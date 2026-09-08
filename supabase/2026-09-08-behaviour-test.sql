-- 2026-09-08 · Box office behaviour suite
--
-- Run AFTER 2026-09-08-ticket-notes.sql, against the same database:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/2026-09-08-behaviour-test.sql
--
-- Wrapped in a transaction that always rolls back, so it is safe against
-- production: the events, orders and codes it creates never survive the run.
-- Every slug is randomised, so it can be run twice in a row and by two people
-- at once.
--
-- 37 of these assertions are NOT about the notes field at all. They pin down
-- what box_public_event() and box_reserve_order() already did — the gate, the
-- sold counts, oversell refusal, per-order limits, event capacity, discounts,
-- the deposit split and the balance due date — because those two functions had
-- to be replaced to add the notes column, and "replaced" is only safe if you
-- can show the old behaviour is still there. The 12 notes assertions are
-- tagged N and are skipped if the migration has not been run.
--
-- This does not test concurrency. The row locking in box_reserve_order() is
-- unchanged by that migration, and proving it needs parallel sessions rather
-- than one transaction.
begin;
do $$
declare
  tag text := 'zz-' || substr(md5(random()::text), 1, 8);
  ev uuid; ev_gate uuid; ev_dep uuid; ev_cap uuid;
  t_std uuid; t_cheap uuid; t_gate uuid; t_dep uuid; t_cap uuid;
  r jsonb; p jsonb; tt jsonb;
  has_notes boolean;
  n int;
