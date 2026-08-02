#!/usr/bin/env node
// scripts/notify-changes.mjs
//
// Emails the operator when an event is added, edited or removed on the board.
//
// rosencri.me has no server and no login, and anyone can edit or delete any
// event (documentation/decisions.md#open-permissions). Nothing else tells the
// operator that happened — so this polls, diffs, and mails a digest.
//
// How it detects a change
// -----------------------
// The `events` table has no `updated_at` column, so "what changed" cannot be
// asked of the database. Instead every run stores a snapshot of the tracked
// columns per event and compares it against the previous run's:
//
//   .github/notify-state.json   committed by .github/workflows/notify.yml
//
// The state file holds nothing that isn't already public on the website, and
// deliberately not the recipient address — that lives only in the NOTIFY_TO
// repository secret.
//
// Because the browser reads with the anon key and RLS only exposes published
// rows, an event *hidden* from the Supabase dashboard is indistinguishable from
// a deleted one. The mail says so rather than guessing.
//
// Environment
// -----------
//   SUPABASE_URL, SUPABASE_ANON_KEY   the same two values calendar.yml uses
//   NOTIFY_TO                         recipient
//   SMTP_HOST                         e.g. smtp.gmail.com
//   SMTP_PORT                         465 (implicit TLS, default) or 587
//   SMTP_USER, SMTP_PASS              app password, never an account password
//   SMTP_FROM                         defaults to SMTP_USER
//   NOTIFY_STATE_PATH                 defaults to .github/notify-state.json
//   NOTIFY_SITE_URL                   defaults to https://rosencri.me/
//   NOTIFY_DRY_RUN=1                  print the mail instead of sending it
//
// Anything missing is a skip, not a failure: the workflow stays green from the
// first run, before any secret has been set. A Supabase or SMTP error IS a
// failure, and leaves the state file untouched so the next run retries.
//
// Usage:
//   node scripts/notify-changes.mjs
//   NOTIFY_DRY_RUN=1 node scripts/notify-changes.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendMail } from './smtp.mjs';

// Wall-clock times in the mail are Rosenheim's, not the runner's UTC — the
// same reason build-ics.mjs pins this. See documentation/pitfalls.md.
process.env.TZ ??= 'Europe/Berlin';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE_PATH = path.join(REPO_ROOT, '.github', 'notify-state.json');
const STATE_VERSION = 1;

/**
 * Columns worth an email, with their German labels.
 *
 * An explicit allowlist, like `rowToEvent` in store.js and `mapSupabaseRow` in
 * build-ics.mjs — and with the same hazard: a new column added everywhere but
 * here is silently never reported. See
 * documentation/pitfalls.md#explicit-allowlists-drop-new-fields.
 */
const TRACKED = {
  title: 'Titel',
  starts_at: 'Beginn',
  ends_at: 'Ende',
  location: 'Ort',
  description: 'Beschreibung',
  url: 'Link',
  image_url: 'Bild',
  tags: 'Tags',
  rrule: 'Wiederholung',
  rdates: 'Weitere Termine',
  author_name: 'Eingetragen von',
};

/* ------------------------------- snapshots ------------------------------- */

const str = (value) => String(value ?? '').trim();

/** Normalised to an instant, so a change of Postgres's text rendering is not a diff. */
const iso = (value) => {
  if (value == null || value === '') return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};

const list = (value) => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);

function snapshotOf(row) {
  return {
    title: str(row.title),
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    location: str(row.location),
    description: str(row.description),
    url: str(row.url),
    image_url: str(row.image_url),
    tags: list(row.tags),
    rrule: str(row.rrule),
    rdates: list(row.rdates).map(iso).filter(Boolean).sort(),
    author_name: str(row.author_name),
    // Not compared — it never changes. Kept so a removal mail can still say
    // when the event had been entered.
    created_at: iso(row.created_at),
  };
}

const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

function diffSnapshots(before, after) {
  const added = [];
  const edited = [];
  const removed = [];

  for (const [id, snap] of Object.entries(after)) {
    const prev = before[id];
    if (!prev) { added.push({ id, snap }); continue; }
    const changes = Object.entries(TRACKED)
      .filter(([field]) => !same(prev[field], snap[field]))
      .map(([field, label]) => ({ field, label, from: prev[field], to: snap[field] }));
    if (changes.length) edited.push({ id, snap, prev, changes });
  }

  for (const [id, prev] of Object.entries(before)) {
    if (!after[id]) removed.push({ id, snap: prev });
  }

  return { added, edited, removed };
}

/* -------------------------------- sources -------------------------------- */

async function fetchEvents(url, key) {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/events`
    + '?select=*&status=eq.published&order=starts_at.asc';
  const res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase request failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Supabase response was not a JSON array');
  return rows;
}

async function readState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    // A state file from a future/unknown shape is treated as absent: re-baseline
    // quietly rather than mail the whole board as "new".
    if (parsed?.version !== STATE_VERSION || typeof parsed.events !== 'object') return null;
    return parsed.events;
  } catch {
    return null;
  }
}

async function writeState(statePath, events) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const payload = { version: STATE_VERSION, updatedAt: new Date().toISOString(), events };
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/* ------------------------------- formatting ------------------------------ */

const fmtDateTime = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
});
const fmtDateTimeLong = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
});

const when = (value, long = false) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${(long ? fmtDateTimeLong : fmtDateTime).format(d)} Uhr`;
};

