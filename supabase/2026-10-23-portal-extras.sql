-- supabase/2026-10-23-portal-extras.sql
--
-- Client portal — the pieces taken from the Sonas couple portal, 23 Oct 2026.
--
-- NOT APPLIED. Written and tested against a local replica whose 80 wp_*
-- function bodies were checksummed identical to production first (see
-- portal-extras-test.sql for how the replica is built). Apply in the Supabase
-- SQL editor as one script, then run portal-extras-test.sql.
--
-- What it adds:
--
--   1. Guests: an RSVP (yes / no / maybe / not heard) and a wedding-party role.
--   2. "Ready for the venue": the client marks a tab finished; staff see it,
--      see whether it has changed since, and can reopen it with a note. It
--      warns, it never locks — the house rule everywhere else.
--   3. Timeline: a ceremony time, rows that move with it, and questions on a
--      row that the client answers ("Who is giving the speeches?").
--   4. Items the client is bringing, with a typical-items list, and staff
--      ticks for received and collected.
--   5. Add-ons: a priced catalogue the client requests from; staff approve or
--      decline. Approval does NOT touch Xero — it tells staff what to invoice.
--   6. Which sections an event shows: a standard set per event type (Wedding,
--      Party, Wake, Other) and per-event ticks that add or remove.
--   7. Overview: one venue cover photo for every event type, and venue
--      documents as links.
--   8. Food, for wakes and parties: packages priced per head, numbers,
--      dietary notes. The bar is always a pay bar.
--   9. Music: descriptions and Spotify links, seeded by event type.
--  10. Marketing: a pre-ticked "keep in touch" choice per login. It is the
--      opt-out that soft opt-in requires, not consent — see the note at §10.
--
-- House rules followed: RLS on with no policies; every read and write through
-- a SECURITY DEFINER function; no client function takes an id that selects
-- whose data it returns; payloads are allowlists; EXECUTE revoked from public,
-- anon and authenticated by name and granted back. Live functions are changed
-- by reading them out of the catalogue and patching an anchor that must occur
-- exactly once — never by pasting a body back.

begin;

-- ── patch helper (session-only) ─────────────────────────────────────────────
-- Reads the live definition, refuses unless the anchor occurs exactly once,
-- skips if the marker shows the patch is already in. CREATE OR REPLACE keeps
-- the function's existing grants.
create or replace function pg_temp.patch_fn(p_name text, p_anchor text, p_new text, p_marker text)
returns void language plpgsql as $$
declare def text; hits int; n int;
begin
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = p_name;
  if n <> 1 then raise exception '%: expected one function, found %', p_name, n; end if;

  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = p_name;

  if position(p_marker in def) > 0 then
    raise notice '% already patched (%), skipped', p_name, p_marker;
    return;
  end if;
  hits := (length(def) - length(replace(def, p_anchor, ''))) / length(p_anchor);
  if hits <> 1 then
    raise exception '%: anchor found % times, expected 1 — nothing changed', p_name, hits;
  end if;
  execute replace(def, p_anchor, p_new);
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- 1. GUESTS — RSVP and role
-- ════════════════════════════════════════════════════════════════════════════
-- NULL rsvp means "not heard yet", which is most people for most of the year.
-- Role is free text with suggestions in the form, because "Mother of the bride"
-- does not fit every wedding and a fixed list would say so to some couples.

alter table public.wp_guests add column if not exists rsvp text;
alter table public.wp_guests add column if not exists role text;
alter table public.wp_guests drop constraint if exists wp_guests_rsvp_check;
alter table public.wp_guests add constraint wp_guests_rsvp_check
  check (rsvp is null or rsvp in ('yes', 'no', 'maybe'));

-- One function for both, rather than new parameters on wp_add_guest and
-- wp_update_guest: adding a parameter makes an overload, and every existing
-- caller would go ambiguous. NULL leaves a field alone; '' clears it.
create or replace function public.wp_set_guest_extras(p_id uuid, p_rsvp text default null, p_role text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_rsvp is not null and p_rsvp not in ('', 'yes', 'no', 'maybe') then
    return jsonb_build_object('ok', false, 'error', 'bad_rsvp');
  end if;
  -- The event clause is the security of this function: it takes a guest id.
  update wp_guests
     set rsvp = case when p_rsvp is null then rsvp else nullif(p_rsvp, '') end,
         role = case when p_role is null then role else left(nullif(trim(p_role), ''), 40) end,
         updated_at = now()
   where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  perform wp_log('guests', 'updated a guest''s reply or role');
  return jsonb_build_object('ok', true);
end $function$;

select pg_temp.patch_fn('wp_get_guests',
  $a$'staying_where', g.staying_where,$a$,
  $a$'staying_where', g.staying_where,
               'rsvp', g.rsvp, 'role', g.role,$a$,
  $a$'rsvp', g.rsvp$a$);


-- ════════════════════════════════════════════════════════════════════════════
-- 2. "READY FOR THE VENUE"
-- ════════════════════════════════════════════════════════════════════════════
-- One row per tab the couple has said is finished. "Changed since" is worked
-- out from the change log rather than stored, so it cannot go stale: any
-- change the couple makes in that area after they said "ready" shows.

create table if not exists public.wp_section_status (
  event_id     integer not null,
  section      text    not null check (section in ('guests','timeline','suppliers','layout','details','items','food','music','drinks','uploads')),
  state        text    not null check (state in ('ready','reopened')),
  ready_at     timestamptz,
  ready_by     text,
  reopened_at  timestamptz,
  reopened_by  uuid references auth.users(id) on delete set null,
  reopen_note  text,
  primary key (event_id, section)
);
alter table public.wp_section_status enable row level security;
revoke all on table public.wp_section_status from anon, authenticated;

-- Section → the area its functions write to the change log under.
create or replace function public.wp_section_area(p_section text)
returns text language sql immutable set search_path to 'public' as $function$
  select case p_section
    when 'guests'    then 'guests'
    when 'timeline'  then 'timeline'
    when 'suppliers' then 'suppliers'
    when 'layout'    then 'table plan'
    when 'details'   then 'venue form'
    when 'items'     then 'items'
    when 'food'      then 'food'
    when 'music'     then 'music'
    when 'drinks'    then 'drinks'
    when 'uploads'   then 'uploads'
  end;
$function$;

-- Internal: the status list for one event. Not callable by clients — they
-- reach it only through functions that resolve their own event first.
create or replace function public.wp_section_rows(p_event integer)
returns jsonb language sql stable security definer set search_path to 'public', 'extensions' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'section',     s.section,
           'state',       s.state,
           'ready_at',    s.ready_at,
           'ready_by',    s.ready_by,
           'reopened_at', s.reopened_at,
           'reopen_note', s.reopen_note,
           'changed_since', s.state = 'ready' and exists (
               select 1 from wp_change_log c
                where c.event_id = s.event_id
                  and c.area = wp_section_area(s.section)
                  and c.at > s.ready_at))
         order by s.section), '[]'::jsonb)
    from wp_section_status s
   where s.event_id = p_event;
$function$;

create or replace function public.wp_get_sections()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object('ok', true, 'sections', wp_section_rows(v_event));
end $function$;

-- p_ready true: "we are done with this". false: "we need to change something"
-- — the couple can take it back themselves; nothing here locks.
create or replace function public.wp_set_section_ready(p_section text, p_ready boolean)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if wp_section_area(p_section) is null then
    return jsonb_build_object('ok', false, 'error', 'bad_section');
  end if;

  if coalesce(p_ready, false) then
    insert into wp_section_status (event_id, section, state, ready_at, ready_by)
    values (v_event, p_section, 'ready', now(), lower(coalesce(auth.jwt() ->> 'email', '')))
    on conflict (event_id, section) do update
      set state = 'ready', ready_at = now(), ready_by = excluded.ready_by;
    perform wp_log('sections', p_section || ' marked ready for the venue');
  else
    delete from wp_section_status where event_id = v_event and section = p_section;
    perform wp_log('sections', p_section || ' taken back to change');
  end if;
  return jsonb_build_object('ok', true, 'sections', wp_section_rows(v_event));
end $function$;

create or replace function public.wp_admin_sections(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'sections', wp_section_rows(p_event_id));
end $function$;

