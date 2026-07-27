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


// Print styles injected into document head
if (typeof document !== "undefined" && !document.getElementById("hbf-print-styles")) {
  const style = document.createElement("style");
  style.id = "hbf-print-styles";
  style.textContent = `
    @media print {
      body > * { display: none !important; }
      #hbf-print-root { display: block !important; }
      #hbf-print-root > * { display: block !important; }
      button { display: none !important; }
      input[type=date] { display: none !important; }
    }
  `;
  document.head.appendChild(style);
}

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
function ConfirmDialog({ message, subMessage, confirmLabel="Delete", cancelLabel="Cancel", onConfirm, onCancel, icon="🗑", iconBg, confirmColor }) {
  var iBg = iconBg || T.redBg;
  var cColor = confirmColor || T.red;
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,30,60,.45)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={onCancel}>
      <div style={{ background:"#fff", borderRadius:12, padding:"28px 32px", maxWidth:400, width:"90%", boxShadow:"0 16px 48px rgba(0,0,0,.18)", border:`1px solid ${T.border}` }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ width:44, height:44, borderRadius:"50%", background:iBg, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:16 }}>
          <span style={{ fontSize:22 }}>{icon}</span>
        </div>
        <div style={{ fontSize:16, fontWeight:700, color:T.text, marginBottom:8 }}>{message}</div>
        {subMessage && <div style={{ fontSize:13, color:T.textMid, marginBottom:20, lineHeight:1.5 }}>{subMessage}</div>}
        <div style={{ display:"flex", gap:10, marginTop:20 }}>
          <button onClick={onConfirm} style={{ flex:1, background:cColor, color:"#fff", border:"none", padding:"11px", borderRadius:7, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700 }}>{confirmLabel}</button>
          <button onClick={onCancel}  style={{ flex:1, background:"#fff", color:T.textMid, border:`1.5px solid ${T.border}`, padding:"11px", borderRadius:7, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600 }}>{cancelLabel}</button>
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

