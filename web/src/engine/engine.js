// Contract checks over MCAP records: a port of src/tracecheck/engine.py.
// Produces the same report structure (report_version 2) as the Python CLI.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { META_LIMIT, META_NAME, plan as bagPlan } from './bag.js';
import { num, validate } from './contract.js';
import { EVENT_LIMIT, covered, explainer, windows } from './events.js';
import { PyFloat, dumps } from './json.js';
import { BagContext, DEFAULT_LIMITS, META_PAIRS_LIMIT, META_VALUE_LIMIT, ScanTruncated, TEXT_LIMIT, scanFast, scanFull } from './reader.js';

export const VERSION = '0.2.0';
export const REPORT_VERSION = 2;
export const NAMES = [
  'Readable bounded MCAP scan',
  'Required topics contain messages',
  'Profile, schema and encoding',
  'Required file metadata',
  'Message counts',
  'Average recorded rate',
  'Sorted timestamp gaps',
  'Record-order timestamp regressions',
  'Sequence continuity',
  'Expected interval coverage',
];
const BAG_NAME = 'ROS 2 bag metadata agreement'; // C11, only in reports for a bag folder
const FULL_SCAN_ONLY = 'Fast mode reads only the summary section; this check needs a full scan.';
const INCOMPLETE = 'Scan incomplete; no completeness or timing conclusion.';
const TRUNCATED_SKIP = 'Recording is incomplete, so this check was not evaluated on the partial data. See the recovered summary.';
const BAG_MISSING_SKIP = 'A file listed in metadata.yaml is not in the folder, so this check was not evaluated on the partial recording. See C11.';
const GAP_DETAIL = 'Adjacent sorted timestamps; only interior gaps. Equal-to-threshold passes.';
const RATE_DETAIL = '(N-1) / (max timestamp - min timestamp), in seconds; not instantaneous rate.';
const RATE_EVENTS_DETAIL = RATE_DETAIL + ' Judged on active_hz: time covered by recorder pause or unsubscribe events written ' +
  'in the recording (excluded_ns) is left out; the events are not verified. observed_hz includes that time.';
const GAP_EVENTS_DETAIL = GAP_DETAIL + ' Gaps covered by a recorder pause or unsubscribe event written in the recording ' +
  'are listed as explained and do not fail; the events are not verified.';
const GAP_EVENTS_UNUSED = GAP_DETAIL + ' Recorder events in this recording were not used: they are matched on log_time only.';
const GAP_EVENTS_LIMIT = GAP_DETAIL + ` Recorder events in this recording were not used: more than ${EVENT_LIMIT} pause or subscription events.`;
const PROVENANCE_EVENTS = 'Local read-only scan in this browser; the file never left this device. User-supplied contract; no execution. ' +
  'Payloads are not decoded, except recognised recorder event messages (action and topic name only).';
const FULL_DETAIL = 'Bounded scan completed. Data-section, chunk and summary CRCs checked when present; attachment CRCs unchecked. ' +
  'Missing CRC warns only when some message data had no CRC coverage. This is not full MCAP conformance validation.';
const FAST_DETAIL = 'Fast mode: header, footer and summary section read and summary CRC checked when present. The data section was ' +
  'not scanned, so message-level corruption is not detected.';
const BAG_BY_NAME = 'The .mcap files in the folder were checked in name order; message counts could not be compared.';
const BAG_NO_META = 'No metadata.yaml in the folder. rosbag2 writes it when a recording is closed, so a recorder that ' +
  'stopped unexpectedly may leave none; it can also be left out when copying. ' + BAG_BY_NAME;
const COUNT_OK = 'Message count matches metadata.yaml.';
const COUNT_BAD = 'Message count differs from metadata.yaml. Compare this copy with the original recording; the folder ' +
  'alone cannot show which is right.';
const PRIORITY = { skipped: 0, pass: 1, warn: 2, fail: 3 };
const get = (m, k, d) => (m.has(k) ? m.get(k) : d);
const pySlice = (s, n) => (s.length <= n ? s : [...s].slice(0, n).join(''));

