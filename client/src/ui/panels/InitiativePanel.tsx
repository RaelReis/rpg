import { generateId, type InitiativeEntry } from '@rpg/shared';

import { act } from '../../net/socket';
import { activeScene, isGm, useStore } from '../../state/store';
import { Empty, Section, Toggle } from '../common';

/**
 * Rastreador de iniciativa.
 *
 * A ordem e visivel para todos, com a vez destacada aqui e tambem no token
 * correspondente no mapa. O avanco e do mestre, salvo quando ele liga
 * "cada um passa o proprio turno".
 */
export function InitiativePanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const playerId = useStore((s) => s.session?.playerId ?? null);
  const selectToken = useStore((s) => s.selectToken);

  void rev;
  if (!table) return <Empty>Sem mesa carregada.</Empty>;

  const initiative = table.initiative;
  const scene = activeScene(useStore.getState());

  function addSelectedTokens(): void {
    if (!scene) return;
    const selectedId = useStore.getState().selectedTokenId;
    const token = scene.tokens.find((t) => t.id === selectedId);
    if (!token) return;

    void act('initiative:add', {
      entry: {
        id: generateId('ini'),
        tokenId: token.id,
        name: token.name,
        playerId: token.ownerPlayerId,
        hiddenFromPlayers: token.gmOnly || token.visibility === 'hidden',
        value: 0,
      },
    });
  }

  function addAllPlayerTokens(): void {
    if (!scene) return;
    for (const token of scene.tokens) {
      if (token.layer !== 3 || !token.ownerPlayerId) continue;
      if (initiative.entries.some((e) => e.tokenId === token.id)) continue;
      void act('initiative:add', {
        entry: {
          id: generateId('ini'),
          tokenId: token.id,
          name: token.name,
          playerId: token.ownerPlayerId,
          value: 0,
        },
      });
    }
  }

  return (
    <>
      <Section
        title="Combate"
        actions={
          gm && (
            <button
              className={`btn sm${initiative.active ? '' : ' primary'}`}
              onClick={() => void act('initiative:update', { active: !initiative.active })}
            >
              {initiative.active ? 'Encerrar' : 'Iniciar'}
            </button>
          )
        }
      >
        {initiative.active ? (
          <div className="row">
            <span className="tag on">Rodada {initiative.round}</span>
            <div className="spacer" />
            {gm && (
              <>
                <button className="btn sm" onClick={() => void act('initiative:previous')}>
                  ‹ Anterior
                </button>
                <button className="btn sm primary" onClick={() => void act('initiative:next')}>
                  Proximo ›
                </button>
              </>
            )}
          </div>
        ) : (
          <span className="hint">O combate esta fora de turnos.</span>
        )}

        {gm && (
          <>
            <div className="row wrap">
              <button className="btn sm" onClick={addSelectedTokens}>
                + Token selecionado
              </button>
              <button className="btn sm" onClick={addAllPlayerTokens}>
                + Todos os jogadores
              </button>
              <button className="btn sm" onClick={() => void act('initiative:roll')} title="1d20 + campo de iniciativa da ficha">
                Rolar para todos
              </button>
            </div>

            <Toggle
              label="Cada um passa o proprio turno"
              hint="Sem isto, apenas voce avanca a ordem."
              checked={initiative.autoAdvance}
              onChange={(v) => void act('initiative:update', { autoAdvance: v })}
            />
          </>
        )}
      </Section>

      <Section title={`Ordem (${initiative.entries.length})`}>
        {initiative.entries.length === 0 ? (
          <Empty>
            {gm ? 'Adicione tokens a ordem de turnos.' : 'O mestre ainda nao montou a ordem.'}
          </Empty>
        ) : (
          <div className="list">
            {initiative.entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                active={entry.id === initiative.activeEntryId}
                mine={entry.playerId !== null && entry.playerId === playerId}
                gm={gm}
                onFocusToken={() => entry.tokenId && selectToken(entry.tokenId)}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function EntryRow({
  entry,
  active,
  mine,
  gm,
  onFocusToken,
}: {
  entry: InitiativeEntry;
  active: boolean;
  mine: boolean;
  gm: boolean;
  onFocusToken: () => void;
}): JSX.Element {
  return (
    <div className={`init-entry${active ? ' active' : ''}${entry.skipped ? ' skipped' : ''}`}>
      <span className="score">{entry.value}</span>

      <span className="who" onClick={onFocusToken} style={{ cursor: entry.tokenId ? 'pointer' : 'default' }}>
        {entry.name}
        {mine && <span className="tag on" style={{ marginLeft: 6 }}>voce</span>}
        {entry.hiddenFromPlayers && gm && <span className="tag gm" style={{ marginLeft: 6 }}>oculto</span>}
      </span>

      {gm && (
        <>
          <input
            className="input mono"
            type="number"
            style={{ width: 58, padding: '3px 5px' }}
            value={entry.value}
            onChange={(e) => {
              const value = Number(e.target.value) || 0;
              const entries = useStore.getState().table?.initiative.entries ?? [];
              void act('initiative:update', {
                entries: entries.map((x) => (x.id === entry.id ? { ...x, value } : x)),
              });
            }}
          />
          <button
            className="btn ghost sm"
            title={entry.skipped ? 'Voltar a ordem' : 'Pular turnos'}
            onClick={() => {
              const entries = useStore.getState().table?.initiative.entries ?? [];
              void act('initiative:update', {
                entries: entries.map((x) => (x.id === entry.id ? { ...x, skipped: !x.skipped } : x)),
              });
            }}
          >
            {entry.skipped ? '▷' : '⏸'}
          </button>
          <button
            className="btn ghost sm"
            onClick={() => void act('initiative:remove', { entryId: entry.id })}
            title="Remover da ordem"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
