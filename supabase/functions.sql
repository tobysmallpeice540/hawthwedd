-- supabase/functions.sql
--
-- Every function in the `public` schema of the Booking App database
-- (rkqbyisfmvwulsyxzwjz), as it actually stood on 8 September 2026.
--
-- WHAT THIS IS FOR
--
-- Until now the database had no representation in this repository at all: the
-- box office functions, the seven security-phase migrations and the RLS grants
-- existed only inside Supabase. That cost real time — the September notes field
-- was designed twice around two functions that could not be read, and the copy
-- that eventually arrived by hand was six and eighteen characters short of what
-- was really running. This file exists so that never happens again.
--
-- It is a REFERENCE COPY, not a migration. Reading it tells you what the
-- database does. Running it whole would recreate all 22 functions, which is
-- almost never what you want — change one function with a dated migration
-- alongside the others in this directory, then refresh this file.
--
-- It also does not, on its own, rebuild the database: the tables, indexes,
-- triggers, RLS policies and table grants are still unversioned. Those are the
-- obvious next thing to capture.
--
-- HOW IT WAS PRODUCED, AND HOW TO REFRESH IT
--
-- Straight out of the catalogue with pg_get_functiondef(), never retyped, and
-- checksummed against the database afterwards:
--
--   md5 9c26614aa9e86702077304784d7e0f82 · 27,170 characters · 22 functions
--
-- To regenerate, run this and save the single column it returns:
--
--   select string_agg(d.def || E';\n', E'\n' order by d.proname)
--   from (
--     select p.proname, pg_get_functiondef(p.oid) as def
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     left join pg_depend dep on dep.objid = p.oid and dep.deptype = 'e'
--     where n.nspname = 'public' and p.prokind = 'f' and dep.objid is null
--   ) d;
--
-- Then verify the md5 of what you saved matches the md5 of what the database
-- returned. If you copied it through anything that might touch whitespace, it
-- will not, and you will be glad you checked.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTIONS (22, alphabetical)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.audit_app_data()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'extensions'
AS $function$
declare
  uid uuid := auth.uid();
  em  text;
