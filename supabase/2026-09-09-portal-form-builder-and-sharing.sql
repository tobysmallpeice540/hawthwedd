-- supabase/2026-09-09-portal-form-builder-and-sharing.sql
--
-- APPLIED 9 September 2026 as two migrations:
--   portal_form_builder_and_supplier_sharing
--   portal_supplier_share_in_payloads   (the two in-place patches at the foot)
--
-- Assertions: portal-form-builder-test.sql — 14, all passing.
--
-- ── THE DETAILS FORM BECOMES SOMETHING TOBY BUILDS ─────────────────────────
--
-- The questions were seeded once and only changeable in SQL. Now: any number of
-- headings he names himself, any number of questions under each, and a field
-- type per question — short text, notes, number, time, date, yes/no, radio
-- buttons or a dropdown.
--
-- A SECTION IS NOT A TABLE. It is the text on each question, so renaming one is
-- a save and inventing one is typing a name. That keeps the whole form to one
-- list with one Save, and means a question moves between headings by retyping
-- its heading rather than by dragging it anywhere.
--
-- ── THE THING wp_admin_save_form_questions EXISTS TO PROTECT ───────────────
--
-- qkey is the key each couple's answer is filed under in wp_venue_form.answers.
-- Change a qkey and every answer already given to that question is orphaned:
-- still in the database, invisible for ever, and nothing anywhere says it
-- happened.
--
-- So a qkey is assigned ONCE and never rewritten. A row arriving with a key
-- keeps it whatever its wording now says; a row arriving without one is given a
-- fresh key derived from its label. Renaming a question is therefore always
-- safe — which matters, because renaming is the common case and the one
-- somebody does without thinking about it. Deleting is not safe, so the reader
-- returns how many couples have answered each question and the screen asks
-- before throwing those answers away.
--
-- Validation runs over every row BEFORE the delete. A form that half-saved
-- would be worse than one that refused.
--
-- ── AND A COUPLE OFFERING THEIR SUPPLIER TO EVERYONE ELSE ──────────────────
--
-- The tick box says "happy for us to suggest them to other couples". It does
-- not publish: it OFFERS. The barn's list is the venue's own recommendation and
-- has a public face, and every supplier on it needs their own agreement first —
-- so a couple cannot write into it directly. share_offered_at records the
-- offer; Toby promotes with the button that already exists.
--
-- Wording the tick box as an offer rather than a promise is deliberate. Saying
-- "they will be added" would be the easy thing to write and a lie.

begin;

-- ── 1. Two more field kinds ─────────────────────────────────────────────────
-- 'choice' rendered as a dropdown and there was no way to ask for radio
-- buttons, which is what you want for three options a couple should see at
-- once. 'choice' is kept and treated as 'select' so nothing existing breaks.
alter table public.wp_venue_form_questions drop constraint if exists wp_venue_form_questions_kind_check;
alter table public.wp_venue_form_questions add constraint wp_venue_form_questions_kind_check
  check (kind in ('text','longtext','yesno','choice','select','radio','number','time','date'));

-- ── 2. Reading the form as a thing to be edited ─────────────────────────────
create or replace function public.wp_admin_form_questions()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object(
    'ok', true,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qkey', q.qkey, 'section', q.section, 'label', q.label, 'help', q.help,
               'kind', q.kind, 'options', q.options, 'sort', q.sort,
               -- How many couples have already answered it. Deleting a question
               -- that people have answered throws their answers away, so the
               -- screen has to be able to say so before it happens.
               'answered', (select count(*) from wp_venue_form f
                             where f.answers ? q.qkey
                               and nullif(trim(coalesce(f.answers ->> q.qkey, '')), '') is not null))
             order by q.sort, q.qkey)
        from wp_venue_form_questions q), '[]'::jsonb)
  );
end;
$function$;

