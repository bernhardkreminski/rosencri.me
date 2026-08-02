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

// Every HTML page at the repo root, not just index.html. impressum.html and
// datenschutz.html link the same stylesheet: leaving them on an older `?v=`
// serves them whatever style.css is cached under that key, which is how a legal
// page ends up rendering unstyled for ten minutes after a deploy.
const htmlFiles = (await readdir(REPO_ROOT)).filter((f) => f.endsWith('.html'));
for (const file of htmlFiles) {
  const full = path.join(REPO_ROOT, file);
  const html = await readFile(full, 'utf8');
  const next = html
    .replace(/(assets\/css\/style\.css)(\?v=[^"']*)?/g, `$1?v=${version}`)
    .replace(/(assets\/js\/app\.js)(\?v=[^"']*)?/g, `$1?v=${version}`);
  if (next !== html) await writeFile(full, next);
}

console.log(
  `[bump-assets] version=${version} — ${touched} module file(s) restamped, `
  + `${htmlFiles.length} page(s) updated: ${htmlFiles.join(', ')}`,
);
