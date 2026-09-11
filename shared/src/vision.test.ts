import { describe, expect, it } from 'vitest';

import { createScene, createToken, createWall } from './defaults.js';
import { cellKey } from './grid.js';
import type { Scene, Token, Wall } from './types.js';
import {
  canPlayerSeeToken,
  collectBlockers,
  computeVision,
  hasLineOfSight,
  movementBlocked,
  segmentsIntersect,
  visibleWalls,
} from './vision.js';

/**
 * Visao, colisao e o que cada papel enxerga.
 *
 * E o codigo mais delicado do projeto porque as falhas sao invisiveis do lado
 * certo da tela: o mestre ve tudo funcionando enquanto o jogador atravessa uma
 * parede ou recebe no payload um token que deveria estar escondido.
 */

const SIZE = 100;

function scene(partial: Partial<Scene> = {}): Scene {
  return createScene({
    grid: { ...createScene().grid, size: SIZE, offsetX: 0, offsetY: 0 },
    fog: { ...createScene().fog, mode: 'vision' },
    ...partial,
  });
}

/** Parede vertical em x, cobrindo de y1 a y2. */
function wallAt(x: number, y1: number, y2: number, extra: Partial<Wall> = {}): Wall {
  return createWall({ x1: x, y1, x2: x, y2, ...extra });
}

describe('segmentsIntersect', () => {
  it('reconhece o cruzamento em X', () => {
    expect(
      segmentsIntersect(
        { x1: 0, y1: 0, x2: 10, y2: 10 },
        { x1: 0, y1: 10, x2: 10, y2: 0 },
      ),
    ).toBe(true);
  });

  it('nao inventa cruzamento entre paralelas', () => {
    expect(
      segmentsIntersect({ x1: 0, y1: 0, x2: 10, y2: 0 }, { x1: 0, y1: 5, x2: 10, y2: 5 }),
    ).toBe(false);
  });

  it('nao cruza quando os segmentos apenas se aproximam', () => {
    expect(
      segmentsIntersect({ x1: 0, y1: 0, x2: 4, y2: 0 }, { x1: 5, y1: -5, x2: 5, y2: 5 }),
    ).toBe(false);
  });
});

describe('hasLineOfSight', () => {
  const blockers = [{ x1: 500, y1: 0, x2: 500, y2: 1000 }];

  it('enxerga sem obstaculo no caminho', () => {
    expect(hasLineOfSight({ x: 100, y: 500 }, { x: 400, y: 500 }, [])).toBe(true);
    expect(hasLineOfSight({ x: 100, y: 500 }, { x: 400, y: 500 }, blockers)).toBe(true);
  });

  it('a parede corta a linha', () => {
    expect(hasLineOfSight({ x: 100, y: 500 }, { x: 900, y: 500 }, blockers)).toBe(false);
  });

  it('contorna a parede pela ponta', () => {
    // A parede termina em y=1000; passar por baixo dela nao e bloqueado.
    expect(hasLineOfSight({ x: 100, y: 1200 }, { x: 900, y: 1200 }, blockers)).toBe(true);
  });
});

describe('movementBlocked', () => {
  it('deixa passar onde nao ha parede', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 100, y: 100 }, { x: 400, y: 100 })).toBe(false);
  });

  it('barra o passo que atravessa a parede', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);
  });

  it('barra tambem o passo diagonal que cruza a parede', () => {
    // A regressao relatada: a validacao rodava so na soltura, e cada evento de
    // arraste ja havia gravado a posicao nova — a origem testada ja estava do
    // outro lado. Validar passo a passo depende disto funcionar na diagonal.
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 450, y: 100 }, { x: 550, y: 300 })).toBe(true);
  });

  it('nao barra o movimento nulo', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 600, y: 100 }, { x: 600, y: 100 })).toBe(false);
  });

  it('porta aberta deixa passar; fechada barra', () => {
    const fechada = scene({ walls: [wallAt(500, 0, 1000, { door: true, open: false })] });
    expect(movementBlocked(fechada, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);

    const aberta = scene({ walls: [wallAt(500, 0, 1000, { door: true, open: true })] });
    expect(movementBlocked(aberta, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(false);
  });

  it('parede secreta barra igual, mesmo sem ser desenhada', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000, { hidden: true })] });
    expect(movementBlocked(s, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);
  });
});

