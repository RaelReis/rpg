import { describe, expect, it } from 'vitest';

import { renameRef, slugOf, uniqueId } from './templateIds';

describe('ids de campo legiveis', () => {
  it('derivam do nome, sem acento nem espaco, so com o que a formula aceita', () => {
    expect(slugOf('Destreza')).toBe('destreza');
    expect(slugOf('Pontos de Vida')).toBe('pontos_de_vida');
    expect(slugOf('Ação por turno!')).toBe('acao_por_turno');
    expect(slugOf('  ')).toBe('campo');
  });

  it('nao repetem um id em uso', () => {
    expect(uniqueId('forca', new Set(['forca', 'forca_2']))).toBe('forca_3');
    expect(uniqueId('mente', new Set(['forca']))).toBe('mente');
  });

  it('renomear leva as referencias, sem pegar ids que so comecam igual', () => {
    expect(renameRef('1d20+@destreza+@destreza_bonus', 'destreza', 'agilidade')).toBe(
      '1d20+@agilidade+@destreza_bonus',
    );
    expect(renameRef('1d@novo-campo', 'novo-campo', 'luta')).toBe('1d@luta');
  });
});