function limitsReport(limits) {
  return { ...limits, text_field_characters: TEXT_LIMIT, metadata_value_characters: META_VALUE_LIMIT,
    metadata_pairs_per_record: META_PAIRS_LIMIT, compression: 'none, zstd, lz4; output capped at declared uncompressed size' };
}

function makePlan(c) {
  const topics = c.get('topics');
  return (topic) => {
    const t = topics.get(topic);
    if (t === undefined) return null;
    return {
      basisLog: get(t, 'time_basis', 'log_time') === 'log_time',
      sequence: t.get('sequence') === 'increment_mod32',
      maxGap: t.get('clock_confirmed') === true && t.has('max_gap_ns') ? t.get('max_gap_ns') : null,
    };
  };
}

const loc = (a, b, f = null) => {
  const l = b < 0 ? { file_offset: a } : { chunk_file_offset: a, chunk_inner_offset: b };
  return f === null || f === undefined ? l : { file: f, ...l };
};
const msg = (cid, m) => ({ ...loc(m[1], m[2], m[6]), message_ordinal: m[0], channel_id: cid, log_time: m[3], publish_time: m[4], sequence: m[5] });

/** Validate the contract and create the report skeleton and its `finding` helper. */
function start(contract, name, size, fast, limits) {
  const c = validate(contract);
  const canonical = dumps(c, { sortKeys: true, separators: [',', ':'], ensureAscii: false });
  const evLimit = limits.evidence_per_finding;
  const result = {
    report_version: REPORT_VERSION,
    tool: { name: 'Backplane Tracecheck', version: VERSION, implementation: 'browser' },
    generated_utc: new Date().toISOString(),
    source: { name, bytes: size, sha256: null },
    scan_mode: fast ? 'fast' : 'full',
    contract: c,
    contract_sha256: bytesToHex(sha256(new TextEncoder().encode(canonical))),
    limits: limitsReport(limits),
    provenance: 'Local read-only scan in this browser; the file never left this device. User-supplied contract; no payload decoding or execution.',
    interpretation: 'Contract observations only. No safety certification, regulatory compliance, causality, or original-recording truthfulness is established. Clock differences are not transport latency.',
    checks: NAMES.map((n, i) => ({ id: `C${String(i + 1).padStart(2, '0')}`, name: n, status: 'skipped', findings: [] })),
  };
  const finding = (i, status, detail, evidence = null, extra = {}, total = null) => {
    const row = { status, detail, ...extra };
    if (evidence !== null) {
      const count = total === null ? evidence.length : total;
      row.evidence_count = count;
      row.evidence = evidence.slice(0, evLimit);
      row.evidence_omitted = Math.max(0, count - row.evidence.length);
    }
    result.checks[i - 1].findings.push(row);
  };
  return [c, result, finding];
}

/** True when some message data had no CRC coverage (full), or the summary has no CRC (fast). */
function crcMissing(r) {
  const crc = r.crc;
  if (r.mode === 'full') return crc.data_section === 'absent' && (crc.chunk_absent > 0 || r.stats.unchunked_messages > 0);
  return crc.summary === 'absent';
}

/** Record a completed scan and its C01 finding. */
function scanned(result, r, missing, ignoreCrc, finding, extra = {}) {
  Object.assign(result, { scan_complete: true, mcap_profile: r.profile, checksum_coverage: r.crc, compression: r.compression,
    scan_stats: { ...r.stats, seconds: new PyFloat(r.stats.seconds) } });
  if (r.recorderEvents) {
    result.recorder_events = r.recorderEvents;
    result.provenance = PROVENANCE_EVENTS;
  }
  const status = r.unknown || (missing && !ignoreCrc) ? 'warn' : 'pass';
  const policy = ignoreCrc ? 'ignore' : 'warn';
  if (r.mode === 'full') {
    finding(1, status, FULL_DETAIL, null, { unknown_records_skipped: r.unknown, missing_crc_policy: policy, crc_coverage_complete: !missing, ...extra });
  } else finding(1, status, FAST_DETAIL, null, { unknown_records_skipped: r.unknown, missing_crc_policy: policy, ...extra });
}

