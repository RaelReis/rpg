import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // O pacote compartilhado e consumido direto do fonte: nao ha passo de
      // build entre editar uma regra de visao e ve-la no navegador.
      '@rpg/shared': path.resolve(here, '../shared/src/index.ts'),
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/uploads': { target: 'http://localhost:8787', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:8787', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
