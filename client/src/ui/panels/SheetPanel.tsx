import type { Sheet } from '@rpg/shared';

import { act } from '../../net/socket';
import { isGm, useStore } from '../../state/store';
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
        {sheets.length > 1 && (
          <SelectField
            label="Ficha em exibicao"
            value={selected?.id ?? ''}
            options={sheets.map((s) => ({
              value: s.id,
              label: `${s.name}${s.ownerPlayerId === playerId ? ' (sua)' : ''}`,
            }))}
            onChange={(v) => selectSheet(v)}
          />
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
