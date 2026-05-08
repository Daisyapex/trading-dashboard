// scripts/fetch.mjs
// Runs on GitHub Actions once per day. Reads tickers.json, calls Finnhub
// for fundamentals/quote/recommendations + Yahoo for OHLCV, writes one
// JSON file per ticker into public/data/.
//
// No npm dependencies needed — pure Node fetch (Node 18+).
//
// Required env var: FINNHUB_KEY (set as a GitHub repo secret).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const FINNHUB_KEY = process.env.FINNHUB_KEY;
if (!FINNHUB_KEY) {
  console.error("FATAL: FINNHUB_KEY environment variable is not set.");
  process.exit(1);
}

const FINNHUB = "https://finnhub.io/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------- API helpers --------

async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const url = `${FINNHUB}${path}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`finnhub ${path} returned ${res.status} for ${params.symbol || ""}`);
    return null;
  }
  return res.json();
}

// Yahoo Finance — unofficial but reliable for daily OHLCV from a server.
// Returns ~1 year of daily candles.
async function yahooCandles(symbol) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 60 * 60 * 24 * 365;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; dashboard-fetcher/1.0)" },
    });
    if (!res.ok) {
      console.warn(`yahoo ${symbol} returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue;
      candles.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: +q.open[i].toFixed(2),
        high: +q.high[i].toFixed(2),
        low: +q.low[i].toFixed(2),
        close: +q.close[i].toFixed(2),
        volume: q.volume[i] || 0,
      });
    }
    return candles;
  } catch (e) {
    console.warn(`yahoo ${symbol} threw: ${e.message}`);
    return null;
  }
}

// -------- Per-ticker fetcher --------

async function fetchTicker(t) {
  console.log(`Fetching ${t.symbol}...`);

  // Run Yahoo + Finnhub calls in parallel for speed
  const [candles, quote, profile, metrics, recs] = await Promise.all([
    yahooCandles(t.symbol),
    finnhub("/quote", { symbol: t.symbol }),
    finnhub("/stock/profile2", { symbol: t.symbol }),
    finnhub("/stock/metric", { symbol: t.symbol, metric: "all" }),
    finnhub("/stock/recommendation", { symbol: t.symbol }),
  ]);

  // Pull peer fundamentals (lighter — just metrics)
  const peerData = {};
  for (const p of t.peers) {
    const m = await finnhub("/stock/metric", { symbol: p, metric: "all" });
    const q = await finnhub("/quote", { symbol: p });
    if (m?.metric) {
      peerData[p] = {
        price: q?.c ?? null,
        pe: m.metric.peBasicExclExtraTTM ?? m.metric.peTTM ?? null,
        fwdPe: m.metric.peExclExtraAnnual ?? null,
        peg: m.metric.pegRatio ?? null,
        ps: m.metric.psTTM ?? null,
        evEbitda: m.metric.currentEv?.ebitdaTTM ?? m.metric["enterpriseValue/EBITDATTM"] ?? null,
        roe: m.metric.roeTTM ?? m.metric.roeRfy ?? null,
        mcap: m.metric.marketCapitalization ?? null,
        ytd: m.metric.yearToDatePriceReturnDaily ?? null,
      };
    }
    await sleep(150); // throttle: stay under 60/min
  }

  const m = metrics?.metric || {};
  const latestRec = recs?.[0] || {};
  const totalRecs = (latestRec.strongBuy || 0) + (latestRec.buy || 0) + (latestRec.hold || 0) + (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const buys = (latestRec.strongBuy || 0) + (latestRec.buy || 0);
  const sells = (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const score = totalRecs ? (5 * (latestRec.strongBuy || 0) + 4 * (latestRec.buy || 0) + 3 * (latestRec.hold || 0) + 2 * (latestRec.sell || 0) + (latestRec.strongSell || 0)) / totalRecs : null;
  const rating = score == null ? "—" : score >= 4.5 ? "Strong Buy" : score >= 3.7 ? "Buy" : score >= 2.7 ? "Hold" : score >= 1.7 ? "Sell" : "Strong Sell";

  return {
    symbol: t.symbol,
    name: t.name || profile?.name || t.symbol,
    sector: t.sector || profile?.finnhubIndustry || "—",
    peers: t.peers,
    fetchedAt: new Date().toISOString(),
    quote: {
      current: quote?.c ?? null,
      change: quote?.d ?? null,
      changePct: quote?.dp ?? null,
      high: quote?.h ?? null,
      low: quote?.l ?? null,
      open: quote?.o ?? null,
      prevClose: quote?.pc ?? null,
    },
    candles: candles || [],
    fundamentals: {
      pe: m.peBasicExclExtraTTM ?? m.peTTM ?? null,
      fwdPe: m.peExclExtraAnnual ?? null,
      peg: m.pegRatio ?? null,
      pb: m.pbAnnual ?? m.pbQuarterly ?? null,
      ps: m.psTTM ?? null,
      evEbitda: m["enterpriseValue/EBITDATTM"] ?? null,
      divYield: m.dividendYieldIndicatedAnnual ?? m.currentDividendYieldTTM ?? null,
      payout: m.payoutRatioTTM ?? null,
      roe: m.roeTTM ?? m.roeRfy ?? null,
      roic: m.roiTTM ?? null,
      debtEq: m["totalDebt/totalEquityAnnual"] ?? null,
      fcfYield: m.currentRatioAnnual ? null : null,
      eps: m.epsBasicExclExtraItemsTTM ?? m.epsTTM ?? null,
      revGrowth: m.revenueGrowthTTMYoy ?? null,
      grossMargin: m.grossMarginTTM ?? null,
      opMargin: m.operatingMarginTTM ?? null,
      mcap: m.marketCapitalization ?? null,
      week52High: m["52WeekHigh"] ?? null,
      week52Low: m["52WeekLow"] ?? null,
      beta: m.beta ?? null,
    },
    consensus: {
      rating,
      score: score != null ? +score.toFixed(2) : null,
      analysts: totalRecs || null,
      strongBuy: latestRec.strongBuy ?? 0,
      buy: latestRec.buy ?? 0,
      buys,
      hold: latestRec.hold ?? 0,
      sell: latestRec.sell ?? 0,
      strongSell: latestRec.strongSell ?? 0,
      sells,
      period: latestRec.period ?? null,
    },
    peerData,
  };
}

// -------- Main --------

async function main() {
  const config = JSON.parse(readFileSync("tickers.json", "utf8"));
  const out = { generatedAt: new Date().toISOString(), tickers: [] };

  for (const t of config.tickers) {
    try {
      const data = await fetchTicker(t);
      writeFileSync(`public/data/${t.symbol}.json`, JSON.stringify(data));
      out.tickers.push({
        symbol: t.symbol,
        name: t.name,
        sector: t.sector,
        price: data.quote.current,
        change: data.quote.change,
        changePct: data.quote.changePct,
      });
      console.log(`  ✓ ${t.symbol}  $${data.quote.current ?? "?"}  (${data.candles.length} bars)`);
    } catch (e) {
      console.error(`  ✗ ${t.symbol} failed: ${e.message}`);
    }
    await sleep(300); // additional pacing between tickers
  }

  writeFileSync("public/data/index.json", JSON.stringify(out, null, 2));
  console.log(`\nDone. Wrote ${out.tickers.length} tickers.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
