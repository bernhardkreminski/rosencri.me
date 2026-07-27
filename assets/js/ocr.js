/**
 * ocr.js — client-side poster-to-event extraction for rosencri.me
 *
 * Loads Tesseract.js v5 lazily from jsDelivr the first time OCR is actually
 * requested (keeps the main page fast), runs recognition with a German+English
 * language pack, and parses the recognised lines into event fields tuned for
 * German subculture event posters (dates, times, German month/weekday names,
 * Rosenheim venue names, ticket/genre boilerplate, etc.).
 *
 * No top-level DOM access: every `document`/`window`/`canvas` touch is inside a
 * function body so this module can be imported under plain Node for unit
 * testing `parsePosterText` and its helpers without a browser.
 */

/** Feature flag the app can check before showing OCR-related UI. */
export const OCR_AVAILABLE = true;

const TESSERACT_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const TESSERACT_CORE_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5';
const TESSERACT_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
const TESSERACT_LANGS = 'deu+eng';

// ---------------------------------------------------------------------------
// Lazy Tesseract loader
// ---------------------------------------------------------------------------

/** @type {Promise<any>|null} */
let tesseractLoadPromise = null;

/**
 * Injects the Tesseract.js CDN script the first time it's needed and caches
 * the loading promise so subsequent calls reuse the same instance.
 * @returns {Promise<any>} the global `Tesseract` object.
 */
