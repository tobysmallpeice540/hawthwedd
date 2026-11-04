-- 2026-11-04a  Contracts signed in the app (replacing SignWell for new contracts).
--
-- The booking form is written from a template in the staff app, FROZEN at the
-- moment it is sent (ct_contracts.body, with its SHA-256), and signed by the
-- couple in the portal: typed full name + a tick, after an emailed sign-in has
-- proved the address is theirs. Hawthbush signs at sending, in the name of the
-- admin who sends it (body.venue). When the last client signs, the contract is
-- sealed: a final SHA-256 over body + answers + signatures, and the signing
-- function makes the PDF (netlify/functions/contract-sign.js).
--
-- House rules applied:
--   · RLS on, NO policies, nothing granted on the tables — functions only.
--   · Every function: revoke from public, anon, authenticated; grant back only
--     where wanted. Staff functions are admin only (wp_is_admin()).
--   · The couple's functions never take an id: the event is the signed-in
--     user's (wp_my_event_id()), and the payload is an allowlist.
--   · Signing is service-only (ct_sign_service), called by contract-sign.js
--     after it has verified the user with Supabase and read the IP address,
--     which a database function cannot see.
--   · A sent contract is never edited. Any change is Void and reissue: a new
--     version, everyone signs again, the old one kept with its reason.

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.ct_contracts (
  id               uuid primary key default gen_random_uuid(),
  event_id         integer not null,
  version          integer not null,
  status           text not null default 'out' check (status in ('out', 'signed', 'void')),
  body             jsonb not null,
  body_sha256      text not null,
  one_signer       boolean not null default false,
  sent_at          timestamptz not null default now(),
  sent_by          uuid,
  sent_by_name     text,
  voided_at        timestamptz,
  voided_by_name   text,
  void_reason      text,
  signed_at        timestamptz,
  final_sha256     text,
  pdf_path         text,
  sealed_at        timestamptz,
  last_reminded_at timestamptz,
  reminders_sent   integer not null default 0,
  unique (event_id, version)
);
-- One contract out for signature per event at a time.
create unique index if not exists ct_contracts_one_out
  on public.ct_contracts (event_id) where status = 'out';

create table if not exists public.ct_signers (
  id              uuid primary key default gen_random_uuid(),
  contract_id     uuid not null references public.ct_contracts(id) on delete cascade,
  role            text not null check (role in ('client1', 'client2')),
  name            text not null,
  email           text not null,
  user_id         uuid,
  first_opened_at timestamptz,
  signed_name     text,
  signed_at       timestamptz,
  ip              text,
  user_agent      text,
  unique (contract_id, role),
  unique (contract_id, email)
);

