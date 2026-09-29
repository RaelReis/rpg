import { describe, expect, it } from 'vitest';

import { fitWithin, MAX_SIDE, needsShrink } from './shrink';

describe('reducao antes do envio', () => {
  it('encaixa o lado maior no maximo, mantendo a proporcao', () => {
    expect(fitWithin(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(1200, 9000, 2048)).toEqual({ width: 273, height: 2048 });
  });

  it('nao amplia imagem pequena', () => {
    expect(fitWithin(300, 200, 1024)).toEqual({ width: 300, height: 200 });
  });

  it('foto de celular acima de 5 MB passa pela reducao; retrato leve sobe intacto', () => {
    expect(needsShrink(4000, 3000, 8 * 1024 * 1024, 'portrait')).toBe(true);
    expect(needsShrink(800, 800, 300 * 1024, 'portrait')).toBe(false);
  });

  it('lado acima do maximo reduz mesmo com o arquivo leve', () => {
    expect(needsShrink(MAX_SIDE.token + 1, 100, 1024, 'token')).toBe(true);
  });
});
