import { generateId, type Ack, type Handout } from '@rpg/shared';

import { socketsOf, syncAssets } from '../broadcast.js';
import { handoutForViewer } from '../filter.js';
import type { Room } from '../room.js';
import { clampNumber, fail, ok, ownedAsset, safeString, type Ctx } from './context.js';

/**
 * Materiais entregues ao grupo: a carta encontrada, o retrato do NPC, o mapa
 * da regiao.
 *
 * Duas ideias separadas de proposito. **Compartilhar** da acesso — o material
 * passa a existir para aquele jogador e ele consulta quando quiser.
 * **Apresentar** abre na tela de quem ja tem acesso, para o momento em que o
 * mestre quer a atencao da mesa. Juntar as duas tiraria do mestre a chance de
 * preparar material sem interromper a cena.
 */

const MAX_HANDOUTS = 200;
const MAX_TEXT = 20000;

/** Envia o material a cada socket, ou o remove de quem perdeu o acesso. */
function emitHandout(room: Room, handout: Handout): void {
  for (const socket of socketsOf(room)) {
    const visible = handoutForViewer(handout, socket.data.viewer);
    if (visible) {
      // A imagem acompanha o acesso: material em preparacao nao entrega a arte.
      syncAssets(room, socket, [visible.assetId]);
      socket.emit('handouts:patch', { upsert: [visible] });
    } else {
      socket.emit('handouts:patch', { remove: [handout.id] });
    }
  }
}

export function createHandout(
  ctx: Ctx,
  payload: { title: string; text?: string; assetId?: string | null },
  ack: Ack<Handout>,
): void {
  if (ctx.room.state.handouts.length >= MAX_HANDOUTS) {
    return fail(ack, 'Limite de materiais desta mesa atingido.');
  }

  const handout: Handout = {
    id: generateId('hnd'),
    title: safeString(payload?.title, 120, 'Novo material') || 'Novo material',
    text: safeString(payload?.text, MAX_TEXT, ''),
    assetId: ownedAsset(ctx, payload?.assetId),
    sharedWith: [],
    sharedWithAll: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  ctx.room.state.handouts.push(handout);
  ctx.room.touch('table');
  emitHandout(ctx.room, handout);
  ok(ack, handout);
}

export function updateHandout(
  ctx: Ctx,
  payload: { handoutId: string; patch: Partial<Handout> },
  ack: Ack<null>,
): void {
  const handout = ctx.room.state.handouts.find((h) => h.id === payload?.handoutId);
  if (!handout) return fail(ack, 'Material nao encontrado.');

  const p = payload.patch ?? {};
  if (p.title !== undefined) handout.title = safeString(p.title, 120, handout.title);
  if (p.text !== undefined) handout.text = safeString(p.text, MAX_TEXT, handout.text);
  if (p.assetId !== undefined) handout.assetId = ownedAsset(ctx, p.assetId);
  if (p.sharedWithAll !== undefined) handout.sharedWithAll = Boolean(p.sharedWithAll);

  if (p.sharedWith !== undefined && Array.isArray(p.sharedWith)) {
    // So aceita ids de jogadores que existem: uma lista com lixo daria acesso
    // fantasma e confundiria a contagem de quem esta vendo.
    const known = new Set(ctx.room.state.players.map((pl) => pl.id));
    handout.sharedWith = p.sharedWith
      .slice(0, clampNumber(known.size, 0, 100, 100))
      .filter((id) => known.has(id));
  }

  handout.updatedAt = Date.now();
  ctx.room.touch('table');
  emitHandout(ctx.room, handout);
  ok(ack, null);
}

export function deleteHandout(ctx: Ctx, payload: { handoutId: string }, ack: Ack<null>): void {
  const index = ctx.room.state.handouts.findIndex((h) => h.id === payload?.handoutId);
  if (index === -1) return fail(ack, 'Material nao encontrado.');

  const [removed] = ctx.room.state.handouts.splice(index, 1);
  ctx.room.touch('table');
  for (const socket of socketsOf(ctx.room)) {
    socket.emit('handouts:patch', { remove: [removed.id] });
  }
  ok(ack, null);
}

/** Abre o material na tela de quem ja tem acesso a ele. */
export function presentHandout(ctx: Ctx, payload: { handoutId: string }, ack: Ack<null>): void {
  const handout = ctx.room.state.handouts.find((h) => h.id === payload?.handoutId);
  if (!handout) return fail(ack, 'Material nao encontrado.');

  if (!handout.sharedWithAll && handout.sharedWith.length === 0) {
    return fail(ack, 'Compartilhe o material antes de apresenta-lo.');
  }

  for (const socket of socketsOf(ctx.room)) {
    if (!handoutForViewer(handout, socket.data.viewer)) continue;
    socket.emit('handout:presented', { handoutId: handout.id });
  }
  ok(ack, null);
}
