import { emitSheet } from './sheets.js';
import {
  CHARACTER_VISION_RADIUS,
  cellKey,
  createToken,
  snapTokenPosition,
  tokenBarFields,
  tokenCell,
  type Ack,
  type Scene,
  type Sheet,
  type Token,
} from '@rpg/shared';

import {
  emitPlayers,
  emitTokenUpsert,
  emitTurns,
  refreshVision,
  socketsOf,
  syncAssets,
} from '../broadcast.js';
import { assetIdsOfSheet, sheetForViewer } from '../filter.js';
import { LIMITS } from '../limits.js';
import type { Room } from '../room.js';
import { fail, ok, ownedAsset, type Ctx } from './context.js';
import { ensurePartyInTurns } from './play.js';

/**
 * Personagem no mapa.
 *
 * Toda ficha nova ganha o proprio token na cena ativa. Antes o mestre criava
 * a ficha, depois o token, depois ligava um ao outro e escolhia o dono — e o
 * jogador que entrava na mesa ficava sem peca ate alguem lembrar disso.
 */

/** Quantas celulas procurar em volta do centro antes de desistir. */
const SEARCH_RADIUS = 12;

/**
 * Primeira celula livre em espiral a partir do centro da cena.
 *
 * Sem isto, varios jogadores entrando em sequencia empilhariam os tokens no
 * mesmo ponto, e um esconderia o outro.
 */
function freeSpot(scene: Scene, scale: number): { x: number; y: number } {
  const grid = scene.grid;
  const occupied = new Set(scene.tokens.map((t) => cellKey(tokenCell(grid, { x: t.x, y: t.y }, t.scale))));
  const center = { x: scene.width / 2 - grid.size / 2, y: scene.height / 2 - grid.size / 2 };

  for (let ring = 0; ring <= SEARCH_RADIUS; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // so a borda do anel
        const candidate = snapTokenPosition(
          grid,
          { x: center.x + dx * grid.size, y: center.y + dy * grid.size },
          scale,
        );
        const key = cellKey(tokenCell(grid, candidate, scale));
        if (!occupied.has(key)) return candidate;
      }
    }
  }
  return snapTokenPosition(grid, center, scale);
}

/**
 * Cria o token de uma ficha recem-criada, se houver cena ativa e espaco.
 *
 * Devolve null sem erro quando nao da: uma ficha sem token continua util, e
 * falhar a criacao da ficha por causa do mapa seria punir a coisa errada.
 */
export function spawnCharacterToken(room: Room, sheet: Sheet): Token | null {
  const scene = room.activeScene();
  if (!scene) return null;
  if (scene.tokens.length >= LIMITS.tokens) return null;

  const owner = room.player(sheet.ownerPlayerId);
  const spot = freeSpot(scene, 1);

  const token = createToken({
    name: sheet.name,
    // A peca no mapa usa o corpo inteiro; o retrato so entra enquanto o corpo
    // nao existe, para o token nao nascer sem arte nenhuma. A forma vem do
    // padrao, que ja e arte inteira.
    assetId: sheet.bodyAssetId ?? sheet.portraitAssetId,
    color: owner?.color ?? '#7a8bd4',
    x: spot.x,
    y: spot.y,
    layer: 3,
    ownerPlayerId: sheet.ownerPlayerId,
    sheetId: sheet.id,
    visionRadius: CHARACTER_VISION_RADIUS,
    // As barras que o modelo marca para aparecer no token ja vem ligadas.
    bars: tokenBarFields(room.state.sheetTemplate)
      .slice(0, 4)
      .map((field) => ({ fieldId: field.id, color: field.color })),
  });

  scene.tokens.push(token);
  room.touchScene(scene.id);
  emitTokenUpsert(room, scene, token);
  refreshVision(room, scene);

  // O personagem de um jogador ja nasce na ordem de turnos: as rodadas estao
  // sempre correndo, e quem esta na mesa tem vez.
  if (sheet.ownerPlayerId && ensurePartyInTurns(room)) emitTurns(room);

  return token;
}

/** A arte do token do personagem passa a ser a imagem de corpo da ficha. */
export function applyCharacterArt(room: Room, sheet: Sheet): void {
  if (!sheet.bodyAssetId) return;

  for (const scene of room.state.scenes) {
    let changed = false;
    for (const token of scene.tokens) {
      if (token.sheetId !== sheet.id) continue;
      token.assetId = sheet.bodyAssetId;
      token.shape = 'art';
      changed = true;
      if (scene.id === room.state.activeSceneId) emitTokenUpsert(room, scene, token);
    }
    if (changed) room.touchScene(scene.id);
  }
}

/**
 * As duas imagens do personagem, enviadas pelo proprio jogador.
 *
 * E o jogador quem manda, e nao o mestre, porque isto acontece na entrada da
 * mesa: a ficha so fica utilizavel com um rosto para o grupo e um corpo para o
 * mapa. O evento troca as duas de uma vez para nao existir o estado pela
 * metade, com retrato e sem peca.
 */
export function setCharacterImages(
  ctx: Ctx,
  payload: { portraitAssetId: string; bodyAssetId: string },
  ack: Ack<null>,
): void {
  const sheet =
    ctx.room.sheet(ctx.room.player(ctx.viewer.playerId)?.sheetId) ??
    ctx.room.state.sheets.find((s) => s.ownerPlayerId === ctx.viewer.playerId) ??
    null;
  if (!sheet) return fail(ack, 'Voce nao tem uma ficha nesta mesa.');

  const portrait = ownedAsset(ctx, payload?.portraitAssetId);
  const body = ownedAsset(ctx, payload?.bodyAssetId);
  if (!portrait || !body) return fail(ack, 'Envie as duas imagens do personagem.');

  sheet.portraitAssetId = portrait;
  sheet.bodyAssetId = body;
  sheet.updatedAt = Date.now();
  ctx.room.touchSheet(sheet.id);

  applyCharacterArt(ctx.room, sheet);

  emitSheet(ctx.room, sheet);
  // A lista de presenca e os retratos do grupo vem do retrato da ficha.
  emitPlayers(ctx.room);
  ok(ack, null);
}

/**
 * O token acompanha o dono da ficha.
 *
 * Quando o mestre passa uma ficha para outro jogador, o personagem no mapa
 * precisa mudar de mao junto — senao o novo dono nao o enxerga pela neblina
 * nem consegue move-lo.
 */
export function syncCharacterOwner(room: Room, sheet: Sheet): void {
  for (const scene of room.state.scenes) {
    let changed = false;
    for (const token of scene.tokens) {
      if (token.sheetId !== sheet.id || token.ownerPlayerId === sheet.ownerPlayerId) continue;
      token.ownerPlayerId = sheet.ownerPlayerId;
      const owner = room.player(sheet.ownerPlayerId);
      if (owner) token.color = owner.color;
      changed = true;
      if (scene.id === room.state.activeSceneId) emitTokenUpsert(room, scene, token);
    }
    if (!changed) continue;
    room.touchScene(scene.id);
    if (scene.id === room.state.activeSceneId) refreshVision(room, scene);
  }
}
