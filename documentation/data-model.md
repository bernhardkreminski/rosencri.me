# Data model

## The event object (browser)

Produced by `store.js`; consumed by everything else.

```js
{
  id:          '3f8a…',          // uuid, or '<uuid>::<ms>' for an occurrence
  seriesId:    '3f8a…',          // only on occurrences — the stored row's id
  occurrence:  0,                // 0 = the stored date, 1..n = generated
  title:       'Jahresfest',
  description: 'multi\nline',
  location:    'Salzstadel',
  start:       '2026-08-05T18:00:00+02:00',   // ISO with offset, never naive
  end:         '2026-08-05T19:00:00+02:00',   // or null
  url:         'https://…',      // '' if none
  imageUrl:    'https://…',      // '' if none
  tags:        ['konzert'],
  rrule:       'FREQ=WEEKLY',    // '' if not repeating
  rdates:      ['2026-08-19T18:00:00+02:00'], // extra dates, [] if none
  createdAt:   '2026-07-27T…Z',
  source:      'poster'|'manual'|'seed',
  authorName:  '',               // free text, '' = anonymous
  isSeed:      false,
  likeCount:   0, goingCount: 0, commentCount: 0
}
```

**Times always carry an offset.** A naive timestamp anywhere in this system is a
bug; see [pitfalls.md](pitfalls.md#timezone-drift).

## Database

Four tables plus a view, in Postgres. Full DDL: `supabase/schema.sql` — idempotent,
safe to re-run.

### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `created_at` | timestamptz | |
| `title` | text | 1–200 chars |
| `description` | text | ≤ 4000 chars |
| `location` | text | free text, not geocoded |
| `starts_at` | timestamptz | **first** occurrence of a series |
| `ends_at` | timestamptz | nullable |
| `url`, `image_url` | text | |
| `tags` | text[] | lowercase, hyphenated |
| `source` | text | `manual` \| `poster` \| `seed` |
| `author_id` | text | the client's self-generated id — **not** an identity |
| `author_name` | text | free text |
| `is_seed` | boolean | demo data marker |
| `status` | text | `published` \| `hidden` — hiding is how you moderate |
| `rrule` | text | RFC 5545 RRULE *value*, no `RRULE:` prefix |
| `rdates` | timestamptz[] | extra dates; **never repeats `starts_at`** |

### `likes` / `rsvps`

Keyed `(event_id, client_id)`. `rsvps.status` is `going` or `maybe`.

### `comments`

Insert-only for visitors. Deleting a comment requires the dashboard.

### `events_with_counts` (view)

`events.*` plus `like_count`, `going_count`, `comment_count` via lateral
subqueries. This is what the browser reads.

> A view **freezes its column list when created**. Adding a column to `events`
> does *not* add it to the view, and `CREATE OR REPLACE VIEW` cannot insert a
> column mid-list. Any new column means dropping and recreating the view — see
> [pitfalls.md](pitfalls.md#views-freeze-their-column-list).

## Access rules

All enforced by Row Level Security. The browser uses the **public/anon key**,
which is designed to be shipped to every visitor and can never bypass RLS.

| Table | Read | Insert | Update | Delete |
|---|---|---|---|---|
| `events` | published only | anyone | **anyone** | **anyone** |
| `likes` | anyone | anyone | — | own `client_id` only |
| `rsvps` | anyone | anyone | — | own `client_id` only |
| `comments` | anyone | anyone | — | — |
| `posters` bucket | public URL only | anyone | — | — |

Two things worth understanding:

**Events are fully open.** Any visitor can edit or delete any event, with no
attribution and no undo. That was chosen deliberately — see
[decisions.md](decisions.md#open-permissions) — and is two lines to revert.

**`client_id` is not authentication.** It is a random value the browser makes up
and sends in an `x-client-id` header. It stops the normal UI from letting you
un-like someone else's like; it stops nothing else. Anyone can send any value.

**The storage bucket cannot be listed.** There is deliberately no anon `SELECT`
policy on `storage.objects`: the bucket is public, so posters are already served
at their public URL, and a read policy would only let anyone enumerate every
poster ever uploaded.

## Identity

There are no accounts. Each browser generates a `clientId` (uuid) on first visit
and stores it in `localStorage` under `rc.identity`, together with an optional
display name. Clearing site data means a new identity — likes and RSVPs made
before are no longer withdrawable from the UI.

## localStorage keys

| Key | Contents |
|---|---|
| `rc.identity` | `{ clientId, name }` |
| `rc.likes` / `rc.rsvps` | this browser's own interactions |
| `rc.events` | events saved while the backend was unreachable |
| `rc.comments` / `rc.counts` | local-mode data for non-UUID (demo) events |
