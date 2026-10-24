-- supabase/2026-10-24j-portal-tidy.sql
--
-- Client portal tidy-up from Toby's walk-through on 24 Oct 2026.
--
--   1. Details form ("Things we need to know"): candles and sparklers out (not
--      allowed); confetti says biodegradable only; the stretch tent is a
--      ceremony location. Questions already asked on another page come off
--      the form: first dance (Music), cake cutting and ceremony time
--      (Timeline), high chairs (Guests). Drop-off and collection stay as
--      questions — the Bringing page saves them — but are no longer drawn on
--      the Details form (`in_form`).
--   2. Checklist: "confetti, candles…" loses the candles; numbers "can be
--      changed later".
--   3. Timeline: the first-dance prompt moves to the Music page. A line can
--      name one of the couple's key contacts as well as a supplier
--      (`contact_id`), and a supplier can now be taken OFF a line
--      (wp_update_block could only ever set one — coalesce).
--   4. Music: a line can say "our DJ is playing this" (`dj_playing`).
--   5. Photos & films: a new section, `photos`, that takes LINKS only
--      (`wp_media_links`). The upload section stays, renamed Uploads in the
--      portal.
--   6. Drinks: a bespoke package is something staff write for one event
--      (`bespoke_name`, `bespoke_pp`, `bespoke_note`). The client can only
--      choose it once one is written. Priced per adult, through
--      wp_drinks_summary like the other two.
--   7. Evening bar: a link to the bar menu (`bar_menu_url`) replaces the
--      example prices.
--   8. Food: a package can belong to one event (`wp_food_packages.event_id`) —
--      a bespoke menu only that client sees and can tick.
--
-- Functions are patched IN PLACE from the live catalogue, each anchor asserted
-- exactly once. CREATE OR REPLACE keeps existing grants. New functions are
-- revoked from public, anon and authenticated and granted back by name.
-- Safe to run twice.
--
-- ORDER: push the front end first and let Netlify deploy, then apply this.
-- The portal skips section keys it does not know, and every new read is
-- optional on the page, so either order is survivable — but that one is clean.

begin;

create or replace function pg_temp.patch_fn(p_sig regprocedure, p_find text, p_repl text)
returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_sig); n integer;
begin
  -- Already patched (a second run): the replacement is there. Skip it. Checked
  -- first because several replacements contain their own anchor.
  if position(p_repl in d) > 0 then
    raise notice 'patch of % already applied — skipped', p_sig;
    return;
  end if;
  n := (length(d) - length(replace(d, p_find, ''))) / length(p_find);
  if n <> 1 then
    raise exception 'patch of % expected the anchor exactly once, found % times: %', p_sig, n, p_find;
  end if;
  execute replace(d, p_find, p_repl);
end $$;

-- ── 1. Details form ─────────────────────────────────────────────────────────
alter table wp_venue_form_questions add column if not exists in_form boolean not null default true;

-- Nobody has answered any of these yet (checked 24 Oct: wp_venue_form is empty).
delete from wp_venue_form_questions
 where qkey in ('naked_flames', 'sparklers', 'first_dance', 'cake_cutting', 'ceremony_time', 'high_chairs');

update wp_venue_form_questions set in_form = false
 where qkey in ('dropoff_date', 'dropoff_time', 'collect_date', 'collect_time');

update wp_venue_form_questions set help = 'Biodegradable only.' where qkey = 'confetti';

update wp_venue_form_questions
   set options = '["The Clearing", "The Grain Store", "The stretch tent", "Not sure yet"]'::jsonb
 where qkey = 'ceremony_location' and not (options ? 'The stretch tent');

select pg_temp.patch_fn('public.wp_get_venue_form()'::regprocedure,
  $f$'help', q.help, 'kind', q.kind, 'options', q.options)$f$,
  $r$'help', q.help, 'kind', q.kind, 'options', q.options, 'in_form', q.in_form)$r$);
select pg_temp.patch_fn('public.wp_get_venue_form()'::regprocedure,
  $f$where v_answers ? q.qkey$f$,
  $r$where q.in_form and v_answers ? q.qkey$r$);
