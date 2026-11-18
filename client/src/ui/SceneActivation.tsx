import { useState } from 'react';
import type { TableState } from '@rpg/shared';

import { act } from '../net/socket';
import { useStore } from '../state/store';
import { Modal } from './common';

/**
 * Ativar uma cena, perguntando antes quando ha o que perguntar.
 *
 * Duas coisas pedem confirmacao: jogadores conectados (a troca e para todos,
 * agora) e personagens que nao estao na cena nova. Antes a cena trocava e o
 * grupo caia num mapa sem peca nenhuma; agora a janela oferece levar o grupo,
 * marcado por padrao — desmarcado para um sonho ou flashback sem ele. Sem
 * nada a perguntar (mesa vazia e todos ja na cena), ativa direto.
 */

/** Personagens de jogador que ainda nao tem token na cena. */
function missingParty(table: TableState, sceneId: string): string[] {
  const scene = table.scenes.find((s) => s.id === sceneId);
  if (!scene) return [];
  return table.sheets
    .filter((sheet) => table.players.some((p) => p.id === sheet.ownerPlayerId && p.role === 'PLAYER'))
    .filter((sheet) => !scene.tokens.some((t) => t.sheetId === sheet.id))
    .map((sheet) => sheet.name);
}

function watching(table: TableState): boolean {
  return table.players.some((p) => p.role === 'PLAYER' && p.connected);
}

/** Chamado pelos botoes de ativar: pergunta, ou ativa direto se nao ha o que perguntar. */
export function requestSceneActivation(sceneId: string): void {
  const table = useStore.getState().table;
  if (!table) return;
  if (!watching(table) && missingParty(table, sceneId).length === 0) {
    void act('scene:activate', { sceneId });
    return;
  }
  useStore.getState().askSceneActivation(sceneId);
}

export function SceneActivationDialog(): JSX.Element | null {
  const sceneId = useStore((s) => s.sceneActivationId);
  const table = useStore((s) => s.table);
  const ask = useStore((s) => s.askSceneActivation);
  const [bringParty, setBringParty] = useState(true);

  if (!sceneId || !table) return null;
  const scene = table.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;

  const missing = missingParty(table, sceneId);
  const close = () => {
    ask(null);
    setBringParty(true);
  };
  const activate = () => {
    void act('scene:activate', { sceneId, bringParty: missing.length > 0 && bringParty });
    close();
  };

  return (
    <Modal
      title="Ativar cena"
      onClose={close}
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            Cancelar
          </button>
          <div className="spacer" />
          <button className="btn primary" onClick={activate}>
            Ativar
          </button>
        </>
      }
    >
      <p>
        {watching(table)
          ? `Ativar "${scene.name}" para todos os jogadores conectados agora?`
          : `Ativar "${scene.name}"?`}
      </p>
      {missing.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={bringParty} onChange={(e) => setBringParty(e.target.checked)} />
          <span>
            Levar o grupo para esta cena
            <small>
              {missing.join(', ')} {missing.length === 1 ? 'ainda nao esta' : 'ainda nao estao'} nesta cena e
              {missing.length === 1 ? ' entra' : ' entram'} no centro do mapa. Desmarque para uma cena sem o grupo,
              como um sonho ou um flashback.
            </small>
          </span>
        </label>
      )}
    </Modal>
  );
}
