export default async (request, context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-xero-token, x-xero-tenant-id",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  const accessToken = request.headers.get("x-xero-token");
  const tenantId = request.headers.get("x-xero-tenant-id");

  if (!accessToken || !path) {
    return new Response(JSON.stringify({ error: "Missing x-xero-token or path" }), {
      status: 400, headers: corsHeaders,
    });
  }

  try {
    let xeroUrl, xeroHeaders;

    if (path === "connections") {
      xeroUrl = "https://api.xero.com/connections";
      xeroHeaders = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };
    } else {
      xeroUrl = `https://api.xero.com/api.xro/2.0/${path}`;
      xeroHeaders = {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      };
    }

    const res = await fetch(xeroUrl, { headers: xeroHeaders });
    const data = await res.text();

    return new Response(data, {
      status: res.status,
      headers: corsHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders,
    });
  }
};

export const config = { path: "/api/xero" };
