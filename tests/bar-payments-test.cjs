// tests/bar-payments-test.cjs
//
// Money behind the bar, end to end through the two functions, against a fake
// Stripe, a fake Supabase and a fake Resend.
//   bar-checkout.js        asks AS THE CLIENT, makes a session for exactly the
//                          amount the database accepted, attaches it, and
//                          never sends anyone to a session it could not attach
//   stripe-ticket-webhook  records a paid bar session, emails client + office
//                          once, never twice on a retry, and tells the office
//                          about money it could not match
//     node tests/bar-payments-test.cjs

const fs = require("fs"), path = require("path"), Module = require("module");
process.env.SUPABASE_SERVICE_KEY = "SERVICE";
process.env.STRIPE_TICKET_SECRET_KEY = "sk_test";
process.env.STRIPE_TICKET_WEBHOOK_SECRET = "whsec";
process.env.RESEND_API_KEY = "re_test";

// A fake stripe package, handed to both functions' require("stripe").
const stripeState = { created: [], expired: [], nextEvent: null, failCreate: false };
const fakeStripe = () => ({
  checkout: { sessions: {
    create: async (p) => { if (stripeState.failCreate) throw new Error("stripe down"); stripeState.created.push(p); return { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }; },
    expire: async (id) => { stripeState.expired.push(id); return {}; },
    list: async () => ({ data: [] })
  } },
  webhooks: { constructEvent: (body, sig, secret) => { if (secret !== "whsec") throw new Error("bad sig"); return stripeState.nextEvent; } },
  refunds: { create: async () => ({}) }
});
const realLoad = Module._load;
Module._load = function (req, parent, isMain) { if (req === "stripe") return fakeStripe; return realLoad.apply(this, arguments); };

function load(file) {
  const FN = path.join(__dirname, "..", "netlify", "functions", file);
  const mod = new Module(FN, null); mod.filename = FN; mod.paths = Module._nodeModulePaths(path.dirname(FN));
  mod._compile(fs.readFileSync(FN, "utf8"), FN);
  return mod.exports.handler;
}
const checkout = load("bar-checkout.js");
const webhook = load("stripe-ticket-webhook.js");

let passes = 0; const fails = [];
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ": " + d : "")); };

function fake(rpcs, appData) {
  const calls = [];
  global.fetch = async (url, o) => {
    const auth = (o.headers || {}).Authorization;
    calls.push({ url, auth, body: o.body ? JSON.parse(o.body) : null, method: o.method });
    const j = (s, b) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b), json: async () => b });
    const m = url.match(/\/rpc\/(\w+)$/);
    if (m) return rpcs[m[1]] ? j(200, rpcs[m[1]](JSON.parse(o.body), auth)) : j(404, { message: "no " + m[1] });
    if (url.includes("api.resend.com")) return j(200, { id: "em_1" });
    if (url.includes("app_data")) return j(200, o.method === "GET" || !o.method ? [{ value: (appData && url.includes("portal_email")) ? appData : [] }] : []);
    return j(404, {});
  };
  return calls;
}
const ev = (b, jwt) => ({ httpMethod: "POST", headers: jwt ? { authorization: "Bearer " + jwt } : {}, body: JSON.stringify(b) });
const hook = (type, session) => { stripeState.nextEvent = { id: "evt_1", type, data: { object: session } };
  return { httpMethod: "POST", headers: { "stripe-signature": "sig" }, body: "{}" }; };

