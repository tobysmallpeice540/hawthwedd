-- supabase/2026-09-09-portal-admin-supplier-upsert.sql
--
-- Creating and editing a DIRECTORY supplier from the admin screen.
--
-- APPLIED TO PRODUCTION 9 September 2026 as migration
-- portal_admin_upsert_supplier. Assertions: portal-admin-supplier-test.sql — 7.
--
-- Directory rows only: passing the id of a supplier a couple invented is
-- refused, because editing it would change it under them. Promotion is the
-- separate, deliberate step (wp_admin_promote_supplier).

create or replace function public.wp_admin_upsert_supplier(
  p_id uuid default null,
  p_name text default null,
  p_category text default null,
  p_contact_name text default null,
  p_email text default null,
  p_phone text default null,
  p_website text default null,
  p_blurb text default null,
  p_pli_held boolean default null,
  p_pli_expires date default null,
  p_internal_note text default null,
  p_active boolean default null,
  p_public_listed boolean default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_id   uuid;
  v_owner integer;
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;

  if p_id is null then
    if length(v_name) = 0 then
      return jsonb_build_object('ok', false, 'error', 'no_name');
    end if;
    if not exists (select 1 from wp_supplier_categories where slug = p_category) then
      return jsonb_build_object('ok', false, 'error', 'bad_category');
    end if;

    insert into wp_suppliers
      (name, category, contact_name, email, phone, website, blurb,
       pli_held, pli_expires, internal_note, active, public_listed, created_by)
    values (left(v_name,120), p_category,
            left(nullif(trim(coalesce(p_contact_name,'')),''),120),
            left(nullif(trim(coalesce(p_email,'')),''),200),
            left(nullif(trim(coalesce(p_phone,'')),''),60),
            left(nullif(trim(coalesce(p_website,'')),''),300),
            left(nullif(trim(coalesce(p_blurb,'')),''),300),
            coalesce(p_pli_held, false), p_pli_expires,
            nullif(trim(coalesce(p_internal_note,'')),''),
            coalesce(p_active, true), coalesce(p_public_listed, false), auth.uid())
    returning id into v_id;

    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  -- Editing: directory rows only.
  select owner_event_id into v_owner from wp_suppliers where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_owner is not null then
    return jsonb_build_object('ok', false, 'error', 'belongs_to_a_couple');
  end if;
  if p_category is not null and not exists (select 1 from wp_supplier_categories where slug = p_category) then
    return jsonb_build_object('ok', false, 'error', 'bad_category');
  end if;

  update wp_suppliers
     set name          = coalesce(left(trim(p_name),120), name),
         category      = coalesce(p_category, category),
         contact_name  = coalesce(left(trim(p_contact_name),120), contact_name),
         email         = coalesce(left(trim(p_email),200), email),
         phone         = coalesce(left(trim(p_phone),60), phone),
         website       = coalesce(left(trim(p_website),300), website),
         blurb         = coalesce(left(trim(p_blurb),300), blurb),
         pli_held      = coalesce(p_pli_held, pli_held),
         pli_expires   = coalesce(p_pli_expires, pli_expires),
         internal_note = coalesce(nullif(trim(p_internal_note),''), internal_note),
         active        = coalesce(p_active, active),
         public_listed = coalesce(p_public_listed, public_listed)
   where id = p_id and owner_event_id is null;

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$function$;

revoke all on function public.wp_admin_upsert_supplier(uuid,text,text,text,text,text,text,text,boolean,date,text,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.wp_admin_upsert_supplier(uuid,text,text,text,text,text,text,text,boolean,date,text,boolean,boolean)
  to authenticated, service_role;
