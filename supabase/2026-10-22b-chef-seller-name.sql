-- 2026-10-22b — Show the seller's name on the public event page and the ticket
--
-- Chef-run events are legally sold by the chef, and the buyer must be told who
-- the contract is with before paying. These two public functions are built as
-- allowlists (CLAUDE.md), so the seller's name has to be added to each one
-- explicitly. Only the NAME is added — never the chef's email, Stripe account
-- or commission.
--
--   box_public_event()  + seller_name, seller_trading_name   (null for Hawthbush events)
--                       + seller_ready — false while a chef's Stripe account
--                         can't take payments yet, so the page can be published
--                         early and show "on sale soon" instead of a buy button
--   box_my_ticket()     + seller_name                        (null for Hawthbush events)
--
-- Done the CLAUDE.md way: each live definition is read out of the catalogue
-- with pg_get_functiondef(), patched as a string at an anchor that must occur
-- exactly once, and only then re-executed. Nothing is pasted back from a copy.
-- Same signature, so CREATE OR REPLACE keeps the existing EXECUTE grants and
-- creates no overload.
--
-- Safe to run twice: a function that already returns seller_name is left alone.
-- Depends on 2026-10-22-chef-payees.sql (box_payees, box_events.payee_id,
-- box_orders.payee_id).

do $$
declare
  def    text;
  anchor text;
  n      int;
begin
  -- ── box_public_event ──────────────────────────────────────────────────────
  def := pg_get_functiondef('public.box_public_event(text,text)'::regprocedure);
  if position('seller_name' in def) > 0 then
    raise notice 'box_public_event already returns seller_name — left alone';
  else
    anchor := $a$'payment_mode',     e.payment_mode,$a$;
    n := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
    if n <> 1 then
      raise exception 'box_public_event: anchor found % times, expected exactly 1 — nothing changed', n;
    end if;
    execute replace(def, anchor,
      $r$'seller_name',      (select p.legal_name   from box_payees p where p.id = e.payee_id),
    'seller_trading_name', (select nullif(p.trading_name, '') from box_payees p where p.id = e.payee_id),
    'seller_ready',     (e.payee_id is null or coalesce((select p.charges_enabled from box_payees p where p.id = e.payee_id), false)),
    $r$ || anchor);
  end if;

  -- ── box_my_ticket ─────────────────────────────────────────────────────────
  -- From the order's own snapshot ONLY, never the event's current seller: a
  -- ticket names whoever actually sold it. Hawthbush orders have no payee, so
  -- this is null for them.
  def := pg_get_functiondef('public.box_my_ticket(text)'::regprocedure);
  if position('seller_name' in def) > 0 then
    raise notice 'box_my_ticket already returns seller_name — left alone';
  else
    anchor := $a$'tickets_issued', o.tickets_issued_at is not null,$a$;
    n := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
    if n <> 1 then
      raise exception 'box_my_ticket: anchor found % times, expected exactly 1 — nothing changed', n;
    end if;
    execute replace(def, anchor,
      $r$'seller_name',    (select p.legal_name from box_payees p where p.id = o.payee_id),
    $r$ || anchor);
  end if;
end $$;

-- ── Assertions ───────────────────────────────────────────────────────────────
do $$
begin
  if position('seller_name' in pg_get_functiondef('public.box_public_event(text,text)'::regprocedure)) = 0 then
    raise exception 'box_public_event does not return seller_name';
  end if;
  if position('seller_name' in pg_get_functiondef('public.box_my_ticket(text)'::regprocedure)) = 0 then
    raise exception 'box_my_ticket does not return seller_name';
  end if;
  -- Still exactly one of each: CREATE OR REPLACE with the same signature must
  -- not have produced an overload.
  if (select count(*) from pg_proc where proname = 'box_public_event' and pronamespace = 'public'::regnamespace) <> 1
  or (select count(*) from pg_proc where proname = 'box_my_ticket'    and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'unexpected overload of box_public_event or box_my_ticket';
  end if;
end $$;
