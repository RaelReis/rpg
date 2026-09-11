import {
  cellHeight,
  createEffect,
  createTile,
  createToken,
  createWall,
  movementBlocked,
  newlyExploredCells,
  snapTokenPosition,
  type Ack,
  type FogPaintPayload,
  type FogResetPayload,
  type Layer,
  type MapEffect,
  type Scene,
  type Tile,
  type Token,
  type TokenMovePayload,
  type Wall,
} from '@rpg/shared';

import { atCapacity, LIMIT_MESSAGES } from '../limits.js';
import {
  emitEffects,
  emitTiles,
  emitTokenMove,
  emitTokenRemoved,
  emitTokenUpsert,
  emitWalls,
  refreshVision,
  socketsOf,
} from '../broadcast.js';
import { canMoveToken, clampNumber, fail, isGm, ok, ownedAsset, safeString, type Ctx } from './context.js';

/** Tokens, tiles, efeitos, paredes e neblina. */

const MAX_CELLS_PER_PAINT = 20000;
const VISIBILITIES = ['visible', 'hidden', 'dim'] as const;
const EFFECT_KINDS = ['circle', 'cone', 'rect', 'line', 'text', 'image'] as const;
const ANCHORS = ['grid', 'token', 'free'] as const;
const TOKEN_SHAPES = ['circle', 'art'] as const;
const EFFECT_STYLES = [
  'flat',
  'glow',
  'pulse',
  'runes',
  'vortex',
  'mist',
  'embers',
  'static',
] as const;

function asLayer(v: unknown, fallback: Layer): Layer {
  return v === 1 || v === 2 || v === 3 || v === 4 ? v : fallback;
}

/**
 * Durante um arraste o cliente emite dezenas de posicoes por segundo. Recalcular
 * a visao a cada uma delas seria desperdicio, entao o fog do jogador que
 * arrasta e atualizado no maximo a cada 100ms; ao soltar, a revisao completa
 * acontece de qualquer forma.
 */
const DRAG_VISION_INTERVAL_MS = 100;
const lastDragVision = new Map<string, number>();

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function createTokenHandler(
  ctx: Ctx,
  payload: { sceneId: string; token: Partial<Token> },
  ack: Ack<Token>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  if (atCapacity(scene.tokens, 'tokens')) return fail(ack, LIMIT_MESSAGES.tokens);

  const t = payload.token ?? {};
  const token = createToken({
    name: safeString(t.name, 60, 'Token'),
    assetId: ownedAsset(ctx, t.assetId),
    color: safeString(t.color, 32, '#7a8bd4'),
    x: clampNumber(t.x, -10000, 30000, 0),
    y: clampNumber(t.y, -10000, 30000, 0),
    scale: clampNumber(t.scale, 0.25, 20, 1),
    rotation: clampNumber(t.rotation, -360, 360, 0),
    layer: asLayer(t.layer, 3),
    shape: TOKEN_SHAPES.includes(t.shape as never) ? t.shape : 'circle',
    visibility: VISIBILITIES.includes(t.visibility as never) ? t.visibility : 'visible',
    opacity: clampNumber(t.opacity, 0.05, 1, 1),
    gmOnly: Boolean(t.gmOnly),
    ownerPlayerId: t.ownerPlayerId ?? null,
    sheetId: t.sheetId ?? null,
    visionRadius: clampNumber(t.visionRadius, 0, 40, 0),
    lightRadius: clampNumber(t.lightRadius, 0, 40, 0),
    bars: Array.isArray(t.bars) ? t.bars.slice(0, 4) : [],
    label: safeString(t.label, 40, ''),
    conditions: Array.isArray(t.conditions) ? t.conditions.slice(0, 12) : [],
  });

  if (scene.grid.snap && scene.grid.type !== 'none') {
    const snapped = snapTokenPosition(scene.grid, { x: token.x, y: token.y }, token.scale);
    token.x = snapped.x;
    token.y = snapped.y;
  }

  scene.tokens.push(token);
  ctx.room.touchScene(scene.id);
  emitTokenUpsert(ctx.room, scene, token);
  applyExploration(ctx, scene);
  refreshVision(ctx.room, scene);
  ok(ack, token);
}

