import type { Ack, Result, Scene, Token } from '@rpg/shared';

import type { TypedSocket } from '../broadcast.js';
import type { Viewer } from '../filter.js';
import { rooms, type Room } from '../room.js';

/** Utilidades compartilhadas pelos handlers: contexto, ack e permissoes. */

export interface Ctx {
  room: Room;
  viewer: Viewer;
  socket: TypedSocket;
}

export function contextOf(socket: TypedSocket): Ctx | null {
  const data = socket.data;
  if (!data?.tableId || !data.viewer) return null;
  const room = rooms.get(data.tableId);
  if (!room) return null;
  return { room, viewer: data.viewer, socket };
}

export function ok<T>(ack: Ack<T> | undefined, data: T): void {
  ack?.({ ok: true, data });
}

export function fail(ack: Ack<never> | Ack<unknown> | undefined, error: string): void {
  (ack as ((r: Result<unknown>) => void) | undefined)?.({ ok: false, error });
}

export function isGm(ctx: Ctx): boolean {
  return ctx.viewer.role === 'GM';
}

/**
 * Envolve um handler que exige papel de mestre. Toda mutacao de mapa, fog,
 * cena e template passa por aqui: o cliente esconde os controles, mas quem
 * garante e o servidor.
 */
export function gmOnly<A extends unknown[]>(
  socket: TypedSocket,
  ack: Ack<unknown> | undefined,
  fn: (ctx: Ctx, ...args: A) => void,
): (...args: A) => void {
  return (...args: A) => {
    const ctx = contextOf(socket);
    if (!ctx) return fail(ack, 'Sessao nao encontrada.');
    if (!isGm(ctx)) return fail(ack, 'Apenas o mestre pode fazer isso.');
    fn(ctx, ...args);
  };
}

export function sceneOf(ctx: Ctx, sceneId: string): Scene | null {
  return ctx.room.scene(sceneId) ?? null;
}

/**
 * Quem pode mover um token: o mestre sempre; o jogador so o proprio, e
 * apenas quando `playersMoveOwnTokensOnly` esta ligado — desligado, ele pode
 * mover qualquer token que enxergue (util para mesas mais colaborativas).
 */
export function canMoveToken(ctx: Ctx, token: Token): boolean {
  if (isGm(ctx)) return true;
  if (token.locked) return false;
  if (token.gmOnly || token.visibility === 'hidden') return false;
  if (ctx.room.state.settings.playersMoveOwnTokensOnly) {
    return token.ownerPlayerId === ctx.viewer.playerId;
  }
  return true;
}

/** Um jogador so edita a ficha que e dele. */
export function canEditSheet(ctx: Ctx, sheetOwnerId: string | null): boolean {
  return isGm(ctx) || sheetOwnerId === ctx.viewer.playerId;
}

export function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

export function safeString(v: unknown, maxLength: number, fallback = ''): string {
  if (typeof v !== 'string') return fallback;
  return v.slice(0, maxLength);
}
