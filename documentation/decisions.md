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

## Notifications poll, they are not pushed {#notify-by-polling}

A GitHub Actions job reads the board each morning, diffs it against a committed
snapshot and mails what changed, rather than a Supabase webhook firing an Edge
Function the moment a row is written.

Push would arrive in seconds. It would also need a deploy step, an HTTP mail
provider's account and API key, and a second place for secrets to live. Polling
reuses the runner, the workflow and the Supabase secrets that already exist, and
a noticeboard for one town does not change often enough for the latency to
matter — the operator asked for exactly one digest, at 09:00.

Hitting 09:00 local is itself a decision. GitHub cron is UTC and ignores DST, so
no single expression is 09:00 all year. Rather than accept an hour of winter
drift, four candidate slots fire and the script sends on the first at or after
09:00 local, once per day. That also makes GitHub's late scheduling harmless
instead of a missed day.

**Cost:** up to a day's delay, one committed state file, and a duplicate
notification if a run dies between sending and committing. The snapshot is
written only after the mail is accepted, so the failure mode is a repeat, never
a miss.

**To reverse:** a `pg_net` trigger or Edge Function on `events`; `OLD`/`NEW`
makes the diffing in `notify-changes.mjs` unnecessary. See
[notifications.md](notifications.md).

---

## SMTP by hand rather than a library {#hand-rolled-smtp}

`scripts/smtp.mjs` is ~250 lines of `node:net` and `node:tls` speaking SMTP
submission. Nodemailer would be one `npm i` away and better in every respect
except the one that matters: this repo has no `package.json`, no lockfile and no
install step anywhere, and a notification mailer is not a good enough reason to
introduce the first one — see [no build step](#no-build-step).

Scope is kept deliberately small: one message, one recipient, plain text,
no pooling, no retry, no attachments. TLS is mandatory on both ports (implicit
on 465, STARTTLS on 587); a server offering neither is refused rather than sent
a password in the clear.

**Cost:** an SMTP state machine nobody else maintains. `SMTP_DEBUG=1` traces the
conversation, because a provider-specific rejection is otherwise unreadable.

---

## Tesseract only, no vision model {#tesseract-only}

> **Reversed on 2026-08-08.** See "Vision model for poster reading" below. The
> original reasoning is kept because the trade-off it describes is still real —
> the site gave up a genuine privacy property to buy accuracy.

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

## Vision model for poster reading {#vision-ocr}

Poster reading now calls Gemini through the `ocr-extract` Edge Function, with
Tesseract kept on-device as the fallback — precisely the revisit the entry above
reserved.

What forced it: six real uploads were hand-transcribed into
`dev/ocr-fixtures.js` and scored. The browser-only pipeline managed **19/43**.
It spent 71 seconds on a hand-lettered flyer and returned no date at all, lost
four of six titles, and saved a flea market starting at 22:42 — the clock in the
screenshot's status bar. Half of those are comprehension failures, not
recognition ones, and no amount of Tesseract tuning reaches them.

**Cost, accepted deliberately:** the image is sent to Google for reading, so the
"nothing ever leaves your device" property is gone. Google's free tier also
trains on submitted content. The privacy page says both plainly, the upload
dialog warns before the picture is chosen, and `OCR_VISION_ENABLED = false`
restores the old behaviour in one line.

**Also considered:** PaddleOCR PP-OCRv5 on-device (~13–30 MB) would have kept
the privacy property and likely fixed the *titles*, but it still returns plain
text — it cannot tell an advert from a poster or a series from a date. Its
accuracy on hand-lettered German is benchmarked nowhere we could find.

**Not built:** a captcha on the upload form. The per-IP daily quota stops loops
and casual scrapers but not a distributed attacker. What is at risk is a free
quota, not money, so this was judged not worth the friction yet.

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

## Pull-to-refresh replaces the browser's own {#pull-to-refresh}

The board changes underneath you and there is no live subscription, so the data
on screen can be an hour old. On a phone the only remedy was the address bar.

The custom gesture exists rather than leaving Chrome's native overscroll refresh
alone because the native one reloads the whole page — modules, fonts, Tesseract
priming — to fetch what a single `store.load()` fetches. `overscroll-behavior-y:
contain` on `html` turns the native one off, so the two never arm together.

Touch-only, deliberately: touch events are their own feature detection, and on
desktop the wordmark already reloads.

**Cost:** a non-passive `touchmove` listener on `document`. It returns on its
first line unless a pull is actually in progress.

---

## Search is collapsed

The front page is about events and adding events. Search and tag chips hide
behind a toggle, and "Kalender abonnieren" was removed from the hero because it
already appears in the header and the footer.

Closing the panel resets the query and tags: a filter still applied with its UI
hidden would shrink the list with nothing on screen to explain it.

---

## Self-hosted fonts

Space Grotesk is served from `assets/fonts/`, not from Google's CDN.

The CDN version transmitted every visitor's IP address to Google before the
first paint, which is the fact pattern LG München I awarded damages for
(20.01.2022, 3 O 17493/20). A noticeboard for a local scene has no business
creating that exposure to save 41 KB.

**Cost:** two binary files in the repo and a manual update if the typeface ever
changes. In exchange the privacy policy lost a whole section, and a
render-blocking request to a third-party origin disappeared.

**Do not reintroduce a CDN font, embed or analytics snippet** without updating
[legal.md](legal.md) and the privacy policy in the same change.

---

## The list collapses a series, the calendar does not

`recurrence.js` materialises a weekly event into as many occurrences as the
400-day window holds. Showing all of them in the list was correct in the sense
that every date is real, and wrong in every sense that matters: with actual data
one weekly Vokü pushed everything else off the front page.

The list now shows one card per series, marked ⟳ with its schedule. The month
grid still gets every occurrence, because showing individual dates is the entire
purpose of a calendar.

**Cost:** the list no longer answers "when is the next Vokü *after* this one" —
that question moves to the calendar view or the event dialog. Accepted: the
front page is for finding out what is on, not for reading a timetable.

The remaining-dates count is only printed for a series that ends. An open-ended
rule has no total, and the window size is an implementation detail, not a fact
about the event.
