/**
 * `npm run share` — abre a mesa para os amigos pela internet.
 *
 * Compila o cliente, sobe o servidor em modo producao e abre um Cloudflare
 * Tunnel, que devolve um link https publico sem mexer no roteador e sem expor
 * o IP de casa. Ctrl+C encerra tudo e grava o estado pendente.
 *
 * Tres decisoes que moldam o script:
 *
 * - O servidor escuta so em 127.0.0.1. O tunnel vira a unica porta de entrada,
 *   e e isso que torna seguro confiar no X-Forwarded-For (TRUST_PROXY=1): sem
 *   acesso direto, ninguem forja o proprio IP para escapar do limite de taxa.
 *
 * - O servidor e supervisionado. Se ele cair no meio da sessao, sobe de novo
 *   sozinho; o tunnel continua de pe, o link nao muda, e os navegadores
 *   reconectam pela sessao guardada. Saida com codigo 0 e encerramento pedido
 *   e nao reinicia. Quedas em sequencia desistem, para nao girar em falso.
 *
 * - O tunnel NAO e reiniciado. Um tunnel novo gera um link novo, e os amigos
 *   ficariam presos no antigo sem saber; melhor parar e avisar.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');
const TSX_PACKAGE = path.join(ROOT, 'node_modules', 'tsx', 'package.json');

const PORT = Number(process.env.PORT ?? 8787);
// 127.0.0.1 e nao localhost: com o servidor preso ao IPv4, um `localhost` que
// resolva primeiro para ::1 bateria numa porta fechada.
const TARGET = `http://127.0.0.1:${PORT}`;
const CLOUDFLARED = process.env.CLOUDFLARED ?? 'cloudflared';
const SKIP_BUILD = process.argv.includes('--no-build');

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const TUNNEL_URL = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;

let server = null;
let tunnel = null;
let stopping = false;
const restarts = [];

const log = (msg) => console.log(`[share] ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Checagens antes de subir qualquer coisa
// ---------------------------------------------------------------------------

function requireCloudflared() {
  const probe = spawnSync(CLOUDFLARED, ['--version'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return;

  console.error(`
  O cloudflared nao foi encontrado.

  Instale uma vez:
    Windows:  winget install --id Cloudflare.cloudflared
    macOS:    brew install cloudflared

  Depois feche e abra o terminal (para o PATH atualizar) e rode
  \`npm run share\` de novo.
`);
  process.exit(1);
}

async function isResponding() {
  try {
    const res = await fetch(`${TARGET}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function requireFreePort() {
  if (!(await isResponding())) return;
  console.error(`
  Ja existe um servidor respondendo na porta ${PORT} — provavelmente o
  \`npm run dev\`. Encerre-o antes de compartilhar: os dois disputariam o
  mesmo banco e a mesma porta.
`);
  process.exit(1);
}

function build() {
  if (SKIP_BUILD) return log('pulando a compilacao (--no-build)');
  log('compilando o cliente...');
  const result = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error('\n  A compilacao falhou; nada foi publicado.\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Servidor supervisionado
// ---------------------------------------------------------------------------

function startServer() {
  if (!existsSync(TSX_PACKAGE)) {
    console.error('\n  tsx nao encontrado. Rode `npm install`.\n');
    process.exit(1);
  }

  // Sem shell e sem a CLI do tsx, que criaria um neto: o filho e o proprio
  // Node com o loader do tsx, para que o canal IPC chegue no servidor de fato.
  server = spawn(process.execPath, ['--import', 'tsx', 'src/start.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      TRUST_PROXY: '1',
      PORT: String(PORT),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  server.on('exit', (code, signal) => {
    server = null;
    if (stopping) return;

    if (code === 0) {
      log('o servidor encerrou normalmente; fechando o tunnel.');
      void stop(0);
      return;
    }

    const now = Date.now();
    restarts.push(now);
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();

    if (restarts.length > MAX_RESTARTS) {
      console.error(
        `\n  O servidor caiu ${restarts.length} vezes em um minuto; desistindo. ` +
          'Veja o erro acima.\n',
      );
      void stop(1);
      return;
    }

    log(`o servidor caiu (${signal ?? `codigo ${code}`}); subindo de novo...`);
    setTimeout(() => {
      if (!stopping) startServer();
    }, 1000);
  });
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isResponding()) return true;
    if (!server) return false;
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tunnel
// ---------------------------------------------------------------------------

function startTunnel() {
  return new Promise((resolve) => {
    tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', TARGET], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // O cloudflared fala muito; so interessa o link e, se der errado, o final.
    const recent = [];
    let announced = false;

    const onData = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        recent.push(line);
        if (recent.length > 15) recent.shift();

        const match = !announced && line.match(TUNNEL_URL);
        if (match) {
          announced = true;
          resolve(match[0]);
        }
      }
    };

    tunnel.stdout.on('data', onData);
    tunnel.stderr.on('data', onData);

    tunnel.on('exit', (code) => {
      tunnel = null;
      if (stopping) return;
      console.error(`\n  O tunnel fechou (codigo ${code}). Ultimas linhas do cloudflared:\n`);
      for (const line of recent) console.error(`    ${line}`);
      console.error('\n  Rode `npm run share` de novo para gerar um link novo.\n');
      if (!announced) resolve(null);
      void stop(1);
    });
  });
}

// ---------------------------------------------------------------------------
// Encerramento
// ---------------------------------------------------------------------------

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;

  if (tunnel) tunnel.kill();

  if (server) {
    log('gravando o estado e encerrando o servidor...');
    // Pedido por IPC, e nao por sinal: no Windows `kill` e TerminateProcess e
    // encerraria sem gravar. Vale tambem quando quem caiu foi o tunnel, caso
    // em que nenhum Ctrl+C chegou ao servidor.
    try {
      if (server.connected) server.send('shutdown');
    } catch {
      // Canal ja fechado: o servidor esta saindo por conta propria.
    }

    const exited = new Promise((resolve) => server?.once('exit', resolve));
    const done = await Promise.race([exited.then(() => true), sleep(8000).then(() => false)]);
    if (!done && server) {
      log('o servidor nao respondeu a tempo; forcando o encerramento.');
      server.kill('SIGKILL');
    }
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

// ---------------------------------------------------------------------------

requireCloudflared();
await requireFreePort();
build();

log('subindo o servidor em modo producao...');
startServer();
if (!(await waitForServer())) {
  console.error('\n  O servidor nao respondeu. Veja o erro acima.\n');
  await stop(1);
}

log('abrindo o tunnel...');
const url = await startTunnel();
if (url) {
  console.log(`
  ============================================================

    Mesa no ar. Mande este link para os amigos:

      ${url}

    Voce (mestre) tambem pode usar: http://localhost:${PORT}

    O link muda a cada \`npm run share\`.
    Ctrl+C encerra tudo e grava a mesa.

  ============================================================
`);
}
