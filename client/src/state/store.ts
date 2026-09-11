import { create } from 'zustand';
import {
  createDefaultTemplate,
  DEFAULT_INITIATIVE,
  DEFAULT_SETTINGS,
  type Asset,
  type ChatMessage,
  type FogPatch,
  type Handout,
  type InitiativeState,
  type MapEffect,
  type MapPing,
  type Player,
  type Point,
  type Scene,
  type Session,
  type Sheet,
  type SheetTemplate,
  type TableSettings,
  type TableState,
  type Tile,
  type Token,
  type Wall,
} from '@rpg/shared';

/**
 * Estado do cliente.
 *
 * Duas velocidades convivem aqui de proposito:
 *
 *  - Mudancas estruturais (fichas, iniciativa, jogadores, listas) incrementam
 *    `rev`, e os componentes React reagem a isso.
 *  - Movimento de token NAO mexe em `rev`. Um arraste emite dezenas de
 *    posicoes por segundo; se cada uma re-renderizasse a arvore React, a
 *    interface engasgaria. O canvas le o estado direto a cada quadro, entao
 *    para ele basta mutar o objeto.
 */

export type Tool =
  | 'select'
  | 'pan'
  | 'measure'
  | 'ping'
  | 'fog-reveal'
  | 'fog-hide'
  | 'wall'
  | 'effect'
  | 'tile';

export type SideTab =
  | 'scene'
  | 'tokens'
  | 'sheet'
  | 'initiative'
  | 'chat'
  | 'handouts'
  | 'assets'
  | 'players';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Uma acao de mapa que pode ser desfeita e refeita pelo mestre.
 *
 * Os dois sentidos ficam na mesma entrada porque recriar muda a identidade:
 * desfazer uma exclusao cria um objeto com id novo, e o refazer seguinte tem
 * de apagar ESSE id, nao o original. Quem monta a entrada guarda o id numa
 * variavel que os dois lados compartilham.
 */
export interface UndoEntry {
  label: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

/** O que a ferramenta de parede desenha a cada clique. */
export type WallKind = 'wall' | 'door' | 'window';

/** O que esta sendo arrastado para o mapa, para a previa de onde vai cair. */
export type DragPayload =
  | { kind: 'sheet'; sheetId: string }
  | { kind: 'asset'; assetId: string; assetKind: string };

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface ActivePing extends MapPing {
  id: number;
  createdAt: number;
}

interface AppState {
  // --- conexao e identidade
  session: Session | null;
  connected: boolean;
  joining: boolean;

  // --- dados da mesa
  table: TableState | null;
  /** Contador de mudancas estruturais; a UI React observa isto. */
  rev: number;

