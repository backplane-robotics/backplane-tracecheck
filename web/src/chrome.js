// Shared page chrome: animated backplane-trace background, sticky header, mobile nav,
// scroll reveals, card glow, copy buttons and toasts. No external requests.

const SVG = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

/** Deterministic PRNG so the background is identical on every load. */
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function traces() {
  const host = document.createElement('div');
  host.className = 'bg-traces';
  host.setAttribute('aria-hidden', 'true');
  const W = 1600;
  const H = 1000;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid slice' }, host);
  const defs = el('defs', {}, svg);
  const g = el('linearGradient', { id: 'pulseGrad', x1: '0', y1: '0', x2: '1', y2: '0' }, defs);
  el('stop', { offset: '0', 'stop-color': '#2af5d2', 'stop-opacity': '0' }, g);
  el('stop', { offset: '0.6', 'stop-color': '#2af5d2' }, g);
  el('stop', { offset: '1', 'stop-color': '#38bdf8' }, g);
  const rand = rng(7);
  const step = 40;
  for (let i = 0; i < 26; i++) {
    let x = Math.round((rand() * W) / step) * step;
    let y = Math.round((rand() * H) / step) * step;
    let d = `M${x} ${y}`;
    let dir = rand() < 0.5 ? 0 : 1;
    for (let s = 0; s < 5; s++) {
      const len = (2 + Math.floor(rand() * 7)) * step;
      if (dir === 0) x += rand() < 0.5 ? len : -len;
      else y += rand() < 0.5 ? len : -len;
      // 45-degree jog like a PCB trace
      const j = step * (rand() < 0.5 ? 1 : -1);
      d += ` L${x} ${y} l${j} ${dir === 0 ? j : j}`;
      x += j;
      y += j;
      dir = 1 - dir;
    }
    el('path', { d, class: 'trace' }, svg);
    if (i % 2 === 0) {
      const p = el('path', { d, class: 'pulse' }, svg);
      p.style.setProperty('--dur', `${7 + rand() * 9}s`);
      p.style.setProperty('--delay', `${-rand() * 12}s`);
    }
    el('circle', { cx: x, cy: y, r: 2.5, class: 'node' }, svg);
  }
  const grid = document.createElement('div');
  grid.className = 'grid-overlay';
  grid.setAttribute('aria-hidden', 'true');
  document.body.prepend(host, grid);
}

function header() {
  const h = document.querySelector('.site-header');
  if (!h) return;
  const onScroll = () => h.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const toggle = h.querySelector('.nav-toggle');
  toggle?.addEventListener('click', () => {
    const open = h.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  h.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => h.classList.remove('open')));
}

function reveals() {
  const items = document.querySelectorAll('.reveal');
  items.forEach((n) => n.dataset.d && n.style.setProperty('--d', `${Number(n.dataset.d) * 0.09}s`));
  if (!('IntersectionObserver' in window)) {
    items.forEach((n) => n.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))),
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  items.forEach((n) => io.observe(n));
}

function glow() {
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card.glow');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
}

let toastTimer;
export function toast(message) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function copyButtons() {
  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      const target = document.getElementById(b.dataset.copy);
      const text = target?.dataset.text || target?.innerText.replace(/^\$ /gm, '') || '';
      try {
        await navigator.clipboard.writeText(text.trim());
        toast('Copied to clipboard');
      } catch {
        toast('Copy failed: select the text manually');
      }
    }),
  );
}

export function initChrome() {
  traces();
  header();
  reveals();
  glow();
  copyButtons();
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
}