describe('visibleWalls', () => {
  const walls = [
    wallAt(100, 0, 100, { id: 'comum' }),
    wallAt(200, 0, 100, { id: 'porta', door: true }),
    wallAt(300, 0, 100, { id: 'secreta', hidden: true }),
    wallAt(400, 0, 100, { id: 'porta-secreta', door: true, hidden: true }),
  ];

  it('o mestre recebe todas', () => {
    expect(visibleWalls(walls, 'GM')).toHaveLength(4);
  });

  it('o jogador recebe apenas as portas nao secretas', () => {
    const seen = visibleWalls(walls, 'PLAYER');
    expect(seen.map((w) => w.id)).toEqual(['porta']);
  });
});

describe('canPlayerSeeToken', () => {
  const gmVision = { gm: true, unrestricted: true, visible: new Set<string>(), explored: new Set<string>() };
  const openVision = { gm: false, unrestricted: true, visible: new Set<string>(), explored: new Set<string>() };
  const fogged = (visible: string[]) => ({
    gm: false,
    unrestricted: false,
    visible: new Set(visible),
    explored: new Set(visible),
  });

  const at = (x: number, y: number, extra: Partial<Token> = {}) =>
    createToken({ x, y, ...extra });

  it('o mestre ve tudo, inclusive o que escondeu', () => {
    const s = scene();
    expect(canPlayerSeeToken(s, at(0, 0, { gmOnly: true }), gmVision, 'ply_1')).toBe(true);
  });

  it('desligar a neblina NAO revela o token oculto do mestre', () => {
    // O vazamento real: `unrestricted` juntava "sem neblina" com "ve tudo", e a
    // checagem de gmOnly vinha depois. Sem neblina, o jogador recebia no
    // payload os tokens que o mestre havia escondido.
    const s = scene();
    expect(canPlayerSeeToken(s, at(0, 0, { gmOnly: true }), openVision, 'ply_1')).toBe(false);
    expect(canPlayerSeeToken(s, at(0, 0, { visibility: 'hidden' }), openVision, 'ply_1')).toBe(false);
  });

  it('o dono ve o proprio token mesmo fora da area iluminada', () => {
    const s = scene();
    const meu = at(5000, 5000, { ownerPlayerId: 'ply_1' });
    expect(canPlayerSeeToken(s, meu, fogged([]), 'ply_1')).toBe(true);
  });

  it('o dono NAO ve o proprio token se o mestre o escondeu', () => {
    const s = scene();
    const meu = at(0, 0, { ownerPlayerId: 'ply_1', gmOnly: true });
    expect(canPlayerSeeToken(s, meu, fogged([]), 'ply_1')).toBe(false);
  });

  it('token na neblina fica invisivel; na area iluminada aparece', () => {
    const s = scene();
    // O canto em (250,250) poe o centro em (300,300): a celula do token e a
    // (3,3), e nao a (2,2) onde o canto cai.
    const alvo = at(250, 250);
    expect(canPlayerSeeToken(s, alvo, fogged([]), 'ply_1')).toBe(false);
    expect(canPlayerSeeToken(s, alvo, fogged([cellKey({ a: 2, b: 2 })]), 'ply_1')).toBe(false);
    expect(canPlayerSeeToken(s, alvo, fogged([cellKey({ a: 3, b: 3 })]), 'ply_1')).toBe(true);
  });

  it('token grande aparece se qualquer celula que ocupa estiver iluminada', () => {
    const s = scene();
    const grande = at(200, 200, { scale: 3 });
    // Ocupa de (2,2) a (4,4); iluminar so um canto ja basta.
    expect(canPlayerSeeToken(s, grande, fogged([cellKey({ a: 4, b: 4 })]), 'ply_1')).toBe(true);
  });

  it('com a neblina desligada na cena, o token comum aparece', () => {
    const s = scene({ fog: { ...scene().fog, mode: 'off' } });
    expect(canPlayerSeeToken(s, at(9999, 9999), fogged([]), 'ply_1')).toBe(true);
  });
});

