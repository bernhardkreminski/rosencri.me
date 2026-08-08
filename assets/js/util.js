/**
 * Small shared helpers: DOM, dates, German formatting, ids.
 * No dependencies, no side effects on import.
 */

import { SOON_WINDOW_HOURS, DEFAULT_DURATION_HOURS } from './config.js?v=20260808T0648';

/* --------------------------------- DOM ---------------------------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Terse element factory.
 * @param {string} tag - e.g. 'div.card.is-live' or 'button#save.btn'
 * @param {object} [props] - properties/attributes. `class`, `dataset`, `on*` handled.
 * @param {(Node|string|null|false)[]} [children]
 */
export function el(tag, props = {}, children = []) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const node = document.createElement(name || 'div');
  for (const token of rest) {
    if (token[0] === '.') node.classList.add(token.slice(1));
    else if (token[0] === '#') node.id = token.slice(1);
  }
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className += (node.className ? ' ' : '') + value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && key !== 'form') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------------------------------- ids --------------------------------- */

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // RFC 4122 v4 fallback for older WebViews.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => UUID_RE.test(String(value || ''));

/* --------------------------------- dates -------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

/** `Date` → the value format a `<input type="datetime-local">` expects. */
export function toLocalInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `<input type="datetime-local">` value → ISO string carrying the local offset. */
export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : toOffsetISO(d);
}

/** `Date` → ISO 8601 with the runtime's UTC offset, e.g. 2026-07-25T16:00:00+02:00 */
export function toOffsetISO(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Parse to a Date, or null.
 *
 * The empty-value guard is load-bearing: `new Date(null)` and `new Date(0)`
 * are the epoch, not invalid dates, so without it a missing end time parses
 * as 01.01.1970 and renders as a real date.
 */
export const parseDate = (value) => {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

export const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `YYYY-MM-DD` in local time — used as a calendar cell key. */
export const dayKey = (date) => {
  const d = parseDate(date);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
};

/* ------------------------------ German text ----------------------------- */

const fmtDate = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'short' });
const fmtDateLong = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
});
const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

export const formatDate = (d) => (parseDate(d) ? fmtDate.format(parseDate(d)) : '');
export const formatDateLong = (d) => (parseDate(d) ? fmtDateLong.format(parseDate(d)) : '');
export const formatTime = (d) => (parseDate(d) ? `${fmtTime.format(parseDate(d))} Uhr` : '');

export const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
export const WEEKDAYS_SHORT_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** "in 3 Stunden", "heute", "vor 2 Tagen" … */
export function relativeTime(date, now = new Date()) {
  const d = parseDate(date);
  if (!d) return '';
  const diffMs = d - now;
  const abs = Math.abs(diffMs);
  const min = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const future = diffMs >= 0;

  if (min < 1) return 'gerade eben';
  if (min < 60) return future ? `in ${min} Min.` : `vor ${min} Min.`;
  if (hours < 24) return future ? `in ${hours} Std.` : `vor ${hours} Std.`;
  if (days === 1) return future ? 'morgen' : 'gestern';
  if (days < 31) return future ? `in ${days} Tagen` : `vor ${days} Tagen`;
  const months = Math.round(days / 30);
  if (months < 12) return future ? `in ${months} Mon.` : `vor ${months} Mon.`;
  const years = Math.round(days / 365);
  return future ? `in ${years} J.` : `vor ${years} J.`;
}

/** Compact human range, e.g. "Sa, 25. Juli · 16:00 – 23:00 Uhr". */
export function formatRange(start, end) {
  const s = parseDate(start);
  if (!s) return '';
  const e = parseDate(end);
  const head = `${formatDateLong(s)} · ${fmtTime.format(s)}`;
  if (!e) return `${head} Uhr`;
  return sameDay(s, e)
    ? `${head} – ${fmtTime.format(e)} Uhr`
    : `${head} Uhr – ${formatDateLong(e)} · ${fmtTime.format(e)} Uhr`;
}

/* ------------------------------ event state ----------------------------- */

/** Effective end of an event (falls back to a default duration). */
export function eventEnd(event) {
  const end = parseDate(event.end);
  const start = parseDate(event.start);
  if (end && start && end > start) return end;
  if (!start) return null;
  return new Date(start.getTime() + DEFAULT_DURATION_HOURS * 3600000);
}

/**
 * @returns {'live'|'soon'|'upcoming'|'past'} — drives the highlight styling.
 */
export function eventPhase(event, now = new Date()) {
  const start = parseDate(event.start);
  if (!start) return 'upcoming';
  const end = eventEnd(event);
  if (now >= start && now <= end) return 'live';
  if (now > end) return 'past';
  return start - now <= SOON_WINDOW_HOURS * 3600000 ? 'soon' : 'upcoming';
}

export const isPast = (event, now = new Date()) => eventPhase(event, now) === 'past';
export const isHot = (event, now = new Date()) => ['live', 'soon'].includes(eventPhase(event, now));

/* -------------------------------- misc ---------------------------------- */

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Turn bare URLs in user text into links; everything else is escaped. */
export function linkify(text) {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, '<br>');
}

export const slug = (str) =>
  String(str).toLowerCase().trim()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function debounce(fn, ms = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Deterministic pastel-ish accent per string, used for tag chips and avatars. */
export function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
