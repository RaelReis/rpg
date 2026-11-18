import {
  boardItemForViewer,
  generateId,
  type Ack,
  type BoardItem,
  type BoardItemKind,
  type BoardPatch,
  type BoardThread,
} from '@rpg/shared';

import { socketsOf, syncAssets } from '../broadcast.js';
import { handoutForViewer, type Viewer } from '../filter.js';
import type { Room } from '../room.js';
import { clampNumber, fail, isGm, ok, ownedAsset, safeString, type Ctx } from './context.js';

/**
 * Quadro de pistas: um por mesa, montado pelo grupo.
 *
 * Todos criam, movem e editam; apagar e do autor e do mestre; o mestre pode
 * travar o quadro — e a trava vale AQUI, no servidor, nao so nos botoes. A
 * ultima escrita vence por item. Arrastar um cartao emite dezenas de posicoes
 * por segundo: elas vao aos outros na hora, e o banco recebe uma escrita
 * agrupada quando o movimento para (`touch('board')` e debounced).
 */

const MAX_ITEMS = 300;
const MAX_THREADS = 500;
const MAX_TEXT = 1000;
const COORD = 50000;
const KINDS: BoardItemKind[] = ['note', 'image', 'handout'];

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

/** O quadro esta travado para esta pessoa? */
function lockedFor(ctx: Ctx): boolean {
  return ctx.room.state.board.locked && !isGm(ctx);
}

/** O observador enxerga este material? Mesma regra da aba Materiais. */
function viewerSeesHandout(room: Room, viewer: Viewer): (handoutId: string) => boolean {
  return (handoutId) => {
    const handout = room.state.handouts.find((h) => h.id === handoutId);
    return !!handout && handoutForViewer(handout, viewer) !== null;
  };
}

/** Item na versao que este observador recebe. */
export function boardItemFor(room: Room, item: BoardItem, viewer: Viewer): BoardItem {
  if (viewer.role === 'GM') return item;
  return boardItemForViewer(item, viewerSeesHandout(room, viewer));
}

/**
 * Envia itens do quadro a todos, filtrados um a um. O cartao de material sai
 * completo so para quem tem acesso ao material; a imagem do item vai antes do
 * item que a usa.
 */
export function emitBoardItems(room: Room, items: BoardItem[], extra: Omit<BoardPatch, 'upsert'> = {}): void {
  for (const socket of socketsOf(room)) {
    const viewer = socket.data.viewer;
    const upsert = items.map((item) => boardItemFor(room, item, viewer));
    syncAssets(room, socket, upsert.map((i) => i.assetId));
    socket.emit('board:patch', { ...extra, upsert });
  }
}

/** Reenvia os cartoes que citam um material, depois que o acesso a ele mudou. */
export function refreshBoardForHandout(room: Room, handoutId: string): void {
  const items = room.state.board.items.filter((i) => i.kind === 'handout' && i.handoutId === handoutId);
  if (items.length) emitBoardItems(room, items);
}

function emitToAll(room: Room, patch: BoardPatch): void {
  for (const socket of socketsOf(room)) socket.emit('board:patch', patch);
}

// ---------------------------------------------------------------------------
// Itens
// ---------------------------------------------------------------------------

export function createBoardItem(ctx: Ctx, payload: { item: Partial<BoardItem> }, ack: Ack<BoardItem>): void {
  if (lockedFor(ctx)) return fail(ack, 'O mestre travou o quadro.');
  const board = ctx.room.state.board;
  if (board.items.length >= MAX_ITEMS) return fail(ack, 'O quadro esta cheio. Apague alguma coisa antes.');

  const raw = payload?.item ?? {};
  const kind = KINDS.includes(raw.kind as BoardItemKind) ? (raw.kind as BoardItemKind) : 'note';

  // Ninguem prega no quadro um material que nao tem: o id viria do console, e
  // o cartao "indisponivel" entregaria aos outros que o material existe.
  let handoutId: string | null = null;
  if (kind === 'handout') {
    handoutId = typeof raw.handoutId === 'string' ? raw.handoutId : null;
    if (!handoutId || !viewerSeesHandout(ctx.room, ctx.viewer)(handoutId)) {
      return fail(ack, 'Material nao encontrado.');
    }
  }

  const assetId = kind === 'image' ? ownedAsset(ctx, raw.assetId) : null;
  if (kind === 'image' && !assetId) return fail(ack, 'Imagem nao encontrada.');

  const item: BoardItem = {
    id: generateId('brd'),
    kind,
    x: clampNumber(raw.x, -COORD, COORD, 0),
    y: clampNumber(raw.y, -COORD, COORD, 0),
    text: safeString(raw.text, MAX_TEXT),
    color: color(raw.color, '#f3e3a1'),
    assetId,
    handoutId,
    authorId: ctx.viewer.playerId,
    updatedAt: Date.now(),
  };

  board.items.push(item);
  ctx.room.touch('board');
  emitBoardItems(ctx.room, [item]);
  ok(ack, item);
}

