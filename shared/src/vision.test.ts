import { describe, expect, it } from 'vitest';

import { createEffect, createScene, createTile, createToken, createWall } from './defaults.js';
import { cellKey } from './grid.js';
import type { LegacyVisibility, Scene, Token, Wall } from './types.js';
import {
  canPlayerSeeToken,
  collectBlockers,
  computeVision,
  newlyExploredCells,
  partySightCells,
  playerSightCells,
  sharedSight,
  dragStepAllowed,
  hasLineOfSight,
  isDoorWithinSight,
  isEffectSeen,
  isTileSeen,
  movementBlocked,
  segmentsIntersect,
  tokenShownByOwnLight,
  visibleWalls,
} from './vision.js';

/**
 * Visao, colisao e o que cada papel enxerga.
 *
 * E o codigo mais delicado do projeto porque as falhas sao invisiveis do lado
 * certo da tela: o mestre ve tudo funcionando enquanto o jogador atravessa uma
 * parede ou recebe no payload um token que deveria estar escondido.
 */

const SIZE = 100;

function scene(partial: Partial<Scene> = {}): Scene {
  return createScene({
    grid: { ...createScene().grid, size: SIZE, offsetX: 0, offsetY: 0 },
    fog: { ...createScene().fog, mode: 'vision' },
    ...partial,
  });
}

/** Parede vertical em x, cobrindo de y1 a y2. */
function wallAt(x: number, y1: number, y2: number, extra: Partial<Wall> = {}): Wall {
  return createWall({ x1: x, y1, x2: x, y2, ...extra });
}

describe('segmentsIntersect', () => {
  it('reconhece o cruzamento em X', () => {
    expect(
      segmentsIntersect(
        { x1: 0, y1: 0, x2: 10, y2: 10 },
        { x1: 0, y1: 10, x2: 10, y2: 0 },
      ),
    ).toBe(true);
  });

  it('nao inventa cruzamento entre paralelas', () => {
    expect(
      segmentsIntersect({ x1: 0, y1: 0, x2: 10, y2: 0 }, { x1: 0, y1: 5, x2: 10, y2: 5 }),
    ).toBe(false);
  });

  it('nao cruza quando os segmentos apenas se aproximam', () => {
    expect(
      segmentsIntersect({ x1: 0, y1: 0, x2: 4, y2: 0 }, { x1: 5, y1: -5, x2: 5, y2: 5 }),
    ).toBe(false);
  });
});

describe('hasLineOfSight', () => {
  const blockers = [{ x1: 500, y1: 0, x2: 500, y2: 1000 }];

  it('enxerga sem obstaculo no caminho', () => {
    expect(hasLineOfSight({ x: 100, y: 500 }, { x: 400, y: 500 }, [])).toBe(true);
    expect(hasLineOfSight({ x: 100, y: 500 }, { x: 400, y: 500 }, blockers)).toBe(true);
  });

  it('a parede corta a linha', () => {
    expect(hasLineOfSight({ x: 100, y: 500 }, { x: 900, y: 500 }, blockers)).toBe(false);
  });

  it('contorna a parede pela ponta', () => {
    // A parede termina em y=1000; passar por baixo dela nao e bloqueado.
    expect(hasLineOfSight({ x: 100, y: 1200 }, { x: 900, y: 1200 }, blockers)).toBe(true);
  });
});

describe('movementBlocked', () => {
  it('deixa passar onde nao ha parede', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 100, y: 100 }, { x: 400, y: 100 })).toBe(false);
  });

  it('barra o passo que atravessa a parede', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);
  });

  it('barra tambem o passo diagonal que cruza a parede', () => {
    // A regressao relatada: a validacao rodava so na soltura, e cada evento de
    // arraste ja havia gravado a posicao nova — a origem testada ja estava do
    // outro lado. Validar passo a passo depende disto funcionar na diagonal.
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 450, y: 100 }, { x: 550, y: 300 })).toBe(true);
  });

  it('nao barra o movimento nulo', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(movementBlocked(s, { x: 600, y: 100 }, { x: 600, y: 100 })).toBe(false);
  });

  it('porta aberta deixa passar; fechada barra', () => {
    const fechada = scene({ walls: [wallAt(500, 0, 1000, { door: true, open: false })] });
    expect(movementBlocked(fechada, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);

    const aberta = scene({ walls: [wallAt(500, 0, 1000, { door: true, open: true })] });
    expect(movementBlocked(aberta, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(false);
  });

  it('parede secreta barra igual, mesmo sem ser desenhada', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000, { hidden: true })] });
    expect(movementBlocked(s, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);
  });
});

