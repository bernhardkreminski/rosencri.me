/**
 * rosencri.me — application shell.
 * Wires the store, the two views, the add-an-event flow and the dialogs.
 */

import { SITE_URL, ICS_PATH, SITE_NAME, MAX_IMAGE_BYTES } from './config.js';
import { store } from './store.js';
import { renderCalendar, monthLabel, groupByDay } from './calendar.js';
import { seriesSpan } from './recurrence.js';
import {
  $, el, clear, formatDate, formatDateLong, formatTime, formatRange, relativeTime,
  eventPhase, parseDate, startOfDay, sameDay, dayKey, toLocalInput, fromLocalInput,
  linkify, hashHue, initials, debounce, MONTHS_DE,
} from './util.js';

/* --------------------------------- state -------------------------------- */

const state = {
  view: 'list',
  query: '',
  tags: new Set(),
  month: startOfDay(new Date()),
  selectedDay: null,
  draft: null,          // { fields, confidence, blob, previewUrl }
  editing: null,        // event being edited, null when adding
  scanAbort: null,
};

const ui = {};
let icalModule = null;

/**
 * 05.08.2026 — no weekday, for date ranges where it would be noise.
 *
 * Deliberately local rather than exported from util.js: only app.js carries a
 * ?v= cache buster, so its static imports can resolve to a stale cached copy
 * of a sibling module for up to Pages' 10-minute max-age. Adding a new export
 * there and consuming it here breaks the whole page with a module error during
 * that window, rather than degrading. Shared helpers must ship at least one
 * deploy before anything imports them.
 */
const fmtDateShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const formatDateShort = (d) => (parseDate(d) ? fmtDateShort.format(parseDate(d)) : '');
/** Filled in once ical.js loads; until then cards simply omit the repeat tag. */
let describeSchedule = () => '';

/* --------------------------------- boot --------------------------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheNodes();
  bindHeader();
  bindAddFlow();
  bindCalendarNav();
  bindSubscribe();
  bindFilters();

  store.addEventListener('change', () => render());
  store.addEventListener('event-changed', () => render());

  ui.storageMode.textContent =
    store.mode === 'supabase' ? 'Daten: geteilt (Supabase)' : 'Daten: nur auf diesem Gerät';

  try {
    await store.load();
  } catch (err) {
    console.error(err);
    toast('Events konnten nicht geladen werden.', 'error');
  }

  if (store.error) banner(store.error, 'warn');
  else if (store.mode === 'local') {
    banner('Kein Server verbunden — deine Events bleiben vorerst auf diesem Gerät.', 'warn');
  }

  render();
  loadIcal().catch(() => {});   // also primes the repeat labels
  applyRoute();
  window.addEventListener('hashchange', applyRoute);

  // Keep "in 3 Std." labels and the live highlight honest without a reload.
  setInterval(() => render(), 60_000);
}

function cacheNodes() {
  Object.assign(ui, {
    banner: $('#banner'),
    viewList: $('#view-list'),
    viewCal: $('#view-calendar'),
    tabs: Array.from(document.querySelectorAll('.viewswitch-btn')),
    listNow: $('#list-now'),
    listUpcoming: $('#list-upcoming'),
    listPast: $('#list-past'),
    sectionNow: $('#section-now'),
    sectionUpcoming: $('#section-upcoming'),
    sectionPast: $('#section-past'),
    pastCount: $('#past-count'),
    todayDate: $('#today-date'),
    empty: $('#empty-state'),
    search: $('#search'),
    tagFilters: $('#tag-filters'),
    filters: $('#filters'),
    calGrid: $('#cal-grid'),
    calTitle: $('#cal-title'),
    calDay: $('#cal-day'),
    calDayTitle: $('#cal-day-title'),
    calDayList: $('#cal-day-list'),
    storageMode: $('#storage-mode'),
    dlgAdd: $('#dlg-add'),
    dlgScan: $('#dlg-scan'),
    dlgForm: $('#dlg-form'),
    dlgDetail: $('#dlg-detail'),
    dlgSubscribe: $('#dlg-subscribe'),
    detailBody: $('#detail-body'),
    form: $('#event-form'),
    formError: $('#form-error'),
    formTitle: $('#form-title'),
    formSub: $('#form-sub'),
    formPoster: $('#form-poster'),
    formPosterImg: $('#form-poster-img'),
    scanImg: $('#scan-img'),
    scanMsg: $('#scan-msg'),
    scanBar: $('#scan-bar'),
    toasts: $('#toasts'),
  });
}

/* -------------------------------- routing ------------------------------- */

function applyRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('event/')) {
    const id = hash.slice(6);
    if (store.getById(id)) openDetail(id);
  } else if (hash === 'kalender') {
    switchView('calendar');
  } else if (hash === 'neu') {
    ui.dlgAdd.showModal();
  }
}

