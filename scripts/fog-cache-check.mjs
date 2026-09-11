/**
 * Verificacao da politica de cache da mascara de neblina.
 *
 * Reproduz `canReuseFogMask` e mede quantas recomposicoes uma sessao tipica
 * exigiria. O objetivo e comparar com o comportamento anterior, em que TODO
 * quadro recompunha a mascara e aplicava um desfoque de tela cheia.
 */

const ZOOM_TOLERANCE = 0.1;
const MASK_MARGIN = 0.35;

function canReuse(mask, needed, zoom, key) {
  if (!mask) return false;
  if (mask.key !== key) return false;
  if (Math.abs(mask.zoom - zoom) / mask.zoom > ZOOM_TOLERANCE) return false;
  return (
    needed.x >= mask.world.x &&
    needed.y >= mask.world.y &&
    needed.x + needed.width <= mask.world.x + mask.world.width &&
    needed.y + needed.height <= mask.world.y + mask.world.height
  );
}

function compose(needed, zoom, key) {
  const mx = needed.width * MASK_MARGIN;
  const my = needed.height * MASK_MARGIN;
  return {
    world: { x: needed.x - mx, y: needed.y - my, width: needed.width + mx * 2, height: needed.height + my * 2 },
    zoom,
    key,
  };
}

const VIEW = { width: 1600, height: 900 };
const rectFor = (cam, zoom) => ({
  x: cam.x - VIEW.width / zoom / 2,
  y: cam.y - VIEW.height / zoom / 2,
  width: VIEW.width / zoom,
  height: VIEW.height / zoom,
});

function run(label, frames) {
  let mask = null;
  let recomposed = 0;

  for (const f of frames) {
    const needed = rectFor(f.cam, f.zoom);
    if (!canReuse(mask, needed, f.zoom, f.key)) {
      mask = compose(needed, f.zoom, f.key);
      recomposed++;
    }
  }

  const pct = ((recomposed / frames.length) * 100).toFixed(1);
  console.log(
    `  ${label.padEnd(34)} ${String(recomposed).padStart(4)} / ${frames.length} quadros (${pct}%)`,
  );
  return recomposed;
}

console.log('\nRecomposicoes da mascara (antes: 100% em todos os casos)\n');

// 1. Mesa parada: o caso mais comum durante o jogo.
run(
  'parado, 5s',
  Array.from({ length: 300 }, () => ({ cam: { x: 1000, y: 700 }, zoom: 1, key: 'v1' })),
);

// 2. Pan lento de 3 segundos.
run(
  'pan lento (3s)',
  Array.from({ length: 180 }, (_, i) => ({ cam: { x: 1000 + i * 2, y: 700 }, zoom: 1, key: 'v1' })),
);

// 3. Pan rapido atravessando o mapa.
run(
  'pan rapido (3s)',
  Array.from({ length: 180 }, (_, i) => ({ cam: { x: 1000 + i * 12, y: 700 }, zoom: 1, key: 'v1' })),
);

// 4. Zoom continuo: a textura perde escala e precisa refazer com frequencia.
run(
  'zoom continuo (2s)',
  Array.from({ length: 120 }, (_, i) => ({
    cam: { x: 1000, y: 700 },
    zoom: 1 * Math.pow(1.01, i),
    key: 'v1',
  })),
);

// 5. Token andando: a visao muda a cada passo, e a mascara precisa acompanhar.
run(
  'token andando (2s)',
  Array.from({ length: 120 }, (_, i) => ({
    cam: { x: 1000, y: 700 },
    zoom: 1,
    key: `v${Math.floor(i / 6)}`,
  })),
);

console.log('\nO custo por quadro reaproveitado e um unico drawImage.\n');