create table if not exists public.ct_answers (
  contract_id uuid primary key references public.ct_contracts(id) on delete cascade,
  answers     jsonb not null default '{}'::jsonb,
  locked_at   timestamptz,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create table if not exists public.ct_log (
  id          bigserial primary key,
  contract_id uuid not null references public.ct_contracts(id) on delete cascade,
  at          timestamptz not null default now(),
  what        text not null,
  who         text,
  ip          text,
  detail      jsonb
);
create index if not exists ct_log_contract on public.ct_log (contract_id, at);

-- Per event: show the couple only the booking form (and their documents) in
-- the portal until the office opens the rest. Presentation, not permission.
create table if not exists public.ct_event_settings (
  event_id          integer primary key,
  booking_form_only boolean not null default false,
  updated_at        timestamptz not null default now()
);

alter table public.ct_contracts      enable row level security;
alter table public.ct_signers        enable row level security;
alter table public.ct_answers        enable row level security;
alter table public.ct_log            enable row level security;
alter table public.ct_event_settings enable row level security;
revoke all on public.ct_contracts, public.ct_signers, public.ct_answers, public.ct_log, public.ct_event_settings
  from public, anon, authenticated;
revoke all on sequence public.ct_log_id_seq from public, anon, authenticated;

-- ── Helpers (internal) ──────────────────────────────────────────────────────

create or replace function public.ct_sha(p jsonb)
returns text language sql immutable
set search_path to 'public', 'extensions'
as $$ select encode(sha256(convert_to(p::text, 'UTF8')), 'hex') $$;

-- The couple's answers, cleaned: known keys only, strings trimmed and capped,
-- choices from a fixed list. Anything else is dropped, never stored.
create or replace function public.ct_clean_answers(p jsonb)
returns jsonb language plpgsql immutable
set search_path to 'public', 'extensions'
as $$
declare
  out jsonb := '{}'::jsonb;
  k text;
  v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return out; end if;
  foreach k in array array['client1Name','client1Mobile','client2Name','client2Mobile',
                           'address','invoiceName','invoiceEmail','requirements'] loop
    if p ? k then
      v := left(btrim(coalesce(p ->> k, '')), case when k in ('requirements','address') then 2000 else 200 end);
      out := out || jsonb_build_object(k, v);
    end if;
  end loop;
  foreach k in array array['amly','hamlet','glamping'] loop
    if p ? k then
      v := lower(btrim(coalesce(p ->> k, '')));
      if v in ('yes','hold','no','') then out := out || jsonb_build_object(k, v); end if;
    end if;
  end loop;
  if p ? 'glampingNights' then
    v := btrim(coalesce(p ->> 'glampingNights', ''));
    if v in ('1','2') then out := out || jsonb_build_object('glampingNights', v::int);
    elsif v = '' then out := out || jsonb_build_object('glampingNights', null);
    end if;
  end if;
  return out;
end $$;

-- What is still missing before a contract can be signed, as a list of keys.
-- The portal shows the same list (src/shared/contractDoc.js, contractMissing);
-- this is the one that is enforced.
create or replace function public.ct_missing(p_body jsonb, p_one boolean, a jsonb)
returns text[] language plpgsql immutable
set search_path to 'public', 'extensions'
as $$
declare
  miss text[] := '{}';
  row jsonb;
  k text;
  ans text;
  opts int;
  n int;
begin
  if coalesce(a ->> 'client1Name', '') = '' then miss := array_append(miss, 'client1Name'); end if;
  if coalesce(a ->> 'client1Mobile', '') = '' then miss := array_append(miss, 'client1Mobile'); end if;
  if not p_one then
    if coalesce(a ->> 'client2Name', '') = '' then miss := array_append(miss, 'client2Name'); end if;
    if coalesce(a ->> 'client2Mobile', '') = '' then miss := array_append(miss, 'client2Mobile'); end if;
  end if;
  if coalesce(a ->> 'address', '') = '' then miss := array_append(miss, 'address'); end if;
  for row in select * from jsonb_array_elements(coalesce(p_body -> 'accommodation', '[]'::jsonb)) loop
    k := row ->> 'key';
    ans := coalesce(a ->> k, '');
    if ans not in ('yes','hold','no') then miss := array_append(miss, k); continue; end if;
    if k = 'glamping' and ans in ('yes','hold') then
      opts := jsonb_array_length(coalesce(row -> 'options', '[]'::jsonb));
      n := nullif(a ->> 'glampingNights', '')::int;
      if n is null and opts = 1 then
        n := (row -> 'options' -> 0 ->> 'nights')::int;
      end if;
      if n is null or not exists (select 1 from jsonb_array_elements(row -> 'options') o
                                   where (o ->> 'nights')::int = n) then
        miss := array_append(miss, 'glampingNights');
      end if;
    end if;
  end loop;
  return miss;
end $$;

create or replace function public.ct_staff_name()
returns text language sql stable security definer
set search_path to 'public', 'extensions'
as $$ select coalesce(nullif(btrim(name), ''), email, 'Hawthbush Farm') from profiles where id = auth.uid() $$;

-- ── Staff (admin only) ──────────────────────────────────────────────────────

-- Send a contract. p_body is the frozen document the staff app built from the
-- template; the venue's signature is added here, then the whole is hashed.
-- Gives both clients portal access (wp_grant_access) in the same transaction.
-- The emails are a second, separate step (contract-admin.js "invite").
create or replace function public.ct_admin_issue(
  p_event_id integer, p_body jsonb, p_one_signer boolean,
  p_client1 jsonb, p_client2 jsonb, p_prefill jsonb, p_booking_form_only boolean)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_id uuid;
  v_ver int;
  v_name text;
  v_body jsonb;
  e1 text := lower(btrim(coalesce(p_client1 ->> 'email', '')));
  e2 text := lower(btrim(coalesce(p_client2 ->> 'email', '')));
  n1 text := btrim(coalesce(p_client1 ->> 'name', ''));
  n2 text := btrim(coalesce(p_client2 ->> 'name', ''));
  g jsonb;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_body is null or jsonb_typeof(p_body -> 'blocks') <> 'array' or jsonb_array_length(p_body -> 'blocks') = 0 then
    return jsonb_build_object('ok', false, 'error', 'empty_contract');
  end if;
  if length(p_body::text) > 600000 then return jsonb_build_object('ok', false, 'error', 'too_long'); end if;
  if e1 !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or n1 = '' then
    return jsonb_build_object('ok', false, 'error', 'client1_needed');
  end if;
  if not coalesce(p_one_signer, false) then
    if e2 !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or n2 = '' then
      return jsonb_build_object('ok', false, 'error', 'client2_needed');
    end if;
    if e2 = e1 then return jsonb_build_object('ok', false, 'error', 'same_email'); end if;
  end if;
  if not exists (select 1 from app_data d, lateral jsonb_array_elements(d.value) e
                  where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event_id) then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;
  if exists (select 1 from ct_contracts where event_id = p_event_id and status = 'out') then
    return jsonb_build_object('ok', false, 'error', 'already_out');
  end if;

  v_name := ct_staff_name();
  select coalesce(max(version), 0) + 1 into v_ver from ct_contracts where event_id = p_event_id;
  v_body := (p_body - 'venue') || jsonb_build_object('venue', jsonb_build_object(
              'company', 'Hawthbush Farm Ltd', 'name', v_name, 'signed_at', now()));

  insert into ct_contracts (event_id, version, body, body_sha256, one_signer, sent_by, sent_by_name)
  values (p_event_id, v_ver, v_body, ct_sha(v_body), coalesce(p_one_signer, false), auth.uid(), v_name)
  returning id into v_id;

  insert into ct_signers (contract_id, role, name, email) values (v_id, 'client1', n1, e1);
  if not coalesce(p_one_signer, false) then
    insert into ct_signers (contract_id, role, name, email) values (v_id, 'client2', n2, e2);
  end if;

  insert into ct_answers (contract_id, answers, updated_by)
  values (v_id, ct_clean_answers(p_prefill) - 'amly' - 'hamlet' - 'glamping' - 'glampingNights', 'office');

  if p_booking_form_only is not null then
    insert into ct_event_settings (event_id, booking_form_only) values (p_event_id, p_booking_form_only)
    on conflict (event_id) do update set booking_form_only = excluded.booking_form_only, updated_at = now();
  end if;

  g := wp_grant_access(p_event_id, e1);
  if coalesce((g ->> 'ok')::boolean, false) is not true then raise exception 'portal access for % failed: %', e1, g; end if;
  if not coalesce(p_one_signer, false) then
    g := wp_grant_access(p_event_id, e2);
    if coalesce((g ->> 'ok')::boolean, false) is not true then raise exception 'portal access for % failed: %', e2, g; end if;
  end if;

  insert into ct_log (contract_id, what, who, detail)
  values (v_id, 'Sent for signing (version ' || v_ver || ')', v_name,
          jsonb_build_object('to', case when coalesce(p_one_signer, false) then jsonb_build_array(e1) else jsonb_build_array(e1, e2) end));
  insert into ct_log (contract_id, what, who)
  values (v_id, 'Signed for Hawthbush Farm Ltd', v_name);

  return jsonb_build_object('ok', true, 'id', v_id, 'version', v_ver, 'sha256', ct_sha(v_body),
                            'venue_name', v_name, 'sent_at', now());
end $$;

create or replace function public.ct_admin_void(p_contract uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare
  c ct_contracts%rowtype;
  v_name text;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if btrim(coalesce(p_reason, '')) = '' then return jsonb_build_object('ok', false, 'error', 'reason_needed'); end if;
  select * into c from ct_contracts where id = p_contract for update;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- A signed contract is a done deal: it is never voided from here.
  if c.status <> 'out' then return jsonb_build_object('ok', false, 'error', 'not_out'); end if;
  v_name := ct_staff_name();
  update ct_contracts set status = 'void', voided_at = now(), voided_by_name = v_name,
         void_reason = left(btrim(p_reason), 500) where id = c.id;
  insert into ct_log (contract_id, what, who, detail)
  values (c.id, 'Voided', v_name, jsonb_build_object('reason', left(btrim(p_reason), 500)));
  return jsonb_build_object('ok', true);
end $$;

-- Everything about one event's contracts, newest first, for the Contract tab.
create or replace function public.ct_admin_for_event(p_event_id integer)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  return jsonb_build_object('ok', true,
    'booking_form_only', coalesce((select booking_form_only from ct_event_settings where event_id = p_event_id), false),
    'contracts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'version', c.version, 'status', c.status, 'body', c.body,
        'body_sha256', c.body_sha256, 'final_sha256', c.final_sha256, 'one_signer', c.one_signer,
        'sent_at', c.sent_at, 'sent_by_name', c.sent_by_name,
        'voided_at', c.voided_at, 'voided_by_name', c.voided_by_name, 'void_reason', c.void_reason,
        'signed_at', c.signed_at, 'pdf_path', c.pdf_path, 'sealed_at', c.sealed_at,
        'last_reminded_at', c.last_reminded_at, 'reminders_sent', c.reminders_sent,
        'answers', coalesce(a.answers, '{}'::jsonb), 'locked_at', a.locked_at,
        'signers', coalesce((select jsonb_agg(jsonb_build_object(
            'role', s.role, 'name', s.name, 'email', s.email, 'first_opened_at', s.first_opened_at,
            'signed_name', s.signed_name, 'signed_at', s.signed_at, 'ip', s.ip) order by s.role)
          from ct_signers s where s.contract_id = c.id), '[]'::jsonb),
        'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'what', l.what, 'who', l.who, 'ip', l.ip) order by l.at, l.id)
          from ct_log l where l.contract_id = c.id), '[]'::jsonb)
      ) order by c.version desc)
      from ct_contracts c left join ct_answers a on a.contract_id = c.id
      where c.event_id = p_event_id), '[]'::jsonb));