/**
 * Check a Blob/File against a validated contract (Map from contract.loads).
 * @param {Blob} blob
 * @param {Map} contract
 * @param {{filename?: string, fast?: boolean, limits?: object, progress?: (done:number,total:number)=>void}} opts
 */
export async function analyze(blob, contract, { filename = 'recording.mcap', fast = false, limits = DEFAULT_LIMITS, progress = null } = {}) {
  const [c, result, finding] = start(contract, String(filename).split(/[\\/]/).pop(), blob.size, fast, limits);
  const ignoreCrc = get(c, 'missing_crc', 'warn') === 'ignore';
  let r;
  try {
    r = null;
    if (fast) {
      r = await scanFast(blob, limits);
      if (r.fastFallback) {
        result.scan_mode = 'full';
        result.fast_mode_fallback = r.fastFallback;
        r = null;
      }
    }
    if (r === null) r = await scanFull(blob, makePlan(c), limits, progress);
    result.source.sha256 = r.sha256;
    scanned(result, r, crcMissing(r), ignoreCrc, finding);
  } catch (e) {
    if (e && e.result) result.source.sha256 = e.result.sha256;
    result.scan_complete = false;
    if (e instanceof ScanTruncated && e.result && e.result.mode === 'full') {
      reportTruncated(result, e.result, String(e.message), finding);
      for (let i = 2; i <= 10; i++) finding(i, 'skipped', TRUNCATED_SKIP);
      return finish(result);
    }
    finding(1, 'fail', `${(e && e.name) || 'Error'}: ${String(e && e.message).slice(0, 300)}`);
    for (let i = 2; i <= 10; i++) finding(i, 'skipped', INCOMPLETE);
    return finish(result);
  }
  inventory(result, r);
  evaluate(result, c, r, finding);
  return finish(result);
}

const countOf = (r, cid) => (r.counts ? r.counts.get(cid) || 0 : r.tracks.get(cid)?.count || 0);

function inventory(result, r) {
  const { schemas, channels } = r;
  result.inventory = [...channels].map(([cid, x]) => ({
    channel_id: cid, topic: x.value.topic, message_count: countOf(r, cid), message_encoding: x.value.message_encoding,
    schema_id: x.value.schema_id, schema: schemas.get(x.value.schema_id)?.value ?? null, location: x.location,
  }));
}