function switchView(view) {
  state.view = view;
  ui.viewList.classList.toggle('is-active', view === 'list');
  ui.viewCal.classList.toggle('is-active', view === 'calendar');
  ui.viewList.hidden = view !== 'list';
  ui.viewCal.hidden = view !== 'calendar';
  for (const tab of ui.tabs) {
    const on = tab.dataset.view === view;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  render();
}

/* -------------------------------- header -------------------------------- */

function bindHeader() {
  for (const tab of ui.tabs) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }
  $('#btn-subscribe').addEventListener('click', openSubscribe);

  // Clicking the wordmark reloads the site.
  //
  // Assigning location.href here does NOT work: when the new URL differs only
  // by its fragment it is a same-document navigation, so the subsequent
  // reload() still fires against the old "#/event/..." URL and the hash comes
  // back. replaceState rewrites the URL without navigating, so the reload
  // that follows genuinely starts from the bare page.
  $('#brand-home').addEventListener('click', (e) => {
    e.preventDefault();
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  });
  for (const id of ['#btn-add-hero', '#btn-add-empty', '#fab']) {
    $(id)?.addEventListener('click', () => ui.dlgAdd.showModal());
  }
  const icsHref = new URL(ICS_PATH, location.href).href;
  for (const id of ['#link-ics-hero', '#link-ics-footer']) {
    $(id)?.addEventListener('click', (e) => { e.preventDefault(); openSubscribe(); });
  }
  $('#sub-download').href = icsHref;
}

function bindFilters() {
  ui.search.addEventListener('input', debounce((e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  }, 160));

  $('#btn-search-toggle').addEventListener('click', () => toggleFilters());
  $('#btn-search-close').addEventListener('click', () => toggleFilters(false));
  // Escape closes the panel the same way the close button does.
  ui.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); toggleFilters(false); }
  });
}

/**
 * Show/hide the search + tag filters.
 *
 * Closing resets the query and tag selection: a hidden filter that is still
 * applied would silently shrink the list with nothing on screen to explain it.
 */
function toggleFilters(force) {
  const open = force ?? ui.filters.hidden;
  ui.filters.hidden = !open;
  $('#btn-search-toggle').setAttribute('aria-expanded', String(open));

  if (open) {
    setTimeout(() => ui.search.focus(), 60);
  } else if (state.query || state.tags.size) {
    ui.search.value = '';
    state.query = '';
    state.tags.clear();
    render();
  }
}

/* ------------------------------- filtering ------------------------------ */

function visibleEvents() {
  const q = state.query;
  return store.getAll().filter((ev) => {
    if (state.tags.size && !ev.tags.some((t) => state.tags.has(t))) return false;
    if (!q) return true;
    return [ev.title, ev.location, ev.description, ev.authorName, ...(ev.tags || [])]
      .join(' ').toLowerCase().includes(q);
  });
}

