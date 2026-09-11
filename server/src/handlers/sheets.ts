import {
  createSheetValues,
  filterTemplateForRole,
  generateId,
  normalizeTemplate,
  reconcileSheetValues,
  resolveFormulaRefs,
  rollFormula,
  sanitizeSheetPatch,
  type Ack,
  type FieldType,
  type FieldValue,
  type Sheet,
  type SheetField,
  type SheetSection,
  type SheetTemplate,
} from '@rpg/shared';

import { emitPlayers, emitTokenUpsert, socketsOf, syncAssets } from '../broadcast.js';
import { prisma, toJson } from '../db.js';
import { atCapacity, LIMIT_MESSAGES } from '../limits.js';
import { assetIdsOfSheet, sheetForViewer } from '../filter.js';
import { spawnCharacterToken, syncCharacterOwner } from './characters.js';
import { publishChat } from './play.js';
import type { Room } from '../room.js';
import { clampNumber, fail, isGm, ok, ownedAsset, safeString, type Ctx } from './context.js';

/**
 * Template de ficha e fichas.
 *
 * O template e o schema que o mestre monta; as fichas sao instancias dele. Ao
 * mudar o schema com fichas ja em uso, os valores sao reconciliados em vez de
 * descartados: campos novos ganham o default, removidos somem e o que continua
 * compativel e preservado.
 */

/** Envia uma ficha a cada socket na versao que ele pode ver. */
function emitSheet(room: Room, sheet: Sheet): void {
  for (const socket of socketsOf(room)) {
    const visible = sheetForViewer(room, sheet, socket.data.viewer);
    if (visible) {
      syncAssets(room, socket, assetIdsOfSheet(visible));
      socket.emit('sheets:patch', { upsert: [visible] });
    }
    else socket.emit('sheets:patch', { remove: [sheet.id] });
  }
}

export function updateTemplate(ctx: Ctx, raw: SheetTemplate, ack: Ack<null>): void {
  const template = normalizeTemplate(raw);
  ctx.room.state.sheetTemplate = template;

  for (const sheet of ctx.room.state.sheets) {
    sheet.values = reconcileSheetValues(template, sheet.values);
    sheet.updatedAt = Date.now();
  }

  ctx.room.touch('table');
  ctx.room.touch('sheets');

  for (const socket of socketsOf(ctx.room)) {
    const viewer = socket.data.viewer;
    socket.emit('template:patch', filterTemplateForRole(template, viewer.role));

    const sheets = ctx.room.state.sheets
      .map((s) => sheetForViewer(ctx.room, s, viewer))
      .filter((s): s is Sheet => s !== null);
    syncAssets(ctx.room, socket, sheets.flatMap(assetIdsOfSheet));
    socket.emit('sheets:patch', { upsert: sheets });
  }
  ok(ack, null);
}

export async function createSheet(
  ctx: Ctx,
  payload: { name: string; ownerPlayerId?: string | null },
  ack: Ack<Sheet>,
): Promise<void> {
  if (atCapacity(ctx.room.state.sheets, 'sheets')) return fail(ack, LIMIT_MESSAGES.sheets);

  const sheet: Sheet = {
    id: generateId('sht'),
    name: safeString(payload?.name, 60, 'Nova ficha') || 'Nova ficha',
    portraitAssetId: null,
    ownerPlayerId: payload?.ownerPlayerId ?? null,
    values: createSheetValues(ctx.room.state.sheetTemplate),
    sharedWithParty: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    await prisma.sheet.create({
      data: {
        id: sheet.id,
        tableId: ctx.room.state.id,
        name: sheet.name,
        ownerPlayerId: sheet.ownerPlayerId,
        portraitAssetId: null,
        values: toJson(sheet.values),
        sharedWithParty: false,
      },
    });
  } catch {
    return fail(ack, 'Nao foi possivel criar a ficha.');
  }

  ctx.room.state.sheets.push(sheet);
  ctx.room.touchSheet(sheet.id);
  emitSheet(ctx.room, sheet);
  spawnCharacterToken(ctx.room, sheet);
  ok(ack, sheet);
}

/**
 * Retrato novo na ficha: o token do personagem e a lista de presenca seguem.
 *
 * So troca a arte do token que usava o retrato antigo (ou nenhuma arte). Se o
 * mestre escolheu outra imagem de proposito para o token, ela fica.
 */
function portraitChanged(ctx: Ctx, sheet: Sheet, previous: string | null): void {
  for (const scene of ctx.room.state.scenes) {
    for (const token of scene.tokens) {
      if (token.sheetId !== sheet.id) continue;
      if (token.assetId !== previous && token.assetId !== null) continue;
      token.assetId = sheet.portraitAssetId;
      ctx.room.touchScene(scene.id);
      emitTokenUpsert(ctx.room, scene, token);
    }
  }
  emitPlayers(ctx.room);
}