/** One field value as it appears inside a "before → after" line. */
function fieldValue(field, value) {
  if (Array.isArray(value)) {
    if (!value.length) return '—';
    return field === 'rdates' ? value.map((v) => when(v)).join('; ') : value.join(', ');
  }
  const text = str(value);
  if (!text) return '—';
  if (field === 'starts_at' || field === 'ends_at') return when(text);
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > 110 ? `${oneLine.slice(0, 110)}…` : oneLine;
}

/** @param {boolean} [link] false for a removed event, whose deep link is dead */
function eventBlock(label, { id, snap, changes }, siteUrl, link = true) {
  const lines = [`${label}  ${snap.title || 'Ohne Titel'}`];
  const push = (text) => lines.push(`    ${text}`);

  if (snap.starts_at) push(when(snap.starts_at, true));
  if (snap.location) push(snap.location);
  if (snap.author_name) push(`eingetragen von ${snap.author_name}`);

  if (changes?.length) {
    lines.push('');
    for (const c of changes) {
      push(`${c.label}: ${fieldValue(c.field, c.from)}  →  ${fieldValue(c.field, c.to)}`);
    }
  }

  if (link) {
    lines.push('');
    push(new URL(`#/event/${id}`, siteUrl).href);
  }
  return lines.join('\n');
}

function composeSubject({ added, edited, removed }) {
  const total = added.length + edited.length + removed.length;
  if (total === 1) {
    const [only] = [...added, ...edited, ...removed];
    const title = only.snap.title || 'Ohne Titel';
    if (added.length) return `rosencri.me: neues Event „${title}"`;
    if (edited.length) return `rosencri.me: „${title}" geändert`;
    return `rosencri.me: „${title}" entfernt`;
  }
  const parts = [
    added.length && `${added.length} neu`,
    edited.length && `${edited.length} geändert`,
    removed.length && `${removed.length} entfernt`,
  ].filter(Boolean);
  return `rosencri.me: ${total} Änderungen (${parts.join(', ')})`;
}

function composeBody(diff, siteUrl, total) {
  const rule = '─'.repeat(58);
  const blocks = [];

  for (const item of diff.added) blocks.push(eventBlock('NEU', item, siteUrl));
  for (const item of diff.edited) blocks.push(eventBlock('GEÄNDERT', item, siteUrl));
  for (const item of diff.removed) {
    blocks.push(
      `${eventBlock('ENTFERNT', item, siteUrl, false)}\n\n`
      + '    gelöscht — oder im Supabase-Dashboard auf „hidden" gesetzt;\n'
      + '    von außen sind die beiden nicht zu unterscheiden',
    );
  }

  return [
    `${total === 1 ? 'Eine Änderung' : `${total} Änderungen`} auf rosencri.me`,
    rule,
    '',
    blocks.join('\n\n'),
    '',
    rule,
    `Stand: ${when(new Date().toISOString())} · ${siteUrl}`,
    'Jede Person kann Events auf dieser Seite anlegen, ändern und löschen —',
    'das ist so gewollt. Rückgängig machen geht nur über das Supabase-Dashboard.',
    '',
  ].join('\n');
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const to = process.env.NOTIFY_TO;
  const smtpHost = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const dryRun = process.env.NOTIFY_DRY_RUN === '1';
  const siteUrl = process.env.NOTIFY_SITE_URL || 'https://rosencri.me/';
  const statePath = process.env.NOTIFY_STATE_PATH
    ? path.resolve(process.env.NOTIFY_STATE_PATH)
    : DEFAULT_STATE_PATH;

  if (!supabaseUrl || !supabaseKey) {
    console.log('[notify] SUPABASE_URL / SUPABASE_ANON_KEY not set — nothing to watch, skipping.');
    return;
  }
  // Deliberately never logs the address itself.
  if (!dryRun && (!to || !smtpHost || !from)) {
    console.log('[notify] NOTIFY_TO / SMTP_HOST / SMTP_FROM not all set — skipping (set the repository secrets to enable mail).');
    return;
  }

  const rows = await fetchEvents(supabaseUrl, supabaseKey);
  const after = Object.fromEntries(rows.map((row) => [row.id, snapshotOf(row)]));
  const before = await readState(statePath);

  if (!before) {
    await writeState(statePath, after);
    console.log(`[notify] No previous state — recorded ${rows.length} event(s) as the baseline, no mail sent.`);
    return;
  }

  const diff = diffSnapshots(before, after);
  const total = diff.added.length + diff.edited.length + diff.removed.length;
  if (!total) {
    console.log(`[notify] ${rows.length} event(s), nothing changed.`);
    return;
  }

  const subject = composeSubject(diff);
  const text = composeBody(diff, siteUrl, total);

  if (dryRun) {
    // Deliberately returns without storing: a dry run that consumed the diff
    // would leave the next real run with nothing to report.
    console.log(`[notify] DRY RUN — would send:\n\nSubject: ${subject}\n\n${text}`);
    return;
  }

  await sendMail({
    host: smtpHost,
    port: process.env.SMTP_PORT || 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from,
    to,
    subject,
    text,
  });
  console.log(`[notify] Sent: ${subject}`);

  // Only after the mail is away. A failed send throws before this line, so the
  // next run sees the same diff again instead of losing the notification.
  await writeState(statePath, after);
  console.log(
    `[notify] ${diff.added.length} added, ${diff.edited.length} edited, ${diff.removed.length} removed — state updated.`,
  );
}

// Guarded so the pure functions below can be imported and exercised without
// the script reaching for the network.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[notify] Failed:', err.message);
    process.exitCode = 1;
  });
}

export { diffSnapshots, snapshotOf, composeSubject, composeBody };
