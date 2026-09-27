import type {
  ActiveScreenEffect,
  Asset,
  BoardItem,
  BoardThread,
  Cell,
  ChatMessage,
  FieldValue,
  InventoryItem,
  Handout,
  Layer,
  MapEffect,
  Player,
  PresentedCard,
  Role,
  Scene,
  SceneCard,
  ScreenEffect,
  ScreenMessage,
  ScreenMessageStyle,
  Session,
  Sheet,
  SheetTemplate,
  Trigger,
  TriggerLogEntry,
  TableSettings,
  TableState,
  TurnEntry,
  TurnState,
  Tile,
  Token,
  Wall,
} from './types.js';

/**
 * Contrato de eventos em tempo real.
 *
 * Sincronizacao em duas velocidades:
 *  - estado estrutural (`table:state`, `scene:patch`) vai inteiro, e muda pouco;
 *  - alta frequencia (`token:moved`, `fog:patch`) vai em delta.
 *
 * `tokens:patch` e deliberadamente um upsert/remove: com `strictVision`, o
 * servidor calcula por jogador quais tokens sao visiveis, e a mesma mensagem
 * expressa "token criado", "token alterado" e "token entrou/saiu da neblina".
 */

export type Ack<T> = (response: Result<T>) => void;

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface SheetOperation {
  sheetId: string;
  fieldId: string;
  action: 'adjust' | 'resource' | 'add' | 'update' | 'remove';
  delta?: number;
  resource?: { current?: number; max?: number };
  itemId?: string;
  item?: Partial<InventoryItem>;
}

export interface JoinRequest {
  code: string;
  name: string;
  /** Senha do mestre definida na criacao da mesa. */
  gmPassword?: string;
  /** Cor preferida do jogador no chat e nos pings. */
  color?: string;
  /**
   * Retomar o jogador desconectado com este mesmo nome. Sem isto, o servidor
   * responde `NAME_TAKEN_OFFLINE` e o cliente pergunta "E voce?" antes.
   */
  reclaim?: boolean;
}

export interface ResumeRequest {
  token: string;
}

export interface CreateTableRequest {
  name: string;
  gmName: string;
  gmPassword?: string;
}

export interface TokenMovePayload {
  sceneId: string;
  tokenId: string;
  x: number;
  y: number;
  /** Movimento ainda em curso (arraste): o servidor nao persiste ainda. */
  dragging?: boolean;
}

/**
 * Varios tokens movidos no mesmo quadro de arraste, num evento so.
 *
 * Um `token:move` por token por quadro estourava o limite de eventos do socket
 * ao arrastar um grupo — e, sem ack, a recusa era silenciosa: os tokens
 * voltavam ao lugar de antes quando a pessoa soltava.
 */
export interface TokensMovePayload {
  sceneId: string;
  moves: { tokenId: string; x: number; y: number }[];
  dragging?: boolean;
}

/**
 * Pincel de neblina.
 *
 * `hide` e `block` sao coisas diferentes de proposito:
 *
 * - `hide` cobre de volta — apaga o que estava revelado e explorado, mas a
 *   area continua descobrivel: o personagem que andar ate la revela de novo.
 *   E o gesto comum, de "fechar o mapa" antes de uma cena.
 * - `block` sela a area: nem a visao dos tokens revela. Serve para o que o
 *   grupo nao pode ver de jeito nenhum, e so sai com `unblock`.
 */
export interface FogPaintPayload {
  sceneId: string;
  cells: string[];
  action: 'reveal' | 'hide' | 'block' | 'clear-reveal' | 'unblock';
}

export interface FogResetPayload {
  sceneId: string;
  /** 'explored' apaga o que os jogadores ja mapearam; 'all' zera tudo. */
  scope: 'explored' | 'revealed' | 'hidden' | 'all';
}

export interface CellSet {
  add?: string[];
  remove?: string[];
}

