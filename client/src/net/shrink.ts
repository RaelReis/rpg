import { MAX_IMAGE_DIMENSION, UPLOAD_LIMITS, type AssetKind } from '@rpg/shared';

/**
 * Reducao da imagem no navegador, antes do envio.
 *
 * O limite por tipo (5 MB para retrato e corpo inteiro) recusava a foto de
 * celular, que passa disso facil — e a entrada do jogador exige as duas
 * imagens, entao a mesa ficava travada para quem vinha pelo convite. Em vez de
 * pedir que a pessoa reduza a foto em outro programa, a mesa reduz aqui: o
 * limite do servidor continua o mesmo e deixa de ser atrito.
 *
 * So atua quando precisa. Imagem dentro do limite e do lado maximo sobe
 * intacta, sem perder qualidade nem o formato original.
 */

/**
 * Lado maximo por tipo, acima do que a mesa de fato desenha: o retrato vira
 * no maximo um cartao da ficha; o corpo inteiro (tipo `token`) e o token no
 * mapa com zoom alto; o mapa pode ser grande de verdade.
 */
export const MAX_SIDE: Record<AssetKind, number> = {
  map: MAX_IMAGE_DIMENSION,
  card: 4096,
  tile: 4096,
  token: 2048,
  effect: 2048,
  portrait: 1024,
  item: 1600,
  clue: 1600,
};

const QUALITY = 0.85;
/**
 * Rodadas de codificacao. A primeira versao tentava tres qualidades por
 * rodada e encolhia 25% a cada falha: um mapa de 35 MP levava mais de um
 * minuto, porque cada codificacao de imagem desse tamanho custa segundos.
 * Agora a segunda rodada ja mira o limite pela proporcao entre o que saiu e o
 * que cabe, e quase sempre basta.
 */
const MAX_ROUNDS = 4;

/** Dimensoes que cabem em `maxSide`, preservando a proporcao. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A imagem precisa passar pela reducao? */
export function needsShrink(width: number, height: number, bytes: number, kind: AssetKind): boolean {
  return bytes > UPLOAD_LIMITS[kind] || Math.max(width, height) > MAX_SIDE[kind];
}

function isHeic(file: File): boolean {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

export class ShrinkError extends Error {}

/**
 * Devolve o arquivo a enviar: o proprio, se ja estiver dentro das regras, ou
 * uma versao reduzida em WebP. `onShrinking` avisa quando a reducao comeca,
 * para a interface dizer por que o envio esta demorando.
 */
export async function shrinkForUpload(file: File, kind: AssetKind, onShrinking?: () => void): Promise<File> {
  // GIF animado perderia a animacao no canvas: segue como esta, e o limite
  // recusa com a mensagem de sempre se for grande demais.
  if (file.type === 'image/gif') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (isHeic(file)) {
      throw new ShrinkError(
        `Este navegador nao le fotos HEIC ("${file.name}"). Exporte a foto como JPEG e envie de novo.`,
      );
    }
    // Arquivo que o navegador nao decodifica: o servidor responde com o
    // motivo certo (formato nao suportado, arquivo invalido).
    return file;
  }

  try {
    // HEIC decodificado sobe convertido mesmo pequeno: o servidor nao o aceita.
    if (!needsShrink(bitmap.width, bitmap.height, file.size, kind) && !isHeic(file)) return file;
    onShrinking?.();

    const limit = UPLOAD_LIMITS[kind];
    // JPEG de origem nao tem transparencia a preservar, e o navegador codifica
    // JPEG bem mais rapido que WebP em imagem grande.
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    let { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_SIDE[kind]);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const blob = await encode(bitmap, width, height, type);
      if (blob.size <= limit) return new File([blob], renamed(file.name, blob.type), { type: blob.type });
      // O tamanho cresce com a area: a raiz da proporcao da o novo lado, com
      // folga para a proxima tentativa nao passar raspando.
      const scale = Math.sqrt(limit / blob.size) * 0.9;
      ({ width, height } = fitWithin(width, height, Math.floor(Math.max(width, height) * scale)));
    }
    throw new ShrinkError(`Nao foi possivel reduzir "${file.name}" ao limite deste tipo.`);
  } finally {
    bitmap.close();
  }
}

async function encode(bitmap: ImageBitmap, width: number, height: number, type: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ShrinkError('O navegador nao conseguiu processar a imagem.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  // WebP guarda a transparencia do PNG recortado; navegador que nao gera WebP
  // devolve PNG, que nao tem qualidade — por isso o JPEG como segunda opcao.
  if (type === 'image/webp') {
    const webp = await toBlob(canvas, 'image/webp', QUALITY);
    if (webp?.type === 'image/webp') return webp;
  }
  const jpeg = await toBlob(canvas, 'image/jpeg', QUALITY);
  if (!jpeg) throw new ShrinkError('O navegador nao conseguiu processar a imagem.');
  return jpeg;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function renamed(name: string, type: string): string {
  const ext = type === 'image/webp' ? 'webp' : 'jpg';
  return `${name.replace(/\.[^.]*$/, '') || 'imagem'}.${ext}`;
}
