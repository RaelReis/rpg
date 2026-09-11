import { io, type Socket } from 'socket.io-client';
import type {
  Ack,
  ClientToServerEvents,
  JoinRequest,
  Result,
  ServerToClientEvents,
  Session,
  TableState,
} from '@rpg/shared';

import { grantImageAccess, revokeImageAccess } from './api';
import { useStore } from '../state/store';

/**
 * Conexao com o servidor.
 *
 * A reconexao e o ponto delicado: quando a rede cai, o socket.io reconecta
 * sozinho, mas do ponto de vista do servidor aquilo e um socket NOVO, sem
 * identidade. Por isso guardamos o token de sessao no navegador e reenviamos
 * `session:resume` a cada reconexao — e o que devolve a pessoa ao mesmo
 * personagem, com os mesmos tokens sob controle, em vez de cria-la de novo.
 */

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SESSION_KEY = 'rpg-vtt:session';

export function storedSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function storeSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Navegacao privada pode bloquear o storage; a sessao entao dura so a aba.
  }
}

let socket: ClientSocket | null = null;

export function getSocket(): ClientSocket {
  if (socket) return socket;

  socket = io({
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 600,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
  });

  registerListeners(socket);
  return socket;
}

/**
 * Teto de espera por um ack. Todo handler do servidor responde a partir do
 * estado em memoria — a gravacao no banco e assincrona e nao segura a
 * resposta —, entao qualquer coisa alem disto e falha, nao lentidao.
 */
const RPC_TIMEOUT_MS = 15000;

/**
 * Envia um evento e devolve o resultado como promessa.
 *
 * O tempo limite nao e detalhe: sem ele, um ack perdido — servidor reiniciado
 * no meio da chamada, evento descartado pelo limitador de taxa — deixa a
 * promessa pendente para sempre, e a interface fica presa em "Salvando..."
 * sem erro e sem saida a nao ser recarregar a pagina.
 */
export function rpc<T>(
  event: keyof ClientToServerEvents,
  payload?: unknown,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = getSocket();
    if (!s.connected) return reject(new Error('Sem conexao com o servidor.'));

    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error('O servidor nao respondeu. Tente de novo.'));
    }, timeoutMs);

    const ack: Ack<T> = (res: Result<T>) => {
      // O ack ainda pode chegar depois do estouro; ai ja nao ha o que fazer
      // com ele, e resolver duas vezes seria silencioso mas errado.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error));
    };

    // Eventos sem payload (initiative:next, initiative:roll) recebem so o ack.
    if (payload === undefined) (s.emit as (e: string, a: unknown) => void)(event, ack);
    else (s.emit as (e: string, p: unknown, a: unknown) => void)(event, payload, ack);
  });
}

/** Evento sem resposta, para o que e continuo (cursor, movimento em arraste). */
export function emit(event: keyof ClientToServerEvents, payload?: unknown): void {
  const s = getSocket();
  if (!s.connected) return;
  if (payload === undefined) (s.emit as (e: string) => void)(event);
  else (s.emit as (e: string, p: unknown) => void)(event, payload);
}

/**
 * Dispara uma acao e transforma a falha em aviso na tela. A maior parte da UI
 * e otimista: o servidor e a autoridade, e um erro precisa aparecer para a
 * pessoa em vez de sumir no console.
 */
export function act<T>(event: keyof ClientToServerEvents, payload?: unknown): Promise<T | null> {
  return rpc<T>(event, payload).catch((err: Error) => {
    useStore.getState().notify('error', err.message);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export async function connectAndResume(): Promise<boolean> {
  const session = storedSession();
  if (!session) return false;

  const s = getSocket();
  if (!s.connected) {
    s.connect();
    await once(s, 'connect', 8000).catch(() => null);
  }
  if (!s.connected) return false;

  try {
    const data = await rpc<{ session: Session; state: TableState }>('session:resume', {
      token: session.token,
    });
    await applySession(data.session, data.state);
    return true;
  } catch {
    // Sessao invalida (mesa apagada, jogador removido): comeca do zero.
    storeSession(null);
    useStore.getState().setSession(null);
    return false;
  }
}

export async function joinTable(req: JoinRequest): Promise<void> {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
    await once(s, 'connect', 8000);
  }
  const data = await rpc<{ session: Session; state: TableState }>('session:join', req);
  await applySession(data.session, data.state);
}

/** Usada logo apos criar a mesa pela API REST, que ja devolve a sessao. */
export async function resumeWithSession(session: Session): Promise<void> {
  storeSession(session);
  const s = getSocket();
  if (!s.connected) {
    s.connect();
    await once(s, 'connect', 8000);
  }
  const data = await rpc<{ session: Session; state: TableState }>('session:resume', {
    token: session.token,
  });
  await applySession(data.session, data.state);
}

async function applySession(session: Session, state: TableState): Promise<void> {
  storeSession(session);

  // O cookie das imagens vem ANTES da mesa. Em paralelo, o canvas pedia as
  // imagens assim que o estado chegava, antes do cookie existir: elas
  // voltavam 401 e, para quem entrava pela primeira vez, a mesa abria sem
  // arte. Custa uma ida ao servidor na entrada.
  await grantImageAccess(session.token);

  const store = useStore.getState();
  store.setSession(session);
  store.setTable(state);
  store.setSideTab(session.role === 'GM' ? 'scene' : 'sheet');
}

export function leaveTable(): void {
  const previous = storedSession();
  if (previous) void revokeImageAccess(previous.token);

  storeSession(null);
  const store = useStore.getState();
  store.setSession(null);
  store.clearTable();
  socket?.disconnect();
}

function once(s: ClientSocket, event: 'connect', timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, handler);
      reject(new Error('Nao foi possivel conectar ao servidor.'));
    }, timeoutMs);

    const handler = () => {
      clearTimeout(timer);
      resolve();
    };
    s.once(event, handler);
  });
}

