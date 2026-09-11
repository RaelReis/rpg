import http from 'node:http';
import path from 'node:path';

import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { UPLOAD_LIMITS, type AssetKind } from '@rpg/shared';

import { BackupError, exportTable, importTable, parseBackup } from './backup.js';
import { socketsOf, type TypedServer } from './broadcast.js';
import { configureSqlite, prisma } from './db.js';
import { CLIENT_DIST, CLIENT_ORIGINS, HOST, IS_PROD, PORT, TRUST_PROXY, UPLOAD_DIR } from './env.js';
import { guardUploads, registerImageAccessRoutes, uploadsStatic } from './image-access.js';
import { atCapacity, LIMIT_MESSAGES, rateLimit } from './limits.js';
import { rooms } from './room.js';
import { registerSocketHandlers } from './socket.js';
import { isAssetKind, saveImage, UploadError } from './uploads.js';

const app = express();

// Precisa vir antes de qualquer coisa que leia req.ip.
if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);

/**
 * Corpo pequeno em tudo, menos onde um backup precisa passar.
 *
 * O parser global roda antes das rotas: montado sem excecao, ele consome o
 * corpo da importacao com o teto de 256kb e o limite maior declarado na rota
 * nunca chega a valer — qualquer backup real volta 413.
 */
const jsonSmall = express.json({ limit: '256kb' });
const BIG_BODY_PATHS = new Set(['/api/tables/import']);

app.use((req, res, next) => {
  if (BIG_BODY_PATHS.has(req.path)) return next();
  jsonSmall(req, res, next);
});
app.use(cors({ origin: IS_PROD ? true : CLIENT_ORIGINS, credentials: true }));

registerImageAccessRoutes(app);

/**
 * Imagens: primeiro a autorizacao, depois o arquivo.
 *
 * Sao imutaveis (o nome contem um id gerado), entao seguem cacheaveis pelo
 * navegador — mas o cache so entra em jogo depois que a sessao foi aceita.
 */
app.use('/uploads', guardUploads(), uploadsStatic);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/**
 * Criar e importar sao as duas rotas que existem antes de qualquer sessao —
 * nao ha identidade para exigir. Ambas escrevem no banco e a importacao grava
 * arquivos, entao a protecao possivel e a taxa.
 *
 * Os tetos sao folgados de proposito. O alvo e o laco automatizado, que faz
 * milhares de pedidos: qualquer numero nesta ordem de grandeza o barra. Ja um
 * teto justo pega quem nao deveria — uma mesa inteira atras do mesmo NAT
 * chega com um IP so, e a suite de testes cria e importa varias vezes
 * seguidas. Errar para o lado generoso custa pouco; errar para o outro
 * bloqueia gente de verdade.
 */
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Muitas mesas criadas deste endereco. Tente de novo em uma hora.',
});

const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Muitas importacoes deste endereco. Tente de novo em uma hora.',
});

/** Criacao de mesa: unica operacao que acontece antes de existir uma sessao. */
app.post('/api/tables', createLimiter, async (req, res) => {
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
    // A tela de entrada esconde "entrar como mestre" quando a mesa ja tem um.
    hasGm: room.state.players.some((p) => p.role === 'GM'),
  });
});

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** Exporta a mesa inteira. Restrito ao mestre: o arquivo contem tudo. */
app.get('/api/tables/:id/export', async (req, res) => {
  const token = String(req.header('x-session-token') ?? '');
  const resolved = token ? await rooms.resolveSession(token) : null;
  if (!resolved) return res.status(401).json({ error: 'Sessao invalida.' });

  const { room, playerId } = resolved;
  if (room.player(playerId)?.role !== 'GM') {
    return res.status(403).json({ error: 'Apenas o mestre exporta a mesa.' });
  }
  if (room.state.id !== req.params.id) {
    return res.status(403).json({ error: 'Sessao nao pertence a esta mesa.' });
  }

  try {
    // Sem imagens o arquivo fica pequeno o bastante para versionar; com elas,
    // e um backup de verdade. Quem pede escolhe.
    const backup = await exportTable(room, req.query.assets !== '0');
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = room.state.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'mesa';

    res.setHeader('Content-Disposition', `attachment; filename="${slug}-${stamp}.json"`);
    res.json(backup);
  } catch (err) {
    console.error('[backup] falha ao exportar:', err);
    res.status(500).json({ error: 'Falha ao gerar o backup.' });
  }
});

