import {
  flashAllowed,
  generateId,
  isScreenEffectKind,
  sanitizeCardDuration,
  sanitizeScreenEffect,
  type Ack,
  type CardPresentation,
  type SceneCard,
  type ScreenEffect,
  type ScreenEffectKind,
  type ScreenEffectParams,
} from '@rpg/shared';

import { socketsOf, syncAssets } from '../broadcast.js';
import { targets } from '../live.js';
import type { Room } from '../room.js';
import { fail, ok, ownedAsset, safeString, type Ctx } from './context.js';

/**
 * Efeitos de tela e cartelas de cena.
 *
 * Os efeitos sao efemeros: nao vao para o banco, e so os fixos esperam por
 * quem reconecta (ver `live.ts`). As cartelas sao preparacao do mestre e sim
 * ficam gravadas — mas nenhuma parte delas chega ao jogador antes de ser
 * apresentada.
 */

const MAX_CARDS = 100;

/** Lista de destinatarios validada; `null` = todos os jogadores. */
function recipients(room: Room, raw: unknown): string[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const players = new Set(room.state.players.filter((p) => p.role === 'PLAYER').map((p) => p.id));
  const ids = [...new Set(raw)].filter((id): id is string => typeof id === 'string' && players.has(id));
  return ids.length ? ids : undefined;
}

// ---------------------------------------------------------------------------
// Efeitos de tela
// ---------------------------------------------------------------------------

export function applyScreenEffect(
  ctx: Ctx,
  payload: { kind: ScreenEffectKind; params: Partial<ScreenEffectParams>; playerIds: string[] | null },
  ack: Ack<ScreenEffect>,
): void {
  if (!isScreenEffectKind(payload?.kind)) return fail(ack, 'Efeito desconhecido.');
  const playerIds = recipients(ctx.room, payload.playerIds);
  if (playerIds === undefined) return fail(ack, 'Escolha para quem aplicar o efeito.');

  const live = ctx.room.live;
  const now = Date.now();
  if (payload.kind === 'flash') {
    // Luz piscando mais de 3 vezes por segundo pode desencadear crises.
    if (!flashAllowed(live.lastFlashAt, now)) {
      return fail(ack, 'Flashes muito seguidos: no maximo 3 por segundo.');
    }
    live.lastFlashAt = now;
  }

  const params = sanitizeScreenEffect(payload.kind, payload.params ?? {});
  const effect = live.addEffect({ id: generateId('sfx'), kind: payload.kind, ...params }, playerIds, () => {
    // O cliente encerra os temporizados sozinho; o painel do mestre tambem.
  });

  for (const socket of socketsOf(ctx.room)) {
    const viewer = socket.data.viewer;
    if (!targets(playerIds, viewer)) continue;
    // O jogador nao recebe a lista de quem mais esta sob o efeito.
    socket.emit('screen:applied', viewer.role === 'GM' ? effect : { ...effect, playerIds: undefined });
  }
  ok(ack, effect);
}

