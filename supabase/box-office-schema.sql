-- ─────────────────────────────────────────────────────────────────────────────
-- HAWTHBUSH FARM — GRAIN STORE BOX OFFICE
-- Run this once, whole, in the Supabase SQL editor.
--
-- Why this feature has real tables when the rest of the app is a JSON blob in
-- app_data: every other feature is edited by one person at a time, so reading a
-- blob, changing it in the browser and writing it back whole is safe. Ticket
-- sales are not like that. Twenty people can press Buy in the same second, and
-- last-write-wins would silently oversell the barn. So the sales data lives in
-- proper rows, and the only way an order is ever created is box_reserve_order()
-- below, which locks the ticket types and counts what is genuinely sold inside
-- a single transaction.
--
-- Email templates and their timings deliberately stay in app_data
-- (hbf_box_templates_v1) — one person edits them occasionally, so the blob
-- really is the right tool there.
--
-- Everything is Europe/London. There is no timezone picker anywhere and there
-- must never be one; timestamptz columns store the correct instant and the app
-- formats them back in London time.
-- ─────────────────────────────────────────────────────────────────────────────

-- Not required by anything below — every function here uses core Postgres
-- only, so the schema works whichever schema Supabase puts extensions in.
create extension if not exists pgcrypto;

-- ── TABLES ───────────────────────────────────────────────────────────────────

create table if not exists box_events (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null default '',
  status              text not null default 'draft'
                        check (status in ('draft','published','hidden')),
  starts_at           timestamptz,
  ends_at             timestamptz,
  venue_name          text not null default 'The Grain Store',
  venue_postcode      text not null default 'TN21 0JY',
  description         text default '',            -- html
  header_image        text default '',
  page_image          text default '',
  capacity            int,                        -- null = no overall cap
  buy_button_label    text not null default 'Select tickets',
  hide_map            boolean not null default false,
  access_code         text,                       -- set = private event
  listed              boolean not null default true,
  show_remaining      text not null default 'hidden'
                        check (show_remaining in ('hidden','low','exact')),
  low_threshold       int not null default 10,
  min_per_order       int,                        -- null = no minimum
  payment_mode        text not null default 'full'
                        check (payment_mode in ('full','deposit')),
  deposit_pence       int not null default 0,     -- PER TICKET
  balance_days        int not null default 30,    -- balance due this many days before
  waitlist_on         boolean not null default false,
  waitlist_cta        text default 'Join the waitlist',
  waitlist_text       text default 'This event is sold out. Leave your details and we''ll email you if more tickets are released.',
  waitlist_confirmation text default 'Thank you — you''re on the list. We''ll be in touch if tickets become available.',
  created_at          timestamptz not null default now()
);

create table if not exists box_ticket_types (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references box_events(id) on delete cascade,
  name            text not null default '',
  description     text default '',
  quantity        int not null default 0,
  price_pence     int not null default 0,
  min_per_order   int,
  max_per_order   int,
  sort_order      int not null default 0,
  hidden          boolean not null default false
);
create index if not exists box_ticket_types_event on box_ticket_types(event_id);

-- This IS the entrant list. One row per booking, not per person — see the
-- note on box_checkins.
create table if not exists box_orders (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references box_events(id) on delete cascade,
  order_ref         text not null unique,          -- HB-8F3K2
  first_name        text default '',
  last_name         text default '',
  email             text default '',
  phone             text default '',
  status            text not null default 'pending'
                      check (status in ('pending','deposit_paid','paid','cancelled','refunded')),
  source            text not null default 'stripe'
                      check (source in ('stripe','cash','transfer','comp')),
  qr_token          text not null unique,          -- 32 random chars; what the QR holds
  tickets_issued_at timestamptz,                   -- null until paid in full
  total_qty         int not null default 0,
  admitted          int not null default 0,        -- the door's running tally
  discount_code     text,
  discount_pence    int not null default 0,
  total_pence       int not null default 0,        -- after discount
  deposit_pence     int not null default 0,
  balance_pence     int not null default 0,
  balance_due_on    date,
  balance_paid_at   timestamptz,
  chased_at         timestamptz,
  email_flags       jsonb not null default '{}'::jsonb,
  stripe_session_id text,
  paid_at           timestamptz,
  notes             text default '',
  created_at        timestamptz not null default now()
);
create index if not exists box_orders_event   on box_orders(event_id);
create index if not exists box_orders_token   on box_orders(qr_token);
create index if not exists box_orders_session on box_orders(stripe_session_id);
create index if not exists box_orders_status  on box_orders(event_id, status);

