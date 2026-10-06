import { stateForViewer } from './filter.js';
import { hashToken } from './auth.js';
import { asyncRoute } from './http.js';
import path from 'node:path';

import express from 'express';

import type { Player } from '@rpg/shared';

import { UPLOAD_DIR } from './env.js';
import { rooms, type Room } from './room.js';

/**
 * Autorizacao das imagens servidas em `/uploads`.
 *
 * Todo o cuidado de nao mandar ao jogador o mapa da proxima cena se apoiava em
 * manter a URL secreta: a pasta era servida como estatica, sem checagem
 * nenhuma. Quem tivesse a URL — inclusive alguem removido da mesa — continuava
 * baixando o arquivo para sempre, e a URL vaza pelo historico, pelo cache ou
 * por um print.
 *
 * O cabecalho de sessao nao serve aqui: `<img src>` nao manda cabecalhos. Por
 * isso a autorizacao vem de um cookie HttpOnly que o navegador anexa sozinho a
 * cada imagem — sem mudar uma unica tag do cliente. Ele guarda VARIOS tokens
 * porque um mestre com duas mesas abertas em abas diferentes precisa ver as
 * imagens das duas; sem isso a segunda aba apagaria o acesso da primeira.
 */

const COOKIE = 'rpg_img';

/** Alem disto o cookie so cresce; abas antigas cedem lugar as recentes. */
const MAX_TOKENS = 24;

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * `decodeURIComponent` sem rede de protecao.
 *
 * A funcao lanca URIError com um `%` malformado, e tanto o caminho quanto o
 * cookie chegam aqui exatamente como o cliente os mandou. Dentro de um
 * middleware assincrono, essa excecao virava promessa rejeitada sem
 * tratamento — e um unico GET para `/uploads/%E0%A4%A` derrubava o processo.
 */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function readTokens(req: express.Request): string[] {
  const tokens: string[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq).trim();
    if (eq < 0 || (name !== COOKIE && !name.startsWith(`${COOKIE}_`))) continue;
    tokens.push(...(safeDecode(part.slice(eq + 1).trim()) ?? '').split(',').filter(Boolean));
  }
  // Os ULTIMOS, nao os primeiros: o navegador manda os cookies mais antigos
  // na frente (RFC 6265), entao `slice(0, 24)` guardava as sessoes velhas e
  // jogava fora justamente a que a pessoa acabou de abrir.
  return tokens.slice(-MAX_TOKENS);
}

