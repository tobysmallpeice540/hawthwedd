// supabase/schema-test.mjs
// Checks that box-office-schema.sql does what it claims — including the bit
// that matters most: two people going for the last three tickets means exactly
// one of them gets them.
//
// It needs a throwaway Postgres 16 and the `pg` package. It never touches the
// live database: it drops and rebuilds the public schema on every run, so only
// ever point it at a scratch database.
//
//   createdb boxtest
//   npm install pg
//   node supabase/schema-test.mjs "postgres://localhost/boxtest"
//
// Anything failing here is a reason not to run the schema against Supabase yet.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const CONN = process.argv[2] || process.env.DATABASE_URL;
if (!CONN) {
  console.error("Usage: node supabase/schema-test.mjs <postgres connection string>");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const conn = { connectionString: CONN };

const c = new pg.Client(conn);
await c.connect();

// A clean slate, plus the three roles Supabase provides and a bare Postgres
// does not — the GRANTs at the bottom of the schema name them.
await c.query("drop schema if exists public cascade; create schema public;");
for (const role of ["anon", "authenticated", "service_role"]) {
  try { await c.query(`create role ${role} nologin`); } catch (e) { /* already there */ }
}
await c.query("grant usage on schema public to anon, authenticated, service_role");
await c.query(fs.readFileSync(path.join(here, "box-office-schema.sql"), "utf8"));
console.log("schema applied");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  → " + JSON.stringify(detail) : "")); }
}
const rpc = async (sql, args) => (await c.query(sql, args)).rows[0];

await c.query("delete from box_events");

// ── Fixture: a comedy night, 10 GA at £20 and 4 premium at £30 ───────────────
const ev = (await c.query(`insert into box_events(slug,name,status,starts_at,capacity)
  values ('comedy','Comedy Night','published', now() + interval '30 days', 12) returning *`)).rows[0];
const ga = (await c.query(`insert into box_ticket_types(event_id,name,quantity,price_pence,sort_order)
  values ($1,'General Admission',10,2000,0) returning *`, [ev.id])).rows[0];
const vip = (await c.query(`insert into box_ticket_types(event_id,name,quantity,price_pence,max_per_order,sort_order)
  values ($1,'Premium',4,3000,2,1) returning *`, [ev.id])).rows[0];

const reserve = (args) => rpc(`select box_reserve_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r`, args)
  .then(r => r.r);

console.log("\n— basic reservation —");
let r = await reserve(['comedy','','Jane','Smith','jane@example.com','','[{"ticket_type_id":"'+ga.id+'","qty":2}]',null,'stripe','']);
check("two tickets reserved", r.ok === true, r);
check("total is £40", r.total_pence === 4000, r);
check("reference looks like HB-XXXXX", /^HB-[A-Z0-9]{5}$/.test(r.order_ref), r.order_ref);
check("token is 32 chars, url-safe", r.qr_token.length === 32 && !/[+/]/.test(r.qr_token), r.qr_token);

console.log("\n— per-type maximum —");
r = await reserve(['comedy','','A','B','a@b.com','','[{"ticket_type_id":"'+vip.id+'","qty":3}]',null,'stripe','']);
check("max 2 per order enforced", r.ok === false && r.error === "above_max", r);

console.log("\n— stock —");
r = await reserve(['comedy','','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":9}]',null,'stripe','']);
check("can't take 9 when 8 are left", r.ok === false && r.error === "sold_out", r);
check("says how many are actually left", r.remaining === 8, r);

