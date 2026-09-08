import { act } from '../net/socket';
import { isGm, useStore } from '../state/store';

/**
 * Faixa de turno sobre o mapa.
 *
 * A barra lateral ja lista a ordem inteira, mas durante a partida a pergunta
 * urgente e uma so: de quem e a vez. Ela fica sobre o mapa, onde os olhos
 * ja estao, e o token correspondente ganha um anel pulsante no canvas.
 */
export function TurnBanner(): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const gm = useStore(isGm);
  const playerId = useStore((s) => s.session?.playerId ?? null);
  const table = useStore((s) => s.table);

  void rev;
  const initiative = table?.initiative;
  if (!initiative?.active) return null;

  const active = initiative.entries.find((e) => e.id === initiative.activeEntryId);
  if (!active) return null;

  const isMyTurn = active.playerId !== null && active.playerId === playerId;
  const canAdvance = gm || (initiative.autoAdvance && isMyTurn);

  return (
    <div className="turn-banner">
      <span className="round">Rodada {initiative.round}</span>
      <span className="who">{active.name}</span>
      {isMyTurn && <span className="tag on">sua vez</span>}

      {gm && (
        <button className="btn ghost sm" onClick={() => void act('initiative:previous')} title="Turno anterior">
          ‹
        </button>
      )}
      {canAdvance && (
        <button className="btn sm" onClick={() => void act('initiative:next')}>
          {isMyTurn && !gm ? 'Encerrar meu turno' : 'Proximo'} ›
        </button>
      )}
    </div>
  );
}
