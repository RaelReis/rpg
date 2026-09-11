import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHARACTER_VISION_RADIUS,
  cellAt,
  cellCorners,
  cellKey,
  cellsWithinRadius,
  measureDistance,
  snapTokenPosition,
  tokenBarFields,
  type Point,
  type Scene,
  type Tile,
  type Token,
  type Wall,
} from '@rpg/shared';

import { act, emit } from '../net/socket';
import { activeScene, findAsset, findSheet, useStore, type WallKind } from '../state/store';
import {
  centerOn,
  clampCamera,
  fitScene,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera,
} from './camera';
import { onImageReady } from './images';
import {
  boxPivot,
  handleAtPoint,
  renderScene,
  invalidateFogMask,
  soleSelectionBox,
  tileAtPoint,
  tokenAtPoint,
  tokensInRect,
  wallAtPoint,
  type Box,
  type HandleId,
  type MarqueeKind,
} from './render';
import { partyVision, resolveVision } from './vision';

/**
 * O palco: canvas do mapa e toda a interacao de ponteiro.
 *
 * A camera vive em um ref, nao no estado do React. Um gesto de pan produz
 * dezenas de quadros por segundo, e passar cada um pelo React re-renderizaria
 * paineis, listas e fichas sem necessidade. O React so e avisado do zoom, e
 * mesmo assim com folga, porque ele aparece no canto da tela.
 */

type GestureKind =
  | 'none'
  | 'pan'
  | 'drag-token'
  | 'measure'
  | 'fog-brush'
  | 'fog-rect'
  | 'marquee'
  | 'tile'
  | 'handle';

interface Gesture {
  kind: GestureKind;
  /** Botao que iniciou o gesto; o direito sem arraste abre o menu de contexto. */
  button: number;
  startScreen: Point;
  startWorld: Point;
  cameraStart: Camera;
  /** Token sob o cursor no inicio do arraste. */
  tokenId: string | null;
  tokenOffset: Point;
  /** Posicao inicial de cada token arrastado, para mover o grupo junto. */
  groupStart: Map<string, Point>;
  paintedCells: Set<string>;
  /** Transformacao por alca. */
  handle: HandleId | null;
  boxStart: Box | null;
  targetKind: 'token' | 'tile' | null;
  targetId: string | null;
  /** Valores originais, para o desfazer e para calcular o delta. */
  originalScale: number;
  originalRotation: number;
  originalSize: { width: number; height: number };
  moved: boolean;
}

const emptyGesture = (): Gesture => ({
  kind: 'none',
  button: 0,
  startScreen: { x: 0, y: 0 },
  startWorld: { x: 0, y: 0 },
  cameraStart: { x: 0, y: 0, zoom: 1 },
  tokenId: null,
  tokenOffset: { x: 0, y: 0 },
  groupStart: new Map(),
  paintedCells: new Set(),
  handle: null,
  boxStart: null,
  targetKind: null,
  targetId: null,
  originalScale: 1,
  originalRotation: 0,
  originalSize: { width: 0, height: 0 },
  moved: false,
});

type FogAction = 'reveal' | 'hide' | 'block';

/** Qual acao o pincel aplica, conforme a ferramenta e o modo de selar. */
function fogAction(tool: string, seal: boolean): FogAction {
  if (tool !== 'fog-hide') return 'reveal';
  return seal ? 'block' : 'hide';
}

const FOG_LABELS: Record<FogAction, string> = {
  reveal: 'revelar neblina',
  hide: 'cobrir com neblina',
  block: 'selar area',
};

const FOG_INVERSE: Record<FogAction, 'clear-reveal' | 'reveal' | 'unblock'> = {
  reveal: 'clear-reveal',
  hide: 'reveal',
  block: 'unblock',
};

const FOG_FLUSH_MS = 140;
/** Abaixo disto, um arraste conta como clique. */
const CLICK_SLOP_PX = 4;
/** Alcance, em pixels de TELA, do encaixe numa ponta de parede existente. */
const WALL_SNAP_PX = 14;

const WALL_LABELS: Record<WallKind, { one: string; many: string }> = {
  wall: { one: 'parede', many: 'paredes' },
  door: { one: 'porta', many: 'portas' },
  window: { one: 'janela', many: 'janelas' },
};

function wallKindOf(wall: Pick<Wall, 'door' | 'window'>): WallKind {
  return wall.door ? 'door' : wall.window ? 'window' : 'wall';
}

interface ContextMenuState {
  /** Posicao na tela, relativa ao palco. */
  x: number;
  y: number;
  wallId: string;
}

interface DropGhost {
  /** Canto superior esquerdo e lado, ja em pixels de tela. */
  x: number;
  y: number;
  size: number;
  label: string;
  imageUrl: string | null;
  color: string;
}