describe('visibleWalls', () => {
  const walls = [
    wallAt(100, 0, 100, { id: 'comum' }),
    wallAt(200, 0, 100, { id: 'porta', door: true }),
    wallAt(300, 0, 100, { id: 'secreta', hidden: true }),
    wallAt(400, 0, 100, { id: 'porta-secreta', door: true, hidden: true }),
  ];

  it('o mestre recebe todas', () => {
    expect(visibleWalls(walls, 'GM')).toHaveLength(4);
  });

  it('o jogador recebe apenas as portas nao secretas', () => {
    const seen = visibleWalls(walls, 'PLAYER');
    expect(seen.map((w) => w.id)).toEqual(['porta']);
  });
});

describe('canPlayerSeeToken', () => {
  const gmVision = { gm: true, unrestricted: true, visible: new Set<string>(), explored: new Set<string>() };
  const openVision = { gm: false, unrestricted: true, visible: new Set<string>(), explored: new Set<string>() };
  const fogged = (visible: string[]) => ({
    gm: false,
    unrestricted: false,
    visible: new Set(visible),
    explored: new Set(visible),
  });

  // `gmOnly` e o campo antigo: passa por `createToken`, que o converte, para
  // os testes seguirem cobrindo tokens gravados antes da unificacao.
  const at = (x: number, y: number, extra: Partial<Token> & LegacyVisibility = {}) =>
    createToken({ x, y, ...extra });

  it('o antigo exclusivo do mestre vira oculto, sem a luz que os jogadores nao viam', () => {
    const t = at(0, 0, { gmOnly: true, lightRadius: 4 });
    expect(t.visibility).toBe('hidden');
    expect(t.lightRadius).toBe(0);
    expect('gmOnly' in t).toBe(false);
  });

  it('o mestre ve tudo, inclusive o que escondeu', () => {
    const s = scene();
    expect(canPlayerSeeToken(s, at(0, 0, { gmOnly: true }), gmVision, 'ply_1')).toBe(true);
  });

  it('desligar a neblina NAO revela o token oculto do mestre', () => {
    // O vazamento real: `unrestricted` juntava "sem neblina" com "ve tudo", e a
    // checagem de gmOnly vinha depois. Sem neblina, o jogador recebia no
    // payload os tokens que o mestre havia escondido.
    const s = scene();
    expect(canPlayerSeeToken(s, at(0, 0, { gmOnly: true }), openVision, 'ply_1')).toBe(false);
    expect(canPlayerSeeToken(s, at(0, 0, { visibility: 'hidden' }), openVision, 'ply_1')).toBe(false);
  });

  it('o dono ve o proprio token mesmo fora da area iluminada', () => {
    const s = scene();
    const meu = at(5000, 5000, { ownerPlayerId: 'ply_1' });
    expect(canPlayerSeeToken(s, meu, fogged([]), 'ply_1')).toBe(true);
  });

  it('o dono NAO ve o proprio token se o mestre o escondeu', () => {
    const s = scene();
    const meu = at(0, 0, { ownerPlayerId: 'ply_1', gmOnly: true });
    expect(canPlayerSeeToken(s, meu, fogged([]), 'ply_1')).toBe(false);
  });

  it('token na neblina fica invisivel; na area iluminada aparece', () => {
    const s = scene();
    // O canto em (250,250) poe o centro em (300,300): a celula do token e a
    // (3,3), e nao a (2,2) onde o canto cai.
    const alvo = at(250, 250);
    expect(canPlayerSeeToken(s, alvo, fogged([]), 'ply_1')).toBe(false);
    expect(canPlayerSeeToken(s, alvo, fogged([cellKey({ a: 2, b: 2 })]), 'ply_1')).toBe(false);
    expect(canPlayerSeeToken(s, alvo, fogged([cellKey({ a: 3, b: 3 })]), 'ply_1')).toBe(true);
  });

  it('token grande aparece se qualquer celula que ocupa estiver iluminada', () => {
    const s = scene();
    const grande = at(200, 200, { scale: 3 });
    // Ocupa de (2,2) a (4,4); iluminar so um canto ja basta.
    expect(canPlayerSeeToken(s, grande, fogged([cellKey({ a: 4, b: 4 })]), 'ply_1')).toBe(true);
  });

  it('com a neblina desligada na cena, o token comum aparece', () => {
    const s = scene({ fog: { ...scene().fog, mode: 'off' } });
    expect(canPlayerSeeToken(s, at(9999, 9999), fogged([]), 'ply_1')).toBe(true);
  });
});

