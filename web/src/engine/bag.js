// ROS 2 bag folders: a port of src/tracecheck/bag.py (keep the two in step).
// Reads metadata.yaml with a small, bounded YAML-subset parser and decides which .mcap files
// make up the recording. Mappings parse to Map, whole numbers to BigInt.

export const META_NAME = 'metadata.yaml';
export const META_LIMIT = 1 << 20; // bytes
export const MAX_FILES = 1000;
const DEPTH_LIMIT = 32;
const INT = /^[0-9]{1,20}$/;
const HEX = /^[0-9a-fA-F]+$/;
const ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b' };

/** The folder cannot be checked as a bag (for example, a non-MCAP storage format). */
export class BagError extends Error {
  get name() {
    return 'BagError';
  }
}
/** metadata.yaml could not be read. */
export class MetaError extends Error {
  get name() {
    return 'MetaError';
  }
}

// Python str.strip(" \t") and friends.
const lstripWs = (s) => s.replace(/^[ \t]+/, '');
const rstripWs = (s) => s.replace(/[ \t]+$/, '');
const stripWs = (s) => rstripWs(lstripWs(s));
const isDash = (s) => s === '-' || s.startsWith('- ');

// ----------------------------------------------------------------------------- YAML subset

function afterQuote(rest) {
  const t = stripWs(rest);
  if (t && !t.startsWith('#')) throw new MetaError('text after a quoted value');
}

function scalar(text) {
  const s = stripWs(text);
  if (['', '~', 'null', 'Null', 'NULL'].includes(s)) return null;
  if (s === '{}') return new Map();
  if (s === '[]') return [];
  if (s[0] === '"') {
    let out = '';
    let i = 1;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        afterQuote(s.slice(i + 1));
        return out;
      }
      if (ch === '\\') {
        i++;
        if (i >= s.length) break;
        const e = s[i];
        if (e in ESCAPES) out += ESCAPES[e];
        else if (e === 'x' || e === 'u' || e === 'U') {
          const n = { x: 2, u: 4, U: 8 }[e];
          const digits = s.slice(i + 1, i + 1 + n);
          if (digits.length !== n || !HEX.test(digits)) throw new MetaError('bad escape in quoted value');
          const v = parseInt(digits, 16);
          if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) throw new MetaError('bad escape in quoted value');
          out += String.fromCodePoint(v);
          i += n;
        } else throw new MetaError('bad escape in quoted value');
      } else out += ch;
      i++;
    }
    throw new MetaError('unterminated quoted value');
  }
  if (s[0] === "'") {
    let out = '';
    let i = 1;
    while (i < s.length) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        afterQuote(s.slice(i + 1));
        return out;
      }
      out += s[i];
      i++;
    }
    throw new MetaError('unterminated quoted value');
  }
  if ('[{&*!|>%@`'.includes(s[0])) throw new MetaError('unsupported YAML value');
  const cut = s.indexOf(' #');
  return rstripWs(cut >= 0 ? s.slice(0, cut) : s);
}

/** [key, rest] for "key: value" or "key:"; null if the line is not a mapping entry. */
function keySplit(content) {
  if (content[0] === '"' || content[0] === "'") throw new MetaError('quoted keys are not supported');
  const i = content.indexOf(': ');
  if (i < 0) return content.endsWith(':') ? [rstripWs(content.slice(0, -1)), ''] : null;
  return [rstripWs(content.slice(0, i)), content.slice(i + 2)];
}

class Lines {
  constructor(text) {
    this.items = [];
    for (const raw of text.split('\n')) {
      const line = raw.replace(/[ \t\r]+$/, '');
      const stripped = line.replace(/^ +/, '');
      if (!stripped || stripped.startsWith('#')) continue;
      if (stripped.startsWith('\t')) throw new MetaError('tab indentation');
      if (stripped === '---' || stripped === '...') continue;
      if (stripped.startsWith('%')) throw new MetaError('YAML directives are not supported');
      this.items.push([line.length - stripped.length, stripped]);
    }
    this.i = 0;
  }
}

function blockScalar(lines, indent, header) {
  if (!['|', '|-', '|+', '>', '>-', '>+'].includes(header)) throw new MetaError('unsupported block scalar');
  const parts = [];
  while (lines.i < lines.items.length && lines.items[lines.i][0] > indent) parts.push(lines.items[lines.i++][1]);
  return parts.join(header[0] === '|' ? '\n' : ' ');
}

