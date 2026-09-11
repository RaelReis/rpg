import { describe, expect, it } from 'vitest';

import { DEFAULT_GRID } from './grid.js';
import {
  cellAt,
  cellCenter,
  cellDistance,
  cellKey,
  cellsWithinRadius,
  measureDistance,
  parseCellKey,
  snapTokenPosition,
  tokenCell,
} from './grid.js';
import type { GridConfig } from './types.js';

/**
 * Grade quadrada e hexagonal.
 *
 * Uma conversao pixel-celula errada nao trava nada: o token so fica uma
 * casa fora do lugar, e a mesa toda passa a jogar com a distancia errada sem
 * ninguem perceber de onde veio.
 */

const square: GridConfig = { ...DEFAULT_GRID, size: 100, unitsPerCell: 1.5 };
const pointy: GridConfig = { ...DEFAULT_GRID, type: 'hex-pointy', size: 100 };
const flat: GridConfig = { ...DEFAULT_GRID, type: 'hex-flat', size: 100 };

describe('cellKey / parseCellKey', () => {
  it('vai e volta sem perder o valor', () => {
    for (const cell of [
      { a: 0, b: 0 },
      { a: 3, b: -7 },
      { a: -12, b: 40 },
    ]) {
      expect(parseCellKey(cellKey(cell))).toEqual(cell);
    }
  });

  it('sobrevive a coordenada negativa, que usa o mesmo separador do sinal', () => {
    expect(cellKey({ a: -1, b: -1 })).toBe('-1,-1');
    expect(parseCellKey('-1,-1')).toEqual({ a: -1, b: -1 });
  });
});

describe('cellAt (quadrada)', () => {
  it('mapeia o ponto para a celula que o contem', () => {
    expect(cellAt(square, { x: 0, y: 0 })).toEqual({ a: 0, b: 0 });
    expect(cellAt(square, { x: 99, y: 99 })).toEqual({ a: 0, b: 0 });
    expect(cellAt(square, { x: 100, y: 0 })).toEqual({ a: 1, b: 0 });
    expect(cellAt(square, { x: 250, y: 350 })).toEqual({ a: 2, b: 3 });
  });

  it('trata coordenada negativa arredondando para baixo, nao para zero', () => {
    // Math.trunc daria { a: 0 } e colocaria dois lados da origem na mesma casa.
    expect(cellAt(square, { x: -1, y: -1 })).toEqual({ a: -1, b: -1 });
    expect(cellAt(square, { x: -100, y: -100 })).toEqual({ a: -1, b: -1 });
    expect(cellAt(square, { x: -101, y: -101 })).toEqual({ a: -2, b: -2 });
  });

  it('respeita o deslocamento da grade', () => {
    const offset: GridConfig = { ...square, offsetX: 50, offsetY: 50 };
    expect(cellAt(offset, { x: 49, y: 49 })).toEqual({ a: -1, b: -1 });
    expect(cellAt(offset, { x: 50, y: 50 })).toEqual({ a: 0, b: 0 });
  });
});

describe('cellAt / cellCenter (hexagonal)', () => {
  it('o centro de uma celula volta para a mesma celula', () => {
    for (const grid of [pointy, flat]) {
      for (const cell of [
        { a: 0, b: 0 },
        { a: 2, b: -1 },
        { a: -3, b: 2 },
        { a: 5, b: 5 },
      ]) {
        expect(cellAt(grid, cellCenter(grid, cell))).toEqual(cell);
      }
    }
  });
});

describe('cellDistance', () => {
  it('usa Chebyshev na grade quadrada: a diagonal custa um passo', () => {
    expect(cellDistance(square, { a: 0, b: 0 }, { a: 3, b: 0 })).toBe(3);
    expect(cellDistance(square, { a: 0, b: 0 }, { a: 3, b: 3 })).toBe(3);
    expect(cellDistance(square, { a: 0, b: 0 }, { a: 1, b: 4 })).toBe(4);
  });

  it('e simetrica', () => {
    const from = { a: -2, b: 5 };
    const to = { a: 4, b: -1 };
    expect(cellDistance(square, from, to)).toBe(cellDistance(square, to, from));
    expect(cellDistance(pointy, from, to)).toBe(cellDistance(pointy, to, from));
  });

  it('usa distancia cubica no hex: os seis vizinhos ficam a um passo', () => {
    const center = { a: 0, b: 0 };
    const neighbours = [
      { a: 1, b: 0 },
      { a: 1, b: -1 },
      { a: 0, b: -1 },
      { a: -1, b: 0 },
      { a: -1, b: 1 },
      { a: 0, b: 1 },
    ];
    for (const n of neighbours) {
      expect(cellDistance(pointy, center, n)).toBe(1);
    }
    // O que parece vizinho em coordenada axial, mas nao e.
    expect(cellDistance(pointy, center, { a: 1, b: 1 })).toBe(2);
  });
});

