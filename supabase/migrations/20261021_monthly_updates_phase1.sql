-- Monthly Updates, Phase 1: database.
--
-- Access model (differs from the original brief, by design):
--   * Every mu_ table has RLS on with no policies (deny-all) and no grants
--     to anon/authenticated, like the rest of the schema. db-gateway is the
--     real access layer.
--   * Readers (users.role = 'reader', one mu_readers row each) never touch
--     tables. db-gateway calls the mu_* functions below and passes the
--     reader's username taken from their session; the functions do all the
--     filtering, so a reader's request only ever returns what is tagged for
--     their profile.
--   * Only super uses the editor tables directly (Phase 2), through the
--     gateway. mu_notes and mu_reads are never reachable as tables, not
--     even for super; super sees only sent notes, via mu_admin_questions.
--   * Sections are written only by mu_publish, and a trigger refuses any
--     section row for a profile the section is hidden from, or an unmasked
--     row for a profile that must see it masked.
--   * New-customer numbers come from customer_first_orders (new-customer
--     parts 1 and 2).
--
-- Safe to run more than once. One transaction: all or nothing.

begin;

-- ── Types and constants ─────────────────────────────────────────────────

do $$
begin
  create type public.mu_profile as enum ('partner', 'investor', 'employee', 'prospect_investor', 'prospect_partner');
exception when duplicate_object then null;
end $$;

-- Section keys in reader tab order. EC data (P&L, Growth & Retention,
-- Scenario Planner) has no key, so it can never be stored as a section.
create or replace function public.mu_section_keys()
returns text[]
language sql
immutable
as $$
  select array['since_last_update', 'quick_look', 'summary', 'monthly_sales',
               'customer_activity', 'customer_summary', 'at_risk']
$$;

-- Reader tabs that can be recorded as viewed: the sections plus the two
-- item tabs.
create or replace function public.mu_tab_keys()
returns text[]
language sql
immutable
as $$
  select public.mu_section_keys() || array['asks', 'news']
$$;

-- ── Tables ──────────────────────────────────────────────────────────────

-- One row per reader account. Not a foreign key to users on purpose: when
-- the account is deleted this row stays (marked deleted) so sent notes and
-- read history keep their reader's name and profile.
create table if not exists public.mu_readers (
  username text primary key,
  profile public.mu_profile not null,
  display_name text not null check (btrim(display_name) <> ''),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text,
  deleted_at timestamptz
);

create table if not exists public.mu_updates (
  id uuid primary key default gen_random_uuid(),
  month date not null unique check (extract(day from month) = 1),
  status text not null default 'draft' check (status in ('draft', 'published')),
  summary_draft text not null default '',
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  published_by text,
  refreshed_at timestamptz,
  check ((status = 'published') = (published_at is not null))
);

