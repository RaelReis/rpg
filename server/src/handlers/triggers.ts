import {
  createTrigger,
  generateId,
  isScreenEffectKind,
  MAX_SCREEN_MESSAGE_LENGTH,
  MAX_SCREEN_MESSAGE_MS,
  MAX_TRIGGER_ACTIONS,
  MAX_TRIGGER_POLYGON_POINTS,
  sanitizeCardDuration,
  sanitizeScreenEffect,
  TRIGGER_LOG_SIZE,
  triggersFiredBy,
  type Ack,
  type Point,
  type Scene,
  type Token,
  type Trigger,
  type TriggerAction,
  type TriggerArea,
  type TriggerAudience,
  type TriggerFiring,
} from '@rpg/shared';

import { emitTokenUpsert, refreshVision, socketsOf } from '../broadcast.js';
import type { Room } from '../room.js';
import { clampNumber, fail, ok, safeString, type Ctx } from './context.js';
import { emitHandout, showHandout } from './handouts.js';
import { deliverScreenMessage } from './messages.js';
import { presentCardTo, startScreenEffect } from './screen.js';

/**
 * Gatilhos no mapa.
 *
 * Tudo aqui e do mestre e fica no servidor: o jogador nao recebe nem a lista,
 * nem as areas, nem o registro de disparos (`sceneForViewer` os esvazia). O
 * disparo tambem e decidido aqui, a cada passo de movimento — ver
 * `evaluateTriggers`, chamado por `moveToken`.
 */

const MAX_TRIGGERS_PER_SCENE = 200;
const COORD = 30000;

// ---------------------------------------------------------------------------
// Validacao
// ---------------------------------------------------------------------------

function finitePoint(p: unknown): Point | null {
  const q = p as Point | null;
  if (!q || typeof q.x !== 'number' || typeof q.y !== 'number') return null;
  if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return null;
  return { x: clampNumber(q.x, -COORD, COORD, 0), y: clampNumber(q.y, -COORD, COORD, 0) };
}

function sanitizeArea(raw: unknown): TriggerArea | null {
  const a = raw as Partial<TriggerArea> | null;
  if (!a || typeof a !== 'object') return null;

  if (a.kind === 'rect') {
    const r = a as Extract<TriggerArea, { kind: 'rect' }>;
    const width = clampNumber(r.width, 1, 2 * COORD, 0);
    const height = clampNumber(r.height, 1, 2 * COORD, 0);
    return {
      kind: 'rect',
      x: clampNumber(r.x, -COORD, COORD, 0),
      y: clampNumber(r.y, -COORD, COORD, 0),
      width,
      height,
    };
  }
  if (a.kind === 'circle') {
    const c = a as Extract<TriggerArea, { kind: 'circle' }>;
    return {
      kind: 'circle',
      x: clampNumber(c.x, -COORD, COORD, 0),
      y: clampNumber(c.y, -COORD, COORD, 0),
      radius: clampNumber(c.radius, 1, COORD, 1),
    };
  }
  if (a.kind === 'polygon') {
    const raws = Array.isArray((a as { points?: unknown }).points) ? (a as { points: unknown[] }).points : [];
    const points = raws.slice(0, MAX_TRIGGER_POLYGON_POINTS).map(finitePoint);
    if (points.length < 3 || points.some((p) => p === null)) return null;
    return { kind: 'polygon', points: points as Point[] };
  }
  return null;
}

function audience(v: unknown): TriggerAudience {
  return v === 'all' ? 'all' : 'triggerer';
}

function sanitizeAction(room: Room, scene: Scene, raw: unknown): TriggerAction | null {
  const a = raw as Partial<TriggerAction> & Record<string, unknown>;
  if (!a || typeof a !== 'object') return null;

  switch (a.type) {
    case 'notify-gm':
      return { type: 'notify-gm' };
    case 'message': {
      const style = a.style === 'whisper' || a.style === 'threat' ? a.style : 'neutral';
      return {
        type: 'message',
        to: audience(a.to),
        text: safeString(a.text, MAX_SCREEN_MESSAGE_LENGTH, ''),
        style,
        durationMs: a.durationMs === null ? null : clampNumber(a.durationMs, 1000, MAX_SCREEN_MESSAGE_MS, 6000),
      };
    }
    case 'screen-effect': {
      if (!isScreenEffectKind(a.kind)) return null;
      return {
        type: 'screen-effect',
        to: audience(a.to),
        kind: a.kind,
        params: sanitizeScreenEffect(a.kind, (a.params as object) ?? {}),
      };
    }
    case 'card': {
      const cardId = typeof a.cardId === 'string' && room.state.sceneCards.some((c) => c.id === a.cardId) ? a.cardId : null;
      return { type: 'card', to: audience(a.to), cardId, durationMs: sanitizeCardDuration(a.durationMs, null) };
    }
    case 'handout': {
      const handoutId =
        typeof a.handoutId === 'string' && room.state.handouts.some((h) => h.id === a.handoutId) ? a.handoutId : null;
      return { type: 'handout', to: audience(a.to), handoutId, share: Boolean(a.share), present: Boolean(a.present) };
    }
    case 'reveal-token': {
      const tokenId = typeof a.tokenId === 'string' && scene.tokens.some((t) => t.id === a.tokenId) ? a.tokenId : null;
      return { type: 'reveal-token', tokenId };
    }
    default:
      return null;
  }
}

