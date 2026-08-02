# Operations runbook

## Moderation

There is no login and no admin UI. Events can be edited and deleted **by anyone,
from the site itself** — that is usually the fastest fix for spam or duplicates.

For anything the site cannot do, use the Supabase dashboard → SQL editor:

```sql
-- Hide an event without deleting it (preferred: reversible)
update public.events set status = 'hidden' where id = '…';

-- Remove a comment (visitors cannot)
delete from public.comments where id = '…';

-- Merge duplicates into one series, keeping the row that has the poster
update public.events set
  starts_at = timestamptz '2026-08-05 18:00+02',
  rdates    = array[ timestamptz '2026-08-19 18:00+02' ]
where id = '<keeper>';
delete from public.events where title ilike '%…%' and id <> '<keeper>';
```

Deleting an event cascades to its likes, RSVPs and comments. It does **not**
remove its uploaded poster — clean those from Storage → `posters` separately, or
they linger against the quota.

## Adding a database column

Three steps, and the second is the one everyone forgets:

```sql
alter table public.events add column if not exists <name> <type> not null default …;

-- The view froze its column list at creation and CREATE OR REPLACE cannot
-- insert a column mid-list, so it must be rebuilt.
drop view if exists public.events_with_counts;
create view public.events_with_counts as select e.*, … ;
grant select on public.events_with_counts to anon;
```

Then update **both** mappers, which are explicit allowlists and will silently
drop an unknown field:

- `rowToEvent` / `eventToRow` in `assets/js/store.js`
- `mapSupabaseRow` in `scripts/build-ics.mjs`

## Verifying the backend

```bash
U=<project-url>; K=<public-key>          # both live in assets/js/config.js
h=(-H "apikey: $K" -H "Authorization: Bearer $K")

curl -s "$U/rest/v1/events_with_counts?select=title,starts_at,rrule,rdates" "${h[@]}"
curl -s "$U/storage/v1/object/list/posters" "${h[@]}" -H "Content-Type: application/json" -d '{"prefix":""}'
```

An empty storage listing is **correct** — enumeration is intentionally blocked.

> PostgREST returns `200` with an empty array when RLS filters everything, not an
> error. A missing policy therefore looks exactly like success. Always check that
> a row actually came back. See [pitfalls.md](pitfalls.md#rls-fails-silently).

## What the public key can do

Probed against the live project:

| | |
|---|---|
| Read published events | ✅ by design |
| Read hidden events | ❌ filtered by RLS |
| Enumerate the poster bucket | ❌ blocked |
| Delete comments | ❌ no policy |
| Reach auth users / other schemas | ❌ 404 |
| **Edit or delete any event** | ✅ **by deliberate choice** |

That last row is the whole risk surface: anyone reading the page source can wipe
every event with two lines of `curl`. There is no undo and no audit trail —
Supabase's daily backups are the only recovery. To close it, drop
`events_update_anon` and `events_delete_anon`.

## Demo data

Removing it takes **both** steps — the config flag only gates the website, while
`build-ics.mjs` reads the seed file directly and ignores the flag:

```bash
# assets/js/config.js
export const SHOW_SEED_EVENTS = false;
rm data/seed-events.json
```

Already done. If seeds ever reach the database: `delete from public.events where is_seed = true;`

## Common symptoms

| Symptom | Cause |
|---|---|
| Site renders **nothing**, blank page | Partial cache bust — run `bump-assets.mjs`, see [pitfalls.md](pitfalls.md#partial-cache-busting-blanks-the-site) |
| An edit "saves" then reverts on reload | RLS policy missing; the write matched zero rows |
| A new column reads as empty everywhere | The view was not rebuilt |
| Feed times off by exactly 1–2 h | Generator ran without `TZ=Europe/Berlin` |
| A date shows as **01.01.1970** | A null reached `new Date()` — the epoch trap |
| Repeat setting silently not saved | `rrule`/`rdates` column missing; insert retried without it |

## Backups

Supabase free tier keeps daily backups. There is no export job in this repo, and
`calendar.ics` in git is a lossy snapshot — it has no likes, comments or RSVPs.
For anything irreplaceable, take a manual dump from the dashboard.
