import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canDeleteOnBoard,
  canEditBoard,
  NOTE_COLORS,
  THREAD_COLORS,
  type BoardItem,
  type BoardThread,
  type ClueBoard,
} from '@rpg/shared';

import { uploadAsset } from '../net/api';
import { act, emit } from '../net/socket';
import { findAsset, isGm, useStore } from '../state/store';

/**
 * Quadro de pistas, em tela cheia.
 *
 * E DOM, e nao canvas: sao poucas dezenas de papeis com texto editavel e
 * imagens, e o navegador ja sabe fazer isso bem. Os fios sao um SVG por baixo
 * dos papeis. Cada pessoa tem a propria camera (pan e zoom), como no mapa — ela
 * vive aqui e nao viaja pela rede.
 */

interface BoardCamera {
  x: number;
  y: number;
  zoom: number;
}

/** A camera sobrevive a fechar e reabrir o quadro na mesma aba. */
let savedCamera: BoardCamera = { x: 0, y: 0, zoom: 1 };

/** Intervalo entre posicoes enviadas durante o arraste de um papel. */
const DRAG_EMIT_MS = 45;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;

/** Onde o fio prende no papel: o alfinete, no alto. */
function pinOf(item: BoardItem): { x: number; y: number } {
  return { x: item.x + item.width / 2, y: item.y + 12 };
}

