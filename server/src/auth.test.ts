import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './auth.js';

/**
 * Senha de mestre.
 *
 * A regressao que motivou estes testes: "mesa sem senha" devolvia `true` para
 * qualquer texto. O unico chamador compensava com uma checagem de contexto,
 * mas bastava o proximo esquece-la para qualquer um virar mestre. O limite de
 * tamanho e o hash assincrono ficam cobertos em `audit.test.ts`.
 */
describe('verifyPassword', () => {
  it('sem senha gravada, nenhuma senha e correta', async () => {
    expect(await verifyPassword('qualquer coisa', null)).toBe(false);
    expect(await verifyPassword('', null)).toBe(false);
  });

  it('aceita a senha certa', async () => {
    expect(await verifyPassword('segredo', await hashPassword('segredo'))).toBe(true);
  });

  it('recusa a senha errada', async () => {
    expect(await verifyPassword('outra', await hashPassword('segredo'))).toBe(false);
  });

  it('recusa hash em formato desconhecido', async () => {
    expect(await verifyPassword('segredo', 'md5:abc:def')).toBe(false);
  });

  it('cada hash tem sal proprio', async () => {
    expect(await hashPassword('segredo')).not.toBe(await hashPassword('segredo'));
  });
});