-- Staff hand a finished tab back with a note ("can you add the ushers?").
create or replace function public.wp_admin_reopen_section(p_event_id integer, p_section text, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if wp_section_area(p_section) is null then
    return jsonb_build_object('ok', false, 'error', 'bad_section');
  end if;
  update wp_section_status
     set state = 'reopened', reopened_at = now(), reopened_by = auth.uid(),
         reopen_note = left(nullif(trim(coalesce(p_note, '')), ''), 500)
   where event_id = p_event_id and section = p_section;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_ready'); end if;
  return jsonb_build_object('ok', true, 'sections', wp_section_rows(p_event_id));
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. TIMELINE — ceremony time, rows that follow it, and questions
-- ════════════════════════════════════════════════════════════════════════════

-- Per-event extras that are the client's, not the diary's. The portal never
-- writes the events array, so the ceremony time lives here; staff see it in
-- the portal admin panel.
create table if not exists public.wp_event_profile (
  event_id         integer primary key,
  ceremony_time    time,
  music_seeded_at  timestamptz,   -- the suggested music lines go in once, not again after a delete
  updated_at       timestamptz not null default now()
);
alter table public.wp_event_profile enable row level security;
revoke all on table public.wp_event_profile from anon, authenticated;

-- rel_minutes: minutes after the ceremony (negative = before). NULL = a fixed
-- time. Only ever set on the event day.
-- prompts: one question per line. answers: a json array, one per question.
alter table public.wp_timeline_template add column if not exists rel_minutes integer;
alter table public.wp_timeline_template add column if not exists prompts text;
alter table public.wp_timeline add column if not exists rel_minutes integer;
alter table public.wp_timeline add column if not exists prompts text;
alter table public.wp_timeline add column if not exists answers jsonb;

-- Minutes from a to b, read the way a wedding day reads: from six hours before
-- to eighteen after, so carriages at 00:30 after a 13:00 ceremony is +690, not
-- -750. time - time alone cannot tell those apart.
create or replace function public.wp_minutes_after(p_from time, p_to time)
returns integer language sql immutable set search_path to 'public' as $function$
  select (((extract(epoch from (p_to - p_from)) / 60)::int + 360) % 1440 + 1440) % 1440 - 360;
$function$;

create or replace function public.wp_set_ceremony_time(p_time time)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_moved integer := 0;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  insert into wp_event_profile (event_id, ceremony_time, updated_at)
  values (v_event, p_time, now())
  on conflict (event_id) do update set ceremony_time = excluded.ceremony_time, updated_at = now();

  -- Clearing the time moves nothing: the rows keep where they are and keep
  -- following, ready for when a time is set again.
  if p_time is not null then
    update wp_timeline
       set start_time = (p_time + make_interval(mins => rel_minutes))::time
     where event_id = v_event and day_key = 'event'
       and rel_minutes is not null and not locked and not pinned;
    get diagnostics v_moved = row_count;
  end if;

  perform wp_log('timeline', 'set the ceremony time to ' || coalesce(to_char(p_time, 'HH24:MI'), 'not set'));
  return jsonb_build_object('ok', true, 'moved', v_moved);
end $function$;

-- Make one row follow the ceremony (from where it sits now), or stop following.
create or replace function public.wp_set_block_follows(p_id uuid, p_follow boolean)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_cer   time;
  b       wp_timeline%rowtype;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select * into b from wp_timeline where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if b.locked then return jsonb_build_object('ok', false, 'error', 'locked'); end if;

  if coalesce(p_follow, false) then
    if b.day_key <> 'event' then return jsonb_build_object('ok', false, 'error', 'not_event_day'); end if;
    select ceremony_time into v_cer from wp_event_profile where event_id = v_event;
    if v_cer is null then return jsonb_build_object('ok', false, 'error', 'no_ceremony_time'); end if;
    update wp_timeline set rel_minutes = wp_minutes_after(v_cer, b.start_time) where id = p_id;
  else
    update wp_timeline set rel_minutes = null where id = p_id;
  end if;
  perform wp_log('timeline', 'changed whether a block follows the ceremony');
  return jsonb_build_object('ok', true);
end $function$;

-- Answers to a row's questions, as a json array of strings in question order.
create or replace function public.wp_answer_block(p_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_clean jsonb;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) > 20 then
    return jsonb_build_object('ok', false, 'error', 'bad_answers');
  end if;
  -- Strings only, each trimmed and capped. Anything else becomes an empty answer.
  select coalesce(jsonb_agg(to_jsonb(left(trim(case when jsonb_typeof(a) = 'string' then a #>> '{}' else '' end), 500))
                            order by i), '[]'::jsonb)
    into v_clean
    from jsonb_array_elements(p_answers) with ordinality as t(a, i);

  update wp_timeline set answers = v_clean where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('timeline', 'answered questions on a block');
  return jsonb_build_object('ok', true);
end $function$;

-- Moving a following row by hand makes it a fixed time — the couple meant that
-- time. The UI says so. Comparing with the old value matters: the edit form
-- always sends the start time, changed or not.
select pg_temp.patch_fn('wp_update_block',
  $a$pinned       = coalesce(p_pinned, pinned)$a$,
  $a$pinned       = coalesce(p_pinned, pinned),
         rel_minutes  = case when p_start_time is not null and p_start_time <> start_time
                             then null else rel_minutes end$a$,
  $a$rel_minutes  = case when p_start_time$a$);

-- Seeding copies the new columns and, if the ceremony time is already known,
-- places the following rows from it.
select pg_temp.patch_fn('wp_get_timeline',
  $a$insert into wp_timeline (event_id, day_key, start_time, duration_min, title, notes, locked, sort)
    select v_event, t.day_key, t.start_time, t.duration_min, t.title, t.notes, false, t.sort$a$,
  $a$insert into wp_timeline (event_id, day_key, start_time, duration_min, title, notes, locked, sort,
                             rel_minutes, prompts)
    select v_event, t.day_key,
           coalesce(case when t.day_key = 'event' and t.rel_minutes is not null
                         then ((select p.ceremony_time from wp_event_profile p where p.event_id = v_event)
                               + make_interval(mins => t.rel_minutes))::time end,
                    t.start_time),
           t.duration_min, t.title, t.notes, false, t.sort,
           case when t.day_key = 'event' then t.rel_minutes end, t.prompts$a$,
  $a$rel_minutes, prompts)$a$);

select pg_temp.patch_fn('wp_get_timeline',
  $a$'locked', b.locked, 'pinned', b.pinned)$a$,
  $a$'locked', b.locked, 'pinned', b.pinned,
               'rel_minutes', b.rel_minutes, 'prompts', b.prompts, 'answers', b.answers)$a$,
  $a$'rel_minutes', b.rel_minutes, 'prompts'$a$);

select pg_temp.patch_fn('wp_get_timeline',
  $a$'event_type', v_type,$a$,
  $a$'event_type', v_type,
    'ceremony_time', (select p.ceremony_time from wp_event_profile p where p.event_id = v_event),$a$,
  $a$'ceremony_time', (select p.ceremony_time$a$);

-- Staff see the answers and the ceremony time.
select pg_temp.patch_fn('wp_admin_event_timeline',
  $a$'title', b.title, 'notes', b.notes, 'supplier_name', s.name, 'locked', b.locked)$a$,
  $a$'title', b.title, 'notes', b.notes, 'supplier_name', s.name, 'locked', b.locked,
               'rel_minutes', b.rel_minutes, 'prompts', b.prompts, 'answers', b.answers)$a$,
  $a$'prompts', b.prompts, 'answers', b.answers$a$);

select pg_temp.patch_fn('wp_admin_event_timeline',
  $a$'ok', true, 'event_type', v_type, 'couple', v_couple,$a$,
  $a$'ok', true, 'event_type', v_type, 'couple', v_couple,
    'ceremony_time', (select p.ceremony_time from wp_event_profile p where p.event_id = p_event_id),$a$,
  $a$'ceremony_time', (select p.ceremony_time from wp_event_profile p where p.event_id = p_event_id)$a$);

-- The template editor reads and writes the two new columns.
select pg_temp.patch_fn('wp_admin_templates',
  $a$'notes', t.notes, 'locked', t.locked, 'sort', t.sort)$a$,
  $a$'notes', t.notes, 'locked', t.locked, 'sort', t.sort,
                            'rel_minutes', t.rel_minutes, 'prompts', t.prompts)$a$,
  $a$'rel_minutes', t.rel_minutes, 'prompts', t.prompts$a$);

select pg_temp.patch_fn('wp_admin_save_timeline_template',
  $a$insert into wp_timeline_template (event_type, day_key, start_time, duration_min, title, notes, locked, sort)$a$,
  $a$insert into wp_timeline_template (event_type, day_key, start_time, duration_min, title, notes, locked, sort,
                                    rel_minutes, prompts)$a$,
  $a$locked, sort,
                                    rel_minutes, prompts)$a$);

select pg_temp.patch_fn('wp_admin_save_timeline_template',
  $a$coalesce((e ->> 'sort')::int, ord * 10)$a$,
  $a$coalesce((e ->> 'sort')::int, ord * 10),
         case when e ->> 'day_key' = 'event'
              then greatest(-720, least(1440, nullif(e ->> 'rel_minutes', '')::int)) end,
         left(nullif(trim(coalesce(e ->> 'prompts', '')), ''), 1000)$a$,
  $a$left(nullif(trim(coalesce(e ->> 'prompts', '')), ''), 1000)$a$);

-- Seeding is first-read-wins, and two first reads at once both found nothing
-- and both seeded: the Overview now reads the checklist as well as the
-- Checklist tab, and React's development mode calls every effect twice, which
-- is how this was found — a replica wedding with 18 checklist items and two of
-- every timeline line. Production is clean (checked 23 Oct). A transaction
-- lock per event makes the second reader wait, then find the rows.
select pg_temp.patch_fn('wp_get_timeline',
  $a$  if not exists (select 1 from wp_timeline where event_id = v_event) then$a$,
  $a$  perform pg_advisory_xact_lock(hashtext('wp_seed_timeline'), v_event);
  if not exists (select 1 from wp_timeline where event_id = v_event) then$a$,
  $a$wp_seed_timeline$a$);

select pg_temp.patch_fn('wp_get_checklist',
  $a$  if not exists (select 1 from wp_checklist where event_id = v_event and source = 'venue') then$a$,
  $a$  perform pg_advisory_xact_lock(hashtext('wp_seed_checklist'), v_event);
  if not exists (select 1 from wp_checklist where event_id = v_event and source = 'venue') then$a$,
  $a$wp_seed_checklist$a$);

