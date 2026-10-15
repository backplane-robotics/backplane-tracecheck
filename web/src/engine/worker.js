// Module Web Worker: runs the scan off the main thread. The file is read from the
// File handle in slices; nothing is uploaded anywhere.

import { ContractError, loads } from './contract.js';
import { analyze, reportJson } from './engine.js';
import { DEFAULT_LIMITS } from './reader.js';
import { render } from './report.js';

self.onmessage = async (event) => {
  const { file, contractText, fast = false, ignoreCrc = false, filename } = event.data || {};
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
    const report = await analyze(file, contract, { filename: filename || file.name, fast, limits: DEFAULT_LIMITS, progress });
    // Reports hold Maps, BigInts and PyFloats; ship text so the main thread gets exact Python-identical JSON.
    self.postMessage({ type: 'result', json: reportJson(report), html: render(report), seconds: (performance.now() - started) / 1000 });
  } catch (e) {
    self.postMessage({ type: 'error', kind: 'internal', message: String((e && e.message) || e) });
  }
};
