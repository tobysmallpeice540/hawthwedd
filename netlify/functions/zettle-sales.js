// netlify/functions/zettle-sales.js
//
// Fetches product-level sales from Zettle (PayPal POS) for a date range and
// aggregates them, so bar stock usage between two stocktakes can be reconciled
// against what was actually rung through the till.
//
// Required Netlify env vars:
//   ZETTLE_API_KEY     — the JWT API key from https://my.zettle.com/apps/api-keys
//                        created with scope READ:PURCHASE
//   ZETTLE_CLIENT_ID   — the client id shown alongside the key (optional; if
//                        omitted it is read out of the API key's JWT payload)
//
// Also add ZETTLE_API_KEY to SECRETS_SCAN_OMIT_KEYS in netlify.toml.
//
// Notes on the data:
//  * All money is in MINOR units (pence) — divided by 100 before returning.
//  * Refunds come back as separate purchases with negative quantities and
//    amounts, so they are summed in rather than filtered out; totals are net.
//  * quantity is a STRING and may be a decimal.

const OAUTH_URL    = "https://oauth.zettle.com/token";
const PURCHASE_URL = "https://purchase.izettle.com/purchases/v2";
const PRODUCTS_URL = "https://products.izettle.com/organizations/self/products";

function jsonResponse(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// The API key is a JWT; its payload carries the client id when one hasn't been
// configured separately.
function clientIdFromAssertion(assertion) {
  try {
    const parts = String(assertion).split(".");
    if (parts.length < 2) return null;
    const pad = parts[1].length % 4 === 0 ? "" : "=".repeat(4 - (parts[1].length % 4));
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8")
    );
    return payload.client_id || payload.clientId || payload.sub || payload.aud || null;
  } catch (e) {
    return null;
  }
}

async function getAccessToken() {
  const assertion = process.env.ZETTLE_API_KEY;
  if (!assertion) throw new Error("ZETTLE_API_KEY is not set in Netlify environment variables.");

  const clientId = process.env.ZETTLE_CLIENT_ID || clientIdFromAssertion(assertion);
  if (!clientId) throw new Error("Could not determine the Zettle client id — set ZETTLE_CLIENT_ID.");

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: clientId,
    assertion: assertion
  });

  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error("Zettle auth failed (" + res.status + "): " + text.slice(0, 200));
  }
  const data = JSON.parse(text);
  // The assertion grant returns no refresh token — a new one is simply
  // requested each time, which is fine for an occasional report.
  return data.access_token;
}

// Page through every purchase in the window.
async function fetchPurchases(token, startDate, endDate) {
  const all = [];
  let lastHash = null;
  const LIMIT = 1000;

  for (let page = 0; page < 60; page++) {   // hard stop: 60k purchases
    let url = PURCHASE_URL + "?limit=" + LIMIT +
      "&startDate=" + encodeURIComponent(startDate) +
      "&endDate=" + encodeURIComponent(endDate);
    if (lastHash) url += "&lastPurchaseHash=" + encodeURIComponent(lastHash);

    const res = await fetch(url, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" }
    });
    if (res.status === 429) throw new Error("Zettle rate limit hit — try again in a minute.");
    const text = await res.text();
    if (!res.ok) throw new Error("Zettle purchases failed (" + res.status + "): " + text.slice(0, 200));

    const data = JSON.parse(text);
    const batch = (data && data.purchases) || [];
    batch.forEach(function(p) { all.push(p); });

    if (batch.length < LIMIT || !data.lastPurchaseHash || data.lastPurchaseHash === lastHash) break;
    lastHash = data.lastPurchaseHash;
  }
  return all;
}