  // --- interface
  tool: Tool;
  /** Selecao de tokens; multipla, para mover ou apagar um grupo de uma vez. */
  selectedTokenIds: string[];
  selectedTileId: string | null;
  selectedWallId: string | null;
  selectedSheetId: string | null;
  selectedAssetId: string | null;
  sideTab: SideTab;
  sideOpen: boolean;
  camera: Camera;
  /** Camadas ocultas na visao do mestre (nao afeta o que o jogador recebe). */
  hiddenLayers: number[];
  /** Sobrepoe no mapa do mestre ate onde o grupo enxerga. */
  showPartyVision: boolean;
  /**
   * Mestre olhando a cena pelos olhos deste jogador.
   *
   * E ferramenta de conferencia: o mestre enxerga tudo por definicao, entao
   * nao tem como saber se a porta que abriu realmente liberou a visao de
   * alguem sem entrar na pele daquela pessoa.
   */
  previewPlayerId: string | null;
  /** Medidor de quadros sobre o mapa (tecla G). */
  showPerf: boolean;
  /** Raio do pincel de neblina, em celulas. */
  fogBrush: number;
  /**
   * Ponto onde o proximo trecho de parede comeca.
   *
   * Cada clique grava o trecho na hora; o rascunho guarda so a ponta solta,
   * para a previa ate o cursor e para o proximo clique continuar dali.
   */
  wallDraft: Point[];
  /** O que o proximo trecho vira. Alt no clique faz uma porta avulsa. */
  wallKind: WallKind;
  /** Ficha ou imagem sendo arrastada sobre o mapa, se houver. */
  dragging: DragPayload | null;
  /** Pincel livre ou area retangular. */
  fogShape: 'brush' | 'rect';
  /**
   * Ao cobrir, selar a area em vez de apenas fecha-la.
   *
   * Coberta, a area volta a ser descobrivel por quem andar ate la; selada,
   * nem a visao dos tokens a revela. O padrao e o gesto mais comum — cobrir.
   */
  fogSeal: boolean;
  /**
   * Historico de desfazer, apenas local e apenas do mestre.
   *
   * Nao e um desfazer colaborativo: cada acao guarda como se reverter, e a
   * reversao viaja como uma operacao nova. Desfazer a exclusao de um token
   * recria um token igual, com id novo — o suficiente para consertar um erro
   * no meio da sessao, sem a complexidade de sincronizar historicos.
   */
  undoStack: UndoEntry[];
  /** O que foi desfeito e ainda pode voltar. Qualquer acao nova o esvazia. */
  redoStack: UndoEntry[];
  notices: Notice[];
  pings: ActivePing[];
  templateEditorOpen: boolean;
  sheetModalId: string | null;
  /** Material aberto na tela, por escolha propria ou apresentado pelo mestre. */
  openHandoutId: string | null;
  /** Mensagens de chat chegadas enquanto a aba estava em outro painel. */
  unreadChat: number;

  // --- acoes de sessao
  setSession(session: Session | null): void;
  setConnected(connected: boolean): void;
  setJoining(joining: boolean): void;

  // --- acoes de estado da mesa
  setTable(table: TableState): void;
  clearTable(): void;
  patchScene(sceneId: string, patch: Partial<Scene>): void;
  removeScene(sceneId: string): void;
  setActiveScene(sceneId: string): void;
  upsertTokens(sceneId: string, tokens: Token[]): void;
  removeTokens(sceneId: string, ids: string[]): void;
  moveTokenLocal(sceneId: string, tokenId: string, x: number, y: number): void;
  upsertTiles(sceneId: string, tiles: Tile[], remove: string[]): void;
  upsertEffects(sceneId: string, effects: MapEffect[], remove: string[]): void;
  upsertWalls(sceneId: string, walls: Wall[], remove: string[]): void;
  applyFogPatch(patch: FogPatch): void;
  upsertSheets(sheets: Sheet[], remove: string[]): void;
  setTemplate(template: SheetTemplate): void;
  setPlayers(players: Player[]): void;
  setInitiative(initiative: InitiativeState): void;
  setSettings(settings: TableSettings): void;
  setTableName(name: string): void;
  upsertAssets(assets: Asset[], remove: string[]): void;
  upsertHandouts(handouts: Handout[], remove: string[]): void;
  addChatMessage(message: ChatMessage): void;

