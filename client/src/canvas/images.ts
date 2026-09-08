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
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

/** Avisa quando uma imagem nova termina de carregar. */
export function onImageReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(): void {
  for (const fn of listeners) fn();
}

export function getImage(url: string | null | undefined): HTMLImageElement | null {
  if (!url) return null;

  const cached = cache.get(url);
  if (cached) return cached.status === 'ready' ? cached.image : null;

  const image = new Image();
  const entry: Entry = { status: 'loading', image };
  cache.set(url, entry);

  image.onload = () => {
    entry.status = 'ready';
    announce();
  };
  image.onerror = () => {
    entry.status = 'error';
  };
  image.src = url;

  return null;
}

export function isLoading(url: string | null | undefined): boolean {
  if (!url) return false;
  return cache.get(url)?.status === 'loading';
}

/** Descarta uma imagem removida da mesa, para nao segurar memoria a toa. */
export function forgetImage(url: string): void {
  cache.delete(url);
}