create table if not exists public.mu_stories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  description text not null default '',
  current_stage text, -- suggested: Exploring, In talks, Pilot, Signed, Live, Paused
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mu_items (
  id uuid primary key default gen_random_uuid(),
  update_id uuid not null references public.mu_updates (id) on delete cascade,
  type text not null check (type in ('news', 'ask')),
  title text not null check (btrim(title) <> ''),
  body text not null default '',
  story_id uuid references public.mu_stories (id) on delete set null,
  stage text,
  author text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mu_items_update_idx on public.mu_items (update_id);
create index if not exists mu_items_story_idx on public.mu_items (story_id);

-- Audience tags. No row = hidden from that profile.
create table if not exists public.mu_item_tags (
  item_id uuid not null references public.mu_items (id) on delete cascade,
  profile public.mu_profile not null,
  primary key (item_id, profile)
);

create table if not exists public.mu_story_tags (
  story_id uuid not null references public.mu_stories (id) on delete cascade,
  profile public.mu_profile not null,
  primary key (story_id, profile)
);

-- Default section audience (the brief's Y / M / – table). Copied into
-- mu_section_audience whenever an update is created; editable per update.
create table if not exists public.mu_section_defaults (
  section_key text not null check (section_key = any (public.mu_section_keys())),
  profile public.mu_profile not null,
  mode text not null check (mode in ('show', 'mask')),
  primary key (section_key, profile)
);

insert into public.mu_section_defaults (section_key, profile, mode)
select k, p, 'show'
from unnest(array['since_last_update', 'quick_look', 'summary', 'monthly_sales', 'customer_activity']) k
cross join unnest(enum_range(null::public.mu_profile)) p
union all
select 'customer_summary', p::public.mu_profile, m
from (values ('partner', 'mask'), ('investor', 'mask'), ('employee', 'show'), ('prospect_investor', 'mask')) v(p, m)
union all
select 'at_risk', p::public.mu_profile, m
from (values ('investor', 'mask'), ('employee', 'show')) v(p, m)
on conflict do nothing;

-- Per-update section audience. No row = section hidden from that profile.
create table if not exists public.mu_section_audience (
  update_id uuid not null references public.mu_updates (id) on delete cascade,
  section_key text not null check (section_key = any (public.mu_section_keys())),
  profile public.mu_profile not null,
  mode text not null check (mode in ('show', 'mask')),
  primary key (update_id, section_key, profile)
);

-- Frozen data sections, written only by mu_publish.
create table if not exists public.mu_sections (
  id uuid primary key default gen_random_uuid(),
  update_id uuid not null references public.mu_updates (id) on delete cascade,
  section_key text not null check (section_key = any (public.mu_section_keys())),
  profile public.mu_profile not null,
  masked boolean not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (update_id, section_key, profile)
);

-- Reader notes and questions. One note per reader per target.
create table if not exists public.mu_notes (
  id uuid primary key default gen_random_uuid(),
  reader text not null references public.mu_readers (username),
  update_id uuid not null references public.mu_updates (id) on delete cascade,
  target_type text not null check (target_type in ('item', 'section')),
  target_id text not null,
  body text not null default '',
  sent_to_team boolean not null default false,
  sent_at timestamptz,
  team_reply text,
  replied_by text,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reader, update_id, target_type, target_id),
  check (sent_to_team = (sent_at is not null))
);
create index if not exists mu_notes_sent_idx on public.mu_notes (update_id) where sent_to_team;

create table if not exists public.mu_reads (
  reader text not null references public.mu_readers (username),
  update_id uuid not null references public.mu_updates (id) on delete cascade,
  first_opened_at timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  seconds integer not null default 0 check (seconds >= 0),
  sections_viewed text[] not null default '{}',
  primary key (reader, update_id)
);

-- Stable masking numbers: customer_key (same key as the new-customer
-- logic, lower(td_customer_name(customer))) -> "Customer #14".
create table if not exists public.mu_customer_aliases (
  customer_key text primary key,
  alias_no integer generated by default as identity unique,
  created_at timestamptz not null default now()
);

-- ── Guards ──────────────────────────────────────────────────────────────

-- New updates get the default section audience.
create or replace function public.mu_seed_section_audience()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.mu_section_audience (update_id, section_key, profile, mode)
  select new.id, d.section_key, d.profile, d.mode from public.mu_section_defaults d
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists trg_mu_updates_seed_audience on public.mu_updates;
create trigger trg_mu_updates_seed_audience
  after insert on public.mu_updates
  for each row execute function public.mu_seed_section_audience();

-- Publish state changes only through mu_publish / mu_unpublish.
create or replace function public.mu_guard_update_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('mu.publishing', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.published_at is not null or new.refreshed_at is not null then
      raise exception 'mu: new updates start as drafts';
    end if;
  elsif (new.status, new.published_at, new.published_by, new.refreshed_at)
        is distinct from (old.status, old.published_at, old.published_by, old.refreshed_at) then
    raise exception 'mu: publish state changes only through publish / unpublish';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_mu_updates_guard on public.mu_updates;
create trigger trg_mu_updates_guard
  before insert or update on public.mu_updates
  for each row execute function public.mu_guard_update_status();

-- A section row may only exist for a profile the section is shown to, and
-- must be masked where that profile's mode is 'mask'.
create or replace function public.mu_guard_section()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  m text;
begin
  if current_setting('mu.publishing', true) is distinct from 'on' then
    raise exception 'mu: sections are written only by publish';
  end if;
  select a.mode into m
  from public.mu_section_audience a
  where a.update_id = new.update_id and a.section_key = new.section_key and a.profile = new.profile;
  if m is null then
    raise exception 'mu: section % is hidden from %', new.section_key, new.profile;
  end if;
  if m = 'mask' and not new.masked then
    raise exception 'mu: section % must be masked for %', new.section_key, new.profile;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mu_sections_guard on public.mu_sections;
create trigger trg_mu_sections_guard
  before insert or update on public.mu_sections
  for each row execute function public.mu_guard_section();

-- Deleting a reader's account: delete their private notes, keep notes they
-- sent to the team (with replies) and their read history; mark the reader
-- deleted so they drop out of future read summaries.
create or replace function public.mu_on_user_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.mu_notes where reader = old.username and not sent_to_team;
  update public.mu_readers
     set active = false, deleted_at = coalesce(deleted_at, now())
   where username = old.username;
  return null;
end;
$$;

drop trigger if exists trg_users_mu_reader_cleanup on public.users;
create trigger trg_users_mu_reader_cleanup
  after delete on public.users
  for each row execute function public.mu_on_user_deleted();

-- Touch updated_at on editor tables.
create or replace function public.mu_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_mu_items_touch on public.mu_items;
create trigger trg_mu_items_touch before update on public.mu_items for each row execute function public.mu_touch();
drop trigger if exists trg_mu_stories_touch on public.mu_stories;
create trigger trg_mu_stories_touch before update on public.mu_stories for each row execute function public.mu_touch();

-- ── Reader functions (gateway passes p_username from the session) ───────

-- The caller's reader row, or 'mu: forbidden'.
create or replace function public.mu_reader(p_username text)
returns public.mu_readers
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r public.mu_readers;
begin
  select m.* into r
  from public.mu_readers m
  join public.users u on u.username = m.username
  where m.username = p_username and m.active and m.deleted_at is null and u.role = 'reader';
  if not found then
    raise exception 'mu: forbidden';
  end if;
  return r;
end;
$$;

-- Is this item / section of this published update visible to the profile?
create or replace function public.mu_item_visible(p_item_id uuid, p_profile public.mu_profile)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.mu_items i
    join public.mu_updates u on u.id = i.update_id and u.status = 'published'
    join public.mu_item_tags t on t.item_id = i.id and t.profile = p_profile
    where i.id = p_item_id)
$$;

create or replace function public.mu_section_visible(p_update_id uuid, p_section_key text, p_profile public.mu_profile)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.mu_sections s
    join public.mu_updates u on u.id = s.update_id and u.status = 'published'
    join public.mu_section_audience a
      on a.update_id = s.update_id and a.section_key = s.section_key and a.profile = s.profile
    where s.update_id = p_update_id and s.section_key = p_section_key and s.profile = p_profile
      and (a.mode = 'show' or s.masked))
