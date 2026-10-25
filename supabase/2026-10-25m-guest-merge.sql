-- supabase/2026-10-25m-guest-merge.sql
--
-- Bringing a guest list in AGAIN without doubling it.
--
-- Couples collect RSVPs on Bridebook, Hitched, Joy, Zola, Getting Married… and
-- export a CSV as replies arrive. wp_import_guests only ever ADDS, so the
-- second import put everybody on the list twice, and it read nothing but
-- names, side, age and notes.
--
-- wp_merge_guests(p_list, p_rows, p_apply) matches each row to a guest already
-- on the event (either list) by name — case, spacing and order of duplicates
-- considered — and:
--   · a match is UPDATED: the RSVP when the file gives one; notes are ADDED TO
--     value by value (one already there is not repeated; a meal choice replaces
--     the one under the same heading; nothing is cut to fit — a value that would
--     overflow is reported instead), never replaced; side and role only where
--     the guest has none; age only where the file's cell plainly says adult,
--     child or baby.
--     The guest stays on whichever list and table they are on.
--   · a new name is ADDED to p_list — unless the file says they are not
--     coming, in which case they are counted and left out.
--   · a guest on p_list who is not in the file is REPORTED, never removed.
-- With p_apply = false nothing is written and the same counts come back, so
-- the couple sees "12 new · 40 updated · 3 not in this file" first.
--
-- Client function: the event comes from the caller (wp_my_event_id); it takes
-- no id. A per-event advisory lock stops two imports at once both adding.
-- wp_import_guests is left in place for older bundles.

begin;

