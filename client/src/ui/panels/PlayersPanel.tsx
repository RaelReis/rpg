import { useState } from 'react';
import type { Sheet } from '@rpg/shared';

import { exportTable } from '../../net/api';
import { act } from '../../net/socket';
import { isGm, useStore } from '../../state/store';
import { Empty, Section, Toggle } from '../common';

/** Painel de mesa: participantes e regras gerais da sessao. */
export function PlayersPanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const myId = useStore((s) => s.session?.playerId ?? null);
  const openSheet = useStore((s) => s.openSheetModal);
  const previewPlayerId = useStore((s) => s.previewPlayerId);
  const setPreviewPlayer = useStore((s) => s.setPreviewPlayer);

  void rev;
  if (!table) return <Empty>Sem mesa carregada.</Empty>;

  const settings = table.settings;

  return (
    <>
      <Section title={`Participantes (${table.players.length})`}>
        <div className="list">
          {table.players.map((player) => {
            const sheet = table.sheets.find((s) => s.ownerPlayerId === player.id);
            return (
              <div key={player.id} className="item">
                <span
                  className="swatch"
                  style={{
                    background: player.color,
                    opacity: player.connected ? 1 : 0.35,
                    borderRadius: '50%',
                  }}
                />
                <span className="name">
                  {player.name}
                  {player.id === myId && ' (voce)'}
                  <span className="sub">
                    {player.connected
                      ? ' · online'
                      : ` · visto ${new Date(player.lastSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
                  </span>
                </span>

                {player.role === 'GM' && <span className="tag gm">MJ</span>}

                {sheet ? (
                  <button className="btn ghost sm" onClick={() => openSheet(sheet.id)} title="Abrir ficha">
                    ▤
                  </button>
                ) : (
                  gm && (
                    // Criar e atribuir numa acao so: separado, o mestre teria
                    // de ir ate a aba Fichas e voltar para escolher o dono.
                    <button
                      className="btn ghost sm"
                      title={`Criar ficha para ${player.name}`}
                      onClick={() =>
                        void act<Sheet>('sheet:create', {
                          name: player.name,
                          ownerPlayerId: player.id,
                        }).then((created) => {
                          if (created) void act('sheet:assign', { sheetId: created.id, playerId: player.id });
                        })
                      }
                    >
                      + ▤
                    </button>
                  )
                )}

                {gm && player.role === 'PLAYER' && (
                  <button
                    className={`btn ghost sm${previewPlayerId === player.id ? ' active' : ''}`}
                    title={`Ver o mapa pelos olhos de ${player.name}`}
                    onClick={() =>
                      setPreviewPlayer(previewPlayerId === player.id ? null : player.id)
                    }
                  >
                    👁
                  </button>
                )}

                {gm && player.id !== myId && (
                  <>
                    <button
                      className="btn ghost sm"
                      title={player.role === 'GM' ? 'Tornar jogador' : 'Promover a mestre'}
                      onClick={() =>
                        void act('player:promote', {
                          playerId: player.id,
                          role: player.role === 'GM' ? 'PLAYER' : 'GM',
                        })
                      }
                    >
                      {player.role === 'GM' ? '↓' : '↑'}
                    </button>
                    <button
                      className="btn ghost sm danger"
                      title="Remover da mesa"
                      onClick={() => {
                        if (window.confirm(`Remover ${player.name} da mesa?`)) {
                          void act('player:kick', { playerId: player.id });
                        }
                      }}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {gm && (
        <Section title="Regras da mesa">
          <Toggle
            label="Jogadores movem apenas os proprios tokens"
            hint="Desligado, qualquer jogador arrasta qualquer token que enxergue."
            checked={settings.playersMoveOwnTokensOnly}
            onChange={(v) => void act('settings:update', { playersMoveOwnTokensOnly: v })}
          />

          <Toggle
            label="Mostrar barras de recurso no mapa"
            hint="Vale para os tokens que voce configurou com barras."
            checked={settings.showPartyBars}
            onChange={(v) => void act('settings:update', { showPartyBars: v })}
          />

          <Toggle
            label="Visao calculada no servidor"
            hint="Ligado, as paredes e os tokens na neblina nao chegam ao navegador do jogador — nem pelo inspecionador de rede. Desligado, o fog responde na hora durante o arraste, mas confia no cliente."
            checked={settings.strictVision}
            onChange={(v) => void act('settings:update', { strictVision: v })}
          />

          <Toggle
            label="Paredes barram o movimento"
            hint="Vale so para os jogadores: voce continua posicionando NPCs em qualquer lugar. O teste e sobre a linha reta entre origem e destino, entao contornar uma quina pode exigir mover em duas etapas."
            checked={settings.wallsBlockMovement}
            onChange={(v) => void act('settings:update', { wallsBlockMovement: v })}
          />

          <Toggle
            label="Jogadores podem anotar no mapa"
            hint="Permite criar efeitos e textos na camada de anotacoes."
            checked={settings.playersCanAnnotate}
            onChange={(v) => void act('settings:update', { playersCanAnnotate: v })}
          />

          <Toggle
            label="Rolagem de dados no chat"
            checked={settings.diceEnabled}
            onChange={(v) => void act('settings:update', { diceEnabled: v })}
          />
        </Section>
      )}

      {gm && <BackupSection tableId={table.id} />}

      <Section title="Voce">
        <PlayerSelfEditor />
      </Section>
    </>
  );
}

function PlayerSelfEditor(): JSX.Element {
  const table = useStore((s) => s.table);
  const myId = useStore((s) => s.session?.playerId ?? null);
  const me = table?.players.find((p) => p.id === myId);
  if (!me) return <Empty>Sessao nao encontrada.</Empty>;

  return (
    <div className="row">
      <label className="field" style={{ flex: 1 }}>
        <span className="label">Nome</span>
        <input
          className="input"
          defaultValue={me.name}
          maxLength={40}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== me.name) void act('player:update', { name });
          }}
        />
      </label>
      <label className="field" style={{ width: 70 }}>
        <span className="label">Cor</span>
        <input
          type="color"
          className="input"
          style={{ height: 32, padding: 2, cursor: 'pointer' }}
          value={me.color}
          onChange={(e) => void act('player:update', { color: e.target.value })}
        />
      </label>
    </div>
  );
}

/**
 * Backup da mesa.
 *
 * O banco e a pasta de uploads sao o backup real, mas so quem tem acesso ao
 * servidor os alcanca. Este arquivo existe para o mestre levar a campanha
 * embora — e por isso nao carrega senha nem token de sessao.
 */
function BackupSection({ tableId }: { tableId: string }): JSX.Element {
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);

  async function download(withAssets: boolean): Promise<void> {
    setBusy(true);
    try {
      await exportTable(tableId, withAssets);
      notify('info', 'Backup gerado.');
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Backup da mesa">
      <div className="row wrap">
        <button className="btn sm" disabled={busy} onClick={() => void download(true)}>
          Baixar com imagens
        </button>
        <button className="btn sm" disabled={busy} onClick={() => void download(false)}>
          Só a estrutura
        </button>
      </div>
      <span className="hint">
        Cenas, fichas, materiais, paredes e neblina num arquivo. Com imagens ele fica grande, mas é
        um backup completo; sem elas, serve para versionar ou compartilhar a montagem da campanha.
        Para restaurar, use <strong>Importar mesa</strong> na tela de entrada — ela sempre cria uma
        mesa nova, e nunca sobrescreve esta.
      </span>
      <span className="hint">
        O arquivo não inclui a senha de mestre nem as sessões dos jogadores: eles entram de novo
        pelo código da mesa restaurada.
      </span>
    </Section>
  );
}
