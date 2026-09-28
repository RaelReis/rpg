import {
  extractRollCommand,
  remapSheetImages,
  generateId,
  MAX_CHAT_LENGTH,
  rollFormula,
  type Ack,
  type ChatMessage,
  type ChatSendPayload,
  type MapPing,
  type Role,
  type TurnEntry,
} from '@rpg/shared';

import { sendFullStateToAll, emitPlayers, emitTokenUpsert, emitTurns, socketsOf, type TypedSocket } from '../broadcast.js';
import { prisma } from '../db.js';
import type { Room } from '../room.js';
import { deleteAssetFiles } from '../uploads.js';
import { dropTurnEntries, removeSheet } from './cascade.js';
import { clampNumber, fail, isGm, ok, safeString, type Ctx } from './context.js';

/** Turnos, chat, pings, jogadores e remocao de imagens. */

// ---------------------------------------------------------------------------
// Turnos
// ---------------------------------------------------------------------------

/**
 * As rodadas estao sempre correndo: elas dao o fluxo da mesa — de quem e a vez
 * de agir e de descrever —, e nao marcam combate. Por isso nao existe abrir nem
 * encerrar; o grupo entra na ordem sozinho e a rodada 1 comeca com a mesa.
 *
 * A ordem e a ORDEM DA LISTA, e quem a define e o mestre arrastando as
 * miniaturas. Nao ha valor rolado: iniciativa por d20 e regra de um sistema
 * especifico, enquanto arrastar serve a qualquer mesa — inclusive quando a
 * ordem muda no meio, que era impossivel de representar com um numero fixo por
 * participante.
 */

const MAX_ENTRIES = 60;
const MAX_HISTORY = 120;

function sanitizeEntry(raw: Partial<TurnEntry>): TurnEntry {
  return {
    id: safeString(raw?.id, 40) || generateId('trn'),
    tokenId: typeof raw?.tokenId === 'string' ? raw.tokenId : null,
    sheetId: typeof raw?.sheetId === 'string' ? raw.sheetId : null,
    playerId: typeof raw?.playerId === 'string' ? raw.playerId : null,
    name: safeString(raw?.name, 60, 'Participante'),
    skipped: Boolean(raw?.skipped),
    hiddenFromPlayers: Boolean(raw?.hiddenFromPlayers),
  };
}

function pushTurns(ctx: Ctx): void {
  ctx.room.touch('table');
  emitTurns(ctx.room);
}

/**
 * Garante que todo personagem de jogador esteja na ordem.
 *
 * Chamado quando alguem entra na mesa: o personagem dele ja nasce na ordem, e
 * mesas gravadas antes desta versao — que nao tinham ordem nenhuma — se
 * preenchem sozinhas na primeira conexao. Devolve `true` se mudou algo.
 */
export function ensurePartyInTurns(room: Room): boolean {
  const scene = room.activeScene();
  if (!scene) return false;

  const turns = room.state.turns;
  const known = new Set(turns.entries.map((e) => e.sheetId ?? e.tokenId));
  let added = false;

  for (const token of scene.tokens) {
    if (token.layer !== 3 || token.ownerPlayerId === null) continue;
    // So quem ainda e jogador da mesa: um token com dono que saiu (ou que
    // virou mestre) recriava a vez de alguem que nao esta mais jogando.
    if (room.player(token.ownerPlayerId)?.role !== 'PLAYER') continue;
    if (turns.entries.length >= MAX_ENTRIES) break;

    const sheet = room.sheet(token.sheetId);
    if (known.has(sheet?.id ?? token.id)) continue;

    turns.entries.push(
      sanitizeEntry({
        tokenId: token.id,
        sheetId: sheet?.id ?? null,
        playerId: token.ownerPlayerId,
        name: sheet?.name ?? token.name,
      }),
    );
    known.add(sheet?.id ?? token.id);
    added = true;
  }

  if (added && !turns.activeEntryId) {
    turns.activeEntryId = turns.entries.find((e) => !e.skipped)?.id ?? null;
  }
  if (added) room.touch('table');
  return added;
}

