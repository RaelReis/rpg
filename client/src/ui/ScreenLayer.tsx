import { useEffect, useState } from 'react';

import { useStore, type ShownMessage } from '../state/store';

/**
 * Camada de imersao sobre o mapa.
 *
 * Fica acima do canvas e fora da camera: uma mensagem ao pe do ouvido nao
 * deve andar junto quando a pessoa arrasta o mapa. E DOM com animacao em CSS,
 * e nao desenho no canvas, de proposito — o mapa continua parando de
 * redesenhar quando nada nele anima, e a textura de neblina nao e tocada.
 */
export function ScreenLayer(): JSX.Element {
  const messages = useStore((s) => s.screenMessages);

  return (
    <div className="screen-layer" aria-live="polite">
      <div className="screen-messages">
        {messages.map((message) => (
          <ScreenMessageView key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}

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
