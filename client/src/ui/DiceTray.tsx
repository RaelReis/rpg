import { useState } from 'react';

import { act } from '../net/socket';
import { Icon, type IconName } from './icons';

/**
 * Bandeja de dados.
 *
 * Os tres botoes fixos de antes (d20, 2d6, d100) cobriam um sistema so. Aqui
 * estao os solidos que os sistemas de mesa usam, e a quantidade se monta
 * clicando: cada clique no dado soma mais um ao punhado. E o gesto da mesa
 * fisica — pegar tres d6 na mao antes de jogar —, e evita obrigar a pessoa a
 * lembrar a sintaxe `/r 3d6+2` no meio da cena.
 *
 * Quem prefere digitar continua digitando: o campo de mensagem aceita `/r`.
 *
 * A rolagem em si e do servidor. A animacao daqui e so a espera: o dado gira
 * enquanto o resultado nao chega, e o resultado aparece no chat.
 */

const DICE: { name: IconName; sides: number }[] = [
  { name: 'd4', sides: 4 },
  { name: 'd6', sides: 6 },
  { name: 'd8', sides: 8 },
  { name: 'd10', sides: 10 },
  { name: 'd12', sides: 12 },
  { name: 'd20', sides: 20 },
];

/** Tempo minimo do giro: sem isto, um servidor local nem mostra a animacao. */
const SPIN_MS = 520;

export function DiceTray({ whisper }: { whisper: boolean }): JSX.Element {
  const [pool, setPool] = useState<Record<number, number>>({});
  const [modifier, setModifier] = useState(0);
  const [rolling, setRolling] = useState(false);

  const chosen = DICE.filter((d) => (pool[d.sides] ?? 0) > 0);
  const formula = buildFormula(pool, modifier);

  function add(sides: number, amount: number): void {
    setPool((previous) => {
      const next = Math.max(0, Math.min(20, (previous[sides] ?? 0) + amount));
      return { ...previous, [sides]: next };
    });
  }

  async function roll(): Promise<void> {
    if (!formula || rolling) return;
    setRolling(true);
    const started = Date.now();
    await act('chat:send', { text: `/r ${formula}`, whisper });
    // O giro completa mesmo quando a resposta volta na hora.
    const left = Math.max(0, SPIN_MS - (Date.now() - started));
    setTimeout(() => setRolling(false), left);
  }

  return (
    <div className="dice-tray">
      <div className="dice-row">
        {DICE.map((die) => {
          const count = pool[die.sides] ?? 0;
          return (
            <button
              key={die.sides}
              type="button"
              className={`dice-btn${count > 0 ? ' on' : ''}`}
              onClick={() => add(die.sides, 1)}
              onContextMenu={(e) => {
                // Botao direito tira um, para corrigir sem limpar tudo.
                e.preventDefault();
                add(die.sides, -1);
              }}
              title={`Somar um d${die.sides} (botao direito tira um)`}
              aria-label={`Somar um d${die.sides}`}
            >
              <Icon name={die.name} size="lg" />
              <span className="dice-name">d{die.sides}</span>
              {count > 0 && <span className="dice-count">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="row">
        <label className="dice-mod">
          <span className="label">Mod</span>
          <input
            className="input mono"
            type="number"
            value={modifier}
            min={-99}
            max={99}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next)) setModifier(Math.trunc(next));
            }}
          />
        </label>

        <span className={`dice-formula mono${formula ? '' : ' empty'}`}>
          {formula || 'escolha os dados'}
        </span>

        <div className="spacer" />

        {(chosen.length > 0 || modifier !== 0) && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setPool({});
              setModifier(0);
            }}
          >
            Limpar
          </button>
        )}

        <button
          type="button"
          className={`btn primary sm dice-roll${rolling ? ' rolling' : ''}`}
          disabled={!formula || rolling}
          onClick={() => void roll()}
        >
          <Icon name="d20" size="sm" className="dice-spin" />
          {rolling ? 'Rolando' : 'Rolar'}
        </button>
      </div>
    </div>
  );
}

/** `{6: 2, 20: 1}` com modificador 3 vira `2d6+1d20+3`. */
function buildFormula(pool: Record<number, number>, modifier: number): string {
  const terms = DICE.filter((d) => (pool[d.sides] ?? 0) > 0).map(
    (d) => `${pool[d.sides]}d${d.sides}`,
  );
  if (terms.length === 0) return '';

  let formula = terms.join('+');
  if (modifier > 0) formula += `+${modifier}`;
  else if (modifier < 0) formula += `${modifier}`;
  return formula;
}
