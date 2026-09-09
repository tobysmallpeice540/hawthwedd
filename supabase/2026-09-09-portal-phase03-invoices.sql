-- supabase/2026-09-09-portal-phase03-invoices.sql
--
-- Wedding client portal — phase 03: money, by mirroring rather than connecting.
--
-- APPLIED TO PRODUCTION 9 September 2026 as migration
-- portal_phase03_invoices_cache. Assertions: portal-phase03-invoices-test.sql
-- — 12, all passing.
--
-- Toby's design, and it is better than the Custom Connection I proposed. The
-- admin app is already signed in to Xero, so whenever a member of staff has it
-- open the invoice summary is copied here; the portal reads the copy. No Xero
-- credential exists anywhere near the client side, and no second Xero app, no
-- extra subscription and no refresh token to keep alive.
--
-- WHAT MAKES IT SAFE ENOUGH:
--   · Only AUTHORISED and PAID invoices are ever stored. The filter is applied
--     HERE, not trusted from the browser — xero-invoice.js pushes DRAFTs, and
--     showing a couple a draft invoice is a bad afternoon.
--   · The online invoice URL is a bearer link: anyone holding it can view and
--     pay. It is returned only to the couple whose event it belongs to, by the
--     same wp_my_event_id() rule as everything else, and never logged.
--   · Cached figures go stale between admin visits, so synced_at travels with
--     them and the portal says when it last checked. The Xero link is always
--     live, so the numbers are the summary and the link is the authority. The
--     portal also warns that payments take a few working days to show.
--
-- Rows for an event that are no longer in Xero as AUTHORISED or PAID (voided,
-- deleted, or moved to another contact) are removed on sync, so a voided
-- invoice disappears rather than lingering as an amount owed.

create table if not exists public.wp_invoices (
  event_id        integer not null,
  xero_invoice_id text    not null,
  invoice_number  text,
  invoice_date    date,
  due_date        date,
  status          text    not null check (status in ('AUTHORISED','PAID')),
  total           numeric(12,2),
  amount_due      numeric(12,2),
  amount_paid     numeric(12,2),
  currency        text,
  online_url      text,
  synced_at       timestamptz not null default now(),
  primary key (event_id, xero_invoice_id)
);
create index if not exists wp_invoices_event on public.wp_invoices (event_id, invoice_date desc);
alter table public.wp_invoices enable row level security;

-- ── Written by the admin app, from what it already fetched ─────────────────

create or replace function public.wp_admin_sync_invoices(p_event_id integer, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_kept   integer := 0;
  v_seen   text[];
  v_gone   integer := 0;
  v_needs  jsonb;
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_not_an_array');
  end if;
  if jsonb_array_length(p_rows) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many_rows');
  end if;

  -- Upsert the ones we will show. The status filter is applied here so a
  -- browser cannot talk us into storing a draft.
  with incoming as (
    select r ->> 'xero_invoice_id'                       as xid,
           nullif(r ->> 'invoice_number','')             as num,
           nullif(r ->> 'invoice_date','')::date         as idate,
           nullif(r ->> 'due_date','')::date             as ddate,
           upper(coalesce(r ->> 'status',''))            as status,
           nullif(r ->> 'total','')::numeric             as total,
           nullif(r ->> 'amount_due','')::numeric        as due,
           nullif(r ->> 'amount_paid','')::numeric       as paid,
           nullif(r ->> 'currency','')                   as cur,
           nullif(r ->> 'online_url','')                 as url
      from jsonb_array_elements(p_rows) r
  ), good as (
    select * from incoming
     where xid is not null and status in ('AUTHORISED','PAID')
  ), upserted as (
    insert into wp_invoices as w
      (event_id, xero_invoice_id, invoice_number, invoice_date, due_date,
       status, total, amount_due, amount_paid, currency, online_url, synced_at)
    select p_event_id, xid, num, idate, ddate, status, total, due, paid, cur, url, now()
      from good
    on conflict (event_id, xero_invoice_id) do update
      set invoice_number = excluded.invoice_number,
          invoice_date   = excluded.invoice_date,
          due_date       = excluded.due_date,
          status         = excluded.status,
          total          = excluded.total,
          amount_due     = excluded.amount_due,
          amount_paid    = excluded.amount_paid,
          currency       = excluded.currency,
          -- keep a URL we already have if this sync did not carry one
          online_url     = coalesce(excluded.online_url, w.online_url),
          synced_at      = now()
    returning 1
  )
  select count(*), array_agg(xid) into v_kept, v_seen from good;

  -- Anything previously cached for this event that Xero no longer lists as
  -- AUTHORISED or PAID has been voided, deleted or moved. Drop it rather than
  -- leave a phantom balance on someone's screen.
  delete from wp_invoices
   where event_id = p_event_id
     and xero_invoice_id <> all (coalesce(v_seen, array[]::text[]));
  get diagnostics v_gone = row_count;

  -- Which ones still have no public link, so the caller can fetch just those.
  select coalesce(jsonb_agg(xero_invoice_id), '[]'::jsonb) into v_needs
    from wp_invoices where event_id = p_event_id and online_url is null;

  return jsonb_build_object('ok', true, 'stored', v_kept, 'removed', v_gone, 'needs_url', v_needs);
end;
$function$;

-- ── Read by the portal ──────────────────────────────────────────────────────

create or replace function public.wp_my_invoices()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  return jsonb_build_object(
    'ok', true,
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'invoice_number', i.invoice_number,
               'invoice_date',   i.invoice_date,
               'due_date',       i.due_date,
               'status',         i.status,
               'total',          i.total,
               'amount_due',     i.amount_due,
               'amount_paid',    i.amount_paid,
               'currency',       coalesce(i.currency, 'GBP'),
               'online_url',     i.online_url,
               'overdue',        i.status = 'AUTHORISED'
                                 and i.due_date is not null
                                 and i.due_date < current_date
                                 and coalesce(i.amount_due, 0) > 0)
             order by i.invoice_date desc nulls last, i.invoice_number)
        from wp_invoices i where i.event_id = v_event), '[]'::jsonb),
    'outstanding', coalesce((
      select sum(amount_due) from wp_invoices
       where event_id = v_event and status = 'AUTHORISED'), 0),
    'checked_at', (select max(synced_at) from wp_invoices where event_id = v_event)
  );
end;
$function$;

revoke all on function public.wp_admin_sync_invoices(integer, jsonb) from public, anon, authenticated;
revoke all on function public.wp_my_invoices()                        from public, anon, authenticated;
grant execute on function public.wp_admin_sync_invoices(integer, jsonb) to authenticated, service_role;
grant execute on function public.wp_my_invoices()                       to authenticated, service_role;
