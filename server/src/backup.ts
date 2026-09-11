import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createDefaultTemplate,
  DEFAULT_INITIATIVE,
  DEFAULT_SETTINGS,
  createScene,
  generateId,
  normalizeTemplate,
  type Handout,
  type Scene,
  type Sheet,
  type TableState,
} from '@rpg/shared';

import { fromJson, prisma, toJson } from './db.js';
import { UPLOAD_DIR } from './env.js';
import { rooms, type Room } from './room.js';
import { saveImage } from './uploads.js';

/**
 * Backup da mesa em um arquivo.
 *
 * O banco e a pasta de uploads sao o backup real, mas dependem de acesso ao
 * servidor. Este formato existe para o mestre levar a campanha embora: cenas,
 * fichas, materiais, paredes e neblina num JSON so, com as imagens embutidas.
 *
 * O que deliberadamente NAO entra: hashes de sessao e a senha de mestre. Um
 * backup circula por e-mail e drive; se carregasse credenciais, quem o
 * recebesse assumiria a mesa original. Os jogadores voltam como nomes, e
 * entram de novo pelo codigo.
 */

export const BACKUP_FORMAT = 1;

/** Acima disto o JSON com imagens fica impraticavel de gerar e de abrir. */
const MAX_EMBEDDED_BYTES = 120 * 1024 * 1024;

interface BackupAsset {
  id: string;
  kind: string;
  originalName: string;
  mime: string;
  width: number;
  height: number;
  /** Conteudo em base64; ausente quando o backup foi gerado sem imagens. */
  data?: string;
}

export interface TableBackup {
  format: number;
  exportedAt: number;
  name: string;
  settings: TableState['settings'];
  sheetTemplate: TableState['sheetTemplate'];
  initiative: TableState['initiative'];
  handouts: Handout[];
  scenes: Scene[];
  sheets: Sheet[];
  /** Apenas para reconstruir a autoria; sem credenciais. */
  players: { id: string; name: string; color: string; role: string }[];
  assets: BackupAsset[];
  assetsEmbedded: boolean;
}

export async function exportTable(room: Room, includeAssets: boolean): Promise<TableBackup> {
  const s = room.state;

  const rows = await prisma.asset.findMany({ where: { tableId: s.id } });
  const totalBytes = rows.reduce((sum, a) => sum + a.size, 0);
  const embed = includeAssets && totalBytes <= MAX_EMBEDDED_BYTES;

  const assets: BackupAsset[] = [];
  for (const row of rows) {
    const entry: BackupAsset = {
      id: row.id,
      kind: row.kind,
      originalName: row.originalName,
      mime: row.mime,
      width: row.width,
      height: row.height,
    };

    if (embed) {
      try {
        const buffer = await fs.readFile(path.join(UPLOAD_DIR, row.filename));
        entry.data = buffer.toString('base64');
      } catch {
        // Arquivo sumiu do disco: o backup segue sem ele, e a referencia
        // apenas ficara vazia na importacao.
      }
    }
    assets.push(entry);
  }

  return {
    format: BACKUP_FORMAT,
    exportedAt: Date.now(),
    name: s.name,
    settings: s.settings,
    sheetTemplate: s.sheetTemplate,
    initiative: s.initiative,
    handouts: s.handouts,
    scenes: s.scenes,
    sheets: s.sheets,
    players: s.players.map((p) => ({ id: p.id, name: p.name, color: p.color, role: p.role })),
    assets,
    assetsEmbedded: embed,
  };
}

export class BackupError extends Error {}

/**
 * Recria a mesa a partir de um backup, sempre como uma mesa NOVA.
 *
 * Importar por cima de uma mesa existente destruiria o que estivesse la sem
 * possibilidade de volta; criar ao lado deixa a comparacao e o descarte nas
 * maos de quem importou.
 */
export async function importTable(
  backup: Partial<TableBackup>,
  gmName: string,
  gmPassword: string,
): Promise<{ room: Room; gmToken: string; gmPlayerId: string; missingAssets: number }> {
  if (!backup || typeof backup !== 'object') throw new BackupError('Arquivo vazio ou ilegivel.');
  if (backup.format !== BACKUP_FORMAT) {
    throw new BackupError(`Formato de backup incompativel (esperado ${BACKUP_FORMAT}).`);
  }
  if (!Array.isArray(backup.scenes) || backup.scenes.length === 0) {
    throw new BackupError('O backup nao contem nenhuma cena.');
  }

  const created = await rooms.createTable({
    name: `${backup.name ?? 'Mesa importada'}`.slice(0, 80),
    gmName,
    gmPassword,
  });
  const room = created.room;

  try {
    return await buildImportedTable(backup, created);
  } catch (err) {
    // A mesa ja existe no banco a esta altura. Deixar o que sobrou seria pior
    // que nao ter importado: o mestre veria uma mesa aparentemente pronta,
    // sem metade das cenas. Desfaz tudo — linhas por cascade, arquivos a mao.
    await discardImported(room.state.id, room.state.assets);
    throw err;
  }
}

