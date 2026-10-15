// Contract language v1: a line-for-line port of src/tracecheck/contract.py.
// Unknown keys, duplicate keys and ambiguous numbers are errors.

import { JsonError, PyFloat, dumps, parse, utf8Length } from './json.js';

export const MAX_CONTRACT = 64 * 1024;
export const MISSING_CRC = ['warn', 'ignore'];
const U64_MAX = 2n ** 64n - 1n;

export class ContractError extends Error {}

function require(ok, message) {
  if (!ok) throw new ContractError(message);
}

const cpLen = (s) => [...s].length;
const isMap = (x) => x instanceof Map;
const pyList = (a) => '[' + a.map((x) => `'${x}'`).join(', ') + ']';

function keys(obj, allowed, where) {
  require(isMap(obj), `${where}: expected an object`);
  const unknown = [...obj.keys()].filter((k) => !allowed.includes(k)).sort();
  require(!unknown.length, `${where}: unknown keys ${pyList(unknown)}`);
}

function string(value, where) {
  require(typeof value === 'string' && cpLen(value) > 0 && cpLen(value) <= 256, `${where}: expected 1–256 characters`);
}

function number(value, where, integer = false) {
  const ok =
    typeof value === 'bigint'
      ? value >= 0n && value <= U64_MAX
      : !integer && value instanceof PyFloat && Number.isFinite(value.v) && value.v >= 0 && value.v <= 2 ** 64 - 1;
  require(ok, `${where}: expected a finite nonnegative ${integer ? 'integer' : 'number'}`);
}

/** Numeric value usable in comparisons: BigInt for ints, Number for floats. */
export const num = (x) => (x instanceof PyFloat ? x.v : x);

const get = (m, k, d) => (m.has(k) ? m.get(k) : d);

export function loads(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // like Python's utf-8-sig
  require(utf8Length(text) <= MAX_CONTRACT, 'contract exceeds 64 KiB');
  let value;
  try {
    value = parse(text);
  } catch (e) {
    if (e instanceof JsonError) throw new ContractError(e.message);
    throw e;
  }
  return validate(value);
}

export function validate(c) {
  keys(c, ['version', 'name', 'profile', 'missing_crc', 'metadata', 'topics'], 'contract');
  require(typeof c.get('version') === 'bigint' && c.get('version') === 1n, 'version must be 1');
  string(c.get('name'), 'name');
  if (c.has('profile')) {
    require(typeof c.get('profile') === 'string' && cpLen(c.get('profile')) <= 256, 'profile must be a string');
  }
  require(MISSING_CRC.includes(get(c, 'missing_crc', 'warn')), `missing_crc must be one of ${pyList(MISSING_CRC)}`);
  const metadata = get(c, 'metadata', new Map());
  keys(metadata, isMap(metadata) ? [...metadata.keys()] : [], 'metadata');
  for (const [name, fields] of metadata) {
    string(name, 'metadata name');
    require(isMap(fields) && fields.size <= 30, 'metadata fields must be an object, <=30 keys');
    for (const [key, expected] of fields) {
      string(key, 'metadata key');
      if (expected !== null) string(expected, 'metadata expected value');
    }
  }
  const topics = c.get('topics');
  require(isMap(topics) && topics.size > 0 && topics.size <= 50, 'topics must contain 1–50 entries');
  for (const [topic, t] of topics) {
    string(topic, 'topic');
    keys(t, ['required', 'message_encoding', 'schema_name', 'schema_encoding', 'schema_sha256', 'min_count', 'max_count',
      'time_basis', 'clock_confirmed', 'min_rate_hz', 'max_rate_hz', 'max_gap_ns',
      'check_regression', 'sequence', 'interval_ns', 'boundary_tolerance_ns'], topic);
    for (const k of ['required', 'clock_confirmed', 'check_regression']) {
      if (t.has(k)) require(typeof t.get(k) === 'boolean', `${topic}.${k}: expected boolean`);
    }
    for (const k of ['message_encoding', 'schema_name', 'schema_encoding']) {
      if (t.has(k)) string(t.get(k), `${topic}.${k}`);
    }
    if (t.has('schema_sha256')) {
      const v = t.get('schema_sha256');
      require(typeof v === 'string' && /^[0-9a-f]{64}$/.test(v), `${topic}.schema_sha256: expected 64 lowercase hex characters`);
    }
    for (const k of ['min_count', 'max_count', 'max_gap_ns', 'boundary_tolerance_ns']) {
      if (t.has(k)) number(t.get(k), `${topic}.${k}`, true);
    }
    for (const k of ['min_rate_hz', 'max_rate_hz']) {
      if (t.has(k)) number(t.get(k), `${topic}.${k}`);
    }
    for (const [lo, hi] of [['min_count', 'max_count'], ['min_rate_hz', 'max_rate_hz']]) {
      if (t.has(lo) && t.has(hi)) require(num(t.get(lo)) <= num(t.get(hi)), `${topic}: ${lo} exceeds ${hi}`);
    }
    require(['log_time', 'publish_time'].includes(get(t, 'time_basis', 'log_time')), `${topic}: unsupported time_basis`);
    require(['disabled', 'increment_mod32'].includes(get(t, 'sequence', 'disabled')), `${topic}: unsupported sequence policy`);
    if (t.has('interval_ns')) {
      const v = t.get('interval_ns');
      require(Array.isArray(v) && v.length === 2, `${topic}: interval_ns needs [start,end]`);
      for (const x of v) number(x, `${topic}.interval_ns`, true);
      require(v[0] < v[1], `${topic}: interval start must precede end`);
      require(get(t, 'boundary_tolerance_ns', 0n) * 2n <= v[1] - v[0], `${topic}: boundary tolerance too large`);
    }
  }
  require(utf8Length(dumps(c)) <= MAX_CONTRACT, 'contract exceeds 64 KiB');
  return c;
}
