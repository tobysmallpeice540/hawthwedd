-- supabase/2026-10-25n-nudges-progress.sql
--
-- Two things for the venue side, both read-only over the portal's own tables.
--
-- 1. WEEKLY DEADLINE REMINDERS to couples (netlify/functions/portal-nudges.js,
--    Mondays, OFF until switched on in Settings → Email templates → Client
--    portal → "Deadline reminder").
--
--    wp_nudge_plan(p_today) — service only — lists, for every coming event
--    with an active portal login, what is overdue or due in the next three
--    weeks:
--      · checklist items not ticked (due in the last six weeks or the next
--        three — anything older is for staff to chase, not a weekly email).
--        An event whose couple has never opened the checklist has no rows
--        yet; its items are worked out from the template the same way
--        wp_get_checklist seeds them.
--      · payments still to come from the published statement
--        (wp_payment_schedule), same window. When an event has a schedule,
--        checklist items about a payment or balance are left out — the
--        schedule says the same thing with the amount.
--      · the drinks order closing, when Drinks is shown, the order is not
--        locked and not marked done, and it closes in the next three weeks.
--      · within eight weeks of the day, the pages not yet marked done.
--    Only what the couple can SEE counts: checklist, payments and drinks only
--    when those pages are shown for the event. Cancelled events and sombre
--    occasions (wake, funeral, memorial, celebration of life) are left out.
--
--    wp_nudges_sent records each (event, week) BEFORE the email goes, through
--    wp_nudge_mark, which returns false if that week is already taken — so a
--    run cut off part way, or run twice, never emails anyone twice in a week.
--    wp_nudge_unmark marks the week failed if the send did not go, which
--    frees it for the next run.
--
-- 2. THE "WHO'S BEHIND" BOARD (Events → Portal settings → Progress).
--    wp_admin_portal_progress() — admin only — one row per coming event:
--    logins and when last seen, pages shown and marked done, numbers, guests
--    and how many are at a table, timeline lines, drinks, checklist overdue
--    and due soon, the next payment, the last reminder sent, and when the
--    couple last changed anything.
--
-- New functions are revoked from public, anon and authenticated, then granted
-- back only where wanted (Supabase's default privileges grant both).

begin;

-- Which pages an event shows, given its type, so a caller handling many
-- events looks the type up once instead of once per section (the board read
-- 31 events in 5 seconds; most of it was this). wp_visible_sections keeps its
-- signature and grants and now delegates here, so there is still one rule.
create or replace function public.wp_visible_sections_typed(p_event integer, p_type text)
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
           (select sd.shown from wp_section_defaults sd where sd.event_type = p_type and sd.section = k.section),
           false);
$function$;

create or replace function public.wp_visible_sections(p_event integer)
returns jsonb language sql stable security definer set search_path to 'public', 'extensions' as $function$
  select wp_visible_sections_typed(p_event, wp_event_type_of(p_event));
$function$;

create table if not exists public.wp_nudges_sent (
  event_id integer not null,
  week_of date not null,
  sent_at timestamptz not null default now(),
  emails text[] not null default '{}',
  items integer not null default 0,
  failed boolean not null default false,
  primary key (event_id, week_of)
);
alter table public.wp_nudges_sent enable row level security;
revoke all on table public.wp_nudges_sent from public, anon, authenticated;

create or replace function public.wp_nudge_plan(p_today date)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  ev record;
  v_visible jsonb;
  v_items jsonb;
  v_has_sched boolean;
  v_lock_days integer;
  v_lock date;
  v_out jsonb := '[]'::jsonb;
  v_emails jsonb;
  v_ready text[];
