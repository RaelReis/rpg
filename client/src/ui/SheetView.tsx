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
import { Icon } from './icons';
import { findAsset, isGm, useStore } from '../state/store';
import { Empty, Section } from './common';

/**
 * Renderiza uma ficha a partir do template da mesa.
 *
 * Nao ha nada de sistema de regras aqui: os campos, os limites e o que o
 * jogador pode editar vem todos do schema montado pelo mestre. Campos
 * travados aparecem visiveis porem sem edicao — o jogador precisa VER o
 * proprio nivel, mesmo sem poder muda-lo.
 */

const COMMIT_DELAY_MS = 420;

export function SheetView({
  sheet,
  onExpand,
}: {
  sheet: Sheet;
  /** So passado por quem mostra a ficha espremida na aba lateral (~320px);
   * a ficha aberta no modal largo ja e o destino, entao nao ganha o botao. */
  onExpand?: () => void;
}): JSX.Element {
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
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <SheetHeader sheet={sheet} canEdit={gm || isOwner} onExpand={onExpand} />

      {sections.map(({ section, fields }) => (
        <Section key={section.id} title={section.label} collapsible>
          <div className="fields">
            {fields.map((field) => (
              <div key={field.id} className={`span-${field.span} sheet-cell-${field.type}`}>
                <FieldEditor
                  field={field}
                  sheet={sheet}
                  editable={canEditField(field, role, isOwner)}
                  allFields={template.fields}
                />
              </div>
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SheetHeader({
  sheet,
  canEdit,
  onExpand,
}: {
  sheet: Sheet;
  canEdit: boolean;
  onExpand?: () => void;
}): JSX.Element {
  const notify = useStore((s) => s.notify);
  const gm = useStore(isGm);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLInputElement>(null);
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
          <Icon name="portrait" size="lg" />
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
        {canEdit && <div className="row wrap">
          <button className="btn sm" onClick={() => inputRef.current?.click()}>Trocar retrato</button>
          <button className="btn sm" onClick={() => bodyRef.current?.click()}>Trocar corpo inteiro</button>
        </div>}
        <input ref={bodyRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden onChange={async e => {
          const file = e.target.files?.[0]; if (!file) return;
          try { const asset = await uploadAsset(file, 'token'); await act('sheet:update', { sheetId: sheet.id, bodyAssetId: asset.id }); }
          catch (err) { notify('error', (err as Error).message); }
          finally { if (bodyRef.current) bodyRef.current.value = ''; }
        }} />
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

      </div>

      {onExpand && (
        <button
          type="button"
          className="btn ghost sm icon-only"
          onClick={onExpand}
          title="Abrir a ficha inteira numa janela maior"
          aria-label="Abrir a ficha inteira numa janela maior"
        >
          <Icon name="expandView" size="sm" />
        </button>
      )}

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
  allFields,
}: {
  field: SheetField;
  sheet: Sheet;
  editable: boolean;
  allFields: SheetField[];
}): JSX.Element {
  const value = sheet.values[field.id];

  const commit = (next: FieldValue): void => {
    void act('sheet:update', { sheetId: sheet.id, values: { [field.id]: next } });
  };

  const label = <FieldLabel field={field} sheet={sheet} editable={editable} allFields={allFields} />;

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
          allFields={allFields}
        />
      );

    case 'inventory':
      return (
        <InventoryEditor
          sheet={sheet}
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
  allFields,
}: {
  field: SheetField;
  sheet: Sheet;
  editable: boolean;
  allFields: SheetField[];
}): JSX.Element {
  const [rolling, setRolling] = useState(false);
  // O servidor normaliza o template ao carregar, mas nao custa nada aceitar
  // um campo incompleto aqui: derrubar a ficha inteira por causa de uma
  // propriedade ausente e uma troca ruim.
  const canRoll = (field.rollFormula ?? '').trim().length > 0;
  // So aparecia ao passar o mouse no dado — quem ve a ficha pela primeira vez
  // nao tinha como saber, so olhando, que Pesquisar soma com Mente.
  const linkedWith = canRoll ? referencedFieldLabels(field, allFields) : [];

  async function roll(e: React.MouseEvent): Promise<void> {
    // Alt rola em sussurro: teste de percepcao sem entregar o resultado.
    const whisper = e.altKey;
    setRolling(true);
    await act('sheet:roll', { sheetId: sheet.id, fieldId: field.id, whisper });
    setRolling(false);
  }

  return (
    <span className="label label-row" title={field.description || undefined}>
      <span className="label-main">
        <span className="label-text">
          {field.label}
          {field.gmOnly && ' · mestre'}
          {field.locked && !editable && <Icon name="locked" size="sm" label="travado" className="inline-icon" />}
        </span>
        {/* Altura reservada mesmo vazia (ver CSS `.label-main`): perícias
            vizinhas sem legenda nao podem empurrar so a delas pra baixo,
            desalinhando a grade de 3 colunas linha a linha. */}
        {linkedWith.length > 0 && <span className="field-linked">{linkedWith.join(' + ')}</span>}
      </span>
      {canRoll && (
        <button
          type="button"
          className="roll-btn"
          disabled={rolling}
          onClick={(e) => void roll(e)}
          title={`Rolar ${readableFormula(field.rollFormula, allFields)} — Alt para sussurrar ao mestre`}
          aria-label={`Rolar ${field.label}`}
        >
          <Icon name="roll" size="sm" />
        </button>
      )}
    </span>
  );
}

/**
 * Outros campos citados na formula, pelo nome — nao pelo id.
 *
 * `1d@per_pesquisar+1d@atr_mente` na propria Pesquisar deve mostrar so
 * "Mente": a propria perícia ja esta escrita no rotulo, repeti-la no
 * subtitulo so faria ruido.
 */
/**
 * A formula como o jogador le: `1d20+@destreza` vira "1d20+Destreza". O
 * tooltip mostrava os ids crus, e com os ids aleatorios de antes aparecia
 * "1d20+@fld_eqa0f9zga6ec".
 */
function readableFormula(formula: string, allFields: SheetField[]): string {
  return formula.replace(/@([A-Za-z0-9_-]+)/g, (raw, id: string) => allFields.find((f) => f.id === id)?.label ?? raw);
}

function referencedFieldLabels(field: SheetField, allFields: SheetField[]): string[] {
  const ids = [...field.rollFormula.matchAll(/@([A-Za-z0-9_-]+)/g)]
    .map((m) => m[1])
    .filter((id) => id !== field.id);
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const label = allFields.find((f) => f.id === id)?.label;
    if (label) labels.push(label);
  }
  return labels;
}

// ---------------------------------------------------------------------------

/** Barra de recurso: atual / maximo, com botoes de ajuste rapido. */
function ResourceEditor({
  field,
  sheet,
  value,
  editable,
  onCommit,
  allFields,
}: {
  field: SheetField;
  sheet: Sheet;
  value: ResourceValue;
  editable: boolean;
  onCommit: (v: FieldValue) => void;
  allFields: SheetField[];
}): JSX.Element {
  const ratio = value.max > 0 ? Math.max(0, Math.min(1, value.current / value.max)) : 0;

  const adjust = (delta: number): void => {
    void act('sheet:operate', { sheetId: sheet.id, fieldId: field.id, action: 'adjust', delta });
  };

  return (
    <div className="resource">
      <FieldLabel field={field} sheet={sheet} editable={editable} allFields={allFields} />

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
            <button className="btn sm icon-only" onClick={() => adjust(-1)} title="-1" aria-label="Diminuir 1">
              <Icon name="remove" size="sm" />
            </button>
            <button className="btn sm icon-only" onClick={() => adjust(1)} title="+1" aria-label="Aumentar 1">
              <Icon name="add" size="sm" />
            </button>
          </>
        )}
        <DebouncedInput
          className="input mono"
          type="number"
          value={String(value.current)}
          disabled={!editable}
          onCommit={(v) => void act('sheet:operate', { sheetId: sheet.id, fieldId: field.id, action: 'resource', resource: { current: Number(v) || 0 } })}
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
            void act('sheet:operate', { sheetId: sheet.id, fieldId: field.id, action: 'resource', resource: { max } });
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Inventario: itens com quantidade, icone proprio e marcacao de equipado. */
function InventoryEditor({
  sheet,
  field,
  items,
  editable,
  onCommit,
}: {
  field: SheetField;
  sheet: Sheet;
  items: InventoryItem[];
  editable: boolean;
  onCommit: (v: FieldValue) => void;
}): JSX.Element {
  const notify = useStore((s) => s.notify);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);

  const update = (id: string, patch: Partial<InventoryItem>): void => {
    void act('sheet:operate', { sheetId: sheet.id, fieldId: field.id, action: 'update', itemId: id, item: patch });
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
              void act('sheet:operate', { sheetId: sheet.id, fieldId: field.id, action: 'add' })
            }
          >
            <Icon name="add" size="sm" /> Item
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
                    role={editable ? 'button' : undefined}
                    tabIndex={editable ? 0 : undefined}
                    aria-label="Trocar imagem do item"
                    onKeyDown={e => { if (editable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setUploadingFor(item.id); fileRef.current?.click(); } }}
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
                    role={editable ? 'button' : undefined}
                    tabIndex={editable ? 0 : undefined}
                    aria-label="Trocar imagem do item"
                    onKeyDown={e => { if (editable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setUploadingFor(item.id); fileRef.current?.click(); } }}
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
                      aria-label="Equipado"
                      aria-pressed={item.equipped}
                      onClick={() => update(item.id, { equipped: !item.equipped })}
                    >
                      <Icon name="equipped" size="sm" />
                    </button>
                    <button
                      className="btn ghost sm icon-only"
                      title="Excluir item"
                      aria-label="Excluir item"
                      onClick={() => void act('sheet:operate', { sheetId: sheet.id, fieldId: field.id, action: 'remove', itemId: item.id })}
                    >
                      <Icon name="delete" size="sm" />
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
      {asset && editable && <button className="btn sm" onClick={() => inputRef.current?.click()}>Trocar imagem</button>}
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
function useDebouncedValue(value: string, onCommit: (value: string) => void) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  const pending = useRef<string | undefined>();
  const timer = useRef<number>();
  const commit = useRef(onCommit); commit.current = onCommit;
  const flush = () => {
    window.clearTimeout(timer.current);
    if (pending.current !== undefined) { const next = pending.current; pending.current = undefined; commit.current(next); }
  };
  useEffect(() => { if (!focused.current && pending.current === undefined) setLocal(value); }, [value]);
  useEffect(() => () => flush(), []);
  return {
    value: local,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; flush(); },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = e.target.value; setLocal(next); pending.current = next;
      window.clearTimeout(timer.current); timer.current = window.setTimeout(flush, COMMIT_DELAY_MS);
    },
  };
}
function DebouncedInput({ value, onCommit, ...rest }: {
  value: string; onCommit: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): JSX.Element {
  const props = useDebouncedValue(value, onCommit);
  return <input {...rest} {...props} />;
}
function DebouncedTextarea({ value, onCommit, disabled }: {
  value: string; onCommit: (v: string) => void; disabled?: boolean;
}): JSX.Element {
  const props = useDebouncedValue(value, onCommit);
  return <textarea className="textarea" disabled={disabled} {...props} />;
}
