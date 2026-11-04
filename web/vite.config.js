import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { prerenderTrackerPage } from './src/tracker-static.js';

// Production CSP from public/_headers (applied by Cloudflare), reused by `vite preview` so the
// built site can be tested locally under exactly the policy it ships with.
const CSP = readFileSync(resolve(import.meta.dirname, 'public/_headers'), 'utf8').match(/Content-Security-Policy: (.+)/)[1].trim();

// Writes the Covered List entries into the tracker page's HTML at build time (and in dev), so crawlers that do not
// run JavaScript see the full list instead of "Loading…". Invalid data fails the build.
function trackerPrerender() {
  return {
    name: 'tracker-prerender',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.filename.replace(/\\/g, '/').endsWith('/tools/covered-list-robots/index.html')) return html;
        const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, 'public/data/covered-list-robots.json'), 'utf8'));
        return prerenderTrackerPage(html, raw);
      },
    },
  };
}

// Multi-page static site: the landing page, the Tracecheck app and the Covered List tracker.
export default defineConfig({
  plugins: [trackerPrerender()],
  build: {
    target: 'es2022',
    // Never inline fonts as data: URLs: the CSP allows fonts only from this site (font-src 'self').
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        tracecheck: resolve(import.meta.dirname, 'tracecheck/index.html'),
        coveredListRobots: resolve(import.meta.dirname, 'tools/covered-list-robots/index.html'),
        fccTestLabRules: resolve(import.meta.dirname, 'insights/fcc-test-lab-rules/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  preview: { headers: { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } },
  test: { include: ['test/**/*.test.js'], testTimeout: 30000 },
});
