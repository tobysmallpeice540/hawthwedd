import { useState, useEffect, useCallback, useRef } from "react";

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";

const sbGet = async (key) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/app_data?key=eq.${key}&select=value`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const rows = await res.json();
  return rows?.[0]?.value ?? null;
};

const sbSet = async (key, value) => {
  await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
  });
};

// ─── SUPABASE STORAGE HELPERS ──────────────────────────────────────────────
const STORAGE_BUCKET = "booking-files";

const sbUploadFile = async (path, file) => {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": file.type || "application/octet-stream",
      "x-upsert": "true",
    },
    body: file,
  });
  if (!res.ok) throw new Error(await res.text());
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
};

const sbDeleteFile = async (path) => {
  await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [path] }),
  });
};


const LOGO_B64 = "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";


const T = {
  bg:          "#f0f6ff",
  bgCard:      "#ffffff",
  bgHeader:    "#ffffff",
  bgInput:     "#f8fafd",
  border:      "#c8d9ef",
  borderFocus: "#2563eb",
  text:        "#1a2d4a",
  textMid:     "#3d5a7a",
  textLight:   "#7a9bbf",
  accent:      "#2563eb",
  accentHov:   "#1d4ed8",
  accentLight: "#dbeafe",
  accentMid:   "#3b82f6",
  midBlue:     "#1e4d8c",
  midBlueBg:   "#e8f0fc",
  green:       "#16a34a",
  greenBg:     "#dcfce7",
  red:         "#dc2626",
  redBg:       "#fee2e2",
  amber:       "#d97706",
  amberBg:     "#fef3c7",
  headerText:  "#1a2d4a",
  navActive:   "#2563eb",
  navInactive: "#5a7a9a",
  chipBgs:     ["#dbeafe","#d1fae5","#fce7f3","#e0e7ff","#fef3c7","#f3e8ff","#ffedd5","#e0f2fe"],
  chipTexts:   ["#1e40af","#065f46","#9d174d","#3730a3","#92400e","#6b21a8","#9a3412","#075985"],
};

// ─── CONFIRM DIALOG ───────────────────────────────────────────────────────────
function ConfirmDialog({ message, subMessage, confirmLabel="Delete", onConfirm, onCancel }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,30,60,.45)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={onCancel}>
      <div style={{ background:"#fff", borderRadius:12, padding:"28px 32px", maxWidth:400, width:"90%", boxShadow:"0 16px 48px rgba(0,0,0,.18)", border:`1px solid ${T.border}` }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ width:44, height:44, borderRadius:"50%", background:T.redBg, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:16 }}>
          <span style={{ fontSize:22 }}>🗑</span>
        </div>
        <div style={{ fontSize:16, fontWeight:700, color:T.text, marginBottom:8 }}>{message}</div>
        {subMessage && <div style={{ fontSize:13, color:T.textMid, marginBottom:20, lineHeight:1.5 }}>{subMessage}</div>}
        <div style={{ display:"flex", gap:10, marginTop:20 }}>
          <button onClick={onConfirm} style={{ flex:1, background:T.red, color:"#fff", border:"none", padding:"11px", borderRadius:7, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700 }}>{confirmLabel}</button>
          <button onClick={onCancel}  style={{ flex:1, background:"#fff", color:T.textMid, border:`1.5px solid ${T.border}`, padding:"11px", borderRadius:7, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600 }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function parseMoney(val) {
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[^0-9.]/g,""));
  return isNaN(n) ? 0 : n;
}

function dayOfWeek(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long" });
}

const DAY_COLOURS = {
  Monday:    { bg:"#e0f2fe", text:"#075985" },
  Tuesday:   { bg:"#f0fdf4", text:"#166534" },
  Wednesday: { bg:"#fef9c3", text:"#854d0e" },
  Thursday:  { bg:"#fdf4ff", text:"#6b21a8" },
  Friday:    { bg:"#fff7ed", text:"#9a3412" },
  Saturday:  { bg:"#fce7f3", text:"#9d174d" },
  Sunday:    { bg:"#fee2e2", text:"#991b1b" },
};

function DayBadge({ dateStr, style={} }) {
  const day = dayOfWeek(dateStr);
  if (!day) return null;
  const c = DAY_COLOURS[day] || { bg: T.midBlueBg, text: T.midBlue };
  return (
    <span style={{ fontSize:11, fontWeight:700, padding:"2px 8px", borderRadius:10, background:c.bg, color:c.text, whiteSpace:"nowrap", ...style }}>
      {day}
    </span>
  );
}

const INITIAL_STAFF = [
  { id:"TM",  name:"Taryn May",           email:"Taryn.may@hotmail.co.uk",       phone:"", rate:"£15 incl Roll Up", role:"Bar Supervisor", active:true, notes:"" },
  { id:"OK",  name:"Olive Kaufmann",      email:"130478@leeds-art.ac.uk",         phone:"", rate:"£14 incl Roll Up", role:"Bar Staff",       active:true, notes:"" },
  { id:"AC",  name:"Aggie Chapman",       email:"aggiechapman10@gmail.com",       phone:"", rate:"£14 incl Roll Up", role:"Bar Staff",       active:true, notes:"" },
  { id:"BeW", name:"Ben Williams",        email:"ben.oscar.williams1@gmail.com",  phone:"", rate:"£10 inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"OH",  name:"Oli Hammond",         email:"oliver.l.hammond@gmail.com",     phone:"", rate:"£10 inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"AP",  name:"Archie Proctor",      email:"archiehp46@icloud.com",          phone:"", rate:"£14 inc Roll Up",  role:"Handy",           active:true, notes:"" },
  { id:"RM",  name:"Rafferty Massingham", email:"Raffgang@icloud.com",            phone:"", rate:"£12 Inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"EP",  name:"Edie",               email:"ediepops46@outlook.com",          phone:"", rate:"£12 Inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"AK",  name:"Ash Kawakita",        email:"akawakita98@gmail.com",          phone:"", rate:"£14 inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"CK",  name:"Connor Keely",        email:"Conor.keeley@icloud.com",        phone:"", rate:"£12 Inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"JD",  name:"Jane Davison",        email:"dressesbyjane@hotmail.co.uk",    phone:"", rate:"£15 incl Roll Up", role:"Day Manager",     active:true, notes:"" },
  { id:"OM",  name:"Ollie Murphy",        email:"olliemur_1@icloud.com",          phone:"", rate:"£14 Inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"RC",  name:"Rose Chaplin",        email:"rchaplin892@gmail.com",          phone:"", rate:"£14 Inc Roll Up",  role:"Bar Staff",       active:true, notes:"" },
  { id:"LM",  name:"Lani Mohan",          email:"lanimahon@icloud.com",           phone:"", rate:"",                 role:"Bar Staff",       active:true, notes:"" },
  { id:"BW",  name:"Bonnie Whitmore",     email:"",                               phone:"", rate:"",                 role:"Day Manager",     active:true, notes:"Inferred from bookings" },
  { id:"TF",  name:"Tom Faulkner",        email:"",                               phone:"", rate:"",                 role:"Day Manager",     active:true, notes:"Inferred from bookings" },
  { id:"BoW", name:"Bo Williams",         email:"",                               phone:"", rate:"",                 role:"Bar Staff",       active:true, notes:"Inferred from bookings" },
  { id:"KN",  name:"KN (Unknown)",        email:"",                               phone:"", rate:"",                 role:"Bar Staff",       active:true, notes:"Initials only — update name" },
];

const INITIAL_BOOKINGS = [
  { id:1,  status:"Confirmed", couple:"Alice Smith Birthday party Barn",         date:"2025-01-24", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"100", mealChildren:"", mealBabies:"", eveGuests:"", phone:"44 7557 598 231", email:"alicelouise90@hotmail.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"yes", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"", hamletBooked:"yes", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroInvoices:[], payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:2,  status:"Confirmed", couple:"Jason Lindfield & Lindy Anderson",        date:"2026-05-23", setup:["TF"], dayManager:["TF"], dayStaff:["RM","AK","OH"], barSupervisor:["TM"], sunday:["KN"], bar:["AK","RM","EP"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"120", mealChildren:"20", mealBabies:"", eveGuests:"120", phone:"", email:"jasonlindfield@ohmenergy.co.uk", email2:"lindyclaire@hotmail.com", ceremony:"NO", guestArrivalTime:"13:00", caterers:"12:00 External caterers arrive, 14:00 Food served 15:00-17:00 Ice Cream & Bubbles Van", foodTruck:"Miky Dough Pizzas", eveFood:"Bucking Broncho", otherVendors:"YES £760", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"3270", deposit:"1000", payment2:"1015", finalPayment:"3095", extras:"Food trucks: up to 3 vendors, waive usual £100 per vendor fee. ALL INVOICES PAID", corkage:"£9 per adult - 100 guests invoiced", pets:"", hairdresser:"", florist:"", band:"16:00-17:00 live music, DJ from 17:00", paSystem:"", notes:"", hoursWorked:{} },
  { id:3,  status:"Confirmed", couple:"Sam Adams & Sarah Precious",              date:"2026-05-30", setup:["BW"], dayManager:["BW"], dayStaff:["JD","BoW","OH"], barSupervisor:["TM"], sunday:[], bar:["AK","OH"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"62", mealChildren:"", mealBabies:"", eveGuests:"62", phone:"07551 801563", email:"sarahp001@hotmail.co.uk", email2:"", ceremony:"Clearing 15:00PM", guestArrivalTime:"14:00 for canapes & drinks", caterers:"12:00 Circa", foodTruck:"none", eveFood:"CIRCA", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"yes", hamletFee:"2790", campingBooked:"no", campingFee:"", nonStandard:"Round tables being delivered day tbc with Circa.", venueFee:"5100", deposit:"1000", payment2:"3935", finalPayment:"4641.8", extras:"Need to find quiet place for Sam to do interview with registrars", corkage:"£9.50 - they are supplying the coffee and tea", pets:"", hairdresser:"9:30 on the day", florist:"10:00 am on the set up Mother-in-law", band:"21:00 Duke of Havoc", paSystem:"", notes:"", hoursWorked:{} },
  { id:4,  status:"Confirmed", couple:"Natalia Szczepanska & Simon Rosenhead",   date:"2026-06-06", setup:["BW"], dayManager:["JD"], dayStaff:["CK","BoW","AK"], barSupervisor:["TM"], sunday:[], bar:["AK","EP","OH"], dayHandy:["TF"], eveHandy:["AP"], mealGuests:"80", mealChildren:"2", mealBabies:"", eveGuests:"80", phone:"7972280260", email:"Natalia_kim@hotmail.com", email2:"", ceremony:"Clearing 13:00", guestArrivalTime:"13:00", caterers:"Circa", foodTruck:"Circa Pizza", eveFood:"CIRCA", otherVendors:"", amlyBooked:"yes", amlyFee:"950", hamletBooked:"yes", hamletFee:"2678", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"4950", deposit:"1000", payment2:"3289", finalPayment:"5481", extras:"", corkage:"£12 plus VAT per guest if 80-90 guests", pets:"", hairdresser:"", florist:"Big Field Flowers", band:"Steel Pan Man", paSystem:"SENT TO JAMES", notes:"", hoursWorked:{} },
  { id:5,  status:"Confirmed", couple:"Richard Mann & Leanne",                   date:"2026-06-12", setup:["BW"], dayManager:["BW"], dayStaff:["BoW","OM","RC","OH"], barSupervisor:["JD"], sunday:[], bar:["AK","EP","CK","OM","RC"], dayHandy:["TF"], eveHandy:["AP","TF"], mealGuests:"106", mealChildren:"", mealBabies:"", eveGuests:"225", phone:"07833 615851", email:"mannroofing@aol.com", email2:"leannesfarley1985@outlook.com", ceremony:"Clearing 13:00", guestArrivalTime:"12:30", caterers:"Greg Churcher - will arrive 10:00", foodTruck:"tbc", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"1230", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"NEED TO ADD £250 FOR A 3RD NIGHT IN AMLY", venueFee:"5190", deposit:"1000", payment2:"2085", finalPayment:"", extras:"", corkage:"9.50 corkage", pets:"", hairdresser:"", florist:"", band:"Our PA guy 10:30am, band 1pm, done by 3:30pm", paSystem:"", notes:"Friday wedding", hoursWorked:{} },
  { id:6,  status:"Confirmed", couple:"Ruby Gislingham & Jack",                  date:"2026-06-20", setup:["BW"], dayManager:["JD"], dayStaff:["BoW","RM","AK"], barSupervisor:["OK"], sunday:["OK"], bar:["AK","RM","TM","BoW"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"86", mealChildren:"", mealBabies:"", eveGuests:"130", phone:"7528350684", email:"rubyjgis@hotmail.com", email2:"jackrowland4@gmail.com", ceremony:"Clearing (non-legal ceremony) Celebrant James", guestArrivalTime:"", caterers:"Circa", foodTruck:"Circa", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"780", hamletBooked:"yes", hamletFee:"2790", campingBooked:"yes", campingFee:"2200", nonStandard:"£500 agreed discount for booking by end of Jan 2025", venueFee:"4600", deposit:"1000", payment2:"4185", finalPayment:"", extras:"", corkage:"INVOICED £9.50 plus VAT for 75-80. HAWTHBUSH TO SUPPLY TEA & COFFEE", pets:"", hairdresser:"", florist:"Mum is doing flowers", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:7,  status:"Confirmed", couple:"Rosa Lavelle-Hill & Sam",                 date:"2026-06-27", setup:["BW"], dayManager:["BW"], dayStaff:["BeW"], barSupervisor:["OK"], sunday:["OK"], bar:["BeW"], dayHandy:["TF"], eveHandy:["TF"], mealGuests:"74", mealChildren:"10", mealBabies:"", eveGuests:"85", phone:"7717126690", email:"rosaellenlavellehill@gmail.com", email2:"", ceremony:"Clearing 2:00pm", guestArrivalTime:"", caterers:"Circa", foodTruck:"The Real Pizza Company £100 charge", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"780", hamletBooked:"yes", hamletFee:"2790", campingBooked:"yes", campingFee:"1495", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"4127.5", finalPayment:"", extras:"", corkage:"TO INVOICE TBC - quoted higher 26 corkage prices", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:8,  status:"Confirmed", couple:"Rosie Latawski & Tim",                    date:"2026-07-04", setup:["JD"], dayManager:["JD"], dayStaff:[], barSupervisor:["TM"], sunday:["OK"], bar:[], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"72", mealChildren:"10", mealBabies:"3", eveGuests:"72", phone:"07740 265594", email:"rosieandtimwedding26@gmail.com", email2:"", ceremony:"1:00pm Friends hosting ceremony", guestArrivalTime:"12:30/12:45 (meeting first at the tap rooms)", caterers:"Circa", foodTruck:"Circa", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"yes", hamletFee:"2790", campingBooked:"yes", campingFee:"2500", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"4730", finalPayment:"", extras:"HIGH CHAIRS - 3 tbc - poss looking for babysitting service", corkage:"TO INVOICE CORKAGE - Standard corkage which will finish around 6pm", pets:"", hairdresser:"", florist:"Rosies mum doing flowers", band:"Marmalade First dance 7:45pm", paSystem:"", notes:"", hoursWorked:{} },
  { id:9,  status:"Confirmed", couple:"Lucyanne Mathews & Marcus Brasier",       date:"2026-07-11", setup:["BW"], dayManager:["BW"], dayStaff:[], barSupervisor:["TM"], sunday:[], bar:[], dayHandy:["TF"], eveHandy:["AP"], mealGuests:"90", mealChildren:"", mealBabies:"", eveGuests:"25", phone:"", email:"lamatthews@hgluk.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"Circa", foodTruck:"tbc", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"no", hamletFee:"", campingBooked:"yes", campingFee:"2500", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"3335", finalPayment:"", extras:"", corkage:"TO INVOICE CORKAGE TBC", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:10, status:"Confirmed", couple:"Yasmin Roberts & Jack Crisp",             date:"2026-07-18", setup:["BW"], dayManager:["JD"], dayStaff:[], barSupervisor:["TM"], sunday:[], bar:[], dayHandy:["TF"], eveHandy:["AP"], mealGuests:"105", mealChildren:"", mealBabies:"", eveGuests:"20", phone:"07535 326046", email:"Yasmin.Roberts@baw.live", email2:"", ceremony:"1:30PM", guestArrivalTime:"", caterers:"Circa", foodTruck:"Pizza van in eve", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"yes", hamletFee:"2750", campingBooked:"no", campingFee:"", nonStandard:"Waiting for signatures. £150+VAT cake cutting. £100+VAT pizza van.", venueFee:"5190", deposit:"1000", payment2:"3460", finalPayment:"", extras:"", corkage:"Standard corkage TBC", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:11, status:"Confirmed", couple:"Jenny Lippiatt & Laurence Organ-Jennings",date:"2026-07-25", setup:["BW"], dayManager:["BW"], dayStaff:["BeW"], barSupervisor:["OK"], sunday:["OK"], bar:["TM","BeW"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"100", mealChildren:"", mealBabies:"4", eveGuests:"0", phone:"07504732555", email:"jennyandlaurence@outlook.com", email2:"", ceremony:"2:00pm Clearing", guestArrivalTime:"", caterers:"Circa", foodTruck:"tbc", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"730", hamletBooked:"yes", hamletFee:"2790", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"3355", finalPayment:"", extras:"", corkage:"Standard corkage - wine being delivered on the Friday", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:12, status:"Confirmed", couple:"Diene Petterle & Tom Mitchelson",         date:"2026-08-01", setup:["BW"], dayManager:["TM"], dayStaff:[], barSupervisor:["OK"], sunday:["OK"], bar:["TM"], dayHandy:["TF"], eveHandy:["AP"], mealGuests:"65", mealChildren:"", mealBabies:"", eveGuests:"", phone:"07949 653646", email:"dienepetterle@gmail.com", email2:"tommitchelson@hotmail.com", ceremony:"", guestArrivalTime:"", caterers:"Circa", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"yes", hamletFee:"2790", campingBooked:"yes", campingFee:"2500", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"4730", finalPayment:"", extras:"", corkage:"Waiting for confirmation", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:13, status:"Confirmed", couple:"Aimee Fenn & Henry Stephens",             date:"2026-08-05", setup:["BW"], dayManager:["BW","TM"], dayStaff:["BeW"], barSupervisor:["OK"], sunday:["OK"], bar:["TM","BeW"], dayHandy:["TF"], eveHandy:["AP"], mealGuests:"80", mealChildren:"25", mealBabies:"", eveGuests:"0", phone:"", email:"aimeefenn88@gmail.com", email2:"hostepo@gmai.com", ceremony:"2pm - friend not legal ceremony", guestArrivalTime:"", caterers:"Sienna Pizza - no need to access kitchen", foodTruck:"Sienna + Ice Cream van", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"yes", hamletFee:"2790", campingBooked:"yes", campingFee:"1600", nonStandard:"£100 x 2 for the food trucks", venueFee:"5190", deposit:"1000", payment2:"3480", finalPayment:"", extras:"", corkage:"Standard corkage package", pets:"4 tiny dogs - agreed would allow to stay for half price!!", hairdresser:"", florist:"Aimee is organising all the flowers", band:"", paSystem:"", notes:"Wednesday wedding. Invoice sent 04/11/2025 awaiting payment", hoursWorked:{} },
  { id:14, status:"Confirmed", couple:"Gabrielle Aron & Tommy Ramsay",           date:"2026-08-08", setup:["BW"], dayManager:["BW"], dayStaff:["BeW"], barSupervisor:["OK"], sunday:["OK"], bar:["TM","BeW"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"100", mealChildren:"", mealBabies:"", eveGuests:"", phone:"7927593896", email:"gtaronramsay@gmail.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"Circa", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"Having a ceilidh", venueFee:"5190", deposit:"1000", payment2:"2085", finalPayment:"", extras:"", corkage:"corkage WITH 20% discount", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:15, status:"Confirmed", couple:"Louise Berry & Gren",                     date:"2026-08-15", setup:["BW"], dayManager:["JD"], dayStaff:[], barSupervisor:["OK"], sunday:["OK"], bar:["TM"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"50", mealChildren:"", mealBabies:"", eveGuests:"50", phone:"05522 787324", email:"louiseberry00@hotmail.co.uk", email2:"", ceremony:"Yes", guestArrivalTime:"", caterers:"Circa", foodTruck:"tbc", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"2085", finalPayment:"", extras:"", corkage:"Standard corkage confirmed", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:16, status:"Confirmed", couple:"Em Hodson & Robert ODonoghue",           date:"2026-08-22", setup:["BW"], dayManager:["BW"], dayStaff:["BeW"], barSupervisor:["OK"], sunday:["OK"], bar:["TM","BeW"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"95", mealChildren:"", mealBabies:"", eveGuests:"0", phone:"7532290198", email:"emrobodonoghue@gmail.com", email2:"", ceremony:"Clearing tbc", guestArrivalTime:"", caterers:"Circa", foodTruck:"tbc", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"yes", hamletFee:"2750", campingBooked:"yes", campingFee:"2500", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"4730", finalPayment:"", extras:"", corkage:"Standard corkage TBC", pets:"Jura - need to charge for 1 dog", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:17, status:"Confirmed", couple:"Ellie Bradley & Ashley Williams",         date:"2026-09-05", setup:["BW"], dayManager:["JD"], dayStaff:["BeW"], barSupervisor:["TM"], sunday:[], bar:["BeW"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"80", mealChildren:"", mealBabies:"", eveGuests:"80", phone:"07527 163713", email:"elizabeth.bradley994@gmail.com", email2:"", ceremony:"Clearing 2:30 PM", guestArrivalTime:"", caterers:"Circa", foodTruck:"tbc", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"780", hamletBooked:"yes", hamletFee:"2790", campingBooked:"yes", campingFee:"2500", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"4630", finalPayment:"", extras:"", corkage:"TO INVOICE CORKAGE - 61-90 Guests £10.50+VAT pp", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:18, status:"Confirmed", couple:"Hannah & Johnny",                         date:"2026-09-18", setup:["BW"], dayManager:["BW"], dayStaff:["BeW"], barSupervisor:["TM"], sunday:[], bar:[], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"75", phone:"", email:"hannahbergin@live.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"Circa TBC", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"780", hamletBooked:"yes", hamletFee:"2790", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"4190", deposit:"1000", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"Friday wedding", hoursWorked:{} },
  { id:19, status:"Confirmed", couple:"Holly Freeman & Cameron",                 date:"2026-09-26", setup:[], dayManager:["JD"], dayStaff:[], barSupervisor:["TM"], sunday:[], bar:[], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"50", mealChildren:"", mealBabies:"", eveGuests:"15", phone:"7429762459", email:"hollyfreeman@hotmail.co.uk", email2:"", ceremony:"Clearing tbc", guestArrivalTime:"", caterers:"£100+VAT 5pm external catering truck", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"5190", deposit:"1000", payment2:"2085", finalPayment:"3085", extras:"£100+VAT for external food truck", corkage:"", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:20, status:"Confirmed", couple:"Emily Hudson & Ed",                       date:"2026-10-03", setup:["BW"], dayManager:["BW"], dayStaff:["BeW"], barSupervisor:["TM"], sunday:[], bar:["BeW"], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"80", mealChildren:"", mealBabies:"", eveGuests:"80", phone:"7479043253", email:"emilyrosehudson@gmail.com", email2:"edmund.pearce@hotmail.co.uk", ceremony:"Clearing", guestArrivalTime:"", caterers:"Circa", foodTruck:"tbc", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"980", hamletBooked:"yes", hamletFee:"3885", campingBooked:"no", campingFee:"", nonStandard:"£500 discount agreed as out of season wedding.", venueFee:"5190", deposit:"1000", payment2:"4027.5", finalPayment:"", extras:"", corkage:"£10.50+VAT for 61-90 guests", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:21, status:"Confirmed", couple:"Emily Cave & Daniel",                     date:"2026-11-28", setup:["BW"], dayManager:["BW"], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:["AP"], eveHandy:["AP"], mealGuests:"80", mealChildren:"", mealBabies:"", eveGuests:"", phone:"7479043253", email:"thebookgirlandgamerguy26@outlook.com", email2:"", ceremony:"Clearing", guestArrivalTime:"", caterers:"TBC", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"780", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"£500 discount", venueFee:"4140", deposit:"", payment2:"1460", finalPayment:"", extras:"", corkage:"", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  // ── 2027 bookings ──────────────────────────────────────────────────────────
  { id:200, status:"Confirmed", couple:"Liz Newall TBC",           date:"2027-06-03", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"", email:"betcarter@hotmail.co.uk", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"600", deposit:"600", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:201, status:"Holding",   couple:"Jason McGeorge & Becky",   date:"2027-07-05", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"Becky 07796 138545", email:"jasonmcgeorge45@gmail.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroInvoices:[], payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:202, status:"Confirmed", couple:"Imogen Parr & Jack",       date:"2027-06-12", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"07766998811", email:"jackmeach@hotmail.com", email2:"imogenfjparr@gmail.com", ceremony:"13:00", guestArrivalTime:"", caterers:"Circa", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroInvoices:[], payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:203, status:"Confirmed", couple:"Tessa Taylor & Isaac",     date:"2027-06-19", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"66 adults + 3 or 4 children", mealChildren:"", mealBabies:"", eveGuests:"110 in total", phone:"", email:"tessa-taylor@hotmail.co.uk", email2:"", ceremony:"12:30 tbc", guestArrivalTime:"", caterers:"Cashew Catering or Isaac's brother", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"1.45pm drinks, food 3-4.30/5. Eve guests ~5-6pm", venueFee:"", deposit:"", payment2:"", finalPayment:"", extras:"", corkage:"£9.50 daytime, £5.00+VAT evening", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:204, status:"Confirmed", couple:"Chloé & Ewan",             date:"2027-07-03", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"50 + 20 children", mealChildren:"", mealBabies:"", eveGuests:"", phone:"", email:"chloe-louiseb@hotmail.co.uk", email2:"", ceremony:"1:00pm", guestArrivalTime:"", caterers:"Bay Tree (10% commission)", foodTruck:"£150+VAT pizza van", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"£150 for cake cutting", venueFee:"", deposit:"", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:205, status:"Confirmed", couple:"Lydia and Rob",            date:"2027-07-10", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"tbc", mealChildren:"", mealBabies:"", eveGuests:"tbc", phone:"", email:"lydsandrobwedding@gmail.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"Circa", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"", hamletBooked:"yes", hamletFee:"", campingBooked:"yes", campingFee:"", nonStandard:"", venueFee:"", deposit:"1000", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:206, status:"Confirmed", couple:"Anna & Jasper",            date:"2027-07-24", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"", email:"annafarnfield@hotmail.co.uk", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"1000", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:207, status:"Confirmed", couple:"Megan Grover & Simon",     date:"2027-07-30", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"85 approx", mealChildren:"", mealBabies:"", eveGuests:"", phone:"7905777283", email:"groverdalywedding2027@gmail.com", email2:"", ceremony:"1pm in clearing", guestArrivalTime:"", caterers:"Likely Circa", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"", hamletBooked:"yes", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"1000", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:208, status:"Confirmed", couple:"Tom and Becky",            date:"2027-08-21", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"", email:"saltdeanbeach@gmail.com", email2:"", ceremony:"Time tbc", guestArrivalTime:"", caterers:"Possibly brother", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"1000", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:209, status:"Holding",   couple:"Liberty Kimber and Toby",  date:"2027-08-28", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"", email:"", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"Awaiting completed forms", venueFee:"", deposit:"", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:210, status:"Confirmed", couple:"Rachel Daly & Luke",       date:"2027-09-11", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"100 tbc", mealChildren:"", mealBabies:"", eveGuests:"20 tbc", phone:"07714 068219", email:"racheldaly_10@hotmail.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"Pizza trucks etc", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"1000", payment2:"2325", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
];

const STAFFING_FIELDS = ["dayManager","dayStaff","barSupervisor","sunday","bar","dayHandy","eveHandy"];
const STAFFING_LABELS = { dayManager:"Day Manager", dayStaff:"Day Staff", barSupervisor:"Bar Supervisor", sunday:"Sunday", bar:"Bar", dayHandy:"Day Handy", eveHandy:"Eve Handy" };

const BOOKING_STORAGE = "hawthbush_bookings_v6";
const STAFF_STORAGE   = "hawthbush_staff_v5";

// ─── STAFF CHIP ───────────────────────────────────────────────────────────────
function StaffChip({ initials, staff, size="sm" }) {
  const person = staff.find(s=>s.id===initials);
  const name = person ? person.name : initials;
  const idx = (initials||"").split("").reduce((a,c)=>a+c.charCodeAt(0),0) % T.chipBgs.length;
  return (
    <span title={name} style={{ display:"inline-flex", alignItems:"center", background:T.chipBgs[idx], color:T.chipTexts[idx], borderRadius:4, padding:size==="sm"?"2px 8px":"4px 12px", fontSize:size==="sm"?11:13, marginRight:4, marginBottom:3, whiteSpace:"nowrap", fontWeight:600 }}>
      {size==="sm" ? initials : name}
    </span>
  );
}


// ─── GMAIL LINK ───────────────────────────────────────────────────────────────
function GmailLink({ email }) {
  if (!email) return null;
  const url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(email)}`;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      title={`Search Gmail for ${email}`}
      style={{ display:"inline-flex", alignItems:"center", gap:4, fontSize:11, fontWeight:600, color:"#db4437", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:4, padding:"2px 8px", textDecoration:"none", flexShrink:0, whiteSpace:"nowrap" }}
      onClick={e=>e.stopPropagation()}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.910 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>
      Gmail
    </a>
  );
}

