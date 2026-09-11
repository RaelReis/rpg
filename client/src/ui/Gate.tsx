import { useEffect, useRef, useState } from 'react';

import { createTable, importTable, lookupTable, type TableSummary } from '../net/api';
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
  const backupRef = useRef<HTMLInputElement>(null);

  // O codigo tambem pode chegar pelo link de convite (?mesa=ABC-123).
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('mesa');
    if (fromUrl) setCode(fromUrl.toUpperCase());
  }, []);

  /*
   * "Entrar como mestre" so aparece quando a mesa ainda nao tem mestre.
   *
   * Quem chega pelo convite e jogador; oferecer o papel de mestre a essa pessoa
   * so convida a confusao — e, numa mesa sem senha, era o jeito de tomar a
   * mesa. Continua existindo um caminho para o proprio mestre voltar de outro
   * aparelho: o link com `&mestre` mostra a opcao, e a senha segue exigida.
   */
  const gmRecovery = new URLSearchParams(window.location.search).has('mestre');
  const offerGm = gmRecovery || (summary !== null && !summary.hasGm);

  useEffect(() => {
    if (!offerGm) setAsGm(false);
  }, [offerGm]);

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

  /**
   * Restaura um backup. A importacao SEMPRE cria uma mesa nova: sobrescrever
   * uma existente destruiria material sem volta, e comparar as duas antes de
   * descartar e uma decisao de quem importou.
   */
  async function handleImport(file: File | undefined): Promise<void> {
    if (!file) return;
    const name = gmName.trim() || tableName.trim();
    if (!name) {
      setError('Preencha seu nome de mestre antes de importar.');
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const backup = JSON.parse(await file.text()) as unknown;
      const result = await importTable(backup, name, newPassword);
      setCreated(result.session.tableCode);
      if (result.missingAssets > 0) {
        // Vale avisar: o backup "so estrutura" volta sem arte, e a mesa
        // parecer vazia sem explicacao seria pior do que o aviso.
        window.alert(
          `${result.missingAssets} imagem(ns) nao vieram no arquivo. A mesa foi restaurada sem elas.`,
        );
      }
      await resumeWithSession(result.session);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    } finally {
      if (backupRef.current) backupRef.current.value = '';
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

              {offerGm && (
                <label className="check">
                  <input type="checkbox" checked={asGm} onChange={(e) => setAsGm(e.target.checked)} />
                  <span>
                    Entrar como mestre
                    <small>Exige a senha definida na criacao da mesa.</small>
                  </span>
                </label>
              )}

              {offerGm && asGm && (
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

              <div className="divider" />

              <button
                type="button"
                className="btn block"
                disabled={busy}
                onClick={() => backupRef.current?.click()}
              >
                Importar mesa de um backup
              </button>
              <span className="hint">
                Restaura cenas, fichas e materiais de um arquivo exportado. Cria sempre uma mesa
                nova, com codigo novo — nada existente e sobrescrito.
              </span>

              <input
                ref={backupRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => void handleImport(e.target.files?.[0])}
              />
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