/** Checks C02-C10 on a completed scan. `firstFile` names the bag file whose Header is cited. */
function evaluate(result, c, r, finding, firstFile = null) {
  const { schemas, channels, metadata } = r;
  const info = r.recorderEvents || null;
  const wins = info !== null && !info.limit_reached ? windows(r.events) : null;

  if (c.has('profile')) {
    finding(3, r.profile === c.get('profile') ? 'pass' : 'fail', 'MCAP Header profile equality', [loc(8, -1, firstFile)],
      { expected: c.get('profile'), observed: r.profile });
  }
  for (const [name, fields] of get(c, 'metadata', new Map())) {
    const found = metadata.filter((m) => m.name === name);
    for (const [key, expected] of fields) {
      const matches = found.filter((m) => m.fields.has(key) && (expected !== null ? m.fields.get(key) === expected : m.fields.get(key) !== ''));
      const ok = found.length > 0 && matches.length === found.length;
      finding(4, ok ? 'pass' : 'fail', `Metadata ${name}.${key}: every matching record must satisfy the contract; null means nonempty.`,
        found.map((m) => m.location), { expected });
    }
  }

  for (const [topic, t] of c.get('topics')) {
    const ids = [...channels].filter(([, ch]) => ch.value.topic === topic).map(([cid]) => cid);
    const active = ids.filter((cid) => countOf(r, cid));
    if (get(t, 'required', true)) {
      finding(2, active.length ? 'pass' : 'fail', 'Required topic needs at least one message.', ids.map((cid) => channels.get(cid).location), { topic });
    }
    if (!ids.length) for (const i of [3, 5, 6, 7, 8, 9, 10]) finding(i, 'skipped', 'Topic absent; see required-topic check.', null, { topic });
    for (const cid of ids) {
      const ch = channels.get(cid).value;
      const ctx = { topic, channel_id: cid };
      const sch = schemas.get(ch.schema_id)?.value || {};
      for (const [key, actual] of [['message_encoding', ch.message_encoding], ['schema_name', sch.name ?? null],
        ['schema_encoding', sch.encoding ?? null], ['schema_sha256', sch.sha256 ?? null]]) {
        if (t.has(key)) {
          finding(3, actual === t.get(key) ? 'pass' : 'fail', key + ' equality (schema payload not validated)',
            [channels.get(cid).location], { expected: t.get(key), observed: actual, ...ctx });
        }
      }
      const n = countOf(r, cid);
      const tr = r.tracks.get(cid);
      if (t.has('min_count') || t.has('max_count')) {
        const ok = get(t, 'min_count', 0n) <= n && n <= get(t, 'max_count', Infinity);
        const ev = tr ? (n ? [msg(cid, tr.first), msg(cid, tr.last)] : []) : [channels.get(cid).location];
        finding(5, ok ? 'pass' : 'fail', 'Per-channel message count', ev,
          { observed: n, minimum: get(t, 'min_count', null), maximum: get(t, 'max_count', null), ...ctx });
      }
      if (!tr) {
        for (const i of [6, 7, 8, 9, 10]) finding(i, 'skipped', FULL_SCAN_ONLY, null, ctx);
        continue;
      }
      if (t.get('sequence') === 'increment_mod32' && n >= 2) {
        finding(9, tr.seqBadN ? 'fail' : 'pass',
          'Physical-order unit increment modulo 2^32; one sequence source per channel is a contract assumption.',
          tr.seqBad.map(([a, b]) => ({ previous: msg(cid, a), current: msg(cid, b) })), ctx, tr.seqBadN);
      } else finding(9, 'skipped', 'Sequence disabled or fewer than two messages.', null, ctx);
      const basis = get(t, 'time_basis', 'log_time');
      const k = basis === 'log_time' ? 3 : 4;
      if (t.get('clock_confirmed') !== true || !n) {
        for (const i of [6, 7, 8, 10]) finding(i, 'skipped', 'Needs clock_confirmed=true and messages; clock domain/epoch must be known by the user.', null, ctx);
        continue;
      }
      const { lo, hi } = tr;
      if ((t.has('min_rate_hz') || t.has('max_rate_hz')) && n >= 2 && hi[k] > lo[k]) {
        const rate = ((n - 1) * 1e9) / Number(hi[k] - lo[k]);
        const [gone, why] = wins !== null && basis === 'log_time' ? covered(wins, topic, lo[k], hi[k]) : [0n, []];
        let judged = rate;
        let extra = {};
        if (gone > 0n && hi[k] - lo[k] > gone) {
          judged = ((n - 1) * 1e9) / Number(hi[k] - lo[k] - gone);
          extra = { active_hz: new PyFloat(judged), excluded_ns: gone, excluded_by: why };
        }
        const ok = num(get(t, 'min_rate_hz', 0n)) <= judged && judged <= num(get(t, 'max_rate_hz', Infinity));
        finding(6, ok ? 'pass' : 'fail', 'active_hz' in extra ? RATE_EVENTS_DETAIL : RATE_DETAIL,
          [msg(cid, lo), msg(cid, hi)], { observed_hz: new PyFloat(rate), time_basis: basis, ...ctx, ...extra });
      } else finding(6, 'skipped', 'Rate bounds absent, fewer than two messages, or zero timestamp span.', null, ctx);
      if (t.has('max_gap_ns') && n >= 2) {
        const explain = wins !== null && basis === 'log_time' ? explainer(wins, topic, t.get('max_gap_ns')) : null;
        const [sample, total, xs, xtotal] = tr.sortedGaps(explain);
        const point = (o, a, b, time, f) => ({ ...loc(a, b, f), message_ordinal: o, channel_id: cid, [basis]: time });
        const at = (i) => point(tr.ords.get(i), tr.locA.get(i), tr.locB.get(i), tr.times.get(i), tr.files ? tr.files[i] : null);
        const bad = sample.map(([a, b, g]) =>
          tr.monotonic && explain === null
            ? { previous: point(a[0], a[1], a[2], a[k], a[6]), current: point(b[0], b[1], b[2], b[k], b[6]), gap_ns: g }
            : { previous: at(a), current: at(b), gap_ns: g });
        const status = total ? 'fail' : 'pass';
        if (info === null) finding(7, status, GAP_DETAIL, bad, { time_basis: basis, ...ctx }, total);
        else if (wins === null || basis !== 'log_time')
          finding(7, status, wins === null ? GAP_EVENTS_LIMIT : GAP_EVENTS_UNUSED, bad, { time_basis: basis, ...ctx }, total);
        else {
          const explained = xs.map(([a, b, g, why]) => ({ previous: at(a), current: at(b), gap_ns: g, explained_by: why }));
          finding(7, status, GAP_EVENTS_DETAIL, bad, { time_basis: basis, ...ctx, explained_gap_count: xtotal, explained_gaps: explained }, total);
        }
      } else finding(7, 'skipped', 'Gap threshold absent or fewer than two messages.', null, ctx);
      if (t.get('check_regression') === true && n >= 2) {
        finding(8, tr.regBadN ? 'fail' : 'pass', 'Strictly decreasing timestamps in physical record order; equal values allowed.',
          tr.regBad.map(([a, b]) => ({ previous: msg(cid, a), current: msg(cid, b) })), { time_basis: basis, ...ctx }, tr.regBadN);
      } else finding(8, 'skipped', 'Regression check disabled or fewer than two messages.', null, ctx);
      if (t.has('interval_ns')) {
        const [start, end] = t.get('interval_ns');
        const tol = get(t, 'boundary_tolerance_ns', 0n);
        const first = lo[k];
        const last = hi[k];
        const ok = start <= first && first <= start + tol && end - tol <= last && last <= end;
        finding(10, ok ? 'pass' : 'fail',
          'All timestamps inside inclusive expected interval, with first/last within endpoint tolerance; interior continuity is C07.',
          [msg(cid, lo), msg(cid, hi)], { expected_interval_ns: [start, end], boundary_tolerance_ns: tol, time_basis: basis, ...ctx });
      } else finding(10, 'skipped', 'No expected interval configured.', null, ctx);
    }
  }
}

