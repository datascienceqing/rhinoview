import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import type { Plugin } from 'vite';

const PROXY_PORT = Number(process.env.SERVER_PORT ?? 8787);
const sharedAlias = { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) };

/**
 * MSW writes its service worker into `public/`, which Vite copies verbatim into the
 * build. Nothing in the production bundle registers it — the mock gate is dev-only —
 * but shipping a request-intercepting service worker to production is a footgun
 * worth closing rather than documenting.
 */
const dropMockServiceWorker = (): Plugin => ({
  name: 'drop-mock-service-worker',
  apply: 'build',
  closeBundle() {
    rmSync(fileURLToPath(new URL('./dist/mockServiceWorker.js', import.meta.url)), { force: true });
  },
});

export default defineConfig({
  plugins: [react(), dropMockServiceWorker()],
  resolve: { alias: sharedAlias },
  server: {
    port: 5173,
    strictPort: true,
    // The client always calls same-origin `/api/*`; Vite forwards to the proxy in
    // dev. The API key therefore never reaches the browser, and there is no CORS
    // preflight to configure in development.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${PROXY_PORT}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    // Two projects, because client code needs a DOM and server/math code must NOT
    // have one — a stray `document` reference in indicator math then fails loudly
    // instead of quietly passing.
    projects: [
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          name: 'client',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['./src/test-setup.ts'],
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          include: ['server/**/*.{test,spec}.ts', 'shared/**/*.{test,spec}.ts'],
        },
      },
    ],
  },
});
