import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cellAt,
  cellCorners,
  cellKey,
  cellsWithinRadius,
  measureDistance,
  snapTokenPosition,
  type Point,
  type Scene,
  type Token,
} from '@rpg/shared';

import { act, emit } from '../net/socket';
import { activeScene, findAsset, useStore } from '../state/store';
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
import { renderScene, tokenAtPoint } from './render';
import { partyVision, resolveVision } from './vision';

/**
 * O palco: canvas do mapa e toda a interacao de ponteiro.
 *
 * A camera vive em um ref, nao no estado do React. Um gesto de pan produz
 * dezenas de quadros por segundo, e passar cada um pelo React re-renderizaria
 * paineis, listas e fichas sem necessidade. O React so e avisado do zoom, e
 * mesmo assim com folga, porque ele aparece no canto da tela.
 */

interface Gesture {
  kind: 'none' | 'pan' | 'drag-token' | 'measure' | 'fog' | 'wall';
  startScreen: Point;
  startWorld: Point;
  lastScreen: Point;
  cameraStart: Camera;
  tokenId: string | null;
  /** Diferenca entre o canto do token e o ponto clicado, para nao "pular". */
  tokenOffset: Point;
  paintedCells: Set<string>;
}

const emptyGesture = (): Gesture => ({
  kind: 'none',
  startScreen: { x: 0, y: 0 },
  startWorld: { x: 0, y: 0 },
  lastScreen: { x: 0, y: 0 },
  cameraStart: { x: 0, y: 0, zoom: 1 },
  tokenId: null,
  tokenOffset: { x: 0, y: 0 },
  paintedCells: new Set(),
});

const CURSOR_INTERVAL_MS = 70;
const FOG_FLUSH_MS = 140;

