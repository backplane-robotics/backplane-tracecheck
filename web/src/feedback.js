// Optional product feedback dialog for the Tracecheck web app.
//
// Deliberately independent of the scan pipeline: this module never reads scan state, filenames,
// contracts or reports. A request is made only when the user presses Submit. Nothing is persisted
// locally; an unsent message lives only in the open page.
import { FEEDBACK_TYPES, HELPED_VALUES, MAX_MESSAGE_CHARS, validateFeedback } from './feedback-schema.js';

const ENDPOINT = '/api/feedback';
const TIMEOUT_MS = 15000;

const FAILURE_TEXT = {
  offline: 'You appear to be offline. Your feedback was not sent. Your text is still here; try again when you are connected.',
  timeout: 'The request timed out. Your feedback was not sent. You can try again.',
  rate_limited: 'Too many submissions in a short time. Your feedback was not sent. Please wait a minute and try again.',
  payload_too_large: 'The feedback is too large to send. Please shorten it and try again.',
  rejected: 'The feedback could not be accepted. Please check the fields and try again.',
  network: 'Your feedback was not sent because of a network or server problem. You can try again.',
};

const VALIDATION_TEXT = {
  invalid_type: 'Choose a feedback type.',
  empty_message: 'Write your feedback before submitting.',
  message_too_long: `Feedback is limited to ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.`,
  invalid_message: 'The feedback contains unsupported control characters.',
};

/** Map a fetch outcome to a failure key; exported for tests. */
export function failureKey(status, error) {
  if (status === 429) return 'rate_limited';
  if (status === 413) return 'payload_too_large';
  if (status === 400 || status === 415) return 'rejected';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return 'network';
}

/** Build the exact request body from form values. Only the four documented fields. */
export function buildPayload({ type, helped, message, version }) {
  return { type, helped: helped || null, message, app_version: version };
}

export function initFeedback({ version, fetchImpl = (...a) => fetch(...a) }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('feedback-dialog');
  if (!dialog) return;
  const form = $('feedback-form');
  const message = $('fb-message');
  const count = $('fb-count');
  const status = $('fb-status');
  const submit = $('fb-submit');
  const success = $('fb-success');
  $('fb-version').textContent = `v${version}`;

  // Guard against stale markup drifting from the schema.
  for (const input of form.querySelectorAll('input[name="type"]')) if (!FEEDBACK_TYPES.includes(input.value)) input.disabled = true;
  for (const input of form.querySelectorAll('input[name="helped"]')) if (!HELPED_VALUES.includes(input.value)) input.disabled = true;

  let pending = false;
  let lastOpener = null;

  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `fb-status ${kind}`.trim();
  };
  const updateCount = () => {
    count.textContent = `${message.value.length.toLocaleString('en-US')} / ${MAX_MESSAGE_CHARS.toLocaleString('en-US')}`;
  };

  function resetForm() {
    form.reset();
    form.hidden = false;
    success.hidden = true;
    submit.textContent = 'Submit feedback';
    setStatus('');
    updateCount();
  }

  function open(opener) {
    lastOpener = opener || document.activeElement;
    if (!success.hidden) resetForm();
    if (!dialog.open) dialog.showModal();
    form.querySelector('input[name="type"]')?.focus();
  }

  function close() {
    if (pending) return;
    dialog.close();
  }

  dialog.addEventListener('close', () => lastOpener?.focus?.());
  dialog.addEventListener('cancel', (e) => {
    if (pending) e.preventDefault();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close(); // backdrop click
  });
  $('fb-cancel').addEventListener('click', close);
  $('fb-x').addEventListener('click', close);
  $('fb-done').addEventListener('click', close);
  message.addEventListener('input', updateCount);
  form.addEventListener('input', () => {
    if (!pending && status.classList.contains('bad')) setStatus('');
  });
  document.querySelectorAll('[data-feedback-open]').forEach((b) => b.addEventListener('click', () => open(b)));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending) return; // duplicate-submit guard

    const data = new FormData(form);
    const payload = buildPayload({ type: data.get('type'), helped: data.get('helped'), message: message.value, version });
    const check = validateFeedback(payload);
    if (!check.ok) {
      setStatus(VALIDATION_TEXT[check.error] || 'Please check the form and try again.', 'bad');
      (check.error === 'invalid_type' ? form.querySelector('input[name="type"]') : message).focus();
      return;
    }
    if (navigator.onLine === false) {
      setStatus(FAILURE_TEXT.offline, 'bad');
      submit.textContent = 'Try again';
      return;
    }

    pending = true;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    setStatus('Sending feedback…');
    let res = null;
    let error = null;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(check.value),
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      error = err;
    }
    let confirmed = false;
    if (res && res.status === 201) {
      try {
        confirmed = (await res.json())?.ok === true;
      } catch {
        confirmed = false;
      }
    }
    pending = false;
    submit.disabled = false;

    if (confirmed) {
      form.hidden = true;
      success.hidden = false;
      $('fb-done').focus();
      return;
    }
    submit.textContent = 'Try again';
    setStatus(FAILURE_TEXT[failureKey(res?.status, error)], 'bad');
  });

  updateCount();
  return { open };
}
