import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import type { Metadata } from 'sharp';
import {
  ALLOWED_IMAGE_MIMES,
  generateId,
  MAX_IMAGE_DIMENSION,
  UPLOAD_LIMITS,
  type Asset,
  type AssetKind,
} from '@rpg/shared';

import { prisma } from './db.js';
import { UPLOAD_DIR } from './env.js';

/**
 * Armazenamento de imagens em disco.
 *
 * O arquivo enviado nunca e confiado pelo nome: o formato real e detectado
 * decodificando os bytes com o sharp, e a extensao gravada vem dessa deteccao.
 * Isso impede que um `.png` que na verdade e outra coisa seja servido de volta
 * com um content-type enganoso.
 */

const KIND_TO_EXT: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
};

const FORMAT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

export const ASSET_KINDS: AssetKind[] = ['map', 'token', 'portrait', 'item', 'effect', 'tile'];

export function isAssetKind(v: string): v is AssetKind {
  return (ASSET_KINDS as string[]).includes(v);
}

export function limitFor(kind: AssetKind): number {
  return UPLOAD_LIMITS[kind];
}

export function assetUrl(filename: string): string {
  return `/uploads/${filename}`;
}

export class UploadError extends Error {}

/** Thumbnails mantem a lista de assets leve mesmo com mapas de 20MB. */
const THUMB_SIZE = 320;

export interface SaveImageParams {
  buffer: Buffer;
  kind: AssetKind;
  tableId: string;
  originalName: string;
  uploadedBy: string | null;
}

export async function saveImage(params: SaveImageParams): Promise<Asset> {
  const { buffer, kind, tableId, uploadedBy } = params;

  if (buffer.length > limitFor(kind)) {
    throw new UploadError(
      `Arquivo acima do limite para ${kind} (${formatBytes(limitFor(kind))}).`,
    );
  }

  let meta: Metadata;
  try {
    meta = await sharp(buffer, { animated: true }).metadata();
  } catch {
    throw new UploadError('Arquivo nao e uma imagem valida.');
  }

  const format = meta.format ?? '';
  const mime = FORMAT_TO_MIME[format];
  if (!mime || !(ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)) {
    throw new UploadError(
      `Formato ${format || 'desconhecido'} nao suportado. Use PNG, JPEG, WebP, GIF ou AVIF.`,
    );
  }

  const width = meta.width ?? 0;
  // Em GIF/WebP animado o `height` do sharp cobre todos os quadros empilhados.
  const height = meta.pageHeight ?? meta.height ?? 0;
  if (width <= 0 || height <= 0) throw new UploadError('Nao foi possivel ler as dimensoes da imagem.');
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new UploadError(
      `Imagem grande demais (${width}x${height}). Maximo ${MAX_IMAGE_DIMENSION}px por lado.`,
    );
  }

  const id = generateId('ast');
  const ext = KIND_TO_EXT[format] ?? 'bin';
  const filename = `${id}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), buffer);

  let thumbFilename: string | null = null;
  try {
    thumbFilename = `${id}.webp`;
    const thumb = await sharp(buffer)
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    await fs.writeFile(path.join(UPLOAD_DIR, 'thumbs', thumbFilename), thumb);
  } catch {
    // Sem thumbnail o cliente cai para a imagem cheia; nao vale abortar o upload.
    thumbFilename = null;
  }

  const row = await prisma.asset.create({
    data: {
      id,
      tableId,
      kind,
      filename,
      thumbFilename,
      originalName: params.originalName.slice(0, 200),
      mime,
      size: buffer.length,
      width,
      height,
      uploadedBy,
    },
  });

  return {
    id: row.id,
    kind,
    url: assetUrl(filename),
    thumbUrl: thumbFilename ? assetUrl(`thumbs/${thumbFilename}`) : null,
    originalName: row.originalName,
    mime,
    size: row.size,
    width,
    height,
    createdAt: row.createdAt.getTime(),
    uploadedBy,
  };
}

export async function deleteAssetFiles(assetId: string): Promise<void> {
  const row = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!row) return;

  await fs.rm(path.join(UPLOAD_DIR, row.filename), { force: true });
  if (row.thumbFilename) {
    await fs.rm(path.join(UPLOAD_DIR, 'thumbs', row.thumbFilename), { force: true });
  }
  await prisma.asset.deleteMany({ where: { id: assetId } });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
