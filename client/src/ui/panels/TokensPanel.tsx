import { useState } from 'react';
import {
  CONDITION_PRESETS,
  LAYER_NAMES,
  PARANORMAL_PRESETS,
  tokenBarFields,
  type Layer,
  type EffectStyle,
  type MapEffect,
  type TokenShape,
  type Tile,
  type Token,
} from '@rpg/shared';

import { act } from '../../net/socket';
import { activeScene, findAsset, useStore } from '../../state/store';
import {
  ColorField,
  Dropzone,
  Empty,
  NumberField,
  SelectField,
  Section,
  TextField,
  Toggle,
} from '../common';

/** Painel do mestre: tokens da cena, inspetor do token e efeitos de mapa. */

export function TokensPanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const selectedIds = useStore((s) => s.selectedTokenIds);
  const selectToken = useStore((s) => s.selectToken);
  const table = useStore((s) => s.table);

  void rev;
  const scene = activeScene(useStore.getState());
  if (!scene || !table) return <Empty>Ative uma cena para trabalhar com tokens.</Empty>;

  const selected =
    selectedIds.length === 1 ? (scene.tokens.find((t) => t.id === selectedIds[0]) ?? null) : null;

  function createToken(assetId: string | null): void {
    if (!scene) return;
    // Nasce no centro do que o mestre esta vendo, nao no canto do mapa.
    void act<Token>('token:create', {
      sceneId: scene.id,
      token: {
        name: assetId ? (findAsset(assetId)?.originalName.replace(/\.[^.]+$/, '') ?? 'Token') : 'Token',
        assetId,
        x: scene.width / 2,
        y: scene.height / 2,
        layer: 3,
      },
    }).then((token) => token && selectToken(token.id));
  }

  return (
    <>
      <Section
        title="Novo token"
        actions={
          <button className="btn sm" onClick={() => createToken(null)}>
            + Vazio
          </button>
        }
      >
        <Dropzone kind="token" label="Enviar imagem e criar token" onUploaded={createToken} multiple />
      </Section>

      <Section title={`Tokens na cena (${scene.tokens.length})`}>
        {scene.tokens.length === 0 ? (
          <Empty>Nenhum token ainda.</Empty>
        ) : (
          ([3, 4, 2, 1] as Layer[]).map((layer) => {
            const group = scene.tokens.filter((t) => t.layer === layer);
            if (group.length === 0) return null;
            return (
              <div key={layer} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="label">{LAYER_NAMES[layer]}</span>
                <div className="list">
                  {group.map((token) => {
                    const asset = findAsset(token.assetId);
                    const owner = table.players.find((p) => p.id === token.ownerPlayerId);
                    return (
                      <button
                        key={token.id}
                        className={`item${selectedIds.includes(token.id) ? ' active' : ''}`}
                        onClick={() => selectToken(token.id)}
                      >
                        {asset ? (
                          <img className="swatch" src={asset.thumbUrl ?? asset.url} alt="" />
                        ) : (
                          <span className="swatch" style={{ background: token.color }} />
                        )}
                        <span className="name">
                          {token.name}
                          {owner && <span className="sub"> · {owner.name}</span>}
                        </span>
                        {token.gmOnly && <span className="tag gm">MJ</span>}
                        {token.visibility === 'hidden' && <span className="tag">oculto</span>}
                        {token.visionRadius > 0 && <span className="tag">👁 {token.visionRadius}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </Section>

      {selectedIds.length > 1 && (
        <Section title={`${selectedIds.length} tokens selecionados`}>
          <span className="hint">
            Arraste para mover o grupo, <strong>Ctrl+D</strong> duplica e <strong>Delete</strong>{' '}
            remove todos. Selecione apenas um para abrir o inspetor.
          </span>
        </Section>
      )}

      {selected && <TokenInspector token={selected} sceneId={scene.id} />}

      <TilesSection tiles={scene.tiles} sceneId={scene.id} />

      <EffectsSection effects={scene.effects} sceneId={scene.id} />
    </>
  );
}

// ---------------------------------------------------------------------------

function TokenInspector({ token, sceneId }: { token: Token; sceneId: string }): JSX.Element {
  const table = useStore((s) => s.table);
  const template = table?.sheetTemplate;
  const barFields = template ? tokenBarFields(template) : [];

  const patch = (p: Partial<Token>): void => {
    void act('token:update', { sceneId, tokenId: token.id, patch: p });
  };

  return (
    <Section
      title="Token selecionado"
      actions={
        <button
          className="btn ghost sm danger"
          onClick={() => {
            if (window.confirm(`Remover "${token.name}" da cena?`)) {
              void act('token:delete', { sceneId, tokenId: token.id });
            }
          }}
        >
          Excluir
        </button>
      }
    >
      <TextField label="Nome" value={token.name} maxLength={60} onChange={(v) => patch({ name: v })} />

      <SelectField
        label="Forma no mapa"
        value={token.shape}
        options={[
          { value: 'circle', label: 'Peca redonda (vista de cima)' },
          { value: 'art', label: 'Arte inteira (personagem de pe)' },
        ]}
        onChange={(v) => patch({ shape: v as TokenShape })}
      />
      {token.shape === 'art' && (
        <span className="hint">
          A ilustracao aparece por completo, de pe sobre a celula, com a transparencia da imagem
          preservada — use um PNG recortado. O tamanho define a largura; a altura vem da propria
          imagem. A area que o token ocupa na grade continua sendo o tamanho declarado.
        </span>
      )}

      <div className="grid-2">
        <SelectField
          label="Camada"
          value={String(token.layer)}
          options={[1, 2, 3, 4].map((l) => ({ value: String(l), label: `${l} — ${LAYER_NAMES[l as Layer]}` }))}
          onChange={(v) => patch({ layer: Number(v) as Layer })}
        />
        <SelectField
          label="Visibilidade"
          value={token.visibility}
          options={[
            { value: 'visible', label: 'Visivel' },
            { value: 'dim', label: 'Semitransparente' },
            { value: 'hidden', label: 'Oculto dos jogadores' },
          ]}
          onChange={(v) => patch({ visibility: v })}
        />
      </div>

      <Toggle
        label="Exclusivo do mestre"
        hint="Nem chega ao navegador dos jogadores, independentemente da neblina."
        checked={token.gmOnly}
        onChange={(v) => patch({ gmOnly: v })}
      />

      <div className="grid-2">
        <NumberField
          label="Tamanho"
          suffix="celulas"
          value={token.scale}
          min={0.25}
          max={20}
          step={0.25}
          onChange={(v) => patch({ scale: v })}
        />
        <NumberField
          label="Rotacao"
          suffix="graus"
          value={token.rotation}
          min={-360}
          max={360}
          onChange={(v) => patch({ rotation: v })}
        />
      </div>

      <div className="grid-2">
        <label className="field">
          <span className="label">Opacidade</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={token.opacity}
            onChange={(e) => patch({ opacity: Number(e.target.value) })}
          />
        </label>
        <ColorField label="Cor do anel" value={token.color} onChange={(v) => patch({ color: v })} />
      </div>

      <Toggle
        label="Travado"
        hint="Impede que seja arrastado por engano."
        checked={token.locked}
        onChange={(v) => patch({ locked: v })}
      />

      <div className="divider" />

      <SelectField
        label="Controlado por"
        value={token.ownerPlayerId ?? ''}
        options={[
          { value: '', label: 'Mestre' },
          ...(table?.players
            .filter((p) => p.role === 'PLAYER')
            .map((p) => ({ value: p.id, label: p.name })) ?? []),
        ]}
        onChange={(v) => patch({ ownerPlayerId: v || null })}
      />

      <SelectField
        label="Ficha vinculada"
        value={token.sheetId ?? ''}
        options={[
          { value: '', label: 'Nenhuma' },
          ...(table?.sheets.map((s) => ({ value: s.id, label: s.name })) ?? []),
        ]}
        onChange={(v) => patch({ sheetId: v || null })}
      />

      <div className="grid-2">
        <NumberField
          label="Raio de visao"
          suffix="celulas"
          value={token.visionRadius}
          min={0}
          max={40}
          onChange={(v) => patch({ visionRadius: v })}
        />
        <NumberField
          label="Luz emitida"
          suffix="celulas"
          value={token.lightRadius}
          min={0}
          max={40}
          onChange={(v) => patch({ lightRadius: v })}
        />
      </div>
      <span className="hint">
        A visao serve ao dono do token. A luz revela para todos os jogadores — e a tocha na mao de
        alguem iluminando a sala inteira.
      </span>

      <div className="divider" />

      <span className="label">Barras sobre o token</span>
      {barFields.length === 0 ? (
        <span className="hint">
          Marque "mostrar no token" em um campo de recurso no editor de ficha para poder usa-lo aqui.
        </span>
      ) : (
        barFields.map((field) => {
          const active = token.bars.some((b) => b.fieldId === field.id);
          return (
            <Toggle
              key={field.id}
              label={field.label}
              checked={active}
              onChange={(on) =>
                patch({
                  bars: on
                    ? [...token.bars, { fieldId: field.id, color: field.color }].slice(0, 3)
                    : token.bars.filter((b) => b.fieldId !== field.id),
                })
              }
            />
          );
        })
      )}

      <div className="divider" />

      <span className="label">Condicoes</span>
      <div className="row wrap">
        {CONDITION_PRESETS.map((condition) => {
          const on = token.conditions.includes(condition.icon);
          return (
            <button
              key={condition.id}
              className={`btn sm${on ? ' primary' : ''}`}
              title={condition.label}
              onClick={() =>
                patch({
                  conditions: on
                    ? token.conditions.filter((c) => c !== condition.icon)
                    : [...token.conditions, condition.icon],
                })
              }
            >
              {condition.icon}
            </button>
          );
        })}
      </div>

      <TextField
        label="Rotulo no mapa"
        value={token.label}
        maxLength={40}
        placeholder="Sobrescreve o nome sob o token"
        onChange={(v) => patch({ label: v })}
      />

      <span className="label">Trocar imagem</span>
      <Dropzone kind="token" label="Enviar nova imagem" onUploaded={(assetId) => patch({ assetId })} />
      {token.assetId && (
        <button className="btn ghost sm" onClick={() => patch({ assetId: null })}>
          Remover imagem
        </button>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

/**
 * Tiles: as pecas de cenario das camadas de fundo e de obstaculos.
 *
 * Diferente do token, o tile e um retangulo — serve para colar uma parte de
 * mapa, um movel, uma coluna. E e aqui que mora o `blocksVision`, que
 * transforma a peca em obstaculo real para a neblina.
 */
function TilesSection({ tiles, sceneId }: { tiles: Tile[]; sceneId: string }): JSX.Element {
  const selectedTileId = useStore((s) => s.selectedTileId);
  const selectTile = useStore((s) => s.selectTile);
  const setTool = useStore((s) => s.setTool);
  const selected = tiles.find((t) => t.id === selectedTileId) ?? null;

  const patch = (p: Partial<Tile>): void => {
    if (selected) void act('tile:update', { sceneId, tileId: selected.id, patch: p });
  };

  return (
    <Section
      title={`Tiles (${tiles.length})`}
      actions={
        <button className="btn sm" onClick={() => setTool('tile')} title="Arraste no mapa para criar">
          + Colocar
        </button>
      }
    >
      {tiles.length === 0 ? (
        <Empty>
          Escolha uma imagem na aba Imagens e arraste-a para o mapa, ou use a ferramenta de tile no
          trilho a esquerda.
        </Empty>
      ) : (
        <div className="list">
          {tiles.map((tile) => {
            const asset = findAsset(tile.assetId);
            return (
              <button
                key={tile.id}
                className={`item${tile.id === selectedTileId ? ' active' : ''}`}
                onClick={() => selectTile(tile.id)}
              >
                {asset ? (
                  <img className="swatch" src={asset.thumbUrl ?? asset.url} alt="" />
                ) : (
                  <span className="swatch" style={{ background: tile.color ?? '#2b3140' }} />
                )}
                <span className="name">
                  {asset?.originalName ?? 'Tile'}
                  <span className="sub">
                    {' '}
                    · camada {tile.layer} · {Math.round(tile.width)}×{Math.round(tile.height)}
                  </span>
                </span>
                {tile.blocksVision && <span className="tag">bloqueia</span>}
                {tile.gmOnly && <span className="tag gm">MJ</span>}
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <>
          <div className="divider" />

          <div className="grid-2">
            <NumberField
              label="Largura"
              suffix="px"
              value={Math.round(selected.width)}
              min={4}
              onChange={(v) => patch({ width: v })}
            />
            <NumberField
              label="Altura"
              suffix="px"
              value={Math.round(selected.height)}
              min={4}
              onChange={(v) => patch({ height: v })}
            />
          </div>

          <div className="grid-2">
            <NumberField
              label="Rotacao"
              suffix="graus"
              value={selected.rotation}
              min={-360}
              max={360}
              onChange={(v) => patch({ rotation: v })}
            />
            <SelectField
              label="Camada"
              value={String(selected.layer)}
              options={[1, 2, 3, 4].map((l) => ({
                value: String(l),
                label: `${l} — ${LAYER_NAMES[l as Layer]}`,
              }))}
              onChange={(v) => patch({ layer: Number(v) as Layer })}
            />
          </div>

          <label className="field">
            <span className="label">Opacidade</span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={selected.opacity}
              onChange={(e) => patch({ opacity: Number(e.target.value) })}
            />
          </label>

          <Toggle
            label="Bloqueia a visao"
            hint="A peca vira obstaculo: a neblina para nela, como numa parede."
            checked={selected.blocksVision}
            onChange={(v) => patch({ blocksVision: v })}
          />

          <Toggle
            label="Somente o mestre ve"
            checked={selected.gmOnly}
            onChange={(v) => patch({ gmOnly: v })}
          />

          <Toggle
            label="Travado"
            hint="Impede arrastar sem querer enquanto voce trabalha por cima."
            checked={selected.locked}
            onChange={(v) => patch({ locked: v })}
          />

          <Dropzone kind="tile" label="Trocar imagem do tile" onUploaded={(assetId) => patch({ assetId })} />

          <button
            className="btn ghost sm danger"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => {
              void act('tile:delete', { sceneId, tileId: selected.id });
              selectTile(null);
            }}
          >
            Excluir tile
          </button>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

/**
 * Efeitos de mapa. O que importa aqui e a ancoragem: preso a uma celula da
 * grid, colado num token (e entao acompanha o movimento dele) ou solto em
 * qualquer coordenada.
 */
function EffectsSection({ effects, sceneId }: { effects: MapEffect[]; sceneId: string }): JSX.Element {
  const [kind, setKind] = useState<MapEffect['kind']>('circle');
  const scene = activeScene(useStore.getState());
  const selectedTokenId = useStore((s) => s.selectedTokenIds[0] ?? null);

  function create(anchor: MapEffect['anchor'], preset: Partial<MapEffect> = {}): void {
    if (!scene) return;
    void act('effect:create', {
      sceneId,
      effect: {
        kind,
        anchor,
        tokenId: anchor === 'token' ? selectedTokenId : null,
        cell:
          anchor === 'grid'
            ? { a: Math.round(scene.width / 2 / scene.grid.size), b: Math.round(scene.height / 2 / scene.grid.size) }
            : null,
        x: anchor === 'free' ? scene.width / 2 : 0,
        y: anchor === 'free' ? scene.height / 2 : 0,
        label: kind === 'text' ? 'Anotacao' : '',
        ...preset,
      },
    });
  }

  return (
    <Section title={`Efeitos de mapa (${effects.length})`}>
      <SelectField
        label="Tipo"
        value={kind}
        options={[
          { value: 'circle', label: 'Area circular' },
          { value: 'cone', label: 'Cone' },
          { value: 'rect', label: 'Retangulo' },
          { value: 'line', label: 'Linha' },
          { value: 'text', label: 'Texto' },
          { value: 'image', label: 'Imagem' },
        ]}
        onChange={setKind}
      />

      <span className="label">Elementos do Outro Lado</span>
      <div className="row wrap">
        {PARANORMAL_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className={`btn sm preset-${preset.id}`}
            title={preset.hint}
            onClick={() => create('free', preset.patch)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <span className="hint">
        Cria a area ja com a cor e o movimento do elemento. Tudo continua editavel depois — o
        preset e um ponto de partida, nao uma regra.
      </span>

      <div className="divider" />

      <div className="row wrap">
        <button className="btn sm" onClick={() => create('grid')} title="Fixo em uma celula da grid">
          Fixar na grid
        </button>
        <button
          className="btn sm"
          onClick={() => create('token')}
          disabled={!selectedTokenId}
          title="Acompanha o token selecionado"
        >
          Prender ao token
        </button>
        <button className="btn sm" onClick={() => create('free')} title="Posicao livre, sem encaixe">
          Solto
        </button>
      </div>

      <div className="list">
        {effects.map((effect) => (
          <EffectRow key={effect.id} effect={effect} sceneId={sceneId} />
        ))}
      </div>
    </Section>
  );
}

function EffectRow({ effect, sceneId }: { effect: MapEffect; sceneId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const patch = (p: Partial<MapEffect>): void => {
    void act('effect:update', { sceneId, effectId: effect.id, patch: p });
  };

  const anchorLabel =
    effect.anchor === 'token' ? 'no token' : effect.anchor === 'grid' ? 'na grid' : 'solto';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="item" onClick={() => setOpen((o) => !o)}>
        <span className="swatch" style={{ background: effect.color }} />
        <span className="name">
          {effect.label || effect.kind}
          <span className="sub"> · {anchorLabel}</span>
        </span>
        {effect.gmOnly && <span className="tag gm">MJ</span>}
        <button
          className="btn ghost sm"
          onClick={(e) => {
            e.stopPropagation();
            void act('effect:delete', { sceneId, effectId: effect.id });
          }}
        >
          ✕
        </button>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 8px 8px' }}>
          <TextField label="Rotulo" value={effect.label} maxLength={120} onChange={(v) => patch({ label: v })} />

          <div className="grid-2">
            <ColorField label="Cor" value={effect.color} onChange={(v) => patch({ color: v })} />
            <label className="field">
              <span className="label">Opacidade</span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={effect.opacity}
                onChange={(e) => patch({ opacity: Number(e.target.value) })}
              />
            </label>
          </div>

          <SelectField
            label="Estilo"
            value={effect.style}
            options={[
              { value: 'flat', label: 'Chapado' },
              { value: 'glow', label: 'Brilho' },
              { value: 'pulse', label: 'Pulsante' },
              { value: 'runes', label: 'Runas (Conhecimento)' },
              { value: 'vortex', label: 'Vortice (Energia)' },
              { value: 'mist', label: 'Nevoa (Morte)' },
              { value: 'embers', label: 'Brasas (Sangue)' },
              { value: 'static', label: 'Chiado (Medo)' },
            ]}
            onChange={(v) => patch({ style: v as EffectStyle })}
          />

          {effect.style !== 'flat' && (
            <>
              <ColorField
                label="Cor secundaria"
                value={effect.colorAlt}
                onChange={(v) => patch({ colorAlt: v })}
              />
              <label className="field">
                <span className="label">Velocidade</span>
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={0.1}
                  value={effect.speed}
                  onChange={(e) => patch({ speed: Number(e.target.value) })}
                />
                <span className="hint">Em zero, o efeito congela.</span>
              </label>
            </>
          )}

          {(effect.kind === 'circle' || effect.kind === 'cone' || effect.kind === 'line') && (
            <NumberField
              label={effect.kind === 'line' ? 'Comprimento' : 'Raio'}
              suffix="celulas"
              value={effect.radius}
              min={0}
              max={200}
              step={0.5}
              onChange={(v) => patch({ radius: v })}
            />
          )}

          {(effect.kind === 'rect' || effect.kind === 'image' || effect.kind === 'line') && (
            <div className="grid-2">
              <NumberField
                label="Largura"
                suffix="celulas"
                value={effect.width}
                min={0}
                max={200}
                step={0.5}
                onChange={(v) => patch({ width: v })}
              />
              {effect.kind !== 'line' && (
                <NumberField
                  label="Altura"
                  suffix="celulas"
                  value={effect.height}
                  min={0}
                  max={200}
                  step={0.5}
                  onChange={(v) => patch({ height: v })}
                />
              )}
            </div>
          )}

          {(effect.kind === 'cone' || effect.kind === 'line' || effect.kind === 'rect' || effect.kind === 'image') && (
            <div className="grid-2">
              <NumberField
                label="Direcao"
                suffix="graus"
                value={effect.angle}
                min={-360}
                max={360}
                onChange={(v) => patch({ angle: v })}
              />
              {effect.kind === 'cone' && (
                <NumberField
                  label="Abertura"
                  suffix="graus"
                  value={effect.spread}
                  min={1}
                  max={360}
                  onChange={(v) => patch({ spread: v })}
                />
              )}
            </div>
          )}

          {effect.kind === 'text' && (
            <NumberField
              label="Tamanho da fonte"
              value={effect.fontSize}
              min={8}
              max={200}
              onChange={(v) => patch({ fontSize: v })}
            />
          )}

          {effect.kind === 'image' && (
            <Dropzone kind="effect" label="Imagem do efeito" onUploaded={(assetId) => patch({ assetId })} />
          )}

          {effect.anchor === 'free' && (
            <div className="grid-2">
              <NumberField label="Posicao X" value={effect.x} onChange={(v) => patch({ x: v })} />
              <NumberField label="Posicao Y" value={effect.y} onChange={(v) => patch({ y: v })} />
            </div>
          )}

          <Toggle
            label="Somente o mestre ve"
            checked={effect.gmOnly}
            onChange={(v) => patch({ gmOnly: v })}
          />
        </div>
      )}
    </div>
  );
}
