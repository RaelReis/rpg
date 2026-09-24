import {
  FIXABLE_SCREEN_EFFECTS,
  MAX_SCREEN_MESSAGE_LENGTH,
  MAX_TRIGGER_ACTIONS,
  type Scene,
  type ScreenEffectKind,
  type ScreenMessageStyle,
  type Trigger,
  type TriggerAction,
  type TriggerActionType,
  type TriggerAudience,
} from '@rpg/shared';

import { deleteTriggerWithUndo } from '../canvas/Stage';
import { act } from '../net/socket';
import { activeScene, useStore, type UndoEntry } from '../state/store';
import { ColorField, Empty, Section, SelectField, TextField, Toggle } from './common';

/**
 * Editor de gatilho: onde o mestre diz quem dispara e o que acontece.
 *
 * As acoes rodam em sequencia, na ordem da lista — avisar o mestre, apagar a
 * luz, mostrar a mensagem. Criar, editar e apagar entram no desfazer; o
 * disparo, nao: ele aconteceu na tela dos jogadores, e Ctrl+Z nao tira de la.
 */

const ACTION_LABELS: Record<TriggerActionType, string> = {
  'notify-gm': 'Avisar o mestre',
  message: 'Mensagem na tela',
  'screen-effect': 'Efeito de tela',
  card: 'Apresentar cartela',
  handout: 'Material',
  'reveal-token': 'Revelar token oculto',
};

const AUDIENCE: { value: TriggerAudience; label: string }[] = [
  { value: 'triggerer', label: 'Quem disparou' },
  { value: 'all', label: 'Todos os jogadores' },
];

const EFFECT_KINDS: { value: ScreenEffectKind; label: string }[] = [
  { value: 'shake', label: 'Tremor' },
  { value: 'flash', label: 'Flash' },
  { value: 'vignette', label: 'Vinheta' },
  { value: 'blur', label: 'Desfoque' },
  { value: 'blackout', label: 'Apagao' },
];

function defaultAction(type: TriggerActionType): TriggerAction {
  switch (type) {
    case 'notify-gm':
      return { type };
    case 'message':
      return { type, to: 'triggerer', text: '', style: 'whisper', durationMs: 6000 };
    case 'screen-effect':
      return { type, to: 'triggerer', kind: 'shake', params: { durationMs: 800, intensity: 0.6 } };
    case 'card':
      return { type, to: 'all', cardId: null, durationMs: null };
    case 'handout':
      return { type, to: 'triggerer', handoutId: null, share: true, present: true };
    case 'reveal-token':
      return { type, tokenId: null };
  }
}

// ---------------------------------------------------------------------------
// Edicao com desfazer
// ---------------------------------------------------------------------------

/**
 * Ultima edicao registrada, para juntar digitacao seguida num passo so.
 *
 * Sem isso, renomear um gatilho viraria uma entrada de desfazer por tecla.
 */
let lastEdit: { triggerId: string; key: string; at: number; entry: UndoEntry; after: { patch: Partial<Trigger> } } | null =
  null;
const COALESCE_MS = 1500;

function editTrigger(sceneId: string, trigger: Trigger, patch: Partial<Trigger>): void {
  const state = useStore.getState();
  const send = (p: Partial<Trigger>) => void act('trigger:update', { sceneId, triggerId: trigger.id, patch: p });
  send(patch);

  const key = Object.keys(patch).sort().join(',');
  const now = Date.now();
  const top = state.undoStack[state.undoStack.length - 1];
  if (lastEdit && lastEdit.triggerId === trigger.id && lastEdit.key === key && now - lastEdit.at < COALESCE_MS && top === lastEdit.entry) {
    lastEdit.after.patch = patch;
    lastEdit.at = now;
    return;
  }

  const before = Object.fromEntries(
    Object.keys(patch).map((k) => [k, structuredClone(trigger[k as keyof Trigger])]),
  ) as Partial<Trigger>;
  const after = { patch };
  const entry: UndoEntry = {
    label: `editar gatilho ${trigger.name}`,
    undo: () => send(before),
    redo: () => send(after.patch),
  };
  state.pushUndo(entry);
  lastEdit = { triggerId: trigger.id, key, at: now, entry, after };
}

