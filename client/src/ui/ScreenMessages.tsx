import { useEffect, useState } from 'react';
import type { ScreenMessage } from '@rpg/shared';

import { useStore } from '../state/store';

/**
 * Mensagens individuais do mestre, no centro da tela.
 *
 * Ficam numa camada de interface acima do mapa, fora da camera: o texto nao
 * pode acompanhar o pan nem sumir num canto quando a pessoa da zoom. Tambem
 * nao passam pelo canvas — o fade e CSS, e o mapa continua parado quando nada
 * nele anima.
 */

/** Duracao do fade de saida; precisa bater com `.screen-msg.leaving` no CSS. */
const FADE_OUT_MS = 700;

export function ScreenMessages(): JSX.Element | null {
  const messages = useStore((s) => s.screenMessages);
  if (messages.length === 0) return null;

  return (
    <div className="screen-msgs" aria-live="assertive">
      {messages.map((message) => (
        <ScreenMessageItem key={message.id} message={message} />
      ))}
    </div>
  );
}

function ScreenMessageItem({ message }: { message: ScreenMessage }): JSX.Element {
  const dismiss = useStore((s) => s.dismissScreenMessage);
  const [leaving, setLeaving] = useState(false);

  // Tempo esgotado: comeca o fade de saida.
  useEffect(() => {
    if (message.durationMs === null) return;
    const timer = setTimeout(() => setLeaving(true), message.durationMs);
    return () => clearTimeout(timer);
  }, [message.durationMs]);

  // Fim do fade: sai do estado.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => dismiss(message.id), FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, [leaving, dismiss, message.id]);

  return (
    <div className={`screen-msg ${message.style}${leaving ? ' leaving' : ''}`} role="status">
      <p>{message.text}</p>
      {message.durationMs === null && (
        <button className="screen-msg-close" onClick={() => setLeaving(true)} aria-label="Fechar mensagem">
          fechar
        </button>
      )}
    </div>
  );
}
