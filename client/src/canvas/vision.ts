import {
  collectBlockers,
  computeVision,
  tokenVisionCells,
  type Role,
  type Scene,
  type VisionResult,
} from '@rpg/shared';

/**
 * Como o cliente descobre o que desenhar sob a neblina.
 *
 * Com `strictVision` ligado o servidor nao manda as paredes (elas revelariam
 * a planta do mapa no inspecionador de rede) e envia no lugar as celulas ja
 * calculadas. Com ele desligado, o cliente recebe as paredes e calcula
 * sozinho — o fog acompanha o arraste sem esperar a volta do servidor, ao
 * custo de confiar no cliente. Os dois caminhos usam o MESMO codigo de visao
 * do pacote compartilhado.
 */

function unrestricted(role: Role): VisionResult {
  return { visible: new Set(), explored: new Set(), unrestricted: true, gm: role === 'GM' };
}

export function resolveVision(scene: Scene | null, role: Role, playerId: string | null): VisionResult {
  if (!scene) return unrestricted(role);
  if (role === 'GM' || scene.fog.mode === 'off') return unrestricted(role);

  // Caminho `strictVision`: o servidor ja resolveu quem ve o que.
  if (scene.fog.computedVisible || scene.fog.computedExplored) {
    return {
      visible: new Set(scene.fog.computedVisible ?? []),
      explored: new Set(scene.fog.computedExplored ?? scene.fog.computedVisible ?? []),
      unrestricted: false,
      gm: false,
    };
  }

  return computeVision(scene, { role, playerId });
}

/**
 * Uniao da visao de todos os tokens de jogador. O mestre usa isto para ver,
 * por cima do proprio mapa, ate onde o grupo enxerga — sem precisar abrir
 * outra janela nem adivinhar.
 */
export function partyVision(scene: Scene): Set<string> {
  const out = new Set<string>();
  if (scene.fog.mode === 'off') return out;

  const blockers = collectBlockers(scene);
  for (const token of scene.tokens) {
    if (token.layer !== 3) continue;
    const isEye = token.ownerPlayerId !== null && token.visionRadius > 0;
    const isLight = token.lightRadius > 0 && !token.gmOnly;
    if (!isEye && !isLight) continue;

    const radius = Math.max(isEye ? token.visionRadius : 0, token.lightRadius);
    for (const cell of tokenVisionCells(scene, token, radius, blockers)) out.add(cell);
  }

  for (const cell of scene.fog.revealed) out.add(cell);
  for (const cell of scene.fog.hidden) out.delete(cell);
  return out;
}
