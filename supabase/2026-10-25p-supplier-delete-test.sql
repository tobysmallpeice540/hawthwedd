-- supabase/2026-10-25p-supplier-delete-test.sql
--
-- Assertions for 2026-10-25p-supplier-delete.sql, run against a SCRATCH
-- database (supplier tables, wp_timeline, and the stubs used by
-- 2026-10-25o-supplier-approval-test.sql) after the migration.
-- t.role = 'admin' | 'bar' | '' stands in for the signed-in person.

do $t$
declare a uuid; b uuid; c uuid; d uuid; v jsonb; n int;
begin
  delete from wp_timeline; delete from wp_event_suppliers; delete from wp_suppliers;
  insert into wp_suppliers (name, category) values ('Unused Florist', 'flowers') returning id into a;
  insert into wp_suppliers (name, category) values ('Chosen Caterer', 'catering') returning id into b;
  insert into wp_event_suppliers (event_id, supplier_id) values (101, b);
  insert into wp_suppliers (name, category) values ('Timeline Band', 'other') returning id into c;
  insert into wp_timeline (event_id, supplier_id) values (101, c);
  insert into wp_suppliers (name, category, owner_event_id) values ('Couple Own', 'other', 101) returning id into d;

  -- 1. Not admin: refused, nothing gone.
  perform set_config('t.role', 'bar', true);
  if (wp_admin_delete_supplier(a)->>'ok')::boolean then raise exception '1 bar login deleted'; end if;
  perform set_config('t.role', 'admin', true);

  -- 2. Chosen by a wedding: refused, with the count; the couple keeps them.
  v := wp_admin_delete_supplier(b);
  if (v->>'ok')::boolean or v->>'error' <> 'in_use' or (v->>'used_by')::int <> 1 then raise exception '2 in-use delete: %', v; end if;
  select count(*) into n from wp_event_suppliers where supplier_id = b;
  if n <> 1 then raise exception '2b a wedding lost its supplier'; end if;

  -- 3. Named on a timeline: refused.
  v := wp_admin_delete_supplier(c);
  if (v->>'ok')::boolean or (v->>'timeline_lines')::int <> 1 then raise exception '3 timeline delete: %', v; end if;

  -- 4. A couple's own: refused.
  if (wp_admin_delete_supplier(d)->>'ok')::boolean then raise exception '4 deleted a couple''s supplier'; end if;

  -- 5. Unused venue supplier: gone.
  if not (wp_admin_delete_supplier(a)->>'ok')::boolean then raise exception '5 unused delete refused'; end if;
  select count(*) into n from wp_suppliers where id = a;
  if n <> 0 then raise exception '5b still there'; end if;
  if (wp_admin_delete_supplier(a)->>'error') <> 'not_found' then raise exception '5c second delete not not_found'; end if;

  -- 6. Grants.
  if has_function_privilege('anon', 'public.wp_admin_delete_supplier(uuid)', 'execute') then raise exception '6 anon can delete'; end if;
  if not has_function_privilege('authenticated', 'public.wp_admin_delete_supplier(uuid)', 'execute') then raise exception '6b staff cannot delete'; end if;

  raise notice 'supplier delete: all assertions passed';
end
$t$;
