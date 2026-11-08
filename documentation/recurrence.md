# Repeating events and series

Two mechanisms, both RFC 5545, both stored on the single event row.

| Field | Covers | Example |
|---|---|---|
| `rrule` | regular patterns | `FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T220000Z` |
| `rdates` | arbitrary dates | `['2026-08-19T18:00:00+02:00', …]` |

They are independent — an event may have either, both, or neither.

## Why both

A rule cannot express an irregular run. "Feierabendkonzert mit Fabi Mägel" is on
05.08., 19.08., 16.09., 30.09. — gaps of 14, 28 and 14 days. No `FREQ`/`INTERVAL`
fits, so those dates are listed explicitly.

## The form

"Wiederholung" offers: Einmalig · **Mehrere Termine (eigene Daten)** · Jeden Tag ·
Jede Woche · Alle 2 Wochen · Jeden Monat · **Jeden x. Wochentag** · **Jeden
letzten Wochentag**. Picking a rule reveals an optional end date; picking
"Mehrere Termine" reveals a list of date rows with add/remove.

### Monthly on a weekday

"Jeden Monat" repeats the day of month (the 5th). For "the first Thursday" the
select offers options **derived from the start date** — `monthlyWeekdayRules()`
in `recurrence.js` — instead of separate ordinal/weekday pickers:

| Start date | Options added | Stored as |
|---|---|---|
| Thu 05.11.2026 | Jeden 1. Donnerstag | `FREQ=MONTHLY;BYDAY=1TH` |
| Thu 26.11.2026 | Jeden 4. Donnerstag · Jeden letzten Donnerstag | `BYDAY=4TH` / `BYDAY=-1TH` |

"letzten" is only offered in the last seven days of a month, where the date is
both the 4th (or 5th) and the last of its weekday — only the author knows which
is meant. Changing the start date rebuilds the options and keeps the chosen kind;
a "letzten" that no longer fits falls back to the ordinal.

Deriving the rule from the start keeps DTSTART on the rule, which RFC 5545
expects. A 5th weekday skips months that have none, like the 31st does.

On save, extra dates are sorted, de-duplicated, and any date equal to the start
is dropped — a repeated first occurrence makes some calendar clients show the
event twice that day.

## One row, many occurrences

`starts_at` is always the **first** occurrence and is never repeated in `rdates`.

`recurrence.js` materialises a series for display only:

```js
expandAll(store.series) // → store.events
```

Window: 60 days back, 400 days forward, hard-capped at 400 occurrences. If a
series' every occurrence is in the past but the rule is open-ended, the next one
is still produced, so a weekly event never silently vanishes.

The occurrence cap only actually bites for `FREQ=DAILY` — it is the only rule
dense enough to reach 400 occurrences before the 400-day window ends. A daily
series that started before the window fills the cap about 340 days out (400 days
counted from `now - 60`), so the month grid stops showing it ~2 months short of
the other rules. The list view is unaffected either way — it collapses a series
to a single card.

The published `.ics` does **not** expand anything — it ships the rule and lets
the calendar client expand it. That is what makes a subscription show a genuine
repeat rather than fifty copies.

## Occurrence identity

Generated occurrences get `id = '<seriesId>::<startMs>'`, plus `seriesId` and
`occurrence` fields.

**Every database call must resolve to the series id first** via `seriesIdOf()`.
An occurrence id fails the UUID check, and the store would silently fall back to
local-only storage. Likes, RSVPs and comments therefore attach to the *series* —
liking "the weekly Vokü" is not per-week bookkeeping.

## Editing and deleting

Both act on the whole series, because there is only one row:

- Editing from **any** occurrence loads the **series' own start date**, not the
  date that was clicked. Loading the clicked date would silently reschedule the
  entire series on save.
- The delete prompt changes to "Ganze Serie löschen?" and spells out that all
  dates go.
- Changing the pattern re-expands immediately — weekly → biweekly halves the
  occurrences on the spot.

There is **no per-occurrence override**: you cannot move or cancel a single date
of a series. Doing so would need `EXDATE` plus override rows. If you need it,
the current workaround is to end the series early and add the exception as its
own event.

## Labels

`describeSchedule(event)` from `ical.js` returns "Jede Woche", "Alle 2 Wochen",
"Jeden 1. Donnerstag im Monat", "4 Termine", "Jede Woche + 2 weitere Termine", or `''`.

`seriesSpan(event)` from `recurrence.js` returns `{first, last}` for the
"von … bis …" line. `last` is **null for an open-ended rule** — a weekly event
with no `UNTIL` never stops, so the UI says "ab <date>" rather than inventing an
end.

> Both must be called with the **stored row**, never an occurrence. An
> occurrence's own start matches one of its `rdates`, which de-duplication then
> drops, so a four-date series reads "3 Termine" on every tile but the first.
> Use `store.getSeries(id)`.
