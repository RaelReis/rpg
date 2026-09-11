import {
  createSheetValues,
  generateId,
  PLAYER_COLORS,
  type Ack,
  type JoinRequest,
  type ResumeRequest,
  type Session,
  type Sheet,
  type TableState,
} from '@rpg/shared';

import { generateSessionToken, hashToken, verifyPassword } from '../auth.js';
import {
  emitPlayers,
  roomChannel,
  sendFullState,
  type TypedSocket,
} from '../broadcast.js';
import { prisma, toJson } from '../db.js';
import { stateForViewer } from '../filter.js';
import { atCapacity, LIMIT_MESSAGES } from '../limits.js';
import { spawnCharacterToken } from './characters.js';
import { rooms, type Room } from '../room.js';
import { fail, ok, safeString } from './context.js';

/**
 * Entrada e reconexao.
 *
 * O token de sessao devolvido no join e a identidade duravel do participante.
 * Guardado no navegador, ele permite voltar para a MESMA pessoa depois de uma
 * queda: mesmo personagem, mesma ficha, mesmos tokens sob controle. Sem isso,
 * cair da conexao criaria um jogador novo e orfanaria a ficha.
 */

type JoinResult = { session: Session; state: TableState };

function pickColor(room: Room, requested?: string): string {
  if (requested && /^#[0-9a-f]{6}$/i.test(requested)) return requested;
  const used = new Set(room.state.players.map((p) => p.color.toLowerCase()));
  const free = PLAYER_COLORS.find((c) => !used.has(c.toLowerCase()));
  return free ?? PLAYER_COLORS[room.state.players.length % PLAYER_COLORS.length];
}

/** Toda ficha de jogador nasce do template vigente da mesa. */
async function createSheetForPlayer(room: Room, playerId: string, name: string): Promise<Sheet> {
  const sheet: Sheet = {
    id: generateId('sht'),
    name,
    portraitAssetId: null,
    ownerPlayerId: playerId,
    values: createSheetValues(room.state.sheetTemplate),
    sharedWithParty: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await prisma.sheet.create({
    data: {
      id: sheet.id,
      tableId: room.state.id,
      name: sheet.name,
      ownerPlayerId: playerId,
      portraitAssetId: null,
      values: toJson(sheet.values),
      sharedWithParty: false,
    },
  });

  room.state.sheets.push(sheet);
  spawnCharacterToken(room, sheet);
  return sheet;
}

/**
 * Monta o estado do participante e sincroniza o cache de visibilidade do
 * socket com o que acabou de ser enviado.
 *
 * Sem isto, `attach` zera o cache e o ack entrega os tokens sem registra-los:
 * o servidor passa a achar que este jogador nao enxerga nada e para de lhe
 * mandar `token:moved`. O sintoma e cruel — depois de uma reconexao os tokens
 * congelam na tela do jogador, mas continuam se movendo para todos os outros.
 */
function stateWithVisibilityCache(room: Room, socket: TypedSocket): TableState {
  const state = stateForViewer(room, socket.data.viewer);
  const scene =
    state.scenes.find((s) => s.id === state.activeSceneId) ?? state.scenes[0] ?? null;

  socket.data.currentSceneId = scene?.id ?? null;
  socket.data.visibleTokens = new Set(scene?.tokens.map((t) => t.id) ?? []);
  socket.data.knownAssets = new Set(state.assets.map((a) => a.id));
  return state;
}

function attach(socket: TypedSocket, room: Room, playerId: string): void {
  const player = room.player(playerId);
  if (!player) return;

  socket.data.tableId = room.state.id;
  socket.data.viewer = { playerId, role: player.role };
  socket.data.visibleTokens = new Set();
  socket.data.knownAssets = new Set();
  socket.data.currentSceneId = room.state.activeSceneId;

  room.sockets.add(socket.id);
  room.lastActivity = Date.now();
  void socket.join(roomChannel(room.state.id));

  player.connected = true;
  player.lastSeen = Date.now();
  room.touchPlayer(player.id);
}

export async function handleJoin(
  socket: TypedSocket,
  req: JoinRequest,
  ack: Ack<JoinResult>,
): Promise<void> {
  // Estes campos chegam de quem ainda nao tem sessao nenhuma: o tipo e
  // conferido antes de qualquer uso, porque `code.trim()` ou `scryptSync` com
  // um objeto lancam — e esta e a porta aberta para qualquer visitante.
  const name = safeString(req?.name, 40).trim();
  if (!name) return fail(ack, 'Informe um nome.');
  if (typeof req?.code !== 'string' || !req.code.trim()) {
    return fail(ack, 'Informe o codigo da mesa.');
  }
  if (req.gmPassword !== undefined && typeof req.gmPassword !== 'string') {
    return fail(ack, 'Senha de mestre invalida.');
  }
  if (req.gmPassword !== undefined && req.gmPassword.length > 200) {
    // scrypt com uma senha gigante e trabalho de CPU gratis para quem ataca.
    return fail(ack, 'Senha de mestre invalida.');
  }

  const room = await rooms.loadByCode(req.code);
  if (!room) return fail(ack, 'Mesa nao encontrada. Confira o codigo.');

  // Cada entrada cria um jogador e uma ficha permanentes: sem teto, quem tiver
  // o codigo enche a mesa e o banco a forca de reentrar.
  if (atCapacity(room.state.players, 'players')) return fail(ack, LIMIT_MESSAGES.players);

  // A senha do mestre e o que separa os dois papeis. Sem senha informada, a
  // pessoa entra como jogador, mesmo que a mesa nao tenha senha definida.
  let role: 'GM' | 'PLAYER' = 'PLAYER';
  if (req.gmPassword !== undefined && req.gmPassword !== '') {
    const stored = await prisma.table.findUnique({
      where: { id: room.state.id },
      select: { gmPasswordHash: true },
    });
    // Mesa sem senha de mestre e com mestre: ninguem assume o papel pelo
    // convite. Antes `verifyPassword` aceitava qualquer senha quando nao havia
    // uma definida, e bastava marcar "entrar como mestre" e digitar qualquer
    // coisa para tomar a mesa.
    const hasGm = room.state.players.some((p) => p.role === 'GM');
    if (!stored?.gmPasswordHash && hasGm) {
      return fail(ack, 'Esta mesa ja tem um mestre.');
    }
    if (!verifyPassword(req.gmPassword, stored?.gmPasswordHash ?? null)) {
      return fail(ack, 'Senha de mestre incorreta.');
    }
    role = 'GM';
  }

  const token = generateSessionToken();
  const playerId = generateId('ply');
  const color = pickColor(room, req.color);

  await prisma.player.create({
    data: {
      id: playerId,
      tableId: room.state.id,
      name,
      role,
      color,
      tokenHash: hashToken(token),
    },
  });

  room.state.players.push({
    id: playerId,
    name,
    role,
    color,
    connected: false,
    lastSeen: Date.now(),
    sheetId: null,
  });

  if (role === 'PLAYER') {
    const sheet = await createSheetForPlayer(room, playerId, name);
    const player = room.player(playerId);
    if (player) player.sheetId = sheet.id;
    room.touchPlayer(playerId);
    room.touchSheet(sheet.id);
  }

  attach(socket, room, playerId);

  const session: Session = {
    tableId: room.state.id,
    tableCode: room.state.code,
    playerId,
    role,
    token,
    name,
  };

  ok(ack, { session, state: stateWithVisibilityCache(room, socket) });
  emitPlayers(room);
}

export async function handleResume(
  socket: TypedSocket,
  req: ResumeRequest,
  ack: Ack<JoinResult>,
): Promise<void> {
  if (typeof req?.token !== 'string' || !req.token) return fail(ack, 'Sessao ausente.');

  const resolved = await rooms.resolveSession(req.token);
  if (!resolved) return fail(ack, 'Sessao expirada ou invalida. Entre novamente.');

  const { room, playerId } = resolved;
  const player = room.player(playerId);
  if (!player) return fail(ack, 'Jogador nao faz mais parte desta mesa.');

  attach(socket, room, playerId);

  const session: Session = {
    tableId: room.state.id,
    tableCode: room.state.code,
    playerId,
    role: player.role,
    token: req.token,
    name: player.name,
  };

  ok(ack, { session, state: stateWithVisibilityCache(room, socket) });
  emitPlayers(room);
}

export function handleDisconnect(socket: TypedSocket): void {
  const tableId = socket.data?.tableId;
  if (!tableId) return;

  const room = rooms.get(tableId);
  if (!room) return;

  room.sockets.delete(socket.id);

  const playerId = socket.data.viewer?.playerId;
  if (!playerId) return;

  // Uma pessoa pode ter mais de uma aba aberta: so marcamos como desconectada
  // quando o ultimo socket dela cai.
  const stillOnline = [...room.sockets].some((id) => {
    const other = socket.nsp.sockets.get(id) as TypedSocket | undefined;
    return other?.data?.viewer?.playerId === playerId;
  });

  const player = room.player(playerId);
  if (player && !stillOnline) {
    player.connected = false;
    player.lastSeen = Date.now();
    room.touchPlayer(player.id);
    emitPlayers(room);
  }
}

export { sendFullState };
