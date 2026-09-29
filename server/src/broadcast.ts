import type { Server, Socket } from 'socket.io';
import type {
  Asset,
  ClientToServerEvents,
  MapEffect,
  Player,
  Scene,
  ServerToClientEvents,
  Tile,
  Token,
  Wall,
} from '@rpg/shared';
import { sharedSight, type SharedSight } from '@rpg/shared';

import {
  assetIdsOfScene,
  effectShownTo,
  playersWithPortraits,
  sceneForViewer,
  stateForViewer,
  tileShownTo,
  tokenForViewer,
  turnsForViewer,
  visibleTokenIds,
  visionFor,
  type Viewer,
  wallForPlayer,
  wallShownTo,
} from './filter.js';
import type { Room } from './room.js';

export interface SocketData {
  tableId: string;
  viewer: Viewer;
  /** Cache do que este socket enxerga, para emitir apenas o delta. */
  visibleTokens: Set<string>;
  /**
   * Efeitos que este socket recebeu. Com ele, a remocao so vai para quem tinha
   * o efeito: mandar `remove` de um id a todos entregaria a existencia de uma
   * alucinacao (ou de um efeito oculto) a quem nunca a viu.
   */
  visibleEffects: Set<string>;
  /**
   * Tiles que este socket recebeu. Com a visao estrita, o jogador so recebe o
   * cenario que ja viu; o conjunto muda com a visao e da o delta a enviar.
   */
  visibleTiles: Set<string>;
  /** Paredes (na pratica, portas) que este socket recebeu; mesma logica dos tiles. */
  visibleWalls: Set<string>;
  currentSceneId: string | null;
  /** Imagens cujos dados este socket ja recebeu. Ver `syncAssets`. */
  knownAssets: Set<string>;
  fogSignature?: string;
}

export type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

let io: TypedServer | null = null;

export function bindIo(server: TypedServer): void {
  io = server;
}

export function roomChannel(tableId: string): string {
  return `table:${tableId}`;
}

