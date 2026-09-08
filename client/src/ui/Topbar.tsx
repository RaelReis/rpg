import { act, leaveTable } from '../net/socket';
import { isGm, useStore } from '../state/store';

/** Barra superior: identidade da mesa, convite, presenca e saida. */
export function Topbar(): JSX.Element {
  const table = useStore((s) => s.table);
  const connected = useStore((s) => s.connected);
  const session = useStore((s) => s.session);
  const notify = useStore((s) => s.notify);
  const toggleSide = useStore((s) => s.toggleSide);
  const sideOpen = useStore((s) => s.sideOpen);
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

      <div className="avatars">
        {table.players.map((player) => (
          <span
            key={player.id}
            className={`av${player.connected ? '' : ' off'}`}
            style={{ background: player.color }}
            title={`${player.name}${player.role === 'GM' ? ' (mestre)' : ''}${player.connected ? '' : ' — offline'}`}
          >
            {player.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>

      {gm && <span className="tag gm">Mestre</span>}

      <button className="btn ghost sm" onClick={toggleSide} title="Mostrar ou ocultar o painel">
        {sideOpen ? '⟩' : '⟨'}
      </button>

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
