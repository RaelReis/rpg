import { useEffect, useState } from 'react';

import { Stage } from './canvas/Stage';
import { connectAndResume } from './net/socket';
import { useStore } from './state/store';
import { Gate } from './ui/Gate';
import { HandoutModal } from './ui/HandoutModal';
import { Notices } from './ui/Notices';
import { Rail } from './ui/Rail';
import { Side } from './ui/Side';
import { SheetModal } from './ui/SheetModal';
import { TemplateEditor } from './ui/TemplateEditor';
import { Topbar } from './ui/Topbar';
import { TurnBanner } from './ui/TurnBanner';

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
      <div className="workspace">
        <Rail />
        <div className="stage-wrap">
          <Stage />
          <TurnBanner />
          <SideToggle />
        </div>
        <Side />
      </div>

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
      {open ? '›' : '‹'}
    </button>
  );
}