function renderTagFilters() {
  const counts = new Map();
  for (const ev of store.getAll()) {
    for (const tag of ev.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  clear(ui.tagFilters);
  for (const [tag] of top) {
    ui.tagFilters.append(el('button.chip', {
      type: 'button',
      'aria-pressed': String(state.tags.has(tag)),
      class: state.tags.has(tag) ? 'is-on' : '',
      text: tag,
      onClick: () => {
        state.tags.has(tag) ? state.tags.delete(tag) : state.tags.add(tag);
        render();
      },
    }));
  }
  ui.tagFilters.hidden = top.length === 0;
}

/* -------------------------------- render -------------------------------- */

function render() {
  renderTagFilters();
  if (state.view === 'list') renderList();
  else renderCalendarView();
}

function renderList() {
  const now = new Date();
  // Re-stamped on every render (incl. the 60s tick), so it survives midnight.
  ui.todayDate.textContent = formatDateLong(now);
  const events = visibleEvents();
  const hot = [], upcoming = [], past = [];

  for (const ev of events) {
    const phase = eventPhase(ev, now);
    if (phase === 'live' || phase === 'soon') hot.push(ev);
    else if (phase === 'past') past.push(ev);
    else upcoming.push(ev);
  }
  past.reverse(); // most recently finished first

  fill(ui.listNow, hot, { hot: true });
  fill(ui.listUpcoming, upcoming);
  fill(ui.listPast, past, { past: true });

  ui.sectionNow.hidden = hot.length === 0;
  ui.sectionUpcoming.hidden = upcoming.length === 0;
  ui.sectionPast.hidden = past.length === 0;
  ui.pastCount.textContent = past.length ? `(${past.length})` : '';
  ui.empty.hidden = events.length !== 0;

  if (!upcoming.length && (hot.length || past.length)) {
    ui.sectionUpcoming.hidden = false;
    clear(ui.listUpcoming).append(
      el('p.comment-empty', { text: 'Nichts weiter geplant. Trag was ein!' }),
    );
  }
}

function fill(container, events, opts = {}) {
  clear(container);
  for (const ev of events) container.append(eventCard(ev, opts));
}

function eventCard(ev, { hot = false, past = false } = {}) {
  const now = new Date();
  const phase = eventPhase(ev, now);
  const start = parseDate(ev.start);

  const card = el('button.card', {
    type: 'button',
    'aria-label': `${ev.title}, ${formatDateLong(start)}`,
    onClick: () => openDetail(ev.id),
  });
  if (hot || phase === 'live' || phase === 'soon') card.classList.add('is-hot');
  if (phase === 'live') card.classList.add('is-live');
  if (phase === 'soon') card.classList.add('is-soon');
  if (past || phase === 'past') card.classList.add('is-past');

  if (ev.imageUrl) {
    card.append(el('span.card-thumb', {}, [el('img', { src: ev.imageUrl, alt: '', loading: 'lazy' })]));
  }

  if (phase === 'live') card.append(el('span.badge.badge-live', {}, ['● Läuft gerade']));
  else if (phase === 'soon') card.append(el('span.badge.badge-soon', {}, [relativeTime(start, now)]));

  card.append(el('span.card-date', {}, [
    formatDate(start),
    el('span.time', { text: formatTime(start) }),
  ]));
  card.append(el('h3.card-title', { text: ev.title }));

  const meta = el('span.card-meta');
  if (ev.location) meta.append(el('span.ellip', {}, [icon('pin'), ev.location]));
  if (phase !== 'live') meta.append(el('span', {}, [icon('clock'), relativeTime(start, now)]));
  if (meta.childElementCount) card.append(meta);

  // Always describe the stored series, never the occurrence: an occurrence's
  // own start matches one of its rdates, which the de-duplication then drops,
  // making a 4-date series read as "3 Termine" on every card but the first.
  const seriesRow = store.getSeries(ev.id) || ev;
  const span = seriesSpan(seriesRow);
  if (span) {
    card.append(el('span.card-span', {}, [
      span.last
        ? `von ${formatDateShort(span.first)} bis ${formatDateShort(span.last)}`
        : `ab ${formatDateShort(span.first)}`,
    ]));
  }
  const repeatLabel = describeSchedule(seriesRow);
  if (ev.tags?.length || repeatLabel) {
    card.append(el('span.card-tags', {}, [
      repeatLabel && el('span.repeat-tag', {}, ['\u27f3 ', repeatLabel]),
      ...ev.tags.slice(0, 3).map((t) => el('span.tag', { text: t })),
    ]));
  }

  const stats = el('span.card-stats', {}, [
    el(`span${store.isLiked(ev.id) ? '.on' : ''}`, {}, ['❤', String(ev.likeCount || 0)]),
    el(`span${store.getRsvp(ev.id) === 'going' ? '.on' : ''}`, {}, ['✋', String(ev.goingCount || 0)]),
    el('span', {}, ['💬', String(ev.commentCount || 0)]),
  ]);
  card.append(stats);
  return card;
}

/* ------------------------------ calendar view --------------------------- */

function bindCalendarNav() {
  $('#cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('#cal-next').addEventListener('click', () => shiftMonth(1));
  $('#cal-today').addEventListener('click', () => {
    state.month = startOfDay(new Date());
    state.selectedDay = startOfDay(new Date());
    renderCalendarView();
  });
}

function shiftMonth(delta) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1);
  renderCalendarView();
}

function renderCalendarView() {
  ui.calTitle.textContent = monthLabel(state.month);
  renderCalendar(ui.calGrid, {
    events: visibleEvents(),
    month: state.month,
    selected: state.selectedDay,
    onSelect: (day) => {
      state.selectedDay = day;
      renderCalendarView();
      ui.calDay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  });

  if (!state.selectedDay) { ui.calDay.hidden = true; return; }
  const list = groupByDay(visibleEvents()).get(dayKey(state.selectedDay)) || [];
  ui.calDay.hidden = false;
  ui.calDayTitle.textContent = formatDateLong(state.selectedDay);
  clear(ui.calDayList);
  if (!list.length) {
    ui.calDayList.append(el('p.comment-empty', { text: 'An diesem Tag ist nichts eingetragen.' }));
  } else {
    for (const ev of list) ui.calDayList.append(eventCard(ev));
  }
}

/* ------------------------------ add-an-event ---------------------------- */

function bindAddFlow() {
  $('#file-camera').addEventListener('change', (e) => handleImage(e.target.files?.[0]));
  $('#file-upload').addEventListener('change', (e) => handleImage(e.target.files?.[0]));
  $('#opt-manual').addEventListener('click', () => {
    ui.dlgAdd.close();
    openForm(null);
  });

  $('#scan-cancel').addEventListener('click', () => {
    state.scanAbort?.abort();
    ui.dlgScan.close();
  });

  $('#form-cancel').addEventListener('click', () => ui.dlgForm.close());
  $('#confirm-cancel').addEventListener('click', () => $('#dlg-confirm').close());
  $('#form-poster-remove').addEventListener('click', () => {
    if (state.draft) state.draft.blob = null;
    ui.formPoster.hidden = true;
  });
  $('#field-repeat').addEventListener('change', (e) => syncRepeatMode(e.target.value));
  $('#btn-add-date').addEventListener('click', () => addDateRow(''));
  $('#form-poster-view').addEventListener('click', () => {
    openLightbox(ui.formPosterImg.src, 'Poster in voller Größe');
  });
  // Tapping the image itself (not just the close button) dismisses the lightbox.
  $('#dlg-lightbox').addEventListener('click', (e) => {
    if (e.target.id !== 'lightbox-img') $('#dlg-lightbox').close();
  });
  ui.form.addEventListener('submit', onSubmitEvent);

  // Touch devices get the camera option first; on desktop it just opens a picker.
  if (!matchMedia('(pointer: coarse)').matches) {
    const camera = $('#opt-camera');
    camera.classList.remove('addopt-primary');
    $('#opt-upload').classList.add('addopt-primary');
    camera.parentNode.insertBefore($('#opt-upload'), camera);
  }
}

async function handleImage(file) {
  if (!file) return;
  ui.dlgAdd.close();
  if (!file.type.startsWith('image/')) {
    toast('Das ist kein Bild.', 'error');
    return;
  }

  const previewUrl = URL.createObjectURL(file);
  ui.scanImg.src = previewUrl;
  ui.scanBar.style.width = '4%';
  ui.scanMsg.textContent = 'Bild wird vorbereitet …';
  ui.dlgScan.showModal();

  const controller = new AbortController();
  state.scanAbort = controller;

  try {
    const ocr = await import('./ocr.js');
    const blob = await ocr.downscaleImage(file, 1600, 0.82);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('Das Bild ist zu groß (max. 5 MB).');

    const result = await ocr.extractFromImage(file, {
      signal: controller.signal,
      onProgress: ({ progress, message }) => {
        ui.scanBar.style.width = `${Math.round((progress || 0) * 100)}%`;
        if (message) ui.scanMsg.textContent = message;
      },
    });

    ui.dlgScan.close();
    const found = [result.fields.title && 'Titel', result.fields.start && 'Datum', result.fields.location && 'Ort']
      .filter(Boolean);
    openForm({
      fields: result.fields,
      confidence: result.confidence,
      blob,
      previewUrl,
      note: found.length
        ? `Erkannt: ${found.join(', ')}. Bitte kurz prüfen.`
        : 'Wir konnten wenig lesen — bitte von Hand ergänzen.',
    });
  } catch (err) {
    ui.dlgScan.close();
    if (controller.signal.aborted) return;
    console.error('[ocr]', err);
    toast(err.message || 'Texterkennung fehlgeschlagen.', 'error');
    // Still let people save the event — just without the auto-fill.
    openForm({ fields: {}, confidence: {}, blob: file, previewUrl, note: 'Automatisches Auslesen hat nicht geklappt — bitte von Hand eintragen.' });
  } finally {
    state.scanAbort = null;
  }
}

/**
 * @param {object|null} draft   OCR/manual draft, or null for a blank form
 * @param {object} [editing]    existing event (or occurrence) being edited
 */
function openForm(draft, editing = null) {
  state.draft = draft;
  state.editing = editing;
  const f = draft?.fields || {};
  const c = draft?.confidence || {};
  const form = ui.form;
  form.reset();

  const isRepeating = Boolean(editing?.rrule);
  ui.formTitle.textContent = editing ? 'Event bearbeiten' : draft ? 'Event prüfen' : 'Event eintragen';
  ui.formSub.textContent = editing
    ? (isRepeating
        ? 'Änderungen gelten für die ganze Serie — alle Termine dieses Events.'
        : 'Änderungen sind sofort für alle sichtbar.')
    : draft?.note || 'Nur Titel und Beginn sind Pflicht.';

  if (editing) {
    // Edit the stored row, not the occurrence: a series has one start date.
    const row = store.getSeries(editing.id) || editing;
    form.title.value = row.title || '';
    form.start.value = row.start ? toLocalInput(row.start) : defaultStart();
    form.end.value = row.end ? toLocalInput(row.end) : '';
    form.location.value = row.location || '';
    form.description.value = row.description || '';
    form.url.value = row.url || '';
    form.tags.value = (row.tags || []).join(', ');
    form.authorName.value = row.authorName || store.identity.name || '';
    clear($('#extra-dates'));
    const [freq, until] = splitRRule(row.rrule || '');
    const extras = Array.isArray(row.rdates) ? row.rdates : [];
    form.repeat.value = extras.length && !freq ? 'dates' : freq;
    form.repeatUntil.value = until;
    for (const d of extras) addDateRow(toLocalInput(d));
    syncRepeatMode(form.repeat.value);
  } else {
    form.title.value = f.title || '';
    form.start.value = f.start || defaultStart();
    form.end.value = f.end || '';
    form.location.value = f.location || '';
    form.description.value = f.description || '';
    form.url.value = f.url || '';
    form.tags.value = (f.tags || []).join(', ');
    form.authorName.value = store.identity.name || '';
    form.repeat.value = '';
    form.repeatUntil.value = '';
    clear($('#extra-dates'));
    syncRepeatMode('');
  }

  for (const flag of form.querySelectorAll('.field-flag')) {
    const key = flag.dataset.flag;
    const score = c[key];
    flag.hidden = !(draft && f[key] && typeof score === 'number' && score < 0.7);
  }

  ui.formPoster.hidden = !draft?.previewUrl;
  if (draft?.previewUrl) ui.formPosterImg.src = draft.previewUrl;
  ui.formError.hidden = true;

  $('#form-submit').textContent = editing ? 'Änderungen speichern' : 'In den Kalender eintragen';
  ui.dlgForm.showModal();
  setTimeout(() => form.title.focus(), 120);
}

/**
 * Show the controls that belong to the chosen repeat mode.
 * 'dates' = explicit list; anything else non-empty = a rule with an end date.
 */
function syncRepeatMode(value) {
  $('#field-dates-wrap').hidden = value !== 'dates';
  $('#field-repeat-until-wrap').hidden = !value || value === 'dates';
  if (value === 'dates' && !$('#extra-dates').children.length) addDateRow('');
}

/** One more date for an irregular series. */
function addDateRow(value = '') {
  const input = el('input', { type: 'datetime-local', name: 'extraDate', value });
  const row = el('div.extra-date', {}, [
    input,
    el('button.extra-date-remove', {
      type: 'button', 'aria-label': 'Termin entfernen',
      onClick: (e) => e.currentTarget.parentElement.remove(),
    }, ['✕']),
  ]);
  $('#extra-dates').append(row);
  return input;
}

/**
 * Split a stored RRULE back into the two form controls.
 * @returns {[string, string]} [value for the repeat select, yyyy-mm-dd or '']
 */
function splitRRule(rrule) {
  if (!rrule) return ['', ''];
  const m = /;?UNTIL=(\d{4})(\d{2})(\d{2})/i.exec(rrule);
  const base = rrule.replace(/;?UNTIL=[^;]*/i, '');
  const known = ['FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=MONTHLY'];
  return [known.includes(base) ? base : '', m ? `${m[1]}-${m[2]}-${m[3]}` : ''];
}

function defaultStart() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(20, 0, 0, 0);
  return toLocalInput(d);
}

async function onSubmitEvent(e) {
  e.preventDefault();
  const form = ui.form;
  const submit = $('#form-submit');
  const fail = (msg) => {
    ui.formError.textContent = msg;
    ui.formError.hidden = false;
  };

  const title = form.title.value.trim();
  const start = fromLocalInput(form.start.value);
  if (!title) return fail('Bitte einen Titel eintragen.');
  if (!start) return fail('Bitte Datum und Uhrzeit eintragen.');

  const end = fromLocalInput(form.end.value);
  if (end && new Date(end) <= new Date(start)) return fail('Das Ende muss nach dem Beginn liegen.');

  submit.disabled = true;
  submit.textContent = 'Speichern …';
  ui.formError.hidden = true;

  try {
    let imageUrl = '';
    if (state.draft?.blob) {
      try {
        imageUrl = await store.uploadPoster(state.draft.blob);
      } catch (err) {
        console.warn('[upload]', err);
      }
    }

    let rrule = form.repeat.value;
    let rdates = [];
    if (rrule === 'dates') {
      // Explicit list rather than a rule.
      rrule = '';
      rdates = [...ui.form.querySelectorAll('input[name="extraDate"]')]
        .map((i) => fromLocalInput(i.value))
        .filter(Boolean);
      const seen = new Set([start]);
      rdates = rdates.filter((d) => !seen.has(d) && seen.add(d));
    }
    if (rrule && form.repeatUntil.value) {
      const [y, m, d] = form.repeatUntil.value.split('-').map(Number);
      const untilLocal = new Date(y, m - 1, d, 23, 59, 59);
      const p = (n) => String(n).padStart(2, '0');
      rrule += `;UNTIL=${untilLocal.getUTCFullYear()}${p(untilLocal.getUTCMonth() + 1)}${p(untilLocal.getUTCDate())}`
             + `T${p(untilLocal.getUTCHours())}${p(untilLocal.getUTCMinutes())}${p(untilLocal.getUTCSeconds())}Z`;
    }

    const authorName = form.authorName.value.trim();
    if (authorName) store.setName(authorName);

    const fields = {
      title,
      start,
      end,
      location: form.location.value.trim(),
      description: form.description.value.trim(),
      url: form.url.value.trim(),
      tags: form.tags.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 8),
      authorName,
      rrule,
      rdates,
    };

    let saved;
    if (state.editing) {
      // Keep the existing poster unless a new one was picked.
      if (imageUrl) fields.imageUrl = imageUrl;
      saved = await store.updateEvent(state.editing.id, fields);
    } else {
      saved = await store.addEvent({
        ...fields,
        imageUrl,
        source: state.draft?.previewUrl ? 'poster' : 'manual',
      });
    }

    ui.dlgForm.close();
    if (state.draft?.previewUrl) URL.revokeObjectURL(state.draft.previewUrl);
    const wasEditing = Boolean(state.editing);
    state.draft = null;
    state.editing = null;
    toast(wasEditing ? 'Änderungen gespeichert.' : 'Event eingetragen 🎉', 'ok');
    render();
    openDetail(saved.id);
  } catch (err) {
    console.error(err);
    fail(err.message || 'Speichern fehlgeschlagen.');
  } finally {
    submit.disabled = false;
    submit.textContent = state.editing ? 'Änderungen speichern' : 'In den Kalender eintragen';
  }
}

