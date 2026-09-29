const defaultStockSymbols = ["AAPL", "MSFT", "NVDA", "TSLA"];
const cacheDuration = 6 * 60 * 60 * 1000;

function marketError(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function readDailyBar(payload, symbol) {
  if (payload.Note || payload.Information || payload["Error Message"]) {
    throw marketError("MARKET_DATA_PROVIDER_UNAVAILABLE", 503, "The market data provider is temporarily unavailable.");
  }

  const series = payload["Time Series (Daily)"];
  if (!series || typeof series !== "object") {
    throw marketError("MARKET_DATA_INVALID_RESPONSE", 502, "Daily market data could not be validated.");
  }

  const dates = Object.keys(series).sort((left, right) => right.localeCompare(left));
  if (dates.length < 2) {
    throw marketError("MARKET_DATA_INSUFFICIENT_HISTORY", 502, "Daily market data is not available for comparison.");
  }

  const date = dates[0];
  const latest = series[date];
  const previous = series[dates[1]];
  const open = Number(latest["1. open"]);
  const high = Number(latest["2. high"]);
  const low = Number(latest["3. low"]);
  const close = Number(latest["4. close"]);
  const volume = Number(latest["5. volume"]);
  const previousClose = Number(previous["4. close"]);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      ![open, high, low, close, volume, previousClose].every(Number.isFinite) ||
      [open, high, low, close, previousClose].some((value) => value <= 0) ||
      volume < 0 || high < low) {
    throw marketError("MARKET_DATA_INVALID_RESPONSE", 502, "Daily market data could not be validated.");
  }

  const change = close - previousClose;

  return {
    symbol,
    date,
    open,
    high,
    low,
    close,
    volume,
    change,
    changePercent: (change / previousClose) * 100
  };
}

function readGlobalQuote(payload, symbol) {
  if (payload.Note || payload.Information || payload["Error Message"]) {
    throw marketError("MARKET_DATA_PROVIDER_UNAVAILABLE", 503, "The market data provider is temporarily unavailable.");
  }

  const quote = payload["Global Quote"];
  if (!quote || typeof quote !== "object") {
    throw marketError("MARKET_DATA_INVALID_RESPONSE", 502, "The real-time quote could not be validated.");
  }

  const date = quote["07. latest trading day"];
  const open = Number(quote["02. open"]);
  const high = Number(quote["03. high"]);
  const low = Number(quote["04. low"]);
  const close = Number(quote["05. price"]);
  const volume = Number(quote["06. volume"]);
  const change = Number(quote["09. change"]);
  const changePercent = Number(String(quote["10. change percent"]).replace("%", ""));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      ![open, high, low, close, volume, change, changePercent].every(Number.isFinite) ||
      [open, high, low, close].some((value) => value <= 0) ||
      volume < 0 || high < low) {
    throw marketError("MARKET_DATA_INVALID_RESPONSE", 502, "The real-time quote could not be validated.");
  }

  return { symbol, date, open, high, low, close, volume, change, changePercent };
}

function createAlphaVantageProvider({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now
} = {}) {
  const apiKey = env.ALPHA_VANTAGE_API_KEY;
  const symbols = (env.STOCK_SYMBOLS || defaultStockSymbols.join(","))
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase());
  const mode = env.MARKET_DATA_MODE || "daily";

  if (symbols.length < 1 || symbols.length > 5 ||
      symbols.some((symbol) => !/^[A-Z0-9.]{1,15}$/.test(symbol)) ||
      new Set(symbols).size !== symbols.length) {
    throw new Error("STOCK_SYMBOLS must contain one to five unique ticker symbols.");
  }
  if (!["daily", "realtime"].includes(mode)) {
    throw new Error("MARKET_DATA_MODE must be daily or realtime.");
  }

  const cache = new Map();
  const pending = new Map();

  async function getDailyStock(symbol) {
    const cached = cache.get(symbol);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (pending.has(symbol)) return pending.get(symbol);

    const request = (async () => {
      const url = new URL("https://www.alphavantage.co/query");
      url.searchParams.set("function", mode === "realtime" ? "GLOBAL_QUOTE" : "TIME_SERIES_DAILY");
      url.searchParams.set("symbol", symbol);
      if (mode === "realtime") {
        url.searchParams.set("entitlement", "realtime");
      } else {
        url.searchParams.set("outputsize", "compact");
      }
      url.searchParams.set("apikey", apiKey);

      let response;
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
      } catch {
        throw marketError("MARKET_DATA_PROVIDER_UNAVAILABLE", 502, "The market data provider could not be reached.");
      }

      if (!response.ok) {
        throw marketError("MARKET_DATA_PROVIDER_UNAVAILABLE", 502, "The market data provider returned an error.");
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw marketError("MARKET_DATA_INVALID_RESPONSE", 502, "Daily market data could not be validated.");
      }

      const stock = mode === "realtime" ? readGlobalQuote(payload, symbol) : readDailyBar(payload, symbol);
      cache.set(symbol, { value: stock, expiresAt: now() + (mode === "realtime" ? 30_000 : cacheDuration) });
      return stock;
    })();

    pending.set(symbol, request);
    try {
      return await request;
    } finally {
      pending.delete(symbol);
    }
  }

  return {
    async getDailyStocks() {
      if (!apiKey) {
        const message = mode === "realtime"
          ? "Real-time quotes require the ALPHA_VANTAGE_API_KEY secret and real-time provider access."
          : "Daily market data requires the ALPHA_VANTAGE_API_KEY secret.";
        throw marketError("MARKET_DATA_NOT_CONFIGURED", 503, message);
      }

      const stocks = [];
      for (const symbol of symbols) stocks.push(await getDailyStock(symbol));
      return { provider: "Alpha Vantage", mode, interval: mode === "realtime" ? "quote" : "daily", stocks };
    }
  };
}

module.exports = { createAlphaVantageProvider };