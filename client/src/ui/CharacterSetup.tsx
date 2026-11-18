import { useRef, useState } from 'react';
import type { Asset, AssetKind } from '@rpg/shared';

import { uploadAsset } from '../net/api';
import { Modal } from './common';
import { act, leaveTable, rpc } from '../net/socket';
import { useStore } from '../state/store';
import { Icon, type IconName } from './icons';

/**
 * As duas imagens do personagem, pedidas na entrada da mesa.
 *
 * O jogador chega com uma ficha vazia e uma peca sem arte, e na pratica isso
 * nunca era corrigido: o personagem passava a campanha como um circulo
 * colorido, e os retratos do grupo ficavam com as iniciais. Pedir as imagens
 * agora, uma unica vez, resolve os dois lugares de uma vez — o retrato vai
 * para a ficha, para a lista de presenca e para os retratos do grupo; o corpo
 * inteiro vira a peca no mapa.
 *
 * Por isso a janela nao fecha: sem as duas, nao ha personagem para mostrar. O
 * mestre nao a ve, porque nao tem personagem.
 *
 * Nem X, nem Esc, nem clique fora. Eles chamavam `leaveTable`, e o gesto de
 * "fechar a janela" do novato o tirava da mesa sem aviso, apagando a sessao —
 * ao voltar, ele ganhava um segundo personagem. Sair continua possivel pelo
 * botao do rodape, com confirmacao, como o "Sair" do cabecalho.
 */
export function CharacterSetup(): JSX.Element | null {
  const rev = useStore((s) => s.rev);
  const table = useStore((s) => s.table);
  const session = useStore((s) => s.session);
  const notify = useStore((s) => s.notify);

  const [portrait, setPortrait] = useState<Asset | null>(null);
  const [body, setBody] = useState<Asset | null>(null);
  const [saving, setSaving] = useState(false);

  void rev;
  if (!table || !session || session.role === 'GM') return null;

  const sheet =
    table.sheets.find((s) => s.id === table.players.find(p => p.id === session.playerId)?.sheetId) ??
    table.sheets.find((s) => s.ownerPlayerId === session.playerId) ??
    null;
  if (!sheet) return null;
  if (sheet.portraitAssetId && sheet.bodyAssetId) return null;

  const chosenPortrait = portrait ?? table.assets.find(a => a.id === sheet.portraitAssetId) ?? null;
  const chosenBody = body ?? table.assets.find(a => a.id === sheet.bodyAssetId) ?? null;
  // Na primeira entrada nao ha imagem nenhuma a preservar; o aviso so vale para
  // quem volta com uma das duas ja escolhida.
  const hasSome = Boolean(sheet.portraitAssetId || sheet.bodyAssetId);

  function leave(): void {
    if (window.confirm('Sair da mesa? Voce pode voltar depois pelo mesmo link, com o mesmo nome.')) leaveTable();
  }

  async function confirm(): Promise<void> {
    if (!chosenPortrait || !chosenBody) return;
    setSaving(true);
    try {
      await rpc('character:images', { portraitAssetId: chosenPortrait.id, bodyAssetId: chosenBody.id });
      notify('info', 'Personagem pronto. Bom jogo.');
    } catch (err) { notify('error', (err as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Seu personagem" footer={<>
      <button className="btn ghost" onClick={leave}>Sair da mesa</button>
      <div className="spacer" />
      <button className="btn primary" disabled={!chosenPortrait || !chosenBody || saving} onClick={() => void confirm()}>
        {saving ? 'Salvando...' : 'Entrar na mesa'}
      </button>
    </>}>
      <p className="hint">
        Escolha as imagens de <strong>{sheet.name}</strong>.
        {hasSome && ' As imagens que voce ja tinha escolhido foram mantidas.'} Voce pode trocar as duas
        depois pela ficha.
      </p>
      <div className="pair">
        <Slot kind="portrait" icon="portrait" title="Retrato" hint="O rosto do personagem, para a ficha e o grupo." asset={chosenPortrait} onPick={setPortrait} />
        <Slot kind="token" icon="tile" title="Corpo inteiro" hint="A arte do personagem no mapa. Fundo transparente fica melhor." asset={chosenBody} onPick={setBody} />
      </div>
    </Modal>
  );
}

function Slot({
  kind,
  icon,
  title,
  hint,
  asset,
  onPick,
}: {
  kind: AssetKind;
  icon: IconName;
  title: string;
  hint: string;
  asset: Asset | null;
  onPick: (asset: Asset) => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const notify = useStore((s) => s.notify);

  async function send(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (!file || busy) return;
    setBusy(true);
    try {
      onPick(await uploadAsset(file, kind));
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <section className={`char-slot ${kind === 'portrait' ? 'char-face' : 'char-body'}`}>
      <h4>
        <Icon name={icon} size="sm" className="inline-icon" /> {title}
      </h4>

      <button
        className="preview"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        aria-label={`Escolher imagem: ${title}`}
      >
        {asset ? (
          <img src={asset.url} alt="" draggable={false} />
        ) : (
          <span className="hint">{busy ? 'Enviando...' : 'Clique para escolher'}</span>
        )}
      </button>

      <span className="hint">{hint}</span>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif"
        hidden
        onChange={(e) => void send(e.target.files)}
      />
    </section>
  );
}
