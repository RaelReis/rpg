import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Session, TableState } from '@rpg/shared';

/*
 * Retomada da sessao (P04). O socket e falso: cada `emit` responde na hora com
 * `fake.response`, e os testes disparam o `connect` na mao para simular a
 * reconexao.
 */
const fake = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  response: { ok: false, error: 'temporario' } as Record<string, unknown>,
  emits: [] as string[],
  connected: true,
  grant: (() => Promise.resolve()) as (token: string) => Promise<void>,
}));
vi.mock('socket.io-client', () => ({ io: () => ({
  get connected() { return fake.connected; },
  on: (name: string, fn: (...args: any[]) => void) => fake.listeners.set(name, fn),
  emit: (name: string, ...args: any[]) => { fake.emits.push(name); args.at(-1)(fake.response); },
  disconnect: vi.fn(),
}) }));
vi.mock('./api', () => ({ grantImageAccess: (token: string) => fake.grant(token), revokeImageAccess: vi.fn().mockResolvedValue(undefined) }));

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, v: string) => data.set(key, v), removeItem: (key: string) => data.delete(key) };
}
const a: Session = { tableId: 'A', tableCode: 'AAA-123', token: 'token-a', playerId: 'p', role: 'PLAYER', name: 'P' };
const table = (name: string) => ({ id: 'A', name, players: [{ id: 'p', name: 'P', role: 'PLAYER' }], sheets: [], screenEffects: [] }) as unknown as TableState;

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  fake.listeners.clear(); fake.emits = []; fake.connected = true;
  fake.grant = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('window', { location: { search: '' } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Cliente ja dentro da mesa, com o estado antigo na tela. */
async function seated() {
  const net = await import('./socket'); net.storeSession(a); net.getSocket();
  const { useStore } = await import('../state/store');
  useStore.getState().setSession(a); useStore.getState().setTable(table('antiga'));
  return { net, useStore, reconnect: () => fake.listeners.get('connect')!() };
}

it('volta a tela de entrada quando a reconexao recebe SESSION_INVALID', async () => {
  const { net, useStore, reconnect } = await seated();
  fake.response = { ok: false, error: 'Jogador nao faz mais parte desta mesa.', code: 'SESSION_INVALID' };
  reconnect(); await vi.advanceTimersByTimeAsync(0);
  expect(net.storedSession()).toBeNull();
  expect(useStore.getState().session).toBeNull();
  expect(useStore.getState().table).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fake.emits).toEqual(['session:resume']);
});

it('repete o resume depois de uma falha passageira na reconexao', async () => {
  const { net, useStore, reconnect } = await seated();
  fake.response = { ok: false, error: 'Uma entrada ja esta em andamento.' };
  reconnect(); await vi.advanceTimersByTimeAsync(0);
  expect(useStore.getState().table?.name).toBe('antiga');
  expect(net.storedSession()).toEqual(a);

  fake.response = { ok: true, data: { session: a, state: table('nova') } };
  await vi.advanceTimersByTimeAsync(1000);
  expect(fake.emits).toEqual(['session:resume', 'session:resume']);
  expect(useStore.getState().table?.name).toBe('nova');
});

it('desiste depois do limite de tentativas, sem perder a sessao', async () => {
  const { net, useStore, reconnect } = await seated();
  fake.response = { ok: false, error: 'temporario' };
  reconnect(); await vi.advanceTimersByTimeAsync(20_000);
  expect(fake.emits.length).toBe(5);
  expect(net.storedSession()).toEqual(a);
  expect(useStore.getState().notices.at(-1)?.message).toMatch(/Recarregue/);
});

it('para de insistir se a conexao cai de novo: o proximo connect recomeca', async () => {
  const { useStore, reconnect } = await seated();
  fake.response = { ok: false, error: 'temporario' };
  reconnect(); await vi.advanceTimersByTimeAsync(0);
  fake.connected = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fake.emits.length).toBe(1);

  fake.connected = true; fake.response = { ok: true, data: { session: a, state: table('nova') } };
  reconnect(); await vi.advanceTimersByTimeAsync(0);
  expect(useStore.getState().table?.name).toBe('nova');
});
