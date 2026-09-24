import { useEffect, useRef } from 'react';
import { reduceScreenEffect, type ScreenEffect } from '@rpg/shared';

import { findAsset, isGm, useStore, type LiveEffect } from '../state/store';

/**
 * Efeitos de tela e cartela de cena, na tela do jogador.
 *
 * Tudo aqui e uma camada de interface acima do mapa, fora da camera, animada
 * pelo proprio navegador (Web Animations). O canvas nao e chamado para nada:
 * o pulo de quadro ocioso continua valendo, e a textura da neblina nao e
 * recomposta porque a tela tremeu. Quando a animacao termina, nao sobra
 * trabalho nenhum — um efeito fixo e so uma camada parada.
 *
 * O mestre nao ve os efeitos na propria tela: ele conduz a cena, e um apagao
 * no meio da preparacao so atrapalharia. O painel no trilho mostra o que esta
 * no ar.
 */

/** Saida de um efeito fixo removido pelo mestre. */
const STOP_FADE_MS = 600;

export function ScreenEffectsLayer(): JSX.Element | null {
  const gm = useStore(isGm);
  const effects = useStore((s) => s.screenEffects);
  const reduce = useStore((s) => s.reduceEffects);

  // Temporizados que ja acabaram saem da lista — tambem no painel do mestre.
  useEffect(() => {
    if (effects.every((e) => e.durationMs === null)) return;
    const timer = setInterval(() => useStore.getState().expireLive(), 500);
    return () => clearInterval(timer);
  }, [effects]);

  if (gm) return null;

  const shown = effects.flatMap((effect) => {
    const adapted = reduce ? reduceScreenEffect(effect) : effect;
    return adapted ? [{ ...effect, ...adapted }] : [];
  });
  if (shown.length === 0) return null;

  return (
    <div className="screen-fx" aria-hidden="true">
      {shown.map((effect) => (
        <EffectLayer key={effect.id} effect={effect} />
      ))}
    </div>
  );
}

/**
 * Envelope de opacidade: entra, fica e sai.
 *
 * As fracoes sao proporcionais a duracao; entrada e saida nunca passam da
 * metade cada, para os offsets continuarem em ordem num efeito curto.
 */
function envelope(total: number, fadeIn: number, fadeOut: number, peak: number): Keyframe[] {
  const a = Math.min(fadeIn / total, 0.5);
  const b = Math.min(fadeOut / total, 0.5);
  return [
    { opacity: 0, offset: 0 },
    { opacity: peak, offset: a },
    { opacity: peak, offset: 1 - b },
    { opacity: 0, offset: 1 },
  ];
}

