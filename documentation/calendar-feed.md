# The calendar feed

A static `calendar.ics` at the site root that any calendar app can subscribe to.

- Subscribe: `webcal://rosencri.me/calendar.ics`
- Fetch: `https://rosencri.me/calendar.ics`

Subscribing beats importing: clients re-fetch periodically, so the board stays in
sync instead of being a one-time snapshot.

## How it is produced

`.github/workflows/calendar.yml` runs `scripts/build-ics.mjs`:

- hourly at **:17** (offset from the top-of-hour rush)
- on `workflow_dispatch`
- on pushes touching the generator or `ical.js`

The script reads published events from Supabase, generates the file with
`assets/js/ical.js`, and commits it back to `main` with `[skip ci]` — which is
exactly why Pages must deploy **from the branch**, not from an Actions workflow.
See [deployment.md](deployment.md#why-branch-based-pages).

The generated file is committed on purpose. It is the published artifact.

If Supabase is configured but unreachable, the script **exits non-zero and leaves
the existing file alone**, so a transient outage can never replace a good feed
with an empty one. With no credentials at all it degrades to an empty but valid
calendar.

## Correctness details that matter

These are the things that break interoperability if you get them wrong:

- **CRLF** line endings, folded at **75 octets** — octet-aware, never splitting a
  multi-byte character
- One **`VTIMEZONE`** block for Europe/Berlin with the real EU DST rules;
  `DTSTART`/`DTEND` are local with `TZID`, while `DTSTAMP`/`CREATED` are UTC
- `REFRESH-INTERVAL`, `X-PUBLISHED-TTL` and `SOURCE` set, so clients treat it as
  a live subscription
- `SOURCE` points at **the .ics itself**, not the website (RFC 7986). Getting
  this wrong pins existing subscriptions to the old address after a domain move.
- **`RRULE` and `RDATE` are not TEXT properties and must not be escaped.**
  Escaping `FREQ=WEEKLY;INTERVAL=2` into `FREQ=WEEKLY\;INTERVAL=2` breaks every
  client. In the same file, `DESCRIPTION` *does* escape its semicolons — that
  contrast is the thing to check after touching the generator.
- Malformed rules are dropped rather than emitted, so bad input can never produce
  a corrupt calendar
- A `VALARM` at −2 h per event

## Per-event export

"Zum Kalender" in the detail dialog downloads a single event. For an occurrence
of a series the rule is **deliberately stripped**, so importing one date cannot
create a whole series shifted onto it.

`googleCalendarUrl()` cannot express `RDATE`; it intentionally points at the
first occurrence only.

## Verifying a change

```bash
node scripts/build-ics.mjs          # writes calendar.ics
grep -c "BEGIN:VEVENT" calendar.ics
grep -a "^RRULE\|^RDATE" calendar.ics
```

Check by eye: every line ≤ 75 octets, CRLF throughout, `BEGIN`/`END` balanced,
exactly one `VTIMEZONE`, `DTSTART` < `DTEND`, and a recurring event appearing
**once** rather than duplicated.

The generator must be run with `TZ=Europe/Berlin` — see
[pitfalls.md](pitfalls.md#timezone-drift).