export function Stage(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const viewportRef = useRef({ width: 0, height: 0 });
  const gestureRef = useRef<Gesture>(emptyGesture());
  const frameRef = useRef<number>(0);
  const lastFogFlushRef = useRef(0);
  const fittedSceneRef = useRef<string | null>(null);
  const handledPingRef = useRef<number>(0);
  /** Assinatura do ultimo quadro ocioso desenhado; vazia enquanto anima. */
  const idleKeyRef = useRef('');

  // Rascunhos que o renderizador le a cada quadro, sem passar pelo React.
  const measureRef = useRef<{ from: Point; to: Point } | null>(null);
  const marqueeRef = useRef<{ from: Point; to: Point; kind: MarqueeKind } | null>(null);
  const hoverRef = useRef<Point | null>(null);
  /** Ctrl segurado sob o cursor: a previa da parede solta da grade tambem. */
  const hoverFreeRef = useRef(false);

  const [zoomLabel, setZoomLabel] = useState(1);
  const [measureText, setMeasureText] = useState<{ text: string; at: Point } | null>(null);
  const [dropGhost, setDropGhost] = useState<DropGhost | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Medidor opcional (tecla G): mostra o custo real do quadro, para nao
  // discutir desempenho por impressao.
  const [perf, setPerf] = useState<{ fps: number; ms: number } | null>(null);
  const perfRef = useRef({ frames: 0, total: 0, since: 0 });

  const tool = useStore((s) => s.tool);
  const rev = useStore((s) => s.rev);
  const pings = useStore((s) => s.pings);

  const wallDraft = useStore((s) => s.wallDraft);
  const wallKind = useStore((s) => s.wallKind);
  const previewPlayerId = useStore((s) => s.previewPlayerId);
  const previewName = useStore(
    (s) => s.table?.players.find((p) => p.id === s.previewPlayerId)?.name ?? null,
  );
  const scene = useMemo(() => activeScene(useStore.getState()), [rev]);

  // -- dimensionamento ------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      viewportRef.current = { width: rect.width, height: rect.height };

      // Atribuir `width` ou `height` APAGA o canvas, mesmo com o mesmo valor.
      // O ResizeObserver dispara isto logo depois dos primeiros quadros; o
      // bitmap sumia, e o pulo de quadro ocioso nao redesenhava, porque nem
      // rev, nem camera, nem tamanho tinham mudado. O jogador parado via a
      // mesa inteira preta ate chegar algum evento — e o F5 repetia a corrida.
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      idleKeyRef.current = '';
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!scene) return;
    if (fittedSceneRef.current === scene.id) return;
    if (viewportRef.current.width === 0) return;
    fittedSceneRef.current = scene.id;
    // A textura de neblina da cena anterior nao serve mais e pode ser grande.
    invalidateFogMask();
    cameraRef.current = fitScene(scene, viewportRef.current);
    setZoomLabel(cameraRef.current.zoom);
  }, [scene]);

  // Ping com foco: o mestre pode puxar a camera da mesa para um ponto.
  useEffect(() => {
    const last = pings[pings.length - 1];
    if (!last || last.id === handledPingRef.current) return;
    handledPingRef.current = last.id;
    if (!last.focus) return;
    cameraRef.current = centerOn(cameraRef.current, { x: last.x, y: last.y });
  }, [pings]);

  // Trocar de ferramenta abandona a parede em construcao.
  useEffect(() => {
    if (tool !== 'wall') useStore.getState().setWallDraft([]);
  }, [tool]);

  // -- laco de desenho ------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const state = useStore.getState();
    const currentScene = activeScene(state);

    if (!ctx || !currentScene) {
      frameRef.current = requestAnimationFrame(draw);
      return;
    }

    // Na previa, o mestre passa a desenhar como se fosse o jogador observado:
    // mesma visao, mesmos filtros. Ele tem os dados de todos, entao o calculo
    // acontece aqui mesmo, sem ida ao servidor.
    const preview = state.session?.role === 'GM' ? state.previewPlayerId : null;
    const role = preview ? 'PLAYER' : (state.session?.role ?? 'PLAYER');
    const playerId = preview ?? state.session?.playerId ?? null;
    const vision = resolveVision(currentScene, role, playerId);

    const sheets = new Map(state.table?.sheets.map((s) => [s.id, s]) ?? []);
    const initiative = state.table?.initiative;
    const activeEntry = initiative?.entries.find((e) => e.id === initiative.activeEntryId);

    // Previa do pincel de neblina sob o cursor, so quando ele esta ativo.
    const painting = state.tool === 'fog-reveal' || state.tool === 'fog-hide';
    const fogCursor =
      painting && hoverRef.current && state.fogShape === 'brush'
        ? { cells: brushKeys(currentScene, hoverRef.current, state.fogBrush) }
        : null;

    // A polilinha em desenho ganha o segmento ate o cursor, ja encaixado onde
    // o proximo clique vai cair: a previa e a promessa do resultado.
    const walling = state.tool === 'wall' && state.session?.role === 'GM';
    const hover = walling && hoverRef.current
      ? resolveWallVertex(currentScene, hoverRef.current, cameraRef.current.zoom, hoverFreeRef.current)
      : null;
    const path = state.wallDraft;
    const wallPath = path.length > 0 ? (hover ? [...path, hover.point] : path) : null;

    const startedAt = performance.now();

    /*
     * Quadro ocioso: com nada em movimento e nada animando, redesenhar produz
     * exatamente a mesma imagem. Pular esse trabalho e o que faz a mesa parada
     * deixar de consumir GPU e bateria de laptop a sessao inteira.
     *
     * O que conta como animacao: o anel do turno pulsa, a selecao tem tracejado
     * correndo, pings expandem, e qualquer gesto em curso desenha uma previa.
     */
    const animating =
      activeEntry?.tokenId != null ||
      state.selectedTokenIds.length > 0 ||
      state.selectedTileId !== null ||
      state.selectedWallId !== null ||
      state.pings.length > 0 ||
      state.wallDraft.length > 0 ||
      // O anel de encaixe segue o cursor enquanto a ferramenta esta ativa.
      walling ||
      marqueeRef.current !== null ||
      measureRef.current !== null ||
      fogCursor !== null ||
      gestureRef.current.kind !== 'none' ||
      // Clima e animacao continua: sem isto o quadro ocioso congelaria a chuva.
      (currentScene.weather?.kind ?? 'none') !== 'none' ||
      // O mesmo vale para efeitos com estilo animado: runas param de girar,
      // brasas param de subir. `speed` 0 congela de proposito e nao conta.
      currentScene.effects.some((e) => e.style !== 'flat' && e.speed > 0);

    if (animating) {
      idleKeyRef.current = '';
    } else {
      const cam = cameraRef.current;
      let key = `${state.rev}|${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.zoom.toFixed(4)}`;
      key += `|${viewportRef.current.width}x${viewportRef.current.height}`;
      key += `|${state.hiddenLayers.join(',')}|${state.showPartyVision ? 1 : 0}`;
      // Movimento de token nao passa por `rev` de proposito; entra aqui.
      for (const t of currentScene.tokens) key += `|${Math.round(t.x)},${Math.round(t.y)}`;

      if (key === idleKeyRef.current) {
        frameRef.current = requestAnimationFrame(draw);
        return;
      }
      idleKeyRef.current = key;
    }

    renderScene({
      ctx,
      scene: currentScene,
      camera: cameraRef.current,
      viewport: viewportRef.current,
      role,
      playerId,
      vision,
      partyOverlay: role === 'GM' && state.showPartyVision ? partyVision(currentScene) : null,
      previewPlayerId: preview,
      hiddenLayers: new Set(state.hiddenLayers),
      selectedTokenIds: new Set(state.selectedTokenIds),
      selectedTileId: state.selectedTileId,
      selectedWallId: state.selectedWallId,
      marquee: marqueeRef.current,
      wallPath,
      wallKind: state.wallKind,
      wallSnap: hover?.snapped ? hover.point : null,
      fogCursor,
      tool: state.tool,
      fogSeal: state.fogSeal,
      activeTokenId: activeEntry?.tokenId ?? null,
      sheets,
      template: state.table?.sheetTemplate ?? { name: '', sections: [], fields: [] },
      showBars: state.table?.settings.showPartyBars ?? true,
      assetUrlOf: (assetId) => findAsset(assetId)?.url ?? null,
      measure: measureRef.current,
      now: performance.now(),
    });

    // Amostra por segundo: o custo medio do desenho e quantos quadros sairam.
    const perfState = perfRef.current;
    perfState.frames += 1;
    perfState.total += performance.now() - startedAt;
    if (perfState.since === 0) perfState.since = startedAt;

    if (startedAt - perfState.since >= 1000) {
      if (useStore.getState().showPerf) {
        setPerf({
          fps: Math.round((perfState.frames * 1000) / (startedAt - perfState.since)),
          ms: Number((perfState.total / perfState.frames).toFixed(2)),
        });
      }
      perfState.frames = 0;
      perfState.total = 0;
      perfState.since = startedAt;
    }

    frameRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(draw);
    // Imagem que termina de carregar precisa de um quadro novo. O pulo de
    // quadro ocioso compara so rev, camera e tokens, e nada disso muda quando
    // o download acaba: com o aviso ignorado, a imagem ficava de fora ate
    // alguem mexer em algo. O mestre, sempre movendo a camera, via na hora; o
    // jogador parado olhando a tela, nao.
    const stop = onImageReady(() => {
      idleKeyRef.current = '';
    });
    return () => {
      cancelAnimationFrame(frameRef.current);
      stop();
    };
  }, [draw]);

  useEffect(() => {
    const timer = setInterval(() => useStore.getState().prunePings(), 700);
    return () => clearInterval(timer);
  }, []);

  // -- utilidades -----------------------------------------------------------

  const toWorld = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return screenToWorld(
      cameraRef.current,
      viewportRef.current,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  }, []);

  const toLocalScreen = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  /** Mesma resolucao de URL usada no desenho, para clique e alcas baterem. */
  const assetUrlOf = useCallback(
    (assetId: string | null) => findAsset(assetId)?.url ?? null,
    [],
  );

  const canMove = useCallback((token: Token): boolean => {
    const state = useStore.getState();
    if (state.session?.role === 'GM') return !token.locked;
    if (token.locked) return false;
    if (state.table?.settings.playersMoveOwnTokensOnly) {
      return token.ownerPlayerId === state.session?.playerId;
    }
    return true;
  }, []);

  const flushFog = useCallback((action: 'reveal' | 'hide' | 'block') => {
    const gesture = gestureRef.current;
    const currentScene = activeScene(useStore.getState());
    if (!currentScene || gesture.paintedCells.size === 0) return;

    const cells = [...gesture.paintedCells];
    gesture.paintedCells = new Set();

    void act('fog:paint', { sceneId: currentScene.id, cells, action });
    useStore.getState().pushUndo({
      label: FOG_LABELS[action],
      // `reveal` e `block` tem inverso exato. `hide` apaga o que estava
      // revelado E o que estava explorado; devolver isso ao estado anterior
      // exigiria guardar a neblina inteira, entao o desfazer aqui revela a
      // area — devolve o que a pessoa via, ainda que como revelacao fixa.
      undo: () => void act('fog:paint', { sceneId: currentScene.id, cells, action: FOG_INVERSE[action] }),
      redo: () => void act('fog:paint', { sceneId: currentScene.id, cells, action }),
    });
  }, []);

  // -- ponteiro -------------------------------------------------------------

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const state = useStore.getState();
      const currentScene = activeScene(state);
      if (!currentScene) return;

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const world = toWorld(e);
      const screen = toLocalScreen(e);
      const gm = state.session?.role === 'GM';
      setContextMenu(null);

      const gesture = emptyGesture();
      gesture.button = e.button;
      gesture.startScreen = screen;
      gesture.startWorld = world;
      gesture.cameraStart = { ...cameraRef.current };

      // Botao do meio e direito sempre movem a camera, seja qual for a
      // ferramenta ativa: e o gesto que a pessoa faz sem pensar.
      const forcePan = e.button === 1 || e.button === 2 || state.tool === 'pan' || e.shiftKey;

      if (forcePan) {
        gesture.kind = 'pan';
      } else if (state.tool === 'measure') {
        gesture.kind = 'measure';
        measureRef.current = { from: world, to: world };
      } else if (state.tool === 'ping') {
        emit('map:ping', { sceneId: currentScene.id, x: world.x, y: world.y, focus: e.altKey });
        gestureRef.current = gesture;
        return;
      } else if (state.tool === 'fog-reveal' || state.tool === 'fog-hide') {
        if (state.fogShape === 'rect') {
          gesture.kind = 'fog-rect';
          marqueeRef.current = { from: world, to: world, kind: state.tool };
        } else {
          gesture.kind = 'fog-brush';
          for (const key of brushKeys(currentScene, world, state.fogBrush)) {
            gesture.paintedCells.add(key);
          }
        }
      } else if (state.tool === 'wall') {
        // A polilinha avanca por cliques; o arraste nao participa. Cada
        // clique depois do primeiro grava o trecho na hora.
        const { point } = resolveWallVertex(currentScene, world, cameraRef.current.zoom, e.ctrlKey);
        const kind: WallKind = e.altKey ? 'door' : state.wallKind;
        addWallSegment(currentScene, point, kind);
        gestureRef.current = gesture;
        return;
      } else if (state.tool === 'tile') {
        gesture.kind = 'tile';
        marqueeRef.current = { from: world, to: world, kind: 'tile' };
      } else {
        // Ferramenta de selecao: alca, token, ou retangulo de selecao.
        const selection = gm
          ? soleSelectionBox(
              currentScene,
              new Set(state.selectedTokenIds),
              state.selectedTileId,
              assetUrlOf,
            )
          : null;
        const handle = selection
          ? handleAtPoint(selection.box, world, cameraRef.current.zoom)
          : null;

        if (selection && handle) {
          gesture.kind = 'handle';
          gesture.handle = handle;
          gesture.boxStart = selection.box;
          gesture.targetKind = selection.kind;
          gesture.targetId = selection.id;

          if (selection.kind === 'token') {
            const token = currentScene.tokens.find((t) => t.id === selection.id);
            gesture.originalScale = token?.scale ?? 1;
            gesture.originalRotation = token?.rotation ?? 0;
          } else {
            const tile = currentScene.tiles.find((t) => t.id === selection.id);
            gesture.originalSize = { width: tile?.width ?? 0, height: tile?.height ?? 0 };
            gesture.originalRotation = tile?.rotation ?? 0;
          }
          gestureRef.current = gesture;
          return;
        }

        const vision = resolveVision(
          currentScene,
          state.session?.role ?? 'PLAYER',
          state.session?.playerId ?? null,
        );
        const token = tokenAtPoint(
          currentScene,
          world,
          new Set(state.hiddenLayers),
          vision,
          assetUrlOf,
        );

        if (token) {
          // Shift acrescenta a selecao em vez de troca-la.
          if (e.shiftKey || e.metaKey) state.toggleTokenSelection(token.id);
          else if (!state.selectedTokenIds.includes(token.id)) state.selectToken(token.id);

          if (canMove(token)) {
            gesture.kind = 'drag-token';
            gesture.tokenId = token.id;
            gesture.tokenOffset = { x: world.x - token.x, y: world.y - token.y };

            // Tudo que estiver selecionado e movivel viaja junto.
            const ids = useStore.getState().selectedTokenIds;
            for (const other of currentScene.tokens) {
              if (!ids.includes(other.id) || !canMove(other)) continue;
              gesture.groupStart.set(other.id, { x: other.x, y: other.y });
            }
            gesture.groupStart.set(token.id, { x: token.x, y: token.y });
          }
        } else {
          // Parede antes de tile: ela e uma linha fina, e se perde para
          // qualquer peca de cenario embaixo se a ordem for a inversa.
          const wall = gm ? wallAtPoint(currentScene, world, cameraRef.current.zoom) : null;
          const tile = gm ? tileAtPoint(currentScene, world, new Set(state.hiddenLayers)) : null;

          if (wall) {
            state.selectWall(wall.id);
            gestureRef.current = gesture;
            return;
          }

          if (tile && !tile.locked) {
            state.selectTile(tile.id);
            gesture.kind = 'drag-token';
            gesture.targetKind = 'tile';
            gesture.targetId = tile.id;
            gesture.tokenOffset = { x: world.x - tile.x, y: world.y - tile.y };
            gesture.groupStart.set(tile.id, { x: tile.x, y: tile.y });
          } else {
            gesture.kind = 'marquee';
            marqueeRef.current = { from: world, to: world, kind: 'select' };
          }
        }
      }

      gestureRef.current = gesture;
    },
    [assetUrlOf, canMove, toLocalScreen, toWorld],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const state = useStore.getState();
      const currentScene = activeScene(state);
      if (!currentScene) return;

      const world = toWorld(e);
      const screen = toLocalScreen(e);
      const gesture = gestureRef.current;
      hoverRef.current = world;
      hoverFreeRef.current = e.ctrlKey;

      if (Math.hypot(screen.x - gesture.startScreen.x, screen.y - gesture.startScreen.y) > CLICK_SLOP_PX) {
        gesture.moved = true;
      }

      // A posicao do cursor nao sai daqui: ninguem, nem o mestre, ve o
      // ponteiro dos outros. Apontar algo e gesto deliberado, pelo ping.
      const now = performance.now();

      switch (gesture.kind) {
        case 'pan': {
          const dx = (screen.x - gesture.startScreen.x) / cameraRef.current.zoom;
          const dy = (screen.y - gesture.startScreen.y) / cameraRef.current.zoom;
          cameraRef.current = clampCamera(
            { ...gesture.cameraStart, x: gesture.cameraStart.x - dx, y: gesture.cameraStart.y - dy },
            currentScene,
            viewportRef.current,
          );
          break;
        }

        case 'drag-token': {
          const dx = world.x - gesture.startWorld.x;
          const dy = world.y - gesture.startWorld.y;

          if (gesture.targetKind === 'tile' && gesture.targetId) {
            const start = gesture.groupStart.get(gesture.targetId);
            if (start) {
              void act('tile:update', {
                sceneId: currentScene.id,
                tileId: gesture.targetId,
                patch: { x: start.x + dx, y: start.y + dy },
              });
            }
            break;
          }

          // Aplicamos localmente e avisamos o servidor: o token acompanha o
          // dedo sem esperar a ida e volta pela rede.
          for (const [id, start] of gesture.groupStart) {
            const x = start.x + dx;
            const y = start.y + dy;
            state.moveTokenLocal(currentScene.id, id, x, y);
            emit('token:move', { sceneId: currentScene.id, tokenId: id, x, y, dragging: true });
          }

          const distance = measureDistance(currentScene.grid, gesture.startWorld, world);
          setMeasureText({
            text: `${distance.toFixed(1)} ${currentScene.grid.unitLabel}`,
            at: worldToScreen(cameraRef.current, viewportRef.current, world.x, world.y),
          });
          break;
        }

        case 'handle':
          applyHandle(currentScene, gesture, world);
          break;

        case 'measure': {
          measureRef.current = { from: gesture.startWorld, to: world };
          const distance = measureDistance(currentScene.grid, gesture.startWorld, world);
          setMeasureText({
            text: `${distance.toFixed(1)} ${currentScene.grid.unitLabel}`,
            at: worldToScreen(cameraRef.current, viewportRef.current, world.x, world.y),
          });
          break;
        }

        case 'fog-brush': {
          for (const key of brushKeys(currentScene, world, state.fogBrush)) {
            gesture.paintedCells.add(key);
          }
          if (now - lastFogFlushRef.current > FOG_FLUSH_MS) {
            lastFogFlushRef.current = now;
            flushFog(fogAction(state.tool, state.fogSeal));
          }
          break;
        }

        case 'fog-rect':
        case 'marquee':
        case 'tile':
          if (marqueeRef.current) marqueeRef.current = { ...marqueeRef.current, to: world };
          break;

        default:
          break;
      }
    },
    [flushFog, toLocalScreen, toWorld],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const state = useStore.getState();
      const currentScene = activeScene(state);
      const gesture = gestureRef.current;
      if (!currentScene) return;

      const world = toWorld(e);

      switch (gesture.kind) {
        case 'drag-token': {
          if (gesture.targetKind === 'tile' && gesture.targetId) {
            const start = gesture.groupStart.get(gesture.targetId);
            const tileId = gesture.targetId;
            if (start && gesture.moved) {
              const end = {
                x: start.x + (world.x - gesture.startWorld.x),
                y: start.y + (world.y - gesture.startWorld.y),
              };
              const moveTo = (p: Point) =>
                void act('tile:update', { sceneId: currentScene.id, tileId, patch: { x: p.x, y: p.y } });
              state.pushUndo({ label: 'mover tile', undo: () => moveTo(start), redo: () => moveTo(end) });
            }
            break;
          }

          const dx = world.x - gesture.startWorld.x;
          const dy = world.y - gesture.startWorld.y;
          const snap = currentScene.grid.snap && currentScene.grid.type !== 'none' && !e.ctrlKey;
          const before = new Map(gesture.groupStart);
          const after = new Map<string, Point>();

          for (const [id, start] of gesture.groupStart) {
            const token = currentScene.tokens.find((t) => t.id === id);
            if (!token) continue;

            let x = start.x + dx;
            let y = start.y + dy;
            // Previa local do snap para nao haver "pulo" quando a resposta do
            // servidor chegar com a posicao definitiva.
            if (snap) {
              const snapped = snapTokenPosition(currentScene.grid, { x, y }, token.scale);
              x = snapped.x;
              y = snapped.y;
            }

            state.moveTokenLocal(currentScene.id, id, x, y);
            after.set(id, { x, y });
            void act('token:move', {
              sceneId: currentScene.id,
              tokenId: id,
              x,
              y,
              dragging: false,
            });
          }

          if (gesture.moved) {
            const place = (positions: Map<string, Point>) => {
              for (const [id, p] of positions) {
                void act('token:move', { sceneId: currentScene.id, tokenId: id, x: p.x, y: p.y, dragging: false });
              }
            };
            state.pushUndo({
              label: before.size > 1 ? `mover ${before.size} tokens` : 'mover token',
              undo: () => place(before),
              redo: () => place(after),
            });
          }
          break;
        }

        case 'pan': {
          // Botao direito sem arrastar e o gesto de "o que da para fazer com
          // isto". Sobre uma parede, abre o menu dela; arrastando, continua
          // sendo o pan de sempre.
          if (gesture.button !== 2 || gesture.moved || state.session?.role !== 'GM') break;
          const wall = wallAtPoint(currentScene, world, cameraRef.current.zoom);
          if (!wall) break;
          const screen = toLocalScreen(e);
          state.selectWall(wall.id);
          setContextMenu({ x: screen.x, y: screen.y, wallId: wall.id });
          break;
        }

        case 'handle':
          commitHandle(currentScene, gesture);
          break;

        case 'fog-brush':
          flushFog(fogAction(state.tool, state.fogSeal));
          break;

        case 'fog-rect': {
          const marquee = marqueeRef.current;
          marqueeRef.current = null;
          if (!marquee) break;

          const cells = cellsInMarquee(currentScene, marquee.from, marquee.to);
          if (cells.length === 0) break;

          const action = fogAction(state.tool, state.fogSeal);
          void act('fog:paint', { sceneId: currentScene.id, cells, action });
          state.pushUndo({
            label: `${FOG_LABELS[action]} (area)`,
            undo: () =>
              void act('fog:paint', { sceneId: currentScene.id, cells, action: FOG_INVERSE[action] }),
            redo: () => void act('fog:paint', { sceneId: currentScene.id, cells, action }),
          });
          break;
        }

        case 'marquee': {
          const marquee = marqueeRef.current;
          marqueeRef.current = null;
          if (!marquee) break;

          if (!gesture.moved) {
            state.selectToken(null);
            break;
          }

          const rect = normalizeRect(marquee.from, marquee.to);
          const vision = resolveVision(
            currentScene,
            state.session?.role ?? 'PLAYER',
            state.session?.playerId ?? null,
          );
          const hits = tokensInRect(currentScene, rect, new Set(state.hiddenLayers), vision);
          state.selectTokens(hits.map((t) => t.id));
          break;
        }

        case 'tile': {
          const marquee = marqueeRef.current;
          marqueeRef.current = null;
          if (!marquee) break;

          const rect = normalizeRect(marquee.from, marquee.to);
          // Um clique seco cria um tile de uma celula, em vez de nada.
          if (rect.width < 4 || rect.height < 4) {
            rect.width = currentScene.grid.size;
            rect.height = currentScene.grid.size;
          }
          void createTile(currentScene, rect);
          break;
        }

        case 'measure':
          measureRef.current = null;
          break;

        default:
          break;
      }

      setMeasureText(null);
      gestureRef.current = emptyGesture();
    },
    [flushFog, toLocalScreen, toWorld],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      const currentScene = activeScene(useStore.getState());
      if (!currentScene) return;

      const screen = toLocalScreen(e);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      cameraRef.current = clampCamera(
        zoomAt(cameraRef.current, viewportRef.current, screen, factor),
        currentScene,
        viewportRef.current,
      );
      setZoomLabel(cameraRef.current.zoom);
    },
    [toLocalScreen],
  );

  // -- soltar ficha ou imagem no mapa --------------------------------------

  /**
   * Previa de onde o que esta sendo arrastado vai cair.
   *
   * O navegador so mostra um fantasma translucido do elemento arrastado, sem
   * relacao com a grade. Aqui a peca aparece ja encaixada na celula sob o
   * cursor, com o nome e a arte — a pessoa ve o resultado antes de soltar.
   */
  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const state = useStore.getState();
      const currentScene = activeScene(state);
      const payload = state.dragging;
      if (!currentScene || !payload || state.session?.role !== 'GM') return;

      e.preventDefault();
      e.dataTransfer.dropEffect = payload.kind === 'sheet' && sheetTokenOn(currentScene, payload.sheetId) ? 'move' : 'copy';

      const spot = dropSpot(currentScene, toWorld(e), e.ctrlKey);
      const topLeft = worldToScreen(cameraRef.current, viewportRef.current, spot.x, spot.y);
      const size = currentScene.grid.size * cameraRef.current.zoom;

      if (payload.kind === 'sheet') {
        const sheet = findSheet(payload.sheetId);
        const existing = sheetTokenOn(currentScene, payload.sheetId);
        const owner = state.table?.players.find((p) => p.id === sheet?.ownerPlayerId);
        setDropGhost({
          x: topLeft.x,
          y: topLeft.y,
          size,
          label: existing ? `Mover ${sheet?.name ?? 'personagem'} para ca` : `Colocar ${sheet?.name ?? 'personagem'}`,
          imageUrl: findAsset(sheet?.portraitAssetId)?.url ?? null,
          color: owner?.color ?? '#7a8bd4',
        });
        return;
      }

      const asset = findAsset(payload.assetId);
      setDropGhost({
        x: topLeft.x,
        y: topLeft.y,
        size,
        label: payload.assetKind === 'tile' || payload.assetKind === 'map' ? 'Colocar tile' : 'Colocar token',
        imageUrl: asset?.thumbUrl ?? asset?.url ?? null,
        color: '#7a8bd4',
      });
    },
    [toWorld],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDropGhost(null);

      const state = useStore.getState();
      const currentScene = activeScene(state);
      state.setDragging(null);
      if (!currentScene || state.session?.role !== 'GM') return;

      const sheetId = e.dataTransfer.getData('application/x-rpg-sheet');
      if (sheetId) {
        void dropSheet(currentScene, sheetId, dropSpot(currentScene, toWorld(e), e.ctrlKey));
        return;
      }

      const assetId = e.dataTransfer.getData('application/x-rpg-asset');
      const kind = e.dataTransfer.getData('application/x-rpg-asset-kind');
      if (!assetId) return;

      const world = toWorld(e);
      const asset = findAsset(assetId);

      // Mapas e tiles viram peca de cenario; o resto vira token.
      if (kind === 'tile' || kind === 'map') {
        const cell = currentScene.grid.size;
        const ratio = asset && asset.height > 0 ? asset.width / asset.height : 1;
        void createTile(currentScene, {
          x: world.x - cell / 2,
          y: world.y - cell / 2 / ratio,
          width: cell,
          height: cell / ratio,
        }, assetId);
        return;
      }

      const spot = dropSpot(currentScene, world, e.ctrlKey);
      void createTokenWithUndo(currentScene, {
        name: asset?.originalName.replace(/\.[^.]+$/, '') ?? 'Token',
        assetId,
        x: spot.x,
        y: spot.y,
        layer: 3,
      });
    },
    [toWorld],
  );

  // -- atalhos --------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const state = useStore.getState();
      const currentScene = activeScene(state);
      const gm = state.session?.role === 'GM';

      // Atalhos com Ctrl antes do resto, para nao colidir com as teclas soltas.
      // Ctrl+Y e o refazer do Windows; Ctrl+Shift+Z, o de quase todo o resto.
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        state.redo();
        return;
      }
      if (mod && key === 'z') {
        e.preventDefault();
        state.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (gm && currentScene) void duplicateSelection(currentScene);
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'v':
          state.setTool('select');
          break;
        case 'h':
          state.setTool('pan');
          break;
        case 'm':
          state.setTool('measure');
          break;
        case 'p':
          state.setTool('ping');
          break;
        case 'g':
          state.togglePerf();
          if (state.showPerf) setPerf(null);
          break;
        case 'f':
          if (currentScene && viewportRef.current.width) {
            cameraRef.current = fitScene(currentScene, viewportRef.current);
            setZoomLabel(cameraRef.current.zoom);
          }
          break;
        case 'enter':
          // Os trechos ja estao gravados; encerrar so solta a ponta.
          if (state.tool === 'wall') state.setWallDraft([]);
          break;
        case 'delete':
        case 'backspace': {
          if (!gm || !currentScene) break;
          void deleteSelection(currentScene);
          break;
        }
        case 'escape':
          setContextMenu(null);
          if (state.previewPlayerId) {
            state.setPreviewPlayer(null);
            break;
          }
          if (state.wallDraft.length > 0) {
            state.setWallDraft([]);
            break;
          }
          state.selectToken(null);
          state.selectTile(null);
          state.selectWall(null);
          state.setTool('select');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // -- render ---------------------------------------------------------------

  const cursorStyle = useMemo(() => {
    switch (tool) {
      case 'pan':
        return 'grab';
      case 'measure':
      case 'wall':
      case 'tile':
        return 'crosshair';
      case 'ping':
        return 'cell';
      case 'fog-reveal':
      case 'fog-hide':
        return 'copy';
      default:
        return 'default';
    }
  }, [tool]);

  return (
    <div
      className="stage"
      ref={hostRef}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        // `dragleave` dispara tambem ao passar sobre um filho do palco; so
        // conta quando o cursor sai do palco de verdade.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropGhost(null);
      }}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => (hoverRef.current = null)}
        onWheel={(e) => {
          setContextMenu(null);
          onWheel(e);
        }}
        onDoubleClick={() => {
          // O duplo clique ja gravou os trechos; so encerra a sequencia.
          if (tool === 'wall') useStore.getState().setWallDraft([]);
        }}
        onContextMenu={(e) => e.preventDefault()}
      />

      {dropGhost && (
        <div className="drop-ghost" style={{ left: dropGhost.x, top: dropGhost.y }}>
          <div
            className="drop-ghost-piece"
            style={{
              width: dropGhost.size,
              height: dropGhost.size,
              borderColor: dropGhost.color,
              backgroundImage: dropGhost.imageUrl ? `url("${dropGhost.imageUrl}")` : undefined,
              backgroundColor: dropGhost.imageUrl ? undefined : dropGhost.color,
            }}
          />
          <span className="drop-ghost-label">{dropGhost.label}</span>
        </div>
      )}

      {contextMenu && (
        <WallContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      {previewPlayerId && (
        <div className="preview-banner">
          <span>
            Vendo pelos olhos de <strong>{previewName ?? 'jogador'}</strong>
          </span>
          <button className="btn sm" onClick={() => useStore.getState().setPreviewPlayer(null)}>
            Sair da previa
          </button>
        </div>
      )}

      <div className="stage-overlay">
        {measureText && (
          <div className="measure-readout" style={{ left: measureText.at.x, top: measureText.at.y }}>
            {measureText.text}
          </div>
        )}

        {pings.map((ping) => {
          const p = worldToScreen(cameraRef.current, viewportRef.current, ping.x, ping.y);
          return <PingMark key={ping.id} x={p.x} y={p.y} color={ping.color} />;
        })}
      </div>

      {tool === 'wall' && wallDraft.length > 0 && (
        <div className="stage-tip">
          Desenhando <strong>{WALL_LABELS[wallKind].many}</strong> · cada clique grava um trecho ·{' '}
          <strong>Enter</strong>, <strong>Esc</strong> ou duplo clique encerra · <strong>Ctrl+Z</strong> desfaz o
          ultimo
        </div>
      )}

      {perf && (
        <div className="perf-readout mono" title="Custo medio de desenho por quadro (tecla G)">
          {perf.fps} fps · {perf.ms} ms
        </div>
      )}

      <div className="zoom-readout">
        <button
          className="btn ghost sm"
          onClick={() => {
            const currentScene = activeScene(useStore.getState());
            if (currentScene) {
              cameraRef.current = fitScene(currentScene, viewportRef.current);
              setZoomLabel(cameraRef.current.zoom);
            }
          }}
          title="Enquadrar o mapa (F)"
        >
          ⤢
        </button>
        <span>{Math.round(zoomLabel * 100)}%</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operacoes
// ---------------------------------------------------------------------------

/**
 * Clique da ferramenta de parede.
 *
 * O primeiro clique so fixa a ponta; cada clique seguinte grava o trecho na
 * hora. Antes a sequencia inteira ficava em rascunho ate o Enter: um clique
 * fora do mapa, uma troca de ferramenta ou uma queda de conexao jogava fora o
 * que tinha sido desenhado. Agora cada trecho tem o proprio desfazer, e
 * Ctrl+Z desmancha a sequencia de tras para frente.
 */
function addWallSegment(scene: Scene, point: Point, kind: WallKind): void {
  const store = useStore.getState();
  const from = store.wallDraft[store.wallDraft.length - 1];

  if (!from) {
    store.setWallDraft([point]);
    return;
  }
  // Duplo clique chega como dois cliques no mesmo ponto: nao e um trecho.
  if (from.x === point.x && from.y === point.y) return;

  store.setWallDraft([point]);

  const wall = {
    x1: from.x,
    y1: from.y,
    x2: point.x,
    y2: point.y,
    door: kind === 'door',
    window: kind === 'window',
  };
  let wallId: string | null = null;

  const create = async () => {
    const created = await act<Wall>('wall:create', { sceneId: scene.id, wall });
    wallId = created?.id ?? null;
    return created;
  };

  void create().then((created) => {
    if (!created) return;
    useStore.getState().pushUndo({
      label: `criar ${WALL_LABELS[kind].one}`,
      undo: () => {
        if (wallId) void act('wall:delete', { sceneId: scene.id, wallId });
        // Desfazer no meio da sequencia devolve a ponta solta ao inicio do
        // trecho, para o proximo clique continuar de onde a parede parou.
        const draft = useStore.getState().wallDraft;
        const tip = draft[draft.length - 1];
        if (tip && tip.x === point.x && tip.y === point.y) useStore.getState().setWallDraft([from]);
      },
      redo: () => void create(),
    });
  });
}

/**
 * Vertice onde o clique da ferramenta de parede vai cair.
 *
 * Ordem de preferencia: ponta de parede existente, depois qualquer ponto de
 * uma parede existente (junta em T), depois o vertice da grade. As duas
 * primeiras sao o que liga paredes vizinhas sozinho — encaixar so na grade
 * deixava frestas sempre que uma parede tinha sido desenhada solta, com Ctrl,
 * ou numa grade diferente.
 */
function resolveWallVertex(
  scene: Scene,
  world: Point,
  zoom: number,
  free: boolean,
): { point: Point; snapped: boolean } {
  const reach = WALL_SNAP_PX / zoom;

  let best: Point | null = null;
  let bestDistance = reach;
  for (const wall of scene.walls) {
    for (const end of [
      { x: wall.x1, y: wall.y1 },
      { x: wall.x2, y: wall.y2 },
    ]) {
      const d = Math.hypot(end.x - world.x, end.y - world.y);
      if (d <= bestDistance) {
        best = end;
        bestDistance = d;
      }
    }
  }
  if (best) return { point: best, snapped: true };

  // Junta em T: projeta o ponto sobre a parede mais proxima ao alcance.
  let onWall: Point | null = null;
  let onWallDistance = reach * 0.6;
  for (const wall of scene.walls) {
    const projected = projectOntoSegment(world, wall);
    const d = Math.hypot(projected.x - world.x, projected.y - world.y);
    if (d <= onWallDistance) {
      onWall = projected;
      onWallDistance = d;
    }
  }
  if (onWall) return { point: onWall, snapped: true };

  return { point: free ? world : snapToGridVertex(scene, world), snapped: false };
}

function projectOntoSegment(p: Point, seg: { x1: number; y1: number; x2: number; y2: number }): Point {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: seg.x1, y: seg.y1 };
  const t = Math.max(0, Math.min(1, ((p.x - seg.x1) * dx + (p.y - seg.y1) * dy) / lengthSq));
  return { x: seg.x1 + t * dx, y: seg.y1 + t * dy };
}

/** Canto superior esquerdo de uma peca de uma celula solta sob o cursor. */
function dropSpot(scene: Scene, world: Point, free: boolean): Point {
  const topLeft = { x: world.x - scene.grid.size / 2, y: world.y - scene.grid.size / 2 };
  if (free || !scene.grid.snap || scene.grid.type === 'none') return topLeft;
  return snapTokenPosition(scene.grid, topLeft, 1);
}

/** Token de uma ficha na cena, se ela ja tiver um. */
function sheetTokenOn(scene: Scene, sheetId: string): Token | null {
  return scene.tokens.find((t) => t.sheetId === sheetId) ?? null;
}

/**
 * Ficha solta no mapa.
 *
 * Se o personagem ja esta na cena, ele vai ate o ponto — arrastar a ficha e o
 * jeito rapido de achar e posicionar alguem num mapa cheio. Se nao esta, nasce
 * ali, ja ligado a ficha, com o dono, as barras e a visao de personagem.
 */
async function dropSheet(scene: Scene, sheetId: string, spot: Point): Promise<void> {
  const state = useStore.getState();
  const sheet = findSheet(sheetId);
  if (!sheet) return;

  const existing = sheetTokenOn(scene, sheetId);
  if (existing) {
    const from = { x: existing.x, y: existing.y };
    const place = (p: Point) =>
      void act('token:move', { sceneId: scene.id, tokenId: existing.id, x: p.x, y: p.y, dragging: false });
    state.moveTokenLocal(scene.id, existing.id, spot.x, spot.y);
    place(spot);
    state.selectToken(existing.id);
    state.pushUndo({ label: `mover ${sheet.name}`, undo: () => place(from), redo: () => place(spot) });
    return;
  }

  const owner = state.table?.players.find((p) => p.id === sheet.ownerPlayerId);
  const template = state.table?.sheetTemplate;
  await createTokenWithUndo(scene, {
    name: sheet.name,
    assetId: sheet.portraitAssetId,
    color: owner?.color ?? '#7a8bd4',
    x: spot.x,
    y: spot.y,
    layer: 3,
    ownerPlayerId: sheet.ownerPlayerId,
    sheetId: sheet.id,
    visionRadius: CHARACTER_VISION_RADIUS,
    bars: template
      ? tokenBarFields(template)
          .slice(0, 4)
          .map((field) => ({ fieldId: field.id, color: field.color }))
      : [],
  });
}

/** Cria um token, seleciona e registra desfazer e refazer. */
async function createTokenWithUndo(scene: Scene, token: Partial<Token>): Promise<void> {
  let tokenId: string | null = null;
  const create = async () => {
    const created = await act<Token>('token:create', { sceneId: scene.id, token });
    tokenId = created?.id ?? null;
    return created;
  };

  const created = await create();
  if (!created) return;
  const state = useStore.getState();
  state.selectToken(created.id);
  state.pushUndo({
    label: `criar ${token.name ?? 'token'}`,
    undo: () => {
      if (tokenId) void act('token:delete', { sceneId: scene.id, tokenId });
    },
    redo: () => void create(),
  });
}

/**
 * Menu de contexto de uma parede.
 *
 * Excluir estava escondido atras de selecionar e apertar Delete, ou de achar a
 * parede numa lista. O botao direito e o gesto que a pessoa tenta primeiro.
 */
function WallContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }): JSX.Element | null {
  const scene = activeScene(useStore.getState());
  const wall = scene?.walls.find((w) => w.id === menu.wallId) ?? null;

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.context-menu')) onClose();
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [onClose]);

  if (!scene || !wall) return null;
  const kind = wallKindOf(wall);
  const label = WALL_LABELS[kind].one;

  const convert = (next: WallKind) => {
    const before = { door: wall.door, window: wall.window, open: wall.open };
    const patch = { door: next === 'door', window: next === 'window' };
    void act('wall:update', { sceneId: scene.id, wallId: wall.id, patch });
    useStore.getState().pushUndo({
      label: `transformar em ${WALL_LABELS[next].one}`,
      undo: () => void act('wall:update', { sceneId: scene.id, wallId: wall.id, patch: before }),
      redo: () => void act('wall:update', { sceneId: scene.id, wallId: wall.id, patch }),
    });
    onClose();
  };

  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
      <div className="context-menu-title">{label[0].toUpperCase() + label.slice(1)}</div>
      {wall.door && (
        <button
          role="menuitem"
          onClick={() => {
            void act('wall:update', { sceneId: scene.id, wallId: wall.id, patch: { open: !wall.open } });
            onClose();
          }}
        >
          {wall.open ? 'Fechar porta' : 'Abrir porta'}
        </button>
      )}
      {(['wall', 'door', 'window'] as WallKind[])
        .filter((k) => k !== kind)
        .map((k) => (
          <button key={k} role="menuitem" onClick={() => convert(k)}>
            Transformar em {WALL_LABELS[k].one}
          </button>
        ))}
      <div className="context-menu-sep" />
      <button
        role="menuitem"
        className="danger"
        onClick={() => {
          void deleteWallWithUndo(scene, wall);
          onClose();
        }}
      >
        Excluir {label}
      </button>
    </div>
  );
}

