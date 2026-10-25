-- supabase/2026-10-25r-airbnb-once.sql
--
-- The same Airbnb email read twice is stored once (25 Oct 2026).
--
-- The Airbnb emails are moving from Toby's own Gmail to hawthbushfarm@gmail.com
-- by a forwarding filter. While the switch happens, an email can sit in both
-- mailboxes and be read from each, under two different Gmail ids — so the
-- Gmail id can no longer be what makes a row unique:
--
--   · a payout line is now unique by Airbnb's own payout reference and the
--     confirmation code (payout_id, from "Payout ID M-…" in the email); read
--     twice it would otherwise double the money paid.
--   · a message is skipped when the same author said the same thing on the same
--     thread (or request) within two days; read twice it would otherwise show
--     twice in the chat.
--
-- airbnb_ingest is patched in place from the live catalogue, each anchor
-- asserted once. CREATE OR REPLACE keeps its grants. Safe to run twice.

begin;

create or replace function pg_temp.patch_fn(p_sig regprocedure, p_find text, p_repl text)
returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_sig); n integer;
begin
  -- Pasted into the SQL editor this file can arrive with Windows line endings
  -- while the live function has plain ones. Compare and write without the \r.
  p_find := replace(p_find, chr(13), '');
  p_repl := replace(p_repl, chr(13), '');
  if position(p_repl in d) > 0 then
    raise notice 'patch of % already applied — skipped', p_sig;
    return;
  end if;
  n := (length(d) - length(replace(d, p_find, ''))) / length(p_find);
  if n <> 1 then
    raise exception 'patch of % expected the anchor exactly once, found % times: %', p_sig, n, p_find;
  end if;
  execute replace(d, p_find, p_repl);
end $$;

alter table public.airbnb_payouts add column if not exists payout_id text;
create unique index if not exists airbnb_payouts_once on public.airbnb_payouts (code, payout_id) where payout_id is not null;

select pg_temp.patch_fn('public.airbnb_ingest(jsonb)'::regprocedure,
  $f$    insert into airbnb_payouts (gmail_id, code, amount, sent_on)
    values (r->>'gmail_id', r->>'code', (r->>'amount')::numeric, nullif(r->>'sent_on', '')::date)
    on conflict do nothing;$f$,
  $r$    -- Unique by gmail id, and by Airbnb's payout reference when the email has one.
    insert into airbnb_payouts (gmail_id, code, amount, sent_on, payout_id)
    values (r->>'gmail_id', r->>'code', (r->>'amount')::numeric, nullif(r->>'sent_on', '')::date, nullif(r->>'payout_id', ''))
    on conflict do nothing;$r$);

select pg_temp.patch_fn('public.airbnb_ingest(jsonb)'::regprocedure,
  $f$    insert into airbnb_messages (gmail_id, idx, thread_id, code, kind, sent_at, direction, author, role, body)
    values (r->>'gmail_id', (r->>'idx')::int, nullif(r->>'thread_id', ''), nullif(r->>'code', ''), r->>'kind',
            nullif(r->>'sent_at', '')::timestamptz, r->>'direction', left(r->>'author', 120), left(r->>'role', 40),
            left(r->>'body', 20000))
    on conflict do nothing;$f$,
  $r$    -- The same words from the same person on the same thread within two
    -- days are the same message, read from a second mailbox.
    insert into airbnb_messages (gmail_id, idx, thread_id, code, kind, sent_at, direction, author, role, body)
    select r->>'gmail_id', (r->>'idx')::int, nullif(r->>'thread_id', ''), nullif(r->>'code', ''), r->>'kind',
           nullif(r->>'sent_at', '')::timestamptz, r->>'direction', left(r->>'author', 120), left(r->>'role', 40),
           left(r->>'body', 20000)
     where not exists (
       select 1 from airbnb_messages x
        where x.thread_id is not distinct from nullif(r->>'thread_id', '')
          and x.code is not distinct from nullif(r->>'code', '')
          and x.direction = r->>'direction' and x.author = left(r->>'author', 120)
          and x.body = left(r->>'body', 20000)
          and x.gmail_id <> r->>'gmail_id'
          and abs(extract(epoch from (x.sent_at - nullif(r->>'sent_at', '')::timestamptz))) < 2 * 86400)
    on conflict do nothing;$r$);

do $check$
begin
  if has_function_privilege('authenticated', 'public.airbnb_ingest(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.airbnb_ingest(jsonb)', 'execute') then
    raise exception 'airbnb_ingest is open to a client';
  end if;
  if position('payout_id' in pg_get_functiondef('public.airbnb_ingest(jsonb)'::regprocedure)) = 0 then
    raise exception 'airbnb_ingest was not patched';
  end if;
end $check$;

commit;
