import crypto from 'node:crypto';

/**
 * Autenticacao por sessao de mesa: nao ha cadastro de usuario.
 *
 * - O jogador entra com codigo da mesa + nome e recebe um token opaco, que o
 *   navegador guarda. Esse token e a identidade dele: e o que permite voltar
 *   para o mesmo personagem depois de uma queda de conexao.
 * - O papel de mestre e protegido por uma senha opcional definida na criacao
 *   da mesa; sem ela, quem tem o link de mestre assume o controle.
 *
 * Guardamos apenas o hash do token, para que um vazamento do banco nao
 * permita se passar por um jogador.
 */

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return true; // mesa sem senha de mestre
  const [scheme, saltHex, keyHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Comparacao de codigo de mesa: sem diferenciar maiusculas nem hifens. */
export function normalizeTableCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
