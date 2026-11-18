import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultTemplate,
  createScene,
  createToken,
  createTrigger,
  DEFAULT_SETTINGS,
  DEFAULT_TURNS,
  type Player,
  type TableState,
} from '@rpg/shared';

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
import { addTurnEntries } from './handlers/play.js';
import { fireTrigger } from './handlers/triggers.js';
import { Room } from './room.js';

/*
 * Acoes de gatilho contra sockets falsos, no mesmo molde do `leaks.test.ts`:
 * o que interessa e o que cada papel recebeu depois do disparo, nao so o
 * estado que ficou no servidor.
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

/** Mesa com mestre e Alice, e um cultista oculto que o gatilho vai revelar. */
function table(): Room {
  const scene = createScene({
    id: 'scn-ativa',
    tokens: [
      createToken({ id: 'tok-alice', name: 'Alice', ownerPlayerId: 'alice', x: 0, y: 0 }),
      createToken({ id: 'tok-cultista', name: 'Cultista', visibility: 'hidden', x: 140, y: 0 }),
    ],
  });
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
    sceneCards: [],
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

describe('gatilho: acao de revelar token', () => {
  // P03. A vez de um token oculto e escondida no envio (`turnsForViewer`), entao
  // revelar o token muda o que o jogador deveria ver na faixa. O gatilho
  // revelava no mapa e nao reenviava os turnos: a miniatura so aparecia no
  // proximo evento de turno.
  it('P03: revelar um token que ja esta na ordem reenvia os turnos ao jogador', () => {
    const room = table();
    const scene = room.activeScene()!;
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');
    addTurnEntries(
      ctxOf(room, gm),
      { entries: [{ tokenId: 'tok-cultista', sheetId: null, playerId: null, name: 'Cultista' }] },
      vi.fn(),
    );

    const turnsOf = (sock: FakeSocket) =>
      sock.received.filter(([ev]) => ev === 'turns:patch').map(([, turns]) => (turns as { entries: { name: string }[] }).entries.map((e) => e.name));
    expect(turnsOf(alice).at(-1)).not.toContain('Cultista');
    const before = turnsOf(alice).length;

    const trigger = createTrigger(
      { kind: 'rect', x: 0, y: 0, width: 70, height: 70 },
      { actions: [{ id: 'act-revela', type: 'reveal', tokenId: 'tok-cultista' }] },
    );
    scene.triggers.push(trigger);
    fireTrigger(room, scene, trigger, scene.tokens[0], 'alice');

    expect(scene.tokens.find((t) => t.id === 'tok-cultista')?.visibility).toBe('visible');
    expect(turnsOf(alice).length).toBeGreaterThan(before);
    expect(turnsOf(alice).at(-1)).toContain('Cultista');
  });
});
