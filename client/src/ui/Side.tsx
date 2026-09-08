import { isGm, useStore, type SideTab } from '../state/store';
import { AssetsPanel } from './panels/AssetsPanel';
import { ChatPanel } from './panels/ChatPanel';
import { InitiativePanel } from './panels/InitiativePanel';
import { PlayersPanel } from './panels/PlayersPanel';
import { ScenePanel } from './panels/ScenePanel';
import { SheetPanel } from './panels/SheetPanel';
import { TokensPanel } from './panels/TokensPanel';

/**
 * Painel lateral.
 *
 * As abas mudam com o papel: o jogador nao ve "Cena", "Imagens" nem
 * "Jogadores", porque nada ali seria acionavel por ele. Preferimos abas
 * ausentes a abas desabilitadas.
 */

const GM_TABS: { id: SideTab; label: string }[] = [
  { id: 'scene', label: 'Cena' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'sheet', label: 'Fichas' },
  { id: 'initiative', label: 'Turnos' },
  { id: 'chat', label: 'Chat' },
  { id: 'assets', label: 'Imagens' },
  { id: 'players', label: 'Mesa' },
];

const PLAYER_TABS: { id: SideTab; label: string }[] = [
  { id: 'sheet', label: 'Ficha' },
  { id: 'initiative', label: 'Turnos' },
  { id: 'chat', label: 'Chat' },
];

export function Side(): JSX.Element {
  const gm = useStore(isGm);
  const tab = useStore((s) => s.sideTab);
  const setTab = useStore((s) => s.setSideTab);
  const open = useStore((s) => s.sideOpen);

  const tabs = gm ? GM_TABS : PLAYER_TABS;
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  return (
    <aside className={`side${open ? '' : ' hidden'}`}>
      <div className="side-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={current === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="side-body">
        {current === 'scene' && <ScenePanel />}
        {current === 'tokens' && <TokensPanel />}
        {current === 'sheet' && <SheetPanel />}
        {current === 'initiative' && <InitiativePanel />}
        {current === 'chat' && <ChatPanel />}
        {current === 'assets' && <AssetsPanel />}
        {current === 'players' && <PlayersPanel />}
      </div>
    </aside>
  );
}
