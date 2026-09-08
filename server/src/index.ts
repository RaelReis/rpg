import http from 'node:http';
import path from 'node:path';

import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { UPLOAD_LIMITS, type AssetKind } from '@rpg/shared';

import { socketsOf, type TypedServer } from './broadcast.js';
import { prisma } from './db.js';
import { CLIENT_DIST, CLIENT_ORIGINS, IS_PROD, PORT, UPLOAD_DIR } from './env.js';
import { rooms } from './room.js';
import { registerSocketHandlers } from './socket.js';
import { isAssetKind, saveImage, UploadError } from './uploads.js';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: IS_PROD ? true : CLIENT_ORIGINS, credentials: true }));

/**
 * Imagens sao servidas como arquivos estaticos e sao imutaveis (o nome contem
 * um id gerado), entao podem ser cacheadas agressivamente pelo navegador.
 */
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '30d',
    immutable: true,
    index: false,
    dotfiles: 'ignore',
  }),
);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/** Criacao de mesa: unica operacao que acontece antes de existir uma sessao. */
app.post('/api/tables', async (req, res) => {
  const name = String(req.body?.name ?? '').slice(0, 80).trim();
  const gmName = String(req.body?.gmName ?? '').slice(0, 40).trim();
  const gmPassword = String(req.body?.gmPassword ?? '');

  if (!name) return res.status(400).json({ error: 'Informe o nome da mesa.' });
  if (!gmName) return res.status(400).json({ error: 'Informe seu nome de mestre.' });

  try {
    const { room, gmPlayerId, gmToken } = await rooms.createTable({ name, gmName, gmPassword });
    res.json({
      session: {
        tableId: room.state.id,
        tableCode: room.state.code,
        playerId: gmPlayerId,
        role: 'GM',
        token: gmToken,
        name: gmName,
      },
    });
  } catch (err) {
    console.error('[api] falha ao criar mesa:', err);
    res.status(500).json({ error: 'Nao foi possivel criar a mesa.' });
  }
});

/** Checagem do codigo antes de entrar, para dar erro cedo na tela de login. */
app.get('/api/tables/:code', async (req, res) => {
  const room = await rooms.loadByCode(String(req.params.code ?? ''));
  if (!room) return res.status(404).json({ error: 'Mesa nao encontrada.' });
  res.json({
    code: room.state.code,
    name: room.state.name,
    requiresGmPassword: Boolean(
      (await prisma.table.findUnique({
        where: { id: room.state.id },
        select: { gmPasswordHash: true },
      }))?.gmPasswordHash,
    ),
    players: room.state.players.filter((p) => p.connected).length,
  });
});

// ---------------------------------------------------------------------------
// Upload de imagens
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Teto absoluto; o limite por tipo (mapa, token, retrato) e conferido depois.
    fileSize: Math.max(...Object.values(UPLOAD_LIMITS)),
    files: 1,
  },
});

/** O jogador sobe o proprio material; mapas e tiles sao do mestre. */
const PLAYER_ALLOWED_KINDS: AssetKind[] = ['portrait', 'item', 'token'];

app.post('/api/assets', upload.single('file'), async (req, res) => {
  const token = String(req.header('x-session-token') ?? '');
  if (!token) return res.status(401).json({ error: 'Sessao ausente.' });

  const resolved = await rooms.resolveSession(token);
  if (!resolved) return res.status(401).json({ error: 'Sessao invalida.' });

  const { room, playerId } = resolved;
  const player = room.player(playerId);
  if (!player) return res.status(401).json({ error: 'Jogador nao encontrado.' });

  const kind = String(req.body?.kind ?? 'token');
  if (!isAssetKind(kind)) return res.status(400).json({ error: 'Tipo de imagem invalido.' });
  if (player.role !== 'GM' && !PLAYER_ALLOWED_KINDS.includes(kind)) {
    return res.status(403).json({ error: 'Apenas o mestre pode enviar este tipo de imagem.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  try {
    const asset = await saveImage({
      buffer: req.file.buffer,
      kind,
      tableId: room.state.id,
      originalName: req.file.originalname ?? 'imagem',
      uploadedBy: playerId,
    });

    room.state.assets.push(asset);

    // A lista de imagens da mesa e material do mestre; o jogador recebe apenas
    // o que acabou de enviar, para poder usa-lo na hora.
    for (const socket of socketsOf(room)) {
      const viewer = socket.data.viewer;
      if (viewer.role === 'GM' || viewer.playerId === playerId) {
        socket.emit('assets:patch', { upsert: [asset] });
      }
    }

    res.json({ asset });
  } catch (err) {
    if (err instanceof UploadError) return res.status(400).json({ error: err.message });
    console.error('[upload] falha:', err);
    res.status(500).json({ error: 'Falha ao processar a imagem.' });
  }
});

// Erros do multer (arquivo grande demais) precisam de resposta propria, senao
// o cliente recebe um HTML de stack trace em vez de uma mensagem util.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Arquivo acima do limite permitido.'
        : `Falha no upload: ${err.message}`;
    return res.status(400).json({ error: message });
  }
  next(err);
});

// ---------------------------------------------------------------------------
// Cliente em producao
// ---------------------------------------------------------------------------

if (IS_PROD) {
  app.use(express.static(CLIENT_DIST, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// ---------------------------------------------------------------------------

const server = http.createServer(app);

const io: TypedServer = new Server(server, {
  cors: { origin: IS_PROD ? true : CLIENT_ORIGINS, credentials: true },
  // Sobrevive a quedas curtas de rede sem derrubar a sessao: o cliente
  // reconecta e continua de onde parou.
  pingTimeout: 25000,
  pingInterval: 10000,
  maxHttpBufferSize: 2 * 1024 * 1024,
});

registerSocketHandlers(io);

server.listen(PORT, () => {
  console.log(`\n  RPG VTT — servidor em http://localhost:${PORT}`);
  if (!IS_PROD) console.log(`  cliente (dev): ${CLIENT_ORIGINS.join(', ')}\n`);
});

/** Nada de perder o ultimo movimento por causa de um Ctrl+C. */
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[${signal}] encerrando; gravando estado pendente...`);
  io.close();
  await rooms.flushAll();
  await prisma.$disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
