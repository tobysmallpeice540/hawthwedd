-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 3 — real accounts
--
-- Run this whole file in a NEW Supabase SQL editor tab. Safe to re-run.
--
-- Replaces three shared logins compiled into the JavaScript bundle with one
-- account per person, checked by Supabase rather than by the browser deciding
-- to render. Roles stay exactly as they are — admin, bar, cleaner — because
-- what changes is who holds an account, not what the roles mean.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text default '',
  role       text not null default 'bar' check (role in ('admin','bar','cleaner')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- A signed-in person may read their own profile and nothing else. This is what
-- the app calls to find out which role it is rendering for — and because the
-- answer comes from the database rather than from sessionStorage, it can't be
-- edited from the browser console the way the old role could.
drop policy if exists profiles_read_own on profiles;
create policy profiles_read_own on profiles
  for select using (auth.uid() = id);

-- Nobody changes a role from the browser. Role changes go through the service
-- key, which is the staff accounts screen in Phase 4.

-- Every new account gets a profile automatically, so an account can never
-- exist without a role. New people default to `bar` — the least that is useful
-- — rather than to admin, because a mistake in that direction is harmless.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'bar')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill: any account created before this ran still needs a profile.
insert into profiles (id, email, role)
select u.id, u.email, 'bar'
from auth.users u
where not exists (select 1 from profiles p where p.id = u.id);

grant select on profiles to authenticated;

-- ── Who is this? ─────────────────────────────────────────────────────────────
-- Used by the app to resolve its own role in one call.
create or replace function my_profile()
returns jsonb
language sql
security definer
set search_path = public, extensions
stable
as $$
  select coalesce(
    (select jsonb_build_object('id', id, 'email', email, 'name', name,
                               'role', role, 'active', active)
       from profiles where id = auth.uid()),
    '{}'::jsonb);
$$;

grant execute on function my_profile() to authenticated;

select id, email, role, active from profiles order by created_at;
