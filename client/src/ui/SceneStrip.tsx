import { useState } from 'react';
import type { Scene } from '@rpg/shared';

import type { TableState } from '@rpg/shared';

import { act } from '../net/socket';
import { findAsset, isGm, useStore } from '../state/store';
import { requestSceneActivation } from './SceneActivation';
import { Icon } from './icons';

/**
 * Tira de cenas.
 *
 * Trocar de cena era so pela aba Cena, no painel — abrir a aba, achar a cena
 * na lista, clicar. No meio de uma sessao isso acontece o tempo todo (a
 * cripta, o patio, de volta ao salao), entao a tira fica no cabecalho, onde
 * a mesa ja olha o tempo todo, com a miniatura de cada cena a vista.
 *
 * Comeca fechada: e util para trocar de cena ao vivo, mas quem prepara a
 * mesa sozinho, antes de todo mundo entrar, nao precisa dela — so o
 * cabecalho comendo altura de tela numa janela que ja e curta.
 *
 * So o mestre ve: e ele quem administra cenas, e o jogador nunca escolhe uma.
 */

const OPEN_KEY = 'rpg-vtt:scene-strip-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Acima disto, o resto vira um contador que abre a aba Cena. */
const MAX_SCENES = 6;

export function SceneStrip(): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const gm = useStore(isGm);
  const setSideTab = useStore((s) => s.setSideTab);
  const setEditingScene = useStore((s) => s.setEditingScene);
  const mapSceneId = useStore((s) => s.mapSceneId);
  const [open, setOpen] = useState(readOpen);

  void rev;
  if (!table || !gm) return null;

  const scenes = table.scenes.slice().sort((a, b) => a.order - b.order);
  const shown = scenes.slice(0, MAX_SCENES);
  const overflow = scenes.slice(MAX_SCENES);
  const active = scenes.find((s) => s.id === table.activeSceneId) ?? null;

  function toggle(): void {
    setOpen((was) => {
      const next = !was;
      try {
        localStorage.setItem(OPEN_KEY, next ? '1' : '0');
      } catch {
        // Sem storage, a escolha dura so a aba.
      }
      return next;
    });
  }

  return (
    <div className={`scene-strip${open ? '' : ' collapsed'}`}>
      <button type="button" className="scene-strip-toggle" onClick={toggle} aria-expanded={open}>
        <Icon name={open ? 'expand' : 'collapsed'} size="sm" />
        Cenas
        {!open && active && (
          // Com o mestre montando outra cena no mapa, o nome sozinho parecia
          // dizer que o mapa mostrava esta; o "no ar" desfaz a ambiguidade.
          <span className="scene-strip-current">
            · {mapSceneId && mapSceneId !== active.id ? `no ar: ${active.name}` : active.name}
          </span>
        )}
      </button>

      {open && (
        <>
          {shown.map((scene) => (
            <SceneCard key={scene.id} scene={scene} table={table} active={scene.id === table.activeSceneId} />
          ))}

          {overflow.length > 0 && (
            <button
              type="button"
              className="scene-strip-more"
              onClick={() => setSideTab('scene')}
              title={overflow.map((s) => s.name).join(', ')}
            >
              +{overflow.length}
            </button>
          )}

          <button
            type="button"
            className="scene-strip-add"
            onClick={() =>
              void act<Scene>('scene:create', { name: 'Nova cena' }).then((created) => {
                if (!created) return;
                setEditingScene(created.id);
                setSideTab('scene');
              })
            }
            title="Nova cena"
            aria-label="Nova cena"
          >
            <Icon name="add" size="sm" />
          </button>
        </>
      )}
    </div>
  );
}

function SceneCard({
  scene,
  active,
  table,
}: {
  scene: Scene;
  active: boolean;
  table: TableState;
}): JSX.Element {
  const asset = findAsset(scene.backgroundAssetId);
  const thumb = asset?.thumbUrl ?? asset?.url ?? null;

  return (
    <button
      type="button"
      className={`scene-strip-item${active ? ' active' : ''}`}
      onClick={() => {
        if (active) return;
        requestSceneActivation(scene.id);
      }}
      title={active ? `${scene.name} — no ar` : `Ativar "${scene.name}" para todos`}
      aria-pressed={active}
    >
      <span className="scene-thumb" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}>
        {active && <span className="scene-thumb-tag">no ar</span>}
      </span>
      <span className="scene-name">{scene.name}</span>
    </button>
  );
}
