import type { BoardItem, ClueBoard } from './types.js';

/**
 * Quadro de pistas: o que cada participante recebe.
 *
 * O quadro e colaborativo, mas os materiais nao sao: um cartao pregado pelo
 * grupo pode apontar para uma carta que so a Alice recebeu. Para quem nao tem
 * acesso, o cartao chega como "Material indisponivel" — sem titulo, sem
 * imagem e sem o id do material, que ja entregaria que ele existe. Quando o
 * material for compartilhado, o servidor reenvia o cartao completo.
 */

/** Versao do item para um observador que pode (ou nao) ver o material citado. */
export function boardItemForViewer(item: BoardItem, canSeeHandout: (handoutId: string) => boolean): BoardItem {
  if (item.kind !== 'handout') return item;
  if (item.handoutId && canSeeHandout(item.handoutId)) return { ...item, unavailable: false };
  return { ...item, handoutId: null, unavailable: true };
}

export function boardForViewer(board: ClueBoard, canSeeHandout: (handoutId: string) => boolean): ClueBoard {
  return {
    locked: board.locked,
    items: board.items.map((item) => boardItemForViewer(item, canSeeHandout)),
    threads: board.threads,
  };
}

/** Normaliza um quadro lido do banco ou de um backup. */
export function normalizeBoard(raw: Partial<ClueBoard> | null | undefined): ClueBoard {
  return {
    locked: Boolean(raw?.locked),
    items: Array.isArray(raw?.items) ? raw.items : [],
    threads: Array.isArray(raw?.threads) ? raw.threads : [],
  };
}
