import { useEffect, useState } from 'react';

import { createTable, lookupTable, type TableSummary } from '../net/api';
import { joinTable, resumeWithSession } from '../net/socket';

/**
 * Entrada na mesa.
 *
 * Nao ha cadastro: o mestre cria a mesa e recebe um codigo; os jogadores
 * entram com esse codigo e um nome. O papel de mestre e protegido pela senha
 * opcional definida na criacao — quem sabe a senha entra como mestre, quem
 * so tem o codigo entra como jogador.
 */

type Mode = 'join' | 'create';

export function Gate(): JSX.Element {
  const [mode, setMode] = useState<Mode>('join');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // entrar
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [asGm, setAsGm] = useState(false);
  const [gmPassword, setGmPassword] = useState('');
  const [summary, setSummary] = useState<TableSummary | null>(null);

  // criar
  const [tableName, setTableName] = useState('');
  const [gmName, setGmName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [created, setCreated] = useState<string | null>(null);

  // O codigo tambem pode chegar pelo link de convite (?mesa=ABC-123).
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('mesa');
    if (fromUrl) setCode(fromUrl.toUpperCase());
  }, []);

  // Confere o codigo enquanto a pessoa digita, para errar cedo e barato.
  useEffect(() => {
    const clean = code.replace(/[^A-Za-z0-9]/g, '');
    if (clean.length < 6) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      lookupTable(clean)
        .then((s) => !cancelled && setSummary(s))
        .catch(() => !cancelled && setSummary(null));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  async function handleJoin(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await joinTable({
        code,
        name: name.trim(),
        gmPassword: asGm ? gmPassword : undefined,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await createTable({
        name: tableName.trim(),
        gmName: gmName.trim(),
        gmPassword: newPassword,
      });
      setCreated(session.tableCode);
      await resumeWithSession(session);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-head">
          <h1>Mesa</h1>
          <p>Sistema de RPG configuravel, jogado a distancia e em tempo real.</p>
        </div>

        <div className="gate-body">
          <div className="tabs">
            <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>
              Entrar
            </button>
            <button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>
              Criar mesa
            </button>
          </div>

          {error && <div className="error-box">{error}</div>}

          {created && (
            <div className="field">
              <span className="label">Codigo de convite</span>
              <div className="code-display">{created}</div>
              <span className="hint">Entrando na mesa...</span>
            </div>
          )}

          {mode === 'join' && !created && (
            <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <label className="label" htmlFor="code">
                  Codigo da mesa
                </label>
                <input
                  id="code"
                  className="input mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABC-123"
                  autoComplete="off"
                  maxLength={12}
                  required
                />
                {summary && (
                  <span className="hint">
                    <strong style={{ color: 'var(--brass)' }}>{summary.name}</strong> —{' '}
                    {summary.players} conectado(s)
                  </span>
                )}
              </div>

              <div className="field">
                <label className="label" htmlFor="name">
                  Seu nome
                </label>
                <input
                  id="name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Como aparecer na mesa"
                  maxLength={40}
                  required
                />
              </div>

              <label className="check">
                <input type="checkbox" checked={asGm} onChange={(e) => setAsGm(e.target.checked)} />
                <span>
                  Entrar como mestre
                  <small>Exige a senha definida na criacao da mesa.</small>
                </span>
              </label>

              {asGm && (
                <div className="field">
                  <label className="label" htmlFor="gmpass">
                    Senha de mestre
                  </label>
                  <input
                    id="gmpass"
                    className="input"
                    type="password"
                    value={gmPassword}
                    onChange={(e) => setGmPassword(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              )}

              <button className="btn primary block" disabled={busy}>
                {busy ? 'Entrando...' : 'Entrar na mesa'}
              </button>
            </form>
          )}

          {mode === 'create' && !created && (
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <label className="label" htmlFor="tname">
                  Nome da mesa
                </label>
                <input
                  id="tname"
                  className="input"
                  value={tableName}
                  onChange={(e) => setTableName(e.target.value)}
                  placeholder="A Torre de Vidro"
                  maxLength={80}
                  required
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="gname">
                  Seu nome
                </label>
                <input
                  id="gname"
                  className="input"
                  value={gmName}
                  onChange={(e) => setGmName(e.target.value)}
                  placeholder="Mestre"
                  maxLength={40}
                  required
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="npass">
                  Senha de mestre (opcional)
                </label>
                <input
                  id="npass"
                  className="input"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
                <span className="hint">
                  Protege o papel de mestre. Sem senha, qualquer pessoa com o codigo pode assumir o
                  controle da mesa.
                </span>
              </div>

              <button className="btn primary block" disabled={busy}>
                {busy ? 'Criando...' : 'Criar mesa'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
