import {
  generateId,
  MAX_SCREEN_MESSAGE_LENGTH,
  SCREEN_MESSAGE_MAX_MS,
  SCREEN_MESSAGE_MIN_MS,
  type Ack,
  type ScreenMessage,
  type ScreenMessageDelivery,
  type ScreenMessageRequest,
  type ScreenMessageStyle,
} from '@rpg/shared';

import { socketsOf, type TypedSocket } from '../broadcast.js';
import type { Room } from '../room.js';
import { clampNumber, fail, ok, safeString, type Ctx } from './context.js';

/**
 * Recursos de imersao: o que o mestre faz aparecer na tela dos jogadores,
 * fora do mapa. Tudo aqui e decidido no servidor — quem recebe, e o que
 * recebe —, e o cliente so desenha.
 */

const MESSAGE_STYLES: ScreenMessageStyle[] = ['neutral', 'whisper', 'threat'];

/** Quanto esperar a confirmacao de cada aba antes de dar a entrega por incerta. */
const DELIVERY_TIMEOUT_MS = 4000;

/** Sockets conectados de cada jogador pedido, so jogadores desta mesa. */
function socketsByPlayer(room: Room, playerIds: Iterable<string>): Map<string, TypedSocket[]> {
  const wanted = new Set(playerIds);
  const out = new Map<string, TypedSocket[]>();
  for (const id of wanted) {
    const player = room.player(id);
    if (player && player.role === 'PLAYER') out.set(id, []);
  }
  for (const socket of socketsOf(room)) {
    out.get(socket.data.viewer.playerId)?.push(socket);
  }
  return out;
}

/**
 * Entrega uma mensagem e espera a confirmacao de cada destinatario.
 *
 * Uma pessoa com duas abas abertas conta como entregue se qualquer uma
 * confirmar. Quem nao tem aba nenhuma fica em `offline`: a mensagem nao e
 * guardada para depois, porque fora de hora ela perde o sentido.
 */
export async function deliverScreenMessage(
  room: Room,
  recipients: Iterable<string>,
  message: ScreenMessage,
): Promise<ScreenMessageDelivery> {
  const result: ScreenMessageDelivery = { delivered: [], offline: [], unconfirmed: [] };

  await Promise.all(
    [...socketsByPlayer(room, recipients)].map(async ([playerId, sockets]) => {
      if (sockets.length === 0) {
        result.offline.push(playerId);
        return;
      }
      const acks = await Promise.all(
        sockets.map((socket) =>
          socket
            .timeout(DELIVERY_TIMEOUT_MS)
            .emitWithAck('message:show', message)
            .then((received) => received === true)
            .catch(() => false),
        ),
      );
      (acks.some(Boolean) ? result.delivered : result.unconfirmed).push(playerId);
    }),
  );

  return result;
}

/** Monta a mensagem a partir do que o cliente mandou, ou devolve o erro. */
export function screenMessageFrom(payload: Partial<ScreenMessageRequest> | undefined): ScreenMessage | string {
  const text = safeString(payload?.text, MAX_SCREEN_MESSAGE_LENGTH).trim();
  if (!text) return 'Escreva a mensagem.';

  const style = MESSAGE_STYLES.includes(payload?.style as ScreenMessageStyle)
    ? (payload!.style as ScreenMessageStyle)
    : 'neutral';

  const durationMs =
    payload?.durationMs === null
      ? null
      : clampNumber(payload?.durationMs, SCREEN_MESSAGE_MIN_MS, SCREEN_MESSAGE_MAX_MS, 6000);

  return { id: generateId('msg'), text, style, durationMs };
}

export async function sendScreenMessage(
  ctx: Ctx,
  payload: ScreenMessageRequest,
  ack: Ack<ScreenMessageDelivery>,
): Promise<void> {
  const message = screenMessageFrom(payload);
  if (typeof message === 'string') return fail(ack, message);

  const recipients = Array.isArray(payload?.recipients)
    ? payload.recipients.filter((id): id is string => typeof id === 'string').slice(0, 50)
    : [];
  if (recipients.length === 0) return fail(ack, 'Escolha quem recebe a mensagem.');

  const delivery = await deliverScreenMessage(ctx.room, recipients, message);
  if (delivery.delivered.length + delivery.offline.length + delivery.unconfirmed.length === 0) {
    return fail(ack, 'Nenhum destinatario valido.');
  }
  ok(ack, delivery);
}
