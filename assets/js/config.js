/**
 * rosencri.me — configuration
 *
 * This file is the ONLY place you need to touch to point the site at a backend
 * or to get rid of the demo data.
 */

/* ------------------------------------------------------------------------- *
 * Backend (Supabase)
 *
 * Paste your project URL and the *anon public* key here. Both are safe to ship
 * in a public repository: the anon key only ever grants what the Row Level
 * Security policies in `supabase/schema.sql` allow.
 *
 * Leave them empty and the site transparently falls back to browser-local
 * storage — everything still works, but data stays on the device.
 * ------------------------------------------------------------------------- */
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

/** Storage bucket that poster photos are uploaded to. */
export const SUPABASE_BUCKET = 'posters';

/* ------------------------------------------------------------------------- *
 * Demo data
 *
 * Set to `false` to remove the five example events from the site. That is the
 * whole removal procedure — no other change needed. See README.md.
 * ------------------------------------------------------------------------- */
export const SHOW_SEED_EVENTS = true;

/* ------------------------------------------------------------------------- *
 * Site
 * ------------------------------------------------------------------------- */
export const SITE_NAME = 'rosencri.me';
export const SITE_TAGLINE = 'Subkultur-Events in Rosenheim';

/** Public base URL, used for iCal links and share URLs. */
export const SITE_URL = 'https://bernhardkreminski.github.io/rosencri.me/';

/** Path of the subscribable calendar feed, relative to SITE_URL. */
export const ICS_PATH = 'calendar.ics';

/** An event counts as "approaching" (and gets highlighted) within this window. */
export const SOON_WINDOW_HOURS = 24;

/** Assumed duration when an event has no end time. */
export const DEFAULT_DURATION_HOURS = 3;

/** Max upload size for poster images, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
