import type { Trigger } from '@rpg/shared';

import { act } from '../net/socket';
import { useStore } from './store';

/**
 * Criar, editar e apagar gatilhos, com desfazer e refazer do mestre.
 *
 * Mesmo esquema das paredes: recriar muda o id, entao quem monta a entrada
 * guarda o id vivo numa variavel que o desfazer e o refazer compartilham. O
 * DISPARO de um gatilho nunca passa por aqui — ele aconteceu na mesa, e
 * Ctrl+Z nao desfaz o susto de ninguem.
 */

type TriggerDraft = Omit<Trigger, 'id'>;

function withoutId(trigger: Trigger): TriggerDraft {
  const { id: _omit, ...rest } = trigger;
  void _omit;
  return rest;
}

export async function createTriggerWithUndo(sceneId: string, draft: Partial<Trigger>): Promise<Trigger | null> {
  let triggerId: string | null = null;
  const create = async () => {
    const created = await act<Trigger>('trigger:create', { sceneId, trigger: draft });
    triggerId = created?.id ?? null;
    return created;
  };

  const created = await create();
  if (!created) return null;
  const store = useStore.getState();
  store.selectTrigger(created.id);
  store.pushUndo({
    label: `criar gatilho "${created.name}"`,
    undo: () => {
      if (triggerId) void act('trigger:delete', { sceneId, triggerId });
    },
    redo: async () => {
      const again = await create();
      if (again) useStore.getState().selectTrigger(again.id);
    },
  });
  return created;
}

/**
 * Edita um gatilho e registra o caminho de volta com os valores anteriores dos
 * campos tocados. Quem chama manda o gatilho como estava ANTES da edicao.
 */
export function updateTriggerWithUndo(
  sceneId: string,
  before: Trigger,
  patch: Partial<Trigger>,
  label = 'editar gatilho',
): void {
  const previous: Partial<Trigger> = {};
  for (const key of Object.keys(patch) as (keyof Trigger)[]) {
    (previous as Record<string, unknown>)[key] = before[key];
  }

  // Edicoes seguintes do mesmo gatilho miram o id vivo, que muda se ele for
  // apagado e recriado pelo desfazer de outra acao.
  const apply = (p: Partial<Trigger>) => void act('trigger:update', { sceneId, triggerId: before.id, patch: p });
  apply(patch);
  useStore.getState().pushUndo({ label, undo: () => apply(previous), redo: () => apply(patch) });
}

export function deleteTriggerWithUndo(sceneId: string, trigger: Trigger): void {
  let triggerId: string | null = trigger.id;
  const shape = withoutId(trigger);

  const remove = () => {
    if (triggerId) void act('trigger:delete', { sceneId, triggerId });
  };

  remove();
  const store = useStore.getState();
  if (store.selectedTriggerId === trigger.id) store.selectTrigger(null);
  store.pushUndo({
    label: `excluir gatilho "${trigger.name}"`,
    undo: async () => {
      const created = await act<Trigger>('trigger:create', { sceneId, trigger: shape });
      triggerId = created?.id ?? null;
      if (created) useStore.getState().selectTrigger(created.id);
    },
    redo: remove,
  });
}