/** Describe a file that ends before its MCAP structure is complete. Mirrors _report_truncated in engine.py. */
function reportTruncated(result, r, reason, finding) {
  const range = r.logTimeRange;
  const messages = r.stats.messages || 0;
  result.recovered = {
    complete_bytes: r.completeBytes,
    file_bytes: r.size,
    data_section_complete: r.dataEndSeen,
    messages,
    log_time_first: range ? range[0] : null,
    log_time_last: range ? range[1] : null,
    log_time_span_ns: range ? range[1] - range[0] : null,
    topics: [...r.channels].map(([cid, ch]) => ({ channel_id: cid, topic: ch.value.topic, message_count: r.tracks.get(cid)?.count || 0 })),
  };
  const where = r.dataEndSeen
    ? 'All message data was read; the file ends in its summary or footer.'
    : 'The file ends inside its message data, so later messages, if any, are missing.';
  finding(1, 'fail',
    `Recording is incomplete: the file ends before its MCAP footer (${reason.slice(0, 120)}). ${where} ` +
      `${messages} complete messages were readable in the first ${r.completeBytes} of ${r.size} bytes. ` +
      'A recording that stopped unexpectedly, or a file cut off while copying, looks like this; the file alone cannot show which.',
    null, { truncated: true });
}

// ----------------------------------------------------------------------------- ROS 2 bag folders

/**
 * Check the files of one ROS 2 bag folder as one recording. Mirrors analyze_bag_files in engine.py.
 * @param {string} folder folder name shown in the report
 * @param {Map<string, Blob>} files plain file name -> Blob (only the folder's own files)
 * @param {Map} contract
 */
