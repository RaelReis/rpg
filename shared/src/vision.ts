import {
  cellAt,
  cellCenter,
  cellKey,
  cellsWithinRadius,
  cellHeight,
  tokenCell,
} from './grid.js';
import type { Cell, Point, Scene, Token, Role, Wall } from './types.js';

/**
 * Fog of war e linha de visao.
 *
 * Este modulo roda nos dois lados: o cliente usa o resultado para desenhar a
 * neblina, e o servidor usa exatamente o mesmo calculo para decidir quais
 * tokens sequer sao enviados ao jogador (`settings.strictVision`). Manter
 * uma unica implementacao evita a classe de bug em que o cliente esconde
 * visualmente algo que o servidor ja entregou no payload.
 */

/** Teto de raio quando ha luz global, para nao varrer o mapa inteiro. */
const MAX_DAYLIGHT_CELLS = 40;

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface VisionResult {
  /** Celulas iluminadas agora: terreno e tokens visiveis. */
  visible: Set<string>;
  /** Celulas ja exploradas: terreno em penumbra, tokens ocultos. */
  explored: Set<string>;
  /**
   * Sem restricao de NEBLINA: o terreno inteiro pode ser desenhado.
   * Nao significa "ve tudo" — uma mesa com a neblina desligada ainda tem
   * tokens que o mestre marcou como ocultos ou exclusivos dele.
   */
  unrestricted: boolean;
  /** O observador e o mestre: enxerga inclusive o que e exclusivo dele. */
  gm: boolean;
}

// ---------------------------------------------------------------------------
// Obstaculos
// ---------------------------------------------------------------------------

/** Paredes e tiles bloqueantes reduzidos a segmentos testaveis. */
export function collectBlockers(scene: Scene): Segment[] {
  const out: Segment[] = [];

  for (const w of scene.walls) {
    if (w.door && w.open) continue;
    out.push({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 });
  }

  for (const tile of scene.tiles) {
    if (!tile.blocksVision) continue;
    const corners = rectCorners(tile);
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }

  return out;
}

function rectCorners(t: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}): Point[] {
  const cx = t.x + t.width / 2;
  const cy = t.y + t.height / 2;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = t.width / 2;
  const hh = t.height / 2;

  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((p) => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }));
}

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
}