create table if not exists box_order_lines (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references box_orders(id) on delete cascade,
  ticket_type_id   uuid references box_ticket_types(id) on delete set null,
  qty              int not null default 0,
  unit_price_pence int not null default 0
);
create index if not exists box_order_lines_order on box_order_lines(order_id);

-- Full scan log. A group arriving in three cars produces three rows against
-- the same order; box_orders.admitted is the running total.
create table if not exists box_checkins (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references box_orders(id) on delete cascade,
  count      int not null default 0,
  checked_at timestamptz not null default now(),
  checked_by text default ''
);
create index if not exists box_checkins_order on box_checkins(order_id);

create table if not exists box_discount_codes (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references box_events(id) on delete cascade,
  code     text not null,
  kind     text not null default 'percent' check (kind in ('percent','fixed')),
  value    numeric not null default 0        -- percent: 10 = 10%. fixed: pounds.
);
create unique index if not exists box_discount_codes_uniq
  on box_discount_codes(event_id, upper(btrim(code)));

create table if not exists box_waitlist (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references box_events(id) on delete cascade,
  name        text default '',
  email       text default '',
  qty_wanted  int not null default 1,
  created_at  timestamptz not null default now(),
  notified_at timestamptz,
  converted   boolean not null default false
);
create index if not exists box_waitlist_event on box_waitlist(event_id);

-- Failed code attempts, so a short access code printed on a poster can't simply
-- be guessed by a script. Counted per event over a short window — see
-- box_rate_ok() for the honest limitation.
create table if not exists box_code_attempts (
  id       bigserial primary key,
  event_id uuid,
  kind     text not null,     -- 'access' | 'discount'
  at       timestamptz not null default now()
);
create index if not exists box_code_attempts_lookup on box_code_attempts(event_id, kind, at);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
-- RLS on, and deliberately no policies at all. The anon key in the public
-- pages therefore cannot read or write a single row of any of these tables —
-- not the buyer names, not the email addresses, not the QR tokens.
--
-- Everything the public needs goes through the SECURITY DEFINER functions
-- below, which run as the owner and expose exactly the fields a stranger is
-- allowed to see. Everything the office needs goes through box-admin.js with
-- the service key, which bypasses RLS.
--
-- This is the opposite of how app_data works today, and it is the point: the
-- box office holds the details of hundreds of members of the public who never
-- signed anything.

alter table box_events         enable row level security;
alter table box_ticket_types   enable row level security;
alter table box_orders         enable row level security;
alter table box_order_lines    enable row level security;
alter table box_checkins       enable row level security;
alter table box_discount_codes enable row level security;
alter table box_waitlist       enable row level security;
alter table box_code_attempts  enable row level security;

-- ── HELPERS ──────────────────────────────────────────────────────────────────

-- How many of each ticket type are genuinely gone: everything paid, plus
-- pending checkouts started in the last 15 minutes. That 15-minute hold is why
-- nobody loses their seats while typing a card number, and why an abandoned
-- checkout releases itself without anything having to run.
create or replace function box_sold_by_type(p_event_id uuid)
returns table (ticket_type_id uuid, sold int)
language sql
stable
as $$
  select l.ticket_type_id, coalesce(sum(l.qty), 0)::int
    from box_order_lines l
    join box_orders o on o.id = l.order_id
   where o.event_id = p_event_id
     and (
       o.status in ('paid','deposit_paid')
       or (o.status = 'pending' and o.created_at > now() - interval '15 minutes')
     )
   group by l.ticket_type_id;
$$;

create or replace function box_sold_total(p_event_id uuid)
returns int
language sql
stable
as $$
  select coalesce(sum(o.total_qty), 0)::int
    from box_orders o
   where o.event_id = p_event_id
     and (
       o.status in ('paid','deposit_paid')
       or (o.status = 'pending' and o.created_at > now() - interval '15 minutes')
     );
$$;

-- A short reference the buyer can read out over the phone: HB- and five
-- characters from an alphabet with no O/0 or I/1 in it, because these get read
-- aloud and written on door lists.
create or replace function box_new_ref()
returns text
language plpgsql
as $$
declare
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
  i int;