// Standard display format across the app: "25 Aug 26" (DD MMM YY)
function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(String(dateStr).slice(0,10) + "T00:00:00");
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"2-digit" });
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
  { id:1,  status:"Confirmed", couple:"Alice Smith Birthday party Barn",         date:"2025-01-24", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"100", mealChildren:"", mealBabies:"", eveGuests:"", phone:"44 7557 598 231", email:"alicelouise90@hotmail.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"yes", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"", hamletBooked:"yes", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroContactId:"", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
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
  { id:201, status:"Holding",   couple:"Jason McGeorge & Becky",   date:"2027-07-05", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"Becky 07796 138545", email:"jasonmcgeorge45@gmail.com", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"no", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroContactId:"", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
  { id:202, status:"Confirmed", couple:"Imogen Parr & Jack",       date:"2027-06-12", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"07766998811", email:"jackmeach@hotmail.com", email2:"imogenfjparr@gmail.com", ceremony:"13:00", guestArrivalTime:"", caterers:"Circa", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"yes", amlyFee:"", hamletBooked:"no", hamletFee:"", campingBooked:"no", campingFee:"", nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroContactId:"", payment2:"", finalPayment:"", extras:"", corkage:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} },
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

// ─── GMAIL OAUTH2 ────────────────────────────────────────────────────────────
const GMAIL_CLIENT_ID   = "631658172216-bh6vocim7t41lf8nhr21bdpb2ss2n1mm.apps.googleusercontent.com";
// Uses whatever domain the app is served from, so changing the Netlify subdomain
// won't break OAuth — you only need to add the new URL in the Google/Xero portals.
const APP_ORIGIN        = (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin : "https://hawthbushfarm.netlify.app";
const GMAIL_REDIRECT    = APP_ORIGIN + "/";
const GMAIL_SCOPE       = "https://www.googleapis.com/auth/gmail.readonly";

const gmailGetToken  = () => { try { return JSON.parse(sessionStorage.getItem("gmail_token")||"null"); } catch { return null; } };
const gmailSetToken  = (t) => sessionStorage.setItem("gmail_token", JSON.stringify(t));
const gmailClearToken = () => sessionStorage.removeItem("gmail_token");

const gmailGetValidToken = () => {
  const t = gmailGetToken();
  if (!t) return null;
  // Token expired?
  if (Date.now() > t.expires_at - 60000) { gmailClearToken(); return null; }
  return t;
};

// ─── XERO OAUTH2 PKCE ────────────────────────────────────────────────────────
const XERO_CLIENT_ID    = "13532E98AD5A449A86B5B6607F547531";
const XERO_SCOPES       = "openid profile email accounting.contacts.read accounting.invoices.read offline_access";
const XERO_REDIRECT_URI = APP_ORIGIN + "/";

const xeroGenerateCodeVerifier = () => {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
};

const xeroGenerateCodeChallenge = async (verifier) => {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
};

const xeroGetToken = () => {
  try { return JSON.parse(sessionStorage.getItem("xero_token") || "null"); } catch { return null; }
};
const xeroSetToken = (t) => sessionStorage.setItem("xero_token", JSON.stringify(t));
const xeroClearToken = () => sessionStorage.removeItem("xero_token");

const xeroRefreshToken = async (refreshToken) => {
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: XERO_CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed");
  const data = await res.json();
  const token = { ...data, expires_at: Date.now() + data.expires_in * 1000 };
  xeroSetToken(token);
  return token;
};

const xeroGetValidToken = async () => {
  let token = xeroGetToken();
  if (!token) return null;
  if (Date.now() > token.expires_at - 60000) {
    try { token = await xeroRefreshToken(token.refresh_token); } catch { xeroClearToken(); return null; }
  }
  return token;
};

const xeroFetch = async (path) => {
  const token = await xeroGetValidToken();
  if (!token) throw new Error("Not connected to Xero");

  // Get tenant ID via Netlify proxy if we don't have it yet
  if (!token.tenant_id) {
    const tenantsRes = await fetch("/api/xero-connections", {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
    });
    if (!tenantsRes.ok) {
      const txt = await tenantsRes.text();
      throw new Error(`Could not fetch Xero organisations (${tenantsRes.status}): ${txt.slice(0,100)}`);
    }
    const tenants = await tenantsRes.json();
    if (!tenants.length) throw new Error("No Xero organisations found");
    token.tenant_id = tenants[0].tenantId;
    xeroSetToken(token);
  }

  // Call Accounting API via Netlify proxy
  const res = await fetch(`/api/xero-api/${path}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Xero-tenant-id": token.tenant_id,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Xero API error (${res.status}): ${txt.slice(0,100)}`);
  }
  return res.json();
};
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
// Static input style used in settings/editor components (no focus state needed)
const inpStyle = { background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 10px", outline:"none", boxSizing:"border-box" };
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

// Find lettings bookings whose check-in falls within windowDays of an event date
function findLinkedAccom(eventDate, accomBookings, windowDays, eventEndDate) {
  if (!eventDate || !accomBookings) return [];
  var eStart = new Date(eventDate+"T00:00:00");
  var eEnd = (eventEndDate && eventEndDate > eventDate) ? new Date(eventEndDate+"T00:00:00") : eStart;
  var win = windowDays || 7;
  return accomBookings.filter(function(b) {
    if (b.status === "cancelled") return false;
    if (b.bookingType === "Blocked") return false; // not-available blocks aren't guest bookings
    var stays = (b.stays&&b.stays.length) ? b.stays : [b];
    return stays.some(function(s) {
      if (!s.checkIn) return false;
      var ci = new Date(s.checkIn+"T00:00:00");
      var co = s.checkOut ? new Date(s.checkOut+"T00:00:00") : ci;
      // Match if stay overlaps the event window
      return ci <= new Date(eEnd.getTime() + win*86400000) && co >= new Date(eStart.getTime() - win*86400000);
    });
  });
}

// Attribute a booking's flat schedule[] (Deposit/Balance entries) to the individual
// stays (properties) they belong to, so multi-property bookings can show each
// stay's Dep/Bal badges on that stay's own row instead of a separate combined row.
// Prefers an explicit sc.propertyId tag; falls back to splitting the schedule
// into equal-sized ordered chunks (one per stay) for older untagged data; if
// neither is possible, everything is returned as "leftover" so nothing is lost.
function attributeScheduleToStays(schedule, stays) {
  var sched = schedule || [];
  if (!stays || stays.length <= 1) return { byStay: [sched], leftover: [] };
  var hasTags = sched.some(function(sc) { return sc.propertyId; });
  if (hasTags) {
    var byStay = stays.map(function(s) {
      return sched.filter(function(sc) { return sc.propertyId === s.propertyId; });
    });
    var leftover = sched.filter(function(sc) { return !sc.propertyId; });
    return { byStay: byStay, leftover: leftover };
  }
  if (sched.length > 0 && sched.length % stays.length === 0) {
    var chunkSize = sched.length / stays.length;
    var byStayChunks = stays.map(function(s, i) { return sched.slice(i * chunkSize, (i + 1) * chunkSize); });
    return { byStay: byStayChunks, leftover: [] };
  }
  return { byStay: stays.map(function() { return []; }), leftover: sched };
}

// Read-only panel: shows lettings bookings linked to a wedding event by date proximity
function LinkedAccomPanel({ eventDate, eventEndDate, eventId, accomBookings, accomProperties, onSaveAccomBooking, onOpenAccomBooking }) {
  var [hideUnlinked, setHideUnlinked] = useState(true); // default: show linked only
  var nearby = findLinkedAccom(eventDate, accomBookings, 7, eventEndDate);
  var explicitlyLinked = (accomBookings||[]).filter(function(b) {
    return b.linkedEventId && String(b.linkedEventId) === String(eventId) && !nearby.find(function(n){ return n.id===b.id; });
  });
  var allBookings = nearby.concat(explicitlyLinked);
  var hasAnyLinked = allBookings.some(function(b){ return String(b.linkedEventId) === String(eventId); });
  // Only hide when there are linked entries — if nothing linked yet, show all so user can tick one
  var visibleBookings = (hideUnlinked && hasAnyLinked)
    ? allBookings.filter(function(b){ return String(b.linkedEventId) === String(eventId); })
    : allBookings;

  if (!allBookings.length) return (
    <div style={{ fontSize:12, color:T.textLight, background:T.bgInput, borderRadius:8, padding:"12px 14px", lineHeight:1.6 }}>
      No lettings bookings found within 7 days of this event.
      To link one, go to Lettings, add or edit a booking, and set its check-in near this event date.
    </div>
  );

  var canLink = !!(eventId && onSaveAccomBooking);

  // Abbreviate common schedule labels
  function shortLabel(lbl) {
    var l = (lbl||"").toLowerCase();
    if (l.indexOf("deposit") !== -1 || l.indexOf("dep") === 0) return "Dep";
    if (l.indexOf("balance") !== -1 || l.indexOf("bal") === 0) return "Bal";
    return lbl;
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        {canLink && !hasAnyLinked && (
          <div style={{ fontSize:11, color:T.textMid, background:T.bgInput, borderRadius:7, padding:"7px 12px" }}>
            Tick a booking to confirm it is attached to this event.
          </div>
        )}
        {canLink && (
          <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", fontSize:12, color:T.text, fontWeight:600, padding:"6px 12px", background: hideUnlinked ? T.accentLight : T.bgInput, borderRadius:7, border:`1.5px solid ${hideUnlinked ? T.accent : T.border}`, marginLeft:"auto" }}>
            <input type="checkbox" checked={hideUnlinked} onChange={function(e){ setHideUnlinked(e.target.checked); }} style={{ width:14, height:14, accentColor:T.accent, cursor:"pointer" }} />
            Linked only
          </label>
        )}
      </div>
      {visibleBookings.map(function(b) {
        var stays = (b.stays&&b.stays.length) ? b.stays : [b];
        var paidAmt = (b.schedule||[]).filter(function(s){ return s.paid; }).reduce(function(sum,s){ return sum+(Number(s.amount)||0); }, 0);
        var outstanding = (Number(b.value)||0) - paidAmt;
        var isLinked = canLink && String(b.linkedEventId) === String(eventId);
        var canOpen = !!onOpenAccomBooking;
        return (
          <div key={b.id}
            onClick={canOpen ? function(){ onOpenAccomBooking(b.id); } : undefined}
            title={canOpen ? "Open this lettings booking" : undefined}
            style={{ border:`1.5px solid ${isLinked ? T.accent : T.border}`, borderRadius:9, padding:"12px 14px", background: isLinked ? T.accentLight : "#fff", cursor: canOpen ? "pointer" : "default" }}>
            {/* Header: checkbox + name + value */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                {canLink && (
                  <input type="checkbox" checked={isLinked}
                    onClick={function(e){ e.stopPropagation(); }}
                    onChange={function(e) {
                    var patch = { linkedEventId: e.target.checked ? eventId : null };
                    if (e.target.checked) patch.bookingType = "Wedding";
                    onSaveAccomBooking(b.id, patch);
                  }} style={{ width:16, height:16, accentColor:T.accent, cursor:"pointer", flexShrink:0 }} />
                )}
                <span style={{ fontWeight:700, color:T.text, fontSize:13, textDecoration: canOpen ? "underline" : "none", textDecorationStyle:"dotted", textDecorationColor:T.textLight }}>
                  {b.guestName || "(no name)"}
                  {b.bookingType && <span style={{ marginLeft:8, fontSize:11, fontWeight:600, color:T.accent, background:"#e0e7ff", padding:"1px 6px", borderRadius:6 }}>{b.bookingType}</span>}
                  {isLinked && <span style={{ marginLeft:8, fontSize:11, fontWeight:700, color:T.accent }}>Linked</span>}
                </span>
              </div>
              <span style={{ fontWeight:700, color:T.text, fontSize:13 }}>{fmtMoney(Number(b.value)||0)}</span>
            </div>
            {/* Stay rows — each with its own Dep/Bal badges inline */}
            {(function() {
              var attributed = attributeScheduleToStays(b.schedule, stays);
              return stays.map(function(s, i) {
                var prop = (accomProperties||[]).find(function(p){ return p.id===s.propertyId; });
                var staySchedule = stays.length === 1 ? (b.schedule||[]) : attributed.byStay[i];
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, flexWrap:"wrap" }}>
                    {prop && <span style={{ width:8, height:8, borderRadius:"50%", background:prop.colour, display:"inline-block", flexShrink:0 }}/>}
                    <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>{s.propertyName || s.propertyId}</span>
                    <span style={{ fontSize:12, color:T.textMid }}>{fmtDate(s.checkIn)} – {fmtDate(s.checkOut)}</span>
                    {s.nights ? <span style={{ fontSize:11, color:T.textLight }}>({s.nights}n)</span> : null}
                    {staySchedule.map(function(sc, si) {
                      return (
                        <span key={si} style={{ fontSize:11, padding:"1px 7px", borderRadius:5, fontWeight:600,
                          background: sc.paid ? T.greenBg : T.amberBg,
                          color:      sc.paid ? T.green   : T.amber }}>
                          {shortLabel(sc.label)}: {fmtMoney(Number(sc.amount)||0)}{sc.paid ? " paid" : sc.dueDate ? " due "+fmtDate(sc.dueDate) : ""}
                        </span>
                      );
                    })}
                  </div>
                );
              });
            })()}
            {/* Any schedule entries that couldn't be attributed to a specific stay */}
            {stays.length > 1 && attributeScheduleToStays(b.schedule, stays).leftover.length > 0 && (
              <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginTop:4 }}>
                {attributeScheduleToStays(b.schedule, stays).leftover.map(function(sc, si) {
                  return (
                    <span key={si} style={{ fontSize:11, padding:"1px 7px", borderRadius:5, fontWeight:600,
                      background: sc.paid ? T.greenBg : T.amberBg,
                      color:      sc.paid ? T.green   : T.amber }}>
                      {shortLabel(sc.label)}: {fmtMoney(Number(sc.amount)||0)}{sc.paid ? " paid" : sc.dueDate ? " due "+fmtDate(sc.dueDate) : ""}
                    </span>
                  );
                })}
              </div>
            )}
            {(Number(b.value)||0) > 0 && (
              <div style={{ marginTop:5, fontSize:12 }}>
                {outstanding <= 0
                  ? <span style={{ color:T.green, fontWeight:600 }}>Fully paid</span>
                  : paidAmt > 0
                    ? <span style={{ color:T.amber, fontWeight:600 }}>Outstanding: {fmtMoney(outstanding)}</span>
                    : <span style={{ color:T.red, fontWeight:600 }}>Not yet paid</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── LETTINGS (HOLIDAY LETS / ACCOMMODATION) ─────────────────────────────────
const PROPERTIES_STORAGE     = "hbf_properties_v1";
const ACCOM_STORAGE          = "hbf_accom_v1";
const ACCOM_GUESTS_STORAGE   = "hbf_accom_guests_v1";
const EMAIL_LOG_STORAGE      = "hbf_email_log_v1";
const DISCOUNT_CODES_STORAGE  = "hbf_discount_codes_v1";
const EMAIL_TEMPLATES_STORAGE = "hbf_email_templates_v1";
const SITE_URL = "https://hawthbushfarm.netlify.app";

const INITIAL_PROPERTIES = [{"id":"hamlet","name":"The Hamlet","bookaletName":"The Hamlet","sleeps":14,"depositPct":50,"balanceWeeks":4,"breakageDefault":0,"checkInFrom":"16:00","checkOutBy":"10:00","checkInFromWedding":"14:00","checkOutByWedding":"11:00","colour":"#2563eb","colourBg":"#dbeafe","blockedByFarmEvents":false,"minNights":2,"maxNights":28,"seasons":[],"baseRate":0,"longStayThreshold":0,"longStayDiscount":0},{"id":"amly","name":"Amly Barn","bookaletName":"Amly Barn","sleeps":6,"depositPct":50,"balanceWeeks":6,"breakageDefault":0,"checkInFrom":"16:00","checkOutBy":"10:00","checkInFromWedding":"14:00","checkOutByWedding":"11:00","colour":"#16a34a","colourBg":"#dcfce7","blockedByFarmEvents":true,"minNights":2,"maxNights":28,"seasons":[],"baseRate":0,"longStayThreshold":0,"longStayDiscount":0},{"id":"glamping","name":"Glamping","bookaletName":"Glamping","sleeps":20,"depositPct":20,"balanceWeeks":6,"breakageDefault":125,"checkInFrom":"16:00","checkOutBy":"10:00","checkInFromWedding":"14:00","checkOutByWedding":"11:00","colour":"#9333ea","colourBg":"#f3e8ff","blockedByFarmEvents":false,"minNights":2,"maxNights":28,"seasons":[],"baseRate":0,"longStayThreshold":0,"longStayDiscount":0}];

const ACCOM_STATUS_META = {
  confirmed: { label:"Confirmed", bg:T.greenBg,  text:T.green },
  pending:   { label:"Pending",   bg:T.amberBg,  text:T.amber },
  completed: { label:"Completed", bg:T.midBlueBg, text:T.midBlue },
  cancelled: { label:"Cancelled", bg:T.redBg,    text:T.red },
};

function fmtMoney(n) {
  const v = Number(n) || 0;
  return "£" + v.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

function isoAddWeeks(iso, weeks) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - weeks * 7);
  return d.toISOString().slice(0, 10);
}

function nightsBetween(ci, co) {
  if (!ci || !co) return null;
  const a = new Date(ci + "T00:00:00"), b = new Date(co + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

// Wrap a legacy flat accom booking into the multi-stay model. No-op if stays[] already present.
function normalizeAccom(b) {
  if (b.stays && b.stays.length) return b;
  const stay = {
    propertyId:   b.propertyId   || "",
    propertyName: b.propertyName || "",
    checkIn:      b.checkIn      || "",
    checkOut:     b.checkOut     || "",
    nights:       b.nights       || null,
    value:        Number(b.value) || 0,
  };
  return Object.assign({}, b, { stays: [stay] });
}

// Compute Airbnb estimated value using the property's long-stay rules (×0.9 for Airbnb cut).
// Returns null when baseRate not yet configured.
function calcAirbnbEstimate(b, prop) {
  if (!prop || !prop.baseRate || prop.baseRate <= 0) return null;
  const ci = (b.stays && b.stays[0] && b.stays[0].checkIn) || b.checkIn;
  const co = (b.stays && b.stays[0] && b.stays[0].checkOut) || b.checkOut;
  const nights = nightsBetween(ci, co);
  if (!nights || nights <= 0) return null;
  let rate = prop.baseRate;
  if (prop.longStayThreshold > 0 && nights >= prop.longStayThreshold && prop.longStayDiscount > 0) {
    rate = Math.max(0, rate - prop.longStayDiscount);
  }
  return Math.round(rate * nights * 0.9 * 100) / 100;
}

// Return nightly rate for a property on a given ISO date, checking seasons first.
function getPriceForNight(prop, dateStr) {
  if (!prop) return 0;
  if (prop.seasons && prop.seasons.length) {
    for (let i = 0; i < prop.seasons.length; i++) {
      const s = prop.seasons[i];
      if (s.startDate && s.endDate && dateStr >= s.startDate && dateStr < s.endDate) {
        return Number(s.ratePerNight) || 0;
      }
    }
  }
  return Number(prop.baseRate) || 0;
}

// Quote a stay: walk each night, sum rates, apply long-stay discount.
// Returns { nights, subtotal, discount, total } or null if invalid.
function quoteStay(prop, checkIn, checkOut) {
  if (!prop || !checkIn || !checkOut) return null;
  const ci = new Date(checkIn+"T00:00:00");
  const co = new Date(checkOut+"T00:00:00");
  const nights = Math.round((co - ci) / 86400000);
  if (nights <= 0) return null;
  let subtotal = 0;
  const d = new Date(ci);
  while (d < co) {
    subtotal += getPriceForNight(prop, d.toISOString().slice(0,10));
    d.setDate(d.getDate() + 1);
  }
  let discount = 0;
  if (prop.longStayThreshold > 0 && nights >= prop.longStayThreshold && prop.longStayDiscount > 0) {
    discount = prop.longStayDiscount * nights;
  }
  const total = Math.max(0, subtotal - discount);
  return { nights, subtotal, discount, total };
}

// Return true if propertyId is free for [checkIn, checkOut), optionally ignoring excludeId.
function checkAvailability(bookings, propertyId, checkIn, checkOut, excludeId) {
  if (!checkIn || !checkOut || !propertyId) return true;
  const ci = new Date(checkIn+"T00:00:00");
  const co = new Date(checkOut+"T00:00:00");
  return !bookings.some(function(b) {
    if (b.id === excludeId || b.status === "cancelled") return false;
    const stays = (b.stays && b.stays.length) ? b.stays : [b];
    return stays.some(function(s) {
      if (s.propertyId !== propertyId) return false;
      if (!s.checkIn || !s.checkOut) return false;
      const sCI = new Date(s.checkIn+"T00:00:00");
      const sCO = new Date(s.checkOut+"T00:00:00");
      return ci < sCO && co > sCI;
    });
  });
}

// Log an automated email to Supabase. Called from send handlers (phase 2).
async function logEmail(entry) {
  try {
    const existing = await sbGet(EMAIL_LOG_STORAGE) || [];
    const rec = Object.assign({ id:"el"+Date.now(), sentAt:new Date().toISOString() }, entry);
    await sbSet(EMAIL_LOG_STORAGE, existing.concat([rec]).slice(-500));
  } catch(e) { console.error("Email log:", e); }
}

// Auto-build a deposit + balance schedule for a manual booking. Zero value -> no schedule.
function buildAccomSchedule(value, prop, checkIn) {
  const total = Number(value) || 0;
  if (total <= 0) return [];
  const pct = prop ? prop.depositPct : 50;
  const bweeks = prop ? prop.balanceWeeks : 4;
  const dep = Math.round(total * pct) / 100;
  const bal = Math.round((total - dep) * 100) / 100;
  return [
    { label:"Deposit", amount:dep, dueDate:null, requested:false, requestedDate:null, paid:false, paidDate:null, stripeId:"" },
    { label:"Balance", amount:bal, dueDate: isoAddWeeks(checkIn, bweeks), requested:false, requestedDate:null, paid:false, paidDate:null, stripeId:"" },
  ];
}

function blankAccom(propId) {
  var pid = propId || "hamlet";
  return {
    id: "a" + Date.now(),
    propertyId: pid, propertyName: "",
    propertyIds: [pid],
    guestName:"", email:"", phone:"",
    checkIn:"", checkOut:"", nights:null, guestCount:"",
    source:"manual", status:"confirmed", bookingType:"", linkedEventId:null,
    value:0, estimated:false,
    extras:[], breakage:0, breakageStripeId:"",
    discountCode:"", discountAmount:0,
    schedule:[], notes:"", createdAt: new Date().toISOString().slice(0,10),
    stays:[{ propertyId:pid, propertyName:"", checkIn:"", checkOut:"", nights:null, guestCount:"", value:0 }],
  };
}

// Small styled input used across the form
function LInput({ label, value, onChange, type="text", placeholder="", width, mono }) {
  const [f, setF] = useState(false);
  return (
    <label style={{ display:"flex", flexDirection:"column", gap:5, width: width || "auto" }}>
      {label && <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>{label}</span>}
      <input type={type} value={value} placeholder={placeholder}
        onChange={e=>onChange(e.target.value)} onFocus={()=>setF(true)} onBlur={()=>setF(false)}
        style={{ background:"#fff", border:`1.5px solid ${f?T.borderFocus:T.border}`, borderRadius:7, color:T.text,
          fontFamily: mono ? "ui-monospace,monospace" : "inherit", fontSize:14, padding:"9px 11px", outline:"none",
          boxShadow: f ? "0 0 0 3px #dbeafe" : "none" }} />
    </label>
  );
}

// Darken a hex colour by subtracting `amount` from each RGB channel (0-255 clamp)
function darkenHex(hex, amount) {
  var h = (hex || "#000000").replace("#", "");
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  var r = Math.max(0, parseInt(h.slice(0,2), 16) - amount);
  var g = Math.max(0, parseInt(h.slice(2,4), 16) - amount);
  var b = Math.max(0, parseInt(h.slice(4,6), 16) - amount);
  return "#" + [r,g,b].map(function(x){ return x.toString(16).padStart(2,"0"); }).join("");
}

const DEFAULT_EMAIL_TEMPLATES = [
  {
    id: "booking_confirmed",
    name: "Booking Confirmed",
    triggerLabel: "Send on booking creation",
    triggerDays: null,
    subject: "Booking Confirmed – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you for booking with Hawthbush Farm! Your reservation is confirmed.\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nDuration: {{nights}} nights\nTotal: £{{totalAmount}}\n\nA deposit of £{{depositAmount}} is due by {{depositDueDate}}.\n\nIf you have any questions, please don't hesitate to get in touch.\n\nWarm regards,\nHawthbush Farm",
    attachments: []
  },
  {
    id: "deposit_request",
    name: "Deposit Request",
    triggerLabel: "Days before deposit due date",
    triggerDays: 3,
    subject: "Deposit Due – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThis is a reminder that your deposit is due for your upcoming stay at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nDeposit due: £{{depositAmount}}\nDue date: {{depositDueDate}}\n\nYou can pay securely here: {{paymentLink}}\n\nWarm regards,\nHawthbush Farm",
    attachments: []
  },
  {
    id: "balance_request",
    name: "Balance Request",
    triggerLabel: "Days before balance due date",
    triggerDays: 28,
    subject: "Balance Due – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nYour balance is now due ahead of your stay at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nBalance due: £{{balanceAmount}}\nDue date: {{balanceDueDate}}\n\nYou can pay securely here: {{paymentLink}}\n\nWe look forward to welcoming you!\n\nWarm regards,\nHawthbush Farm",
    attachments: []
  },
  {
    id: "payment_confirmation",
    name: "Payment Confirmation",
    triggerLabel: "Send on payment receipt",
    triggerDays: null,
    subject: "Payment Received – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you – we have received your payment of £{{amountPaid}} for your booking at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAmount received: £{{amountPaid}}\n\nWarm regards,\nHawthbush Farm",
    attachments: []
  },
  {
    id: "arrival_general",
    name: "Arrival Info (General)",
    triggerLabel: "Days before check-in (1st reminder)",
    triggerDays: 28,
    triggerLabel2: "Days before check-in (2nd reminder)",
    triggerDays2: 3,
    subject: "Your Arrival at Hawthbush Farm – {{checkIn}}",
    body: "Dear {{guestName}},\n\nWe're looking forward to welcoming you to {{propertyName}}!\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}} from {{checkInTime}}\nCheck-out: {{checkOut}} by {{checkOutTime}}\nDuration: {{nights}} nights\n\nDirections and access information are attached. Please don't hesitate to contact us if you have any questions before your arrival.\n\nWarm regards,\nHawthbush Farm",
    attachments: []
  },
  {
    id: "arrival_event",
    name: "Arrival Info (Wedding/Event)",
    triggerLabel: "Days before check-in (1st reminder)",
    triggerDays: 28,
    triggerLabel2: "Days before check-in (2nd reminder)",
    triggerDays2: 3,
    subject: "Your Wedding Weekend at Hawthbush Farm – {{checkIn}}",
    body: "Dear {{guestName}},\n\nWe are so excited to be part of your special day at Hawthbush Farm!\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}} from {{checkInTime}}\nCheck-out: {{checkOut}} by {{checkOutTime}}\n\nYour event information pack and site map are attached. Please do reach out if there is anything you need ahead of your celebration.\n\nWith warmest wishes,\nHawthbush Farm",
    attachments: []
  }
];

const EMAIL_TOKENS = [
  "{{guestName}}", "{{guestEmail}}", "{{guestPhone}}",
  "{{bookingRef}}", "{{propertyName}}",
  "{{checkIn}}", "{{checkOut}}", "{{nights}}",
  "{{checkInTime}}", "{{checkOutTime}}",
  "{{totalAmount}}", "{{depositAmount}}", "{{balanceAmount}}",
  "{{depositDueDate}}", "{{balanceDueDate}}", "{{amountPaid}}", "{{paymentLink}}"
];

// ── Month timeline: one lane per property ────────────────────────────────────
function AccomCalendar({ properties, bookings, events, cursor, setCursor, onOpen, onViewEventsCalendar }) {
  const [mode, setMode] = useState("year");
  const [tooltip, setTooltip] = useState(null);

  const year  = cursor.getFullYear();
  const month = cursor.getMonth();

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DOW    = ["M","T","W","T","F","S","S"];
  const todayD = new Date();
  const today  = todayD.getFullYear() + "-" + String(todayD.getMonth()+1).padStart(2,"0") + "-" + String(todayD.getDate()).padStart(2,"0");

  // Helper: local-time ISO date string from a Date object (avoids UTC-shift bug)
  function localDs(d) {
    return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
  }

  // Occupancy map: dateStr -> [property, ...]
  // Booking map:   dateStr -> [{booking, stay, prop}]  (for hover tooltip)
  // Blocked set:   "dateStr:propId" -> true, for manually blocked "not available" ranges
  const occMap = {}, bookingMap = {}, blockedSet = new Set();
  bookings.forEach(b => {
    if (b.status === "cancelled") return;
    const isBlocked = b.bookingType === "Blocked";
    const stays = (b.stays && b.stays.length) ? b.stays : [b];
    stays.forEach(s => {
      if (!s.checkIn || !s.checkOut || !s.propertyId) return;
      const prop = properties.find(p => p.id === s.propertyId);
      if (!prop) return;
      const ci  = new Date(s.checkIn+"T00:00:00");
      const co  = new Date(s.checkOut+"T00:00:00");
      const st  = new Date(Math.max(ci.getTime(), new Date(year,0,1).getTime()));
      const en  = new Date(Math.min(co.getTime(), new Date(year+1,0,1).getTime()));
      let d = new Date(st);
      while (d < en) {
        const ds = localDs(d);
        if (!occMap[ds]) occMap[ds] = [];
        if (!occMap[ds].find(x=>x.id===prop.id)) occMap[ds].push(prop);
        if (!bookingMap[ds]) bookingMap[ds] = [];
        if (!bookingMap[ds].find(e=>e.booking.id===b.id&&e.prop.id===prop.id)) bookingMap[ds].push({ booking:b, stay:s, prop:prop });
        if (isBlocked) blockedSet.add(ds + ":" + prop.id);
        d.setDate(d.getDate()+1);
      }
    });
  });

  // Event dates set + map: any wedding/event that falls in the year
  const eventDates = new Set();
  const eventByDate = {};
  (events || []).forEach(function(e) {
    if (!e.date) return;
    var start = e.date;
    var end = (e.endDate && e.endDate > start) ? e.endDate : start;
    var cur = new Date(start + "T00:00:00");
    var endD = new Date(end + "T00:00:00");
    while (cur <= endD) {
      var ds = cur.getFullYear() + "-" + String(cur.getMonth()+1).padStart(2,"0") + "-" + String(cur.getDate()).padStart(2,"0");
      if (ds.startsWith(String(year))) {
        eventDates.add(ds);
        if (!eventByDate[ds]) eventByDate[ds] = [];
        if (!eventByDate[ds].find(function(x){ return x.id===e.id; })) eventByDate[ds].push(e);
      }
      cur.setDate(cur.getDate() + 1);
    }
  });

  // Changeover set: "dateStr:propId" for days where same property has both a checkOut AND checkIn
  const coByProp = {}, ciByProp = {};
  bookings.forEach(function(b) {
    if (b.status === "cancelled") return;
    var bstays = (b.stays && b.stays.length) ? b.stays : [b];
    bstays.forEach(function(s) {
      if (!s.checkIn || !s.checkOut || !s.propertyId) return;
      if (!coByProp[s.propertyId]) coByProp[s.propertyId] = new Set();
      if (!ciByProp[s.propertyId]) ciByProp[s.propertyId] = new Set();
      coByProp[s.propertyId].add(s.checkOut);
      ciByProp[s.propertyId].add(s.checkIn);
    });
  });
  const changeoverSet = new Set();
  properties.forEach(function(p) {
    var coSet = coByProp[p.id] || new Set();
    var ciSet = ciByProp[p.id] || new Set();
    coSet.forEach(function(d) { if (ciSet.has(d)) changeoverSet.add(d + ":" + p.id); });
  });

  // ── YEAR VIEW ──────────────────────────────────────────────────────────────
  if (mode === "year") {
    return (
      <div>
        <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:18 }}>
          <button onClick={()=>setCursor(new Date(year-1,0,1))} style={navBtn}>&#8249;</button>
          <div style={{ fontSize:20, fontWeight:800, color:T.text, minWidth:70, textAlign:"center" }}>{year}</div>
          <button onClick={()=>setCursor(new Date(year+1,0,1))} style={navBtn}>&#8250;</button>
          <button onClick={()=>{ setCursor(new Date()); setMode("month"); }} style={{ ...navBtn, width:"auto", padding:"0 14px", fontSize:13, fontWeight:600 }}>This month</button>
          {onViewEventsCalendar && (
            <button onClick={onViewEventsCalendar} style={{ ...navBtn, width:"auto", padding:"0 14px", fontSize:13, fontWeight:600, marginLeft:"auto", background:T.accentLight, color:T.accent, border:`1.5px solid ${T.accent}` }}>Events calendar</button>
          )}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:16 }}>
          {MONTHS.map((mName, mIdx) => {
            const nD = daysInMonth(year, mIdx);
            const firstDow = (new Date(year, mIdx, 1).getDay()+6)%7;
            // Single flat array: 7 DOW headers + blank pads + date cells
            const allCells = [];
            DOW.forEach((d,i) => allCells.push({ type:"dow", label:d, key:"h"+i }));
            for (let i=0; i<firstDow; i++) allCells.push({ type:"pad", key:"p"+i });
            for (let d=1; d<=nD; d++) allCells.push({ type:"day", day:d });
            return (
              <div key={mName} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
                <div onClick={()=>{ setCursor(new Date(year,mIdx,1)); setMode("month"); }}
                  style={{ padding:"8px 12px", background:"#eef4fd", borderBottom:`1px solid ${T.border}`, cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontSize:15, fontWeight:700, color:T.midBlue }}>{mName}</span>
                  <span style={{ fontSize:11, color:T.accent, fontWeight:600 }}>View &#8594;</span>
                </div>
                <div style={{ padding:"8px 8px 10px" }}>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
                    {allCells.map((cell, ci) => {
                      if (cell.type === "dow") return (
                        <div key={cell.key} style={{ textAlign:"center", fontSize:11, color:T.textLight, fontWeight:700, paddingBottom:3 }}>{cell.label}</div>
                      );
                      if (cell.type === "pad") return <div key={cell.key}/>;
                      // day cell
                      const day = cell.day;
                      const ds = `${year}-${String(mIdx+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                      const propsOn = occMap[ds] || [];
                      const hasEvent = eventDates.has(ds);
                      const isToday  = ds === today;
                      const colInRow = (ci - 7) % 7; // offset by 7 header cells
                      const isSat = colInRow === 5, isSun = colInRow === 6;
                      const chgProps = propsOn.filter(p => changeoverSet.has(ds + ":" + p.id));
                      const isChgover = chgProps.length > 0;
                      const cp0 = isChgover ? chgProps[0] : null;
                      const allBlocked = propsOn.length > 0 && propsOn.every(p => blockedSet.has(ds + ":" + p.id));
                      const bg = allBlocked
                        ? "repeating-linear-gradient(135deg, #e2e8f0, #e2e8f0 4px, #eef2f7 4px, #eef2f7 8px)"
                        : isChgover && cp0
                        ? "linear-gradient(135deg, " + darkenHex(cp0.colour, 60) + " 50%, " + cp0.colour + "44 50%)"
                        : propsOn.length === 1 ? propsOn[0].colour+"2a"
                        : propsOn.length > 1   ? propsOn[0].colour+"1e"
                        : "transparent";
                      const dayEntries = bookingMap[ds] || [];
                      const dateEvts = eventByDate[ds] || [];
                      return (
                        <div key={day}
                          style={{ textAlign:"center", padding:"3px 0 5px", borderRadius:3, background:bg,
                            outline: isToday ? `1.5px solid ${T.accent}` : "none",
                            cursor: (dayEntries.length||dateEvts.length) ? "pointer" : "default", position:"relative" }}
                          onMouseEnter={function(e) {
                            if (!dayEntries.length && !dateEvts.length) return;
                            var rect = e.currentTarget.getBoundingClientRect();
                            setTooltip({ ds:ds, dayEntries:dayEntries, dateEvts:dateEvts, x:rect.left, y:rect.bottom+4 });
                          }}
                          onMouseLeave={function() { setTooltip(null); }}>
                          <div style={{ fontSize:12, fontWeight:propsOn.length||hasEvent?700:400,
                            color: isSat||isSun ? T.accent : T.text, lineHeight:"1.3" }}>{day}</div>
                          {(propsOn.length > 0 || hasEvent) && (
                            <div style={{ display:"flex", justifyContent:"center", gap:2, marginTop:2, flexWrap:"wrap" }}>
                              {propsOn.slice(0,3).map(function(p){
                                const isPropBlocked = blockedSet.has(ds + ":" + p.id);
                                return (
                                  <span key={p.id} title={isPropBlocked ? p.name + " — not available" : p.name} style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:11, height:11, borderRadius:2, background: isPropBlocked ? "#94a3b8" : p.colour, color:"#fff", fontSize:8, fontWeight:800, lineHeight:1 }}>
                                    {(p.id||p.name||"?")[0].toUpperCase()}
                                  </span>
                                );
                              })}
                              {hasEvent && (
                                <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:11, height:11, borderRadius:2, background:"#ef4444", color:"#fff", fontSize:8, fontWeight:800, lineHeight:1 }}>E</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Hover tooltip */}
        {tooltip && (function() {
          var vw = typeof window !== "undefined" ? window.innerWidth : 800;
          var tLeft = Math.max(8, Math.min(tooltip.x - 130, vw - 280));
          var dispDate = new Date(tooltip.ds+"T00:00:00").toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long" });
          return (
            <div style={{ position:"fixed", left:tLeft, top:tooltip.y, zIndex:9999, background:"#1e293b", color:"#f8fafc",
              borderRadius:9, boxShadow:"0 8px 28px rgba(0,0,0,.35)", padding:"10px 14px", minWidth:220, maxWidth:280, pointerEvents:"none", fontSize:12, lineHeight:"1.55" }}>
              <div style={{ fontWeight:700, marginBottom:6, borderBottom:"1px solid rgba(255,255,255,.18)", paddingBottom:4, fontSize:13 }}>{dispDate}</div>
              {tooltip.dayEntries.map(function(entry, i) {
                return (
                  <div key={i} style={{ marginBottom: i < tooltip.dayEntries.length-1 ? 8 : 0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ width:8, height:8, borderRadius:"50%", background:entry.prop.colour, display:"inline-block", flexShrink:0 }}/>
                      <span style={{ fontWeight:700, color:"#cbd5e1" }}>{entry.prop.name}</span>
                    </div>
                    <div style={{ paddingLeft:14, color:"#e2e8f0" }}>
                      {entry.booking.guestName || entry.booking.name || "Guest"}
                    </div>
                    {entry.stay.checkIn && (
                      <div style={{ paddingLeft:14, color:"#94a3b8", fontSize:11 }}>
                        {new Date(entry.stay.checkIn+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"})}
                        {" - "}
                        {new Date(entry.stay.checkOut+"T00:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"})}
                      </div>
                    )}
                  </div>
                );
              })}
              {(tooltip.dateEvts||[]).map(function(ev, i) {
                return (
                  <div key={i} style={{ marginTop: (i===0&&tooltip.dayEntries.length) ? 6 : i===0 ? 0 : 4, display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ width:8, height:8, borderRadius:"50%", background:"#ef4444", display:"inline-block", flexShrink:0 }}/>
                    <span style={{ color:"#fca5a5", fontWeight:600 }}>
                      {ev.eventType || "Wedding"}{ev.couple ? " — " + ev.couple : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Legend */}
        <div style={{ display:"flex", gap:18, flexWrap:"wrap", alignItems:"center", padding:"10px 14px", background:"#fff", border:`1px solid ${T.border}`, borderRadius:9, fontSize:12, color:T.textMid }}>
          <span style={{ fontWeight:700, color:T.text, fontSize:11, textTransform:"uppercase", letterSpacing:.4 }}>Key:</span>
          {properties.map(function(p){
            return (
              <span key={p.id} style={{ display:"flex", alignItems:"center", gap:5 }}>
                <span style={{ width:12, height:12, borderRadius:2, background:p.colour+"2a", border:`1.5px solid ${p.colour}`, display:"inline-block" }}/>
                <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:11, height:11, borderRadius:2, background:p.colour, color:"#fff", fontSize:8, fontWeight:800 }}>{(p.id||p.name||"?")[0].toUpperCase()}</span>
                {p.name}
              </span>
            );
          })}
          <span style={{ display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:11, height:11, borderRadius:2, background:"#ef4444", color:"#fff", fontSize:8, fontWeight:800 }}>E</span>
            Farm event
          </span>
          <span style={{ display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:11, height:11, borderRadius:2, background:"#94a3b8", color:"#fff", fontSize:8, fontWeight:800 }}>×</span>
            Blocked / not available
          </span>
          <span style={{ display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ width:12, height:12, borderRadius:2, background:"linear-gradient(135deg, #1040a0 50%, #3b82f633 50%)", display:"inline-block" }}/>
            Changeover
          </span>
          <span style={{ display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ width:12, height:12, borderRadius:2, outline:`1.5px solid ${T.accent}`, display:"inline-block" }}/>
            Today
          </span>
          <span style={{ display:"flex", alignItems:"center", gap:5, color:T.textLight, fontStyle:"italic" }}>
            Hover a date to see booking details
          </span>
        </div>
      </div>
    );
  }

  // ── MONTH TIMELINE VIEW ────────────────────────────────────────────────────
  const nDays = daysInMonth(year, month);
  const dayW = 34;
  const monthStart = new Date(year, month, 1);
  const monthEnd   = new Date(year, month+1, 1);
  const monthLabel = cursor.toLocaleDateString("en-GB", { month:"long", year:"numeric" });

  const laneFor = (pid) => {
    const entries = [];
    bookings.forEach(b => {
      if (b.status === "cancelled") return;
      const stays = (b.stays && b.stays.length) ? b.stays : [b];
      stays.forEach(s => {
        if (s.propertyId !== pid) return;
        if (!s.checkIn || !s.checkOut) return;
        if (new Date(s.checkOut+"T00:00:00") <= monthStart) return;
        if (new Date(s.checkIn+"T00:00:00") >= monthEnd) return;
        entries.push({ booking:b, checkIn:s.checkIn, checkOut:s.checkOut });
      });
    });
    return entries;
  };

  const barGeom = (checkIn, checkOut) => {
    const ci = new Date(checkIn+"T00:00:00"), co = new Date(checkOut+"T00:00:00");
    const startDay = ci < monthStart ? 0 : (ci.getDate() - 1);
    const endDay   = co > monthEnd   ? nDays : (co.getDate() - 1);
    const span = Math.max(1, endDay - startDay);
    return { left: startDay * dayW, width: span * dayW - 3 };
  };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
        <button onClick={()=>setMode("year")} style={{ ...navBtn, width:"auto", padding:"0 14px", fontSize:13, fontWeight:600, color:T.accent, border:`1.5px solid ${T.accent}` }}>&#8592; Year</button>
        <button onClick={()=>setCursor(new Date(year, month-1, 1))} style={navBtn}>&#8249;</button>
        <div style={{ fontSize:17, fontWeight:700, color:T.text, minWidth:180, textAlign:"center" }}>{monthLabel}</div>
        <button onClick={()=>setCursor(new Date(year, month+1, 1))} style={navBtn}>&#8250;</button>
        <button onClick={()=>setCursor(new Date())} style={{ ...navBtn, width:"auto", padding:"0 14px", fontSize:13, fontWeight:600 }}>Today</button>
      </div>

      <div style={{ overflowX:"auto", border:`1px solid ${T.border}`, borderRadius:10, background:"#fff" }}>
        <div style={{ minWidth: 130 + nDays*dayW }}>
          <div style={{ display:"flex", borderBottom:`1px solid ${T.border}`, background:T.bgInput }}>
            <div style={{ width:130, flexShrink:0, padding:"8px 10px", fontSize:12, fontWeight:700, color:T.textMid }}>Property</div>
            {Array.from({length:nDays}, (_,i)=>{
              const d = new Date(year, month, i+1);
              const wknd = d.getDay()===0 || d.getDay()===6;
              return (
                <div key={i} style={{ width:dayW, flexShrink:0, textAlign:"center", padding:"6px 0", fontSize:11,
                  color: wknd ? T.accent : T.textLight, fontWeight: wknd?700:500, background: wknd ? "#f0f6ff" : "transparent" }}>
                  <div>{"SMTWTFS".charAt(d.getDay())}</div>
                  <div style={{ fontSize:12, color:T.text }}>{i+1}</div>
                </div>
              );
            })}
          </div>
          {properties.map(p => {
            const lane = laneFor(p.id);
            const checkInDays = new Set(
              lane.filter(e => { const ci=new Date(e.checkIn+"T00:00:00"); return ci.getFullYear()===year&&ci.getMonth()===month; })
                  .map(e => new Date(e.checkIn+"T00:00:00").getDate())
            );
            const checkOutDays = new Set(
              lane.filter(e => { const co=new Date(e.checkOut+"T00:00:00"); return co.getFullYear()===year&&co.getMonth()===month; })
                  .map(e => new Date(e.checkOut+"T00:00:00").getDate())
            );
            return (
              <div key={p.id} style={{ display:"flex", borderBottom:`1px solid ${T.border}` }}>
                <div style={{ width:130, flexShrink:0, padding:"12px 10px", fontSize:13, fontWeight:700, color:T.text,
                  display:"flex", alignItems:"center", gap:7, borderRight:`1px solid ${T.border}` }}>
                  <span style={{ width:11, height:11, borderRadius:3, background:p.colour, flexShrink:0 }}/>{p.name}
                </div>
                <div style={{ position:"relative", height:44, flex:1 }}>
                  {Array.from({length:nDays}, (_,i)=>{
                    const d = new Date(year, month, i+1);
                    const wknd = d.getDay()===0||d.getDay()===6;
                    const dayNum = i+1;
                    const isCI = checkInDays.has(dayNum);
                    const isCO = checkOutDays.has(dayNum);
                    const isChgDay = isCI && isCO;
                    return (
                      <div key={i} style={{ position:"absolute", left:i*dayW, top:0, width:dayW, height:"100%",
                        background: wknd ? "#f6faff" : "transparent", borderRight:`1px solid #eef3fa`, overflow:"hidden" }}>
                        {isCO && <div style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%",
                          background: isChgDay ? darkenHex(p.colour, 55) : p.colour,
                          opacity: isChgDay ? 0.75 : 0.28,
                          clipPath:"polygon(0 0, 0% 100%, 100% 100%)" }}/>}
                        {isCI && <div style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%",
                          background: p.colour,
                          opacity: isChgDay ? 0.35 : 0.28,
                          clipPath:"polygon(100% 0, 0 0, 100% 100%)" }}/>}
                      </div>
                    );
                  })}
                  {lane.map((e,i) => {
                    const g = barGeom(e.checkIn, e.checkOut);
                    const b = e.booking;
                    const airbnb = b.source==="airbnb";
                    const blocked = b.bookingType==="Blocked";
                    return (
                      <div key={b.id+"-"+i} onClick={()=>onOpen(b)}
                        title={`${blocked ? "Not available" : (b.guestName||"(no name)")} - ${fmtDate(e.checkIn)} to ${fmtDate(e.checkOut)}`}
                        style={{ position:"absolute", left:g.left+2, top:8, width:g.width, height:28, borderRadius:6,
                          background: blocked ? "repeating-linear-gradient(135deg, #e2e8f0, #e2e8f0 4px, #eef2f7 4px, #eef2f7 8px)" : airbnb ? "#fff" : p.colourBg,
                          border: blocked ? "1.5px solid #94a3b8" : `1.5px ${airbnb?"dashed":"solid"} ${p.colour}`,
                          color: blocked ? "#64748b" : p.colour, fontSize:11, fontWeight:600, padding:"0 6px", display:"flex", alignItems:"center",
                          overflow:"hidden", whiteSpace:"nowrap", cursor:"pointer", opacity: b.status==="pending"?0.75:1 }}>
                        {blocked ? "Not available" : airbnb ? "Airbnb" : (b.guestName || "Booking")}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display:"flex", gap:16, marginTop:10, fontSize:12, color:T.textMid, flexWrap:"wrap", alignItems:"center" }}>
        <span><span style={{ display:"inline-block", width:20, height:10, background:T.accentLight, border:`1.5px solid ${T.accent}`, borderRadius:3, verticalAlign:"middle", marginRight:5 }}/>Direct / manual</span>
        <span><span style={{ display:"inline-block", width:20, height:10, background:"#fff", border:`1.5px dashed ${T.accent}`, borderRadius:3, verticalAlign:"middle", marginRight:5 }}/>Airbnb block</span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
          <span style={{ display:"inline-block", width:14, height:14, background:"#2563eb", opacity:.3, clipPath:"polygon(0 0, 0% 100%, 100% 100%)", verticalAlign:"middle" }}/>
          <span>Checkout day</span>
        </span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
          <span style={{ display:"inline-block", width:14, height:14, background:"#2563eb", opacity:.3, clipPath:"polygon(100% 0, 0 0, 100% 100%)", verticalAlign:"middle" }}/>
          <span>Checkin day</span>
        </span>
        <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
          <span style={{ display:"inline-flex", width:14, height:14, verticalAlign:"middle", overflow:"hidden" }}>
            <span style={{ display:"inline-block", width:"100%", height:"100%", background:"#1040a0", opacity:.8, clipPath:"polygon(0 0, 0% 100%, 100% 100%)" }}/>
          </span>
          <span>+</span>
          <span style={{ display:"inline-flex", width:14, height:14, verticalAlign:"middle", overflow:"hidden" }}>
            <span style={{ display:"inline-block", width:"100%", height:"100%", background:"#2563eb", opacity:.35, clipPath:"polygon(100% 0, 0 0, 100% 100%)" }}/>
          </span>
          <span>Changeover day</span>
        </span>
        <span style={{ opacity:.7 }}>Faded = pending</span>
      </div>
    </div>
  );
}

const navBtn = { width:36, height:36, borderRadius:8, border:`1.5px solid ${T.border}`, background:"#fff", color:T.text, fontSize:18, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" };

// ── Booking list ─────────────────────────────────────────────────────────────
// Short display label for a property (used in table headers / badges)
function shortPropLabel(p) {
  var n = (p && (p.name || p.id)) || "";
  if (/hamlet/i.test(n)) return "Hamlet";
  if (/amly/i.test(n)) return "Amly";
  if (/glamp/i.test(n) || /camping/i.test(n)) return "Glamping";
  return n.split(" ")[0] || n;
}

// Source label for a lettings booking: Manual / Website / Airbnb / Blocked
function accomSourceLabel(b) {
  if (b.bookingType === "Blocked") return "Blocked";
  if (b.source === "airbnb") return "Airbnb";
  if (b.source === "direct" || b.source === "website") return "Website";
  return "Manual";
}
const ACCOM_SOURCE_META = {
  Manual:  { bg:"#e0e7ff", text:"#4338ca" },
  Website: { bg:"#dcfce7", text:"#15803d" },
  Airbnb:  { bg:"#fee2e2", text:"#b91c1c" },
  Blocked: { bg:"#f1f5f9", text:"#64748b" },
};

function AccomList({ properties, bookings, filterProp, setFilterProp, filterStatus, setFilterStatus, onOpen }) {
  const [showPast, setShowPast] = useState(false);
  const today = new Date().toISOString().slice(0,10);

  const propName = (id) => (properties.find(p=>p.id===id)||{}).name || id;

  const withPrimary = bookings.map(b => {
    const primary = (b.stays && b.stays[0]) || b;
    return { b, primary };
  });

  const isCurrent = ({ primary }) => {
    // A booking is "current/future" if its latest checkout is today or later
    return (primary.checkOut || "") >= today;
  };

  const filtered = withPrimary
    .filter(({ b, primary }) => filterProp==="all" || (b.stays||[]).some(s=>s.propertyId===filterProp) || b.propertyId===filterProp)
    .filter(({ b }) => filterStatus==="all" || b.status===filterStatus);

  const currentRows = filtered.filter(x => isCurrent(x))
    .sort((a,z)=> (a.primary.checkIn||"").localeCompare(z.primary.checkIn||""));

  const pastRows = filtered.filter(x => !isCurrent(x))
    .sort((a,z)=> (z.primary.checkIn||"").localeCompare(a.primary.checkIn||"")); // most recent first

  const paidState = (b) => {
    if (!b.schedule || !b.schedule.length) return b.value>0 ? "—" : "n/a";
    const paid = b.schedule.filter(s=>s.paid).length;
    return paid===b.schedule.length ? "Paid" : String(paid)+"/"+String(b.schedule.length);
  };

  // Which property IDs are booked in this booking
  const bookedPropIds = (b) => {
    var ids = new Set();
    if (b.stays && b.stays.length) {
      b.stays.forEach(function(s){ if (s.propertyId) ids.add(s.propertyId); });
    } else if (b.propertyId) {
      ids.add(b.propertyId);
    }
    return ids;
  };

  // Build dynamic grid: Guest | per-property | Dates | Source | Event | Status | Value | Paid
  const propCols = properties.map(function(){ return "0.55fr"; }).join(" ");
  const gridTemplate = "1.5fr " + propCols + " 1.1fr 0.7fr 0.75fr 0.75fr 0.75fr 0.75fr";

  const TableHeader = () => (
    <div style={{ display:"grid", gridTemplateColumns:gridTemplate, background:T.bgInput, borderBottom:`1px solid ${T.border}`, fontSize:12, fontWeight:700, color:T.textMid }}>
      <div style={{ padding:"10px 12px" }}>Guest</div>
      {properties.map(p=>(
        <div key={p.id} style={{ padding:"10px 4px", textAlign:"center" }}>
          <span title={p.name} style={{ display:"inline-flex", alignItems:"center", gap:3, fontSize:11 }}>
            <span style={{ width:8, height:8, borderRadius:"50%", background:p.colour, display:"inline-block" }}/>
            {shortPropLabel(p)}
          </span>
        </div>
      ))}
      <div style={{ padding:"10px 12px" }}>Dates</div>
      <div style={{ padding:"10px 12px" }}>Source</div>
      <div style={{ padding:"10px 12px" }}>Type</div>
      <div style={{ padding:"10px 12px" }}>Status</div>
      <div style={{ padding:"10px 12px" }}>Value</div>
      <div style={{ padding:"10px 12px" }}>Paid</div>
    </div>
  );

  const Row = ({ b, primary }) => {
    const meta = ACCOM_STATUS_META[b.status] || ACCOM_STATUS_META.confirmed;
    const bProps = bookedPropIds(b);
    const srcLabel = accomSourceLabel(b);
    const srcMeta = ACCOM_SOURCE_META[srcLabel] || ACCOM_SOURCE_META.Manual;
    return (
      <div onClick={()=>onOpen(b)} style={{ display:"grid", gridTemplateColumns:gridTemplate, borderBottom:`1px solid #eef3fa`, cursor:"pointer", fontSize:13, color:T.text, alignItems:"center" }}>
        <div style={{ padding:"11px 12px", fontWeight:600 }}>
          {b.guestName || (b.bookingType==="Blocked" ? "Not available" : b.source==="airbnb" ? "Airbnb block" : "(no name)")}
          {b.estimated && b.value>0 && <span style={{ marginLeft:6, fontSize:10, color:T.amber, fontWeight:600 }}>est.</span>}
        </div>
        {properties.map(p=>(
          <div key={p.id} style={{ padding:"8px 4px", textAlign:"center" }}>
            {bProps.has(p.id)
              ? <span style={{ width:14, height:14, borderRadius:3, background: b.bookingType==="Blocked" ? "#94a3b8" : p.colour, display:"inline-block", boxShadow:"0 1px 3px "+(b.bookingType==="Blocked"?"#94a3b8":p.colour)+"66" }} title={p.name}/>
              : <span style={{ width:14, height:14, borderRadius:3, border:`1.5px solid #e2e8f0`, display:"inline-block", background:"transparent" }}/>
            }
          </div>
        ))}
        <div style={{ padding:"11px 12px", fontSize:12 }}>{fmtDate(primary.checkIn)} – {fmtDate(primary.checkOut)}</div>
        <div style={{ padding:"11px 12px" }}>
          <span style={{ fontSize:11, fontWeight:700, color:srcMeta.text, background:srcMeta.bg, padding:"2px 7px", borderRadius:8 }}>{srcLabel}</span>
        </div>
        <div style={{ padding:"11px 12px" }}>
          {b.bookingType
            ? <span style={{ fontSize:11, fontWeight:700, color: b.bookingType==="Blocked" ? "#64748b" : T.accent, background: b.bookingType==="Blocked" ? "#f1f5f9" : T.accentLight, padding:"2px 7px", borderRadius:8 }}>{b.bookingType}</span>
            : <span style={{ color:T.textLight, fontSize:11 }}>Let</span>}
        </div>
        <div style={{ padding:"11px 12px" }}><span style={{ fontSize:11, fontWeight:700, color:meta.text, background:meta.bg, padding:"2px 8px", borderRadius:8 }}>{meta.label}</span></div>
        <div style={{ padding:"11px 12px" }}>{b.value>0 ? fmtMoney(b.value) : "—"}</div>
        <div style={{ padding:"11px 12px" }}>{paidState(b)}</div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap", alignItems:"center" }}>
        <select value={filterProp} onChange={e=>setFilterProp(e.target.value)} style={selStyle}>
          <option value="all">All properties</option>
          {properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={selStyle}>
          <option value="all">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <span style={{ alignSelf:"center", fontSize:13, color:T.textMid }}>{currentRows.length} upcoming · {pastRows.length} past</span>
      </div>

      <div style={{ border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", background:"#fff" }}>
        <TableHeader/>
        {currentRows.map(({ b, primary }) => <Row key={b.id} b={b} primary={primary}/>)}
        {!currentRows.length && <div style={{ padding:"22px", textAlign:"center", color:T.textLight, fontSize:13 }}>No upcoming bookings match.</div>}
      </div>

      <div style={{ marginTop:14, textAlign:"center" }}>
        <button onClick={()=>setShowPast(v=>!v)}
          style={{ background:"none", border:`1.5px solid ${T.border}`, color:T.textMid, borderRadius:8, padding:"8px 20px", cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
          {showPast ? "Hide past bookings" : "Show past bookings (" + pastRows.length + ")"}
        </button>
      </div>

      {showPast && pastRows.length > 0 && (
        <div style={{ border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", background:"#fff", marginTop:10, opacity:.85 }}>
          <div style={{ padding:"8px 14px", background:T.bgInput, borderBottom:`1px solid ${T.border}`, fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.4 }}>
            Past bookings (most recent first)
          </div>
          <TableHeader/>
          {pastRows.map(({ b, primary }) => <Row key={b.id} b={b} primary={primary}/>)}
        </div>
      )}
    </div>
  );
}

const selStyle = { background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:7, color:T.text, fontFamily:"inherit", fontSize:13, padding:"8px 11px", outline:"none", cursor:"pointer" };

// ── Add / edit form ──────────────────────────────────────────────────────────
function AccomForm({ properties, discountCodes, events, form, setForm, onSave, onCancel, onDelete }) {
  var formStays = (form.stays && form.stays.length) ? form.stays : [{ propertyId:form.propertyId||"hamlet", propertyName:"", checkIn:form.checkIn||"", checkOut:form.checkOut||"", nights:null, guestCount:form.guestCount||"", value:Number(form.value)||0 }];
  var selPropIds = formStays.map(function(s){ return s.propertyId; });
  var totalValue = formStays.reduce(function(s,st){ return s+(Number(st.value)||0); }, 0);
  var primaryProp = properties.find(function(p){ return p.id===selPropIds[0]; });
  const upd = (k,v)=> setForm(f=>({ ...f, [k]:v }));
  const zeroValue = totalValue <= 0;

  const toggleProp = (pid, checked) => setForm(function(f) {
    var cur = (f.stays&&f.stays.length) ? f.stays : [{ propertyId:f.propertyId||"hamlet", propertyName:"", checkIn:"", checkOut:"", nights:null, guestCount:"", value:0 }];
    var next;
    if (checked) {
      var ref = cur[0] || {};
      next = cur.concat([{ propertyId:pid, propertyName:"", checkIn:ref.checkIn||"", checkOut:ref.checkOut||"", nights:ref.nights||null, guestCount:"", value:0 }]);
    } else {
      next = cur.filter(function(s){ return s.propertyId !== pid; });
      if (!next.length) next = cur;
    }
    var pIds = next.map(function(s){ return s.propertyId; });
    var tot = next.reduce(function(s,st){ return s+(Number(st.value)||0); }, 0);
    return Object.assign({}, f, { stays:next, propertyIds:pIds, propertyId:pIds[0], value:tot });
  });

  const updStay = (idx, key, val) => setForm(function(f) {
    var cur = (f.stays&&f.stays.length) ? f.stays : [];
    var next = cur.map(function(s,i){ return i===idx ? Object.assign({}, s, { [key]:val }) : s; });
    var tot = next.reduce(function(s,st){ return s+(Number(st.value)||0); }, 0);
    return Object.assign({}, f, { stays:next, value:tot });
  });

  const regenSchedule = () => {
    var firstStay = formStays[0] || {};
    const sched = buildAccomSchedule(totalValue, primaryProp, firstStay.checkIn);
    setForm(f=>({ ...f, schedule: sched, value: totalValue }));
  };
  const updSched = (i, k, v) => setForm(f=>{
    const s = f.schedule.map((row,idx)=> idx===i ? { ...row, [k]:v } : row);
    return { ...f, schedule: s };
  });
  const addExtra = () => setForm(f=>({ ...f, extras: f.extras.concat([{ desc:"", amount:0 }]) }));
  const updExtra = (i,k,v)=> setForm(f=>({ ...f, extras: f.extras.map((e,idx)=> idx===i ? { ...e, [k]:v } : e) }));
  const rmExtra = (i)=> setForm(f=>({ ...f, extras: f.extras.filter((_,idx)=> idx!==i) }));

  return (
    <div style={{ maxWidth:860 }}>
      {form.bookingType === "Blocked" && (
        <div style={{ marginBottom:16, padding:"10px 14px", background:"#f1f5f9", border:`1.5px solid #cbd5e1`, borderRadius:8, fontSize:12, color:T.textMid, lineHeight:1.5 }}>
          This marks the property as unavailable for the selected dates. It won't be treated as a guest booking, and will sync out to Airbnb as blocked.
        </div>
      )}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14, marginBottom:16 }}>
        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
          <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>Properties</span>
          <div style={{ display:"flex", gap:14, flexWrap:"wrap", padding:"10px 12px", background:T.bgInput, borderRadius:8, border:`1.5px solid ${T.border}` }}>
            {properties.map(function(p) {
              var checked = selPropIds.includes(p.id);
              return (
                <label key={p.id} style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", fontSize:13, fontWeight:checked?700:500, color:checked?T.text:T.textMid }}>
                  <input type="checkbox" checked={checked}
                    onChange={function(e){ toggleProp(p.id, e.target.checked); }}
                    style={{ width:15, height:15, accentColor:p.colour, cursor:"pointer" }} />
                  <span style={{ width:10, height:10, borderRadius:"50%", background:p.colour, display:"inline-block" }}/>
                  {p.name}
                </label>
              );
            })}
          </div>
        </div>
        <label style={{ display:"flex", flexDirection:"column", gap:5 }}>
          <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>Booking type</span>
          <select value={form.bookingType} onChange={function(e){
            var v = e.target.value;
            upd("bookingType", v);
            if (v === "Blocked" && !form.guestName) upd("guestName", "Not available");
          }} style={{ ...selStyle, padding:"9px 11px" }}>
            <option value="">Standard let</option>
            <option value="Wedding">Wedding</option>
            <option value="Owner">Owner / comp</option>
            <option value="Blocked">Blocked (not available)</option>
          </select>
        </label>
        {(events && events.length > 0) && (
          <label style={{ display:"flex", flexDirection:"column", gap:5 }}>
            <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>Link to farm event</span>
            <select value={form.linkedEventId || ""} onChange={function(e){ upd("linkedEventId", e.target.value ? Number(e.target.value) : null); }} style={{ ...selStyle, padding:"9px 11px" }}>
              <option value="">No event link</option>
              {(events||[]).slice().sort(function(a,b){ return a.date>b.date?1:-1; }).map(function(ev) {
                return (
                  <option key={ev.id} value={ev.id}>
                    {ev.date} — {ev.couple || ev.bookingType || "Event"}{ev.eventType ? " (" + ev.eventType + ")" : ""}
                  </option>
                );
              })}
            </select>
            {form.linkedEventId && (
              <span style={{ fontSize:11, color:T.accent, fontWeight:600 }}>Linked to event #{form.linkedEventId}</span>
            )}
          </label>
        )}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14, marginBottom:16 }}>
        <LInput label="Guest name" value={form.guestName} onChange={v=>upd("guestName",v)} />
        <LInput label="Email" value={form.email} onChange={v=>upd("email",v)} />
        <LInput label="Phone" value={form.phone} onChange={v=>upd("phone",v)} />
        <label style={{ display:"flex", flexDirection:"column", gap:5 }}>
          <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>Status</span>
          <select value={form.status} onChange={e=>upd("status", e.target.value)} style={{ ...selStyle, padding:"9px 11px" }}>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>

      {/* Per-property stays grid */}
      <div style={{ border:`1px solid ${T.border}`, borderRadius:9, overflow:"hidden", marginBottom:16 }}>
        <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr 50px 60px 1fr", background:T.bgInput, borderBottom:`1px solid ${T.border}`, fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.5 }}>
          {["Property","Check-in","Check-out","Nights","Guests","Price (£)"].map(function(h){ return <div key={h} style={{ padding:"9px 12px" }}>{h}</div>; })}
        </div>
        {formStays.map(function(s, idx) {
          var p = properties.find(function(pp){ return pp.id===s.propertyId; });
          var nights = nightsBetween(s.checkIn, s.checkOut);
          var q = (p && p.baseRate && s.checkIn && s.checkOut) ? quoteStay(p, s.checkIn, s.checkOut) : null;
          return (
            <div key={s.propertyId} style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr 50px 60px 1fr", borderBottom: idx < formStays.length-1 ? `1px solid ${T.border}` : "none", background:"#fff", alignItems:"center" }}>
              <div style={{ padding:"10px 12px", display:"flex", alignItems:"center", gap:7, fontSize:13, fontWeight:600 }}>
                {p && <span style={{ width:10, height:10, borderRadius:"50%", background:p.colour, display:"inline-block", flexShrink:0 }}/>}
                {p ? p.name : s.propertyId}
              </div>
              <div style={{ padding:"6px 8px" }}>
                <input type="date" value={s.checkIn||""} onChange={function(e){ updStay(idx,"checkIn",e.target.value); }} style={{ ...inlineInput, width:"100%" }}/>
              </div>
              <div style={{ padding:"6px 8px" }}>
                <input type="date" value={s.checkOut||""} onChange={function(e){ updStay(idx,"checkOut",e.target.value); }} style={{ ...inlineInput, width:"100%" }}/>
              </div>
              <div style={{ padding:"10px 8px", fontSize:13, color:T.textMid, textAlign:"center" }}>{nights||"—"}</div>
              <div style={{ padding:"6px 8px" }}>
                <input type="number" value={s.guestCount||""} placeholder="—" onChange={function(e){ updStay(idx,"guestCount",e.target.value); }} style={{ ...inlineInput, width:"100%" }}/>
              </div>
              <div style={{ padding:"6px 8px", display:"flex", gap:6, alignItems:"center" }}>
                <input type="number" value={s.value||""} placeholder="0" onChange={function(e){ updStay(idx,"value",e.target.value); }} style={{ ...inlineInput, flex:1, minWidth:0 }}/>
                {q && (
                  <button type="button" onClick={function(){ updStay(idx,"value",q.total); }}
                    title={"Pricing estimate: "+fmtMoney(q.total)}
                    style={{ ...smallBtn, padding:"5px 9px", fontSize:11, whiteSpace:"nowrap", flexShrink:0 }}>
                    {fmtMoney(q.total)}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {formStays.length > 1 && (
          <div style={{ display:"flex", justifyContent:"flex-end", alignItems:"center", padding:"10px 16px", background:T.accentLight, borderTop:`1px solid ${T.accent}30`, gap:16 }}>
            <span style={{ fontSize:12, color:T.midBlue }}>Total billed to guest</span>
            <span style={{ fontSize:16, fontWeight:800, color:T.text }}>{fmtMoney(totalValue)}</span>
          </div>
        )}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:8 }}>
        <label style={{ display:"flex", flexDirection:"column", gap:5 }}>
          <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>Discount code</span>
          <input value={form.discountCode || ""} onChange={e => {
            const code = e.target.value.toUpperCase();
            upd("discountCode", code);
            const today = new Date().toISOString().slice(0,10);
            const match = (discountCodes || []).find(c => c.active && c.code === code && (!c.expiresAt || c.expiresAt >= today));
            if (match) {
              const disc = match.type === "pct" ? Math.round((Number(form.value)||0) * match.value / 100 * 100) / 100 : match.value;
              upd("discountAmount", disc);
            } else {
              upd("discountAmount", 0);
            }
          }} style={inpStyle} placeholder="e.g. SUMMER10" />
          {(function() {
            const today = new Date().toISOString().slice(0,10);
            const match = (discountCodes || []).find(c => c.code === (form.discountCode || "").toUpperCase());
            if (!form.discountCode) return null;
            if (!match) return <span style={{ fontSize:11, color:T.red }}>Code not found</span>;
            if (!match.active) return <span style={{ fontSize:11, color:T.red }}>Code inactive</span>;
            if (match.expiresAt && match.expiresAt < today) return <span style={{ fontSize:11, color:T.red }}>Code expired</span>;
            return <span style={{ fontSize:11, color:T.green, fontWeight:600 }}>Valid — {match.type === "pct" ? match.value+"% off" : fmtMoney(match.value)+" off"}</span>;
          })()}
        </label>
        <label style={{ display:"flex", flexDirection:"column", gap:5 }}>
          <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>Source</span>
          <select value={form.source} onChange={e=>upd("source", e.target.value)} style={{ ...selStyle, padding:"9px 11px" }}>
            <option value="manual">Manual</option>
            <option value="direct">Direct (online)</option>
            <option value="airbnb">Airbnb</option>
            <option value="wedding">Wedding-linked</option>
          </select>
        </label>
      </div>
      {zeroValue && <div style={{ fontSize:12, color:T.textMid, background:T.amberBg, border:`1px solid #fcd34d`, borderRadius:7, padding:"8px 11px", marginBottom:16 }}>Zero value — this booking blocks the calendar but generates no payment schedule and is never chased.</div>}

      {/* Extras */}
      <div style={{ border:`1px solid ${T.border}`, borderRadius:9, padding:"14px 16px", marginBottom:16, background:T.bgInput }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: form.extras.length?10:0 }}>
          <span style={{ fontSize:13, fontWeight:700, color:T.text }}>Extras</span>
          <button onClick={addExtra} style={smallBtn}>+ Add extra</button>
        </div>
        {form.extras.map((e,i)=>(
          <div key={i} style={{ display:"flex", gap:10, marginBottom:8 }}>
            <input value={e.desc} placeholder="Description" onChange={ev=>updExtra(i,"desc",ev.target.value)} style={{ flex:1, ...inlineInput }} />
            <input type="number" value={e.amount} placeholder="£" onChange={ev=>updExtra(i,"amount",ev.target.value)} style={{ width:110, ...inlineInput }} />
            <button onClick={()=>rmExtra(i)} style={{ ...smallBtn, color:T.red, borderColor:"#fca5a5" }}>Remove</button>
          </div>
        ))}
      </div>

      {/* Breakage */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:16, alignItems:"end" }}>
        <LInput label="Breakage deposit (£, refundable)" type="number" value={form.breakage} onChange={v=>upd("breakage",v)} />
        {Number(form.breakage)>0 && (
          <button onClick={()=>alert("Refund breakage via Stripe — wired to the Stripe refund function in phase 2 (uses the stored charge ID).")}
            style={{ ...smallBtn, padding:"9px 14px", fontSize:13 }}>Refund breakage from Stripe</button>
        )}
      </div>

      {/* Payment schedule */}
      <div style={{ border:`1px solid ${T.border}`, borderRadius:9, padding:"14px 16px", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <span style={{ fontSize:13, fontWeight:700, color:T.text }}>Payment schedule</span>
          <button onClick={regenSchedule} style={smallBtn} disabled={zeroValue}>Auto-build deposit + balance</button>
        </div>
        {!form.schedule.length && <div style={{ fontSize:12, color:T.textLight }}>No schedule. {zeroValue ? "Zero-value booking." : "Use auto-build, or leave blank if paid."}</div>}
        {form.schedule.map((s,i)=>(
          <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 0.9fr 1.1fr auto", gap:10, alignItems:"center", marginBottom:8 }}>
            <input value={s.label} onChange={e=>updSched(i,"label",e.target.value)} style={inlineInput} />
            <input type="number" value={s.amount} onChange={e=>updSched(i,"amount",e.target.value)} style={inlineInput} />
            <input type="date" value={s.dueDate||""} onChange={e=>updSched(i,"dueDate",e.target.value)} style={inlineInput} />
            <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:T.textMid, whiteSpace:"nowrap" }}>
              <input type="checkbox" checked={!!s.paid} onChange={e=>updSched(i,"paid",e.target.checked)} style={{ width:15, height:15, accentColor:T.accent }} />paid
            </label>
          </div>
        ))}
      </div>

      <label style={{ display:"flex", flexDirection:"column", gap:5, marginBottom:18 }}>
        <span style={{ fontSize:12, fontWeight:600, color:T.textMid }}>Notes</span>
        <textarea value={form.notes} onChange={e=>upd("notes",e.target.value)} rows={3}
          style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:7, color:T.text, fontFamily:"inherit", fontSize:14, padding:"10px 11px", outline:"none", resize:"vertical" }} />
      </label>

      <div style={{ display:"flex", gap:10 }}>
        <button onClick={onSave} style={{ background:T.accent, color:"#fff", border:"none", padding:"11px 22px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700 }}>Save booking</button>
        <button onClick={onCancel} style={{ background:"#fff", color:T.textMid, border:`1.5px solid ${T.border}`, padding:"11px 22px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600 }}>Cancel</button>
        {onDelete && <button onClick={onDelete} style={{ marginLeft:"auto", background:"#fff", color:T.red, border:`1.5px solid #fca5a5`, padding:"11px 22px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600 }}>Delete</button>}
      </div>
    </div>
  );
}

const smallBtn = { background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:7, color:T.text, fontFamily:"inherit", fontSize:12, fontWeight:600, padding:"6px 12px", cursor:"pointer" };
const inlineInput = { background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:7, color:T.text, fontFamily:"inherit", fontSize:13, padding:"8px 10px", outline:"none" };

// ── One-off Bookalet importer (file upload) ──────────────────────────────────
function AccomImport({ onImported, saveBookings, bookings }) {
  const [status, setStatus] = useState("");
  const [mergeStatus, setMergeStatus] = useState("");
  const [mergePreview, setMergePreview] = useState(null);

  const handleFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        const props = Array.isArray(data.properties) && data.properties.length ? data.properties : INITIAL_PROPERTIES;
        const guests = Array.isArray(data.guests) ? data.guests : [];
        const imported = Array.isArray(data.bookings) ? data.bookings : [];
        setStatus("Saving " + imported.length + " bookings and " + guests.length + " guests…");
        await sbSet(PROPERTIES_STORAGE, props);
        await sbSet(ACCOM_GUESTS_STORAGE, guests);
        await sbSet(ACCOM_STORAGE, imported);
        setStatus("Imported " + imported.length + " bookings and " + guests.length + " guests.");
        onImported(props, guests, imported);
      } catch (err) {
        setStatus("Import failed: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  // Find pairs: any two single-property bookings with the same guest name (case-insensitive)
  // that have different properties and check-in dates within 7 days of each other.
  const findMergePairs = () => {
    var singles = (bookings||[]).filter(function(b) {
      if (b.status === "cancelled") return false;
      var stays = (b.stays&&b.stays.length) ? b.stays : [b];
      return stays.length === 1;
    });
    var pairs = [];
    var used = new Set();
    singles.forEach(function(b1, i) {
      if (used.has(b1.id)) return;
      var s1 = ((b1.stays&&b1.stays.length)?b1.stays:[b1])[0];
      if (!s1||!s1.propertyId||!s1.checkIn) return;
      var name1 = (b1.guestName||"").toLowerCase().trim();
      if (!name1) return;
      var ci1 = new Date(s1.checkIn+"T00:00:00");
      singles.forEach(function(b2, j) {
        if (j <= i) return;
        if (used.has(b1.id)||used.has(b2.id)) return;
        var s2 = ((b2.stays&&b2.stays.length)?b2.stays:[b2])[0];
        if (!s2||!s2.propertyId||!s2.checkIn) return;
        if (s2.propertyId === s1.propertyId) return;
        var name2 = (b2.guestName||"").toLowerCase().trim();
        if (!name2 || name2 !== name1) return;
        var ci2 = new Date(s2.checkIn+"T00:00:00");
        if (Math.abs((ci1-ci2)/86400000) > 7) return;
        pairs.push({ b1:b1, b2:b2, s1:s1, s2:s2 });
        used.add(b1.id); used.add(b2.id);
      });
    });
    return pairs;
  };

  const previewMerge = () => {
    var pairs = findMergePairs();
    setMergePreview(pairs);
  };

  const runMerge = async () => {
    if (!mergePreview || !mergePreview.length) return;
    setMergeStatus("Merging…");
    var removeIds = new Set();
    var newBookings = [];
    mergePreview.forEach(function(pair) {
      var b1 = pair.b1, b2 = pair.b2, s1 = pair.s1, s2 = pair.s2;
      var merged = Object.assign({}, b1, {
        guestName: b1.guestName || b2.guestName,
        value: (Number(b1.value)||0) + (Number(b2.value)||0),
        propertyIds: [s1.propertyId, s2.propertyId],
        stays: [
          Object.assign({}, s1, { value:0 }),
          Object.assign({}, s2, { value:0 }),
        ],
      });
      var sched1 = (b1.schedule||[]).map(function(sc){ return Object.assign({}, sc, { propertyId: sc.propertyId || s1.propertyId }); });
      var sched2 = (b2.schedule||[]).map(function(sc){ return Object.assign({}, sc, { propertyId: sc.propertyId || s2.propertyId }); });
      var combinedSched = sched1.concat(sched2);
      if (combinedSched.length) merged.schedule = combinedSched;
      newBookings.push(merged);
      removeIds.add(b1.id); removeIds.add(b2.id);
    });
    var updated = (bookings||[]).filter(function(b){ return !removeIds.has(b.id); }).concat(newBookings);
    await saveBookings(updated);
    setMergeStatus("Merged " + mergePreview.length + " pair" + (mergePreview.length===1?"":"s") + " — " + newBookings.length + " multi-property booking" + (newBookings.length===1?"":"s") + " created.");
    setMergePreview(null);
  };

  return (
    <div style={{ maxWidth:620, display:"flex", flexDirection:"column", gap:18 }}>
      <div style={{ border:`1px solid ${T.border}`, borderRadius:10, padding:"20px 22px", background:"#fff" }}>
        <div style={{ fontSize:15, fontWeight:700, color:T.text, marginBottom:6 }}>Import from Bookalet</div>
        <div style={{ fontSize:13, color:T.textMid, lineHeight:1.55, marginBottom:16 }}>
          Load the one-off seed file (guests + bookings exported from Bookalet). This overwrites the Lettings data in Supabase, so it is safe to re-run. Running read-only alongside Bookalet — nothing is sent to Airbnb or Stripe.
        </div>
        <input type="file" accept="application/json,.json" onChange={handleFile}
          style={{ fontSize:13, color:T.textMid }} />
        {status && <div style={{ marginTop:14, fontSize:13, fontWeight:600, color: status.startsWith("Import failed") ? T.red : T.green }}>{status}</div>}
      </div>

      {/* Multi-property merge tool */}
      <div style={{ border:`1px solid ${T.border}`, borderRadius:10, padding:"20px 22px", background:"#fff" }}>
        <div style={{ fontSize:15, fontWeight:700, color:T.text, marginBottom:4 }}>Merge Split Bookings</div>
        <div style={{ fontSize:13, color:T.textMid, lineHeight:1.55, marginBottom:14 }}>
          Finds pairs of single-property bookings with the same guest name and close dates — these should be one multi-property booking. Preview first before committing.
        </div>
        {!mergePreview && (
          <button onClick={previewMerge} style={{ background:"#fff", border:`1.5px solid ${T.border}`, color:T.text, fontFamily:"inherit", fontSize:13, fontWeight:600, padding:"9px 18px", borderRadius:8, cursor:"pointer" }}>Preview pairs</button>
        )}
        {mergePreview && mergePreview.length===0 && (
          <div style={{ fontSize:13, color:T.green, fontWeight:600 }}>No mergeable pairs found — all bookings look correct.</div>
        )}
        {mergePreview && mergePreview.length>0 && (
          <div>
            <div style={{ fontSize:13, fontWeight:600, color:T.text, marginBottom:10 }}>Found {mergePreview.length} pair{mergePreview.length===1?"":"s"} to merge:</div>
            {mergePreview.map(function(pair, i) {
              var b1=pair.b1, b2=pair.b2, s1=pair.s1, s2=pair.s2;
              return (
                <div key={i} style={{ background:T.bgInput, border:`1px solid ${T.border}`, borderRadius:7, padding:"10px 14px", marginBottom:8, fontSize:12, color:T.textMid }}>
                  <div style={{ fontWeight:700, color:T.text, marginBottom:4 }}>{b1.guestName || "(no name)"}</div>
                  <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
                    <span style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:5, padding:"3px 8px" }}>
                      {s1.propertyId} · {fmtDate(s1.checkIn)}–{fmtDate(s1.checkOut)} · {fmtMoney(Number(b1.value)||0)}
                    </span>
                    <span style={{ color:T.textLight, alignSelf:"center" }}>+</span>
                    <span style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:5, padding:"3px 8px" }}>
                      {s2.propertyId} · {fmtDate(s2.checkIn)}–{fmtDate(s2.checkOut)} · {fmtMoney(Number(b2.value)||0)}
                    </span>
                    <span style={{ color:T.green, fontWeight:700, alignSelf:"center" }}>= {fmtMoney((Number(b1.value)||0)+(Number(b2.value)||0))}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ display:"flex", gap:10, marginTop:14 }}>
              <button onClick={runMerge} style={{ background:T.accent, color:"#fff", border:"none", fontFamily:"inherit", fontSize:13, fontWeight:700, padding:"9px 20px", borderRadius:8, cursor:"pointer" }}>Merge {mergePreview.length} pair{mergePreview.length===1?"":"s"}</button>
              <button onClick={()=>setMergePreview(null)} style={{ background:"#fff", border:`1.5px solid ${T.border}`, color:T.textMid, fontFamily:"inherit", fontSize:13, fontWeight:600, padding:"9px 16px", borderRadius:8, cursor:"pointer" }}>Cancel</button>
            </div>
          </div>
        )}
        {mergeStatus && <div style={{ marginTop:12, fontSize:13, fontWeight:600, color:T.green }}>{mergeStatus}</div>}
      </div>
    </div>
  );
}

// ── Lettings Revenue Report ───────────────────────────────────────────────────
function AccomReport({ properties, bookings }) {
  const allYears = [...new Set(
    bookings.flatMap(b => {
      const stays = (b.stays && b.stays.length) ? b.stays : [b];
      return stays.map(s => s.checkIn ? s.checkIn.slice(0,4) : null).filter(Boolean);
    })
  )].sort();
  const currentYear = new Date().getFullYear().toString();
  const [year, setYear] = useState(allYears.includes(currentYear) ? currentYear : (allYears[allYears.length-1]||currentYear));

  const propName = (id) => (properties.find(p=>p.id===id)||{}).name || id;

  // Filter to bookings with at least one stay in the selected year, not cancelled
  const yearBookings = bookings.filter(b => {
    if (b.status==="cancelled") return false;
    const stays = (b.stays && b.stays.length) ? b.stays : [b];
    return stays.some(s => s.checkIn && s.checkIn.startsWith(year));
  });

  // Revenue by source category
  const direct   = yearBookings.filter(b => b.source!=="airbnb" && !b.estimated && Number(b.value)>0);
  const airbnbEst = yearBookings.filter(b => b.source==="airbnb" && Number(b.value)>0);
  const wedding  = yearBookings.filter(b => b.bookingType==="Wedding" && Number(b.value)>0);

  const sumVal = (arr) => arr.reduce((s,b) => s + (Number(b.value)||0), 0);

  // Revenue by property (across all sources)
  const byProp = {};
  properties.forEach(p => { byProp[p.id] = { direct:0, airbnb:0, wedding:0, total:0 }; });
  yearBookings.forEach(b => {
    const val = Number(b.value)||0;
    if (val<=0) return;
    const stays = (b.stays && b.stays.length) ? b.stays : [b];
    // Distribute value equally across stays of this booking (simple split)
    const perStay = val / stays.length;
    stays.forEach(s => {
      if (!s.checkIn || !s.checkIn.startsWith(year)) return;
      if (!byProp[s.propertyId]) byProp[s.propertyId] = { direct:0, airbnb:0, wedding:0, total:0 };
      const bucket = b.source==="airbnb" ? "airbnb" : b.bookingType==="Wedding" ? "wedding" : "direct";
      byProp[s.propertyId][bucket] = (byProp[s.propertyId][bucket]||0) + perStay;
      byProp[s.propertyId].total   = (byProp[s.propertyId].total||0)   + perStay;
    });
  });

  const totalAll = sumVal(direct) + sumVal(airbnbEst) + sumVal(wedding);

  const prevYear = allYears[allYears.indexOf(year)-1];
  const nextYear = allYears[allYears.indexOf(year)+1];

  const srcRow = (label, arr, colour) => {
    const val = sumVal(arr);
    return (
      <div key={label} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
        <span style={{ width:160, color:T.textMid, fontSize:13 }}>{label}</span>
        <div style={{ flex:1, background:"#f0f6ff", borderRadius:4, height:24, overflow:"hidden" }}>
          <div style={{ width:totalAll>0?`${Math.min(100,(val/totalAll)*100)}%`:"0%", minWidth:val>0?40:0, height:"100%",
            background:colour, borderRadius:4, display:"flex", alignItems:"center", paddingLeft:8 }}>
            {val>0 && <span style={{ color:"#fff", fontSize:11, fontWeight:700 }}>{fmtMoney(val)}</span>}
          </div>
        </div>
        <span style={{ fontSize:13, fontWeight:600, color:T.text, minWidth:80, textAlign:"right" }}>{fmtMoney(val)}</span>
        <span style={{ fontSize:12, color:T.textLight, minWidth:40, textAlign:"right" }}>{arr.length} bkg{arr.length===1?"":"s"}</span>
      </div>
    );
  };

  return (
    <div>
      {/* Year navigator */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:22 }}>
        <button onClick={()=>setYear(prevYear)} disabled={!prevYear} style={{ ...navBtn, opacity:prevYear?1:.4 }}>&#8249;</button>
        <div style={{ display:"flex", gap:6 }}>
          {allYears.map(y=>(
            <button key={y} onClick={()=>setYear(y)} style={{ background:y===year?T.midBlue:"#fff", color:y===year?"#fff":T.textMid, border:`1.5px solid ${y===year?T.midBlue:T.border}`, padding:"6px 16px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:y===year?700:400 }}>{y}</button>
          ))}
        </div>
        <button onClick={()=>setYear(nextYear)} disabled={!nextYear} style={{ ...navBtn, opacity:nextYear?1:.4 }}>&#8250;</button>
      </div>

      {/* Summary cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14, marginBottom:24 }}>
        <StatCard label="Direct / Manual" value={fmtMoney(sumVal(direct))} sub={`${direct.length} bookings`}/>
        <StatCard label="Airbnb (estimated)" value={fmtMoney(sumVal(airbnbEst))} sub={`${airbnbEst.length} blocks — estimate only`}/>
        <StatCard label="Wedding-linked" value={fmtMoney(sumVal(wedding))} sub={`${wedding.length} bookings`}/>
      </div>

      {/* Revenue by source bar chart */}
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"20px 22px", marginBottom:20, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:15 }}>Revenue by source — {year}</h3>
        {srcRow("Direct / Manual", direct, T.accent)}
        {srcRow("Airbnb (est.)", airbnbEst, T.amber)}
        {srcRow("Wedding-linked", wedding, T.green)}
        <div style={{ borderTop:`1px solid ${T.border}`, marginTop:12, paddingTop:10, display:"flex", justifyContent:"flex-end", fontSize:14, fontWeight:700, color:T.midBlue }}>
          Total: {fmtMoney(totalAll)}
        </div>
      </div>

      {/* Revenue by property */}
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"20px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:15 }}>Revenue by property — {year}</h3>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead>
              <tr style={{ background:T.bgInput }}>
                {["Property","Direct","Airbnb est.","Wedding","Total"].map(h=>(
                  <th key={h} style={{ padding:"9px 12px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1, textTransform:"uppercase", fontWeight:700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {properties.map((p,i) => {
                const d = byProp[p.id] || { direct:0, airbnb:0, wedding:0, total:0 };
                return (
                  <tr key={p.id} style={{ borderTop:`1px solid ${T.border}` }}>
                    <td style={{ padding:"10px 12px", fontWeight:600 }}>
                      <span style={{ display:"inline-block", width:10, height:10, borderRadius:2, background:p.colour, marginRight:6, verticalAlign:"middle" }}/>
                      {p.name}
                    </td>
                    <td style={{ padding:"10px 12px", color:d.direct>0?T.text:T.textLight }}>{d.direct>0?fmtMoney(Math.round(d.direct)):"—"}</td>
                    <td style={{ padding:"10px 12px", color:d.airbnb>0?T.amber:T.textLight }}>{d.airbnb>0?fmtMoney(Math.round(d.airbnb))+" *":"—"}</td>
                    <td style={{ padding:"10px 12px", color:d.wedding>0?T.green:T.textLight }}>{d.wedding>0?fmtMoney(Math.round(d.wedding)):"—"}</td>
                    <td style={{ padding:"10px 12px", fontWeight:700, color:T.midBlue }}>{d.total>0?fmtMoney(Math.round(d.total)):"—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop:10, fontSize:11, color:T.textLight }}>* Airbnb figures are estimates based on stored booking values. Pricing rules applied when baseRate is configured.</div>
      </div>
    </div>
  );
}

// ── Property settings editor ─────────────────────────────────────────────────
// Weekday toggle row — used for allowed check-in / check-out days, at property
// level and as an optional per-season override. Days are stored as an array of
// 0=Mon..6=Sun indices; empty/undefined array means "no restriction, any day".
const DOW_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
function DayToggles({ label, hint, value, onChange, compact }) {
  const days = value || [];
  const toggle = (i) => {
    const next = days.includes(i) ? days.filter(d => d !== i) : days.concat([i]).sort();
    onChange(next);
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:compact?3:4 }}>
      {label && <span style={{ fontSize:compact?10:11, color:T.textMid, fontWeight:600 }}>{label}</span>}
      <div style={{ display:"flex", gap:4 }}>
        {DOW_SHORT.map((d,i) => {
          const on = days.includes(i);
          return (
            <button key={i} type="button" onClick={()=>toggle(i)}
              title={d}
              style={{ width:compact?24:28, height:compact?24:28, borderRadius:6, border:`1.5px solid ${on?T.accent:T.border}`,
                background: on ? T.accent : "#fff", color: on ? "#fff" : T.textMid, fontSize:compact?10:11, fontWeight:700,
                cursor:"pointer", fontFamily:"inherit", padding:0 }}>
              {d[0]}
            </button>
          );
        })}
      </div>
      {hint && <span style={{ fontSize:10, color:T.textLight }}>{days.length ? hint : "No restriction — any day allowed"}</span>}
    </div>
  );
}

function PropertyEditor({ properties, setProperties, onSave }) {
  const [openId, setOpenId] = useState(null);
  const [flash,  setFlash]  = useState("");

  const updProp = (pid, key, val) =>
    setProperties(ps => ps.map(p => p.id === pid ? Object.assign({}, p, { [key]: val }) : p));

  const addSeason = (pid) =>
    setProperties(ps => ps.map(p =>
      p.id !== pid ? p : Object.assign({}, p, {
        seasons: p.seasons.concat([{ label:"", startDate:"", endDate:"", ratePerNight:0 }])
      })
    ));

  const updSeason = (pid, si, key, val) =>
    setProperties(ps => ps.map(p =>
      p.id !== pid ? p : Object.assign({}, p, {
        seasons: p.seasons.map((s, idx) => idx === si ? Object.assign({}, s, { [key]: val }) : s)
      })
    ));

  const rmSeason = (pid, si) =>
    setProperties(ps => ps.map(p =>
      p.id !== pid ? p : Object.assign({}, p, {
        seasons: p.seasons.filter((_, idx) => idx !== si)
      })
    ));

  const handleSave = async () => {
    await onSave();
    setFlash("Saved");
    setTimeout(() => setFlash(""), 2500);
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Property settings</div>
          <div style={{ fontSize:12, color:T.textMid, marginTop:2 }}>Pricing, seasons, booking rules — used by the public booking page</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {flash && <span style={{ fontSize:12, color:T.green, fontWeight:600 }}>{flash}</span>}
          <button onClick={handleSave} style={{ background:T.accent, color:"#fff", border:"none", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Save all</button>
        </div>
      </div>

      {properties.map(p => {
        const open = openId === p.id;
        return (
          <div key={p.id} style={{ border:`1px solid ${T.border}`, borderRadius:10, marginBottom:12, overflow:"hidden", boxShadow:"0 2px 6px rgba(37,99,235,.05)" }}>
            <div onClick={() => setOpenId(open ? null : p.id)}
              style={{ display:"flex", alignItems:"center", gap:10, padding:"13px 16px", background:T.bgInput, cursor:"pointer", userSelect:"none" }}>
              <span style={{ width:13, height:13, borderRadius:3, background:p.colour, flexShrink:0 }}/>
              <span style={{ fontSize:14, fontWeight:700, color:T.text, flex:1 }}>{p.name}</span>
              <span style={{ fontSize:12, color:T.textMid }}>
                {p.baseRate ? "Base: " + String(fmtMoney(p.baseRate)) + "/night" : "No base rate"} ·{" "}
                {p.seasons && p.seasons.length ? p.seasons.length + " season" + (p.seasons.length > 1 ? "s" : "") : "No seasons"}
              </span>
              <span style={{ fontSize:11, color:T.textLight, marginLeft:8 }}>{open ? "▲" : "▼"}</span>
            </div>

            {open && (
              <div style={{ padding:"18px 18px 20px" }}>

                {/* ── Pricing ── */}
                <div style={{ fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.5, marginBottom:10 }}>Pricing</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:18 }}>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Base rate (£/night)</span>
                    <input type="number" value={p.baseRate || ""} onChange={e => updProp(p.id, "baseRate", Number(e.target.value))} style={inpStyle} placeholder="e.g. 250" min="0" />
                  </label>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Long-stay from (nights)</span>
                    <input type="number" value={p.longStayThreshold || ""} onChange={e => updProp(p.id, "longStayThreshold", Number(e.target.value))} style={inpStyle} placeholder="e.g. 7" min="0" />
                  </label>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Long-stay discount (£/night)</span>
                    <input type="number" value={p.longStayDiscount || ""} onChange={e => updProp(p.id, "longStayDiscount", Number(e.target.value))} style={inpStyle} placeholder="e.g. 30" min="0" />
                  </label>
                </div>

                {/* ── Seasons ── */}
                <div style={{ fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.5, marginBottom:8 }}>Seasons (override base rate for date ranges)</div>
                {p.seasons && p.seasons.map((s, si) => (
                  <div key={si} style={{ marginBottom:12, paddingBottom:12, borderBottom: si < p.seasons.length-1 ? `1px dashed ${T.border}` : "none" }}>
                    <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr auto", gap:8, alignItems:"end" }}>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        {si === 0 && <span style={{ fontSize:10, color:T.textLight, fontWeight:600 }}>Label</span>}
                        <input value={s.label || ""} onChange={e => updSeason(p.id, si, "label", e.target.value)} style={inpStyle} placeholder="e.g. Peak summer" />
                      </label>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        {si === 0 && <span style={{ fontSize:10, color:T.textLight, fontWeight:600 }}>From</span>}
                        <input type="date" value={s.startDate || ""} onChange={e => updSeason(p.id, si, "startDate", e.target.value)} style={inpStyle} />
                      </label>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        {si === 0 && <span style={{ fontSize:10, color:T.textLight, fontWeight:600 }}>To (exclusive)</span>}
                        <input type="date" value={s.endDate || ""} onChange={e => updSeason(p.id, si, "endDate", e.target.value)} style={inpStyle} />
                      </label>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        {si === 0 && <span style={{ fontSize:10, color:T.textLight, fontWeight:600 }}>£/night</span>}
                        <input type="number" value={s.ratePerNight || ""} onChange={e => updSeason(p.id, si, "ratePerNight", Number(e.target.value))} style={inpStyle} placeholder="0" min="0" />
                      </label>
                      <button onClick={() => rmSeason(p.id, si)}
                        style={{ background:T.redBg, color:T.red, border:"1px solid #fca5a5", borderRadius:6, padding:"0 12px", cursor:"pointer", fontFamily:"inherit", fontSize:12, height:36, alignSelf:"end" }}>
                        Remove
                      </button>
                    </div>
                    <div style={{ display:"flex", gap:24, marginTop:8, paddingLeft:2 }}>
                      <DayToggles compact label="Check-in days override" value={s.checkInDays}
                        onChange={(v)=>updSeason(p.id, si, "checkInDays", v)} />
                      <DayToggles compact label="Check-out days override" value={s.checkOutDays}
                        onChange={(v)=>updSeason(p.id, si, "checkOutDays", v)} />
                    </div>
                  </div>
                ))}
                <button onClick={() => addSeason(p.id)}
                  style={{ background:"none", border:`1.5px dashed ${T.border}`, color:T.accent, borderRadius:7, padding:"6px 16px", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600, marginBottom:20 }}>
                  + Add season
                </button>

                {/* ── Booking rules ── */}
                <div style={{ fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.5, marginBottom:10 }}>Booking rules</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:16 }}>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Min nights</span>
                    <input type="number" value={p.minNights || ""} onChange={e => updProp(p.id, "minNights", Number(e.target.value))} style={inpStyle} min="1" />
                  </label>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Max nights</span>
                    <input type="number" value={p.maxNights || ""} onChange={e => updProp(p.id, "maxNights", Number(e.target.value))} style={inpStyle} min="1" />
                  </label>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Booking window (months ahead)</span>
                    <input type="number" value={p.bookingHorizonMonths || ""} onChange={e => updProp(p.id, "bookingHorizonMonths", Number(e.target.value))} style={inpStyle} placeholder="e.g. 6 — blank = no limit" min="0" />
                  </label>
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20, marginBottom:18, padding:"12px 14px", background:T.bgInput, borderRadius:8, border:`1px solid ${T.border}` }}>
                  <DayToggles label="Allowed check-in days" hint="Only these days can be selected as an arrival day on the public calendar"
                    value={p.checkInDays} onChange={(v)=>updProp(p.id, "checkInDays", v)} />
                  <DayToggles label="Allowed check-out days" hint="Stay lengths that would land checkout on another day are hidden"
                    value={p.checkOutDays} onChange={(v)=>updProp(p.id, "checkOutDays", v)} />
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:6 }}>
                  <div style={{ background:T.accentLight, borderRadius:8, padding:"10px 14px" }}>
                    <div style={{ fontSize:10, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.4, marginBottom:8 }}>General bookings</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Check-in from</span>
                        <input value={p.checkInFrom || ""} onChange={e => updProp(p.id, "checkInFrom", e.target.value)} style={inpStyle} placeholder="16:00" />
                      </label>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Check-out by</span>
                        <input value={p.checkOutBy || ""} onChange={e => updProp(p.id, "checkOutBy", e.target.value)} style={inpStyle} placeholder="10:00" />
                      </label>
                    </div>
                  </div>
                  <div style={{ background:"#fef3c7", borderRadius:8, padding:"10px 14px" }}>
                    <div style={{ fontSize:10, fontWeight:700, color:"#92400e", textTransform:"uppercase", letterSpacing:.4, marginBottom:8 }}>Weekend weddings</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Check-in from</span>
                        <input value={p.checkInFromWedding || ""} onChange={e => updProp(p.id, "checkInFromWedding", e.target.value)} style={inpStyle} placeholder="14:00" />
                      </label>
                      <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                        <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Check-out by</span>
                        <input value={p.checkOutByWedding || ""} onChange={e => updProp(p.id, "checkOutByWedding", e.target.value)} style={inpStyle} placeholder="11:00" />
                      </label>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize:11, color:T.textLight, marginBottom:18 }}>{"Email tokens {{checkInTime}} and {{checkOutTime}} resolve to these times based on booking type."}</div>

                {/* ── Payment ── */}
                <div style={{ fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.5, marginBottom:10 }}>Payment</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Deposit %</span>
                    <input type="number" value={p.depositPct || ""} onChange={e => updProp(p.id, "depositPct", Number(e.target.value))} style={inpStyle} min="0" max="100" />
                  </label>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Balance due (weeks before check-in)</span>
                    <input type="number" value={p.balanceWeeks || ""} onChange={e => updProp(p.id, "balanceWeeks", Number(e.target.value))} style={inpStyle} min="0" />
                  </label>
                  <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Breakage deposit (£)</span>
                    <input type="number" value={p.breakageDefault || ""} onChange={e => updProp(p.id, "breakageDefault", Number(e.target.value))} style={inpStyle} min="0" />
                  </label>
                </div>

              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Discount codes editor ────────────────────────────────────────────────────
function DiscountCodesEditor({ codes, setCodes, onSave }) {
  const [flash, setFlash] = useState("");
  const [newCode, setNewCode] = useState({ code:"", type:"pct", value:"", description:"", expiresAt:"" });

  const updNew = (k, v) => setNewCode(c => Object.assign({}, c, { [k]: v }));

  const addCode = () => {
    if (!newCode.code.trim() || !newCode.value) return;
    const rec = {
      id:          "dc-" + Date.now(),
      code:        newCode.code.trim().toUpperCase(),
      type:        newCode.type,
      value:       Number(newCode.value),
      description: newCode.description.trim(),
      active:      true,
      expiresAt:   newCode.expiresAt || null,
    };
    setCodes(cs => cs.concat([rec]));
    setNewCode({ code:"", type:"pct", value:"", description:"", expiresAt:"" });
  };

  const toggleActive = (id) =>
    setCodes(cs => cs.map(c => c.id === id ? Object.assign({}, c, { active: !c.active }) : c));

  const removeCode = (id) => setCodes(cs => cs.filter(c => c.id !== id));

  const handleSave = async () => {
    await onSave();
    setFlash("Saved");
    setTimeout(() => setFlash(""), 2000);
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Discount codes</div>
          <div style={{ fontSize:12, color:T.textMid, marginTop:2 }}>Applied at booking — fixed £ off or percentage off the total</div>
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          {flash && <span style={{ fontSize:12, color:T.green, fontWeight:600 }}>{flash}</span>}
          <button onClick={handleSave} style={{ background:T.accent, color:"#fff", border:"none", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Save</button>
        </div>
      </div>

      {/* Existing codes */}
      {codes.length > 0 && (
        <div style={{ border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", background:"#fff", marginBottom:18 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1.2fr 0.8fr 0.8fr 1.5fr 1fr 0.7fr 0.6fr", background:T.bgInput, borderBottom:`1px solid ${T.border}`, fontSize:11, fontWeight:700, color:T.textMid }}>
            {["Code","Type","Value","Description","Expires","Active",""].map(h => (
              <div key={h} style={{ padding:"9px 12px" }}>{h}</div>
            ))}
          </div>
          {codes.map(c => (
            <div key={c.id} style={{ display:"grid", gridTemplateColumns:"1.2fr 0.8fr 0.8fr 1.5fr 1fr 0.7fr 0.6fr", borderBottom:`1px solid #eef3fa`, fontSize:13, color:T.text, alignItems:"center", opacity: c.active ? 1 : .55 }}>
              <div style={{ padding:"10px 12px", fontWeight:700, letterSpacing:.5, color:T.midBlue }}>{c.code}</div>
              <div style={{ padding:"10px 12px" }}>{c.type === "pct" ? "% off" : "£ off"}</div>
              <div style={{ padding:"10px 12px" }}>{c.type === "pct" ? c.value + "%" : fmtMoney(c.value)}</div>
              <div style={{ padding:"10px 12px", fontSize:12, color:T.textMid }}>{c.description || "—"}</div>
              <div style={{ padding:"10px 12px", fontSize:12 }}>{c.expiresAt ? fmtDate(c.expiresAt) : "No expiry"}</div>
              <div style={{ padding:"10px 12px" }}>
                <button onClick={() => toggleActive(c.id)}
                  style={{ fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit",
                    background: c.active ? T.greenBg : T.redBg, color: c.active ? T.green : T.red }}>
                  {c.active ? "Active" : "Off"}
                </button>
              </div>
              <div style={{ padding:"10px 12px" }}>
                <button onClick={() => removeCode(c.id)}
                  style={{ fontSize:11, color:T.red, background:T.redBg, border:"none", borderRadius:6, padding:"3px 10px", cursor:"pointer", fontFamily:"inherit" }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new code */}
      <div style={{ border:`1px solid ${T.border}`, borderRadius:10, padding:"16px 18px", background:"#fff" }}>
        <div style={{ fontSize:12, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.4, marginBottom:12 }}>Add new code</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 0.7fr 0.7fr 1.5fr 1fr auto", gap:10, alignItems:"end" }}>
          <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
            <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Code</span>
            <input value={newCode.code} onChange={e => updNew("code", e.target.value.toUpperCase())}
              style={inpStyle} placeholder="e.g. SUMMER10" />
          </label>
          <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
            <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Type</span>
            <select value={newCode.type} onChange={e => updNew("type", e.target.value)} style={{ ...inpStyle }}>
              <option value="pct">% off</option>
              <option value="fixed">£ off</option>
            </select>
          </label>
          <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
            <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>{newCode.type === "pct" ? "%" : "£"} value</span>
            <input type="number" value={newCode.value} onChange={e => updNew("value", e.target.value)}
              style={inpStyle} placeholder={newCode.type === "pct" ? "10" : "50"} min="0" />
          </label>
          <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
            <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Description (optional)</span>
            <input value={newCode.description} onChange={e => updNew("description", e.target.value)}
              style={inpStyle} placeholder="e.g. Summer 2026 discount" />
          </label>
          <label style={{ display:"flex", flexDirection:"column", gap:4 }}>
            <span style={{ fontSize:11, color:T.textMid, fontWeight:600 }}>Expires (optional)</span>
            <input type="date" value={newCode.expiresAt} onChange={e => updNew("expiresAt", e.target.value)}
              style={inpStyle} />
          </label>
          <button onClick={addCode}
            style={{ background:T.accent, color:"#fff", border:"none", borderRadius:8, padding:"9px 18px", cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700, height:38, alignSelf:"end" }}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ── iCal / Airbnb sync settings ───────────────────────────────────────────────
function ICalSettings({ properties, setProperties, onSave }) {
  const [syncState, setSyncState] = useState({});
  const [flash, setFlash] = useState("");

  const updProp = (pid, key, val) =>
    setProperties(ps => ps.map(p => p.id === pid ? Object.assign({}, p, { [key]: val }) : p));

  const handleSave = async () => {
    await onSave();
    setFlash("Saved");
    setTimeout(() => setFlash(""), 2000);
  };

  const syncNow = async (pid) => {
    setSyncState(s => Object.assign({}, s, { [pid]: { loading: true, result: null } }));
    try {
      const res = await fetch("/.netlify/functions/sync-property-ical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId: pid })
      });
      const data = await res.json();
      if (data.error) {
        setSyncState(s => Object.assign({}, s, { [pid]: { loading: false, result: "Error: " + data.error } }));
      } else {
        const msg = "Synced — " + data.imported + " new block" + (data.imported === 1 ? "" : "s") + " from " + data.total + " in feed";
        setSyncState(s => Object.assign({}, s, { [pid]: { loading: false, result: msg } }));
        // Update lastSyncedAt in local property state
        setProperties(ps => ps.map(p => p.id === pid ? Object.assign({}, p, { lastSyncedAt: new Date().toISOString() }) : p));
      }
    } catch (e) {
      setSyncState(s => Object.assign({}, s, { [pid]: { loading: false, result: "Network error — check console" } }));
    }
  };

  const copyUrl = (url) => {
    if (navigator.clipboard) navigator.clipboard.writeText(url);
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Airbnb / iCal sync</div>
          <div style={{ fontSize:12, color:T.textMid, marginTop:2 }}>Export your availability to Airbnb; import Airbnb blocks back in</div>
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          {flash && <span style={{ fontSize:12, color:T.green, fontWeight:600 }}>{flash}</span>}
          <button onClick={handleSave} style={{ background:T.accent, color:"#fff", border:"none", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Save URLs</button>
        </div>
      </div>
      <div style={{ fontSize:12, color:T.textMid, background:T.accentLight, borderRadius:8, padding:"10px 14px", marginBottom:20, lineHeight:1.6 }}>
        <strong>Setup:</strong> For each property, (1) copy the Export URL and paste it into Airbnb as your availability calendar URL,
        then (2) paste Airbnb's iCal import URL here and click Sync. Airbnb's URL is found in your Airbnb listing under Calendar settings.
      </div>

      {properties.map(p => {
        const exportUrl = SITE_URL + "/.netlify/functions/property-calendar?id=" + p.id;
        const ss = syncState[p.id] || {};
        return (
          <div key={p.id} style={{ border:`1px solid ${T.border}`, borderRadius:10, padding:"18px 20px", marginBottom:14, background:"#fff", boxShadow:"0 2px 6px rgba(37,99,235,.04)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <span style={{ width:13, height:13, borderRadius:3, background:p.colour, flexShrink:0 }}/>
              <span style={{ fontSize:14, fontWeight:700, color:T.text }}>{p.name}</span>
              {p.lastSyncedAt && (
                <span style={{ fontSize:11, color:T.textLight, marginLeft:"auto" }}>
                  Last synced: {new Date(p.lastSyncedAt).toLocaleString("en-GB", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}
                </span>
              )}
            </div>

            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11, fontWeight:600, color:T.textMid, marginBottom:6, textTransform:"uppercase", letterSpacing:.4 }}>
                1. Export URL — paste this into Airbnb
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <input readOnly value={exportUrl} style={{ ...inpStyle, flex:1, fontSize:11, background:"#f7f9fc", color:T.textMid }} />
                <button onClick={() => copyUrl(exportUrl)}
                  style={{ background:T.accentLight, color:T.accent, border:`1.5px solid ${T.accent}30`, borderRadius:7, padding:"8px 16px", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700, whiteSpace:"nowrap" }}>
                  Copy
                </button>
              </div>
            </div>

            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, fontWeight:600, color:T.textMid, marginBottom:6, textTransform:"uppercase", letterSpacing:.4 }}>
                2. Import URL — from Airbnb
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <input value={p.airbnbImportUrl || ""}
                  onChange={e => updProp(p.id, "airbnbImportUrl", e.target.value)}
                  style={{ ...inpStyle, flex:1, fontSize:12 }}
                  placeholder="https://www.airbnb.co.uk/calendar/ical/..." />
                <button onClick={() => syncNow(p.id)} disabled={!p.airbnbImportUrl || ss.loading}
                  style={{ background: ss.loading ? T.bgInput : T.green, color: ss.loading ? T.textLight : "#fff", border:"none", borderRadius:7, padding:"8px 16px", cursor: p.airbnbImportUrl && !ss.loading ? "pointer" : "not-allowed", fontFamily:"inherit", fontSize:12, fontWeight:700, whiteSpace:"nowrap" }}>
                  {ss.loading ? "Syncing…" : "Sync now"}
                </button>
              </div>
              {ss.result && (
                <div style={{ marginTop:6, fontSize:12, color: ss.result.startsWith("Error") ? T.red : T.green, fontWeight:600 }}>
                  {ss.result}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Email Templates Editor ────────────────────────────────────────────────────
function EmailTemplatesEditor({ templates, setTemplates, onSave }) {
  const [sel, setSel] = useState(0);
  const [flash, setFlash] = useState("");
  const [copying, setCopying] = useState(null);
  const fileRef = useRef(null);

  const upd = function(key, val) {
    setTemplates(function(ts) {
      return ts.map(function(t, i) { return i === sel ? Object.assign({}, t, { [key]: val }) : t; });
    });
  };

  const handleSave = async function() {
    await onSave();
    setFlash("Saved");
    setTimeout(function() { setFlash(""); }, 2000);
  };

  const handleFile = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert("File is over 2 MB — please compress it before attaching.");
      e.target.value = "";
      return;
    }
    var reader = new FileReader();
    reader.onload = function(ev) {
      var att = { name: file.name, size: file.size, type: file.type, dataUrl: ev.target.result };
      var curr = templates[sel];
      upd("attachments", (curr.attachments || []).concat([att]));
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const removeAtt = function(idx) {
    upd("attachments", (templates[sel].attachments || []).filter(function(_, i) { return i !== idx; }));
  };

  const copyToken = function(token, idx) {
    if (navigator.clipboard) navigator.clipboard.writeText(token);
    setCopying(idx);
    setTimeout(function() { setCopying(null); }, 1200);
  };

  var tmpl = templates[sel] || {};
  var TEMPLATE_NAMES = templates.map(function(t) { return t.name; });

  const taStyle = {
    width:"100%", boxSizing:"border-box", fontFamily:"monospace", fontSize:13, lineHeight:1.65,
    border:`1.5px solid ${T.border}`, borderRadius:8, padding:"12px 14px", resize:"vertical",
    color:T.text, background:"#fafbff", minHeight:260, outline:"none"
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700, color:T.text }}>Email templates</div>
          <div style={{ fontSize:12, color:T.textMid, marginTop:3 }}>Edit subject and body for each email type. Use tokens (click to copy) where guest/booking details should appear.</div>
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center", flexShrink:0, marginLeft:16 }}>
          {flash && <span style={{ fontSize:12, color:T.green, fontWeight:600 }}>{flash}</span>}
          <button onClick={handleSave} style={{ background:T.accent, color:"#fff", border:"none", padding:"9px 20px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Save templates</button>
        </div>
      </div>

      <div style={{ display:"flex", gap:14 }}>
        {/* Left: template list */}
        <div style={{ width:190, flexShrink:0 }}>
          {TEMPLATE_NAMES.map(function(name, i) {
            return (
              <button key={i} onClick={function() { setSel(i); }}
                style={{ display:"block", width:"100%", textAlign:"left", background: sel===i ? T.accentLight : "transparent",
                  border: `1.5px solid ${sel===i ? T.accent : T.border}`, borderRadius:8, padding:"9px 12px", marginBottom:6,
                  cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight: sel===i ? 700 : 500,
                  color: sel===i ? T.accent : T.text }}>
                {name}
                {templates[i].triggerDays !== null && (
                  <div style={{ fontSize:10, color:T.textLight, marginTop:2, fontWeight:400 }}>{templates[i].triggerLabel}</div>
                )}
              </button>
            );
          })}
        </div>

        {/* Right: editor */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"20px 22px" }}>
            {/* Trigger days row (for timed templates) */}
            {tmpl.triggerDays !== null && (
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16, padding:"10px 14px", background:T.accentLight, borderRadius:8, border:`1px solid ${T.accent}30` }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:12, color:T.textMid, fontWeight:600 }}>{tmpl.triggerLabel}:</span>
                  <input type="number" min="0" max="365" value={tmpl.triggerDays || 0}
                    onChange={function(e) { upd("triggerDays", parseInt(e.target.value) || 0); }}
                    style={{ width:60, border:`1.5px solid ${T.border}`, borderRadius:6, padding:"5px 8px", fontFamily:"inherit", fontSize:13, textAlign:"center" }} />
                  <span style={{ fontSize:12, color:T.textLight }}>days before (set to 0 to disable)</span>
                </div>
                {tmpl.triggerDays2 !== undefined && (
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:12, color:T.textMid, fontWeight:600 }}>{tmpl.triggerLabel2 || "2nd reminder"}:</span>
                    <input type="number" min="0" max="365" value={tmpl.triggerDays2 || 0}
                      onChange={function(e) { upd("triggerDays2", parseInt(e.target.value) || 0); }}
                      style={{ width:60, border:`1.5px solid ${T.border}`, borderRadius:6, padding:"5px 8px", fontFamily:"inherit", fontSize:13, textAlign:"center" }} />
                    <span style={{ fontSize:12, color:T.textLight }}>days before (set to 0 to disable)</span>
                  </div>
                )}
              </div>
            )}

            {/* Subject */}
            <div style={{ marginBottom:14 }}>
              <label style={{ display:"block", fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.4, marginBottom:5 }}>Subject</label>
              <input value={tmpl.subject || ""} onChange={function(e) { upd("subject", e.target.value); }}
                style={{ ...inpStyle, width:"100%", boxSizing:"border-box", fontSize:13 }} />
            </div>

            {/* Body */}
            <div style={{ marginBottom:16 }}>
              <label style={{ display:"block", fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.4, marginBottom:5 }}>Body</label>
              <textarea value={tmpl.body || ""} onChange={function(e) { upd("body", e.target.value); }} style={taStyle} />
            </div>

            {/* Tokens reference */}
            <div style={{ marginBottom:18 }}>
              <div style={{ fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.4, marginBottom:7 }}>Available tokens — click to copy</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                {EMAIL_TOKENS.map(function(token, i) {
                  return (
                    <button key={token} onClick={function() { copyToken(token, i); }}
                      style={{ background: copying===i ? T.green : T.bgInput, color: copying===i ? "#fff" : T.textMid,
                        border:`1px solid ${T.border}`, borderRadius:5, padding:"3px 8px", cursor:"pointer",
                        fontFamily:"monospace", fontSize:11, transition:"background .15s" }}>
                      {copying===i ? "Copied!" : token}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Attachments */}
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:.4, marginBottom:7 }}>Attachments (max 2 MB each)</div>
              {(tmpl.attachments || []).length === 0 && (
                <div style={{ fontSize:12, color:T.textLight, marginBottom:8 }}>No files attached to this template.</div>
              )}
              {(tmpl.attachments || []).map(function(att, i) {
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 10px", background:T.bgInput, borderRadius:7, marginBottom:5, border:`1px solid ${T.border}` }}>
                    <span style={{ fontSize:12, color:T.text, flex:1, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>{att.name}</span>
                    <span style={{ fontSize:11, color:T.textLight, flexShrink:0 }}>{Math.round(att.size/1024)} KB</span>
                    <button onClick={function() { removeAtt(i); }}
                      style={{ background:"none", border:"none", color:T.red, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700, padding:"0 4px" }}>
                      Remove
                    </button>
                  </div>
                );
              })}
              <input ref={fileRef} type="file" onChange={handleFile} style={{ display:"none" }} />
              <button onClick={function() { if (fileRef.current) fileRef.current.click(); }}
                style={{ background:T.bgInput, border:`1.5px solid ${T.border}`, borderRadius:7, padding:"8px 16px", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600, color:T.text, marginTop:4 }}>
                + Attach file
              </button>
              <div style={{ fontSize:11, color:T.textLight, marginTop:5 }}>
                Files are stored with the template. For large files (brochures, maps) consider linking to a URL in the body instead.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Setup wrapper (sub-tabs: Pricing | Discount Codes | Airbnb Sync) ──────────
function LettingsSetup({ properties, setProperties, onSaveProperties, discountCodes, setDiscountCodes, onSaveDiscountCodes, emailTemplates, setEmailTemplates, onSaveEmailTemplates }) {
  const [setupTab, setSetupTab] = useState("pricing");
  const tabs = [["pricing","Pricing & Rules"],["codes","Discount Codes"],["ical","Airbnb Sync"],["emails","Email Templates"]];
  return (
    <div>
      <div style={{ display:"flex", gap:2, marginBottom:22, borderBottom:`1px solid ${T.border}` }}>
        {tabs.map(function([id, label]) {
          return (
            <button key={id} onClick={function() { setSetupTab(id); }}
              style={{ background:"none", border:"none", borderBottom: setupTab===id ? `3px solid ${T.midBlue}` : "3px solid transparent",
                color: setupTab===id ? T.midBlue : T.navInactive, fontFamily:"inherit", fontSize:13, fontWeight: setupTab===id ? 700 : 500,
                padding:"6px 16px 10px", cursor:"pointer" }}>
              {label}
            </button>
          );
        })}
      </div>
      {setupTab === "pricing" && <PropertyEditor properties={properties} setProperties={setProperties} onSave={onSaveProperties}/>}
      {setupTab === "codes"   && <DiscountCodesEditor codes={discountCodes} setCodes={setDiscountCodes} onSave={onSaveDiscountCodes}/>}
      {setupTab === "ical"    && <ICalSettings properties={properties} setProperties={setProperties} onSave={onSaveProperties}/>}
      {setupTab === "emails"  && <EmailTemplatesEditor templates={emailTemplates} setTemplates={setEmailTemplates} onSave={onSaveEmailTemplates}/>}
    </div>
  );
}

// ── Main Lettings view ───────────────────────────────────────────────────────
function LettingsView({ events, calendarTrigger, setView: setAppView, setReportType: setAppReportType, focusBookingId, clearFocusBooking }) {
  const [properties, setProperties]         = useState(INITIAL_PROPERTIES);
  const [bookings, setBookings]             = useState([]);
  const [guests, setGuests]                 = useState([]);
  const [discountCodes, setDiscountCodes]   = useState([]);
  const [emailTemplates, setEmailTemplates] = useState(DEFAULT_EMAIL_TEMPLATES);
  const [loaded, setLoaded]                 = useState(false);
  const [tab, setTab]               = useState("calendar");
  // Jump to calendar sub-tab when the Calendar nav item is clicked
  useEffect(function() { if (calendarTrigger > 0) setTab("calendar"); }, [calendarTrigger]);
  const [cursor, setCursor]         = useState(()=> new Date());
  const [form, setForm]             = useState(null);
  const [editId, setEditId]         = useState(null);
  const [filterProp, setFilterProp] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [flash, setFlash]           = useState("");
  const [askSendConfirm, setAskSendConfirm] = useState(null); // holds the just-created booking record, or null
  const [sendingConfirm, setSendingConfirm] = useState(false);
  const [askDeleteBooking, setAskDeleteBooking] = useState(false);

  useEffect(() => {
    (async () => {
      try { const p = await sbGet(PROPERTIES_STORAGE); if (p && p.length) setProperties(p); } catch {}
      try { const b = await sbGet(ACCOM_STORAGE);      setBookings((b || []).map(normalizeAccom)); } catch { setBookings([]); }
      try { const g = await sbGet(ACCOM_GUESTS_STORAGE); setGuests(g || []); } catch { setGuests([]); }
      try { const dc = await sbGet(DISCOUNT_CODES_STORAGE); setDiscountCodes(dc || []); } catch { setDiscountCodes([]); }
      try { const et = await sbGet(EMAIL_TEMPLATES_STORAGE); if (et && et.length) setEmailTemplates(et); } catch {}
      setLoaded(true);
    })();
  }, []);

  const saveBookings = async (data) => {
    setBookings(data);
    try { await sbSet(ACCOM_STORAGE, data); setFlash("Saved"); setTimeout(()=>setFlash(""), 1500); }
    catch (e) { console.error(e); setFlash("Save failed"); }
  };

  const saveProperties = async () => {
    try { await sbSet(PROPERTIES_STORAGE, properties); setFlash("Saved"); setTimeout(()=>setFlash(""), 1500); }
    catch (e) { console.error(e); setFlash("Save failed"); }
  };

  const saveDiscountCodes = async () => {
    try { await sbSet(DISCOUNT_CODES_STORAGE, discountCodes); setFlash("Saved"); setTimeout(()=>setFlash(""), 1500); }
    catch (e) { console.error(e); setFlash("Save failed"); }
  };

  const saveEmailTemplates = async () => {
    try { await sbSet(EMAIL_TEMPLATES_STORAGE, emailTemplates); setFlash("Saved"); setTimeout(()=>setFlash(""), 1500); }
    catch (e) { console.error(e); setFlash("Save failed"); }
  };

  const openNew  = () => { setForm(blankAccom()); setEditId(null); setTab("form"); };
  const openNewBlock = () => { setForm(Object.assign({}, blankAccom(), { bookingType:"Blocked", guestName:"Not available" })); setEditId(null); setTab("form"); };
  const openEdit = (b) => {
    var editStays;
    if (b.stays && b.stays.length) {
      // Ensure each stay has guestCount and value fields
      editStays = b.stays.map(function(s) {
        return Object.assign({ guestCount:"", value:0 }, s);
      });
    } else {
      // Old flat booking — wrap into a single stay
      editStays = [{ propertyId:b.propertyId||"hamlet", propertyName:b.propertyName||"", checkIn:b.checkIn||"", checkOut:b.checkOut||"", nights:b.nights||null, guestCount:b.guestCount||"", value:Number(b.value)||0 }];
    }
    var pIds = editStays.map(function(s){ return s.propertyId; }).filter(Boolean);
    if (!pIds.length) pIds = [b.propertyId||"hamlet"];
    setForm(Object.assign({}, blankAccom(pIds[0]), b, { propertyIds:pIds, propertyId:pIds[0], stays:editStays, extras:(b.extras||[]).slice(), schedule:(b.schedule||[]).slice() }));
    setEditId(b.id); setTab("form");
  };

  // Deep-link: open a specific accom booking when arriving via the Bookings accommodation column
  useEffect(function() {
    if (!focusBookingId || !loaded) return;
    var target = bookings.find(function(b) { return String(b.id) === String(focusBookingId); });
    if (target) openEdit(target);
    if (clearFocusBooking) clearFocusBooking();
  }, [focusBookingId, loaded, bookings]);

  const handleSave = async () => {
    var rawStays = (form.stays && form.stays.length) ? form.stays : [{ propertyId:form.propertyId||"hamlet", propertyName:"", checkIn:form.checkIn||"", checkOut:form.checkOut||"", nights:null, guestCount:form.guestCount||"", value:Number(form.value)||0 }];
    var stays = rawStays.map(function(s) {
      var p = properties.find(function(pp){ return pp.id===s.propertyId; });
      return Object.assign({}, s, { propertyName: p?p.name:s.propertyId, nights: nightsBetween(s.checkIn, s.checkOut) });
    });
    var totalValue = stays.reduce(function(sum,s){ return sum+(Number(s.value)||0); }, 0);
    var primary = stays[0] || {};
    var pIds = stays.map(function(s){ return s.propertyId; });
    var rec = Object.assign({}, form, {
      propertyId: primary.propertyId || form.propertyId,
      propertyName: primary.propertyName || "",
      propertyIds: pIds,
      checkIn: primary.checkIn || "",
      checkOut: primary.checkOut || "",
      nights: primary.nights || null,
      value: totalValue,
      stays: stays
    });
    var isNew = !editId;
    var next = editId ? bookings.map(function(b){ return b.id===editId ? rec : b; }) : bookings.concat([rec]);
    await saveBookings(next);
    setTab("calendar"); setForm(null); setEditId(null);
    // Newly-created manual booking with a guest email — offer to send the Booking Confirmed email
    if (isNew && rec.email && rec.bookingType !== "Blocked") {
      setAskSendConfirm(rec);
    }
  };
  const sendBookingConfirmedEmail = async () => {
    if (!askSendConfirm) return;
    setSendingConfirm(true);
    try {
      await fetch("/.netlify/functions/send-accom-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: askSendConfirm.id, emailType: "booking_confirmed" }),
      });
      setFlash("Confirmation email sent");
      setTimeout(function(){ setFlash(""); }, 2000);
    } catch (e) {
      console.error(e);
      setFlash("Email send failed");
      setTimeout(function(){ setFlash(""); }, 2500);
    }
    setSendingConfirm(false);
    setAskSendConfirm(null);
  };
  const handleDelete = async () => {
    const next = bookings.filter(b=> b.id!==editId);
    await saveBookings(next);
    setTab("calendar"); setForm(null); setEditId(null); setAskDeleteBooking(false);
  };

  const subTabs = [["calendar","Calendar"],["list","Bookings"],["report","Report"],["import","Import"],["settings","Settings"]];

  return (
    <div style={{ maxWidth:1200, margin:"0 auto", padding:"24px 28px" }}>
      {askSendConfirm && (
        <ConfirmDialog
          message="Send booking confirmation email?"
          subMessage={`Email "${askSendConfirm.guestName || "this guest"}" at ${askSendConfirm.email} to confirm their new booking.`}
          confirmLabel={sendingConfirm ? "Sending…" : "Send Email"}
          cancelLabel="Skip"
          icon="✉️"
          iconBg={T.accentLight}
          confirmColor={T.accent}
          onConfirm={sendBookingConfirmedEmail}
          onCancel={()=>setAskSendConfirm(null)}
        />
      )}
      {askDeleteBooking && (
        <ConfirmDialog
          message="Delete this booking?"
          subMessage={`"${(form && form.guestName) || "This booking"}" will be permanently removed. This cannot be undone.`}
          confirmLabel="Yes, Delete"
          cancelLabel="Cancel"
          onConfirm={handleDelete}
          onCancel={()=>setAskDeleteBooking(false)}
        />
      )}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
        <div>
          <h2 style={{ fontSize:22, fontWeight:800, color:T.text, margin:0 }}>Lettings</h2>
          <div style={{ fontSize:13, color:T.textMid, marginTop:3 }}>Holiday lets across {properties.map(p=>p.name).join(", ")} · read-only alongside Bookalet</div>
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          {flash && <span style={{ fontSize:12, fontWeight:600, color:T.green }}>{flash}</span>}
          <button onClick={openNewBlock} style={{ background:"#fff", color:T.textMid, border:`1.5px solid ${T.border}`, padding:"10px 16px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600 }}>+ Block dates</button>
          <button onClick={openNew} style={{ background:T.accent, color:"#fff", border:"none", padding:"10px 18px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:700 }}>+ New booking</button>
        </div>
      </div>

      {tab!=="form" && (
        <div style={{ display:"flex", gap:4, marginBottom:20, borderBottom:`1px solid ${T.border}` }}>
          {subTabs.map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={{ background:"none", border:"none", borderBottom: tab===id?`3px solid ${T.accent}`:"3px solid transparent",
              color: tab===id?T.accent:T.navInactive, fontFamily:"inherit", fontSize:14, fontWeight: tab===id?700:500, padding:"8px 16px 12px", cursor:"pointer" }}>{label}</button>
          ))}
        </div>
      )}

      {!loaded && <div style={{ padding:"40px", textAlign:"center", color:T.textLight }}>Loading…</div>}

      {loaded && tab==="calendar" && <AccomCalendar properties={properties} bookings={bookings} events={events||[]} cursor={cursor} setCursor={setCursor} onOpen={openEdit} onViewEventsCalendar={setAppView && setAppReportType ? function(){ setAppReportType("calendar"); setAppView("reports"); } : null} />}
      {loaded && tab==="list" && <AccomList properties={properties} bookings={bookings} filterProp={filterProp} setFilterProp={setFilterProp} filterStatus={filterStatus} setFilterStatus={setFilterStatus} onOpen={openEdit} />}
      {loaded && tab==="report" && <AccomReport properties={properties} bookings={bookings} />}
      {loaded && tab==="import" && <AccomImport onImported={(p,g,b)=>{ setProperties(p); setGuests(g); setBookings(b.map(normalizeAccom)); setTab("calendar"); }} saveBookings={saveBookings} bookings={bookings} />}
      {loaded && tab==="settings" && (
        <LettingsSetup
          properties={properties} setProperties={setProperties} onSaveProperties={saveProperties}
          discountCodes={discountCodes} setDiscountCodes={setDiscountCodes} onSaveDiscountCodes={saveDiscountCodes}
          emailTemplates={emailTemplates} setEmailTemplates={setEmailTemplates} onSaveEmailTemplates={saveEmailTemplates}
        />
      )}
      {tab==="form" && form && (
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:T.text, marginBottom:16 }}>{editId ? "Edit booking" : "New booking"}</div>
          <AccomForm properties={properties} discountCodes={discountCodes} events={events||[]} form={form} setForm={setForm} onSave={handleSave} onCancel={()=>{ setTab("calendar"); setForm(null); setEditId(null); }} onDelete={editId ? ()=>setAskDeleteBooking(true) : null} />
        </div>
      )}
    </div>
  );
}


// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [bookings, setBookings] = useState([]);
  const [staff, setStaff]       = useState([]);
  const [view, setView]         = useState("home");
  const [lettingsCalTrigger, setLettingsCalTrigger] = useState(0);
  const [xeroToken, setXeroToken]   = useState(() => xeroGetToken());
  const [gmailToken, setGmailToken] = useState(() => gmailGetToken());

  // Handle Gmail OAuth2 implicit flow callback — reads access_token from URL hash
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("access_token")) return;
    const params = new URLSearchParams(hash.replace("#",""));
    const accessToken = params.get("access_token");
    const expiresIn   = parseInt(params.get("expires_in")||"3600");
    const state       = params.get("state");
    if (!accessToken) return;
    if (state !== sessionStorage.getItem("gmail_state")) return;
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
    const token = { access_token: accessToken, expires_at: Date.now() + expiresIn * 1000 };
    gmailSetToken(token);
    setGmailToken(token);
    sessionStorage.removeItem("gmail_state");
  }, []);

  const handleGmailConnect = () => {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem("gmail_state", state);
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      redirect_uri:  GMAIL_REDIRECT,
      response_type: "token",
      scope:         GMAIL_SCOPE,
      state,
      include_granted_scopes: "true",
    });
    window.location.href = url;
  };

  const handleGmailDisconnect = () => { gmailClearToken(); setGmailToken(null); };

  // Handle Xero OAuth2 callback — runs once on load if ?code= is in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code) return;
    const savedState    = sessionStorage.getItem("xero_state");
    const codeVerifier  = sessionStorage.getItem("xero_code_verifier");
    if (state !== savedState) { console.error("Xero state mismatch"); return; }
    // Clean URL immediately
    window.history.replaceState({}, document.title, window.location.pathname);
    // Exchange code for token
    (async () => {
      try {
        const res = await fetch("https://identity.xero.com/connect/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: XERO_REDIRECT_URI,
            client_id: XERO_CLIENT_ID,
            code_verifier: codeVerifier,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const token = { ...data, expires_at: Date.now() + data.expires_in * 1000 };
        xeroSetToken(token);
        setXeroToken(token);
        sessionStorage.removeItem("xero_state");
        sessionStorage.removeItem("xero_code_verifier");
      } catch(err) { console.error("Xero token exchange failed:", err); }
    })();
  }, []);

  const handleXeroConnect = async () => {
    const verifier  = xeroGenerateCodeVerifier();
    const challenge = await xeroGenerateCodeChallenge(verifier);
    const state     = xeroGenerateCodeVerifier(); // reuse as random state
    sessionStorage.setItem("xero_code_verifier", verifier);
    sessionStorage.setItem("xero_state", state);
    const url = "https://login.xero.com/identity/connect/authorize?" + new URLSearchParams({
      response_type: "code",
      client_id: XERO_CLIENT_ID,
      redirect_uri: XERO_REDIRECT_URI,
      scope: XERO_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    window.location.href = url;
  };

  const handleXeroDisconnect = () => { xeroClearToken(); setXeroToken(null); };
  const [editId, setEditId]     = useState(null);
  const [formData, setFormData] = useState(null);
  const [search, setSearch]     = useState("");
  const [reportType, setReportType] = useState("summary");
  const [loaded, setLoaded]     = useState(false);
  const [enquiries, setEnquiries]         = useState([]);
  const [viewingRequests, setViewingRequests] = useState([]);
  const [viewingBlocks,   setViewingBlocks]   = useState([]);
  const [editStaffId, setEditStaffId] = useState(null);
  const [staffForm, setStaffForm]     = useState(null);
  const [focusEnquiryId, setFocusEnquiryId] = useState(null);
  const [focusAccomBookingId, setFocusAccomBookingId] = useState(null);
  const [accomBookings, setAccomBookings]     = useState([]);
  const [accomProperties, setAccomProperties] = useState([]);

  // Navigate straight to a specific enquiry's detail page (used from Viewings + Year Calendar)
  const goToEnquiry = (id) => { setFocusEnquiryId(id); setView("enquiries"); };
  // Navigate straight to a specific lettings booking (used from the Bookings accommodation column)
  const goToAccomBooking = (id) => { setFocusAccomBookingId(id); setView("lettings"); };

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
          xeroContactId: b.xeroContactId || "",
        }));
        setBookings(migrated);
      } catch { setBookings(INITIAL_BOOKINGS); }
      try { const r = await sbGet(STAFF_STORAGE); setStaff(r || INITIAL_STAFF); } catch { setStaff(INITIAL_STAFF); }
      try { const r = await sbGet(ENQUIRIES_STORAGE); setEnquiries(r || []); } catch { setEnquiries([]); }
        try { const r = await sbGet(VR_STORAGE); setViewingRequests(r || []); } catch { setViewingRequests([]); }
        try { const r = await sbGet(VB_STORAGE); setViewingBlocks(r || []); } catch { setViewingBlocks([]); }
      try { const r = await sbGet(ACCOM_STORAGE); setAccomBookings((r||[]).map(normalizeAccom)); } catch { setAccomBookings([]); }
      try { const r = await sbGet(PROPERTIES_STORAGE); setAccomProperties(r||INITIAL_PROPERTIES); } catch { setAccomProperties(INITIAL_PROPERTIES); }
      setLoaded(true);
    })();
  },[]);

  const saveBookings = useCallback(async data=>{ setBookings(data); try{await sbSet(BOOKING_STORAGE, data);}catch(e){console.error(e);} },[]);
  const saveStaff    = useCallback(async data=>{ setStaff(data);    try{await sbSet(STAFF_STORAGE, data);}catch(e){console.error(e);} },[]);

  const saveAccomBooking = useCallback(async (bookingId, patch) => {
    setAccomBookings(function(prev) {
      var next = prev.map(function(b) { return b.id===bookingId ? Object.assign({}, b, patch) : b; });
      sbSet(ACCOM_STORAGE, next).catch(function(e){ console.error(e); });
      return next;
    });
  }, []);

  const emptyBooking = ()=>({ couple:"", date:"", endDate:"", status:"Confirmed", eventType:"Wedding (Peak)", setup:[], dayManager:[], dayStaff:[], barSupervisor:[], sunday:[], bar:[], dayHandy:[], eveHandy:[], mealGuests:"", mealChildren:"", mealBabies:"", eveGuests:"", phone:"", email:"", email2:"", ceremony:"", guestArrivalTime:"", caterers:"", foodTruck:"", eveFood:"", otherVendors:"", amlyBooked:"undecided", amlyFee:"", amly50Paid:false, amly100Paid:false, hamletBooked:"undecided", hamletFee:"", hamlet50Paid:false, hamlet100Paid:false, campingBooked:"undecided", campingFee:"", camping50Paid:false, camping100Paid:false, nonStandard:"", venueFee:"", deposit:"", depositPaid:false, xeroContactId:"", payment2:"", finalPayment:"", extras:"", corkage:"", corkageTotal:"", pets:"", barTakeGross:"", circaCommission:"", hairdresser:"", florist:"", band:"", paSystem:"", notes:"", hoursWorked:{} });

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

  const handleConvertEnquiryToBooking = (enq) => {
    const sortedContacts = [...(enq.contacts||[])].sort((a,b)=> (a.date||"") > (b.date||"") ? 1 : -1);
    const methodLabel = m => m==="phone" ? "Phone" : m==="other" ? "Other" : "Email";
    const contactLines = sortedContacts.map(c => `${c.date||"No date"} (${methodLabel(c.method)}): ${c.note||""}`).join("\n\n");

    const extraLines = [];
    if (enq.source) extraLines.push(`Source: ${enq.source}`);
    if (enq.eventType) extraLines.push(`Enquiry event type: ${enq.eventType}`);
    if (enq.numbers) extraLines.push(`Numbers (from enquiry): ${enq.numbers}`);
    if (enq.datePreference) extraLines.push(`Date preference (from enquiry): ${enq.datePreference}`);

    const notesParts = [`Converted from enquiry${enq.name ? ` — ${enq.name}` : ""}.`];
    if (extraLines.length) notesParts.push(extraLines.join("\n"));
    if (contactLines) notesParts.push(`Contact History:\n${contactLines}`);

    // Pick up an ISO date (YYYY-MM-DD) if the date preference happens to contain one
    const dateMatch = (enq.datePreference||"").match(/\d{4}-\d{2}-\d{2}/);

    const newBooking = {
      ...emptyBooking(),
      couple: enq.name || "",
      date: dateMatch ? dateMatch[0] : "",
      email: enq.email || "",
      phone: enq.phone || "",
      notes: notesParts.join("\n\n"),
      viewings: enq.viewings || [],
      files: enq.files || [],
    };

    const newId = Math.max(0, ...bookings.map(b=>b.id)) + 1;
    const withId = { ...newBooking, id:newId };
    const updated = [...bookings, withId].sort((a,b)=>a.date>b.date?1:-1);
    saveBookings(updated);

    setFormData(withId);
    setEditId(newId);
    setView("form");
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
      <Header view={view} setView={setView} onNew={handleNew} xeroToken={xeroToken} onXeroConnect={handleXeroConnect} onXeroDisconnect={handleXeroDisconnect} gmailToken={gmailToken} onGmailConnect={handleGmailConnect} onGmailDisconnect={handleGmailDisconnect} onCalendarTab={()=>{ setView("lettings"); setLettingsCalTrigger(function(n){ return n+1; }); }}/>
      <div style={{ maxWidth:1240, margin:"0 auto", padding:"0 24px 60px" }}>
        {view==="home"    && <DashboardView bookings={bookings} viewingRequests={viewingRequests} setView={setView}/>}
        {view==="list"    && <ListView bookings={filtered} search={search} setSearch={setSearch} onEdit={handleEdit} onDelete={handleDelete} onNew={handleNew} staff={staff} accomBookings={accomBookings} onOpenAccom={goToAccomBooking} xeroToken={xeroToken}/>}
        {view==="form"    && <FormView formData={formData} setFormData={setFormData} onSubmit={handleSubmit} onCancel={()=>setView("list")} isEdit={!!editId} staff={staff} xeroToken={xeroToken} gmailToken={gmailToken} onDelete={editId ? ()=>handleDelete(editId) : null} accomBookings={accomBookings} accomProperties={accomProperties} onSaveAccomBooking={saveAccomBooking} onOpenAccomBooking={goToAccomBooking}
          onAutoSave={async(fd)=>{
            if(!fd.couple||!fd.date) return;
            let updated;
            if(editId) {
              updated=bookings.map(b=>b.id===editId?{...fd,id:editId}:b);
            } else {
              // First autosave of a brand-new booking: mint an id and remember it,
              // so subsequent autosaves update this same record instead of creating duplicates
              const newId=Math.max(0,...bookings.map(b=>b.id))+1;
              updated=[...bookings,{...fd,id:newId}];
              setEditId(newId);
              setFormData(f=>({...f, id:newId}));
            }
            await saveBookings(updated.sort((a,b)=>a.date>b.date?1:-1));
          }}
        />}
        {view==="staff"   && <StaffView staff={staff} bookings={bookings} staffForm={staffForm} setStaffForm={setStaffForm} editStaffId={editStaffId} onNew={handleNewStaff} onEdit={handleEditStaff} onDelete={handleDeleteStaff} onSubmit={handleSubmitStaff} onCancel={()=>{setStaffForm(null);setEditStaffId(null);}}/>}
        {view==="bar"        && <BarView/>}
        {view==="lettings"   && <LettingsView events={bookings} calendarTrigger={lettingsCalTrigger} setView={setView} setReportType={setReportType} focusBookingId={focusAccomBookingId} clearFocusBooking={()=>setFocusAccomBookingId(null)}/>}
        {view==="enquiries"  && <EnquiriesView gmailToken={gmailToken} onConvertToBooking={handleConvertEnquiryToBooking} focusEnquiryId={focusEnquiryId} clearFocus={()=>setFocusEnquiryId(null)}/>}
        {view==="viewings"   && <ViewingsView bookings={bookings} setBookings={setBookings} setView={setView} setReportType={setReportType} onEditBooking={handleEdit}
          viewingRequests={viewingRequests} setViewingRequests={setViewingRequests}
          viewingBlocks={viewingBlocks} setViewingBlocks={setViewingBlocks}
          enquiries={enquiries} setEnquiries={setEnquiries}
          saveEnquiries={async(e)=>{ setEnquiries(e); await sbSet(ENQUIRIES_STORAGE,e); }}
          saveBookings={saveBookings}
          onSelectEnquiry={goToEnquiry}/>}
        {view==="reports"    && <ReportsView bookings={bookings} staff={staff} reportType={reportType} setReportType={setReportType} enquiries={enquiries} setView={setView} onEditBooking={handleEdit} onSelectEnquiry={goToEnquiry} accomBookings={accomBookings} accomProperties={accomProperties}/>}
        {view==="settings"   && <SettingsView xeroToken={xeroToken} onXeroConnect={handleXeroConnect} onXeroDisconnect={handleXeroDisconnect} gmailToken={gmailToken} onGmailConnect={handleGmailConnect} onGmailDisconnect={handleGmailDisconnect} setView={setView}/>}
      </div>
    </div>
  );
}

// ─── HEADER ───────────────────────────────────────────────────────────────────
function Header({ view, setView, onNew, xeroToken, onXeroConnect, onXeroDisconnect, gmailToken, onGmailConnect, onGmailDisconnect, onCalendarTab }) {
  // "calendar" is a virtual tab that maps to view="lettings" (calendar sub-tab)
  const tabs = [
    {id:"home",label:"Home"},
    {id:"calendar",label:"Calendar",virtual:true},
    {id:"lettings",label:"Lettings"},
    {id:"list",label:"Bookings"},
    {id:"enquiries",label:"Enquiries"},
    {id:"viewings",label:"Viewings"},
    {id:"bar",label:"Bar"},
    {id:"reports",label:"Reports"},
    {id:"settings",label:"Settings"},
  ];
  const isXeroConnected  = !!xeroToken;
  const isGmailConnected = !!gmailToken;
  // "calendar" virtual tab is active when we're on lettings (it switches to lettings calendar sub-tab)
  function isActive(t) {
    if (t.id === "calendar") return false; // never highlight calendar; lettings tab is the real home
    return view === t.id;
  }
  return (
    <header style={{ background:"#ffffff", borderBottom:`2px solid ${T.border}`, padding:"0 28px", display:"flex", alignItems:"center", gap:0, boxShadow:"0 2px 12px rgba(37,99,235,.08)" }}>
      <div style={{ display:"flex", alignItems:"center", marginRight:36, padding:"8px 0", flexShrink:0 }}>
        <img src={`data:image/png;base64,${LOGO_B64}`} alt="Hawthbush Farm" style={{ height:52, width:"auto", imageRendering:"crisp-edges" }} />
      </div>
      <nav style={{ display:"flex", gap:0, flex:1 }}>
        {tabs.map(t=>(
          <button key={t.id} onClick={t.virtual ? onCalendarTab : ()=>setView(t.id)}
            style={{ background:"none", border:"none", color:isActive(t)?T.navActive:T.navInactive, fontFamily:"inherit", fontSize:14, fontWeight:isActive(t)?700:400, padding:"22px 20px 18px", cursor:"pointer", borderBottom:isActive(t)?`3px solid ${T.accent}`:"3px solid transparent", transition:"all .2s", letterSpacing:.2 }}>{t.label}</button>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", paddingRight:8 }}>
          {isXeroConnected
            ? <button onClick={onXeroDisconnect} title="Disconnect Xero" style={{ background:"#e6f7fd", border:"1px solid #13B5EA", color:"#0e8ab0", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:5 }}><span style={{ color:"#13B5EA" }}>✓</span> Xero</button>
            : <button onClick={onXeroConnect} style={{ background:"#13B5EA", border:"none", color:"#fff", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>Connect Xero</button>
          }
          <div style={{ width:1, height:20, background:T.border, margin:"0 6px" }}/>
          {isGmailConnected
            ? <button onClick={onGmailDisconnect} title="Disconnect Gmail" style={{ background:"#fef2f2", border:"1px solid #fca5a5", color:"#dc2626", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:5 }}><span style={{ color:"#ea4335" }}>✓</span> Gmail</button>
            : <button onClick={onGmailConnect} style={{ background:"#ea4335", border:"none", color:"#fff", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600 }}>Connect Gmail</button>
          }
        </div>
      </nav>
      <button onClick={onNew} style={{ background:T.midBlue, color:"#fff", border:"none", padding:"9px 22px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:14, fontWeight:600, boxShadow:"0 2px 8px rgba(30,77,140,.25)", flexShrink:0 }}>
        + New Booking
      </button>
    </header>
  );
}

// ─── BOOKINGS LIST ────────────────────────────────────────────────────────────
function ListView({ bookings, search, setSearch, onEdit, onDelete, onNew, staff, accomBookings, onOpenAccom, xeroToken }) {
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
      {search ? <BookingTable rows={bookings} onEdit={onEdit} onDelete={onDelete} label="Results" staff={staff} accomBookings={accomBookings} onOpenAccom={onOpenAccom} xeroToken={xeroToken}/> : <>
        <BookingTable rows={upcoming} onEdit={onEdit} onDelete={onDelete} label="Upcoming" staff={staff} accomBookings={accomBookings} onOpenAccom={onOpenAccom} xeroToken={xeroToken}/>
        {past.length>0 && <BookingTable rows={past} onEdit={onEdit} onDelete={onDelete} label="Past" dimmed staff={staff} accomBookings={accomBookings} onOpenAccom={onOpenAccom} xeroToken={xeroToken}/>}
      </>}
      {bookings.length===0 && <div style={{ textAlign:"center", padding:60, color:T.textLight }}><p style={{ fontSize:18, marginBottom:16 }}>No bookings yet</p><button onClick={onNew} style={{ background:T.accent, color:"#fff", border:"none", padding:"11px 28px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:15 }}>Create First Booking</button></div>}
    </div>
  );
}

function BookingTable({ rows, onEdit, onDelete, label, dimmed, staff, accomBookings, onOpenAccom, xeroToken }) {
  if(rows.length===0) return null;

  // Bulk-fetch Xero invoices (one request covering every contact ID on this
  // page) so the Payment column reflects real Xero data instead of the
  // manually-typed deposit/2nd payment/final payment fields.
  const [xeroInvoicesByContact, setXeroInvoicesByContact] = useState({});
  const contactIds = rows.map(function(b){ return (b.xeroContactId||"").trim(); }).filter(Boolean);
  const contactIdsKey = contactIds.slice().sort().join(",");

  useEffect(function() {
    if (!xeroToken || !contactIds.length) { setXeroInvoicesByContact({}); return; }
    let cancelled = false;
    (async function() {
      try {
        const data = await xeroFetch(`Invoices?ContactIDs=${contactIds.join(",")}&order=Date DESC`);
        if (cancelled) return;
        const byContact = {};
        (data.Invoices||[]).forEach(function(inv){
          const cid = inv.Contact && inv.Contact.ContactID;
          if (!cid) return;
          if (!byContact[cid]) byContact[cid] = [];
          byContact[cid].push(inv);
        });
        setXeroInvoicesByContact(byContact);
      } catch(e) {
        console.warn("Xero invoice bulk fetch failed:", e.message);
        if (!cancelled) setXeroInvoicesByContact({});
      }
    })();
    return function(){ cancelled = true; };
  }, [xeroToken?.access_token, contactIdsKey]);

  return (
    <div style={{ marginBottom:36 }}>
      <h3 style={{ color:T.midBlue, fontSize:11, letterSpacing:2, textTransform:"uppercase", marginBottom:10, fontWeight:700 }}>{label} ({rows.length})</h3>
      <div style={{ background:"#fff", borderRadius:10, border:`1px solid ${T.border}`, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", opacity:dimmed?.65:1 }}>
          <thead>
            <tr style={{ background:"#eef4fd", borderBottom:`1px solid ${T.border}` }}>
              {["Date","Day","Couple / Event","Event Type","Day Guests","Eve Guests","Venue Fee","Accommodation","Status","Payment","Viewings","Files"].map(h=>(
                <th key={h} style={{ color:T.textMid, fontSize:11, letterSpacing:1.2, textTransform:"uppercase", padding:"10px 12px", textAlign:"left", fontWeight:700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b,i)=>{
              const total=parseMoney(b.venueFee);
              // Payment column reflects live Xero invoice data for this booking's
              // contact, rather than the manually-typed deposit/2nd/final fields.
              const xeroContactId = (b.xeroContactId||"").trim();
              const xeroInvoices = xeroContactId ? xeroInvoicesByContact[xeroContactId] : null;
              let payment;
              if (!xeroToken || !xeroContactId || !xeroInvoices || xeroInvoices.length===0) {
                payment = { mode:"na" };
              } else {
                const xTotal = xeroInvoices.reduce(function(s,inv){ return s+(Number(inv.Total)||0); }, 0);
                const xDue   = xeroInvoices.reduce(function(s,inv){ return s+(Number(inv.AmountDue)||0); }, 0);
                payment = { mode:"xero", due:xDue, isFullyPaid: xTotal>0 && xDue<=0.01 };
              }
              const linkedAccom = (accomBookings||[]).filter(function(ab){ return ab.linkedEventId && String(ab.linkedEventId)===String(b.id); });
              // Keep each badge tied to its underlying accom booking id so it can be clicked through to open it
              const accomBadges = linkedAccom.map(function(ab) {
                var stays = (ab.stays&&ab.stays.length) ? ab.stays : [ab];
                var labels = stays.map(function(s){
                  var n = s.propertyName || s.propertyId || "Accom";
                  if (/hamlet/i.test(n)) return "Hamlet";
                  if (/amly/i.test(n)) return "Amly";
                  if (/glamp/i.test(n) || /camping/i.test(n)) return "Glamp";
                  return n;
                }).filter(function(v,i,arr){ return arr.indexOf(v)===i; });
                return { id: ab.id, labels: labels };
              });
              return (
                <tr key={b.id} style={{ borderTop:i>0?`1px solid ${T.border}`:"none", transition:"background .12s", cursor:"pointer" }}
                  onClick={()=>onEdit(b.id)}
                  onMouseEnter={e=>e.currentTarget.style.background="#f0f6ff"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.accent, whiteSpace:"nowrap", fontWeight:600 }}>{b.date?fmtDate(b.date)+(b.endDate&&b.endDate>b.date?" – "+fmtDate(b.endDate):""):"—"}</td>
                  <td style={{ padding:"10px 12px", whiteSpace:"nowrap" }}><DayBadge dateStr={b.date}/></td>
                  <td style={{ padding:"10px 12px", maxWidth:180 }}>
                    <div style={{ fontWeight:600, color:T.text, fontSize:14 }}>{b.couple||"—"}</div>
                  </td>
                  <td style={{ padding:"10px 12px", fontSize:12, color:T.textMid }}>{b.eventType||"—"}</td>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.textMid }}>{b.mealGuests||"—"}</td>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.textMid }}>{b.eveGuests||"—"}</td>
                  <td style={{ padding:"10px 12px", fontSize:13, color:T.text, fontWeight:500 }}>{total>0?`£${total.toLocaleString()}`:"—"}</td>
                  <td style={{ padding:"10px 12px" }} onClick={e=>e.stopPropagation()}>
                    {accomBadges.length===0 ? <span style={{ color:T.textLight, fontSize:11 }}>—</span>
                      : accomBadges.map(function(entry){
                          return entry.labels.map(function(lbl){
                            return (
                              <span key={entry.id+"-"+lbl}
                                onClick={function(){ if (onOpenAccom) onOpenAccom(entry.id); }}
                                title="Open lettings booking"
                                style={{ fontSize:10, background:T.midBlueBg, color:T.midBlue, borderRadius:4, padding:"2px 6px", marginRight:3, fontWeight:600, cursor: onOpenAccom ? "pointer" : "default", textDecoration: onOpenAccom ? "underline" : "none", textDecorationStyle:"dotted" }}>
                                {lbl}
                              </span>
                            );
                          });
                        })}
                  </td>
                  <td style={{ padding:"10px 12px" }}>
                    {b.status==="Holding"
                      ? <span style={{ fontSize:11, padding:"3px 9px", borderRadius:12, background:"#fef9c3", color:"#854d0e", fontWeight:600 }}>Holding</span>
                      : b.status==="Confirmed"
                        ? <span style={{ fontSize:11, padding:"3px 9px", borderRadius:12, background:T.greenBg, color:T.green, fontWeight:600 }}>Confirmed</span>
                        : <span style={{ color:T.textLight, fontSize:11 }}>—</span>}
                  </td>
                  <td style={{ padding:"10px 12px" }}>
                    {payment.mode==="xero"
                      ? <span style={{ fontSize:11, padding:"3px 9px", borderRadius:12, background:payment.isFullyPaid?T.greenBg:payment.due>0?T.amberBg:T.redBg, color:payment.isFullyPaid?T.green:payment.due>0?T.amber:T.red, fontWeight:600 }}>{payment.isFullyPaid?"✓ Paid":payment.due>0?`£${payment.due.toLocaleString()} due`:"Overpaid"}</span>
                      : <span style={{ color:T.textLight, fontSize:11 }} title="No Xero invoices linked to this booking">N/A</span>}
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

// ─── GMAIL THREAD PANEL ──────────────────────────────────────────────────────
function GmailThreadPanel({ emails, gmailToken, formData, update, onAutoSave, entityId, entityType="booking" }) {
  const [threads,      setThreads]      = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState(null);
  const [expanded,     setExpanded]     = useState({});
  const [fullMsgs,     setFullMsgs]     = useState({}); // threadId -> full messages
  const [importing,    setImporting]    = useState({}); // attachmentKey -> bool
  const [importedKeys, setImportedKeys] = useState({}); // attachmentKey -> true

  const decodeEntities = (str) => {
    if (!str) return "";
    return str.replace(/&#(\d+);/g, (_,n)=>String.fromCharCode(n))
              .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
              .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'");
  };

  const emailList = Array.isArray(emails) ? emails.filter(Boolean) : [emails].filter(Boolean);

  const load = async () => {
    const token = gmailGetValidToken();
    if (!token || !emailList.length) return;
    setLoading(true); setError(null);
    try {
      const query = emailList.map(e => `from:${e} OR to:${e}`).join(" OR ");
      const searchRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(query)}&maxResults=15`,
        { headers: { Authorization: `Bearer ${token.access_token}` } }
      );
      if (!searchRes.ok) throw new Error(`Gmail search failed: ${searchRes.status}`);
      const searchData = await searchRes.json();
      const threadList = searchData.threads || [];
      const detailed = await Promise.all(threadList.map(async t => {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Content-Type`,
          { headers: { Authorization: `Bearer ${token.access_token}` } }
        );
        if (!res.ok) return t;
        return res.json();
      }));
      setThreads(detailed);
    } catch(err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (gmailToken) load(); }, [emails?.join(","), gmailToken?.access_token]);

  const loadFullThread = async (threadId) => {
    if (fullMsgs[threadId]) return; // already loaded
    const token = gmailGetValidToken();
    if (!token) return;
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
        { headers: { Authorization: `Bearer ${token.access_token}` } }
      );
      if (!res.ok) return;
      const data = await res.json();
      setFullMsgs(prev => ({ ...prev, [threadId]: data.messages || [] }));
    } catch(e) { console.warn("Full thread fetch failed:", e); }
  };

  const handleExpand = (threadId) => {
    const nowOpen = !expanded[threadId];
    setExpanded(e => ({ ...e, [threadId]: nowOpen }));
    if (nowOpen) loadFullThread(threadId);
  };

  // Get all attachment parts from a message recursively
  const getAttachments = (parts) => {
    if (!parts) return [];
    const atts = [];
    for (const part of parts) {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        atts.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size || 0 });
      }
      if (part.parts) atts.push(...getAttachments(part.parts));
    }
    return atts;
  };

  const importAttachment = async (msgId, att) => {
    const key = `${msgId}_${att.attachmentId}`;
    if (importing[key] || importedKeys[key]) return;
    const token = gmailGetValidToken();
    if (!token) { alert("Gmail token expired — please reconnect Gmail."); return; }
    setImporting(p => ({ ...p, [key]: true }));
    try {
      // Fetch the attachment data
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${att.attachmentId}`,
        { headers: { Authorization: `Bearer ${token.access_token}` } }
      );
      if (!res.ok) throw new Error(`Attachment fetch failed: ${res.status}`);
      const data = await res.json();
      // Decode base64url
      const b64 = (data.data || "").replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: att.mimeType || "application/octet-stream" });
      // Upload to Supabase Storage
      const id = entityId || formData?.id || formData?.couple?.replace(/[^a-z0-9]/gi,"_").toLowerCase() || "unknown";
      const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g,"_");
      const path = `${entityType}s/${id}/${Date.now()}_${safeName}`;
      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": att.mimeType || "application/octet-stream", "x-upsert": "true" },
        body: blob,
      });
      if (!uploadRes.ok) throw new Error(await uploadRes.text());
      const url = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
      // Add to booking files
      const newFile = { name: att.filename, url, path, type: att.mimeType || "", docType: guessDocType(att.filename), uploadedAt: new Date().toISOString().slice(0,10) };
      const currentFiles = formData?.files || [];
      const updatedFiles = [...currentFiles, newFile];
      if (update) update("files", updatedFiles);
      if (onAutoSave && formData) await onAutoSave({ ...formData, files: updatedFiles });
      setImportedKeys(p => ({ ...p, [key]: true }));
    } catch(err) {
      alert("Import failed: " + err.message);
    } finally {
      setImporting(p => ({ ...p, [key]: false }));
    }
  };

  const getHeader = (msg, name) => msg?.payload?.headers?.find(h=>h.name===name)?.value || "";
  const decodeBody = (msg) => {
    const parts = msg?.payload?.parts || [msg?.payload];
    for (const part of (parts||[])) {
      if (part?.mimeType === "text/plain" && part?.body?.data) {
        try { return atob(part.body.data.replace(/-/g,"+").replace(/_/g,"/")); } catch {}
      }
      if (part?.parts) {
        for (const sub of part.parts) {
          if (sub?.mimeType === "text/plain" && sub?.body?.data) {
            try { return atob(sub.body.data.replace(/-/g,"+").replace(/_/g,"/")); } catch {}
          }
        }
      }
    }
    return msg?.snippet || "";
  };

  if (!gmailToken) return (
    <div style={{ marginTop:16, padding:"10px 14px", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, fontSize:12, color:"#dc2626" }}>
      Connect Gmail (button in nav bar) to see email threads here.
    </div>
  );
  if (!emailList.length) return null;
  if (loading) return <div style={{ marginTop:16, padding:"12px 14px", background:T.bgInput, borderRadius:8, fontSize:12, color:T.textLight }}>Loading emails from Gmail…</div>;
  if (error) return (
    <div style={{ marginTop:16, padding:"10px 14px", background:T.redBg, border:"1px solid #fca5a5", borderRadius:8, fontSize:12, color:T.red, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <span>⚠ {error}</span>
      <button onClick={load} style={{ background:"none", border:"none", color:T.red, cursor:"pointer", fontSize:12, fontWeight:600, textDecoration:"underline" }}>Retry</button>
    </div>
  );
  if (!threads) return null;
  if (threads.length === 0) return (
    <div style={{ marginTop:16, padding:"10px 14px", background:T.bgInput, borderRadius:8, fontSize:12, color:T.textLight }}>No emails found for {emailList.join(", ")}.</div>
  );

  return (
    <div style={{ marginTop:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <span style={{ fontSize:12, color:T.textMid, fontWeight:600 }}>📧 {threads.length} email thread{threads.length!==1?"s":""} with {emailList.join(", ")}</span>
        <button onClick={load} style={{ background:"none", border:"none", color:T.midBlue, cursor:"pointer", fontSize:11, fontWeight:600 }}>↻ Refresh</button>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {threads.map(thread => {
          const lastMsg  = thread.messages?.[thread.messages.length-1];
          const firstMsg = thread.messages?.[0];
          const subject  = getHeader(firstMsg, "Subject") || "(no subject)";
          const from     = getHeader(lastMsg, "From") || "";
          const date     = getHeader(lastMsg, "Date") || "";
          const snippet  = thread.snippet || "";
          const isOpen   = expanded[thread.id];
          const msgCount = thread.messages?.length || 1;
          const fullMessages = fullMsgs[thread.id];
          const gmailUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(emailList.map(e=>`from:${e} OR to:${e}`).join(" OR "))}/${thread.id}`;
          // Count attachments across all full messages
          const totalAtts = fullMessages ? fullMessages.reduce((s,m) => s + getAttachments(m?.payload?.parts).length, 0) : 0;
          return (
            <div key={thread.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:8, overflow:"hidden", boxShadow:"0 1px 3px rgba(0,0,0,.05)" }}>
              <div onClick={()=>handleExpand(thread.id)}
                style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"10px 14px", cursor:"pointer" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
                    <span style={{ fontSize:13, fontWeight:600, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{subject}</span>
                    {msgCount > 1 && <span style={{ fontSize:10, background:T.midBlueBg, color:T.midBlue, borderRadius:10, padding:"1px 6px", fontWeight:600, flexShrink:0 }}>{msgCount}</span>}
                    {totalAtts > 0 && <span style={{ fontSize:10, background:"#fef9c3", color:"#92400e", borderRadius:10, padding:"1px 6px", fontWeight:600, flexShrink:0 }}>📎 {totalAtts}</span>}
                  </div>
                  <div style={{ fontSize:11, color:T.textLight, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{from}</div>
                  {!isOpen && <div style={{ fontSize:11, color:T.textMid, marginTop:3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{decodeEntities(snippet)}</div>}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
                  <span style={{ fontSize:10, color:T.textLight, whiteSpace:"nowrap" }}>{new Date(date).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</span>
                  <a href={gmailUrl} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}
                    style={{ color:T.midBlue, fontSize:11, fontWeight:600, textDecoration:"none" }}>↗</a>
                  <span style={{ color:T.textLight, fontSize:12 }}>{isOpen?"▲":"▼"}</span>
                </div>
              </div>
              {isOpen && (
                <div style={{ borderTop:`1px solid ${T.border}`, background:"#f8fafd" }}>
                  {(fullMessages || thread.messages || []).map((msg, mi) => {
                    const atts = getAttachments(msg?.payload?.parts);
                    const msgs = fullMessages || thread.messages || [];
                    return (
                      <div key={msg.id} style={{ padding:"10px 14px", borderBottom:mi<msgs.length-1?`1px solid ${T.border}`:"none" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                          <span style={{ fontSize:11, fontWeight:600, color:T.text }}>{getHeader(msg,"From")}</span>
                          <span style={{ fontSize:10, color:T.textLight }}>{new Date(getHeader(msg,"Date")).toLocaleDateString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span>
                        </div>
                        <div style={{ fontSize:12, color:T.textMid, whiteSpace:"pre-wrap", lineHeight:1.5, maxHeight:200, overflow:"auto" }}>{decodeEntities(decodeBody(msg)||msg.snippet)}</div>
                        {atts.length > 0 && (
                          <div style={{ marginTop:10, display:"flex", flexDirection:"column", gap:6 }}>
                            <div style={{ fontSize:11, color:T.textMid, fontWeight:600, textTransform:"uppercase", letterSpacing:0.8 }}>Attachments</div>
                            {atts.map((att, ai) => {
                              const key = `${msg.id}_${att.attachmentId}`;
                              const isImporting = importing[key];
                              const isImported  = importedKeys[key] || (formData?.files||[]).some(f=>f.name===att.filename);
                              const sizeKb = Math.round(att.size / 1024);
                              return (
                                <div key={ai} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", background:"#fff", border:`1px solid ${T.border}`, borderRadius:6 }}>
                                  <span style={{ fontSize:18 }}>{/\.pdf$/i.test(att.filename)?"📄":/\.(doc|docx)$/i.test(att.filename)?"📝":/\.(xls|xlsx)$/i.test(att.filename)?"📊":/\.(jpe?g|png|gif|webp)$/i.test(att.filename)?"🖼":"📎"}</span>
                                  <div style={{ flex:1, minWidth:0 }}>
                                    <div style={{ fontSize:12, fontWeight:600, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{att.filename}</div>
                                    <div style={{ fontSize:10, color:T.textLight }}>{sizeKb > 0 ? `${sizeKb} KB` : ""} · {guessDocType(att.filename)}</div>
                                  </div>
                                  {isImported
                                    ? <span style={{ fontSize:11, color:T.green, fontWeight:600 }}>✓ In Files</span>
                                    : formData
                                      ? <button onClick={()=>importAttachment(msg.id, att)} disabled={isImporting}
                                          style={{ background:T.midBlue, color:"#fff", border:"none", padding:"4px 10px", borderRadius:5, cursor:isImporting?"wait":"pointer", fontFamily:"inherit", fontSize:11, fontWeight:600, opacity:isImporting?0.6:1, flexShrink:0 }}>
                                          {isImporting ? "Saving…" : "⬆ Add to Files"}
                                        </button>
                                      : null
                                  }
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── XERO LIVE INVOICES PANEL ────────────────────────────────────────────────
function XeroInvoicesPanel({ contactId, xeroToken }) {
  const [invoices, setInvoices] = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  const load = async () => {
    if (!xeroToken) return;
    setLoading(true); setError(null);
    try {
      const data = await xeroFetch(`Invoices?ContactIDs=${contactId}&order=Date DESC`);
      setInvoices(data.Invoices || []);
    } catch(err) { setError(err.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (xeroToken) load(); }, [contactId, xeroToken?.access_token]);

  if (!xeroToken) return (
    <div style={{ marginTop:12, padding:"10px 14px", background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, fontSize:12, color:"#92400e" }}>
      Connect Xero (button in nav bar) to see live invoices here.
    </div>
  );
  if (loading) return <div style={{ marginTop:12, padding:"12px 14px", background:T.bgInput, borderRadius:8, fontSize:12, color:T.textLight }}>Loading invoices from Xero…</div>;
  if (error) return (
    <div style={{ marginTop:12, padding:"10px 14px", background:T.redBg, border:"1px solid #fca5a5", borderRadius:8, fontSize:12, color:T.red, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <span>⚠ {error}</span>
      <button onClick={load} style={{ background:"none", border:"none", color:T.red, cursor:"pointer", fontSize:12, fontWeight:600, textDecoration:"underline" }}>Retry</button>
    </div>
  );
  if (!invoices) return null;
  if (invoices.length === 0) return <div style={{ marginTop:12, padding:"10px 14px", background:T.bgInput, borderRadius:8, fontSize:12, color:T.textLight }}>No invoices found for this contact in Xero.</div>;

  const statusColour = (s) => {
    if (s==="PAID") return { bg:T.greenBg, text:T.green, border:"#86efac" };
    if (s==="VOIDED") return { bg:"#f3f4f6", text:T.textLight, border:T.border };
    if (s==="AUTHORISED") return { bg:T.amberBg, text:"#92400e", border:"#fcd34d" };
    return { bg:T.midBlueBg, text:T.midBlue, border:T.border };
  };

  return (
    <div style={{ marginTop:14 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
        <span style={{ fontSize:12, color:T.textMid, fontWeight:600 }}>{invoices.length} invoice{invoices.length!==1?"s":""} in Xero</span>
        <button onClick={load} style={{ background:"none", border:"none", color:T.midBlue, cursor:"pointer", fontSize:11, fontWeight:600 }}>↻ Refresh</button>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        {invoices.map(inv => {
          const sc = statusColour(inv.Status);
          return (
            <div key={inv.InvoiceID} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", background:"#fff", border:`1px solid ${T.border}`, borderRadius:8, fontSize:12 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:600, color:T.text }}>{inv.InvoiceNumber}</div>
                {inv.Reference && <div style={{ color:T.textLight, fontSize:11 }}>{inv.Reference}</div>}
                {inv.DueDateString && <div style={{ color:T.textLight, fontSize:11 }}>Due: {inv.DueDateString}</div>}
              </div>
              <div style={{ textAlign:"right", flexShrink:0 }}>
                <div style={{ fontWeight:700, color:inv.AmountDue>0?"#92400e":T.green }}>
                  {inv.AmountDue>0 ? `£${inv.AmountDue.toLocaleString("en-GB",{minimumFractionDigits:2})} due` : "Paid"}
                </div>
                <div style={{ color:T.textLight, fontSize:11 }}>Total: £{(inv.Total||0).toLocaleString("en-GB",{minimumFractionDigits:2})}</div>
              </div>
              <span style={{ fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:4, background:sc.bg, color:sc.text, border:`1px solid ${sc.border}`, flexShrink:0 }}>
                {inv.Status==="AUTHORISED"?"UNPAID":inv.Status}
              </span>
              <a href={`https://go.xero.com/app/!qhzr2/invoicing/view/${inv.InvoiceID}`} target="_blank" rel="noreferrer"
                style={{ color:T.midBlue, fontSize:11, fontWeight:600, textDecoration:"none", flexShrink:0 }}>↗</a>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FormView({ formData, setFormData, onSubmit, onCancel, isEdit, staff, onAutoSave, onDelete, xeroToken, gmailToken, accomBookings, accomProperties, onSaveAccomBooking, onOpenAccomBooking }) {
  const [activeSection, setActiveSection] = useState("core");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = (key,val) => setFormData(f=>({...f,[key]:val}));

  // ── Autosave: silently persist the whole form ~1.5s after typing stops, so
  // navigating away (e.g. to open a linked accom booking) never loses data.
  const [autoSaveState, setAutoSaveState] = useState("idle"); // idle | saving | saved | error
  const autoSaveTimerRef = useRef(null);
  const autoSaveSkipFirstRef = useRef(true);
  useEffect(function() {
    // Skip the very first run (form just loaded — nothing to save yet)
    if (autoSaveSkipFirstRef.current) { autoSaveSkipFirstRef.current = false; return; }
    if (!onAutoSave) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(function() {
      setAutoSaveState("saving");
      Promise.resolve(onAutoSave(formData)).then(function() {
        setAutoSaveState("saved");
        setTimeout(function() { setAutoSaveState(function(s){ return s==="saved" ? "idle" : s; }); }, 2500);
      }).catch(function() {
        setAutoSaveState("error");
      });
    }, 1500);
    return function() { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [formData]);

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
              {formData.date && <span>{fmtDate(formData.date)}{formData.endDate && formData.endDate > formData.date ? " – " + fmtDate(formData.endDate) : ""}</span>}
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
            {autoSaveState!=="idle" && (
              <div style={{ display:"flex", alignItems:"center", gap:6, justifyContent:"center", fontSize:11, fontWeight:600,
                color: autoSaveState==="saving" ? T.textLight : autoSaveState==="error" ? T.red : T.green }}>
                {autoSaveState==="saving" && "Saving…"}
                {autoSaveState==="saved"  && "✓ All changes saved"}
                {autoSaveState==="error"  && "Autosave failed — click Save Changes"}
              </div>
            )}
          </div>
        </div>

        <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:28, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
          <h3 style={{ margin:"0 0 22px", color:T.midBlue, fontWeight:700, fontSize:17, borderBottom:`2px solid ${T.border}`, paddingBottom:12 }}>{FORM_SECTIONS[activeSection].label}</h3>

          {activeSection==="staffing" && (
            <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
              <StaffPicker label="Friday Set-Up (who sets up the venue)" value={formData.setup||[]} onChange={val=>update("setup",val)} staff={staff}/>
              {STAFFING_FIELDS.map(key=>(
                <StaffPicker key={key} label={STAFFING_LABELS[key]} value={formData[key]||[]} onChange={val=>update(key,val)} staff={staff}/>
              ))}
              {/* Shift times + Hours Worked inline */}
              {(() => {
                // Include setup staff here (excluded only from Event Rota timeline)
                const setupIds = formData.setup || [];
                const eventIds = [...new Set(STAFFING_FIELDS.flatMap(k=>formData[k]||[]))];
                const allIds   = [...new Set([...setupIds, ...eventIds])];
                if (allIds.length === 0) return null;
                const shifts = formData.staffShifts || {};
                const hw     = formData.hoursWorked || {};
                const updateShift = (id, field, val) => {
                  const updated = { ...shifts, [id]: { ...(shifts[id]||{}), [field]: val } };
                  update("staffShifts", updated);
                };
                const updateHours = (id, val) => {
                  const updated = { ...hw };
                  if (val === "") delete updated[id];
                  else updated[id] = parseFloat(val) || 0;
                  update("hoursWorked", updated);
                };
                const toMins = t => { const [h,m]=(t||"").split(":").map(Number); return h*60+m; };
                const totalHrs = Object.values(hw).reduce((a,b)=>a+b,0);
                return (
                  <div>
                    <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:12, marginTop:4, borderTop:`1px solid ${T.border}`, paddingTop:16 }}>Shift Times &amp; Hours Worked</div>
                    <div style={{ display:"grid", gridTemplateColumns:"44px 1fr 90px 90px 90px 16px", alignItems:"center", gap:"6px 10px", marginBottom:8, padding:"0 11px" }}>
                      <div/>
                      <div style={{ fontSize:10, fontWeight:700, color:T.textLight, letterSpacing:1, textTransform:"uppercase" }}>Name</div>
                      <div style={{ fontSize:10, fontWeight:700, color:T.textLight, letterSpacing:1, textTransform:"uppercase", textAlign:"center" }}>From</div>
                      <div style={{ fontSize:10, fontWeight:700, color:T.textLight, letterSpacing:1, textTransform:"uppercase", textAlign:"center" }}>To</div>
                      <div style={{ fontSize:10, fontWeight:700, color:T.textLight, letterSpacing:1, textTransform:"uppercase", textAlign:"center" }}>Hrs</div>
                      <div/>
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                      {allIds.map(id => {
                        const person  = staff.find(s=>s.id===id);
                        const sh      = shifts[id] || {};
                        const isSetup = setupIds.includes(id) && !eventIds.includes(id);
                        const diff    = sh.start && sh.end ? toMins(sh.end) - toMins(sh.start) : 0;
                        const expected = diff > 0 ? +(diff/60).toFixed(2) : null;
                        const tStyle  = { background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"5px 8px", outline:"none", width:90 };
                        return (
                          <div key={id} style={{ display:"grid", gridTemplateColumns:"44px 1fr 90px 90px 90px 16px", alignItems:"center", gap:"6px 10px", padding:"7px 10px", background:isSetup?"#fffbeb":T.bgInput, borderRadius:7, border:`1px solid ${isSetup?"#fde68a":T.border}` }}>
                            <StaffChip initials={id} staff={staff}/>
                            <span style={{ fontSize:13, color:T.text, fontWeight:500 }}>
                              {person?.name||id}
                              {isSetup && <span style={{ fontSize:10, color:"#92400e", fontWeight:600, marginLeft:6, background:"#fef9c3", borderRadius:4, padding:"1px 5px" }}>Fri Set-Up</span>}
                            </span>
                            <input type="time" value={sh.start||""} onChange={e=>updateShift(id,"start",e.target.value)} style={tStyle}/>
                            <input type="time" value={sh.end||""} onChange={e=>updateShift(id,"end",e.target.value)} style={tStyle}/>
                            <div style={{ position:"relative" }}>
                              <input type="number" min="0" step="0.5"
                                value={hw[id]!==undefined ? hw[id] : ""}
                                onChange={e=>updateHours(id, e.target.value)}
                                placeholder={expected!==null ? String(expected) : ""}
                                style={{ ...tStyle, width:80, textAlign:"center" }}/>
                              {expected!==null && hw[id]===undefined && (
                                <span style={{ position:"absolute", right:4, top:"50%", transform:"translateY(-50%)", fontSize:9, color:T.textLight, pointerEvents:"none" }}>est</span>
                              )}
                            </div>
                            <span style={{ fontSize:12, color:T.textLight }}>h</span>
                          </div>
                        );
                      })}
                    </div>
                    {totalHrs > 0 && (
                      <div style={{ marginTop:12, padding:"8px 14px", background:T.accentLight, borderRadius:7, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ fontSize:12, color:T.midBlue, fontWeight:600 }}>Total hours this event</span>
                        <span style={{ fontSize:16, color:T.midBlue, fontWeight:700 }}>{totalHrs}h</span>
                      </div>
                    )}
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
                  <FLabel>Final Total Corkage Amount (£)</FLabel>
                  <FInput type="number" value={formData.corkageTotal||""} onChange={v=>update("corkageTotal",v)}/>
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

              {/* Xero Contact + Live Invoices */}
              <div style={{ borderTop:`2px solid ${T.border}`, paddingTop:16 }}>
                <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:10 }}>Xero</div>
                <div>
                  <FLabel>Xero Contact ID <span style={{ fontWeight:400, color:T.textLight, fontSize:11 }}>— paste the UUID from the customer URL in Xero</span></FLabel>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ flex:1 }}>
                      <FInput type="text" value={formData.xeroContactId||""} onChange={v=>update("xeroContactId",v)} placeholder="e.g. 959587a8-1369-474b-a13e-1eb3a819fd02"/>
                    </div>
                    {formData.xeroContactId && formData.xeroContactId.trim() && (
                      <a href={`https://go.xero.com/app/!qhzr2/contacts/contact/${formData.xeroContactId.trim()}/activity/invoices?pageNumber=1&pageSize=25&searchTerm=&sortByDirection=DESC&sortByField=AmountDue&startDate=&endDate=&status=&searchDateBy=any&includeDeletedAndVoid=false`}
                        target="_blank" rel="noreferrer"
                        style={{ background:"#13B5EA", color:"#fff", borderRadius:6, padding:"8px 14px", fontSize:13, fontWeight:700, textDecoration:"none", whiteSpace:"nowrap", flexShrink:0 }}>
                        Open in Xero ↗
                      </a>
                    )}
                  </div>
                  {!formData.xeroContactId && (
                    <p style={{ fontSize:11, color:T.textLight, margin:"6px 0 0" }}>
                      To find the ID: open the customer in Xero → copy the UUID from the URL (the part after /contact/)
                    </p>
                  )}
                </div>
                {formData.xeroContactId && formData.xeroContactId.trim() && (
                  <XeroInvoicesPanel contactId={formData.xeroContactId.trim()} xeroToken={xeroToken}/>
                )}
              </div>

              {/* Accommodation — live from Lettings */}
              <div style={{ borderTop:`2px solid ${T.border}`, paddingTop:16 }}>
                <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:4 }}>Accommodation</div>
                <div style={{ fontSize:12, color:T.textLight, marginBottom:12 }}>
                  Lettings bookings with check-in within 7 days of this event date
                </div>
                <LinkedAccomPanel eventDate={formData.date} eventEndDate={formData.endDate} eventId={formData.id} accomBookings={accomBookings||[]} accomProperties={accomProperties||[]} onSaveAccomBooking={onSaveAccomBooking} onOpenAccomBooking={onOpenAccomBooking}/>
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
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <FInput type="date" value={formData.date} onChange={v=>update("date",v)}/>
                        <DayBadge dateStr={formData.date} style={{ fontSize:13, padding:"6px 12px" }}/>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:T.textMid, width:80, flexShrink:0 }}>End date</div>
                        <FInput type="date" value={formData.endDate||""} onChange={v=>update("endDate",v)}/>
                        {formData.endDate && formData.endDate > formData.date && (
                          <span style={{ fontSize:12, color:T.textMid }}>
                            {Math.round((new Date(formData.endDate+"T00:00:00") - new Date(formData.date+"T00:00:00")) / 86400000)} day(s)
                          </span>
                        )}
                        {formData.endDate && (
                          <button type="button" onClick={function(){ update("endDate",""); }}
                            style={{ fontSize:11, color:T.red, background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", padding:"2px 6px" }}>clear</button>
                        )}
                      </div>
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

          {activeSection==="contact" && (formData.email || formData.email2) && (
            <GmailThreadPanel emails={[formData.email, formData.email2].filter(Boolean)} gmailToken={gmailToken} formData={formData} update={update} onAutoSave={onAutoSave}/>
          )}

          {activeSection==="core" && isEdit && onDelete && (
            <div style={{ marginTop:40, paddingTop:20, borderTop:`1px solid ${T.border}` }}>
              {!confirmDelete ? (
                <button onClick={()=>setConfirmDelete(true)} style={{ background:"none", color:T.red, border:`1.5px solid ${T.red}`, padding:"9px 20px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
                  Delete Booking
                </button>
              ) : (
                <div style={{ background:"#fff5f5", border:`1.5px solid ${T.red}`, borderRadius:8, padding:"16px 20px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
                  <span style={{ color:T.red, fontWeight:600, fontSize:14, flex:1 }}>Are you sure? This cannot be undone.</span>
                  <button onClick={onDelete} style={{ background:T.red, color:"#fff", border:"none", padding:"9px 20px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Yes, Delete</button>
                  <button onClick={()=>setConfirmDelete(false)} style={{ background:"none", color:T.textMid, border:`1px solid ${T.border}`, padding:"9px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13 }}>Cancel</button>
                </div>
              )}
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
function ReportsView({ bookings, staff, reportType, setReportType, enquiries, setView, onEditBooking, onSelectEnquiry, accomBookings, accomProperties }) {
  const types = [{id:"summary",label:"Annual Summary"},{id:"calendar",label:"Year Calendar"},{id:"accommodation",label:"Accommodation"},{id:"staffing",label:"Rota Overview"},{id:"hours",label:"Hours Worked"},{id:"timeline",label:"Event Rota"}];
  // If an old/removed report type is still selected, fall back to summary
  const activeType = types.some(t=>t.id===reportType) ? reportType : "summary";
  return (
    <div style={{ paddingTop:28 }}>
      <div style={{ marginBottom:22, display:"flex", gap:8, flexWrap:"wrap" }}>
        {types.map(t=>(
          <button key={t.id} onClick={()=>{ if(t.id==="accommodation"){ setView("lettings"); } else { setReportType(t.id); } }}
            style={{ background:activeType===t.id?T.midBlue:"#fff", color:activeType===t.id?"#fff":T.textMid, border:`1.5px solid ${activeType===t.id?T.midBlue:T.border}`, padding:"8px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:activeType===t.id?700:400 }}>{t.label}</button>
        ))}
      </div>
      {activeType==="summary"   && <SummaryReport bookings={bookings}/>}
      {activeType==="calendar"  && <CalendarReport bookings={bookings} enquiries={enquiries||[]} setView={setView} onEditBooking={onEditBooking} onSelectEnquiry={onSelectEnquiry}/>}
      {activeType==="staffing"  && <StaffingRota bookings={bookings} staff={staff}/>}
      {activeType==="hours"     && <HoursReport bookings={bookings} staff={staff}/>}
      {activeType==="timeline"  && <StaffTimelineReport bookings={bookings} staff={staff}/>}
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
  // Bar take = recorded gross bar take + corkage.
  // Prefer the numeric "Final Total Corkage Amount" field; fall back to a number
  // parsed from the free-text corkage note only if the numeric box is empty.
  const totalBarGross = yearBookings.reduce((s,b)=>s+parseMoney(b.barTakeGross),0);
  const totalCorkage  = yearBookings.reduce((s,b)=>s+(parseMoney(b.corkageTotal) || parseMoney(b.corkage)),0);
  const totalBarTake  = totalBarGross + totalCorkage;
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
    `Bar Take (incl. corkage): £${totalBarTake.toLocaleString()} (bar £${totalBarGross.toLocaleString()} + corkage £${totalCorkage.toLocaleString()})`,
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
        <button onClick={()=>window.print()} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
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
        <StatCard label="Bar Take (incl. corkage)" value={`£${totalBarTake.toLocaleString()}`} sub={`Bar £${totalBarGross.toLocaleString()} + corkage £${totalCorkage.toLocaleString()}`}/>
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

      {/* Events by event type */}
      {yearBookings.length>0 && (()=>{
        const typeCounts = {};
        yearBookings.forEach(b => {
          const t = b.eventType || "Other";
          typeCounts[t] = (typeCounts[t]||0)+1;
        });
        const maxCount = Math.max(...Object.values(typeCounts), 1);
        return (
          <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:24, marginTop:16, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
            <h3 style={{ margin:"0 0 16px", color:T.midBlue, fontWeight:700, fontSize:16 }}>{year} Events by Type</h3>
            {Object.entries(typeCounts).sort((a,b)=>b[1]-a[1]).map(([type, count])=>(
              <div key={type} style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
                <span style={{ width:160, color:T.textMid, fontSize:13, flexShrink:0 }}>{type}</span>
                <div style={{ flex:1, background:T.accentLight, borderRadius:4, height:22, overflow:"hidden" }}>
                  <div style={{ width:`${Math.min(100,(count/maxCount)*100)}%`, minWidth:count>0?30:0, height:"100%", background:T.midBlue, borderRadius:4, display:"flex", alignItems:"center", paddingLeft:8 }}>
                    <span style={{ color:"#fff", fontSize:11, fontWeight:700 }}>{count}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// Returns which farm properties are booked on a wedding booking
function getBookedProps(b) {
  var ps = [];
  if (b.amlyBooked === "yes") ps.push("Amly Barn");
  if (b.hamletBooked === "yes") ps.push("The Hamlet");
  if (b.campingBooked === "yes") ps.push("Glamping");
  return ps;
}

// ─── YEAR CALENDAR REPORT ─────────────────────────────────────────────────────
function CalendarReport({ bookings, enquiries, setView, onEditBooking, onSelectEnquiry }) {
  const allYears = [...new Set(bookings.filter(b=>b.date).map(b=>b.date.slice(0,4)))].sort();
  const currentYear = new Date().getFullYear().toString();
  const [year, setYear] = useState(allYears.includes(currentYear) ? currentYear : (allYears[allYears.length-1]||currentYear));
  const [showViewings, setShowViewings] = useState(true);
  const [tooltip, setTooltip] = useState(null);
  const today = new Date().toISOString().slice(0,10);

  // Click handlers → jump to the booking form or the enquiry page
  const openBooking = (id) => { if (onEditBooking) { onEditBooking(id); if (setView) setView("form"); } };
  const openEnquiry = (id) => { if (onSelectEnquiry) onSelectEnquiry(id); };
  const openViewing = (v) => { if (v.source==="booking") openBooking(v.sourceId); else openEnquiry(v.sourceId); };

  // Index bookings by date string — multi-day events fill every day in range
  const byDate = {};
  bookings.filter(b=>b.date&&b.couple&&b.date.startsWith(year)).forEach(function(b) {
    var start = b.date;
    var end = (b.endDate && b.endDate > start) ? b.endDate : start;
    var cur = new Date(start + "T00:00:00");
    var endD = new Date(end + "T00:00:00");
    while (cur <= endD) {
      var ds = cur.getFullYear() + "-" + String(cur.getMonth()+1).padStart(2,"0") + "-" + String(cur.getDate()).padStart(2,"0");
      if (ds.startsWith(year)) {
        byDate[ds] = byDate[ds] || [];
        if (!byDate[ds].find(function(x){ return x.id===b.id; })) byDate[ds].push(b);
      }
      cur.setDate(cur.getDate() + 1);
    }
  });

  // Collect all viewings from bookings and enquiries (with source id for click-through)
  const viewingsByDate = {};
  bookings.forEach(b=>{
    (b.viewings||[]).forEach(v=>{
      if(v.date&&v.date.startsWith(year)){
        viewingsByDate[v.date] = viewingsByDate[v.date]||[];
        viewingsByDate[v.date].push({ label:b.couple||"Booking", source:"booking", sourceId:b.id });
      }
    });
  });
  (enquiries||[]).forEach(e=>{
    (e.viewings||[]).forEach(v=>{
      if(v.date&&v.date.startsWith(year)){
        viewingsByDate[v.date] = viewingsByDate[v.date]||[];
        viewingsByDate[v.date].push({ label:e.name||"Enquiry", source:"enquiry", sourceId:e.id });
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
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ width:12, height:5, borderRadius:3, background:"#3b82f6" }}/>
          <span style={{ fontSize:12, color:T.textMid }}>Wedding booked</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ width:12, height:5, borderRadius:3, background:"#ec4899" }}/>
          <span style={{ fontSize:12, color:T.textMid }}>Payment overdue</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background:"#7c3aed" }}/>
          <span style={{ fontSize:12, color:T.textMid }}>Viewing</span>
        </div>
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
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:20 }}>
        {MONTHS.map((monthName, mIdx) => {
          const monthNum = String(mIdx+1).padStart(2,"0");
          const firstDay = new Date(`${year}-${monthNum}-01T00:00:00`);
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
                    const hasOverdue = dayBookings.some(b=>(b.schedule||[]).some(s=>!s.paid&&s.dueDate&&s.dueDate<today));
                    const hasAny = dayBookings.length > 0;
                    const cellBg = hasAny ? (hasOverdue ? "#fce7f3" : "#dbeafe") : "transparent";
                    const cellBorder = hasAny ? (hasOverdue ? "#f9a8d4" : "#93c5fd") : "transparent";
                    const cellText = hasAny ? (hasOverdue ? "#be185d" : "#1d4ed8") : T.text;
                    const lozengeBg = hasOverdue ? "#ec4899" : "#3b82f6";
                    const isSun = (cells.slice(0,ci).filter(Boolean).length + startDow) % 7 === 6;
                    const isSat = (cells.slice(0,ci).filter(Boolean).length + startDow) % 7 === 5;

                    const hasViewing = showViewings && (viewingsByDate[dateStr]||[]).length > 0;
                    return (
                      <div key={day}
                        onMouseEnter={function(e) {
                          if (!hasAny && !hasViewing) return;
                          var rect = e.currentTarget.getBoundingClientRect();
                          setTooltip({ x: rect.left + rect.width/2, y: rect.bottom + 6, dateStr: dateStr, dayBookings: dayBookings, views: showViewings ? (viewingsByDate[dateStr]||[]) : [] });
                        }}
                        onMouseLeave={function() { setTooltip(null); }}
                        style={{ position:"relative", textAlign:"center", padding:"4px 1px 10px", borderRadius:4, background:cellBg, border:`1px solid ${cellBorder}`, cursor:hasAny||hasViewing?"pointer":"default", outline:isToday?`2px solid ${T.accent}`:"none" }}>
                        <span style={{ fontSize:11, fontWeight:isToday||hasAny?700:400, color:isSat||isSun?T.textLight:cellText }}>
                          {day}
                        </span>
                        {hasViewing && (
                          <div style={{ position:"absolute", top:1, left:2, width:5, height:5, borderRadius:"50%", background:"#7c3aed" }}/>
                        )}
                        {hasAny && (
                          <div style={{ position:"absolute", bottom:2, left:"50%", transform:"translateX(-50%)", width:dayBookings.length>1?20:14, height:6, borderRadius:3, background:lozengeBg, display:"flex", alignItems:"center", justifyContent:"center" }}>
                            {dayBookings.length>1 && <span style={{ fontSize:7, fontWeight:700, color:"#fff", lineHeight:1 }}>{dayBookings.length}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Booking list for this month — click to open the booking */}
                {Object.entries(byDate).filter(([d])=>d.startsWith(`${year}-${monthNum}`)).sort().map(([d, bks])=>(
                  bks.map(b => {
                    const s = getBookingStyle(b);
                    return (
                      <div key={b.id} onClick={()=>openBooking(b.id)} title={`Open ${b.couple}`}
                        style={{ marginTop:4, padding:"2px 6px", borderRadius:4, background:s.bg, border:`1px solid ${s.border}`, display:"flex", alignItems:"center", gap:4, cursor:"pointer" }}>
                        <span style={{ fontSize:10, fontWeight:700, color:s.text, flexShrink:0 }}>{new Date(d+"T00:00:00").getDate()}</span>
                        <span style={{ fontSize:10, color:s.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{b.couple}</span>
                      </div>
                    );
                  })
                ))}
                {showViewings && Object.entries(viewingsByDate).filter(([d])=>d.startsWith(`${year}-${monthNum}`)).sort().map(([d, views])=>(
                  views.map((v,vi) => (
                    <div key={d+vi} onClick={()=>openViewing(v)} title={`Open ${v.label} (${v.source})`}
                      style={{ marginTop:3, padding:"2px 6px", borderRadius:4, background:"#f3e8ff", border:"1px solid #c4b5fd", display:"flex", alignItems:"center", gap:4, cursor:"pointer" }}>
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

      {/* Hover tooltip */}
      {tooltip && (
        <div style={{ position:"fixed", left: Math.max(8, Math.min(tooltip.x - 130, (typeof window!=="undefined"?window.innerWidth:800) - 270)), top: tooltip.y, zIndex:9999, background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"10px 14px", boxShadow:"0 8px 28px rgba(37,99,235,.18)", minWidth:220, maxWidth:280, pointerEvents:"none" }}>
          <div style={{ fontSize:10, fontWeight:700, color:T.textMid, marginBottom:7, paddingBottom:6, borderBottom:`1px solid #eef3fa`, textTransform:"uppercase", letterSpacing:.4 }}>
            {new Date(tooltip.dateStr+"T00:00:00").toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}
          </div>
          {tooltip.dayBookings.map(function(b) {
            var props = getBookedProps(b);
            return (
              <div key={b.id} style={{ marginBottom:8, paddingBottom:8, borderBottom:`1px solid #f0f4fb` }}>
                <div style={{ fontSize:13, fontWeight:700, color:T.text }}>{b.couple}</div>
                <div style={{ fontSize:11, color:T.textMid, marginTop:2 }}>{b.eventType || "Event"}</div>
                {props.length > 0 && (
                  <div style={{ fontSize:11, color:T.accent, marginTop:3 }}>{props.join(" + ")}</div>
                )}
                <div style={{ fontSize:11, color: b.status==="Holding" ? "#d97706" : b.date < tooltip.dateStr.slice(0,10) ? T.textLight : T.green, marginTop:2, fontWeight:600 }}>{b.status}</div>
              </div>
            );
          })}
          {tooltip.views.map(function(v, i) {
            return (
              <div key={i} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                <span style={{ width:7, height:7, borderRadius:"50%", background:"#7c3aed", flexShrink:0, display:"inline-block" }}/>
                <span style={{ fontSize:11, color:"#6d28d9" }}>{v.label} <span style={{ opacity:.65 }}>(viewing)</span></span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AccommodationReport({ bookings, accomBookings, accomProperties }) {
  // Wedding events sorted by date
  var rows = bookings.filter(function(b){ return b.couple && b.date; })
    .sort(function(a,z){ return a.date > z.date ? 1 : -1; });

  // For each event, find linked lettings bookings (check-in within 7 days)
  var rowsWithAccom = rows.map(function(b) {
    return { event:b, linked: findLinkedAccom(b.date, accomBookings, 7, b.endDate) };
  });

  // Stats: count events that have at least one linked accom booking + total revenue
  var linkedEvents = rowsWithAccom.filter(function(r){ return r.linked.length > 0; });
  var totalAccomRevenue = accomBookings.filter(function(b){ return b.status!=="cancelled"; })
    .reduce(function(s,b){ return s + (Number(b.value)||0); }, 0);

  // Per-property stats
  var propStats = {};
  (accomProperties||[]).forEach(function(p) { propStats[p.id] = { count:0, revenue:0 }; });
  accomBookings.filter(function(b){ return b.status!=="cancelled"; }).forEach(function(b) {
    var stays = (b.stays&&b.stays.length) ? b.stays : [b];
    var perStay = (Number(b.value)||0) / (stays.length||1);
    stays.forEach(function(s) {
      if (!propStats[s.propertyId]) propStats[s.propertyId] = { count:0, revenue:0 };
      propStats[s.propertyId].count++;
      propStats[s.propertyId].revenue += perStay;
    });
  });

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr " + (accomProperties||[]).map(function(){ return "1fr"; }).join(" "), gap:16, marginBottom:22, flexWrap:"wrap" }}>
        <StatCard label="Events with Accom" value={linkedEvents.length} sub={rows.length + " events total"}/>
        <StatCard label="Total Accom Revenue" value={fmtMoney(totalAccomRevenue)} sub="all non-cancelled bookings"/>
        {(accomProperties||[]).map(function(p) {
          var st = propStats[p.id] || { count:0, revenue:0 };
          return (
            <StatCard key={p.id} label={p.name} value={st.count + " stays"} sub={fmtMoney(st.revenue)}/>
          );
        })}
      </div>

      {/* Per-event table */}
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <div style={{ padding:"10px 14px", background:"#eef4fd", borderBottom:`1px solid ${T.border}`, fontSize:11, fontWeight:700, color:T.textMid, textTransform:"uppercase", letterSpacing:1 }}>
          Events and linked lettings bookings
        </div>
        {rowsWithAccom.map(function(row, i) {
          var ev = row.event;
          var linked = row.linked;
          return (
            <div key={ev.id} style={{ borderTop: i>0 ? `1px solid ${T.border}` : "none", padding:"12px 14px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom: linked.length ? 8 : 0 }}>
                <span style={{ fontSize:12, color:T.accent, fontWeight:600, minWidth:90 }}>{fmtDate(ev.date)}</span>
                <span style={{ fontSize:14, fontWeight:700, color:T.text }}>{ev.couple}</span>
                {ev.eventType && <span style={{ fontSize:11, color:T.midBlue, background:T.midBlueBg, padding:"1px 7px", borderRadius:5, fontWeight:600 }}>{ev.eventType}</span>}
                {!linked.length && <span style={{ fontSize:11, color:T.textLight, fontStyle:"italic" }}>No lettings bookings linked</span>}
              </div>
              {linked.length > 0 && (
                <div style={{ paddingLeft:102, display:"flex", flexDirection:"column", gap:6 }}>
                  {linked.map(function(ab) {
                    var stays = (ab.stays&&ab.stays.length) ? ab.stays : [ab];
                    var paidAmt = (ab.schedule||[]).filter(function(s){ return s.paid; }).reduce(function(sum,s){ return sum+(Number(s.amount)||0); }, 0);
                    var outstanding = (Number(ab.value)||0) - paidAmt;
                    return (
                      <div key={ab.id} style={{ background:T.bgInput, border:`1px solid ${T.border}`, borderRadius:7, padding:"8px 12px", fontSize:12 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                          <span style={{ fontWeight:600, color:T.text }}>{ab.guestName||"(no name)"}</span>
                          {stays.map(function(s, si) {
                            var prop = (accomProperties||[]).find(function(p){ return p.id===s.propertyId; });
                            return (
                              <span key={si} style={{ display:"inline-flex", alignItems:"center", gap:4, color:T.textMid }}>
                                {prop && <span style={{ width:7, height:7, borderRadius:"50%", background:prop.colour, display:"inline-block" }}/>}
                                {s.propertyName||s.propertyId}
                                {" "}{fmtDate(s.checkIn)}–{fmtDate(s.checkOut)}
                              </span>
                            );
                          })}
                          <span style={{ marginLeft:"auto", fontWeight:700, color:T.text }}>{fmtMoney(Number(ab.value)||0)}</span>
                          {outstanding <= 0 && (Number(ab.value)||0) > 0
                            ? <span style={{ fontSize:11, fontWeight:700, color:T.green, background:T.greenBg, padding:"1px 7px", borderRadius:5 }}>Paid</span>
                            : outstanding > 0
                              ? <span style={{ fontSize:11, fontWeight:700, color:T.amber, background:T.amberBg, padding:"1px 7px", borderRadius:5 }}>{fmtMoney(outstanding)} outstanding</span>
                              : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!rows.length && <div style={{ padding:24, textAlign:"center", color:T.textLight, fontSize:13 }}>No bookings yet.</div>}
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
        <button onClick={()=>window.print()} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
      </div>
    <div style={{ overflowX:"auto" }}>
      <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, overflow:"hidden", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead><tr style={{ background:"#eef4fd" }}>{["Date","Couple","Friday Set-Up","Day Manager","Bar Sup","Day Staff","Bar","Day Handy","Eve Handy"].map(h=><th key={h} style={{ padding:"10px 12px", textAlign:"left", color:T.textMid, fontSize:11, letterSpacing:1.1, textTransform:"uppercase", fontWeight:700 }}>{h}</th>)}</tr></thead>
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
        <button onClick={()=>window.print()} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
      </div>
      <p style={{ color:T.textMid, fontSize:13, marginBottom:18 }}>Upcoming bookings with outstanding balance (deposit is advance on venue fee)</p>
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {rows.map(b=>{
          const fee=parseMoney(b.venueFee),dep=parseMoney(b.deposit),balance=Math.max(0,fee-dep),pct=fee>0?Math.min(100,Math.round((dep/fee)*100)):0;
          return (
            <div key={b.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"16px 20px", boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                <div><div style={{ fontWeight:600, color:T.text }}>{b.couple}</div><div style={{ fontSize:12, color:T.textLight }}>{fmtDate(b.date)}</div></div>
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
    ...workload.filter(w=>w.count>0).map(w=>`${w.name} (${w.role}): ${w.count} upcoming\n  ${Object.entries(w.roles).map(([r,c])=>`${r==="setup"?"Friday Set-Up":STAFFING_LABELS[r]}: ${c}`).join(", ")}`)
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
        <button onClick={()=>window.print()} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
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
                  <span key={role} style={{ fontSize:11, background:T.accentLight, border:`1px solid ${T.border}`, borderRadius:4, padding:"2px 8px", color:T.accent, fontWeight:600 }}>{role==="setup"?"Friday Friday Set-Up":STAFFING_LABELS[role]}: {cnt}</span>
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
    if (val === "") delete updated[id];
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
  const eventsForStaff = (id) => filtered.filter(b => (b.hoursWorked||{})[id] > 0).sort((a,b)=>a.date>b.date?1:-1);
  const monthLabel = m => new Date(m+"-01").toLocaleDateString("en-GB",{month:"short",year:"numeric"});

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}>
        <button onClick={()=>window.print()} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
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
                                <td style={{ padding:"8px 16px", fontSize:12, color:T.accent, fontWeight:500 }}>{fmtDate(b.date)}</td>
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

// ─── Dashboard (Slice 2) ──────────────────────────────────────────────────────
function DashboardView({ bookings, viewingRequests, setView }) {
  const [accomBookings, setAccomBookings] = useState([]);
  const [emailLog, setEmailLog]           = useState([]);
  const [loaded, setLoaded]               = useState(false);

  useEffect(()=>{
    (async()=>{
      try { const b = await sbGet(ACCOM_STORAGE); setAccomBookings((b||[]).map(normalizeAccom)); } catch { setAccomBookings([]); }
      try { const l = await sbGet(EMAIL_LOG_STORAGE); setEmailLog(l||[]); } catch { setEmailLog([]); }
      setLoaded(true);
    })();
  }, []);

  const today = new Date().toISOString().slice(0,10);
  const in7   = new Date(Date.now() + 7*86400000).toISOString().slice(0,10);

  // Upcoming wedding events in next 7 days
  const upcomingEvents = bookings
    .filter(b => b.couple && b.date && b.date >= today && b.date <= in7)
    .sort((a,b)=>a.date>b.date?1:-1);

  // Upcoming accom check-ins in next 7 days
  const upcomingCheckIns = accomBookings.filter(b => {
    if (b.status==="cancelled") return false;
    const stays = b.stays||[];
    return stays.some(s => s.checkIn && s.checkIn>=today && s.checkIn<=in7);
  }).sort((a,z)=>{
    const aCI = (a.stays||[]).map(s=>s.checkIn||"").filter(d=>d>=today).sort()[0] || "9999";
    const zCI = (z.stays||[]).map(s=>s.checkIn||"").filter(d=>d>=today).sort()[0] || "9999";
    return aCI > zCI ? 1 : aCI < zCI ? -1 : 0;
  });

  // Pending viewing requests
  const pendingViewings = (viewingRequests||[]).filter(r=>r.status==="pending");

  // Overdue accom payments: schedule entries where paid=false AND dueDate < today AND booking not cancelled
  const overduePayments = [];
  accomBookings.forEach(b => {
    if (b.status==="cancelled") return;
    (b.schedule||[]).forEach(s => {
      if (!s.paid && s.dueDate && s.dueDate < today) {
        overduePayments.push({ booking:b, entry:s });
      }
    });
  });

  const sectionStyle = { background:"#fff", border:`1px solid ${T.border}`, borderRadius:12, padding:"20px 22px", boxShadow:"0 2px 8px rgba(37,99,235,.06)", marginBottom:18 };
  const secHead = (label, count, colour) => (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
      <h3 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:15 }}>{label}</h3>
      {count!=null && <span style={{ fontSize:12, fontWeight:700, color:colour||T.textMid, background: colour ? colour+"22" : T.bgInput, padding:"2px 10px", borderRadius:8 }}>{count}</span>}
    </div>
  );

  const fmtDay = (d) => d ? new Date(d+"T00:00:00").toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}) : "—";

  return (
    <div style={{ maxWidth:1100, margin:"0 auto", padding:"28px 28px 60px" }}>
      <h2 style={{ fontSize:22, fontWeight:800, color:T.text, margin:"0 0 6px" }}>Home</h2>
      <p style={{ color:T.textMid, fontSize:13, margin:"0 0 24px" }}>Today: {fmtDay(today)}</p>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:18 }}>

        {/* Upcoming events */}
        <div style={sectionStyle}>
          {secHead("Upcoming Events — next 7 days", upcomingEvents.length, upcomingEvents.length?T.green:null)}
          {!loaded && <div style={{ color:T.textLight, fontSize:13 }}>Loading…</div>}
          {loaded && upcomingEvents.length===0 && <div style={{ color:T.textLight, fontSize:13 }}>No events this week.</div>}
          {upcomingEvents.map(b=>(
            <div key={b.id} onClick={()=>setView("list")} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:`1px solid #f0f6ff`, cursor:"pointer" }}>
              <span style={{ fontSize:11, fontWeight:700, color:T.accent, background:T.accentLight, padding:"2px 8px", borderRadius:6, flexShrink:0 }}>{fmtDay(b.date)}</span>
              <span style={{ fontSize:13, fontWeight:600, color:T.text }}>{b.couple}</span>
              {b.eventType && <span style={{ fontSize:10, color:T.textLight }}>{b.eventType}</span>}
            </div>
          ))}
        </div>

        {/* Upcoming accom check-ins */}
        <div style={sectionStyle}>
          {secHead("Accom Check-ins — next 7 days", upcomingCheckIns.length, upcomingCheckIns.length?T.green:null)}
          {!loaded && <div style={{ color:T.textLight, fontSize:13 }}>Loading…</div>}
          {loaded && upcomingCheckIns.length===0 && <div style={{ color:T.textLight, fontSize:13 }}>No check-ins this week.</div>}
          {upcomingCheckIns.map(b=>{
            const nextStay = (b.stays||[]).filter(s=>s.checkIn&&s.checkIn>=today&&s.checkIn<=in7).sort((a,z)=>a.checkIn>z.checkIn?1:-1)[0];
            return (
              <div key={b.id} onClick={()=>setView("lettings")} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:`1px solid #f0f6ff`, cursor:"pointer" }}>
                <span style={{ fontSize:11, fontWeight:700, color:T.green, background:T.greenBg, padding:"2px 8px", borderRadius:6, flexShrink:0 }}>{fmtDay(nextStay&&nextStay.checkIn)}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{b.guestName||"(no name)"}</div>
                  <div style={{ fontSize:11, color:T.textLight }}>{(b.stays||[]).map(s=>s.propertyName||s.propertyId).join(" + ")}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Pending viewing requests */}
        <div style={sectionStyle}>
          {secHead("Viewing Requests", pendingViewings.length, pendingViewings.length?T.amber:null)}
          {pendingViewings.length===0 && <div style={{ color:T.textLight, fontSize:13 }}>No unresponded requests.</div>}
          {pendingViewings.slice(0,6).map((r,i)=>(
            <div key={r.id||i} onClick={()=>setView("viewings")} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:`1px solid #f0f6ff`, cursor:"pointer" }}>
              <span style={{ fontSize:11, fontWeight:700, color:T.amber, background:T.amberBg, padding:"2px 8px", borderRadius:6, flexShrink:0 }}>Pending</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600, color:T.text }}>{r.name||"(no name)"}</div>
                <div style={{ fontSize:11, color:T.textLight }}>{r.eventType||""}{r.date?" - "+fmtDay(r.date):""}</div>
              </div>
            </div>
          ))}
          {pendingViewings.length>6 && <div style={{ fontSize:12, color:T.accent, marginTop:8, cursor:"pointer" }} onClick={()=>setView("viewings")}>+ {pendingViewings.length-6} more</div>}
        </div>

        {/* Overdue payments */}
        <div style={sectionStyle}>
          {secHead("Overdue Accom Payments", overduePayments.length, overduePayments.length?T.red:null)}
          {!loaded && <div style={{ color:T.textLight, fontSize:13 }}>Loading…</div>}
          {loaded && overduePayments.length===0 && <div style={{ color:T.textLight, fontSize:13 }}>No overdue payments.</div>}
          {overduePayments.slice(0,8).map(({ booking:b, entry:s },i)=>(
            <div key={b.id+"-"+i} onClick={()=>setView("lettings")} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 0", borderBottom:`1px solid #f0f6ff`, cursor:"pointer" }}>
              <span style={{ fontSize:11, fontWeight:700, color:T.red, background:T.redBg, padding:"2px 8px", borderRadius:6, flexShrink:0 }}>Due {fmtDay(s.dueDate)}</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600, color:T.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{b.guestName||"(no name)"} — {s.label}</div>
                <div style={{ fontSize:11, color:T.red, fontWeight:600 }}>{fmtMoney(s.amount)}</div>
              </div>
            </div>
          ))}
          {overduePayments.length>8 && <div style={{ fontSize:12, color:T.accent, marginTop:8, cursor:"pointer" }} onClick={()=>setView("lettings")}>+ {overduePayments.length-8} more</div>}
        </div>
      </div>

      {/* Email log */}
      <div style={sectionStyle}>
        {secHead("Recent Automated Emails", emailLog.length||null)}
        {emailLog.length===0 && (
          <div style={{ color:T.textLight, fontSize:13 }}>No emails logged yet. When the system sends automated emails (phase 2), they will appear here.</div>
        )}
        {emailLog.slice().reverse().slice(0,10).map(e=>(
          <div key={e.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 0", borderBottom:`1px solid #f0f6ff`, fontSize:13 }}>
            <span style={{ color:T.textLight, fontSize:11, flexShrink:0 }}>{e.sentAt ? new Date(e.sentAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "—"}</span>
            <span style={{ fontWeight:600, color:T.text, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{e.subject||"(no subject)"}</span>
            <span style={{ color:T.textLight, fontSize:11 }}>{e.to||""}</span>
            {e.opened && <span style={{ fontSize:10, fontWeight:700, color:T.green, background:T.greenBg, padding:"1px 6px", borderRadius:6 }}>Opened</span>}
          </div>
        ))}
      </div>
    </div>
  );
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
        <button onClick={()=>window.print()} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
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

  const handlePrint = () => {
    const win = window.open("", "_blank");
    if (!win) return;
    const tableRows = rows.map(r =>
      `<tr>
        <td>${r.name}</td>
        <td>${r.category}</td>
        <td>${r.opening}</td>
        <td>${r.ordered > 0 ? "+"+r.ordered : "0"}</td>
        <td>${r.closing}</td>
        <td style="font-weight:700;color:${r.used<0?"#c0392b":r.used>0?"#111":"#aaa"}">${r.used}</td>
        <td>${r.costUnit!=null?"£"+r.costUnit.toFixed(2):"—"}</td>
        <td>${r.costVal!=null&&r.used>0?"£"+r.costVal.toFixed(2):"—"}</td>
        <td>${r.saleVal!=null&&r.used>0?"£"+r.saleVal.toFixed(2):"—"}</td>
      </tr>`
    ).join("");
    win.document.write(`<!DOCTYPE html><html><head><title>Bar Usage Report</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 12px; color: #222; padding: 24px; }
      h1 { font-size: 20px; margin-bottom: 4px; }
      .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
      .summary { display: flex; gap: 32px; margin-bottom: 24px; }
      .summary div { border: 1px solid #ddd; border-radius: 6px; padding: 12px 18px; min-width: 140px; }
      .summary .label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 4px; }
      .summary .val { font-size: 22px; font-weight: 700; color: #1e40af; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #f0f4ff; padding: 8px 10px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #555; border-bottom: 2px solid #ddd; }
      td { padding: 7px 10px; border-bottom: 1px solid #eee; }
      tr:nth-child(even) td { background: #fafafa; }
      @media print { button { display: none; } }
    </style>
    </head><body>
    <h1>Bar Usage Report</h1>
    <div class="sub">${fromST.date} (${fromST.label}) &rarr; ${toST.date} (${toST.label})</div>
    <div class="summary">
      <div><div class="label">Products Used</div><div class="val">${totUsed}</div></div>
      <div><div class="label">Est. Cost of Stock</div><div class="val">£${totCost.toFixed(2)}</div></div>
      <div><div class="label">Est. Sale Value</div><div class="val">£${totSale.toFixed(2)}</div></div>
      ${totCost>0?`<div><div class="label">Implied Margin</div><div class="val">${Math.round((1-totCost/totSale)*100)}%</div></div>`:""}
    </div>
    <table>
      <thead><tr>
        <th>Product</th><th>Category</th><th>Opening</th><th>Ordered</th>
        <th>Closing</th><th>Used</th><th>Buy Price</th><th>Cost of Usage</th><th>Est. Sale Value</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <p style="margin-top:24px;color:#aaa;font-size:11px">Hawthbush Farm Bar Usage Report — printed ${new Date().toLocaleDateString("en-GB")}</p>
    </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 500);
  };

  return (
    <div>
      {/* Print button */}
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}>
        <button onClick={handlePrint} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
      </div>
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
const VR_STORAGE        = "hbf_viewing_requests_v1";
const VB_STORAGE        = "hbf_viewing_blocks_v1";

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
    // Exclude Friday Set-Up staff — they work the day before, not the event day
    const setupIds = new Set(b.setup || []);
    const entries = Object.entries(shifts).filter(([id,sh]) => sh.start && sh.end && !setupIds.has(id));
    if (entries.length === 0) return <p style={{ color:T.textLight, fontSize:13 }}>No shift times set for this booking.</p>;

    // Parse time to minutes from a base of 08:00.
    // Times < 06:00 are treated as next-day (i.e. 00:30 = 24:30 = 1470 mins)
    // This handles typical event spans of 08:00 to ~01:00 next day.
    const toMins = t => {
      const [h,m] = t.split(":").map(Number);
      const mins = h*60 + m;
      // If hour < 6, assume it's past midnight (next day)
      return mins < 360 ? mins + 1440 : mins;
    };

    const allMins = entries.flatMap(([,sh]) => [toMins(sh.start), toMins(sh.end)]);
    const minTime = Math.floor(Math.min(...allMins) / 60) * 60;
    const maxTime = Math.ceil(Math.max(...allMins) / 60) * 60;
    const totalSpan = maxTime - minTime;

    const hours = [];
    for (let m = minTime; m <= maxTime; m += 60) {
      hours.push(m);
    }

    return (
      <div>
        {/* Hour ruler */}
        <div style={{ display:"flex", marginLeft:160, marginBottom:8 }}>
          {hours.map(m => {
            const displayH = Math.floor(m/60) % 24; // wrap past midnight
            const isNextDay = Math.floor(m/60) >= 24;
            return (
              <div key={m} style={{ flex:1, fontSize:11, color:isNextDay?T.accent:T.textLight, fontWeight:600, textAlign:"left", borderLeft:`1px solid ${T.border}`, paddingLeft:4 }}>
                {String(displayH).padStart(2,"0")}:00{isNextDay?" +1":""}
              </div>
            );
          })}
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
              const roleLabel = role === "setup" ? "Friday Set-Up" : role ? STAFFING_LABELS[role] : "";

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
        <button onClick={()=>window.print()} style={{ background:T.midBlueBg, border:`1px solid ${T.border}`, color:T.midBlue, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>🖨 Print / Save as PDF</button>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:22, flexWrap:"wrap" }}>
        <h3 style={{ margin:0, color:T.midBlue, fontWeight:700, fontSize:17 }}>Staff Timeline</h3>
        <select value={selectedBooking||""} onChange={e=>setSelectedBooking(Number(e.target.value)||e.target.value)}
          style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:14, padding:"7px 12px", outline:"none", flex:1, maxWidth:400 }}>
          {upcoming.length > 0 && <optgroup label="Upcoming">
            {upcoming.map(b=><option key={b.id} value={b.id}>{fmtDate(b.date)} — {b.couple}</option>)}
          </optgroup>}
          {past.length > 0 && <optgroup label="Past">
            {past.map(b=><option key={b.id} value={b.id}>{fmtDate(b.date)} — {b.couple}</option>)}
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
                  <div style={{ fontSize:13, color:T.textLight }}>{fmtDate(booking.date)}</div>
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
            <span style={{ fontSize:13, fontWeight:700, color:"#6d28d9" }}>📅 {v.date?fmtDate(v.date):"No date"}{v.time ? " · "+v.time : ""}</span>
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

// ─── VIEWING REQUESTS INBOX ───────────────────────────────────────────────────
const VIEWING_SLOTS = ["10:00","12:00","14:00","16:00","18:00"];

function ViewingRequestsInbox({ requests, setRequests, blocks, setBlocks, bookings, enquiries, saveEnquiries, saveBookings, mode="requests", confirmedSlot=null }) {
  const [acting, setActing]         = useState(null);
  const [blockDate,   setBlockDate]   = useState("");
  const [blockDateTo, setBlockDateTo] = useState("");
  const [blockSlot,   setBlockSlot]   = useState("");
  const [blockNote,   setBlockNote]   = useState("");
  const [flash, setFlash]           = useState(null);
  // Confirm modal state
  const [confirmModal, setConfirmModal]   = useState(null); // { req } or null
  const [enqMode, setEnqMode]             = useState("new");  // "new" | "existing" | "booking"
  const [enqSearch, setEnqSearch]         = useState("");
  const [selectedEnqId, setSelectedEnqId] = useState("");
  const [selectedBkgId, setSelectedBkgId] = useState("");
  // Decline modal state
  const [declineModal, setDeclineModal]   = useState(null); // { req } or null
  const [declineReason, setDeclineReason] = useState("");
  // Delete modal state (removes a request without sending any email)
  const [deleteModal, setDeleteModal]     = useState(null); // { req } or null

  const showFlash = (msg, col=T.green) => { setFlash({msg,col}); setTimeout(()=>setFlash(null),3000); };

  const saveRequests = async (updated) => {
    setRequests(updated);
    await sbSet(VR_STORAGE, updated);
  };
  const saveBlocks = async (updated) => {
    setBlocks(updated);
    await sbSet(VB_STORAGE, updated);
  };

  // Opens the confirm modal instead of acting immediately
  const handleConfirmClick = (req) => {
    // Pre-search by email to see if there's likely a match
    const match = (enquiries||[]).find(e =>
      e.email && req.email && e.email.toLowerCase() === req.email.toLowerCase()
    );
    setEnqMode(match ? "existing" : "new");
    setSelectedEnqId(match ? match.id : "");
    setEnqSearch(req.name || "");
    setConfirmModal({ req });
  };

  const handleDeclineClick = (req) => {
    setDeclineReason("");
    setDeclineModal({ req });
  };

  const handleDeleteClick = (req) => setDeleteModal({ req });

  // Remove a request entirely — no email is sent (for test/duplicate requests)
  const handleDeleteRequest = async (req) => {
    const updated = requests.filter(r => r.id !== req.id);
    await saveRequests(updated);
    setDeleteModal(null);
    showFlash("Request deleted", T.textMid);
  };

  const handleAction = async (req, action, mode, existingEnqId, declineMsg) => {
    setActing(req.id);
    try {
      // Send email via Netlify function
      const res = await fetch("/.netlify/functions/handle-viewing", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ id: req.id, action, declineReason: declineMsg||"" }),
      });
      if (!res.ok) throw new Error("Function failed");

      // Update request status
      const updatedRequests = requests.map(r => r.id===req.id ? {...r, status: action==="confirm"?"confirmed":"declined"} : r);
      await saveRequests(updatedRequests);

      if (action === "confirm") {
        const newViewing = {
          id: `v_${Date.now()}`,
          date: req.date,
          time: req.time,
          notes: ("Confirmed from website request. " + (req.notes||"")).trim(),
          outcome: "pending",
        };

        if (mode === "booking" && existingEnqId) {
          // Attach viewing to existing booking
          const bkgId = Number(existingEnqId) || existingEnqId;
          const updatedBookings = (bookings||[]).map(b =>
            (b.id === bkgId || b.id === Number(bkgId))
              ? { ...b, viewings: [...(b.viewings||[]), newViewing] }
              : b
          );
          if (saveBookings) await saveBookings(updatedBookings);
          const bkg = (bookings||[]).find(b=>b.id===bkgId||b.id===Number(bkgId));
          showFlash("Confirmed - viewing added to booking: " + (bkg?.couple||""));
        } else if (mode === "existing" && existingEnqId) {
          // Attach viewing to existing enquiry
          const updatedEnq = (enquiries||[]).map(e =>
            e.id === existingEnqId
              ? { ...e, viewings: [...(e.viewings||[]), newViewing] }
              : e
          );
          await saveEnquiries(updatedEnq);
          const enq = (enquiries||[]).find(e=>e.id===existingEnqId);
          showFlash("Confirmed - viewing added to " + (enq?.name||"existing enquiry"));
        } else {
          // Create new enquiry
          const newEnq = {
            id: `enq_${Date.now()}`,
            name: req.name,
            email: req.email,
            phone: req.phone || "",
            eventType: req.eventType || "Wedding",
            numbers: (req.dayGuests && req.eveGuests) ? `Day: ${req.dayGuests}, Eve: ${req.eveGuests}` : req.dayGuests || req.eveGuests || "",
            datePreference: req.preferredDate || "",
            source: req.source || "Website viewing request",
            notes: req.notes || "",
            temperature: "warm",
            outcome: "undecided",
            contacts: [],
            viewings: [newViewing],
          };
          await saveEnquiries([...(enquiries||[]), newEnq]);
          showFlash("Confirmed - new enquiry created for " + req.name);
        }
      } else {
        showFlash("Declined - apology email sent to " + req.name, T.amber);
      }
    } catch(e) {
      showFlash("Something went wrong: " + e.message, T.red);
    } finally {
      setActing(null);
      setConfirmModal(null);
    }
  };

  const addBlock = async () => {
    if (!blockDate) return;
    const newBlocks = [];
    if (blockDateTo && blockDateTo > blockDate) {
      // Expand date range into individual day blocks
      const cur = new Date(blockDate + "T00:00:00");
      const end = new Date(blockDateTo + "T00:00:00");
      while (cur <= end) {
        const ds = cur.toISOString().slice(0,10);
        newBlocks.push({ id:`blk_${Date.now()}_${ds}`, date:ds, slot:blockSlot||null, note:blockNote||"", addedAt:new Date().toISOString() });
        cur.setDate(cur.getDate()+1);
      }
    } else {
      newBlocks.push({ id:`blk_${Date.now()}`, date:blockDate, slot:blockSlot||null, note:blockNote||"", addedAt:new Date().toISOString() });
    }
    const updated = [...blocks, ...newBlocks];
    await saveBlocks(updated);
    setBlockDate(""); setBlockDateTo(""); setBlockSlot(""); setBlockNote("");
    showFlash(newBlocks.length > 1 ? "Blocked " + newBlocks.length + " days" : "Block added");
  };

  const removeBlock = async (id) => {
    await saveBlocks(blocks.filter(b=>b.id!==id));
  };

  const pending   = requests.filter(r=>r.status==="pending");
  const confirmed = requests.filter(r=>r.status==="confirmed");
  const declined  = requests.filter(r=>r.status==="declined");

  const statusBadge = (s) => {
    const styles = {
      pending:   { bg:"#fef9c3", color:"#92400e", label:"Pending" },
      confirmed: { bg:T.greenBg, color:T.green,   label:"Confirmed" },
      declined:  { bg:T.redBg,   color:T.red,     label:"Declined" },
    };
    const st = styles[s] || styles.pending;
    return <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:10, background:st.bg, color:st.color }}>{st.label}</span>;
  };

  const tabData = { pending, confirmed, declined };
  const pendingRows  = [...pending].sort((a,b)=>a.date>b.date?1:-1);
  const declinedRows = [...declined].sort((a,b)=>a.date>b.date?1:-1);

  // A single request card (used in the Pending and Declined sections)
  const renderReqCard = (req) => {
    const niceDate = fmtDate(req.date);
    return (
      <div key={req.id} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"16px 20px", boxShadow:"0 2px 6px rgba(37,99,235,.06)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, flexWrap:"wrap" }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6, flexWrap:"wrap" }}>
              <span style={{ fontWeight:700, fontSize:15, color:T.text }}>{req.name}</span>
              {statusBadge(req.status)}
              <span style={{ fontSize:12, color:T.textLight }}>{req.submittedAt ? new Date(req.submittedAt).toLocaleDateString("en-GB") : ""}</span>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:"4px 16px", fontSize:13, color:T.textMid }}>
              <span>Date: {niceDate} at {req.time}</span>
              {req.eventType && <span>Event type: {req.eventType}</span>}
              <span>Email: {req.email}</span>
              {req.phone && <span>Phone: {req.phone}</span>}
              {req.dayGuests && <span>Day guests: {req.dayGuests}</span>}
              {req.eveGuests && <span>Eve guests: {req.eveGuests}</span>}
              {req.preferredDate && <span>Year: {req.preferredDate}</span>}
              {req.source && <span>Source: {req.source}</span>}
              {req.midweek && <span style={{ color:T.green, fontWeight:600 }}>Midweek interest</span>}
              {req.ceremony && <span style={{ color:T.green, fontWeight:600 }}>Ceremony onsite</span>}
            </div>
            {req.notes && <div style={{ marginTop:8, fontSize:12, color:T.textMid, fontStyle:"italic", background:T.bgInput, borderRadius:5, padding:"6px 10px" }}>{req.notes}</div>}
          </div>
          <div style={{ display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
            {req.status==="pending" && (<>
              <button onClick={()=>handleConfirmClick(req)} disabled={acting===req.id}
                style={{ background:T.green, color:"#fff", border:"none", padding:"8px 16px", borderRadius:6, cursor:acting===req.id?"wait":"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600, opacity:acting===req.id?0.7:1 }}>
                {acting===req.id?"…":"✓ Confirm"}
              </button>
              <button onClick={()=>handleDeclineClick(req)} disabled={acting===req.id}
                style={{ background:T.redBg, color:T.red, border:`1px solid #fca5a5`, padding:"8px 16px", borderRadius:6, cursor:acting===req.id?"wait":"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
                ✕ Decline
              </button>
            </>)}
            <button onClick={()=>handleDeleteClick(req)} disabled={acting===req.id} title="Delete request (no email sent)"
              style={{ background:"none", color:T.textLight, border:`1px solid ${T.border}`, padding:"8px 12px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
              🗑 Delete
            </button>
          </div>
        </div>
      </div>
    );
  };

  const sectionHeading = (label, count, color) => (
    <div style={{ display:"flex", alignItems:"center", gap:10, margin:"0 0 14px" }}>
      <span style={{ fontSize:12, letterSpacing:1.2, textTransform:"uppercase", color:color, fontWeight:700 }}>{label}</span>
      {count!=null && <span style={{ background:T.bgInput, color:T.textMid, borderRadius:10, padding:"1px 9px", fontSize:11, fontWeight:700 }}>{count}</span>}
      <div style={{ flex:1, height:1, background:T.border }}/>
    </div>
  );

  return (
    <div>
      {flash && <div style={{ position:"fixed", top:20, right:20, zIndex:9999, background:flash.col, color:"#fff", padding:"10px 20px", borderRadius:8, fontWeight:600, fontSize:13, boxShadow:"0 4px 12px rgba(0,0,0,.2)" }}>{flash.msg}</div>}

      {/* Delete modal — removes the request with no email sent */}
      {deleteModal && (() => {
        const req = deleteModal.req;
        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:10000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
            <div style={{ background:"#fff", borderRadius:12, padding:28, maxWidth:440, width:"100%", boxShadow:"0 8px 40px rgba(0,0,0,.2)" }}>
              <h3 style={{ margin:"0 0 6px", fontSize:17, color:T.text }}>Delete Viewing Request</h3>
              <p style={{ fontSize:13, color:T.textLight, margin:"0 0 18px" }}>
                {req.name} — {fmtDate(req.date)} at {req.time}
              </p>
              <p style={{ fontSize:13, color:T.textMid, margin:"0 0 20px" }}>
                This permanently removes the request. <strong>No email is sent</strong> to the requester — use this for test or duplicate requests.
              </p>
              <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
                <button onClick={()=>setDeleteModal(null)}
                  style={{ padding:"9px 20px", border:`1px solid ${T.border}`, borderRadius:6, background:"#fff", color:T.textMid, fontFamily:"inherit", fontSize:13, cursor:"pointer" }}>
                  Cancel
                </button>
                <button onClick={()=>handleDeleteRequest(req)}
                  style={{ padding:"9px 20px", background:T.red, border:"none", borderRadius:6, color:"#fff", fontFamily:"inherit", fontSize:13, fontWeight:600, cursor:"pointer" }}>
                  Delete Request
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Decline modal */}
      {declineModal && (() => {
        const req = declineModal.req;
        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:10000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
            <div style={{ background:"#fff", borderRadius:12, padding:28, maxWidth:460, width:"100%", boxShadow:"0 8px 40px rgba(0,0,0,.2)" }}>
              <h3 style={{ margin:"0 0 6px", fontSize:17, color:T.text }}>Decline Viewing Request</h3>
              <p style={{ fontSize:13, color:T.textLight, margin:"0 0 18px" }}>
                {req.name} — {fmtDate(req.date)} at {req.time}
              </p>
              <div style={{ fontSize:12, fontWeight:700, letterSpacing:1, textTransform:"uppercase", color:T.red, marginBottom:8 }}>Reason for declining</div>
              <textarea
                value={declineReason}
                onChange={e=>setDeclineReason(e.target.value)}
                placeholder="e.g. Unfortunately we are fully booked on that date. We'd love to find an alternative time..."
                rows={4}
                style={{ width:"100%", border:`1.5px solid ${T.border}`, borderRadius:7, padding:"10px 12px", fontFamily:"inherit", fontSize:13, outline:"none", resize:"vertical", marginBottom:16 }}
              />
              <p style={{ fontSize:12, color:T.textLight, marginBottom:16 }}>This message will be included in the decline email sent to {req.name}.</p>
              <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
                <button onClick={()=>setDeclineModal(null)}
                  style={{ padding:"9px 20px", border:`1px solid ${T.border}`, borderRadius:6, background:"#fff", color:T.textMid, fontFamily:"inherit", fontSize:13, cursor:"pointer" }}>
                  Cancel
                </button>
                <button onClick={()=>{ handleAction(req,"decline","new",null,declineReason); setDeclineModal(null); }} disabled={acting===req.id}
                  style={{ padding:"9px 20px", background:T.red, border:"none", borderRadius:6, color:"#fff", fontFamily:"inherit", fontSize:13, fontWeight:600, cursor:"pointer" }}>
                  {acting===req.id?"Sending...":"Decline & Send Email"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Confirm modal */}
      {confirmModal && (() => {
        const req = confirmModal.req;
        const filteredEnqs = (enquiries||[]).filter(e =>
          !enqSearch.trim() ||
          (e.name||"").toLowerCase().includes(enqSearch.toLowerCase()) ||
          (e.email||"").toLowerCase().includes(enqSearch.toLowerCase())
        ).slice(0,8);
        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:10000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
            <div style={{ background:"#fff", borderRadius:12, padding:28, maxWidth:500, width:"100%", boxShadow:"0 8px 40px rgba(0,0,0,.2)" }}>
              <h3 style={{ margin:"0 0 6px", fontSize:17, color:T.text }}>Confirm Viewing</h3>
              <p style={{ fontSize:13, color:T.textLight, margin:"0 0 18px" }}>
                {req.name} — {fmtDate(req.date)} at {req.time}
              </p>
              <div style={{ fontSize:12, fontWeight:700, letterSpacing:1, textTransform:"uppercase", color:T.midBlue, marginBottom:10 }}>Enquiry</div>
              <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
                {[["new","+ New enquiry"],["existing","Existing enquiry"],["booking","Existing booking"]].map(([m,l])=>(
                  <button key={m} onClick={()=>{ setEnqMode(m); setSelectedEnqId(""); setSelectedBkgId(""); }}
                    style={{ flex:1, minWidth:120, padding:"9px 0", border:`2px solid ${enqMode===m?T.midBlue:T.border}`, borderRadius:7, background:enqMode===m?T.midBlueBg:"#fff", color:enqMode===m?T.midBlue:T.textMid, fontFamily:"inherit", fontSize:12, fontWeight:600, cursor:"pointer" }}>
                    {l}
                  </button>
                ))}
              </div>
              {enqMode==="existing" && (
                <div style={{ marginBottom:16 }}>
                  <input type="text" value={enqSearch} onChange={e=>{ setEnqSearch(e.target.value); setSelectedEnqId(""); }}
                    placeholder="Search enquiries by name or email..."
                    style={{ width:"100%", border:`1.5px solid ${T.border}`, borderRadius:6, padding:"8px 11px", fontFamily:"inherit", fontSize:13, outline:"none", marginBottom:8 }}/>
                  <div style={{ maxHeight:160, overflowY:"auto", border:`1px solid ${T.border}`, borderRadius:7 }}>
                    {filteredEnqs.length===0 && <div style={{ padding:"10px 14px", fontSize:13, color:T.textLight }}>No enquiries found</div>}
                    {filteredEnqs.map(e=>(
                      <div key={e.id} onClick={()=>setSelectedEnqId(e.id)}
                        style={{ padding:"9px 14px", cursor:"pointer", background:selectedEnqId===e.id?T.midBlueBg:"#fff", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <div>
                          <div style={{ fontSize:13, fontWeight:600, color:T.text }}>{e.name}</div>
                          <div style={{ fontSize:11, color:T.textLight }}>{e.email}{e.datePreference?" · "+e.datePreference:""}</div>
                        </div>
                        {selectedEnqId===e.id && <span style={{ color:T.midBlue, fontWeight:700 }}>✓</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {enqMode==="booking" && (
                <div style={{ marginBottom:16 }}>
                  <input type="text" value={enqSearch} onChange={e=>{ setEnqSearch(e.target.value); setSelectedBkgId(""); }}
                    placeholder="Search bookings by couple name..."
                    style={{ width:"100%", border:`1.5px solid ${T.border}`, borderRadius:6, padding:"8px 11px", fontFamily:"inherit", fontSize:13, outline:"none", marginBottom:8 }}/>
                  <div style={{ maxHeight:160, overflowY:"auto", border:`1px solid ${T.border}`, borderRadius:7 }}>
                    {(bookings||[]).filter(b=> !enqSearch.trim() || (b.couple||"").toLowerCase().includes(enqSearch.toLowerCase())).slice(0,8).map(b=>(
                      <div key={b.id} onClick={()=>setSelectedBkgId(String(b.id))}
                        style={{ padding:"9px 14px", cursor:"pointer", background:selectedBkgId===String(b.id)?T.midBlueBg:"#fff", borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <div>
                          <div style={{ fontSize:13, fontWeight:600, color:T.text }}>{b.couple}</div>
                          <div style={{ fontSize:11, color:T.textLight }}>{fmtDate(b.date)}</div>
                        </div>
                        {selectedBkgId===String(b.id) && <span style={{ color:T.midBlue, fontWeight:700 }}>✓</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {enqMode==="new" && (
                <div style={{ padding:"10px 14px", background:T.bgInput, borderRadius:7, fontSize:13, color:T.textMid, marginBottom:16 }}>
                  A new enquiry will be created for <strong>{req.name}</strong> with this viewing attached.
                </div>
              )}
              <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
                <button onClick={()=>setConfirmModal(null)}
                  style={{ padding:"9px 20px", border:`1px solid ${T.border}`, borderRadius:6, background:"#fff", color:T.textMid, fontFamily:"inherit", fontSize:13, cursor:"pointer" }}>
                  Cancel
                </button>
                <button
                  onClick={()=>handleAction(req,"confirm",enqMode, enqMode==="booking"?selectedBkgId:selectedEnqId, "")}
                  disabled={(enqMode==="existing"&&!selectedEnqId)||(enqMode==="booking"&&!selectedBkgId)||acting===req.id}
                  style={{ padding:"9px 20px", background:T.green, border:"none", borderRadius:6, color:"#fff", fontFamily:"inherit", fontSize:13, fontWeight:600, cursor:((enqMode==="existing"&&!selectedEnqId)||(enqMode==="booking"&&!selectedBkgId))||acting===req.id?"not-allowed":"pointer", opacity:((enqMode==="existing"&&!selectedEnqId)||(enqMode==="booking"&&!selectedBkgId))||acting===req.id?0.6:1 }}>
                  {acting===req.id?"Confirming...":"Confirm & Send Email"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Requests mode: Pending → Confirmed → Declined, all on one page ── */}
      {mode==="requests" && (<>
        {sectionHeading("Pending", pendingRows.length, "#92400e")}
        {pendingRows.length===0 && <div style={{ color:T.textLight, fontSize:13, padding:"6px 0 20px" }}>No pending requests.</div>}
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:32 }}>
          {pendingRows.map(renderReqCard)}
        </div>

        {sectionHeading("Confirmed", null, T.green)}
        <div style={{ marginBottom:32 }}>{confirmedSlot}</div>

        {sectionHeading("Declined", declinedRows.length, T.red)}
        {declinedRows.length===0 && <div style={{ color:T.textLight, fontSize:13, padding:"6px 0 20px" }}>No declined requests.</div>}
        <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:12 }}>
          {declinedRows.map(renderReqCard)}
        </div>
      </>)}

      {/* ── Blocks mode: block management only ── */}
      {mode==="blocks" && (
      <div style={{ paddingTop:4 }}>
        <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:14 }}>Manage Blocked Dates / Slots</div>
        <p style={{ fontSize:12, color:T.textLight, marginBottom:14 }}>Block a whole day (leave slot empty) or a specific time slot. Events/weddings are automatically blocked.</p>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:10, alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <label style={{ fontSize:11, color:T.textLight, fontWeight:600, whiteSpace:"nowrap" }}>From</label>
            <input type="date" value={blockDate} onChange={e=>setBlockDate(e.target.value)}
              style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 10px", outline:"none" }}/>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <label style={{ fontSize:11, color:T.textLight, fontWeight:600, whiteSpace:"nowrap" }}>To</label>
            <input type="date" value={blockDateTo} onChange={e=>setBlockDateTo(e.target.value)} min={blockDate||undefined}
              style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 10px", outline:"none" }}/>
          </div>
          <select value={blockSlot} onChange={e=>setBlockSlot(e.target.value)}
            style={{ background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 10px", outline:"none" }}>
            <option value="">All day</option>
            {VIEWING_SLOTS.map(s=><option key={s}>{s}</option>)}
          </select>
          <input type="text" value={blockNote} onChange={e=>setBlockNote(e.target.value)} placeholder="Reason e.g. Holiday"
            style={{ flex:1, minWidth:120, background:"#fff", border:`1.5px solid ${T.border}`, borderRadius:6, color:T.text, fontFamily:"inherit", fontSize:13, padding:"7px 10px", outline:"none" }}/>
          <button onClick={addBlock} disabled={!blockDate}
            style={{ background:T.midBlue, color:"#fff", border:"none", padding:"7px 18px", borderRadius:6, cursor:blockDate?"pointer":"not-allowed", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
            + Add Block
          </button>
        </div>
        {blocks.length>0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {(()=>{
              // Group consecutive dates with same note/slot into ranges for display
              const sorted = [...blocks].sort((a,b)=>a.date>b.date?1:-1);
              const groups = [];
              sorted.forEach(b => {
                const last = groups[groups.length-1];
                const prevDate = last ? new Date(last.dateTo+"T00:00:00") : null;
                const thisDate = new Date(b.date+"T00:00:00");
                if (last && last.note===b.note && last.slot===b.slot && prevDate) {
                  const diff = (thisDate - prevDate) / 86400000;
                  if (diff === 1) { last.dateTo = b.date; last.ids.push(b.id); return; }
                }
                groups.push({ dateFrom:b.date, dateTo:b.date, note:b.note, slot:b.slot, ids:[b.id] });
              });
              return groups.map((g,i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", background:"#fff", border:`1px solid ${T.border}`, borderRadius:7, fontSize:13 }}>
                  <span style={{ fontWeight:600, color:T.text }}>
                    {g.dateFrom === g.dateTo ? fmtDate(g.dateFrom) : `${fmtDate(g.dateFrom)} → ${fmtDate(g.dateTo)}`}
                  </span>
                  <span style={{ color:T.textMid }}>{g.slot || "All day"}</span>
                  {g.note && <span style={{ color:T.textLight, fontStyle:"italic", flex:1 }}>{g.note}</span>}
                  {g.ids.length > 1 && <span style={{ fontSize:11, color:T.textLight }}>({g.ids.length} days)</span>}
                  <button onClick={()=>{ g.ids.forEach(id=>removeBlock(id)); }}
                    style={{ background:T.redBg, border:"none", color:T.red, padding:"3px 8px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:11, fontWeight:600 }}>✕</button>
                </div>
              ));
            })()}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function ViewingsView({ bookings, setBookings, setView, setReportType, onEditBooking, onSelectEnquiry, viewingRequests, setViewingRequests, viewingBlocks, setViewingBlocks, enquiries, setEnquiries, saveEnquiries, saveBookings }) {
  const [filter,    setFilter]    = useState("upcoming");
  const [viewTab,   setViewTab]   = useState("viewings");
  const [refreshing, setRefreshing] = useState(false);
  const [editKey, setEditKey]     = useState(null); // `${sourceType}:${sourceId}:${vIndex}` currently being edited
  const [editV,   setEditV]       = useState(null);
  const [vFlash,  setVFlash]      = useState(false);
  const loaded = true;

  const flashSaved = () => { setVFlash(true); setTimeout(()=>setVFlash(false), 2000); };

  // Reload requests + enquiries (and, on a manual refresh, bookings) from Supabase.
  // Enquiries are reloaded because the Enquiries page keeps its own copy, so the
  // confirmed list can otherwise miss enquiry viewings. Bookings are NOT reloaded on
  // auto-open because App state already holds the freshest bookings (same source the
  // Year Calendar uses) — reloading there risks overwriting an in-session edit.
  const refreshRequests = async (full=false) => {
    setRefreshing(true);
    try {
      const r = await sbGet(VR_STORAGE);
      setViewingRequests(r || []);
      const b = await sbGet(VB_STORAGE);
      setViewingBlocks(b || []);
      const enq = await sbGet(ENQUIRIES_STORAGE);
      if (enq && setEnquiries) setEnquiries(enq);
      if (full) {
        const bk = await sbGet(BOOKING_STORAGE);
        if (bk && setBookings) setBookings(bk);
      }
    } catch(e) { console.warn("Refresh failed:", e); }
    finally { setRefreshing(false); }
  };

  // Auto-refresh when Viewings tab is opened (requests + enquiries only)
  useEffect(() => { refreshRequests(false); }, []);
  const today = new Date().toISOString().slice(0,10);

  // Gather all viewings from both bookings and enquiries.
  // vIndex is the position within that source's viewings array — used for edit/delete.
  const allViewings = [];
  bookings.forEach(b=>{
    (b.viewings||[]).forEach((v,vi)=>{
      allViewings.push({ ...v, vIndex:vi, sourceType:"booking", sourceName:b.couple||"Unnamed Booking", sourceId:b.id, sourcePhone:b.phone||b.email||"" });
    });
  });
  enquiries.forEach(e=>{
    (e.viewings||[]).forEach((v,vi)=>{
      allViewings.push({ ...v, vIndex:vi, sourceType:"enquiry", sourceName:e.name||"Unnamed Enquiry", sourceId:e.id, sourcePhone:e.phone||e.email||"" });
    });
  });

  // Update / delete a viewing back onto its source booking or enquiry
  const saveViewingEdit = async (v) => {
    if (v.sourceType==="booking") {
      const updated = bookings.map(b => b.id===v.sourceId
        ? { ...b, viewings:(b.viewings||[]).map((vv,idx)=> idx===v.vIndex ? { ...vv, date:editV.date, time:editV.time, notes:editV.notes } : vv) }
        : b);
      if (saveBookings) await saveBookings(updated);
    } else {
      const updated = enquiries.map(e => e.id===v.sourceId
        ? { ...e, viewings:(e.viewings||[]).map((vv,idx)=> idx===v.vIndex ? { ...vv, date:editV.date, time:editV.time, notes:editV.notes } : vv) }
        : e);
      if (saveEnquiries) await saveEnquiries(updated);
    }
    setEditKey(null); setEditV(null); flashSaved();
  };

  const deleteViewing = async (v) => {
    if (v.sourceType==="booking") {
      const updated = bookings.map(b => b.id===v.sourceId
        ? { ...b, viewings:(b.viewings||[]).filter((_,idx)=> idx!==v.vIndex) }
        : b);
      if (saveBookings) await saveBookings(updated);
    } else {
      const updated = enquiries.map(e => e.id===v.sourceId
        ? { ...e, viewings:(e.viewings||[]).filter((_,idx)=> idx!==v.vIndex) }
        : e);
      if (saveEnquiries) await saveEnquiries(updated);
    }
    flashSaved();
  };

  const sorted = [...allViewings].sort((a,b)=>a.date>b.date?1:-1);
  const filtered = sorted.filter(v=>{
    if (filter==="upcoming") return v.date >= today;
    if (filter==="past")     return v.date < today;
    return true;
  });

  if (!loaded) return <div style={{ padding:40, color:T.textLight }}>Loading viewings…</div>;

  return (
    <div style={{ paddingTop:28 }}>
      {vFlash && <div style={{ position:"fixed", top:20, right:20, zIndex:9999, background:T.green, color:"#fff", padding:"10px 20px", borderRadius:8, fontWeight:600, fontSize:13, boxShadow:"0 4px 12px rgba(0,0,0,.2)" }}>✓ Saved</div>}
      {/* Tabs: Viewings | Blocks | Year Calendar */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:24, flexWrap:"wrap" }}>
        <h2 style={{ margin:0, color:"#6d28d9", fontWeight:700, fontSize:22, marginRight:8 }}>Viewings</h2>
        {[["viewings","Viewings"],["blocks","Blocks"]].map(([v,l])=>{
          const pendCount = (viewingRequests||[]).filter(r=>r.status==="pending").length;
          return (
          <button key={v} onClick={()=>setViewTab(v)} style={{ background:viewTab===v?T.midBlue:"#fff", color:viewTab===v?"#fff":T.textMid, border:`1.5px solid ${viewTab===v?T.midBlue:T.border}`, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:viewTab===v?700:400 }}>
            {v==="viewings" && pendCount>0 ? "Viewings ("+pendCount+")" : l}
          </button>
          );
        })}
        {setReportType && (
          <button onClick={()=>{ setReportType("calendar"); setView("reports"); }}
            style={{ background:"#fff", color:T.midBlue, border:`1.5px solid ${T.midBlue}`, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
            📅 Year Calendar →
          </button>
        )}
        <button onClick={()=>refreshRequests(true)} disabled={refreshing}
          style={{ marginLeft:"auto", background:"none", border:`1px solid ${T.border}`, color:T.textMid, padding:"7px 14px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, opacity:refreshing?0.5:1 }}>
          {refreshing ? "…" : "↻ Refresh"}
        </button>
      </div>

      {viewTab==="blocks" && (
        <ViewingRequestsInbox mode="blocks"
          requests={[]} setRequests={()=>{}}
          blocks={viewingBlocks||[]} setBlocks={setViewingBlocks}
          bookings={bookings} enquiries={enquiries} saveEnquiries={saveEnquiries} saveBookings={saveBookings}
        />
      )}

      {viewTab==="viewings" && (
        <ViewingRequestsInbox mode="requests"
          requests={viewingRequests||[]} setRequests={setViewingRequests}
          blocks={viewingBlocks||[]} setBlocks={setViewingBlocks}
          bookings={bookings} enquiries={enquiries} saveEnquiries={saveEnquiries} saveBookings={saveBookings}
          confirmedSlot={(<>
      <div style={{ display:"flex", gap:6, marginBottom:20, alignItems:"center", flexWrap:"wrap" }}>
        {[["upcoming","Upcoming"],["all","All"],["past","Past"]].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)} style={{ background:filter===v?"#6d28d9":"#fff", color:filter===v?"#fff":T.textMid, border:`1.5px solid ${filter===v?"#6d28d9":T.border}`, padding:"6px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:filter===v?700:400 }}>{l}</button>
        ))}
        <span style={{ fontSize:13, color:T.textLight, marginLeft:"auto", alignSelf:"center" }}>{filtered.length} viewing{filtered.length!==1?"s":""}</span>
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign:"center", padding:40, color:T.textLight, fontSize:14 }}>No {filter==="all"?"":""+filter+" "}viewings found.</div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {filtered.map((v,i)=>{
          const key = `${v.sourceType}:${v.sourceId}:${v.vIndex}`;
          const isEditing = editKey===key;
          return (
          <div key={key} style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"14px 18px", boxShadow:"0 2px 8px rgba(37,99,235,.06)", display:"flex", alignItems:"flex-start", gap:16 }}>
            <div style={{ flexShrink:0, background:"#f3e8ff", border:"1px solid #c4b5fd", borderRadius:8, padding:"10px 14px", textAlign:"center", minWidth:60 }}>
              <div style={{ fontSize:18, fontWeight:700, color:"#6d28d9", lineHeight:1 }}>{v.date ? new Date(v.date+"T00:00:00").getDate() : "—"}</div>
              <div style={{ fontSize:10, color:"#7c3aed", fontWeight:600, marginTop:2 }}>{v.date ? new Date(v.date+"T00:00:00").toLocaleDateString("en-GB",{month:"short"}) : ""}</div>
              <div style={{ fontSize:10, color:"#7c3aed" }}>{v.date ? String(new Date(v.date+"T00:00:00").getFullYear()).slice(2) : ""}</div>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6, flexWrap:"wrap" }}>
                {v.time && !isEditing && <span style={{ fontSize:13, fontWeight:600, color:T.text }}>🕐 {v.time}</span>}
                <span style={{ fontSize:11, padding:"2px 8px", borderRadius:10, background:v.sourceType==="booking"?T.greenBg:"#f3e8ff", color:v.sourceType==="booking"?T.green:"#6d28d9", border:`1px solid ${v.sourceType==="booking"?"#86efac":"#c4b5fd"}`, fontWeight:600 }}>
                  {v.sourceType==="booking" ? "Booking" : "Enquiry"}
                </span>
                {v.date < today && <span style={{ fontSize:11, padding:"2px 8px", borderRadius:10, background:"#e5e7eb", color:"#6b7280", border:"1px solid #d1d5db", fontWeight:600 }}>Past</span>}
                {!isEditing && (
                  <span style={{ marginLeft:"auto", display:"flex", gap:6 }}>
                    <button onClick={()=>{ setEditKey(key); setEditV({ date:v.date||"", time:v.time||"", notes:v.notes||"" }); }}
                      style={{ background:"#f3e8ff", border:"none", color:"#6d28d9", cursor:"pointer", fontSize:12, fontWeight:600, padding:"3px 14px", borderRadius:5 }}>✎ Edit</button>
                  </span>
                )}
              </div>
              {isEditing ? (
                <div style={{ marginTop:6 }}>
                  <ViewingForm viewing={editV} onChange={setEditV} onSave={()=>saveViewingEdit(v)} onCancel={()=>{ setEditKey(null); setEditV(null); }} saveLabel="Save"/>
                  <div style={{ marginTop:8, display:"flex", justifyContent:"flex-end" }}>
                    <button onClick={()=>{ deleteViewing(v); setEditKey(null); setEditV(null); }}
                      style={{ background:T.redBg, border:`1px solid #fca5a5`, color:T.red, cursor:"pointer", fontSize:12, fontWeight:600, padding:"6px 14px", borderRadius:6 }}>🗑 Delete this viewing</button>
                  </div>
                </div>
              ) : (<>
                <div
                  onClick={()=>{ if(v.sourceType==="booking"&&onEditBooking){ onEditBooking(v.sourceId); setView("form"); } else if(v.sourceType==="enquiry"&&onSelectEnquiry){ onSelectEnquiry(v.sourceId); } }}
                  style={{ fontWeight:700, color:T.accent, fontSize:15, marginBottom:4, cursor:"pointer", textDecoration:"underline", textDecorationColor:"transparent", transition:"text-decoration-color .15s" }}
                  onMouseEnter={e=>e.currentTarget.style.textDecorationColor=T.accent}
                  onMouseLeave={e=>e.currentTarget.style.textDecorationColor="transparent"}
                >{v.sourceName}</div>
                {v.sourcePhone && <div style={{ fontSize:12, color:T.textMid, marginBottom:v.notes?4:0 }}>📞 {v.sourcePhone}</div>}
                {v.notes && <p style={{ margin:0, fontSize:13, color:T.textMid, lineHeight:1.5 }}>{v.notes}</p>}
              </>)}
            </div>
          </div>
          );
        })}
      </div>
      </>)}
        />
      )}
    </div>
  );
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function SettingsView({ xeroToken, onXeroConnect, onXeroDisconnect, gmailToken, onGmailConnect, onGmailDisconnect, setView }) {
  const [feedCopied, setFeedCopied] = useState(false);
  const feedUrl = (typeof window !== "undefined" ? window.location.origin : "") + "/calendar.ics";
  const card = { background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:"22px 24px", boxShadow:"0 2px 8px rgba(37,99,235,.06)", marginBottom:20 };
  return (
    <div style={{ paddingTop:28, maxWidth:820 }}>
      <h2 style={{ margin:"0 0 20px", color:T.midBlue, fontWeight:700, fontSize:22 }}>Settings</h2>

      {/* Staff */}
      {setView && (
        <div style={card}>
          <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:8 }}>Staff</div>
          <p style={{ fontSize:13, color:T.textMid, margin:"0 0 14px", lineHeight:1.5 }}>Manage staff members used for rota assignments.</p>
          <button onClick={()=>setView("staff")} style={{ background:T.accent, color:"#fff", border:"none", padding:"9px 20px", borderRadius:7, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>Manage Staff</button>
        </div>
      )}

      {/* Calendar feed */}
      <div style={card}>
        <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:8 }}>Calendar Feed (Subscribe)</div>
        <p style={{ fontSize:13, color:T.textMid, margin:"0 0 14px", lineHeight:1.5 }}>
          A live iCalendar feed of all events and viewings. Add it to Google, Apple or Outlook calendar via "Subscribe from URL" / "Add calendar by URL" — it refreshes automatically. New URL subscriptions in Google Calendar can take several hours to first appear.
        </p>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <code style={{ background:T.bgInput, border:`1px solid ${T.border}`, borderRadius:6, padding:"8px 12px", fontSize:12, color:T.text, wordBreak:"break-all" }}>{feedUrl}</code>
          <button onClick={()=>{ try{ navigator.clipboard.writeText(feedUrl); setFeedCopied(true); setTimeout(()=>setFeedCopied(false),2000); }catch(e){} }}
            style={{ background:feedCopied?T.green:T.midBlue, color:"#fff", border:"none", padding:"8px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
            {feedCopied ? "✓ Copied" : "Copy URL"}
          </button>
          <a href={feedUrl} target="_blank" rel="noreferrer"
            style={{ background:"#fff", color:T.midBlue, border:`1.5px solid ${T.midBlue}`, padding:"8px 16px", borderRadius:6, textDecoration:"none", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>
            Download .ics
          </a>
        </div>
      </div>

      {/* Integrations */}
      <div style={card}>
        <div style={{ fontSize:11, letterSpacing:1.2, textTransform:"uppercase", color:T.midBlue, fontWeight:700, marginBottom:14 }}>Integrations</div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
            <div>
              <div style={{ fontSize:14, fontWeight:600, color:T.text }}>Xero</div>
              <div style={{ fontSize:12, color:T.textLight }}>{xeroToken ? "Connected" : "Not connected"}</div>
            </div>
            {xeroToken
              ? <button onClick={onXeroDisconnect} style={{ background:"#e6f7fd", border:"1px solid #13B5EA", color:"#0e8ab0", padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>Disconnect</button>
              : <button onClick={onXeroConnect} style={{ background:"#13B5EA", border:"none", color:"#fff", padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>Connect Xero</button>}
          </div>
          <div style={{ height:1, background:T.border }}/>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
            <div>
              <div style={{ fontSize:14, fontWeight:600, color:T.text }}>Gmail</div>
              <div style={{ fontSize:12, color:T.textLight }}>{gmailToken ? "Connected" : "Not connected"}</div>
            </div>
            {gmailToken
              ? <button onClick={onGmailDisconnect} style={{ background:"#fef2f2", border:"1px solid #fca5a5", color:"#dc2626", padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>Disconnect</button>
              : <button onClick={onGmailConnect} style={{ background:"#ea4335", border:"none", color:"#fff", padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600 }}>Connect Gmail</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── EnquiriesView (top-level) ────────────────────────────────────────────────
function EnquiriesView({ gmailToken, onConvertToBooking, focusEnquiryId, clearFocus }) {
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

  // Deep-link: when arriving with a focus enquiry id (e.g. clicked from Viewings or Year Calendar), open it
  useEffect(() => {
    if (focusEnquiryId) { setSelected(focusEnquiryId); setAdding(false); if (clearFocus) clearFocus(); }
  }, [focusEnquiryId]);

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
        gmailToken={gmailToken}
        onConvertToBooking={onConvertToBooking}
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

function EnquiryDetail({ enq, onUpdate, onDelete, onBack, isNew, confirmDlg, setConfirmDlg, gmailToken, onConvertToBooking }) {
  const [form, setForm]         = useState({...enq});
  const [newContact, setNewContact] = useState({ date: new Date().toISOString().slice(0,10), method:"email", note:"" });
  const [addingContact, setAddingContact] = useState(false);
  const [editingContactIdx, setEditingContactIdx] = useState(null);
  const [editContactForm, setEditContactForm] = useState(null);
  const [dirty, setDirty]       = useState(isNew);

  const update = (k,v) => { setForm(f=>({...f,[k]:v})); setDirty(true); };

  const save = async () => { await onUpdate(form); setDirty(false); };

  const handleConvertClick = () => {
    setConfirmDlg({
      message: "Convert this enquiry to a booking?",
      subMessage: `A new booking will be created for "${form.name||"this enquiry"}" with name, email, phone, viewings and files copied across, and contact history added to notes. You'll be taken to the new booking to fill in any missing details.`,
      onConfirm: async () => {
        setConfirmDlg(null);
        const updatedForm = { ...form, outcome: "booked" };
        setForm(updatedForm);
        setDirty(false);
        await onUpdate(updatedForm);
        onConvertToBooking(updatedForm);
      }
    });
  };

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
        {onConvertToBooking && <button onClick={handleConvertClick} style={{ background:T.green, color:"#fff", border:"none", padding:"9px 18px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Convert to Booking</button>}
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

        {/* Right column: gmail + contact history */}
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          {/* Gmail threads */}
          {form.email && (
            <div style={{ background:"#fff", border:`1px solid ${T.border}`, borderRadius:10, padding:22, boxShadow:"0 2px 8px rgba(37,99,235,.06)" }}>
              <h3 style={{ margin:"0 0 12px", color:T.midBlue, fontWeight:700, fontSize:15, borderBottom:`1px solid ${T.border}`, paddingBottom:10 }}>Gmail</h3>
              <GmailThreadPanel emails={[form.email].filter(Boolean)} gmailToken={gmailToken} formData={form} update={(k,v)=>{ setForm(f=>({...f,[k]:v})); setDirty(true); }} onAutoSave={onUpdate} entityId={form.id||form.name?.replace(/[^a-z0-9]/gi,"_").toLowerCase()} entityType="enquiry"/>
            </div>
          )}
          {/* Contact history */}
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
