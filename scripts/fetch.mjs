// scripts/fetch.mjs
import { readFileSync, writeFileSync } from "node:fs";
import YahooFinance from "yahoo-finance2";
const YF = YahooFinance.default || YahooFinance;
const yahooFinance = new YF();



const FINNHUB_KEY = process.env.FINNHUB_KEY;
if (!FINNHUB_KEY) {
  console.error("FATAL: FINNHUB_KEY environment variable is not set.");
  process.exit(1);
}

const FINNHUB = "https://finnhub.io/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Yahoo candles via library
async function yahooCandles(symbol, period1, interval) {
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: new Date(period1 * 1000),
      period2: new Date(),
      interval,
    });
    if (!result?.quotes) return [];
    return result.quotes
      .filter((q) => q.close != null)
      .map((q) => ({
        date: new Date(q.date).toISOString().slice(0, 10),
        time: Math.floor(new Date(q.date).getTime() / 1000),
        open: +(q.open ?? q.close).toFixed(2),
        high: +(q.high ?? q.close).toFixed(2),
        low: +(q.low ?? q.close).toFixed(2),
        close: +q.close.toFixed(2),
        volume: q.volume || 0,
      }));
  } catch (e) {
    console.warn(`yahoo candles ${symbol}: ${e.message}`);
    return [];
  }
}

