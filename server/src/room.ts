import {
  createDefaultTemplate,
  decodeExploredCells,
  encodeExploredCells,
  createScene,
  createSheetValues,
  DEFAULT_SETTINGS,
  DEFAULT_TURNS,
  generateId,
  generateTableCode,
  normalizeBoard,
  normalizeTemplate,
  normalizeTurns,
  type Asset,
  type ChatMessage,
  type ClueBoard,
  type Handout,
  type Player,
  type Scene,
  type SceneCard,
  type TriggerLogEntry,
  type Sheet,
  type SheetTemplate,
  type TableState,
} from '@rpg/shared';
import { CHAT_HISTORY_SIZE } from '@rpg/shared';

import { generateSessionToken, hashPassword, hashToken, normalizeTableCode } from './auth.js';
import { fromJson, prisma, toJson, withRetry } from './db.js';
import { PERSIST_DEBOUNCE_MS, ROOM_IDLE_TIMEOUT_MS } from './env.js';
import { socketsOf } from './broadcast.js';
import { assetUrl } from './uploads.js';

/**
 * Uma mesa carregada em memoria.
 *
 * O estado em RAM e a autoridade durante a sessao; o banco e o registro
 * duravel. Toda mutacao marca o que sujou e agenda um flush agrupado, para
 * que um arraste de token (dezenas de eventos por segundo) vire uma unica
 * escrita quando ele parar.
 */

const SESSION_CACHE_MS = 60_000;
const SESSION_CACHE_MAX = 4096;

/**
 * `board` e separado de `table` de proposito: arrastar um cartao no quadro de
 * pistas marca so ele, e a gravacao agrupada escreve uma coluna em vez de
 * reserializar chat, materiais e configuracoes a cada movimento.
 */
type DirtyKind = 'table' | 'players' | 'sheets' | 'board';

export class Room {
  readonly state: TableState;

  private dirty = new Set<DirtyKind>();
  private dirtyScenes = new Set<string>();

  /**
   * Ids das fichas e jogadores alterados desde a ultima gravacao.
   *
   * A marcacao era so por categoria: mudar um campo de uma ficha marcava
   * `sheets`, e o flush regravava TODAS as fichas da mesa, uma consulta por
   * vez. Com 20 fichas, cada rajada de digitacao virava 20 idas ao banco em
   * serie. Guardar os ids faz a gravacao custar o que a mudanca custou.
   */
  private dirtySheetIds = new Set<string>();
  private dirtyPlayerIds = new Set<string>();
  private removedScenes = new Set<string>();
  private removedSheets = new Set<string>();
  private removedPlayers = new Set<string>();

  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  /** Sockets conectados, para saber quando a sala pode sair da memoria. */
  readonly sockets = new Set<string>();

  /**
   * Ultimo flash entregue a cada jogador. E o teto de 3 clarões por segundo:
   * vale para o mestre clicando rapido e para gatilhos disparando em serie.
   */
  readonly lastFlashAt = new Map<string, number>();

  /** Quando a cartela atual entrou na tela, para quem reconecta ver o restante. */
  presentationStartedAt = 0;

  /** Ultimo disparo de cada par gatilho:token, contra rajadas na borda da area. */
  readonly triggerCooldown = new Map<string, number>();
  presentationTimer: NodeJS.Timeout | null = null;
  lastActivity = Date.now();
  persistenceError = false;

  constructor(state: TableState) {
    this.state = state;
  }

  // -- consultas -----------------------------------------------------------

  scene(id: string | null | undefined): Scene | undefined {
    if (!id) return undefined;
    return this.state.scenes.find((s) => s.id === id);
  }

  activeScene(): Scene | undefined {
    return this.scene(this.state.activeSceneId);
  }

  player(id: string | null | undefined): Player | undefined {
    if (!id) return undefined;
    return this.state.players.find((p) => p.id === id);
  }