/** Importa um backup como uma mesa NOVA, sem tocar em nada existente. */
// O teto acompanha MAX_EMBEDDED_BYTES do export mais a inflacao do base64: um
// backup gerado aqui tem de poder voltar. Quem contem o abuso e o limitador
// acima, nao o tamanho — que existe para o arquivo legitimo caber.
app.post('/api/tables/import', importLimiter, express.json({ limit: '200mb' }), async (req, res) => {
  const gmName = String(req.body?.gmName ?? '').slice(0, 40).trim();
  if (!gmName) return res.status(400).json({ error: 'Informe seu nome de mestre.' });

  try {
    const backup = parseBackup(req.body?.backup);
    const result = await importTable(backup, gmName, String(req.body?.gmPassword ?? ''));

    res.json({
      session: {
        tableId: result.room.state.id,
        tableCode: result.room.state.code,
        playerId: result.gmPlayerId,
        role: 'GM',
        token: result.gmToken,
        name: gmName,
      },
      missingAssets: result.missingAssets,
    });
  } catch (err) {
    if (err instanceof BackupError) return res.status(400).json({ error: err.message });
    console.error('[backup] falha ao importar:', err);
    res.status(500).json({ error: 'Falha ao importar o backup.' });
  }
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
  if (atCapacity(room.state.assets, 'assets')) {
    return res.status(409).json({ error: LIMIT_MESSAGES.assets });
  }

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

// Antes de aceitar conexoes: WAL e busy_timeout mudam como o SQLite se
// comporta sob escritas simultaneas.
await configureSqlite();

const onListening = (): void => {
  console.log(`\n  RPG VTT — servidor em http://localhost:${PORT}`);
  if (!IS_PROD) console.log(`  cliente (dev): ${CLIENT_ORIGINS.join(', ')}\n`);
};

if (HOST) server.listen(PORT, HOST, onListening);
else server.listen(PORT, onListening);

let shuttingDown = false;

/** Nada de perder o ultimo movimento por causa de um Ctrl+C. */
async function shutdown(signal: string): Promise<void> {
  // No Windows, sob o `npm run share`, o Ctrl+C do console e o pedido por IPC
  // chegam os dois: gravar e fechar duas vezes so atrapalharia.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] encerrando; gravando estado pendente...`);
  io.close();
  await rooms.flushAll();
  await prisma.$disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

/**
 * Ultima camada. Os handlers de socket ja tem guarda propria; isto cobre o
 * resto — rotas HTTP assincronas, timers, qualquer promessa esquecida.
 *
 * Promessa rejeitada afeta um pedido: registra e segue, porque derrubar o
 * processo encerraria a sessao de todas as mesas por causa de um so.
 * Excecao sincrona e diferente: o estado pode ter ficado pela metade, e seguir
 * rodando e arriscar gravar lixo. Grava o que estiver pendente e encerra; quem
 * supervisiona o processo (o `npm run share`, por exemplo) sobe de novo, e os
 * clientes reconectam sozinhos pela sessao guardada.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[processo] promessa rejeitada sem tratamento:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[processo] excecao nao tratada; gravando e encerrando:', err);
  setTimeout(() => process.exit(1), 3000).unref();
  void rooms.flushAll().finally(() => process.exit(1));
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Pedido de encerramento vindo de um supervisor (o `npm run share`). E o unico
// jeito portavel: no Windows, matar um processo filho e TerminateProcess, que
// encerra sem rodar handler nenhum — e sem gravar o estado pendente.
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown('supervisor');
});
