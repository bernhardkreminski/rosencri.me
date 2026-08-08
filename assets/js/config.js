/**
 * rosencri.me — configuration
 *
 * This file is the ONLY place you need to touch to point the site at a backend
 * or to get rid of the demo data.
 */

/* ------------------------------------------------------------------------- *
 * Backend (Supabase)
 *
 * Paste your project URL and the public API key here — labelled *anon public*
 * on older projects, *publishable* (`sb_publishable_…`) on newer ones. Both are
 * safe to ship in a public repository: this key only ever grants what the Row
 * Level Security policies in `supabase/schema.sql` allow. The *secret* /
 * *service_role* key bypasses RLS and must never appear in this file.
 *
 * Leave them empty and the site transparently falls back to browser-local
 * storage — everything still works, but data stays on the device.
 * ------------------------------------------------------------------------- */
export const SUPABASE_URL = 'https://pyftcvikhuzleqxjsecn.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Nc8I0WcFkrfZKqoRGEBYJQ_1opGv3oG';

/** Storage bucket that poster photos are uploaded to. */
export const SUPABASE_BUCKET = 'posters';

/* ------------------------------------------------------------------------- *
 * Demo data
 *
 * Set to `false` to remove the five example events from the site. That is the
 * whole removal procedure — no other change needed. See README.md.
 * ------------------------------------------------------------------------- */
export const SHOW_SEED_EVENTS = false;

/* ------------------------------------------------------------------------- *
 * Site
 * ------------------------------------------------------------------------- */
export const SITE_NAME = 'rosencri.me';
export const SITE_TAGLINE = 'Subkultur-Events in Rosenheim';

/** Public base URL, used for iCal links and share URLs. */
export const SITE_URL = 'https://rosencri.me/';

/** Path of the subscribable calendar feed, relative to SITE_URL. */
export const ICS_PATH = 'calendar.ics';

/** An event counts as "approaching" (and gets highlighted) within this window. */
export const SOON_WINDOW_HOURS = 24;

/** Assumed duration when an event has no end time. */
export const DEFAULT_DURATION_HOURS = 3;

/** Max upload size for poster images, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/* ------------------------------------------------------------------------- *
 * Poster reading (OCR)
 *
 * Two engines. The `ocr-extract` Supabase Edge Function runs a vision model
 * server-side and reads posters far better than anything that fits in a
 * browser; Tesseract.js stays on the device as the fallback and runs whenever
 * the function is disabled, unreachable, over quota, or the visitor is offline.
 *
 * Setting this to `false` restores the original behaviour exactly: on-device
 * only, nothing ever leaves the browser. Do that if the function's API key is
 * unset or you want the privacy property back — nothing else needs changing.
 *
 * NOTE: with this enabled, the poster image IS sent to a third party for
 * reading. That is a change from the site's original promise and is documented
 * in documentation/ocr.md and in the privacy page.
 * ------------------------------------------------------------------------- */
export const OCR_VISION_ENABLED = true;

/** Edge Function slug; resolved against SUPABASE_URL. */
export const OCR_FUNCTION_NAME = 'ocr-extract';

/**
 * Longest the browser waits for the vision call before giving up and running
 * Tesseract instead. The function itself may take a few seconds on a large
 * image; beyond this the on-device path will finish sooner.
 */
export const OCR_VISION_TIMEOUT_MS = 25000;
