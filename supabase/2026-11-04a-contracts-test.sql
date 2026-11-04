-- supabase/2026-11-04a-contracts-test.sql
--
-- Assertions for 2026-11-04a-contracts.sql. Run against a SCRATCH Postgres 16
-- AFTER tests/contracts/standins.sql and the migration:
--
--   psql -d cttest -f tests/contracts/standins.sql
--   psql -d cttest -f supabase/2026-11-04a-contracts.sql
--   psql -d cttest -f supabase/2026-11-04a-contracts-test.sql
--
-- auth.uid() / auth.jwt() read t.uid / t.email. Each block raises on failure;
-- all passing prints "contracts: all assertions passed".

delete from ct_contracts; delete from ct_event_settings; delete from wp_access; delete from profiles;
insert into profiles (id, name, email, role, active) values
  ('00000000-0000-0000-0000-00000000000a', 'Rosanna Greenwood', 'rosanna@hawthbushfarm.co.uk', 'admin', true),
  ('00000000-0000-0000-0000-00000000000b', 'Bar', 'bar@hawthbushfarm.co.uk', 'bar', true);
insert into app_data (key, value) values ('hawthbush_bookings_v6',
  '[{"id":501,"couple":"Amy & Ben"},{"id":502,"couple":"Wake for Cyril"}]'::jsonb)
  on conflict (key) do update set value = excluded.value;

do $t$
declare
  bod jsonb := '{"format":1,"title":"Booking Form","event":{"id":501,"name":"Amy & Ben","date":"2027-06-26"},
    "blocks":[{"t":"h1","text":"Booking Form"},{"t":"accommodation"},{"t":"signatures"}],
    "accommodation":[{"key":"amly","label":"Amly Barn","from":"2027-06-25","to":"2027-06-27","fee":"1050"},
                     {"key":"glamping","label":"Glamping","options":[{"nights":1,"from":"2027-06-26","to":"2027-06-27","fee":"1750"},
                                                                     {"nights":2,"from":"2027-06-25","to":"2027-06-27","fee":"2675"}]}],
    "venue":{"name":"forged"}}'::jsonb;
  v jsonb; cid uuid; n int; t timestamptz;
