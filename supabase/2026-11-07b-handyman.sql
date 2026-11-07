-- 2026-11-07b — the Handyman login (Toby, 7 Nov 2026).
--
-- A handyman is an office login with less of the app: no Settings, no
-- Enquiries, only the two rota reports, and none of the settings pages that
-- live inside sections (Lettings → Report / Import / Settings, Events →
-- Portal settings and Invoices, Box Office → Settings, checklist set-up).
--
-- It is NOT a new value of profiles.role. Every database function, storage
-- policy and Netlify function that serves the office checks role = 'admin'
-- (wp_is_admin, chk_my_role, todo_*, resolveStaff(['admin']) in a dozen
-- functions); a handyman needs nearly all of those to work — the event form
-- alone calls admin-only portal functions. So a handyman IS role 'admin' with
-- profiles.access = 'handyman', and the app shows him less.
--
-- What that means, plainly: the narrowing is in the browser, like the rest of
-- `role` (see CLAUDE.md). The one server-side refusal is user-admin.js, which
-- will not let a handyman manage logins — otherwise he could make himself a
-- full administrator.
--
-- authenticated has SELECT only on profiles, and profiles_read_own lets a
-- person read their own row; only user-admin.js (service key) writes it.

alter table public.profiles add column if not exists access text;

alter table public.profiles drop constraint if exists profiles_access_check;
alter table public.profiles add constraint profiles_access_check
  check (access is null or (access = 'handyman' and role = 'admin'));

-- The app reads its role from here (main.jsx). Same body as before plus access.
create or replace function public.my_profile()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
  select coalesce(
    (select jsonb_build_object('id', id, 'email', email, 'name', name,
                               'role', role, 'active', active, 'access', access)
       from profiles where id = auth.uid()),
    '{}'::jsonb);
$function$;
