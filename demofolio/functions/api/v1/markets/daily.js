const { createAlphaVantageProvider } = require("../../../../market-data.js");

let provider;
let providerSettings;

function getProvider(env) {
  const settings = `${env.ALPHA_VANTAGE_API_KEY || ""}\u0000${env.STOCK_SYMBOLS || ""}`;
  if (!provider || providerSettings !== settings) {
    provider = createAlphaVantageProvider({ env });
    providerSettings = settings;
  }
  return provider;
}

async function getDailyResponse({ request, env, waitUntil }) {
  const realtime = env.MARKET_DATA_MODE === "realtime";
  const responseHeaders = {
    "Cache-Control": realtime
      ? "public, max-age=0, s-maxage=30, stale-while-revalidate=10"
      : "public, max-age=300, s-maxage=21600, stale-while-revalidate=600",
    "X-Content-Type-Options": "nosniff"
  };

  try {
    const data = await getProvider(env).getDailyStocks();
    const response = Response.json(data, { headers: responseHeaders });
    const cacheKey = new Request(`${new URL(request.url).origin}/__market_cache/daily?mode=${realtime ? "realtime" : "daily"}&symbols=${encodeURIComponent(env.STOCK_SYMBOLS || "AAPL,MSFT,NVDA,TSLA")}`);
    waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return Response.json({
      error: {
        code: error.code || "MARKET_DATA_UNAVAILABLE",
        message: error.statusCode ? error.message : "Daily market data is temporarily unavailable."
      }
    }, {
      status: error.statusCode || 502,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  }
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET", "Cache-Control": "no-store" }
    });
  }

  const mode = context.env.MARKET_DATA_MODE === "realtime" ? "realtime" : "daily";
  const cacheKey = new Request(`${new URL(request.url).origin}/__market_cache/daily?mode=${mode}&symbols=${encodeURIComponent(context.env.STOCK_SYMBOLS || "AAPL,MSFT,NVDA,TSLA")}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  return getDailyResponse(context);
}