export async function analyzeBag(folder, files, contract, { fast = false, limits = DEFAULT_LIMITS, progress = null } = {}) {
  let metaText = null;
  let metaSha = null;
  let metaError = null;
  if (files.has(META_NAME)) {
    const blob = files.get(META_NAME);
    if (blob.size > META_LIMIT) metaError = `larger than ${META_LIMIT >> 20} MiB`;
    else {
      const data = new Uint8Array(await blob.slice(0, META_LIMIT + 1).arrayBuffer());
      metaSha = bytesToHex(sha256(data));
      try {
        metaText = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        metaError = 'not UTF-8 text';
      }
    }
  }
  const bag = bagPlan(folder, [...files.keys()], metaText, metaSha, metaError);
  const todo = bag.files.filter((f) => f.present && f.listed !== false);
  for (const f of bag.files) {
    const scan = !f.present ? 'missing' : f.listed === false ? 'not listed' : 'not scanned';
    Object.assign(f, { bytes: f.present ? files.get(f.name).size : null, sha256: null, scan, messages: null });
  }
  const total = todo.reduce((a, f) => a + f.bytes, 0);
  const [c, result, finding] = start(contract, folder, total, fast, limits);
  result.checks.push({ id: 'C11', name: BAG_NAME, status: 'skipped', findings: [] });
  const ignoreCrc = get(c, 'missing_crc', 'warn') === 'ignore';
  const ctx = new BagContext(todo.map((f) => f.name), limits);
  let results = [];
  let current = null;
  let merged;
  try {
    if (fast) {
      const got = [];
      let fellBack = false;
      for (const f of todo) {
        current = f;
        const r = await scanFast(files.get(f.name), limits);
        if (r.fastFallback) {
          result.scan_mode = 'full';
          result.fast_mode_fallback = `${f.name}: ${r.fastFallback}`;
          fellBack = true;
          break;
        }
        got.push(r);
      }
      if (!fellBack) {
        results = got;
        todo.forEach((f, i) => Object.assign(f, { scan: 'summary only', messages: results[i].stats.messages }));
      }
    }
    if (!results.length) {
      const planFn = makePlan(c);
      let offset = 0;
      for (let i = 0; i < todo.length; i++) {
        const f = todo[i];
        current = f;
        ctx.startFile(i);
        const o = offset;
        const prog = progress ? (d) => progress(o + d, total) : null;
        const r = await scanFull(files.get(f.name), planFn, limits, prog, ctx);
        Object.assign(f, { sha256: r.sha256, scan: 'complete', messages: r.stats.messages });
        results.push(r);
        offset += f.bytes;
      }
    }
    current = null;
    merged = merge(results, ctx);
  } catch (e) {
    const partial = (e && e.result) || null;
    result.scan_complete = false;
    const truncated = e instanceof ScanTruncated && partial !== null && partial.mode === 'full';
    if (current !== null) {
      current.scan = truncated ? 'incomplete' : 'error';
      if (partial !== null) Object.assign(current, { sha256: partial.sha256, messages: partial.stats.messages ?? null });
    }
    if (truncated) reportTruncatedBag(result, ctx, results, partial, current, todo.length, String(e.message), finding);
    else {
      const where = current !== null ? current.name : folder;
      finding(1, 'fail', `${where}: ${(e && e.name) || 'Error'}: ${String(e && e.message).slice(0, 300)}`, null, { file: where });
    }
    for (let i = 2; i <= 10; i++) finding(i, 'skipped', truncated ? TRUNCATED_SKIP : INCOMPLETE);
    bagCheck(bag, null, finding);
    result.bag = bag;
    return finish(result);
  }
  scanned(result, merged, results.some(crcMissing), ignoreCrc, finding, { files_scanned: results.length });
  inventory(result, merged);
  if (bag.files.some((f) => f.scan === 'missing')) {
    result.scan_complete = false;
    for (let i = 2; i <= 10; i++) finding(i, 'skipped', BAG_MISSING_SKIP);
  } else evaluate(result, c, merged, finding, todo[0].name);
  bagCheck(bag, merged, finding);
  result.bag = bag;
  return finish(result);
}

