import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canEditField,
  generateId,
  isResourceValue,
  type FieldValue,
  type InventoryItem,
  type ResourceValue,
  type Sheet,
  type SheetField,
} from '@rpg/shared';

import { uploadAsset } from '../net/api';
import { act } from '../net/socket';
import { findAsset, isGm, useStore } from '../state/store';
import { Empty } from './common';

/**
 * Renderiza uma ficha a partir do template da mesa.
 *
 * Nao ha nada de sistema de regras aqui: os campos, os limites e o que o
 * jogador pode editar vem todos do schema montado pelo mestre. Campos
 * travados aparecem visiveis porem sem edicao — o jogador precisa VER o
 * proprio nivel, mesmo sem poder muda-lo.
 */

const COMMIT_DELAY_MS = 420;

export function SheetView({ sheet }: { sheet: Sheet }): JSX.Element {
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const playerId = useStore((s) => s.session?.playerId ?? null);
  const template = table?.sheetTemplate;

  // O agrupamento precisa ficar ANTES de qualquer retorno antecipado: um hook
  // chamado condicionalmente quebra a ordem que o React usa para associar
  // estado a componente.
  const sections = useMemo(
    () =>
      !template
        ? []
        : [...template.sections]
            .sort((a, b) => a.order - b.order)
            .map((section) => ({
              section,
              fields: template.fields
                .filter((f) => f.sectionId === section.id)
                .sort((a, b) => a.order - b.order),
            }))
            .filter((group) => group.fields.length > 0),
    [template],
  );

  if (!template) return <Empty>Template de ficha indisponivel.</Empty>;

  const isOwner = sheet.ownerPlayerId === playerId;
  const role = gm ? 'GM' : 'PLAYER';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SheetHeader sheet={sheet} canEdit={gm || isOwner} />

      {sections.map(({ section, fields }) => (
        <div key={section.id} style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <span className="label">{section.label}</span>
          <div className="fields">
            {fields.map((field) => (
              <div key={field.id} className={`span-${field.span}`}>
                <FieldEditor
                  field={field}
                  sheet={sheet}
                  editable={canEditField(field, role, isOwner)}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SheetHeader({ sheet, canEdit }: { sheet: Sheet; canEdit: boolean }): JSX.Element {
  const notify = useStore((s) => s.notify);
  const gm = useStore(isGm);
  const inputRef = useRef<HTMLInputElement>(null);
  const portrait = findAsset(sheet.portraitAssetId);

  async function uploadPortrait(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const asset = await uploadAsset(file, 'portrait');
      void act('sheet:update', { sheetId: sheet.id, portraitAssetId: asset.id });
    } catch (err) {
      notify('error', (err as Error).message);
    }
  }

  return (
    <div className="sheet-head">
      {portrait ? (
        <img
          className="portrait"
          src={portrait.url}
          alt={sheet.name}
          onClick={() => canEdit && inputRef.current?.click()}
          style={{ cursor: canEdit ? 'pointer' : 'default' }}
          title={canEdit ? 'Trocar retrato' : undefined}
        />
      ) : (
        <div
          className="portrait empty"
          onClick={() => canEdit && inputRef.current?.click()}
          title={canEdit ? 'Enviar retrato' : undefined}
        >
          ☺
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
        <DebouncedInput
          className="input"
          value={sheet.name}
          disabled={!canEdit}
          maxLength={60}
          placeholder="Nome do personagem"
          onCommit={(v) => void act('sheet:update', { sheetId: sheet.id, name: v })}
        />

        <label className="check">
          <input
            type="checkbox"
            checked={sheet.sharedWithParty}
            disabled={!canEdit}
            onChange={(e) =>
              void act('sheet:update', { sheetId: sheet.id, sharedWithParty: e.target.checked })
            }
          />
          <span>
            Compartilhar com o grupo
            <small>Os outros jogadores passam a ver esta ficha inteira.</small>
          </span>
        </label>

        {gm && (
          <button
            className="btn ghost sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => useStore.getState().openTemplateEditor(true)}
          >
            Editar modelo de ficha
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void uploadPortrait(e.target.files?.[0])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function FieldEditor({
  field,
  sheet,
  editable,
}: {
  field: SheetField;
  sheet: Sheet;
  editable: boolean;
}): JSX.Element {
  const value = sheet.values[field.id];

  const commit = (next: FieldValue): void => {
    void act('sheet:update', { sheetId: sheet.id, values: { [field.id]: next } });
  };

  const label = <FieldLabel field={field} sheet={sheet} editable={editable} />;

  switch (field.type) {
    case 'longtext':
      return (
        <label className="field">
          {label}
          <DebouncedTextarea
            value={typeof value === 'string' ? value : ''}
            disabled={!editable}
            onCommit={commit}
          />
        </label>
      );

    case 'number':
      return (
        <label className="field">
          {label}
          <DebouncedInput
            className="input mono"
            type="number"
            value={typeof value === 'number' ? String(value) : '0'}
            disabled={!editable}
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            step={field.step ?? 1}
            onCommit={(v) => commit(Number(v) || 0)}
          />
        </label>
      );

    case 'boolean':
      return (
        <label className="check">
          <input
            type="checkbox"
            checked={value === true}
            disabled={!editable}
            onChange={(e) => commit(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );

    case 'select':
      return (
        <label className="field">
          {label}
          <select
            className="input select"
            value={typeof value === 'string' ? value : ''}
            disabled={!editable}
            onChange={(e) => commit(e.target.value)}
          >
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      );

    case 'resource':
      return (
        <ResourceEditor
          field={field}
          sheet={sheet}
          value={isResourceValue(value) ? value : { current: 0, max: 0 }}
          editable={editable}
          onCommit={commit}
        />
      );

    case 'inventory':
      return (
        <InventoryEditor
          field={field}
          items={Array.isArray(value) ? value : []}
          editable={editable}
          onCommit={commit}
        />
      );

    case 'image':
      return (
        <ImageFieldEditor
          field={field}
          assetId={typeof value === 'string' ? value : null}
          editable={editable}
          onCommit={commit}
        />
      );

    default:
      return (
        <label className="field">
          {label}
          <DebouncedInput
            className="input"
            value={typeof value === 'string' ? value : ''}
            disabled={!editable}
            onCommit={commit}
          />
        </label>
      );
  }
}

/**
 * Rotulo do campo, com o botao de rolagem quando o modelo define uma formula.
 *
 * A rolagem sai daqui como um pedido ao servidor, que resolve as referencias
 * (`@destreza`) com os valores atuais e joga os dados. Rolar no navegador
 * transformaria o resultado numa sugestao.
 */
function FieldLabel({
  field,
  sheet,
  editable,
}: {
  field: SheetField;
  sheet: Sheet;
  editable: boolean;
}): JSX.Element {
  const [rolling, setRolling] = useState(false);
  // O servidor normaliza o template ao carregar, mas nao custa nada aceitar
  // um campo incompleto aqui: derrubar a ficha inteira por causa de uma
  // propriedade ausente e uma troca ruim.
  const canRoll = (field.rollFormula ?? '').trim().length > 0;

  async function roll(e: React.MouseEvent): Promise<void> {
    // Alt rola em sussurro: teste de percepcao sem entregar o resultado.
    const whisper = e.altKey;
    setRolling(true);
    await act('sheet:roll', { sheetId: sheet.id, fieldId: field.id, whisper });
    setRolling(false);
  }

  return (
    <span className="label label-row" title={field.description || undefined}>
      <span>
        {field.label}
        {field.gmOnly && ' · mestre'}
        {field.locked && !editable && ' 🔒'}
      </span>
      {canRoll && (
        <button
          type="button"
          className="roll-btn"
          disabled={rolling}
          onClick={(e) => void roll(e)}
          title={`Rolar ${field.rollFormula} — Alt para sussurrar ao mestre`}
        >
          🎲
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------

/** Barra de recurso: atual / maximo, com botoes de ajuste rapido. */
function ResourceEditor({
  field,
  sheet,
  value,
  editable,
  onCommit,
}: {
  field: SheetField;
  sheet: Sheet;
  value: ResourceValue;
  editable: boolean;
  onCommit: (v: FieldValue) => void;
}): JSX.Element {
  const ratio = value.max > 0 ? Math.max(0, Math.min(1, value.current / value.max)) : 0;

  const adjust = (delta: number): void => {
    const current = Math.max(field.min ?? 0, Math.min(value.max, value.current + delta));
    onCommit({ ...value, current });
  };

  return (
    <div className="resource">
      <FieldLabel field={field} sheet={sheet} editable={editable} />

      <div className="bar">
        <div
          className="fill"
          style={{
            width: `${ratio * 100}%`,
            background: `linear-gradient(180deg, ${field.color} 0%, ${field.color}bb 100%)`,
          }}
        />
        <span className="txt">
          {value.current} / {value.max}
        </span>
      </div>

      <div className="row">
        {editable && (
          <>
            <button className="btn sm" onClick={() => adjust(-1)} title="-1">
              −
            </button>
            <button className="btn sm" onClick={() => adjust(1)} title="+1">
              +
            </button>
          </>
        )}
        <DebouncedInput
          className="input mono"
          type="number"
          value={String(value.current)}
          disabled={!editable}
          onCommit={(v) => onCommit({ ...value, current: Number(v) || 0 })}
        />
        <span className="hint">de</span>
        <DebouncedInput
          className="input mono"
          type="number"
          value={String(value.max)}
          disabled={!editable}
          onCommit={(v) => {
            const max = Number(v) || 0;
            // Reduzir o maximo nao pode deixar o atual acima dele.
            onCommit({ max, current: Math.min(value.current, max) });
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Inventario: itens com quantidade, icone proprio e marcacao de equipado. */
function InventoryEditor({
  field,
  items,
  editable,
  onCommit,
}: {
  field: SheetField;
  items: InventoryItem[];
  editable: boolean;
  onCommit: (v: FieldValue) => void;
}): JSX.Element {
  const notify = useStore((s) => s.notify);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);

  const update = (id: string, patch: Partial<InventoryItem>): void => {
    onCommit(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  async function uploadIcon(file: File | undefined): Promise<void> {
    if (!file || !uploadingFor) return;
    try {
      const asset = await uploadAsset(file, 'item');
      update(uploadingFor, { assetId: asset.id });
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setUploadingFor(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="field">
      <div className="row">
        <span className="label">{field.label}</span>
        <div className="spacer" />
        {editable && (
          <button
            className="btn sm"
            onClick={() =>
              onCommit([
                ...items,
                {
                  id: generateId('itm'),
                  name: 'Novo item',
                  quantity: 1,
                  assetId: null,
                  description: '',
                  equipped: false,
                },
              ])
            }
          >
            + Item
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="hint">Inventario vazio.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((item) => {
            const asset = findAsset(item.assetId);
            return (
              <div key={item.id} className={`inv-item${item.equipped ? ' equipped' : ''}`}>
                {asset ? (
                  <img
                    className="inv-icon"
                    src={asset.thumbUrl ?? asset.url}
                    alt=""
                    onClick={() => {
                      if (!editable) return;
                      setUploadingFor(item.id);
                      fileRef.current?.click();
                    }}
                  />
                ) : (
                  <div
                    className="inv-icon"
                    onClick={() => {
                      if (!editable) return;
                      setUploadingFor(item.id);
                      fileRef.current?.click();
                    }}
                    title="Enviar icone"
                  >
                    +
                  </div>
                )}

                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <DebouncedInput
                    className="input"
                    value={item.name}
                    disabled={!editable}
                    maxLength={120}
                    onCommit={(v) => update(item.id, { name: v })}
                  />
                  <DebouncedInput
                    className="input"
                    value={item.description}
                    disabled={!editable}
                    placeholder="Descricao"
                    onCommit={(v) => update(item.id, { description: v })}
                  />
                </div>

                <DebouncedInput
                  className="input mono"
                  type="number"
                  style={{ width: 62 }}
                  value={String(item.quantity)}
                  disabled={!editable}
                  onCommit={(v) => update(item.id, { quantity: Math.max(0, Number(v) || 0) })}
                />

                {editable && (
                  <>
                    <button
                      className={`btn sm${item.equipped ? ' primary' : ''}`}
                      title="Equipado"
                      onClick={() => update(item.id, { equipped: !item.equipped })}
                    >
                      ⚔
                    </button>
                    <button
                      className="btn ghost sm"
                      onClick={() => onCommit(items.filter((i) => i.id !== item.id))}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void uploadIcon(e.target.files?.[0])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ImageFieldEditor({
  field,
  assetId,
  editable,
  onCommit,
}: {
  field: SheetField;
  assetId: string | null;
  editable: boolean;
  onCommit: (v: FieldValue) => void;
}): JSX.Element {
  const notify = useStore((s) => s.notify);
  const inputRef = useRef<HTMLInputElement>(null);
  const asset = findAsset(assetId);

  async function upload(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const uploaded = await uploadAsset(file, 'item');
      onCommit(uploaded.id);
    } catch (err) {
      notify('error', (err as Error).message);
    }
  }

  return (
    <div className="field">
      <span className="label">{field.label}</span>
      {asset ? (
        <img
          src={asset.url}
          alt={field.label}
          style={{ width: '100%', borderRadius: 6, border: '1px solid var(--line)', cursor: editable ? 'pointer' : 'default' }}
          onClick={() => editable && inputRef.current?.click()}
        />
      ) : (
        <button className="btn sm" disabled={!editable} onClick={() => inputRef.current?.click()}>
          Enviar imagem
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void upload(e.target.files?.[0])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Campo que so envia ao servidor depois que a digitacao para.
 *
 * Sem isso, cada tecla viraria um evento de socket e uma escrita de ficha
 * replicada para a mesa inteira. O valor externo so sobrescreve o local
 * quando o campo nao esta em foco, para nao arrancar o texto de quem digita.
 */
function DebouncedInput({
  value,
  onCommit,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): JSX.Element {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <input
      {...rest}
      value={local}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        window.clearTimeout(timer.current);
        if (local !== value) onCommit(local);
      }}
      onChange={(e) => {
        const next = e.target.value;
        setLocal(next);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onCommit(next), COMMIT_DELAY_MS);
      }}
    />
  );
}

function DebouncedTextarea({
  value,
  onCommit,
  disabled,
}: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
}): JSX.Element {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <textarea
      className="textarea"
      value={local}
      disabled={disabled}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        window.clearTimeout(timer.current);
        if (local !== value) onCommit(local);
      }}
      onChange={(e) => {
        const next = e.target.value;
        setLocal(next);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onCommit(next), COMMIT_DELAY_MS);
      }}
    />
  );
}