/** Aplica sobre `trigger` so os campos que vieram, validados. */
function applyPatch(room: Room, scene: Scene, trigger: Trigger, p: Partial<Trigger>): string | null {
  if (p.area !== undefined) {
    const area = sanitizeArea(p.area);
    if (!area) return 'Area de gatilho invalida.';
    trigger.area = area;
  }
  if (p.name !== undefined) trigger.name = safeString(p.name, 60, trigger.name).trim() || 'Gatilho';
  if (p.enabled !== undefined) trigger.enabled = Boolean(p.enabled);
  if (p.mode !== undefined) trigger.mode = p.mode === 'always' ? 'always' : 'once';
  if (p.armed !== undefined) trigger.armed = Boolean(p.armed);
  if (p.who !== undefined) trigger.who = p.who === 'any' || p.who === 'tokens' ? p.who : 'players';
  if (p.tokenIds !== undefined && Array.isArray(p.tokenIds)) {
    const known = new Set(scene.tokens.map((t) => t.id));
    trigger.tokenIds = [...new Set(p.tokenIds)].filter((id) => typeof id === 'string' && known.has(id)).slice(0, 50);
  }
  if (p.includeGmMoves !== undefined) trigger.includeGmMoves = Boolean(p.includeGmMoves);
  if (p.actions !== undefined && Array.isArray(p.actions)) {
    trigger.actions = p.actions
      .slice(0, MAX_TRIGGER_ACTIONS)
      .map((a) => sanitizeAction(room, scene, a))
      .filter((a): a is TriggerAction => a !== null);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emissao — so para o mestre
// ---------------------------------------------------------------------------

function toGm(room: Room, fn: (socket: ReturnType<typeof socketsOf>[number]) => void): void {
  for (const socket of socketsOf(room)) if (socket.data.viewer.role === 'GM') fn(socket);
}

function emitTriggers(room: Room, scene: Scene, upsert: Trigger[], remove: string[] = []): void {
  toGm(room, (s) => s.emit('triggers:patch', { sceneId: scene.id, upsert, remove }));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createTriggerHandler(
  ctx: Ctx,
  payload: { sceneId: string; trigger: Partial<Trigger> },
  ack: Ack<Trigger>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');
  if (scene.triggers.length >= MAX_TRIGGERS_PER_SCENE) return fail(ack, 'Limite de gatilhos desta cena atingido.');

  const raw = payload.trigger ?? {};
  const area = sanitizeArea(raw.area);
  if (!area) return fail(ack, 'Area de gatilho invalida.');

  const trigger = createTrigger({ id: generateId('trg'), area });
  const error = applyPatch(ctx.room, scene, trigger, { ...raw, area });
  if (error) return fail(ack, error);

  scene.triggers.push(trigger);
  ctx.room.touchScene(scene.id);
  emitTriggers(ctx.room, scene, [trigger]);
  ok(ack, trigger);
}

export function updateTriggerHandler(
  ctx: Ctx,
  payload: { sceneId: string; triggerId: string; patch: Partial<Trigger> },
  ack: Ack<null>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');
  const trigger = scene.triggers.find((t) => t.id === payload.triggerId);
  if (!trigger) return fail(ack, 'Gatilho nao encontrado.');

  // Validado numa copia: um patch recusado nao pode deixar metade aplicada.
  const draft: Trigger = structuredClone(trigger);
  const error = applyPatch(ctx.room, scene, draft, payload.patch ?? {});
  if (error) return fail(ack, error);
  Object.assign(trigger, draft);

  ctx.room.touchScene(scene.id);
  emitTriggers(ctx.room, scene, [trigger]);
  ok(ack, null);
}

export function deleteTriggerHandler(
  ctx: Ctx,
  payload: { sceneId: string; triggerId: string },
  ack: Ack<null>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');
  const index = scene.triggers.findIndex((t) => t.id === payload.triggerId);
  if (index === -1) return fail(ack, 'Gatilho nao encontrado.');

  scene.triggers.splice(index, 1);
  ctx.room.touchScene(scene.id);
  emitTriggers(ctx.room, scene, [], [payload.triggerId]);
  ok(ack, null);
}

export function rearmTrigger(ctx: Ctx, payload: { sceneId: string; triggerId: string }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  const trigger = scene?.triggers.find((t) => t.id === payload?.triggerId);
  if (!scene || !trigger) return fail(ack, 'Gatilho nao encontrado.');

  trigger.armed = true;
  ctx.room.touchScene(scene.id);
  emitTriggers(ctx.room, scene, [trigger]);
  ok(ack, null);
}

export function clearTriggerLog(ctx: Ctx, payload: { sceneId: string }, ack: Ack<null>): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');
  scene.triggerLog = [];
  ctx.room.touchScene(scene.id);
  toGm(ctx.room, (s) => s.emit('trigger-log:patch', { sceneId: scene.id, log: [] }));
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Disparo
// ---------------------------------------------------------------------------

/** Centro do token numa posicao, que e o ponto testado contra as areas. */
export function tokenCenter(token: Token, at: Point, cellW: number, cellH: number): Point {
  return { x: at.x + (cellW * token.scale) / 2, y: at.y + (cellH * token.scale) / 2 };
}

/**
 * Avalia os gatilhos da cena para um passo de movimento ja aplicado.
 *
 * `from` e `to` sao os centros antes e depois — o trecho que o token
 * realmente percorreu. Quem chama passa o `to` depois das paredes: se elas
 * barraram o movimento, conta so ate onde o token chegou.
 */
export function evaluateTriggers(
  ctx: Ctx,
  scene: Scene,
  token: Token,
  from: Point,
  to: Point,
): void {
  if (scene.triggers.length === 0) return;
  const movedByGm = ctx.viewer.role === 'GM';
  const fired = triggersFiredBy(scene.triggers, token, from, to, movedByGm);
  if (fired.length === 0) return;

  // Quem disparou: o jogador que moveu, ou o dono do token quando foi o mestre.
  const triggerer = movedByGm ? token.ownerPlayerId : ctx.viewer.playerId;
  for (const trigger of fired) fire(ctx.room, scene, trigger, token, triggerer);
}

function fire(room: Room, scene: Scene, trigger: Trigger, token: Token, triggerer: string | null): void {
  if (trigger.mode === 'once') trigger.armed = false;

  const firing: TriggerFiring = {
    id: generateId('fir'),
    triggerId: trigger.id,
    triggerName: trigger.name,
    tokenId: token.id,
    tokenName: token.name,
    playerId: triggerer,
    at: Date.now(),
  };
  scene.triggerLog.push(firing);
  if (scene.triggerLog.length > TRIGGER_LOG_SIZE) scene.triggerLog.splice(0, scene.triggerLog.length - TRIGGER_LOG_SIZE);
  room.touchScene(scene.id);

  if (trigger.mode === 'once') emitTriggers(room, scene, [trigger]);
  const notify = trigger.actions.some((a) => a.type === 'notify-gm');
  toGm(room, (s) => s.emit('trigger:fired', { sceneId: scene.id, firing, notify }));

  for (const action of trigger.actions) {
    try {
      runAction(room, scene, action, triggerer);
    } catch (err) {
      // Uma acao quebrada nao impede as seguintes nem derruba o movimento.
      console.error(`[gatilho ${trigger.id}] falha na acao ${action.type}:`, err);
    }
  }
}

/** Destinatarios de uma acao: `null` = todos os jogadores; `[]` = ninguem. */
function recipientsOf(to: TriggerAudience, triggerer: string | null): string[] | null {
  if (to === 'all') return null;
  return triggerer ? [triggerer] : [];
}

function runAction(room: Room, scene: Scene, action: TriggerAction, triggerer: string | null): void {
  switch (action.type) {
    case 'notify-gm':
      // O aviso ao mestre ja saiu junto do registro do disparo.
      return;

    case 'message': {
      const to = recipientsOf(action.to, triggerer);
      const players = room.state.players.filter((p) => p.role === 'PLAYER').map((p) => p.id);
      const targets = to ?? players;
      if (targets.length === 0 || !action.text.trim()) return;
      void deliverScreenMessage(room, targets, {
        id: generateId('msg'),
        text: action.text,
        style: action.style,
        durationMs: action.durationMs,
      });
      return;
    }

    case 'screen-effect': {
      const to = recipientsOf(action.to, triggerer);
      if (to && to.length === 0) return;
      startScreenEffect(room, action.kind, action.params, to);
      return;
    }

    case 'card': {
      const card = room.state.sceneCards.find((c) => c.id === action.cardId);
      const to = recipientsOf(action.to, triggerer);
      if (!card || (to && to.length === 0)) return;
      presentCardTo(room, card, to, action.durationMs ?? card.durationMs);
      return;
    }

    case 'handout': {
      const handout = room.state.handouts.find((h) => h.id === action.handoutId);
      const to = recipientsOf(action.to, triggerer);
      if (!handout || (to && to.length === 0)) return;
      if (action.share) {
        if (to === null) handout.sharedWithAll = true;
        else handout.sharedWith = [...new Set([...handout.sharedWith, ...to])];
        handout.updatedAt = Date.now();
        room.touch('table');
        emitHandout(room, handout);
      }
      if (action.present) showHandout(room, handout, to);
      return;
    }

    case 'reveal-token': {
      const token = scene.tokens.find((t) => t.id === action.tokenId);
      if (!token || (token.visibility === 'visible' && !token.gmOnly)) return;
      token.visibility = 'visible';
      token.gmOnly = false;
      room.touchScene(scene.id);
      emitTokenUpsert(room, scene, token);
      refreshVision(room, scene);
      return;
    }
  }
}
