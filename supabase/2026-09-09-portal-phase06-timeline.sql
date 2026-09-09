-- supabase/2026-09-09-portal-phase06-timeline.sql
--
-- Wedding client portal — phase 06: the timeline.
--
-- APPLIED TO PRODUCTION 9 September 2026 as migration portal_phase06_timeline.
-- Assertions: portal-phase06-timeline-test.sql — 17, all passing.
--
-- A LIST, NOT A GANTT. Each block is a start time, a length, a title, an
-- optional supplier and a note. The list is ordered by time; moving something
-- means changing its time. wp_shift_after() pushes everything from a given time
-- onwards, which is what actually happens when a ceremony runs late.
--
-- IT SPANS DAYS. Which days a wedding gets — the day before, the day itself,
-- the day after — comes from the event type, not from the couple. A PARTY IS A
-- SINGLE DAY with no access either side, which has a consequence worth building
-- in rather than discovering: with no day-before access the setup happens on the
-- morning, so the party template opens with setup and supplier arrivals rather
-- than at guest arrival. A wedding's template can assume the room was dressed
-- yesterday; a party's cannot.
--
-- Rules hang off the event type LABEL, not the variant: peak is a pricing
-- distinction, not an operational one, and a peak wedding keeps the same curfew
-- as an off-peak one.
--
-- >>> SUPERSEDED IN PART by 2026-09-09-portal-phase06b-real-curfews.sql, which
-- >>> corrects three things: access times are per event and live in the
-- >>> contract as PROSE (never parsed), a Party's curfew is derived from the
-- >>> end of access rather than fixed, and fixed points are computed on read
-- >>> rather than seeded as locked rows. Read that file alongside this one.
--
-- >>> THE TIMES BELOW ARE PLACEHOLDERS. Party-as-single-day and
-- >>> wedding-as-three-days are Toby's decisions and are correct. Every clock
-- >>> time — access, music end, bar close, carriages, vacate — and the Wake and
-- >>> Other rows are guesses that need replacing with the real house rules
-- >>> before a couple sees them. Changing them here changes what every future
-- >>> timeline is measured against; blocks already created keep their times.

-- ── Event type rules ────────────────────────────────────────────────────────

create or replace function public.wp_event_type_label(p_raw text)
 returns text
 language sql
 immutable
as $function$
  select coalesce(nullif(trim(regexp_replace(coalesce(p_raw, ''), '\s*\(.*?\)\s*$', '')), ''), 'Other');
$function$;

create table if not exists public.wp_event_type_days (
  event_type text not null,
  day_key    text not null check (day_key in ('before','event','after')),
  offered    boolean not null default true,
  label      text not null,
  access_at  time,
  music_ends time,
  bar_closes time,
  carriages  time,
  vacate_by  time,
  primary key (event_type, day_key)
);
alter table public.wp_event_type_days enable row level security;

insert into public.wp_event_type_days
  (event_type, day_key, offered, label, access_at, music_ends, bar_closes, carriages, vacate_by) values
  -- A wedding takes all three days.
  ('Wedding','before', true,  'The day before', '10:00', null,    null,    null,    null),
  ('Wedding','event',  true,  'The day',        '08:00', '23:30', '23:30', '00:00', null),
  ('Wedding','after',  true,  'The day after',  null,    null,    null,    null,    '11:00'),
  -- A party is a single day. No access either side. Toby's decision.
  ('Party','before',   false, 'The day before', null,    null,    null,    null,    null),
  ('Party','event',    true,  'The day',        '09:00', '23:00', '23:00', '23:30', '10:00'),
  ('Party','after',    false, 'The day after',  null,    null,    null,    null,    null),
  -- Wake and Other: single day by default, PENDING Toby's answer.
  ('Wake','before',    false, 'The day before', null,    null,    null,    null,    null),
  ('Wake','event',     true,  'The day',        '09:00', '22:00', '22:00', '22:30', '10:00'),
  ('Wake','after',     false, 'The day after',  null,    null,    null,    null,    null),
  ('Other','before',   false, 'The day before', null,    null,    null,    null,    null),
  ('Other','event',    true,  'The day',        '09:00', '23:00', '23:00', '23:30', '10:00'),
  ('Other','after',    false, 'The day after',  null,    null,    null,    null,    null)