describe('measureDistance', () => {
  it('converte celulas para as unidades da mesa', () => {
    // 3 celulas na diagonal, a 1,5 unidade por celula.
    const d = measureDistance(square, { x: 50, y: 50 }, { x: 350, y: 350 });
    expect(d).toBeCloseTo(4.5);
  });

  it('acompanha unitsPerCell', () => {
    const feet: GridConfig = { ...square, unitsPerCell: 5 };
    expect(measureDistance(feet, { x: 50, y: 50 }, { x: 250, y: 50 })).toBe(10);
  });
});

describe('cellsWithinRadius', () => {
  it('cobre o quadrado completo na grade quadrada', () => {
    expect(cellsWithinRadius(square, { a: 0, b: 0 }, 0)).toHaveLength(1);
    expect(cellsWithinRadius(square, { a: 0, b: 0 }, 1)).toHaveLength(9);
    expect(cellsWithinRadius(square, { a: 0, b: 0 }, 2)).toHaveLength(25);
  });

  it('cobre o hexagono completo na grade hexagonal', () => {
    // 1 + 3r(r+1): 7 para raio 1, 19 para raio 2.
    expect(cellsWithinRadius(pointy, { a: 0, b: 0 }, 1)).toHaveLength(7);
    expect(cellsWithinRadius(pointy, { a: 0, b: 0 }, 2)).toHaveLength(19);
  });

  it('nao devolve celula alem do raio', () => {
    const center = { a: 4, b: -2 };
    for (const cell of cellsWithinRadius(pointy, center, 3)) {
      expect(cellDistance(pointy, center, cell)).toBeLessThanOrEqual(3);
    }
  });

  it('trata raio negativo como zero em vez de estourar', () => {
    expect(cellsWithinRadius(square, { a: 0, b: 0 }, -5)).toHaveLength(1);
  });
});

describe('snapTokenPosition', () => {
  it('encaixa pelo centro do token, nao pelo canto', () => {
    // Canto em y=260 poe o centro em 310, que cai na celula 3: o canto vai
    // para 300, e nao para 200. Encaixar pelo canto faria o token pular para
    // tras sempre que o cursor passasse pouco da metade da celula.
    expect(snapTokenPosition(square, { x: 130, y: 260 }, 1)).toEqual({ x: 100, y: 300 });
    expect(snapTokenPosition(square, { x: 130, y: 230 }, 1)).toEqual({ x: 100, y: 200 });
  });

  it('token de tamanho par encaixa nas linhas da grade', () => {
    const snapped = snapTokenPosition(square, { x: 90, y: 190 }, 2);
    expect(snapped).toEqual({ x: 100, y: 200 });
  });

  it('mantem o token grande alinhado a grade', () => {
    const snapped = snapTokenPosition(square, { x: 137, y: 262 }, 2);
    expect(snapped.x % square.size).toBe(0);
    expect(snapped.y % square.size).toBe(0);
  });

  it('encaixar duas vezes nao move de novo', () => {
    const once = snapTokenPosition(square, { x: 137, y: 262 }, 1);
    expect(snapTokenPosition(square, once, 1)).toEqual(once);
  });
});

describe('tokenCell', () => {
  it('usa o centro do token, nao o canto', () => {
    // Token de 2x2 comecando em (0,0) ocupa ate (200,200): o centro cai em (1,1).
    expect(tokenCell(square, { x: 0, y: 0 }, 2)).toEqual({ a: 1, b: 1 });
    expect(tokenCell(square, { x: 0, y: 0 }, 1)).toEqual({ a: 0, b: 0 });
  });
});
