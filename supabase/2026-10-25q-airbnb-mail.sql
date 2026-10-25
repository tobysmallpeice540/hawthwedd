-- supabase/2026-10-25q-airbnb-mail.sql
--
-- Airbnb emails into the lettings bookings (25 Oct 2026).
--
-- netlify/functions/airbnb-mail reads the Airbnb emails in Toby's Gmail (read
-- only, with his permission, through a Google sign-in he gives once) and keeps
-- what it finds here:
--
--   airbnb_mail_state     one row: the Gmail connection. The refresh token is
--                         stored ENCRYPTED with a key only the Netlify function
--                         holds; nobody but the service role can read the row.
--   airbnb_mail_seen      every Gmail message already read, so none is read twice.
--   airbnb_reservations   one row per Airbnb confirmation code: the guest's full
--                         name, guests, what the booking says we will earn, the
--                         message thread, and when it was cancelled or changed.
--   airbnb_payouts        one row per reservation line of a "We sent a payout"
--                         email: the money actually sent.
--   airbnb_reviews        the star rating from "X has left a 4-star review".
--   airbnb_messages       the guest's messages and ours, one row each.
--
-- Nothing here is reachable by anon or authenticated directly. The worker uses
-- the service role (airbnb_ingest, airbnb_purge_enquiries). Staff read through
-- two admin-only functions: airbnb_admin_status() and
-- airbnb_admin_conversation(code, thread).
--
-- Enquiries that never became a booking are not kept: airbnb_purge_enquiries
-- deletes a thread's messages once nothing has been said for 30 days and no
-- reservation carries that thread.
--
-- Safe to run twice.

begin;

create table if not exists public.airbnb_mail_state (
  id             integer primary key default 1 check (id = 1),
  account_email  text,
  token_enc      text,                 -- AES-256-GCM, key held by the function
  connected_at   timestamptz,
  connected_by   text,
  backfill_done  boolean not null default false,
  backfill_page  text,                 -- Gmail page token: how far back the first read has got
  last_ok_at     timestamptz,          -- the last run that read everything it was given
  last_sync_at   timestamptz,
  last_error     text,
  last_result    jsonb
);
alter table public.airbnb_mail_state add column if not exists backfill_page text;
alter table public.airbnb_mail_state add column if not exists last_ok_at timestamptz;
insert into public.airbnb_mail_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.airbnb_mail_seen (
  gmail_id  text primary key,
  kind      text,
  reason    text,
  seen_at   timestamptz not null default now()
);

create table if not exists public.airbnb_reservations (
  code                text primary key check (code ~ '^HM[A-Z0-9]{8}$'),
  thread_id           text,
  room_id             text,
  listing             text,
  guest_name          text,
  check_in            date,
  check_out           date,
  guests              text,
  guest_count         integer,
  info_at             timestamptz,      -- the email the details above came from
  payout_expected     numeric(10,2),
  payout_expected_at  timestamptz,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  altered_at          timestamptz,
  booking_id          text,
  updated_at          timestamptz not null default now()
);
create index if not exists airbnb_reservations_thread on public.airbnb_reservations (thread_id);
create index if not exists airbnb_reservations_out on public.airbnb_reservations (check_out);

create table if not exists public.airbnb_payouts (
  gmail_id  text not null,
  code      text not null,
  amount    numeric(10,2) not null,
  sent_on   date,
  primary key (gmail_id, code)
);

create table if not exists public.airbnb_reviews (
  gmail_id     text primary key,
  listing      text,
  check_in     date,
  check_out    date,
  stars        integer check (stars between 1 and 5),
  guest_first  text,
  at           timestamptz
);

create table if not exists public.airbnb_messages (
  gmail_id   text not null,
  idx        integer not null,
  thread_id  text,
  code       text,
  kind       text,          -- enquiry | request | reservation
  sent_at    timestamptz,
  direction  text check (direction in ('guest', 'host')),
  author     text,
  role       text,
  body       text,
  primary key (gmail_id, idx)
);
create index if not exists airbnb_messages_thread on public.airbnb_messages (thread_id);
create index if not exists airbnb_messages_code on public.airbnb_messages (code);

