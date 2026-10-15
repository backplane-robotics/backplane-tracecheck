// Browser engine tests: golden parity with the Python implementation, plus unit tests.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ContractError, loads } from '../src/engine/contract.js';
import { crc32 } from '../src/engine/crc32.js';
import { analyze, reportJson } from '../src/engine/engine.js';
import { PyFloat, dumps, parse, pyFloatRepr } from '../src/engine/json.js';
import { lz4Decompress } from '../src/engine/lz4.js';
import { DEFAULT_LIMITS, decompress } from '../src/engine/reader.js';
import { esc, render } from '../src/engine/report.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EX = join(ROOT, 'examples');
const expected = JSON.parse(readFileSync(join(EX, 'expected.json'), 'utf8'));
const blobOf = (name) => new Blob([readFileSync(join(EX, name))]);
const contractOf = (name) => loads(readFileSync(join(EX, name), 'utf8'));

describe('golden cases (examples/expected.json)', () => {
  for (const c of expected.cases) {
    it(`${c.file} ${c.fast ? 'fast' : 'full'}`, async () => {
      const r = await analyze(blobOf(c.file), contractOf(c.contract), { filename: c.file, fast: !!c.fast });
      expect(r.overall).toBe(c.overall);
      expect(r.scan_complete).toBe(c.scan_complete);
      expect(Object.fromEntries(r.checks.map((x) => [x.id, x.status]))).toEqual(c.checks);
      const html = render(r);
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(JSON.parse(reportJson(r)).overall).toBe(c.overall);
    });
  }
});

// Full-report parity: run the Python engine on the same inputs and compare JSON byte-for-byte,
// after removing fields that legitimately differ (time, implementation, wording about the device).
const PY = join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const VOLATILE = ['generated_utc', 'tool', 'provenance'];
function normalize(text) {
  const m = parse(text);
  for (const k of VOLATILE) m.delete(k);
  if (m.has('scan_stats')) m.get('scan_stats').delete('seconds');
  return dumps(m, { indent: 2, ensureAscii: false });
}

describe.skipIf(!existsSync(PY))('full report parity with Python', () => {
  const script = `
import json, sys
from pathlib import Path
from tracecheck.engine import analyze_file
ex = Path(sys.argv[1]); out = []
for case in json.loads((ex / 'expected.json').read_text(encoding='utf-8'))['cases']:
    c = json.loads((ex / case['contract']).read_text(encoding='utf-8'))
    out.append(json.dumps(analyze_file(ex / case['file'], c, fast=case.get('fast', False)), indent=2, ensure_ascii=False))
sys.stdout.buffer.write(json.dumps(out).encode('utf-8'))
`;
  const run = spawnSync(PY, ['-c', script, EX], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const reports = run.status === 0 ? JSON.parse(run.stdout) : null;
  it('python ran', () => expect(run.stderr || '').toBe(''));
  expected.cases.forEach((c, i) => {
    it(`${c.file} ${c.fast ? 'fast' : 'full'}`, async () => {
      const r = await analyze(blobOf(c.file), contractOf(c.contract), { filename: c.file, fast: !!c.fast });
      expect(normalize(reportJson(r))).toBe(normalize(reports[i]));
    });
  });
});

describe('json', () => {
  it('formats floats like Python repr', () => {
    expect(pyFloatRepr(1)).toBe('1.0');
    expect(pyFloatRepr(0.1)).toBe('0.1');
    expect(pyFloatRepr(1e16)).toBe('1e+16');
    expect(pyFloatRepr(1.5e-7)).toBe('1.5e-07');
    expect(pyFloatRepr(123456789012345.6)).toBe('123456789012345.6');
    expect(pyFloatRepr(0.0001)).toBe('0.0001');
    expect(pyFloatRepr(0.00001)).toBe('1e-05');
  });
  it('preserves ints, floats and key order', () => {
    const v = parse('{"b": 1, "a": 2.0, "c": 18446744073709551615}');
    expect(v.get('b')).toBe(1n);
    expect(v.get('a')).toBeInstanceOf(PyFloat);
    expect(dumps(v)).toBe('{"b": 1, "a": 2.0, "c": 18446744073709551615}');
    expect(dumps(v, { sortKeys: true, separators: [',', ':'] })).toBe('{"a":2.0,"b":1,"c":18446744073709551615}');
  });
  it('escapes non-ASCII like Python by default', () => {
    expect(dumps('é😀')).toBe('"\\u00e9\\ud83d\\ude00"');
    expect(dumps('é', { ensureAscii: false })).toBe('"é"');
  });
  it('rejects duplicate keys and NaN', () => {
    expect(() => parse('{"a":1,"a":2}')).toThrow();
    expect(() => parse('NaN')).toThrow();
  });
});

describe('contract', () => {
  it('rejects unknown keys and bad missing_crc', () => {
    expect(() => loads('{"version":1,"name":"x","topics":{"/a":{}},"bogus":1}')).toThrow(ContractError);
    expect(() => loads('{"version":1,"name":"x","topics":{"/a":{}},"missing_crc":"off"}')).toThrow(ContractError);
    expect(loads('{"version":1,"name":"x","topics":{"/a":{}},"missing_crc":"ignore"}').get('missing_crc')).toBe('ignore');
  });
});

describe('codecs and limits', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('lz4 rejects output larger than declared', () => {
    // Frame: magic, FLG (version 01, block independence), BD (64 KiB), HC; one uncompressed block "hello"; end mark.
    const frame = new Uint8Array([0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82, 5, 0, 0, 0x80, 104, 101, 108, 108, 111, 0, 0, 0, 0]);
    expect(new TextDecoder().decode(lz4Decompress(frame, 5))).toBe('hello');
    expect(() => lz4Decompress(frame, 4)).toThrow();
  });
  it('rejects unsupported compression and oversize declarations', () => {
    expect(() => decompress('brotli', new Uint8Array(4), 4)).toThrow();
    expect(DEFAULT_LIMITS.max_chunk_uncompressed_bytes).toBe(256 * 1024 * 1024);
  });
  it.skipIf(!zlib.zstdCompressSync)('zstd output is capped at the declared size', () => {
    const bomb = zlib.zstdCompressSync(new Uint8Array(8 << 20)); // 8 MiB of zeros, a few hundred bytes compressed
    expect(bomb.length).toBeLessThan(4096);
    expect(() => decompress('zstd', new Uint8Array(bomb), 1024)).toThrow();
    expect(() => decompress('zstd', new Uint8Array(bomb), (8 << 20) + 1)).toThrow();
    expect(decompress('zstd', new Uint8Array(bomb), 8 << 20).length).toBe(8 << 20);
  });
  it('reports a truncated file as an incomplete scan', async () => {
    const r = await analyze(blobOf('truncated.mcap'), contractOf('demo-contract.json'));
    expect(r.scan_complete).toBe(false);
    expect(r.checks[0].status).toBe('fail');
  });
  it('escapes HTML', () => {
    expect(esc(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#x27;&amp;');
  });
});
