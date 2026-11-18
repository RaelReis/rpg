import {
  collectBlockers,
  computeVision,
  partySightCells,
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
  return JSON.stringify([playerId, scene.grid, scene.width, scene.height, scene.globalLight,
    scene.fog, scene.walls, scene.tiles.filter(t => t.blocksVision), scene.tokens]);
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

/**
 * O que o grupo enxerga agora, para o olho do mestre. Mesma regra do servidor
 * (`partySightCells`): antes ela somava toda luz do mapa, e o mestre via como
 * "do grupo" uma sala que nenhum jogador tinha linha de visao para enxergar.
 */
function computePartyVision(scene: Scene): Set<string> {
  return partySightCells(scene);
}