/** Exclui uma parede com desfazer e refazer; o id muda a cada recriacao. */
async function deleteWallWithUndo(scene: Scene, wall: Wall): Promise<void> {
  const state = useStore.getState();
  const { id: originalId, ...shape } = wall;
  let wallId: string | null = originalId;

  const remove = () => {
    if (wallId) void act('wall:delete', { sceneId: scene.id, wallId });
  };

  remove();
  if (state.selectedWallId === originalId) state.selectWall(null);
  state.pushUndo({
    label: `excluir ${WALL_LABELS[wallKindOf(wall)].one}`,
    undo: async () => {
      const created = await act<Wall>('wall:create', { sceneId: scene.id, wall: shape });
      wallId = created?.id ?? null;
    },
    redo: remove,
  });
}

async function createTile(
  scene: Scene,
  rect: { x: number; y: number; width: number; height: number },
  assetId: string | null = null,
): Promise<void> {
  const state = useStore.getState();
  const chosen = assetId ?? state.selectedAssetId;

  await createTileWithUndo(
    scene,
    { assetId: chosen, x: rect.x, y: rect.y, width: rect.width, height: rect.height, layer: 2 },
    'criar tile',
  );
}

async function createTileWithUndo(scene: Scene, tile: Partial<Tile>, label: string): Promise<void> {
  let tileId: string | null = null;
  const create = async () => {
    const created = await act<Tile>('tile:create', { sceneId: scene.id, tile });
    tileId = created?.id ?? null;
    return created;
  };

  const created = await create();
  if (!created) return;
  const state = useStore.getState();
  state.selectTile(created.id);
  state.pushUndo({
    label,
    undo: () => {
      if (tileId) void act('tile:delete', { sceneId: scene.id, tileId });
    },
    redo: () => void create(),
  });
}

