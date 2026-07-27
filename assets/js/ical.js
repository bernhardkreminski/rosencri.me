// assets/js/ical.js
//
// RFC 5545 (iCalendar) generator for rosencri.me.
//
// Isomorphic: safe to import from the browser (assets/js/app.js) AND from
// plain Node 20 (scripts/build-ics.mjs). No DOM access happens at module
// load time — `document`/`Blob`/`URL.createObjectURL` are only touched
// inside downloadICS(), which is the one function that is browser-only.
//
// Shared event shape (produced by assets/js/store.js):
//   {
//     id, title, description, location,
//     start,            // ISO 8601 with offset, e.g. "2026-07-25T16:00:00+02:00"
//     end,              // same shape or null -> treated as start + 3h
//     url, imageUrl, tags, createdAt, source, authorName, isSeed
//   }

const CRLF = '\r\n';

const SITE = 'https://bernhardkreminski.github.io/rosencri.me/';

const DEFAULTS = Object.freeze({
  calName: 'rosencri.me — Subkultur in Rosenheim',
  calDesc: 'Offener Terminkalender für die Rosenheimer Subkultur: Konzerte, Vokü, Flohmärkte, Lesungen.',
  calUrl: SITE,
  // RFC 7986 SOURCE must point at the calendar data itself, not the website.
  sourceUrl: `${SITE}calendar.ics`,
  prodId: '-//rosencri.me//Rosenheim Subculture Events//DE',
  timezone: 'Europe/Berlin',
  refreshInterval: 'PT1H',
});

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------

/**
 * Escape a value for use in an RFC 5545 TEXT property.
 * Order matters: backslashes first, then ; and , then newlines.
 * Do NOT use this for URI or DATE-TIME properties.
 */
function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a single logical content line to RFC 5545's 75-octet limit.
 * Folding is octet-aware (UTF-8) and never splits a multi-byte code point:
 * we walk the string one Unicode code point at a time (Array.from handles
 * surrogate pairs) and measure each code point's UTF-8 byte length before
 * deciding whether it still fits on the current physical line.
 *
 * First physical line: up to 75 octets.
 * Continuation lines: up to 74 octets of content + 1 leading space = 75.
 */