describe('computeVision', () => {
  it('o mestre vem marcado como gm e sem restricao', () => {
    const s = scene();
    const v = computeVision(s, { playerId: null, role: 'GM' });
    expect(v.gm).toBe(true);
    expect(v.unrestricted).toBe(true);
  });

  it('o jogador nao vem marcado como gm', () => {
    const s = scene();
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });
    expect(v.gm).toBe(false);
  });

  it('com a neblina desligada o jogador fica sem restricao, mas nao vira gm', () => {
    // A distincao que fecha o vazamento: sem neblina, ele ve o cenario todo;
    // continua sem direito ao que o mestre escondeu.
    const s = scene({ fog: { ...scene().fog, mode: 'off' } });
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });
    expect(v.unrestricted).toBe(true);
    expect(v.gm).toBe(false);
  });

  it('a parede limita o que o token do jogador enxerga', () => {
    const s = scene({
      walls: [wallAt(500, 0, 2000)],
      tokens: [createToken({ x: 100, y: 100, ownerPlayerId: 'ply_1', visionRadius: 20 })],
    });
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });

    // Perto e do mesmo lado: visivel. Do outro lado da parede: nao.
    expect(v.visible.has(cellKey({ a: 3, b: 1 }))).toBe(true);
    expect(v.visible.has(cellKey({ a: 8, b: 1 }))).toBe(false);
  });
});

describe('juntas de parede', () => {
  // Canto em L com o vertice em (500, 500): uma parede vertical subindo e uma
  // horizontal indo para a direita. O raio diagonal passa EXATAMENTE pelo
  // vertice, que e o que acontece entre centros de celula numa grade.
  const corner = [wallAt(500, 0, 500), createWall({ x1: 500, y1: 500, x2: 1000, y2: 500 })];

  it('um raio exatamente pelo vertice de um canto e barrado', () => {
    const s = scene({ walls: corner });
    expect(movementBlocked(s, { x: 450, y: 550 }, { x: 550, y: 450 })).toBe(true);
    expect(hasLineOfSight({ x: 450, y: 550 }, { x: 550, y: 450 }, collectBlockers(s))).toBe(false);
  });

  it('token parado sobre a linha da parede nao fica cego por ela', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(hasLineOfSight({ x: 500, y: 300 }, { x: 300, y: 300 }, collectBlockers(s))).toBe(true);
  });

  it('raio paralelo que corre ao longo da parede nao e barrado', () => {
    const s = scene({ walls: [wallAt(500, 0, 1000)] });
    expect(hasLineOfSight({ x: 500, y: 1100 }, { x: 500, y: 1200 }, collectBlockers(s))).toBe(true);
  });
});

describe('janelas', () => {
  const window = wallAt(500, 0, 1000, { window: true });

  it('deixam ver o outro lado', () => {
    const s = scene({ walls: [window] });
    expect(hasLineOfSight({ x: 400, y: 100 }, { x: 600, y: 100 }, collectBlockers(s, 'vision'))).toBe(true);
  });

  it('barram a passagem', () => {
    const s = scene({ walls: [window] });
    expect(movementBlocked(s, { x: 400, y: 100 }, { x: 600, y: 100 })).toBe(true);
  });

  it('a visao calculada alcanca o outro lado da janela', () => {
    const s = scene({
      walls: [window],
      tokens: [createToken({ x: 400, y: 100, ownerPlayerId: 'ply_1', visionRadius: 5 })],
    });
    const v = computeVision(s, { playerId: 'ply_1', role: 'PLAYER' });
    expect(v.visible.has(cellKey({ a: 6, b: 1 }))).toBe(true);
  });

  it('o jogador enxerga a janela desenhada, mas nao a parede comum', () => {
    const seen = visibleWalls(
      [wallAt(100, 0, 100, { id: 'comum' }), wallAt(200, 0, 100, { id: 'janela', window: true })],
      'PLAYER',
    );
    expect(seen.map((w) => w.id)).toEqual(['janela']);
  });

  it('uma parede nao pode ser porta e janela ao mesmo tempo', () => {
    expect(createWall({ door: true, window: true }).window).toBe(false);
  });
});

