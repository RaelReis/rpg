import {
  canPlayerSeeToken,
  computeVision,
  concealedFromPlayers,
  filterSheetForRole,
  boardForViewer,
  filterTemplateForRole,
  isEffectSeen,
  isTileSeen,
  perceives,
  reduceScreenEffect,
  type ActiveScreenEffect,
  type Asset,
  type ChatMessage,
  type Handout,
  type MapEffect,
  type Player,
  type PresentedCard,
  type Role,
  type Scene,
  type Sheet,
  type SheetTemplate,
  type Tile,
  type TableState,
  type Token,
  type TurnEntry,
  type TurnState,
  type VisionResult,
  type Wall,
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
/** A parede como o jogador a recebe: a tranca so aparece quando ele tenta abrir. */
export function wallForPlayer(wall: Wall): Wall {
  return wall.locked ? { ...wall, locked: false } : wall;
}

export function visibleTokenIds(scene: Scene, viewer: Viewer, vision?: VisionResult): Set<string> {
  const v = vision ?? visionFor(scene, viewer);
  const out = new Set<string>();
  for (const token of scene.tokens) {
    if (canPlayerSeeToken(scene, token, v, viewer.playerId)) out.add(token.id);
  }
  return out;
}

/** Aplica a semitransparencia de `dim` no que sai para o jogador. */
function presentToken(room: Room, token: Token): Token {
  const publicFields = new Set(room.state.sheetTemplate.fields.filter(f => !f.gmOnly).map(f => f.id));
  return { ...token, bars: token.bars.filter(b => publicFields.has(b.fieldId)),
    opacity: token.visibility === 'dim' ? Math.min(token.opacity, 0.45) : token.opacity };
}

export function sceneForViewer(room: Room, scene: Scene, viewer: Viewer): Scene {
  if (viewer.role === 'GM') return scene;

  const strict = room.state.settings.strictVision;
  const vision = visionFor(scene, viewer);

  const tokens = scene.tokens
    .filter((t) => canPlayerSeeToken(scene, t, vision, viewer.playerId))
    .map(t => presentToken(room, t));

  const tiles = scene.tiles.filter((t) => tileShownTo(room, scene, t, viewer, vision));
  const effects = scene.effects.filter((e) => effectShownTo(room, scene, e, viewer, vision));

  // Com strictVision as paredes ficam no servidor: elas descrevem a planta do
  // mapa e apareceriam inteiras no inspecionador de rede do navegador. O que
  // o jogador recebe sao portas visiveis (para poder interagir) e o resultado
  // ja calculado da visao.
  const walls = (
    strict ? scene.walls.filter((w) => (w.door || w.window) && !w.hidden) : scene.walls.filter((w) => !w.hidden)
  ).map(wallForPlayer);

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

  // A cartela de abertura e preparacao do mestre: nem o id sai daqui.
  // Gatilhos e cartela de abertura sao preparacao do mestre: nem o id sai.
  return { ...scene, tokens, tiles, effects, walls, fog, introCardId: null, triggers: [] };
}

/**
 * O tile chega a este observador? Exclusivo do mestre nunca. Com a visao
 * estrita, tambem nao o que esta fora do que o jogador viu: o bau da sala que
 * ninguem explorou chegava com posicao e arte, e o tile que bloqueia a visao
 * entregava a planta que as paredes escondem (ver `isTileSeen`).
 */
export function tileShownTo(room: Room, scene: Scene, tile: Tile, viewer: Viewer, vision?: VisionResult): boolean {
  if (viewer.role === 'GM') return true;
  if (tile.gmOnly) return false;
  if (!room.state.settings.strictVision) return true;
  return isTileSeen(scene, vision ?? visionFor(scene, viewer), tile);
}

/**
 * O efeito chega a este observador, considerando tambem a neblina quando a
 * visao estrita esta ligada? Mesma regra do renderizador (`isEffectSeen`).
 */
export function effectShownTo(
  room: Room,
  scene: Scene,
  effect: MapEffect,
  viewer: Viewer,
  vision?: VisionResult,
): boolean {
  if (!effectVisibleTo(effect, viewer)) return false;
  if (viewer.role === 'GM' || !room.state.settings.strictVision) return true;
  return isEffectSeen(scene, vision ?? visionFor(scene, viewer), effect);
}

/**
 * O efeito chega a este observador? Oculto e alucinacao de outra pessoa ficam
 * de fora do payload.
 */
export function effectVisibleTo(effect: MapEffect, viewer: Viewer): boolean {
  if (viewer.role === 'GM') return true;
  if (effect.visibility === 'hidden') return false;
  return perceives(effect, viewer.playerId);
}

/**
 * Fichas de NPC nao vao inteiras para o jogador, mas as barras configuradas
 * pelo mestre precisam de valor. Devolvemos uma ficha reduzida so com os
 * campos que aquele token expoe.
 */
function barOnlySheet(room: Room, sheet: Sheet, tokens: Token[]): Sheet | null {
  const publicFields = new Set(room.state.sheetTemplate.fields.filter(f => !f.gmOnly && f.type === 'resource').map(f => f.id));
  const fieldIds = new Set<string>();

  /*
   * PV e PD de outro personagem de JOGADOR vao sempre, com ou sem o token dele
   * a vista: sao os retratos do grupo, e o colega sumia do canto da tela a cada
   * vez que saia da linha de visao. NPC continua dependendo do token visivel —
   * o PV do monstro atras da parede nao e assunto do grupo.
   */
  if (room.player(sheet.ownerPlayerId)?.role === 'PLAYER') {
    for (const field of room.state.sheetTemplate.fields) {
      if (field.vital && publicFields.has(field.id)) fieldIds.add(field.id);
    }
  }
  for (const token of tokens) {
    if (token.sheetId !== sheet.id) continue;
    for (const bar of token.bars) if (publicFields.has(bar.fieldId)) fieldIds.add(bar.fieldId);
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

  // Sem cena ativa ainda ha os retratos do grupo (ver `barOnlySheet`).
  const scene = room.activeScene();
  const vision = scene ? visionFor(scene, viewer) : null;
  const visible = scene && vision ? scene.tokens.filter((t) => canPlayerSeeToken(scene, t, vision, viewer.playerId)) : [];
  return barOnlySheet(room, sheet, visible);
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
      const reduced = barOnlySheet(room, sheet, visibleTokens);
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
export function assetIdsOfSheet(sheet: Sheet, template: SheetTemplate): (string | null)[] {
  const ids: (string | null)[] = [sheet.portraitAssetId, sheet.bodyAssetId];
  for (const value of Object.values(sheet.values)) {
    if (Array.isArray(value)) for (const item of value) ids.push(item.assetId);
  }
  for (const field of template.fields) {
    const value = sheet.values[field.id];
    if (field.type === 'image' && typeof value === 'string') ids.push(value);
  }
  return ids;
}

/**
 * Jogadores com o retrato da ficha principal, para a lista de presenca.
 *
 * O retrato e derivado na hora do envio: gravado no jogador, ficaria velho a
 * cada troca de imagem na ficha.
 */
export function playersWithPortraits(room: Room, viewer?: Viewer): Player[] {
  return room.state.players.map((p) => {
    const out: Player = { ...p, portraitAssetId: room.sheet(p.sheetId)?.portraitAssetId ?? null };
    // Preferencia de acessibilidade e assunto de cada um: so a propria pessoa
    // recebe o valor.
    if (!viewer || viewer.playerId !== p.id) delete out.reduceEffects;
    return out;
  });
}

/** O jogador pediu para reduzir efeitos de tela? */
export function prefersReducedEffects(room: Room, playerId: string): boolean {
  return room.player(playerId)?.reduceEffects === true;
}

/** Esta pessoa esta entre os destinatarios (`null` = todos os jogadores)? */
export function isRecipient(recipients: string[] | null, playerId: string): boolean {
  return recipients === null || recipients.includes(playerId);
}

/**
 * Efeitos fixos ativos para o observador. O mestre ve a lista inteira, com os
 * destinatarios, para poder remover; o jogador recebe so os que o atingem, ja
 * na versao reduzida se ele pediu, e sem saber quem mais os recebe.
 */
export function screenEffectsForViewer(room: Room, viewer: Viewer): ActiveScreenEffect[] {
  if (viewer.role === 'GM') return room.state.screenEffects;
  const reduce = prefersReducedEffects(room, viewer.playerId);
  const out: ActiveScreenEffect[] = [];
  for (const active of room.state.screenEffects) {
    if (!isRecipient(active.recipients, viewer.playerId)) continue;
    const { recipients: _omit, ...effect } = active;
    void _omit;
    const shown = reduce ? reduceScreenEffect(effect) : effect;
    if (shown) out.push({ ...shown, recipients: null });
  }
  return out;
}

/**
 * A cartela na tela, na versao do observador — ou null se ele nao e
 * destinatario. Quem reconecta no meio ve so o tempo que falta.
 */
export function presentedCardForViewer(room: Room, viewer: Viewer): PresentedCard | null {
  const card = room.state.presentedCard;
  if (!card) return null;
  const remaining =
    card.durationMs === null ? null : Math.max(0, card.durationMs - (Date.now() - room.presentationStartedAt));
  if (remaining === 0) return null;
  if (viewer.role === 'GM') return { ...card, durationMs: remaining };
  if (!isRecipient(card.recipients, viewer.playerId)) return null;
  return { ...card, durationMs: remaining, recipients: null };
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
  for (const sheet of sheets) for (const id of assetIdsOfSheet(sheet, room.state.sheetTemplate)) ids.add(id);
  for (const handout of room.state.handouts) {
    if (handoutForViewer(handout, viewer)) ids.add(handout.assetId);
  }
  ids.add(presentedCardForViewer(room, viewer)?.assetId);
  // Imagens pregadas no quadro de pistas sao do grupo: todos as recebem.
  for (const item of room.state.board.items) ids.add(item.assetId);

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
 * A ordem de turnos como este observador tem direito de ve-la.
 *
 * Saem tres coisas: as miniaturas que o mestre escondeu, as de tokens ocultos
 * ou exclusivos do mestre, e as de alucinacoes que este jogador nao percebe —
 * todas trariam o id e o nome do token, e a ordem de turno entregaria o
 * monstro que a mesa ainda nao encontrou. O historico e a vez atual acompanham
 * o mesmo corte: um registro do monstro escondido entregaria que ele existe e
 * em que rodada agiu.
 *
 * A ocultacao do token e lida aqui, na hora do envio, e nao copiada para a
 * vez quando ela entra na ordem. Copiada, dependia de o cliente mandar a flag:
 * a ficha arrastada para a faixa nao mandava, e o NPC oculto aparecia para
 * todos. Lida daqui, revelar o token tambem revela a vez dele.
 */
export function turnsForViewer(room: Room, viewer: Viewer): TurnState {
  const turns = room.state.turns;
  if (viewer.role === 'GM') return turns;

  const unseenTokens = new Set<string>();
  // Por ficha: tem token a mostra em alguma cena? E tem algum escondido?
  const sheetShown = new Set<string>();
  const sheetConcealed = new Set<string>();
  for (const scene of room.state.scenes) {
    for (const token of scene.tokens) {
      const unseen = !perceives(token, viewer.playerId) || concealedFromPlayers(token);
      if (unseen) unseenTokens.add(token.id);
      if (token.sheetId) (unseen ? sheetConcealed : sheetShown).add(token.sheetId);
    }
  }

  // Vez sem token (a ficha entrou na ordem numa cena onde o NPC nao esta):
  // vale o que os tokens da ficha dizem. Sem isto, o NPC oculto em outra cena
  // aparecia na faixa com o nome.
  const concealedBySheet = (e: TurnEntry) =>
    e.tokenId === null && e.sheetId !== null && sheetConcealed.has(e.sheetId) && !sheetShown.has(e.sheetId);

  const hidden = new Set(
    turns.entries
      .filter(
        (e) => e.hiddenFromPlayers || (e.tokenId !== null && unseenTokens.has(e.tokenId)) || concealedBySheet(e),
      )
      .map((e) => e.id),
  );
  if (hidden.size === 0) return turns;

  return {
    ...turns,
    entries: turns.entries.filter((e) => !hidden.has(e.id)),
    history: turns.history.filter((r) => !hidden.has(r.entryId)),
    activeEntryId:
      turns.activeEntryId && hidden.has(turns.activeEntryId) ? null : turns.activeEntryId,
  };
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
      players: playersWithPortraits(room, viewer),
      sheetTemplate: s.sheetTemplate,
      presentedCard: presentedCardForViewer(room, viewer),
    };
  }

  const active = room.activeScene();
  const scene = active ? sceneForViewer(room, active, viewer) : null;
  const sheets = sheetsForViewer(room, viewer, scene?.tokens ?? []);

  const players = playersWithPortraits(room, viewer);

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
    turns: turnsForViewer(room, viewer),
    chat: chatForViewer(s.chat, viewer),
    // Cartelas em preparacao nunca saem: nem titulo, nem imagem, nem id.
    sceneCards: [],
    triggerLog: [],
    board: boardForViewer(s.board, (handoutId) => {
      const handout = s.handouts.find((h) => h.id === handoutId);
      return !!handout && handoutForViewer(handout, viewer) !== null;
    }),
    screenEffects: screenEffectsForViewer(room, viewer),
    presentedCard: presentedCardForViewer(room, viewer),
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
  return presentToken(room, token);
}
