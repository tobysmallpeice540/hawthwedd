-- supabase/2026-10-23g-day-details-statement.sql
--
-- Ceremony details, key contacts for the day, a drop-off and collection slot,
-- and a statement of account on the client portal.
--
--   1. Venue form questions (data, editable later in Settings → Portal →
--      Venue form): who is conducting the ceremony and how to reach them,
--      where it is and where it moves if it rains; when things are dropped
--      off and collected. The ceremony TIME already exists (wp_event_profile,
--      which drives the timeline) and is not duplicated here.
--   2. wp_key_contacts — the people to phone on the day (name, role, phone,
--      note), kept by the couple; read by staff in wp_admin_day_details().
--   3. wp_payment_schedule — the payments still to come, as the staff app
--      computes them (invoice stages not yet raised, and any damage deposit).
--      Published by the staff app whenever it is open, in the same spirit as
--      wp_invoices; read by the couple in wp_my_statement(). The figures are
--      PROVISIONAL and the portal says so: final invoices move with numbers
--      and additions.
--
-- House rules: RLS on with no policies, table privileges revoked from anon and
-- authenticated; SECURITY DEFINER functions; EXECUTE revoked by name and
-- granted back only to authenticated. No client function takes an event id.
-- Client payloads are built field by field.
--
-- Front end first: the portal pages that use these functions treat a missing
-- function as "not there yet" and carry on, so the order does not matter, but
-- the new venue-form questions show up the moment this runs.

begin;

-- ── 1. Venue form questions ────────────────────────────────────────────────
-- Sort numbers slot them in after "When do the registrars arrive?" (30) and,
-- for the drop-off section, before "Anything else" (140). Options are a guess
-- at the venue's own names and are meant to be edited.
insert into public.wp_venue_form_questions (qkey, section, label, help, kind, options, sort) values
  ('officiant_name',       'Your ceremony', 'Who is conducting it?',
     'The registrar, celebrant or minister — a name if you have one.', 'text', null, 32),
  ('officiant_contact',    'Your ceremony', 'How do we reach them?',
     'A phone number or email, in case we need them on the day.', 'text', null, 34),
  ('ceremony_location',    'Your ceremony', 'Where would you like the ceremony?',
     null, 'choice', '["The Clearing", "The Grain Store", "Not sure yet"]'::jsonb, 36),
  ('wet_weather_location', 'Your ceremony', 'And if it rains?',
     'Where the ceremony moves to if the weather turns.', 'choice', '["The Grain Store", "Not sure yet"]'::jsonb, 38),
  ('dropoff_date',  'Dropping off and collecting', 'When will you drop things off?',
     'Signs, favours, decorations — anything on your "What you are bringing" list.', 'date', null, 132),
  ('dropoff_time',  'Dropping off and collecting', 'Roughly what time?', null, 'time', null, 134),
  ('collect_date',  'Dropping off and collecting', 'When will you collect them?',
     'Everything on the list goes home with the person named against it.', 'date', null, 136),
  ('collect_time',  'Dropping off and collecting', 'Roughly what time?', null, 'time', null, 138)
on conflict (qkey) do nothing;

-- ── 2. Key contacts ────────────────────────────────────────────────────────
create table if not exists public.wp_key_contacts (
  id          uuid primary key default gen_random_uuid(),
  event_id    integer not null,
  name        text not null check (length(trim(name)) > 0),
  role        text,
  phone       text,
  note        text,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists wp_key_contacts_event on public.wp_key_contacts (event_id, sort, created_at);
alter table public.wp_key_contacts enable row level security;
revoke all on table public.wp_key_contacts from anon, authenticated;

create or replace function public.wp_get_key_contacts()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object('ok', true, 'contacts', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'phone', c.phone, 'note', c.note)
                     order by c.sort, c.created_at)
      from wp_key_contacts c where c.event_id = v_event), '[]'::jsonb));
end $function$;