async function duplicateSelection(scene: Scene): Promise<void> {
  const state = useStore.getState();
  const offset = scene.grid.size * 0.5;

  // Copia tudo menos a identidade: a duplicata nasce ao lado da original.
  const copies: Partial<Token>[] = [];
  for (const id of state.selectedTokenIds) {
    const token = scene.tokens.find((t) => t.id === id);
    if (!token) continue;
    const { id: _omit, ...rest } = token;
    void _omit;
    copies.push({ ...rest, x: token.x + offset, y: token.y + offset });
  }

  if (state.selectedTileId) {
    const tile = scene.tiles.find((t) => t.id === state.selectedTileId);
    if (tile) {
      const { id: _omit, ...rest } = tile;
      void _omit;
      await createTileWithUndo(scene, { ...rest, x: tile.x + offset, y: tile.y + offset }, 'duplicar tile');
    }
  }

  if (copies.length === 0) return;

  let createdIds: string[] = [];
  const createAll = async () => {
    const created = await Promise.all(copies.map((token) => act<Token>('token:create', { sceneId: scene.id, token })));
    createdIds = created.flatMap((t) => (t ? [t.id] : []));
  };

  await createAll();
  if (createdIds.length === 0) return;
  state.selectTokens(createdIds);
  state.pushUndo({
    label: `duplicar ${createdIds.length} token(s)`,
    undo: () => {
      for (const tokenId of createdIds) void act('token:delete', { sceneId: scene.id, tokenId });
    },
    redo: () => void createAll(),
  });
}

