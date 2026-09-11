import type express from 'express';

/**
 * Tetos de recurso e limite de taxa.
 *
 * O servidor guarda a mesa inteira em memoria e serializa cada cena como um
 * JSON so. Sem teto, um cliente com defeito — ou um script — faz a memoria do
 * processo e o tamanho da linha no banco crescerem ate derrubar a aplicacao
 * para todo mundo. Os numeros abaixo sao folgados de proposito: ninguem
 * desenhando um mapa a mao chega perto deles, e quem chegar esta errando.
 */

export const LIMITS = {
  /** Por cena. */
  tokens: 500,
  tiles: 1000,
  effects: 200,
  walls: 4000,
  /** Por mesa. */
  scenes: 100,
  players: 50,
  sheets: 200,
  assets: 2000,
} as const;

export const LIMIT_MESSAGES: Record<keyof typeof LIMITS, string> = {
  tokens: 'Limite de tokens desta cena atingido.',
  tiles: 'Limite de peças desta cena atingido.',
  effects: 'Limite de efeitos desta cena atingido.',
  walls: 'Limite de paredes desta cena atingido.',
  scenes: 'Limite de cenas desta mesa atingido.',
  players: 'Esta mesa já está cheia.',
  sheets: 'Limite de fichas desta mesa atingido.',
  assets: 'Limite de imagens desta mesa atingido.',
};

/**
 * `true` quando a colecao ja esta no teto. Quem chama devolve
 * `LIMIT_MESSAGES[what]` — a mensagem diz o que encheu, e nao apenas que
 * falhou, porque o mestre precisa saber o que apagar.
 */
export function atCapacity(list: { length: number }, what: keyof typeof LIMITS): boolean {
  return list.length >= LIMITS[what];
}

// ---------------------------------------------------------------------------
// Limite de taxa
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Limitador por IP em memoria, no mesmo espirito do que ja protege os eventos
 * de socket. Uma dependencia a mais nao se justifica para uma janela fixa, e
 * o estado morre com o processo — que e exatamente o desejado aqui.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  message: string;
}): express.RequestHandler {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    const now = Date.now();

    // Varre o que expirou antes de medir, senao o mapa cresce com cada IP que
    // aparece uma vez e nunca mais volta.
    if (buckets.size > 512) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const key = req.ip ?? req.socket.remoteAddress ?? 'desconhecido';
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (++bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: options.message });
    }

    next();
  };
}