export function updateBoardItem(
  ctx: Ctx,
  payload: { itemId: string; patch: Partial<BoardItem>; dragging?: boolean },
  ack?: Ack<null>,
): void {
  if (lockedFor(ctx)) return fail(ack, 'O mestre travou o quadro.');
  const item = ctx.room.state.board.items.find((i) => i.id === payload?.itemId);
  if (!item) return fail(ack, 'Item nao encontrado.');

  const p = payload.patch ?? {};
  if (p.x !== undefined) item.x = clampNumber(p.x, -COORD, COORD, item.x);
  if (p.y !== undefined) item.y = clampNumber(p.y, -COORD, COORD, item.y);
  // Quem nao ve o material recebe o cartao sem legenda; deixar que a
  // reescrevesse seria apagar, as cegas, o que o mestre escreveu.
  const blind = item.kind === 'handout' && boardItemFor(ctx.room, item, ctx.viewer).unavailable;
  if (p.text !== undefined && !blind) item.text = safeString(p.text, MAX_TEXT, item.text);
  if (p.color !== undefined) item.color = color(p.color, item.color);
  // O tipo e o conteudo de referencia (imagem, material) nao mudam depois de
  // pregado: trocar o material de um cartao e pregar outro cartao.
  item.updatedAt = Date.now();

  ctx.room.touch('board');

  if (payload.dragging) {
    // Durante o arraste o item vai aos OUTROS; quem arrasta ja o tem na mao,
    // e receber a propria posicao atrasada faria o cartao tremer.
    for (const socket of socketsOf(ctx.room)) {
      if (socket.id === ctx.socket.id) continue;
      socket.emit('board:patch', { upsert: [boardItemFor(ctx.room, item, socket.data.viewer)] });
    }
    return ok(ack, null);
  }

  emitBoardItems(ctx.room, [item]);
  ok(ack, null);
}

/** Apagar: o autor e o mestre. */
function canRemove(ctx: Ctx, authorId: string | null): boolean {
  return isGm(ctx) || (authorId !== null && authorId === ctx.viewer.playerId);
}

export function deleteBoardItem(ctx: Ctx, payload: { itemId: string }, ack: Ack<null>): void {
  if (lockedFor(ctx)) return fail(ack, 'O mestre travou o quadro.');
  const board = ctx.room.state.board;
  const item = board.items.find((i) => i.id === payload?.itemId);
  if (!item) return fail(ack, 'Item nao encontrado.');
  if (!canRemove(ctx, item.authorId)) return fail(ack, 'So quem pregou (ou o mestre) pode apagar.');

  board.items = board.items.filter((i) => i.id !== item.id);
  // Fio sem uma das pontas nao tem o que ligar.
  const orphans = board.threads.filter((t) => t.from === item.id || t.to === item.id).map((t) => t.id);
  board.threads = board.threads.filter((t) => !orphans.includes(t.id));

  ctx.room.touch('board');
  emitToAll(ctx.room, { remove: [item.id], threads: { remove: orphans } });
  ok(ack, null);
}

export function lockBoard(ctx: Ctx, payload: { locked: boolean }, ack: Ack<null>): void {
  ctx.room.state.board.locked = Boolean(payload?.locked);
  ctx.room.touch('board');
  emitToAll(ctx.room, { locked: ctx.room.state.board.locked });
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Fios
// ---------------------------------------------------------------------------

export function createThread(
  ctx: Ctx,
  payload: { from: string; to: string; color?: string },
  ack: Ack<BoardThread>,
): void {
  if (lockedFor(ctx)) return fail(ack, 'O mestre travou o quadro.');
  const board = ctx.room.state.board;
  if (board.threads.length >= MAX_THREADS) return fail(ack, 'Fios demais no quadro.');

  const from = payload?.from;
  const to = payload?.to;
  const exists = (id: unknown) => board.items.some((i) => i.id === id);
  if (typeof from !== 'string' || typeof to !== 'string' || from === to || !exists(from) || !exists(to)) {
    return fail(ack, 'Escolha dois itens diferentes do quadro.');
  }
  const duplicate = board.threads.find(
    (t) => (t.from === from && t.to === to) || (t.from === to && t.to === from),
  );
  if (duplicate) return ok(ack, duplicate);

  const thread: BoardThread = {
    id: generateId('fio'),
    from,
    to,
    color: color(payload.color, '#c0392b'),
    authorId: ctx.viewer.playerId,
  };
  board.threads.push(thread);
  ctx.room.touch('board');
  emitToAll(ctx.room, { threads: { upsert: [thread] } });
  ok(ack, thread);
}

export function updateThread(ctx: Ctx, payload: { threadId: string; color: string }, ack: Ack<null>): void {
  if (lockedFor(ctx)) return fail(ack, 'O mestre travou o quadro.');
  const thread = ctx.room.state.board.threads.find((t) => t.id === payload?.threadId);
  if (!thread) return fail(ack, 'Fio nao encontrado.');
  thread.color = color(payload.color, thread.color);
  ctx.room.touch('board');
  emitToAll(ctx.room, { threads: { upsert: [thread] } });
  ok(ack, null);
}

export function deleteThread(ctx: Ctx, payload: { threadId: string }, ack: Ack<null>): void {
  if (lockedFor(ctx)) return fail(ack, 'O mestre travou o quadro.');
  const board = ctx.room.state.board;
  const thread = board.threads.find((t) => t.id === payload?.threadId);
  if (!thread) return fail(ack, 'Fio nao encontrado.');
  if (!canRemove(ctx, thread.authorId)) return fail(ack, 'So quem esticou o fio (ou o mestre) pode remove-lo.');
  board.threads = board.threads.filter((t) => t.id !== thread.id);
  ctx.room.touch('board');
  emitToAll(ctx.room, { threads: { remove: [thread.id] } });
  ok(ack, null);
}