on conflict (event_type, day_key) do update
  set offered = excluded.offered, label = excluded.label, access_at = excluded.access_at,
      music_ends = excluded.music_ends, bar_closes = excluded.bar_closes,
      carriages = excluded.carriages, vacate_by = excluded.vacate_by;

-- ── The blocks ──────────────────────────────────────────────────────────────

create table if not exists public.wp_timeline (
  id           uuid primary key default gen_random_uuid(),
  event_id     integer not null,
  day_key      text not null check (day_key in ('before','event','after')),
  start_time   time not null,
  duration_min integer not null default 30 check (duration_min between 0 and 1440),
  title        text not null,
  notes        text,
  supplier_id  uuid references public.wp_suppliers(id) on delete set null,
  locked       boolean not null default false,   -- venue-fixed: bar close, curfew
  pinned       boolean not null default false,   -- the couple's own "do not move"
  sort         integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists wp_timeline_event on public.wp_timeline (event_id, day_key, start_time);
alter table public.wp_timeline enable row level security;

create table if not exists public.wp_timeline_template (
  id           serial primary key,
  event_type   text not null,
  day_key      text not null,
  start_time   time not null,
  duration_min integer not null default 30,
  title        text not null,
  notes        text,
  locked       boolean not null default false,
  sort         integer not null default 0
);
alter table public.wp_timeline_template enable row level security;

delete from public.wp_timeline_template;
insert into public.wp_timeline_template
  (event_type, day_key, start_time, duration_min, title, notes, locked, sort) values
  -- Wedding: the room is dressed the day before.
  ('Wedding','before','10:00', 240, 'Access for setting up', 'Flowers, styling, anything being dropped off.', false, 10),
  ('Wedding','before','16:00',  60, 'Rehearsal',              null, false, 20),
  ('Wedding','event', '08:00',  60, 'Suppliers arrive',       null, false, 10),
  ('Wedding','event', '13:00',  45, 'Ceremony',               null, false, 20),
  ('Wedding','event', '13:45',  90, 'Drinks and photographs', null, false, 30),
  ('Wedding','event', '15:30', 120, 'Wedding breakfast',      null, false, 40),
  ('Wedding','event', '17:30',  45, 'Speeches',               null, false, 50),
  ('Wedding','event', '19:30',  30, 'Cake and first dance',   null, false, 60),
  ('Wedding','event', '23:30',   0, 'Music ends',   'Set by the venue.', true, 900),
  ('Wedding','event', '23:30',   0, 'Bar closes',   'Set by the venue.', true, 910),
  ('Wedding','event', '00:00',   0, 'Carriages',    'Set by the venue.', true, 920),
  ('Wedding','after', '09:00',  90, 'Breakfast',              null, false, 10),
  ('Wedding','after', '11:00',   0, 'Everything cleared and away', 'Set by the venue.', true, 900),
  -- Party: single day, so setup has to happen on the morning.
  ('Party','event','09:00', 180, 'Access and setting up', 'There is no access the day before, so everything happens this morning.', false, 10),
  ('Party','event','12:00',  60, 'Suppliers arrive',      null, false, 20),
  ('Party','event','14:00',  30, 'Guests arrive',         null, false, 30),
  ('Party','event','23:00',   0, 'Music ends', 'Set by the venue.', true, 900),
  ('Party','event','23:00',   0, 'Bar closes', 'Set by the venue.', true, 910),
  ('Party','event','23:30',   0, 'Carriages',  'Set by the venue.', true, 920);

-- ── Read ────────────────────────────────────────────────────────────────────

create or replace function public.wp_get_timeline()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_type  text;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select wp_event_type_label(e ->> 'eventType') into v_type
    from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = v_event limit 1;
  v_type := coalesce(v_type, 'Other');
  if not exists (select 1 from wp_event_type_days where event_type = v_type) then
    v_type := 'Other';
  end if;

  -- Seed once, from the template for this event type. Idempotent: the venue
  -- rows are locked and cannot be deleted, so the count never returns to zero.
  if not exists (select 1 from wp_timeline where event_id = v_event) then
    insert into wp_timeline (event_id, day_key, start_time, duration_min, title, notes, locked, sort)
    select v_event, t.day_key, t.start_time, t.duration_min, t.title, t.notes, t.locked, t.sort
      from wp_timeline_template t
      join wp_event_type_days d on d.event_type = t.event_type and d.day_key = t.day_key and d.offered
     where t.event_type = v_type;
  end if;

  return jsonb_build_object(
    'ok', true,
    'event_type', v_type,
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day_key', d.day_key, 'label', d.label,
               'access_at', d.access_at, 'music_ends', d.music_ends,
               'bar_closes', d.bar_closes, 'carriages', d.carriages, 'vacate_by', d.vacate_by)
             order by case d.day_key when 'before' then 1 when 'event' then 2 else 3 end)
        from wp_event_type_days d where d.event_type = v_type and d.offered), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'day_key', b.day_key, 'start_time', b.start_time,
               'duration_min', b.duration_min, 'title', b.title, 'notes', b.notes,
               'supplier_id', b.supplier_id, 'supplier_name', s.name,
               'locked', b.locked, 'pinned', b.pinned)
             order by case b.day_key when 'before' then 1 when 'event' then 2 else 3 end,
                      b.start_time, b.sort)
        from wp_timeline b left join wp_suppliers s on s.id = b.supplier_id
       where b.event_id = v_event), '[]'::jsonb),
    -- for the "who is this" dropdown on a block
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
        from wp_event_suppliers es join wp_suppliers s on s.id = es.supplier_id
       where es.event_id = v_event), '[]'::jsonb)
  );
