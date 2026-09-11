import { useRef, useState } from 'react';
import {
  generateId,
  type FieldType,
  type SheetField,
  type SheetSection,
  type SheetTemplate,
} from '@rpg/shared';

import { act } from '../net/socket';
import { useStore } from '../state/store';
import { Modal, SelectField, Toggle } from './common';

/**
 * Editor do modelo de ficha.
 *
 * Este e o lugar onde a mesa deixa de ser generica: o mestre monta aqui os
 * campos do sistema que vai usar. As fichas existentes sao reconciliadas ao
 * salvar — campos novos ganham o valor padrao, campos removidos somem, e o
 * que continua compativel e preservado.
 */

const TYPE_LABELS: Record<FieldType, string> = {
  text: 'Texto curto',
  longtext: 'Texto longo',
  number: 'Numero',
  boolean: 'Sim / nao',
  select: 'Lista de opcoes',
  resource: 'Recurso (barra)',
  inventory: 'Inventario',
  image: 'Imagem',
};

export function TemplateEditor(): JSX.Element {
  const close = useStore((s) => s.openTemplateEditor);
  const notify = useStore((s) => s.notify);
  const current = useStore((s) => s.table?.sheetTemplate);

  // Editamos uma copia: nada e enviado a mesa ate o mestre salvar.
  const [draft, setDraft] = useState<SheetTemplate>(() =>
    current ? structuredClone(current) : { name: 'Ficha', sections: [], fields: [] },
  );
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const sections = [...draft.sections].sort((a, b) => a.order - b.order);

  function patchSection(id: string, patch: Partial<SheetSection>): void {
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  }

  function addSection(): void {
    setDraft((d) => ({
      ...d,
      sections: [
        ...d.sections,
        { id: generateId('sec'), label: 'Nova secao', order: d.sections.length, collapsed: false },
      ],
    }));
  }

  function removeSection(id: string): void {
    const used = draft.fields.filter((f) => f.sectionId === id).length;
    if (used > 0 && !window.confirm(`Esta secao tem ${used} campo(s). Remover tudo?`)) return;
    setDraft((d) => ({
      ...d,
      sections: d.sections.filter((s) => s.id !== id),
      fields: d.fields.filter((f) => f.sectionId !== id),
    }));
  }

  function addField(sectionId: string): void {
    setDraft((d) => ({
      ...d,
      fields: [
        ...d.fields,
        {
          id: generateId('fld'),
          label: 'Novo campo',
          type: 'text',
          sectionId,
          order: d.fields.filter((f) => f.sectionId === sectionId).length,
          locked: false,
          gmOnly: false,
          description: '',
          min: null,
          max: null,
          step: null,
          options: [],
          color: '#6b7fd7',
          showOnToken: false,
          span: 1,
          defaultValue: null,
          rollFormula: '',
        },
      ],
    }));
  }

  function patchField(id: string, patch: Partial<SheetField>): void {
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }));
  }

  function moveField(id: string, direction: -1 | 1): void {
    setDraft((d) => {
      const field = d.fields.find((f) => f.id === id);
      if (!field) return d;
      const siblings = d.fields
        .filter((f) => f.sectionId === field.sectionId)
        .sort((a, b) => a.order - b.order);
      const index = siblings.findIndex((f) => f.id === id);
      const target = index + direction;
      if (target < 0 || target >= siblings.length) return d;

      const reordered = [...siblings];
      [reordered[index], reordered[target]] = [reordered[target], reordered[index]];

      const orders = new Map(reordered.map((f, i) => [f.id, i]));
      return {
        ...d,
        fields: d.fields.map((f) => (orders.has(f.id) ? { ...f, order: orders.get(f.id)! } : f)),
      };
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    const result = await act('template:update', draft);
    setSaving(false);
    if (result !== null) {
      notify('info', 'Modelo de ficha atualizado.');
      close(false);
    }
  }

  /**
   * Exporta o modelo como JSON. Montar a ficha de um sistema da trabalho; sem
   * isso ela ficaria presa a uma mesa, e cada campanha nova comecaria do zero.
   */
  function exportTemplate(): void {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${draft.name.replace(/[^\w\-]+/g, '-').toLowerCase() || 'ficha'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importTemplate(file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<SheetTemplate>;
      if (!Array.isArray(parsed?.fields) || !Array.isArray(parsed?.sections)) {
        throw new Error('O arquivo nao parece um modelo de ficha.');
      }

      // Carrega no rascunho, nao na mesa: o mestre revisa e so entao salva.
      setDraft({
        name: String(parsed.name ?? 'Ficha importada').slice(0, 60),
        sections: parsed.sections,
        fields: parsed.fields,
      });
      notify('info', 'Modelo carregado. Revise e salve para aplicar a mesa.');
    } catch (err) {
      notify('error', `Nao foi possivel importar: ${(err as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <Modal
      title="Modelo de ficha"
      onClose={() => close(false)}
      wide
      footer={
        <>
          <span className="hint" style={{ flex: 1, textAlign: 'left' }}>
            As fichas existentes serao ajustadas ao novo modelo.
          </span>
          <button className="btn" onClick={exportTemplate} title="Baixar este modelo como JSON">
            Exportar
          </button>
          <button
            className="btn"
            onClick={() => fileRef.current?.click()}
            title="Carregar um modelo salvo"
          >
            Importar
          </button>
          <button className="btn" onClick={() => close(false)}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar modelo'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <label className="field">
          <span className="label">Nome do modelo</span>
          <input
            className="input"
            value={draft.name}
            maxLength={60}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Ex.: Ficha da Ordem, Ficha de investigador"
          />
        </label>

        {sections.map((section) => {
          const fields = draft.fields
            .filter((f) => f.sectionId === section.id)
            .sort((a, b) => a.order - b.order);

          return (
            <div
              key={section.id}
              style={{
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div className="row">
                <input
                  className="input"
                  style={{ maxWidth: 260, fontWeight: 600 }}
                  value={section.label}
                  maxLength={60}
                  onChange={(e) => patchSection(section.id, { label: e.target.value })}
                />
                <div className="spacer" />
                <button className="btn sm" onClick={() => addField(section.id)}>
                  + Campo
                </button>
                <button className="btn ghost sm danger" onClick={() => removeSection(section.id)}>
                  Remover secao
                </button>
              </div>

              {fields.length === 0 ? (
                <span className="hint">Secao sem campos.</span>
              ) : (
                fields.map((field) => (
                  <FieldRow
                    key={field.id}
                    field={field}
                    sections={sections}
                    onPatch={(p) => patchField(field.id, p)}
                    onRemove={() =>
                      setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== field.id) }))
                    }
                    onMove={(dir) => moveField(field.id, dir)}
                  />
                ))
              )}
            </div>
          );
        })}

        <button className="btn" onClick={addSection}>
          + Nova secao
        </button>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => void importTemplate(e.target.files?.[0])}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function FieldRow({
  field,
  sections,
  onPatch,
  onRemove,
  onMove,
}: {
  field: SheetField;
  sections: SheetSection[];
  onPatch: (patch: Partial<SheetField>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className={`field-row${field.gmOnly ? ' gm' : ''}`}>
        <button className="btn ghost sm" onClick={() => onMove(-1)} title="Subir">
          ↑
        </button>
        <button className="btn ghost sm" onClick={() => onMove(1)} title="Descer">
          ↓
        </button>

        <input
          className="input"
          style={{ flex: 1, minWidth: 100 }}
          value={field.label}
          maxLength={60}
          onChange={(e) => onPatch({ label: e.target.value })}
        />

        <select
          className="input select"
          style={{ width: 150 }}
          value={field.type}
          onChange={(e) => onPatch({ type: e.target.value as FieldType })}
        >
          {(Object.keys(TYPE_LABELS) as FieldType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>

        <button className="btn ghost sm" onClick={() => setOpen((o) => !o)} title="Mais opcoes">
          {open ? '▴' : '▾'}
        </button>
        <button className="btn ghost sm danger" onClick={onRemove} title="Remover campo">
          ✕
        </button>
      </div>

      {open && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '4px 12px 12px 46px',
          }}
        >
          <div className="grid-3">
            <SelectField
              label="Largura"
              value={String(field.span)}
              options={[
                { value: '1', label: 'Um terco' },
                { value: '2', label: 'Dois tercos' },
                { value: '3', label: 'Linha inteira' },
              ]}
              onChange={(v) => onPatch({ span: Number(v) as 1 | 2 | 3 })}
            />

            <SelectField
              label="Secao"
              value={field.sectionId}
              options={sections.map((s) => ({ value: s.id, label: s.label }))}
              onChange={(v) => onPatch({ sectionId: v })}
            />

            {(field.type === 'number' || field.type === 'resource') && (
              <label className="field">
                <span className="label">Maximo</span>
                <input
                  className="input mono"
                  type="number"
                  value={field.max ?? ''}
                  placeholder="sem limite"
                  onChange={(e) => onPatch({ max: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </label>
            )}
          </div>

          {(field.type === 'number' || field.type === 'resource') && (
            <label className="field">
              <span className="label">Minimo</span>
              <input
                className="input mono"
                type="number"
                value={field.min ?? ''}
                placeholder="sem limite"
                onChange={(e) => onPatch({ min: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </label>
          )}

          {field.type === 'select' && (
            <label className="field">
              <span className="label">Opcoes (uma por linha)</span>
              <textarea
                className="textarea"
                value={field.options.join('\n')}
                onChange={(e) =>
                  onPatch({ options: e.target.value.split('\n').map((o) => o.trim()).filter(Boolean) })
                }
              />
            </label>
          )}

          {field.type === 'resource' && (
            <div className="grid-2">
              <label className="field">
                <span className="label">Cor da barra</span>
                <input
                  type="color"
                  className="input"
                  style={{ height: 32, padding: 2 }}
                  value={field.color}
                  onChange={(e) => onPatch({ color: e.target.value })}
                />
              </label>
              <Toggle
                label="Mostrar no token"
                hint="Libera este recurso como barra sobre os tokens."
                checked={field.showOnToken}
                onChange={(v) => onPatch({ showOnToken: v })}
              />
            </div>
          )}

          <label className="field">
            <span className="label">Formula de rolagem</span>
            <input
              className="input mono"
              value={field.rollFormula}
              maxLength={100}
              placeholder="Ex.: 1d20+@destreza"
              onChange={(e) => onPatch({ rollFormula: e.target.value })}
            />
            <span className="hint">
              Preenchida, o campo ganha um dado clicavel na ficha. Use{' '}
              <span className="mono">@id_do_campo</span> para somar outro valor da mesma ficha —
              o id aparece no topo de cada campo. Aceita <span className="mono">4d6kh3</span> para
              manter os melhores dados.
            </span>
            <span className="hint mono">id deste campo: {field.id}</span>
          </label>

          <label className="field">
            <span className="label">Descricao / ajuda</span>
            <input
              className="input"
              value={field.description}
              maxLength={300}
              placeholder="Aparece ao passar o mouse sobre o campo"
              onChange={(e) => onPatch({ description: e.target.value })}
            />
          </label>

          <Toggle
            label="Travado para o jogador"
            hint="Ele ve o valor, mas so voce edita."
            checked={field.locked}
            onChange={(v) => onPatch({ locked: v })}
          />

          <Toggle
            label="Somente o mestre"
            hint="O campo nem chega ao navegador do jogador."
            checked={field.gmOnly}
            onChange={(v) => onPatch({ gmOnly: v })}
          />
        </div>
      )}
    </div>
  );
}
