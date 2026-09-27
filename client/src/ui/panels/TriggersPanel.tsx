import { useEffect, useState } from 'react';
import {
  MAX_TRIGGER_ACTIONS,
  type ScreenEffectKind,
  type ScreenMessageStyle,
  type Trigger,
  type TriggerAction,
  type TriggerLogEntry,
  type TriggerTarget,
} from '@rpg/shared';

import { activeScene, useStore } from '../../state/store';
import { deleteTriggerWithUndo, updateTriggerWithUndo } from '../../state/triggerOps';
import { ColorField, Empty, SelectField, Section, Toggle } from '../common';
import { Icon } from '../icons';

/**
 * Gatilhos da cena: lista, edicao e registro de disparos.
 *
 * Toda edicao passa pelo desfazer do mestre. Campos de texto gravam ao sair
 * do campo, e nao a cada tecla: senao o Ctrl+Z desfaria uma letra por vez.
 */

const NO_LOG: TriggerLogEntry[] = [];

const ACTION_LABELS: Record<TriggerAction['type'], string> = {
  notify: 'Avisar o mestre',
  message: 'Mensagem na tela',
  screen: 'Efeito de tela',
  card: 'Apresentar cartela',
  handout: 'Compartilhar/apresentar material',
  reveal: 'Revelar token oculto',
};

const EFFECT_OPTIONS: { value: ScreenEffectKind; label: string }[] = [
  { value: 'shake', label: 'Tremor' },
  { value: 'flash', label: 'Flash' },
  { value: 'vignette', label: 'Vinheta' },
  { value: 'blur', label: 'Desfoque' },
  { value: 'blackout', label: 'Apagao' },
];

const TARGET_OPTIONS: { value: TriggerTarget; label: string }[] = [
  { value: 'trigger', label: 'Quem disparou' },
  { value: 'all', label: 'Todos os jogadores' },
];

let actionSeq = 0;
function newActionId(): string {
  actionSeq += 1;
  return `a${Date.now().toString(36)}${actionSeq}`;
}

function newAction(type: TriggerAction['type']): TriggerAction {
  const id = newActionId();
  switch (type) {
    case 'notify':
      return { id, type };
    case 'message':
      return { id, type, target: 'trigger', text: '', style: 'whisper', durationMs: 6000 };
    case 'screen':
      return {
        id,
        type,
        target: 'trigger',
        effect: { kind: 'shake', color: '#000000', intensity: 0.6, durationMs: 1000 },
      };
    case 'card':
      return { id, type, target: 'all', cardId: '', durationMs: 6000 };
    case 'handout':
      return { id, type, handoutId: '', share: 'trigger', present: true };
    case 'reveal':
      return { id, type, tokenId: '' };
  }
}

export function TriggersPanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const selectedId = useStore((s) => s.selectedTriggerId);
  const selectTrigger = useStore((s) => s.selectTrigger);
  const setTool = useStore((s) => s.setTool);
  const log = useStore((s) => s.table?.triggerLog ?? NO_LOG);

  void rev;
  const scene = activeScene(useStore.getState());
  if (!scene) return <Empty>Ative uma cena para trabalhar com gatilhos.</Empty>;

  const triggers = scene.triggers ?? [];
  const selected = triggers.find((t) => t.id === selectedId) ?? null;

  return (
    <>
      <Section
        title={`Gatilhos da cena (${triggers.length})`}
        actions={
          <button className="btn sm" onClick={() => setTool('trigger')} title="Desenhar uma area no mapa">
            <Icon name="add" size="sm" /> Desenhar
          </button>
        }
      >
        {triggers.length === 0 ? (
          <Empty>
            Use a ferramenta de gatilho do trilho para desenhar uma area. Quando um token de jogador entrar nela, as
            acoes do gatilho acontecem — e ninguem alem de voce sabe que ela esta la.
          </Empty>
        ) : (
          <div className="list">
            {triggers.map((t) => (
              <button
                key={t.id}
                className={`item${t.id === selectedId ? ' active' : ''}`}
                onClick={() => selectTrigger(t.id)}
              >
                <span className="swatch trigger-swatch">
                  <Icon name="trigger" size="sm" />
                </span>
                <span className="name">
                  {t.name}
                  <span className="sub"> · {t.actions.length} acao(oes)</span>
                </span>
                {!t.enabled && <span className="tag">desligado</span>}
                {t.enabled && t.mode === 'once' && !t.armed && <span className="tag">disparado</span>}
                {t.mode === 'always' && <span className="tag">toda vez</span>}
              </button>
            ))}
          </div>
        )}
      </Section>

      {selected && <TriggerEditor key={selected.id} sceneId={scene.id} trigger={selected} />}

      <TriggerLog entries={log} />
    </>
  );
}