/** Combine per-file scan results into one, using the logical channels in `ctx`. Mirrors _merge. */
function merge(results, ctx) {
  const first = results[0];
  const m = { mode: first.mode, size: results.reduce((a, x) => a + x.size, 0), sha256: null, metadata: [], counts: null,
    crc: {}, compression: {}, unknown: 0, stats: {}, recorderEvents: null, events: [] };
  m.profile = results.every((x) => x.profile === first.profile) ? first.profile : null;
  for (const [k, v] of Object.entries(first.crc)) {
    const vals = results.map((x) => x.crc[k]);
    m.crc[k] = vals.every((x) => typeof x === 'number') ? vals.reduce((a, x) => a + x, 0) : vals.every((x) => x === v) ? v : 'mixed';
  }
  for (const x of results) for (const [k, v] of Object.entries(x.compression)) m.compression[k] = (m.compression[k] || 0) + v;
  m.unknown = results.reduce((a, x) => a + x.unknown, 0);
  for (const k of Object.keys(first.stats)) {
    const vals = results.map((x) => (k in x.stats ? x.stats[k] : null));
    if (vals.some((v) => v === null)) m.stats[k] = null;
    else {
      const sum = vals.reduce((a, v) => a + v, 0);
      m.stats[k] = k === 'seconds' ? Math.round(sum * 1000) / 1000 : sum;
    }
  }
  results.forEach((x, i) => {
    for (const md of x.metadata) m.metadata.push({ ...md, location: { file: ctx.names[i], ...md.location } });
  });
  if (first.mode === 'fast') {
    const counts = new Map();
    results.forEach((x, i) => {
      ctx.startFile(i);
      for (const cid of x.channels.keys()) {
        const lid = ctx.channel(cid, x);
        counts.set(lid, (counts.get(lid) || 0) + (x.counts.get(cid) || 0));
      }
    });
    m.counts = counts;
  }
  m.schemas = ctx.schemas;
  m.channels = ctx.channels;
  m.tracks = ctx.tracks;
  const infos = results.map((x) => x.recorderEvents).filter((x) => x);
  if (infos.length) {
    const events = results.flatMap((x) => x.events);
    const kinds = {};
    for (const info of infos) for (const [k, v] of Object.entries(info.message_counts)) kinds[k] = (kinds[k] || 0) + v;
    const limit = infos.some((info) => info.limit_reached) || events.length > EVENT_LIMIT;
    m.events = events.slice(0, EVENT_LIMIT);
    m.recorderEvents = { recorder: infos[0].recorder, message_counts: kinds, decoded: m.events.length,
      undecodable: infos.reduce((a, info) => a + info.undecodable, 0), limit_reached: limit, note: infos[0].note };
  }
  return m;
}

/** Like reportTruncated, for a bag whose file `f` is cut off. Mirrors _report_truncated_bag. */
function reportTruncatedBag(result, ctx, results, r, f, nFiles, reason, finding) {
  const ranges = [...results, r].map((x) => x.logTimeRange).filter((x) => x);
  const lo = ranges.length ? ranges.reduce((a, x) => (x[0] < a ? x[0] : a), ranges[0][0]) : null;
  const hi = ranges.length ? ranges.reduce((a, x) => (x[1] > a ? x[1] : a), ranges[0][1]) : null;
  const messages = ctx.base + (r.stats.messages || 0);
  const complete = results.reduce((a, x) => a + x.size, 0) + r.completeBytes;
  const total = result.source.bytes;
  result.recovered = {
    incomplete_file: f.name,
    complete_bytes: complete,
    file_bytes: total,
    data_section_complete: r.dataEndSeen,
    messages,
    log_time_first: lo,
    log_time_last: hi,
    log_time_span_ns: ranges.length ? hi - lo : null,
    topics: [...ctx.channels].map(([lid, ch]) => ({ channel_id: lid, topic: ch.value.topic, message_count: ctx.tracks.get(lid)?.count || 0 })),
  };
  const where = r.dataEndSeen
    ? 'All message data in that file was read; it ends in its summary or footer.'
    : 'It ends inside its message data, so later messages, if any, are missing.';
  const later = nFiles - results.length - 1;
  const after = later ? ` ${later} later file(s) in the bag were not scanned.` : '';
  finding(1, 'fail',
    `Recording is incomplete: ${f.name} ends before its MCAP footer (${pySlice(reason, 120)}). ${where} ` +
      `${messages} complete messages were readable in the first ${complete} of ${total} bytes of the bag.${after} ` +
      'A recording that stopped unexpectedly, or a file cut off while copying, looks like this; the files alone cannot show which.',
    null, { truncated: true, file: f.name });
}

