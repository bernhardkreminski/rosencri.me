# Poster OCR

`assets/js/ocr.js` turns a photo of a poster into event fields. It runs
**entirely in the browser** — the image is never uploaded for text extraction.

## Honest summary

On a **printed** poster it does well: title, date, time, venue, URL, tags.

On a **hand-lettered** poster — which is most of what this scene puts up — expect
title, date and URL, and expect to type the time and venue yourself. This is a
property of the recogniser, not a bug to be fixed by tuning. The review screen
exists because of it.

## Why the naive approach fails

Tesseract's default page segmentation **silently drops the largest line** on a
page when it is surrounded by much smaller text. On the reference poster the
headline `JAHRESFEST` never reached the parser at all, so the title fell through
to a band name — the result was `"Resfest"`.

The font was never the problem. Cropping the headline by hand and scaling it 2×
reads it immediately. The problem is **layout analysis** on a page mixing a 270px
headline with 40px body text in three ink colours.

## How it actually works

A **multi-variant ensemble**, all on one reused worker:

1. **Preprocess** — downscale/upscale to a 2600px long edge. At the previous
   1600px almost nothing was readable; this single change recovered the date and
   the URL.
2. **Build variants** of the same image:
   - plain greyscale
   - one mask per dominant **ink colour** (hue clusters of saturated pixels)
   - a **light-ink mask** (`value > 0.80, saturation < 0.22`) for pale text on a
     saturated background — cream-on-red is invisible to the colour masks,
     because there the background colour *is* the ink
3. **Run a prioritised pass list** (variant × page-segmentation mode).
4. **Merge** lines across passes: de-duplicate by bounding-box overlap or text
   equality, keep the higher-confidence reading, splice fragments that share a
   substring.
5. **Parse** the merged lines into fields.

The headline only survives because of step 4: one mask yields `JAHRE`, another
yields `AHRESFEST`, and the splice produces `JAHRESFEST`. **No single pass ever
produces the full title.**

Colour masks are skipped on near-monochrome images, so a plain scan runs three
passes in ~1.5 s instead of seven in ~5 s.

## Parsing rules

German-first. Dates: `25.07.2026`, `25.7.26`, `25.07.` (year inferred),
`Samstag, 25.07.2026`, `1. August 2026`, ISO. Times: `ab 16 Uhr`, `16:00`,
`20h`, ranges, and `Beginn` preferred over `Einlass` when both appear.

Title is the tallest confident line, excluding boilerplate (`Eintritt`,
`Vorverkauf`, `Live Musik`, weekday and month names …). Venue comes from
`Ort:`/`@`/`im`/`in der` markers, postcode+city, or a known-venue keyword —
but a keyword match is rejected if the line reads as an enumeration, because
`Biergarten - Fassbrause - Steckerlfisch` is a food list, not a venue.

Tags are matched against a genre keyword list over the **widest** evidence: the
raw text of *every* pass, before merging and filtering. A fragment can be too
garbled to publish in a description while still being perfectly good proof that
"Post-Punk" appears on the poster.

The description gets the **narrow** set: noise-filtered, de-duplicated, and with
anything already used as title/date/url removed.

## What it cannot read

Measured on the reference poster (`vetternWIRTSCHAFT` Jahresfest):

| | Result |
|---|---|
| Title, date, URL, printed body text | ✅ |
| `ab 16 Uhr` — small, rotated, inside a badge | ❌ absent from all seven passes |
| `vetternWIRTSCHAFT` — a drawn logo, not type | ❌ only 2–4 char garbage |

Note it is not deterministic: some live scans *have* captured `WIRTSCHAFT`.
Treat these as "unreliable", not "impossible".

Closing this gap needs a vision model, not more Tesseract tuning. That was
offered and declined in favour of staying free and dependency-light — see
[decisions.md](decisions.md#tesseract-only).

## Testing it

`dev/ocr-playground.html` — drop an image, see progress, fields, confidence and
raw text, plus a built-in parser test suite.

**Test against real photographs.** Synthetic posters drawn on a canvas in a
clean font pass easily and prove nothing; that mistake is what let `"Resfest"`
ship in the first place.
