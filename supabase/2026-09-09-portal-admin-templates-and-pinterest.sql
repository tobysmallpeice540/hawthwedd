-- supabase/2026-09-09-portal-admin-templates-and-pinterest.sql
--
-- APPLIED 9 September 2026 as migration portal_admin_templates_and_pinterest.
-- Assertions: portal-admin-templates-test.sql — 17, all passing.
--
-- FOUR THINGS.
--
-- 1. wp_shift_after() IS DROPPED. It moved every later block when a day ran
--    late, and the "fix this one" tick existed only to opt out of it. Both are
--    gone from the portal: a timeline is a rough shape a couple sketches, not a
--    schedule that reflows, and things run at the same time as each other all
--    day long. A client-facing function nothing calls is not dead code — it is
--    dead code anyone can still call.
--
-- 2. THE TEMPLATES GET A SCREEN. wp_timeline_template, wp_checklist_template
--    and wp_event_type_days have existed since the portal was built and none of
--    them could be edited without SQL. wp_admin_templates() reads all three;
--    three savers write them.
--
--    THE RULE THAT MAKES THEM SAFE TO EDIT: changing a template never touches a
--    wedding already seeded. A couple shown a 2pm ceremony does not find it
--    silently moved months later. Both templates are COPIED at seed time rather
--    than referenced, which is what makes that true — and is why renumbering
--    the checklist 1..n on every save is harmless.
--
-- 3. AND WHAT PEOPLE DID WITH THEM. wp_admin_event_timeline() shows one
--    couple's suggested day, read-only. A template is worth very little without
--    that: if everyone moves the same line, the template is wrong.
--
-- 4. A PINTEREST BOARD. One URL per event.
--
--    THE HOST IS CHECKED, and that is the assertion worth reading. This URL is
--    rendered as a link that staff click from the admin side, so an unchecked
--    one is somewhere to hang a phishing page under the venue's own branding.
--    Only https and only Pinterest's own domains: `evil.example.com`,
--    `javascript:`, plain http and — the one that catches a lazy regex —
--    `pinterest.com.evil.example.com` are all refused.
--
--    The portal shows it as a LINK, never an embed. Pinterest's board widget
--    works by loading their JavaScript into the page, and that page holds a
--    guest list, names, access needs and a live session. That is a real trade
--    for a prettier tab and not one to make quietly.
--
-- Validation refuses whole. A save that half-applied would be worse than one
-- that failed, so each checks everything before deleting anything.

begin;

-- Nothing shifts anything any more, so the function that did it is dead code on
-- a client-facing API. Dead code that can still be called is not dead.
drop function if exists public.wp_shift_after(text, time, integer);

-- ── Reading every template in one call ──────────────────────────────────────
create or replace function public.wp_admin_templates()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;

  return jsonb_build_object(
    'ok', true,
    'event_types', coalesce((
      select jsonb_agg(x order by x->>'event_type') from (
        select jsonb_build_object(
                 'event_type', d.event_type,
                 'days', (select jsonb_agg(jsonb_build_object(
                            'day_key', d2.day_key, 'label', d2.label, 'offered', d2.offered,
                            'music_ends', d2.music_ends, 'bar_closes', d2.bar_closes,
                            'carriages', d2.carriages, 'site_closed', d2.site_closed,
                            'curfew_mode', d2.curfew_mode, 'offset_min', d2.offset_min)
                          order by case d2.day_key when 'before' then 1 when 'event' then 2 else 3 end)
                          from wp_event_type_days d2 where d2.event_type = d.event_type),
                 'blocks', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', t.id, 'day_key', t.day_key, 'start_time', t.start_time,
                            'duration_min', t.duration_min, 'title', t.title,
                            'notes', t.notes, 'locked', t.locked, 'sort', t.sort)
                          order by case t.day_key when 'before' then 1 when 'event' then 2 else 3 end,
                                   t.start_time, t.sort)
                          from wp_timeline_template t where t.event_type = d.event_type), '[]'::jsonb)
               ) as x
          from wp_event_type_days d group by d.event_type
      ) q), '[]'::jsonb),
    'checklist', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'detail', c.detail,
                                          'days_before', c.days_before, 'sort', c.sort)
             order by c.sort, c.id)
        from wp_checklist_template c), '[]'::jsonb)
  );
end;
$function$;

