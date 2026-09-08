import fs from "fs"; import pg from "pg";
const c=new pg.Client({host:"127.0.0.1",port:54329,user:"postgres",database:"postgres"});
await c.connect();
await c.query("drop schema if exists public cascade; create schema public;");
for (const r of ["anon","authenticated","service_role"]) { try{await c.query(`create role ${r} nologin`);}catch(e){} }
// Reproduce Supabase's default privileges, which is the whole point.
await c.query(`alter default privileges in schema public grant execute on functions to anon, authenticated, service_role`);
await c.query("grant usage on schema public to anon, authenticated, service_role");
await c.query("create table app_data (key text primary key, value jsonb, updated_at timestamptz default now())");
await c.query(fs.readFileSync("box-office-schema.sql","utf8"));
await c.query(fs.readFileSync("phase1-public-availability.sql","utf8"));

const can = async (role, fn) =>
  (await c.query(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, fn])).rows[0].ok;
const SIG = "box_reserve_order(text,text,text,text,text,text,jsonb,text,text,text)";

let pass=0, fail=0;
const is=(n,g,w)=>{ if(g===w){pass++;console.log("  ok   "+n);} else {fail++;console.log(`  FAIL ${n} got ${g} want ${w}`);} };

console.log("\n— before the fix, reproducing what the audit found —");
is("anon CAN call box_reserve_order (the bug)", await can("anon", SIG), true);

await c.query(fs.readFileSync("FIX-function-grants.sql","utf8"));

console.log("\n— after the fix —");
is("anon cannot call box_reserve_order",          await can("anon", SIG), false);
is("signed-in cannot call box_reserve_order",     await can("authenticated", SIG), false);
is("service role still can",                      await can("service_role", SIG), true);
is("anon cannot call box_expire_holds",           await can("anon", "box_expire_holds()"), false);


console.log("\n— the public pages must keep working —");
for (const f of ["box_public_whats_on()","box_public_event(text,text)","box_my_ticket(text)",
                 "box_join_waitlist(text,text,text,int)","box_check_discount(text,text,int)",
                 "public_accom_busy()","public_viewing_availability()"])
  is(`anon can still call ${f.split("(")[0]}`, await can("anon", f), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
await c.end(); process.exit(fail?1:0);
