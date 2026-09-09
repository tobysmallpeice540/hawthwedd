-- supabase/2026-09-09-portal-supplier-suppress.sql
--
-- APPLIED 9 September 2026 as migration portal_supplier_suppress_and_counts.
-- Assertions: portal-supplier-suppress-test.sql — 9, all passing.
--
-- ── SUPPRESSING IS NOT DELETING, and the distinction is the whole feature ───
--
-- A couple adds a supplier. It is theirs, and it stays theirs whatever
-- Hawthbush thinks of them. Suppressing says one thing only: "never suggest
-- these to anybody else."
--
-- So it:
--   · drops the supplier out of the recommended list couples browse,
--   · UNDOES a promotion, because a supplier promoted last month would
--     otherwise sit in that list wearing a Suppressed tick,
--   · clears the offer, so the same firm stops reappearing in the queue every
--     time another couple offers them.
--
-- And it does NOT:
--   · remove them from the wedding that added them,
--   · tell that couple anything at all.
--
-- That last point is deliberate and is assertions 4 and 5. This is Hawthbush's
-- judgement about its own recommendations, not a verdict to be delivered to a
-- customer about a supplier they have already booked. The word "suppress" never
-- reaches the portal bundle.
--
-- ── HOW MANY WEDDINGS HAVE USED EACH ONE ───────────────────────────────────
--
-- Already returned to staff; now to couples as well. It is the single most
-- useful line on that list — "eleven weddings here have used them" beats any
-- blurb anybody could write — and it is an aggregate that says nothing about
-- any individual wedding, which is why it is allowed through a payload that
-- otherwise deliberately withholds insurance status and internal notes.
--
-- All three readers are patched IN PLACE from the catalogue, each anchor
-- asserted exactly once, each patch skipping if already applied.

begin;

alter table public.wp_suppliers add column if not exists suppressed_at timestamptz;

create or replace function public.wp_admin_suppress_supplier(p_id uuid, p_suppress boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_on boolean := coalesce(p_suppress, true);
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;

  update wp_suppliers
     set suppressed_at  = case when v_on then now() else null end,
         -- Suppressing has to undo a promotion, or a supplier promoted last
         -- month would sit in the recommended list wearing a Suppressed tick.
         public_listed  = case when v_on then false else public_listed end,
         promoted_at    = case when v_on then null  else promoted_at end,
         -- And it clears the offer, so it stops reappearing in the queue.
         share_offered_at = case when v_on then null else share_offered_at end
   where id = p_id;

  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('admin', case when v_on then 'suppressed a supplier' else 'un-suppressed a supplier' end);
  return jsonb_build_object('ok', true);
end;
$function$;

do $patch$
declare
  def text; hits int;
  a text := $x$       where s.owner_event_id is null and s.active), '[]'::jsonb),$x$;
  r text := $x$       where s.owner_event_id is null and s.active and s.suppressed_at is null), '[]'::jsonb),$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_get_suppliers';
  if def is null then raise exception 'wp_get_suppliers() not found'; end if;
  if position('suppressed_at' in def) > 0 then
    raise notice 'wp_get_suppliers() already drops suppressed suppliers - skipped'; return;
  end if;
  hits := (length(def) - length(replace(def, a, ''))) / length(a);
  if hits <> 1 then raise exception 'directory anchor found % times - not patching', hits; end if;
  execute replace(def, a, r);
  raise notice 'wp_get_suppliers() patched: the directory drops suppressed suppliers';
end
$patch$;

do $patch2$
declare
  def text; hits int;
  a text := $x$               'website', s.website, 'blurb', s.blurb)
             order by s.category, s.name)$x$;
  r text := $x$               'website', s.website, 'blurb', s.blurb,
               'used_by', (select count(*) from wp_event_suppliers es where es.supplier_id = s.id))
             order by s.category, s.name)$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_get_suppliers';
  if def is null then raise exception 'wp_get_suppliers() not found'; end if;
  if position('used_by' in def) > 0 then
    raise notice 'wp_get_suppliers() already reports use - skipped'; return;
  end if;
  hits := (length(def) - length(replace(def, a, ''))) / length(a);
  if hits <> 1 then raise exception 'blurb anchor found % times - not patching', hits; end if;
  execute replace(def, a, r);
  raise notice 'wp_get_suppliers() patched: the directory reports how often each is used';
end
$patch2$;

do $patch3$
declare
  def text; hits int;
  a text := $x$               'share_offered_at', s.share_offered_at,$x$;
  r text := $x$               'share_offered_at', s.share_offered_at,
               'suppressed_at', s.suppressed_at,$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_admin_suppliers';
  if def is null then raise exception 'wp_admin_suppliers() not found'; end if;
  if position('suppressed_at' in def) > 0 then
    raise notice 'wp_admin_suppliers() already reports suppression - skipped'; return;
  end if;
  hits := (length(def) - length(replace(def, a, ''))) / length(a);
  if hits <> 1 then raise exception 'share_offered_at anchor found % times - not patching', hits; end if;
  execute replace(def, a, r);
  raise notice 'wp_admin_suppliers() patched: reports suppression';
end
$patch3$;

revoke all on function public.wp_admin_suppress_supplier(uuid, boolean) from public, anon, authenticated;
grant execute on function public.wp_admin_suppress_supplier(uuid, boolean) to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop function if exists public.wp_admin_suppress_supplier(uuid, boolean);
-- The column can stay: it is additive, and while wp_get_suppliers() still reads
-- it, dropping it would break the directory.
