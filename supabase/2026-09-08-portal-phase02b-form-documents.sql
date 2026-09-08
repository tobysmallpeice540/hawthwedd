-- supabase/2026-09-08-portal-phase02b-form-documents.sql
--
-- Wedding client portal — phase 02b: the venue-must-know form, and documents.
--
-- APPLIED TO PRODUCTION 8 September 2026 as migration
-- portal_phase02_venue_form_and_documents.
-- Assertions: portal-phase02b-form-documents-test.sql — 13, all passing.
--
-- THE FORM. Questions live in a table rather than in the front end, so the set
-- can change without a deploy. Answers are a jsonb blob keyed by question key,
-- and wp_save_venue_form accepts ONLY keys that exist in the question table —
-- an allowlist, so a client cannot stuff arbitrary json into the record.
--
-- THE DOCUMENTS. Files live in the private `booking-files` bucket, so nothing
-- can be linked directly; netlify/functions/portal-file.js mints a short-lived
-- signed URL and asks wp_may_read_file() first. Only two docTypes are ever
-- offered to a client: the Event Booking Form and the Accommodation Booking
-- Form. Timesheets are staff hours, and untyped files are whatever happened to
-- be dragged in — neither is the couple's to read. An allowlist again, for the
-- same reason.

-- ── Question set ────────────────────────────────────────────────────────────

create table if not exists public.wp_venue_form_questions (
  qkey    text primary key,
  section text not null,
  label   text not null,
  help    text,
  kind    text not null check (kind in ('text','longtext','yesno','choice','number','time')),
  options jsonb,
  sort    integer not null
);
alter table public.wp_venue_form_questions enable row level security;

insert into public.wp_venue_form_questions (qkey, section, label, help, kind, options, sort) values
 ('ceremony_type',    'Your ceremony', 'What kind of ceremony?', null, 'choice',
   '["Registrar","Celebrant","Blessing","No ceremony here"]'::jsonb, 10),
 ('ceremony_time',    'Your ceremony', 'What time does it start?', null, 'time', null, 20),
 ('registrar_arrival','Your ceremony', 'When do the registrars arrive?',
   'They usually want to see you both about an hour beforehand.', 'time', null, 30),

 ('confetti',        'On the day', 'Are you having confetti?',
   'Let us know and we will tell you where it can go.', 'yesno', null, 40),
 ('naked_flames',    'On the day', 'Candles or any other naked flames?',
   'Including in centrepieces and lanterns.', 'yesno', null, 50),
 ('sparklers',       'On the day', 'Sparklers or fireworks?', null, 'yesno', null, 60),
 ('first_dance',     'On the day', 'First dance song', 'Artist and title, if you know it yet.', 'text', null, 70),
 ('cake_cutting',    'On the day', 'Roughly when are you cutting the cake?', null, 'time', null, 80),
 ('cake_stand',      'On the day', 'Do you need a cake stand and knife from us?', null, 'yesno', null, 90),

 ('high_chairs',     'Your guests', 'How many high chairs do you need?', null, 'number', null, 100),
 ('coaches',         'Your guests', 'Any coaches or minibuses?',
   'So we can keep the turning space clear.', 'yesno', null, 110),
 ('taxi_time',       'Your guests', 'What time are taxis booked for?', null, 'time', null, 120),
 ('parking_notes',   'Your guests', 'Anything else about arrival or parking', null, 'longtext', null, 130),

 ('anything_else',   'Anything else', 'Anything at all we should know',
   'However small. We would rather hear it now than on the morning.', 'longtext', null, 140)
on conflict (qkey) do update
  set section = excluded.section, label = excluded.label, help = excluded.help,
      kind = excluded.kind, options = excluded.options, sort = excluded.sort;

create or replace function public.wp_get_venue_form()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_answers jsonb;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select coalesce(answers, '{}'::jsonb) into v_answers from wp_venue_form where event_id = v_event;
  v_answers := coalesce(v_answers, '{}'::jsonb);

  return jsonb_build_object(
    'ok', true,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qkey', q.qkey, 'section', q.section, 'label', q.label,
               'help', q.help, 'kind', q.kind, 'options', q.options)
             order by q.sort)
        from wp_venue_form_questions q), '[]'::jsonb),
    'answers', v_answers,
    'progress', jsonb_build_object(
      'answered', (select count(*) from wp_venue_form_questions q
                    where v_answers ? q.qkey
                      and nullif(trim(v_answers ->> q.qkey), '') is not null),
      'total',    (select count(*) from wp_venue_form_questions))
  );
