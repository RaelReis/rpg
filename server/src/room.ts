import {
  createDefaultTemplate,
  createScene,
  createSheetValues,
  DEFAULT_INITIATIVE,
  DEFAULT_SETTINGS,
  generateId,
  generateTableCode,
  type Asset,
  type ChatMessage,
  type Player,
  type Scene,
  type Sheet,
  type SheetTemplate,
  type TableState,
} from '@rpg/shared';
import { CHAT_HISTORY_SIZE } from '@rpg/shared';

import { generateSessionToken, hashPassword, hashToken, normalizeTableCode } from './auth.js';
import { fromJson, prisma, toJson } from './db.js';
import { PERSIST_DEBOUNCE_MS, ROOM_IDLE_TIMEOUT_MS } from './env.js';
import { assetUrl } from './uploads.js';

/**
 * Uma mesa carregada em memoria.
 *
 * O estado em RAM e a autoridade durante a sessao; o banco e o registro
 * duravel. Toda mutacao marca o que sujou e agenda um flush agrupado, para
 * que um arraste de token (dezenas de eventos por segundo) vire uma unica
 * escrita quando ele parar.
 */

type DirtyKind = 'table' | 'players' | 'sheets';

export class Room {
  readonly state: TableState;

  private dirty = new Set<DirtyKind>();
  private dirtyScenes = new Set<string>();
  private removedScenes = new Set<string>();
  private removedSheets = new Set<string>();
  private removedPlayers = new Set<string>();

  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  /** Sockets conectados, para saber quando a sala pode sair da memoria. */
  readonly sockets = new Set<string>();
  lastActivity = Date.now();

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

  removeSceneRecord(sceneId: string): void {
    this.dirtyScenes.delete(sceneId);
    this.removedScenes.add(sceneId);
    this.schedule();
  }

  removeSheetRecord(sheetId: string): void {
    this.removedSheets.add(sheetId);
    this.schedule();
  }

  removePlayerRecord(playerId: string): void {
    this.removedPlayers.add(playerId);
    this.schedule();
  }

  private schedule(): void {
    this.state.updatedAt = Date.now();
    this.lastActivity = Date.now();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Grava tudo que estiver pendente. Chamado no debounce e no shutdown. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;

    const kinds = new Set(this.dirty);
    const scenes = new Set(this.dirtyScenes);
    const rmScenes = new Set(this.removedScenes);
    const rmSheets = new Set(this.removedSheets);
    const rmPlayers = new Set(this.removedPlayers);

    this.dirty.clear();
    this.dirtyScenes.clear();
    this.removedScenes.clear();
    this.removedSheets.clear();
    this.removedPlayers.clear();

    if (
      kinds.size === 0 &&
      scenes.size === 0 &&
      rmScenes.size === 0 &&
      rmSheets.size === 0 &&
      rmPlayers.size === 0
    ) {
      return;
    }

    this.flushing = this.persist(kinds, scenes, rmScenes, rmSheets, rmPlayers).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async persist(
    kinds: Set<DirtyKind>,
    sceneIds: Set<string>,
    rmScenes: Set<string>,
    rmSheets: Set<string>,
    rmPlayers: Set<string>,
  ): Promise<void> {
    const s = this.state;

    try {
      if (kinds.has('table')) {
        await prisma.table.update({
          where: { id: s.id },
          data: {
            name: s.name,
            activeSceneId: s.activeSceneId,
            settings: toJson(s.settings),
            sheetTemplate: toJson(s.sheetTemplate),
            initiative: toJson(s.initiative),
            chat: toJson(s.chat.slice(-CHAT_HISTORY_SIZE)),
          },
        });
      }

      for (const id of rmScenes) {
        await prisma.scene.deleteMany({ where: { id } });
      }
      for (const id of sceneIds) {
        const scene = this.scene(id);
        if (!scene) continue;
        const data = { id: scene.id, tableId: s.id, name: scene.name, order: scene.order, data: toJson(scene) };
        await prisma.scene.upsert({ where: { id: scene.id }, create: data, update: data });
      }

      for (const id of rmPlayers) {
        await prisma.player.deleteMany({ where: { id } });
      }
      if (kinds.has('players')) {
        for (const p of s.players) {
          await prisma.player.updateMany({
            where: { id: p.id },
            data: { name: p.name, color: p.color, role: p.role, sheetId: p.sheetId, lastSeen: new Date(p.lastSeen) },
          });
        }
      }

      for (const id of rmSheets) {
        await prisma.sheet.deleteMany({ where: { id } });
      }
      if (kinds.has('sheets')) {
        for (const sheet of s.sheets) {
          const data = {
            id: sheet.id,
            tableId: s.id,
            name: sheet.name,
            ownerPlayerId: sheet.ownerPlayerId,
            portraitAssetId: sheet.portraitAssetId,
            values: toJson(sheet.values),
            sharedWithParty: sheet.sharedWithParty,
          };
          await prisma.sheet.upsert({ where: { id: sheet.id }, create: data, update: data });
        }
      }
    } catch (err) {
      // Uma falha de escrita nao pode derrubar a sessao em andamento: o estado
      // em memoria continua valido e a proxima mudanca tenta gravar de novo.
      console.error(`[room ${s.code}] falha ao persistir:`, err);
    }
  }

  appendChat(message: ChatMessage): void {
    this.state.chat.push(message);
    if (this.state.chat.length > CHAT_HISTORY_SIZE) {
      this.state.chat.splice(0, this.state.chat.length - CHAT_HISTORY_SIZE);
    }
    this.touch('table');
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

class RoomManager {
  private rooms = new Map<string, Room>();
  private codeIndex = new Map<string, string>();
  private loading = new Map<string, Promise<Room | null>>();

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
        name: params.name.slice(0, 80) || 'Mesa sem nome',
        gmPasswordHash: params.gmPassword ? hashPassword(params.gmPassword) : null,
        activeSceneId: scene.id,
        settings: toJson(DEFAULT_SETTINGS),
        sheetTemplate: toJson(template),
        initiative: toJson(DEFAULT_INITIATIVE),
        chat: toJson([]),
      },
    });

