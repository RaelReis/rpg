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
  WeatherConfig,
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
  wallsBlockMovement: true,
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
export const DEFAULT_WEATHER: WeatherConfig = { kind: 'none', intensity: 0.5, angle: 12 };

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
    weather: { ...DEFAULT_WEATHER, ...(partial.weather ?? {}) },
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
    shape: partial.shape ?? 'circle',
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
    style: partial.style ?? 'flat',
    colorAlt: partial.colorAlt ?? '#ffffff',
    speed: partial.speed ?? 1,
  };
}

/**
 * Presets dos Elementos do Outro Lado (Ordem Paranormal).
 *
 * As cores seguem a simbologia do sistema: Sangue e vermelho; Morte anda em
 * preto, branco e cinza; Conhecimento e dourado; Energia e neon; e Medo nao
 * tem cor propria — aparece translucido, misturado ao que estiver em volta.
 * Cada preset e so um ponto de partida: cor, estilo e ritmo continuam
 * editaveis, porque a mesa e de quem joga.
 */
export interface EffectPreset {
  id: string;
  label: string;
  hint: string;
  patch: Partial<MapEffect>;
}

export const PARANORMAL_PRESETS: EffectPreset[] = [
  {
    id: 'blood',
    label: 'Sangue',
    hint: 'Violencia e dor: brasas quentes subindo da area.',
    patch: { style: 'embers', color: '#a4161a', colorAlt: '#ff4d4d', opacity: 0.5, speed: 1 },
  },
  {
    id: 'death',
    label: 'Morte',
    hint: 'Lodo e decadencia: nevoa cinza que se arrasta.',
    patch: { style: 'mist', color: '#79808a', colorAlt: '#eef1f4', opacity: 0.6, speed: 0.6 },
  },
  {
    id: 'knowledge',
    label: 'Conhecimento',
    hint: 'Sigilos e simbolos: anel de runas girando.',
    patch: { style: 'runes', color: '#d9a441', colorAlt: '#fff1c9', opacity: 0.6, speed: 0.8 },
  },
  {
    id: 'energy',
    label: 'Energia',
    hint: 'Caos mutavel: vortice neon em movimento.',
    patch: { style: 'vortex', color: '#7b2ff7', colorAlt: '#22e0ff', opacity: 0.55, speed: 1.4 },
  },
  {
    id: 'fear',
    label: 'Medo',
    hint: 'Sem cor propria: chiado translucido que distorce o que cobre.',
    patch: { style: 'static', color: '#101018', colorAlt: '#8f8fa8', opacity: 0.45, speed: 1.2 },
  },
];

export function createWall(partial: Partial<Wall> = {}): Wall {
  return {
    id: partial.id ?? generateId('wal'),
    x1: partial.x1 ?? 0,
    y1: partial.y1 ?? 0,
    x2: partial.x2 ?? 0,
    y2: partial.y2 ?? 0,
    door: partial.door ?? false,
    open: partial.open ?? false,
    window: partial.door ? false : (partial.window ?? false),
    hidden: partial.hidden ?? false,
  };
}

/**
 * Visao com que um personagem nasce, em celulas.
 *
 * Com zero o jogador entra numa cena escura sem enxergar nem o proprio
 * entorno, e o mestre precisava lembrar de ajustar cada token novo.
 */
export const CHARACTER_VISION_RADIUS = 1;

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
