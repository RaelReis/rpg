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

import {
  assetIdsOfScene,
  playersWithPortraits,
  sceneForViewer,
  stateForViewer,
  tokenForViewer,
  visibleTokenIds,
  visionFor,
  type Viewer,
} from './filter.js';
import type { Room } from './room.js';

export interface SocketData {
  tableId: string;
  viewer: Viewer;
  /** Cache do que este socket enxerga, para emitir apenas o delta. */
  visibleTokens: Set<string>;
  currentSceneId: string | null;
  /** Imagens cujos dados este socket ja recebeu. Ver `syncAssets`. */
  knownAssets: Set<string>;
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
    if (s?.data.viewer) out.push(s);
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

export function sendFullState(room: Room, socket: TypedSocket): void {
  const state = stateForViewer(room, socket.data.viewer);
  const scene = state.scenes.find((s) => s.id === state.activeSceneId) ?? state.scenes[0] ?? null;

  socket.data.currentSceneId = scene?.id ?? null;
  socket.data.visibleTokens = new Set(scene?.tokens.map((t) => t.id) ?? []);
  socket.data.knownAssets = new Set(state.assets.map((a) => a.id));
  socket.emit('table:state', state);
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
    socket.data.currentSceneId = filtered.id;
    socket.data.visibleTokens = new Set(filtered.tokens.map((t) => t.id));
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

  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    if (viewer.role === 'GM') continue;
    if (scene.id !== room.state.activeSceneId) continue;
    if (onlyPlayerIds && !onlyPlayerIds.has(viewer.playerId)) continue;

    const vision = visionFor(scene, viewer);
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

    if (strict) {
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
    if (socket.data.viewer.role !== 'GM' && scene.id !== room.state.activeSceneId) continue;
    socket.data.visibleTokens?.delete(tokenId);
    socket.emit('tokens:patch', { sceneId: scene.id, remove: [tokenId] });
  }
}

export function emitTiles(room: Room, scene: Scene, upsert: Tile[], remove: string[] = []): void {
  for (const socket of socketsOf(room)) {
    const gm = socket.data.viewer.role === 'GM';
    if (!gm && scene.id !== room.state.activeSceneId) continue;
    const visible = gm ? upsert : upsert.filter((t) => !t.gmOnly);
    const hide = gm ? remove : [...remove, ...upsert.filter((t) => t.gmOnly).map((t) => t.id)];
    if (visible.length || hide.length) {
      syncAssets(room, socket, visible.map((t) => t.assetId));
      socket.emit('tiles:patch', { sceneId: scene.id, upsert: visible, remove: hide });
    }
  }
}

export function emitEffects(room: Room, scene: Scene, upsert: MapEffect[], remove: string[] = []): void {
  for (const socket of socketsOf(room)) {
    const gm = socket.data.viewer.role === 'GM';
    if (!gm && scene.id !== room.state.activeSceneId) continue;
    const hidden = (e: MapEffect) => e.gmOnly || e.visibility === 'hidden';
    const visible = gm ? upsert : upsert.filter((e) => !hidden(e));
    const hide = gm ? remove : [...remove, ...upsert.filter(hidden).map((e) => e.id)];
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

    // Sem strictVision o cliente calcula a propria visao e precisa das paredes.
    // Portas e janelas sao coisas que o jogador enxerga no mapa; paredes
    // comuns, nao.
    const drawable = (w: Wall) => (w.door || w.window) && !w.hidden;
    const allowed = strict ? upsert.filter(drawable) : upsert.filter((w) => !w.hidden);
    const hide = strict
      ? [...remove, ...upsert.filter((w) => !drawable(w)).map((w) => w.id)]
      : [...remove, ...upsert.filter((w) => w.hidden).map((w) => w.id)];

    if (allowed.length || hide.length) {
      socket.emit('walls:patch', { sceneId: scene.id, upsert: allowed, remove: hide });
    }
  }
}

export function emitPlayers(room: Room): void {
  const players = playersWithPortraits(room);
  for (const socket of socketsOf(room)) {
    // Sem os dados da imagem o jogador veria o retrato do colega quebrado.
    syncAssets(room, socket, players.map((p) => p.portraitAssetId));
    socket.emit('players:patch', players);
  }
}

export function emitInitiative(room: Room): void {
  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    const initiative =
      viewer.role === 'GM'
        ? room.state.initiative
        : {
            ...room.state.initiative,
            entries: room.state.initiative.entries.filter((e) => !e.hiddenFromPlayers),
          };
    socket.emit('initiative:patch', initiative);
  }
}

export function notify(socket: TypedSocket, level: 'info' | 'warn' | 'error', message: string): void {
  socket.emit('notice', { level, message });
}
