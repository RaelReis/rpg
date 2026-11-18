import type { Scene, TurnEntry } from '@rpg/shared';

import { emitEffects, emitTokenRemoved, emitTurns, refreshVision, socketsOf } from '../broadcast.js';
import type { Room } from '../room.js';

/**
 * Exclusoes que levam junto o que dependia do objeto apagado.
 *
 * Cada handler apagava so o proprio objeto: remover um jogador deixava a ficha
 * dele virar NPC, o token apontando para um dono que nao existe e a vez na
 * ordem; apagar a ficha deixava o token e a vez; apagar o token deixava a vez.
 * O mestre limpava na mao, em quatro passos, no meio da sessao — e o token com
 * dono fantasma ainda fazia `ensurePartyInTurns` recriar a vez depois.
 *
 * Vive fora de play/sheets/map de proposito: os tres precisam disto, e eles ja
 * se importam entre si.
 */

/**
 * Tira da ordem as vezes que casam com `drop`. Saindo quem estava com a vez,
 * ela passa para a primeira que nao esta pulada. Devolve se algo saiu; quem
 * chama decide quando emitir.
 */
export function dropTurnEntries(room: Room, drop: (entry: TurnEntry) => boolean): boolean {
  const turns = room.state.turns;
  const remaining = turns.entries.filter((e) => !drop(e));
  if (remaining.length === turns.entries.length) return false;

  const goneActive = !remaining.some((e) => e.id === turns.activeEntryId);
  turns.entries = remaining;
  if (goneActive) turns.activeEntryId = remaining.find((e) => !e.skipped)?.id ?? null;
  room.touch('table');
  return true;
}

/** Apaga tokens de uma cena com os efeitos presos a eles e as vezes deles. */
export function removeTokens(room: Room, scene: Scene, ids: Set<string>): void {
  if (ids.size === 0) return;
  scene.tokens = scene.tokens.filter((t) => !ids.has(t.id));

  // Efeitos presos ao token desaparecem junto com ele.
  const orphans = scene.effects.filter((e) => e.anchor === 'token' && e.tokenId !== null && ids.has(e.tokenId));
  if (orphans.length) {
    scene.effects = scene.effects.filter((e) => !orphans.includes(e));
    emitEffects(room, scene, [], orphans.map((e) => e.id));
  }

  room.touchScene(scene.id);
  for (const id of ids) emitTokenRemoved(room, scene, id);
  refreshVision(room, scene);

  if (dropTurnEntries(room, (e) => e.tokenId !== null && ids.has(e.tokenId))) emitTurns(room);
}

/**
 * Apaga a ficha, os tokens dela em todas as cenas e a vez dela na ordem, e
 * solta o jogador que a tinha como personagem.
 */
export function removeSheet(room: Room, sheetId: string): boolean {
  const index = room.state.sheets.findIndex((s) => s.id === sheetId);
  if (index === -1) return false;

  const [removed] = room.state.sheets.splice(index, 1);
  room.removeSheetRecord(removed.id);

  for (const player of room.state.players) {
    if (player.sheetId === removed.id) {
      player.sheetId = null;
      room.touchPlayer(player.id);
    }
  }

  for (const scene of room.state.scenes) {
    removeTokens(room, scene, new Set(scene.tokens.filter((t) => t.sheetId === removed.id).map((t) => t.id)));
  }
  if (dropTurnEntries(room, (e) => e.sheetId === removed.id)) emitTurns(room);

  for (const socket of socketsOf(room)) socket.emit('sheets:patch', { remove: [removed.id] });
  return true;
}