begin
  -- 1. Only an admin sends.
  perform set_config('t.uid', '00000000-0000-0000-0000-00000000000b', false);
  v := ct_admin_issue(501, bod, false, '{"name":"Amy","email":"amy@example.com"}', '{"name":"Ben","email":"ben@example.com"}', '{}', true);
  if (v->>'ok')::boolean then raise exception '1 bar login sent a contract'; end if;

  perform set_config('t.uid', '00000000-0000-0000-0000-00000000000a', false);
  v := ct_admin_issue(501, bod, false, '{"name":"Amy","email":"amy@example.com"}', '{"name":"Ben","email":"AMY@example.com"}', '{}', true);
  if v->>'error' <> 'same_email' then raise exception '1b same address twice: %', v; end if;
  v := ct_admin_issue(501, bod, false, '{"name":"Amy","email":"amy@example.com"}', '{"name":"","email":""}', '{}', true);
  if v->>'error' <> 'client2_needed' then raise exception '1c second client missing: %', v; end if;
  v := ct_admin_issue(999, bod, false, '{"name":"Amy","email":"amy@example.com"}', '{"name":"Ben","email":"ben@example.com"}', '{}', true);
  if v->>'error' <> 'event_not_found' then raise exception '1d unknown event: %', v; end if;

  v := ct_admin_issue(501, bod, false, '{"name":"Amy Smith","email":"Amy@Example.com"}', '{"name":"Ben Jones","email":"ben@example.com"}',
                      '{"client1Name":"Amy Smith","client2Name":"Ben Jones","amly":"yes","bogus":"x"}', true);
  if not (v->>'ok')::boolean then raise exception '1e issue failed: %', v; end if;
  cid := (v->>'id')::uuid;
  if (v->>'version')::int <> 1 then raise exception '1f version %', v; end if;
  -- The venue signature is the server's, not whatever the body said.
  if (select body->'venue'->>'name' from ct_contracts where id = cid) <> 'Rosanna Greenwood' then raise exception '1g venue name forged'; end if;
  if (select body_sha256 from ct_contracts where id = cid) <> ct_sha((select body from ct_contracts where id = cid)) then raise exception '1h hash'; end if;
  -- Prefill keeps names, never pre-answers a choice, drops unknown keys.
  if (select answers from ct_answers where contract_id = cid) <> '{"client1Name":"Amy Smith","client2Name":"Ben Jones"}'::jsonb then
    raise exception '1i prefill %', (select answers from ct_answers where contract_id = cid); end if;
  if (select count(*) from wp_access where event_id = 501) <> 2 then raise exception '1j portal access not granted'; end if;
  if not (select booking_form_only from ct_event_settings where event_id = 501) then raise exception '1k booking form only'; end if;
  v := ct_admin_issue(501, bod, false, '{"name":"Amy","email":"amy@example.com"}', '{"name":"Ben","email":"ben@example.com"}', '{}', null);
  if v->>'error' <> 'already_out' then raise exception '1l second contract while one is out: %', v; end if;

  -- 2. Grants: the couple's functions for signed-in users, signing for the service only.
  if has_function_privilege('anon', 'public.ct_my_contract()', 'execute') then raise exception '2 anon can read a contract'; end if;
  if not has_function_privilege('authenticated', 'public.ct_my_contract()', 'execute') then raise exception '2b authenticated cannot'; end if;
  if has_function_privilege('authenticated', 'public.ct_sign_service(uuid,text,text,text,text)', 'execute') then raise exception '2c a client could call signing directly'; end if;
  if not has_function_privilege('service_role', 'public.ct_sign_service(uuid,text,text,text,text)', 'execute') then raise exception '2d service cannot sign'; end if;
  if has_function_privilege('authenticated', 'public.ct_service_contract(uuid)', 'execute') then raise exception '2e service read open'; end if;
  if has_function_privilege('authenticated', 'public.ct_clean_answers(jsonb)', 'execute') then raise exception '2f helper open'; end if;
  if has_table_privilege('authenticated', 'public.ct_contracts', 'select') then raise exception '2g table readable'; end if;

  -- 3. The couple read their own contract; the first open is logged once.
  perform set_config('t.uid', '', false);
  perform set_config('t.email', 'amy@example.com', false);
  v := ct_my_contract();
  if v->'contract'->>'my_role' <> 'client1' or not (v->'contract'->>'can_sign')::boolean then raise exception '3 my contract %', v; end if;
  if not (v->>'booking_form_only')::boolean then raise exception '3b only flag'; end if;
  if not (v->'contract'->'missing') ? 'client1Mobile' or not (v->'contract'->'missing') ? 'glamping' then raise exception '3c missing %', v->'contract'->'missing'; end if;
  if (v->'contract'->'missing') ? 'client1Name' then raise exception '3d prefilled name counted missing'; end if;
  if (v->'contract'->'signers'->0) ? 'email' then raise exception '3e signer emails sent to the client'; end if;
  perform ct_my_contract();
  if (select count(*) from ct_log where contract_id = cid and what like 'Opened by%') <> 1 then raise exception '3f opened logged twice'; end if;

  -- 4. Answers: cleaned; a stranger cannot.
  v := ct_save_answers('{"client1Mobile":" 07700 900001 ","amly":"maybe","glamping":"hold","glampingNights":"3","evil":"x"}');
  if v->'answers' ? 'evil' or v->'answers' ? 'amly' or v->'answers'->>'glamping' <> 'hold' or v->'answers'->>'client1Mobile' <> '07700 900001' then
    raise exception '4 answers %', v; end if;
  if not (v->'missing') ? 'glampingNights' or not (v->'missing') ? 'amly' then raise exception '4b missing: %', v; end if;
  v := ct_save_answers('{"amly":"Yes"}');
  if v->'answers'->>'amly' <> 'yes' then raise exception '4b2 amly %', v; end if;
  perform set_config('t.email', 'stranger@example.com', false);
  v := ct_save_answers('{"address":"x"}');
  if v->>'error' is distinct from 'no_access' then raise exception '4c stranger saved: %', v; end if;
  if ct_my_contract()->>'error' is distinct from 'no_access' then raise exception '4d stranger read'; end if;

  -- 5. Signing: incomplete refused; the first signature locks; once only.
  v := ct_sign_service(null, 'amy@example.com', 'Amy Smith', '1.2.3.4', 'UA');
  if v->>'error' <> 'incomplete' then raise exception '5 incomplete signed: %', v; end if;
  v := ct_sign_service(null, 'amy@example.com', ' ', '1.2.3.4', 'UA');
  if v->>'error' <> 'name_needed' then raise exception '5b blank name: %', v; end if;
  perform set_config('t.email', 'ben@example.com', false);
  v := ct_save_answers('{"client2Mobile":"07700 900002","address":"1 Lane, Lewes","glampingNights":2}');
  if jsonb_array_length(v->'missing') <> 0 then raise exception '5c still missing %', v; end if;
  v := ct_sign_service(null, 'stranger@example.com', 'Eve', '1.2.3.4', 'UA');
  if v->>'error' <> 'no_access' then raise exception '5d stranger signed: %', v; end if;
  v := ct_sign_service(null, 'Amy@Example.com', 'Amy Smith', '1.2.3.4', 'UA');
  if not (v->>'ok')::boolean or (v->>'complete')::boolean then raise exception '5e first signature %', v; end if;
  if (select locked_at from ct_answers where contract_id = cid) is null then raise exception '5f not locked'; end if;
  v := ct_save_answers('{"address":"changed"}');
  if v->>'error' is distinct from 'locked' and (v->>'ok')::boolean then raise exception '5g edited after a signature'; end if;
  v := ct_sign_service(null, 'amy@example.com', 'Amy Smith', '1.2.3.4', 'UA');
  if v->>'error' <> 'already_signed' then raise exception '5h signed twice: %', v; end if;
  v := ct_sign_service(null, 'ben@example.com', 'Ben Jones', '5.6.7.8', 'UA2');
  if not (v->>'complete')::boolean then raise exception '5i not complete: %', v; end if;
  if (select status from ct_contracts where id = cid) <> 'signed' or (select final_sha256 from ct_contracts where id = cid) is null then
    raise exception '5j not sealed by hash'; end if;
  if (select ip from ct_signers where contract_id = cid and role = 'client2') <> '5.6.7.8' then raise exception '5k ip'; end if;

  -- 6. A signed contract cannot be voided; PDF path for the couple only once made.
  perform set_config('t.uid', '00000000-0000-0000-0000-00000000000a', false);
  v := ct_admin_void(cid, 'changed our minds');
  if v->>'error' <> 'not_out' then raise exception '6 voided a signed contract: %', v; end if;
  perform set_config('t.uid', '', false);
  perform set_config('t.email', 'amy@example.com', false);
  if ct_my_pdf_path() is not null then raise exception '6b path before made'; end if;
  v := ct_service_set_pdf(cid, 'bookings/501/x.pdf');
  if ct_my_pdf_path() <> 'bookings/501/x.pdf' then raise exception '6c path'; end if;
  if not ((ct_my_contract()->'contract'->>'pdf_ready')::boolean) then raise exception '6d pdf_ready'; end if;
  if (ct_service_set_pdf(cid, 'bookings/501/y.pdf')->>'ok')::boolean then raise exception '6e filed twice'; end if;
  if ct_my_pdf_path() <> 'bookings/501/x.pdf' then raise exception '6f second filing replaced the first'; end if;

  -- 7. Void and reissue: one signer (a wake), version numbers per event.
  perform set_config('t.uid', '00000000-0000-0000-0000-00000000000a', false);
  v := ct_admin_issue(502, bod - 'accommodation' || '{"accommodation":[]}', true, '{"name":"Cy","email":"cy@example.com"}', null, '{}', null);
  if not (v->>'ok')::boolean then raise exception '7 one-signer issue %', v; end if;
  cid := (v->>'id')::uuid;
  if (select count(*) from ct_signers where contract_id = cid) <> 1 then raise exception '7b signers'; end if;
  v := ct_admin_void(cid, '');
  if v->>'error' <> 'reason_needed' then raise exception '7c void with no reason'; end if;
  v := ct_admin_void(cid, 'wrong fee');
  if not (v->>'ok')::boolean then raise exception '7d void %', v; end if;
  v := ct_admin_issue(502, bod - 'accommodation' || '{"accommodation":[]}', true, '{"name":"Cy","email":"cy@example.com"}', null, '{}', null);
  if (v->>'version')::int <> 2 then raise exception '7e version %', v; end if;
  cid := (v->>'id')::uuid;
  perform set_config('t.uid', '', false);
  perform set_config('t.email', 'cy@example.com', false);
  if (ct_my_contract()->'contract'->>'version')::int <> 2 then raise exception '7f client sees the void one'; end if;
  perform ct_save_answers('{"client1Mobile":"1","address":"x"}');
  v := ct_sign_service(null, 'cy@example.com', 'Cyril Jr', null, null);
  if not (v->>'complete')::boolean then raise exception '7g one signer did not complete: %', v; end if;

  -- 8. Statuses and the event view, admin only.
  perform set_config('t.uid', '00000000-0000-0000-0000-00000000000b', false);
  if (ct_admin_statuses()->>'ok')::boolean then raise exception '8 bar read statuses'; end if;
  perform set_config('t.uid', '00000000-0000-0000-0000-00000000000a', false);
  v := ct_admin_statuses();
  if jsonb_array_length(v->'contracts') <> 2 then raise exception '8b statuses %', v; end if;
  v := ct_admin_for_event(502);
  if jsonb_array_length(v->'contracts') <> 2 or (v->'contracts'->0->>'version')::int <> 2 then raise exception '8c for event %', v; end if;
  if v->'contracts'->1->>'void_reason' <> 'wrong fee' then raise exception '8d void reason'; end if;

  -- 9. Reminders: due after N days, marked once.
  v := ct_admin_issue(501, bod, true, '{"name":"Amy","email":"amy@example.com"}', null, '{}', null);
  cid := (v->>'id')::uuid;
  v := ct_service_due_reminders(7);
  if jsonb_array_length(v) <> 0 then raise exception '9 due too soon %', v; end if;
  update ct_contracts set sent_at = now() - interval '8 days' where id = cid;
  v := ct_service_due_reminders(7);
  if jsonb_array_length(v) <> 1 or v->0->'unsigned'->0->>'email' <> 'amy@example.com' then raise exception '9b due %', v; end if;
  t := (v->0->>'last')::timestamptz;
  if not ((ct_service_mark_reminded(cid, t)->>'ok')::boolean) then raise exception '9c mark'; end if;
  if (ct_service_mark_reminded(cid, t)->>'ok')::boolean then raise exception '9d marked twice'; end if;
  if jsonb_array_length(ct_service_due_reminders(7)) <> 0 then raise exception '9e still due after a reminder'; end if;

  raise notice 'contracts: all assertions passed';
end $t$;