end $$;

-- The latest contract per event, for the pipeline and the start-up filing pass.
create or replace function public.ct_admin_statuses()
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  return jsonb_build_object('ok', true, 'contracts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'event_id', c.event_id, 'id', c.id, 'version', c.version, 'status', c.status,
      'sent_at', c.sent_at, 'signed_at', c.signed_at, 'pdf_path', c.pdf_path, 'sealed_at', c.sealed_at,
      'answers', case when c.status = 'signed' then a.answers else null end))
    from (select distinct on (event_id) * from ct_contracts order by event_id, version desc) c
    left join ct_answers a on a.contract_id = c.id), '[]'::jsonb));
end $$;

create or replace function public.ct_admin_set_booking_form_only(p_event_id integer, p_on boolean)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  insert into ct_event_settings (event_id, booking_form_only) values (p_event_id, coalesce(p_on, false))
  on conflict (event_id) do update set booking_form_only = excluded.booking_form_only, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- ── The couple ──────────────────────────────────────────────────────────────

-- Their contract: the newest that is out or signed (never a void one). The
-- first time each signer opens it is recorded (the audit trail's "opened").
create or replace function public.ct_my_contract()
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_event integer := wp_my_event_id();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  c ct_contracts%rowtype;
  me ct_signers%rowtype;
  a ct_answers%rowtype;
  v_only boolean;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  v_only := coalesce((select booking_form_only from ct_event_settings where event_id = v_event), false);
  select * into c from ct_contracts where event_id = v_event and status in ('out', 'signed')
   order by version desc limit 1;
  if c.id is null then
    return jsonb_build_object('ok', true, 'contract', null, 'booking_form_only', v_only);
  end if;
  select * into me from ct_signers where contract_id = c.id and (email = v_email or user_id = auth.uid())
   order by (email = v_email) desc limit 1;
  if me.id is not null and me.first_opened_at is null then
    update ct_signers set first_opened_at = now(), user_id = coalesce(user_id, auth.uid()) where id = me.id;
    insert into ct_log (contract_id, what, who) values (c.id, 'Opened by ' || me.name, me.email);
  end if;
  select * into a from ct_answers where contract_id = c.id;
  return jsonb_build_object('ok', true, 'booking_form_only', v_only, 'contract', jsonb_build_object(
    'id', c.id, 'version', c.version, 'status', c.status, 'body', c.body, 'body_sha256', c.body_sha256,
    'one_signer', c.one_signer, 'sent_at', c.sent_at, 'signed_at', c.signed_at,
    'pdf_ready', c.pdf_path is not null,
    'answers', coalesce(a.answers, '{}'::jsonb), 'locked', a.locked_at is not null,
    'missing', to_jsonb(ct_missing(c.body, c.one_signer, coalesce(a.answers, '{}'::jsonb))),
    'my_role', me.role,
    'can_sign', me.id is not null and me.signed_at is null and c.status = 'out',
    'signers', coalesce((select jsonb_agg(jsonb_build_object(
        'role', s.role, 'name', s.name, 'signed', s.signed_at is not null,
        'signed_at', s.signed_at, 'signed_name', s.signed_name) order by s.role)
      from ct_signers s where s.contract_id = c.id), '[]'::jsonb)));
end $$;

create or replace function public.ct_save_answers(p_answers jsonb)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_event integer := wp_my_event_id();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  c ct_contracts%rowtype;
  a ct_answers%rowtype;
  v_new jsonb;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select * into c from ct_contracts where event_id = v_event and status = 'out' order by version desc limit 1;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'no_contract'); end if;
  if not exists (select 1 from ct_signers where contract_id = c.id and (email = v_email or user_id = auth.uid())) then
    return jsonb_build_object('ok', false, 'error', 'not_a_signer');
  end if;
  select * into a from ct_answers where contract_id = c.id for update;
  if a.locked_at is not null then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  v_new := coalesce(a.answers, '{}'::jsonb) || ct_clean_answers(p_answers);
  update ct_answers set answers = v_new, updated_at = now(), updated_by = v_email where contract_id = c.id;
  return jsonb_build_object('ok', true, 'answers', v_new,
                            'missing', to_jsonb(ct_missing(c.body, c.one_signer, v_new)));
