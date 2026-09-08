import { LAYER_NAMES, type Layer } from '@rpg/shared';

import { isGm, useStore, type Tool } from '../state/store';

/**
 * Trilho de ferramentas.
 *
 * As ferramentas de mestre (neblina, paredes) ficam separadas por um traco e
 * simplesmente nao existem para o jogador — nao aparecem desabilitadas, para
 * a barra dele nao virar um mostruario do que ele nao pode fazer.
 */

interface ToolDef {
  id: Tool;
  icon: string;
  tip: string;
  gmOnly?: boolean;
}

const TOOLS: ToolDef[] = [
  { id: 'select', icon: '⬚', tip: 'Selecionar e mover (V)' },
  { id: 'pan', icon: '✋', tip: 'Mover o mapa (H) — ou arraste com o botao direito' },
  { id: 'measure', icon: '📏', tip: 'Medir distancia (M)' },
  { id: 'ping', icon: '◎', tip: 'Ping no mapa (P) — Alt para puxar a camera da mesa' },
];

const GM_TOOLS: ToolDef[] = [
  { id: 'fog-reveal', icon: '☀', tip: 'Revelar neblina', gmOnly: true },
  { id: 'fog-hide', icon: '🌫', tip: 'Cobrir com neblina', gmOnly: true },
  { id: 'wall', icon: '▨', tip: 'Desenhar parede — Alt para porta, Ctrl solta da grid', gmOnly: true },
];

export function Rail(): JSX.Element {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const gm = useStore(isGm);
  const hiddenLayers = useStore((s) => s.hiddenLayers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const showPartyVision = useStore((s) => s.showPartyVision);
  const togglePartyVision = useStore((s) => s.togglePartyVision);

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
        </>
      )}
    </nav>
  );
}
