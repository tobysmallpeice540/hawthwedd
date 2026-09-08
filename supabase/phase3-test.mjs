import fs from "fs"; import pg from "pg";
const c = new pg.Client({host:"127.0.0.1",port:54329,user:"postgres",database:"postgres"});
await c.connect();
await c.query("drop schema if exists public cascade; create schema public;");
await c.query("drop schema if exists auth cascade; create schema auth;");
for (const r of ["anon","authenticated","service_role"]) { try { await c.query(`create role ${r} nologin`);} catch(e){} }

// Minimal stand-ins for what Supabase provides.
await c.query(`create table auth.users (id uuid primary key default gen_random_uuid(),
                 email text, raw_user_meta_data jsonb default '{}'::jsonb)`);
await c.query(`create or replace function auth.uid() returns uuid language sql stable
               as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);

// An account that exists BEFORE the migration, to exercise the backfill.
const pre = (await c.query(`insert into auth.users(email) values ('old@hawthbush') returning id`)).rows[0].id;

await c.query(fs.readFileSync("phase3-auth.sql","utf8"));

let pass=0, fail=0;
const is=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);
  if(a===b){pass++;console.log("  ok   "+n);}else{fail++;console.log("  FAIL "+n+"  got "+a+" want "+b);}};

console.log("\n— profiles —");
is("pre-existing account was backfilled",
   (await c.query("select role from profiles where id=$1",[pre])).rows[0]?.role, "bar");

const nu = (await c.query(`insert into auth.users(email) values ('new@hawthbush') returning id`)).rows[0].id;
is("trigger creates a profile on signup",
   (await c.query("select role,active from profiles where id=$1",[nu])).rows[0], {role:"bar", active:true});

const ad = (await c.query(`insert into auth.users(email, raw_user_meta_data)
  values ('boss@hawthbush', '{"role":"admin","name":"Toby"}') returning id`)).rows[0].id;
is("role and name can be set at signup",
   (await c.query("select role,name from profiles where id=$1",[ad])).rows[0], {role:"admin", name:"Toby"});

let bad = null;
try { await c.query(`insert into auth.users(email, raw_user_meta_data) values ('x@y','{"role":"superuser"}')`); }
catch (e) { bad = e.code; }
is("an invented role is rejected", bad, "23514");

console.log("\n— my_profile() resolves the caller —");
await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [ad]);
is("returns the signed-in user's role", (await c.query("select my_profile() as p")).rows[0].p.role, "admin");
await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [nu]);
is("and follows who is asking", (await c.query("select my_profile() as p")).rows[0].p.role, "bar");

console.log("\n— row level security on profiles —");
await c.query("grant usage on schema public to authenticated");
await c.query(`set role authenticated`);
await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [nu]);
const seen = (await c.query("select id from profiles")).rows;
await c.query("reset role");
is("a signed-in user sees only their own profile", seen.length, 1);
is("...and it is theirs", seen[0].id, nu);

console.log(`\n${pass} passed, ${fail} failed\n`);
await c.end(); process.exit(fail?1:0);