    await prisma.scene.create({
      data: { id: scene.id, tableId: id, name: scene.name, order: 0, data: toJson(scene) },
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

    const template = fromJson<SheetTemplate>(row.sheetTemplate, createDefaultTemplate());

    const state: TableState = {
      id: row.id,
      code: row.code,
      name: row.name,
      activeSceneId: row.activeSceneId,
      settings: { ...DEFAULT_SETTINGS, ...fromJson(row.settings, DEFAULT_SETTINGS) },
      sheetTemplate: template,
      initiative: { ...DEFAULT_INITIATIVE, ...fromJson(row.initiative, DEFAULT_INITIATIVE) },
      scenes: row.scenes.map((s) => createScene(fromJson<Partial<Scene>>(s.data, {}))),
      players: row.players.map(
        (p): Player => ({
          id: p.id,
          name: p.name,
          role: p.role === 'GM' ? 'GM' : 'PLAYER',
          color: p.color,
          connected: false,
          lastSeen: p.lastSeen.getTime(),
          sheetId: p.sheetId,
        }),
      ),
      sheets: row.sheets.map(
        (s): Sheet => ({
          id: s.id,
          name: s.name,
          portraitAssetId: s.portraitAssetId,
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
      chat: fromJson<ChatMessage[]>(row.chat, []),
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
    const normalized = normalizeTableCode(rawCode);

    for (const [code, id] of this.codeIndex) {
      if (normalizeTableCode(code) === normalized) {
        const room = this.rooms.get(id);
        if (room) return room;
      }
    }

    // O codigo e guardado com hifen; a busca aceita qualquer formatacao.
    const candidates = await prisma.table.findMany({ select: { id: true, code: true } });
    const match = candidates.find((t) => normalizeTableCode(t.code) === normalized);
    return match ? this.load(match.id) : null;
  }

  /** Resolve um token de sessao para a mesa e o jogador correspondentes. */
  async resolveSession(token: string): Promise<{ room: Room; playerId: string } | null> {
    const player = await prisma.player.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!player) return null;
    const room = await this.load(player.tableId);
    return room ? { room, playerId: player.id } : null;
  }

  /** Descarrega mesas ociosas, depois de garantir que nada ficou por gravar. */
  private async evictIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.sockets.size > 0) continue;
      if (now - room.lastActivity < ROOM_IDLE_TIMEOUT_MS) continue;
      await room.flush();
      this.rooms.delete(id);
      this.codeIndex.delete(room.state.code);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((r) => r.flush()));
  }
}

export const rooms = new RoomManager();
