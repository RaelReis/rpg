import { describe, expect, it } from 'vitest';

import {
  canEditField,
  coerceValue,
  createDefaultTemplate,
  createSheetValues,
  filterSheetForRole,
  filterTemplateForRole,
  normalizeTemplate,
  reconcileSheetValues,
  sanitizeSheetPatch,
} from './sheet.js';
import type { Sheet, SheetField, SheetTemplate } from './types.js';

/**
 * Fichas configuraveis.
 *
 * Aqui moram duas classes de falha silenciosa: a reconciliacao, que decide o
 * que acontece com os valores ja preenchidos quando o mestre muda o modelo; e
 * a filtragem por papel, que decide o que sai do servidor. Um erro na primeira
 * apaga o personagem de alguem; um erro na segunda entrega o segredo do mestre.
 */

function field(partial: Partial<SheetField> & Pick<SheetField, 'id' | 'type'>): SheetField {
  return {
    label: partial.id,
    sectionId: 'main',
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
  } as SheetField;
}

function template(fields: SheetField[]): SheetTemplate {
  return {
    name: 'Ficha',
    sections: [{ id: 'main', label: 'Geral', order: 0, collapsed: false }],
    fields,
  };
}

describe('normalizeTemplate', () => {
  it('preenche as propriedades ausentes de um modelo antigo', () => {
    // A falha relatada: mesas criadas antes de `rollFormula` existir tinham
    // campos sem a propriedade, e a interface chamava .trim() em undefined —
    // a aba inteira quebrava ao abrir.
    const legacy = {
      name: 'Antiga',
      sections: [{ id: 'main', label: 'Geral', order: 0 }],
      fields: [{ id: 'forca', label: 'Forca', type: 'number', sectionId: 'main' }],
    } as unknown as Partial<SheetTemplate>;

    const normalized = normalizeTemplate(legacy);
    const [f] = normalized.fields;

    expect(f.rollFormula).toBe('');
    expect(f.options).toEqual([]);
    expect(f.description).toBe('');
    expect(f.min).toBeNull();
    expect(f.span).toBe(1);
    expect(f.locked).toBe(false);
  });

  it('sobrevive a nulo e a objeto vazio', () => {
    for (const raw of [null, undefined, {}]) {
      const t = normalizeTemplate(raw as Partial<SheetTemplate>);
      expect(t.sections.length).toBeGreaterThan(0);
      expect(Array.isArray(t.fields)).toBe(true);
    }
  });

  it('garante ao menos uma secao', () => {
    expect(normalizeTemplate({ sections: [], fields: [] }).sections).toHaveLength(1);
  });

  it('desambigua ids repetidos, que colidiriam no Record de valores', () => {
    const t = normalizeTemplate({
      sections: [{ id: 'main', label: 'Geral', order: 0, collapsed: false }],
      fields: [
        { id: 'pv', type: 'number' } as SheetField,
        { id: 'pv', type: 'number' } as SheetField,
      ],
    });
    expect(new Set(t.fields.map((f) => f.id)).size).toBe(2);
  });

  it('reancora o campo cuja secao nao existe, em vez de perde-lo', () => {
    const t = normalizeTemplate({
      sections: [{ id: 'main', label: 'Geral', order: 0, collapsed: false }],
      fields: [{ id: 'x', type: 'text', sectionId: 'secao_apagada' } as SheetField],
    });
    expect(t.fields[0].sectionId).toBe('main');
  });

  it('troca tipo desconhecido por texto', () => {
    const t = normalizeTemplate({
      fields: [{ id: 'x', type: 'inventado' } as unknown as SheetField],
    });
    expect(t.fields[0].type).toBe('text');
  });

  it('normalizar duas vezes nao muda o resultado', () => {
    const once = normalizeTemplate(createDefaultTemplate());
    expect(normalizeTemplate(once)).toEqual(once);
  });
});

describe('reconcileSheetValues', () => {
  const t = template([
    field({ id: 'nome', type: 'text' }),
    field({ id: 'pv', type: 'resource', min: 0, max: 100 }),
    field({ id: 'nivel', type: 'number', min: 1, max: 20 }),
  ]);

  it('preserva o que ja estava preenchido', () => {
    const out = reconcileSheetValues(t, { nome: 'Ravena', nivel: 5 });
    expect(out.nome).toBe('Ravena');
    expect(out.nivel).toBe(5);
  });

  it('preenche com o padrao o campo que nunca existiu', () => {
    const out = reconcileSheetValues(t, { nome: 'Ravena' });
    expect(out.pv).toBeDefined();
    expect(out.nivel).toBeDefined();
  });

  it('descarta valor de tipo incompativel em vez de propagar lixo', () => {
    // Se o mestre troca um campo de texto para numero, o texto antigo nao
    // pode virar NaN dentro da ficha.
    const out = reconcileSheetValues(t, { nivel: 'muito alto' as never });
    expect(typeof out.nivel).toBe('number');
  });

  it('remove o campo que saiu do modelo', () => {
    const out = reconcileSheetValues(t, { nome: 'X', campo_removido: 'sobra' as never });
    expect('campo_removido' in out).toBe(false);
  });

  it('aplica os limites do campo ao reconciliar', () => {
    const out = reconcileSheetValues(t, { nivel: 99 });
    expect(out.nivel).toBe(20);
  });

  it('reconciliar duas vezes nao muda o resultado', () => {
    const once = reconcileSheetValues(t, { nome: 'Ravena', nivel: 5 });
    expect(reconcileSheetValues(t, once)).toEqual(once);
  });
});

