-- supabase/2026-10-23b-portal-drinks.sql
--
-- Client portal — the Drinks tab. 23 Oct 2026. Apply AFTER
-- 2026-10-23-portal-extras.sql (it relies on wp_my_event_id, wp_log,
-- wp_event_type_of, the patch conventions and the "drinks" section key).
--
-- NOT APPLIED. Tested on the local replica — see portal-drinks-test.sql.
--
-- Toby's rules, as given:
--
--   * Two packages, or something agreed separately ("bespoke"):
--       Classic Drinks Package — £24.00 + VAT a head
--       Bring your own (corkage) — £11.90 + VAT a head
--     EVERYTHING IN THE SYSTEM IS INC VAT: £28.80 and £14.28. Ex VAT is for
--     marketing only. The VAT is worked out for Xero, never typed.
--   * The rate is held PER WEDDING from day one — copied from settings when the
--     package is chosen, editable by staff — so a change of price never
--     reprices a booked wedding.
--   * Adults pay the rate; children pay the child rate (a setting, currently
--     £0); infants are free. Allowances are per ADULT. Evening-only guests are
--     not counted: both packages end with the wedding breakfast.
--   * Allowances per adult: 2 reception drinks, half a bottle of wine with the
--     meal, 1 glass for the toast. NO POOLING — each moment stands alone.
--   * Corkage beyond the allowance is charged per item: wine £10 + VAT a
--     bottle (sparkling counts as wine), beer/cider £2, mixed drink £2 a serve.
--     Spirits are NOT allowed — they are in the list, marked not allowed, so
--     they can be switched on later, and other kinds can be added.
--   * Anything not yet priced is "price on request", priced by staff later.
--   * The evening is always a pay bar. A client can put money behind the bar
--     (with rules, e.g. no spirits) and pay it through a Stripe Payment Link
--     set in settings. Unused money is refunded to the card — no bank details
--     are ever collected.
--   * The order locks a set number of days before the event (a setting,
--     starting at 28). Locked means the client can no longer change it here;
--     staff can unlock. This is a deliberate exception to "warn, never refuse":
--     the invoice is made from the locked order and must not move underneath it.
--   * Once locked, staff can create the drinks invoice in Xero as a DRAFT.
--
-- ONE implementation of the arithmetic: wp_drinks_summary(). The client tab,
-- the staff panel and the Xero invoice lines all read it.

begin;

-- ── settings: one row ───────────────────────────────────────────────────────
create table if not exists public.wp_drinks_settings (
  id                   boolean primary key default true check (id),
  classic_pp           numeric(10,2) not null default 28.80,   -- inc VAT, per adult
  corkage_pp           numeric(10,2) not null default 14.28,   -- inc VAT, per adult
  child_pp             numeric(10,2) not null default 0,       -- inc VAT, per child
  vat_rate             numeric(5,2)  not null default 20,
  lock_days            integer not null default 28 check (lock_days between 0 and 365),
  reception_per_adult  numeric(6,2) not null default 2,
  wine_bottles_per_adult numeric(6,2) not null default 0.5,
  toast_per_adult      numeric(6,2) not null default 1,
  bar_link_url         text check (bar_link_url is null or bar_link_url ~ '^https://'),
  bar_prices           jsonb not null default '[]'::jsonb,     -- [{name, price}] inc VAT, examples
  bar_note             text,
  xero_account         text not null default '205',
  updated_at           timestamptz not null default now()
);
alter table public.wp_drinks_settings enable row level security;
revoke all on table public.wp_drinks_settings from anon, authenticated;

insert into public.wp_drinks_settings (id, bar_note, bar_prices) values (true,
  'These are example prices. Bar prices change from time to time and always follow the brewery''s current price list.',
  '[{"name":"Pint of Gun Brewery beer","price":null},{"name":"Glass of house wine (175ml)","price":null},{"name":"Soft drink","price":null}]')
on conflict (id) do nothing;