export function Stage(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const viewportRef = useRef({ width: 0, height: 0 });
  const gestureRef = useRef<Gesture>(emptyGesture());
  const frameRef = useRef<number>(0);
  const lastCursorRef = useRef(0);
  const lastFogFlushRef = useRef(0);
  const fittedSceneRef = useRef<string | null>(null);
  const handledPingRef = useRef<number>(0);

  const [zoomLabel, setZoomLabel] = useState(1);
  const [measureText, setMeasureText] = useState<{ text: string; at: Point } | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);

  const tool = useStore((s) => s.tool);
  const rev = useStore((s) => s.rev);
  const peers = useStore((s) => s.peers);
  const pings = useStore((s) => s.pings);
  const sideOpen = useStore((s) => s.sideOpen);

  const measureRef = useRef<{ from: Point; to: Point } | null>(null);
  const wallDraftRef = useRef<{ from: Point; to: Point } | null>(null);

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
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Enquadra automaticamente ao abrir uma cena pela primeira vez.
  useEffect(() => {
    if (!scene) return;
    if (fittedSceneRef.current === scene.id) return;
    if (viewportRef.current.width === 0) return;
    fittedSceneRef.current = scene.id;
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

    const role = state.session?.role ?? 'PLAYER';
    const playerId = state.session?.playerId ?? null;
    const vision = resolveVision(currentScene, role, playerId);

    const sheets = new Map(state.table?.sheets.map((s) => [s.id, s]) ?? []);
    const initiative = state.table?.initiative;
    const activeEntry = initiative?.entries.find((e) => e.id === initiative.activeEntryId);

    renderScene({
      ctx,
      scene: currentScene,
      camera: cameraRef.current,
      viewport: viewportRef.current,
      role,
      playerId,
      vision,
      partyOverlay: role === 'GM' && state.showPartyVision ? partyVision(currentScene) : null,
      hiddenLayers: new Set(state.hiddenLayers),
      selectedTokenId: state.selectedTokenId,
      activeTokenId: activeEntry?.tokenId ?? null,
      sheets,
      template: state.table?.sheetTemplate ?? { name: '', sections: [], fields: [] },
      showBars: state.table?.settings.showPartyBars ?? true,
      assetUrlOf: (assetId) => findAsset(assetId)?.url ?? null,
      measure: measureRef.current,
      wallDraft: wallDraftRef.current,
      now: performance.now(),
    });

    frameRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(draw);
    const stop = onImageReady(() => void 0);
    return () => {
      cancelAnimationFrame(frameRef.current);
      stop();
    };
  }, [draw]);

  // Limpa pings expirados sem manter um timer por ping.
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

  const canMove = useCallback((token: Token): boolean => {
    const state = useStore.getState();
    if (state.session?.role === 'GM') return true;
    if (token.locked) return false;
    if (state.table?.settings.playersMoveOwnTokensOnly) {
      return token.ownerPlayerId === state.session?.playerId;
    }
    return true;
  }, []);

  /** Celulas cobertas pelo pincel de neblina, com raio ajustavel. */
  const brushCells = useCallback((currentScene: Scene, world: Point, radius: number): string[] => {
    const center = cellAt(currentScene.grid, world);
    return cellsWithinRadius(currentScene.grid, center, radius).map(cellKey);
  }, []);

  const flushFog = useCallback((action: 'reveal' | 'hide') => {
    const gesture = gestureRef.current;
    const currentScene = activeScene(useStore.getState());
    if (!currentScene || gesture.paintedCells.size === 0) return;

    void act('fog:paint', {
      sceneId: currentScene.id,
      cells: [...gesture.paintedCells],
      action,
    });
    gesture.paintedCells = new Set();
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

      const gesture = emptyGesture();
      gesture.startScreen = screen;
      gesture.lastScreen = screen;
      gesture.startWorld = world;
      gesture.cameraStart = { ...cameraRef.current };

      // Botao do meio e direito sempre movem a camera, seja qual for a
      // ferramenta ativa: é o gesto que a pessoa faz sem pensar.
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
        gesture.kind = 'fog';
        for (const cell of brushCells(currentScene, world, 1)) gesture.paintedCells.add(cell);
      } else if (state.tool === 'wall') {
        gesture.kind = 'wall';
        wallDraftRef.current = { from: world, to: world };
      } else {
        const vision = resolveVision(
          currentScene,
          state.session?.role ?? 'PLAYER',
          state.session?.playerId ?? null,
        );
        const token = tokenAtPoint(currentScene, world, new Set(state.hiddenLayers), vision);

        if (token) {
          state.selectToken(token.id);
          if (canMove(token)) {
            gesture.kind = 'drag-token';
            gesture.tokenId = token.id;
            gesture.tokenOffset = { x: world.x - token.x, y: world.y - token.y };
          }
        } else {
          state.selectToken(null);
          gesture.kind = 'pan';
        }
      }

      gestureRef.current = gesture;
      setDraftVersion((v) => v + 1);
    },
    [brushCells, canMove, toLocalScreen, toWorld],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const state = useStore.getState();
      const currentScene = activeScene(state);
      if (!currentScene) return;

      const world = toWorld(e);
      const screen = toLocalScreen(e);
      const gesture = gestureRef.current;

      // Cursor compartilhado, com folga para nao inundar a mesa.
      const now = performance.now();
      if (now - lastCursorRef.current > CURSOR_INTERVAL_MS) {
        lastCursorRef.current = now;
        emit('cursor:move', { sceneId: currentScene.id, x: world.x, y: world.y });
      }

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
          const token = currentScene.tokens.find((t) => t.id === gesture.tokenId);
          if (!token) break;
          const x = world.x - gesture.tokenOffset.x;
          const y = world.y - gesture.tokenOffset.y;

          // Aplicamos localmente e avisamos o servidor: o token acompanha o
          // dedo sem esperar a ida e volta pela rede.
          state.moveTokenLocal(currentScene.id, token.id, x, y);
          emit('token:move', { sceneId: currentScene.id, tokenId: token.id, x, y, dragging: true });

          const from = { x: gesture.startWorld.x, y: gesture.startWorld.y };
          const distance = measureDistance(currentScene.grid, from, world);
          setMeasureText({
            text: `${distance.toFixed(1)} ${currentScene.grid.unitLabel}`,
            at: worldToScreen(cameraRef.current, viewportRef.current, world.x, world.y),
          });
          break;
        }

        case 'measure': {
          measureRef.current = { from: gesture.startWorld, to: world };
          const distance = measureDistance(currentScene.grid, gesture.startWorld, world);
          setMeasureText({
            text: `${distance.toFixed(1)} ${currentScene.grid.unitLabel}`,
            at: worldToScreen(cameraRef.current, viewportRef.current, world.x, world.y),
          });
          break;
        }

        case 'fog': {
          for (const cell of brushCells(currentScene, world, 1)) gesture.paintedCells.add(cell);
          if (now - lastFogFlushRef.current > FOG_FLUSH_MS) {
            lastFogFlushRef.current = now;
            flushFog(state.tool === 'fog-hide' ? 'hide' : 'reveal');
          }
          break;
        }

        case 'wall': {
          // Ctrl solta a parede da grid; sem ele, ela gruda nos vertices.
          const snapped = e.ctrlKey ? world : snapToGridVertex(currentScene, world);
          wallDraftRef.current = { from: gesture.startWorld, to: snapped };
          break;
        }

        default:
          break;
      }

      gesture.lastScreen = screen;
    },
    [brushCells, flushFog, toLocalScreen, toWorld],
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
          const token = currentScene.tokens.find((t) => t.id === gesture.tokenId);
          if (token) {
            let x = world.x - gesture.tokenOffset.x;
            let y = world.y - gesture.tokenOffset.y;

            // Previa local do snap para nao haver "pulo" quando a resposta do
            // servidor chegar com a posicao definitiva.
            if (currentScene.grid.snap && currentScene.grid.type !== 'none' && !e.ctrlKey) {
              const snapped = snapTokenPosition(currentScene.grid, { x, y }, token.scale);
              x = snapped.x;
              y = snapped.y;
            }

            state.moveTokenLocal(currentScene.id, token.id, x, y);
            void act('token:move', {
              sceneId: currentScene.id,
              tokenId: token.id,
              x,
              y,
              dragging: false,
            });
          }
          break;
        }

        case 'fog':
          flushFog(state.tool === 'fog-hide' ? 'hide' : 'reveal');
          break;

        case 'wall': {
          const draft = wallDraftRef.current;
          if (draft) {
            const length = Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y);
            // Um clique sem arraste nao vira parede de tamanho zero.
            if (length > currentScene.grid.size * 0.2) {
              void act('wall:create', {
                sceneId: currentScene.id,
                wall: {
                  x1: draft.from.x,
                  y1: draft.from.y,
                  x2: draft.to.x,
                  y2: draft.to.y,
                  door: e.altKey,
                },
              });
            }
          }
          wallDraftRef.current = null;
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
      setDraftVersion((v) => v + 1);
    },
    [flushFog, toWorld],
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

  // -- atalhos --------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const state = useStore.getState();
      const currentScene = activeScene(state);

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
        case 'f':
          if (currentScene && viewportRef.current.width) {
            cameraRef.current = fitScene(currentScene, viewportRef.current);
            setZoomLabel(cameraRef.current.zoom);
          }
          break;
        case 'delete':
        case 'backspace': {
          if (state.session?.role !== 'GM' || !state.selectedTokenId || !currentScene) break;
          void act('token:delete', {
            sceneId: currentScene.id,
            tokenId: state.selectedTokenId,
          });
          break;
        }
        case 'escape':
          state.selectToken(null);
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

  void draftVersion;
  void sideOpen;

  return (
    <div className="stage" ref={hostRef}>
      <canvas
        ref={canvasRef}
        style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div className="stage-overlay">
        {measureText && (
          <div
            className="measure-readout"
            style={{ left: measureText.at.x, top: measureText.at.y }}
          >
            {measureText.text}
          </div>
        )}

        {Object.values(peers).map((peer) => {
          const p = worldToScreen(cameraRef.current, viewportRef.current, peer.x, peer.y);
          return (
            <div key={peer.playerId} className="peer-cursor" style={{ left: p.x, top: p.y }}>
              <svg width="12" height="16" viewBox="0 0 12 16" fill="none">
                <path d="M1 1L1 13L4.5 9.5L7 15L9 14L6.5 8.5L11 8L1 1Z" fill={peer.color} stroke="#0c0e13" />
              </svg>
              <span className="tip" style={{ background: peer.color }}>
                {peer.name}
              </span>
            </div>
          );
        })}

        {pings.map((ping) => {
          const p = worldToScreen(cameraRef.current, viewportRef.current, ping.x, ping.y);
          return <PingMark key={ping.id} x={p.x} y={p.y} color={ping.color} />;
        })}
      </div>

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
