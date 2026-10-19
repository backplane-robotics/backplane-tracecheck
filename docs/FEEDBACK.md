# Feedback endpoint

The Tracecheck web app has an optional **Send feedback** dialog. It is separate from recording processing:
recordings are checked in the browser and are never sent to this endpoint.

## What is sent and stored

The browser sends a JSON body with exactly four fields to `POST /api/feedback` on the same origin:

| Field | Values |
|---|---|
| `type` | `did_not_work`, `improvement` or `experience` (required) |
| `helped` | `yes`, `partly`, `no`, `not_sure` or `null` (optional) |
| `message` | Plain text, 1 to 2,000 characters after trimming |
| `app_version` | The visible app version, for example `0.2.0` |

The Worker ([`web/worker/feedback.js`](../web/worker/feedback.js)) validates the body against the shared schema
([`web/src/feedback-schema.js`](../web/src/feedback-schema.js)). It rejects unexpected fields, invalid values,
non-JSON requests, bodies over 16 KiB and cross-site requests. If validation passes, it stores one Workers KV entry:

```json
{ "received_at": "2026-10-18T12:00:00.000Z", "type": "improvement", "helped": "partly", "message": "...", "app_version": "0.2.0" }
```

Key format: `feedback:<received_at>:<random UUID>`. No IP address, user agent, cookie, filename, scan result or
other identifier is stored. The client only shows success after the Worker returns `201 {"ok": true}`, which happens
only after the KV write has completed.

## Privacy controls

- **No application logging.** The Worker has no `console` calls. Workers invocation logs are disabled in
  `wrangler.jsonc` (`observability.logs.invocation_logs: false`).
- **Rate limiting.** 5 submissions per minute per client, using the Cloudflare Workers rate-limiting binding.
  The client IP is the in-memory counter key and is not written to storage.
- **Spam control.** Only same-origin browser requests are accepted (`Sec-Fetch-Site: same-origin`, or a matching
  `Origin`). Together with the rate limit, this is the only spam control. There is no CAPTCHA or third-party script.
- **No public listing.** The Worker exposes no read or list endpoint. Any other `/api/*` path returns 404.
- **Provider logs.** Cloudflare may still keep its own edge and security logs for requests to the site.
  Check the current Cloudflare dashboard settings and policies before making stronger statements.

## Retention

Each entry is written with a KV `expirationTtl` of 90 days, after which Cloudflare deletes it.

> Do not advertise the 90-day period on the website until expiry has been confirmed on the production namespace.
> For example, write a test entry with a short TTL using
> `npx wrangler kv key put --binding FEEDBACK --remote "feedback:ttl-test" "{}" --ttl 60`, then confirm it is gone
> a few minutes later.

## One-time setup (owner)

Run these from the repository root with your Cloudflare account. Workers KV and the rate-limiting binding are both
available on the free plan.

```bash
cd web && npm ci && cd ..
npx --prefix web wrangler login
npx --prefix web wrangler kv namespace create FEEDBACK
# Copy the printed id into wrangler.jsonc, replacing REPLACE_WITH_FEEDBACK_KV_NAMESPACE_ID.
cd web && npm run build && cd ..
npx --prefix web wrangler deploy
```

Until the placeholder id is replaced, `wrangler deploy` fails. That stops the site from being deployed with a
feedback button that cannot store anything.

## Reading feedback privately

Feedback is read only through the authenticated Cloudflare dashboard or the CLI:

```bash
npx --prefix web wrangler kv key list --binding FEEDBACK --remote
npx --prefix web wrangler kv key get  --binding FEEDBACK --remote "feedback:2026-10-18T12:00:00.000Z:<uuid>"
```

Treat the message text as untrusted. Read it as plain text and never paste it into HTML or a spreadsheet formula
without escaping.

## Deleting feedback

```bash
npx --prefix web wrangler kv key delete --binding FEEDBACK --remote "<key>"
```