$$;

-- Archive: published months, newest first.
create or replace function public.mu_list_updates(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.mu_reader(p_username);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'month', u.month, 'published_at', u.published_at,
                                        'refreshed_at', u.refreshed_at) order by u.month desc)
    from public.mu_updates u
    where u.status = 'published'), '[]'::jsonb);
end;
$$;

-- One published update, filtered to the reader's profile.
create or replace function public.mu_get_update(p_username text, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r public.mu_readers;
  u public.mu_updates;
begin
  r := public.mu_reader(p_username);
  select * into u from public.mu_updates where month = p_month and status = 'published';
  if not found then
    raise exception 'mu: not found';
  end if;
  return jsonb_build_object(
    'id', u.id,
    'month', u.month,
    'published_at', u.published_at,
    'refreshed_at', u.refreshed_at,
    'profile', r.profile,
    'display_name', r.display_name,
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('key', s.section_key, 'masked', s.masked, 'payload', s.payload)
                       order by array_position(public.mu_section_keys(), s.section_key))
      from public.mu_sections s
      where s.update_id = u.id and s.profile = r.profile
        and public.mu_section_visible(u.id, s.section_key, r.profile)), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'type', i.type, 'title', i.title, 'body', i.body, 'stage', i.stage,
               'updated_at', i.updated_at,
               'story', case when st.id is not null
                             then jsonb_build_object('id', st.id, 'name', st.name, 'current_stage', st.current_stage)
                        end)
             order by (i.type = 'ask') desc, i.sort_order, i.created_at)
      from public.mu_items i
      join public.mu_item_tags t on t.item_id = i.id and t.profile = r.profile
      left join public.mu_stories st
        on st.id = i.story_id
       and exists (select 1 from public.mu_story_tags stt where stt.story_id = st.id and stt.profile = r.profile)
      where i.update_id = u.id), '[]'::jsonb));
end;
$$;

