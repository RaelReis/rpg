import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScene, createTile, createToken, createWall, createDefaultTemplate, createSheetValues, DEFAULT_SETTINGS, DEFAULT_TURNS, type TableState, type Sheet } from '@rpg/shared';

vi.mock('./db.js', () => ({
  prisma: { table: { update: vi.fn(), findUnique: vi.fn() }, player: { findUnique: vi.fn(), create: vi.fn() }, sheet: { create: vi.fn() }, asset: { findMany: vi.fn() } },
  toJson: JSON.stringify, fromJson: (s: string) => JSON.parse(s), withRetry: (fn: () => unknown) => fn(),
}));
import { prisma } from './db.js';
import { Room, rooms } from './room.js';
import { bindIo, sendFullStateToAll, type TypedSocket, type TypedServer } from './broadcast.js';
import { handleJoin } from './handlers/session.js';
import { stateForViewer, assetIdsOfSheet } from './filter.js';
import { exportTable, remapSheetImages } from './backup.js';
import { hashPassword, verifyPassword } from './auth.js';
import { moveToken, updateWall } from './handlers/map.js';
import { operateSheet } from './handlers/sheets.js';
import { validateBackup } from './backup-validation.js';
import { ownedAsset, type Ctx } from './handlers/context.js';

const created: Room[] = [];
function fixture(id = 'table'): Room {
  const template = createDefaultTemplate();
  const scene = createScene({ id: `${id}-scene` });
  const sheet: Sheet = { id: 'sheet', name: 'NPC', ownerPlayerId: null, portraitAssetId: null, bodyAssetId: null, values: createSheetValues(template), sharedWithParty: false, createdAt: 0, updatedAt: 0 };
  const state: TableState = { id, code: id, name: id, activeSceneId: scene.id, settings: { ...DEFAULT_SETTINGS }, sheetTemplate: template, turns: structuredClone(DEFAULT_TURNS), scenes: [scene], sheets: [sheet], players: [], assets: [], handouts: [], chat: [], sceneCards: [], screenEffects: [], presentedCard: null, triggerLog: [], board: { locked: false, items: [], threads: [] }, createdAt: 0, updatedAt: 0 };
  const room = new Room(state); created.push(room); return room;
}
afterEach(() => { for (const room of created.splice(0)) room.cancelPendingWrites(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('audit regressions', () => {
  it('retains failed writes for the next flush', async () => {
    const room = fixture();
    vi.mocked(prisma.table.update).mockRejectedValueOnce(new Error('disk failure')).mockResolvedValueOnce({} as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    room.touch('table');
    await expect(room.flush()).rejects.toThrow('disk failure');
    expect(room.persistenceError).toBe(true);
    await room.flush();
    expect(prisma.table.update).toHaveBeenCalledTimes(2);
    expect(room.persistenceError).toBe(false);
  });
  it('resolves valid sessions, caches them, and refuses a removed player', async () => {
    const room = fixture();
    room.state.players.push({ id: 'p', name: 'P', role: 'PLAYER', color: '#ffffff', connected: true, lastSeen: 0, sheetId: null });
    vi.spyOn(rooms, 'load').mockResolvedValue(room);
    vi.mocked(prisma.player.findUnique).mockResolvedValue({ id: 'p', tableId: room.state.id } as never);
    expect((await rooms.resolveSession('synthetic-audit-token'))?.playerId).toBe('p');
    expect((await rooms.resolveSession('synthetic-audit-token'))?.playerId).toBe('p');
    expect(prisma.player.findUnique).toHaveBeenCalledTimes(1);
    room.state.players = [];
    expect(await rooms.resolveSession('synthetic-audit-token')).toBeNull();
  });
  it('does not send a secret resource through a token bar', () => {
    const room = fixture();
    room.state.sheetTemplate.fields.find(f => f.id === 'hp')!.gmOnly = true;
    room.activeScene()!.tokens.push(createToken({ sheetId: 'sheet', bars: [{ fieldId: 'hp', color: '#ffffff' }] }));
    const state = stateForViewer(room, { playerId: 'p', role: 'PLAYER' });
    expect(state.sheets.flatMap(s => Object.keys(s.values))).not.toContain('hp');
    expect(state.scenes[0].tokens[0].bars).toEqual([]);
  });
  it('fails explicitly instead of silently exporting without images', async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([{ size: 121 * 1024 * 1024 }] as never);
    await expect(exportTable(fixture(), true)).rejects.toThrow('120 MB');
  });
  it('collects and remaps image fields without remapping arbitrary text', () => {
    const room = fixture(); const sheet = room.state.sheets[0];
    room.state.sheetTemplate.fields.push({ ...room.state.sheetTemplate.fields[0], id: 'drawing', type: 'image' });
    sheet.values.drawing = 'old'; sheet.values.concept = 'old';
    expect(assetIdsOfSheet(sheet, room.state.sheetTemplate)).toContain('old');
    expect(remapSheetImages(room.state.sheetTemplate, sheet.values, () => 'new')).toMatchObject({ drawing: 'new', concept: 'old' });
  });
  it('rejects player movement in inactive scenes', () => {
    const room = fixture(); const scene = createScene({ tokens: [createToken({ id: 'token', ownerPlayerId: 'p' })] });
    room.state.scenes.push(scene); const ack = vi.fn();
    moveToken({ room, viewer: { playerId: 'p', role: 'PLAYER' }, socket: {} as TypedSocket }, { sceneId: scene.id, tokenId: 'token', x: 300, y: 300 }, ack);
    expect(ack.mock.calls[0][0].ok).toBe(false);
    expect(scene.tokens[0].x).toBe(0);
  });
  it('detaches an old room before authenticating into another', async () => {
    const a = fixture('A'); const b = fixture('B');
    a.state.handouts.push({ id: 'secret', title: 'Secret', text: 'Private', assetId: null, sharedWith: [], sharedWithAll: false, createdAt: 0, updatedAt: 0 });
    vi.spyOn(rooms, 'loadByCode').mockImplementation(async code => code === 'A' ? a : b);
    vi.spyOn(rooms, 'get').mockImplementation(id => id === 'A' ? a : b);
    vi.mocked(prisma.table.findUnique).mockResolvedValue({ gmPasswordHash: await hashPassword('password') } as never);
    const emit = vi.fn(); const socketMap = new Map();
    const socket = { id: 'socket', connected: true, data: {}, join: vi.fn(), leave: vi.fn(), emit, nsp: { sockets: socketMap } } as unknown as TypedSocket;
    socketMap.set(socket.id, socket);
    bindIo({ sockets: { sockets: socketMap } } as unknown as TypedServer);
    await handleJoin(socket, { code: 'A', name: 'Player' }, vi.fn());
    await handleJoin(socket, { code: 'B', name: 'GM', gmPassword: 'password' }, vi.fn());
    expect(a.sockets.has(socket.id)).toBe(false);
    expect(socket.leave).toHaveBeenCalledWith('table:A');
    // Even a stale membership cannot bypass the broadcast's own check.
    a.sockets.add(socket.id); emit.mockClear(); sendFullStateToAll(a);
    expect(emit).not.toHaveBeenCalled();
  });
  it('hashes asynchronously and enforces the same password boundary', async () => {
    const password = 'x'.repeat(200); const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    await expect(hashPassword('x'.repeat(201))).rejects.toThrow();
    expect(await verifyPassword('x'.repeat(201), hash)).toBe(false);
  });
  it('applies rapid resource clicks to current values and enforces field permissions', () => {
    const room = fixture(); const sheet = room.state.sheets[0]; sheet.ownerPlayerId = 'p';
    sheet.values.hp = { current: 5, max: 10 };
    const ctx = { room, viewer: { role: 'PLAYER', playerId: 'p' }, socket: {} } as Ctx;
    const ack = vi.fn();
    operateSheet(ctx, { sheetId: sheet.id, fieldId: 'hp', action: 'adjust', delta: 1 }, ack);
    operateSheet(ctx, { sheetId: sheet.id, fieldId: 'hp', action: 'adjust', delta: 1 }, ack);
    expect(sheet.values.hp).toEqual({ current: 7, max: 10 });
    room.state.sheetTemplate.fields.find(f => f.id === 'hp')!.locked = true;
    operateSheet(ctx, { sheetId: sheet.id, fieldId: 'hp', action: 'adjust', delta: 1 }, ack);
    expect(sheet.values.hp).toEqual({ current: 7, max: 10 });
    expect(ack.mock.lastCall?.[0].ok).toBe(false);
  });
  it('preserves independent inventory updates', () => {
    const room = fixture(); const sheet = room.state.sheets[0]; sheet.ownerPlayerId = 'p';
    const ctx = { room, viewer: { role: 'PLAYER', playerId: 'p' }, socket: {} } as Ctx;
    for (let i = 0; i < 2; i++) operateSheet(ctx, { sheetId: sheet.id, fieldId: 'items', action: 'add' }, vi.fn());
    const items = sheet.values.items as { id: string; name: string }[];
    operateSheet(ctx, { sheetId: sheet.id, fieldId: 'items', action: 'update', itemId: items[0].id, item: { name: 'First' } }, vi.fn());
    operateSheet(ctx, { sheetId: sheet.id, fieldId: 'items', action: 'update', itemId: items[1].id, item: { name: 'Second' } }, vi.fn());
    expect((sheet.values.items as typeof items).map(i => i.name)).toEqual(['First', 'Second']);
  });
  it('rejects hostile imports before persistence, but accepts an ordinary scene', () => {
    const room = fixture();
    const backup = { format: 1, scenes: room.state.scenes, sheets: room.state.sheets, sheetTemplate: room.state.sheetTemplate, assets: [] };
    expect(() => validateBackup(backup)).not.toThrow();
    expect(() => validateBackup({ ...backup, scenes: Array(101).fill(room.state.scenes[0]) })).toThrow();
    expect(() => validateBackup({ ...backup, scenes: [{ ...room.state.scenes[0], grid: { size: 0 } }] })).toThrow();
    expect(() => validateBackup({ ...backup, scenes: [{ ...room.state.scenes[0], tokens: [{ id: 'bad', visionRadius: 1e9 }] }] })).toThrow();
    expect(() => validateBackup({ ...backup, scenes: [{ ...room.state.scenes[0], backgroundAssetId: 'foreign' }] })).toThrow();
    expect(() => validateBackup({ ...backup, sheets: [{ ...room.state.sheets[0], values: { items: [null] } }] })).toThrow();
  });
  it('does not permit binding a secret image to a public character', () => {
    const room = fixture();
    room.state.assets.push({ id: 'private', kind: 'map', url: '/uploads/private.png', thumbUrl: null, originalName: 'Secret', mime: 'image/png', width: 1, height: 1, size: 10, createdAt: 0, uploadedBy: 'gm' });
    const ctx = { room, viewer: { role: 'PLAYER', playerId: 'p' }, socket: {} } as Ctx;
    expect(ownedAsset(ctx, 'private')).toBeNull();
    room.state.assets[0].uploadedBy = 'p';
    expect(ownedAsset(ctx, 'private')).toBe('private');
  });
});

describe('portas abertas pelo jogador', () => {
  // Alice no canto (0,0), no escuro total: enxerga so em volta de si.
  function doorsFixture(): { room: Room; ctx: Ctx; open: (wallId: string, sceneId?: string) => { ok: boolean; error?: string } } {
    const room = fixture();
    const scene = room.activeScene()!;
    scene.fog.mode = 'vision';
    scene.globalLight = 0;
    scene.tokens.push(createToken({ id: 'alice-token', ownerPlayerId: 'alice', x: 0, y: 0, visionRadius: 1 }));
    scene.walls.push(createWall({ id: 'perto', x1: 70, y1: 0, x2: 70, y2: 70, door: true }));
    scene.walls.push(createWall({ id: 'longe', x1: 1400, y1: 0, x2: 1400, y2: 70, door: true }));
    scene.walls.push(createWall({ id: 'secreta', x1: 0, y1: 70, x2: 70, y2: 70, door: true, hidden: true }));
    room.state.players.push({ id: 'alice', name: 'Alice', role: 'PLAYER', color: '#ffffff', connected: true, lastSeen: 0, sheetId: null });
    const ctx = { room, viewer: { role: 'PLAYER', playerId: 'alice' }, socket: {} } as Ctx;
    const open = (wallId: string, sceneId = scene.id) => {
      const ack = vi.fn();
      updateWall(ctx, { sceneId, wallId, patch: { open: true } }, ack);
      return ack.mock.calls[0][0];
    };
    return { room, ctx, open };
  }

  it('abre a porta que o jogador enxerga', () => {
    const { room, open } = doorsFixture();
    expect(open('perto').ok).toBe(true);
    expect(room.activeScene()!.walls.find((w) => w.id === 'perto')!.open).toBe(true);
  });

  it('recusa a porta no escuro do outro lado do mapa', () => {
    const { room, open } = doorsFixture();
    expect(open('longe')).toMatchObject({ ok: false, error: 'Voce nao enxerga esta porta.' });
    expect(room.activeScene()!.walls.find((w) => w.id === 'longe')!.open).toBe(false);
  });

  it('recusa porta secreta e porta de cena fora do ar', () => {
    const { room, open } = doorsFixture();
    expect(open('secreta').ok).toBe(false);
    const other = createScene({ walls: [createWall({ id: 'outra', x1: 70, y1: 0, x2: 70, y2: 70, door: true })] });
    room.state.scenes.push(other);
    expect(open('outra', other.id)).toMatchObject({ ok: false, error: 'Esta cena nao esta no ar.' });
  });
});

describe('parada encostada no obstaculo', () => {
  // Tile que bloqueia, desalinhado da grade (comeca em x=720, a grade em 700).
  // Com a visao estrita o cliente nao o conhece: o arraste para onde o
  // servidor barra, no meio de uma celula, e o soltar pede a celula encaixada.
  it('encaixa na celula vizinha que o token alcanca, e nao em cima do obstaculo', () => {
    const room = fixture();
    const scene = room.activeScene()!;
    scene.tiles.push(createTile({ id: 'estante', x: 720, y: 0, width: 70, height: 210, blocksVision: true }));
    scene.tokens.push(createToken({ id: 'bruno', ownerPlayerId: 'p', x: 630, y: 70 }));
    room.state.players.push({ id: 'p', name: 'P', role: 'PLAYER', color: '#ffffff', connected: true, lastSeen: 0, sheetId: null });
    const ctx = { room, viewer: { playerId: 'p', role: 'PLAYER' }, socket: { emit: vi.fn() } } as unknown as Ctx;

    // Arraste ate o centro encostar no obstaculo (centro em 719, ele comeca em 720).
    moveToken(ctx, { sceneId: scene.id, tokenId: 'bruno', x: 684, y: 70, dragging: true }, vi.fn());
    expect(scene.tokens.find((t) => t.id === 'bruno')!.x).toBe(684);

    // Soltar pede a celula encaixada mais proxima (700), que cruza o obstaculo.
    moveToken(ctx, { sceneId: scene.id, tokenId: 'bruno', x: 700, y: 70 }, vi.fn());
    const bruno = scene.tokens.find((t) => t.id === 'bruno')!;
    expect({ x: bruno.x, y: bruno.y }).toEqual({ x: 630, y: 70 });
  });
});
