import type {
  FieldType,
  FieldValue,
  InventoryItem,
  ResourceValue,
  Role,
  Sheet,
  SheetField,
  SheetSection,
  SheetTemplate,
} from './types.js';

/**
 * Fichas sao definidas por um schema montado pelo mestre, nao por um sistema
 * de regras embutido. Ao entrar na mesa, o jogador recebe uma ficha gerada a
 * partir do template vigente; quando o mestre altera o schema, as fichas
 * existentes sao reconciliadas (campos novos ganham o default, campos
 * removidos somem, valores compativeis sao preservados).
 */

export function isResourceValue(v: unknown): v is ResourceValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ResourceValue).current === 'number' &&
    typeof (v as ResourceValue).max === 'number'
  );
}

export function isInventoryValue(v: unknown): v is InventoryItem[] {
  return Array.isArray(v);
}

/** Valor inicial de um campo, respeitando o default definido no template. */
export function defaultValueFor(field: SheetField): FieldValue {
  if (field.defaultValue !== undefined && field.defaultValue !== null) {
    return cloneValue(field.defaultValue);
  }
  switch (field.type) {
    case 'number':
      return field.min ?? 0;
    case 'boolean':
      return false;
    case 'resource': {
      const max = field.max ?? 10;
      return { current: max, max };
    }
    case 'inventory':
      return [];
    case 'select':
      return field.options[0] ?? '';
    case 'image':
      return null;
    default:
      return '';
  }
}

function cloneValue(v: FieldValue): FieldValue {
  if (Array.isArray(v)) return v.map((i) => ({ ...i }));
  if (isResourceValue(v)) return { ...v };
  return v;
}

/** Gera o conjunto de valores de uma ficha nova a partir do template. */
export function createSheetValues(template: SheetTemplate): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of template.fields) values[field.id] = defaultValueFor(field);
  return values;
}

/**
 * Reaplica o template sobre valores existentes. Chamado quando o mestre
 * edita o schema com fichas ja em uso.
 */
export function reconcileSheetValues(
  template: SheetTemplate,
  values: Record<string, FieldValue>,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const field of template.fields) {
    const existing = values[field.id];
    out[field.id] =
      existing === undefined || !valueMatchesType(field, existing)
        ? defaultValueFor(field)
        : coerceValue(field, existing);
  }
  return out;
}

function valueMatchesType(field: SheetField, v: FieldValue): boolean {
  switch (field.type) {
    case 'number':
      return typeof v === 'number';
    case 'boolean':
      return typeof v === 'boolean';
    case 'resource':
      return isResourceValue(v);
    case 'inventory':
      return isInventoryValue(v);
    case 'image':
      return v === null || typeof v === 'string';
    default:
      return typeof v === 'string';
  }
}

/** Aplica limites do campo (min/max) ao valor recebido. */
export function coerceValue(field: SheetField, v: FieldValue): FieldValue {
  if (field.type === 'number' && typeof v === 'number') {
    return clamp(v, field.min, field.max);
  }
  if (field.type === 'resource' && isResourceValue(v)) {
    const max = clamp(v.max, field.min ?? 0, field.max);
    return { max, current: clamp(v.current, field.min ?? 0, max) };
  }
  if (field.type === 'select' && typeof v === 'string') {
    return field.options.includes(v) ? v : (field.options[0] ?? '');
  }
  if (field.type === 'inventory' && isInventoryValue(v)) {
    return v.slice(0, 200).map((item) => ({
      id: String(item.id ?? ''),
      name: String(item.name ?? '').slice(0, 120),
      quantity: Number.isFinite(item.quantity) ? Math.max(0, Math.floor(item.quantity)) : 1,
      assetId: item.assetId ?? null,
      description: String(item.description ?? '').slice(0, 2000),
      equipped: Boolean(item.equipped),
    }));
  }
  if (typeof v === 'string') return v.slice(0, 20000);
  return v;
}

function clamp(n: number, min: number | null, max: number | null): number {
  let out = Number.isFinite(n) ? n : 0;
  if (min !== null && min !== undefined) out = Math.max(min, out);
  if (max !== null && max !== undefined) out = Math.min(max, out);
  return out;
}