async function deleteSelection(scene: Scene): Promise<void> {
  const state = useStore.getState();
  const tokens = scene.tokens.filter((t) => state.selectedTokenIds.includes(t.id));
  const tile = scene.tiles.find((t) => t.id === state.selectedTileId) ?? null;
  const wall = scene.walls.find((w) => w.id === state.selectedWallId) ?? null;

  if (wall) {
    await deleteWallWithUndo(scene, wall);
    return;
  }

  if (tokens.length === 0 && !tile) return;

  // Desfazer recria objetos equivalentes, com ids novos: o suficiente para
  // consertar um engano, sem sincronizar historicos entre clientes. Os ids
  // vivos ficam aqui, para o refazer apagar os recriados e nao os originais.
  let tokenIds = tokens.map((t) => t.id);
  let tileId = tile?.id ?? null;

  const removeAll = () => {
    for (const tokenId of tokenIds) void act('token:delete', { sceneId: scene.id, tokenId });
    if (tileId) void act('tile:delete', { sceneId: scene.id, tileId });
  };

  removeAll();
  state.pushUndo({
    label: tokens.length > 1 ? `excluir ${tokens.length} tokens` : 'excluir do mapa',
    undo: async () => {
      const recreated = await Promise.all(
        tokens.map(({ id: _omit, ...rest }) => {
          void _omit;
          return act<Token>('token:create', { sceneId: scene.id, token: rest });
        }),
      );
      tokenIds = recreated.flatMap((t) => (t ? [t.id] : []));
      if (tile) {
        const { id: _omitTile, ...rest } = tile;
        void _omitTile;
        tileId = (await act<Tile>('tile:create', { sceneId: scene.id, tile: rest }))?.id ?? null;
      }
    },
    redo: removeAll,
  });

  state.selectToken(null);
  state.selectTile(null);
}

