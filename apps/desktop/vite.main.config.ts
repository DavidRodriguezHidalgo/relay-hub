import { defineConfig } from 'vite';

// Everything else (chokidar included) is bundled: the asar ships no node_modules.
export default defineConfig({
  build: { rollupOptions: { external: ['node:sqlite'] } },
});
