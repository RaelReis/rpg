import type { Player } from '@rpg/shared';

import { act, leaveTable } from '../net/socket';
import { findAsset, isGm, useStore } from '../state/store';

/** Acima disto, os demais viram um contador para o cabecalho nao estourar. */
const MAX_AVATARS = 7;

/** Barra superior: identidade da mesa, convite, presenca e saida. */
export function Topbar(): JSX.Element {
  const table = useStore((s) => s.table);
  const connected = useStore((s) => s.connected);
  const session = useStore((s) => s.session);
  const notify = useStore((s) => s.notify);
  const gm = useStore(isGm);

  if (!table) return <div className="topbar" />;

  /** Copia o link de convite pronto, nao so o codigo solto. */
  async function copyInvite(): Promise<void> {
    const url = `${window.location.origin}${window.location.pathname}?mesa=${table!.code}`;
    try {
      await navigator.clipboard.writeText(url);
      notify('info', 'Link de convite copiado.');
    } catch {
      notify('warn', `Copie manualmente: ${table!.code}`);
    }
  }

  function rename(): void {
    const next = window.prompt('Nome da mesa', table!.name);
    if (next && next.trim()) void act('table:rename', next.trim());
  }

  // Quem esta na mesa agora. O mestre primeiro, depois os jogadores na ordem
  // em que entraram; quem caiu some da lista e volta sozinho ao reconectar.
  const online = table.players
    .filter((p) => p.connected)
    .sort((a, b) => (a.role === b.role ? 0 : a.role === 'GM' ? -1 : 1));
  const shown = online.slice(0, MAX_AVATARS);
  const overflow = online.slice(MAX_AVATARS);

  return (
    <header className="topbar">
      <span className="brand" onDoubleClick={gm ? rename : undefined} title={gm ? 'Clique duplo para renomear' : table.name}>
        {table.name}
      </span>

      <button className="code" onClick={copyInvite} title="Copiar link de convite">
        {table.code}
      </button>

      <span className={`conn${connected ? '' : ' off'}`}>
        <span className="dot" />
        {connected ? 'conectado' : 'reconectando'}
      </span>

      <div className="spacer" />

      <div className="presence" aria-label={`${online.length} na mesa`}>
        <div className="avatars">
          {shown.map((player) => (
            <PresenceAvatar key={player.id} player={player} me={player.id === session?.playerId} />
          ))}
          {overflow.length > 0 && (
            <span className="av more" title={overflow.map((p) => p.name).join(', ')}>
              +{overflow.length}
            </span>
          )}
        </div>
        <span className="presence-count">{online.length} na mesa</span>
      </div>

      {gm && <span className="tag gm">Mestre</span>}

      <span className="topbar-sep" aria-hidden="true" />

      <button
        className="btn ghost sm"
        onClick={() => {
          if (window.confirm('Sair da mesa neste dispositivo?')) leaveTable();
        }}
        title={`Sair (${session?.name})`}
      >
        Sair
      </button>
    </header>
  );
}

/**
 * Um participante: o retrato do personagem, ou a inicial na cor da pessoa.
 *
 * O anel usa a cor do jogador, a mesma do token e do ping no mapa — e o que
 * permite bater o rosto do cabecalho com a peca no mapa.
 */
function PresenceAvatar({ player, me }: { player: Player; me: boolean }): JSX.Element {
  const portrait = findAsset(player.portraitAssetId);
  const title = `${player.name}${player.role === 'GM' ? ' (mestre)' : ''}${me ? ' — voce' : ''}`;

  return (
    <span
      className={`av${portrait ? ' photo' : ''}${player.role === 'GM' ? ' gm' : ''}`}
      style={{ background: player.color, boxShadow: `0 0 0 2px ${player.color}` }}
      title={title}
    >
      {portrait ? (
        <img src={portrait.thumbUrl ?? portrait.url} alt={player.name} draggable={false} />
      ) : (
        player.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
