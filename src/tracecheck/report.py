import html
import json

STYLE = '''body{font:16px/1.55 system-ui,sans-serif;color:#203348;background:#eef3f7;margin:0}main{max-width:1120px;margin:auto;padding:36px}h1{font-size:36px;line-height:1.15}h2{margin:0 0 12px}article,.intro{background:white;border:1px solid #dae3eb;border-radius:14px;padding:24px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 Consolas,monospace;background:#f4f7fa;padding:14px;border-radius:8px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}.pass{color:#116746}.fail{color:#b62b35}.warn{color:#865500}.skipped{color:#596979}.badge{font-weight:750;text-transform:uppercase}.sub{color:#526579}a{color:#126b83}code{overflow-wrap:anywhere}@media print{body{background:white}main{padding:0}article{break-inside:avoid}h1{font-size:28px}}'''

def render(r):
    esc = lambda x: html.escape(str(x))
    rows = ''.join(f'<tr><td>{x["id"]}</td><td><a href="#{x["id"]}">{esc(x["name"])}</a></td><td class="badge {x["status"]}">{x["status"]}</td></tr>' for x in r['checks'])
    sections = []
    for x in r['checks']:
        findings = ''.join(f'<p><span class="badge {f["status"]}">{f["status"]}</span> · {esc(f["detail"])}</p><pre>{esc(json.dumps({k:v for k,v in f.items() if k not in ["detail","status"]}, indent=2, ensure_ascii=False))}</pre>' for f in x['findings'])
        sections.append(f'<article id="{x["id"]}"><h2>{x["id"]} · {esc(x["name"])}</h2>{findings}</article>')
    provenance = {k:v for k,v in r.items() if k not in ['checks','inventory','contract','recovered']}
    rec = r.get('recovered')
    recovered = (f'<article id="recovered"><h2 class="warn">Recovered before the cut-off</h2><p>The file ends before its MCAP footer. '
                 f'These complete messages were readable; the contract checks were not run on this partial data.</p>'
                 f'<pre>{esc(json.dumps(rec,indent=2,ensure_ascii=False))}</pre></article>') if rec else ''
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Tracecheck · {esc(r['source']['name'])}</title><style>{STYLE}</style><main><p class="sub">BACKPLANE TRACECHECK · v{esc(r['tool']['version'])}</p><h1>{esc(r['source']['name'])}</h1><div class="intro"><h2 class="{r['overall']}">{r['overall'].upper()} · contract review</h2><p>Scan complete: <b>{str(r['scan_complete']).lower()}</b> · {r['status_counts']['pass']} pass · {r['status_counts']['warn']} warn · {r['status_counts']['fail']} fail · {r['status_counts']['skipped']} skipped</p><p>{esc(r['interpretation'])}</p><p>Skipped means no conclusion. Check-level status is the worst applicable finding; inspect skipped sub-findings too.</p></div><table><thead><tr><th>Check</th><th>Requirement</th><th>Status</th></tr></thead><tbody>{rows}</tbody></table>{recovered}{''.join(sections)}<article><h2>Provenance and limits</h2><pre>{esc(json.dumps(provenance,indent=2,ensure_ascii=False))}</pre></article><article><h2>Contract used</h2><pre>{esc(json.dumps(r['contract'],indent=2,ensure_ascii=False))}</pre></article><article><h2>Channel inventory</h2><pre>{esc(json.dumps(r.get('inventory',[]),indent=2,ensure_ascii=False))}</pre></article></main></html>'''
