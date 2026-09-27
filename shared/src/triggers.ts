import { tokenCenter } from './grid.js';
import { sanitizeScreenEffect } from './screen.js';
import type {
  Point,
  Scene,
  ScreenEffect,
  ScreenMessageStyle,
  Token,
  Trigger,
  TriggerAction,
  TriggerArea,
} from './types.js';

/**
 * Gatilhos: geometria e regras de disparo.
 *
 * Roda no servidor, que e quem decide o disparo, e no cliente, que so desenha
 * as areas para o mestre. O teste de disparo usa o SEGMENTO percorrido pelo
 * centro do token, e nao so a posicao final: um arraste rapido atravessaria
 * uma area pequena sem nunca "estar" dentro dela num evento.
 */

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

/** Tolerancia de ponto flutuante: um ponto exatamente na borda conta como dentro. */
const EPS = 1e-6;

function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > EPS * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) return false;
  return (
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

function orient(a: Point, b: Point, c: Point): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(v) <= EPS ? 0 : Math.sign(v);
}

/** Os segmentos fechados AB e CD se tocam (inclusive nas pontas e colineares)? */
export function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(c, a, b)) ||
    (o2 === 0 && onSegment(d, a, b)) ||
    (o3 === 0 && onSegment(a, c, d)) ||
    (o4 === 0 && onSegment(b, c, d))
  );
}

/** Distancia de um ponto ao segmento AB. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Vertices da area, para retangulo e poligono. */
export function areaVertices(area: TriggerArea): Point[] {
  if (area.kind === 'rect') {
    return [
      { x: area.x, y: area.y },
      { x: area.x + area.width, y: area.y },
      { x: area.x + area.width, y: area.y + area.height },
      { x: area.x, y: area.y + area.height },
    ];
  }
  if (area.kind === 'polygon') return area.points;
  return [];
}

