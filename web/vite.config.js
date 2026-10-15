import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Production CSP from public/_headers (Cloudflare Pages), reused by `vite preview` so the
// built site can be tested locally under exactly the policy it ships with.
const CSP = readFileSync(resolve(import.meta.dirname, 'public/_headers'), 'utf8').match(/Content-Security-Policy: (.+)/)[1].trim();

// Multi-page static site: the landing page and the Tracecheck app.
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        tracecheck: resolve(import.meta.dirname, 'tracecheck/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  preview: { headers: { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } },
  test: { include: ['test/**/*.test.js'], testTimeout: 30000 },
});
