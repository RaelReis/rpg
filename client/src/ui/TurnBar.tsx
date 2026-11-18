import { useState } from 'react';
import { concealedFromPlayers, type TurnEntry, type TurnRecord } from '@rpg/shared';

import { act } from '../net/socket';
import { activeScene, liveScene, findAsset, findSheet, isGm, useStore } from '../state/store';
import { Icon } from './icons';

/**
 * A vez de agir, no cabecalho.
 *
 * As rodadas estao sempre correndo: elas nao marcam combate, marcam o fluxo da
 * mesa — de quem e a vez de agir e de descrever. Por isso nao ha botao de abrir
 * ou encerrar, e o grupo ja nasce na ordem.
 *
 * A ordem das miniaturas E a ordem dos turnos, e o mestre a define arrastando.
 * Ficava sobre o mapa e tampava justamente o que a mesa esta olhando; aqui
 * ocupa a faixa morta do cabecalho, ao lado da presenca.
 */
/** Quantas miniaturas cabem na faixa antes de virar `+N`. */
const MAX_VISIBLE = 8;

export function TurnBar(): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const myId = useStore((s) => s.session?.playerId ?? null);
  const selectedTokenIds = useStore((s) => s.selectedTokenIds);
  const selectToken = useStore((s) => s.selectToken);
  const notify = useStore((s) => s.notify);

  const [showHistory, setShowHistory] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  // Ficha passando sobre a faixa: ela acende para dizer que aceita o soltar.
  // Presa ao arraste em curso, para apagar tambem quando ele acaba fora dela.
  const [sheetOver, setSheetOver] = useState(false);
  const draggingSheet = useStore((s) => s.dragging?.kind === 'sheet');

  void rev;
  if (!table) return null;

  const turns = table.turns;
  const entries = turns.entries;
  if (entries.length === 0) return null;

  // Tokens escondidos do grupo: a vez deles ja nao chega aos jogadores (o
  // servidor le a ocultacao do token), e a miniatura do mestre mostra isso.
  const concealedTokens = new Set(
    table.scenes.flatMap((s) => s.tokens).filter(concealedFromPlayers).map((t) => t.id),
  );

  function reorder(dragged: string, target: string, after: boolean): void {
    const ids = entries.map((e) => e.id).filter((id) => id !== dragged);
    const index = ids.indexOf(target);
    const at = index === -1 ? ids.length : index + (after ? 1 : 0);
    ids.splice(at, 0, dragged);
    void act('turns:reorder', { entryIds: ids });
  }

  function addSheet(sheetId: string): void {
    const sheet = findSheet(sheetId);
    if (!sheet) return;
    // A ordem e da cena no ar: o token da vez e o de la, mesmo com o mestre
    // montando outra cena no mapa.
    const token = liveScene(useStore.getState())?.tokens.find((t) => t.sheetId === sheet.id);
    void act('turns:add', {
      entries: [
        { sheetId: sheet.id, tokenId: token?.id ?? null, playerId: sheet.ownerPlayerId, name: sheet.name },
      ],
    });
  }

  function addSelected(): void {
    const scene = activeScene(useStore.getState());
    const chosen = scene?.tokens.filter((t) => selectedTokenIds.includes(t.id)) ?? [];
    if (chosen.length === 0) {
      notify('info', 'Selecione no mapa quem deve entrar na ordem.');
      return;
    }
    void act('turns:add', {
      entries: chosen.map((token) => ({
        tokenId: token.id,
        sheetId: token.sheetId,
        playerId: token.ownerPlayerId,
        name: findSheet(token.sheetId)?.name ?? token.name,
        // Sem `hiddenFromPlayers`: quem o mestre esconde do mapa ja fica fora
        // da ordem visivel pelo servidor, que le a ocultacao do token na hora
        // do envio. Gravar a flag aqui prendia a vez escondida mesmo depois de
        // o mestre revelar o token.
      })),
    });
  }

  const active = entries.find((e) => e.id === turns.activeEntryId) ?? null;
  const myTurn = !!active && active.playerId !== null && active.playerId === myId;

  /*
   * A fila nao rola: barra de rolagem no cabecalho e um alvo minusculo, e o
   * conteudo escondido nela nunca e encontrado. Passando do teto, a faixa
   * mostra uma janela em volta de quem esta com a vez e conta o resto — como
   * a lista de presenca ao lado ja faz.
   */
  const activeIndex = Math.max(0, entries.findIndex((e) => e.id === turns.activeEntryId));
  const start = Math.min(
    Math.max(0, activeIndex - Math.floor(MAX_VISIBLE / 2)),
    Math.max(0, entries.length - MAX_VISIBLE),
  );
  const visible = entries.length <= MAX_VISIBLE ? entries : entries.slice(start, start + MAX_VISIBLE);
  const rest = entries.length - visible.length;

  return (
    <div className="turn-bar">
      <div
        className={`turn-strip${sheetOver && draggingSheet ? ' sheet-over' : ''}`}
        onDragOver={(e) => {
          if (!gm) return;
          const payload = useStore.getState().dragging;
          if (dragId || payload?.kind === 'sheet') e.preventDefault();
          if (payload?.kind === 'sheet' && !sheetOver) setSheetOver(true);
        }}
        onDragLeave={(e) => {
          // Pelas coordenadas, e nao por relatedTarget: no Chrome ele chega
          // nulo, e passar de uma miniatura para outra apagava o destaque.
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) {
            setSheetOver(false);
          }
        }}
        onDrop={(e) => {
          setSheetOver(false);
          if (!gm) return;
          const payload = useStore.getState().dragging;
          if (payload?.kind === 'sheet') {
            e.preventDefault();
            addSheet(payload.sheetId);
          }
        }}
      >
        <span className="turn-round" title={`Rodada ${turns.round}`}>
          R{turns.round}
        </span>

        <div className="turn-minis">
          {visible.map((entry) => (
            <Mini
              key={entry.id}
              entry={entry}
              active={entry.id === turns.activeEntryId}
              mine={entry.playerId !== null && entry.playerId === myId}
              tokenConcealed={entry.tokenId !== null && concealedTokens.has(entry.tokenId)}
              gm={gm}
              dragging={dragId === entry.id}
              drop={dropAt?.id === entry.id ? (dropAt.after ? 'after' : 'before') : null}
              onFocusToken={() => entry.tokenId && selectToken(entry.tokenId)}
              onDragStart={() => setDragId(entry.id)}
              onDragEnd={() => {
                setDragId(null);
                setDropAt(null);
              }}
              onDragOverMini={(after) => {
                if (dragId && dragId !== entry.id) setDropAt({ id: entry.id, after });
              }}
              onDropMini={(after) => {
                if (dragId && dragId !== entry.id) reorder(dragId, entry.id, after);
                setDragId(null);
                setDropAt(null);
              }}
            />
          ))}
          {rest > 0 && (
            <span className="turn-rest" title={`Mais ${rest} na ordem`}>
              +{rest}
            </span>
          )}
        </div>

        {active && (
          <span className={`turn-now${myTurn ? ' mine' : ''}`}>
            {myTurn ? 'sua vez' : active.name}
          </span>
        )}

        {/* Quem esta com a vez a passa quando termina, sem esperar o mestre. */}
        {myTurn && !gm && table.settings.playersPassTurn && (
          <button
            className="btn sm turn-pass"
            onClick={() => void act('turns:pass')}
            title="Terminei: passar a vez para o proximo"
          >
            Passar
          </button>
        )}

        {gm && (
          <>
            <button
              className="btn ghost sm icon-only"
              onClick={() => void act('turns:previous')}
              title="Voltar a vez"
              aria-label="Voltar a vez"
            >
              <Icon name="previous" size="sm" />
            </button>
            <button
              className="btn ghost sm icon-only"
              onClick={() => void act('turns:next')}
              title="Passar a vez"
              aria-label="Passar a vez"
            >
              <Icon name="next" size="sm" />
            </button>
            <button
              className="btn ghost sm icon-only"
              onClick={addSelected}
              title="Coloca na ordem quem esta selecionado no mapa — ou arraste uma ficha ate aqui"
              aria-label="Colocar na ordem quem esta selecionado no mapa"
            >
              <Icon name="add" size="sm" />
            </button>
          </>
        )}

        {turns.history.length > 0 && (
          <button
            className={`btn ghost sm icon-only${showHistory ? ' on' : ''}`}
            onClick={() => setShowHistory((v) => !v)}
            title="Historico de turnos"
            aria-label="Historico de turnos"
            aria-expanded={showHistory}
          >
            <Icon name="history" size="sm" />
          </button>
        )}
      </div>

      {showHistory && turns.history.length > 0 && <History history={turns.history} />}
    </div>
  );
}

