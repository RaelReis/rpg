import {
  createSheetValues,
  filterTemplateForRole,
  generateId,
  reconcileSheetValues,
  sanitizeSheetPatch,
  type Ack,
  type FieldType,
  type FieldValue,
  type Sheet,
  type SheetField,
  type SheetSection,
  type SheetTemplate,
} from '@rpg/shared';

import { socketsOf } from '../broadcast.js';
import { prisma, toJson } from '../db.js';
import { sheetForViewer } from '../filter.js';
import type { Room } from '../room.js';
import { clampNumber, fail, isGm, ok, safeString, type Ctx } from './context.js';

/**
 * Template de ficha e fichas.
 *
 * O template e o schema que o mestre monta; as fichas sao instancias dele. Ao
 * mudar o schema com fichas ja em uso, os valores sao reconciliados em vez de
 * descartados: campos novos ganham o default, removidos somem e o que continua
 * compativel e preservado.
 */

const FIELD_TYPES: FieldType[] = [
  'text',
  'longtext',
  'number',
  'boolean',
  'select',
  'resource',
  'inventory',
  'image',
];

const MAX_FIELDS = 200;
const MAX_SECTIONS = 30;

function sanitizeTemplate(raw: SheetTemplate): SheetTemplate {
  const sections: SheetSection[] = (Array.isArray(raw?.sections) ? raw.sections : [])
    .slice(0, MAX_SECTIONS)
    .map((s, i): SheetSection => ({
      id: safeString(s?.id, 40) || generateId('sec'),
      label: safeString(s?.label, 60, 'Secao'),
      order: typeof s?.order === 'number' ? s.order : i,
      collapsed: Boolean(s?.collapsed),
    }));

  if (sections.length === 0) {
    sections.push({ id: 'main', label: 'Geral', order: 0, collapsed: false });
  }

  const sectionIds = new Set(sections.map((s) => s.id));
  const seenFieldIds = new Set<string>();

  const fields: SheetField[] = (Array.isArray(raw?.fields) ? raw.fields : [])
    .slice(0, MAX_FIELDS)
    .map((f, i): SheetField => {
      let id = safeString(f?.id, 40) || generateId('fld');
      // Ids repetidos colidiriam no Record de valores da ficha.
      while (seenFieldIds.has(id)) id = generateId('fld');
      seenFieldIds.add(id);

      const type: FieldType = FIELD_TYPES.includes(f?.type) ? f.type : 'text';
      const span = f?.span === 2 || f?.span === 3 ? f.span : 1;

      return {
        id,
        label: safeString(f?.label, 60, 'Campo'),
        type,
        sectionId: sectionIds.has(f?.sectionId) ? f.sectionId : sections[0].id,
        order: typeof f?.order === 'number' ? f.order : i,
        locked: Boolean(f?.locked),
        gmOnly: Boolean(f?.gmOnly),
        description: safeString(f?.description, 300, ''),
        min: typeof f?.min === 'number' ? f.min : null,
        max: typeof f?.max === 'number' ? f.max : null,
        step: typeof f?.step === 'number' ? f.step : null,
        options: Array.isArray(f?.options) ? f.options.slice(0, 50).map((o) => safeString(o, 60)) : [],
        color: safeString(f?.color, 32, '#6b7fd7'),
        showOnToken: Boolean(f?.showOnToken),
        span,
        defaultValue: (f?.defaultValue ?? null) as FieldValue,
      };
    });

  return { name: safeString(raw?.name, 60, 'Ficha'), sections, fields };
}

/** Envia uma ficha a cada socket na versao que ele pode ver. */
function emitSheet(room: Room, sheet: Sheet): void {
  for (const socket of socketsOf(room)) {
    const visible = sheetForViewer(room, sheet, socket.data.viewer);
    if (visible) socket.emit('sheets:patch', { upsert: [visible] });
    else socket.emit('sheets:patch', { remove: [sheet.id] });
  }
}

export function updateTemplate(ctx: Ctx, raw: SheetTemplate, ack: Ack<null>): void {
  const template = sanitizeTemplate(raw);
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
    socket.emit('sheets:patch', { upsert: sheets });
  }
  ok(ack, null);
}

export async function createSheet(
  ctx: Ctx,
  payload: { name: string; ownerPlayerId?: string | null },
  ack: Ack<Sheet>,
): Promise<void> {
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
  ctx.room.touch('sheets');
  emitSheet(ctx.room, sheet);
  ok(ack, sheet);
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
    sheet.portraitAssetId = payload.portraitAssetId;
  }
  if (payload.sharedWithParty !== undefined && (gm || isOwner)) {
    sheet.sharedWithParty = Boolean(payload.sharedWithParty);
  }

  sheet.updatedAt = Date.now();
  ctx.room.touch('sheets');
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
      ctx.room.touch('players');
    }
  }

  for (const socket of socketsOf(ctx.room)) socket.emit('sheets:patch', { remove: [removed.id] });
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

  ctx.room.touch('sheets');
  ctx.room.touch('players');
  emitSheet(ctx.room, sheet);
  for (const socket of socketsOf(ctx.room)) socket.emit('players:patch', ctx.room.state.players);
  ok(ack, null);
}

export { clampNumber };