create or replace function public.wp_merge_guests(p_list text, p_rows jsonb, p_apply boolean)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare
  v_event integer := wp_my_event_id();
  v_base integer;
  rec record;
  r jsonb;
  v_rsvp text; v_notes text; v_add text; v_side text; v_role text; v_age text;
  v_changes text[];
  v_parts jsonb; v_part jsonb; v_t text; v_h text; v_cur text[]; v_cand text; v_added text[]; v_full boolean;
  full_names text[] := '{}'; dup_names text[] := '{}';
  n_new integer := 0; n_upd integer := 0; n_same integer := 0; n_declined integer := 0;
  new_names text[] := '{}'; upd_lines text[] := '{}'; declined_names text[] := '{}';
  v_matched uuid[] := '{}';
  v_missing jsonb;
  v_missing_n integer;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_list not in ('seated', 'evening') then return jsonb_build_object('ok', false, 'error', 'bad_list'); end if;
  if jsonb_typeof(p_rows) <> 'array' then return jsonb_build_object('ok', false, 'error', 'rows_not_an_array'); end if;
  if jsonb_array_length(p_rows) > 1000 then return jsonb_build_object('ok', false, 'error', 'too_many_rows'); end if;

  perform pg_advisory_xact_lock(hashtext('wp_merge_guests'), v_event);

  select coalesce(max(sort) + 1, 0) into v_base from wp_guests where event_id = v_event and list = p_list;

  for rec in
    with inp as (
      select t.ord, t.r,
             left(trim(coalesce(t.r ->> 'first_name', '')), 80) as f,
             left(trim(coalesce(t.r ->> 'last_name', '')), 80) as l
        from jsonb_array_elements(p_rows) with ordinality as t(r, ord)
    ), inp2 as (
      select inp.*, lower(regexp_replace(trim(f || ' ' || l), '\s+', ' ', 'g')) as k
        from inp where length(trim(f || ' ' || l)) > 0
    ), inp3 as (
      select inp2.*, row_number() over (partition by k order by ord) as kn from inp2
    ), ex as (
      select g.*, lower(regexp_replace(trim(coalesce(g.first_name, '') || ' ' || coalesce(g.last_name, '')), '\s+', ' ', 'g')) as k
        from wp_guests g where g.event_id = v_event
    ), ex2 as (
      -- The guest on the list being imported into is matched first; then the
      -- other list (someone moved to the evening is not added again).
      select ex.*, row_number() over (partition by k order by (list = p_list) desc, sort, created_at) as kn from ex
    )
    select i.ord, i.r, i.f, i.l, i.kn, e.id as gid, e.rsvp as e_rsvp, e.access_needs as e_notes, e.side as e_side,
           e.role as e_role, e.age_band as e_age
      from inp3 i left join ex2 e on e.k = i.k and e.kn = i.kn
     order by i.ord
  loop
    r := rec.r;
    v_rsvp := case when r ->> 'rsvp' in ('yes', 'no', 'maybe') then r ->> 'rsvp' end;
    v_add := left(nullif(trim(coalesce(r ->> 'access_needs', '')), ''), 300);

    if rec.gid is null then
      if v_rsvp = 'no' then
        n_declined := n_declined + 1;
        if cardinality(declined_names) < 25 then declined_names := declined_names || trim(rec.f || ' ' || rec.l); end if;
        continue;
      end if;
      n_new := n_new + 1;
      if cardinality(new_names) < 25 then new_names := new_names || trim(rec.f || ' ' || rec.l); end if;
      if p_apply then
        insert into wp_guests (event_id, list, first_name, last_name, side, age_band, staying, access_needs, rsvp, role, sort)
        values (v_event, p_list, rec.f, rec.l,
                left(nullif(trim(coalesce(r ->> 'side', '')), ''), 40),
                case when coalesce(r ->> 'age_band', 'adult') in ('adult', 'child', 'baby') then coalesce(r ->> 'age_band', 'adult') else 'adult' end,
                false, v_add, v_rsvp,
                left(nullif(trim(coalesce(r ->> 'role', '')), ''), 40),
                v_base);
        v_base := v_base + 1;
      end if;
      continue;
    end if;

    v_matched := v_matched || rec.gid;
    v_changes := '{}';

    v_rsvp := coalesce(v_rsvp, rec.e_rsvp);
    if v_rsvp is distinct from rec.e_rsvp then
      v_changes := v_changes || ('reply: ' || case v_rsvp when 'yes' then 'coming' when 'no' then 'not coming' else 'maybe' end);
    end if;

    -- Notes: each value from the file is added only if it is not there
    -- already; a meal choice replaces the one under the same heading
    -- ("Main: Lamb" → "Main: Beef"). Nothing is ever cut to fit: a value that
    -- would take the notes past 300 characters is left out and reported.
    v_parts := case when jsonb_typeof(r -> 'notes_parts') = 'array' then r -> 'notes_parts'
                    when v_add is not null then jsonb_build_array(jsonb_build_object('text', v_add))
                    else '[]'::jsonb end;
    v_notes := coalesce(trim(rec.e_notes), '');
    v_added := '{}'; v_full := false;
    for v_part in select * from jsonb_array_elements(v_parts) loop
      v_t := left(trim(coalesce(v_part ->> 'text', '')), 300);
      v_h := nullif(trim(coalesce(v_part ->> 'heading', '')), '');
      continue when v_t = '';
      v_cur := case when v_notes = '' then '{}'::text[] else string_to_array(v_notes, ' · ') end;
      continue when exists (select 1 from unnest(v_cur) x where lower(trim(x)) = lower(v_t));
      if v_h is not null and exists (select 1 from unnest(v_cur) x where left(lower(trim(x)), length(v_h) + 2) = lower(v_h) || ': ') then
        v_cand := array_to_string(array(select case when left(lower(trim(x)), length(v_h) + 2) = lower(v_h) || ': ' then v_t else x end
                                          from unnest(v_cur) with ordinality as u(x, o) order by o), ' · ');
      else
        v_cand := case when v_notes = '' then v_t else v_notes || ' · ' || v_t end;
      end if;
      if length(v_cand) > 300 then v_full := true; continue; end if;
      v_notes := v_cand; v_added := v_added || v_t;
    end loop;
    v_notes := nullif(v_notes, '');
    if v_notes is distinct from nullif(trim(coalesce(rec.e_notes, '')), '') then
      v_changes := v_changes || ('notes: ' || array_to_string(v_added, ', '));
    else
      v_notes := rec.e_notes;   -- untouched, exactly as it was
    end if;
    if v_full and cardinality(full_names) < 25 then full_names := full_names || trim(rec.f || ' ' || rec.l); end if;
    if rec.kn > 1 and cardinality(dup_names) < 25 and not (trim(rec.f || ' ' || rec.l) = any(dup_names)) then
      dup_names := dup_names || trim(rec.f || ' ' || rec.l);
    end if;

    v_side := coalesce(rec.e_side, left(nullif(trim(coalesce(r ->> 'side', '')), ''), 40));
    if v_side is distinct from rec.e_side then v_changes := v_changes || ('side: ' || v_side); end if;

    v_role := coalesce(rec.e_role, left(nullif(trim(coalesce(r ->> 'role', '')), ''), 40));
    if v_role is distinct from rec.e_role then v_changes := v_changes || ('role: ' || v_role); end if;

    v_age := rec.e_age;
    if coalesce((r ->> 'age_given')::boolean, false) and r ->> 'age_band' in ('adult', 'child', 'baby') then
      v_age := r ->> 'age_band';
    end if;
    if v_age is distinct from rec.e_age then v_changes := v_changes || ('age: ' || v_age); end if;

    if cardinality(v_changes) = 0 then
      n_same := n_same + 1;
    else
      n_upd := n_upd + 1;
      if cardinality(upd_lines) < 25 then
        upd_lines := upd_lines || (trim(rec.f || ' ' || rec.l) || ' — ' || array_to_string(v_changes, '; '));
      end if;
      if p_apply then
        update wp_guests set rsvp = v_rsvp, access_needs = v_notes, side = v_side, role = v_role,
                             age_band = v_age, updated_at = now()
         where id = rec.gid and event_id = v_event;
      end if;
    end if;
  end loop;

  select count(*), coalesce(jsonb_agg(nm) filter (where rn <= 25), '[]'::jsonb)
    into v_missing_n, v_missing
    from (select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) as nm,
                 row_number() over (order by sort, created_at) as rn
            from wp_guests
           where event_id = v_event and list = p_list and not (id = any(v_matched))
             -- the ones this very import added are not "missing"
             and not (p_apply and created_at >= now())) m;

  if p_apply and (n_new + n_upd) > 0 then
    perform wp_log('guests', format('imported a list: %s new, %s updated (%s)', n_new, n_upd, p_list));
  end if;

  return jsonb_build_object('ok', true, 'applied', p_apply,
    'new', n_new, 'updated', n_upd, 'unchanged', n_same, 'declined', n_declined, 'missing', v_missing_n,
    'new_names', to_jsonb(new_names), 'updated_lines', to_jsonb(upd_lines),
    'declined_names', to_jsonb(declined_names), 'missing_names', v_missing,
    'notes_full_names', to_jsonb(full_names), 'duplicate_names', to_jsonb(dup_names));
end $function$;

revoke all on function public.wp_merge_guests(text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.wp_merge_guests(text, jsonb, boolean) to authenticated;

commit;
