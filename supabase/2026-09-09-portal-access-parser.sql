-- supabase/2026-09-09-portal-access-parser.sql
--
-- Parsing the contract's access wording — as a PROPOSAL, never as an answer.
--
-- APPLIED TO PRODUCTION 9 September 2026 as migration portal_access_time_parser.
-- Assertions: portal-access-parser-test.sql — 25, all passing.
--
-- Toby is right that these are far more consistent than the corkage note: they
-- are three near-identical phrases written by the venue, not prose typed by a
-- client. So they can be read. What must not happen is the reading being
-- trusted on its own, which is why this follows the contract-review pattern
-- already used for signed documents: propose, show the human what was proposed
-- beside the original words, and let them confirm.
--
-- The rules that matter:
--   · The parse is computed on read and NEVER STORED. Nothing to go stale, and
--     it re-reads correctly if the contract wording is later changed.
--   · wp_fixed_points() uses only CONFIRMED times from wp_event_access. A
--     proposal never reaches a couple — assertion 17 checks the word
--     "proposed" does not appear anywhere in what the portal returns them.
--   · It refuses rather than guesses. A bare "10 to 6" has no am/pm and is
--     rejected with a reason, not silently read as 10:00-18:00.
--
--   midday / noon = 12:00,  midnight = 00:00,  12am = 00:00,  12pm = 12:00.

-- One side of the range. Returns null when it cannot be sure.
create or replace function public.wp_parse_clock(p_text text)
 returns time
 language plpgsql
 immutable
as $function$
declare
  t text := lower(trim(coalesce(p_text, '')));
  m text[];
  h integer; mins integer; ampm text;
begin
  if t = '' then return null; end if;

  -- Words first, because "12 midnight" must not be read as 12:00.
  if t ~ 'midnight'        then return '00:00'::time; end if;
  if t ~ '(midday|noon)'   then return '12:00'::time; end if;

  -- 10am · 10.30am · 10:30am · 4.30 pm
  m := regexp_match(t, '^(\d{1,2})\s*(?:[.:]\s*(\d{2}))?\s*(am|pm)$');
  if m is null then return null; end if;

  h    := m[1]::int;
  mins := coalesce(m[2]::int, 0);
  ampm := m[3];

  if h < 1 or h > 12 or mins > 59 then return null; end if;

  if ampm = 'am' then
    if h = 12 then h := 0; end if;          -- 12am is midnight
  else
    if h <> 12 then h := h + 12; end if;    -- 12pm is midday
  end if;

  return make_time(h, mins, 0);
end;
$function$;

-- The whole phrase. Returns what it found and, when it fails, why.
create or replace function public.wp_parse_access_range(p_text text)
 returns jsonb
 language plpgsql
 immutable
as $function$
declare
  t text := lower(trim(coalesce(p_text, '')));
  parts text[];
  a time; b time;
begin
  if t = '' then
    return jsonb_build_object('ok', false, 'reason', 'nothing to read');
  end if;

  -- normalise the dashes people actually type
  t := replace(replace(replace(t, '–', '-'), '—', '-'), ' to ', ' - ');
  t := regexp_replace(t, '\s+(until|till)\s+', ' - ', 'g');

  parts := regexp_split_to_array(t, '\s*-\s*');
  if array_length(parts, 1) <> 2 then
    return jsonb_build_object('ok', false, 'reason', 'could not see two times in that', 'text', p_text);
  end if;

  a := wp_parse_clock(parts[1]);
  b := wp_parse_clock(parts[2]);

  if a is null or b is null then
    return jsonb_build_object(
      'ok', false,
      'reason', case when a is null and b is null then 'neither time is clear'
                     when a is null then 'the start time is not clear'
                     else 'the end time is not clear' end,
      'text', p_text);
  end if;

  return jsonb_build_object('ok', true, 'from', a, 'to', b, 'text', p_text);
end;
$function$;

-- ── The admin view, now carrying a proposal per day ─────────────────────────

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
               'contract_text', ct.txt,
               -- read from the contract wording, for a human to check.
               -- NOT used by wp_fixed_points and never shown to a couple.
               'proposed', wp_parse_access_range(ct.txt),
               'access_from', a.access_from, 'access_to', a.access_to,
               'confirmed', a.access_to is not null,
               'music_ends', a.music_ends, 'bar_closes', a.bar_closes,
               'carriages', a.carriages, 'site_closed', a.site_closed,
               'resolved', wp_fixed_points(p_event_id, v_type, d.day_key))
             order by case d.day_key when 'before' then 1 when 'event' then 2 else 3 end)
        from wp_event_type_days d
        left join wp_event_access a on a.event_id = p_event_id and a.day_key = d.day_key
        cross join lateral (select case d.day_key
                 when 'before' then coalesce(ev->'contract'->'values'->>'Access Day Before', ev->'contract'->'fields'->>'accessBefore')
                 when 'event'  then coalesce(ev->'contract'->'values'->>'Access Event Day',  ev->'contract'->'fields'->>'accessDay')
                 else               coalesce(ev->'contract'->'values'->>'Access Day After',  ev->'contract'->'fields'->>'accessAfter') end as txt) ct
       where d.event_type = v_type and d.offered), '[]'::jsonb));
end;
$function$;

-- Every event with a contract, and what we would propose for each. The list an
-- admin works down once, rather than opening bookings one at a time.
create or replace function public.wp_admin_access_queue()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'events', coalesce((
    select jsonb_agg(jsonb_build_object(
             'event_id', (e->>'id')::int,
             'couple', e->>'couple',
             'date', e->>'date',
             'event_type', wp_event_type_label(e->>'eventType'),
             'contract_text', e->'contract'->'values'->>'Access Event Day',
             'proposed', wp_parse_access_range(e->'contract'->'values'->>'Access Event Day'),
             'confirmed', exists (
               select 1 from wp_event_access a
                where a.event_id = (e->>'id')::int and a.day_key = 'event' and a.access_to is not null))
           order by e->>'date')
      from app_data d, lateral jsonb_array_elements(d.value) e
     where d.key = 'hawthbush_bookings_v6'
       and nullif(e->'contract'->'values'->>'Access Event Day', '') is not null), '[]'::jsonb));
end;
$function$;

revoke all on function public.wp_parse_clock(text)         from public, anon, authenticated;
revoke all on function public.wp_parse_access_range(text)  from public, anon, authenticated;
revoke all on function public.wp_admin_access(integer)     from public, anon, authenticated;
revoke all on function public.wp_admin_access_queue()      from public, anon, authenticated;

grant execute on function public.wp_parse_clock(text)        to service_role;
grant execute on function public.wp_parse_access_range(text) to service_role;
grant execute on function public.wp_admin_access(integer)    to authenticated, service_role;
grant execute on function public.wp_admin_access_queue()     to authenticated, service_role;

do $verify$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;
  raise notice 'access parser in place';
end
$verify$;