begin
  if uid is not null then
    select email into em from profiles where id = uid;
  end if;

  insert into audit_log (actor_id, actor_email, key, action, bytes)
  values (
    uid,
    coalesce(em, case when uid is null then 'server' else 'unknown' end),
    coalesce(new.key, old.key),
    lower(tg_op),
    length(coalesce(new.value, old.value)::text)
  );
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.audit_log_no_edits()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'audit_log is append-only';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.box_avail_label(p_show text, p_low integer, p_remaining integer, p_total integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p_remaining <= 0 then 'Sold out'
    when p_show = 'exact' then p_remaining || ' of ' || p_total || ' left'
    when p_show = 'low' and p_remaining <= p_low then 'Only ' || p_remaining || ' left'
    else ''
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.box_check_discount(p_slug text, p_code text, p_subtotal_pence integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_expire_holds()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_join_waitlist(p_slug text, p_name text, p_email text, p_qty integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_my_ticket(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_new_ref()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_new_token()
 RETURNS text
 LANGUAGE sql
AS $function$
  select substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 32);
$function$
;

CREATE OR REPLACE FUNCTION public.box_norm_code(p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select upper(btrim(coalesce(p_code, '')));
$function$
;

CREATE OR REPLACE FUNCTION public.box_num_text(v numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when v = trunc(v) then trunc(v)::text else rtrim(v::text, '0') end;
$function$
;

CREATE OR REPLACE FUNCTION public.box_public_event(p_slug text, p_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
    'notes_enabled',  coalesce(t.notes_enabled, false),
    'notes_label',    t.notes_label,
    'notes_required', coalesce(t.notes_required, false),
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_public_whats_on()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_rate_ok(p_event_id uuid, p_kind text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select count(*) < 20
    from box_code_attempts
   where event_id = p_event_id
     and kind = p_kind
     and at > now() - interval '15 minutes';
$function$
;

CREATE OR REPLACE FUNCTION public.box_reserve_order(p_slug text, p_access_code text, p_first_name text, p_last_name text, p_email text, p_phone text, p_lines jsonb, p_discount_code text DEFAULT NULL::text, p_source text DEFAULT 'stripe'::text, p_notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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

  insert into box_order_lines(order_id, ticket_type_id, qty, unit_price_pence, customer_note)
  select new_order_id,
         (l->>'ticket_type_id')::uuid,
         (l->>'qty')::int,
         (select price_pence from box_ticket_types where id = (l->>'ticket_type_id')::uuid),
         nullif(btrim(coalesce(l->>'note', '')), '')
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
$function$
;

CREATE OR REPLACE FUNCTION public.box_sold_by_type(p_event_id uuid)
 RETURNS TABLE(ticket_type_id uuid, sold integer)
 LANGUAGE sql
 STABLE
AS $function$
  select l.ticket_type_id, coalesce(sum(l.qty), 0)::int
    from box_order_lines l
    join box_orders o on o.id = l.order_id
   where o.event_id = p_event_id
     and (
       o.status in ('paid','deposit_paid')
       or (o.status = 'pending' and o.created_at > now() - interval '15 minutes')
     )
   group by l.ticket_type_id;
$function$
;

CREATE OR REPLACE FUNCTION public.box_sold_total(p_event_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(sum(o.total_qty), 0)::int
    from box_orders o
   where o.event_id = p_event_id
     and (
       o.status in ('paid','deposit_paid')
       or (o.status = 'pending' and o.created_at > now() - interval '15 minutes')
     );
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  insert into profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'bar')
  )
  on conflict (id) do nothing;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.my_profile()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(
    (select jsonb_build_object('id', id, 'email', email, 'name', name,
                               'role', role, 'active', active)
       from profiles where id = auth.uid()),
    '{}'::jsonb);
$function$
;

CREATE OR REPLACE FUNCTION public.public_accom_busy()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'propertyId', s->>'propertyId',
           'checkIn',    s->>'checkIn',
           'checkOut',   s->>'checkOut'
         )), '[]'::jsonb)
  from jsonb_array_elements(
         coalesce((select value from app_data where key = 'hbf_accom_v1'), '[]'::jsonb)
       ) b
  cross join lateral (
    select case
             when jsonb_typeof(b->'stays') = 'array' and jsonb_array_length(b->'stays') > 0
               then b->'stays'
             else jsonb_build_array(b)
           end as arr
  ) x
  cross join lateral jsonb_array_elements(x.arr) s
  where coalesce(b->>'status', '') <> 'cancelled'
    and coalesce(s->>'propertyId', '') <> ''
    and coalesce(s->>'checkIn', '')    <> ''
    and coalesce(s->>'checkOut', '')   <> '';
$function$
;

CREATE OR REPLACE FUNCTION public.public_properties()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',                   p->>'id',
    'name',                 p->>'name',
    'sleeps',               p->'sleeps',
    'colour',               p->>'colour',
    'colourBg',             p->>'colourBg',
    'publicBookable',       p->'publicBookable',
    'baseRate',             p->'baseRate',
    'seasons',              p->'seasons',
    'depositPct',           p->'depositPct',
    'balanceWeeks',         p->'balanceWeeks',
    'minNights',            p->'minNights',
    'maxNights',            p->'maxNights',
    'checkInDays',          p->'checkInDays',
    'checkOutDays',         p->'checkOutDays',
    'checkInFrom',          p->>'checkInFrom',
    'checkOutBy',           p->>'checkOutBy',
    'checkInFromWedding',   p->>'checkInFromWedding',
    'checkOutByWedding',    p->>'checkOutByWedding',
    'bookingHorizonMonths', p->'bookingHorizonMonths',
    'longStayDiscount',     p->'longStayDiscount',
    'longStayDiscountPct',  p->'longStayDiscountPct',
    'longStayThreshold',    p->'longStayThreshold',
    'breakageDefault',      p->'breakageDefault',
    'blockedByFarmEvents',  p->'blockedByFarmEvents'
    -- deliberately absent: airbnbImportUrl, lastSyncedAt, bookaletName
  ))), '[]'::jsonb)
  from jsonb_array_elements(
    coalesce((select value from app_data where key = 'hbf_properties_v1'), '[]'::jsonb)
  ) p;
