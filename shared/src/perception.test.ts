import { describe, expect, it } from 'vitest';

import { createEffect, createScene, createToken } from './defaults.js';
import { cellKey } from './grid.js';
import {
  enforceHallucinationRules,
  isHallucination,
  perceives,
  sanitizeVisibleTo,
} from './perception.js';
import type { Scene } from './types.js';
import { canPlayerSeeToken, computeVision, newlyExploredCells, playerSightCells } from './vision.js';

/**
 * Alucinacoes: objetos que so alguns jogadores percebem.
 *
 * A falha aqui e silenciosa do lado do mestre — ele ve tudo de qualquer
 * jeito. Quem descobre o vazamento e o jogador que nao devia saber, seja pelo
 * token na tela, seja pela neblina que abriu sem motivo.
 */

const SIZE = 100;
const ALICE = 'ply_alice';
const BRUNO = 'ply_bruno';

function scene(partial: Partial<Scene> = {}): Scene {
  return createScene({
    grid: { ...createScene().grid, size: SIZE, offsetX: 0, offsetY: 0 },
    fog: { ...createScene().fog, mode: 'vision' },
    globalLight: 0,
    ...partial,
  });
}

describe('perceives', () => {
  it('sem lista, todos percebem', () => {
    const token = createToken();
    expect(isHallucination(token)).toBe(false);
    expect(perceives(token, ALICE)).toBe(true);
    expect(perceives(token, null)).toBe(true);
  });

  it('com lista, so quem esta nela', () => {
    const token = createToken({ visibleTo: [ALICE] });
    expect(isHallucination(token)).toBe(true);
    expect(perceives(token, ALICE)).toBe(true);
    expect(perceives(token, BRUNO)).toBe(false);
    expect(perceives(token, null)).toBe(false);
  });

  it('lista vazia: so o mestre', () => {
    const effect = createEffect({ visibleTo: [] });
    expect(perceives(effect, ALICE)).toBe(false);
    expect(perceives(effect, ALICE, true)).toBe(true);
  });

  it('trata campo ausente (dado antigo) como "todos"', () => {
    const legacy = { visibleTo: undefined as unknown as null };
    expect(isHallucination(legacy)).toBe(false);
    expect(perceives(legacy, BRUNO)).toBe(true);
  });
});

describe('sanitizeVisibleTo', () => {
  const known = [ALICE, BRUNO];

  it('mantem null e descarta o que nao e lista', () => {
    expect(sanitizeVisibleTo(null, known)).toBeNull();
    expect(sanitizeVisibleTo(undefined, known)).toBeNull();
    expect(sanitizeVisibleTo('ply_alice', known)).toBeNull();
  });

  it('filtra ids desconhecidos, repetidos e que nao sao texto', () => {
    expect(sanitizeVisibleTo([ALICE, 'ply_x', ALICE, 42, BRUNO], known)).toEqual([ALICE, BRUNO]);
  });

  it('aceita a lista vazia', () => {
    expect(sanitizeVisibleTo([], known)).toEqual([]);
  });
});

describe('enforceHallucinationRules', () => {
  it('tira dono, visao e luz de uma alucinacao', () => {
    const token = enforceHallucinationRules(
      createToken({ visibleTo: [ALICE], ownerPlayerId: ALICE, visionRadius: 5, lightRadius: 3 }),
    );
    expect(token.ownerPlayerId).toBeNull();
    expect(token.visionRadius).toBe(0);
    expect(token.lightRadius).toBe(0);
  });

  it('nao mexe em token comum', () => {
    const token = enforceHallucinationRules(createToken({ ownerPlayerId: ALICE, visionRadius: 5 }));
    expect(token.ownerPlayerId).toBe(ALICE);
    expect(token.visionRadius).toBe(5);
  });
});

describe('alucinacoes e visao', () => {
  it('quem esta fora da lista nao ve o token, nem com a neblina desligada', () => {
    const s = scene({ fog: { ...createScene().fog, mode: 'off' } });
    const ghost = createToken({ visibleTo: [ALICE] });
    s.tokens.push(ghost);

    const forBruno = computeVision(s, { role: 'PLAYER', playerId: BRUNO });
    const forAlice = computeVision(s, { role: 'PLAYER', playerId: ALICE });
    expect(canPlayerSeeToken(s, ghost, forBruno, BRUNO)).toBe(false);
    expect(canPlayerSeeToken(s, ghost, forAlice, ALICE)).toBe(true);
  });

  it('a lista nao sobrepoe ocultacao nem neblina para quem esta nela', () => {
    const s = scene();
    const ghost = createToken({ visibleTo: [ALICE], x: 900, y: 900 });
    s.tokens.push(ghost);
    const forAlice = computeVision(s, { role: 'PLAYER', playerId: ALICE });
    expect(canPlayerSeeToken(s, ghost, forAlice, ALICE)).toBe(false);

    const hidden = createToken({ visibleTo: [ALICE], visibility: 'hidden' });
    const off = scene({ fog: { ...createScene().fog, mode: 'off' } });
    off.tokens.push(hidden);
    const v = computeVision(off, { role: 'PLAYER', playerId: ALICE });
    expect(canPlayerSeeToken(off, hidden, v, ALICE)).toBe(false);
  });

  it('o mestre ve qualquer alucinacao', () => {
    const s = scene();
    const ghost = createToken({ visibleTo: [] });
    s.tokens.push(ghost);
    const gm = computeVision(s, { role: 'GM', playerId: 'ply_gm' });
    expect(canPlayerSeeToken(s, ghost, gm, 'ply_gm')).toBe(true);
  });

  it('uma alucinacao com luz nao ilumina a neblina de ninguem', () => {
    const s = scene();
    // Dado mal formado de proposito: a regra vale mesmo sem o servidor zerar.
    const ghost = createToken({ visibleTo: [ALICE], lightRadius: 4, ownerPlayerId: ALICE, visionRadius: 4 });
    s.tokens.push(ghost);

    expect(playerSightCells(s, ALICE).size).toBe(0);
    expect(playerSightCells(s, BRUNO).size).toBe(0);
    for (const who of [ALICE, BRUNO]) {
      const v = computeVision(s, { role: 'PLAYER', playerId: who });
      expect(v.visible.has(cellKey({ a: 0, b: 0 }))).toBe(false);
    }
    expect(newlyExploredCells(s).size).toBe(0);
  });
});