end;
$function$;

-- Merges rather than replaces, so a half-filled form saves without wiping the
-- rest. Unknown keys are dropped, not rejected: a stale browser sending an
-- old question should still save the answers that are still real.
create or replace function public.wp_save_venue_form(p_answers jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_clean jsonb;
  v_dropped integer;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if jsonb_typeof(p_answers) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'not_an_object');
  end if;

  -- ALLOWLIST: only keys that exist as questions survive, and each value is
  -- capped so a text field cannot become a payload.
  select coalesce(jsonb_object_agg(k, left(p_answers ->> k, 2000)), '{}'::jsonb)
    into v_clean
    from jsonb_object_keys(p_answers) k
   where exists (select 1 from wp_venue_form_questions q where q.qkey = k);

  v_dropped := (select count(*) from jsonb_object_keys(p_answers) k
                 where not exists (select 1 from wp_venue_form_questions q where q.qkey = k));

  insert into wp_venue_form as f (event_id, answers, updated_by)
  values (v_event, v_clean, auth.uid())
  on conflict (event_id) do update
    set answers = f.answers || v_clean,
        updated_at = now(),
        updated_by = auth.uid();

  perform wp_log('venue form', 'answered ' || (select count(*) from jsonb_object_keys(v_clean)) || ' question(s)');
  return jsonb_build_object('ok', true, 'saved', (select count(*) from jsonb_object_keys(v_clean)), 'ignored', v_dropped);
end;
$function$;

-- ── Documents ───────────────────────────────────────────────────────────────

create or replace function public.wp_my_documents()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  ev jsonb;
  v_test boolean;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select e into ev from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = v_event limit 1;
  if ev is null then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  -- A test-mode contract is not a real one. Showing "out for signature" for a
  -- test send would be worse than showing nothing.
  v_test := coalesce((ev -> 'contract' ->> 'testMode')::boolean, false);

  return jsonb_build_object(
    'ok', true,
    'contract', case
      when ev -> 'contract' is null or v_test then null
      else jsonb_build_object(
        'status',  ev -> 'contract' ->> 'status',
        'sent_at', ev -> 'contract' ->> 'sentAt')
      end,
    -- ALLOWLIST by docType. Timesheets are staff hours; untyped files are
    -- whatever was dragged in. Neither belongs to the couple.
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', f ->> 'name',
               'doc_type', f ->> 'docType',
               'uploaded_at', f ->> 'uploadedAt',
               'path', f ->> 'path')
             order by f ->> 'uploadedAt')
        from jsonb_array_elements(coalesce(ev -> 'files', '[]'::jsonb)) f
       where f ->> 'docType' in ('Event Booking Form', 'Accommodation Booking Form')
         and nullif(f ->> 'path', '') is not null), '[]'::jsonb)
  );
end;
$function$;

-- Asked by the Netlify signer before it mints a URL. Same allowlist, enforced
-- again here rather than trusted from the caller.
create or replace function public.wp_may_read_file(p_path text)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
begin
  if v_event is null or nullif(trim(coalesce(p_path, '')), '') is null then
    return false;
  end if;
  return exists (
    select 1
      from app_data d,
           lateral jsonb_array_elements(d.value) e,
           lateral jsonb_array_elements(coalesce(e -> 'files', '[]'::jsonb)) f
     where d.key = 'hawthbush_bookings_v6'
       and (e ->> 'id')::int = v_event
       and f ->> 'path' = p_path
       and f ->> 'docType' in ('Event Booking Form', 'Accommodation Booking Form'));
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

revoke all on function public.wp_get_venue_form()          from public, anon, authenticated;
revoke all on function public.wp_save_venue_form(jsonb)    from public, anon, authenticated;
revoke all on function public.wp_my_documents()            from public, anon, authenticated;
revoke all on function public.wp_may_read_file(text)       from public, anon, authenticated;

grant execute on function public.wp_get_venue_form()       to authenticated, service_role;
grant execute on function public.wp_save_venue_form(jsonb) to authenticated, service_role;
grant execute on function public.wp_my_documents()         to authenticated, service_role;
grant execute on function public.wp_may_read_file(text)    to authenticated, service_role;

do $verify$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;
  select count(*) into n from wp_venue_form_questions;
  if n <> 14 then raise exception 'expected 14 questions, found %', n; end if;
  raise notice 'phase 02b in place';
end
$verify$;