// ---------------------------------------------------------------------------

/** Campo de texto que grava ao sair (ou no Enter), para o desfazer ser por edicao. */
function CommitText({
  label,
  value,
  onCommit,
  placeholder,
  maxLength,
  multiline,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className="field">
      <span className="label">{label}</span>
      {multiline ? (
        <textarea
          className="input"
          rows={2}
          value={draft}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          className="input"
          value={draft}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
    </label>
  );
}

function TriggerEditor({ sceneId, trigger }: { sceneId: string; trigger: Trigger }): JSX.Element {
  const scene = activeScene(useStore.getState());
  const [adding, setAdding] = useState<TriggerAction['type']>('message');
  const update = (patch: Partial<Trigger>, label?: string) => updateTriggerWithUndo(sceneId, trigger, patch, label);
  const setActions = (actions: TriggerAction[], label: string) => update({ actions }, label);

  const tokens = scene?.tokens ?? [];
  const areaLabel =
    trigger.area.kind === 'rect' ? 'retangulo' : trigger.area.kind === 'circle' ? 'circulo' : 'poligono';

  function moveAction(index: number, delta: number): void {
    const next = trigger.actions.slice();
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setActions(next, 'reordenar acoes');
  }

  return (
    <Section
      title="Gatilho selecionado"
      actions={
        <button className="btn ghost sm danger" onClick={() => deleteTriggerWithUndo(sceneId, trigger)}>
          Excluir
        </button>
      }
    >
      <CommitText label="Nome" value={trigger.name} maxLength={80} onCommit={(name) => update({ name }, 'renomear gatilho')} />
      <span className="hint">Area: {areaLabel}. Para mudar a forma, apague e desenhe de novo (Ctrl+Z traz de volta).</span>

      <Toggle
        label="Ligado"
        checked={trigger.enabled}
        onChange={(enabled) => update({ enabled }, enabled ? 'ligar gatilho' : 'desligar gatilho')}
      />

      <div className="grid-2">
        <SelectField
          label="Dispara"
          value={trigger.mode}
          options={[
            { value: 'once', label: 'Uma vez' },
            { value: 'always', label: 'Toda vez' },
          ]}
          onChange={(mode) => update({ mode, armed: true }, 'mudar modo do gatilho')}
        />
        <SelectField
          label="Quem dispara"
          value={trigger.who}
          options={[
            { value: 'players', label: 'Tokens de jogadores' },
            { value: 'any', label: 'Qualquer token' },
            { value: 'tokens', label: 'Tokens escolhidos' },
          ]}
          onChange={(who) => update({ who }, 'mudar quem dispara')}
        />
      </div>

      {trigger.mode === 'once' && (
        <div className="row">
          <span className="hint" style={{ flex: 1 }}>
            {trigger.armed ? 'Armado: dispara na proxima entrada e desarma.' : 'Ja disparou e esta desarmado.'}
          </span>
          {!trigger.armed && (
            <button className="btn sm" onClick={() => update({ armed: true }, 'rearmar gatilho')}>
              Rearmar
            </button>
          )}
        </div>
      )}

      {trigger.who === 'tokens' && (
        <div className="row wrap">
          {tokens.length === 0 && <span className="hint">Nenhum token na cena.</span>}
          {tokens.map((t) => {
            const on = trigger.tokenIds.includes(t.id);
            return (
              <label key={t.id} className="check" style={{ width: 'auto' }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    update(
                      { tokenIds: on ? trigger.tokenIds.filter((id) => id !== t.id) : [...trigger.tokenIds, t.id] },
                      'escolher tokens do gatilho',
                    )
                  }
                />
                <span>{t.name}</span>
              </label>
            );
          })}
        </div>
      )}

      <Toggle
        label="Movimentos do mestre tambem disparam"
        hint="Desligado, voce posiciona NPCs a vontade sem cair na propria armadilha."
        checked={trigger.gmMoves}
        onChange={(gmMoves) => update({ gmMoves }, 'mudar gatilho')}
      />

      <div className="divider" />
      <span className="label">Acoes, em ordem</span>
      {trigger.actions.length === 0 && <span className="hint">Nenhuma acao: o disparo so entra no registro.</span>}
      {trigger.actions.map((action, index) => (
        <div key={action.id} className="trigger-action">
          <div className="row">
            <span className="trigger-action-n mono">{index + 1}</span>
            <strong style={{ flex: 1 }}>{ACTION_LABELS[action.type]}</strong>
            <button
              className="btn ghost sm"
              disabled={index === 0}
              onClick={() => moveAction(index, -1)}
              title="Subir"
              aria-label="Subir"
            >
              <Icon name="moveUp" size="sm" />
            </button>
            <button
              className="btn ghost sm"
              disabled={index === trigger.actions.length - 1}
              onClick={() => moveAction(index, 1)}
              title="Descer"
              aria-label="Descer"
            >
              <Icon name="moveDown" size="sm" />
            </button>
            <button
              className="btn ghost sm danger"
              title="Remover acao"
              aria-label="Remover acao"
              onClick={() => setActions(trigger.actions.filter((a) => a.id !== action.id), 'remover acao')}
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
          <ActionFields
            action={action}
            onChange={(next) =>
              setActions(
                trigger.actions.map((a) => (a.id === action.id ? next : a)),
                `editar acao "${ACTION_LABELS[action.type]}"`,
              )
            }
          />
        </div>
      ))}

      {trigger.actions.length < MAX_TRIGGER_ACTIONS && (
        <div className="row">
          <select
            className="input select"
            value={adding}
            onChange={(e) => setAdding(e.target.value as TriggerAction['type'])}
            style={{ flex: 1 }}
          >
            {(Object.keys(ACTION_LABELS) as TriggerAction['type'][]).map((type) => (
              <option key={type} value={type}>
                {ACTION_LABELS[type]}
              </option>
            ))}
          </select>
          <button
            className="btn sm"
            onClick={() => setActions([...trigger.actions, newAction(adding)], `adicionar acao "${ACTION_LABELS[adding]}"`)}
          >
            <Icon name="add" size="sm" /> Acao
          </button>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

function ActionFields({
  action,
  onChange,
}: {
  action: TriggerAction;
  onChange: (next: TriggerAction) => void;
}): JSX.Element | null {
  const table = useStore((s) => s.table);
  const scene = activeScene(useStore.getState());

  switch (action.type) {
    case 'notify':
      return <span className="hint">Aviso na sua tela com o nome do gatilho e quem entrou.</span>;

    case 'message':
      return (
        <>
          <CommitText
            label="Texto"
            multiline
            maxLength={400}
            value={action.text}
            placeholder="O chao range sob seus pes."
            onCommit={(text) => onChange({ ...action, text })}
          />
          <div className="grid-2">
            <SelectField
              label="Para"
              value={action.target}
              options={TARGET_OPTIONS}
              onChange={(target) => onChange({ ...action, target })}
            />
            <SelectField
              label="Tom"
              value={action.style}
              options={[
                { value: 'neutral', label: 'Neutro' },
                { value: 'whisper', label: 'Sussurro' },
                { value: 'threat', label: 'Ameaca' },
              ]}
              onChange={(style) => onChange({ ...action, style: style as ScreenMessageStyle })}
            />
          </div>
          <SelectField
            label="Na tela por"
            value={action.durationMs === null ? 'close' : String(action.durationMs)}
            options={[
              { value: '3000', label: '3 segundos' },
              { value: '6000', label: '6 segundos' },
              { value: '10000', label: '10 segundos' },
              { value: 'close', label: 'Ate o jogador fechar' },
            ]}
            onChange={(v) => onChange({ ...action, durationMs: v === 'close' ? null : Number(v) })}
          />
        </>
      );

    case 'screen': {
      const effect = action.effect;
      const fixable = effect.kind === 'vignette' || effect.kind === 'blur' || effect.kind === 'blackout';
      return (
        <>
          <div className="grid-2">
            <SelectField
              label="Efeito"
              value={effect.kind}
              options={EFFECT_OPTIONS}
              onChange={(kind) =>
                onChange({
                  ...action,
                  effect: {
                    ...effect,
                    kind,
                    color: kind === 'flash' ? '#ffffff' : effect.color,
                    durationMs: effect.durationMs ?? 3000,
                  },
                })
              }
            />
            <SelectField
              label="Para"
              value={action.target}
              options={TARGET_OPTIONS}
              onChange={(target) => onChange({ ...action, target })}
            />
          </div>
          {(effect.kind === 'flash' || effect.kind === 'vignette') && (
            <ColorField
              label="Cor"
              value={effect.color}
              onChange={(color) => onChange({ ...action, effect: { ...effect, color } })}
            />
          )}
          {effect.kind !== 'blackout' && (
            <label className="field">
              <span className="label">Intensidade</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={effect.intensity}
                onChange={(e) => onChange({ ...action, effect: { ...effect, intensity: Number(e.target.value) } })}
              />
            </label>
          )}
          <SelectField
            label="Duracao"
            value={effect.durationMs === null ? 'fixed' : String(effect.durationMs)}
            options={[
              { value: '600', label: '0,6 segundo' },
              { value: '1000', label: '1 segundo' },
              { value: '3000', label: '3 segundos' },
              { value: '8000', label: '8 segundos' },
              ...(fixable ? [{ value: 'fixed', label: 'Fixo (ate voce parar)' }] : []),
            ]}
            onChange={(v) =>
              onChange({ ...action, effect: { ...effect, durationMs: v === 'fixed' ? null : Number(v) } })
            }
          />
        </>
      );
    }

    case 'card':
      return (
        <>
          <SelectField
            label="Cartela"
            value={action.cardId}
            options={[
              { value: '', label: 'Escolha...' },
              ...(table?.sceneCards.map((c) => ({ value: c.id, label: c.title })) ?? []),
            ]}
            onChange={(cardId) => onChange({ ...action, cardId })}
          />
          <div className="grid-2">
            <SelectField
              label="Para"
              value={action.target}
              options={TARGET_OPTIONS}
              onChange={(target) => onChange({ ...action, target })}
            />
            <SelectField
              label="Na tela por"
              value={action.durationMs === null ? 'close' : String(action.durationMs)}
              options={[
                { value: '6000', label: '6 segundos' },
                { value: '10000', label: '10 segundos' },
                { value: 'close', label: 'Ate voce fechar' },
              ]}
              onChange={(v) => onChange({ ...action, durationMs: v === 'close' ? null : Number(v) })}
            />
          </div>
        </>
      );

    case 'handout':
      return (
        <>
          <SelectField
            label="Material"
            value={action.handoutId}
            options={[
              { value: '', label: 'Escolha...' },
              ...(table?.handouts.map((h) => ({ value: h.id, label: h.title })) ?? []),
            ]}
            onChange={(handoutId) => onChange({ ...action, handoutId })}
          />
          <SelectField
            label="Compartilhar com"
            value={action.share}
            options={[
              { value: 'none', label: 'Nao mudar o acesso' },
              { value: 'trigger', label: 'Quem disparou' },
              { value: 'all', label: 'Todos' },
            ]}
            onChange={(share) => onChange({ ...action, share })}
          />
          <Toggle
            label="Apresentar (abrir na tela)"
            checked={action.present}
            onChange={(present) => onChange({ ...action, present })}
          />
        </>
      );

    case 'reveal': {
      // Os ocultos primeiro: e quase sempre um deles que a pessoa procura.
      const tokens = (scene?.tokens ?? [])
        .slice()
        .sort((a, b) => Number(b.visibility === 'hidden' || b.gmOnly) - Number(a.visibility === 'hidden' || a.gmOnly));
      return (
        <SelectField
          label="Token"
          value={action.tokenId}
          options={[
            { value: '', label: 'Escolha...' },
            ...tokens.map((t) => ({
              value: t.id,
              label: `${t.name}${t.visibility === 'hidden' || t.gmOnly ? ' (oculto)' : ''}`,
            })),
          ]}
          onChange={(tokenId) => onChange({ ...action, tokenId })}
        />
      );
    }
  }
}

// ---------------------------------------------------------------------------

function TriggerLog({ entries }: { entries: TriggerLogEntry[] }): JSX.Element {
  const recent = entries.slice(-30).reverse();
  return (
    <Section title="Registro de disparos">
      {recent.length === 0 ? (
        <Empty>Nenhum disparo ainda. So voce ve este registro.</Empty>
      ) : (
        <div className="list">
          {recent.map((entry) => (
            <div key={entry.id} className="item">
              <span className="mono sub">
                {new Date(entry.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="name">
                <Icon name="trigger" size="sm" /> {entry.triggerName}
                <span className="sub">
                  {' '}
                  · {entry.tokenName}
                  {entry.playerName ? ` (${entry.playerName})` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
