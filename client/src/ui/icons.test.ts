import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONDITION_PRESETS } from '@rpg/shared';
import { describe, expect, it } from 'vitest';

import { CONDITION_ICONS, ICONS, iconDataUrl } from './icons';

/**
 * Guarda do padrao de icones.
 *
 * O padrao so vale enquanto ninguem volta a colar um emoji num botao. Estes
 * testes falham nesse caso, apontando arquivo e linha, e conferem que todo
 * nome do registro existe de fato no Lucide.
 */

const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Faixas Unicode que so aparecem no codigo como icone improvisado: setas,
 * simbolos tecnicos, formas geometricas, dingbats, braille e emoji. Texto de
 * interface (acentos, travessao, reticencias) fica de fora.
 */
const GLYPH_ICON = new RegExp(
  [
    '[\\u2190-\\u21FF]', // setas
    '[\\u2300-\\u23FF]', // tecnicos (⏸, ⌘...)
    '[\\u25A0-\\u25FF]', // formas geometricas (▤, ▾, ◎...)
    '[\\u2600-\\u27BF]', // simbolos e dingbats (☀, ✕, ✎, ⚔...)
    '[\\u2800-\\u28FF]', // braille (⠿)
    '[\\u2900-\\u297F]', // setas suplementares (⤢)
    '[\\u2B00-\\u2BFF]', // simbolos e setas diversos (⬚, ⬇)
    '[\\u2039\\u203A\\u2212]', // ‹ › −
    '\\p{Extended_Pictographic}', // emoji
  ].join('|'),
  'u',
);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('padrao de icones', () => {
  it('nenhum emoji ou caractere Unicode faz papel de icone no cliente', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(CLIENT_SRC)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.trim();
        // Comentario pode citar o simbolo antigo para explicar a troca.
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        const match = code.match(GLYPH_ICON);
        if (match) offenders.push(`${path.relative(CLIENT_SRC, file)}:${i + 1} "${match[0]}"`);
      });
    }
    expect(offenders, `use <Icon name="..."> de ui/icons.tsx:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('todo nome do registro aponta para um desenho valido do Lucide', () => {
    const tags = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
    for (const [name, node] of Object.entries(ICONS)) {
      expect(node.length, name).toBeGreaterThan(0);
      for (const [tag] of node) expect(tags.has(tag), `${name}: <${tag}>`).toBe(true);
    }
  });

  it('toda condicao do jogo tem icone e cor', () => {
    for (const condition of CONDITION_PRESETS) {
      const look = CONDITION_ICONS[condition.id];
      expect(look, condition.id).toBeDefined();
      expect(ICONS[look.icon]).toBeDefined();
      expect(look.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('o icone para canvas e um SVG valido, estavel por icone e cor', () => {
    const url = iconDataUrl('dead', '#e5675e');
    expect(url).toBe(iconDataUrl('dead', '#e5675e'));
    expect(url).not.toBe(iconDataUrl('dead', '#ffffff'));

    const svg = decodeURIComponent(url.replace('data:image/svg+xml;charset=utf-8,', ''));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('stroke="#e5675e"');
    expect(svg).toMatch(/<(path|circle)\b/);
  });
});
