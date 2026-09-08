import {
  cellCenter,
  cellCorners,
  cellHeight,
  cellKey,
  cellsInRect,
  hexRadius,
  isHex,
  tokenCell,
  type Layer,
  type MapEffect,
  type Point,
  type Role,
  type Scene,
  type Sheet,
  type SheetTemplate,
  type Tile,
  type Token,
  type VisionResult,
} from '@rpg/shared';

import { visibleWorldRect, worldToScreen, type Camera, type Viewport } from './camera';
import { getImage } from './images';

/**
 * Desenho do mapa.
 *
 * Tudo acontece em um unico canvas, camada por camada, na ordem que o modelo
 * define: fundo, tiles, tokens, efeitos. A neblina entra entre o terreno e os
 * tokens — assim ela apaga o cenario E impede que um token dentro dela seja
 * desenhado, em vez de so escurece-lo por cima.
 */

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  scene: Scene;
  camera: Camera;
  viewport: Viewport;
  role: Role;
  playerId: string | null;
  vision: VisionResult;
  /** Previa da visao do grupo, exclusiva do painel do mestre. */
  partyOverlay: Set<string> | null;
  hiddenLayers: Set<number>;
  selectedTokenId: string | null;
  /** Token de quem esta em turno, destacado no mapa. */
  activeTokenId: string | null;
  sheets: Map<string, Sheet>;
  template: SheetTemplate;
  showBars: boolean;
  assetUrlOf: (assetId: string | null) => string | null;
  measure: { from: Point; to: Point } | null;
  wallDraft: { from: Point; to: Point } | null;
  now: number;
}

const FOG_COLOR = '#05060a';

/** Canvas auxiliares da neblina, reaproveitados entre quadros. */
let fogCanvas: HTMLCanvasElement | null = null;
let maskLitCanvas: HTMLCanvasElement | null = null;
let maskSeenCanvas: HTMLCanvasElement | null = null;

/**
 * A mascara da borda suave e composta em resolucao reduzida: ela existe apenas
 * para alimentar um desfoque, entao detalhe fino ali seria descartado de
 * qualquer forma. Isso corta o custo do efeito em quase uma ordem de grandeza.
 */
const MASK_SCALE = 0.4;

