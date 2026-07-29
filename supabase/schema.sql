-- supabase/schema.sql
--
-- Schema for rosencri.me — a community board for subculture events in
-- Rosenheim, Germany. Backend is Supabase (Postgres + PostgREST + Storage),
-- called directly from the browser with the public anon key. There is no
-- server of our own, so all access control lives in Postgres Row Level
-- Security (RLS) policies below.
--
-- Safe to re-run: every statement is idempotent (CREATE TABLE IF NOT EXISTS,
-- DROP POLICY IF EXISTS before each CREATE POLICY, CREATE OR REPLACE VIEW).
-- Paste this whole file into the Supabase SQL editor and run it.

-- Needed for gen_random_uuid(). Supabase projects have pgcrypto available;
-- this is a no-op if it's already enabled.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  title         text not null check (char_length(title) between 1 and 200),
  description   text not null default '' check (char_length(description) <= 4000),
  location      text not null default '',
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  url           text not null default '',
  image_url     text not null default '',
  tags          text[] not null default '{}',
  source        text not null default 'manual' check (source in ('manual', 'poster', 'seed')),
  author_id     text not null default '',
  author_name   text not null default '',
  is_seed       boolean not null default false,
  status        text not null default 'published' check (status in ('published', 'hidden')),
  -- RFC 5545 RRULE *value* (no "RRULE:" prefix), '' for a one-off event.
  -- e.g. 'FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=MONTHLY;UNTIL=20261231T220000Z'
  rrule         text not null default ''
);

-- Existing installs: add the column without disturbing current rows.
alter table public.events add column if not exists rrule text not null default '';

create table if not exists public.likes (
  event_id   uuid not null references public.events(id) on delete cascade,
  client_id  text not null,
  created_at timestamptz not null default now(),
  primary key (event_id, client_id)
);

create table if not exists public.rsvps (
  event_id   uuid not null references public.events(id) on delete cascade,
  client_id  text not null,
  name       text not null default '',
  status     text not null check (status in ('going', 'maybe')),
  created_at timestamptz not null default now(),
  primary key (event_id, client_id)
);

create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid references public.events(id) on delete cascade,
  client_id  text not null default '',
  author     text not null default '',
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

create index if not exists events_starts_at_idx on public.events (starts_at);
create index if not exists events_status_idx on public.events (status);
create index if not exists comments_event_id_created_at_idx on public.comments (event_id, created_at);

-- ---------------------------------------------------------------------
-- events_with_counts view
--
-- All event columns plus like_count / going_count / comment_count, computed
-- via lateral subqueries rather than a GROUP BY so every event row is kept
-- even when it has zero likes/rsvps/comments. Chosen over an RPC function
-- so the browser can keep using plain PostgREST `select=*` / filtering /
-- ordering against this view exactly like a table.
-- ---------------------------------------------------------------------

create or replace view public.events_with_counts as
select
  e.*,
  coalesce(lc.like_count, 0)    as like_count,
  coalesce(rc.going_count, 0)   as going_count,
  coalesce(cc.comment_count, 0) as comment_count
from public.events e
left join lateral (
  select count(*) as like_count
  from public.likes l
  where l.event_id = e.id
) lc on true
left join lateral (
  select count(*) as going_count
  from public.rsvps r
  where r.event_id = e.id and r.status = 'going'
) rc on true
left join lateral (
  select count(*) as comment_count
  from public.comments c
  where c.event_id = e.id
) cc on true;

grant select on public.events_with_counts to anon;

-- ---------------------------------------------------------------------
-- Row Level Security
--
-- The `anon` role is what the browser uses via the public anon key. Since
-- anon clients are NOT authenticated, `client_id` is just a value the
-- client itself generates and sends (e.g. a random id persisted in
-- localStorage) — it is NOT a verified identity. Restricting DELETE on
-- likes/rsvps to "rows whose client_id matches what you send" (via an
-- `x-client-id` request header, see the policies below) is therefore
-- best-effort: it stops accidental cross-deleting from the normal UI, but a
-- motivated user can trivially spoof any client_id/header with a raw HTTP
-- request using the same public anon key. This is a deliberate,
-- honestly-documented trade-off for a no-backend static site.
-- NOTE for whoever wires up the frontend Supabase client (assets/js/store.js):
-- for the delete-your-own-like/rsvp policies below to do anything at all,
-- every DELETE request to `likes`/`rsvps` needs an `x-client-id` header set
-- to that same client's id, e.g. via
-- `createClient(url, key, { global: { headers: { 'x-client-id': clientId } } })`.
-- Without it, current_setting('request.headers', ...) is empty and the
-- delete policy will simply never match (delete becomes a no-op, not an
-- error).
-- Moderation of events/comments (hiding spam, editing typos, etc.) is done
-- by an admin through the Supabase dashboard, using the privileged
-- service_role key — never the anon key — which bypasses RLS entirely.
-- ---------------------------------------------------------------------

