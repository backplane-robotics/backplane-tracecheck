// Tests for the /api/feedback Worker and the shared feedback schema.
import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, MAX_MESSAGE_CHARS, validateFeedback } from '../src/feedback-schema.js';
import { RETENTION_SECONDS, handleFeedback } from '../worker/feedback.js';
import * as entry from '../worker/index.js';

const worker = entry.default;

it('worker entry point exports only the default handler (workerd rejects other exports)', () => {
  expect(Object.keys(entry)).toEqual(['default']);
});

const URL_ = 'https://backplanerobotics.com/api/feedback';
const good = { type: 'improvement', helped: 'partly', message: 'Please add a units hint.', app_version: '0.2.0' };

function fakeKv({ fail = false } = {}) {
  const puts = [];
  return { puts, async put(key, value, opts) { if (fail) throw new Error('kv down'); puts.push({ key, value, opts }); } };
}
const limiter = (success = true) => ({ calls: 0, async limit() { this.calls++; return { success }; } });

function req(body, { headers = {}, method = 'POST', raw } = {}) {
  const init = {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9', ...headers },
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = raw ?? JSON.stringify(body);
  return new Request(URL_, init);
}
const fixed = { now: () => new Date('2026-10-18T12:00:00.000Z'), makeId: () => 'id-1' };

describe('validateFeedback', () => {
  it('accepts the four documented fields and trims the message', () => {
    expect(validateFeedback({ ...good, message: '  hi  ' })).toEqual({ ok: true, value: { ...good, message: 'hi' } });
  });
  it('treats helped as optional', () => {
    const { helped, ...rest } = good;
    expect(validateFeedback(rest)).toEqual({ ok: true, value: { ...rest, helped: null } });
  });
  it.each([
    [{ ...good, filename: 'run.mcap' }, 'unexpected_field'],
    [{ ...good, type: 'bug' }, 'invalid_type'],
    [{ ...good, helped: 'maybe' }, 'invalid_helped'],
    [{ ...good, message: '   ' }, 'empty_message'],
    [{ ...good, message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }, 'message_too_long'],
    [{ ...good, message: 'bad\u0000byte' }, 'invalid_message'],
    [{ ...good, app_version: '<script>' }, 'invalid_app_version'],
    [[good], 'invalid_body'],
    [null, 'invalid_body'],
  ])('rejects %j', (body, error) => {
    expect(validateFeedback(body)).toEqual({ ok: false, error });
  });
  it('accepts a message of exactly the maximum length', () => {
    expect(validateFeedback({ ...good, message: 'x'.repeat(MAX_MESSAGE_CHARS) }).ok).toBe(true);
  });
});

describe('POST /api/feedback', () => {
  it('stores only the validated fields with a 90-day TTL and returns 201', async () => {
    const kv = fakeKv();
    const res = await handleFeedback(req(good), { FEEDBACK: kv, FEEDBACK_LIMITER: limiter() }, fixed);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe('feedback:2026-10-18T12:00:00.000Z:id-1');
    expect(kv.puts[0].opts).toEqual({ expirationTtl: RETENTION_SECONDS });
    const stored = JSON.parse(kv.puts[0].value);
    expect(stored).toEqual({ received_at: '2026-10-18T12:00:00.000Z', ...good });
    expect(kv.puts[0].value).not.toContain('203.0.113.9');
  });

  it('never reports success when storage fails', async () => {
    const res = await handleFeedback(req(good), { FEEDBACK: fakeKv({ fail: true }) }, fixed);
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it('returns 503 when no storage is bound', async () => {
    const res = await handleFeedback(req(good), {}, fixed);
    expect(res.status).toBe(503);
  });

  it('rejects unexpected fields without storing anything', async () => {
    const kv = fakeKv();
    const res = await handleFeedback(req({ ...good, report: '{}' }), { FEEDBACK: kv }, fixed);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'unexpected_field' });
    expect(kv.puts).toHaveLength(0);
  });

  it('rejects oversized bodies by declared length and by actual length', async () => {
    const kv = fakeKv();
    const big = JSON.stringify({ ...good, message: 'x'.repeat(MAX_BODY_BYTES) });
    const declared = await handleFeedback(req(null, { raw: big, headers: { 'content-length': String(big.length) } }), { FEEDBACK: kv }, fixed);
    expect(declared.status).toBe(413);
    const actual = await handleFeedback(req(null, { raw: big }), { FEEDBACK: kv }, fixed);
    expect(actual.status).toBe(413);
    expect(kv.puts).toHaveLength(0);
  });

  it('rejects invalid JSON and non-JSON content types', async () => {
    const kv = fakeKv();
    expect((await handleFeedback(req(null, { raw: '{nope' }), { FEEDBACK: kv }, fixed)).status).toBe(400);
    expect((await handleFeedback(req(good, { headers: { 'content-type': 'text/plain' } }), { FEEDBACK: kv }, fixed)).status).toBe(415);
    expect(kv.puts).toHaveLength(0);
  });

  it('refuses cross-site requests', async () => {
    const kv = fakeKv();
    const cross = await handleFeedback(req(good, { headers: { 'sec-fetch-site': 'cross-site' } }), { FEEDBACK: kv }, fixed);
    expect(cross.status).toBe(403);
    const foreign = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify(good) });
    expect((await handleFeedback(foreign, { FEEDBACK: kv }, fixed)).status).toBe(403);
    const sameOrigin = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://backplanerobotics.com' }, body: JSON.stringify(good) });
    expect((await handleFeedback(sameOrigin, { FEEDBACK: kv }, fixed)).status).toBe(201);
  });

  it('applies the rate limiter before storing', async () => {
    const kv = fakeKv();
    const res = await handleFeedback(req(good), { FEEDBACK: kv, FEEDBACK_LIMITER: limiter(false) }, fixed);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(kv.puts).toHaveLength(0);
  });

  it('only allows POST', async () => {
    const res = await handleFeedback(req(null, { method: 'GET' }), { FEEDBACK: fakeKv() }, fixed);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('Worker routing', () => {
  it('serves non-API paths from static assets without touching storage', async () => {
    const kv = fakeKv();
    const seen = [];
    const env = { FEEDBACK: kv, ASSETS: { fetch: async (r) => (seen.push(new URL(r.url).pathname), new Response('asset')) } };
    const res = await worker.fetch(new Request('https://backplanerobotics.com/tracecheck/'), env);
    expect(await res.text()).toBe('asset');
    expect(seen).toEqual(['/tracecheck/']);
    expect(kv.puts).toHaveLength(0);
  });
  it('returns 404 for unknown API paths and exposes no listing endpoint', async () => {
    const env = { FEEDBACK: fakeKv(), ASSETS: { fetch: async () => new Response('asset') } };
    expect((await worker.fetch(new Request('https://backplanerobotics.com/api/feedback/list'), env)).status).toBe(404);
  });
});