/* ------------------------------ event detail ---------------------------- */

async function openDetail(id) {
  const ev = store.getById(id);
  if (!ev) return;
  const now = new Date();
  const phase = eventPhase(ev, now);
  const start = parseDate(ev.start);

  const body = clear(ui.detailBody);

  if (ev.imageUrl) {
    // The banner is cropped to keep the dialog usable; posters carry details
    // (times, venue, line-up) that the crop cuts off, so it opens in full.
    body.append(el('button.detail-hero', {
      type: 'button',
      title: 'Bild vollständig anzeigen',
      onClick: () => openLightbox(ev.imageUrl, `Poster: ${ev.title}`),
    }, [
      el('img', { src: ev.imageUrl, alt: `Poster: ${ev.title}` }),
      el('span.detail-hero-zoom', {}, [
        el('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>' }),
        'Ganzes Bild ansehen',
      ]),
    ]));
  }

  const kicker = el('div.detail-kicker');
  if (phase === 'live') kicker.append(el('span.badge.badge-live', {}, ['● Läuft gerade']));
  else if (phase === 'soon') kicker.append(el('span.badge.badge-soon', {}, [relativeTime(start, now)]));
  else kicker.append(document.createTextNode(phase === 'past' ? 'Vorbei' : relativeTime(start, now)));
  body.append(kicker);

  body.append(el('h2.detail-title#detail-title', { text: ev.title }));

  const meta = el('div.detail-meta');
  meta.append(el('div', {}, [icon('cal'), el('strong', { text: formatRange(ev.start, ev.end) })]));
  // Describe the stored series, not the occurrence — see the note in eventCard.
  const detailSeries = store.getSeries(ev.id) || ev;
  const repeatText = describeSchedule(detailSeries);
  if (repeatText) {
    const span = seriesSpan(detailSeries);
    const range = span
      ? (span.last
          ? ` · von ${formatDateLong(span.first)} bis ${formatDateLong(span.last)}`
          : ` · ab ${formatDateLong(span.first)}`)
      : '';
    meta.append(el('div', {}, [icon('repeat'), el('strong', { text: repeatText + range })]));
  }
  if (ev.location) meta.append(el('div', {}, [icon('pin'), el('strong', { text: ev.location })]));
  if (ev.url) {
    meta.append(el('div', {}, [
      icon('link'),
      el('a', { href: ev.url, target: '_blank', rel: 'noopener noreferrer', text: prettyUrl(ev.url) }),
    ]));
  }
  if (ev.authorName) meta.append(el('div', {}, [icon('user'), `eingetragen von ${ev.authorName}`]));
  body.append(meta);

  if (ev.description) body.append(el('div.detail-desc', { html: linkify(ev.description) }));
  if (ev.tags?.length) {
    body.append(el('div.detail-tags', {}, ev.tags.map((t) => el('span.tag', { text: t }))));
  }

  /* actions */
  const actions = el('div.detail-actions');

  const likeBtn = el(`button.actbtn${store.isLiked(id) ? '.is-on' : ''}`, {
    type: 'button',
    onClick: async () => {
      try {
        const res = await store.toggleLike(id);
        likeBtn.classList.toggle('is-on', res.liked);
        likeBtn.querySelector('.n').textContent = String(res.count);
      } catch (err) { toast(err.message, 'error'); }
    },
  }, ['❤', el('span.n', { text: String(ev.likeCount || 0) })]);

  const goingBtn = el(`button.actbtn.act-going${store.getRsvp(id) === 'going' ? '.is-on' : ''}`, {
    type: 'button',
    onClick: async () => {
      try {
        const res = await store.setRsvp(id, 'going');
        goingBtn.classList.toggle('is-on', res.status === 'going');
        goingBtn.querySelector('.n').textContent = String(res.count);
      } catch (err) { toast(err.message, 'error'); }
    },
  }, ['✋ Ich bin dabei', el('span.n', { text: String(ev.goingCount || 0) })]);

  const calBtn = el('button.actbtn', {
    type: 'button',
    onClick: async () => {
      const ical = await loadIcal();
      // The dialog shows one occurrence, so export just that date. Keeping the
      // RRULE here would import a whole series starting from this occurrence,
      // silently shifting the repeat the user actually subscribed to.
      const single = { ...ev, rrule: '' };
      ical.downloadICS([single], `${(ev.title || 'event').replace(/[^\w-]+/g, '-').slice(0, 40)}.ics`, {
        calName: ev.title, calUrl: SITE_URL,
      });
      toast('Termin heruntergeladen.', 'ok');
    },
  }, ['📅 Zum Kalender']);

  const shareBtn = el('button.actbtn', {
    type: 'button',
    onClick: () => shareEvent(ev),
  }, ['↗ Teilen']);

  actions.append(likeBtn, goingBtn, calBtn, shareBtn);
  body.append(actions);

  // Anyone may edit or delete anything — deliberate open-board choice, see
  // supabase/schema.sql. Kept visually separate from the social actions.
  const manage = el('div.detail-manage', {}, [
    el('button.actbtn', {
      type: 'button',
      onClick: () => { ui.dlgDetail.close(); openForm(null, ev); },
    }, ['✎ Bearbeiten']),
    el('button.actbtn.actbtn-danger', {
      type: 'button',
      onClick: () => confirmDelete(ev),
    }, ['🗑 Löschen']),
  ]);
  body.append(manage);

  /* comments */
  const live = phase === 'live' || phase === 'soon';
  const comments = el(`section.comments${live ? '.is-live' : ''}`);
  comments.append(el('h3', {}, [
    live ? '📣 Live-Updates' : '💬 Kommentare',
    el('span.count', { text: '' }),
  ]));
  if (live) {
    comments.append(el('p.live-note', {}, [
      '🔥 ',
      phase === 'live'
        ? 'Das läuft gerade — schreib rein, wie es ist, wer da ist, ob noch was geht.'
        : 'Das ist bald — hier ist der Platz für kurzfristige Infos.',
    ]));
  }

  const list = el('div.comment-list', {}, [el('p.comment-empty', { text: 'Lade …' })]);
  comments.append(list);

  const nameInput = el('input', { name: 'name', placeholder: 'Dein Name', maxlength: 40, value: store.identity.name });
  const textInput = el('textarea', { name: 'body', rows: 2, maxlength: 2000, placeholder: live ? 'Was geht gerade?' : 'Kommentar …', required: true });
  const sendBtn = el('button.btn.btn-primary.btn-sm', { type: 'submit', text: 'Senden' });

  const cForm = el('form.comment-form', {
    onSubmit: async (e) => {
      e.preventDefault();
      const text = textInput.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        if (nameInput.value.trim()) store.setName(nameInput.value.trim());
        await store.addComment(id, text);
        textInput.value = '';
        await paintComments(list, id, live);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        sendBtn.disabled = false;
      }
    },
  }, [
    el('div.row', {}, [nameInput, textInput]),
    el('div.row', { style: 'justify-content:flex-end' }, [sendBtn]),
  ]);
  comments.append(cForm);
  body.append(comments);

  ui.dlgDetail.showModal();
  history.replaceState(null, '', `#/event/${id}`);
  ui.dlgDetail.addEventListener('close', () => {
    history.replaceState(null, '', location.pathname + location.search);
  }, { once: true });

  await paintComments(list, id, live);
}

