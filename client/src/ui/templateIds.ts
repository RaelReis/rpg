/*
 * Ids de campo do modelo de ficha. Ficam fora do editor para poder ser
 * testados: um erro aqui quebra formulas em silencio.
 */

/**
 * Id de campo a partir do nome: `Destreza` vira `destreza`, `Pontos de Vida`
 * vira `pontos_de_vida`. E o que o mestre escreve nas formulas (`1d20+@destreza`);
 * o id aleatorio de antes (`fld_eqa0f9zga6ec`) nao dava para lembrar nem ler,
 * e aparecia ate no tooltip do dado. So usa o que a formula aceita apos o @.
 */
export function slugOf(label: string): string {
  return (
    label
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'campo'
  );
}

/** `base`, ou `base_2`, `base_3`... o primeiro que ninguem mais usa. */
export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Troca `@antigo` por `@novo` numa formula, sem pegar ids que so comecam igual. */
export function renameRef(formula: string, from: string, to: string): string {
  return formula.replace(new RegExp(`@${from.replace(/[-]/g, '\\-')}(?![A-Za-z0-9_-])`, 'g'), `@${to}`);
}