  sheet(id: string | null | undefined): Sheet | undefined {
    if (!id) return undefined;
    return this.state.sheets.find((s) => s.id === id);
  }

  // -- marcacao de mudanca -------------------------------------------------

  touch(kind: DirtyKind): void {
    this.dirty.add(kind);
    this.schedule();
  }

  touchScene(sceneId: string): void {
    this.dirtyScenes.add(sceneId);
    this.schedule();
  }

  /** Marca uma ficha. Prefira isto a `touch('sheets')`, que regrava todas. */
  touchSheet(sheetId: string): void {
    this.dirtySheetIds.add(sheetId);
    this.schedule();
  }

  /** Marca um jogador. Prefira isto a `touch('players')`. */
  touchPlayer(playerId: string): void {
    this.dirtyPlayerIds.add(playerId);
    this.schedule();
  }

  removeSceneRecord(sceneId: string): void {
    this.dirtyScenes.delete(sceneId);
    this.removedScenes.add(sceneId);
    this.schedule();
  }

  removeSheetRecord(sheetId: string): void {
    this.dirtySheetIds.delete(sheetId);
    this.removedSheets.add(sheetId);
    this.schedule();
  }

  removePlayerRecord(playerId: string): void {
    this.dirtyPlayerIds.delete(playerId);
    this.removedPlayers.add(playerId);
    this.schedule();
  }

  /**
   * Esquece o que estava para ser gravado e cancela o debounce pendente.
   *
   * So faz sentido quando a mesa inteira vai ser apagada: gravar o estado
   * parcial de uma importacao que falhou seria recriar exatamente a linha que
   * estamos prestes a remover.
   */
  cancelPendingWrites(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty.clear();
    this.dirtyScenes.clear();
    this.dirtySheetIds.clear();
    this.dirtyPlayerIds.clear();
    this.removedScenes.clear();
    this.removedSheets.clear();
    this.removedPlayers.clear();
  }

