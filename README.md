# rosencri.me

A community board for subculture events in Rosenheim, Germany — concerts, Vokü dinners, flea markets, DIY workshops, and everything else the local punk/indie/DIY scene puts on a flyer. Photograph a poster, let OCR read it, review the result, and it's on the board for everyone.

**Live site:** https://rosencri.me/

## Features

- **Add events from a poster photo** — take a picture with your phone or upload one, and on-device OCR extracts a title, date, time, location, and description as a starting point.
- **Review-and-correct step** — every OCR result is shown in an editable form before it's saved, so nothing gets published unchecked.
- **Manual entry** for events without a poster.
- **List view** with visual highlighting for events happening **now** and events starting **within 24h**, plus separate upcoming and past sections.
- **Month calendar view**, including past events, for browsing by date.
- **iCal subscription** (`webcal://`) for the whole board, plus a per-event "add to my calendar" link.
- **Likes, RSVP ("ich bin dabei"), and comments** — comments become more prominent on events that are currently happening, for live updates from the event itself.
- **Edit and delete** any event, and **repeating events** — weekly/biweekly/monthly, or a series on arbitrary dates.
- **Pull to refresh** on touch devices — drag down from the top to re-read the board without reloading the page.
- **Email notifications for the operator** when an event is added, edited or removed, so an open board with no undo isn't also a silent one.

## Tech stack

- Plain HTML/CSS/JS, ES modules, **zero build step**.
- [Tesseract.js](https://github.com/naptha/tesseract.js) loaded from a CDN — OCR runs entirely in the browser; no image is ever uploaded anywhere for text extraction.
- [Supabase](https://supabase.com) (Postgres + REST + Storage) for shared, cross-device persistence.
- GitHub Pages for hosting.
- GitHub Actions to regenerate the subscribable `calendar.ics` every hour, and to email the operator when the board changes.

## Project layout

```
index.html                   Single-page app shell
assets/css/style.css         All styling
assets/js/config.js          Supabase credentials & feature flags
assets/js/store.js           Data layer (Supabase, with local-storage fallback)
assets/js/ocr.js             Tesseract.js wiring & poster-to-event field extraction
assets/js/ical.js            iCal (.ics) generation for subscribe / add-to-calendar
assets/js/app.js             UI: list, calendar, forms, likes/RSVP/comments
assets/js/calendar.js        Month-grid rendering
assets/js/util.js            Date/DOM/formatting helpers, event phase logic
assets/js/recurrence.js      Expanding repeating events into occurrences
assets/js/seed.js            Relative-date resolution for the demo events
scripts/build-ics.mjs        Node script that (re)builds calendar.ics from event data
scripts/notify-changes.mjs   Diffs the board against the last run and mails the operator
scripts/smtp.mjs             Minimal dependency-free SMTP client used by the notifier
scripts/bump-assets.mjs      Cache-busting version stamp — run before shipping
supabase/schema.sql          Database schema (tables, RLS policies)
.github/workflows/           CI: hourly calendar.ics rebuild, change notifications
.github/notify-state.json    Last seen event snapshot, written by the notify workflow
calendar.ics                 Generated, committed iCal feed (see .gitignore)
dev/ocr-playground.html      Standalone page for testing OCR on sample images
```

## Local development

No build step — but ES modules need to be served over a real HTTP origin, not opened as a `file://` path.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Note: camera capture only works over HTTPS or on `localhost` — browsers block camera access on plain HTTP origins.

## Configuration

Backend and feature flags live in `assets/js/config.js`:

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SHOW_SEED_EVENTS`, the site URL, the
"soon" window and the image size cap. Leaving the credentials empty is
supported — the app falls back to browser-local storage, still works, but data
won't sync between devices. See `supabase/README.md` for backend setup.

## Demo events

The board originally shipped with five placeholder events in
`data/seed-events.json`. **They have been removed** — the file is deleted and
`SHOW_SEED_EVENTS` is `false` in `assets/js/config.js`.

To bring demo data back, restore that file from git history and flip the flag
to `true`. Note that `scripts/build-ics.mjs` reads the seed file directly and
does *not* honour the flag, so deleting the file is what keeps demo events out
of the published `calendar.ics`.

## Documentation

Full documentation lives in [`documentation/`](documentation/README.md):

| | |
|---|---|
| [architecture.md](documentation/architecture.md) | Stack, module map, data flow |
| [data-model.md](documentation/data-model.md) | Event shape, schema, access rules |
| [features.md](documentation/features.md) | What the site does |
| [ocr.md](documentation/ocr.md) | Poster scanning and its limits |
| [recurrence.md](documentation/recurrence.md) | Repeating events and series |
| [calendar-feed.md](documentation/calendar-feed.md) | The subscribable .ics |
| [notifications.md](documentation/notifications.md) | Change emails: setup, cadence, failure modes |
| [deployment.md](documentation/deployment.md) | Hosting and releasing |
| [operations.md](documentation/operations.md) | Moderation, migrations, recovery |
| [decisions.md](documentation/decisions.md) | Why things are the way they are |
| [pitfalls.md](documentation/pitfalls.md) | Traps already hit — read before changing dates, caching or SQL |

**Before shipping any change under `assets/`:** `node scripts/bump-assets.mjs`

## Deployment

See [`documentation/deployment.md`](documentation/deployment.md).

## Privacy / moderation

Events and comments are public and posted anonymously under a self-chosen
nickname — there is no login or account system.

**Anyone can edit or delete any event**, deliberately; see
[`documentation/decisions.md`](documentation/decisions.md#open-permissions) for
the reasoning and how to reverse it. Comments are insert-only and can only be
removed from the Supabase dashboard.

Because that is the whole risk surface, every add, edit and removal emails the
operator — see [`documentation/notifications.md`](documentation/notifications.md).
The recipient address is a repository secret and appears nowhere in this repo.
