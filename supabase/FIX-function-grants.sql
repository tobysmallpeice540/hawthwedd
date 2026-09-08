-- ─────────────────────────────────────────────────────────────────────────────
-- FIX — take box_reserve_order and box_expire_holds away from the anon key
--
-- Run the whole file in a NEW SQL editor tab. Read-safe: it changes who may
-- call two functions and nothing else. No public page uses them.
--
-- What was wrong: box-office-schema.sql did
--     revoke all on function box_reserve_order(...) from public;
-- which is not enough on Supabase. Supabase grants EXECUTE directly to anon
-- and authenticated on every new function through default privileges, and
-- revoking from PUBLIC leaves a direct grant untouched. The audit caught it.
--
-- Why it matters: box_reserve_order deliberately relaxes two checks when the
-- source is not 'stripe', because that is how the office issues cash and comp
-- tickets:
--     if p_source = 'stripe' and e.status <> 'published'      then refuse
--     if p_source = 'stripe' and access_code is set           then check it
-- Anyone holding the anon key — which is in the public bundle — could call it
-- with p_source => 'comp' and reserve seats on a draft or private event without
-- the code, repeatedly, holding the stock for fifteen minutes at a time.
--
-- They could NOT get a usable ticket: the order is created unpaid, so
-- tickets_issued_at stays null and ticket-qr.js refuses to draw a code. The
-- risk is exhausting an event's stock and walking past the private-event gate,
-- not stealing tickets or reading anyone's details.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function box_reserve_order(text,text,text,text,text,text,jsonb,text,text,text)
  from anon, authenticated, public;
revoke all on function box_expire_holds() from anon, authenticated, public;

grant execute on function box_reserve_order(text,text,text,text,text,text,jsonb,text,text,text)
  to service_role;
grant execute on function box_expire_holds() to service_role;

-- Trigger functions are called by the trigger, never by a client. Guarded so
-- this file runs cleanly whether or not the later migrations have been applied.
do $$
begin
  if to_regprocedure('public.audit_app_data()') is not null then
    execute 'revoke all on function public.audit_app_data() from anon, authenticated, public';
  end if;
  if to_regprocedure('public.handle_new_user()') is not null then
    execute 'revoke all on function public.handle_new_user() from anon, authenticated, public';
  end if;
end $$;

-- Prove it. box_reserve_order and box_expire_holds must read no/no; the five
-- public box office functions and my_profile must stay callable.
select p.proname as function_name,
       case when has_function_privilege('anon',          p.oid, 'EXECUTE') then 'YES' else 'no' end as anon,
       case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'YES' else 'no' end as signed_in,
       case when has_function_privilege('service_role',  p.oid, 'EXECUTE') then 'YES' else 'no' end as service
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by p.proname;
