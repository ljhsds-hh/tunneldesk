import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const rootPackage = require('../package.json') as { version?: string };

export default defineConfig({
  plugins: [react()],
  define: {
    // Single source of truth for the version displayed in the UI.
    __APP_VERSION__: JSON.stringify(rootPackage.version ?? '0.0.0'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:19000',
        changeOrigin: false,
      },
      '/proxy.pac': {
        target: 'http://127.0.0.1:19000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
