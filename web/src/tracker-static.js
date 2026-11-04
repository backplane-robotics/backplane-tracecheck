// Build-time rendering of the Covered List tracker, so the entries are in the page's HTML for crawlers and
// link-preview bots that do not run JavaScript. Used by the Vite plugin in vite.config.js. The markup mirrors
// renderEntry() in tracker.js; the browser replaces it with the live, filterable list after the data loads.
import { formatDate, validateTrackerData } from './tracker-data.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for use in HTML text or a double-quoted attribute. */
export function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

function link(url, label, id) {
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank" id="${escapeHtml(id)}">${escapeHtml(label)}</a>`;
}

function time(iso) {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatDate(iso))}</time>`;
}

export function renderEntryHtml(e) {
  const id = `entry-${e.id}`;
  const verified = e.verified_against_primary;
  const sources = [];
  if (e.primary_source_url) sources.push(link(e.primary_source_url, `FCC notice${e.notice_number ? ` ${e.notice_number}` : ''}`, `${id}-primary`));
  e.secondary_sources.forEach((u, i) => sources.push(link(u, hostOf(u), `${id}-src-${i}`)));
  const sourcesHtml = sources.length ? sources.join(' · ') : '<span class="muted">Source link pending</span>';
  return [
    `<article class="entry card glow" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}-title">`,
    '<header class="entry-head"><div>',
    `<h3 id="${escapeHtml(id)}-title">${escapeHtml(e.manufacturer)}</h3>`,
    `<p class="entry-cat mono">${escapeHtml(e.category)}</p>`,
    '</div><div class="entry-tags">',
    `<span class="pill soon">${escapeHtml(e.status)}</span>`,
    `<span class="pill ${verified ? 'pass' : 'warn'}">${verified ? 'Verified' : 'Unverified'}</span>`,
    '</div></header>',
    `<ul class="entry-equipment" aria-label="Named equipment">${e.equipment.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`,
    e.conditions_summary ? `<p class="entry-conditions muted">${escapeHtml(e.conditions_summary)}</p>` : '',
    '<dl class="entry-facts">',
    `<div><dt>Public Notice</dt><dd class="mono">${escapeHtml(e.notice_number || 'Not yet identified')}</dd></div>`,
    `<div><dt>Announced</dt><dd>${time(e.date_announced)}</dd></div>`,
    `<div><dt>Last checked</dt><dd>${time(e.last_checked)}</dd></div>`,
    '</dl>',
    `<p class="entry-sources">${sourcesHtml}</p>`,
    '</article>',
  ].join('');
}

function replaceOnce(html, target, replacement) {
  const at = html.indexOf(target);
  if (at < 0 || html.indexOf(target, at + target.length) >= 0) throw new Error(`tracker prerender: expected exactly one ${target}`);
  return html.slice(0, at) + replacement + html.slice(at + target.length);
}

/**
 * Write the validated tracker data into the tracker page HTML: the entry list, the result count and both
 * "last updated" dates. Throws (failing the build) if the data is invalid or the page markup has changed.
 */
export function prerenderTrackerPage(html, raw) {
  const result = validateTrackerData(raw);
  if (!result.ok) throw new Error(`tracker prerender: invalid data: ${result.errors.join('; ')}`);
  const { entries, last_updated: updated } = result.data;
  const n = entries.length;
  let out = html;
  out = replaceOnce(out, '<div class="tracker-list" id="tracker-list"></div>',
    `<div class="tracker-list" id="tracker-list">${entries.map(renderEntryHtml).join('\n')}</div>`);
  out = replaceOnce(out, 'aria-live="polite">Loading…</p>', `aria-live="polite">${n} of ${n} ${n === 1 ? 'entry' : 'entries'}</p>`);
  for (const id of ['last-updated-top', 'last-updated-bottom'])
    out = replaceOnce(out, `<time id="${id}" datetime="">—</time>`, `<time id="${id}" datetime="${escapeHtml(updated)}">${escapeHtml(formatDate(updated))}</time>`);
  return out;
}
