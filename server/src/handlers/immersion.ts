import {
  flashAllowed,
  generateId,
  MAX_SCREEN_MESSAGE_LENGTH,
  reduceScreenEffect,
  sanitizeScreenEffect,
  SCREEN_MESSAGE_MAX_MS,
  SCREEN_MESSAGE_MIN_MS,
  type Ack,
  type CardPresentRequest,
  type PresentedCard,
  type SceneCard,
  type ScreenEffect,
  type ScreenEffectRequest,
  type ScreenMessage,
  type ScreenMessageDelivery,
  type ScreenMessageRequest,
  type ScreenMessageStyle,
} from '@rpg/shared';

import { emitPlayers, socketsOf, syncAssets, type TypedSocket } from '../broadcast.js';
import { isRecipient, prefersReducedEffects, presentedCardForViewer } from '../filter.js';
import type { Room } from '../room.js';
import { clampNumber, fail, ok, ownedAsset, safeString, type Ctx } from './context.js';

/**
 * Recursos de imersao: o que o mestre faz aparecer na tela dos jogadores,
 * fora do mapa. Tudo aqui e decidido no servidor — quem recebe, e o que
 * recebe —, e o cliente so desenha.
 */

const MESSAGE_STYLES: ScreenMessageStyle[] = ['neutral', 'whisper', 'threat'];

/** Quanto esperar a confirmacao de cada aba antes de dar a entrega por incerta. */
const DELIVERY_TIMEOUT_MS = 4000;

/** Sockets conectados de cada jogador pedido, so jogadores desta mesa. */
function socketsByPlayer(room: Room, playerIds: Iterable<string>): Map<string, TypedSocket[]> {
  const wanted = new Set(playerIds);
  const out = new Map<string, TypedSocket[]>();
  for (const id of wanted) {
    const player = room.player(id);
    if (player && player.role === 'PLAYER') out.set(id, []);
  }
  for (const socket of socketsOf(room)) {
    out.get(socket.data.viewer.playerId)?.push(socket);
  }
  return out;
}

/**
 * Entrega uma mensagem e espera a confirmacao de cada destinatario.
 *
 * Uma pessoa com duas abas abertas conta como entregue se qualquer uma
 * confirmar. Quem nao tem aba nenhuma fica em `offline`: a mensagem nao e
 * guardada para depois, porque fora de hora ela perde o sentido.
 */
export async function deliverScreenMessage(
  room: Room,
  recipients: Iterable<string>,
  message: ScreenMessage,
): Promise<ScreenMessageDelivery> {
  const result: ScreenMessageDelivery = { delivered: [], offline: [], unconfirmed: [] };

  await Promise.all(
    [...socketsByPlayer(room, recipients)].map(async ([playerId, sockets]) => {
      if (sockets.length === 0) {
        result.offline.push(playerId);
        return;
      }
      const acks = await Promise.all(
        sockets.map((socket) =>
          socket
            .timeout(DELIVERY_TIMEOUT_MS)
            .emitWithAck('message:show', message)
            .then((received) => received === true)
            .catch(() => false),
        ),
      );
      (acks.some(Boolean) ? result.delivered : result.unconfirmed).push(playerId);
    }),
  );

  return result;
}

/** Monta a mensagem a partir do que o cliente mandou, ou devolve o erro. */
export function screenMessageFrom(payload: Partial<ScreenMessageRequest> | undefined): ScreenMessage | string {
  const text = safeString(payload?.text, MAX_SCREEN_MESSAGE_LENGTH).trim();
  if (!text) return 'Escreva a mensagem.';

  const style = MESSAGE_STYLES.includes(payload?.style as ScreenMessageStyle)
    ? (payload!.style as ScreenMessageStyle)
    : 'neutral';

  const durationMs =
    payload?.durationMs === null
      ? null
      : clampNumber(payload?.durationMs, SCREEN_MESSAGE_MIN_MS, SCREEN_MESSAGE_MAX_MS, 6000);

  return { id: generateId('msg'), text, style, durationMs };
}

export async function sendScreenMessage(
  ctx: Ctx,
  payload: ScreenMessageRequest,
  ack: Ack<ScreenMessageDelivery>,
): Promise<void> {
  const message = screenMessageFrom(payload);
  if (typeof message === 'string') return fail(ack, message);

  const recipients = Array.isArray(payload?.recipients)
    ? payload.recipients.filter((id): id is string => typeof id === 'string').slice(0, 50)
    : [];
  if (recipients.length === 0) return fail(ack, 'Escolha quem recebe a mensagem.');

  const delivery = await deliverScreenMessage(ctx.room, recipients, message);
  if (delivery.delivered.length + delivery.offline.length + delivery.unconfirmed.length === 0) {
    return fail(ack, 'Nenhum destinatario valido.');
  }
  ok(ack, delivery);
}

/** Lista de destinatarios vinda do cliente: `null` = todos os jogadores. */
export function recipientsOf(room: Room, value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const players = new Set(room.state.players.filter((p) => p.role === 'PLAYER').map((p) => p.id));
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && players.has(id)))];
}

// ---------------------------------------------------------------------------
// Efeitos de tela
// ---------------------------------------------------------------------------

