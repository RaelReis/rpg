import { useState } from 'react';
import type { ActiveScreenEffect, SceneCard, ScreenEffect, ScreenEffectKind } from '@rpg/shared';

import { act } from '../net/socket';
import { findAsset, useStore } from '../state/store';
import { ColorField, Dropzone, Empty, Modal, SelectField, TextField, Toggle } from './common';
import { Icon, type IconName } from './icons';

/**
 * Paineis de imersao do mestre: efeitos de tela e cartelas de cena.
 *
 * O que sai daqui vai para a tela dos jogadores, e so dos escolhidos. A
 * decisao final (quem recebe, e a versao reduzida para quem pediu) e do
 * servidor.
 */

/**
 * Lista vazia estavel para os seletores: `?? []` criaria um array novo a cada
 * leitura, e o zustand entenderia isso como mudanca a cada render.
 */
const NO_EFFECTS: ActiveScreenEffect[] = [];
const NO_CARDS: SceneCard[] = [];

// ---------------------------------------------------------------------------
// Destinatarios
// ---------------------------------------------------------------------------

/** "Todos" ou uma lista de jogadores. `null` = todos. */
function RecipientsPicker({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}): JSX.Element {
  const allPlayers = useStore((s) => s.table?.players);
  const players = (allPlayers ?? []).filter((p) => p.role === 'PLAYER');

  return (
    <div className="field">
      <SelectField
        label="Para"
        value={value === null ? 'all' : 'some'}
        options={[
          { value: 'all', label: 'Todos os jogadores' },
          { value: 'some', label: 'Jogadores escolhidos' },
        ]}
        onChange={(v) => onChange(v === 'all' ? null : [])}
      />
      {value !== null && (
        <div className="row wrap">
          {players.length === 0 && <span className="hint">Nenhum jogador na mesa ainda.</span>}
          {players.map((p) => {
            const on = value.includes(p.id);
            return (
              <label key={p.id} className="check" style={{ width: 'auto' }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onChange(on ? value.filter((id) => id !== p.id) : [...value, p.id])}
                />
                <span>
                  {p.name}
                  {!p.connected && <small> offline</small>}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function useRecipientNames(): (ids: string[] | null) => string {
  const players = useStore((s) => s.table?.players);
  return (ids) =>
    ids === null ? 'todos' : (players ?? []).filter((p) => ids.includes(p.id)).map((p) => p.name).join(', ') || 'ninguem';
}

// ---------------------------------------------------------------------------
// Efeitos de tela
// ---------------------------------------------------------------------------

const EFFECTS: { kind: ScreenEffectKind; icon: IconName; label: string; hint: string }[] = [
  { kind: 'shake', icon: 'shake', label: 'Tremor', hint: 'Sacode o mapa' },
  { kind: 'flash', icon: 'flash', label: 'Flash', hint: 'Um clarao que se apaga' },
  { kind: 'vignette', icon: 'vignette', label: 'Vinheta', hint: 'Escurece as bordas da tela' },
  { kind: 'blur', icon: 'blur', label: 'Desfoque', hint: 'Embaça o mapa' },
  { kind: 'blackout', icon: 'blackout', label: 'Apagao', hint: 'Tela preta, com fade' },
];

const EFFECT_LABEL: Record<ScreenEffectKind, string> = {
  shake: 'Tremor',
  flash: 'Flash',
  vignette: 'Vinheta',
  blur: 'Desfoque',
  blackout: 'Apagao',
};

/** Efeitos que podem ficar ate o mestre remover. */
const FIXABLE: ScreenEffectKind[] = ['vignette', 'blur', 'blackout'];

/** Painel compacto ao lado do trilho. */
export function ScreenEffectsPanel(): JSX.Element {
  const close = useStore((s) => s.setImmersionPanel);
  const active = useStore((s) => s.table?.screenEffects ?? NO_EFFECTS);
  const names = useRecipientNames();

  const [kind, setKind] = useState<ScreenEffectKind>('shake');
  const [color, setColor] = useState('#8a1010');
  const [flashColor, setFlashColor] = useState('#ffffff');
  const [intensity, setIntensity] = useState(0.6);
  const [seconds, setSeconds] = useState(2);
  const [fixed, setFixed] = useState(false);
  const [recipients, setRecipients] = useState<string[] | null>(null);

  const canFix = FIXABLE.includes(kind);
  const usesColor = kind === 'flash' || kind === 'vignette';
  const usesIntensity = kind !== 'blackout';

  function apply(): void {
    const effect: Partial<ScreenEffect> = {
      kind,
      color: kind === 'flash' ? flashColor : color,
      intensity,
      durationMs: canFix && fixed ? null : Math.round(seconds * 1000),
    };
    void act('screen:apply', { effect, recipients });
  }

  return (
    <div className="rail-panel" role="dialog" aria-label="Efeitos de tela">
      <header>
        <h3>Efeitos de tela</h3>
        <button className="btn ghost sm" onClick={() => close(null)} aria-label="Fechar">
          <Icon name="close" size="sm" />
        </button>
      </header>

      <div className="fx-kinds">
        {EFFECTS.map((e) => (
          <button
            key={e.kind}
            className={`btn sm${kind === e.kind ? ' primary' : ''}`}
            title={e.hint}
            onClick={() => setKind(e.kind)}
          >
            <Icon name={e.icon} size="sm" /> {e.label}
          </button>
        ))}
      </div>

      {usesColor && (
        <ColorField
          label="Cor"
          value={kind === 'flash' ? flashColor : color}
          onChange={kind === 'flash' ? setFlashColor : setColor}
        />
      )}

      {usesIntensity && (
        <label className="field">
          <span className="label">Intensidade</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
          />
        </label>
      )}

      {canFix && (
        <Toggle
          label="Fixo"
          hint="Fica ate voce remover, inclusive para quem reconectar."
          checked={fixed}
          onChange={setFixed}
        />
      )}
      {!(canFix && fixed) && (
        <label className="field">
          <span className="label">Duracao (segundos)</span>
          <input
            className="input mono"
            type="number"
            min={0.3}
            max={600}
            step={0.5}
            value={seconds}
            onChange={(e) => setSeconds(Math.max(0.3, Number(e.target.value) || 0))}
          />
        </label>
      )}

      <RecipientsPicker value={recipients} onChange={setRecipients} />

      <button
        className="btn primary"
        disabled={recipients !== null && recipients.length === 0}
        onClick={apply}
      >
        Aplicar {EFFECT_LABEL[kind].toLowerCase()}
      </button>

      {active.length > 0 && (
        <>
          <div className="divider" />
          <span className="label">Fixos ativos</span>
          <div className="list">
            {active.map((e: ActiveScreenEffect) => (
              <div key={e.id} className="item">
                <span className="swatch" style={{ background: e.kind === 'blackout' ? '#000' : e.color }} />
                <span className="name">
                  {EFFECT_LABEL[e.kind]}
                  <span className="sub"> · {names(e.recipients)}</span>
                </span>
                <button
                  className="btn ghost sm"
                  title="Remover"
                  onClick={() => void act('screen:stop', { effectId: e.id })}
                  aria-label="Remover"
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <button className="btn danger" onClick={() => void act('screen:stop', {})}>
        Parar todos
      </button>
      <span className="hint">
        Quem marcou "reduzir efeitos de tela" nao recebe o tremor, e ve uma vinheta suave no lugar
        do flash. Nenhuma tela recebe mais de 3 flashes por segundo.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartelas de cena
// ---------------------------------------------------------------------------

const CARD_DURATIONS = [
  { value: '6000', label: '6 segundos' },
  { value: '10000', label: '10 segundos' },
  { value: '20000', label: '20 segundos' },
  { value: 'close', label: 'Ate eu fechar' },
];

export function CardsModal(): JSX.Element {
  const close = useStore((s) => s.setImmersionPanel);
  const rev = useStore((s) => s.rev);
  const cards = useStore((s) => s.table?.sceneCards ?? NO_CARDS);
  const presented = useStore((s) => s.table?.presentedCard ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(cards[0]?.id ?? null);
  const [newTitle, setNewTitle] = useState('');

  void rev;
  const selected = cards.find((c) => c.id === selectedId) ?? null;

  async function create(): Promise<void> {
    const card = await act<SceneCard>('card:create', { title: newTitle.trim() || 'Nova cartela' });
    if (card) {
      setSelectedId(card.id);
      setNewTitle('');
    }
  }

  return (
    <Modal title="Cartelas de cena" onClose={() => close(null)} wide>
      <div className="cards-layout">
        <div className="cards-list">
          <div className="row">
            <input
              className="input"
              placeholder="Capitulo 3 — O Porao"
              value={newTitle}
              maxLength={120}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
            />
            <button className="btn sm" onClick={() => void create()}>
              <Icon name="add" size="sm" /> Nova
            </button>
          </div>
          {cards.length === 0 ? (
            <Empty>Prepare aqui as cartelas da sessao. Nenhum jogador ve nada ate voce apresentar.</Empty>
          ) : (
            <div className="list">
              {cards.map((card) => (
                <button
                  key={card.id}
                  className={`item${card.id === selectedId ? ' active' : ''}`}
                  onClick={() => setSelectedId(card.id)}
                >
                  <span className="name">
                    {card.title}
                    {card.subtitle && <span className="sub"> · {card.subtitle}</span>}
                  </span>
                  {presented?.cardId === card.id && <span className="tag on">no ar</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {selected ? <CardEditor key={selected.id} card={selected} /> : <Empty>Escolha ou crie uma cartela.</Empty>}
      </div>
    </Modal>
  );
}

function CardEditor({ card }: { card: SceneCard }): JSX.Element {
  const presented = useStore((s) => s.table?.presentedCard ?? null);
  const [recipients, setRecipients] = useState<string[] | null>(null);
  const [duration, setDuration] = useState('6000');
  const asset = findAsset(card.assetId);

  const patch = (p: Partial<SceneCard>) => void act('card:update', { cardId: card.id, patch: p });
  const live = presented?.cardId === card.id;

  return (
    <div className="card-editor">
      <div className="scene-card preview">
        {asset && <div className="scene-card-bg" style={{ backgroundImage: `url("${asset.url}")` }} />}
        <div className="scene-card-text">
          <h1>{card.title}</h1>
          {card.subtitle && <p>{card.subtitle}</p>}
        </div>
      </div>

      <TextField label="Titulo" value={card.title} maxLength={120} onChange={(v) => patch({ title: v })} />
      <TextField
        label="Subtitulo"
        value={card.subtitle}
        maxLength={200}
        placeholder="O Porao"
        onChange={(v) => patch({ subtitle: v })}
      />

      <span className="label">Imagem de fundo</span>
      <Dropzone kind="card" label="Enviar imagem da cartela" onUploaded={(assetId) => patch({ assetId })} />
      {card.assetId && (
        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => patch({ assetId: null })}>
          Remover imagem
        </button>
      )}

      <div className="divider" />

      <RecipientsPicker value={recipients} onChange={setRecipients} />
      <SelectField label="Na tela por" value={duration} options={CARD_DURATIONS} onChange={setDuration} />

      <div className="row wrap">
        <button
          className="btn primary"
          disabled={recipients !== null && recipients.length === 0}
          onClick={() =>
            void act('card:present', {
              cardId: card.id,
              recipients,
              durationMs: duration === 'close' ? null : Number(duration),
            })
          }
        >
          Apresentar
        </button>
        {live && (
          <button className="btn" onClick={() => void act('card:close', {})}>
            Fechar
          </button>
        )}
        <div className="spacer" />
        <button
          className="btn ghost sm danger"
          onClick={() => {
            if (window.confirm(`Excluir a cartela "${card.title}"?`)) void act('card:delete', { cardId: card.id });
          }}
        >
          Excluir
        </button>
      </div>
      <span className="hint">
        Nada desta cartela chega aos jogadores antes de voce apresentar — nem o titulo. Para abrir
        uma cena com ela, escolha-a na aba Cena, em "Cartela ao ativar".
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preferencias pessoais
// ---------------------------------------------------------------------------

export function PrefsModal(): JSX.Element {
  const setOpen = useStore((s) => s.setPrefsOpen);
  const myId = useStore((s) => s.session?.playerId ?? null);
  const me = useStore((s) => s.table?.players.find((p) => p.id === myId) ?? null);

  return (
    <Modal title="Preferencias" onClose={() => setOpen(false)}>
      <Toggle
        label="Reduzir efeitos de tela"
        hint="O mestre pode sacudir a tela ou dar um clarao. Ligado, voce nao recebe o tremor e ve uma vinheta suave no lugar do flash."
        checked={me?.reduceEffects === true}
        onChange={(v) => void act('player:prefs', { reduceEffects: v })}
      />
    </Modal>
  );
}
