#!/usr/bin/env node
// scripts/build-ics.mjs
//
// Builds the public, subscribable calendar.ics feed for rosencri.me.
//
// Zero npm dependencies — only Node 20 builtins (node:fs/promises, node:path,
// node:url, node:crypto) and the global `fetch`.
//
// Sources merged, in order of precedence (later wins on id collision):
//   1. data/seed-events.json  — demo/placeholder events owned by another agent.
//   2. Supabase `events` table (published only) — the live/real data.
// Supabase is expected to win when both happen to share an id, since it's
// the source of truth once an event is actually published.
//
// Usage:
//   node scripts/build-ics.mjs
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/build-ics.mjs

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { eventsToICS } from '../assets/js/ical.js';
import { resolveSeedDates } from '../assets/js/seed.js';

// Seed events express their start as a wall-clock time ("dayOffset 0, 20:00").
// `resolveSeedDates` turns that into a Date with setHours(), which resolves in
// the *process* timezone. GitHub Actions runners are UTC, so without this the
// feed placed every seed 2h later than the website showed it (20:00 -> 22:00).
// The board is Rosenheim-local, so Europe/Berlin is the correct frame of
// reference for a bare "20:00". Real events are unaffected either way: they
// carry an explicit UTC offset.
process.env.TZ ??= 'Europe/Berlin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SEED_PATH = path.join(REPO_ROOT, 'data', 'seed-events.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'calendar.ics');
const CAL_URL = 'https://rosencri.me/';

// ---------------------------------------------------------------------
// Supabase source
// ---------------------------------------------------------------------

function mapSupabaseRow(row) {
  return {
    id: row.id,
    title: row.title || '',
    description: row.description || '',
    location: row.location || '',
    start: row.starts_at,
    end: row.ends_at || null,
    url: row.url || '',
    imageUrl: row.image_url || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.created_at,
    source: row.source || 'manual',
    authorName: row.author_name || '',
    isSeed: !!row.is_seed,
  };
}

/**
 * Fetches published events from Supabase REST (PostgREST).
 * Returns { events, skipped } — skipped=true when the env vars are unset
 * (this is a normal, non-error condition for local/dev runs).
 * Throws if the env vars ARE set but the request fails, so the caller can
 * abort the whole build rather than silently publish a stale/incomplete feed.
 */
async function fetchSupabaseEvents() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    return { events: [], skipped: true };
  }

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/events?select=*&status=eq.published&order=starts_at.asc`;
  const res = await fetch(endpoint, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase request failed: ${res.status} ${res.statusText} ${body}`.trim());
  }

  const rows = await res.json();
  if (!Array.isArray(rows)) {
    throw new Error('Supabase response was not a JSON array');
  }
  return { events: rows.map(mapSupabaseRow), skipped: false };
}

// ---------------------------------------------------------------------
// Seed file source
// ---------------------------------------------------------------------

function stableFallbackId(seed) {
  return 'seed-' + createHash('sha1').update(seed).digest('hex').slice(0, 24);
}

function normalizeSeedEvent(raw, nowMs) {
  const event = { ...raw };

  // Relative seed dates are resolved by the same module the browser uses, so
  // the published feed and the website agree on when the demo events happen.
  const { start, end } = resolveSeedDates(raw, new Date(nowMs));
  if (start) event.start = start.toISOString();
  if (end) event.end = end.toISOString();
  for (const key of ['startOffsetHours', 'endOffsetHours', 'dayOffset', 'time', 'durationHours', 'rollForward']) {
    delete event[key];
  }

  event.title = event.title || '';
  event.description = event.description || '';
  event.location = event.location || '';
  event.end = event.end || null;
  event.url = event.url || '';
  event.imageUrl = event.imageUrl || '';
  event.tags = Array.isArray(event.tags) ? event.tags : [];
  event.createdAt = event.createdAt || new Date(nowMs).toISOString();
  event.source = event.source || 'seed';
  event.authorName = event.authorName || '';
  event.isSeed = true;

  if (!event.id) {
    // Deterministic fallback so the id (and therefore the ICS UID) stays
    // stable across runs even if the seed file never sets one explicitly.
    event.id = stableFallbackId(`${event.title}|${event.start}`);
  }

  return event;
}

/**
 * Reads and normalizes data/seed-events.json.
 * Returns { events, present }. A missing file is NOT an error: present=false
 * and events=[] so the build continues using Supabase data alone.
 */
async function readSeedEvents(seedPath) {
  let raw;
  try {
    raw = await readFile(seedPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { events: [], present: false };
    }
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${seedPath}: ${err.message}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`${seedPath} must contain a JSON array of events`);
  }

  const nowMs = Date.now();
  return { events: data.map((ev) => normalizeSeedEvent(ev, nowMs)), present: true };
}

// ---------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------

/**
 * Merge multiple event lists, deduping by id. Sources listed later take
 * precedence over earlier ones when the same id appears in both.
 */
function mergeEvents(orderedSources) {
  const byId = new Map();
  for (const events of orderedSources) {
    for (const ev of events) {
      if (!ev || !ev.id) continue;
      byId.set(ev.id, ev);
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const seedPath = process.env.SEED_EVENTS_PATH
    ? path.resolve(process.env.SEED_EVENTS_PATH)
    : DEFAULT_SEED_PATH;

  const seedResult = await readSeedEvents(seedPath);

  let supabaseResult;
  try {
    supabaseResult = await fetchSupabaseEvents();
  } catch (err) {
    console.error(`[build-ics] ERROR fetching events from Supabase: ${err.message}`);
    console.error('[build-ics] Aborting without touching calendar.ics.');
    process.exitCode = 1;
    return;
  }

  const merged = mergeEvents([seedResult.events, supabaseResult.events]);

  const ics = eventsToICS(merged, { calUrl: CAL_URL });
  await writeFile(OUTPUT_PATH, ics, 'utf8');
  const bytes = Buffer.byteLength(ics, 'utf8');

  const seedNote = seedResult.present ? `seed=${seedResult.events.length}` : 'seed=0(file missing)';
  const supabaseNote = supabaseResult.skipped
    ? 'supabase=skipped(no env vars)'
    : `supabase=${supabaseResult.events.length}`;
  const ms = Date.now() - startedAt;

  if (merged.length === 0) {
    console.log(
      `[build-ics] No events found (${seedNote}, ${supabaseNote}). ` +
        `Wrote a valid empty calendar to ${OUTPUT_PATH} (${bytes} bytes) in ${ms}ms.`
    );
    return;
  }

  console.log(
    `[build-ics] ${seedNote}, ${supabaseNote}, total=${merged.length} -> ` +
      `${OUTPUT_PATH} (${bytes} bytes) in ${ms}ms`
  );
}

main().catch((err) => {
  console.error('[build-ics] Unhandled error:', err);
  process.exitCode = 1;
});
