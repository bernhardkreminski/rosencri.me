/**
 * Month grid. Weeks start on Monday (German convention). Past events are shown,
 * just dimmed — people want to look back at what happened.
 */

import { el, clear, dayKey, startOfDay, sameDay, eventPhase, MONTHS_DE, WEEKDAYS_SHORT_DE, parseDate } from './util.js?v=20260731T0401';

const MAX_LABELS = 3;

export const monthLabel = (date) => `${MONTHS_DE[date.getMonth()]} ${date.getFullYear()}`;

/** Group events by local day key. Multi-day events appear on every day they span. */
export function groupByDay(events) {
  const map = new Map();
  for (const ev of events) {
    const start = parseDate(ev.start);
    if (!start) continue;
    const end = parseDate(ev.end);
    let cursor = startOfDay(start);
    const last = startOfDay(end && end > start ? end : start);
    let guard = 0;
    while (cursor <= last && guard++ < 60) {
      const key = dayKey(cursor);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
      cursor = new Date(cursor.getTime() + 86400000);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (parseDate(a.start) || 0) - (parseDate(b.start) || 0));
  }
  return map;
}

/**
 * @param {HTMLElement} grid
 * @param {{events: object[], month: Date, selected: Date|null, onSelect: (d: Date) => void}} opts
 */
export function renderCalendar(grid, { events, month, selected, onSelect }) {
  clear(grid);
  const byDay = groupByDay(events);
  const now = new Date();
  const today = startOfDay(now);

  for (const wd of WEEKDAYS_SHORT_DE) {
    grid.append(el('div.cal-wd', { role: 'columnheader', text: wd }));
  }

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // getDay(): 0 = Sunday → shift so Monday is column 0.
  const lead = (first.getDay() + 6) % 7;
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1 - lead);

  for (let i = 0; i < 42; i++) {
    const day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i);
    const dayEvents = byDay.get(dayKey(day)) || [];
    const outside = day.getMonth() !== month.getMonth();
    const isToday = sameDay(day, today);

    // The visual "today" ring means nothing to a screen reader; aria-current
    // is what actually conveys it. Phase words are spelled out too, because on
    // narrow screens the dots are the only remaining cue and a dot has no
    // accessible name.
    const phases = dayEvents.map((ev) => eventPhase(ev, now));
    const label = [
      isToday ? 'Heute, ' : '',
      `${day.getDate()}. ${MONTHS_DE[day.getMonth()]}`,
      dayEvents.length
        ? `, ${dayEvents.length} Event${dayEvents.length === 1 ? '' : 's'}`
        : ', keine Events',
      phases.includes('live') ? ', läuft gerade' : '',
      phases.includes('soon') ? ', in den nächsten 24 Stunden' : '',
    ].join('');

    const cell = el('button.cal-cell', {
      type: 'button',
      role: 'gridcell',
      'aria-label': label,
      onClick: () => onSelect(day),
    });
    if (isToday) cell.setAttribute('aria-current', 'date');
    if (outside) cell.classList.add('is-out');
    if (isToday) cell.classList.add('is-today');
    if (selected && sameDay(day, selected)) cell.classList.add('is-selected');

    cell.append(el('span.cal-num', { text: String(day.getDate()) }));

    // Compact dot row for narrow screens.
    if (dayEvents.length) {
      const dots = el('span.cal-dots', { 'aria-hidden': 'true' });
      for (const ev of dayEvents.slice(0, 4)) {
        dots.append(el(`i.dot.dot-${phaseDot(ev, now)}`));
      }
      cell.append(dots);
    }

    for (const ev of dayEvents.slice(0, MAX_LABELS)) {
      const phase = eventPhase(ev, now);
      cell.append(el(`span.cal-ev.is-${phase}`, { title: ev.title, text: ev.title }));
    }
    if (dayEvents.length > MAX_LABELS) {
      cell.append(el('span.cal-more', { text: `+${dayEvents.length - MAX_LABELS}` }));
    }

    grid.append(cell);
  }

  return byDay;
}

/**
 * Dot class per event phase. `live` and `soon` used to collapse into one class,
 * which made the legend claim four states the grid never actually drew.
 */
function phaseDot(ev, now) {
  const phase = eventPhase(ev, now);
  if (phase === 'past') return 'past';
  if (phase === 'live') return 'live';
  if (phase === 'soon') return 'soon';
  return 'up';
}
