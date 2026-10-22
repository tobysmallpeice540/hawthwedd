-- 2026-10-22 — Chef-run ticketed events (Stripe Connect direct charges)
--
-- Purely additive: one new table and new, nullable columns. Nothing existing is
-- altered or dropped, no function is touched, and every event that exists today
-- keeps selling exactly as it does now (payee_id null = Hawthbush sells).
--
-- Run in the Supabase SQL editor. Safe to run twice.
--
-- Design: claude/scope-chef-ticketing.md in the "Weddings Booking App" project.
--
-- Deliberately NO new database function, so there is no new EXECUTE grant to
-- remember to revoke. Everything reads and writes this table through
-- box-admin.js with the service key, as the rest of the box office does.

-- ── The chefs ────────────────────────────────────────────────────────────────
create table if not exists box_payees (
  id                     uuid primary key default gen_random_uuid(),
  legal_name             text not null,                -- the contracting party, shown to buyers as the seller
  trading_name           text not null default '',
  entity_type            text not null default 'sole_trader'
                           check (entity_type in ('sole_trader','company','other')),
  email                  text not null default '',
  stripe_account_id      text,                         -- acct_..., set when the invite is created
  charges_enabled        boolean not null default false,
  details_submitted      boolean not null default false,
  default_commission_bps int not null default 1500     -- 1500 = 15%, VAT-inclusive
                           check (default_commission_bps between 0 and 10000),
  created_at             timestamptz not null default now()
);

create unique index if not exists box_payees_stripe_account
  on box_payees(stripe_account_id) where stripe_account_id is not null;

-- Same posture as every other box-office table: RLS on, no policies, so the
-- anon key in the browser bundle can read none of it. Chef names and emails are
-- personal data.
alter table box_payees enable row level security;
revoke all on box_payees from anon, authenticated;

-- ── Events: who sells the tickets ────────────────────────────────────────────
-- ON DELETE RESTRICT, not SET NULL: deleting a chef must never quietly turn
-- their event into one Hawthbush sells.
alter table box_events
  add column if not exists payee_id uuid references box_payees(id) on delete restrict,
  add column if not exists commission_bps int
    check (commission_bps is null or commission_bps between 0 and 10000);   -- null = use the chef's default

-- Chef events are full payment only. Enforced here as well as in box-admin.js
-- so no route can create a chef event with a deposit.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'box_events_chef_full_payment_only') then
    alter table box_events
      add constraint box_events_chef_full_payment_only
      check (payee_id is null or payment_mode = 'full');
  end if;
end $$;

create index if not exists box_events_payee on box_events(payee_id);

-- ── Orders: a snapshot taken at checkout ─────────────────────────────────────
-- Copied onto the order so that editing the event later can never misroute a
-- refund, and so reporting does not depend on the chef's current settings.
alter table box_orders
  add column if not exists payee_id                  uuid references box_payees(id) on delete restrict,
  add column if not exists stripe_account_id         text,      -- the account the money was taken on (null = ours)
  add column if not exists commission_bps            int,
  add column if not exists application_fee_pence     int,       -- what Hawthbush's fee came to, VAT-inclusive
  add column if not exists stripe_payment_intent_id  text,      -- needed to refund
  add column if not exists marketing_opt_in          boolean not null default false,
  add column if not exists marketing_opt_in_at       timestamptz;

create index if not exists box_orders_payment_intent on box_orders(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ── Assertions: fail loudly if the shape is not what the code expects ────────
do $$
declare missing text;
begin
  select string_agg(c, ', ') into missing from (values
    ('box_payees.legal_name'), ('box_payees.stripe_account_id'), ('box_payees.charges_enabled'),
    ('box_events.payee_id'), ('box_events.commission_bps'),
    ('box_orders.payee_id'), ('box_orders.stripe_account_id'), ('box_orders.application_fee_pence'),
    ('box_orders.stripe_payment_intent_id'), ('box_orders.marketing_opt_in')
  ) v(c)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name  = split_part(v.c, '.', 1)
      and column_name = split_part(v.c, '.', 2)
  );
  if missing is not null then
    raise exception 'chef-payees migration incomplete, missing: %', missing;
  end if;
end $$;
