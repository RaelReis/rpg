import { DEFAULT_GRID } from './grid.js';
import type {
  FogConfig,
  InitiativeState,
  MapEffect,
  Scene,
  TableSettings,
  Tile,
  Token,
  Wall,
} from './types.js';

/** Fabricas de entidades. Cliente e servidor criam objetos completos pelos
 *  mesmos defaults, evitando campos `undefined` viajando pelo socket. */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?<T extends Uint8Array>(a: T): T } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function generateId(prefix = ''): string {
  const bytes = randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return prefix ? `${prefix}_${s}` : s;
}

/** Codigo de convite legivel em voz alta; sem 0/O e 1/I. */
export function generateTableCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let s = '';
  for (const b of bytes) s += chars[b % chars.length];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export const PLAYER_COLORS = [
  '#e05c5c',
  '#e0a33e',
  '#5cc98a',
  '#4a9fd9',
  '#9b7ede',
  '#d95ca8',
  '#4ec9c9',
  '#c9a24e',
];

export const DEFAULT_SETTINGS: TableSettings = {
  playersMoveOwnTokensOnly: true,
  showPartyBars: true,
  strictVision: true,
  playersCanAnnotate: false,
  diceEnabled: true,
};

export const DEFAULT_INITIATIVE: InitiativeState = {
  active: false,
  round: 0,
  activeEntryId: null,
  entries: [],
  autoAdvance: false,
  turnSeconds: 0,
};

/**
 * Cena nova nasce SEM neblina.
 *
 * Com o modo por visao ligado desde o inicio, um jogador que entra antes de
 * ter um token com raio de visao encara uma tela preta e conclui que algo
 * quebrou. A neblina e um recurso que o mestre liga quando a cena pede,
 * nao um estado inicial.
 */
export const DEFAULT_FOG: FogConfig = {
  mode: 'off',
  explored: [],
  revealed: [],
  hidden: [],
  rememberExplored: true,
  dimOpacity: 0.55,
  edgeSoftness: 0.6,
};

export function createScene(partial: Partial<Scene> = {}): Scene {
  return {
    id: partial.id ?? generateId('scn'),
    name: partial.name ?? 'Nova cena',
    order: partial.order ?? 0,
    backgroundAssetId: partial.backgroundAssetId ?? null,
    backgroundColor: partial.backgroundColor ?? '#1a1d24',
    width: partial.width ?? 2100,
    height: partial.height ?? 1400,
    grid: { ...DEFAULT_GRID, ...(partial.grid ?? {}) },
    fog: { ...DEFAULT_FOG, ...(partial.fog ?? {}) },
    walls: partial.walls ?? [],
    tiles: partial.tiles ?? [],
    tokens: partial.tokens ?? [],
    effects: partial.effects ?? [],
    globalLight: partial.globalLight ?? 1,
  };
}

export function createToken(partial: Partial<Token> = {}): Token {
  return {
    id: partial.id ?? generateId('tok'),
    name: partial.name ?? 'Token',
    assetId: partial.assetId ?? null,
    color: partial.color ?? '#7a8bd4',
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    scale: partial.scale ?? 1,
    rotation: partial.rotation ?? 0,
    layer: partial.layer ?? 3,
    visibility: partial.visibility ?? 'visible',
    opacity: partial.opacity ?? 1,
    gmOnly: partial.gmOnly ?? false,
    ownerPlayerId: partial.ownerPlayerId ?? null,
    sheetId: partial.sheetId ?? null,
    visionRadius: partial.visionRadius ?? 0,
    lightRadius: partial.lightRadius ?? 0,
    bars: partial.bars ?? [],
    label: partial.label ?? '',
    locked: partial.locked ?? false,
    conditions: partial.conditions ?? [],
  };
}

export function createTile(partial: Partial<Tile> = {}): Tile {
  return {
    id: partial.id ?? generateId('til'),
    assetId: partial.assetId ?? null,
    color: partial.color ?? null,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? 140,
    height: partial.height ?? 140,
    rotation: partial.rotation ?? 0,
    opacity: partial.opacity ?? 1,
    layer: partial.layer ?? 2,
    blocksVision: partial.blocksVision ?? false,
    gmOnly: partial.gmOnly ?? false,
    locked: partial.locked ?? false,
  };
}

export function createEffect(partial: Partial<MapEffect> = {}): MapEffect {
  return {
    id: partial.id ?? generateId('efx'),
    kind: partial.kind ?? 'circle',
    label: partial.label ?? '',
    color: partial.color ?? '#e0a33e',
    opacity: partial.opacity ?? 0.45,
    assetId: partial.assetId ?? null,
    anchor: partial.anchor ?? 'free',
    cell: partial.cell ?? null,
    tokenId: partial.tokenId ?? null,
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    radius: partial.radius ?? 2,
    width: partial.width ?? 2,
    height: partial.height ?? 2,
    angle: partial.angle ?? 0,
    spread: partial.spread ?? 60,
    layer: partial.layer ?? 4,
    visibility: partial.visibility ?? 'visible',
    gmOnly: partial.gmOnly ?? false,
    fontSize: partial.fontSize ?? 28,
  };
}

export function createWall(partial: Partial<Wall> = {}): Wall {
  return {
    id: partial.id ?? generateId('wal'),
    x1: partial.x1 ?? 0,
    y1: partial.y1 ?? 0,
    x2: partial.x2 ?? 0,
    y2: partial.y2 ?? 0,
    door: partial.door ?? false,
    open: partial.open ?? false,
    hidden: partial.hidden ?? false,
  };
}

export const CONDITION_PRESETS = [
  { id: 'stunned', label: 'Atordoado', icon: '💫' },
  { id: 'poisoned', label: 'Envenenado', icon: '🧪' },
  { id: 'prone', label: 'Caido', icon: '⬇️' },
  { id: 'blinded', label: 'Cego', icon: '🚫' },
  { id: 'burning', label: 'Em chamas', icon: '🔥' },
  { id: 'blessed', label: 'Abencoado', icon: '✨' },
  { id: 'hasted', label: 'Acelerado', icon: '⚡' },
  { id: 'dead', label: 'Morto', icon: '💀' },
];
