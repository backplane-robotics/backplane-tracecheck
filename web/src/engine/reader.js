// Strict, bounded, streaming MCAP reader: a port of src/tracecheck/reader.py.
// Reads a Blob/File sequentially with Blob.slice(), so multi-GB recordings never have to fit
// in memory. SHA-256 and the MCAP CRCs are computed on the fly. Payloads are never decoded.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { crc32 } from './crc32.js';
import { lz4Decompress } from './lz4.js';
import { decompressInto } from './vendor/fzstd.js';

export const MAGIC = new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]);
export const OP = { HEADER: 1, FOOTER: 2, SCHEMA: 3, CHANNEL: 4, MESSAGE: 5, CHUNK: 6, MESSAGE_INDEX: 7, CHUNK_INDEX: 8,
  ATTACHMENT: 9, ATTACHMENT_INDEX: 10, STATISTICS: 11, METADATA: 12, METADATA_INDEX: 13, SUMMARY_OFFSET: 14, DATA_END: 15 };
const KNOWN = (op) => op >= 1 && op <= 15;
export const MiB = 1 << 20;
export const TEXT_LIMIT = 1024;
export const META_VALUE_LIMIT = 65536;
export const META_PAIRS_LIMIT = 100;
const FOOTER_RECORD_SIZE = 1 + 8 + 20;
const SUPPORTED = ['', 'zstd', 'lz4'];

export const DEFAULT_LIMITS = Object.freeze({
  max_record_bytes: 256 * MiB,
  max_chunk_uncompressed_bytes: 256 * MiB,
  max_summary_bytes: 256 * MiB,
  max_messages: 1e12,
  max_records: 1e12,
  max_tracked_messages: 20_000_000,
  max_entities: 10_000,
  max_seconds: null,
  evidence_per_finding: 20,
});