export function updateToken(
  ctx: Ctx,
  payload: { sceneId: string; tokenId: string; patch: Partial<Token> },
  ack: Ack<null>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const token = scene.tokens.find((t) => t.id === payload.tokenId);
  if (!token) return fail(ack, 'Token nao encontrado.');

  const gm = isGm(ctx);
  const isOwner = token.ownerPlayerId === ctx.viewer.playerId;
  if (!gm && !isOwner) return fail(ack, 'Voce nao controla este token.');

  const p = payload.patch ?? {};
  let visionAffected = false;

  // Fora do papel de mestre, o jogador so ajusta a apresentacao do proprio
  // token: nada que mude visibilidade, camada, dono ou alcance de visao.
  if (p.rotation !== undefined) token.rotation = clampNumber(p.rotation, -360, 360, token.rotation);
  if (p.label !== undefined) token.label = safeString(p.label, 40, token.label);
  if (p.conditions !== undefined && Array.isArray(p.conditions)) {
    token.conditions = p.conditions.slice(0, 12).map((c) => safeString(c, 24));
  }

  if (gm) {
    if (p.name !== undefined) token.name = safeString(p.name, 60, token.name);
    if (p.assetId !== undefined) token.assetId = ownedAsset(ctx, p.assetId);
    if (p.color !== undefined) token.color = safeString(p.color, 32, token.color);
    if (p.scale !== undefined) {
      token.scale = clampNumber(p.scale, 0.25, 20, token.scale);
      visionAffected = true;
    }
    if (p.layer !== undefined) {
      token.layer = asLayer(p.layer, token.layer);
      visionAffected = true;
    }
    if (p.shape !== undefined && TOKEN_SHAPES.includes(p.shape as never)) token.shape = p.shape;
    if (p.visibility !== undefined && VISIBILITIES.includes(p.visibility as never)) {
      token.visibility = p.visibility;
      visionAffected = true;
    }
    if (p.opacity !== undefined) token.opacity = clampNumber(p.opacity, 0.05, 1, token.opacity);
    if (p.gmOnly !== undefined) {
      token.gmOnly = Boolean(p.gmOnly);
      visionAffected = true;
    }
    if (p.ownerPlayerId !== undefined) {
      token.ownerPlayerId = p.ownerPlayerId;
      visionAffected = true;
    }
    if (p.sheetId !== undefined) token.sheetId = p.sheetId;
    if (p.visionRadius !== undefined) {
      token.visionRadius = clampNumber(p.visionRadius, 0, 40, token.visionRadius);
      visionAffected = true;
    }
    if (p.lightRadius !== undefined) {
      token.lightRadius = clampNumber(p.lightRadius, 0, 40, token.lightRadius);
      visionAffected = true;
    }
    if (p.bars !== undefined && Array.isArray(p.bars)) token.bars = p.bars.slice(0, 4);
    if (p.locked !== undefined) token.locked = Boolean(p.locked);
    if (p.x !== undefined) token.x = clampNumber(p.x, -10000, 30000, token.x);
    if (p.y !== undefined) token.y = clampNumber(p.y, -10000, 30000, token.y);
  }

  ctx.room.touchScene(scene.id);
  emitTokenUpsert(ctx.room, scene, token);
  if (visionAffected) {
    applyExploration(ctx, scene);
    refreshVision(ctx.room, scene);
  }
  ok(ack, null);
}

