-- Stand-ins for a SCRATCH Postgres 16 so supabase/2026-11-06b-todos.sql can be
-- applied and tested without Supabase. Load tests/contracts/standins.sql first
-- (roles, auth.uid() reading t.uid, profiles, app_data). chk_my_role and
-- chk_person_label are copies of the live definitions (read 6 Nov 2026).

create or replace function public.chk_my_role() returns text language sql stable security definer
set search_path to 'public' as $function$
  select role from profiles where id = auth.uid() and active and role in ('admin', 'bar', 'cleaner');
$function$;

create or replace function public.chk_person_label(p_id uuid) returns text language sql stable security definer
set search_path to 'public' as $function$
  select coalesce((
    select case
      when p.role = 'bar' then 'Bar'
      when p.role = 'cleaner' then 'Housekeeping'
      else (
        with parts as (select regexp_split_to_array(trim(coalesce(p.name, '')), '\s+') a)
        select case
          when (select a[1] from parts) = '' then coalesce(nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'Someone')
          when coalesce((select a[2] from parts), '') <> '' and exists (
            select 1 from profiles q
             where q.id <> p.id and q.active and q.role = 'admin'
               and lower((regexp_split_to_array(trim(coalesce(q.name, '')), '\s+'))[1]) = lower((select a[1] from parts)))
            then (select a[1] from parts) || ' ' || upper(left((select a[2] from parts), 1))
          else (select a[1] from parts)
        end)
    end
    from profiles p where p.id = p_id), 'Someone');
$function$;