export function ClueBoardView(): JSX.Element | null {
  const open = useStore((s) => s.boardOpen);
  const setOpen = useStore((s) => s.setBoardOpen);
  const boardRev = useStore((s) => s.boardRev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const myId = useStore((s) => s.session?.playerId ?? null);
  const notify = useStore((s) => s.notify);
  void boardRev;

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [camera, setCameraState] = useState<BoardCamera>(savedCamera);
  const setCamera = (c: BoardCamera) => {
    savedCamera = c;
    setCameraState(c);
  };

  /** Fio em construcao: o primeiro papel ja escolhido. */
  const [threadFrom, setThreadFrom] = useState<string | null>(null);
  const [threadMode, setThreadMode] = useState(false);
  const [threadColor, setThreadColor] = useState(THREAD_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [handoutPicker, setHandoutPicker] = useState(false);

  const drag = useRef<{
    kind: 'pan' | 'item';
    itemId?: string;
    startX: number;
    startY: number;
    origin: { x: number; y: number };
    lastEmit: number;
    moved: boolean;
  } | null>(null);

  const board: ClueBoard = table?.clueBoard ?? { locked: false, items: [], threads: [] };
  const role = gm ? 'GM' : 'PLAYER';
  const editable = canEditBoard(board, role);

  // Esc fecha o fio em curso, a edicao, e por fim o quadro.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (threadFrom || threadMode) {
        setThreadFrom(null);
        setThreadMode(false);
      } else if (editingId) {
        setEditingId(null);
      } else {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, threadFrom, threadMode, editingId, setOpen]);

  /** Centro do que esta na tela, em coordenadas do quadro. */
  const viewCenter = useCallback((): { x: number; y: number } => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    return { x: (w / 2 - camera.x) / camera.zoom, y: (h / 2 - camera.y) / camera.zoom };
  }, [camera]);

  if (!open || !table) return null;

  // -- criar ----------------------------------------------------------------

  function place(width: number, height: number): { x: number; y: number } {
    const c = viewCenter();
    // Um pouco espalhado, para dois papeis novos nao nascerem um sobre o outro.
    const jitter = () => Math.round((Math.random() - 0.5) * 80);
    return { x: Math.round(c.x - width / 2) + jitter(), y: Math.round(c.y - height / 2) + jitter() };
  }

  function addNote(): void {
    const at = place(190, 150);
    void act<BoardItem>('board:create-item', { kind: 'note', ...at, text: '', color: NOTE_COLORS[0] }).then(
      (item) => item && setEditingId(item.id),
    );
  }

  async function addImage(file: File): Promise<void> {
    try {
      const asset = await uploadAsset(file, 'clue');
      const at = place(240, 180);
      void act('board:create-item', { kind: 'image', ...at, assetId: asset.id });
    } catch (err) {
      notify('error', (err as Error).message);
    }
  }

  function addHandout(handoutId: string): void {
    setHandoutPicker(false);
    const at = place(210, 160);
    void act('board:create-item', { kind: 'handout', ...at, handoutId });
  }

  // -- ponteiro -------------------------------------------------------------

  function onSurfaceDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('board-world')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, origin: { x: camera.x, y: camera.y }, lastEmit: 0, moved: false };
    setThreadFrom(null);
  }

  function onItemDown(e: React.PointerEvent<HTMLDivElement>, item: BoardItem): void {
    if ((e.target as HTMLElement).closest('button, textarea, input, select')) return;
    e.stopPropagation();

    if (threadMode && editable) {
      if (!threadFrom) {
        setThreadFrom(item.id);
      } else if (threadFrom !== item.id) {
        void act('board:create-thread', { fromId: threadFrom, toId: item.id, color: threadColor });
        setThreadFrom(null);
      }
      return;
    }

    if (!editable || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      kind: 'item',
      itemId: item.id,
      startX: e.clientX,
      startY: e.clientY,
      origin: { x: item.x, y: item.y },
      lastEmit: 0,
      moved: false,
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;

    if (d.kind === 'pan') {
      setCamera({ ...camera, x: d.origin.x + dx, y: d.origin.y + dy });
      return;
    }

    const x = Math.round(d.origin.x + dx / camera.zoom);
    const y = Math.round(d.origin.y + dy / camera.zoom);
    useStore.getState().moveBoardItemLocal(d.itemId!, x, y);
    const now = performance.now();
    if (now - d.lastEmit >= DRAG_EMIT_MS) {
      d.lastEmit = now;
      emit('board:move-item', { itemId: d.itemId, x, y, dragging: true });
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind !== 'item' || !d.moved) return;
    const x = Math.round(d.origin.x + (e.clientX - d.startX) / camera.zoom);
    const y = Math.round(d.origin.y + (e.clientY - d.startY) / camera.zoom);
    useStore.getState().moveBoardItemLocal(d.itemId!, x, y);
    // O evento final grava; os de arraste so circulam.
    void act('board:move-item', { itemId: d.itemId, x, y, dragging: false });
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
    // Zoom no cursor: o ponto sob ele continua sob ele.
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const wx = (px - camera.x) / camera.zoom;
    const wy = (py - camera.y) / camera.zoom;
    setCamera({ zoom, x: px - wx * zoom, y: py - wy * zoom });
  }

  // -- desenho --------------------------------------------------------------

  const itemsById = new Map(board.items.map((i) => [i.id, i]));
  const myHandouts = table.handouts;

  return (
    <div className="board-view" role="dialog" aria-label="Quadro de pistas">
      <header className="board-bar">
        <strong className="board-title">📌 Quadro de pistas</strong>
        {board.locked && <span className="tag gm">travado pelo mestre</span>}

        {editable && (
          <>
            <button className="btn sm" onClick={addNote}>
              + Nota
            </button>
            <label className="btn sm" style={{ cursor: 'pointer' }}>
              + Imagem
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void addImage(file);
                }}
              />
            </label>
            <div className="board-picker">
              <button className="btn sm" onClick={() => setHandoutPicker(!handoutPicker)} disabled={myHandouts.length === 0}>
                + Material
              </button>
              {handoutPicker && (
                <div className="board-picker-list">
                  {myHandouts.map((h) => (
                    <button key={h.id} className="item" onClick={() => addHandout(h.id)}>
                      {h.title}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <span className="topbar-sep" aria-hidden="true" />
            <button
              className={`btn sm${threadMode ? ' primary' : ''}`}
              onClick={() => {
                setThreadMode(!threadMode);
                setThreadFrom(null);
              }}
              title="Ligar dois papeis com um fio: clique no primeiro, depois no segundo"
            >
              🧵 Fio
            </button>
            {threadMode &&
              THREAD_COLORS.map((c) => (
                <button
                  key={c}
                  className={`board-swatch${threadColor === c ? ' on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setThreadColor(c)}
                  aria-label={`Fio ${c}`}
                />
              ))}
          </>
        )}

        <div className="spacer" />
        {gm && (
          <button
            className={`btn sm${board.locked ? ' primary' : ''}`}
            onClick={() => void act('board:lock', { locked: !board.locked })}
            title="Travado, o quadro fica somente leitura para os jogadores"
          >
            {board.locked ? '🔒 Travado' : '🔓 Travar'}
          </button>
        )}
        <button className="btn sm" onClick={() => setOpen(false)}>
          Fechar
        </button>
      </header>

      {threadMode && (
        <div className="stage-tip board-tip">
          {threadFrom ? 'Agora clique no segundo papel' : 'Clique no primeiro papel do fio'} · <strong>Esc</strong> cancela
        </div>
      )}

      <div
        ref={surfaceRef}
        className="board-surface"
        onPointerDown={onSurfaceDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="board-world"
          style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
        >
          <svg className="board-threads" aria-hidden="true">
            {board.threads.map((thread) => {
              const a = itemsById.get(thread.fromId);
              const b = itemsById.get(thread.toId);
              if (!a || !b) return null;
              return (
                <ThreadLine
                  key={thread.id}
                  thread={thread}
                  from={pinOf(a)}
                  to={pinOf(b)}
                  deletable={canDeleteOnBoard(board, thread, role, myId)}
                />
              );
            })}
          </svg>

          {board.items.map((item) => (
            <BoardPaper
              key={item.id}
              item={item}
              editing={editingId === item.id}
              selected={threadFrom === item.id}
              editable={editable}
              deletable={canDeleteOnBoard(board, item, role, myId)}
              onPointerDown={(e) => onItemDown(e, item)}
              onEdit={() => editable && item.kind === 'note' && setEditingId(item.id)}
              onDoneEditing={() => setEditingId(null)}
            />
          ))}
        </div>

        {board.items.length === 0 && (
          <div className="board-empty">
            O quadro esta vazio. Prenda uma nota, uma imagem ou um material e ligue as pistas com
            fios. Arraste o fundo para mover o quadro; a roda do mouse aproxima.
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadLine({
  thread,
  from,
  to,
  deletable,
}: {
  thread: BoardThread;
  from: { x: number; y: number };
  to: { x: number; y: number };
  deletable: boolean;
}): JSX.Element {
  // Fio de verdade cede um pouco no meio.
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2 + Math.min(60, Math.hypot(to.x - from.x, to.y - from.y) * 0.08);
  const d = `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;
  return (
    <g className={deletable ? 'deletable' : ''}>
      <path d={d} stroke={thread.color} strokeWidth={3} fill="none" strokeLinecap="round" />
      {deletable && (
        <path
          d={d}
          className="board-thread-hit"
          stroke="transparent"
          strokeWidth={16}
          fill="none"
          onClick={() => {
            if (window.confirm('Cortar este fio?')) void act('board:delete-thread', { threadId: thread.id });
          }}
        >
          <title>Clique para cortar o fio</title>
        </path>
      )}
    </g>
  );
}

function BoardPaper({
  item,
  editing,
  selected,
  editable,
  deletable,
  onPointerDown,
  onEdit,
  onDoneEditing,
}: {
  item: BoardItem;
  editing: boolean;
  selected: boolean;
  editable: boolean;
  deletable: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onEdit: () => void;
  onDoneEditing: () => void;
}): JSX.Element {
  const table = useStore((s) => s.table);
  const openHandout = useStore((s) => s.openHandout);
  const [draft, setDraft] = useState(item.text);
  useEffect(() => {
    if (!editing) setDraft(item.text);
  }, [item.text, editing]);

  const style: React.CSSProperties = {
    left: item.x,
    top: item.y,
    width: item.width,
    minHeight: item.height,
    transform: `rotate(${item.rotation}deg)`,
    background: item.kind === 'note' ? item.color : undefined,
  };

  let body: JSX.Element;
  if (item.kind === 'note') {
    body = editing ? (
      <textarea
        className="board-note-edit"
        autoFocus
        maxLength={1000}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== item.text) void act('board:update-item', { itemId: item.id, patch: { text: draft } });
          onDoneEditing();
        }}
      />
    ) : (
      <p className="board-note-text">{item.text || (editable ? 'Clique duas vezes para escrever.' : '')}</p>
    );
  } else if (item.kind === 'image') {
    const asset = findAsset(item.assetId);
    body = asset ? (
      <img src={asset.url} alt="" draggable={false} />
    ) : (
      <span className="board-missing">Imagem removida</span>
    );
  } else {
    const handout = table?.handouts.find((h) => h.id === item.handoutId);
    const asset = findAsset(handout?.assetId);
    body =
      item.unavailable || !handout ? (
        // Sem titulo, sem imagem, sem id: so a forma de um papel virado.
        <span className="board-missing">Material indisponivel</span>
      ) : (
        <button className="board-handout" onClick={() => openHandout(handout.id)} title="Abrir o material">
          {asset && <img src={asset.thumbUrl ?? asset.url} alt="" draggable={false} />}
          <strong>{handout.title}</strong>
        </button>
      );
  }

  return (
    <div
      className={`board-paper ${item.kind}${selected ? ' selected' : ''}${item.unavailable ? ' unavailable' : ''}`}
      style={style}
      onPointerDown={onPointerDown}
      onDoubleClick={onEdit}
    >
      <span className="board-pin" aria-hidden="true" />
      {body}
      {(deletable || (editable && item.kind === 'note')) && (
        <div className="board-paper-tools">
          {editable &&
            item.kind === 'note' &&
            NOTE_COLORS.map((c) => (
              <button
                key={c}
                className="board-swatch"
                style={{ background: c }}
                onClick={() => void act('board:update-item', { itemId: item.id, patch: { color: c } })}
                aria-label="Cor do papel"
              />
            ))}
          {deletable && (
            <button
              className="board-remove"
              onClick={() => void act('board:delete-item', { itemId: item.id })}
              title="Tirar do quadro"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}
