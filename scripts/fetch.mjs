// scripts/fetch.mjs
import { readFileSync, writeFileSync } from "node:fs";

const FINNHUB_KEY = process.env.FINNHUB_KEY;
if (!FINNHUB_KEY) {
  console.error("FATAL: FINNHUB_KEY environment variable is not set.");
  process.exit(1);
}

const FINNHUB = "https://finnhub.io/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": "Mozilla/5.0 (compatible; dashboard-fetcher/1.0)" };

async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const url = `${FINNHUB}${path}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`finnhub ${path} ${res.status} for ${params.symbol || ""}`);
    return null;
  }
  return res.json();
}

// Yahoo daily candles, 1Y
async function yahooCandles(symbol, range = "1y", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return null;
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
        time: ts[i],
        open: +q.open[i].toFixed(2), high: +q.high[i].toFixed(2),
        low: +q.low[i].toFixed(2), close: +q.close[i].toFixed(2),
        volume: q.volume[i] || 0,
      });
    }
    return candles;
  } catch (e) { return null; }
}

// Yahoo quoteSummary — pulls many modules at once
async function yahooSummary(symbol) {
  const modules = [
    "financialData", "defaultKeyStatistics", "summaryDetail", "price",
    "recommendationTrend", "upgradeDowngradeHistory",
    "earningsTrend", "earningsHistory",
    "institutionOwnership", "insiderTransactions", "majorHoldersBreakdown",
  ].join(",");
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}`;
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) {
      console.warn(`yahoo summary ${symbol} ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data?.quoteSummary?.result?.[0] || null;
  } catch (e) {
    console.warn(`yahoo summary ${symbol} failed: ${e.message}`);
    return null;
  }
}

// Helper: get raw value from Yahoo (which wraps numbers as { raw, fmt })
const yv = (obj, key) => obj?.[key]?.raw ?? null;

async function fetchTicker(t) {
  console.log(`Fetching ${t.symbol}${t.holding ? " (HOLDING)" : ""}...`);

  const [candles1Y, candles5Y, quote, profile, metrics, recs, summary] = await Promise.all([
    yahooCandles(t.symbol, "1y", "1d"),
    yahooCandles(t.symbol, "5y", "1wk"),
    finnhub("/quote", { symbol: t.symbol }),
    finnhub("/stock/profile2", { symbol: t.symbol }),
    finnhub("/stock/metric", { symbol: t.symbol, metric: "all" }),
    finnhub("/stock/recommendation", { symbol: t.symbol }),
    yahooSummary(t.symbol),
  ]);

  // Peer fundamentals (using Yahoo this time too for forward P/E accuracy)
  const peerData = {};
  for (const p of (t.peers || [])) {
    const [m, q, ys] = await Promise.all([
      finnhub("/stock/metric", { symbol: p, metric: "all" }),
      finnhub("/quote", { symbol: p }),
      yahooSummary(p),
    ]);
    if (m?.metric || ys) {
      const ks = ys?.defaultKeyStatistics || {};
      const sd = ys?.summaryDetail || {};
      const fd = ys?.financialData || {};
      peerData[p] = {
        price: q?.c ?? null,
        pe: yv(sd, "trailingPE") ?? m?.metric?.peBasicExclExtraTTM ?? null,
        fwdPe: yv(ks, "forwardPE") ?? yv(sd, "forwardPE") ?? null,  // Fixed!
        peg: yv(ks, "pegRatio") ?? m?.metric?.pegRatio ?? null,
        ps: yv(sd, "priceToSalesTrailing12Months") ?? m?.metric?.psTTM ?? null,
        evEbitda: yv(ks, "enterpriseToEbitda") ?? null,
        roe: yv(fd, "returnOnEquity") != null ? yv(fd, "returnOnEquity") * 100 : (m?.metric?.roeTTM ?? null),
        mcap: yv(sd, "marketCap") != null ? yv(sd, "marketCap") / 1e6 : (m?.metric?.marketCapitalization ?? null),
      };
    }
    await sleep(150);
  }

  const m = metrics?.metric || {};
  const ks = summary?.defaultKeyStatistics || {};
  const sd = summary?.summaryDetail || {};
  const fd = summary?.financialData || {};
  const pr = summary?.price || {};

  const latestRec = recs?.[0] || {};
  const totalRecs = (latestRec.strongBuy || 0) + (latestRec.buy || 0) + (latestRec.hold || 0) + (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const buys = (latestRec.strongBuy || 0) + (latestRec.buy || 0);
  const sells = (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const score = totalRecs ? (5 * (latestRec.strongBuy || 0) + 4 * (latestRec.buy || 0) + 3 * (latestRec.hold || 0) + 2 * (latestRec.sell || 0) + (latestRec.strongSell || 0)) / totalRecs : null;
  const rating = score == null ? "—" : score >= 4.5 ? "Strong Buy" : score >= 3.7 ? "Buy" : score >= 2.7 ? "Hold" : score >= 1.7 ? "Sell" : "Strong Sell";

  // Analyst data
  const recTrend = summary?.recommendationTrend?.trend || [];
  const upgrades = summary?.upgradeDowngradeHistory?.history || [];
  const analystData = {
    targetMean: yv(fd, "targetMeanPrice"),
    targetHigh: yv(fd, "targetHighPrice"),
    targetLow: yv(fd, "targetLowPrice"),
    targetMedian: yv(fd, "targetMedianPrice"),
    numAnalysts: yv(fd, "numberOfAnalystOpinions"),
    monthlyTrend: recTrend.slice(0, 4).reverse().map((r) => ({
      period: r.period, strongBuy: r.strongBuy ?? 0, buy: r.buy ?? 0,
      hold: r.hold ?? 0, sell: r.sell ?? 0, strongSell: r.strongSell ?? 0,
    })),
    latestActions: upgrades.slice(0, 5).map((u) => ({
      date: u.epochGradeDate ? new Date(u.epochGradeDate * 1000).toISOString().slice(0, 10) : null,
      firm: u.firm ?? null, toGrade: u.toGrade ?? null,
      fromGrade: u.fromGrade ?? null, action: u.action ?? null,
    })),
  };

  // ============ LYNCH METRICS ============
  const earningsTrend = summary?.earningsTrend?.trend || [];
  const nextYrTrend = earningsTrend.find((e) => e.period === "+1y") || {};
  const epsGrowthNext = yv(nextYrTrend.growth, "raw") ?? yv(nextYrTrend, "growth");
  const revGrowthNext = yv(nextYrTrend.revenueEstimate ? nextYrTrend.revenueEstimate.growth : {}, "raw");
  // 5yr growth from earningsTrend "+5y"
  const fiveYrTrend = earningsTrend.find((e) => e.period === "+5y") || {};
  const fiveYrGrowth = yv(fiveYrTrend, "growth");

  const earningsHistoryArr = summary?.earningsHistory?.history || [];
  const epsHistory = earningsHistoryArr.map((e) => ({
    quarter: e.quarter?.fmt ?? null,
    actual: yv(e, "epsActual"),
    estimate: yv(e, "epsEstimate"),
    surprise: yv(e, "epsDifference"),
    surprisePct: yv(e, "surprisePercent"),
  })).filter((e) => e.actual != null);

  // EPS volatility (lower = more stable, what Lynch wanted)
  const epsValues = epsHistory.map((e) => e.actual).filter((v) => v != null);
  const epsMean = epsValues.length ? epsValues.reduce((s, x) => s + x, 0) / epsValues.length : null;
  const epsStdev = epsValues.length > 1 ? Math.sqrt(epsValues.reduce((s, x) => s + (x - epsMean) ** 2, 0) / epsValues.length) : null;
  const epsCoefVar = epsMean && epsStdev ? Math.abs(epsStdev / epsMean) : null;

  // Insider activity (last 6 months)
  const insiderTxs = summary?.insiderTransactions?.transactions || [];
  let insiderBuys = 0, insiderSells = 0, insiderBuyValue = 0, insiderSellValue = 0;
  insiderTxs.forEach((tx) => {
    const isBuy = tx.transactionText?.toLowerCase().includes("purchase") || tx.transactionText?.toLowerCase().includes("buy");
    const isSell = tx.transactionText?.toLowerCase().includes("sale") || tx.transactionText?.toLowerCase().includes("sell");
    const value = yv(tx, "value") ?? 0;
    if (isBuy) { insiderBuys++; insiderBuyValue += value; }
    if (isSell) { insiderSells++; insiderSellValue += value; }
  });

  // Lynch category heuristic
  const mcap = yv(sd, "marketCap"); // in dollars
  const revG = yv(fd, "revenueGrowth"); // 0.x form
  let lynchCategory = "—";
  if (mcap && revG != null) {
    if (mcap > 200e9 && Math.abs(revG) < 0.05) lynchCategory = "Stalwart";
    else if (mcap < 5e9 && revG > 0.20) lynchCategory = "Fast Grower";
    else if (revG > 0.20) lynchCategory = "Fast Grower";
    else if (revG < -0.05) lynchCategory = "Turnaround";
    else if (revG < 0.05) lynchCategory = "Slow Grower";
    else lynchCategory = "Stalwart";
  }

  const lynchData = {
    category: lynchCategory,
    epsGrowthNextYr: epsGrowthNext != null ? epsGrowthNext * 100 : null,
    epsGrowth5Yr: fiveYrGrowth != null ? fiveYrGrowth * 100 : null,
    epsCoefVar: epsCoefVar != null ? +epsCoefVar.toFixed(3) : null,
    epsHistory: epsHistory.slice(0, 8),
    insiderBuys, insiderSells,
    insiderBuyValue: Math.round(insiderBuyValue),
    insiderSellValue: Math.round(insiderSellValue),
    netInsiderActivity: insiderBuyValue - insiderSellValue,
    heldByInsiders: yv(ks, "heldPercentInsiders"),
    heldByInstitutions: yv(ks, "heldPercentInstitutions"),
    shortRatio: yv(ks, "shortRatio"),
    shortPctFloat: yv(ks, "shortPercentOfFloat"),
    pegRatio: yv(ks, "pegRatio") ?? yv(ks, "trailingPegRatio") ?? m?.pegRatio ?? null,
  };

  // ============ SIMONS-STYLE METRICS (calc'd from candles) ============
  const simonsData = candles1Y && candles1Y.length >= 50 ? computeSimonsMetrics(candles1Y) : null;

  return {
    symbol: t.symbol,
    name: t.name || profile?.name || pr?.shortName || t.symbol,
    sector: t.sector || profile?.finnhubIndustry || "—",
    peers: t.peers || [],
    holding: !!t.holding,
    fetchedAt: new Date().toISOString(),
    quote: {
      current: quote?.c ?? null, change: quote?.d ?? null, changePct: quote?.dp ?? null,
      high: quote?.h ?? null, low: quote?.l ?? null, open: quote?.o ?? null, prevClose: quote?.pc ?? null,
    },
    candles: candles1Y || [],
    candles5Y: candles5Y || [],
    fundamentals: {
      // Use Yahoo as primary source — much more reliable
      pe: yv(sd, "trailingPE") ?? m.peBasicExclExtraTTM ?? m.peTTM ?? null,
      fwdPe: yv(ks, "forwardPE") ?? yv(sd, "forwardPE") ?? null,    // FIXED
      peg: yv(ks, "pegRatio") ?? yv(ks, "trailingPegRatio") ?? m.pegRatio ?? null,
      pb: yv(ks, "priceToBook") ?? m.pbAnnual ?? m.pbQuarterly ?? null,
      ps: yv(sd, "priceToSalesTrailing12Months") ?? m.psTTM ?? null,
      evEbitda: yv(ks, "enterpriseToEbitda") ?? m["enterpriseValue/EBITDATTM"] ?? null,
      divYield: yv(sd, "dividendYield") != null ? yv(sd, "dividendYield") * 100 : (m.dividendYieldIndicatedAnnual ?? null),
      divRate: yv(sd, "dividendRate"),
      qtrlyDivAmt: yv(ks, "lastDividendValue"),
      payout: yv(sd, "payoutRatio") != null ? yv(sd, "payoutRatio") * 100 : (m.payoutRatioTTM ?? null),
      roe: yv(fd, "returnOnEquity") != null ? yv(fd, "returnOnEquity") * 100 : (m.roeTTM ?? null),
      roic: m.roiTTM ?? null,
      debtEq: yv(fd, "debtToEquity") ?? m["totalDebt/totalEquityAnnual"] ?? null,
      eps: yv(ks, "trailingEps") ?? m.epsBasicExclExtraItemsTTM ?? null,
      epsForward: yv(ks, "forwardEps"),
      revGrowth: yv(fd, "revenueGrowth") != null ? yv(fd, "revenueGrowth") * 100 : (m.revenueGrowthTTMYoy ?? null),
      grossMargin: yv(fd, "grossMargins") != null ? yv(fd, "grossMargins") * 100 : (m.grossMarginTTM ?? null),
      opMargin: yv(fd, "operatingMargins") != null ? yv(fd, "operatingMargins") * 100 : (m.operatingMarginTTM ?? null),
      profitMargin: yv(fd, "profitMargins") != null ? yv(fd, "profitMargins") * 100 : null,
      mcap: yv(sd, "marketCap") != null ? yv(sd, "marketCap") / 1e6 : (m.marketCapitalization ?? null),
      mcapRaw: yv(sd, "marketCap"),
      week52High: yv(sd, "fiftyTwoWeekHigh") ?? m["52WeekHigh"] ?? null,
      week52Low: yv(sd, "fiftyTwoWeekLow") ?? m["52WeekLow"] ?? null,
      avgVol: yv(sd, "averageVolume"),
      beta: yv(ks, "beta") ?? m.beta ?? null,
      sharesOut: yv(ks, "sharesOutstanding"),
      bookValue: yv(ks, "bookValue"),
      currentRatio: yv(fd, "currentRatio"),
      quickRatio: yv(fd, "quickRatio"),
      totalCash: yv(fd, "totalCash"),
      totalDebt: yv(fd, "totalDebt"),
      freeCashflow: yv(fd, "freeCashflow"),
      operCashflow: yv(fd, "operatingCashflow"),
    },
    consensus: {
      rating, score: score != null ? +score.toFixed(2) : null, analysts: totalRecs || null,
      strongBuy: latestRec.strongBuy ?? 0, buy: latestRec.buy ?? 0, buys,
      hold: latestRec.hold ?? 0, sell: latestRec.sell ?? 0, strongSell: latestRec.strongSell ?? 0,
      sells, period: latestRec.period ?? null,
    },
    analyst: analystData,
    lynch: lynchData,
    simons: simonsData,
    peerData,
  };
}

// ============ SIMONS METRICS ============
function computeSimonsMetrics(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));

  // Autocorrelation lag-k of returns
  const autocorr = (k) => {
    if (returns.length < k + 5) return null;
    const r = returns.slice(0, returns.length - k);
    const rk = returns.slice(k);
    const m1 = r.reduce((s, x) => s + x, 0) / r.length;
    const m2 = rk.reduce((s, x) => s + x, 0) / rk.length;
    let num = 0, d1 = 0, d2 = 0;
    for (let i = 0; i < r.length; i++) {
      num += (r[i] - m1) * (rk[i] - m2);
      d1 += (r[i] - m1) ** 2;
      d2 += (rk[i] - m2) ** 2;
    }
    return d1 && d2 ? +(num / Math.sqrt(d1 * d2)).toFixed(3) : null;
  };

  // ATR(14)
  const atr = (() => {
    if (candles.length < 15) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      trs.push(tr);
    }
    const last14 = trs.slice(-14);
    return +(last14.reduce((s, x) => s + x, 0) / 14).toFixed(2);
  })();

  // Max drawdown over the period
  const maxDD = (() => {
    let peak = closes[0]; let mdd = 0;
    for (const c of closes) {
      if (c > peak) peak = c;
      const dd = (c - peak) / peak;
      if (dd < mdd) mdd = dd;
    }
    return +(mdd * 100).toFixed(2);
  })();

  // Sharpe ratio (annualized, rf=0 simple)
  const meanR = returns.reduce((s, x) => s + x, 0) / returns.length;
  const sdR = Math.sqrt(returns.reduce((s, x) => s + (x - meanR) ** 2, 0) / returns.length);
  const sharpe = sdR ? +(meanR / sdR * Math.sqrt(252)).toFixed(2) : null;

  // OBV (on-balance volume) trend — last 20 day slope
  const obv = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = obv[i - 1];
    if (candles[i].close > candles[i - 1].close) obv.push(prev + candles[i].volume);
    else if (candles[i].close < candles[i - 1].close) obv.push(prev - candles[i].volume);
    else obv.push(prev);
  }
  const obv20 = obv.slice(-20);
  const obvSlope = obv20.length === 20 ? (obv20[19] - obv20[0]) / 20 : null;
  const obvTrend = obvSlope == null ? "—" : obvSlope > 0 ? "Accumulation" : obvSlope < 0 ? "Distribution" : "Neutral";

  // Day-of-week effect (last 1Y)
  const dowReturns = [[], [], [], [], []]; // Mon-Fri
  for (let i = 1; i < candles.length; i++) {
    const day = new Date(candles[i].date).getUTCDay();
    if (day >= 1 && day <= 5) {
      dowReturns[day - 1].push(returns[i - 1]);
    }
  }
  const dowAvg = dowReturns.map((arr) => arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length * 100).toFixed(3) : null);

  return {
    autocorrLag1: autocorr(1),
    autocorrLag5: autocorr(5),
    autocorrLag20: autocorr(20),
    atr14: atr,
    maxDrawdown: maxDD,
    sharpe1Y: sharpe,
    obvTrend,
    dowAvgReturns: dowAvg, // Mon, Tue, Wed, Thu, Fri
  };
}

async function main() {
  const config = JSON.parse(readFileSync("tickers.json", "utf8"));
  const out = { generatedAt: new Date().toISOString(), tickers: [] };

  for (const t of config.tickers) {
    try {
      const data = await fetchTicker(t);
      writeFileSync(`public/data/${t.symbol}.json`, JSON.stringify(data));
      out.tickers.push({
        symbol: t.symbol, name: t.name, sector: t.sector,
        holding: !!t.holding,
        price: data.quote.current, change: data.quote.change, changePct: data.quote.changePct,
      });
      const fwdPe = data.fundamentals.fwdPe;
      console.log(`  ✓ ${t.symbol}  $${data.quote.current ?? "?"}  fwdPE=${fwdPe ? fwdPe.toFixed(1) : "—"}  ${t.holding ? "★" : ""}`);
    } catch (e) {
      console.error(`  ✗ ${t.symbol} failed: ${e.message}`);
    }
    await sleep(400);
  }

  writeFileSync("public/data/index.json", JSON.stringify(out, null, 2));
  console.log(`\nDone. Wrote ${out.tickers.length} tickers (${out.tickers.filter(x=>x.holding).length} holdings).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
