import { useState } from 'react';
import type { SceneCard } from '@rpg/shared';

import { act } from '../../net/socket';
import { findAsset, useStore } from '../../state/store';
import { Dropzone, Empty, Section, SelectField, TextField } from '../common';

/**
 * Cartelas de cena: "Capitulo 3 — O Porao", em tela cheia.
 *
 * O mestre prepara com antecedencia. Nada daqui chega aos jogadores — nem o
 * titulo, nem a imagem — ate a cartela ser apresentada.
 */

const DURATIONS = [
  { value: '4000', label: '4 s' },
  { value: '6000', label: '6 s' },
  { value: '10000', label: '10 s' },
  { value: '20000', label: '20 s' },
  { value: 'close', label: 'Ate eu fechar' },
];

function durationValue(ms: number | null): string {
  if (ms === null) return 'close';
  return DURATIONS.some((d) => d.value === String(ms)) ? String(ms) : '6000';
}

export function CardsSection(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const presentation = useStore((s) => s.presentation);
  const [openId, setOpenId] = useState<string | null>(null);
  void rev;

  const cards = table?.sceneCards ?? [];
  const showing = presentation ? cards.find((c) => c.id === presentation.cardId) : null;

  return (
    <Section
      title={`Cartelas de cena (${cards.length})`}
      actions={
        <button
          className="btn sm"
          onClick={() =>
            void act<SceneCard>('card:create', { title: 'Novo capitulo' }).then((card) => card && setOpenId(card.id))
          }
        >
          + Nova
        </button>
      }
    >
      {presentation && (
        <div className="row card-live">
          <span className="tag on">no ar</span>
          <span className="name" style={{ flex: 1 }}>
            {showing?.title ?? presentation.title}
          </span>
          <button className="btn sm" onClick={() => void act('card:close', {})}>
            Fechar
          </button>
        </div>
      )}

      {cards.length === 0 ? (
        <Empty>
          Prepare a abertura de um capitulo: imagem, titulo e subtitulo em tela cheia. Os jogadores
          so a veem quando voce apresentar.
        </Empty>
      ) : (
        <div className="list">
          {cards.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              open={openId === card.id}
              onToggle={() => setOpenId(openId === card.id ? null : card.id)}
            />
          ))}
        </div>
      )}

      {cards.length > 0 && table && (
        <>
          <div className="divider" />
          <span className="label">Mostrar cartela ao ativar a cena</span>
          {table.scenes
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((scene) => (
              <SelectField
                key={scene.id}
                label={scene.name}
                value={scene.introCardId ?? ''}
                options={[{ value: '', label: 'Nenhuma' }, ...cards.map((c) => ({ value: c.id, label: c.title }))]}
                onChange={(v) => void act('scene:update', { sceneId: scene.id, patch: { introCardId: v || null } })}
              />
            ))}
          <span className="hint">
            Ao ativar a cena, a cartela aparece para todos, pela duracao dela. Continua secreta ate la.
          </span>
        </>
      )}
    </Section>
  );
}

function CardRow({ card, open, onToggle }: { card: SceneCard; open: boolean; onToggle: () => void }): JSX.Element {
  const table = useStore((s) => s.table);
  const players = table?.players.filter((p) => p.role === 'PLAYER') ?? [];
  const [targets, setTargets] = useState<string[] | null>(null);
  const image = findAsset(card.assetId);

  const patch = (p: Partial<SceneCard>): void => {
    void act('card:update', { cardId: card.id, patch: p });
  };

  function present(): void {
    void act('card:present', { cardId: card.id, playerIds: targets, durationMs: card.durationMs });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="item" onClick={onToggle}>
        {image ? (
          <img className="swatch" src={image.thumbUrl ?? image.url} alt="" />
        ) : (
          <span className="swatch" style={{ background: '#0c0e13' }} />
        )}
        <span className="name">
          {card.title}
          {card.subtitle && <span className="sub"> · {card.subtitle}</span>}
        </span>
        <button
          className="btn sm"
          onClick={(e) => {
            e.stopPropagation();
            present();
          }}
          title="Mostrar em tela cheia agora"
        >
          Apresentar
        </button>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 8px 8px' }}>
          <TextField label="Titulo" value={card.title} maxLength={120} onChange={(v) => patch({ title: v })} />
          <TextField
            label="Subtitulo"
            value={card.subtitle}
            maxLength={200}
            placeholder="O Porao"
            onChange={(v) => patch({ subtitle: v })}
          />
          <SelectField
            label="Duracao ao apresentar"
            value={durationValue(card.durationMs)}
            options={DURATIONS}
            onChange={(v) => patch({ durationMs: v === 'close' ? null : Number(v) })}
          />

          <div className="field">
            <span className="label">Apresentar para</span>
            <div className="row wrap">
              <label className={`chip-check${targets === null ? ' on' : ''}`}>
                <input type="checkbox" checked={targets === null} onChange={() => setTargets(targets === null ? [] : null)} />
                Todos
              </label>
              {players.map((p) => {
                const on = targets?.includes(p.id) ?? false;
                return (
                  <label key={p.id} className={`chip-check${on ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setTargets(on ? (targets ?? []).filter((id) => id !== p.id) : [...(targets ?? []), p.id])
                      }
                    />
                    {p.name}
                  </label>
                );
              })}
            </div>
          </div>

          <Dropzone kind="card" label="Imagem de fundo da cartela" onUploaded={(assetId) => patch({ assetId })} />
          {card.assetId && (
            <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => patch({ assetId: null })}>
              Remover imagem
            </button>
          )}

          <div className="row">
            <button
              className="btn primary sm"
              disabled={targets !== null && targets.length === 0}
              onClick={present}
            >
              Apresentar
            </button>
            <div style={{ flex: 1 }} />
            <button
              className="btn ghost sm danger"
              onClick={() => {
                if (window.confirm(`Excluir a cartela "${card.title}"?`)) void act('card:delete', { cardId: card.id });
              }}
            >
              Excluir
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
