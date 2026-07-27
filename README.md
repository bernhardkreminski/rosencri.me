# rosencri.me

A community board for subculture events in Rosenheim, Germany — concerts, Vokü dinners, flea markets, DIY workshops, and everything else the local punk/indie/DIY scene puts on a flyer. Photograph a poster, let OCR read it, review the result, and it's on the board for everyone.

**Live site:** https://bernhardkreminski.github.io/rosencri.me/

## Features

- **Add events from a poster photo** — take a picture with your phone or upload one, and on-device OCR extracts a title, date, time, location, and description as a starting point.
- **Review-and-correct step** — every OCR result is shown in an editable form before it's saved, so nothing gets published unchecked.
- **Manual entry** for events without a poster.
- **List view** with visual highlighting for events happening **now** and events starting **within 24h**, plus separate upcoming and past sections.
- **Month calendar view**, including past events, for browsing by date.
- **iCal subscription** (`webcal://`) for the whole board, plus a per-event "add to my calendar" link.
- **Likes, RSVP ("ich bin dabei"), and comments** — comments become more prominent on events that are currently happening, for live updates from the event itself.

## Tech stack

- Plain HTML/CSS/JS, ES modules, **zero build step**.
- [Tesseract.js](https://github.com/naptha/tesseract.js) loaded from a CDN — OCR runs entirely in the browser; no image is ever uploaded anywhere for text extraction.
- [Supabase](https://supabase.com) (Postgres + REST + Storage) for shared, cross-device persistence.
- GitHub Pages for hosting.
- GitHub Actions to regenerate the subscribable `calendar.ics` every hour.

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
assets/js/seed.js            Relative-date resolution for the demo events
data/seed-events.json        Demo events shown when the board is otherwise empty
scripts/build-ics.mjs        Node script that (re)builds calendar.ics from event data
supabase/schema.sql          Database schema (tables, RLS policies)
.github/workflows/           CI: hourly calendar.ics rebuild
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

```js
export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";
export const SHOW_SEED_EVENTS = true;
```

If `SUPABASE_URL` / `SUPABASE_ANON_KEY` are left empty, the app falls back to browser-local storage — it still works, but data won't sync between devices or visitors. See `supabase/README.md` for backend setup.

## Removing the demo events

**The five events shipped in `data/seed-events.json` are placeholder demo data — remove them before treating the board as live.**

- Fastest: set `SHOW_SEED_EVENTS = false` in `assets/js/config.js` — a one-line change that hides them instantly.
- Cleanup: delete `data/seed-events.json` entirely.
- If seed events were ever pushed into Supabase (e.g. via a script or manual import), also run:
  ```sql
  DELETE FROM events WHERE is_seed = true;
  ```

## Deployment

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for enabling GitHub Pages, configuring secrets, verifying the deploy, and setting up the custom `rosencri.me` domain.

## Privacy / moderation

Events and comments are public and posted anonymously under a self-chosen nickname — there is no login or account system. Moderation (removing spam or inappropriate content) is done manually from the Supabase dashboard.
