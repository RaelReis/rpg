import { useState } from 'react';
import type { Handout } from '@rpg/shared';

import { act } from '../../net/socket';
import { findAsset, isGm, useStore } from '../../state/store';
import { Dropzone, Empty, Section, TextField, Toggle } from '../common';

/**
 * Materiais do grupo.
 *
 * O mestre monta aqui a carta, o retrato, o mapa da regiao — e decide, item a
 * item, quem tem acesso. O jogador ve apenas o que foi compartilhado com ele:
 * um material em preparacao nao aparece nem pelo titulo.
 */
export function HandoutsPanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const openHandout = useStore((s) => s.openHandout);
  const [title, setTitle] = useState('');

  void rev;
  if (!table) return <Empty>Sem mesa carregada.</Empty>;

  const handouts = [...table.handouts].sort((a, b) => b.updatedAt - a.updatedAt);

  if (!gm) {
    return (
      <Section title={`Materiais (${handouts.length})`}>
        {handouts.length === 0 ? (
          <Empty>O mestre ainda nao compartilhou nada com voce.</Empty>
        ) : (
          <div className="list">
            {handouts.map((h) => (
              <button key={h.id} className="item" onClick={() => openHandout(h.id)}>
                {h.assetId && findAsset(h.assetId) ? (
                  <img className="swatch" src={findAsset(h.assetId)?.thumbUrl ?? ''} alt="" />
                ) : (
                  <span className="swatch" style={{ display: 'grid', placeItems: 'center' }}>
                    ✉
                  </span>
                )}
                <span className="name">{h.title}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
    );
  }

  return (
    <>
      <Section
        title="Novo material"
        actions={
          <button
            className="btn sm"
            onClick={() => {
              void act<Handout>('handout:create', { title: title.trim() || 'Novo material' }).then(
                (h) => h && openHandout(h.id),
              );
              setTitle('');
            }}
          >
            + Criar
          </button>
        }
      >
        <TextField
          label="Titulo"
          value={title}
          maxLength={120}
          placeholder="A carta do bispo"
          onChange={setTitle}
        />
        <span className="hint">
          Materiais nascem so seus. Compartilhe quando quiser dar acesso, e apresente quando quiser
          a atencao da mesa.
        </span>
      </Section>

      <Section title={`Materiais (${handouts.length})`}>
        {handouts.length === 0 ? (
          <Empty>Nenhum material ainda.</Empty>
        ) : (
          <div className="list">
            {handouts.map((h) => (
              <HandoutRow key={h.id} handout={h} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function HandoutRow({ handout }: { handout: Handout }): JSX.Element {
  const [open, setOpen] = useState(false);
  const table = useStore((s) => s.table);
  const openHandout = useStore((s) => s.openHandout);

  const players = table?.players.filter((p) => p.role === 'PLAYER') ?? [];
  const patch = (p: Partial<Handout>): void => {
    void act('handout:update', { handoutId: handout.id, patch: p });
  };

  const audience = handout.sharedWithAll
    ? 'todos'
    : handout.sharedWith.length > 0
      ? `${handout.sharedWith.length} jogador(es)`
      : 'so voce';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="item" onClick={() => setOpen((o) => !o)}>
        {handout.assetId && findAsset(handout.assetId) ? (
          <img className="swatch" src={findAsset(handout.assetId)?.thumbUrl ?? ''} alt="" />
        ) : (
          <span className="swatch" style={{ display: 'grid', placeItems: 'center' }}>
            ✉
          </span>
        )}
        <span className="name">
          {handout.title}
          <span className="sub"> · {audience}</span>
        </span>

        <button
          className="btn ghost sm"
          title="Abrir na sua tela"
          onClick={(e) => {
            e.stopPropagation();
            openHandout(handout.id);
          }}
        >
          👁
        </button>
        <button
          className="btn sm"
          title="Abrir na tela de quem tem acesso"
          onClick={(e) => {
            e.stopPropagation();
            void act('handout:present', { handoutId: handout.id });
          }}
        >
          Apresentar
        </button>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '0 8px 10px' }}>
          <TextField
            label="Titulo"
            value={handout.title}
            maxLength={120}
            onChange={(v) => patch({ title: v })}
          />

          <label className="field">
            <span className="label">Texto</span>
            <textarea
              className="textarea"
              defaultValue={handout.text}
              placeholder="O conteudo que o grupo vai ler"
              onBlur={(e) => {
                if (e.target.value !== handout.text) patch({ text: e.target.value });
              }}
            />
          </label>

          <Dropzone
            kind="portrait"
            label="Imagem do material"
            onUploaded={(assetId) => patch({ assetId })}
          />
          {handout.assetId && (
            <button className="btn ghost sm" onClick={() => patch({ assetId: null })}>
              Remover imagem
            </button>
          )}

          <div className="divider" />

          <Toggle
            label="Compartilhar com todos"
            hint="Inclui quem entrar na mesa depois."
            checked={handout.sharedWithAll}
            onChange={(v) => patch({ sharedWithAll: v })}
          />

          {!handout.sharedWithAll && (
            <>
              <span className="label">Compartilhar com</span>
              {players.length === 0 ? (
                <span className="hint">Nenhum jogador na mesa ainda.</span>
              ) : (
                players.map((p) => (
                  <Toggle
                    key={p.id}
                    label={p.name}
                    checked={handout.sharedWith.includes(p.id)}
                    onChange={(on) =>
                      patch({
                        sharedWith: on
                          ? [...handout.sharedWith, p.id]
                          : handout.sharedWith.filter((id) => id !== p.id),
                      })
                    }
                  />
                ))
              )}
            </>
          )}

          <button
            className="btn ghost sm danger"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              if (window.confirm(`Excluir "${handout.title}"?`)) {
                void act('handout:delete', { handoutId: handout.id });
              }
            }}
          >
            Excluir material
          </button>
        </div>
      )}
    </div>
  );
}
