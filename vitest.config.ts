import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Os testes cobrem `shared/` (grid, visao, dados, fichas), o cliente (padrao
 * de icones) e as partes do servidor que nao dependem de banco nem de socket.
 *
 * E o codigo que quebra sem sintoma — um modificador com o sinal trocado, uma
 * diagonal que atravessa parede ou uma senha aceita sem conferir produzem
 * resultados plausiveis, e a suite e2e nao os alcanca.
 */
export default defineConfig({
  // O registro de icones e um .tsx; o JSX dele sai no runtime automatico do React.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@rpg/shared': path.resolve(here, 'shared/src/index.ts') },
  },
  test: {
    include: ['shared/src/**/*.test.ts', 'client/src/**/*.test.ts', 'server/src/**/*.test.ts'],
    environment: 'node',
  },
});
