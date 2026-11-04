// Cloudflare Worker entry point for backplanerobotics.com.
//
// Only /api/* and the Google Search Console verification file reach this script (see "run_worker_first" in
// wrangler.jsonc); every other request is served directly from static assets. The only endpoint is
// POST /api/feedback (see ./feedback.js).
// This module must export only the handler object: the Workers runtime rejects other named exports.
import { handleFeedback, reply } from './feedback.js';

// Static assets use clean URLs, so /googleXXXX.html would redirect to /googleXXXX. Google's file check does not
// accept a redirect, so serve the same file at its exact .html address.
const GOOGLE_VERIFICATION = /^\/google[0-9a-f]{16}\.html$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === '/api/feedback') return handleFeedback(request, env);
    if (pathname.startsWith('/api/')) return reply(404, { ok: false, error: 'not_found' });
    if (GOOGLE_VERIFICATION.test(pathname)) {
      url.pathname = pathname.slice(0, -'.html'.length);
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  },
};