const MAX_FIXED_EFFECTS = 20;

/** Avisa os mestres conectados de quais efeitos fixos estao ativos. */
function emitActiveEffects(room: Room): void {
  for (const socket of socketsOf(room)) {
    if (socket.data.viewer.role === 'GM') socket.emit('screen:active', room.state.screenEffects);
  }
}

/**
 * Entrega um efeito aos jogadores escolhidos.
 *
 * A reducao acontece AQUI, por destinatario: quem pediu "reduzir efeitos"
 * recebe a vinheta no lugar do flash e nao recebe o tremor. O teto de
 * flashes tambem: um clarao que chegaria menos de 334ms depois do anterior
 * nao e enviado. O mestre nao recebe o efeito na propria tela — ele esta
 * conduzindo a cena, e o painel mostra o que esta ativo.
 */
export function deliverScreenEffect(room: Room, effect: ScreenEffect, recipients: string[] | null): void {
  const now = Date.now();
  const flashedNow = new Set<string>();

  for (const socket of socketsOf(room)) {
    const { playerId, role } = socket.data.viewer;
    if (role !== 'PLAYER' || !isRecipient(recipients, playerId)) continue;

    const shown = prefersReducedEffects(room, playerId) ? reduceScreenEffect(effect) : effect;
    if (!shown) continue;

    // A mesma pessoa com duas abas recebe o flash nas duas; o teto e por
    // pessoa e por pedido, nao por aba.
    if (shown.kind === 'flash' && !flashedNow.has(playerId)) {
      if (!flashAllowed(room.lastFlashAt.get(playerId), now)) continue;
      room.lastFlashAt.set(playerId, now);
      flashedNow.add(playerId);
    }
    socket.emit('screen:effect', shown);
  }

  if (effect.durationMs === null) {
    room.state.screenEffects.push({ ...effect, recipients });
    emitActiveEffects(room);
  }
}

export function applyScreenEffect(ctx: Ctx, payload: ScreenEffectRequest, ack: Ack<ScreenEffect>): void {
  const effect = sanitizeScreenEffect(payload?.effect, generateId('sfx'));
  if (!effect) return fail(ack, 'Efeito de tela invalido.');
  if (effect.durationMs === null && ctx.room.state.screenEffects.length >= MAX_FIXED_EFFECTS) {
    return fail(ack, 'Efeitos fixos demais ativos. Remova algum antes.');
  }

  const recipients = recipientsOf(ctx.room, payload?.recipients);
  if (recipients !== null && recipients.length === 0) return fail(ack, 'Escolha quem recebe o efeito.');
  deliverScreenEffect(ctx.room, effect, recipients);
  ok(ack, effect);
}

export function stopScreenEffect(ctx: Ctx, payload: { effectId?: string }, ack: Ack<null>): void {
  const room = ctx.room;
  const effectId = typeof payload?.effectId === 'string' ? payload.effectId : null;

  if (!effectId) {
    // "Parar todos": os fixos e os que ainda estao correndo.
    room.state.screenEffects = [];
    for (const socket of socketsOf(room)) {
      if (socket.data.viewer.role === 'PLAYER') socket.emit('screen:stopped', { all: true });
    }
    emitActiveEffects(room);
    return ok(ack, null);
  }

  const index = room.state.screenEffects.findIndex((e) => e.id === effectId);
  if (index === -1) return fail(ack, 'Efeito nao encontrado.');
  const [removed] = room.state.screenEffects.splice(index, 1);

  // So quem recebeu o efeito fica sabendo que ele acabou.
  for (const socket of socketsOf(room)) {
    const { playerId, role } = socket.data.viewer;
    if (role === 'PLAYER' && isRecipient(removed.recipients, playerId)) {
      socket.emit('screen:stopped', { ids: [removed.id] });
    }
  }
  emitActiveEffects(room);
  ok(ack, null);
}