-- Add (p_id null) or change one of your own. An id from another event is
-- simply not found: the update is scoped to the caller's event.
create or replace function public.wp_save_key_contact(p_id uuid, p_name text, p_role text, p_phone text, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id(); v_id uuid; v_name text := left(trim(coalesce(p_name, '')), 80);
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if length(v_name) = 0 then return jsonb_build_object('ok', false, 'error', 'no_name'); end if;
  if p_id is null then
    if (select count(*) from wp_key_contacts where event_id = v_event) >= 20 then
      return jsonb_build_object('ok', false, 'error', 'too_many');
    end if;
    insert into wp_key_contacts (event_id, name, role, phone, note, sort)
    values (v_event, v_name,
            left(nullif(trim(coalesce(p_role, '')), ''), 80),
            left(nullif(trim(coalesce(p_phone, '')), ''), 40),
            left(nullif(trim(coalesce(p_note, '')), ''), 300),
            coalesce((select max(sort) + 1 from wp_key_contacts where event_id = v_event), 0))
    returning id into v_id;
    perform wp_log('contacts', 'added ' || v_name);
  else
    update wp_key_contacts
       set name = v_name,
           role = left(nullif(trim(coalesce(p_role, '')), ''), 80),
           phone = left(nullif(trim(coalesce(p_phone, '')), ''), 40),
           note = left(nullif(trim(coalesce(p_note, '')), ''), 300),
           updated_at = now()
     where id = p_id and event_id = v_event
    returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    perform wp_log('contacts', 'changed ' || v_name);
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

create or replace function public.wp_delete_key_contact(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id(); v_name text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  delete from wp_key_contacts where id = p_id and event_id = v_event returning name into v_name;
  if v_name is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('contacts', 'removed ' || v_name);
  return jsonb_build_object('ok', true);
end $function$;

-- Staff: everything about the day the couple has told us outside the timeline
-- — the venue form (questions with answers) and the key contacts. Any member
-- of staff: the bar and cleaning logins work the day too. Nothing here is a
-- guest's personal note (those stay admin-only in wp_admin_guests).
create or replace function public.wp_admin_day_details(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_answers jsonb;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select coalesce(answers, '{}'::jsonb) into v_answers from wp_venue_form where event_id = p_event_id;
  return jsonb_build_object(
    'ok', true,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object('qkey', q.qkey, 'section', q.section, 'label', q.label, 'kind', q.kind)
                       order by q.sort)
        from wp_venue_form_questions q), '[]'::jsonb),
    'answers', coalesce(v_answers, '{}'::jsonb),
    'answered_at', (select updated_at from wp_venue_form where event_id = p_event_id),
    'ceremony_time', (select ceremony_time from wp_event_profile where event_id = p_event_id),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'phone', c.phone, 'note', c.note)
                       order by c.sort, c.created_at)
        from wp_key_contacts c where c.event_id = p_event_id), '[]'::jsonb));
end $function$;

-- ── 3. Payment schedule (statement of account) ─────────────────────────────
create table if not exists public.wp_payment_schedule (
  event_id      integer not null,
  seq           integer not null,
  label         text not null,
  due_on        date,
  amount        numeric(12,2) not null,
  refundable    boolean not null default false,
  lines         jsonb not null default '[]'::jsonb,
  published_at  timestamptz not null default now(),
  primary key (event_id, seq)
);
alter table public.wp_payment_schedule enable row level security;
revoke all on table public.wp_payment_schedule from anon, authenticated;

