# Decisions

Why the project is the way it is. Each entry records the trade-off, so a future
change is a deliberate reversal rather than an accident.

---

## No build step

Plain HTML, CSS and ES modules. No bundler, no framework, no npm dependency;
`scripts/` uses only Node builtins.

A local noticeboard should still be editable in five years by whoever inherits
it. A toolchain is the thing most likely to rot first.

**Cost:** no tree-shaking or minification, and module-level cache busting has to
be handled by hand — see [pitfalls.md](pitfalls.md#partial-cache-busting-blanks-the-site).

---

## Supabase rather than a server

GitHub Pages is static-only, and the requirement was shared data visible to
everyone. Supabase gives Postgres, a REST API and file storage on a free tier,
addressed directly from the browser with a public key, with all access control in
Row Level Security.

**Alternatives:** Firebase (heavier client, same account requirement); a
git-backed store (needs a write token in the browser — unacceptable).

---

## Open permissions {#open-permissions}

**Anyone can edit or delete any event.** No login, no attribution, no undo.

Chosen explicitly by the operator over two narrower options (own-device only, or
own-device plus a moderator key). The scene can fix its own duplicates, typos and
bad scans without anyone holding dashboard access.

**The risk is real:** one visitor can empty the board, and the only recovery is
Supabase's daily backup. Comments stay insert-only, and events can be *hidden*
rather than deleted from the dashboard.

**To reverse:** drop `events_update_anon` and `events_delete_anon`. Two lines.

---

## Tesseract only, no vision model {#tesseract-only}

Browser OCR reliably misses hand-lettered logos and small rotated text — exactly
what this scene's posters are made of. A vision model behind a serverless
function would read them properly.

Declined in favour of staying free, keyless and dependency-light. The consequence
is accepted openly: the review screen shows the poster large and full-screen so
missing details can be read off it, and low-confidence fields are flagged rather
than presented as fact.

**To revisit:** a Supabase Edge Function holding an API key server-side, with
Tesseract as the offline fallback.

---

## Recurrence stored as one row

A series is one database row plus a rule or a date list, expanded client-side for
display. The `.ics` ships the rule itself.

Storing N copies would duplicate every edit, scatter likes and comments across
occurrences, and make a subscription show fifty unrelated events.

**Cost:** no per-occurrence overrides — a single date cannot be moved or
cancelled. That needs `EXDATE` plus override rows and has not been built.

---

## Interactions attach to the series

Liking "the weekly Vokü" likes the series, not one week. Simpler to reason about
and matches how people talk about a recurring thing.

---

## German UI, English code

The audience is a local scene in Bavaria. Code, comments and documentation stay
English so the project remains contributable.

---

## Demo data with relative dates

The five shipped demo events used offsets from "now", not fixed dates, so the
live / soon / upcoming / past states demonstrated correctly whenever the page was
opened. Removed once the board went live.

---

## Branch-based Pages

The hourly workflow commits `calendar.ics` with `[skip ci]`, which does not
trigger other workflows. Branch-based publishing redeploys on every commit
regardless; an Actions-based Pages source would silently never publish feed
updates.

---

## Phase colours differ in shape as well as hue

`läuft gerade` and `in den nächsten 24 h` were both red and indistinguishable.
They are now red/round and amber/square, so the distinction survives colour
blindness and greyscale. Solid fills use darker variants that clear 4.5:1 against
white text; the display hues do not.

---

## Search is collapsed

The front page is about events and adding events. Search and tag chips hide
behind a toggle, and "Kalender abonnieren" was removed from the hero because it
already appears in the header and the footer.

Closing the panel resets the query and tags: a filter still applied with its UI
hidden would shrink the list with nothing on screen to explain it.
