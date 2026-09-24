import type { ScreenEffectKind, ScreenEffectParams } from './screen.js';
import type { ScreenMessageStyle } from './events.js';
import type { Point, Token } from './types.js';
import { segmentsIntersect } from './vision.js';

/**
 * Gatilhos no mapa: areas invisiveis que disparam acoes quando um token entra.
 *
 * Moram no servidor. O jogador nunca recebe um gatilho — nem a area, que
 * denunciaria onde o mapa guarda uma surpresa. Quem decide o disparo e o
 * servidor, no mesmo ponto em que ja valida as paredes, com a geometria
 * daqui.
 */

export type TriggerArea =
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'circle'; x: number; y: number; radius: number }
  | { kind: 'polygon'; points: Point[] };

/** Quem dispara: tokens de jogadores (o padrao), qualquer token, ou tokens escolhidos. */
export type TriggerWho = 'players' | 'any' | 'tokens';

/** Para quem vai uma acao que aparece na tela: quem disparou ou todos os jogadores. */
export type TriggerAudience = 'triggerer' | 'all';

export type TriggerAction =
  | { type: 'notify-gm' }
  | { type: 'message'; to: TriggerAudience; text: string; style: ScreenMessageStyle; durationMs: number | null }
  | { type: 'screen-effect'; to: TriggerAudience; kind: ScreenEffectKind; params: Partial<ScreenEffectParams> }
  | { type: 'card'; to: TriggerAudience; cardId: string | null; durationMs: number | null }
  | { type: 'handout'; to: TriggerAudience; handoutId: string | null; share: boolean; present: boolean }
  | { type: 'reveal-token'; tokenId: string | null };

export type TriggerActionType = TriggerAction['type'];

export interface Trigger {
  id: string;
  name: string;
  area: TriggerArea;
  /** Desligado, o gatilho existe mas nao dispara. */
  enabled: boolean;
  /** `once` desarma depois do primeiro disparo, ate o mestre rearmar. */
  mode: 'once' | 'always';
  /** So faz sentido em `once`: false depois de disparar. */
  armed: boolean;
  who: TriggerWho;
  /** `who = 'tokens'`: quais. */
  tokenIds: string[];
  /**
   * Movimentos do mestre tambem disparam. Desligado por padrao: o mestre
   * posiciona NPCs enquanto monta a cena, e nao quer abrir a porta do porao
   * so por arrastar o guarda para dentro dela.
   */
  includeGmMoves: boolean;
  /** Executadas em ordem, a cada disparo. */
  actions: TriggerAction[];
}

/** Uma linha do registro de disparos, que so o mestre ve. */
export interface TriggerFiring {
  id: string;
  triggerId: string;
  triggerName: string;
  tokenId: string;
  tokenName: string;
  /** Jogador que moveu o token, quando foi um jogador. */
  playerId: string | null;
  at: number;
}

export const MAX_TRIGGER_ACTIONS = 12;
export const MAX_TRIGGER_POLYGON_POINTS = 64;
export const TRIGGER_LOG_SIZE = 50;

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

/** Vertices do contorno, para retangulo e poligono. */
export function areaPolygon(area: TriggerArea): Point[] | null {
  if (area.kind === 'polygon') return area.points;
  if (area.kind === 'rect') {
    const { x, y, width, height } = area;
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }
  return null;
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) return false;
  return (
    p.x >= Math.min(a.x, b.x) - 1e-9 &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    p.y >= Math.min(a.y, b.y) - 1e-9 &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

/**
 * O ponto esta dentro da area? A borda conta como dentro: um token que para
 * exatamente na linha de uma area desenhada na grade ja entrou nela.
 */
export function pointInArea(p: Point, area: TriggerArea): boolean {
  if (area.kind === 'circle') return Math.hypot(p.x - area.x, p.y - area.y) <= area.radius;

  const poly = areaPolygon(area)!;
  if (poly.length < 3) return false;

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (onSegment(p, a, b)) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * O segmento de `from` a `to` toca a area em algum ponto?
 *
 * E o SEGMENTO, e nao so o ponto final: um arraste rapido manda posicoes
 * espacadas, e um token que salta de um lado ao outro de um corredor estreito
 * nunca teria uma posicao registrada dentro dele.
 */
export function segmentTouchesArea(from: Point, to: Point, area: TriggerArea): boolean {
  if (pointInArea(from, area) || pointInArea(to, area)) return true;

  if (area.kind === 'circle') return distanceToSegment({ x: area.x, y: area.y }, from, to) <= area.radius;

  const poly = areaPolygon(area)!;
  const move = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    // Passar raspando por um vertice ou ao longo de uma aresta tambem conta.
    if (segmentsIntersect(move, { x1: a.x, y1: a.y, x2: b.x, y2: b.y })) return true;
    if (onSegment(a, from, to)) return true;
  }
  return false;
}

/**
 * O movimento de `from` a `to` e uma ENTRADA na area?
 *
 * Quem ja estava dentro e continua andando la dentro nao entra de novo — sem
 * isso, um gatilho "toda vez" dispararia a cada passo do arraste. Sair e
 * voltar e uma entrada nova.
 */
export function movementEntersArea(from: Point, to: Point, area: TriggerArea): boolean {
  if (from.x === to.x && from.y === to.y) return false;
  if (pointInArea(from, area)) return false;
  return segmentTouchesArea(from, to, area);
}

// ---------------------------------------------------------------------------
// Regras de disparo
// ---------------------------------------------------------------------------

/** Este token, movido por este papel, pode disparar o gatilho? */
export function triggerAccepts(trigger: Trigger, token: Token, movedByGm: boolean): boolean {
  if (!trigger.enabled) return false;
  if (trigger.mode === 'once' && !trigger.armed) return false;
  if (movedByGm && !trigger.includeGmMoves) return false;
  if (trigger.who === 'players') return token.ownerPlayerId !== null;
  if (trigger.who === 'tokens') return trigger.tokenIds.includes(token.id);
  return true;
}

/**
 * Gatilhos que este movimento dispara, na ordem em que estao na cena.
 *
 * `from` e `to` sao o centro do token antes e depois do passo — e o trecho
 * efetivamente percorrido: se uma parede barrou o movimento, quem chama passa
 * onde o token parou, e nao onde a pessoa queria que ele fosse.
 */
export function triggersFiredBy(
  triggers: Trigger[],
  token: Token,
  from: Point,
  to: Point,
  movedByGm: boolean,
): Trigger[] {
  return triggers.filter(
    (t) => triggerAccepts(t, token, movedByGm) && movementEntersArea(from, to, t.area),
  );
}

// ---------------------------------------------------------------------------
// Fabricas
// ---------------------------------------------------------------------------

export function createTrigger(partial: Partial<Trigger> & { id: string; area: TriggerArea }): Trigger {
  return {
    id: partial.id,
    name: partial.name ?? 'Gatilho',
    area: partial.area,
    enabled: partial.enabled ?? true,
    mode: partial.mode ?? 'once',
    armed: partial.armed ?? true,
    who: partial.who ?? 'players',
    tokenIds: partial.tokenIds ?? [],
    includeGmMoves: partial.includeGmMoves ?? false,
    actions: partial.actions ?? [{ type: 'notify-gm' }],
  };
}
