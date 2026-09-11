import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@rpg/shared';

import { act } from '../../net/socket';
import { isGm, useStore } from '../../state/store';

/**
 * Chat e rolagem de dados.
 *
 * A rolagem e agnostica de sistema: `/r 2d6+3`, `/r 4d6kh3`, `/r d20`. O
 * resultado vem do servidor — rolar no cliente deixaria o resultado ao
 * alcance de quem abrisse o console.
 */
export function ChatPanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const playerId = useStore((s) => s.session?.playerId ?? null);
  const [text, setText] = useState('');
  const [whisper, setWhisper] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const messages = table?.chat ?? [];

  // Rola para o fim apenas se a pessoa ja estava no fim: quem subiu para ler
  // uma mensagem antiga nao e arrastado de volta a cada nova linha.
  useEffect(() => {
    const log = logRef.current;
    if (log && pinnedRef.current) log.scrollTop = log.scrollHeight;
  }, [rev, messages.length]);

  function send(e: React.FormEvent): void {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    void act('chat:send', { text: value, whisper });
    setText('');
    pinnedRef.current = true;
  }

  return (
    <div className="chat">
      <div
        className="chat-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length === 0 && (
          <div className="hint">
            Sem mensagens ainda. Use <span className="mono">/r 2d6+3</span> para rolar dados.
          </div>
        )}
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} mine={message.playerId === playerId} />
        ))}
      </div>

      <form className="chat-input" onSubmit={send}>
        <div className="row">
          <input
            className="input"
            value={text}
            placeholder={whisper ? 'Sussurrar ao mestre...' : 'Mensagem ou /r 1d20+5'}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn primary" disabled={!text.trim()}>
            Enviar
          </button>
        </div>

        <div className="row">
          {!gm && (
            <label className="check" style={{ padding: 0 }}>
              <input type="checkbox" checked={whisper} onChange={(e) => setWhisper(e.target.checked)} />
              <span>Sussurrar ao mestre</span>
            </label>
          )}
          <div className="spacer" />
          {['d20', '2d6', 'd100'].map((formula) => (
            <button
              key={formula}
              type="button"
              className="btn sm"
              onClick={() => void act('chat:send', { text: `/r ${formula}`, whisper })}
            >
              {formula}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}

function MessageRow({ message, mine }: { message: ChatMessage; mine: boolean }): JSX.Element {
  const time = new Date(message.createdAt).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`msg${message.whisper ? ' whisper' : ''}`}>
      <div className="row" style={{ gap: 6 }}>
        <span className="who" style={{ color: message.authorColor }}>
          {message.authorName}
          {mine && ' (voce)'}
        </span>
        {message.whisper && <span className="tag">sussurro</span>}
        <div className="spacer" />
        <span className="hint mono" style={{ fontSize: 10 }}>
          {time}
        </span>
      </div>

      {message.roll ? (
        <div className="roll">
          <span className="total">{message.roll.total}</span>
          <span className="detail">
            {message.rollLabel && <strong className="roll-label">{message.rollLabel}</strong>}
            {message.roll.formula}
            {message.roll.rolls.length > 0 && ` · [${message.roll.rolls.join(', ')}]`}
          </span>
        </div>
      ) : (
        <div className="body">{message.text}</div>
      )}
    </div>
  );
}