end $$;

-- ── Service only (Netlify functions) ────────────────────────────────────────

-- Sign. contract-sign.js has verified the user with Supabase and passes who
-- they are, the typed name, and the IP address and browser it saw.
create or replace function public.ct_sign_service(
  p_user uuid, p_email text, p_name text, p_ip text, p_ua text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_event integer;
  c ct_contracts%rowtype;
  me ct_signers%rowtype;
  a ct_answers%rowtype;
  miss text[];
  v_left int;
  v_sigs jsonb;
begin
  if btrim(coalesce(p_name, '')) = '' or length(btrim(p_name)) < 2 then
    return jsonb_build_object('ok', false, 'error', 'name_needed');
  end if;
  select acc.event_id into v_event from wp_access acc
   where acc.revoked_at is null and (acc.user_id = p_user or acc.email = v_email)
   order by acc.user_id nulls last limit 1;
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  select * into c from ct_contracts where event_id = v_event and status = 'out'
   order by version desc limit 1 for update;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'no_contract'); end if;
  select * into me from ct_signers where contract_id = c.id and (email = v_email or user_id = p_user)
   order by (email = v_email) desc limit 1 for update;
  if me.id is null then return jsonb_build_object('ok', false, 'error', 'not_a_signer'); end if;
  if me.signed_at is not null then return jsonb_build_object('ok', false, 'error', 'already_signed'); end if;

  select * into a from ct_answers where contract_id = c.id for update;
  miss := ct_missing(c.body, c.one_signer, coalesce(a.answers, '{}'::jsonb));
  if array_length(miss, 1) > 0 then
    return jsonb_build_object('ok', false, 'error', 'incomplete', 'missing', to_jsonb(miss));
  end if;

  -- The first signature freezes the details for everyone.
  if a.locked_at is null then
    update ct_answers set locked_at = now() where contract_id = c.id;
    insert into ct_log (contract_id, what, who, detail)
    values (c.id, 'Details locked', me.email, jsonb_build_object('answers', a.answers));
  end if;

  update ct_signers set signed_name = left(btrim(p_name), 120), signed_at = now(),
         ip = left(coalesce(p_ip, ''), 64), user_agent = left(coalesce(p_ua, ''), 300),
         user_id = coalesce(user_id, p_user)
   where id = me.id;
  insert into ct_log (contract_id, what, who, ip)
  values (c.id, 'Signed by ' || me.name || ' (typed "' || left(btrim(p_name), 120) || '")', me.email, left(coalesce(p_ip, ''), 64));

  select count(*) into v_left from ct_signers where contract_id = c.id and signed_at is null;
  if v_left = 0 then
    select jsonb_agg(jsonb_build_object('role', role, 'email', email, 'signed_name', signed_name,
                                        'signed_at', signed_at, 'ip', ip) order by role)
      into v_sigs from ct_signers where contract_id = c.id;
    update ct_contracts set status = 'signed', signed_at = now(),
           final_sha256 = ct_sha(jsonb_build_object('body', c.body, 'answers', a.answers, 'signatures', v_sigs))
     where id = c.id;
    insert into ct_log (contract_id, what, who) values (c.id, 'Completed — everyone has signed', 'system');
  end if;

  return jsonb_build_object('ok', true, 'contract_id', c.id, 'event_id', c.event_id,
                            'role', me.role, 'complete', v_left = 0);
