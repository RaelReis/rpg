import { useState } from 'react';
import {
  MAX_SCREEN_MESSAGE_LENGTH,
  type ScreenMessageReport,
  type ScreenMessageStyle,
} from '@rpg/shared';

import { act } from '../net/socket';
import { useStore } from '../state/store';
import { Modal, SelectField } from './common';

/**
 * Mensagem individual: o mestre escreve, escolhe quem recebe, e o texto
 * aparece no centro da tela dessas pessoas.
 *
 * Quem esta offline nao recebe depois. O mestre ve isso na resposta, e decide
 * se repete quando a pessoa voltar.
 */

const DURATIONS: { value: string; label: string }[] = [
  { value: '4000', label: '4 segundos' },
  { value: '8000', label: '8 segundos' },
  { value: '15000', label: '15 segundos' },
  { value: '30000', label: '30 segundos' },
  { value: 'close', label: 'Ate o jogador fechar' },
];

const STYLES: { value: ScreenMessageStyle; label: string }[] = [
  { value: 'neutral', label: 'Neutro' },
  { value: 'whisper', label: 'Sussurro' },
  { value: 'threat', label: 'Ameaca' },
];

export function MessageComposer({ initial }: { initial: string[] }): JSX.Element {
  const table = useStore((s) => s.table);
  const close = useStore((s) => s.openMessageComposer);
  const notify = useStore((s) => s.notify);

  const players = table?.players.filter((p) => p.role === 'PLAYER') ?? [];
  const [targets, setTargets] = useState<string[]>(initial);
  const [text, setText] = useState('');
  const [style, setStyle] = useState<ScreenMessageStyle>('neutral');
  const [duration, setDuration] = useState('8000');
  const [sending, setSending] = useState(false);

  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? 'jogador';
  const toggle = (id: string) =>
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  async function send(): Promise<void> {
    setSending(true);
    const report = await act<ScreenMessageReport>('message:send', {
      playerIds: targets,
      text,
      style,
      durationMs: duration === 'close' ? null : Number(duration),
    });
    setSending(false);
    if (!report) return;

    const list = (ids: string[]) => ids.map(nameOf).join(', ');
    if (report.delivered.length) notify('info', `Mensagem entregue a ${list(report.delivered)}.`);
    if (report.offline.length) {
      notify('warn', `Offline, nao recebeu: ${list(report.offline)}. A mensagem nao fica guardada.`);
    }
    if (report.unconfirmed.length) {
      notify('warn', `Enviada, mas sem confirmacao de ${list(report.unconfirmed)}.`);
    }
    close(null);
  }

  const canSend = !sending && targets.length > 0 && text.trim().length > 0;

  return (
    <Modal
      title="Mensagem individual"
      onClose={() => close(null)}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            Nao entra no chat e nao fica guardada.
          </span>
          <button className="btn" onClick={() => close(null)}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!canSend} onClick={() => void send()}>
            {sending ? 'Enviando...' : 'Enviar'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field">
          <span className="label">Para</span>
          {players.length === 0 ? (
            <span className="hint">Nenhum jogador na mesa ainda.</span>
          ) : (
            <div className="row wrap">
              {players.map((p) => (
                <label key={p.id} className={`chip-check${targets.includes(p.id) ? ' on' : ''}`}>
                  <input type="checkbox" checked={targets.includes(p.id)} onChange={() => toggle(p.id)} />
                  <span className="swatch" style={{ background: p.color, opacity: p.connected ? 1 : 0.35 }} />
                  {p.name}
                  {!p.connected && <span className="sub"> · offline</span>}
                </label>
              ))}
              {players.length > 1 && (
                <button
                  className="btn ghost sm"
                  onClick={() =>
                    setTargets(targets.length === players.length ? [] : players.map((p) => p.id))
                  }
                >
                  {targets.length === players.length ? 'Nenhum' : 'Todos'}
                </button>
              )}
            </div>
          )}
        </div>

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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSend) void send();
            }}
          />
        </label>

        <div className="grid-2">
          <SelectField label="Estilo" value={style} options={STYLES} onChange={setStyle} />
          <SelectField label="Duracao" value={duration} options={DURATIONS} onChange={setDuration} />
        </div>

        {/* Previa na tipografia que o jogador vai ver. */}
        <div className="screen-msg-preview">
          <div className={`screen-msg ${style} still`}>
            <p>{text.trim() || 'Voce ouve alguem chamar seu nome.'}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
