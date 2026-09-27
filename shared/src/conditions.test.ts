import { describe, expect, it } from 'vitest';

import { createScene, createToken, normalizeConditions } from './defaults.js';

/**
 * Condicoes passaram a ser gravadas por id. Tokens antigos guardavam o emoji;
 * se a conversao falhar, a condicao some do mapa sem aviso.
 */
describe('normalizeConditions', () => {
  it('converte os emojis antigos no id da condicao', () => {
    expect(normalizeConditions(['💫', '🔥', '💀'])).toEqual(['stunned', 'burning', 'dead']);
  });

  it('aceita as duas grafias da seta de caido', () => {
    expect(normalizeConditions(['⬇️'])).toEqual(['prone']);
    expect(normalizeConditions(['⬇'])).toEqual(['prone']);
  });

  it('mantem ids validos e descarta o que nao conhece', () => {
    expect(normalizeConditions(['blessed', 'inventada', 42, null])).toEqual(['blessed']);
  });

  it('nao repete a condicao marcada pelos dois formatos', () => {
    expect(normalizeConditions(['🔥', 'burning'])).toEqual(['burning']);
  });

  it('entrada invalida vira lista vazia', () => {
    expect(normalizeConditions(undefined)).toEqual([]);
    expect(normalizeConditions('stunned')).toEqual([]);
  });

  it('a cena carregada ja chega com os tokens migrados', () => {
    const legacy = createToken({ conditions: ['🧪', '✨'] });
    const scene = createScene({ tokens: [legacy] });
    expect(scene.tokens[0].conditions).toEqual(['poisoned', 'blessed']);
  });
});
