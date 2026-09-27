import { describe, expect, it } from 'vitest';

import {
  FLASH_MIN_INTERVAL_MS,
  flashAllowed,
  reduceScreenEffect,
  sanitizeScreenEffect,
} from './screen.js';

/**
 * Efeitos de tela e acessibilidade.
 *
 * A reducao e uma promessa para quem tem epilepsia fotossensivel ou enjoo de
 * movimento: se ela falhar, a pessoa descobre do pior jeito.
 */

describe('sanitizeScreenEffect', () => {
  it('recusa tipo desconhecido', () => {
    expect(sanitizeScreenEffect({ kind: 'strobe' as never }, 'x')).toBeNull();
    expect(sanitizeScreenEffect(undefined, 'x')).toBeNull();
  });

  it('tremor e flash sempre tem duracao, mesmo pedindo fixo', () => {
    expect(sanitizeScreenEffect({ kind: 'shake', durationMs: null }, 'a')?.durationMs).toBe(800);
    expect(sanitizeScreenEffect({ kind: 'flash', durationMs: null }, 'b')?.durationMs).toBe(600);
  });

  it('vinheta, desfoque e apagao podem ser fixos', () => {
    for (const kind of ['vignette', 'blur', 'blackout'] as const) {
      expect(sanitizeScreenEffect({ kind, durationMs: null }, kind)?.durationMs).toBeNull();
    }
  });

  it('um flash nunca e curto o bastante para piscar', () => {
    expect(sanitizeScreenEffect({ kind: 'flash', durationMs: 20 }, 'c')?.durationMs).toBe(250);
  });

  it('limita intensidade e descarta cor invalida', () => {
    const effect = sanitizeScreenEffect({ kind: 'vignette', intensity: 7, color: 'red; x' }, 'd');
    expect(effect?.intensity).toBe(1);
    expect(effect?.color).toBe('#000000');
  });
});

describe('reduceScreenEffect', () => {
  it('o tremor nao e enviado', () => {
    const shake = sanitizeScreenEffect({ kind: 'shake', intensity: 1 }, 's')!;
    expect(reduceScreenEffect(shake)).toBeNull();
  });

  it('o flash vira uma vinheta suave da mesma cor', () => {
    const flash = sanitizeScreenEffect({ kind: 'flash', color: '#ff0000', intensity: 1, durationMs: 400 }, 'f')!;
    const reduced = reduceScreenEffect(flash);
    expect(reduced?.kind).toBe('vignette');
    expect(reduced?.color).toBe('#ff0000');
    expect(reduced?.intensity).toBeLessThanOrEqual(0.35);
    expect(reduced?.durationMs).toBeGreaterThanOrEqual(1200);
    expect(reduced?.id).toBe('f');
  });

  it('os demais passam como estao', () => {
    const blur = sanitizeScreenEffect({ kind: 'blur', durationMs: null }, 'b')!;
    expect(reduceScreenEffect(blur)).toEqual(blur);
  });
});

describe('flashAllowed', () => {
  it('no maximo 3 flashes por segundo', () => {
    expect(flashAllowed(undefined, 1000)).toBe(true);
    expect(flashAllowed(1000, 1000 + FLASH_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(flashAllowed(1000, 1000 + FLASH_MIN_INTERVAL_MS)).toBe(true);

    // Rajada de 10 pedidos em 1s: passam no maximo 3.
    let last: number | undefined;
    let passed = 0;
    for (let t = 0; t < 1000; t += 100) {
      if (flashAllowed(last, t)) {
        passed++;
        last = t;
      }
    }
    expect(passed).toBeLessThanOrEqual(3);
  });
});
