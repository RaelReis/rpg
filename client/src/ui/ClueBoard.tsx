import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BoardItem, BoardThread } from '@rpg/shared';

import { uploadAsset } from '../net/api';
import { act, emit } from '../net/socket';
import { findAsset, isGm, useStore } from '../state/store';
import { Icon } from './icons';

/**
 * Quadro de pistas: cortica, papeis e fios vermelhos.
 *
 * E DOM, e nao canvas: sao poucas dezenas de itens com texto editavel, e o
 * navegador ja sabe desenhar, selecionar e digitar. A camera (pan e zoom) e
 * de cada participante, como no mapa. O que muda no quadro vai ao servidor,
 * que devolve a todos ja filtrado — o cartao de um material que voce nao tem
 * chega como "indisponivel", sem titulo nem imagem.
 */

const WIDTH: Record<BoardItem['kind'], number> = { note: 180, image: 220, handout: 200 };
const NOTE_COLORS = ['#f3e3a1', '#f4b6b6', '#b8e0c8', '#b9d3f0', '#e3d0f5'];
const THREAD_COLORS = ['#c0392b', '#2d6cdf', '#27ae60', '#e1b12c', '#ecf0f1'];
/** Intervalo minimo entre posicoes enviadas durante o arraste. */
const DRAG_SEND_MS = 50;

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Pino no topo do item: e dali que o fio sai, como num quadro de verdade. */
function pinOf(item: BoardItem): { x: number; y: number } {
  return { x: item.x + WIDTH[item.kind] / 2, y: item.y + 8 };
}