/** Sockets autenticados de uma mesa. */
export function socketsOf(room: Room): TypedSocket[] {
  if (!io) return [];
  const out: TypedSocket[] = [];
  for (const id of room.sockets) {
    const s = io.sockets.sockets.get(id) as TypedSocket | undefined;
    if (s?.data.tableId !== room.state.id) continue;
    const player = room.player(s.data.viewer?.playerId);
    if (!player) continue;
    s.data.viewer = { playerId: player.id, role: player.role };
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

/**
 * Garante que o jogador tenha os dados das imagens antes do conteudo que as usa.
 *
 * O jogador nao recebe a lista inteira de imagens da mesa: o mapa da proxima
 * cena ou a arte de um chefe ainda escondido entregariam a surpresa, nem que
 * fosse pelo nome do arquivo. Ele recebe so o que ja esta em uso no que ele
 * enxerga. So que essa lista era montada apenas no estado completo, e nada a
 * atualizava depois: quando o mestre punha arte num token no meio da sessao, o
 * jogador recebia o token com um `assetId` que nao sabia transformar em URL.
 * A imagem aparecia para o mestre na hora e para a mesa so depois de recarregar.
 *
 * Por isso cada emissor chama isto com as imagens do que esta prestes a enviar,
 * JA filtrado para o observador: o que ele nao pode ver nao traz a arte junto.
 * A memoria por socket evita reenviar o que ele ja tem.
 */
export function syncAssets(
  room: Room,
  socket: TypedSocket,
  ids: Iterable<string | null | undefined>,
): void {
  if (socket.data.viewer.role === 'GM') return; // o mestre recebe todas

  const known = (socket.data.knownAssets ??= new Set());
  const fresh: Asset[] = [];

  for (const id of ids) {
    if (!id || known.has(id)) continue;
    const asset = room.state.assets.find((a) => a.id === id);
    if (!asset) continue;
    known.add(id);
    fresh.push(asset);
  }

  if (fresh.length) socket.emit('assets:patch', { upsert: fresh });
}

// ---------------------------------------------------------------------------
// Envio de estado
// ---------------------------------------------------------------------------

export function stateWithVisibilityCache(room: Room, socket: TypedSocket) {
  const player = room.player(socket.data.viewer?.playerId);
  if (socket.data.tableId !== room.state.id || !player) throw new Error('Sessao nao pertence a mesa.');
  socket.data.viewer = { playerId: player.id, role: player.role };
  const state = stateForViewer(room, socket.data.viewer);
  const scene = state.scenes.find((s) => s.id === state.activeSceneId) ?? state.scenes[0] ?? null;

  socket.data.fogSignature = scene ? JSON.stringify([scene.id, scene.fog.computedVisible, scene.fog.computedExplored]) : undefined;
  socket.data.currentSceneId = scene?.id ?? null;
  socket.data.visibleTokens = new Set(scene?.tokens.map((t) => t.id) ?? []);
  socket.data.visibleEffects = new Set(scene?.effects.map((e) => e.id) ?? []);
  socket.data.visibleTiles = new Set(scene?.tiles.map((t) => t.id) ?? []);
  socket.data.visibleWalls = new Set(scene?.walls.map((w) => w.id) ?? []);
  socket.data.knownAssets = new Set(state.assets.map((a) => a.id));
  return state;
}

export function sendFullState(room: Room, socket: TypedSocket): void {
  socket.emit('table:state', stateWithVisibilityCache(room, socket));
}

export function sendFullStateToAll(room: Room): void {
  for (const socket of socketsOf(room)) sendFullState(room, socket);
}

/** Reenvia a cena inteira (ja filtrada) para todos. Usado em mudancas amplas. */
export function pushScene(room: Room, scene: Scene): void {
  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;

    // Jogador so acompanha a cena ativa; se nao for essa, nao ha o que enviar.
    if (viewer.role !== 'GM' && scene.id !== room.state.activeSceneId) continue;

    const filtered = sceneForViewer(room, scene, viewer);
    socket.data.fogSignature = JSON.stringify([filtered.id, filtered.fog.computedVisible, filtered.fog.computedExplored]);
    socket.data.currentSceneId = filtered.id;
    socket.data.visibleTokens = new Set(filtered.tokens.map((t) => t.id));
    if (viewer.role !== 'GM') {
      socket.data.visibleEffects = new Set(filtered.effects.map((e) => e.id));
      socket.data.visibleTiles = new Set(filtered.tiles.map((t) => t.id));
      socket.data.visibleWalls = new Set(filtered.walls.map((w) => w.id));
    }
    syncAssets(room, socket, assetIdsOfScene(filtered));
    socket.emit('scene:patch', { sceneId: scene.id, patch: filtered });
  }
}

/**
 * Recalcula a visao de cada jogador e emite so a diferenca: tokens que
 * entraram na neblina, tokens que sairam e o novo conjunto de celulas
 * iluminadas. E o caminho chamado depois de qualquer coisa que mexa na
 * visibilidade (movimento, paredes, luz, pintura de fog).
 */
export function refreshVision(room: Room, scene: Scene, onlyPlayerIds?: Set<string>): void {
  const strict = room.state.settings.strictVision;
  // Paredes e luzes sao as mesmas para todos os jogadores desta passagem.
  let shared: SharedSight | undefined;

  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    if (viewer.role === 'GM') continue;
    if (scene.id !== room.state.activeSceneId) continue;
    if (onlyPlayerIds && !onlyPlayerIds.has(viewer.playerId)) continue;

    const vision = visionFor(scene, viewer, (shared ??= sharedSight(scene)));
    const nowVisible = visibleTokenIds(scene, viewer, vision);
    const before = socket.data.visibleTokens ?? new Set<string>();

    const upsert: Token[] = [];
    for (const id of nowVisible) {
      if (before.has(id)) continue;
      const token = scene.tokens.find((t) => t.id === id);
      if (token) {
        const presented = tokenForViewer(room, scene, token, viewer, vision);
        if (presented) upsert.push(presented);
      }
    }

    const remove: string[] = [];
    for (const id of before) if (!nowVisible.has(id)) remove.push(id);

    socket.data.visibleTokens = nowVisible;

    if (upsert.length || remove.length) {
      syncAssets(room, socket, upsert.map((t) => t.assetId));
      socket.emit('tokens:patch', { sceneId: scene.id, upsert, remove });
    }

    // Cenario e efeitos acompanham a visao como os tokens: entram quando o
    // jogador passa a ve-los e saem quando deixam de valer (o efeito acima da
    // neblina que ficou no escuro, o tile que o mestre cobriu).
    if (strict) {
      const tiles = diffShown(scene.tiles, (socket.data.visibleTiles ??= new Set()), (t) =>
        tileShownTo(room, scene, t, viewer, vision),
      );
      if (tiles.upsert.length || tiles.remove.length) {
        syncAssets(room, socket, tiles.upsert.map((t) => t.assetId));
        socket.emit('tiles:patch', { sceneId: scene.id, ...tiles });
      }
      const effects = diffShown(scene.effects, (socket.data.visibleEffects ??= new Set()), (e) =>
        effectShownTo(room, scene, e, viewer, vision),
      );
      if (effects.upsert.length || effects.remove.length) {
        syncAssets(room, socket, effects.upsert.map((e) => e.assetId));
        socket.emit('effects:patch', { sceneId: scene.id, ...effects });
      }
      // A porta chega quando o jogador a ve pela primeira vez e fica enquanto
      // ela estiver na area explorada.
      const walls = diffShown(scene.walls, (socket.data.visibleWalls ??= new Set()), (w) =>
        wallShownTo(room, scene, w, viewer, vision),
      );
      if (walls.upsert.length || walls.remove.length) {
        socket.emit('walls:patch', { sceneId: scene.id, upsert: walls.upsert.map(wallForPlayer), remove: walls.remove });
      }
    }

    if (strict) {
      const signature = JSON.stringify([scene.id, [...vision.visible], [...vision.explored]]);
      if (socket.data.fogSignature === signature) continue;
      socket.data.fogSignature = signature;
      socket.emit('fog:patch', {
        sceneId: scene.id,
        computed: { visible: [...vision.visible], explored: [...vision.explored] },
      });
    }
  }
}