export interface FogPatch {
  sceneId: string;
  explored?: CellSet;
  revealed?: CellSet;
  hidden?: CellSet;
  /** Substituicao total das listas cruas (reset do mestre). */
  reset?: { explored?: string[]; revealed?: string[]; hidden?: string[] };
  /**
   * Visao ja calculada pelo servidor para ESTE jogador (`strictVision`).
   *
   * Separada de `reset` de proposito. As duas chegavam no mesmo campo, e o
   * cliente gravava toda substituicao tambem como visao calculada: um reset
   * de listas cruas faria o cliente tratar o pincel do mestre como "o que o
   * jogador ve", ignorando a linha de visao dos tokens.
   */
  computed?: { visible: string[]; explored: string[] };
}

export interface TokensPatch {
  sceneId: string;
  upsert?: Token[];
  remove?: string[];
}

export interface MapPing {
  sceneId: string;
  x: number;
  y: number;
  color: string;
  playerName: string;
  /** Puxa a camera dos jogadores para o ponto (so o mestre pode). */
  focus: boolean;
}

export interface ScreenMessageRequest {
  /** Jogadores que recebem a mensagem. */
  recipients: string[];
  text: string;
  style: ScreenMessageStyle;
  /** Milissegundos na tela; `null` fica ate o jogador fechar. */
  durationMs: number | null;
}

/**
 * Resultado da entrega, para o mestre saber quem de fato leu.
 *
 * Quem esta offline nao recebe depois: a mensagem e do momento, e aparecer
 * fora de hora, quando a pessoa voltar, estragaria o efeito. O mestre e
 * avisado e decide se repete.
 */
export interface ScreenMessageDelivery {
  delivered: string[];
  offline: string[];
  /** Conectados que nao confirmaram a tempo (aba travada, rede ruim). */
  unconfirmed: string[];
}

export interface ScreenEffectRequest {
  effect: Partial<ScreenEffect>;
  /** Jogadores que recebem; `null` = todos. */
  recipients: string[] | null;
}

export interface CardPresentRequest {
  cardId: string;
  /** Jogadores que veem; `null` = todos. */
  recipients: string[] | null;
  /** Milissegundos na tela; `null` fica ate o mestre fechar. */
  durationMs: number | null;
}

export interface BoardPatch {
  upsert?: BoardItem[];
  remove?: string[];
  threads?: { upsert?: BoardThread[]; remove?: string[] };
  locked?: boolean;
}

export interface ChatSendPayload {
  text: string;
  whisper: boolean;
}

// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  'session:join': (req: JoinRequest, ack: Ack<{ session: Session; state: TableState }>) => void;
  'session:resume': (req: ResumeRequest, ack: Ack<{ session: Session; state: TableState }>) => void;

  'settings:update': (patch: Partial<TableSettings>, ack: Ack<null>) => void;
  'table:rename': (name: string, ack: Ack<null>) => void;

  'scene:create': (payload: { name: string; backgroundAssetId?: string | null }, ack: Ack<Scene>) => void;
  'scene:update': (payload: { sceneId: string; patch: Partial<Scene> }, ack: Ack<null>) => void;
  'scene:delete': (payload: { sceneId: string }, ack: Ack<null>) => void;
  'scene:activate': (payload: { sceneId: string }, ack: Ack<null>) => void;

  'token:create': (payload: { sceneId: string; token: Partial<Token> }, ack: Ack<Token>) => void;
  'token:update': (payload: { sceneId: string; tokenId: string; patch: Partial<Token> }, ack: Ack<null>) => void;
  'token:move': (payload: TokenMovePayload, ack?: Ack<null>) => void;
  /** Lote de um quadro de arraste; sem ack, como o movimento continuo. */
  'tokens:move': (payload: TokensMovePayload) => void;
  'token:delete': (payload: { sceneId: string; tokenId: string }, ack: Ack<null>) => void;

  'tile:create': (payload: { sceneId: string; tile: Partial<Tile> }, ack: Ack<Tile>) => void;
  'tile:update': (payload: { sceneId: string; tileId: string; patch: Partial<Tile> }, ack: Ack<null>) => void;
  'tile:delete': (payload: { sceneId: string; tileId: string }, ack: Ack<null>) => void;

  'effect:create': (payload: { sceneId: string; effect: Partial<MapEffect> }, ack: Ack<MapEffect>) => void;
  'effect:update': (payload: { sceneId: string; effectId: string; patch: Partial<MapEffect> }, ack: Ack<null>) => void;
  'effect:delete': (payload: { sceneId: string; effectId: string }, ack: Ack<null>) => void;

  'wall:create': (payload: { sceneId: string; wall: Partial<Wall> }, ack: Ack<Wall>) => void;
  'wall:update': (payload: { sceneId: string; wallId: string; patch: Partial<Wall> }, ack: Ack<null>) => void;
  'wall:delete': (payload: { sceneId: string; wallId: string }, ack: Ack<null>) => void;

  'fog:paint': (payload: FogPaintPayload, ack?: Ack<null>) => void;
  'fog:reset': (payload: FogResetPayload, ack: Ack<null>) => void;

  'template:update': (template: SheetTemplate, ack: Ack<true>) => void;

  'sheet:create': (payload: { name: string; ownerPlayerId?: string | null }, ack: Ack<Sheet>) => void;
  'sheet:update': (payload: { sheetId: string; values?: Record<string, FieldValue>; name?: string; portraitAssetId?: string | null; sharedWithParty?: boolean }, ack: Ack<null>) => void;
  'sheet:delete': (payload: { sheetId: string }, ack: Ack<null>) => void;
  'sheet:operate': (payload: SheetOperation, ack: Ack<null>) => void;
  'sheet:assign': (payload: { sheetId: string; playerId: string | null }, ack: Ack<null>) => void;
  /**
   * Rola a formula de um campo da ficha. Quem resolve as referencias e joga
   * os dados e o servidor — deixar isso no cliente permitiria escolher o
   * resultado com o console aberto.
   */
  'sheet:roll': (payload: { sheetId: string; fieldId: string; whisper?: boolean }, ack: Ack<null>) => void;

  /**
   * As duas imagens do personagem, enviadas pelo proprio jogador ao entrar:
   * retrato (ficha e grupo) e corpo inteiro (token no mapa).
   */
  'character:images': (
    payload: { portraitAssetId: string; bodyAssetId: string },
    ack: Ack<null>,
  ) => void;

  'turns:add': (payload: { entries: Partial<TurnEntry>[] }, ack: Ack<null>) => void;
  'turns:remove': (payload: { entryId: string }, ack: Ack<null>) => void;
  /** Nova ordem completa, como o mestre deixou as miniaturas. */
  'turns:reorder': (payload: { entryIds: string[] }, ack: Ack<null>) => void;
  'turns:update': (payload: { entryId: string; patch: Partial<TurnEntry> }, ack: Ack<null>) => void;
  /** Passa a vez para uma miniatura especifica, sem percorrer a ordem. */
  'turns:set': (payload: { entryId: string }, ack: Ack<null>) => void;
  'turns:next': (ack: Ack<null>) => void;
  'turns:previous': (ack: Ack<null>) => void;

  'player:update': (patch: { name?: string; color?: string }, ack: Ack<null>) => void;
  'player:kick': (payload: { playerId: string }, ack: Ack<null>) => void;
  'player:promote': (payload: { playerId: string; role: Role }, ack: Ack<null>) => void;

  'asset:delete': (payload: { assetId: string }, ack: Ack<null>) => void;

  'handout:create': (payload: { title: string; text?: string; assetId?: string | null }, ack: Ack<Handout>) => void;
  'handout:update': (payload: { handoutId: string; patch: Partial<Handout> }, ack: Ack<null>) => void;
  'handout:delete': (payload: { handoutId: string }, ack: Ack<null>) => void;
  /**
   * Abre o material na tela de quem ja tem acesso.
   *
   * Compartilhar e apresentar sao coisas diferentes: o mestre pode deixar um
   * material disponivel para consulta sem interromper a cena, e apresentar
   * quando for a hora.
   */
  'handout:present': (payload: { handoutId: string }, ack: Ack<null>) => void;

  'chat:send': (payload: ChatSendPayload, ack: Ack<null>) => void;
  /** Mensagem individual no centro da tela (so o mestre envia). */
  'message:send': (payload: ScreenMessageRequest, ack: Ack<ScreenMessageDelivery>) => void;
  /** Efeito de tela (so o mestre). Fixos ficam ativos ate `screen:stop`. */
  'screen:apply': (payload: ScreenEffectRequest, ack: Ack<ScreenEffect>) => void;
  /** Remove um efeito fixo, ou todos os efeitos quando `effectId` e omitido. */
  'screen:stop': (payload: { effectId?: string }, ack: Ack<null>) => void;
  /** Preferencias pessoais de quem esta conectado. */
  'player:prefs': (payload: { reduceEffects?: boolean }, ack: Ack<null>) => void;

  'card:create': (payload: { title: string; subtitle?: string; assetId?: string | null }, ack: Ack<SceneCard>) => void;
  'card:update': (payload: { cardId: string; patch: Partial<SceneCard> }, ack: Ack<null>) => void;
  'card:delete': (payload: { cardId: string }, ack: Ack<null>) => void;
  'card:present': (payload: CardPresentRequest, ack: Ack<null>) => void;
  'card:close': (payload: Record<string, never>, ack: Ack<null>) => void;

  /** Gatilhos de mapa (so o mestre). O disparo e decidido no movimento. */
  'trigger:create': (payload: { sceneId: string; trigger: Partial<Trigger> }, ack: Ack<Trigger>) => void;
  'trigger:update': (payload: { sceneId: string; triggerId: string; patch: Partial<Trigger> }, ack: Ack<null>) => void;
  'trigger:delete': (payload: { sceneId: string; triggerId: string }, ack: Ack<null>) => void;

  /** Quadro de pistas: todos editam; apagar e do autor e do mestre. */
  'board:create': (payload: { item: Partial<BoardItem> }, ack: Ack<BoardItem>) => void;
  /** `dragging` marca movimento em curso: vai aos outros, grava agrupado. */
  'board:update': (payload: { itemId: string; patch: Partial<BoardItem>; dragging?: boolean }, ack: Ack<null>) => void;
  'board:delete': (payload: { itemId: string }, ack: Ack<null>) => void;
  'board:lock': (payload: { locked: boolean }, ack: Ack<null>) => void;
  'thread:create': (payload: { from: string; to: string; color?: string }, ack: Ack<BoardThread>) => void;
  'thread:update': (payload: { threadId: string; color: string }, ack: Ack<null>) => void;
  'thread:delete': (payload: { threadId: string }, ack: Ack<null>) => void;
  'map:ping': (payload: Omit<MapPing, 'playerName' | 'color'>) => void;
  // Nao ha evento de cursor: ninguem, nem o mestre, ve o ponteiro dos outros.
  // O ping continua sendo o jeito deliberado de apontar algo no mapa.
}

