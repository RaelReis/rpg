/**
 * Cache de imagens do mapa.
 *
 * O canvas redesenha a cada quadro e nao pode esperar por I/O: `getImage`
 * devolve a imagem se ja estiver carregada e, se nao, dispara o carregamento
 * e devolve null. Quando a imagem chega, avisamos o renderizador para pedir
 * um novo quadro — assim o mapa "aparece" sozinho sem loop de polling.
 */

type Status = 'loading' | 'ready' | 'error';

interface Entry {
  status: Status;
  image: HTMLImageElement;
  /** Tentativas que ja falharam, para espacar a proxima. */
  failures: number;
  /** Antes disto, um erro continua valendo e nao dispara nova tentativa. */
  retryAt: number;
  lastUsed: number;
}

/**
 * Espera entre tentativas: 1s, 2s, 4s... ate 30s.
 *
 * O erro era definitivo: uma unica falha deixava a imagem em branco ate
 * recarregar a pagina. E falhas passageiras sao comuns aqui — o cookie de
 * acesso ainda a caminho na entrada, uma oscilacao do tunnel, o servidor
 * reiniciando. Tentar de novo com espera crescente cobre todas sem martelar
 * o servidor quando o arquivo realmente nao existe.
 */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

const cache = new Map<string, Entry>();
let lastPruned = 0;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const listeners = new Set<() => void>();

/** Avisa quando uma imagem nova termina de carregar. */
export function onImageReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(): void {
  for (const fn of listeners) fn();
}

function load(url: string, entry: Entry): void {
  const image = new Image();
  entry.image = image;
  entry.status = 'loading';

  image.onload = () => {
    if (cache.get(url) !== entry) return;
    entry.status = 'ready';
    entry.failures = 0;
    announce();
  };
  image.onerror = () => {
    if (cache.get(url) !== entry) return;
    entry.status = 'error';
    entry.failures += 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (entry.failures - 1));
    entry.retryAt = Date.now() + delay;
    // O renderizador so chama `getImage` quando desenha, e com a mesa parada
    // ele nao desenha. Sem este aviso a nova tentativa nunca aconteceria.
    setTimeout(announce, delay);
  };
  image.src = url;
}

export function getImage(url: string | null | undefined): HTMLImageElement | null {
  if (!url) return null;

  pruneImages();
  const cached = cache.get(url);
  if (cached) {
    cached.lastUsed = Date.now();
    if (cached.status === 'ready') return cached.image;
    if (cached.status === 'error' && Date.now() >= cached.retryAt) load(url, cached);
    return null;
  }

  const entry: Entry = { status: 'loading', image: new Image(), failures: 0, retryAt: 0, lastUsed: Date.now() };
  cache.set(url, entry);
  load(url, entry);
  return null;
}

export function isLoading(url: string | null | undefined): boolean {
  if (!url) return false;
  return cache.get(url)?.status === 'loading';
}

/** Descarta uma imagem removida da mesa, para nao segurar memoria a toa. */
export function forgetImage(url: string): void {
  const entry = cache.get(url);
  if (entry) { entry.image.onload = null; entry.image.onerror = null; }
  cache.delete(url);
}

export function clearImages(): void { for (const url of cache.keys()) forgetImage(url); }
function pruneImages(): void {
  const now = Date.now(); if (now - lastPruned < 1000) return; lastPruned = now;
  const sorted = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const size = (entry: Entry) => entry.image.naturalWidth * entry.image.naturalHeight * 4;
  let bytes = sorted.reduce((total, [, entry]) => total + size(entry), 0);
  for (const [url, entry] of sorted) {
    // Keep the current frame's working set; evict old scenes first.
    if (now - entry.lastUsed < 2000) continue;
    if (bytes > MAX_DECODED_BYTES || cache.size > 200 || now - entry.lastUsed > 60000) {
      bytes -= size(entry); forgetImage(url);
    }
  }
}