-- A story's timeline across published months, if the story is tagged for
-- the reader; only items tagged for them.
create or replace function public.mu_story_timeline(p_username text, p_story_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r public.mu_readers;
  st public.mu_stories;
begin
  r := public.mu_reader(p_username);
  select s.* into st
  from public.mu_stories s
  join public.mu_story_tags t on t.story_id = s.id and t.profile = r.profile
  where s.id = p_story_id;
  if not found then
    raise exception 'mu: not found';
  end if;
  return jsonb_build_object(
    'id', st.id, 'name', st.name, 'description', st.description, 'current_stage', st.current_stage,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.id, 'month', u.month, 'type', i.type, 'title', i.title,
                                          'body', i.body, 'stage', i.stage)
                       order by u.month, i.sort_order, i.created_at)
      from public.mu_items i
      join public.mu_updates u on u.id = i.update_id and u.status = 'published'
      join public.mu_item_tags t on t.item_id = i.id and t.profile = r.profile
      where i.story_id = st.id), '[]'::jsonb));
end;
$$;

-- The reader's own notes, newest month first.
create or replace function public.mu_my_notes(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r public.mu_readers;
begin
  r := public.mu_reader(p_username);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', n.id, 'update_id', n.update_id, 'month', u.month,
             'target_type', n.target_type, 'target_id', n.target_id,
             'target_title', case when n.target_type = 'item' and public.mu_item_visible(i.id, r.profile)
                                  then i.title end,
             'body', n.body, 'sent_to_team', n.sent_to_team, 'sent_at', n.sent_at,
             'team_reply', n.team_reply, 'replied_at', n.replied_at,
             'created_at', n.created_at, 'updated_at', n.updated_at)
           order by u.month desc, n.created_at)
    from public.mu_notes n
    join public.mu_updates u on u.id = n.update_id
    left join public.mu_items i on n.target_type = 'item' and i.id::text = n.target_id
    where n.reader = r.username), '[]'::jsonb);
end;
$$;

