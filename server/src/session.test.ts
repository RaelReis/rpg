import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultTemplate,
  createScene,
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

import { hashPassword, hashToken } from './auth.js';
import { bindIo, type TypedServer, type TypedSocket } from './broadcast.js';
import { prisma } from './db.js';
import { handleJoin } from './handlers/session.js';
import { LIMITS } from './limits.js';
import { Room, rooms } from './room.js';

/*
 * P06. A volta do mestre pela senha.
 *
 * A retomada por nome so existia para jogador: com `gmPassword` informado o
 * handler pulava o bloco de nome repetido e ia direto para o `create`. Cada
 * entrada pela senha (outro aparelho, navegador limpo) deixava mais um mestre
 * desconectado na presenca, contando para o teto de jogadores da mesa.
 */

const PASSWORD = 'senha-do-mestre';

let socketMap: Map<string, TypedSocket>;
const created: Room[] = [];

beforeEach(async () => {
  socketMap = new Map();
  bindIo({ sockets: { sockets: socketMap } } as unknown as TypedServer);
  vi.mocked(prisma.table.findUnique).mockResolvedValue({ gmPasswordHash: await hashPassword(PASSWORD) } as never);
});

afterEach(() => {
  for (const room of created.splice(0)) room.cancelPendingWrites();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function table(players: Player[] = []): Room {
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
    players,
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
  vi.spyOn(rooms, 'loadByCode').mockResolvedValue(room);
  vi.spyOn(rooms, 'get').mockReturnValue(room);
  return room;
}

function person(id: string, name: string, role: Player['role'], connected: boolean): Player {
  return { id, name, role, color: '#ffffff', connected, lastSeen: 0, sheetId: null };
}

/** Socket de quem ainda nao entrou: sem mesa nem papel. */
function visitor(id: string): { socket: TypedSocket; received: unknown[][] } {
  const received: unknown[][] = [];
  const socket = {
    id,
    connected: true,
    data: {},
    emit: (...args: unknown[]) => {
      received.push(args);
      return true;
    },
    join: vi.fn(),
    leave: vi.fn(),
    disconnect: vi.fn(),
    nsp: { sockets: socketMap },
  } as unknown as TypedSocket;
  socketMap.set(id, socket);
  return { socket, received };
}

async function joinAsGm(socket: TypedSocket, name: string, gmPassword = PASSWORD) {
  const ack = vi.fn();
  await handleJoin(socket, { code: 'mesa', name, gmPassword }, ack);
  return ack.mock.calls[0][0];
}

const gms = (room: Room) => room.state.players.filter((p) => p.role === 'GM');

describe('P06: mestre que volta pela senha', () => {
  it('retoma o mestre desconectado de mesmo nome, com token novo, sem criar outro', async () => {
    const room = table();

    const first = await joinAsGm(visitor('sock-1').socket, 'Rafael');
    expect(first.ok).toBe(true);
    const original = first.data.session;

    // Navegador limpo ou outro aparelho: a sessao se perdeu e o mestre caiu.
    room.sockets.clear();
    gms(room)[0].connected = false;

    const second = await joinAsGm(visitor('sock-2').socket, '  rafaél ');
    expect(second.ok).toBe(true);
    const session = second.data.session;

    expect(session.playerId).toBe(original.playerId);
    expect(session.role).toBe('GM');
    expect(session.token).not.toBe(original.token);
    expect(gms(room)).toHaveLength(1);
    expect(gms(room)[0].connected).toBe(true);
    expect(prisma.player.create).toHaveBeenCalledTimes(1);
    // O token antigo deixa de valer: o hash gravado passa a ser o do novo.
    expect(prisma.player.update).toHaveBeenCalledWith({
      where: { id: original.playerId },
      data: { tokenHash: hashToken(session.token) },
    });
  });

  it('nao toma o mestre de mesmo nome que esta conectado', async () => {
    const room = table([person('gm-1', 'Rafael', 'GM', true)]);

    const res = await joinAsGm(visitor('sock-2').socket, 'Rafael');

    expect(res.ok).toBe(true);
    expect(res.data.session.playerId).not.toBe('gm-1');
    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(gms(room)).toHaveLength(2);
  });

  it('senha errada nao retoma ninguem', async () => {
    const room = table([person('gm-1', 'Rafael', 'GM', false)]);

    const res = await joinAsGm(visitor('sock-2').socket, 'Rafael', 'chute');

    expect(res.ok).toBe(false);
    expect(prisma.player.update).not.toHaveBeenCalled();
    expect(room.player('gm-1')!.connected).toBe(false);
  });

  it('nao toma um jogador desconectado que tenha o mesmo nome', async () => {
    const room = table([person('ply-1', 'Rafael', 'PLAYER', false)]);

    const res = await joinAsGm(visitor('sock-2').socket, 'Rafael');

    expect(res.ok).toBe(true);
    expect(res.data.session.playerId).not.toBe('ply-1');
    expect(res.data.session.role).toBe('GM');
    expect(room.player('ply-1')).toMatchObject({ role: 'PLAYER', connected: false });
  });

  it('retoma mesmo com a mesa cheia, porque nao cria ninguem', async () => {
    const crowd = Array.from({ length: LIMITS.players - 1 }, (_, i) => person(`ply-${i}`, `Jogador ${i}`, 'PLAYER', false));
    const room = table([person('gm-1', 'Rafael', 'GM', false), ...crowd]);

    const res = await joinAsGm(visitor('sock-2').socket, 'Rafael');

    expect(res.ok).toBe(true);
    expect(res.data.session.playerId).toBe('gm-1');
    expect(room.state.players).toHaveLength(LIMITS.players);
  });
});
