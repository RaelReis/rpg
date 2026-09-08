import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuracao do servidor. O .env e lido a mao para nao adicionar uma
 * dependencia so por isso — o Prisma ja le o dele por conta propria.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(SERVER_ROOT, '.env'));

export const PORT = Number(process.env.PORT ?? 8787);

/**
 * Origens aceitas pelo CORS e pelo handshake do socket. Em dev o Vite serve
 * em 5173; em producao o proprio servidor entrega o build do cliente e a
 * origem passa a ser a mesma, dispensando a lista.
 */
export const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const UPLOAD_DIR = path.resolve(
  SERVER_ROOT,
  process.env.UPLOAD_DIR ?? './uploads',
);

export const CLIENT_DIST = path.resolve(PROJECT_ROOT, 'client', 'dist');

export const IS_PROD = process.env.NODE_ENV === 'production';

/** Mesas sem ninguem conectado saem da memoria depois disto (ficam no banco). */
export const ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Janela de agrupamento das escritas no banco. */
export const PERSIST_DEBOUNCE_MS = 1500;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'thumbs'), { recursive: true });
