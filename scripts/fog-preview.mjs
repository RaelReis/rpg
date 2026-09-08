/**
 * Previa da borda da neblina.
 *
 * Reproduz fora do navegador o mesmo algoritmo de `client/src/canvas/render.ts`
 * (bolhas de raio igual a meia-diagonal da celula + um desfoque unico sobre a
 * mascara) para comparar o recorte duro com o de nuvem sem precisar abrir a
 * aplicacao. Gera `fog-preview.png` na raiz.
 */
import sharp from 'sharp';

const CELL = 64;
const COLS = 13;
const ROWS = 9;
const W = CELL * COLS;
const H = CELL * ROWS;

// Mesmo ruido por celula usado no renderizador.
function cellNoise(a, b) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Visao a partir de um ponto, cortada por uma parede vertical com uma porta.
 * Usa distancia euclidiana entre centros, igual ao `tokenVisionCells` real.
 */
function revealedCells() {
  const origin = { a: 4, b: 4 };
  const radius = 4.6;
  const out = [];
  for (let a = 0; a < COLS; a++) {
    for (let b = 0; b < ROWS; b++) {
      if (Math.hypot(a - origin.a, b - origin.b) > radius) continue;
      // "Parede" em a=8, com abertura em b=4..5.
      if (a > 8 && !(b >= 4 && b <= 5)) continue;
      out.push({ a, b });
    }
  }
  return out;
}

const cells = revealedCells();

function terrainSvg() {
  const tiles = [];
  for (let a = 0; a < COLS; a++) {
    for (let b = 0; b < ROWS; b++) {
      const shade = 60 + Math.round(cellNoise(a * 7, b * 13) * 55);
      tiles.push(
        `<rect x="${a * CELL}" y="${b * CELL}" width="${CELL}" height="${CELL}" fill="rgb(${shade},${shade - 12},${shade - 26})"/>`,
      );
    }
  }
  const grid = [];
  for (let a = 0; a <= COLS; a++) grid.push(`<line x1="${a * CELL}" y1="0" x2="${a * CELL}" y2="${H}"/>`);
  for (let b = 0; b <= ROWS; b++) grid.push(`<line x1="0" y1="${b * CELL}" x2="${W}" y2="${b * CELL}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${tiles.join('')}
    <g stroke="rgba(0,0,0,0.28)" stroke-width="1">${grid.join('')}</g>
  </svg>`;
}

/** Mascara dura: o poligono exato de cada celula. */
function sharpMaskSvg() {
  const rects = cells
    .map((c) => `<rect x="${c.a * CELL}" y="${c.b * CELL}" width="${CELL}" height="${CELL}" fill="#fff"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`;
}

/** Mascara de nuvem: bolhas de raio ligeiramente irregular. */
function cloudMaskSvg(softness) {
  const base = CELL * Math.SQRT1_2;
  const circles = cells
    .map((c) => {
      const r = base * (1 + softness * (0.04 + cellNoise(c.a, c.b) * 0.18));
      return `<circle cx="${c.a * CELL + CELL / 2}" cy="${c.b * CELL + CELL / 2}" r="${r.toFixed(1)}" fill="#fff"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${circles}</svg>`;
}

async function compose(maskSvg, blurPx) {
  let mask = sharp(Buffer.from(maskSvg)).png();
  if (blurPx > 0) mask = mask.blur(blurPx);
  const maskBuf = await mask.toBuffer();

  // Camada de neblina com os buracos recortados pela mascara.
  const fog = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 5, g: 6, b: 10, alpha: 1 } },
  })
    .composite([{ input: maskBuf, blend: 'dest-out' }])
    .png()
    .toBuffer();

  return sharp(Buffer.from(terrainSvg()))
    .composite([{ input: fog, blend: 'over' }])
    .png()
    .toBuffer();
}

const LABEL_H = 34;
function labelSvg(text, width) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_H}">
    <rect width="${width}" height="${LABEL_H}" fill="#12141a"/>
    <text x="12" y="22" font-family="sans-serif" font-size="14" fill="#d9a441">${text}</text>
  </svg>`;
}

const panels = [
  { title: 'edgeSoftness = 0  (recorte por celula)', buf: await compose(sharpMaskSvg(), 0) },
  { title: 'edgeSoftness = 0.6  (padrao, nuvem)', buf: await compose(cloudMaskSvg(0.6), CELL * 0.34 * 0.6) },
  { title: 'edgeSoftness = 1.0  (maximo)', buf: await compose(cloudMaskSvg(1), CELL * 0.34 * 1) },
];

const GAP = 10;
const totalH = panels.length * (H + LABEL_H + GAP);

const layers = [];
let y = 0;
for (const panel of panels) {
  layers.push({ input: Buffer.from(labelSvg(panel.title, W)), top: y, left: 0 });
  layers.push({ input: panel.buf, top: y + LABEL_H, left: 0 });
  y += H + LABEL_H + GAP;
}

await sharp({
  create: { width: W, height: totalH, channels: 4, background: { r: 12, g: 20, b: 26, alpha: 1 } },
})
  .composite(layers)
  .png()
  .toFile('fog-preview.png');

console.log(`fog-preview.png gerado (${W}x${totalH}) — ${cells.length} celulas reveladas`);