/**
 * Movimento de token. Quem ja enxerga o token recebe so as coordenadas; a
 * revisao completa de visibilidade fica para `refreshVision`, chamada quando
 * o arraste termina (ou continuamente, apenas para o dono do token).
 */
export function emitTokenMove(room: Room, scene: Scene, token: Token): void {
  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    if (viewer.role === 'GM') {
      socket.emit('token:moved', { sceneId: scene.id, tokenId: token.id, x: token.x, y: token.y });
      continue;
    }
    if (scene.id !== room.state.activeSceneId) continue;
    if (socket.data.visibleTokens?.has(token.id)) {
      socket.emit('token:moved', { sceneId: scene.id, tokenId: token.id, x: token.x, y: token.y });
    }
  }
}

/** Cria/atualiza um token respeitando a visibilidade de cada destinatario. */
export function emitTokenUpsert(room: Room, scene: Scene, token: Token): void {
  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    if (viewer.role !== 'GM' && scene.id !== room.state.activeSceneId) continue;

    const presented = tokenForViewer(room, scene, token, viewer);
    const wasVisible = socket.data.visibleTokens?.has(token.id) ?? false;

    if (presented) {
      socket.data.visibleTokens?.add(token.id);
      syncAssets(room, socket, [presented.assetId]);
      socket.emit('tokens:patch', { sceneId: scene.id, upsert: [presented] });
    } else if (wasVisible) {
      socket.data.visibleTokens?.delete(token.id);
      socket.emit('tokens:patch', { sceneId: scene.id, remove: [token.id] });
    }
  }
}

export function emitTokenRemoved(room: Room, scene: Scene, tokenId: string): void {
  for (const socket of socketsOf(room)) {
    const gm = socket.data.viewer.role === 'GM';
    if (!gm && scene.id !== room.state.activeSceneId) continue;
    // Quem nunca recebeu o token nao recebe o id dele de brinde.
    const had = socket.data.visibleTokens?.delete(tokenId) ?? false;
    if (gm || had) socket.emit('tokens:patch', { sceneId: scene.id, remove: [tokenId] });
  }
}

/**
 * Compara o que o observador deve ver agora com o que ele ja recebeu e atualiza
 * o conjunto. Devolve o que entrar (inteiro) e os ids que sairem.
 */
function diffShown<T extends { id: string }>(
  items: T[],
  known: Set<string>,
  shown: (item: T) => boolean,
): { upsert: T[]; remove: string[] } {
  const upsert: T[] = [];
  const remove: string[] = [];
  const present = new Set<string>();
  for (const item of items) {
    present.add(item.id);
    const visible = shown(item);
    if (visible && !known.has(item.id)) {
      known.add(item.id);
      upsert.push(item);
    } else if (!visible && known.has(item.id)) {
      known.delete(item.id);
      remove.push(item.id);
    }
  }
  // O que sumiu da cena sai por quem apagou (emitTiles/emitEffects); aqui so
  // se limpa a memoria, sem anunciar id.
  for (const id of known) if (!present.has(id)) known.delete(id);
  return { upsert, remove };
}

