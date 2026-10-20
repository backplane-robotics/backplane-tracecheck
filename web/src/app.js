// Tracecheck web app: UI wiring. All scanning happens in ./engine/worker.js on this device.
import './style.css';
import './app.css';
import { initChrome, toast } from './chrome.js';
import { ContractError, loads } from './engine/contract.js';
import { VERSION } from './engine/engine.js';
import { PyFloat, parse } from './engine/json.js';
import { initFeedback } from './feedback.js';

initChrome();

const $ = (id) => document.getElementById(id);
const ui = {
  dropzone: $('dropzone'), fileInput: $('file-input'), dzTitle: $('dz-title'), dzSub: $('dz-sub'), demoGrid: $('demo-grid'),
  preset: $('contract-preset'), editor: $('contract-editor'), status: $('contract-status'), contractFile: $('contract-file'),
  fast: $('opt-fast'), ignoreCrc: $('opt-ignore-crc'), selected: $('selected-file'), run: $('run-btn'),
  progress: $('progress'), bar: $('progress-bar'), pct: $('progress-pct'), bytes: $('progress-bytes'), rate: $('progress-rate'), eta: $('progress-eta'),
  results: $('results'), error: $('error-box'), folderInput: $('folder-input'), bagPick: $('bag-pick'),
};
$('app-version').textContent = `v${VERSION}`;
// Feedback receives only the app version; it has no access to scan state.
initFeedback({ version: VERSION });

// `file` is one .mcap; `bag` is one ROS 2 bag folder: { folder, files: Map(name -> File) }.
const state = { file: null, bag: null, demo: null, contractOk: false, worker: null, report: null, json: '', html: '', running: false };

// ---------- formatting helpers ----------
const fmtBytes = (n) => {
  n = Number(n);
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) (n /= 1000), i++;
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtNum = (n) => (typeof n === 'bigint' ? n.toLocaleString('en-US') : typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(n));
// Headline for the CRC tile: chunk coverage when known (full scan), else the data-section status.
const crcHeadline = (cov) => {
  if (cov.chunk_present_verified === undefined) return cov.data_section ? `data ${cov.data_section}` : '—';
  const ok = Number(cov.chunk_present_verified), absent = Number(cov.chunk_absent ?? 0);
  if (ok + absent === 0) return 'no chunks';
  return absent === 0 ? `${fmtNum(ok)}/${fmtNum(ok)} chunks verified` : `${fmtNum(ok)}/${fmtNum(ok + absent)} chunks verified`;
};
const fmtDur = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : s < 90 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

/** Python-faithful JSON (Maps, BigInt, PyFloat) -> plain objects. Integers that fit exactly in a double
 *  become Numbers; larger ones (nanosecond timestamps) stay BigInt so no digits are lost. */
function plain(v) {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof PyFloat) return v.v;
  if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  return v;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- contract editor ----------
const CUSTOM_PLACEHOLDER = `Paste your contract JSON here, or click "Load file".

Minimal example:
{
  "version": 1,
  "name": "My recording requirements",
  "topics": {
    "/my/topic": { "required": true, "min_count": 1 }
  }
}`;
ui.editor.placeholder = CUSTOM_PLACEHOLDER;

async function loadPreset(name) {
  if (name === 'custom') {
    ui.editor.value = '';
    validateContract();
    ui.editor.focus();
    return;
  }
  const res = await fetch(`/demo/${name}`);
  ui.editor.value = await res.text();
  validateContract();
}

