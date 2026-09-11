import {
  cellCenter,
  cellCorners,
  cellHeight,
  cellKey,
  canPlayerSeeToken,
  cellsInRect,
  hexRadius,
  isHex,
  parseCellKey,
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
  type Wall,
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

export type MarqueeKind = 'select' | 'fog-reveal' | 'fog-hide' | 'tile';

/** Caixa orientada de um objeto do mapa, base do desenho de alcas. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /**
   * Ponto em torno do qual o objeto gira. Ausente, e o centro da caixa.
   *
   * A arte de corpo inteiro gira em torno dos pes, e nao do meio: e ali que o
   * personagem "esta" na grade. Se as alcas girassem em torno do centro, elas
   * se descolariam da figura a cada grau.
   */
  pivot?: Point;
}

/** Ponto de giro efetivo de uma caixa. */
export function boxPivot(box: Box): Point {
  return box.pivot ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export type HandleId = 'nw' | 'ne' | 'se' | 'sw' | 'rotate';

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
  selectedTokenIds: Set<string>;
  selectedTileId: string | null;
  selectedWallId: string | null;
  /** Retangulo em construcao: selecao, area de neblina ou tile novo. */
  marquee: { from: Point; to: Point; kind: MarqueeKind } | null;
  /** Parede em polilinha ainda aberta, incluindo o segmento sob o cursor. */
  wallPath: Point[] | null;
  /** Tipo do proximo trecho de parede, para a previa sair na cor certa. */
  wallKind: 'wall' | 'door' | 'window';
  /** Ponta de parede existente onde o cursor vai encaixar, se houver. */
  wallSnap: Point | null;
  /** Pre-visualizacao do pincel de neblina sob o cursor. */
  fogCursor: { cells: string[] } | null;
  /** Ferramenta ativa; muda a cor de algumas previas. */
  tool: string;
  /** Pincel de cobrir esta selando a area, e nao apenas fechando-a. */
  fogSeal: boolean;
  /**
   * Quando definido, o mestre esta olhando a cena pelos olhos deste jogador.
   *
   * O servidor manda tudo ao mestre — inclusive tokens ocultos e camadas so
   * dele. Para a previa ser fiel, o filtro que normalmente acontece no
   * servidor precisa ser refeito aqui: sem isso, o mestre veria a neblina do
   * jogador mas com os segredos por cima dela, o que nao ajuda ninguem.
   */
  previewPlayerId: string | null;
  /** Token de quem esta em turno, destacado no mapa. */
  activeTokenId: string | null;
  sheets: Map<string, Sheet>;
  template: SheetTemplate;
  showBars: boolean;
  assetUrlOf: (assetId: string | null) => string | null;
  measure: { from: Point; to: Point } | null;
  now: number;
}

const FOG_COLOR = '#05060a';

/** Canvas auxiliares da neblina, reaproveitados entre quadros. */
let fogCanvas: HTMLCanvasElement | null = null;
let maskRawCanvas: HTMLCanvasElement | null = null;
let maskOutCanvas: HTMLCanvasElement | null = null;

/**
 * A mascara da borda suave e composta em resolucao reduzida: ela existe apenas
 * para alimentar um desfoque, entao detalhe fino ali seria descartado de
 * qualquer forma. Isso corta o custo do efeito em quase uma ordem de grandeza.
 */
const MASK_SCALE = 0.4;

/** Folga em volta da viewport, para o pan andar sem recompor a mascara. */
const MASK_MARGIN = 0.35;
/**
 * Quanto o zoom pode variar antes de a mascara precisar ser refeita.
 *
 * Ela e rasterizada numa escala; aproximar demais depois disso mostraria a
 * ampliacao. Como a textura ja e desfocada, 10% de estiramento nao aparece —
 * e essa folga corta em tres as recomposicoes durante um gesto de zoom.
 */
const ZOOM_TOLERANCE = 0.1;
/** Sobra de resolucao que paga o estiramento tolerado acima. */
const MASK_OVERSAMPLE = 1.1;
/** Teto de lado da textura, para nao alocar uma superficie gigante. */
const MAX_MASK_SIDE = 2048;
/** Acima disto, a borda suave nao compensa e voltamos ao recorte por celula. */
const MAX_MASK_CELLS = 12000;

/**
 * Mascara da neblina ja desfocada, guardada em coordenadas de MUNDO.
 *
 * Desenhar centenas de bolhas e aplicar um desfoque de tela cheia a cada
 * quadro e caro demais para um laco de 60fps — e desnecessario, porque nada
 * disso muda enquanto a visao e a grade sao as mesmas. Guardamos o resultado
 * ancorado no mundo, com uma folga em volta da tela: mover a camera passa a
 * custar um unico `drawImage`, e a recomposicao so acontece quando a visao
 * muda, o zoom muda, ou o pan sai da folga.
 */
interface FogMask {
  canvas: HTMLCanvasElement;
  /** Retangulo do mundo que a textura cobre. */
  world: { x: number; y: number; width: number; height: number };
  zoom: number;
  key: string;
}

let fogMask: FogMask | null = null;

/** Descarta a mascara em cache (troca de cena, de mesa, ou saida da mesa). */
export function invalidateFogMask(): void {
  fogMask = null;
}

/**
 * A mascara guardada ainda serve para este quadro?
 *
 * Serve enquanto a aparencia nao mudou (`key`), o zoom continua praticamente o
 * mesmo — a textura foi rasterizada naquela escala, e esticar demais borra — e
 * a area visivel ainda cabe dentro do que foi coberto. Funcao pura, para poder
 * ser testada sem um canvas.
 */
export function canReuseFogMask(
  mask: Pick<FogMask, 'world' | 'zoom' | 'key'>,
  needed: { x: number; y: number; width: number; height: number },
  zoom: number,
  key: string,
): boolean {
  if (mask.key !== key) return false;
  if (Math.abs(mask.zoom - zoom) / mask.zoom > ZOOM_TOLERANCE) return false;

  return (
    needed.x >= mask.world.x &&
    needed.y >= mask.world.y &&
    needed.x + needed.width <= mask.world.x + mask.world.width &&
    needed.y + needed.height <= mask.world.y + mask.world.height
  );
}

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
  drawWeather(input, dpr);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Clima
// ---------------------------------------------------------------------------

/** Teto de particulas na intensidade maxima. */
const WEATHER_MAX_PARTICLES = 420;

