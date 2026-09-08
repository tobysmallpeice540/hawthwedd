-- supabase/2026-09-08-portal-phase02-checklist.sql
--
-- Wedding client portal — phase 02: the checklist.
--
-- APPLIED TO PRODUCTION 8 September 2026 as migration portal_phase02_checklist.
-- Depends on 2026-09-08-portal-phase00-schema.sql.
-- Assertions: portal-phase02-checklist-test.sql — 15, all passing.
--
-- Two kinds of item. VENUE items are locked: the couple ticks them but cannot
-- edit, re-date or delete them, because they are Hawthbush's deadlines and not
-- suggestions. CLIENT items are entirely theirs.
--
-- The payoff is on the admin side. wp_admin_checklist() gives a completion
-- figure per wedding, which turns a client toy into the chasing list — that is
-- most of why this tab is worth building.
--
-- SEEDING. Nothing is ever invited to an empty portal, so wp_get_checklist()
-- seeds the venue items on first read if none exist. Safe to repeat: venue items
-- cannot be deleted, so once seeded the count never returns to zero. Dates are
-- computed backwards from the wedding date.
--
-- >>> THE TEMPLATE BELOW IS A PLACEHOLDER. The wording and especially the
-- >>> offsets are a guess at Hawthbush's real deadlines, not Toby's. They want
-- >>> confirming before a real couple sees them. Changing them later only
-- >>> affects weddings seeded after the change — existing rows stay put, which
-- >>> is correct, since a deadline a couple has already been told should not
-- >>> silently move.

create table if not exists public.wp_checklist_template (
  id       integer primary key,
  title    text    not null,
  detail   text,
  days_before integer not null,     -- days before the wedding date
  sort     integer not null
);

alter table public.wp_checklist_template enable row level security;

insert into public.wp_checklist_template (id, title, detail, days_before, sort) values
  (1, 'Tell us roughly how many people',
      'Just numbers for now — seated for the meal, and anyone joining in the evening. You can change them whenever you like.', 365, 10),
  (2, 'Choose your suppliers',
      'Caterer, photographer, flowers, music. We have a list of people who know the barn well if that helps.', 180, 20),
  (3, 'Send us your timings',
      'Roughly how the day runs, so we know when to expect everyone.', 56, 30),
  (4, 'Tell us about confetti, candles and anything else',
      'There is a short form of things we need to know before the day.', 42, 40),
  (5, 'Confirm who is staying overnight',
      'So we can get the rooms right.', 42, 50),
  (6, 'Confirm your final numbers',
      'This is the figure we cater and charge on, so we do need it by this point.', 28, 60),
  (7, 'Final balance due', null, 28, 70),
  (8, 'Send us your table plan',
      'Who sits where. It does not have to be perfect — we can adjust on the day.', 14, 80),
  (9, 'Any access needs among your guests',
      'Step-free access, hearing loop, parking close to the door, high chairs.', 14, 90)
on conflict (id) do update
  set title = excluded.title, detail = excluded.detail,
      days_before = excluded.days_before, sort = excluded.sort;

-- ── Read, seeding on first use ──────────────────────────────────────────────

create or replace function public.wp_get_checklist()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_date  date;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  -- Seed the venue items once. Idempotent: venue items cannot be deleted, so a
  -- second call finds them and does nothing.
  if not exists (select 1 from wp_checklist where event_id = v_event and source = 'venue') then
    select nullif(e ->> 'date', '')::date into v_date
      from app_data d, lateral jsonb_array_elements(d.value) e
     where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = v_event
     limit 1;

    insert into wp_checklist (event_id, title, detail, due_on, source, locked, sort)
    select v_event, t.title, t.detail,
           case when v_date is null then null else v_date - t.days_before end,
           'venue', true, t.sort
      from wp_checklist_template t;
  end if;

  return jsonb_build_object(
    'ok', true,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'title', c.title, 'detail', c.detail,
               'due_on', c.due_on, 'done', c.done_at is not null,
               'done_at', c.done_at, 'source', c.source, 'locked', c.locked)
             order by c.done_at is not null, c.due_on nulls last, c.sort, c.created_at)
        from wp_checklist c where c.event_id = v_event), '[]'::jsonb),
    'progress', jsonb_build_object(
      'done',  (select count(*) from wp_checklist where event_id = v_event and done_at is not null),
      'total', (select count(*) from wp_checklist where event_id = v_event))
  );
