import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createDefaultTemplate, createScene, DEFAULT_SETTINGS, DEFAULT_TURNS, type TableState } from '@rpg/shared';

import { guardUploads, registerImageAccessRoutes } from './image-access.js';
import { rooms, Room } from './room.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Mesa com um jogador e uma imagem que ele so ve se a pista for compartilhada. */
function makeRoom(): Room {
  const scene = createScene();
  return new Room({
    id: 'room', code: 'ROOM', name: 'Room', scenes: [scene], activeSceneId: scene.id,
    players: [
      { id: 'p', name: 'Player', color: '#ffffff', role: 'PLAYER', connected: true, lastSeen: 0, sheetId: null },
      { id: 'q', name: 'Other', color: '#ffffff', role: 'PLAYER', connected: true, lastSeen: 0, sheetId: null },
    ],
    sheets: [], sheetTemplate: createDefaultTemplate(),
    assets: [{ id: 'asset', kind: 'map', url: '/uploads/private.png', thumbUrl: null, originalName: 'Secret', mime: 'image/png', width: 1, height: 1, size: 10, createdAt: 0, uploadedBy: 'gm' }],
    handouts: [{ id: 'handout', title: 'Secret', text: '', assetId: 'asset', sharedWithAll: false, sharedWith: [], createdAt: 0, updatedAt: 0 }],
    chat: [], turns: structuredClone(DEFAULT_TURNS), settings: { ...DEFAULT_SETTINGS }, sceneCards: [], screenEffects: [],
    presentedCard: null, triggerLog: [], board: { locked: false, items: [], threads: [] }, createdAt: 0, updatedAt: 0,
  } as TableState);
}

function makeApp(trustProxy = 0): express.Express {
  const app = express();
  if (trustProxy > 0) app.set('trust proxy', trustProxy);
  registerImageAccessRoutes(app);
  app.use('/uploads', guardUploads(), (_req, res) => res.send('image'));
  return app;
}

it('so marca Secure no cookie quando o pedido chegou por https', async () => {
  // `npm start` roda em producao sobre HTTP puro na rede local: e o caso que
  // ficava sem imagens.
  vi.stubEnv('NODE_ENV', 'production');
  const room = makeRoom();
  vi.spyOn(rooms, 'resolveSession').mockImplementation(async () => ({ room, playerId: 'p' }));
  const grant = (base: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/session/image-access`, { method: 'POST', headers: { 'x-session-token': 'token-a', ...headers } });

  const plain = await listen(makeApp());
  expect((await grant(plain)).headers.get('set-cookie')).not.toContain('Secure');
  // Sem `trust proxy`, o cabecalho do cliente nao basta para se dizer https.
  expect((await grant(plain, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).not.toContain('Secure');

  // O caminho do `npm run share`: tunnel https na frente, TRUST_PROXY=1.
  const tunneled = await listen(makeApp(1));
  expect((await grant(tunneled, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toContain('Secure');
  const revoke = await fetch(`${tunneled}/api/session/image-access`, {
    method: 'DELETE', headers: { 'x-session-token': 'token-a', 'x-forwarded-proto': 'https' },
  });
  expect(revoke.headers.get('set-cookie')).toContain('Secure');
});

it('com cookies demais, fica com as sessoes mais recentes', async () => {
  const room = makeRoom();
  room.state.handouts[0].sharedWithAll = true;
  // So a sessao mais nova vale; as 24 anteriores sao de mesas ja abandonadas.
  vi.spyOn(rooms, 'resolveSession').mockImplementation(async (token) => (token === 'newest' ? { room, playerId: 'p' } : null));
  const base = await listen(makeApp());

  // O navegador manda os cookies mais antigos primeiro.
  const cookie = [...Array.from({ length: 24 }, (_, i) => `rpg_img_old${i}=stale-${i}`), 'rpg_img_new=newest'].join('; ');
  expect((await fetch(`${base}/uploads/private.png`, { headers: { cookie } })).status).toBe(200);
});