-- The Wedding template already has a 13:00 Ceremony row. Everything from it
-- onwards on the day becomes "follows the ceremony", so a couple who set a
-- 14:30 ceremony get drinks, breakfast and speeches moved with it. Earlier
-- rows (suppliers arriving) stay fixed: they depend on access, not the vows.
-- Only the template changes — no couple's existing timeline is touched.
do $backfill$
declare v_cer time; n int;
begin
  select count(*), min(start_time) into n, v_cer
    from wp_timeline_template
   where event_type = 'Wedding' and day_key = 'event' and lower(trim(title)) = 'ceremony';
  if n = 1 then
    update wp_timeline_template
       set rel_minutes = wp_minutes_after(v_cer, start_time)
     where event_type = 'Wedding' and day_key = 'event' and start_time >= v_cer
       and rel_minutes is null;
  else
    raise notice 'Wedding template: % ceremony rows, so no rows were set to follow it', n;
  end if;

  -- Example questions, Sonas-style, for Toby to rewrite in the template editor.
  update wp_timeline_template set prompts =
    'Who is walking in, and in what order?' || chr(10) || 'Any readings — and who is reading?'
   where event_type = 'Wedding' and day_key = 'event' and lower(trim(title)) = 'ceremony' and prompts is null;
  update wp_timeline_template set prompts =
    'How many speeches, and who is giving them?' || chr(10) || 'Do any speakers need a microphone?'
   where event_type = 'Wedding' and day_key = 'event' and lower(trim(title)) = 'speeches' and prompts is null;
  update wp_timeline_template set prompts =
    'What is your first dance song?' || chr(10) || 'Is the cake being served in the evening, or boxed to take home?'
   where event_type = 'Wedding' and day_key = 'event' and lower(trim(title)) = 'cake and first dance' and prompts is null;
end $backfill$;


-- ════════════════════════════════════════════════════════════════════════════
-- 4. ITEMS THE COUPLE IS BRINGING
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.wp_item_types (
  id     uuid primary key default gen_random_uuid(),
  name   text not null,
  sort   integer not null default 0,
  active boolean not null default true
);
alter table public.wp_item_types enable row level security;
revoke all on table public.wp_item_types from anon, authenticated;

create table if not exists public.wp_items (
  id            uuid primary key default gen_random_uuid(),
  event_id      integer not null,
  name          text not null check (length(trim(name)) > 0),
  qty           integer not null default 1 check (qty between 1 and 999),
  notes         text,
  take_home_by  text,             -- who takes it away at the end
  received_at   timestamptz,
  received_by   text,             -- staff name, as shown on the sheet
  collected_at  timestamptz,
  collected_by  text,
  created_at    timestamptz not null default now()
);
create index if not exists wp_items_event on public.wp_items (event_id, created_at);
alter table public.wp_items enable row level security;
revoke all on table public.wp_items from anon, authenticated;

insert into public.wp_item_types (name, sort)
select v.name, v.sort from (values
  ('Table plan and easel', 10), ('Table names or numbers', 20), ('Place cards', 30),
  ('Guest book and pen', 40), ('Card box', 50), ('Favours', 60), ('Centrepieces', 70),
  ('Candles or lanterns', 80), ('Signs', 90), ('Bunting', 100), ('Fairy lights', 110),
  ('Biodegradable confetti', 120), ('Cake knife', 130), ('Cake stand', 140), ('Cake topper', 150),
  ('Photos of loved ones', 160), ('Disposable cameras', 170), ('Lawn games', 180), ('Umbrellas', 190)
) as v(name, sort)
where not exists (select 1 from public.wp_item_types);

create or replace function public.wp_get_items()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object(
    'ok', true,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'name', i.name, 'qty', i.qty, 'notes', i.notes,
               'take_home_by', i.take_home_by,
               'received_at', i.received_at, 'collected_at', i.collected_at)
             order by i.created_at)
        from wp_items i where i.event_id = v_event), '[]'::jsonb),
    'typical', coalesce((
      select jsonb_agg(t.name order by t.sort, t.name)
        from wp_item_types t where t.active), '[]'::jsonb)
  );
end $function$;

create or replace function public.wp_add_item(p_name text, p_qty integer default 1, p_notes text default null, p_take_home_by text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id(); v_id uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if length(trim(coalesce(p_name, ''))) = 0 then return jsonb_build_object('ok', false, 'error', 'no_name'); end if;
  if (select count(*) from wp_items where event_id = v_event) >= 200 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  insert into wp_items (event_id, name, qty, notes, take_home_by)
  values (v_event, left(trim(p_name), 120), greatest(1, least(999, coalesce(p_qty, 1))),
          left(nullif(trim(coalesce(p_notes, '')), ''), 500),
          left(nullif(trim(coalesce(p_take_home_by, '')), ''), 80))
  returning id into v_id;
  perform wp_log('items', 'added ' || left(trim(p_name), 120));
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

-- Sent whole: '' clears notes and take-home, as on the guest form.
create or replace function public.wp_update_item(p_id uuid, p_name text, p_qty integer, p_notes text, p_take_home_by text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if length(trim(coalesce(p_name, ''))) = 0 then return jsonb_build_object('ok', false, 'error', 'no_name'); end if;
  update wp_items
     set name = left(trim(p_name), 120),
         qty = greatest(1, least(999, coalesce(p_qty, qty))),
         notes = left(nullif(trim(coalesce(p_notes, '')), ''), 500),
         take_home_by = left(nullif(trim(coalesce(p_take_home_by, '')), ''), 80)
   where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('items', 'updated ' || left(trim(p_name), 120));
  return jsonb_build_object('ok', true);
end $function$;

-- Something already in our hands is not deleted from the list: the record of
-- having it is how it gets back to them. They can still edit it.
create or replace function public.wp_delete_item(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id(); v_rec timestamptz; v_name text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select received_at, name into v_rec, v_name from wp_items where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_rec is not null then return jsonb_build_object('ok', false, 'error', 'already_received'); end if;
  delete from wp_items where id = p_id and event_id = v_event;
  perform wp_log('items', 'removed ' || v_name);
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_items(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', i.id, 'name', i.name, 'qty', i.qty, 'notes', i.notes, 'take_home_by', i.take_home_by,
             'received_at', i.received_at, 'received_by', i.received_by,
             'collected_at', i.collected_at, 'collected_by', i.collected_by)
           order by i.created_at)
      from wp_items i where i.event_id = p_event_id), '[]'::jsonb));
end $function$;

-- p_what: 'received' or 'collected'; p_on false un-ticks a mistake.
create or replace function public.wp_admin_mark_item(p_id uuid, p_what text, p_on boolean)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_who text;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_what not in ('received', 'collected') then return jsonb_build_object('ok', false, 'error', 'bad_what'); end if;
  select coalesce(nullif(trim(name), ''), email) into v_who from profiles where id = auth.uid();
  if p_what = 'received' then
    update wp_items set received_at = case when p_on then now() end,
                        received_by = case when p_on then v_who end
     where id = p_id;
  else
    update wp_items set collected_at = case when p_on then now() end,
                        collected_by = case when p_on then v_who end
     where id = p_id;
  end if;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_item_types()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'types', coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'sort', t.sort, 'active', t.active)
           order by t.sort, t.name) from wp_item_types t), '[]'::jsonb));
end $function$;

-- The whole list, replaced. Suggestions only — nothing points at these rows.
create or replace function public.wp_admin_save_item_types(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    return jsonb_build_object('ok', false, 'error', 'bad_rows');
  end if;
  delete from wp_item_types;
  insert into wp_item_types (name, sort, active)
  select left(trim(e ->> 'name'), 120), ord * 10, coalesce((e ->> 'active')::boolean, true)
    from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
   where length(trim(coalesce(e ->> 'name', ''))) > 0;
  return jsonb_build_object('ok', true);
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
-- 5. ADD-ONS
-- ════════════════════════════════════════════════════════════════════════════
-- A request is a question, not a purchase. Approval records a price and tells
-- staff what to put on the next invoice; nothing here reaches Xero or Stripe.
-- Glamping is deliberately not an add-on: it is accommodation, booked through
-- the contract and the lettings system.

create table if not exists public.wp_addons (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  description      text,
  unit_label       text not null default 'each',
  price_inc_vat     numeric(10,2) check (price_inc_vat is null or price_inc_vat >= 0),
  vat_rate         numeric(5,2) not null default 20 check (vat_rate between 0 and 100),
  price_on_request boolean not null default false,
  max_qty          integer not null default 1 check (max_qty between 1 and 999),
  -- A portal section this add-on switches on once confirmed (the webcast).
  unlocks          text check (unlocks is null or unlocks in ('webcast')),
  active           boolean not null default true,
  sort             integer not null default 0,
  created_at       timestamptz not null default now()
);
alter table public.wp_addons enable row level security;
revoke all on table public.wp_addons from anon, authenticated;

create table if not exists public.wp_addon_requests (
  id            uuid primary key default gen_random_uuid(),
  event_id      integer not null,
  addon_id      uuid references public.wp_addons(id) on delete set null,
  addon_name    text not null,         -- kept, so a retired add-on still reads
  unit_label    text not null,
  qty           integer not null default 1 check (qty between 1 and 999),
  note          text,
  unit_price    numeric(10,2),          -- inc VAT; null while "price on request"
  vat_rate      numeric(5,2) not null default 20,
  status        text not null default 'requested'
                check (status in ('requested', 'approved', 'declined', 'cancelled')),
  requested_at  timestamptz not null default now(),
  requested_by  text,
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id) on delete set null,
  staff_note    text
);
create index if not exists wp_addon_requests_event on public.wp_addon_requests (event_id, requested_at);
create index if not exists wp_addon_requests_open on public.wp_addon_requests (requested_at) where status = 'requested';
alter table public.wp_addon_requests enable row level security;
revoke all on table public.wp_addon_requests from anon, authenticated;