async function paintComments(container, id, live) {
  const list = await store.listComments(id, { force: true });
  clear(container);
  if (!list.length) {
    container.append(el('p.comment-empty', {
      text: live ? 'Noch keine Updates. Mach den Anfang.' : 'Noch keine Kommentare.',
    }));
    return;
  }
  for (const c of list) {
    const hue = hashHue(c.author || 'anon');
    container.append(el('div.comment', {}, [
      el('span.avatar', { style: `background:hsl(${hue} 55% 45%)`, text: initials(c.author) }),
      el('div.comment-body', {}, [
        el('div.comment-head', {}, [
          el('strong', { text: c.author || 'anonym' }),
          el('time', { datetime: c.createdAt, text: relativeTime(c.createdAt) }),
        ]),
        el('div.comment-text', { html: linkify(c.body) }),
      ]),
    ]));
  }
}

/** Ask before deleting; a recurring event takes its whole series with it. */
function confirmDelete(ev) {
  const repeating = Boolean(ev.rrule || (ev.rdates || []).length);
  $('#confirm-title').textContent = repeating ? 'Ganze Serie löschen?' : 'Event löschen?';
  $('#confirm-text').textContent = repeating
    ? `„${ev.title}" wiederholt sich — gelöscht werden alle Termine der Serie, nicht nur dieser eine.`
    : `„${ev.title}" wird für alle entfernt.`;

  const ok = $('#confirm-ok');
  const clone = ok.cloneNode(true);          // drop listeners from a prior open
  ok.replaceWith(clone);
  clone.addEventListener('click', async () => {
    clone.disabled = true;
    clone.textContent = 'Löschen …';
    try {
      await store.deleteEvent(ev.id);
      $('#dlg-confirm').close();
      ui.dlgDetail.close();
      history.replaceState(null, '', location.pathname + location.search);
      toast(repeating ? 'Serie gelöscht.' : 'Event gelöscht.', 'ok');
      render();
    } catch (err) {
      console.error(err);
      toast(err.message || 'Löschen fehlgeschlagen.', 'error');
    } finally {
      clone.disabled = false;
      clone.textContent = 'Endgültig löschen';
    }
  });
  $('#dlg-confirm').showModal();
}

