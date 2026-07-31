#!/usr/bin/env node
// scripts/bump-assets.mjs
//
// Stamps one cache-busting version onto index.html AND onto every relative
// import inside assets/js/*.js.
//
// Why this exists
// ---------------
// GitHub Pages serves assets with `max-age=600`. Versioning only the entry
// point (`app.js?v=N`) is worse than versioning nothing: the browser fetches a
// fresh app.js whose static `import './util.js'` still resolves to the cached
// copy. If the new code uses an export the cached module doesn't have yet, the
// module graph fails to load and the page renders *nothing* — a blank site,
// not a degraded one, for up to ten minutes. That happened twice here, with
// `formatDateShort` and then `seriesSpan`.
//
// Stamping the same version through the whole graph means a deploy either
// serves all-new or all-old modules, never a mix.
//
// Usage:  node scripts/bump-assets.mjs [version]
//         (defaults to a UTC timestamp, e.g. 20260731T1042)

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = path.join(REPO_ROOT, 'assets', 'js');

const version = process.argv[2] || new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);

/** `'./util.js'` / `'./util.js?v=old'` → `'./util.js?v=<version>'` */
const stamp = (src) =>
  src.replace(/(['"])(\.\/[\w.-]+\.js)(\?v=[^'"]*)?\1/g, `$1$2?v=${version}$1`);

const files = (await readdir(JS_DIR)).filter((f) => f.endsWith('.js'));
let touched = 0;

for (const file of files) {
  const full = path.join(JS_DIR, file);
  const before = await readFile(full, 'utf8');
  const after = stamp(before);
  if (after !== before) {
    await writeFile(full, after);
    touched++;
  }
}

const htmlPath = path.join(REPO_ROOT, 'index.html');
const html = await readFile(htmlPath, 'utf8');
const nextHtml = html
  .replace(/(assets\/css\/style\.css)(\?v=[^"']*)?/g, `$1?v=${version}`)
  .replace(/(assets\/js\/app\.js)(\?v=[^"']*)?/g, `$1?v=${version}`);
await writeFile(htmlPath, nextHtml);

console.log(`[bump-assets] version=${version} — ${touched} module file(s) restamped, index.html updated`);
