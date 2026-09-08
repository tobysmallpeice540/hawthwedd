-- supabase/2026-09-08-portal-phase04-suppliers.sql
--
-- Wedding client portal — phase 04: suppliers.
--
-- APPLIED TO PRODUCTION 8 September 2026 as migration portal_phase04_suppliers.
-- Assertions: portal-phase04-suppliers-test.sql — 16, all passing.
--
-- ONE TABLE, TWO KINDS OF ROW. A directory row has owner_event_id NULL and is
-- offered to everybody. A client-added row is owned by the event that created
-- it, is private to that couple, and never appears in anyone else's list.
-- Promoting a client-added supplier into the directory is one update — clearing
-- the owner — which is why the two are not separate tables.
--
-- WHAT A CLIENT NEVER SEES: whether Hawthbush holds a supplier's public
-- liability certificate, when it expires, and the internal note. Those are the
-- venue's business with the supplier, not the couple's, so the client-facing
-- payload is an allowlist that leaves them out.
--
-- The point of the directory, from Toby's side: knowing who is coming on site
-- before the day, being able to chase insurance in advance, and learning which
-- suppliers recur. A client-added supplier is a candidate for the directory,
-- which is how the list improves itself.

create table if not exists public.wp_supplier_categories (
  slug  text primary key,
  label text not null,
  sort  integer not null
);
alter table public.wp_supplier_categories enable row level security;

insert into public.wp_supplier_categories (slug, label, sort) values
  ('catering',      'Catering',            10),
  ('photography',   'Photography',         20),
  ('video',         'Video',               30),
  ('flowers',       'Flowers',             40),
  ('music',         'Music and DJs',       50),
  ('cake',          'Cake',                60),
  ('hair_makeup',   'Hair and make-up',    70),
  ('celebrant',     'Celebrant',           80),
  ('transport',     'Transport',           90),
  ('hire',          'Furniture and hire',  100),
  ('stationery',    'Stationery',          110),
  ('other',         'Something else',      120)
on conflict (slug) do update set label = excluded.label, sort = excluded.sort;

create table if not exists public.wp_suppliers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  category       text not null references public.wp_supplier_categories(slug),
  contact_name   text,
  email          text,
  phone          text,
  website        text,
  blurb          text,
  -- venue-only fields; never returned to a client
  pli_held       boolean not null default false,
  pli_expires    date,
  internal_note  text,
  -- NULL = in the shared directory. Set = private to that one wedding.
  owner_event_id integer,
  active         boolean not null default true,
  public_listed  boolean not null default false,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  promoted_at    timestamptz
);
create index if not exists wp_suppliers_directory on public.wp_suppliers (category, name) where owner_event_id is null and active;
create index if not exists wp_suppliers_owned     on public.wp_suppliers (owner_event_id) where owner_event_id is not null;
alter table public.wp_suppliers enable row level security;

create table if not exists public.wp_event_suppliers (
  id          uuid primary key default gen_random_uuid(),
  event_id    integer not null,
  supplier_id uuid not null references public.wp_suppliers(id) on delete cascade,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (event_id, supplier_id)
);
create index if not exists wp_event_suppliers_event on public.wp_event_suppliers (event_id);
alter table public.wp_event_suppliers enable row level security;

-- ── Read ────────────────────────────────────────────────────────────────────

create or replace function public.wp_get_suppliers()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  return jsonb_build_object(
    'ok', true,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('slug', c.slug, 'label', c.label) order by c.sort)
        from wp_supplier_categories c), '[]'::jsonb),

    -- The shared directory. Client-owned rows are excluded by the owner test,
    -- so one couple's private supplier never shows up in another's list.
    'directory', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'category', s.category,
               'website', s.website, 'blurb', s.blurb)
             order by s.category, s.name)
        from wp_suppliers s
       where s.owner_event_id is null and s.active), '[]'::jsonb),

    -- What this wedding has chosen, directory or their own.
    'chosen', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', es.id, 'supplier_id', s.id, 'name', s.name, 'category', s.category,
               'contact_name', s.contact_name, 'email', s.email, 'phone', s.phone,
               'website', s.website, 'notes', es.notes,
               'mine', s.owner_event_id is not null)
             order by s.category, s.name)
        from wp_event_suppliers es
        join wp_suppliers s on s.id = es.supplier_id
       where es.event_id = v_event), '[]'::jsonb)
  );
end;
$function$;

-- ── Choosing from the directory ─────────────────────────────────────────────

