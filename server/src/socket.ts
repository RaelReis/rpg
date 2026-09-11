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
  createHandout,
  deleteHandout,
  presentHandout,
  updateHandout,
} from './handlers/handouts.js';
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
  rollSheetField,
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

type Listener = (...args: unknown[]) => unknown;

/**
 * Nenhum evento, por mais malformado, derruba o processo.
 *
 * O servidor e um processo so, com todas as mesas em memoria: uma excecao que
 * escapa de um handler encerra o Node e leva a sessao de todo mundo junto. E
 * bastava pouco — `session:resume` com um token numerico chegava a
 * `crypto.update(12345)`, lancava dentro de uma funcao assincrona, e um
 * visitante anonimo, sem sessao nenhuma, derrubava a aplicacao.
 *
 * Validar cada campo de cada payload continua sendo o certo, e os handlers de
 * entrada fazem isso. Esta guarda e a rede embaixo: envolve TODO listener
 * registrado no socket, inclusive os que ainda nao existem, e transforma a
 * falha em resposta de erro para quem perguntou. Por isso os handlers devolvem
 * a promessa em vez de descarta-la com `void` — sem ela, a rejeicao escaparia
 * da guarda.
 */
function guardListeners(socket: TypedSocket): void {
  const register = socket.on.bind(socket) as unknown as (event: string, listener: Listener) => TypedSocket;

  const report = (event: string, args: unknown[], err: unknown): void => {
    console.error(`[socket ${socket.id}] falha em "${event}":`, err);
    const ack = args[args.length - 1];
    if (typeof ack !== 'function') return;
    try {
      ack({ ok: false, error: 'O servidor nao conseguiu processar o pedido.' });
    } catch {
      // O handler ja havia respondido antes de falhar.
    }
  };

  (socket as unknown as { on: (event: string, listener: Listener) => TypedSocket }).on = (
    event,
    listener,
  ) =>
    register(event, (...args: unknown[]) => {
      try {
        const result = listener(...args);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          (result as Promise<unknown>).catch((err) => report(event, args, err));
        }
      } catch (err) {
        report(event, args, err);
      }
    });
}

/** Teto de eventos por janela, para uma aba com defeito nao inundar a mesa. */
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 220;

export function registerSocketHandlers(io: TypedServer): void {
  bindIo(io);

  io.on('connection', (socket: TypedSocket) => {
    // Antes de qualquer registro: o que for registrado sem guarda fica sem ela.
    guardListeners(socket);

    let windowStart = Date.now();
    let eventCount = 0;

    socket.use(([, ...rest], next) => {
      const now = Date.now();
      if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
        windowStart = now;
        eventCount = 0;
      }

      if (++eventCount > RATE_LIMIT_MAX_EVENTS) {
        // Recusar sem responder deixa o cliente esperando um ack que nunca
        // vem: a promessa fica pendente para sempre e o botao trava em
        // "Salvando...". Quem pergunta merece um nao — o ultimo argumento do
        // evento e o ack, quando o cliente enviou um.
        const ack = rest[rest.length - 1];
        if (typeof ack === 'function') {
          (ack as (r: { ok: false; error: string }) => void)({
            ok: false,
            error: 'Excesso de eventos. Aguarde um instante.',
          });
        }
        return next(new Error('Excesso de eventos. Aguarde um instante.'));
      }

      next();
    });

    socket.on('error', (err) => {
      console.warn(`[socket ${socket.id}]`, err.message);
    });

    /** Handler que exige apenas uma sessao valida. */
    const member =
      <P, R>(fn: (ctx: Ctx, payload: P, ack: Ack<R>) => unknown) =>
      (payload: P, ack: Ack<R>) => {
        const ctx = contextOf(socket);
        if (!ctx) return fail(ack, 'Sessao nao encontrada. Recarregue a pagina.');
        return fn(ctx, payload, ack);
      };

    /** Handler restrito ao mestre. */
    const gm =
      <P, R>(fn: (ctx: Ctx, payload: P, ack: Ack<R>) => unknown) =>
      (payload: P, ack: Ack<R>) => {
        const ctx = contextOf(socket);
        if (!ctx) return fail(ack, 'Sessao nao encontrada. Recarregue a pagina.');
        if (!isGm(ctx)) return fail(ack, 'Apenas o mestre pode fazer isso.');
        return fn(ctx, payload, ack);
      };

    /** Evento sem resposta (fire-and-forget), como cursor e ping. */
    const loose =
      <P>(fn: (ctx: Ctx, payload: P) => unknown) =>
      (payload: P) => {
        const ctx = contextOf(socket);
        if (ctx) return fn(ctx, payload);
      };

    // -- sessao ------------------------------------------------------------
    socket.on('session:join', (req, ack) => handleJoin(socket, req, ack));
    socket.on('session:resume', (req, ack) => handleResume(socket, req, ack));
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
    socket.on('sheet:create', gm(createSheet));
    socket.on('sheet:update', member(updateSheet));
    socket.on('sheet:delete', gm(deleteSheet));
    socket.on('sheet:assign', gm(assignSheet));
    socket.on('sheet:roll', member(rollSheetField));

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
    socket.on('player:kick', gm(kickPlayer));
    socket.on('player:promote', gm(promotePlayer));
    socket.on('asset:delete', gm(deleteAsset));

    socket.on('handout:create', gm(createHandout));
    socket.on('handout:update', gm(updateHandout));
    socket.on('handout:delete', gm(deleteHandout));
    socket.on('handout:present', gm(presentHandout));

    socket.on('map:ping', loose(pingMap));
  });
}