describe('tokens grandes', () => {
  /*
   * O bug relatado: "as vezes o personagem ve atraves da parede, e isso
   * acontece com token de tamanho grande".
   *
   * O snap encaixa tokens de tamanho PAR com o centro em cima das linhas da
   * grade, que e onde as paredes ficam. Testando so o centro, o passo que para
   * sobre a parede e o passo que sai dela nunca tinham as duas pontas em lados
   * opostos: o token atravessava em dois movimentos. E a origem da visao, que
   * era o centro da celula arredondada, caia do lado de la do muro.
   */
  const s = scene({ walls: [wallAt(500, 0, 1000)] });

  it('o token 2x2 nao para em cima da parede', () => {
    expect(movementBlocked(s, { x: 400, y: 300 }, { x: 500, y: 300 }, 2)).toBe(true);
  });

  it('e o que ja esta dentro da parede sai, mas nao afunda mais', () => {
    // So o mestre coloca um token nessa posicao — ou desenha uma parede por
    // cima de um token que ja estava ali. De dentro do muro toda saida cruza o
    // muro, entao medir o trajeto deixaria o token preso para sempre.
    expect(movementBlocked(s, { x: 500, y: 300 }, { x: 400, y: 300 }, 2)).toBe(false);
    expect(movementBlocked(s, { x: 500, y: 300 }, { x: 600, y: 300 }, 2)).toBe(false);
    expect(movementBlocked(s, { x: 500, y: 300 }, { x: 520, y: 300 }, 2)).toBe(true);
  });

  it('o token 4x4 tambem e barrado', () => {
    // Corpo de quatro celulas: com o centro em x=300 ele ocupa de 100 a 500 e
    // encosta na parede. O teste e sobre ENTRAR na parede, entao a posicao de
    // partida precisa estar inteira do lado de ca.
    expect(movementBlocked(s, { x: 300, y: 400 }, { x: 400, y: 400 }, 4)).toBe(true);
  });

  it('o token 3x3 continua barrado ao cruzar', () => {
    expect(movementBlocked(s, { x: 350, y: 350 }, { x: 650, y: 350 }, 3)).toBe(true);
  });

  it('nem afunda na parede meio passo por vez', () => {
    // Como o arraste entrega uma posicao por quadro, o token entrava na parede
    // em passos curtos: cada passo isolado apenas ENCOSTAVA nela, e encostar
    // nao e cruzar. Medir onde o corpo para fecha esse caminho.
    expect(movementBlocked(s, { x: 350, y: 300 }, { x: 400, y: 300 }, 2)).toBe(false);
    expect(movementBlocked(s, { x: 400, y: 300 }, { x: 450, y: 300 }, 2)).toBe(true);
  });

  it('um token que comeca limpo nunca termina do outro lado', () => {
    // A garantia que fecha o bug: saindo de uma posicao livre, nenhum passo
    // — curto, longo ou na diagonal — leva o corpo para o outro lado.
    for (const destino of [450, 500, 550, 600, 900]) {
      expect(movementBlocked(s, { x: 400, y: 300 }, { x: destino, y: 300 }, 2)).toBe(true);
    }
    expect(movementBlocked(s, { x: 400, y: 300 }, { x: 560, y: 600 }, 2)).toBe(true);
  });

  it('o token de uma celula mantem o teste de sempre', () => {
    expect(movementBlocked(s, { x: 450, y: 350 }, { x: 550, y: 350 }, 1)).toBe(true);
    expect(movementBlocked(s, { x: 150, y: 350 }, { x: 450, y: 350 }, 1)).toBe(false);
  });

  it('o token 2x2 passa por um vao de duas celulas', () => {
    const gap = scene({ walls: [wallAt(500, 0, 200), wallAt(500, 400, 1000)] });
    expect(movementBlocked(gap, { x: 400, y: 300 }, { x: 600, y: 300 }, 2)).toBe(false);
  });

  it('mas nao por um vao mais estreito que ele', () => {
    const gap = scene({ walls: [wallAt(500, 0, 250), wallAt(500, 350, 1000)] });
    expect(movementBlocked(gap, { x: 400, y: 300 }, { x: 600, y: 300 }, 2)).toBe(true);
  });

  it('porta aberta deixa o token 2x2 passar; fechada barra', () => {
    const aberta = scene({ walls: [wallAt(500, 0, 1000, { door: true, open: true })] });
    expect(movementBlocked(aberta, { x: 400, y: 300 }, { x: 600, y: 300 }, 2)).toBe(false);

    const fechada = scene({ walls: [wallAt(500, 0, 1000, { door: true, open: false })] });
    expect(movementBlocked(fechada, { x: 400, y: 300 }, { x: 600, y: 300 }, 2)).toBe(true);
  });

  it('janela barra a passagem do token 2x2', () => {
    const janela = scene({ walls: [wallAt(500, 0, 1000, { window: true })] });
    expect(movementBlocked(janela, { x: 400, y: 300 }, { x: 600, y: 300 }, 2)).toBe(true);
  });

  it('a visao do token 2x2 sai do centro dele, e nao da celula arredondada', () => {
    // Centro exatamente sobre a parede (o mestre pode posicionar assim): ele
    // enxerga os dois lados, como quem esta parado no vao. Antes enxergava so
    // a sala da direita — cego justamente para o lado onde estava.
    const emCima = scene({
      walls: [wallAt(500, 0, 1000)],
      tokens: [createToken({ x: 400, y: 200, scale: 2, ownerPlayerId: 'ply_1', visionRadius: 6 })],
    });
    const v = computeVision(emCima, { role: 'PLAYER', playerId: 'ply_1' });
    expect(v.visible.has(cellKey({ a: 1, b: 3 }))).toBe(true);
    expect(v.visible.has(cellKey({ a: 8, b: 3 }))).toBe(true);
  });

  it('encostado na parede, o token 2x2 enxerga so o lado dele', () => {
    const aoLado = scene({
      walls: [wallAt(500, 0, 1000)],
      tokens: [createToken({ x: 300, y: 200, scale: 2, ownerPlayerId: 'ply_1', visionRadius: 6 })],
    });
    const v = computeVision(aoLado, { role: 'PLAYER', playerId: 'ply_1' });
    expect(v.visible.has(cellKey({ a: 1, b: 3 }))).toBe(true);
    expect(v.visible.has(cellKey({ a: 8, b: 3 }))).toBe(false);
  });
});

