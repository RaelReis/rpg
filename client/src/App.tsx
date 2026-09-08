import { useEffect, useState } from 'react';

import { Stage } from './canvas/Stage';
import { connectAndResume } from './net/socket';
import { useStore } from './state/store';
import { Gate } from './ui/Gate';
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
        </div>
        <Side />
      </div>

      {templateEditorOpen && <TemplateEditor />}
      {sheetModalId && <SheetModal sheetId={sheetModalId} />}
      <Notices />
    </div>
  );
}