begin
  select lock_days into v_lock_days from wp_drinks_settings limit 1;

  for ev in
    select (e ->> 'id')::int as id, nullif(e ->> 'date', '')::date as d, e ->> 'couple' as couple,
           e ->> 'client1Name' as c1, e ->> 'client2Name' as c2, e ->> 'eventType' as etype
      from app_data x, lateral jsonb_array_elements(x.value) e
     where x.key = 'hawthbush_bookings_v6'
       and (e ->> 'id') ~ '^\d+$'
       and coalesce(e ->> 'status', '') <> 'Cancelled'
       and nullif(e ->> 'date', '') is not null
       and (e ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
       and (e ->> 'date')::date >= p_today
       and coalesce(e ->> 'eventType', '') !~* '(wake|funeral|memorial|celebration of life)'
  loop
    select coalesce(jsonb_agg(distinct lower(a.email)), '[]'::jsonb) into v_emails
      from wp_access a where a.event_id = ev.id and a.revoked_at is null and a.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
    continue when jsonb_array_length(v_emails) = 0;

    v_visible := wp_visible_sections_typed(ev.id, wp_event_type_of(ev.id));
    v_items := '[]'::jsonb;
    v_has_sched := v_visible ? 'money' and exists (select 1 from wp_payment_schedule s where s.event_id = ev.id);

    -- payments still to come
    if v_visible ? 'money' then
      select v_items || coalesce(jsonb_agg(jsonb_build_object(
               'kind', 'payment', 'label', s.label, 'due', s.due_on, 'amount', s.amount,
               'overdue', s.due_on < p_today) order by s.due_on, s.seq), '[]'::jsonb)
        into v_items
        from wp_payment_schedule s
       where s.event_id = ev.id and s.due_on between p_today - 42 and p_today + 21 and coalesce(s.amount, 0) > 0;
    end if;

    -- checklist: the rows, or the template if it was never opened
    if v_visible ? 'checklist' then
      if exists (select 1 from wp_checklist c where c.event_id = ev.id and c.source = 'venue') then
        select v_items || coalesce(jsonb_agg(jsonb_build_object(
                 'kind', 'task', 'label', c.title, 'due', c.due_on, 'overdue', c.due_on < p_today)
                 order by c.due_on, c.sort), '[]'::jsonb)
          into v_items
          from wp_checklist c
         where c.event_id = ev.id and c.done_at is null and c.due_on between p_today - 42 and p_today + 21
           and not (v_has_sched and c.title ~* '(payment|balance)');
      else
        select v_items || coalesce(jsonb_agg(jsonb_build_object(
                 'kind', 'task', 'label', t.title, 'due', t.due, 'overdue', t.due < p_today)
                 order by t.due, t.sort), '[]'::jsonb)
          into v_items
          from (select tt.title, tt.sort,
                       case when tt.due_md is not null then wp_fixed_due(ev.d, tt.due_md) else ev.d - tt.days_before end as due
                  from wp_checklist_template tt) t
         where t.due between p_today - 42 and p_today + 21
           and not (v_has_sched and t.title ~* '(payment|balance)');
      end if;
    end if;

    select coalesce(array_agg(ss.section), '{}') into v_ready
      from wp_section_status ss where ss.event_id = ev.id and ss.state = 'ready';

    -- the drinks order closing
    if v_visible ? 'drinks' and v_lock_days is not null and not ('drinks' = any(v_ready)) then
      v_lock := ev.d - v_lock_days;
      if v_lock between p_today and p_today + 21 and not wp_drinks_locked(ev.id) then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'kind', 'drinks', 'label', 'Your drinks order closes', 'due', v_lock, 'overdue', false));
      end if;
    end if;

    -- in the last eight weeks: pages still to mark done
    if ev.d - p_today <= 56 then
      v_items := v_items || coalesce((
        select jsonb_agg(jsonb_build_object('kind', 'section', 'section', k.s, 'overdue', false) order by k.ord)
          from unnest(array['guests','food','drinks','bar','timeline','music','suppliers','layout','items','details'])
               with ordinality as k(s, ord)
         where v_visible ? k.s and not (k.s = any(v_ready))), '[]'::jsonb);
    end if;

    continue when jsonb_array_length(v_items) = 0;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'event_id', ev.id, 'event_date', ev.d, 'couple', ev.couple, 'client1', ev.c1, 'client2', ev.c2,
      'event_type', wp_event_type_label(ev.etype), 'emails', v_emails, 'items', v_items));
  end loop;
  return v_out;
end $function$;

create or replace function public.wp_nudge_mark(p_event integer, p_week date, p_emails text[], p_items integer)
returns boolean language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  insert into wp_nudges_sent (event_id, week_of, emails, items) values (p_event, p_week, coalesce(p_emails, '{}'), coalesce(p_items, 0))
  on conflict (event_id, week_of) do update
     set sent_at = now(), emails = excluded.emails, items = excluded.items, failed = false
   where wp_nudges_sent.failed;
  return found;
end $function$;

create or replace function public.wp_nudge_unmark(p_event integer, p_week date)
returns void language sql security definer set search_path to 'public', 'extensions' as $function$
  update wp_nudges_sent set failed = true where event_id = p_event and week_of = p_week;
$function$;

