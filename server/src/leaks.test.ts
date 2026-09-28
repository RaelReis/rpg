import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultTemplate,
  createEffect,
  createScene,
  createSheetValues,
  createTile,
  createToken,
  createTrigger,
  createWall,
  DEFAULT_SETTINGS,
  DEFAULT_TURNS,
  type Player,
  type Sheet,
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
import { stateForViewer } from './filter.js';
import type { Ctx } from './handlers/context.js';
import { createBoardItem, updateBoardItem } from './handlers/board.js';
import { updateHandout } from './handlers/handouts.js';
import {
  createEffectHandler,
  createTileHandler,
  createTokenHandler,
  createWallHandler,
  deleteTile,
  deleteToken,
  moveToken,
  paintFog,
  updateToken,
} from './handlers/map.js';
import { createTriggerHandler } from './handlers/triggers.js';
import { activateScene } from './handlers/scene.js';
import { addTurnEntries, ensurePartyInTurns, kickPlayer, pingMap } from './handlers/play.js';
import { createSheet, deleteSheet, updateSheet } from './handlers/sheets.js';
import { handleJoin } from './handlers/session.js';
import { Room, rooms } from './room.js';

/*
 * Caca a vazamentos em forma de teste.
 *
 * O relatorio de QA (qa/relatorio-usabilidade.md) achou os vazamentos em
 * caminhos secundarios — arrastar a ficha para a ordem, compartilhar um
 * material com outra pessoa —, e nao no estado inicial, que ja era filtrado.
 * Por isso aqui cada fluxo de risco roda contra sockets falsos e o teste olha
 * TUDO o que o jogador recebeu, nao so o `stateForViewer`.
 *
 * Todo segredo leva o marcador `SEGREDO` no id ou no texto: basta ele aparecer
 * no trafego serializado para o teste acusar, sem depender do formato da
 * mensagem.
 *
 * Os achados ainda abertos usam `it.fails`: a suite segue verde (o build roda
 * os testes) e o teste passa a FALHAR quando o bug for corrigido — o aviso
 * para trocar `it.fails` por `it` junto da correcao.
 */

const SECRET = /SEGREDO/;

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
  return { id, name: id, role, color: '#ffffff', connected: true, lastSeen: 0, sheetId: `sht-${id}` };
}