  private schedule(): void {
    this.state.updatedAt = Date.now();
    this.lastActivity = Date.now();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Grava tudo que estiver pendente. Chamado no debounce e no shutdown.
   *
   * Encadeia em vez de devolver a gravacao em curso: devolvendo-a, o que
   * sujasse DURANTE ela ficaria de fora, e a promessa resolveria dizendo que
   * gravou. Durante a sessao isso se resolvia sozinho — a proxima mudanca
   * reagendava —, mas no encerramento `flushAll` retornava antes de gravar
   * tudo, e o ultimo movimento se perdia justo no Ctrl+C.
   */
  async flush(): Promise<void> {
    this.flushing = (this.flushing ?? Promise.resolve())
      .catch(() => {
        // Uma falha anterior nao pode impedir a proxima tentativa.
      })
      .then(() => this.persistPending());

    const mine = this.flushing;
    const settled = () => { if (this.flushing === mine) this.flushing = null; };
    void mine.then(settled, settled);
    return mine;
  }

  /** Recolhe o que esta marcado agora e grava. */
  private async persistPending(): Promise<void> {
    const kinds = new Set(this.dirty);
    const scenes = new Set(this.dirtyScenes);
    const sheetIds = new Set(this.dirtySheetIds);
    const playerIds = new Set(this.dirtyPlayerIds);
    const rmScenes = new Set(this.removedScenes);
    const rmSheets = new Set(this.removedSheets);
    const rmPlayers = new Set(this.removedPlayers);

    this.dirty.clear();
    this.dirtyScenes.clear();
    this.dirtySheetIds.clear();
    this.dirtyPlayerIds.clear();
    this.removedScenes.clear();
    this.removedSheets.clear();
    this.removedPlayers.clear();

    if (
      kinds.size === 0 &&
      scenes.size === 0 &&
      sheetIds.size === 0 &&
      playerIds.size === 0 &&
      rmScenes.size === 0 &&
      rmSheets.size === 0 &&
      rmPlayers.size === 0
    ) {
      return;
    }

    try {
      await this.persist(kinds, scenes, sheetIds, playerIds, rmScenes, rmSheets, rmPlayers);
      if (this.persistenceError) for (const socket of socketsOf(this)) socket.emit('notice', { level: 'info', message: 'As alteracoes pendentes foram salvas.' });
      this.persistenceError = false;
    } catch (err) {
      // Merge rather than replace: changes made during I/O must also survive.
      for (const v of kinds) this.dirty.add(v);
      for (const v of scenes) if (this.scene(v)) this.dirtyScenes.add(v);
      for (const v of sheetIds) if (this.sheet(v)) this.dirtySheetIds.add(v);
      for (const v of playerIds) if (this.player(v)) this.dirtyPlayerIds.add(v);
      for (const v of rmScenes) this.removedScenes.add(v);
      for (const v of rmSheets) this.removedSheets.add(v);
      for (const v of rmPlayers) this.removedPlayers.add(v);
      if (!this.persistenceError) for (const socket of socketsOf(this)) socket.emit('notice', { level: 'error', message: 'Nao foi possivel salvar. Mantenha o servidor aberto; estamos tentando novamente.' });
      this.persistenceError = true;
      this.schedule();
      throw err;
    }
  }

  private async persist(
    kinds: Set<DirtyKind>,
    sceneIds: Set<string>,
    sheetIds: Set<string>,
    playerIds: Set<string>,
    rmScenes: Set<string>,
    rmSheets: Set<string>,
    rmPlayers: Set<string>,
  ): Promise<void> {
    const s = this.state;

    try {
      // Tudo aqui e upsert ou update por id, portanto idempotente: repetir a
      // operacao inteira apos contencao nao duplica nada.
      await withRetry(async () => {
      if (kinds.has('table')) {
        await prisma.table.update({
          where: { id: s.id },
          data: {
            name: s.name,
            activeSceneId: s.activeSceneId,
            settings: toJson(s.settings),
            sheetTemplate: toJson(s.sheetTemplate),
            // A coluna mantem o nome antigo: renomea-la exigiria migrar todas
            // as mesas gravadas, e o conteudo e a ordem de turnos.
            initiative: toJson(s.turns),
            chat: toJson(s.chat.slice(-CHAT_HISTORY_SIZE)),
            handouts: toJson(s.handouts),
            sceneCards: toJson(s.sceneCards),
            triggerLog: toJson(s.triggerLog),
            board: toJson(s.board),
          },
        });
      } else if (kinds.has('board')) {
        await prisma.table.update({ where: { id: s.id }, data: { board: toJson(s.board) } });
      }

      for (const id of rmScenes) {
        await prisma.scene.deleteMany({ where: { id } });
      }
      for (const id of sceneIds) {
        const scene = this.scene(id);
        if (!scene) continue;
        const data = {
          id: scene.id,
          tableId: s.id,
          name: scene.name,
          order: scene.order,
          data: toJson(sceneForStorage(scene)),
        };
        await prisma.scene.upsert({ where: { id: scene.id }, create: data, update: data });
      }

      for (const id of rmPlayers) {
        await prisma.player.deleteMany({ where: { id } });
      }
      // `kinds` com 'players' significa "todos" — usado quando a mudanca
      // atinge a mesa inteira. O caso comum e um jogador so, por id.
      const players = kinds.has('players')
        ? s.players
        : s.players.filter((p) => playerIds.has(p.id));

      await Promise.all(
        players.map((p) =>
          prisma.player.updateMany({
            where: { id: p.id },
            data: {
              name: p.name,
              color: p.color,
              role: p.role,
              sheetId: p.sheetId,
              reduceEffects: p.reduceEffects ?? false,
              lastSeen: new Date(p.lastSeen),
            },
          }),
        ),
      );

      for (const id of rmSheets) {
        await prisma.sheet.deleteMany({ where: { id } });
      }
      const sheets = kinds.has('sheets')
        ? s.sheets
        : s.sheets.filter((sheet) => sheetIds.has(sheet.id));

      await Promise.all(
        sheets.map((sheet) => {
          const data = {
            id: sheet.id,
            tableId: s.id,
            name: sheet.name,
            ownerPlayerId: sheet.ownerPlayerId,
            portraitAssetId: sheet.portraitAssetId,
            bodyAssetId: sheet.bodyAssetId,
            values: toJson(sheet.values),
            sharedWithParty: sheet.sharedWithParty,
          };
          return prisma.sheet.upsert({ where: { id: sheet.id }, create: data, update: data });
        }),
      );
      });
    } catch (err) {
      // Uma falha de escrita nao pode derrubar a sessao em andamento: o estado
      // em memoria continua valido e a proxima mudanca tenta gravar de novo.
      console.error(`[room ${s.code}] falha ao persistir:`, err);
      throw err;
    }
  }

  /**
   * Mensagem e rolagem gravam na hora, sem esperar o debounce.
   *
   * Uma queda do servidor perdia o ultimo 1,5 s — num arraste, so um passo do
   * token; no chat, a rolagem decisiva que a mesa inteira viu. O volume de
   * mensagens e baixo o bastante para nao pesar como pesaria o movimento.
   */
  appendChat(message: ChatMessage): void {
    this.state.chat.push(message);
    if (this.state.chat.length > CHAT_HISTORY_SIZE) {
      this.state.chat.splice(0, this.state.chat.length - CHAT_HISTORY_SIZE);
    }
    this.touch('table');
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A falha ja volta a marcar e reagenda dentro de persistPending.
    void this.flush().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Carregamento e criacao
// ---------------------------------------------------------------------------

export interface CreatedTable {
  room: Room;
  gmPlayerId: string;
  gmToken: string;
}

/**
 * Cena pronta para gravar.
 *
 * `fog.explored` sai como faixas em vez de uma chave por celula. E a unica
 * diferenca entre o que roda em memoria e o que fica no banco, e existe
 * porque a cena inteira e reserializada a cada gravacao: num mapa grande e ja
 * explorado, essa lista sozinha domina o custo do flush.
 */
function sceneForStorage(scene: Scene): Record<string, unknown> {
  const { explored, exploredBy, ...fog } = scene.fog;
  // A exploracao por jogador usa o mesmo codec: com quatro jogadores, sao
  // quatro listas do tamanho da antiga, e o custo do flush crescia junto.
  const exploredByRuns: Record<string, unknown> = {};
  for (const [playerId, cells] of Object.entries(exploredBy)) {
    if (cells.length) exploredByRuns[playerId] = encodeExploredCells(cells);
  }
  return { ...scene, fog: { ...fog, exploredRuns: encodeExploredCells(explored), exploredByRuns } };
}

/** Desfaz `sceneForStorage`, aceitando tambem cenas gravadas antes dele. */
function sceneFromStorage(raw: string): Partial<Scene> {
  const parsed = fromJson<Record<string, unknown>>(raw, {});
  const fog = parsed.fog as Record<string, unknown> | undefined;
  if (!fog) return parsed as Partial<Scene>;

  const { exploredRuns, exploredByRuns, ...rest } = fog;
  const decoded: Record<string, unknown> = { ...rest };
  // Cenas anteriores ao codec ainda trazem `explored` como lista de chaves.
  if (exploredRuns) decoded.explored = decodeExploredCells(exploredRuns as never);
  // Cenas anteriores a exploracao individual nao tem `exploredByRuns`: tudo o
  // que o grupo explorou fica na base comum, e ninguem perde o que ja mapeou.
  if (exploredByRuns && typeof exploredByRuns === 'object') {
    const exploredBy: Record<string, string[]> = {};
    for (const [playerId, runs] of Object.entries(exploredByRuns as Record<string, unknown>)) {
      exploredBy[playerId] = decodeExploredCells(runs as never);
    }
    decoded.exploredBy = exploredBy;
  }
  return { ...parsed, fog: decoded } as unknown as Partial<Scene>;
}

class RoomManager {
  private rooms = new Map<string, Room>();
  private codeIndex = new Map<string, string>();
  private loading = new Map<string, Promise<Room | null>>();

  /**
   * Cache curto de sessao.
   *
   * A autorizacao de `/uploads` resolve uma sessao POR IMAGEM, e cada resolucao
   * era uma consulta ao banco: abrir uma cena com trinta imagens custava trinta
   * idas ao SQLite, multiplicadas pelos tokens guardados no cookie. A entrada
   * cacheada ainda e conferida contra a mesa em memoria a cada uso, entao
   * expulsar alguem tem efeito imediato — o jogador some de `room.state.players`
   * na hora, e a entrada e descartada.
   */
  private sessionCache = new Map<string, { tableId: string; playerId: string; at: number }>();

  constructor() {
    setInterval(() => void this.evictIdle(), 60_000).unref();
  }

  async createTable(params: {
    name: string;
    gmName: string;
    gmPassword?: string;
  }): Promise<CreatedTable> {
    const id = generateId('tbl');
    const template = createDefaultTemplate();
    const scene = createScene({ name: 'Cena inicial' });
    const code = await this.uniqueCode();

    await prisma.table.create({
      data: {
        id,
        code,
        codeNormalized: normalizeTableCode(code),
        name: params.name.slice(0, 80) || 'Mesa sem nome',
        gmPasswordHash: params.gmPassword ? await hashPassword(params.gmPassword) : null,
        activeSceneId: scene.id,
        settings: toJson(DEFAULT_SETTINGS),
        sheetTemplate: toJson(template),
        initiative: toJson(DEFAULT_TURNS),
        chat: toJson([]),
        handouts: toJson([]),
      },
    });

    await prisma.scene.create({
      data: { id: scene.id, tableId: id, name: scene.name, order: 0, data: toJson(sceneForStorage(scene)) },
    });

    const gmToken = generateSessionToken();
    const gmPlayerId = generateId('ply');
    await prisma.player.create({
      data: {
        id: gmPlayerId,
        tableId: id,
        name: params.gmName.slice(0, 40) || 'Mestre',
        role: 'GM',
        color: '#e0a33e',
        tokenHash: hashToken(gmToken),
      },
    });

    const room = await this.load(id);
    if (!room) throw new Error('falha ao carregar a mesa recem-criada');
    return { room, gmPlayerId, gmToken };
  }

  private async uniqueCode(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const code = generateTableCode();
      const existing = await prisma.table.findUnique({ where: { code }, select: { id: true } });
      if (!existing) return code;
    }
    throw new Error('nao foi possivel gerar um codigo de mesa livre');
  }

  get(tableId: string): Room | undefined {
    return this.rooms.get(tableId);
  }

  async load(tableId: string): Promise<Room | null> {
    const cached = this.rooms.get(tableId);
    if (cached) return cached;

    const inFlight = this.loading.get(tableId);
    if (inFlight) return inFlight;

    const promise = this.loadFromDb(tableId).finally(() => this.loading.delete(tableId));
    this.loading.set(tableId, promise);
    return promise;
  }

  private async loadFromDb(tableId: string): Promise<Room | null> {
    const row = await prisma.table.findUnique({
      where: { id: tableId },
      include: {
        scenes: { orderBy: { order: 'asc' } },
        players: true,
        sheets: true,
        assets: true,
      },
    });
    if (!row) return null;

    // Normaliza na leitura: mesas gravadas por versoes anteriores nao tem os
    // campos de template criados depois, e chegariam com buracos ao cliente.
    const template = normalizeTemplate(
      fromJson<Partial<SheetTemplate>>(row.sheetTemplate, createDefaultTemplate()),
    );

    const state: TableState = {
      id: row.id,
      code: row.code,
      name: row.name,
      activeSceneId: row.activeSceneId,
      settings: { ...DEFAULT_SETTINGS, ...fromJson(row.settings, DEFAULT_SETTINGS) },
      sheetTemplate: template,
      turns: normalizeTurns(fromJson(row.initiative, DEFAULT_TURNS)),
      scenes: row.scenes.map((s) => createScene(sceneFromStorage(s.data))),
      players: row.players.map(
        (p): Player => ({
          id: p.id,
          name: p.name,
          role: p.role === 'GM' ? 'GM' : 'PLAYER',
          color: p.color,
          connected: false,
          lastSeen: p.lastSeen.getTime(),
          sheetId: p.sheetId,
          reduceEffects: p.reduceEffects,
        }),
      ),
      sheets: row.sheets.map(
        (s): Sheet => ({
          id: s.id,
          name: s.name,
          portraitAssetId: s.portraitAssetId,
          bodyAssetId: s.bodyAssetId,
          ownerPlayerId: s.ownerPlayerId,
          values: fromJson(s.values, createSheetValues(template)),
          sharedWithParty: s.sharedWithParty,
          createdAt: s.createdAt.getTime(),
          updatedAt: s.updatedAt.getTime(),
        }),
      ),
      assets: row.assets.map(
        (a): Asset => ({
          id: a.id,
          kind: a.kind as Asset['kind'],
          url: assetUrl(a.filename),
          thumbUrl: a.thumbFilename ? assetUrl(`thumbs/${a.thumbFilename}`) : null,
          originalName: a.originalName,
          mime: a.mime,
          size: a.size,
          width: a.width,
          height: a.height,
          createdAt: a.createdAt.getTime(),
          uploadedBy: a.uploadedBy,
        }),
      ),
      handouts: fromJson<Handout[]>(row.handouts, []),
      chat: fromJson<ChatMessage[]>(row.chat, []),
      sceneCards: fromJson<SceneCard[]>(row.sceneCards, []),
      triggerLog: fromJson<TriggerLogEntry[]>(row.triggerLog, []),
      board: normalizeBoard(fromJson<Partial<ClueBoard>>(row.board, {})),
      // Efeitos fixos e cartela na tela vivem so em memoria: um reinicio do
      // servidor encerra a apresentacao, como encerraria a sessao.
      screenEffects: [],
      presentedCard: null,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };

    if (!state.activeSceneId && state.scenes.length > 0) {
      state.activeSceneId = state.scenes[0].id;
    }

    const room = new Room(state);
    this.rooms.set(row.id, room);
    this.codeIndex.set(row.code, row.id);
    return room;
  }

  async loadByCode(rawCode: string): Promise<Room | null> {
    if (typeof rawCode !== 'string') return null;
    const normalized = normalizeTableCode(rawCode);
    if (!normalized) return null;

    for (const [code, id] of this.codeIndex) {
      if (normalizeTableCode(code) === normalized) {
        const room = this.rooms.get(id);
        if (room) return room;
      }
    }

    // Consulta pelo indice unico. Antes daqui saia um findMany de TODAS as
    // mesas, normalizadas uma a uma em memoria, porque o codigo e guardado
    // com hifen e o digitado nunca bate: cada tentativa de entrada percorria
    // o banco inteiro.
    const row = await prisma.table.findUnique({
      where: { codeNormalized: normalized },
      select: { id: true },
    });
    if (row) return this.load(row.id);

    // Mesas anteriores a coluna ainda estao com ela nula. A varredura fica
    // como caminho de compatibilidade e preenche o que encontrar, para que a
    // proxima busca ja use o indice.
    return this.findLegacyByCode(normalized);
  }

  /** Caminho de compatibilidade para linhas sem `codeNormalized`. */
  private async findLegacyByCode(normalized: string): Promise<Room | null> {
    const pending = await prisma.table.findMany({
      where: { codeNormalized: null },
      select: { id: true, code: true },
    });
    if (pending.length === 0) return null;

    for (const t of pending) {
      await prisma.table
        .update({ where: { id: t.id }, data: { codeNormalized: normalizeTableCode(t.code) } })
        .catch(() => {
          // Colisao improvavel entre codigos antigos: deixa nulo e segue.
        });
    }

    const match = pending.find((t) => normalizeTableCode(t.code) === normalized);
    return match ? this.load(match.id) : null;
  }

  /**
   * Esquece as sessoes em cache de um jogador. Usado quando o token dele e
   * trocado: sem isto, o token antigo seguia valendo pelo tempo do cache.
   */
  forgetPlayerSessions(playerId: string): void {
    for (const [hash, entry] of this.sessionCache) {
      if (entry.playerId === playerId) this.sessionCache.delete(hash);
    }
  }

  /** Resolve um token de sessao para a mesa e o jogador correspondentes. */
  async resolveSession(token: string): Promise<{ room: Room; playerId: string } | null> {
    if (typeof token !== 'string' || !token || token.length > 256) return null;

    const hash = hashToken(token);
    const cached = this.sessionCache.get(hash);
    if (cached && Date.now() - cached.at < SESSION_CACHE_MS) {
      const room = await this.load(cached.tableId);
      // Confere contra a memoria: quem foi expulso ja nao esta na mesa, e a
      // entrada cacheada nao pode servir de passe.
      if (room?.player(cached.playerId)) return { room, playerId: cached.playerId };
      this.sessionCache.delete(hash);
    }

    const player = await prisma.player.findUnique({ where: { tokenHash: hash } });
    if (!player) return null;
    const room = await this.load(player.tableId);
    if (!room) return null;

    // A linha do banco sobrevive ao `player:kick` ate o proximo flush. Sem esta
    // conferencia, quem acabou de ser expulso continuava baixando as imagens
    // da mesa nessa janela — a memoria e a autoridade, nao o banco.
    if (!room.player(player.id)) return null;

    this.rememberSession(hash, player.tableId, player.id);
    return { room, playerId: player.id };
  }

  private rememberSession(hash: string, tableId: string, playerId: string): void {
    // Varre o vencido antes de crescer, para o mapa nao acumular sessao morta.
    if (this.sessionCache.size >= SESSION_CACHE_MAX) {
      const cutoff = Date.now() - SESSION_CACHE_MS;
      for (const [key, entry] of this.sessionCache) {
        if (entry.at < cutoff) this.sessionCache.delete(key);
      }
      if (this.sessionCache.size >= SESSION_CACHE_MAX) this.sessionCache.clear();
    }
    this.sessionCache.set(hash, { tableId, playerId, at: Date.now() });
  }

  /**
   * Remove a mesa da memoria E do banco, sem gravar o que estava pendente.
   *
   * Existe para desfazer uma importacao que falhou no meio: a mesa ja foi
   * criada, mas esta incompleta, e deixa-la seria pior que nao ter importado.
   * O cascade do schema leva cenas, jogadores, fichas e assets junto; os
   * arquivos em disco sao removidos por quem chamou.
   */
  async discard(tableId: string): Promise<void> {
    const room = this.rooms.get(tableId);
    if (room) {
      room.cancelPendingWrites();
      this.rooms.delete(tableId);
      this.codeIndex.delete(room.state.code);
    }
    await prisma.table.delete({ where: { id: tableId } }).catch(() => {
      // Se a propria criacao falhou, nao ha linha para apagar.
    });
  }

  /** Descarrega mesas ociosas, depois de garantir que nada ficou por gravar. */
  private async evictIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.sockets.size > 0) continue;
      if (now - room.lastActivity < ROOM_IDLE_TIMEOUT_MS) continue;
      try { await room.flush(); } catch { continue; }
      if (room.sockets.size > 0 || Date.now() - room.lastActivity < ROOM_IDLE_TIMEOUT_MS) continue;
      this.rooms.delete(id);
      this.codeIndex.delete(room.state.code);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((r) => r.flush()));
  }
}

export const rooms = new RoomManager();