export function addTurnEntries(
  ctx: Ctx,
  payload: { entries: Partial<TurnEntry>[] },
  ack: Ack<null>,
): void {
  const turns = ctx.room.state.turns;
  const incoming = Array.isArray(payload?.entries) ? payload.entries.slice(0, MAX_ENTRIES) : [];
  if (incoming.length === 0) return fail(ack, 'Nada para adicionar a ordem.');

  const tokens = new Set(turns.entries.map((e) => e.tokenId).filter(Boolean));
  const sheets = new Set(turns.entries.map((e) => e.sheetId).filter(Boolean));
  let added = 0;

  for (const raw of incoming) {
    if (turns.entries.length >= MAX_ENTRIES) break;
    const entry = sanitizeEntry(raw);

    // O mesmo personagem entra uma vez so, venha pelo token ou pela ficha.
    if (entry.tokenId && tokens.has(entry.tokenId)) continue;
    if (entry.sheetId && sheets.has(entry.sheetId)) continue;

    turns.entries.push(entry);
    if (entry.tokenId) tokens.add(entry.tokenId);
    if (entry.sheetId) sheets.add(entry.sheetId);
    added++;
  }

  if (added === 0) return fail(ack, 'Esses personagens ja estao na ordem.');
  pushTurns(ctx);
  ok(ack, null);
}

export function removeTurnEntry(ctx: Ctx, payload: { entryId: string }, ack: Ack<null>): void {
  const turns = ctx.room.state.turns;
  const index = turns.entries.findIndex((e) => e.id === payload?.entryId);
  if (index === -1) return fail(ack, 'Participante nao encontrado.');

  const wasActive = turns.activeEntryId === payload.entryId;
  turns.entries.splice(index, 1);

  // Tirando quem estava jogando, a vez passa para quem ficou naquela posicao.
  if (wasActive) {
    turns.activeEntryId = turns.entries[Math.min(index, turns.entries.length - 1)]?.id ?? null;
  }

  pushTurns(ctx);
  ok(ack, null);
}

/** Nova ordem completa, como o mestre deixou as miniaturas. */
export function reorderTurns(ctx: Ctx, payload: { entryIds: string[] }, ack: Ack<null>): void {
  const turns = ctx.room.state.turns;
  const ids = Array.isArray(payload?.entryIds) ? payload.entryIds : [];
  if (ids.length === 0) return fail(ack, 'Ordem vazia.');

  const byId = new Map(turns.entries.map((e) => [e.id, e]));
  const ordered: TurnEntry[] = [];
  const used = new Set<string>();

  for (const id of ids) {
    const entry = typeof id === 'string' ? byId.get(id) : undefined;
    if (!entry || used.has(entry.id)) continue;
    ordered.push(entry);
    used.add(entry.id);
  }

  // Quem entrou na ordem enquanto o mestre arrastava nao veio na lista dele:
  // vai para o fim em vez de sumir do combate.
  for (const entry of turns.entries) {
    if (!used.has(entry.id)) ordered.push(entry);
  }

  turns.entries = ordered;
  pushTurns(ctx);
  ok(ack, null);
}

export function updateTurnEntry(
  ctx: Ctx,
  payload: { entryId: string; patch: Partial<TurnEntry> },
  ack: Ack<null>,
): void {
  const turns = ctx.room.state.turns;
  const entry = turns.entries.find((e) => e.id === payload?.entryId);
  if (!entry) return fail(ack, 'Participante nao encontrado.');

  const p = payload.patch ?? {};
  if (p.name !== undefined) entry.name = safeString(p.name, 60, entry.name);
  if (p.skipped !== undefined) entry.skipped = Boolean(p.skipped);
  if (p.hiddenFromPlayers !== undefined) entry.hiddenFromPlayers = Boolean(p.hiddenFromPlayers);

  // Pular quem esta jogando passaria a vez para um participante fora da ordem.
  if (entry.skipped && turns.activeEntryId === entry.id) {
    turns.activeEntryId = turns.entries.find((e) => !e.skipped)?.id ?? null;
  }

  pushTurns(ctx);
  ok(ack, null);
}

/** Passa a vez direto para uma miniatura, sem percorrer a ordem. */
export function setActiveTurn(ctx: Ctx, payload: { entryId: string }, ack: Ack<null>): void {
  const turns = ctx.room.state.turns;
  const entry = turns.entries.find((e) => e.id === payload?.entryId);
  if (!entry) return fail(ack, 'Participante nao encontrado.');

  turns.activeEntryId = entry.id;
  pushTurns(ctx);
  ok(ack, null);
}

function advance(ctx: Ctx, direction: 1 | -1): void {
  const turns = ctx.room.state.turns;
  const playable = turns.entries.filter((e) => !e.skipped);
  if (playable.length === 0) return;

  const current = playable.findIndex((e) => e.id === turns.activeEntryId);
  const finishing = current >= 0 ? playable[current] : null;
  const roundPlayed = turns.round;
  let next = current + direction;

  if (next >= playable.length) {
    next = 0;
    turns.round += 1;
  } else if (next < 0) {
    next = playable.length - 1;
    turns.round = Math.max(1, turns.round - 1);
  }

  if (direction === 1 && finishing) {
    turns.history.push({
      round: roundPlayed,
      entryId: finishing.id,
      name: finishing.name,
      at: Date.now(),
    });
    if (turns.history.length > MAX_HISTORY) {
      turns.history = turns.history.slice(-MAX_HISTORY);
    }
  } else if (direction === -1) {
    // Voltar o turno desfaz o registro: o historico conta o que aconteceu, e
    // essa vez nao aconteceu.
    turns.history.pop();
  }

  turns.activeEntryId = playable[next].id;
  pushTurns(ctx);
}

