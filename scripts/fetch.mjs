// scripts/fetch.mjs — direct HTTP, manual Yahoo crumb auth (no external library)
import { readFileSync, writeFileSync } from "node:fs";

const FINNHUB_KEY = process.env.FINNHUB_KEY;
if (!FINNHUB_KEY) {
  console.error("FATAL: FINNHUB_KEY environment variable is not set.");
  process.exit(1);
}

const FINNHUB = "https://finnhub.io/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

// ============ Yahoo cookie + crumb auth ============
let YAHOO_COOKIE = null;
let YAHOO_CRUMB = null;

async function ensureYahooAuth() {
  if (YAHOO_COOKIE && YAHOO_CRUMB) return true;
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: BROWSER_HEADERS, redirect: "manual" });
    const setCookie = r1.headers.get("set-cookie") || "";
    if (setCookie) {
      YAHOO_COOKIE = setCookie.split(",").map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
    }
    if (!YAHOO_COOKIE) {
      const r2 = await fetch("https://query1.finance.yahoo.com/", { headers: BROWSER_HEADERS });
      const sc2 = r2.headers.get("set-cookie") || "";
      YAHOO_COOKIE = sc2.split(",").map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
    }
    if (!YAHOO_COOKIE) return false;
    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { ...BROWSER_HEADERS, "Cookie": YAHOO_COOKIE },
    });
    if (!crumbRes.ok) return false;
    YAHOO_CRUMB = (await crumbRes.text()).trim();
    if (!YAHOO_CRUMB || YAHOO_CRUMB.length > 50) { YAHOO_CRUMB = null; return false; }
    console.log(`Yahoo auth OK (crumb=${YAHOO_CRUMB.slice(0, 8)}...)`);
    return true;
  } catch (e) {
    console.warn(`Yahoo auth failed: ${e.message}`);
    return false;
  }
}