do $rls$
declare t text;
begin
  foreach t in array array['airbnb_mail_state','airbnb_mail_seen','airbnb_reservations','airbnb_payouts','airbnb_reviews','airbnb_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $rls$;

-- ── The worker writes through one function, in one transaction ─────────────
--
-- p: { seen: [{id, kind, reason}], reservations: [{code, thread_id, room_id,
--      listing, guest_name, check_in, check_out, guests, guest_count, payout,
--      confirmed, at}], cancellations: [{code, at}], alterations: [{code, at}],
--      payouts: [{gmail_id, code, amount, sent_on}], reviews: [{gmail_id,
--      listing, check_in, check_out, stars, guest_first, at}], messages:
--      [{gmail_id, idx, thread_id, code, kind, sent_at, direction, author,
--      role, body}], links: [{code, booking_id}] }
--
-- Emails are read newest first, so every field takes the value from the most
-- recent email that has one (info_at, payout_expected_at), whatever order they
-- arrive in. A message or payout line already stored is left alone.
create or replace function public.airbnb_ingest(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; n_res int := 0; n_msg int := 0; n_pay int := 0; n_rev int := 0; n_seen int := 0; k int;
  v_at timestamptz;
begin
  for r in select * from jsonb_array_elements(coalesce(p->'reservations', '[]')) loop
    if coalesce(r->>'code', '') !~ '^HM[A-Z0-9]{8}$' then continue; end if;
    v_at := coalesce(nullif(r->>'at', '')::timestamptz, now());
    insert into airbnb_reservations as a (code, thread_id, room_id, listing, guest_name, check_in, check_out,
                                          guests, guest_count, info_at, payout_expected, payout_expected_at, confirmed_at)
    values (r->>'code', nullif(r->>'thread_id', ''), nullif(r->>'room_id', ''), nullif(r->>'listing', ''),
            nullif(r->>'guest_name', ''), nullif(r->>'check_in', '')::date, nullif(r->>'check_out', '')::date,
            nullif(r->>'guests', ''), nullif(r->>'guest_count', '')::int, v_at,
            nullif(r->>'payout', '')::numeric, case when nullif(r->>'payout', '') is not null then v_at end,
            case when (r->>'confirmed')::boolean then v_at end)
    on conflict (code) do update set
      -- Details: the newer email wins where it has the field at all.
      thread_id   = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.thread_id, a.thread_id) else coalesce(a.thread_id, excluded.thread_id) end,
      room_id     = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.room_id, a.room_id) else coalesce(a.room_id, excluded.room_id) end,
      listing     = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.listing, a.listing) else coalesce(a.listing, excluded.listing) end,
      guest_name  = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.guest_name, a.guest_name) else coalesce(a.guest_name, excluded.guest_name) end,
      check_in    = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.check_in, a.check_in) else coalesce(a.check_in, excluded.check_in) end,
      check_out   = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.check_out, a.check_out) else coalesce(a.check_out, excluded.check_out) end,
      guests      = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.guests, a.guests) else coalesce(a.guests, excluded.guests) end,
      guest_count = case when excluded.info_at >= coalesce(a.info_at, '-infinity') then coalesce(excluded.guest_count, a.guest_count) else coalesce(a.guest_count, excluded.guest_count) end,
      info_at     = greatest(a.info_at, excluded.info_at),
      payout_expected    = case when excluded.payout_expected is not null and excluded.payout_expected_at >= coalesce(a.payout_expected_at, '-infinity')
                                then excluded.payout_expected else a.payout_expected end,
      payout_expected_at = case when excluded.payout_expected is not null and excluded.payout_expected_at >= coalesce(a.payout_expected_at, '-infinity')
                                then excluded.payout_expected_at else a.payout_expected_at end,
      confirmed_at = least(a.confirmed_at, excluded.confirmed_at),
      updated_at   = now();
    n_res := n_res + 1;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'cancellations', '[]')) loop
    if coalesce(r->>'code', '') !~ '^HM[A-Z0-9]{8}$' then continue; end if;
    v_at := coalesce(nullif(r->>'at', '')::timestamptz, now());
    insert into airbnb_reservations as a (code, cancelled_at, check_in, check_out)
    values (r->>'code', v_at, nullif(r->>'check_in', '')::date, nullif(r->>'check_out', '')::date)
    on conflict (code) do update set
      cancelled_at = least(a.cancelled_at, excluded.cancelled_at),
      check_in = coalesce(a.check_in, excluded.check_in), check_out = coalesce(a.check_out, excluded.check_out),
      updated_at = now();
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'alterations', '[]')) loop
    if coalesce(r->>'code', '') !~ '^HM[A-Z0-9]{8}$' then continue; end if;
    insert into airbnb_reservations as a (code, altered_at)
    values (r->>'code', coalesce(nullif(r->>'at', '')::timestamptz, now()))
    on conflict (code) do update set altered_at = greatest(a.altered_at, excluded.altered_at), updated_at = now();
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'payouts', '[]')) loop
    if coalesce(r->>'code', '') !~ '^HM[A-Z0-9]{8}$' or nullif(r->>'amount', '') is null then continue; end if;
    insert into airbnb_payouts (gmail_id, code, amount, sent_on)
    values (r->>'gmail_id', r->>'code', (r->>'amount')::numeric, nullif(r->>'sent_on', '')::date)
    on conflict do nothing;
    get diagnostics k = row_count; n_pay := n_pay + k;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'reviews', '[]')) loop
    insert into airbnb_reviews (gmail_id, listing, check_in, check_out, stars, guest_first, at)
    values (r->>'gmail_id', r->>'listing', nullif(r->>'check_in', '')::date, nullif(r->>'check_out', '')::date,
            (r->>'stars')::int, r->>'guest_first', nullif(r->>'at', '')::timestamptz)
    on conflict do nothing;
    get diagnostics k = row_count; n_rev := n_rev + k;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'messages', '[]')) loop
    if nullif(r->>'body', '') is null then continue; end if;
    insert into airbnb_messages (gmail_id, idx, thread_id, code, kind, sent_at, direction, author, role, body)
    values (r->>'gmail_id', (r->>'idx')::int, nullif(r->>'thread_id', ''), nullif(r->>'code', ''), r->>'kind',
            nullif(r->>'sent_at', '')::timestamptz, r->>'direction', left(r->>'author', 120), left(r->>'role', 40),
            left(r->>'body', 20000))
    on conflict do nothing;
    get diagnostics k = row_count; n_msg := n_msg + k;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'links', '[]')) loop
    update airbnb_reservations set booking_id = r->>'booking_id'
     where code = r->>'code' and booking_id is distinct from r->>'booking_id';
  end loop;

  -- Seen last: a message is marked read only in the same transaction that
  -- stored what it said.
  for r in select * from jsonb_array_elements(coalesce(p->'seen', '[]')) loop
    insert into airbnb_mail_seen (gmail_id, kind, reason) values (r->>'id', r->>'kind', left(r->>'reason', 200))
    on conflict (gmail_id) do nothing;
    get diagnostics k = row_count; n_seen := n_seen + k;
  end loop;

  return jsonb_build_object('ok', true, 'reservations', n_res, 'messages', n_msg, 'payouts', n_pay,
                            'reviews', n_rev, 'seen', n_seen);
