import type { DiceRoll, FieldValue } from './types.js';

/**
 * Rolagem de dados agnostica de sistema: soma de termos `NdM`, com
 * modificadores fixos. Suporta manter os melhores/piores dados (`4d6kh3`),
 * que aparece em varios sistemas sem ser especifico de nenhum.
 */

const TERM = /([+-]?)\s*(?:(\d*)d(\d+)(?:(kh|kl)(\d+))?|(\d+))/gi;

export const MAX_DICE = 100;
export const MAX_SIDES = 1000;

/**
 * Colapsa sinais encadeados. Uma formula com referencia — `1d20+@mod` — vira
 * `1d20+-2` quando o modificador e negativo, e a gramatica de termos nao
 * aceita dois sinais seguidos. Normalizar aqui resolve para qualquer entrada,
 * inclusive a digitada a mao no chat.
 */
export function normalizeFormula(formula: string): string {
  let out = formula.replace(/\s+/g, '');
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = out.replace(/\+-|-\+/g, '-').replace(/--/g, '+').replace(/\+\+/g, '+');
  }
  return out;
}

export function parseFormula(formula: string): { valid: boolean; terms: number } {
  const clean = normalizeFormula(formula);
  const matches = clean.match(new RegExp(TERM.source, 'gi'));
  if (!matches) return { valid: false, terms: 0 };
  return { valid: matches.join('').length === clean.length, terms: matches.length };
}

/**
 * Executa a formula. Devolve null se ela nao for reconhecida, para que o
 * chamador trate a mensagem como texto normal de chat.
 */
export function rollFormula(formula: string, rng: () => number = Math.random): DiceRoll | null {
  const clean = normalizeFormula(formula);
  if (!clean || clean.length > 100) return null;
  if (!parseFormula(clean).valid) return null;

  const rolls: number[] = [];
  let total = 0;
  let modifier = 0;
  let matched = false;

  TERM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERM.exec(clean)) !== null) {
    matched = true;
    const sign = m[1] === '-' ? -1 : 1;

    if (m[6] !== undefined) {
      const flat = parseInt(m[6], 10) * sign;
      modifier += flat;
      total += flat;
      continue;
    }

    const count = Math.min(m[2] ? parseInt(m[2], 10) : 1, MAX_DICE);
    const sides = Math.min(parseInt(m[3], 10), MAX_SIDES);
    if (count < 1 || sides < 1) return null;

    const group: number[] = [];
    for (let i = 0; i < count; i++) group.push(1 + Math.floor(rng() * sides));
    rolls.push(...group);

    let kept = group;
    if (m[4] && m[5]) {
      const keep = Math.min(parseInt(m[5], 10), group.length);
      const sorted = [...group].sort((a, b) => (m![4]!.toLowerCase() === 'kh' ? b - a : a - b));
      kept = sorted.slice(0, keep);
    }

    total += sign * kept.reduce((s, n) => s + n, 0);
  }

  if (!matched) return null;
  return { formula: clean, rolls, modifier, total };
}

/**
 * Troca referencias a campos da ficha pelos valores, para que uma formula
 * como `1d20+@destreza` continue valida quando o atributo mudar.
 *
 * Campos de recurso (vida, mana) entram pelo valor ATUAL, nao pelo maximo —
 * uma formula que depende de vitalidade deve acompanhar o desgaste. Referencia
 * inexistente ou nao numerica vira 0, para uma ficha incompleta nao quebrar a
 * rolagem inteira.
 */
export function resolveFormulaRefs(
  formula: string,
  values: Record<string, FieldValue>,
): string {
  return formula.replace(/@([A-Za-z0-9_-]+)/g, (_match, id: string) => {
    const value = values[id];
    let n = 0;

    if (typeof value === 'number') n = value;
    else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { current?: unknown }).current === 'number'
    ) {
      n = (value as { current: number }).current;
    }

    return String(Math.trunc(n));
  });
}

/** Detecta comandos de rolagem digitados no chat: `/r 2d6+3` ou `/roll d20`. */
export function extractRollCommand(text: string): string | null {
  const m = text.trim().match(/^\/(?:r|roll|rolar|d)\s+(.+)$/i);
  if (m) return m[1];
  const short = text.trim().match(/^\/(d\d+.*)$/i);
  return short ? short[1] : null;
}
