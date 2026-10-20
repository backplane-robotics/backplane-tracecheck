import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterEntries, validateTrackerData } from '../src/tracker-data.js';

const DATA = JSON.parse(readFileSync(resolve(import.meta.dirname, '../public/data/covered-list-robots.json'), 'utf8'));

describe('covered-list-robots.json', () => {
  it('passes validation', () => {
    const r = validateTrackerData(DATA);
    expect(r.errors).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('sorts newest first', () => {
    const { data } = validateTrackerData(DATA);
    const dates = data.entries.map((e) => e.date_announced);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe('validateTrackerData', () => {
  const clone = () => structuredClone(DATA);

  it('rejects non-https and javascript: links', () => {
    for (const bad of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x']) {
      const d = clone();
      d.entries[0].primary_source_url = bad;
      expect(validateTrackerData(d).ok).toBe(false);
      const d2 = clone();
      d2.entries[0].secondary_sources = [bad];
      expect(validateTrackerData(d2).ok).toBe(false);
    }
  });

  it('rejects unknown keys, duplicate ids, bad dates and missing fields', () => {
    const a = clone(); a.entries[0].extra = 1;
    const b = clone(); b.entries[1].id = b.entries[0].id;
    const c = clone(); c.entries[0].date_announced = '2026-13-45';
    const d = clone(); delete d.entries[0].manufacturer;
    const e = clone(); e.entries[0].verified_against_primary = 'yes';
    for (const x of [a, b, c, d, e]) expect(validateTrackerData(x).ok).toBe(false);
  });

  it('rejects oversized entry lists', () => {
    const d = clone();
    d.entries = Array.from({ length: 501 }, (_, i) => ({ ...DATA.entries[0], id: `e-${i}` }));
    expect(validateTrackerData(d).ok).toBe(false);
  });
});

describe('filterEntries', () => {
  const { data } = validateTrackerData(DATA);

  it('matches all words across fields, case-insensitive', () => {
    expect(filterEntries(data.entries, { query: 'ar650' }).map((e) => e.id)).toEqual(['anscer-ar-amr']);
    expect(filterEntries(data.entries, { query: 'DA 26-1063' }).map((e) => e.id)).toEqual(['matic-floor-cleaner']);
    expect(filterEntries(data.entries, { query: 'zzz-no-match' })).toEqual([]);
  });

  it('filters by manufacturer, category and inclusive date range', () => {
    expect(filterEntries(data.entries, { manufacturer: 'Husqvarna AB' })).toHaveLength(1);
    expect(filterEntries(data.entries, { from: '2026-10-01', to: '2026-10-16' }).map((e) => e.id).sort()).toEqual(['matic-floor-cleaner', 'volley-agv-amr']);
    expect(filterEntries(data.entries, {})).toHaveLength(data.entries.length);
  });
});
