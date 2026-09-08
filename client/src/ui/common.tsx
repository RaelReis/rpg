import { useRef, useState, type ReactNode } from 'react';
import type { AssetKind } from '@rpg/shared';

import { formatBytes, uploadAsset, uploadLimitFor } from '../net/api';
import { useStore } from '../state/store';

/** Pecas reutilizadas pelos paineis. */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(980px, 100%)' } : undefined}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="section">
      <header>
        <h3>{title}</h3>
        <div className="spacer" />
        {actions}
      </header>
      {children}
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
    if (!files || files.length === 0) return;
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
      <div
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
        <div className="hint" style={{ marginTop: 4 }}>
          PNG, JPEG, WebP, GIF ou AVIF — ate {formatBytes(uploadLimitFor(kind))}
        </div>
      </div>
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
