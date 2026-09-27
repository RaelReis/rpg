import { describe, expect, it } from 'vitest';

import { createScene, createToken, createTrigger } from './defaults.js';
import { cellCenter, cellCorners } from './grid.js';
import {
  pointInArea,
  sanitizeAction,
  sanitizeTrigger,
  segmentEntersArea,
  segmentTouchesArea,
  triggerAccepts,
  triggersEntered,
} from './triggers.js';
import type { GridConfig, TriggerArea } from './types.js';

/**
 * Gatilhos: geometria de entrada e quem dispara.
 *
 * A falha tipica e silenciosa — a armadilha simplesmente nao cai, porque o
 * token passou rapido demais ou parou exatamente na borda.
 */

const G = 100;
const square: GridConfig = { ...createScene().grid, type: 'square', size: G, offsetX: 0, offsetY: 0 };

/** Retangulo cobrindo as celulas [a0..a1] x [b0..b1], com borda nas linhas da grade. */
function cellsRect(a0: number, b0: number, a1: number, b1: number): TriggerArea {
  return { kind: 'rect', x: a0 * G, y: b0 * G, width: (a1 - a0 + 1) * G, height: (b1 - b0 + 1) * G };
}

const center = (a: number, b: number) => cellCenter(square, { a, b });

describe('pointInArea', () => {
  it('retangulo, com a borda contando como dentro', () => {
    const area = cellsRect(2, 2, 3, 3);
    expect(pointInArea(area, { x: 250, y: 250 })).toBe(true);
    expect(pointInArea(area, { x: 200, y: 250 })).toBe(true);
    expect(pointInArea(area, { x: 199, y: 250 })).toBe(false);
  });

  it('circulo', () => {
    const area: TriggerArea = { kind: 'circle', x: 0, y: 0, radius: 50 };
    expect(pointInArea(area, { x: 30, y: 40 })).toBe(true);
    expect(pointInArea(area, { x: 40, y: 40 })).toBe(false);
  });

  it('poligono concavo (em L)', () => {
    const area: TriggerArea = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 100 },
        { x: 100, y: 100 },
        { x: 100, y: 200 },
        { x: 0, y: 200 },
      ],
    };
    expect(pointInArea(area, { x: 50, y: 150 })).toBe(true);
    expect(pointInArea(area, { x: 150, y: 50 })).toBe(true);
    // O "buraco" do L fica de fora.
    expect(pointInArea(area, { x: 150, y: 150 })).toBe(false);
  });
});

describe('segmentEntersArea', () => {
  it('um arraste rapido que atravessa a area inteira dispara', () => {
    const area = cellsRect(5, 1, 5, 1);
    // De (1,1) a (10,1) num unico evento: nem a origem nem o destino estao dentro.
    expect(pointInArea(area, center(10, 1))).toBe(false);
    expect(segmentEntersArea(area, center(1, 1), center(10, 1))).toBe(true);
  });

  it('um caminho que passa ao lado nao dispara', () => {
    const area = cellsRect(5, 1, 5, 1);
    expect(segmentEntersArea(area, center(1, 2), center(10, 2))).toBe(false);
  });

  it('quem ja esta dentro e se move la dentro nao dispara de novo', () => {
    const area = cellsRect(2, 2, 4, 4);
    expect(segmentEntersArea(area, center(2, 2), center(4, 4))).toBe(false);
  });

  it('sair e voltar conta como nova entrada', () => {
    const area = cellsRect(2, 2, 2, 2);
    expect(segmentEntersArea(area, center(2, 2), center(1, 2))).toBe(false);
    expect(segmentEntersArea(area, center(1, 2), center(2, 2))).toBe(true);
  });

  it('circulo atravessado de raspao', () => {
    const area: TriggerArea = { kind: 'circle', x: 500, y: 500, radius: 60 };
    expect(segmentEntersArea(area, { x: 0, y: 540 }, { x: 1000, y: 540 })).toBe(true);
    expect(segmentEntersArea(area, { x: 0, y: 580 }, { x: 1000, y: 580 })).toBe(false);
  });
});

describe('area na borda de celula', () => {
  // A area cobre exatamente a celula (3,3). Centros de token ficam no meio das
  // celulas, meia celula longe da borda.
  const area = cellsRect(3, 3, 3, 3);

  it('andar pela coluna vizinha, paralelo a borda, nao dispara', () => {
    expect(segmentEntersArea(area, center(2, 0), center(2, 8))).toBe(false);
    expect(segmentEntersArea(area, center(4, 0), center(4, 8))).toBe(false);
  });

  it('entrar na celula dispara', () => {
    expect(segmentEntersArea(area, center(2, 3), center(3, 3))).toBe(true);
  });

  it('parar exatamente na borda (sem encaixe na grade) conta como entrar', () => {
    expect(segmentEntersArea(area, center(2, 3), { x: 300, y: 350 })).toBe(true);
  });

  it('a diagonal entre duas celulas vizinhas toca a quina e dispara', () => {
    // De (2,2) a (4,4) o centro passa exatamente pelo meio da celula (3,3).
    expect(segmentEntersArea(area, center(2, 2), center(4, 4))).toBe(true);
    // De (2,4) a (4,4) passa pela linha de baixo, fora da celula (3,3).
    expect(segmentEntersArea(area, center(2, 4), center(4, 4))).toBe(false);
  });
});