// ---------------------------------------------------------------------------
// Editor flutuante
// ---------------------------------------------------------------------------

export function TriggerEditor(): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const selectedId = useStore((s) => s.selectedTriggerId);
  const select = useStore((s) => s.selectTrigger);
  void rev;

  const scene = activeScene(useStore.getState());
  const trigger = scene?.triggers?.find((t) => t.id === selectedId);
  if (!scene || !trigger) return null;

  const edit = (patch: Partial<Trigger>) => editTrigger(scene.id, trigger, patch);
  const setActions = (actions: TriggerAction[]) => edit({ actions });
  const fired = trigger.mode === 'once' && !trigger.armed;

  return (
    <div className="rail-pop right trigger-editor" role="dialog" aria-label="Gatilho">
      <header>
        <strong>⚑ Gatilho</strong>
        <button className="btn ghost sm" onClick={() => select(null)} aria-label="Fechar">
          ✕
        </button>
      </header>

      <TextField label="Nome" value={trigger.name} maxLength={60} onChange={(v) => edit({ name: v })} />

      <div className="grid-2">
        <SelectField
          label="Modo"
          value={trigger.mode}
          options={[
            { value: 'once', label: 'Uma vez' },
            { value: 'always', label: 'Toda vez' },
          ]}
          onChange={(v) => edit({ mode: v })}
        />
        <SelectField
          label="Quem dispara"
          value={trigger.who}
          options={[
            { value: 'players', label: 'Tokens de jogadores' },
            { value: 'any', label: 'Qualquer token' },
            { value: 'tokens', label: 'Tokens escolhidos' },
          ]}
          onChange={(v) => edit({ who: v })}
        />
      </div>

      {fired && (
        <div className="row trigger-fired">
          <span className="tag">disparado</span>
          <span className="hint" style={{ flex: 1 }}>
            Desarmou depois do primeiro disparo.
          </span>
          <button className="btn sm" onClick={() => void act('trigger:rearm', { sceneId: scene.id, triggerId: trigger.id })}>
            Rearmar
          </button>
        </div>
      )}

      {trigger.who === 'tokens' && (
        <div className="row wrap">
          {scene.tokens.length === 0 && <span className="hint">Nenhum token na cena.</span>}
          {scene.tokens.map((token) => {
            const on = trigger.tokenIds.includes(token.id);
            return (
              <label key={token.id} className={`chip-check${on ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    edit({ tokenIds: on ? trigger.tokenIds.filter((id) => id !== token.id) : [...trigger.tokenIds, token.id] })
                  }
                />
                {token.name}
              </label>
            );
          })}
        </div>
      )}

      <Toggle label="Ligado" checked={trigger.enabled} onChange={(v) => edit({ enabled: v })} />
      <Toggle
        label="Meus movimentos tambem disparam"
        hint="Desligado, voce posiciona NPCs dentro da area sem disparar nada."
        checked={trigger.includeGmMoves}
        onChange={(v) => edit({ includeGmMoves: v })}
      />

      <div className="divider" />
      <span className="label">Acoes, em ordem</span>

      {trigger.actions.length === 0 && <span className="hint">Sem acoes: o disparo so entra no registro.</span>}
      {trigger.actions.map((action, index) => (
        <ActionRow
          key={index}
          scene={scene}
          action={action}
          first={index === 0}
          last={index === trigger.actions.length - 1}
          onChange={(next) => setActions(trigger.actions.map((a, i) => (i === index ? next : a)))}
          onMove={(delta) => {
            const list = [...trigger.actions];
            const [moved] = list.splice(index, 1);
            list.splice(index + delta, 0, moved);
            setActions(list);
          }}
          onRemove={() => setActions(trigger.actions.filter((_, i) => i !== index))}
        />
      ))}

      {trigger.actions.length < MAX_TRIGGER_ACTIONS && (
        <SelectField
          label="Adicionar acao"
          value={'' as TriggerActionType | ''}
          options={[
            { value: '', label: 'Escolha...' },
            ...(Object.keys(ACTION_LABELS) as TriggerActionType[]).map((t) => ({ value: t, label: ACTION_LABELS[t] })),
          ]}
          onChange={(v) => v && setActions([...trigger.actions, defaultAction(v)])}
        />
      )}

      <div className="divider" />
      <button
        className="btn ghost sm danger"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => void deleteTriggerWithUndo(scene, trigger)}
      >
        Excluir gatilho
      </button>
    </div>
  );
}

function ActionRow({
  scene,
  action,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  scene: Scene;
  action: TriggerAction;
  first: boolean;
  last: boolean;
  onChange: (next: TriggerAction) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}): JSX.Element {
  const table = useStore((s) => s.table);

  return (
    <div className="trigger-action">
      <div className="row">
        <strong style={{ flex: 1 }}>{ACTION_LABELS[action.type]}</strong>
        <button className="btn ghost sm" disabled={first} onClick={() => onMove(-1)} title="Subir">
          ↑
        </button>
        <button className="btn ghost sm" disabled={last} onClick={() => onMove(1)} title="Descer">
          ↓
        </button>
        <button className="btn ghost sm" onClick={onRemove} title="Remover acao">
          ✕
        </button>
      </div>

      {'to' in action && (
        <SelectField label="Para" value={action.to} options={AUDIENCE} onChange={(to) => onChange({ ...action, to })} />
      )}

      {action.type === 'message' && (
        <>
          <label className="field">
            <span className="label">Texto</span>
            <textarea
              className="input"
              rows={2}
              maxLength={MAX_SCREEN_MESSAGE_LENGTH}
              value={action.text}
              placeholder="Voce ouve passos atras de voce."
              onChange={(e) => onChange({ ...action, text: e.target.value })}
            />
          </label>
          <div className="grid-2">
            <SelectField
              label="Estilo"
              value={action.style}
              options={[
                { value: 'neutral', label: 'Neutro' },
                { value: 'whisper', label: 'Sussurro' },
                { value: 'threat', label: 'Ameaca' },
              ]}
              onChange={(style: ScreenMessageStyle) => onChange({ ...action, style })}
            />
            <SelectField
              label="Duracao"
              value={action.durationMs === null ? 'close' : String(action.durationMs)}
              options={[
                { value: '4000', label: '4 s' },
                { value: '6000', label: '6 s' },
                { value: '10000', label: '10 s' },
                { value: 'close', label: 'Ate fechar' },
              ]}
              onChange={(v) => onChange({ ...action, durationMs: v === 'close' ? null : Number(v) })}
            />
          </div>
        </>
      )}

      {action.type === 'screen-effect' && (
        <>
          <div className="grid-2">
            <SelectField
              label="Efeito"
              value={action.kind}
              options={EFFECT_KINDS}
              onChange={(kind) => onChange({ ...action, kind, params: { ...action.params, durationMs: kind === 'flash' ? 350 : 2000 } })}
            />
            <SelectField
              label="Duracao"
              value={action.params.durationMs === null ? 'fixed' : String(action.params.durationMs ?? 800)}
              options={[
                ...(action.kind === 'flash'
                  ? [
                      { value: '200', label: 'Curto' },
                      { value: '350', label: 'Medio' },
                      { value: '900', label: 'Longo' },
                    ]
                  : [
                      { value: '800', label: '0,8 s' },
                      { value: '2000', label: '2 s' },
                      { value: '5000', label: '5 s' },
                      { value: '10000', label: '10 s' },
                    ]),
                ...(FIXABLE_SCREEN_EFFECTS.includes(action.kind) ? [{ value: 'fixed', label: 'Fixo' }] : []),
              ]}
              onChange={(v) => onChange({ ...action, params: { ...action.params, durationMs: v === 'fixed' ? null : Number(v) } })}
            />
          </div>
          {(action.kind === 'flash' || action.kind === 'vignette') && (
            <ColorField
              label="Cor"
              value={action.params.color ?? (action.kind === 'flash' ? '#ffffff' : '#000000')}
              onChange={(color) => onChange({ ...action, params: { ...action.params, color } })}
            />
          )}
          {(action.kind === 'shake' || action.kind === 'vignette' || action.kind === 'blur') && (
            <label className="field">
              <span className="label">Intensidade</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={action.params.intensity ?? 0.6}
                onChange={(e) => onChange({ ...action, params: { ...action.params, intensity: Number(e.target.value) } })}
              />
            </label>
          )}
        </>
      )}

      {action.type === 'card' && (
        <SelectField
          label="Cartela (com a duracao dela)"
          value={action.cardId ?? ''}
          options={[
            { value: '', label: 'Escolha...' },
            ...(table?.sceneCards ?? []).map((c) => ({ value: c.id, label: c.title })),
          ]}
          onChange={(v) => onChange({ ...action, cardId: v || null })}
        />
      )}

      {action.type === 'handout' && (
        <>
          <SelectField
            label="Material"
            value={action.handoutId ?? ''}
            options={[
              { value: '', label: 'Escolha...' },
              ...(table?.handouts ?? []).map((h) => ({ value: h.id, label: h.title })),
            ]}
            onChange={(v) => onChange({ ...action, handoutId: v || null })}
          />
          <div className="row wrap">
            <Toggle label="Compartilhar" checked={action.share} onChange={(share) => onChange({ ...action, share })} />
            <Toggle label="Apresentar" checked={action.present} onChange={(present) => onChange({ ...action, present })} />
          </div>
        </>
      )}

      {action.type === 'reveal-token' && (
        <SelectField
          label="Token"
          value={action.tokenId ?? ''}
          options={[
            { value: '', label: 'Escolha...' },
            ...scene.tokens.map((t) => ({
              value: t.id,
              label: `${t.name}${t.gmOnly || t.visibility === 'hidden' ? ' (oculto)' : ''}`,
            })),
          ]}
          onChange={(v) => onChange({ ...action, tokenId: v || null })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lista e registro, na aba Cena
// ---------------------------------------------------------------------------

export function TriggersSection(): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const selectedId = useStore((s) => s.selectedTriggerId);
  const select = useStore((s) => s.selectTrigger);
  const setTool = useStore((s) => s.setTool);
  const table = useStore((s) => s.table);
  void rev;

  const scene = activeScene(useStore.getState());
  if (!scene) return null;
  const triggers = scene.triggers ?? [];
  const log = scene.triggerLog ?? [];
  const nameOf = (id: string | null) => table?.players.find((p) => p.id === id)?.name;

  return (
    <Section
      title={`Gatilhos (${triggers.length})`}
      actions={
        <button className="btn sm" onClick={() => setTool('trigger')} title="Desenhe a area no mapa">
          + Desenhar
        </button>
      }
    >
      {triggers.length === 0 ? (
        <Empty>
          Areas invisiveis que disparam acoes quando um token entra: uma mensagem, um apagao, uma
          cartela. Os jogadores nunca recebem os gatilhos.
        </Empty>
      ) : (
        <div className="list">
          {triggers.map((t) => {
            const fired = t.mode === 'once' && !t.armed;
            return (
              <button
                key={t.id}
                className={`item${t.id === selectedId ? ' active' : ''}`}
                onClick={() => select(t.id === selectedId ? null : t.id)}
              >
                <span className="name">
                  ⚑ {t.name}
                  <span className="sub">
                    {' '}
                    · {t.mode === 'once' ? 'uma vez' : 'toda vez'} · {t.actions.length} acao(oes)
                  </span>
                </span>
                {!t.enabled && <span className="tag">desligado</span>}
                {fired && <span className="tag">disparado</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="row">
        <span className="label" style={{ flex: 1 }}>
          Registro de disparos
        </span>
        {log.length > 0 && (
          <button className="btn ghost sm" onClick={() => void act('trigger:clear-log', { sceneId: scene.id })}>
            Limpar
          </button>
        )}
      </div>
      {log.length === 0 ? (
        <span className="hint">Nenhum disparo nesta cena ainda.</span>
      ) : (
        <div className="list trigger-log">
          {log
            .slice()
            .reverse()
            .map((f) => (
              <div key={f.id} className="item">
                <span className="mono sub">
                  {new Date(f.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="name">
                  {f.triggerName}
                  <span className="sub">
                    {' '}
                    · {f.tokenName}
                    {nameOf(f.playerId) ? ` (${nameOf(f.playerId)})` : ''}
                  </span>
                </span>
              </div>
            ))}
        </div>
      )}
    </Section>
  );
}
