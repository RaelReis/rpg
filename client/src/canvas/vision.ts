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

/**
 * Ultimo resultado, reaproveitado enquanto a entrada nao muda.
 *
 * O laco de desenho chama isto a cada quadro, e sem cache cada quadro
 * reconstruiria conjuntos com centenas de chaves — trabalho jogado fora 60
 * vezes por segundo. As listas vindas do servidor sao substituidas (e nao
 * mutadas) quando a visao muda, entao a propria identidade do array serve de
 * teste: se e o mesmo array, o resultado tambem e.
 */
let cached: {
  sceneId: string;
  playerId: string | null;
  visibleRef: readonly string[] | undefined;
  exploredRef: readonly string[] | undefined;
  localKey: string | null;
  result: VisionResult;
} | null = null;

/** Assinatura do caminho local: o que faria a visao mudar sem vir do servidor. */
function localVisionKey(scene: Scene, playerId: string | null): string {
  let key = `${scene.fog.mode}|${scene.globalLight}|${scene.fog.revealed.length}`;
  key += `|${scene.fog.hidden.length}|${scene.fog.explored.length}|${scene.walls.length}`;
  for (const wall of scene.walls) if (wall.door) key += `|d${wall.id}:${wall.open ? 1 : 0}`;
  for (const tile of scene.tiles) if (tile.blocksVision) key += `|t${tile.id}:${tile.x},${tile.y}`;
  for (const token of scene.tokens) {
    if (token.visionRadius <= 0 && token.lightRadius <= 0) continue;
    key += `|${token.id}:${Math.round(token.x)},${Math.round(token.y)}`;
  }
  return `${playerId ?? ''}|${key}`;
}

export function resolveVision(scene: Scene | null, role: Role, playerId: string | null): VisionResult {
  if (!scene) return unrestricted(role);
  if (role === 'GM' || scene.fog.mode === 'off') return unrestricted(role);

  // Caminho `strictVision`: o servidor ja resolveu quem ve o que.
  if (scene.fog.computedVisible || scene.fog.computedExplored) {
    if (
      cached &&
      cached.sceneId === scene.id &&
      cached.playerId === playerId &&
      cached.visibleRef === scene.fog.computedVisible &&
      cached.exploredRef === scene.fog.computedExplored
    ) {
      return cached.result;
    }

    const result: VisionResult = {
      visible: new Set(scene.fog.computedVisible ?? []),
      explored: new Set(scene.fog.computedExplored ?? scene.fog.computedVisible ?? []),
      unrestricted: false,
      gm: false,
    };
    cached = {
      sceneId: scene.id,
      playerId,
      visibleRef: scene.fog.computedVisible,
      exploredRef: scene.fog.computedExplored,
      localKey: null,
      result,
    };
    return result;
  }

  // Caminho local: o calculo de linha de visao e caro, e repeti-lo a cada
  // quadro com a mesma entrada seria o desperdicio mais caro do laco.
  const localKey = localVisionKey(scene, playerId);
  if (cached && cached.sceneId === scene.id && cached.localKey === localKey) {
    return cached.result;
  }

  const result = computeVision(scene, { role, playerId });
  cached = {
    sceneId: scene.id,
    playerId,
    visibleRef: undefined,
    exploredRef: undefined,
    localKey,
    result,
  };
  return result;
}

/**
 * Uniao da visao de todos os tokens de jogador. O mestre usa isto para ver,
 * por cima do proprio mapa, ate onde o grupo enxerga — sem precisar abrir
 * outra janela nem adivinhar.
 */
let partyCache: { sceneId: string; key: string; result: Set<string> } | null = null;

export function partyVision(scene: Scene): Set<string> {
  // Mesma razao do cache acima: isto varre celulas e testa paredes, e o
  // painel do mestre o chamaria a cada quadro enquanto o olho estiver ligado.
  const key = localVisionKey(scene, null);
  if (partyCache && partyCache.sceneId === scene.id && partyCache.key === key) {
    return partyCache.result;
  }

  const result = computePartyVision(scene);
  partyCache = { sceneId: scene.id, key, result };
  return result;
}

function computePartyVision(scene: Scene): Set<string> {
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
