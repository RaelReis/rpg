import { describe, expect, it } from 'vitest';

import { createToken } from './defaults.js';
import { cellCenter, cellCorners, DEFAULT_GRID } from './grid.js';
import {
  createTrigger,
  movementEntersArea,
  pointInArea,
  segmentTouchesArea,
  triggerAccepts,
  triggersFiredBy,
  type TriggerArea,
} from './triggers.js';
import type { GridConfig } from './types.js';

/**
 * Gatilhos: quando um movimento conta como entrada numa area.
 *
 * A falha aqui e silenciosa dos dois jeitos: um gatilho que nao dispara
 * parece so uma cena calma, e um que dispara a cada passo enche a tela do
 * jogador de mensagens repetidas.
 */

const G = 70;
const square: GridConfig = { ...DEFAULT_GRID, type: 'square', size: G, offsetX: 0, offsetY: 0 };

/** A celula (2,2) da grade quadrada, exatamente nas linhas da grade. */
const cell22: TriggerArea = { kind: 'rect', x: 2 * G, y: 2 * G, width: G, height: G };
const center = (a: number, b: number) => cellCenter(square, { a, b });

describe('entrada pelo segmento', () => {
  it('um arraste rapido que atravessa a area conta, mesmo sem parar dentro', () => {
    // Do centro de (1,2) ao centro de (3,2): as duas pontas estao fora.
    expect(pointInArea(center(1, 2), cell22)).toBe(false);
    expect(pointInArea(center(3, 2), cell22)).toBe(false);
    expect(movementEntersArea(center(1, 2), center(3, 2), cell22)).toBe(true);
  });

  it('um salto longo que passa por cima de uma faixa estreita tambem', () => {
    const corridor: TriggerArea = { kind: 'rect', x: 500, y: 0, width: 4, height: 1000 };
    expect(movementEntersArea({ x: 100, y: 300 }, { x: 900, y: 320 }, corridor)).toBe(true);
  });

  it('passar ao lado nao conta', () => {
    expect(movementEntersArea(center(1, 1), center(3, 1), cell22)).toBe(false);
  });

  it('andar ate a celula vizinha nao conta', () => {
    expect(movementEntersArea(center(0, 2), center(1, 2), cell22)).toBe(false);
  });

  it('parar dentro conta', () => {
    expect(movementEntersArea(center(1, 2), center(2, 2), cell22)).toBe(true);
  });

  it('quem ja esta dentro e continua andando nao entra de novo', () => {
    const room: TriggerArea = { kind: 'rect', x: 0, y: 0, width: 5 * G, height: 5 * G };
    expect(movementEntersArea(center(1, 1), center(2, 1), room)).toBe(false);
  });

  it('sair e voltar e uma entrada nova', () => {
    expect(movementEntersArea(center(2, 2), center(4, 2), cell22)).toBe(false);
    expect(movementEntersArea(center(4, 2), center(2, 2), cell22)).toBe(true);
  });

  it('parado nao dispara nada', () => {
    expect(movementEntersArea(center(1, 2), center(1, 2), cell22)).toBe(false);
  });
});

describe('area na borda de celula', () => {
  it('a borda conta como dentro', () => {
    expect(pointInArea({ x: 2 * G, y: 2.5 * G }, cell22)).toBe(true);
    expect(pointInArea({ x: 3 * G, y: 3 * G }, cell22)).toBe(true);
  });

  it('um movimento que termina exatamente na linha da grade entra', () => {
    expect(movementEntersArea(center(0, 2), { x: 2 * G, y: 2.5 * G }, cell22)).toBe(true);
  });

  it('deslizar exatamente ao longo da borda entra', () => {
    expect(segmentTouchesArea({ x: 0, y: 2 * G }, { x: 5 * G, y: 2 * G }, cell22)).toBe(true);
  });

  it('um pixel antes da borda nao entra', () => {
    expect(movementEntersArea(center(0, 2), { x: 2 * G - 1, y: 2.5 * G }, cell22)).toBe(false);
  });
});

