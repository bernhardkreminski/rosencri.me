# Legal pages

> **Not legal advice.** This is a developer's summary of what was built and why.
> Nobody here is a lawyer. A user-generated board that accepts uploaded poster
> photographs carries real copyright and liability exposure — if the site grows
> beyond a hobby, have it reviewed properly.

Two static pages, no JavaScript, sharing `assets/css/style.css`:

```
impressum.html      operator identity + liability notices
datenschutz.html    what data is processed, by whom, and your rights
```

Both are linked from the footer of every page. That placement is the
requirement, not a stylistic choice: § 5 DDG wants them **leicht erkennbar,
unmittelbar erreichbar und ständig verfügbar**. Do not move them behind a
dialog, a hamburger menu or a route that needs JavaScript to resolve.

---

## Before this goes live

`impressum.html` and `datenschutz.html` ship with **13 placeholders** and are
worse than useless until they are filled — a visibly unfinished Impressum is
itself the thing being penalised. They render as loud red dashed boxes (`.todo`
in the stylesheet) so they cannot be missed.

```sh
grep -c 'class="todo"' impressum.html datenschutz.html   # expect 0 when done
```

| Needed | Where | Notes |
|---|---|---|
| Full name | both | No pseudonym, no band name |
| Postal address | both | **A PO box is not sufficient** — see below |
| Email address | both | Use a role address, not a personal one |
| Supabase region | `datenschutz.html` §3 | Dashboard → Settings → General → Region |
| Phone | `impressum.html` | Optional — delete the line if unused |

### The address problem

There is no way around publishing a real postal address, and for a private
person running a public site that means a home address. The usual ways out:

- a **c/o address** at a Verein, a shop, or a venue that agrees to it;
- registering an **eingetragener Verein**, which puts the Verein's address in
  the Impressum instead of yours.

An address that cannot receive post does not satisfy the requirement.

### The email problem

The Impressum email is **public by definition** — it will be scraped. Use
something like `kontakt@rosencri.me` forwarded to a real mailbox, never the
personal address used for the change notifications
([notifications.md](notifications.md)). Those two addresses serve opposite
purposes: one is published on purpose, the other is a repository secret
specifically so it stays out of the repo.

---

## Which law actually applies

Worth understanding, because the common answer is wrong for this site.

**§ 5 DDG** (Digitale-Dienste-Gesetz, which replaced § 5 TMG in May 2024) binds
*geschäftsmäßige* services — typically ones offered for payment. A genuinely
non-commercial noticeboard may fall outside it.

**§ 18 Abs. 1 MStV** (Medienstaatsvertrag) is the one that catches this site. It
requires name and address for any digital service that is **not purely personal
or familial** — which a public event board plainly is not, commercial or not.
§ 18 Abs. 2 MStV additionally wants a named person responsible for the content,
because the board carries journalistic-editorial content in the broad sense.

So: the Impressum is required here **regardless of whether money is involved**.
Both citations are kept on the page since the DDG one costs nothing and removes
the argument entirely.

The **Datenschutzerklärung** is not optional under any reading — Art. 13 DSGVO
applies the moment an IP address reaches a server, which is every page view.

---

## What the privacy policy has to disclose

Derived by reading the code, not from a template. Every external host the
browser contacts:

| Recipient | When | Sees | Section |
|---|---|---|---|
| GitHub Pages (US) | every page view | IP, user agent, referrer | §2 |
| Supabase, behind Cloudflare | every page view | IP + submitted content | §3 |
| jsDelivr, `tessdata.projectnaptha.com` | only on poster scan | IP | §5 |

Fonts and stylesheets are served from our own origin. On a normal page view the
browser contacts **no third party** other than the host and the backend.

If you add an embed, a map, an analytics snippet or a font, this table and the
page change with it.

### Google Fonts was removed {#google-fonts}