console.log("\n— overall event capacity (12) beats the type totals (14) —");
// Narrow the room to 6 with 2 already sold: the types still have stock, so
// only the overall cap can refuse this.
await c.query("update box_events set capacity=6 where id=$1", [ev.id]);
r = await reserve(['comedy','','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":8}]',null,'stripe','']);
check("the overall cap refuses what the ticket types would allow", r.ok === false && r.error === "sold_out", r);
check("and says how many the room has left", r.remaining === 4, r);
await c.query("update box_events set capacity=12 where id=$1", [ev.id]);
r = await reserve(['comedy','','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":8},{"ticket_type_id":"'+vip.id+'","qty":2}]',null,'stripe','']);
check("but exactly filling the room is allowed", r.ok === true, r);
await c.query("delete from box_orders where event_id=$1 and first_name='A'", [ev.id]);

console.log("\n— discount codes —");
await c.query(`insert into box_discount_codes(event_id,code,kind,value) values ($1,'TENOFF','percent',10)`, [ev.id]);
await c.query(`insert into box_discount_codes(event_id,code,kind,value) values ($1,'FIVER','fixed',5)`, [ev.id]);
r = await reserve(['comedy','','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":2}]','tenoff','stripe','']);
check("percent code applies (case-insensitive)", r.ok && r.discount_pence === 400 && r.total_pence === 3600, r);
r = await reserve(['comedy','','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":1}]',' fiver ','stripe','']);
check("fixed code applies (trimmed)", r.ok && r.discount_pence === 500 && r.total_pence === 1500, r);
r = await reserve(['comedy','','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":1}]','NOPE','stripe','']);
check("unknown code refused", r.ok === false && r.error === "bad_discount", r);
const chk = (await c.query(`select box_check_discount('comedy','TENOFF',10000) as r`)).rows[0].r;
check("check_discount previews the saving", chk.ok && chk.discount_pence === 1000 && chk.label === "10% off", chk);

console.log("\n— access code —");
await c.query(`update box_events set access_code='BARN26' where id=$1`, [ev.id]);
r = await reserve(['comedy','wrong','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":1}]',null,'stripe','']);
check("wrong code refused at the reserve function", r.ok === false && r.error === "bad_access_code", r);
r = await reserve(['comedy',' barn26 ','A','B','a@b.com','','[{"ticket_type_id":"'+ga.id+'","qty":1}]',null,'stripe','']);
check("right code accepted, trimmed and case-insensitive", r.ok === true, r);
let pub = (await c.query(`select box_public_event('comedy', null) as r`)).rows[0].r;
check("gated event hides its ticket types", pub.ok && pub.gated === true && !pub.ticket_types, pub);
check("gated event still shows name and date", !!pub.name && !!pub.starts_at, pub);
pub = (await c.query(`select box_public_event('comedy','BARN26') as r`)).rows[0].r;
check("correct code opens the page", pub.ok && pub.gated === false && pub.ticket_types.length === 2, pub);
await c.query(`update box_events set access_code=null where id=$1`, [ev.id]);
await c.query(`delete from box_code_attempts`);

console.log("\n— the Christmas party: £75 a head, min 6, £20 deposit —");
const xmas = (await c.query(`insert into box_events(slug,name,status,starts_at,payment_mode,deposit_pence,balance_days,min_per_order)
  values ('xmas','Christmas Party','published', now() + interval '90 days','deposit',2000,30,6) returning *`)).rows[0];
const seat = (await c.query(`insert into box_ticket_types(event_id,name,quantity,price_pence)
  values ($1,'Seat',60,7500) returning *`, [xmas.id])).rows[0];
r = await reserve(['xmas','','A','B','a@b.com','','[{"ticket_type_id":"'+seat.id+'","qty":4}]',null,'stripe','']);
check("a table of four is refused (minimum six)", r.ok === false && r.error === "below_event_min", r);
r = await reserve(['xmas','','Tom','Reed','tom@example.com','','[{"ticket_type_id":"'+seat.id+'","qty":6}]',null,'stripe','']);
check("a table of six is allowed", r.ok === true, r);
check("£120 today", r.deposit_pence === 12000, r);
check("£330 owing", r.balance_pence === 33000, r);
check("£450 total", r.total_pence === 45000, r);
check("balance due 30 days before", r.balance_due_on !== null, r);
check("pay now = the deposit", r.pay_now_pence === 12000, r);