  // --- interface
  setTool(tool: Tool): void;
  selectToken(id: string | null): void;
  toggleTokenSelection(id: string): void;
  selectTokens(ids: string[]): void;
  selectTile(id: string | null): void;
  selectWall(id: string | null): void;
  setFogBrush(radius: number): void;
  setWallDraft(points: Point[]): void;
  setWallKind(kind: WallKind): void;
  setDragging(payload: DragPayload | null): void;
  setFogShape(shape: 'brush' | 'rect'): void;
  setFogSeal(seal: boolean): void;
  pushUndo(entry: UndoEntry): void;
  undo(): void;
  redo(): void;
  selectSheet(id: string | null): void;
  selectAsset(id: string | null): void;
  setSideTab(tab: SideTab): void;
  toggleSide(): void;
  setCamera(camera: Camera): void;
  toggleLayer(layer: number): void;
  togglePartyVision(): void;
  setPreviewPlayer(playerId: string | null): void;
  togglePerf(): void;
  notify(level: Notice['level'], message: string): void;
  dismissNotice(id: number): void;
  addPing(ping: MapPing): void;
  prunePings(): void;
  openTemplateEditor(open: boolean): void;
  openSheetModal(sheetId: string | null): void;
  openHandout(handoutId: string | null): void;
}

let noticeSeq = 0;
let pingSeq = 0;

/** Muta a cena e devolve `true` se ela existe — evita repetir a busca. */
function withScene(table: TableState | null, sceneId: string, fn: (scene: Scene) => void): boolean {
  const scene = table?.scenes.find((s) => s.id === sceneId);
  if (!scene) return false;
  fn(scene);
  return true;
}

function mergeById<T extends { id: string }>(list: T[], upsert: T[], remove: string[]): T[] {
  const removed = new Set(remove);
  const byId = new Map(list.filter((i) => !removed.has(i.id)).map((i) => [i.id, i]));
  for (const item of upsert) byId.set(item.id, item);
  return [...byId.values()];
}

export const useStore = create<AppState>((set, get) => ({
  session: null,
  connected: false,
  joining: false,
  table: null,
  rev: 0,

  tool: 'select',
  selectedTokenIds: [],
  selectedTileId: null,
  selectedWallId: null,
  selectedSheetId: null,
  selectedAssetId: null,
  sideTab: 'chat',
  sideOpen: true,
  camera: { x: 0, y: 0, zoom: 1 },
  hiddenLayers: [],
  showPartyVision: false,
  previewPlayerId: null,
  showPerf: false,
  fogBrush: 1,
  fogShape: 'brush',
  fogSeal: false,
  wallDraft: [],
  wallKind: 'wall',
  dragging: null,
  undoStack: [],
  redoStack: [],
  notices: [],
  pings: [],
  templateEditorOpen: false,
  sheetModalId: null,
  openHandoutId: null,
  unreadChat: 0,

  setSession: (session) => set({ session }),
  setConnected: (connected) => set({ connected }),
  setJoining: (joining) => set({ joining }),

  setTable: (table) =>
    set((s) => ({
      table,
      rev: s.rev + 1,
      // A ficha propria e o ponto de partida natural para o jogador.
      selectedSheetId:
        s.selectedSheetId && table.sheets.some((sh) => sh.id === s.selectedSheetId)
          ? s.selectedSheetId
          : (table.players.find((p) => p.id === s.session?.playerId)?.sheetId ??
            table.sheets.find((sh) => sh.ownerPlayerId === s.session?.playerId)?.id ??
            null),
    })),

  clearTable: () =>
    set({
      table: null,
      rev: 0,
      selectedTokenIds: [],
      selectedTileId: null,
      selectedWallId: null,
      pings: [],
      undoStack: [],
      redoStack: [],
      wallDraft: [],
    }),

  patchScene: (sceneId, patch) =>
    set((s) => {
      if (!s.table) return {};
      const scenes = s.table.scenes.slice();
      const index = scenes.findIndex((sc) => sc.id === sceneId);
      if (index === -1) scenes.push(patch as Scene);
      else scenes[index] = { ...scenes[index], ...patch };
      return { table: { ...s.table, scenes }, rev: s.rev + 1 };
    }),

  removeScene: (sceneId) =>
    set((s) => {
      if (!s.table) return {};
      return {
        table: { ...s.table, scenes: s.table.scenes.filter((sc) => sc.id !== sceneId) },
        rev: s.rev + 1,
      };
    }),

  setActiveScene: (sceneId) =>
    set((s) => {
      if (!s.table) return {};
      // O historico e por cena: desfazer algo de outro mapa aconteceria fora
      // da vista, e a pessoa nao veria o efeito do proprio Ctrl+Z.
      const changed = s.table.activeSceneId !== sceneId;
      return {
        table: { ...s.table, activeSceneId: sceneId },
        rev: s.rev + 1,
        undoStack: changed ? [] : s.undoStack,
        redoStack: changed ? [] : s.redoStack,
        wallDraft: changed ? [] : s.wallDraft,
        selectedTokenIds: changed ? [] : s.selectedTokenIds,
        selectedTileId: changed ? null : s.selectedTileId,
        selectedWallId: changed ? null : s.selectedWallId,
      };
    }),

  upsertTokens: (sceneId, tokens) =>
    set((s) => {
      const changed = withScene(s.table, sceneId, (scene) => {
        scene.tokens = mergeById(scene.tokens, tokens, []);
      });
      return changed ? { rev: s.rev + 1 } : {};
    }),

  removeTokens: (sceneId, ids) =>
    set((s) => {
      const gone = new Set(ids);
      const changed = withScene(s.table, sceneId, (scene) => {
        scene.tokens = scene.tokens.filter((t) => !gone.has(t.id));
      });
      return changed
        ? { rev: s.rev + 1, selectedTokenIds: s.selectedTokenIds.filter((id) => !gone.has(id)) }
        : {};
    }),

  /**
   * Caminho quente: nao incrementa `rev` de proposito. O canvas le a posicao
   * do objeto a cada quadro, entao a mutacao ja e suficiente.
   */
  moveTokenLocal: (sceneId, tokenId, x, y) => {
    const table = get().table;
    withScene(table, sceneId, (scene) => {
      const token = scene.tokens.find((t) => t.id === tokenId);
      if (token) {
        token.x = x;
        token.y = y;
      }
    });
  },

  upsertTiles: (sceneId, tiles, remove) =>
    set((s) => {
      const changed = withScene(s.table, sceneId, (scene) => {
        scene.tiles = mergeById(scene.tiles, tiles, remove);
      });
      return changed ? { rev: s.rev + 1 } : {};
    }),

  upsertEffects: (sceneId, effects, remove) =>
    set((s) => {
      const changed = withScene(s.table, sceneId, (scene) => {
        scene.effects = mergeById(scene.effects, effects, remove);
      });
      return changed ? { rev: s.rev + 1 } : {};
    }),

  upsertWalls: (sceneId, walls, remove) =>
    set((s) => {
      const changed = withScene(s.table, sceneId, (scene) => {
        scene.walls = mergeById(scene.walls, walls, remove);
      });
      return changed ? { rev: s.rev + 1 } : {};
    }),

  applyFogPatch: (patch) =>
    set((s) => {
      const changed = withScene(s.table, patch.sceneId, (scene) => {
        // Visao ja calculada pelo servidor (strictVision): substitui o que o
        // jogador enxerga. Nao toca as listas cruas, que nesse modo ficam
        // vazias no cliente, exatamente como o estado completo as entrega.
        if (patch.computed) {
          scene.fog.computedVisible = patch.computed.visible;
          scene.fog.computedExplored = patch.computed.explored;
          return;
        }

        // Reset das listas cruas, feito pelo mestre: substitui, nao acumula.
        if (patch.reset) {
          if (patch.reset.explored) scene.fog.explored = patch.reset.explored;
          if (patch.reset.revealed) scene.fog.revealed = patch.reset.revealed;
          if (patch.reset.hidden) scene.fog.hidden = patch.reset.hidden;
          return;
        }

        const apply = (list: string[], set?: { add?: string[]; remove?: string[] }): string[] => {
          if (!set) return list;
          let out = list;
          if (set.remove?.length) {
            const gone = new Set(set.remove);
            out = out.filter((c) => !gone.has(c));
          }
          if (set.add?.length) out = [...out, ...set.add];
          return out;
        };

        scene.fog.explored = apply(scene.fog.explored, patch.explored);
        scene.fog.revealed = apply(scene.fog.revealed, patch.revealed);
        scene.fog.hidden = apply(scene.fog.hidden, patch.hidden);
      });
      return changed ? { rev: s.rev + 1 } : {};
    }),

  upsertSheets: (sheets, remove) =>
    set((s) => {
      if (!s.table) return {};
      return {
        table: { ...s.table, sheets: mergeById(s.table.sheets, sheets, remove) },
        rev: s.rev + 1,
      };
    }),

  setTemplate: (template) =>
    set((s) => (s.table ? { table: { ...s.table, sheetTemplate: template }, rev: s.rev + 1 } : {})),

  setPlayers: (players) =>
    set((s) => (s.table ? { table: { ...s.table, players }, rev: s.rev + 1 } : {})),

  setInitiative: (initiative) =>
    set((s) => (s.table ? { table: { ...s.table, initiative }, rev: s.rev + 1 } : {})),

  setSettings: (settings) =>
    set((s) => (s.table ? { table: { ...s.table, settings }, rev: s.rev + 1 } : {})),

  setTableName: (name) => set((s) => (s.table ? { table: { ...s.table, name }, rev: s.rev + 1 } : {})),

  upsertAssets: (assets, remove) =>
    set((s) => {
      if (!s.table) return {};
      return {
        table: { ...s.table, assets: mergeById(s.table.assets, assets, remove) },
        rev: s.rev + 1,
      };
    }),

  upsertHandouts: (handouts, remove) =>
    set((s) => {
      if (!s.table) return {};
      return {
        table: { ...s.table, handouts: mergeById(s.table.handouts, handouts, remove) },
        rev: s.rev + 1,
        // Um material removido nao pode continuar aberto na tela de ninguem.
        openHandoutId: remove.includes(s.openHandoutId ?? '') ? null : s.openHandoutId,
      };
    }),

  addChatMessage: (message) =>
    set((s) => {
      if (!s.table) return {};
      const chat = [...s.table.chat, message].slice(-200);
      // A propria mensagem nunca conta como nao lida.
      const mine = message.playerId === s.session?.playerId;
      const reading = s.sideTab === 'chat' && s.sideOpen;
      return {
        table: { ...s.table, chat },
        rev: s.rev + 1,
        unreadChat: mine || reading ? s.unreadChat : s.unreadChat + 1,
      };
    }),

  setTool: (tool) => set({ tool }),
  selectToken: (id) =>
    set({ selectedTokenIds: id ? [id] : [], selectedTileId: null, selectedWallId: null }),

  toggleTokenSelection: (id) =>
    set((s) => ({
      selectedTokenIds: s.selectedTokenIds.includes(id)
        ? s.selectedTokenIds.filter((t) => t !== id)
        : [...s.selectedTokenIds, id],
      selectedTileId: null,
      selectedWallId: null,
    })),

  selectTokens: (ids) => set({ selectedTokenIds: ids, selectedTileId: null, selectedWallId: null }),
  selectTile: (selectedTileId) =>
    set({ selectedTileId, selectedTokenIds: [], selectedWallId: null }),
  selectWall: (selectedWallId) =>
    set({ selectedWallId, selectedTokenIds: [], selectedTileId: null }),
  setFogBrush: (radius) => set({ fogBrush: Math.min(8, Math.max(0, Math.round(radius))) }),
  setFogShape: (fogShape) => set({ fogShape }),
  setFogSeal: (fogSeal) => set({ fogSeal }),
  setWallDraft: (wallDraft) => set({ wallDraft }),
  setWallKind: (wallKind) => set({ wallKind }),
  setDragging: (dragging) => set({ dragging }),

  // Acao nova depois de um desfazer abre outro galho da historia: o que
  // estava para refazer deixa de fazer sentido.
  pushUndo: (entry) => set((s) => ({ undoStack: [...s.undoStack, entry].slice(-50), redoStack: [] })),

  undo: () => {
    const stack = get().undoStack;
    const entry = stack[stack.length - 1];
    if (!entry) {
      get().notify('info', 'Nada para desfazer.');
      return;
    }
    set((s) => ({ undoStack: stack.slice(0, -1), redoStack: [...s.redoStack, entry].slice(-50) }));
    void Promise.resolve(entry.undo()).then(() => get().notify('info', `Desfeito: ${entry.label}`));
  },

  redo: () => {
    const stack = get().redoStack;
    const entry = stack[stack.length - 1];
    if (!entry) {
      get().notify('info', 'Nada para refazer.');
      return;
    }
    set((s) => ({ redoStack: stack.slice(0, -1), undoStack: [...s.undoStack, entry].slice(-50) }));
    void Promise.resolve(entry.redo()).then(() => get().notify('info', `Refeito: ${entry.label}`));
  },
  selectSheet: (selectedSheetId) => set({ selectedSheetId }),
  selectAsset: (selectedAssetId) => set({ selectedAssetId }),
  setSideTab: (sideTab) =>
    set((s) => ({ sideTab, sideOpen: true, unreadChat: sideTab === 'chat' ? 0 : s.unreadChat })),
  toggleSide: () => set((s) => ({ sideOpen: !s.sideOpen })),
  setCamera: (camera) => set({ camera }),

  toggleLayer: (layer) =>
    set((s) => ({
      hiddenLayers: s.hiddenLayers.includes(layer)
        ? s.hiddenLayers.filter((l) => l !== layer)
        : [...s.hiddenLayers, layer],
    })),

  togglePartyVision: () => set((s) => ({ showPartyVision: !s.showPartyVision })),
  togglePerf: () => set((s) => ({ showPerf: !s.showPerf })),

  setPreviewPlayer: (previewPlayerId) =>
    // A previa e so de leitura: manter uma selecao ativa convidaria a editar
    // o mapa enquanto se olha pela perspectiva de outra pessoa.
    set({ previewPlayerId, selectedTokenIds: [], selectedTileId: null, selectedWallId: null }),

  notify: (level, message) => {
    const id = ++noticeSeq;
    set((s) => ({ notices: [...s.notices, { id, level, message }] }));
    setTimeout(() => get().dismissNotice(id), level === 'error' ? 6500 : 4000);
  },

  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  addPing: (ping) =>
    set((s) => ({ pings: [...s.pings, { ...ping, id: ++pingSeq, createdAt: Date.now() }] })),

  prunePings: () =>
    set((s) => {
      const cutoff = Date.now() - 2600;
      const kept = s.pings.filter((p) => p.createdAt > cutoff);
      return kept.length === s.pings.length ? {} : { pings: kept };
    }),

  openTemplateEditor: (templateEditorOpen) => set({ templateEditorOpen }),
  openSheetModal: (sheetModalId) => set({ sheetModalId }),
  openHandout: (openHandoutId) => set({ openHandoutId }),
}));

// ---------------------------------------------------------------------------
// Seletores
// ---------------------------------------------------------------------------

export function activeScene(state: AppState = useStore.getState()): Scene | null {
  const table = state.table;
  if (!table) return null;
  return table.scenes.find((s) => s.id === table.activeSceneId) ?? table.scenes[0] ?? null;
}

export function isGm(state: AppState = useStore.getState()): boolean {
  return state.session?.role === 'GM';
}

export function myPlayerId(state: AppState = useStore.getState()): string | null {
  return state.session?.playerId ?? null;
}

export function tableSettings(state: AppState = useStore.getState()): TableSettings {
  return state.table?.settings ?? DEFAULT_SETTINGS;
}

export function sheetTemplate(state: AppState = useStore.getState()): SheetTemplate {
  return state.table?.sheetTemplate ?? createDefaultTemplate();
}

export function initiativeState(state: AppState = useStore.getState()): InitiativeState {
  return state.table?.initiative ?? DEFAULT_INITIATIVE;
}

export function findSheet(id: string | null | undefined): Sheet | null {
  if (!id) return null;
  return useStore.getState().table?.sheets.find((s) => s.id === id) ?? null;
}

export function findAsset(id: string | null | undefined): Asset | null {
  if (!id) return null;
  return useStore.getState().table?.assets.find((a) => a.id === id) ?? null;
}
