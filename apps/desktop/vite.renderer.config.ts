import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { workspacePackages } from './workspace-packages';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // Our own packages are source, not dependencies. Left to the optimizer, Vite pre-bundles
    // them once and serves that cache until its config changes — so an export added to
    // @relay/shared was missing from the bundle, the renderer failed to evaluate, and the
    // window came up blank. Served from source they are always current.
    exclude: workspacePackages(),
  },
});
