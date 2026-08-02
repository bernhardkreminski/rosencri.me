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
//   NOTIFY_DIGEST_HOUR                hold everything until this hour, Rosenheim
//                                     local, at most one mail per day. Unset =
//                                     send immediately (manual runs always do).
//   NOTIFY_DRY_RUN=1                  print the mail instead of sending it
//   NOTIFY_DUMP_HTML=<path>           dry runs also write the HTML part there
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
    // `lastMailedOn` was added after the first deploys; absent means "not today".
    return { events: parsed.events, lastMailedOn: parsed.lastMailedOn || '' };
  } catch {
    return null;
  }
}

async function writeState(statePath, events, lastMailedOn = '') {
  await mkdir(path.dirname(statePath), { recursive: true });
  const payload = {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    lastMailedOn,
    events,
  };
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/* ------------------------------ digest timing ----------------------------- */

const berlinParts = (date = new Date()) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Berlin',
    }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

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

/* ---------------------------------- html --------------------------------- */

/*
 * Inline styles only, tables for structure, no images and no external assets.
 * Mail clients strip <style> blocks (Gmail), ignore flexbox and grid, and block
 * remote content by default — so this looks deliberately like 2005 markup. The
 * palette is lifted from assets/css/style.css; the accents are the *-solid
 * tokens, which are the ones that clear 4.5:1 behind white text.
 */
