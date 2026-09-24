import { describe, expect, it } from 'vitest';

import {
  FLASH_MIN_INTERVAL_MS,
  flashAllowed,
  reduceScreenEffect,
  sanitizeCardDuration,
  sanitizeScreenEffect,
  type ScreenEffect,
} from './screen.js';

/**
 * Efeitos de tela: o que o mestre pede, o que o servidor aceita e como o
 * efeito chega a quem pediu menos movimento na tela.
 */

function effect(partial: Partial<ScreenEffect>): ScreenEffect {
  return {
    id: 'fx_1',
    kind: 'flash',
    color: '#ffffff',
    intensity: 1,
    durationMs: 300,
    fadeMs: 0,
    elapsedMs: 0,
    ...partial,
  };
}

describe('sanitizeScreenEffect', () => {
  it('tremor e flash nunca sao fixos', () => {
    expect(sanitizeScreenEffect('shake', { durationMs: null }).durationMs).not.toBeNull();
    expect(sanitizeScreenEffect('flash', { durationMs: null }).durationMs).not.toBeNull();
  });

  it('vinheta, desfoque e apagao podem ser fixos', () => {
    expect(sanitizeScreenEffect('vignette', { durationMs: null }).durationMs).toBeNull();
    expect(sanitizeScreenEffect('blur', { durationMs: null }).durationMs).toBeNull();
    expect(sanitizeScreenEffect('blackout', { durationMs: null }).durationMs).toBeNull();
  });

  it('limita duracao, intensidade e fade', () => {
    const shake = sanitizeScreenEffect('shake', { durationMs: 999_999, intensity: 7 });
    expect(shake.durationMs).toBe(10_000);
    expect(shake.intensity).toBe(1);
    expect(sanitizeScreenEffect('flash', { durationMs: 1 }).durationMs).toBe(100);
    expect(sanitizeScreenEffect('blackout', { fadeMs: 60_000 }).fadeMs).toBe(5_000);
    // Fade so existe no apagao.
    expect(sanitizeScreenEffect('vignette', { fadeMs: 900 }).fadeMs).toBe(0);
  });

  it('cor invalida cai no padrao do efeito', () => {
    expect(sanitizeScreenEffect('flash', { color: 'url(javascript:1)' }).color).toBe('#ffffff');
    expect(sanitizeScreenEffect('vignette', { color: '#a4161a' }).color).toBe('#a4161a');
  });
});

describe('reduceScreenEffect', () => {
  it('o tremor some', () => {
    expect(reduceScreenEffect(effect({ kind: 'shake' }))).toBeNull();
  });

  it('o flash vira uma vinheta suave da mesma cor', () => {
    const reduced = reduceScreenEffect(effect({ kind: 'flash', color: '#ff0000', intensity: 1, durationMs: 150 }));
    expect(reduced?.kind).toBe('vignette');
    expect(reduced?.color).toBe('#ff0000');
    expect(reduced!.intensity).toBeLessThan(0.5);
    // Nao pode virar outro piscar rapido.
    expect(reduced!.durationMs).toBeGreaterThanOrEqual(900);
  });

  it('o resto passa como veio', () => {
    const blackout = effect({ kind: 'blackout', durationMs: null, fadeMs: 800 });
    expect(reduceScreenEffect(blackout)).toBe(blackout);
    const blur = effect({ kind: 'blur' });
    expect(reduceScreenEffect(blur)).toBe(blur);
  });
});

describe('flashAllowed', () => {
  it('o primeiro flash sempre sai', () => {
    expect(flashAllowed(null, 0)).toBe(true);
  });

  it('nunca mais de 3 flashes em qualquer janela de 1 segundo', () => {
    // O mestre martelando o botao a cada 50ms por 5 segundos.
    const fired: number[] = [];
    let last: number | null = null;
    for (let t = 0; t <= 5000; t += 50) {
      if (flashAllowed(last, t)) {
        fired.push(t);
        last = t;
      }
    }
    for (const start of fired) {
      const inWindow = fired.filter((t) => t >= start && t < start + 1000);
      expect(inWindow.length).toBeLessThanOrEqual(3);
    }
    expect(fired[1] - fired[0]).toBeGreaterThanOrEqual(FLASH_MIN_INTERVAL_MS);
  });
});

describe('sanitizeCardDuration', () => {
  it('null e "ate o mestre fechar"', () => {
    expect(sanitizeCardDuration(null)).toBeNull();
  });

  it('limita e usa o padrao para lixo', () => {
    expect(sanitizeCardDuration(10)).toBe(1_000);
    expect(sanitizeCardDuration('x' as unknown)).toBe(6000);
  });
});
