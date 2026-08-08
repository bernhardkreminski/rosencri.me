# Development setup

## What you need

| Tool | Version | Needed for | Install (macOS) |
|---|---|---|---|
| **git** | any | cloning, and `git push` *is* the deploy | ships with Xcode Command Line Tools |
| **Node** | 18+ (CI pins **20**) | `scripts/*.mjs` — most importantly `bump-assets.mjs`, which is mandatory before shipping | `brew install node` |
| **Python 3** | 3.x | the local static server only | ships with macOS |

That is the entire list.

## What you do *not* need

There is **no `package.json`, no lockfile and no `npm install`**. Every script
imports Node's standard library only — `node:fs/promises`, `node:path`,
`node:url`, `node:crypto`, `node:net`, `node:tls`. Even the SMTP client is
hand-rolled (`scripts/smtp.mjs`) specifically to keep it that way.

No bundler, no transpiler, no framework CLI, no test runner. The browser loads
the ES modules exactly as they are committed. If you find yourself adding a build
step, read [decisions.md](decisions.md) first.

Python is *only* a convenient static file server. Anything that serves the repo
root over HTTP works — `npx serve`, `caddy file-server`, whatever. There is no
Python code in this project.

### Version notes

Homebrew currently installs Node 26; the workflows pin Node 20. The scripts use
nothing version-sensitive, so either is fine — don't go out of your way to match
CI. If you want to anyway, `brew install node@20` works but is keg-only and will
not land on your `PATH` without extra setup.

## Verify the setup

```bash
node --version && python3 --version && git --version
```

## Run the site

ES modules need a real HTTP origin — opening `index.html` as a `file://` path
fails at the first `import`.

```bash
python3 -m http.server 8123
```

Then open <http://localhost:8123>.

Camera capture needs HTTPS or `localhost`; browsers block `getUserMedia` on plain
HTTP origins. `localhost` counts as secure, so the local server is fine — testing
from a phone on your LAN via `http://192.168.x.x:8123` is not, and the camera
button will silently do nothing there.

`dev/ocr-playground.html` is a standalone harness for trying OCR on sample images
without touching the board.

## Running the scripts

| Script | What it needs | Runs locally? |
|---|---|---|
| `bump-assets.mjs` | nothing — no env, no network | yes |
| `build-ics.mjs` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | yes — both are public and already in [`assets/js/config.js`](../assets/js/config.js) |
| `notify-changes.mjs` | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_TO` + the Supabase pair | no — those are GitHub repository secrets and are deliberately not in the repo |

Rebuilding the calendar feed by hand:

```bash
SUPABASE_URL=https://pyftcvikhuzleqxjsecn.supabase.co \
SUPABASE_ANON_KEY=sb_publishable_Nc8I0WcFkrfZKqoRGEBYJQ_1opGv3oG \
node scripts/build-ics.mjs
```

Both scripts force `TZ=Europe/Berlin` themselves, so output does not depend on
your machine's timezone.

`notify-changes.mjs` stays a CI job. Even with the secrets to hand, running it
locally mails the operator for real and rewrites `.github/notify-state.json`,
which then makes the next scheduled run miss changes — see
[notifications.md](notifications.md). Use `NOTIFY_DRY_RUN=1` if you must.

## Before you push

```bash
node scripts/bump-assets.mjs
```

Mandatory for anything under `assets/`, and it is the one step in this repo that
breaks the live site outright when skipped or done halfway —
[pitfalls.md](pitfalls.md#partial-cache-busting-blanks-the-site). Full release
procedure in [deployment.md](deployment.md).