create or replace function public.wp_choose_supplier(p_supplier_id uuid, p_notes text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_name  text;
  v_id    uuid;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  -- Only a directory row, or one this couple owns. Naming another wedding's
  -- private supplier gets nothing.
  select name into v_name from wp_suppliers
   where id = p_supplier_id and active
     and (owner_event_id is null or owner_event_id = v_event);
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into wp_event_suppliers (event_id, supplier_id, notes)
  values (v_event, p_supplier_id, nullif(trim(coalesce(p_notes,'')),''))
  on conflict (event_id, supplier_id) do update set notes = excluded.notes
  returning id into v_id;

  perform wp_log('suppliers', 'chose ' || v_name);
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

create or replace function public.wp_unchoose_supplier(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_sup uuid;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  delete from wp_event_suppliers
   where id = p_id and event_id = v_event      -- <- the security of this function
  returning supplier_id into v_sup;
  if v_sup is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- A supplier this couple invented, now unchosen, has no reason to exist.
  delete from wp_suppliers where id = v_sup and owner_event_id = v_event;

  perform wp_log('suppliers', 'removed a supplier');
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Their own supplier ──────────────────────────────────────────────────────

create or replace function public.wp_add_own_supplier(
  p_name text, p_category text,
  p_contact_name text default null, p_email text default null,
  p_phone text default null, p_website text default null, p_notes text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_name  text := trim(coalesce(p_name, ''));
  v_sup   uuid;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if length(v_name) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_name');
  end if;
  if not exists (select 1 from wp_supplier_categories where slug = p_category) then
    return jsonb_build_object('ok', false, 'error', 'bad_category');
  end if;

  insert into wp_suppliers
    (name, category, contact_name, email, phone, website, owner_event_id, created_by, active)
  values (left(v_name,120), p_category,
          left(nullif(trim(coalesce(p_contact_name,'')),''),120),
          left(nullif(trim(coalesce(p_email,'')),''),200),
          left(nullif(trim(coalesce(p_phone,'')),''),60),
          left(nullif(trim(coalesce(p_website,'')),''),300),
          v_event, auth.uid(), true)
  returning id into v_sup;

  insert into wp_event_suppliers (event_id, supplier_id, notes)
  values (v_event, v_sup, nullif(trim(coalesce(p_notes,'')),''));

  perform wp_log('suppliers', 'added their own supplier: ' || left(v_name, 80));
  return jsonb_build_object('ok', true, 'supplier_id', v_sup);
end;
$function$;

-- Only a supplier this couple owns. A directory row belongs to the venue, and
-- editing it would change it for every other wedding.
create or replace function public.wp_update_own_supplier(
  p_supplier_id uuid, p_name text default null, p_category text default null,
  p_contact_name text default null, p_email text default null,
  p_phone text default null, p_website text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_hit integer;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if p_category is not null and not exists (select 1 from wp_supplier_categories where slug = p_category) then
    return jsonb_build_object('ok', false, 'error', 'bad_category');
  end if;

  update wp_suppliers
     set name         = coalesce(left(trim(p_name),120), name),
         category     = coalesce(p_category, category),
         contact_name = coalesce(left(trim(p_contact_name),120), contact_name),
         email        = coalesce(left(trim(p_email),200), email),
         phone        = coalesce(left(trim(p_phone),60), phone),
         website      = coalesce(left(trim(p_website),300), website)
   where id = p_supplier_id
     and owner_event_id = v_event;        -- <- the security of this function
  get diagnostics v_hit = row_count;

  if v_hit = 0 then return jsonb_build_object('ok', false, 'error', 'not_yours'); end if;
  perform wp_log('suppliers', 'edited their own supplier');
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Admin ───────────────────────────────────────────────────────────────────

create or replace function public.wp_admin_suppliers()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;
  return jsonb_build_object(
    'ok', true,
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'category', s.category,
               'contact_name', s.contact_name, 'email', s.email, 'phone', s.phone,
               'website', s.website, 'blurb', s.blurb,
               'pli_held', s.pli_held, 'pli_expires', s.pli_expires,
               'internal_note', s.internal_note,
               'owner_event_id', s.owner_event_id, 'active', s.active,
               'public_listed', s.public_listed,
               'used_by', (select count(*) from wp_event_suppliers es where es.supplier_id = s.id))
             order by s.owner_event_id nulls first, s.category, s.name)
        from wp_suppliers s), '[]'::jsonb));
end;
$function$;

create or replace function public.wp_admin_promote_supplier(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_hit integer;
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;
  update wp_suppliers
     set owner_event_id = null, promoted_at = now(), active = true
   where id = p_id and owner_event_id is not null;
  get diagnostics v_hit = row_count;
  if v_hit = 0 then return jsonb_build_object('ok', false, 'error', 'not_found_or_already_directory'); end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

revoke all on function public.wp_get_suppliers()                                from public, anon, authenticated;
revoke all on function public.wp_choose_supplier(uuid,text)                     from public, anon, authenticated;
revoke all on function public.wp_unchoose_supplier(uuid)                        from public, anon, authenticated;
revoke all on function public.wp_add_own_supplier(text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.wp_update_own_supplier(uuid,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.wp_admin_suppliers()                              from public, anon, authenticated;
revoke all on function public.wp_admin_promote_supplier(uuid)                   from public, anon, authenticated;

grant execute on function public.wp_get_suppliers()                             to authenticated, service_role;
grant execute on function public.wp_choose_supplier(uuid,text)                  to authenticated, service_role;
grant execute on function public.wp_unchoose_supplier(uuid)                     to authenticated, service_role;
grant execute on function public.wp_add_own_supplier(text,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.wp_update_own_supplier(uuid,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.wp_admin_suppliers()                           to authenticated, service_role;
grant execute on function public.wp_admin_promote_supplier(uuid)                to authenticated, service_role;

do $verify$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname='public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;
  select count(*) into n from pg_policy p join pg_class c on c.oid=p.polrelid where c.relname like 'wp\_%';
  if n > 0 then raise exception 'wp_ tables must have no policies, found %', n; end if;
  raise notice 'phase 04 suppliers in place';
end
$verify$;
