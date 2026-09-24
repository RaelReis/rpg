import {
  BOARD_LIMITS,
  canDeleteOnBoard,
  canEditBoard,
  generateId,
  NOTE_COLORS,
  THREAD_COLORS,
  type Ack,
  type BoardItem,
  type BoardItemKind,
  type BoardThread,
} from '@rpg/shared';

import { socketsOf, syncAssets } from '../broadcast.js';
import { boardItemForViewer, handoutForViewer } from '../filter.js';
import type { Room } from '../room.js';
import { clampNumber, fail, ok, ownedAsset, safeString, type Ctx } from './context.js';

/**
 * Quadro de pistas.
 *
 * Todos criam, movem e editam; apagar e do autor e do mestre; travado, so o
 * mestre mexe. As regras moram em shared/board.ts e sao conferidas AQUI — a
 * interface esconde os botoes, mas quem recusa e o servidor.
 *
 * A ultima escrita vence, por item: cada mudanca substitui o item inteiro na
 * tela de todos, na ordem em que chegou ao servidor.
 */

const KINDS: BoardItemKind[] = ['note', 'image', 'handout'];
const EXTENT = BOARD_LIMITS.extent;

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

function refuseLocked(ctx: Ctx): string | null {
  return canEditBoard(ctx.room.state.clueBoard, ctx.viewer.role)
    ? null
    : 'O mestre travou o quadro: por enquanto ele e so de leitura.';
}

// ---------------------------------------------------------------------------
// Emissao
// ---------------------------------------------------------------------------

interface BoardDelta {
  items?: BoardItem[];
  removeItems?: string[];
  threads?: BoardThread[];
  removeThreads?: string[];
  locked?: boolean;
}

/** Envia a mudanca a cada socket, com os cartoes filtrados para quem recebe. */
export function emitBoard(room: Room, delta: BoardDelta): void {
  for (const socket of socketsOf(room)) {
    const upsertItems = delta.items?.map((i) => boardItemForViewer(room, i, socket.data.viewer));
    // As imagens chegam antes dos itens que as usam.
    if (upsertItems?.length) syncAssets(room, socket, upsertItems.map((i) => i.assetId));
    socket.emit('board:patch', {
      upsertItems,
      removeItems: delta.removeItems,
      upsertThreads: delta.threads,
      removeThreads: delta.removeThreads,
      locked: delta.locked,
    });
  }
}

/**
 * O acesso a um material mudou: os cartoes que apontam para ele sao
 * reenviados, e cada um fica completo ou "indisponivel" conforme quem recebe.
 */
export function refreshBoardCards(room: Room, handoutId: string): void {
  const cards = room.state.clueBoard.items.filter((i) => i.kind === 'handout' && i.handoutId === handoutId);
  if (cards.length) emitBoard(room, { items: cards });
}

// ---------------------------------------------------------------------------
// Itens
// ---------------------------------------------------------------------------

