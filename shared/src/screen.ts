import type { ScreenEffect, ScreenEffectKind } from './types.js';

/**
 * Efeitos de tela: regras que servidor e cliente precisam conhecer.
 *
 * O servidor normaliza o pedido do mestre e aplica a preferencia de
 * acessibilidade de cada jogador ANTES de enviar — quem pediu "reduzir
 * efeitos" nem recebe o tremor. O cliente aplica o mesmo teto de flashes como
 * segunda barreira, para o caso de eventos chegarem em rajada.
 */

export const SCREEN_EFFECT_KINDS: ScreenEffectKind[] = ['shake', 'flash', 'vignette', 'blur', 'blackout'];

/** Efeitos que fazem sentido sem prazo: ficam ate o mestre remover. */
export const FIXABLE_SCREEN_EFFECTS: ScreenEffectKind[] = ['vignette', 'blur', 'blackout'];

/**
 * Intervalo minimo entre dois flashes na tela de uma pessoa.
 *
 * Mais de 3 clarões por segundo e o limiar classico de risco para quem tem
 * epilepsia fotossensivel (WCAG 2.3.1). Um flash que chegue antes disso e
 * descartado, venha do mestre clicando rapido ou de gatilhos em sequencia.
 */
export const FLASH_MIN_INTERVAL_MS = 334;

/** Fade de entrada e saida do apagao. */
export const BLACKOUT_FADE_MS = 800;

const LIMITS: Record<ScreenEffectKind, { min: number; max: number; fallback: number }> = {
  shake: { min: 200, max: 8000, fallback: 800 },
  // Um flash nunca e mais curto que isso: piscar rapido demais e o que se quer evitar.
  flash: { min: 250, max: 3000, fallback: 600 },
  vignette: { min: 500, max: 600000, fallback: 4000 },
  blur: { min: 500, max: 600000, fallback: 4000 },
  blackout: { min: BLACKOUT_FADE_MS * 2, max: 600000, fallback: 4000 },
};

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

/**
 * Normaliza o que o cliente mandou num efeito completo. `durationMs: null`
 * so vale para os efeitos que podem ser fixos; tremor e flash sempre acabam.
 */
export function sanitizeScreenEffect(raw: Partial<ScreenEffect> | undefined, id: string): ScreenEffect | null {
  const kind = raw?.kind;
  if (!kind || !SCREEN_EFFECT_KINDS.includes(kind)) return null;

  const limits = LIMITS[kind];
  const fixed = raw?.durationMs === null && FIXABLE_SCREEN_EFFECTS.includes(kind);

  return {
    id,
    kind,
    color: color(raw?.color, kind === 'flash' ? '#ffffff' : '#000000'),
    intensity: clamp(raw?.intensity, 0, 1, 0.6),
    durationMs: fixed ? null : clamp(raw?.durationMs, limits.min, limits.max, limits.fallback),
  };
}

/**
 * Versao do efeito para quem pediu para reduzir efeitos de tela.
 *
 * O flash vira uma vinheta suave da mesma cor — o sinal de "algo aconteceu"
 * continua, sem o clarao. O tremor simplesmente nao acontece: nao ha versao
 * branda de sacudir a tela que ajude quem tem enjoo de movimento. Devolve
 * `null` quando nada deve ser enviado.
 */
export function reduceScreenEffect(effect: ScreenEffect): ScreenEffect | null {
  switch (effect.kind) {
    case 'shake':
      return null;
    case 'flash':
      return {
        ...effect,
        kind: 'vignette',
        intensity: Math.min(effect.intensity, 0.35),
        durationMs: Math.max(effect.durationMs ?? 0, 1200),
      };
    default:
      return effect;
  }
}

/** Este flash respeita o intervalo minimo desde o ultimo? */
export function flashAllowed(lastFlashAt: number | undefined, now: number): boolean {
  return lastFlashAt === undefined || now - lastFlashAt >= FLASH_MIN_INTERVAL_MS;
}
