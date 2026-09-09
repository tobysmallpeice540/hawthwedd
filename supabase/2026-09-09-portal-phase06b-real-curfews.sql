-- supabase/2026-09-09-portal-phase06b-real-curfews.sql
--
-- Portal timeline, corrected against how Hawthbush actually works.
--
-- APPLIED TO PRODUCTION 9 September 2026 as two migrations:
--   portal_phase06b_real_curfews
--   portal_phase06b_fix_after_midnight_ordering  (the sort-key fix, below)
--
-- Assertions: portal-phase06b-curfews-test.sql — 12, all passing.
--
-- THREE THINGS WERE WRONG IN PHASE 06, all from the same mistaken assumption
-- that access times are a property of the event TYPE. They are not: they are in
-- each event's contract.
--
-- 1. ACCESS IS PER EVENT, AND IT IS PROSE. The contract holds three free-text
--    fields — "Midday to 4.30pm", "10am to Midnight", "10am to 11.30am". It is
--    NOT parsed. Reading a number out of free text is how "£9 per adult · 100
--    guests" became £9,100 in the corkage field, and the same rule applies
--    here: the prose is shown to the couple verbatim, and anything the portal
--    needs to CALCULATE with comes from a structured time an admin has set.
--
-- 2. A PARTY'S CURFEW IS DERIVED, NOT FIXED. Music, bar and carriages are 30
--    minutes before the end of access on the day; the last 30 minutes are
--    clearing up, so the site closes at the end of access. A wake is the same.
--    A wedding is absolute: music midnight, bar 23:45, carriages midnight,
--    site closed 00:30.
--
-- 3. "OTHER" IS A MOP-UP CATEGORY with no house rule, so its times are set per
--    event by an admin or not shown at all.
--
-- AND ONE CONSEQUENCE: fixed points are no longer seeded as rows. A stored row
-- saying "Bar closes 23:00" would be wrong the moment an access time changed.
-- They are computed on every read instead, so they cannot go stale. Times after
-- midnight sort to the end of the day rather than the start.
--
-- STILL OPEN: no event has structured access times yet, so a Party or Wake
-- shows no finishing times at all until an admin sets the access end. That is
-- deliberate — showing an invented curfew would be worse than showing none.

-- ── Event-type rules, reshaped ──────────────────────────────────────────────

alter table public.wp_event_type_days drop column if exists access_at;
alter table public.wp_event_type_days drop column if exists vacate_by;
alter table public.wp_event_type_days add column if not exists curfew_mode text
  not null default 'per_event' check (curfew_mode in ('absolute','before_access_end','per_event'));
alter table public.wp_event_type_days add column if not exists offset_min integer;
alter table public.wp_event_type_days add column if not exists site_closed time;

update public.wp_event_type_days set music_ends=null, bar_closes=null, carriages=null;

-- Wedding: absolute, exactly as Toby gave them.
update public.wp_event_type_days
   set curfew_mode='absolute', music_ends='00:00', bar_closes='23:45',
       carriages='00:00', site_closed='00:30', offset_min=null
 where event_type='Wedding' and day_key='event';

-- Party and Wake: 30 minutes before the end of access; the last half hour is
-- clearing up, so the site closes when access ends.
update public.wp_event_type_days
   set curfew_mode='before_access_end', offset_min=30,
       music_ends=null, bar_closes=null, carriages=null, site_closed=null
 where event_type in ('Party','Wake') and day_key='event';

-- Other: no house rule. Admin sets it per event, or nothing is shown.
update public.wp_event_type_days
   set curfew_mode='per_event', offset_min=null
 where event_type='Other';

update public.wp_event_type_days set curfew_mode='per_event'
 where day_key <> 'event' and curfew_mode <> 'per_event';

-- ── Structured access times, set by an admin, never parsed ──────────────────

