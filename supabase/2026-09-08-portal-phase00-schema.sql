-- supabase/2026-09-08-portal-phase00-schema.sql
--
-- Wedding client portal — phase 00: tables and the access layer.
--
-- APPLIED TO PRODUCTION 8 September 2026 as two migrations:
--   portal_phase00_schema_and_access
--   portal_phase00_close_internal_helpers   (the revoke at the foot of this file)
--
-- Depends on 2026-09-08-portal-phase00-prereq.sql, which must be applied first —
-- without it a client account either cannot be created at all or arrives as bar
-- staff, and app_data is readable by any signed-in user.
--
-- SHAPE
--
-- Follows the box office: RLS on with NO policies, so nothing is reachable
-- except through SECURITY DEFINER functions, which are the only authorisation
-- surface. Portal data lives in these tables and NEVER in the app_data events
-- array — a client writing into that array at an unpredictable moment is how
-- this project has lost records four times.
--
-- THE RULE THAT MATTERS MOST
--
--   No client-facing function takes an event id. The event is resolved from the
--   signed-in user by wp_my_event_id(). If a client could name the event, they
--   could name somebody else's wedding.
--
-- Events are rows of app_data->'hawthbush_bookings_v6', keyed by a numeric "id"
-- (45 bookings, 45 distinct ids, none null — checked 8 September 2026).

-- ── Tables ──────────────────────────────────────────────────────────────────

-- Who may sign in, and to which wedding. Many rows per event: both partners,
-- and a planner if wanted.
create table if not exists public.wp_access (
  id            uuid primary key default gen_random_uuid(),
  event_id      integer     not null,
  email         text        not null,
  user_id       uuid        references auth.users(id) on delete set null,
  invited_at    timestamptz not null default now(),
  invited_by    uuid        references auth.users(id) on delete set null,
  first_seen_at timestamptz,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  constraint wp_access_email_lower check (email = lower(email))
);
create unique index if not exists wp_access_event_email on public.wp_access (event_id, email);
create index        if not exists wp_access_email       on public.wp_access (email) where revoked_at is null;
create index        if not exists wp_access_user        on public.wp_access (user_id) where revoked_at is null;

-- The client's declared numbers. Deliberately separate from the names: a couple
-- knows the counts eighteen months before they know who is coming.
-- NULL means "not told us yet", which is not the same as zero.
--
-- evening_extras is EXTRAS — people arriving in the evening only. The diary's
-- own eveGuests field is used as a TOTAL. Convert on the way in when applying
-- to the event, or the two will disagree about how many people are on site.
create table if not exists public.wp_guest_numbers (
  event_id        integer primary key,
  seated_adults   integer check (seated_adults   >= 0),
  seated_children integer check (seated_children >= 0),
  seated_babies   integer check (seated_babies   >= 0),
  evening_extras  integer check (evening_extras  >= 0),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null,
  applied_at      timestamptz,
  applied_by      uuid references auth.users(id) on delete set null
);

-- Two lists, not one. Only 'seated' feeds the layout tab; 'evening' never gets
-- a seat but counts towards capacity and the bar.
create table if not exists public.wp_guests (
  id           uuid primary key default gen_random_uuid(),
  event_id     integer not null,
  list         text    not null check (list in ('seated', 'evening')),
  first_name   text    not null default '',
  last_name    text    not null default '',
  side         text,
  age_band     text    not null default 'adult' check (age_band in ('adult', 'child', 'baby')),
  staying      boolean not null default false,
  access_needs text,
  plus_one_of  uuid    references public.wp_guests(id) on delete set null,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint wp_guests_has_a_name check (length(trim(first_name || ' ' || last_name)) > 0)
);
create index if not exists wp_guests_event_list on public.wp_guests (event_id, list, sort);