-- ── the list: package choices, extras, corkage kinds ────────────────────────
-- route   classic | corkage
-- moment  reception | wine | toast   — the three allowances
--         extra                      — Classic add-ons and upgrades sold by the unit
--         soft                       — corkage soft-drink jugs
-- drinks_per_unit: how many of the moment's allowance one unit uses. Reception
-- is counted in drinks (a bottle of fizz = 6), the meal in bottles (a bottle =
-- 1), the toast in glasses (a bottle = 8).
-- price_inc_vat: for a Classic choice, the supplement per unit (0 = included);
-- for an extra, the price per unit; for a corkage kind, the ADDITIONAL corkage
-- per unit beyond the allowance.
create table if not exists public.wp_drinks_catalogue (
  id               uuid primary key default gen_random_uuid(),
  route            text not null check (route in ('classic', 'corkage')),
  moment           text not null check (moment in ('reception', 'wine', 'toast', 'extra', 'soft')),
  name             text not null,
  unit             text not null default 'glass',
  drinks_per_unit  numeric(6,2) not null default 1 check (drinks_per_unit > 0),
  price_inc_vat    numeric(10,2) check (price_inc_vat is null or price_inc_vat >= 0),
  price_on_request boolean not null default false,
  allowed          boolean not null default true,
  non_alcoholic    boolean not null default false,
  active           boolean not null default true,
  sort             integer not null default 0
);
alter table public.wp_drinks_catalogue enable row level security;
revoke all on table public.wp_drinks_catalogue from anon, authenticated;

insert into public.wp_drinks_catalogue (route, moment, name, unit, drinks_per_unit, price_inc_vat, price_on_request, allowed, non_alcoholic, sort)
select * from (values
  -- Classic: what the allowance can be spent on
  ('classic','reception','Prosecco',                       'glass', 1, 0,    false, true, false, 10),
  ('classic','reception','Bottled beer',                   'bottle',1, 0,    false, true, false, 20),
  ('classic','reception','Mixed drink (our selection)',    'glass', 1, 0,    false, true, false, 30),
  ('classic','reception','Non-alcoholic option',           'glass', 1, 0,    false, true, true,  40),
  ('classic','reception','Champagne instead of Prosecco',  'glass', 1, null, true,  true, false, 50),
  ('classic','wine',     'House red',                      'bottle',1, 0,    false, true, false, 10),
  ('classic','wine',     'House white',                    'bottle',1, 0,    false, true, false, 20),
  ('classic','wine',     'House rosé',                     'bottle',1, 0,    false, true, false, 30),
  ('classic','wine',     'Premium wine upgrade',           'bottle',1, null, true,  true, false, 40),
  ('classic','toast',    'Prosecco',                       'glass', 1, 0,    false, true, false, 10),
  ('classic','toast',    'Non-alcoholic option',           'glass', 1, 0,    false, true, true,  20),
  ('classic','toast',    'Champagne instead of Prosecco',  'glass', 1, null, true,  true, false, 30),
  -- Classic: make it yours
  ('classic','extra',    'Extra Prosecco',                 'bottle',1, null, true,  true, false, 10),
  ('classic','extra',    'Extra bottled beer',             'bottle',1, null, true,  true, false, 20),
  ('classic','extra',    'Mixed drink',                    'jug',   1, null, true,  true, false, 30),
  ('classic','extra',    'Beer trough (beers and ciders on ice)', 'trough', 1, null, true, true, false, 40),
  ('classic','extra',    'After-dinner cocktail',          'serve', 1, null, true,  true, false, 50),
  -- Corkage: what they may bring, and the additional corkage beyond the allowance
  ('corkage','reception','Prosecco, Champagne or sparkling wine', 'bottle', 6, 12.00, false, true,  false, 10),
  ('corkage','reception','Wine',                           'bottle',6, 12.00, false, true,  false, 20),
  ('corkage','reception','Bottled beer or cider',          'bottle',1, 2.40,  false, true,  false, 30),
  ('corkage','reception','Cocktail or mixed drink',        'serve', 1, 2.40,  false, true,  false, 40),
  ('corkage','reception','Spirits',                        'bottle',1, null,  false, false, false, 50),
  ('corkage','wine',     'Wine',                           'bottle',1, 12.00, false, true,  false, 10),
  ('corkage','toast',    'Prosecco, Champagne or sparkling wine', 'bottle', 8, 12.00, false, true, false, 10),
  ('corkage','soft',     'Sparkling elderflower',          'jug',   1, null,  true,  true,  true,  10),
  ('corkage','soft',     'Squash',                         'jug',   1, null,  true,  true,  true,  20)
) as v(route, moment, name, unit, drinks_per_unit, price_inc_vat, price_on_request, allowed, non_alcoholic, sort)
where not exists (select 1 from public.wp_drinks_catalogue);

