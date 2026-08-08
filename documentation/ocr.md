# Poster OCR

Turning a photo of a poster into event fields. Two engines:

| | |
|---|---|
| **Primary** | Google Gemini, called by the `ocr-extract` Supabase Edge Function |
| **Fallback** | Tesseract.js in the browser, exactly as before |

`extractEventFields()` in `assets/js/ocr.js` is the entry point. It tries the
function, and falls back to Tesseract on **disabled, offline, over-quota, bad
key, upstream outage** — everything except a user cancellation, because running
a second 30-second engine after someone closes the dialog is the opposite of
what they asked for.

Set `OCR_VISION_ENABLED = false` in `assets/js/config.js` to restore the
original browser-only behaviour. Nothing else needs changing.

## The image now leaves the device

This is a real change, and it is the cost of the accuracy below. The
[privacy page](../datenschutz.html#texterkennung) and the upload dialog both say
so plainly. Two things worth keeping in mind:

- Google's **free** tier uses submitted content to improve its products and
  models. Only the paid tier carries a no-training commitment. The board's own
  guidance is therefore: scan posters that are already hanging in public.
- The request is made by the Edge Function, not the browser, so Google gets the
  image but not the visitor's IP address.

## Why this was necessary

`dev/ocr-batch.html` scores both engines against `dev/ocr-fixtures.js` — six
images that are live on the board, hand-transcribed from the originals.

| Engine | Score | Wall clock, all six |
|---|---|---|
| Tesseract, before this work | 16/43 | ~150 s |
| Tesseract, with the parser fixes below | 19/43 | ~150 s |
| **Gemini via `ocr-extract`** | **43/43** | **~15 s** |

The browser-only failures were not the kind more tuning reaches:

| Image | What happened |
|---|---|
| H3CKE (hand-lettered) | 71 seconds, **no date and no time at all** |
| Kultur-Strand | title read as `“x Live-Acts Open Amr <<,`; `Start 17:00` sits in a small rotated badge and was never seen |
| Freiluftkino (programme table) | title `I 7`; venue `Himmel 13.8. Steckerifischfiasko` — a film title fused with a date |
| Flohmarkt am Stoa (screenshot) | start time **22:42 — the phone's status-bar clock** |
| Alpinflohmarkt (screenshot) | title `il`; an unrelated advert above the post leaked into the description |
| Fabi Maegel (website screenshot) | took `19.08.` from "Weitere Termine" as the event date |

Four of six lost their title at the recogniser. Those are two distinct
problems — **recognition** (Tesseract cannot read hand-lettering, rotated
badges or dense tables) and **comprehension** (knowing a status-bar clock is
not an event time, that "Weitere Termine" describes a series, that the
paragraph above the post is somebody else's advert). A vision model addresses
both; a better OCR engine only addresses the first.

This is the path `decisions.md#tesseract-only` reserved for exactly this case.

## What the model is asked for

One call, image plus a German prompt, with a JSON schema constraining the
reply. The prompt is explicit about the traps the fixtures exposed: ignore
phone and app chrome, the status-bar clock is when the screenshot was taken,
a date range is not a time range, return null rather than guess.

It returns `furtherDates` (a stated series) and `untilDate` (the last day of a
run) alongside the usual fields, plus `notes` — a sentence naming whatever it
could not read, which the review form shows instead of a generic "please check".

Two prompt rules were added after the first scored run, each fixing a real miss:

- **Programme sheets.** On the Freiluftkino programme the model returned the
  film from one row (`Michael`, 3.8.) as the whole event. It is now told that a
  table of dated rows means the event is the *run*: heading as the title,
  earliest row as `startDate`, latest as `untilDate`.
- **Instagram handles.** With no website on the flyer, the account name above
  the post is the only link there is, and it was being dropped.

Those two changes took the score from 39/43 to 43/43.

Confidence is **derived, not asked for**: a model scoring its own certainty
produces a confident-sounding number with nothing behind it. What is actually
known is whether a field came back populated, and whether a start time was
genuinely printed. A date with no time scores below the form's 0.7 threshold so
the field gets flagged rather than presenting the 20:00 stand-in as fact.

## The Tesseract fallback

Unchanged in structure — multi-variant ensemble, colour masks, cross-pass
voting; see the git history of this file for the full description. Four parser
bugs found while measuring the baseline were fixed, and they applied to *both*
engines' inputs:

1. **A date range was read as a time range.** `4.7.26 – 27.9.26` matched the
   time-range pattern as `7.26 - 27` and produced a 07:26 start. Times are now
   searched over date-masked text (`maskDates`).
2. **20:00 was invented silently.** When no time is found the form still needs a
   value, so 20:00 stands in — but confidence is now pushed under the flag
   threshold so it is always marked for review. Kultur-Strand shipped 20:00 this
   way while its poster said 17:00.
3. **The first date won.** "Weitere Termine: …" lines are now excluded from
   event-date matching and parsed into repeat dates instead.
4. **A headline containing a date was discarded whole.** "Save the Date
   alpinflohmarkt: 25. Oktober" was rejected as a title candidate for matching
   a date pattern, so the title fell through to the Instagram handle below it.
   Dates are now stripped from the candidate instead.

Screenshot chrome is filtered by **content, not position**. A fixed top/bottom
band was tried first and was actively harmful — it removed the Fabi Maegel
headline (7% down the page) and the Alpinflohmarkt opening hours (~90% down).
Real posters put real content hard against both edges.

## Abuse control, and its limits

The function calls a metered API with a key we hold, and the board has no login,
so there is no one to attribute a request to. Two layers: a 4 MB image cap, and
a per-IP daily quota counted in `public.ocr_usage` (`OCR_DAILY_IP_QUOTA`,
default 40).

The quota check **fails open** — if the counter table is unreachable the request
proceeds, because losing OCR entirely is worse than briefly losing the ceiling.

This stops a runaway loop and a casual scraper. It does **nothing** against a
distributed attacker with many IPs. Closing that needs a captcha
(Cloudflare Turnstile is free and would fit), which is deliberately not built
yet — the exposure is a free-tier quota, not money.

## Testing it

```bash
python3 -m http.server 8000
```

- `dev/ocr-batch.html` — scores all six fixtures. `?engine=tesseract` or
  `?engine=vision` to force one; `?only=<slug>` for a single image. Results are
  left on `window.__OCR_RESULTS__`.
- `dev/ocr-playground.html` — drop a single image, see fields and raw text.

**Test against real photographs.** Synthetic posters drawn in a clean font pass
easily and prove nothing; that mistake is what let `"Resfest"` ship originally.
Every fixture here is an image someone actually uploaded.

## Setup

See [`supabase/README.md`](../supabase/README.md) for deploying the function and
setting the key.
