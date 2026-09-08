// tests/ticket-notes-e2e.cjs
//
// The checkout notes field, driven through a real browser against the real
// public/ticket-event.html, with the Supabase RPCs and the checkout function
// stubbed. Nothing here touches the live database or Stripe.
//
//   npm i -D playwright && npx playwright install chromium
//   node tests/ticket-notes-e2e.cjs
//
// Set CHROME_PATH to point at an existing Chromium if you have one.
//
// 18 assertions. Exits non-zero on any failure.
//
// End-to-end check of the checkout notes field against the real page, with
// the Supabase RPCs and the checkout function stubbed. Drives the browser the
// way a buyer would: pick tickets, fill the details, answer the question, and
// assert what the page finally POSTs.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "public");
const T_DINNER = "11111111-1111-4111-8111-111111111111";
const T_STAND  = "22222222-2222-4222-8222-222222222222";

let failures = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
}

const publicEvent = {
  ok: true, name: "Supper Club", slug: "supper-club", status: "published",
  starts_at: "2026-11-14T19:00:00Z", ends_at: "2026-11-14T23:00:00Z",
  venue_name: "The Grain Store", venue_postcode: "TN21 0JY",
  description: "<p>Six courses.</p>", hide_map: true, listed: true,
  payment_mode: "full", deposit_pence: 0, balance_days: 30,
  min_per_order: null, gated: false, sold_out: false,
  buy_button_label: "Select tickets",
  ticket_types: [
    { id: T_DINNER, name: "Dinner", description: "", price_pence: 7500, remaining: 40, max_per_order: null, avail_label: "",
      notes_enabled: true, notes_required: true,
      notes_label: "If you would like to be seated with a group, please leave us their surname here." },
    { id: T_STAND,  name: "Standing", description: "", price_pence: 2000, remaining: 40, max_per_order: null, avail_label: "",
      notes_enabled: false, notes_required: false, notes_label: null }
  ]
};


