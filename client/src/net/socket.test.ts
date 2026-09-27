import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Session, TableState } from '@rpg/shared';

const fake = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  response: { ok: false, error: 'temporario' } as Record<string, unknown>,
}));
vi.mock('socket.io-client', () => ({ io: () => ({
  connected: true,
  on: (name: string, fn: (...args: any[]) => void) => fake.listeners.set(name, fn),
  emit: (_name: string, ...args: any[]) => args.at(-1)(fake.response),
  disconnect: vi.fn(),
}) }));
vi.mock('./api', () => ({ grantImageAccess: vi.fn().mockResolvedValue(undefined), revokeImageAccess: vi.fn().mockResolvedValue(undefined) }));

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, v: string) => data.set(key, v), removeItem: (key: string) => data.delete(key) };
}
const a: Session = { tableId: 'A', tableCode: 'AAA-123', token: 'token-a', playerId: 'p', role: 'PLAYER', name: 'P' };
beforeEach(() => { vi.resetModules(); fake.listeners.clear(); vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('window', { location: { search: '' } }); });
afterEach(() => vi.unstubAllGlobals());

it('keeps the tab identity when another tab replaces the last session', async () => {
  const net = await import('./socket'); net.storeSession(a);
  localStorage.setItem('rpg-vtt:session', JSON.stringify({ ...a, tableId: 'B', token: 'token-b' }));
  expect(net.storedSession()).toEqual(a);
});
it('preserves credentials on transient failures and removes explicitly invalid sessions', async () => {
  const net = await import('./socket'); net.storeSession(a);
  fake.response = { ok: false, error: 'temporario' };
  expect(await net.connectAndResume()).toBe(false); expect(net.storedSession()).toEqual(a);
  fake.response = { ok: false, error: 'revogado', code: 'SESSION_INVALID' };
  expect(await net.connectAndResume()).toBe(false); expect(net.storedSession()).toBeNull();
});
it('updates the local role from an authoritative state of the same table only', async () => {
  const net = await import('./socket'); net.storeSession(a); net.getSocket();
  const { useStore } = await import('../state/store'); useStore.getState().setSession(a);
  const state = { id: 'A', players: [{ id: 'p', name: 'GM', role: 'GM' }], sheets: [] } as unknown as TableState;
  fake.listeners.get('table:state')!(state);
  expect(net.storedSession()?.role).toBe('GM'); expect(useStore.getState().session?.role).toBe('GM');
  fake.listeners.get('table:state')!({ ...state, id: 'foreign', players: [{ id: 'p', role: 'PLAYER' }] });
  expect(net.storedSession()?.role).toBe('GM');
});