function sheetOf(id: string, owner: string | null, template = createDefaultTemplate()): Sheet {
  return {
    id,
    name: id,
    ownerPlayerId: owner,
    portraitAssetId: null,
    bodyAssetId: null,
    values: createSheetValues(template),
    sharedWithParty: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Mesa com mestre, Alice e Bruno, neblina por visao e escuridao total: a Alice
 * so enxerga as celulas em volta do proprio token, no canto (0,0).
 */
function table(): Room {
  const template = createDefaultTemplate();
  const scene = createScene({
    id: 'scn-ativa',
    globalLight: 0,
    fog: { mode: 'vision' } as never,
    tokens: [
      createToken({ id: 'tok-alice', ownerPlayerId: 'alice', sheetId: 'sht-alice', x: 0, y: 0, visionRadius: 2 }),
      createToken({ id: 'tok-bruno', ownerPlayerId: 'bruno', sheetId: 'sht-bruno', x: 1400, y: 0, visionRadius: 2 }),
    ],
  });
  const state: TableState = {
    id: 'mesa',
    code: 'mesa',
    name: 'mesa',
    activeSceneId: scene.id,
    settings: { ...DEFAULT_SETTINGS, strictVision: true },
    sheetTemplate: template,
    turns: structuredClone(DEFAULT_TURNS),
    scenes: [scene],
    sheets: [sheetOf('sht-alice', 'alice', template), sheetOf('sht-bruno', 'bruno', template)],
    players: [player('mestre', 'GM'), player('alice'), player('bruno')],
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
  state.players[0].sheetId = null;
  const room = new Room(state);
  created.push(room);
  return room;
}

/** Socket falso autenticado na mesa, que guarda tudo o que recebe. */
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

/** Tudo o que o jogador recebeu, mais o estado completo que ele receberia agora. */
function traffic(room: Room, sock: FakeSocket): string {
  return JSON.stringify(sock.received) + JSON.stringify(stateForViewer(room, sock.socket.data.viewer));
}

function secretsIn(text: string): string[] {
  return [...new Set(text.match(/SEGREDO[\w-]*/g) ?? [])];
}

describe('vazamentos: o que ja esta protegido', () => {
  it('o estado do jogador nao carrega nenhum segredo de preparacao', () => {
    const room = table();
    const scene = room.activeScene()!;
    const near = { x: 70, y: 0 };

    // Tokens escondidos por tres caminhos diferentes, todos dentro da visao da Alice.
    scene.tokens.push(createToken({ id: 'SEGREDO-oculto', name: 'SEGREDO-oculto', visibility: 'hidden', ...near }));
    scene.tokens.push(createToken({ id: 'SEGREDO-exclusivo', name: 'SEGREDO-exclusivo', gmOnly: true, ...near }));
    scene.tokens.push(createToken({ id: 'SEGREDO-alucinacao', name: 'SEGREDO-alucinacao', visibleTo: ['bruno'], ...near }));
    // Paredes comuns e porta secreta nao vao com a visao estrita.
    scene.walls.push(createWall({ id: 'SEGREDO-parede', x1: 140, y1: 0, x2: 140, y2: 280 }));
    scene.walls.push(createWall({ id: 'SEGREDO-porta', x1: 0, y1: 140, x2: 70, y2: 140, door: true, hidden: true }));
    scene.triggers.push(createTrigger({ kind: 'rect', x: 0, y: 0, width: 70, height: 70 }, { id: 'SEGREDO-gatilho', name: 'SEGREDO-gatilho' }));

    room.state.sheetTemplate.fields.push({ ...room.state.sheetTemplate.fields[0], id: 'SEGREDO-campo', gmOnly: true });
    room.sheet('sht-alice')!.values['SEGREDO-campo'] = 'SEGREDO-valor';

    room.state.handouts.push({
      id: 'SEGREDO-material',
      title: 'SEGREDO-titulo',
      text: '',
      assetId: null,
      sharedWith: [],
      sharedWithAll: false,
      createdAt: 0,
      updatedAt: 0,
    });
    room.state.scenes.push(createScene({ id: 'SEGREDO-cena', name: 'SEGREDO-cena' }));
    room.state.sceneCards.push({ id: 'SEGREDO-cartela', title: 'SEGREDO-cartela', subtitle: '', assetId: null, createdAt: 0, updatedAt: 0 });
    room.state.triggerLog.push({
      id: 'SEGREDO-disparo',
      at: 0,
      sceneId: scene.id,
      triggerId: 'SEGREDO-gatilho',
      triggerName: 'SEGREDO-gatilho',
      tokenId: 'tok-bruno',
      tokenName: 'bruno',
      playerName: 'bruno',
    });
    room.state.chat.push({
      id: 'msg',
      playerId: 'bruno',
      authorName: 'bruno',
      authorColor: '#fff',
      text: 'SEGREDO-sussurro',
      roll: null,
      rollLabel: null,
      whisper: true,
      createdAt: 0,
    });

    const alice = connect(room, 'alice');
    expect(secretsIn(traffic(room, alice))).toEqual([]);
  });

  it('apagar uma alucinacao nao avisa quem nunca a percebeu', () => {
    const room = table();
    room.activeScene()!.tokens.push(createToken({ id: 'SEGREDO-fantasma', visibleTo: ['bruno'], x: 70, y: 0 }));
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');

    deleteToken(ctxOf(room, gm), { sceneId: 'scn-ativa', tokenId: 'SEGREDO-fantasma' }, vi.fn());

    expect(secretsIn(JSON.stringify(alice.received))).toEqual([]);
  });
});

describe('vazamentos: achados do relatorio de QA', () => {
  // Q-002. Arrastar a ficha para a faixa de turnos manda o mesmo payload que
  // `addSheet` do TurnBar, sem `hiddenFromPlayers`. A vez do NPC oculto ia
  // aos jogadores com nome e id do token; agora o servidor le a ocultacao do
  // token na hora do envio.
  it('Q-002: NPC oculto posto na ordem pela ficha nao chega aos jogadores', () => {
    const room = table();
    const scene = room.activeScene()!;
    room.state.sheets.push(sheetOf('sht-SEGREDO-guarda', null));
    scene.tokens.push(
      createToken({ id: 'tok-SEGREDO-guarda', sheetId: 'sht-SEGREDO-guarda', name: 'SEGREDO-guarda', visibility: 'hidden', x: 700, y: 700 }),
    );
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');

    addTurnEntries(
      ctxOf(room, gm),
      { entries: [{ sheetId: 'sht-SEGREDO-guarda', tokenId: 'tok-SEGREDO-guarda', playerId: null, name: 'SEGREDO-guarda' }] },
      vi.fn(),
    );

    expect(secretsIn(traffic(room, alice))).toEqual([]);
  });

  it('Q-002: revelar o token revela a vez; esconder um token ja na ordem esconde a vez', () => {
    const room = table();
    const scene = room.activeScene()!;
    scene.tokens.push(createToken({ id: 'tok-cultista', name: 'Cultista', visibility: 'hidden', x: 700, y: 700 }));
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');
    addTurnEntries(ctxOf(room, gm), { entries: [{ tokenId: 'tok-cultista', sheetId: null, playerId: null, name: 'Cultista' }] }, vi.fn());

    const lastTurns = () =>
      alice.received.filter(([ev]) => ev === 'turns:patch').at(-1)?.[1] as { entries: { name: string }[] } | undefined;
    expect(lastTurns()?.entries.map((e) => e.name)).not.toContain('Cultista');

    updateToken(ctxOf(room, gm), { sceneId: scene.id, tokenId: 'tok-cultista', patch: { visibility: 'visible' } }, vi.fn());
    expect(lastTurns()?.entries.map((e) => e.name)).toContain('Cultista');

    updateToken(ctxOf(room, gm), { sceneId: scene.id, tokenId: 'tok-cultista', patch: { gmOnly: true } }, vi.fn());
    expect(lastTurns()?.entries.map((e) => e.name)).not.toContain('Cultista');
  });

  // Q-003. O filtro de cena so tirava tiles `gmOnly`: um bau numa sala que
  // ninguem viu e um tile que bloqueia a visao (a mesma planta que as paredes
  // escondem) chegavam inteiros ao jogador.
  it('Q-003: tiles fora da visao e tiles que bloqueiam a visao nao chegam ao jogador', () => {
    const room = table();
    const scene = room.activeScene()!;
    scene.tiles.push(createTile({ id: 'SEGREDO-bau', x: 1400, y: 1050, width: 70, height: 70 }));
    scene.tiles.push(createTile({ id: 'SEGREDO-estante', x: 700, y: 700, width: 70, height: 210, blocksVision: true }));
    const alice = connect(room, 'alice');

    expect(secretsIn(traffic(room, alice))).toEqual([]);
  });

  it('Q-003: o tile entra quando o jogador passa a ve-lo, e o que bloqueia a visao nunca entra', () => {
    const room = table();
    const scene = room.activeScene()!;
    scene.tiles.push(createTile({ id: 'tile-bau', x: 700, y: 0, width: 70, height: 70 }));
    scene.tiles.push(createTile({ id: 'SEGREDO-estante', x: 840, y: 0, width: 70, height: 70, blocksVision: true }));
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');
    const received = () => JSON.stringify(alice.received);

    expect(received()).not.toContain('tile-bau');
    // O mestre leva a Alice para perto do bau.
    moveToken(ctxOf(room, gm), { sceneId: scene.id, tokenId: 'tok-alice', x: 560, y: 0 }, vi.fn());
    expect(received()).toContain('tile-bau');
    expect(secretsIn(received())).toEqual([]);
  });

  it('Q-003: efeito acima da neblina so vai com a ancora iluminada, e sai quando ela escurece', () => {
    const room = table();
    const scene = room.activeScene()!;
    scene.effects.push(createEffect({ id: 'efeito-runas', anchor: 'free', x: 735, y: 35, layer: 4 }));
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');
    expect(JSON.stringify(stateForViewer(room, alice.socket.data.viewer))).not.toContain('efeito-runas');

    moveToken(ctxOf(room, gm), { sceneId: scene.id, tokenId: 'tok-alice', x: 630, y: 0 }, vi.fn());
    const patches = () => alice.received.filter(([ev]) => ev === 'effects:patch').map(([, p]) => p);
    expect(JSON.stringify(patches())).toContain('efeito-runas');

    // Afastada, a ancora fica no escuro: explorada nao basta acima da neblina.
    moveToken(ctxOf(room, gm), { sceneId: scene.id, tokenId: 'tok-alice', x: 0, y: 0 }, vi.fn());
    expect(patches().at(-1)).toMatchObject({ remove: ['efeito-runas'] });
  });

  it('apagar um tile exclusivo do mestre nao manda o id a quem nunca o recebeu', () => {
    const room = table();
    room.activeScene()!.tiles.push(createTile({ id: 'SEGREDO-tile-mestre', x: 0, y: 0, gmOnly: true }));
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');
    deleteTile(ctxOf(room, gm), { sceneId: 'scn-ativa', tileId: 'SEGREDO-tile-mestre' }, vi.fn());
    expect(secretsIn(JSON.stringify(alice.received))).toEqual([]);
  });

  it('com a neblina desligada, o cenario inteiro continua indo ao jogador', () => {
    const room = table();
    const scene = room.activeScene()!;
    scene.fog.mode = 'off';
    scene.tiles.push(createTile({ id: 'tile-longe', x: 1400, y: 1050 }));
    const alice = connect(room, 'alice');
    expect(JSON.stringify(stateForViewer(room, alice.socket.data.viewer))).toContain('tile-longe');
  });

  // Q-004. Mudar o compartilhamento de um material mandava `remove` com o id
  // a todos os que nao veem — inclusive a quem nunca teve acesso.
  it('Q-004: compartilhar um material com o Bruno nao manda o id dele a Alice', () => {
    const room = table();
    room.state.handouts.push({
      id: 'SEGREDO-carta',
      title: 'carta',
      text: '',
      assetId: null,
      sharedWith: [],
      sharedWithAll: false,
      createdAt: 0,
      updatedAt: 0,
    });
    const gm = connect(room, 'mestre');
    connect(room, 'bruno');
    const alice = connect(room, 'alice');

    updateHandout(ctxOf(room, gm), { handoutId: 'SEGREDO-carta', patch: { sharedWith: ['bruno'] } }, vi.fn());
    updateHandout(ctxOf(room, gm), { handoutId: 'SEGREDO-carta', patch: { sharedWith: [] } }, vi.fn());

    expect(secretsIn(JSON.stringify(alice.received))).toEqual([]);
  });

  // D3. O "exclusivo do mestre" deixou de existir como campo: mesa gravada
  // antes da unificacao tem de continuar escondendo o token e a luz dele.
  it('token gravado como exclusivo do mestre segue fora do payload do jogador', () => {
    const room = table();
    const scene = room.activeScene()!;
    scene.fog.mode = 'off';
    const loaded = createScene({
      ...scene,
      tokens: [...scene.tokens, { id: 'SEGREDO-legado', name: 'x', layer: 3, lightRadius: 6, gmOnly: true } as never],
    });
    room.state.scenes = [loaded];
    const alice = connect(room, 'alice');
    const legacy = loaded.tokens.find((t) => t.id === 'SEGREDO-legado')!;
    expect(legacy.visibility).toBe('hidden');
    expect(legacy.lightRadius).toBe(0);
    expect(secretsIn(JSON.stringify(stateForViewer(room, alice.socket.data.viewer)))).toEqual([]);
  });

  // Q-032. O cartao de material indisponivel escondia titulo, imagem e id, mas
  // a legenda que o mestre escreveu nele — em geral, sobre o material — ia
  // inteira a todos.
  it('Q-032: legenda de cartao de material fechado nao chega a quem nao o ve', () => {
    const room = table();
    room.state.handouts.push({
      id: 'hnd-carta',
      title: 'carta',
      text: '',
      assetId: null,
      sharedWith: ['bruno'],
      sharedWithAll: false,
      createdAt: 0,
      updatedAt: 0,
    });
    const gm = connect(room, 'mestre');
    const bruno = connect(room, 'bruno');
    const alice = connect(room, 'alice');

    const ack = vi.fn();
    createBoardItem(ctxOf(room, gm), { item: { kind: 'handout', handoutId: 'hnd-carta', text: 'legenda SEGREDO' } }, ack);
    const itemId = ack.mock.calls[0][0].data.id as string;
    expect(JSON.stringify(bruno.received)).toContain('legenda SEGREDO');
    expect(secretsIn(JSON.stringify(alice.received))).toEqual([]);
    expect(secretsIn(JSON.stringify(stateForViewer(room, alice.socket.data.viewer)))).toEqual([]);

    // E quem nao ve o material nao reescreve, as cegas, a legenda do mestre.
    updateBoardItem(ctxOf(room, alice), { itemId, patch: { text: 'apagado' } });
    expect(room.state.board.items[0].text).toBe('legenda SEGREDO');
  });
});

describe('reproducoes do relatorio de QA', () => {
  // Q-005. O novato que fechava a janela de imagens perdia a sessao; ao entrar
  // de novo com o mesmo nome, ganhava outro jogador, outra ficha, outro token
  // e outra vez. Agora o servidor pergunta se e a mesma pessoa e, confirmado,
  // devolve o personagem com um token novo.
  it('Q-005: reentrar com o mesmo nome pergunta e retoma, sem duplicar', async () => {
    const room = table();
    room.state.players = room.state.players.filter((p) => p.id === 'mestre');
    room.state.sheets = [];
    room.activeScene()!.tokens = [];
    vi.spyOn(rooms, 'loadByCode').mockResolvedValue(room);
    const gm = connect(room, 'mestre');

    const first = connect(room, 'ninguem');
    const firstAck = vi.fn();
    await handleJoin(first.socket, { code: 'mesa', name: 'Alice' }, firstAck);
    const original = firstAck.mock.calls[0][0].data.session;

    // A aba fecha: o jogador fica desconectado, a sessao se perde no navegador.
    room.sockets.delete(first.socket.id);
    for (const p of room.state.players) if (p.name === 'Alice') p.connected = false;

    // Sem confirmar, nada e criado: o cliente recebe a pergunta.
    const second = connect(room, 'ninguem-2');
    const askAck = vi.fn();
    await handleJoin(second.socket, { code: 'mesa', name: '  alíce ' }, askAck);
    expect(askAck.mock.calls[0][0]).toMatchObject({ ok: false, code: 'NAME_TAKEN_OFFLINE' });

    // Confirmado, volta o mesmo jogador, com outro token de sessao.
    const reclaimAck = vi.fn();
    await handleJoin(second.socket, { code: 'mesa', name: 'Alice', reclaim: true }, reclaimAck);
    const reclaimed = reclaimAck.mock.calls[0][0].data.session;
    expect(reclaimed.playerId).toBe(original.playerId);
    expect(reclaimed.token).not.toBe(original.token);

    expect(room.state.players.filter((p) => p.name === 'Alice')).toHaveLength(1);
    expect(room.state.sheets.filter((s) => s.name === 'Alice')).toHaveLength(1);
    expect(room.activeScene()!.tokens.filter((t) => t.name === 'Alice')).toHaveLength(1);
    // O mestre fica sabendo que o personagem foi retomado por outro acesso.
    expect(JSON.stringify(gm.received)).toContain('retomou o personagem');
  });

  it('Q-005: nome de alguem conectado agora e recusado, sem criar nada', async () => {
    const room = table();
    vi.spyOn(rooms, 'loadByCode').mockResolvedValue(room);
    const other = connect(room, 'visitante');
    const ack = vi.fn();
    await handleJoin(other.socket, { code: 'mesa', name: 'ALICE' }, ack);
    expect(ack.mock.calls[0][0]).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
    expect(room.state.players).toHaveLength(3);
  });

  // Q-007. `kickPlayer` tirava as vezes do jogador, mas o token dele continuava
  // com `ownerPlayerId` apontando para quem saiu — e `ensurePartyInTurns`
  // recriava a vez a partir desse token. Foi assim que a "Alice fantasma"
  // voltou para a ordem durante o teste.
  it('Q-007: jogador removido nao volta para a ordem nem deixa token com dono fantasma', async () => {
    const room = table();
    ensurePartyInTurns(room);
    expect(room.state.turns.entries.some((e) => e.playerId === 'bruno')).toBe(true);
    const gm = connect(room, 'mestre');
    connect(room, 'bruno');

    await kickPlayer(ctxOf(room, gm), { playerId: 'bruno' }, vi.fn());
    ensurePartyInTurns(room);

    expect(room.state.turns.entries.filter((e) => e.playerId === 'bruno' || e.tokenId === 'tok-bruno')).toEqual([]);
    expect(room.activeScene()!.tokens.filter((t) => t.ownerPlayerId === 'bruno')).toEqual([]);
  });

  it('Q-007: remover o jogador leva a ficha e o token dele; o familiar fica, sem dono', async () => {
    const room = table();
    room.activeScene()!.tokens.push(createToken({ id: 'tok-corvo', name: 'Corvo', ownerPlayerId: 'bruno', x: 1470, y: 0 }));
    ensurePartyInTurns(room);
    const gm = connect(room, 'mestre');

    await kickPlayer(ctxOf(room, gm), { playerId: 'bruno' }, vi.fn());

    expect(room.sheet('sht-bruno')).toBeUndefined();
    expect(room.activeScene()!.tokens.find((t) => t.id === 'tok-bruno')).toBeUndefined();
    expect(room.activeScene()!.tokens.find((t) => t.id === 'tok-corvo')?.ownerPlayerId).toBeNull();
  });

  it('Q-007: apagar a ficha leva os tokens dela e a vez; apagar o token leva a vez', () => {
    const room = table();
    ensurePartyInTurns(room);
    const gm = connect(room, 'mestre');
    const vezes = () => room.state.turns.entries.map((e) => e.tokenId);
    expect(vezes()).toEqual(expect.arrayContaining(['tok-alice', 'tok-bruno']));

    deleteSheet(ctxOf(room, gm), { sheetId: 'sht-bruno' }, vi.fn());
    expect(room.activeScene()!.tokens.find((t) => t.id === 'tok-bruno')).toBeUndefined();
    expect(vezes()).not.toContain('tok-bruno');

    deleteToken(ctxOf(room, gm), { sceneId: 'scn-ativa', tokenId: 'tok-alice' }, vi.fn());
    expect(vezes()).not.toContain('tok-alice');
  });
});

describe('grupo na cena nova e NPC que nasce oculto', () => {
  it('Q-009: ativar levando o grupo cria os tokens e aponta as vezes para eles', () => {
    const room = table();
    ensurePartyInTurns(room);
    room.state.scenes.push(createScene({ id: 'scn-porao' }));
    const gm = connect(room, 'mestre');

    activateScene(ctxOf(room, gm), { sceneId: 'scn-porao', bringParty: true }, vi.fn());

    const porao = room.scene('scn-porao')!;
    const alice = porao.tokens.find((t) => t.sheetId === 'sht-alice');
    expect(alice?.ownerPlayerId).toBe('alice');
    expect(porao.tokens.find((t) => t.sheetId === 'sht-bruno')).toBeDefined();
    // Dois tokens, em celulas diferentes.
    expect(new Set(porao.tokens.map((t) => `${t.x},${t.y}`)).size).toBe(2);
    expect(room.state.turns.entries.find((e) => e.sheetId === 'sht-alice')?.tokenId).toBe(alice?.id);
  });

  it('Q-009: sem levar o grupo, a cena abre sem os personagens', () => {
    const room = table();
    room.state.scenes.push(createScene({ id: 'scn-sonho' }));
    const gm = connect(room, 'mestre');

    activateScene(ctxOf(room, gm), { sceneId: 'scn-sonho' }, vi.fn());

    expect(room.scene('scn-sonho')!.tokens).toEqual([]);
  });

  it('Q-020: NPC criado com a mesa assistindo nasce oculto, e o mestre e avisado', async () => {
    const room = table();
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');

    const ack = vi.fn();
    createTokenHandler(ctxOf(room, gm), { sceneId: 'scn-ativa', token: { name: 'SEGREDO-monstro', x: 70, y: 0 } }, ack);
    expect(ack.mock.calls[0][0].data.visibility).toBe('hidden');
    expect(JSON.stringify(gm.received)).toContain('entrou oculto');
    expect(secretsIn(JSON.stringify(alice.received))).toEqual([]);

    await createSheet(ctxOf(room, gm), { name: 'SEGREDO-capanga' }, vi.fn());
    const capanga = room.activeScene()!.tokens.find((t) => t.name === 'SEGREDO-capanga');
    expect(capanga?.visibility).toBe('hidden');
    expect(secretsIn(JSON.stringify(alice.received))).toEqual([]);
  });

  it('Q-020: sem jogador conectado, ou com visibilidade pedida, nasce como pedido', () => {
    const room = table();
    const gm = connect(room, 'mestre');
    const ack = vi.fn();
    createTokenHandler(ctxOf(room, gm), { sceneId: 'scn-ativa', token: { name: 'Aliado', visibility: 'visible' } }, ack);
    expect(ack.mock.calls[0][0].data.visibility).toBe('visible');

    for (const p of room.state.players) if (p.role === 'PLAYER') p.connected = false;
    createTokenHandler(ctxOf(room, gm), { sceneId: 'scn-ativa', token: { name: 'Preparo' } }, ack);
    expect(ack.mock.calls[1][0].data.visibility).toBe('visible');
  });
});

describe('fase 3: retratos do grupo e nome da ficha', () => {
  it('Q-017: o PV do colega chega mesmo com o token dele fora da visao; o do NPC nao', () => {
    const room = table();
    // Bruno esta em (1400,0), fora da visao da Alice no escuro total.
    room.state.sheets.push(sheetOf('sht-SEGREDO-npc', null));
    room.activeScene()!.tokens.push(createToken({ sheetId: 'sht-SEGREDO-npc', x: 1400, y: 700, bars: [{ fieldId: 'hp', color: '#f00' }] }));
    const state = stateForViewer(room, { playerId: 'alice', role: 'PLAYER' });
    const bruno = state.sheets.find((s) => s.id === 'sht-bruno');
    expect(bruno?.values.hp).toBeDefined();
    // So as resistencias: nada da ficha do colega alem delas.
    expect(Object.keys(bruno?.values ?? {}).sort()).toEqual(['energy', 'hp']);
    expect(secretsIn(JSON.stringify(state.sheets))).toEqual([]);
  });

  it('Q-019: renomear a ficha renomeia o token e a vez; token renomeado a parte fica', () => {
    const room = table();
    ensurePartyInTurns(room);
    const scene = room.activeScene()!;
    scene.tokens.find((t) => t.id === 'tok-alice')!.name = 'sht-alice';
    scene.tokens.push(createToken({ id: 'tok-alice-2', sheetId: 'sht-alice', name: 'Alice disfarcada' }));
    const gm = connect(room, 'mestre');

    updateSheet(ctxOf(room, gm), { sheetId: 'sht-alice', name: 'Alice Moreau' }, vi.fn());

    expect(scene.tokens.find((t) => t.id === 'tok-alice')?.name).toBe('Alice Moreau');
    expect(scene.tokens.find((t) => t.id === 'tok-alice-2')?.name).toBe('Alice disfarcada');
    expect(room.state.turns.entries.find((e) => e.sheetId === 'sht-alice')?.name).toBe('Alice Moreau');
  });
});

describe('vez de NPC oculto em outra cena', () => {
  it('a vez sem token, de ficha cujos tokens estao todos ocultos, nao chega ao jogador', () => {
    const room = table();
    room.state.sheets.push(sheetOf('sht-SEGREDO-vilao', null));
    const outra = createScene({ id: 'scn-outra' });
    outra.tokens.push(createToken({ sheetId: 'sht-SEGREDO-vilao', name: 'SEGREDO-vilao', visibility: 'hidden' }));
    room.state.scenes.push(outra);
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');

    // Como o cliente faz ao arrastar a ficha na cena ativa, onde o NPC nao tem token.
    addTurnEntries(ctxOf(room, gm), { entries: [{ sheetId: 'sht-SEGREDO-vilao', tokenId: null, playerId: null, name: 'SEGREDO-vilao' }] }, vi.fn());

    expect(secretsIn(traffic(room, alice))).toEqual([]);
  });
});

describe('2.2: montar cena fora do ar', () => {
  it('nada do que o mestre monta numa cena fora do ar chega ao jogador', () => {
    const room = table();
    room.state.scenes.push(createScene({ id: 'SEGREDO-cena-preparo', name: 'SEGREDO-porao' }));
    const gm = connect(room, 'mestre');
    const alice = connect(room, 'alice');
    const ctx = ctxOf(room, gm);
    const sceneId = 'SEGREDO-cena-preparo';

    createWallHandler(ctx, { sceneId, wall: { x1: 0, y1: 0, x2: 70, y2: 0 } }, vi.fn());
    createWallHandler(ctx, { sceneId, wall: { x1: 0, y1: 70, x2: 70, y2: 70, door: true } }, vi.fn());
    const tokenAck = vi.fn();
    createTokenHandler(ctx, { sceneId, token: { name: 'SEGREDO-chefe', visibility: 'visible', x: 140, y: 140 } }, tokenAck);
    createTileHandler(ctx, { sceneId, tile: { x: 0, y: 0, width: 70, height: 70 } }, vi.fn());
    createEffectHandler(ctx, { sceneId, effect: { kind: 'circle', label: 'SEGREDO-runa', x: 70, y: 70 } }, vi.fn());
    createTriggerHandler(ctx, { sceneId, trigger: { name: 'SEGREDO-armadilha', area: { kind: 'rect', x: 0, y: 0, width: 70, height: 70 } } }, vi.fn());
    paintFog(ctx, { sceneId, cells: ['0,0', '1,0'], action: 'block' }, vi.fn());
    pingMap(ctx, { sceneId, x: 10, y: 10, focus: true });
    moveToken(ctx, { sceneId, tokenId: tokenAck.mock.calls[0][0].data.id, x: 210, y: 140 }, vi.fn());

    expect(alice.received).toEqual([]);
    expect(secretsIn(traffic(room, alice))).toEqual([]);
    // O mestre, sim, recebe o que montou.
    expect(JSON.stringify(gm.received)).toContain('SEGREDO-chefe');
  });
});
