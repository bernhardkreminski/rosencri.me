# Features

Everything the site does, from the visitor's side. UI language is German.

## Adding an event

The `+` button (floating, bottom right) and "Event hinzufügen" both open a sheet
with three options:

1. **Poster fotografieren** — `<input capture="environment">`, opens the camera
   directly on a phone
2. **Bild hochladen** — file picker
3. **Manuell eintragen** — empty form

On a touch device the camera option is shown first and styled as primary; on a
desktop the order flips, because a capture input there just opens a file picker.

After a photo, OCR runs on the device (progress bar, cancellable) and the result
opens in a **review form** — nothing is ever saved without confirmation. Fields
the OCR was unsure about are flagged "⚠︎ bitte prüfen". The poster is shown
alongside the form at a readable size and opens full-screen on tap, because
[some things are never extractable](ocr.md#what-it-cannot-read).

Required: title and start. Everything else is optional.

## Browsing

### List view

Three sections, in this order:

- **Jetzt & heute** — running now or starting within 24 h. Amplified cards:
  bigger title, coloured border, badge.
- **Demnächst** — everything later.
- **Vorbei** — collapsed by default, newest first.

Above them: **"Heute ist <date>"**, restamped every 60 s so it survives midnight.

Each card shows date, time, location, tags, and like/RSVP/comment counts. Cards
for a series, or for something currently running, also carry a **"von … bis …"**
line — dates for multi-day, times for same-day. It is omitted entirely when an
event has no real end time.

### Calendar view

Month grid, weeks starting Monday, past events included but dimmed. Today is
ringed and carries `aria-current="date"`. Clicking a day lists that day's events
below the grid.

Four phase colours, distinguishable without colour vision (shape differs too):

| | Meaning |
|---|---|
| red, round | läuft gerade |
| amber, square | in den nächsten 24 h |
| teal | demnächst |
| grey | vorbei |

### Pull to refresh

Drag down from the top of either view and let go past the threshold: the board
is re-read from Supabase and repainted, with a spinner under the header and an
"Aktualisiert." toast. The stale-data problem is real — the page only otherwise
refetches on load, and the 60-second tick just re-renders what it already has.

Touch only. Touch events *are* the feature detection: a mouse never fires them,
and on desktop the wordmark already reloads the page.

The gesture is claimed only when it starts at the very top of the document,
moves downward, is not mostly sideways, and did not start inside a dialog —
sheets scroll inside themselves. Anything else is handed straight back to the
page on the first move.

`overscroll-behavior-y: contain` on `html` suppresses the browser's own
overscroll refresh. Without it Chrome on Android arms two refreshes at once.

### Search and filters

Collapsed behind "Suchen & filtern" — the front page is about events, not about
searching. Opening reveals a search box and the twelve most-used tags.

**Closing resets both.** A hidden filter that is still applied would shrink the
list with nothing on screen to explain it.

## Event detail

Opens as a dialog, deep-linkable at `#/event/<id>`.

Shows the poster (tap for full size), date/time, series span, location, link,
description, tags, and:

- **❤ Like** and **✋ Ich bin dabei** with counts
- **📅 Zum Kalender** — downloads a single `.ics` for that occurrence
- **↗ Teilen** — native share sheet, or copies the link
- **✎ Bearbeiten** / **🗑 Löschen** — separated from the social row so deleting
  is never a mis-tap away from liking

### Comments

Ordinary comments, keyed to the series rather than an individual occurrence.

When an event is **live or within 24 h**, the section becomes a highlighted
**"Live-Updates"** panel with a prompt to post what's happening — that was the
point of the feature.

## Repeating events and series

See [recurrence.md](recurrence.md). In short: weekly / every two weeks / monthly
with an optional end date, or a list of arbitrary dates. Editing or deleting any
occurrence affects the whole series, and the UI says so.

## Calendar subscription

"Abonnieren" gives a `webcal://` one-tap link, a copyable URL, per-app
instructions, and a one-off download. See [calendar-feed.md](calendar-feed.md).

## Operator notifications

Not visible on the site: every event added, edited or removed goes into a digest
emailed to the operator at 09:00 the next morning, so an open board with no
login and no undo is not also a silent one. See
[notifications.md](notifications.md).

## Behaviour worth knowing

- Clicking the **rosencri.me** wordmark reloads the site and clears any deep link.
- Light and dark themes follow the OS.
- Fully keyboard operable; dialogs are real `<dialog>` elements.
- `prefers-reduced-motion` disables the animations.
- Works offline-ish: with no backend the site still runs and stores locally,
  showing a banner that data is not shared.