export function updateSheet(
  ctx: Ctx,
  payload: {
    sheetId: string;
    values?: Record<string, FieldValue>;
    name?: string;
    portraitAssetId?: string | null;
    sharedWithParty?: boolean;
  },
  ack: Ack<null>,
): void {
  const sheet = ctx.room.sheet(payload?.sheetId);
  if (!sheet) return fail(ack, 'Ficha nao encontrada.');

  const gm = isGm(ctx);
  const isOwner = sheet.ownerPlayerId === ctx.viewer.playerId;
  if (!gm && !isOwner) return fail(ack, 'Voce nao pode editar esta ficha.');

  if (payload.values && typeof payload.values === 'object') {
    // O patch e filtrado campo a campo: o cliente pode mandar qualquer coisa,
    // mas campos travados ou exclusivos do mestre sao descartados aqui.
    const safe = sanitizeSheetPatch(ctx.room.state.sheetTemplate, payload.values, ctx.viewer.role, isOwner);
    Object.assign(sheet.values, safe);
  }

  if (payload.name !== undefined && (gm || isOwner)) {
    sheet.name = safeString(payload.name, 60, sheet.name);
  }
  if (payload.portraitAssetId !== undefined && (gm || isOwner)) {
    const previous = sheet.portraitAssetId;
    sheet.portraitAssetId = ownedAsset(ctx, payload.portraitAssetId);
    if (sheet.portraitAssetId !== previous) portraitChanged(ctx, sheet, previous);
  }
  if (payload.sharedWithParty !== undefined && (gm || isOwner)) {
    sheet.sharedWithParty = Boolean(payload.sharedWithParty);
  }

  sheet.updatedAt = Date.now();
  ctx.room.touchSheet(sheet.id);
  emitSheet(ctx.room, sheet);
  ok(ack, null);
}

export function deleteSheet(ctx: Ctx, payload: { sheetId: string }, ack: Ack<null>): void {
  const index = ctx.room.state.sheets.findIndex((s) => s.id === payload?.sheetId);
  if (index === -1) return fail(ack, 'Ficha nao encontrada.');

  const [removed] = ctx.room.state.sheets.splice(index, 1);
  ctx.room.removeSheetRecord(removed.id);

  // Desfaz os vinculos para nao deixar tokens e jogadores apontando para o vazio.
  for (const scene of ctx.room.state.scenes) {
    for (const token of scene.tokens) {
      if (token.sheetId === removed.id) {
        token.sheetId = null;
        ctx.room.touchScene(scene.id);
      }
    }
  }
  for (const player of ctx.room.state.players) {
    if (player.sheetId === removed.id) {
      player.sheetId = null;
      ctx.room.touchPlayer(player.id);
    }
  }

  for (const socket of socketsOf(ctx.room)) socket.emit('sheets:patch', { remove: [removed.id] });
  ok(ack, null);
}

/**
 * Rola a formula de um campo da ficha.
 *
 * A resolucao das referencias e o lancamento acontecem aqui, e nao no
 * navegador: uma rolagem decidida no cliente seria so uma sugestao. O
 * resultado entra no chat com o rotulo do campo, para a mesa saber o que
 * foi testado.
 */
export function rollSheetField(
  ctx: Ctx,
  payload: { sheetId: string; fieldId: string; whisper?: boolean },
  ack: Ack<null>,
): void {
  if (!ctx.room.state.settings.diceEnabled) {
    return fail(ack, 'A rolagem de dados esta desativada nesta mesa.');
  }

  const sheet = ctx.room.sheet(payload?.sheetId);
  if (!sheet) return fail(ack, 'Ficha nao encontrada.');

  const gm = isGm(ctx);
  const isOwner = sheet.ownerPlayerId === ctx.viewer.playerId;
  if (!gm && !isOwner && !sheet.sharedWithParty) {
    return fail(ack, 'Voce nao tem acesso a esta ficha.');
  }

  const field = ctx.room.state.sheetTemplate.fields.find((f) => f.id === payload?.fieldId);
  if (!field) return fail(ack, 'Campo nao encontrado.');
  if (!gm && field.gmOnly) return fail(ack, 'Campo indisponivel.');
  if (!field.rollFormula.trim()) return fail(ack, 'Este campo nao tem formula de rolagem.');

  const roll = rollFormula(resolveFormulaRefs(field.rollFormula, sheet.values));
  if (!roll) return fail(ack, `Nao entendi a formula "${field.rollFormula}".`);

  const player = ctx.room.player(ctx.viewer.playerId);
  publishChat(ctx, {
    playerId: player?.id ?? null,
    authorName: player?.name ?? 'Mesa',
    authorColor: player?.color ?? '#d9a441',
    text: '',
    roll,
    rollLabel: `${sheet.name} · ${field.label}`,
    whisper: Boolean(payload?.whisper),
  });
  ok(ack, null);
}

export function assignSheet(
  ctx: Ctx,
  payload: { sheetId: string; playerId: string | null },
  ack: Ack<null>,
): void {
  const sheet = ctx.room.sheet(payload?.sheetId);
  if (!sheet) return fail(ack, 'Ficha nao encontrada.');

  const playerId = payload.playerId;
  if (playerId && !ctx.room.player(playerId)) return fail(ack, 'Jogador nao encontrado.');

  const previousOwner = ctx.room.player(sheet.ownerPlayerId);
  if (previousOwner && previousOwner.sheetId === sheet.id) previousOwner.sheetId = null;

  sheet.ownerPlayerId = playerId;
  sheet.updatedAt = Date.now();

  const owner = ctx.room.player(playerId);
  if (owner) owner.sheetId = sheet.id;

  ctx.room.touchSheet(sheet.id);
  if (previousOwner) ctx.room.touchPlayer(previousOwner.id);
  if (owner) ctx.room.touchPlayer(owner.id);
  emitSheet(ctx.room, sheet);
  syncCharacterOwner(ctx.room, sheet);
  emitPlayers(ctx.room);
  ok(ack, null);
}

export { clampNumber };