begin
  for attempt in 1..200 loop
    candidate := 'HB-';
    for i in 1..5 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from box_orders where order_ref = candidate) then
      return candidate;
    end if;
  end loop;
  -- Vanishingly unlikely; a longer reference beats failing the sale.
  return 'HB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
end;
$$;

-- 32 hex characters, from two UUIDs. Deliberately NOT pgcrypto's
-- gen_random_bytes(): on Supabase, extensions are installed into an
-- `extensions` schema, so a function pinned to search_path=public cannot see
-- them and fails at runtime with "gen_random_bytes does not exist".
-- gen_random_uuid() has been core Postgres since 13, so it is always visible.
-- 128 bits of randomness, and hex is safe in a URL path.
create or replace function box_new_token()
returns text
language sql
volatile
as $$
  select substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 32);
$$;

-- Best-effort brute-force brake. Counted per event rather than per IP, because
-- these functions are called straight from the browser and never see one.
-- Honest limitation: someone hammering an event's access code can trip the
-- brake for a legitimate guest too. The window is therefore short, and the
-- invite link carries ?code= so most people never type anything at all.
create or replace function box_rate_ok(p_event_id uuid, p_kind text)
returns boolean
language sql
stable
as $$
  select count(*) < 20
    from box_code_attempts
   where event_id = p_event_id
     and kind = p_kind
     and at > now() - interval '15 minutes';
$$;

-- Codes are typed off a poster, so they are compared case-insensitively and
-- with the whitespace taken off.
create or replace function box_norm_code(p_code text)
returns text
language sql
immutable
as $$
  select upper(btrim(coalesce(p_code, '')));
$$;

-- Money and percentages as a person would write them: 10 stays 10, 12.50
-- becomes 12.5. Trimming trailing zeros off the plain text would turn 10 into
-- 1, which is a discount nobody meant to offer.
create or replace function box_num_text(v numeric)
returns text
language sql
immutable
as $$
  select case when v = trunc(v) then trunc(v)::text else rtrim(v::text, '0') end;
$$;

-- What a stranger is allowed to know about how many are left.
create or replace function box_avail_label(p_show text, p_low int, p_remaining int, p_total int)
returns text
language sql
immutable
as $$
  select case
    when p_remaining <= 0 then 'Sold out'
    when p_show = 'exact' then p_remaining || ' of ' || p_total || ' left'
    when p_show = 'low' and p_remaining <= p_low then 'Only ' || p_remaining || ' left'
    else ''
  end;
$$;

-- ── PUBLIC READS ─────────────────────────────────────────────────────────────

-- /whats-on — published, listed events only. Nothing private, nothing draft.
create or replace function box_public_whats_on()
returns jsonb
language sql
security definer
set search_path = public, extensions
stable
as $$
  select coalesce(jsonb_agg(x order by x->>'starts_at'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'slug',        e.slug,
      'name',        e.name,
      'starts_at',   e.starts_at,
      'ends_at',     e.ends_at,
      'venue_name',  e.venue_name,
      'page_image',  e.page_image,
      'sold_out',    (
         coalesce((select sum(t.quantity) from box_ticket_types t
                    where t.event_id = e.id and not t.hidden), 0)
         - box_sold_total(e.id)
      ) <= 0,
      'from_pence',  (select min(t.price_pence) from box_ticket_types t
                       where t.event_id = e.id and not t.hidden)
    ) as x
    from box_events e
    where e.status = 'published'
      and e.listed
      and (e.ends_at is null or e.ends_at > now() - interval '6 hours')
  ) s;
$$;