const C = {
  page: '#f3ece0', card: '#fffdf7', line: '#e3d9c0',
  ink: '#1c1a17', dim: '#6d675c', faint: '#98918f',
  added: '#26827e', edited: '#ab611d', removed: '#d34338',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function htmlChangeRows(changes) {
  const rows = changes.map((c) => `
          <tr>
            <td style="padding:4px 12px 4px 0;color:${C.dim};font-size:13px;white-space:nowrap;vertical-align:top">${esc(c.label)}</td>
            <td style="padding:4px 0;font-size:13px;color:${C.ink}">
              <span style="color:${C.faint};text-decoration:line-through">${esc(fieldValue(c.field, c.from))}</span>
              <span style="color:${C.faint}">&nbsp;→&nbsp;</span>
              <strong>${esc(fieldValue(c.field, c.to))}</strong>
            </td>
          </tr>`).join('');
  return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0;border-collapse:collapse">${rows}
        </table>`;
}

function htmlCard(label, accent, { id, snap, changes }, siteUrl, link = true, note = '') {
  const meta = [
    snap.starts_at && when(snap.starts_at, true),
    snap.location,
    snap.author_name && `eingetragen von ${snap.author_name}`,
  ].filter(Boolean).map((line) => `
        <div style="font-size:14px;color:${C.dim};margin-top:3px">${esc(line)}</div>`).join('');

  const url = new URL(`#/event/${id}`, siteUrl).href;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px">
    <tr>
      <td style="border-left:3px solid ${accent};padding:2px 0 2px 16px">
        <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.09em;color:#ffffff;background:${accent};border-radius:999px;padding:3px 11px">${esc(label)}</span>
        <div style="font-size:18px;font-weight:700;color:${C.ink};margin:9px 0 0;line-height:1.25">${esc(snap.title || 'Ohne Titel')}</div>${meta}${changes?.length ? htmlChangeRows(changes) : ''}${note ? `
        <div style="margin-top:12px;padding:9px 12px;background:${C.page};border-radius:8px;font-size:12px;color:${C.dim};line-height:1.5">${esc(note)}</div>` : ''}${link ? `
        <div style="margin-top:14px"><a href="${esc(url)}" style="display:inline-block;background:${C.ink};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:999px">Event ansehen</a></div>` : ''}
      </td>
    </tr>
  </table>`;
}

function composeHtml(diff, siteUrl, total) {
  const cards = [
    ...diff.added.map((i) => htmlCard('NEU', C.added, i, siteUrl)),
    ...diff.edited.map((i) => htmlCard('GEÄNDERT', C.edited, i, siteUrl)),
    ...diff.removed.map((i) => htmlCard('ENTFERNT', C.removed, i, siteUrl, false,
      'Gelöscht — oder im Supabase-Dashboard auf „hidden" gesetzt. Von außen sind die beiden nicht zu unterscheiden.')),
  ].join('');

  // A full document, not a fragment. The MIME part already declares
  // charset=utf-8, but clients that extract the HTML and re-render it (or a
  // browser opening a saved .eml) fall back to guessing without the meta tag,
  // and every umlaut arrives as mojibake.
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>rosencri.me</title>
</head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="margin:0;padding:26px 12px;background:${C.page};font-family:${FONT};-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:${C.card};border:1px solid ${C.line};border-radius:18px">
  <tr>
    <td style="padding:24px 26px 18px;border-bottom:1px solid ${C.line}">
      <div style="font-size:19px;font-weight:700;letter-spacing:-.02em;color:${C.ink}">rosencri<span style="color:${C.removed}">.</span>me</div>
      <div style="font-size:14px;color:${C.dim};margin-top:3px">${total === 1 ? 'Eine Änderung' : `${total} Änderungen`} auf dem Board</div>
    </td>
  </tr>
  <tr><td style="padding:22px 26px 4px">${cards}</td></tr>
  <tr>
    <td style="padding:16px 26px 22px;border-top:1px solid ${C.line};font-size:12px;color:${C.dim};line-height:1.6">
      Stand: ${esc(when(new Date().toISOString()))} · <a href="${esc(siteUrl)}" style="color:${C.dim}">${esc(siteUrl.replace(/^https?:\/\/|\/$/g, ''))}</a><br>
      Jede Person kann Events auf dieser Seite anlegen, ändern und löschen — das ist so gewollt.
      Rückgängig machen geht nur über das Supabase-Dashboard.
    </td>
  </tr>
</table>
</div>
</body>
</html>`;
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
  const digestHour = process.env.NOTIFY_DIGEST_HOUR;
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
  const state = await readState(statePath);

  if (!state) {
    await writeState(statePath, after);
    console.log(`[notify] No previous state — recorded ${rows.length} event(s) as the baseline, no mail sent.`);
    return;
  }

  const diff = diffSnapshots(state.events, after);
  const total = diff.added.length + diff.edited.length + diff.removed.length;
  if (!total) {
    console.log(`[notify] ${rows.length} event(s), nothing changed.`);
    return;
  }

  /*
   * One digest a day, in the morning.
   *
   * `digestHour` is only set for scheduled runs, so a manual dispatch always
   * sends. The gate lives here rather than in the cron because GitHub cron is
   * UTC and ignores DST: `0 7 * * *` is 09:00 in Rosenheim in summer and 08:00
   * in winter. The workflow fires several candidate slots and this drops all
   * but the first one at or after 09:00 local — which also absorbs GitHub's
   * habit of running scheduled jobs late.
   */
  const now = berlinParts();
  if (digestHour) {
    if (now.hour < Number(digestHour)) {
      console.log(`[notify] ${total} change(s) pending — holding until ${digestHour}:00 (now ${now.hour}:xx in Rosenheim).`);
      return;
    }
    if (state.lastMailedOn === now.day) {
      console.log(`[notify] ${total} change(s) pending — today's digest already went out; they go in tomorrow's.`);
      return;
    }
  }

  const subject = composeSubject(diff);
  const text = composeBody(diff, siteUrl, total);
  const html = composeHtml(diff, siteUrl, total);

  if (dryRun) {
    // Deliberately returns without storing: a dry run that consumed the diff
    // would leave the next real run with nothing to report.
    console.log(`[notify] DRY RUN — would send:\n\nSubject: ${subject}\n\n${text}`);
    if (process.env.NOTIFY_DUMP_HTML) {
      await writeFile(process.env.NOTIFY_DUMP_HTML, html, 'utf8');
      console.log(`[notify] HTML part written to ${process.env.NOTIFY_DUMP_HTML}`);
    }
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
    html,
  });
  console.log(`[notify] Sent: ${subject}`);

  // Only after the mail is away. A failed send throws before this line, so the
  // next run sees the same diff again instead of losing the notification.
  await writeState(statePath, after, now.day);
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

export { diffSnapshots, snapshotOf, composeSubject, composeBody, composeHtml, berlinParts };
