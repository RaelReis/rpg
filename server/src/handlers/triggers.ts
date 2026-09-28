import {
  createTrigger,
  generateId,
  sanitizeScreenEffect,
  sanitizeTrigger,
  triggersEntered,
  type Ack,
  type Point,
  type Scene,
  type Token,
  type Trigger,
  type TriggerAction,
  type TriggerLogEntry,
  type TriggerTarget,
} from '@rpg/shared';

import { emitTokenUpsert, refreshVision, socketsOf } from '../broadcast.js';
import { handoutForViewer } from '../filter.js';
import type { Room } from '../room.js';
import { fail, isGm, ok, type Ctx } from './context.js';
import { emitHandout } from './handouts.js';
import { deliverScreenEffect, deliverScreenMessage, presentCardTo } from './immersion.js';

/**
 * Gatilhos no mapa: areas invisiveis que disparam acoes quando um token entra.
 *
 * Tudo aqui e do mestre. O jogador nunca recebe um gatilho — nem a area, nem
 * o nome — e o disparo e decidido no servidor, no mesmo ponto em que o
 * movimento ja e validado contra as paredes.
 */

const MAX_TRIGGERS_PER_SCENE = 200;
const MAX_LOG = 200;

/**
 * Um mesmo token nao dispara o mesmo gatilho duas vezes em menos disto. No
 * modo "toda vez", um arraste que tremula na borda da area viraria uma rajada
 * de disparos; ninguem quer tres mensagens iguais porque a mao tremeu.
 */
const REFIRE_COOLDOWN_MS = 1500;

/** Envia o gatilho aos mestres conectados, e a mais ninguem. */
function emitTriggers(room: Room, scene: Scene, upsert: Trigger[], remove: string[] = []): void {
  for (const socket of socketsOf(room)) {
    if (socket.data.viewer.role === 'GM') socket.emit('triggers:patch', { sceneId: scene.id, upsert, remove });
  }
}

// ---------------------------------------------------------------------------
// Edicao
// ---------------------------------------------------------------------------

