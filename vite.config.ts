import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const apiPort = Number(process.env.OLAV_TASKS_API_PORT ?? '4318');
const webPort = Number(process.env.OLAV_TASKS_WEB_PORT ?? '4317');
if (![apiPort, webPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) throw new Error('Development ports must be integers between 1 and 65535.');
export default defineConfig({
  root: 'web', plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) } },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: webPort, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } } },
});
