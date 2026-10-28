-- supabase/2026-10-28s-email-archive.sql
--
-- The email archive (28 Oct 2026): every email to and from the people on our
-- events, enquiries and lettings, kept here so nobody has to "Connect Gmail"
-- to see them.
--
-- netlify/functions/email-archive reads the farm Gmail (hawthbushfarm@gmail.com,
-- the Airbnb-mail connection's sealed token, read only) twice an hour and keeps:
--
--   email_archive_state      one row: how far the reading has got.
--   email_messages           one row per email: who, when, which way, the
--                            subject, the text with the quoted history cut
--                            off, and a LIST of its real attachments (never
--                            the files themselves — those are saved to a
--                            record's Files only when somebody presses Save).
--                            The emails the app sends itself (hbf_email_log_v1,
--                            which only keeps the last 500) are copied in too,
--                            as direction 'app'.
--   email_archive_addresses  every record address already read back to
--                            1 Jan 2025 — a new address is read back on its own.
--   email_archive_seen       recent Gmail messages looked at and found to be
--                            nobody's, so they are not looked at again.
--
-- Guests' emails are personal: nothing here is readable by a client. The worker
-- writes with the service role (email_ingest, email_purge); staff read through
-- two ADMIN-ONLY functions (wp_is_admin — bar and cleaner logins are staff but
-- never see these): email_admin_messages(addresses, ref) and email_admin_status().
--
-- Kept: emails of anybody on an event or a letting, or an enquiry that booked.
-- Emails of enquiries that never booked are deleted two years after they were
-- sent (email_purge, run daily by the worker with the list of addresses to keep).
--
-- Safe to run twice.

begin;

create table if not exists public.email_archive_state (
  id             integer primary key default 1 check (id = 1),
  last_ok_at     timestamptz,          -- the last run that looked at everything recent
  last_sync_at   timestamptz,
  last_error     text,
  last_result    jsonb,
  app_log_upto   text,                 -- sentAt of the newest app-sent email copied in
  last_purge_at  timestamptz
);
insert into public.email_archive_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.email_messages (
  gmail_id     text primary key,       -- Gmail's message id, or 'app:<log id>'
  thread_id    text,
  rfc_id       text,                   -- the Message-ID header
  sent_at      timestamptz not null,
  direction    text not null check (direction in ('in', 'out', 'app')),
  from_addr    text,
  from_name    text,
  to_addrs     text[] not null default '{}',
  cc_addrs     text[] not null default '{}',
  addrs        text[] not null default '{}',   -- everyone on it but us, lower case
  subject      text,
  body         text,
  body_html    text,                   -- only for direction 'app' (our own templates)
  attachments  jsonb not null default '[]'::jsonb,  -- [{part, name, mime, size}]
  kind         text,                   -- direction 'app': the template that sent it
  ref          text,                   -- direction 'app': the booking id it was logged against
  stored_at    timestamptz not null default now()
);
create index if not exists email_messages_addrs on public.email_messages using gin (addrs);
create index if not exists email_messages_sent on public.email_messages (sent_at);
create index if not exists email_messages_ref on public.email_messages (ref) where ref is not null;
create index if not exists email_messages_rfc on public.email_messages (rfc_id) where rfc_id is not null;

create table if not exists public.email_archive_addresses (
  addr           text primary key,
  backfilled_at  timestamptz not null default now(),
  found          integer not null default 0
);

create table if not exists public.email_archive_seen (
  gmail_id  text primary key,
  seen_at   timestamptz not null default now()
);

do $rls$
declare t text;
begin
  foreach t in array array['email_archive_state','email_messages','email_archive_addresses','email_archive_seen'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $rls$;

-- ── The worker writes through one function, in one transaction ─────────────
--
-- p: { messages: [{gmail_id, thread_id, rfc_id, sent_at, direction, from_addr,
--      from_name, to_addrs[], cc_addrs[], addrs[], subject, body, body_html,
--      attachments[], kind, ref}], seen: [gmail_id], addresses_done:
--      [{addr, found}] }
--
-- A message already stored is left alone. So is a second copy of one (the same
-- Message-ID, the same direction) under another Gmail id.
create or replace function public.email_ingest(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; n_msg int := 0; n_seen int := 0; n_addr int := 0; k int;
  v_dir text;
begin
  for r in select * from jsonb_array_elements(coalesce(p->'messages', '[]')) loop
    v_dir := r->>'direction';
    if coalesce(r->>'gmail_id', '') = '' or v_dir not in ('in', 'out', 'app')
       or nullif(r->>'sent_at', '') is null then continue; end if;
    if nullif(r->>'rfc_id', '') is not null and exists (
         select 1 from email_messages m where m.rfc_id = r->>'rfc_id' and m.direction = v_dir and m.gmail_id <> r->>'gmail_id') then
      continue;
    end if;
    insert into email_messages (gmail_id, thread_id, rfc_id, sent_at, direction, from_addr, from_name,
                                to_addrs, cc_addrs, addrs, subject, body, body_html, attachments, kind, ref)
    values (r->>'gmail_id', nullif(r->>'thread_id', ''), left(nullif(r->>'rfc_id', ''), 300),
            (r->>'sent_at')::timestamptz, v_dir,
            left(lower(nullif(r->>'from_addr', '')), 200), left(nullif(r->>'from_name', ''), 200),
            coalesce((select array_agg(left(lower(x), 200)) from jsonb_array_elements_text(r->'to_addrs') x), '{}'),
            coalesce((select array_agg(left(lower(x), 200)) from jsonb_array_elements_text(r->'cc_addrs') x), '{}'),
            coalesce((select array_agg(distinct left(lower(x), 200)) from jsonb_array_elements_text(r->'addrs') x), '{}'),
            left(r->>'subject', 500), left(r->>'body', 20000),
            case when v_dir = 'app' then left(r->>'body_html', 200000) end,
            case when jsonb_typeof(r->'attachments') = 'array' then r->'attachments' else '[]'::jsonb end,
            left(nullif(r->>'kind', ''), 80), left(nullif(r->>'ref', ''), 120))
    on conflict (gmail_id) do nothing;
    get diagnostics k = row_count; n_msg := n_msg + k;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'seen', '[]')) loop
    insert into email_archive_seen (gmail_id) values (r #>> '{}') on conflict do nothing;
    get diagnostics k = row_count; n_seen := n_seen + k;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'addresses_done', '[]')) loop
    if coalesce(r->>'addr', '') = '' then continue; end if;
    insert into email_archive_addresses (addr, found) values (lower(r->>'addr'), coalesce((r->>'found')::int, 0))
    on conflict (addr) do update set backfilled_at = now(), found = excluded.found;
    n_addr := n_addr + 1;
  end loop;

  return jsonb_build_object('ok', true, 'messages', n_msg, 'seen', n_seen, 'addresses', n_addr);
end $$;

-- ── Two years, then gone — except for the people who booked ─────────────────
-- p_keep: every address on an event or a letting, or an enquiry that booked.
-- A message is kept if anybody on it is one of those. Also forgets "seen" ids
-- older than 60 days (the recent look-back is never more than 60).
create or replace function public.email_purge(p_keep text[], p_before timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_keep is null or cardinality(p_keep) = 0 then
    raise exception 'email_purge needs the list of addresses to keep';
  end if;
  if p_before > now() - interval '700 days' then
    raise exception 'email_purge keeps at least two years';
  end if;
  delete from email_messages m
   where m.sent_at < p_before
     and not (m.addrs && (select array_agg(lower(x)) from unnest(p_keep) x))
     and (m.ref is null or not (m.ref = any (p_keep)));
  get diagnostics n = row_count;
  delete from email_archive_seen where seen_at < now() - interval '60 days';
  update email_archive_state set last_purge_at = now() where id = 1;
  return n;
end $$;

-- ── What staff read (admins only) ──────────────────────────────────────────
-- One record's emails: anything to or from its addresses, and anything the
-- app logged against its booking id. Newest first, at most 400.
create or replace function public.email_admin_messages(p_addresses text[], p_ref text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_addrs text[];
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  v_addrs := coalesce((select array_agg(distinct lower(trim(x))) from unnest(coalesce(p_addresses, '{}')) x
                        where trim(x) like '%@%'), '{}');
  if cardinality(v_addrs) = 0 and nullif(p_ref, '') is null then
    return jsonb_build_object('ok', true, 'messages', '[]'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'messages', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', m.gmail_id, 'thread', m.thread_id, 'at', m.sent_at, 'dir', m.direction,
             'from', m.from_addr, 'from_name', m.from_name, 'to', to_jsonb(m.to_addrs), 'cc', to_jsonb(m.cc_addrs),
             'subject', m.subject, 'body', m.body, 'html', m.body_html, 'atts', m.attachments,
             'kind', m.kind, 'ref', m.ref) order by m.sent_at desc)
      from (select * from email_messages m
             where m.addrs && v_addrs or (nullif(p_ref, '') is not null and m.ref = p_ref)
             order by m.sent_at desc limit 400) m), '[]'::jsonb));
