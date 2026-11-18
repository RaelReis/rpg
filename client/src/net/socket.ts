import { clearImages, forgetImage } from '../canvas/images';
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

let activeSession: Session | null | undefined;
function validSession(value: unknown): value is Session {
  const s = value as Session | null;
  return !!s && typeof s.token === 'string' && typeof s.tableId === 'string' && typeof s.playerId === 'string';
}
export function storedSession(): Session | null {
  if (activeSession !== undefined) return activeSession;
  try {
    const registry = JSON.parse(localStorage.getItem(`${SESSION_KEY}:tables`) ?? '{}') as Record<string, Session>;
    const tab = sessionStorage.getItem(SESSION_KEY);
    const code = new URLSearchParams(window.location.search).get('mesa')?.replace(/[^a-z0-9]/gi, '').toUpperCase();
    const requested = code ? Object.values(registry).find(s => s.tableCode.replace(/[^a-z0-9]/gi, '').toUpperCase() === code) : null;
    const value = requested ?? (tab ? JSON.parse(tab) : code ? null : JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'));
    activeSession = validSession(value) ? value : null;
  } catch { activeSession = null; }
  return activeSession ?? null;
}
export function storeSession(session: Session | null): void {
  const previous = activeSession;
  activeSession = session;
  try {
    const registry = JSON.parse(localStorage.getItem(`${SESSION_KEY}:tables`) ?? '{}');
    if (session) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      registry[session.tableId] = session;
    } else {
      sessionStorage.removeItem(SESSION_KEY);
      if (previous) {
        delete registry[previous.tableId];
        if (JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')?.token === previous.token) localStorage.removeItem(SESSION_KEY);
      }
    }
    localStorage.setItem(`${SESSION_KEY}:tables`, JSON.stringify(registry));
  } catch { /* Memory still preserves identity when storage is unavailable. */ }
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
      else reject(Object.assign(new Error(res.error), { code: res.code }));
    };

    // Eventos sem payload (turns:next, turns:previous) recebem so o ack.
    if (payload === undefined) (s.emit as (e: string, a: unknown) => void)(event, ack);
    else (s.emit as (e: string, p: unknown, a: unknown) => void)(event, payload, ack);
  });
}

const blockedListeners = new Set<(tokenId: string) => void>();

/**
 * Avisa quando o servidor para um token arrastado numa parede. Fica fora do
 * store de proposito: e um sinal do gesto em curso, nao estado da mesa.
 */
export function onTokenBlocked(listener: (tokenId: string) => void): () => void {
  blockedListeners.add(listener);
  return () => {
    blockedListeners.delete(listener);
  };
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
    if (storedSession()?.token !== session.token) return false;
    await applySession(data.session, data.state);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'SESSION_INVALID') {
      storeSession(null);
      useStore.getState().setSession(null);
    } else useStore.getState().notify('error', 'Nao foi possivel retomar a mesa. Sua sessao foi preservada; tente novamente.');
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

/** Espera antes de cada nova tentativa do cookie; acabou a lista, desiste. */
const IMAGE_ACCESS_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** So o pedido mais recente insiste: entrar ou reconectar aposenta o anterior. */
let imageAccessRun = 0;

/**
 * Pede o cookie das imagens sem deixar a falha dele derrubar a entrada.
 *
 * A falha (o prazo de 5 s numa rede lenta) era propagada depois de o servidor
 * ja ter aceitado a sessao: o estado novo era descartado e, na entrada, tentar
 * de novo dava "Ja tem alguem chamado X na mesa agora", porque o socket ja
 * estava ligado ao jogador recem-criado. Agora quem chama segue com a mesa, e
 * o cookie e tentado de novo por fora; as imagens que voltarem 401 nesse
 * intervalo o cache do canvas ja repete sozinho (`canvas/images.ts`).
 */
async function ensureImageAccess(token: string): Promise<void> {
  const run = ++imageAccessRun;
  try {
    await grantImageAccess(token);
  } catch {
    void (async () => {
      for (const delay of IMAGE_ACCESS_RETRY_DELAYS_MS) {
        await wait(delay);
        if (run !== imageAccessRun || storedSession()?.token !== token) return;
        try {
          await grantImageAccess(token);
          return;
        } catch { /* segue para a proxima espera */ }
      }
    })();
  }
}

async function applySession(session: Session, state: TableState): Promise<void> {
  storeSession(session);

  // O cookie das imagens vem ANTES da mesa. Em paralelo, o canvas pedia as
  // imagens assim que o estado chegava, antes do cookie existir: elas
  // voltavam 401 e, para quem entrava pela primeira vez, a mesa abria sem
  // arte. Custa uma ida ao servidor na entrada.
  await ensureImageAccess(session.token);

  if (storedSession()?.token !== session.token) return;
  const store = useStore.getState();
  store.setSession(session);
  store.setTable(state);
  // Escolhe a aba sem abrir o painel: no celular ele cobre o mapa, e abrir
  // aqui desfazia o painel fechado de saida (ver `sideOpen` no store).
  useStore.setState({ sideTab: session.role === 'GM' ? 'scene' : 'sheet' });
}