describe('coerceValue', () => {
  it('respeita min e max do numero', () => {
    const f = field({ id: 'n', type: 'number', min: 0, max: 10 });
    expect(coerceValue(f, 20)).toBe(10);
    expect(coerceValue(f, -5)).toBe(0);
    expect(coerceValue(f, 7)).toBe(7);
  });

  it('deixa o numero negativo passar quando nao ha min', () => {
    // O modificador negativo precisa sobreviver: com `min: 0` ele virava 0 e a
    // formula rolava `1d20+0` em vez de `1d20-3`.
    const f = field({ id: 'mod', type: 'number', min: null, max: null });
    expect(coerceValue(f, -3)).toBe(-3);
  });

  it('nao deixa o atual passar do maximo no recurso', () => {
    const f = field({ id: 'pv', type: 'resource', min: 0, max: 100 });
    expect(coerceValue(f, { current: 50, max: 20 })).toEqual({ current: 20, max: 20 });
  });

  it('troca opcao invalida pela primeira da lista', () => {
    const f = field({ id: 's', type: 'select', options: ['a', 'b'] });
    expect(coerceValue(f, 'z')).toBe('a');
    expect(coerceValue(f, 'b')).toBe('b');
  });
});

describe('canEditField', () => {
  const livre = field({ id: 'a', type: 'text' });
  const travado = field({ id: 'b', type: 'text', locked: true });
  const doMestre = field({ id: 'c', type: 'text', gmOnly: true });

  it('o mestre escreve em tudo', () => {
    for (const f of [livre, travado, doMestre]) {
      expect(canEditField(f, 'GM', false)).toBe(true);
    }
  });

  it('o dono escreve so no que esta destravado', () => {
    expect(canEditField(livre, 'PLAYER', true)).toBe(true);
    expect(canEditField(travado, 'PLAYER', true)).toBe(false);
    expect(canEditField(doMestre, 'PLAYER', true)).toBe(false);
  });

  it('quem nao e dono nao escreve nem no campo livre', () => {
    expect(canEditField(livre, 'PLAYER', false)).toBe(false);
  });
});

describe('sanitizeSheetPatch', () => {
  const t = template([
    field({ id: 'nome', type: 'text' }),
    field({ id: 'defesa', type: 'number', locked: true }),
    field({ id: 'segredo', type: 'text', gmOnly: true }),
  ]);

  it('descarta a escrita do jogador em campo travado ou do mestre', () => {
    const patch = sanitizeSheetPatch(t, { nome: 'X', defesa: 99, segredo: 'vazou' }, 'PLAYER', true);
    expect(patch.nome).toBe('X');
    expect('defesa' in patch).toBe(false);
    expect('segredo' in patch).toBe(false);
  });

  it('o mestre escreve em todos', () => {
    const patch = sanitizeSheetPatch(t, { nome: 'X', defesa: 9, segredo: 's' }, 'GM', false);
    expect(Object.keys(patch).sort()).toEqual(['defesa', 'nome', 'segredo']);
  });

  it('ignora campo que nao existe no modelo', () => {
    const patch = sanitizeSheetPatch(t, { inventado: 'x' } as never, 'GM', false);
    expect('inventado' in patch).toBe(false);
  });
});

describe('filtragem por papel', () => {
  const t = template([
    field({ id: 'nome', type: 'text' }),
    field({ id: 'segredo', type: 'text', gmOnly: true }),
  ]);

  const sheet: Sheet = {
    id: 'sht_1',
    name: 'Ravena',
    portraitAssetId: null,
    ownerPlayerId: 'ply_1',
    values: { nome: 'Ravena', segredo: 'e uma espia' },
    sharedWithParty: false,
    createdAt: 0,
    updatedAt: 0,
  };

  it('o campo do mestre nao sai no payload do jogador', () => {
    // Esconder na interface nao basta: o valor chegaria pelo devtools.
    const filtered = filterSheetForRole(t, sheet, 'PLAYER');
    expect(filtered.values.nome).toBe('Ravena');
    expect('segredo' in filtered.values).toBe(false);
  });

  it('o mestre recebe a ficha inteira', () => {
    const filtered = filterSheetForRole(t, sheet, 'GM');
    expect(filtered.values.segredo).toBe('e uma espia');
  });

  it('o modelo enviado ao jogador tambem perde o campo do mestre', () => {
    const filtered = filterTemplateForRole(t, 'PLAYER');
    expect(filtered.fields.map((f) => f.id)).toEqual(['nome']);
    expect(filterTemplateForRole(t, 'GM').fields).toHaveLength(2);
  });
});

describe('createSheetValues', () => {
  it('cria um valor para cada campo do modelo', () => {
    const t = createDefaultTemplate();
    const values = createSheetValues(t);
    for (const f of t.fields) {
      expect(values[f.id]).toBeDefined();
    }
  });
});
