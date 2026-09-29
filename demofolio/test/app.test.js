const test = require("node:test");
const assert = require("node:assert");
const app = require("../server");
const { createAlphaVantageProvider } = require("../market-data");

test("health, plans and portfolio endpoints respond", async () => {
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    assert.strictEqual((await (await fetch(base + "/health")).json()).status, "ok");
    const plans = await (await fetch(base + "/api/plans")).json();
    assert.ok(plans.disclaimer && plans.plans.length === 2);
    assert.strictEqual((await (await fetch(base + "/api/portfolio")).json()).simulated, true);
  } finally { server.close(); }
});

test("daily market endpoint reports missing provider credentials without making a request", async () => {
  let fetchCount = 0;
  const provider = createAlphaVantageProvider({
    env: { ALPHA_VANTAGE_API_KEY: "", STOCK_SYMBOLS: "AAPL" },
    fetchImpl: async () => { fetchCount++; }
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const previousProvider = app.locals.marketProvider;
  app.locals.marketProvider = provider;

  try {
    const response = await fetch(base + "/api/v1/markets/daily");
    const payload = await response.json();
    assert.strictEqual(response.status, 503);
    assert.strictEqual(payload.error.code, "MARKET_DATA_NOT_CONFIGURED");
    assert.strictEqual(fetchCount, 0);
  } finally {
    server.close();
    app.locals.marketProvider = previousProvider;
  }
});

test("daily market endpoint returns provider OHLCV data", async () => {
  let fetchCount = 0;
  const provider = createAlphaVantageProvider({
    env: { ALPHA_VANTAGE_API_KEY: "server-side-test-key", STOCK_SYMBOLS: "AAPL" },
    fetchImpl: async (url) => {
      fetchCount++;
      assert.strictEqual(new URL(url).searchParams.get("function"), "TIME_SERIES_DAILY");
      return {
        ok: true,
        json: async () => ({
          "Time Series (Daily)": {
            "2026-09-28": {
              "1. open": "100.00",
              "2. high": "106.00",
              "3. low": "99.00",
              "4. close": "105.00",
              "5. volume": "123456"
            },
            "2026-09-25": { "4. close": "100.00" }
          }
        })
      };
    }
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const previousProvider = app.locals.marketProvider;
  app.locals.marketProvider = provider;

  try {
    const response = await fetch(base + "/api/v1/markets/daily");
    const payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.provider, "Alpha Vantage");
    assert.strictEqual(payload.stocks[0].date, "2026-09-28");
    assert.strictEqual(payload.stocks[0].close, 105);
    assert.strictEqual(payload.stocks[0].changePercent, 5);
    assert.strictEqual(fetchCount, 1);
    assert.ok(!JSON.stringify(payload).includes("server-side-test-key"));
  } finally {
    server.close();
    app.locals.marketProvider = previousProvider;
  }
});

test("realtime quote mode requests the realtime entitlement and reports provider quotes", async () => {
  let requestedUrl;
  const provider = createAlphaVantageProvider({
    env: { ALPHA_VANTAGE_API_KEY: "server-side-test-key", STOCK_SYMBOLS: "AAPL", MARKET_DATA_MODE: "realtime" },
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        json: async () => ({
          "Global Quote": {
            "01. symbol": "AAPL",
            "02. open": "100.00",
            "03. high": "106.00",
            "04. low": "99.00",
            "05. price": "105.00",
            "06. volume": "123456",
            "07. latest trading day": "2026-09-28",
            "09. change": "5.00",
            "10. change percent": "5.0000%"
          }
        })
      };
    }
  });
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const previousProvider = app.locals.marketProvider;
  app.locals.marketProvider = provider;

  try {
    const response = await fetch(base + "/api/v1/markets/daily");
    const payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.mode, "realtime");
    assert.strictEqual(payload.stocks[0].close, 105);
    assert.strictEqual(payload.stocks[0].changePercent, 5);
    assert.strictEqual(requestedUrl.searchParams.get("function"), "GLOBAL_QUOTE");
    assert.strictEqual(requestedUrl.searchParams.get("entitlement"), "realtime");
    assert.ok(!JSON.stringify(payload).includes("server-side-test-key"));
  } finally {
    server.close();
    app.locals.marketProvider = previousProvider;
  }
});