describe('dragStepAllowed', () => {
  /*
   * A previa do arraste no cliente. O servidor ja barrava o passo; o cliente
   * nao, e o token do jogador atravessava a parede na tela e voltava ao soltar.
   */
  const s = scene({ walls: [wallAt(500, 0, 1000)] });
  // Celula de 100px: centro do token em (450, 250), uma celula antes da parede.
  const token = createToken({ x: 400, y: 200, scale: 1 });

  it('deixa andar ao longo da parede', () => {
    expect(dragStepAllowed(s, token, 400, 450)).toBe(true);
  });

  it('barra o passo que cruza a parede', () => {
    expect(dragStepAllowed(s, token, 520, 200)).toBe(false);
  });

  it('usa o corpo do token grande, nao so o centro', () => {
    // Token 2x2 com o corpo encostado na parede: meio passo ja afundaria nela.
    const big = createToken({ x: 300, y: 200, scale: 2 });
    expect(dragStepAllowed(s, big, 350, 200)).toBe(false);
    expect(dragStepAllowed(s, big, 300, 350)).toBe(true);
  });
});

describe('isDoorWithinSight', () => {
  // Visao feita a mao: so a celula (0,0) esta iluminada.
  const seen = { visible: new Set([cellKey({ a: 0, b: 0 })]), explored: new Set<string>(), unrestricted: false, gm: false };

  it('alcanca a porta na borda de uma celula que o jogador ve', () => {
    // Porta vertical em x=100, entre as celulas (0,0) e (1,0).
    expect(isDoorWithinSight(scene(), seen, wallAt(SIZE, 0, SIZE, { door: true }))).toBe(true);
  });

  it('nao alcanca uma porta no escuro, longe do que o jogador ve', () => {
    expect(isDoorWithinSight(scene(), seen, wallAt(5 * SIZE, 0, SIZE, { door: true }))).toBe(false);
  });

  it('com a neblina desligada, ou para o mestre, qualquer porta vale', () => {
    const off = scene({ fog: { ...createScene().fog, mode: 'off' } });
    expect(isDoorWithinSight(off, seen, wallAt(5 * SIZE, 0, SIZE, { door: true }))).toBe(true);
    expect(isDoorWithinSight(scene(), { ...seen, gm: true }, wallAt(5 * SIZE, 0, SIZE, { door: true }))).toBe(true);
  });
});

