import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from './store';

/*
 * O historico de desfazer e local, mas a mesa nao: uma entrada que ficou
 * velha (outra pessoa mexeu no objeto depois) nao pode agir. Antes, desfazer
 * um movimento depois que o jogador moveu o mesmo token o teletransportava.
 */
describe('desfazer que nao atropela a mesa', () => {
  beforeEach(() => {
    useStore.setState({ undoStack: [], redoStack: [], notices: [] } as never);
  });

  it('descarta a entrada bloqueada sem agir, e avisa o motivo', () => {
    const undo = vi.fn();
    const notify = vi.spyOn(useStore.getState(), 'notify');
    useStore.getState().pushUndo({ label: 'mover token', undo, redo: vi.fn(), blocked: () => 'o token foi movido depois' });

    useStore.getState().undo();

    expect(undo).not.toHaveBeenCalled();
    expect(useStore.getState().undoStack).toHaveLength(0);
    expect(useStore.getState().redoStack).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith('info', expect.stringContaining('o token foi movido depois'));
  });

  it('entrada livre desfaz e vai para o refazer; o refazer tambem confere', () => {
    const redo = vi.fn();
    let moved = false;
    useStore.getState().pushUndo({
      label: 'mover token',
      undo: vi.fn(),
      redo,
      blocked: (dir) => (dir === 'redo' && moved ? 'o token foi movido depois' : null),
    });

    useStore.getState().undo();
    expect(useStore.getState().redoStack).toHaveLength(1);

    moved = true;
    useStore.getState().redo();
    expect(redo).not.toHaveBeenCalled();
    expect(useStore.getState().redoStack).toHaveLength(0);
  });
});