-- Venue items are locked: the client ticks them but cannot delete or re-date
-- them. Their own items are free.
create table if not exists public.wp_checklist (
  id         uuid primary key default gen_random_uuid(),
  event_id   integer not null,
  title      text    not null,
  detail     text,
  due_on     date,
  done_at    timestamptz,
  done_by    uuid references auth.users(id) on delete set null,
  source     text    not null default 'client' check (source in ('venue', 'client')),
  locked     boolean not null default false,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists wp_checklist_event on public.wp_checklist (event_id, sort);

-- "Things the venue must know" — registrar timings, confetti, naked flames,
-- parking, high chairs, cake stand, first dance, curfew acknowledged. jsonb
-- because the question set will change and each change should not be a
-- migration.
create table if not exists public.wp_venue_form (
  event_id   integer primary key,
  answers    jsonb   not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Feeds the 07:00 digest. Every portal write appends one line; nothing here is
-- ever shown to a client.
create table if not exists public.wp_change_log (
  id          bigserial primary key,
  event_id    integer not null,
  at          timestamptz not null default now(),
  actor_email text,
  actor_user  uuid,
  area        text not null,
  summary     text not null
);
create index if not exists wp_change_log_recent on public.wp_change_log (at desc);
create index if not exists wp_change_log_event  on public.wp_change_log (event_id, at desc);

-- RLS on, no policies: unreachable except through the functions below.
alter table public.wp_access        enable row level security;
alter table public.wp_guest_numbers enable row level security;
alter table public.wp_guests        enable row level security;
alter table public.wp_checklist     enable row level security;
alter table public.wp_venue_form    enable row level security;
alter table public.wp_change_log    enable row level security;

-- ── Access resolution ───────────────────────────────────────────────────────

-- The event for the signed-in caller. Takes no argument, on purpose.
create or replace function public.wp_my_event_id()
 returns integer
 language sql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
  select a.event_id
    from wp_access a
   where a.revoked_at is null
     and (a.user_id = auth.uid()
          or a.email = lower(coalesce(auth.jwt() ->> 'email', '~none~')))
   order by a.user_id nulls last
   limit 1;
$function$;

-- Called on sign-in: links the auth user to the invitation and stamps the visit.
create or replace function public.wp_touch_access()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_event integer;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  update wp_access
     set user_id       = auth.uid(),
         first_seen_at = coalesce(first_seen_at, now()),
         last_seen_at  = now()
   where revoked_at is null
     and (user_id = auth.uid() or email = v_email)
  returning event_id into v_event;

  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  return jsonb_build_object('ok', true, 'event_id', v_event);
end;
$function$;

-- Internal: append to the change log.
create or replace function public.wp_log(p_area text, p_summary text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
begin
  if v_event is null then return; end if;
  insert into wp_change_log (event_id, actor_email, actor_user, area, summary)
  values (v_event, lower(coalesce(auth.jwt() ->> 'email', '')), auth.uid(), p_area, left(p_summary, 500));
end;
$function$;

-- ── What the client sees of their own booking ───────────────────────────────

-- An ALLOWLIST, field by field. A new column on the booking record is not
-- exposed by accident. Money, staff, notes, corkage, commission, the Xero
-- contact and every other couple stay out.
create or replace function public.wp_my_event()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  ev      jsonb;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select e into ev
    from app_data d,
         lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6'
     and (e ->> 'id')::int = v_event
   limit 1;

  if ev is null then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'event_id',   v_event,
    'couple',     coalesce(ev ->> 'couple', ''),
    'date',       ev ->> 'date',
    'end_date',   ev ->> 'endDate',
    'event_type', coalesce(ev ->> 'eventType', 'Wedding'),
    'status',     coalesce(ev ->> 'status', ''),
    'ceremony',          ev ->> 'ceremony',
    'guest_arrival',     ev ->> 'guestArrivalTime',
    -- which accommodation they hold, so the rooms tab offers only those.
    -- The fees are deliberately not here.
    'accommodation', jsonb_build_object(
      'amly',    coalesce(ev ->> 'amlyBooked',    'undecided'),
      'hamlet',  coalesce(ev ->> 'hamletBooked',  'undecided'),
      'camping', coalesce(ev ->> 'campingBooked', 'undecided')
    ),
    -- what the diary currently holds, so the numbers panel can pre-fill
    'venue_numbers', jsonb_build_object(
      'meal_guests',   ev ->> 'mealGuests',
      'meal_children', ev ->> 'mealChildren',
      'meal_babies',   ev ->> 'mealBabies',
      'evening_total', ev ->> 'eveGuests'
    )
  );
end;
$function$;

-- ── Admin: who has a login ──────────────────────────────────────────────────

create or replace function public.wp_grant_access(p_event_id integer, p_email text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id    uuid;
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'bad_email');
  end if;
  if not exists (
    select 1 from app_data d, lateral jsonb_array_elements(d.value) e
     where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  insert into wp_access (event_id, email, invited_by)
  values (p_event_id, v_email, auth.uid())
  on conflict (event_id, email)
    do update set revoked_at = null, invited_at = now(), invited_by = auth.uid()
  returning id into v_id;

  insert into wp_change_log (event_id, actor_email, actor_user, area, summary)
  values (p_event_id, lower(coalesce(auth.jwt() ->> 'email', '')), auth.uid(),
          'access', 'granted portal access to ' || v_email);

  return jsonb_build_object('ok', true, 'id', v_id, 'email', v_email);
end;
$function$;

create or replace function public.wp_revoke_access(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer;
  v_email text;
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;

  update wp_access set revoked_at = now()
   where id = p_id and revoked_at is null
  returning event_id, email into v_event, v_email;

  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'not_found_or_already_revoked');
  end if;

  insert into wp_change_log (event_id, actor_email, actor_user, area, summary)
  values (v_event, lower(coalesce(auth.jwt() ->> 'email', '')), auth.uid(),
          'access', 'revoked portal access for ' || v_email);

  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.wp_list_access(p_event_id integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;
  return jsonb_build_object('ok', true, 'access', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'email', a.email,
             'invited_at', a.invited_at, 'first_seen_at', a.first_seen_at,
             'last_seen_at', a.last_seen_at, 'revoked_at', a.revoked_at,
             'linked', a.user_id is not null)
           order by a.invited_at)
      from wp_access a where a.event_id = p_event_id), '[]'::jsonb));
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────
--
-- IMPORTANT, and learned the hard way in this very migration: Supabase applies
-- ALTER DEFAULT PRIVILEGES granting EXECUTE on every new function in `public`
-- to anon, authenticated AND service_role. The default is OPEN, not closed.
-- Revoking from PUBLIC and anon is not enough — `authenticated` holds its own
-- explicit grant and must be revoked by name.
--
-- Every new function in this schema: revoke from public, anon AND
-- authenticated, then grant back only where wanted.

