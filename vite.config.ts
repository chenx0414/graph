import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { compressWebAssets } from './scripts/compress-web-assets.ts';

export default defineConfig({
  plugins: [react(), compressWebAssets()],
  root: 'src/web',
  base: '/',
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    // `pnpm dev` serves the live front-end and proxies /api to the loopback daemon.
    proxy: { '/api': process.env.GRAPH_DEV_API ?? 'http://127.0.0.1:4173' },
  },
});
