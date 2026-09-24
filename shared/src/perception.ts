import type { MapEffect, Role, Scene, Token } from './types.js';

/**
 * Percepcao individual: objetos que so alguns jogadores enxergam.
 *
 * Uma alucinacao e um token ou efeito com `visibleTo` preenchido. Quem nao
 * esta na lista nao recebe o objeto — nem o id —, e o servidor decide isso
 * com as mesmas funcoes que a previa "ver pelos olhos" usa no cliente.
 *
 * Uma alucinacao nao emite luz nem visao e nao tem dono. Sem essa regra a
 * neblina de quem NAO a ve denunciaria a existencia dela: uma tocha que so
 * Alice enxerga iluminaria a sala para Bruno tambem, e ele veria o chao
 * clarear sem nada ali.
 */

/** `null` e o comportamento normal; uma lista restringe a quem esta nela. */
export type VisibleTo = string[] | null;

export function isRestricted(obj: { visibleTo?: VisibleTo }): boolean {
  return Array.isArray(obj.visibleTo);
}

/**
 * O participante esta na lista de quem ve o objeto?
 *
 * Nao considera neblina, camadas nem `gmOnly`: e so o recorte da alucinacao,
 * aplicado junto com as outras regras de visibilidade.
 */
export function inVisibleTo(obj: { visibleTo?: VisibleTo }, role: Role, playerId: string | null): boolean {
  if (role === 'GM') return true;
  if (!Array.isArray(obj.visibleTo)) return true;
  return playerId !== null && obj.visibleTo.includes(playerId);
}

/**
 * O token serve de olhos ou de fonte de luz?
 *
 * Alucinacoes nunca servem, mesmo que tenham raio configurado — o raio fica
 * guardado para quando o mestre tornar o token real de novo.
 */
export function emitsVision(token: Token): boolean {
  return !isRestricted(token);
}

/**
 * Um efeito de mapa chega a este jogador?
 *
 * Alem da propria lista, um efeito preso a um token herda a restricao dele:
 * o efeito carrega o `tokenId` da ancora, e mandar a aura de uma alucinacao a
 * quem nao a ve entregaria o id do token escondido.
 */
export function canPlayerSeeEffect(scene: Scene, effect: MapEffect, playerId: string | null): boolean {
  if (effect.gmOnly || effect.visibility === 'hidden') return false;
  if (!inVisibleTo(effect, 'PLAYER', playerId)) return false;
  if (effect.anchor === 'token' && effect.tokenId) {
    const anchor = scene.tokens.find((t) => t.id === effect.tokenId);
    if (anchor && !inVisibleTo(anchor, 'PLAYER', playerId)) return false;
  }
  return true;
}

/**
 * Normaliza a lista vinda de fora: so ids de jogadores conhecidos, sem
 * repeticao. Qualquer coisa que nao seja lista vira `null` (sem restricao).
 */
export function sanitizeVisibleTo(raw: unknown, knownPlayerIds: Iterable<string>): VisibleTo {
  if (!Array.isArray(raw)) return null;
  const known = new Set(knownPlayerIds);
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id === 'string' && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