function foldLine(line) {
  const encoder = new TextEncoder();
  const codePoints = Array.from(line);
  const physicalLines = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;

  for (const ch of codePoints) {
    const chBytes = encoder.encode(ch).length;
    if (currentBytes + chBytes > limit && current !== '') {
      physicalLines.push(current);
      current = ch;
      currentBytes = chBytes;
      limit = 74;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  physicalLines.push(current);

  return physicalLines.map((l, i) => (i === 0 ? l : ' ' + l)).join(CRLF);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a Date as a UTC DATE-TIME: YYYYMMDDTHHMMSSZ */
function formatUTC(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * Format a Date as a local (floating, TZID-relative) DATE-TIME for the
 * given IANA timezone: YYYYMMDDTHHMMSS (no Z, no offset).
 * Uses Intl.DateTimeFormat so DST transitions are resolved correctly
 * regardless of the host machine's local timezone (works the same in
 * browsers and in Node 20, which ships full ICU).
 */
function formatLocal(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  // Some engines emit "24" instead of "00" for midnight when hour12:false.
  let hour = parts.hour;
  if (hour === '24') hour = '00';
  return `${parts.year}${parts.month}${parts.day}T${hour}${parts.minute}${parts.second}`;
}

/** Resolve the effective DTEND, applying the "null / end<=start -> +3h" rule. */
function resolveEnd(start, end) {
  if (!end || end.getTime() <= start.getTime()) {
    return new Date(start.getTime() + THREE_HOURS_MS);
  }
  return end;
}

function buildDescription(event, calUrl) {
  const parts = [];
  if (event.description) parts.push(event.description);
  if (Array.isArray(event.tags) && event.tags.length) {
    parts.push('Tags: ' + event.tags.join(', '));
  }
  parts.push(`${calUrl}#/event/${event.id}`);
  return parts.join('\n\n');
}

/** Europe/Berlin VTIMEZONE block (CET/CEST with correct EU DST rules). */
function vtimezoneLines(tzid) {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'X-LIC-LOCATION:Europe/Berlin',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

/** Build the lines for one VEVENT, or return null if start is unusable. */
function buildVEvent(event, opts, now) {
  const start = parseDate(event.start);
  if (!start) return null;
  const end = resolveEnd(start, parseDate(event.end));
  const created = parseDate(event.createdAt) || now;
  const tz = opts.timezone || DEFAULTS.timezone;
  const title = event.title || '';

  const lines = [];
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${event.id}@rosencri.me`);
  lines.push(`DTSTAMP:${formatUTC(now)}`);
  lines.push(`CREATED:${formatUTC(created)}`);
  lines.push(`LAST-MODIFIED:${formatUTC(created)}`);
  lines.push(`DTSTART;TZID=${tz}:${formatLocal(start, tz)}`);
  lines.push(`DTEND;TZID=${tz}:${formatLocal(end, tz)}`);
  lines.push(`SUMMARY:${escapeText(title)}`);
  lines.push(`DESCRIPTION:${escapeText(buildDescription(event, opts.calUrl))}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  if (Array.isArray(event.tags) && event.tags.length) {
    lines.push(`CATEGORIES:${event.tags.map(escapeText).join(',')}`);
  }
  lines.push('STATUS:CONFIRMED');
  lines.push('TRANSP:OPAQUE');
  lines.push('BEGIN:VALARM');
  lines.push('ACTION:DISPLAY');
  lines.push(`DESCRIPTION:${escapeText('Reminder: ' + (title || 'Event'))}`);
  lines.push('TRIGGER:-PT2H');
  lines.push('END:VALARM');
  lines.push('END:VEVENT');
  return { lines, start };
}

function buildCalendar(veventLineGroups, opts) {
  const o = { ...DEFAULTS, ...opts };
  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${o.prodId}`);
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:${escapeText(o.calName)}`);
  lines.push(`X-WR-CALDESC:${escapeText(o.calDesc)}`);
  lines.push(`X-WR-TIMEZONE:${o.timezone}`);
  lines.push(`NAME:${escapeText(o.calName)}`);
  lines.push(`DESCRIPTION:${escapeText(o.calDesc)}`);
  lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${o.refreshInterval}`);
  lines.push(`X-PUBLISHED-TTL:${o.refreshInterval}`);
  lines.push(`SOURCE;VALUE=URI:${o.sourceUrl || DEFAULTS.sourceUrl}`);
  lines.push(...vtimezoneLines(o.timezone));
  for (const group of veventLineGroups) lines.push(...group);
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Build a full VCALENDAR feed from a list of events.
 * Events with an unparseable/missing `start` are skipped. Remaining
 * events are sorted by start ascending.
 */
export function eventsToICS(events, opts = {}) {
  const merged = { ...DEFAULTS, ...opts };
  const now = new Date();
  const built = [];
  for (const event of events || []) {
    const v = buildVEvent(event, merged, now);
    if (v) built.push(v);
  }
  built.sort((a, b) => a.start.getTime() - b.start.getTime());
  return buildCalendar(built.map((v) => v.lines), opts);
}

/**
 * Build a single-event VCALENDAR (e.g. for an "add to my calendar" link).
 * Throws if the event's start date is missing/unparseable.
 */
export function eventToICS(event, opts = {}) {
  const merged = { ...DEFAULTS, ...opts };
  const now = new Date();
  const v = buildVEvent(event, merged, now);
  if (!v) {
    throw new Error('eventToICS: event has a missing or unparseable start date');
  }
  return buildCalendar([v.lines], opts);
}

/**
 * Trigger a browser download of an .ics file built from `events`.
 * Browser-only — throws if called outside a DOM environment.
 */
export function downloadICS(events, filename = 'rosencrime.ics', opts = {}) {
  if (typeof document === 'undefined') {
    throw new Error('downloadICS() is browser-only (no `document` in this environment)');
  }
  const ics = eventsToICS(events, opts);
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Build a Google Calendar "quick add" URL for a single event.
 */
export function googleCalendarUrl(event) {
  const start = parseDate(event.start);
  if (!start) {
    throw new Error('googleCalendarUrl: event has a missing or unparseable start date');
  }
  const end = resolveEnd(start, parseDate(event.end));
  const description = buildDescription(event, DEFAULTS.calUrl);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title || '',
    dates: `${formatUTC(start)}/${formatUTC(end)}`,
    details: description,
    location: event.location || '',
    ctz: DEFAULTS.timezone,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Convert an https:// (or http://) calendar feed URL into a webcal:// URL. */
export function webcalUrl(httpsUrl) {
  return String(httpsUrl).replace(/^https?:\/\//, 'webcal://');
}
