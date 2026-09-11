import { UPLOAD_LIMITS, type Asset, type AssetKind, type Session } from '@rpg/shared';

import { storedSession } from './socket';

/** Chamadas HTTP: as poucas coisas que nao cabem no socket. */

async function parse<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Resposta sem corpo JSON (proxy fora do ar, 502): a mensagem vem do status.
  }
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `Falha na requisicao (${res.status}).`;
    throw new Error(message);
  }
  return body as T;
}

/**
 * Troca o token de sessao por um cookie que autoriza as imagens.
 *
 * As imagens entram na pagina por `<img src>` e por Canvas, que nao mandam
 * cabecalhos — o cookie e o unico jeito de o navegador provar quem esta
 * pedindo, e ele so vale para /uploads.
 */
export async function grantImageAccess(token: string): Promise<void> {
  await fetch('/api/session/image-access', {
    method: 'POST',
    headers: { 'x-session-token': token },
    // A entrada na mesa espera por isto; um servidor lento nao pode prende-la.
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    // Sem isto as imagens nao carregam, mas o resto da mesa funciona: nao vale
    // impedir a entrada por causa da falha.
  });
}

export async function revokeImageAccess(token: string): Promise<void> {
  await fetch('/api/session/image-access', {
    method: 'DELETE',
    headers: { 'x-session-token': token },
  }).catch(() => {});
}

export async function createTable(params: {
  name: string;
  gmName: string;
  gmPassword: string;
}): Promise<Session> {
  const res = await fetch('/api/tables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await parse<{ session: Session }>(res);
  return data.session;
}

export interface TableSummary {
  code: string;
  name: string;
  requiresGmPassword: boolean;
  players: number;
  /** A mesa ja tem mestre: a entrada nao oferece o papel a quem chega. */
  hasGm: boolean;
}

export async function lookupTable(code: string): Promise<TableSummary> {
  const res = await fetch(`/api/tables/${encodeURIComponent(code)}`);
  return parse<TableSummary>(res);
}

export function uploadLimitFor(kind: AssetKind): number {
  return UPLOAD_LIMITS[kind];
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Envia uma imagem. O tamanho e conferido aqui apenas para dar erro imediato:
 * quem realmente valida (tipo, dimensoes e limite por categoria) e o servidor.
 */
export async function uploadAsset(file: File, kind: AssetKind): Promise<Asset> {
  const session = storedSession();
  if (!session) throw new Error('Sessao ausente.');

  const limit = uploadLimitFor(kind);
  if (file.size > limit) {
    throw new Error(
      `"${file.name}" tem ${formatBytes(file.size)}; o limite para este tipo e ${formatBytes(limit)}.`,
    );
  }

  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);

  const res = await fetch('/api/assets', {
    method: 'POST',
    headers: { 'x-session-token': session.token },
    body: form,
  });
  const data = await parse<{ asset: Asset }>(res);
  return data.asset;
}

/**
 * Baixa a mesa inteira como arquivo. `withAssets` decide entre um backup de
 * verdade (com as imagens dentro) e um arquivo leve, so com a estrutura.
 */
export async function exportTable(tableId: string, withAssets: boolean): Promise<void> {
  const session = storedSession();
  if (!session) throw new Error('Sessao ausente.');

  const res = await fetch(`/api/tables/${tableId}/export?assets=${withAssets ? '1' : '0'}`, {
    headers: { 'x-session-token': session.token },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Falha ao exportar a mesa.');
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ?? 'mesa.json';
  link.click();
  URL.revokeObjectURL(url);
}

/** Cria uma mesa NOVA a partir de um backup, sem tocar nas existentes. */
export async function importTable(
  backup: unknown,
  gmName: string,
  gmPassword: string,
): Promise<{ session: Session; missingAssets: number }> {
  const res = await fetch('/api/tables/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup, gmName, gmPassword }),
  });
  return parse<{ session: Session; missingAssets: number }>(res);
}
