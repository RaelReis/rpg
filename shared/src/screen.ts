/**
 * Efeitos de tela e cartelas de cena.
 *
 * Os dois vivem fora do mapa: sao desenhados numa camada de interface acima
 * dele, independente da camera. Um tremor sacode a tela de quem joga, e nao o
 * terreno; uma cartela cobre tudo, e nao um canto do mapa.
 *
 * Este modulo tem as regras que os dois lados precisam conhecer: o servidor
 * normaliza o que o mestre pede, e o cliente adapta o efeito para quem pediu
 * menos movimento na tela.
 */

export type ScreenEffectKind = 'shake' | 'flash' | 'vignette' | 'blur' | 'blackout';

export const SCREEN_EFFECT_KINDS: ScreenEffectKind[] = ['shake', 'flash', 'vignette', 'blur', 'blackout'];

/** Efeitos que podem ficar na tela ate o mestre remover. */
export const FIXABLE_SCREEN_EFFECTS: ScreenEffectKind[] = ['vignette', 'blur', 'blackout'];

export interface ScreenEffectParams {
  /** Flash e vinheta. */
  color: string;
  /** 0 a 1: tremor, vinheta e desfoque. */
  intensity: number;
  /** Tempo na tela, em ms. `null` = fixo, ate o mestre remover. */
  durationMs: number | null;
  /** Apagao: entrada e saida suaves, em ms. */
  fadeMs: number;
}

export interface ScreenEffect extends ScreenEffectParams {
  id: string;
  kind: ScreenEffectKind;
  /**
   * Quanto do efeito ja passou quando esta mensagem saiu do servidor.
   *
   * Zero no disparo. Quem reconecta no meio de um efeito recebe o tempo
   * decorrido, em vez de um horario absoluto — o relogio do navegador nao
   * precisa bater com o do servidor.
   */
  elapsedMs: number;
  /**
   * Destinatarios; `null` = todos os jogadores. So vai para o mestre: o
   * jogador nao precisa saber quem mais esta sentindo o mesmo.
   */
  playerIds?: string[] | null;
}

/**
 * Intervalo minimo entre dois flashes: no maximo 3 por segundo.
 *
 * Luz piscando mais rapido que isso pode desencadear crises em pessoas
 * fotossensiveis. O servidor recusa o que vier antes disso, e o cliente
 * tambem ignora, para nao depender de uma camada so.
 */
export const FLASH_MIN_INTERVAL_MS = 334;

const LIMITS: Record<ScreenEffectKind, { min: number; max: number; fallback: number }> = {
  shake: { min: 100, max: 10_000, fallback: 600 },
  flash: { min: 100, max: 2_000, fallback: 350 },
  vignette: { min: 300, max: 600_000, fallback: 4_000 },
  blur: { min: 300, max: 600_000, fallback: 4_000 },
  blackout: { min: 300, max: 600_000, fallback: 3_000 },
};

const MAX_FADE_MS = 5_000;

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function isColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

export function isScreenEffectKind(v: unknown): v is ScreenEffectKind {
  return SCREEN_EFFECT_KINDS.includes(v as ScreenEffectKind);
}

/**
 * Normaliza os parametros pedidos para um efeito.
 *
 * Tremor e flash nunca sao fixos: um tremor sem fim e so desconforto, e um
 * flash e por definicao um instante.
 */
export function sanitizeScreenEffect(kind: ScreenEffectKind, raw: Partial<ScreenEffectParams>): ScreenEffectParams {
  const limits = LIMITS[kind];
  const fixed = raw?.durationMs === null && FIXABLE_SCREEN_EFFECTS.includes(kind);
  const fallbackColor = kind === 'flash' ? '#ffffff' : '#000000';
  return {
    color: isColor(raw?.color) ? raw.color : fallbackColor,
    intensity: clamp(raw?.intensity, 0, 1, 0.6),
    durationMs: fixed ? null : clamp(raw?.durationMs, limits.min, limits.max, limits.fallback),
    fadeMs: kind === 'blackout' ? clamp(raw?.fadeMs, 0, MAX_FADE_MS, 800) : 0,
  };
}

/**
 * O efeito como aparece para quem ligou "Reduzir efeitos de tela".
 *
 * O tremor some. O flash vira uma vinheta suave da mesma cor: a pessoa ainda
 * percebe que algo aconteceu, sem o clarao. O resto passa como veio — nao
 * pisca nem se move.
 */
export function reduceScreenEffect(effect: ScreenEffect): ScreenEffect | null {
  if (effect.kind === 'shake') return null;
  if (effect.kind === 'flash') {
    return {
      ...effect,
      kind: 'vignette',
      intensity: 0.35,
      // Uma vinheta que dura o mesmo que um flash seria outro piscar.
      durationMs: Math.max(effect.durationMs ?? 0, 900),
    };
  }
  return effect;
}

/** Pode sair um flash agora, dado o ultimo? */
export function flashAllowed(lastFlashAt: number | null, now: number): boolean {
  return lastFlashAt === null || now - lastFlashAt >= FLASH_MIN_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Cartelas de cena
// ---------------------------------------------------------------------------

/**
 * Cartela de cena: tela cheia com imagem, titulo e subtitulo ("Capitulo 3 —
 * O Porao").
 *
 * E material de preparacao do mestre. Nunca chega ao jogador antes de ser
 * apresentada — nem o titulo, que ja entregaria o que vem pela frente.
 */
export interface SceneCard {
  id: string;
  title: string;
  subtitle: string;
  assetId: string | null;
  /** Duracao padrao ao apresentar, em ms. `null` = ate o mestre fechar. */
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Uma cartela no ar, como vai para a tela de quem a recebe. */
export interface CardPresentation {
  id: string;
  cardId: string;
  title: string;
  subtitle: string;
  assetId: string | null;
  durationMs: number | null;
  /** Ver `ScreenEffect.elapsedMs`. */
  elapsedMs: number;
  /** Destinatarios; so para o mestre, como em `ScreenEffect`. */
  playerIds?: string[] | null;
}

export const MAX_CARD_DURATION_MS = 600_000;
export const MIN_CARD_DURATION_MS = 1_000;

export function sanitizeCardDuration(v: unknown, fallback: number | null = 6000): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return clamp(v, MIN_CARD_DURATION_MS, MAX_CARD_DURATION_MS, 6000);
}

/**
 * O que acontece ao vivo na tela dos jogadores, e nao fica gravado.
 *
 * Vai junto do estado completo para que um efeito fixo e uma cartela aberta
 * sobrevivam a reconexao — ja filtrado para quem recebe.
 */
export interface LiveState {
  screenEffects: ScreenEffect[];
  presentation: CardPresentation | null;
}
