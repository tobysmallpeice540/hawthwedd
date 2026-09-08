import fs from "fs"; import pg from "pg";
const c = new pg.Client({host:"127.0.0.1",port:54329,user:"postgres",database:"postgres"});
await c.connect();
await c.query("drop schema if exists public cascade; create schema public;");
for (const r of ["anon","authenticated","service_role"]) { try { await c.query(`create role ${r} nologin`);} catch(e){} }
await c.query("create table app_data (key text primary key, value jsonb, updated_at timestamptz default now())");

// Fixtures deliberately mixing the shapes the real data actually contains.
const accom = [
  { id:"W1", status:"confirmed", guestName:"Jane Smith", email:"j@x.com", phone:"07700 900001", value:1200,
    stays:[{propertyId:"hamlet", checkIn:"2026-06-01", checkOut:"2026-06-05"},
           {propertyId:"amly",   checkIn:"2026-06-01", checkOut:"2026-06-03"}] },
  { id:"W2", status:"pending",   guestName:"Tom Reed", email:"t@x.com",
    stays:[{propertyId:"hamlet", checkIn:"2026-07-10", checkOut:"2026-07-12"}] },
  { id:"W3", status:"cancelled", guestName:"Gone Away", email:"g@x.com",
    stays:[{propertyId:"hamlet", checkIn:"2026-08-01", checkOut:"2026-08-04"}] },
  // legacy flat record, no stays[]
  { id:"W4", status:"confirmed", guestName:"Old Format", email:"o@x.com",
    propertyId:"camping", checkIn:"2026-09-01", checkOut:"2026-09-03" },
  // junk that must be skipped rather than crash
  { id:"W5", status:"confirmed", guestName:"No dates", stays:[{propertyId:"hamlet"}] },
];
const bookings = [
  { id:1, couple:"Sarah & Tom", date:"2026-05-01", email:"s@x.com", phone:"07700 900002",
    viewings:[{date:"2026-03-01", time:"10:00"}] },
  { id:2, couple:"Ann & Bo",   date:"2026-05-09", email:"a@x.com" },
  { id:3, couple:"",           date:"2026-05-20" },            // no couple → not an event day
];
const enquiries = [
  { id:"enq_1", name:"Enq One", email:"e1@x.com", viewings:[{date:"2026-03-02", time:"14:00"}] },
  { id:"enq_2", name:"Enq Two", email:"e2@x.com" },
];
const requests = [
  { id:"r1", status:"confirmed", date:"2026-03-03", time:"11:00", name:"Req One", email:"r1@x.com" },
  { id:"r2", status:"pending",   date:"2026-03-04", time:"11:00", name:"Req Two", email:"r2@x.com" },
];
const blocks = [
  { date:"2026-03-05", slot:"10:00", kind:"block" },
  { date:"2026-03-06", kind:"open" },
  { date:"2026-03-07" },                                        // no kind → treated as a block
];
for (const [k,v] of [["hbf_accom_v1",accom],["hawthbush_bookings_v6",bookings],
                     ["hbf_enquiries_v1",enquiries],["hbf_viewing_requests_v1",requests],
                     ["hbf_viewing_blocks_v1",blocks]])
  await c.query("insert into app_data(key,value) values ($1,$2)", [k, JSON.stringify(v)]);

await c.query(fs.readFileSync("phase1-public-availability.sql","utf8"));

let pass=0, fail=0;
const is=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);
  if(a===b){pass++;console.log("  ok   "+n);}else{fail++;console.log("  FAIL "+n+"\n        got  "+a+"\n        want "+b);}};

// ── What the OLD client-side code would compute, verbatim from book-accom.html
function oldBusy(list){const out=[];list.forEach(b=>{ if(b.status==="cancelled")return;
  const stays=(b.stays&&b.stays.length)?b.stays:[b];
  stays.forEach(st=>{ if(!st.propertyId||!st.checkIn||!st.checkOut)return;
    out.push({propertyId:st.propertyId,checkIn:st.checkIn,checkOut:st.checkOut});});});return out;}

const busy = (await c.query("select public_accom_busy() as r")).rows[0].r;
const key = a => a.map(x=>`${x.propertyId}|${x.checkIn}|${x.checkOut}`).sort();

console.log("\n— cottage availability: new function vs the old client-side logic —");
is("identical set of occupied stays", key(busy), key(oldBusy(accom)));
is("cancelled booking frees its dates", busy.some(b=>b.checkIn==="2026-08-01"), false);
is("pending booking still holds its dates", busy.some(b=>b.checkIn==="2026-07-10"), true);
is("legacy flat record handled", busy.some(b=>b.propertyId==="camping"), true);
is("multi-property booking yields both stays", busy.filter(b=>b.checkIn==="2026-06-01").length, 2);
is("incomplete stay skipped, not crashed", busy.filter(b=>!b.checkIn).length, 0);
is("no guest details leak", JSON.stringify(busy).match(/Jane|Smith|@x\.com|07700|1200/), null);

console.log("\n— viewing availability —");
const va = (await c.query("select public_viewing_availability() as r")).rows[0].r;
const takenKey = va.taken.map(t=>`${t.date} ${t.time}`).sort();
is("viewings from weddings, enquiries and confirmed requests", takenKey,
   ["2026-03-01 10:00","2026-03-02 14:00","2026-03-03 11:00"]);
is("an unconfirmed request does not hold a slot", takenKey.includes("2026-03-04 11:00"), false);
is("blocks carried through", va.blocks.length, 3);
is("a block with no kind defaults to 'block'",
   va.blocks.find(b=>b.date==="2026-03-07").kind, "block");
is("an opening keeps its kind", va.blocks.find(b=>b.date==="2026-03-06").kind, "open");
is("event days are dates only", va.eventDays.sort(), ["2026-05-01","2026-05-09"]);
is("a record with no couple is not an event day", va.eventDays.includes("2026-05-20"), false);
is("no couple names, emails or phones leak",
   JSON.stringify(va).match(/Sarah|Tom|Ann|Enq|@x\.com|07700/), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
await c.end(); process.exit(fail?1:0);