`index.html` used to load Space Grotesk from `fonts.googleapis.com` on every
visit, handing the visitor's IP address to Google before anything rendered.
**LG München I, 20.01.2022, 3 O 17493/20** awarded damages to a visitor for
exactly this, and it fuelled a wave of opportunistic warning letters.

The font is now self-hosted:

- `assets/fonts/space-grotesk-latin.woff2` (22 KB) and
  `-latin-ext.woff2` (19 KB) — one **variable** file per subset, covering
  weights 300–700, rather than three static weights;
- `@font-face` at the top of `style.css`, with the same `unicode-range` split
  Google used, so latin-ext is only fetched when a character needs it (German
  umlauts live in the latin subset, so it usually is not);
- SIL Open Font License 1.1, `assets/fonts/OFL.txt`. The licence file must stay
  with the fonts.

The privacy policy's Google section is gone and §2 now states positively that no
third-party content is loaded. Verified in a browser: the only origins a page
view touches are our own and Supabase.

The font files carry no `?v=` stamp — they are immutable, and a different font
would be a different filename. `bump-assets.mjs` does not touch them.

The OCR CDN (§5) is a much smaller version of the same issue, since it only
fires when someone actually scans a poster. Self-hosting Tesseract would mean
committing multi-megabyte binaries, which is a real trade-off rather than a
clear win.

### Why localStorage needs no consent banner

§ 25 Abs. 1 TDDDG requires consent before storing anything on a user's device —
but § 25 Abs. 2 Nr. 2 exempts what is **strictly necessary** for a service the
user explicitly requested. The keys here (`rc.identity`, `rc.likes`,
`rc.rsvps`, `rc.events`) exist so you can withdraw your own like and so a draft
survives the backend being unreachable. There is no tracking, no profiling and
no third-party cookie anywhere in the codebase.

That is why this site has **no cookie banner**, and adding one would be a
mistake rather than extra safety — it would ask for consent that is not needed.
Introducing any analytics tool changes this analysis completely.

---

## What was deliberately left out

Standard German Impressum boilerplate is full of items that are folklore,
obsolete, or actively wrong. None of these appear:

**The "LG Hamburg 1998" link disclaimer.** The paragraph beginning *"Mit Urteil
vom 12. Mai 1998 hat das Landgericht Hamburg entschieden…"* is copy-pasted
across the German web and has no legal effect whatsoever. It misstates the
ruling, and a blanket disclaimer cannot displace §§ 7–10 DDG. What actually
limits liability is the host-provider privilege plus acting promptly on notice —
which is why the page gives a **reporting address** instead.

**The EU online dispute resolution link.** The ODR platform at
`ec.europa.eu/consumers/odr` was **shut down on 20 July 2025**. Linking a dead
platform is now a defect rather than compliance. It would not have applied
anyway: no contracts are concluded here.

**A VSBG § 36 arbitration statement.** Applies to businesses with consumer
contracts. There are none.

**USt-IdNr., Handelsregister, Berufsaufsichtsbehörde.** Only for businesses,
registered entities and regulated professions.

---

## What is genuinely load-bearing

For a board where **anyone can post anything with no login**, the sections that
matter are not the disclaimers — they are:

1. **The reporting address** (`impressum.html`, "Von Nutzerinnen und Nutzern
   eingetragene Inhalte"). Host-provider privilege under §§ 8–10 DDG holds only
   until you have knowledge of a violation. A working, monitored contact and
   prompt removal is the actual protection.
2. **The "ohne Gewähr" note on event data.** Times and venues are user-entered
   and partly OCR-guessed, and people plan evenings around them.
3. **The warning not to enter third-party personal data** (`datenschutz.html`
   §3). Anything typed in is public, in the `.ics` feed, and editable by anyone.

If a takedown request arrives, [operations.md](operations.md) covers hiding a
row via the Supabase dashboard — `status = 'hidden'` rather than deleting, so
there is a record of what was removed.