export function createTriggerHandler(
  ctx: Ctx,
  payload: { sceneId: string; trigger: Partial<Trigger> },
  ack: Ack<Trigger>,
): void {
  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return fail(ack, 'Cena nao encontrada.');
  if (scene.triggers.length >= MAX_TRIGGERS_PER_SCENE) return fail(ack, 'Limite de gatilhos desta cena atingido.');

  const draft = payload.trigger ?? {};
  const base = createTrigger({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 });
  const trigger = sanitizeTrigger({ ...draft, armed: draft.armed ?? true }, base);
  if (!trigger || draft.area === undefined) return fail(ack, 'Area do gatilho invalida.');

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
  const index = scene.triggers.findIndex((t) => t.id === payload.triggerId);
  if (index === -1) return fail(ack, 'Gatilho nao encontrado.');

  const next = sanitizeTrigger(payload.patch, scene.triggers[index]);
  if (!next) return fail(ack, 'Area do gatilho invalida.');

  scene.triggers[index] = next;
  ctx.room.touchScene(scene.id);
  emitTriggers(ctx.room, scene, [next]);
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

// ---------------------------------------------------------------------------
// Disparo
// ---------------------------------------------------------------------------

/**
 * Confere os gatilhos para um passo de movimento ja aceito.
 *
 * `from` e onde o token estava antes deste passo; a posicao atual do token e
 * o destino. Se o movimento foi barrado por parede, quem chama passa a
 * posicao onde o token de fato parou — so conta o trecho percorrido.
 */
export function checkTriggers(ctx: Ctx, scene: Scene, token: Token, from: Point): void {
  if (!scene.triggers?.length) return;
  const to = { x: token.x, y: token.y };
  if (from.x === to.x && from.y === to.y) return;

  const movedByGm = isGm(ctx);
  const hits = triggersEntered(scene, token, from, to, movedByGm);
  if (hits.length === 0) return;

  // Quem disparou: o dono do token, ou o jogador que o moveu.
  const triggerer = token.ownerPlayerId ?? (movedByGm ? null : ctx.viewer.playerId);
  const now = Date.now();

  for (const trigger of hits) {
    const key = `${trigger.id}:${token.id}`;
    const last = ctx.room.triggerCooldown.get(key);
    if (last !== undefined && now - last < REFIRE_COOLDOWN_MS) continue;
    ctx.room.triggerCooldown.set(key, now);
    fireTrigger(ctx.room, scene, trigger, token, triggerer);
  }
}

function targetsOf(target: TriggerTarget, triggerer: string | null): string[] | null {
  if (target === 'all') return null;
  return triggerer ? [triggerer] : [];
}

/**
 * Executa o gatilho: desarma (no modo "uma vez"), registra e roda as acoes na
 * ordem da lista. O disparo nao entra no desfazer do mestre — ele aconteceu
 * na mesa, e o que os jogadores viram nao volta.
 */
export function fireTrigger(room: Room, scene: Scene, trigger: Trigger, token: Token, triggerer: string | null): void {
  if (trigger.mode === 'once') {
    trigger.armed = false;
    room.touchScene(scene.id);
    emitTriggers(room, scene, [trigger]);
  }

  const entry: TriggerLogEntry = {
    id: generateId('tlg'),
    at: Date.now(),
    sceneId: scene.id,
    triggerId: trigger.id,
    triggerName: trigger.name,
    tokenId: token.id,
    tokenName: token.name,
    playerName: room.player(triggerer)?.name ?? null,
  };
  room.state.triggerLog.push(entry);
  if (room.state.triggerLog.length > MAX_LOG) room.state.triggerLog.splice(0, room.state.triggerLog.length - MAX_LOG);
  room.touch('table');
  for (const socket of socketsOf(room)) {
    if (socket.data.viewer.role === 'GM') socket.emit('trigger:fired', entry);
  }

  for (const action of trigger.actions) {
    try {
      runAction(room, scene, trigger, action, entry, triggerer);
    } catch (err) {
      // Uma acao quebrada (material apagado, cartela sumida) nao impede as
      // seguintes, nem derruba o movimento que a disparou.
      console.error(`[gatilho ${trigger.id}] acao ${action.type} falhou:`, err);
    }
  }
}

function runAction(
  room: Room,
  scene: Scene,
  trigger: Trigger,
  action: TriggerAction,
  entry: TriggerLogEntry,
  triggerer: string | null,
): void {
  switch (action.type) {
    case 'notify': {
      const who = entry.playerName ? `${entry.tokenName} (${entry.playerName})` : entry.tokenName;
      for (const socket of socketsOf(room)) {
        if (socket.data.viewer.role === 'GM') {
          socket.emit('notice', { level: 'info', message: `Gatilho "${trigger.name}": ${who} entrou.` });
        }
      }
      return;
    }

    case 'message': {
      const recipients = targetsOf(action.target, triggerer);
      const ids =
        recipients ?? room.state.players.filter((p) => p.role === 'PLAYER').map((p) => p.id);
      if (!action.text.trim() || ids.length === 0) return;
      void deliverScreenMessage(room, ids, {
        id: generateId('msg'),
        text: action.text,
        style: action.style,
        durationMs: action.durationMs,
      });
      return;
    }

    case 'screen': {
      const recipients = targetsOf(action.target, triggerer);
      if (recipients?.length === 0) return;
      const effect = sanitizeScreenEffect(action.effect, generateId('sfx'));
      if (effect) deliverScreenEffect(room, effect, recipients);
      return;
    }

    case 'card': {
      const recipients = targetsOf(action.target, triggerer);
      const card = room.state.sceneCards.find((c) => c.id === action.cardId);
      if (!card || recipients?.length === 0) return;
      presentCardTo(room, card, recipients, action.durationMs);
      return;
    }

    case 'handout': {
      const handout = room.state.handouts.find((h) => h.id === action.handoutId);
      if (!handout) return;
      if (action.share === 'all') handout.sharedWithAll = true;
      if (action.share === 'trigger' && triggerer && !handout.sharedWith.includes(triggerer)) {
        handout.sharedWith.push(triggerer);
      }
      if (action.share !== 'none') {
        handout.updatedAt = Date.now();
        room.touch('table');
        emitHandout(room, handout);
      }
      if (action.present) {
        // Apresentar abre a janela de quem tem acesso; quem nao tem continua
        // sem saber do material.
        for (const socket of socketsOf(room)) {
          const viewer = socket.data.viewer;
          if (viewer.role === 'GM' || !handoutForViewer(handout, viewer)) continue;
          if (action.share === 'trigger' && viewer.playerId !== triggerer && !handout.sharedWithAll) continue;
          socket.emit('handout:presented', { handoutId: handout.id });
        }
      }
      return;
    }

    case 'reveal': {
      const token = scene.tokens.find((t) => t.id === action.tokenId);
      if (!token) return;
      token.visibility = 'visible';
      room.touchScene(scene.id);
      emitTokenUpsert(room, scene, token);
      refreshVision(room, scene);
      return;
    }
  }
}
