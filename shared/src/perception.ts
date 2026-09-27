import type { MapEffect, Token } from './types.js';

/**
 * Percepcao individual: alucinacoes.
 *
 * Um token ou efeito com `visibleTo` definido existe apenas para os jogadores
 * da lista (e para o mestre). Para os demais ele nao e escondido na tela: ele
 * nao entra no payload, nem como id.
 *
 * Uma alucinacao nao emite luz, nao enxerga e nao tem dono. Sem essa regra,
 * ela vazaria pela neblina: a tocha de um fantasma que so a Alice ve abriria
 * a sala para o Bruno tambem, e a visao "dele" exploraria o mapa de alguem.
 * O servidor zera esses campos ao gravar, e as funcoes de visao ignoram
 * alucinacoes como fonte — a regra vale mesmo para dados antigos ou mal
 * formados.
 */

type Perceivable = Pick<Token, 'visibleTo'> | Pick<MapEffect, 'visibleTo'>;

/** O objeto tem visibilidade restrita a uma lista de jogadores? */
export function isHallucination(obj: Perceivable): boolean {
  return Array.isArray(obj.visibleTo);
}

/**
 * Este jogador percebe o objeto? Nao considera neblina nem ocultacao — e so a
 * camada de percepcao, aplicada antes das outras. O mestre percebe tudo.
 */
export function perceives(obj: Perceivable, playerId: string | null, gm = false): boolean {
  if (gm) return true;
  if (!Array.isArray(obj.visibleTo)) return true;
  return playerId !== null && obj.visibleTo.includes(playerId);
}

/** Maximo de destinatarios numa lista; uma mesa tem no maximo 50 pessoas. */
const MAX_VISIBLE_TO = 50;

/**
 * Normaliza a lista vinda do cliente: `null` continua `null`; uma lista vira
 * so ids de jogadores conhecidos, sem repeticao. Lista vazia e valida e quer
 * dizer "so o mestre".
 */
export function sanitizeVisibleTo(value: unknown, knownPlayerIds: Iterable<string>): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const known = new Set(knownPlayerIds);
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !known.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_VISIBLE_TO) break;
  }
  return out;
}

/** Aplica ao token as restricoes de alucinacao: sem dono, sem visao, sem luz. */
export function enforceHallucinationRules(token: Token): Token {
  if (!isHallucination(token)) return token;
  token.ownerPlayerId = null;
  token.visionRadius = 0;
  token.lightRadius = 0;
  return token;
}