-- Create or update the reader's note on something they can see.
-- p_send: true = send to the Tezz team, false = unsend, null = unchanged.
create or replace function public.mu_save_note(
  p_username text, p_update_id uuid, p_target_type text, p_target_id text, p_body text, p_send boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.mu_readers;
  n public.mu_notes;
begin
  r := public.mu_reader(p_username);
  if p_target_type = 'item' then
    if p_target_id !~ '^[0-9a-fA-F-]{36}$'
       or not exists (select 1 from public.mu_items i where i.id = p_target_id::uuid and i.update_id = p_update_id)
       or not public.mu_item_visible(p_target_id::uuid, r.profile) then
      raise exception 'mu: not found';
    end if;
  elsif p_target_type = 'section' then
    if not public.mu_section_visible(p_update_id, p_target_id, r.profile) then
      raise exception 'mu: not found';
    end if;
  else
    raise exception 'mu: invalid target type';
  end if;
  if length(coalesce(p_body, '')) > 10000 then
    raise exception 'mu: note too long';
  end if;

  insert into public.mu_notes as x (reader, update_id, target_type, target_id, body, sent_to_team, sent_at)
  values (r.username, p_update_id, p_target_type, p_target_id, coalesce(p_body, ''),
          coalesce(p_send, false), case when p_send then now() end)
  on conflict (reader, update_id, target_type, target_id) do update
     set body = excluded.body,
         sent_to_team = coalesce(p_send, x.sent_to_team),
         sent_at = case when p_send is null then x.sent_at
                        when p_send then coalesce(x.sent_at, now())
                        else null end,
         updated_at = now()
  returning * into n;

  return jsonb_build_object('id', n.id, 'sent_to_team', n.sent_to_team, 'sent_at', n.sent_at,
                            'updated_at', n.updated_at);
end;
$$;

create or replace function public.mu_delete_note(p_username text, p_note_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.mu_readers;
begin
  r := public.mu_reader(p_username);
  delete from public.mu_notes where id = p_note_id and reader = r.username;
  if not found then
    raise exception 'mu: not found';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Read tracking. p_seconds is time since the last call, capped at 5 min so
-- a forgotten tab can't inflate it.
create or replace function public.mu_record_read(p_username text, p_update_id uuid, p_seconds integer, p_tab text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.mu_readers;
  secs integer := least(greatest(coalesce(p_seconds, 0), 0), 300);
begin
  r := public.mu_reader(p_username);
  if not exists (select 1 from public.mu_updates where id = p_update_id and status = 'published') then
    raise exception 'mu: not found';
  end if;
  if p_tab is not null and not (p_tab = any (public.mu_tab_keys())) then
    raise exception 'mu: invalid tab';
  end if;
  insert into public.mu_reads as x (reader, update_id, seconds, sections_viewed)
  values (r.username, p_update_id, secs, case when p_tab is null then '{}'::text[] else array[p_tab] end)
  on conflict (reader, update_id) do update
     set last_opened_at = now(),
         seconds = x.seconds + secs,
         sections_viewed = case when p_tab is null or p_tab = any (x.sections_viewed) then x.sections_viewed
                                else x.sections_viewed || p_tab end;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── Super functions (gateway allows only role super) ────────────────────

-- Questions inbox: sent notes only. Private notes are never returned.
create or replace function public.mu_admin_questions(p_update_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'update_id', n.update_id, 'month', u.month,
           'reader', n.reader, 'display_name', m.display_name, 'profile', m.profile,
           'reader_deleted', m.deleted_at is not null,
           'target_type', n.target_type, 'target_id', n.target_id,
           'target_title', i.title,
           'body', n.body, 'sent_at', n.sent_at,
           'team_reply', n.team_reply, 'replied_by', n.replied_by, 'replied_at', n.replied_at)
         order by n.sent_at desc), '[]'::jsonb)
  from public.mu_notes n
  join public.mu_readers m on m.username = n.reader
  join public.mu_updates u on u.id = n.update_id
  left join public.mu_items i on n.target_type = 'item' and i.id::text = n.target_id
  where n.sent_to_team
    and (p_update_id is null or n.update_id = p_update_id)
$$;

create or replace function public.mu_admin_reply(p_by text, p_note_id uuid, p_reply text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.mu_notes
     set team_reply = nullif(btrim(coalesce(p_reply, '')), ''),
         replied_by = p_by,
         replied_at = now()
   where id = p_note_id and sent_to_team;
  if not found then
    raise exception 'mu: not found';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- "9 of 14 readers opened · avg 6 min". Expected readers are those whose
-- account existed when the update was published, so the figure for a past
-- month doesn't change when readers are added or deleted later.
create or replace function public.mu_admin_read_summary(p_update_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  u public.mu_updates;
begin
  select * into u from public.mu_updates where id = p_update_id;
  if not found then
    raise exception 'mu: not found';
  end if;
  return (
    with expected as (
      select m.* from public.mu_readers m
      where u.published_at is not null
        and m.created_at <= u.published_at
        and (m.deleted_at is null or m.deleted_at > u.published_at)
    ),
    per_reader as (
      select coalesce(e.username, rd.reader) as username,
             coalesce(e.display_name, m2.display_name) as display_name,
             coalesce(e.profile, m2.profile) as profile,
             rd.first_opened_at, rd.last_opened_at, rd.seconds, rd.sections_viewed
      from expected e
      full join (select * from public.mu_reads where update_id = u.id) rd on rd.reader = e.username
      left join public.mu_readers m2 on m2.username = rd.reader
    )
    select jsonb_build_object(
      'update_id', u.id, 'month', u.month,
      'readers_expected', (select count(*) from expected),
      'readers_opened', (select count(*) from per_reader where first_opened_at is not null),
      'avg_seconds', (select coalesce(round(avg(seconds)), 0) from per_reader where first_opened_at is not null),
      'readers', coalesce((select jsonb_agg(to_jsonb(p) order by p.first_opened_at nulls last, p.display_name)
                           from per_reader p), '[]'::jsonb))
  );
end;
$$;

-- Monthly new customers (first delivered/collected/assigned order), total
-- and by the customer type on that first order. p_from / p_to are months.
create or replace function public.mu_new_customer_counts(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with firsts as (
    select date_trunc('month', f.first_order_date)::date as month, o.customer_type
    from public.customer_first_orders f
    join public.orders o on o.order_id = f.first_order_id
    where f.first_order_date >= date_trunc('month', p_from)
      and f.first_order_date < date_trunc('month', p_to) + interval '1 month'
  ),
  months as (
    select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as month
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', m.month,
           'total', (select count(*) from firsts f where f.month = m.month),
           'b2b', (select count(*) from firsts f where f.month = m.month and f.customer_type = 'B2B'),
           'b2c', (select count(*) from firsts f where f.month = m.month and coalesce(f.customer_type, 'B2C') <> 'B2B'))
         order by m.month), '[]'::jsonb)
  from months m
$$;

-- Alias numbers for customer keys, creating any that are missing.
create or replace function public.mu_ensure_aliases(p_keys text[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.mu_customer_aliases (customer_key)
  select distinct k from unnest(p_keys) k
  where k is not null and k <> ''
  order by 1
  on conflict do nothing;
  return coalesce((
    select jsonb_object_agg(a.customer_key, a.alias_no)
    from public.mu_customer_aliases a
    where a.customer_key = any (p_keys)), '{}'::jsonb);
end;
$$;

-- Create a reader account: users row (role reader, must change password on
-- first login; the password trigger hashes it) + mu_readers row, together.
create or replace function public.mu_create_reader(
  p_by text, p_username text, p_password text, p_email text, p_profile public.mu_profile, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.mu_readers where username = p_username) then
    raise exception 'mu: that username belonged to a former reader; choose another';
  end if;
  if exists (select 1 from public.users where username = p_username) then
    raise exception 'mu: user already exists';
  end if;
  if btrim(coalesce(p_display_name, '')) = '' then
    raise exception 'mu: display name required';
  end if;
  insert into public.users (username, password, role, email, must_change_password)
  values (p_username, p_password, 'reader', coalesce(p_email, ''), true);
  insert into public.mu_readers (username, profile, display_name, created_by)
  values (p_username, p_profile, btrim(p_display_name), p_by);
  return jsonb_build_object('ok', true);
end;
$$;

-- Publish, or refresh and republish: replaces all of the update's sections
-- in one transaction. p_sections: [{section_key, profile, masked, payload}].
-- The section guard refuses hidden profiles and unmasked rows for masked
-- profiles, which rolls back the whole publish.
create or replace function public.mu_publish(p_by text, p_update_id uuid, p_sections jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u public.mu_updates;
  n integer;
begin
  select * into u from public.mu_updates where id = p_update_id for update;
  if not found then
    raise exception 'mu: not found';
  end if;
  if jsonb_typeof(p_sections) is distinct from 'array' then
    raise exception 'mu: sections must be an array';
  end if;
  perform set_config('mu.publishing', 'on', true);

  delete from public.mu_sections where update_id = u.id;
  insert into public.mu_sections (update_id, section_key, profile, masked, payload)
  select u.id, s->>'section_key', (s->>'profile')::public.mu_profile, coalesce((s->>'masked')::boolean, false),
         coalesce(s->'payload', 'null'::jsonb)
  from jsonb_array_elements(p_sections) s;
  get diagnostics n = row_count;

  if u.status = 'draft' then
    update public.mu_updates
       set status = 'published', published_at = now(), published_by = p_by, refreshed_at = null
     where id = u.id;
  else
    update public.mu_updates set refreshed_at = now() where id = u.id;
  end if;

  perform set_config('mu.publishing', 'off', true);
  return jsonb_build_object('ok', true, 'sections', n, 'republished', u.status = 'published');
end;
$$;

-- Back to draft (for mistakes): readers stop seeing it; sections removed.
create or replace function public.mu_unpublish(p_by text, p_update_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('mu.publishing', 'on', true);
  delete from public.mu_sections where update_id = p_update_id;
  update public.mu_updates
     set status = 'draft', published_at = null, published_by = null, refreshed_at = null
   where id = p_update_id and status = 'published';
  if not found then
    perform set_config('mu.publishing', 'off', true);
    raise exception 'mu: not found';
  end if;
  perform set_config('mu.publishing', 'off', true);
  return jsonb_build_object('ok', true);
end;
$$;

-- ── Lock-down ───────────────────────────────────────────────────────────

do $$
declare
  t text;
  f record;
begin
  foreach t in array array['mu_readers', 'mu_updates', 'mu_stories', 'mu_items', 'mu_item_tags', 'mu_story_tags',
                           'mu_section_defaults', 'mu_section_audience', 'mu_sections', 'mu_notes', 'mu_reads',
                           'mu_customer_aliases']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;

  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'mu\_%' escape '\')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

grant usage on type public.mu_profile to service_role;

commit;

notify pgrst, 'reload schema';

-- Check (the result the SQL Editor shows). Expected: tables 12,
-- functions 25, defaults 31, rls_off 0.
select (select count(*) from pg_tables where schemaname = 'public' and tablename like 'mu\_%' escape '\') as tables,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'mu\_%' escape '\') as functions,
       (select count(*) from public.mu_section_defaults) as defaults,
       (select count(*) from pg_tables where schemaname = 'public' and tablename like 'mu\_%' escape '\' and not rowsecurity) as rls_off;
