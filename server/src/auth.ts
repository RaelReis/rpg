import { MAX_GM_PASSWORD_LENGTH } from '@rpg/shared';
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

export async function hashPassword(password: string): Promise<string> {
  if (password.length > MAX_GM_PASSWORD_LENGTH) throw new Error('Senha deve ter no maximo 200 caracteres.');
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(password, salt);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

/**
 * Sem hash gravado NAO existe senha correta.
 *
 * Devolver `true` para "mesa sem senha" fazia desta funcao uma armadilha:
 * bastava um chamador esquecer a checagem de contexto para qualquer texto
 * digitado virar o papel de mestre. O unico chamador hoje ja recusa antes de
 * chegar aqui; o padrao seguro elimina a chance de o proximo nao recusar.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored || password.length > MAX_GM_PASSWORD_LENGTH) return false;
  const [scheme, saltHex, keyHex] = stored.split(':');
  if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(saltHex ?? '') || !/^[a-f0-9]{64}$/i.test(keyHex ?? '')) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = await deriveKey(password, Buffer.from(saltHex, 'hex'));
  return crypto.timingSafeEqual(expected, actual);
}

/** Comparacao de codigo de mesa: sem diferenciar maiusculas nem hifens. */
export function normalizeTableCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

let activeHashes = 0;
/** Bounded CPU work, without blocking the event loop or accumulating a queue. */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= 4) return Promise.reject(new Error('Muitas entradas simultaneas. Tente novamente em instantes.'));
  activeHashes++;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => {
      activeHashes--;
      if (err) reject(err); else resolve(key);
    });
  });
}
