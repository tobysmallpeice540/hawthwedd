-- supabase/2026-10-25l-review-fixes.sql
--
-- Fixes from the review of 25 Oct 2026 (two independent reviewers, on the
-- 24 Oct j and k migrations and the portal front end).
--
--   1. Bespoke drinks: the package's own price is the price. wp_drinks_summary
--      took coalesce(rate_pp, bespoke_pp), so a per-wedding rate saved earlier
--      (or carried over from Classic/corkage) silently overrode it, and the
--      couple saw one figure while the invoice said another. And a bespoke
--      package with no price now counts as unpriced, instead of a quiet £0.
--   2. Bespoke food: pricing or renaming an event's own menu after the client
--      chose it now reaches their choice. wp_save_food keeps the price the
--      client chose at (right for the standard menus, where a later price rise
--      must not reach a booked couple), so a menu chosen while "price on
--      request" stayed unpriced for good and dropped out of the VAT split.
--   3. Checklist: a fixed-date item (Interim payment, 15 January) falls in the
--      event's own year, as the statement now has it (stage 2 invoiced 1 Dec,
--      due 15 Jan of the wedding year). It is not seeded
--      when it fell before the booking was made (where the event records
--      createdAt), or in the last 28 days — the final balance (28 days before)
--      covers it then. Not "before today": a checklist is seeded when the
--      couple first opens the portal, which can be well after an interim
--      payment they still owe. The one row migration k added for a date
--      already gone (test event 222, 15 Jan 2026) is removed.
--   4. Sixteen wp_admin_save_* functions checked is_staff(), so a bar login
--      could rewrite venue settings, drinks prices, the checklist, the form
--      questions and so on. They now check wp_is_admin(), the house rule.
--   5. wp_admin_set_drinks_bespoke recreated from the file, so the live body
--      matches the migration (the j apply had dropped a comment line).
--
-- Patched in place from the live catalogue, each anchor asserted once.
-- CREATE OR REPLACE keeps grants. Safe to run twice.

begin;

create or replace function pg_temp.patch_fn(p_sig regprocedure, p_find text, p_repl text)
returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_sig); n integer;
begin
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

-- ── 1. Bespoke drinks price ─────────────────────────────────────────────────
select pg_temp.patch_fn('public.wp_drinks_summary(integer)'::regprocedure,
  $f$v_rate  := coalesce(d.rate_pp, case d.route when 'classic' then s.classic_pp when 'corkage' then s.corkage_pp when 'bespoke' then d.bespoke_pp end);$f$,
  $r$v_rate  := case when d.route = 'bespoke' then d.bespoke_pp
                   else coalesce(d.rate_pp, case d.route when 'classic' then s.classic_pp when 'corkage' then s.corkage_pp end) end;$r$);

select pg_temp.patch_fn('public.wp_drinks_summary(integer)'::regprocedure,
  $f$  -- The three allowances. No pooling: each moment stands alone.$f$,
  $r$  -- A bespoke package with no price yet is something still to price, not £0.
  if d.route = 'bespoke' and d.bespoke_pp is null then
    v_unpriced := v_unpriced + 1;
  end if;

  -- The three allowances. No pooling: each moment stands alone.$r$);

-- ── 2. Bespoke food: the client's choice follows its menu ──────────────────
select pg_temp.patch_fn('public.wp_admin_save_event_food(integer,uuid,text,text,numeric,boolean)'::regprocedure,
  $f$  return jsonb_build_object('ok', true, 'id', v_id);$f$,
  $r$  -- Their choice follows a menu written for them alone (a standard menu
  -- keeps the price it was chosen at — see wp_save_food).
  if coalesce(p_active, true) then
    update wp_food_choice c
       set package_name = p.name, price_pp = p.price_pp_inc_vat, vat_rate = p.vat_rate
      from wp_food_packages p
     where p.id = v_id and c.event_id = p_event_id and c.package_id = v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);$r$);

-- ── 3. Fixed-date checklist items ───────────────────────────────────────────
select pg_temp.patch_fn('public.wp_get_checklist()'::regprocedure,
  $f$  v_date  date;
begin$f$,
  $r$  v_date  date;
  v_booked date;
begin$r$);
select pg_temp.patch_fn('public.wp_get_checklist()'::regprocedure,
  $f$    select nullif(e ->> 'date', '')::date into v_date$f$,
  $r$    select nullif(e ->> 'date', '')::date,
           case when (e ->> 'createdAt') ~ '^\d{4}-\d{2}-\d{2}' then left(e ->> 'createdAt', 10)::date end
      into v_date, v_booked$r$);
-- Seeding happens when the couple first opens the portal, not when they book,
-- so "already past today" would hide a payment they genuinely owe. The test is
-- against the booking date where the record has one (newer events only).
select pg_temp.patch_fn('public.wp_get_checklist()'::regprocedure,
  $f$      from wp_checklist_template t;
  end if;$f$,
  $r$      from wp_checklist_template t
     -- A fixed-date item falls in the event's own year (Interim payment: 15
     -- January of the wedding year, matching the statement). Left out if that
     -- is before they booked, or in the last 28 days (the final balance is due
     -- then and covers it).
     where t.due_md is null or v_date is null
        or (wp_fixed_due(v_date, t.due_md) >= coalesce(v_booked, '-infinity'::date)
            and wp_fixed_due(v_date, t.due_md) < v_date - 28
            and extract(year from wp_fixed_due(v_date, t.due_md)) = extract(year from v_date));
  end if;$r$);

delete from wp_checklist
 where title = 'Interim payment due' and source = 'venue' and done_at is null
   and due_on < '2026-10-24';

-- ── 4. Settings saves: admin only ───────────────────────────────────────────
select pg_temp.patch_fn(f::regprocedure, 'not is_staff()', 'not wp_is_admin()')
  from unnest(array[
    'public.wp_admin_save_accommodation', 'public.wp_admin_save_addons', 'public.wp_admin_save_boards',
    'public.wp_admin_save_checklist_template', 'public.wp_admin_save_drinks_catalogue',
    'public.wp_admin_save_drinks_settings', 'public.wp_admin_save_event_day',
    'public.wp_admin_save_food_packages', 'public.wp_admin_save_form_questions',
    'public.wp_admin_save_item_types', 'public.wp_admin_save_music_defaults', 'public.wp_admin_save_preset',
    'public.wp_admin_save_section_defaults', 'public.wp_admin_save_timeline_template',
    'public.wp_admin_save_venue_settings', 'public.wp_admin_save_webcast']) n,
  lateral (select p.oid::regprocedure::text as f from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname || '.' || p.proname = n) x;

-- ── 5. Bring wp_admin_set_drinks_bespoke back in line with the j file ──────
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
revoke all on function public.wp_admin_set_drinks_bespoke(integer,text,text,numeric) from public, anon, authenticated;
grant execute on function public.wp_admin_set_drinks_bespoke(integer,text,text,numeric) to authenticated;

-- ── checks ──────────────────────────────────────────────────────────────────
do $check$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'wp_admin_save%' and p.prosrc like '%not is_staff()%') then
    raise exception 'a settings save is still staff-gated'; end if;
  if exists (select 1 from wp_checklist where title = 'Interim payment due' and due_on < '2026-10-24' and done_at is null) then
    raise exception 'past interim item still there'; end if;
  if has_function_privilege('anon', 'public.wp_admin_set_drinks_bespoke(integer,text,text,numeric)', 'execute') then
    raise exception 'bespoke drinks callable by anon'; end if;
end $check$;

commit;