export function emitTiles(room: Room, scene: Scene, upsert: Tile[], remove: string[] = []): void {
  const strict = room.state.settings.strictVision;
  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    const gm = viewer.role === 'GM';
    if (!gm && scene.id !== room.state.activeSceneId) continue;

    let visible = upsert;
    let hide = remove;
    if (!gm) {
      // Envio so do cenario que o jogador ve; remocao so para quem tinha o
      // tile. Antes, apagar um tile exclusivo do mestre mandava o id a todos.
      const vision = strict ? visionFor(scene, viewer) : undefined;
      const known = (socket.data.visibleTiles ??= new Set());
      visible = upsert.filter((t) => tileShownTo(room, scene, t, viewer, vision));
      const shownIds = new Set(visible.map((t) => t.id));
      hide = [...remove, ...upsert.filter((t) => !shownIds.has(t.id)).map((t) => t.id)].filter((id) =>
        known.has(id),
      );
      for (const id of hide) known.delete(id);
      for (const t of visible) known.add(t.id);
    }
    if (visible.length || hide.length) {
      syncAssets(room, socket, visible.map((t) => t.assetId));
      socket.emit('tiles:patch', { sceneId: scene.id, upsert: visible, remove: hide });
    }
  }
}

export function emitEffects(room: Room, scene: Scene, upsert: MapEffect[], remove: string[] = []): void {
  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    const gm = viewer.role === 'GM';
    if (!gm && scene.id !== room.state.activeSceneId) continue;

    let visible = upsert;
    let hide = remove;
    if (!gm) {
      // Remocao so para quem tinha o efeito; envio so para quem pode ve-lo.
      // E isto que tira a alucinacao da tela de quem saiu da lista e a
      // entrega a quem entrou, sem anunciar o id a mais ninguem.
      const vision = room.state.settings.strictVision ? visionFor(scene, viewer) : undefined;
      const known = (socket.data.visibleEffects ??= new Set());
      visible = upsert.filter((e) => effectShownTo(room, scene, e, viewer, vision));
      const shownIds = new Set(visible.map((e) => e.id));
      hide = [...remove, ...upsert.filter((e) => !shownIds.has(e.id)).map((e) => e.id)].filter((id) =>
        known.has(id),
      );
      for (const id of hide) known.delete(id);
      for (const e of visible) known.add(e.id);
    }
    if (visible.length || hide.length) {
      syncAssets(room, socket, visible.map((e) => e.assetId));
      socket.emit('effects:patch', { sceneId: scene.id, upsert: visible, remove: hide });
    }
  }
}

export function emitWalls(room: Room, scene: Scene, upsert: Wall[], remove: string[] = []): void {
  const strict = room.state.settings.strictVision;
  for (const socket of socketsOf(room)) {
    const gm = socket.data.viewer.role === 'GM';
    if (gm) {
      socket.emit('walls:patch', { sceneId: scene.id, upsert, remove });
      continue;
    }
    if (scene.id !== room.state.activeSceneId) continue;

    // Mesma regra do estado inicial (`wallShownTo`); a remocao so vai a quem
    // tinha a parede, para nao anunciar o id de uma porta que ele nunca viu.
    const vision = strict ? visionFor(scene, socket.data.viewer) : undefined;
    const known = (socket.data.visibleWalls ??= new Set());
    const shown = upsert.filter((w) => wallShownTo(room, scene, w, socket.data.viewer, vision));
    const shownIds = new Set(shown.map((w) => w.id));
    const hide = [...remove, ...upsert.filter((w) => !shownIds.has(w.id)).map((w) => w.id)].filter((id) => known.has(id));
    for (const id of hide) known.delete(id);
    for (const w of shown) known.add(w.id);
    const allowed = shown.map(wallForPlayer);

    if (allowed.length || hide.length) {
      socket.emit('walls:patch', { sceneId: scene.id, upsert: allowed, remove: hide });
    }
  }
}

export function emitPlayers(room: Room): void {
  for (const socket of socketsOf(room)) {
    const players = playersWithPortraits(room, socket.data.viewer);
    // Sem os dados da imagem o jogador veria o retrato do colega quebrado.
    syncAssets(room, socket, players.map((p) => p.portraitAssetId));
    socket.emit('players:patch', players);
  }
}

export function emitTurns(room: Room): void {
  for (const socket of socketsOf(room)) {
    socket.emit('turns:patch', turnsForViewer(room, socket.data.viewer));
  }
}

export function notify(socket: TypedSocket, level: 'info' | 'warn' | 'error', message: string): void {
  socket.emit('notice', { level, message });
}
