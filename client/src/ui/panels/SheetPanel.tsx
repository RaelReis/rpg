import type { Sheet } from '@rpg/shared';

import { act } from '../../net/socket';
import { activeScene, findAsset, isGm, useStore } from '../../state/store';
import { Empty, SelectField, Section } from '../common';
import { Icon } from '../icons';
import { SheetView } from '../SheetView';

/**
 * Fichas.
 *
 * O mestre navega por todas as fichas da mesa (personagens, NPCs, monstros);
 * o jogador ve a propria e as que o grupo compartilhou.
 */
export function SheetPanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const playerId = useStore((s) => s.session?.playerId ?? null);
  const selectedId = useStore((s) => s.selectedSheetId);
  const selectSheet = useStore((s) => s.selectSheet);
  const openSheetModal = useStore((s) => s.openSheetModal);

  void rev;
  if (!table) return <Empty>Sem mesa carregada.</Empty>;

  /*
   * O jogador so escolhe entre fichas inteiras: a dele e as compartilhadas com
   * o grupo. As demais chegam reduzidas as barras (para os retratos do grupo),
   * e abertas aqui apareciam como ficha completa com zeros onde faltava campo —
   * foi assim que uma jogadora abriu, sem perceber, a ficha de outra pessoa.
   */
  const sheets = gm
    ? table.sheets
    : table.sheets.filter((s) => s.ownerPlayerId === playerId || s.sharedWithParty);
  const own = sheets.find((s) => s.ownerPlayerId === playerId) ?? null;
  const selected: Sheet | null =
    sheets.find((s) => s.id === selectedId) ?? own ?? (gm ? (sheets[0] ?? null) : null);

  return (
    <>
      <Section
        title={gm ? `Fichas (${sheets.length})` : 'Minha ficha'}
        actions={
          gm && (
            <>
              {/* Sempre a vista, mesmo sem nenhuma ficha: o botao ficava so
                  dentro de uma ficha aberta, e para montar o modelo antes de
                  os jogadores entrarem era preciso criar uma ficha a toa. */}
              <button
                className="btn ghost sm"
                onClick={() => useStore.getState().openTemplateEditor(true)}
                title="Editar o modelo de ficha da mesa"
              >
                Modelo
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  void act<Sheet>('sheet:create', { name: 'Nova ficha' }).then(
                    (sheet) => sheet && selectSheet(sheet.id),
                  )
                }
              >
                <Icon name="add" size="sm" /> Ficha
              </button>
            </>
          )
        }
      >
        {gm && sheets.length > 0 ? (
          <SheetRoster sheets={sheets} selectedId={selected?.id ?? null} onSelect={selectSheet} />
        ) : (
          sheets.length > 1 && (
            <SelectField
              label="Ficha em exibicao"
              value={selected?.id ?? ''}
              options={sheets.map((s) => ({
                value: s.id,
                label: `${s.name}${s.ownerPlayerId === playerId ? ' (sua)' : ''}`,
              }))}
              onChange={(v) => selectSheet(v)}
            />
          )
        )}

        {gm && selected && (
          <>
            <SelectField
              label="Dono"
              value={selected.ownerPlayerId ?? ''}
              options={[
                { value: '', label: 'Mestre / NPC' },
                ...table.players
                  .filter((p) => p.role === 'PLAYER')
                  .map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(v) => void act('sheet:assign', { sheetId: selected.id, playerId: v || null })}
            />

            <button
              className="btn ghost sm danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                const tokens = table.scenes.flatMap((s) => s.tokens).filter((t) => t.sheetId === selected.id).length;
                const which = tokens === 1 ? 'O token' : `Os ${tokens} tokens`;
                const extra = tokens > 0 ? `\n\n${which} dela e a vez na ordem saem junto.` : '';
                if (window.confirm(`Excluir a ficha "${selected.name}"?${extra}`)) {
                  void act('sheet:delete', { sheetId: selected.id });
                }
              }}
            >
              Excluir ficha
            </button>
          </>
        )}
      </Section>

      {selected ? (
        // A ficha ja monta as proprias secoes (com o mesmo Section colapsavel
        // dos outros paineis) — outro <section> em volta so duplicaria a borda.
        <SheetView key={selected.id} sheet={selected} onExpand={() => openSheetModal(selected.id)} />
      ) : (
        <section className="section">
          <Empty>
            {gm
              ? 'Nenhuma ficha criada ainda.'
              : // A mensagem antiga falava em "configurar o modelo", que nao era o
                // caso: sem ficha, o jogador so volta a ter uma pelo mestre.
                'Voce esta sem ficha nesta mesa. Peca ao mestre para criar uma para voce.'}
          </Empty>
        </section>
      )}
    </>
  );
}

/**
 * Lista de fichas do mestre, arrastavel para o mapa.
 *
 * Substitui o seletor para quem pode posicionar personagens: a ficha vira uma
 * peca que se pega e se solta no tabuleiro. Soltar coloca o personagem ali;
 * se ele ja esta na cena, e movido ate o ponto. O selo "no mapa" diz qual dos
 * dois vai acontecer antes de arrastar.
 */
function SheetRoster({
  sheets,
  selectedId,
  onSelect,
}: {
  sheets: Sheet[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const rev = useStore((s) => s.rev);
  const players = useStore((s) => s.table?.players ?? []);
  const setDragging = useStore((s) => s.setDragging);

  void rev;
  const scene = activeScene(useStore.getState());
  const onMap = new Set(scene?.tokens.flatMap((t) => (t.sheetId ? [t.sheetId] : [])) ?? []);

  return (
    <div className="sheet-roster">
      <span className="hint">Arraste uma ficha para o mapa para colocar ou mover o personagem.</span>
      <div className="list">
        {sheets.map((sheet) => {
          const owner = players.find((p) => p.id === sheet.ownerPlayerId);
          const portrait = findAsset(sheet.portraitAssetId);
          return (
            <button
              key={sheet.id}
              className={`item sheet-chip${sheet.id === selectedId ? ' active' : ''}`}
              onClick={() => onSelect(sheet.id)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-rpg-sheet', sheet.id);
                e.dataTransfer.effectAllowed = 'copyMove';
                setDragging({ kind: 'sheet', sheetId: sheet.id });
              }}
              onDragEnd={() => setDragging(null)}
              title={onMap.has(sheet.id) ? 'Arraste para mover o personagem no mapa' : 'Arraste para colocar no mapa'}
            >
              <span className="grip" aria-hidden="true">
                <Icon name="grip" size="sm" />
              </span>
              {portrait ? (
                <img className="swatch" src={portrait.thumbUrl ?? portrait.url} alt="" />
              ) : (
                <span className="swatch" style={{ background: owner?.color ?? 'var(--line)' }} />
              )}
              <span className="name">
                {sheet.name}
                <span className="sub"> · {owner ? owner.name : 'NPC'}</span>
              </span>
              {onMap.has(sheet.id) && <span className="tag">no mapa</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