-- Examples only, switched OFF, for Toby to price and turn on.
insert into public.wp_addons (name, description, unit_label, price_on_request, active, sort)
select v.* from (values
  ('Fire pit', 'Lit and looked after through the evening.', 'each', true, false, 10),
  ('Extra hour of bar and music', 'Subject to our licence — ask us first.', 'per hour', true, false, 20),
  ('Lawn games', 'Giant Jenga, quoits and the like, set out on the lawn.', 'set', true, false, 30)
) as v(name, description, unit_label, price_on_request, active, sort)
where not exists (select 1 from public.wp_addons);

-- The webcast: once confirmed, the client's portal gains a Webcast page with
-- the stream address and password staff set for that event. Off until priced.
insert into public.wp_addons (name, description, unit_label, price_on_request, active, sort, unlocks)
select 'Webcast of the service', 'A live stream for people who cannot be there. We send you the link and password to share.',
       'each', true, false, 40, 'webcast'
where not exists (select 1 from public.wp_addons where unlocks = 'webcast');

create or replace function public.wp_get_addons()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object(
    'ok', true,
    'catalogue', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'name', a.name, 'description', a.description, 'unit_label', a.unit_label,
               'price_inc_vat', case when a.price_on_request then null else a.price_inc_vat end,
               'vat_rate', a.vat_rate, 'price_on_request', a.price_on_request or a.price_inc_vat is null,
               'max_qty', a.max_qty)
             order by a.sort, a.name)
        from wp_addons a where a.active), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'addon_id', r.addon_id, 'name', r.addon_name, 'unit_label', r.unit_label,
               'qty', r.qty, 'note', r.note, 'unit_price', r.unit_price, 'vat_rate', r.vat_rate,
               'status', r.status, 'requested_at', r.requested_at,
               'decided_at', r.decided_at, 'staff_note', r.staff_note)
             order by r.requested_at desc)
        from wp_addon_requests r where r.event_id = v_event and r.status <> 'cancelled'), '[]'::jsonb)
  );
end $function$;

-- Asking twice for the same thing updates the open request rather than
-- stacking a second one for staff to untangle.
create or replace function public.wp_request_addon(p_addon_id uuid, p_qty integer default 1, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  a wp_addons%rowtype;
  v_qty integer;
  v_id uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select * into a from wp_addons where id = p_addon_id and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_available'); end if;
  v_qty := greatest(1, least(a.max_qty, coalesce(p_qty, 1)));

  update wp_addon_requests
     set qty = v_qty, note = left(nullif(trim(coalesce(p_note, '')), ''), 500), requested_at = now()
   where event_id = v_event and addon_id = a.id and status = 'requested'
  returning id into v_id;

  if v_id is null then
    insert into wp_addon_requests (event_id, addon_id, addon_name, unit_label, qty, note, unit_price, vat_rate, requested_by)
    values (v_event, a.id, a.name, a.unit_label, v_qty, left(nullif(trim(coalesce(p_note, '')), ''), 500),
            case when a.price_on_request then null else a.price_inc_vat end, a.vat_rate,
            lower(coalesce(auth.jwt() ->> 'email', '')))
    returning id into v_id;
  end if;

  perform wp_log('add-ons', 'asked for ' || a.name);
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

-- Only an open request can be withdrawn from here. An approved one is on its
-- way to an invoice — that is a conversation, not a button.
create or replace function public.wp_cancel_addon(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id(); v_status text; v_name text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select status, addon_name into v_status, v_name from wp_addon_requests where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_status <> 'requested' then return jsonb_build_object('ok', false, 'error', 'already_decided'); end if;
  update wp_addon_requests set status = 'cancelled', decided_at = now() where id = p_id and event_id = v_event;
  perform wp_log('add-ons', 'withdrew ' || v_name);
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_addons()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'addons', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'name', a.name, 'description', a.description, 'unit_label', a.unit_label,
             'price_inc_vat', a.price_inc_vat, 'vat_rate', a.vat_rate, 'price_on_request', a.price_on_request,
             'max_qty', a.max_qty, 'active', a.active, 'sort', a.sort, 'unlocks', a.unlocks,
             'requests', (select count(*) from wp_addon_requests r where r.addon_id = a.id))
           order by a.sort, a.name) from wp_addons a), '[]'::jsonb));
end $function$;

-- Upsert by id. Rows left out are switched off, never deleted: requests point
-- at them.
create or replace function public.wp_admin_save_addons(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare e jsonb; ord bigint; v_ids uuid[] := '{}'; v_id uuid;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 60 then
    return jsonb_build_object('ok', false, 'error', 'bad_rows');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x where length(trim(coalesce(x ->> 'name', ''))) = 0) then
    return jsonb_build_object('ok', false, 'error', 'needs_name');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x
              where not coalesce((x ->> 'price_on_request')::boolean, false)
                and nullif(x ->> 'price_inc_vat', '') is null) then
    return jsonb_build_object('ok', false, 'error', 'needs_price');
  end if;

  for e, ord in select x, o from jsonb_array_elements(p_rows) with ordinality as t(x, o) loop
    v_id := nullif(e ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from wp_addons where id = v_id) then
      update wp_addons set
        name = left(trim(e ->> 'name'), 120),
        description = left(nullif(trim(coalesce(e ->> 'description', '')), ''), 500),
        unit_label = coalesce(left(nullif(trim(coalesce(e ->> 'unit_label', '')), ''), 30), 'each'),
        price_inc_vat = nullif(e ->> 'price_inc_vat', '')::numeric,
        vat_rate = coalesce(nullif(e ->> 'vat_rate', '')::numeric, 20),
        price_on_request = coalesce((e ->> 'price_on_request')::boolean, false),
        max_qty = greatest(1, least(999, coalesce(nullif(e ->> 'max_qty', '')::int, 1))),
        unlocks = case when e ->> 'unlocks' = 'webcast' then 'webcast' end,
        active = coalesce((e ->> 'active')::boolean, true),
        sort = ord * 10
      where id = v_id;
    else
      insert into wp_addons (name, description, unit_label, price_inc_vat, vat_rate, price_on_request, max_qty, active, sort, unlocks)
      values (left(trim(e ->> 'name'), 120),
              left(nullif(trim(coalesce(e ->> 'description', '')), ''), 500),
              coalesce(left(nullif(trim(coalesce(e ->> 'unit_label', '')), ''), 30), 'each'),
              nullif(e ->> 'price_inc_vat', '')::numeric,
              coalesce(nullif(e ->> 'vat_rate', '')::numeric, 20),
              coalesce((e ->> 'price_on_request')::boolean, false),
              greatest(1, least(999, coalesce(nullif(e ->> 'max_qty', '')::int, 1))),
              coalesce((e ->> 'active')::boolean, true), ord * 10,
              case when e ->> 'unlocks' = 'webcast' then 'webcast' end)
      returning id into v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;

  update wp_addons set active = false where not (id = any (v_ids));
  perform wp_log('admin', 'saved the add-ons list');
  return jsonb_build_object('ok', true);
end $function$;

-- One event's requests, or with no event every open request across weddings.
create or replace function public.wp_admin_addon_requests(p_event_id integer default null)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'requests', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'event_id', r.event_id, 'name', r.addon_name, 'unit_label', r.unit_label,
             'qty', r.qty, 'note', r.note, 'unit_price', r.unit_price, 'vat_rate', r.vat_rate,
             'status', r.status, 'requested_at', r.requested_at, 'requested_by', r.requested_by,
             'decided_at', r.decided_at, 'staff_note', r.staff_note)
           order by r.requested_at desc)
      from wp_addon_requests r
     where (p_event_id is null and r.status = 'requested')
        or (p_event_id is not null and r.event_id = p_event_id and r.status <> 'cancelled')), '[]'::jsonb));
end $function$;

