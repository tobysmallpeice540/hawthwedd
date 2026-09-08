-- ─────────────────────────────────────────────────────────────────────────────
-- PATCH 01 — remove the pgcrypto dependency
--
-- Run this whole file in the Supabase SQL editor, in a NEW query tab.
--
-- Why: box_new_token() and box_new_ref() used gen_random_bytes(), which comes
-- from the pgcrypto extension. On Supabase, extensions live in an `extensions`
-- schema. Called on their own these functions work, because the session's
-- search_path includes that schema — but box_reserve_order() pins
-- `search_path = public`, so inside a real reservation gen_random_bytes is
-- invisible, the function throws, and the whole order rolls back. The symptom
-- is a checkout that fails at the payment step with no order row created.
--
-- The fix uses gen_random_uuid(), which has been core Postgres since version 13
-- and is therefore visible whatever the search_path.
--
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

-- 32 hex characters — 128 bits of randomness, and safe in a URL path.
create or replace function box_new_token()
returns text
language sql
volatile
as $$
  select substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 32);
$$;

-- A short reference the buyer can read out over the phone: HB- and five
-- characters from an alphabet with no O/0 or I/1 in it.
create or replace function box_new_ref()
returns text
language plpgsql
as $$
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
$$;

-- Belt and braces: let the security-definer functions see the extensions
-- schema too, so anything added later that does need an extension resolves.
alter function box_public_whats_on()                          set search_path = public, extensions;
alter function box_public_event(text, text)                   set search_path = public, extensions;
alter function box_my_ticket(text)                            set search_path = public, extensions;
alter function box_join_waitlist(text, text, text, int)       set search_path = public, extensions;
alter function box_check_discount(text, text, int)            set search_path = public, extensions;
alter function box_expire_holds()                             set search_path = public, extensions;
alter function box_reserve_order(text,text,text,text,text,text,jsonb,text,text,text)
                                                              set search_path = public, extensions;

-- Proof it worked: this must return 32 characters of 0-9 and a-f only.
select box_new_token() as new_token_should_be_hex;