-- ── one event's order ───────────────────────────────────────────────────────
create table if not exists public.wp_drinks (
  event_id          integer primary key,
  route             text check (route is null or route in ('classic', 'corkage', 'bespoke')),
  rate_pp           numeric(10,2),         -- inc VAT, per adult, THIS wedding's rate
  child_rate_pp     numeric(10,2),         -- inc VAT, per child
  soft_choice       text check (soft_choice is null or soft_choice in ('elderflower', 'squash')),
  notes             text,
  bespoke_note      text,                  -- staff: what was agreed, when "bespoke"
  unlocked          boolean not null default false,
  invoiced_at       timestamptz,
  xero_invoice_id   text,
  xero_invoice_number text,
  bar_amount        numeric(10,2) check (bar_amount is null or bar_amount >= 0),
  bar_rules         text,
  bar_paid_amount   numeric(10,2),
  bar_paid_at       timestamptz,
  updated_at        timestamptz not null default now(),
  updated_by        text
);
alter table public.wp_drinks enable row level security;
revoke all on table public.wp_drinks from anon, authenticated;

create table if not exists public.wp_drinks_lines (
  id               uuid primary key default gen_random_uuid(),
  event_id         integer not null,
  catalogue_id     uuid references public.wp_drinks_catalogue(id) on delete set null,
  route            text not null,
  moment           text not null,
  name             text not null,           -- kept, so a retired item still reads
  unit             text not null,
  drinks_per_unit  numeric(6,2) not null,
  qty              integer not null check (qty between 1 and 5000),
  unit_price       numeric(10,2),           -- inc VAT, as it was when added; null = not priced yet
  created_at       timestamptz not null default now()
);
create index if not exists wp_drinks_lines_event on public.wp_drinks_lines (event_id, moment, created_at);
alter table public.wp_drinks_lines enable row level security;
revoke all on table public.wp_drinks_lines from anon, authenticated;


