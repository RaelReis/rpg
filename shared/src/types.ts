/**
 * Modelo de dominio compartilhado entre servidor e cliente.
 * O servidor e a autoridade: todo o estado abaixo vive no servidor e e
 * replicado (filtrado por papel) para os clientes conectados.
 */

export type Role = 'GM' | 'PLAYER';

/** Camadas fixas do mapa, na ordem de desenho. */
export const LAYERS = [1, 2, 3, 4] as const;
export type Layer = (typeof LAYERS)[number];

export const LAYER_NAMES: Record<Layer, string> = {
  1: 'Fundo / Terreno',
  2: 'Tiles / Obstaculos',
  3: 'Tokens',
  4: 'Efeitos / Anotacoes',
};

export type GridType = 'square' | 'hex-pointy' | 'hex-flat' | 'none';

export interface GridConfig {
  type: GridType;
  /** Largura de uma celula, em pixels do mapa. */
  size: number;
  offsetX: number;
  offsetY: number;
  color: string;
  opacity: number;
  /** Snap da movimentacao a grid. */
  snap: boolean;
  /** Quantas unidades de distancia do sistema valem uma celula (ex.: 1.5). */
  unitsPerCell: number;
  unitLabel: string;
}

export interface Point {
  x: number;
  y: number;
}

/** Coordenada de celula: (a,b) = (x,y) na grid quadrada, (q,r) axial em hex. */
export interface Cell {
  a: number;
  b: number;
}

/** Segmento que bloqueia visao. */
export interface Wall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Porta: quando aberta, deixa de bloquear a visao. */
  door: boolean;
  open: boolean;
  /**
   * Janela: barra a passagem, mas nao a visao. Exclusiva com `door` — uma
   * janela nao abre, e uma porta fechada bloqueia as duas coisas.
   */
  window: boolean;
  /** Bloqueia visao mas nao e desenhada para o jogador. */
  hidden: boolean;
}

export type FogMode = 'off' | 'manual' | 'vision';

export interface FogConfig {
  mode: FogMode;
  /** Celulas ja exploradas por algum token de jogador (ficam em penumbra). */
  explored: string[];
  /** Celulas reveladas a mao pelo mestre (sempre visiveis). */
  revealed: string[];
  /** Celulas forcadas a escuro pelo mestre; vencem qualquer revelacao. */
  hidden: string[];
  /** Mantem em penumbra o que ja foi visto; se falso, so a visao atual aparece. */
  rememberExplored: boolean;
  /** Opacidade da area explorada mas fora da visao atual. */
  dimOpacity: number;
  /**
   * Suavidade da borda da neblina, de 0 a 1.
   *
   * Em 0, o recorte segue exatamente o poligono de cada celula e a silhueta
   * denuncia a grade. Acima disso a borda e composta por um desfoque, com
   * contorno arredondado e irregular, como nuvem. O preco e que a transicao
   * passa a revelar um pouco alem do limite exato das celulas — por isso e
   * ajustavel, e nao fixa.
   */
  edgeSoftness: number;

  /**
   * Preenchidos APENAS no payload enviado ao jogador quando
   * `settings.strictVision` esta ligado. Nesse modo o servidor calcula a
   * visao e nao envia as paredes da cena — mandar as paredes entregaria a
   * planta do mapa a quem abrisse o inspecionador de rede. Com strictVision
   * desligado estes campos vem vazios e o proprio cliente calcula a visao,
   * o que e mais fluido durante o arraste, porem confia no cliente.
   */
  computedVisible?: string[];
  computedExplored?: string[];
}

export type TokenVisibility = 'visible' | 'hidden' | 'dim';

/**
 * Como o token e desenhado no mapa.
 *
 * `circle` e a peca vista de cima: a arte e recortada num disco e cabe na
 * celula. `art` mostra a ilustracao inteira, de pe sobre a celula, com a
 * transparencia preservada — a figura sobe para fora do quadrado e a celula
 * vira o chao onde ela pisa.
 *
 * A escolha e so visual: a area que o token ocupa para movimento, visao e
 * alcance continua sendo `scale` celulas, independentemente da altura da arte.
 */
export type TokenShape = 'circle' | 'art';

export interface TokenBar {
  /** Id do campo do template de ficha (tipo `resource`) exibido como barra. */
  fieldId: string;
  color: string;
}

export interface Token {
  id: string;
  name: string;
  assetId: string | null;
  /** Cor de fallback quando nao ha imagem. */
  color: string;
  /** Canto superior esquerdo, em pixels do mapa. */
  x: number;
  y: number;
  /** Tamanho em celulas (1 = 1x1, 2 = 2x2 ...). */
  scale: number;
  rotation: number;
  layer: Layer;
  shape: TokenShape;
  visibility: TokenVisibility;
  opacity: number;
  /** Visivel apenas para o mestre, independente do fog. */
  gmOnly: boolean;
  /** Jogador dono (pode mover e enxerga pelo token). Null = do mestre. */
  ownerPlayerId: string | null;
  /** Ficha vinculada; alimenta as barras e a janela de atributos. */
  sheetId: string | null;
  /** Raio de visao em celulas. 0 = nao enxerga (nao revela fog). */
  visionRadius: number;
  /** Emite luz: revela fog para todos os jogadores, nao so para o dono. */
  lightRadius: number;
  bars: TokenBar[];
  /** Anotacao curta desenhada sob o token. */
  label: string;
  locked: boolean;
  conditions: string[];
}