// ---------------------------------------------------------------------------
// Alcas de transformacao
// ---------------------------------------------------------------------------

/** Aplica rotacao ou escala enquanto a alca esta sendo arrastada. */
function applyHandle(scene: Scene, gesture: Gesture, world: Point): void {
  const box = gesture.boxStart;
  if (!box || !gesture.targetId) return;

  // Pivo, e nao centro: a arte de corpo inteiro gira em torno dos pes. Medir o
  // angulo a partir do centro da caixa faria a figura girar fora do cursor.
  const { x: cx, y: cy } = boxPivot(box);

  if (gesture.handle === 'rotate') {
    // O angulo e medido do pivo ate o cursor; +90 porque a alca fica no topo.
    const degrees = (Math.atan2(world.y - cy, world.x - cx) * 180) / Math.PI + 90;
    const snapped = Math.round(degrees / 15) * 15;

    if (gesture.targetKind === 'token') {
      void act('token:update', {
        sceneId: scene.id,
        tokenId: gesture.targetId,
        patch: { rotation: snapped },
      });
    } else {
      void act('tile:update', {
        sceneId: scene.id,
        tileId: gesture.targetId,
        patch: { rotation: snapped },
      });
    }
    return;
  }

  // Escala pela distancia ao centro, comparada com a distancia original.
  const startDistance = Math.hypot(gesture.startWorld.x - cx, gesture.startWorld.y - cy);
  const nowDistance = Math.hypot(world.x - cx, world.y - cy);
  if (startDistance < 1) return;
  const factor = Math.max(0.1, nowDistance / startDistance);

  if (gesture.targetKind === 'token') {
    void act('token:update', {
      sceneId: scene.id,
      tokenId: gesture.targetId,
      patch: { scale: Math.max(0.25, Math.round(gesture.originalScale * factor * 4) / 4) },
    });
  } else {
    void act('tile:update', {
      sceneId: scene.id,
      tileId: gesture.targetId,
      patch: {
        width: Math.max(4, gesture.originalSize.width * factor),
        height: Math.max(4, gesture.originalSize.height * factor),
      },
    });
  }
}