-- /tickets/<slug>. Called with whatever access code the visitor has (or none).
-- A gated event still returns its name and date — enough for the page not to
-- look broken — and nothing else at all: no ticket types, no prices.
create or replace function box_public_event(p_slug text, p_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e box_events%rowtype;
  gated boolean := false;
  types jsonb;
  total_remaining int;
  total_quantity int;
begin
  select * into e from box_events where slug = p_slug and status = 'published';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if coalesce(e.access_code, '') <> '' then
    if box_norm_code(p_code) = box_norm_code(e.access_code) then
      gated := false;
    else
      gated := true;
      -- Only a genuine attempt counts against the brake; arriving with no code
      -- at all is the normal way to meet the gate.
      if coalesce(btrim(p_code), '') <> '' then
        insert into box_code_attempts(event_id, kind) values (e.id, 'access');
      end if;
      if not box_rate_ok(e.id, 'access') then
        return jsonb_build_object(
          'ok', true, 'gated', true, 'locked', true,
          'name', e.name, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
          'venue_name', e.venue_name
        );
      end if;
    end if;
  end if;

  if gated then
    return jsonb_build_object(
      'ok', true, 'gated', true, 'locked', false,
      'name', e.name, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
      'venue_name', e.venue_name, 'page_image', e.page_image
    );
  end if;

  select coalesce(sum(t.quantity), 0)::int into total_quantity
    from box_ticket_types t where t.event_id = e.id and not t.hidden;

  total_remaining := greatest(total_quantity - box_sold_total(e.id), 0);
  if e.capacity is not null then
    total_remaining := least(total_remaining, greatest(e.capacity - box_sold_total(e.id), 0));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',            t.id,
    'name',          t.name,
    'description',   t.description,
    'price_pence',   t.price_pence,
    'min_per_order', t.min_per_order,
    'max_per_order', t.max_per_order,
    'remaining',     greatest(t.quantity - coalesce(s.sold, 0), 0),
    'avail_label',   box_avail_label(e.show_remaining, e.low_threshold,
                       greatest(t.quantity - coalesce(s.sold, 0), 0), t.quantity)
  ) order by t.sort_order, t.name), '[]'::jsonb)
  into types
  from box_ticket_types t
  left join box_sold_by_type(e.id) s on s.ticket_type_id = t.id
  where t.event_id = e.id and not t.hidden;

  return jsonb_build_object(
    'ok', true,
    'gated', false,
    'id',               e.id,
    'slug',             e.slug,
    'name',             e.name,
    'starts_at',        e.starts_at,
    'ends_at',          e.ends_at,
    'venue_name',       e.venue_name,
    'venue_postcode',   e.venue_postcode,
    'description',      e.description,
    'header_image',     e.header_image,
    'page_image',       e.page_image,
    'buy_button_label', e.buy_button_label,
    'hide_map',         e.hide_map,
    'listed',           e.listed,
    'min_per_order',    e.min_per_order,
    'payment_mode',     e.payment_mode,
    'deposit_pence',    e.deposit_pence,
    'balance_days',     e.balance_days,
    'waitlist_on',      e.waitlist_on,
    'waitlist_cta',     e.waitlist_cta,
    'waitlist_text',    e.waitlist_text,
    'waitlist_confirmation', e.waitlist_confirmation,
    'show_remaining',   e.show_remaining,
    'total_remaining',  total_remaining,
    'sold_out',         total_remaining <= 0,
    'ticket_types',     types
  );
end;
$$;

-- /my-ticket/<token>. The token is the secret, so it is the whole check —
-- and the order reference is never accepted here, which is why the QR carries
-- a random 32 characters rather than the reference someone could read off a
-- ticket held up in front of them.
create or replace function box_my_ticket(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o box_orders%rowtype;
  e box_events%rowtype;
  lines jsonb;
begin
  select * into o from box_orders where qr_token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into e from box_events where id = o.event_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'name', coalesce(t.name, 'Ticket'),
    'qty',  l.qty,
    'unit_price_pence', l.unit_price_pence
  )), '[]'::jsonb)
  into lines
  from box_order_lines l
  left join box_ticket_types t on t.id = l.ticket_type_id
  where l.order_id = o.id;

  return jsonb_build_object(
    'ok', true,
    'order_ref',      o.order_ref,
    'first_name',     o.first_name,
    'last_name',      o.last_name,
    'status',         o.status,
    'total_qty',      o.total_qty,
    'admitted',       o.admitted,
    'total_pence',    o.total_pence,
    'deposit_pence',  o.deposit_pence,
    'balance_pence',  o.balance_pence,
    'balance_due_on', o.balance_due_on,
    'tickets_issued', o.tickets_issued_at is not null,
    'lines',          lines,
    'event', jsonb_build_object(
      'name', e.name, 'slug', e.slug,
      'starts_at', e.starts_at, 'ends_at', e.ends_at,
      'venue_name', e.venue_name, 'venue_postcode', e.venue_postcode
    )
  );
