import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const PROXY_PORT = Number(process.env.SERVER_PORT ?? 8787);
const sharedAlias = { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) };

export default defineConfig({
  plugins: [react()],
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