/** O jogador so escreve em campos destravados e nao exclusivos do mestre. */
export function canEditField(field: SheetField, role: Role, isOwner: boolean): boolean {
  if (role === 'GM') return true;
  if (!isOwner) return false;
  return !field.locked && !field.gmOnly;
}

/**
 * Filtra um patch vindo do cliente, mantendo apenas os campos que aquele
 * papel realmente pode escrever. O servidor nunca confia no patch cru.
 */
export function sanitizeSheetPatch(
  template: SheetTemplate,
  patch: Record<string, FieldValue>,
  role: Role,
  isOwner: boolean,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  const byId = new Map(template.fields.map((f) => [f.id, f]));

  for (const [id, value] of Object.entries(patch)) {
    const field = byId.get(id);
    if (!field) continue;
    if (!canEditField(field, role, isOwner)) continue;
    if (!valueMatchesType(field, value)) continue;
    out[id] = coerceValue(field, value);
  }
  return out;
}

/** Remove do payload os campos que o jogador nao deve nem receber. */
export function filterSheetForRole(
  template: SheetTemplate,
  sheet: Sheet,
  role: Role,
): Sheet {
  if (role === 'GM') return sheet;

  const values: Record<string, FieldValue> = {};
  for (const field of template.fields) {
    if (field.gmOnly) continue;
    values[field.id] = sheet.values[field.id] ?? defaultValueFor(field);
  }
  return { ...sheet, values };
}

export function filterTemplateForRole(template: SheetTemplate, role: Role): SheetTemplate {
  if (role === 'GM') return template;
  return { ...template, fields: template.fields.filter((f) => !f.gmOnly) };
}

// ---------------------------------------------------------------------------
// Normalizacao do template
// ---------------------------------------------------------------------------

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

function text(v: unknown, maxLength: number, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, maxLength) : fallback;
}

/**
 * Preenche um template ate a forma completa de `SheetTemplate`.
 *
 * Roda em dois momentos, e os dois importam:
 *
 *  - ao SALVAR, porque o cliente pode mandar qualquer coisa;
 *  - ao CARREGAR do banco, porque um template gravado por uma versao antiga
 *    do programa nao tem os campos criados depois. Sem isto, adicionar uma
 *    propriedade nova ao modelo quebra todas as mesas que ja existiam — o
 *    valor chega `undefined` e derruba a interface na primeira leitura.
 */
export function normalizeTemplate(raw: Partial<SheetTemplate> | null | undefined): SheetTemplate {
  const sections: SheetSection[] = (Array.isArray(raw?.sections) ? raw.sections : [])
    .slice(0, MAX_SECTIONS)
    .map((s, i): SheetSection => ({
      id: text(s?.id, 40) || `sec_${i}`,
      label: text(s?.label, 60, 'Secao'),
      order: typeof s?.order === 'number' ? s.order : i,
      collapsed: Boolean(s?.collapsed),
    }));

  if (sections.length === 0) {
    sections.push({ id: 'main', label: 'Geral', order: 0, collapsed: false });
  }

  const sectionIds = new Set(sections.map((s) => s.id));
  const seen = new Set<string>();

  const fields: SheetField[] = (Array.isArray(raw?.fields) ? raw.fields : [])
    .slice(0, MAX_FIELDS)
    .map((f, i): SheetField => {
      // Ids repetidos colidiriam no Record de valores da ficha.
      let id = text(f?.id, 40) || `fld_${i}`;
      while (seen.has(id)) id = `${id}_${i}`;
      seen.add(id);

      return {
        id,
        label: text(f?.label, 60, 'Campo'),
        type: FIELD_TYPES.includes(f?.type as FieldType) ? (f.type as FieldType) : 'text',
        sectionId: sectionIds.has(f?.sectionId as string) ? (f.sectionId as string) : sections[0].id,
        order: typeof f?.order === 'number' ? f.order : i,
        locked: Boolean(f?.locked),
        gmOnly: Boolean(f?.gmOnly),
        description: text(f?.description, 300),
        min: typeof f?.min === 'number' ? f.min : null,
        max: typeof f?.max === 'number' ? f.max : null,
        step: typeof f?.step === 'number' ? f.step : null,
        options: Array.isArray(f?.options) ? f.options.slice(0, 50).map((o) => text(o, 60)) : [],
        color: text(f?.color, 32, '#6b7fd7'),
        showOnToken: Boolean(f?.showOnToken),
        span: f?.span === 2 || f?.span === 3 ? f.span : 1,
        defaultValue: (f?.defaultValue ?? null) as FieldValue,
        rollFormula: text(f?.rollFormula, 100),
      };
    });

  return { name: text(raw?.name, 60, 'Ficha'), sections, fields };
}

