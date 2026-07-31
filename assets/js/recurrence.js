/**
 * Recurring-event expansion.
 *
 * Events store an RFC 5545 RRULE *value* (no "RRULE:" prefix) and are expanded
 * into individual occurrences for the list and calendar views. The published
 * .ics does NOT use this — it emits one VEVENT carrying the RRULE and lets the
 * calendar client expand it, which is what makes a subscription show the repeat
 * natively. This module exists purely so our own UI can show the same thing.
 *
 * Only the small subset the form can produce is supported:
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, optional INTERVAL, optional UNTIL.
 *
 * Isomorphic: no DOM, no imports.
 */

/** How far back/forward the UI materialises occurrences. */
export const WINDOW_BACK_DAYS = 60;
export const WINDOW_FORWARD_DAYS = 400;
/** Hard stop so a malformed rule can never spin up unbounded work. */
const MAX_OCCURRENCES = 400;

const SEP = '::';

/** Occurrence id → the id of the series it belongs to. */
export const seriesIdOf = (id) => String(id ?? '').split(SEP)[0];
export const isOccurrenceId = (id) => String(id ?? '').includes(SEP);

/**
 * @param {string} rrule
 * @returns {{freq: string, interval: number, until: Date|null}|null}
 */
export function parseRRule(rrule) {
  if (typeof rrule !== 'string' || !rrule.trim()) return null;
  const parts = {};
  for (const chunk of rrule.trim().split(';')) {
    const [k, v] = chunk.split('=');
    if (k && v != null) parts[k.trim().toUpperCase()] = v.trim();
  }
  const freq = (parts.FREQ || '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

  const interval = Math.max(1, Math.min(52, parseInt(parts.INTERVAL, 10) || 1));

  let until = null;
  if (parts.UNTIL) {
    // Basic-format UTC stamp: YYYYMMDDTHHMMSSZ (Z optional in the wild).
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/.exec(parts.UNTIL);
    if (m) {
      until = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 23), +(m[5] || 59), +(m[6] || 59)));
      if (Number.isNaN(until.getTime())) until = null;
    }
  }
  return { freq, interval, until };
}

/**
 * Advance a date by n steps of `freq`, operating on local calendar components
 * rather than adding milliseconds. This keeps the wall-clock time stable across
 * a DST boundary — a 20:00 weekly event stays 20:00, it does not drift to 19:00
 * when the clocks change.
 *
 * Returns null when the step lands on a date that does not exist (e.g. the 31st
 * in a 30-day month), which per RFC 5545 is skipped rather than clamped.
 */
function step(base, freq, n) {
  const y = base.getFullYear(), mo = base.getMonth(), d = base.getDate();
  const h = base.getHours(), mi = base.getMinutes(), s = base.getSeconds();
  let out;
  if (freq === 'DAILY') out = new Date(y, mo, d + n, h, mi, s);
  else if (freq === 'WEEKLY') out = new Date(y, mo, d + 7 * n, h, mi, s);
  else if (freq === 'MONTHLY') {
    out = new Date(y, mo + n, d, h, mi, s);
    if (out.getDate() !== d) return null;      // e.g. 31 Jan -> "31 Feb"
  } else {
    out = new Date(y + n, mo, d, h, mi, s);
    if (out.getDate() !== d) return null;      // 29 Feb in a non-leap year
  }
  return Number.isNaN(out.getTime()) ? null : out;
}

/**
 * Expand one event into the occurrences falling inside the window.
 * A non-recurring event yields itself unchanged (same object identity), so
 * callers can expand a whole list unconditionally.
 *
 * @param {object} event  app-shaped event with `start`, optional `end`, `rrule`
 * @param {{from?: Date, to?: Date, now?: Date}} [opts]
 * @returns {object[]}
 */
