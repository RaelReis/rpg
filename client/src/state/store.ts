import { create } from 'zustand';
import {
  createDefaultTemplate,
  DEFAULT_INITIATIVE,
  DEFAULT_SETTINGS,
  type Asset,
  type ChatMessage,
  type CursorMove,
  type FogPatch,
  type InitiativeState,
  type MapEffect,
  type MapPing,
  type Player,
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

export type SideTab = 'scene' | 'tokens' | 'sheet' | 'initiative' | 'chat' | 'assets' | 'players';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface ActivePing extends MapPing {
  id: number;
  createdAt: number;
}

export interface PeerCursor extends CursorMove {
  updatedAt: number;
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
  selectedTokenId: string | null;
  selectedSheetId: string | null;
  selectedAssetId: string | null;
  sideTab: SideTab;
  sideOpen: boolean;
  camera: Camera;
  /** Camadas ocultas na visao do mestre (nao afeta o que o jogador recebe). */
  hiddenLayers: number[];
  /** Sobrepoe no mapa do mestre ate onde o grupo enxerga. */
  showPartyVision: boolean;
  notices: Notice[];
  peers: Record<string, PeerCursor>;
  pings: ActivePing[];
  templateEditorOpen: boolean;
  sheetModalId: string | null;

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
  addChatMessage(message: ChatMessage): void;

  // --- interface
  setTool(tool: Tool): void;
  selectToken(id: string | null): void;
  selectSheet(id: string | null): void;
  selectAsset(id: string | null): void;
  setSideTab(tab: SideTab): void;
  toggleSide(): void;
  setCamera(camera: Camera): void;
  toggleLayer(layer: number): void;
  togglePartyVision(): void;
  notify(level: Notice['level'], message: string): void;
  dismissNotice(id: number): void;
  setPeer(cursor: CursorMove): void;
  removePeer(playerId: string): void;
  addPing(ping: MapPing): void;
  prunePings(): void;
  openTemplateEditor(open: boolean): void;
  openSheetModal(sheetId: string | null): void;
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
  selectedTokenId: null,
  selectedSheetId: null,
  selectedAssetId: null,
  sideTab: 'chat',
  sideOpen: true,
  camera: { x: 0, y: 0, zoom: 1 },
  hiddenLayers: [],
  showPartyVision: false,
  notices: [],
  peers: {},
  pings: [],
  templateEditorOpen: false,
  sheetModalId: null,

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

  clearTable: () => set({ table: null, rev: 0, selectedTokenId: null, peers: {}, pings: [] }),

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
    set((s) => (s.table ? { table: { ...s.table, activeSceneId: sceneId }, rev: s.rev + 1 } : {})),

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
        ? {
            rev: s.rev + 1,
            selectedTokenId: gone.has(s.selectedTokenId ?? '') ? null : s.selectedTokenId,
          }
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
        // O reset chega quando o servidor recalcula a visao do jogador ou
        // quando o mestre limpa a neblina: substitui, nao acumula.
        if (patch.reset) {
          if (patch.reset.explored) {
            scene.fog.computedExplored = patch.reset.explored;
            scene.fog.explored = patch.reset.explored;
          }
          if (patch.reset.revealed) {
            scene.fog.computedVisible = patch.reset.revealed;
            scene.fog.revealed = patch.reset.revealed;
          }
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

  addChatMessage: (message) =>
    set((s) => {
      if (!s.table) return {};
      const chat = [...s.table.chat, message].slice(-200);
      return { table: { ...s.table, chat }, rev: s.rev + 1 };
    }),

  setTool: (tool) => set({ tool }),
  selectToken: (selectedTokenId) => set({ selectedTokenId }),
  selectSheet: (selectedSheetId) => set({ selectedSheetId }),
  selectAsset: (selectedAssetId) => set({ selectedAssetId }),
  setSideTab: (sideTab) => set({ sideTab, sideOpen: true }),
  toggleSide: () => set((s) => ({ sideOpen: !s.sideOpen })),
  setCamera: (camera) => set({ camera }),

  toggleLayer: (layer) =>
    set((s) => ({
      hiddenLayers: s.hiddenLayers.includes(layer)
        ? s.hiddenLayers.filter((l) => l !== layer)
        : [...s.hiddenLayers, layer],
    })),

  togglePartyVision: () => set((s) => ({ showPartyVision: !s.showPartyVision })),

  notify: (level, message) => {
    const id = ++noticeSeq;
    set((s) => ({ notices: [...s.notices, { id, level, message }] }));
    setTimeout(() => get().dismissNotice(id), level === 'error' ? 6500 : 4000);
  },

  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  setPeer: (cursor) =>
    set((s) => ({ peers: { ...s.peers, [cursor.playerId]: { ...cursor, updatedAt: Date.now() } } })),

  removePeer: (playerId) =>
    set((s) => {
      const peers = { ...s.peers };
      delete peers[playerId];
      return { peers };
    }),

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
