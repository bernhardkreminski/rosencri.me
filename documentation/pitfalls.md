# Pitfalls

Every one of these has already caused a real bug here, several of them on the
live site. Read the relevant section before touching that area.

---

## Partial cache busting blanks the site

**Twice.** Both times the live site rendered *nothing at all*.

GitHub Pages serves assets with `max-age=600`. Versioning only the entry point
(`app.js?v=N`) is **worse than versioning nothing**: the browser fetches a fresh
`app.js` whose static `import './util.js'` still resolves to the cached copy. If
the new code uses an export that copy lacks, the module graph fails to load and
the page is blank — not degraded, blank — for up to ten minutes.

```
SyntaxError: The requested module './util.js'
does not provide an export named 'formatDateShort'
```

**Rule:** run `node scripts/bump-assets.mjs` before shipping anything under
`assets/`. It stamps one version onto `index.html` *and* every relative import
inside `assets/js/`, so a deploy serves all-new or all-old modules, never a mix.
Never hand-edit a `?v=` value.

---

## The epoch trap

`new Date(null)`, `new Date(0)` and `new Date('')` are all **the epoch — a valid
date**, not an invalid one. A `Number.isNaN(d.getTime())` check does not catch
them, so a missing value silently becomes **01.01.1970** and renders as if real.

This bit three times: filtering extra dates, a stray `0` in an array, and an
event with no end time showing "von 31.07.2026 bis 01.01.1970".

`parseDate()` in `util.js` now guards `null`/`''` at the source. When accepting
date input from anywhere else, **reject non-dates before constructing**, and
prefer strings and `Date`s over numbers.

---

## Timezone drift

Two distinct failures:

**Wall-clock vs milliseconds.** Stepping a weekly series by `+7 * 86400000 ms`
drifts an event from 20:00 to 19:00 across a DST change. `recurrence.js` steps
through **local calendar components** instead. A monthly series from the 31st
also skips short months rather than clamping, per RFC 5545.

**Process timezone.** GitHub Actions runners are UTC. `build-ics.mjs` resolves
wall-clock times with `setHours()`, so without `TZ=Europe/Berlin` the published
feed placed every event two hours later than the website showed it. The script
pins `process.env.TZ` and the workflow sets it too.

Always store and pass ISO strings **with an offset**. A naive timestamp anywhere
in this system is a bug.

---

## Views freeze their column list

A Postgres view captures its columns when created. `ALTER TABLE … ADD COLUMN`
does **not** appear in a `select e.*` view, and `CREATE OR REPLACE VIEW` can only
*append* — inserting a column mid-list fails:

```
ERROR 42P16: cannot change name of view column "like_count" to "rrule"
```

Adding a column therefore means `DROP VIEW` + `CREATE VIEW` + re-`GRANT`.
Skipping the rebuild is nastier than an error: the column exists, the site reads
it as empty, and the feature looks broken for no visible reason.

---

## RLS fails silently

PostgREST returns **`200` with an empty array** (or `204`) when Row Level
Security filters everything — not an error. A missing `UPDATE` policy therefore
looks *exactly* like a successful save until the next reload undoes it.

Both `updateEvent` and `deleteEvent` now assert that a row actually came back and
surface a clear message instead. Do the same for any new write path.

The same behaviour makes probing safe-looking: a `DELETE` that appears to succeed
may have deleted nothing. Verify by reading back, and scope destructive probes to
a throwaway row.

---

## Explicit allowlists drop new fields

`rowToEvent`/`eventToRow` in `store.js` and `mapSupabaseRow` in `build-ics.mjs`
list their fields explicitly. A new column added to the database and the form but
not to these mappers is **silently discarded**.

This shipped once: a weekly event reached the feed as a single one-off date,
because `mapSupabaseRow` dropped `rrule`. Every subscriber would have seen it
happen once.

---

## Describe the series, not the occurrence

An occurrence's own start matches one of its `rdates`, which de-duplication then
drops — so a four-date series reads **"3 Termine"** on every tile but the first.
Always pass `store.getSeries(id)` to `describeSchedule()` and `seriesSpan()`.

---

## Never display the assumed end time

`eventEnd()` invents `start + 3 h` when no end is set, so phase logic has
something to work with. That guess is for **scheduling only**. Printing it would
tell people an event closes at a time nobody stated. Any UI showing an end must
check the real `end` field first.

---

## Word-boundary matching in the German parser

Stripping a weekday prefix without anchoring ate the first two letters of
`SOLIKONZERT` → `Likonzert`, because `SO` is Sonntag.

Use `(?![\p{L}\p{N}])` with the `u` flag, **not** `\b` — JavaScript's non-unicode
`\b` treats umlauts as non-word characters and would still split `FRÜHSCHOPPEN`
after `FR`. The same hazard applies to month names inside words (`Maifeier`).

---

## Test OCR against real photographs

Synthetic posters drawn on a canvas in a clean font pass trivially and prove
nothing. Verification against them is what let `"Resfest"` ship as a title.
Use a real photo — `dev/ocr-playground.html` exists for exactly this.

---

## Local settings can capture secrets

`.claude/settings.local.json` records approved shell commands verbatim, which
means a token pasted into a command lands in that file in cleartext. It is
gitignored, but treat any credential that passes through the shell as exposed
and rotate it.