export function expandEvent(event, opts = {}) {
  const rule = parseRRule(event?.rrule);
  const start = event?.start ? new Date(event.start) : null;
  const extra = Array.isArray(event?.rdates) ? event.rdates : [];
  if (!start || Number.isNaN(start.getTime())) return [event];
  if (!rule && !extra.length) return [event];

  // Explicit dates (RFC 5545 RDATE) cover series that no FREQ/INTERVAL can
  // describe — e.g. concerts on 05.08., 19.08., 16.09., 30.09.
  if (!rule) return withExplicitDates(event, start, extra);

  const now = opts.now || new Date();
  const from = opts.from || new Date(now.getTime() - WINDOW_BACK_DAYS * 86400000);
  const to = opts.to || new Date(now.getTime() + WINDOW_FORWARD_DAYS * 86400000);
  const end = event.end ? new Date(event.end) : null;
  const durationMs = end && end > start ? end - start : null;

  const out = [];
  for (let n = 0; out.length < MAX_OCCURRENCES; n++) {
    const occStart = step(start, rule.freq, n * rule.interval);
    // A skipped month/leap day is not the end of the series — keep stepping.
    if (occStart === null) {
      if (n > MAX_OCCURRENCES * 2) break;
      continue;
    }
    if (occStart > to) break;
    if (rule.until && occStart > rule.until) break;
    if (occStart < from) continue;

    out.push(n === 0 ? { ...event, seriesId: event.id, occurrence: 0 } : {
      ...event,
      id: `${event.id}${SEP}${occStart.getTime()}`,
      seriesId: event.id,
      occurrence: n,
      start: toOffsetISO(occStart),
      end: durationMs ? toOffsetISO(new Date(occStart.getTime() + durationMs)) : null,
    });
  }
  // Everything is behind us but the series is open-ended: still show the next
  // one, otherwise a weekly event silently vanishes off the board.
  if (!out.length && !rule.until) {
    for (let n = 1; n <= MAX_OCCURRENCES; n++) {
      const occStart = step(start, rule.freq, n * rule.interval);
      if (occStart && occStart >= from) {
        out.push({
          ...event,
          id: `${event.id}${SEP}${occStart.getTime()}`,
          seriesId: event.id,
          occurrence: n,
          start: toOffsetISO(occStart),
          end: durationMs ? toOffsetISO(new Date(occStart.getTime() + durationMs)) : null,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Materialise an event that lists its dates explicitly. The first date is the
 * event's own `start`; `rdates` holds only the additional ones.
 */
function withExplicitDates(event, start, rdates) {
  const end = event.end ? new Date(event.end) : null;
  const durationMs = end && end > start ? end - start : null;

  const seen = new Set([start.getTime()]);
  const out = [{ ...event, seriesId: event.id, occurrence: 0 }];

  const parsed = rdates
    // Reject non-dates BEFORE constructing. new Date(null) and new Date(0) are
    // both the epoch rather than invalid dates, so a null or a stray 0 would
    // otherwise surface as a real occurrence on 01.01.1970. rdates always
    // arrive as ISO strings (Postgres) or Dates, so numbers are not accepted.
    .filter((d) => d instanceof Date || (typeof d === 'string' && d.trim() !== ''))
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()) && d.getFullYear() > 1970)
    .sort((a, b) => a - b);

  let n = 0;
  for (const occStart of parsed) {
    // A repeated first date would render the same event twice on that day.
    if (seen.has(occStart.getTime())) continue;
    seen.add(occStart.getTime());
    out.push({
      ...event,
      id: `${event.id}${SEP}${occStart.getTime()}`,
      seriesId: event.id,
      occurrence: ++n,
      start: toOffsetISO(occStart),
      end: durationMs ? toOffsetISO(new Date(occStart.getTime() + durationMs)) : null,
    });
  }
  return out;
}

/** Expand a list, preserving one-off events as-is. */
export function expandAll(events, opts = {}) {
  const out = [];
  for (const ev of events) out.push(...expandEvent(ev, opts));
  return out;
}

/* Local copy of util.js's formatter — kept here so this module stays
   dependency-free and usable from Node. */
function toOffsetISO(date) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}
