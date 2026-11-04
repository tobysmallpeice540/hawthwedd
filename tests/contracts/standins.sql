-- Stand-ins for a SCRATCH Postgres 16 so supabase/2026-11-04a-contracts.sql can
-- be applied and tested without Supabase. auth.uid() / auth.jwt() read the
-- session settings t.uid and t.email. wp_is_admin, wp_my_event_id and
-- wp_grant_access are copies of the live definitions (read 4 Nov 2026).
do $$ begin
  begin create role anon nologin; exception when duplicate_object then null; end;
  begin create role authenticated nologin; exception when duplicate_object then null; end;
  begin create role service_role nologin; exception when duplicate_object then null; end;
end $$;
create schema if not exists extensions;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('t.uid', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as
  $$ select jsonb_build_object('email', nullif(current_setting('t.email', true), '')) $$;

create table if not exists public.profiles (id uuid primary key, name text, email text, role text, active boolean default true, mobile text);
create table if not exists public.app_data (key text primary key, value jsonb, updated_at timestamptz default now());
create table if not exists public.wp_access (
  id uuid primary key default gen_random_uuid(), event_id integer not null, email text not null, user_id uuid,
  invited_at timestamptz default now(), invited_by uuid, first_seen_at timestamptz, last_seen_at timestamptz,
  revoked_at timestamptz, last_link_sent_at timestamptz, marketing_ok boolean, marketing_changed_at timestamptz,
  unique (event_id, email));
create table if not exists public.wp_change_log (id bigserial primary key, event_id integer, actor_email text, actor_user uuid, area text, summary text, at timestamptz default now());

create or replace function public.wp_is_admin() returns boolean language sql stable security definer
set search_path to 'public', 'extensions' as
$$ select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin'); $$;

create or replace function public.wp_my_event_id() returns integer language sql stable security definer
set search_path to 'public', 'extensions' as $$
  select a.event_id from wp_access a
   where a.revoked_at is null
     and (a.user_id = auth.uid() or a.email = lower(coalesce(auth.jwt() ->> 'email', '~none~')))
   order by a.user_id nulls last limit 1; $$;

create or replace function public.wp_grant_access(p_event_id integer, p_email text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id    uuid;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then return jsonb_build_object('ok', false, 'error', 'bad_email'); end if;
  if not exists (select 1 from app_data d, lateral jsonb_array_elements(d.value) e
     where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = p_event_id) then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;
  insert into wp_access (event_id, email, invited_by) values (p_event_id, v_email, auth.uid())
  on conflict (event_id, email) do update set revoked_at = null, invited_at = now(), invited_by = auth.uid()
  returning id into v_id;
  insert into wp_change_log (event_id, actor_email, actor_user, area, summary)
  values (p_event_id, lower(coalesce(auth.jwt() ->> 'email', '')), auth.uid(), 'access', 'granted portal access to ' || v_email);
  return jsonb_build_object('ok', true, 'id', v_id, 'email', v_email);
end; $function$;