select pg_temp.patch_fn('public.wp_get_venue_form()'::regprocedure,
  $f$(select count(*) from wp_venue_form_questions))$f$,
  $r$(select count(*) from wp_venue_form_questions where in_form))$r$);

-- The admin editor deletes and re-inserts every question. Remember each key's
-- in_form across that, or saving the editor would put drop-off back on the form.
select pg_temp.patch_fn('public.wp_admin_save_form_questions(jsonb)'::regprocedure,
  $f$  delete from wp_venue_form_questions;$f$,
  $r$  select coalesce(jsonb_object_agg(qkey, in_form), '{}'::jsonb) into v_inform from wp_venue_form_questions;
  delete from wp_venue_form_questions;$r$);
select pg_temp.patch_fn('public.wp_admin_save_form_questions(jsonb)'::regprocedure,
  $f$  v_n      integer := 0;$f$,
  $r$  v_n      integer := 0;
  v_inform jsonb;$r$);
select pg_temp.patch_fn('public.wp_admin_save_form_questions(jsonb)'::regprocedure,
  $f$insert into wp_venue_form_questions (qkey, section, label, help, kind, options, sort)$f$,
  $r$insert into wp_venue_form_questions (qkey, section, label, help, kind, options, sort, in_form)$r$);
select pg_temp.patch_fn('public.wp_admin_save_form_questions(jsonb)'::regprocedure,
  $f$            ord * 10);$f$,
  $r$            ord * 10,
            coalesce((e ->> 'in_form')::boolean, (v_inform ->> v_key)::boolean, true));$r$);

-- ── 2. Checklist ────────────────────────────────────────────────────────────
update wp_checklist_template set title = 'Tell us about confetti and anything else'
 where title = 'Tell us about confetti, candles and anything else';
update wp_checklist set title = 'Tell us about confetti and anything else'
 where title = 'Tell us about confetti, candles and anything else';
update wp_checklist_template
   set detail = replace(detail, 'You can change them whenever you like.', 'You can change them later.')
 where detail like '%You can change them whenever you like.%';
update wp_checklist
   set detail = replace(detail, 'You can change them whenever you like.', 'You can change them later.')
 where detail like '%You can change them whenever you like.%';

-- ── 3. Timeline ─────────────────────────────────────────────────────────────
-- The first dance song is asked on the Music page now. Answers are stored by
-- position, so dropping the first prompt drops the first answer with it.
update wp_timeline
   set prompts = replace(prompts, E'What is your first dance song?\n', ''),
       answers = case when jsonb_typeof(answers) = 'array' then answers - 0 else answers end
 where prompts like E'What is your first dance song?\n%';
update wp_timeline_template
   set prompts = replace(prompts, E'What is your first dance song?\n', '')
 where prompts like E'What is your first dance song?\n%';

alter table wp_timeline add column if not exists contact_id uuid references wp_key_contacts(id) on delete set null;

select pg_temp.patch_fn('public.wp_get_timeline()'::regprocedure,
  $f$'supplier_id', b.supplier_id, 'supplier_name', s.name,$f$,
  $r$'supplier_id', b.supplier_id, 'supplier_name', s.name,
               'contact_id', b.contact_id, 'contact_name', kc.name,$r$);
select pg_temp.patch_fn('public.wp_get_timeline()'::regprocedure,
  $f$left join wp_suppliers s on s.id = b.supplier_id$f$,
  $r$left join wp_suppliers s on s.id = b.supplier_id left join wp_key_contacts kc on kc.id = b.contact_id$r$);
