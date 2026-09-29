const express = require("express");
const { createAlphaVantageProvider } = require("./market-data");
const app = express();
const started = Date.now();
let requests = 0;

app.use((req, res, next) => { requests++; next(); });
app.use(express.static("public", { extensions: ["html"] }));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/ready", (req, res) => res.json({ ready: true }));

// Prometheus-style metrics for the monitoring exercise
app.get("/metrics", (req, res) => {
  res.type("text/plain").send(
    `# TYPE demofolio_requests_total counter\ndemofolio_requests_total ${requests}\n` +
    `# TYPE demofolio_uptime_seconds gauge\ndemofolio_uptime_seconds ${Math.floor((Date.now() - started) / 1000)}\n`
  );
});

app.get("/api/plans", (req, res) => res.json({
  disclaimer: "Simulated data for DevOps practice. Not financial advice.",
  plans: [
    { name: "Starter", virtualBalance: 1000 },
    { name: "Pro", virtualBalance: 10000 }
  ]
}));

app.get("/api/portfolio", (req, res) => res.json({
  simulated: true,
  holdings: [
    { symbol: "DEMO-A", qty: 12, price: 101.5 },
    { symbol: "DEMO-B", qty: 4, price: 250.0 },
    { symbol: "DEMO-C", qty: 30, price: 18.2 }
  ]
}));

const marketProvider = createAlphaVantageProvider();
app.get("/api/v1/markets/daily", async (req, res) => {
  try {
    res.json(await req.app.locals.marketProvider.getDailyStocks());
  } catch (error) {
    res.status(error.statusCode || 502).json({
      error: {
        code: error.code || "MARKET_DATA_UNAVAILABLE",
        message: error.statusCode ? error.message : "Daily market data is temporarily unavailable."
      }
    });
  }
});

const port = process.env.PORT || 3000;
app.locals.marketProvider = marketProvider;
if (require.main === module) app.listen(port, () => console.log(`DemoFolio listening on ${port}`));
module.exports = app;