create or replace function public.wp_admin_decide_addon(p_id uuid, p_status text, p_unit_price numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_price numeric;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_status not in ('approved', 'declined', 'requested') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;
  select coalesce(p_unit_price, unit_price) into v_price from wp_addon_requests where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- An approval must say what it costs, or nobody knows what to invoice.
  if p_status = 'approved' and v_price is null then
    return jsonb_build_object('ok', false, 'error', 'needs_price');
  end if;
  update wp_addon_requests
     set status = p_status, unit_price = v_price,
         decided_at = case when p_status = 'requested' then null else now() end,
         decided_by = case when p_status = 'requested' then null else auth.uid() end,
         staff_note = left(nullif(trim(coalesce(p_note, '')), ''), 500)
   where id = p_id;
  return jsonb_build_object('ok', true);
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
-- 6. WHICH SECTIONS AN EVENT SHOWS
-- ════════════════════════════════════════════════════════════════════════════
-- A standard set per event type, and per-event ticks that add to it or take
-- away from it. An event with no tick of its own follows its type's standard,
-- so changing the standard changes every event that has not been customised.
-- Overview is always shown and is not in the list.
--
-- This decides what the portal SHOWS. It is not a permission: the functions
-- behind a hidden section still answer, because hiding is a presentation
-- choice and nothing in a hidden section is anybody else's data.

create table if not exists public.wp_section_defaults (
  event_type text    not null,
  section    text    not null,
  shown      boolean not null default true,
  primary key (event_type, section)
);
alter table public.wp_section_defaults enable row level security;
revoke all on table public.wp_section_defaults from anon, authenticated;

create table if not exists public.wp_event_sections (
  event_id   integer not null,
  section    text    not null,
  shown      boolean not null,
  updated_at timestamptz not null default now(),
  primary key (event_id, section)
);
alter table public.wp_event_sections enable row level security;
revoke all on table public.wp_event_sections from anon, authenticated;

-- The tabs, in the order the portal draws them.
create or replace function public.wp_section_keys()
returns text[] language sql immutable set search_path to 'public' as $function$
  select array['guests','food','drinks','checklist','timeline','music','uploads','webcast','suppliers',
               'layout','items','addons','money','details','documents','inspiration'];
$function$;

insert into public.wp_section_defaults (event_type, section, shown)
select t.event_type, k.section, k.section = any (t.shown)
  from (values
    ('Wedding', array['guests','drinks','checklist','timeline','music','suppliers','layout','items',
                      'addons','money','details','documents','inspiration']),
    ('Party',   array['guests','food','drinks','checklist','timeline','music','suppliers','layout','items',
                      'addons','money','details','documents']),
    ('Wake',    array['guests','food','drinks','timeline','music','uploads','money','details','documents']),
    ('Other',   array['guests','timeline','money','details','documents'])
  ) as t(event_type, shown)
  cross join unnest(wp_section_keys()) as k(section)
on conflict (event_type, section) do nothing;

-- The diary's event type, as the portal's rules know it.
create or replace function public.wp_event_type_of(p_event integer)
returns text language sql stable security definer set search_path to 'public', 'extensions' as $function$
  select case when exists (select 1 from wp_section_defaults where event_type = x.t) then x.t else 'Other' end
    from (select wp_event_type_label((
            select e ->> 'eventType' from app_data d, lateral jsonb_array_elements(d.value) e
             where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event limit 1)) as t) x;
$function$;

create or replace function public.wp_visible_sections(p_event integer)
returns jsonb language sql stable security definer set search_path to 'public', 'extensions' as $function$
  select coalesce(jsonb_agg(k.section order by k.ord), '[]'::jsonb)
    from unnest(wp_section_keys()) with ordinality as k(section, ord)
   where coalesce(
           (select es.shown from wp_event_sections es where es.event_id = p_event and es.section = k.section),
           -- A section an add-on unlocks (the webcast) appears once that add-on
           -- is CONFIRMED for this event. A per-event tick still overrides.
           (select true where exists (
              select 1 from wp_addon_requests r join wp_addons a on a.id = r.addon_id
               where r.event_id = p_event and r.status = 'approved' and a.unlocks = k.section)),
           (select sd.shown from wp_section_defaults sd
             where sd.event_type = wp_event_type_of(p_event) and sd.section = k.section),
           false);
$function$;

create or replace function public.wp_admin_section_defaults()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'sections', to_jsonb(wp_section_keys()),
    'types', coalesce((
      select jsonb_agg(jsonb_build_object('event_type', t.event_type,
               'shown', (select coalesce(jsonb_agg(sd.section), '[]'::jsonb) from wp_section_defaults sd
                          where sd.event_type = t.event_type and sd.shown))
             order by case t.event_type when 'Wedding' then 1 when 'Party' then 2 when 'Wake' then 3 else 4 end)
        from (select distinct event_type from wp_section_defaults) t), '[]'::jsonb));
end $function$;

create or replace function public.wp_admin_save_section_defaults(p_event_type text, p_shown text[])
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_event_type not in ('Wedding', 'Party', 'Wake', 'Other') then
    return jsonb_build_object('ok', false, 'error', 'bad_event_type');
  end if;
  insert into wp_section_defaults (event_type, section, shown)
  select p_event_type, k, k = any (coalesce(p_shown, '{}')) from unnest(wp_section_keys()) k
  on conflict (event_type, section) do update set shown = excluded.shown;
  perform wp_log('admin', 'changed the standard sections for ' || p_event_type);
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_event_sections(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_type text := wp_event_type_of(p_event_id);
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'event_type', v_type,
    'sections', (select jsonb_agg(jsonb_build_object(
        'section', k.section,
        'standard', coalesce(sd.shown, false),
        'override', es.shown,
        'shown', coalesce(es.shown, sd.shown, false)) order by k.ord)
      from unnest(wp_section_keys()) with ordinality as k(section, ord)
      left join wp_section_defaults sd on sd.event_type = v_type and sd.section = k.section
      left join wp_event_sections es on es.event_id = p_event_id and es.section = k.section));
end $function$;

-- p_shown NULL puts the section back to its type's standard.
create or replace function public.wp_admin_set_event_section(p_event_id integer, p_section text, p_shown boolean)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if not (p_section = any (wp_section_keys())) then
    return jsonb_build_object('ok', false, 'error', 'bad_section');
  end if;
  if p_shown is null then
    delete from wp_event_sections where event_id = p_event_id and section = p_section;
  else
    insert into wp_event_sections (event_id, section, shown) values (p_event_id, p_section, p_shown)
    on conflict (event_id, section) do update set shown = excluded.shown, updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
-- 7. OVERVIEW — cover photo, venue documents
-- ════════════════════════════════════════════════════════════════════════════

-- Small settings Toby can change without a deploy. Allowlisted keys only.
create table if not exists public.wp_settings (
  key        text primary key check (key in ('cover_url', 'upload_max_mb')),
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.wp_settings enable row level security;
revoke all on table public.wp_settings from anon, authenticated;

-- One picture for every kind of event: the pasture with the church beyond,
-- from the website. A dressed wedding barn would be wrong at the top of a
-- wake; this is right for all of them.
insert into public.wp_settings (key, value) values
  ('cover_url', 'https://images.squarespace-cdn.com/content/v1/6897aa6fe61ae2143f465ab1/1754770035072-D9C36AEMSWQM20NRMZXF/farm.jpg?format=1500w')
on conflict (key) do nothing;

create table if not exists public.wp_venue_docs (
  id     uuid primary key default gen_random_uuid(),
  title  text not null,
  url    text not null check (url ~ '^(https://|/)'),
  note   text,
  sort   integer not null default 0,
  active boolean not null default true
);
alter table public.wp_venue_docs enable row level security;
revoke all on table public.wp_venue_docs from anon, authenticated;

-- Everything the Overview needs that is not the diary's, in one round trip —
-- including which tabs to draw.
create or replace function public.wp_get_home()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object(
    'ok', true,
    'event_type',    wp_event_type_of(v_event),
    'visible',       wp_visible_sections(v_event),
    'ceremony_time', (select ceremony_time from wp_event_profile where event_id = v_event),
    'cover_url',     (select value from wp_settings where key = 'cover_url'),
    'marketing_ok',  coalesce((select a.marketing_ok from wp_access a
                                where a.event_id = v_event and a.revoked_at is null
                                  and (a.user_id = auth.uid()
                                       or a.email = lower(coalesce(auth.jwt() ->> 'email', '~none~')))
                                order by a.user_id nulls last limit 1), true),
    'sections',      wp_section_rows(v_event),
    'items',         (select count(*) from wp_items where event_id = v_event),
    'addons_open',   (select count(*) from wp_addon_requests where event_id = v_event and status = 'requested'),
    'food_chosen',   exists (select 1 from wp_food_choice where event_id = v_event and package_id is not null),
    'music_links',   (select count(*) from wp_playlist where event_id = v_event and url is not null)
  );
end $function$;

create or replace function public.wp_admin_profile(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'ceremony_time', (select ceremony_time from wp_event_profile where event_id = p_event_id),
    'marketing', coalesce((select jsonb_agg(jsonb_build_object('email', a.email, 'ok', a.marketing_ok,
                                                               'changed_at', a.marketing_changed_at) order by a.email)
                             from wp_access a where a.event_id = p_event_id and a.revoked_at is null), '[]'::jsonb));
end $function$;

create or replace function public.wp_get_venue_docs()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if wp_my_event_id() is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object('ok', true, 'docs', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'url', d.url, 'note', d.note)
           order by d.sort, d.title)
      from wp_venue_docs d where d.active), '[]'::jsonb));
end $function$;

create or replace function public.wp_admin_venue_settings()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'cover_url', (select value from wp_settings where key = 'cover_url'),
    'docs', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'url', d.url,
                                                          'note', d.note, 'active', d.active)
                                       order by d.sort, d.title) from wp_venue_docs d), '[]'::jsonb));
end $function$;