describe('isTileSeen e isEffectSeen', () => {
  const lit = new Set([cellKey({ a: 0, b: 0 })]);
  const remembered = new Set([cellKey({ a: 2, b: 0 })]);
  const vision = { visible: lit, explored: remembered, unrestricted: false, gm: false };
  const tile = (x: number, extra = {}) => createTile({ x, y: 0, width: SIZE, height: SIZE, ...extra });
  const effect = (x: number, layer: 1 | 2 | 3 | 4) => createEffect({ anchor: 'free', x, y: SIZE / 2, layer });

  it('tile conta no visivel e no explorado, e o que bloqueia a visao nunca conta', () => {
    expect(isTileSeen(scene(), vision, tile(0))).toBe(true);
    expect(isTileSeen(scene(), vision, tile(2 * SIZE))).toBe(true);
    expect(isTileSeen(scene(), vision, tile(5 * SIZE))).toBe(false);
    expect(isTileSeen(scene(), vision, tile(0, { blocksVision: true }))).toBe(false);
  });

  it('efeito de cenario vale no explorado; acima da neblina, so no iluminado', () => {
    expect(isEffectSeen(scene(), vision, effect(2.5 * SIZE, 2))).toBe(true);
    expect(isEffectSeen(scene(), vision, effect(2.5 * SIZE, 4))).toBe(false);
    expect(isEffectSeen(scene(), vision, effect(0.5 * SIZE, 4))).toBe(true);
  });
});

describe('neblina de cena nova', () => {
  // Cenas criadas na mesma execucao dividiam os arrays do DEFAULT_FOG: o que
  // uma explorava aparecia como lembrado em todas as outras, ate em outra mesa.
  it('cada cena tem as proprias listas', () => {
    const a = createScene({});
    const b = createScene({});
    a.fog.explored.push('1,1');
    a.fog.revealed.push('2,2');
    a.fog.hidden.push('3,3');
    expect(b.fog).toMatchObject({ explored: [], revealed: [], hidden: [] });
    expect(createScene({}).fog.explored).toEqual([]);
  });
});

describe('exploracao e luz por jogador', () => {
  // Duas salas separadas por uma parede em x=700. Alice na da esquerda, Bruno
  // na da direita, cada um com visao 2; uma tocha sem dono no fundo da sala
  // do Bruno, longe dele.
  function rooms(): Scene {
    return createScene({
      width: 2100,
      height: 1400,
      globalLight: 0,
      fog: { mode: 'vision' } as never,
      walls: [createWall({ x1: 700, y1: 0, x2: 700, y2: 1400 })],
      tokens: [
        createToken({ id: 'alice', ownerPlayerId: 'ply_a', x: 140, y: 140, visionRadius: 2 }),
        createToken({ id: 'bruno', ownerPlayerId: 'ply_b', x: 1400, y: 140, visionRadius: 2 }),
        createToken({ id: 'tocha', x: 1540, y: 1120, lightRadius: 2 }),
      ],
    });
  }
  const torchCell = cellKey({ a: 22, b: 16 });
  const aliceCell = cellKey({ a: 2, b: 2 });

  it('o que a Alice explora nao entra na memoria do Bruno', () => {
    const s = rooms();
    const fresh = newlyExploredCells(s);
    expect(fresh.get('ply_a')).toContain(aliceCell);
    expect(fresh.get('ply_b')).not.toContain(aliceCell);
    for (const [playerId, cells] of fresh) s.fog.exploredBy[playerId] = cells;

    // A Alice sai de perto; o Bruno nunca esteve la.
    s.tokens[0].x = 560;
    const alice = computeVision(s, { role: 'PLAYER', playerId: 'ply_a' });
    const bruno = computeVision(s, { role: 'PLAYER', playerId: 'ply_b' });
    expect(alice.explored.has(aliceCell)).toBe(true);
    expect(bruno.explored.has(aliceCell)).toBe(false);
  });

  it('a exploracao gravada antes vale para todos, como base comum', () => {
    const s = rooms();
    s.fog.explored = ['9,9'];
    for (const playerId of ['ply_a', 'ply_b']) {
      expect(computeVision(s, { role: 'PLAYER', playerId }).explored.has('9,9')).toBe(true);
    }
  });

  it('luz alheia so aparece para quem tem linha de visao ate ela', () => {
    const s = rooms();
    // Bruno, na mesma sala, ve a area da tocha mesmo fora do proprio raio.
    expect(computeVision(s, { role: 'PLAYER', playerId: 'ply_b' }).visible.has(torchCell)).toBe(true);
    // Alice, atras da parede, nao — antes a luz aparecia para todos.
    expect(computeVision(s, { role: 'PLAYER', playerId: 'ply_a' }).visible.has(torchCell)).toBe(false);
  });

  it('a propria luz ilumina para o dono', () => {
    const s = rooms();
    s.tokens[0].visionRadius = 0;
    s.tokens[0].lightRadius = 3;
    expect(computeVision(s, { role: 'PLAYER', playerId: 'ply_a' }).visible.has(aliceCell)).toBe(true);
  });

  it('a visao do grupo e a uniao do que cada um ve', () => {
    const s = rooms();
    const party = partySightCells(s);
    expect(party.has(aliceCell)).toBe(true);
    expect(party.has(torchCell)).toBe(true);
  });
});

