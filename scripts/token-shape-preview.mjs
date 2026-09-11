/**
 * Previa das duas formas de token, lado a lado sobre a mesma grade.
 *
 * A arte de teste e uma silhueta de personagem gerada aqui — o objetivo e
 * conferir o enquadramento, a marca de chao e a ordem de profundidade, e nao
 * a ilustracao em si. Gera `token-shape-preview.png`.
 */
import sharp from 'sharp';

const CELL = 70;
const W = 760;
const H = 420;

/** Silhueta simples de pessoa: cabeca, tronco, bracos e pernas. */
function figure(color, accent) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 190" width="100" height="190">
    <g fill="${color}" stroke="${accent}" stroke-width="2">
      <circle cx="50" cy="24" r="18"/>
      <path d="M32 44 L68 44 L74 108 L26 108 Z"/>
      <path d="M32 50 L14 96 L24 100 L40 60 Z"/>
      <path d="M68 50 L86 96 L76 100 L60 60 Z"/>
      <path d="M34 108 L30 180 L44 180 L48 120 Z"/>
      <path d="M66 108 L70 180 L56 180 L52 120 Z"/>
    </g>
    <path d="M32 44 L68 44 L66 62 L34 62 Z" fill="${accent}" opacity="0.55"/>
  </svg>`;
}

const grid = [];
for (let x = 0; x <= W; x += CELL) grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
for (let y = 0; y <= H; y += CELL) grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);

/** Marca de chao + rotulo, iguais aos do renderizador. */
function ground(cx, cy, w, color, active) {
  const rx = w * 0.42;
  const ry = rx * 0.32;
  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="rgba(0,0,0,0.4)"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none"
      stroke="${active ? '#d9a441' : color}" stroke-width="${active ? 3.5 : 2}"/>`;
}

const parts = [];

// --- Esquerda: peca redonda -------------------------------------------------
const circleCx = 130;
const circleCy = 200;
parts.push(`<text x="40" y="60" font-family="sans-serif" font-size="14" fill="#e9e4d9">Peça redonda</text>`);
parts.push(`<circle cx="${circleCx}" cy="${circleCy}" r="${CELL * 0.47}" fill="#0d0f14"/>`);
parts.push(`<clipPath id="clipTok"><circle cx="${circleCx}" cy="${circleCy}" r="${CELL * 0.46}"/></clipPath>`);
parts.push(`<g clip-path="url(#clipTok)">
  <rect x="${circleCx - CELL / 2}" y="${circleCy - CELL / 2}" width="${CELL}" height="${CELL}" fill="#4a5a78"/>
  <g transform="translate(${circleCx - 46} ${circleCy - 70}) scale(0.92)">${figure('#8fa3c4', '#c9d6ea')}</g>
</g>`);
parts.push(`<circle cx="${circleCx}" cy="${circleCy}" r="${CELL * 0.46}" fill="none" stroke="#7a8bd4" stroke-width="2"/>`);
parts.push(`<text x="${circleCx}" y="${circleCy + CELL * 0.47 + 18}" text-anchor="middle"
  font-family="sans-serif" font-size="12" fill="#e9e4d9">Agente</text>`);

// --- Direita: arte inteira, tres figuras para mostrar a profundidade --------
parts.push(`<text x="330" y="60" font-family="sans-serif" font-size="14" fill="#e9e4d9">Arte inteira (personagem de pé)</text>`);

const cast = [
  { cx: 400, cy: 160, color: '#6f8f6a', accent: '#cfe3cb', ring: '#5cc98a', name: 'Batedor', active: false },
  { cx: 500, cy: 230, color: '#8b5a5a', accent: '#e9c3c3', ring: '#e05c5c', name: 'Bruto', active: true },
  { cx: 610, cy: 300, color: '#5f5a8b', accent: '#cfc9e9', ring: '#9b7ede', name: 'Ocultista', active: false },
];

// Desenhadas de tras para a frente, como no renderizador.
for (const c of cast) {
  const artW = CELL;
  const artH = artW * 1.9;
  parts.push(ground(c.cx, c.cy, artW, c.ring, c.active));
  // Sombra: a propria silhueta escurecida e deslocada.
  parts.push(`<g opacity="0.32" transform="translate(${c.cx - artW / 2 + artW * 0.04} ${c.cy - artH + artH * 0.02}) scale(${artW / 100} ${artH / 190})">
    ${figure('#000', '#000')}</g>`);
  parts.push(`<g transform="translate(${c.cx - artW / 2} ${c.cy - artH}) scale(${artW / 100} ${artH / 190})">
    ${figure(c.color, c.accent)}</g>`);
  parts.push(`<text x="${c.cx}" y="${c.cy + 26}" text-anchor="middle"
    font-family="sans-serif" font-size="12" fill="#e9e4d9">${c.name}</text>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#2b3244"/>
  <g stroke="rgba(0,0,0,0.28)" stroke-width="1">${grid.join('')}</g>
  ${parts.join('')}
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('token-shape-preview.png');
console.log(`token-shape-preview.png gerado (${W}x${H})`);