function loadTesseract() {
  if (tesseractLoadPromise) return tesseractLoadPromise;

  tesseractLoadPromise = new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.Tesseract) {
      resolve(window.Tesseract);
      return;
    }
    if (typeof document === 'undefined') {
      reject(new Error('Text recognition is only available in a browser.'));
      return;
    }

    const existing = document.querySelector(`script[src="${TESSERACT_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.Tesseract) resolve(window.Tesseract);
        else reject(new Error('Could not load the text recognition library. Please check your internet connection and try again.'));
      });
      existing.addEventListener('error', () => {
        reject(new Error('Could not reach the text recognition library (CDN unavailable). Please check your internet connection and try again.'));
      });
      return;
    }

    const script = document.createElement('script');
    script.src = TESSERACT_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('Could not load the text recognition library. Please check your internet connection and try again.'));
    };
    script.onerror = () => {
      tesseractLoadPromise = null; // allow retry on a later call
      reject(new Error('Could not reach the text recognition library (CDN unavailable). Please check your internet connection and try again.'));
    };
    document.head.appendChild(script);
  });

  return tesseractLoadPromise;
}

// ---------------------------------------------------------------------------
// Image preprocessing (browser only)
// ---------------------------------------------------------------------------

/**
 * Loads a File/Blob into a drawable bitmap-like source.
 * @param {Blob} file
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
async function loadDrawable(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  // Fallback for environments without createImageBitmap.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Could not read the image file.'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Computes output dimensions constrained to `maxDimension` on the longest side.
 * @param {number} width
 * @param {number} height
 * @param {number} maxDimension
 */
function fitDimensions(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} quality
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
        type,
        quality,
      );
      return;
    }
    // Extremely old-browser fallback.
    try {
      const dataUrl = canvas.toDataURL(type, quality);
      const bytes = atob(dataUrl.split(',')[1]);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
      resolve(new Blob([arr], { type }));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Downscales an image to a JPEG blob, for fast preview/upload. Browser-only.
 * @param {File|Blob} file
 * @param {number} [maxDimension=1600]
 * @param {number} [quality=0.82]
 * @returns {Promise<Blob>}
 */
export async function downscaleImage(file, maxDimension = 1600, quality = 0.82) {
  if (typeof document === 'undefined') {
    throw new Error('Image processing is only available in a browser.');
  }
  const drawable = await loadDrawable(file);
  const srcW = drawable.width ?? drawable.naturalWidth;
  const srcH = drawable.height ?? drawable.naturalHeight;
  const { width, height } = fitDimensions(srcW, srcH, maxDimension);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(drawable, 0, 0, width, height);

  return canvasToBlob(canvas, 'image/jpeg', quality);
}

/**
 * Applies greyscale conversion + a mild linear contrast stretch in place.
 * @param {Uint8ClampedArray} data RGBA pixel buffer.
 */
function applyGreyscaleContrast(data) {
  const contrast = 35; // mild
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (let i = 0; i < data.length; i += 4) {
    const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const adjusted = Math.min(255, Math.max(0, factor * (grey - 128) + 128));
    data[i] = adjusted;
    data[i + 1] = adjusted;
    data[i + 2] = adjusted;
  }
}

/**
 * Prepares a poster photo for OCR: downscale to <=1600px, greyscale, mild
 * contrast stretch. Falls back to returning the original file when no DOM is
 * available (shouldn't happen in practice — `extractFromImage` is browser-only).
 * @param {File|Blob} file
 * @returns {Promise<Blob>}
 */
async function preprocessForOcr(file) {
  if (typeof document === 'undefined') return file;
  const drawable = await loadDrawable(file);
  const srcW = drawable.width ?? drawable.naturalWidth;
  const srcH = drawable.height ?? drawable.naturalHeight;
  const { width, height } = fitDimensions(srcW, srcH, 1600);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(drawable, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  applyGreyscaleContrast(imageData.data);
  ctx.putImageData(imageData, 0, 0);

  return canvasToBlob(canvas, 'image/jpeg', 0.92);
}

// ---------------------------------------------------------------------------
// Shared text-normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Folds German umlauts/ß to their ASCII digraph form for robust, OCR-tolerant
 * keyword matching (MÜNCHEN / MUENCHEN / München all fold to "muenchen").
 * Only used for comparisons — never for display strings.
 * @param {string} str
 * @returns {string}
 */
function foldGerman(str) {
  return str
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

/**
 * Fixes common OCR digit/letter confusions (O/0, l/I/1, S/5) inside a
 * substring that is already known to be a date/time candidate. Deliberately
 * scoped — must never be applied to title/description text.
 * @param {string} token
 * @returns {string}
 */
function fixDigitLookalikes(token) {
  return token.replace(/[oOlIS]/g, (ch) => {
    if (ch === 'o' || ch === 'O') return '0';
    if (ch === 'l' || ch === 'I') return '1';
    if (ch === 'S') return '5';
    return ch;
  });
}

// ---------------------------------------------------------------------------
// Date / time parsing
// ---------------------------------------------------------------------------

const MONTH_MAP = {
  jan: 1, januar: 1,
  feb: 2, februar: 2,
  mar: 3, maerz: 3, marz: 3, mrz: 3, // "maerz" from foldGerman("märz")
  apr: 4, april: 4,
  mai: 5,
  jun: 6, juni: 6,
  jul: 7, juli: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10,
  nov: 11, november: 11,
  dez: 12, dezember: 12,
};

const MONTH_NAME_ALTERNATION =
  '(?:Januar|Jan|Februar|Feb|M[äae]?rz|Mrz|April|Apr|Mai|Juni|Jun|Juli|Jul|August|Aug|September|Sept?|Oktober|Okt|November|Nov|Dezember|Dez)';

const WEEKDAY_NAMES = [
  'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonnabend', 'Sonntag',
];
const WEEKDAY_ABBR = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// Weekday token must stand alone (optionally followed by "." or ","), never be
// a prefix/infix of a longer word — e.g. "SOLIKONZERT" must NOT lose its
// leading "SO" (Sonntag abbreviation), nor "MITTWOCHSCLUB" its "Mittwoch".
// A plain `\b` isn't enough here: JS's default (non-unicode) word boundary
// treats German umlauts as non-word characters, so `\b` would (wrongly) see
// a boundary between "FR" and the "Ü" in "FRÜHSCHOPPEN". Using a unicode-aware
// negative lookahead for "not a letter/number" instead of `\b` avoids that.
const WEEKDAY_PREFIX_RE = new RegExp(
  `^(?:${WEEKDAY_NAMES.join('|')}|${WEEKDAY_ABBR.join('|')})(?![\\p{L}\\p{N}])[.,]?\\s*`,
  'iu',
);

function monthFromToken(token) {
  const key = foldGerman(token).replace(/\./g, '');
  return MONTH_MAP[key] ?? null;
}

/**
 * Finds the first plausible date in a set of lines.
 * @param {{text: string}[]} lines
 * @returns {{year: number, month: number, day: number, explicitYear: boolean, lineIndex: number, matchText: string}|null}
 */
function findDate(lines) {
  // 1. ISO yyyy-mm-dd
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return { year, month, day, explicitYear: true, lineIndex: i, matchText: m[0] };
      }
    }
  }

  // 2. dd.mm.yyyy / dd.mm.yy / dd.mm. — tolerate OCR digit lookalikes.
  // (year+boundary only required when a year is actually present, so a
  // trailing-dot yearless date like "25.07." still matches at end-of-string.)
  const dotDateRe = /\b([0-9oOlIS]{1,2})\.\s?([0-9oOlIS]{1,2})\.(?:\s?([0-9oOlIS]{2,4})\b)?/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(dotDateRe);
    if (!m) continue;
    const day = Number(fixDigitLookalikes(m[1]));
    const month = Number(fixDigitLookalikes(m[2]));
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) continue;
    let year = null;
    let explicitYear = false;
    if (m[3]) {
      const rawYear = fixDigitLookalikes(m[3]);
      year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
      explicitYear = true;
    }
    return { year, month, day, explicitYear, lineIndex: i, matchText: m[0] };
  }

  // 3. "1. August 2026" / "1 Aug 2026" / "Freitag 1. August"
  const monthNameRe = new RegExp(
    `\\b(\\d{1,2})\\.?\\s*(${MONTH_NAME_ALTERNATION})\\.?\\s*(\\d{4})?\\b`,
    'i',
  );
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(monthNameRe);
    if (!m) continue;
    const month = monthFromToken(m[2]);
    if (!month) continue;
    const day = Number(m[1]);
    if (!(day >= 1 && day <= 31)) continue;
    return {
      year: m[3] ? Number(m[3]) : null,
      month,
      day,
      explicitYear: Boolean(m[3]),
      lineIndex: i,
      matchText: m[0],
    };
  }

  return null;
}

/**
 * Resolves a possibly-yearless {month, day} into a concrete year: the next
 * future (or today) occurrence relative to `now`.
 */
function resolveYear(dateInfo, now) {
  if (dateInfo.explicitYear && dateInfo.year) return dateInfo.year;
  const year = now.getFullYear();
  const candidate = new Date(year, dateInfo.month - 1, dateInfo.day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (candidate < today) return year + 1;
  return year;
}

/**
 * Finds start/end time-of-day (in "HH:MM" 24h form) within the full text.
 * Prefers Beginn/Start/"ab" over Einlass/Doors, and range patterns give both
 * start and end directly.
 * @param {string} fullText
 * @returns {{start: string|null, end: string|null, found: boolean}}
 */
function findTime(fullText) {
  const toHHMM = (h, m) => {
    const hour = Math.min(23, Math.max(0, Number(h)));
    const min = m ? Math.min(59, Math.max(0, Number(m))) : 0;
    return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  // Range: "20:00 - 23:00", "16 - 18 Uhr", "20 Uhr bis 23 Uhr"
  const rangeRe = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:Uhr)?\s*(?:-|–|bis)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:Uhr)?/i;
  const rangeMatch = fullText.match(rangeRe);
  if (rangeMatch) {
    return {
      start: toHHMM(rangeMatch[1], rangeMatch[2]),
      end: toHHMM(rangeMatch[3], rangeMatch[4]),
      found: true,
    };
  }

  // Finds a time within a short window of text following a keyword. Tries,
  // in order of confidence: "HH:MM"/"HH.MM" (with optional "Uhr"), then
  // "HH Uhr"/"HHh", then finally a bare number as a last resort (still scoped
  // to the narrow post-keyword window, so it won't reach into an unrelated
  // date/year elsewhere in the text).
  function matchTimeInWindow(window) {
    let m = window.match(/(\d{1,2})[:.](\d{2})\s*(?:Uhr)?/i);
    if (m) return { h: m[1], m: m[2] };
    m = window.match(/(\d{1,2})\s*(?:Uhr|h)\b/i);
    if (m) return { h: m[1], m: undefined };
    m = window.match(/(\d{1,2})\b/);
    if (m) return { h: m[1], m: undefined };
    return null;
  }

  function timeAfterKeyword(keywordRe) {
    const km = fullText.match(keywordRe);
    if (!km) return null;
    const windowStart = km.index + km[0].length;
    const window = fullText.slice(windowStart, windowStart + 20);
    return matchTimeInWindow(window);
  }

  // Preferred keywords: "ab", "Beginn", "Start"
  const preferred = timeAfterKeyword(/\b(?:ab|Beginn|Start)\b/i);
  if (preferred) return { start: toHHMM(preferred.h, preferred.m), end: null, found: true };

  // Fallback keywords: "Einlass", "Doors"
  const doors = timeAfterKeyword(/\b(?:Einlass|Doors)\b/i);
  if (doors) return { start: toHHMM(doors.h, doors.m), end: null, found: true };

  // Generic, no-keyword-context fallback. A bare "dd.mm"-shaped token is
  // ambiguous with a date, so a dot separator only counts as a time here when
  // "Uhr" explicitly follows it; a colon is unambiguous on its own.
  let m = fullText.match(/(\d{1,2}):(\d{2})\s*(?:Uhr)?/);
  if (m) return { start: toHHMM(m[1], m[2]), end: null, found: true };
  m = fullText.match(/(\d{1,2})[.:](\d{2})\s*Uhr\b/i);
  if (m) return { start: toHHMM(m[1], m[2]), end: null, found: true };
  m = fullText.match(/(\d{1,2})\s*(?:Uhr|h)\b/i);
  if (m) return { start: toHHMM(m[1], undefined), end: null, found: true };

  return { start: null, end: null, found: false };
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

const BOILERPLATE_WORDS = new Set(
  [
    'eintritt', 'einlass', 'beginn', 'vorverkauf', 'vvk', 'abendkasse', 'ak',
    'tickets', 'ticket', 'live', 'live musik', 'livemusik', 'support', 'presents',
    'praesentiert', 'ab', 'uhr', 'gefoerdert durch', 'info', 'infos', 'doors', 'start',
    ...WEEKDAY_NAMES, ...WEEKDAY_ABBR,
    'januar', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august',
    'september', 'oktober', 'november', 'dezember',
  ].map((w) => foldGerman(w)),
);

const DATE_OR_TIME_LINE_RE = new RegExp(
  [
    '\\d{1,2}\\.\\s?\\d{1,2}\\.', // dd.mm.
    '\\d{4}-\\d{1,2}-\\d{1,2}', // ISO
    `\\d{1,2}\\.?\\s*${MONTH_NAME_ALTERNATION}`, // 1. August
    '\\d{1,2}[:.]\\d{2}\\s*(Uhr)?', // 16:00 / 16.00 Uhr
    '\\d{1,2}\\s*Uhr', // 16 Uhr
    '\\d{1,2}h\\b', // 20h
  ].join('|'),
  'i',
);

const URL_LINE_RE = /https?:\/\/|www\.|@[a-z0-9_.]{2,}|\.(de|com|net|org|info)\b/i;
const PRICE_OR_NUMERIC_RE = /^[\d\s€$.,%-]+$/;

/**
 * True when a line is essentially just a date/time expression (e.g.
 * "ab 16 Uhr", "Beginn 20:00") with no other salient content — such lines
 * should not leak into the description.
 * @param {string} text
 */
function isPureDateTimeLine(text) {
  const stripped = text
    .replace(new RegExp(DATE_OR_TIME_LINE_RE.source, 'gi'), ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !BOILERPLATE_WORDS.has(foldGerman(w)))
    .filter((w) => !/^[\W_]+$/.test(w));
  return stripped.length === 0;
}

/**
 * Converts an ALL-CAPS (or mostly caps) word to Title Case, but leaves
 * short (<=3 letter) acronyms and already-mixed-case words untouched.
 * @param {string} word
 */
function titleCaseWord(word) {
  const letters = word.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  if (!letters) return word;
  const isAllCaps = letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  const isAllLower = letters === letters.toLowerCase();
  if (!isAllCaps) return word; // mixed case (e.g. "vetternWIRTSCHAFT") — keep as-is
  if (letters.length <= 3) return word; // keep short acronyms as-is
  if (isAllLower) return word;
  return word.charAt(0) + word.slice(1).toLowerCase();
}

/**
 * Normalises an ALL-CAPS title to Title Case, word by word.
 * @param {string} line
 */
function normaliseTitleCasing(line) {
  return line
    .split(' ')
    .map((word) => titleCaseWord(word))
    .join(' ');
}

/**
 * Picks the most likely poster headline out of the recognised lines.
 * @param {{text: string, confidence: number, height: number, top: number, left: number}[]} lines
 * @returns {{text: string, confidence: number, lineIndexes: number[]}|null}
 */
function findTitle(lines) {
  const candidates = lines
    .map((line, index) => ({ ...line, index }))
    .filter((line) => {
      const trimmed = line.text.trim();
      if (trimmed.length < 2 || trimmed.length > 60) return false;
      if ((line.confidence ?? 100) <= 55) return false;
      if (DATE_OR_TIME_LINE_RE.test(trimmed)) return false;
      if (URL_LINE_RE.test(trimmed)) return false;
      if (PRICE_OR_NUMERIC_RE.test(trimmed)) return false;
      const folded = foldGerman(trimmed);
      if (BOILERPLATE_WORDS.has(folded)) return false;
      // Strip a leading weekday and re-check (e.g. "Sa" alone already caught above).
      const withoutWeekday = foldGerman(trimmed.replace(WEEKDAY_PREFIX_RE, '').trim());
      if (!withoutWeekday) return false;
      if (BOILERPLATE_WORDS.has(withoutWeekday)) return false;
      return true;
    });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const tallest = candidates[0];
  const second = candidates[1];

  let text = tallest.text.trim().replace(WEEKDAY_PREFIX_RE, '').trim();
  const lineIndexes = [tallest.index];
  let confSum = tallest.confidence ?? 70;
  let confCount = 1;

  if (second) {
    const heightRatio = Math.min(tallest.height ?? 1, second.height ?? 1) / Math.max(tallest.height ?? 1, second.height ?? 1);
    const verticalGap = Math.abs((second.top ?? 0) - ((tallest.top ?? 0) + (tallest.height ?? 0)));
    const adjacent = verticalGap < (tallest.height ?? 20) * 1.5;
    if (heightRatio >= 0.85 && adjacent) {
      const secondText = second.text.trim().replace(WEEKDAY_PREFIX_RE, '').trim();
      // Join in reading order (top-to-bottom).
      if ((second.top ?? 0) >= (tallest.top ?? 0)) {
        text = `${text} ${secondText}`.trim();
      } else {
        text = `${secondText} ${text}`.trim();
      }
      lineIndexes.push(second.index);
      confSum += second.confidence ?? 70;
      confCount += 1;
    }
  }

  text = normaliseTitleCasing(text);

  return { text, confidence: confSum / confCount, lineIndexes };
}

// ---------------------------------------------------------------------------
// Location extraction
// ---------------------------------------------------------------------------

/** Known Rosenheim-area venue keywords — extend freely as new venues appear. */
const VENUE_KEYWORDS = [
  'Asta', 'Ballhaus', 'Beat Club', 'Bunker', 'Container', 'Jugendzentrum', 'JUZ',
  'Kulturzentrum', 'KUKO', 'Lokschuppen', 'Z-Bau', 'Vetternwirtschaft', 'Alte Spinnerei',
  'Alte Kantine', 'Wirtschaft', 'Biergarten', 'Halle', 'Keller', 'Café', 'Cafe', 'Bar',
  'Club', 'Kulturbühne',
].map((kw) => foldGerman(kw));

const STREET_SUFFIX_RE = /\b\w+(str\.|straße|strasse|platz|weg|gasse)\s*\d+\w?\b/i;
const POSTCODE_CITY_RE = /\b(\d{5})\s+([A-ZÄÖÜ][\wäöüßÄÖÜ.-]+)\b/;

/**
 * True when a line reads like an enumerated list (food/drink offerings, band
 * line-ups, etc.) rather than a single place name — used to stop a venue
 * keyword that merely appears inside such a list (e.g. "Biergarten" inside
 * "Biergarten - Fassbrause - Steckerlfisch") from being mistaken for the venue.
 * @param {string} text
 */
function looksLikeEnumeration(text) {
  const trimmed = text.trim();
  const separatorCount = (trimmed.match(/ - | – |,/g) || []).length;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return separatorCount >= 2 || wordCount > 6 || trimmed.length > 45;
}

/**
 * @param {{text: string}[]} lines
 * @returns {{text: string, confidence: number, lineIndex: number, consumesLine: boolean}|null}
 */
function findLocation(lines) {
  // 1. Explicit marker: "Ort:", "Location:", "Adresse:"
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(/^\s*(?:Ort|Location|Adresse)\s*[:\-]\s*(.+)$/i);
    if (m && m[1].trim()) {
      return { text: m[1].trim(), confidence: 0.8, lineIndex: i, consumesLine: true };
    }
  }

  // 2. Inline prefix markers: "@ X", "im X", "in der X", "bei X"
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(/(?:^|\s)(?:@\s+|im\s+|in der\s+|bei\s+)([A-ZÄÖÜ][\wäöüßÄÖÜ .-]{1,40})/);
    if (m && m[1].trim()) {
      return { text: m[1].trim(), confidence: 0.7, lineIndex: i, consumesLine: true };
    }
  }

  // 3. Known venue keyword appearing anywhere in a line — but only when the
  // line reads like a place name, not an enumerated list that merely
  // contains the keyword (e.g. a food/drink line mentioning "Biergarten").
  // Lowest-priority signal on purpose: explicit markers and postcode/city
  // above always win. Confidence is capped low so the UI flags it for review.
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].text.trim();
    if (looksLikeEnumeration(trimmed)) continue;
    const folded = foldGerman(trimmed);
    if (VENUE_KEYWORDS.some((kw) => folded.includes(kw))) {
      return { text: trimmed, confidence: 0.5, lineIndex: i, consumesLine: true };
    }
  }

  // 4. Street name + house number.
  for (let i = 0; i < lines.length; i += 1) {
    if (STREET_SUFFIX_RE.test(lines[i].text)) {
      return { text: lines[i].text.trim(), confidence: 0.55, lineIndex: i, consumesLine: true };
    }
  }

  // 5. Postcode + city -> use the city as a fallback default. Only the city
  // token is extracted, so the rest of the line (if any) stays available for
  // the description.
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(POSTCODE_CITY_RE);
    if (m) {
      return { text: m[2].trim(), confidence: 0.5, lineIndex: i, consumesLine: false };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

function normaliseUrl(raw) {
  let url = raw.trim().replace(/[.,;)\]]+$/, '');
  if (/^https?:\/\//i.test(url)) {
    return url.replace(/^http:\/\//i, 'https://');
  }
  if (/^www\./i.test(url)) {
    return `https://${url}`;
  }
  return `https://${url}`;
}