describe('tokenShownByOwnLight', () => {
  // O arraste decide com a visao do ultimo calculo completo, que guarda a tocha
  // na posicao antiga. A consulta tem de fechar essa diferenca sem mudar a
  // regra: visao antiga OU luz propria = visao refeita, posicao a posicao.
  it('visao guardada mais a luz propria da o mesmo que refazer a visao', () => {
    const torch = createToken({ id: 'tocha', ownerPlayerId: 'bruno', x: 1900, y: 1900, lightRadius: 2 });
    const s = scene({
      tokens: [createToken({ id: 'olho', ownerPlayerId: 'alice', x: 0, y: 0, visionRadius: 2 }), torch],
      walls: [createWall({ x1: 500, y1: -100, x2: 500, y2: 350 }), createWall({ x1: 200, y1: 600, x2: 900, y2: 600 })],
    });
    s.fog.hidden = ['7,1'];
    const stale = computeVision(s, { role: 'PLAYER', playerId: 'alice' });

    let seen = 0;
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        torch.x = a * SIZE;
        torch.y = b * SIZE;
        const fresh = computeVision(s, { role: 'PLAYER', playerId: 'alice' });
        const expected = canPlayerSeeToken(s, torch, fresh, 'alice');
        const got = canPlayerSeeToken(s, torch, stale, 'alice') || tokenShownByOwnLight(s, torch, 'alice');
        expect(got, `celula ${a},${b}`).toBe(expected);
        if (expected) seen++;
      }
    }
    // O teste so vale se houver dos dois casos.
    expect(seen).toBeGreaterThan(10);
    expect(seen).toBeLessThan(140);
  });

  it('nao vale para token sem luz, oculto, do proprio jogador ou fora da neblina de visao', () => {
    const torch = createToken({ id: 'tocha', ownerPlayerId: 'bruno', x: 800, y: 0, lightRadius: 2 });
    const s = scene({ tokens: [createToken({ ownerPlayerId: 'alice', x: 0, y: 0, visionRadius: 2 }), torch] });
    expect(tokenShownByOwnLight(s, torch, 'alice')).toBe(true);
    expect(tokenShownByOwnLight(s, torch, 'bruno')).toBe(false);
    expect(tokenShownByOwnLight(s, { ...torch, lightRadius: 0 }, 'alice')).toBe(false);
    expect(tokenShownByOwnLight(s, { ...torch, visibility: 'hidden' }, 'alice')).toBe(false);
    expect(tokenShownByOwnLight(s, { ...torch, visibleTo: ['bruno'] }, 'alice')).toBe(false);
    s.fog.mode = 'manual';
    expect(tokenShownByOwnLight(s, torch, 'alice')).toBe(false);
  });
});

