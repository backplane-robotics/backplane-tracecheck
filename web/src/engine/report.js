// Standalone HTML report: a port of src/tracecheck/report.py render().
// The output is a self-contained document offered as a download (never framed in the app).

import { dumps } from './json.js';

const STYLE = 'body{font:16px/1.55 system-ui,sans-serif;color:#203348;background:#eef3f7;margin:0}main{max-width:1120px;margin:auto;padding:36px}h1{font-size:36px;line-height:1.15}h2{margin:0 0 12px}article,.intro{background:white;border:1px solid #dae3eb;border-radius:14px;padding:24px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 Consolas,monospace;background:#f4f7fa;padding:14px;border-radius:8px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}.pass{color:#116746}.fail{color:#b62b35}.warn{color:#865500}.skipped{color:#596979}.badge{font-weight:750;text-transform:uppercase}.sub{color:#526579}a{color:#126b83}code{overflow-wrap:anywhere}@media print{body{background:white}main{padding:0}article{break-inside:avoid}h1{font-size:28px}}';

/** Same escaping as Python's html.escape(quote=True). */
export const esc = (x) =>
  String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const pretty = (v) => dumps(v, { indent: 2, ensureAscii: false });
const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

export function render(r) {
  const rows = r.checks
    .map((x) => `<tr><td>${x.id}</td><td><a href="#${x.id}">${esc(x.name)}</a></td><td class="badge ${x.status}">${x.status}</td></tr>`)
    .join('');
  const sections = r.checks
    .map((x) => {
      const findings = x.findings
        .map((f) => `<p><span class="badge ${f.status}">${f.status}</span> · ${esc(f.detail)}</p><pre>${esc(pretty(omit(f, ['detail', 'status'])))}</pre>`)
        .join('');
      return `<article id="${x.id}"><h2>${x.id} · ${esc(x.name)}</h2>${findings}</article>`;
    })
    .join('');
  const provenance = omit(r, ['checks', 'inventory', 'contract', 'recovered', 'bag']);
  const cut = r.recovered && 'incomplete_file' in r.recovered ? `${esc(r.recovered.incomplete_file)} ends` : 'The file ends';
  let recovered = r.recovered
    ? `<article id="recovered"><h2 class="warn">Recovered before the cut-off</h2><p>${cut} before its MCAP footer. ` +
      'These complete messages were readable; the contract checks were not run on this partial data.</p>' +
      `<pre>${esc(pretty(r.recovered))}</pre></article>`
    : '';
  if (r.bag) {
    recovered += '<article id="bag"><h2>ROS 2 bag folder</h2><p>The .mcap files below were checked in order as one recording. ' +
      'Each SHA-256 identifies the bytes that were read; it does not show where they came from.</p>' +
      `<pre>${esc(pretty(r.bag))}</pre></article>`;
  }
  const sc = r.status_counts;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Tracecheck · ${esc(r.source.name)}</title><style>${STYLE}</style><main><p class="sub">BACKPLANE TRACECHECK · v${esc(r.tool.version)}</p><h1>${esc(r.source.name)}</h1><div class="intro"><h2 class="${r.overall}">${r.overall.toUpperCase()} · contract review</h2><p>Scan complete: <b>${String(r.scan_complete).toLowerCase()}</b> · ${sc.pass} pass · ${sc.warn} warn · ${sc.fail} fail · ${sc.skipped} skipped</p><p>${esc(r.interpretation)}</p><p>Skipped means no conclusion. Check-level status is the worst applicable finding; inspect skipped sub-findings too.</p></div><table><thead><tr><th>Check</th><th>Requirement</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>${recovered}${sections}<article><h2>Provenance and limits</h2><pre>${esc(pretty(provenance))}</pre></article><article><h2>Contract used</h2><pre>${esc(pretty(r.contract))}</pre></article><article><h2>Channel inventory</h2><pre>${esc(pretty(r.inventory || []))}</pre></article></main></html>`;
}