$function$
;

CREATE OR REPLACE FUNCTION public.public_viewing_availability()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  with
  bookings as (
    select coalesce((select value from app_data where key = 'hawthbush_bookings_v6'), '[]'::jsonb) as v
  ),
  enquiries as (
    select coalesce((select value from app_data where key = 'hbf_enquiries_v1'), '[]'::jsonb) as v
  ),
  requests as (
    select coalesce((select value from app_data where key = 'hbf_viewing_requests_v1'), '[]'::jsonb) as v
  ),
  blocks as (
    select coalesce((select value from app_data where key = 'hbf_viewing_blocks_v1'), '[]'::jsonb) as v
  ),

  -- Viewings booked against a wedding record
  from_bookings as (
    select vw->>'date' as d, vw->>'time' as t
    from bookings, jsonb_array_elements(bookings.v) b
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(b->'viewings') = 'array' then b->'viewings' else '[]'::jsonb end
    ) vw
  ),
  -- …and against an enquiry
  from_enquiries as (
    select vw->>'date' as d, vw->>'time' as t
    from enquiries, jsonb_array_elements(enquiries.v) e
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(e->'viewings') = 'array' then e->'viewings' else '[]'::jsonb end
    ) vw
  ),
  -- …and requests made online that have been confirmed
  from_requests as (
    select r->>'date' as d, r->>'time' as t
    from requests, jsonb_array_elements(requests.v) r
    where r->>'status' = 'confirmed'
  ),
  taken as (
    select d, t from from_bookings
    union all select d, t from from_enquiries
    union all select d, t from from_requests
  )

  select jsonb_build_object(
    'taken', coalesce((
      select jsonb_agg(distinct jsonb_build_object('date', d, 'time', t))
      from taken where coalesce(d, '') <> ''
    ), '[]'::jsonb),

    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', bl->>'date', 'slot', bl->>'slot', 'kind', coalesce(bl->>'kind', 'block')))
      from blocks, jsonb_array_elements(blocks.v) bl
      where coalesce(bl->>'date', '') <> ''
    ), '[]'::jsonb),

    -- Just the dates. A farm event blocks the day; who it belongs to is none
    -- of the public page's business.
    'eventDays', coalesce((
      select jsonb_agg(distinct b->>'date')
      from bookings, jsonb_array_elements(bookings.v) b
      where coalesce(b->>'date', '') <> ''
        and coalesce(b->>'couple', '') <> ''
    ), '[]'::jsonb)
  );
$function$
;

-- ─────────────────────────────────────────────────────────────────────────────
-- EXECUTE GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Which roles may call what. This is load-bearing security, not bookkeeping:
-- `anon` is the key compiled into every public page, so anything granted to it
-- is reachable by anyone who views source.
--
-- The two that matter most are the ones NOT in this list for anon:
-- box_reserve_order() is service_role only, so an order can only be created
-- through the Netlify function, and box_expire_holds() and audit_app_data()
-- likewise. box_public_event(), box_check_discount(), box_join_waitlist() and
-- box_my_ticket() are anon-callable by design — they are the public pages —
-- and each is SECURITY DEFINER with its own gate inside.