-- Staff app: replace the schedule of each event named. p_events is
--   [{ "event_id": 123, "rows": [{ label, due_on, amount, refundable,
--                                   lines: [{ desc, amount }] }] }]
-- An event sent with no rows has its schedule cleared (everything invoiced).
-- An event that is not in the diary is skipped and reported. The app sends
-- cancelled events with no rows, so their old figures are cleared.
create or replace function public.wp_admin_publish_schedule(p_events jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  e jsonb; r jsonb; v_event integer; v_seq integer; v_done integer := 0; v_rows integer := 0;
  v_skipped jsonb := '[]'::jsonb; v_known integer[]; v_amount numeric; v_lines jsonb;
begin
  -- Admin only: these are the figures a couple is shown, and the bar and
  -- cleaning logins are staff but have no business rewriting them.
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if jsonb_typeof(p_events) <> 'array' then return jsonb_build_object('ok', false, 'error', 'not_an_array'); end if;
  if jsonb_array_length(p_events) > 500 then return jsonb_build_object('ok', false, 'error', 'too_many_events'); end if;

  select coalesce(array_agg((x ->> 'id')::int), '{}') into v_known
    from app_data a, lateral jsonb_array_elements(a.value) x
   where a.key = 'hawthbush_bookings_v6' and (x ->> 'id') ~ '^\d+$';

  for e in select * from jsonb_array_elements(p_events) loop
    -- Checked one at a time: Postgres does not promise to evaluate an OR left
    -- to right, and jsonb_array_length raises on anything but an array.
    if coalesce(e ->> 'event_id', '') !~ '^\d+$' or coalesce(jsonb_typeof(e -> 'rows'), '') <> 'array' then
      v_skipped := v_skipped || to_jsonb(coalesce(e ->> 'event_id', '?')); continue;
    end if;
    if jsonb_array_length(e -> 'rows') > 12 then
      v_skipped := v_skipped || to_jsonb(e ->> 'event_id'); continue;
    end if;
    v_event := (e ->> 'event_id')::int;
    if not (v_event = any (v_known)) then
      v_skipped := v_skipped || to_jsonb(v_event); continue;
    end if;
    delete from wp_payment_schedule where event_id = v_event;
    v_seq := 0;
    for r in select * from jsonb_array_elements(e -> 'rows') loop
      begin
        v_amount := round((r ->> 'amount')::numeric, 2);
      exception when others then v_amount := null;
      end;
      if v_amount is null or v_amount <= 0 or v_amount > 1000000 or length(trim(coalesce(r ->> 'label', ''))) = 0 then continue; end if;
      -- Lines rebuilt field by field; anything else in them is dropped.
      select coalesce(jsonb_agg(jsonb_build_object('desc', left(coalesce(l ->> 'desc', ''), 200),
                                                   'amount', round((l ->> 'amount')::numeric, 2))), '[]'::jsonb)
        into v_lines
        from (select l from jsonb_array_elements(case when jsonb_typeof(r -> 'lines') = 'array' then r -> 'lines' else '[]'::jsonb end) l
               limit 30) s
       where (l ->> 'amount') ~ '^-?\d+(\.\d+)?$';
      v_seq := v_seq + 1;
      insert into wp_payment_schedule (event_id, seq, label, due_on, amount, refundable, lines, published_at)
      values (v_event, v_seq, left(trim(r ->> 'label'), 80),
              case when (r ->> 'due_on') ~ '^\d{4}-\d{2}-\d{2}$' then (r ->> 'due_on')::date end,
              v_amount, coalesce(r ->> 'refundable', '') = 'true', v_lines, now());
      v_rows := v_rows + 1;
    end loop;
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('ok', true, 'events', v_done, 'rows', v_rows, 'skipped', v_skipped);
end $function$;

-- Couple: the payments still to come on their own event.
create or replace function public.wp_my_statement()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object(
    'ok', true,
    'schedule', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', s.label, 'due_on', s.due_on, 'amount', s.amount, 'refundable', s.refundable,
               'lines', coalesce((select jsonb_agg(jsonb_build_object('desc', l ->> 'desc', 'amount', (l ->> 'amount')::numeric))
                                    from jsonb_array_elements(s.lines) l), '[]'::jsonb))
             order by s.due_on nulls first, s.seq)
        from wp_payment_schedule s where s.event_id = v_event), '[]'::jsonb),
    'published_at', (select max(published_at) from wp_payment_schedule where event_id = v_event));
end $function$;

-- ── Grants ─────────────────────────────────────────────────────────────────
revoke all on function public.wp_get_key_contacts()                                from public, anon, authenticated;
revoke all on function public.wp_save_key_contact(uuid, text, text, text, text)    from public, anon, authenticated;
revoke all on function public.wp_delete_key_contact(uuid)                          from public, anon, authenticated;
revoke all on function public.wp_admin_day_details(integer)                        from public, anon, authenticated;
revoke all on function public.wp_admin_publish_schedule(jsonb)                     from public, anon, authenticated;
revoke all on function public.wp_my_statement()                                    from public, anon, authenticated;
grant execute on function public.wp_get_key_contacts()                             to authenticated;
grant execute on function public.wp_save_key_contact(uuid, text, text, text, text) to authenticated;
grant execute on function public.wp_delete_key_contact(uuid)                       to authenticated;
grant execute on function public.wp_admin_day_details(integer)                     to authenticated;
grant execute on function public.wp_admin_publish_schedule(jsonb)                  to authenticated;
grant execute on function public.wp_my_statement()                                 to authenticated;

commit;
