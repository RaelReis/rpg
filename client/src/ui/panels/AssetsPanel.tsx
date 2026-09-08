import { useState } from 'react';
import type { AssetKind } from '@rpg/shared';

import { formatBytes } from '../../net/api';
import { act } from '../../net/socket';
import { useStore } from '../../state/store';
import { Dropzone, Empty, SelectField, Section } from '../common';

/** Biblioteca de imagens da mesa. */

const KIND_LABELS: Record<AssetKind, string> = {
  map: 'Mapas',
  tile: 'Tiles',
  token: 'Tokens',
  portrait: 'Retratos',
  item: 'Itens',
  effect: 'Efeitos',
};

export function AssetsPanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const selectedAssetId = useStore((s) => s.selectedAssetId);
  const selectAsset = useStore((s) => s.selectAsset);
  const [kind, setKind] = useState<AssetKind>('token');
  const [filter, setFilter] = useState<AssetKind | 'all'>('all');

  void rev;
  if (!table) return <Empty>Sem mesa carregada.</Empty>;

  const assets = table.assets
    .filter((a) => filter === 'all' || a.kind === filter)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  const totalBytes = table.assets.reduce((sum, a) => sum + a.size, 0);

  return (
    <>
      <Section title="Enviar imagem">
        <SelectField
          label="Categoria"
          value={kind}
          options={(Object.keys(KIND_LABELS) as AssetKind[]).map((k) => ({
            value: k,
            label: KIND_LABELS[k],
          }))}
          onChange={setKind}
        />
        <Dropzone kind={kind} onUploaded={(id) => selectAsset(id)} multiple />
      </Section>

      <Section title={`Biblioteca (${table.assets.length})`}>
        <SelectField
          label="Filtrar"
          value={filter}
          options={[
            { value: 'all' as const, label: 'Todas' },
            ...(Object.keys(KIND_LABELS) as AssetKind[]).map((k) => ({
              value: k,
              label: KIND_LABELS[k],
            })),
          ]}
          onChange={setFilter}
        />

        {assets.length === 0 ? (
          <Empty>Nenhuma imagem nesta categoria.</Empty>
        ) : (
          <div className="asset-grid">
            {assets.map((asset) => (
              <button
                key={asset.id}
                className={`asset${asset.id === selectedAssetId ? ' selected' : ''}`}
                onClick={() => selectAsset(asset.id === selectedAssetId ? null : asset.id)}
                title={`${asset.originalName} — ${asset.width}×${asset.height}, ${formatBytes(asset.size)}`}
              >
                <img src={asset.thumbUrl ?? asset.url} alt={asset.originalName} loading="lazy" />
                <span className="kind">{asset.kind}</span>
                <span
                  className="rm"
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(
                        'Excluir esta imagem? Tokens, tiles e fichas que a usam ficarao sem imagem.',
                      )
                    ) {
                      void act('asset:delete', { assetId: asset.id });
                    }
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}

        <span className="hint">{formatBytes(totalBytes)} em imagens nesta mesa.</span>
      </Section>
    </>
  );
}
