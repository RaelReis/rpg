import { createScene, createToken, createTile, createEffect, createWall, normalizeTemplate, sanitizeArea, DEFAULT_SETTINGS, MAX_TRIGGER_ACTIONS, UPLOAD_LIMITS } from '@rpg/shared';
import { LIMITS } from './limits.js';
import type { TableBackup } from './backup.js';

type Obj = Record<string, unknown>;

/**
 * Versoes do formato que a importacao abre (ver BACKUP_FORMAT em backup.ts).
 * Mora aqui, e nao em backup.ts, porque backup.ts importa este arquivo.
 */
export const SUPPORTED_BACKUP_FORMATS = [1, 2, 3, 4];

/** Alucinacao: lista de jogadores que percebem o objeto, ou null. */
function visibleTo(v: unknown, path: string): void {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v) || v.length > 50 || v.some((id) => typeof id !== 'string')) invalid(path);
}
function invalid(path: string): never { throw new Error(`Backup invalido: ${path}.`); }
function object(v: unknown, path: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(path);
  return v as Obj;
}
function list(v: unknown, max: number, path: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) invalid(`${path}: limite ${max}`);
  return v;
}
function number(v: unknown, min: number, max: number, path: string): void {
  if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)) invalid(path);
}
function bounds(o: Obj, limits: Record<string, [number, number]>, path: string): void {
  for (const [key, [min, max]] of Object.entries(limits)) number(o[key], min, max, `${path}.${key}`);
}
function enumeration(v: unknown, allowed: readonly unknown[], path: string): void {
  if (v !== undefined && !allowed.includes(v)) invalid(path);
}
/** Validate primitive types against the same defaults used by regular entities. */
function shape(raw: Obj, defaults: object, path: string): void {
  for (const [key, value] of Object.entries(defaults)) {
    const v = raw[key]; if (v === undefined) continue;
    if (key === 'visibleTo') visibleTo(v, `${path}.${key}`);
    else if (value === null) { if (v !== null && typeof v !== 'string' && key !== 'cell') invalid(`${path}.${key}`); }
    else if (Array.isArray(value)) { if (!Array.isArray(v)) invalid(`${path}.${key}`); }
    else if (typeof value !== 'object' && typeof v !== typeof value) invalid(`${path}.${key}`);
  }
}
function unique(items: unknown[], path: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    const id = object(item, path).id;
    if (typeof id !== 'string' || !id || id.length > 100 || ids.has(id)) invalid(`${path}.id`);
    ids.add(id);
  }
}

