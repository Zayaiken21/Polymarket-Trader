/* BlueEdge price-to-beat relay (Cloudflare Worker, free plan)
 * Browsers block github.io pages from reading polymarket.com directly (CORS). This worker forwards ONLY
 * Polymarket's public price-to-beat endpoint and adds CORS headers. No keys, no accounts, read-only.
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker → paste this file → Deploy.
 * Then paste the worker address (https://<name>.<you>.workers.dev) into BlueEdge → Settings → Price-to-beat relay.
 */
const UPSTREAM = "https://polymarket.com/api/crypto/crypto-price";
const VARIANTS = new Set(["fiveminute", "fifteen", "hourly", "fourhour", "daily"]);

export default {
  async fetch(request) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

    const input = new URL(request.url).searchParams;
    const symbol = (input.get("symbol") || "").toUpperCase();
    const variant = input.get("variant") || "";
    const start = input.get("eventStartTime") || "";
    const end = input.get("endDate") || "";
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    if (!/^[A-Z0-9]{2,6}$/.test(symbol) || !VARIANTS.has(variant) || !iso.test(start) || (end && !iso.test(end))) {
      return json({ error: "Expected symbol, variant, eventStartTime (and endDate) in 2026-01-01T00:00:00Z format" }, 400, cors);
    }

    const q = new URLSearchParams({ symbol, eventStartTime: start, variant });
    if (end) q.set("endDate", end);
    const upstream = await fetch(`${UPSTREAM}?${q}`, { headers: { Accept: "application/json" }, cf: { cacheTtl: 3, cacheEverything: true } });
    const body = await upstream.text();
    let cache = "public, max-age=3";
    try { if (JSON.parse(body).completed) cache = "public, max-age=86400"; } catch {}
    return new Response(body, { status: upstream.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": cache } });
  }
};

const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
