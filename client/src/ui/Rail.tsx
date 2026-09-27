import { isGm, useStore, type Tool, type WallKind } from '../state/store';
import { Icon, type IconName } from './icons';

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
  icon: IconName;
  tip: string;
}

const TOOLS: ToolDef[] = [
  { id: 'select', icon: 'select', tip: 'Selecionar e mover (V) — arraste no vazio para selecionar varios' },
  { id: 'pan', icon: 'pan', tip: 'Mover o mapa (H) — ou arraste com o botao direito' },
  { id: 'measure', icon: 'measure', tip: 'Medir distancia (M)' },
  { id: 'ping', icon: 'ping', tip: 'Ping no mapa (P) — Alt para puxar a camera da mesa' },
];

const GM_TOOLS: ToolDef[] = [
  { id: 'fog-reveal', icon: 'fogReveal', tip: 'Revelar neblina' },
  { id: 'fog-hide', icon: 'fogHide', tip: 'Cobrir com neblina' },
  { id: 'wall', icon: 'wall', tip: 'Parede — cada clique ja grava o trecho; duplo clique ou Esc encerra, Ctrl solta da grade' },
  { id: 'tile', icon: 'tile', tip: 'Colocar tile — arraste a area; usa a imagem selecionada em Imagens' },
];

const WALL_KINDS: { id: WallKind; icon: IconName; tip: string }[] = [
  { id: 'wall', icon: 'wall', tip: 'Parede solida — barra a visao e a passagem' },
  { id: 'door', icon: 'door', tip: 'Porta — abre e fecha; Alt no clique faz uma porta avulsa' },
  { id: 'window', icon: 'window', tip: 'Janela — deixa ver o outro lado, mas barra a passagem' },
];

export function Rail(): JSX.Element {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const gm = useStore(isGm);
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
          <Icon name={t.icon} size="lg" />
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
              <Icon name={t.icon} size="lg" />
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
                aria-label={kind.tip}
              >
                <Icon name={kind.icon} size="lg" />
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
                aria-label="Pincel livre"
              >
                <Icon name="brush" size="lg" />
              </button>
              <button
                className={`tool${fogShape === 'rect' ? ' active' : ''}`}
                data-tip="Area retangular — revela uma sala inteira de uma vez"
                onClick={() => setFogShape('rect')}
                aria-label="Area retangular"
              >
                <Icon name="area" size="lg" />
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
                  aria-label={fogSeal ? 'Selando area' : 'Cobrindo area'}
                  aria-pressed={fogSeal}
                >
                  <Icon name={fogSeal ? 'sealed' : 'unsealed'} size="lg" />
                </button>
              )}
              {fogShape === 'brush' && (
                <div className="rail-brush" title="Tamanho do pincel">
                  <button
                    className="tool sm"
                    data-tip="Pincel menor"
                    onClick={() => setFogBrush(fogBrush - 1)}
                    disabled={fogBrush <= 0}
                    aria-label="Pincel menor"
                  >
                    <Icon name="remove" size="sm" />
                  </button>
                  <span className="mono">{fogBrush * 2 + 1}</span>
                  <button
                    className="tool sm"
                    data-tip="Pincel maior"
                    onClick={() => setFogBrush(fogBrush + 1)}
                    disabled={fogBrush >= 8}
                    aria-label="Pincel maior"
                  >
                    <Icon name="add" size="sm" />
                  </button>
                </div>
              )}
            </>
          )}

          <span className="sep" />

          <button
            className={`tool${showPartyVision ? ' active' : ''}`}
            data-tip="Mostrar ate onde o grupo enxerga"
            onClick={togglePartyVision}
            aria-label="Mostrar ate onde o grupo enxerga"
            aria-pressed={showPartyVision}
          >
            <Icon name="partyVision" size="lg" />
          </button>

          <button
            className="tool"
            data-tip={undoDepth > 0 ? `Desfazer (Ctrl+Z) — ${undoDepth} acao(oes)` : 'Nada para desfazer'}
            onClick={undo}
            disabled={undoDepth === 0}
            aria-label="Desfazer"
          >
            <Icon name="undo" size="lg" />
          </button>

          <button
            className="tool"
            data-tip={redoDepth > 0 ? `Refazer (Ctrl+Y) — ${redoDepth} acao(oes)` : 'Nada para refazer'}
            onClick={redo}
            disabled={redoDepth === 0}
            aria-label="Refazer"
          >
            <Icon name="redo" size="lg" />
          </button>
        </>
      )}
    </nav>
  );
}