/** Interseccao propria de segmentos; toques exatos nas pontas nao bloqueiam. */
export function segmentsIntersect(a: Segment, b: Segment): boolean {
  const o1 = orientation(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const o2 = orientation(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const o3 = orientation(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const o4 = orientation(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Descarta rapidamente paredes cujo bounding box nao toca o raio. */
function boxesOverlap(a: Segment, b: Segment): boolean {
  return !(
    Math.max(a.x1, a.x2) < Math.min(b.x1, b.x2) ||
    Math.min(a.x1, a.x2) > Math.max(b.x1, b.x2) ||
    Math.max(a.y1, a.y2) < Math.min(b.y1, b.y2) ||
    Math.min(a.y1, a.y2) > Math.max(b.y1, b.y2)
  );
}

export function hasLineOfSight(from: Point, to: Point, blockers: Segment[]): boolean {
  const ray: Segment = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  for (const b of blockers) {
    if (!boxesOverlap(ray, b)) continue;
    if (segmentsIntersect(ray, b)) return false;
  }
  return true;
}

/**
 * Uma celula conta como visivel se o centro OU um dos cantos recuados for
 * alcancado. Sem os cantos, quinas de parede criam buracos de visao
 * artificiais em corredores diagonais.
 */
function cellIsLit(
  origin: Point,
  cell: Cell,
  scene: Scene,
  blockers: Segment[],
): boolean {
  const center = cellCenter(scene.grid, cell);
  if (hasLineOfSight(origin, center, blockers)) return true;

  const inset = scene.grid.size * 0.3;
  const ih = cellHeight(scene.grid) * 0.3;
  const probes: Point[] = [
    { x: center.x - inset, y: center.y - ih },
    { x: center.x + inset, y: center.y - ih },
    { x: center.x + inset, y: center.y + ih },
    { x: center.x - inset, y: center.y + ih },
  ];
  for (const p of probes) {
    if (hasLineOfSight(origin, p, blockers)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Campo de visao
// ---------------------------------------------------------------------------

/** Raio efetivo de um token, somando sua visao propria a luz do ambiente. */
function effectiveRadius(scene: Scene, radius: number): number {
  const daylight = Math.round(scene.globalLight * MAX_DAYLIGHT_CELLS);
  return Math.min(Math.max(radius, daylight), MAX_DAYLIGHT_CELLS);
}

/** Celulas iluminadas por um unico token, respeitando paredes. */
export function tokenVisionCells(
  scene: Scene,
  token: Token,
  radius: number,
  blockers: Segment[],
): Set<string> {
  const out = new Set<string>();
  const r = effectiveRadius(scene, radius);
  if (r <= 0) return out;

  const from = tokenCell(scene.grid, { x: token.x, y: token.y }, token.scale);
  const origin = cellCenter(scene.grid, from);

  // `cellsWithinRadius` enumera os candidatos pela metrica da grade (Chebyshev
  // na quadrada), que descreve MOVIMENTO — andar na diagonal custa um passo.
  // Visao e luz, porem, sao fenomenos fisicos: um facho de 6 celulas alcanca
  // 6 celulas em toda direcao, nao 8 na diagonal. Filtrar pela distancia
  // euclidiana troca a area quadrada por uma circular, que e o que a pessoa
  // espera ver quando o personagem acende uma tocha.
  const limit = r * scene.grid.size;
  for (const cell of cellsWithinRadius(scene.grid, from, r)) {
    const center = cellCenter(scene.grid, cell);
    if (Math.hypot(center.x - origin.x, center.y - origin.y) > limit) continue;
    if (cellIsLit(origin, cell, scene, blockers)) out.add(cellKey(cell));
  }
  return out;
}

/**
 * Quais tokens servem de "olhos" para este jogador: os proprios tokens com
 * visao, mais qualquer fonte de luz do mapa (uma tocha acesa numa sala
 * revela a sala para todo mundo que a alcance).
 */
export function visionSources(scene: Scene, playerId: string | null): Token[] {
  return scene.tokens.filter((t) => {
    if (t.layer !== 3) return false;
    if (t.lightRadius > 0 && !t.gmOnly) return true;
    return t.ownerPlayerId !== null && t.ownerPlayerId === playerId && t.visionRadius > 0;
  });
}

export interface VisionOptions {
  role: Role;
  playerId: string | null;
}

/**
 * Resultado de visibilidade da cena para um observador.
 * O mestre sempre recebe `unrestricted`; o painel dele desenha por cima uma
 * previa do que os jogadores enxergam.
 */
export function computeVision(scene: Scene, opts: VisionOptions): VisionResult {
  const empty = { visible: new Set<string>(), explored: new Set<string>() };

  if (opts.role === 'GM') return { ...empty, unrestricted: true, gm: true };
  if (scene.fog.mode === 'off') return { ...empty, unrestricted: true, gm: false };

  const hidden = new Set(scene.fog.hidden);
  const revealed = scene.fog.revealed.filter((k) => !hidden.has(k));

  if (scene.fog.mode === 'manual') {
    const visible = new Set(revealed);
    const explored = scene.fog.rememberExplored
      ? new Set([...scene.fog.explored.filter((k) => !hidden.has(k)), ...revealed])
      : new Set(visible);
    return { visible, explored, unrestricted: false, gm: false };
  }

  // mode === 'vision'
  const blockers = collectBlockers(scene);
  const visible = new Set(revealed);

  for (const token of visionSources(scene, opts.playerId)) {
    const radius = Math.max(
      token.ownerPlayerId === opts.playerId ? token.visionRadius : 0,
      token.lightRadius,
    );
    for (const key of tokenVisionCells(scene, token, radius, blockers)) {
      if (!hidden.has(key)) visible.add(key);
    }
  }

  const explored = scene.fog.rememberExplored
    ? new Set([...scene.fog.explored.filter((k) => !hidden.has(k)), ...visible])
    : new Set(visible);

  return { visible, explored, unrestricted: false, gm: false };
}

// ---------------------------------------------------------------------------
// Consultas usadas por renderizador e servidor
// ---------------------------------------------------------------------------

export function isCellVisible(vision: VisionResult, cell: Cell): boolean {
  return vision.unrestricted || vision.visible.has(cellKey(cell));
}

export function isCellExplored(vision: VisionResult, cell: Cell): boolean {
  return vision.unrestricted || vision.explored.has(cellKey(cell));
}

export function isPointVisible(scene: Scene, vision: VisionResult, p: Point): boolean {
  if (vision.unrestricted) return true;
  return vision.visible.has(cellKey(cellAt(scene.grid, p)));
}

/**
 * Um token so aparece para o jogador se nao for exclusivo do mestre, nao
 * estiver marcado como oculto, e (com fog de visao) ocupar uma celula
 * iluminada. Tokens do proprio jogador sao sempre visiveis para ele, para
 * que ninguem perca o proprio personagem dentro da neblina.
 */
export function canPlayerSeeToken(
  scene: Scene,
  token: Token,
  vision: VisionResult,
  playerId: string | null,
): boolean {
  // O mestre ve tudo. Para qualquer outro, a marcacao de oculto vem ANTES de
  // qualquer consideracao sobre neblina: desligar a neblina afrouxa o que se
  // enxerga do cenario, e nunca deve revelar o que o mestre escondeu.
  if (vision.gm) return true;
  if (token.gmOnly || token.visibility === 'hidden') return false;
  if (token.ownerPlayerId !== null && token.ownerPlayerId === playerId) return true;
  if (vision.unrestricted || scene.fog.mode === 'off') return true;

  // Um token grande e visto se qualquer celula que ele ocupa estiver iluminada.
  const origin = tokenCell(scene.grid, { x: token.x, y: token.y }, token.scale);
  const span = Math.max(0, Math.ceil(token.scale) - 1);
  for (const cell of cellsWithinRadius(scene.grid, origin, span)) {
    if (vision.visible.has(cellKey(cell))) return true;
  }
  return false;
}

/**
 * Celulas que os tokens de jogador acabaram de descobrir, para acumular em
 * `fog.explored`. O servidor chama isto a cada movimento e so persiste o
 * delta, evitando reescrever o conjunto inteiro a cada passo.
 */
export function newlyExploredCells(scene: Scene): string[] {
  if (scene.fog.mode !== 'vision' || !scene.fog.rememberExplored) return [];

  const known = new Set(scene.fog.explored);
  const blockers = collectBlockers(scene);
  const fresh: string[] = [];

  for (const token of scene.tokens) {
    if (token.layer !== 3) continue;
    const isPlayerEye = token.ownerPlayerId !== null && token.visionRadius > 0;
    const isLight = token.lightRadius > 0 && !token.gmOnly;
    if (!isPlayerEye && !isLight) continue;

    const radius = Math.max(isPlayerEye ? token.visionRadius : 0, token.lightRadius);
    for (const key of tokenVisionCells(scene, token, radius, blockers)) {
      if (!known.has(key)) {
        known.add(key);
        fresh.push(key);
      }
    }
  }

  return fresh;
}

/** Paredes que o jogador pode ver desenhadas (portas secretas ficam de fora). */
export function visibleWalls(walls: Wall[], role: Role): Wall[] {
  if (role === 'GM') return walls;
  return walls.filter((w) => !w.hidden && w.door);
}