export interface ServerToClientEvents {
  /** Estado completo (ja filtrado pelo papel de quem recebe). */
  'table:state': (state: TableState) => void;
  'scene:patch': (payload: { sceneId: string; patch: Partial<Scene> }) => void;
  'scene:removed': (payload: { sceneId: string }) => void;
  'scene:activated': (payload: { sceneId: string }) => void;

  'tokens:patch': (payload: TokensPatch) => void;
  'token:moved': (payload: { sceneId: string; tokenId: string; x: number; y: number }) => void;
  /**
   * So para quem arrasta: o passo foi recusado por uma parede, e o token segue
   * em `x`/`y`. Com strictVision o jogador nao recebe as paredes comuns, entao
   * a previa local nao tem como saber sozinha onde parar.
   */
  'token:blocked': (payload: { sceneId: string; tokenId: string; x: number; y: number }) => void;

  'tiles:patch': (payload: { sceneId: string; upsert?: Tile[]; remove?: string[] }) => void;
  'effects:patch': (payload: { sceneId: string; upsert?: MapEffect[]; remove?: string[] }) => void;
  'walls:patch': (payload: { sceneId: string; upsert?: Wall[]; remove?: string[] }) => void;
  'fog:patch': (payload: FogPatch) => void;

  'sheets:patch': (payload: { upsert?: Sheet[]; remove?: string[] }) => void;
  'template:patch': (template: SheetTemplate) => void;
  'players:patch': (players: Player[]) => void;
  'turns:patch': (turns: TurnState) => void;
  'settings:patch': (settings: TableSettings) => void;
  'assets:patch': (payload: { upsert?: Asset[]; remove?: string[] }) => void;
  'handouts:patch': (payload: { upsert?: Handout[]; remove?: string[] }) => void;
  'handout:presented': (payload: { handoutId: string }) => void;
  'table:renamed': (name: string) => void;