alter table public.events   enable row level security;
alter table public.likes    enable row level security;
alter table public.rsvps    enable row level security;
alter table public.comments enable row level security;

-- Fresh Supabase projects normally auto-grant anon/authenticated broad table
-- privileges in the public schema, but we grant explicitly too so this
-- schema doesn't silently depend on that project-level default. GRANT is
-- idempotent — re-running it is a no-op, and it does nothing without a
-- matching RLS policy (both a GRANT and a passing policy are required).
grant select, insert on public.events to anon;
grant select, insert, delete on public.likes to anon;
grant select, insert, delete on public.rsvps to anon;
grant select, insert on public.comments to anon;

-- events: public read of published events; public insert (new events go
-- straight in as 'published' by default); no UPDATE/DELETE for anon.
drop policy if exists "events_select_published" on public.events;
create policy "events_select_published"
  on public.events for select
  to anon
  using (status = 'published');

drop policy if exists "events_insert_anon" on public.events;
create policy "events_insert_anon"
  on public.events for insert
  to anon
  with check (true);

-- likes: public read, public insert, delete only your own (client_id-scoped).
drop policy if exists "likes_select_all" on public.likes;
create policy "likes_select_all"
  on public.likes for select
  to anon
  using (true);

drop policy if exists "likes_insert_anon" on public.likes;
create policy "likes_insert_anon"
  on public.likes for insert
  to anon
  with check (true);

-- "Delete only your own like": PostgREST exposes the incoming request's
-- headers as the `request.headers` GUC (a JSON object). We compare the
-- row's client_id against an `x-client-id` header the browser is expected
-- to send on delete requests (the same opaque, client-generated id it
-- writes into client_id on insert). This is a REAL restriction in the sense
-- that a row can only be deleted by a request presenting the matching
-- header — but it is still best-effort, NOT authentication: anon clients
-- have no verified identity, the anon key is shared by everyone, and anyone
-- issuing a raw HTTP request can set `x-client-id` to any value, including
-- someone else's. Treat this as "keeps the normal UI honest", not a
-- security boundary.
drop policy if exists "likes_delete_own" on public.likes;
create policy "likes_delete_own"
  on public.likes for delete
  to anon
  using (
    client_id = coalesce(
      current_setting('request.headers', true)::json->>'x-client-id',
      ''
    )
  );

-- rsvps: public read, public insert, delete only your own (best-effort, see above).
drop policy if exists "rsvps_select_all" on public.rsvps;
create policy "rsvps_select_all"
  on public.rsvps for select
  to anon
  using (true);

drop policy if exists "rsvps_insert_anon" on public.rsvps;
create policy "rsvps_insert_anon"
  on public.rsvps for insert
  to anon
  with check (true);

drop policy if exists "rsvps_delete_own" on public.rsvps;
create policy "rsvps_delete_own"
  on public.rsvps for delete
  to anon
  using (
    client_id = coalesce(
      current_setting('request.headers', true)::json->>'x-client-id',
      ''
    )
  );

-- comments: public read, public insert. No UPDATE/DELETE for anon —
-- moderation only, via the Supabase dashboard (service_role).
drop policy if exists "comments_select_all" on public.comments;
create policy "comments_select_all"
  on public.comments for select
  to anon
  using (true);

drop policy if exists "comments_insert_anon" on public.comments;
create policy "comments_insert_anon"
  on public.comments for insert
  to anon
  with check (true);

-- ---------------------------------------------------------------------
-- Storage: `posters` public bucket for uploaded event poster images.
--
-- 5 MB per-file limit and an allowed mime type set are enforced on the
-- bucket itself (file_size_limit / allowed_mime_types below) so oversized
-- or unexpected file types are rejected by Storage before they ever reach
-- a policy check.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'posters',
  'posters',
  true,
  5242880, -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- Deliberately NO anon SELECT policy on storage.objects.
--
-- The bucket is public, so files are already served to everyone through
--   /storage/v1/object/public/posters/<name>
-- which bypasses RLS. A `for select ... using (bucket_id = 'posters')` policy
-- adds nothing to that, but it *does* let anyone call the list endpoint and
-- enumerate every poster ever uploaded. Verified against a live project:
-- with the policy, `POST /storage/v1/object/list/posters` returns the full
-- file listing to an anonymous caller; without it the listing is empty while
-- public reads and anonymous uploads both still return 200.
drop policy if exists "posters_public_read" on storage.objects;

drop policy if exists "posters_anon_upload" on storage.objects;
create policy "posters_anon_upload"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'posters');

-- ---------------------------------------------------------------------
-- Seed data removal
--
-- Demo/placeholder events are inserted with is_seed = true (see
-- data/seed-events.json, merged into the calendar feed by
-- scripts/build-ics.mjs). Once real events exist, remove the demo data by
-- uncommenting and running the statement below in the SQL editor.
-- ---------------------------------------------------------------------

-- DELETE FROM events WHERE is_seed = true;
