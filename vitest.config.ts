import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Os testes cobrem `shared/`: a matematica de grid, visao, dados e fichas.
 *
 * E o codigo que roda nos dois lados e que quebra sem sintoma — um
 * modificador com o sinal trocado ou uma diagonal que atravessa parede
 * produzem resultados plausiveis, e a suite e2e nao os alcanca.
 */
export default defineConfig({
  resolve: {
    alias: { '@rpg/shared': path.resolve(here, 'shared/src/index.ts') },
  },
  test: {
    include: ['shared/src/**/*.test.ts'],
    environment: 'node',
  },
});
