/**
 * Data layer.
 *
 * Two interchangeable backends behind one API:
 *   - 'supabase' — shared, public, cross-device (PostgREST + Storage over plain fetch)
 *   - 'local'    — browser localStorage, used when Supabase is not configured
 *
 * Demo ("seed") events always live client-side: they have non-UUID ids, so their
 * likes/RSVPs/comments are kept locally even in Supabase mode.
 */

import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_BUCKET,
  SHOW_SEED_EVENTS, MAX_IMAGE_BYTES,
} from './config.js';
import { uuid, isUuid, toOffsetISO, parseDate } from './util.js';
import { resolveSeedDates } from './seed.js';
import { expandAll, seriesIdOf } from './recurrence.js';

const LS = {
  events: 'rc.events',
  likes: 'rc.likes',
  rsvps: 'rc.rsvps',
  comments: 'rc.comments',
  identity: 'rc.identity',
};

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/* ---------------------------- local storage io --------------------------- */

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[store] could not persist', key, err);
    return false;
  }
}

/* ------------------------------- identity -------------------------------- */

function loadIdentity() {
  const saved = read(LS.identity, null);
  if (saved?.clientId) return saved;
  const fresh = { clientId: uuid(), name: '' };
  write(LS.identity, fresh);
  return fresh;
}

/* ------------------------------ supabase io ------------------------------ */

/**
 * Set once the store is constructed. The RLS policies in `supabase/schema.sql`
 * compare this header against `likes.client_id` / `rsvps.client_id` so people
 * can only withdraw their own like or RSVP. It is a courtesy fence, not
 * authentication — see the long comment in the schema.
 */
let currentClientId = '';

const sbHeaders = (extra = {}) => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'x-client-id': currentClientId,
  ...extra,
});

