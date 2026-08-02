# Change notifications

An email to the operator whenever an event is **added, edited or removed**.

Anyone can change anything on this board and nothing is attributed
([decisions.md](decisions.md#open-permissions)). Without a notification the
first sign that someone emptied the calendar is opening the site and finding it
empty. This closes that gap without adding a login, a server or an account.

---

## How it works

```
.github/workflows/notify.yml        4 morning slots, sends once
        │
        ▼
scripts/notify-changes.mjs
        │  GET events (published, anon key)  ──►  Supabase
        │  compare against .github/notify-state.json
        │  nothing changed ──► exit, no mail, no commit
        ▼
scripts/smtp.mjs  ──►  your SMTP provider  ──►  your inbox
        │
        ▼
commit .github/notify-state.json  [skip ci]
```

`events` has no `updated_at` column, so the database cannot be asked *what*
changed. Each run therefore stores a snapshot of the tracked columns per event
and diffs it against the previous run's. The snapshot lives in
`.github/notify-state.json`, committed by the workflow — it contains only what
the website already shows publicly, and never the recipient address.

**The very first run sends nothing.** With no previous state everything would
look new, so that run records a baseline and stops.

The state file also carries `lastMailedOn`, which is what keeps the daily digest
to one mail a day — see [Cadence](#cadence).

## Setting it up

Four repository secrets, plus two optional ones. `SUPABASE_URL` and
`SUPABASE_ANON_KEY` are already set for `calendar.yml`.

| Secret | Value |
|---|---|
| `NOTIFY_TO` | where the mail goes |
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_USER` | the mailbox to send from |
| `SMTP_PASS` | an **app password**, never the account password |
| `SMTP_PORT` | optional, `465` (default) or `587` |
| `SMTP_FROM` | optional, defaults to `SMTP_USER` |

With [the GitHub CLI](https://cli.github.com/):

```sh
gh secret set NOTIFY_TO
gh secret set SMTP_HOST --body "smtp.gmail.com"
gh secret set SMTP_USER
gh secret set SMTP_PASS
```

Omitting `--body` prompts for the value instead of putting it in your shell
history — worth doing for all four, since the recipient address is the one thing
this feature exists to keep out of the repo.

### Gmail

Gmail rejects account passwords over SMTP. With 2-step verification on, create
an app password at <https://myaccount.google.com/apppasswords> and use it as
`SMTP_PASS`. `SMTP_HOST=smtp.gmail.com`, port `465`, `SMTP_USER` = the full
address. `SMTP_FROM` must be that same address or one of its verified aliases;
Gmail rewrites or refuses anything else.

Any provider works — the client speaks plain SMTP submission on 465 (implicit
TLS) or 587 (STARTTLS). There is no unencrypted path: a server offering neither
is refused rather than sent a password in the clear.

## Checking it without waiting

**Actions → Notify on event changes → Run workflow**, with *dry run* ticked:
the mail is printed to the job log instead of sent, and the snapshot is left
alone so the next real run still reports the same changes.

Locally:

```sh
NOTIFY_DRY_RUN=1 \
SUPABASE_URL=… SUPABASE_ANON_KEY=… \
NOTIFY_STATE_PATH=/tmp/state.json \
node scripts/notify-changes.mjs
```

Run it once to write the baseline, edit an event on the site, run it again.
`SMTP_DEBUG=1` traces the SMTP conversation (credentials are never traced) —
that trace is the only practical way to see why a provider is unhappy.

## Cadence

**One digest per day, at 09:00 in Rosenheim.** Everything that changed since the
last mail arrives together, so a busy evening is one mail the next morning, not
six that night.

Hitting 09:00 local takes two pieces, because GitHub cron is UTC and does not
follow DST — `0 7 * * *` is 09:00 in summer but 08:00 in winter:

- the workflow fires **four candidate slots**, `0 7,8,9,10 * * *`
- the script sends on the **first slot at or after 09:00 local**, and records
  the date in `lastMailedOn` so the remaining slots do nothing

|  | 07 UTC | 08 UTC | 09 UTC | 10 UTC |
|---|---|---|---|---|
| summer (CEST) | **09:00 → sends** | 10:00 skip | 11:00 skip | 12:00 skip |
| winter (CET) | 08:00 too early | **09:00 → sends** | 10:00 skip | 11:00 skip |

The spare slots are not waste. GitHub starts scheduled jobs late under load, and
a run that slips past its hour is simply caught by the next one — the `>= 09:00
and not yet today` rule makes late runs harmless instead of missed.

A **manual dispatch ignores the gate entirely** and sends whatever is pending.
`NOTIFY_DIGEST_HOUR` is only set for `schedule` events.

**Consequence worth knowing:** a change made at 09:05 is reported the *next*
morning. If a change lands on a day when no digest went out, it is mailed at the
next slot that day. To go back to near-real-time, drop `NOTIFY_DIGEST_HOUR` from
the workflow and set the cron to `*/30 * * * *`.

## What the mail says

Subject is the change when there is one (`rosencri.me: neues Event „…"`), or a
count when there are several. Each event gets a card — colour-coded green for
added, amber for edited, red for removed — with its date, venue, the person who
entered it, a button through to the event, and for an edit the changed fields
struck through as `before → after`.

It is sent as `multipart/alternative`: a plain-text part first, then HTML. A
client picks the last part it can render, so HTML wins where it is supported and
the text version is what lands in a terminal mail reader or a notification
preview. Both are generated from the same diff.

The HTML is deliberately old-fashioned — tables, inline styles, no images, no
external assets, no `<style>` block. Gmail strips embedded stylesheets, blocks
remote content by default, and ignores flexbox and grid. It also carries its own
`<meta charset="utf-8">`: the MIME header already declares the encoding, but a
client that extracts and re-renders the HTML falls back to guessing without it,
and every umlaut arrives as mojibake.

To look at it without sending, point a dry run at a file and open it:

```sh
NOTIFY_DRY_RUN=1 NOTIFY_DUMP_HTML=/tmp/mail.html \
SUPABASE_URL=… SUPABASE_ANON_KEY=… NOTIFY_STATE_PATH=/tmp/state.json \
node scripts/notify-changes.mjs
```

Deletions have no working link, so they don't get one. They also carry a caveat:
the browser reads with the anon key, RLS exposes only published rows, so an
event **hidden** from the dashboard is indistinguishable from a deleted one.
The mail says both rather than picking one.

## Failure behaviour

| Situation | What happens |
|---|---|
| Secrets not set | Job succeeds, logs that it skipped. Nothing breaks before setup. |
| Supabase unreachable | Job **fails**, state untouched, next run retries. |
| SMTP rejects the mail | Job **fails**, state untouched — the change is reported next run rather than lost. |
| State file missing or from an older format | Silently re-baselines. No mail. |
| Every morning slot delayed past 10:00 local | That day's digest is skipped; the changes go out the next morning. |
| Push rejected (`calendar.yml` pushed first) | Rebase and retry, three attempts. |

The state file is only written **after** the mail is accepted. That ordering is
the whole failure design: a crash can produce a duplicate notification, never a
missing one.

## Adding a column

`TRACKED` in `scripts/notify-changes.mjs` is an explicit allowlist, exactly like
the mappers in `store.js` and `build-ics.mjs`, and carries the same hazard: a new
column added everywhere *but* here is silently never reported. See
[pitfalls.md](pitfalls.md#explicit-allowlists-drop-new-fields).

## Why not something instant

A Supabase database webhook firing an Edge Function would mail within seconds
instead of the next morning. It was declined for the same reason as everything
else here: it needs a deploy step (`supabase functions deploy`), an HTTP mail
provider's account and API key, and secrets living in a second place. Polling
reuses the workflow, the runner and the Supabase secrets that already exist, and
a community noticeboard does not change often enough to notice the difference.

**To revisit:** a `pg_net` trigger or an Edge Function on `events`, with the
recipient and API key as Supabase secrets. The diffing here would become
unnecessary — the trigger knows `OLD` and `NEW`.