end $$;

-- ── Enquiries that never became a booking are not kept ─────────────────────
create or replace function public.airbnb_purge_enquiries(p_days integer default 30)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with dead_threads as (
    select m.thread_id from airbnb_messages m
     where m.thread_id is not null
       and not exists (select 1 from airbnb_reservations r where r.thread_id = m.thread_id)
     group by m.thread_id
    having max(m.sent_at) < now() - make_interval(days => greatest(p_days, 1))
  ), dead_codes as (
    select m.code from airbnb_messages m
     where m.thread_id is null and m.code is not null
       and not exists (select 1 from airbnb_reservations r where r.code = m.code and r.confirmed_at is not null)
     group by m.code
    having max(m.sent_at) < now() - make_interval(days => greatest(p_days, 1))
  )
  delete from airbnb_messages m
   where m.thread_id in (select thread_id from dead_threads)
      or (m.thread_id is null and m.code in (select code from dead_codes));
  get diagnostics n = row_count;
  return n;
end $$;

-- ── What staff read ─────────────────────────────────────────────────────────
create or replace function public.airbnb_admin_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s airbnb_mail_state;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into s from airbnb_mail_state where id = 1;
  return jsonb_build_object('ok', true,
    'connected', s.token_enc is not null,
    'account', s.account_email, 'connected_at', s.connected_at, 'connected_by', s.connected_by,
    'backfill_done', coalesce(s.backfill_done, false), 'last_sync_at', s.last_sync_at,
    'last_error', s.last_error, 'last_result', s.last_result,
    'reservations', (select count(*) from airbnb_reservations),
    'messages', (select count(*) from airbnb_messages),
    'read', (select count(*) from airbnb_mail_seen));
