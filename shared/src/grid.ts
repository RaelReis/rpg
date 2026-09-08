import type { Cell, GridConfig, Point } from './types.js';

/**
 * Conversoes de grid. Uma unica API cobre grid quadrada e hexagonal
 * (pointy-top e flat-top), para que renderizador, snap, medicao de
 * distancia e calculo de visao nao precisem se ramificar por tipo.
 *
 * Em hex usamos coordenadas axiais (q, r) guardadas em Cell como (a, b).
 * `grid.size` e sempre a LARGURA da celula em pixels; o raio do hexagono
 * e derivado dai, para que trocar de quadrada para hex mantenha a escala.
 */

const SQRT3 = Math.sqrt(3);

export function isHex(grid: GridConfig): boolean {
  return grid.type === 'hex-pointy' || grid.type === 'hex-flat';
}

/** Raio (centro -> vertice) do hexagono, derivado da largura da celula. */
export function hexRadius(grid: GridConfig): number {
  return grid.type === 'hex-flat' ? grid.size / 2 : grid.size / SQRT3;
}

/** Altura ocupada por uma celula, util para dimensionar tokens. */
export function cellHeight(grid: GridConfig): number {
  if (grid.type === 'hex-pointy') return hexRadius(grid) * 2;
  if (grid.type === 'hex-flat') return hexRadius(grid) * SQRT3;
  return grid.size;
}

export function cellKey(cell: Cell): string {
  return `${cell.a},${cell.b}`;
}

export function parseCellKey(key: string): Cell {
  const i = key.indexOf(',');
  return { a: Number(key.slice(0, i)), b: Number(key.slice(i + 1)) };
}

export function cellEquals(a: Cell, b: Cell): boolean {
  return a.a === b.a && a.b === b.b;
}

// ---------------------------------------------------------------------------
// pixel -> celula
// ---------------------------------------------------------------------------

export function cellAt(grid: GridConfig, p: Point): Cell {
  const x = p.x - grid.offsetX;
  const y = p.y - grid.offsetY;

  if (grid.type === 'none') {
    return { a: Math.floor(x / grid.size), b: Math.floor(y / grid.size) };
  }
  if (grid.type === 'square') {
    return { a: Math.floor(x / grid.size), b: Math.floor(y / grid.size) };
  }

  const R = hexRadius(grid);
  let q: number;
  let r: number;
  if (grid.type === 'hex-pointy') {
    q = ((SQRT3 / 3) * x - (1 / 3) * y) / R;
    r = ((2 / 3) * y) / R;
  } else {
    q = ((2 / 3) * x) / R;
    r = ((-1 / 3) * x + (SQRT3 / 3) * y) / R;
  }
  return axialRound(q, r);
}

/** Arredonda coordenada axial fracionaria para o hexagono mais proximo. */
function axialRound(q: number, r: number): Cell {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);

  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);

  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;

  return { a: rq, b: rr };
}

// ---------------------------------------------------------------------------
// celula -> pixel
// ---------------------------------------------------------------------------

/** Centro geometrico da celula, em pixels do mapa. */
export function cellCenter(grid: GridConfig, cell: Cell): Point {
  if (grid.type === 'square' || grid.type === 'none') {
    return {
      x: grid.offsetX + (cell.a + 0.5) * grid.size,
      y: grid.offsetY + (cell.b + 0.5) * grid.size,
    };
  }

  const R = hexRadius(grid);
  if (grid.type === 'hex-pointy') {
    return {
      x: grid.offsetX + R * (SQRT3 * cell.a + (SQRT3 / 2) * cell.b),
      y: grid.offsetY + R * ((3 / 2) * cell.b),
    };
  }
  return {
    x: grid.offsetX + R * ((3 / 2) * cell.a),
    y: grid.offsetY + R * ((SQRT3 / 2) * cell.a + SQRT3 * cell.b),
  };
}

/** Canto superior esquerdo do retangulo que envolve a celula. */
export function cellTopLeft(grid: GridConfig, cell: Cell): Point {
  const c = cellCenter(grid, cell);
  return { x: c.x - grid.size / 2, y: c.y - cellHeight(grid) / 2 };
}