/** C11: compare the folder and the scan with metadata.yaml. `r` is null when the scan is incomplete. */
function bagCheck(bag, r, finding) {
  const meta = bag.metadata;
  const files = bag.files;
  if (meta === 'present') {
    finding(11, 'pass', 'metadata.yaml was read.', null, { metadata: 'present', ros_distro: bag.ros_distro, files_listed: files.filter((f) => f.listed).length });
  } else if (meta === 'absent') finding(11, 'warn', BAG_NO_META, null, { metadata: 'absent' });
  else finding(11, 'warn', `metadata.yaml could not be read (${bag.metadata_error}). ${BAG_BY_NAME}`, null, { metadata: 'unreadable' });
  for (const f of files) {
    if (f.scan === 'missing') finding(11, 'fail', 'This file is listed in metadata.yaml but is not in the folder, so the recording is incomplete.', null, { file: f.name });
    else if (f.scan === 'not listed') finding(11, 'warn', 'This .mcap file is in the folder but not listed in metadata.yaml, so it was not checked.', null, { file: f.name });
  }
  if (meta !== 'present') return;
  if (r === null) {
    finding(11, 'skipped', 'Scan incomplete; message counts were not compared with metadata.yaml.');
    return;
  }
  const compare = (claimed, observed, where) => {
    const ok = BigInt(claimed) === BigInt(observed);
    finding(11, ok ? 'pass' : 'fail', ok ? COUNT_OK : COUNT_BAD, null, { ...where, claimed, observed });
  };
  for (const f of files) if (f.messages !== null && f.messages_claimed !== null) compare(f.messages_claimed, f.messages, { file: f.name });
  if (files.some((f) => f.scan === 'missing')) {
    finding(11, 'skipped', 'A listed file is missing, so topic and total message counts were not compared.');
    return;
  }
  const observed = new Map();
  for (const [cid, ch] of r.channels) observed.set(ch.value.topic, (observed.get(ch.value.topic) || 0) + countOf(r, cid));
  const listed = new Set();
  for (const t of bag.topics_claimed) {
    listed.add(t.name);
    if (t.message_count !== null) compare(t.message_count, observed.get(t.name) || 0, { topic: t.name });
  }
  for (const [topic, n] of observed) if (n && !listed.has(topic)) finding(11, 'warn', 'This topic has messages but is not listed in metadata.yaml.', null, { topic, observed: n });
  if (bag.message_count_claimed !== null) compare(bag.message_count_claimed, r.stats.messages, { scope: 'bag' });
}

export function finish(result) {
  for (const check of result.checks) {
    if (!check.findings.length) check.findings = [{ status: 'skipped', detail: 'No applicable requirement configured.' }];
    check.status = check.findings.reduce((a, f) => (PRIORITY[f.status] > PRIORITY[a] ? f.status : a), 'skipped');
  }
  result.overall = result.checks.reduce((a, x) => (PRIORITY[x.status] > PRIORITY[a] ? x.status : a), 'skipped');
  result.status_counts = Object.fromEntries(Object.keys(PRIORITY).map((s) => [s, result.checks.filter((x) => x.status === s).length]));
  return result;
}

/** Report as pretty JSON text, exactly like the Python CLI's report.json formatting. */
export const reportJson = (r) => dumps(r, { indent: 2, ensureAscii: false });
