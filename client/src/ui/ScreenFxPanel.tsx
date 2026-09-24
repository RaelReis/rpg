import { useEffect, useState } from 'react';
import {
  FIXABLE_SCREEN_EFFECTS,
  type ScreenEffect,
  type ScreenEffectKind,
  type ScreenEffectParams,
} from '@rpg/shared';

import { act } from '../net/socket';
import { useStore } from '../state/store';
import { ColorField, SelectField } from './common';

/**
 * Painel compacto de efeitos de tela, aberto pelo trilho.
 *
 * O mestre escolhe o efeito, ajusta o minimo e aplica em todos ou em quem
 * escolher. Abaixo fica o que esta no ar, com o "parar todos" sempre a mao.
 */

const KINDS: { id: ScreenEffectKind; icon: string; label: string }[] = [
  { id: 'shake', icon: '〰', label: 'Tremor' },
  { id: 'flash', icon: '✦', label: 'Flash' },
  { id: 'vignette', icon: '◉', label: 'Vinheta' },
  { id: 'blur', icon: '◌', label: 'Desfoque' },
  { id: 'blackout', icon: '●', label: 'Apagao' },
];

const LABEL: Record<ScreenEffectKind, string> = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<
  ScreenEffectKind,
  string
>;

const DURATIONS: Record<ScreenEffectKind, { value: string; label: string }[]> = {
  shake: [
    { value: '400', label: '0,4 s' },
    { value: '800', label: '0,8 s' },
    { value: '1500', label: '1,5 s' },
    { value: '3000', label: '3 s' },
  ],
  flash: [
    { value: '200', label: 'Curto' },
    { value: '450', label: 'Medio' },
    { value: '900', label: 'Longo' },
  ],
  vignette: [],
  blur: [],
  blackout: [],
};

const LONG_DURATIONS = [
  { value: '2000', label: '2 s' },
  { value: '5000', label: '5 s' },
  { value: '10000', label: '10 s' },
  { value: '30000', label: '30 s' },
  { value: 'fixed', label: 'Fixo (ate remover)' },
];

function durationOptions(kind: ScreenEffectKind): { value: string; label: string }[] {
  return FIXABLE_SCREEN_EFFECTS.includes(kind) ? LONG_DURATIONS : DURATIONS[kind];
}

export function ScreenFxPanel(): JSX.Element {
  const table = useStore((s) => s.table);
  const active = useStore((s) => s.screenEffects);
  const close = useStore((s) => s.setScreenFxOpen);

  const players = table?.players.filter((p) => p.role === 'PLAYER') ?? [];
  const [kind, setKind] = useState<ScreenEffectKind>('shake');
  const [intensity, setIntensity] = useState(0.6);
  const [color, setColor] = useState('#ffffff');
  const [duration, setDuration] = useState('800');
  const [fade, setFade] = useState(800);
  const [targets, setTargets] = useState<string[] | null>(null);

  // A lista no ar some sozinha quando os temporizados acabam; o relogio aqui
  // so serve para o painel acompanhar.
  const [, tick] = useState(0);
  useEffect(() => {
    if (active.every((e) => e.durationMs === null)) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [active]);

  function pick(next: ScreenEffectKind): void {
    setKind(next);
    setDuration(durationOptions(next)[1]?.value ?? durationOptions(next)[0].value);
    setColor(next === 'flash' ? '#ffffff' : next === 'vignette' ? '#5a0a0a' : '#000000');
  }

  function apply(): void {
    const params: Partial<ScreenEffectParams> = {
      intensity,
      color,
      durationMs: duration === 'fixed' ? null : Number(duration),
      fadeMs: fade,
    };
    void act<ScreenEffect>('screen:apply', { kind, params, playerIds: targets });
  }

  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? '?';
  const toggle = (id: string) => {
    const current = targets ?? [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setTargets(next);
  };

  const usesIntensity = kind === 'shake' || kind === 'vignette' || kind === 'blur';
  const usesColor = kind === 'flash' || kind === 'vignette';

  return (
    <div className="rail-pop screen-fx-panel" role="dialog" aria-label="Efeitos de tela">
      <header>
        <strong>Efeitos de tela</strong>
        <button className="btn ghost sm" onClick={() => close(false)} aria-label="Fechar">
          ✕
        </button>
      </header>

      <div className="fx-kinds">
        {KINDS.map((k) => (
          <button
            key={k.id}
            className={`btn sm${kind === k.id ? ' primary' : ''}`}
            onClick={() => pick(k.id)}
            title={k.label}
          >
            <span aria-hidden="true">{k.icon}</span> {k.label}
          </button>
        ))}
      </div>

      <div className="grid-2">
        <SelectField label="Duracao" value={duration} options={durationOptions(kind)} onChange={setDuration} />
        {usesColor ? <ColorField label="Cor" value={color} onChange={setColor} /> : <span />}
      </div>

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

      {kind === 'blackout' && (
        <label className="field">
          <span className="label">Fade de entrada e saida ({(fade / 1000).toFixed(1)} s)</span>
          <input type="range" min={0} max={3000} step={100} value={fade} onChange={(e) => setFade(Number(e.target.value))} />
        </label>
      )}

      <div className="field">
        <span className="label">Para</span>
        <div className="row wrap">
          <label className={`chip-check${targets === null ? ' on' : ''}`}>
            <input type="checkbox" checked={targets === null} onChange={() => setTargets(targets === null ? [] : null)} />
            Todos
          </label>
          {players.map((p) => {
            const on = targets?.includes(p.id) ?? false;
            return (
              <label key={p.id} className={`chip-check${on ? ' on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(p.id)} />
                <span className="swatch" style={{ background: p.color, opacity: p.connected ? 1 : 0.35 }} />
                {p.name}
              </label>
            );
          })}
        </div>
      </div>

      <button className="btn primary" disabled={targets !== null && targets.length === 0} onClick={apply}>
        Aplicar {LABEL[kind].toLowerCase()}
      </button>

      <div className="divider" />

      <div className="row">
        <span className="label" style={{ flex: 1 }}>
          No ar ({active.length})
        </span>
        <button
          className="btn sm danger"
          disabled={active.length === 0}
          onClick={() => void act('screen:stop', {})}
          title="Remove todos os efeitos da tela de todos"
        >
          Parar todos
        </button>
      </div>
      {active.length === 0 ? (
        <span className="hint">Nenhum efeito na tela dos jogadores.</span>
      ) : (
        <div className="list">
          {active.map((effect) => {
            const left =
              effect.durationMs === null
                ? 'fixo'
                : `${Math.max(0, Math.ceil((effect.durationMs - (Date.now() - effect.startedAt)) / 1000))} s`;
            const who = effect.playerIds ? effect.playerIds.map(nameOf).join(', ') : 'todos';
            return (
              <div key={effect.id} className="item">
                <span className="name">
                  {LABEL[effect.kind]}
                  <span className="sub">
                    {' '}
                    · {who} · {left}
                  </span>
                </span>
                <button
                  className="btn ghost sm"
                  onClick={() => void act('screen:stop', { effectId: effect.id })}
                  title="Remover este efeito"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      <span className="hint">
        Quem ligou "Reduzir efeitos de tela" ve o flash como uma vinheta suave e nao sente o tremor.
      </span>
    </div>
  );
}
