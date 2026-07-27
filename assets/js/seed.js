/**
 * Demo-event date resolution — shared by the browser (store.js) and the
 * Node calendar generator (scripts/build-ics.mjs), so both produce identical
 * timestamps for the same seed file.
 *
 * Seeds carry *relative* dates so the demo keeps showing off every UI state
 * (live / within 24h / upcoming / past) whenever the page happens to be opened.
 *
 * Supported forms, in precedence order:
 *   1. `start` / `end`                        — absolute ISO strings
 *   2. `dayOffset` + `time` (+ `durationHours`, `rollForward`)
 *                                             — "N days from today at HH:MM"
 *   3. `startOffsetHours` / `endOffsetHours`   — plain hour offsets from now
 *
 * Isomorphic: no DOM, no imports.
 */

const HOUR = 3600000;

/**
 * @param {object} raw   entry from data/seed-events.json
 * @param {Date}  [now]  reference time, injectable for tests
 * @returns {{start: Date|null, end: Date|null}}
 */
export function resolveSeedDates(raw, now = new Date()) {
  if (raw.start) {
    const start = new Date(raw.start);
    const end = raw.end ? new Date(raw.end) : null;
    return { start: valid(start), end: valid(end) };
  }

  if (Number.isFinite(raw.dayOffset) && typeof raw.time === 'string') {
    const [h, m] = raw.time.split(':').map(Number);
    const start = new Date(now);
    start.setDate(start.getDate() + raw.dayOffset);
    start.setHours(h || 0, m || 0, 0, 0);
    // "next occurrence" semantics: keeps a seed reliably inside its window.
    if (raw.rollForward && start <= now) start.setDate(start.getDate() + 1);
    const end = Number.isFinite(raw.durationHours)
      ? new Date(start.getTime() + raw.durationHours * HOUR)
      : null;
    return { start, end };
  }

  const start = Number.isFinite(raw.startOffsetHours)
    ? new Date(now.getTime() + raw.startOffsetHours * HOUR)
    : null;
  const end = Number.isFinite(raw.endOffsetHours)
    ? new Date(now.getTime() + raw.endOffsetHours * HOUR)
    : null;
  return { start, end };
}

const valid = (d) => (d && !Number.isNaN(d.getTime()) ? d : null);
