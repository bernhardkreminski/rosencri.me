# rosencri.me — Documentation

An open, login-free noticeboard for subculture events in Rosenheim (Upper Bavaria).
People photograph an event poster, OCR pulls out the details, they check the result,
and it lands on a shared board and in a subscribable calendar.

**Live:** <https://rosencri.me> · **Repo:** `bernhardkreminski/rosencri.me`

---

## Read this first

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | Stack, module map, data flow, rendering |
| [data-model.md](data-model.md) | Event shape, database schema, access rules |
| [features.md](features.md) | Every user-facing feature and how it behaves |
| [ocr.md](ocr.md) | Poster scanning: how it works and where it fails |
| [recurrence.md](recurrence.md) | Repeating events and series on fixed dates |
| [calendar-feed.md](calendar-feed.md) | The subscribable `.ics` feed |
| [notifications.md](notifications.md) | Email to the operator when an event changes |
| [deployment.md](deployment.md) | Hosting, domain, releasing changes |
| [operations.md](operations.md) | Runbook: moderation, migrations, recovery |
| [decisions.md](decisions.md) | Why things are the way they are |
| [pitfalls.md](pitfalls.md) | Traps already hit — read before changing dates, caching or SQL |

## The 60-second version

- **No build step.** Plain HTML, CSS and ES modules served straight from GitHub Pages.
- **No login.** Anyone can add, edit or delete any event. This is deliberate — see
  [decisions.md](decisions.md#open-permissions).
- **No server of our own.** The browser talks directly to Supabase (Postgres +
  PostgREST + Storage) with a public key; all access control lives in Postgres
  Row Level Security.
- **OCR runs on the device.** Poster images are never uploaded for text extraction.
- **German UI.** The audience is a local scene; the code and docs are English.

## Repository layout

```
index.html                  Single-page app shell, all dialogs
assets/css/style.css        All styling (design tokens at the top)
assets/js/
  config.js                 Backend credentials + feature flags — start here
  store.js                  Data layer: Supabase with a local-storage fallback
  app.js                    UI shell: views, dialogs, add/edit flow
  calendar.js               Month grid
  recurrence.js             Expanding series into occurrences
  ocr.js                    Poster → event fields (Tesseract.js)
  ical.js                   .ics generation (browser + Node)
  util.js                   Dates, DOM, formatting, event phases
  seed.js                   Relative-date resolution for demo events
scripts/
  build-ics.mjs             Rebuilds calendar.ics from Supabase
  notify-changes.mjs        Diffs the board and mails the operator
  smtp.mjs                  Minimal dependency-free SMTP client
  bump-assets.mjs           Cache-busting version stamp — run before shipping
supabase/schema.sql         Tables, view, RLS policies. Idempotent.
.github/workflows/          Hourly calendar rebuild, change notifications
.github/notify-state.json   Last seen event snapshot (written by the workflow)
dev/ocr-playground.html     Standalone OCR test harness
documentation/              You are here
```

## Working on this

```bash
python3 -m http.server 8123      # ES modules need a real HTTP origin
```

Then open <http://localhost:8123>. Camera capture needs HTTPS or `localhost`.

Before pushing anything that touches `assets/`:

```bash
node scripts/bump-assets.mjs
```

This is not optional. See [pitfalls.md](pitfalls.md#partial-cache-busting-blanks-the-site).