create table if not exists public.wp_event_access (
  event_id    integer not null,
  day_key     text not null check (day_key in ('before','event','after')),
  access_from time,
  access_to   time,
  -- for 'Other', and for any event needing a one-off
  music_ends  time,
  bar_closes  time,
  carriages   time,
  site_closed time,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  primary key (event_id, day_key)
);
alter table public.wp_event_access enable row level security;

-- ── Fixed points, computed rather than stored ───────────────────────────────
--
-- The ordering here caught a real bug on the way in. The first version added
-- `interval '24 hours'` to an after-midnight time, which does not do what it
-- looks like: in Postgres, time + interval returns a time and WRAPS, so
-- 00:30 + 24h is 00:30 again. Sort on minutes past midnight instead.

create or replace function public.wp_fixed_points(p_event_id integer, p_event_type text, p_day_key text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  r wp_event_type_days%rowtype;
  a wp_event_access%rowtype;
  v_music time; v_bar time; v_car time; v_site time;
begin
  select * into r from wp_event_type_days
   where event_type = p_event_type and day_key = p_day_key;
  if not found or not r.offered then return '[]'::jsonb; end if;

  select * into a from wp_event_access where event_id = p_event_id and day_key = p_day_key;

  if r.curfew_mode = 'absolute' then
    v_music := r.music_ends; v_bar := r.bar_closes;
    v_car   := r.carriages;  v_site := r.site_closed;
  elsif r.curfew_mode = 'before_access_end' and a.access_to is not null then
    -- 30 minutes before access ends; the last half hour is clearing up.
    v_music := a.access_to - make_interval(mins => r.offset_min);
    v_bar   := v_music;
    v_car   := v_music;
    v_site  := a.access_to;
  end if;

  -- A per-event value always wins, whatever the type rule said.
  v_music := coalesce(a.music_ends,  v_music);
  v_bar   := coalesce(a.bar_closes,  v_bar);
  v_car   := coalesce(a.carriages,   v_car);
  v_site  := coalesce(a.site_closed, v_site);

  return (
    select coalesce(jsonb_agg(x order by x_sort), '[]'::jsonb)
      from (
        select jsonb_build_object('title', t, 'time', v, 'locked', true) as x,
               -- minutes past midnight; anything before 6am belongs to the end
               -- of the night, so it gets a day added rather than sorting first
               (extract(epoch from v) / 60
                 + case when v < '06:00'::time then 1440 else 0 end) as x_sort
          from (values
                 ('Music ends', v_music),
                 ('Bar closes', v_bar),
                 ('Carriages',  v_car),
                 ('Site closed and everything away', v_site)
               ) as f(t, v)
         where v is not null
      ) s
  );
end;
$function$;

-- ── Stop seeding locked rows, and remove any already seeded ─────────────────

delete from public.wp_timeline_template where locked;
delete from public.wp_timeline where locked;

-- ── Read, rebuilt around the above ──────────────────────────────────────────

create or replace function public.wp_get_timeline()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  ev jsonb;
  v_type text;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select e into ev from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = v_event limit 1;

  v_type := coalesce(wp_event_type_label(ev ->> 'eventType'), 'Other');
  if not exists (select 1 from wp_event_type_days where event_type = v_type) then
    v_type := 'Other';
  end if;

  if not exists (select 1 from wp_timeline where event_id = v_event) then
    insert into wp_timeline (event_id, day_key, start_time, duration_min, title, notes, locked, sort)
    select v_event, t.day_key, t.start_time, t.duration_min, t.title, t.notes, false, t.sort
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
               -- The contract's own words, shown verbatim and never parsed.
               'access_text', case d.day_key
                 when 'before' then ev -> 'contract' -> 'values' ->> 'Access Day Before'
                 when 'event'  then ev -> 'contract' -> 'values' ->> 'Access Event Day'
                 else               ev -> 'contract' -> 'values' ->> 'Access Day After' end,
               'fixed', wp_fixed_points(v_event, v_type, d.day_key))
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
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
        from wp_event_suppliers es join wp_suppliers s on s.id = es.supplier_id
       where es.event_id = v_event), '[]'::jsonb)
  );
