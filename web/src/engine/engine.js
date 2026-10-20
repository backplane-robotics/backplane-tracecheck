// Contract checks over MCAP records: a port of src/tracecheck/engine.py.
// Produces the same report structure (report_version 2) as the Python CLI.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { num, validate } from './contract.js';
import { PyFloat, dumps } from './json.js';
import { DEFAULT_LIMITS, META_PAIRS_LIMIT, META_VALUE_LIMIT, ScanTruncated, TEXT_LIMIT, scanFast, scanFull } from './reader.js';

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
const FULL_SCAN_ONLY = 'Fast mode reads only the summary section; this check needs a full scan.';
const INCOMPLETE = 'Scan incomplete; no completeness or timing conclusion.';
const TRUNCATED_SKIP = 'Recording is incomplete, so this check was not evaluated on the partial data. See the recovered summary.';
const PRIORITY = { skipped: 0, pass: 1, warn: 2, fail: 3 };
const get = (m, k, d) => (m.has(k) ? m.get(k) : d);

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

const loc = (a, b) => (b < 0 ? { file_offset: a } : { chunk_file_offset: a, chunk_inner_offset: b });
const msg = (cid, m) => ({ ...loc(m[1], m[2]), message_ordinal: m[0], channel_id: cid, log_time: m[3], publish_time: m[4], sequence: m[5] });

/**
 * Check a Blob/File against a validated contract (Map from contract.loads).
 * @param {Blob} blob
 * @param {Map} contract
 * @param {{filename?: string, fast?: boolean, limits?: object, progress?: (done:number,total:number)=>void}} opts
 */
export async function analyze(blob, contract, { filename = 'recording.mcap', fast = false, limits = DEFAULT_LIMITS, progress = null } = {}) {
  const c = validate(contract);
  const canonical = dumps(c, { sortKeys: true, separators: [',', ':'], ensureAscii: false });
  const evLimit = limits.evidence_per_finding;
  const result = {
    report_version: REPORT_VERSION,
    tool: { name: 'Backplane Tracecheck', version: VERSION, implementation: 'browser' },
    generated_utc: new Date().toISOString(),
    source: { name: String(filename).split(/[\\/]/).pop(), bytes: blob.size, sha256: null },
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
    const crc = r.crc;
    Object.assign(result, { scan_complete: true, mcap_profile: r.profile, checksum_coverage: crc, compression: r.compression,
      scan_stats: { ...r.stats, seconds: new PyFloat(r.stats.seconds) } });
    const policy = ignoreCrc ? 'ignore' : 'warn';
    if (r.mode === 'full') {
      const missing = crc.data_section === 'absent' && (crc.chunk_absent > 0 || r.stats.unchunked_messages > 0);
      finding(1, r.unknown || (missing && !ignoreCrc) ? 'warn' : 'pass',
        'Bounded scan completed. Data-section, chunk and summary CRCs checked when present; attachment CRCs unchecked. ' +
          'Missing CRC warns only when some message data had no CRC coverage. This is not full MCAP conformance validation.',
        null, { unknown_records_skipped: r.unknown, missing_crc_policy: policy, crc_coverage_complete: !missing });
    } else {
      const missing = crc.summary === 'absent';
      finding(1, r.unknown || (missing && !ignoreCrc) ? 'warn' : 'pass',
        'Fast mode: header, footer and summary section read and summary CRC checked when present. The data section was ' +
          'not scanned, so message-level corruption is not detected.',
        null, { unknown_records_skipped: r.unknown, missing_crc_policy: policy });
    }
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

  const { schemas, channels, metadata } = r;
  const countOf = (cid) => (r.counts ? r.counts.get(cid) || 0 : r.tracks.get(cid)?.count || 0);
  result.inventory = [...channels].map(([cid, x]) => ({
    channel_id: cid, topic: x.value.topic, message_count: countOf(cid), message_encoding: x.value.message_encoding,
    schema_id: x.value.schema_id, schema: schemas.get(x.value.schema_id)?.value ?? null, location: x.location,
  }));

  if (c.has('profile')) {
    finding(3, r.profile === c.get('profile') ? 'pass' : 'fail', 'MCAP Header profile equality', [{ file_offset: 8 }],
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
    const active = ids.filter((cid) => countOf(cid));
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
      const n = countOf(cid);
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
        const ok = num(get(t, 'min_rate_hz', 0n)) <= rate && rate <= num(get(t, 'max_rate_hz', Infinity));
        finding(6, ok ? 'pass' : 'fail', '(N-1) / (max timestamp - min timestamp), in seconds; not instantaneous rate.',
          [msg(cid, lo), msg(cid, hi)], { observed_hz: new PyFloat(rate), time_basis: basis, ...ctx });
      } else finding(6, 'skipped', 'Rate bounds absent, fewer than two messages, or zero timestamp span.', null, ctx);
      if (t.has('max_gap_ns') && n >= 2) {
        const [sample, total] = tr.sortedGaps();
        const point = (o, a, b, time) => ({ ...loc(a, b), message_ordinal: o, channel_id: cid, [basis]: time });
        const bad = sample.map(([a, b, g]) =>
          tr.monotonic
            ? { previous: point(a[0], a[1], a[2], a[k]), current: point(b[0], b[1], b[2], b[k]), gap_ns: g }
            : { previous: point(tr.ords.get(a), tr.locA.get(a), tr.locB.get(a), tr.times.get(a)),
                current: point(tr.ords.get(b), tr.locA.get(b), tr.locB.get(b), tr.times.get(b)), gap_ns: g });
        finding(7, total ? 'fail' : 'pass', 'Adjacent sorted timestamps; only interior gaps. Equal-to-threshold passes.', bad,
          { time_basis: basis, ...ctx }, total);
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
  return finish(result);
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
