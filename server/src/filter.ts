import {
  canPlayerSeeEffect,
  canPlayerSeeToken,
  computeVision,
  inVisibleTo,
  filterSheetForRole,
  filterTemplateForRole,
  type Asset,
  type ChatMessage,
  type Handout,
  type InitiativeState,
  type MapEffect,
  type Player,
  type Role,
  type Scene,
  type Sheet,
  type TableState,
  type Token,
  type VisionResult,
} from '@rpg/shared';

import type { Room } from './room.js';

/**
 * Reducao do estado da mesa ao que cada participante tem direito de ver.
 *
 * A regra e nao mandar e depois esconder na interface: se o jogador nao
 * deveria saber de algo, aquilo nao entra no payload. Vale para tokens na
 * neblina, camadas exclusivas do mestre, campos de ficha secretos, cenas
 * ainda nao usadas e ate para a lista de imagens (o mapa da proxima sessao
 * apareceria ali).
 */

export interface Viewer {
  playerId: string;
  role: Role;
}

export function visionFor(scene: Scene, viewer: Viewer): VisionResult {
  return computeVision(scene, { role: viewer.role, playerId: viewer.playerId });
}

/** Ids dos tokens que este observador enxerga na cena. */
export function visibleTokenIds(scene: Scene, viewer: Viewer, vision?: VisionResult): Set<string> {
  const v = vision ?? visionFor(scene, viewer);
  const out = new Set<string>();
  for (const token of scene.tokens) {
    if (canPlayerSeeToken(scene, token, v, viewer.playerId)) out.add(token.id);
  }
  return out;
}

/**
 * Como o token sai para o jogador.
 *
 * `dim` vira semitransparencia. Uma alucinacao chega como um token comum: a
 * lista ficaria no payload de quem a enxerga e contaria que ela e alucinacao —
 * e quem mais a ve. Luz e visao saem zeradas pelo mesmo motivo, e para que o
 * calculo local de visao (sem `strictVision`) de o mesmo resultado que o do
 * servidor, que ignora as duas.
 */
function presentToken(token: Token): Token {
  let out = token;
  if (token.visibility === 'dim') out = { ...out, opacity: Math.min(token.opacity, 0.45) };
  if (token.visibleTo) out = { ...out, visibleTo: null, lightRadius: 0, visionRadius: 0 };
  return out;
}

/** Efeito como sai para o jogador: sem a lista de quem o ve. */
export function presentEffect(effect: MapEffect): MapEffect {
  return effect.visibleTo ? { ...effect, visibleTo: null } : effect;
}

export function sceneForViewer(room: Room, scene: Scene, viewer: Viewer): Scene {
  if (viewer.role === 'GM') return scene;

  const strict = room.state.settings.strictVision;
  const vision = visionFor(scene, viewer);

  const tokens = scene.tokens
    .filter((t) => canPlayerSeeToken(scene, t, vision, viewer.playerId))
    .map(presentToken);

  const tiles = scene.tiles.filter((t) => !t.gmOnly);
  const effects = scene.effects
    .filter((e) => canPlayerSeeEffect(scene, e, viewer.playerId))
    .map(presentEffect);

  // Com strictVision as paredes ficam no servidor: elas descrevem a planta do
  // mapa e apareceriam inteiras no inspecionador de rede do navegador. O que
  // o jogador recebe sao portas visiveis (para poder interagir) e o resultado
  // ja calculado da visao.
  const walls = strict
    ? scene.walls.filter((w) => (w.door || w.window) && !w.hidden)
    : scene.walls.filter((w) => !w.hidden);

  // Com strictVision, as listas cruas de neblina (onde o mestre pintou, o que
  // o grupo ja explorou) nao saem do servidor; vao apenas as celulas
  // calculadas para ESTE jogador. Com a neblina desligada nao existem celulas
  // calculadas, e mandar listas vazias seria pedir para o cliente interpretar
  // "vazio" como "nao ve nada" — a cena inteira ficaria preta.
  const fog = !strict
    ? scene.fog
    : scene.fog.mode === 'off'
      ? { ...scene.fog, explored: [], revealed: [], hidden: [] }
      : {
          ...scene.fog,
          explored: [],
          revealed: [],
          hidden: [],
          computedVisible: [...vision.visible],
          computedExplored: [...vision.explored],
        };

  // A cartela de abertura da cena e surpresa: sai do payload ate aparecer.
  // Gatilhos e o registro deles nunca saem: a area ja entregaria onde o mapa
  // guarda uma surpresa.
  return { ...scene, tokens, tiles, effects, walls, fog, introCardId: null, triggers: [], triggerLog: [] };
}