begin
  select exists (
    select 1 from information_schema.columns
     where table_name = 'box_order_lines' and column_name = 'customer_note'
  ) into has_notes;

  -- ── Fixtures ──────────────────────────────────────────────────────────────
  insert into box_events(slug, name, status, starts_at, ends_at, show_remaining, low_threshold)
    values (tag || '-open', 'Open Event', 'published', now() + interval '30 days',
            now() + interval '30 days 4 hours', 'exact', 10)
    returning id into ev;
  insert into box_ticket_types(event_id, name, quantity, price_pence, sort_order)
    values (ev, 'Standard', 10, 2500, 0) returning id into t_std;
  insert into box_ticket_types(event_id, name, quantity, price_pence, sort_order, max_per_order)
    values (ev, 'Cheap', 5, 1000, 1, 2) returning id into t_cheap;

  insert into box_events(slug, name, status, starts_at, access_code, listed)
    values (tag || '-gate', 'Private Event', 'published', now() + interval '10 days', 'BARN26', false)
    returning id into ev_gate;
  insert into box_ticket_types(event_id, name, quantity, price_pence)
    values (ev_gate, 'Invite', 20, 5000) returning id into t_gate;

  insert into box_events(slug, name, status, starts_at, payment_mode, deposit_pence, balance_days, min_per_order)
    values (tag || '-dep', 'Christmas Party', 'published', '2026-12-18 19:00+00', 'deposit', 2000, 30, 6)
    returning id into ev_dep;
  insert into box_ticket_types(event_id, name, quantity, price_pence)
    values (ev_dep, 'Dinner', 60, 7500) returning id into t_dep;

  insert into box_events(slug, name, status, starts_at, capacity)
    values (tag || '-cap', 'Capped', 'published', now() + interval '20 days', 4)
    returning id into ev_cap;
  insert into box_ticket_types(event_id, name, quantity, price_pence)
    values (ev_cap, 'Any', 100, 1000) returning id into t_cap;

  insert into box_discount_codes(event_id, code, kind, value) values (ev, 'TENOFF', 'percent', 10);
  insert into box_discount_codes(event_id, code, kind, value) values (ev, 'FIVER', 'fixed', 5);

  -- ── box_public_event ──────────────────────────────────────────────────────
  p := box_public_event(tag || '-open', null);
  if not (p->>'ok')::boolean then raise exception 'B1: public event not ok: %', p; end if;
  if jsonb_array_length(p->'ticket_types') <> 2 then raise exception 'B2: expected 2 types: %', p; end if;
  if (p->>'total_remaining')::int <> 15 then raise exception 'B3: expected 15 remaining, got %', p->>'total_remaining'; end if;
  tt := p->'ticket_types'->0;
  if tt->>'name' <> 'Standard' then raise exception 'B4: sort order wrong: %', tt; end if;
  if (tt->>'remaining')::int <> 10 then raise exception 'B5: remaining wrong: %', tt; end if;
  if tt->>'avail_label' <> '10 of 10 left' then raise exception 'B6: avail label wrong: %', tt->>'avail_label'; end if;

  -- The gate hides the tickets and says only what a stranger may see.
  p := box_public_event(tag || '-gate', null);
  if not (p->>'gated')::boolean then raise exception 'B7: private event was not gated'; end if;
  if p ? 'ticket_types' then raise exception 'B8: gated event leaked its ticket types'; end if;
  p := box_public_event(tag || '-gate', 'barn26');
  if (p->>'gated')::boolean then raise exception 'B9: correct code (lowercased) did not open the gate'; end if;

  -- ── Reserving ─────────────────────────────────────────────────────────────
  r := box_reserve_order(tag || '-open', '', 'Jane', 'Smith', 'jane@example.com', '07700 900123',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_std, 'qty', 2)), null, 'stripe', 'Terms accepted');
  if not (r->>'ok')::boolean then raise exception 'B10: reserve failed: %', r; end if;
  if (r->>'qty')::int <> 2 then raise exception 'B11: qty wrong: %', r; end if;
  if (r->>'total_pence')::int <> 5000 then raise exception 'B12: total wrong: %', r; end if;
  if (r->>'pay_now_pence')::int <> 5000 then raise exception 'B13: pay now wrong: %', r; end if;
  if (select order_ref from box_orders where id = (r->>'order_id')::uuid) !~ '^HB-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$' then
    raise exception 'B14: order ref malformed';
  end if;
  if (select length(qr_token) from box_orders where id = (r->>'order_id')::uuid) <> 32 then
    raise exception 'B15: qr token is not 32 characters';
  end if;
  if (select count(*) from box_order_lines where order_id = (r->>'order_id')::uuid) <> 1 then
    raise exception 'B16: expected one order line';
  end if;
  if (select unit_price_pence from box_order_lines where order_id = (r->>'order_id')::uuid) <> 2500 then
    raise exception 'B17: unit price not taken from the ticket type';
  end if;

  -- The pending hold counts as sold, so the page immediately shows fewer.
  p := box_public_event(tag || '-open', null);
  if ((p->'ticket_types'->0)->>'remaining')::int <> 8 then
    raise exception 'B18: pending hold not counted as sold: %', p->'ticket_types'->0;
  end if;

  -- ── Refusals ──────────────────────────────────────────────────────────────
  r := box_reserve_order(tag || '-open', '', 'Greedy', 'Person', 'g@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_std, 'qty', 9)));
  if (r->>'ok')::boolean then raise exception 'B19: oversell was allowed'; end if;
  if r->>'error' <> 'sold_out' then raise exception 'B20: wrong refusal: %', r; end if;
  if (r->>'remaining')::int <> 8 then raise exception 'B21: refusal reported wrong remaining: %', r; end if;

  r := box_reserve_order(tag || '-open', '', 'Max', 'Out', 'm@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_cheap, 'qty', 3)));
  if (r->>'ok')::boolean or r->>'error' <> 'above_max' then raise exception 'B22: max per order not enforced: %', r; end if;

  r := box_reserve_order(tag || '-gate', 'WRONG', 'Sneaky', 'Person', 's@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_gate, 'qty', 1)));
  if (r->>'ok')::boolean or r->>'error' <> 'bad_access_code' then
    raise exception 'B23: the gate was bypassable by posting directly: %', r;
  end if;

  r := box_reserve_order(tag || '-dep', '', 'Small', 'Party', 'sp@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_dep, 'qty', 4)));
  if (r->>'ok')::boolean or r->>'error' <> 'below_event_min' then
    raise exception 'B24: event minimum not enforced: %', r;
  end if;

  r := box_reserve_order(tag || '-cap', '', 'Too', 'Many', 'tm@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_cap, 'qty', 5)));
  if (r->>'ok')::boolean or r->>'error' <> 'sold_out' then
    raise exception 'B25: event capacity not enforced: %', r;
  end if;

  -- ── Money ─────────────────────────────────────────────────────────────────
  r := box_reserve_order(tag || '-open', '', 'Disc', 'Ount', 'd@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_std, 'qty', 2)), 'tenoff');
  if (r->>'discount_pence')::int <> 500 then raise exception 'B26: percent discount wrong: %', r; end if;
  if (r->>'total_pence')::int <> 4500 then raise exception 'B27: discounted total wrong: %', r; end if;

  r := box_reserve_order(tag || '-open', '', 'Fix', 'Ed', 'f@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_cheap, 'qty', 1)), 'FIVER');
  if (r->>'discount_pence')::int <> 500 then raise exception 'B28: fixed discount wrong: %', r; end if;
  if (r->>'total_pence')::int <> 500 then raise exception 'B29: fixed discount total wrong: %', r; end if;

  r := box_reserve_order(tag || '-open', '', 'Bad', 'Code', 'bc@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_cheap, 'qty', 1)), 'NOPE');
  if (r->>'ok')::boolean or r->>'error' <> 'bad_discount' then raise exception 'B30: bad code accepted: %', r; end if;

  -- A table of six at £75 with a £20 deposit: £120 now, £330 later, due 30 days
  -- before an 18 December event.
  r := box_reserve_order(tag || '-dep', '', 'Table', 'Six', 't6@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_dep, 'qty', 6)));
  if not (r->>'ok')::boolean then raise exception 'B31: deposit reserve failed: %', r; end if;
  if (r->>'deposit_pence')::int <> 12000 then raise exception 'B32: deposit wrong: %', r; end if;
  if (r->>'balance_pence')::int <> 33000 then raise exception 'B33: balance wrong: %', r; end if;
  if (r->>'pay_now_pence')::int <> 12000 then raise exception 'B34: pay now wrong on deposit: %', r; end if;
  if (r->>'balance_due_on')::date <> date '2026-11-18' then
    raise exception 'B35: balance due date wrong: %', r->>'balance_due_on';
  end if;

  -- A comp ticket takes no deposit and is allowed against a draft event.
  update box_events set status = 'draft' where id = ev_cap;
  r := box_reserve_order(tag || '-cap', '', 'Guest', 'List', 'gl@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_cap, 'qty', 2)), null, 'comp');
  if not (r->>'ok')::boolean then raise exception 'B36: comp order against a draft event refused: %', r; end if;
  update box_events set status = 'published' where id = ev_cap;

  r := box_reserve_order(tag || '-cap', '', 'Public', 'Buyer', 'pb@example.com', '',
        jsonb_build_array(jsonb_build_object('ticket_type_id', t_cap, 'qty', 1)));
  if not (r->>'ok')::boolean then raise exception 'B37: sale against a published event refused: %', r; end if;

  -- ── NEW: the checkout question ────────────────────────────────────────────
  if has_notes then
    update box_ticket_types
       set notes_enabled = true,
           notes_label = 'If you would like to be seated with a group, please leave us their surname here.',
           notes_required = false
     where id = t_std;

    p := box_public_event(tag || '-open', null);
    tt := p->'ticket_types'->0;
    if not (tt->>'notes_enabled')::boolean then raise exception 'N1: notes_enabled not returned: %', tt; end if;
    if tt->>'notes_label' not like 'If you would like%' then raise exception 'N2: notes_label not returned: %', tt; end if;
    if (tt->>'notes_required')::boolean then raise exception 'N3: notes_required should be false: %', tt; end if;
    tt := p->'ticket_types'->1;
    if (tt->>'notes_enabled')::boolean then raise exception 'N4: quiet type reported as asking: %', tt; end if;

    -- A note on one line, nothing on the other, in one reserve.
    r := box_reserve_order(tag || '-open', '', 'Note', 'Taker', 'nt@example.com', '',
          jsonb_build_array(
            jsonb_build_object('ticket_type_id', t_std,   'qty', 1, 'note', '  Henderson  '),
            jsonb_build_object('ticket_type_id', t_cheap, 'qty', 1)
          ));
    if not (r->>'ok')::boolean then raise exception 'N5: reserve with a note failed: %', r; end if;
    if (select customer_note from box_order_lines
         where order_id = (r->>'order_id')::uuid and ticket_type_id = t_std) <> 'Henderson' then
      raise exception 'N6: note not stored, or not trimmed';
    end if;
    if (select customer_note from box_order_lines
         where order_id = (r->>'order_id')::uuid and ticket_type_id = t_cheap) is not null then
      raise exception 'N7: a line with no note should be null, not empty string';
    end if;
    if (r->>'qty')::int <> 2 or (r->>'total_pence')::int <> 3500 then
      raise exception 'N8: adding a note changed the money: %', r;
    end if;

    -- A blank or whitespace answer is null, not an empty string, so "did they
    -- answer?" is one test everywhere.
    r := box_reserve_order(tag || '-open', '', 'Blank', 'Note', 'bn@example.com', '',
          jsonb_build_array(jsonb_build_object('ticket_type_id', t_std, 'qty', 1, 'note', '   ')));
    if (select customer_note from box_order_lines where order_id = (r->>'order_id')::uuid) is not null then
      raise exception 'N9: whitespace-only note should store as null';
    end if;

    -- An old client that sends no note key at all still works.
    r := box_reserve_order(tag || '-open', '', 'Old', 'Client', 'oc@example.com', '',
          jsonb_build_array(jsonb_build_object('ticket_type_id', t_std, 'qty', 1)));
    if not (r->>'ok')::boolean then raise exception 'N10: reserve without a note key failed: %', r; end if;
    if (select customer_note from box_order_lines where order_id = (r->>'order_id')::uuid) is not null then
      raise exception 'N11: missing note key should store as null';
    end if;

    -- Defaults: an existing ticket type asks nothing until switched on.
    if (select notes_enabled from box_ticket_types where id = t_cheap) is not false then
      raise exception 'N12: notes_enabled should default to false';
    end if;
    raise notice 'BEHAVIOUR SUITE PASSED (37 baseline + 12 notes assertions)';
  else
    raise notice 'BEHAVIOUR SUITE PASSED (37 baseline assertions; notes columns absent, 12 skipped)';
  end if;
end $$;
rollback;
