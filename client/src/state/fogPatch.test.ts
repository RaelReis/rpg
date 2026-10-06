import { beforeEach, describe, expect, it } from 'vitest';
import { createScene, type TableState } from '@rpg/shared';

import { useStore } from './store';

/*
 * `fog:patch` com a visao calculada pelo servidor (strictVision). O explorado
 * chega como diferenca: o cliente soma as celulas novas ao que ja tinha, e so
 * substitui a lista quando o servidor a manda inteira.
 */
describe('applyFogPatch: visao calculada', () => {
  const fog = () => useStore.getState().table!.scenes[0].fog;

  beforeEach(() => {
    const scene = createScene({ id: 'scn' });
    scene.fog.computedVisible = ['0,0'];
    scene.fog.computedExplored = ['0,0', '1,0'];
    useStore.setState({ table: { activeSceneId: 'scn', scenes: [scene] } as unknown as TableState });
  });

  it('soma as celulas novas ao explorado e troca o visivel inteiro', () => {
    useStore.getState().applyFogPatch({ sceneId: 'scn', computed: { visible: ['2,0'], exploredAdd: ['2,0'] } });
    expect(fog().computedVisible).toEqual(['2,0']);
    expect(fog().computedExplored).toEqual(['0,0', '1,0', '2,0']);
  });

  it('sem celula nova, a lista explorada continua a mesma', () => {
    const before = fog().computedExplored;
    useStore.getState().applyFogPatch({ sceneId: 'scn', computed: { visible: ['1,0'], exploredAdd: [] } });
    expect(fog().computedVisible).toEqual(['1,0']);
    expect(fog().computedExplored).toBe(before);
  });

  it('lista inteira substitui: e como o explorado encolhe', () => {
    useStore.getState().applyFogPatch({ sceneId: 'scn', computed: { visible: ['1,0'], explored: ['1,0'] } });
    expect(fog().computedExplored).toEqual(['1,0']);
  });

  it('nao toca as listas cruas', () => {
    useStore.getState().applyFogPatch({ sceneId: 'scn', computed: { visible: [], exploredAdd: ['5,5'] } });
    expect(fog().explored).toEqual([]);
    expect(fog().revealed).toEqual([]);
  });
});