select pg_temp.patch_fn('public.wp_get_timeline()'::regprocedure,
  $f$    'suppliers', coalesce(($f$,
  $r$    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role) order by c.sort, c.created_at)
        from wp_key_contacts c where c.event_id = v_event), '[]'::jsonb),
    'suppliers', coalesce(($r$);

select pg_temp.patch_fn('public.wp_admin_event_timeline(integer)'::regprocedure,
  $f$'supplier_name', s.name, 'locked', b.locked,$f$,
  $r$'supplier_name', s.name, 'contact_name', kc.name, 'locked', b.locked,$r$);
select pg_temp.patch_fn('public.wp_admin_event_timeline(integer)'::regprocedure,
  $f$left join wp_suppliers s on s.id = b.supplier_id$f$,
  $r$left join wp_suppliers s on s.id = b.supplier_id left join wp_key_contacts kc on kc.id = b.contact_id$r$);

-- Who a line is for: a supplier, one of their own people, both or neither.
-- Unlike wp_update_block this SETS both, so null takes one off.
create or replace function public.wp_set_block_who(p_id uuid, p_supplier_id uuid, p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_event integer := wp_my_event_id();
  v_locked boolean;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select locked into v_locked from wp_timeline where id = p_id and event_id = v_event;
  if v_locked is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_locked then return jsonb_build_object('ok', false, 'error', 'locked'); end if;
  if p_supplier_id is not null and not exists (
    select 1 from wp_event_suppliers where event_id = v_event and supplier_id = p_supplier_id) then
    return jsonb_build_object('ok', false, 'error', 'not_your_supplier');
  end if;
  if p_contact_id is not null and not exists (
    select 1 from wp_key_contacts where event_id = v_event and id = p_contact_id) then
    return jsonb_build_object('ok', false, 'error', 'not_your_contact');
  end if;
  update wp_timeline set supplier_id = p_supplier_id, contact_id = p_contact_id
   where id = p_id and event_id = v_event;
  perform wp_log('timeline', 'changed who is doing a line');
  return jsonb_build_object('ok', true);
end $$;

-- ── 4. Music ────────────────────────────────────────────────────────────────
alter table wp_playlist add column if not exists dj_playing boolean not null default false;

select pg_temp.patch_fn('public.wp_get_music()'::regprocedure,
  $f$jsonb_build_object('id', p.id, 'description', p.description, 'url', p.url)$f$,
  $r$jsonb_build_object('id', p.id, 'description', p.description, 'url', p.url, 'dj_playing', p.dj_playing)$r$);
select pg_temp.patch_fn('public.wp_admin_music(integer)'::regprocedure,
  $f$jsonb_build_object('description', p.description, 'url', p.url)$f$,
  $r$jsonb_build_object('description', p.description, 'url', p.url, 'dj_playing', p.dj_playing)$r$);

create or replace function public.wp_set_music_dj(p_id uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_event integer := wp_my_event_id(); v_desc text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  update wp_playlist set dj_playing = coalesce(p_on, false)
   where id = p_id and event_id = v_event
  returning description into v_desc;
  if v_desc is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('music', left(v_desc, 60) || case when p_on then ': the DJ is playing it' else ': not the DJ' end);
  return jsonb_build_object('ok', true);
end $$;

-- ── 5. Photos & films: links only ───────────────────────────────────────────
create table if not exists wp_media_links (
  id          uuid primary key default gen_random_uuid(),
  event_id    integer not null,
  description text not null check (length(trim(description)) > 0),
  url         text not null check (url ~ '^https://'),
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists wp_media_links_event on wp_media_links (event_id, sort);
alter table wp_media_links enable row level security;
revoke all on table wp_media_links from public, anon, authenticated;

create or replace function public.wp_get_media_links()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object('ok', true, 'links', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'description', m.description, 'url', m.url)
           order by m.sort, m.created_at)
      from wp_media_links m where m.event_id = v_event), '[]'::jsonb));
end $$;

