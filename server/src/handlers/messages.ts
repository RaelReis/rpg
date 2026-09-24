import {
  generateId,
  MAX_SCREEN_MESSAGE_LENGTH,
  MAX_SCREEN_MESSAGE_MS,
  type Ack,
  type ScreenMessage,
  type ScreenMessageReport,
  type ScreenMessageRequest,
  type ScreenMessageStyle,
} from '@rpg/shared';

import { socketsOf } from '../broadcast.js';
import { clampNumber, fail, ok, safeString, type Ctx } from './context.js';

/**
 * Mensagem individual: um texto no centro da tela de jogadores escolhidos.
 *
 * Nao passa pelo chat nem pelo banco. Quem esta offline nao recebe depois —
 * o mestre fica sabendo na hora e decide o que fazer, porque uma voz que
 * chama o nome de alguem uma hora mais tarde ja nao assusta ninguem.
 */

const STYLES: ScreenMessageStyle[] = ['neutral', 'whisper', 'threat'];

/** Quanto esperar a tela do jogador confirmar que mostrou a mensagem. */
const DELIVERY_TIMEOUT_MS = 4000;
const MIN_DURATION_MS = 1000;

export async function sendScreenMessage(
  ctx: Ctx,
  payload: ScreenMessageRequest,
  ack: Ack<ScreenMessageReport>,
): Promise<void> {
  const text = safeString(payload?.text, MAX_SCREEN_MESSAGE_LENGTH).trim();
  if (!text) return fail(ack, 'Escreva a mensagem.');

  const style = STYLES.includes(payload?.style) ? payload.style : 'neutral';
  const durationMs =
    payload?.durationMs === null
      ? null
      : clampNumber(payload?.durationMs, MIN_DURATION_MS, MAX_SCREEN_MESSAGE_MS, 6000);

  const players = new Set(
    ctx.room.state.players.filter((p) => p.role === 'PLAYER').map((p) => p.id),
  );
  const targets = Array.isArray(payload?.playerIds)
    ? [...new Set(payload.playerIds)].filter((id): id is string => typeof id === 'string' && players.has(id))
    : [];
  if (targets.length === 0) return fail(ack, 'Escolha ao menos um jogador.');

  const message: ScreenMessage = { id: generateId('msg'), text, style, durationMs };
  const report: ScreenMessageReport = { delivered: [], offline: [], unconfirmed: [] };
  const sockets = socketsOf(ctx.room);

  await Promise.all(
    targets.map(async (playerId) => {
      // A mesma pessoa pode ter mais de uma aba aberta: mostra em todas, e
      // basta uma confirmar.
      const mine = sockets.filter((s) => s.data.viewer.playerId === playerId);
      if (mine.length === 0) {
        report.offline.push(playerId);
        return;
      }

      const confirmations = mine.map((s) =>
        s.timeout(DELIVERY_TIMEOUT_MS).emitWithAck('message:shown', message),
      );
      try {
        await Promise.any(confirmations);
        report.delivered.push(playerId);
      } catch {
        report.unconfirmed.push(playerId);
      }
    }),
  );

  ok(ack, report);
}