export class ScanError extends Error {
  get name() {
    return 'ScanError';
  }
}
export class ScanTimeout extends ScanError {
  get name() {
    return 'ScanTimeout';
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const hex = (bytes) => bytesToHex(sha256(bytes));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ----------------------------------------------------------------------------- parsing

/** Strict little-endian field reader over a Uint8Array window [p, end). */
class Cursor {
  constructor(b, start = 0, end = b.length) {
    this.b = b;
    this.p = start;
    this.end = end;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  take(n) {
    if (n < 0 || n > this.end - this.p) throw new ScanError('field exceeds record boundary');
    const p = this.p;
    this.p = p + n;
    return p;
  }
  u16() {
    return this.dv.getUint16(this.take(2), true);
  }
  u32() {
    return this.dv.getUint32(this.take(4), true);
  }
  u64() {
    return this.dv.getBigUint64(this.take(8), true);
  }
  /** u64 as a Number; values beyond 2^53 become Infinity so bounds checks reject them. */
  u64n() {
    const v = this.u64();
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : Infinity;
  }
  bytes(n) {
    const p = this.take(n);
    return this.b.subarray(p, p + n);
  }
  string(limit = TEXT_LIMIT) {
    const n = this.u32();
    const p = this.take(n);
    if (n > limit * 4) throw new ScanError(`record text field exceeds ${limit} characters`);
    let s;
    try {
      s = utf8.decode(this.b.subarray(p, p + n));
    } catch {
      throw new ScanError('record text field is not valid UTF-8');
    }
    if (n > limit && [...s].length > limit) throw new ScanError(`record text field exceeds ${limit} characters`);
    return s;
  }
  stringMap() {
    const n = this.u32();
    const sub = new Cursor(this.b, this.take(n), this.p);
    const out = new Map();
    let pairs = 0;
    while (sub.p < sub.end) {
      if (++pairs > META_PAIRS_LIMIT) throw new ScanError('metadata field or pair count exceeds limit');
      const k = sub.string(TEXT_LIMIT);
      out.set(k, sub.string(META_VALUE_LIMIT));
    }
    return out;
  }
  u16u64Map() {
    const n = this.u32();
    const sub = new Cursor(this.b, this.take(n), this.p);
    const out = new Map();
    while (sub.p < sub.end) {
      const k = sub.u16();
      out.set(k, sub.u64n());
    }
    return out;
  }
}

function parseSchema(c) {
  const id = c.u16();
  const name = c.string();
  const encoding = c.string();
  const data = c.bytes(c.u32());
  if (id === 0) throw new ScanError('schema id zero is reserved');
  return [id, { name, encoding, sha256: hex(data) }];
}

function parseChannel(c) {
  const id = c.u16();
  const schema_id = c.u16();
  const topic = c.string();
  const message_encoding = c.string();
  const metadata = c.stringMap();
  return [id, { topic, schema_id, message_encoding, metadata }];
}

function* iterRecords(buf, start = 0, end = buf.length) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = start;
  while (p < end) {
    if (end - p < 9) throw new ScanError('truncated record header');
    const op = buf[p];
    const len = dv.getBigUint64(p + 1, true);
    const body = p + 9;
    if (len > BigInt(end - body)) throw new ScanError('record extends beyond its container');
    yield [p, op, body, body + Number(len)];
    p = body + Number(len);
  }
}

export function decompress(compression, data, size) {
  if (compression !== 'zstd' && compression !== 'lz4') throw new ScanError(`unsupported compression: '${compression.slice(0, 40)}'`);
  let out;
  try {
    if (compression === 'zstd') {
      out = new Uint8Array(size);
      const n = decompressInto(data, out);
      if (n !== size) throw new ScanError('decompressed chunk size differs from declared uncompressed size');
    } else {
      out = lz4Decompress(data, size);
    }
  } catch (e) {
    if (e instanceof ScanError) throw e;
    const msg = String(e && e.message);
    if (msg.includes('exceeds declared size') || msg.includes('differs from declared'))
      throw new ScanError('decompressed chunk size differs from declared uncompressed size');
    throw new ScanError(`${compression} chunk decompression failed: ${msg.slice(0, 120)}`);
  }
  return out;
}

// ----------------------------------------------------------------------------- tracking

/** Growable typed array. */
class Grow {
  constructor(Type) {
    this.T = Type;
    this.a = new Type(1024);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.T(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  get(i) {
    return this.a[i];
  }
}

/** Incremental per-channel statistics; see reader.py Track. Messages are [ord, a, b, log, pub, seq]. */
export class Track {
  constructor(cid, cfg, evidence) {
    this.cid = cid;
    this.cfg = cfg;
    this.ev = evidence;
    this.count = 0;
    this.first = this.last = this.lo = this.hi = null;
    this.monotonic = true;
    this.seqBad = [];
    this.regBad = [];
    this.gapBad = [];
    this.seqBadN = this.regBadN = this.gapBadN = 0;
    if (cfg && cfg.maxGap !== null) {
      this.times = new Grow(BigUint64Array);
      this.ords = new Grow(Float64Array);
      this.locA = new Grow(Float64Array);
      this.locB = new Grow(Float64Array);
    } else this.times = null;
  }
  add(m) {
    this.count++;
    const cfg = this.cfg;
    const k = cfg.basisLog ? 3 : 4;
    const t = m[k];
    const prev = this.last;
    if (prev === null) {
      this.first = this.lo = this.hi = m;
    } else {
      if (cfg.sequence && m[5] !== ((prev[5] + 1) >>> 0)) {
        this.seqBadN++;
        if (this.seqBad.length < this.ev) this.seqBad.push([prev, m]);
      }
      const pt = prev[k];
      if (t < pt) {
        this.monotonic = false;
        this.regBadN++;
        if (this.regBad.length < this.ev) this.regBad.push([prev, m]);
      } else if (this.monotonic && cfg.maxGap !== null && t - pt > cfg.maxGap) {
        this.gapBadN++;
        if (this.gapBad.length < this.ev) this.gapBad.push([prev, m]);
      }
      if (t < this.lo[k]) this.lo = m;
      if (t >= this.hi[k]) this.hi = m;
    }
    this.last = m;
    if (this.times) {
      this.times.push(t);
      this.ords.push(m[0]);
      this.locA.push(m[1]);
      this.locB.push(m[2]);
    }
  }
  /** [sample, total]; sample items are [a, b, gap] where a/b are messages (in-order) or indices. */
  sortedGaps() {
    const k = this.cfg.basisLog ? 3 : 4;
    if (this.monotonic) return [this.gapBad.map(([a, b]) => [a, b, b[k] - a[k]]), this.gapBadN];
    const times = this.times.a;
    const n = this.times.n;
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((x, y) => (times[x] < times[y] ? -1 : times[x] > times[y] ? 1 : x - y));
    const sample = [];
    let total = 0;
    for (let i = 1; i < n; i++) {
      const a = order[i - 1];
      const b = order[i];
      const g = times[b] - times[a];
      if (g > this.cfg.maxGap) {
        total++;
        if (sample.length < this.ev) sample.push([a, b, g]);
      }
    }
    return [sample, total];
  }
}

function mapEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) return false;
  return true;
}

function newResult(mode, size) {
  return { mode, size, sha256: null, profile: null, schemas: new Map(), channels: new Map(), metadata: [],
    tracks: new Map(), counts: null, crc: {}, compression: {}, unknown: 0, stats: {}, fastFallback: null };
}

class Registry {
  constructor(r, limits) {
    this.r = r;
    this.limits = limits;
  }
  bound() {
    const { r } = this;
    const n = this.limits.max_entities;
    if (r.channels.size > n || r.schemas.size > n || r.metadata.length > n)
      throw new ScanError(`channel/schema/metadata count exceeds ${n}`);
  }
  schema(c, loc) {
    const [id, value] = parseSchema(c);
    const old = this.r.schemas.get(id);
    if (old && (old.value.name !== value.name || old.value.encoding !== value.encoding || old.value.sha256 !== value.sha256))
      throw new ScanError('conflicting repeated schema id');
    if (!old) this.r.schemas.set(id, { value, location: loc });
    this.bound();
  }
  channel(c, loc) {
    const [id, value] = parseChannel(c);
    if (value.schema_id && !this.r.schemas.has(value.schema_id)) throw new ScanError('channel references undefined schema');
    const old = this.r.channels.get(id);
    if (old) {
      const o = old.value;
      if (o.topic !== value.topic || o.schema_id !== value.schema_id || o.message_encoding !== value.message_encoding ||
          !mapEquals(o.metadata, value.metadata))
        throw new ScanError('conflicting repeated channel id');
    } else this.r.channels.set(id, { value, location: loc });
    this.bound();
    return id;
  }
  metadata(c, loc) {
    const name = c.string();
    const fields = c.stringMap();
    this.r.metadata.push({ name, fields, location: loc });
    this.bound();
  }
}

/** Sequential Blob reader that hashes every byte once (at load) and CRCs consumed bytes. */
class Source {
  constructor(blob, progress) {
    this.blob = blob;
    this.size = blob.size;
    this.pos = 0;
    this.buf = new Uint8Array(0);
    this.bufStart = 0;
    this.loaded = 0;
    this.sha = sha256.create();
    this.crc = 0;
    this.progress = progress;
  }
  has(n) {
    return this.pos + n <= this.bufStart + this.buf.length;
  }
  async fill(n) {
    if (n < 0 || n > this.size - this.pos) throw new ScanError('record extends beyond end of file');
    const need = this.pos + n - this.loaded;
    if (need > 0) {
      const start = this.loaded;
      const end = Math.min(this.size, start + Math.max(8 * MiB, need));
      const bytes = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
      if (bytes.length !== end - start) throw new ScanError('unexpected end of file');
      this.sha.update(bytes);
      this.loaded = end;
      const tail = this.buf.subarray(this.pos - this.bufStart);
      if (tail.length) {
        const merged = new Uint8Array(tail.length + bytes.length);
        merged.set(tail);
        merged.set(bytes, tail.length);
        this.buf = merged;
      } else this.buf = bytes;
      this.bufStart = this.pos;
      if (this.progress) this.progress(this.loaded, this.size);
    }
  }
  /** Consume n bytes that are already buffered (call has()/fill() first). */
  take(n) {
    const off = this.pos - this.bufStart;
    const view = this.buf.subarray(off, off + n);
    this.crc = crc32(view, this.crc);
    this.pos += n;
    return view;
  }
  async read(n) {
    if (!this.has(n)) await this.fill(n);
    return this.take(n);
  }
  async skip(n) {
    if (n < 0 || n > this.size - this.pos) throw new ScanError('record extends beyond end of file');
    while (n > 0) {
      const step = Math.min(n, 4 * MiB);
      await this.read(step);
      n -= step;
    }
  }
  async drain() {
    try {
      while (this.loaded < this.size) {
        const end = Math.min(this.size, this.loaded + 8 * MiB);
        this.sha.update(new Uint8Array(await this.blob.slice(this.loaded, end).arrayBuffer()));
        this.loaded = end;
        if (this.progress) this.progress(this.loaded, this.size);
      }
      return true;
    } catch {
      return false;
    }
  }
}

// ----------------------------------------------------------------------------- full scan

export async function scanFull(blob, plan, limits = DEFAULT_LIMITS, progress = null) {
  const started = performance.now();
  const size = blob.size;
  const r = newResult('full', size);
  r.crc = { data_section: 'absent', chunk_present_verified: 0, chunk_absent: 0, summary: 'no summary section', attachments: 'not checked' };
  const reg = new Registry(r, limits);
  const src = new Source(blob, progress);
  const stats = { records: 0, messages: 0, unchunked_messages: 0, chunks: 0, attachments_skipped: 0 };
  r.stats = stats;
  const tracks = r.tracks;
  const ev = limits.evidence_per_finding;
  let tracked = 0;
  let ended = false;
  let headerSeen = false;
  let summaryCrcStart = null;

  const onMessage = (buf, dv, body, end, a, b) => {
    if (end - body < 22) throw new ScanError('message record too short');
    const cid = dv.getUint16(body, true);
    const tr = tracks.get(cid);
    if (ended || tr === undefined) throw new ScanError('message after DataEnd or undefined channel');
    if (++stats.messages > limits.max_messages) throw new ScanError(`message count exceeds ${limits.max_messages}`);
    if (tr.cfg === null) {
      tr.count++;
      return;
    }
    if (tr.times && ++tracked > limits.max_tracked_messages)
      throw new ScanError(`gap-check timestamp storage exceeds ${limits.max_tracked_messages} messages; raise the max_tracked_messages limit`);
    tr.add([stats.messages, a, b, dv.getBigUint64(body + 6, true), dv.getBigUint64(body + 14, true), dv.getUint32(body + 2, true)]);
  };
  const onChannel = (c, loc) => {
    const cid = reg.channel(c, loc);
    if (!tracks.has(cid)) tracks.set(cid, new Track(cid, plan(r.channels.get(cid).value.topic), ev));
  };
  const countRecord = () => {
    if (++stats.records > limits.max_records) throw new ScanError('record count exceeds limit');
    if (limits.max_seconds !== null && (stats.records & 0x3ff) === 0 && performance.now() - started > limits.max_seconds * 1000)
      throw new ScanTimeout(`scan time exceeds ${limits.max_seconds} seconds`);
  };

  try {
    if (size < 8 || !same(await src.read(8), MAGIC)) throw new ScanError('not an MCAP file (bad magic)');
    for (;;) {
      if (size - src.pos < 9) throw new ScanError('unexpected end of file (missing footer)');
      const crcBefore = src.crc;
      const offset = src.pos;
      const head = await src.read(9);
      const op = head[0];
      const lenBig = new DataView(head.buffer, head.byteOffset, 9).getBigUint64(1, true);
      const length = lenBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(lenBig) : Infinity;
      countRecord();
      if (!headerSeen && op !== OP.HEADER) throw new ScanError('first record must be Header');
      const loc = { file_offset: offset };
      if (op === OP.FOOTER) {
        if (length < 20) throw new ScanError('footer record too short');
        const body = await src.read(16);
        const summaryStart = new DataView(body.buffer, body.byteOffset, 16).getBigUint64(0, true);
        const crcMid = src.crc;
        const c4 = await src.read(4);
        const summaryCrc = new DataView(c4.buffer, c4.byteOffset, 4).getUint32(0, true);
        await src.skip(length - 20);
        if (summaryStart === 0n) r.crc.summary = 'no summary section';
        else if (summaryCrcStart === null || summaryStart !== BigInt(summaryCrcStart)) r.crc.summary = 'not checked';
        else if (summaryCrc === 0) r.crc.summary = 'absent';
        else if (summaryCrc !== crcMid) throw new ScanError('summary CRC mismatch');
        else r.crc.summary = 'verified';
        if (size - src.pos < 8 || !same(await src.read(8), MAGIC)) throw new ScanError('missing trailing magic');
        if (src.pos !== size) throw new ScanError('trailing bytes after footer magic');
        break;
      }
      if (![OP.HEADER, OP.SCHEMA, OP.CHANNEL, OP.MESSAGE, OP.CHUNK, OP.METADATA, OP.DATA_END].includes(op)) {
        await src.skip(length);
        if (op === OP.ATTACHMENT) stats.attachments_skipped++;
        else if (!KNOWN(op)) r.unknown++;
        continue;
      }
      if (length > limits.max_record_bytes) throw new ScanError(`record length exceeds ${limits.max_record_bytes} byte limit`);
      const buf = await src.read(length);
      const c = new Cursor(buf);
      if (op === OP.HEADER) {
        if (headerSeen) throw new ScanError('repeated Header');
        headerSeen = true;
        r.profile = c.string();
        c.string(); // library
      } else if (op === OP.SCHEMA) reg.schema(c, loc);
      else if (op === OP.CHANNEL) onChannel(c, loc);
      else if (op === OP.MESSAGE) {
        stats.unchunked_messages++;
        onMessage(buf, c.dv, 0, length, offset, -1);
      } else if (op === OP.METADATA) {
        if (!ended) reg.metadata(c, loc);
      } else if (op === OP.DATA_END) {
        if (ended) throw new ScanError('repeated DataEnd');
        ended = true;
        const dataCrc = c.u32();
        if (dataCrc && dataCrc !== crcBefore) throw new ScanError('data section CRC mismatch');
        r.crc.data_section = dataCrc ? 'verified' : 'absent';
        src.crc = 0;
        summaryCrcStart = src.pos;
      } else if (op === OP.CHUNK) {
        if (ended) throw new ScanError('chunk after DataEnd');
        stats.chunks++;
        c.u64();
        c.u64();
        const usizeBig = c.u64();
        const ucrc = c.u32();
        const compression = c.string();
        const n = c.u64n();
        const p = c.take(n);
        if (!SUPPORTED.includes(compression)) throw new ScanError(`unsupported compression: '${compression.slice(0, 40)}'`);
        let inner;
        if (compression === '') {
          if (usizeBig !== BigInt(n)) throw new ScanError('chunk size inconsistent with uncompressed size');
          inner = buf.subarray(p, p + n);
        } else {
          if (usizeBig > BigInt(limits.max_chunk_uncompressed_bytes))
            throw new ScanError(`chunk declares ${usizeBig} uncompressed bytes, above the ${limits.max_chunk_uncompressed_bytes} byte limit`);
          inner = decompress(compression, buf.subarray(p, p + n), Number(usizeBig));
        }
        const name = compression || 'none';
        r.compression[name] = (r.compression[name] || 0) + 1;
        if (ucrc) {
          if (crc32(inner) !== ucrc) throw new ScanError('chunk CRC mismatch');
          r.crc.chunk_present_verified++;
        } else r.crc.chunk_absent++;
        const idv = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
        for (const [ioff, iop, ib, ie] of iterRecords(inner)) {
          countRecord();
          if (iop === OP.MESSAGE) onMessage(inner, idv, ib, ie, offset, ioff);
          else if (iop === OP.CHANNEL) onChannel(new Cursor(inner, ib, ie), { chunk_file_offset: offset, chunk_inner_offset: ioff });
          else if (iop === OP.SCHEMA) reg.schema(new Cursor(inner, ib, ie), { chunk_file_offset: offset, chunk_inner_offset: ioff });
          else if (KNOWN(iop)) throw new ScanError('unsupported record inside chunk');
          else r.unknown++;
        }
      }
    }
    r.sha256 = bytesToHex(src.sha.digest());
    r.stats.seconds = Math.round(performance.now() - started) / 1000;
    return r;
  } catch (e) {
    const err = e instanceof ScanError ? e : new ScanError(`${e && e.name}: ${e && e.message}`);
    const drained = !(e instanceof ScanTimeout) && !(e instanceof RangeError) && (await src.drain());
    r.sha256 = drained || src.loaded === size ? bytesToHex(src.sha.digest()) : null;
    err.result = r;
    throw err;
  }
}

// ----------------------------------------------------------------------------- fast scan

export async function scanFast(blob, limits = DEFAULT_LIMITS) {
  const started = performance.now();
  const size = blob.size;
  const r = newResult('fast', size);
  r.crc = { data_section: 'not checked (fast mode)', chunk_present_verified: 0, chunk_absent: 0, summary: 'no summary section', attachments: 'not checked' };
  const reg = new Registry(r, limits);
  const readAt = async (off, n) => {
    if (off < 0 || n < 0 || off + n > size) throw new ScanError('summary reference outside the file');
    const b = new Uint8Array(await blob.slice(off, off + n).arrayBuffer());
    if (b.length !== n) throw new ScanError('unexpected end of file');
    return b;
  };
  if (size < 8 + 9 + FOOTER_RECORD_SIZE + 8) throw new ScanError('file too small to be MCAP');
  const head = await readAt(0, 17);
  if (!same(head.subarray(0, 8), MAGIC)) throw new ScanError('not an MCAP file (bad magic)');
  if (head[8] !== OP.HEADER) throw new ScanError('first record must be Header');
  const hlen = new Cursor(head, 9).u64n();
  if (hlen > limits.max_record_bytes) throw new ScanError(`record length exceeds ${limits.max_record_bytes} byte limit`);
  const hc = new Cursor(await readAt(17, hlen));
  r.profile = hc.string();
  hc.string();
  const headerEnd = 17 + hlen;

  const footerAt = size - 8 - FOOTER_RECORD_SIZE;
  const tail = await readAt(footerAt, FOOTER_RECORD_SIZE + 8);
  if (!same(tail.subarray(-8), MAGIC)) throw new ScanError('missing trailing magic');
  const tc = new Cursor(tail, 1);
  if (tail[0] !== OP.FOOTER || tc.u64() !== 20n) {
    r.fastFallback = 'footer is not at the standard position';
    return r;
  }
  const summaryStart = tc.u64n();
  tc.u64();
  const summaryCrc = tc.u32();
  if (summaryStart === 0) {
    r.fastFallback = 'file has no summary section';
    return r;
  }
  if (!(headerEnd <= summaryStart && summaryStart <= footerAt)) throw new ScanError('summary_start outside the file');
  if (footerAt - summaryStart > limits.max_summary_bytes) throw new ScanError(`summary section exceeds ${limits.max_summary_bytes} byte limit`);
  const buf = await readAt(summaryStart, footerAt - summaryStart);
  if (summaryCrc) {
    if (crc32(tail.subarray(0, 25), crc32(buf)) !== summaryCrc) throw new ScanError('summary CRC mismatch');
    r.crc.summary = 'verified';
  } else r.crc.summary = 'absent';

  let statistics = null;
  const metadataIndex = [];
  for (const [off, op, b, e] of iterRecords(buf)) {
    const loc = { file_offset: summaryStart + off };
    const c = new Cursor(buf, b, e);
    if (op === OP.SCHEMA) reg.schema(c, loc);
    else if (op === OP.CHANNEL) reg.channel(c, loc);
    else if (op === OP.STATISTICS) {
      statistics = { message_count: c.u64n(), schema_count: c.u16(), channel_count: c.u32(), attachment_count: c.u32(),
        metadata_count: c.u32(), chunk_count: c.u32(), message_start_time: c.u64(), message_end_time: c.u64(),
        channel_message_counts: c.u16u64Map() };
    } else if (op === OP.METADATA_INDEX) metadataIndex.push([c.u64n(), c.u64n()]);
    else if (op === OP.CHUNK_INDEX) {
      c.take(32);
      c.take(c.u32());
      c.u64();
      const name = c.string() || 'none';
      r.compression[name] = (r.compression[name] || 0) + 1;
    } else if (op === OP.ATTACHMENT_INDEX || op === OP.SUMMARY_OFFSET) {
      /* not needed */
    } else if (KNOWN(op)) throw new ScanError('unexpected record type in summary section');
    else r.unknown++;
  }
  if (!statistics) return (r.fastFallback = 'summary has no Statistics record'), r;
  if (r.channels.size < statistics.channel_count) return (r.fastFallback = 'summary does not repeat every channel'), r;
  if (metadataIndex.length < statistics.metadata_count) return (r.fastFallback = 'summary does not index every metadata record'), r;

  for (const [offset, length] of metadataIndex) {
    if (!(length >= 9 && length <= limits.max_record_bytes)) throw new ScanError('metadata index length invalid or above limit');
    const rec = await readAt(offset, length);
    const rc = new Cursor(rec, 1);
    if (rec[0] !== OP.METADATA || rc.u64() !== BigInt(length - 9)) throw new ScanError('metadata index does not point to a Metadata record');
    reg.metadata(new Cursor(rec, 9), { file_offset: offset });
  }
  r.counts = new Map([...r.channels.keys()].map((cid) => [cid, statistics.channel_message_counts.get(cid) || 0]));
  r.stats = { records: null, messages: statistics.message_count, chunks: statistics.chunk_count,
    attachments_skipped: statistics.attachment_count, seconds: Math.round(performance.now() - started) / 1000 };
  return r;
}
