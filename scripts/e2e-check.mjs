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
  await rpc(gm, 'wall:create', {
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
  const imgRes = await fetch(`${BASE}${uploaded.asset.url}`);
  check('imagem servida pelo servidor', imgRes.ok);

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

  console.log('\n== 13. Reconexao mantem a identidade ==');
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