async function finnhub(path, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const url = `${FINNHUB}${path}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status !== 429 && res.status !== 403) {
      console.warn(`finnhub ${path} ${res.status} for ${params.symbol || ""}`);
    }
    return null;
  }
  return res.json();
}

async function yahooCandles(symbol, range = "1y", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue;
      candles.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        time: ts[i],
        open: +(q.open[i] ?? q.close[i]).toFixed(2),
        high: +(q.high[i] ?? q.close[i]).toFixed(2),
        low: +(q.low[i] ?? q.close[i]).toFixed(2),
        close: +q.close[i].toFixed(2),
        volume: q.volume[i] || 0,
      });
    }
    return candles;
  } catch (e) { return []; }
}

async function yahooSummary(symbol) {
  if (!YAHOO_CRUMB) return null;
  const modules = [
    "financialData", "defaultKeyStatistics", "summaryDetail", "price",
    "recommendationTrend", "upgradeDowngradeHistory",
    "earningsTrend", "earningsHistory",
    "insiderTransactions", "majorHoldersBreakdown",
  ].join(",");
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(YAHOO_CRUMB)}`;
  try {
    const res = await fetch(url, { headers: { ...BROWSER_HEADERS, "Cookie": YAHOO_COOKIE } });
    if (!res.ok) {
      if (res.status === 401) {
        YAHOO_COOKIE = null; YAHOO_CRUMB = null;
        await ensureYahooAuth();
        if (YAHOO_CRUMB) {
          const url2 = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=${modules}&crumb=${encodeURIComponent(YAHOO_CRUMB)}`;
          const res2 = await fetch(url2, { headers: { ...BROWSER_HEADERS, "Cookie": YAHOO_COOKIE } });
          if (res2.ok) { const data = await res2.json(); return data?.quoteSummary?.result?.[0] || null; }
        }
      }
      return null;
    }
    const data = await res.json();
    return data?.quoteSummary?.result?.[0] || null;
  } catch (e) { return null; }
}

// ============ OPTIONS CHAIN ============
async function yahooOptions(symbol) {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}`;
  try {
    const res = await fetch(url, { headers: { ...BROWSER_HEADERS, "Cookie": YAHOO_COOKIE || "" } });
    if (!res.ok) {
      console.warn(`yahoo options ${symbol}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data?.optionChain?.result?.[0] || null;
  } catch (e) {
    console.warn(`yahoo options ${symbol}: ${e.message}`);
    return null;
  }
}

function computeOptionsMetrics(optChain, spotPrice) {
  if (!optChain?.options?.[0]) return null;
  const expiry = optChain.options[0];
  const calls = expiry.calls || [];
  const puts = expiry.puts || [];
  if (!calls.length && !puts.length) return null;

  // Put/Call ratios
  const callVolTotal = calls.reduce((s, x) => s + (x.volume || 0), 0);
  const putVolTotal = puts.reduce((s, x) => s + (x.volume || 0), 0);
  const callOITotal = calls.reduce((s, x) => s + (x.openInterest || 0), 0);
  const putOITotal = puts.reduce((s, x) => s + (x.openInterest || 0), 0);
  const pcrVolume = callVolTotal > 0 ? +(putVolTotal / callVolTotal).toFixed(3) : null;
  const pcrOI = callOITotal > 0 ? +(putOITotal / callOITotal).toFixed(3) : null;

  // Top strikes by volume (combined calls + puts)
  const allContracts = [
    ...calls.map((c) => ({ ...c, type: "CALL" })),
    ...puts.map((p) => ({ ...p, type: "PUT" })),
  ].filter((c) => c.volume > 0);
  allContracts.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  const topStrikes = allContracts.slice(0, 8).map((c) => ({
    type: c.type,
    strike: c.strike,
    volume: c.volume || 0,
    openInterest: c.openInterest || 0,
    iv: c.impliedVolatility ? +(c.impliedVolatility * 100).toFixed(1) : null,
    lastPrice: c.lastPrice ?? null,
    // "Unusual" = volume > 2x open interest (signals new positions opening)
    unusual: c.openInterest > 0 ? c.volume > 2 * c.openInterest : c.volume > 1000,
  }));

  // Volatility skew — IV at OTM strikes
  // Find roughly 10-15% OTM put and call
  const targetOTMPct = 0.10;
  const otmCallTarget = spotPrice * (1 + targetOTMPct);
  const otmPutTarget = spotPrice * (1 - targetOTMPct);

  const closestCall = calls.filter((c) => c.impliedVolatility && c.strike >= spotPrice)
    .reduce((closest, c) => !closest || Math.abs(c.strike - otmCallTarget) < Math.abs(closest.strike - otmCallTarget) ? c : closest, null);
  const closestPut = puts.filter((p) => p.impliedVolatility && p.strike <= spotPrice)
    .reduce((closest, p) => !closest || Math.abs(p.strike - otmPutTarget) < Math.abs(closest.strike - otmPutTarget) ? p : closest, null);
  // ATM IV — closest strike to spot
  const atmCall = calls.filter((c) => c.impliedVolatility)
    .reduce((closest, c) => !closest || Math.abs(c.strike - spotPrice) < Math.abs(closest.strike - spotPrice) ? c : closest, null);

  const ivATM = atmCall?.impliedVolatility ? +(atmCall.impliedVolatility * 100).toFixed(1) : null;
  const ivOTMPut = closestPut?.impliedVolatility ? +(closestPut.impliedVolatility * 100).toFixed(1) : null;
  const ivOTMCall = closestCall?.impliedVolatility ? +(closestCall.impliedVolatility * 100).toFixed(1) : null;
  // Skew = OTM put IV - OTM call IV. Positive = fear pricing (puts more expensive).
  const skew = (ivOTMPut != null && ivOTMCall != null) ? +(ivOTMPut - ivOTMCall).toFixed(1) : null;

  // Skew curve data for visualization (every strike with IV)
  const skewCurve = [...calls, ...puts]
    .filter((c) => c.impliedVolatility && c.strike)
    .map((c) => ({
      strike: c.strike,
      iv: +(c.impliedVolatility * 100).toFixed(1),
      moneyness: +((c.strike / spotPrice - 1) * 100).toFixed(1), // % away from spot
    }))
    .sort((a, b) => a.strike - b.strike);

  // Expiry date
  const expiryDate = expiry.expirationDate ? new Date(expiry.expirationDate * 1000).toISOString().slice(0, 10) : null;
  const daysToExpiry = expiry.expirationDate ? Math.round((expiry.expirationDate * 1000 - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  return {
    expiry: expiryDate,
    daysToExpiry,
    spotPrice,
    pcrVolume,
    pcrOI,
    callVolTotal,
    putVolTotal,
    callOITotal,
    putOITotal,
    ivATM,
    ivOTMPut,
    ivOTMCall,
    skew,
    skewCurve,
    topStrikes,
  };
}

const v = (obj, ...path) => {
  let cur = obj;
  for (const p of path) { if (cur == null) return null; cur = cur[p]; }
  if (cur == null) return null;
  if (typeof cur === "object" && "raw" in cur) return cur.raw;
  return cur;
};

async function fetchTicker(t) {
  console.log(`Fetching ${t.symbol}${t.holding ? " (HOLDING)" : ""}...`);

  const [candles1Y, candles5Y, quote, profile, metrics, recs, summary, options] = await Promise.all([
    yahooCandles(t.symbol, "1y", "1d"),
    yahooCandles(t.symbol, "5y", "1wk"),
    finnhub("/quote", { symbol: t.symbol }),
    finnhub("/stock/profile2", { symbol: t.symbol }),
    finnhub("/stock/metric", { symbol: t.symbol, metric: "all" }),
    finnhub("/stock/recommendation", { symbol: t.symbol }),
    yahooSummary(t.symbol),
    yahooOptions(t.symbol),
  ]);

  // Peer fundamentals
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
        pe: v(sd, "trailingPE") ?? m?.metric?.peBasicExclExtraTTM ?? null,
        fwdPe: v(ks, "forwardPE") ?? v(sd, "forwardPE") ?? null,
        peg: v(ks, "pegRatio") ?? v(ks, "trailingPegRatio") ?? null,
        ps: v(sd, "priceToSalesTrailing12Months") ?? m?.metric?.psTTM ?? null,
        evEbitda: v(ks, "enterpriseToEbitda") ?? null,
        roe: v(fd, "returnOnEquity") != null ? v(fd, "returnOnEquity") * 100 : (m?.metric?.roeTTM ?? null),
        mcap: v(sd, "marketCap") != null ? v(sd, "marketCap") / 1e6 : (m?.metric?.marketCapitalization ?? null),
      };
    }
    await sleep(250);
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

  const recTrend = summary?.recommendationTrend?.trend || [];
  const upgrades = summary?.upgradeDowngradeHistory?.history || [];
  const analystData = {
    targetMean: v(fd, "targetMeanPrice"),
    targetHigh: v(fd, "targetHighPrice"),
    targetLow: v(fd, "targetLowPrice"),
    targetMedian: v(fd, "targetMedianPrice"),
    numAnalysts: v(fd, "numberOfAnalystOpinions"),
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

  // Lynch
  const earningsTrend = summary?.earningsTrend?.trend || [];
  const nextYrTrend = earningsTrend.find((e) => e.period === "+1y") || {};
  const fiveYrTrend = earningsTrend.find((e) => e.period === "+5y") || {};
  const epsGrowthNext = v(nextYrTrend, "growth");
  const fiveYrGrowth = v(fiveYrTrend, "growth");
  const earningsHistoryArr = summary?.earningsHistory?.history || [];
  const epsHistory = earningsHistoryArr.map((e) => ({
    actual: v(e, "epsActual"), estimate: v(e, "epsEstimate"),
    surprise: v(e, "epsDifference"), surprisePct: v(e, "surprisePercent"),
  })).filter((e) => e.actual != null);
  const epsValues = epsHistory.map((e) => e.actual).filter((x) => x != null);
  const epsMean = epsValues.length ? epsValues.reduce((s, x) => s + x, 0) / epsValues.length : null;
  const epsStdev = epsValues.length > 1 ? Math.sqrt(epsValues.reduce((s, x) => s + (x - epsMean) ** 2, 0) / epsValues.length) : null;
  const epsCoefVar = epsMean && epsStdev ? Math.abs(epsStdev / epsMean) : null;

  const insiderTxs = summary?.insiderTransactions?.transactions || [];
  let insiderBuys = 0, insiderSells = 0, insiderBuyValue = 0, insiderSellValue = 0;
  insiderTxs.forEach((tx) => {
    const txt = (tx.transactionText || "").toLowerCase();
    const isBuy = txt.includes("purchase") || txt.includes("buy");
    const isSell = txt.includes("sale") || txt.includes("sell");
    const value = v(tx, "value") ?? 0;
    if (isBuy) { insiderBuys++; insiderBuyValue += value; }
    if (isSell) { insiderSells++; insiderSellValue += value; }
  });

  const mcapRaw = v(sd, "marketCap");
  const revG = v(fd, "revenueGrowth");
  let lynchCategory = "—";
  if (mcapRaw && revG != null) {
    if (mcapRaw > 200e9 && Math.abs(revG) < 0.05) lynchCategory = "Stalwart";
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
    heldByInsiders: v(ks, "heldPercentInsiders"),
    heldByInstitutions: v(ks, "heldPercentInstitutions"),
    shortRatio: v(ks, "shortRatio"),
    shortPctFloat: v(ks, "shortPercentOfFloat"),
    pegRatio: v(ks, "pegRatio") ?? v(ks, "trailingPegRatio") ?? m.pegRatio ?? null,
  };

  const simonsData = candles1Y && candles1Y.length >= 50 ? computeSimonsMetrics(candles1Y) : null;

  // ============ OPTIONS ============
  const spotPrice = quote?.c ?? options?.quote?.regularMarketPrice ?? null;
  const optionsData = options && spotPrice ? computeOptionsMetrics(options, spotPrice) : null;

  return {
    symbol: t.symbol,
    name: t.name || profile?.name || v(pr, "shortName") || t.symbol,
    sector: t.sector || profile?.finnhubIndustry || "—",
    peers: t.peers || [],
    holding: !!t.holding,
    fetchedAt: new Date().toISOString(),
    quote: {
      current: quote?.c ?? null, change: quote?.d ?? null, changePct: quote?.dp ?? null,
      high: quote?.h ?? null, low: quote?.l ?? null, open: quote?.o ?? null, prevClose: quote?.pc ?? null,
    },
    candles: candles1Y || [], candles5Y: candles5Y || [],
    fundamentals: {
      pe: v(sd, "trailingPE") ?? m.peBasicExclExtraTTM ?? m.peTTM ?? null,
      fwdPe: v(ks, "forwardPE") ?? v(sd, "forwardPE") ?? null,
      peg: v(ks, "pegRatio") ?? v(ks, "trailingPegRatio") ?? m.pegRatio ?? null,
      pb: v(ks, "priceToBook") ?? m.pbAnnual ?? m.pbQuarterly ?? null,
      ps: v(sd, "priceToSalesTrailing12Months") ?? m.psTTM ?? null,
      evEbitda: v(ks, "enterpriseToEbitda") ?? m["enterpriseValue/EBITDATTM"] ?? null,
      divYield: v(sd, "dividendYield") != null ? v(sd, "dividendYield") * 100 : (m.dividendYieldIndicatedAnnual ?? null),
      divRate: v(sd, "dividendRate"),
      qtrlyDivAmt: v(ks, "lastDividendValue"),
      payout: v(sd, "payoutRatio") != null ? v(sd, "payoutRatio") * 100 : (m.payoutRatioTTM ?? null),
      roe: v(fd, "returnOnEquity") != null ? v(fd, "returnOnEquity") * 100 : (m.roeTTM ?? null),
      roic: m.roiTTM ?? null,
      debtEq: v(fd, "debtToEquity") ?? m["totalDebt/totalEquityAnnual"] ?? null,
      eps: v(ks, "trailingEps") ?? m.epsBasicExclExtraItemsTTM ?? null,
      epsForward: v(ks, "forwardEps"),
      revGrowth: v(fd, "revenueGrowth") != null ? v(fd, "revenueGrowth") * 100 : (m.revenueGrowthTTMYoy ?? null),
      grossMargin: v(fd, "grossMargins") != null ? v(fd, "grossMargins") * 100 : (m.grossMarginTTM ?? null),
      opMargin: v(fd, "operatingMargins") != null ? v(fd, "operatingMargins") * 100 : (m.operatingMarginTTM ?? null),
      profitMargin: v(fd, "profitMargins") != null ? v(fd, "profitMargins") * 100 : null,
      mcap: mcapRaw != null ? mcapRaw / 1e6 : (m.marketCapitalization ?? null),
      mcapRaw,
      week52High: v(sd, "fiftyTwoWeekHigh") ?? m["52WeekHigh"] ?? null,
      week52Low: v(sd, "fiftyTwoWeekLow") ?? m["52WeekLow"] ?? null,
      avgVol: v(sd, "averageVolume"),
      beta: v(ks, "beta") ?? m.beta ?? null,
      sharesOut: v(ks, "sharesOutstanding"),
      bookValue: v(ks, "bookValue"),
      currentRatio: v(fd, "currentRatio"),
      quickRatio: v(fd, "quickRatio"),
      totalCash: v(fd, "totalCash"),
      totalDebt: v(fd, "totalDebt"),
      freeCashflow: v(fd, "freeCashflow"),
      operCashflow: v(fd, "operatingCashflow"),
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
    options: optionsData,
    peerData,
  };
}

function computeSimonsMetrics(candles) {
  const closes = candles.map((c) => c.close);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const autocorr = (k) => {
    if (returns.length < k + 5) return null;
    const r = returns.slice(0, returns.length - k); const rk = returns.slice(k);
    const m1 = r.reduce((s, x) => s + x, 0) / r.length;
    const m2 = rk.reduce((s, x) => s + x, 0) / rk.length;
    let num = 0, d1 = 0, d2 = 0;
    for (let i = 0; i < r.length; i++) {
      num += (r[i] - m1) * (rk[i] - m2);
      d1 += (r[i] - m1) ** 2; d2 += (rk[i] - m2) ** 2;
    }
    return d1 && d2 ? +(num / Math.sqrt(d1 * d2)).toFixed(3) : null;
  };
  const atr = (() => {
    if (candles.length < 15) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close));
      trs.push(tr);
    }
    return +(trs.slice(-14).reduce((s, x) => s + x, 0) / 14).toFixed(2);
  })();
  let peak = closes[0]; let mdd = 0;
  for (const c of closes) { if (c > peak) peak = c; const dd = (c - peak) / peak; if (dd < mdd) mdd = dd; }
  const meanR = returns.reduce((s, x) => s + x, 0) / returns.length;
  const sdR = Math.sqrt(returns.reduce((s, x) => s + (x - meanR) ** 2, 0) / returns.length);
  const sharpe = sdR ? +(meanR / sdR * Math.sqrt(252)).toFixed(2) : null;
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
  const dowReturns = [[], [], [], [], []];
  for (let i = 1; i < candles.length; i++) {
    const day = new Date(candles[i].date).getUTCDay();
    if (day >= 1 && day <= 5) dowReturns[day - 1].push(returns[i - 1]);
  }
  const dowAvg = dowReturns.map((arr) => arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length * 100).toFixed(3) : null);
  return {
    autocorrLag1: autocorr(1), autocorrLag5: autocorr(5), autocorrLag20: autocorr(20),
    atr14: atr, maxDrawdown: +(mdd * 100).toFixed(2),
    sharpe1Y: sharpe, obvTrend, dowAvgReturns: dowAvg,
  };
}

async function main() {
  console.log("Initializing Yahoo Finance auth...");
  await ensureYahooAuth();

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
      const fwd = data.fundamentals.fwdPe;
      const pcr = data.options?.pcrVolume;
      console.log(`  ✓ ${t.symbol}  $${data.quote.current ?? "?"}  fwdPE=${fwd ? fwd.toFixed(1) : "—"}  PCR=${pcr != null ? pcr.toFixed(2) : "—"}  ${t.holding ? "★" : ""}`);
    } catch (e) {
      console.error(`  ✗ ${t.symbol} failed: ${e.message}`);
    }
    await sleep(400);
  }

  writeFileSync("public/data/index.json", JSON.stringify(out, null, 2));
  console.log(`\nDone. Wrote ${out.tickers.length} tickers (${out.tickers.filter(x=>x.holding).length} holdings).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
