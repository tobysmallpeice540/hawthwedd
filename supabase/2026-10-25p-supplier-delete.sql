-- supabase/2026-10-25p-supplier-delete.sql
--
-- Deleting a supplier from the venue's directory.
--
-- NOT YET APPLIED (25 Oct 2026). Until it is, Delete on the Supplier directory
-- says this change is needed; Edit and Suppress work without it.
-- Assertions: 2026-10-25p-supplier-delete-test.sql, all passing on a scratch copy.
--
-- Only a supplier NO wedding has chosen and no timeline line names can be
-- deleted. The foreign keys would otherwise do something nobody asked for:
-- wp_event_suppliers cascades (the supplier silently vanishes from couples'
-- lists) and wp_timeline sets null (a line loses who it was). A supplier in
-- use is Suppressed instead — kept, never offered again — and the refusal
-- says how many weddings have them so the screen can say so.
--
-- Only the venue's own (owner_event_id is null). A couple's own supplier is
-- theirs; it leaves when they remove it (wp_unchoose_supplier).
--
-- Admin only (wp_is_admin). Revoked from public, anon and authenticated, then
-- granted back to authenticated (the function checks) and service_role.

begin;

create or replace function public.wp_admin_delete_supplier(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  r wp_suppliers%rowtype;
  v_used integer;
  v_lines integer;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;

  -- Locked, so a couple cannot choose it between the check and the delete.
  select * into r from wp_suppliers where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if r.owner_event_id is not null then
    return jsonb_build_object('ok', false, 'error', 'belongs_to_a_couple');
  end if;

  select count(*) into v_used  from wp_event_suppliers where supplier_id = p_id;
  select count(*) into v_lines from wp_timeline where supplier_id = p_id;
  if v_used > 0 or v_lines > 0 then
    return jsonb_build_object('ok', false, 'error', 'in_use', 'used_by', v_used, 'timeline_lines', v_lines);
  end if;

  delete from wp_suppliers where id = p_id;
  perform wp_log('admin', 'deleted a supplier: ' || left(r.name, 80));
  return jsonb_build_object('ok', true);
end;
$function$;

do $grants$
begin
  revoke all on function public.wp_admin_delete_supplier(uuid) from public, anon, authenticated;
  grant execute on function public.wp_admin_delete_supplier(uuid) to authenticated, service_role;
end $grants$;

commit;
