import fs from "fs"; import pg from "pg";
const c = new pg.Client({host:"127.0.0.1",port:54329,user:"postgres",database:"postgres"});
await c.connect();
await c.query("drop schema if exists public cascade; create schema public;");
await c.query("drop schema if exists auth cascade; create schema auth;");
await c.query("drop schema if exists storage cascade; create schema storage;");
for (const r of ["anon","authenticated","service_role"]) { try { await c.query(`create role ${r} nologin`);} catch(e){} }

// Stand-ins for what Supabase provides.
await c.query(`create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}')`);
await c.query(`create or replace function auth.uid() returns uuid language sql stable
               as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
await c.query(`create table storage.buckets (id text primary key, public boolean)`);
await c.query(`create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text)`);
await c.query(`alter table storage.objects enable row level security`);
await c.query(`insert into storage.buckets values ('booking-files', true)`);
await c.query(`create table app_data (key text primary key, value jsonb, updated_at timestamptz default now())`);
await c.query(`create table profiles (id uuid primary key, email text, role text, active boolean default true)`);

const uid = (await c.query(`insert into auth.users(email) values ('toby@hawthbush') returning id`)).rows[0].id;
await c.query(`insert into profiles(id,email,role) values ($1,'toby@hawthbush','admin')`, [uid]);

await c.query(fs.readFileSync("phase5-6-storage-audit.sql","utf8"));

let pass=0, fail=0;
const is=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);
  if(a===b){pass++;console.log("  ok   "+n);}else{fail++;console.log(`  FAIL ${n}  got ${a} want ${b}`);}};

console.log("\n— phase 5: the bucket —");
is("booking-files is no longer public",
   (await c.query("select public from storage.buckets where id='booking-files'")).rows[0].public, false);
is("four policies guard it",
   Number((await c.query("select count(*) n from pg_policies where tablename='objects' and policyname like 'booking_files%'")).rows[0].n), 4);

console.log("\n— phase 6: who wrote what —");
await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
await c.query(`insert into app_data(key,value) values ('hbf_accom_v1','[{"a":1}]')`);
let row = (await c.query("select actor_email, key, action, bytes from audit_log order by id desc limit 1")).rows[0];
is("a person's write is attributed", { e: row.actor_email, k: row.key, a: row.action }, { e:"toby@hawthbush", k:"hbf_accom_v1", a:"insert" });
is("size is recorded", row.bytes > 0, true);

await c.query(`update app_data set value='[{"a":1},{"b":2}]' where key='hbf_accom_v1'`);
is("an update is recorded too",
   (await c.query("select action from audit_log order by id desc limit 1")).rows[0].action, "update");

console.log("\n— a server write is distinguishable from a person —");
await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
await c.query(`insert into app_data(key,value) values ('hbf_backup_index_v1','[]')`);
row = (await c.query("select actor_id, actor_email from audit_log order by id desc limit 1")).rows[0];
is("no actor id", row.actor_id, null);
is("recorded as the server", row.actor_email, "server");

console.log("\n— append-only, enforced —");
let e1=null, e2=null;
try { await c.query("update audit_log set actor_email='someone else' where id=1"); } catch (e) { e1 = e.message; }
try { await c.query("delete from audit_log where id=1"); } catch (e) { e2 = e.message; }
is("cannot be edited", /append-only/.test(e1 || ""), true);
is("cannot be deleted", /append-only/.test(e2 || ""), true);

console.log("\n— a deletion is still recorded —");
const before = Number((await c.query("select count(*) n from audit_log")).rows[0].n);
await c.query("delete from app_data where key='hbf_backup_index_v1'");
is("deleting a key leaves a trace",
   Number((await c.query("select count(*) n from audit_log")).rows[0].n) > before, true);
is("...and it says so",
   (await c.query("select action, key from audit_log order by id desc limit 1")).rows[0].action, "delete");

console.log(`\n${pass} passed, ${fail} failed\n`);
await c.end(); process.exit(fail?1:0);