end;
$function$;

-- ── Admin: the structured times ─────────────────────────────────────────────

create or replace function public.wp_admin_set_access(
  p_event_id integer, p_day_key text,
  p_access_from time default null, p_access_to time default null,
  p_music_ends time default null, p_bar_closes time default null,
  p_carriages time default null, p_site_closed time default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_day_key not in ('before','event','after') then
    return jsonb_build_object('ok', false, 'error', 'bad_day'); end if;

  insert into wp_event_access as x
    (event_id, day_key, access_from, access_to, music_ends, bar_closes, carriages, site_closed, updated_by)
  values (p_event_id, p_day_key, p_access_from, p_access_to,
          p_music_ends, p_bar_closes, p_carriages, p_site_closed, auth.uid())
  on conflict (event_id, day_key) do update
    set access_from = excluded.access_from, access_to = excluded.access_to,
        music_ends = excluded.music_ends, bar_closes = excluded.bar_closes,
        carriages = excluded.carriages, site_closed = excluded.site_closed,
        updated_at = now(), updated_by = auth.uid();

  return jsonb_build_object('ok', true);
end;
$function$;

-- What the admin screen needs: the contract's prose beside the structured time,
-- so a human can read one and set the other. Deliberately not automatic.
create or replace function public.wp_admin_access(p_event_id integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare ev jsonb; v_type text;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select e into ev from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event_id limit 1;
  if ev is null then return jsonb_build_object('ok', false, 'error', 'event_not_found'); end if;
  v_type := coalesce(wp_event_type_label(ev ->> 'eventType'), 'Other');

  return jsonb_build_object(
    'ok', true, 'event_type', v_type,
    'needs_times', exists (
      select 1 from wp_event_type_days d
       where d.event_type = v_type and d.day_key = 'event' and d.offered
         and d.curfew_mode in ('before_access_end','per_event')),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day_key', d.day_key, 'label', d.label, 'curfew_mode', d.curfew_mode,
               'contract_text', case d.day_key
                 when 'before' then coalesce(ev->'contract'->'values'->>'Access Day Before', ev->'contract'->'fields'->>'accessBefore')
                 when 'event'  then coalesce(ev->'contract'->'values'->>'Access Event Day',  ev->'contract'->'fields'->>'accessDay')
                 else               coalesce(ev->'contract'->'values'->>'Access Day After',  ev->'contract'->'fields'->>'accessAfter') end,
               'access_from', a.access_from, 'access_to', a.access_to,
               'music_ends', a.music_ends, 'bar_closes', a.bar_closes,
               'carriages', a.carriages, 'site_closed', a.site_closed,
               'resolved', wp_fixed_points(p_event_id, v_type, d.day_key))
             order by case d.day_key when 'before' then 1 when 'event' then 2 else 3 end)
        from wp_event_type_days d
        left join wp_event_access a on a.event_id = p_event_id and a.day_key = d.day_key
       where d.event_type = v_type and d.offered), '[]'::jsonb));
end;
$function$;

revoke all on function public.wp_fixed_points(integer,text,text)                          from public, anon, authenticated;
revoke all on function public.wp_admin_set_access(integer,text,time,time,time,time,time,time) from public, anon, authenticated;
revoke all on function public.wp_admin_access(integer)                                    from public, anon, authenticated;
revoke all on function public.wp_get_timeline()                                           from public, anon, authenticated;

grant execute on function public.wp_fixed_points(integer,text,text)                       to service_role;
grant execute on function public.wp_admin_set_access(integer,text,time,time,time,time,time,time) to authenticated, service_role;
grant execute on function public.wp_admin_access(integer)                                 to authenticated, service_role;
grant execute on function public.wp_get_timeline()                                        to authenticated, service_role;

do $verify$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;
  if (select count(*) from wp_timeline_template where locked) <> 0 then
    raise exception 'locked template rows still present'; end if;
  raise notice 'phase 06b in place';
end
$verify$;