-- ── 3. Saving it ────────────────────────────────────────────────────────────
create or replace function public.wp_admin_save_form_questions(p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  e        jsonb;
  ord      integer := 0;
  v_key    text;
  v_kind   text;
  v_keys   text[] := '{}';
  v_n      integer := 0;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_not_an_array');
  end if;
  if jsonb_array_length(p_rows) > 80 then
    return jsonb_build_object('ok', false, 'error', 'too_many_questions');
  end if;

  -- Everything is checked before anything is written. A form that half-saved
  -- would be worse than one that refused.
  for e in select * from jsonb_array_elements(p_rows) loop
    v_kind := coalesce(e ->> 'kind', '');
    if length(trim(coalesce(e ->> 'label', ''))) = 0 then
      return jsonb_build_object('ok', false, 'error', 'needs_label');
    end if;
    if length(trim(coalesce(e ->> 'section', ''))) = 0 then
      return jsonb_build_object('ok', false, 'error', 'needs_section');
    end if;
    if v_kind not in ('text','longtext','yesno','choice','select','radio','number','time','date') then
      return jsonb_build_object('ok', false, 'error', 'bad_kind');
    end if;
    -- A dropdown with nothing in it is a dead end on the couple's screen.
    if v_kind in ('select','radio','choice')
       and coalesce(jsonb_array_length(case when jsonb_typeof(e -> 'options') = 'array'
                                            then e -> 'options' else '[]'::jsonb end), 0) < 2 then
      return jsonb_build_object('ok', false, 'error', 'needs_two_options');
    end if;
  end loop;

  delete from wp_venue_form_questions;

  for e in select * from jsonb_array_elements(p_rows) loop
    ord := ord + 1;

    -- Keep the key it already had; only invent one for a genuinely new question.
    v_key := nullif(trim(coalesce(e ->> 'qkey', '')), '');
    if v_key is null then
      v_key := left(regexp_replace(lower(trim(e ->> 'label')), '[^a-z0-9]+', '_', 'g'), 40);
      v_key := trim(both '_' from v_key);
      if v_key = '' then v_key := 'q'; end if;
      -- Two questions can be worded the same; their keys cannot.
      if v_key = any (v_keys) or exists (select 1 from unnest(v_keys) k where k = v_key) then
        v_key := left(v_key, 34) || '_' || ord::text;
      end if;
    end if;
    if v_key = any (v_keys) then
      v_key := left(v_key, 34) || '_' || ord::text;
    end if;
    v_keys := v_keys || v_key;

    v_kind := e ->> 'kind';
    insert into wp_venue_form_questions (qkey, section, label, help, kind, options, sort)
    values (v_key,
            left(trim(e ->> 'section'), 80),
            left(trim(e ->> 'label'), 200),
            left(nullif(trim(coalesce(e ->> 'help', '')), ''), 300),
            v_kind,
            case when v_kind in ('select','radio','choice') then e -> 'options' else null end,
            ord * 10);
    v_n := v_n + 1;
  end loop;

  perform wp_log('admin', 'saved the details form');
  return jsonb_build_object('ok', true, 'saved', v_n);
end;
$function$;

-- ── 4. A couple offering their supplier to everyone else ────────────────────
alter table public.wp_suppliers add column if not exists share_offered_at timestamptz;

create or replace function public.wp_offer_supplier(p_id uuid, p_share boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  -- Their own addition only. `owner_event_id = v_event` is the whole security
  -- of this: a supplier the venue added has a null owner, so a couple cannot
  -- reach one, and neither can they reach another wedding's.
  update wp_suppliers
     set share_offered_at = case when coalesce(p_share, true) then now() else null end
   where id = p_id and owner_event_id = v_event;

  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('suppliers',
    case when coalesce(p_share, true) then 'offered a supplier to other couples'
         else 'stopped sharing a supplier' end);
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── 5. Both supplier readers patched IN PLACE, anchors asserted once each ────
do $patch$
declare
  def text; hits int;
  a text := $x$'mine', s.owner_event_id is not null)$x$;
  r text := $x$'mine', s.owner_event_id is not null,
               'shared', s.share_offered_at is not null)$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_get_suppliers';
  if def is null then raise exception 'wp_get_suppliers() not found'; end if;
  if position('share_offered_at' in def) > 0 then
    raise notice 'wp_get_suppliers() already reports sharing - skipped'; return;
  end if;
  hits := (length(def) - length(replace(def, a, ''))) / length(a);
  if hits <> 1 then raise exception 'mine anchor found % times - not patching', hits; end if;
  execute replace(def, a, r);
  raise notice 'wp_get_suppliers() patched: reports whether a supplier is offered';
end
$patch$;

-- And the admin list needs to show which ones have been offered, or the tick
-- box on the couple's side goes nowhere anybody can see.
do $patch2$
declare
  def text; hits int;
  a text := $x$'public_listed', s.public_listed$x$;
  r text := $x$'public_listed', s.public_listed,
               'share_offered_at', s.share_offered_at$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_admin_suppliers';
  if def is null then raise exception 'wp_admin_suppliers() not found'; end if;
  if position('share_offered_at' in def) > 0 then
    raise notice 'wp_admin_suppliers() already reports sharing - skipped'; return;
  end if;
  hits := (length(def) - length(replace(def, a, ''))) / length(a);
  if hits <> 1 then raise exception 'public_listed anchor found % times - not patching', hits; end if;
  execute replace(def, a, r);
  raise notice 'wp_admin_suppliers() patched: reports offers';
end
$patch2$;

revoke all on function public.wp_admin_form_questions()             from public, anon, authenticated;
revoke all on function public.wp_admin_save_form_questions(jsonb)   from public, anon, authenticated;
revoke all on function public.wp_offer_supplier(uuid, boolean)      from public, anon, authenticated;

grant execute on function public.wp_admin_form_questions()           to authenticated, service_role;
grant execute on function public.wp_admin_save_form_questions(jsonb) to authenticated, service_role;
grant execute on function public.wp_offer_supplier(uuid, boolean)    to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- The kind constraint can be narrowed back, but only after any 'radio',
-- 'select' or 'date' question has been changed or removed, or the ALTER fails.
-- share_offered_at is additive and nullable; leaving it costs nothing.