function value(lines, indent, rest, depth) {
  const r = stripWs(rest);
  if (r[0] === '|' || r[0] === '>') return blockScalar(lines, indent, stripWs(r.split(' #')[0]));
  if (r) return scalar(r);
  if (lines.i < lines.items.length) {
    const [nextIndent, next] = lines.items[lines.i];
    if (nextIndent > indent || (nextIndent === indent && isDash(next))) return block(lines, nextIndent, depth + 1);
  }
  return null;
}

function block(lines, indent, depth) {
  if (depth > DEPTH_LIMIT) throw new MetaError('nesting too deep');
  if (isDash(lines.items[lines.i][1])) {
    const seq = [];
    while (lines.i < lines.items.length) {
      const [ind, content] = lines.items[lines.i];
      if (ind !== indent || !isDash(content)) break;
      const rest = content.slice(1);
      const body = rest.replace(/^ +/, '');
      if (!body) {
        lines.i++;
        seq.push(value(lines, indent, '', depth));
        continue;
      }
      if (body[0] === '|' || body[0] === '>' || body[0] === '"' || body[0] === "'" || keySplit(body) === null) {
        lines.i++;
        seq.push(value(lines, indent, body, depth));
        continue;
      }
      // "- key: value" starts a mapping whose entries sit at the column after "- ".
      lines.items[lines.i] = [indent + rest.length - body.length + 1, body];
      seq.push(block(lines, lines.items[lines.i][0], depth + 1));
    }
    return seq;
  }
  const mapping = new Map();
  while (lines.i < lines.items.length) {
    const [ind, content] = lines.items[lines.i];
    if (ind < indent) break;
    if (ind > indent) throw new MetaError('unexpected indentation');
    if (isDash(content)) break;
    const kv = keySplit(content);
    if (kv === null || !kv[0]) throw new MetaError("expected 'key: value'");
    const [key, rest] = kv;
    if (mapping.has(key)) throw new MetaError('duplicate key');
    lines.i++;
    mapping.set(key, value(lines, indent, rest, depth));
  }
  return mapping;
}

export function parseYaml(text) {
  const lines = new Lines(text);
  if (!lines.items.length) throw new MetaError('empty document');
  if (lines.items[0][0] !== 0) throw new MetaError('unexpected indentation');
  const out = block(lines, 0, 0);
  if (lines.i !== lines.items.length) throw new MetaError('unexpected indentation');
  return out;
}

// ----------------------------------------------------------------------------- bag metadata

const isMap = (v) => v instanceof Map;
const getv = (m, k) => (m.has(k) ? m.get(k) : null);

function int(v, what) {
  if (v === null) return null;
  if (typeof v !== 'string' || !INT.test(v)) throw new MetaError(`${what} is not a whole number`);
  return BigInt(v);
}

function str(v) {
  if (v === null || typeof v === 'string') return v;
  throw new MetaError('expected a text value');
}

function basename(path) {
  const name = path.split(/[\\/]/).pop();
  if (name === '' || name === '.' || name === '..') throw new MetaError('bad file path');
  return name;
}

/** Extract what Tracecheck needs from metadata.yaml. Throws MetaError. */
export function parseInfo(text) {
  const doc = parseYaml(text);
  const root = isMap(doc) ? getv(doc, 'rosbag2_bagfile_information') : null;
  if (!isMap(root)) throw new MetaError('no rosbag2_bagfile_information section');
  const filesMeta = getv(root, 'files');
  const claimed = new Map();
  if (filesMeta !== null) {
    if (!Array.isArray(filesMeta)) throw new MetaError('files is not a list');
    for (const item of filesMeta) {
      if (!isMap(item) || typeof getv(item, 'path') !== 'string') throw new MetaError('bad files entry');
      claimed.set(basename(item.get('path')), int(getv(item, 'message_count'), 'file message_count'));
    }
  }
  const rel = getv(root, 'relative_file_paths');
  let listed;
  if (rel === null) listed = [...claimed.keys()];
  else if (Array.isArray(rel) && rel.every((p) => typeof p === 'string')) listed = rel.map(basename);
  else throw new MetaError('relative_file_paths is not a list of paths');
  if (new Set(listed).size !== listed.length) throw new MetaError('a file is listed twice');
  const topics = [];
  const rawTopics = getv(root, 'topics_with_message_count');
  // Python: `root.get(...) or []` treats an empty mapping, list or text as no topics.
  const empty = rawTopics === null || rawTopics === '' || (isMap(rawTopics) && rawTopics.size === 0) ||
    (Array.isArray(rawTopics) && rawTopics.length === 0);
  if (!empty) {
    if (!Array.isArray(rawTopics)) throw new MetaError('topics_with_message_count is not a list');
    for (const item of rawTopics) {
      const meta = isMap(item) ? getv(item, 'topic_metadata') : null;
      if (!isMap(meta) || typeof getv(meta, 'name') !== 'string') throw new MetaError('bad topics_with_message_count entry');
      topics.push({ name: meta.get('name'), type: str(getv(meta, 'type')), message_count: int(getv(item, 'message_count'), 'topic message_count') });
    }
  }
  return {
    version: int(getv(root, 'version'), 'version'),
    storage_identifier: str(getv(root, 'storage_identifier')),
    ros_distro: str(getv(root, 'ros_distro')),
    compression_format: str(getv(root, 'compression_format')) || '',
    compression_mode: str(getv(root, 'compression_mode')) || '',
    message_count: int(getv(root, 'message_count'), 'message_count'),
    files: listed.map((n) => ({ name: n, message_count: claimed.has(n) ? claimed.get(n) : null })),
    topics,
  };
}

