import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Durable Object base classes come from the Workers runtime; the API
    // integration tests import the Worker entry point, so stub that module.
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./test/support/cloudflare-workers.ts', import.meta.url)),
    },
  },
});