-- ── the arithmetic, once ────────────────────────────────────────────────────
create or replace function public.wp_drinks_summary(p_event integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  s        wp_drinks_settings%rowtype;
  d        wp_drinks%rowtype;
  n        wp_guest_numbers%rowtype;
  v_date   date;
  v_lock   date;
  v_adults integer; v_children integer; v_infants integer;
  v_rate   numeric; v_child numeric;
  m        text; v_allow numeric; v_used numeric; v_left numeric; v_over_units integer;
  l        record;
  moments  jsonb := '[]'::jsonb;
  inv      jsonb := '[]'::jsonb;     -- invoice lines: [{desc, amount}] inc VAT
  v_total  numeric := 0;
  v_unpriced integer := 0;
  v_moment_lines jsonb; v_over_cost numeric; v_line_over integer; v_line_cost numeric;
  v_label  text;
begin
  select * into s from wp_drinks_settings where id;
  select * into d from wp_drinks where event_id = p_event;
  select * into n from wp_guest_numbers where event_id = p_event;
  select nullif(e ->> 'date', '')::date into v_date
    from app_data a, lateral jsonb_array_elements(a.value) e
   where a.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event limit 1;

  v_adults   := coalesce(n.seated_adults, 0);
  v_children := coalesce(n.seated_children, 0);
  v_infants  := coalesce(n.seated_babies, 0);
  v_lock     := case when v_date is not null then v_date - s.lock_days end;

  v_rate  := coalesce(d.rate_pp, case d.route when 'classic' then s.classic_pp when 'corkage' then s.corkage_pp end);
  v_child := coalesce(d.child_rate_pp, s.child_pp);

  -- The package itself
  if d.route in ('classic', 'corkage') and v_adults > 0 then
    v_label := case d.route when 'classic' then 'Classic Drinks Package' else 'Bring your own — corkage' end;
    inv := inv || jsonb_build_object('desc', v_label || ' — ' || v_adults || ' adults at £' || to_char(v_rate, 'FM999990.00'),
                                     'amount', round(v_rate * v_adults, 2));
    v_total := v_total + round(v_rate * v_adults, 2);
    if v_children > 0 and v_child > 0 then
      inv := inv || jsonb_build_object('desc', v_label || ' — ' || v_children || ' children at £' || to_char(v_child, 'FM999990.00'),
                                       'amount', round(v_child * v_children, 2));
      v_total := v_total + round(v_child * v_children, 2);
    end if;
  end if;

  -- The three allowances. No pooling: each moment stands alone.
  if d.route in ('classic', 'corkage') then
    foreach m in array array['reception', 'wine', 'toast'] loop
      v_allow := ceil(v_adults * case m when 'reception' then s.reception_per_adult
                                         when 'wine' then s.wine_bottles_per_adult
                                         else s.toast_per_adult end);
      select coalesce(sum(qty * drinks_per_unit), 0) into v_used
        from wp_drinks_lines where event_id = p_event and route = d.route and moment = m;
      v_over_cost := 0; v_moment_lines := '[]'::jsonb;

      if d.route = 'classic' then
        -- Supplements on upgrades. Going over the allowance is flagged, not
        -- charged: extra drinks are bought from the extras list.
        for l in select * from wp_drinks_lines where event_id = p_event and route = 'classic' and moment = m order by created_at loop
          if l.unit_price is null then
            v_unpriced := v_unpriced + 1;
          elsif l.unit_price > 0 then
            inv := inv || jsonb_build_object('desc', l.name || ' (upgrade) × ' || l.qty || ' ' || l.unit || case when l.qty = 1 then '' else 's' end,
                                             'amount', round(l.unit_price * l.qty, 2));
            v_over_cost := v_over_cost + round(l.unit_price * l.qty, 2);
          end if;
        end loop;
      else
        -- Corkage beyond the allowance. The allowance is used up by the dearest
        -- drinks first (highest corkage per drink), so what is charged is the
        -- cheaper remainder — the reading kindest to the client, and the same
        -- every time. A part-bottle over is charged as a bottle.
        v_left := v_allow;
        for l in select * from wp_drinks_lines where event_id = p_event and route = 'corkage' and moment = m
                  order by coalesce(unit_price, 0) / drinks_per_unit desc, created_at loop
          v_line_over := 0; v_line_cost := 0;
          if l.qty * l.drinks_per_unit <= v_left then
            v_left := v_left - l.qty * l.drinks_per_unit;
          else
            v_line_over := ceil((l.qty * l.drinks_per_unit - v_left) / l.drinks_per_unit);
            v_left := 0;
            if l.unit_price is null then
              v_unpriced := v_unpriced + 1;
            else
              v_line_cost := round(v_line_over * l.unit_price, 2);
              inv := inv || jsonb_build_object('desc', 'Additional corkage — ' || l.name || ' × ' || v_line_over || ' ' || l.unit
                                                        || case when v_line_over = 1 then '' else 's' end,
                                               'amount', v_line_cost);
            end if;
          end if;
          v_over_cost := v_over_cost + v_line_cost;
          v_moment_lines := v_moment_lines || jsonb_build_object('id', l.id, 'over_units', v_line_over, 'over_cost', v_line_cost);
        end loop;
      end if;

      v_total := v_total + v_over_cost;
      moments := moments || jsonb_build_object(
        'moment', m, 'allowance', v_allow, 'used', v_used,
        'unit', case m when 'reception' then 'drinks' when 'wine' then 'bottles' else 'glasses' end,
        'cost', v_over_cost, 'lines', v_moment_lines);
    end loop;

    -- Extras (Classic) and soft-drink jugs (corkage), priced by the unit.
    for l in select * from wp_drinks_lines where event_id = p_event and route = d.route
                                             and moment in ('extra', 'soft') order by moment, created_at loop
      if l.unit_price is null then
        v_unpriced := v_unpriced + 1;
      else
        inv := inv || jsonb_build_object('desc', l.name || ' × ' || l.qty || ' ' || l.unit || case when l.qty = 1 then '' else 's' end,
                                         'amount', round(l.unit_price * l.qty, 2));
        v_total := v_total + round(l.unit_price * l.qty, 2);
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'adults', v_adults, 'children', v_children, 'infants', v_infants,
    'numbers_missing', n.event_id is null,
    'rate_pp', v_rate, 'child_rate_pp', v_child,
    'lock_date', v_lock,
    'locked', v_lock is not null and current_date >= v_lock and not coalesce(d.unlocked, false),
    'moments', moments,
    'total', v_total,
    'vat', round(v_total * s.vat_rate / (100 + s.vat_rate), 2),
    'unpriced', v_unpriced,
    'invoice_lines', inv
  );