  'chat:message': (message: ChatMessage) => void;
  /** O cliente confirma pelo ack assim que recebe: e o "entregue" do mestre. */
  'message:show': (message: ScreenMessage, ack: (received: boolean) => void) => void;
  /** Um efeito comeca na tela deste jogador (ja reduzido, se ele pediu). */
  'screen:effect': (effect: ScreenEffect) => void;
  /** Efeitos encerrados pelo mestre; `all` limpa a tela. */
  'screen:stopped': (payload: { ids: string[] } | { all: true }) => void;
  /** Lista de efeitos fixos ativos, para o painel do mestre. */
  'screen:active': (effects: ActiveScreenEffect[]) => void;

  /** Cartelas preparadas (so o mestre recebe). */
  'cards:patch': (payload: { upsert?: SceneCard[]; remove?: string[] }) => void;
  /** Cartela entra na tela (ou sai, com `null`). */
  'card:presented': (card: PresentedCard | null) => void;

  /** Gatilhos de uma cena (so o mestre recebe). */
  'triggers:patch': (payload: { sceneId: string; upsert?: Trigger[]; remove?: string[] }) => void;
  /** Um gatilho disparou (so o mestre recebe). */
  'trigger:fired': (entry: TriggerLogEntry) => void;

  /** Mudancas no quadro de pistas, ja filtradas para quem recebe. */
  'board:patch': (payload: BoardPatch) => void;
  'map:ping': (ping: MapPing) => void;

  'notice': (payload: { level: 'info' | 'warn' | 'error'; message: string }) => void;
  'session:ended': (payload: { reason: string }) => void;
}

// ---------------------------------------------------------------------------
// Limites aceitos pelo servidor (o cliente usa os mesmos numeros na UI)
// ---------------------------------------------------------------------------

export const UPLOAD_LIMITS = {
  /** Mapas costumam ser grandes; tokens e retratos, nao. */
  map: 20 * 1024 * 1024,
  tile: 10 * 1024 * 1024,
  token: 5 * 1024 * 1024,
  portrait: 5 * 1024 * 1024,
  item: 2 * 1024 * 1024,
  effect: 5 * 1024 * 1024,
  /** Fundo de cartela de cena: tela cheia, entao imagem grande. */
  card: 10 * 1024 * 1024,
  /** Imagem pregada no quadro de pistas; qualquer participante envia. */
  clue: 5 * 1024 * 1024,
} as const;

export const ALLOWED_IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_CHAT_LENGTH = 2000;
export const MAX_SCREEN_MESSAGE_LENGTH = 400;
/** Limites de tempo na tela de uma mensagem com duracao. */
export const SCREEN_MESSAGE_MIN_MS = 1000;
export const SCREEN_MESSAGE_MAX_MS = 120000;
export const CHAT_HISTORY_SIZE = 200;

export type { Cell, Layer };