export function nextTurn(ctx: Ctx, ack: Ack<null>): void {
  advance(ctx, 1);
  ok(ack, null);
}

export function previousTurn(ctx: Ctx, ack: Ack<null>): void {
  advance(ctx, -1);
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export function sendChat(ctx: Ctx, payload: ChatSendPayload, ack: Ack<null>): void {
  const text = safeString(payload?.text, MAX_CHAT_LENGTH).trim();
  if (!text) return fail(ack, 'Mensagem vazia.');

  const player = ctx.room.player(ctx.viewer.playerId);
  if (!player) return fail(ack, 'Jogador nao encontrado.');

  const command = ctx.room.state.settings.diceEnabled ? extractRollCommand(text) : null;
  const roll = command ? rollFormula(command) : null;
  if (command && !roll) return fail(ack, `Nao entendi a rolagem "${command}".`);

  publishChat(ctx, {
    playerId: player.id,
    authorName: player.name,
    authorColor: player.color,
    text: roll ? '' : text,
    roll,
    rollLabel: null,
    whisper: Boolean(payload?.whisper),
  });
  ok(ack, null);
}

/** Monta a mensagem, guarda no historico e entrega a quem tem direito. */
export function publishChat(
  ctx: Ctx,
  parts: Omit<ChatMessage, 'id' | 'createdAt'>,
): ChatMessage {
  const message: ChatMessage = { ...parts, id: generateId('msg'), createdAt: Date.now() };
  ctx.room.appendChat(message);

  // Sussurro e uma conversa reservada entre o jogador e o mestre.
  for (const socket of socketsOf(ctx.room)) {
    const viewer = socket.data.viewer;
    if (message.whisper && viewer.role !== 'GM' && viewer.playerId !== message.playerId) continue;
    socket.emit('chat:message', message);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Pings e cursores
// ---------------------------------------------------------------------------

export function pingMap(ctx: Ctx, payload: Omit<MapPing, 'playerName' | 'color'>): void {
  const player = ctx.room.player(ctx.viewer.playerId);
  if (!player) return;

  const scene = ctx.room.scene(payload?.sceneId);
  if (!scene) return;

  const ping: MapPing = {
    sceneId: scene.id,
    x: clampNumber(payload.x, -30000, 30000, 0),
    y: clampNumber(payload.y, -30000, 30000, 0),
    color: player.color,
    playerName: player.name,
    // Puxar a camera dos outros e prerrogativa do mestre.
    focus: isGm(ctx) && Boolean(payload.focus),
  };

  for (const socket of socketsOf(ctx.room)) {
    if (socket.data.viewer.role !== 'GM' && scene.id !== ctx.room.state.activeSceneId) continue;
    socket.emit('map:ping', ping);
  }
}

// ---------------------------------------------------------------------------
// Jogadores
// ---------------------------------------------------------------------------

export function updatePlayer(ctx: Ctx, patch: { name?: string; color?: string }, ack: Ack<null>): void {
  const player = ctx.room.player(ctx.viewer.playerId);
  if (!player) return fail(ack, 'Jogador nao encontrado.');

  if (patch?.name !== undefined) {
    const name = safeString(patch.name, 40).trim();
    if (name) player.name = name;
  }
  if (patch?.color !== undefined && /^#[0-9a-f]{6}$/i.test(patch.color)) {
    player.color = patch.color;
  }

  ctx.room.touchPlayer(player.id);
  emitPlayers(ctx.room);
  ok(ack, null);
}

export async function kickPlayer(ctx: Ctx, payload: { playerId: string }, ack: Ack<null>): Promise<void> {
  const target = ctx.room.player(payload?.playerId);
  if (!target) return fail(ack, 'Jogador nao encontrado.');
  if (target.id === ctx.viewer.playerId) return fail(ack, 'Voce nao pode se remover da mesa.');

  ctx.room.state.players = ctx.room.state.players.filter((p) => p.id !== target.id);
  ctx.room.removePlayerRecord(target.id);

  /*
   * Quem sai da mesa leva o personagem junto: a ficha, os tokens dela e a vez
   * na ordem. Antes a ficha virava NPC, o token ficava com um dono que nao
   * existe e a vez continuava na ordem — e o token com dono fantasma fazia
   * `ensurePartyInTurns` recriar a vez depois. Para manter o personagem como
   * NPC, o mestre troca o dono da ficha antes de remover (a confirmacao diz).
   */
  for (const sheet of ctx.room.state.sheets.filter((s) => s.ownerPlayerId === target.id)) {
    removeSheet(ctx.room, sheet.id);
  }

  // Tokens dele sem ficha (um familiar, um aliado) ficam no mapa, sem dono.
  for (const scene of ctx.room.state.scenes) {
    for (const token of scene.tokens) {
      if (token.ownerPlayerId !== target.id) continue;
      token.ownerPlayerId = null;
      ctx.room.touchScene(scene.id);
      emitTokenUpsert(ctx.room, scene, token);
    }
  }

  if (dropTurnEntries(ctx.room, (e) => e.playerId === target.id)) emitTurns(ctx.room);

  for (const socket of socketsOf(ctx.room)) {
    if (socket.data.viewer.playerId === target.id) {
      socket.emit('session:ended', { reason: 'Voce foi removido da mesa pelo mestre.' });
      socket.disconnect(true);
    }
  }

  emitPlayers(ctx.room);
  ok(ack, null);
}

export async function promotePlayer(
  ctx: Ctx,
  payload: { playerId: string; role: Role },
  ack: Ack<null>,
): Promise<void> {
  const target = ctx.room.player(payload?.playerId);
  if (!target) return fail(ack, 'Jogador nao encontrado.');

  const role: Role = payload.role === 'GM' ? 'GM' : 'PLAYER';
  if (target.id === ctx.viewer.playerId && role === 'PLAYER') {
    const otherGms = ctx.room.state.players.filter((p) => p.role === 'GM' && p.id !== target.id);
    if (otherGms.length === 0) return fail(ack, 'A mesa ficaria sem mestre.');
  }

  target.role = role;
  ctx.room.touchPlayer(target.id);
  await prisma.player.updateMany({ where: { id: target.id }, data: { role } });

  // O papel muda o que a pessoa tem direito de receber: reenviamos tudo.
  for (const socket of socketsOf(ctx.room)) {
    if (socket.data.viewer.playerId === target.id) {
      socket.data.viewer = { playerId: target.id, role };
      const { sendFullState } = await import('../broadcast.js');
      sendFullState(ctx.room, socket as TypedSocket);
    }
  }

  emitPlayers(ctx.room);
  ok(ack, null);
}

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

export async function deleteAsset(ctx: Ctx, payload: { assetId: string }, ack: Ack<null>): Promise<void> {
  const assetId = safeString(payload?.assetId, 64);
  const index = ctx.room.state.assets.findIndex((a) => a.id === assetId);
  if (index === -1) return fail(ack, 'Imagem nao encontrada.');

  await deleteAssetFiles(assetId);
  ctx.room.state.assets = ctx.room.state.assets.filter(a => a.id !== assetId);

  // Quem referenciava a imagem volta para a cor de fallback.
  for (const scene of ctx.room.state.scenes) {
    let touched = false;
    if (scene.backgroundAssetId === assetId) {
      scene.backgroundAssetId = null;
      touched = true;
    }
    for (const token of scene.tokens) {
      if (token.assetId === assetId) {
        token.assetId = null;
        touched = true;
      }
    }
    for (const tile of scene.tiles) {
      if (tile.assetId === assetId) {
        tile.assetId = null;
        touched = true;
      }
    }
    for (const effect of scene.effects) {
      if (effect.assetId === assetId) {
        effect.assetId = null;
        touched = true;
      }
    }
    if (touched) {
      ctx.room.touchScene(scene.id);
      const { pushScene } = await import('../broadcast.js');
      pushScene(ctx.room, scene);
    }
  }

  for (const sheet of ctx.room.state.sheets) {
    if (sheet.portraitAssetId === assetId) sheet.portraitAssetId = null;
    if (sheet.bodyAssetId === assetId) sheet.bodyAssetId = null;
    sheet.values = remapSheetImages(ctx.room.state.sheetTemplate, sheet.values, id => id === assetId ? null : id);
    ctx.room.touchSheet(sheet.id);
  }
  for (const handout of ctx.room.state.handouts) if (handout.assetId === assetId) handout.assetId = null;
  ctx.room.touch('table');
  for (const socket of socketsOf(ctx.room)) socket.emit('assets:patch', { remove: [assetId] });
  sendFullStateToAll(ctx.room);
  ok(ack, null);
}