end $function$;

-- Internal: refuse a client write once locked.
create or replace function public.wp_drinks_locked(p_event integer)
returns boolean language sql stable security definer set search_path to 'public', 'extensions' as $function$
  select coalesce((wp_drinks_summary(p_event) ->> 'locked')::boolean, false);
$function$;


-- ── client ──────────────────────────────────────────────────────────────────
create or replace function public.wp_get_drinks()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  s wp_drinks_settings%rowtype;
  d wp_drinks%rowtype;
  v_type text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select * into s from wp_drinks_settings where id;
  select * into d from wp_drinks where event_id = v_event;
  v_type := wp_event_type_of(v_event);
  return jsonb_build_object(
    'ok', true,
    'event_id', v_event,
    -- The packages are for weddings. Every event gets the bar.
    'packages_offered', v_type = 'Wedding',
    'settings', jsonb_build_object(
      'classic_pp', s.classic_pp, 'corkage_pp', s.corkage_pp, 'child_pp', s.child_pp,
      'lock_days', s.lock_days, 'reception_per_adult', s.reception_per_adult,
      'wine_bottles_per_adult', s.wine_bottles_per_adult, 'toast_per_adult', s.toast_per_adult,
      'bar_link_url', s.bar_link_url, 'bar_prices', s.bar_prices, 'bar_note', s.bar_note),
    'catalogue', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'route', c.route, 'moment', c.moment, 'name', c.name, 'unit', c.unit,
               'drinks_per_unit', c.drinks_per_unit,
               'price', case when c.price_on_request then null else c.price_inc_vat end,
               'price_on_request', c.price_on_request or (c.price_inc_vat is null and c.allowed),
               'allowed', c.allowed, 'non_alcoholic', c.non_alcoholic)
             order by c.route, case c.moment when 'reception' then 1 when 'wine' then 2 when 'toast' then 3 when 'extra' then 4 else 5 end, c.sort, c.name)
        from wp_drinks_catalogue c where c.active), '[]'::jsonb),
    'order', jsonb_build_object(
      'route', d.route, 'soft_choice', d.soft_choice, 'notes', d.notes,
      'bespoke_note', d.bespoke_note,
      'bar_amount', d.bar_amount, 'bar_rules', d.bar_rules,
      'bar_paid_amount', d.bar_paid_amount, 'bar_paid_at', d.bar_paid_at,
      'invoiced', d.invoiced_at is not null),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'catalogue_id', x.catalogue_id, 'moment', x.moment, 'name', x.name,
               'unit', x.unit, 'drinks_per_unit', x.drinks_per_unit, 'qty', x.qty, 'unit_price', x.unit_price)
             order by x.moment, x.created_at)
        from wp_drinks_lines x where x.event_id = v_event and x.route = d.route), '[]'::jsonb),
    'summary', wp_drinks_summary(v_event)
  );
end $function$;

