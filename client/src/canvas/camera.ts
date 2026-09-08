import type { Point, Scene } from '@rpg/shared';

/**
 * Camera do mapa.
 *
 * Cada participante tem a propria camera: onde o mestre esta olhando nao
 * arrasta a tela de ninguem (a nao ser por um ping com foco, deliberado).
 * `x`/`y` sao o ponto do MAPA que aparece no centro da viewport.
 */

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 6;

export function screenToWorld(cam: Camera, vp: Viewport, sx: number, sy: number): Point {
  return {
    x: cam.x + (sx - vp.width / 2) / cam.zoom,
    y: cam.y + (sy - vp.height / 2) / cam.zoom,
  };
}

export function worldToScreen(cam: Camera, vp: Viewport, wx: number, wy: number): Point {
  return {
    x: (wx - cam.x) * cam.zoom + vp.width / 2,
    y: (wy - cam.y) * cam.zoom + vp.height / 2,
  };
}

/** Retangulo do mapa atualmente visivel, para nao desenhar o que esta fora. */
export function visibleWorldRect(
  cam: Camera,
  vp: Viewport,
): { x: number; y: number; width: number; height: number } {
  const w = vp.width / cam.zoom;
  const h = vp.height / cam.zoom;
  return { x: cam.x - w / 2, y: cam.y - h / 2, width: w, height: h };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zoom ancorado no cursor: o ponto sob o mouse nao escorrega. */
export function zoomAt(cam: Camera, vp: Viewport, screen: Point, factor: number): Camera {
  const zoom = clampZoom(cam.zoom * factor);
  if (zoom === cam.zoom) return cam;

  const before = screenToWorld(cam, vp, screen.x, screen.y);
  const after = screenToWorld({ ...cam, zoom }, vp, screen.x, screen.y);
  return { x: cam.x + (before.x - after.x), y: cam.y + (before.y - after.y), zoom };
}

/**
 * Mantem a camera perto do mapa. Permitimos uma folga de meia tela para que
 * dê para trabalhar nas bordas sem a imagem grudar no canto.
 */
export function clampCamera(cam: Camera, scene: Scene, vp: Viewport): Camera {
  const marginX = vp.width / cam.zoom / 2;
  const marginY = vp.height / cam.zoom / 2;
  return {
    ...cam,
    x: Math.min(Math.max(cam.x, -marginX), scene.width + marginX),
    y: Math.min(Math.max(cam.y, -marginY), scene.height + marginY),
  };
}

/** Enquadra a cena inteira, com uma folga para respirar. */
export function fitScene(scene: Scene, vp: Viewport): Camera {
  if (vp.width === 0 || vp.height === 0) return { x: scene.width / 2, y: scene.height / 2, zoom: 1 };
  const zoom = clampZoom(Math.min(vp.width / scene.width, vp.height / scene.height) * 0.94);
  return { x: scene.width / 2, y: scene.height / 2, zoom };
}

/** Centraliza em um ponto sem mexer no zoom (usado por ping com foco). */
export function centerOn(cam: Camera, point: Point): Camera {
  return { ...cam, x: point.x, y: point.y };
}
