import { useEffect, useRef, useState } from 'react';
import {
  isResourceValue,
  vitalFields,
  type Player,
  type ResourceValue,
  type Sheet,
  type SheetField,
  type VitalRole,
} from '@rpg/shared';

import { activeScene, liveScene, findAsset, isGm, useStore } from '../state/store';
import { Icon } from './icons';

/**
 * Retratos do grupo sobre o mapa.
 *
 * Durante a cena ninguem abre a ficha para saber quanto aguenta: a pergunta e
 * so "quanto de PV e de PD sobrou". Os retratos respondem isso de relance,
 * no canto do mapa, com a foto do personagem, o nome e as duas resistencias.
 *
 * O jogador ve o proprio personagem primeiro, e os colegas quando o servidor
 * manda esses valores (ficha compartilhada, ou barras do grupo ligadas). O
 * mestre ve todos os personagens de jogador.
 */

const OPEN_KEY = 'rpg-vtt:party-hud-open';

/** Ate este maximo, o recurso vira quadradinhos, como na ficha impressa. */
const MAX_PIPS = 20;

/**
 * O jogador abre com os retratos a vista; o mestre, nao.
 *
 * A tela do mestre ja tem os mesmos numeros em tres lugares — barras sobre os
 * tokens, aba Fichas e retratos —, e e a dele que fica cheia. Quem escolher o
 * contrario tem a escolha guardada.
 */
function readOpen(gm: boolean): boolean {
  try {
    const saved = localStorage.getItem(OPEN_KEY);
    if (saved !== null) return saved !== '0';
  } catch {
    // Sem storage, vale o padrao do papel.
  }
  return !gm;
}