-- Choosing (or changing) the package. The rate is copied onto the wedding
-- from settings at this moment — that is "per wedding from day one". Lines
-- belonging to the other package go: they mean nothing under this one.
create or replace function public.wp_set_drinks_route(p_route text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  s wp_drinks_settings%rowtype;
  v_old text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_route is not null and p_route not in ('classic', 'corkage', 'bespoke') then
    return jsonb_build_object('ok', false, 'error', 'bad_route');
  end if;
  if wp_event_type_of(v_event) <> 'Wedding' and p_route is not null then
    return jsonb_build_object('ok', false, 'error', 'not_offered');
  end if;
  if wp_drinks_locked(v_event) then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  select * into s from wp_drinks_settings where id;
  select route into v_old from wp_drinks where event_id = v_event;
  if v_old is not distinct from p_route then return jsonb_build_object('ok', true); end if;

  insert into wp_drinks (event_id, route, rate_pp, child_rate_pp, updated_at, updated_by)
  values (v_event, p_route,
          case p_route when 'classic' then s.classic_pp when 'corkage' then s.corkage_pp end,
          case when p_route in ('classic', 'corkage') then s.child_pp end,
          now(), lower(coalesce(auth.jwt() ->> 'email', '')))
  on conflict (event_id) do update set
    route = excluded.route, rate_pp = excluded.rate_pp, child_rate_pp = excluded.child_rate_pp,
    updated_at = now(), updated_by = excluded.updated_by;
  delete from wp_drinks_lines where event_id = v_event and route is distinct from p_route;

  perform wp_log('drinks', 'chose ' || coalesce(p_route, 'no package'));
  return jsonb_build_object('ok', true);
end $function$;

-- Add a line (p_id null) or change its quantity. The price is taken from the
-- list when the line is added and kept, so a price change later does not move it.
create or replace function public.wp_save_drinks_line(p_id uuid, p_catalogue_id uuid, p_qty integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_route text;
  c wp_drinks_catalogue%rowtype;
  v_id uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_qty is null or p_qty < 1 or p_qty > 5000 then return jsonb_build_object('ok', false, 'error', 'bad_qty'); end if;
  if wp_drinks_locked(v_event) then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  select route into v_route from wp_drinks where event_id = v_event;

  if p_id is not null then
    update wp_drinks_lines set qty = p_qty where id = p_id and event_id = v_event returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  else
    select * into c from wp_drinks_catalogue where id = p_catalogue_id and active;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_available'); end if;
    if c.route is distinct from v_route then return jsonb_build_object('ok', false, 'error', 'wrong_package'); end if;
    if not c.allowed then return jsonb_build_object('ok', false, 'error', 'not_allowed'); end if;
    if (select count(*) from wp_drinks_lines where event_id = v_event) >= 80 then
      return jsonb_build_object('ok', false, 'error', 'too_many');
    end if;
    insert into wp_drinks_lines (event_id, catalogue_id, route, moment, name, unit, drinks_per_unit, qty, unit_price)
    values (v_event, c.id, c.route, c.moment, c.name, c.unit, c.drinks_per_unit, p_qty,
            case when c.price_on_request then null else c.price_inc_vat end)
    returning id into v_id;
  end if;

  perform wp_log('drinks', 'changed the drinks order');
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

create or replace function public.wp_delete_drinks_line(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if wp_drinks_locked(v_event) then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  delete from wp_drinks_lines where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('drinks', 'removed a line from the drinks order');
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_save_drinks_details(p_soft_choice text, p_notes text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_soft_choice is not null and p_soft_choice not in ('', 'elderflower', 'squash') then
    return jsonb_build_object('ok', false, 'error', 'bad_choice');
  end if;
  if wp_drinks_locked(v_event) then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  insert into wp_drinks (event_id, soft_choice, notes, updated_at, updated_by)
  values (v_event, nullif(p_soft_choice, ''), left(nullif(trim(coalesce(p_notes, '')), ''), 1000),
          now(), lower(coalesce(auth.jwt() ->> 'email', '')))
  on conflict (event_id) do update set soft_choice = excluded.soft_choice, notes = excluded.notes,
    updated_at = now(), updated_by = excluded.updated_by;
  perform wp_log('drinks', 'updated the drinks notes');
  return jsonb_build_object('ok', true);
end $function$;

-- Money behind the bar: how much they mean to put there, and the rules for it.
-- Not part of the lock — people top up a tab on the day before. Paying is done
-- on Stripe; staff record what actually arrived.
create or replace function public.wp_save_bar_tab(p_amount numeric, p_rules text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 50000) then
    return jsonb_build_object('ok', false, 'error', 'bad_amount');
  end if;
  insert into wp_drinks (event_id, bar_amount, bar_rules, updated_at, updated_by)
  values (v_event, round(p_amount, 2), left(nullif(trim(coalesce(p_rules, '')), ''), 500),
          now(), lower(coalesce(auth.jwt() ->> 'email', '')))
  on conflict (event_id) do update set bar_amount = excluded.bar_amount, bar_rules = excluded.bar_rules,
    updated_at = now(), updated_by = excluded.updated_by;
  perform wp_log('drinks', 'set money behind the bar');
  return jsonb_build_object('ok', true);
end $function$;


-- ── staff ───────────────────────────────────────────────────────────────────
create or replace function public.wp_admin_drinks(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare d wp_drinks%rowtype;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select * into d from wp_drinks where event_id = p_event_id;
  return jsonb_build_object('ok', true,
    'order', case when d.event_id is null then null else to_jsonb(d) end,
    'lines', coalesce((select jsonb_agg(to_jsonb(x) order by x.moment, x.created_at)
                         from wp_drinks_lines x where x.event_id = p_event_id and x.route = d.route), '[]'::jsonb),
    'summary', wp_drinks_summary(p_event_id),
    'xero_account', (select xero_account from wp_drinks_settings where id));
end $function$;

-- NULL leaves a field alone. p_clear_paid true clears the bar payment record.
create or replace function public.wp_admin_set_drinks(p_event_id integer, p_rate_pp numeric default null,
    p_child_rate_pp numeric default null, p_unlocked boolean default null, p_bespoke_note text default null,
    p_bar_paid_amount numeric default null, p_route text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_route is not null and p_route not in ('classic', 'corkage', 'bespoke') then
    return jsonb_build_object('ok', false, 'error', 'bad_route');
  end if;
  insert into wp_drinks (event_id) values (p_event_id) on conflict (event_id) do nothing;
  update wp_drinks set
    route         = coalesce(p_route, route),
    rate_pp       = coalesce(p_rate_pp, rate_pp),
    child_rate_pp = coalesce(p_child_rate_pp, child_rate_pp),
    unlocked      = coalesce(p_unlocked, unlocked),
    bespoke_note  = case when p_bespoke_note is null then bespoke_note else nullif(trim(p_bespoke_note), '') end,
    bar_paid_amount = case when p_bar_paid_amount is null then bar_paid_amount
                           when p_bar_paid_amount = 0 then null else p_bar_paid_amount end,
    bar_paid_at   = case when p_bar_paid_amount is null then bar_paid_at
                         when p_bar_paid_amount = 0 then null else now() end,
    updated_at = now()
  where event_id = p_event_id;
  if p_route is not null then
    delete from wp_drinks_lines where event_id = p_event_id and route <> p_route;
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Price a "price on request" line (or correct one).
create or replace function public.wp_admin_price_drinks_line(p_id uuid, p_unit_price numeric)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_unit_price is not null and p_unit_price < 0 then return jsonb_build_object('ok', false, 'error', 'bad_price'); end if;
  update wp_drinks_lines set unit_price = round(p_unit_price, 2) where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Record the draft invoice made in Xero. Refuses unless the order is locked
-- and every line has a price: an invoice from a moving or half-priced order
-- is the mistake this whole lock exists to prevent.
create or replace function public.wp_admin_mark_drinks_invoiced(p_event_id integer, p_xero_invoice_id text, p_number text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare sm jsonb := wp_drinks_summary(p_event_id);
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if not (sm ->> 'locked')::boolean then return jsonb_build_object('ok', false, 'error', 'not_locked'); end if;
  if (sm ->> 'unpriced')::int > 0 then return jsonb_build_object('ok', false, 'error', 'unpriced_lines'); end if;
  update wp_drinks set invoiced_at = now(), xero_invoice_id = p_xero_invoice_id,
                       xero_invoice_number = nullif(trim(coalesce(p_number, '')), '')
   where event_id = p_event_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_order'); end if;
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_drinks_settings()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'settings', (select to_jsonb(s) from wp_drinks_settings s where id),
    'catalogue', coalesce((select jsonb_agg(to_jsonb(c) order by c.route,
                             case c.moment when 'reception' then 1 when 'wine' then 2 when 'toast' then 3 when 'extra' then 4 else 5 end, c.sort, c.name)
                             from wp_drinks_catalogue c), '[]'::jsonb));
end $function$;

create or replace function public.wp_admin_save_drinks_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if nullif(p ->> 'bar_link_url', '') is not null and (p ->> 'bar_link_url') !~ '^https://' then
    return jsonb_build_object('ok', false, 'error', 'link_not_https');
  end if;
  if jsonb_typeof(coalesce(p -> 'bar_prices', '[]'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_prices');
  end if;
  update wp_drinks_settings set
    classic_pp  = coalesce(nullif(p ->> 'classic_pp', '')::numeric, classic_pp),
    corkage_pp  = coalesce(nullif(p ->> 'corkage_pp', '')::numeric, corkage_pp),
    child_pp    = coalesce(nullif(p ->> 'child_pp', '')::numeric, child_pp),
    vat_rate    = coalesce(nullif(p ->> 'vat_rate', '')::numeric, vat_rate),
    lock_days   = coalesce(nullif(p ->> 'lock_days', '')::int, lock_days),
    reception_per_adult    = coalesce(nullif(p ->> 'reception_per_adult', '')::numeric, reception_per_adult),
    wine_bottles_per_adult = coalesce(nullif(p ->> 'wine_bottles_per_adult', '')::numeric, wine_bottles_per_adult),
    toast_per_adult        = coalesce(nullif(p ->> 'toast_per_adult', '')::numeric, toast_per_adult),
    bar_link_url = nullif(trim(coalesce(p ->> 'bar_link_url', '')), ''),
    bar_prices   = coalesce(p -> 'bar_prices', '[]'::jsonb),
    bar_note     = nullif(trim(coalesce(p ->> 'bar_note', '')), ''),
    xero_account = coalesce(nullif(trim(coalesce(p ->> 'xero_account', '')), ''), xero_account),
    updated_at = now()
  where id;
  perform wp_log('admin', 'saved the drinks settings');
  return jsonb_build_object('ok', true);
end $function$;

-- Upsert by id; rows left out are switched off, never deleted.
create or replace function public.wp_admin_save_drinks_catalogue(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare e jsonb; ord bigint; v_ids uuid[] := '{}'; v_id uuid;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 150 then
    return jsonb_build_object('ok', false, 'error', 'bad_rows');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) x
              where length(trim(coalesce(x ->> 'name', ''))) = 0
                 or coalesce(x ->> 'route', '') not in ('classic', 'corkage')
                 or coalesce(x ->> 'moment', '') not in ('reception', 'wine', 'toast', 'extra', 'soft')
                 or coalesce(nullif(x ->> 'drinks_per_unit', '')::numeric, 1) <= 0) then
    return jsonb_build_object('ok', false, 'error', 'bad_row');
  end if;
  for e, ord in select x, o from jsonb_array_elements(p_rows) with ordinality as t(x, o) loop
    v_id := nullif(e ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from wp_drinks_catalogue where id = v_id) then
      update wp_drinks_catalogue set
        route = e ->> 'route', moment = e ->> 'moment', name = left(trim(e ->> 'name'), 120),
        unit = coalesce(left(nullif(trim(coalesce(e ->> 'unit', '')), ''), 20), 'glass'),
        drinks_per_unit = coalesce(nullif(e ->> 'drinks_per_unit', '')::numeric, 1),
        price_inc_vat = nullif(e ->> 'price_inc_vat', '')::numeric,
        price_on_request = coalesce((e ->> 'price_on_request')::boolean, false),
        allowed = coalesce((e ->> 'allowed')::boolean, true),
        non_alcoholic = coalesce((e ->> 'non_alcoholic')::boolean, false),
        active = coalesce((e ->> 'active')::boolean, true),
        sort = ord * 10
      where id = v_id;
    else
      insert into wp_drinks_catalogue (route, moment, name, unit, drinks_per_unit, price_inc_vat, price_on_request,
                                       allowed, non_alcoholic, active, sort)
      values (e ->> 'route', e ->> 'moment', left(trim(e ->> 'name'), 120),
              coalesce(left(nullif(trim(coalesce(e ->> 'unit', '')), ''), 20), 'glass'),
              coalesce(nullif(e ->> 'drinks_per_unit', '')::numeric, 1),
              nullif(e ->> 'price_inc_vat', '')::numeric,
              coalesce((e ->> 'price_on_request')::boolean, false),
              coalesce((e ->> 'allowed')::boolean, true),
              coalesce((e ->> 'non_alcoholic')::boolean, false),
              coalesce((e ->> 'active')::boolean, true), ord * 10)
      returning id into v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  update wp_drinks_catalogue set active = false where not (id = any (v_ids));
  perform wp_log('admin', 'saved the drinks list');
  return jsonb_build_object('ok', true);
end $function$;


-- ── grants ──────────────────────────────────────────────────────────────────
do $grants$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'wp_drinks_summary', 'wp_drinks_locked',
       'wp_get_drinks', 'wp_set_drinks_route', 'wp_save_drinks_line', 'wp_delete_drinks_line',
       'wp_save_drinks_details', 'wp_save_bar_tab',
       'wp_admin_drinks', 'wp_admin_set_drinks', 'wp_admin_price_drinks_line', 'wp_admin_mark_drinks_invoiced',
       'wp_admin_drinks_settings', 'wp_admin_save_drinks_settings', 'wp_admin_save_drinks_catalogue')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('wp_drinks_summary', 'wp_drinks_locked') then
      execute format('grant execute on function %s to service_role', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $grants$;

commit;