end $$;

-- Everything the PDF and the emails need. Service only.
create or replace function public.ct_service_contract(p_contract uuid)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
declare c ct_contracts%rowtype;
begin
  select * into c from ct_contracts where id = p_contract;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true,
    'id', c.id, 'event_id', c.event_id, 'version', c.version, 'status', c.status, 'body', c.body,
    'body_sha256', c.body_sha256, 'final_sha256', c.final_sha256, 'one_signer', c.one_signer,
    'sent_at', c.sent_at, 'sent_by_name', c.sent_by_name, 'signed_at', c.signed_at,
    'pdf_path', c.pdf_path, 'sealed_at', c.sealed_at,
    'answers', coalesce((select answers from ct_answers where contract_id = c.id), '{}'::jsonb),
    'signers', coalesce((select jsonb_agg(jsonb_build_object(
        'role', s.role, 'name', s.name, 'email', s.email, 'signed_name', s.signed_name,
        'signed_at', s.signed_at, 'ip', s.ip, 'first_opened_at', s.first_opened_at) order by s.role)
      from ct_signers s where s.contract_id = c.id), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'what', l.what, 'who', l.who, 'ip', l.ip) order by l.at, l.id)
      from ct_log l where l.contract_id = c.id), '[]'::jsonb));
end $$;

