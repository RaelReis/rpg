import { LAYER_NAMES, type Layer } from '@rpg/shared';

import { isGm, useStore, type Tool, type WallKind } from '../state/store';

/**
 * Trilho de ferramentas.
 *
 * As ferramentas de mestre (neblina, paredes, tiles) ficam separadas por um
 * traco e simplesmente nao existem para o jogador — nao aparecem
 * desabilitadas, para a barra dele nao virar um mostruario do que ele nao
 * pode fazer.
 */

interface ToolDef {
  id: Tool;
  icon: string;
  tip: string;
}

const TOOLS: ToolDef[] = [
  { id: 'select', icon: '⬚', tip: 'Selecionar e mover (V) — arraste no vazio para selecionar varios' },
  { id: 'pan', icon: '✋', tip: 'Mover o mapa (H) — ou arraste com o botao direito' },
  { id: 'measure', icon: '📏', tip: 'Medir distancia (M)' },
  { id: 'ping', icon: '◎', tip: 'Ping no mapa (P) — Alt para puxar a camera da mesa' },
];

const GM_TOOLS: ToolDef[] = [
  { id: 'fog-reveal', icon: '☀', tip: 'Revelar neblina' },
  { id: 'fog-hide', icon: '🌫', tip: 'Cobrir com neblina' },
  { id: 'wall', icon: '▨', tip: 'Parede — cada clique grava um trecho; Enter ou Esc encerra, Ctrl solta da grade' },
  { id: 'tile', icon: '🧱', tip: 'Colocar tile — arraste a area; usa a imagem selecionada em Imagens' },
];

const WALL_KINDS: { id: WallKind; icon: string; tip: string }[] = [
  { id: 'wall', icon: '▤', tip: 'Parede solida — barra a visao e a passagem' },
  { id: 'door', icon: '🚪', tip: 'Porta — abre e fecha; Alt no clique faz uma porta avulsa' },
  { id: 'window', icon: '🪟', tip: 'Janela — deixa ver o outro lado, mas barra a passagem' },
];

export function Rail(): JSX.Element {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const gm = useStore(isGm);
  const hiddenLayers = useStore((s) => s.hiddenLayers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const showPartyVision = useStore((s) => s.showPartyVision);
  const togglePartyVision = useStore((s) => s.togglePartyVision);
  const fogBrush = useStore((s) => s.fogBrush);
  const setFogBrush = useStore((s) => s.setFogBrush);
  const fogShape = useStore((s) => s.fogShape);
  const setFogShape = useStore((s) => s.setFogShape);
  const fogSeal = useStore((s) => s.fogSeal);
  const setFogSeal = useStore((s) => s.setFogSeal);
  const wallKind = useStore((s) => s.wallKind);
  const setWallKind = useStore((s) => s.setWallKind);
  const undo = useStore((s) => s.undo);
  const undoDepth = useStore((s) => s.undoStack.length);
  const redo = useStore((s) => s.redo);
  const redoDepth = useStore((s) => s.redoStack.length);

  const painting = tool === 'fog-reveal' || tool === 'fog-hide';

  return (
    <nav className="rail">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool${tool === t.id ? ' active' : ''}`}
          data-tip={t.tip}
          onClick={() => setTool(t.id)}
          aria-label={t.tip}
        >
          {t.icon}
        </button>
      ))}

      {gm && (
        <>
          <span className="sep" />
          {GM_TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool${tool === t.id ? ' active' : ''}`}
              data-tip={t.tip}
              onClick={() => setTool(t.id)}
              aria-label={t.tip}
            >
              {t.icon}
            </button>
          ))}

          {/* O que a proxima parede vai ser. Fica visivel enquanto a
              ferramenta esta ativa, em vez de depender de lembrar a tecla. */}
          {tool === 'wall' &&
            WALL_KINDS.map((kind) => (
              <button
                key={kind.id}
                className={`tool${wallKind === kind.id ? ' active' : ''}`}
                data-tip={kind.tip}
                onClick={() => setWallKind(kind.id)}
              >
                {kind.icon}
              </button>
            ))}

          {/* Opcoes do pincel aparecem so quando ele esta em uso, para nao
              ocupar o trilho o tempo todo. */}
          {painting && (
            <>
              <button
                className={`tool${fogShape === 'brush' ? ' active' : ''}`}
                data-tip="Pincel livre"
                onClick={() => setFogShape('brush')}
              >
                ✎
              </button>
              <button
                className={`tool${fogShape === 'rect' ? ' active' : ''}`}
                data-tip="Area retangular — revela uma sala inteira de uma vez"
                onClick={() => setFogShape('rect')}
              >
                ▭
              </button>
              {/* Selar so faz sentido ao cobrir: e o que separa "fechar o
                  mapa" de "esta area o grupo nao ve de jeito nenhum". */}
              {tool === 'fog-hide' && (
                <button
                  className={`tool${fogSeal ? ' active danger' : ''}`}
                  data-tip={
                    fogSeal
                      ? 'Selando: nem os tokens revelam esta area'
                      : 'Cobrindo: o personagem que andar ate la revela de novo'
                  }
                  onClick={() => setFogSeal(!fogSeal)}
                >
                  {fogSeal ? '🔒' : '🔓'}
                </button>
              )}
              {fogShape === 'brush' && (
                <div className="rail-brush" title="Tamanho do pincel">
                  <button
                    className="tool sm"
                    data-tip="Pincel menor"
                    onClick={() => setFogBrush(fogBrush - 1)}
                    disabled={fogBrush <= 0}
                  >
                    −
                  </button>
                  <span className="mono">{fogBrush * 2 + 1}</span>
                  <button
                    className="tool sm"
                    data-tip="Pincel maior"
                    onClick={() => setFogBrush(fogBrush + 1)}
                    disabled={fogBrush >= 8}
                  >
                    +
                  </button>
                </div>
              )}
            </>
          )}

          <span className="sep" />

          {/* Ocultar camadas e um recurso de trabalho do mestre: muda apenas o
              que ELE ve, sem afetar o que chega aos jogadores. */}
          {([1, 2, 3, 4] as Layer[]).map((layer) => (
            <button
              key={layer}
              className={`tool${hiddenLayers.includes(layer) ? '' : ' active'}`}
              data-tip={`${LAYER_NAMES[layer]} — mostrar/ocultar na sua tela`}
              onClick={() => toggleLayer(layer)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
            >
              {layer}
            </button>
          ))}

          <span className="sep" />

          <button
            className={`tool${showPartyVision ? ' active' : ''}`}
            data-tip="Mostrar ate onde o grupo enxerga"
            onClick={togglePartyVision}
          >
            👁
          </button>

          <button
            className="tool"
            data-tip={undoDepth > 0 ? `Desfazer (Ctrl+Z) — ${undoDepth} acao(oes)` : 'Nada para desfazer'}
            onClick={undo}
            disabled={undoDepth === 0}
          >
            ↶
          </button>

          <button
            className="tool"
            data-tip={redoDepth > 0 ? `Refazer (Ctrl+Y) — ${redoDepth} acao(oes)` : 'Nada para refazer'}
            onClick={redo}
            disabled={redoDepth === 0}
          >
            ↷
          </button>
        </>
      )}
    </nav>
  );
}
