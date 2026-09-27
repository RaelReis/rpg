import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, TableState } from '@rpg/shared';

import { act } from '../../net/socket';
import { findAsset, isGm, useStore } from '../../state/store';
import { DiceTray } from '../DiceTray';
import { Icon, type IconName } from '../icons';

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
  const [trayOpen, setTrayOpen] = useState(false);
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
    // O sussurro e quase sempre um aside pontual, nao uma conversa inteira
    // por texto — a voz externa carrega o resto. Sem isto, a marca ficava
    // ligada em silencio e a proxima mensagem publica saia sussurrada sem
    // ninguem perceber antes de mandar.
    setWhisper(false);
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
          <MessageRow
            key={message.id}
            message={message}
            mine={message.playerId === playerId}
            portraitUrl={portraitOf(table, message.playerId)}
          />
        ))}
      </div>

      <form className={`chat-input${whisper ? ' whisper-on' : ''}`} onSubmit={send}>
        <div className="row">
          <input
            className="input"
            value={text}
            placeholder={whisper ? 'Sussurrar ao mestre...' : 'Mensagem ou /r 1d20+5'}
            title="Comeca com /r para rolar sem abrir a Bandeja — ex.: /r 2d6+3"
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn primary" disabled={!text.trim()}>
            Enviar
          </button>
        </div>

        <div className="row" style={{ gap: 10 }}>
          {!gm && (
            <label className="check" style={{ padding: 0 }}>
              <input type="checkbox" checked={whisper} onChange={(e) => setWhisper(e.target.checked)} />
              <span>Sussurrar ao mestre</span>
            </label>
          )}
          <div className="spacer" />
          <button
            type="button"
            className={`tray-toggle${trayOpen ? ' on' : ''}`}
            onClick={() => setTrayOpen((o) => !o)}
            aria-expanded={trayOpen}
          >
            <Icon name="d20" size="sm" /> Bandeja
          </button>
        </div>
      </form>

      {trayOpen && <DiceTray whisper={whisper} />}
    </div>
  );
}

/**
 * Retrato de quem falou.
 *
 * O mesmo rosto da ficha, da lista de presenca e da faixa de turnos: num chat
 * de cinco pessoas, procurar o nome escrito custa mais do que reconhecer a
 * cara — ainda mais quando a mesa esta no meio de uma cena.
 */
function portraitOf(table: TableState | null, playerId: string | null): string | null {
  const player = table?.players.find((p) => p.id === playerId);
  const asset = findAsset(player?.portraitAssetId);
  return asset?.thumbUrl ?? asset?.url ?? null;
}

const DIE_SIDES: number[] = [4, 6, 8, 10, 12, 20];

/** Le a formula ("2d6+3", "1d20+1d6") e acha o maior dado nomeado, pra ilustrar a rolagem. */
function dieIconFor(formula: string): IconName {
  const found = [...formula.matchAll(/d(\d+)/gi)].map((m) => Number(m[1]));
  const known = found.filter((sides) => DIE_SIDES.includes(sides));
  if (known.length === 0) return 'roll';
  return `d${Math.max(...known)}` as IconName;
}

function MessageRow({
  message,
  mine,
  portraitUrl,
}: {
  message: ChatMessage;
  mine: boolean;
  portraitUrl: string | null;
}): JSX.Element {
  const time = new Date(message.createdAt).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`msg${message.whisper ? ' whisper' : ''}`}>
      {/* Decorativo: o nome ao lado ja diz quem falou. */}
      <span className="msg-face" style={{ ['--pc' as string]: message.authorColor }} aria-hidden="true">
        {portraitUrl ? (
          <img src={portraitUrl} alt="" draggable={false} />
        ) : (
          message.authorName.slice(0, 1).toUpperCase()
        )}
      </span>

      <div className="msg-main">
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
            <Icon name={dieIconFor(message.roll.formula)} size="lg" className="roll-icon" />
            <span className="roll-main">
              <span className="total">{message.roll.total}</span>
              {message.rollLabel && <span className="roll-label">{message.rollLabel}</span>}
            </span>
            <span className="detail">
              <span className="roll-formula">{message.roll.formula}</span>
              {message.roll.rolls.length > 0 && (
                <span className="roll-breakdown">[{message.roll.rolls.join(', ')}]</span>
              )}
            </span>
          </div>
        ) : (
          <div className="body">{message.text}</div>
        )}
      </div>
    </div>
  );
}
