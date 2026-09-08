import { useStore } from '../state/store';
import { Modal } from './common';
import { SheetView } from './SheetView';

/** Ficha aberta em janela, para consultar sem perder o mapa de vista. */
export function SheetModal({ sheetId }: { sheetId: string }): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const close = useStore((s) => s.openSheetModal);

  void rev;
  const sheet = table?.sheets.find((s) => s.id === sheetId);
  if (!sheet) return null;

  return (
    <Modal title={sheet.name} onClose={() => close(null)} wide>
      <SheetView sheet={sheet} />
    </Modal>
  );
}