export function createBoardItem(
  ctx: Ctx,
  payload: {
    kind: BoardItemKind;
    x: number;
    y: number;
    width?: number;
    height?: number;
    text?: string;
    color?: string;
    assetId?: string | null;
    handoutId?: string | null;
  },
  ack: Ack<BoardItem>,
): void {
  const locked = refuseLocked(ctx);
  if (locked) return fail(ack, locked);

  const board = ctx.room.state.clueBoard;
  if (board.items.length >= BOARD_LIMITS.items) return fail(ack, 'O quadro esta cheio.');
  if (!KINDS.includes(payload?.kind)) return fail(ack, 'Tipo de item invalido.');

  const kind = payload.kind;
  let assetId: string | null = null;
  let handoutId: string | null = null;
  let width = kind === 'note' ? 190 : kind === 'handout' ? 210 : 240;
  let height = kind === 'note' ? 150 : kind === 'handout' ? 160 : 180;

  if (kind === 'image') {
    // O jogador so prega imagens de pista: com qualquer id da mesa ele poderia
    // trazer para o quadro de todos uma arte que o mestre ainda guarda.
    const asset = ctx.room.state.assets.find((a) => a.id === ownedAsset(ctx, payload.assetId));
    if (!asset || (ctx.viewer.role !== 'GM' && asset.kind !== 'clue')) return fail(ack, 'Imagem invalida para o quadro.');
    assetId = asset.id;
    if (asset.width > 0 && asset.height > 0) height = Math.round((width * asset.height) / asset.width);
  }

  if (kind === 'handout') {
    // So se prega o que se tem em maos.
    const handout = ctx.room.state.handouts.find((h) => h.id === payload.handoutId);
    if (!handout || !handoutForViewer(handout, ctx.viewer)) return fail(ack, 'Material nao encontrado.');
    handoutId = handout.id;
  }

  width = clampNumber(payload.width, 60, 1200, width);
  height = clampNumber(payload.height, 40, 1200, height);

  const item: BoardItem = {
    id: generateId('bit'),
    kind,
    x: clampNumber(payload.x, -EXTENT, EXTENT, 0),
    y: clampNumber(payload.y, -EXTENT, EXTENT, 0),
    width,
    height,
    // Papel pregado a mao nunca fica reto.
    rotation: Math.round((Math.random() * 6 - 3) * 10) / 10,
    text: kind === 'note' ? safeString(payload.text, BOARD_LIMITS.text, '') : '',
    color: isHexColor(payload.color) ? payload.color : NOTE_COLORS[0],
    assetId,
    handoutId,
    authorId: ctx.viewer.playerId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  board.items.push(item);
  ctx.room.touch('board');
  emitBoard(ctx.room, { items: [item] });
  ok(ack, item);
}

export function updateBoardItem(
  ctx: Ctx,
  payload: { itemId: string; patch: Partial<BoardItem> },
  ack: Ack<null>,
): void {
  const locked = refuseLocked(ctx);
  if (locked) return fail(ack, locked);

  const item = ctx.room.state.clueBoard.items.find((i) => i.id === payload?.itemId);
  if (!item) return fail(ack, 'Item nao encontrado.');

  const p = payload.patch ?? {};
  if (p.x !== undefined) item.x = clampNumber(p.x, -EXTENT, EXTENT, item.x);
  if (p.y !== undefined) item.y = clampNumber(p.y, -EXTENT, EXTENT, item.y);
  if (p.width !== undefined) item.width = clampNumber(p.width, 60, 1200, item.width);
  if (p.height !== undefined) item.height = clampNumber(p.height, 40, 1200, item.height);
  if (p.rotation !== undefined) item.rotation = clampNumber(p.rotation, -45, 45, item.rotation);
  if (p.text !== undefined && item.kind === 'note') item.text = safeString(p.text, BOARD_LIMITS.text, item.text);
  if (p.color !== undefined && isHexColor(p.color)) item.color = p.color;

  item.updatedAt = Date.now();
  ctx.room.touch('board');
  emitBoard(ctx.room, { items: [item] });
  ok(ack, null);
}

/**
 * Movimento de item. Durante o arraste so as coordenadas circulam, e nada vai
 * para o disco; o evento final grava e manda o item inteiro.
 */
export function moveBoardItem(
  ctx: Ctx,
  payload: { itemId: string; x: number; y: number; dragging?: boolean },
  ack?: Ack<null>,
): void {
  const locked = refuseLocked(ctx);
  if (locked) return fail(ack, locked);

  const item = ctx.room.state.clueBoard.items.find((i) => i.id === payload?.itemId);
  if (!item) return fail(ack, 'Item nao encontrado.');

  item.x = clampNumber(payload.x, -EXTENT, EXTENT, item.x);
  item.y = clampNumber(payload.y, -EXTENT, EXTENT, item.y);

  if (payload.dragging) {
    // Quem arrasta ja ve o item na mao; os outros so precisam da posicao.
    for (const socket of socketsOf(ctx.room)) {
      if (socket.id === ctx.socket.id) continue;
      socket.emit('board:item-moved', { itemId: item.id, x: item.x, y: item.y });
    }
    return ok(ack, null);
  }

  item.updatedAt = Date.now();
  ctx.room.touch('board');
  emitBoard(ctx.room, { items: [item] });
  ok(ack, null);
}

export function deleteBoardItem(ctx: Ctx, payload: { itemId: string }, ack: Ack<null>): void {
  const board = ctx.room.state.clueBoard;
  const item = board.items.find((i) => i.id === payload?.itemId);
  if (!item) return fail(ack, 'Item nao encontrado.');
  if (!canDeleteOnBoard(board, item, ctx.viewer.role, ctx.viewer.playerId)) {
    return fail(ack, board.locked ? 'O quadro esta travado.' : 'So quem pregou (ou o mestre) pode tirar isto do quadro.');
  }

  board.items = board.items.filter((i) => i.id !== item.id);
  // Fio sem uma das pontas nao liga nada.
  const loose = board.threads.filter((t) => t.fromId === item.id || t.toId === item.id).map((t) => t.id);
  board.threads = board.threads.filter((t) => !loose.includes(t.id));

  ctx.room.touch('board');
  emitBoard(ctx.room, { removeItems: [item.id], removeThreads: loose });
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Fios
// ---------------------------------------------------------------------------

export function createBoardThread(
  ctx: Ctx,
  payload: { fromId: string; toId: string; color: string },
  ack: Ack<BoardThread>,
): void {
  const locked = refuseLocked(ctx);
  if (locked) return fail(ack, locked);

  const board = ctx.room.state.clueBoard;
  if (board.threads.length >= BOARD_LIMITS.threads) return fail(ack, 'Fios demais no quadro.');
  const { fromId, toId } = payload ?? ({} as typeof payload);
  if (fromId === toId) return fail(ack, 'Um fio liga dois itens diferentes.');
  if (!board.items.some((i) => i.id === fromId) || !board.items.some((i) => i.id === toId)) {
    return fail(ack, 'Item nao encontrado.');
  }
  const duplicate = board.threads.some(
    (t) => (t.fromId === fromId && t.toId === toId) || (t.fromId === toId && t.toId === fromId),
  );
  if (duplicate) return fail(ack, 'Esses dois itens ja estao ligados.');

  const thread: BoardThread = {
    id: generateId('thr'),
    fromId,
    toId,
    color: isHexColor(payload.color) ? payload.color : THREAD_COLORS[0],
    authorId: ctx.viewer.playerId,
  };
  board.threads.push(thread);
  ctx.room.touch('board');
  emitBoard(ctx.room, { threads: [thread] });
  ok(ack, thread);
}

export function deleteBoardThread(ctx: Ctx, payload: { threadId: string }, ack: Ack<null>): void {
  const board = ctx.room.state.clueBoard;
  const thread = board.threads.find((t) => t.id === payload?.threadId);
  if (!thread) return fail(ack, 'Fio nao encontrado.');
  if (!canDeleteOnBoard(board, thread, ctx.viewer.role, ctx.viewer.playerId)) {
    return fail(ack, board.locked ? 'O quadro esta travado.' : 'So quem ligou (ou o mestre) pode cortar este fio.');
  }

  board.threads = board.threads.filter((t) => t.id !== thread.id);
  ctx.room.touch('board');
  emitBoard(ctx.room, { removeThreads: [thread.id] });
  ok(ack, null);
}

export function lockBoard(ctx: Ctx, payload: { locked: boolean }, ack: Ack<null>): void {
  ctx.room.state.clueBoard.locked = Boolean(payload?.locked);
  ctx.room.touch('board');
  emitBoard(ctx.room, { locked: ctx.room.state.clueBoard.locked });
  ok(ack, null);
}