/** Python's natural-sort key comparison: digit runs compare as numbers, then the plain name. */
function naturalKey(name) {
  return name.split(/([0-9]+)/).filter((p) => p).map((p) => ('0123456789'.includes(p[0]) ? [0, BigInt(p), ''] : [1, 0n, p]));
}
function cmpStr(a, b) {
  const x = [...a];
  const y = [...b];
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    const d = x[k].codePointAt(0) - y[k].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
function cmpNatural(a, b) {
  const x = naturalKey(a);
  const y = naturalKey(b);
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    const [p, q] = [x[k], y[k]];
    if (p[0] !== q[0]) return p[0] - q[0];
    if (p[1] !== q[1]) return p[1] < q[1] ? -1 : 1;
    const d = cmpStr(p[2], q[2]);
    if (d) return d;
  }
  return x.length - y.length || cmpStr(a, b);
}

/**
 * Decide which files form the recording. `names` are the plain file names in the bag folder.
 * `metaError` marks a metadata.yaml that exists but could not be read as text. Returns the
 * `bag` report section without scan results. Throws BagError when the folder can't be checked.
 */
export function plan(folder, names, metaText, metaSha256 = null, metaError = null) {
  const present = new Set(names);
  const mcaps = names.filter((n) => n.endsWith('.mcap')).sort(cmpNatural);
  let info = null;
  let error = metaError;
  if (metaError !== null) metaText = '';
  else if (metaText !== null) {
    try {
      info = parseInfo(metaText);
    } catch (e) {
      if (!(e instanceof MetaError || e instanceof RangeError)) throw e;
      error = [...String(e.message)].slice(0, 200).join('');
    }
  }
  const bag = { folder, metadata: metaText === null ? 'absent' : info === null ? 'unreadable' : 'present' };
  if (error !== null) bag.metadata_error = error;
  bag.metadata_sha256 = metaSha256;
  let files;
  if (info !== null) {
    const storage = info.storage_identifier || '';
    if (storage !== '' && storage !== 'mcap')
      throw new BagError(`this bag uses ${pyRepr([...storage].slice(0, 40).join(''))} storage; only MCAP bags can be checked`);
    if (info.compression_mode.toLowerCase() === 'file') throw new BagError('this bag uses rosbag2 file compression; decompress it first');
    Object.assign(bag, { ros_distro: info.ros_distro, storage_identifier: info.storage_identifier,
      message_count_claimed: info.message_count, topics_claimed: info.topics });
    files = info.files.map((f) => ({ name: f.name, listed: true, present: present.has(f.name), messages_claimed: f.message_count }));
    const listed = new Set(files.map((f) => f.name));
    for (const n of mcaps) if (!listed.has(n)) files.push({ name: n, listed: false, present: true, messages_claimed: null });
  } else {
    files = mcaps.map((n) => ({ name: n, listed: null, present: true, messages_claimed: null }));
  }
  if (files.length > MAX_FILES) throw new BagError(`bag folder lists more than ${MAX_FILES} files`);
  if (!files.some((f) => f.present && f.listed !== false)) throw new BagError('no MCAP recording files found in the bag folder');
  bag.files = files;
  return bag;
}

/** Python repr() of a short str (quotes and backslashes; enough for error messages). */
function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q) + q;
}