create or replace function public.wp_admin_save_venue_settings(p_cover_url text, p_docs jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_cover text := nullif(trim(coalesce(p_cover_url, '')), '');
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if v_cover is not null and v_cover !~ '^(https://|/)' then
    return jsonb_build_object('ok', false, 'error', 'cover_not_https');
  end if;
  if p_docs is null or jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) > 40 then
    return jsonb_build_object('ok', false, 'error', 'bad_docs');
  end if;
  if exists (select 1 from jsonb_array_elements(p_docs) x
              where length(trim(coalesce(x ->> 'title', ''))) = 0
                 or trim(coalesce(x ->> 'url', '')) !~ '^(https://|/)') then
    return jsonb_build_object('ok', false, 'error', 'doc_needs_title_and_https');
  end if;

  insert into wp_settings (key, value, updated_at) values ('cover_url', v_cover, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  delete from wp_venue_docs;
  insert into wp_venue_docs (title, url, note, sort, active)
  select left(trim(x ->> 'title'), 120), left(trim(x ->> 'url'), 1000),
         left(nullif(trim(coalesce(x ->> 'note', '')), ''), 300), o * 10,
         coalesce((x ->> 'active')::boolean, true)
    from jsonb_array_elements(p_docs) with ordinality as t(x, o);
  perform wp_log('admin', 'saved the portal cover and venue documents');
  return jsonb_build_object('ok', true);
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
-- 8. FOOD — for wakes and parties, where Hawthbush caters
-- ════════════════════════════════════════════════════════════════════════════
-- A short list of packages, each priced per head. The client picks one and
-- confirms numbers. Tea and coffee are part of every package, so they are in
-- the description rather than a separate choice. The bar is a pay bar — the
-- Drinks tab covers money behind it; there is no drinks package for a wake.
--
-- Dietary notes are held here because here Hawthbush IS the caterer. That is
-- the opposite of the wedding decision (no dietary data: weddings use outside
-- caterers), and it is deliberate. Notes are per event, not per named guest.

create table if not exists public.wp_food_packages (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  description      text,
  price_pp_inc_vat  numeric(10,2) check (price_pp_inc_vat is null or price_pp_inc_vat >= 0),
  vat_rate         numeric(5,2) not null default 20 check (vat_rate between 0 and 100),
  price_on_request boolean not null default false,
  active           boolean not null default true,
  sort             integer not null default 0,
  created_at       timestamptz not null default now()
);
alter table public.wp_food_packages enable row level security;
revoke all on table public.wp_food_packages from anon, authenticated;

create table if not exists public.wp_food_choice (
  event_id      integer primary key,
  package_id    uuid references public.wp_food_packages(id) on delete set null,
  package_name  text,               -- kept, so a retired package still reads
  price_pp      numeric(10,2),      -- inc VAT, as it was when chosen
  vat_rate      numeric(5,2),
  numbers       integer check (numbers is null or numbers between 0 and 2000),
  serve_time    time,
  dietary       text,
  notes         text,
  updated_at    timestamptz not null default now(),
  updated_by    text
);
alter table public.wp_food_choice enable row level security;
revoke all on table public.wp_food_choice from anon, authenticated;

-- Placeholders, switched OFF, for Toby to name, describe and price.
insert into public.wp_food_packages (name, description, price_on_request, active, sort)
select v.* from (values
  ('Sandwich and cake buffet', 'Sandwiches, savouries and cake, with tea and coffee.', true, false, 10),
  ('Hot buffet', 'A hot main with sides and a pudding, with tea and coffee.', true, false, 20)
) as v(name, description, price_on_request, active, sort)
where not exists (select 1 from public.wp_food_packages);

create or replace function public.wp_get_food()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  c wp_food_choice%rowtype;
  n wp_guest_numbers%rowtype;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select * into c from wp_food_choice where event_id = v_event;
  select * into n from wp_guest_numbers where event_id = v_event;
  return jsonb_build_object(
    'ok', true,
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'description', p.description,
               'price_pp_inc_vat', case when p.price_on_request then null else p.price_pp_inc_vat end,
               'vat_rate', p.vat_rate, 'price_on_request', p.price_on_request or p.price_pp_inc_vat is null)
             order by p.sort, p.name)
        from wp_food_packages p where p.active), '[]'::jsonb),
    'choice', case when c.event_id is null then null else jsonb_build_object(
               'package_id', c.package_id, 'package_name', c.package_name,
               'price_pp', c.price_pp, 'vat_rate', c.vat_rate, 'numbers', c.numbers,
               'serve_time', c.serve_time, 'dietary', c.dietary, 'notes', c.notes,
               'updated_at', c.updated_at) end,
    -- What the Guests tab says, so numbers can be pre-filled rather than retyped.
    'guest_numbers', case when n.event_id is null then null
                          else coalesce(n.seated_adults, 0) + coalesce(n.seated_children, 0)
                               + coalesce(n.seated_babies, 0) + coalesce(n.evening_extras, 0) end
  );
end $function$;

-- Sent whole. The price is taken from the package when the package CHANGES;
-- saving the same package again keeps the price it was chosen at.
create or replace function public.wp_save_food(p_package_id uuid, p_numbers integer, p_serve_time time,
                                               p_dietary text, p_notes text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  p wp_food_packages%rowtype;
  v_old uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_numbers is not null and (p_numbers < 0 or p_numbers > 2000) then
    return jsonb_build_object('ok', false, 'error', 'bad_numbers');
  end if;
  if p_package_id is not null then
    select * into p from wp_food_packages where id = p_package_id and active;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_available'); end if;
  end if;
  select package_id into v_old from wp_food_choice where event_id = v_event;

  insert into wp_food_choice (event_id, package_id, package_name, price_pp, vat_rate, numbers, serve_time,
                              dietary, notes, updated_at, updated_by)
  values (v_event, p_package_id, p.name,
          case when p.price_on_request then null else p.price_pp_inc_vat end, p.vat_rate,
          p_numbers, p_serve_time,
          left(nullif(trim(coalesce(p_dietary, '')), ''), 1000),
          left(nullif(trim(coalesce(p_notes, '')), ''), 1000),
          now(), lower(coalesce(auth.jwt() ->> 'email', '')))
  on conflict (event_id) do update set
    package_id   = excluded.package_id,
    package_name = case when excluded.package_id is not distinct from wp_food_choice.package_id
                        then wp_food_choice.package_name else excluded.package_name end,
    price_pp     = case when excluded.package_id is not distinct from wp_food_choice.package_id
                        then wp_food_choice.price_pp else excluded.price_pp end,
    vat_rate     = case when excluded.package_id is not distinct from wp_food_choice.package_id
                        then wp_food_choice.vat_rate else excluded.vat_rate end,
    numbers = excluded.numbers, serve_time = excluded.serve_time,
    dietary = excluded.dietary, notes = excluded.notes,
    updated_at = now(), updated_by = excluded.updated_by;

  perform wp_log('food', case when p_package_id is distinct from v_old
                              then 'chose ' || coalesce(p.name, 'no package') else 'updated the food details' end);
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_food_packages()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'packages', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'description', p.description, 'price_pp_inc_vat', p.price_pp_inc_vat,
             'vat_rate', p.vat_rate, 'price_on_request', p.price_on_request, 'active', p.active,
             'chosen', (select count(*) from wp_food_choice c where c.package_id = p.id))
           order by p.sort, p.name) from wp_food_packages p), '[]'::jsonb));
end $function$;