end;
$$;

-- Checking a discount code from the ticket step, so the saving can be shown in
-- the order summary before anyone commits to anything. This only ever reports
-- what a code is worth — box_reserve_order() works the discount out again from
-- scratch before Stripe is asked for a penny, so nothing here is trusted later.
create or replace function box_check_discount(p_slug text, p_code text, p_subtotal_pence int)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e  box_events%rowtype;
  dc box_discount_codes%rowtype;
  amount int;
begin
  select * into e from box_events where slug = p_slug and status = 'published';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if not box_rate_ok(e.id, 'discount') then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'message', 'Too many attempts. Please try again in a few minutes.');
  end if;

  select * into dc from box_discount_codes
   where event_id = e.id and box_norm_code(code) = box_norm_code(p_code);
  if not found then
    insert into box_code_attempts(event_id, kind) values (e.id, 'discount');
    return jsonb_build_object('ok', false, 'error', 'bad_discount',
      'message', 'That discount code is not recognised.');
  end if;

  if dc.kind = 'percent' then
    amount := round(greatest(coalesce(p_subtotal_pence, 0), 0) * dc.value / 100.0);
  else
    amount := round(dc.value * 100);
  end if;
  amount := least(greatest(amount, 0), greatest(coalesce(p_subtotal_pence, 0), 0));

  return jsonb_build_object(
    'ok', true,
    'code', box_norm_code(dc.code),
    'discount_pence', amount,
    -- A whole number keeps its zeros (10 is not 1), and only a genuine
    -- fraction gets them trimmed, so 12.50 reads as 12.5.
    'label', case when dc.kind = 'percent'
               then box_num_text(dc.value) || '% off'
               else '£' || box_num_text(dc.value) || ' off' end
  );
end;
$$;