create or replace function public.ct_service_set_pdf(p_contract uuid, p_path text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
begin
  -- Only the first run to finish files it: a second (the retry, a double
  -- click) is told 'already' and sends no second set of emails.
  update ct_contracts set pdf_path = p_path, sealed_at = now()
   where id = p_contract and status = 'signed' and pdf_path is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'already_or_not_signed'); end if;
  insert into ct_log (contract_id, what, who, detail) values (p_contract, 'Signed copy made and filed', 'system',
    jsonb_build_object('path', p_path));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.ct_service_note(p_contract uuid, p_what text, p_who text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
begin
  insert into ct_log (contract_id, what, who) values (p_contract, left(p_what, 500), left(coalesce(p_who, 'system'), 200));
  return jsonb_build_object('ok', true);
end $$;

-- Contracts still out whose last email (sending or reminder) is at least
-- p_every_days old, with who has still to sign.
create or replace function public.ct_service_due_reminders(p_every_days integer)
returns jsonb language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'event_id', c.event_id,
        'event_name', c.body -> 'event' ->> 'name', 'event_date', c.body -> 'event' ->> 'date',
        'last', greatest(c.sent_at, c.last_reminded_at),
        'unsigned', (select jsonb_agg(jsonb_build_object('name', s.name, 'email', s.email))
                       from ct_signers s where s.contract_id = c.id and s.signed_at is null)))
      from ct_contracts c
     where c.status = 'out'
       and greatest(c.sent_at, coalesce(c.last_reminded_at, c.sent_at))
           <= now() - make_interval(days => greatest(1, coalesce(p_every_days, 7)))), '[]'::jsonb);