/** All checks happen before creating rows or decoding embedded images. */
export function validateBackup(raw: unknown): asserts raw is Partial<TableBackup> {
  const backup = object(raw, 'arquivo');
  if (!SUPPORTED_BACKUP_FORMATS.includes(backup.format as number)) invalid('formato');
  let nodes = 0; let textBytes = 0;
  function walk(value: unknown, path: string, depth = 0): void {
    if (++nodes > 1_000_000 || depth > 16) invalid('estrutura muito complexa');
    if (typeof value === 'number' && !Number.isFinite(value)) invalid(path);
    if (typeof value === 'string') {
      textBytes += value.length;
      if (value.length > 20000 || textBytes > 20 * 1024 * 1024) invalid(`${path}: texto muito grande`);
    } else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid(path);
        walk(v, `${path}.${key}`, depth + 1);
      }
    }
  }
  // Embedded bytes have their own budget; do not walk base64 as user text.
  const { assets: rawAssets, ...structure } = backup;
  walk(structure, 'backup');
  const assets = list(rawAssets, LIMITS.assets, 'imagens'); unique(assets, 'imagens');
  let bytes = 0;
  for (const entry of assets) {
    const a = object(entry, 'imagem');
    if (typeof a.kind !== 'string' || !Object.hasOwn(UPLOAD_LIMITS, a.kind)) invalid('tipo de imagem');
    if (a.originalName !== undefined && (typeof a.originalName !== 'string' || a.originalName.length > 200)) invalid('nome de imagem');
    if (a.data !== undefined) {
      if (typeof a.data !== 'string') invalid('imagem base64');
      const size = Math.floor(a.data.length * 3 / 4) - (a.data.endsWith('==') ? 2 : a.data.endsWith('=') ? 1 : 0);
      if (size > UPLOAD_LIMITS[a.kind as keyof typeof UPLOAD_LIMITS]) invalid('imagem acima do limite');
      bytes += size; if (bytes > 120 * 1024 * 1024) invalid('imagens excedem 120 MB');
      if (a.data.length % 4 || /[^a-zA-Z0-9+/=]/.test(a.data)) invalid('imagem base64');
    }
  }
  if (backup.settings !== undefined) shape(object(backup.settings, 'configuracao'), DEFAULT_SETTINGS, 'configuracao');
  const scenes = list(backup.scenes, LIMITS.scenes, 'cenas');
  if (!scenes.length) invalid('sem cenas'); unique(scenes, 'cenas');
  for (const entry of scenes) {
    const scene = object(entry, 'cena'); shape(scene, createScene(), 'cena');
    bounds(scene, { width: [1, 20000], height: [1, 20000], globalLight: [0, 1] }, 'cena');
    if (scene.grid !== undefined) {
      const grid = object(scene.grid, 'grade'); shape(grid, createScene().grid, 'grade');
      bounds(grid, { size: [10, 500], offsetX: [-5000, 5000], offsetY: [-5000, 5000], opacity: [0, 1], unitsPerCell: [0.01, 1000] }, 'grade');
      enumeration(grid.type, ['none', 'square', 'hex-flat', 'hex-pointy'], 'tipo de grade');
    }
    if (scene.fog !== undefined) {
      const fog = object(scene.fog, 'neblina'); shape(fog, createScene().fog, 'neblina');
      enumeration(fog.mode, ['off', 'manual', 'vision'], 'modo de neblina');
      bounds(fog, { dimOpacity: [0, 1], edgeSoftness: [0, 1] }, 'neblina');
      for (const key of ['explored', 'revealed', 'hidden']) {
        if (list(fog[key], 200000, `neblina.${key}`).some(v => typeof v !== 'string' || !/^-?\d+,-?\d+$/.test(v))) invalid(`neblina.${key}`);
      }
      delete fog.computedVisible; delete fog.computedExplored;
    }
    if (scene.weather !== undefined) {
      const weather = object(scene.weather, 'clima');
      enumeration(weather.kind, ['none', 'rain', 'snow', 'fog', 'ash'], 'clima');
      bounds(weather, { intensity: [0, 1], angle: [-80, 80] }, 'clima');
    }
    for (const [key, defaults] of [['tokens', createToken()], ['tiles', createTile()], ['effects', createEffect()], ['walls', createWall()]] as const) {
      const entities = list(scene[key], LIMITS[key], key); unique(entities, key);
      for (const entry of entities) {
        const entity = object(entry, key); shape(entity, defaults, key);
        bounds(entity, { x: [-30000, 30000], y: [-30000, 30000], scale: [0.25, 20], opacity: [0, 1], visionRadius: [0, 40], lightRadius: [0, 40], rotation: [-360, 360], radius: [0, 200], width: [0, 20000], height: [0, 20000], speed: [0, 10], fontSize: [1, 200], spread: [0, 360] }, key);
        enumeration(entity.layer, [1, 2, 3, 4], 'camada');
        enumeration(entity.visibility, ['visible', 'hidden', 'dim'], 'visibilidade');
        enumeration(entity.shape, ['art', 'circle'], 'forma');
        if (key === 'effects') {
          enumeration(entity.kind, ['circle', 'cone', 'rect', 'line', 'text', 'image'], 'efeito');
          enumeration(entity.style, ['flat', 'glow', 'pulse', 'runes', 'vortex', 'mist', 'embers', 'static'], 'estilo');
          enumeration(entity.anchor, ['free', 'grid', 'token'], 'ancora');
          if (entity.cell != null) { const cell = object(entity.cell, 'celula'); if (typeof cell.a !== 'number' || typeof cell.b !== 'number') invalid('celula'); number(cell.a, -10000, 30000, 'celula.a'); number(cell.b, -10000, 30000, 'celula.b'); }
        }
        if (key === 'walls') bounds(entity, { x1: [-30000, 30000], y1: [-30000, 30000], x2: [-30000, 30000], y2: [-30000, 30000] }, 'parede');
        if (key === 'tokens') {
          list(entity.conditions, 30, 'condicoes');
          for (const bar of list(entity.bars, 4, 'barras')) { const b = object(bar, 'barra'); if (typeof b.fieldId !== 'string' || typeof b.color !== 'string') invalid('barra'); }
        }
      }
    }
  }
  const sheets = list(backup.sheets, LIMITS.sheets, 'fichas'); unique(sheets, 'fichas');
  const template = backup.sheetTemplate === undefined ? undefined : object(backup.sheetTemplate, 'modelo');
  if (template) { list(template.fields, 200, 'campos'); list(template.sections, 30, 'secoes'); }
  const fields = normalizeTemplate(template ?? {}).fields;
  for (const field of fields) {
    const value = field.defaultValue;
    if (value == null) continue;
    if (field.type === 'inventory') for (const item of list(value, 200, 'inventario padrao')) object(item, 'item padrao');
    else if (field.type === 'resource') { const r = object(value, 'recurso padrao'); if (typeof r.current !== 'number' || typeof r.max !== 'number') invalid('recurso padrao'); }
    else if (['text', 'longtext', 'select', 'image'].includes(field.type) && typeof value !== 'string') invalid('valor padrao');
    else if (field.type === 'number' && typeof value !== 'number') invalid('valor padrao');
    else if (field.type === 'boolean' && typeof value !== 'boolean') invalid('valor padrao');
    if (field.min !== null && field.max !== null && field.min > field.max) invalid('limites de campo');
  }
  for (const entry of sheets) {
    const sheet = object(entry, 'ficha'); const values = object(sheet.values, 'valores');
    if (typeof sheet.name !== 'string') invalid('nome da ficha');
    for (const field of fields) {
      const value = values[field.id];
      if (value === undefined || value === null) continue;
      if (field.type === 'inventory') for (const item of list(value, 200, 'inventario')) object(item, 'item');
      if (field.type === 'resource') { const resource = object(value, 'recurso'); if (typeof resource.current !== 'number' || typeof resource.max !== 'number') invalid('recurso'); }
    }
  }
  const handouts = list(backup.handouts, 200, 'materiais'); unique(handouts, 'materiais');
  for (const entry of handouts) { const h = object(entry, 'material'); if (typeof h.title !== 'string' || typeof h.text !== 'string') invalid('material'); }
  list(backup.players, LIMITS.players, 'jogadores');
  const sheetIds = new Set(sheets.map(s => (s as Obj).id));
  const assetIds = new Set(assets.map(a => (a as Obj).id));
  const reference = (id: unknown, ids: Set<unknown>, path: string) => { if (id != null && !ids.has(id)) invalid(path); };
  for (const rawScene of scenes) {
    const scene = rawScene as Obj;
    const tokens = list(scene.tokens, LIMITS.tokens, 'tokens');
    const tokenIds = new Set(tokens.map(t => (t as Obj).id));
    reference(scene.backgroundAssetId, assetIds, 'imagem da cena');
    for (const rawToken of tokens) { const t = rawToken as Obj; reference(t.sheetId, sheetIds, 'ficha do token'); reference(t.assetId, assetIds, 'imagem do token'); }
    for (const raw of list(scene.tiles, LIMITS.tiles, 'tiles')) reference((raw as Obj).assetId, assetIds, 'imagem do tile');
    for (const raw of list(scene.effects, LIMITS.effects, 'efeitos')) {
      const e = raw as Obj; reference(e.assetId, assetIds, 'imagem do efeito');
      if (e.anchor === 'token') reference(e.tokenId, tokenIds, 'token do efeito');
    }
  }
  for (const raw of sheets) {
    const sheet = raw as Obj; reference(sheet.portraitAssetId, assetIds, 'retrato'); reference(sheet.bodyAssetId, assetIds, 'corpo');
    for (const field of fields) {
      const value = (sheet.values as Obj)[field.id];
      if (field.type === 'image') reference(value, assetIds, 'imagem da ficha');
      if (field.type === 'inventory' && Array.isArray(value)) for (const item of value) reference(item.assetId, assetIds, 'imagem do item');
    }
  }
  for (const raw of handouts) reference((raw as Obj).assetId, assetIds, 'imagem do material');

  // Formatos 2 a 4: cartelas, gatilhos, registro de disparos e quadro de pistas.
  const cards = list(backup.sceneCards, 100, 'cartelas'); unique(cards, 'cartelas');
  for (const raw of cards) {
    const card = object(raw, 'cartela');
    if (typeof card.title !== 'string') invalid('titulo da cartela');
    reference(card.assetId, assetIds, 'imagem da cartela');
  }
  const cardIds = new Set(cards.map((c) => (c as Obj).id));
  for (const rawScene of scenes) {
    const scene = rawScene as Obj;
    reference(scene.introCardId, cardIds, 'cartela de abertura');
    const triggers = list(scene.triggers, 200, 'gatilhos'); unique(triggers, 'gatilhos');
    for (const raw of triggers) {
      const trigger = object(raw, 'gatilho');
      if (!sanitizeArea(trigger.area)) invalid('area do gatilho');
      for (const action of list(trigger.actions, MAX_TRIGGER_ACTIONS, 'acoes do gatilho')) object(action, 'acao do gatilho');
      list(trigger.tokenIds, 50, 'tokens do gatilho');
    }
  }
  list(backup.triggerLog, 1000, 'registro de disparos');
  if (backup.board !== undefined) {
    const board = object(backup.board, 'quadro');
    const items = list(board.items, 300, 'itens do quadro'); unique(items, 'itens do quadro');
    for (const raw of items) {
      const item = object(raw, 'item do quadro');
      enumeration(item.kind, ['note', 'image', 'handout'], 'tipo de item do quadro');
      reference(item.assetId, assetIds, 'imagem do quadro');
      // Material apagado depois de pregado vira cartao "removido": nao invalida.
      if (item.handoutId != null && typeof item.handoutId !== 'string') invalid('material do quadro');
      number(item.x, -50000, 50000, 'item do quadro.x');
      number(item.y, -50000, 50000, 'item do quadro.y');
    }
    const threads = list(board.threads, 500, 'fios do quadro'); unique(threads, 'fios do quadro');
    const itemIds = new Set(items.map((i) => (i as Obj).id));
    for (const raw of threads) {
      const thread = object(raw, 'fio');
      reference(thread.from, itemIds, 'ponta do fio');
      reference(thread.to, itemIds, 'ponta do fio');
    }
  }
}
