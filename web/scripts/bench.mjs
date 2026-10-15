// Throughput check for the browser engine on a large local file (run with node).
// Usage: node web/scripts/bench.mjs <file.mcap> <contract.json> [--fast]
import { openAsBlob, readFileSync } from 'node:fs';
import { loads } from '../src/engine/contract.js';
import { analyze } from '../src/engine/engine.js';

const [file, contract, flag] = process.argv.slice(2);
const blob = await openAsBlob(file);
const t = performance.now();
let last = 0;
const r = await analyze(blob, loads(readFileSync(contract, 'utf8')), {
  filename: file, fast: flag === '--fast',
  progress: (d, n) => { if (d - last > 256 << 20 || d === n) { last = d; process.stdout.write(`  ${(d / n * 100).toFixed(0)}%\r`); } },
});
const s = (performance.now() - t) / 1000;
console.log(`${r.overall} complete=${r.scan_complete} ${(blob.size / 1e6).toFixed(0)} MB in ${s.toFixed(1)} s = ${(blob.size / 1e6 / s).toFixed(0)} MB/s, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
console.log(r.checks.map((c) => `${c.id}=${c.status}`).join(' '));