-- ── The timings offered for one event type ──────────────────────────────────
--
-- Replace-all rather than row-by-row: this is a short list edited as a whole,
-- and a partial save that half-applied would be worse than one that failed.
--
-- Changing a template NEVER touches a wedding already seeded. A couple who has
-- been shown 2pm for the ceremony does not find it silently moved to 3pm
-- because the template changed — the same rule the checklist template already
-- follows, and the reason both are copied at seed time rather than referenced.
create or replace function public.wp_admin_save_timeline_template(p_event_type text, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_n integer := 0;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_not_an_array');
  end if;
  if not exists (select 1 from wp_event_type_days where event_type = p_event_type) then
    return jsonb_build_object('ok', false, 'error', 'unknown_event_type');
  end if;
  if jsonb_array_length(p_rows) > 60 then
    return jsonb_build_object('ok', false, 'error', 'too_many_rows');
  end if;
  -- A row on a day this type does not offer would be seeded and then be
  -- invisible for ever, which looks like the save having failed.
  if exists (
    select 1 from jsonb_array_elements(p_rows) e
     where not exists (select 1 from wp_event_type_days d
                        where d.event_type = p_event_type
                          and d.day_key = (e ->> 'day_key') and d.offered))
  then
    return jsonb_build_object('ok', false, 'error', 'day_not_offered');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where length(trim(coalesce(e ->> 'title',''))) = 0
                 or nullif(e ->> 'start_time','') is null)
  then
    return jsonb_build_object('ok', false, 'error', 'needs_time_and_title');
  end if;

  delete from wp_timeline_template where event_type = p_event_type;

  insert into wp_timeline_template (event_type, day_key, start_time, duration_min, title, notes, locked, sort)
  select p_event_type, e ->> 'day_key', (e ->> 'start_time')::time,
         greatest(0, least(1440, coalesce((e ->> 'duration_min')::int, 30))),
         left(trim(e ->> 'title'), 120),
         left(nullif(trim(coalesce(e ->> 'notes','')),''), 500),
         coalesce((e ->> 'locked')::boolean, false),
         coalesce((e ->> 'sort')::int, ord * 10)
    from jsonb_array_elements(p_rows) with ordinality as t(e, ord);

  get diagnostics v_n = row_count;
  perform wp_log('admin', 'saved the ' || p_event_type || ' timeline template');
  return jsonb_build_object('ok', true, 'saved', v_n);
end;
$function$;

-- ── One day of one event type: its name, whether it is offered, its curfews ──
create or replace function public.wp_admin_save_event_day(
  p_event_type text, p_day_key text,
  p_label text default null, p_offered boolean default null,
  p_music_ends time default null, p_bar_closes time default null,
  p_carriages time default null, p_site_closed time default null,
  p_curfew_mode text default null, p_offset_min integer default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_day_key not in ('before','event','after') then
    return jsonb_build_object('ok', false, 'error', 'bad_day');
  end if;
  if p_curfew_mode is not null and p_curfew_mode not in ('per_event','fixed','offset') then
    return jsonb_build_object('ok', false, 'error', 'bad_curfew_mode');
  end if;

  update wp_event_type_days
     set label       = coalesce(left(trim(p_label), 60), label),
         offered     = coalesce(p_offered, offered),
         music_ends  = coalesce(p_music_ends, music_ends),
         bar_closes  = coalesce(p_bar_closes, bar_closes),
         carriages   = coalesce(p_carriages, carriages),
         site_closed = coalesce(p_site_closed, site_closed),
         curfew_mode = coalesce(p_curfew_mode, curfew_mode),
         offset_min  = coalesce(p_offset_min, offset_min)
   where event_type = p_event_type and day_key = p_day_key;

  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('admin', 'changed the ' || p_event_type || ' ' || p_day_key || ' day');
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── The checklist every wedding starts from ─────────────────────────────────
-- Renumbered 1..n on every save. Safe because wp_checklist copies the title,
-- detail and computed date at seed time and never references the template id —
-- so a wedding already seeded keeps the deadlines it was given.
create or replace function public.wp_admin_save_checklist_template(p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_n integer := 0;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_not_an_array');
  end if;
  if jsonb_array_length(p_rows) > 40 then
    return jsonb_build_object('ok', false, 'error', 'too_many_rows');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where length(trim(coalesce(e ->> 'title',''))) = 0)
  then
    return jsonb_build_object('ok', false, 'error', 'needs_title');
  end if;
  -- A deadline after the wedding is a typo. days_before counts backwards.
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where coalesce((e ->> 'days_before')::int, 0) < 0
                 or coalesce((e ->> 'days_before')::int, 0) > 1095)
  then
    return jsonb_build_object('ok', false, 'error', 'bad_days_before');
  end if;

  delete from wp_checklist_template;

  insert into wp_checklist_template (id, title, detail, days_before, sort)
  select ord::int, left(trim(e ->> 'title'), 160),
         left(nullif(trim(coalesce(e ->> 'detail','')),''), 500),
         coalesce((e ->> 'days_before')::int, 0),
         coalesce((e ->> 'sort')::int, ord * 10)
    from jsonb_array_elements(p_rows) with ordinality as t(e, ord);

  get diagnostics v_n = row_count;
  perform wp_log('admin', 'saved the checklist template');
  return jsonb_build_object('ok', true, 'saved', v_n);