function writeCookie(req: express.Request, res: express.Response, tokens: string[], name: string): void {
  const value = encodeURIComponent(tokens.join(','));
  const attrs = [
    `${name}=${value}`,
    // Restrito a /uploads: o cookie nao acompanha as chamadas de API, que ja
    // se autenticam pelo cabecalho.
    'Path=/uploads',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${tokens.length ? MAX_AGE_SECONDS : 0}`,
  ];
  // `Secure` acompanha o pedido, nao o NODE_ENV. Marcado em toda producao, o
  // `npm start` na rede local (http://192.168.x.x) entregava um cookie que o
  // navegador descarta em origem insegura, e os jogadores ficavam sem nenhuma
  // imagem — so o mestre via, porque o Chrome abre excecao para localhost.
  // `req.secure` respeita o `trust proxy`, entao atras do tunnel (https na
  // borda, X-Forwarded-Proto) o cookie continua saindo com `Secure`.
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/**
 * Troca o token de sessao por permissao de ver as imagens da mesa.
 *
 * O cliente chama isto ao entrar; o cookie resultante e o que faz cada
 * `<img>` ser aceito depois.
 */
export function registerImageAccessRoutes(app: express.Express): void {
  app.post('/api/session/image-access', asyncRoute(async (req, res) => {
    const token = String(req.header('x-session-token') ?? '');
    if (!token) return res.status(401).json({ error: 'Sessao ausente.' });
    if (!(await rooms.resolveSession(token))) {
      return res.status(401).json({ error: 'Sessao invalida.' });
    }

    // O token novo vai para a frente; os antigos seguem validos ate o teto.
    writeCookie(req, res, [token], `${COOKIE}_${hashToken(token).slice(0, 16)}`);
    res.json({ ok: true });
  }));

  app.delete('/api/session/image-access', (req, res) => {
    const token = String(req.header('x-session-token') ?? '');
    if (!token || token.length > 256) return res.sendStatus(400);
    writeCookie(req, res, [], `${COOKIE}_${hashToken(token).slice(0, 16)}`);
    res.json({ ok: true });
  });
}

/**
 * Por quanto tempo o conjunto de imagens de um jogador e reaproveitado.
 *
 * E tambem o teto do atraso de uma revogacao: quem deixa de poder ver uma
 * imagem (pista descompartilhada, token que sumiu na neblina) ainda consegue
 * baixa-la por ate este tempo. Dois segundos cobrem a rajada de pedidos de uma
 * cena abrindo, que e o que o cache existe para absorver, e ficam abaixo do
 * que alguem levaria para aproveitar a janela. Expulsao nao passa por aqui:
 * `rooms.resolveSession` e `room.player` barram na hora.
 */
export const IMAGE_ACCESS_CACHE_MS = 2000;

/** Uma entrada por jogador por mesa; o teto so existe para o mapa nao crescer sem fim. */
const IMAGE_ACCESS_CACHE_MAX = 1024;

interface AccessEntry {
  room: Room;
  role: Player['role'];
  at: number;
  urls: string[];
}

/**
 * Conjunto de imagens permitidas, por jogador, por poucos segundos.
 *
 * `guardUploads` recalculava `stateForViewer` inteiro — visao incluida — a
 * cada imagem pedida: 30 imagens numa cena com luz global eram 30 calculos de
 * ~21 ms, com o servidor parado para todo mundo enquanto isso. E como as
 * imagens saem com `no-cache`, toda revalidacao do navegador repetia a conta.
 *
 * A chave leva mesa e jogador, e a entrada guarda a `Room` e o papel de quando
 * foi calculada: o conjunto de um jogador nunca responde por outro, nem pelo
 * mesmo jogador depois de mudar de papel ou de a mesa ser recarregada.
 */
const accessCache = new Map<string, AccessEntry>();

/** So para os testes conferirem o teto. */
export function imageAccessCacheSize(): number {
  return accessCache.size;
}

function computeAllowedUrls(room: Room, player: Player): string[] {
  const allowed = new Set(stateForViewer(room, { playerId: player.id, role: player.role }).assets.map(a => a.id));
  const urls: string[] = [];
  for (const a of room.state.assets) {
    if (!allowed.has(a.id) && a.uploadedBy !== player.id) continue;
    urls.push(a.url);
    if (a.thumbUrl) urls.push(a.thumbUrl);
  }
  return urls;
}

function cachedAllowedUrls(key: string, room: Room, player: Player): string[] | null {
  const entry = accessCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.at;
  // `age < 0` e relogio que andou para tras: sem este lado da conta a entrada
  // valeria ate o relogio alcancar de novo o instante em que foi gravada.
  if (entry.room !== room || entry.role !== player.role || age < 0 || age >= IMAGE_ACCESS_CACHE_MS) {
    accessCache.delete(key);
    return null;
  }
  return entry.urls;
}

function rememberAllowedUrls(key: string, room: Room, player: Player, urls: string[]): void {
  // Mesma politica do cache de sessao: varre o vencido antes de crescer.
  if (!accessCache.has(key) && accessCache.size >= IMAGE_ACCESS_CACHE_MAX) {
    const now = Date.now();
    for (const [k, entry] of accessCache) {
      const age = now - entry.at;
      if (age < 0 || age >= IMAGE_ACCESS_CACHE_MS) accessCache.delete(k);
    }
    if (accessCache.size >= IMAGE_ACCESS_CACHE_MAX) accessCache.clear();
  }
  // `at` e o instante do calculo e nao e renovado no uso: pedir imagens sem
  // parar nao pode esticar o acesso alem da janela.
  accessCache.set(key, { room, role: player.role, at: Date.now(), urls });
}

/**
 * Deixa passar apenas quem tem sessao numa mesa dona do arquivo.
 *
 * A lista de assets da sala ja esta em memoria, e a sessao vem do cache curto
 * de `rooms.resolveSession`. Sem esse cache, este comentario prometia "nenhuma
 * consulta ao banco" enquanto cada imagem custava uma consulta por token
 * guardado no cookie — trinta imagens numa cena, trinta idas ao SQLite.
 */
export function guardUploads(): express.RequestHandler {
  return async (req, res, next) => {
    // `/uploads/x.png` e `/uploads/thumbs/x.webp` — o que identifica o arquivo
    // e o caminho relativo inteiro, nao so o nome.
    const rel = safeDecode(req.path.replace(/^\/+/, ''));
    if (!rel || rel.includes('..')) return res.sendStatus(400);

    const tokens = readTokens(req);
    if (tokens.length === 0) {
      return res.status(401).json({ error: 'Entre na mesa para ver as imagens.' });
    }

    for (const token of tokens) {
      const resolved = await rooms.resolveSession(token).catch(() => null);
      if (!resolved) continue;

      const player = resolved.room.player(resolved.playerId);
      if (!player) continue;
      const key = `${resolved.room.state.id}
${player.id}`;
      const owns = (urls: string[]) => urls.some((url) => url.endsWith(`/${rel}`));

      const cached = cachedAllowedUrls(key, resolved.room, player);
      if (cached && owns(cached)) return next();

      // O cache so e ouvido quando diz sim. Um "nao" guardado recusaria por
      // dois segundos a imagem que o jogador acabou de enviar ou de receber
      // (o retrato da entrada, a pista recem-compartilhada). Recalcular aqui
      // custa o mesmo de antes e so acontece para arquivo que ele nao via.
      const fresh = computeAllowedUrls(resolved.room, player);
      rememberAllowedUrls(key, resolved.room, player, fresh);
      if (owns(fresh)) return next();
    }

    // Existe mas nao e desta mesa: 404 em vez de 403, para nao confirmar a
    // quem tenta adivinhar que aquele id de imagem existe em algum lugar.
    res.sendStatus(404);
  };
}

export const uploadsStatic = express.static(UPLOAD_DIR, {
  // Revalidate access after sharing changes; downloaded copies remain local.
  maxAge: 0,
  immutable: false,
  setHeaders: res => res.setHeader('Cache-Control', 'private, no-cache'),
  index: false,
  dotfiles: 'ignore',
});

export const UPLOADS_ROOT = path.resolve(UPLOAD_DIR);