// Full product library, flattened to one row per variant. The key format
// matches the sales aggregation (productUuid|variantUuid) so a mapping made
// against the catalogue lines up with sales when they appear.
async function fetchCatalogue(token) {
  const res = await fetch(PRODUCTS_URL, {
    headers: { "Authorization": "Bearer " + token, "Accept": "application/json" }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error("Zettle products failed (" + res.status + "): " + text.slice(0, 200) +
      (res.status === 403 ? " — the API key may be missing the READ:PRODUCT scope." : ""));
  }
  const data = JSON.parse(text);
  const products = Array.isArray(data) ? data : (data.products || []);

  const rows = [];
  products.forEach(function(p) {
    const variants = (p.variants && p.variants.length) ? p.variants : [{ uuid: null, name: "" }];
    variants.forEach(function(v) {
      const price = v.price && typeof v.price.amount === "number" ? v.price.amount / 100 : null;
      rows.push({
        key: (p.uuid || "") + "|" + (v.uuid || ""),
        productUuid: p.uuid || null,
        variantUuid: v.uuid || null,
        name: p.name || "(unnamed)",
        variantName: v.name || "",
        category: (p.category && p.category.name) || "",
        sku: v.sku || "",
        price: price
      });
    });
  });
  rows.sort(function(a, b) {
    const an = (a.category + " " + a.name + " " + a.variantName).toLowerCase();
    const bn = (b.category + " " + b.name + " " + b.variantName).toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return rows;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return jsonResponse(400, { error: "Invalid JSON" }); }

  // ── Catalogue only — no date range needed ──────────────────────────────────
  if (body.action === "catalogue") {
    try {
      const token = await getAccessToken();
      const catalogue = await fetchCatalogue(token);
      return jsonResponse(200, { ok: true, catalogue: catalogue, count: catalogue.length });
    } catch (err) {
      console.error("zettle-sales catalogue error:", err);
      return jsonResponse(500, { error: String(err.message || err) });
    }
  }

  const startDate = body.startDate;
  const endDate   = body.endDate;
  if (!startDate || !endDate) {
    return jsonResponse(400, { error: "startDate and endDate are required (YYYY-MM-DD)" });
  }

  try {
    const token = await getAccessToken();
    const purchases = await fetchPurchases(token, startDate, endDate);

    // ── Aggregate ────────────────────────────────────────────────────────────
    //
    // Gift cards need care or the numbers double-count:
    //
    //   Selling a gift card    — real money in (paid by card/cash), but no
    //                            stock moves. It IS revenue, at the moment of
    //                            sale.
    //   Redeeming a gift card  — drinks leave the shelf, but no new money
    //                            arrives; the purchase is settled by a payment
    //                            of type GIFTCARD.
    //
    // So: revenue is the sum of every payment EXCEPT gift-card redemptions,
    // while stock consumption counts every product line EXCEPT gift-card sales.
    // Summing purchase totals instead would count a gift card twice — once when
    // sold and again when spent.
    const byKey = {};          // productUuid|variantUuid -> line
    const byPaymentType = {};
    let purchaseTotalMinor = 0;   // raw sum of purchase amounts (reference only)
    let revenueMinor = 0;         // money actually taken
    let giftCardSoldMinor = 0;    // value of gift cards sold
    let giftCardRedeemedMinor = 0;// value settled by gift card
    let refundCount = 0;
    let customAmountMinor = 0;    // "custom amount" rings — no product attached

    purchases.forEach(function(p) {
      purchaseTotalMinor += Number(p.amount || 0);
      if (p.refund) refundCount++;

      (p.payments || []).forEach(function(pay) {
        const t = pay.type || "UNKNOWN";
        const amt = Number(pay.amount || 0);
        byPaymentType[t] = (byPaymentType[t] || 0) + amt;
        if (t === "GIFTCARD") giftCardRedeemedMinor += amt;
        else revenueMinor += amt;   // real money in
      });

      (p.products || []).forEach(function(line) {
        const qty = parseFloat(line.quantity || "0") || 0;
        const unit = Number(line.unitPrice || 0);
        const disc = Number(line.discountValue || 0);
        const rowMinor = (qty * unit) - (qty >= 0 ? disc : -disc);

        // A gift card sale is revenue, not a drink — never counts toward stock.
        if (line.type === "GIFTCARD") { giftCardSoldMinor += rowMinor; return; }

        if (line.type === "CUSTOM_AMOUNT" || !line.name) {
          customAmountMinor += rowMinor;
          return;
        }

        const key = (line.productUuid || "custom") + "|" + (line.variantUuid || "");
        if (!byKey[key]) {
          byKey[key] = {
            key: key,
            productUuid: line.productUuid || null,
            variantUuid: line.variantUuid || null,
            name: line.name,
            variantName: line.variantName || "",
            units: 0,
            grossMinor: 0,
            isLibraryProduct: !!line.libraryProduct
          };
        }
        // Units always count — a drink poured against a gift card still leaves
        // the shelf, even though the line may be priced at zero.
        byKey[key].units += qty;
        byKey[key].grossMinor += rowMinor;
      });
    });

    const byProduct = Object.keys(byKey).map(function(k) {
      const r = byKey[k];
      return {
        key: r.key,
        productUuid: r.productUuid,
        variantUuid: r.variantUuid,
        name: r.name,
        variantName: r.variantName,
        units: Math.round(r.units * 1000) / 1000,
        gross: Math.round(r.grossMinor) / 100,
        isLibraryProduct: r.isLibraryProduct
      };
    }).sort(function(a, b) { return b.gross - a.gross; });

    const payments = Object.keys(byPaymentType).map(function(t) {
      return { type: t, amount: Math.round(byPaymentType[t]) / 100 };
    }).sort(function(a, b) { return b.amount - a.amount; });

    return jsonResponse(200, {
      ok: true,
      from: startDate,
      to: endDate,
      purchaseCount: purchases.length,
      refundCount: refundCount,
      // `revenue` is the figure to use as the bar take — every payment except
      // gift-card redemptions, so gift cards are counted once, when sold.
      revenue: Math.round(revenueMinor) / 100,
      giftCardsSold: Math.round(giftCardSoldMinor) / 100,
      giftCardsRedeemed: Math.round(giftCardRedeemedMinor) / 100,
      // Raw sum of purchase totals — double-counts gift cards, kept only so the
      // difference can be explained on screen.
      purchaseTotal: Math.round(purchaseTotalMinor) / 100,
      gross: Math.round(revenueMinor) / 100,   // back-compat alias
      customAmountTotal: Math.round(customAmountMinor) / 100,
      byProduct: byProduct,
      payments: payments
    });

  } catch (err) {
    console.error("zettle-sales error:", err);
    return jsonResponse(500, { error: String(err.message || err) });
  }
};
