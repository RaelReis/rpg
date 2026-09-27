import { Notices } from './Notices';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AssetKind } from '@rpg/shared';

import { formatBytes, uploadAsset, uploadLimitFor } from '../net/api';
import { useStore } from '../state/store';
import { Icon } from './icons';

/** Pecas reutilizadas pelos paineis. */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  /**
   * Sem `onClose`, a janela nao tem X e ignora Esc e clique fora: so sai
   * pelos botoes do rodape. E para janela que nao pode sumir por engano.
   */
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return (
    <dialog ref={ref} className="modal-shell" aria-labelledby={titleId}
      onCancel={e => { e.preventDefault(); onClose?.(); }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" style={wide ? { width: 'min(980px, 100%)' } : undefined}>
        <header>
          <h2 id={titleId}>{title}</h2>
          {onClose && (
            <button type="button" className="btn ghost sm icon-only" onClick={onClose} aria-label="Fechar">
              <Icon name="close" />
            </button>
          )}
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
      <Notices />
    </dialog>
  );
}

/**
 * Secao dobravel: o titulo vira botao, e o estado fica lembrado por titulo.
 * O painel de cena empilha oito secoes — sem dobrar, toda visita comeca com
 * uma rolagem longa ate a que importa naquele momento.
 */
function readSectionOpen(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) return saved !== '0';
  } catch {
    // Sem storage, vale o padrao.
  }
  return fallback;
}

export function Section({
  title,
  actions,
  children,
  collapsible,
  defaultOpen = true,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}): JSX.Element {
  const storageKey = `rpg-vtt:section:${title}`;
  const [open, setOpen] = useState(() => (collapsible ? readSectionOpen(storageKey, defaultOpen) : true));

  const toggle = (): void => {
    setOpen((was) => {
      const next = !was;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        // Sem storage, a escolha dura so a aba.
      }
      return next;
    });
  };

  return (
    <section className="section">
      <header>
        {collapsible ? (
          <button type="button" className="section-toggle" onClick={toggle} aria-expanded={open}>
            <Icon name={open ? 'expand' : 'collapsed'} size="sm" />
            <h3>{title}</h3>
          </button>
        ) : (
          <h3>{title}</h3>
        )}
        <div className="spacer" />
        {actions}
      </header>
      {open && children}
    </section>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
}): JSX.Element {
  return (
    <label className="field">
      <span className="label">
        {label}
        {suffix ? ` (${suffix})` : ''}
      </span>
      <input
        className="input mono"
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
}): JSX.Element {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <input
        type="color"
        className="input"
        style={{ height: 32, padding: 2, cursor: 'pointer' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <select
        className="input select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

/**
 * Area de upload que aceita clique e arrastar-e-soltar. O limite de tamanho
 * aparece antes do envio: e mais util saber o teto do que receber um erro
 * depois de esperar o upload de um mapa de 30MB.
 */
export function Dropzone({
  kind,
  label,
  onUploaded,
  multiple,
}: {
  kind: AssetKind;
  label?: string;
  onUploaded: (assetId: string) => void;
  multiple?: boolean;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const notify = useStore((s) => s.notify);

  async function send(files: FileList | null): Promise<void> {
    if (busy || !files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files).slice(0, multiple ? 20 : 1)) {
        const asset = await uploadAsset(file, kind);
        onUploaded(asset.id);
      }
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={busy}
        className={`dropzone${over ? ' over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files);
        }}
      >
        {busy ? 'Enviando...' : (label ?? 'Arraste uma imagem ou clique para escolher')}
        <span className="hint" style={{ display: 'block', marginTop: 4 }}>
          PNG, JPEG, WebP, GIF ou AVIF — ate {formatBytes(uploadLimitFor(kind))}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        multiple={multiple}
        hidden
        onChange={(e) => void send(e.target.files)}
      />
    </>
  );
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}