/** Registra o desfazer da transformacao concluida. */
function commitHandle(scene: Scene, gesture: Gesture): void {
  if (!gesture.targetId || !gesture.moved) return;
  const state = useStore.getState();
  const targetId = gesture.targetId;

  // O estado final vem da cena: as atualizacoes do arraste ja voltaram do
  // servidor, e e ele que diz onde a transformacao terminou.
  if (gesture.targetKind === 'token') {
    const { originalScale, originalRotation } = gesture;
    const token = scene.tokens.find((t) => t.id === targetId);
    const final = { scale: token?.scale ?? originalScale, rotation: token?.rotation ?? originalRotation };
    const apply = (patch: { scale: number; rotation: number }) =>
      void act('token:update', { sceneId: scene.id, tokenId: targetId, patch });
    state.pushUndo({
      label: gesture.handle === 'rotate' ? 'girar token' : 'redimensionar token',
      undo: () => apply({ scale: originalScale, rotation: originalRotation }),
      redo: () => apply(final),
    });
  } else {
    const { originalSize, originalRotation } = gesture;
    const tile = scene.tiles.find((t) => t.id === targetId);
    const final = {
      width: tile?.width ?? originalSize.width,
      height: tile?.height ?? originalSize.height,
      rotation: tile?.rotation ?? originalRotation,
    };
    const apply = (patch: { width: number; height: number; rotation: number }) =>
      void act('tile:update', { sceneId: scene.id, tileId: targetId, patch });
    state.pushUndo({
      label: gesture.handle === 'rotate' ? 'girar tile' : 'redimensionar tile',
      undo: () => apply({ ...originalSize, rotation: originalRotation }),
      redo: () => apply(final),
    });
  }
}