create or replace function public.wp_save_media_link(p_id uuid, p_description text, p_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_event integer := wp_my_event_id();
  v_url text := trim(coalesce(p_url, ''));
  v_desc text := trim(coalesce(p_description, ''));
  v_id uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if length(v_desc) = 0 then return jsonb_build_object('ok', false, 'error', 'no_description'); end if;
  if v_url !~ '^https://[^\s/]+\.[^\s]+$' or length(v_url) > 1000 then
    return jsonb_build_object('ok', false, 'error', 'bad_link');
  end if;
  if p_id is null then
    if (select count(*) from wp_media_links where event_id = v_event) >= 40 then
      return jsonb_build_object('ok', false, 'error', 'too_many');
    end if;
    insert into wp_media_links (event_id, description, url, sort)
    values (v_event, left(v_desc, 200), v_url,
            coalesce((select max(sort) + 10 from wp_media_links where event_id = v_event), 10))
    returning id into v_id;
  else
    update wp_media_links set description = left(v_desc, 200), url = v_url
     where id = p_id and event_id = v_event
    returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  end if;
  perform wp_log('photos', 'saved a link: ' || left(v_desc, 60));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.wp_delete_media_link(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  delete from wp_media_links where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('photos', 'removed a link');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.wp_admin_media_links(p_event_id integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'links', coalesce((
    select jsonb_agg(jsonb_build_object('description', m.description, 'url', m.url, 'created_at', m.created_at)
           order by m.sort, m.created_at)
      from wp_media_links m where m.event_id = p_event_id), '[]'::jsonb));
end $$;

select pg_temp.patch_fn('public.wp_section_keys()'::regprocedure,
  $f$'music','uploads'$f$, $r$'music','photos','uploads'$r$);
select pg_temp.patch_fn('public.wp_section_area(text)'::regprocedure,
  $f$    when 'uploads'   then 'uploads'$f$,
  $r$    when 'uploads'   then 'uploads'
    when 'photos'    then 'photos'$r$);

alter table wp_section_status drop constraint if exists wp_section_status_section_check;
alter table wp_section_status add constraint wp_section_status_section_check check (section = any (array[
  'guests','timeline','suppliers','layout','details','items','food','music','drinks','bar','uploads','photos']));

-- The same standard as uploads: wakes, for the slideshow.
insert into wp_section_defaults (event_type, section, shown)
select t.event_type, 'photos', t.event_type = 'Wake'
  from (select distinct event_type from wp_section_defaults) t
 where not exists (select 1 from wp_section_defaults d where d.event_type = t.event_type and d.section = 'photos');

-- ── 6. Drinks: a bespoke package written for one event ──────────────────────
alter table wp_drinks add column if not exists bespoke_name text;
alter table wp_drinks add column if not exists bespoke_pp numeric
  check (bespoke_pp is null or bespoke_pp >= 0);

select pg_temp.patch_fn('public.wp_get_drinks()'::regprocedure,
  $f$'bespoke_note', d.bespoke_note,$f$,
  $r$'bespoke_note', d.bespoke_note, 'bespoke_name', d.bespoke_name, 'bespoke_pp', d.bespoke_pp,
      'bespoke_offered', coalesce(d.bespoke_name is not null or d.bespoke_note is not null, false),$r$);

select pg_temp.patch_fn('public.wp_drinks_summary(integer)'::regprocedure,
  $f$case d.route when 'classic' then s.classic_pp when 'corkage' then s.corkage_pp end$f$,
  $r$case d.route when 'classic' then s.classic_pp when 'corkage' then s.corkage_pp when 'bespoke' then d.bespoke_pp end$r$);
select pg_temp.patch_fn('public.wp_drinks_summary(integer)'::regprocedure,
  $f$if d.route in ('classic', 'corkage') and v_adults > 0 then$f$,
  $r$if (d.route in ('classic', 'corkage') or (d.route = 'bespoke' and v_rate is not null)) and v_adults > 0 then$r$);
select pg_temp.patch_fn('public.wp_drinks_summary(integer)'::regprocedure,
  $f$when 'classic' then 'Classic Drinks Package' else$f$,
  $r$when 'classic' then 'Classic Drinks Package' when 'bespoke' then coalesce(d.bespoke_name, 'Bespoke drinks package') else$r$);

-- The client can choose bespoke only once staff have written one.
select pg_temp.patch_fn('public.wp_set_drinks_route(text)'::regprocedure,
  $f$  if wp_drinks_locked(v_event) then return jsonb_build_object('ok', false, 'error', 'locked'); end if;$f$,
  $r$  if p_route = 'bespoke' and not exists (
       select 1 from wp_drinks where event_id = v_event and (bespoke_name is not null or bespoke_note is not null)) then
    return jsonb_build_object('ok', false, 'error', 'not_offered');
  end if;
  if wp_drinks_locked(v_event) then return jsonb_build_object('ok', false, 'error', 'locked'); end if;$r$);

create or replace function public.wp_admin_set_drinks_bespoke(p_event_id integer, p_name text, p_note text, p_pp numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text := nullif(trim(coalesce(p_name, '')), ''); v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_pp is not null and p_pp < 0 then return jsonb_build_object('ok', false, 'error', 'bad_price'); end if;
  insert into wp_drinks (event_id) values (p_event_id) on conflict (event_id) do nothing;
  update wp_drinks set
    bespoke_name = left(v_name, 120),
    bespoke_note = left(v_note, 1000),
    bespoke_pp   = case when v_name is null and v_note is null then null else p_pp end,
    -- Taking the package away takes their choice of it away too.
    route        = case when v_name is null and v_note is null and route = 'bespoke' then null else route end,
    updated_at   = now()
  where event_id = p_event_id;
  insert into wp_change_log (event_id, actor_email, actor_user, area, summary)
  values (p_event_id, lower(coalesce(auth.jwt() ->> 'email', '')), auth.uid(), 'drinks',
          case when v_name is null and v_note is null then 'staff removed the bespoke package'
               else 'staff set a bespoke package: ' || left(coalesce(v_name, v_note), 60) end);
  return jsonb_build_object('ok', true);
end $$;

-- ── 7. Evening bar: the menu, not example prices ────────────────────────────
alter table wp_drinks_settings add column if not exists bar_menu_url text
  check (bar_menu_url is null or bar_menu_url ~ '^https://');

select pg_temp.patch_fn('public.wp_get_drinks()'::regprocedure,
  $f$'bar_prices', s.bar_prices, 'bar_note', s.bar_note)$f$,
  $r$'bar_prices', s.bar_prices, 'bar_note', s.bar_note, 'bar_menu_url', s.bar_menu_url)$r$);
select pg_temp.patch_fn('public.wp_admin_save_drinks_settings(jsonb)'::regprocedure,
  $f$  if jsonb_typeof(coalesce(p -> 'bar_prices', '[]'::jsonb)) <> 'array' then$f$,
  $r$  if nullif(trim(coalesce(p ->> 'bar_menu_url', '')), '') is not null and trim(p ->> 'bar_menu_url') !~ '^https://' then
    return jsonb_build_object('ok', false, 'error', 'menu_not_https');
  end if;
  if jsonb_typeof(coalesce(p -> 'bar_prices', '[]'::jsonb)) <> 'array' then$r$);
-- Only when the key is sent: an older tab saving settings must not clear it.
select pg_temp.patch_fn('public.wp_admin_save_drinks_settings(jsonb)'::regprocedure,
  $f$    bar_note     = nullif(trim(coalesce(p ->> 'bar_note', '')), ''),$f$,
  $r$    bar_note     = nullif(trim(coalesce(p ->> 'bar_note', '')), ''),
    bar_menu_url = case when p ? 'bar_menu_url' then nullif(trim(coalesce(p ->> 'bar_menu_url', '')), '') else bar_menu_url end,$r$);

-- The example price list and its "these are example prices" note go.
update wp_drinks_settings set bar_prices = '[]'::jsonb,
       bar_note = case when bar_note like 'These are example prices%' then null else bar_note end
 where id;

-- ── 8. Food: a bespoke menu for one event ───────────────────────────────────
alter table wp_food_packages add column if not exists event_id integer;
create index if not exists wp_food_packages_event on wp_food_packages (event_id) where event_id is not null;

select pg_temp.patch_fn('public.wp_get_food()'::regprocedure,
  $f$'vat_rate', p.vat_rate, 'price_on_request', p.price_on_request or p.price_pp_inc_vat is null)$f$,
  $r$'vat_rate', p.vat_rate, 'price_on_request', p.price_on_request or p.price_pp_inc_vat is null,
               'bespoke', p.event_id is not null)$r$);
