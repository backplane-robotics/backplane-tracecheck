// POST /api/feedback handler, used by the Worker entry point in ./index.js.
//
// Stores the four documented feedback fields in a private Workers KV namespace. It is entirely separate
// from the Tracecheck scan pipeline: recordings are processed in the browser and never sent here.
//
// Privacy rules for this file:
//  - Never log request bodies, headers or client IP addresses (no console.* calls).
//  - The stored record contains only the validated fields plus a server timestamp.
//  - The client IP is used only as the in-memory rate-limit key and is not stored.

import { MAX_BODY_BYTES, validateFeedback } from '../src/feedback-schema.js';

export const RETENTION_SECONDS = 90 * 24 * 60 * 60;

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function reply(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

/** Read at most `limit` bytes of the body. Returns null if the body is larger. */
async function readLimited(request, limit) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Same-origin browser requests only. Cross-site form posts and scripted requests from other sites are refused. */
function isSameOrigin(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(request.url).origin;
}

export async function handleFeedback(request, env, { now = () => new Date(), makeId = () => crypto.randomUUID() } = {}) {
  if (request.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' }, { allow: 'POST' });
  if (!isSameOrigin(request)) return reply(403, { ok: false, error: 'forbidden' });

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return reply(415, { ok: false, error: 'unsupported_media_type' });

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(413, { ok: false, error: 'payload_too_large' });

  if (env.FEEDBACK_LIMITER) {
    const key = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.FEEDBACK_LIMITER.limit({ key });
    if (!success) return reply(429, { ok: false, error: 'rate_limited' }, { 'retry-after': '60' });
  }

  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) return reply(413, { ok: false, error: 'payload_too_large' });

  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return reply(400, { ok: false, error: 'invalid_json' });
  }

  const result = validateFeedback(body);
  if (!result.ok) return reply(400, { ok: false, error: result.error });

  if (!env.FEEDBACK) return reply(503, { ok: false, error: 'storage_unavailable' });

  const receivedAt = now().toISOString();
  const record = { received_at: receivedAt, ...result.value };
  try {
    await env.FEEDBACK.put(`feedback:${receivedAt}:${makeId()}`, JSON.stringify(record), { expirationTtl: RETENTION_SECONDS });
  } catch {
    return reply(503, { ok: false, error: 'storage_failed' });
  }
  return reply(201, { ok: true });
}
