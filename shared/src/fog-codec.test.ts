import { describe, expect, it } from 'vitest';

import { decodeExploredCells, encodeExploredCells } from './fog-codec.js';

/**
 * O codec grava a neblina; se ele perder uma celula, o mapa do jogador volta
 * coberto onde ele ja tinha andado — e ninguem relaciona o sintoma a gravacao.
 * Por isso os testes cobrem a ida e volta, e nao so o tamanho.
 */

const sorted = (keys: string[]) => [...keys].sort();

describe('codec de celulas exploradas', () => {
  it('vai e volta sem perder celula', () => {
    const keys = ['10,4', '11,4', '12,4', '18,4', '3,9'];
    expect(sorted(decodeExploredCells(encodeExploredCells(keys)))).toEqual(sorted(keys));
  });

  it('agrupa a faixa contigua', () => {
    const runs = encodeExploredCells(['10,4', '11,4', '12,4']);
    expect(runs['4']).toEqual([[10, 12]]);
  });

  it('separa faixas com buraco no meio', () => {
    const runs = encodeExploredCells(['1,0', '2,0', '5,0', '6,0']);
    expect(runs['0']).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('trata a celula isolada como faixa de um', () => {
    expect(encodeExploredCells(['7,3'])['3']).toEqual([[7, 7]]);
  });

  it('funciona com coordenada negativa', () => {
    const keys = ['-3,-1', '-2,-1', '-1,-1', '0,-1'];
    expect(encodeExploredCells(keys)['-1']).toEqual([[-3, 0]]);
    expect(sorted(decodeExploredCells(encodeExploredCells(keys)))).toEqual(sorted(keys));
  });

  it('nao depende da ordem de entrada', () => {
    const desordenado = ['12,4', '10,4', '11,4'];
    expect(encodeExploredCells(desordenado)['4']).toEqual([[10, 12]]);
  });

  it('elimina duplicatas em vez de repetir a celula', () => {
    const runs = encodeExploredCells(['5,1', '5,1', '5,1']);
    expect(decodeExploredCells(runs)).toEqual(['5,1']);
  });

  it('lida com lista vazia', () => {
    expect(encodeExploredCells([])).toEqual({});
    expect(decodeExploredCells({})).toEqual([]);
  });

  it('sobrevive a dados corrompidos sem estourar', () => {
    expect(decodeExploredCells(null)).toEqual([]);
    expect(decodeExploredCells(undefined)).toEqual([]);
    expect(decodeExploredCells({ abc: [[1, 2]] })).toEqual([]);
    expect(decodeExploredCells({ '1': [[5, 2]] })).toEqual([]);
    expect(decodeExploredCells({ '1': 'nao e faixa' } as never)).toEqual([]);
  });

  it('ignora chave malformada na entrada', () => {
    expect(encodeExploredCells(['lixo', '', ',', '3,4'])).toEqual({ '4': [[3, 3]] });
  });

  it('encolhe de verdade um mapa explorado', () => {
    // 200x200 celulas contiguas: o caso que pesava na gravacao.
    const keys: string[] = [];
    for (let b = 0; b < 200; b++) {
      for (let a = 0; a < 200; a++) keys.push(`${a},${b}`);
    }

    const antes = JSON.stringify(keys).length;
    const depois = JSON.stringify(encodeExploredCells(keys)).length;

    expect(sorted(decodeExploredCells(encodeExploredCells(keys)))).toEqual(sorted(keys));
    // Cada linha vira uma faixa so: a reducao e de mais de cinquenta vezes.
    expect(depois).toBeLessThan(antes / 50);
  });
});