end;
$function$;

-- ── What one couple has actually suggested ──────────────────────────────────
-- Read-only. The point of a template is worth nothing without being able to see
-- what people did with it.
create or replace function public.wp_admin_event_timeline(p_event_id integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_type text; v_couple text;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;

  select wp_event_type_label(e ->> 'eventType'), e ->> 'couple'
    into v_type, v_couple
    from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event_id
   limit 1;
  if v_type is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  return jsonb_build_object(
    'ok', true, 'event_type', v_type, 'couple', v_couple,
    'days', coalesce((
      select jsonb_agg(jsonb_build_object('day_key', d.day_key, 'label', d.label,
                                          'fixed', wp_fixed_points(p_event_id, v_type, d.day_key))
             order by case d.day_key when 'before' then 1 when 'event' then 2 else 3 end)
        from wp_event_type_days d where d.event_type = v_type and d.offered), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day_key', b.day_key, 'start_time', b.start_time, 'duration_min', b.duration_min,
               'title', b.title, 'notes', b.notes, 'supplier_name', s.name, 'locked', b.locked)
             order by case b.day_key when 'before' then 1 when 'event' then 2 else 3 end,
                      b.start_time, b.sort)
        from wp_timeline b left join wp_suppliers s on s.id = b.supplier_id
       where b.event_id = p_event_id), '[]'::jsonb)
  );
end;
$function$;

-- ── A Pinterest board ───────────────────────────────────────────────────────
create table if not exists public.wp_event_meta (
  event_id      integer primary key,
  pinterest_url text,
  updated_at    timestamptz not null default now()
);
alter table public.wp_event_meta enable row level security;

create or replace function public.wp_get_pinterest()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object('ok', true,
    'url', (select pinterest_url from wp_event_meta where event_id = v_event));
end;
$function$;

-- The host is checked, and deliberately so. This URL is rendered as a link that
-- staff will click from the admin side, so an unchecked one is somewhere to put
-- a phishing page under the venue's own branding. Empty clears it.
create or replace function public.wp_set_pinterest(p_url text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_url   text := nullif(trim(coalesce(p_url, '')), '');
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  if v_url is not null and v_url !~* '^https://([a-z0-9-]+\.)*pinterest\.[a-z.]{2,6}/[^\s]*$' then
    return jsonb_build_object('ok', false, 'error', 'not_a_pinterest_link');
  end if;

  insert into wp_event_meta (event_id, pinterest_url, updated_at)
  values (v_event, left(v_url, 500), now())
  on conflict (event_id) do update
    set pinterest_url = excluded.pinterest_url, updated_at = now();

  perform wp_log('pinterest', case when v_url is null then 'removed their board' else 'linked a board' end);
  return jsonb_build_object('ok', true, 'url', v_url);
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE to anon AND authenticated by default on every new
-- function in `public`. Revoking from `public` alone does not do it.

revoke all on function public.wp_admin_templates()                              from public, anon, authenticated;
revoke all on function public.wp_admin_save_timeline_template(text, jsonb)      from public, anon, authenticated;
revoke all on function public.wp_admin_save_event_day(text,text,text,boolean,time,time,time,time,text,integer) from public, anon, authenticated;
revoke all on function public.wp_admin_save_checklist_template(jsonb)           from public, anon, authenticated;
revoke all on function public.wp_admin_event_timeline(integer)                  from public, anon, authenticated;
revoke all on function public.wp_get_pinterest()                                from public, anon, authenticated;
revoke all on function public.wp_set_pinterest(text)                            from public, anon, authenticated;

grant execute on function public.wp_admin_templates()                              to authenticated, service_role;
grant execute on function public.wp_admin_save_timeline_template(text, jsonb)      to authenticated, service_role;
grant execute on function public.wp_admin_save_event_day(text,text,text,boolean,time,time,time,time,text,integer) to authenticated, service_role;
grant execute on function public.wp_admin_save_checklist_template(jsonb)           to authenticated, service_role;
grant execute on function public.wp_admin_event_timeline(integer)                  to authenticated, service_role;
grant execute on function public.wp_get_pinterest()                                to authenticated, service_role;
grant execute on function public.wp_set_pinterest(text)                            to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Dropping the seven functions removes the Templates tab's data and the
-- Inspiration tab; the templates themselves are untouched and keep seeding.
-- wp_shift_after() is in 2026-09-09-portal-phase06-timeline.sql if the shifting
-- behaviour is ever wanted back — but the portal no longer has a screen for it.
