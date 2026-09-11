import { findAsset, useStore } from '../state/store';
import { Modal } from './common';

/**
 * Janela do material.
 *
 * Abre por escolha da pessoa (pela aba Materiais) ou quando o mestre
 * apresenta. A imagem manda no layout: uma carta ou um retrato pedem tamanho,
 * e o texto acompanha embaixo em vez de disputar espaco ao lado.
 */
export function HandoutModal({ handoutId }: { handoutId: string }): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const close = useStore((s) => s.openHandout);

  void rev;
  const handout = table?.handouts.find((h) => h.id === handoutId);
  if (!handout) return null;

  const asset = findAsset(handout.assetId);

  return (
    <Modal title={handout.title} onClose={() => close(null)} wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {asset && (
          <img
            src={asset.url}
            alt={handout.title}
            style={{
              width: '100%',
              maxHeight: '58vh',
              objectFit: 'contain',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--line)',
              background: 'var(--void)',
            }}
          />
        )}

        {handout.text.trim() ? (
          <p className="handout-text">{handout.text}</p>
        ) : (
          !asset && <span className="hint">Este material ainda esta vazio.</span>
        )}
      </div>
    </Modal>
  );
}