/**
 * Fichas de NPC nao vao inteiras para o jogador, mas as barras configuradas
 * pelo mestre precisam de valor. Devolvemos uma ficha reduzida so com os
 * campos que aquele token expoe.
 */
function barOnlySheet(sheet: Sheet, tokens: Token[]): Sheet | null {
  const fieldIds = new Set<string>();
  for (const token of tokens) {
    if (token.sheetId !== sheet.id) continue;
    for (const bar of token.bars) fieldIds.add(bar.fieldId);
  }
  if (fieldIds.size === 0) return null;

  const values: Sheet['values'] = {};
  for (const id of fieldIds) {
    if (sheet.values[id] !== undefined) values[id] = sheet.values[id];
  }
  return { ...sheet, values, portraitAssetId: null };
}

/**
 * Uma ficha isolada, na versao que este observador pode receber — ou null se
 * ele nao deve nem saber que ela existe. Usado nas atualizacoes incrementais
 * de ficha, para nao reenviar o estado inteiro a cada tecla digitada.
 */
export function sheetForViewer(room: Room, sheet: Sheet, viewer: Viewer): Sheet | null {
  if (viewer.role === 'GM') return sheet;

  const template = room.state.sheetTemplate;
  if (sheet.ownerPlayerId === viewer.playerId || sheet.sharedWithParty) {
    return filterSheetForRole(template, sheet, viewer.role);
  }

  if (!room.state.settings.showPartyBars) return null;

  const scene = room.activeScene();
  if (!scene) return null;

  const vision = visionFor(scene, viewer);
  const visible = scene.tokens.filter((t) => canPlayerSeeToken(scene, t, vision, viewer.playerId));
  return barOnlySheet(sheet, visible);
}

function sheetsForViewer(room: Room, viewer: Viewer, visibleTokens: Token[]): Sheet[] {
  const template = room.state.sheetTemplate;
  if (viewer.role === 'GM') return room.state.sheets;

  const out: Sheet[] = [];
  const included = new Set<string>();

  for (const sheet of room.state.sheets) {
    const isOwn = sheet.ownerPlayerId === viewer.playerId;
    if (isOwn || sheet.sharedWithParty) {
      out.push(filterSheetForRole(template, sheet, viewer.role));
      included.add(sheet.id);
    }
  }

  if (room.state.settings.showPartyBars) {
    for (const sheet of room.state.sheets) {
      if (included.has(sheet.id)) continue;
      const reduced = barOnlySheet(sheet, visibleTokens);
      if (reduced) out.push(reduced);
    }
  }

  return out;
}

/**
 * Imagens que uma cena usa. Recebe a cena JA filtrada para o observador: um
 * token oculto que ficou de fora nao pode trazer a propria arte junto.
 */
export function assetIdsOfScene(scene: Scene): (string | null)[] {
  return [
    scene.backgroundAssetId,
    ...scene.tokens.map((t) => t.assetId),
    ...scene.tiles.map((t) => t.assetId),
    ...scene.effects.map((e) => e.assetId),
  ];
}

/** Imagens que uma ficha usa: o retrato e os itens de inventario. */
export function assetIdsOfSheet(sheet: Sheet): (string | null)[] {
  const ids: (string | null)[] = [sheet.portraitAssetId];
  for (const value of Object.values(sheet.values)) {
    if (Array.isArray(value)) for (const item of value) ids.push(item.assetId);
  }
  return ids;
}

/**
 * Jogadores com o retrato da ficha principal, para a lista de presenca.
 *
 * O retrato e derivado na hora do envio: gravado no jogador, ficaria velho a
 * cada troca de imagem na ficha.
 */
export function playersWithPortraits(room: Room): Player[] {
  return room.state.players.map((p) => ({
    ...p,
    portraitAssetId: room.sheet(p.sheetId)?.portraitAssetId ?? null,
  }));
}

