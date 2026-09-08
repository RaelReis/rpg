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
