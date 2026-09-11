// The Squarespace code block, driven in a real browser inside a host page that
// carries its own hostile stylesheet — because that is the situation it ships
// into: a code block shares the page's CSS with everything else on it.
const { chromium } = require("playwright");
const fs = require("fs");

const path = require("path");
const PUBLIC = path.join(__dirname, "..", "public");
const SNIPPET = fs.readFileSync(path.join(PUBLIC, "squarespace-brochure.html"), "utf8");

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log("  ok   " + l); } else { fail++; console.log("  FAIL " + l); } };

(async () => {
  // Use whatever chromium Playwright has; PLAYWRIGHT_CHROMIUM lets a sandbox
  // point at a preinstalled one.
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const page = await browser.newPage();

  // The thank-you page lives on the Netlify site, which this sandbox cannot
  // reach. Serve a stub for it so the redirect can be followed and asserted.
  const posted = [];
  await page.route("**/brochure-thanks", route =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<h1>stub thanks</h1>" }));
  await page.route("**/submit-brochure", route => {
    posted.push(JSON.parse(route.request().postData() || "{}"));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, id: "br_1" }) });
  });

  // A host page that styles inputs and forms of its own, and a second form to
  // prove nothing in the snippet reaches it.
  await page.setContent(`<!doctype html><html><head><style>
      input, select, button { border: 6px dashed magenta !important; }
      .hbf-br-pill span { }
    </style></head><body>
      <form id="other"><input id="otherinput" type="text"></form>
      ${SNIPPET}
    </body></html>`, { waitUntil: "domcontentloaded" });

  console.log("\nThe form");
  ok("it renders", await page.locator("#hbf-brochure form").count() === 1);
  ok("the wording Toby asked for is there",
     (await page.locator(".hbf-br-intro").innerText())
       .replace(/\s+/g, " ").trim() ===
     "Let us know a little information about you and we will send our brochure and availability.");
  ok("it collects an email", await page.locator('#hbf-brochure input[name="email"]').count() === 1);
  ok("three guest bands", await page.locator('#hbf-brochure input[name="guests"]').count() === 3);
  ok("guests is one-of-three", await page.locator('#hbf-brochure input[name="guests"][type="radio"]').count() === 3);
  ok("three years", await page.locator('#hbf-brochure input[name="years"]').count() === 3);
  ok("three wedding types", await page.locator('#hbf-brochure input[name="types"]').count() === 3);
  ok("years and types allow more than one",
     await page.locator('#hbf-brochure input[name="years"][type="checkbox"]').count() === 3 &&
     await page.locator('#hbf-brochure input[name="types"][type="checkbox"]').count() === 3);

  const years = await page.locator('#hbf-brochure input[name="years"]').evaluateAll(els => els.map(e => e.value));
  const nextYear = new Date().getFullYear() + 1;
  ok("the years start at next year and run three deep (" + years.join(",") + ")",
     JSON.stringify(years) === JSON.stringify([nextYear, nextYear+1, nextYear+2].map(String)));

  // The order the questions are asked in, which the error messages follow.
  const asked = await page.locator("#hbf-brochure fieldset legend")
    .evaluateAll(els => els.map(e => e.textContent.split("?")[0].split("(")[0].trim()));
  ok("guests is asked last (" + asked.join(" | ") + ")",
     asked.length === 3 && asked[2].indexOf("how many guests") !== -1);
  ok("year is asked first of the three", asked[0].indexOf("Which year") !== -1);

  console.log("\nIt keeps to itself");
  ok("the honeypot is off screen",
     await page.locator("#hbf-br-website").evaluate(el => el.getBoundingClientRect().right < 0));
  ok("the host page's other input is untouched by the snippet's styles",
     await page.locator("#otherinput").evaluate(el => getComputedStyle(el).borderStyle) === "dashed");
  ok("but the snippet's own email box is styled by the snippet",
     await page.locator('#hbf-brochure input[name="email"]').evaluate(el => getComputedStyle(el).borderRadius) === "6px");

  console.log("\nValidation");
  const errText = async () => (await page.locator(".hbf-br-err").isVisible())
    ? (await page.locator(".hbf-br-err").innerText()) : "";

  await page.click(".hbf-br-submit");
  ok("an empty form is refused on the email", (await errText()).indexOf("valid email") !== -1);
  ok("and nothing was posted", posted.length === 0);

  await page.fill('#hbf-brochure input[name="email"]', "jo@example.com");
  await page.click(".hbf-br-submit");
  ok("no year is refused next", (await errText()).indexOf("at least one year") !== -1);

  await page.click(`#hbf-brochure input[name="years"][value="${nextYear}"]`, { force: true });
  await page.click(".hbf-br-submit");
  ok("no wedding type is refused next", (await errText()).indexOf("kind of wedding") !== -1);

  await page.click('#hbf-brochure input[name="types"][value="peak_midweek"]', { force: true });
  await page.click(".hbf-br-submit");
  ok("no guest band is refused last", (await errText()).indexOf("how many guests") !== -1);
  ok("still nothing posted", posted.length === 0);
  await page.click('#hbf-brochure input[name="types"][value="peak_midweek"]', { force: true });

  console.log("\nChoosing");
  await page.click('#hbf-brochure input[name="types"][value="peak_weekend"]', { force: true });
  await page.click('#hbf-brochure input[name="types"][value="off_peak"]', { force: true });
  await page.click(`#hbf-brochure input[name="years"][value="${nextYear + 1}"]`, { force: true });
  ok("two types can be chosen at once",
     await page.locator('#hbf-brochure input[name="types"]:checked').count() === 2);
  ok("two years can be chosen at once",
     await page.locator('#hbf-brochure input[name="years"]:checked').count() === 2);

  await page.click('#hbf-brochure input[name="guests"][value="over120"]', { force: true });
  ok("but only one guest band",
     await page.locator('#hbf-brochure input[name="guests"]:checked').count() === 1);

  // The pill fades over .12s, so a colour read the instant after the click is
  // a value part-way through the fade, not the one that ends up on screen.
  await page.waitForTimeout(300);
  const chosenBg = await page.locator('#hbf-brochure input[name="guests"][value="over120"] + span')
    .evaluate(el => getComputedStyle(el).backgroundColor);
  const unchosenBg = await page.locator('#hbf-brochure input[name="guests"][value="under60"] + span')
    .evaluate(el => getComputedStyle(el).backgroundColor);
  ok("a chosen pill looks different from an unchosen one (" + chosenBg + " vs " + unchosenBg + ")",
     chosenBg !== unchosenBg && chosenBg === "rgb(30, 58, 47)");

  console.log("\nSending");
  await page.fill('#hbf-brochure input[name="name"]', "  Jo Bloggs  ");
  await page.click(".hbf-br-submit");
  await page.waitForURL(/brochure-thanks/, { timeout: 5000 }).catch(() => {});

  ok("it posted once", posted.length === 1);
  const body = posted[0] || {};
  ok("with the email", body.email === "jo@example.com");
  ok("with the name trimmed", body.name === "Jo Bloggs");
  ok("with the guest band", body.guests === "over120");
  ok("with both years", JSON.stringify(body.years) === JSON.stringify([String(nextYear), String(nextYear + 1)]));
  ok("with both types", JSON.stringify(body.types) === JSON.stringify(["peak_weekend", "off_peak"]));
  ok("and an empty honeypot", body.website === "");
  ok("then it goes to the thank-you page", page.url().indexOf("/brochure-thanks") !== -1);

  console.log("\nWhen the function says no");
  const page2 = await browser.newPage();
  await page2.route("**/submit-brochure", route =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Please choose at least one year." }) }));
  await page2.setContent("<!doctype html><html><body>" + SNIPPET + "</body></html>", { waitUntil: "domcontentloaded" });
  await page2.fill('#hbf-brochure input[name="email"]', "jo@example.com");
  await page2.click('#hbf-brochure input[name="guests"][value="under60"]', { force: true });
  await page2.click(`#hbf-brochure input[name="years"][value="${nextYear}"]`, { force: true });
  await page2.click('#hbf-brochure input[name="types"][value="off_peak"]', { force: true });
  await page2.click(".hbf-br-submit");
  await page2.waitForTimeout(400);
  ok("the server's own message is shown", (await page2.locator(".hbf-br-err").innerText()).indexOf("at least one year") !== -1);
  ok("the button comes back so they can try again",
     await page2.locator(".hbf-br-submit").isEnabled() &&
     (await page2.locator(".hbf-br-submit").innerText()).indexOf("Send me") !== -1);
  ok("and it stayed on the page", page2.url().indexOf("brochure-thanks") === -1);

  console.log("\nThe thank-you page");
  const page3 = await browser.newPage();
  await page3.goto("file://" + path.join(PUBLIC, "brochure-thanks.html"));
  ok("it thanks them", (await page3.locator("h1").innerText()).indexOf("Thank you") !== -1);
  ok("it offers a way back to the website",
     await page3.locator('a.back[href="https://www.hawthbushfarm.co.uk/"]').count() === 1);
  await page3.click("#stay");
  await page3.waitForTimeout(1500);
  ok("stay here stops the countdown", page3.url().indexOf("hawthbushfarm.co.uk") === -1);

  const page4 = await browser.newPage();
  await page4.goto("file://" + path.join(PUBLIC, "brochure-thanks.html"));
  await page4.waitForTimeout(2500);
  ok("otherwise the countdown is ticking down",
     Number(await page4.locator("#secs").innerText()) < 9);

  // 400x900 — the phone width the rest of the app is checked at.
  const page5 = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page5.setContent("<!doctype html><html><body style='margin:0'>" + SNIPPET + "</body></html>", { waitUntil: "domcontentloaded" });
  const wide = await page5.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok("at 400px nothing spills off the side", !wide);

  await browser.close();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
