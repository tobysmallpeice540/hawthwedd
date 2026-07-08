// netlify/functions/xero-proxy.js
// Proxies Xero API calls to avoid CORS restrictions in the browser.
// The browser sends the access token and tenant ID in headers;
// this function forwards them to api.xero.com and returns the result.

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "https://cool-sorbet-b1d599.netlify.app",
    "Access-Control-Allow-Headers": "Content-Type, x-xero-token, x-xero-tenant-id",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const accessToken = event.headers["x-xero-token"];
  const tenantId    = event.headers["x-xero-tenant-id"];
  const path        = event.queryStringParameters?.path;

  if (!accessToken || !tenantId || !path) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing x-xero-token, x-xero-tenant-id, or path parameter" }),
    };
  }

  // Connections endpoint (no tenant ID needed)
  if (path === "connections") {
    const res = await fetch("https://api.xero.com/connections", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const data = await res.text();
    return {
      statusCode: res.status,
      headers: { ...headers, "Content-Type": "application/json" },
      body: data,
    };
  }

  // Standard Accounting API call
  const url = `https://api.xero.com/api.xro/2.0/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json",
    },
  });

  const data = await res.text();
  return {
    statusCode: res.status,
    headers: { ...headers, "Content-Type": "application/json" },
    body: data,
  };
};
