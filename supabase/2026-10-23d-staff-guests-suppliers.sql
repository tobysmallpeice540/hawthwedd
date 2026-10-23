-- supabase/2026-10-23d-staff-guests-suppliers.sql
--
-- The event form's Guests and Vendors & Logistics sections now show what the
-- client portal holds, instead of the diary's own text fields. Four staff
-- functions make that possible. Nothing here changes a client function.
--
--   wp_admin_guests(event)        the guest list, numbers and tables — ADMIN
--                                 only: access and dietary notes are about
--                                 guests' health, and bar/cleaning logins
--                                 have no need of them.
--   wp_admin_event_suppliers(ev)  the suppliers the client has chosen.
--   wp_admin_set_numbers(...)     staff set the numbers (taken by phone, say).
--                                 Logged to the change log directly — wp_log()
--                                 finds the event from the caller, and a member
--                                 of staff is nobody's client.
--   wp_admin_all_numbers()        seated and evening totals for every event
--                                 that has given them, for the events list.
--
-- The diary's old fields (mealGuests, caterers, band…) are left exactly as
-- they are. The form shows them read-only as "from before the portal"; the
-- events list and calendar feed fall back to them only where the portal has
-- no numbers.
--
-- House rules: SECURITY DEFINER, gated inside on is_staff() (and an admin
-- check where said), EXECUTE revoked from public, anon and authenticated by
-- name and granted back to authenticated and service_role.

begin;

create or replace function public.wp_is_admin()
returns boolean language sql stable security definer set search_path to 'public', 'extensions' as $function$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$function$;

create or replace function public.wp_admin_guests(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare
  n wp_guest_numbers%rowtype;
  v_seated integer;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into n from wp_guest_numbers where event_id = p_event_id;
  v_seated := coalesce(n.seated_adults, 0) + coalesce(n.seated_children, 0) + coalesce(n.seated_babies, 0);
  return jsonb_build_object(
    'ok', true,
    'numbers', jsonb_build_object(
      'told_us', n.event_id is not null,
      'seated_adults', n.seated_adults, 'seated_children', n.seated_children,
      'seated_babies', n.seated_babies, 'evening_extras', n.evening_extras,
      'seated_total', case when n.event_id is null then null else v_seated end,
      'evening_total', case when n.event_id is null then null else v_seated + coalesce(n.evening_extras, 0) end,
      'updated_at', n.updated_at),
    'guests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'list', g.list, 'first_name', g.first_name, 'last_name', g.last_name,
               'side', g.side, 'age_band', g.age_band, 'staying', g.staying, 'staying_where', g.staying_where,
               'access_needs', g.access_needs, 'rsvp', g.rsvp, 'role', g.role,
               'table_label', (select t.label from wp_layout_tables t where t.id = g.table_id))
             order by (g.list = 'evening'), g.last_name, g.first_name)
        from wp_guests g where g.event_id = p_event_id), '[]'::jsonb),
    'tables', (select count(*) from wp_layout_tables t where t.event_id = p_event_id)
  );
end $function$;

create or replace function public.wp_admin_event_suppliers(p_event_id integer)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'categories', coalesce((select jsonb_object_agg(c.slug, c.label) from wp_supplier_categories c), '{}'::jsonb),
    'chosen', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', es.id, 'name', s.name, 'category', s.category,
               'contact_name', s.contact_name, 'email', s.email, 'phone', s.phone,
               'website', s.website, 'notes', es.notes,
               'from_directory', s.owner_event_id is null,
               'pli_held', s.pli_held, 'pli_expires', s.pli_expires)
             order by s.category, s.name)
        from wp_event_suppliers es join wp_suppliers s on s.id = es.supplier_id
       where es.event_id = p_event_id), '[]'::jsonb));
end $function$;

create or replace function public.wp_admin_set_numbers(p_event_id integer, p_seated_adults integer,
    p_seated_children integer, p_seated_babies integer, p_evening_extras integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if not exists (select 1 from app_data d, lateral jsonb_array_elements(d.value) e
                  where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event_id) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if coalesce(p_seated_adults, 0) < 0 or coalesce(p_seated_children, 0) < 0
     or coalesce(p_seated_babies, 0) < 0 or coalesce(p_evening_extras, 0) < 0 then
    return jsonb_build_object('ok', false, 'error', 'negative');
  end if;
  if greatest(coalesce(p_seated_adults,0), coalesce(p_seated_children,0),
              coalesce(p_seated_babies,0), coalesce(p_evening_extras,0)) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'implausible');
  end if;
  insert into wp_guest_numbers as n
    (event_id, seated_adults, seated_children, seated_babies, evening_extras, updated_by)
  values (p_event_id, p_seated_adults, p_seated_children, p_seated_babies, p_evening_extras, auth.uid())
  on conflict (event_id) do update
    set seated_adults = excluded.seated_adults, seated_children = excluded.seated_children,
        seated_babies = excluded.seated_babies, evening_extras = excluded.evening_extras,
        updated_at = now(), updated_by = auth.uid();
  insert into wp_change_log (event_id, actor_email, actor_user, area, summary)
  values (p_event_id, lower(coalesce(auth.jwt() ->> 'email', '')), auth.uid(), 'guests',
          format('venue set numbers: %s adults, %s children, %s babies, %s evening extras',
            coalesce(p_seated_adults::text,'-'), coalesce(p_seated_children::text,'-'),
            coalesce(p_seated_babies::text,'-'), coalesce(p_evening_extras::text,'-')));
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.wp_admin_all_numbers()
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'numbers', coalesce((
    select jsonb_object_agg(n.event_id::text, jsonb_build_object(
             'seated', coalesce(n.seated_adults,0) + coalesce(n.seated_children,0) + coalesce(n.seated_babies,0),
             'evening', coalesce(n.seated_adults,0) + coalesce(n.seated_children,0) + coalesce(n.seated_babies,0)
                        + coalesce(n.evening_extras,0)))
      from wp_guest_numbers n), '{}'::jsonb));
end $function$;

do $grants$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'public' and p.proname in
              ('wp_is_admin', 'wp_admin_guests', 'wp_admin_event_suppliers', 'wp_admin_set_numbers', 'wp_admin_all_numbers')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = 'wp_is_admin' then
      execute format('grant execute on function %s to service_role', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $grants$;

commit;