let validateTimer;
function validateContract() {
  if (!ui.editor.value.trim()) {
    ui.status.textContent = 'Paste a contract or load a .json file to continue';
    ui.status.className = 'contract-status';
    state.contractOk = false;
    updateRun();
    return;
  }
  try {
    const c = loads(ui.editor.value);
    const topics = c.get('topics').size;
    ui.status.textContent = `✓ Valid · ${c.get('name')} · ${topics} topic${topics === 1 ? '' : 's'}`;
    ui.status.className = 'contract-status ok';
    state.contractOk = true;
  } catch (e) {
    ui.status.textContent = `✗ ${e instanceof ContractError ? e.message : 'Invalid JSON'}`;
    ui.status.className = 'contract-status bad';
    state.contractOk = false;
  }
  updateRun();
}
ui.editor.addEventListener('input', () => {
  ui.preset.value = 'custom';
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateContract, 250);
});
ui.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: t, value } = ui.editor;
    ui.editor.value = value.slice(0, s) + '  ' + value.slice(t);
    ui.editor.selectionStart = ui.editor.selectionEnd = s + 2;
    ui.editor.dispatchEvent(new Event('input'));
  }
});
ui.preset.addEventListener('change', () => loadPreset(ui.preset.value));
$('contract-load').addEventListener('click', () => ui.contractFile.click());
ui.contractFile.addEventListener('change', async () => {
  const f = ui.contractFile.files[0];
  if (!f) return;
  if (f.size > 64 * 1024) return toast('Contract files are limited to 64 KiB');
  ui.editor.value = await f.text();
  ui.preset.value = 'custom';
  validateContract();
  ui.contractFile.value = '';
});
$('contract-download').addEventListener('click', () => download('contract.json', ui.editor.value, 'application/json'));

// ---------- recording selection ----------
function setFile(file, demo = null) {
  state.file = file;
  state.bag = null;
  state.demo = demo;
  ui.selected.replaceChildren(
    h('span', { class: 'sel-name', text: file.name }),
    h('span', { class: 'mono muted', text: `${fmtBytes(file.size)}${demo ? ' · demo' : ''}` }),
  );
  ui.dropzone.classList.add('has-file');
  ui.bagPick.classList.remove('active');
  ui.dzTitle.textContent = file.name;
  ui.dzSub.textContent = `${fmtBytes(file.size)} · click or drop to replace`;
  document.querySelectorAll('.demo').forEach((d) => d.classList.toggle('active', d.dataset.file === demo?.file));
  updateRun();
}

const bagBytes = (files) => [...files].filter(([n]) => n.endsWith('.mcap')).reduce((a, [, f]) => a + f.size, 0);
const selectedBytes = () => (state.bag ? bagBytes(state.bag.files) : state.file ? state.file.size : 0);

/** Select one ROS 2 bag folder. `files` maps plain file names (no subfolders) to File objects. */
function setBag(folder, files, demo = null) {
  const mcaps = [...files.keys()].filter((n) => n.endsWith('.mcap')).length;
  if (!mcaps) return toast('No .mcap files in that folder');
  state.file = null;
  state.bag = { folder, files };
  state.demo = demo;
  const meta = files.has('metadata.yaml') ? 'metadata.yaml' : 'no metadata.yaml';
  const summary = `${mcaps} .mcap file${mcaps === 1 ? '' : 's'} · ${meta} · ${fmtBytes(bagBytes(files))}`;
  ui.selected.replaceChildren(
    h('span', { class: 'sel-name', text: `${folder}/` }),
    h('span', { class: 'mono muted', text: `bag folder · ${summary}${demo ? ' · demo' : ''}` }),
  );
  ui.dropzone.classList.add('has-file');
  ui.bagPick.classList.add('active');
  ui.dzTitle.textContent = `${folder}/`;
  ui.dzSub.textContent = `${summary} · click or drop to replace`;
  document.querySelectorAll('.demo').forEach((d) => d.classList.toggle('active', d.dataset.file === demo?.file));
  updateRun();
}

