# Deployment

## 1. Enable GitHub Pages

1. Go to the repo's **Settings → Pages**.
2. Under **Build and deployment → Source**, select **Deploy from a branch**, then branch `main` / folder `/ (root)`.
3. Push to `main` — GitHub publishes the site automatically. There is no build step.

> **Why branch-based and not "GitHub Actions"?** The hourly `calendar.yml` workflow commits a
> refreshed `calendar.ics` back to `main` with `[skip ci]`, which deliberately does *not* trigger
> other workflows. Branch-based publishing redeploys on every commit regardless, so calendar
> updates actually reach the live feed. An Actions-based Pages source would silently skip them.

Once deployed, the site is available at:

```
https://bernhardkreminski.github.io/rosencri.me/
```

## 2. Repo secrets for the calendar workflow

The hourly `calendar.ics` rebuild needs Supabase credentials as repo secrets, not committed config. Using the [GitHub CLI](https://cli.github.com/):

```bash
gh secret set SUPABASE_URL
gh secret set SUPABASE_ANON_KEY
```

Each command prompts for the value interactively (or pipe it in with `--body`). These become available to the workflow as `${{ secrets.SUPABASE_URL }}` / `${{ secrets.SUPABASE_ANON_KEY }}`.

## 3. Verify the deploy

- **Actions tab**: confirm the Pages workflow run is green.
- **Site check**: open the live URL and confirm events load.
- **Calendar check**: confirm `https://bernhardkreminski.github.io/rosencri.me/calendar.ics` returns a valid `.ics` file, and that it's being refreshed — check the "regenerate calendar.ics" workflow runs on its hourly schedule in the Actions tab.

## 4. Custom domain (optional): `rosencri.me`

`.me` is a real top-level domain — this section assumes you already own `rosencri.me` through a registrar. Registering it is out of scope here.

1. **Add a `CNAME` file** to the repo root containing exactly:

   ```
   rosencri.me
   ```

   (GitHub Pages writes this automatically if you set the custom domain in the Pages UI instead — either works, but keep only one source of truth.)

2. **DNS records**, at your domain registrar / DNS provider:

   For the apex domain (`rosencri.me`), add four `A` records:

   ```
   185.199.108.153
   185.199.109.153
   185.199.110.153
   185.199.111.153
   ```

   And the equivalent `AAAA` records for IPv6:

   ```
   2606:50c0:8000::153
   2606:50c0:8001::153
   2606:50c0:8002::153
   2606:50c0:8003::153
   ```

   For the `www` subdomain, instead add a `CNAME` record:

   ```
   www → bernhardkreminski.github.io
   ```

3. Back in **Settings → Pages**, enter `rosencri.me` as the custom domain and wait for DNS to verify.
4. Once verified, check **Enforce HTTPS**.

## 5. Subscribing to the calendar

The feed lives at `webcal://bernhardkreminski.github.io/rosencri.me/calendar.ics` (or `https://.../calendar.ics` if a client doesn't support the `webcal://` scheme). Subscribing keeps it in sync — clients periodically re-fetch it rather than importing a one-time snapshot.

- **iOS**: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar → paste the `webcal://` URL.
- **macOS (Calendar app)**: File → New Calendar Subscription → paste the `webcal://` URL → Subscribe.
- **Google Calendar**: on the web, "Other calendars" → **+** → "From URL" → paste the URL (use the `https://` form) → Add calendar.
- **Outlook**: Add calendar → "Subscribe from web" → paste the URL (use the `https://` form) → Import.