create or replace function public.wp_admin_portal_progress()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_today date := (now() at time zone 'Europe/London')::date;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  return jsonb_build_object('ok', true, 'today', v_today, 'events', coalesce((
    select jsonb_agg(row_obj order by (row_obj ->> 'date'), (row_obj ->> 'event_id')::int)
      from (
        select jsonb_build_object(
          'event_id', ev.id, 'date', ev.d, 'couple', ev.couple, 'status', ev.status,
          'event_type', wp_event_type_label(ev.etype),
          'logins', (select count(*) from wp_access a where a.event_id = ev.id and a.revoked_at is null),
          'last_seen', (select max(a.last_seen_at) from wp_access a where a.event_id = ev.id and a.revoked_at is null),
          'invited', (select max(coalesce(a.last_link_sent_at, a.invited_at)) from wp_access a where a.event_id = ev.id and a.revoked_at is null),
          'visible', wp_visible_sections_typed(ev.id, wp_event_type_of(ev.id)),
          'ready', coalesce((select jsonb_agg(ss.section) from wp_section_status ss where ss.event_id = ev.id and ss.state = 'ready'), '[]'::jsonb),
          'reopened', coalesce((select jsonb_agg(ss.section) from wp_section_status ss where ss.event_id = ev.id and ss.state = 'reopened'), '[]'::jsonb),
          'numbers', (select jsonb_build_object('adults', n.seated_adults, 'children', n.seated_children,
                                                'babies', n.seated_babies, 'evening', n.evening_extras, 'updated_at', n.updated_at)
                        from wp_guest_numbers n where n.event_id = ev.id),
          'guests_seated', (select count(*) from wp_guests g where g.event_id = ev.id and g.list = 'seated'),
          'guests_evening', (select count(*) from wp_guests g where g.event_id = ev.id and g.list = 'evening'),
          'guests_at_tables', (select count(*) from wp_guests g where g.event_id = ev.id and g.list = 'seated' and g.table_id is not null),
          'tables', (select count(*) from wp_layout_tables t where t.event_id = ev.id),
          'timeline_lines', (select count(*) from wp_timeline t where t.event_id = ev.id),
          'drinks_route', (select dr.route from wp_drinks dr where dr.event_id = ev.id),
          'drinks_locked', wp_drinks_locked(ev.id),
          'checklist_overdue', (select count(*) from wp_checklist c where c.event_id = ev.id and c.done_at is null and c.due_on < v_today),
          'checklist_soon', (select count(*) from wp_checklist c where c.event_id = ev.id and c.done_at is null and c.due_on between v_today and v_today + 21),
          'checklist_done', (select count(*) from wp_checklist c where c.event_id = ev.id and c.done_at is not null),
          'checklist_total', (select count(*) from wp_checklist c where c.event_id = ev.id),
          'next_payment', (select jsonb_build_object('label', s.label, 'due', s.due_on, 'amount', s.amount)
                             from wp_payment_schedule s where s.event_id = ev.id and coalesce(s.amount, 0) > 0
                            order by s.due_on, s.seq limit 1),
          'last_reminder', (select max(n.sent_at) from wp_nudges_sent n where n.event_id = ev.id and not n.failed),
          'last_change', (select max(l.at) from wp_change_log l where l.event_id = ev.id
                            and l.actor_email in (select a.email from wp_access a where a.event_id = ev.id))
        ) as row_obj
        from (select (e ->> 'id')::int as id, (e ->> 'date')::date as d, e ->> 'couple' as couple,
                     e ->> 'status' as status, e ->> 'eventType' as etype
                from app_data x, lateral jsonb_array_elements(x.value) e
               where x.key = 'hawthbush_bookings_v6'
                 and (e ->> 'id') ~ '^\d+$'
                 and coalesce(e ->> 'status', '') <> 'Cancelled'
                 and (e ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$'
                 and (e ->> 'date')::date >= v_today) ev
      ) q), '[]'::jsonb));
end $function$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.wp_visible_sections_typed(integer,text)',
    'public.wp_nudge_plan(date)', 'public.wp_nudge_mark(integer,date,text[],integer)',
    'public.wp_nudge_unmark(integer,date)', 'public.wp_admin_portal_progress()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  grant execute on function public.wp_visible_sections_typed(integer,text) to service_role;
  grant execute on function public.wp_nudge_plan(date) to service_role;
  grant execute on function public.wp_nudge_mark(integer,date,text[],integer) to service_role;
  grant execute on function public.wp_nudge_unmark(integer,date) to service_role;
  grant execute on function public.wp_admin_portal_progress() to authenticated, service_role;
end $grants$;

commit;
