import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 31042,
    proxy: {
      // Preserve the browser Host so strict same-origin checks also work in development.
      '/api': { target: 'http://127.0.0.1:31041', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:31041', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
