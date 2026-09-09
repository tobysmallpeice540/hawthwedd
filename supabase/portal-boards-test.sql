-- supabase/portal-boards-test.sql
--
-- Assertions for 2026-09-09-portal-boards-many.sql. Twelve.
--
-- ASSERTION 7 IS THE ONE TO READ. The farm's boards and a couple's live in the
-- same table, told apart only by event_id being NULL. wp_delete_board() deletes
--
--     where id = p_id and event_id = wp_my_event_id()
--
-- so a farm board is unreachable because NULL is never equal to anything — not
-- because anybody wrote a check. That is the right design and it reads as an
-- accident, which is exactly why it needs pinning: someone "tidying" that
-- clause into `event_id is not distinct from v_event` would hand every couple
-- a delete button on the farm's own boards.
--
-- Assertion 4 is the other one worth reading: staff click these links from the
-- admin side, so an unchecked address is a phishing page wearing the farm's
-- branding. The fourth case — pinterest.com.evil.example.com — is what a looser
-- pattern lets through.
--
-- Rolled back, so the two fake couples and every board they make are undone.
--
--     ERROR: ALL 12 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 12 passed.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; uX uuid := '00000000-0000-4000-8000-0000000000b1'; uY uuid := '00000000-0000-4000-8000-0000000000b2';
  evX int; evY int; bid uuid; venueBid uuid; i int;