/** Imagem colada no mapa nas camadas 1 e 2 (terreno, moveis, paredes). */
export interface Tile {
  id: string;
  assetId: string | null;
  color: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  layer: Layer;
  /** Bloqueia a visao dos tokens (o retangulo vira obstaculo). */
  blocksVision: boolean;
  gmOnly: boolean;
  locked: boolean;
}

export type EffectAnchorMode = 'grid' | 'token' | 'free';

/**
 * Como a area do efeito e pintada.
 *
 * A forma (`kind`) diz ONDE o efeito pega; o estilo diz com que cara ele
 * aparece. Separar os dois deixa qualquer aparencia disponivel para qualquer
 * forma — um cone de runas e um retangulo de neblina usam o mesmo caminho de
 * recorte e trocam so o preenchimento.
 */
export type EffectStyle =
  | 'flat'
  | 'glow'
  | 'pulse'
  | 'runes'
  | 'vortex'
  | 'mist'
  | 'embers'
  | 'static';

/**
 * Efeito de mapa: area de magia, marcador ou texto. Pode ser fixado a uma
 * celula da grid, preso a um token (acompanha o movimento) ou solto em
 * qualquer coordenada, sem snap.
 */
export interface MapEffect {
  id: string;
  kind: 'circle' | 'cone' | 'rect' | 'line' | 'text' | 'image';
  label: string;
  color: string;
  opacity: number;
  assetId: string | null;
  anchor: EffectAnchorMode;
  /** anchor = 'grid': celula onde esta fixado. */
  cell: Cell | null;
  /** anchor = 'token': token que ele acompanha. */
  tokenId: string | null;
  /** Deslocamento relativo a ancora, ou posicao absoluta quando 'free'. */
  x: number;
  y: number;
  /** Raio/comprimento em celulas, para circle, cone e line. */
  radius: number;
  /** Dimensoes em celulas, para rect. */
  width: number;
  height: number;
  /** Direcao em graus, para cone e line. */
  angle: number;
  /** Abertura do cone, em graus. */
  spread: number;
  layer: Layer;
  visibility: TokenVisibility;
  gmOnly: boolean;
  fontSize: number;
  style: EffectStyle;
  /** Cor secundaria; os estilos que a usam fazem degrade entre as duas. */
  colorAlt: string;
  /** Multiplicador de velocidade da animacao. 0 congela o efeito. */
  speed: number;
}

export type WeatherKind = 'none' | 'rain' | 'snow' | 'fog' | 'ash';

/**
 * Clima da cena.
 *
 * E atmosfera, nao regra: nao afeta visao nem movimento. Desenhado em
 * coordenadas de TELA, e nao do mapa — chuva cai na frente da camera, e nao
 * fica presa a um canto do terreno quando a pessoa arrasta o mapa.
 */
export interface WeatherConfig {
  kind: WeatherKind;
  /** 0 a 1: densidade das particulas. */
  intensity: number;
  /** Inclinacao em graus; 0 e vertical. Vento. */
  angle: number;
}

export interface Scene {
  id: string;
  name: string;
  order: number;
  backgroundAssetId: string | null;
  backgroundColor: string;
  /** Dimensoes do mapa em pixels (definem os limites de pan). */
  width: number;
  height: number;
  grid: GridConfig;
  fog: FogConfig;
  walls: Wall[];
  tiles: Tile[];
  tokens: Token[];
  effects: MapEffect[];
  /** 1 = dia claro; 0 = escuridao total, so a visao dos tokens ilumina. */
  globalLight: number;
  weather: WeatherConfig;
}

// ---------------------------------------------------------------------------
// Fichas configuraveis
// ---------------------------------------------------------------------------

export type FieldType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'boolean'
  | 'select'
  | 'resource'
  | 'inventory'
  | 'image';

export interface SheetField {
  id: string;
  label: string;
  type: FieldType;
  sectionId: string;
  order: number;
  /** Jogador ve, mas nao edita (ex.: nivel, definido pelo mestre). */
  locked: boolean;
  /** Apenas o mestre ve o campo (ex.: motivacao secreta do NPC). */
  gmOnly: boolean;
  description: string;
  /** number / resource */
  min: number | null;
  max: number | null;
  step: number | null;
  /** select */
  options: string[];
  /** resource: cor da barra e se aparece no token */
  color: string;
  showOnToken: boolean;
  /** Largura no layout: 1 = 1/3, 2 = 2/3, 3 = linha inteira. */
  span: 1 | 2 | 3;
  defaultValue: FieldValue;
  /**
   * Formula de rolagem opcional, que torna o campo clicavel.
   *
   * Aceita referencias a outros campos da mesma ficha com `@id`, por exemplo
   * `1d20+@destreza`. Vazio significa que o campo nao rola nada. Como o
   * sistema de regras e do mestre, a formula tambem e — nao ha nada embutido
   * aqui sobre como um teste funciona.
   */
  rollFormula: string;
}