end;
$function$;

-- ── Ticking, which is allowed on every item ─────────────────────────────────

create or replace function public.wp_set_task_done(p_id uuid, p_done boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_hit   integer;
  v_title text;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  update wp_checklist
     set done_at = case when p_done then now() else null end,
         done_by = case when p_done then auth.uid() else null end
   where id = p_id and event_id = v_event      -- <- the security of this function
  returning title into v_title;
  get diagnostics v_hit = row_count;

  if v_hit = 0 then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('checklist', (case when p_done then 'ticked: ' else 'un-ticked: ' end) || v_title);
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Their own items ─────────────────────────────────────────────────────────

create or replace function public.wp_add_task(p_title text, p_due_on date default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_title text := trim(coalesce(p_title, ''));
  v_id    uuid;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if length(v_title) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_title');
  end if;

  insert into wp_checklist (event_id, title, due_on, source, locked, sort)
  values (v_event, left(v_title, 200), p_due_on, 'client', false,
          coalesce((select max(sort) + 1 from wp_checklist where event_id = v_event), 100))
  returning id into v_id;

  perform wp_log('checklist', 'added their own task: ' || left(v_title, 80));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

-- Locked items refuse edits and deletion. A venue deadline is not the couple's
-- to move, and quietly letting them move it would be worse than saying no.
create or replace function public.wp_update_task(p_id uuid, p_title text default null, p_due_on date default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_locked boolean;
  v_hit integer;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select locked into v_locked from wp_checklist where id = p_id and event_id = v_event;
  if v_locked is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_locked then return jsonb_build_object('ok', false, 'error', 'locked'); end if;

  update wp_checklist
     set title  = coalesce(left(trim(p_title), 200), title),
         due_on = coalesce(p_due_on, due_on)
   where id = p_id and event_id = v_event;
  get diagnostics v_hit = row_count;

  if v_hit = 0 then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('checklist', 'edited their own task');
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.wp_delete_task(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_locked boolean;
  v_title  text;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select locked, title into v_locked, v_title from wp_checklist where id = p_id and event_id = v_event;
  if v_locked is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_locked then return jsonb_build_object('ok', false, 'error', 'locked'); end if;

  delete from wp_checklist where id = p_id and event_id = v_event and not locked;
  perform wp_log('checklist', 'removed their own task: ' || left(v_title, 80));
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Admin: the chasing view ─────────────────────────────────────────────────

create or replace function public.wp_admin_checklist(p_event_id integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;
  return jsonb_build_object(
    'ok', true,
    'done',    (select count(*) from wp_checklist where event_id = p_event_id and done_at is not null),
    'total',   (select count(*) from wp_checklist where event_id = p_event_id),
    -- what is actually late, which is the only part worth chasing
    'overdue', coalesce((
      select jsonb_agg(jsonb_build_object('title', title, 'due_on', due_on) order by due_on)
        from wp_checklist
       where event_id = p_event_id and done_at is null
         and due_on is not null and due_on < current_date), '[]'::jsonb));
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE to anon AND authenticated on every new function here.
-- Revoke both by name, then grant back.

revoke all on function public.wp_get_checklist()                      from public, anon, authenticated;
revoke all on function public.wp_set_task_done(uuid, boolean)         from public, anon, authenticated;
revoke all on function public.wp_add_task(text, date)                 from public, anon, authenticated;
revoke all on function public.wp_update_task(uuid, text, date)        from public, anon, authenticated;
revoke all on function public.wp_delete_task(uuid)                    from public, anon, authenticated;
revoke all on function public.wp_admin_checklist(integer)             from public, anon, authenticated;

grant execute on function public.wp_get_checklist()                   to authenticated, service_role;
grant execute on function public.wp_set_task_done(uuid, boolean)      to authenticated, service_role;
grant execute on function public.wp_add_task(text, date)              to authenticated, service_role;
grant execute on function public.wp_update_task(uuid, text, date)     to authenticated, service_role;
grant execute on function public.wp_delete_task(uuid)                 to authenticated, service_role;
grant execute on function public.wp_admin_checklist(integer)          to authenticated, service_role;

do $verify$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;
  select count(*) into n from wp_checklist_template;
  if n <> 9 then raise exception 'expected 9 template rows, found %', n; end if;
  raise notice 'phase 02 checklist in place';
end
$verify$;