export function leaveTable(): void {
  clearImages();
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera antes de cada nova tentativa de retomar; acabou a lista, desiste. */
const RESUME_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** So a retomada mais recente vale: cada `connect` aposenta a anterior. */
let resumeRun = 0;

/**
 * Reapresenta a sessao depois de uma reconexao, insistindo se falhar.
 *
 * Uma falha aqui so virava aviso: a mesa antiga ficava na tela sobre um socket
 * sem sessao, e toda acao respondia "Sessao nao encontrada. Recarregue a
 * pagina." Agora a falha passageira (ack perdido, servidor ainda subindo,
 * outra entrada em andamento) e repetida com espera, e `SESSION_INVALID` —
 * removido pelo mestre enquanto estava fora, personagem retomado em outro
 * aparelho — devolve a pessoa a tela de entrada, como `connectAndResume` faz.
 */
async function resumeAfterReconnect(s: ClientSocket, session: Session): Promise<void> {
  const run = ++resumeRun;
  const store = () => useStore.getState();
  const stale = () => run !== resumeRun || storedSession()?.token !== session.token;

  for (let attempt = 0; ; attempt++) {
    try {
      const data = await rpc<{ session: Session; state: TableState }>('session:resume', { token: session.token });
      // O cookie pode ter expirado ou sido limpo enquanto a conexao caia.
      await ensureImageAccess(data.session.token);
      if (stale()) return;
      storeSession(data.session);
      store().setSession(data.session);
      store().setTable(data.state);
      store().notify('info', 'Reconectado a mesa.');
      return;
    } catch (err) {
      if (stale()) return;
      if ((err as { code?: string }).code === 'SESSION_INVALID') {
        store().notify('error', (err as Error).message);
        leaveTable();
        return;
      }
      // Caiu de novo no meio: o proximo `connect` recomeca do zero.
      if (!s.connected) return;
      const delay = RESUME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        store().notify('error', 'Nao foi possivel retomar a sessao. Recarregue a pagina.');
        return;
      }
      await wait(delay);
      if (stale() || !s.connected) return;
    }
  }
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
    if (session && store().table) void resumeAfterReconnect(s, session);
  });

  s.on('disconnect', (reason) => {
    store().setConnected(false);
    if (reason !== 'io client disconnect') {
      store().notify('warn', 'Conexao perdida. Tentando reconectar...');
    }
  });

  s.on('connect_error', () => store().setConnected(false));

  s.on('table:state', (state) => {
    const current = storedSession();
    if (!current || current.tableId !== state.id) return;
    const player = state.players.find(p => p.id === current.playerId);
    if (player) {
      const session = { ...current, role: player.role, name: player.name };
      storeSession(session); store().setSession(session);
    }
    store().setTable(state);
  });
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

  s.on('token:blocked', ({ sceneId, tokenId, x, y }) => {
    store().moveTokenLocal(sceneId, tokenId, x, y);
    for (const listener of blockedListeners) listener(tokenId);
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
  s.on('turns:patch', (turns) => store().setTurns(turns));
  s.on('settings:patch', (settings) => store().setSettings(settings));
  s.on('assets:patch', ({ upsert, remove }) => {
    for (const id of remove ?? []) {
      const asset = store().table?.assets.find(a => a.id === id);
      if (asset) { forgetImage(asset.url); if (asset.thumbUrl) forgetImage(asset.thumbUrl); }
    }
    store().upsertAssets(upsert ?? [], remove ?? []);
  });
  s.on('handouts:patch', ({ upsert, remove }) =>
    store().upsertHandouts(upsert ?? [], remove ?? []),
  );

  // Apresentar e um gesto do mestre pedindo a atencao da mesa: a janela abre
  // sozinha, em vez de esperar a pessoa procurar o material na aba.
  s.on('handout:presented', ({ handoutId }) => {
    const state = store();
    const handout = state.table?.handouts.find((h) => h.id === handoutId);
    // O mestre nao recebe a propria apresentacao em janela: ela abria sobre o
    // painel dele e travava os cliques seguintes (retirar o acesso, por
    // exemplo) ate ser fechada. Para ele basta saber a quem chegou.
    if (state.session?.role === 'GM') {
      if (!handout) return;
      const names = handout.sharedWithAll
        ? 'todos'
        : (state.table?.players ?? [])
            .filter((p) => handout.sharedWith.includes(p.id))
            .map((p) => p.name)
            .join(', ');
      state.notify('info', `Apresentado a ${names}: ${handout.title}`);
      return;
    }
    state.openHandout(handoutId);
    if (handout) state.notify('info', `O mestre apresentou: ${handout.title}`);
  });
  s.on('table:renamed', (name) => store().setTableName(name));

  s.on('chat:message', (message) => store().addChatMessage(message));
  s.on('map:ping', (ping) => store().addPing(ping));

  // A confirmacao sai assim que a mensagem chega: e ela que diz ao mestre que
  // a pessoa recebeu, e nao que apenas estava conectada.
  s.on('message:show', (message, ack) => {
    store().showScreenMessage(message);
    if (typeof ack === 'function') ack(true);
  });

  s.on('screen:effect', (effect) => store().startScreenEffect(effect));
  s.on('screen:stopped', (payload) => store().stopScreenEffects(payload));
  s.on('screen:active', (effects) => store().setActiveScreenEffects(effects));
  s.on('cards:patch', ({ upsert, remove }) => store().upsertCards(upsert ?? [], remove ?? []));
  s.on('card:presented', (card) => store().setPresentedCard(card));
  s.on('triggers:patch', ({ sceneId, upsert, remove }) =>
    store().upsertTriggers(sceneId, upsert ?? [], remove ?? []),
  );
  s.on('trigger:fired', (entry) => store().addTriggerLog(entry));
  s.on('board:patch', (patch) => store().applyBoardPatch(patch));

  s.on('notice', ({ level, message }) => store().notify(level, message));

  s.on('session:ended', ({ reason }) => {
    store().notify('error', reason);
    leaveTable();
  });
}