ui.fileInput.addEventListener('change', () => ui.fileInput.files[0] && setFile(ui.fileInput.files[0]));
$('folder-btn').addEventListener('click', () => ui.folderInput.click());
ui.folderInput.addEventListener('change', () => {
  // webkitRelativePath is "folder/name"; files in subfolders ("folder/sub/name") are not part of the bag.
  const files = new Map();
  let folder = null;
  for (const f of ui.folderInput.files) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    folder ??= parts.length > 1 ? parts[0] : 'bag';
    if (parts.length <= 2) files.set(parts[parts.length - 1], f);
  }
  ui.folderInput.value = '';
  if (folder !== null) setBag(folder, files);
});

/** Read the plain files of a dropped folder (not its subfolders). */
async function folderFiles(entry) {
  const reader = entry.createReader();
  const entries = [];
  for (;;) {
    const batch = await new Promise((ok, bad) => reader.readEntries(ok, bad));
    if (!batch.length) break;
    entries.push(...batch);
  }
  const files = new Map();
  for (const e of entries.filter((x) => x.isFile)) files.set(e.name, await new Promise((ok, bad) => e.file(ok, bad)));
  return files;
}

for (const ev of ['dragenter', 'dragover']) {
  ui.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    ui.dropzone.classList.add('drag');
  });
}
for (const ev of ['dragleave', 'drop']) ui.dropzone.addEventListener(ev, () => ui.dropzone.classList.remove('drag'));
ui.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  const items = [...(e.dataTransfer?.items || [])];
  const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean); // must be read before any await
  if (entries.length === 1 && entries[0].isDirectory) {
    try {
      setBag(entries[0].name, await folderFiles(entries[0]));
    } catch {
      toast('Could not read that folder; try "Choose a bag folder"');
    }
    return;
  }
  const dropped = e.dataTransfer?.files || [];
  if (dropped.length > 1) return toast('Drop one .mcap file, or one bag folder');
  if (dropped[0]) setFile(dropped[0]);
});
// Prevent the browser from navigating to a file dropped outside the zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function loadDemos() {
  try {
    const demos = await (await fetch('/demo/manifest.json')).json();
    ui.demoGrid.replaceChildren(
      ...demos.map((d, i) => {
        const b = h('button', { class: 'demo', type: 'button', role: 'listitem', id: `demo-${d.file.replace(/\W+/g, '-')}`, 'data-file': d.file },
          h('b', { text: d.title }), h('span', { text: d.note }), h('small', { class: 'mono', text: `${d.file} · ${fmtBytes(d.bytes)}` }));
        b.style.setProperty('--i', i);
        b.addEventListener('click', async () => {
          b.classList.add('loading');
          try {
            if (d.bag) {
              const files = new Map();
              for (const n of d.files) files.set(n, new File([await (await fetch(`/demo/${d.bag}/${n}`)).blob()], n));
              setBag(d.bag, files, d);
            } else {
              const blob = await (await fetch(`/demo/${d.file}`)).blob();
              setFile(new File([blob], d.file), d);
            }
            if (ui.preset.value !== d.contract) {
              ui.preset.value = d.contract;
              await loadPreset(d.contract);
            }
          } finally {
            b.classList.remove('loading');
          }
        });
        return b;
      }),
    );
  } catch {
    ui.demoGrid.replaceChildren(h('p', { class: 'muted', text: 'Demo files are unavailable offline.' }));
  }
}

function updateRun() {
  ui.run.disabled = !((state.file || state.bag) && state.contractOk) || state.running;
}

// ---------- running ----------
function newWorker() {
  state.worker?.terminate();
  state.worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => fail(`Worker error: ${e.message || 'unknown'}`);
}

let runStarted = 0;
function run() {
  if (ui.run.disabled) return;
  ui.error.hidden = true;
  $('error-actions').hidden = true;
  ui.results.hidden = true;
  state.running = true;
  updateRun();
  ui.run.classList.add('busy');
  ui.progress.hidden = false;
  setProgress(0, selectedBytes(), 0);
  newWorker();
  runStarted = performance.now();
  const opts = { contractText: ui.editor.value, fast: ui.fast.checked, ignoreCrc: ui.ignoreCrc.checked };
  if (state.bag) {
    const files = [...state.bag.files].map(([name, file]) => ({ name, file }));
    state.worker.postMessage({ ...opts, bag: { folder: state.bag.folder, files } });
  } else state.worker.postMessage({ ...opts, file: state.file, filename: state.file.name });
}