end;
$function$;

-- ── Writing ─────────────────────────────────────────────────────────────────

create or replace function public.wp_add_block(
  p_day_key text, p_start_time time, p_title text,
  p_duration_min integer default 30, p_notes text default null,
  p_supplier_id uuid default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_title text := trim(coalesce(p_title, ''));
  v_id uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_day_key not in ('before','event','after') then
    return jsonb_build_object('ok', false, 'error', 'bad_day'); end if;
  if length(v_title) = 0 then return jsonb_build_object('ok', false, 'error', 'no_title'); end if;
  if p_start_time is null then return jsonb_build_object('ok', false, 'error', 'no_time'); end if;

  -- A day the event type does not offer is not a day.
  if not exists (
    select 1 from app_data d, lateral jsonb_array_elements(d.value) e
      join wp_event_type_days t
        on t.event_type = wp_event_type_label(e ->> 'eventType') and t.day_key = p_day_key and t.offered
     where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = v_event)
  then
    return jsonb_build_object('ok', false, 'error', 'day_not_offered');
  end if;

  -- A supplier must be one this wedding has actually chosen.
  if p_supplier_id is not null and not exists (
    select 1 from wp_event_suppliers where event_id = v_event and supplier_id = p_supplier_id)
  then
    return jsonb_build_object('ok', false, 'error', 'not_your_supplier');
  end if;

  insert into wp_timeline (event_id, day_key, start_time, duration_min, title, notes, supplier_id)
  values (v_event, p_day_key, p_start_time, greatest(0, least(1440, coalesce(p_duration_min, 30))),
          left(v_title, 120), left(nullif(trim(coalesce(p_notes,'')),''), 500), p_supplier_id)
  returning id into v_id;

  perform wp_log('timeline', 'added ' || left(v_title, 60));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

create or replace function public.wp_update_block(
  p_id uuid, p_start_time time default null, p_title text default null,
  p_duration_min integer default null, p_notes text default null,
  p_supplier_id uuid default null, p_pinned boolean default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_locked boolean;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  select locked into v_locked from wp_timeline where id = p_id and event_id = v_event;
  if v_locked is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_locked then return jsonb_build_object('ok', false, 'error', 'locked'); end if;

  if p_supplier_id is not null and not exists (
    select 1 from wp_event_suppliers where event_id = v_event and supplier_id = p_supplier_id)
  then
    return jsonb_build_object('ok', false, 'error', 'not_your_supplier');
  end if;

  update wp_timeline
     set start_time   = coalesce(p_start_time, start_time),
         title        = coalesce(left(trim(p_title), 120), title),
         duration_min = coalesce(greatest(0, least(1440, p_duration_min)), duration_min),
         notes        = coalesce(left(trim(p_notes), 500), notes),
         supplier_id  = coalesce(p_supplier_id, supplier_id),
         pinned       = coalesce(p_pinned, pinned)
   where id = p_id and event_id = v_event;

  perform wp_log('timeline', 'edited a block');
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.wp_delete_block(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_locked boolean; v_title text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select locked, title into v_locked, v_title from wp_timeline where id = p_id and event_id = v_event;
  if v_locked is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_locked then return jsonb_build_object('ok', false, 'error', 'locked'); end if;

  delete from wp_timeline where id = p_id and event_id = v_event and not locked;
  perform wp_log('timeline', 'removed ' || left(coalesce(v_title,''), 60));
  return jsonb_build_object('ok', true);
end;
$function$;

-- What actually happens when the ceremony runs late: push everything after it.
-- Locked venue rows never move — the bar does not close later because lunch
-- overran — and neither do blocks the couple has pinned.
create or replace function public.wp_shift_after(p_day_key text, p_from time, p_minutes integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_moved integer;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_day_key not in ('before','event','after') then
    return jsonb_build_object('ok', false, 'error', 'bad_day'); end if;
  if p_minutes is null or abs(p_minutes) > 720 then
    return jsonb_build_object('ok', false, 'error', 'too_far'); end if;

  update wp_timeline
     set start_time = start_time + make_interval(mins => p_minutes)
   where event_id = v_event and day_key = p_day_key
     and start_time >= p_from
     and not locked and not pinned;
  get diagnostics v_moved = row_count;

  perform wp_log('timeline', format('shifted %s block(s) by %s minutes', v_moved, p_minutes));
  return jsonb_build_object('ok', true, 'moved', v_moved);
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

revoke all on function public.wp_get_timeline()                            from public, anon, authenticated;
revoke all on function public.wp_add_block(text,time,text,integer,text,uuid) from public, anon, authenticated;
revoke all on function public.wp_update_block(uuid,time,text,integer,text,uuid,boolean) from public, anon, authenticated;
revoke all on function public.wp_delete_block(uuid)                        from public, anon, authenticated;
revoke all on function public.wp_shift_after(text,time,integer)            from public, anon, authenticated;
revoke all on function public.wp_event_type_label(text)                    from public, anon, authenticated;

grant execute on function public.wp_get_timeline()                         to authenticated, service_role;
grant execute on function public.wp_add_block(text,time,text,integer,text,uuid) to authenticated, service_role;
grant execute on function public.wp_update_block(uuid,time,text,integer,text,uuid,boolean) to authenticated, service_role;
grant execute on function public.wp_delete_block(uuid)                     to authenticated, service_role;
grant execute on function public.wp_shift_after(text,time,integer)         to authenticated, service_role;
grant execute on function public.wp_event_type_label(text)                 to service_role;

do $verify$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;
  if (select count(*) from wp_event_type_days where offered) <> 6 then
    raise exception 'expected 6 offered day rows'; end if;
  raise notice 'phase 06 timeline in place';
end
$verify$;