// ---------------------------------------------------------------------------
// Geometria auxiliar
// ---------------------------------------------------------------------------

function normalizeRect(a: Point, b: Point): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Celulas cobertas pelo pincel, com o raio escolhido pelo mestre. */
function brushKeys(scene: Scene, world: Point, radius: number): string[] {
  const center = cellAt(scene.grid, world);
  return cellsWithinRadius(scene.grid, center, Math.max(0, radius)).map(cellKey);
}

/** Celulas dentro do retangulo arrastado, para revelar uma sala de uma vez. */
function cellsInMarquee(scene: Scene, from: Point, to: Point): string[] {
  const rect = normalizeRect(from, to);
  const step = Math.max(4, scene.grid.size / 3);
  const keys = new Set<string>();

  for (let y = rect.y; y <= rect.y + rect.height; y += step) {
    for (let x = rect.x; x <= rect.x + rect.width; x += step) {
      keys.add(cellKey(cellAt(scene.grid, { x, y })));
    }
  }
  // Garante as bordas exatas, que o passo pode ter pulado.
  keys.add(cellKey(cellAt(scene.grid, { x: rect.x + rect.width, y: rect.y + rect.height })));
  return [...keys];
}

/** Vertice de grid mais proximo, para paredes encaixarem nos cantos das salas. */
function snapToGridVertex(scene: Scene, world: Point): Point {
  const grid = scene.grid;
  if (grid.type === 'none') return world;
  if (grid.type === 'square') {
    return {
      x: grid.offsetX + Math.round((world.x - grid.offsetX) / grid.size) * grid.size,
      y: grid.offsetY + Math.round((world.y - grid.offsetY) / grid.size) * grid.size,
    };
  }

  // Em hex, o vertice mais proximo entre os seis da celula sob o cursor.
  const corners = cellCorners(grid, cellAt(grid, world));
  let best = corners[0];
  let bestDistance = Infinity;
  for (const corner of corners) {
    const d = (corner.x - world.x) ** 2 + (corner.y - world.y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = corner;
    }
  }
  return best;
}

/** Marca de ping: um alvo que pulsa e some sozinho. */
function PingMark({ x, y, color }: { x: number; y: number; color: string }): JSX.Element {
  return (
    <svg
      width="72"
      height="72"
      viewBox="0 0 72 72"
      style={{ position: 'absolute', left: x - 36, top: y - 36, pointerEvents: 'none' }}
    >
      <circle cx="36" cy="36" r="8" fill="none" stroke={color} strokeWidth="3">
        <animate attributeName="r" from="8" to="30" dur="1.3s" repeatCount="2" />
        <animate attributeName="opacity" from="1" to="0" dur="1.3s" repeatCount="2" />
      </circle>
      <circle cx="36" cy="36" r="4" fill={color}>
        <animate attributeName="opacity" from="1" to="0" dur="2.6s" />
      </circle>
    </svg>
  );
}
