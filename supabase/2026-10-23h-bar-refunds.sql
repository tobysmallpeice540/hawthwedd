-- supabase/2026-10-23h-bar-refunds.sql
--
-- A refund made in Stripe comes off the money behind the bar by itself.
--
-- Staff refund in the Stripe dashboard (ticketing account) as before. Stripe
-- sends charge.refunded to stripe-ticket-webhook.js, which calls
-- wp_bar_payment_refunded() with the charge's payment intent and its
-- CUMULATIVE amount refunded. The row records that figure (never more than was
-- paid), the total behind the bar is recomputed net of refunds, and the client
-- and the office are told — once per change, because a repeated delivery
-- carries the same cumulative figure and changes nothing.
--
-- Needs, in Stripe: the ticketing account's existing webhook endpoint to also
-- listen for charge.refunded.
--
-- Live functions are patched from the catalogue at anchors asserted to occur
-- exactly once; a patch already applied is skipped.

begin;

alter table public.wp_bar_payments add column if not exists refunded_amount numeric(10,2) not null default 0;
alter table public.wp_bar_payments add column if not exists refunded_at timestamptz;
create index if not exists wp_bar_payments_pi on public.wp_bar_payments (payment_intent);

do $patch$
declare v_def text; v_n int; rec record;
begin
  for rec in
    select * from (values
      -- the running total is net of refunds
      ('public.wp_bar_recompute(integer)'::regprocedure,
       $a$select coalesce(sum(amount), 0), max(paid_at) into v_total, v_last$a$,
       $b$select coalesce(sum(amount - refunded_amount), 0), max(paid_at) into v_total, v_last$b$,
       $m$sum(amount - refunded_amount)$m$),
      ('public.wp_bar_payment_paid(text,numeric,text,text)'::regprocedure,
       $a$select coalesce(sum(amount), 0) into v_total from wp_bar_payments where event_id = r.event_id and status = 'paid';$a$,
       $b$select coalesce(sum(amount - refunded_amount), 0) into v_total from wp_bar_payments where event_id = r.event_id and status = 'paid';$b$,
       $m$sum(amount - refunded_amount)$m$),
      -- the client sees what came back
      ('public.wp_bar_payments_json(integer)'::regprocedure,
       $a$'created_at', created_at, 'paid_at', paid_at, 'note', note)$a$,
       $b$'created_at', created_at, 'paid_at', paid_at, 'note', note,
           'refunded_amount', refunded_amount, 'refunded_at', refunded_at)$b$,
       $m$'refunded_amount', refunded_amount$m$)
    ) as t(fn, anchor, replacement, marker)
  loop
    v_def := pg_get_functiondef(rec.fn);
    if position(rec.marker in v_def) > 0 then raise notice '% already patched', rec.fn; continue; end if;
    v_n := (length(v_def) - length(replace(v_def, rec.anchor, ''))) / length(rec.anchor);
    if v_n <> 1 then raise exception 'patch anchor for % found % times — nothing changed', rec.fn, v_n; end if;
    execute replace(v_def, rec.anchor, rec.replacement);
  end loop;
end $patch$;

-- Service: Stripe says this payment intent has had p_refunded_total refunded
-- in all. Not a bar payment → not_found (a ticket refund; nothing to do here).
create or replace function public.wp_bar_payment_refunded(p_payment_intent text, p_refunded_total numeric)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare r wp_bar_payments%rowtype; v_new numeric; v_delta numeric; v_total numeric; v_couple text; v_date text;
begin
  select * into r from wp_bar_payments
   where payment_intent = p_payment_intent and source = 'stripe' and status = 'paid' for update;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_new := least(r.amount, greatest(0, round(coalesce(p_refunded_total, 0), 2)));
  v_delta := v_new - r.refunded_amount;
  if v_delta <> 0 then
    update wp_bar_payments set refunded_amount = v_new, refunded_at = now() where id = r.id;
    perform wp_bar_recompute(r.event_id);
    insert into wp_change_log (event_id, actor_email, area, summary)
    values (r.event_id, null, 'bar', 'refunded £' || to_char(v_delta, 'FM999990.00') || ' of money behind the bar');
  end if;
  select coalesce(sum(amount - refunded_amount), 0) into v_total from wp_bar_payments where event_id = r.event_id and status = 'paid';
  select e ->> 'couple', e ->> 'date' into v_couple, v_date from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = r.event_id limit 1;
  return jsonb_build_object('ok', true, 'changed', v_delta <> 0, 'refund', v_delta, 'refunded_total', v_new,
    'paid', r.amount, 'total', v_total, 'event_id', r.event_id, 'payer_email', r.payer_email,
    'couple', v_couple, 'event_date', v_date,
    'client_emails', coalesce((select jsonb_agg(distinct a.email) from wp_access a
                                where a.event_id = r.event_id and a.revoked_at is null), '[]'::jsonb));
end $function$;

do $grants$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname = 'wp_bar_payment_refunded'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $grants$;

commit;