function setProgress(done, total, seconds) {
  const p = total ? Math.min(1, done / total) : 1;
  ui.bar.style.width = `${(p * 100).toFixed(1)}%`;
  ui.pct.textContent = `${Math.floor(p * 100)}%`;
  ui.bytes.textContent = `${fmtBytes(done)} / ${fmtBytes(total)}`;
  const rate = seconds > 0.2 ? done / seconds : 0;
  ui.rate.textContent = rate ? `${fmtBytes(rate)}/s` : '—';
  ui.eta.textContent = rate && p < 1 ? `~${fmtDur((total - done) / rate)} left` : '';
}

function stopRunning() {
  state.running = false;
  ui.run.classList.remove('busy');
  ui.progress.hidden = true;
  updateRun();
}

function fail(message) {
  stopRunning();
  ui.error.textContent = message;
  ui.error.hidden = false;
  $('error-actions').hidden = false;
}

function onWorkerMessage({ data }) {
  if (data.type === 'progress') setProgress(data.done, data.total, data.seconds);
  else if (data.type === 'error') {
    const prefix = { contract: 'Contract error', bag: 'This folder can’t be checked' }[data.kind] || 'Unexpected error';
    fail(`${prefix}: ${data.message}`);
  } else if (data.type === 'result') {
    setProgress(selectedBytes(), selectedBytes(), data.seconds);
    state.json = data.json;
    state.html = data.html;
    state.report = plain(parse(data.json));
    stopRunning();
    state.worker.terminate();
    state.worker = null;
    renderResults(state.report, (performance.now() - runStarted) / 1000);
  }
}

ui.run.addEventListener('click', run);
$('cancel-btn').addEventListener('click', () => {
  state.worker?.terminate();
  state.worker = null;
  stopRunning();
  toast('Scan cancelled');
});

// ---------- results ----------
const STATUS_TEXT = { pass: 'Pass', warn: 'Warn', fail: 'Fail', skipped: 'Skipped' };
const pill = (s) => h('span', { class: `pill ${s}`, text: s });
const FACT_KEYS = ['file', 'topic', 'channel_id', 'scope', 'claimed', 'observed', 'expected', 'observed_hz', 'active_hz', 'excluded_ns', 'excluded_by', 'minimum', 'maximum', 'time_basis', 'expected_interval_ns',
  'boundary_tolerance_ns', 'missing_crc_policy', 'crc_coverage_complete', 'unknown_records_skipped', 'explained_gap_count', 'files_scanned',
  'metadata', 'ros_distro', 'files_listed'];
const EXPLAINED_LABELS = { recorder_paused: 'recorder paused', topic_unsubscribed: 'topic unsubscribed by recorder' };

const fmtNs = (ns) => {
  const n = Number(ns);
  return n >= 1e9 ? `${(n / 1e9).toFixed(3)} s` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} ms` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} µs` : `${n} ns`;
};
const kvs = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? kvs(v, `${prefix}${k}.`)
      : [h('span', { class: 'kv' }, h('i', { text: prefix + k }), h('b', { text: Array.isArray(v) ? `[${v.map(String).join(', ')}]` : v === null ? 'null' : String(v) }))]);

