/**
 * Compactacao das celulas de neblina para gravacao.
 *
 * `fog.explored` e uma lista de chaves `"a,b"`, uma por celula descoberta. A
 * forma e otima para consultar (vira um Set) e pessima para guardar: cada
 * celula custa cerca de nove bytes no JSON, e a cena inteira e reserializada
 * a cada gravacao. Um mapa grande totalmente explorado passa das dezenas de
 * milhares de entradas, e todo flush carrega esse peso.
 *
 * A observacao que resolve: exploracao acontece em faixas. Um personagem
 * andando por um corredor descobre celulas vizinhas na mesma linha, entao
 * `10,4  11,4  12,4` — 27 bytes — vira a faixa `[10,12]`.
 *
 * Isto vale APENAS na fronteira da persistencia. Em memoria e no protocolo a
 * lista continua sendo `string[]`: mudar o formato ali obrigaria cliente,
 * servidor e calculo de visao a concordarem sobre uma representacao nova, e o
 * ganho nao justifica o risco.
 */

/** Faixas por linha: `{ "4": [[10, 12], [18, 22]] }`. */
export type ExploredRuns = Record<string, [number, number][]>;

export function encodeExploredCells(keys: string[]): ExploredRuns {
  const byRow = new Map<number, number[]>();

  for (const key of keys) {
    const comma = key.indexOf(',');
    if (comma <= 0) continue;
    const a = Number(key.slice(0, comma));
    const b = Number(key.slice(comma + 1));
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    const row = byRow.get(b);
    if (row) row.push(a);
    else byRow.set(b, [a]);
  }

  const out: ExploredRuns = {};
  for (const [b, columns] of byRow) {
    columns.sort((x, y) => x - y);

    const runs: [number, number][] = [];
    let start = columns[0];
    let previous = columns[0];

    for (let i = 1; i < columns.length; i++) {
      const current = columns[i];
      if (current === previous) continue; // duplicata
      if (current === previous + 1) {
        previous = current;
        continue;
      }
      runs.push([start, previous]);
      start = current;
      previous = current;
    }
    runs.push([start, previous]);
    out[String(b)] = runs;
  }
  return out;
}

export function decodeExploredCells(runs: ExploredRuns | null | undefined): string[] {
  if (!runs || typeof runs !== 'object') return [];

  const out: string[] = [];
  for (const [rowKey, ranges] of Object.entries(runs)) {
    const b = Number(rowKey);
    if (!Number.isFinite(b) || !Array.isArray(ranges)) continue;

    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2) continue;
      const [from, to] = range;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
      for (let a = from; a <= to; a++) out.push(`${a},${b}`);
    }
  }
  return out;
}
