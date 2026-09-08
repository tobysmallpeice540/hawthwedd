-- 2026-09-08 · Box office: an optional question on the ticket checkout
--
-- Switched on per ticket type per event, with wording that is editable in the
-- app. The worked example was "if you would like to be seated with a group,
-- please leave us their surname here" — a seating question rather than a
-- booking one, so the answer has to travel all the way to the door list.
--
-- Run this in the Supabase SQL editor, whole, in one go. Every statement is
-- idempotent; running it twice changes nothing the second time.
--
--
-- WHY THIS FILE DOES NOT CONTAIN THE TWO FUNCTIONS IT CHANGES
--
-- box_public_event() and box_reserve_order() both need one small addition. The
-- obvious way to write that is to paste the whole function in with the change
-- made. This file deliberately does not, because the repository does not hold
-- the schema (see the outstanding list) and the only available copy of those
-- functions came through a chat window, where it lost a handful of whitespace
-- characters in transit — 6 in one function, 18 in the other. Pasting that back
-- would have quietly rewritten live code from a lossy copy.
--
-- So instead each function is read out of the catalogue as it actually stands,
-- patched in place, and put back. pg_get_functiondef() returns a complete,
-- executable CREATE OR REPLACE statement, so the signature, the volatility, the
-- SECURITY DEFINER flag and the search_path all carry across untouched, and
-- every line this migration is not deliberately changing is byte-for-byte what
-- was already running.
--
-- Each patch asserts that its anchor appears exactly once. A function that has
-- moved on since this was written raises and changes nothing, rather than
-- being replaced by something written against a version that no longer exists.
--
-- WHAT ACTUALLY CHANGES
--
--   box_public_event()   three more keys on each ticket type, so the checkout
--                        knows whether to ask and what to say. Nothing else in
--                        the returned object moves.
--
--   box_reserve_order()  one column on the box_order_lines insert at the very
--                        end. Nothing above that line reads it: the note takes
--                        no part in the row locking, the sold counts, the
--                        access code, the discount, the deposit or any refusal,
--                        and an order that cannot be reserved never reaches it.


-- ── 1. Configuration, per ticket type ───────────────────────────────────────
alter table box_ticket_types
  add column if not exists notes_enabled  boolean not null default false,
  add column if not exists notes_label    text,
  add column if not exists notes_required boolean not null default false;

comment on column box_ticket_types.notes_enabled  is
  'Ask the buyer a free-text question when this ticket type is in the basket.';
comment on column box_ticket_types.notes_label    is
  'The question, in Toby''s words. Shown above the box. Falls back to a generic prompt if blank.';
comment on column box_ticket_types.notes_required is
  'Refuse to continue past the details step until it is answered.';


-- ── 2. The answer, per order line ───────────────────────────────────────────
-- On the line rather than the order, because the question belongs to the ticket
-- type: a booking of four dinner tickets and two standing tickets can be asked
-- one thing about the table and nothing about the standing pair.
alter table box_order_lines
  add column if not exists customer_note text;

comment on column box_order_lines.customer_note is
  'What the buyer typed into the notes box for this ticket type at checkout.';


-- ── 3. Tidy-up ──────────────────────────────────────────────────────────────
-- An earlier draft of this change added a separate reader for the notes
-- configuration, because box_public_event() could not be seen at the time.
-- No longer needed. A no-op if it was never created.
drop function if exists public.box_public_ticket_notes(text);


-- ── 4. box_public_event(): return the configuration with each ticket type ───
do $mig$
declare
  def     text;
  anchor  text := '''avail_label'',';
  patched text;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'box_public_event';

  if def is null then
    raise exception 'box_public_event() not found — nothing to patch';
  end if;

  -- Already done? Then this migration has run before. Leave it alone.
  if position('notes_enabled' in def) > 0 then
    raise notice 'box_public_event() already returns the notes configuration — skipped';
    return;
  end if;

  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'box_public_event(): expected exactly one %, found %',
      anchor, (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  end if;

  -- The three keys go in ahead of avail_label. jsonb does not preserve key
  -- order, so where they sit in the literal makes no difference to the caller;
  -- what matters is that avail_label is a unique, single-line anchor and the
  -- surrounding expression is left alone.
  --
  -- coalesce() rather than the bare column so that a ticket type created before
  -- this migration reads as "asks nothing" rather than as null, which the page
  -- would otherwise have to special-case.
  patched := replace(def, anchor,
    '''notes_enabled'',  coalesce(t.notes_enabled, false),' || chr(10) ||
    '    ''notes_label'',    t.notes_label,'                || chr(10) ||
    '    ''notes_required'', coalesce(t.notes_required, false),' || chr(10) ||
    '    ''avail_label'',');

  execute patched;
  raise notice 'box_public_event() patched';
end $mig$;


-- ── 5. box_reserve_order(): carry the answer onto the line it belongs to ────
-- In the same transaction as the order, rather than patched on afterwards by
-- the Netlify function: no window in which a booking exists without the answer
-- that came with it, and no second write that can fail on its own.
do $mig$
declare
  def      text;
  cols     text := 'box_order_lines(order_id, ticket_type_id, qty, unit_price_pence)';
  price    text := '(select price_pence from box_ticket_types where id = (l->>''ticket_type_id'')::uuid)';
  patched  text;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'box_reserve_order';

  if def is null then
    raise exception 'box_reserve_order() not found — nothing to patch';
  end if;

  if position('customer_note' in def) > 0 then
    raise notice 'box_reserve_order() already stores the customer note — skipped';
    return;
  end if;

  if (length(def) - length(replace(def, cols, ''))) / length(cols) <> 1 then
    raise exception 'box_reserve_order(): the box_order_lines insert does not look as expected';
  end if;
  if (length(def) - length(replace(def, price, ''))) / length(price) <> 1 then
    raise exception 'box_reserve_order(): the unit price sub-select does not look as expected';
  end if;

  patched := replace(def, cols,
    'box_order_lines(order_id, ticket_type_id, qty, unit_price_pence, customer_note)');

  -- Blank and whitespace-only answers become null, so "did they answer?" is one
  -- test everywhere downstream rather than two.
  patched := replace(patched, price,
    price || ',' || chr(10) ||
    '         nullif(btrim(coalesce(l->>''note'', '''')), '''')');

  execute patched;
  raise notice 'box_reserve_order() patched';
end $mig$;


-- ── 6. Prove it took ────────────────────────────────────────────────────────
do $mig$
begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'box_ticket_types' and column_name = 'notes_enabled') then
    raise exception 'post-check: box_ticket_types.notes_enabled missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_name = 'box_order_lines' and column_name = 'customer_note') then
    raise exception 'post-check: box_order_lines.customer_note missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'box_public_event'
                    and position('notes_enabled' in p.prosrc) > 0) then
    raise exception 'post-check: box_public_event() does not return the notes configuration';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'box_reserve_order'
                    and position('customer_note' in p.prosrc) > 0) then
    raise exception 'post-check: box_reserve_order() does not store the customer note';
  end if;
  raise notice 'ALL FOUR POST-CHECKS PASSED';
end $mig$;