-- Upsert by id; rows left out are switched off, never deleted.
create or replace function public.wp_admin_save_food_packages(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare e jsonb; ord bigint; v_ids uuid[] := '{}'; v_id uuid;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 30 then
    return jsonb_build_object('ok', false, 'error', 'bad_rows');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x where length(trim(coalesce(x ->> 'name', ''))) = 0) then
    return jsonb_build_object('ok', false, 'error', 'needs_name');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x
              where not coalesce((x ->> 'price_on_request')::boolean, false)
                and nullif(x ->> 'price_pp_inc_vat', '') is null) then
    return jsonb_build_object('ok', false, 'error', 'needs_price');
  end if;

  for e, ord in select x, o from jsonb_array_elements(p_rows) with ordinality as t(x, o) loop
    v_id := nullif(e ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from wp_food_packages where id = v_id) then
      update wp_food_packages set
        name = left(trim(e ->> 'name'), 120),
        description = left(nullif(trim(coalesce(e ->> 'description', '')), ''), 1000),
        price_pp_inc_vat = nullif(e ->> 'price_pp_inc_vat', '')::numeric,
        vat_rate = coalesce(nullif(e ->> 'vat_rate', '')::numeric, 20),
        price_on_request = coalesce((e ->> 'price_on_request')::boolean, false),
        active = coalesce((e ->> 'active')::boolean, true),
        sort = ord * 10
      where id = v_id;
    else
      insert into wp_food_packages (name, description, price_pp_inc_vat, vat_rate, price_on_request, active, sort)
      values (left(trim(e ->> 'name'), 120),
              left(nullif(trim(coalesce(e ->> 'description', '')), ''), 1000),
              nullif(e ->> 'price_pp_inc_vat', '')::numeric,
              coalesce(nullif(e ->> 'vat_rate', '')::numeric, 20),
              coalesce((e ->> 'price_on_request')::boolean, false),
              coalesce((e ->> 'active')::boolean, true), ord * 10)
      returning id into v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  update wp_food_packages set active = false where not (id = any (v_ids));
  perform wp_log('admin', 'saved the food packages');
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_food(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare c wp_food_choice%rowtype;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select * into c from wp_food_choice where event_id = p_event_id;
  return jsonb_build_object('ok', true, 'choice', case when c.event_id is null then null else jsonb_build_object(
    'package_name', c.package_name, 'price_pp', c.price_pp, 'vat_rate', c.vat_rate, 'numbers', c.numbers,
    'serve_time', c.serve_time, 'dietary', c.dietary, 'notes', c.notes,
    'updated_at', c.updated_at, 'updated_by', c.updated_by) end);
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
-- 9. MUSIC — a list of descriptions and Spotify links
-- ════════════════════════════════════════════════════════════════════════════
-- Spotify only, because that is what the venue system plays. The check is in
-- the database as well as the form: an Apple Music link that slipped through
-- would surface on the night as silence.

create table if not exists public.wp_playlist (
  id          uuid primary key default gen_random_uuid(),
  event_id    integer not null,
  description text not null check (length(trim(description)) > 0),
  url         text check (url is null or url ~ '^https://(open\.spotify\.com|spotify\.link)/'),
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists wp_playlist_event on public.wp_playlist (event_id, sort);
alter table public.wp_playlist enable row level security;
revoke all on table public.wp_playlist from anon, authenticated;

create or replace function public.wp_music_url_ok(p_url text)
returns boolean language sql immutable set search_path to 'public' as $function$
  select p_url ~ '^https://(open\.spotify\.com|spotify\.link)/[A-Za-z0-9/_?=&%.-]+$' and length(p_url) <= 500;
$function$;

-- The suggested lines for each kind of event, which staff edit. Wake:
-- arrival, procession, song 1, song 2 … Wedding: arrival, first dance …
create table if not exists public.wp_music_defaults (
  event_type  text not null,
  description text not null,
  sort        integer not null default 0,
  primary key (event_type, description)
);
alter table public.wp_music_defaults enable row level security;
revoke all on table public.wp_music_defaults from anon, authenticated;

insert into public.wp_music_defaults (event_type, description, sort)
select v.t, v.d, v.o from (values
  ('Wedding', 'Arrival — background music', 10), ('Wedding', 'First dance', 20), ('Wedding', 'Dancefloor', 30),
  ('Party',   'Arrival — background music', 10), ('Party',   'Dancefloor', 20),
  ('Wake',    'Arrival — background music', 10), ('Wake',    'Procession', 20),
  ('Wake',    'Song 1', 30), ('Wake', 'Song 2', 40),
  ('Other',   'Background music', 10)
) as v(t, d, o)
where not exists (select 1 from public.wp_music_defaults);

create or replace function public.wp_admin_music_defaults()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'types', (
    select jsonb_agg(jsonb_build_object('event_type', t,
             'lines', coalesce((select jsonb_agg(m.description order by m.sort, m.description)
                                  from wp_music_defaults m where m.event_type = t), '[]'::jsonb))
           order by o)
      from unnest(array['Wedding', 'Party', 'Wake', 'Other']) with ordinality as x(t, o)));
end $function$;

-- Changes the suggestions for events that open their Music tab from now on.
-- An event already seeded keeps its own list.
create or replace function public.wp_admin_save_music_defaults(p_event_type text, p_lines text[])
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_event_type not in ('Wedding', 'Party', 'Wake', 'Other') then
    return jsonb_build_object('ok', false, 'error', 'bad_event_type');
  end if;
  if coalesce(array_length(p_lines, 1), 0) > 30 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;
  delete from wp_music_defaults where event_type = p_event_type;
  insert into wp_music_defaults (event_type, description, sort)
  select p_event_type, left(trim(l), 200), o * 10
    from unnest(coalesce(p_lines, '{}')) with ordinality as x(l, o)
   where length(trim(l)) > 0
  on conflict (event_type, description) do nothing;   -- a line typed twice counts once
  perform wp_log('admin', 'changed the music suggestions for ' || p_event_type);
  return jsonb_build_object('ok', true);
end $function$;

-- Suggested lines go in on the first visit, from the event type's list above,
-- with empty links. They go in once: a client who deletes them all does not
-- get them back.
create or replace function public.wp_get_music()
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_type text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  perform pg_advisory_xact_lock(hashtext('wp_seed_music'), v_event);   -- see the seeding note in §3
  if not exists (select 1 from wp_event_profile where event_id = v_event and music_seeded_at is not null) then
    v_type := wp_event_type_of(v_event);
    insert into wp_playlist (event_id, description, sort)
    select v_event, m.description, m.sort
      from wp_music_defaults m
     where m.event_type = v_type
       and not exists (select 1 from wp_playlist where event_id = v_event);
    insert into wp_event_profile (event_id, music_seeded_at) values (v_event, now())
    on conflict (event_id) do update set music_seeded_at = now();
  end if;

  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'description', p.description, 'url', p.url)
           order by p.sort, p.created_at)
      from wp_playlist p where p.event_id = v_event), '[]'::jsonb));
end $function$;

-- p_id NULL adds a line; otherwise it edits one of the caller's own lines.
create or replace function public.wp_save_music_item(p_id uuid, p_description text, p_url text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_url text := nullif(trim(coalesce(p_url, '')), '');
  v_id uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if length(trim(coalesce(p_description, ''))) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_description');
  end if;
  if v_url is not null and not wp_music_url_ok(v_url) then
    return jsonb_build_object('ok', false, 'error', 'not_spotify');
  end if;

  if p_id is null then
    if (select count(*) from wp_playlist where event_id = v_event) >= 60 then
      return jsonb_build_object('ok', false, 'error', 'too_many');
    end if;
    insert into wp_playlist (event_id, description, url, sort)
    values (v_event, left(trim(p_description), 200), v_url,
            coalesce((select max(sort) + 10 from wp_playlist where event_id = v_event), 10))
    returning id into v_id;
  else
    update wp_playlist set description = left(trim(p_description), 200), url = v_url
     where id = p_id and event_id = v_event
    returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  end if;
  perform wp_log('music', 'saved ' || left(trim(p_description), 60));
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

create or replace function public.wp_delete_music_item(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  delete from wp_playlist where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('music', 'removed a music line');
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_music(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('description', p.description, 'url', p.url) order by p.sort, p.created_at)
      from wp_playlist p where p.event_id = p_event_id), '[]'::jsonb));
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
-- 10. MARKETING — "keep in touch", ticked by default
-- ════════════════════════════════════════════════════════════════════════════
-- Under PECR a booked couple can be emailed on the soft opt-in basis — the
-- basis brevo-sync.js already records — PROVIDED they are offered a simple way
-- to refuse when their details are collected. A pre-ticked box is that offer,
-- framed as what it is: untick to opt out. It is not consent, and must never
-- be described or relied on as consent (a pre-ticked box cannot be, under UK
-- GDPR). One choice per login, because two partners can feel differently.
--
-- brevo-sync.js reads the opt-outs and unsubscribes those addresses in Brevo.
-- Re-ticking later does NOT resubscribe them there automatically: we cannot
-- tell an unsubscribe made here from one made from an email footer, and
-- reversing the second would be the serious mistake.

alter table public.wp_access add column if not exists marketing_ok boolean not null default true;
alter table public.wp_access add column if not exists marketing_changed_at timestamptz;

create or replace function public.wp_set_marketing(p_ok boolean)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  update wp_access
     set marketing_ok = coalesce(p_ok, true), marketing_changed_at = now()
   where event_id = v_event and revoked_at is null
     and (user_id = auth.uid() or email = lower(coalesce(auth.jwt() ->> 'email', '~none~')));
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $function$;



-- ════════════════════════════════════════════════════════════════════════════
-- 11. WEBCAST, and PHOTOS & FILMS
-- ════════════════════════════════════════════════════════════════════════════

-- The webcast page: the stream address and password staff set for the event.
-- Shown only while the Webcast section is visible to that event (normally
-- because the webcast add-on has been confirmed).
create table if not exists public.wp_webcast (
  event_id    integer primary key,
  stream_url  text check (stream_url is null or stream_url ~ '^https://'),
  password    text,
  notes       text,
  updated_at  timestamptz not null default now()
);
alter table public.wp_webcast enable row level security;
revoke all on table public.wp_webcast from anon, authenticated;

create or replace function public.wp_get_webcast()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id(); w wp_webcast%rowtype;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if not (wp_visible_sections(v_event) ? 'webcast') then
    return jsonb_build_object('ok', false, 'error', 'not_available');
  end if;
  select * into w from wp_webcast where event_id = v_event;
  return jsonb_build_object('ok', true, 'stream_url', w.stream_url, 'password', w.password, 'notes', w.notes);
end $function$;