async function sb(path, { method = 'GET', body, headers, signal } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    signal,
    headers: sbHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ------------------------------- mapping --------------------------------- */

/** DB row (snake_case) → app event (camelCase). */
function rowToEvent(row) {
  return {
    id: row.id,
    title: row.title || '',
    description: row.description || '',
    location: row.location || '',
    start: row.starts_at ? toOffsetISO(new Date(row.starts_at)) : null,
    end: row.ends_at ? toOffsetISO(new Date(row.ends_at)) : null,
    url: row.url || '',
    imageUrl: row.image_url || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.created_at || new Date().toISOString(),
    source: row.source || 'manual',
    authorName: row.author_name || '',
    isSeed: Boolean(row.is_seed),
    rrule: row.rrule || '',
    likeCount: Number(row.like_count || 0),
    goingCount: Number(row.going_count || 0),
    commentCount: Number(row.comment_count || 0),
  };
}

/** App event → DB row. */
function eventToRow(ev, identity) {
  return {
    id: ev.id,
    title: ev.title,
    description: ev.description || '',
    location: ev.location || '',
    starts_at: ev.start,
    ends_at: ev.end || null,
    url: ev.url || '',
    image_url: ev.imageUrl || '',
    tags: ev.tags || [],
    source: ev.source || 'manual',
    author_id: identity.clientId,
    author_name: ev.authorName || '',
    is_seed: false,
    rrule: ev.rrule || '',
  };
}

/** Normalise anything (seed file, local storage, draft) into the app shape. */
function normalise(raw, now = new Date()) {
  const resolved = resolveSeedDates(raw, now);
  const start = resolved.start ? toOffsetISO(resolved.start) : null;
  const end = resolved.end ? toOffsetISO(resolved.end) : null;
  return {
    id: raw.id || uuid(),
    title: (raw.title || '').trim() || 'Ohne Titel',
    description: raw.description || '',
    location: raw.location || '',
    start,
    end,
    url: raw.url || '',
    imageUrl: raw.imageUrl || '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : [],
    createdAt: raw.createdAt || new Date().toISOString(),
    source: raw.source || 'manual',
    authorName: raw.authorName || '',
    isSeed: Boolean(raw.isSeed),
    rrule: raw.rrule || '',
    likeCount: Number(raw.likeCount || 0),
    goingCount: Number(raw.goingCount || 0),
    commentCount: Number(raw.commentCount || 0),
  };
}

/* --------------------------------- store --------------------------------- */

class Store extends EventTarget {
  constructor() {
    super();
    this.mode = hasSupabase ? 'supabase' : 'local';
    this.identity = loadIdentity();
    currentClientId = this.identity.clientId;
    this.events = [];
    this.error = null;
    /** @type {Map<string, object[]>} eventId → comments */
    this._comments = new Map();
    this._myLikes = new Set(read(LS.likes, []));
    this._myRsvps = new Map(Object.entries(read(LS.rsvps, {})));
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ------------------------------ loading -------------------------------- */

  async load() {
    const seeds = SHOW_SEED_EVENTS ? await this._loadSeeds() : [];
    const local = read(LS.events, []).map((e) => normalise(e));
    let remote = [];

    if (this.mode === 'supabase') {
      try {
        const rows = await sb('events_with_counts?select=*&status=eq.published&order=starts_at.asc');
        remote = (rows || []).map(rowToEvent);
        await this._loadMyInteractions();
        this.error = null;
      } catch (err) {
        console.error('[store] Supabase unreachable, falling back to local data', err);
        this.error = 'Verbindung zum Server fehlgeschlagen — es werden nur lokale Events angezeigt.';
      }
    }

    // Local drafts are kept as a safety net; remote wins on id collision.
    const byId = new Map();
    for (const ev of [...seeds, ...local, ...remote]) byId.set(ev.id, ev);
    this.series = [...byId.values()];
    // Recurring events are stored once and materialised per occurrence for the
    // UI. The .ics deliberately does not do this — it ships the RRULE itself.
    this.events = expandAll(this.series).sort(
      (a, b) => (parseDate(a.start)?.getTime() || 0) - (parseDate(b.start)?.getTime() || 0),
    );
    this._applyLocalCounts();
    this.emit('change', { events: this.events });
    return this.events;
  }

  async _loadSeeds() {
    try {
      const res = await fetch(new URL('../../data/seed-events.json', import.meta.url), { cache: 'no-cache' });
      if (!res.ok) return [];
      const list = await res.json();
      return list.map((raw) => normalise({ ...raw, isSeed: true, source: 'seed' }));
    } catch (err) {
      console.warn('[store] no seed events loaded', err);
      return [];
    }
  }

  async _loadMyInteractions() {
    const cid = encodeURIComponent(this.identity.clientId);
    const [likes, rsvps] = await Promise.all([
      sb(`likes?select=event_id&client_id=eq.${cid}`).catch(() => []),
      sb(`rsvps?select=event_id,status&client_id=eq.${cid}`).catch(() => []),
    ]);
    for (const row of likes || []) this._myLikes.add(row.event_id);
    for (const row of rsvps || []) this._myRsvps.set(row.event_id, row.status);
  }

  /** Seed/local events keep their counters in localStorage. */
  _applyLocalCounts() {
    const localCounts = read('rc.counts', {});
    for (const ev of this.events) {
      if (isUuid(ev.id) && this.mode === 'supabase') continue;
      const c = localCounts[ev.id];
      if (c) {
        ev.likeCount = c.likes || 0;
        ev.goingCount = c.going || 0;
      }
      ev.commentCount = (read(LS.comments, {})[ev.id] || []).length;
    }
  }

  _bumpLocalCount(id, field, delta) {
    const counts = read('rc.counts', {});
    counts[id] = counts[id] || { likes: 0, going: 0 };
    counts[id][field] = Math.max(0, (counts[id][field] || 0) + delta);
    write('rc.counts', counts);
    return counts[id][field];
  }

  /* ------------------------------ accessors ------------------------------ */

  getAll() { return this.events; }
  getById(id) { return this.events.find((e) => e.id === id) || null; }
  /** The stored row behind an occurrence (or the event itself). */
  getSeries(id) { return (this.series || []).find((e) => e.id === seriesIdOf(id)) || this.getById(id); }
  isLiked(id) { return this._myLikes.has(seriesIdOf(id)); }
  getRsvp(id) { return this._myRsvps.get(seriesIdOf(id)) || null; }

  setName(name) {
    this.identity = { ...this.identity, name: String(name || '').slice(0, 40) };
    write(LS.identity, this.identity);
    this.emit('identity', this.identity);
  }

  /* -------------------------------- writes ------------------------------- */

  /** @param {object} draft app-shaped event without an id */
  async addEvent(draft) {
    const ev = normalise({ ...draft, id: uuid(), createdAt: new Date().toISOString() });
    if (!ev.start) throw new Error('Ein Event braucht ein Datum.');

    if (this.mode === 'supabase') {
      const post = (body) => sb('events', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body,
      });
      try {
        let row;
        try {
          [row] = await post(eventToRow(ev, this.identity));
        } catch (err) {
          // A database that predates the recurrence migration rejects the
          // `rrule` column outright. Saving the event without its repeat rule
          // is far better than refusing to save it at all, so retry once.
          if (!/rrule/i.test(String(err.message))) throw err;
          console.warn('[store] no rrule column yet — saving without the repeat rule');
          const { rrule, ...withoutRrule } = eventToRow(ev, this.identity);
          [row] = await post(withoutRrule);
        }
        const saved = rowToEvent(row);
        this._ingest(saved);
        return saved;
      } catch (err) {
        console.error('[store] remote insert failed, saving locally', err);
      }
    }

    const local = read(LS.events, []);
    local.push(ev);
    write(LS.events, local);
    this._ingest(ev);
    return ev;
  }

  /**
   * Add a stored event to the in-memory set and re-materialise occurrences, so
   * a newly created recurring event shows its whole series immediately rather
   * than only its first date until the next reload.
   */
  _ingest(ev) {
    this.series = [...(this.series || []), ev];
    this.events = expandAll(this.series).sort(
      (a, b) => (parseDate(a.start)?.getTime() || 0) - (parseDate(b.start)?.getTime() || 0),
    );
    this.emit('change', { events: this.events });
  }

  /**
   * Upload a poster image. Returns a public URL in Supabase mode, or a data URL
   * locally (so the preview survives a reload without a backend).
   */
  async uploadPoster(blob) {
    if (!blob) return '';
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('Das Bild ist zu groß (max. 5 MB).');

    if (this.mode === 'supabase') {
      const name = `${Date.now()}-${uuid().slice(0, 8)}.jpg`;
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${name}`, {
        method: 'POST',
        headers: sbHeaders({ 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'false' }),
        body: blob,
      });
      if (res.ok) return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${name}`;
      console.warn('[store] poster upload failed', res.status, await res.text().catch(() => ''));
    }

    // Data URLs are large; only keep them for small images to protect the quota.
    if (blob.size > 400 * 1024) return '';
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  }

  async toggleLike(occurrenceId) {
    const id = seriesIdOf(occurrenceId);
    const ev = this.getById(occurrenceId);
    if (!ev) return null;
    const liked = this._myLikes.has(id);
    const remote = this.mode === 'supabase' && isUuid(id);

    if (liked) this._myLikes.delete(id); else this._myLikes.add(id);
    write(LS.likes, [...this._myLikes]);

    if (remote) {
      try {
        if (liked) {
          await sb(`likes?event_id=eq.${id}&client_id=eq.${encodeURIComponent(this.identity.clientId)}`, { method: 'DELETE' });
        } else {
          await sb('likes', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' }, body: { event_id: id, client_id: this.identity.clientId } });
        }
        ev.likeCount = Math.max(0, ev.likeCount + (liked ? -1 : 1));
      } catch (err) {
        console.error('[store] like failed', err);
        if (liked) this._myLikes.add(id); else this._myLikes.delete(id);
        write(LS.likes, [...this._myLikes]);
        throw new Error('Konnte nicht gespeichert werden.');
      }
    } else {
      ev.likeCount = this._bumpLocalCount(id, 'likes', liked ? -1 : 1);
    }

    this.emit('event-changed', { id });
    return { liked: !liked, count: ev.likeCount };
  }

  /** @param {'going'|'maybe'|null} status */
  async setRsvp(occurrenceId, status) {
    const id = seriesIdOf(occurrenceId);
    const ev = this.getById(occurrenceId);
    if (!ev) return null;
    const prev = this._myRsvps.get(id) || null;
    if (prev === status) status = null; // toggling the active choice clears it
    const remote = this.mode === 'supabase' && isUuid(id);

    if (status) this._myRsvps.set(id, status); else this._myRsvps.delete(id);
    write(LS.rsvps, Object.fromEntries(this._myRsvps));

    const wasGoing = prev === 'going';
    const isGoing = status === 'going';
    const delta = (isGoing ? 1 : 0) - (wasGoing ? 1 : 0);

    if (remote) {
      try {
        if (status) {
          await sb('rsvps', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: { event_id: id, client_id: this.identity.clientId, name: this.identity.name, status },
          });
        } else {
          await sb(`rsvps?event_id=eq.${id}&client_id=eq.${encodeURIComponent(this.identity.clientId)}`, { method: 'DELETE' });
        }
        ev.goingCount = Math.max(0, ev.goingCount + delta);
      } catch (err) {
        console.error('[store] rsvp failed', err);
        if (prev) this._myRsvps.set(id, prev); else this._myRsvps.delete(id);
        write(LS.rsvps, Object.fromEntries(this._myRsvps));
        throw new Error('Konnte nicht gespeichert werden.');
      }
    } else if (delta) {
      ev.goingCount = this._bumpLocalCount(id, 'going', delta);
    }

    this.emit('event-changed', { id });
    return { status, count: ev.goingCount };
  }

  /* ------------------------------- comments ------------------------------ */

  async listComments(occurrenceId, { force = false } = {}) {
    const id = seriesIdOf(occurrenceId);
    if (!force && this._comments.has(id)) return this._comments.get(id);

    let list = read(LS.comments, {})[id] || [];
    if (this.mode === 'supabase' && isUuid(id)) {
      try {
        const rows = await sb(`comments?select=*&event_id=eq.${id}&order=created_at.asc`);
        list = (rows || []).map((r) => ({
          id: r.id, author: r.author || 'anonym', body: r.body, createdAt: r.created_at,
          mine: r.client_id === this.identity.clientId,
        }));
      } catch (err) {
        console.error('[store] loading comments failed', err);
      }
    }
    this._comments.set(id, list);
    return list;
  }

  async addComment(occurrenceId, body) {
    const id = seriesIdOf(occurrenceId);
    const text = String(body || '').trim();
    if (!text) throw new Error('Kommentar ist leer.');
    if (text.length > 2000) throw new Error('Kommentar ist zu lang (max. 2000 Zeichen).');

    const author = this.identity.name || 'anonym';
    const comment = {
      id: uuid(), author, body: text, createdAt: new Date().toISOString(), mine: true,
    };

    if (this.mode === 'supabase' && isUuid(id)) {
      try {
        const [row] = await sb('comments', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: { event_id: id, client_id: this.identity.clientId, author, body: text },
        });
        comment.id = row.id;
        comment.createdAt = row.created_at;
      } catch (err) {
        console.error('[store] posting comment failed', err);
        throw new Error('Kommentar konnte nicht gesendet werden.');
      }
    } else {
      const all = read(LS.comments, {});
      all[id] = [...(all[id] || []), comment];
      write(LS.comments, all);
    }

    const list = [...(this._comments.get(id) || []), comment];
    this._comments.set(id, list);
    const ev = this.getById(id);
    if (ev) ev.commentCount = list.length;
    this.emit('event-changed', { id });
    return comment;
  }
}

export const store = new Store();
export { normalise as normaliseEvent };
