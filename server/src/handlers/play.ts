import {
  extractRollCommand,
  generateId,
  MAX_CHAT_LENGTH,
  rollFormula,
  type Ack,
  type ChatMessage,
  type ChatSendPayload,
  type InitiativeEntry,
  type InitiativeState,
  type MapPing,
  type Role,
} from '@rpg/shared';

import { emitInitiative, emitPlayers, socketsOf, type TypedSocket } from '../broadcast.js';
import { prisma } from '../db.js';
import { deleteAssetFiles } from '../uploads.js';
import { clampNumber, fail, isGm, ok, safeString, type Ctx } from './context.js';

/** Iniciativa, chat, pings, jogadores e remocao de imagens. */

// ---------------------------------------------------------------------------
// Iniciativa
// ---------------------------------------------------------------------------

/** Maior valor primeiro; empate resolvido pelo desempate manual. */
function sortEntries(entries: InitiativeEntry[]): InitiativeEntry[] {
  return [...entries].sort((a, b) => b.value - a.value || b.tiebreak - a.tiebreak);
}

function sanitizeEntry(raw: Partial<InitiativeEntry>): InitiativeEntry {
  return {
    id: safeString(raw?.id, 40) || generateId('ini'),
    tokenId: raw?.tokenId ?? null,
    name: safeString(raw?.name, 60, 'Participante'),
    value: clampNumber(raw?.value, -999, 999, 0),
    tiebreak: clampNumber(raw?.tiebreak, -999, 999, 0),
    playerId: raw?.playerId ?? null,
    skipped: Boolean(raw?.skipped),
    hiddenFromPlayers: Boolean(raw?.hiddenFromPlayers),
  };
}

export function updateInitiative(ctx: Ctx, patch: Partial<InitiativeState>, ack: Ack<null>): void {
  const init = ctx.room.state.initiative;

  if (patch?.entries !== undefined && Array.isArray(patch.entries)) {
    init.entries = sortEntries(patch.entries.slice(0, 100).map(sanitizeEntry));
  }
  if (patch?.active !== undefined) {
    init.active = Boolean(patch.active);
    if (init.active && init.round === 0) init.round = 1;
    if (init.active && !init.activeEntryId) init.activeEntryId = init.entries[0]?.id ?? null;
    if (!init.active) {
      init.round = 0;
      init.activeEntryId = null;
    }
  }
  if (patch?.round !== undefined) init.round = clampNumber(patch.round, 0, 9999, init.round);
  if (patch?.autoAdvance !== undefined) init.autoAdvance = Boolean(patch.autoAdvance);
  if (patch?.turnSeconds !== undefined) init.turnSeconds = clampNumber(patch.turnSeconds, 0, 3600, init.turnSeconds);
  if (patch?.activeEntryId !== undefined) {
    const exists = init.entries.some((e) => e.id === patch.activeEntryId);
    init.activeEntryId = exists ? patch.activeEntryId : init.activeEntryId;
  }

  ctx.room.touch('table');
  emitInitiative(ctx.room);
  ok(ack, null);
}

export function addInitiativeEntry(ctx: Ctx, payload: { entry: Partial<InitiativeEntry> }, ack: Ack<null>): void {
  const init = ctx.room.state.initiative;
  if (init.entries.length >= 100) return fail(ack, 'Limite de participantes na iniciativa.');

  const entry = sanitizeEntry(payload?.entry ?? {});

  // Um token entra na ordem uma vez so.
  if (entry.tokenId && init.entries.some((e) => e.tokenId === entry.tokenId)) {
    return fail(ack, 'Este token ja esta na iniciativa.');
  }

  init.entries = sortEntries([...init.entries, entry]);
  ctx.room.touch('table');
  emitInitiative(ctx.room);
  ok(ack, null);
}

export function removeInitiativeEntry(ctx: Ctx, payload: { entryId: string }, ack: Ack<null>): void {
  const init = ctx.room.state.initiative;
  const index = init.entries.findIndex((e) => e.id === payload?.entryId);
  if (index === -1) return fail(ack, 'Participante nao encontrado.');

  const wasActive = init.activeEntryId === payload.entryId;
  init.entries.splice(index, 1);

  // Removendo quem estava jogando, o turno passa para o proximo da ordem.
  if (wasActive) {
    init.activeEntryId = init.entries[Math.min(index, init.entries.length - 1)]?.id ?? null;
  }

  ctx.room.touch('table');
  emitInitiative(ctx.room);
  ok(ack, null);
}

function step(ctx: Ctx, direction: 1 | -1): void {
  const init = ctx.room.state.initiative;
  const playable = init.entries.filter((e) => !e.skipped);
  if (playable.length === 0) return;

  const currentIndex = playable.findIndex((e) => e.id === init.activeEntryId);
  let next = currentIndex + direction;

  if (next >= playable.length) {
    next = 0;
    init.round += 1;
  } else if (next < 0) {
    next = playable.length - 1;
    init.round = Math.max(1, init.round - 1);
  }

  init.activeEntryId = playable[next].id;
  ctx.room.touch('table');
  emitInitiative(ctx.room);
}

