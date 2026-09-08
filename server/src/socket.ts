import type { Ack } from '@rpg/shared';

import { bindIo, type TypedServer, type TypedSocket } from './broadcast.js';
import { contextOf, fail, isGm, type Ctx } from './handlers/context.js';
import {
  createEffectHandler,
  createTileHandler,
  createTokenHandler,
  createWallHandler,
  deleteEffect,
  deleteTile,
  deleteToken,
  deleteWall,
  moveToken,
  paintFog,
  resetFog,
  updateEffect,
  updateTile,
  updateToken,
  updateWall,
} from './handlers/map.js';
import {
  addInitiativeEntry,
  deleteAsset,
  kickPlayer,
  moveCursor,
  nextTurn,
  pingMap,
  previousTurn,
  promotePlayer,
  removeInitiativeEntry,
  rollInitiative,
  sendChat,
  updateInitiative,
  updatePlayer,
} from './handlers/play.js';
import {
  activateScene,
  createSceneHandler,
  deleteScene,
  renameTable,
  updateScene,
  updateSettings,
} from './handlers/scene.js';
import { handleDisconnect, handleJoin, handleResume } from './handlers/session.js';
import {
  assignSheet,
  createSheet,
  deleteSheet,
  updateSheet,
  updateTemplate,
} from './handlers/sheets.js';

/**
 * Registro dos eventos.
 *
 * As checagens de papel ficam concentradas nos wrappers `gm` e `member`: o
 * cliente esconde os controles que o jogador nao pode usar, mas quem decide
 * de fato e este arquivo.
 */

/** Teto de eventos por janela, para uma aba com defeito nao inundar a mesa. */
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 220;

export function registerSocketHandlers(io: TypedServer): void {
  bindIo(io);

  io.on('connection', (socket: TypedSocket) => {
    let windowStart = Date.now();
    let eventCount = 0;

    socket.use(([, ...rest], next) => {
      const now = Date.now();
      if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
        windowStart = now;
        eventCount = 0;
      }
      if (++eventCount > RATE_LIMIT_MAX_EVENTS) {
        return next(new Error('Excesso de eventos. Aguarde um instante.'));
      }
      void rest;
      next();
    });

    socket.on('error', (err) => {
      console.warn(`[socket ${socket.id}]`, err.message);
    });

    /** Handler que exige apenas uma sessao valida. */
    const member =
      <P, R>(fn: (ctx: Ctx, payload: P, ack: Ack<R>) => void) =>
      (payload: P, ack: Ack<R>) => {
        const ctx = contextOf(socket);
        if (!ctx) return fail(ack, 'Sessao nao encontrada. Recarregue a pagina.');
        fn(ctx, payload, ack);
      };

    /** Handler restrito ao mestre. */
    const gm =
      <P, R>(fn: (ctx: Ctx, payload: P, ack: Ack<R>) => void) =>
      (payload: P, ack: Ack<R>) => {
        const ctx = contextOf(socket);
        if (!ctx) return fail(ack, 'Sessao nao encontrada. Recarregue a pagina.');
        if (!isGm(ctx)) return fail(ack, 'Apenas o mestre pode fazer isso.');
        fn(ctx, payload, ack);
      };

    /** Evento sem resposta (fire-and-forget), como cursor e ping. */
    const loose =
      <P>(fn: (ctx: Ctx, payload: P) => void) =>
      (payload: P) => {
        const ctx = contextOf(socket);
        if (ctx) fn(ctx, payload);
      };

    // -- sessao ------------------------------------------------------------
    socket.on('session:join', (req, ack) => void handleJoin(socket, req, ack));
    socket.on('session:resume', (req, ack) => void handleResume(socket, req, ack));
    socket.on('disconnect', () => handleDisconnect(socket));

    // -- mesa e cenas ------------------------------------------------------
    socket.on('settings:update', gm(updateSettings));
    socket.on('table:rename', gm(renameTable));
    socket.on('scene:create', gm(createSceneHandler));
    socket.on('scene:update', gm(updateScene));
    socket.on('scene:delete', gm(deleteScene));
    socket.on('scene:activate', gm(activateScene));

    // -- mapa --------------------------------------------------------------
    socket.on('token:create', gm(createTokenHandler));
    socket.on('token:update', member(updateToken));
    socket.on('token:move', (payload, ack) => {
      const ctx = contextOf(socket);
      if (!ctx) return fail(ack, 'Sessao nao encontrada.');
      moveToken(ctx, payload, ack);
    });
    socket.on('token:delete', gm(deleteToken));

    socket.on('tile:create', gm(createTileHandler));
    socket.on('tile:update', gm(updateTile));
    socket.on('tile:delete', gm(deleteTile));

    // Efeitos aceitam jogador quando o mestre libera anotacoes; a checagem
    // fica dentro do handler, que conhece a configuracao da mesa.
    socket.on('effect:create', member(createEffectHandler));
    socket.on('effect:update', member(updateEffect));
    socket.on('effect:delete', member(deleteEffect));

    socket.on('wall:create', gm(createWallHandler));
    socket.on('wall:update', member(updateWall)); // jogador so abre/fecha portas
    socket.on('wall:delete', gm(deleteWall));

    socket.on('fog:paint', (payload, ack) => {
      const ctx = contextOf(socket);
      if (!ctx) return fail(ack, 'Sessao nao encontrada.');
      if (!isGm(ctx)) return fail(ack, 'Apenas o mestre controla a neblina.');
      paintFog(ctx, payload, ack);
    });
    socket.on('fog:reset', gm(resetFog));

    // -- fichas ------------------------------------------------------------
    socket.on('template:update', gm(updateTemplate));
    socket.on('sheet:create', gm((ctx, payload, ack) => void createSheet(ctx, payload, ack)));
    socket.on('sheet:update', member(updateSheet));
    socket.on('sheet:delete', gm(deleteSheet));
    socket.on('sheet:assign', gm(assignSheet));

    // -- iniciativa --------------------------------------------------------
    socket.on('initiative:update', gm(updateInitiative));
    socket.on('initiative:add', gm(addInitiativeEntry));
    socket.on('initiative:remove', gm(removeInitiativeEntry));
    socket.on('initiative:roll', (ack) => {
      const ctx = contextOf(socket);
      if (!ctx) return fail(ack, 'Sessao nao encontrada.');
      if (!isGm(ctx)) return fail(ack, 'Apenas o mestre rola a iniciativa.');
      rollInitiative(ctx, ack);
    });
    socket.on('initiative:next', (ack) => {
      const ctx = contextOf(socket);
      if (!ctx) return fail(ack, 'Sessao nao encontrada.');
      nextTurn(ctx, ack);
    });
    socket.on('initiative:previous', (ack) => {
      const ctx = contextOf(socket);
      if (!ctx) return fail(ack, 'Sessao nao encontrada.');
      if (!isGm(ctx)) return fail(ack, 'Apenas o mestre volta o turno.');
      previousTurn(ctx, ack);
    });

    // -- social ------------------------------------------------------------
    socket.on('chat:send', member(sendChat));
    socket.on('player:update', member(updatePlayer));
    socket.on('player:kick', gm((ctx, payload, ack) => void kickPlayer(ctx, payload, ack)));
    socket.on('player:promote', gm((ctx, payload, ack) => void promotePlayer(ctx, payload, ack)));
    socket.on('asset:delete', gm((ctx, payload, ack) => void deleteAsset(ctx, payload, ack)));

    socket.on('map:ping', loose(pingMap));
    socket.on('cursor:move', loose(moveCursor));
  });
}