revoke all on function public.wp_my_event_id()                     from public, anon;
revoke all on function public.wp_touch_access()                    from public, anon;
revoke all on function public.wp_log(text, text)                   from public, anon;
revoke all on function public.wp_my_event()                        from public, anon;
revoke all on function public.wp_grant_access(integer, text)       from public, anon;
revoke all on function public.wp_revoke_access(uuid)               from public, anon;
revoke all on function public.wp_list_access(integer)              from public, anon;

grant execute on function public.wp_touch_access()                 to authenticated, service_role;
grant execute on function public.wp_my_event()                     to authenticated, service_role;
grant execute on function public.wp_grant_access(integer, text)    to authenticated, service_role;
grant execute on function public.wp_revoke_access(uuid)            to authenticated, service_role;
grant execute on function public.wp_list_access(integer)           to authenticated, service_role;

grant execute on function public.wp_my_event_id()                  to service_role;
grant execute on function public.wp_log(text, text)                to service_role;

-- Applied as migration portal_phase00_close_internal_helpers: the two internal
-- helpers keep no authenticated grant. wp_my_event_id() is harmless either way
-- (no arguments, returns only the caller's own event); wp_log() is not — a
-- client could otherwise append arbitrary lines to their own change log, which
-- is poisoning of the 07:00 digest.
revoke execute on function public.wp_my_event_id()   from authenticated;
revoke execute on function public.wp_log(text, text) from authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────

do $verify$
declare n int;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name like 'wp\_%';
  if n <> 6 then raise exception 'expected 6 wp_ tables, found %', n; end if;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname like 'wp\_%' and c.relkind = 'r' and not c.relrowsecurity;
  if n > 0 then raise exception '% wp_ table(s) without RLS enabled', n; end if;

  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname like 'wp\_%';
  if n > 0 then raise exception 'wp_ tables must have NO policies, found %', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'wp\_%';
  if n <> 7 then raise exception 'expected 7 wp_ functions, found %', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'wp\_%' and not p.prosecdef;
  if n > 0 then raise exception '% wp_ function(s) are not SECURITY DEFINER', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'wp\_%'
     and has_function_privilege('authenticated', p.oid, 'execute');
  if n <> 5 then raise exception 'expected 5 wp_ functions callable by authenticated, found %', n; end if;

  raise notice 'portal phase 00 schema in place';
end
$verify$;