describe('hexagono', () => {
  const hex: GridConfig = { ...DEFAULT_GRID, type: 'hex-pointy', size: G, offsetX: 0, offsetY: 0 };
  const target = { a: 3, b: 3 };
  const corners = cellCorners(hex, target);
  const area: TriggerArea = { kind: 'polygon', points: corners };
  const mid = cellCenter(hex, target);

  it('o centro da celula esta dentro, e os vertices tambem', () => {
    expect(pointInArea(mid, area)).toBe(true);
    for (const corner of corners) expect(pointInArea(corner, area)).toBe(true);
  });

  it('atravessar o hexagono conta', () => {
    expect(movementEntersArea({ x: mid.x - 3 * G, y: mid.y }, { x: mid.x + 3 * G, y: mid.y }, area)).toBe(true);
  });

  it('passar rente a um lado, por fora, nao conta', () => {
    // Na ponta-em-cima, os lados verticais ficam a meia largura do centro.
    const half = (Math.sqrt(3) / 2) * (G / Math.sqrt(3));
    const x = mid.x + half + 2;
    expect(movementEntersArea({ x, y: mid.y - 3 * G }, { x, y: mid.y + 3 * G }, area)).toBe(false);
  });

  it('passar exatamente por um vertice conta', () => {
    const top = corners.reduce((a, b) => (b.y < a.y ? b : a));
    expect(movementEntersArea({ x: top.x - G, y: top.y }, { x: top.x + G, y: top.y }, area)).toBe(true);
  });
});

describe('circulo', () => {
  const circle: TriggerArea = { kind: 'circle', x: 500, y: 500, radius: 100 };

  it('corta o circulo pela corda', () => {
    expect(movementEntersArea({ x: 300, y: 450 }, { x: 700, y: 450 }, circle)).toBe(true);
  });

  it('passa por fora', () => {
    expect(movementEntersArea({ x: 300, y: 380 }, { x: 700, y: 380 }, circle)).toBe(false);
  });
});

describe('quem dispara', () => {
  const area = cell22;
  const hero = createToken({ id: 'tok_hero', ownerPlayerId: 'ply_a' });
  const npc = createToken({ id: 'tok_npc' });

  it('por padrao, so tokens de jogadores', () => {
    const t = createTrigger({ id: 't1', area });
    expect(triggerAccepts(t, hero, false)).toBe(true);
    expect(triggerAccepts(t, npc, false)).toBe(false);
  });

  it('movimento do mestre nao dispara, a menos que marcado', () => {
    const t = createTrigger({ id: 't1', area });
    expect(triggerAccepts(t, hero, true)).toBe(false);
    expect(triggerAccepts({ ...t, includeGmMoves: true }, hero, true)).toBe(true);
  });

  it('qualquer token', () => {
    expect(triggerAccepts(createTrigger({ id: 't', area, who: 'any' }), npc, false)).toBe(true);
  });

  it('tokens especificos', () => {
    const t = createTrigger({ id: 't', area, who: 'tokens', tokenIds: ['tok_npc'] });
    expect(triggerAccepts(t, npc, false)).toBe(true);
    expect(triggerAccepts(t, hero, false)).toBe(false);
  });

  it('desligado ou ja disparado (uma vez) nao dispara', () => {
    expect(triggerAccepts(createTrigger({ id: 't', area, enabled: false }), hero, false)).toBe(false);
    expect(triggerAccepts(createTrigger({ id: 't', area, armed: false }), hero, false)).toBe(false);
    expect(triggerAccepts(createTrigger({ id: 't', area, mode: 'always', armed: false }), hero, false)).toBe(true);
  });

  it('triggersFiredBy junta regra e geometria', () => {
    const a = createTrigger({ id: 'a', area });
    const b = createTrigger({ id: 'b', area: { kind: 'rect', x: 900, y: 900, width: 10, height: 10 } });
    const fired = triggersFiredBy([a, b], hero, center(1, 2), center(3, 2), false);
    expect(fired.map((t) => t.id)).toEqual(['a']);
  });
});