/** Remove a mesa e as imagens ja gravadas por uma importacao que falhou. */
async function discardImported(tableId: string, assets: { url: string; thumbUrl: string | null }[]): Promise<void> {
  const files = assets.flatMap((a) =>
    [a.url, a.thumbUrl].filter((u): u is string => Boolean(u)).map((u) => u.replace(/^\/uploads\//, '')),
  );

  await Promise.all(
    files.map((f) => fs.rm(path.join(UPLOAD_DIR, f), { force: true }).catch(() => {})),
  );
  await rooms.discard(tableId).catch((err) => {
    console.error('[backup] falha ao desfazer importacao:', err);
  });
}

/**
 * Reconstroi a mesa a partir do backup. Separado de `importTable` para que
 * qualquer erro daqui para baixo caia no compensador acima.
 */
async function buildImportedTable(
  backup: Partial<TableBackup>,
  created: { room: Room; gmToken: string; gmPlayerId: string },
): Promise<{ room: Room; gmToken: string; gmPlayerId: string; missingAssets: number }> {
  const room = created.room;

  // As imagens sao regravadas e ganham ids novos; tudo que apontava para elas
  // precisa ser reescrito, senao a mesa importada volta sem arte nenhuma.
  const idMap = new Map<string, string>();
  let missingAssets = 0;

  for (const asset of backup.assets ?? []) {
    if (!asset?.data) {
      missingAssets++;
      continue;
    }
    try {
      const saved = await saveImage({
        buffer: Buffer.from(asset.data, 'base64'),
        kind: (asset.kind as never) ?? 'token',
        tableId: room.state.id,
        originalName: asset.originalName ?? 'imagem',
        uploadedBy: created.gmPlayerId,
      });
      idMap.set(asset.id, saved.id);
      room.state.assets.push(saved);
    } catch {
      missingAssets++;
    }
  }

  const remap = (id: string | null | undefined): string | null => {
    if (!id) return null;
    return idMap.get(id) ?? null;
  };

  // Cenas: a primeira do backup vira a ativa.
  room.state.scenes = (backup.scenes ?? []).map((raw, index) => {
    const scene = createScene({ ...raw, id: generateId('scn'), order: index });
    scene.backgroundAssetId = remap(raw.backgroundAssetId);
    scene.tokens = scene.tokens.map((t) => ({ ...t, assetId: remap(t.assetId) }));
    scene.tiles = scene.tiles.map((t) => ({ ...t, assetId: remap(t.assetId) }));
    scene.effects = scene.effects.map((e) => ({ ...e, assetId: remap(e.assetId) }));
    return scene;
  });
  room.state.activeSceneId = room.state.scenes[0]?.id ?? null;

  room.state.sheetTemplate = normalizeTemplate(backup.sheetTemplate ?? createDefaultTemplate());
  room.state.settings = { ...DEFAULT_SETTINGS, ...(backup.settings ?? {}) };
  room.state.initiative = { ...DEFAULT_INITIATIVE, ...(backup.initiative ?? {}) };

  room.state.handouts = (backup.handouts ?? []).map((h) => ({
    ...h,
    id: generateId('hnd'),
    assetId: remap(h.assetId),
    // Os jogadores do backup nao existem nesta mesa; o acesso recomeca do zero.
    sharedWith: [],
    sharedWithAll: false,
  }));

  // As fichas chegam sem dono: os jogadores entrarao com identidades novas, e
  // o mestre reatribui pela aba Fichas.
  room.state.sheets = (backup.sheets ?? []).map((sheet) => ({
    ...sheet,
    id: generateId('sht'),
    ownerPlayerId: null,
    portraitAssetId: remap(sheet.portraitAssetId),
  }));

  // Em uma transacao: ou a mesa importada tem todas as fichas do backup, ou
  // nao tem nenhuma e o compensador apaga a mesa inteira. Meio-termo aqui
  // significa uma ficha faltando que ninguem nota ate precisar dela.
  if (room.state.sheets.length > 0) {
    await prisma.$transaction(
      room.state.sheets.map((sheet) =>
        prisma.sheet.create({
          data: {
            id: sheet.id,
            tableId: room.state.id,
            name: sheet.name,
            ownerPlayerId: null,
            portraitAssetId: sheet.portraitAssetId,
            values: toJson(sheet.values),
            sharedWithParty: sheet.sharedWithParty,
          },
        }),
      ),
    );
  }

  // Os tokens perdem o dono junto com as fichas, e o vinculo de ficha e
  // refeito por indice, que e a unica correspondencia que sobrevive aos ids.
  const sheetByOldId = new Map<string, string>();
  (backup.sheets ?? []).forEach((old, i) => {
    const fresh = room.state.sheets[i];
    if (old?.id && fresh) sheetByOldId.set(old.id, fresh.id);
  });

  for (const scene of room.state.scenes) {
    scene.tokens = scene.tokens.map((t) => ({
      ...t,
      ownerPlayerId: null,
      sheetId: t.sheetId ? (sheetByOldId.get(t.sheetId) ?? null) : null,
    }));
    room.touchScene(scene.id);
  }

  room.touch('table');
  room.touch('sheets');
  await room.flush();

  return {
    room,
    gmToken: created.gmToken,
    gmPlayerId: created.gmPlayerId,
    missingAssets,
  };
}

/** Lê um backup vindo do corpo da requisicao, com mensagem util em caso de erro. */
export function parseBackup(raw: unknown): Partial<TableBackup> {
  if (typeof raw === 'string') return fromJson<Partial<TableBackup>>(raw, {});
  if (raw && typeof raw === 'object') return raw as Partial<TableBackup>;
  throw new BackupError('Nao foi possivel ler o arquivo de backup.');
}
