import {
  createSheetValues,
  canEditField,
  isResourceValue,
  type SheetOperation,
  filterTemplateForRole,
  generateId,
  normalizeTemplate,
  reconcileSheetValues,
  remapSheetImages,
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

import { sendFullStateToAll, emitPlayers, emitTokenUpsert, emitTurns, notify, socketsOf, syncAssets } from '../broadcast.js';
import { prisma, toJson } from '../db.js';
import { atCapacity, LIMIT_MESSAGES } from '../limits.js';
import { assetIdsOfSheet, sheetForViewer } from '../filter.js';
import { removeSheet } from './cascade.js';
import { applyCharacterArt, spawnCharacterToken, syncCharacterOwner } from './characters.js';
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
export function emitSheet(room: Room, sheet: Sheet): void {
  for (const socket of socketsOf(room)) {
    const visible = sheetForViewer(room, sheet, socket.data.viewer);
    if (visible) {
      syncAssets(room, socket, assetIdsOfSheet(visible, room.state.sheetTemplate));
      socket.emit('sheets:patch', { upsert: [visible] });
    }
    else socket.emit('sheets:patch', { remove: [sheet.id] });
  }
}

export function updateTemplate(ctx: Ctx, raw: SheetTemplate, ack: Ack<true>): void {
  const template = normalizeTemplate(raw);
  ctx.room.state.sheetTemplate = template;

  for (const sheet of ctx.room.state.sheets) {
    sheet.values = reconcileSheetValues(template, sheet.values);
    sheet.updatedAt = Date.now();
  }

  ctx.room.touch('table');
  ctx.room.touch('sheets');

  for (const scene of ctx.room.state.scenes) {
    for (const token of scene.tokens) {
      token.bars = token.bars.filter(b => template.fields.some(f => f.id === b.fieldId && !f.gmOnly && f.type === 'resource'));
    }
    ctx.room.touchScene(scene.id);
  }
  sendFullStateToAll(ctx.room);
  // `null` seria ambiguo aqui: e o mesmo valor que `act()` devolve numa
  // falha, entao quem chama nunca saberia distinguir "salvou" de "nao salvou"
  // so olhando o retorno. Isso deixava o modal do editor de ficha sem fechar
  // depois de salvar, mesmo quando o modelo ja tinha ido para a mesa.
  ok(ack, true);
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
    bodyAssetId: null,
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
        bodyAssetId: null,
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
  const token = spawnCharacterToken(ctx.room, sheet);
  if (token?.visibility === 'hidden') {
    notify(ctx.socket, 'info', `${sheet.name} entrou oculto: ha jogadores na mesa. Revele o token quando for a hora.`);
  }
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
    bodyAssetId?: string | null;
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
    const linked = remapSheetImages(ctx.room.state.sheetTemplate, safe, id => ownedAsset(ctx, id));
    Object.assign(sheet.values, linked);
  }

  if (payload.name !== undefined && (gm || isOwner)) {
    const previous = sheet.name;
    sheet.name = safeString(payload.name, 60, sheet.name);
    if (sheet.name !== previous) renameLinked(ctx.room, sheet.id, previous, sheet.name);
  }
  if (payload.portraitAssetId !== undefined && (gm || isOwner)) {
    const previous = sheet.portraitAssetId;
    sheet.portraitAssetId = ownedAsset(ctx, payload.portraitAssetId);
    if (sheet.portraitAssetId !== previous) portraitChanged(ctx, sheet, previous);
  }
  if (payload.bodyAssetId !== undefined && (gm || isOwner)) {
    const previous = sheet.bodyAssetId;
    sheet.bodyAssetId = ownedAsset(ctx, payload.bodyAssetId);
    // A imagem de corpo E a arte do token: trocar uma troca a outra.
    if (sheet.bodyAssetId !== previous) applyCharacterArt(ctx.room, sheet);
  }
  if (payload.sharedWithParty !== undefined && (gm || isOwner)) {
    sheet.sharedWithParty = Boolean(payload.sharedWithParty);
  }

  sheet.updatedAt = Date.now();
  ctx.room.touchSheet(sheet.id);
  emitSheet(ctx.room, sheet);
  ok(ack, null);
}

