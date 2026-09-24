import type { Role } from './types.js';

/**
 * Quadro de pistas: a cortica onde o grupo monta a investigacao.
 *
 * Um por mesa, colaborativo: todos criam, movem e editam; apagar e de quem
 * criou e do mestre. O mestre pode travar o quadro, e ai ele vira somente
 * leitura para os jogadores — no servidor, e nao so na interface.
 */

export type BoardItemKind = 'note' | 'image' | 'handout';

export interface BoardItem {
  id: string;
  kind: BoardItemKind;
  /** Canto superior esquerdo, em pixels do quadro. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Leve inclinacao, como papel pregado a mao. Em graus. */
  rotation: number;
  /** Nota: o texto. */
  text: string;
  /** Nota: a cor do papel. */
  color: string;
  /** Imagem enviada. */
  assetId: string | null;
  /**
   * Cartao de material: referencia a um item de Materiais.
   *
   * Para quem nao tem acesso ao material, sai `null` com `unavailable` —
   * nem o id, que ja diria que o material existe.
   */
  handoutId: string | null;
  /** So no payload: o material existe, mas este jogador nao tem acesso. */
  unavailable?: boolean;
  /** Quem criou; so ele e o mestre apagam. `null` = autor que nao esta mais na mesa. */
  authorId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BoardThread {
  id: string;
  fromId: string;
  toId: string;
  color: string;
  authorId: string | null;
}

export interface ClueBoard {
  locked: boolean;
  items: BoardItem[];
  threads: BoardThread[];
}

export const EMPTY_BOARD: ClueBoard = { locked: false, items: [], threads: [] };

export const BOARD_LIMITS = {
  items: 300,
  threads: 400,
  text: 1000,
  /** Lado maximo do quadro, em pixels, nas duas direcoes a partir da origem. */
  extent: 20000,
} as const;

export const NOTE_COLORS = ['#f2dc8d', '#f4b6a6', '#b9dfb0', '#aecbe8', '#e6e1d6'];
export const THREAD_COLORS = ['#c0392b', '#2c3e8f', '#1e7a4c', '#d4a017', '#111111'];

/** O quadro aceita mudancas deste papel agora? */
export function canEditBoard(board: Pick<ClueBoard, 'locked'>, role: Role): boolean {
  return role === 'GM' || !board.locked;
}

/** Apagar um item ou fio: o autor e o mestre, e o autor so com o quadro aberto. */
export function canDeleteOnBoard(
  board: Pick<ClueBoard, 'locked'>,
  thing: { authorId: string | null },
  role: Role,
  playerId: string | null,
): boolean {
  if (role === 'GM') return true;
  if (board.locked) return false;
  return thing.authorId !== null && thing.authorId === playerId;
}

/**
 * O item como sai para quem nao pode ver o material referenciado.
 *
 * Titulo e imagem nem estao no item — vem do material, que o jogador so
 * recebe se tiver acesso. O que resta a esconder e a referencia.
 */
export function boardItemFor(item: BoardItem, handoutVisible: boolean): BoardItem {
  if (item.kind !== 'handout' || handoutVisible) {
    return item.unavailable ? { ...item, unavailable: undefined } : item;
  }
  return { ...item, handoutId: null, unavailable: true };
}

export function normalizeBoard(raw: Partial<ClueBoard> | null | undefined): ClueBoard {
  return {
    locked: Boolean(raw?.locked),
    items: Array.isArray(raw?.items) ? raw.items : [],
    threads: Array.isArray(raw?.threads) ? raw.threads : [],
  };
}