function evidenceLine(ev, explained = false) {
  if (ev.previous && ev.current) {
    const rest = Object.fromEntries(Object.entries(ev).filter(([k]) => k !== 'previous' && k !== 'current')
      .map(([k, v]) => [k, k === 'explained_by' && Array.isArray(v) ? v.map((x) => EXPLAINED_LABELS[x] || x).join(', ') : v]));
    const tag = 'gap_ns' in rest ? `gap ${fmtNs(rest.gap_ns)}${explained ? ' · explained' : ''}` : 'detail';
    return h('li', { class: 'ev pair' },
      h('div', { class: 'ev-row' }, h('span', { class: 'ev-tag', text: 'previous' }), kvs(ev.previous)),
      h('div', { class: 'ev-row' }, h('span', { class: 'ev-tag', text: 'current' }), kvs(ev.current)),
      Object.keys(rest).length ? h('div', { class: 'ev-row' }, h('span', { class: explained ? 'ev-tag' : 'ev-tag hot', text: tag }), kvs(rest)) : null);
  }
  return h('li', { class: 'ev' }, kvs(ev));
}

function findingEl(f) {
  const facts = FACT_KEYS.filter((k) => k in f).map((k) =>
    h('span', { class: 'fact' }, h('i', { text: k.replace(/_/g, ' ') }), h('b', { text: k === 'excluded_by' ? f[k].map((x) => EXPLAINED_LABELS[x] || x).join(', ') : k === 'excluded_ns' ? fmtNs(f[k]) : Array.isArray(f[k]) ? `[${f[k].map(fmtNum).join(', ')}]` : f[k] === null ? 'null' : fmtNum(f[k]) })));
  const el = h('div', { class: `finding ${f.status}` }, h('div', { class: 'finding-head' }, pill(f.status), h('p', { text: f.detail })));
  if (facts.length) el.append(h('div', { class: 'facts' }, facts));
  if (Array.isArray(f.evidence) && f.evidence.length) {
    el.append(h('div', { class: 'ev-head mono' }, `Evidence · ${fmtNum(f.evidence_count)} total${f.evidence_omitted ? ` · ${fmtNum(f.evidence_omitted)} not shown` : ''}`));
    el.append(h('ul', { class: 'ev-list' }, f.evidence.map((ev) => evidenceLine(ev))));
  }
  if (Array.isArray(f.explained_gaps) && f.explained_gaps.length) {
    const hidden = Number(f.explained_gap_count) - f.explained_gaps.length;
    el.append(h('div', { class: 'ev-head mono' }, `Explained by recorder events · ${fmtNum(f.explained_gap_count)} total${hidden > 0 ? ` · ${fmtNum(hidden)} not shown` : ''}`));
    el.append(h('ul', { class: 'ev-list explained' }, f.explained_gaps.map((ev) => evidenceLine(ev, true))));
  }
  return el;
}

/** Summary of what was readable in a file that ends before its MCAP footer. */
function renderRecovered(rec) {
  const box = $('result-recovered');
  if (!rec) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const pct = Number(rec.file_bytes) ? Math.floor((Number(rec.complete_bytes) / Number(rec.file_bytes)) * 1000) / 10 : 0;
  const fact = (label, value) => h('div', {}, h('dt', { text: label }), h('dd', { class: 'mono', text: value }));
  const topics = rec.topics || [];
  box.replaceChildren(
    h('h3', { text: 'Recovered before the cut-off' }),
    h('p', { class: 'muted', text: rec.data_section_complete
      ? 'All message data was read. The file is missing its summary or footer, which tools use to index the recording.'
      : 'The file stops partway through its message data. These complete messages were readable before that point; anything recorded after it is not in this file.' }),
    h('dl', { class: 'recovered-facts' },
      fact('Messages', fmtNum(rec.messages)),
      fact('Time span', rec.log_time_span_ns === null ? '—' : fmtNs(rec.log_time_span_ns)),
      fact('Readable bytes', `${fmtBytes(Number(rec.complete_bytes))} of ${fmtBytes(Number(rec.file_bytes))} (${pct}%)`),
      rec.incomplete_file ? fact('File cut off', rec.incomplete_file) : fact('Message data complete', rec.data_section_complete ? 'Yes' : 'No')),
    topics.length
      ? h('div', { class: 'table-wrap' }, h('table', { id: 'recovered-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Topic' }), h('th', { text: 'Messages recovered' }))),
          h('tbody', {}, topics.map((t) => h('tr', {}, h('td', { class: 'mono', text: t.topic }), h('td', { class: 'mono', text: fmtNum(t.message_count) }))))))
      : null,
    h('p', { class: 'tiny muted', text: 'The contract checks were not run on this partial data. To find out why the file is incomplete, check the recorder’s logs and how the file was copied or uploaded.' }),
  );
  box.hidden = false;
}

