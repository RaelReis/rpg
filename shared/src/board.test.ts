import { describe, expect, it } from 'vitest';

import { boardItemFor, canDeleteOnBoard, canEditBoard, normalizeBoard, type BoardItem } from './board.js';

/**
 * Quadro de pistas: quem pode mexer e o que sai para quem nao tem acesso ao
 * material de um cartao.
 */

function item(partial: Partial<BoardItem>): BoardItem {
  return {
    id: 'bi_1',
    kind: 'note',
    x: 0,
    y: 0,
    width: 180,
    height: 140,
    rotation: 0,
    text: '',
    color: '#f2dc8d',
    assetId: null,
    handoutId: null,
    authorId: 'ply_a',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('canEditBoard', () => {
  it('aberto, todos editam', () => {
    expect(canEditBoard({ locked: false }, 'PLAYER')).toBe(true);
  });

  it('travado, so o mestre', () => {
    expect(canEditBoard({ locked: true }, 'PLAYER')).toBe(false);
    expect(canEditBoard({ locked: true }, 'GM')).toBe(true);
  });
});

describe('canDeleteOnBoard', () => {
  const note = item({ authorId: 'ply_a' });

  it('o autor apaga o proprio item', () => {
    expect(canDeleteOnBoard({ locked: false }, note, 'PLAYER', 'ply_a')).toBe(true);
  });

  it('outro jogador nao', () => {
    expect(canDeleteOnBoard({ locked: false }, note, 'PLAYER', 'ply_b')).toBe(false);
  });

  it('o mestre sempre', () => {
    expect(canDeleteOnBoard({ locked: true }, note, 'GM', 'ply_gm')).toBe(true);
  });

  it('com o quadro travado, nem o autor', () => {
    expect(canDeleteOnBoard({ locked: true }, note, 'PLAYER', 'ply_a')).toBe(false);
  });

  it('item de autor que saiu da mesa: so o mestre', () => {
    expect(canDeleteOnBoard({ locked: false }, item({ authorId: null }), 'PLAYER', null)).toBe(false);
  });
});

describe('boardItemFor', () => {
  const card = item({ kind: 'handout', handoutId: 'hnd_secret' });

  it('sem acesso ao material, o cartao sai sem a referencia', () => {
    const out = boardItemFor(card, false);
    expect(out.handoutId).toBeNull();
    expect(out.unavailable).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hnd_secret');
  });

  it('com acesso, o cartao sai completo', () => {
    const out = boardItemFor(card, true);
    expect(out.handoutId).toBe('hnd_secret');
    expect(out.unavailable).toBeUndefined();
  });

  it('notas e imagens nao sao afetadas', () => {
    const note = item({ text: 'o mordomo mentiu' });
    expect(boardItemFor(note, false)).toBe(note);
  });
});

describe('normalizeBoard', () => {
  it('mesa antiga, sem quadro, ganha um vazio', () => {
    expect(normalizeBoard(undefined)).toEqual({ locked: false, items: [], threads: [] });
  });
});
