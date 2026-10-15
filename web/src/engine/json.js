// Strict JSON that behaves like Python's `json` module for Tracecheck's purposes:
//   * integers parse to BigInt (exact, like Python int); floats parse to PyFloat
//   * objects parse to Map (insertion order kept, even for numeric-looking keys)
//   * duplicate keys, NaN/Infinity, control characters and deep nesting are errors
//   * dumps() reproduces json.dumps output, including Python's float repr, so the
//     canonical contract hash matches the Python implementation byte for byte.

export class JsonError extends Error {}

/** A JSON number that Python would parse as float (it had a fraction or exponent). */
export class PyFloat {
  constructor(v) {
    this.v = v;
  }
  valueOf() {
    return this.v;
  }
}

const MAX_DEPTH = 500;
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUM = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

export function parse(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => {
    throw new JsonError(`${msg} at position ${i}`);
  };
  const ws = () => {
    while (i < n && WS.has(text.charCodeAt(i))) i++;
  };
  function str() {
    i++; // opening quote
    let out = '';
    let start = i;
    for (;;) {
      if (i >= n) fail('Unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i++);
        return out;
      }
      if (c < 0x20) fail('Invalid control character in string');
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        i += 2;
        if (e === 'u') {
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Invalid \\uXXXX escape');
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        } else {
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!(e in map)) fail('Invalid escape');
          out += map[e];
        }
        start = i;
      } else i++;
    }
  }
  function value(depth) {
    if (depth > MAX_DEPTH) fail('Nesting too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const m = new Map();
      ws();
      if (text[i] === '}') {
        i++;
        return m;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expecting property name enclosed in double quotes');
        const k = str();
        ws();
        if (text[i] !== ':') fail("Expecting ':' delimiter");
        i++;
        const v = value(depth + 1);
        if (m.has(k)) throw new JsonError(`duplicate key: ${k}`);
        m.set(k, v);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return m;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return a;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) return (i += 4), true;
    if (text.startsWith('false', i)) return (i += 5), false;
    if (text.startsWith('null', i)) return (i += 4), null;
    for (const k of ['NaN', 'Infinity', '-Infinity']) if (text.startsWith(k, i)) fail(`invalid number: ${k}`);
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m) fail('Expecting value');
    i = NUM.lastIndex;
    return m[1] || m[2] ? new PyFloat(Number(m[0])) : BigInt(m[0]);
  }
  const v = value(0);
  ws();
  if (i !== n) fail('Extra data');
  return v;
}

/** Python repr() of a float, e.g. 10.0, 0.1, 1e-05, 1e+16. */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  let [mant, e] = x.toExponential().split('e');
  const exp = parseInt(e, 10);
  const neg = mant[0] === '-';
  if (neg) mant = mant.slice(1);
  const d = mant.replace('.', '');
  let out;
  if (exp < -4 || exp >= 16) {
    out = d[0] + (d.length > 1 ? '.' + d.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  } else if (exp >= 0) {
    out = d.length <= exp + 1 ? d + '0'.repeat(exp + 1 - d.length) + '.0' : d.slice(0, exp + 1) + '.' + d.slice(exp + 1);
  } else {
    out = '0.' + '0'.repeat(-exp - 1) + d;
  }
  return (neg ? '-' : '') + out;
}

function cmpCodePoints(a, b) {
  const x = [...a];
  const y = [...b];
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    const d = x[k].codePointAt(0) - y[k].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

function quote(s, ensureAscii) {
  const q = JSON.stringify(s);
  if (!ensureAscii) return q;
  return q.replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * Serialize like Python json.dumps. Supported values: null, boolean, string, BigInt (int),
 * PyFloat (float), number (int when integral, else float), Array, Map and plain objects.
 */
export function dumps(value, { indent = null, sortKeys = false, ensureAscii = true, separators = null } = {}) {
  const [itemSep, keySep] = separators || (indent === null ? [', ', ': '] : [',', ': ']);
  const pad = (level) => (indent === null ? '' : '\n' + ' '.repeat(indent * level));
  function enc(v, level) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'string') return quote(v, ensureAscii);
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof PyFloat) return pyFloatRepr(v.v);
    if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? String(v) : pyFloatRepr(v);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return '[' + v.map((x) => pad(level + 1) + enc(x, level + 1)).join(itemSep) + pad(level) + ']';
    }
    let entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
    if (sortKeys) entries = entries.sort((a, b) => cmpCodePoints(a[0], b[0]));
    if (!entries.length) return '{}';
    return '{' + entries.map(([k, x]) => pad(level + 1) + quote(k, ensureAscii) + keySep + enc(x, level + 1)).join(itemSep) + pad(level) + '}';
  }
  return enc(value, 0);
}

/** UTF-8 byte length of a string. */
export const utf8Length = (s) => new TextEncoder().encode(s).length;
