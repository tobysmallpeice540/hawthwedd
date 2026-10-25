-- supabase/2026-10-25o-supplier-approval-test.sql
--
-- Assertions for 2026-10-25o-supplier-approval.sql. Run against a SCRATCH
-- database holding the supplier tables and the live bodies of the functions it
-- patches (the session that wrote this built one in a throwaway Postgres 16),
-- AFTER the migration. Each block raises on failure; all passing prints
-- "supplier approval: all assertions passed".
--
-- The scratch session settings stand in for the signed-in person:
--   t.role  = 'admin' | 'bar' | ''    (wp_is_admin / is_staff)
--   t.event = the couple's event      (wp_my_event_id)

do $t$
declare
  a uuid; b uuid; v jsonb; n int;
begin
  delete from wp_event_suppliers; delete from wp_suppliers;

  -- Couple 101 adds their own photographer; the venue has one of its own.
  insert into wp_suppliers (name, category, contact_name, owner_event_id) values ('Couple Snaps', 'other', 'Pat', 101) returning id into a;
  insert into wp_event_suppliers (event_id, supplier_id) values (101, a);
  insert into wp_suppliers (name, category) values ('Venue Flowers', 'flowers') returning id into b;

  -- 1. Before approval another couple cannot see or choose it.
  perform set_config('t.event', '202', true); perform set_config('t.role', '', true);
  v := wp_get_suppliers();
  if v->'directory' @> jsonb_build_array(jsonb_build_object('name', 'Couple Snaps')) then raise exception '1 private supplier shown to another couple'; end if;
  if not (v->'directory' @> jsonb_build_array(jsonb_build_object('name', 'Venue Flowers'))) then raise exception '1b venue supplier missing'; end if;
  if (wp_choose_supplier(a)->>'ok')::boolean then raise exception '1c another couple chose a private supplier'; end if;

  -- 2. Only an admin can review or approve; a bar login is staff but not admin.
  perform set_config('t.role', 'bar', true);
  if (wp_admin_review_supplier(a, 'photography')->>'ok')::boolean then raise exception '2 bar login reviewed'; end if;
  if (wp_admin_approve_supplier(a, true)->>'ok')::boolean then raise exception '2b bar login approved'; end if;

  -- 3. Review fixes the category and writes the blurb, on the couple's row,
  --    without touching their name or contact.
  perform set_config('t.role', 'admin', true);
  v := wp_admin_review_supplier(a, 'photography', '  Relaxed, documentary style  ', 'Ask about drone', true, '2027-03-31');
  if not (v->>'ok')::boolean then raise exception '3 review refused: %', v; end if;
  select count(*) into n from wp_suppliers where id = a and category = 'photography' and blurb = 'Relaxed, documentary style'
    and internal_note = 'Ask about drone' and pli_held and pli_expires = '2027-03-31' and name = 'Couple Snaps' and contact_name = 'Pat' and owner_event_id = 101;
  if n <> 1 then raise exception '3b review did not land as expected'; end if;
  if (wp_admin_review_supplier(a, 'nonsense')->>'ok')::boolean then raise exception '3c bad category accepted'; end if;
  -- null leaves alone, empty clears
  perform wp_admin_review_supplier(a, null, null, '');
  select count(*) into n from wp_suppliers where id = a and blurb = 'Relaxed, documentary style' and internal_note is null;
  if n <> 1 then raise exception '3d null/empty handling wrong'; end if;

  -- 4. Approving puts it in front of other couples and remembers its origin.
  v := wp_admin_approve_supplier(a, true);
  if not (v->>'ok')::boolean then raise exception '4 approve refused: %', v; end if;
  select count(*) into n from wp_suppliers where id = a and owner_event_id is null and promoted_from_event_id = 101 and promoted_at is not null;
  if n <> 1 then raise exception '4b approval did not move the row'; end if;
  perform set_config('t.event', '202', true);
  v := wp_get_suppliers();
  if not (v->'directory' @> jsonb_build_array(jsonb_build_object('name', 'Couple Snaps', 'blurb', 'Relaxed, documentary style'))) then raise exception '4c approved supplier not shown'; end if;
  -- the venue-only fields never reach a couple
  if (v->'directory'->0) ? 'internal_note' or (v->'directory'->0) ? 'pli_held' then raise exception '4d venue-only field leaked'; end if;
  v := wp_admin_suppliers();
  if not (v->'suppliers' @> jsonb_build_array(jsonb_build_object('name', 'Couple Snaps', 'promoted_from_event_id', 101))) then raise exception '4e staff list lacks the origin'; end if;

  -- 5. Unticking while only the original couple has it gives it back to them.
  v := wp_admin_approve_supplier(a, false);
  if v->>'mode' <> 'returned' then raise exception '5 expected returned, got %', v; end if;
  select count(*) into n from wp_suppliers where id = a and owner_event_id = 101 and promoted_from_event_id is null and active;
  if n <> 1 then raise exception '5b not returned to the couple'; end if;
  perform set_config('t.event', '202', true);
  if wp_get_suppliers()->'directory' @> jsonb_build_array(jsonb_build_object('name', 'Couple Snaps')) then raise exception '5c still shown after untick'; end if;

  -- 6. Approve again, couple 202 chooses it, then untick: withdrawn, not taken away.
  perform wp_admin_approve_supplier(a, true);
  if not (wp_choose_supplier(a)->>'ok')::boolean then raise exception '6 could not choose approved supplier'; end if;
  v := wp_admin_approve_supplier(a, false);
  if v->>'mode' <> 'withdrawn' or (v->>'kept_by')::int <> 1 then raise exception '6b expected withdrawn by 1, got %', v; end if;
  select count(*) into n from wp_event_suppliers where supplier_id = a;
  if n <> 2 then raise exception '6c a wedding lost its supplier'; end if;
  perform set_config('t.event', '303', true);
  if wp_get_suppliers()->'directory' @> jsonb_build_array(jsonb_build_object('name', 'Couple Snaps')) then raise exception '6d withdrawn supplier still offered'; end if;
  if (wp_choose_supplier(a)->>'ok')::boolean then raise exception '6e withdrawn supplier still choosable'; end if;
  -- and approving again restores it
  perform wp_admin_approve_supplier(a, true);
  if not (wp_get_suppliers()->'directory' @> jsonb_build_array(jsonb_build_object('name', 'Couple Snaps'))) then raise exception '6f re-approval did not restore'; end if;

  -- 7. A suppressed supplier cannot be approved; a venue supplier cannot be unticked.
  update wp_suppliers set suppressed_at = now(), owner_event_id = 101, promoted_from_event_id = null where id = a;
  if (wp_admin_approve_supplier(a, true)->>'ok')::boolean then raise exception '7 suppressed supplier approved'; end if;
  if (wp_admin_approve_supplier(b, false)->>'ok')::boolean then raise exception '7b venue supplier unticked'; end if;
  if (wp_admin_approve_supplier(b, true)->>'ok')::boolean then raise exception '7c venue supplier approved as if a couple''s'; end if;

  -- 8. The old promote button records where the row came from.
  update wp_suppliers set suppressed_at = null where id = a;
  perform wp_admin_promote_supplier(a);
  select count(*) into n from wp_suppliers where id = a and owner_event_id is null and promoted_from_event_id = 101;
  if n <> 1 then raise exception '8 old promote lost the origin'; end if;

  -- 9. Grants: nothing for anon; authenticated may call (the function checks).
  if has_function_privilege('anon', 'public.wp_admin_approve_supplier(uuid,boolean)', 'execute') then raise exception '9 anon can approve'; end if;
  if has_function_privilege('anon', 'public.wp_admin_review_supplier(uuid,text,text,text,boolean,date)', 'execute') then raise exception '9b anon can review'; end if;
  if not has_function_privilege('authenticated', 'public.wp_admin_approve_supplier(uuid,boolean)', 'execute') then raise exception '9c staff cannot approve'; end if;

  raise notice 'supplier approval: all assertions passed';
end
$t$;