select pg_temp.patch_fn('public.wp_get_food()'::regprocedure,
  $f$order by p.sort, p.name)$f$,
  $r$order by (p.event_id is null), p.sort, p.name)$r$);
select pg_temp.patch_fn('public.wp_get_food()'::regprocedure,
  $f$from wp_food_packages p where p.active)$f$,
  $r$from wp_food_packages p where p.active and (p.event_id is null or p.event_id = v_event))$r$);
select pg_temp.patch_fn('public.wp_save_food(uuid,integer,time without time zone,text,text)'::regprocedure,
  $f$select * into p from wp_food_packages where id = p_package_id and active;$f$,
  $r$select * into p from wp_food_packages where id = p_package_id and active and (event_id is null or event_id = v_event);$r$);

-- The everyone-list in settings leaves one-event menus alone.
select pg_temp.patch_fn('public.wp_admin_food_packages()'::regprocedure,
  $f$from wp_food_packages p), '[]'::jsonb));$f$,
  $r$from wp_food_packages p where p.event_id is null), '[]'::jsonb));$r$);
select pg_temp.patch_fn('public.wp_admin_save_food_packages(jsonb)'::regprocedure,
  $f$exists (select 1 from wp_food_packages where id = v_id)$f$,
  $r$exists (select 1 from wp_food_packages where id = v_id and event_id is null)$r$);
