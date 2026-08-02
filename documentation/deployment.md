# Deployment

## Where it runs

| | |
|---|---|
| Host | GitHub Pages, **deploy from branch** `main`, folder `/` |
| Domain | `rosencri.me` via the `CNAME` file, HTTPS enforced |
| DNS | Namecheap: four apex `A` records to GitHub Pages, `www` `CNAME` to `<user>.github.io` |
| Backend | Supabase project (EU / Frankfurt) |

`www` and the old `github.io` address both 301 to the apex.

## Shipping a change

```bash
# 1. Stamp a new cache-busting version across the whole module graph
node scripts/bump-assets.mjs

# 2. Commit and push — Pages redeploys on every commit to main
git add -A && git commit -m "…" && git push
```

**Step 1 is mandatory** for anything under `assets/`. Skipping it means visitors
keep the old file for up to ten minutes; doing it *partially* is worse than not
doing it at all, because a fresh entry point plus cached modules produces a blank
page. This is the single most dangerous footgun in the repo —
[pitfalls.md](pitfalls.md#partial-cache-busting-blanks-the-site).

Pages usually publishes within a minute. Verify against the live site, not
localhost:

```bash
curl -s https://rosencri.me/ | grep -o 'app.js?v=[0-9A-Z]*'
```

The generated `calendar.ics` frequently conflicts on rebase. It is a build
artifact: regenerate it, `git add`, continue.

```bash
node scripts/build-ics.mjs && git add calendar.ics && git rebase --continue
```

## Why branch-based Pages

The hourly calendar workflow commits `calendar.ics` back to `main` with
`[skip ci]`, which deliberately does not trigger other workflows. Branch-based
publishing redeploys on **every** commit regardless, so feed updates actually
reach the site. An Actions-based Pages source would silently skip them.

## Secrets

Two repository secrets, `SUPABASE_URL` and `SUPABASE_ANON_KEY`, let the hourly
job read events. Without them the workflow still succeeds — it just builds an
empty feed.

The same public key is in `assets/js/config.js` and is *meant* to be public: it
is shipped to every visitor's browser and can never bypass Row Level Security.
Its real blast radius is documented in [operations.md](operations.md#what-the-public-key-can-do).

**Never** put a `service_role` / `sb_secret_` key anywhere in this repo. That one
bypasses RLS entirely and belongs only in the Supabase dashboard.

## Setting this up elsewhere

1. Create a Supabase project; run `supabase/schema.sql` in its SQL editor.
2. Put the project URL and public key into `assets/js/config.js`.
3. Add the same two values as repository secrets.
4. Enable Pages: Settings → Pages → Deploy from a branch → `main` / `/`.
5. For a custom domain: `CNAME` file, DNS records, then tick **Enforce HTTPS**.

Leaving the credentials empty is supported — the site falls back to
browser-local storage and shows a banner.

## Permissions note

A fine-grained GitHub token needs **Pages: write** to enable Pages via the API
and **Secrets: write** to set secrets. Without those the API returns 403 and both
steps have to be done in the web UI.