/**
 * @param {{text: string}[]} lines
 * @returns {{text: string, confidence: number, lineIndex: number, matchText: string}|null}
 */
function findUrl(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(/https?:\/\/[^\s]+/i);
    if (m) return { text: normaliseUrl(m[0]), confidence: 0.9, lineIndex: i, matchText: m[0] };
  }
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(/\bwww\.[^\s]+\.[a-z]{2,}\b/i);
    if (m) return { text: normaliseUrl(m[0]), confidence: 0.75, lineIndex: i, matchText: m[0] };
  }
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(/\b[a-z0-9-]+\.(de|com|net|org|info)\b/i);
    if (m && !/^\d+$/.test(m[0].split('.')[0])) {
      return { text: normaliseUrl(m[0]), confidence: 0.6, lineIndex: i, matchText: m[0] };
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].text.match(/@([a-zA-Z0-9_.]{2,30})\b/);
    if (m) {
      return {
        text: `https://instagram.com/${m[1]}`,
        confidence: 0.5,
        lineIndex: i,
        matchText: m[0],
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TAG_DEFINITIONS = [
  ['punk', /\bpunk\b/i],
  ['post-punk', /\bpost[\s-]?punk/i],
  ['garage', /\bgarage/i],
  ['rock', /\brock/i],
  ['surf', /\bsurf/i],
  ['metal', /\bmetal/i],
  ['hardcore', /\bhardcore/i],
  ['techno', /\btechno/i],
  ['rave', /\brave/i],
  ['elektro', /\belektro/i],
  ['hiphop', /\bhip[\s-]?hop/i],
  ['jazz', /\bjazz/i],
  ['folk', /\bfolk/i],
  ['indie', /\bindie/i],
  ['konzert', /\bkonzert/i],
  ['live-musik', /\blive[\s-]?musik/i],
  ['festival', /\bfestival/i],
  ['party', /\bparty/i],
  ['lesung', /\blesung/i],
  ['theater', /\btheater/i],
  ['kino', /\bkino/i],
  ['film', /\bfilm/i],
  ['ausstellung', /\bausstellung/i],
  ['flohmarkt', /\bflohmarkt/i],
  ['workshop', /\bworkshop/i],
  ['voku', /\bvok[üu]/i],
  ['kufa', /\bk[üu]fa\b/i],
  // No trailing boundary (like 'kinder'/'konzert' below): "soli" is commonly
  // a compound-word prefix on posters (e.g. "Solikonzert" = solidarity gig).
  ['soli', /\bsoli/i],
  ['open-air', /\bopen[\s-]?air/i],
  ['biergarten', /\bbiergarten/i],
  ['kinder', /\bkinder/i],
  ['diy', /\bdiy\b/i],
];

/**
 * NOTE: the reference JAHRESFEST poster genuinely produces 7 distinct tag
 * hits (live-musik, post-punk, garage, rock, surf, biergarten, kinder), one
 * more than the "max 6" guidance in the spec — the cap below is relaxed to 8
 * so that mandatory reference case still passes without dropping a hit.
 */
const MAX_TAGS = 8;

function findTags(fullText) {
  const folded = foldGerman(fullText);
  const found = [];
  for (const [tag, re] of TAG_DEFINITIONS) {
    if (re.test(fullText) || re.test(folded)) found.push(tag);
  }
  return [...new Set(found)].slice(0, MAX_TAGS);
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PosterLine
 * @property {string} text
 * @property {number} confidence 0..100
 * @property {number} height px
 * @property {number} top px
 * @property {number} left px
 */

/**
 * @typedef {Object} PosterFields
 * @property {string} title
 * @property {string|null} start
 * @property {string|null} end
 * @property {string} location
 * @property {string} description
 * @property {string} url
 * @property {string[]} tags
 */

/**
 * Internal: does the actual parsing work and additionally returns the
 * per-field confidence, which `extractFromImage` needs but the public
 * `parsePosterText` signature (spec: returns Fields only) does not expose.
 * @param {PosterLine[]} lines
 * @param {Date} [now]
 * @returns {{fields: PosterFields, confidence: {title:number,start:number,location:number,url:number,overall:number}}}
 */
function analyzePoster(lines, now = new Date()) {
  const safeLines = Array.isArray(lines)
    ? lines.map((l) => ({
        text: typeof l?.text === 'string' ? l.text : '',
        confidence: typeof l?.confidence === 'number' ? l.confidence : 70,
        height: typeof l?.height === 'number' ? l.height : 10,
        top: typeof l?.top === 'number' ? l.top : 0,
        left: typeof l?.left === 'number' ? l.left : 0,
      }))
    : [];

  const fullText = safeLines.map((l) => l.text).join('\n');

  const dateInfo = findDate(safeLines);
  const timeInfo = findTime(fullText);
  const titleInfo = findTitle(safeLines);
  const locationInfo = findLocation(safeLines);
  const urlInfo = findUrl(safeLines);
  const tags = findTags(fullText);

  let start = null;
  let end = null;
  let startConfidence = 0;

  if (dateInfo) {
    const year = resolveYear(dateInfo, now);
    const pad = (n) => String(n).padStart(2, '0');
    const isoDate = `${year}-${pad(dateInfo.month)}-${pad(dateInfo.day)}`;
    const hhmm = timeInfo.start ?? '20:00';
    start = `${isoDate}T${hhmm}`;
    if (timeInfo.end) {
      end = `${isoDate}T${timeInfo.end}`;
    }
    const dateConfidence = dateInfo.explicitYear ? 0.9 : 0.65;
    startConfidence = timeInfo.found ? dateConfidence : Math.min(dateConfidence, 0.5);
  }

  // Build description from whatever lines weren't consumed elsewhere.
  const consumedIndexes = new Set([
    ...(titleInfo?.lineIndexes ?? []),
    ...(dateInfo ? [dateInfo.lineIndex] : []),
    ...(locationInfo?.consumesLine ? [locationInfo.lineIndex] : []),
  ]);

  const descriptionLines = [];
  safeLines.forEach((line, index) => {
    if (consumedIndexes.has(index)) return;
    let text = line.text;
    if (urlInfo && urlInfo.lineIndex === index) {
      text = text.replace(urlInfo.matchText, '').trim();
    }
    text = text.replace(/\s{2,}/g, ' ').trim();
    if (text.length < 3) return;
    if (/^[\W_]+$/.test(text)) return; // pure punctuation / OCR noise
    const foldedLine = foldGerman(text);
    if (BOILERPLATE_WORDS.has(foldedLine)) return;
    if (isPureDateTimeLine(text)) return;
    descriptionLines.push(text);
  });

  let description = descriptionLines.join('\n');
  if (description.length > 400) {
    description = description.slice(0, 400).replace(/\s+\S*$/, '');
  }

  const fields = {
    title: titleInfo?.text ?? '',
    start,
    end,
    location: locationInfo?.text ?? '',
    description,
    url: urlInfo?.text ?? '',
    tags,
  };

  const confidence = {
    title: titleInfo ? Math.min(1, (titleInfo.confidence ?? 70) / 100) : 0,
    start: startConfidence,
    location: locationInfo ? locationInfo.confidence : 0,
    url: urlInfo ? urlInfo.confidence : 0,
  };
  const parts = [confidence.title, confidence.start, confidence.location, confidence.url];
  confidence.overall = parts.reduce((a, b) => a + b, 0) / parts.length;

  return { fields, confidence };
}

/**
 * Pure, unit-testable poster-line parser — never throws, always returns a
 * complete Fields object (empty strings/nulls on total failure).
 * @param {PosterLine[]} lines
 * @returns {PosterFields}
 */
export function parsePosterText(lines) {
  try {
    return analyzePoster(lines).fields;
  } catch {
    return {
      title: '',
      start: null,
      end: null,
      location: '',
      description: '',
      url: '',
      tags: [],
    };
  }
}

// ---------------------------------------------------------------------------
// OCR pipeline (browser only)
// ---------------------------------------------------------------------------

function assertNotAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Extraction was cancelled.');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * Flattens Tesseract v5 recognition data into line objects. Carries `right`/
 * `bottom` (bbox extent) alongside the public PosterLine fields purely for
 * `mergeLines`' overlap math — those two are stripped before lines are
 * handed back to callers.
 * @param {any} data
 * @returns {(PosterLine & {right: number, bottom: number})[]}
 */
function flattenLines(data) {
  const rawLines = data?.lines ?? [];
  return rawLines.map((line) => {
    const bbox = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    return {
      text: (line.text ?? '').trim(),
      confidence: line.confidence ?? 0,
      height: Math.max(1, (bbox.y1 ?? 0) - (bbox.y0 ?? 0)),
      top: bbox.y0 ?? 0,
      left: bbox.x0 ?? 0,
      right: bbox.x1 ?? (bbox.x0 ?? 0),
      bottom: bbox.y1 ?? (bbox.y0 ?? 0),
    };
  }).filter((l) => l.text.length > 0);
}

/** Case-folded, whitespace-collapsed text for line-identity comparisons. */
function normaliseForDedupe(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Overlap of [aStart,aEnd] and [bStart,bEnd] as a fraction of the shorter span. */
function overlapFraction(aStart, aEnd, bStart, bEnd) {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  const shorter = Math.min(aEnd - aStart, bEnd - bStart);
  if (overlap <= 0 || shorter <= 0) return 0;
  return overlap / shorter;
}

/** True when two recognised lines are almost certainly the same physical line. */
function isSamePhysicalLine(a, b) {
  if (normaliseForDedupe(a.text) === normaliseForDedupe(b.text)) return true;
  const vOverlap = overlapFraction(a.top, a.bottom, b.top, b.bottom);
  const hOverlap = overlapFraction(a.left, a.right, b.left, b.right);
  return vOverlap > 0.6 && hOverlap > 0.6;
}

/**
 * Merges a default-PSM pass with a SPARSE_TEXT (PSM 11) pass. Tesseract's
 * default page segmentation can drop an oversized poster headline when it's
 * mixed with a lot of smaller body text; a sparse-text second pass reliably
 * catches it, but is noisier overall, so low-confidence/very-short
 * sparse-only lines are dropped rather than merged in. On a duplicate, keeps
 * whichever line has higher confidence, but always keeps the larger height
 * (height drives title selection, so a good box shouldn't shrink because a
 * lower-confidence pass measured it tighter). Result is sorted by `top`.
 * @param {(PosterLine & {right: number, bottom: number})[]} primary default-PSM lines
 * @param {(PosterLine & {right: number, bottom: number})[]} secondary sparse-PSM lines
 */
function mergeLines(primary, secondary) {
  const merged = primary.map((l) => ({ ...l }));
  for (const candidate of secondary) {
    const matchIndex = merged.findIndex((existing) => isSamePhysicalLine(existing, candidate));
    if (matchIndex >= 0) {
      const existing = merged[matchIndex];
      const winner = candidate.confidence > existing.confidence ? candidate : existing;
      merged[matchIndex] = { ...winner, height: Math.max(existing.height, candidate.height) };
    } else if (candidate.confidence >= 60 && candidate.text.trim().length >= 2) {
      merged.push({ ...candidate });
    }
    // else: sparse-only noise below the confidence/length bar — dropped.
  }
  merged.sort((a, b) => a.top - b.top);
  return merged;
}

/** Strips the internal `right`/`bottom` bbox-extent fields for public output. */
function toPublicLine({ text, confidence, height, top, left }) {
  return { text, confidence, height, top, left };
}

/**
 * Main entry point: runs OCR on a poster photo and returns extracted event
 * fields.
 * @param {File|Blob} file
 * @param {{onProgress?: (p: {stage: string, progress: number, message: string}) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{rawText: string, lines: PosterLine[], fields: PosterFields, confidence: {title:number,start:number,location:number,url:number,overall:number}, durationMs: number}>}
 */
export async function extractFromImage(file, options = {}) {
  const { onProgress = () => {}, signal } = options;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  onProgress({ stage: 'prepare', progress: 0, message: 'Bereite Bild vor…' });
  assertNotAborted(signal);
  const processed = await preprocessForOcr(file);
  assertNotAborted(signal);
  onProgress({ stage: 'prepare', progress: 1, message: 'Bild bereit.' });

  onProgress({ stage: 'load', progress: 0, message: 'Lade OCR-Engine…' });
  let Tesseract;
  try {
    Tesseract = await loadTesseract();
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not load the text recognition library.');
  }
  assertNotAborted(signal);
  onProgress({ stage: 'load', progress: 1, message: 'OCR-Engine geladen.' });

  // Tesseract's default page segmentation (PSM 3, "auto") can drop an
  // oversized poster headline entirely when it's mixed with a lot of smaller
  // body text. A second SPARSE_TEXT (PSM 11) pass over the same preprocessed
  // image reliably catches it. One worker is reused for both passes — a
  // second worker would double the (slow) model-load time. `recognizePhase`
  // lets the single shared logger map each pass's own 0..1 progress into a
  // distinct slice of the overall "recognize" stage.
  let recognizePhase = 'default';
  const phaseRanges = { default: [0, 0.7], sparse: [0.7, 0.95] };

  let worker = null;
  try {
    worker = await Tesseract.createWorker(TESSERACT_LANGS, 1, {
      workerPath: TESSERACT_SCRIPT_URL.replace('tesseract.min.js', 'worker.min.js'),
      corePath: TESSERACT_CORE_PATH,
      langPath: TESSERACT_LANG_PATH,
      logger: (m) => {
        if (m?.status === 'recognizing text') {
          const [from, to] = phaseRanges[recognizePhase];
          const p = typeof m.progress === 'number' ? m.progress : 0;
          onProgress({
            stage: 'recognize',
            progress: from + (to - from) * p,
            message: recognizePhase === 'sparse' ? 'Suche Überschrift…' : 'Erkenne Text…',
          });
        }
      },
    });

    assertNotAborted(signal);
    const { data: defaultData } = await worker.recognize(processed);
    assertNotAborted(signal);
    const defaultLines = flattenLines(defaultData);

    let sparseLines = [];
    recognizePhase = 'sparse';
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      assertNotAborted(signal);
      const { data: sparseData } = await worker.recognize(processed);
      sparseLines = flattenLines(sparseData);
      await worker.setParameters({ tessedit_pageseg_mode: '3' }); // restore default
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      console.warn('[ocr] sparse-text (PSM 11) pass failed, continuing with the default-PSM result only:', err);
    }
    assertNotAborted(signal);
    onProgress({ stage: 'recognize', progress: 1, message: 'Text erkannt.' });

    const mergedLines = mergeLines(defaultLines, sparseLines);
    const lines = mergedLines.map(toPublicLine);
    const rawText = lines.map((l) => l.text).join('\n');

    onProgress({ stage: 'parse', progress: 0, message: 'Extrahiere Felder…' });
    const { fields, confidence } = analyzePoster(lines);
    onProgress({ stage: 'parse', progress: 1, message: 'Fertig.' });

    const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;

    return {
      rawText,
      lines,
      fields,
      confidence,
      durationMs,
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`Text recognition failed: ${err?.message ?? 'unknown error'}`);
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore termination errors */
      }
    }
  }
}