export interface SheetSection {
  id: string;
  label: string;
  order: number;
  collapsed: boolean;
}

export interface SheetTemplate {
  name: string;
  sections: SheetSection[];
  fields: SheetField[];
}

export interface ResourceValue {
  current: number;
  max: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  assetId: string | null;
  description: string;
  equipped: boolean;
}

export type FieldValue =
  | string
  | number
  | boolean
  | ResourceValue
  | InventoryItem[]
  | null;

export interface Sheet {
  id: string;
  name: string;
  portraitAssetId: string | null;
  /** Jogador dono. Null = ficha de NPC/monstro do mestre. */
  ownerPlayerId: string | null;
  values: Record<string, FieldValue>;
  /** Visivel para os demais jogadores (ex.: aliado do grupo). */
  sharedWithParty: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Participantes, iniciativa e mesa
// ---------------------------------------------------------------------------

export interface Player {
  id: string;
  name: string;
  role: Role;
  color: string;
  connected: boolean;
  lastSeen: number;
  /** Ficha principal do jogador. */
  sheetId: string | null;
  /**
   * Retrato da ficha principal, para a lista de presenca no cabecalho.
   * Derivado no envio, nunca gravado: a fonte de verdade e a ficha.
   */
  portraitAssetId?: string | null;
}

export interface InitiativeEntry {
  id: string;
  tokenId: string | null;
  name: string;
  value: number;
  /** Desempate manual. */
  tiebreak: number;
  playerId: string | null;
  /** Continua listado, mas o turno pula (ex.: inconsciente). */
  skipped: boolean;
  hiddenFromPlayers: boolean;
}

export interface InitiativeState {
  active: boolean;
  round: number;
  activeEntryId: string | null;
  entries: InitiativeEntry[];
  /** Turno avanca sozinho ao fim do tempo, em vez de so pelo mestre. */
  autoAdvance: boolean;
  /** Segundos por turno quando autoAdvance esta ligado. 0 = sem limite. */
  turnSeconds: number;
}

export interface TableSettings {
  /** Jogadores movem apenas os proprios tokens. */
  playersMoveOwnTokensOnly: boolean;
  /** Jogadores veem as barras de recurso dos tokens dos outros. */
  showPartyBars: boolean;
  /** Servidor omite tokens fora da visao (mais seguro, custa CPU). */
  strictVision: boolean;
  /**
   * Paredes barram o movimento dos tokens, e nao apenas a visao.
   *
   * Vale so para os jogadores: o mestre precisa posicionar NPCs em qualquer
   * lugar, inclusive dentro de uma parede enquanto monta a cena.
   */
  wallsBlockMovement: boolean;
  /** Jogadores podem criar anotacoes na camada 4. */
  playersCanAnnotate: boolean;
  diceEnabled: boolean;
}

export type AssetKind = 'map' | 'token' | 'portrait' | 'item' | 'effect' | 'tile';

export interface Asset {
  id: string;
  kind: AssetKind;
  url: string;
  thumbUrl: string | null;
  originalName: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
  uploadedBy: string | null;
}

export interface DiceRoll {
  formula: string;
  rolls: number[];
  modifier: number;
  total: number;
}

export interface ChatMessage {
  id: string;
  playerId: string | null;
  authorName: string;
  authorColor: string;
  text: string;
  roll: DiceRoll | null;
  /** Nome do que foi rolado (ex.: "Percepcao"), quando veio de uma ficha. */
  rollLabel: string | null;
  /** Sussurro: apenas o mestre e o autor recebem. */
  whisper: boolean;
  createdAt: number;
}

/**
 * Material entregue ao grupo: a carta encontrada, o retrato do NPC, o mapa
 * da regiao.
 *
 * Fica guardado na mesa como preparacao do mestre e so aparece para quem ele
 * escolher — por isso o compartilhamento e explicito, e nao um efeito de ter
 * criado o material.
 */
export interface Handout {
  id: string;
  title: string;
  text: string;
  assetId: string | null;
  /** Jogadores especificos com acesso. Ignorado quando `sharedWithAll`. */
  sharedWith: string[];
  sharedWithAll: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Estado completo da mesa. O jogador recebe uma versao filtrada disto. */
export interface TableState {
  id: string;
  code: string;
  name: string;
  activeSceneId: string | null;
  settings: TableSettings;
  sheetTemplate: SheetTemplate;
  initiative: InitiativeState;
  scenes: Scene[];
  players: Player[];
  sheets: Sheet[];
  assets: Asset[];
  handouts: Handout[];
  chat: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Identidade devolvida no login e reaproveitada na reconexao. */
export interface Session {
  tableId: string;
  tableCode: string;
  playerId: string;
  role: Role;
  token: string;
  name: string;
}