console.log("\n— no QR before the balance is paid —");
let mine = (await c.query(`select box_my_ticket($1) as r`, [r.qr_token])).rows[0].r;
check("my-ticket shows the booking", mine.ok === true, mine);
check("but reports no tickets issued", mine.tickets_issued === false, mine);
check("and states the balance", mine.balance_pence === 33000, mine);

console.log("\n— two buyers, three tickets left —");
await c.query(`delete from box_orders where event_id=$1`, [ev.id]);
await c.query(`update box_ticket_types set quantity=3 where id=$1`, [ga.id]);
await c.query(`update box_events set capacity=null where id=$1`, [ev.id]);
const a = new pg.Client(conn); await a.connect();
const b = new pg.Client(conn); await b.connect();
await a.query("begin"); await b.query("begin");
const call = `select box_reserve_order('comedy','','X','Y','x@y.com','','[{"ticket_type_id":"${ga.id}","qty":3}]',null,'stripe','') as r`;
const pa = a.query(call);
// b starts a moment later and must block on the row lock a holds
await new Promise(res => setTimeout(res, 120));
const pb = b.query(call);
const ra = (await pa).rows[0].r;
await a.query("commit");
const rb = (await pb).rows[0].r;
await b.query("commit");
check("first buyer gets the last three", ra.ok === true, ra);
check("second buyer is refused, not oversold", rb.ok === false && rb.error === "sold_out", rb);
const sold = (await c.query(`select box_sold_total($1) as n`, [ev.id])).rows[0].n;
check("exactly three sold in total", Number(sold) === 3, sold);
await a.end(); await b.end();

console.log("\n— the 15-minute hold —");
let held = (await c.query(`select box_sold_total($1) as n`, [ev.id])).rows[0].n;
check("a pending order holds its seats", Number(held) === 3, held);
await c.query(`update box_orders set created_at = now() - interval '20 minutes' where event_id=$1`, [ev.id]);
held = (await c.query(`select box_sold_total($1) as n`, [ev.id])).rows[0].n;
check("after 15 minutes it releases them by itself", Number(held) === 0, held);
r = await reserve(['comedy','','Late','Buyer','late@example.com','','[{"ticket_type_id":"'+ga.id+'","qty":3}]',null,'stripe','']);
check("so the next buyer can have them", r.ok === true, r);

console.log("\n— hygiene —");
await c.query(`update box_orders set created_at = now() - interval '3 hours' where status='pending'`);
const removed = (await c.query(`select box_expire_holds() as n`)).rows[0].n;
check("expire_holds clears abandoned checkouts", Number(removed) > 0, removed);

console.log("\n— what's on —");
await c.query(`update box_events set listed=true, status='published'`);
const listing = (await c.query(`select box_public_whats_on() as r`)).rows[0].r;
check("lists published events", listing.length === 2, listing.map(x=>x.slug));
await c.query(`update box_events set listed=false where slug='xmas'`);
const listing2 = (await c.query(`select box_public_whats_on() as r`)).rows[0].r;
check("an unlisted event is filtered out in Postgres", listing2.length === 1 && listing2[0].slug === "comedy", listing2);

console.log("\n— waitlist —");
await c.query(`update box_events set waitlist_on=true where slug='comedy'`);
let w = (await c.query(`select box_join_waitlist('comedy','Ann','ann@example.com',2) as r`)).rows[0].r;
check("joins the waitlist", w.ok === true && w.already === false, w);
w = (await c.query(`select box_join_waitlist('comedy','Ann','ANN@example.com',2) as r`)).rows[0].r;
check("a second go is treated as a misclick", w.ok === true && w.already === true, w);

console.log(`\n${pass} passed, ${fail} failed\n`);
await c.end();
process.exit(fail ? 1 : 0);