function Mini({
  entry,
  active,
  mine,
  tokenConcealed,
  gm,
  dragging,
  drop,
  onFocusToken,
  onDragStart,
  onDragEnd,
  onDragOverMini,
  onDropMini,
}: {
  entry: TurnEntry;
  active: boolean;
  mine: boolean;
  /** O token da vez esta oculto: ela some para os jogadores, com ou sem a flag. */
  tokenConcealed: boolean;
  gm: boolean;
  dragging: boolean;
  drop: 'before' | 'after' | null;
  onFocusToken: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverMini: (after: boolean) => void;
  onDropMini: (after: boolean) => void;
}): JSX.Element {
  const face = faceOf(entry);

  const classes = [
    'turn-mini',
    active ? 'active' : '',
    mine ? 'mine' : '',
    entry.skipped ? 'skipped' : '',
    entry.hiddenFromPlayers || tokenConcealed ? 'hidden-entry' : '',
    dragging ? 'dragging' : '',
    drop ? `drop-${drop}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  /** Metade esquerda da miniatura cai antes dela; metade direita, depois. */
  const sideOf = (e: React.DragEvent<HTMLDivElement>): boolean => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX > box.left + box.width / 2;
  };

  return (
    <div
      className={classes}
      style={{ ['--pc' as string]: face.color }}
      draggable={gm}
      onDragStart={(e) => {
        // Sem dados o Firefox cancela o arraste antes do primeiro dragover.
        e.dataTransfer.setData('text/plain', entry.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!gm) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOverMini(sideOf(e));
      }}
      onDrop={(e) => {
        if (!gm) return;
        // Ficha solta sobre a miniatura sobe para a faixa, que a poe na ordem.
        // Parar aqui engolia o soltar: so funcionava no fundo da faixa.
        if (useStore.getState().dragging?.kind === 'sheet') return;
        e.preventDefault();
        e.stopPropagation();
        onDropMini(sideOf(e));
      }}
    >
      <button
        className="face"
        onClick={() => (gm ? void act('turns:set', { entryId: entry.id }) : onFocusToken())}
        title={gm ? `${entry.name} — clique para dar a vez, arraste para mudar a ordem` : entry.name}
        aria-label={gm ? `Dar a vez a ${entry.name}` : entry.name}
      >
        {face.url ? (
          <img src={face.url} alt="" draggable={false} />
        ) : (
          <span className="initials">{initials(entry.name)}</span>
        )}
      </button>

      {gm && (
        <div className="turn-tools">
          <button
            className="btn ghost sm icon-only"
            onClick={() => void act('turns:update', { entryId: entry.id, patch: { skipped: !entry.skipped } })}
            title={entry.skipped ? 'Voltar a ordem' : 'Pular a vez'}
            aria-label={entry.skipped ? 'Voltar a ordem' : 'Pular a vez'}
          >
            <Icon name={entry.skipped ? 'resumeTurn' : 'skipTurn'} size="sm" />
          </button>
          {tokenConcealed ? (
            // Com o token oculto, a flag da vez nao muda nada para os
            // jogadores: o botao explica em vez de parecer que falhou.
            <button
              className="btn ghost sm icon-only"
              disabled
              title="Escondida porque o token esta oculto — revele o token para mostrar"
              aria-label="Escondida porque o token esta oculto"
            >
              <Icon name="blinded" size="sm" />
            </button>
          ) : (
            <button
              className="btn ghost sm icon-only"
              onClick={() =>
                void act('turns:update', {
                  entryId: entry.id,
                  patch: { hiddenFromPlayers: !entry.hiddenFromPlayers },
                })
              }
              title={entry.hiddenFromPlayers ? 'Mostrar aos jogadores' : 'Esconder dos jogadores'}
              aria-label={entry.hiddenFromPlayers ? 'Mostrar aos jogadores' : 'Esconder dos jogadores'}
            >
              <Icon name={entry.hiddenFromPlayers ? 'blinded' : 'vision'} size="sm" />
            </button>
          )}
          <button
            className="btn ghost sm icon-only"
            onClick={() => void act('turns:remove', { entryId: entry.id })}
            title="Tirar da ordem"
            aria-label="Tirar da ordem"
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Vezes mostradas de uma vez.
 *
 * O corte e por LINHA, e nao por rodada: numa mesa de dez participantes, uma
 * rodada sozinha ja sao dez nomes, e tres rodadas fariam um painel mais alto
 * que a tela. Sem rolagem, o que passa do fim da tela fica inalcancavel — pior
 * que a barra de rolagem que tiramos.
 */
const HISTORY_LINES = 12;

function History({ history }: { history: TurnRecord[] }): JSX.Element {
  // O fim da lista e o que interessa: as ultimas vezes jogadas.
  const recent = history.slice(-HISTORY_LINES);
  const older = history.length - recent.length;

  const rounds = new Map<number, TurnRecord[]>();
  for (const record of recent) {
    const list = rounds.get(record.round);
    if (list) list.push(record);
    else rounds.set(record.round, [record]);
  }

  // Da rodada mais recente para a mais antiga: e o que se quer conferir.
  const ordered = [...rounds.entries()].sort((a, b) => b[0] - a[0]);

  return (
    <div className="turn-history">
      <h4>Historico de turnos</h4>
      {ordered.map(([round, records]) => (
        <div key={round} className="turn-history-round">
          <span className="round-label">Rodada {round}</span>
          <ol>
            {records.map((record, i) => (
              <li key={`${record.entryId}-${i}`}>{record.name}</li>
            ))}
          </ol>
        </div>
      ))}
      {older > 0 && (
        <span className="hint">
          {older === 1 ? 'mais 1 vez antes destas' : `mais ${older} vezes antes destas`}
        </span>
      )}
    </div>
  );
}

/**
 * Retrato da miniatura, na ordem em que a imagem existe: a ficha do
 * personagem, depois a foto que a lista de presenca traz do colega, e por fim
 * a arte do token. Sem nenhuma, ficam as iniciais.
 */
function faceOf(entry: TurnEntry): { url: string | null; color: string } {
  const state = useStore.getState();
  const sheet = findSheet(entry.sheetId);
  const player = entry.playerId
    ? (state.table?.players.find((p) => p.id === entry.playerId) ?? null)
    : null;
  const token = entry.tokenId
    ? (liveScene(state)?.tokens.find((t) => t.id === entry.tokenId) ?? null)
    : null;

  const asset = findAsset(sheet?.portraitAssetId ?? player?.portraitAssetId ?? token?.assetId ?? null);

  return {
    url: asset?.thumbUrl ?? asset?.url ?? null,
    color: player?.color ?? token?.color ?? '#45506e',
  };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