/**
 * O token e a vez da ficha seguem o nome dela. A ficha "Nova ficha" virava
 * "Guarda", e o mapa e a ordem continuavam dizendo "Nova ficha". So troca o
 * que ainda tinha o nome antigo: um token renomeado a parte fica como esta.
 */
function renameLinked(room: Room, sheetId: string, from: string, to: string): void {
  for (const scene of room.state.scenes) {
    for (const token of scene.tokens) {
      if (token.sheetId !== sheetId || token.name !== from) continue;
      token.name = to;
      room.touchScene(scene.id);
      emitTokenUpsert(room, scene, token);
    }
  }
  let turnsChanged = false;
  for (const entry of room.state.turns.entries) {
    if (entry.sheetId === sheetId && entry.name === from) {
      entry.name = to;
      turnsChanged = true;
    }
  }
  if (turnsChanged) {
    room.touch('table');
    emitTurns(room);
  }
}

/**
 * Apaga a ficha com os tokens dela e a vez na ordem (ver `removeSheet`).
 * Antes o token ficava no mapa sem ficha e a vez continuava na ordem; para
 * manter a peca, o mestre desliga a ficha do token antes de apagar.
 */
export function deleteSheet(ctx: Ctx, payload: { sheetId: string }, ack: Ack<null>): void {
  if (!removeSheet(ctx.room, payload?.sheetId)) return fail(ack, 'Ficha nao encontrada.');
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

/** Operations are applied synchronously against current state, never a client snapshot. */
export function operateSheet(ctx: Ctx, payload: SheetOperation, ack: Ack<null>): void {
  const sheet = ctx.room.sheet(payload?.sheetId);
  const field = ctx.room.state.sheetTemplate.fields.find(f => f.id === payload?.fieldId);
  if (!sheet || !field || !canEditField(field, ctx.viewer.role, sheet.ownerPlayerId === ctx.viewer.playerId)) return fail(ack, 'Voce nao pode editar este campo.');
  const value = sheet.values[field.id];
  let next: FieldValue;
  if (field.type === 'resource' && isResourceValue(value)) {
    if (payload.action === 'adjust') next = { ...value, current: value.current + clampNumber(payload.delta, -10000, 10000, 0) };
    else if (payload.action === 'resource') next = {
      current: clampNumber(payload.resource?.current, -1000000, 1000000, value.current),
      max: clampNumber(payload.resource?.max, 0, 1000000, value.max),
    };
    else return fail(ack, 'Operacao invalida.');
  } else if (field.type === 'inventory' && Array.isArray(value)) {
    if (payload.action === 'add') {
      if (value.length >= 200) return fail(ack, 'Limite de itens atingido.');
      next = [...value, { id: generateId('itm'), name: 'Novo item', quantity: 1, description: '', equipped: false, assetId: null }];
    } else {
      const item = value.find(i => i.id === payload.itemId);
      if (!item) return fail(ack, 'Item nao encontrado.');
      if (payload.action === 'remove') next = value.filter(i => i.id !== item.id);
      else if (payload.action === 'update') {
        const patch = payload.item ?? {};
        next = value.map(i => i.id !== item.id ? i : { ...i,
          name: safeString(patch.name, 120, i.name),
          description: safeString(patch.description, 2000, i.description),
          quantity: clampNumber(patch.quantity, 0, 1000000, i.quantity),
          equipped: typeof patch.equipped === 'boolean' ? patch.equipped : i.equipped,
          assetId: patch.assetId === undefined ? i.assetId : ownedAsset(ctx, patch.assetId),
        });
      } else return fail(ack, 'Operacao invalida.');
    }
  } else return fail(ack, 'Tipo de campo incompativel.');
  updateSheet(ctx, { sheetId: sheet.id, values: { [field.id]: next } }, ack);
}
