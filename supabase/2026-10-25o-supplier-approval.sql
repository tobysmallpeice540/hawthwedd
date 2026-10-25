-- supabase/2026-10-25o-supplier-approval.sql
--
-- A COUPLE'S SUPPLIER IS SHOWN TO OTHER COUPLES ONLY ONCE IT IS APPROVED.
--
-- NOT YET APPLIED (25 Oct 2026). Paste the whole file into the Supabase SQL
-- editor and run it. Safe to run twice. Tested against the live bodies of the
-- two functions it patches: 2026-10-25o-supplier-approval-test.sql, all passing.
-- The staff app works before it is applied (the tick says it is needed).
--
-- That was already the rule underneath: a supplier a couple adds is owned by
-- their event (owner_event_id), wp_get_suppliers lists only rows with no owner
-- to anybody else, and the one way out of private was a member of staff
-- pressing "Add to directory" (wp_admin_promote_supplier). This migration
-- makes that step a reviewable, reversible tick:
--
--   · wp_admin_review_supplier — before approving, staff can correct the
--     category and write the line other couples will read (blurb), plus the
--     venue's own note and insurance. It works on a couple's row, which
--     wp_admin_upsert_supplier deliberately refuses; it does NOT touch name or
--     contact details, which are the couple's own words.
--   · wp_admin_approve_supplier(id, true) — "Approved for sharing". Moves the
--     row into the directory as promotion always has, and now remembers which
--     wedding it came from (promoted_from_event_id), so the venue list of
--     couples' suppliers keeps showing it, ticked.
--   · wp_admin_approve_supplier(id, false) — untick. If no other wedding has
--     chosen it, it goes back to being that couple's own (they can edit it
--     again). If others have, it is withdrawn from the list (active = false):
--     the weddings that chose it keep it, nobody new can.
--   · wp_admin_promote_supplier — the old button, still called by any tab on
--     a build before 2026-10-25i — now records promoted_from_event_id too.
--   · wp_admin_suppliers — also returns promoted_from_event_id and promoted_at.
--
-- Admin only (wp_is_admin), not is_staff: what other couples are recommended
-- is the venue's judgement, and bar and housekeeping logins are staff.
--
-- Patches to live functions are made IN PLACE from the catalogue, each anchor
-- asserted exactly once, each skipping if already applied.

begin;

alter table public.wp_suppliers add column if not exists promoted_from_event_id integer;

