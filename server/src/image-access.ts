import { stateForViewer } from './filter.js';
import { hashToken } from './auth.js';
import { asyncRoute } from './http.js';
import path from 'node:path';

import express from 'express';

import { UPLOAD_DIR } from './env.js';
import { rooms } from './room.js';

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
  return tokens.slice(0, 24);
}

function writeCookie(res: express.Response, tokens: string[], name: string): void {
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
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
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
    writeCookie(res, [token], `${COOKIE}_${hashToken(token).slice(0, 16)}`);
    res.json({ ok: true });
  }));

  app.delete('/api/session/image-access', (req, res) => {
    const token = String(req.header('x-session-token') ?? '');
    if (!token || token.length > 256) return res.sendStatus(400);
    writeCookie(res, [], `${COOKIE}_${hashToken(token).slice(0, 16)}`);
    res.json({ ok: true });
  });
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
      const allowed = new Set(stateForViewer(resolved.room, { playerId: player.id, role: player.role }).assets.map(a => a.id));
      const owns = resolved.room.state.assets.filter(a => allowed.has(a.id) || a.uploadedBy === player.id).some(
        (a) => a.url.endsWith(`/${rel}`) || a.thumbUrl?.endsWith(`/${rel}`),
      );
      if (owns) return next();
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
