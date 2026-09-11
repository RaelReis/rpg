import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

/**
 * Prepara o SQLite para varias mesas gravando ao mesmo tempo.
 *
 * No modo padrao (rollback journal) um escritor bloqueia todos os leitores, e
 * duas mesas ativas ja bastam para produzir SQLITE_BUSY. Com WAL, leitura e
 * escrita deixam de disputar, e `busy_timeout` faz o driver esperar em vez de
 * falhar de imediato quando dois flushes se cruzam.
 *
 * WAL fica gravado no cabecalho do arquivo e vale para as conexoes seguintes;
 * `busy_timeout` e por conexao e por isso e reaplicado a cada arranque.
 */
export async function configureSqlite(): Promise<void> {
  // `$queryRawUnsafe`, e nao `$executeRawUnsafe`: estes PRAGMAs devolvem uma
  // linha, e o execute do Prisma rejeita qualquer resultado no SQLite. Com
  // execute, o WAL chegava a ser gravado antes do erro, mas a excecao abortava
  // o bloco e busy_timeout e synchronous nunca eram aplicados.
  const pragmas = ['journal_mode = WAL', 'busy_timeout = 5000', 'synchronous = NORMAL'];
  for (const pragma of pragmas) {
    try {
      await prisma.$queryRawUnsafe(`PRAGMA ${pragma};`);
    } catch (err) {
      // Um PRAGMA recusado nao deve impedir os outros.
      console.warn(`[db] PRAGMA ${pragma} nao aplicado:`, err);
    }
  }
}

/** `true` para o erro de banco ocupado, que vale a pena repetir. */
function isBusy(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}` : String(err);
  return /SQLITE_BUSY|database is locked/i.test(text);
}

/**
 * Repete uma gravacao que falhou por contencao.
 *
 * Antes, uma falha destas era apenas registrada no console: a mesa seguia em
 * memoria e aquela gravacao se perdia em silencio. Repetir cobre a janela
 * curta em que outro flush segurava o arquivo.
 */
export async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await operation();
    } catch (err) {
      if (!isBusy(err)) throw err;
      lastError = err;
      // Espera crescente: 50ms, 150ms, 350ms.
      await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** i - 1) + 50));
    }
  }
  throw lastError;
}

/** Helpers de (de)serializacao dos blobs JSON do SQLite. */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
