// Module Web Worker: runs the scan off the main thread. Files are read from their File
// handles in slices; nothing is uploaded anywhere.

import { BagError } from './bag.js';
import { ContractError, loads } from './contract.js';
import { analyze, analyzeBag, reportJson } from './engine.js';
import { DEFAULT_LIMITS } from './reader.js';
import { render } from './report.js';

self.onmessage = async (event) => {
  // Either `file` (one .mcap) or `bag` ({ folder, files: [{ name, file }] }, one ROS 2 bag folder).
  const { file, bag, contractText, fast = false, ignoreCrc = false, filename } = event.data || {};
  let contract;
  try {
    contract = loads(contractText);
  } catch (e) {
    self.postMessage({ type: 'error', kind: e instanceof ContractError ? 'contract' : 'internal', message: String(e.message || e) });
    return;
  }
  if (ignoreCrc) contract.set('missing_crc', 'ignore');
  let last = 0;
  const started = performance.now();
  const progress = (done, total) => {
    const now = performance.now();
    if (now - last < 100 && done < total) return;
    last = now;
    self.postMessage({ type: 'progress', done, total, seconds: (now - started) / 1000 });
  };
  try {
    const opts = { fast, limits: DEFAULT_LIMITS, progress };
    const report = bag
      ? await analyzeBag(bag.folder, new Map(bag.files.map((f) => [f.name, f.file])), contract, opts)
      : await analyze(file, contract, { ...opts, filename: filename || file.name });
    // Reports hold Maps, BigInts and PyFloats; ship text so the main thread gets exact Python-identical JSON.
    self.postMessage({ type: 'result', json: reportJson(report), html: render(report), seconds: (performance.now() - started) / 1000 });
  } catch (e) {
    self.postMessage({ type: 'error', kind: e instanceof BagError ? 'bag' : 'internal', message: String((e && e.message) || e) });
  }
};
