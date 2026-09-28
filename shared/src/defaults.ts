import { DEFAULT_GRID } from './grid.js';
import type {
  FogConfig,
  LegacyVisibility,
  Trigger,
  TriggerArea,
  MapEffect,
  Scene,
  TableSettings,
  Tile,
  Token,
  TurnEntry,
  TurnState,
  Wall,
  WeatherConfig,
} from './types.js';

/** Fabricas de entidades. Cliente e servidor criam objetos completos pelos
 *  mesmos defaults, evitando campos `undefined` viajando pelo socket. */

export const MAX_GM_PASSWORD_LENGTH = 200;

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
  playersPassTurn: true,
};

export const DEFAULT_TURNS: TurnState = {
  round: 1,
  activeEntryId: null,
  entries: [],
  history: [],
};

/**
 * Normaliza a ordem de turnos vinda do banco ou de um backup.
 *
 * Mesas gravadas antes desta versao guardam o rastreador de iniciativa antigo,
 * com valor rolado e desempate. Os campos que sobraram ainda descrevem quem
 * participava, entao a ordem e reaproveitada — na sequencia em que estava
 * gravada, que era a ordem de iniciativa.
 */
export function normalizeTurns(raw: unknown): TurnState {
  const source = (raw ?? {}) as Partial<TurnState>;
  const rawEntries = Array.isArray(source.entries) ? source.entries : [];

  const entries: TurnEntry[] = rawEntries.slice(0, 60).map((entry) => {
    const e = (entry ?? {}) as Partial<TurnEntry>;
    return {
      id: typeof e.id === 'string' && e.id ? e.id : generateId('trn'),
      tokenId: typeof e.tokenId === 'string' ? e.tokenId : null,
      sheetId: typeof e.sheetId === 'string' ? e.sheetId : null,
      playerId: typeof e.playerId === 'string' ? e.playerId : null,
      name: typeof e.name === 'string' && e.name ? e.name.slice(0, 60) : 'Participante',
      skipped: Boolean(e.skipped),
      hiddenFromPlayers: Boolean(e.hiddenFromPlayers),
    };
  });

  const rawHistory = Array.isArray(source.history) ? source.history : [];
  const ids = new Set(entries.map((e) => e.id));
  const history = rawHistory
    .map((r) => (r ?? {}) as TurnRecordLike)
    .filter((r) => typeof r.entryId === 'string' && ids.has(r.entryId))
    .slice(-120)
    .map((r) => ({
      round: Number.isFinite(r.round) ? Number(r.round) : 1,
      entryId: String(r.entryId),
      name: typeof r.name === 'string' ? r.name.slice(0, 60) : 'Participante',
      at: Number.isFinite(r.at) ? Number(r.at) : Date.now(),
    }));

  const activeEntryId =
    typeof source.activeEntryId === 'string' && ids.has(source.activeEntryId)
      ? source.activeEntryId
      : (entries.find((e) => !e.skipped)?.id ?? null);

  return {
    round: Math.max(1, Math.min(9999, Math.trunc(Number(source.round) || 1))),
    activeEntryId,
    entries,
    history,
  };
}

interface TurnRecordLike {
  round?: unknown;
  entryId?: unknown;
  name?: unknown;
  at?: unknown;
}

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
    // Passar pelas fabricas completa campos criados depois que a cena foi
    // gravada (ou exportada): um token antigo chegaria sem `visibleTo`. As
    // condicoes antigas (emojis) viram ids no caminho.
    tokens: (partial.tokens ?? []).map((t) => createToken({ ...t, conditions: normalizeConditions(t.conditions) })),
    effects: (partial.effects ?? []).map((e) => createEffect(e)),
    globalLight: partial.globalLight ?? 1,
    weather: { ...DEFAULT_WEATHER, ...(partial.weather ?? {}) },
    introCardId: partial.introCardId ?? null,
    triggers: partial.triggers ?? [],
  };
}

export const EMPTY_BOARD = { locked: false, items: [], threads: [] } as const;

