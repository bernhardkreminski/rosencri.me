# Supabase setup for rosencri.me

rosencri.me has no server of its own. The browser talks directly to a
[Supabase](https://supabase.com) project (hosted Postgres + PostgREST +
Storage) using the public **anon key**, and access control is entirely
enforced by Postgres Row Level Security (RLS) policies — see
`schema.sql` for those policies and the trade-offs documented in it.

## 1. Create a project

1. Sign up / log in at [supabase.com](https://supabase.com) and create a new project.
2. Wait for it to finish provisioning (a couple of minutes).

## 2. Run the schema

1. Open **SQL Editor** in the Supabase dashboard.
2. Paste the entire contents of [`schema.sql`](./schema.sql) and run it.
3. It's idempotent — safe to re-run any time you want to pick up changes
   (it uses `create table if not exists`, `drop policy if exists` +
   `create policy`, `create or replace view`, etc.).

This creates:

- Tables `events`, `likes`, `rsvps`, `comments` (all with RLS enabled).
- A view `events_with_counts` (events + like/going/comment counts).
- A public storage bucket named `posters` (5 MB limit, image mime types only).

Note there is intentionally **no anon SELECT policy on `storage.objects`**. The
bucket is public, so posters are already readable at
`/storage/v1/object/public/posters/<name>` without any policy; adding one would
only let anyone call the list endpoint and enumerate every poster ever
uploaded. Uploads and public reads both work without it.

## 3. Copy your project keys

In the dashboard: **Project Settings → API Keys**.

- **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`
- The public key. Supabase is mid-migration on naming here:
  - newer projects show a **publishable key**, `sb_publishable_…`
  - older ones show an **anon / public** key, a long JWT starting `eyJ…`

  Either works — both are accepted in the `apikey` and `Authorization: Bearer`
  headers that `store.js` sends. Never use the **secret** / **service_role**
  key: it bypasses RLS entirely.

## 4. Wire the site to your project

Open [`assets/js/config.js`](../assets/js/config.js) and fill in:

```js
export const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...'; // your anon public key
```

Leaving both empty is also supported — the site falls back to
browser-local storage so it still works without any backend configured.

### Is it safe to commit the anon key to a public repo?

Yes. The anon key is *meant* to be public — it's the key a static site
ships to every visitor's browser, by design. It does not grant admin
access. What it's allowed to do is entirely defined by the RLS policies in
`schema.sql`: public read of published events, public insert of new
events/likes/rsvps/comments, and best-effort delete of your own
like/rsvp. It can never bypass RLS, drop tables, or read hidden/unpublished
rows. The only key that must stay secret is the **service_role** key
(never referenced anywhere in this repo) — that one *does* bypass RLS and
should only ever be used from a trusted environment (e.g. typed directly
into the Supabase dashboard), never shipped to a browser.

## 5. Add the same two values as GitHub repo secrets

The hourly `calendar.yml` workflow (`scripts/build-ics.mjs`) also needs
these two values, as repository secrets, to pull published events into the
`calendar.ics` feed. Using the [GitHub CLI](https://cli.github.com/):

```sh
gh secret set SUPABASE_URL --body "https://xxxxxxxxxxxx.supabase.co"
gh secret set SUPABASE_ANON_KEY --body "eyJ..."
```

(Or set them via GitHub's web UI: **Settings → Secrets and variables →
Actions → New repository secret**.)

If these secrets are left unset, the workflow still runs successfully — it
just builds the calendar feed from `data/seed-events.json` alone.

## Removing the demo data

Five example events ship with the site so it doesn't look empty on day
one. There are two independent places demo data can come from, and you can
clear either or both:

- **Client-only demo events** (from `data/seed-events.json`, shown even
  with no Supabase project configured): set `SHOW_SEED_EVENTS = false` in
  `assets/js/config.js`.
- **Seed rows actually inserted into your Supabase database** (if any were
  added via the dashboard or a script): run this in the SQL editor —

  ```sql
  DELETE FROM events WHERE is_seed = true;
  ```

  This statement is also included, commented out, at the bottom of
  `schema.sql`.

## Notes on the RLS trade-offs (read `schema.sql` for the full comments)

- `events`/`comments` can be publicly inserted but **not** updated or
  deleted by anon — moderation (hiding spam, fixing typos) is done by an
  admin through the Supabase dashboard using the service_role key.
- `likes`/`rsvps` can be deleted by anon, restricted to rows whose
  `client_id` matches an `x-client-id` request header the browser is
  expected to send. This is best-effort, not real authentication: anon
  clients aren't authenticated, so a client_id/header is just a value the
  browser makes up and sends — trivially spoofable via a raw HTTP request
  with the same public anon key. It's enough to keep the normal UI honest
  (you can only un-like/un-RSVP through your own browser), not a security
  boundary.

---

## Edge Function: `ocr-extract` (poster reading)

Reads an uploaded poster with Google's Gemini API and returns event fields.
It exists so the API key stays **server-side** — a static site cannot hold a
secret, and a key shipped in client JS gets scraped within hours.

Background and the measurements that justified it: [`documentation/ocr.md`](../documentation/ocr.md).

### 1. Apply the schema

Re-run `schema.sql` in the SQL editor (it is idempotent). This adds
`public.ocr_usage` and `public.bump_ocr_usage()`, the per-IP daily quota the
function uses. Both are deliberately unreachable with the anon key.

### 2. Get a Gemini API key

<https://aistudio.google.com/apikey> — free, no credit card.

### 3. Deploy

```bash
supabase login
supabase link --project-ref pyftcvikhuzleqxjsecn
supabase secrets set GEMINI_API_KEY=<your key>
supabase functions deploy ocr-extract
```

Or, without the CLI: paste `functions/ocr-extract/index.ts` into
**Edge Functions → Deploy a new function** in the dashboard, and add
`GEMINI_API_KEY` under **Project Settings → Edge Functions → Secrets**.

### 4. Verify

```bash
curl -s -X POST https://pyftcvikhuzleqxjsecn.supabase.co/functions/v1/ocr-extract \
  -H "Content-Type: application/json" \
  -H "apikey: sb_publishable_Nc8I0WcFkrfZKqoRGEBYJQ_1opGv3oG" \
  -H "Authorization: Bearer sb_publishable_Nc8I0WcFkrfZKqoRGEBYJQ_1opGv3oG" \
  -d '{"imageBase64":"iVBORw0KGgo=","mimeType":"image/png"}'
```

`{"error":"not_configured"}` means the secret is missing. `{"error":"upstream_error", "status":400}`
with "API key not valid" means the secret is set but wrong. A `400` naming the
model means `GEMINI_MODEL` needs setting to a model id your key can reach.

Then run `dev/ocr-batch.html?engine=vision` against the six fixture images.

### Environment variables

| Name | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | **Required.** Set via `supabase secrets set`, never in git. |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Change without a redeploy if the model id moves. |
| `OCR_DAILY_IP_QUOTA` | `40` | Per-IP, per-UTC-day cap. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform; the
function uses them only to count quota, and skips counting if they are absent.

### Turning it off

`OCR_VISION_ENABLED = false` in `assets/js/config.js` reverts the site to
on-device Tesseract. The function can stay deployed; nothing will call it.
