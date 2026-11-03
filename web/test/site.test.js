// Site-wide checks for search engines and link previews: every page has a title, a description and a canonical URL,
// every canonical URL is in sitemap.xml (and nothing else is), and robots.txt points to the sitemap.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(import.meta.dirname, '..');
const SITE = 'https://backplanerobotics.com';
const PAGES = { 'index.html': '/', 'tracecheck/index.html': '/tracecheck/', 'tools/covered-list-robots/index.html': '/tools/covered-list-robots/',
  'insights/fcc-test-lab-rules/index.html': '/insights/fcc-test-lab-rules/' };
const read = (p) => readFileSync(resolve(WEB, p), 'utf8');
const sitemap = read('public/sitemap.xml');
const inSitemap = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

describe('search engine basics', () => {
  for (const [file, path] of Object.entries(PAGES)) {
    it(`${path} has a title, description, canonical URL and Open Graph tags`, () => {
      const html = read(file);
      expect(html).toMatch(/<html lang="en">/);
      expect(html).toMatch(/<title>[^<]{10,}<\/title>/);
      const desc = /<meta name="description" content="([^"]+)"/.exec(html)?.[1] ?? '';
      expect(desc.length).toBeGreaterThan(50);
      expect(html).toContain(`<link rel="canonical" href="${SITE}${path}" />`);
      expect(html).toContain(`<meta property="og:url" content="${SITE}${path}" />`);
      expect(html).toMatch(/<meta property="og:title" content="[^"]+"/);
      expect(html).not.toMatch(/name="robots" content="[^"]*noindex/);
    });
  }

  it('sitemap.xml lists exactly the public pages', () => {
    expect(inSitemap.sort()).toEqual(Object.values(PAGES).map((p) => SITE + p).sort());
  });

  it('robots.txt allows crawling and points to the sitemap', () => {
    const robots = read('public/robots.txt');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).not.toMatch(/^Disallow: \/$/m);
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it('structured data on article pages is valid JSON', () => {
    const html = read('insights/fcc-test-lab-rules/index.html');
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1];
    const data = JSON.parse(block);
    expect(data['@type']).toBe('Article');
    expect(data.mainEntityOfPage).toBe(`${SITE}/insights/fcc-test-lab-rules/`);
  });
});