/** Show an image uncropped, at full size, over the whole screen. */
function openLightbox(src, alt = 'Bild in voller Größe') {
  const img = $('#lightbox-img');
  img.src = src;
  img.alt = alt;
  $('#dlg-lightbox').showModal();
}

async function shareEvent(ev) {
  const url = new URL(`#/event/${ev.id}`, SITE_URL).href;
  const text = `${ev.title} — ${formatRange(ev.start, ev.end)}${ev.location ? `, ${ev.location}` : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: ev.title, text, url }); return; } catch { /* cancelled */ }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Link kopiert.', 'ok');
  } catch {
    toast(url);
  }
}

/* ------------------------------- subscribe ------------------------------ */

async function loadIcal() {
  if (!icalModule) {
    icalModule = await import('./ical.js');
    if (typeof icalModule.describeSchedule === 'function') {
      describeSchedule = icalModule.describeSchedule;
      render();
    }
  }
  return icalModule;
}

function bindSubscribe() {
  $('#sub-copy').addEventListener('click', async () => {
    const input = $('#sub-url');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Adresse kopiert.', 'ok');
    } catch {
      input.select();
      document.execCommand?.('copy');
      toast('Adresse kopiert.', 'ok');
    }
  });
}

async function openSubscribe() {
  const httpsUrl = new URL(ICS_PATH, location.href).href;
  const ical = await loadIcal();
  $('#sub-url').value = httpsUrl;
  $('#sub-webcal').href = ical.webcalUrl(httpsUrl);
  $('#sub-download').href = httpsUrl;
  ui.dlgSubscribe.showModal();
}

/* ------------------------------ small stuff ----------------------------- */

const ICONS = {
  pin: '<path d="M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  link: '<path d="M10 13a5 5 0 007.1 0l2.4-2.4a5 5 0 10-7.1-7.1L11 4.9"/><path d="M14 11a5 5 0 00-7.1 0l-2.4 2.4a5 5 0 107.1 7.1L13 19.1"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0114 0"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

const prettyUrl = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

function banner(text, kind = 'info') {
  ui.banner.textContent = text;
  ui.banner.dataset.kind = kind;
  ui.banner.hidden = false;
}

function toast(message, kind = 'info') {
  const node = el('div.toast', { dataset: { kind }, text: message });
  ui.toasts.append(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 300);
  }, 3600);
}

// <dialog> handles Escape itself; we only need to release the poster preview's
// object URL when the form sheet goes away, however it was closed.
document.addEventListener('close', (e) => {
  if (e.target !== ui.dlgForm) return;
  if (state.draft?.previewUrl) URL.revokeObjectURL(state.draft.previewUrl);
  state.draft = null;
  // Must be cleared on cancel too — a leftover `editing` would turn the next
  // "Event hinzufügen" into an overwrite of the event that was being edited.
  state.editing = null;
}, true);

export { store, state };
