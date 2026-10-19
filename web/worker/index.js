// Cloudflare Worker entry point for backplanerobotics.com.
//
// Only /api/* reaches this script (see "run_worker_first" in wrangler.jsonc); every other request is
// served directly from static assets. The only endpoint is POST /api/feedback (see ./feedback.js).
// This module must export only the handler object: the Workers runtime rejects other named exports.
import { handleFeedback, reply } from './feedback.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/feedback') return handleFeedback(request, env);
    if (pathname.startsWith('/api/')) return reply(404, { ok: false, error: 'not_found' });
    return env.ASSETS.fetch(request);
  },
};