(async () => {
  const server = http.createServer((req, res) => {
    const p0 = req.url.split("?")[0];
    const file = path.join(ROOT, p0.startsWith("/tickets/") || p0 === "/" ? "ticket-event.html" : p0);
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end("no"); }
      res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : "application/octet-stream" });
      res.end(buf);
    });
  });
  await new Promise(r => server.listen(8799, r));

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage();

  let posted = null;
  let rpcCalls = 0;

  await page.route("**/rest/v1/**", async route => {
    const url = route.request().url();
    if (url.includes("rpc/box_public_event")) {
      rpcCalls++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(publicEvent) });
    }
    if (url.includes("app_data")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.route("**/.netlify/functions/create-ticket-checkout", async route => {
    posted = JSON.parse(route.request().postData() || "{}");
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ error: "stopped here on purpose" }) });
  });

  page.on("pageerror", e => { failures++; console.log("  FAIL  page error: " + e.message); });

  await page.goto("http://localhost:8799/tickets/supper-club?buy=1", { waitUntil: "networkidle" });

  console.log("\nThe configuration arrives with the event");
  ok("box_public_event is called once, and nothing else", rpcCalls === 1, rpcCalls + " calls");

  // Onto the ticket step.
  await page.waitForSelector("[data-plus]");

  console.log("\nThe question only appears for the tickets it belongs to");
  await page.click(`[data-plus="${T_STAND}"]`);
  await page.click(`[data-plus="${T_STAND}"]`);
  await page.click("#to-details");
  await page.waitForSelector("#d-first");
  ok("standing tickets alone ask nothing", await page.locator(`#note-${T_DINNER}`).count() === 0);

  await page.click("#back-tickets");
  await page.waitForSelector("[data-plus]");
  await page.click(`[data-plus="${T_DINNER}"]`);
  await page.click(`[data-plus="${T_DINNER}"]`);
  await page.click(`[data-plus="${T_DINNER}"]`);
  await page.click(`[data-plus="${T_DINNER}"]`);
  await page.click("#to-details");
  await page.waitForSelector(`#note-${T_DINNER}`);
  ok("adding dinner tickets brings the question up", await page.locator(`#note-${T_DINNER}`).count() === 1);
  ok("the quiet ticket type still asks nothing", await page.locator(`#note-${T_STAND}`).count() === 0);

  const labelText = await page.locator(`label[for="note-${T_DINNER}"]`).innerText();
  ok("the label is Toby's wording, not a default",
    labelText.includes("please leave us their surname here"), labelText);
  ok("a required question is not marked optional", !labelText.toLowerCase().includes("optional"), labelText);
  ok("the question says which tickets it is about",
    (await page.locator(".note-for").innerText()).toLowerCase().indexOf("4 × dinner") === 0,
    await page.locator(".note-for").innerText());

  console.log("\nA required answer is required");
  await page.fill("#d-first", "Jane");
  await page.fill("#d-last", "Smith");
  await page.fill("#d-email", "jane@example.com");
  await page.fill("#d-email2", "jane@example.com");
  await page.fill("#d-phone", "07700 900123");
  await page.check("#d-terms");
  await page.click("#to-payment");
  await page.waitForTimeout(200);
  ok("blank answer is refused", await page.locator(".alert-error").count() === 1,
    await page.locator(".alert-error").count() + " error boxes");
  ok("the refusal repeats the question rather than shrugging",
    (await page.locator(".alert-error").innerText()).includes("surname"));
  ok("it did not move on to payment", await page.locator("#go-stripe").count() === 0);

  console.log("\nThe answer survives going back to change the order");
  await page.fill(`#note-${T_DINNER}`, "Sitting with the Hendersons");
  await page.click("#back-tickets");
  await page.waitForSelector("[data-plus]");
  await page.click("#to-details");
  await page.waitForSelector(`#note-${T_DINNER}`);
  ok("typing is not lost on the way back and forth",
    (await page.inputValue(`#note-${T_DINNER}`)) === "Sitting with the Hendersons",
    await page.inputValue(`#note-${T_DINNER}`));

  console.log("\nWhat reaches the server");
  await page.check("#d-terms");
  await page.click("#to-payment");
  await page.waitForSelector("#go-stripe");
  await page.click("#go-stripe");
  await page.waitForTimeout(600);

  ok("the checkout was called", !!posted);
  if (posted) {
    const dinner = (posted.lines || []).find(l => l.ticket_type_id === T_DINNER);
    const stand  = (posted.lines || []).find(l => l.ticket_type_id === T_STAND);
    ok("the dinner line carries the note", dinner && dinner.note === "Sitting with the Hendersons",
      JSON.stringify(dinner));
    ok("the dinner quantity is untouched by any of this", dinner && dinner.qty === 4, JSON.stringify(dinner));
    ok("the standing line carries no note", stand && stand.note === "", JSON.stringify(stand));
    ok("nothing else about the payload changed",
      posted.firstName === "Jane" && posted.email === "jane@example.com" && !!posted.termsAcceptedAt);
  }

  console.log("\nA page served before the migration behaves exactly as before");
  const page2 = await browser.newPage();
  // box_public_event as it was: no notes_* keys on the ticket types at all.
  const oldShape = JSON.parse(JSON.stringify(publicEvent));
  oldShape.ticket_types.forEach(t => {
    delete t.notes_enabled; delete t.notes_label; delete t.notes_required;
  });
  await page2.route("**/rest/v1/**", async route => {
    const url = route.request().url();
    if (url.includes("rpc/box_public_event")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(oldShape) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  let posted2 = null;
  await page2.route("**/.netlify/functions/create-ticket-checkout", async route => {
    posted2 = JSON.parse(route.request().postData() || "{}");
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"error":"stop"}' });
  });
  page2.on("pageerror", e => { failures++; console.log("  FAIL  page error (no-migration): " + e.message); });

  await page2.goto("http://localhost:8799/tickets/supper-club?buy=1", { waitUntil: "networkidle" });
  await page2.waitForSelector("[data-plus]");
  await page2.click(`[data-plus="${T_DINNER}"]`);
  await page2.click("#to-details");
  await page2.waitForSelector("#d-first");
  ok("no question is asked when the columns are absent", await page2.locator(".note-ask").count() === 0);
  await page2.fill("#d-first", "Tom");
  await page2.fill("#d-last", "Reed");
  await page2.fill("#d-email", "tom@example.com");
  await page2.fill("#d-email2", "tom@example.com");
  await page2.check("#d-terms");
  await page2.click("#to-payment");
  await page2.waitForSelector("#go-stripe");
  await page2.click("#go-stripe");
  await page2.waitForTimeout(500);
  ok("the sale still goes through", !!posted2 && posted2.lines.length === 1, JSON.stringify(posted2 && posted2.lines));

  await browser.close();
  server.close();
  console.log("\n" + passes + " passed, " + failures + " failed");
  process.exit(failures ? 1 : 0);
})();
