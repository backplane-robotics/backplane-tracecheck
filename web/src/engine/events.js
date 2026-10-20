// Recorder event messages that can explain timestamp gaps: a port of src/tracecheck/events.py.
// dynrec (rosbag2_dynamic_recorder) writes PauseEvent and SubscriptionChangeEvent messages into
// the recording. Only their action and topic name are read; every other payload stays opaque.
// The events are the recorder's own account and are not verified.

export const DYNREC_PREFIX = 'rosbag2_dynamic_recorder_interfaces/msg/';
export const EVENT_TYPES = ['PauseEvent', 'SubscriptionChangeEvent', 'FileSplitEvent', 'LowDiskEvent', 'BagSizeLimitEvent', 'MessagesLostEvent'];
export const EVENT_LIMIT = 10000;
const NAME_LIMIT = 1024;
export const NOTE = 'These events were written into the recording by the recorder. Tracecheck reads their type, action, topic ' +
  'name and log time to label gaps; it does not verify them or say why recording was paused.';

const PAUSED = 0;
const RESUMED = 1;
const UNSUBSCRIBED = 1;
const LABEL_PAUSE = 'recorder_paused';
const LABEL_TOPIC = 'topic_unsubscribed';
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Short event type name for a recognised recorder event channel, else null. */
export function eventType(schemaName, messageEncoding) {
  if (messageEncoding !== 'cdr' || !schemaName || !schemaName.startsWith(DYNREC_PREFIX)) return null;
  const short = schemaName.slice(DYNREC_PREFIX.length);
  return EVENT_TYPES.includes(short) ? short : null;
}

/** Minimal plain-CDR reader; alignment is relative to the end of the 4-byte header. */
class Cdr {
  constructor(bytes, le) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
    this.le = le;
  }
  take(n, align = 1) {
    this.p += (align - (this.p % align)) % align;
    if (this.p + n > this.b.length) throw new Error('short CDR payload');
    const p = this.p;
    this.p += n;
    return p;
  }
  u8() {
    return this.b[this.take(1)];
  }
  u32() {
    return this.dv.getUint32(this.take(4, 4), this.le);
  }
  string() {
    const n = this.u32();
    if (n < 1 || n > NAME_LIMIT * 4 + 1) throw new Error('bad CDR string length');
    const p = this.take(n);
    if (this.b[p + n - 1] !== 0) throw new Error('CDR string is not NUL-terminated');
    const s = utf8.decode(this.b.subarray(p, p + n - 1));
    if ([...s].length > NAME_LIMIT) throw new Error('CDR string too long');
    return s;
  }
}

/** Decode a PauseEvent or SubscriptionChangeEvent payload to [kind, action, topic], else null. */
export function decode(kind, payload) {
  if (kind !== 'PauseEvent' && kind !== 'SubscriptionChangeEvent') return null;
  if (payload.length < 4 || payload[0] !== 0 || (payload[1] !== 0 && payload[1] !== 1)) return null;
  const c = new Cdr(payload.subarray(4), payload[1] === 1);
  try {
    c.take(8, 4); // builtin_interfaces/Time stamp
    if (kind === 'PauseEvent') {
      const action = c.u8();
      return action === PAUSED || action === RESUMED ? ['pause', action, null] : null;
    }
    const topic = c.string();
    c.string(); // topic_type
    const action = c.u8();
    return (action === 0 || action === 1) && topic ? ['subscription', action, topic] : null;
  } catch {
    return null;
  }
}

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** [pause windows, Map topic -> windows]; a window is [start, end|null]. Mirrors events.windows. */
export function windows(events) {
  const pause = [];
  const topics = new Map();
  let openPause = null;
  const openTopic = new Map();
  const add = (topic, w) => (topics.has(topic) ? topics.get(topic).push(w) : topics.set(topic, [w]));
  const sorted = [...events].sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]);
  for (const [t, , kind, action, topic] of sorted) {
    if (kind === 'pause') {
      if (action === PAUSED && openPause === null) openPause = t;
      else if (action === RESUMED && openPause !== null) {
        pause.push([openPause, t]);
        openPause = null;
      }
    } else if (action === UNSUBSCRIBED) {
      if (!openTopic.has(topic)) openTopic.set(topic, t);
    } else if (openTopic.has(topic)) {
      add(topic, [openTopic.get(topic), t]);
      openTopic.delete(topic);
    }
  }
  if (openPause !== null) pause.push([openPause, null]);
  for (const [topic, start] of openTopic) add(topic, [start, null]);
  return [pause, topics];
}

/** explain(a, b) -> sorted labels or null, for gaps on `topic`; null when no window applies. */
export function explainer(wins, topic, limit) {
  const [pause, topics] = wins;
  const spans = [...pause.map(([s, e]) => [s, e, LABEL_PAUSE]), ...(topics.get(topic) || []).map(([s, e]) => [s, e, LABEL_TOPIC])];
  if (!spans.length) return null;
  return (a, b) => {
    const clipped = [];
    for (const [s, e, label] of spans) {
      const lo = s > a ? s : a;
      const hi = e === null ? b : e < b ? e : b;
      if (lo < hi) clipped.push([lo, hi, label]);
    }
    if (!clipped.length) return null;
    clipped.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]));
    let cursor = a;
    let widest = 0n;
    const labels = new Set();
    for (const [lo, hi, label] of clipped) {
      if (lo > cursor && lo - cursor > widest) widest = lo - cursor;
      if (hi > cursor) cursor = hi;
      labels.add(label);
    }
    if (b - cursor > widest) widest = b - cursor;
    return widest <= limit ? [...labels].sort() : null;
  };
}

/** [ns of [a, b] inside pause or `topic` unsubscribed windows, sorted labels]. Mirrors events.covered. */
export function covered(wins, topic, a, b) {
  const [pause, topics] = wins;
  const spans = [...pause.map(([s, e]) => [s, e, LABEL_PAUSE]), ...(topics.get(topic) || []).map(([s, e]) => [s, e, LABEL_TOPIC])];
  const clipped = [];
  for (const [s, e, label] of spans) {
    const lo = s > a ? s : a;
    const hi = e === null ? b : e < b ? e : b;
    if (lo < hi) clipped.push([lo, hi, label]);
  }
  clipped.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]));
  let total = 0n;
  let cursor = a;
  const labels = new Set();
  for (const [s, hi, label] of clipped) {
    const lo = s > cursor ? s : cursor;
    if (hi > lo) {
      total += hi - lo;
      cursor = hi;
    }
    labels.add(label);
  }
  return [total, [...labels].sort()];
}