// ─── STAFF PICKER ─────────────────────────────────────────────────────────────
function StaffPicker({ label, value=[], onChange, staff }) {
  const [open, setOpen] = useState(false);
  const toggle = id => onChange(value.includes(id) ? value.filter(v=>v!==id) : [...value, id]);
  const activeStaff = staff.filter(s=>s.active);
  return (
    <div style={{ position:"relative" }}>
      <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:5, fontWeight:600 }}>{label}</label>
      <div onClick={()=>setOpen(!open)} style={{ minHeight:36, background:T.bgInput, border:`1.5px solid ${open?T.borderFocus:T.border}`, borderRadius:6, padding:"4px 10px", cursor:"pointer", display:"flex", flexWrap:"wrap", alignItems:"center", gap:2, boxShadow:open?"0 0 0 3px #dbeafe":"none", transition:"all .15s" }}>
        {value.length===0 && <span style={{ color:T.textLight, fontSize:13 }}>Select staff…</span>}
        {value.map(id=><StaffChip key={id} initials={id} staff={staff}/>)}
        <span style={{ marginLeft:"auto", color:T.textLight, fontSize:10 }}>▾</span>
      </div>
      {open && (
        <div style={{ position:"absolute", zIndex:200, top:"100%", left:0, right:0, background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, maxHeight:220, overflowY:"auto", boxShadow:"0 8px 24px rgba(0,0,0,.12)" }}>
          {activeStaff.map(s=>{
            const sel = value.includes(s.id);
            return (
              <div key={s.id} onClick={()=>toggle(s.id)} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", cursor:"pointer", background:sel?T.accentLight:"none", borderBottom:`1px solid ${T.border}` }}
                onMouseEnter={e=>e.currentTarget.style.background=sel?T.accentLight:"#f0f6ff"}
                onMouseLeave={e=>e.currentTarget.style.background=sel?T.accentLight:"none"}>
                <span style={{ width:18, height:18, border:`2px solid ${sel?T.accent:T.border}`, borderRadius:4, background:sel?T.accent:"none", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:"#fff", flexShrink:0 }}>{sel?"✓":""}</span>
                <StaffChip initials={s.id} staff={staff}/>
                <span style={{ fontSize:13, color:T.text }}>{s.name}</span>
                <span style={{ marginLeft:"auto", fontSize:11, color:T.textLight }}>{s.role}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── INPUT HELPERS ────────────────────────────────────────────────────────────
const IS = (f) => ({ width:"100%", background:T.bgInput, border:`1.5px solid ${f?T.borderFocus:T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box", boxShadow:f?"0 0 0 3px #dbeafe":"none", transition:"all .15s" });
function FLabel({ children, required }) {
  return <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:5, fontWeight:600 }}>{children}{required&&<span style={{ color:T.red, marginLeft:4 }}>*</span>}</label>;
}
function FInput({ value, onChange, type="text", placeholder="" }) {
  const [f,setF] = useState(false);
  return <input type={type} value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder} onFocus={()=>setF(true)} onBlur={()=>setF(false)} style={IS(f)} />;
}
function FTextarea({ value, onChange, rows=3 }) {
  const [f,setF] = useState(false);
  return <textarea value={value||""} onChange={e=>onChange(e.target.value)} rows={rows} onFocus={()=>setF(true)} onBlur={()=>setF(false)} style={{ ...IS(f), resize:"vertical" }} />;
}
function FCheck({ checked, onChange, label, bold }) {
  return (
    <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", userSelect:"none" }}>
      <span style={{ width:20, height:20, border:`2px solid ${checked?T.accent:T.border}`, borderRadius:4, background:checked?T.accent:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#fff", flexShrink:0, transition:"all .15s" }}>{checked?"✓":""}</span>
      <span style={{ fontSize:bold?15:14, color:T.text, fontWeight:bold?600:400 }}>{label}</span>
    </label>
  );
}

// ─── ACCOMMODATION FIELD ──────────────────────────────────────────────────────
function AccomField({ bookedKey, feeKey, paid50Key, paid100Key, label, formData, update }) {
  const [f,setF] = useState(false);
  const val = formData[bookedKey] || "undecided";
  const isYes = val === "yes";
  const bgMap = { yes: T.accentLight, no: T.redBg, undecided: T.amberBg };
  const borderMap = { yes: T.accentMid, no: "#fca5a5", undecided: "#fcd34d" };
  return (
    <div style={{ background:bgMap[val]||T.bgInput, border:`1.5px solid ${borderMap[val]||T.border}`, borderRadius:8, padding:"14px 16px", transition:"all .2s" }}>
      <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:12 }}>
        <span style={{ fontSize:15, fontWeight:600, color:T.text, minWidth:70 }}>{label}</span>
        <select value={val} onChange={e=>update(bookedKey,e.target.value)}
          style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"6px 10px", outline:"none", cursor:"pointer" }}>
          <option value="undecided">Undecided</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
        {isYes && (
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:13, color:T.textMid, fontWeight:500 }}>Fee: £</span>
            <input type="number" value={formData[feeKey]||""} onChange={e=>update(feeKey,e.target.value)} placeholder="0"
              onFocus={()=>setF(true)} onBlur={()=>setF(false)}
              style={{ width:90, background:"#fff", border:`1.5px solid ${f?T.borderFocus:T.border}`, borderRadius:6, color:T.text, fontSize:14, padding:"6px 10px", outline:"none", boxShadow:f?"0 0 0 3px #dbeafe":"none" }} />
          </div>
        )}
        {isYes && paid50Key && (
          <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", fontSize:13, color:T.textMid, whiteSpace:"nowrap" }}>
            <input type="checkbox" checked={!!formData[paid50Key]} onChange={e=>update(paid50Key,e.target.checked)} style={{ width:14, height:14, accentColor:T.accent, cursor:"pointer" }}/>
            50% paid
          </label>
        )}
        {isYes && paid100Key && (
          <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", fontSize:13, color:T.textMid, whiteSpace:"nowrap" }}>
            <input type="checkbox" checked={!!formData[paid100Key]} onChange={e=>update(paid100Key,e.target.checked)} style={{ width:14, height:14, accentColor:T.accent, cursor:"pointer" }}/>
            100% paid
          </label>
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [bookings, setBookings] = useState([]);
  const [staff, setStaff]       = useState([]);
  const [view, setView]         = useState("list");
  const [editId, setEditId]     = useState(null);
  const [formData, setFormData] = useState(null);
  const [search, setSearch]     = useState("");
  const [reportType, setReportType] = useState("summary");
  const [loaded, setLoaded]     = useState(false);
  const [enquiries, setEnquiries] = useState([]);
  const [editStaffId, setEditStaffId] = useState(null);
  const [staffForm, setStaffForm]     = useState(null);

  useEffect(()=>{
    (async()=>{
      try {
        const raw = (await sbGet(BOOKING_STORAGE)) || INITIAL_BOOKINGS;
        const migrated = raw.map(b => ({
          ...b,
          amlyBooked:    b.amlyBooked === true ? "yes" : b.amlyBooked === false ? "no" : b.amlyBooked || "no",
          hamletBooked:  b.hamletBooked === true ? "yes" : b.hamletBooked === false ? "no" : b.hamletBooked || "no",
          campingBooked: b.campingBooked === true ? "yes" : b.campingBooked === false ? "no" : b.campingBooked || "no",
          status: b.status || "Confirmed",
          eventType: b.eventType || "Wedding (Peak)",
          depositPaid: b.depositPaid || false,
          xeroInvoices: b.xeroInvoices || [],
        }));
        setBookings(migrated);
      } catch { setBookings(INITIAL_BOOKINGS); }
      try { const r = await sbGet(STAFF_STORAGE); setStaff(r || INITIAL_STAFF); } catch { setStaff(INITIAL_STAFF); }
      try { const r = await sbGet(ENQUIRIES_STORAGE); setEnquiries(r || []); } catch { setEnquiries([]); }
      setLoaded(true);
    })();
  },[]);

  const saveBookings = useCallback(async data=>{ setBookings(data); try{await sbSet(BOOKING_STORAGE, data);}catch(e){console.error(e);} },[]);
  const saveStaff    = useCallback(async data=>{ setStaff(data);    try{await sbSet(STAFF_STORAGE, data);}catch(e){console.error(e);} },[]);

  const emptyBooking = ()=>({ couple:"", date:"", status:"Confirmed", eventType:"Wedding (Peak)", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"", email:"", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"undecided", amlyFee:"", amly50Paid:false, amly100Paid:false, hamletBooked:"undecided", hamletFee:"", hamlet50Paid:false, hamlet100Paid:false, campingBooked:"undecided", campingFee:"", camping50Paid:false, camping100Paid:false, nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroInvoices:[], payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} });

  const safeArr = v => Array.isArray(v) ? v : [];
  const [confirmDlg, setConfirmDlg] = useState(null);
  const askConfirm = (message, subMessage, onConfirm) => setConfirmDlg({ message, subMessage, onConfirm });

  const handleNew    = ()=>{ setFormData(emptyBooking()); setEditId(null); setView("form"); };
  const handleEdit   = id=>{ const b=bookings.find(x=>x.id===id); setFormData({...b, setup:safeArr(b.setup), dayManager:safeArr(b.dayManager), dayStaff:safeArr(b.dayStaff), barSupervisor:safeArr(b.barSupervisor), sunday:safeArr(b.sunday), bar:safeArr(b.bar), dayHandy:safeArr(b.dayHandy), eveHandy:safeArr(b.eveHandy) }); setEditId(id); setView("form"); };
  const handleDelete = id => {
    const b = bookings.find(x=>x.id===id);
    askConfirm("Delete this booking?", `"${b?.couple||"This booking"}" will be permanently removed.`,
      async () => { setConfirmDlg(null); await saveBookings(bookings.filter(x=>x.id!==id)); });
  };
  const handleSubmit = async ()=>{
    if(!formData.couple||!formData.date){ alert("Couple name and date are required."); return; }
    let updated;
    if(editId) updated=bookings.map(b=>b.id===editId?{...formData,id:editId}:b);
    else { const newId=Math.max(0,...bookings.map(b=>b.id))+1; updated=[...bookings,{...formData,id:newId}]; }
    updated=updated.sort((a,b)=>a.date>b.date?1:-1);
    await saveBookings(updated); setView("list");
  };

  const emptyStaff = ()=>({ id:"", name:"", email:"", phone:"", rate:"", role:"Bar Staff", active:true, notes:"" });
  const handleNewStaff    = ()=>{ setStaffForm(emptyStaff()); setEditStaffId(null); };
  const handleEditStaff   = id=>{ const s=staff.find(x=>x.id===id); setStaffForm({...s}); setEditStaffId(id); };
  const handleDeleteStaff = id => {
    const s = staff.find(x=>x.id===id);
    askConfirm("Remove this staff member?", `${s?.name||"This person"} will be removed from the staff database. They will still appear on any existing bookings.`,
      async () => { setConfirmDlg(null); await saveStaff(staff.filter(x=>x.id!==id)); });
  };
  const handleSubmitStaff = async ()=>{
    if(!staffForm.id||!staffForm.name){ alert("Initials and name are required."); return; }
    let updated;
    if(editStaffId) updated=staff.map(s=>s.id===editStaffId?{...staffForm}:s);
    else { if(staff.find(s=>s.id===staffForm.id)){ alert(`Initials "${staffForm.id}" already exists.`); return; } updated=[...staff,staffForm]; }
    await saveStaff(updated); setStaffForm(null); setEditStaffId(null);
  };

  const filtered = bookings.filter(b=>{ const q=search.toLowerCase(); return !q||(b.couple||"").toLowerCase().includes(q)||(b.email||"").toLowerCase().includes(q)||(b.date||"").includes(q); });

  if(!loaded) return <div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:T.bg,color:T.accent,fontFamily:"system-ui,sans-serif",fontSize:20 }}>Loading…</div>;

  return (
    <div style={{ minHeight:"100vh", background:T.bg, color:T.text, fontFamily:"system-ui,-apple-system,sans-serif" }}>
      {confirmDlg && <ConfirmDialog message={confirmDlg.message} subMessage={confirmDlg.subMessage} onConfirm={confirmDlg.onConfirm} onCancel={()=>setConfirmDlg(null)}/>}
      <Header view={view} setView={setView} onNew={handleNew}/>
      <div style={{ maxWidth:1240, margin:"0 auto", padding:"0 24px 60px" }}>
        {view==="list"    && <ListView bookings={filtered} search={search} setSearch={setSearch} onEdit={handleEdit} onDelete={handleDelete} onNew={handleNew} staff={staff}/>}
        {view==="form"    && <FormView formData={formData} setFormData={setFormData} onSubmit={handleSubmit} onCancel={()=>setView("list")} isEdit={!!editId} staff={staff}
          onAutoSave={async(fd)=>{ if(!fd.couple||!fd.date) return; let updated; if(editId) updated=bookings.map(b=>b.id===editId?{...fd,id:editId}:b); else { const newId=Math.max(0,...bookings.map(b=>b.id))+1; updated=[...bookings,{...fd,id:newId}]; } await saveBookings(updated.sort((a,b)=>a.date>b.date?1:-1)); }}
        />}
        {view==="staff"   && <StaffView staff={staff} bookings={bookings} staffForm={staffForm} setStaffForm={setStaffForm} editStaffId={editStaffId} onNew={handleNewStaff} onEdit={handleEditStaff} onDelete={handleDeleteStaff} onSubmit={handleSubmitStaff} onCancel={()=>{setStaffForm(null);setEditStaffId(null);}}/>}
        {view==="bar"        && <BarView/>}
        {view==="enquiries"  && <EnquiriesView/>}
        {view==="viewings"   && <ViewingsView bookings={bookings} setView={setView} onEditBooking={handleEdit} onSelectEnquiry={id=>{/* handled inside EnquiriesView */}}/>}
        {view==="reports"    && <ReportsView bookings={bookings} staff={staff} reportType={reportType} setReportType={setReportType} enquiries={enquiries}/>}
      </div>
    </div>
  );
}

// ─── HEADER ───────────────────────────────────────────────────────────────────
function Header({ view, setView, onNew }) {
  const tabs = [{id:"enquiries",label:"Enquiries"},{id:"list",label:"Bookings"},{id:"viewings",label:"Viewings"},{id:"staff",label:"Staff"},{id:"bar",label:"Bar"},{id:"reports",label:"Reports"}];
  return (
    <header style={{ background:"#ffffff", borderBottom:`2px solid ${T.border}`, padding:"0 28px", display:"flex", alignItems:"center", gap:0, boxShadow:"0 2px 12px rgba(37,99,235,.08)" }}>
      <div style={{ display:"flex", alignItems:"center", marginRight:36, padding:"8px 0", flexShrink:0 }}>
        <img src={`data:image/png;base64,${LOGO_B64}`} alt="Hawthbush Farm" style={{ height:52, width:"auto", imageRendering:"crisp-edges" }} />
      </div>
      <nav style={{ display:"flex", gap:0, flex:1 }}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setView(t.id)} style={{ background:"none", border:"none", color:view===t.id?T.navActive:T.navInactive, fontFamily:"inherit", fontSize:14, fontWeight:view===t.id?700:400, padding:"22px 20px 18px", cursor:"pointer", borderBottom:view===t.id?`3px solid ${T.accent}`:"3px solid transparent", transition:"all .2s", letterSpacing:.2 }}>{t.label}</button>
        ))}
      </nav>
      <button onClick={onNew} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"9px 22px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600, boxShadow:"0 2px 8px rgba(30,77,140,.25)", flexShrink:0 }}>
        + New Booking
      </button>
    </header>
  );
}

// ─── BOOKINGS LIST ────────────────────────────────────────────────────────────
function ListView({ bookings, search, setSearch, onEdit, onDelete, onNew, staff }) {
  const today = new Date().toISOString().slice(0,10);
  const upcoming = bookings.filter(b=>b.date>=today);
  const past     = bookings.filter(b=>b.date<today);
  return (
    <div>
      <div style={{ padding:"28px 0 18px", display:"flex", alignItems:"center", gap:14 }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name, email or date…"
          style={{ flex:1, background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:8, color:T.text, fontFamily:"inherit", fontSize:14, padding:"10px 14px", outline:"none", boxShadow:"0 1px 3px rgba(37,99,235,.06)" }}/>
        <span style={{ color:T.textLight, fontSize:13, flexShrink:0 }}>{bookings.length} booking{bookings.length!==1?"s":""}</span>
      </div>
      {search ? <BookingTable rows={bookings} onEdit={onEdit} onDelete={onDelete} label="Results" staff={staff}/> : <>
        <BookingTable rows={upcoming} onEdit={onEdit} onDelete={onDelete} label="Upcoming" staff={staff}/>
        {past.length>0 && <BookingTable rows={past} onEdit={onEdit} onDelete={onDelete} label="Past" dimmed staff={staff}/>}
      </>}
      {bookings.length===0 && <div style={{ textAlign:"center", padding:60, color:T.textLight }}><p style={{ fontSize:18, marginBottom:16 }}>No bookings yet</p><button onClick={onNew} style={{ background:T.accent, color:"#fff", border:"none", padding:"11px 28px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:15 }}>Create First Booking</button></div>}
    </div>
  );
}

function BookingTable({ rows, onEdit, onDelete, label, dimmed, staff }) {
  if(rows.length===0) return null;
  return (
    <div style={{ marginBottom:36 }}>
      <h3 style={{ color:T.midBlue, fontSize:11, letterSpacing:2, textTransform:"uppercase", marginBottom:10, fontWeight:700 }}>{label} ({rows.length})</h3>
      <div style={{ background:"#fff", borderRadius:10, border:`1px solid ${T.border}`, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", opacity:dimmed?.65:1 }}>
          <thead>
            <tr style={{ background:"#eef4fd", borderBottom:`1px solid ${T.border}` }}>
              {["Date","Day","Couple / Event","Day Guests","Eve Guests","Venue Fee","Accommodation","Status","Payment","Viewings","Files"].map(h=>(
                <th key={h} style={{ color:T.textMid, fontSize:11, letterSpacing:1.2, textTransform:"uppercase", padding:"10px 12px", textAlign:"left", fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b,i)=>{
              const paid=parseMoney(b.deposit)+parseMoney(b.payment2)+parseMoney(b.finalPayment);
              const total=parseMoney(b.venueFee), balance=total-paid, isFullyPaid=total>0&&balance<=0;
              const accomBadges = [];
              if(b.amlyBooked==="yes")    accomBadges.push("Amly");
              if(b.hamletBooked==="yes")  accomBadges.push("Hamlet");
              if(b.campingBooked==="yes") accomBadges.push("Camping");
              return (
                <tr key={b.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none", transition:"background .12s", cursor:"pointer" }}
                  onClick={()=>onEdit(b.id)}
                  onMouseEnter={e=>e.currentTarget.style.background="#f0f6ff"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.accent, whiteSpace:"nowrap", fontWeight:600 }}>{b.date?new Date(b.date+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"}):"—"}</td>
                  <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}><DayBadge dateStr={b.date}/></td>
                  <td style={{ padding:"10px 12px", maxWidth:180 }}>
                    <div style={{ fontWeight:600, color:T.text, fontSize:14 }}>{b.couple||"—"}</div>
                  </td>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.textMid }}>{b.mealGuests||"—"}</td>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.textMid }}>{b.eveGuests||"—"}</td>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.text, fontWeight:500 }}>{total>0?`£${total.toLocaleString()}`:"—"}</td>
                  <td style={{ padding:"10px 12px" }}>
                    {accomBadges.length===0 ? <span style={{ color:T.textLight, fontSize:11 }}>—</span>
                      : accomBadges.map(a=><span key={a} style={{ fontSize:10, background:T.midBlueBg, color:T.midBlue, borderRadius:4, padding:"2px 6px", marginRight:3, fontWeight:600 }}>{a}</span>)}
                  </td>
                  <td style={{ padding:"10px 12px" }}>
                    {b.status==="Holding"
                      ? <span style={{ fontSize:11, padding:"3px 9px", borderRadius:12, background:"#fef9c3", color:"#854d0e", fontWeight:600 }}>Holding</span>
                      : b.status==="Confirmed"
                        ? <span style={{ fontSize:11, padding:"3px 9px", borderRadius:12, background:T.greenBg, color:T.green, fontWeight:600 }}>Confirmed</span>
                        : <span style={{ color:T.textLight, fontSize:11 }}>—</span>}
                  </td>
                  <td style={{ padding:"10px 12px" }}>
                    {total>0?(<span style={{ fontSize:11, padding:"3px 9px", borderRadius:12, background:isFullyPaid?T.greenBg:balance>0?T.amberBg:T.redBg, color:isFullyPaid?T.green:balance>0?T.amber:T.red, fontWeight:600 }}>{isFullyPaid?"✓ Paid":balance>0?`£${balance.toLocaleString()} due`:"Overpaid"}</span>):<span style={{ color:T.textLight,fontSize:11 }}>—</span>}
                  </td>
                  <td style={{ padding:"10px 12px", minWidth:120 }}>
                    {(b.viewings||[]).length===0
                      ? <span style={{ color:T.textLight, fontSize:11 }}>—</span>
                      : <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                          {[...(b.viewings||[])].sort((a,z)=>a.date>z.date?1:-1).map((v,i)=>(
                            <div key={i} style={{ fontSize:10, background:T.midBlueBg, color:T.midBlue, borderRadius:4, padding:"2px 6px", whiteSpace:"nowrap", fontWeight:600 }}>
                              📅 {v.date}{v.time?" "+v.time:""}
                            </div>
                          ))}
                        </div>
                    }
                  </td>
                  <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}>
                    {(()=>{
                      const bFiles = b.files||[];
                      const has = (type) => bFiles.some(f=>f.docType===type);
                      const Tick = ({label,short}) => (
                        <span title={label} style={{ display:"inline-flex",alignItems:"center",justifyContent:"center",width:24,height:20,borderRadius:4,marginRight:2,fontSize:9,fontWeight:700,background:has(label)?T.greenBg:"#f1f5f9",color:has(label)?T.green:T.textLight,border:`1px solid ${has(label)?"#86efac":T.border}` }}>{short}</span>
                      );
                      return <div style={{display:"flex",alignItems:"center",gap:1}}>
                        <Tick label="Event Booking Form" short="EBF"/>
                        <Tick label="Accommodation Booking Form" short="ABF"/>
                        <Tick label="Event Timesheet" short="TS"/>
                      </div>;
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── FORM ─────────────────────────────────────────────────────────────────────
const EVENT_TYPES = ["Wedding (Peak)","Wedding (Off Peak)","Party","Wake","Other"];

const TEXT_FIELDS = [
  { key:"couple",          label:"Couple / Event Name",  type:"text",     section:"core",     required:true },
  { key:"date",            label:"Event Date",            type:"date",     section:"core",     required:true },
  { key:"status",          label:"Status",                type:"select",   section:"core",     options:["Confirmed","Holding"] },
  { key:"eventType",       label:"Event Type",            type:"select",   section:"core",     options:EVENT_TYPES },
  { key:"pets",            label:"Pets",                  type:"text",     section:"core" },
  { key:"notes",           label:"Internal Notes",        type:"textarea", section:"core" },
  { key:"venueFee",        label:"Venue Fee (£)",         type:"number",   section:"financials" },
  { key:"deposit",         label:"Deposit (£)",           type:"number",   section:"financials" },
  { key:"payment2",        label:"2nd Payment (£)",       type:"number",   section:"financials" },
  { key:"finalPayment",    label:"Final Payment (£)",     type:"number",   section:"financials" },
  { key:"mealGuests",      label:"Adults (meal)",         type:"number",   section:"guests" },
  { key:"mealChildren",    label:"Children (meal)",       type:"number",   section:"guests" },
  { key:"mealBabies",      label:"Babies (meal)",         type:"number",   section:"guests" },
  { key:"eveGuests",       label:"Evening Guests (total)", type:"number",   section:"guests" },
  { key:"phone",           label:"Phone",                 type:"text",     section:"contact" },
  { key:"email",           label:"Email",                 type:"email",    section:"contact" },
  { key:"email2",          label:"2nd Email",             type:"email",    section:"contact" },
  { key:"ceremony",        label:"Ceremony / Clearing",   type:"text",     section:"vendors" },
  { key:"guestArrivalTime",label:"Guest Arrival Time",    type:"text",     section:"vendors" },
  { key:"caterers",        label:"Caterers",              type:"text",     section:"vendors" },
  { key:"foodTruck",       label:"Food Truck",            type:"text",     section:"vendors" },
  { key:"eveFood",         label:"Evening Food",          type:"text",     section:"vendors" },
  { key:"otherVendors",    label:"Other Vendors",         type:"text",     section:"vendors" },
  { key:"florist",         label:"Florist",               type:"text",     section:"vendors" },
  { key:"band",            label:"Band / Entertainment",  type:"text",     section:"vendors" },
  { key:"paSystem",        label:"PA System",             type:"text",     section:"vendors" },
  { key:"hairdresser",     label:"Hairdresser",           type:"text",     section:"vendors" },
  { key:"corkage",          label:"Corkage",               type:"text",     section:"financials" },
  { key:"barTakeGross",     label:"Bar Take Gross (£)",    type:"number",   section:"financials" },
  { key:"circaCommission",  label:"Circa Commission (£)",  type:"number",   section:"financials" },
];

const FORM_SECTIONS = {
  core:       { label:"Event Details" },
  financials: { label:"Financials & Accom" },
  guests:     { label:"Guests" },
  contact:    { label:"Contact" },
  staffing:   { label:"Staffing" },
  vendors:    { label:"Vendors & Logistics" },
  viewings:   { label:"Viewings" },
  files:      { label:"Files" },
};

function FormView({ formData, setFormData, onSubmit, onCancel, isEdit, staff, onAutoSave }) {
  const [activeSection, setActiveSection] = useState("core");
  const update = (key,val) => setFormData(f=>({...f,[key]:val}));

  const countFilled = s => {
    if(s==="staffing") return ["setup",...STAFFING_FIELDS].filter(k=>(formData[k]||[]).length>0).length;
    if(s==="viewings") return (formData.viewings||[]).length;
    if(s==="files") return (formData.files||[]).length;
    if(s==="financials") return ["venueFee","deposit","corkage","barTakeGross","circaCommission","nonStandard","amlyBooked","hamletBooked","campingBooked"].filter(k=>formData[k]&&formData[k]!=="undecided").length;
    return TEXT_FIELDS.filter(f=>f.section===s&&formData[f.key]).length;
  };
  const countTotal = s => {
    if(s==="staffing") return 1+STAFFING_FIELDS.length;
    if(s==="viewings") return (formData.viewings||[]).length || 1;
    if(s==="files") return (formData.files||[]).length || 1;
    if(s==="financials") return 9;
    return TEXT_FIELDS.filter(f=>f.section===s).length;
  };

  return (
    <div style={{ paddingTop:28 }}>
      <div style={{ position:"sticky", top:0, zIndex:50, background:"#f0f6ff", border:`1px solid ${T.border}`, borderRadius:10, padding:"12px 18px", marginBottom:18, boxShadow:"0 2px 8px rgba(37,99,235,.10)", display:"flex", alignItems:"center", gap:14 }}>
        <button onClick={onCancel} style={{ background:"#fff", border:`1px solid ${T.border}`, color:T.textMid, cursor:"pointer", fontSize:13, fontFamily:"inherit", padding:"6px 14px", borderRadius:6, flexShrink:0 }}>← Back</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:18, color:T.midBlue, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {formData.couple || (isEdit ? "Edit Booking" : "New Booking")}
          </div>
          {(formData.date || formData.eventType) && (
            <div style={{ fontSize:12, color:T.textMid, marginTop:2, display:"flex", alignItems:"center", gap:8 }}>
              {formData.date && <span>{new Date(formData.date+"T00:00:00").toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"long",year:"numeric"})}</span>}
              {formData.eventType && <span style={{ background:T.midBlueBg, color:T.midBlue, borderRadius:4, padding:"1px 7px", fontSize:11, fontWeight:600 }}>{formData.eventType}</span>}
            </div>
          )}
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"200px 1fr", gap:20 }}>
        <div>
          <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            {Object.keys(FORM_SECTIONS).map(s=>{
              const filled=countFilled(s), total=countTotal(s), active=activeSection===s;
              return (
                <button key={s} onClick={()=>setActiveSection(s)} style={{ display:"block", width:"100%", textAlign:"left", padding:"11px 14px", background:active?"#eef4fd":"none", border:"none", borderLeft:active?`3px solid ${T.accent}`:"3px solid transparent", borderBottom:`1px solid ${T.border}`, color:active?T.accent:T.textMid, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:active?700:400 }}>
                  <span style={{ display:"block" }}>{FORM_SECTIONS[s].label}</span>
                  <span style={{ fontSize:10, opacity:.65, color:active?T.accent:T.textLight }}>{filled}/{total} filled</span>
                </button>
              );
            })}
          </div>
          <div style={{ marginTop:16, display:"flex", flexDirection:"column", gap:8 }}>
            <button onClick={onSubmit} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"12px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700, boxShadow:"0 2px 8px rgba(30,77,140,.25)" }}>{isEdit?"Save Changes":"Create Booking"}</button>
            <button onClick={onCancel} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"11px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13 }}>Cancel</button>
          </div>
        </div>

        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:28, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <h3 style={{ margin:"0 0 22px", color:T.midBlue, fontWeight:700, fontSize:17, borderBottom:`2px solid ${T.border}`, paddingBottom:12 }}>{FORM_SECTIONS[activeSection].label}</h3>

          {activeSection==="staffing" && (
            <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
              <StaffPicker label="Set-Up (who sets up the venue)" value={formData.setup||[]} onChange={val=>update("setup",val)} staff={staff}/>
              {STAFFING_FIELDS.map(key=>(
                <StaffPicker key={key} label={STAFFING_LABELS[key]} value={formData[key]||[]} onChange={val=>update(key,val)} staff={staff}/>
              ))}
              {/* Shift times per person */}
              {(() => {
                const allIds = [...new Set(["setup",...STAFFING_FIELDS].flatMap(k=>formData[k]||[]))];
                if (allIds.length === 0) return null;
                const shifts = formData.staffShifts || {};
                const updateShift = (id, field, val) => {
                  const updated = { ...shifts, [id]: { ...(shifts[id]||{}), [field]: val } };
                  update("staffShifts", updated);
                };
                return (
                  <div>
                    <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:12, marginTop:4, borderTop:`1px solid ${T.border}`, paddingTop:16 }}>Shift Times (optional)</div>
                    <p style={{ fontSize:12, color:T.textLight, margin:"0 0 12px" }}>Set start and end times for each assigned staff member — used for the Staff Timeline report.</p>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {allIds.map(id => {
                        const person = staff.find(s=>s.id===id);
                        const sh = shifts[id] || {};
                        const tStyle = { background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"5px 8px", outline:"none", width:100 };
                        return (
                          <div key={id} style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 12px", background:T.bgInput, borderRadius:8, border:`1px solid ${T.border}` }}>
                            <StaffChip initials={id} staff={staff}/>
                            <span style={{ flex:1, fontSize:13, color:T.text, fontWeight:500 }}>{person?.name||id}</span>
                            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                              <label style={{ fontSize:11, color:T.textLight, fontWeight:600 }}>FROM</label>
                              <input type="time" value={sh.start||""} onChange={e=>updateShift(id,"start",e.target.value)} style={tStyle}/>
                            </div>
                            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                              <label style={{ fontSize:11, color:T.textLight, fontWeight:600 }}>TO</label>
                              <input type="time" value={sh.end||""} onChange={e=>updateShift(id,"end",e.target.value)} style={tStyle}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {activeSection==="viewings" && (
            <BookingViewingsSection formData={formData} update={update} onAutoSave={onAutoSave}/>
          )}

          {activeSection==="files" && (
            <BookingFilesSection formData={formData} update={update} onAutoSave={onAutoSave}/>
          )}

          {activeSection==="financials" && (
            <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
              {/* Non-standard / extras at top */}
              <div>
                <FLabel>Non-Standard / Extras</FLabel>
                <FTextarea value={formData.nonStandard||""} onChange={v=>update("nonStandard",v)} rows={3}/>
              </div>

              {/* Core financials */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"14px 22px" }}>
                <div>
                  <FLabel>Venue Fee (£)</FLabel>
                  <FInput type="number" value={formData.venueFee||""} onChange={v=>update("venueFee",v)}/>
                </div>
                <div>
                  <FLabel>Deposit (£) <span style={{ fontWeight:400, color:T.textLight, fontSize:11 }}>— advance on venue fee</span></FLabel>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ flex:1 }}><FInput type="number" value={formData.deposit||""} onChange={v=>update("deposit",v)}/></div>
                    <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", fontSize:13, color:T.textMid, whiteSpace:"nowrap" }}>
                      <input type="checkbox" checked={!!formData.depositPaid} onChange={e=>update("depositPaid",e.target.checked)} style={{ width:15, height:15, accentColor:T.green, cursor:"pointer" }}/>
                      Paid
                    </label>
                  </div>
                </div>
                <div>
                  <FLabel>Corkage</FLabel>
                  <FInput type="text" value={formData.corkage||""} onChange={v=>update("corkage",v)}/>
                </div>
                <div>
                  <FLabel>Bar Take Gross (£)</FLabel>
                  <FInput type="number" value={formData.barTakeGross||""} onChange={v=>update("barTakeGross",v)}/>
                </div>
                <div>
                  <FLabel>Circa Commission (£)</FLabel>
                  <FInput type="number" value={formData.circaCommission||""} onChange={v=>update("circaCommission",v)}/>
                </div>
              </div>

              {/* Xero Invoices */}
              <div style={{ borderTop:`2px solid ${T.border}`, paddingTop:16 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                  <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700 }}>Xero Invoices</div>
                  {(formData.xeroInvoices||[]).length < 5 && (
                    <button type="button" onClick={()=>update("xeroInvoices",[...(formData.xeroInvoices||[]),{number:"",paid:false}])}
                      style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"4px 12px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>
                      + Add Invoice
                    </button>
                  )}
                </div>
                {(formData.xeroInvoices||[]).length === 0 && (
                  <p style={{ fontSize:12, color:T.textLight, margin:0 }}>No invoices linked yet — click + Add Invoice to link a Xero invoice number.</p>
                )}
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {(formData.xeroInvoices||[]).map((inv, i) => {
                    const num = (inv.number||"").trim();
                    const xeroUrl = num
                      ? `https://go.xero.com/AccountsReceivable/Search.aspx?graphSearch=False&invoiceRef=${encodeURIComponent(num)}&ref=${encodeURIComponent(num)}&toSearch=${encodeURIComponent(num)}&dateWithin=any&pageSize=200&unsentOnly=False`
                      : null;
                    const updateInv = (field, val) => {
                      const updated = (formData.xeroInvoices||[]).map((x,j)=>j===i?{...x,[field]:val}:x);
                      update("xeroInvoices", updated);
                    };
                    return (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:8, background:T.bgInput, border:`1px solid ${T.border}`, borderRadius:8, padding:"10px 12px" }}>
                        <span style={{ fontSize:12, color:T.textLight, fontWeight:600, minWidth:20 }}>#{i+1}</span>
                        <input type="text" value={inv.number||""} onChange={e=>updateInv("number",e.target.value)}
                          placeholder="e.g. INV-0303"
                          style={{ flex:1, background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"6px 10px", outline:"none" }}/>
                        <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", fontSize:12, color:T.textMid, whiteSpace:"nowrap" }}>
                          <input type="checkbox" checked={!!inv.paid} onChange={e=>updateInv("paid",e.target.checked)} style={{ width:14, height:14, accentColor:T.green, cursor:"pointer" }}/>
                          Paid
                        </label>
                        {xeroUrl && (
                          <a href={xeroUrl} target="_blank" rel="noreferrer"
                            style={{ background:"#13B5EA", color:"#fff", borderRadius:5, padding:"5px 11px", fontSize:12, fontWeight:700, textDecoration:"none", whiteSpace:"nowrap", flexShrink:0 }}>
                            Open in Xero ↗
                          </a>
                        )}
                        <button type="button" onClick={()=>update("xeroInvoices",(formData.xeroInvoices||[]).filter((_,j)=>j!==i))}
                          style={{ background:T.redBg, border:"none", color:T.red, padding:"5px 9px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600, flexShrink:0 }}>
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Accommodation */}
              <div style={{ borderTop:`2px solid ${T.border}`, paddingTop:16 }}>
                <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:12 }}>Accommodation</div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  <AccomField bookedKey="amlyBooked"    feeKey="amlyFee"    paid50Key="amly50Paid"    paid100Key="amly100Paid"    label="Amly"    formData={formData} update={update}/>
                  <AccomField bookedKey="hamletBooked"  feeKey="hamletFee"  paid50Key="hamlet50Paid"  paid100Key="hamlet100Paid"  label="Hamlet"  formData={formData} update={update}/>
                  <AccomField bookedKey="campingBooked" feeKey="campingFee" paid50Key="camping50Paid" paid100Key="camping100Paid" label="Camping" formData={formData} update={update}/>
                </div>
              </div>

              {/* Payment notes */}
              <div>
                <FLabel>Payment Notes</FLabel>
                <FTextarea value={formData.paymentNotes||""} onChange={v=>update("paymentNotes",v)} rows={2}/>
              </div>
            </div>
          )}

          {activeSection!=="staffing" && activeSection!=="financials" && activeSection!=="viewings" && activeSection!=="files" && (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"16px 22px" }}>
              {TEXT_FIELDS.filter(f=>f.section===activeSection).map(field=>(
                <div key={field.key} style={{ gridColumn:field.type==="textarea"?"1 / -1":"auto" }}>
                  <FLabel required={field.required}>{field.label}</FLabel>
                  {field.key==="date" ? (
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <FInput type="date" value={formData[field.key]} onChange={v=>update(field.key,v)}/>
                      <DayBadge dateStr={formData.date} style={{ fontSize:13, padding:"6px 12px" }}/>
                    </div>
                  ) : field.type==="select" ? (
                    <select value={formData[field.key]||""} onChange={e=>update(field.key,e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none" }}>
                      {(field.options||[]).map(o=><option key={o}>{o}</option>)}
                    </select>
                  ) : field.type==="textarea"
                    ? <FTextarea value={formData[field.key]} onChange={v=>update(field.key,v)}/>
                    : field.type==="email" ? (
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <FInput type="email" value={formData[field.key]} onChange={v=>update(field.key,v)}/>
                        <GmailLink email={formData[field.key]}/>
                      </div>
                    ) : <FInput type={field.type} value={formData[field.key]} onChange={v=>update(field.key,v)}/>
                  }
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── STAFF TAB ────────────────────────────────────────────────────────────────
const ROLES = ["Day Manager","Bar Supervisor","Bar Staff","Handy","Other"];

function StaffView({ staff, bookings, staffForm, setStaffForm, editStaffId, onNew, onEdit, onDelete, onSubmit, onCancel }) {
  const updateForm = (k,v) => setStaffForm(f=>({...f,[k]:v}));
  const today = new Date().toISOString().slice(0,10);
  const bookingCount = {};
  bookings.forEach(b=>{ ["setup",...STAFFING_FIELDS].forEach(field=>{ (b[field]||[]).forEach(id=>{ bookingCount[id]=(bookingCount[id]||0)+1; }); }); });
  const upcomingFor = id => bookings.filter(b=>b.date>=today&&["setup",...STAFFING_FIELDS].some(f=>(b[f]||[]).includes(id)));

  return (
    <div style={{ paddingTop:28 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:22 }}>
        <h2 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:22 }}>Staff Database</h2>
        <button onClick={onNew} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"9px 22px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600, boxShadow:"0 2px 8px rgba(30,77,140,.25)" }}>+ Add Staff Member</button>
      </div>

      {staffForm && (
        <div style={{ background:"#fff", border:`2px solid ${T.accentMid}`, borderRadius:10, padding:26, marginBottom:26, boxShadow:"0 4px 16px rgba(59,130,246,.1)" }}>
          <h3 style={{ margin:"0 0 18px", color:T.midBlue, fontWeight:700, fontSize:16 }}>{editStaffId?"Edit Staff Member":"New Staff Member"}</h3>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"14px 22px" }}>
            {[{k:"id",l:"Initials / Code",required:true,hint:"e.g. TM, BeW"},{k:"name",l:"Full Name",required:true},{k:"email",l:"Email"},{k:"phone",l:"Phone"},{k:"rate",l:"Pay Rate"}].map(({k,l,required,hint})=>(
              <div key={k}>
                <FLabel required={required}>{l}</FLabel>
                <FInput value={staffForm[k]} onChange={v=>updateForm(k,v)} placeholder={hint||""}/>
              </div>
            ))}
            <div>
              <FLabel>Role</FLabel>
              <select value={staffForm.role||"Bar Staff"} onChange={e=>updateForm("role",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none" }}>
                {ROLES.map(r=><option key={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ gridColumn:"1/-1" }}>
              <FLabel>Notes</FLabel>
              <FTextarea value={staffForm.notes} onChange={v=>updateForm("notes",v)} rows={2}/>
            </div>
            <div><FCheck checked={staffForm.active!==false} onChange={v=>updateForm("active",v)} label="Active"/></div>
          </div>
          <div style={{ display:"flex", gap:10, marginTop:18 }}>
            <button onClick={onSubmit} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"10px 24px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700 }}>{editStaffId?"Save Changes":"Add Staff Member"}</button>
            <button onClick={onCancel} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"10px 20px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(290px,1fr))", gap:16 }}>
        {staff.map(s=>{
          const upcoming=upcomingFor(s.id), total=bookingCount[s.id]||0;
          return (
            <div key={s.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:18, opacity:s.active?1:.55, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <StaffChip initials={s.id} staff={[s]} size="lg"/>
                  <div>
                    <div style={{ fontWeight:700, color:T.text, fontSize:15 }}>{s.name}</div>
                    <div style={{ fontSize:11, color:T.textLight }}>{s.role}{!s.active&&" · Inactive"}</div>
                  </div>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={()=>onEdit(s.id)} style={{ background:T.accentLight, border:"none", color:T.accent, padding:"3px 10px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight:600 }}>Edit</button>
                  <button onClick={()=>onDelete(s.id)} style={{ background:T.redBg, border:"none", color:T.red, padding:"3px 8px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕</button>
                </div>
              </div>
              {s.email&&<div style={{ fontSize:12, color:T.textLight, marginBottom:3, display:"flex", alignItems:"center", gap:8 }}>{s.email} <GmailLink email={s.email}/></div>}
              {s.phone&&<div style={{ fontSize:12, color:T.textLight, marginBottom:3 }}>{s.phone}</div>}
              {s.rate&&<div style={{ fontSize:12, color:T.accent, marginBottom:8, fontWeight:600 }}>{s.rate}</div>}
              {s.notes&&<div style={{ fontSize:11, color:T.textMid, marginBottom:8, fontStyle:"italic" }}>{s.notes}</div>}
              <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:10, display:"flex", gap:16 }}>
                <span style={{ fontSize:11, color:T.textLight }}><span style={{ color:T.accent, fontWeight:700 }}>{total}</span> total</span>
                <span style={{ fontSize:11, color:T.textLight }}><span style={{ color:upcoming.length>0?T.green:T.textLight, fontWeight:700 }}>{upcoming.length}</span> upcoming</span>
              </div>
              {upcoming.length>0&&(
                <div style={{ marginTop:8, display:"flex", flexWrap:"wrap", gap:4 }}>
                  {upcoming.slice(0,3).map(b=>(
                    <span key={b.id} style={{ fontSize:10, background:T.bg, border:`1px solid ${T.border}`, borderRadius:4, padding:"2px 7px", color:T.textMid }}>
                      {new Date(b.date+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"})} · {b.couple.split("&")[0].trim().split(" ")[0]}
                    </span>
                  ))}
                  {upcoming.length>3&&<span style={{ fontSize:10, color:T.textLight }}>+{upcoming.length-3} more</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── REPORTS ──────────────────────────────────────────────────────────────────
function ReportsView({ bookings, staff, reportType, setReportType, enquiries }) {
  const types = [{id:"summary",label:"Annual Summary"},{id:"calendar",label:"Year Calendar"},{id:"revenue",label:"Revenue Tracker"},{id:"accommodation",label:"Accommodation"},{id:"staffing",label:"Rota Overview"},{id:"hours",label:"Hours Worked"},{id:"timeline",label:"Event Rota"}];
  // Note: hours report kept for reference, accommodation report kept
  return (
    <div style={{ paddingTop:28 }}>
      <div style={{ marginBottom:22, display:"flex", gap:8, flexWrap:"wrap" }}>
        {types.map(t=>(
          <button key={t.id} onClick={()=>setReportType(t.id)} style={{ background:reportType===t.id?T.midBlue:"#fff", color:reportType===t.id?"#fff":T.textMid, border:`1.5px solid ${reportType===t.id?T.midBlue:T.border}`, padding:"8px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:reportType===t.id?700:400 }}>{t.label}</button>
        ))}
      </div>
      {reportType==="summary"       && <SummaryReport bookings={bookings}/>}
      {reportType==="calendar"       && <CalendarReport bookings={bookings} enquiries={enquiries||[]}/>}
      {reportType==="revenue"       && <RevenueReport bookings={bookings}/>}
      {reportType==="accommodation" && <AccommodationReport bookings={bookings}/>}
      {reportType==="staffing"      && <StaffingRota bookings={bookings} staff={staff}/>}
      {reportType==="hours"          && <HoursReport bookings={bookings} staff={staff}/>}
      {reportType==="timeline"        && <StaffTimelineReport bookings={bookings} staff={staff}/>}
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"20px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
      <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, marginBottom:8, fontWeight:600 }}>{label}</div>
      <div style={{ fontSize:28, color:T.midBlue, fontWeight:700 }}>{value}</div>
      {sub&&<div style={{ fontSize:12, color:T.textLight, marginTop:4 }}>{sub}</div>}
    </div>
  );
}

function SummaryReport({ bookings }) {
  const allYears = [...new Set(bookings.filter(b=>b.date).map(b=>b.date.slice(0,4)))].sort();
  const currentYear = new Date().getFullYear().toString();
  const [year, setYear] = useState(allYears.includes(currentYear) ? currentYear : (allYears[allYears.length-1]||currentYear));
  const [printMode, setPrintMode] = useState(false);

  const yearBookings = bookings.filter(b=>b.couple&&b.date&&b.date.startsWith(year));
  const today = new Date().toISOString().slice(0,10);
  const upcoming = yearBookings.filter(b=>b.date>=today);
  const totalVenueFees = yearBookings.reduce((s,b)=>s+parseMoney(b.venueFee),0);
  const totalAccom = yearBookings.reduce((s,b)=>s+parseMoney(b.amlyFee)+parseMoney(b.hamletFee)+parseMoney(b.campingFee),0);
  const totalRevenue = totalVenueFees + totalAccom;
  const totalDeposits = yearBookings.reduce((s,b)=>s+parseMoney(b.deposit),0);
  const monthCounts = {};
  yearBookings.forEach(b=>{ const m=b.date.slice(0,7); monthCounts[m]=(monthCounts[m]||0)+1; });
  const prevYear = allYears[allYears.indexOf(year)-1];
  const nextYear = allYears[allYears.indexOf(year)+1];

  const printText = [
    `Annual Summary — ${year}`,
    `Bookings: ${yearBookings.length} (${upcoming.length} upcoming)`,
    `Venue Fees: £${totalVenueFees.toLocaleString()}`,
    `Accommodation Revenue: £${totalAccom.toLocaleString()}`,
    `Total Revenue: £${totalRevenue.toLocaleString()}`,
    `Deposits Held (advance on venue fees): £${totalDeposits.toLocaleString()}`,
    `Confirmed: ${yearBookings.filter(b=>b.status==="Confirmed").length} | Holding: ${yearBookings.filter(b=>b.status==="Holding").length}`,
    `Accommodation — Amly: ${yearBookings.filter(b=>b.amlyBooked==="yes").length} | Hamlet: ${yearBookings.filter(b=>b.hamletBooked==="yes").length} | Camping: ${yearBookings.filter(b=>b.campingBooked==="yes").length}`,
    "",
    "Bookings by Month:",
    ...Object.entries(monthCounts).sort().map(([m,c])=>`  ${new Date(m+"-01").toLocaleDateString("en-GB",{month:"long"})}: ${c}`)
  ].join("\n");

  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      {/* Year navigator */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:16, marginBottom:24 }}>
        <button onClick={()=>setYear(prevYear)} disabled={!prevYear} style={{ background:prevYear?"#fff":"#f5f5f5", border:`1px solid ${T.border}`, color:prevYear?T.midBlue:T.textLight, width:36, height:36, borderRadius:8, cursor:prevYear?"pointer":"default", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" }}>‹</button>
        <div style={{ display:"flex", gap:8 }}>
          {allYears.map(y=>(
            <button key={y} onClick={()=>setYear(y)} style={{ background:y===year?T.midBlue:"#fff", color:y===year?"#fff":T.textMid, border:`1.5px solid ${y===year?T.midBlue:T.border}`, padding:"6px 18px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:15, fontWeight:y===year?700:400 }}>{y}</button>
          ))}
        </div>
        <button onClick={()=>setYear(nextYear)} disabled={!nextYear} style={{ background:nextYear?"#fff":"#f5f5f5", border:`1px solid ${T.border}`, color:nextYear?T.midBlue:T.textLight, width:36, height:36, borderRadius:8, cursor:nextYear?"pointer":"default", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" }}>›</button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:28 }}>
        <StatCard label="Bookings" value={yearBookings.length} sub={`${upcoming.length} upcoming`}/>
        <StatCard label="Venue Fees" value={`£${totalVenueFees.toLocaleString()}`} sub={`${year}`}/>
        <StatCard label="Accom Revenue" value={`£${totalAccom.toLocaleString()}`} sub={`Total: £${totalRevenue.toLocaleString()}`}/>
        <StatCard label="Deposits Held" value={`£${totalDeposits.toLocaleString()}`} sub="Advance on venue fees — not additional"/>
        <StatCard label="Confirmed" value={yearBookings.filter(b=>b.status==="Confirmed").length} sub="Confirmed bookings"/>
        <StatCard label="Holding" value={yearBookings.filter(b=>b.status==="Holding").length} sub="Holding bookings"/>
        <StatCard label="Amly / Hamlet / Camping" value={`${yearBookings.filter(b=>b.amlyBooked==="yes").length} / ${yearBookings.filter(b=>b.hamletBooked==="yes").length} / ${yearBookings.filter(b=>b.campingBooked==="yes").length}`} sub="Accommodation bookings"/>
      </div>
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:24, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:16 }}>{year} Bookings by Month</h3>
        {Object.entries(monthCounts).sort().map(([month,count])=>{
          const lbl=new Date(month+"-01").toLocaleDateString("en-GB",{month:"long",year:"numeric"});
          return (
            <div key={month} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
              <span style={{ width:130, color:T.textMid, fontSize:13 }}>{lbl}</span>
              <div style={{ flex:1, background:T.accentLight, borderRadius:4, height:22, overflow:"hidden" }}>
                <div style={{ width:`${Math.min(100,(count/5)*100)}%`, minWidth:count>0?30:0, height:"100%", background:T.midBlue, borderRadius:4, display:"flex", alignItems:"center", paddingLeft:8 }}>
                  <span style={{ color:"#fff", fontSize:11, fontWeight:700 }}>{count}</span>
                </div>
              </div>
            </div>
          );
        })}
        {Object.keys(monthCounts).length===0 && <p style={{ color:T.textLight, fontSize:13 }}>No bookings in {year}.</p>}
      </div>
    </div>
  );
}

// ─── YEAR CALENDAR REPORT ─────────────────────────────────────────────────────
function CalendarReport({ bookings, enquiries }) {
  const allYears = [...new Set(bookings.filter(b=>b.date).map(b=>b.date.slice(0,4)))].sort();
  const currentYear = new Date().getFullYear().toString();
  const [year, setYear] = useState(allYears.includes(currentYear) ? currentYear : (allYears[allYears.length-1]||currentYear));
  const [showViewings, setShowViewings] = useState(true);
  const today = new Date().toISOString().slice(0,10);

  // Index bookings by date string
  const byDate = {};
  bookings.filter(b=>b.date&&b.couple&&b.date.startsWith(year)).forEach(b=>{
    byDate[b.date] = byDate[b.date] || [];
    byDate[b.date].push(b);
  });

  // Collect all viewings from bookings and enquiries
  const viewingsByDate = {};
  bookings.forEach(b=>{
    (b.viewings||[]).forEach(v=>{
      if(v.date&&v.date.startsWith(year)){
        viewingsByDate[v.date] = viewingsByDate[v.date]||[];
        viewingsByDate[v.date].push({ label:b.couple||"Booking", source:"booking" });
      }
    });
  });
  (enquiries||[]).forEach(e=>{
    (e.viewings||[]).forEach(v=>{
      if(v.date&&v.date.startsWith(year)){
        viewingsByDate[v.date] = viewingsByDate[v.date]||[];
        viewingsByDate[v.date].push({ label:e.name||"Enquiry", source:"enquiry" });
      }
    });
  });

  const prevYear = allYears[allYears.indexOf(year)-1];
  const nextYear = allYears[allYears.indexOf(year)+1];
  // Allow scrolling to years not yet in allYears
  const yearInt = parseInt(year);

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  const getBookingStyle = (b) => {
    const isPast = b.date < today;
    if (isPast) return { bg:"#e5e7eb", text:"#6b7280", border:"#d1d5db" };
    if (b.status==="Holding") return { bg:"#fef9c3", text:"#854d0e", border:"#fcd34d" };
    return { bg:"#dcfce7", text:"#166534", border:"#86efac" };
  };

  return (
    <div>
      {/* Year nav */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:16, marginBottom:24 }}>
        <button onClick={()=>setYear(String(yearInt-1))} style={{ background:"#fff", border:`1px solid ${T.border}`, color:T.midBlue, width:36, height:36, borderRadius:8, cursor:"pointer", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" }}>‹</button>
        <div style={{ display:"flex", gap:8 }}>
          {allYears.map(y=>(
            <button key={y} onClick={()=>setYear(y)} style={{ background:y===year?T.midBlue:"#fff", color:y===year?"#fff":T.textMid, border:`1.5px solid ${y===year?T.midBlue:T.border}`, padding:"6px 18px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:15, fontWeight:y===year?700:400 }}>{y}</button>
          ))}
          {!allYears.includes(String(yearInt)) && <button style={{ background:T.midBlue, color:"#fff", border:`1.5px solid ${T.midBlue}`, padding:"6px 18px", borderRadius:8, fontFamily:"inherit", fontSize:15, fontWeight:700 }}>{year}</button>}
        </div>
        <button onClick={()=>setYear(String(yearInt+1))} style={{ background:"#fff", border:`1px solid ${T.border}`, color:T.midBlue, width:36, height:36, borderRadius:8, cursor:"pointer", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" }}>›</button>
      </div>

      {/* Legend + toggle */}
      <div style={{ display:"flex", gap:16, marginBottom:20, flexWrap:"wrap", alignItems:"center" }}>
        {[{label:"Confirmed",bg:"#dcfce7",text:"#166534",border:"#86efac"},{label:"Holding",bg:"#fef9c3",text:"#854d0e",border:"#fcd34d"},{label:"Past",bg:"#e5e7eb",text:"#6b7280",border:"#d1d5db"}].map(l=>(
          <div key={l.label} style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ width:14, height:14, borderRadius:3, background:l.bg, border:`1px solid ${l.border}` }}/>
            <span style={{ fontSize:12, color:T.textMid }}>{l.label}</span>
          </div>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8 }}>
          <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", fontSize:13, color:T.textMid, userSelect:"none" }}>
            <input type="checkbox" checked={showViewings} onChange={e=>setShowViewings(e.target.checked)} style={{ accentColor:"#7c3aed", width:15, height:15, cursor:"pointer" }}/>
            <span style={{ display:"flex", alignItems:"center", gap:5 }}>
              <span style={{ width:10, height:10, borderRadius:"50%", background:"#7c3aed", display:"inline-block" }}/>
              Show Viewings
            </span>
          </label>
        </div>
      </div>

      {/* 12-month grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16 }}>
        {MONTHS.map((monthName, mIdx) => {
          const monthNum = String(mIdx+1).padStart(2,"0");
          const firstDay = new Date(`${year}-${monthNum}-01`);
          const daysInMonth = new Date(yearInt, mIdx+1, 0).getDate();
          // Monday=0 offset
          let startDow = (firstDay.getDay()+6)%7;

          const cells = [];
          for (let i=0; i<startDow; i++) cells.push(null);
          for (let d=1; d<=daysInMonth; d++) cells.push(d);

          return (
            <div key={monthName} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <div style={{ padding:"10px 14px", background:"#eef4fd", borderBottom:`1px solid ${T.border}` }}>
                <span style={{ fontSize:14, fontWeight:700, color:T.midBlue }}>{monthName} {year}</span>
              </div>
              <div style={{ padding:"8px 10px" }}>
                {/* Day headers */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:1, marginBottom:4 }}>
                  {DOW.map(d=><div key={d} style={{ textAlign:"center", fontSize:9, fontWeight:700, color:T.textLight, letterSpacing:.5, padding:"2px 0" }}>{d}</div>)}
                </div>
                {/* Day cells */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:1 }}>
                  {cells.map((day, ci) => {
                    if (!day) return <div key={`e${ci}`}/>;
                    const dateStr = `${year}-${monthNum}-${String(day).padStart(2,"0")}`;
                    const dayBookings = byDate[dateStr] || [];
                    const isToday = dateStr === today;
                    const hasPast = dayBookings.some(b=>b.date<today);
                    const hasConfirmed = dayBookings.some(b=>b.date>=today&&b.status==="Confirmed");
                    const hasHolding = dayBookings.some(b=>b.date>=today&&b.status==="Holding");
                    const cellBg = hasPast ? "#e5e7eb" : hasConfirmed ? "#dcfce7" : hasHolding ? "#fef9c3" : "transparent";
                    const cellBorder = hasPast ? "#d1d5db" : hasConfirmed ? "#86efac" : hasHolding ? "#fcd34d" : "transparent";
                    const cellText = hasPast ? "#6b7280" : (hasConfirmed||hasHolding) ? (hasConfirmed?"#166534":"#854d0e") : T.text;
                    const isSun = (cells.slice(0,ci).filter(Boolean).length + startDow) % 7 === 6;
                    const isSat = (cells.slice(0,ci).filter(Boolean).length + startDow) % 7 === 5;

                    return (
                      <div key={day} title={dayBookings.map(b=>b.couple).join(", ")}
                        style={{ position:"relative", textAlign:"center", padding:"3px 1px", borderRadius:4, background:cellBg, border:`1px solid ${cellBorder}`, cursor:dayBookings.length?"pointer":"default" }}>
                        <span style={{ fontSize:10, fontWeight:dayBookings.length?700:400, color:isToday?T.accent:isSat||isSun?T.textLight:cellText }}>
                          {day}
                        </span>
                        {isToday && <div style={{ position:"absolute", bottom:1, left:"50%", transform:"translateX(-50%)", width:4, height:4, borderRadius:"50%", background:T.accent }}/>}
                        {showViewings && (viewingsByDate[dateStr]||[]).length>0 && (
                          <div style={{ position:"absolute", top:1, left:2, width:5, height:5, borderRadius:"50%", background:"#7c3aed" }} title={(viewingsByDate[dateStr]||[]).map(v=>v.label).join(", ")}/>
                        )}
                        {dayBookings.length>0 && (
                          <div style={{ position:"absolute", top:1, right:2, fontSize:8, fontWeight:700, color:cellText }}>{dayBookings.length>1?dayBookings.length:""}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Booking list for this month */}
                {Object.entries(byDate).filter(([d])=>d.startsWith(`${year}-${monthNum}`)).sort().map(([d, bks])=>(
                  bks.map(b => {
                    const s = getBookingStyle(b);
                    return (
                      <div key={b.id} style={{ marginTop:4, padding:"2px 6px", borderRadius:4, background:s.bg, border:`1px solid ${s.border}`, display:"flex", alignItems:"center", gap:4 }}>
                        <span style={{ fontSize:10, fontWeight:700, color:s.text, flexShrink:0 }}>{new Date(d+"T00:00:00").getDate()}</span>
                        <span style={{ fontSize:10, color:s.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{b.couple}</span>
                      </div>
                    );
                  })
                ))}
                {showViewings && Object.entries(viewingsByDate).filter(([d])=>d.startsWith(`${year}-${monthNum}`)).sort().map(([d, views])=>(
                  views.map((v,vi) => (
                    <div key={d+vi} style={{ marginTop:3, padding:"2px 6px", borderRadius:4, background:"#f3e8ff", border:"1px solid #c4b5fd", display:"flex", alignItems:"center", gap:4 }}>
                      <span style={{ fontSize:9, width:7, height:7, borderRadius:"50%", background:"#7c3aed", flexShrink:0, display:"inline-block" }}/>
                      <span style={{ fontSize:10, fontWeight:700, color:"#6d28d9", flexShrink:0 }}>{new Date(d+"T00:00:00").getDate()}</span>
                      <span style={{ fontSize:10, color:"#6d28d9", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{v.label}</span>
                    </div>
                  ))
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RevenueReport({ bookings }) {
  const [printMode, setPrintMode] = useState(false);
  const rows=bookings.filter(b=>b.couple&&parseMoney(b.venueFee)>0).sort((a,b)=>a.date>b.date?1:-1);
  const totalFees=rows.reduce((s,b)=>s+parseMoney(b.venueFee),0);
  const totalDeposits=rows.reduce((s,b)=>s+parseMoney(b.deposit),0);
  // Deposit is an advance on venue fee — balance = fee - deposit (remaining to collect)
  const totalBalance=rows.reduce((s,b)=>s+Math.max(0,parseMoney(b.venueFee)-parseMoney(b.deposit)),0);
  const printText = [
    "Revenue Tracker", "",
    "Date | Couple | Venue Fee | Deposit Paid | Balance",
    ...rows.map(b=>{ const fee=parseMoney(b.venueFee),dep=parseMoney(b.deposit),bal=Math.max(0,fee-dep); return b.date+" | "+b.couple+" | £"+fee.toLocaleString()+" | £"+dep.toLocaleString()+" | £"+bal.toLocaleString(); }),
    "",
    "Total: £"+totalFees.toLocaleString()+" fees | £"+totalDeposits.toLocaleString()+" deposits | £"+totalBalance.toLocaleString()+" outstanding",
  ].join("\n");
  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.7, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:16, marginBottom:22 }}>
        <StatCard label="Total Venue Fees" value={`£${totalFees.toLocaleString()}`} sub="Sum of all venue fees"/>
        <StatCard label="Deposits Paid" value={`£${totalDeposits.toLocaleString()}`} sub="Advances on venue fees"/>
        <StatCard label="Balance Outstanding" value={`£${totalBalance.toLocaleString()}`} sub="Remaining after deposits"/>
      </div>
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead><tr style={{ background:"#eef4fd" }}>{["Date","Couple","Venue Fee","Deposit (advance)","Balance Remaining"].map(h=><th key={h} style={{ padding:"10px 14px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.2, textTransform:"uppercase", fontWeight:700 }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((b,i)=>{
              const fee=parseMoney(b.venueFee),dep=parseMoney(b.deposit),balance=Math.max(0,fee-dep);
              return <tr key={b.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none" }}>
                <td style={{ padding:"10px 14px", fontSize:12, color:T.accent, fontWeight:500 }}>{b.date}</td>
                <td style={{ padding:"10px 14px", fontSize:13, fontWeight:500 }}>{b.couple}</td>
                <td style={{ padding:"10px 14px", fontSize:13 }}>£{fee.toLocaleString()}</td>
                <td style={{ padding:"10px 14px", fontSize:13, color:dep>0?T.green:T.textLight }}>{dep>0?`£${dep.toLocaleString()}`:"—"}</td>
                <td style={{ padding:"10px 14px", fontSize:13, fontWeight:700, color:balance===0?T.green:T.amber }}>{balance===0?"✓ Paid in full":`£${balance.toLocaleString()}`}</td>
              </tr>;
            })}
          </tbody>
          <tfoot><tr style={{ borderTop:`2px solid ${T.border}`, background:"#eef4fd" }}>
            <td colSpan={2} style={{ padding:"10px 14px", fontSize:13, color:T.midBlue, fontWeight:700 }}>TOTALS</td>
            <td style={{ padding:"10px 14px", fontSize:13, color:T.midBlue, fontWeight:700 }}>£{totalFees.toLocaleString()}</td>
            <td style={{ padding:"10px 14px", fontSize:13, color:T.green, fontWeight:600 }}>£{totalDeposits.toLocaleString()}</td>
            <td style={{ padding:"10px 14px", fontSize:13, color:T.amber, fontWeight:700 }}>£{totalBalance.toLocaleString()}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>
  );
}

function AccommodationReport({ bookings }) {
  const [printMode, setPrintMode] = useState(false);
  const rows=bookings.filter(b=>b.couple&&b.date);
  const amlyRows=rows.filter(b=>b.amlyBooked==="yes");
  const hamletRows=rows.filter(b=>b.hamletBooked==="yes");
  const campingRows=rows.filter(b=>b.campingBooked==="yes");
  const printText = [
    "Accommodation Report",
    `Amly: ${amlyRows.length} bookings — £${amlyRows.reduce((s,b)=>s+parseMoney(b.amlyFee),0).toLocaleString()}`,
    `Hamlet: ${hamletRows.length} bookings — £${hamletRows.reduce((s,b)=>s+parseMoney(b.hamletFee),0).toLocaleString()}`,
    `Camping: ${campingRows.length} bookings — £${campingRows.reduce((s,b)=>s+parseMoney(b.campingFee),0).toLocaleString()}`,
    "",
    "Date | Couple | Amly | Amly Fee | Hamlet | Hamlet Fee | Camping | Camping Fee",
    ...rows.map(b=>`${b.date} | ${b.couple} | ${b.amlyBooked==="yes"?"Yes":b.amlyBooked==="no"?"No":"TBC"} | ${parseMoney(b.amlyFee)>0?"£"+parseMoney(b.amlyFee).toLocaleString():"—"} | ${b.hamletBooked==="yes"?"Yes":b.hamletBooked==="no"?"No":"TBC"} | ${parseMoney(b.hamletFee)>0?"£"+parseMoney(b.hamletFee).toLocaleString():"—"} | ${b.campingBooked==="yes"?"Yes":b.campingBooked==="no"?"No":"TBC"} | ${parseMoney(b.campingFee)>0?"£"+parseMoney(b.campingFee).toLocaleString():"—"}`)
  ].join("\n");
  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:16, marginBottom:22 }}>
        <StatCard label="Amly Booked"    value={amlyRows.length}    sub={`£${amlyRows.reduce((s,b)=>s+parseMoney(b.amlyFee),0).toLocaleString()} confirmed`}/>
        <StatCard label="Hamlet Booked"  value={hamletRows.length}  sub={`£${hamletRows.reduce((s,b)=>s+parseMoney(b.hamletFee),0).toLocaleString()} confirmed`}/>
        <StatCard label="Camping Booked" value={campingRows.length} sub={`£${campingRows.reduce((s,b)=>s+parseMoney(b.campingFee),0).toLocaleString()} confirmed`}/>
      </div>
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead><tr style={{ background:"#eef4fd" }}>{["Date","Couple","Amly","Amly Fee","Hamlet","Hamlet Fee","Camping","Camping Fee"].map(h=><th key={h} style={{ padding:"10px 12px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((b,i)=>(
              <tr key={b.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none" }}>
                <td style={{ padding:"10px 12px", fontSize:12, color:T.accent, fontWeight:500 }}>{b.date}</td>
                <td style={{ padding:"10px 12px", fontSize:13, fontWeight:500 }}>{b.couple}</td>
                {[["amlyBooked","amlyFee"],["hamletBooked","hamletFee"],["campingBooked","campingFee"]].map(([bk,fk])=>[
                  <td key={bk} style={{ padding:"10px 12px" }}>
                    {b[bk]==="yes"
                      ? <span style={{ fontSize:11, padding:"2px 9px", borderRadius:10, background:T.greenBg, color:T.green, fontWeight:700 }}>Yes</span>
                      : b[bk]==="no"
                        ? <span style={{ fontSize:11, padding:"2px 9px", borderRadius:10, background:T.redBg, color:T.red, fontWeight:700 }}>No</span>
                        : <span style={{ fontSize:11, padding:"2px 9px", borderRadius:10, background:T.amberBg, color:T.amber, fontWeight:700 }}>TBC</span>}
                  </td>,
                  <td key={fk} style={{ padding:"10px 12px", fontSize:13, color:parseMoney(b[fk])>0?T.text:T.textLight }}>{parseMoney(b[fk])>0?`£${parseMoney(b[fk]).toLocaleString()}`:"—"}</td>
                ])}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StaffingRota({ bookings, staff }) {
  const [printMode, setPrintMode] = useState(false);
  const today=new Date().toISOString().slice(0,10);
  const rows=bookings.filter(b=>b.couple&&b.date&&b.date>=today).sort((a,b)=>a.date>b.date?1:-1);
  const getNames = (ids) => (ids||[]).map(id=>(staff.find(s=>s.id===id)||{name:id}).name).join(", ") || "—";
  const printText = [
    "Staffing Rota — Upcoming Events",
    "",
    ...rows.map(b=>[
      `${b.date} — ${b.couple}`,
      `  Set-Up: ${getNames(b.setup)}`,
      `  Day Manager: ${getNames(b.dayManager)}`,
      `  Bar Supervisor: ${getNames(b.barSupervisor)}`,
      `  Day Staff: ${getNames(b.dayStaff)}`,
      `  Bar: ${getNames(b.bar)}`,
      `  Day Handy: ${getNames(b.dayHandy)}`,
      `  Eve Handy: ${getNames(b.eveHandy)}`,
    ].join("\n"))
  ].join("\n\n");
  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
    <div style={{ overflowX:"auto" }}>
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead><tr style={{ background:"#eef4fd" }}>{["Date","Couple","Set-Up","Day Manager","Bar Sup","Day Staff","Bar","Day Handy","Eve Handy"].map(h=><th key={h} style={{ padding:"10px 12px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((b,i)=>(
              <tr key={b.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none" }}>
                <td style={{ padding:"10px 12px", fontSize:12, color:T.accent, whiteSpace:"nowrap", fontWeight:600 }}>{new Date(b.date+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</td>
                <td style={{ padding:"10px 12px", fontSize:13, fontWeight:500, maxWidth:130 }}>{b.couple.split("&")[0].trim()}</td>
                {["setup","dayManager","barSupervisor","dayStaff","bar","dayHandy","eveHandy"].map(field=>(
                  <td key={field} style={{ padding:"10px 12px" }}>
                    {(b[field]||[]).length===0?<span style={{ color:T.textLight,fontSize:11 }}>—</span>:(b[field]||[]).map(id=><StaffChip key={id} initials={id} staff={staff}/>)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  );
}

function PipelineReport({ bookings }) {
  const [printMode, setPrintMode] = useState(false);
  const today=new Date().toISOString().slice(0,10);
  const rows=bookings.filter(b=>b.couple&&b.date>=today&&parseMoney(b.venueFee)>0);
  const printText = [
    "Payment Pipeline — Upcoming Bookings",
    "",
    ...rows.map(b=>{
      const fee=parseMoney(b.venueFee),dep=parseMoney(b.deposit),balance=Math.max(0,fee-dep);
      return `${b.date} | ${b.couple}\n  Venue Fee: £${fee.toLocaleString()} | Deposit: £${dep.toLocaleString()} | Balance: ${balance===0?"PAID IN FULL":"£"+balance.toLocaleString()}`;
    })
  ].join("\n\n");
  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      <p style={{ color:T.textMid, fontSize:13, marginBottom:18 }}>Upcoming bookings with outstanding balance (deposit is advance on venue fee)</p>
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {rows.map(b=>{
          const fee=parseMoney(b.venueFee),dep=parseMoney(b.deposit),balance=Math.max(0,fee-dep),pct=fee>0?Math.min(100,Math.round((dep/fee)*100)):0;
          return (
            <div key={b.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"16px 20px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                <div><div style={{ fontWeight:600, color:T.text }}>{b.couple}</div><div style={{ fontSize:12, color:T.textLight }}>{b.date}</div></div>
                <div style={{ textAlign:"right" }}><div style={{ fontSize:18, color:T.midBlue, fontWeight:700 }}>£{fee.toLocaleString()}</div><div style={{ fontSize:11, color:T.textLight }}>{dep>0?`Deposit: £${dep.toLocaleString()}`:"No deposit"}</div></div>
              </div>
              <div style={{ background:T.bg, borderRadius:4, height:8, overflow:"hidden" }}><div style={{ background:balance===0?T.green:T.accentMid, height:"100%", width:`${pct}%`, borderRadius:4 }}/></div>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:6, fontSize:11, color:T.textLight }}>
                <span>Balance remaining: {balance===0?"✓ Paid in full":`£${balance.toLocaleString()}`}</span>
                <span style={{ color:balance===0?T.green:T.accent, fontWeight:700 }}>{pct}% deposit paid</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StaffWorkloadReport({ bookings, staff }) {
  const [printMode, setPrintMode] = useState(false);
  const today=new Date().toISOString().slice(0,10);
  const upcoming=bookings.filter(b=>b.date>=today);
  const workload=staff.filter(s=>s.active).map(s=>{
    const assigned=upcoming.filter(b=>["setup",...STAFFING_FIELDS].some(f=>(b[f]||[]).includes(s.id)));
    const roles={};
    upcoming.forEach(b=>["setup",...STAFFING_FIELDS].forEach(f=>{ if((b[f]||[]).includes(s.id)) roles[f]=(roles[f]||0)+1; }));
    return {...s, count:assigned.length, roles};
  }).sort((a,b)=>b.count-a.count);
  const max=Math.max(1,...workload.map(w=>w.count));
  const printText = [
    "Staff Workload — Upcoming Events",
    "",
    ...workload.filter(w=>w.count>0).map(w=>`${w.name} (${w.role}): ${w.count} upcoming\n  ${Object.entries(w.roles).map(([r,c])=>`${r==="setup"?"Set-Up":STAFFING_LABELS[r]}: ${c}`).join(", ")}`)
  ].join("\n\n");
  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      <p style={{ color:T.textMid, fontSize:13, marginBottom:18 }}>Upcoming bookings per active staff member</p>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {workload.map(w=>(
          <div key={w.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"14px 20px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8 }}>
              <StaffChip initials={w.id} staff={staff} size="lg"/>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                  <span style={{ fontWeight:700, color:T.text }}>{w.name}</span>
                  <span style={{ fontSize:11, color:T.textLight }}>{w.role}</span>
                  <span style={{ marginLeft:"auto", fontSize:13, color:T.midBlue, fontWeight:700 }}>{w.count} upcoming</span>
                </div>
                <div style={{ background:T.bg, borderRadius:4, height:8, overflow:"hidden" }}>
                  <div style={{ background:w.count>5?T.red:w.count>2?T.amber:T.green, height:"100%", width:`${(w.count/max)*100}%`, minWidth:w.count>0?4:0, borderRadius:4 }}/>
                </div>
              </div>
            </div>
            {w.count>0&&(
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {Object.entries(w.roles).map(([role,cnt])=>(
                  <span key={role} style={{ fontSize:11, background:T.accentLight, border:`1px solid ${T.border}`, borderRadius:4, padding:"2px 8px", color:T.accent, fontWeight:600 }}>{role==="setup"?"Set-Up":STAFFING_LABELS[role]}: {cnt}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── HOURS SECTION (in booking form) ─────────────────────────────────────────
function HoursSection({ formData, update, staff, staffShifts }) {
  const hw = formData.hoursWorked || {};
  const updateHours = (id, val) => {
    const updated = { ...hw };
    if (val === "" || val === "0") delete updated[id];
    else updated[id] = parseFloat(val) || 0;
    update("hoursWorked", updated);
  };

  // Which staff are already assigned to this booking
  const assignedIds = new Set([
    ...(formData.setup||[]),
    ...(formData.dayManager||[]),
    ...(formData.dayStaff||[]),
    ...(formData.barSupervisor||[]),
    ...(formData.sunday||[]),
    ...(formData.bar||[]),
    ...(formData.dayHandy||[]),
    ...(formData.eveHandy||[]),
  ]);

  const assignedStaff = staff.filter(s => assignedIds.has(s.id));
  const otherStaff    = staff.filter(s => s.active && !assignedIds.has(s.id));

  const totalHours = Object.values(hw).reduce((a,b)=>a+b,0);

  return (
    <div>
      <p style={{ margin:"0 0 16px", fontSize:13, color:T.textMid }}>
        Enter actual hours worked by each staff member at this event.
      </p>

      {assignedStaff.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:10 }}>Assigned Staff</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 20px" }}>
            {assignedStaff.map(s => {
              const sh = staffShifts[s.id];
              let expectedHrs = null;
              if (sh?.start && sh?.end) {
                const toMins = t => { const [h,m] = t.split(":").map(Number); return h*60+m; };
                const diff = toMins(sh.end) - toMins(sh.start);
                if (diff > 0) expectedHrs = +(diff/60).toFixed(2);
              }
              return <HoursRow key={s.id} s={s} hw={hw} updateHours={updateHours} highlighted expectedHrs={expectedHrs}/>;
            })}
          </div>
        </div>
      )}

      {otherStaff.length > 0 && (
        <div>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:700, marginBottom:10 }}>Other Staff</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 20px" }}>
            {otherStaff.map(s => {
              const sh = staffShifts[s.id];
              let expectedHrs = null;
              if (sh?.start && sh?.end) {
                const toMins = t => { const [h,m] = t.split(":").map(Number); return h*60+m; };
                const diff = toMins(sh.end) - toMins(sh.start);
                if (diff > 0) expectedHrs = +(diff/60).toFixed(2);
              }
              return <HoursRow key={s.id} s={s} hw={hw} updateHours={updateHours} expectedHrs={expectedHrs}/>;
            })}
          </div>
        </div>
      )}

      {totalHours > 0 && (
        <div style={{ marginTop:20, padding:"12px 16px", background:T.accentLight, borderRadius:8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:13, color:T.midBlue, fontWeight:600 }}>Total hours this event</span>
          <span style={{ fontSize:20, color:T.midBlue, fontWeight:700 }}>{totalHours.toLocaleString()}h</span>
        </div>
      )}
    </div>
  );
}

function HoursRow({ s, hw, updateHours, highlighted, expectedHrs }) {
  const [f, setF] = useState(false);
  const val = hw[s.id] || "";
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background: highlighted ? T.accentLight : T.bgInput, border:`1.5px solid ${f ? T.borderFocus : highlighted && val ? T.accentMid : T.border}`, borderRadius:8, transition:"all .15s" }}>
      <StaffChip initials={s.id} staff={[s]} />
      <span style={{ flex:1, fontSize:13, color:T.text, fontWeight:500 }}>{s.name}</span>
      {expectedHrs !== null && (
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", marginRight:4 }}>
          <span style={{ fontSize:9, letterSpacing:.8, textTransform:"uppercase", color:T.textLight, fontWeight:600 }}>Expected</span>
          <span style={{ fontSize:14, fontWeight:700, color:T.midBlue }}>{expectedHrs}h</span>
        </div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <input
          type="number"
          min="0"
          step="0.5"
          value={val}
          onChange={e => updateHours(s.id, e.target.value)}
          onFocus={() => setF(true)}
          onBlur={() => setF(false)}
          placeholder="0"
          style={{ width:70, background:"#fff", border:`1.5px solid ${f?T.borderFocus:T.border}`, borderRadius:6, color:T.text, fontSize:14, padding:"5px 8px", outline:"none", textAlign:"center", boxShadow:f?"0 0 0 3px #dbeafe":"none" }}
        />
        <span style={{ fontSize:12, color:T.textLight }}>hrs</span>
      </div>
    </div>
  );
}

// ─── HOURS WORKED REPORT ──────────────────────────────────────────────────────
function HoursReport({ bookings, staff }) {
  const today = new Date().toISOString().slice(0,10);
  const threeMonthsAgo = new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10);

  const [from, setFrom] = useState(threeMonthsAgo);
  const [to,   setTo]   = useState(today);

  const filtered = bookings.filter(b => b.date >= from && b.date <= to && b.hoursWorked && Object.keys(b.hoursWorked).length > 0);

  // Aggregate hours per staff member
  const totals = {};
  filtered.forEach(b => {
    Object.entries(b.hoursWorked||{}).forEach(([id, hrs]) => {
      totals[id] = (totals[id] || 0) + hrs;
    });
  });

  // Per-staff breakdown by month
  const monthlyBreakdown = {}; // { staffId: { 'YYYY-MM': hours } }
  filtered.forEach(b => {
    const month = b.date.slice(0,7);
    Object.entries(b.hoursWorked||{}).forEach(([id, hrs]) => {
      if (!monthlyBreakdown[id]) monthlyBreakdown[id] = {};
      monthlyBreakdown[id][month] = (monthlyBreakdown[id][month] || 0) + hrs;
    });
  });

  // All months in range
  const allMonths = [...new Set(filtered.map(b => b.date.slice(0,7)))].sort();

  const sortedStaff = staff.filter(s => totals[s.id] > 0).sort((a,b) => (totals[b.id]||0) - (totals[a.id]||0));
  const unknownIds = Object.keys(totals).filter(id => !staff.find(s=>s.id===id));
  const grandTotal = Object.values(totals).reduce((a,b)=>a+b,0);

  // Per-event detail for each staff member
  const [expandedStaff, setExpandedStaff] = useState(null);
  const [printMode, setPrintMode] = useState(false);
  const eventsForStaff = (id) => filtered.filter(b => (b.hoursWorked||{})[id] > 0).sort((a,b)=>a.date>b.date?1:-1);

  const monthLabel = m => new Date(m+"-01").toLocaleDateString("en-GB",{month:"short",year:"numeric"});

  const printText = grandTotal === 0 ? "No hours logged in this period." : [
    `Hours Worked Report — ${from} to ${to}`,
    `Total: ${grandTotal}h across ${filtered.length} events`,
    "",
    ...sortedStaff.map(s => {
      const events = eventsForStaff(s.id);
      const rate = parseFloat((s.rate||"").replace(/[^0-9.]/g,"")) || 0;
      const est = rate > 0 ? ` (~£${(totals[s.id]*rate).toFixed(2)})` : "";
      return `${s.name}: ${totals[s.id]}h${est}\n${events.map(b=>`  ${b.date} — ${b.couple}: ${(b.hoursWorked||{})[s.id]}h`).join("\n")}`;
    })
  ].join("\n\n");

  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      {/* Date range controls */}
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"16px 20px", marginBottom:22, display:"flex", alignItems:"center", gap:16, flexWrap:"wrap", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <span style={{ fontSize:13, color:T.textMid, fontWeight:600 }}>Date range:</span>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <label style={{ fontSize:12, color:T.textLight }}>From</label>
          <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={{ background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"6px 10px", outline:"none" }}/>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <label style={{ fontSize:12, color:T.textLight }}>To</label>
          <input type="date" value={to} onChange={e=>setTo(e.target.value)} style={{ background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"6px 10px", outline:"none" }}/>
        </div>
        {/* Quick range buttons */}
        {[
          {label:"This month",  fn:()=>{ const n=new Date(); const m=n.toISOString().slice(0,7); setFrom(m+"-01"); setTo(n.toISOString().slice(0,10)); }},
          {label:"Last month",  fn:()=>{ const d=new Date(); d.setMonth(d.getMonth()-1); const m=d.toISOString().slice(0,7); setFrom(m+"-01"); const last=new Date(d.getFullYear(),d.getMonth()+1,0); setTo(last.toISOString().slice(0,10)); }},
          {label:"Last 3 months",fn:()=>{ const n=new Date(); setTo(n.toISOString().slice(0,10)); const f=new Date(n); f.setMonth(f.getMonth()-3); setFrom(f.toISOString().slice(0,10)); }},
          {label:"This year",   fn:()=>{ const y=new Date().getFullYear(); setFrom(y+"-01-01"); setTo(y+"-12-31"); }},
        ].map(({label,fn})=>(
          <button key={label} onClick={fn} style={{ background:T.midBlueBg, border:"none", color:T.midBlue, padding:"6px 12px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>{label}</button>
        ))}
        <span style={{ marginLeft:"auto", fontSize:13, color:T.textLight }}>{filtered.length} event{filtered.length!==1?"s":""} with hours logged</span>
      </div>

      {grandTotal === 0 ? (
        <div style={{ textAlign:"center", padding:60, color:T.textLight }}>
          <p style={{ fontSize:16 }}>No hours logged in this period.</p>
          <p style={{ fontSize:13 }}>Add hours to bookings using the Hours Worked section in each booking form.</p>
        </div>
      ) : (
        <>
          {/* Summary stat cards */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:24 }}>
            <StatCard label="Total Hours" value={`${grandTotal.toLocaleString()}h`} sub={`Across ${filtered.length} events`}/>
            <StatCard label="Staff Worked" value={sortedStaff.length} sub="Unique staff members"/>
            <StatCard label="Avg per Event" value={filtered.length>0?`${(grandTotal/filtered.length).toFixed(1)}h`:"—"} sub="Average total hours"/>
          </div>

          {/* Monthly breakdown table (if multiple months) */}
          {allMonths.length > 1 && (
            <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, marginBottom:22, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <div style={{ padding:"14px 20px", borderBottom:`1px solid ${T.border}`, background:"#eef4fd" }}>
                <span style={{ fontSize:13, fontWeight:700, color:T.midBlue }}>Monthly Summary</span>
              </div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse" }}>
                  <thead>
                    <tr style={{ background:"#f5f9ff" }}>
                      <th style={{ padding:"10px 16px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.2, textTransform:"uppercase", fontWeight:700 }}>Staff Member</th>
                      {allMonths.map(m=><th key={m} style={{ padding:"10px 12px", textAlign:"center", color:T.textMid, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>{monthLabel(m)}</th>)}
                      <th style={{ padding:"10px 12px", textAlign:"center", color:T.midBlue, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStaff.map((s,i)=>(
                      <tr key={s.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none" }}
                        onMouseEnter={e=>e.currentTarget.style.background="#f5f9ff"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <td style={{ padding:"10px 16px" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <StaffChip initials={s.id} staff={[s]}/>
                            <span style={{ fontSize:13, fontWeight:500, color:T.text }}>{s.name}</span>
                          </div>
                        </td>
                        {allMonths.map(m=>{
                          const hrs = (monthlyBreakdown[s.id]||{})[m]||0;
                          return <td key={m} style={{ padding:"10px 12px", textAlign:"center", fontSize:13, color:hrs>0?T.text:T.textLight, fontWeight:hrs>0?500:400 }}>{hrs>0?`${hrs}h`:"—"}</td>;
                        })}
                        <td style={{ padding:"10px 12px", textAlign:"center", fontSize:14, color:T.midBlue, fontWeight:700 }}>{totals[s.id]}h</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop:`2px solid ${T.border}`, background:"#eef4fd" }}>
                      <td style={{ padding:"10px 16px", fontSize:13, fontWeight:700, color:T.midBlue }}>Month total</td>
                      {allMonths.map(m=>{
                        const mTotal = Object.values(monthlyBreakdown).reduce((sum, byMonth)=>sum+(byMonth[m]||0),0);
                        return <td key={m} style={{ padding:"10px 12px", textAlign:"center", fontSize:13, fontWeight:700, color:T.midBlue }}>{mTotal>0?`${mTotal}h`:"—"}</td>;
                      })}
                      <td style={{ padding:"10px 12px", textAlign:"center", fontSize:14, fontWeight:700, color:T.midBlue }}>{grandTotal}h</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Per-staff cards with expand to see events */}
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {sortedStaff.map(s=>{
              const isExpanded = expandedStaff === s.id;
              const events = eventsForStaff(s.id);
              const total = totals[s.id] || 0;
              const maxHrs = Math.max(...sortedStaff.map(x=>totals[x.id]||0));
              const rate = parseFloat((s.rate||"").replace(/[^0-9.]/g,"")) || 0;
              const estPay = rate > 0 ? (total * rate).toFixed(2) : null;

              return (
                <div key={s.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
                  <div style={{ padding:"14px 20px", display:"flex", alignItems:"center", gap:12, cursor:"pointer" }} onClick={()=>setExpandedStaff(isExpanded?null:s.id)}>
                    <StaffChip initials={s.id} staff={[s]} size="lg"/>
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", alignItems:"baseline", gap:10, marginBottom:5 }}>
                        <span style={{ fontWeight:700, color:T.text, fontSize:15 }}>{s.name}</span>
                        <span style={{ fontSize:11, color:T.textLight }}>{s.role}</span>
                        {s.rate && <span style={{ fontSize:11, color:T.accent, marginLeft:"auto" }}>{s.rate}</span>}
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                        <div style={{ flex:1, background:T.bg, borderRadius:4, height:8, overflow:"hidden" }}>
                          <div style={{ background:T.midBlue, height:"100%", width:`${(total/maxHrs)*100}%`, borderRadius:4 }}/>
                        </div>
                        <span style={{ fontSize:16, fontWeight:700, color:T.midBlue, width:60, textAlign:"right" }}>{total}h</span>
                        {estPay && <span style={{ fontSize:12, color:T.green, fontWeight:600, width:80, textAlign:"right" }}>~£{estPay}</span>}
                        <span style={{ fontSize:11, color:T.textLight, width:70, textAlign:"right" }}>{events.length} event{events.length!==1?"s":""}</span>
                      </div>
                    </div>
                    <span style={{ fontSize:16, color:T.textLight, marginLeft:8 }}>{isExpanded?"▲":"▼"}</span>
                  </div>
                  {isExpanded && (
                    <div style={{ borderTop:`1px solid ${T.border}`, background:T.bg }}>
                      <table style={{ width:"100%", borderCollapse:"collapse" }}>
                        <thead>
                          <tr style={{ background:"#eef4fd" }}>
                            {["Date","Event","Hours","Est. Pay"].map(h=><th key={h} style={{ padding:"8px 16px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {events.map((b,i)=>{
                            const hrs = (b.hoursWorked||{})[s.id]||0;
                            const ep = rate>0?(hrs*rate).toFixed(2):null;
                            return (
                              <tr key={b.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none" }}>
                                <td style={{ padding:"8px 16px", fontSize:12, color:T.accent, fontWeight:500 }}>{new Date(b.date+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</td>
                                <td style={{ padding:"8px 16px", fontSize:13 }}>{b.couple}</td>
                                <td style={{ padding:"8px 16px", fontSize:13, fontWeight:700, color:T.midBlue }}>{hrs}h</td>
                                <td style={{ padding:"8px 16px", fontSize:13, color:T.green, fontWeight:500 }}>{ep?`£${ep}`:"—"}</td>
                              </tr>
                            );
                          })}
                          <tr style={{ borderTop:`1.5px solid ${T.border}`, background:"#eef4fd" }}>
                            <td colSpan={2} style={{ padding:"8px 16px", fontSize:12, fontWeight:700, color:T.midBlue }}>Total</td>
                            <td style={{ padding:"8px 16px", fontSize:14, fontWeight:700, color:T.midBlue }}>{total}h</td>
                            <td style={{ padding:"8px 16px", fontSize:13, fontWeight:700, color:T.green }}>{estPay?`£${estPay}`:"—"}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BAR MODULE
// ═══════════════════════════════════════════════════════════════════════════════

const BAR_PRODUCTS_KEY  = "hbf_bar_products_v1";
const BAR_EVENTS_KEY    = "hbf_bar_events_v1";   // orders + stocktakes

const INITIAL_PRODUCTS = [
  // Wine
  { id:"p1",  name:"Sauvignon, Les Fleurs de Montblanc", category:"Wine",      supplier:"Flint",           multiple:3.33, costUnit:7.65  },
  { id:"p2",  name:"Chardonnay, Château Pesquié",        category:"Wine",      supplier:"Flint",           multiple:3.56, costUnit:8.00  },
  { id:"p3",  name:"Atance Blanco, Atance",              category:"Wine",      supplier:"Flint",           multiple:3.61, costUnit:7.90  },
  { id:"p4",  name:"Grace Bridge Pinot Noir",            category:"Wine",      supplier:"Flint",           multiple:3.17, costUnit:9.00  },
  { id:"p5",  name:"Triennes Rosé, Triennes",            category:"Wine",      supplier:"Flint",           multiple:3.83, costUnit:9.00  },
  { id:"p6",  name:"Lampo Prosecco",                     category:"Wine",      supplier:"Flint",           multiple:6.00, costUnit:8.55  },
  // Beer
  { id:"p7",  name:"Numb Angel Lager 4%",                category:"Beer",      supplier:"Gun",             multiple:3.84, costUnit:83.94 },
  { id:"p8",  name:"Project Babylon APA 4.6%",           category:"Beer",      supplier:"Gun",             multiple:4.03, costUnit:83.94 },
  { id:"p9",  name:"Limbertwig Cider 4.6%",              category:"Beer",      supplier:"Gun",             multiple:3.84, costUnit:83.94 },
  { id:"p10", name:"Cans (Stout, IPA, No Alc)",          category:"Beer",      supplier:"Gun",             multiple:5.00, costUnit:null  },
  { id:"p11", name:"Peroni 0%",                          category:"Beer",      supplier:"LWC",             multiple:4.80, costUnit:1.04  },
  // Cocktails
  { id:"p12", name:"Margarita",                          category:"Cocktails", supplier:"LWC",             multiple:2.26, costUnit:2.484 },
  { id:"p13", name:"Espresso Martini",                   category:"Cocktails", supplier:"LWC",             multiple:5.27, costUnit:2.484 },
  { id:"p14", name:"Paloma",                             category:"Cocktails", supplier:"LWC",             multiple:5.27, costUnit:2.484 },
  { id:"p15", name:"Cosmopolitan",                       category:"Cocktails", supplier:"LWC",             multiple:5.27, costUnit:2.484 },
  { id:"p16", name:"Aperol Spritz",                      category:"Cocktails", supplier:"LWC",             multiple:6.05, costUnit:11.90 },
  { id:"p17", name:"Pimms No.1 Cup",                     category:"Cocktails", supplier:"LWC",             multiple:4.38, costUnit:14.61 },
  // Spirits
  { id:"p18", name:"Mousehall Gin",                      category:"Spirits",   supplier:"Mousehall",       multiple:3.45, costUnit:27.88 },
  { id:"p19", name:"Mousehall Vodka",                    category:"Spirits",   supplier:"Mousehall",       multiple:3.45, costUnit:27.88 },
  { id:"p20", name:"Nikka Coffee Whisky",                category:"Spirits",   supplier:"Whisky Exchange", multiple:2.87, costUnit:47.48 },
  { id:"p21", name:"Bombay Sapphire Gin",                category:"Spirits",   supplier:"LWC",             multiple:5.23, costUnit:18.36 },
  { id:"p22", name:"Smirnoff Vodka",                     category:"Spirits",   supplier:"LWC",             multiple:6.83, costUnit:13.46 },
  { id:"p23", name:"Bacardi Rum",                        category:"Spirits",   supplier:"LWC",             multiple:5.49, costUnit:17.49 },
  { id:"p24", name:"Captain Morgan Spiced",              category:"Spirits",   supplier:"LWC",             multiple:6.90, costUnit:13.93 },
  { id:"p25", name:"Tequila Buen Amigo Silver",          category:"Spirits",   supplier:"LWC",             multiple:6.16, costUnit:15.59 },
  { id:"p26", name:"Jack Daniels",                       category:"Spirits",   supplier:"LWC",             multiple:5.14, costUnit:18.69 },
  { id:"p27", name:"Jamesons",                           category:"Spirits",   supplier:"LWC",             multiple:4.84, costUnit:21.50 },
  { id:"p28", name:"Disaronno",                          category:"Spirits",   supplier:"LWC",             multiple:5.26, costUnit:18.27 },
  { id:"p29", name:"Baileys Irish Cream",                category:"Spirits",   supplier:"LWC",             multiple:7.79, costUnit:12.34 },
  { id:"p30", name:"Jagermeister",                       category:"Spirits",   supplier:"LWC",             multiple:5.75, costUnit:16.71 },
  { id:"p31", name:"Kahlua",                             category:"Spirits",   supplier:"LWC",             multiple:7.42, costUnit:12.94 },
  { id:"p32", name:"Sambuca",                            category:"Spirits",   supplier:"LWC",             multiple:6.23, costUnit:15.43 },
  // Softs
  { id:"p33", name:"Redbull",                            category:"Softs",     supplier:"LWC",             multiple:3.03, costUnit:1.088 },
  { id:"p34", name:"Diet Coke",                          category:"Softs",     supplier:"LWC",             multiple:4.67, costUnit:0.535 },
  { id:"p35", name:"Coke",                               category:"Softs",     supplier:"LWC",             multiple:3.77, costUnit:0.664 },
  { id:"p36", name:"Folkington Tonic",                   category:"Softs",     supplier:"LWC",             multiple:5.92, costUnit:0.464 },
  { id:"p37", name:"Folkington Tonic Light",             category:"Softs",     supplier:"LWC",             multiple:5.92, costUnit:0.464 },
  { id:"p38", name:"Frobishers Orange Juice",            category:"Softs",     supplier:"LWC",             multiple:2.95, costUnit:1.118 },
  { id:"p39", name:"South Downs Sparkling",              category:"Softs",     supplier:"LWC",             multiple:6.40, costUnit:0.391 },
  { id:"p40", name:"Karma Lemony Lemonade",              category:"Softs",     supplier:"LWC",             multiple:2.90, costUnit:1.036 },
  { id:"p41", name:"Ginger Ale",                         category:"Softs",     supplier:"LWC",             multiple:4.85, costUnit:0.619 },
];

const INITIAL_BAR_EVENTS = [
  {
    id:"ev_import_6", type:"stocktake", date:"2026-05-01", label:"Stocktake 1 May",
    lines:{"p1":0,"p2":0,"p3":0,"p4":0,"p5":0,"p6":0,"p11":0,"p12":0,"p13":0,"p15":0,"p21":0,"p22":0,"p23":0,"p24":0,"p25":0,"p26":0,"p27":0,"p28":0,"p29":0,"p30":0,"p31":0,"p32":0,"p16":0,"p17":0,"p33":0,"p34":0,"p35":0,"p36":0,"p37":0,"p38":0,"p39":0,"p40":0,"p41":0}
  },
  {
    id:"ev_import_7", type:"order", date:"2026-05-15", label:"Order 15 May",
    lines:{"p1":24,"p2":24,"p3":24,"p4":12,"p5":12,"p6":24,"p11":24,"p12":24,"p13":24,"p15":24,"p21":4,"p22":4,"p24":4,"p25":4,"p26":4,"p27":4,"p28":4,"p29":4,"p30":4,"p31":4,"p32":4,"p16":4,"p17":4,"p33":24,"p34":24,"p35":24,"p36":24,"p37":24,"p38":24,"p39":24,"p40":24,"p41":24}
  },
  {
    id:"ev_import_8", type:"stocktake", date:"2026-06-01", label:"Stocktake 1 June",
    lines:{"p1":12,"p2":23,"p3":15,"p4":1,"p5":4,"p6":17,"p11":19,"p12":3,"p15":16,"p21":3,"p22":3,"p23":1,"p24":1,"p25":7,"p26":3,"p27":4,"p28":2,"p29":2,"p30":2,"p31":1,"p32":3,"p16":9,"p17":3,"p33":18,"p34":2,"p35":16,"p36":20,"p37":23,"p38":3,"p39":12,"p40":16,"p41":12}
  },
  {
    id:"ev_import_9", type:"order", date:"2026-06-02", label:"Order 2 June",
    lines:{"p1":12,"p3":12,"p4":12,"p5":12,"p6":6,"p11":24,"p12":24,"p13":24,"p15":12,"p21":1,"p22":1,"p23":3,"p24":3,"p28":1,"p29":1,"p30":1,"p31":1,"p17":2,"p34":24,"p35":24,"p36":12,"p38":24,"p39":24,"p41":12}
  },
];

const BAR_CATEGORIES = ["Wine","Beer","Cocktails","Spirits","Softs"];

const CAT_COLOURS = {
  Wine:      { bg:"#fce7f3", text:"#9d174d", border:"#f9a8d4" },
  Beer:      { bg:"#fef3c7", text:"#92400e", border:"#fcd34d" },
  Cocktails: { bg:"#f3e8ff", text:"#6b21a8", border:"#d8b4fe" },
  Spirits:   { bg:"#e0f2fe", text:"#075985", border:"#7dd3fc" },
  Softs:     { bg:"#dcfce7", text:"#166534", border:"#86efac" },
};

function CatBadge({ cat }) {
  const c = CAT_COLOURS[cat] || { bg:T.accentLight, text:T.accent, border:T.border };
  return <span style={{ fontSize:11, fontWeight:700, padding:"2px 9px", borderRadius:10, background:c.bg, color:c.text, border:`1px solid ${c.border}`, whiteSpace:"nowrap" }}>{cat}</span>;
}

function fmt2(n) { return n == null ? "—" : `£${Number(n).toFixed(2)}`; }
function fmtN(n) { return n == null || n === "" ? "—" : Number(n).toLocaleString(); }

// ─── currentStock: derive from events ────────────────────────────────────────
function computeStock(products, events) {
  // returns { productId: qty }
  const stock = {};
  products.forEach(p => { stock[p.id] = 0; });
  const sorted = [...events].sort((a,b) => a.date > b.date ? 1 : -1);
  sorted.forEach(ev => {
    Object.entries(ev.lines || {}).forEach(([pid, qty]) => {
      if (ev.type === "order") stock[pid] = (stock[pid] || 0) + Number(qty || 0);
      if (ev.type === "stocktake") stock[pid] = Number(qty || 0); // absolute
    });
  });
  return stock;
}

// ─── BarView ──────────────────────────────────────────────────────────────────
function BarView() {
  const [products, setProducts] = useState([]);
  const [events, setEvents]     = useState([]);
  const [loaded, setLoaded]     = useState(false);
  const [barView, setBarView]   = useState("stock");
  const [editProduct, setEditProduct] = useState(null);
  const [productForm, setProductForm] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [confirmDlg, setConfirmDlg]   = useState(null);

  useEffect(() => {
    (async () => {
      try { const r = await sbGet(BAR_PRODUCTS_KEY); setProducts(r || INITIAL_PRODUCTS); } catch { setProducts(INITIAL_PRODUCTS); }
      try { const r = await sbGet(BAR_EVENTS_KEY);   setEvents(r || INITIAL_BAR_EVENTS); }   catch { setEvents(INITIAL_BAR_EVENTS); }
      setLoaded(true);
    })();
  }, []);

  const saveProducts = async p => { setProducts(p); try { await sbSet(BAR_PRODUCTS_KEY, p); } catch(e) { console.error(e); } };
  const saveEvents   = async e => { setEvents(e);   try { await sbSet(BAR_EVENTS_KEY,   e); } catch(e) { console.error(e); } };

  const handleDeleteEvent = async id => {
    const ev = events.find(e=>e.id===id);
    setConfirmDlg({
      message: `Delete this ${ev?.type || "entry"}?`,
      subMessage: `"${ev?.label||ev?.date}" will be permanently removed. This will affect current stock calculations.`,
      onConfirm: async () => { setConfirmDlg(null); await saveEvents(events.filter(e => e.id !== id)); }
    });
  };

  const handleEditEvent = ev => {
    setEditingEvent(ev);
    setBarView(ev.type === "order" ? "order" : "stocktake");
  };

  const handleSaveEvent = async ev => {
    let updated;
    if (editingEvent) {
      updated = events.map(e => e.id === editingEvent.id ? { ...ev, id: editingEvent.id } : e);
    } else {
      updated = [...events, ev];
    }
    await saveEvents(updated);
    setEditingEvent(null);
    setBarView("history");
  };

  const stock = computeStock(products, events);

  if (!loaded) return <div style={{ padding:40, color:T.textLight }}>Loading bar data…</div>;

  const subTabs = [
    { id:"stock",      label:"Current Stock" },
    { id:"order",      label:"+ New Order" },
    { id:"stocktake",  label:"+ New Stocktake" },
    { id:"history",    label:"History" },
    { id:"report",     label:"Usage Report" },
    { id:"products",   label:"Products" },
  ];

  return (
    <div style={{ paddingTop:28 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:22 }}>
        <h2 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:22 }}>Bar Management</h2>
      </div>
      {confirmDlg && <ConfirmDialog message={confirmDlg.message} subMessage={confirmDlg.subMessage} onConfirm={confirmDlg.onConfirm} onCancel={()=>setConfirmDlg(null)}/>}

      {/* Sub-navigation */}
      <div style={{ display:"flex", gap:6, marginBottom:24, flexWrap:"wrap" }}>
        {subTabs.map(t => (
          <button key={t.id} onClick={() => { setEditingEvent(null); setBarView(t.id); }} style={{ background: barView===t.id ? T.midBlue : "#fff", color: barView===t.id ? "#fff" : T.textMid, border:`1.5px solid ${barView===t.id ? T.midBlue : T.border}`, padding:"8px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:barView===t.id?700:400 }}>
            {t.label}
          </button>
        ))}
      </div>

      {barView === "stock"     && <StockView products={products} stock={stock} events={events}/>}
      {barView === "order"     && <EventEntryView type="order"     products={products} stock={stock} editingEvent={editingEvent} onSave={handleSaveEvent} onCancel={() => { setEditingEvent(null); setBarView("history"); }}/>}
      {barView === "stocktake" && <EventEntryView type="stocktake" products={products} stock={stock} editingEvent={editingEvent} onSave={handleSaveEvent} onCancel={() => { setEditingEvent(null); setBarView("history"); }}/>}
      {barView === "history"   && <EventHistoryView events={events} products={products} onEdit={handleEditEvent} onDelete={handleDeleteEvent}/>}
      {barView === "report"    && <BarReportView  products={products} events={events}/>}
      {barView === "products"  && <ProductsView   products={products} onSave={saveProducts}/>}
    </div>
  );
}

// ─── Current Stock ────────────────────────────────────────────────────────────
function StockView({ products, stock, events }) {
  const lastStocktake = [...events].filter(e=>e.type==="stocktake").sort((a,b)=>b.date>a.date?1:-1)[0];
  const lastOrder     = [...events].filter(e=>e.type==="order").sort((a,b)=>b.date>a.date?1:-1)[0];

  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:24 }}>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:6 }}>Last Stocktake</div>
          <div style={{ fontSize:18, fontWeight:700, color:T.midBlue }}>{lastStocktake ? lastStocktake.date : "None yet"}</div>
          {lastStocktake && <div style={{ fontSize:12, color:T.textLight, marginTop:3 }}>{lastStocktake.label || ""}</div>}
        </div>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:6 }}>Last Order</div>
          <div style={{ fontSize:18, fontWeight:700, color:T.midBlue }}>{lastOrder ? lastOrder.date : "None yet"}</div>
          {lastOrder && <div style={{ fontSize:12, color:T.textLight, marginTop:3 }}>{lastOrder.label || ""}</div>}
        </div>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:6 }}>Stock Value (Cost)</div>
          <div style={{ fontSize:18, fontWeight:700, color:T.midBlue }}>
            {fmt2(products.reduce((s,p) => s + (stock[p.id]||0) * (p.costUnit||0), 0))}
          </div>
        </div>
      </div>

      {BAR_CATEGORIES.map(cat => {
        const prods = products.filter(p => p.category === cat);
        if (!prods.length) return null;
        const cc = CAT_COLOURS[cat];
        return (
          <div key={cat} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, marginBottom:16, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            <div style={{ padding:"12px 20px", background:cc.bg, borderBottom:`1px solid ${cc.border}`, display:"flex", alignItems:"center", gap:10 }}>
              <CatBadge cat={cat}/>
              <span style={{ fontSize:12, color:cc.text, fontWeight:500 }}>{prods.length} products</span>
              <span style={{ marginLeft:"auto", fontSize:12, color:cc.text, fontWeight:600 }}>
                Stock value: {fmt2(prods.reduce((s,p) => s + (stock[p.id]||0) * (p.costUnit||0), 0))}
              </span>
            </div>
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ background:"#f5f9ff" }}>
                  {["Product","Supplier","Buy Price","Multiple","Est. Sale Price","Current Stock","Stock Value"].map(h => (
                    <th key={h} style={{ padding:"8px 14px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {prods.map((p,i) => {
                  const qty = stock[p.id] || 0;
                  const stockVal = p.costUnit ? qty * p.costUnit : null;
                  const salePrice = p.costUnit ? p.costUnit * p.multiple : null;
                  const low = qty <= 2;
                  return (
                    <tr key={p.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none", background:low&&qty===0?"#fff5f5":low?"#fffbeb":"transparent" }}>
                      <td style={{ padding:"10px 14px", fontSize:13, fontWeight:600, color:T.text }}>{p.name}</td>
                      <td style={{ padding:"10px 14px", fontSize:12, color:T.textLight }}>{p.supplier}</td>
                      <td style={{ padding:"10px 14px", fontSize:13 }}>{fmt2(p.costUnit)}</td>
                      <td style={{ padding:"10px 14px", fontSize:13, color:T.textMid }}>{p.multiple}x</td>
                      <td style={{ padding:"10px 14px", fontSize:13, color:T.green, fontWeight:500 }}>{fmt2(salePrice)}</td>
                      <td style={{ padding:"10px 14px" }}>
                        <span style={{ fontSize:14, fontWeight:700, color:qty===0?T.red:qty<=3?T.amber:T.text }}>{qty}</span>
                        {qty===0 && <span style={{ fontSize:10, color:T.red, marginLeft:6, fontWeight:600 }}>OUT</span>}
                        {qty>0&&qty<=3 && <span style={{ fontSize:10, color:T.amber, marginLeft:6, fontWeight:600 }}>LOW</span>}
                      </td>
                      <td style={{ padding:"10px 14px", fontSize:13, color:T.textMid }}>{stockVal != null ? fmt2(stockVal) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ─── Order / Stocktake Entry ──────────────────────────────────────────────────
function ProductEntryCard({ p, lines, stock, setLine, isOrder }) {
  const val      = lines[p.id];
  const curStock = stock[p.id] || 0;
  const hasVal   = val !== "" && val != null && Number(val) !== 0;
  const stockOut  = curStock === 0;
  const stockLow  = curStock <= 3;
  const stockColour = stockOut ? T.red : stockLow ? T.amber : T.green;
  const stockBg    = stockOut ? T.redBg : stockLow ? T.amberBg : T.greenBg;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background:hasVal?T.accentLight:T.bgInput, border:`1.5px solid ${hasVal?T.accentMid:T.border}`, borderRadius:8, transition:"all .15s" }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:600, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</div>
        <div style={{ fontSize:11, color:T.textLight, marginTop:2 }}>Buy: {fmt2(p.costUnit)}</div>
      </div>
      {isOrder && (
        <div style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", background:stockBg, border:`1px solid ${stockColour}`, borderRadius:6, padding:"3px 8px", minWidth:44 }}>
          <span style={{ fontSize:16, fontWeight:700, color:stockColour, lineHeight:1.1 }}>{curStock}</span>
          <span style={{ fontSize:9, fontWeight:600, color:stockColour, textTransform:"uppercase", letterSpacing:.5 }}>{stockOut?"out":stockLow?"low":"in stock"}</span>
        </div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
        {isOrder && (
          <button onClick={()=>setLine(p.id, Math.max(0,(Number(val)||0)-1))} style={{ width:26, height:26, border:`1px solid ${T.border}`, borderRadius:4, background:"#fff", cursor:"pointer", fontSize:16, color:T.textMid, display:"flex", alignItems:"center", justifyContent:"center" }}>−</button>
        )}
        <input
          type="number" min="0" step={isOrder ? 1 : (p.category === "Softs" ? 1 : 0.5)}
          value={val ?? (isOrder ? "" : (stock[p.id]||0))}
          onChange={e => setLine(p.id, e.target.value)}
          style={{ width:64, textAlign:"center", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontSize:14, padding:"5px 6px", outline:"none" }}
        />
        {isOrder && (
          <button onClick={()=>setLine(p.id, (Number(val)||0)+1)} style={{ width:26, height:26, border:`1px solid ${T.border}`, borderRadius:4, background:"#fff", cursor:"pointer", fontSize:16, color:T.textMid, display:"flex", alignItems:"center", justifyContent:"center" }}>+</button>
        )}
        <span style={{ fontSize:11, color:T.textLight, width:28 }}>{isOrder?"units":"in stock"}</span>
      </div>
    </div>
  );
}

function EventEntryView({ type, products, stock, onSave, onCancel, editingEvent }) {
  const today = new Date().toISOString().slice(0,10);
  const [date,  setDate]  = useState(editingEvent?.date  || today);
  const [label, setLabel] = useState(editingEvent?.label || "");
  const [lines, setLines] = useState(editingEvent?.lines || {});
  const [saving, setSaving] = useState(false);

  const initStocktake = () => {
    if (editingEvent) return; // editing: lines already pre-filled above
    const init = {};
    products.forEach(p => { init[p.id] = stock[p.id] || 0; });
    setLines(init);
  };

  useEffect(() => {
    if (type === "stocktake" && !editingEvent) initStocktake();
  }, []);

  const setLine = (pid, val) => setLines(l => ({ ...l, [pid]: val === "" ? "" : Number(val) }));

  const handleSave = async () => {
    if (!date) { alert("Please set a date."); return; }
    setSaving(true);
    const ev = {
      id:    editingEvent?.id || `ev_${Date.now()}`,
      type,
      date,
      label: label || (type === "order" ? "Order" : "Stocktake"),
      lines: Object.fromEntries(Object.entries(lines).filter(([,v]) => v !== "" && v !== 0 && v != null)),
    };
    await onSave(ev);
    setSaving(false);
  };

  const isOrder  = type === "order";
  const isEditing = !!editingEvent;
  const title    = isEditing
    ? `Edit ${isOrder ? "Order" : "Stocktake"}: ${editingEvent.label}`
    : isOrder ? "New Order" : "New Stocktake";
  const hint     = isOrder
    ? "Enter quantities ordered for each product. Leave blank or 0 to skip."
    : "Enter actual counted stock for each product.";

  const totalLines = Object.entries(lines).filter(([,v]) => v !== "" && Number(v) > 0).length;
  const totalCost  = isOrder
    ? products.reduce((s,p) => s + (Number(lines[p.id]||0)) * (p.costUnit||0), 0)
    : null;

  return (
    <div>
      {/* Header */}
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 24px", marginBottom:20, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:17 }}>{title}</h3>
        <p style={{ margin:"0 0 16px", fontSize:13, color:T.textMid }}>{hint}</p>
        <div style={{ display:"flex", gap:20, flexWrap:"wrap", alignItems:"flex-end" }}>
          <div>
            <FLabel>Date</FLabel>
            <FInput type="date" value={date} onChange={setDate}/>
          </div>
          <div style={{ flex:1, minWidth:200 }}>
            <FLabel>Label (optional)</FLabel>
            <FInput value={label} onChange={setLabel} placeholder={isOrder ? "e.g. Order before 14 June wedding" : "e.g. After 14 June wedding"}/>
          </div>
          {totalLines > 0 && (
            <div style={{ background:T.accentLight, borderRadius:8, padding:"10px 16px", display:"flex", gap:20 }}>
              <span style={{ fontSize:13, color:T.midBlue }}><strong>{totalLines}</strong> lines</span>
              {totalCost > 0 && <span style={{ fontSize:13, color:T.midBlue }}>Est. cost: <strong>{fmt2(totalCost)}</strong></span>}
            </div>
          )}
        </div>
      </div>

      {/* Product lines — orders: by supplier then category; stocktakes: by category only */}
      {isOrder ? (
        // ORDER: group by supplier, then category within each supplier
        (() => {
          const suppliers = [...new Set(products.map(p => p.supplier))].sort();
          return suppliers.map(supplier => {
            const supplierProds = products.filter(p => p.supplier === supplier);
            if (!supplierProds.length) return null;
            const cats = [...new Set(supplierProds.map(p => p.category))];
            return (
              <div key={supplier} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, marginBottom:14, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
                <div style={{ padding:"10px 18px", background:T.midBlueBg, borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:13, fontWeight:700, color:T.midBlue }}>{supplier}</span>
                  <span style={{ fontSize:11, color:T.textLight }}>{supplierProds.length} product{supplierProds.length!==1?"s":""}</span>
                </div>
                {cats.map(cat => {
                  const prods = supplierProds.filter(p => p.category === cat);
                  const cc = CAT_COLOURS[cat];
                  return (
                    <div key={cat}>
                      <div style={{ padding:"6px 18px", background:cc.bg, borderBottom:`1px solid ${cc.border}`, borderTop:`1px solid ${cc.border}`, display:"flex", alignItems:"center", gap:8 }}>
                        <CatBadge cat={cat}/>
                      </div>
                      <div style={{ padding:"12px 18px", display:"grid", gridTemplateColumns:"1fr", gap:"8px" }}>
                        {prods.map(p => <ProductEntryCard key={p.id} p={p} lines={lines} stock={stock} setLine={setLine} isOrder={true}/>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          });
        })()
      ) : (
        // STOCKTAKE: group by category only
        BAR_CATEGORIES.map(cat => {
          const prods = products.filter(p => p.category === cat);
          if (!prods.length) return null;
          const cc = CAT_COLOURS[cat];
          return (
            <div key={cat} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, marginBottom:14, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <div style={{ padding:"10px 18px", background:cc.bg, borderBottom:`1px solid ${cc.border}` }}>
                <CatBadge cat={cat}/>
              </div>
              <div style={{ padding:"14px 18px", display:"grid", gridTemplateColumns:"1fr", gap:"8px" }}>
                {prods.map(p => <ProductEntryCard key={p.id} p={p} lines={lines} stock={stock} setLine={setLine} isOrder={false}/>)}
              </div>
            </div>
          );
        })
      )}

      <div style={{ display:"flex", gap:12, marginTop:8, position:"sticky", bottom:20 }}>
        <button onClick={handleSave} disabled={saving} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"13px 36px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:15, fontWeight:700, boxShadow:"0 2px 8px rgba(30,77,140,.25)" }}>
          {saving ? "Saving…" : isEditing ? "Save Changes" : isOrder ? "Save Order" : "Save Stocktake"}
        </button>
        {onCancel && (
          <button onClick={onCancel} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"13px 24px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:14 }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Event History ────────────────────────────────────────────────────────────
function EventHistoryView({ events, products, onEdit, onDelete }) {
  const [printMode, setPrintMode] = useState(false);
  const sorted = [...events].sort((a,b) => b.date > a.date ? 1 : -1);
  const [expanded, setExpanded] = useState(null);

  const printText = sorted.map(ev => {
    const isOrder = ev.type === "order";
    const lines = Object.entries(ev.lines||{}).map(([pid,qty]) => {
      const prod = products.find(p=>p.id===pid);
      return `  ${prod ? prod.name : pid}: ${qty}`;
    });
    return [`${ev.date} — ${isOrder?"ORDER":"STOCKTAKE"}: ${ev.label||""}`, ...lines].join("\n");
  }).join("\n\n");

  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText||"No history yet."}</pre>
    </div>
  );

  if (!sorted.length) {
    return (
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:48, textAlign:"center", color:T.textLight }}>
        <p style={{ fontSize:16 }}>No orders or stocktakes recorded yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      <div style={{ display:"flex", gap:16, marginBottom:18 }}>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"14px 20px", flex:1, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:4 }}>Stocktakes</div>
          <div style={{ fontSize:24, fontWeight:700, color:T.midBlue }}>{sorted.filter(e=>e.type==="stocktake").length}</div>
        </div>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"14px 20px", flex:1, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:4 }}>Orders</div>
          <div style={{ fontSize:24, fontWeight:700, color:T.midBlue }}>{sorted.filter(e=>e.type==="order").length}</div>
        </div>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"14px 20px", flex:1, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:4 }}>Total Est. Ordered</div>
          <div style={{ fontSize:24, fontWeight:700, color:T.midBlue }}>
            {fmt2(sorted.filter(e=>e.type==="order").reduce((sum,ev) =>
              sum + products.reduce((s,p) => s + (Number(ev.lines?.[p.id]||0)) * (p.costUnit||0), 0), 0
            ))}
          </div>
        </div>
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {sorted.map(ev => {
          const isOrder     = ev.type === "order";
          const isExpanded  = expanded === ev.id;
          const lineCount   = Object.keys(ev.lines||{}).length;
          const orderCost   = isOrder ? products.reduce((s,p) => s + (Number(ev.lines?.[p.id]||0)) * (p.costUnit||0), 0) : null;
          const typeColour  = isOrder
            ? { bg:T.midBlueBg, text:T.midBlue, border:T.border, label:"Order" }
            : { bg:T.greenBg,   text:T.green,   border:"#86efac", label:"Stocktake" };

          return (
            <div key={ev.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              {/* Row header */}
              <div style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 18px", cursor:"pointer" }}
                onClick={() => setExpanded(isExpanded ? null : ev.id)}>
                {/* Type badge */}
                <span style={{ fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:10, background:typeColour.bg, color:typeColour.text, border:`1px solid ${typeColour.border}`, flexShrink:0 }}>
                  {typeColour.label}
                </span>
                {/* Date */}
                <span style={{ fontSize:14, fontWeight:700, color:T.accent, flexShrink:0 }}>
                  {new Date(ev.date+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}
                </span>
                <span style={{ fontSize:12, color:T.textLight, flexShrink:0 }}>
                  {dayOfWeek(ev.date)}
                </span>
                {/* Label */}
                <span style={{ fontSize:14, color:T.text, fontWeight:500, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {ev.label}
                </span>
                {/* Meta */}
                <span style={{ fontSize:12, color:T.textLight, flexShrink:0 }}>{lineCount} product{lineCount!==1?"s":""}</span>
                {orderCost > 0 && <span style={{ fontSize:13, fontWeight:600, color:T.midBlue, flexShrink:0 }}>{fmt2(orderCost)}</span>}
                {/* Actions */}
                <div style={{ display:"flex", gap:6, flexShrink:0 }} onClick={e=>e.stopPropagation()}>
                  <button onClick={()=>onEdit(ev)} style={{ background:T.accentLight, border:"none", color:T.accent, padding:"4px 12px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600 }}>Edit</button>
                  <button onClick={()=>onDelete(ev.id)} style={{ background:T.redBg, border:"none", color:T.red, padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>✕</button>
                </div>
                <span style={{ fontSize:14, color:T.textLight }}>{isExpanded?"▲":"▼"}</span>
              </div>

              {/* Expanded product lines */}
              {isExpanded && (
                <div style={{ borderTop:`1px solid ${T.border}`, background:T.bg, padding:"12px 18px" }}>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(240px,1fr))", gap:"8px 16px" }}>
                    {Object.entries(ev.lines||{}).map(([pid, qty]) => {
                      const prod = products.find(p=>p.id===pid);
                      if (!prod) return null;
                      const lineVal = isOrder && prod.costUnit ? qty * prod.costUnit : null;
                      return (
                        <div key={pid} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", background:"#fff", borderRadius:6, border:`1px solid ${T.border}` }}>
                          <CatBadge cat={prod.category}/>
                          <span style={{ flex:1, fontSize:12, fontWeight:500, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{prod.name}</span>
                          <span style={{ fontSize:13, fontWeight:700, color:T.midBlue, flexShrink:0 }}>{qty}</span>
                          {lineVal != null && <span style={{ fontSize:11, color:T.textLight, flexShrink:0 }}>{fmt2(lineVal)}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Bar Usage Report ─────────────────────────────────────────────────────────
function BarReportView({ products, events }) {
  const stocktakes = [...events].filter(e=>e.type==="stocktake").sort((a,b)=>a.date>b.date?1:-1);
  const [fromIdx, setFromIdx] = useState(0);
  const [toIdx,   setToIdx]   = useState(Math.min(1, stocktakes.length-1));

  if (stocktakes.length < 2) {
    return (
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:48, textAlign:"center", color:T.textLight, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <div style={{ fontSize:32, marginBottom:12 }}>📦</div>
        <p style={{ fontSize:16, fontWeight:600, color:T.textMid, marginBottom:8 }}>At least two stocktakes needed</p>
        <p style={{ fontSize:13 }}>Record two stocktakes to see usage between them. Any orders placed between stocktakes will be accounted for automatically.</p>
      </div>
    );
  }

  const fromST = stocktakes[fromIdx];
  const toST   = stocktakes[toIdx];

  // Orders between the two stocktake dates (inclusive of from, exclusive of to)
  const ordersInRange = events.filter(e =>
    e.type === "order" && e.date >= fromST.date && e.date < toST.date
  );

  // Usage per product: opening + ordered - closing = used
  const rows = products.map(p => {
    const opening = Number(fromST.lines?.[p.id] || 0);
    const ordered = ordersInRange.reduce((s,o) => s + Number(o.lines?.[p.id]||0), 0);
    const closing = Number(toST.lines?.[p.id] || 0);
    const used    = opening + ordered - closing;
    const costVal = p.costUnit ? used * p.costUnit : null;
    const saleVal = p.costUnit ? used * p.costUnit * p.multiple : null;
    return { ...p, opening, ordered, closing, used, costVal, saleVal };
  }).filter(r => r.used !== 0 || r.ordered > 0);

  const totCost = rows.reduce((s,r) => s + (r.costVal||0), 0);
  const totSale = rows.reduce((s,r) => s + (r.saleVal||0), 0);
  const totUsed = rows.filter(r=>r.used>0).length;

  return (
    <div>
      {/* Controls */}
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 24px", marginBottom:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <h3 style={{ margin:"0 0 14px", color:T.midBlue, fontWeight:700, fontSize:16 }}>Compare Stocktakes</h3>
        <div style={{ display:"flex", gap:24, flexWrap:"wrap", alignItems:"flex-end" }}>
          <div>
            <FLabel>From stocktake</FLabel>
            <select value={fromIdx} onChange={e=>setFromIdx(Number(e.target.value))} style={{ background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"8px 11px", outline:"none" }}>
              {stocktakes.map((s,i) => <option key={s.id} value={i}>{s.date} — {s.label}</option>)}
            </select>
          </div>
          <div>
            <FLabel>To stocktake</FLabel>
            <select value={toIdx} onChange={e=>setToIdx(Number(e.target.value))} style={{ background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"8px 11px", outline:"none" }}>
              {stocktakes.map((s,i) => <option key={s.id} value={i}>{s.date} — {s.label}</option>)}
            </select>
          </div>
          {ordersInRange.length > 0 && (
            <div style={{ background:T.midBlueBg, borderRadius:8, padding:"8px 14px", fontSize:12, color:T.midBlue, fontWeight:600 }}>
              {ordersInRange.length} order{ordersInRange.length!==1?"s":""} included between dates
            </div>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:22 }}>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:6 }}>Products Used</div>
          <div style={{ fontSize:28, fontWeight:700, color:T.midBlue }}>{totUsed}</div>
        </div>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:6 }}>Est. Cost of Stock Used</div>
          <div style={{ fontSize:28, fontWeight:700, color:T.midBlue }}>{fmt2(totCost)}</div>
        </div>
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:T.textLight, fontWeight:600, marginBottom:6 }}>Est. Sale Value</div>
          <div style={{ fontSize:28, fontWeight:700, color:T.green }}>{fmt2(totSale)}</div>
          {totCost > 0 && <div style={{ fontSize:12, color:T.textLight, marginTop:3 }}>Implied margin: {Math.round((1-totCost/totSale)*100)}%</div>}
        </div>
      </div>

      {/* Breakdown by category */}
      {BAR_CATEGORIES.map(cat => {
        const catRows = rows.filter(r => r.category === cat);
        if (!catRows.length) return null;
        const cc = CAT_COLOURS[cat];
        const catCost = catRows.reduce((s,r)=>s+(r.costVal||0),0);
        const catSale = catRows.reduce((s,r)=>s+(r.saleVal||0),0);
        return (
          <div key={cat} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, marginBottom:14, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            <div style={{ padding:"12px 20px", background:cc.bg, borderBottom:`1px solid ${cc.border}`, display:"flex", alignItems:"center", gap:12 }}>
              <CatBadge cat={cat}/>
              <span style={{ marginLeft:"auto", fontSize:12, color:cc.text, fontWeight:600 }}>Cost: {fmt2(catCost)} · Est. sale: {fmt2(catSale)}</span>
            </div>
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ background:"#f5f9ff" }}>
                  {["Product","Opening","Ordered","Closing","Used","Buy Price","Cost of Usage","Est. Sale Value"].map(h=>(
                    <th key={h} style={{ padding:"8px 12px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {catRows.map((r,i) => (
                  <tr key={r.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none", background:r.used<0?"#fff5f5":"transparent" }}>
                    <td style={{ padding:"9px 12px", fontSize:13, fontWeight:600 }}>{r.name}</td>
                    <td style={{ padding:"9px 12px", fontSize:13, color:T.textMid }}>{fmtN(r.opening)}</td>
                    <td style={{ padding:"9px 12px", fontSize:13, color:r.ordered>0?T.green:T.textLight }}>{r.ordered>0?`+${r.ordered}`:"—"}</td>
                    <td style={{ padding:"9px 12px", fontSize:13, color:T.textMid }}>{fmtN(r.closing)}</td>
                    <td style={{ padding:"9px 12px" }}>
                      <span style={{ fontSize:14, fontWeight:700, color:r.used>0?T.text:r.used<0?T.red:T.textLight }}>{r.used>0?r.used:r.used<0?`${r.used} ⚠`:"—"}</span>
                    </td>
                    <td style={{ padding:"9px 12px", fontSize:13, color:T.textMid }}>{fmt2(r.costUnit)}</td>
                    <td style={{ padding:"9px 12px", fontSize:13, fontWeight:500 }}>{r.costVal!=null&&r.used>0?fmt2(r.costVal):"—"}</td>
                    <td style={{ padding:"9px 12px", fontSize:13, color:T.green, fontWeight:500 }}>{r.saleVal!=null&&r.used>0?fmt2(r.saleVal):"—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ─── Products Admin ───────────────────────────────────────────────────────────
function ProductsView({ products, onSave }) {
  const [editId, setEditId]   = useState(null);
  const [form, setForm]       = useState(null);
  const [filterCat, setFilterCat] = useState("All");

  const updateForm = (k,v) => setForm(f=>({...f,[k]:v}));
  const emptyProduct = () => ({ id:`p${Date.now()}`, name:"", category:"Wine", supplier:"", multiple:1, costUnit:"" });

  const handleEdit = p => { setForm({...p}); setEditId(p.id); };
  const handleNew  = () => { setForm(emptyProduct()); setEditId("new"); };
  const handleDelete = id => {
    const p = products.find(x=>x.id===id);
    if (!confirm(`Delete "${p?.name||"this product"}"? This cannot be undone.`)) return;
    onSave(products.filter(p=>p.id!==id));
  };
  const handleSubmit = () => {
    if (!form.name) { alert("Product name required."); return; }
    let updated;
    if (editId==="new") updated = [...products, {...form, multiple:Number(form.multiple), costUnit:form.costUnit?Number(form.costUnit):null}];
    else updated = products.map(p=>p.id===editId?{...form,multiple:Number(form.multiple),costUnit:form.costUnit?Number(form.costUnit):null}:p);
    onSave(updated);
    setEditId(null); setForm(null);
  };

  const visibleCats = ["All", ...BAR_CATEGORIES];
  const filtered = filterCat==="All" ? products : products.filter(p=>p.category===filterCat);

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
        <div style={{ display:"flex", gap:6 }}>
          {visibleCats.map(c=>(
            <button key={c} onClick={()=>setFilterCat(c)} style={{ background:filterCat===c?T.midBlue:"#fff", color:filterCat===c?"#fff":T.textMid, border:`1px solid ${filterCat===c?T.midBlue:T.border}`, padding:"6px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:filterCat===c?700:400 }}>{c}</button>
          ))}
        </div>
        <button onClick={handleNew} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"8px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>+ Add Product</button>
      </div>

      {/* Edit/Add form */}
      {form && (
        <div style={{ background:"#fff", border:`2px solid ${T.accentMid}`, borderRadius:10, padding:24, marginBottom:20, boxShadow:"0 4px 16px rgba(59,130,246,.1)" }}>
          <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:16 }}>{editId==="new"?"New Product":"Edit Product"}</h3>
          <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr", gap:"12px 18px" }}>
            <div><FLabel required>Product Name</FLabel><FInput value={form.name} onChange={v=>updateForm("name",v)}/></div>
            <div>
              <FLabel>Category</FLabel>
              <select value={form.category} onChange={e=>updateForm("category",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none" }}>
                {BAR_CATEGORIES.map(c=><option key={c}>{c}</option>)}
              </select>
            </div>
            <div><FLabel>Supplier</FLabel><FInput value={form.supplier||""} onChange={v=>updateForm("supplier",v)}/></div>
            <div><FLabel>Buy Price (£)</FLabel><FInput type="number" value={form.costUnit||""} onChange={v=>updateForm("costUnit",v)}/></div>
            <div><FLabel>Multiple</FLabel><FInput type="number" value={form.multiple||""} onChange={v=>updateForm("multiple",v)}/></div>
          </div>
          <div style={{ display:"flex", gap:10, marginTop:16 }}>
            <button onClick={handleSubmit} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"9px 22px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700 }}>Save</button>
            <button onClick={()=>{setForm(null);setEditId(null);}} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"9px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13 }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr style={{ background:"#eef4fd" }}>
              {["Product","Category","Supplier","Buy Price","Multiple","Est. Sale",""].map(h=>(
                <th key={h} style={{ padding:"10px 14px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.2, textTransform:"uppercase", fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p,i)=>(
              <tr key={p.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none" }}
                onMouseEnter={e=>e.currentTarget.style.background="#f5f9ff"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <td style={{ padding:"10px 14px", fontSize:13, fontWeight:600, color:T.text }}>{p.name}</td>
                <td style={{ padding:"10px 14px" }}><CatBadge cat={p.category}/></td>
                <td style={{ padding:"10px 14px", fontSize:12, color:T.textLight }}>{p.supplier}</td>
                <td style={{ padding:"10px 14px", fontSize:13 }}>{fmt2(p.costUnit)}</td>
                <td style={{ padding:"10px 14px", fontSize:13, color:T.textMid }}>{p.multiple}x</td>
                <td style={{ padding:"10px 14px", fontSize:13, color:T.green, fontWeight:500 }}>{p.costUnit ? fmt2(p.costUnit*p.multiple) : "—"}</td>
                <td style={{ padding:"10px 14px", whiteSpace:"nowrap" }}>
                  <button onClick={()=>handleEdit(p)} style={{ background:T.accentLight, border:"none", color:T.accent, padding:"4px 12px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600, marginRight:6 }}>Edit</button>
                  <button onClick={()=>handleDelete(p.id)} style={{ background:T.redBg, border:"none", color:T.red, padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENQUIRIES MODULE
// ═══════════════════════════════════════════════════════════════════════════════

const ENQUIRIES_STORAGE = "hbf_enquiries_v1";
const VIEWINGS_STORAGE  = "hbf_viewings_v1";

const INITIAL_ENQUIRIES = [
  {
    "id": "enq_1",
    "name": "Chelsea Nokes & Kai",
    "eventType": "Wedding",
    "numbers": "50",
    "datePreference": "2026-27",
    "email": "chelsea.nokes@icloud.com",
    "phone": "",
    "source": "Bridebook - WF",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2025-01-22",
        "method": "email",
        "note": "Chelsea replied to my email to say that they love HF and nothing compares but their dog is unwell and they are having to cover  expensive vet bills - now looking at end of life.l  Will plan wedding again when they can."
      },
      {
        "date": "2025-11-05",
        "method": "email",
        "note": "Chelsea and partner are still looking at venues - aiming to see 2 per month!"
      },
      {
        "date": "2025-11-05",
        "method": "email",
        "note": "Sent a follow up today."
      },
      {
        "date": "2025-10-09",
        "method": "email",
        "note": "Chelsea sent email following visiting the wedding fayre.  Have sent all the info."
      }
    ]
  },
  {
    "id": "enq_2",
    "name": "Tom Manktelow",
    "eventType": "Wedding party",
    "numbers": "90",
    "datePreference": "2027",
    "email": "tmanktelow21@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-15",
        "method": "email",
        "note": "Sent a follow up after sending Tom the party package info."
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Semt a follow up - move to no longer interested if don't hear back."
      },
      {
        "date": "2026-01-08",
        "method": "email",
        "note": "Tom replied - they are now thinking about a midweek wedding - have sent details."
      },
      {
        "date": "2026-01-06",
        "method": "email",
        "note": "Sent a follow up"
      },
      {
        "date": "2025-12-01",
        "method": "email",
        "note": "Tom emailed back.  Have said we're not able to do viewings for 2027 weddings until Spring but we can hold a preffered date with £100 deposit.  Await his response."
      },
      {
        "date": "2025-10-28",
        "method": "email",
        "note": "Have sent all the info - given full prices but said we can offer a slightly different package for parties out of the wedding season."
      }
    ]
  },
  {
    "id": "enq_3",
    "name": "Alex Krolak",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2027/2028",
    "email": "alexmkrolak@gmail.com",
    "phone": "",
    "source": "Friends married at the farm",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a final follow up."
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Sent a follow up."
      },
      {
        "date": "2026-02-03",
        "method": "email",
        "note": "sent a follow up."
      },
      {
        "date": "2026-01-27",
        "method": "email",
        "note": "Have sent all the details."
      }
    ]
  },
  {
    "id": "enq_4",
    "name": "Kristina & Isaac",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "?",
    "email": "kristinaquantrell@gmail.com",
    "phone": "",
    "source": "UK BRIDES",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a final follow up"
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Sent a follow up."
      },
      {
        "date": "2026-02-03",
        "method": "email",
        "note": "sent a follow up."
      },
      {
        "date": "2026-01-30",
        "method": "email",
        "note": "Have sent all the details."
      }
    ]
  },
  {
    "id": "enq_5",
    "name": "Jess Greenwood",
    "eventType": "10 Year Wedding Anniversary",
    "numbers": "",
    "datePreference": "Thur 24 June 2027",
    "email": "jessica.blackman@live.co.uk",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a final follow up"
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Sent a follow up."
      },
      {
        "date": "2026-02-10",
        "method": "email",
        "note": "Have asked Jess for a bit more info"
      }
    ]
  },
  {
    "id": "enq_6",
    "name": "Sam & Bex",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2026 or 2027",
    "email": "sam.and.bex.thomas@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a follow up"
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Sent a follow up."
      },
      {
        "date": "2026-02-20",
        "method": "email",
        "note": "Have sent all the info."
      }
    ]
  },
  {
    "id": "enq_7",
    "name": "Lottie & Andy",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "",
    "email": "charlottecurtisdesign@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a follow up"
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Sent a follow up."
      },
      {
        "date": "2026-02-25",
        "method": "email",
        "note": "Lottie would like to arrange a viewing - have asked when they're looking to get married as she wanted a viewing sooner rather than later."
      },
      {
        "date": "2026-02-23",
        "method": "email",
        "note": "Sent all the info"
      }
    ]
  },
  {
    "id": "enq_8",
    "name": "Michael Trew",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2026",
    "email": "mtrew222@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a follow up and let him know we have one weekend now available"
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Sent a follow up."
      },
      {
        "date": "2026-02-23",
        "method": "email",
        "note": "Michael and his boyfriend want to marry in 2026 - have asked when they are looking to marry and sent all the info."
      }
    ]
  },
  {
    "id": "enq_9",
    "name": "Caroline Kinderman",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2026 - happy with midweek in summer holidays",
    "email": "",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a follow up"
      },
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Sent a follow up. 23..02.20 sent all the info"
      }
    ]
  },
  {
    "id": "enq_10",
    "name": "Charlotte Edwards",
    "eventType": "Wedding",
    "numbers": "100-120",
    "datePreference": "2028",
    "email": "charlotteedwards023@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a follow up"
      },
      {
        "date": "2026-03-03",
        "method": "email",
        "note": "Charlotte is looking for a wedding venue that can allow a relaxed set up with perhaps food vendors etc rather than traditional set up - I've sent all the info."
      }
    ]
  },
  {
    "id": "enq_11",
    "name": "Jennifer MacDonald",
    "eventType": "",
    "numbers": "",
    "datePreference": "",
    "email": "jenmac2@hotmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a follow up"
      },
      {
        "date": "2026-03-10",
        "method": "email",
        "note": "Interested poss in a date this year, or otherwise 2027.  Have sent all info."
      }
    ]
  },
  {
    "id": "enq_12",
    "name": "Jemma Stolworthy",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2027",
    "email": "stolworthyjemma@yahoo.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "Sent a follow up"
      },
      {
        "date": "2026-03-20",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_13",
    "name": "Grace & Charlie",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2027",
    "email": "gracedellar4@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-14",
        "method": "email",
        "note": "CHASE UP WK BEG 20 APRIL"
      },
      {
        "date": "2026-04-13",
        "method": "email",
        "note": "Grace has finally replied - she said that they'd like to visit on 2nd May.  Have explained fully booked and offered different dates."
      },
      {
        "date": "2026-03-27",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_14",
    "name": "Sarah Jane Leaver",
    "eventType": "Wedding",
    "numbers": "?",
    "datePreference": "?",
    "email": "sarahjaneleaver@icloud.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-07",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_15",
    "name": "Holly",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "?",
    "email": "hollymariesherwood@icloud.com",
    "phone": "",
    "source": "UK BRIDES",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-20",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_16",
    "name": "Megan Scott",
    "eventType": "Wedding",
    "numbers": "?",
    "datePreference": "?",
    "email": "megan.scott6@icloud.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-05",
        "method": "email",
        "note": "Have sent all the info - Megan wanted to visit over the weekend."
      }
    ]
  },
  {
    "id": "enq_17",
    "name": "Ross Hawkes",
    "eventType": "Wedding",
    "numbers": "?",
    "datePreference": "?",
    "email": "rosshawkes@yahoo.co.uk",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-05",
        "method": "email",
        "note": "Have sent all the info."
      }
    ]
  },
  {
    "id": "enq_18",
    "name": "Judith Panugaling",
    "eventType": "Wedding",
    "numbers": "200",
    "datePreference": "2028-07-01 00:00:00",
    "email": "judithpanugaling25@gmail.com",
    "phone": "",
    "source": "UK BRIDES",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": []
  },
  {
    "id": "enq_19",
    "name": "Francesca Skinner-Clark",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "15/07/2028 - 2028",
    "email": "frankiiee12@googlemail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": []
  },
  {
    "id": "enq_20",
    "name": "Charlotte",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2026-08-27 00:00:00",
    "email": "velsaunders@icloud.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": []
  },
  {
    "id": "enq_21",
    "name": "Charlotte",
    "eventType": "",
    "numbers": "",
    "datePreference": "",
    "email": "charlotte.mizzi998@gmail.com",
    "phone": "",
    "source": "WHITESPACE",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": []
  },
  {
    "id": "enq_22",
    "name": "Ellie Martin",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "",
    "email": "",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-15",
        "method": "email",
        "note": "Sent all the info"
      }
    ]
  },
  {
    "id": "enq_23",
    "name": "Natalie Arnold",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "",
    "email": "nataliesarnold@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-15",
        "method": "email",
        "note": "Sent all the info"
      }
    ]
  },
  {
    "id": "enq_24",
    "name": "Holly",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2028",
    "email": "varndellholly@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-18",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_25",
    "name": "Jon Beach",
    "eventType": "Wedding",
    "numbers": "50",
    "datePreference": "2027-07-01 00:00:00",
    "email": "on_beach@icloud.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-21",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_26",
    "name": "Alfie Dale & Marina",
    "eventType": "Wedding",
    "numbers": "100",
    "datePreference": "Poss 26th June 2027",
    "email": "alfiedale1@gmail.com",
    "phone": "07515 888 186",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-28",
        "method": "phone",
        "note": "Spoke on phone have sent all the info."
      }
    ]
  },
  {
    "id": "enq_27",
    "name": "Emily",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "",
    "email": "emilyspice@icloud.com",
    "phone": "",
    "source": "WHITESPACE",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-28",
        "method": "email",
        "note": "Sent all the info"
      }
    ]
  },
  {
    "id": "enq_28",
    "name": "Ellie Martin",
    "eventType": "Wedding",
    "numbers": "?",
    "datePreference": "?",
    "email": "ellieemartinn@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-20",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_29",
    "name": "Stephanie",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "",
    "email": "stephanieltoogood@yahoo.com",
    "phone": "",
    "source": "WHITEPACE",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-06-03",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_31",
    "name": "Vicki Marie",
    "eventType": "Camping",
    "numbers": "",
    "datePreference": "",
    "email": "vickimariecossar@outlook.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": []
  },
  {
    "id": "enq_32",
    "name": "Robyn Mills",
    "eventType": "Camping",
    "numbers": "",
    "datePreference": "",
    "email": "robyn_mills86@hotmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "",
    "viewingTime": "",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2025-11-14",
        "method": "email",
        "note": "Follow up - meant to be booking for the same weekend as Yas and Jack"
      }
    ]
  },
  {
    "id": "enq_36",
    "name": "Michelle",
    "eventType": "Retreat",
    "numbers": "",
    "datePreference": "",
    "email": "michelle@tribestronger.com",
    "phone": "",
    "source": "",
    "firstViewing": "29th May",
    "viewingTime": "14:00:00",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-13",
        "method": "email",
        "note": "Retreat enquiry"
      }
    ]
  },
  {
    "id": "enq_38",
    "name": "Jessie Rosenburt",
    "eventType": "Wedding",
    "numbers": "200",
    "datePreference": "2028-06-01 00:00:00",
    "email": "rosenberg.l.jessie@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "5th June",
    "viewingTime": "10:30 tbc",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "",
        "method": "email",
        "note": "Brough forward the viewing - Jessie said our venue is top of their list!"
      }
    ]
  },
  {
    "id": "enq_40",
    "name": "Jason & Becky",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2027",
    "email": "jasonmcgeorge39@yahoo.com",
    "phone": "",
    "source": "",
    "firstViewing": "Thursday 11th June",
    "viewingTime": "10",
    "viewingForm": "NEED TO SEND",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-21",
        "method": "phone",
        "note": "Spoken to Jason today - sounds really nice.  Re-scheduling due to the work going on in the barn"
      }
    ]
  },
  {
    "id": "enq_41",
    "name": "Emma Poole",
    "eventType": "Wedding duplicate",
    "numbers": "",
    "datePreference": "",
    "email": "emmapoole@hotmail.co.uk",
    "phone": "",
    "source": "",
    "firstViewing": "Thursday 11th June",
    "viewingTime": "11am tbc",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": []
  },
  {
    "id": "enq_42",
    "name": "Kat & Troy",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "",
    "email": "bearbugwedding@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "19th June",
    "viewingTime": "14",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": []
  },
  {
    "id": "enq_43",
    "name": "Gabby",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2027/28",
    "email": "gabriellabiazotti@gmail.com>",
    "phone": "",
    "source": "",
    "firstViewing": "Saturday 27th June",
    "viewingTime": "11.30am",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-04-07",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_46",
    "name": "Tania Stebbing & Bruno Rodrigues",
    "eventType": "Wedding",
    "numbers": "120",
    "datePreference": "31st July - 2nd August",
    "email": "Tania.Stebbing@sweatybetty.com",
    "phone": "",
    "source": "Internet Search",
    "firstViewing": "Saturday 17th may",
    "viewingTime": "11.3",
    "viewingForm": "RECEIVED VIEWING FORM BACK",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "",
        "method": "email",
        "note": "CONTACT IN JAN/FEB 2026"
      },
      {
        "date": "2025-05-25",
        "method": "email",
        "note": "Taniia and partner have decided to hold off booking untl they have moved as they are in the process of hopefully buying a house.  She says the defo want to book Hawthbush for 20"
      },
      {
        "date": "2025-03-27",
        "method": "email",
        "note": "Taniia is keen to book a viewing - she sounds very keen."
      },
      {
        "date": "2025-03-25",
        "method": "email",
        "note": "Have sent all details"
      }
    ]
  },
  {
    "id": "enq_47",
    "name": "Chloe Dawes & Jamie",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2027-07-17 00:00:00",
    "email": "chloe-dawes1@hotmail.co.uk",
    "phone": "",
    "source": "Google search",
    "firstViewing": "Friday 29th August",
    "viewingTime": "tbc",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2025-11-18",
        "method": "email",
        "note": "Have emailed Chloe again today as not heard back from her since confirming the Harley"
      },
      {
        "date": "205-07-22",
        "method": "email",
        "note": "Have confirmed re the Harley.  Waiting to hear if they are coming back for another viewing on 29th August. NEED TO LET CHLOE KNOW ABOUT THE HARLEY DAVIDSON"
      },
      {
        "date": "2025-07-10",
        "method": "email",
        "note": "Sent follow up  Really loely couple - she is an occupational therapist and he is a roofer - they have two small children.  Big family.  They absolutely love the venue - I think they will book.  I have sent a follow up and said we'll confirm the 27 prices."
      },
      {
        "date": "2025-06-20",
        "method": "email",
        "note": "Chloe has now received all the info - they love the Gun Pub and are very excited to have found us close by."
      }
    ]
  },
  {
    "id": "enq_48",
    "name": "Natalie Bryrant & Richard",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "Sept 2026",
    "email": "byrnes_n@yahoo.com",
    "phone": "",
    "source": "",
    "firstViewing": "Saturday 2nd August",
    "viewingTime": "11.3",
    "viewingForm": "RECEIVED VIEWING FORM",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "",
        "method": "email",
        "note": "CONTACT IN JAN/FEB 2026 ABOUT 2027"
      },
      {
        "date": "2025-10-04",
        "method": "email",
        "note": "Richard emailed to say they had decided to put their wedding back to 2027 as they have had an offer accepted on a house."
      },
      {
        "date": "2025-09-25",
        "method": "email",
        "note": "They are v interested in booking the 29th August."
      },
      {
        "date": "2025-08-13",
        "method": "email",
        "note": "Have sent another follow up.  Last weekend in August is the date they'd like - Lovely couple - she's American works as a project manager and he was lovely (wearing a baseball cap - workis in Pharma) They loved the venue.  Have sent follow up."
      },
      {
        "date": "2025-06-16",
        "method": "email",
        "note": "Have emailed Natalie to say I can do 11.30 on August 2nd for a viewing."
      },
      {
        "date": "2025-06-04",
        "method": "email",
        "note": "Sent all the info - they go to the brewery and would like food trucks for their main food."
      }
    ]
  },
  {
    "id": "enq_49",
    "name": "Harriet Francis & James DUPLICATE",
    "eventType": "Wedding",
    "numbers": "120",
    "datePreference": "July or August 2027",
    "email": "harriet.francis94@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "Tuesday 31st March",
    "viewingTime": "10:00:00",
    "viewingForm": "SENT BOOKING FORM",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "",
        "method": "email",
        "note": "Harriet seems keen - has pushed for an earlier viewing - still wants to keep the 26th March booking as well."
      },
      {
        "date": "2027-03-03",
        "method": "email",
        "note": "Have sent all the info"
      }
    ]
  },
  {
    "id": "enq_50",
    "name": "Johnny Healey & Hannah",
    "eventType": "Wedding",
    "numbers": "75",
    "datePreference": "Sept - poss 19/20",
    "email": "healeyjohnny1987@gmail.com",
    "phone": "",
    "source": "",
    "firstViewing": "2026-03-17 00:00:00",
    "viewingTime": "9.30 - virtual tour",
    "viewingForm": "",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-03-24",
        "method": "email",
        "note": "Hannah loved the farm - hopeful she will book.  Came with her mum Kim and little baby girl Romey"
      },
      {
        "date": "2026-03-17",
        "method": "email",
        "note": "They're very int in Fri 19 Sept - in discussions re pricing against another venue."
      },
      {
        "date": "2026-03-05",
        "method": "email",
        "note": "Johnny looking for a venue for this year - have offered 19/20 - arranging a viewing."
      }
    ]
  },
  {
    "id": "enq_51",
    "name": "Rebecca Talbot and Tom Harper (Becky & Tom)",
    "eventType": "",
    "numbers": "",
    "datePreference": "21/22nd August 2027 SEND HOLDING DEPOSIT INVOICE",
    "email": "saltdeanbeach@gmail.com",
    "phone": "",
    "source": "Regulars of the brewery",
    "firstViewing": "Sunday 26th April",
    "viewingTime": "10.30am",
    "viewingForm": "RECIEVED",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-02",
        "method": "email",
        "note": "Sent a follow up as not heard back from them since their viewing."
      },
      {
        "date": "2026-04-26",
        "method": "email",
        "note": "Viewing went well, hopeful they will proceed. Sent follow up email.  Follow up early May if no contact."
      },
      {
        "date": "2026-02-03",
        "method": "email",
        "note": "sent a follow up."
      },
      {
        "date": "2026-01-30",
        "method": "email",
        "note": "They seem keen - have given me three different weekends in August and September."
      },
      {
        "date": "2026-01-27",
        "method": "email",
        "note": "Have sent all the details"
      }
    ]
  },
  {
    "id": "enq_52",
    "name": "Henry & Gemma",
    "eventType": "Wedding",
    "numbers": "",
    "datePreference": "2028",
    "email": "",
    "phone": "",
    "source": "",
    "firstViewing": "Sunday 26th April",
    "viewingTime": "16:00:00",
    "viewingForm": "SENT",
    "outcome": "undecided",
    "didNotBookReason": "",
    "temperature": "cold",
    "contacts": [
      {
        "date": "2026-05-02",
        "method": "email",
        "note": "Sent a follow up."
      },
      {
        "date": "2026-04-27",
        "method": "email",
        "note": "Sent a follow up - nice couple - she's Irish and has quite alot of Irish family that would come over and need accommodation."
      },
      {
        "date": "2026-03-17",
        "method": "email",
        "note": "Have asked if they send me their email address so that I can send the viewing booking form."
      }
    ]
  }
];

const TEMP_CONFIG = {
  cold: { label:"Cold", bg:"#e0f2fe", text:"#075985", border:"#7dd3fc" },
  warm: { label:"Warm", bg:"#fef3c7", text:"#92400e", border:"#fcd34d" },
  hot:  { label:"Hot",  bg:"#fee2e2", text:"#991b1b", border:"#fca5a5" },
};
const OUTCOME_CONFIG = {
  undecided:    { label:"Undecided",    bg:"#f5f9ff", text:"#3d5a7a", border:"#c8d9ef" },
  booked:       { label:"Booked",       bg:"#dcfce7", text:"#166534", border:"#86efac" },
  didnotbook:   { label:"Did Not Book", bg:"#fee2e2", text:"#991b1b", border:"#fca5a5" },
};
const METHOD_CONFIG = {
  email: { label:"Email", icon:"✉" },
  phone: { label:"Phone", icon:"📞" },
  other: { label:"Other", icon:"💬" },
};

function TempBadge({ temp }) {
  const c = TEMP_CONFIG[temp] || TEMP_CONFIG.cold;
  return <span style={{ fontSize:11, fontWeight:700, padding:"2px 9px", borderRadius:10, background:c.bg, color:c.text, border:`1px solid ${c.border}`, whiteSpace:"nowrap" }}>{c.label}</span>;
}
function OutcomeBadge({ outcome }) {
  const c = OUTCOME_CONFIG[outcome] || OUTCOME_CONFIG.undecided;
  return <span style={{ fontSize:11, fontWeight:700, padding:"2px 9px", borderRadius:10, background:c.bg, color:c.text, border:`1px solid ${c.border}`, whiteSpace:"nowrap" }}>{c.label}</span>;
}



// ─── STAFF TIMELINE REPORT ────────────────────────────────────────────────────
const TIMELINE_COLOURS = [
  { bg:"#0f766e", text:"#ffffff" }, // teal
  { bg:"#dc2626", text:"#ffffff" }, // red
  { bg:"#d97706", text:"#ffffff" }, // amber
  { bg:"#2563eb", text:"#ffffff" }, // blue
  { bg:"#7c3aed", text:"#ffffff" }, // purple
  { bg:"#db2777", text:"#ffffff" }, // pink
  { bg:"#16a34a", text:"#ffffff" }, // green
  { bg:"#0284c7", text:"#ffffff" }, // sky
  { bg:"#9333ea", text:"#ffffff" }, // violet
  { bg:"#ea580c", text:"#ffffff" }, // orange
];

function StaffTimelineReport({ bookings, staff }) {
  const [printMode, setPrintMode]     = useState(false);
  const [downloading, setDownloading] = useState(false);
  const timelineRef                   = useRef(null);
  const today = new Date().toISOString().slice(0,10);
  const upcoming = bookings.filter(b => b.date >= today && b.couple && (b.staffShifts && Object.keys(b.staffShifts).length > 0));
  const past     = bookings.filter(b => b.date <  today && b.couple && (b.staffShifts && Object.keys(b.staffShifts).length > 0));

  const [selectedBooking, setSelectedBooking] = useState(upcoming[0]?.id || past[0]?.id || null);

  const allWithShifts = [...upcoming, ...past];
  const booking = allWithShifts.find(b => b.id === selectedBooking);

  if (allWithShifts.length === 0) {
    return (
      <div style={{ textAlign:"center", padding:60, color:T.textLight }}>
        <div style={{ fontSize:32, marginBottom:16 }}>📅</div>
        <div style={{ fontSize:16, marginBottom:8 }}>No shift times recorded yet.</div>
        <div style={{ fontSize:13 }}>Add start and end times in the Staffing section of a booking to see the timeline here.</div>
      </div>
    );
  }

  const renderTimeline = (b) => {
    if (!b) return null;
    const shifts = b.staffShifts || {};
    const entries = Object.entries(shifts).filter(([,sh]) => sh.start && sh.end);
    if (entries.length === 0) return <p style={{ color:T.textLight, fontSize:13 }}>No shift times set for this booking.</p>;

    // Parse time to minutes from midnight
    const toMins = t => { const [h,m] = t.split(":").map(Number); return h*60+m; };

    const allMins = entries.flatMap(([,sh]) => [toMins(sh.start), toMins(sh.end)]);
    const minTime = Math.floor(Math.min(...allMins) / 60) * 60; // round down to hour
    const maxTime = Math.ceil(Math.max(...allMins) / 60) * 60;  // round up to hour
    const totalSpan = maxTime - minTime;

    const hours = [];
    for (let m = minTime; m <= maxTime; m += 60) {
      hours.push(m);
    }

    return (
      <div>
        {/* Hour ruler */}
        <div style={{ display:"flex", marginLeft:160, marginBottom:8 }}>
          {hours.map(m => (
            <div key={m} style={{ flex:1, fontSize:11, color:T.textLight, fontWeight:600, textAlign:"left", borderLeft:`1px solid ${T.border}`, paddingLeft:4 }}>
              {String(Math.floor(m/60)).padStart(2,"0")}:00
            </div>
          ))}
        </div>

        {/* Grid lines + bars */}
        <div style={{ position:"relative" }}>
          {/* Vertical grid lines */}
          <div style={{ position:"absolute", left:160, right:0, top:0, bottom:0, display:"flex", pointerEvents:"none" }}>
            {hours.map(m => (
              <div key={m} style={{ flex:1, borderLeft:`1px solid ${T.border}` }}/>
            ))}
          </div>

          {/* Staff rows */}
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {entries.map(([id, sh], i) => {
              const person = staff.find(s => s.id === id);
              const name = person?.name || id;
              const startM = toMins(sh.start);
              const endM   = toMins(sh.end);
              const leftPct  = ((startM - minTime) / totalSpan) * 100;
              const widthPct = ((endM - startM) / totalSpan) * 100;
              const col = TIMELINE_COLOURS[i % TIMELINE_COLOURS.length];

              // Find this person's role on the booking
              const role = ["setup",...STAFFING_FIELDS].find(f => (b[f]||[]).includes(id));
              const roleLabel = role === "setup" ? "Set-Up" : role ? STAFFING_LABELS[role] : "";

              return (
                <div key={id} style={{ display:"flex", alignItems:"center", height:44 }}>
                  {/* Name label */}
                  <div style={{ width:160, flexShrink:0, paddingRight:12, display:"flex", flexDirection:"column", alignItems:"flex-end" }}>
                    <span style={{ fontSize:13, fontWeight:600, color:T.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:150 }}>{name}</span>
                    {roleLabel && <span style={{ fontSize:10, color:T.textLight, fontWeight:500 }}>{roleLabel}</span>}
                  </div>
                  {/* Bar area */}
                  <div style={{ flex:1, position:"relative", height:36 }}>
                    <div style={{
                      position:"absolute",
                      left:`${leftPct}%`,
                      width:`${Math.max(widthPct, 2)}%`,
                      height:"100%",
                      background:col.bg,
                      borderRadius:8,
                      display:"flex",
                      alignItems:"center",
                      paddingLeft:10,
                      boxShadow:"0 2px 6px rgba(0,0,0,.18)",
                      overflow:"hidden",
                      cursor:"default",
                    }}
                    title={`${name}: ${sh.start}–${sh.end}`}>
                      <span style={{ fontSize:12, fontWeight:700, color:col.text, whiteSpace:"nowrap" }}>
                        {sh.start}–{sh.end}
                        {widthPct > 20 && <span style={{ fontWeight:400, marginLeft:6 }}>{name}</span>}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Now line (if today) */}
        {b.date === today && (() => {
          const now = new Date();
          const nowMins = now.getHours()*60 + now.getMinutes();
          if (nowMins < minTime || nowMins > maxTime) return null;
          const leftPct = ((nowMins - minTime) / totalSpan) * 100;
          return (
            <div style={{ position:"relative", marginLeft:160, marginTop:-((entries.length*50)+8) }}>
              <div style={{ position:"absolute", left:`${leftPct}%`, top:0, bottom:0, width:2, background:T.red, opacity:.7, zIndex:10 }}>
                <div style={{ position:"absolute", top:-4, left:-20, fontSize:10, background:T.red, color:"#fff", borderRadius:3, padding:"1px 5px", whiteSpace:"nowrap" }}>Now</div>
              </div>
            </div>
          );
        })()}
      </div>
    );
  };

  const timelineRows = bookings.filter(b=>b.couple&&b.date).sort((a,b)=>a.date>b.date?1:-1);
  const printText = [
    "Staff Timeline Report",
    "",
    ...timelineRows.map(b => {
      const getNames = (ids) => (ids||[]).map(id=>(staff.find(s=>s.id===id)||{name:id}).name).join(", ") || "—";
      return `${b.date} — ${b.couple}\n  Manager: ${getNames(b.dayManager)} | Bar Sup: ${getNames(b.barSupervisor)}\n  Day Staff: ${getNames(b.dayStaff)} | Bar: ${getNames(b.bar)}`;
    })
  ].join("\n\n");
  if(printMode) return (
    <div>
      <button onClick={()=>setPrintMode(false)} style={{ marginBottom:14, background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>← Back</button>
      <pre style={{ background:"#f8fafd", border:`1px solid ${T.border}`, borderRadius:8, padding:"16px 20px", fontSize:13, fontFamily:"inherit", lineHeight:1.8, whiteSpace:"pre-wrap", color:T.text }}>{printText}</pre>
    </div>
  );
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
        <button onClick={()=>setPrintMode(true)} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>📋 Email-Friendly View</button>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:22, flexWrap:"wrap" }}>
        <h3 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:17 }}>Staff Timeline</h3>
        <select value={selectedBooking||""} onChange={e=>setSelectedBooking(Number(e.target.value)||e.target.value)}
          style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"7px 12px", outline:"none", flex:1, maxWidth:400 }}>
          {upcoming.length > 0 && <optgroup label="Upcoming">
            {upcoming.map(b=><option key={b.id} value={b.id}>{b.date} — {b.couple}</option>)}
          </optgroup>}
          {past.length > 0 && <optgroup label="Past">
            {past.map(b=><option key={b.id} value={b.id}>{b.date} — {b.couple}</option>)}
          </optgroup>}
        </select>
      </div>

      {booking && (() => {
        const handleDownload = async () => {
          setDownloading(true);
          try {
            if (!window.html2canvas) {
              await new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
                s.onload = resolve; s.onerror = reject;
                document.head.appendChild(s);
              });
            }
            const canvas = await window.html2canvas(timelineRef.current, { backgroundColor:"#ffffff", scale:2, useCORS:true });
            const a = document.createElement("a");
            a.href = canvas.toDataURL("image/jpeg", 0.92);
            a.download = `rota-${(booking.couple||"rota").replace(/[^a-z0-9]/gi,"-").toLowerCase()}-${booking.date||"undated"}.jpg`;
            a.click();
          } catch(err) { console.error(err); alert("Download failed — please try again."); }
          finally { setDownloading(false); }
        };
        return (
          <div>
            <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
              <button onClick={handleDownload} disabled={downloading}
                style={{ background:T.green, color:"#fff", border:"none", padding:"8px 18px", borderRadius:6, cursor:downloading?"wait":"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600, opacity:downloading?0.7:1 }}>
                {downloading ? "Preparing…" : "⬇ Download as JPG"}
              </button>
            </div>
            <div ref={timelineRef} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"22px 24px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <div style={{ marginBottom:20, paddingBottom:14, borderBottom:`1px solid ${T.border}`, display:"flex", alignItems:"center", gap:12 }}>
                <div>
                  <div style={{ fontSize:18, fontWeight:700, color:T.midBlue }}>{booking.couple}</div>
                  <div style={{ fontSize:13, color:T.textLight }}>{booking.date ? new Date(booking.date+"T00:00:00").toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"}) : ""}</div>
                </div>
              </div>
              {renderTimeline(booking)}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── VIEWINGS COMPONENTS ──────────────────────────────────────────────────────

const VIEWING_STORAGE_KEY = "hbf_viewings_v1";

function ViewingForm({ viewing, onChange, onSave, onCancel, saveLabel="Add" }) {
  const iStyle = { width:"100%", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 9px", outline:"none", boxSizing:"border-box" };
  return (
    <div style={{ background:T.accentLight, border:`1.5px solid ${T.accentMid}`, borderRadius:8, padding:14 }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
        <div>
          <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:4, fontWeight:600 }}>Date</label>
          <input type="date" value={viewing.date||""} onChange={e=>onChange({...viewing,date:e.target.value})} style={iStyle}/>
        </div>
        <div>
          <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:4, fontWeight:600 }}>Time</label>
          <input type="time" value={viewing.time||""} onChange={e=>onChange({...viewing,time:e.target.value})} style={iStyle}/>
        </div>
      </div>
      <div style={{ marginBottom:10 }}>
        <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:4, fontWeight:600 }}>Notes</label>
        <textarea value={viewing.notes||""} onChange={e=>onChange({...viewing,notes:e.target.value})} rows={2}
          style={{ ...iStyle, resize:"vertical" }} placeholder="Viewing notes…"/>
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={onSave} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"7px 18px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>{saveLabel}</button>
        <button onClick={onCancel} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"7px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:13 }}>Cancel</button>
      </div>
    </div>
  );
}

function ViewingsList({ viewings, onEdit, onDelete }) {
  if (!viewings || viewings.length === 0) return <p style={{ color:T.textLight, fontSize:13, textAlign:"center", padding:"12px 0" }}>No viewings yet.</p>;
  const sorted = [...viewings].sort((a,b)=>a.date>b.date?1:-1);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {sorted.map((v,i)=>(
        <div key={i} style={{ background:T.bgInput, border:`1px solid ${T.border}`, borderRadius:8, padding:"10px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: v.notes ? 6 : 0 }}>
            <span style={{ fontSize:13, fontWeight:700, color:"#6d28d9" }}>📅 {v.date||"No date"}{v.time ? " · "+v.time : ""}</span>
            {onEdit && <button onClick={()=>onEdit(i)} style={{ marginLeft:"auto", background:"#f3e8ff", border:"none", color:"#6d28d9", cursor:"pointer", fontSize:12, fontWeight:600, padding:"2px 10px", borderRadius:4 }}>Edit</button>}
            {onDelete && <button onClick={()=>onDelete(i)} style={{ background:T.redBg, border:"none", color:T.red, cursor:"pointer", fontSize:12, fontWeight:600, padding:"2px 8px", borderRadius:4 }}>✕</button>}
          </div>
          {v.notes && <p style={{ margin:0, fontSize:13, color:T.text, lineHeight:1.5 }}>{v.notes}</p>}
        </div>
      ))}
    </div>
  );
}

// Viewings section inside booking FormView

// ─── FILE ATTACHMENT SECTION ───────────────────────────────────────────────────
const FILE_DOC_TYPES = ["Event Booking Form", "Accommodation Booking Form", "Event Timesheet", "Other"];

const guessDocType = (filename) => {
  const n = (filename||"").toLowerCase();
  if (n.includes("timesheet") || n.includes("time sheet") || n.includes("hours")) return "Event Timesheet";
  if (n.includes("accom") || n.includes("accommodation") || n.includes("hamlet") || n.includes("amly") || n.includes("camping")) return "Accommodation Booking Form";
  if (n.includes("booking") || n.includes("event") || n.includes("wedding") || n.includes("contract") || n.includes("form")) return "Event Booking Form";
  return "Other";
};

function BookingFilesSection({ formData, update, onAutoSave, entityId, entityType="booking" }) {
  const [uploading, setUploading]   = useState(false);
  const [error, setError]           = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [dragOver, setDragOver]     = useState(false);
  const flash = () => { setSavedFlash(true); setTimeout(()=>setSavedFlash(false), 2000); };

  const id    = entityId || formData.id || formData.couple?.replace(/[^a-z0-9]/gi,"_").toLowerCase() || "unknown";
  const files = formData.files || [];

  const isPdf  = (f) => /\.pdf$/i.test(f.name||"") || f.type==="application/pdf";
  const isHeic = (f) => /\.heic$/i.test(f.name||"") || f.type==="image/heic" || f.type==="image/heif";
  const isImage = (f) => {
    if (isHeic(f) || isPdf(f)) return false;
    if (f.type && f.type.startsWith("image/")) return true;
    return /\.(jpe?g|png|gif|webp|svg)$/i.test(f.name || "");
  };

  const [blobUrls, setBlobUrls] = useState({});
  const [pdfUrls,  setPdfUrls]  = useState({});

  useEffect(() => {
    files.filter(f=>isImage(f)).forEach(file => {
      if (blobUrls[file.url]) return;
      fetch(file.url, { headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}` }})
        .then(r=>r.blob()).then(blob=>setBlobUrls(p=>({...p,[file.url]:URL.createObjectURL(blob)})))
        .catch(e=>console.warn("Preview fetch failed:",e));
    });
    return () => { Object.values(blobUrls).forEach(u=>URL.revokeObjectURL(u)); };
  }, [files]);

  useEffect(() => {
    files.filter(f=>isPdf(f)).forEach(file => {
      if (pdfUrls[file.url]) return;
      fetch(file.url, { headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}` }})
        .then(r=>r.blob()).then(blob=>setPdfUrls(p=>({...p,[file.url]:URL.createObjectURL(blob)})))
        .catch(e=>console.warn("PDF fetch failed:",e));
    });
    return () => { Object.values(pdfUrls).forEach(u=>URL.revokeObjectURL(u)); };
  }, [files]);

  const processFiles = async (picked) => {
    if (!picked.length) return;
    setUploading(true); setError(null);
    try {
      const newFiles = [...files];
      for (const file of picked) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
        const path = `${entityType}s/${id}/${Date.now()}_${safeName}`;
        const url  = await sbUploadFile(path, file);
        newFiles.push({ name:file.name, url, path, type:file.type||"", docType:guessDocType(file.name), uploadedAt:new Date().toISOString().slice(0,10) });
      }
      update("files", newFiles);
      if (onAutoSave) { await onAutoSave({...formData, files:newFiles}); flash(); }
    } catch(err) { setError("Upload failed: "+err.message); }
    finally { setUploading(false); }
  };

  const handleUpload    = async (e) => { await processFiles(Array.from(e.target.files)); e.target.value=""; };
  const handleDrop      = async (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); await processFiles(Array.from(e.dataTransfer.files)); };
  const handleDragOver  = (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); };

  const handleDelete = async (idx) => {
    const file = files[idx];
    try { if (file.path) await sbDeleteFile(file.path); } catch(e) { console.warn("Delete failed:",e); }
    const updated = files.filter((_,i)=>i!==idx);
    update("files", updated);
    if (onAutoSave) { await onAutoSave({...formData, files:updated}); flash(); }
  };

  const updateDocType = (idx, docType) => {
    const updated = files.map((f,i)=>i===idx?{...f,docType}:f);
    update("files", updated);
    if (onAutoSave) onAutoSave({...formData, files:updated});
  };

  const DocTypeSelect = ({file, idx}) => (
    <select value={file.docType||"Other"} onChange={e=>updateDocType(idx,e.target.value)} onClick={e=>e.stopPropagation()}
      style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:5, color:T.text, fontFamily:"inherit", fontSize:11, padding:"3px 7px", cursor:"pointer", flexShrink:0 }}>
      {FILE_DOC_TYPES.map(t=><option key={t}>{t}</option>)}
    </select>
  );

  const FooterBar = ({file, idx, tight}) => (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:tight?"8px 14px":"10px 14px", borderTop:`1px solid ${T.border}`, flexWrap:"wrap" }}>
      <span style={{ flex:1, fontSize:13, color:T.text, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", minWidth:0 }}>{file.name}</span>
      <DocTypeSelect file={file} idx={idx}/>
      {file.uploadedAt && <span style={{ fontSize:11, color:T.textLight, whiteSpace:"nowrap" }}>{file.uploadedAt}</span>}
      <a href={file.url} target="_blank" rel="noreferrer" style={{ background:T.midBlueBg, color:T.midBlue, border:`1px solid ${T.border}`, borderRadius:5, padding:"4px 10px", fontSize:12, fontWeight:600, textDecoration:"none", whiteSpace:"nowrap" }}>⬇ Open</a>
      <button onClick={()=>handleDelete(idx)} style={{ background:T.redBg, border:"none", color:T.red, padding:"4px 10px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>✕ Remove</button>
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
        <span style={{ fontSize:13, color:T.textMid }}>
          {files.length} file{files.length!==1?"s":""} attached
          {savedFlash && <span style={{ color:T.green, fontWeight:600, fontSize:11, marginLeft:8 }}>✓ Saved</span>}
        </span>
        <label style={{ background:T.midBlue, color:"#fff", border:"none", padding:"7px 16px", borderRadius:6, cursor:uploading?"wait":"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600, display:"flex", alignItems:"center", gap:6, opacity:uploading?0.7:1 }}>
          {uploading ? "Uploading…" : "⬆ Upload Files"}
          <input type="file" multiple onChange={handleUpload} disabled={uploading} style={{ display:"none" }}/>
        </label>
      </div>

      {error && <div style={{ background:T.redBg, border:`1px solid #fca5a5`, borderRadius:6, padding:"8px 12px", color:T.red, fontSize:13, marginBottom:12 }}>{error}</div>}

      <label onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
        style={{ display:"block", textAlign:"center", padding:files.length===0?"44px 20px":"14px 20px", color:dragOver?T.midBlue:T.textLight, border:`2px dashed ${dragOver?T.midBlue:T.border}`, borderRadius:10, background:dragOver?T.accentLight:"transparent", cursor:"pointer", transition:"all .15s", marginBottom:files.length>0?12:0 }}>
        <div style={{ fontSize:files.length===0?30:16, marginBottom:4 }}>{dragOver?"⬇":"📎"}</div>
        <div style={{ fontSize:13, fontWeight:dragOver?600:400 }}>{dragOver?"Drop to upload":files.length===0?"Drag files here, or click Upload Files above":"Drag more files here to upload"}</div>
        <input type="file" multiple onChange={handleUpload} disabled={uploading} style={{ display:"none" }}/>
      </label>

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {files.map((file, idx) => {
          if (isImage(file)) return (
            <div key={idx} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,.05)" }}>
              {blobUrls[file.url]
                ? <a href={blobUrls[file.url]} target="_blank" rel="noreferrer" style={{ display:"block" }}>
                    <img src={blobUrls[file.url]} alt={file.name} style={{ width:"100%", maxHeight:360, objectFit:"contain", background:"#f8fafd", display:"block", cursor:"pointer" }}/>
                  </a>
                : <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:80, background:"#f8fafd", color:T.textLight, fontSize:12, gap:8 }}><span>⟳</span> Loading preview…</div>
              }
              <FooterBar file={file} idx={idx} tight/>
            </div>
          );
          if (isPdf(file)) return (
            <div key={idx} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,.05)" }}>
              {pdfUrls[file.url]
                ? <iframe src={pdfUrls[file.url]} title={file.name} style={{ width:"100%", height:500, border:"none", background:"#f8fafd", display:"block" }}/>
                : <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:80, background:"#f8fafd", color:T.textLight, fontSize:12, gap:8 }}><span>⟳</span> Loading PDF…</div>
              }
              <FooterBar file={file} idx={idx} tight/>
            </div>
          );
          if (isHeic(file)) return (
            <div key={idx} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,.05)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"16px", background:"#fffbeb", borderBottom:`1px solid #fde68a` }}>
                <span style={{ fontSize:24 }}>📷</span>
                <div>
                  <div style={{ fontSize:13, fontWeight:600, color:"#92400e" }}>HEIC preview not supported in browsers</div>
                  <div style={{ fontSize:12, color:"#a16207", marginTop:2 }}>Use the Open button to download and view in Photos or another app</div>
                </div>
              </div>
              <FooterBar file={file} idx={idx}/>
            </div>
          );
          return (
            <div key={idx} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,.05)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px" }}>
                <div style={{ fontSize:26, flexShrink:0 }}>{/\.(doc|docx)$/i.test(file.name)?"📝":/\.(xls|xlsx)$/i.test(file.name)?"📊":"📎"}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{file.name}</div>
                  {file.uploadedAt && <div style={{ fontSize:11, color:T.textLight, marginTop:2 }}>Uploaded {file.uploadedAt}</div>}
                </div>
                <DocTypeSelect file={file} idx={idx}/>
                <a href={file.url} target="_blank" rel="noreferrer" style={{ background:T.midBlueBg, color:T.midBlue, border:`1px solid ${T.border}`, borderRadius:5, padding:"6px 12px", fontSize:12, fontWeight:600, textDecoration:"none", whiteSpace:"nowrap", flexShrink:0 }}>⬇ Open</a>
                <button onClick={()=>handleDelete(idx)} style={{ background:T.redBg, border:"none", color:T.red, padding:"6px 12px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600, flexShrink:0 }}>✕ Remove</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function BookingViewingsSection({ formData, update, onAutoSave }) {
  const [adding, setAdding] = useState(false);
  const [editIdx, setEditIdx] = useState(null);
  const [newV, setNewV] = useState({ date: new Date().toISOString().slice(0,10), time:"", notes:"" });
  const [editV, setEditV] = useState(null);

  const viewings = formData.viewings || [];

  const [savedFlash, setSavedFlash] = useState(false);
  const flash = () => { setSavedFlash(true); setTimeout(()=>setSavedFlash(false), 2000); };

  const addViewing = async () => {
    if (!newV.date) return;
    const updated = [...viewings, { ...newV }];
    update("viewings", updated);
    setNewV({ date: new Date().toISOString().slice(0,10), time:"", notes:"" });
    setAdding(false);
    if (onAutoSave) { await onAutoSave({ ...formData, viewings: updated }); flash(); }
  };

  const startEdit = (i) => {
    const sorted = [...viewings].sort((a,b)=>a.date>b.date?1:-1);
    const actual = viewings.indexOf(sorted[i]);
    setEditIdx(actual); setEditV({ ...sorted[i] });
  };

  const saveEdit = async () => {
    const updated = viewings.map((v,i)=>i===editIdx?editV:v);
    update("viewings", updated);
    setEditIdx(null); setEditV(null);
    if (onAutoSave) { await onAutoSave({ ...formData, viewings: updated }); flash(); }
  };

  const deleteViewing = async (i) => {
    const sorted = [...viewings].sort((a,b)=>a.date>b.date?1:-1);
    const actual = viewings.indexOf(sorted[i]);
    const updated = viewings.filter((_,ii)=>ii!==actual);
    update("viewings", updated);
    if (onAutoSave) { await onAutoSave({ ...formData, viewings: updated }); flash(); }
  };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
        <span style={{ fontSize:13, color:T.textMid }}>{viewings.length} viewing{viewings.length!==1?"s":""} recorded {savedFlash && <span style={{ color:T.green, fontWeight:600, fontSize:11 }}>✓ Saved</span>}</span>
        {!adding && <button onClick={()=>setAdding(true)} style={{ background:"#f3e8ff", border:"none", color:"#6d28d9", padding:"5px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>+ Add Viewing</button>}
      </div>
      {adding && <div style={{ marginBottom:12 }}><ViewingForm viewing={newV} onChange={setNewV} onSave={addViewing} onCancel={()=>setAdding(false)}/></div>}
      {editIdx !== null && editV && <div style={{ marginBottom:12 }}><ViewingForm viewing={editV} onChange={setEditV} onSave={saveEdit} onCancel={()=>{setEditIdx(null);setEditV(null);}} saveLabel="Save"/></div>}
      <ViewingsList viewings={[...viewings].sort((a,b)=>a.date>b.date?1:-1)} onEdit={editIdx===null ? startEdit : null} onDelete={editIdx===null ? deleteViewing : null}/>
    </div>
  );
}

// Viewings section inside EnquiryDetail
function EnquiryViewingsSection({ form, setForm, setDirty, onSave }) {
  const [adding, setAdding] = useState(false);
  const [editIdx, setEditIdx] = useState(null);
  const [newV, setNewV] = useState({ date: new Date().toISOString().slice(0,10), time:"", notes:"" });
  const [editV, setEditV] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const viewings = form.viewings || [];

  const persist = async (updatedForm) => {
    await onSave(updatedForm);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  };

  const addViewing = async () => {
    if (!newV.date) return;
    const updated = { ...form, viewings:[...(form.viewings||[]), {...newV}] };
    setForm(updated); setDirty(false);
    setNewV({ date: new Date().toISOString().slice(0,10), time:"", notes:"" }); setAdding(false);
    await persist(updated);
  };

  const startEdit = (i) => {
    const sorted = [...viewings].sort((a,b)=>a.date>b.date?1:-1);
    const actual = viewings.indexOf(sorted[i]);
    setEditIdx(actual); setEditV({...sorted[i]});
  };

  const saveEdit = async () => {
    const updated = { ...form, viewings:(form.viewings||[]).map((v,i)=>i===editIdx?editV:v) };
    setForm(updated); setDirty(false);
    setEditIdx(null); setEditV(null);
    await persist(updated);
  };

  const deleteViewing = async (i) => {
    const sorted = [...viewings].sort((a,b)=>a.date>b.date?1:-1);
    const actual = viewings.indexOf(sorted[i]);
    const updated = { ...form, viewings:(form.viewings||[]).filter((_,ii)=>ii!==actual) };
    setForm(updated); setDirty(false);
    await persist(updated);
  };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:`1px solid ${T.border}`, paddingBottom:10, marginBottom:14 }}>
        <h3 style={{ margin:0, color:"#6d28d9", fontWeight:700, fontSize:15 }}>Viewings <span style={{ fontSize:12, color:T.textLight, fontWeight:400 }}>({viewings.length})</span></h3>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {savedFlash && <span style={{ fontSize:11, color:T.green, fontWeight:600 }}>✓ Saved to cloud</span>}
          {!adding && editIdx===null && <button onClick={()=>setAdding(true)} style={{ background:"#f3e8ff", border:"none", color:"#6d28d9", padding:"5px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>+ Add Viewing</button>}
        </div>
      </div>
      {adding && <div style={{ marginBottom:12 }}><ViewingForm viewing={newV} onChange={setNewV} onSave={addViewing} onCancel={()=>setAdding(false)}/></div>}
      {editIdx !== null && editV && <div style={{ marginBottom:12 }}><ViewingForm viewing={editV} onChange={setEditV} onSave={saveEdit} onCancel={()=>{setEditIdx(null);setEditV(null);}} saveLabel="Save"/></div>}
      <ViewingsList viewings={[...viewings].sort((a,b)=>a.date>b.date?1:-1)} onEdit={editIdx===null?startEdit:null} onDelete={editIdx===null?deleteViewing:null}/>
    </div>
  );
}

// ─── VIEWINGS TAB VIEW ────────────────────────────────────────────────────────
function ViewingsView({ bookings, setView, onEditBooking, onSelectEnquiry }) {
  const [enquiries, setEnquiries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("upcoming"); // upcoming | all | past

  useEffect(()=>{
    (async()=>{
      try { const r = await sbGet(ENQUIRIES_STORAGE); setEnquiries(r||[]); } catch { setEnquiries([]); }
      setLoaded(true);
    })();
  },[]);

  const today = new Date().toISOString().slice(0,10);

  // Gather all viewings from both bookings and enquiries
  const allViewings = [];
  bookings.forEach(b=>{
    (b.viewings||[]).forEach(v=>{
      allViewings.push({ ...v, sourceType:"booking", sourceName:b.couple||"Unnamed Booking", sourceId:b.id, sourcePhone:b.phone||b.email||"" });
    });
  });
  enquiries.forEach(e=>{
    (e.viewings||[]).forEach(v=>{
      allViewings.push({ ...v, sourceType:"enquiry", sourceName:e.name||"Unnamed Enquiry", sourceId:e.id, sourcePhone:e.phone||e.email||"" });
    });
  });

  const sorted = [...allViewings].sort((a,b)=>a.date>b.date?1:-1);
  const filtered = sorted.filter(v=>{
    if (filter==="upcoming") return v.date >= today;
    if (filter==="past")     return v.date < today;
    return true;
  });

  if (!loaded) return <div style={{ padding:40, color:T.textLight }}>Loading viewings…</div>;

  return (
    <div style={{ paddingTop:28 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
        <h2 style={{ margin:0, color:"#6d28d9", fontWeight:700, fontSize:22 }}>Viewings</h2>
        <span style={{ fontSize:13, color:T.textLight }}>{filtered.length} viewing{filtered.length!==1?"s":""}</span>
      </div>

      <div style={{ display:"flex", gap:6, marginBottom:20 }}>
        {[["upcoming","Upcoming"],["all","All"],["past","Past"]].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)} style={{ background:filter===v?"#6d28d9":"#fff", color:filter===v?"#fff":T.textMid, border:`1.5px solid ${filter===v?"#6d28d9":T.border}`, padding:"6px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:filter===v?700:400 }}>{l}</button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign:"center", padding:60, color:T.textLight, fontSize:15 }}>No {filter==="all"?"":""+filter+" "}viewings found.</div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {filtered.map((v,i)=>(
          <div key={i} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"14px 18px", boxShadow:"0 2px 8px rgba(37,99,235,.06)", display:"flex", alignItems:"flex-start", gap:16 }}>
            <div style={{ flexShrink:0, background:"#f3e8ff", border:"1px solid #c4b5fd", borderRadius:8, padding:"10px 14px", textAlign:"center", minWidth:60 }}>
              <div style={{ fontSize:18, fontWeight:700, color:"#6d28d9", lineHeight:1 }}>{v.date ? new Date(v.date+"T00:00:00").getDate() : "—"}</div>
              <div style={{ fontSize:10, color:"#7c3aed", fontWeight:600, marginTop:2 }}>{v.date ? new Date(v.date+"T00:00:00").toLocaleDateString("en-GB",{month:"short"}) : ""}</div>
              <div style={{ fontSize:10, color:"#7c3aed" }}>{v.date ? new Date(v.date+"T00:00:00").getFullYear() : ""}</div>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6, flexWrap:"wrap" }}>
                {v.time && <span style={{ fontSize:13, fontWeight:600, color:T.text }}>🕐 {v.time}</span>}
                <span style={{ fontSize:11, padding:"2px 8px", borderRadius:10, background:v.sourceType==="booking"?T.greenBg:"#f3e8ff", color:v.sourceType==="booking"?T.green:"#6d28d9", border:`1px solid ${v.sourceType==="booking"?"#86efac":"#c4b5fd"}`, fontWeight:600 }}>
                  {v.sourceType==="booking" ? "Booking" : "Enquiry"}
                </span>
                {v.date < today && <span style={{ fontSize:11, padding:"2px 8px", borderRadius:10, background:"#e5e7eb", color:"#6b7280", border:"1px solid #d1d5db", fontWeight:600 }}>Past</span>}
              </div>
              <div
                onClick={()=>{ if(v.sourceType==="booking"&&onEditBooking){ onEditBooking(v.sourceId); setView("form"); } else if(v.sourceType==="enquiry"&&onSelectEnquiry){ onSelectEnquiry(v.sourceId); setView("enquiries"); } }}
                style={{ fontWeight:700, color:T.accent, fontSize:15, marginBottom:4, cursor:"pointer", textDecoration:"underline", textDecorationColor:"transparent", transition:"text-decoration-color .15s" }}
                onMouseEnter={e=>e.currentTarget.style.textDecorationColor=T.accent}
                onMouseLeave={e=>e.currentTarget.style.textDecorationColor="transparent"}
              >{v.sourceName}</div>
              {v.sourcePhone && <div style={{ fontSize:12, color:T.textMid, marginBottom:v.notes?4:0 }}>📞 {v.sourcePhone}</div>}
              {v.notes && <p style={{ margin:0, fontSize:13, color:T.textMid, lineHeight:1.5 }}>{v.notes}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── EnquiriesView (top-level) ────────────────────────────────────────────────
function EnquiriesView() {
  const [enquiries, setEnquiries] = useState([]);
  const [loaded, setLoaded]       = useState(false);
  const [selected, setSelected]   = useState(null); // id of open enquiry
  const [adding, setAdding]       = useState(false);
  const [filter, setFilter]       = useState("undecided"); // undecided | all | booked | didnotbook
  const [tempFilter, setTempFilter] = useState("all");
  const [search, setSearch]       = useState("");
  const [confirmDlg, setConfirmDlg] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await sbGet(ENQUIRIES_STORAGE);
        setEnquiries(r || INITIAL_ENQUIRIES);
      } catch { setEnquiries(INITIAL_ENQUIRIES); }
      setLoaded(true);
    })();
  }, []);

  const save = async data => {
    setEnquiries(data);
    try { await sbSet(ENQUIRIES_STORAGE, data); } catch(e) { console.error(e); }
  };

  const updateEnquiry = async updated => {
    await save(enquiries.map(e => e.id === updated.id ? updated : e));
  };

  const deleteEnquiry = id => {
    const e = enquiries.find(x=>x.id===id);
    setConfirmDlg({
      message: "Delete this enquiry?",
      subMessage: `"${e?.name}" will be permanently removed.`,
      onConfirm: async () => { setConfirmDlg(null); setSelected(null); await save(enquiries.filter(x=>x.id!==id)); }
    });
  };

  const addNew = () => {
    const id = `enq_${Date.now()}`;
    const blank = { id, name:"", eventType:"Wedding", numbers:"", datePreference:"", email:"", phone:"", source:"", firstViewing:"", viewingTime:"", viewingForm:"", outcome:"undecided", didNotBookReason:"", temperature:"cold", contacts:[] };
    save([...enquiries, blank]);
    setSelected(id);
    setAdding(true);
  };

  if (!loaded) return <div style={{ padding:40, color:T.textLight }}>Loading enquiries…</div>;

  // If an enquiry is selected, show detail view
  if (selected) {
    const enq = enquiries.find(e=>e.id===selected);
    if (!enq) { setSelected(null); return null; }
    return (
      <EnquiryDetail
        enq={enq}
        onUpdate={updateEnquiry}
        onDelete={()=>deleteEnquiry(enq.id)}
        onBack={()=>{ setSelected(null); setAdding(false); }}
        isNew={adding}
        confirmDlg={confirmDlg}
        setConfirmDlg={setConfirmDlg}
      />
    );
  }

  const TEMP_ORDER = { hot:0, warm:1, cold:2 };
  const filtered = enquiries.filter(e => {
    if (filter !== "all" && e.outcome !== filter) return false;
    if (tempFilter !== "all" && e.temperature !== tempFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (e.name||"").toLowerCase().includes(q) || (e.email||"").toLowerCase().includes(q) || (e.datePreference||"").toLowerCase().includes(q);
    }
    return true;
  }).sort((a,b) => (TEMP_ORDER[a.temperature]??2) - (TEMP_ORDER[b.temperature]??2));

  return (
    <div style={{ paddingTop:28 }}>
      {confirmDlg && <ConfirmDialog message={confirmDlg.message} subMessage={confirmDlg.subMessage} onConfirm={confirmDlg.onConfirm} onCancel={()=>setConfirmDlg(null)}/>}

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
        <h2 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:22 }}>Enquiries</h2>
        <button onClick={addNew} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"9px 22px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600 }}>+ New Enquiry</button>
      </div>

      {/* Filters */}
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
        {/* Outcome filter */}
        <div style={{ display:"flex", gap:4 }}>
          {[["undecided","Undecided"],["booked","Booked"],["didnotbook","Did Not Book"],["all","All"]].map(([v,l])=>(
            <button key={v} onClick={()=>setFilter(v)} style={{ background:filter===v?T.midBlue:"#fff", color:filter===v?"#fff":T.textMid, border:`1.5px solid ${filter===v?T.midBlue:T.border}`, padding:"6px 14px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:filter===v?700:400 }}>{l}</button>
          ))}
        </div>
        <div style={{ width:1, height:24, background:T.border }}/>
        {/* Temperature filter */}
        {[["all","All"],["cold","Cold"],["warm","Warm"],["hot","Hot"]].map(([v,l])=>(
          <button key={v} onClick={()=>setTempFilter(v)} style={{ background:tempFilter===v?(TEMP_CONFIG[v]?.bg||T.midBlue):"#fff", color:tempFilter===v?(TEMP_CONFIG[v]?.text||"#fff"):T.textMid, border:`1.5px solid ${tempFilter===v?(TEMP_CONFIG[v]?.border||T.midBlue):T.border}`, padding:"6px 14px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:tempFilter===v?700:400 }}>{l}</button>
        ))}
        <div style={{ flex:1 }}/>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name or email…"
          style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 12px", outline:"none", width:220 }}/>
        <span style={{ fontSize:12, color:T.textLight }}>{filtered.length} of {enquiries.length}</span>
      </div>

      {/* List */}
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr style={{ background:"#eef4fd" }}>
              {["Name","Event","Date Preference","First Viewing","Contacts","Temp","Outcome",""].map(h=>(
                <th key={h} style={{ padding:"10px 14px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.2, textTransform:"uppercase", fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length===0 && (
              <tr><td colSpan={8} style={{ padding:40, textAlign:"center", color:T.textLight }}>No enquiries match this filter.</td></tr>
            )}
            {filtered.map((e,i)=>{
              const lastContact = [...(e.contacts||[])].filter(c=>c.date).sort((a,b)=>b.date>a.date?1:-1)[0];
              const tc = TEMP_CONFIG[e.temperature];
              const rowBg = tc ? tc.bg : "transparent";
              const rowHover = tc ? tc.bg : "#f0f6ff";
              return (
                <tr key={e.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none", cursor:"pointer", transition:"background .12s", background:rowBg }}
                  onClick={()=>{ setSelected(e.id); setAdding(false); }}
                  onMouseEnter={ev=>ev.currentTarget.style.background=rowHover}
                  onMouseLeave={ev=>ev.currentTarget.style.background=rowBg}>
                  <td style={{ padding:"11px 14px" }}>
                    <div style={{ fontWeight:700, color:T.text, fontSize:14 }}>{e.name||"—"}</div>
                  </td>
                  <td style={{ padding:"11px 14px", fontSize:13, color:T.textMid }}>{e.eventType||"—"}</td>
                  <td style={{ padding:"11px 14px", fontSize:13, color:T.textMid }}>{e.datePreference||"—"}</td>
                  <td style={{ padding:"11px 14px", fontSize:13, color:T.accent, fontWeight:500 }}>{e.firstViewing||"—"}</td>
                  <td style={{ padding:"11px 14px", fontSize:13 }}>
                    <span style={{ color:(e.contacts||[]).length>0?T.midBlue:T.textLight, fontWeight:600 }}>{(e.contacts||[]).length}</span>
                    {lastContact && <div style={{ fontSize:10, color:T.textLight }}>{lastContact.date}</div>}
                  </td>
                  <td style={{ padding:"11px 14px" }}><TempBadge temp={e.temperature}/></td>
                  <td style={{ padding:"11px 14px" }}><OutcomeBadge outcome={e.outcome}/></td>
                  <td style={{ padding:"11px 14px", whiteSpace:"nowrap" }} onClick={ev=>ev.stopPropagation()}>
                    <button onClick={()=>deleteEnquiry(e.id)} style={{ background:T.redBg, border:"none", color:T.red, padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:12 }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Enquiry Detail ────────────────────────────────────────────────────────────
function FRow({ label, children }) {
  return (
    <div>
      <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:5, fontWeight:600 }}>{label}</label>
      {children}
    </div>
  );
}

function EnquiryDetail({ enq, onUpdate, onDelete, onBack, isNew, confirmDlg, setConfirmDlg }) {
  const [form, setForm]         = useState({...enq});
  const [newContact, setNewContact] = useState({ date: new Date().toISOString().slice(0,10), method:"email", note:"" });
  const [addingContact, setAddingContact] = useState(false);
  const [editingContactIdx, setEditingContactIdx] = useState(null);
  const [editContactForm, setEditContactForm] = useState(null);
  const [dirty, setDirty]       = useState(isNew);

  const update = (k,v) => { setForm(f=>({...f,[k]:v})); setDirty(true); };

  const save = async () => { await onUpdate(form); setDirty(false); };

  const addContact = () => {
    if (!newContact.note.trim()) return;
    const c = [...(form.contacts||[]), { ...newContact }];
    setForm(f=>({...f, contacts:c})); setDirty(true);
    setNewContact({ date: new Date().toISOString().slice(0,10), method:"email", note:"" });
    setAddingContact(false);
  };

  const deleteContact = idx => {
    const c = (form.contacts||[]).filter((_,i)=>i!==idx);
    setForm(f=>({...f, contacts:c})); setDirty(true);
  };

  const startEditContact = (idx) => {
    const real = form.contacts.findIndex((_,i) => {
      const sorted = [...(form.contacts||[])].sort((a,b)=>{ if(!a.date)return 1;if(!b.date)return -1;return b.date>a.date?1:-1; });
      return form.contacts.indexOf(sorted[idx]) === i;
    });
    // find the actual index in the unsorted array by matching the sorted item
    const sorted = [...(form.contacts||[])].sort((a,b)=>{ if(!a.date)return 1;if(!b.date)return -1;return b.date>a.date?1:-1; });
    const actualIdx = (form.contacts||[]).indexOf(sorted[idx]);
    setEditingContactIdx(actualIdx);
    setEditContactForm({ ...sorted[idx] });
  };

  const saveEditContact = () => {
    const updated = (form.contacts||[]).map((c,i) => i===editingContactIdx ? editContactForm : c);
    setForm(f=>({...f, contacts:updated})); setDirty(true);
    setEditingContactIdx(null); setEditContactForm(null);
  };

  const sortedContacts = [...(form.contacts||[])].sort((a,b)=>{
    if (!a.date) return 1; if (!b.date) return -1;
    return b.date > a.date ? 1 : -1;
  });



  return (
    <div style={{ paddingTop:28 }}>
      {confirmDlg && <ConfirmDialog message={confirmDlg.message} subMessage={confirmDlg.subMessage} onConfirm={confirmDlg.onConfirm} onCancel={()=>setConfirmDlg(null)}/>}

      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:22 }}>
        <button onClick={onBack} style={{ background:"#fff", border:`1px solid ${T.border}`, color:T.textMid, cursor:"pointer", fontSize:13, padding:"6px 14px", borderRadius:6, fontFamily:"inherit" }}>← Back</button>
        <h2 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:20, flex:1 }}>{form.name||"New Enquiry"}</h2>
        <TempBadge temp={form.temperature}/>
        <OutcomeBadge outcome={form.outcome}/>
        {dirty && <button onClick={save} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"9px 22px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700 }}>Save Changes</button>}
        <button onClick={onDelete} style={{ background:T.redBg, border:"none", color:T.red, padding:"9px 14px", borderRadius:6, cursor:"pointer", fontSize:13 }}>Delete</button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
        {/* Left column: core info */}
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Core details */}
          <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:15, borderBottom:`1px solid ${T.border}`, paddingBottom:10 }}>Enquiry Details</h3>
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <FRow label="Name"><input value={form.name||""} onChange={e=>update("name",e.target.value)} placeholder="Full name" style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <FRow label="Event Type"><input type="text" value={form.eventType||""} onChange={e=>update("eventType",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
                <FRow label="Numbers"><input type="text" value={form.numbers||""} onChange={e=>update("numbers",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
                <FRow label="Date Preference"><input type="text" value={form.datePreference||""} onChange={e=>update("datePreference",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
                <FRow label="Source"><input type="text" value={form.source||""} onChange={e=>update("source",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
                <FRow label="Email">
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <input type="email" value={form.email||""} onChange={e=>update("email",e.target.value)} style={{ flex:1, background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/>
                    <GmailLink email={form.email}/>
                  </div>
                </FRow>
                <FRow label="Phone"><input type="tel" value={form.phone||""} onChange={e=>update("phone",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
              </div>
            </div>
          </div>

          {/* Viewing */}
          <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:15, borderBottom:`1px solid ${T.border}`, paddingBottom:10 }}>First Viewing</h3>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              <FRow label="Date / Description"><input type="text" value={form.firstViewing||""} onChange={e=>update("firstViewing",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
              <FRow label="Time"><input type="text" value={form.viewingTime||""} onChange={e=>update("viewingTime",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow>
              <div style={{ gridColumn:"1/-1" }}><FRow label="Viewing Form"><input type="text" value={form.viewingForm||""} onChange={e=>update("viewingForm",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", boxSizing:"border-box" }}/></FRow></div>
            </div>
          </div>

          {/* Outcome */}
          <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:15, borderBottom:`1px solid ${T.border}`, paddingBottom:10 }}>Status</h3>

            {/* Temperature - radio buttons */}
            <div style={{ marginBottom:16 }}>
              <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:8, fontWeight:600 }}>Temperature</label>
              <div style={{ display:"flex", gap:8 }}>
                {Object.entries(TEMP_CONFIG).map(([v,c])=>(
                  <label key={v} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", padding:"8px 14px", borderRadius:8, background:form.temperature===v?c.bg:"#fff", border:`1.5px solid ${form.temperature===v?c.border:T.border}`, transition:"all .15s" }}>
                    <input type="radio" name="temp" value={v} checked={form.temperature===v} onChange={()=>update("temperature",v)} style={{ accentColor:c.text }}/>
                    <span style={{ fontSize:13, fontWeight:700, color:form.temperature===v?c.text:T.textMid }}>{c.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Outcome dropdown */}
            <FRow label="Outcome">
              <select value={form.outcome||""} onChange={e=>update("outcome",e.target.value)} style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none" }}>{Object.entries(OUTCOME_CONFIG).map(([v,c])=><option key={v} value={v}>{c.label}</option>)}</select>
            </FRow>

            {/* Did not book reason */}
            {form.outcome==="didnotbook" && (
              <div style={{ marginTop:12 }}>
                <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:5, fontWeight:600 }}>Reason Did Not Book</label>
                <textarea value={form.didNotBookReason||""} onChange={e=>update("didNotBookReason",e.target.value)} rows={3}
                  style={{ width:"100%", background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"8px 11px", outline:"none", resize:"vertical", boxSizing:"border-box" }}/>
              </div>
            )}
          </div>
        </div>

        {/* Right column: contact history */}
        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)", display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:`1px solid ${T.border}`, paddingBottom:10, marginBottom:4 }}>
            <h3 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:15 }}>Contact History <span style={{ fontSize:12, color:T.textLight, fontWeight:400 }}>({(form.contacts||[]).length})</span></h3>
            <button onClick={()=>setAddingContact(true)} style={{ background:T.accentLight, border:"none", color:T.accent, padding:"5px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>+ Add Contact</button>
          </div>

          {/* New contact form */}
          {addingContact && (
            <div style={{ background:T.accentLight, border:`1.5px solid ${T.accentMid}`, borderRadius:8, padding:14 }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                <div>
                  <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:4, fontWeight:600 }}>Date</label>
                  <input type="date" value={newContact.date} onChange={e=>setNewContact(n=>({...n,date:e.target.value}))}
                    style={{ width:"100%", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"6px 9px", outline:"none", boxSizing:"border-box" }}/>
                </div>
                <div>
                  <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:4, fontWeight:600 }}>Method</label>
                  <select value={newContact.method} onChange={e=>setNewContact(n=>({...n,method:e.target.value}))}
                    style={{ width:"100%", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"6px 9px", outline:"none" }}>
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              <textarea value={newContact.note} onChange={e=>setNewContact(n=>({...n,note:e.target.value}))} placeholder="Contact note…" rows={3}
                style={{ width:"100%", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 9px", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10 }}/>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={addContact} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"7px 18px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>Add</button>
                <button onClick={()=>setAddingContact(false)} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"7px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:13 }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Contact list */}
          <div style={{ overflowY:"auto", maxHeight:520, display:"flex", flexDirection:"column", gap:10 }}>
            {sortedContacts.length===0 && !addingContact && (
              <p style={{ color:T.textLight, fontSize:13, textAlign:"center", padding:20 }}>No contacts yet.</p>
            )}
            {sortedContacts.map((c,i)=>{
              const mc = METHOD_CONFIG[c.method]||METHOD_CONFIG.email;
              const isEditing = editingContactIdx !== null && (form.contacts||[]).indexOf(c) === editingContactIdx;
              if (isEditing && editContactForm) {
                return (
                  <div key={i} style={{ background:T.accentLight, border:`1.5px solid ${T.accentMid}`, borderRadius:8, padding:14 }}>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
                      <div>
                        <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:4, fontWeight:600 }}>Date</label>
                        <input type="date" value={editContactForm.date||""} onChange={e=>setEditContactForm(f=>({...f,date:e.target.value}))}
                          style={{ width:"100%", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"6px 9px", outline:"none", boxSizing:"border-box" }}/>
                      </div>
                      <div>
                        <label style={{ display:"block", fontSize:11, letterSpacing:1, textTransform:"uppercase", color:T.textMid, marginBottom:4, fontWeight:600 }}>Method</label>
                        <select value={editContactForm.method||"email"} onChange={e=>setEditContactForm(f=>({...f,method:e.target.value}))}
                          style={{ width:"100%", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"6px 9px", outline:"none" }}>
                          <option value="email">Email</option>
                          <option value="phone">Phone</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>
                    <textarea value={editContactForm.note||""} onChange={e=>setEditContactForm(f=>({...f,note:e.target.value}))} rows={3}
                      style={{ width:"100%", background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 9px", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10 }}/>
                    <div style={{ display:"flex", gap:8 }}>
                      <button onClick={saveEditContact} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"7px 18px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>Save</button>
                      <button onClick={()=>{ setEditingContactIdx(null); setEditContactForm(null); }} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"7px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:13 }}>Cancel</button>
                      <button onClick={()=>{ const actualIdx=(form.contacts||[]).indexOf(c); const updated=(form.contacts||[]).filter((_,ii)=>ii!==actualIdx); setForm(f=>({...f,contacts:updated})); setDirty(true); setEditingContactIdx(null); setEditContactForm(null); }} style={{ marginLeft:"auto", background:T.redBg, border:"none", color:T.red, padding:"7px 12px", borderRadius:5, cursor:"pointer", fontSize:12, fontWeight:600 }}>Delete</button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} style={{ background:T.bgInput, border:`1px solid ${T.border}`, borderRadius:8, padding:"10px 14px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
                    <span style={{ fontSize:13, fontWeight:700, color:T.accent }}>{c.date||"No date"}</span>
                    <span style={{ fontSize:11, background:T.accentLight, color:T.accent, border:`1px solid ${T.border}`, borderRadius:4, padding:"1px 7px", fontWeight:600 }}>{mc.icon} {mc.label}</span>
                    <button onClick={()=>startEditContact(i)} style={{ marginLeft:"auto", background:T.midBlueBg, border:"none", color:T.midBlue, cursor:"pointer", fontSize:12, fontWeight:600, padding:"2px 10px", borderRadius:4 }}>Edit</button>
                  </div>
                  <p style={{ margin:0, fontSize:13, color:T.text, lineHeight:1.5 }}>{c.note}</p>
                </div>
              );
            })}
          </div>

          {dirty && (
            <button onClick={save} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"11px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700, marginTop:"auto" }}>Save Changes</button>
          )}
        </div>

        {/* Viewings card */}
        <div style={{ gridColumn:"1/-1", background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:13, letterSpacing:1.1, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:14 }}>Viewings</div>
          <EnquiryViewingsSection form={form} setForm={setForm} setDirty={setDirty} onSave={onUpdate}/>
        </div>
        {/* Files card */}
        <div style={{ gridColumn:"1/-1", background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <div style={{ fontSize:13, letterSpacing:1.1, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:14 }}>Files</div>
          <BookingFilesSection
            formData={form}
            update={(k,v)=>{ setForm(f=>({...f,[k]:v})); setDirty(true); }}
            onAutoSave={onUpdate}
            entityId={form.id || form.name?.replace(/[^a-z0-9]/gi,"_").toLowerCase()}
            entityType="enquiry"
          />
        </div>
      </div>
    </div>
  );
}
