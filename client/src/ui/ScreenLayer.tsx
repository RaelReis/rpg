import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { BLACKOUT_FADE_MS, type PresentedCard, type ScreenEffectKind } from '@rpg/shared';

import { act } from '../net/socket';
import { findAsset, isGm, useStore, type ShownEffect, type ShownMessage } from '../state/store';

/**
 * Camada de imersao sobre o mapa.
 *
 * Fica acima do canvas e fora da camera: uma mensagem ao pe do ouvido nao
 * deve andar junto quando a pessoa arrasta o mapa. E DOM com animacao em CSS,
 * e nao desenho no canvas, de proposito — o mapa continua parando de
 * redesenhar quando nada nele anima, e a textura de neblina nao e tocada.
 * Cada animacao existe so enquanto o elemento dela esta na tela.
 */
export function ScreenLayer(): JSX.Element {
  const messages = useStore((s) => s.screenMessages);
  const effects = useStore((s) => s.shownEffects);

  return (
    <div className="screen-layer" aria-live="polite">
      <EffectClock />
      {effects.map((effect) => (
        <EffectOverlay key={effect.id} effect={effect} />
      ))}
      <div className="screen-messages">
        {messages.map((message) => (
          <ScreenMessageView key={message.id} message={message} />
        ))}
      </div>
      <CardStatus />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Efeitos de tela
// ---------------------------------------------------------------------------

/** Fade de saida de cada efeito; o que ja apaga sozinho nao tem. */
const FADE_OUT: Record<ScreenEffectKind, number> = {
  shake: 0,
  flash: 0,
  vignette: 700,
  blur: 600,
  blackout: BLACKOUT_FADE_MS,
};

/**
 * Relogio dos efeitos com prazo: marca a saida quando falta so o fade, e tira
 * da lista quando o fade acaba. Um timer por efeito, nenhum laco de quadros.
 */
function EffectClock(): null {
  const effects = useStore((s) => s.shownEffects);
  const markLeaving = useStore((s) => s.markEffectLeaving);
  const remove = useStore((s) => s.removeShownEffect);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const now = Date.now();
    for (const effect of effects) {
      const fade = FADE_OUT[effect.kind];
      if (effect.leaving) {
        timers.push(setTimeout(() => remove(effect.id), fade));
      } else if (effect.durationMs !== null) {
        const leaveAt = effect.receivedAt + effect.durationMs - fade;
        timers.push(setTimeout(() => markLeaving(effect.id), Math.max(0, leaveAt - now)));
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [effects, markLeaving, remove]);

  return null;
}

function EffectOverlay({ effect }: { effect: ShownEffect }): JSX.Element | null {
  const leaving = effect.leaving ? ' leaving' : '';

  switch (effect.kind) {
    case 'flash': {
      const style = {
        background: effect.color,
        '--fx-peak': String(0.35 + effect.intensity * 0.6),
        animationDuration: `${effect.durationMs ?? 600}ms`,
      } as CSSProperties;
      return <div className="fx fx-flash" style={style} />;
    }
    case 'vignette': {
      // Gradiente relativo ao tamanho da tela: uma sombra interna em pixels
      // fixos engolia o mapa inteiro numa janela pequena. O centro fica
      // sempre limpo; a intensidade aproxima a borda e engrossa a cor.
      const clear = 62 - effect.intensity * 30;
      const style = {
        background: `radial-gradient(ellipse at center, transparent ${clear}%, ${effect.color} 115%)`,
        '--fx-strength': String(0.55 + effect.intensity * 0.45),
      } as CSSProperties;
      return <div className={`fx fx-vignette${leaving}`} style={style} />;
    }
    case 'blackout':
      return <div className={`fx fx-blackout${leaving}`} />;
    // Tremor e desfoque agem sobre o mapa, em `ScreenFx`.
    default:
      return null;
  }
}

/**
 * Envolve o mapa para tremer e desfocar. Transformacao e filtro de CSS sobre
 * o elemento, e nao redesenho do canvas: o quadro ocioso continua ocioso.
 */
export function ScreenFx({ children }: { children: ReactNode }): JSX.Element {
  const effects = useStore((s) => s.shownEffects);
  const shake = [...effects].reverse().find((e) => e.kind === 'shake' && !e.leaving);
  const blur = [...effects].reverse().find((e) => e.kind === 'blur' && !e.leaving);

  const style = {
    '--shake-amp': shake ? `${3 + shake.intensity * 14}px` : '0px',
    filter: blur ? `blur(${1 + blur.intensity * 7}px)` : undefined,
  } as CSSProperties;

  return (
    <div className={`screen-fx${shake ? ' shaking' : ''}`} style={style}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mensagem individual
// ---------------------------------------------------------------------------

/** Duracao do fade de saida, igual a do CSS. */
const FADE_OUT_MS = 700;

function ScreenMessageView({ message }: { message: ShownMessage }): JSX.Element {
  const dismiss = useStore((s) => s.dismissScreenMessage);
  const [leaving, setLeaving] = useState(false);

  // Mensagem com duracao sai sozinha; a sem duracao espera o jogador fechar.
  useEffect(() => {
    if (message.durationMs === null) return;
    const remaining = Math.max(0, message.receivedAt + message.durationMs - Date.now());
    const timer = setTimeout(() => setLeaving(true), remaining);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => dismiss(message.id), FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, [leaving, dismiss, message.id]);

  return (
    <div
      className={`screen-message ${message.style}${leaving ? ' leaving' : ''}`}
      role="status"
      onClick={() => setLeaving(true)}
      title="Clique para fechar"
    >
      <p>{message.text}</p>
      {message.durationMs === null && (
        <button
          className="btn ghost sm"
          onClick={(e) => {
            e.stopPropagation();
            setLeaving(true);
          }}
        >
          Fechar
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartela de cena
// ---------------------------------------------------------------------------

/** Fade da cartela, igual ao do CSS. */
const CARD_FADE_MS = 1000;

/**
 * Cartela em tela cheia, na tela do jogador.
 *
 * Quem decide quando ela sai e o servidor (pela duracao ou pelo mestre); o
 * cliente so guarda a ultima por um instante para o fade de saida.
 */
export function SceneCardOverlay(): JSX.Element | null {
  const card = useStore((s) => s.table?.presentedCard ?? null);
  const gm = useStore(isGm);
  const [shown, setShown] = useState<PresentedCard | null>(card);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (card) {
      setShown(card);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => setShown(null), CARD_FADE_MS);
    return () => clearTimeout(timer);
  }, [card]);

  if (gm || !shown) return null;
  const asset = findAsset(shown.assetId);

  return (
    <div className={`scene-card${leaving ? ' leaving' : ''}`} role="dialog" aria-label={shown.title}>
      {asset && <div className="scene-card-bg" style={{ backgroundImage: `url("${asset.url}")` }} />}
      <div className="scene-card-text">
        <h1>{shown.title}</h1>
        {shown.subtitle && <p>{shown.subtitle}</p>}
      </div>
    </div>
  );
}

/** Aviso ao mestre de que ha uma cartela no ar, com o botao de fechar. */
function CardStatus(): JSX.Element | null {
  const card = useStore((s) => s.table?.presentedCard ?? null);
  const gm = useStore(isGm);
  if (!gm || !card) return null;
  return (
    <div className="card-status">
      <span>
        Cartela no ar: <strong>{card.title}</strong>
        {card.durationMs === null ? ' · ate voce fechar' : ''}
      </span>
      <button className="btn sm" onClick={() => void act('card:close', {})}>
        Fechar
      </button>
    </div>
  );
}