/** Vertices da celula, para desenhar a grid e realces. */
export function cellCorners(grid: GridConfig, cell: Cell): Point[] {
  const c = cellCenter(grid, cell);

  if (grid.type === 'square' || grid.type === 'none') {
    const h = grid.size / 2;
    return [
      { x: c.x - h, y: c.y - h },
      { x: c.x + h, y: c.y - h },
      { x: c.x + h, y: c.y + h },
      { x: c.x - h, y: c.y + h },
    ];
  }

  const R = hexRadius(grid);
  const startAngle = grid.type === 'hex-pointy' ? -Math.PI / 2 : 0;
  const pts: Point[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = startAngle + (i * Math.PI) / 3;
    pts.push({ x: c.x + R * Math.cos(angle), y: c.y + R * Math.sin(angle) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Snap, distancia e vizinhanca
// ---------------------------------------------------------------------------

/**
 * Alinha um token a grid. `sizeInCells` mantem tokens grandes (2x2, 3x3)
 * centrados de forma coerente em vez de presos ao canto de uma celula.
 */
export function snapTokenPosition(
  grid: GridConfig,
  topLeft: Point,
  sizeInCells: number,
): Point {
  if (grid.type === 'none') return topLeft;

  const w = grid.size * sizeInCells;
  const h = cellHeight(grid) * sizeInCells;
  const center = { x: topLeft.x + w / 2, y: topLeft.y + h / 2 };

  if (grid.type === 'square') {
    // Tokens de tamanho par se encaixam nas linhas; impares, no centro da celula.
    const half = sizeInCells % 2 === 0 ? 0 : 0.5;
    const a = Math.round((center.x - grid.offsetX) / grid.size - half) + half;
    const b = Math.round((center.y - grid.offsetY) / grid.size - half) + half;
    const snapped = { x: grid.offsetX + a * grid.size, y: grid.offsetY + b * grid.size };
    return { x: snapped.x - w / 2, y: snapped.y - h / 2 };
  }

  const c = cellCenter(grid, cellAt(grid, center));
  return { x: c.x - w / 2, y: c.y - h / 2 };
}

/** Celula ocupada pelo centro de um token. */
export function tokenCell(grid: GridConfig, topLeft: Point, sizeInCells: number): Cell {
  const w = grid.size * sizeInCells;
  const h = cellHeight(grid) * sizeInCells;
  return cellAt(grid, { x: topLeft.x + w / 2, y: topLeft.y + h / 2 });
}

/** Distancia em celulas. Quadrada usa Chebyshev; hex usa distancia cubica. */
export function cellDistance(grid: GridConfig, from: Cell, to: Cell): number {
  if (isHex(grid)) {
    const dq = from.a - to.a;
    const dr = from.b - to.b;
    return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
  }
  return Math.max(Math.abs(from.a - to.a), Math.abs(from.b - to.b));
}

/** Todas as celulas a no maximo `radius` celulas de distancia. */
export function cellsWithinRadius(grid: GridConfig, center: Cell, radius: number): Cell[] {
  const out: Cell[] = [];
  const r = Math.max(0, Math.floor(radius));

  if (isHex(grid)) {
    for (let dq = -r; dq <= r; dq++) {
      const lo = Math.max(-r, -dq - r);
      const hi = Math.min(r, -dq + r);
      for (let dr = lo; dr <= hi; dr++) {
        out.push({ a: center.a + dq, b: center.b + dr });
      }
    }
    return out;
  }

  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      out.push({ a: center.a + dx, b: center.b + dy });
    }
  }
  return out;
}

/** Distancia entre dois pontos, ja convertida para as unidades do sistema. */
export function measureDistance(grid: GridConfig, from: Point, to: Point): number {
  const cells = cellDistance(grid, cellAt(grid, from), cellAt(grid, to));
  return cells * grid.unitsPerCell;
}

/** Celulas visiveis na area da tela, para nao iterar o mapa inteiro. */
export function cellsInRect(
  grid: GridConfig,
  rect: { x: number; y: number; width: number; height: number },
): Cell[] {
  const out: Cell[] = [];
  if (grid.type === 'square' || grid.type === 'none') {
    const a0 = Math.floor((rect.x - grid.offsetX) / grid.size);
    const b0 = Math.floor((rect.y - grid.offsetY) / grid.size);
    const a1 = Math.ceil((rect.x + rect.width - grid.offsetX) / grid.size);
    const b1 = Math.ceil((rect.y + rect.height - grid.offsetY) / grid.size);
    for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) out.push({ a, b });
    return out;
  }

  // Em hex, varremos o retangulo com um passo seguro e deduplicamos.
  const step = hexRadius(grid);
  const seen = new Set<string>();
  for (let y = rect.y - step; y <= rect.y + rect.height + step; y += step) {
    for (let x = rect.x - step; x <= rect.x + rect.width + step; x += step) {
      const c = cellAt(grid, { x, y });
      const key = cellKey(c);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

export const DEFAULT_GRID: GridConfig = {
  type: 'square',
  size: 70,
  offsetX: 0,
  offsetY: 0,
  color: '#000000',
  opacity: 0.25,
  snap: true,
  unitsPerCell: 1.5,
  unitLabel: 'm',
};
