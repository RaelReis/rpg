import { useEffect, useState } from 'react';

import { Stage } from './canvas/Stage';
import { connectAndResume } from './net/socket';
import { useStore } from './state/store';
import { CharacterSetup } from './ui/CharacterSetup';
import { Gate } from './ui/Gate';
import { HandoutModal } from './ui/HandoutModal';
import { Notices } from './ui/Notices';
import { Icon } from './ui/icons';
import { PartyHud } from './ui/PartyHud';
import { Rail } from './ui/Rail';
import { SceneStrip } from './ui/SceneStrip';
import { Side } from './ui/Side';
import { SheetModal } from './ui/SheetModal';
import { TemplateEditor } from './ui/TemplateEditor';
import { Topbar } from './ui/Topbar';

export function App(): JSX.Element {
  const table = useStore((s) => s.table);
  const session = useStore((s) => s.session);
  const templateEditorOpen = useStore((s) => s.templateEditorOpen);
  const sheetModalId = useStore((s) => s.sheetModalId);
  const openHandoutId = useStore((s) => s.openHandoutId);
  const [restoring, setRestoring] = useState(true);

  /**
   * Antes de mostrar a tela de entrada, tentamos retomar a sessao guardada no
   * navegador. Quem fechou a aba no meio da sessao volta direto para a mesa,
   * sem digitar codigo de novo.
   */
  useEffect(() => {
    let cancelled = false;
    connectAndResume()
      .catch(() => false)
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (restoring) {
    return (
      <div className="gate">
        <div className="hint">Retomando sessao...</div>
      </div>
    );
  }

  if (!session || !table) {
    return (
      <>
        <Gate />
        <Notices />
      </>
    );
  }

  return (
    <div className="app">
      <Topbar />
      <SceneStrip />
      <div className="workspace">
        <div className="stage-wrap">
          <Stage />
          <PartyHud />
          <Rail />
          <SideToggle />
        </div>
        <Side />
      </div>

      <CharacterSetup key={`${session.tableId}:${session.playerId}`} />
      {templateEditorOpen && <TemplateEditor />}
      {sheetModalId && <SheetModal sheetId={sheetModalId} />}
      {openHandoutId && <HandoutModal handoutId={openHandoutId} />}
      <Notices />
    </div>
  );
}

/**
 * Aba presa a borda entre o mapa e o painel, que o recolhe e o traz de volta.
 *
 * Ficava no cabecalho, colada ao "Sair": quem ia esconder o painel acabava
 * saindo da mesa. Aqui ela esta onde o painel esta, a tela inteira de
 * distancia do botao de sair, e continua visivel com o painel fechado.
 */
function SideToggle(): JSX.Element {
  const open = useStore((s) => s.sideOpen);
  const toggle = useStore((s) => s.toggleSide);
  return (
    <button
      className={`side-toggle${open ? '' : ' closed'}`}
      onClick={toggle}
      title={open ? 'Ocultar painel' : 'Mostrar painel'}
      aria-label={open ? 'Ocultar painel' : 'Mostrar painel'}
      aria-expanded={open}
    >
      <Icon name={open ? 'panelHide' : 'panelShow'} size="sm" />
    </button>
  );
}
