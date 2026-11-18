import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScene, DEFAULT_SETTINGS, DEFAULT_TURNS, createDefaultTemplate, type Player, type TableState } from '@rpg/shared';

vi.mock('./db.js', () => ({
  prisma: {
    table: { update: vi.fn(), findUnique: vi.fn() },
    player: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    sheet: { create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    asset: { findMany: vi.fn() },
  },
  toJson: JSON.stringify,
  fromJson: (s: string) => JSON.parse(s),
  withRetry: (fn: () => unknown) => fn(),
}));

import { bindIo, type TypedServer, type TypedSocket } from './broadcast.js';
import type { Ctx } from './handlers/context.js';
import { updateScene } from './handlers/scene.js';
import { Room } from './room.js';

/*
 * `scene:update` devolve ao mestre so as chaves que mudaram. A cartela de
 * abertura ficava de fora da lista: o servidor gravava, o mestre recebia
 * `patch: {}` e o seletor do painel voltava ao valor anterior.
 *
 * O id da cartela e material de preparacao, entao o teste olha os dois lados:
 * o mestre tem de receber, o jogador nao pode.
 */

interface FakeSocket {
  socket: TypedSocket;
  received: unknown[][];
}

let socketMap: Map<string, TypedSocket>;
const created: Room[] = [];

beforeEach(() => {
  socketMap = new Map();
  bindIo({ sockets: { sockets: socketMap } } as unknown as TypedServer);
});

afterEach(() => {
  for (const room of created.splice(0)) room.cancelPendingWrites();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function player(id: string, role: Player['role'] = 'PLAYER'): Player {
  return { id, name: id, role, color: '#ffffff', connected: true, lastSeen: 0, sheetId: null };
}

/** Mesa com mestre e Alice, uma cena no ar e uma cartela pronta. */
function table(): Room {
  const scene = createScene({ id: 'scn-ativa' });
  const state: TableState = {
    id: 'mesa',
    code: 'mesa',
    name: 'mesa',
    activeSceneId: scene.id,
    settings: { ...DEFAULT_SETTINGS },
    sheetTemplate: createDefaultTemplate(),
    turns: structuredClone(DEFAULT_TURNS),
    scenes: [scene],
    sheets: [],
    players: [player('mestre', 'GM'), player('alice')],
    assets: [],
    handouts: [],
    chat: [],
    sceneCards: [{ id: 'crd-SEGREDO', title: 'Abertura', subtitle: '', assetId: null, createdAt: 0, updatedAt: 0 }],
    screenEffects: [],
    presentedCard: null,
    triggerLog: [],
    board: { locked: false, items: [], threads: [] },
    createdAt: 0,
    updatedAt: 0,
  };
  const room = new Room(state);
  created.push(room);
  return room;
}

function connect(room: Room, playerId: string): FakeSocket {
  const received: unknown[][] = [];
  const role = room.player(playerId)?.role ?? 'PLAYER';
  const socket = {
    id: `sock-${playerId}`,
    connected: true,
    data: { tableId: room.state.id, viewer: { playerId, role } },
    emit: (...args: unknown[]) => {
      received.push(args);
      return true;
    },
    join: vi.fn(),
    leave: vi.fn(),
    disconnect: vi.fn(),
    nsp: { sockets: socketMap },
  } as unknown as TypedSocket;
  socketMap.set(socket.id, socket);
  room.sockets.add(socket.id);
  return { socket, received };
}

function ctxOf(room: Room, sock: FakeSocket): Ctx {
  return { room, viewer: sock.socket.data.viewer, socket: sock.socket };
}

/** Os patches de cena que o socket recebeu, na ordem. */
function scenePatches(sock: FakeSocket): Record<string, unknown>[] {
  return sock.received
    .filter(([event]) => event === 'scene:patch')
    .map(([, body]) => (body as { patch: Record<string, unknown> }).patch);
}

describe('scene:update: cartela de abertura', () => {
  it('o mestre recebe de volta a cartela que escolheu', () => {
    const room = table();
    const gm = connect(room, 'mestre');

    updateScene(ctxOf(room, gm), { sceneId: 'scn-ativa', patch: { introCardId: 'crd-SEGREDO' } }, () => {});

    expect(room.scene('scn-ativa')!.introCardId).toBe('crd-SEGREDO');
    expect(scenePatches(gm)).toEqual([{ introCardId: 'crd-SEGREDO' }]);
  });

  it('o mestre recebe null quando a cartela escolhida nao existe', () => {
    const room = table();
    room.scene('scn-ativa')!.introCardId = 'crd-SEGREDO';
    const gm = connect(room, 'mestre');

    updateScene(ctxOf(room, gm), { sceneId: 'scn-ativa', patch: { introCardId: 'crd-apagada' } }, () => {});

    expect(scenePatches(gm)).toEqual([{ introCardId: null }]);
  });

  it('o jogador nao recebe o id da cartela, nem junto de outra chave', () => {
    const room = table();
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');

    updateScene(
      ctxOf(room, gm),
      { sceneId: 'scn-ativa', patch: { name: 'Taverna', introCardId: 'crd-SEGREDO' } },
      () => {},
    );

    expect(scenePatches(gm)).toEqual([{ name: 'Taverna', introCardId: 'crd-SEGREDO' }]);
    expect(scenePatches(alice)).toEqual([{ name: 'Taverna' }]);
    expect(JSON.stringify(alice.received)).not.toMatch(/SEGREDO|introCardId/);
  });
});
