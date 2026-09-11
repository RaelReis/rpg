/**
 * Previa dos estilos de efeito.
 *
 * Reproduz em SVG o mesmo desenho de `paintStyledArea`, para conferir a
 * aparencia dos Elementos do Outro Lado sem abrir a aplicacao. Gera
 * `effects-preview.png` na raiz.
 */
import sharp from 'sharp';

const CELL = 300;
const R = 108;

function noise(i, salt) {
  let h = Math.imul(i + 1, 2246822519) + Math.imul(salt + 1, 3266489917);
  h = Math.imul(h ^ (h >>> 15), 668265263);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const rgba = (hex, a) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

/** t fixo: a previa e um instante da animacao. */
const T = 1.6;

function body(style, color, alt, cx, cy, id) {
  const defs = [];
  const out = [];

  if (style === 'glow' || style === 'pulse') {
    const beat = style === 'pulse' ? 0.82 + Math.sin(T * 2.1) * 0.18 : 1;
    defs.push(`<radialGradient id="g${id}"><stop offset="0" stop-color="${rgba(alt, 0.55)}"/>
      <stop offset="0.45" stop-color="${rgba(color, 0.75)}"/>
      <stop offset="1" stop-color="${rgba(color, 0)}"/></radialGradient>`);
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R * beat}" fill="url(#g${id})"/>`);
  }

  if (style === 'runes') {
    defs.push(`<radialGradient id="h${id}"><stop offset="0" stop-color="${rgba(alt, 0.35)}"/>
      <stop offset="0.7" stop-color="${rgba(color, 0.4)}"/>
      <stop offset="1" stop-color="${rgba(color, 0.1)}"/></radialGradient>`);
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#h${id})"/>`);
    for (const ring of [0.58, 0.86]) {
      const spin = T * (ring === 0.58 ? 0.35 : -0.22);
      const rr = R * ring;
      out.push(`<circle cx="${cx}" cy="${cy}" r="${rr}" fill="none" stroke="${rgba(alt, 0.65)}" stroke-width="1.5"/>`);
      const glyphs = ring === 0.58 ? 8 : 12;
      for (let i = 0; i < glyphs; i++) {
        const a = spin + (i / glyphs) * Math.PI * 2;
        const gx = cx + Math.cos(a) * rr;
        const gy = cy + Math.sin(a) * rr;
        const size = R * 0.07;
        const v = noise(i, ring === 0.58 ? 1 : 2);
        const deg = ((a + Math.PI / 2) * 180) / Math.PI;
        const shape = Math.floor(noise(i, 33) * 3);
        let d;
        if (shape === 0) {
          d = `M ${-size} ${-size * (0.4 + v)} L ${size * (v - 0.5)} ${size} L ${size} ${-size * v}`;
        } else if (shape === 1) {
          d = `M 0 ${-size} L 0 ${size} M ${-size * 0.7} ${-size * (v - 0.2)} L ${size * 0.7} ${-size * (v - 0.2)}`;
        } else {
          d = `M ${size * 0.75} 0 A ${size * 0.75} ${size * 0.75} 0 1 1 ${size * 0.75 * Math.cos(Math.PI * 1.4)} ${size * 0.75 * Math.sin(Math.PI * 1.4)} M 0 ${-size} L 0 ${size * (v - 0.2)}`;
        }
        out.push(`<g transform="translate(${gx} ${gy}) rotate(${deg})">
          <path d="${d}" fill="none" stroke="${rgba(alt, 0.9)}" stroke-width="2"/></g>`);
      }
    }
  }

  if (style === 'vortex') {
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="${rgba(color, 0.2)}"/>`);
    for (let a = 0; a < 5; a++) {
      const pts = [];
      for (let s = 0; s <= 26; s++) {
        const p = s / 26;
        const angle = T * 1.6 + (a / 5) * Math.PI * 2 + p * 4.2;
        pts.push(`${cx + Math.cos(angle) * R * p},${cy + Math.sin(angle) * R * p}`);
      }
      out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${rgba(a % 2 === 0 ? alt : color, 0.75)}"
        stroke-width="${3.5 - a * 0.35}" stroke-linecap="round"/>`);
    }
  }

  if (style === 'mist') {
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="${rgba(color, 0.5)}"/>`);
    for (let i = 0; i < 14; i++) {
      const drift = T * (0.14 + noise(i, 5) * 0.2);
      const ang = noise(i, 6) * Math.PI * 2 + drift;
      const dist = R * (0.1 + noise(i, 7) * 0.75);
      const px = cx + Math.cos(ang) * dist;
      const py = cy + Math.sin(ang) * dist * 0.7;
      const rr = R * (0.35 + noise(i, 8) * 0.5);
      defs.push(`<radialGradient id="m${id}_${i}">
        <stop offset="0" stop-color="${rgba(i % 3 === 0 ? alt : color, 0.85)}"/>
        <stop offset="0.6" stop-color="${rgba(color, 0.35)}"/>
        <stop offset="1" stop-color="${rgba(color, 0)}"/></radialGradient>`);
      out.push(`<circle cx="${px}" cy="${py}" r="${rr}" fill="url(#m${id}_${i})"/>`);
    }
  }

  if (style === 'embers') {
    defs.push(`<linearGradient id="b${id}" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${rgba(color, 0.95)}"/>
      <stop offset="0.55" stop-color="${rgba(color, 0.45)}"/>
      <stop offset="1" stop-color="${rgba(color, 0.12)}"/></linearGradient>`);
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#b${id})"/>`);
    for (let i = 0; i < 64; i++) {
      const lane = noise(i, 9);
      const phase = noise(i, 10);
      const climb = (T * (0.22 + phase * 0.35) + phase) % 1;
      const px = cx + (lane * 2 - 1) * R * 0.94 + Math.sin(T * 1.4 + i) * R * 0.06;
      const py = cy + R * 0.98 - climb * R * 2;
      const rr = Math.max(1, R * 0.05 * (0.45 + phase));
      const tone = climb > 0.5 ? color : alt;
      out.push(`<circle cx="${px}" cy="${py}" r="${rr}" fill="${tone}"
        opacity="${Math.min(1, (1 - climb) * 1.5).toFixed(2)}"/>`);
    }
  }

  if (style === 'static') {
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="${rgba(color, 0.55)}"/>`);
    const step = Math.max(2, R / 34);
    const frame = Math.floor(T * 12);
    for (let i = 0; i < 620; i++) {
      const n1 = noise(i, frame % 97);
      const n2 = noise(i, (frame % 97) + 40);
      out.push(`<rect x="${cx - R + n1 * R * 2}" y="${cy - R + n2 * R * 2}"
        width="${step * (0.5 + n1 * 1.6)}" height="${step * 0.7}" fill="${rgba(alt, 0.55)}"/>`);
    }
    for (let b = 0; b < 5; b++) {
      const band = ((T * 0.35 + b * 0.27) % 1.4) - 0.2;
      out.push(`<rect x="${cx - R}" y="${cy - R + band * R * 2}" width="${R * 2}"
        height="${R * (0.03 + noise(b, 61) * 0.05)}" fill="${rgba(alt, 0.22)}"/>`);
    }
  }

  return { defs: defs.join(''), out: out.join('') };
}

const CARDS = [
  { style: 'embers', color: '#a4161a', alt: '#ff4d4d', title: 'Sangue — brasas', op: 0.5 },
  { style: 'mist', color: '#79808a', alt: '#eef1f4', title: 'Morte — névoa', op: 0.6 },
  { style: 'runes', color: '#d9a441', alt: '#fff1c9', title: 'Conhecimento — runas', op: 0.6 },
  { style: 'vortex', color: '#7b2ff7', alt: '#22e0ff', title: 'Energia — vórtice', op: 0.55 },
  { style: 'static', color: '#101018', alt: '#8f8fa8', title: 'Medo — chiado', op: 0.45 },
  { style: 'pulse', color: '#6ea8d8', alt: '#dff1ff', title: 'Pulsante (genérico)', op: 0.5 },
];

const COLS = 3;
const rows = Math.ceil(CARDS.length / COLS);
const W = COLS * CELL;
const H = rows * CELL;

const defs = [];
const shapes = [];

CARDS.forEach((card, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const cx = col * CELL + CELL / 2;
  const cy = row * CELL + CELL / 2 + 8;

  // Xadrez por baixo: mostra quanto de cada efeito deixa o mapa transparecer.
  for (let a = 0; a < 6; a++) {
    for (let b = 0; b < 6; b++) {
      const shade = (a + b) % 2 === 0 ? '#2a2f3a' : '#232833';
      shapes.push(`<rect x="${col * CELL + a * 50}" y="${row * CELL + b * 50}" width="50" height="50" fill="${shade}"/>`);
    }
  }

  const { defs: d, out } = body(card.style, card.color, card.alt, cx, cy, i);
  defs.push(d);
  shapes.push(`<g opacity="${card.op}">${out}</g>`);
  shapes.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${rgba(card.alt, 0.8)}" stroke-width="1.5"/>`);
  shapes.push(`<text x="${col * CELL + 12}" y="${row * CELL + 22}" font-family="sans-serif"
    font-size="13" fill="#e9e4d9">${card.title}</text>`);
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>${defs.join('')}</defs>
  <rect width="${W}" height="${H}" fill="#12141a"/>
  ${shapes.join('')}
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('effects-preview.png');
console.log(`effects-preview.png gerado (${W}x${H})`);