export function updatePrefs(ctx: Ctx, payload: { reduceEffects?: boolean }, ack: Ack<null>): void {
  const player = ctx.room.player(ctx.viewer.playerId);
  if (!player) return fail(ack, 'Jogador nao encontrado.');
  if (typeof payload?.reduceEffects === 'boolean') player.reduceEffects = payload.reduceEffects;
  ctx.room.touchPlayer(player.id);
  emitPlayers(ctx.room);
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Cartelas de cena
// ---------------------------------------------------------------------------

const MAX_CARDS = 100;
const CARD_MIN_MS = 2000;
const CARD_MAX_MS = 120000;
/** Duracao da cartela mostrada ao ativar uma cena. */
export const INTRO_CARD_MS = 6000;

function emitCards(room: Room, upsert: SceneCard[], remove: string[] = []): void {
  // Material de preparacao: so o mestre recebe, nem o titulo sai.
  for (const socket of socketsOf(room)) {
    if (socket.data.viewer.role === 'GM') socket.emit('cards:patch', { upsert, remove });
  }
}

export function createCard(
  ctx: Ctx,
  payload: { title: string; subtitle?: string; assetId?: string | null },
  ack: Ack<SceneCard>,
): void {
  if (ctx.room.state.sceneCards.length >= MAX_CARDS) return fail(ack, 'Limite de cartelas desta mesa atingido.');
  const card: SceneCard = {
    id: generateId('crd'),
    title: safeString(payload?.title, 120).trim() || 'Nova cartela',
    subtitle: safeString(payload?.subtitle, 200),
    assetId: ownedAsset(ctx, payload?.assetId),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  ctx.room.state.sceneCards.push(card);
  ctx.room.touch('table');
  emitCards(ctx.room, [card]);
  ok(ack, card);
}

export function updateCard(ctx: Ctx, payload: { cardId: string; patch: Partial<SceneCard> }, ack: Ack<null>): void {
  const card = ctx.room.state.sceneCards.find((c) => c.id === payload?.cardId);
  if (!card) return fail(ack, 'Cartela nao encontrada.');
  const p = payload.patch ?? {};
  if (p.title !== undefined) card.title = safeString(p.title, 120, card.title);
  if (p.subtitle !== undefined) card.subtitle = safeString(p.subtitle, 200, card.subtitle);
  if (p.assetId !== undefined) card.assetId = ownedAsset(ctx, p.assetId);
  card.updatedAt = Date.now();
  ctx.room.touch('table');
  emitCards(ctx.room, [card]);
  ok(ack, null);
}

export function deleteCard(ctx: Ctx, payload: { cardId: string }, ack: Ack<null>): void {
  const room = ctx.room;
  const index = room.state.sceneCards.findIndex((c) => c.id === payload?.cardId);
  if (index === -1) return fail(ack, 'Cartela nao encontrada.');
  const [removed] = room.state.sceneCards.splice(index, 1);

  if (room.state.presentedCard?.cardId === removed.id) closePresentedCard(room);

  // Cena que abria com esta cartela deixa de abrir.
  for (const scene of room.state.scenes) {
    if (scene.introCardId !== removed.id) continue;
    scene.introCardId = null;
    room.touchScene(scene.id);
    for (const socket of socketsOf(room)) {
      if (socket.data.viewer.role === 'GM') {
        socket.emit('scene:patch', { sceneId: scene.id, patch: { introCardId: null } });
      }
    }
  }

  room.touch('table');
  emitCards(room, [], [removed.id]);
  ok(ack, null);
}

/**
 * Coloca uma cartela na tela dos destinatarios.
 *
 * E so aqui que titulo, subtitulo e imagem saem do servidor para o jogador —
 * antes disso a cartela nao existe para ele. A imagem vai junto, por
 * `syncAssets`, antes da cartela que a usa.
 */
export function presentCardTo(
  room: Room,
  card: SceneCard,
  recipients: string[] | null,
  durationMs: number | null,
): void {
  const previous = room.state.presentedCard;
  if (room.presentationTimer) clearTimeout(room.presentationTimer);
  room.presentationTimer = null;

  const presented: PresentedCard = {
    cardId: card.id,
    title: card.title,
    subtitle: card.subtitle,
    assetId: card.assetId,
    durationMs,
    recipients,
  };
  room.state.presentedCard = presented;
  room.presentationStartedAt = Date.now();

  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    const shown = presentedCardForViewer(room, viewer);
    if (shown) {
      syncAssets(room, socket, [shown.assetId]);
      socket.emit('card:presented', shown);
    } else if (previous && viewer.role === 'PLAYER' && isRecipient(previous.recipients, viewer.playerId)) {
      // Estava vendo a cartela anterior e nao ve a nova: a anterior sai.
      socket.emit('card:presented', null);
    }
  }

  if (durationMs !== null) {
    room.presentationTimer = setTimeout(() => {
      if (room.state.presentedCard === presented) closePresentedCard(room);
    }, durationMs);
    room.presentationTimer.unref?.();
  }
}

/** Tira a cartela da tela de quem a via, e avisa o mestre. */
export function closePresentedCard(room: Room): void {
  const card = room.state.presentedCard;
  if (room.presentationTimer) clearTimeout(room.presentationTimer);
  room.presentationTimer = null;
  room.state.presentedCard = null;
  if (!card) return;

  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    if (viewer.role === 'GM' || isRecipient(card.recipients, viewer.playerId)) {
      socket.emit('card:presented', null);
    }
  }
}

export function presentCard(ctx: Ctx, payload: CardPresentRequest, ack: Ack<null>): void {
  const card = ctx.room.state.sceneCards.find((c) => c.id === payload?.cardId);
  if (!card) return fail(ack, 'Cartela nao encontrada.');
  const recipients = recipientsOf(ctx.room, payload?.recipients);
  if (recipients !== null && recipients.length === 0) return fail(ack, 'Escolha quem ve a cartela.');
  const durationMs =
    payload?.durationMs === null ? null : clampNumber(payload?.durationMs, CARD_MIN_MS, CARD_MAX_MS, INTRO_CARD_MS);

  presentCardTo(ctx.room, card, recipients, durationMs);
  ok(ack, null);
}

export function closeCard(ctx: Ctx, _payload: unknown, ack: Ack<null>): void {
  closePresentedCard(ctx.room);
  ok(ack, null);
}
