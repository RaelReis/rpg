import { useState } from 'react';
import type { GridType, Scene } from '@rpg/shared';

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

/** Painel do mestre: cenas, grid, fundo, neblina e iluminacao. */

const GRID_OPTIONS: { value: GridType; label: string }[] = [
  { value: 'square', label: 'Quadrada' },
  { value: 'hex-pointy', label: 'Hexagonal (ponta em cima)' },
  { value: 'hex-flat', label: 'Hexagonal (lado em cima)' },
  { value: 'none', label: 'Sem grid' },
];

export function ScenePanel(): JSX.Element {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const [newSceneName, setNewSceneName] = useState('');

  void rev;
  const scene = activeScene(useStore.getState());
  if (!table) return <Empty>Sem mesa carregada.</Empty>;

  const patch = (p: Partial<Scene>): void => {
    if (scene) void act('scene:update', { sceneId: scene.id, patch: p });
  };

  return (
    <>
      <Section
        title="Cenas"
        actions={
          <button
            className="btn sm"
            onClick={() => {
              void act('scene:create', { name: newSceneName.trim() || 'Nova cena' });
              setNewSceneName('');
            }}
          >
            + Nova
          </button>
        }
      >
        <div className="list">
          {table.scenes
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((s) => (
              <div key={s.id} className={`item${s.id === table.activeSceneId ? ' active' : ''}`}>
                <button
                  className="name"
                  style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                  onClick={() => void act('scene:activate', { sceneId: s.id })}
                  title="Ativar para todos os jogadores"
                >
                  {s.name}
                </button>
                {s.id === table.activeSceneId && <span className="tag on">no ar</span>}
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    if (window.confirm(`Excluir a cena "${s.name}"? Tokens e neblina dela serao perdidos.`)) {
                      void act('scene:delete', { sceneId: s.id });
                    }
                  }}
                  title="Excluir cena"
                >
                  ✕
                </button>
              </div>
            ))}
        </div>

        <input
          className="input"
          placeholder="Nome da proxima cena"
          value={newSceneName}
          maxLength={80}
          onChange={(e) => setNewSceneName(e.target.value)}
        />
        <span className="hint">
          Cenas novas ficam so com voce. Os jogadores passam a ve-las quando forem ativadas.
        </span>
      </Section>

      {!scene ? (
        <Section title="Cena ativa">
          <Empty>Nenhuma cena ativa.</Empty>
        </Section>
      ) : (
        <>
          <Section title="Cena ativa">
            <TextField label="Nome" value={scene.name} onChange={(v) => patch({ name: v })} maxLength={80} />

            <div className="grid-2">
              <NumberField
                label="Largura"
                suffix="px"
                value={scene.width}
                min={100}
                max={20000}
                onChange={(v) => patch({ width: v })}
              />
              <NumberField
                label="Altura"
                suffix="px"
                value={scene.height}
                min={100}
                max={20000}
                onChange={(v) => patch({ height: v })}
              />
            </div>

            <span className="label">Imagem de fundo</span>
            {scene.backgroundAssetId && findAsset(scene.backgroundAssetId) && (
              <div className="row">
                <img
                  className="swatch"
                  style={{ width: 56, height: 40 }}
                  src={findAsset(scene.backgroundAssetId)?.thumbUrl ?? findAsset(scene.backgroundAssetId)?.url}
                  alt=""
                />
                <span className="hint" style={{ flex: 1 }}>
                  {findAsset(scene.backgroundAssetId)?.width}×{findAsset(scene.backgroundAssetId)?.height}
                </span>
                <button className="btn ghost sm" onClick={() => patch({ backgroundAssetId: null })}>
                  Remover
                </button>
              </div>
            )}

            <Dropzone
              kind="map"
              label="Enviar mapa de fundo"
              onUploaded={(assetId) => {
                // O mapa novo define o tamanho da cena: e quase sempre o que
                // se quer, e evita ter que digitar as dimensoes na mao.
                const asset = findAsset(assetId);
                patch({
                  backgroundAssetId: assetId,
                  ...(asset ? { width: asset.width, height: asset.height } : {}),
                });
              }}
            />

            <ColorField
              label="Cor de fundo"
              value={scene.backgroundColor}
              onChange={(v) => patch({ backgroundColor: v })}
            />
          </Section>

          <Section title="Grid">
            <SelectField
              label="Tipo"
              value={scene.grid.type}
              options={GRID_OPTIONS}
              onChange={(v) => patch({ grid: { ...scene.grid, type: v } })}
            />

            <div className="grid-2">
              <NumberField
                label="Tamanho da celula"
                suffix="px"
                value={scene.grid.size}
                min={10}
                max={500}
                onChange={(v) => patch({ grid: { ...scene.grid, size: v } })}
              />
              <NumberField
                label="Distancia por celula"
                value={scene.grid.unitsPerCell}
                min={0.01}
                step={0.5}
                onChange={(v) => patch({ grid: { ...scene.grid, unitsPerCell: v } })}
              />
            </div>

            <div className="grid-3">
              <NumberField
                label="Deslocar X"
                value={scene.grid.offsetX}
                onChange={(v) => patch({ grid: { ...scene.grid, offsetX: v } })}
              />
              <NumberField
                label="Deslocar Y"
                value={scene.grid.offsetY}
                onChange={(v) => patch({ grid: { ...scene.grid, offsetY: v } })}
              />
              <TextField
                label="Unidade"
                value={scene.grid.unitLabel}
                maxLength={8}
                onChange={(v) => patch({ grid: { ...scene.grid, unitLabel: v } })}
              />
            </div>
            <span className="hint">
              Ajuste tamanho e deslocamento ate a grid coincidir com o desenho do mapa enviado.
            </span>

            <div className="grid-2">
              <ColorField
                label="Cor"
                value={scene.grid.color}
                onChange={(v) => patch({ grid: { ...scene.grid, color: v } })}
              />
              <label className="field">
                <span className="label">Opacidade</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={scene.grid.opacity}
                  onChange={(e) => patch({ grid: { ...scene.grid, opacity: Number(e.target.value) } })}
                />
              </label>
            </div>

            <Toggle
              label="Encaixar tokens na grid"
              hint="Segure Ctrl ao soltar um token para posicionar livremente."
              checked={scene.grid.snap}
              onChange={(v) => patch({ grid: { ...scene.grid, snap: v } })}
            />
          </Section>

          <Section title="Neblina de guerra">
            <SelectField
              label="Modo"
              value={scene.fog.mode}
              options={[
                { value: 'off', label: 'Desligada — todos veem tudo' },
                { value: 'manual', label: 'Manual — voce revela com o pincel' },
                { value: 'vision', label: 'Por visao — os tokens revelam ao andar' },
              ]}
              onChange={(v) => patch({ fog: { ...scene.fog, mode: v } })}
            />

            {scene.fog.mode === 'vision' && (
              <span className="hint">
                Cada token precisa de um raio de visao (aba Tokens) e de um dono para enxergar.
                Paredes bloqueiam a visao; portas so bloqueiam quando fechadas.
              </span>
            )}

            <Toggle
              label="Lembrar areas exploradas"
              hint="O que ja foi visto continua no mapa, em penumbra, sem mostrar tokens."
              checked={scene.fog.rememberExplored}
              onChange={(v) => patch({ fog: { ...scene.fog, rememberExplored: v } })}
            />

            <label className="field">
              <span className="label">Escuridao da area lembrada</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={scene.fog.dimOpacity}
                onChange={(e) => patch({ fog: { ...scene.fog, dimOpacity: Number(e.target.value) } })}
              />
            </label>

            <label className="field">
              <span className="label">Borda da neblina</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={scene.fog.edgeSoftness}
                onChange={(e) => patch({ fog: { ...scene.fog, edgeSoftness: Number(e.target.value) } })}
              />
            </label>
            <span className="hint">
              Em zero, a neblina recorta exatamente as celulas e a grade aparece na silhueta. Subindo,
              a borda vira nuvem — mais bonito, mas a transicao suave revela um pouco alem do limite
              exato das celulas.
            </span>

            <div className="row wrap">
              <button
                className="btn sm"
                onClick={() => void act('fog:reset', { sceneId: scene.id, scope: 'explored' })}
              >
                Reencobrir explorado
              </button>
              <button
                className="btn sm"
                onClick={() => void act('fog:reset', { sceneId: scene.id, scope: 'revealed' })}
              >
                Limpar revelado
              </button>
              <button
                className="btn sm danger"
                onClick={() => void act('fog:reset', { sceneId: scene.id, scope: 'all' })}
              >
                Zerar tudo
              </button>
            </div>
          </Section>

          <Section title="Iluminacao">
            <label className="field">
              <span className="label">Luz do ambiente</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={scene.globalLight}
                onChange={(e) => patch({ globalLight: Number(e.target.value) })}
              />
            </label>
            <span className="hint">
              Em 1, quem tem linha de visao enxerga longe. Em 0, so o raio de visao e as fontes de
              luz dos tokens iluminam — a diferenca entre um campo aberto ao meio-dia e uma masmorra.
            </span>
          </Section>

          <Section title="Paredes">
            <div className="row">
              <span className="hint" style={{ flex: 1 }}>
                {scene.walls.length} parede(s) nesta cena.
              </span>
              {scene.walls.length > 0 && (
                <button
                  className="btn ghost sm danger"
                  onClick={() => {
                    if (!window.confirm('Remover todas as paredes desta cena?')) return;
                    for (const wall of scene.walls) {
                      void act('wall:delete', { sceneId: scene.id, wallId: wall.id });
                    }
                  }}
                >
                  Remover todas
                </button>
              )}
            </div>

            <div className="list">
              {scene.walls
                .filter((w) => w.door)
                .map((wall) => (
                  <div key={wall.id} className="item">
                    <span className="name">Porta {wall.hidden ? '(secreta)' : ''}</span>
                    <button
                      className="btn sm"
                      onClick={() =>
                        void act('wall:update', {
                          sceneId: scene.id,
                          wallId: wall.id,
                          patch: { open: !wall.open },
                        })
                      }
                    >
                      {wall.open ? 'Fechar' : 'Abrir'}
                    </button>
                    <button
                      className="btn ghost sm"
                      onClick={() => void act('wall:delete', { sceneId: scene.id, wallId: wall.id })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
            <span className="hint">
              Use a ferramenta de parede no trilho a esquerda. Segure Alt ao desenhar para criar
              uma porta.
            </span>
          </Section>
        </>
      )}
    </>
  );
}