/**
 * Avanco de turno. O mestre sempre pode; o jogador da vez so quando o mestre
 * habilitou `autoAdvance`, que e o modo "cada um passa o proprio turno".
 */
export function nextTurn(ctx: Ctx, ack: Ack<null>): void {
  const init = ctx.room.state.initiative;
  if (!isGm(ctx)) {
    const active = init.entries.find((e) => e.id === init.activeEntryId);
    const isMyTurn = active?.playerId === ctx.viewer.playerId;
    if (!init.autoAdvance || !isMyTurn) return fail(ack, 'Apenas o mestre avanca o turno.');
  }
  step(ctx, 1);
  ok(ack, null);
}

export function previousTurn(ctx: Ctx, ack: Ack<null>): void {
  step(ctx, -1);
  ok(ack, null);
}

/**
 * Rola iniciativa para todos de uma vez: 1d20 somado ao campo `initiative`
 * da ficha vinculada, quando ele existir. Como o sistema de regras e do
 * mestre, o resultado fica editavel na barra lateral.
 */
export function rollInitiative(ctx: Ctx, ack: Ack<null>): void {
  const init = ctx.room.state.initiative;
  const scene = ctx.room.activeScene();

  init.entries = sortEntries(
    init.entries.map((entry) => {
      const token = scene?.tokens.find((t) => t.id === entry.tokenId);
      const sheet = ctx.room.sheet(token?.sheetId);
      const bonusRaw = sheet?.values['initiative'];
      const bonus = typeof bonusRaw === 'number' ? bonusRaw : 0;
      const roll = rollFormula('1d20');
      return { ...entry, value: (roll?.total ?? 0) + bonus, tiebreak: Math.random() };
    }),
  );

  init.activeEntryId = init.entries.find((e) => !e.skipped)?.id ?? null;
  if (init.active && init.round === 0) init.round = 1;

  ctx.room.touch('table');
  emitInitiative(ctx.room);
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

  const message: ChatMessage = {
    id: generateId('msg'),
    playerId: player.id,
    authorName: player.name,
    authorColor: player.color,
    text: roll ? '' : text,
    roll,
    whisper: Boolean(payload?.whisper),
    createdAt: Date.now(),
  };

  ctx.room.appendChat(message);

  // Sussurro e uma conversa reservada entre o jogador e o mestre.
  for (const socket of socketsOf(ctx.room)) {
    const viewer = socket.data.viewer;
    if (message.whisper && viewer.role !== 'GM' && viewer.playerId !== message.playerId) continue;
    socket.emit('chat:message', message);
  }
  ok(ack, null);
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

export function moveCursor(ctx: Ctx, payload: { sceneId: string; x: number; y: number }): void {
  const player = ctx.room.player(ctx.viewer.playerId);
  if (!player) return;

  const data = {
    sceneId: safeString(payload?.sceneId, 64),
    playerId: player.id,
    name: player.name,
    color: player.color,
    x: clampNumber(payload?.x, -30000, 30000, 0),
    y: clampNumber(payload?.y, -30000, 30000, 0),
  };

  for (const socket of socketsOf(ctx.room)) {
    if (socket.data.viewer.playerId === player.id) continue;
    if (socket.data.currentSceneId !== data.sceneId) continue;
    socket.emit('cursor:moved', data);
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

  ctx.room.touch('players');
  emitPlayers(ctx.room);
  ok(ack, null);
}

export async function kickPlayer(ctx: Ctx, payload: { playerId: string }, ack: Ack<null>): Promise<void> {
  const target = ctx.room.player(payload?.playerId);
  if (!target) return fail(ack, 'Jogador nao encontrado.');
  if (target.id === ctx.viewer.playerId) return fail(ack, 'Voce nao pode se remover da mesa.');

  ctx.room.state.players = ctx.room.state.players.filter((p) => p.id !== target.id);
  ctx.room.removePlayerRecord(target.id);

  // A ficha continua na mesa, agora sem dono: o mestre decide o que fazer com ela.
  for (const sheet of ctx.room.state.sheets) {
    if (sheet.ownerPlayerId === target.id) {
      sheet.ownerPlayerId = null;
      ctx.room.touch('sheets');
    }
  }

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
  ctx.room.touch('players');
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

  ctx.room.state.assets.splice(index, 1);
  await deleteAssetFiles(assetId);

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
    if (sheet.portraitAssetId === assetId) {
      sheet.portraitAssetId = null;
      ctx.room.touch('sheets');
    }
  }

  for (const socket of socketsOf(ctx.room)) socket.emit('assets:patch', { remove: [assetId] });
  ok(ack, null);
}