/** Ruido estavel por indice, em [0,1). Da a cada particula um lugar proprio. */
function particleNoise(i: number, salt: number): number {
  let h = Math.imul(i + 1, 374761393) + Math.imul(salt + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Clima da cena.
 *
 * Desenhado em coordenadas de TELA, e nao do mapa: chuva cai na frente da
 * camera. Ancorar no mundo faria a tempestade ficar parada num canto do
 * terreno enquanto a pessoa arrasta o mapa.
 *
 * As particulas nao tem estado — posicao e derivada do indice e do relogio.
 * Isso evita manter e atualizar um array a cada quadro, e faz o efeito
 * sobreviver a qualquer troca de cena sem inicializacao.
 */
function drawWeather(input: RenderInput, dpr: number): void {
  const { ctx, scene, viewport, now } = input;
  const weather = scene.weather;
  if (!weather || weather.kind === 'none' || weather.intensity <= 0.01) return;

  const W = viewport.width;
  const H = viewport.height;
  const count = Math.round(WEATHER_MAX_PARTICLES * weather.intensity);
  const tilt = Math.tan((weather.angle * Math.PI) / 180);

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (weather.kind === 'fog') {
    // Nevoa e uma massa que se arrasta, nao particulas: manchas largas e
    // lentas, claras o bastante para nao virar neblina de guerra.
    ctx.globalAlpha = 0.05 + weather.intensity * 0.16;
    const blobs = 7;
    for (let i = 0; i < blobs; i++) {
      const drift = ((now * 0.008 + particleNoise(i, 3) * 4000) % (W + 900)) - 450;
      const y = particleNoise(i, 7) * H;
      const r = 180 + particleNoise(i, 11) * 260;

      const gradient = ctx.createRadialGradient(drift, y, 0, drift, y, r);
      gradient.addColorStop(0, 'rgba(200, 208, 220, 0.85)');
      gradient.addColorStop(1, 'rgba(200, 208, 220, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(drift, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // Um unico caminho para todas as particulas: centenas de `stroke` avulsos
  // custariam bem mais do que um traco so.
  ctx.beginPath();

  for (let i = 0; i < count; i++) {
    const lane = particleNoise(i, 1);
    const phase = particleNoise(i, 2);

    if (weather.kind === 'rain') {
      const speed = 620 + phase * 520;
      const y = ((now * speed) / 1000 + phase * H) % (H + 40) - 20;
      const x = (lane * (W + Math.abs(tilt) * H) - tilt * y) % (W + 60) - 30;
      const len = 9 + phase * 13;

      ctx.moveTo(x, y);
      ctx.lineTo(x + tilt * len, y + len);
      continue;
    }

    // Neve e cinzas caem devagar e balancam; a deriva senoidal e o que
    // distingue um floco de uma gota.
    const speed = weather.kind === 'snow' ? 55 + phase * 60 : 34 + phase * 46;
    const y = ((now * speed) / 1000 + phase * H) % (H + 30) - 15;
    const sway = Math.sin(now / (1400 + phase * 2200) + i) * (weather.kind === 'snow' ? 16 : 26);
    const x = (lane * W + sway - tilt * y * 0.4 + W) % W;
    const r = weather.kind === 'snow' ? 1.1 + phase * 2.1 : 0.8 + phase * 1.4;

    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  if (weather.kind === 'rain') {
    ctx.strokeStyle = `rgba(178, 200, 228, ${0.16 + weather.intensity * 0.3})`;
    ctx.lineWidth = 1.1;
    ctx.stroke();
  } else {
    ctx.fillStyle =
      weather.kind === 'snow'
        ? `rgba(238, 244, 252, ${0.4 + weather.intensity * 0.45})`
        : `rgba(150, 142, 132, ${0.3 + weather.intensity * 0.4})`;
    ctx.fill();
  }

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
  /*
   * Tokens saem do fundo para a frente, ordenados por onde pisam.
   *
   * Com a peca vista de cima isso quase nao aparece, porque duas nunca se
   * cobrem muito. Com arte de corpo inteiro e indispensavel: sem ordenar,
   * uma figura mais ao norte — logo, mais distante — passaria por cima de
   * quem esta a frente dela, e a cena perde a leitura de profundidade.
   */
  const ordered = input.scene.tokens.filter((t) => t.layer === layer);
  if (ordered.length > 1) {
    const foot = (t: Token) =>
      t.y + ((input.scene.grid.type === 'none' ? input.scene.grid.size : cellHeight(input.scene.grid)) * t.scale) / 2;
    ordered.sort((a, b) => foot(a) - foot(b));
  }
  for (const token of ordered) drawToken(input, token);
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
  if (input.previewPlayerId !== null && tile.gmOnly) return;
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
    ctx.setLineDash([]);
  }

  if (tile.id === input.selectedTileId) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#e9e4d9';
    ctx.lineWidth = 1.5 / input.camera.zoom;
    ctx.setLineDash([5 / input.camera.zoom, 4 / input.camera.zoom]);
    ctx.lineDashOffset = -input.now / 45;
    ctx.strokeRect(-tile.width / 2, -tile.height / 2, tile.width, tile.height);
    ctx.setLineDash([]);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function drawToken(input: RenderInput, token: Token): void {
  const { ctx, scene, camera } = input;
  if (input.previewPlayerId !== null) {
    if (!canPlayerSeeToken(scene, token, input.vision, input.previewPlayerId)) return;
  }
  const grid = scene.grid;
  const w = grid.size * token.scale;
  const h = (grid.type === 'none' ? grid.size : cellHeight(grid)) * token.scale;
  const cx = token.x + w / 2;
  const cy = token.y + h / 2;

  if (!litEnoughToDraw(input, token.layer, { x: cx, y: cy })) return;

  const radius = Math.min(w, h) / 2;
  const isSelected = input.selectedTokenIds.has(token.id);
  const isActive = token.id === input.activeTokenId;

  const art = getImage(input.assetUrlOf(token.assetId));
  if (token.shape === 'art' && art) {
    drawArtToken(input, token, { cx, cy, w, h }, art, isSelected, isActive);
    drawTokenBars(input, token, cx, cy + h / 2, w);
    drawTokenLabel(input, token, cx, cy + h / 2, w);
    return;
  }

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

/**
 * Altura da arte de um token, em pixels do mapa.
 *
 * A largura acompanha o tamanho declarado do token; a altura vem da proporcao
 * da imagem, entao uma ilustracao de corpo inteiro sobe para fora da celula.
 * Exportado porque o teste de clique e as alcas precisam da mesma medida que
 * o desenho — se divergirem, a pessoa clica onde ve e nao acerta nada.
 */
export function artTokenHeight(img: HTMLImageElement, width: number): number {
  if (img.width <= 0) return width;
  return (img.height / img.width) * width;
}

/**
 * Token como ilustracao inteira, de pe sobre a celula.
 *
 * O disco recortado funciona para peca vista de cima, mas destroi uma arte de
 * personagem: corta a cabeca e os pes e joga fora a transparencia. Aqui a
 * imagem e desenhada como veio, e a celula deixa de ser a moldura para virar
 * o chao — uma marca elipsoidal marca onde a figura pisa, e e ela que carrega
 * a cor do dono e o destaque do turno.
 */
function drawArtToken(
  input: RenderInput,
  token: Token,
  box: { cx: number; cy: number; w: number; h: number },
  img: HTMLImageElement,
  isSelected: boolean,
  isActive: boolean,
): void {
  const { ctx, camera } = input;
  const { cx, cy, w } = box;

  const artW = w;
  const artH = artTokenHeight(img, artW);
  // Os pes ficam no centro da celula: e ali que o token "esta" para a grade.
  const baseY = cy;
  const top = baseY - artH;

  ctx.save();
  ctx.globalAlpha = token.opacity;

  // Marca de chao: ancora a figura visualmente e substitui o anel do disco.
  const footRx = artW * 0.42;
  const footRy = footRx * 0.32;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, baseY, footRx, footRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(cx, baseY, footRx, footRy, 0, 0, Math.PI * 2);
  ctx.strokeStyle = isActive ? '#d9a441' : token.color;
  ctx.lineWidth = (isActive ? 3.5 : 2) / camera.zoom;
  ctx.stroke();

  if (isActive) {
    const pulse = 0.5 + 0.5 * Math.sin(input.now / 340);
    ctx.beginPath();
    ctx.ellipse(cx, baseY, footRx * (1.06 + pulse * 0.14), footRy * (1.06 + pulse * 0.14), 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(217,164,65,${0.16 + pulse * 0.34})`;
    ctx.lineWidth = 2.5 / camera.zoom;
    ctx.stroke();
  }
  ctx.restore();

  /*
   * A sombra sai do proprio `drawImage`: a sombra do canvas respeita o canal
   * alfa, entao com um PNG recortado ela segue o contorno do personagem, e
   * nao um retangulo. Desenhar a arte duas vezes (uma escurecida) daria o
   * mesmo resultado pagando dobrado, a cada quadro e por token.
   */
  // Figura e contornos no mesmo referencial girado em torno dos pes: o
  // tracejado de selecao precisa acompanhar a figura, e nao ficar em pe
  // enquanto ela tomba.
  ctx.save();
  ctx.translate(cx, baseY);
  if (token.rotation) ctx.rotate((token.rotation * Math.PI) / 180);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = (artW * 0.08) / camera.zoom;
  ctx.shadowOffsetY = (artH * 0.015) / camera.zoom;
  ctx.drawImage(img, -artW / 2, -artH, artW, artH);
  ctx.restore();

  if (isSelected) {
    ctx.save();
    ctx.strokeStyle = '#e9e4d9';
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
    ctx.lineDashOffset = -input.now / 45;
    ctx.strokeRect(-artW / 2, -artH, artW, artH);
    ctx.restore();
  }

  // Sinais que so o mestre ve: oculto dos jogadores, ou exclusivo dele.
  if (input.role === 'GM' && (token.gmOnly || token.visibility !== 'visible')) {
    ctx.save();
    ctx.strokeStyle = token.gmOnly ? '#d9a441' : '#6ea8d8';
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([3 / camera.zoom, 5 / camera.zoom]);
    ctx.strokeRect(-artW / 2, -artH, artW, artH);
    ctx.restore();
  }
  ctx.restore();

  ctx.restore();

  drawConditions(input, token, cx, top, artW);
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
  if (input.previewPlayerId !== null && (effect.gmOnly || effect.visibility === 'hidden')) return;
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

  /*
   * Formas com area (circulo, cone, retangulo) sao desenhadas em duas etapas:
   * a forma vira um recorte, e o estilo pinta dentro dele. Separar as duas
   * coisas e o que permite qualquer aparencia em qualquer forma — um cone de
   * runas e um retangulo de nevoa passam pelo mesmo caminho.
   */
  const areaKinds = effect.kind === 'circle' || effect.kind === 'cone' || effect.kind === 'rect';
  if (areaKinds && effect.style !== 'flat') {
    paintStyledArea(input, effect, origin, unit);
    drawEffectLabelAndAnchor(input, effect, origin);
    ctx.restore();
    return;
  }

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

      // Uma linha "energizada" ganha um halo por baixo do traco principal.
      if (effect.style !== 'flat') {
        ctx.save();
        ctx.globalAlpha = effect.opacity * 0.4;
        ctx.strokeStyle = effect.colorAlt;
        ctx.lineWidth = Math.max(effect.width, 0.2) * unit * 2.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.lineTo(origin.x + Math.cos(rad) * r, origin.y + Math.sin(rad) * r);
        ctx.stroke();
        ctx.restore();
      }

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

  drawEffectLabelAndAnchor(input, effect, origin);
  ctx.restore();
}

/** Rotulo e marcador de ancora, comuns a todos os estilos. */
function drawEffectLabelAndAnchor(input: RenderInput, effect: MapEffect, origin: Point): void {
  const { ctx, camera } = input;

  // Rotulo do efeito (exceto no tipo texto, que ja e o proprio rotulo).
  if (effect.label && effect.kind !== 'text') {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = `500 ${13 / camera.zoom}px Archivo, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Contorno escuro: sobre brasas ou runas, texto claro sozinho some.
    ctx.lineWidth = 3 / camera.zoom;
    ctx.strokeStyle = 'rgba(5,6,10,0.8)';
    ctx.strokeText(effect.label, origin.x, origin.y);
    ctx.fillStyle = '#e9e4d9';
    ctx.fillText(effect.label, origin.x, origin.y);
    ctx.restore();
  }

  // Marcador da ancora: deixa claro se o efeito segue um token ou esta solto.
  if (input.role === 'GM' && effect.anchor === 'token') {
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = effect.colorAlt;
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([4 / camera.zoom, 3 / camera.zoom]);
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 6 / camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Estilos de efeito
// ---------------------------------------------------------------------------

/** Traca a forma do efeito no contexto, para servir de recorte. */
function traceEffectShape(
  ctx: CanvasRenderingContext2D,
  effect: MapEffect,
  origin: Point,
  unit: number,
): { cx: number; cy: number; reach: number } {
  ctx.beginPath();

  if (effect.kind === 'circle') {
    const r = effect.radius * unit;
    ctx.arc(origin.x, origin.y, r, 0, Math.PI * 2);
    return { cx: origin.x, cy: origin.y, reach: r };
  }

  if (effect.kind === 'cone') {
    const r = effect.radius * unit;
    const start = ((effect.angle - effect.spread / 2) * Math.PI) / 180;
    const end = ((effect.angle + effect.spread / 2) * Math.PI) / 180;
    ctx.moveTo(origin.x, origin.y);
    ctx.arc(origin.x, origin.y, r, start, end);
    ctx.closePath();
    return { cx: origin.x, cy: origin.y, reach: r };
  }

  // rect
  const w = effect.width * unit;
  const h = effect.height * unit;
  const rad = (effect.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corner = (dx: number, dy: number) => ({
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  });

  const pts = [corner(-w / 2, -h / 2), corner(w / 2, -h / 2), corner(w / 2, h / 2), corner(-w / 2, h / 2)];
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  return { cx: origin.x, cy: origin.y, reach: Math.max(w, h) / 2 };
}

/** Ruido estavel por indice — da a cada particula um lugar proprio. */
function effectNoise(i: number, salt: number): number {
  let h = Math.imul(i + 1, 2246822519) + Math.imul(salt + 1, 3266489917);
  h = Math.imul(h ^ (h >>> 15), 668265263);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Pinta a area do efeito conforme o estilo escolhido.
 *
 * O recorte da forma vale para tudo o que e desenhado aqui: as particulas
 * podem passear livremente que nao escapam do cone nem do retangulo.
 */
function paintStyledArea(
  input: RenderInput,
  effect: MapEffect,
  origin: Point,
  unit: number,
): void {
  const { ctx, camera } = input;
  // `speed` 0 congela o efeito, o que serve para quem acha animacao demais.
  const t = input.now * 0.001 * effect.speed;

  ctx.save();
  const shape = traceEffectShape(ctx, effect, origin, unit);
  ctx.clip();

  const { cx, cy, reach } = shape;
  const base = effect.color;
  const alt = effect.colorAlt;

  switch (effect.style) {
    case 'glow':
    case 'pulse': {
      // Pulsar e o mesmo brilho com o raio respirando.
      const beat = effect.style === 'pulse' ? 0.82 + Math.sin(t * 2.1) * 0.18 : 1;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, reach * beat));
      g.addColorStop(0, withAlpha(alt, 0.55));
      g.addColorStop(0.45, withAlpha(base, 0.75));
      g.addColorStop(1, withAlpha(base, 0));
      ctx.fillStyle = g;
      ctx.fillRect(cx - reach, cy - reach, reach * 2, reach * 2);
      break;
    }

    case 'runes': {
      // Conhecimento: sigilos girando num anel, sobre um halo dourado.
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
      halo.addColorStop(0, withAlpha(alt, 0.35));
      halo.addColorStop(0.7, withAlpha(base, 0.4));
      halo.addColorStop(1, withAlpha(base, 0.1));
      ctx.fillStyle = halo;
      ctx.fillRect(cx - reach, cy - reach, reach * 2, reach * 2);

      for (const ring of [0.58, 0.86]) {
        const spin = t * (ring === 0.58 ? 0.35 : -0.22);
        const rr = reach * ring;

        ctx.save();
        ctx.strokeStyle = withAlpha(alt, 0.65);
        ctx.lineWidth = 1.5 / camera.zoom;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.stroke();

        const glyphs = ring === 0.58 ? 8 : 12;
        ctx.strokeStyle = withAlpha(alt, 0.9);
        ctx.lineWidth = 2 / camera.zoom;
        for (let i = 0; i < glyphs; i++) {
          const a = spin + (i / glyphs) * Math.PI * 2;
          const gx = cx + Math.cos(a) * rr;
          const gy = cy + Math.sin(a) * rr;
          const size = reach * 0.07;

          // Glifo procedural: tracos curtos com angulos derivados do indice,
          // o bastante para parecer escrita sem desenhar um alfabeto.
          ctx.save();
          ctx.translate(gx, gy);
          ctx.rotate(a + Math.PI / 2);
          // Tres desenhos sorteados pelo indice: um glifo unico repetido lê
          // como padrao decorativo, e nao como escrita.
          const v = effectNoise(i, ring === 0.58 ? 1 : 2);
          const shape = Math.floor(effectNoise(i, 33) * 3);
          ctx.beginPath();
          if (shape === 0) {
            ctx.moveTo(-size, -size * (0.4 + v));
            ctx.lineTo(size * (v - 0.5), size);
            ctx.lineTo(size, -size * v);
          } else if (shape === 1) {
            ctx.moveTo(0, -size);
            ctx.lineTo(0, size);
            ctx.moveTo(-size * 0.7, -size * (v - 0.2));
            ctx.lineTo(size * 0.7, -size * (v - 0.2));
          } else {
            ctx.arc(0, 0, size * 0.75, 0, Math.PI * 1.4);
            ctx.moveTo(0, -size);
            ctx.lineTo(0, size * (v - 0.2));
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }
      break;
    }

    case 'vortex': {
      // Energia: bracos em espiral girando, em neon.
      ctx.fillStyle = withAlpha(base, 0.2);
      ctx.fillRect(cx - reach, cy - reach, reach * 2, reach * 2);

      const arms = 5;
      ctx.lineCap = 'round';
      for (let a = 0; a < arms; a++) {
        ctx.beginPath();
        ctx.strokeStyle = withAlpha(a % 2 === 0 ? alt : base, 0.75);
        ctx.lineWidth = (3.5 - a * 0.35) / camera.zoom;

        for (let s = 0; s <= 26; s++) {
          const p = s / 26;
          const angle = t * 1.6 + (a / arms) * Math.PI * 2 + p * 4.2;
          const rr = reach * p;
          const px = cx + Math.cos(angle) * rr;
          const py = cy + Math.sin(angle) * rr;
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      break;
    }

    case 'mist': {
      // Morte: massas lentas que se arrastam e nunca repetem o mesmo desenho.
      // Um veu de base garante que a area leia como coberta, e nao como um
      // borrao claro; as massas por cima e que dao o movimento.
      ctx.fillStyle = withAlpha(base, 0.5);
      ctx.fillRect(cx - reach, cy - reach, reach * 2, reach * 2);

      for (let i = 0; i < 14; i++) {
        const drift = t * (0.14 + effectNoise(i, 5) * 0.2);
        const ang = effectNoise(i, 6) * Math.PI * 2 + drift;
        const dist = reach * (0.1 + effectNoise(i, 7) * 0.75);
        const px = cx + Math.cos(ang) * dist;
        const py = cy + Math.sin(ang) * dist * 0.7;
        const rr = reach * (0.35 + effectNoise(i, 8) * 0.5);

        const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, withAlpha(i % 3 === 0 ? alt : base, 0.85));
        g.addColorStop(0.6, withAlpha(base, 0.35));
        g.addColorStop(1, withAlpha(base, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case 'embers': {
      // Sangue: uma base quente, mais viva embaixo, com brasas subindo dela.
      const bed = ctx.createLinearGradient(cx, cy + reach, cx, cy - reach);
      bed.addColorStop(0, withAlpha(base, 0.95));
      bed.addColorStop(0.55, withAlpha(base, 0.45));
      bed.addColorStop(1, withAlpha(base, 0.12));
      ctx.fillStyle = bed;
      ctx.fillRect(cx - reach, cy - reach, reach * 2, reach * 2);

      // O halo e o que faz a brasa parecer quente, e nao um ponto colorido.
      ctx.shadowBlur = (reach * 0.09) / camera.zoom;
      for (let i = 0; i < 64; i++) {
        const lane = effectNoise(i, 9);
        const phase = effectNoise(i, 10);
        const climb = (t * (0.22 + phase * 0.35) + phase) % 1;

        const px = cx + (lane * 2 - 1) * reach * 0.94 + Math.sin(t * 1.4 + i) * reach * 0.06;
        const py = cy + reach * 0.98 - climb * reach * 2;
        const rr = Math.max(1, reach * 0.05 * (0.45 + phase));

        // Some conforme sobe: brasa que esfria.
        ctx.globalAlpha = effect.opacity * Math.min(1, (1 - climb) * 1.5);
        const tone = climb > 0.5 ? base : alt;
        ctx.fillStyle = tone;
        ctx.shadowColor = tone;
        ctx.beginPath();
        ctx.arc(px, py, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = effect.opacity;
      break;
    }

    case 'static': {
      // Medo: sem cor propria. Um veu escuro com chiado por cima, que
      // atrapalha a leitura do que esta embaixo em vez de colorir.
      ctx.fillStyle = withAlpha(base, 0.55);
      ctx.fillRect(cx - reach, cy - reach, reach * 2, reach * 2);

      const step = Math.max(2, reach / 34);
      const frame = Math.floor(t * 12);

      // Chiado denso: o Medo tem de atrapalhar a leitura do que esta embaixo.
      ctx.fillStyle = withAlpha(alt, 0.55);
      for (let i = 0; i < 620; i++) {
        const n1 = effectNoise(i, frame % 97);
        const n2 = effectNoise(i, (frame % 97) + 40);
        ctx.fillRect(
          cx - reach + n1 * reach * 2,
          cy - reach + n2 * reach * 2,
          step * (0.5 + n1 * 1.6),
          step * 0.7,
        );
      }

      // Faixas de interferencia deslizando: e o que separa "granulado" de
      // "sinal com defeito", que e a sensacao que o elemento pede.
      ctx.fillStyle = withAlpha(alt, 0.22);
      for (let b = 0; b < 5; b++) {
        const band = ((t * 0.35 + b * 0.27) % 1.4) - 0.2;
        ctx.fillRect(
          cx - reach,
          cy - reach + band * reach * 2,
          reach * 2,
          reach * (0.03 + effectNoise(b, 61) * 0.05),
        );
      }
      break;
    }

    default:
      break;
  }

  ctx.restore();

  // Contorno por fora do recorte, para a area continuar tendo limite claro.
  ctx.save();
  ctx.globalAlpha = Math.min(1, effect.opacity + 0.4);
  ctx.strokeStyle = effect.colorAlt;
  ctx.lineWidth = 1.5 / camera.zoom;
  traceEffectShape(ctx, effect, origin, unit);
  ctx.stroke();
  ctx.restore();
}

/** Aceita `#rgb`, `#rrggbb` e devolve rgba com o alfa pedido. */
function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return `rgba(255,255,255,${alpha})`;

  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// Paredes
// ---------------------------------------------------------------------------

function drawWalls(input: RenderInput): void {
  const { ctx, scene, camera, role } = input;
  if (scene.walls.length === 0) return;

  ctx.save();
  for (const wall of scene.walls) {
    // O jogador so ve portas e janelas; paredes comuns sao informacao do mestre.
    if (role !== 'GM' && ((!wall.door && !wall.window) || wall.hidden)) continue;

    ctx.beginPath();
    ctx.moveTo(wall.x1, wall.y1);
    ctx.lineTo(wall.x2, wall.y2);

    if (wall.door) {
      ctx.strokeStyle = wall.open ? '#6fae72' : '#d9a441';
      ctx.lineWidth = 4 / camera.zoom;
      ctx.setLineDash(wall.open ? [8 / camera.zoom, 6 / camera.zoom] : []);
    } else if (wall.window) {
      // Tracejado longo e azul: le-se como vidro, e nao se confunde com a
      // porta aberta (verde) nem com a parede secreta (roxa).
      ctx.strokeStyle = wall.hidden ? 'rgba(155,126,222,0.75)' : '#7fb3d8';
      ctx.lineWidth = 3.5 / camera.zoom;
      ctx.setLineDash([10 / camera.zoom, 5 / camera.zoom]);
    } else {
      ctx.strokeStyle = wall.hidden ? 'rgba(155,126,222,0.75)' : 'rgba(207,91,82,0.75)';
      ctx.lineWidth = 3 / camera.zoom;
      ctx.setLineDash(wall.hidden ? [6 / camera.zoom, 4 / camera.zoom] : []);
    }

    ctx.stroke();
    ctx.setLineDash([]);

    if (wall.id === input.selectedWallId) {
      // Halo claro por baixo: a parede fica obvia sem perder a cor que diz
      // o tipo dela (porta, secreta, comum).
      ctx.save();
      ctx.strokeStyle = '#e9e4d9';
      ctx.lineWidth = 9 / camera.zoom;
      ctx.globalAlpha = 0.35;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wall.x1, wall.y1);
      ctx.lineTo(wall.x2, wall.y2);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Parede sob o ponto, com tolerancia em pixels de TELA — uma parede fina
 * precisa continuar clicavel com o mapa afastado.
 */
export function wallAtPoint(scene: Scene, world: Point, zoom: number): Wall | null {
  const reach = 8 / zoom;

  for (let i = scene.walls.length - 1; i >= 0; i--) {
    const wall = scene.walls[i];
    if (distanceToSegment(world, wall) <= reach) return wall;
  }
  return null;
}

function distanceToSegment(p: Point, seg: { x1: number; y1: number; x2: number; y2: number }): number {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - seg.x1, p.y - seg.y1);

  // Projecao do ponto sobre o segmento, presa as pontas.
  const t = Math.max(0, Math.min(1, ((p.x - seg.x1) * dx + (p.y - seg.y1) * dy) / lengthSq));
  return Math.hypot(p.x - (seg.x1 + t * dx), p.y - (seg.y1 + t * dy));
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
  const { camera, viewport } = input;

  const mask = ensureFogMask(input, dim, softness);
  if (!mask) return carveSharp(input, fog, dim);

  // O quadro so paga por isto: uma textura ja pronta, desenhada em
  // coordenadas de mundo. Sem laco de celulas, sem desfoque.
  fog.save();
  fog.setTransform(dpr, 0, 0, dpr, 0, 0);
  fog.translate(viewport.width / 2, viewport.height / 2);
  fog.scale(camera.zoom, camera.zoom);
  fog.translate(-camera.x, -camera.y);
  fog.globalCompositeOperation = 'destination-out';
  fog.drawImage(mask.canvas, mask.world.x, mask.world.y, mask.world.width, mask.world.height);
  fog.restore();
}

/**
 * Assinatura do que faria a mascara mudar de aparencia.
 *
 * Movimento de token nao passa pelo contador de revisao do estado (e de
 * proposito: seria caro), entao as posicoes de quem enxerga entram aqui na
 * mao. As portas tambem, porque abrir uma muda a silhueta inteira.
 */
function fogSignature(input: RenderInput, dim: number, softness: number): string {
  const { scene, vision } = input;
  const g = scene.grid;

  let sig = `${scene.id}|${vision.visible.size}/${vision.explored.size}/${dim.toFixed(2)}/${softness.toFixed(2)}`;
  sig += `|g${g.type}:${g.size}:${g.offsetX}:${g.offsetY}`;
  sig += `|f${scene.fog.revealed.length}:${scene.fog.hidden.length}:${scene.fog.explored.length}`;

  let doors = 0;
  for (const wall of scene.walls) if (wall.door && wall.open) doors++;
  sig += `|w${scene.walls.length}:${doors}`;

  for (const token of scene.tokens) {
    if (token.visionRadius <= 0 && token.lightRadius <= 0) continue;
    sig += `|${token.id}:${Math.round(token.x)},${Math.round(token.y)}`;
  }
  return sig;
}

/** Devolve a mascara valida para este quadro, recompondo apenas se preciso. */
function ensureFogMask(input: RenderInput, dim: number, softness: number): FogMask | null {
  const { scene, camera, viewport, vision } = input;

  const needed = visibleWorldRect(camera, viewport);
  const key = fogSignature(input, dim, softness);

  if (fogMask && canReuseFogMask(fogMask, needed, camera.zoom, key)) return fogMask;

  // Com o mapa muito afastado, a area visivel cobre milhares de celulas e a
  // recomposicao passaria a travar. Nesse regime a borda suave nem se
  // distingue na tela, entao o recorte por celula sai mais barato e igual.
  const cellsOnScreen =
    (needed.width / scene.grid.size) * (needed.height / Math.max(1, cellHeight(scene.grid)));
  if (cellsOnScreen > MAX_MASK_CELLS) {
    fogMask = null;
    return null;
  }

  // Recompoe com folga em volta, para os proximos pans caberem sem refazer.
  // Sob carga, a folga encolhe: recompor mais vezes e melhor do que recompor
  // uma area enorme de uma vez.
  const margin = cellsOnScreen > MAX_MASK_CELLS / 3 ? 0.08 : MASK_MARGIN;
  const marginX = needed.width * margin;
  const marginY = needed.height * margin;
  const world = {
    x: needed.x - marginX,
    y: needed.y - marginY,
    width: needed.width + marginX * 2,
    height: needed.height + marginY * 2,
  };

  // Resolucao da textura: pixels de tela vezes a reducao da mascara, com um
  // teto para nao alocar uma superficie enorme em zoom muito alto.
  let scale = camera.zoom * MASK_SCALE * MASK_OVERSAMPLE;
  const longest = Math.max(world.width, world.height) * scale;
  if (longest > MAX_MASK_SIDE) scale *= MAX_MASK_SIDE / longest;

  const pxW = Math.max(1, Math.round(world.width * scale));
  const pxH = Math.max(1, Math.round(world.height * scale));

  maskRawCanvas = ensureCanvas(maskRawCanvas, pxW, pxH);
  const raw = maskRawCanvas.getContext('2d');
  if (!raw) return null;

  raw.setTransform(1, 0, 0, 1, 0, 0);
  raw.clearRect(0, 0, pxW, pxH);
  raw.setTransform(scale, 0, 0, scale, -world.x * scale, -world.y * scale);
  raw.fillStyle = '#ffffff';

  // Um Path2D por nivel, preenchido de uma vez so. Bolhas sobrepostas dentro
  // do MESMO caminho nao somam opacidade, e e isso que permite guardar
  // penumbra e luz na mesma textura sem manchar as junoes entre celulas.
  const usesPenumbra = dim > 0.01;
  const litPath = new Path2D();
  const seenPath = usesPenumbra ? new Path2D() : null;
  const base = coverRadius(scene);

  for (const cell of cellsInRect(scene.grid, world)) {
    const cellId = cellKey(cell);
    const isVisible = vision.visible.has(cellId);
    const isExplored = vision.explored.has(cellId);
    if (!isVisible && !isExplored) continue;

    const center = cellCenter(scene.grid, cell);
    // O desvio sai de um hash da propria coordenada: a mesma celula gera
    // sempre a mesma bolha, entao a silhueta nao ferve quando a camera anda.
    const radius = base * (1 + softness * (0.04 + cellNoise(cell.a, cell.b) * 0.18));

    if (isVisible) {
      litPath.moveTo(center.x + radius, center.y);
      litPath.arc(center.x, center.y, radius, 0, Math.PI * 2);
    }
    // A penumbra cobre tambem o que esta iluminado agora, para nao abrir um
    // vinco na fronteira entre a area vista e a area lembrada.
    if (seenPath) {
      seenPath.moveTo(center.x + radius, center.y);
      seenPath.arc(center.x, center.y, radius, 0, Math.PI * 2);
    }
  }

  if (seenPath) {
    raw.globalAlpha = dim;
    raw.fill(seenPath);
  }
  raw.globalAlpha = 1;
  raw.fill(litPath);

  // Desfoque aplicado UMA vez, aqui, e nao a cada quadro na tela cheia.
  const blurPx = Math.min(48, Math.max(1.5, scene.grid.size * camera.zoom * 0.34 * softness));
  maskOutCanvas = ensureCanvas(maskOutCanvas, pxW, pxH);
  const out = maskOutCanvas.getContext('2d');
  if (!out) return null;

  out.setTransform(1, 0, 0, 1, 0, 0);
  out.clearRect(0, 0, pxW, pxH);
  out.filter = `blur(${(blurPx * (scale / camera.zoom)).toFixed(2)}px)`;
  out.drawImage(maskRawCanvas, 0, 0);
  out.filter = 'none';

  fogMask = { canvas: maskOutCanvas, world, zoom: camera.zoom, key };
  return fogMask;
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
  if (!overlay || input.role !== 'GM' || input.previewPlayerId !== null) return;

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

  drawWallEndpoints(input);
  drawWallPath(input);
  drawFogCursor(input);
  drawMarquee(input);
  drawHandles(input);
}

/** Parede em polilinha: os vertices ja fixados e o segmento sob o cursor. */
function drawWallPath(input: RenderInput): void {
  const path = input.wallPath;
  if (!path || path.length === 0) return;

  const { ctx, camera } = input;
  ctx.save();
  ctx.strokeStyle = WALL_COLORS[input.wallKind];
  ctx.lineWidth = 3 / camera.zoom;
  ctx.globalAlpha = 0.9;
  ctx.lineJoin = 'round';
  if (input.wallKind === 'window') ctx.setLineDash([10 / camera.zoom, 5 / camera.zoom]);

  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Vertices ja confirmados, para ficar claro onde a proxima parede comeca.
  ctx.fillStyle = '#e9e4d9';
  for (const p of path) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 / camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Pontas de parede existentes, enquanto a ferramenta de parede esta ativa.
 *
 * Mostram onde uma parede nova vai se ligar. O anel maior marca a ponta em
 * que o cursor vai encaixar agora — sem ele, a pessoa nao sabe se a junta
 * fechou ou se ficou uma fresta.
 */
function drawWallEndpoints(input: RenderInput): void {
  if (input.role !== 'GM' || input.tool !== 'wall') return;
  const { ctx, camera, scene } = input;

  ctx.save();
  ctx.fillStyle = 'rgba(233,228,217,0.55)';
  const r = 2.5 / camera.zoom;
  const seen = new Set<string>();
  for (const wall of scene.walls) {
    for (const [x, y] of [
      [wall.x1, wall.y1],
      [wall.x2, wall.y2],
    ]) {
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (input.wallSnap) {
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 2 / camera.zoom;
    ctx.beginPath();
    ctx.arc(input.wallSnap.x, input.wallSnap.y, 7 / camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

const WALL_COLORS: Record<'wall' | 'door' | 'window', string> = {
  wall: '#cf5b52',
  door: '#d9a441',
  window: '#7fb3d8',
};

/** Area que o pincel de neblina vai afetar se houver clique agora. */
function drawFogCursor(input: RenderInput): void {
  const cursor = input.fogCursor;
  if (!cursor || cursor.cells.length === 0) return;

  const { ctx, scene, camera, tool } = input;
  const sealing = tool === 'fog-hide' && input.fogSeal;

  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = sealing ? '#cf5b52' : tool === 'fog-hide' ? '#0c0e13' : '#d9a441';
  for (const key of cursor.cells) fillCell(ctx, scene, parseCellKey(key), 0.4 / camera.zoom);

  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = sealing ? '#cf5b52' : tool === 'fog-hide' ? '#6f7280' : '#d9a441';
  ctx.lineWidth = 1.5 / camera.zoom;
  ctx.stroke();
  ctx.restore();
}

/** Retangulo arrastado: selecao, area de neblina ou tile novo. */
function drawMarquee(input: RenderInput): void {
  const marquee = input.marquee;
  if (!marquee) return;

  const { ctx, camera } = input;
  const x = Math.min(marquee.from.x, marquee.to.x);
  const y = Math.min(marquee.from.y, marquee.to.y);
  const w = Math.abs(marquee.to.x - marquee.from.x);
  const h = Math.abs(marquee.to.y - marquee.from.y);

  const palette: Record<MarqueeKind, string> = {
    select: '#6ea8d8',
    'fog-reveal': '#d9a441',
    'fog-hide': '#8a8f9c',
    tile: '#5cc98a',
  };
  const color = palette[marquee.kind];

  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 / camera.zoom;
  ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Alcas de transformacao
// ---------------------------------------------------------------------------

/** Tamanho da alca em pixels de TELA: ela não deve encolher com o zoom. */
export const HANDLE_SCREEN_SIZE = 9;
/** Distancia da alca de rotacao ao topo da caixa, tambem em pixels de tela. */
export const ROTATE_SCREEN_OFFSET = 26;

export function tokenBox(
  scene: Scene,
  token: Token,
  assetUrlOf?: (assetId: string | null) => string | null,
): Box {
  const w = scene.grid.size * token.scale;
  const h = (scene.grid.type === 'none' ? scene.grid.size : cellHeight(scene.grid)) * token.scale;

  if (token.shape === 'art' && assetUrlOf) {
    const img = getImage(assetUrlOf(token.assetId));
    if (img) {
      const artH = artTokenHeight(img, w);
      // A arte sobe a partir do centro da celula, entao a caixa comeca acima
      // do token e termina onde ele pisa — e e em torno desse ponto que gira.
      const feet = { x: token.x + w / 2, y: token.y + h / 2 };
      return {
        x: token.x,
        y: feet.y - artH,
        width: w,
        height: artH,
        rotation: token.rotation,
        pivot: feet,
      };
    }
  }

  return { x: token.x, y: token.y, width: w, height: h, rotation: token.rotation };
}

export function tileBox(tile: Tile): Box {
  return { x: tile.x, y: tile.y, width: tile.width, height: tile.height, rotation: tile.rotation };
}

/**
 * Posicao de cada alca em coordenadas do mapa, ja considerando a rotacao do
 * objeto. O mesmo calculo serve para desenhar e para o teste de clique, o que
 * evita alca desenhada num lugar e clicavel em outro.
 */
export function handlePositions(box: Box, zoom: number): Record<HandleId, Point> {
  const pivot = boxPivot(box);
  const rad = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Cada ponto e dado sem rotacao e girado em torno do pivo — que para a
  // maioria dos objetos e o centro, e para a arte de corpo inteiro sao os pes.
  const place = (x: number, y: number): Point => {
    const dx = x - pivot.x;
    const dy = y - pivot.y;
    return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
  };

  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;

  return {
    nw: place(left, top),
    ne: place(right, top),
    se: place(right, bottom),
    sw: place(left, bottom),
    rotate: place(box.x + box.width / 2, top - ROTATE_SCREEN_OFFSET / zoom),
  };
}

/** Alca sob o ponto, ou null. A area de clique e generosa de proposito. */
export function handleAtPoint(box: Box, world: Point, zoom: number): HandleId | null {
  const reach = (HANDLE_SCREEN_SIZE / zoom) * 1.1;
  const positions = handlePositions(box, zoom);
  for (const [id, p] of Object.entries(positions) as [HandleId, Point][]) {
    if (Math.abs(world.x - p.x) <= reach && Math.abs(world.y - p.y) <= reach) return id;
  }
  return null;
}

/** Caixa do unico objeto selecionado, ou null quando ha varios ou nenhum. */
export function soleSelectionBox(
  scene: Scene,
  selectedTokenIds: Set<string>,
  selectedTileId: string | null,
  assetUrlOf?: (assetId: string | null) => string | null,
): { box: Box; kind: 'token' | 'tile'; id: string } | null {
  if (selectedTileId) {
    const tile = scene.tiles.find((t) => t.id === selectedTileId);
    if (tile && !tile.locked) return { box: tileBox(tile), kind: 'tile', id: tile.id };
    return null;
  }
  if (selectedTokenIds.size !== 1) return null;

  const id = [...selectedTokenIds][0];
  const token = scene.tokens.find((t) => t.id === id);
  if (!token || token.locked) return null;
  return { box: tokenBox(scene, token, assetUrlOf), kind: 'token', id: token.id };
}

function drawHandles(input: RenderInput): void {
  // Alcas sao ferramenta de autoria: so aparecem para quem pode transformar.
  if (input.role !== 'GM') return;

  // Com a mesma resolucao de imagem do clique. Sem ela, a caixa de um token de
  // arte inteira saia do tamanho da celula: a alca de girar era desenhada
  // logo acima da celula, mas so respondia acima da cabeca da figura — e
  // clicar onde ela aparecia acertava o corpo e arrastava o token.
  const selection = soleSelectionBox(
    input.scene,
    input.selectedTokenIds,
    input.selectedTileId,
    input.assetUrlOf,
  );
  if (!selection) return;

  const { ctx, camera } = input;
  const positions = handlePositions(selection.box, camera.zoom);
  const size = HANDLE_SCREEN_SIZE / camera.zoom;

  ctx.save();

  // Haste ligando a caixa a alca de rotacao.
  const top = {
    x: (positions.nw.x + positions.ne.x) / 2,
    y: (positions.nw.y + positions.ne.y) / 2,
  };
  ctx.strokeStyle = 'rgba(233,228,217,0.55)';
  ctx.lineWidth = 1 / camera.zoom;
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(positions.rotate.x, positions.rotate.y);
  ctx.stroke();

  for (const [id, p] of Object.entries(positions) as [HandleId, Point][]) {
    ctx.beginPath();
    if (id === 'rotate') ctx.arc(p.x, p.y, size / 1.7, 0, Math.PI * 2);
    else ctx.rect(p.x - size / 2, p.y - size / 2, size, size);

    ctx.fillStyle = id === 'rotate' ? '#d9a441' : '#e9e4d9';
    ctx.fill();
    ctx.strokeStyle = '#0c0e13';
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.stroke();
  }

  ctx.restore();
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
  assetUrlOf?: (assetId: string | null) => string | null,
): Token | null {
  // Mesma ordem do desenho, invertida: quem aparece por cima e pego primeiro.
  const stack = [...scene.tokens].sort((a, b) => {
    const cell = scene.grid.type === 'none' ? scene.grid.size : cellHeight(scene.grid);
    return a.y + (cell * a.scale) / 2 - (b.y + (cell * b.scale) / 2);
  });

  for (let i = stack.length - 1; i >= 0; i--) {
    const token = stack[i];
    if (hiddenLayers.has(token.layer)) continue;

    const w = scene.grid.size * token.scale;
    const h = (scene.grid.type === 'none' ? scene.grid.size : cellHeight(scene.grid)) * token.scale;
    const cx = token.x + w / 2;
    const cy = token.y + h / 2;

    if (!vision.unrestricted && token.layer > 2) {
      if (!vision.visible.has(cellKey(cellAtPoint(scene, { x: cx, y: cy })))) continue;
    }

    // A area clicavel segue o que foi desenhado: disco para a peca vista de
    // cima, retangulo da ilustracao para a arte de corpo inteiro.
    if (token.shape === 'art') {
      const img = getImage(assetUrlOf?.(token.assetId) ?? null);
      if (img) {
        const artH = artTokenHeight(img, w);
        // Leva o ponto para o referencial da figura, desfazendo a rotacao em
        // torno dos pes. Sem isto, uma figura girada so respondia ao clique
        // na area onde ela estaria em pe.
        const rad = (-token.rotation * Math.PI) / 180;
        const dx = world.x - cx;
        const dy = world.y - cy;
        const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
        const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
        if (lx >= -w / 2 && lx <= w / 2 && ly >= -artH && ly <= 0) return token;
        continue;
      }
    }

    const radius = Math.min(w, h) / 2;
    const dx = world.x - cx;
    const dy = world.y - cy;
    if (dx * dx + dy * dy <= radius * radius) return token;
  }
  return null;
}

/** Tile sob o ponto, do topo para baixo, respeitando rotacao e camadas. */
export function tileAtPoint(
  scene: Scene,
  world: Point,
  hiddenLayers: Set<number>,
): Tile | null {
  for (let i = scene.tiles.length - 1; i >= 0; i--) {
    const tile = scene.tiles[i];
    if (hiddenLayers.has(tile.layer)) continue;

    // Leva o ponto para o espaco local do tile e testa contra o retangulo.
    const cx = tile.x + tile.width / 2;
    const cy = tile.y + tile.height / 2;
    const rad = (-tile.rotation * Math.PI) / 180;
    const dx = world.x - cx;
    const dy = world.y - cy;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);

    if (Math.abs(lx) <= tile.width / 2 && Math.abs(ly) <= tile.height / 2) return tile;
  }
  return null;
}

/** Tokens cujo centro cai dentro do retangulo, para selecao por arrasto. */
export function tokensInRect(
  scene: Scene,
  rect: { x: number; y: number; width: number; height: number },
  hiddenLayers: Set<number>,
  vision: VisionResult,
): Token[] {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;

  return scene.tokens.filter((token) => {
    if (hiddenLayers.has(token.layer)) return false;
    const box = tokenBox(scene, token);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (cx < rect.x || cx > x2 || cy < rect.y || cy > y2) return false;
    if (!vision.unrestricted && token.layer > 2) {
      if (!vision.visible.has(cellKey(cellAtPoint(scene, { x: cx, y: cy })))) return false;
    }
    return true;
  });
}

export { isHex, worldToScreen };