select pg_temp.patch_fn('public.wp_admin_save_food_packages(jsonb)'::regprocedure,
  $f$update wp_food_packages set active = false where not (id = any (v_ids));$f$,
  $r$update wp_food_packages set active = false where event_id is null and not (id = any (v_ids));$r$);

create or replace function public.wp_admin_event_food(p_event_id integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'bespoke', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'description', p.description,
                                        'price_pp_inc_vat', p.price_pp_inc_vat, 'active', p.active)
           order by p.sort, p.created_at)
      from wp_food_packages p where p.event_id = p_event_id and p.active), '[]'::jsonb));
end $$;

-- Create (p_id null), change, or remove (p_active false) one event's own menu.
create or replace function public.wp_admin_save_event_food(p_event_id integer, p_id uuid, p_name text,
                                                           p_description text, p_price_pp numeric, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_name text := trim(coalesce(p_name, ''));
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_event_id is null then return jsonb_build_object('ok', false, 'error', 'no_event'); end if;
  if coalesce(p_active, true) and length(v_name) = 0 then return jsonb_build_object('ok', false, 'error', 'needs_name'); end if;
  if p_price_pp is not null and p_price_pp < 0 then return jsonb_build_object('ok', false, 'error', 'bad_price'); end if;
  if p_id is null then
    insert into wp_food_packages (name, description, price_pp_inc_vat, vat_rate, price_on_request, active, sort, event_id)
    values (left(v_name, 120), left(nullif(trim(coalesce(p_description, '')), ''), 1000), p_price_pp, 20,
            p_price_pp is null, true, 0, p_event_id)
    returning id into v_id;
  else
    update wp_food_packages set
      name = case when length(v_name) > 0 then left(v_name, 120) else name end,
      description = left(nullif(trim(coalesce(p_description, '')), ''), 1000),
      price_pp_inc_vat = p_price_pp,
      price_on_request = p_price_pp is null,
      active = coalesce(p_active, true)
    where id = p_id and event_id = p_event_id
    returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ── grants for the new functions ────────────────────────────────────────────
do $grants$
declare f text;
begin
  foreach f in array array[
    'public.wp_set_block_who(uuid,uuid,uuid)',
    'public.wp_set_music_dj(uuid,boolean)',
    'public.wp_get_media_links()',
    'public.wp_save_media_link(uuid,text,text)',
    'public.wp_delete_media_link(uuid)',
    'public.wp_admin_media_links(integer)',
    'public.wp_admin_set_drinks_bespoke(integer,text,text,numeric)',
    'public.wp_admin_event_food(integer)',
    'public.wp_admin_save_event_food(integer,uuid,text,text,numeric,boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $grants$;

-- ── checks ──────────────────────────────────────────────────────────────────
do $check$
begin
  if exists (select 1 from wp_venue_form_questions where qkey in ('naked_flames','sparklers','first_dance')) then
    raise exception 'details questions not removed'; end if;
  if (select count(*) from wp_venue_form_questions where not in_form) <> 4 then
    raise exception 'expected the four drop-off questions off the form'; end if;
  if not ('photos' = any (wp_section_keys())) or wp_section_area('photos') is distinct from 'photos' then
    raise exception 'photos section not registered'; end if;
  if exists (select 1 from wp_checklist where title like '%candles%') then
    raise exception 'checklist still mentions candles'; end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('wp_get_media_links','wp_save_media_link','wp_admin_set_drinks_bespoke','wp_admin_save_event_food','wp_set_block_who','wp_set_music_dj')
                and has_function_privilege('anon', p.oid, 'execute')) then
    raise exception 'a new function is callable by anon'; end if;
end $check$;

commit;