/** O ponto esta dentro da area? A borda conta como dentro. */
export function pointInArea(area: TriggerArea, p: Point): boolean {
  if (area.kind === 'circle') {
    return Math.hypot(p.x - area.x, p.y - area.y) <= area.radius + EPS;
  }
  if (area.kind === 'rect') {
    return (
      p.x >= area.x - EPS &&
      p.x <= area.x + area.width + EPS &&
      p.y >= area.y - EPS &&
      p.y <= area.y + area.height + EPS
    );
  }

  const pts = area.points;
  if (pts.length < 3) return false;
  for (let i = 0; i < pts.length; i++) {
    if (onSegment(p, pts[i], pts[(i + 1) % pts.length])) return true;
  }
  // Par-impar por raio horizontal.
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** O segmento de A a B toca a area em algum ponto? */
export function segmentTouchesArea(area: TriggerArea, a: Point, b: Point): boolean {
  if (pointInArea(area, a) || pointInArea(area, b)) return true;
  if (area.kind === 'circle') {
    return distanceToSegment({ x: area.x, y: area.y }, a, b) <= area.radius + EPS;
  }
  const pts = areaVertices(area);
  for (let i = 0; i < pts.length; i++) {
    if (segmentsTouch(a, b, pts[i], pts[(i + 1) % pts.length])) return true;
  }
  return false;
}

/**
 * O movimento de A a B ENTRA na area?
 *
 * Entrar e comecar fora e tocar a area em algum ponto do caminho. Quem ja esta
 * dentro e se mexe la dentro nao dispara de novo — senao cada passo de um
 * arraste dentro da sala seria um disparo.
 */
export function segmentEntersArea(area: TriggerArea, a: Point, b: Point): boolean {
  if (pointInArea(area, a)) return false;
  return segmentTouchesArea(area, a, b);
}

/** Caixa que envolve a area, para desenho e clique. */
export function areaBounds(area: TriggerArea): { x: number; y: number; width: number; height: number } {
  if (area.kind === 'circle') {
    return { x: area.x - area.radius, y: area.y - area.radius, width: area.radius * 2, height: area.radius * 2 };
  }
  if (area.kind === 'rect') return { x: area.x, y: area.y, width: area.width, height: area.height };
  const xs = area.points.map((p) => p.x);
  const ys = area.points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}


// ---------------------------------------------------------------------------
// Quem dispara
// ---------------------------------------------------------------------------

/**
 * Este token, movido por este papel, pode disparar o gatilho?
 *
 * Movimento do mestre nao dispara por padrao: ele posiciona NPCs enquanto
 * monta a cena, e a armadilha nao deveria cair no proprio arquiteto.
 */
export function triggerAccepts(trigger: Trigger, token: Token, movedByGm: boolean): boolean {
  if (!trigger.enabled) return false;
  if (trigger.mode === 'once' && !trigger.armed) return false;
  if (movedByGm && !trigger.gmMoves) return false;

  switch (trigger.who) {
    case 'players':
      return token.ownerPlayerId !== null;
    case 'tokens':
      return trigger.tokenIds.includes(token.id);
    case 'any':
      return true;
  }
}

/** Gatilhos da cena que este movimento faz disparar, na ordem da lista. */
export function triggersEntered(
  scene: Scene,
  token: Token,
  from: Point,
  to: Point,
  movedByGm: boolean,
): Trigger[] {
  // O centro do token e o mesmo ponto que as paredes e a visao usam.
  const a = tokenCenter(scene.grid, from, token.scale);
  const b = tokenCenter(scene.grid, to, token.scale);
  if (a.x === b.x && a.y === b.y) return [];
  return (scene.triggers ?? []).filter(
    (t) => triggerAccepts(t, token, movedByGm) && segmentEntersArea(t.area, a, b),
  );
}

// ---------------------------------------------------------------------------
// Normalizacao
// ---------------------------------------------------------------------------

export const MAX_TRIGGER_ACTIONS = 10;
const MAX_POLYGON_POINTS = 64;
const COORD = 30000;

function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v: unknown, max: number, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function id(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : fallback;
}

/** Area vinda do cliente, ou `null` se nao da para usar. */
export function sanitizeArea(raw: unknown): TriggerArea | null {
  const a = raw as Partial<TriggerArea> | null;
  if (!a || typeof a !== 'object') return null;

  if (a.kind === 'rect') {
    const r = a as Extract<TriggerArea, { kind: 'rect' }>;
    const width = num(r.width, 0, COORD, 0);
    const height = num(r.height, 0, COORD, 0);
    if (width < 1 || height < 1) return null;
    return { kind: 'rect', x: num(r.x, -COORD, COORD, 0), y: num(r.y, -COORD, COORD, 0), width, height };
  }
  if (a.kind === 'circle') {
    const c = a as Extract<TriggerArea, { kind: 'circle' }>;
    const radius = num(c.radius, 0, COORD, 0);
    if (radius < 1) return null;
    return { kind: 'circle', x: num(c.x, -COORD, COORD, 0), y: num(c.y, -COORD, COORD, 0), radius };
  }
  if (a.kind === 'polygon') {
    const p = a as Extract<TriggerArea, { kind: 'polygon' }>;
    if (!Array.isArray(p.points)) return null;
    const points = p.points
      .slice(0, MAX_POLYGON_POINTS)
      .filter((pt) => pt && typeof pt === 'object')
      .map((pt) => ({ x: num(pt.x, -COORD, COORD, 0), y: num(pt.y, -COORD, COORD, 0) }));
    if (points.length < 3) return null;
    return { kind: 'polygon', points };
  }
  return null;
}

const STYLES: ScreenMessageStyle[] = ['neutral', 'whisper', 'threat'];

/** Uma acao vinda do cliente, ou `null` se o tipo e desconhecido. */
export function sanitizeAction(raw: unknown, fallbackId: string): TriggerAction | null {
  const a = raw as Partial<TriggerAction> & Record<string, unknown>;
  if (!a || typeof a !== 'object') return null;
  const actionId = id(a.id, fallbackId);
  const target = a.target === 'all' ? 'all' : 'trigger';

  switch (a.type) {
    case 'notify':
      return { id: actionId, type: 'notify' };
    case 'message':
      return {
        id: actionId,
        type: 'message',
        target,
        text: str(a.text, 400),
        style: STYLES.includes(a.style as ScreenMessageStyle) ? (a.style as ScreenMessageStyle) : 'neutral',
        durationMs: a.durationMs === null ? null : num(a.durationMs, 1000, 120000, 6000),
      };
    case 'screen': {
      const effect = sanitizeScreenEffect(a.effect as Partial<ScreenEffect>, 'preview');
      if (!effect) return null;
      const { id: _omit, ...rest } = effect;
      void _omit;
      return { id: actionId, type: 'screen', target, effect: rest };
    }
    case 'card':
      return {
        id: actionId,
        type: 'card',
        target,
        cardId: str(a.cardId, 40),
        durationMs: a.durationMs === null ? null : num(a.durationMs, 2000, 120000, 6000),
      };
    case 'handout':
      return {
        id: actionId,
        type: 'handout',
        handoutId: str(a.handoutId, 40),
        share: a.share === 'all' || a.share === 'trigger' ? a.share : 'none',
        present: Boolean(a.present),
      };
    case 'reveal':
      return { id: actionId, type: 'reveal', tokenId: str(a.tokenId, 40) };
    default:
      return null;
  }
}

/**
 * Gatilho completo a partir do que o cliente mandou. `base` e o gatilho atual
 * numa edicao, ou um gatilho novo; so os campos presentes em `raw` mudam.
 */
export function sanitizeTrigger(raw: Partial<Trigger> | undefined, base: Trigger): Trigger | null {
  const r = raw ?? {};
  const area = r.area !== undefined ? sanitizeArea(r.area) : base.area;
  if (!area) return null;

  let actions = base.actions;
  if (Array.isArray(r.actions)) {
    actions = r.actions
      .slice(0, MAX_TRIGGER_ACTIONS)
      .map((a, i) => sanitizeAction(a, `act${i}_${Date.now().toString(36)}`))
      .filter((a): a is TriggerAction => a !== null);
  }

  return {
    id: base.id,
    name: r.name !== undefined ? str(r.name, 80).trim() || 'Gatilho' : base.name,
    area,
    enabled: r.enabled !== undefined ? Boolean(r.enabled) : base.enabled,
    mode: r.mode === 'always' || r.mode === 'once' ? r.mode : base.mode,
    armed: r.armed !== undefined ? Boolean(r.armed) : base.armed,
    who: r.who === 'any' || r.who === 'tokens' || r.who === 'players' ? r.who : base.who,
    tokenIds: Array.isArray(r.tokenIds)
      ? r.tokenIds.filter((t): t is string => typeof t === 'string').slice(0, 50)
      : base.tokenIds,
    gmMoves: r.gmMoves !== undefined ? Boolean(r.gmMoves) : base.gmMoves,
    actions,
  };
}
