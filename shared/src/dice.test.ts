import { describe, expect, it } from 'vitest';

import {
  extractRollCommand,
  normalizeFormula,
  parseFormula,
  resolveFormulaRefs,
  rollFormula,
} from './dice.js';

/**
 * A rolagem e o unico lugar do projeto onde um erro passa despercebido: o
 * resultado e um numero plausivel de qualquer jeito. Um modificador negativo
 * aplicado como positivo so aparece quando alguem confere a conta a mao.
 */

/** Dado viciado: devolve sempre a face pedida, para o total ser previsivel. */
const always = (face: number, sides = 20) => () => (face - 0.5) / sides;

describe('normalizeFormula', () => {
  it('colapsa os sinais que uma referencia negativa produz', () => {
    // `1d20+@mod` com mod = -3 vira `1d20+-3`, que a gramatica nao aceita.
    expect(normalizeFormula('1d20+-3')).toBe('1d20-3');
    expect(normalizeFormula('1d20--3')).toBe('1d20+3');
    expect(normalizeFormula('1d20-+3')).toBe('1d20-3');
    expect(normalizeFormula('1d20++3')).toBe('1d20+3');
  });

  it('colapsa cadeias mais longas contando os sinais', () => {
    // Dois negativos se cancelam: + - - + resulta em +.
    expect(normalizeFormula('1d20+--+3')).toBe('1d20+3');
    // Tres negativos deixam o resultado negativo.
    expect(normalizeFormula('1d20+---3')).toBe('1d20-3');
  });

  it('remove espacos', () => {
    expect(normalizeFormula(' 2d6 + 4 ')).toBe('2d6+4');
  });
});

describe('parseFormula', () => {
  it('aceita as formas comuns', () => {
    expect(parseFormula('1d20').valid).toBe(true);
    expect(parseFormula('2d6+3').valid).toBe(true);
    expect(parseFormula('4d6kh3').valid).toBe(true);
    expect(parseFormula('d20-1').valid).toBe(true);
  });

  it('recusa o que nao e formula', () => {
    expect(parseFormula('bom dia').valid).toBe(false);
    expect(parseFormula('1d20 e depois corro').valid).toBe(false);
    expect(parseFormula('').valid).toBe(false);
  });
});

describe('rollFormula', () => {
  it('aplica o modificador negativo com o sinal certo', () => {
    // A regressao real: `min: 0` no campo fazia -3 virar 0, e o teste passava
    // por sorte porque a soma so destoava quando o d20 caia alto.
    const roll = rollFormula('1d20-3', always(10));
    expect(roll).not.toBeNull();
    expect(roll!.formula).toBe('1d20-3');
    expect(roll!.rolls).toEqual([10]);
    expect(roll!.total).toBe(7);
  });

  it('soma o modificador positivo', () => {
    const roll = rollFormula('1d20+5', always(10));
    expect(roll!.total).toBe(15);
  });

  it('mantem os melhores dados em kh', () => {
    let n = 0;
    const faces = [1, 6, 3, 5];
    const rng = () => (faces[n++ % faces.length] - 0.5) / 6;

    const roll = rollFormula('4d6kh3', rng);
    expect(roll).not.toBeNull();
    // Descarta o 1; sobram 6, 3 e 5.
    expect(roll!.total).toBe(14);
  });

  it('devolve null para texto que nao e rolagem', () => {
    expect(rollFormula('vou atacar o goblin')).toBeNull();
    expect(rollFormula('')).toBeNull();
  });

  it('recusa formula longa demais', () => {
    expect(rollFormula('1d6+'.repeat(40) + '1')).toBeNull();
  });
});

describe('resolveFormulaRefs', () => {
  it('substitui referencia numerica', () => {
    expect(resolveFormulaRefs('1d20+@forca', { forca: 4 })).toBe('1d20+4');
  });

  it('preserva o sinal do valor negativo', () => {
    // A saida intencionalmente fica com sinal duplo; normalizeFormula limpa.
    expect(resolveFormulaRefs('1d20+@mod', { mod: -3 })).toBe('1d20+-3');
    expect(normalizeFormula(resolveFormulaRefs('1d20+@mod', { mod: -3 }))).toBe('1d20-3');
  });

  it('le o campo de recurso pelo valor atual', () => {
    expect(resolveFormulaRefs('1d20+@pv', { pv: { current: 7, max: 12 } })).toBe('1d20+7');
  });

  it('trata referencia ausente como zero', () => {
    expect(resolveFormulaRefs('1d20+@nada', {})).toBe('1d20+0');
  });

  it('trunca valor fracionario', () => {
    expect(resolveFormulaRefs('1d20+@x', { x: 2.9 })).toBe('1d20+2');
  });
});

describe('extractRollCommand', () => {
  it('reconhece as formas de comando', () => {
    expect(extractRollCommand('/r 2d6+3')).toBe('2d6+3');
    expect(extractRollCommand('/roll d20')).toBe('d20');
    expect(extractRollCommand('/rolar 1d100')).toBe('1d100');
    expect(extractRollCommand('/d20+2')).toBe('d20+2');
  });

  it('ignora conversa comum', () => {
    expect(extractRollCommand('ataco o goblin')).toBeNull();
    expect(extractRollCommand('/sussurrar oi')).toBeNull();
  });
});