create or replace function box_join_waitlist(p_slug text, p_name text, p_email text, p_qty int)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e box_events%rowtype;
begin
  select * into e from box_events where slug = p_slug and status = 'published';
  if not found or not e.waitlist_on then
    return jsonb_build_object('ok', false, 'error', 'not_available');
  end if;
  if coalesce(btrim(p_email), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'email_required');
  end if;
  -- Signing up twice is a misclick, not a second person.
  if exists (
    select 1 from box_waitlist
     where event_id = e.id and lower(btrim(email)) = lower(btrim(p_email)) and not converted
  ) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  insert into box_waitlist(event_id, name, email, qty_wanted)
  values (e.id, btrim(coalesce(p_name, '')), btrim(p_email), greatest(coalesce(p_qty, 1), 1));
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- ── THE RESERVE FUNCTION ─────────────────────────────────────────────────────
-- The only way an order is ever created, including for cash and comps.
--
-- In one transaction it locks the ticket types, counts what is genuinely sold,
-- re-checks the access code, the discount code and the minimum order size,
-- refuses if there isn't enough left, and only then writes the order.
--
-- Two people going for the last three tickets means exactly one of them gets
-- them. "First come, first served" after a waitlist release is then actually
-- true rather than aspirational.
--
-- p_lines: [{"ticket_type_id": "...", "qty": 2}, ...]
create or replace function box_reserve_order(
  p_slug        text,
  p_access_code text,
  p_first_name  text,
  p_last_name   text,
  p_email       text,
  p_phone       text,
  p_lines       jsonb,
  p_discount_code text default null,
  p_source      text default 'stripe',
  p_notes       text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e            box_events%rowtype;
  line         jsonb;
  tt           box_ticket_types%rowtype;
  want         int;
  sold         int;
  remaining    int;
  gross_pence  int := 0;
  qty_total    int := 0;
  disc_pence   int := 0;
  dc           box_discount_codes%rowtype;
  new_order_id uuid;
  new_ref      text;
  new_token    text;
  dep_pence    int := 0;
  bal_pence    int := 0;
  due_on       date;
  event_sold   int;
begin
  select * into e from box_events where slug = p_slug for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'That event could not be found.');
  end if;

  -- Hand-issued orders (cash/transfer/comp) come from the office through the
  -- service key and are allowed against a draft event; a public sale is not.
  if p_source = 'stripe' and e.status <> 'published' then
    return jsonb_build_object('ok', false, 'error', 'not_on_sale',
      'message', 'Tickets for this event are not on sale.');
  end if;

  -- The gate is re-checked here, server side, so posting straight at this
  -- function gets a private event no further than the page does.
  if p_source = 'stripe' and coalesce(e.access_code, '') <> '' then
    if not box_rate_ok(e.id, 'access') then
      return jsonb_build_object('ok', false, 'error', 'locked',
        'message', 'Too many attempts. Please try again in a few minutes.');
    end if;
    if box_norm_code(p_access_code) <> box_norm_code(e.access_code) then
      insert into box_code_attempts(event_id, kind) values (e.id, 'access');
      return jsonb_build_object('ok', false, 'error', 'bad_access_code',
        'message', 'That access code is not right.');
    end if;
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_tickets',
      'message', 'No tickets were selected.');
  end if;

  -- Lock every ticket type on the event, in a stable order so two concurrent
  -- reservations can never deadlock against each other.
  perform 1 from box_ticket_types where event_id = e.id order by id for update;

  for line in select * from jsonb_array_elements(p_lines) loop
    want := coalesce((line->>'qty')::int, 0);
    if want <= 0 then continue; end if;

    select * into tt from box_ticket_types
     where id = (line->>'ticket_type_id')::uuid and event_id = e.id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'bad_ticket_type',
        'message', 'One of those ticket types is no longer available.');
    end if;

    select coalesce(s.sold, 0) into sold
      from box_sold_by_type(e.id) s where s.ticket_type_id = tt.id;
    sold := coalesce(sold, 0);
    remaining := tt.quantity - sold;

    if want > remaining then
      return jsonb_build_object('ok', false, 'error', 'sold_out',
        'message', case when remaining <= 0
          then tt.name || ' has just sold out.'
          else 'Only ' || remaining || ' of ' || tt.name || ' left.' end,
        'ticket_type_id', tt.id, 'remaining', greatest(remaining, 0));
    end if;
    if tt.min_per_order is not null and want < tt.min_per_order then
      return jsonb_build_object('ok', false, 'error', 'below_min',
        'message', tt.name || ': minimum ' || tt.min_per_order || ' per order.');
    end if;
    if tt.max_per_order is not null and want > tt.max_per_order then
      return jsonb_build_object('ok', false, 'error', 'above_max',
        'message', tt.name || ': maximum ' || tt.max_per_order || ' per order.');
    end if;

    gross_pence := gross_pence + (want * tt.price_pence);
    qty_total   := qty_total + want;
  end loop;

  if qty_total <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_tickets',
      'message', 'No tickets were selected.');
  end if;

  -- Counted across the whole order: four adults and two children make a table
  -- of six.
  if e.min_per_order is not null and qty_total < e.min_per_order then
    return jsonb_build_object('ok', false, 'error', 'below_event_min',
      'message', 'This event is booked in groups of at least ' || e.min_per_order || '.');
  end if;

  -- The overall cap sits across all ticket types, so a room of 150 stays a
  -- room of 150 however the types are sized.
  if e.capacity is not null then
    event_sold := box_sold_total(e.id);
    if event_sold + qty_total > e.capacity then
      return jsonb_build_object('ok', false, 'error', 'sold_out',
        'message', case when e.capacity - event_sold <= 0
          then 'This event has just sold out.'
          else 'Only ' || (e.capacity - event_sold) || ' tickets left.' end,
        'remaining', greatest(e.capacity - event_sold, 0));
    end if;
  end if;

  -- Recalculated here and nowhere else. The browser is never trusted with a
  -- price: whatever the checkout displayed, this is the number Stripe is asked
  -- to take.
  if coalesce(btrim(p_discount_code), '') <> '' then
    select * into dc from box_discount_codes
     where event_id = e.id and box_norm_code(code) = box_norm_code(p_discount_code);
    if not found then
      insert into box_code_attempts(event_id, kind) values (e.id, 'discount');
      if not box_rate_ok(e.id, 'discount') then
        return jsonb_build_object('ok', false, 'error', 'locked',
          'message', 'Too many attempts. Please try again in a few minutes.');
      end if;
      return jsonb_build_object('ok', false, 'error', 'bad_discount',
        'message', 'That discount code is not recognised.');
    end if;
    if dc.kind = 'percent' then
      disc_pence := round(gross_pence * dc.value / 100.0);
    else
      disc_pence := round(dc.value * 100);
    end if;
    disc_pence := least(greatest(disc_pence, 0), gross_pence);
  end if;

  -- Deposits are per ticket: £75 a head with a £20 deposit means a table of six
  -- pays £120 now and owes £330.
  if e.payment_mode = 'deposit' and e.deposit_pence > 0 and p_source = 'stripe' then
    dep_pence := least(e.deposit_pence * qty_total, gross_pence - disc_pence);
    bal_pence := (gross_pence - disc_pence) - dep_pence;
    if e.starts_at is not null then
      due_on := (e.starts_at at time zone 'Europe/London')::date - e.balance_days;
    end if;
  end if;

  new_ref   := box_new_ref();
  new_token := box_new_token();

  insert into box_orders(
    event_id, order_ref, first_name, last_name, email, phone,
    status, source, qr_token, total_qty, discount_code, discount_pence,
    total_pence, deposit_pence, balance_pence, balance_due_on, notes
  ) values (
    e.id, new_ref, btrim(coalesce(p_first_name, '')), btrim(coalesce(p_last_name, '')),
    btrim(coalesce(p_email, '')), btrim(coalesce(p_phone, '')),
    'pending', p_source, new_token, qty_total,
    nullif(box_norm_code(p_discount_code), ''), disc_pence,
    gross_pence - disc_pence, dep_pence, bal_pence, due_on, coalesce(p_notes, '')
  )
  returning id into new_order_id;

  insert into box_order_lines(order_id, ticket_type_id, qty, unit_price_pence)
  select new_order_id,
         (l->>'ticket_type_id')::uuid,
         (l->>'qty')::int,
         (select price_pence from box_ticket_types where id = (l->>'ticket_type_id')::uuid)
    from jsonb_array_elements(p_lines) l
   where coalesce((l->>'qty')::int, 0) > 0;

  return jsonb_build_object(
    'ok', true,
    'order_id',       new_order_id,
    'order_ref',      new_ref,
    'qr_token',       new_token,
    'qty',            qty_total,
    'gross_pence',    gross_pence,
    'discount_pence', disc_pence,
    'total_pence',    gross_pence - disc_pence,
    'deposit_pence',  dep_pence,
    'balance_pence',  bal_pence,
    'balance_due_on', due_on,
    'pay_now_pence',  case when dep_pence > 0 then dep_pence else gross_pence - disc_pence end
  );