export function ClueBoardView(): JSX.Element | null {
  const board = useStore((s) => s.table?.board ?? null);
  const handouts = useStore((s) => s.table?.handouts);
  const gm = useStore(isGm);
  const myId = useStore((s) => s.session?.playerId ?? null);
  const close = useStore((s) => s.setBoardOpen);
  const storedCamera = useStore((s) => s.boardCamera);
  const setStoredCamera = useStore((s) => s.setBoardCamera);
  const notify = useStore((s) => s.notify);

  const viewportRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState<Camera>(storedCamera ?? { x: 0, y: 0, zoom: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  /** Posicao local do item em arraste; o servidor so ve a posicao final. */
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; px: number; py: number; lastSent: number } | null>(
    null,
  );
  const panRef = useRef<{ px: number; py: number; cam: Camera } | null>(null);

  const [threadMode, setThreadMode] = useState(false);
  const [threadFrom, setThreadFrom] = useState<string | null>(null);
  const [threadColor, setThreadColor] = useState(THREAD_COLORS[0]);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]);

  const lockedForMe = !!board?.locked && !gm;

  // A camera sobrevive a fechar e reabrir o quadro.
  useEffect(() => () => setStoredCamera(cameraRef.current), [setStoredCamera]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        if (threadMode) {
          setThreadMode(false);
          setThreadFrom(null);
        } else close(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, threadMode]);

  /** Ponto do quadro no centro do que a pessoa esta vendo, para itens novos. */
  const viewCenter = useCallback((): { x: number; y: number } => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const cam = cameraRef.current;
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    return { x: (w / 2 - cam.x) / cam.zoom - 90, y: (h / 2 - cam.y) / cam.zoom - 60 };
  }, []);

  if (!board) return null;

  const items = board.items.map((i) => (dragPos && dragPos.id === i.id ? { ...i, x: dragPos.x, y: dragPos.y } : i));
  const byId = new Map(items.map((i) => [i.id, i]));
  const canRemove = (authorId: string | null) => !lockedForMe && (gm || (authorId !== null && authorId === myId));
  const selected = board.threads.find((t) => t.id === selectedThread) ?? null;

  // -- criar ---------------------------------------------------------------

  function addNote(): void {
    void act('board:create', { item: { kind: 'note', text: '', color: noteColor, ...viewCenter() } }).then(
      (created) => created && setEditing((created as BoardItem).id),
    );
  }

  function addHandout(handoutId: string): void {
    if (handoutId) void act('board:create', { item: { kind: 'handout', handoutId, ...viewCenter() } });
  }

  async function addImage(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    try {
      const asset = await uploadAsset(file, 'clue');
      await act('board:create', { item: { kind: 'image', assetId: asset.id, ...viewCenter() } });
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // -- camera --------------------------------------------------------------

  function onViewportDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('board-world')) return;
    setSelectedThread(null);
    panRef.current = { px: e.clientX, py: e.clientY, cam: cameraRef.current };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onViewportMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (!pan) return;
    setCamera({ ...pan.cam, x: pan.cam.x + e.clientX - pan.px, y: pan.cam.y + e.clientY - pan.py });
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cam = cameraRef.current;
    const zoom = Math.min(2.5, Math.max(0.25, cam.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // Zoom no cursor: o ponto sob o mouse fica parado.
    setCamera({ zoom, x: cx - ((cx - cam.x) * zoom) / cam.zoom, y: cy - ((cy - cam.y) * zoom) / cam.zoom });
  }

  // -- itens ---------------------------------------------------------------

  function onItemDown(e: ReactPointerEvent<HTMLDivElement>, item: BoardItem): void {
    const target = e.target as HTMLElement;
    if (target.closest('button, textarea, input, a')) return;
    e.stopPropagation();

    if (threadMode) {
      if (!threadFrom) setThreadFrom(item.id);
      else if (threadFrom !== item.id) {
        void act('thread:create', { from: threadFrom, to: item.id, color: threadColor });
        setThreadFrom(null);
      }
      return;
    }

    if (lockedForMe || e.button !== 0) return;
    dragRef.current = { id: item.id, startX: item.x, startY: item.y, px: e.clientX, py: e.clientY, lastSent: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onItemMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    const zoom = cameraRef.current.zoom;
    const x = Math.round(drag.startX + (e.clientX - drag.px) / zoom);
    const y = Math.round(drag.startY + (e.clientY - drag.py) / zoom);
    setDragPos({ id: drag.id, x, y });

    // Os outros veem o cartao andar; o banco so grava quando ele para.
    const now = performance.now();
    if (now - drag.lastSent >= DRAG_SEND_MS) {
      drag.lastSent = now;
      emit('board:update', { itemId: drag.id, patch: { x, y }, dragging: true });
    }
  }

  function onItemUp(): void {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !dragPos || dragPos.id !== drag.id) {
      setDragPos(null);
      return;
    }
    const { x, y } = dragPos;
    const item = board?.items.find((i) => i.id === drag.id);
    // Otimista: o cartao fica onde foi solto enquanto a confirmacao volta.
    if (item) useStore.getState().applyBoardPatch({ upsert: [{ ...item, x, y }] });
    setDragPos(null);
    void act('board:update', { itemId: drag.id, patch: { x, y } });
  }

  const handoutTitle = (item: BoardItem): { title: string; assetId: string | null } | null => {
    if (!item.handoutId) return null;
    const h = handouts?.find((x) => x.id === item.handoutId);
    return h ? { title: h.title, assetId: h.assetId } : null;
  };

  const worldStyle = { transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` };

  return (
    <div className="board-overlay" role="dialog" aria-label="Quadro de pistas">
      <header className="board-toolbar">
        <h2>
          <Icon name="board" /> Quadro de pistas
        </h2>
        {!lockedForMe && (
          <>
            <div className="board-colors" aria-label="Cor da nota">
              {NOTE_COLORS.map((c) => (
                <button
                  key={c}
                  className={`board-color${noteColor === c ? ' on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setNoteColor(c)}
                  title="Cor da proxima nota"
                />
              ))}
            </div>
            <button className="btn sm" onClick={addNote}>
              <Icon name="add" size="sm" /> Nota
            </button>
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              <Icon name="add" size="sm" /> Imagem
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif"
              onChange={(e) => void addImage(e.target.files)}
            />
            <select
              className="input select sm"
              value=""
              onChange={(e) => addHandout(e.target.value)}
              title="Pregar um material que voce recebeu"
            >
              <option value="">+ Material...</option>
              {(handouts ?? []).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.title}
                </option>
              ))}
            </select>
            <button
              className={`btn sm${threadMode ? ' primary' : ''}`}
              onClick={() => {
                setThreadMode(!threadMode);
                setThreadFrom(null);
              }}
              title="Ligar dois itens com um fio"
            >
              <Icon name="thread" size="sm" /> Fio
            </button>
            {threadMode && (
              <div className="board-colors" aria-label="Cor do fio">
                {THREAD_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`board-color${threadColor === c ? ' on' : ''}`}
                    style={{ background: c }}
                    onClick={() => setThreadColor(c)}
                    title="Cor do fio"
                  />
                ))}
              </div>
            )}
          </>
        )}
        <div className="spacer" />
        {gm && (
          <button
            className={`btn sm${board.locked ? ' danger' : ''}`}
            onClick={() => void act('board:lock', { locked: !board.locked })}
            title="Travado, o quadro fica somente leitura para os jogadores"
          >
            <Icon name={board.locked ? 'locked' : 'unsealed'} size="sm" /> {board.locked ? 'Travado' : 'Travar'}
          </button>
        )}
        <span className="mono sub">{Math.round(camera.zoom * 100)}%</span>
        <button
          className="btn ghost sm"
          onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}
          title="Voltar ao inicio"
          aria-label="Voltar ao inicio"
        >
          <Icon name="fitMap" size="sm" />
        </button>
        <button className="btn ghost sm" onClick={() => close(false)} aria-label="Fechar quadro">
          <Icon name="close" size="sm" />
        </button>
      </header>

      {lockedForMe && <div className="board-banner">O mestre travou o quadro: por enquanto, so leitura.</div>}
      {threadMode && (
        <div className="board-banner">
          {threadFrom ? 'Agora clique no segundo item.' : 'Clique no primeiro item que o fio vai ligar.'} Esc cancela.
        </div>
      )}

      <div
        ref={viewportRef}
        className={`board-viewport${threadMode ? ' threading' : ''}`}
        onPointerDown={onViewportDown}
        onPointerMove={onViewportMove}
        onPointerUp={() => (panRef.current = null)}
        onWheel={onWheel}
      >
        <div className="board-world" style={worldStyle}>
          <svg className="board-threads" width="1" height="1">
            {board.threads.map((thread: BoardThread) => {
              const a = byId.get(thread.from);
              const b = byId.get(thread.to);
              if (!a || !b) return null;
              const p = pinOf(a);
              const q = pinOf(b);
              // Leve curva para baixo: fio de verdade cede com o peso.
              const sag = Math.min(60, Math.hypot(q.x - p.x, q.y - p.y) * 0.12);
              const d = `M ${p.x} ${p.y} Q ${(p.x + q.x) / 2} ${(p.y + q.y) / 2 + sag} ${q.x} ${q.y}`;
              return (
                <g key={thread.id} onPointerDown={(e) => (e.stopPropagation(), setSelectedThread(thread.id))}>
                  <path d={d} className="board-thread-hit" />
                  <path
                    d={d}
                    className={`board-thread${thread.id === selectedThread ? ' selected' : ''}`}
                    style={{ stroke: thread.color }}
                  />
                </g>
              );
            })}
          </svg>

          {items.map((item) => {
            const linked = handoutTitle(item);
            const image = item.kind === 'image' ? findAsset(item.assetId) : linked ? findAsset(linked.assetId) : null;
            return (
              <div
                key={item.id}
                className={`board-item ${item.kind}${threadFrom === item.id ? ' linking' : ''}${
                  item.unavailable ? ' unavailable' : ''
                }`}
                style={{ left: item.x, top: item.y, width: WIDTH[item.kind], background: item.kind === 'note' ? item.color : undefined }}
                onPointerDown={(e) => onItemDown(e, item)}
                onPointerMove={onItemMove}
                onPointerUp={onItemUp}
                onDoubleClick={() => !lockedForMe && !item.unavailable && setEditing(item.id)}
              >
                <span className="board-pin" />

                {item.kind === 'handout' &&
                  (item.unavailable ? (
                    <div className="board-handout-missing">Material indisponivel</div>
                  ) : linked ? (
                    <div className="board-handout">
                      <strong>{linked.title}</strong>
                      <button
                        className="btn ghost sm"
                        onClick={() => useStore.getState().openHandout(item.handoutId)}
                      >
                        Abrir
                      </button>
                    </div>
                  ) : (
                    <div className="board-handout-missing">Material removido</div>
                  ))}

                {image && <img src={image.thumbUrl ?? image.url} alt="" draggable={false} />}

                {editing === item.id ? (
                  <NoteEditor
                    initial={item.text}
                    onDone={(text) => {
                      setEditing(null);
                      if (text !== item.text) void act('board:update', { itemId: item.id, patch: { text } });
                    }}
                  />
                ) : (
                  (item.text || item.kind === 'note') && (
                    <p className={item.text ? '' : 'placeholder'}>{item.text || 'Clique duas vezes para escrever'}</p>
                  )
                )}

                {canRemove(item.authorId) && (
                  <button
                    className="board-remove"
                    title="Apagar"
                    onClick={() => void act('board:delete', { itemId: item.id })}
                    aria-label="Apagar"
                  >
                    <Icon name="delete" size="sm" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {board.items.length === 0 && (
          <div className="board-empty">
            O quadro esta vazio. Pregue notas, imagens e os materiais que o grupo recebeu, e ligue as
            pistas com fios.
          </div>
        )}
      </div>

      {selected && !lockedForMe && (
        <div className="board-thread-menu">
          {THREAD_COLORS.map((c) => (
            <button
              key={c}
              className={`board-color${selected.color === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => void act('thread:update', { threadId: selected.id, color: c })}
            />
          ))}
          {canRemove(selected.authorId) && (
            <button
              className="btn ghost sm danger"
              onClick={() => {
                void act('thread:delete', { threadId: selected.id });
                setSelectedThread(null);
              }}
            >
              Cortar fio
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Texto da nota ou legenda; grava ao sair do campo. */
function NoteEditor({ initial, onDone }: { initial: string; onDone: (text: string) => void }): JSX.Element {
  const [text, setText] = useState(initial);
  return (
    <textarea
      className="board-note-input"
      autoFocus
      value={text}
      maxLength={1000}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone(initial);
      }}
    />
  );
}
