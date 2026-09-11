/**
 * Verificacao ponta a ponta com dois clientes reais (mestre e jogador).
 * Roda contra o servidor em localhost:8787. Arquivo temporario de validacao.
 */
import { io } from 'socket.io-client';
import sharp from 'sharp';

const BASE = 'http://localhost:8787';
let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function connect() {
  const socket = io(BASE, { transports: ['websocket'] });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function rpc(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const cb = (res) => (res.ok ? resolve(res.data) : reject(new Error(res.error)));
    if (payload === undefined) socket.emit(event, cb);
    else socket.emit(event, payload, cb);
  });
}

/** Espera um evento chegar, ou devolve null apos o tempo limite. */
function waitFor(socket, event, predicate = () => true, timeout = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeout);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n== 1. Criacao da mesa ==');
  const createRes = await fetch(`${BASE}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mesa de Teste', gmName: 'Mestre', gmPassword: 'segredo' }),
  });
  const { session: gmSession } = await createRes.json();
  check('mesa criada com codigo', !!gmSession?.tableCode, JSON.stringify(gmSession));
  check('papel de mestre atribuido', gmSession.role === 'GM');

  const lookup = await (await fetch(`${BASE}/api/tables/${gmSession.tableCode}`)).json();
  check('consulta do codigo devolve o nome', lookup.name === 'Mesa de Teste');
  check('consulta indica que ha senha de mestre', lookup.requiresGmPassword === true);

  console.log('\n== 2. Sessoes ==');
  const gm = await connect();
  const gmState = await rpc(gm, 'session:resume', { token: gmSession.token });
  check('mestre retoma a sessao', gmState.session.role === 'GM');
  const sceneId = gmState.state.activeSceneId;
  check('mesa nasce com uma cena ativa', !!sceneId);

  const player = await connect();
  const joined = await rpc(player, 'session:join', {
    code: gmSession.tableCode,
    name: 'Alice',
  });
  check('jogador entra pelo codigo', joined.session.role === 'PLAYER');
  check('ficha criada automaticamente ao entrar', joined.state.sheets.length >= 1);
  const playerId = joined.session.playerId;
  const playerSheet = joined.state.sheets.find((s) => s.ownerPlayerId === playerId);
  check('ficha do jogador tem os campos do template', !!playerSheet?.values?.hp);

  // Senha errada nao pode virar mestre.
  const intruder = await connect();
  let refused = false;
  try {
    await rpc(intruder, 'session:join', {
      code: gmSession.tableCode,
      name: 'Intruso',
      gmPassword: 'errada',
    });
  } catch {
    refused = true;
  }
  check('senha de mestre incorreta e recusada', refused);
  intruder.disconnect();

  console.log('\n== 3. Campos exclusivos do mestre ==');
  const gmOnlyField = gmState.state.sheetTemplate.fields.find((f) => f.gmOnly);
  check('template tem campo exclusivo do mestre', !!gmOnlyField);
  check(
    'campo do mestre nao chega ao jogador',
    joined.state.sheetTemplate.fields.every((f) => f.id !== gmOnlyField.id),
  );

  console.log('\n== 4. Tokens e visibilidade ==');
  const visible = await rpc(gm, 'token:create', {
    sceneId,
    token: { name: 'Guarda', x: 300, y: 300, layer: 3 },
  });
  const secret = await rpc(gm, 'token:create', {
    sceneId,
    token: { name: 'Assassino oculto', x: 400, y: 300, layer: 3, gmOnly: true },
  });
  await sleep(200);

  const playerTokensAfterCreate = await new Promise((resolve) => {
    rpc(player, 'session:resume', { token: joined.session.token }).then((d) =>
      resolve(d.state.scenes[0]?.tokens ?? []),
    );
  });
  check(
    'token comum chega ao jogador',
    playerTokensAfterCreate.some((t) => t.id === visible.id),
  );
  check(
    'token exclusivo do mestre NAO chega ao jogador',
    !playerTokensAfterCreate.some((t) => t.id === secret.id),
    `recebidos: ${playerTokensAfterCreate.map((t) => t.name).join(', ')}`,
  );

  console.log('\n== 5. Movimento em tempo real ==');
  const movePromise = waitFor(player, 'token:moved', (p) => p.tokenId === visible.id);
  await rpc(gm, 'token:move', { sceneId, tokenId: visible.id, x: 500, y: 350, dragging: false });
  const moved = await movePromise;
  check('jogador recebe o movimento do token', moved !== null, 'nenhum token:moved recebido');

  console.log('\n== 6. Permissao de movimento ==');
  let moveRefused = false;
  try {
    await rpc(player, 'token:move', { sceneId, tokenId: visible.id, x: 10, y: 10 });
  } catch {
    moveRefused = true;
  }
  check('jogador nao move token que nao e dele', moveRefused);

  console.log('\n== 7. Neblina por visao ==');
  // Token do jogador, com visao, e uma parede entre ele e o guarda.
  const hero = await rpc(gm, 'token:create', {
    sceneId,
    token: { name: 'Alice', x: 100, y: 100, layer: 3, ownerPlayerId: playerId, visionRadius: 4 },
  });
  await rpc(gm, 'scene:update', {
    sceneId,
    patch: { globalLight: 0, fog: { mode: 'vision' } },
  });
  await sleep(300);

  const fogState = (await rpc(player, 'session:resume', { token: joined.session.token })).state;
  const fogScene = fogState.scenes[0];
  check('jogador recebe celulas de visao ja calculadas', Array.isArray(fogScene.fog.computedVisible));
  check('celulas visiveis nao estao vazias', (fogScene.fog.computedVisible ?? []).length > 0);
  check(
    'jogador enxerga o proprio token',
    fogScene.tokens.some((t) => t.id === hero.id),
  );
  check(
    'token longe do heroi fica fora da visao',
    !fogScene.tokens.some((t) => t.id === visible.id),
    `tokens recebidos: ${fogScene.tokens.map((t) => t.name).join(', ')}`,
  );

  console.log('\n== 8. Paredes nao vazam para o jogador ==');
  const solidWall = await rpc(gm, 'wall:create', {
    sceneId,
    wall: { x1: 200, y1: 0, x2: 200, y2: 600 },
  });
  await sleep(250);
  const afterWall = (await rpc(player, 'session:resume', { token: joined.session.token })).state;
  check(
    'parede comum nao e enviada ao jogador (strictVision)',
    afterWall.scenes[0].walls.length === 0,
    `recebeu ${afterWall.scenes[0].walls.length} parede(s)`,
  );
  const gmAfterWall = (await rpc(gm, 'session:resume', { token: gmSession.token })).state;
  check('mestre recebe a parede', gmAfterWall.scenes[0].walls.length === 1);

  console.log('\n== 9. Chat e dados ==');
  const rollPromise = waitFor(player, 'chat:message', (m) => m.roll !== null);
  await rpc(gm, 'chat:send', { text: '/r 2d6+3', whisper: false });
  const rollMsg = await rollPromise;
  check('rolagem processada no servidor', rollMsg?.roll != null);
  check(
    'resultado dentro do intervalo de 2d6+3',
    rollMsg && rollMsg.roll.total >= 5 && rollMsg.roll.total <= 15,
    `total=${rollMsg?.roll?.total}`,
  );

  const whisperSeen = waitFor(player, 'chat:message', (m) => m.whisper === true, 800);
  await rpc(gm, 'chat:send', { text: 'segredo do mestre', whisper: true });
  const leaked = await whisperSeen;
  check('sussurro do mestre nao vaza para o jogador', leaked === null);

  console.log('\n== 10. Ficha: campos travados ==');
  const levelField = gmState.state.sheetTemplate.fields.find((f) => f.id === 'level');
  check('campo "nivel" e travado no template padrao', levelField?.locked === true);
  await rpc(player, 'sheet:update', {
    sheetId: playerSheet.id,
    values: { level: 99, hp: { current: 12, max: 20 } },
  });
  await sleep(250);
  const sheetAfter = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.sheets.find(
    (s) => s.id === playerSheet.id,
  );
  check('edicao de campo livre e aceita', sheetAfter.values.hp.current === 12);
  check(
    'edicao de campo travado e descartada',
    sheetAfter.values.level === 1,
    `nivel=${sheetAfter.values.level}`,
  );

  console.log('\n== 11. Iniciativa ==');
  await rpc(gm, 'initiative:add', {
    entry: { name: 'Alice', tokenId: hero.id, playerId, value: 12 },
  });
  await rpc(gm, 'initiative:add', { entry: { name: 'Guarda', tokenId: visible.id, value: 18 } });
  const initPatch = waitFor(player, 'initiative:patch');
  await rpc(gm, 'initiative:update', { active: true });
  const init = await initPatch;
  check('ordem de iniciativa chega aos jogadores', (init?.entries?.length ?? 0) === 2);
  check('ordenada do maior para o menor', init?.entries[0].value === 18);

  let advanceRefused = false;
  try {
    await rpc(player, 'initiative:next');
  } catch {
    advanceRefused = true;
  }
  check('jogador nao avanca turno sem autorizacao', advanceRefused);

  console.log('\n== 12. Upload de imagem ==');
  const png = await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 200, g: 60, b: 60, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const form = new FormData();
  form.append('kind', 'token');
  form.append('file', new Blob([png], { type: 'image/png' }), 'monstro.png');
  const uploadRes = await fetch(`${BASE}/api/assets`, {
    method: 'POST',
    headers: { 'x-session-token': gmSession.token },
    body: form,
  });
  const uploaded = await uploadRes.json();
  check('upload aceito', uploadRes.ok && !!uploaded.asset?.id, JSON.stringify(uploaded).slice(0, 120));
  check('dimensoes detectadas', uploaded.asset?.width === 120 && uploaded.asset?.height === 120);
  check('thumbnail gerada', !!uploaded.asset?.thumbUrl);
  // As imagens exigem autorizacao: sem o cookie de sessao, nem o dono baixa.
  const anonImg = await fetch(`${BASE}${uploaded.asset.url}`);
  check('imagem NAO e servida sem sessao', anonImg.status === 401, `status=${anonImg.status}`);

  const grant = await fetch(`${BASE}/api/session/image-access`, {
    method: 'POST',
    headers: { 'x-session-token': gmSession.token },
  });
  check('sessao valida obtem acesso as imagens', grant.ok, `status=${grant.status}`);
  const imgCookie = grant.headers.get('set-cookie')?.split(';')[0] ?? '';

  const imgRes = await fetch(`${BASE}${uploaded.asset.url}`, { headers: { cookie: imgCookie } });
  check('imagem servida a quem esta na mesa', imgRes.ok, `status=${imgRes.status}`);

  // Uma sessao de OUTRA mesa nao alcanca esta imagem, mesmo com a URL em maos.
  const outsider = await (await fetch(`${BASE}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mesa vizinha', gmName: 'Outro' }),
  })).json();
  const outsiderGrant = await fetch(`${BASE}/api/session/image-access`, {
    method: 'POST',
    headers: { 'x-session-token': outsider.session.token },
  });
  const outsiderCookie = outsiderGrant.headers.get('set-cookie')?.split(';')[0] ?? '';
  const crossRes = await fetch(`${BASE}${uploaded.asset.url}`, {
    headers: { cookie: outsiderCookie },
  });
  check('imagem NAO vaza para sessao de outra mesa', crossRes.status === 404, `status=${crossRes.status}`);

  // Referenciar um asset de outra mesa tambem nao pode funcionar: sem esta
  // checagem bastava conhecer o id para trazer a arte alheia para o mapa.
  const stolen = await rpc(gm, 'token:create', {
    sceneId,
    token: { name: 'Ladrao', x: 1, y: 1, assetId: 'ast_de_outra_mesa' },
  });
  check('token com assetId desconhecido perde a referencia',
    stolen?.assetId === null, JSON.stringify(stolen).slice(0, 140));

  // Um arquivo que nao e imagem precisa ser recusado, mesmo com nome .png.
  const fakeForm = new FormData();
  fakeForm.append('kind', 'token');
  fakeForm.append('file', new Blob([Buffer.from('isto nao e uma imagem')], { type: 'image/png' }), 'falso.png');
  const fakeRes = await fetch(`${BASE}/api/assets`, {
    method: 'POST',
    headers: { 'x-session-token': gmSession.token },
    body: fakeForm,
  });
  check('arquivo que nao e imagem e recusado', fakeRes.status === 400);

  // Jogador nao pode subir mapa.
  const mapForm = new FormData();
  mapForm.append('kind', 'map');
  mapForm.append('file', new Blob([png], { type: 'image/png' }), 'mapa.png');
  const mapRes = await fetch(`${BASE}/api/assets`, {
    method: 'POST',
    headers: { 'x-session-token': joined.session.token },
    body: mapForm,
  });
  check('jogador nao envia mapa', mapRes.status === 403);

  console.log('\n== 12b. Imagens chegam ao jogador na hora ==');
  // O jogador recebe so as imagens em uso no que ele enxerga. Essa lista era
  // montada apenas no estado completo: arte posta num token no meio da sessao
  // aparecia para o mestre na hora e para a mesa so depois de recarregar.
  const uploadArt = async (name) => {
    const buffer = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 40, g: 90, b: 40, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('kind', 'token');
    form.append('file', new Blob([buffer], { type: 'image/png' }), name);
    const res = await fetch(`${BASE}/api/assets`, {
      method: 'POST',
      headers: { 'x-session-token': gmSession.token },
      body: form,
    });
    return (await res.json()).asset;
  };

  // Ordem de chegada: a imagem precisa vir ANTES do token que a usa.
  const arrivals = [];
  const trackAssets = ({ upsert }) => {
    for (const a of upsert ?? []) arrivals.push(`asset:${a.id}`);
  };
  const trackTokens = ({ upsert }) => {
    for (const t of upsert ?? []) arrivals.push(`token:${t.id}`);
  };
  player.on('assets:patch', trackAssets);
  player.on('tokens:patch', trackTokens);

  const unusedArt = await uploadArt('chefe-final.png');
  const liveArt = await uploadArt('aliado.png');
  // Do jogador, para ser visivel com qualquer neblina que a suite tenha deixado.
  const liveArtToken = await rpc(gm, 'token:create', {
    sceneId,
    token: { name: 'Aliado', x: 70, y: 70, assetId: liveArt.id, ownerPlayerId: playerId },
  });
  await sleep(300);

  const assetAt = arrivals.indexOf(`asset:${liveArt.id}`);
  const tokenAt = arrivals.indexOf(`token:${liveArtToken.id}`);
  check('jogador recebe a imagem do token criado com arte', assetAt !== -1);
  check('a imagem chega antes do token que a usa', assetAt !== -1 && tokenAt !== -1 && assetAt < tokenAt);
  check('imagem enviada mas nao usada NAO chega ao jogador', !arrivals.includes(`asset:${unusedArt.id}`));

  const hiddenArt = await uploadArt('emboscada.png');
  const hiddenArtToken = await rpc(gm, 'token:create', {
    sceneId,
    token: { name: 'Emboscada', x: 140, y: 70, assetId: hiddenArt.id, gmOnly: true },
  });
  await sleep(300);
  check('arte de token oculto NAO chega ao jogador', !arrivals.includes(`asset:${hiddenArt.id}`));
  await rpc(gm, 'token:update', {
    sceneId,
    tokenId: hiddenArtToken.id,
    patch: { gmOnly: false, ownerPlayerId: playerId },
  });
  await sleep(300);
  check('a arte chega quando o token e revelado', arrivals.includes(`asset:${hiddenArt.id}`));

  const swappedArt = await uploadArt('aliado-ferido.png');
  await rpc(gm, 'token:update', { sceneId, tokenId: liveArtToken.id, patch: { assetId: swappedArt.id } });
  await sleep(300);
  check('arte trocada num token existente chega ao jogador', arrivals.includes(`asset:${swappedArt.id}`));

  const foreignPatch = waitFor(gm, 'tokens:patch', (p) => p.upsert?.some((t) => t.id === liveArtToken.id));
  await rpc(gm, 'token:update', { sceneId, tokenId: liveArtToken.id, patch: { assetId: 'ast_de_outra_mesa' } });
  const afterForeign = (await foreignPatch)?.upsert.find((t) => t.id === liveArtToken.id);
  check('atualizar token com asset de outra mesa perde a referencia', afterForeign?.assetId === null);

  player.off('assets:patch', trackAssets);
  player.off('tokens:patch', trackTokens);
  await rpc(gm, 'token:delete', { sceneId, tokenId: liveArtToken.id });
  await rpc(gm, 'token:delete', { sceneId, tokenId: hiddenArtToken.id });

  console.log('\n== 13. Tiles ==');
  const tile = await rpc(gm, 'tile:create', {
    sceneId,
    tile: { x: 600, y: 100, width: 140, height: 140, layer: 2, blocksVision: true },
  });
  check('tile criado', !!tile?.id);
  check('tile guarda o bloqueio de visao', tile.blocksVision === true);

  await rpc(gm, 'tile:update', { sceneId, tileId: tile.id, patch: { width: 200, rotation: 45 } });
  await sleep(200);
  const gmTiles = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0].tiles;
  const updatedTile = gmTiles.find((t) => t.id === tile.id);
  check('tile redimensionado e girado', updatedTile?.width === 200 && updatedTile?.rotation === 45);

  const secretTile = await rpc(gm, 'tile:create', {
    sceneId,
    tile: { x: 700, y: 200, width: 100, height: 100, layer: 2, gmOnly: true },
  });
  await sleep(200);
  const playerTiles = (await rpc(player, 'session:resume', { token: joined.session.token }))
    .state.scenes[0].tiles;
  check(
    'tile exclusivo do mestre nao chega ao jogador',
    !playerTiles.some((t) => t.id === secretTile.id),
  );

  console.log('\n== 14. Neblina em area ==');
  // Uma area retangular vira muitas celulas de uma vez.
  const areaCells = [];
  for (let a = 20; a < 30; a++) for (let b = 20; b < 30; b++) areaCells.push(`${a},${b}`);
  await rpc(gm, 'fog:paint', { sceneId, cells: areaCells, action: 'reveal' });
  await sleep(250);

  const fogAfterArea = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0].fog;
  check('area revelada de uma vez', fogAfterArea.revealed.length >= areaCells.length);
  check('modo de neblina preservado', typeof fogAfterArea.edgeSoftness === 'number');

  // O desfazer do cliente usa clear-reveal nas mesmas celulas.
  await rpc(gm, 'fog:paint', { sceneId, cells: areaCells, action: 'clear-reveal' });
  await sleep(250);
  const fogUndone = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0].fog;
  check('reversao da area limpa o que foi revelado', fogUndone.revealed.length === 0);

  console.log('\n== 14b. Cobrir e reencobrir vs selar ==');
  // Uma celula que o heroi enxerga agora, para testar o efeito do pincel.
  const beforePaint =
    (await rpc(player, 'session:resume', { token: joined.session.token })).state.scenes[0].fog
      .computedVisible ?? [];
  const target = beforePaint[Math.floor(beforePaint.length / 2)];
  check('heroi enxerga alguma celula para o teste', !!target, `visiveis=${beforePaint.length}`);

  const visibleNow = async () => {
    const st = await rpc(player, 'session:resume', { token: joined.session.token });
    return (st.state.scenes[0].fog.computedVisible ?? []).includes(target);
  };

  // `hide` fecha o mapa, mas a area continua descobrivel: o token que a
  // enxerga volta a revela-la no proximo calculo de visao.
  await rpc(gm, 'fog:paint', { sceneId, cells: [target], action: 'hide' });
  await sleep(300);
  check('area coberta volta a ser revelada pela visao do token', await visibleNow());

  // `block` sela: nem a visao do token abre.
  await rpc(gm, 'fog:paint', { sceneId, cells: [target], action: 'block' });
  await sleep(300);
  check('area selada NAO e revelada pela visao do token', !(await visibleNow()));

  await rpc(gm, 'fog:paint', { sceneId, cells: [target], action: 'unblock' });
  await sleep(300);
  check('desselar devolve a area a visao do token', await visibleNow());

  console.log('\n== 14c. Portas ==');
  // A parede solida da secao 8 fica na frente da porta; sem tira-la, o teste
  // mediria o bloqueio dela, e nao o efeito de abrir a porta.
  await rpc(gm, 'wall:delete', { sceneId, wallId: solidWall.id });
  await sleep(250);

  const doorWall = await rpc(gm, 'wall:create', {
    sceneId,
    wall: { x1: 210, y1: -400, x2: 210, y2: 900, door: true, open: false },
  });
  await sleep(300);
  const beyond = async () => {
    const st = await rpc(player, 'session:resume', { token: joined.session.token });
    const cells = st.state.scenes[0].fog.computedVisible ?? [];
    const limit = Math.floor(210 / fogScene.grid.size);
    return cells.filter((k) => Number(k.split(',')[0]) > limit).length;
  };

  const doorClosed = await beyond();
  await rpc(gm, 'wall:update', { sceneId, wallId: doorWall.id, patch: { open: true } });
  await sleep(300);
  const doorOpen = await beyond();
  check(
    'abrir a porta libera a visao alem dela',
    doorOpen > doorClosed,
    `fechada=${doorClosed} aberta=${doorOpen}`,
  );

  // O jogador precisa conseguir abrir e fechar portas visiveis.
  let playerToggledDoor = true;
  try {
    await rpc(player, 'wall:update', { sceneId, wallId: doorWall.id, patch: { open: false } });
  } catch {
    playerToggledDoor = false;
  }
  check('jogador abre e fecha portas', playerToggledDoor);

  await rpc(gm, 'wall:delete', { sceneId, wallId: doorWall.id });
  await sleep(200);
  const wallsLeft = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0]
    .walls;
  check('parede excluida some da cena', !wallsLeft.some((w) => w.id === doorWall.id));

  // A polilinha cria um segmento por trecho; o tipo escolhido tem de valer
  // para todos eles. O cliente ja errou isso uma vez, deixando de enviar
  // `door` e criando parede solida onde a pessoa pediu porta.
  const polyline = [
    { x: 900, y: 100 },
    { x: 900, y: 240 },
    { x: 1040, y: 240 },
  ];
  const madeDoors = [];
  for (let i = 0; i < polyline.length - 1; i++) {
    madeDoors.push(
      await rpc(gm, 'wall:create', {
        sceneId,
        wall: {
          x1: polyline[i].x,
          y1: polyline[i].y,
          x2: polyline[i + 1].x,
          y2: polyline[i + 1].y,
          door: true,
        },
      }),
    );
  }
  check('polilinha cria um segmento por trecho', madeDoors.length === 2);
  check(
    'todos os segmentos saem como porta',
    madeDoors.every((w) => w.door === true),
    JSON.stringify(madeDoors.map((w) => w.door)),
  );
  for (const w of madeDoors) await rpc(gm, 'wall:delete', { sceneId, wallId: w.id });

  console.log('\n== 14d. Paredes barram o movimento ==');
  // Uma parede entre o heroi e o outro lado, com a regra ligada.
  await rpc(gm, 'settings:update', { wallsBlockMovement: true });
  const blocker = await rpc(gm, 'wall:create', {
    sceneId,
    wall: { x1: 300, y1: -500, x2: 300, y2: 900, door: false },
  });
  await sleep(250);

  const heroPos = async () => {
    const st = await rpc(gm, 'session:resume', { token: gmSession.token });
    const t = st.state.scenes[0].tokens.find((x) => x.id === hero.id);
    return { x: t.x, y: t.y };
  };
  const start = await heroPos();

  let crossRefused = false;
  try {
    // O heroi e do jogador, entao quem tenta atravessar e o jogador.
    await rpc(player, 'token:move', { sceneId, tokenId: hero.id, x: 600, y: start.y, dragging: false });
  } catch {
    crossRefused = true;
  }
  check('salto direto e recusado', crossRefused);
  const after = await heroPos();
  check('token permanece onde estava', after.x === start.x && after.y === start.y);

  /*
   * O caminho que o navegador realmente usa: uma posicao por quadro enquanto
   * o dedo se move, e so no fim um evento sem `dragging`. Testar apenas o
   * salto direto escondia o bug — cada evento de arraste ja gravava a posicao
   * nova, e no evento final a origem medida ficava do outro lado da parede.
   */
  let dragRefused = false;
  for (let x = start.x + 30; x <= 600; x += 40) {
    await rpc(player, 'token:move', { sceneId, tokenId: hero.id, x, y: start.y, dragging: true });
  }
  try {
    await rpc(player, 'token:move', { sceneId, tokenId: hero.id, x: 600, y: start.y, dragging: false });
  } catch {
    dragRefused = true;
  }
  check('ARRASTE tambem e recusado', dragRefused);

  const afterDrag = await heroPos();
  check(
    'token para deste lado da parede',
    afterDrag.x < 300,
    `parou em x=${afterDrag.x}, parede em x=300`,
  );

  await rpc(gm, 'token:move', { sceneId, tokenId: hero.id, x: start.x, y: start.y, dragging: false });
  await sleep(200);

  // Movimento no mesmo lado da parede continua livre.
  await rpc(player, 'token:move', { sceneId, tokenId: hero.id, x: 150, y: start.y, dragging: false });
  await sleep(200);
  const moved2 = await heroPos();
  check('movimento sem parede no caminho e aceito', moved2.x !== start.x);

  // O mestre precisa posicionar NPCs em qualquer lugar, inclusive atras de
  // paredes, enquanto monta a cena.
  await rpc(gm, 'token:move', { sceneId, tokenId: visible.id, x: 600, y: 300, dragging: false });
  await sleep(200);
  const gmToken = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0]
    .tokens.find((t) => t.id === visible.id);
  check('mestre atravessa paredes', Math.round(gmToken.x) >= 560);

  await rpc(gm, 'settings:update', { wallsBlockMovement: false });
  await sleep(200);
  await rpc(player, 'token:move', { sceneId, tokenId: hero.id, x: 600, y: start.y, dragging: false });
  await sleep(200);
  check('desligar a regra libera a passagem', (await heroPos()).x >= 560);

  await rpc(gm, 'wall:delete', { sceneId, wallId: blocker.id });
  await rpc(gm, 'token:move', { sceneId, tokenId: hero.id, x: start.x, y: start.y, dragging: false });
  await sleep(250);

  console.log('\n== 14e. Clima da cena ==');
  await rpc(gm, 'scene:update', {
    sceneId,
    patch: { weather: { kind: 'rain', intensity: 0.8, angle: 20 } },
  });
  await sleep(250);
  const withWeather = (await rpc(player, 'session:resume', { token: joined.session.token })).state
    .scenes[0];
  check('clima chega ao jogador', withWeather.weather?.kind === 'rain');
  check('intensidade preservada', withWeather.weather?.intensity === 0.8);

  await rpc(gm, 'scene:update', {
    sceneId,
    patch: { weather: { kind: 'tempestade-de-lulas', intensity: 5, angle: 999 } },
  });
  await sleep(250);
  const clamped = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0]
    .weather;
  check('tipo desconhecido e ignorado', clamped.kind === 'rain');
  check('intensidade e angulo sao limitados', clamped.intensity === 1 && clamped.angle === 80);

  console.log('\n== 14g. Forma do token ==');
  const artToken = await rpc(gm, 'token:create', {
    sceneId,
    token: { name: 'Figura', x: 900, y: 900, layer: 3, shape: 'art' },
  });
  check('token com arte inteira criado', artToken?.shape === 'art');

  await rpc(gm, 'token:update', { sceneId, tokenId: artToken.id, patch: { shape: 'holograma' } });
  await sleep(200);
  const badShape = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0]
    .tokens.find((t) => t.id === artToken.id);
  check('forma desconhecida e ignorada', badShape?.shape === 'art');

  await rpc(gm, 'token:update', { sceneId, tokenId: artToken.id, patch: { shape: 'circle' } });
  await sleep(200);
  const backToCircle = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0]
    .tokens.find((t) => t.id === artToken.id);
  check('forma volta para peca redonda', backToCircle?.shape === 'circle');
  await rpc(gm, 'token:delete', { sceneId, tokenId: artToken.id });

  console.log('\n== 14f. Estilos de efeito ==');
  const styled = await rpc(gm, 'effect:create', {
    sceneId,
    effect: {
      kind: 'circle',
      anchor: 'free',
      x: 800,
      y: 800,
      radius: 3,
      style: 'runes',
      color: '#d9a441',
      colorAlt: '#fff1c9',
      speed: 0.8,
    },
  });
  check('efeito com estilo criado', styled?.style === 'runes');
  check('cor secundaria guardada', styled?.colorAlt === '#fff1c9');
  check('velocidade guardada', styled?.speed === 0.8);

  await rpc(gm, 'effect:update', {
    sceneId,
    effectId: styled.id,
    patch: { style: 'buraco-negro', speed: 99 },
  });
  await sleep(250);
  const afterBadPatch = (await rpc(gm, 'session:resume', { token: gmSession.token })).state.scenes[0]
    .effects.find((e) => e.id === styled.id);
  check('estilo desconhecido e ignorado', afterBadPatch?.style === 'runes');
  check('velocidade e limitada', afterBadPatch?.speed === 4);

  // Efeitos com estilo continuam sujeitos ao filtro de papel.
  await rpc(gm, 'effect:update', { sceneId, effectId: styled.id, patch: { gmOnly: true } });
  await sleep(250);
  const playerEffects = (await rpc(player, 'session:resume', { token: joined.session.token })).state
    .scenes[0].effects;
  check('efeito do mestre nao chega ao jogador', !playerEffects.some((e) => e.id === styled.id));

  await rpc(gm, 'effect:delete', { sceneId, effectId: styled.id });

  console.log('\n== 15. Rolagem pela ficha ==');
  // Modelo com uma formula que soma um atributo da propria ficha.
  const template = gmState.state.sheetTemplate;
  // O campo padrao de Defesa tem `min: 0`, e o servidor eleva qualquer valor
  // negativo a zero. Sem soltar esse limite, o teste do modificador negativo
  // rolaria "1d20+0" e passaria por sorte, sem nunca exercitar o caso.
  const withFormula = {
    ...template,
    fields: template.fields.map((f) =>
      f.id === 'defense' ? { ...f, rollFormula: '1d20+@defense', min: null } : f,
    ),
  };
  await rpc(gm, 'template:update', withFormula);
  await sleep(250);

  await rpc(gm, 'sheet:update', { sheetId: playerSheet.id, values: { defense: 7 } });
  await sleep(200);

  const rollFromSheet = waitFor(gm, 'chat:message', (m) => m.rollLabel !== null, 2000);
  await rpc(gm, 'sheet:roll', { sheetId: playerSheet.id, fieldId: 'defense' });
  const sheetRoll = await rollFromSheet;

  check('rolagem da ficha chega ao chat', sheetRoll !== null);
  check('rotulo identifica o campo', (sheetRoll?.rollLabel ?? '').includes('Defesa'));
  check(
    'referencia @defense resolvida (1d20+7 => 8..27)',
    sheetRoll && sheetRoll.roll.total >= 8 && sheetRoll.roll.total <= 27,
    `total=${sheetRoll?.roll?.total} formula=${sheetRoll?.roll?.formula}`,
  );

  // Modificador negativo produzia "1d20+-3", que a gramatica nao aceitava.
  await rpc(gm, 'sheet:update', { sheetId: playerSheet.id, values: { defense: -3 } });
  await sleep(200);
  const negativeRoll = waitFor(gm, 'chat:message', (m) => m.rollLabel !== null, 2000);
  await rpc(gm, 'sheet:roll', { sheetId: playerSheet.id, fieldId: 'defense' });
  const negative = await negativeRoll;
  // A formula precisa chegar normalizada como `1d20-3`; sem isso, o `+-`
  // gerado pela substituicao nao passaria pela gramatica de termos.
  check(
    'sinais encadeados sao normalizados',
    negative?.roll?.formula === '1d20-3',
    `formula=${negative?.roll?.formula}`,
  );
  check(
    'modificador negativo entra no resultado',
    negative !== null && negative.roll.total >= -2 && negative.roll.total <= 17,
    `total=${negative?.roll?.total} formula=${negative?.roll?.formula}`,
  );

  let noFormula = false;
  try {
    await rpc(gm, 'sheet:roll', { sheetId: playerSheet.id, fieldId: 'concept' });
  } catch {
    noFormula = true;
  }
  check('campo sem formula recusa a rolagem', noFormula);

  console.log('\n== 15b. Template antigo e completado ==');
  // Simula um template gravado por uma versao anterior do programa (ou um
  // arquivo importado antigo): campos sem as propriedades criadas depois.
  const legacy = {
    name: 'Modelo antigo',
    sections: [{ id: 'geral', label: 'Geral', order: 0 }],
    fields: [{ id: 'forca', label: 'Forca', type: 'number', sectionId: 'geral' }],
  };
  await rpc(gm, 'template:update', legacy);
  await sleep(300);

  const normalized = (await rpc(gm, 'session:resume', { token: gmSession.token })).state
    .sheetTemplate;
  const legacyField = normalized.fields.find((f) => f.id === 'forca');
  check('campo antigo sobrevive', !!legacyField);
  check(
    'propriedades ausentes sao preenchidas',
    legacyField?.rollFormula === '' &&
      legacyField?.span === 1 &&
      Array.isArray(legacyField?.options) &&
      legacyField?.locked === false,
    JSON.stringify(legacyField),
  );
  check('secao incompleta ganha os campos que faltavam', normalized.sections[0]?.collapsed === false);

  console.log('\n== 15c. Materiais do grupo ==');
  const handout = await rpc(gm, 'handout:create', { title: 'A carta do bispo', text: 'Segredo.' });
  check('material criado', !!handout?.id);
  await sleep(250);

  const playerHandouts = async () =>
    (await rpc(player, 'session:resume', { token: joined.session.token })).state.handouts;

  check(
    'material em preparacao NAO chega ao jogador',
    !(await playerHandouts()).some((h) => h.id === handout.id),
  );

  // Um material presente na tela sem ter sido compartilhado seria um vazamento.
  let presentRefused = false;
  try {
    await rpc(gm, 'handout:present', { handoutId: handout.id });
  } catch {
    presentRefused = true;
  }
  check('apresentar exige compartilhar antes', presentRefused);

  await rpc(gm, 'handout:update', { handoutId: handout.id, patch: { sharedWith: [playerId] } });
  await sleep(250);
  const shared = (await playerHandouts()).find((h) => h.id === handout.id);
  check('material compartilhado chega ao jogador', !!shared);
  check('conteudo acompanha', shared?.text === 'Segredo.');

  const presented = waitFor(player, 'handout:presented', (p) => p.handoutId === handout.id, 1500);
  await rpc(gm, 'handout:present', { handoutId: handout.id });
  check('apresentar abre na tela do jogador', (await presented) !== null);

  // Tirar o acesso precisa REMOVER da lista, e nao apenas parar de atualizar.
  const removedForPlayer = waitFor(
    player,
    'handouts:patch',
    (p) => (p.remove ?? []).includes(handout.id),
    1500,
  );
  await rpc(gm, 'handout:update', { handoutId: handout.id, patch: { sharedWith: [] } });
  check('retirar o acesso remove o material do jogador', (await removedForPlayer) !== null);

  let playerCreateRefused = false;
  try {
    await rpc(player, 'handout:create', { title: 'Meu material' });
  } catch {
    playerCreateRefused = true;
  }
  check('jogador nao cria material', playerCreateRefused);

  console.log('\n== 15d. Backup da mesa ==');
  const exportRes = await fetch(`${BASE}/api/tables/${gmSession.tableId}/export?assets=0`, {
    headers: { 'x-session-token': gmSession.token },
  });
  check('mestre exporta a mesa', exportRes.ok);
  const backup = await exportRes.json();
  check('backup traz as cenas', Array.isArray(backup.scenes) && backup.scenes.length > 0);
  check('backup traz as fichas', Array.isArray(backup.sheets) && backup.sheets.length > 0);
  check(
    'backup NAO carrega credenciais',
    !JSON.stringify(backup).includes('tokenHash') &&
      !JSON.stringify(backup).includes('gmPasswordHash'),
  );

  const playerExport = await fetch(`${BASE}/api/tables/${gmSession.tableId}/export`, {
    headers: { 'x-session-token': joined.session.token },
  });
  check('jogador nao exporta a mesa', playerExport.status === 403);

  const importRes = await fetch(`${BASE}/api/tables/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup, gmName: 'Mestre restaurado' }),
  });
  const imported = await importRes.json();
  check('importacao cria mesa nova', importRes.ok && !!imported.session?.tableCode);
  check(
    'a mesa importada tem codigo diferente da original',
    imported.session?.tableCode !== gmSession.tableCode,
  );

  const restored = await connect();
  const restoredState = (await rpc(restored, 'session:resume', { token: imported.session.token }))
    .state;
  check('cenas restauradas', restoredState.scenes.length === backup.scenes.length);
  check('fichas restauradas', restoredState.sheets.length === backup.sheets.length);
  check(
    'fichas restauradas voltam sem dono',
    restoredState.sheets.every((s) => s.ownerPlayerId === null),
  );
  check(
    'materiais restaurados voltam sem compartilhamento',
    restoredState.handouts.every((h) => !h.sharedWithAll && h.sharedWith.length === 0),
  );
  restored.disconnect();

  const badImport = await fetch(`${BASE}/api/tables/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup: { format: 999, scenes: [] }, gmName: 'X' }),
  });
  check('backup de formato desconhecido e recusado', badImport.status === 400);

  console.log('\n== 17. Personagem nasce com token ==');
  // Mesa propria, sem senha de mestre, para nao depender do estado acima.
  const fresh = await (
    await fetch(`${BASE}/api/tables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mesa das atualizacoes', gmName: 'Mestre' }),
    })
  ).json();
  const gm2 = await connect();
  const scene2 = (await rpc(gm2, 'session:resume', { token: fresh.session.token })).state.activeSceneId;
  const G = 70; // tamanho padrao da celula

  const alice = await connect();
  const aliceJoin = await rpc(alice, 'session:join', { code: fresh.session.tableCode, name: 'Alice' });
  const aliceId = aliceJoin.session.playerId;
  const aliceSheet = aliceJoin.state.sheets.find((s) => s.ownerPlayerId === aliceId);
  const aliceToken = aliceJoin.state.scenes
    .find((s) => s.id === scene2)
    ?.tokens.find((t) => t.sheetId === aliceSheet?.id);
  check('jogador que entra ganha o token do personagem', !!aliceToken);
  check('o token pertence ao jogador', aliceToken?.ownerPlayerId === aliceId);
  check('personagem nasce com visao 1', aliceToken?.visionRadius === 1);

  const bob = await connect();
  const bobJoin = await rpc(bob, 'session:join', { code: fresh.session.tableCode, name: 'Bob' });
  const bobId = bobJoin.session.playerId;
  const bobToken = bobJoin.state.scenes.find((s) => s.id === scene2)?.tokens.find((t) => t.ownerPlayerId === bobId);
  check(
    'personagens entrando em sequencia nao se empilham',
    !!bobToken && (bobToken.x !== aliceToken.x || bobToken.y !== aliceToken.y),
  );

  const npcSpawn = waitFor(gm2, 'tokens:patch', (p) => p.upsert?.some((t) => t.name === 'Capanga'));
  const npcSheet = await rpc(gm2, 'sheet:create', { name: 'Capanga' });
  const npcToken = (await npcSpawn)?.upsert.find((t) => t.name === 'Capanga');
  check('ficha criada pelo mestre tambem ganha token', npcToken?.sheetId === npcSheet.id);

  const handedOver = waitFor(gm2, 'tokens:patch', (p) =>
    p.upsert?.some((t) => t.sheetId === npcSheet.id && t.ownerPlayerId === bobId),
  );
  await rpc(gm2, 'sheet:assign', { sheetId: npcSheet.id, playerId: bobId });
  check('o token acompanha o novo dono da ficha', !!(await handedOver));

  console.log('\n== 18. Entrada como mestre ==');
  const summary2 = await (await fetch(`${BASE}/api/tables/${fresh.session.tableCode}`)).json();
  check('consulta informa que a mesa ja tem mestre', summary2.hasGm === true);
  const usurper = await connect();
  let usurpRefused = '';
  try {
    await rpc(usurper, 'session:join', { code: fresh.session.tableCode, name: 'Intruso', gmPassword: 'qualquer' });
  } catch (err) {
    usurpRefused = err.message;
  }
  check(
    'mesa sem senha e com mestre nao aceita outro mestre pelo convite',
    usurpRefused.includes('mestre'),
    usurpRefused || 'entrou como mestre',
  );
  usurper.disconnect();

  console.log('\n== 19. Cursores ficam privados ==');
  let cursorLeaked = false;
  bob.on('cursor:moved', () => (cursorLeaked = true));
  alice.emit('cursor:move', { sceneId: scene2, x: 10, y: 10 });
  await sleep(400);
  check('o ponteiro de um jogador nao chega aos outros', !cursorLeaked);

  console.log('\n== 20. Janelas e juntas de parede ==');
  await rpc(gm2, 'settings:update', { wallsBlockMovement: true });
  await rpc(gm2, 'scene:update', {
    sceneId: scene2,
    patch: { globalLight: 0, fog: { mode: 'vision', rememberExplored: false } },
  });
  await rpc(gm2, 'token:update', { sceneId: scene2, tokenId: aliceToken.id, patch: { visionRadius: 5 } });
  await sleep(300);

  const aCell = { a: Math.floor((aliceToken.x + G / 2) / G), b: Math.floor((aliceToken.y + G / 2) / G) };
  const pastWall = `${aCell.a + 2},${aCell.b}`;
  const lineX = (aCell.a + 1) * G;

  // Parede solida entre Alice e a celula alem dela: nao ve, e o jogador nao
  // recebe a parede comum.
  const solidWallsPatch = waitFor(alice, 'walls:patch', () => true, 800);
  const solidVision = waitFor(alice, 'fog:patch', (p) => !!p.computed);
  const glass = await rpc(gm2, 'wall:create', {
    sceneId: scene2,
    wall: { x1: lineX, y1: aliceToken.y - 3 * G, x2: lineX, y2: aliceToken.y + 4 * G },
  });
  const solidFog = await solidVision;
  check('visao calculada chega em campo proprio, sem reset cru', !!solidFog?.computed && !solidFog?.reset);
  check('parede solida esconde o outro lado', !solidFog?.computed.visible.includes(pastWall));
  const solidSent = await solidWallsPatch;
  check('parede comum nao e desenhada para o jogador', !solidSent?.upsert?.some((w) => w.id === glass.id));

  const windowVision = waitFor(alice, 'fog:patch', (p) => !!p.computed?.visible.includes(pastWall));
  const windowWalls = waitFor(alice, 'walls:patch', (p) => p.upsert?.some((w) => w.id === glass.id));
  await rpc(gm2, 'wall:update', { sceneId: scene2, wallId: glass.id, patch: { window: true } });
  check('janela deixa ver o outro lado', !!(await windowVision));
  check('o jogador recebe a janela para desenhar', !!(await windowWalls));

  let windowCrossRefused = false;
  try {
    await rpc(alice, 'token:move', { sceneId: scene2, tokenId: aliceToken.id, x: aliceToken.x + 2 * G, y: aliceToken.y, dragging: false });
  } catch {
    windowCrossRefused = true;
  }
  check('janela barra a passagem', windowCrossRefused);

  const dupWall = await rpc(gm2, 'wall:create', {
    sceneId: scene2,
    wall: { x1: lineX + 1, y1: aliceToken.y + 4 * G - 1, x2: lineX + 3 * G, y2: aliceToken.y + 4 * G },
  }).catch(() => null);
  check(
    'ponta quase junta e soldada a ponta existente',
    dupWall?.x1 === lineX && dupWall?.y1 === aliceToken.y + 4 * G,
    JSON.stringify(dupWall),
  );
  let zeroRefused = false;
  try {
    await rpc(gm2, 'wall:create', { sceneId: scene2, wall: { x1: 5, y1: 5, x2: 5, y2: 5 } });
  } catch {
    zeroRefused = true;
  }
  check('parede sem comprimento e recusada', zeroRefused);

  // Canto em L com o vertice exatamente no caminho diagonal do token do Bob.
  const bCell = { a: Math.floor((bobToken.x + G / 2) / G), b: Math.floor((bobToken.y + G / 2) / G) };
  const vx = (bCell.a + 1) * G;
  const vy = bCell.b * G;
  await rpc(gm2, 'wall:create', { sceneId: scene2, wall: { x1: vx, y1: vy - 3 * G, x2: vx, y2: vy } });
  await rpc(gm2, 'wall:create', { sceneId: scene2, wall: { x1: vx, y1: vy, x2: vx + 3 * G, y2: vy } });
  let cornerRefused = false;
  try {
    await rpc(bob, 'token:move', { sceneId: scene2, tokenId: bobToken.id, x: bobToken.x + G, y: bobToken.y - G, dragging: false });
  } catch {
    cornerRefused = true;
  }
  check('token nao escapa pela junta de um canto', cornerRefused);
  await rpc(gm2, 'settings:update', { wallsBlockMovement: false });

  console.log('\n== 21. Neblina sem strictVision chega ao jogador ==');
  await rpc(gm2, 'settings:update', { strictVision: false });
  await rpc(gm2, 'scene:update', { sceneId: scene2, patch: { fog: { mode: 'manual' } } });
  await sleep(300);
  const rawReveal = waitFor(alice, 'fog:patch', (p) => p.revealed?.add?.includes('40,40'));
  await rpc(gm2, 'fog:paint', { sceneId: scene2, cells: ['40,40', '41,40'], action: 'reveal' });
  check('area revelada pelo mestre chega ao jogador', !!(await rawReveal));
  const rawReset = waitFor(alice, 'fog:patch', (p) => !!p.reset);
  await rpc(gm2, 'fog:reset', { sceneId: scene2, scope: 'revealed' });
  const reset = await rawReset;
  check('reset do mestre chega ao jogador como listas cruas', !!reset && !reset.computed);
  await rpc(gm2, 'settings:update', { strictVision: true });

  console.log('\n== 22. Retratos na lista de presenca ==');
  const faceBuffer = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 200, g: 170, b: 90, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const faceForm = new FormData();
  faceForm.append('kind', 'portrait');
  faceForm.append('file', new Blob([faceBuffer], { type: 'image/png' }), 'alice.png');
  const face = (
    await (
      await fetch(`${BASE}/api/assets`, { method: 'POST', headers: { 'x-session-token': fresh.session.token }, body: faceForm })
    ).json()
  ).asset;

  const bobSeesFace = waitFor(bob, 'players:patch', (players) =>
    players.some((p) => p.id === aliceId && p.portraitAssetId === face.id),
  );
  const bobGetsFaceAsset = waitFor(bob, 'assets:patch', (p) => p.upsert?.some((a) => a.id === face.id));
  const tokenGetsFace = waitFor(gm2, 'tokens:patch', (p) =>
    p.upsert?.some((t) => t.id === aliceToken.id && t.assetId === face.id),
  );
  await rpc(alice, 'sheet:update', { sheetId: aliceSheet.id, portraitAssetId: face.id });
  check('o retrato do personagem chega a lista de presenca dos outros', !!(await bobSeesFace));
  check('com os dados da imagem, para nao aparecer quebrado', !!(await bobGetsFaceAsset));
  check('o token do personagem ganha o retrato', !!(await tokenGetsFace));

  alice.disconnect();
  bob.disconnect();
  gm2.disconnect();

  console.log('\n== 16. Reconexao mantem a identidade ==');
  player.disconnect();
  await sleep(300);
  const player2 = await connect();
  const resumed = await rpc(player2, 'session:resume', { token: joined.session.token });
  check('mesmo playerId apos reconectar', resumed.session.playerId === playerId);
  check(
    'ficha continua sendo a mesma',
    resumed.state.sheets.some((s) => s.id === playerSheet.id),
  );

  console.log('\n== 14. Persistencia ==');
  await sleep(2000); // aguarda o flush debounced do servidor
  const reloaded = await (await fetch(`${BASE}/api/tables/${gmSession.tableCode}`)).json();
  check('mesa continua consultavel', reloaded.name === 'Mesa de Teste');

  gm.disconnect();
  player2.disconnect();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${checks - failures}/${checks} verificacoes passaram`);
  if (failures > 0) console.log(`${failures} FALHA(S)`);
  console.log('='.repeat(52));
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nERRO NO TESTE:', err);
  process.exit(1);
});
