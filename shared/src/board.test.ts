import { describe, expect, it } from 'vitest';

import { boardForViewer, boardItemForViewer, normalizeBoard } from './board.js';
import type { BoardItem } from './types.js';

/** O cartao de material nao pode entregar o material a quem nao o recebeu. */

function item(partial: Partial<BoardItem>): BoardItem {
  return {
    id: 'itm',
    kind: 'note',
    x: 0,
    y: 0,
    text: '',
    color: '#f3e3a1',
    assetId: null,
    handoutId: null,
    authorId: null,
    updatedAt: 0,
    ...partial,
  };
}

describe('boardItemForViewer', () => {
  const card = item({ id: 'c1', kind: 'handout', handoutId: 'hnd_diario', text: 'olhem a data' });

  it('sem acesso, o cartao chega como indisponivel e sem o id do material', () => {
    const shown = boardItemForViewer(card, () => false);
    expect(shown.unavailable).toBe(true);
    expect(shown.handoutId).toBeNull();
    expect(JSON.stringify(shown)).not.toContain('hnd_diario');
  });

  it('com acesso, o cartao chega completo', () => {
    const shown = boardItemForViewer(card, (id) => id === 'hnd_diario');
    expect(shown.unavailable).toBe(false);
    expect(shown.handoutId).toBe('hnd_diario');
  });

  it('a legenda do cartao nao chega a quem nao ve o material', () => {
    const captioned = { ...card, text: 'a carta do farol' };
    expect(boardItemForViewer(captioned, () => false).text).toBe('');
    expect(boardItemForViewer(captioned, () => true).text).toBe('a carta do farol');
  });

  it('material apagado vira indisponivel', () => {
    expect(boardItemForViewer(card, () => false).unavailable).toBe(true);
  });

  it('notas e imagens passam como estao', () => {
    const note = item({ kind: 'note', text: 'o farol' });
    expect(boardItemForViewer(note, () => false)).toBe(note);
  });

  it('o quadro inteiro filtra so os cartoes', () => {
    const board = { locked: true, items: [card, item({ id: 'n1' })], threads: [] };
    const shown = boardForViewer(board, () => false);
    expect(shown.locked).toBe(true);
    expect(shown.items[0].handoutId).toBeNull();
    expect(shown.items[1].id).toBe('n1');
  });
});

describe('normalizeBoard', () => {
  it('aceita ausencia e lixo', () => {
    expect(normalizeBoard(undefined)).toEqual({ locked: false, items: [], threads: [] });
    expect(normalizeBoard({ items: 'x' as never })).toEqual({ locked: false, items: [], threads: [] });
  });
});