grant execute on function public.audit_app_data() to service_role;
grant execute on function public.audit_log_no_edits() to anon;
grant execute on function public.audit_log_no_edits() to authenticated;
grant execute on function public.audit_log_no_edits() to service_role;
grant execute on function public.box_avail_label(p_show text, p_low integer, p_remaining integer, p_total integer) to anon;
grant execute on function public.box_avail_label(p_show text, p_low integer, p_remaining integer, p_total integer) to authenticated;
grant execute on function public.box_avail_label(p_show text, p_low integer, p_remaining integer, p_total integer) to service_role;
grant execute on function public.box_check_discount(p_slug text, p_code text, p_subtotal_pence integer) to anon;
grant execute on function public.box_check_discount(p_slug text, p_code text, p_subtotal_pence integer) to authenticated;
grant execute on function public.box_check_discount(p_slug text, p_code text, p_subtotal_pence integer) to service_role;
grant execute on function public.box_expire_holds() to service_role;
grant execute on function public.box_join_waitlist(p_slug text, p_name text, p_email text, p_qty integer) to anon;
grant execute on function public.box_join_waitlist(p_slug text, p_name text, p_email text, p_qty integer) to authenticated;
grant execute on function public.box_join_waitlist(p_slug text, p_name text, p_email text, p_qty integer) to service_role;
grant execute on function public.box_my_ticket(p_token text) to anon;
grant execute on function public.box_my_ticket(p_token text) to authenticated;
grant execute on function public.box_my_ticket(p_token text) to service_role;
grant execute on function public.box_new_ref() to anon;
grant execute on function public.box_new_ref() to authenticated;
grant execute on function public.box_new_ref() to service_role;
grant execute on function public.box_new_token() to anon;
grant execute on function public.box_new_token() to authenticated;
grant execute on function public.box_new_token() to service_role;
grant execute on function public.box_norm_code(p_code text) to anon;
grant execute on function public.box_norm_code(p_code text) to authenticated;
grant execute on function public.box_norm_code(p_code text) to service_role;
grant execute on function public.box_num_text(v numeric) to anon;
grant execute on function public.box_num_text(v numeric) to authenticated;
grant execute on function public.box_num_text(v numeric) to service_role;
grant execute on function public.box_public_event(p_slug text, p_code text) to anon;
grant execute on function public.box_public_event(p_slug text, p_code text) to authenticated;
grant execute on function public.box_public_event(p_slug text, p_code text) to service_role;
grant execute on function public.box_public_whats_on() to anon;
grant execute on function public.box_public_whats_on() to authenticated;
grant execute on function public.box_public_whats_on() to service_role;
grant execute on function public.box_rate_ok(p_event_id uuid, p_kind text) to anon;
grant execute on function public.box_rate_ok(p_event_id uuid, p_kind text) to authenticated;
grant execute on function public.box_rate_ok(p_event_id uuid, p_kind text) to service_role;
grant execute on function public.box_reserve_order(p_slug text, p_access_code text, p_first_name text, p_last_name text, p_email text, p_phone text, p_lines jsonb, p_discount_code text, p_source text, p_notes text) to service_role;
grant execute on function public.box_sold_by_type(p_event_id uuid) to anon;
grant execute on function public.box_sold_by_type(p_event_id uuid) to authenticated;
grant execute on function public.box_sold_by_type(p_event_id uuid) to service_role;
grant execute on function public.box_sold_total(p_event_id uuid) to anon;
grant execute on function public.box_sold_total(p_event_id uuid) to authenticated;
grant execute on function public.box_sold_total(p_event_id uuid) to service_role;
grant execute on function public.handle_new_user() to service_role;
grant execute on function public.my_profile() to anon;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.my_profile() to service_role;
grant execute on function public.public_accom_busy() to anon;
grant execute on function public.public_accom_busy() to authenticated;
grant execute on function public.public_accom_busy() to service_role;
grant execute on function public.public_properties() to anon;
grant execute on function public.public_properties() to authenticated;
grant execute on function public.public_properties() to service_role;
grant execute on function public.public_viewing_availability() to anon;
grant execute on function public.public_viewing_availability() to authenticated;
grant execute on function public.public_viewing_availability() to service_role;