export function moveToken(ctx: Ctx, payload: TokenMovePayload, ack?: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const token = scene.tokens.find((t) => t.id === payload.tokenId);
  if (!token) return fail(ack, 'Token nao encontrado.');
  if (!canMoveToken(ctx, token)) return fail(ack, 'Voce nao pode mover este token.');

  const dragging = payload.dragging === true;
  let x = clampNumber(payload.x, -10000, 30000, token.x);
  let y = clampNumber(payload.y, -10000, 30000, token.y);

  const from = { x: token.x, y: token.y };

  // O snap so entra ao soltar: durante o arraste o token acompanha o cursor.
  if (!dragging && scene.grid.snap && scene.grid.type !== 'none') {
    const snapped = snapTokenPosition(scene.grid, { x, y }, token.scale);
    x = snapped.x;
    y = snapped.y;
  }

  const w = scene.grid.size * token.scale;
  const h = cellHeight(scene.grid) * token.scale;
  x = Math.min(Math.max(x, -w), scene.width);
  y = Math.min(Math.max(y, -h), scene.height);

  /*
   * Paredes barram o movimento a CADA passo do arraste, e nao apenas ao
   * soltar.
   *
   * Validar so no fim parecia mais suave, mas nao funciona: cada evento de
   * arraste ja grava a posicao nova no servidor, entao no evento final a
   * origem do teste seria a ultima posicao do arraste — do outro lado da
   * parede — e o segmento medido seria de poucos pixels. O token atravessava
   * qualquer parede desde que a pessoa arrastasse em vez de saltar.
   *
   * Barrar passo a passo tambem fecha um vazamento: um token que atravessa a
   * parede durante o arraste revela a neblina do outro lado, e a area
   * explorada e permanente — voltar o token depois nao desfaz o que o grupo
   * ja viu.
   *
   * O mestre passa por paredes de proposito: ele precisa posicionar um NPC
   * dentro de uma cripta fechada enquanto monta a cena.
   */
  if (!isGm(ctx) && ctx.room.state.settings.wallsBlockMovement) {
    const center = (p: { x: number; y: number }) => ({ x: p.x + w / 2, y: p.y + h / 2 });
    if (movementBlocked(scene, center(from), center({ x, y }))) {
      // Durante o arraste a recusa e silenciosa: a previa local do cliente
      // segue o cursor, e avisar a cada quadro encheria a tela de erros.
      // O token simplesmente nao sai do lugar no servidor.
      if (dragging) return ok(ack, null);

      // Ao soltar, o token para onde o arraste chegou — encostado na parede.
      // Sem isto ele ficaria fora da grade, porque o arraste nao usa snap.
      if (scene.grid.snap && scene.grid.type !== 'none') {
        const settled = snapTokenPosition(scene.grid, { x: token.x, y: token.y }, token.scale);
        if (!movementBlocked(scene, center(token), center(settled))) {
          token.x = settled.x;
          token.y = settled.y;
          ctx.room.touchScene(scene.id);
        }
      }

      emitTokenMove(ctx.room, scene, token);
      refreshVision(ctx.room, scene);
      return fail(ack, 'Ha uma parede no caminho.');
    }
  }

  token.x = x;
  token.y = y;

  emitTokenMove(ctx.room, scene, token);

  if (dragging) {
    // Atualiza a neblina de quem esta arrastando, sem custear a mesa inteira.
    const owner = token.ownerPlayerId ?? (isGm(ctx) ? null : ctx.viewer.playerId);
    if (owner && token.visionRadius > 0) {
      const now = Date.now();
      const last = lastDragVision.get(token.id) ?? 0;
      if (now - last >= DRAG_VISION_INTERVAL_MS) {
        lastDragVision.set(token.id, now);
        applyExploration(ctx, scene);
        refreshVision(ctx.room, scene, new Set([owner]));
      }
    }
    return ok(ack, null);
  }

  lastDragVision.delete(token.id);
  ctx.room.touchScene(scene.id);
  applyExploration(ctx, scene);
  refreshVision(ctx.room, scene);
  ok(ack, null);
}

