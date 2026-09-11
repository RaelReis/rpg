import type {
  Asset,
  Cell,
  ChatMessage,
  FieldValue,
  Handout,
  InitiativeEntry,
  InitiativeState,
  Layer,
  MapEffect,
  Player,
  Role,
  Scene,
  Session,
  Sheet,
  SheetTemplate,
  TableSettings,
  TableState,
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

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface JoinRequest {
  code: string;
  name: string;
  /** Senha do mestre definida na criacao da mesa. */
  gmPassword?: string;
  /** Cor preferida do jogador no chat e nos pings. */
  color?: string;
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

  'template:update': (template: SheetTemplate, ack: Ack<null>) => void;

  'sheet:create': (payload: { name: string; ownerPlayerId?: string | null }, ack: Ack<Sheet>) => void;
  'sheet:update': (payload: { sheetId: string; values?: Record<string, FieldValue>; name?: string; portraitAssetId?: string | null; sharedWithParty?: boolean }, ack: Ack<null>) => void;
  'sheet:delete': (payload: { sheetId: string }, ack: Ack<null>) => void;
  'sheet:assign': (payload: { sheetId: string; playerId: string | null }, ack: Ack<null>) => void;
  /**
   * Rola a formula de um campo da ficha. Quem resolve as referencias e joga
   * os dados e o servidor — deixar isso no cliente permitiria escolher o
   * resultado com o console aberto.
   */
  'sheet:roll': (payload: { sheetId: string; fieldId: string; whisper?: boolean }, ack: Ack<null>) => void;

  'initiative:update': (patch: Partial<InitiativeState>, ack: Ack<null>) => void;
  'initiative:add': (payload: { entry: Partial<InitiativeEntry> }, ack: Ack<null>) => void;
  'initiative:remove': (payload: { entryId: string }, ack: Ack<null>) => void;
  'initiative:next': (ack: Ack<null>) => void;
  'initiative:previous': (ack: Ack<null>) => void;
  'initiative:roll': (ack: Ack<null>) => void;

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

  'tiles:patch': (payload: { sceneId: string; upsert?: Tile[]; remove?: string[] }) => void;
  'effects:patch': (payload: { sceneId: string; upsert?: MapEffect[]; remove?: string[] }) => void;
  'walls:patch': (payload: { sceneId: string; upsert?: Wall[]; remove?: string[] }) => void;
  'fog:patch': (payload: FogPatch) => void;

  'sheets:patch': (payload: { upsert?: Sheet[]; remove?: string[] }) => void;
  'template:patch': (template: SheetTemplate) => void;
  'players:patch': (players: Player[]) => void;
  'initiative:patch': (initiative: InitiativeState) => void;
  'settings:patch': (settings: TableSettings) => void;
  'assets:patch': (payload: { upsert?: Asset[]; remove?: string[] }) => void;
  'handouts:patch': (payload: { upsert?: Handout[]; remove?: string[] }) => void;
  'handout:presented': (payload: { handoutId: string }) => void;
  'table:renamed': (name: string) => void;

  'chat:message': (message: ChatMessage) => void;
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
export const CHAT_HISTORY_SIZE = 200;

export type { Cell, Layer };