(async () => {
  // ── checkout ──────────────────────────────────────────────────────────────
  let calls = fake({
    wp_bar_payment_start: (b) => ({ ok: true, id: "row-1", event_id: 222, amount: b.p_amount, couple: "Sam & Alex", email: "sam@x.test" }),
    wp_bar_payment_attach: () => ({ ok: true })
  });
  let r = await checkout(ev({ amount: 500, eventId: 999 }, "USERJWT"));
  const sc = stripeState.created[0];
  check("C1 url returned", r.statusCode === 200 && JSON.parse(r.body).url.includes("cs_1"), r.body);
  check("C2 asked as the client", calls.find((c) => c.url.endsWith("wp_bar_payment_start")).auth === "Bearer USERJWT");
  check("C3 event never from the browser", !calls.some((c) => JSON.stringify(c.body || {}).includes("999")) && sc.client_reference_id === "event-222");
  check("C4 exact amount in pence", sc.line_items[0].price_data.unit_amount === 50000 && sc.line_items[0].price_data.currency === "gbp");
  check("C5 marked as bar_tab with the row", sc.metadata.bookingType === "bar_tab" && sc.metadata.barPaymentId === "row-1");
  check("C6 attached with the service key", calls.find((c) => c.url.endsWith("wp_bar_payment_attach")).auth === "Bearer SERVICE");

  fake({ wp_bar_payment_start: () => ({ ok: false, error: "bad_amount" }) });
  r = await checkout(ev({ amount: 5 }, "USERJWT"));
  check("C7 database refusal passed on", r.statusCode === 400 && JSON.parse(r.body).code === "bad_amount", r.body);

  r = await checkout(ev({ amount: 500 }));
  check("C8 no sign-in, no payment", r.statusCode === 401);

  stripeState.created = [];
  fake({ wp_bar_payment_start: () => ({ ok: true, id: "row-2", event_id: 222, amount: 50, email: "" }),
         wp_bar_payment_attach: () => ({ ok: false, error: "not_found" }) });
  r = await checkout(ev({ amount: 50 }, "USERJWT"));
  check("C9 unattached session is expired, nobody sent to pay it", r.statusCode === 500 && stripeState.expired.includes("cs_1"), r.body);

  // ── webhook ───────────────────────────────────────────────────────────────
  const paidSession = { id: "cs_1", payment_status: "paid", amount_total: 50000, payment_intent: "pi_1",
                        customer_details: { email: "Sam@X.test" }, client_reference_id: "event-222",
                        metadata: { bookingType: "bar_tab", barPaymentId: "row-1" } };
  calls = fake({ wp_bar_payment_paid: (b) => ({ ok: true, first_time: true, event_id: 222, amount: b.p_amount_total, total: 500,
    paid_at: "2026-10-23T16:00:00Z", payer_email: "sam@x.test", couple: "Sam & Alex", event_date: "2026-12-05",
    client_emails: ["sam@x.test", "alex@x.test"] }) });
  r = await webhook(hook("checkout.session.completed", paidSession));
  const paidCall = calls.find((c) => c.url.endsWith("wp_bar_payment_paid"));
  const emails = calls.filter((c) => c.url.includes("api.resend.com")).map((c) => c.body);
  check("W1 200", r.statusCode === 200, r.statusCode + " " + r.body);
  check("W2 recorded with the session and pounds", paidCall && paidCall.body.p_session === "cs_1" && paidCall.body.p_amount_total === 500);
  check("W3 client and office emailed", emails.length === 2 &&
    JSON.stringify(emails[0].to) === JSON.stringify(["sam@x.test", "alex@x.test"]) && emails[1].to === "hello@hawthbushfarm.co.uk",
    JSON.stringify(emails.map((e) => e.to)));
  check("W4 emails say the amount and the date", emails[0].html.includes("£500.00") && emails[0].html.includes("23 October 2026") &&
    emails[1].subject.includes("£500.00"), emails[0].subject);
  check("W5 logged to Recent Automated Emails", calls.some((c) => c.url.includes("app_data") && c.method === "POST"));

  // Wording changed under Settings → Email templates is what the client gets.
  calls = fake({ wp_bar_payment_paid: () => ({ ok: true, first_time: true, event_id: 222, amount: 250, total: 750,
    paid_at: "2026-10-24T10:00:00Z", payer_email: "sam@x.test", couple: "Sam <b>& Alex", event_date: "2026-12-05", client_emails: [] }) },
    [{ id: "bar_receipt", subject: "Cheers! {amount} for {event}", body: "Got {amount}.\n\nNow {total} on {date}." }]);
  r = await webhook(hook("checkout.session.completed", paidSession));
  const custom = calls.filter((c) => c.url.includes("api.resend.com")).map((c) => c.body)[0];
  check("W5b custom wording used and filled", custom && custom.subject === "Cheers! £250.00 for Sam <b>& Alex" &&
    custom.html.includes("Got <strong>£250.00</strong>.") && custom.html.includes("Now <strong>£750.00</strong> on 24 October 2026."), custom && custom.subject);
  check("W5c event name escaped in the HTML", custom && !custom.html.includes("<b>&") , "");

  calls = fake({ wp_bar_payment_paid: () => ({ ok: true, first_time: false, event_id: 222, amount: 500, total: 500 }) });
  r = await webhook(hook("checkout.session.completed", paidSession));
  check("W6 retried delivery: no second email", r.statusCode === 200 && !calls.some((c) => c.url.includes("api.resend.com")));

  calls = fake({ wp_bar_payment_paid: () => ({ ok: false, error: "amount_mismatch" }) });
  r = await webhook(hook("checkout.session.completed", paidSession));
  const alert = calls.filter((c) => c.url.includes("api.resend.com")).map((c) => c.body);
  check("W7 unmatched money: office told, client not", r.statusCode === 200 && alert.length === 1 &&
    alert[0].to === "hello@hawthbushfarm.co.uk" && alert[0].subject.includes("not matched"));

  calls = fake({ wp_bar_payment_expired: (b) => ({ ok: true, s: b.p_session }) });
  r = await webhook(hook("checkout.session.expired", paidSession));
  check("W8 expiry recorded", r.statusCode === 200 && calls.some((c) => c.url.endsWith("wp_bar_payment_expired") && c.body.p_session === "cs_1"));

  calls = fake({});
  r = await webhook(hook("checkout.session.completed", Object.assign({}, paidSession, { payment_status: "unpaid" })));
  check("W9 an unpaid completion records nothing", r.statusCode === 200 && !calls.some((c) => c.url.includes("/rpc/")));

  calls = fake({ wp_bar_payment_paid: () => { throw new Error("db down"); } });
  global.fetch = async (url) => ({ ok: false, status: 500, text: async () => "down" });
  r = await webhook(hook("checkout.session.completed", paidSession));
  check("W10 database down: 500 so Stripe retries", r.statusCode === 500, String(r.statusCode));

  // A ticket session is still left to the ticket code (no bar handling).
  calls = fake({});
  r = await webhook(hook("checkout.session.completed", { id: "cs_t", metadata: { bookingType: "something_else" } }));
  check("W11 other sessions untouched", r.statusCode === 200 && !calls.some((c) => c.url.includes("wp_bar_")));

  if (fails.length) { console.log(passes + " passed, FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("ALL " + passes + " ASSERTIONS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