end $$;

-- Marked BEFORE the email goes, and refused if another run got there first
-- (p_last must still be the latest send), so a reminder never goes twice.
create or replace function public.ct_service_mark_reminded(p_contract uuid, p_last timestamptz)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions'
as $$
begin
  update ct_contracts set last_reminded_at = now(), reminders_sent = reminders_sent + 1
   where id = p_contract and status = 'out'
     and greatest(sent_at, coalesce(last_reminded_at, sent_at)) = p_last;
  if not found then return jsonb_build_object('ok', false, 'error', 'taken'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Signed contracts with no PDF yet (a run that was cut short), for a retry.
create or replace function public.ct_service_unsealed()
returns jsonb language sql stable security definer
set search_path to 'public', 'extensions'
as $$
  select coalesce(jsonb_agg(id), '[]'::jsonb) from ct_contracts
   where status = 'signed' and pdf_path is null and signed_at < now() - interval '2 minutes';
$$;

-- The signed copy's path, for the couple — asked AS THE USER by
-- contract-sign.js before it signs a short-lived download link.
create or replace function public.ct_my_pdf_path()
returns text language sql stable security definer
set search_path to 'public', 'extensions'
as $$
  select c.pdf_path from ct_contracts c
   where c.event_id = wp_my_event_id() and c.status = 'signed' and c.pdf_path is not null
   order by c.version desc limit 1;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on new public functions to anon AND authenticated by
-- default; revoke from all three, then grant back what is wanted.
do $$
declare f text;
begin
  foreach f in array array[
    'public.ct_sha(jsonb)', 'public.ct_clean_answers(jsonb)', 'public.ct_missing(jsonb,boolean,jsonb)',
    'public.ct_staff_name()',
    'public.ct_admin_issue(integer,jsonb,boolean,jsonb,jsonb,jsonb,boolean)',
    'public.ct_admin_void(uuid,text)', 'public.ct_admin_for_event(integer)',
    'public.ct_admin_statuses()', 'public.ct_admin_set_booking_form_only(integer,boolean)',
    'public.ct_my_contract()', 'public.ct_save_answers(jsonb)', 'public.ct_my_pdf_path()',
    'public.ct_sign_service(uuid,text,text,text,text)', 'public.ct_service_contract(uuid)',
    'public.ct_service_set_pdf(uuid,text)', 'public.ct_service_note(uuid,text,text)',
    'public.ct_service_due_reminders(integer)', 'public.ct_service_mark_reminded(uuid,timestamptz)',
    'public.ct_service_unsealed()'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
  end loop;
end $$;

grant execute on function public.ct_admin_issue(integer,jsonb,boolean,jsonb,jsonb,jsonb,boolean) to authenticated;
grant execute on function public.ct_admin_void(uuid,text)                         to authenticated;
grant execute on function public.ct_admin_for_event(integer)                      to authenticated;
grant execute on function public.ct_admin_statuses()                              to authenticated;
grant execute on function public.ct_admin_set_booking_form_only(integer,boolean)  to authenticated;
grant execute on function public.ct_my_contract()                                 to authenticated;
grant execute on function public.ct_save_answers(jsonb)                           to authenticated;
grant execute on function public.ct_my_pdf_path()                                 to authenticated;

grant execute on function public.ct_sign_service(uuid,text,text,text,text)        to service_role;
grant execute on function public.ct_service_contract(uuid)                        to service_role;
grant execute on function public.ct_service_set_pdf(uuid,text)                    to service_role;
grant execute on function public.ct_service_note(uuid,text,text)                  to service_role;
grant execute on function public.ct_service_due_reminders(integer)                to service_role;
grant execute on function public.ct_service_mark_reminded(uuid,timestamptz)       to service_role;
grant execute on function public.ct_service_unsealed()                            to service_role;
