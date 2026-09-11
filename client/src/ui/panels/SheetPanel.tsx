import type { Sheet } from '@rpg/shared';

import { act } from '../../net/socket';
import { activeScene, findAsset, isGm, useStore } from '../../state/store';
import { Empty, SelectField, Section } from '../common';
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

  void rev;
  if (!table) return <Empty>Sem mesa carregada.</Empty>;

  const sheets = table.sheets;
  const own = sheets.find((s) => s.ownerPlayerId === playerId) ?? null;
  const selected: Sheet | null =
    sheets.find((s) => s.id === selectedId) ?? own ?? (gm ? (sheets[0] ?? null) : null);

  return (
    <>
      <Section
        title={gm ? `Fichas (${sheets.length})` : 'Minha ficha'}
        actions={
          gm && (
            <button
              className="btn sm"
              onClick={() =>
                void act<Sheet>('sheet:create', { name: 'Nova ficha' }).then(
                  (sheet) => sheet && selectSheet(sheet.id),
                )
              }
            >
              + Ficha
            </button>
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
                if (window.confirm(`Excluir a ficha "${selected.name}"?`)) {
                  void act('sheet:delete', { sheetId: selected.id });
                }
              }}
            >
              Excluir ficha
            </button>
          </>
        )}
      </Section>

      <section className="section">
        {selected ? (
          <SheetView sheet={selected} />
        ) : (
          <Empty>
            {gm
              ? 'Nenhuma ficha criada ainda.'
              : 'Sua ficha aparecera assim que o mestre configurar o modelo.'}
          </Empty>
        )}
      </section>
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
                ⠿
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
