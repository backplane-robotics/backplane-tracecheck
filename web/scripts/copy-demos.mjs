// Copies the synthetic example recordings from ../examples into public/demo/ and writes
// a manifest the app uses for its demo picker. Runs before `dev` and `build`.
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', 'examples');
const dest = resolve(here, '..', 'public', 'demo');

const DEMOS = [
  { file: 'clean.mcap', contract: 'demo-contract.json', title: 'Clean recording', note: 'Uncompressed, every check passes.' },
  { file: 'clean-zstd.mcap', contract: 'demo-contract.json', title: 'Clean (zstd)', note: 'Same data in zstd-compressed chunks.' },
  { file: 'faults.mcap', contract: 'demo-contract.json', title: 'Injected faults', note: 'Gaps, regressions, sequence breaks, bad metadata.' },
  { file: 'no-crc.mcap', contract: 'demo-contract.json', title: 'No CRCs', note: 'Valid file written without checksums: warns.' },
  { file: 'truncated.mcap', contract: 'demo-contract.json', title: 'Truncated file', note: 'Cut off mid-write: scan fails safely.' },
  { file: 'fleet-zstd.mcap', contract: 'fleet-contract.json', title: 'Mobile robot (zstd)', note: '4 ROS 2 topics, 20 s at fleet rates.' },
  { file: 'fleet-dropout-lz4.mcap', contract: 'fleet-contract.json', title: 'Sensor dropout (lz4)', note: 'An IMU outage hidden in a 20 s drive.' },
];

mkdirSync(dest, { recursive: true });
const files = new Set(DEMOS.flatMap((d) => [d.file, d.contract]));
for (const f of files) copyFileSync(join(src, f), join(dest, f));
const manifest = DEMOS.map((d) => ({ ...d, bytes: statSync(join(src, d.file)).size }));
writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`copy-demos: ${files.size} files -> public/demo`);
