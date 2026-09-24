import type { CardPresentation, LiveState, ScreenEffect } from '@rpg/shared';

import type { Viewer } from './filter.js';

/**
 * O que esta acontecendo agora na tela dos jogadores: efeitos de tela e a
 * cartela no ar.
 *
 * Fica so na memoria. Um apagao fixo precisa sobreviver a reconexao de quem
 * caiu, mas nao a um reinicio do servidor — e reabrir a mesa amanha com a tela
 * de todo mundo preta seria um susto do tipo errado.
 */

interface Timed {
  /** `Date.now()` do disparo, para calcular o tempo decorrido no reenvio. */
  startedAt: number;
  /** Destinatarios; `null` = todos os jogadores, inclusive quem entrar depois. */
  playerIds: string[] | null;
  timer: NodeJS.Timeout | null;
}

interface ActiveEffect extends Timed {
  effect: Omit<ScreenEffect, 'elapsedMs' | 'playerIds'>;
}

interface ActivePresentation extends Timed {
  presentation: Omit<CardPresentation, 'elapsedMs' | 'playerIds'>;
}

export function targets(playerIds: string[] | null, viewer: Viewer): boolean {
  if (viewer.role === 'GM') return true;
  return playerIds === null || playerIds.includes(viewer.playerId);
}

export class LiveScreen {
  readonly effects = new Map<string, ActiveEffect>();
  presentation: ActivePresentation | null = null;
  lastFlashAt: number | null = null;

  addEffect(effect: ActiveEffect['effect'], playerIds: string[] | null, onExpire: () => void): ScreenEffect {
    const startedAt = Date.now();
    const timer =
      effect.durationMs === null
        ? null
        : setTimeout(() => {
            this.effects.delete(effect.id);
            onExpire();
          }, effect.durationMs);
    timer?.unref();
    this.effects.set(effect.id, { effect, playerIds, startedAt, timer });
    return { ...effect, elapsedMs: 0, playerIds };
  }

  removeEffect(id: string): ActiveEffect | null {
    const active = this.effects.get(id);
    if (!active) return null;
    if (active.timer) clearTimeout(active.timer);
    this.effects.delete(id);
    return active;
  }

  present(
    presentation: ActivePresentation['presentation'],
    playerIds: string[] | null,
    onExpire: () => void,
  ): CardPresentation {
    this.closePresentation();
    const startedAt = Date.now();
    const timer =
      presentation.durationMs === null
        ? null
        : setTimeout(() => {
            if (this.presentation?.presentation.id === presentation.id) this.presentation = null;
            onExpire();
          }, presentation.durationMs);
    timer?.unref();
    this.presentation = { presentation, playerIds, startedAt, timer };
    return { ...presentation, elapsedMs: 0, playerIds };
  }

  closePresentation(): ActivePresentation | null {
    const current = this.presentation;
    if (!current) return null;
    if (current.timer) clearTimeout(current.timer);
    this.presentation = null;
    return current;
  }

  /**
   * O que este observador deve ter na tela agora.
   *
   * O jogador recebe so o que e para ele, sem a lista de destinatarios; o
   * mestre recebe tudo, com a lista, para o painel mostrar quem esta sob
   * qual efeito.
   */
  forViewer(viewer: Viewer): LiveState {
    const now = Date.now();
    const gm = viewer.role === 'GM';

    const screenEffects: ScreenEffect[] = [];
    for (const active of this.effects.values()) {
      if (!targets(active.playerIds, viewer)) continue;
      screenEffects.push({
        ...active.effect,
        elapsedMs: now - active.startedAt,
        ...(gm ? { playerIds: active.playerIds } : {}),
      });
    }

    const current = this.presentation;
    const presentation =
      current && targets(current.playerIds, viewer)
        ? {
            ...current.presentation,
            elapsedMs: now - current.startedAt,
            ...(gm ? { playerIds: current.playerIds } : {}),
          }
        : null;

    return { screenEffects, presentation };
  }
}
