import { describe, expect, it } from 'vitest';

import { createEffect, createScene, createToken } from './defaults.js';
import {
  canPlayerSeeEffect,
  emitsVision,
  inVisibleTo,
  isRestricted,
  sanitizeVisibleTo,
} from './perception.js';
import type { Scene, Token } from './types.js';
import { canPlayerSeeToken, computeVision, newlyExploredCells, visionSources } from './vision.js';

/**
 * Alucinacoes: objetos que so alguns jogadores enxergam.
 *
 * A falha que importa aqui e silenciosa do lado do mestre: ele ve tudo certo
 * enquanto o jogador errado recebe o objeto, ou enquanto a neblina de alguem
 * clareia por causa de uma luz que ele nem deveria saber que existe.
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

function hallucination(extra: Partial<Token> = {}): Token {
  return createToken({ id: 'tok_vulto', x: 500, y: 500, visibleTo: [ALICE], ...extra });
}

describe('inVisibleTo', () => {
  it('sem lista, todos enxergam', () => {
    const token = createToken();
    expect(token.visibleTo).toBeNull();
    expect(inVisibleTo(token, 'PLAYER', ALICE)).toBe(true);
    expect(isRestricted(token)).toBe(false);
  });

  it('com lista, so quem esta nela', () => {
    const token = hallucination();
    expect(inVisibleTo(token, 'PLAYER', ALICE)).toBe(true);
    expect(inVisibleTo(token, 'PLAYER', BRUNO)).toBe(false);
    expect(inVisibleTo(token, 'PLAYER', null)).toBe(false);
  });

  it('o mestre sempre enxerga', () => {
    expect(inVisibleTo(hallucination({ visibleTo: [] }), 'GM', 'ply_gm')).toBe(true);
  });

  it('lista vazia esconde de todos os jogadores', () => {
    const token = hallucination({ visibleTo: [] });
    expect(inVisibleTo(token, 'PLAYER', ALICE)).toBe(false);
    expect(isRestricted(token)).toBe(true);
  });
});

describe('canPlayerSeeToken com alucinacao', () => {
  it('a neblina desligada nao entrega a alucinacao a quem nao esta na lista', () => {
    const s = scene({ fog: { ...scene().fog, mode: 'off' } });
    const token = hallucination();
    s.tokens.push(token);
    const alice = computeVision(s, { role: 'PLAYER', playerId: ALICE });
    const bruno = computeVision(s, { role: 'PLAYER', playerId: BRUNO });
    expect(canPlayerSeeToken(s, token, alice, ALICE)).toBe(true);
    expect(canPlayerSeeToken(s, token, bruno, BRUNO)).toBe(false);
  });

  it('a luz do dia nao entrega a alucinacao', () => {
    const s = scene({ globalLight: 1 });
    s.tokens.push(createToken({ x: 400, y: 500, ownerPlayerId: BRUNO, visionRadius: 3 }));
    const token = hallucination();
    s.tokens.push(token);
    const bruno = computeVision(s, { role: 'PLAYER', playerId: BRUNO });
    expect(bruno.visible.size).toBeGreaterThan(0);
    expect(canPlayerSeeToken(s, token, bruno, BRUNO)).toBe(false);
  });

  it('para quem esta na lista, a neblina continua valendo', () => {
    const s = scene();
    const token = hallucination();
    s.tokens.push(token);
    // Alice sem nenhum token com visao: tudo escuro, alucinacao inclusive.
    const alice = computeVision(s, { role: 'PLAYER', playerId: ALICE });
    expect(canPlayerSeeToken(s, token, alice, ALICE)).toBe(false);

    s.tokens.push(createToken({ x: 400, y: 500, ownerPlayerId: ALICE, visionRadius: 3 }));
    const lit = computeVision(s, { role: 'PLAYER', playerId: ALICE });
    expect(canPlayerSeeToken(s, token, lit, ALICE)).toBe(true);
  });

  it('o mestre sempre ve', () => {
    const s = scene();
    const token = hallucination({ visibleTo: [] });
    s.tokens.push(token);
    expect(canPlayerSeeToken(s, token, computeVision(s, { role: 'GM', playerId: 'gm' }), 'gm')).toBe(true);
  });
});

describe('alucinacao nao emite luz nem visao', () => {
  it('uma tocha alucinada nao ilumina ninguem', () => {
    const s = scene();
    s.tokens.push(hallucination({ lightRadius: 4 }));
    expect(emitsVision(s.tokens[0])).toBe(false);
    expect(visionSources(s, ALICE)).toHaveLength(0);
    // Nem para quem a enxerga: se clareasse para Alice, a luz real da mesma
    // sala se comportaria diferente para ela e para Bruno.
    expect(computeVision(s, { role: 'PLAYER', playerId: ALICE }).visible.size).toBe(0);
    expect(computeVision(s, { role: 'PLAYER', playerId: BRUNO }).visible.size).toBe(0);
  });

  it('a mesma tocha, real, ilumina todos', () => {
    const s = scene();
    s.tokens.push(createToken({ x: 500, y: 500, lightRadius: 4 }));
    expect(computeVision(s, { role: 'PLAYER', playerId: BRUNO }).visible.size).toBeGreaterThan(0);
  });

  it('nao acumula area explorada', () => {
    const s = scene();
    s.tokens.push(hallucination({ lightRadius: 4, visionRadius: 4 }));
    expect(newlyExploredCells(s)).toEqual([]);
  });
});

describe('canPlayerSeeEffect', () => {
  it('respeita a propria lista', () => {
    const s = scene();
    const effect = createEffect({ visibleTo: [BRUNO] });
    expect(canPlayerSeeEffect(s, effect, BRUNO)).toBe(true);
    expect(canPlayerSeeEffect(s, effect, ALICE)).toBe(false);
  });

  it('preso a uma alucinacao, herda a restricao dela', () => {
    const s = scene();
    s.tokens.push(hallucination());
    const aura = createEffect({ anchor: 'token', tokenId: 'tok_vulto' });
    expect(canPlayerSeeEffect(s, aura, ALICE)).toBe(true);
    expect(canPlayerSeeEffect(s, aura, BRUNO)).toBe(false);
  });

  it('continua obedecendo gmOnly e oculto', () => {
    const s = scene();
    expect(canPlayerSeeEffect(s, createEffect({ gmOnly: true }), ALICE)).toBe(false);
    expect(canPlayerSeeEffect(s, createEffect({ visibility: 'hidden' }), ALICE)).toBe(false);
    expect(canPlayerSeeEffect(s, createEffect(), ALICE)).toBe(true);
  });
});

describe('sanitizeVisibleTo', () => {
  it('nao-lista vira sem restricao', () => {
    expect(sanitizeVisibleTo(null, [ALICE])).toBeNull();
    expect(sanitizeVisibleTo('ply_alice', [ALICE])).toBeNull();
  });

  it('descarta ids desconhecidos e repetidos', () => {
    expect(sanitizeVisibleTo([ALICE, 'lixo', ALICE, 3], [ALICE, BRUNO])).toEqual([ALICE]);
  });
});

describe('cenas antigas', () => {
  it('token gravado antes do campo chega sem restricao', () => {
    const legacy = { id: 'tok_old', name: 'Velho' } as unknown as Token;
    const s = createScene({ tokens: [legacy] });
    expect(s.tokens[0].visibleTo).toBeNull();
    expect(s.tokens[0].id).toBe('tok_old');
  });
});