create or replace function public.wp_admin_webcast(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare w wp_webcast%rowtype;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select * into w from wp_webcast where event_id = p_event_id;
  return jsonb_build_object('ok', true, 'shown', wp_visible_sections(p_event_id) ? 'webcast',
    'stream_url', w.stream_url, 'password', w.password, 'notes', w.notes);
end $function$;

create or replace function public.wp_admin_save_webcast(p_event_id integer, p_stream_url text, p_password text, p_notes text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_url text := nullif(trim(coalesce(p_stream_url, '')), '');
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if v_url is not null and v_url !~ '^https://' then return jsonb_build_object('ok', false, 'error', 'url_not_https'); end if;
  insert into wp_webcast (event_id, stream_url, password, notes, updated_at)
  values (p_event_id, left(v_url, 1000), left(nullif(trim(coalesce(p_password, '')), ''), 200),
          left(nullif(trim(coalesce(p_notes, '')), ''), 1000), now())
  on conflict (event_id) do update set stream_url = excluded.stream_url, password = excluded.password,
    notes = excluded.notes, updated_at = now();
  return jsonb_build_object('ok', true);
end $function$;


-- Photos and films a client sends us — for a wake, the pictures for the
-- slideshow and the films for the screen.
--
-- THE SHAPE. Files go straight from the browser to a PRIVATE storage bucket
-- with a one-use signed upload URL, so a 400MB film never passes through a
-- Netlify function (they take 6MB). netlify/functions/portal-upload.js:
--   1. asks wp_upload_slot() AS THE USER — which checks the event, the
--      section, the type and the size, and decides the path itself
--      (<event_id>/<uuid>.<ext>); the client never names a path;
--   2. signs an upload URL for exactly that path with the service key;
--   3. after the upload, checks the object is really there and calls
--      wp_upload_confirm() with the service key, so a row only becomes
--      "ready" when a file exists.
-- Viewing and deleting go through the same function the same way. Clients see
-- only their own event's files; staff see any.
create table if not exists public.wp_uploads (
  id          uuid primary key default gen_random_uuid(),
  event_id    integer not null,
  path        text not null unique,
  name        text not null,
  kind        text not null check (kind in ('image', 'video')),
  mime        text not null,
  size_bytes  bigint not null check (size_bytes > 0),
  caption     text,
  status      text not null default 'pending' check (status in ('pending', 'ready')),
  uploaded_by text,
  created_at  timestamptz not null default now(),
  ready_at    timestamptz
);
create index if not exists wp_uploads_event on public.wp_uploads (event_id, created_at);
alter table public.wp_uploads enable row level security;
revoke all on table public.wp_uploads from anon, authenticated;

insert into public.wp_settings (key, value) values ('upload_max_mb', '500') on conflict (key) do nothing;

-- The private bucket, where Supabase storage exists (not on a bare replica).
-- Its own limit backs up the function's; the project-wide upload limit in the
-- Supabase dashboard must be at least as large for films to get through.
do $bucket$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute $q$insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('portal-uploads', 'portal-uploads', false, 524288000,
              array['image/jpeg','image/png','image/webp','image/heic','image/heif',
                    'video/mp4','video/quicktime','video/x-m4v','video/webm'])
      on conflict (id) do nothing$q$;
  end if;
end $bucket$;

create or replace function public.wp_upload_slot(p_name text, p_size bigint, p_mime text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_kind text;
  v_ext  text;
  v_max  bigint := coalesce((select value::bigint from wp_settings where key = 'upload_max_mb'), 500) * 1048576;
  v_id   uuid := gen_random_uuid();
  v_path text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if not (wp_visible_sections(v_event) ? 'uploads') then
    return jsonb_build_object('ok', false, 'error', 'not_available');
  end if;
  v_kind := case when p_mime in ('image/jpeg','image/png','image/webp','image/heic','image/heif') then 'image'
                 when p_mime in ('video/mp4','video/quicktime','video/x-m4v','video/webm') then 'video' end;
  if v_kind is null then return jsonb_build_object('ok', false, 'error', 'bad_type'); end if;
  if p_size is null or p_size <= 0 or p_size > v_max then
    return jsonb_build_object('ok', false, 'error', 'too_big', 'max_mb', v_max / 1048576);
  end if;
  if (select count(*) from wp_uploads where event_id = v_event) >= 300 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  v_ext := case p_mime when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
                       when 'image/heic' then 'heic' when 'image/heif' then 'heif' when 'video/mp4' then 'mp4'
                       when 'video/quicktime' then 'mov' when 'video/x-m4v' then 'm4v' else 'webm' end;
  v_path := v_event || '/' || v_id || '.' || v_ext;
  insert into wp_uploads (id, event_id, path, name, kind, mime, size_bytes, uploaded_by)
  values (v_id, v_event, v_path, left(coalesce(nullif(trim(p_name), ''), 'file'), 200), v_kind, p_mime, p_size,
          lower(coalesce(auth.jwt() ->> 'email', '')));
  return jsonb_build_object('ok', true, 'id', v_id, 'path', v_path);
end $function$;

-- Service key only: the file is there, so the row is real.
create or replace function public.wp_upload_confirm(p_id uuid, p_size bigint)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  update wp_uploads set status = 'ready', ready_at = now(), size_bytes = coalesce(p_size, size_bytes)
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- Logged directly, not through wp_log(): this runs with the service key, so
  -- there is no signed-in person for wp_log to find an event from.
  insert into wp_change_log (event_id, actor_email, area, summary)
  select event_id, uploaded_by, 'uploads', 'sent ' || name from wp_uploads where id = p_id;
  return jsonb_build_object('ok', true);
end $function$;

-- Whether the CALLER may see / remove this upload, and where it is. Asked as
-- the user by the function: a client gets their own event's files only; staff
-- any. p_for 'view' needs the file ready; 'delete' does not (an abandoned
-- upload can be cleared).
create or replace function public.wp_upload_path(p_id uuid, p_for text)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare u wp_uploads%rowtype; v_event integer;
begin
  select * into u from wp_uploads where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not is_staff() then
    v_event := wp_my_event_id();
    if v_event is null or u.event_id <> v_event then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  end if;
  if p_for = 'view' and u.status <> 'ready' then return jsonb_build_object('ok', false, 'error', 'not_ready'); end if;
  return jsonb_build_object('ok', true, 'path', u.path, 'event_id', u.event_id, 'status', u.status,
                            'size_bytes', u.size_bytes, 'mime', u.mime, 'name', u.name);
end $function$;

-- Service key only, after the stored file is gone.
create or replace function public.wp_upload_forget(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  delete from wp_uploads where id = p_id;
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_get_uploads()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object('ok', true,
    'max_mb', coalesce((select value::int from wp_settings where key = 'upload_max_mb'), 500),
    'uploads', coalesce((select jsonb_agg(jsonb_build_object(
        'id', u.id, 'name', u.name, 'kind', u.kind, 'size_bytes', u.size_bytes, 'caption', u.caption,
        'uploaded_by', u.uploaded_by, 'created_at', u.created_at) order by u.created_at)
      from wp_uploads u where u.event_id = v_event and u.status = 'ready'), '[]'::jsonb));
end $function$;

create or replace function public.wp_set_upload_caption(p_id uuid, p_caption text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  update wp_uploads set caption = left(nullif(trim(coalesce(p_caption, '')), ''), 300)
   where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('uploads', 'captioned a photo or film');
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_uploads(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'uploads', coalesce((select jsonb_agg(jsonb_build_object(
      'id', u.id, 'name', u.name, 'kind', u.kind, 'size_bytes', u.size_bytes, 'caption', u.caption,
      'status', u.status, 'uploaded_by', u.uploaded_by, 'created_at', u.created_at) order by u.created_at)
    from wp_uploads u where u.event_id = p_event_id), '[]'::jsonb));
end $function$;

-- ════════════════════════════════════════════════════════════════════════════
-- GRANTS
-- ════════════════════════════════════════════════════════════════════════════
-- Supabase grants EXECUTE to anon AND authenticated on every new function.
-- Revoke all three by name, then grant back only what is meant to be called.

do $grants$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'wp_set_guest_extras',
       'wp_section_area', 'wp_section_rows', 'wp_get_sections', 'wp_set_section_ready',
       'wp_admin_sections', 'wp_admin_reopen_section',
       'wp_minutes_after', 'wp_set_ceremony_time', 'wp_set_block_follows', 'wp_answer_block',
       'wp_get_items', 'wp_add_item', 'wp_update_item', 'wp_delete_item',
       'wp_admin_items', 'wp_admin_mark_item', 'wp_admin_item_types', 'wp_admin_save_item_types',
       'wp_get_addons', 'wp_request_addon', 'wp_cancel_addon',
       'wp_admin_addons', 'wp_admin_save_addons', 'wp_admin_addon_requests', 'wp_admin_decide_addon',
       'wp_section_keys', 'wp_event_type_of', 'wp_visible_sections', 'wp_admin_section_defaults',
       'wp_admin_save_section_defaults', 'wp_admin_event_sections', 'wp_admin_set_event_section',
       'wp_get_home', 'wp_admin_profile',
       'wp_get_venue_docs', 'wp_admin_venue_settings', 'wp_admin_save_venue_settings',
       'wp_get_food', 'wp_save_food', 'wp_admin_food_packages', 'wp_admin_save_food_packages', 'wp_admin_food',
       'wp_music_url_ok', 'wp_get_music', 'wp_save_music_item', 'wp_delete_music_item', 'wp_admin_music',
       'wp_admin_music_defaults', 'wp_admin_save_music_defaults',
       'wp_get_webcast', 'wp_admin_webcast', 'wp_admin_save_webcast',
       'wp_upload_slot', 'wp_upload_confirm', 'wp_upload_path', 'wp_upload_forget', 'wp_get_uploads',
       'wp_set_upload_caption', 'wp_admin_uploads',
       'wp_set_marketing')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    -- Internal helpers stay with service_role only. They are only ever called
    -- from inside SECURITY DEFINER functions, which run as the owner.
    if f.proname in ('wp_section_area', 'wp_section_rows', 'wp_minutes_after', 'wp_section_keys',
                     'wp_event_type_of', 'wp_visible_sections', 'wp_music_url_ok',
                     -- called only by netlify/functions/portal-upload.js with the service key
                     'wp_upload_confirm', 'wp_upload_forget') then
      execute format('grant execute on function %s to service_role', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $grants$;

commit;
