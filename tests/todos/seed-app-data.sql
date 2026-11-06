-- What the app (build 2026-11-06c) may have saved before the move to tables:
-- the standard areas with one renamed, a project, a good to-do and a broken one.
insert into app_data (key, value) values
 ('hbf_todo_areas_v1', '[{"id":"admin","name":"Admin"},{"id":"amly-barn","name":"Amly Barn"},{"id":"grain-store","name":"Grain Store"},
   {"id":"glamping","name":"Glamping"},{"id":"hamlet","name":"Hamlet"},{"id":"cinema-barn","name":"Cinema Barn"},
   {"id":"wood-store","name":"Wood Store"},{"id":"old-brewery","name":"Old Brewery"},{"id":"barn-in-the-woods","name":"Barn in the Woods"}]'),
 ('hbf_todo_projects_v1', '[{"id":"cinema-refit","name":"Cinema refit","ownerId":"00000000-0000-0000-0000-0000000000a1"}]'),
 ('hbf_todos_v1', '[{"id":"td_copied1","title":"Copied across","who":"anyone","priority":"week","setOn":"2026-11-06","state":"open","photos":[]},
   {"id":"nonsense","title":"","priority":"whenever"},
   {"id":"td_nowho01","title":"No who saved","priority":"day","setOn":"2026-11-06"},
   {"id":"td_badwho1","title":"Mangled person","who":"person:------------------------------------","priority":"day"}]')
on conflict (key) do update set value = excluded.value;