end;
$$;

-- Hygiene only. The correctness comes from the 15-minute count in
-- box_sold_by_type(), not from this ever running — but an abandoned checkout
-- is somebody's name and email address, and there is no reason to keep it.
create or replace function box_expire_holds()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n int;
begin
  with gone as (
    delete from box_orders
     where status = 'pending'
       and source = 'stripe'
       and created_at < now() - interval '2 hours'
    returning 1
  )
  select count(*)::int into n from gone;
  delete from box_code_attempts where at < now() - interval '1 day';
  return n;
end;
$$;

-- ── GRANTS ───────────────────────────────────────────────────────────────────
-- The anon key may call these functions and nothing else. It cannot read a
-- table directly, so the buyer list is not one URL away from anyone who reads
-- the JavaScript bundle.
-- Revoked from anon and authenticated BY NAME, not only from PUBLIC. Supabase
-- grants EXECUTE directly to those roles on every new function through default
-- privileges, and revoking from PUBLIC leaves a direct grant in place — which
-- is how these two stayed callable with the anon key until an audit found them.
revoke all on function box_reserve_order(text,text,text,text,text,text,jsonb,text,text,text)
  from anon, authenticated, public;
revoke all on function box_expire_holds() from anon, authenticated, public;

grant execute on function box_public_whats_on()            to anon, authenticated;
grant execute on function box_public_event(text, text)     to anon, authenticated;
grant execute on function box_my_ticket(text)              to anon, authenticated;
grant execute on function box_join_waitlist(text,text,text,int) to anon, authenticated;
grant execute on function box_check_discount(text,text,int)      to anon, authenticated;

-- box_reserve_order is called only by create-ticket-checkout.js with the
-- service key: it takes money decisions, so it is not something a browser gets
-- to call directly.
grant execute on function box_reserve_order(text,text,text,text,text,text,jsonb,text,text,text) to service_role;
grant execute on function box_expire_holds() to service_role;