export function PartyHud(): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const myId = useStore((s) => s.session?.playerId ?? null);
  const gm = useStore(isGm);
  const openSheet = useStore((s) => s.openSheetModal);
  const [open, setOpen] = useState(() => readOpen(gm));

  void rev;
  if (!table) return null;

  const { pv, pd } = vitalFields(table.sheetTemplate);
  if (!pv && !pd) return null;

  const playerOrder = new Map(table.players.map((p, i) => [p.id, i]));
  const characters = table.sheets
    .filter((sheet) => {
      if (!sheet.ownerPlayerId) return false;
      if (gm || sheet.ownerPlayerId === myId) return true;
      // Colega: so aparece se o servidor mandou ao menos uma das resistencias.
      return [pv, pd].some((f) => f && isResourceValue(sheet.values[f.id]));
    })
    .sort((a, b) => {
      if (a.ownerPlayerId === myId) return -1;
      if (b.ownerPlayerId === myId) return 1;
      return (playerOrder.get(a.ownerPlayerId!) ?? 99) - (playerOrder.get(b.ownerPlayerId!) ?? 99);
    });

  if (characters.length === 0) return null;

  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem(OPEN_KEY, was ? '0' : '1');
      } catch {
        // Sem storage, a escolha dura so a aba.
      }
      return !was;
    });
  };

  // Quem esta em turno: pela entrada ligada ao jogador, a ficha ou ao token.
  const turns = table.turns;
  const activeEntry = turns.entries.find((e) => e.id === turns.activeEntryId);
  // A vez e da cena no ar, mesmo com o mestre montando outra no mapa.
  const scene = liveScene(useStore.getState());
  const activeSheetId =
    activeEntry?.sheetId ??
    (activeEntry?.tokenId
      ? (scene?.tokens.find((t) => t.id === activeEntry.tokenId)?.sheetId ?? null)
      : null);

  return (
    <section className={`party-hud${open ? '' : ' closed'}`} aria-label="Retratos do grupo">
      <button className="party-hud-toggle" onClick={toggle} aria-expanded={open}>
        Grupo <Icon name={open ? 'expand' : 'collapsed'} size="sm" />
      </button>

      {open && (
        <div className="party-hud-row">
          {characters.map((sheet) => {
            const owner = table.players.find((p) => p.id === sheet.ownerPlayerId) ?? null;
            const canOpen = gm || sheet.ownerPlayerId === myId || sheet.sharedWithParty;
            const onTurn =
              !!activeEntry &&
              (activeSheetId === sheet.id || (activeEntry.playerId !== null && activeEntry.playerId === owner?.id));
            return (
              <CharacterPortrait
                key={sheet.id}
                sheet={sheet}
                owner={owner}
                pv={pv}
                pd={pd}
                mine={sheet.ownerPlayerId === myId}
                onTurn={onTurn}
                onOpen={canOpen ? () => openSheet(sheet.id) : null}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function CharacterPortrait({
  sheet,
  owner,
  pv,
  pd,
  mine,
  onTurn,
  onOpen,
}: {
  sheet: Sheet;
  owner: Player | null;
  pv: SheetField | null;
  pd: SheetField | null;
  mine: boolean;
  onTurn: boolean;
  onOpen: (() => void) | null;
}): JSX.Element {
  // A ficha do colega chega reduzida, sem retrato; a lista de presenca traz.
  const portrait = findAsset(sheet.portraitAssetId ?? owner?.portraitAssetId);
  const pvValue = pv ? asResource(sheet.values[pv.id]) : null;
  const pdValue = pd ? asResource(sheet.values[pd.id]) : null;

  // No sistema, chegar a 0 PV ou 0 PD obriga a um teste para continuar de pe.
  const dying = pvValue !== null && pvValue.max > 0 && pvValue.current <= 0;
  const breaking = pdValue !== null && pdValue.max > 0 && pdValue.current <= 0;
  const stamp = dying ? 'Morrendo' : breaking ? 'Em colapso' : null;

  const classes = [
    'hud-card',
    mine ? 'mine' : '',
    onTurn ? 'on-turn' : '',
    dying || breaking ? 'fallen' : '',
    owner && !owner.connected ? 'offline' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const title = [
    sheet.name,
    owner ? `jogador: ${owner.name}${owner.connected ? '' : ' (offline)'}` : null,
    onOpen ? 'clique para abrir a ficha' : null,
  ]
    .filter(Boolean)
    .join(' — ');

  const portraitContent = portrait ? (
    <img src={portrait.thumbUrl ?? portrait.url} alt="" draggable={false} />
  ) : (
    <span className="hud-initials">{initials(sheet.name)}</span>
  );

  return (
    <article className={classes} style={{ ['--pc' as string]: owner?.color ?? '#7a8bd4' }} title={title}>
      {onOpen ? (
        <button className="hud-portrait" onClick={onOpen} aria-label={`Abrir a ficha de ${sheet.name}`}>
          {portraitContent}
          {stamp && <span className="hud-stamp">{stamp}</span>}
        </button>
      ) : (
        <div className="hud-portrait">
          {portraitContent}
          {stamp && <span className="hud-stamp">{stamp}</span>}
        </div>
      )}

      <div className="hud-name">{sheet.name}</div>

      <div className="hud-vitals">
        {pv && pvValue && <VitalBar role="pv" field={pv} value={pvValue} />}
        {pd && pdValue && <VitalBar role="pd" field={pd} value={pdValue} />}
      </div>
    </article>
  );
}

/**
 * Uma resistencia: selo com a sigla, o valor e a trilha.
 *
 * Ate 20 pontos a trilha e de quadradinhos, um por ponto — a mesma leitura da
 * ficha impressa, em que se risca um quadrado por dano. Acima disso vira uma
 * barra continua, porque quadrados demais deixam de ser legiveis.
 */
function VitalBar({ role, field, value }: { role: VitalRole; field: SheetField; value: ResourceValue }): JSX.Element {
  const flash = useChangeFlash(value.current);
  const ratio = value.max > 0 ? Math.max(0, Math.min(1, value.current / value.max)) : 0;
  const low = value.max > 0 && ratio <= 0.25;
  const pips = value.max > 0 && value.max <= MAX_PIPS;

  return (
    <div
      className={`hud-vital ${role}${low ? ' low' : ''}${flash ? ` ${flash}` : ''}`}
      style={{ ['--vital' as string]: field.color }}
      aria-label={`${field.label}: ${value.current} de ${value.max}`}
    >
      <div className="hud-vital-head">
        <span className="hud-tape">{role.toUpperCase()}</span>
        <span className="hud-value mono">
          {value.current}
          <span className="hud-max">/{value.max}</span>
        </span>
      </div>

      {pips ? (
        <div className="hud-pips" style={{ gridTemplateColumns: `repeat(${Math.min(10, value.max)}, 1fr)` }}>
          {Array.from({ length: value.max }, (_, i) => (
            <span key={i} className={i < value.current ? 'on' : ''} />
          ))}
        </div>
      ) : (
        <div className="hud-track">
          <div className="hud-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * Pisca quando o valor muda: vermelho ao perder, verde ao recuperar.
 *
 * O dano de um colega acontece enquanto a pessoa olha para outra coisa; o
 * lampejo e o que puxa o olho para o retrato certo.
 */
function useChangeFlash(current: number): 'hurt' | 'heal' | null {
  const previous = useRef(current);
  const [flash, setFlash] = useState<'hurt' | 'heal' | null>(null);

  useEffect(() => {
    if (current === previous.current) return;
    setFlash(current < previous.current ? 'hurt' : 'heal');
    previous.current = current;
    const timer = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(timer);
  }, [current]);

  return flash;
}

function asResource(v: unknown): ResourceValue | null {
  return isResourceValue(v) ? v : null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