/** Sequencia de deslocamentos que decai: forte no inicio, assentando no fim. */
function shakeFrames(effect: ScreenEffect): Keyframe[] {
  const amplitude = 3 + 19 * effect.intensity;
  const steps = Math.max(4, Math.round((effect.durationMs ?? 600) / 45));
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const decay = i === steps ? 0 : 1 - i / steps;
    const x = (Math.random() * 2 - 1) * amplitude * decay;
    const y = (Math.random() * 2 - 1) * amplitude * decay;
    frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` });
  }
  return frames;
}

function layerStyle(effect: ScreenEffect): React.CSSProperties {
  switch (effect.kind) {
    case 'flash':
      return { background: effect.color };
    case 'vignette': {
      // Intensidade fecha o circulo claro do centro e engrossa a borda.
      const clear = 72 - effect.intensity * 42;
      return {
        background: `radial-gradient(ellipse at center, transparent ${clear}%, ${effect.color} 100%)`,
      };
    }
    case 'blur': {
      const px = (1 + effect.intensity * 11).toFixed(1);
      return { backdropFilter: `blur(${px}px)`, WebkitBackdropFilter: `blur(${px}px)` };
    }
    case 'blackout':
      return { background: '#000' };
    default:
      return {};
  }
}

function EffectLayer({ effect }: { effect: LiveEffect }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const removeScreenEffect = useStore((s) => s.removeScreenEffect);

  // Entrada, e o envelope inteiro quando o efeito tem duracao.
  useEffect(() => {
    const elapsed = Date.now() - effect.startedAt;

    if (effect.kind === 'shake') {
      // O tremor move o palco do mapa, e nao uma camada por cima dele.
      const stage = ref.current?.closest('.stage-wrap')?.querySelector<HTMLElement>('.stage');
      const total = effect.durationMs ?? 0;
      if (!stage || elapsed >= total) return;
      const anim = stage.animate(shakeFrames(effect), { duration: total, easing: 'linear' });
      anim.currentTime = elapsed;
      return () => anim.cancel();
    }

    const el = ref.current;
    if (!el) return;

    if (effect.durationMs === null) {
      const fadeIn = effect.kind === 'blackout' ? effect.fadeMs : 600;
      const anim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.max(fadeIn, 1), fill: 'forwards' });
      anim.currentTime = Math.min(elapsed, fadeIn);
      return () => anim.cancel();
    }

    const total = effect.durationMs;
    if (elapsed >= total) return;
    const frames =
      effect.kind === 'flash'
        ? envelope(total, Math.min(60, total * 0.2), total * 0.8, 0.85)
        : effect.kind === 'blackout'
          ? envelope(total, effect.fadeMs, effect.fadeMs, 1)
          : envelope(total, Math.min(500, total * 0.25), Math.min(700, total * 0.3), 1);
    const anim = el.animate(frames, { duration: total, fill: 'forwards', easing: 'ease-in-out' });
    anim.currentTime = elapsed;
    return () => anim.cancel();
  }, [effect.id, effect.kind, effect.durationMs, effect.startedAt, effect.fadeMs, effect.intensity]);

  // Saida de um fixo removido pelo mestre.
  useEffect(() => {
    if (!effect.stopping) return;
    const el = ref.current;
    const fade = effect.kind === 'blackout' ? Math.max(effect.fadeMs, 300) : STOP_FADE_MS;
    if (!el) {
      removeScreenEffect(effect.id);
      return;
    }
    const from = Number(getComputedStyle(el).opacity) || 1;
    const anim = el.animate([{ opacity: from }, { opacity: 0 }], { duration: fade, fill: 'forwards' });
    anim.onfinish = () => removeScreenEffect(effect.id);
    return () => anim.cancel();
  }, [effect.stopping, effect.id, effect.kind, effect.fadeMs, removeScreenEffect]);

  return (
    <div
      ref={ref}
      className={`screen-fx-layer ${effect.kind}`}
      style={{ ...layerStyle(effect), opacity: effect.kind === 'shake' ? undefined : 0 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Cartela de cena
// ---------------------------------------------------------------------------

/** Precisa bater com a transicao de `.card-presentation` no CSS. */
const CARD_FADE_MS = 1100;

export function CardPresentationView(): JSX.Element | null {
  const gm = useStore(isGm);
  const presentation = useStore((s) => s.presentation);
  const close = useStore((s) => s.closePresentation);
  const clear = useStore((s) => s.clearPresentation);
  const rev = useStore((s) => s.rev);
  void rev;

  // Fim da duracao: comeca a sair.
  useEffect(() => {
    if (!presentation || presentation.durationMs === null || presentation.closing) return;
    const remaining = presentation.durationMs - (Date.now() - presentation.startedAt);
    const timer = setTimeout(() => close(presentation.id), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [presentation, close]);

  // Fim do fade de saida: sai do estado.
  useEffect(() => {
    if (!presentation?.closing) return;
    const timer = setTimeout(clear, CARD_FADE_MS);
    return () => clearTimeout(timer);
  }, [presentation?.closing, clear]);

  if (gm || !presentation) return null;

  const image = findAsset(presentation.assetId);
  return (
    <div className={`card-presentation${presentation.closing ? ' closing' : ''}`} role="dialog" aria-label={presentation.title}>
      {image && <div className="card-bg" style={{ backgroundImage: `url("${image.url}")` }} />}
      <div className="card-shade" />
      <div className="card-text">
        <h1>{presentation.title}</h1>
        {presentation.subtitle && <p>{presentation.subtitle}</p>}
      </div>
    </div>
  );
}
