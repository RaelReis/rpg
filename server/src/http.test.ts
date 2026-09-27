import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { asyncRoute } from './http.js';
import { guardUploads, registerImageAccessRoutes } from './image-access.js';
import { rooms, Room } from './room.js';
import { createDefaultTemplate, createScene, DEFAULT_SETTINGS, DEFAULT_TURNS, type TableState } from '@rpg/shared';

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('forwards an asynchronous route failure to the JSON error handler', async () => {
  const app = express();
  app.get('/failure', asyncRoute(async () => { throw new Error('simulated'); }));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: 'handled' }));
  const response = await fetch(`${await listen(app)}/failure`);
  expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'handled' });
});
it('issues independent cookies and rechecks sharing on each download', async () => {
  const scene = createScene();
  const room = new Room({ id: 'room', code: 'ROOM', name: 'Room', scenes: [scene], activeSceneId: scene.id, players: [{ id: 'p', name: 'Player', color: '#ffffff', role: 'PLAYER', connected: true, lastSeen: 0, sheetId: null }], sheets: [], sheetTemplate: createDefaultTemplate(), assets: [{ id: 'asset', kind: 'map', url: '/uploads/private.png', thumbUrl: null, originalName: 'Secret', mime: 'image/png', width: 1, height: 1, size: 10, createdAt: 0, uploadedBy: 'gm' }], handouts: [{ id: 'handout', title: 'Secret', text: '', assetId: 'asset', sharedWithAll: false, sharedWith: [], createdAt: 0, updatedAt: 0 }], chat: [], turns: structuredClone(DEFAULT_TURNS), settings: { ...DEFAULT_SETTINGS }, sceneCards: [], screenEffects: [], presentedCard: null, triggerLog: [], board: { locked: false, items: [], threads: [] }, createdAt: 0, updatedAt: 0 } as TableState);
  vi.spyOn(rooms, 'resolveSession').mockImplementation(async token => ['token-a', 'token-b'].includes(token) ? { room, playerId: 'p' } : null);
  const app = express(); registerImageAccessRoutes(app);
  app.use('/uploads', guardUploads(), (_req, res) => res.send('image'));
  const base = await listen(app);
  const grant = (token: string) => fetch(`${base}/api/session/image-access`, { method: 'POST', headers: { 'x-session-token': token } });
  const a = (await grant('token-a')).headers.get('set-cookie')!;
  const b = (await grant('token-b')).headers.get('set-cookie')!;
  expect(a.split('=')[0]).not.toBe(b.split('=')[0]); expect(a).toContain('Path=/uploads');
  const cookie = `${a.split(';')[0]}; ${b.split(';')[0]}`;
  const download = () => fetch(`${base}/uploads/private.png`, { headers: { cookie } });
  expect((await download()).status).toBe(404);
  room.state.handouts[0].sharedWithAll = true;
  expect((await download()).status).toBe(200);
  room.state.handouts[0].sharedWithAll = false;
  expect((await download()).status).toBe(404);
  const revoke = await fetch(`${base}/api/session/image-access`, { method: 'DELETE', headers: { 'x-session-token': 'token-b' } });
  expect(revoke.headers.get('set-cookie')!.split('=')[0]).toBe(b.split('=')[0]);
  expect(revoke.headers.get('set-cookie')).toContain('Max-Age=0');
});