-- ── Review: category and the line other couples see ────────────────────────
-- NULL leaves a field alone. An empty string clears blurb / internal note.
create or replace function public.wp_admin_review_supplier(
  p_id uuid, p_category text default null, p_blurb text default null,
  p_internal_note text default null, p_pli_held boolean default null, p_pli_expires date default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_category is not null and not exists (select 1 from wp_supplier_categories where slug = p_category) then
    return jsonb_build_object('ok', false, 'error', 'bad_category');
  end if;

  update wp_suppliers
     set category      = coalesce(p_category, category),
         blurb         = case when p_blurb is null then blurb
                              else left(nullif(trim(p_blurb), ''), 300) end,
         internal_note = case when p_internal_note is null then internal_note
                              else nullif(trim(p_internal_note), '') end,
         pli_held      = coalesce(p_pli_held, pli_held),
         pli_expires   = case when p_pli_held = false then null else coalesce(p_pli_expires, pli_expires) end
   where id = p_id;

  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('admin', 'reviewed a supplier');
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Approved for sharing: the tick, both ways ──────────────────────────────
create or replace function public.wp_admin_approve_supplier(p_id uuid, p_approve boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  r wp_suppliers%rowtype;
  v_from integer;
  v_others integer;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;

  -- Locked for the length of the call, so a couple choosing it meanwhile
  -- waits and then sees the row as it is left.
  select * into r from wp_suppliers where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if coalesce(p_approve, true) then
    if r.suppressed_at is not null then
      return jsonb_build_object('ok', false, 'error', 'suppressed');
    end if;
    if r.owner_event_id is not null then
      update wp_suppliers
         set promoted_from_event_id = owner_event_id, owner_event_id = null,
             promoted_at = now(), active = true
       where id = p_id;
    elsif r.promoted_from_event_id is not null then
      -- Withdrawn earlier while others had it; approving again puts it back.
      update wp_suppliers set active = true, promoted_at = coalesce(promoted_at, now()) where id = p_id;
    else
      return jsonb_build_object('ok', false, 'error', 'already_directory');
    end if;
    perform wp_log('admin', 'approved a supplier for sharing: ' || left(r.name, 80));
    return jsonb_build_object('ok', true, 'approved', true);
  end if;

  -- Unticking. Only a row that came from a couple can be unticked here; the
  -- venue's own suppliers are switched off with Active, not this.
  v_from := r.promoted_from_event_id;
  if v_from is null then
    if r.owner_event_id is not null then return jsonb_build_object('ok', true, 'approved', false); end if;
    return jsonb_build_object('ok', false, 'error', 'not_from_a_couple');
  end if;

  select count(*) into v_others
    from wp_event_suppliers es where es.supplier_id = p_id and es.event_id <> v_from;

  if v_others = 0 then
    update wp_suppliers
       set owner_event_id = v_from, promoted_from_event_id = null, promoted_at = null, active = true
     where id = p_id;
    perform wp_log('admin', 'withdrew a supplier from sharing: ' || left(r.name, 80));
    return jsonb_build_object('ok', true, 'approved', false, 'mode', 'returned');
  end if;

  update wp_suppliers set active = false, promoted_at = null where id = p_id;
  perform wp_log('admin', 'withdrew a supplier from sharing (kept by ' || v_others || ' other weddings): ' || left(r.name, 80));
  return jsonb_build_object('ok', true, 'approved', false, 'mode', 'withdrawn', 'kept_by', v_others);
end;
$function$;

-- ── The old promote button records where the row came from ─────────────────
do $patch$
declare
  def text; hits int;
  a text := $x$set owner_event_id = null, promoted_at = now(), active = true$x$;
  r text := $x$set promoted_from_event_id = owner_event_id, owner_event_id = null, promoted_at = now(), active = true$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_admin_promote_supplier';
  if def is null then raise exception 'wp_admin_promote_supplier() not found'; end if;
  if position('promoted_from_event_id' in def) > 0 then
    raise notice 'wp_admin_promote_supplier() already records the source - skipped'; return;
  end if;
  hits := (length(def) - length(replace(def, a, ''))) / length(a);
  if hits <> 1 then raise exception 'promote anchor found % times - not patching', hits; end if;
  execute replace(def, a, r);
  raise notice 'wp_admin_promote_supplier() patched: records promoted_from_event_id';
end
$patch$;

-- ── The staff list says where each one came from ───────────────────────────
do $patch2$
declare
  def text; hits int;
  a text := $x$'suppressed_at', s.suppressed_at,$x$;
  r text := $x$'suppressed_at', s.suppressed_at,
               'promoted_from_event_id', s.promoted_from_event_id,
               'promoted_at', s.promoted_at,$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_admin_suppliers';
  if def is null then raise exception 'wp_admin_suppliers() not found'; end if;
  if position('promoted_from_event_id' in def) > 0 then
    raise notice 'wp_admin_suppliers() already returns the source - skipped'; return;
  end if;
  hits := (length(def) - length(replace(def, a, ''))) / length(a);
  if hits <> 1 then raise exception 'admin list anchor found % times - not patching', hits; end if;
  execute replace(def, a, r);
  raise notice 'wp_admin_suppliers() patched: returns promoted_from_event_id, promoted_at';
end
$patch2$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'public.wp_admin_review_supplier(uuid,text,text,text,boolean,date)',
    'public.wp_admin_approve_supplier(uuid,boolean)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $grants$;

commit;