export function deleteToken(ctx: Ctx, payload: { sceneId: string; tokenId: string }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const index = scene.tokens.findIndex((t) => t.id === payload.tokenId);
  if (index === -1) return fail(ack, 'Token nao encontrado.');

  scene.tokens.splice(index, 1);

  // Efeitos presos ao token desaparecem junto com ele.
  const orphans = scene.effects.filter((e) => e.anchor === 'token' && e.tokenId === payload.tokenId);
  if (orphans.length) {
    scene.effects = scene.effects.filter((e) => !orphans.includes(e));
    emitEffects(ctx.room, scene, [], orphans.map((e) => e.id));
  }

  ctx.room.touchScene(scene.id);
  emitTokenRemoved(ctx.room, scene, payload.tokenId);
  refreshVision(ctx.room, scene);
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Neblina
// ---------------------------------------------------------------------------

/** Acumula em `fog.explored` o que os tokens de jogador acabaram de descobrir. */
function applyExploration(ctx: Ctx, scene: Scene): void {
  const fresh = newlyExploredCells(scene);
  if (fresh.length === 0) return;

  scene.fog.explored.push(...fresh);
  ctx.room.touchScene(scene.id);

  emitFogPatch(ctx, scene, { explored: { add: fresh } });
}

export function paintFog(ctx: Ctx, payload: FogPaintPayload, ack?: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const cells = Array.isArray(payload.cells) ? payload.cells.slice(0, MAX_CELLS_PER_PAINT) : [];
  if (cells.length === 0) return ok(ack, null);

  const apply = (list: string[], add: boolean): string[] => {
    const set = new Set(list);
    const changed: string[] = [];
    for (const c of cells) {
      if (add ? !set.has(c) : set.has(c)) {
        changed.push(c);
        if (add) set.add(c);
        else set.delete(c);
      }
    }
    list.length = 0;
    list.push(...set);
    return changed;
  };

  let patch: FogDelta = {};

  switch (payload.action) {
    case 'reveal': {
      const added = apply(scene.fog.revealed, true);
      const unhidden = apply(scene.fog.hidden, false);
      patch = { revealed: { add: added }, hidden: { remove: unhidden } };
      break;
    }
    case 'hide': {
      // Cobrir de volta, sem selar: apaga o revelado e o explorado, e a area
      // volta a ser descobrivel por quem andar ate la. E o que se espera do
      // gesto de "fechar o mapa" — selar seria uma decisao bem mais forte,
      // e por isso mora em `block`.
      const unrevealed = apply(scene.fog.revealed, false);
      const unexplored = apply(scene.fog.explored, false);
      patch = { revealed: { remove: unrevealed }, explored: { remove: unexplored } };
      break;
    }
    case 'block': {
      const added = apply(scene.fog.hidden, true);
      const unrevealed = apply(scene.fog.revealed, false);
      const unexplored = apply(scene.fog.explored, false);
      patch = {
        hidden: { add: added },
        revealed: { remove: unrevealed },
        explored: { remove: unexplored },
      };
      break;
    }
    case 'clear-reveal':
      patch = { revealed: { remove: apply(scene.fog.revealed, false) } };
      break;
    case 'unblock':
      patch = { hidden: { remove: apply(scene.fog.hidden, false) } };
      break;
    default:
      return fail(ack, 'Acao de neblina invalida.');
  }

  ctx.room.touchScene(scene.id);
  emitFogPatch(ctx, scene, patch);
  refreshVision(ctx.room, scene);
  ok(ack, null);
}

type FogSetDelta = { add?: string[]; remove?: string[] };
type FogDelta = { explored?: FogSetDelta; revealed?: FogSetDelta; hidden?: FogSetDelta };

/**
 * Entrega as listas cruas de neblina a quem tem direito a elas.
 *
 * O mestre sempre recebe. O jogador so recebe sem `strictVision`: nesse modo o
 * cliente dele calcula a propria visao a partir dessas listas, e o estado
 * completo ja as envia. Antes so o mestre recebia os deltas, entao a area que
 * o mestre revelava — e o que o grupo explorava — nunca chegava ao jogador
 * ate ele recarregar a pagina. Com `strictVision` o jogador continua recebendo
 * apenas o resultado ja calculado, por `refreshVision`.
 */
function emitFogPatch(ctx: Ctx, scene: Scene, patch: FogDelta | { reset: FogSetLists }): void {
  const strict = ctx.room.state.settings.strictVision;
  for (const socket of socketsOf(ctx.room)) {
    const gm = socket.data.viewer.role === 'GM';
    if (!gm && (strict || scene.id !== ctx.room.state.activeSceneId)) continue;
    socket.emit('fog:patch', { sceneId: scene.id, ...patch });
  }
}

type FogSetLists = { explored: string[]; revealed: string[]; hidden: string[] };

export function resetFog(ctx: Ctx, payload: FogResetPayload, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const scope = payload.scope;
  if (scope === 'explored' || scope === 'all') scene.fog.explored = [];
  if (scope === 'revealed' || scope === 'all') scene.fog.revealed = [];
  if (scope === 'hidden' || scope === 'all') scene.fog.hidden = [];

  ctx.room.touchScene(scene.id);
  emitFogPatch(ctx, scene, {
    reset: {
      explored: scene.fog.explored,
      revealed: scene.fog.revealed,
      hidden: scene.fog.hidden,
    },
  });
  refreshVision(ctx.room, scene);
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export function createTileHandler(ctx: Ctx, payload: { sceneId: string; tile: Partial<Tile> }, ack: Ack<Tile>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  if (atCapacity(scene.tiles, 'tiles')) return fail(ack, LIMIT_MESSAGES.tiles);

  const t = payload.tile ?? {};
  const tile = createTile({
    assetId: ownedAsset(ctx, t.assetId),
    color: t.color ?? null,
    x: clampNumber(t.x, -10000, 30000, 0),
    y: clampNumber(t.y, -10000, 30000, 0),
    width: clampNumber(t.width, 4, 20000, scene.grid.size),
    height: clampNumber(t.height, 4, 20000, scene.grid.size),
    rotation: clampNumber(t.rotation, -360, 360, 0),
    opacity: clampNumber(t.opacity, 0.05, 1, 1),
    layer: asLayer(t.layer, 2),
    blocksVision: Boolean(t.blocksVision),
    gmOnly: Boolean(t.gmOnly),
  });

  scene.tiles.push(tile);
  ctx.room.touchScene(scene.id);
  emitTiles(ctx.room, scene, [tile]);
  if (tile.blocksVision) refreshVision(ctx.room, scene);
  ok(ack, tile);
}

export function updateTile(
  ctx: Ctx,
  payload: { sceneId: string; tileId: string; patch: Partial<Tile> },
  ack: Ack<null>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const tile = scene.tiles.find((t) => t.id === payload.tileId);
  if (!tile) return fail(ack, 'Tile nao encontrado.');

  const p = payload.patch ?? {};
  const blockedBefore = tile.blocksVision;

  if (p.assetId !== undefined) tile.assetId = ownedAsset(ctx, p.assetId);
  if (p.color !== undefined) tile.color = p.color;
  if (p.x !== undefined) tile.x = clampNumber(p.x, -10000, 30000, tile.x);
  if (p.y !== undefined) tile.y = clampNumber(p.y, -10000, 30000, tile.y);
  if (p.width !== undefined) tile.width = clampNumber(p.width, 4, 20000, tile.width);
  if (p.height !== undefined) tile.height = clampNumber(p.height, 4, 20000, tile.height);
  if (p.rotation !== undefined) tile.rotation = clampNumber(p.rotation, -360, 360, tile.rotation);
  if (p.opacity !== undefined) tile.opacity = clampNumber(p.opacity, 0.05, 1, tile.opacity);
  if (p.layer !== undefined) tile.layer = asLayer(p.layer, tile.layer);
  if (p.blocksVision !== undefined) tile.blocksVision = Boolean(p.blocksVision);
  if (p.gmOnly !== undefined) tile.gmOnly = Boolean(p.gmOnly);
  if (p.locked !== undefined) tile.locked = Boolean(p.locked);

  ctx.room.touchScene(scene.id);
  emitTiles(ctx.room, scene, [tile]);
  if (blockedBefore || tile.blocksVision) refreshVision(ctx.room, scene);
  ok(ack, null);
}

export function deleteTile(ctx: Ctx, payload: { sceneId: string; tileId: string }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const index = scene.tiles.findIndex((t) => t.id === payload.tileId);
  if (index === -1) return fail(ack, 'Tile nao encontrado.');

  const [removed] = scene.tiles.splice(index, 1);
  ctx.room.touchScene(scene.id);
  emitTiles(ctx.room, scene, [], [removed.id]);
  if (removed.blocksVision) refreshVision(ctx.room, scene);
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Efeitos de mapa
// ---------------------------------------------------------------------------

export function createEffectHandler(
  ctx: Ctx,
  payload: { sceneId: string; effect: Partial<MapEffect> },
  ack: Ack<MapEffect>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const gm = isGm(ctx);
  if (!gm && !ctx.room.state.settings.playersCanAnnotate) {
    return fail(ack, 'O mestre desativou anotacoes dos jogadores.');
  }

  const e = payload.effect ?? {};
  const anchor = ANCHORS.includes(e.anchor as never) ? e.anchor! : 'free';

  // Ancorar a um token exige que ele exista; senao o efeito ficaria orfao.
  if (anchor === 'token' && !scene.tokens.some((t) => t.id === e.tokenId)) {
    return fail(ack, 'Token de ancoragem nao encontrado.');
  }

  if (atCapacity(scene.effects, 'effects')) return fail(ack, LIMIT_MESSAGES.effects);

  const effect = createEffect({
    kind: EFFECT_KINDS.includes(e.kind as never) ? e.kind : 'circle',
    label: safeString(e.label, 120, ''),
    color: safeString(e.color, 32, '#e0a33e'),
    opacity: clampNumber(e.opacity, 0.05, 1, 0.45),
    assetId: ownedAsset(ctx, e.assetId),
    anchor,
    cell: anchor === 'grid' && e.cell ? { a: Math.round(e.cell.a), b: Math.round(e.cell.b) } : null,
    tokenId: anchor === 'token' ? (e.tokenId ?? null) : null,
    x: clampNumber(e.x, -30000, 30000, 0),
    y: clampNumber(e.y, -30000, 30000, 0),
    radius: clampNumber(e.radius, 0, 200, 2),
    width: clampNumber(e.width, 0, 200, 2),
    height: clampNumber(e.height, 0, 200, 2),
    angle: clampNumber(e.angle, -360, 360, 0),
    spread: clampNumber(e.spread, 1, 360, 60),
    // Anotacao de jogador vive na camada de efeitos e nunca e exclusiva do mestre.
    layer: gm ? asLayer(e.layer, 4) : 4,
    visibility: gm && VISIBILITIES.includes(e.visibility as never) ? e.visibility! : 'visible',
    gmOnly: gm ? Boolean(e.gmOnly) : false,
    fontSize: clampNumber(e.fontSize, 8, 200, 28),
    style: EFFECT_STYLES.includes(e.style as never) ? e.style : 'flat',
    colorAlt: safeString(e.colorAlt, 32, '#ffffff'),
    speed: clampNumber(e.speed, 0, 4, 1),
  });

  scene.effects.push(effect);
  ctx.room.touchScene(scene.id);
  emitEffects(ctx.room, scene, [effect]);
  ok(ack, effect);
}

export function updateEffect(
  ctx: Ctx,
  payload: { sceneId: string; effectId: string; patch: Partial<MapEffect> },
  ack: Ack<null>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const effect = scene.effects.find((e) => e.id === payload.effectId);
  if (!effect) return fail(ack, 'Efeito nao encontrado.');
  if (!isGm(ctx) && !ctx.room.state.settings.playersCanAnnotate) {
    return fail(ack, 'Apenas o mestre pode editar efeitos.');
  }

  const p = payload.patch ?? {};
  if (p.kind !== undefined && EFFECT_KINDS.includes(p.kind as never)) effect.kind = p.kind;
  if (p.label !== undefined) effect.label = safeString(p.label, 120, effect.label);
  if (p.color !== undefined) effect.color = safeString(p.color, 32, effect.color);
  if (p.opacity !== undefined) effect.opacity = clampNumber(p.opacity, 0.05, 1, effect.opacity);
  if (p.assetId !== undefined) effect.assetId = ownedAsset(ctx, p.assetId);
  if (p.anchor !== undefined && ANCHORS.includes(p.anchor as never)) effect.anchor = p.anchor;
  if (p.cell !== undefined) {
    effect.cell = p.cell ? { a: Math.round(p.cell.a), b: Math.round(p.cell.b) } : null;
  }
  if (p.tokenId !== undefined) effect.tokenId = p.tokenId;
  if (p.x !== undefined) effect.x = clampNumber(p.x, -30000, 30000, effect.x);
  if (p.y !== undefined) effect.y = clampNumber(p.y, -30000, 30000, effect.y);
  if (p.radius !== undefined) effect.radius = clampNumber(p.radius, 0, 200, effect.radius);
  if (p.width !== undefined) effect.width = clampNumber(p.width, 0, 200, effect.width);
  if (p.height !== undefined) effect.height = clampNumber(p.height, 0, 200, effect.height);
  if (p.angle !== undefined) effect.angle = clampNumber(p.angle, -360, 360, effect.angle);
  if (p.spread !== undefined) effect.spread = clampNumber(p.spread, 1, 360, effect.spread);
  if (p.fontSize !== undefined) effect.fontSize = clampNumber(p.fontSize, 8, 200, effect.fontSize);
  if (p.style !== undefined && EFFECT_STYLES.includes(p.style as never)) effect.style = p.style;
  if (p.colorAlt !== undefined) effect.colorAlt = safeString(p.colorAlt, 32, effect.colorAlt);
  if (p.speed !== undefined) effect.speed = clampNumber(p.speed, 0, 4, effect.speed);

  if (isGm(ctx)) {
    if (p.layer !== undefined) effect.layer = asLayer(p.layer, effect.layer);
    if (p.visibility !== undefined && VISIBILITIES.includes(p.visibility as never)) {
      effect.visibility = p.visibility;
    }
    if (p.gmOnly !== undefined) effect.gmOnly = Boolean(p.gmOnly);
  }

  ctx.room.touchScene(scene.id);
  emitEffects(ctx.room, scene, [effect]);
  ok(ack, null);
}

export function deleteEffect(ctx: Ctx, payload: { sceneId: string; effectId: string }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const index = scene.effects.findIndex((e) => e.id === payload.effectId);
  if (index === -1) return fail(ack, 'Efeito nao encontrado.');
  if (!isGm(ctx) && !ctx.room.state.settings.playersCanAnnotate) {
    return fail(ack, 'Apenas o mestre pode remover efeitos.');
  }

  scene.effects.splice(index, 1);
  ctx.room.touchScene(scene.id);
  emitEffects(ctx.room, scene, [], [payload.effectId]);
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Paredes
// ---------------------------------------------------------------------------

/**
 * Distancia, em pixels do mapa, abaixo da qual uma ponta nova e soldada a uma
 * ponta existente. O editor ja encaixa as pontas enquanto a pessoa desenha;
 * isto cobre o que chega de outro jeito (importacao, arredondamento de ponto
 * flutuante) e garante que pontas "quase juntas" virem o MESMO ponto — uma
 * fresta de meio pixel ja deixa a visao escapar.
 */
const WELD_DISTANCE = 2;

function weldToExisting(scene: Scene, point: { x: number; y: number }): { x: number; y: number } {
  let best = point;
  let bestDistance = WELD_DISTANCE;
  for (const wall of scene.walls) {
    for (const end of [{ x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }]) {
      const d = Math.hypot(end.x - point.x, end.y - point.y);
      if (d <= bestDistance) {
        best = end;
        bestDistance = d;
      }
    }
  }
  return best === point ? point : { x: best.x, y: best.y };
}

export function createWallHandler(ctx: Ctx, payload: { sceneId: string; wall: Partial<Wall> }, ack: Ack<Wall>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  if (atCapacity(scene.walls, 'walls')) return fail(ack, LIMIT_MESSAGES.walls);

  const w = payload.wall ?? {};
  const start = weldToExisting(scene, {
    x: clampNumber(w.x1, -30000, 30000, 0),
    y: clampNumber(w.y1, -30000, 30000, 0),
  });
  const end = weldToExisting(scene, {
    x: clampNumber(w.x2, -30000, 30000, 0),
    y: clampNumber(w.y2, -30000, 30000, 0),
  });
  // Segmento de comprimento zero nao bloqueia nada e so polui a lista.
  if (start.x === end.x && start.y === end.y) return fail(ack, 'Parede sem comprimento.');

  const wall = createWall({
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    door: Boolean(w.door),
    open: Boolean(w.open),
    window: Boolean(w.window),
    hidden: Boolean(w.hidden),
  });

  scene.walls.push(wall);
  ctx.room.touchScene(scene.id);
  emitWalls(ctx.room, scene, [wall]);
  refreshVision(ctx.room, scene);
  ok(ack, wall);
}

export function updateWall(
  ctx: Ctx,
  payload: { sceneId: string; wallId: string; patch: Partial<Wall> },
  ack: Ack<null>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const wall = scene.walls.find((w) => w.id === payload.wallId);
  if (!wall) return fail(ack, 'Parede nao encontrada.');

  const p = payload.patch ?? {};
  const gm = isGm(ctx);

  // Jogador nao edita geometria de parede, mas pode abrir e fechar uma porta
  // visivel — e o que torna portas uteis durante a partida.
  if (!gm) {
    if (!wall.door || wall.hidden) return fail(ack, 'Apenas o mestre pode editar paredes.');
    if (p.open === undefined) return fail(ack, 'Jogadores so podem abrir ou fechar portas.');
    wall.open = Boolean(p.open);
  } else {
    if (p.x1 !== undefined) wall.x1 = clampNumber(p.x1, -30000, 30000, wall.x1);
    if (p.y1 !== undefined) wall.y1 = clampNumber(p.y1, -30000, 30000, wall.y1);
    if (p.x2 !== undefined) wall.x2 = clampNumber(p.x2, -30000, 30000, wall.x2);
    if (p.y2 !== undefined) wall.y2 = clampNumber(p.y2, -30000, 30000, wall.y2);
    // Porta e janela sao exclusivas: ligar uma desliga a outra.
    if (p.door !== undefined) {
      wall.door = Boolean(p.door);
      if (wall.door) wall.window = false;
    }
    if (p.window !== undefined) {
      wall.window = Boolean(p.window);
      if (wall.window) {
        wall.door = false;
        wall.open = false;
      }
    }
    if (p.open !== undefined) wall.open = wall.door && Boolean(p.open);
    if (p.hidden !== undefined) wall.hidden = Boolean(p.hidden);
  }

  ctx.room.touchScene(scene.id);
  emitWalls(ctx.room, scene, [wall]);
  refreshVision(ctx.room, scene);
  ok(ack, null);
}

export function deleteWall(ctx: Ctx, payload: { sceneId: string; wallId: string }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const index = scene.walls.findIndex((w) => w.id === payload.wallId);
  if (index === -1) return fail(ack, 'Parede nao encontrada.');

  scene.walls.splice(index, 1);
  ctx.room.touchScene(scene.id);
  emitWalls(ctx.room, scene, [], [payload.wallId]);
  refreshVision(ctx.room, scene);
  ok(ack, null);
}
