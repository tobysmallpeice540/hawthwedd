import fs from "fs"; import pg from "pg";
const c=new pg.Client({host:"127.0.0.1",port:54329,user:"postgres",database:"postgres"});
await c.connect();
await c.query("drop schema if exists public cascade; create schema public;");
await c.query("drop schema if exists storage cascade; create schema storage;");
await c.query("drop schema if exists auth cascade; create schema auth;");
for (const r of ["anon","authenticated","service_role"]) { try{await c.query(`create role ${r} nologin`);}catch(e){} }
await c.query("grant usage on schema public, storage to anon, authenticated, service_role");
await c.query(`create or replace function auth.uid() returns uuid language sql stable
               as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$`);
await c.query(`create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text)`);
await c.query(`alter table storage.objects enable row level security`);
await c.query(`create policy "Allow public access pjwyyr_0" on storage.objects for select to anon using (true)`);
await c.query(`create policy booking_files_read on storage.objects for select to authenticated using (bucket_id='booking-files')`);
await c.query(`create table profiles (id uuid primary key, email text, role text, active boolean default true)`);
await c.query(`alter table profiles enable row level security`);
await c.query(`create policy profiles_read_own on profiles for select using (auth.uid()=id)`);
await c.query(`create table app_data (key text primary key, value jsonb, updated_at timestamptz default now())`);
await c.query(`alter table app_data enable row level security`);
await c.query(`create policy "Allow all for anon" on app_data for all to anon using (true) with check (true)`);
await c.query(`create policy app_data_authenticated on app_data for all to authenticated using (true) with check (true)`);
await c.query(`grant all on app_data, profiles to anon, authenticated`);
await c.query(`grant all on storage.objects to anon, authenticated`);

const props = [{id:"hamlet",name:"The Hamlet",sleeps:14,baseRate:0,seasons:[],publicBookable:true,
                minNights:2,maxNights:28,depositPct:50,balanceWeeks:4,
                airbnbImportUrl:"https://www.airbnb.co.uk/calendar/ical/15331259.ics?s=SECRET",
                lastSyncedAt:"2026-08-22", bookaletName:"hamlet-old"}];
for (const [k,v] of [["hbf_properties_v1",props],["hbf_terms_v1",{text:"letting terms"}],
                     ["hbf_ticket_terms_v1",{text:"ticket terms"}],
                     ["hawthbush_bookings_v6",[{couple:"Sarah & Tom",email:"s@x.com",phone:"07700900000"}]],
                     ["hbf_accom_v1",[{guestName:"Jane",email:"j@x.com"}]]])
  await c.query("insert into app_data(key,value) values ($1,$2)", [k, JSON.stringify(v)]);

await c.query(fs.readFileSync("phase7-close-app-data.sql","utf8"));

let pass=0, fail=0;
const is=(n,g,w)=>{ if(JSON.stringify(g)===JSON.stringify(w)){pass++;console.log("  ok   "+n);}
                    else {fail++;console.log(`  FAIL ${n}  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);} };
const asRole = async (role, sql, params) => {
  await c.query("begin"); await c.query(`set local role ${role}`);
  try { const r = await c.query(sql, params); await c.query("commit"); return r.rows; }
  catch (e) { await c.query("rollback"); return { error: e.message }; }
};

console.log("\n— what anon can still read from app_data —");
is("the letting terms", (await asRole("anon", "select key from app_data where key='hbf_terms_v1'")).length, 1);
is("the ticket terms",  (await asRole("anon", "select key from app_data where key='hbf_ticket_terms_v1'")).length, 1);

console.log("\n— what anon can no longer read —");
for (const k of ["hawthbush_bookings_v6","hbf_accom_v1","hbf_properties_v1"])
  is(`${k} is closed`, (await asRole("anon", "select key from app_data where key=$1",[k])).length, 0);

console.log("\n— and cannot write —");
const w = await asRole("anon", "insert into app_data(key,value) values ('x','1')");
is("insert refused", !!w.error, true);
const d = await asRole("anon", "delete from app_data where key='hbf_terms_v1'");
is("delete refused", Array.isArray(d) ? d.length===0 : true, true);
is("terms survived the delete attempt",
   (await asRole("anon","select key from app_data where key='hbf_terms_v1'")).length, 1);

console.log("\n— the properties projection —");
const pr = (await asRole("anon","select public_properties() as r"))[0].r;
is("anon gets the properties", pr.length, 1);
is("pricing fields present", [pr[0].id, pr[0].minNights, pr[0].depositPct], ["hamlet", 2, 50]);
is("the Airbnb iCal URL is NOT included", "airbnbImportUrl" in pr[0], false);
is("no secret anywhere in the payload", /SECRET|ical/.test(JSON.stringify(pr)), false);

console.log("\n— signed-in users are unaffected —");
await c.query("begin"); await c.query("set local role authenticated");
const seen = (await c.query("select count(*)::int n from app_data")).rows[0].n;
await c.query("rollback");
is("still reads everything", seen, 5);

console.log("\n— the file bucket —");
is("legacy anon policy gone",
   (await c.query(`select count(*)::int n from pg_policies where tablename='objects' and policyname like 'Allow public%'`)).rows[0].n, 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
await c.end(); process.exit(fail?1:0);