end $$;

-- One booking's conversation: the messages on its thread (and any sent with
-- the request to book, which carry only the code), oldest first.
create or replace function public.airbnb_admin_conversation(p_code text, p_thread text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_res airbnb_reservations; v_thread text;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into v_res from airbnb_reservations where code = p_code;
  v_thread := coalesce(v_res.thread_id, nullif(p_thread, ''));
  return jsonb_build_object('ok', true,
    'reservation', case when v_res.code is null then null else jsonb_build_object(
      'code', v_res.code, 'thread_id', v_res.thread_id, 'guest_name', v_res.guest_name, 'listing', v_res.listing,
      'check_in', v_res.check_in, 'check_out', v_res.check_out, 'guests', v_res.guests,
      'payout_expected', v_res.payout_expected, 'confirmed_at', v_res.confirmed_at,
      'cancelled_at', v_res.cancelled_at, 'altered_at', v_res.altered_at) end,
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'sent_on', sent_on) order by sent_on)
                           from airbnb_payouts where code = p_code), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
                             'at', m.sent_at, 'direction', m.direction, 'author', m.author, 'role', m.role,
                             'kind', m.kind, 'body', m.body) order by m.sent_at, m.gmail_id, m.idx)
                            from airbnb_messages m
                           where (v_thread is not null and m.thread_id = v_thread)
                              or (p_code is not null and m.code = p_code)), '[]'::jsonb));
end $$;

-- Supabase grants EXECUTE on every new function to anon and authenticated.
revoke all on function public.airbnb_ingest(jsonb) from public, anon, authenticated;
revoke all on function public.airbnb_purge_enquiries(integer) from public, anon, authenticated;
revoke all on function public.airbnb_admin_status() from public, anon, authenticated;
revoke all on function public.airbnb_admin_conversation(text, text) from public, anon, authenticated;
grant execute on function public.airbnb_ingest(jsonb) to service_role;
grant execute on function public.airbnb_purge_enquiries(integer) to service_role;
grant execute on function public.airbnb_admin_status() to authenticated, service_role;
grant execute on function public.airbnb_admin_conversation(text, text) to authenticated, service_role;

do $check$
begin
  if has_function_privilege('authenticated', 'public.airbnb_ingest(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.airbnb_ingest(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.airbnb_admin_status()', 'execute')
     or has_function_privilege('anon', 'public.airbnb_admin_conversation(text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.airbnb_purge_enquiries(integer)', 'execute') then
    raise exception 'an airbnb function is open to the wrong role';
  end if;
  if has_table_privilege('authenticated', 'public.airbnb_mail_state', 'select')
     or has_table_privilege('anon', 'public.airbnb_messages', 'select')
     or has_table_privilege('authenticated', 'public.airbnb_messages', 'select') then
    raise exception 'an airbnb table is readable by a client';
  end if;
end $check$;

commit;
