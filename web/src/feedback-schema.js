// Feedback form schema, shared by the browser dialog and the /api/feedback Worker.
// Only these four fields are ever accepted. Nothing here may be derived from scan state.

export const FEEDBACK_TYPES = Object.freeze(['did_not_work', 'improvement', 'experience']);
export const HELPED_VALUES = Object.freeze(['yes', 'partly', 'no', 'not_sure']);
export const FEEDBACK_FIELDS = Object.freeze(['type', 'helped', 'message', 'app_version']);
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_BODY_BYTES = 16 * 1024;

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,24})?$/;
// C0 controls other than tab, newline and carriage return are rejected.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Validate a decoded feedback body.
 * @returns {{ ok: true, value: { type: string, helped: string | null, message: string, app_version: string } }
 *         | { ok: false, error: string }}
 */
export function validateFeedback(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  for (const key of Object.keys(body)) if (!FEEDBACK_FIELDS.includes(key)) return { ok: false, error: 'unexpected_field' };

  const { type, helped = null, message, app_version: appVersion } = body;
  if (typeof type !== 'string' || !FEEDBACK_TYPES.includes(type)) return { ok: false, error: 'invalid_type' };
  if (helped !== null && (typeof helped !== 'string' || !HELPED_VALUES.includes(helped))) return { ok: false, error: 'invalid_helped' };
  if (typeof message !== 'string') return { ok: false, error: 'invalid_message' };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: 'empty_message' };
  if (trimmed.length > MAX_MESSAGE_CHARS) return { ok: false, error: 'message_too_long' };
  if (CONTROL_RE.test(trimmed)) return { ok: false, error: 'invalid_message' };
  if (typeof appVersion !== 'string' || !VERSION_RE.test(appVersion)) return { ok: false, error: 'invalid_app_version' };

  return { ok: true, value: { type, helped, message: trimmed, app_version: appVersion } };
}
