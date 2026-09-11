import {
  createScene,
  DEFAULT_SETTINGS,
  type Ack,
  type GridConfig,
  type Scene,
  type TableSettings,
} from '@rpg/shared';

import { atCapacity, LIMIT_MESSAGES } from '../limits.js';
import {
  pushScene,
  refreshVision,
  sendFullStateToAll,
  socketsOf,
} from '../broadcast.js';
import { clampNumber, fail, ok, ownedAsset, safeString, type Ctx } from './context.js';

/** Cenas (mapas), configuracao de grid e ajustes gerais da mesa. */

const GRID_TYPES = ['square', 'hex-pointy', 'hex-flat', 'none'] as const;
const FOG_MODES = ['off', 'manual', 'vision'] as const;
const WEATHER_KINDS = ['none', 'rain', 'snow', 'fog', 'ash'] as const;

function sanitizeGrid(patch: Partial<GridConfig>, current: GridConfig): GridConfig {
  return {
    type: GRID_TYPES.includes(patch.type as never) ? (patch.type as GridConfig['type']) : current.type,
    size: clampNumber(patch.size, 10, 500, current.size),
    offsetX: clampNumber(patch.offsetX, -5000, 5000, current.offsetX),
    offsetY: clampNumber(patch.offsetY, -5000, 5000, current.offsetY),
    color: safeString(patch.color, 32, current.color),
    opacity: clampNumber(patch.opacity, 0, 1, current.opacity),
    snap: typeof patch.snap === 'boolean' ? patch.snap : current.snap,
    unitsPerCell: clampNumber(patch.unitsPerCell, 0.01, 1000, current.unitsPerCell),
    unitLabel: safeString(patch.unitLabel, 8, current.unitLabel),
  };
}

/**
 * `scene:update` cobre apenas propriedades da cena. Tokens, tiles, efeitos e
 * paredes tem handlers proprios — aceita-los aqui permitiria substituir o
 * mapa inteiro num evento so, sem passar pelas checagens de cada tipo.
 */
export function updateScene(ctx: Ctx, payload: { sceneId: string; patch: Partial<Scene> }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  const p = payload.patch ?? {};
  let visionAffected = false;

  if (p.name !== undefined) scene.name = safeString(p.name, 80, scene.name);
  if (p.backgroundAssetId !== undefined) {
    scene.backgroundAssetId = ownedAsset(ctx, p.backgroundAssetId);
  }
  if (p.backgroundColor !== undefined) scene.backgroundColor = safeString(p.backgroundColor, 32, scene.backgroundColor);
  if (p.width !== undefined) scene.width = clampNumber(p.width, 100, 20000, scene.width);
  if (p.height !== undefined) scene.height = clampNumber(p.height, 100, 20000, scene.height);
  if (p.order !== undefined) scene.order = clampNumber(p.order, 0, 9999, scene.order);

  if (p.globalLight !== undefined) {
    scene.globalLight = clampNumber(p.globalLight, 0, 1, scene.globalLight);
    visionAffected = true;
  }

  if (p.weather) {
    const w = p.weather;
    if (w.kind && WEATHER_KINDS.includes(w.kind)) scene.weather.kind = w.kind;
    if (w.intensity !== undefined) {
      scene.weather.intensity = clampNumber(w.intensity, 0, 1, scene.weather.intensity);
    }
    if (w.angle !== undefined) scene.weather.angle = clampNumber(w.angle, -80, 80, scene.weather.angle);
  }

  if (p.grid) {
    scene.grid = sanitizeGrid(p.grid, scene.grid);
    visionAffected = true;
  }

  if (p.fog) {
    const f = p.fog;
    if (f.mode && FOG_MODES.includes(f.mode)) scene.fog.mode = f.mode;
    if (typeof f.rememberExplored === 'boolean') scene.fog.rememberExplored = f.rememberExplored;
    if (f.dimOpacity !== undefined) scene.fog.dimOpacity = clampNumber(f.dimOpacity, 0, 1, scene.fog.dimOpacity);
    if (f.edgeSoftness !== undefined) {
      scene.fog.edgeSoftness = clampNumber(f.edgeSoftness, 0, 1, scene.fog.edgeSoftness);
    }
    visionAffected = true;
  }

  ctx.room.touchScene(scene.id);
  pushScene(ctx.room, scene);
  if (visionAffected) refreshVision(ctx.room, scene);
  ok(ack, null);
}

