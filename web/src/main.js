// Landing page entry.
import './style.css';
import './landing.css';
import { initChrome } from './chrome.js';

initChrome();

// CRA countdown to full application: 11 Dec 2027 00:00 CET (UTC+1).
const DEADLINE = Date.UTC(2027, 11, 10, 23, 0, 0);
const days = document.getElementById('cd-days');
const hours = document.getElementById('cd-hours');
const mins = document.getElementById('cd-mins');
function tick() {
  const ms = Math.max(0, DEADLINE - Date.now());
  days.textContent = Math.floor(ms / 864e5).toLocaleString('en-US');
  hours.textContent = String(Math.floor(ms / 36e5) % 24).padStart(2, '0');
  mins.textContent = String(Math.floor(ms / 6e4) % 60).padStart(2, '0');
}
if (days) {
  tick();
  setInterval(tick, 30_000);
}

// Animate the yield ring and number when it scrolls into view.
const ring = document.querySelector('.yield-ring');
const num = document.getElementById('yield-number');
if (ring && num && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    ring.classList.add('on');
    const target = 87;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 1400);
      num.textContent = String(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, { threshold: 0.4 });
  io.observe(ring);
} else ring?.classList.add('on');