// ---------------------------------------------------------------------------
// Template inicial
// ---------------------------------------------------------------------------

function field(partial: Partial<SheetField> & Pick<SheetField, 'id' | 'label' | 'type' | 'sectionId'>): SheetField {
  return {
    order: 0,
    locked: false,
    gmOnly: false,
    description: '',
    min: null,
    max: null,
    step: null,
    options: [],
    color: '#6b7fd7',
    showOnToken: false,
    span: 1,
    defaultValue: null,
    rollFormula: '',
    ...partial,
  };
}

/**
 * Template inicial propositalmente neutro: recursos, inventario e anotacoes
 * servem a qualquer sistema. Atributos especificos (Forca, Presenca, Vigor)
 * sao adicionados pelo mestre no editor de ficha.
 */
export function createDefaultTemplate(): SheetTemplate {
  return {
    name: 'Ficha padrao',
    sections: [
      { id: 'identity', label: 'Identidade', order: 0, collapsed: false },
      { id: 'resources', label: 'Recursos', order: 1, collapsed: false },
      { id: 'attributes', label: 'Atributos', order: 2, collapsed: false },
      { id: 'inventory', label: 'Inventario', order: 3, collapsed: false },
      { id: 'notes', label: 'Anotacoes', order: 4, collapsed: false },
    ],
    fields: [
      field({ id: 'concept', label: 'Conceito', type: 'text', sectionId: 'identity', order: 0, span: 2 }),
      field({ id: 'level', label: 'Nivel', type: 'number', sectionId: 'identity', order: 1, min: 0, locked: true, defaultValue: 1 }),
      field({ id: 'background', label: 'Historia', type: 'longtext', sectionId: 'identity', order: 2, span: 3 }),

      field({ id: 'hp', label: 'Vida', type: 'resource', sectionId: 'resources', order: 0, min: 0, max: 999, color: '#d9534f', showOnToken: true, defaultValue: { current: 20, max: 20 } }),
      field({ id: 'energy', label: 'Energia', type: 'resource', sectionId: 'resources', order: 1, min: 0, max: 999, color: '#4a90d9', showOnToken: true, defaultValue: { current: 10, max: 10 } }),
      field({ id: 'actions', label: 'Acoes por turno', type: 'resource', sectionId: 'resources', order: 2, min: 0, max: 20, color: '#e0a33e', showOnToken: false, defaultValue: { current: 3, max: 3 } }),

      field({ id: 'defense', label: 'Defesa', type: 'number', sectionId: 'attributes', order: 0, min: 0, defaultValue: 10 }),
      field({ id: 'initiative', label: 'Iniciativa', type: 'number', sectionId: 'attributes', order: 1, defaultValue: 0, rollFormula: '1d20+@initiative' }),
      field({ id: 'speed', label: 'Deslocamento', type: 'number', sectionId: 'attributes', order: 2, min: 0, defaultValue: 9 }),

      field({ id: 'items', label: 'Itens', type: 'inventory', sectionId: 'inventory', order: 0, span: 3 }),

      field({ id: 'notes', label: 'Anotacoes do personagem', type: 'longtext', sectionId: 'notes', order: 0, span: 3 }),
      field({ id: 'gm_notes', label: 'Notas do mestre', type: 'longtext', sectionId: 'notes', order: 1, span: 3, gmOnly: true }),
    ],
  };
}

/** Campos marcados para virar barra sobre o token. */
export function tokenBarFields(template: SheetTemplate): SheetField[] {
  return template.fields.filter((f) => f.type === 'resource' && f.showOnToken);
}
