-- supabase/2026-10-23f-bar-payments.sql
--
-- Money behind the bar, recorded by Stripe instead of by hand.
--
-- The client types an amount on their Evening bar tab and presses Add now.
-- netlify/functions/bar-checkout.js asks wp_bar_payment_start() AS THE CLIENT
-- (so the event is theirs and no other), makes a Checkout session for exactly
-- that amount on the ticketing Stripe account, and attaches the session to the
-- pending row. When Stripe confirms payment, stripe-ticket-webhook.js calls
-- wp_bar_payment_paid(), which checks the session and the amount against the
-- row before marking it paid, then the webhook emails the client and the
-- office. Abandoned checkouts are marked expired. Nothing needs recording by
-- hand; staff can still add a payment taken another way (cash, a transfer).
--
-- wp_drinks.bar_paid_amount / bar_paid_at become the running total of paid
-- rows and the date of the latest, recomputed on every change, so every reader
-- of those fields (client tab, staff panel) keeps working.
--
-- House rules: RLS on with no policies, table privileges revoked from anon and
-- authenticated; SECURITY DEFINER functions; EXECUTE revoked by name. The
-- client function takes no event id. The webhook-facing ones are service-only.

begin;

create table if not exists public.wp_bar_payments (
  id                 uuid primary key default gen_random_uuid(),
  event_id           integer not null,
  amount             numeric(10,2) not null check (amount > 0 and amount <= 10000),
  status             text not null default 'pending' check (status in ('pending', 'paid', 'expired')),
  source             text not null default 'stripe' check (source in ('stripe', 'staff')),
  stripe_session_id  text unique,
  payment_intent     text,
  payer_email        text,
  note               text,
  created_at         timestamptz not null default now(),
  created_by         text,
  paid_at            timestamptz
);
create index if not exists wp_bar_payments_event on public.wp_bar_payments (event_id, created_at);
alter table public.wp_bar_payments enable row level security;
revoke all on table public.wp_bar_payments from anon, authenticated;

-- Internal: the running total onto wp_drinks, and a change-log line.
create or replace function public.wp_bar_recompute(p_event integer)
returns void language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_total numeric; v_last timestamptz;
begin
  select coalesce(sum(amount), 0), max(paid_at) into v_total, v_last
    from wp_bar_payments where event_id = p_event and status = 'paid';
  insert into wp_drinks (event_id) values (p_event) on conflict (event_id) do nothing;
  update wp_drinks set bar_paid_amount = nullif(v_total, 0), bar_paid_at = v_last, updated_at = now()
   where event_id = p_event;
end $function$;

-- Internal: what the client and staff see. Paid rows always; a pending one only
-- while its checkout could still complete (Stripe holds a session 30 minutes).
create or replace function public.wp_bar_payments_json(p_event integer)
returns jsonb language sql stable security definer set search_path to 'public', 'extensions' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'amount', amount, 'status', status, 'source', source,
           'created_at', created_at, 'paid_at', paid_at, 'note', note)
         order by coalesce(paid_at, created_at)), '[]'::jsonb)
    from wp_bar_payments
   where event_id = p_event
     and (status = 'paid' or (status = 'pending' and created_at > now() - interval '35 minutes'));
$function$;

-- Client: start a payment. Returns the row id and what the checkout needs.
create or replace function public.wp_bar_payment_start(p_amount numeric)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id(); v_id uuid; v_couple text; v_email text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_amount is null or p_amount < 10 or p_amount > 5000 or p_amount <> round(p_amount, 2) then
    return jsonb_build_object('ok', false, 'error', 'bad_amount');
  end if;
  -- One open checkout at a time per event is plenty; it also stops a double
  -- press making two sessions.
  if (select count(*) from wp_bar_payments where event_id = v_event and status = 'pending'
         and created_at > now() - interval '35 minutes') >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_pending');
  end if;
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  insert into wp_bar_payments (event_id, amount, created_by, payer_email)
  values (v_event, round(p_amount, 2), v_email, nullif(v_email, ''))
  returning id into v_id;
  select e ->> 'couple' into v_couple from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = v_event limit 1;
  perform wp_log('bar', 'started a payment of £' || to_char(round(p_amount, 2), 'FM999990.00') || ' behind the bar');
  return jsonb_build_object('ok', true, 'id', v_id, 'event_id', v_event, 'amount', round(p_amount, 2),
                            'couple', v_couple, 'email', v_email);
end $function$;