/** Somente os assets referenciados pelo que este observador recebeu. */
function assetsForViewer(
  room: Room,
  viewer: Viewer,
  scene: Scene | null,
  sheets: Sheet[],
  players: Player[],
): Asset[] {
  if (viewer.role === 'GM') return room.state.assets;

  const ids = new Set<string | null | undefined>();
  // Retratos da lista de presenca no cabecalho.
  for (const player of players) ids.add(player.portraitAssetId);
  if (scene) for (const id of assetIdsOfScene(scene)) ids.add(id);
  for (const sheet of sheets) for (const id of assetIdsOfSheet(sheet)) ids.add(id);
  for (const handout of room.state.handouts) {
    if (handoutForViewer(handout, viewer)) ids.add(handout.assetId);
  }
  // A imagem da cartela no ar; as preparadas nao entregam a arte.
  ids.add(room.live.forViewer(viewer).presentation?.assetId);

  return room.state.assets.filter((a) => ids.has(a.id));
}

/**
 * O material so existe para quem recebeu acesso. Um handout em preparacao
 * nao pode aparecer na lista do jogador — nem o titulo, que ja entrega a
 * surpresa.
 */
export function handoutForViewer(handout: Handout, viewer: Viewer): Handout | null {
  if (viewer.role === 'GM') return handout;
  if (handout.sharedWithAll) return handout;
  return handout.sharedWith.includes(viewer.playerId) ? handout : null;
}

/**
 * Ordem de iniciativa sem o que o jogador nao pode saber: entradas marcadas
 * pelo mestre e as que apontam para uma alucinacao destinada a outra pessoa —
 * a entrada carrega o nome e o id do token.
 */
export function initiativeForViewer(room: Room, viewer: Viewer): InitiativeState {
  const initiative = room.state.initiative;
  if (viewer.role === 'GM') return initiative;

  const restricted = new Map<string, Token>();
  for (const scene of room.state.scenes) {
    for (const token of scene.tokens) if (token.visibleTo) restricted.set(token.id, token);
  }

  const entries = initiative.entries.filter((e) => {
    if (e.hiddenFromPlayers) return false;
    const token = e.tokenId ? restricted.get(e.tokenId) : undefined;
    return !token || inVisibleTo(token, viewer.role, viewer.playerId);
  });

  // A vez de uma entrada que ficou de fora nao pode apontar para ela.
  const activeEntryId = entries.some((e) => e.id === initiative.activeEntryId)
    ? initiative.activeEntryId
    : null;

  return { ...initiative, entries, activeEntryId };
}

function chatForViewer(chat: ChatMessage[], viewer: Viewer): ChatMessage[] {
  if (viewer.role === 'GM') return chat;
  return chat.filter((m) => !m.whisper || m.playerId === viewer.playerId);
}

/**
 * Estado completo para um observador. O jogador recebe apenas a cena ativa:
 * as demais sao material de preparacao do mestre.
 */
export function stateForViewer(room: Room, viewer: Viewer): TableState {
  const s = room.state;

  if (viewer.role === 'GM') {
    return {
      ...s,
      players: playersWithPortraits(room),
      sheetTemplate: s.sheetTemplate,
      live: room.live.forViewer(viewer),
    };
  }

  const active = room.activeScene();
  const scene = active ? sceneForViewer(room, active, viewer) : null;
  const sheets = sheetsForViewer(room, viewer, scene?.tokens ?? []);

  const players = playersWithPortraits(room);

  return {
    ...s,
    players,
    scenes: scene ? [scene] : [],
    sheets,
    handouts: s.handouts
      .map((h) => handoutForViewer(h, viewer))
      .filter((h): h is Handout => h !== null),
    assets: assetsForViewer(room, viewer, scene, sheets, players),
    sheetTemplate: filterTemplateForRole(s.sheetTemplate, viewer.role),
    initiative: initiativeForViewer(room, viewer),
    chat: chatForViewer(s.chat, viewer),
    // Cartelas preparadas sao material do mestre; o jogador so ve a que esta
    // no ar, por `live`.
    sceneCards: [],
    live: room.live.forViewer(viewer),
  };
}

/** Token individual ja adaptado ao observador, ou null se ele nao o ve. */
export function tokenForViewer(
  room: Room,
  scene: Scene,
  token: Token,
  viewer: Viewer,
  vision?: VisionResult,
): Token | null {
  if (viewer.role === 'GM') return token;
  const v = vision ?? visionFor(scene, viewer);
  if (!canPlayerSeeToken(scene, token, v, viewer.playerId)) return null;
  return presentToken(token);
}