export function createTrigger(area: TriggerArea, partial: Partial<Trigger> = {}): Trigger {
  return {
    id: partial.id ?? generateId('trg'),
    name: partial.name ?? 'Gatilho',
    area,
    enabled: partial.enabled ?? true,
    mode: partial.mode ?? 'once',
    armed: partial.armed ?? true,
    who: partial.who ?? 'players',
    tokenIds: partial.tokenIds ?? [],
    gmMoves: partial.gmMoves ?? false,
    actions: partial.actions ?? [{ id: 'notify', type: 'notify' }],
  };
}

export function createToken(partial: Partial<Token> & LegacyVisibility = {}): Token {
  // O "exclusivo do mestre" antigo escondia o token e apagava a luz dele para
  // os jogadores; oculto com a luz zerada da o mesmo resultado na mesa.
  const legacyGmOnly = partial.gmOnly === true;
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
    // Arte inteira e o padrao: e assim que a peca aparece na mesa de verdade,
    // e a ficha do personagem ja chega com uma imagem de corpo.
    shape: partial.shape ?? 'art',
    visibility: legacyGmOnly ? 'hidden' : (partial.visibility ?? 'visible'),
    opacity: partial.opacity ?? 1,
    ownerPlayerId: partial.ownerPlayerId ?? null,
    sheetId: partial.sheetId ?? null,
    visionRadius: partial.visionRadius ?? 0,
    lightRadius: legacyGmOnly ? 0 : (partial.lightRadius ?? 0),
    bars: partial.bars ?? [],
    label: partial.label ?? '',
    locked: partial.locked ?? false,
    conditions: partial.conditions ?? [],
    visibleTo: partial.visibleTo ?? null,
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

export function createEffect(partial: Partial<MapEffect> & LegacyVisibility = {}): MapEffect {
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
    visibility: partial.gmOnly === true ? 'hidden' : (partial.visibility ?? 'visible'),
    fontSize: partial.fontSize ?? 28,
    style: partial.style ?? 'flat',
    colorAlt: partial.colorAlt ?? '#ffffff',
    speed: partial.speed ?? 1,
    visibleTo: partial.visibleTo ?? null,
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

/**
 * Condicoes que o mestre marca sobre um token.
 *
 * O token guarda o `id`. O desenho do icone e da interface: o pacote
 * compartilhado nao sabe de biblioteca de icones, e trocar o desenho de uma
 * condicao nao pode exigir migrar os tokens gravados.
 */
export const CONDITION_PRESETS = [
  { id: 'stunned', label: 'Atordoado' },
  { id: 'poisoned', label: 'Envenenado' },
  { id: 'prone', label: 'Caido' },
  { id: 'blinded', label: 'Cego' },
  { id: 'burning', label: 'Em chamas' },
  { id: 'blessed', label: 'Abencoado' },
  { id: 'hasted', label: 'Acelerado' },
  { id: 'dead', label: 'Morto' },
] as const;

export type ConditionId = (typeof CONDITION_PRESETS)[number]['id'];

const CONDITION_IDS = new Set<string>(CONDITION_PRESETS.map((c) => c.id));

/** Emojis que os tokens guardavam antes de a condicao ser gravada por id. */
const LEGACY_CONDITION_GLYPHS: Record<string, ConditionId> = {
  '💫': 'stunned',
  '🧪': 'poisoned',
  '⬇️': 'prone',
  '⬇': 'prone',
  '🚫': 'blinded',
  '🔥': 'burning',
  '✨': 'blessed',
  '⚡': 'hasted',
  '💀': 'dead',
};

/**
 * Condicoes validas, sem repeticao, com os emojis antigos convertidos em id.
 *
 * Aplicado ao criar a cena (e portanto ao carregar do banco e ao importar
 * backup) e em toda escrita vinda do cliente: nenhum token fica com um
 * valor que a interface nao sabe desenhar.
 */
export function normalizeConditions(raw: unknown): ConditionId[] {
  if (!Array.isArray(raw)) return [];
  const out: ConditionId[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = CONDITION_IDS.has(value) ? (value as ConditionId) : LEGACY_CONDITION_GLYPHS[value];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
