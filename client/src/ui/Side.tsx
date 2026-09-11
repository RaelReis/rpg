import { isGm, useStore, type SideTab } from '../state/store';
import { ErrorBoundary } from './ErrorBoundary';
import { AssetsPanel } from './panels/AssetsPanel';
import { HandoutsPanel } from './panels/HandoutsPanel';
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
  { id: 'handouts', label: 'Materiais' },
  { id: 'assets', label: 'Imagens' },
  { id: 'players', label: 'Mesa' },
];

const PLAYER_TABS: { id: SideTab; label: string }[] = [
  { id: 'sheet', label: 'Ficha' },
  { id: 'initiative', label: 'Turnos' },
  { id: 'chat', label: 'Chat' },
  { id: 'handouts', label: 'Materiais' },
];

export function Side(): JSX.Element {
  const gm = useStore(isGm);
  const tab = useStore((s) => s.sideTab);
  const setTab = useStore((s) => s.setSideTab);
  const open = useStore((s) => s.sideOpen);
  const unreadChat = useStore((s) => s.unreadChat);

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
            {t.id === 'chat' && unreadChat > 0 && current !== 'chat' && (
              <span className="badge">{unreadChat > 99 ? '99+' : unreadChat}</span>
            )}
          </button>
        ))}
      </div>

      <div className="side-body">
        {/* A chave por aba reinicia a barreira ao trocar de painel: um erro
            em Fichas nao deve deixar as outras abas presas no estado de falha. */}
        <ErrorBoundary key={current} area={`O painel "${current}"`}>
          {current === 'scene' && <ScenePanel />}
          {current === 'tokens' && <TokensPanel />}
          {current === 'sheet' && <SheetPanel />}
          {current === 'initiative' && <InitiativePanel />}
          {current === 'chat' && <ChatPanel />}
          {current === 'handouts' && <HandoutsPanel />}
          {current === 'assets' && <AssetsPanel />}
          {current === 'players' && <PlayersPanel />}
        </ErrorBoundary>
      </div>
    </aside>
  );
}