-- Service: the checkout session exists; tie it to the row.
create or replace function public.wp_bar_payment_attach(p_id uuid, p_session text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  update wp_bar_payments set stripe_session_id = p_session
   where id = p_id and status = 'pending' and stripe_session_id is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Service: Stripe says it is paid. The session id must be the one we made for
-- the row, and the amount must be exactly the row's. Idempotent: Stripe
-- retries webhooks, and a second delivery reports first_time false so nobody
-- is emailed twice.
create or replace function public.wp_bar_payment_paid(p_session text, p_amount_total numeric,
    p_payment_intent text, p_email text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare r wp_bar_payments%rowtype; v_first boolean := false; v_total numeric; v_couple text; v_date text;
begin
  select * into r from wp_bar_payments where stripe_session_id = p_session for update;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if round(p_amount_total, 2) <> r.amount then
    return jsonb_build_object('ok', false, 'error', 'amount_mismatch', 'expected', r.amount, 'got', p_amount_total);
  end if;
  if r.status <> 'paid' then
    update wp_bar_payments set status = 'paid', paid_at = now(), payment_intent = p_payment_intent,
           payer_email = coalesce(nullif(lower(p_email), ''), payer_email)
     where id = r.id returning * into r;
    v_first := true;
    perform wp_bar_recompute(r.event_id);
    -- wp_log finds nobody here (this runs with the service key), so write the
    -- change-log line directly.
    insert into wp_change_log (event_id, actor_email, area, summary)
    values (r.event_id, r.payer_email, 'bar', 'paid £' || to_char(r.amount, 'FM999990.00') || ' behind the bar');
  end if;
  select coalesce(sum(amount), 0) into v_total from wp_bar_payments where event_id = r.event_id and status = 'paid';
  select e ->> 'couple', e ->> 'date' into v_couple, v_date from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = r.event_id limit 1;
  return jsonb_build_object('ok', true, 'first_time', v_first, 'id', r.id, 'event_id', r.event_id,
    'amount', r.amount, 'total', v_total, 'paid_at', r.paid_at, 'payer_email', r.payer_email,
    'couple', v_couple, 'event_date', v_date,
    'client_emails', coalesce((select jsonb_agg(distinct a.email) from wp_access a
                                where a.event_id = r.event_id and a.revoked_at is null), '[]'::jsonb));
end $function$;

-- Service: an abandoned checkout.
create or replace function public.wp_bar_payment_expired(p_session text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  update wp_bar_payments set status = 'expired' where stripe_session_id = p_session and status = 'pending';
  return jsonb_build_object('ok', true);
end $function$;

-- Staff: a payment taken another way (cash, a transfer). Recorded as paid.
create or replace function public.wp_admin_add_bar_payment(p_event_id integer, p_amount numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000 then return jsonb_build_object('ok', false, 'error', 'bad_amount'); end if;
  insert into wp_bar_payments (event_id, amount, status, source, note, created_by, paid_at)
  values (p_event_id, round(p_amount, 2), 'paid', 'staff', left(nullif(trim(coalesce(p_note, '')), ''), 200),
          lower(coalesce(auth.jwt() ->> 'email', '')), now());
  perform wp_bar_recompute(p_event_id);
  insert into wp_change_log (event_id, actor_email, actor_user, area, summary)
  values (p_event_id, lower(coalesce(auth.jwt() ->> 'email', '')), auth.uid(), 'bar',
          'venue recorded £' || to_char(round(p_amount, 2), 'FM999990.00') || ' behind the bar');
  return jsonb_build_object('ok', true);
end $function$;

-- Staff: take back a payment recorded by hand in error. Stripe payments are
-- refunded in Stripe, not removed here.
create or replace function public.wp_admin_remove_bar_payment(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  update wp_bar_payments set status = 'expired', note = coalesce(note || ' · ', '') || 'removed by staff'
   where id = p_id and source = 'staff' and status = 'paid' returning event_id into v_event;
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_bar_recompute(v_event);
  return jsonb_build_object('ok', true);
end $function$;

-- The client's drinks payload and the staff panel gain the payment list.
do $patch$
declare v_def text; v_n int; rec record;
begin
  for rec in
    select * from (values
      ('public.wp_get_drinks()'::regprocedure,
       $a$'pay_bar', d.pay_bar, 'bar_usage', d.bar_usage,$a$,
       $b$'pay_bar', d.pay_bar, 'bar_usage', d.bar_usage,
      'bar_payments', wp_bar_payments_json(v_event),$b$,
       $m$'bar_payments', wp_bar_payments_json(v_event)$m$),
      ('public.wp_admin_drinks(integer)'::regprocedure,
       $a$'summary', wp_drinks_summary(p_event_id),$a$,
       $b$'summary', wp_drinks_summary(p_event_id),
    'bar_payments', (select coalesce(jsonb_agg(to_jsonb(x) order by coalesce(x.paid_at, x.created_at)), '[]'::jsonb)
                       from wp_bar_payments x where x.event_id = p_event_id and x.status <> 'expired'),$b$,
       $m$'bar_payments', (select$m$)
    ) as t(fn, anchor, replacement, marker)
  loop
    v_def := pg_get_functiondef(rec.fn);
    if position(rec.marker in v_def) > 0 then raise notice '% already patched', rec.fn; continue; end if;
    v_n := (length(v_def) - length(replace(v_def, rec.anchor, ''))) / length(rec.anchor);
    if v_n <> 1 then raise exception 'patch anchor for % found % times — nothing changed', rec.fn, v_n; end if;
    execute replace(v_def, rec.anchor, rec.replacement);
  end loop;
end $patch$;

do $grants$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname in
              ('wp_bar_recompute', 'wp_bar_payments_json', 'wp_bar_payment_start', 'wp_bar_payment_attach',
               'wp_bar_payment_paid', 'wp_bar_payment_expired', 'wp_admin_add_bar_payment', 'wp_admin_remove_bar_payment')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('wp_bar_payment_start', 'wp_admin_add_bar_payment', 'wp_admin_remove_bar_payment') then
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    else
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $grants$;

commit;