describe('P10: visao guardada entre movimentos', () => {
  /** Numeros repetiveis: o teste falha sempre no mesmo passo. */
  function dice(seed: number): (n: number) => number {
    let s = seed;
    return (n) => Math.floor(((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n);
  }

  function busyScene(globalLight: number): Scene {
    return scene({
      globalLight,
      tokens: [
        createToken({ id: 'alice-1', ownerPlayerId: 'alice', x: 200, y: 200, visionRadius: 4 }),
        createToken({ id: 'alice-2', ownerPlayerId: 'alice', x: 900, y: 300, visionRadius: 2, lightRadius: 3 }),
        createToken({ id: 'bruno-1', ownerPlayerId: 'bruno', x: 1200, y: 900, visionRadius: 3 }),
        createToken({ id: 'tocha', x: 600, y: 800, lightRadius: 3 }),
        createToken({ id: 'npc', x: 400, y: 400 }),
      ],
      walls: [
        wallAt(500, 0, 700),
        wallAt(1000, 200, 900, { id: 'porta', door: true }),
        wallAt(300, 500, 1100, { window: true }),
        createWall({ x1: 0, y1: 600, x2: 800, y2: 600 }),
      ],
      tiles: [createTile({ id: 'estante', x: 1300, y: 300, width: 100, height: 300, blocksVision: true })],
    });
  }

  // O que se guarda e o resultado; a regra nao pode mudar. A cada alteracao da
  // cena, o que sai com a memoria tem de ser igual, celula a celula e na mesma
  // ordem, ao calculo feito do zero numa copia que nunca foi vista.
  for (const globalLight of [0, 1]) {
    it(`da o mesmo que calcular do zero, com luz global ${globalLight}`, () => {
      const s = busyScene(globalLight);
      const roll = dice(42 + globalLight);
      const mutations: ((sc: Scene) => void)[] = [
        (sc) => { const t = sc.tokens[roll(sc.tokens.length)]; t.x = roll(16) * SIZE; t.y = roll(12) * SIZE; },
        (sc) => { const t = sc.tokens[roll(sc.tokens.length)]; t.lightRadius = roll(4); },
        (sc) => { const t = sc.tokens[roll(sc.tokens.length)]; t.visionRadius = roll(5); },
        (sc) => { const t = sc.tokens[roll(sc.tokens.length)]; t.scale = 1 + roll(2); },
        (sc) => { const t = sc.tokens[roll(sc.tokens.length)]; t.layer = roll(4) === 0 ? 2 : 3; },
        (sc) => { const t = sc.tokens[roll(sc.tokens.length)]; t.visibleTo = roll(3) === 0 ? ['alice'] : null; },
        (sc) => { const t = sc.tokens[roll(sc.tokens.length)]; t.ownerPlayerId = [null, 'alice', 'bruno'][roll(3)]; },
        (sc) => { const w = sc.walls.find((x) => x.id === 'porta')!; w.open = !w.open; },
        (sc) => { const w = sc.walls[roll(sc.walls.length)]; w.x1 += SIZE; w.x2 += SIZE; },
        (sc) => { sc.walls.push(wallAt(roll(16) * SIZE, 0, 400)); },
        // Sem tirar as quatro primeiras: a porta e a janela ficam ate o fim.
        (sc) => { if (sc.walls.length > 4) sc.walls.pop(); },
        (sc) => { sc.tiles[0].y = roll(8) * SIZE; },
        (sc) => { sc.tiles[0].blocksVision = !sc.tiles[0].blocksVision; },
        (sc) => { sc.globalLight = roll(3) / 2; },
        (sc) => { sc.grid.offsetX = roll(2) * 25; },
        (sc) => { sc.tokens.reverse(); },
        // Nada muda: e o caso em que a memoria responde.
        () => {},
        (sc) => { sc.fog.revealed.push(`${roll(16)},${roll(12)}`); },
        (sc) => { sc.fog.hidden = [`${roll(16)},${roll(12)}`]; },
      ];

      for (let step = 0; step < 150; step++) {
        mutations[roll(mutations.length)](s);
        const scratch = structuredClone(s);
        for (const playerId of ['alice', 'bruno', 'ninguem']) {
          expect([...playerSightCells(s, playerId)], `passo ${step}, ${playerId}`).toEqual([
            ...playerSightCells(scratch, playerId),
          ]);
          const opts = { role: 'PLAYER' as const, playerId };
          const kept = computeVision(s, opts);
          const fresh = computeVision(scratch, opts);
          expect([...kept.visible]).toEqual([...fresh.visible]);
          expect([...kept.explored]).toEqual([...fresh.explored]);
        }
        expect([...newlyExploredCells(s)]).toEqual([...newlyExploredCells(scratch)]);
        expect([...partySightCells(s)]).toEqual([...partySightCells(scratch)]);
      }
    });
  }

  it('sem mudanca na cena, o segundo calculo devolve o mesmo conjunto; com mudanca, outro', () => {
    const s = busyScene(0);
    const first = playerSightCells(s, 'alice');
    expect(playerSightCells(s, 'alice')).toBe(first);
    // NPC sem luz andando nao muda a visao de ninguem.
    s.tokens.find((t) => t.id === 'npc')!.x = 700;
    expect(playerSightCells(s, 'alice')).toBe(first);
    s.tokens.find((t) => t.id === 'alice-1')!.x = 300;
    expect(playerSightCells(s, 'alice')).not.toBe(first);
  });

  it('exploracao e revisao do mesmo movimento dividem um calculo so', () => {
    const s = busyScene(0);
    const shared = sharedSight(s);
    const explored = newlyExploredCells(s, undefined, shared);
    expect(explored.get('alice')!.length).toBeGreaterThan(0);
    expect(shared.sights.get('alice')).toBe(playerSightCells(s, 'alice', shared));
  });
});