// Yahoo quoteSummary — uses library, auto-handles auth/crumbs
async function yahooSummary(symbol) {
  try {
    const modules = [
      "financialData", "defaultKeyStatistics", "summaryDetail", "price",
      "recommendationTrend", "upgradeDowngradeHistory",
      "earningsTrend", "earningsHistory",
      "insiderTransactions", "majorHoldersBreakdown",
    ];
    const result = await yahooFinance.quoteSummary(symbol, { modules });
    return result || null;
  } catch (e) {
    console.warn(`yahoo summary ${symbol}: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

async function fetchTicker(t) {
  console.log(`Fetching ${t.symbol}${t.holding ? " (HOLDING)" : ""}...`);

  const period1Y = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365;
  const period5Y = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * 5;

  const [candles1Y, candles5Y, quote, profile, metrics, recs, summary] = await Promise.all([
    yahooCandles(t.symbol, period1Y, "1d"),
    yahooCandles(t.symbol, period5Y, "1wk"),
    finnhub("/quote", { symbol: t.symbol }),
    finnhub("/stock/profile2", { symbol: t.symbol }),
    finnhub("/stock/metric", { symbol: t.symbol, metric: "all" }),
    finnhub("/stock/recommendation", { symbol: t.symbol }),
    yahooSummary(t.symbol),
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
        pe: sd.trailingPE ?? m?.metric?.peBasicExclExtraTTM ?? null,
        fwdPe: ks.forwardPE ?? sd.forwardPE ?? null,
        peg: ks.pegRatio ?? ks.trailingPegRatio ?? null,
        ps: sd.priceToSalesTrailing12Months ?? m?.metric?.psTTM ?? null,
        evEbitda: ks.enterpriseToEbitda ?? null,
        roe: fd.returnOnEquity != null ? fd.returnOnEquity * 100 : (m?.metric?.roeTTM ?? null),
        mcap: sd.marketCap != null ? sd.marketCap / 1e6 : (m?.metric?.marketCapitalization ?? null),
      };
    }
    await sleep(200);
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
    targetMean: fd.targetMeanPrice ?? null,
    targetHigh: fd.targetHighPrice ?? null,
    targetLow: fd.targetLowPrice ?? null,
    targetMedian: fd.targetMedianPrice ?? null,
    numAnalysts: fd.numberOfAnalystOpinions ?? null,
    monthlyTrend: recTrend.slice(0, 4).reverse().map((r) => ({
      period: r.period, strongBuy: r.strongBuy ?? 0, buy: r.buy ?? 0,
      hold: r.hold ?? 0, sell: r.sell ?? 0, strongSell: r.strongSell ?? 0,
    })),
    latestActions: upgrades.slice(0, 5).map((u) => ({
      date: u.epochGradeDate ? new Date(u.epochGradeDate).toISOString().slice(0, 10) : null,
      firm: u.firm ?? null, toGrade: u.toGrade ?? null,
      fromGrade: u.fromGrade ?? null, action: u.action ?? null,
    })),
  };

  // Lynch metrics
  const earningsTrend = summary?.earningsTrend?.trend || [];
  const nextYrTrend = earningsTrend.find((e) => e.period === "+1y") || {};
  const fiveYrTrend = earningsTrend.find((e) => e.period === "+5y") || {};
  const epsGrowthNext = nextYrTrend?.growth ?? null;
  const fiveYrGrowth = fiveYrTrend?.growth ?? null;

  const earningsHistoryArr = summary?.earningsHistory?.history || [];
  const epsHistory = earningsHistoryArr.map((e) => ({
    quarter: e.quarter ?? null,
    actual: e.epsActual ?? null,
    estimate: e.epsEstimate ?? null,
    surprise: e.epsDifference ?? null,
    surprisePct: e.surprisePercent ?? null,
  })).filter((e) => e.actual != null);

  const epsValues = epsHistory.map((e) => e.actual).filter((v) => v != null);
  const epsMean = epsValues.length ? epsValues.reduce((s, x) => s + x, 0) / epsValues.length : null;
  const epsStdev = epsValues.length > 1 ? Math.sqrt(epsValues.reduce((s, x) => s + (x - epsMean) ** 2, 0) / epsValues.length) : null;
  const epsCoefVar = epsMean && epsStdev ? Math.abs(epsStdev / epsMean) : null;

  const insiderTxs = summary?.insiderTransactions?.transactions || [];
  let insiderBuys = 0, insiderSells = 0, insiderBuyValue = 0, insiderSellValue = 0;
  insiderTxs.forEach((tx) => {
    const txt = (tx.transactionText || "").toLowerCase();
    const isBuy = txt.includes("purchase") || txt.includes("buy");
    const isSell = txt.includes("sale") || txt.includes("sell");
    const value = tx.value ?? 0;
    if (isBuy) { insiderBuys++; insiderBuyValue += value; }
    if (isSell) { insiderSells++; insiderSellValue += value; }
  });

  const mcap = sd.marketCap;
  const revG = fd.revenueGrowth;
  let lynchCategory = "—";
  if (mcap && revG != null) {
    if (mcap > 200e9 && Math.abs(revG) < 0.05) lynchCategory = "Stalwart";
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
    heldByInsiders: ks.heldPercentInsiders ?? null,
    heldByInstitutions: ks.heldPercentInstitutions ?? null,
    shortRatio: ks.shortRatio ?? null,
    shortPctFloat: ks.shortPercentOfFloat ?? null,
    pegRatio: ks.pegRatio ?? ks.trailingPegRatio ?? m.pegRatio ?? null,
  };

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
      pe: sd.trailingPE ?? m.peBasicExclExtraTTM ?? m.peTTM ?? null,
      fwdPe: ks.forwardPE ?? sd.forwardPE ?? null,
      peg: ks.pegRatio ?? ks.trailingPegRatio ?? m.pegRatio ?? null,
      pb: ks.priceToBook ?? m.pbAnnual ?? m.pbQuarterly ?? null,
      ps: sd.priceToSalesTrailing12Months ?? m.psTTM ?? null,
      evEbitda: ks.enterpriseToEbitda ?? m["enterpriseValue/EBITDATTM"] ?? null,
      divYield: sd.dividendYield != null ? sd.dividendYield * 100 : (m.dividendYieldIndicatedAnnual ?? null),
      divRate: sd.dividendRate ?? null,
      qtrlyDivAmt: ks.lastDividendValue ?? null,
      payout: sd.payoutRatio != null ? sd.payoutRatio * 100 : (m.payoutRatioTTM ?? null),
      roe: fd.returnOnEquity != null ? fd.returnOnEquity * 100 : (m.roeTTM ?? null),
      roic: m.roiTTM ?? null,
      debtEq: fd.debtToEquity ?? m["totalDebt/totalEquityAnnual"] ?? null,
      eps: ks.trailingEps ?? m.epsBasicExclExtraItemsTTM ?? null,
      epsForward: ks.forwardEps ?? null,
      revGrowth: fd.revenueGrowth != null ? fd.revenueGrowth * 100 : (m.revenueGrowthTTMYoy ?? null),
      grossMargin: fd.grossMargins != null ? fd.grossMargins * 100 : (m.grossMarginTTM ?? null),
      opMargin: fd.operatingMargins != null ? fd.operatingMargins * 100 : (m.operatingMarginTTM ?? null),
      profitMargin: fd.profitMargins != null ? fd.profitMargins * 100 : null,
      mcap: sd.marketCap != null ? sd.marketCap / 1e6 : (m.marketCapitalization ?? null),
      mcapRaw: sd.marketCap ?? null,
      week52High: sd.fiftyTwoWeekHigh ?? m["52WeekHigh"] ?? null,
      week52Low: sd.fiftyTwoWeekLow ?? m["52WeekLow"] ?? null,
      avgVol: sd.averageVolume ?? null,
      beta: ks.beta ?? m.beta ?? null,
      sharesOut: ks.sharesOutstanding ?? null,
      bookValue: ks.bookValue ?? null,
      currentRatio: fd.currentRatio ?? null,
      quickRatio: fd.quickRatio ?? null,
      totalCash: fd.totalCash ?? null,
      totalDebt: fd.totalDebt ?? null,
      freeCashflow: fd.freeCashflow ?? null,
      operCashflow: fd.operatingCashflow ?? null,
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

function computeSimonsMetrics(candles) {
  const closes = candles.map((c) => c.close);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));

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

  let peak = closes[0]; let mdd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < mdd) mdd = dd;
  }

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
    autocorrLag1: autocorr(1),
    autocorrLag5: autocorr(5),
    autocorrLag20: autocorr(20),
    atr14: atr,
    maxDrawdown: +(mdd * 100).toFixed(2),
    sharpe1Y: sharpe,
    obvTrend,
    dowAvgReturns: dowAvg,
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
      const fwd = data.fundamentals.fwdPe;
      const tgt = data.analyst?.targetMean;
      console.log(`  ✓ ${t.symbol}  $${data.quote.current ?? "?"}  fwdPE=${fwd ? fwd.toFixed(1) : "—"}  tgt=${tgt ? "$" + tgt.toFixed(0) : "—"}  ${t.holding ? "★" : ""}`);
    } catch (e) {
      console.error(`  ✗ ${t.symbol} failed: ${e.message}`);
    }
    await sleep(400);
  }

  writeFileSync("public/data/index.json", JSON.stringify(out, null, 2));
  console.log(`\nDone. Wrote ${out.tickers.length} tickers (${out.tickers.filter(x=>x.holding).length} holdings).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