describe('computeVision', () => {
  it('o mestre vem marcado como gm e sem restricao', () => {
    const s = scene();
    const v = computeVision(s, { playerId: null, role: 'GM' });
    expect(v.gm).toBe(true);
    expect(v.unrestricted).toBe(true);
  });

  it('o jogador nao vem marcado como gm', () => {
    const s = scene();
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });
    expect(v.gm).toBe(false);
  });

  it('com a neblina desligada o jogador fica sem restricao, mas nao vira gm', () => {
    // A distincao que fecha o vazamento: sem neblina, ele ve o cenario todo;
    // continua sem direito ao que o mestre escondeu.
    const s = scene({ fog: { ...scene().fog, mode: 'off' } });
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });
    expect(v.unrestricted).toBe(true);
    expect(v.gm).toBe(false);
  });

  it('a parede limita o que o token do jogador enxerga', () => {
    const s = scene({
      walls: [wallAt(500, 0, 2000)],
      tokens: [createToken({ x: 100, y: 100, ownerPlayerId: 'ply_1', visionRadius: 20 })],
    });
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });

    // Perto e do mesmo lado: visivel. Do outro lado da parede: nao.
    expect(v.visible.has(cellKey({ a: 3, b: 1 }))).toBe(true);
    expect(v.visible.has(cellKey({ a: 8, b: 1 }))).toBe(false);
  });
});

describe('juntas de parede', () => {
  // Canto em L com o vertice em (500, 500): uma parede vertical subindo e uma
  // horizontal indo para a direita. O raio diagonal passa EXATAMENTE pelo
  // vertice, que e o que acontece entre centros de celula numa grade.
  const corner = [wallAt(500, 0, 500), createWall({ x1: 500, y1: 500, x2: 1000, y2: 500 })];

  it('um raio exatamente pelo vertice de um canto e barrado', () => {
    const s = scene({ walls: corner });
    expect(movementBlocked(s, { x: 450, y: 550 }, { x: 550, y: 450 })).toBe(true);
    expect(hasLineOfSight({ x: 450, y: 550 }, { x: 550, y: 450 }, collectBlockers(s))).toBe(false);
  });

  it('token parado sobre a linha da parede nao fica cego por ela', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(hasLineOfSight({ x: 500, y: 300 }, { x: 300, y: 300 }, collectBlockers(s))).toBe(true);
  });

  it('raio paralelo que corre ao longo da parede nao e barrado', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(hasLineOfSight({ x: 500, y: 1100 }, { x: 500, y: 1200 }, collectBlockers(s))).toBe(true);
  });
});

describe('janelas', () => {
  const window = wallAt(500, 0, 1000, { window: true });

  it('deixam ver o outro lado', () => {
    const s = scene({ walls: [window] });
    expect(hasLineOfSight({ x: 400, y: 100 }, { x: 600, y: 100 }, collectBlockers(s, 'vision'))).toBe(true);
  });

  it('barram a passagem', () => {
    const s = scene({ walls: [window] });
    expect(movementBlocked(s, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);
  });

  it('a visao calculada alcanca o outro lado da janela', () => {
    const s = scene({
      walls: [window],
      tokens: [createToken({ x: 400, y: 100, ownerPlayerId: 'ply_1', visionRadius: 5 })],
    });
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });
    expect(v.visible.has(cellKey({ a: 6, b: 1 }))).toBe(true);
  });

  it('o jogador enxerga a janela desenhada, mas nao a parede comum', () => {
    const seen = visibleWalls(
      [wallAt(100, 0, 100, { id: 'comum' }), wallAt(200, 0, 100, { id: 'janela', window: true })],
      'PLAYER',
    );
    expect(seen.map((w) => w.id)).toEqual(['janela']);
  });

  it('uma parede nao pode ser porta e janela ao mesmo tempo', () => {
    expect(createWall({ door: true, window: true }).window).toBe(false);
  });
});