describe('hexagono', () => {
  const hex: GridConfig = { ...square, type: 'hex-pointy' };
  const cell = { a: 3, b: 2 };
  const area: TriggerArea = { kind: 'polygon', points: cellCorners(hex, cell) };

  it('o centro da celula esta dentro, o do vizinho nao', () => {
    expect(pointInArea(area, cellCenter(hex, cell))).toBe(true);
    expect(pointInArea(area, cellCenter(hex, { a: 4, b: 2 }))).toBe(false);
  });

  it('entrar vindo de um vizinho dispara', () => {
    expect(segmentEntersArea(area, cellCenter(hex, { a: 4, b: 2 }), cellCenter(hex, cell))).toBe(true);
  });

  it('andar entre dois vizinhos pelo lado de fora nao dispara', () => {
    // (4,1) e (4,2) sao vizinhos entre si e do hexagono (3,2); o segmento entre
    // os centros cruza a aresta que ELES compartilham pelo meio, e so toca o
    // hexagono na quina em comum dos tres — longe do caminho.
    expect(segmentEntersArea(area, cellCenter(hex, { a: 4, b: 1 }), cellCenter(hex, { a: 4, b: 2 }))).toBe(false);
  });

  it('atravessar o hexagono de ponta a ponta dispara', () => {
    expect(segmentTouchesArea(area, cellCenter(hex, { a: 1, b: 2 }), cellCenter(hex, { a: 5, b: 2 }))).toBe(true);
  });
});

describe('quem dispara', () => {
  const scene = createScene({ grid: square });
  const hero = createToken({ id: 'hero', ownerPlayerId: 'ply_a', x: 100, y: 100 });
  const npc = createToken({ id: 'npc', x: 100, y: 100 });

  it('por padrao: so token de jogador, e nao em movimento do mestre', () => {
    const t = createTrigger(cellsRect(5, 1, 5, 1));
    expect(triggerAccepts(t, hero, false)).toBe(true);
    expect(triggerAccepts(t, npc, false)).toBe(false);
    expect(triggerAccepts(t, hero, true)).toBe(false);
    expect(triggerAccepts({ ...t, gmMoves: true }, hero, true)).toBe(true);
  });

  it('qualquer token, ou so os escolhidos', () => {
    const any = createTrigger(cellsRect(5, 1, 5, 1), { who: 'any' });
    expect(triggerAccepts(any, npc, false)).toBe(true);
    const some = createTrigger(cellsRect(5, 1, 5, 1), { who: 'tokens', tokenIds: ['npc'] });
    expect(triggerAccepts(some, npc, false)).toBe(true);
    expect(triggerAccepts(some, hero, false)).toBe(false);
  });

  it('desarmado ou desligado nao dispara', () => {
    const t = createTrigger(cellsRect(5, 1, 5, 1));
    expect(triggerAccepts({ ...t, armed: false }, hero, false)).toBe(false);
    expect(triggerAccepts({ ...t, armed: false, mode: 'always' }, hero, false)).toBe(true);
    expect(triggerAccepts({ ...t, enabled: false }, hero, false)).toBe(false);
  });

  it('triggersEntered usa o centro do token e o caminho inteiro', () => {
    const s = { ...scene, triggers: [createTrigger(cellsRect(5, 1, 5, 1), { id: 'trap' })] };
    // Token 1x1: canto (100,100) = centro da celula (1,1).
    const hit = triggersEntered(s, hero, { x: 100, y: 100 }, { x: 1000, y: 100 }, false);
    expect(hit.map((t) => t.id)).toEqual(['trap']);
    expect(triggersEntered(s, hero, { x: 100, y: 200 }, { x: 1000, y: 200 }, false)).toEqual([]);
  });
});

describe('normalizacao', () => {
  it('descarta area degenerada e acao desconhecida', () => {
    const base = createTrigger(cellsRect(0, 0, 0, 0));
    expect(sanitizeTrigger({ area: { kind: 'polygon', points: [{ x: 0, y: 0 }] } }, base)).toBeNull();
    expect(sanitizeAction({ type: 'explode' }, 'x')).toBeNull();
  });

  it('mantem o que nao veio no patch', () => {
    const base = createTrigger(cellsRect(0, 0, 0, 0), { name: 'Porta', mode: 'always' });
    const next = sanitizeTrigger({ name: 'Porta rangente' }, base)!;
    expect(next.name).toBe('Porta rangente');
    expect(next.mode).toBe('always');
    expect(next.area).toEqual(base.area);
  });

  it('efeito de tela da acao passa pela mesma normalizacao', () => {
    const action = sanitizeAction({ type: 'screen', target: 'all', effect: { kind: 'flash', durationMs: 5 } }, 'a');
    expect(action?.type === 'screen' && action.effect.durationMs).toBe(250);
  });
});
