import { useState } from 'react';
import {
  MAX_SCREEN_MESSAGE_LENGTH,
  type ScreenMessageDelivery,
  type ScreenMessageStyle,
} from '@rpg/shared';

import { act } from '../net/socket';
import { useStore } from '../state/store';
import { Modal, SelectField } from './common';

/**
 * Mensagem individual: o texto que aparece no centro da tela de alguns
 * jogadores. Nao passa pelo chat e nao fica registrada.
 */

const DURATIONS: { value: string; label: string }[] = [
  { value: '3000', label: '3 segundos' },
  { value: '6000', label: '6 segundos' },
  { value: '10000', label: '10 segundos' },
  { value: '20000', label: '20 segundos' },
  { value: 'close', label: 'Ate o jogador fechar' },
];

const STYLES: { value: ScreenMessageStyle; label: string }[] = [
  { value: 'neutral', label: 'Neutro' },
  { value: 'whisper', label: 'Sussurro' },
  { value: 'threat', label: 'Ameaca' },
];

export function MessageComposer(): JSX.Element | null {
  const composer = useStore((s) => s.messageComposer);
  const close = useStore((s) => s.openMessageComposer);
  const allPlayers = useStore((s) => s.table?.players);
  const notify = useStore((s) => s.notify);

  const [recipients, setRecipients] = useState<string[]>(composer?.recipients ?? []);
  const [text, setText] = useState('');
  const [duration, setDuration] = useState('6000');
  const [style, setStyle] = useState<ScreenMessageStyle>('neutral');
  const [sending, setSending] = useState(false);

  if (!composer) return null;
  const players = (allPlayers ?? []).filter((p) => p.role === 'PLAYER');
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? 'jogador';

  async function send(): Promise<void> {
    setSending(true);
    const result = await act<ScreenMessageDelivery>('message:send', {
      recipients,
      text,
      style,
      durationMs: duration === 'close' ? null : Number(duration),
    });
    setSending(false);
    if (!result) return;

    // O mestre precisa saber quem de fato leu: quem estava fora nao recebe
    // depois, e a decisao de repetir e dele.
    if (result.delivered.length) notify('info', `Entregue a ${result.delivered.map(nameOf).join(', ')}.`);
    if (result.offline.length) {
      notify('warn', `Offline, nao recebeu: ${result.offline.map(nameOf).join(', ')}.`);
    }
    if (result.unconfirmed.length) {
      notify('warn', `Sem confirmacao de ${result.unconfirmed.map(nameOf).join(', ')}.`);
    }
    close(null);
  }

  return (
    <Modal
      title="Mensagem individual"
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" onClick={() => close(null)}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={sending || !text.trim() || recipients.length === 0}
            onClick={() => void send()}
          >
            {sending ? 'Enviando...' : 'Enviar'}
          </button>
        </>
      }
    >
      <span className="label">Para</span>
      {players.length === 0 ? (
        <span className="hint">Nenhum jogador na mesa ainda.</span>
      ) : (
        <div className="row wrap">
          {players.map((p) => {
            const on = recipients.includes(p.id);
            return (
              <label key={p.id} className="check" style={{ width: 'auto' }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setRecipients(on ? recipients.filter((id) => id !== p.id) : [...recipients, p.id])
                  }
                />
                <span>
                  {p.name}
                  {!p.connected && <small> offline</small>}
                </span>
              </label>
            );
          })}
        </div>
      )}

      <label className="field">
        <span className="label">Texto</span>
        <textarea
          className="input"
          rows={3}
          autoFocus
          maxLength={MAX_SCREEN_MESSAGE_LENGTH}
          placeholder="Voce ouve alguem chamar seu nome."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <div className="grid-2">
        <SelectField label="Tom" value={style} options={STYLES} onChange={setStyle} />
        <SelectField label="Na tela por" value={duration} options={DURATIONS} onChange={setDuration} />
      </div>

      {text.trim() && (
        <div className="screen-message-preview">
          <div className={`screen-message static ${style}`}>
            <p>{text}</p>
          </div>
        </div>
      )}

      <span className="hint">
        Aparece no centro da tela, por cima do mapa. Nao entra no chat e nao fica guardada; quem
        estiver offline nao recebe depois.
      </span>
    </Modal>
  );
}
