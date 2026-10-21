// FCC Covered List robot tracker page. Loads /data/covered-list-robots.json (same origin),
// validates it, and renders it with textContent only (never innerHTML) so data cannot inject markup.
import './style.css';
import './tracker.css';
import { initChrome } from './chrome.js';
import { distinct, filterEntries, formatDate, isHttpsUrl, validateTrackerData } from './tracker-data.js';

initChrome();

const $ = (id) => document.getElementById(id);
const MAX_BYTES = 512 * 1024;

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function sourceLink(url, label, id) {
  return h('a', { href: url, rel: 'noopener noreferrer', target: '_blank', id, text: label });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

function renderEntry(e) {
  const verified = e.verified_against_primary;
  const card = h('article', { class: 'entry card glow', id: `entry-${e.id}`, 'aria-labelledby': `entry-${e.id}-title` });

  const head = h('header', { class: 'entry-head' },
    h('div', {},
      h('h3', { id: `entry-${e.id}-title`, text: e.manufacturer }),
      h('p', { class: 'entry-cat mono', text: e.category }),
    ),
    h('div', { class: 'entry-tags' },
      h('span', { class: 'pill soon', text: e.status }),
      h('span', { class: `pill ${verified ? 'pass' : 'warn'}`, text: verified ? 'Verified' : 'Unverified' }),
    ),
  );

  const equipment = h('ul', { class: 'entry-equipment', 'aria-label': 'Named equipment' });
  e.equipment.forEach((x) => equipment.append(h('li', { text: x })));

  const facts = h('dl', { class: 'entry-facts' },
    h('div', {}, h('dt', { text: 'Public Notice' }), h('dd', { class: 'mono', text: e.notice_number || 'Not yet identified' })),
    h('div', {}, h('dt', { text: 'Announced' }), h('dd', {}, h('time', { datetime: e.date_announced, text: formatDate(e.date_announced) }))),
    h('div', {}, h('dt', { text: 'Last checked' }), h('dd', {}, h('time', { datetime: e.last_checked, text: formatDate(e.last_checked) }))),
  );

  const sources = h('p', { class: 'entry-sources' });
  if (e.primary_source_url) sources.append(sourceLink(e.primary_source_url, `FCC notice${e.notice_number ? ` ${e.notice_number}` : ''}`, `entry-${e.id}-primary`));
  e.secondary_sources.forEach((u, i) => {
    sources.append(document.createTextNode(' · '));
    sources.append(sourceLink(u, hostOf(u), `entry-${e.id}-src-${i}`));
  });
  if (!sources.childNodes.length) sources.append(h('span', { class: 'muted', text: 'Source link pending' }));

  card.append(head, equipment);
  if (e.conditions_summary) card.append(h('p', { class: 'entry-conditions muted', text: e.conditions_summary }));
  card.append(facts, sources);
  return card;
}

function fillSelect(select, values) {
  values.forEach((v) => select.append(h('option', { value: v, text: v })));
}

function setUpdated(iso) {
  for (const id of ['last-updated-top', 'last-updated-bottom']) {
    const t = $(id);
    t.dateTime = iso;
    t.textContent = formatDate(iso);
  }
}

function showError(message) {
  $('result-count').textContent = 'Unavailable';
  const box = $('tracker-error');
  box.textContent = message;
  box.hidden = false;
}

async function load() {
  const res = await fetch('/data/covered-list-robots.json', { credentials: 'omit', cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('data file too large');
  return JSON.parse(text);
}

async function main() {
  let raw;
  try {
    raw = await load();
  } catch {
    showError('The tracker data could not be loaded. Please refresh the page, or check the official FCC Covered List directly.');
    return;
  }
  const result = validateTrackerData(raw);
  if (!result.ok) {
    showError('The tracker data failed validation and is not shown. Please check the official FCC Covered List directly.');
    return;
  }
  const { data } = result;
  setUpdated(data.last_updated);

  const d = data.designation;
  if (d && typeof d.notice_number === 'string' && d.notice_number.length < 40) $('designation-notice').textContent = d.notice_number;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d.date ?? '')) $('designation-date').textContent = formatDate(d.date);
  if (isHttpsUrl(data.covered_list_url)) {
    for (const id of ['disclaimer-covered-list', 'disclaimer-covered-list-bottom']) $(id).href = data.covered_list_url;
  }

  fillSelect($('f-manufacturer'), distinct(data.entries, 'manufacturer'));
  fillSelect($('f-category'), distinct(data.entries, 'category'));

  const list = $('tracker-list');
  const render = () => {
    const shown = filterEntries(data.entries, {
      query: $('f-search').value,
      manufacturer: $('f-manufacturer').value,
      category: $('f-category').value,
      from: $('f-from').value,
      to: $('f-to').value,
    });
    list.replaceChildren(...shown.map(renderEntry));
    if (!shown.length) list.append(h('p', { class: 'empty muted', text: 'No entries match these filters.' }));
    $('result-count').textContent = `${shown.length} of ${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'}`;
  };

  const form = $('filters');
  form.addEventListener('input', render);
  form.addEventListener('submit', (ev) => ev.preventDefault());
  form.addEventListener('reset', () => setTimeout(render, 0));
  render();
}

main();