export function createSceneHandler(
  ctx: Ctx,
  payload: { name: string; backgroundAssetId?: string | null },
  ack: Ack<Scene>,
): void {
  if (atCapacity(ctx.room.state.scenes, 'scenes')) return fail(ack, LIMIT_MESSAGES.scenes);

  const scene = createScene({
    name: safeString(payload?.name, 80, 'Nova cena') || 'Nova cena',
    backgroundAssetId: ownedAsset(ctx, payload?.backgroundAssetId),
    order: ctx.room.state.scenes.length,
  });

  // O mapa nasce do tamanho da imagem de fundo, quando houver.
  const asset = ctx.room.state.assets.find((a) => a.id === scene.backgroundAssetId);
  if (asset) {
    scene.width = asset.width;
    scene.height = asset.height;
  }

  ctx.room.state.scenes.push(scene);
  ctx.room.touchScene(scene.id);

  // Cenas novas sao material do mestre: o jogador so as recebe ao serem ativadas.
  for (const socket of socketsOf(ctx.room)) {
    if (socket.data.viewer.role === 'GM') {
      socket.emit('scene:patch', { sceneId: scene.id, patch: scene });
    }
  }
  ok(ack, scene);
}

export function deleteScene(ctx: Ctx, payload: { sceneId: string }, ack: Ack<null>): void {
  const index = ctx.room.state.scenes.findIndex((s) => s.id === payload?.sceneId);
  if (index === -1) return fail(ack, 'Cena nao encontrada.');
  if (ctx.room.state.scenes.length === 1) return fail(ack, 'A mesa precisa de pelo menos uma cena.');

  const [removed] = ctx.room.state.scenes.splice(index, 1);
  ctx.room.removeSceneRecord(removed.id);

  if (ctx.room.state.activeSceneId === removed.id) {
    ctx.room.state.activeSceneId = ctx.room.state.scenes[0]?.id ?? null;
    ctx.room.touch('table');
    sendFullStateToAll(ctx.room);
  } else {
    for (const socket of socketsOf(ctx.room)) {
      if (socket.data.viewer.role === 'GM') socket.emit('scene:removed', { sceneId: removed.id });
    }
  }
  ok(ack, null);
}

/**
 * Trocar de cena reescreve por completo o que os jogadores enxergam, entao
 * o caminho barato de delta nao serve: todos recebem o estado cheio de novo.
 */
export function activateScene(ctx: Ctx, payload: { sceneId: string }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');

  ctx.room.state.activeSceneId = scene.id;
  ctx.room.touch('table');

  sendFullStateToAll(ctx.room);
  for (const socket of socketsOf(ctx.room)) socket.emit('scene:activated', { sceneId: scene.id });
  ok(ack, null);
}

export function updateSettings(ctx: Ctx, patch: Partial<TableSettings>, ack: Ack<null>): void {
  const current = ctx.room.state.settings;
  const next: TableSettings = { ...DEFAULT_SETTINGS, ...current };

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof TableSettings)[]) {
    const value = patch?.[key];
    if (typeof value === 'boolean') next[key] = value;
  }

  const strictChanged = next.strictVision !== current.strictVision;
  ctx.room.state.settings = next;
  ctx.room.touch('table');

  for (const socket of socketsOf(ctx.room)) socket.emit('settings:patch', next);

  // Ligar/desligar strictVision muda o formato do payload da cena (paredes vs.
  // celulas ja calculadas), entao os jogadores precisam do estado inteiro.
  if (strictChanged) sendFullStateToAll(ctx.room);
  else {
    const scene = ctx.room.activeScene();
    if (scene) refreshVision(ctx.room, scene);
  }
  ok(ack, null);
}

export function renameTable(ctx: Ctx, name: string, ack: Ack<null>): void {
  const clean = safeString(name, 80).trim();
  if (!clean) return fail(ack, 'Nome invalido.');

  ctx.room.state.name = clean;
  ctx.room.touch('table');
  for (const socket of socketsOf(ctx.room)) socket.emit('table:renamed', clean);
  ok(ack, null);
}