const SCAN_TEXT = { complete: 'checked', 'summary only': 'summary read (fast mode)', incomplete: 'cut off', error: 'could not be read',
  'not scanned': 'not checked', missing: 'missing from folder', 'not listed': 'not in metadata.yaml; not checked' };

/** The files of a ROS 2 bag folder, in the order they were checked. */
function renderBag(bag) {
  const box = $('result-bag');
  if (!bag) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const meta = { present: 'metadata.yaml read', absent: 'no metadata.yaml', unreadable: 'metadata.yaml unreadable' }[bag.metadata];
  const msgs = (f) => {
    if (f.messages === null) return f.messages_claimed === null ? '—' : `— (metadata.yaml: ${fmtNum(f.messages_claimed)})`;
    if (f.messages_claimed === null) return fmtNum(f.messages);
    return f.messages === f.messages_claimed ? fmtNum(f.messages) : `${fmtNum(f.messages)} (metadata.yaml: ${fmtNum(f.messages_claimed)})`;
  };
  const cls = (f) => (['missing', 'incomplete', 'error'].includes(f.scan) || (f.messages !== null && f.messages_claimed !== null && f.messages !== f.messages_claimed)
    ? 'bad' : ['not listed', 'not scanned'].includes(f.scan) ? 'warn' : '');
  box.replaceChildren(
    h('h3', {}, `Bag folder · ${bag.folder}/`, h('span', { class: 'pill skipped', text: meta })),
    h('div', { class: 'table-wrap' }, h('table', { id: 'bag-table' },
      h('thead', {}, h('tr', {}, ...['File', 'Status', 'Messages', 'Size', 'SHA-256'].map((t) => h('th', { text: t })))),
      h('tbody', {}, bag.files.map((f) => h('tr', {},
        h('td', { class: 'mono', text: f.name }),
        h('td', { class: cls(f), text: SCAN_TEXT[f.scan] || f.scan }),
        h('td', { class: 'mono', text: msgs(f) }),
        h('td', { class: 'mono', text: f.bytes === null ? '—' : fmtBytes(f.bytes) }),
        h('td', { class: 'mono', title: f.sha256 || '', text: f.sha256 ? `${f.sha256.slice(0, 16)}…` : '—' })))))),
    h('p', { class: 'tiny muted', text: 'The files were checked in this order as one recording; gaps and sequence breaks across file boundaries count. ' +
      'A SHA-256 identifies the bytes that were read; it does not show where they came from. See C11 for the metadata.yaml comparison.' }),
  );
  box.hidden = false;
}