export function stopScreenEffect(ctx: Ctx, payload: { effectId?: string }, ack: Ack<null>): void {
  const live = ctx.room.live;
  const ids =
    typeof payload?.effectId === 'string' && payload.effectId ? [payload.effectId] : [...live.effects.keys()];

  const stopped = ids.flatMap((id) => {
    const active = live.removeEffect(id);
    return active ? [{ id, playerIds: active.playerIds }] : [];
  });

  // Cada um fica sabendo so do que era dele.
  for (const socket of socketsOf(ctx.room)) {
    const mine = stopped.filter((s) => targets(s.playerIds, socket.data.viewer)).map((s) => s.id);
    if (mine.length) socket.emit('screen:stopped', { ids: mine });
  }
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Cartelas de cena
// ---------------------------------------------------------------------------

/** Cartelas preparadas: so o mestre recebe. */
function emitCards(room: Room, upsert: SceneCard[], remove: string[] = []): void {
  for (const socket of socketsOf(room)) {
    if (socket.data.viewer.role !== 'GM') continue;
    socket.emit('cards:patch', { upsert, remove });
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
    title: safeString(payload?.title, 120, '').trim() || 'Nova cartela',
    subtitle: safeString(payload?.subtitle, 200, ''),
    assetId: ownedAsset(ctx, payload?.assetId),
    durationMs: 6000,
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
  if (p.durationMs !== undefined) card.durationMs = sanitizeCardDuration(p.durationMs, card.durationMs);

  card.updatedAt = Date.now();
  ctx.room.touch('table');
  emitCards(ctx.room, [card]);
  ok(ack, null);
}

export function deleteCard(ctx: Ctx, payload: { cardId: string }, ack: Ack<null>): void {
  const index = ctx.room.state.sceneCards.findIndex((c) => c.id === payload?.cardId);
  if (index === -1) return fail(ack, 'Cartela nao encontrada.');

  const [removed] = ctx.room.state.sceneCards.splice(index, 1);
  ctx.room.touch('table');

  // Cena que abria com ela passa a abrir sem cartela.
  for (const scene of ctx.room.state.scenes) {
    if (scene.introCardId !== removed.id) continue;
    scene.introCardId = null;
    ctx.room.touchScene(scene.id);
    for (const socket of socketsOf(ctx.room)) {
      if (socket.data.viewer.role === 'GM') {
        socket.emit('scene:patch', { sceneId: scene.id, patch: { introCardId: null } });
      }
    }
  }

  emitCards(ctx.room, [], [removed.id]);
  ok(ack, null);
}

/**
 * Coloca a cartela no ar. E o unico caminho pelo qual o conteudo dela chega a
 * um jogador — e so aos destinatarios.
 */
export function presentCardTo(room: Room, card: SceneCard, playerIds: string[] | null, durationMs: number | null): void {
  // Quem estava vendo outra cartela e nao esta entre os novos destinatarios
  // precisa ver aquela fechar.
  closePresentation(room);

  const presentation = room.live.present(
    {
      id: generateId('prs'),
      cardId: card.id,
      title: card.title,
      subtitle: card.subtitle,
      assetId: card.assetId,
      durationMs,
    },
    playerIds,
    () => emitClosed(room, presentation, playerIds),
  );

  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    if (!targets(playerIds, viewer)) continue;
    const gm = viewer.role === 'GM';
    // A imagem chega antes da cartela, para ela nao abrir sem fundo.
    if (!gm) syncAssets(room, socket, [presentation.assetId]);
    socket.emit('card:presented', gm ? presentation : { ...presentation, playerIds: undefined });
  }
}

function emitClosed(room: Room, presentation: CardPresentation, playerIds: string[] | null): void {
  for (const socket of socketsOf(room)) {
    if (!targets(playerIds, socket.data.viewer)) continue;
    socket.emit('card:closed', { presentationId: presentation.id });
  }
}

function closePresentation(room: Room): void {
  const closed = room.live.closePresentation();
  if (!closed) return;
  emitClosed(room, { ...closed.presentation, elapsedMs: 0 }, closed.playerIds);
}

export function presentCard(
  ctx: Ctx,
  payload: { cardId: string; playerIds: string[] | null; durationMs: number | null },
  ack: Ack<null>,
): void {
  const card = ctx.room.state.sceneCards.find((c) => c.id === payload?.cardId);
  if (!card) return fail(ack, 'Cartela nao encontrada.');
  const playerIds = recipients(ctx.room, payload.playerIds);
  if (playerIds === undefined) return fail(ack, 'Escolha para quem apresentar.');

  presentCardTo(ctx.room, card, playerIds, sanitizeCardDuration(payload.durationMs, card.durationMs));
  ok(ack, null);
}

export function closeCard(ctx: Ctx, _payload: Record<string, never>, ack: Ack<null>): void {
  closePresentation(ctx.room);
  ok(ack, null);
}