end $$;

create or replace function public.email_admin_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s email_archive_state; g airbnb_mail_state;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into s from email_archive_state where id = 1;
  select * into g from airbnb_mail_state where id = 1;
  return jsonb_build_object('ok', true,
    'connected', g.token_enc is not null, 'account', g.account_email,
    'last_sync_at', s.last_sync_at, 'last_ok_at', s.last_ok_at, 'last_error', s.last_error,
    'last_result', s.last_result, 'last_purge_at', s.last_purge_at,
    'messages', (select count(*) from email_messages where direction <> 'app'),
    'app_messages', (select count(*) from email_messages where direction = 'app'),
    'addresses_done', (select count(*) from email_archive_addresses),
    'oldest', (select min(sent_at) from email_messages where direction <> 'app'));
end $$;

-- Supabase grants EXECUTE on every new function to anon and authenticated.
revoke all on function public.email_ingest(jsonb) from public, anon, authenticated;
revoke all on function public.email_purge(text[], timestamptz) from public, anon, authenticated;
revoke all on function public.email_admin_messages(text[], text) from public, anon, authenticated;
revoke all on function public.email_admin_status() from public, anon, authenticated;
grant execute on function public.email_ingest(jsonb) to service_role;
grant execute on function public.email_purge(text[], timestamptz) to service_role;
grant execute on function public.email_admin_messages(text[], text) to authenticated, service_role;
grant execute on function public.email_admin_status() to authenticated, service_role;

do $check$
begin
  if has_function_privilege('authenticated', 'public.email_ingest(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.email_ingest(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.email_purge(text[],timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.email_purge(text[],timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.email_admin_messages(text[],text)', 'execute')
     or has_function_privilege('anon', 'public.email_admin_status()', 'execute') then
    raise exception 'an email archive function is open to the wrong role';
  end if;
  if has_table_privilege('authenticated', 'public.email_messages', 'select')
     or has_table_privilege('anon', 'public.email_messages', 'select')
     or has_table_privilege('authenticated', 'public.email_archive_state', 'select') then
    raise exception 'an email archive table is readable by a client';
  end if;
end $check$;

commit;