function renderResults(r, seconds) {
  const sc = r.status_counts;
  const ring = $('overall-ring');
  ring.className = `overall-ring ${r.overall}`;
  $('overall-label').textContent = STATUS_TEXT[r.overall];
  $('h-results').textContent = r.scan_complete ? `Contract review: ${STATUS_TEXT[r.overall].toLowerCase()}` : r.recovered ? 'Recording incomplete' : 'Scan incomplete';
  $('result-file').textContent = r.bag
    ? `${r.source.name}/ · bag folder · ${r.bag.files.length} file${r.bag.files.length === 1 ? '' : 's'} · ${fmtBytes(r.source.bytes)}`
    : `${r.source.name} · ${fmtBytes(r.source.bytes)}${r.source.sha256 ? ` · sha256 ${r.source.sha256.slice(0, 16)}…` : ''}`;
  $('result-file').title = r.source.sha256 || '';
  $('result-counts').replaceChildren(...['pass', 'warn', 'fail', 'skipped'].map((s) => h('span', { class: `count ${s}` }, h('b', { text: sc[s] }), ` ${s}`)));

  const cov = r.checksum_coverage || {};
  const comp = r.compression ? Object.entries(r.compression).map(([k, v]) => `${k || 'none'} × ${v}`).join(', ') || '—' : '—';
  const st = r.scan_stats || {};
  const stat = (label, value, sub = '') => h('div', { class: 'stat card' }, h('span', { class: 'mono muted', text: label }), h('b', { text: value }), sub ? h('small', { class: 'muted', text: sub }) : null);
  $('result-stats').replaceChildren(
    stat('Mode', r.scan_mode === 'fast' ? 'Fast (summary)' : 'Full scan', r.fast_mode_fallback ? `fell back: ${r.fast_mode_fallback}` : r.mcap_profile ? `profile: ${r.mcap_profile}` : ''),
    stat('Duration', fmtDur(seconds), seconds > 0 ? `${fmtBytes(r.source.bytes / seconds)}/s` : ''),
    stat('Messages', st.messages !== undefined ? fmtNum(st.messages) : '—', st.chunks !== undefined ? `${fmtNum(st.chunks)} chunks · ${fmtNum(st.records ?? 0)} records` : ''),
    stat('Compression', comp),
    stat('CRC coverage', crcHeadline(cov), [cov.data_section ? `data-section CRC ${cov.data_section}` : '', cov.summary ? `summary ${cov.summary}` : ''].filter(Boolean).join(' · ')),
  );
  $('result-interpretation').textContent = `${r.interpretation} "Skipped" means no conclusion was drawn.`;
  renderRecovered(r.recovered);
  renderBag(r.bag);

  $('result-checks').replaceChildren(
    ...r.checks.map((c, i) => {
      const counted = c.findings.filter((f) => f.status !== 'skipped').length;
      const d = h('details', { class: `check ${c.status}`, id: `check-${c.id}`, open: c.status === 'fail' || c.status === 'warn' ? true : null },
        h('summary', {}, h('code', { text: c.id }), h('span', { class: 'check-name', text: c.name }),
          h('span', { class: 'check-n mono muted', text: `${counted} finding${counted === 1 ? '' : 's'}` }), pill(c.status)),
        h('div', { class: 'check-body' }, c.findings.map(findingEl)));
      d.style.setProperty('--i', i);
      return d;
    }),
  );

  const tbody = document.querySelector('#inventory-table tbody');
  const inv = r.inventory || [];
  tbody.replaceChildren(
    ...(inv.length
      ? inv.map((x) => h('tr', {}, h('td', { class: 'mono', text: x.channel_id }), h('td', { class: 'mono', text: x.topic }), h('td', { class: 'mono', text: fmtNum(x.message_count) }),
          h('td', { text: x.message_encoding }), h('td', { class: 'mono', text: x.schema ? `${x.schema.name} (${x.schema.encoding})` : '—' })))
      : [h('tr', {}, h('td', { colspan: 5, class: 'muted', text: 'No channels read.' }))]),
  );

  ui.results.hidden = false;
  ui.results.classList.remove('in');
  requestAnimationFrame(() => ui.results.classList.add('in'));
  ui.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const baseName = () => (state.report?.source.name || 'recording').replace(/\.mcap$/i, '');
$('dl-json').addEventListener('click', () => download(`${baseName()}.tracecheck.json`, state.json + '\n', 'application/json'));
$('dl-html').addEventListener('click', () => download(`${baseName()}.tracecheck.html`, state.html, 'text/html'));
$('new-check').addEventListener('click', () => {
  ui.results.hidden = true;
  $('workspace').scrollIntoView({ behavior: 'smooth' });
});

// ---------- init ----------
loadDemos();
loadPreset(ui.preset.value);
