// Pure data helpers for the FCC Covered List robot tracker: validation and filtering.
// Kept free of DOM access so they can be unit-tested (see test/tracker.test.js).

export const MAX_ENTRIES = 500;
const MAX_TEXT = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

const REQUIRED_ENTRY_KEYS = [
  'id', 'manufacturer', 'equipment', 'category', 'notice_number', 'date_announced', 'status',
  'conditions_summary', 'primary_source_url', 'secondary_sources', 'verified_against_primary', 'last_checked',
];

function isText(v, { allowEmpty = false } = {}) {
  return typeof v === 'string' && v.length <= MAX_TEXT && (allowEmpty || v.trim().length > 0);
}

function isDate(v) {
  return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/** Only https links are rendered; anything else is treated as invalid data. */
export function isHttpsUrl(v) {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate the tracker JSON. Returns { ok: true, data } with entries sorted newest first,
 * or { ok: false, errors: [...] }. The page renders nothing from invalid data.
 */
export function validateTrackerData(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['root must be an object'] };
  if (raw.schema_version !== 1) errors.push('schema_version must be 1');
  if (!isDate(raw.last_updated)) errors.push('last_updated must be YYYY-MM-DD');
  if (!isHttpsUrl(raw.covered_list_url)) errors.push('covered_list_url must be an https URL');
  if (!Array.isArray(raw.entries)) errors.push('entries must be an array');
  else if (raw.entries.length > MAX_ENTRIES) errors.push(`entries exceeds ${MAX_ENTRIES}`);

  const ids = new Set();
  (Array.isArray(raw.entries) ? raw.entries.slice(0, MAX_ENTRIES) : []).forEach((e, i) => {
    const at = `entries[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return errors.push(`${at} must be an object`);
    for (const k of REQUIRED_ENTRY_KEYS) if (!(k in e)) errors.push(`${at}.${k} is missing`);
    for (const k of Object.keys(e)) if (!REQUIRED_ENTRY_KEYS.includes(k)) errors.push(`${at}.${k} is not a known key`);
    if (!(typeof e.id === 'string' && ID_RE.test(e.id))) errors.push(`${at}.id is invalid`);
    else if (ids.has(e.id)) errors.push(`${at}.id is duplicated`);
    else ids.add(e.id);
    for (const k of ['manufacturer', 'category', 'status']) if (!isText(e[k])) errors.push(`${at}.${k} must be non-empty text`);
    for (const k of ['notice_number', 'conditions_summary']) if (!isText(e[k], { allowEmpty: true })) errors.push(`${at}.${k} must be text`);
    if (!Array.isArray(e.equipment) || e.equipment.length === 0 || e.equipment.length > 100 || !e.equipment.every((x) => isText(x)))
      errors.push(`${at}.equipment must be a non-empty list of text`);
    for (const k of ['date_announced', 'last_checked']) if (!isDate(e[k])) errors.push(`${at}.${k} must be YYYY-MM-DD`);
    if (e.primary_source_url !== '' && !isHttpsUrl(e.primary_source_url)) errors.push(`${at}.primary_source_url must be https or empty`);
    if (!Array.isArray(e.secondary_sources) || e.secondary_sources.length > 20 || !e.secondary_sources.every(isHttpsUrl))
      errors.push(`${at}.secondary_sources must be a list of https URLs`);
    if (typeof e.verified_against_primary !== 'boolean') errors.push(`${at}.verified_against_primary must be true or false`);
  });

  if (errors.length) return { ok: false, errors };
  const entries = [...raw.entries].sort((a, b) => b.date_announced.localeCompare(a.date_announced) || a.manufacturer.localeCompare(b.manufacturer));
  return { ok: true, data: { ...raw, entries } };
}

/** Distinct, sorted values of one field, for the filter dropdowns. */
export function distinct(entries, key) {
  return [...new Set(entries.map((e) => e[key]))].sort((a, b) => a.localeCompare(b));
}

/**
 * Filter entries. `query` matches manufacturer, equipment, category, notice number and conditions
 * (case-insensitive, all words must match). Dates are inclusive YYYY-MM-DD strings; empty means no bound.
 */
export function filterEntries(entries, { query = '', manufacturer = '', category = '', from = '', to = '' } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (manufacturer && e.manufacturer !== manufacturer) return false;
    if (category && e.category !== category) return false;
    if (from && e.date_announced < from) return false;
    if (to && e.date_announced > to) return false;
    if (!words.length) return true;
    const hay = [e.manufacturer, e.category, e.notice_number, e.conditions_summary, e.status, ...e.equipment].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Format YYYY-MM-DD as e.g. "18 Sep 2026" without timezone drift. */
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}