// ---------------------------------------------------------------------------
// Eventos do servidor -> estado
// ---------------------------------------------------------------------------

function registerListeners(s: ClientSocket): void {
  const store = () => useStore.getState();

  s.on('connect', () => {
    store().setConnected(true);

    // Reconexao: o socket e novo para o servidor, entao reapresentamos a
    // sessao. O estado completo volta em seguida, ja atualizado.
    const session = storedSession();
    if (session && store().table) {
      rpc<{ session: Session; state: TableState }>('session:resume', { token: session.token })
        .then(async (data) => {
          // O cookie pode ter expirado ou sido limpo enquanto a conexao caia.
          await grantImageAccess(data.session.token);
          store().setSession(data.session);
          store().setTable(data.state);
          store().notify('info', 'Reconectado a mesa.');
        })
        .catch(() => store().notify('error', 'Nao foi possivel retomar a sessao.'));
    }
  });

  s.on('disconnect', (reason) => {
    store().setConnected(false);
    if (reason !== 'io client disconnect') {
      store().notify('warn', 'Conexao perdida. Tentando reconectar...');
    }
  });

  s.on('connect_error', () => store().setConnected(false));

  s.on('table:state', (state) => store().setTable(state));
  s.on('scene:patch', ({ sceneId, patch }) => store().patchScene(sceneId, patch));
  s.on('scene:removed', ({ sceneId }) => store().removeScene(sceneId));
  s.on('scene:activated', ({ sceneId }) => store().setActiveScene(sceneId));

  s.on('tokens:patch', ({ sceneId, upsert, remove }) => {
    if (upsert?.length) store().upsertTokens(sceneId, upsert);
    if (remove?.length) store().removeTokens(sceneId, remove);
  });

  s.on('token:moved', ({ sceneId, tokenId, x, y }) => {
    store().moveTokenLocal(sceneId, tokenId, x, y);
  });

  s.on('tiles:patch', ({ sceneId, upsert, remove }) =>
    store().upsertTiles(sceneId, upsert ?? [], remove ?? []),
  );
  s.on('effects:patch', ({ sceneId, upsert, remove }) =>
    store().upsertEffects(sceneId, upsert ?? [], remove ?? []),
  );
  s.on('walls:patch', ({ sceneId, upsert, remove }) =>
    store().upsertWalls(sceneId, upsert ?? [], remove ?? []),
  );
  s.on('fog:patch', (patch) => store().applyFogPatch(patch));

  s.on('sheets:patch', ({ upsert, remove }) => store().upsertSheets(upsert ?? [], remove ?? []));
  s.on('template:patch', (template) => store().setTemplate(template));
  s.on('players:patch', (players) => store().setPlayers(players));
  s.on('initiative:patch', (initiative) => store().setInitiative(initiative));
  s.on('settings:patch', (settings) => store().setSettings(settings));
  s.on('assets:patch', ({ upsert, remove }) => store().upsertAssets(upsert ?? [], remove ?? []));
  s.on('handouts:patch', ({ upsert, remove }) =>
    store().upsertHandouts(upsert ?? [], remove ?? []),
  );

  // Apresentar e um gesto do mestre pedindo a atencao da mesa: a janela abre
  // sozinha, em vez de esperar a pessoa procurar o material na aba.
  s.on('handout:presented', ({ handoutId }) => {
    const state = store();
    const handout = state.table?.handouts.find((h) => h.id === handoutId);
    state.openHandout(handoutId);
    if (handout) state.notify('info', `O mestre apresentou: ${handout.title}`);
  });
  s.on('table:renamed', (name) => store().setTableName(name));

  s.on('chat:message', (message) => store().addChatMessage(message));
  s.on('map:ping', (ping) => store().addPing(ping));

  s.on('notice', ({ level, message }) => store().notify(level, message));

  s.on('session:ended', ({ reason }) => {
    store().notify('error', reason);
    leaveTable();
  });
}