export function renderScene(input: RenderInput): void {
  const { ctx, scene, camera, viewport } = input;
  const dpr = window.devicePixelRatio || 1;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  ctx.fillStyle = scene.backgroundColor || '#14161c';
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  // Do ponto daqui em diante desenhamos em coordenadas do MAPA.
  ctx.translate(viewport.width / 2, viewport.height / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  drawBackgroundImage(input);
  drawLayer(input, 1);
  drawGrid(input);
  drawLayer(input, 2);
  drawFog(input);
  drawLayer(input, 3);
  drawLayer(input, 4);
  drawWalls(input);
  drawPartyOverlay(input);
  drawDrafts(input);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Fundo e grid
// ---------------------------------------------------------------------------

function drawBackgroundImage(input: RenderInput): void {
  const { ctx, scene } = input;
  const url = input.assetUrlOf(scene.backgroundAssetId);
  const img = getImage(url);
  if (!img) return;
  ctx.drawImage(img, 0, 0, scene.width, scene.height);
}

function drawGrid(input: RenderInput): void {
  const { ctx, scene, camera } = input;
  const grid = scene.grid;
  if (grid.type === 'none' || grid.opacity <= 0.01) return;

  // Abaixo de um certo zoom a grid vira ruido visual; some.
  const onScreenCell = grid.size * camera.zoom;
  if (onScreenCell < 7) return;

  const rect = visibleWorldRect(camera, input.viewport);
  ctx.save();
  ctx.strokeStyle = grid.color;
  ctx.globalAlpha = grid.opacity;
  ctx.lineWidth = Math.max(0.5, 1 / camera.zoom);

  if (grid.type === 'square') {
    const startX = Math.floor((rect.x - grid.offsetX) / grid.size) * grid.size + grid.offsetX;
    const startY = Math.floor((rect.y - grid.offsetY) / grid.size) * grid.size + grid.offsetY;
    const endX = rect.x + rect.width;
    const endY = rect.y + rect.height;

    ctx.beginPath();
    for (let x = startX; x <= endX; x += grid.size) {
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, endY);
    }
    for (let y = startY; y <= endY; y += grid.size) {
      ctx.moveTo(rect.x, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    for (const cell of cellsInRect(grid, rect)) {
      const corners = cellCorners(grid, cell);
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Camadas
// ---------------------------------------------------------------------------

function drawLayer(input: RenderInput, layer: Layer): void {
  if (input.hiddenLayers.has(layer)) return;

  for (const tile of input.scene.tiles) {
    if (tile.layer === layer) drawTile(input, tile);
  }
  for (const token of input.scene.tokens) {
    if (token.layer === layer) drawToken(input, token);
  }
  for (const effect of input.scene.effects) {
    if (effect.layer === layer) drawEffect(input, effect);
  }
}

/** Nas camadas acima da neblina, so desenhamos o que estiver iluminado. */
function litEnoughToDraw(input: RenderInput, layer: Layer, world: Point): boolean {
  if (input.vision.unrestricted) return true;
  if (layer <= 2) return true;
  return input.vision.visible.has(cellKey(cellAtPoint(input.scene, world)));
}

function cellAtPoint(scene: Scene, p: Point) {
  const { grid } = scene;
  if (grid.type === 'none') return { a: Math.floor(p.x / grid.size), b: Math.floor(p.y / grid.size) };
  // Reaproveita a conversao do pacote compartilhado via tokenCell (escala 0).
  return tokenCell(grid, { x: p.x, y: p.y }, 0);
}

function drawTile(input: RenderInput, tile: Tile): void {
  const { ctx } = input;
  const center = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  if (!litEnoughToDraw(input, tile.layer, center)) return;

  ctx.save();
  ctx.globalAlpha = tile.opacity;
  ctx.translate(center.x, center.y);
  if (tile.rotation) ctx.rotate((tile.rotation * Math.PI) / 180);

  const img = getImage(input.assetUrlOf(tile.assetId));
  if (img) {
    ctx.drawImage(img, -tile.width / 2, -tile.height / 2, tile.width, tile.height);
  } else {
    ctx.fillStyle = tile.color ?? '#2b3140';
    ctx.fillRect(-tile.width / 2, -tile.height / 2, tile.width, tile.height);
  }

  // Marcacoes de autoria: so o mestre ve que aquilo bloqueia visao ou e dele.
  if (input.role === 'GM' && (tile.blocksVision || tile.gmOnly)) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = tile.blocksVision ? '#cf5b52' : '#d9a441';
    ctx.lineWidth = 2 / input.camera.zoom;
    ctx.setLineDash([6 / input.camera.zoom, 4 / input.camera.zoom]);
    ctx.strokeRect(-tile.width / 2, -tile.height / 2, tile.width, tile.height);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function drawToken(input: RenderInput, token: Token): void {
  const { ctx, scene, camera } = input;
  const grid = scene.grid;
  const w = grid.size * token.scale;
  const h = (grid.type === 'none' ? grid.size : cellHeight(grid)) * token.scale;
  const cx = token.x + w / 2;
  const cy = token.y + h / 2;

  if (!litEnoughToDraw(input, token.layer, { x: cx, y: cy })) return;

  const radius = Math.min(w, h) / 2;
  const isSelected = token.id === input.selectedTokenId;
  const isActive = token.id === input.activeTokenId;

  ctx.save();
  ctx.globalAlpha = token.opacity;

  // Sombra: separa o token do terreno sem precisar de contorno grosso.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10 / camera.zoom;
  ctx.shadowOffsetY = 2 / camera.zoom;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.96, 0, Math.PI * 2);
  ctx.fillStyle = '#0d0f14';
  ctx.fill();
  ctx.restore();

  const img = getImage(input.assetUrlOf(token.assetId));
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.94, 0, Math.PI * 2);
  ctx.clip();

  if (img) {
    ctx.save();
    ctx.translate(cx, cy);
    if (token.rotation) ctx.rotate((token.rotation * Math.PI) / 180);
    // `cover`: preenche o circulo sem distorcer a arte enviada.
    const scale = Math.max((radius * 2) / img.width, (radius * 2) / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = token.color;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    // Sem imagem, as iniciais do nome identificam o token.
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.font = `700 ${radius * 0.82}px Archivo, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(token.name), cx, cy + radius * 0.03);
  }
  ctx.restore();

  // Anel: cor do token, ou latao quando e a vez dele.
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.94, 0, Math.PI * 2);
  ctx.lineWidth = (isActive ? 3.5 : 2) / camera.zoom;
  ctx.strokeStyle = isActive ? '#d9a441' : token.color;
  ctx.stroke();

  if (isActive) {
    const pulse = 0.5 + 0.5 * Math.sin(input.now / 340);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (1.04 + pulse * 0.07), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(217,164,65,${0.16 + pulse * 0.34})`;
    ctx.lineWidth = 2.5 / camera.zoom;
    ctx.stroke();
  }

  if (isSelected) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.12, 0, Math.PI * 2);
    ctx.strokeStyle = '#e9e4d9';
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
    ctx.lineDashOffset = -input.now / 45;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Sinais que so o mestre ve: token escondido dos jogadores ou exclusivo dele.
  if (input.role === 'GM' && (token.gmOnly || token.visibility !== 'visible')) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.02, 0, Math.PI * 2);
    ctx.strokeStyle = token.gmOnly ? '#d9a441' : '#6ea8d8';
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([3 / camera.zoom, 5 / camera.zoom]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();

  drawTokenBars(input, token, cx, cy + h / 2, w);
  drawTokenLabel(input, token, cx, cy + h / 2, w);
  drawConditions(input, token, cx, cy - h / 2, w);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Barras de recurso configuradas no token, alimentadas pela ficha vinculada. */
function drawTokenBars(input: RenderInput, token: Token, cx: number, bottom: number, w: number): void {
  if (!input.showBars || token.bars.length === 0) return;
  const sheet = token.sheetId ? input.sheets.get(token.sheetId) : null;
  if (!sheet) return;

  const { ctx, camera } = input;
  const barW = w * 0.86;
  const barH = Math.max(4, 6 / camera.zoom);
  let y = bottom + 3 / camera.zoom;

  for (const bar of token.bars.slice(0, 3)) {
    const value = sheet.values[bar.fieldId];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const resource = value as { current: number; max: number };
    if (!Number.isFinite(resource.max) || resource.max <= 0) continue;

    const ratio = Math.max(0, Math.min(1, resource.current / resource.max));

    ctx.save();
    ctx.fillStyle = 'rgba(5,6,10,0.82)';
    ctx.fillRect(cx - barW / 2, y, barW, barH);
    ctx.fillStyle = bar.color || '#cf5b52';
    ctx.fillRect(cx - barW / 2, y, barW * ratio, barH);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1 / camera.zoom;
    ctx.strokeRect(cx - barW / 2, y, barW, barH);
    ctx.restore();

    y += barH + 2 / camera.zoom;
  }
}

function drawTokenLabel(input: RenderInput, token: Token, cx: number, bottom: number, w: number): void {
  const text = token.label || token.name;
  if (!text) return;

  const { ctx, camera } = input;
  // Em zoom baixo o rotulo vira borrao; melhor omitir.
  const size = 12 / camera.zoom;
  if (size * camera.zoom < 8) return;

  const y = bottom + (token.bars.length && input.showBars ? 22 : 6) / camera.zoom;

  ctx.save();
  ctx.font = `500 ${size}px Archivo, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const metrics = ctx.measureText(text);
  const padX = 4 / camera.zoom;
  ctx.fillStyle = 'rgba(5,6,10,0.72)';
  ctx.fillRect(cx - metrics.width / 2 - padX, y - 1 / camera.zoom, metrics.width + padX * 2, size * 1.25);

  ctx.fillStyle = '#e9e4d9';
  ctx.fillText(text, cx, y);
  ctx.restore();
  void w;
}

function drawConditions(input: RenderInput, token: Token, cx: number, top: number, w: number): void {
  if (token.conditions.length === 0) return;

  const { ctx, camera } = input;
  const size = Math.max(10, w * 0.22);
  const gap = size * 0.15;
  const total = token.conditions.length * size + (token.conditions.length - 1) * gap;
  let x = cx - total / 2;
  const y = top - size * 0.7;

  ctx.save();
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const condition of token.conditions.slice(0, 6)) {
    ctx.fillText(condition, x, y);
    x += size + gap;
  }
  ctx.restore();
  void camera;
}

// ---------------------------------------------------------------------------
// Efeitos
// ---------------------------------------------------------------------------

/** Resolve a ancora do efeito: celula da grid, token que ele segue, ou solto. */
function effectOrigin(input: RenderInput, effect: MapEffect): Point | null {
  const { scene } = input;

  if (effect.anchor === 'token') {
    const token = scene.tokens.find((t) => t.id === effect.tokenId);
    if (!token) return null;
    const w = scene.grid.size * token.scale;
    const h = (scene.grid.type === 'none' ? scene.grid.size : cellHeight(scene.grid)) * token.scale;
    return { x: token.x + w / 2 + effect.x, y: token.y + h / 2 + effect.y };
  }

  if (effect.anchor === 'grid' && effect.cell) {
    const corners = cellCorners(scene.grid, effect.cell);
    const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
    const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
    return { x: cx + effect.x, y: cy + effect.y };
  }

  return { x: effect.x, y: effect.y };
}

function drawEffect(input: RenderInput, effect: MapEffect): void {
  const origin = effectOrigin(input, effect);
  if (!origin) return;
  if (!litEnoughToDraw(input, effect.layer, origin)) return;

  const { ctx, scene, camera } = input;
  const unit = scene.grid.size;

  ctx.save();
  ctx.globalAlpha = effect.opacity;
  ctx.fillStyle = effect.color;
  ctx.strokeStyle = effect.color;
  ctx.lineWidth = 2 / camera.zoom;

  switch (effect.kind) {
    case 'circle': {
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, effect.radius * unit, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = Math.min(1, effect.opacity + 0.35);
      ctx.stroke();
      break;
    }
    case 'rect': {
      const w = effect.width * unit;
      const h = effect.height * unit;
      ctx.save();
      ctx.translate(origin.x, origin.y);
      ctx.rotate((effect.angle * Math.PI) / 180);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.globalAlpha = Math.min(1, effect.opacity + 0.35);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      break;
    }
    case 'cone': {
      const r = effect.radius * unit;
      const start = ((effect.angle - effect.spread / 2) * Math.PI) / 180;
      const end = ((effect.angle + effect.spread / 2) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.arc(origin.x, origin.y, r, start, end);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = Math.min(1, effect.opacity + 0.35);
      ctx.stroke();
      break;
    }
    case 'line': {
      const r = effect.radius * unit;
      const rad = (effect.angle * Math.PI) / 180;
      ctx.lineWidth = Math.max(effect.width, 0.2) * unit;
      ctx.globalAlpha = effect.opacity;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(origin.x + Math.cos(rad) * r, origin.y + Math.sin(rad) * r);
      ctx.stroke();
      break;
    }
    case 'image': {
      const img = getImage(input.assetUrlOf(effect.assetId));
      const w = effect.width * unit;
      const h = effect.height * unit;
      ctx.save();
      ctx.translate(origin.x, origin.y);
      ctx.rotate((effect.angle * Math.PI) / 180);
      if (img) ctx.drawImage(img, -w / 2, -h / 2, w, h);
      else {
        ctx.globalAlpha = effect.opacity * 0.5;
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.restore();
      break;
    }
    case 'text': {
      ctx.globalAlpha = Math.min(1, effect.opacity + 0.45);
      ctx.font = `600 ${effect.fontSize}px Eczar, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4 / camera.zoom;
      ctx.strokeStyle = 'rgba(5,6,10,0.85)';
      ctx.strokeText(effect.label, origin.x, origin.y);
      ctx.fillText(effect.label, origin.x, origin.y);
      break;
    }
  }

  // Rotulo do efeito (exceto no tipo texto, que ja e o proprio rotulo).
  if (effect.label && effect.kind !== 'text') {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e9e4d9';
    ctx.font = `500 ${13 / camera.zoom}px Archivo, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(effect.label, origin.x, origin.y);
  }

  // Marcador da ancora: deixa claro se o efeito segue um token ou esta solto.
  if (input.role === 'GM' && effect.anchor === 'token') {
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 6 / camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Paredes
// ---------------------------------------------------------------------------

function drawWalls(input: RenderInput): void {
  const { ctx, scene, camera, role } = input;
  if (scene.walls.length === 0) return;

  ctx.save();
  for (const wall of scene.walls) {
    // O jogador so ve portas; paredes comuns sao informacao do mestre.
    if (role !== 'GM' && (!wall.door || wall.hidden)) continue;

    ctx.beginPath();
    ctx.moveTo(wall.x1, wall.y1);
    ctx.lineTo(wall.x2, wall.y2);

    if (wall.door) {
      ctx.strokeStyle = wall.open ? '#6fae72' : '#d9a441';
      ctx.lineWidth = 4 / camera.zoom;
      ctx.setLineDash(wall.open ? [8 / camera.zoom, 6 / camera.zoom] : []);
    } else {
      ctx.strokeStyle = wall.hidden ? 'rgba(155,126,222,0.75)' : 'rgba(207,91,82,0.75)';
      ctx.lineWidth = 3 / camera.zoom;
      ctx.setLineDash(wall.hidden ? [6 / camera.zoom, 4 / camera.zoom] : []);
    }

    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Neblina
// ---------------------------------------------------------------------------

/**
 * A neblina e composta num canvas proprio e depois estampada sobre o mapa.
 * Fazer os recortes direto no canvas principal exigiria `destination-out`,
 * que apagaria o terreno ja desenhado em vez de mascara-lo.
 */
function drawFog(input: RenderInput): void {
  const { ctx, scene, camera, viewport, vision } = input;
  if (vision.unrestricted) return;

  const dpr = window.devicePixelRatio || 1;
  fogCanvas = ensureCanvas(fogCanvas, viewport.width * dpr, viewport.height * dpr);
  const fog = fogCanvas.getContext('2d');
  if (!fog) return;

  fog.setTransform(dpr, 0, 0, dpr, 0, 0);
  fog.clearRect(0, 0, viewport.width, viewport.height);
  fog.globalAlpha = 1;
  fog.globalCompositeOperation = 'source-over';
  fog.filter = 'none';
  fog.fillStyle = FOG_COLOR;
  fog.fillRect(0, 0, viewport.width, viewport.height);

  // Quanto da area ja explorada continua aparecendo, em penumbra.
  const dim = scene.fog.rememberExplored ? 1 - scene.fog.dimOpacity : 0;
  const softness = Math.min(1, Math.max(0, scene.fog.edgeSoftness ?? 0));

  if (softness <= 0.02) carveSharp(input, fog, dim);
  else carveSoft(input, fog, dim, softness, dpr);

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(fogCanvas, 0, 0, viewport.width, viewport.height);
  ctx.restore();

  // Restaura a transformacao de mundo para as camadas seguintes.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(viewport.width / 2, viewport.height / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);
}

function ensureCanvas(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
): HTMLCanvasElement {
  const c = canvas ?? document.createElement('canvas');
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

/** Recorte celula a celula: exato, barato, e com a silhueta da grade. */
function carveSharp(input: RenderInput, fog: CanvasRenderingContext2D, dim: number): void {
  const { scene, camera, viewport, vision } = input;

  fog.save();
  fog.translate(viewport.width / 2, viewport.height / 2);
  fog.scale(camera.zoom, camera.zoom);
  fog.translate(-camera.x, -camera.y);
  fog.globalCompositeOperation = 'destination-out';

  // Meio pixel de folga elimina a costura entre celulas vizinhas.
  const bleed = 0.6 / camera.zoom;

  for (const cell of cellsInRect(scene.grid, visibleWorldRect(camera, viewport))) {
    const key = cellKey(cell);
    const isVisible = vision.visible.has(key);
    const isExplored = !isVisible && vision.explored.has(key);
    if (!isVisible && !isExplored) continue;

    fog.globalAlpha = isVisible ? 1 : dim;
    if (fog.globalAlpha <= 0) continue;
    fillCell(fog, scene, cell, bleed);
  }

  fog.restore();
}

/**
 * Recorte com borda de nuvem.
 *
 * Cada celula revelada vira uma bolha circular de raio suficiente para cobrir
 * os proprios vertices; bolhas vizinhas se interceptam, e a uniao produz o
 * contorno festonado que da o aspecto de nuvem, no lugar do recorte de papel
 * quadriculado. Um unico desfoque sobre a mascara inteira arredonda o resto.
 *
 * Sao duas mascaras separadas, e nao uma so com opacidades diferentes: bolhas
 * sobrepostas desenhadas com alpha parcial somariam nas interseccoes, e a area
 * em penumbra ficaria manchada nas junoes entre celulas.
 */
function carveSoft(
  input: RenderInput,
  fog: CanvasRenderingContext2D,
  dim: number,
  softness: number,
  dpr: number,
): void {
  const { scene, camera, viewport, vision } = input;

  maskLitCanvas = ensureCanvas(maskLitCanvas, viewport.width * MASK_SCALE, viewport.height * MASK_SCALE);
  maskSeenCanvas = ensureCanvas(maskSeenCanvas, viewport.width * MASK_SCALE, viewport.height * MASK_SCALE);

  const lit = maskLitCanvas.getContext('2d');
  const seen = maskSeenCanvas.getContext('2d');
  if (!lit || !seen) return carveSharp(input, fog, dim);

  const usesPenumbra = dim > 0.01;
  const targets = usesPenumbra ? [lit, seen] : [lit];

  for (const m of targets) {
    m.setTransform(MASK_SCALE, 0, 0, MASK_SCALE, 0, 0);
    m.clearRect(0, 0, viewport.width, viewport.height);
    m.translate(viewport.width / 2, viewport.height / 2);
    m.scale(camera.zoom, camera.zoom);
    m.translate(-camera.x, -camera.y);
    m.fillStyle = '#ffffff';
  }

  const base = coverRadius(scene);

  for (const cell of cellsInRect(scene.grid, visibleWorldRect(camera, viewport))) {
    const key = cellKey(cell);
    const isVisible = vision.visible.has(key);
    const isExplored = vision.explored.has(key);
    if (!isVisible && !isExplored) continue;

    const center = cellCenter(scene.grid, cell);
    // O desvio sai de um hash da propria coordenada: a mesma celula gera
    // sempre a mesma bolha, entao a silhueta nao ferve quando a camera anda.
    const radius = base * (1 + softness * (0.04 + cellNoise(cell.a, cell.b) * 0.18));

    if (isVisible) blob(lit, center.x, center.y, radius);
    // A penumbra cobre tambem o que esta iluminado agora, para nao abrir um
    // vinco na fronteira entre a area vista e a area lembrada.
    if (usesPenumbra) blob(seen, center.x, center.y, radius);
  }

  const cellOnScreen = scene.grid.size * camera.zoom;
  const blurPx = Math.min(48, Math.max(1.5, cellOnScreen * 0.34 * softness)) * MASK_SCALE;

  fog.save();
  fog.setTransform(dpr, 0, 0, dpr, 0, 0);
  fog.globalCompositeOperation = 'destination-out';
  fog.filter = `blur(${blurPx.toFixed(2)}px)`;

  if (usesPenumbra) {
    fog.globalAlpha = dim;
    fog.drawImage(maskSeenCanvas, 0, 0, viewport.width, viewport.height);
  }
  fog.globalAlpha = 1;
  fog.drawImage(maskLitCanvas, 0, 0, viewport.width, viewport.height);

  fog.filter = 'none';
  fog.restore();
}

function blob(target: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  target.beginPath();
  target.arc(x, y, radius, 0, Math.PI * 2);
  target.fill();
}

/** Raio que cobre a celula inteira, vertices inclusive. */
function coverRadius(scene: Scene): number {
  const grid = scene.grid;
  if (grid.type === 'square' || grid.type === 'none') return grid.size * Math.SQRT1_2;
  return hexRadius(grid);
}

/** Ruido estavel por celula, em [0,1). Mesma celula, mesmo valor, sempre. */
function cellNoise(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fillCell(
  target: CanvasRenderingContext2D,
  scene: Scene,
  cell: { a: number; b: number },
  bleed: number,
): void {
  const grid = scene.grid;

  if (grid.type === 'square' || grid.type === 'none') {
    const x = grid.offsetX + cell.a * grid.size;
    const y = grid.offsetY + cell.b * grid.size;
    target.fillRect(x - bleed, y - bleed, grid.size + bleed * 2, grid.size + bleed * 2);
    return;
  }

  const corners = cellCorners(grid, cell);
  const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
  const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
  const grow = 1 + bleed / (grid.size / 2);

  target.beginPath();
  corners.forEach((p, i) => {
    const x = cx + (p.x - cx) * grow;
    const y = cy + (p.y - cy) * grow;
    if (i === 0) target.moveTo(x, y);
    else target.lineTo(x, y);
  });
  target.closePath();
  target.fill();
}

/**
 * Sobreposicao exclusiva do mestre: hachura o que o grupo NAO enxerga, para
 * ele saber, sem sair do proprio mapa, o que ainda esta escondido.
 */
function drawPartyOverlay(input: RenderInput): void {
  const overlay = input.partyOverlay;
  if (!overlay || input.role !== 'GM') return;

  const { ctx, scene, camera, viewport } = input;
  const rect = visibleWorldRect(camera, viewport);

  ctx.save();
  ctx.fillStyle = 'rgba(70, 96, 140, 0.2)';
  const bleed = 0.4 / camera.zoom;
  for (const cell of cellsInRect(scene.grid, rect)) {
    if (overlay.has(cellKey(cell))) continue;
    fillCell(ctx, scene, cell, bleed);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Rascunhos (medicao, parede em construcao)
// ---------------------------------------------------------------------------

function drawDrafts(input: RenderInput): void {
  const { ctx, camera } = input;

  if (input.measure) {
    const { from, to } = input.measure;
    ctx.save();
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 2 / camera.zoom;
    ctx.setLineDash([7 / camera.zoom, 5 / camera.zoom]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const p of [from, to]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 / camera.zoom, 0, Math.PI * 2);
      ctx.fillStyle = '#d9a441';
      ctx.fill();
    }
    ctx.restore();
  }

  if (input.wallDraft) {
    const { from, to } = input.wallDraft;
    ctx.save();
    ctx.strokeStyle = '#cf5b52';
    ctx.lineWidth = 3 / camera.zoom;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** Token sob o ponto, de cima para baixo (ultimo desenhado ganha). */
export function tokenAtPoint(
  scene: Scene,
  world: Point,
  hiddenLayers: Set<number>,
  vision: VisionResult,
): Token | null {
  for (let i = scene.tokens.length - 1; i >= 0; i--) {
    const token = scene.tokens[i];
    if (hiddenLayers.has(token.layer)) continue;

    const w = scene.grid.size * token.scale;
    const h = (scene.grid.type === 'none' ? scene.grid.size : cellHeight(scene.grid)) * token.scale;
    const cx = token.x + w / 2;
    const cy = token.y + h / 2;

    if (!vision.unrestricted && token.layer > 2) {
      if (!vision.visible.has(cellKey(cellAtPoint(scene, { x: cx, y: cy })))) continue;
    }

    const radius = Math.min(w, h) / 2;
    const dx = world.x - cx;
    const dy = world.y - cy;
    if (dx * dx + dy * dy <= radius * radius) return token;
  }
  return null;
}

export { isHex, worldToScreen };
