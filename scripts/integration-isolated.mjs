import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'rpg-integration-'));
const uploads = path.join(scratch, 'uploads'); mkdirSync(uploads);
writeFileSync(path.join(scratch, 'test.db'), '');
const env = { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '18787', DATABASE_URL: `file:${path.join(scratch, 'test.db').replaceAll('\\', '/')}`, UPLOAD_DIR: uploads };
console.log(`Banco e uploads isolados: ${scratch}`);
execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'server/prisma/schema.prisma')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
let logs = '';
server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
let exit = 1;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('Servidor encerrou antes de iniciar.');
    try { ready = (await fetch('http://127.0.0.1:18787/api/health', { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Tempo limite ao iniciar servidor isolado.');
  const suite = spawn(process.execPath, ['scripts/e2e-check.mjs'], { cwd: root, env: { ...env, E2E_BASE_URL: 'http://127.0.0.1:18787' }, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => suite.kill(), 180000);
  exit = await new Promise(resolve => suite.once('exit', code => resolve(code ?? 1)));
  clearTimeout(timeout);
} catch (err) { console.error(err); }
finally {
  if (server.connected) server.send('shutdown');
  if (server.exitCode === null) {
    const timeout = setTimeout(() => server.kill(), 10000);
    await new Promise(resolve => server.once('exit', resolve)); clearTimeout(timeout);
  }
  if (exit) console.error(logs);
}
process.exitCode = exit;
