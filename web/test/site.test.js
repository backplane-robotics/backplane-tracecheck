// Site-wide checks for search engines and link previews: every page has a title, a description and a canonical URL,
// every canonical URL is in sitemap.xml (and nothing else is), and robots.txt points to the sitemap.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prerenderTrackerPage } from '../src/tracker-static.js';

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
      expect(html).toContain(`<meta property="og:image" content="${SITE}/og-image.png" />`);
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(html).not.toMatch(/name="robots" content="[^"]*noindex/);
    });
  }

  it('keeps the Google Search Console ownership proofs (removing them unverifies the site)', () => {
    expect(read('index.html')).toContain('<meta name="google-site-verification" content="FPAdFw_kW0GiPCVfHkRc-yQi7ILc8GIEX0YSbypjGqs" />');
    expect(read('public/google3b619a281a7416fa.html')).toContain('google-site-verification: google3b619a281a7416fa.html');
  });

  it('sitemap.xml lists exactly the public pages', () => {
    expect(inSitemap.sort()).toEqual(Object.values(PAGES).map((p) => SITE + p).sort());
  });

  it('robots.txt allows search crawlers, blocks AI training crawlers and points to the sitemap', () => {
    const robots = read('public/robots.txt');
    // Parse into groups: consecutive User-agent lines share the rules that follow them.
    const groups = [];
    let current = null;
    for (const line of robots.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)) {
      const [, key, value] = /^([^:]+):\s*(.*)$/.exec(line);
      if (/^user-agent$/i.test(key)) {
        if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
        current.agents.push(value.toLowerCase());
      } else if (/^(allow|disallow)$/i.test(key)) current.rules.push(`${key.toLowerCase()}:${value}`);
    }
    const rulesFor = (agent) => (groups.find((g) => g.agents.includes(agent.toLowerCase())) ?? groups.find((g) => g.agents.includes('*'))).rules;
    for (const bot of ['*', 'Googlebot', 'Bingbot', 'OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot'])
      expect(rulesFor(bot), bot).not.toContain('disallow:/');
    for (const bot of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot'])
      expect(rulesFor(bot), bot).toContain('disallow:/');
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it('the tracker page has the entries in its HTML for crawlers that do not run JavaScript', () => {
    const raw = JSON.parse(read('public/data/covered-list-robots.json'));
    const html = prerenderTrackerPage(read('tools/covered-list-robots/index.html'), raw);
    expect(html).not.toContain('Loading…');
    for (const e of raw.entries) expect(html).toContain(`<article class="entry card glow" id="entry-${e.id}"`);
    expect(html).toContain(`${raw.entries.length} of ${raw.entries.length} entries`);
    expect(html).toContain(`<time id="last-updated-top" datetime="${raw.last_updated}">`);
  });

  it('structured data on article pages is valid JSON', () => {
    const html = read('insights/fcc-test-lab-rules/index.html');
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1];
    const data = JSON.parse(block);
    expect(data['@type']).toBe('Article');
    expect(data.mainEntityOfPage).toBe(`${SITE}/insights/fcc-test-lab-rules/`);
  });
});
