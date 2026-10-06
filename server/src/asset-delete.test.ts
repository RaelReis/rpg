import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultTemplate, createScene, DEFAULT_SETTINGS, DEFAULT_TURNS, type Asset, type BoardItem, type TableState } from '@rpg/shared';

vi.mock('./db.js', () => ({
  prisma: { table: { update: vi.fn() } },
  toJson: JSON.stringify, fromJson: (s: string) => JSON.parse(s), withRetry: (fn: () => unknown) => fn(),
}));
// Apagar o arquivo em disco nao e o que se testa aqui: so o que sobra no estado.
vi.mock('./uploads.js', () => ({ deleteAssetFiles: vi.fn() }));
import { prisma } from './db.js';
import { bindIo, type TypedServer, type TypedSocket } from './broadcast.js';
import { stateForViewer } from './filter.js';
import type { Ctx } from './handlers/context.js';
import { deleteAsset } from './handlers/play.js';
import { Room } from './room.js';

const created: Room[] = [];
afterEach(() => { for (const room of created.splice(0)) room.cancelPendingWrites(); vi.clearAllMocks(); });

function asset(id: string): Asset {
  return { id, kind: 'map', url: `/uploads/${id}.png`, thumbUrl: null, originalName: id, mime: 'image/png', width: 1, height: 1, size: 10, createdAt: 0, uploadedBy: 'gm' };
}

function pinned(id: string, assetId: string | null, text = ''): BoardItem {
  return { id, kind: assetId ? 'image' : 'note', x: 0, y: 0, text, color: '#f3e3a1', assetId, handoutId: null, authorId: 'p', updatedAt: 0 };
}

function fixture(): { room: Room; ctx: Ctx } {
  const scene = createScene({ id: 'scene' });
  const state: TableState = { id: 'table', code: 'table', name: 'table', activeSceneId: scene.id, settings: { ...DEFAULT_SETTINGS }, sheetTemplate: createDefaultTemplate(), turns: structuredClone(DEFAULT_TURNS), scenes: [scene], sheets: [], players: [], assets: [asset('apagada'), asset('outra')], handouts: [], chat: [], sceneCards: [], screenEffects: [], presentedCard: null, triggerLog: [], board: { locked: false, items: [], threads: [] }, createdAt: 0, updatedAt: 0 };
  const room = new Room(state);
  created.push(room);
  bindIo({ sockets: { sockets: new Map() } } as unknown as TypedServer);
  return { room, ctx: { room, viewer: { role: 'GM', playerId: 'gm' }, socket: {} as TypedSocket } as Ctx };
}

describe('apagar imagem', () => {
  it('tira do quadro o cartao de imagem sem legenda, com os fios dele, e mantem o que tem legenda', async () => {
    const { room, ctx } = fixture();
    room.state.board.items.push(
      pinned('vazio', 'apagada'),
      pinned('legendado', 'apagada', 'A faca do crime'),
      pinned('intacto', 'outra'),
      pinned('nota', null, 'Quem estava na taverna?'),
    );
    room.state.board.threads.push(
      { id: 'fio-orfao', from: 'vazio', to: 'nota', color: '#c0392b', authorId: 'p' },
      { id: 'fio-vivo', from: 'legendado', to: 'nota', color: '#c0392b', authorId: 'p' },
    );

    const ack = vi.fn();
    await deleteAsset(ctx, { assetId: 'apagada' }, ack);

    expect(ack.mock.calls[0][0].ok).toBe(true);
    expect(room.state.board.items.map((i) => i.id)).toEqual(['legendado', 'intacto', 'nota']);
    expect(room.state.board.items.find((i) => i.id === 'legendado')).toMatchObject({ assetId: null, text: 'A faca do crime' });
    expect(room.state.board.items.find((i) => i.id === 'intacto')!.assetId).toBe('outra');
    expect(room.state.board.threads.map((t) => t.id)).toEqual(['fio-vivo']);

    // O quadro limpo tem de chegar ao banco, senao a referencia morta volta no proximo carregamento.
    vi.mocked(prisma.table.update).mockResolvedValue({} as never);
    await room.flush();
    const written = JSON.stringify(vi.mocked(prisma.table.update).mock.calls);
    expect(written).toContain('legendado');
    expect(written).not.toContain('apagada');
  });

  it('zera a imagem das cartelas e da cartela que esta na tela', async () => {
    const { room, ctx } = fixture();
    room.state.sceneCards.push(
      { id: 'crd1', title: 'Capitulo 1', subtitle: '', assetId: 'apagada', createdAt: 0, updatedAt: 0 },
      { id: 'crd2', title: 'Capitulo 2', subtitle: '', assetId: 'outra', createdAt: 0, updatedAt: 0 },
    );
    room.state.presentedCard = { cardId: 'crd1', title: 'Capitulo 1', subtitle: '', assetId: 'apagada', durationMs: null, recipients: null };

    await deleteAsset(ctx, { assetId: 'apagada' }, vi.fn());

    expect(room.state.sceneCards.map((c) => c.assetId)).toEqual([null, 'outra']);
    expect(room.state.presentedCard).toMatchObject({ cardId: 'crd1', title: 'Capitulo 1', assetId: null });
    expect(stateForViewer(room, { playerId: 'p', role: 'PLAYER' }).presentedCard?.assetId).toBeNull();
  });
});