begin
  select id into uAdmin from public.profiles where active and role='admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;
  select min((e->>'id')::int), max((e->>'id')::int) into evX, evY
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';

  insert into auth.users (id,instance_id,aud,role,email,created_at,updated_at) values
    (uX,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','bx@test.invalid',now(),now()),
    (uY,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','by@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uX,'bx@test.invalid','X','client',true),(uY,'by@test.invalid','Y','client',true)
  on conflict (id) do update set role='client', active=true;
  insert into public.wp_access (event_id,email,user_id) values (evX,'bx@test.invalid',uX),(evY,'by@test.invalid',uY);

  -- 1. The farm puts up a board
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  r := wp_admin_save_boards('[{"label":"The barn dressed","url":"https://www.pinterest.co.uk/hawthbush/barn/"}]'::jsonb);
  if (r->>'ok')::bool and (r->>'saved')::int = 1 then passes:=passes+1;
  else fails := fails || 'FAIL 1: the farm could not save a board'; end if;
  select id into venueBid from wp_boards where event_id is null limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','bx@test.invalid')::text, true);

  -- 2. A couple sees it without having added anything
  r := wp_get_boards();
  if (r->>'ok')::bool and jsonb_array_length(r->'venue') = 1 and jsonb_array_length(r->'mine') = 0
  then passes:=passes+1; else fails := fails || 'FAIL 2: the farm board did not reach the couple'; end if;

  -- 3. They can keep several of their own
  r := wp_add_board('Flowers', 'https://www.pinterest.co.uk/us/flowers/'); bid := (r->>'id')::uuid;
  r := wp_add_board('Tables',  'https://pinterest.com/us/tables/');
  r := wp_get_boards();
  if jsonb_array_length(r->'mine') = 2 and jsonb_array_length(r->'venue') = 1 then passes:=passes+1;
  else fails := fails || 'FAIL 3: could not keep more than one board'; end if;

  -- 4. ── READ THIS ONE ── anything that is not a Pinterest board is refused
  if (wp_add_board('Bad','https://evil.example.com/x') ->> 'error') = 'not_a_pinterest_link'
     and (wp_add_board('Bad','javascript:alert(1)') ->> 'error') = 'not_a_pinterest_link'
     and (wp_add_board('Bad','http://www.pinterest.com/x') ->> 'error') = 'not_a_pinterest_link'
     and (wp_add_board('Bad','https://pinterest.com.evil.example.com/x') ->> 'error') = 'not_a_pinterest_link'
  then passes:=passes+1; else fails := fails || 'FAIL 4: a non-Pinterest link was accepted'; end if;

  -- 5. Eight is the cap and it holds
  for i in 1..10 loop perform wp_add_board('B'||i, 'https://www.pinterest.co.uk/us/b'||i||'/'); end loop;
  if (select count(*) from wp_boards where event_id = evX) = 8 then passes:=passes+1;
  else fails := fails || ('FAIL 5: the cap did not hold, got ' ||
        (select count(*) from wp_boards where event_id = evX)); end if;

  -- 6. They can remove their own
  r := wp_delete_board(bid);
  if (r->>'ok')::bool and (select count(*) from wp_boards where id = bid) = 0 then passes:=passes+1;
  else fails := fails || 'FAIL 6: could not remove their own board'; end if;

  -- 7. ── THE ONE THAT MATTERS ── they cannot remove the FARM's, which they can
  --    see. NULL event_id is never equal to v_event, and that is the whole
  --    mechanism. Do not "tidy" that clause.
  r := wp_delete_board(venueBid);
  if not (r->>'ok')::bool and r->>'error' = 'not_found'
     and (select count(*) from wp_boards where id = venueBid) = 1 then passes:=passes+1;
  else fails := fails || 'FAIL 7: a couple deleted the farm''s board'; end if;

  -- 8. ...nor another wedding's
  perform set_config('request.jwt.claims', json_build_object('sub',uY,'email','by@test.invalid')::text, true);
  r := wp_add_board('Theirs','https://www.pinterest.co.uk/them/x/');
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','bx@test.invalid')::text, true);
  if (wp_delete_board((r->>'id')::uuid) ->> 'error') = 'not_found' then passes:=passes+1;
  else fails := fails || 'FAIL 8: deleted another wedding''s board'; end if;

  -- 9. ...and never sees it
  r := wp_get_boards();
  if not (r->'mine')::text like '%Theirs%' then passes:=passes+1;
  else fails := fails || 'FAIL 9: another wedding''s board leaked'; end if;

  -- 10. A couple cannot reach the farm's list at all
  if (wp_admin_boards() ->> 'error') = 'not_staff'
     and (wp_admin_save_boards('[]'::jsonb) ->> 'error') = 'not_staff'
  then passes:=passes+1; else fails := fails || 'FAIL 10: a client reached the farm''s boards'; end if;

  -- 11. One bad address rejects the whole batch, and rejects it BEFORE the
  --     delete — otherwise a typo would leave the farm with no boards at all.
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  r := wp_admin_save_boards('[{"label":"ok","url":"https://www.pinterest.co.uk/a/"},{"label":"bad","url":"https://evil.example.com"}]'::jsonb);
  if not (r->>'ok')::bool and r->>'error' = 'not_a_pinterest_link'
     and (select count(*) from wp_boards where event_id is null) = 1 then passes:=passes+1;
  else fails := fails || 'FAIL 11: a bad batch emptied the farm''s boards'; end if;

  perform set_config('request.jwt.claims', null, true);

  -- 12. Grant surface, and the single-board pair really is gone
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('wp_get_boards','wp_add_board','wp_delete_board',
                                                  'wp_admin_boards','wp_admin_save_boards','wp_is_board_url')
         and has_function_privilege('anon', p.oid, 'execute')) = 0
     and (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname in ('wp_get_pinterest','wp_set_pinterest')) = 0
  then passes:=passes+1; else fails := fails || 'FAIL 12: grant surface or leftovers'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── Checking this file against the live catalogue ───────────────────────────
-- Compare the BODY, not pg_get_functiondef. Bodies on 9 September 2026:
--   wp_is_board_url       d88f27b66e3b97cba03b8a531c517ca2    87
--   wp_get_boards         41447cf682a2a524b1b1d91a9b9976a0   567
--   wp_add_board          1e9ee024a8da7f410c4d4947214b9952  1003
--   wp_delete_board       47bafd28251387196109ab9d6103f28a   388
--   wp_admin_boards       47ef2d1a937311b7b2ef1d86a705f8e8   331
--   wp_admin_save_boards  4ffcfb521f2b3b8e3fae1c0f1d6f3a85  1092

select p.proname,
       md5(trim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) as body_md5,
       has_function_privilege('anon', p.oid, 'execute') as anon_expected_false
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'wp\_%board%'
order by p.proname;
