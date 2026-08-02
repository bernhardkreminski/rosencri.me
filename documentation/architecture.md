# Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| Hosting | GitHub Pages, branch-based | Free, no build step, redeploys on every push |
| Frontend | Plain HTML/CSS/ES modules | No toolchain to rot; editable by anyone who knows JS |
| Backend | Supabase (Postgres + PostgREST + Storage) | Shared data without running a server |
| OCR | Tesseract.js, lazily loaded from a CDN | Runs on-device; no image ever leaves the phone |
| Calendar feed | GitHub Actions, hourly | Produces a static `.ics` that any calendar app can subscribe to |

There is **no build, no bundler, no framework, and no npm dependency**. `scripts/`
runs on plain Node 20 builtins.

## Module map

```
index.html
  └── app.js ─────────── UI shell: routing, views, dialogs, add/edit flow
        ├── config.js ── credentials + flags (the only file you edit to point elsewhere)
        ├── store.js ─── data layer
        │     ├── util.js
        │     ├── seed.js ────── demo-event date resolution
        │     └── recurrence.js  series expansion
        ├── calendar.js  month grid
        ├── recurrence.js
        ├── util.js
        ├── ical.js ──── loaded on demand (calendar export, series labels)
        └── ocr.js ───── loaded on demand (first poster scan only)
```

`ical.js` and `ocr.js` are **dynamically imported** so the initial page load stays
small — OCR in particular pulls a multi-megabyte CDN payload the first time it runs.

`ical.js` and `seed.js` are **isomorphic**: no DOM access at module scope, so
`scripts/build-ics.mjs` can import them under Node.

## Data flow

### Reading

```
Supabase view `events_with_counts`
      │  (single GET, published events only)
      ▼
store.load()  ──► store.series   the stored rows, one per event
      │
      │ expandAll()  — recurrence.js materialises each series into occurrences
      ▼
   store.events  ──► render()  ──► list view / month grid
```

A repeating event is **one row** in the database and **many objects** in
`store.events`. Occurrence ids are `<uuid>::<timestamp>`; the part before `::`
is the series id. Anything that touches the database must resolve back to the
series id first — see [recurrence.md](recurrence.md#occurrence-identity).

### Writing

`store` exposes `addEvent`, `updateEvent`, `deleteEvent`, `toggleLike`,
`setRsvp`, `addComment`, `uploadPoster`. Each writes to Supabase over PostgREST
and updates the in-memory state, then emits a `change` event that triggers a
re-render.

If Supabase is unreachable or unconfigured, the store silently falls back to
`localStorage` and the UI shows a banner. That fallback is why the app still
works during a schema migration.

## Rendering

Deliberately dumb: no virtual DOM, no reactivity. `render()` clears the list
containers and rebuilds them from `store.events`. It runs on:

- any `change` / `event-changed` event from the store
- a **60-second interval**, so "in 3 Std." labels and the live highlight stay
  honest without a reload, and the "Heute ist …" line survives midnight

Elements are built with `el()` from `util.js`, a small factory taking
`'div.card.is-live'`-style tags.

## Event phases

`eventPhase()` in `util.js` returns one of four states, and almost all visual
treatment keys off it:

| Phase | Meaning | Where |
|---|---|---|
| `live` | now is between start and end | "Jetzt & heute", red, pulsing badge |
| `soon` | starts within `SOON_WINDOW_HOURS` (24) | "Jetzt & heute", amber |
| `upcoming` | later | "Demnächst", teal |
| `past` | over | "Vorbei", grey, dimmed |

When an event has no end time, `eventEnd()` assumes `DEFAULT_DURATION_HOURS` (3)
for phase purposes only. That guess is never displayed — see
[pitfalls.md](pitfalls.md#never-display-the-assumed-end-time).

## Configuration

Everything tunable lives in `assets/js/config.js`: backend credentials, the
demo-data flag, the site URL, the "soon" window, the assumed duration and the
image size cap. **Credential values are not reproduced in this documentation** —
read the file.
