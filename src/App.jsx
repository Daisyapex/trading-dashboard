import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell, ComposedChart,
} from "recharts";
import {
  Activity, DollarSign, Users, MessageSquare, AlertCircle,
  Search, ChevronRight, Sigma, GitCompare, Briefcase, Loader2,
  Menu, X, TrendingUp, TrendingDown, BarChart3, Zap, Target,
} from "lucide-react";
import { createChart } from "lightweight-charts";

const BASE = import.meta.env.BASE_URL;

// ============================================================
// CONFIG
// ============================================================
const FINNHUB_KEY = "d7v2oe9r01qp7l70qf20d7v2oe9r01qp7l70qf2g";
const REFRESH_MS = 60_000;

const RIGHT_PAD_DESKTOP = 56;
const RIGHT_PAD_MOBILE = 50;

function isMarketOpen() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" && window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

// ============================================================
// INDICATORS
// ============================================================
const sma = (data, period) => data.map((d, i) => {
  if (i < period - 1) return { ...d, [`sma${period}`]: null };
  const slice = data.slice(i - period + 1, i + 1);
  return { ...d, [`sma${period}`]: +(slice.reduce((s, x) => s + x.close, 0) / period).toFixed(3) };
});
const ema = (data, period, key = "close", outKey) => {
  const k = 2 / (period + 1); const out = outKey || `ema${period}`;
  let prev = data[0]?.[key]; if (prev == null) return data;
  return data.map((d, i) => { const v = i === 0 ? d[key] : d[key] * k + prev * (1 - k); prev = v; return { ...d, [out]: +v.toFixed(3) }; });
};
const rsi = (data, period = 14) => {
  let gains = 0, losses = 0;
  return data.map((d, i) => {
    if (i === 0) return { ...d, rsi: null };
    const diff = d.close - data[i - 1].close;
    if (i <= period) {
      if (diff > 0) gains += diff; else losses -= diff;
      if (i === period) { const rs = gains / period / (losses / period || 0.0001); return { ...d, rsi: +(100 - 100 / (1 + rs)).toFixed(1) }; }
      return { ...d, rsi: null };
    }
    const gain = diff > 0 ? diff : 0; const loss = diff < 0 ? -diff : 0;
    gains = (gains * (period - 1) + gain) / period; losses = (losses * (period - 1) + loss) / period;
    const rs = gains / (losses || 0.0001); return { ...d, rsi: +(100 - 100 / (1 + rs)).toFixed(1) };
  });
};
const macd = (data) => {
  if (data.length < 26) return data.map((d) => ({ ...d, macd: null, signal: null, hist: null }));
  let d = ema(data, 12, "close", "_e12"); d = ema(d, 26, "close", "_e26");
  const macdLine = d.map((x) => +(x._e12 - x._e26).toFixed(3));
  const k = 2 / 10; let prev = macdLine[0];
  const signal = macdLine.map((v, i) => { const s = i === 0 ? v : v * k + prev * (1 - k); prev = s; return +s.toFixed(3); });
  return d.map((x, i) => ({ ...x, macd: macdLine[i], signal: signal[i], hist: +(macdLine[i] - signal[i]).toFixed(3) }));
};
const sqzmom = (data, length = 20, multBB = 2, multKC = 1.5) => data.map((d, i) => {
  if (i < length - 1) return { ...d, sqz_mom: null, sqz_on: false };
  const slice = data.slice(i - length + 1, i + 1);
  const mean = slice.reduce((s, x) => s + x.close, 0) / length;
  const sd = Math.sqrt(slice.reduce((s, x) => s + (x.close - mean) ** 2, 0) / length);
  const tr = slice.map((x, j) => { if (j === 0) return x.high - x.low; const p = slice[j - 1].close; return Math.max(x.high - x.low, Math.abs(x.high - p), Math.abs(x.low - p)); });
  const atr = tr.reduce((s, x) => s + x, 0) / length;
  const sqzOn = mean + multBB * sd < mean + multKC * atr && mean - multBB * sd > mean - multKC * atr;
  const highest = Math.max(...slice.map((x) => x.high)); const lowest = Math.min(...slice.map((x) => x.low));
  const target = ((highest + lowest) / 2 + mean) / 2;
  const ys = slice.map((x) => x.close - target); const n = ys.length; const xs = ys.map((_, j) => j);
  const sumX = xs.reduce((s, x) => s + x, 0); const sumY = ys.reduce((s, x) => s + x, 0);
  const sumXY = xs.reduce((s, x, j) => s + x * ys[j], 0); const sumXX = xs.reduce((s, x) => s + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 0.0001);
  const intercept = (sumY - slope * sumX) / n;
  return { ...d, sqz_mom: +(slope * (n - 1) + intercept).toFixed(3), sqz_on: sqzOn };
});
const zscore = (data, period = 20) => data.map((d, i) => {
  if (i < period - 1) return { ...d, zscore: null };
  const slice = data.slice(i - period + 1, i + 1).map((x) => x.close);
  const mean = slice.reduce((s, x) => s + x, 0) / period;
  const sd = Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
  return { ...d, zscore: +((d.close - mean) / (sd || 0.0001)).toFixed(2) };
});
const hurstExponent = (data, period = 100) => {
  if (data.length < period + 1) return 0.5;
  const closes = data.slice(-period - 1).map((x) => x.close);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const n = returns.length; const mean = returns.reduce((s, x) => s + x, 0) / n;
  const dev = returns.map((x) => x - mean); const cum = []; dev.reduce((s, x, i) => (cum[i] = s + x), 0);
  const R = Math.max(...cum) - Math.min(...cum); const S = Math.sqrt(dev.reduce((s, x) => s + x * x, 0) / n);
  return +(Math.log(R / (S || 0.0001)) / Math.log(n)).toFixed(2);
};
const realizedVol = (data, period = 30) => {
  if (data.length < period + 1) return 0;
  const closes = data.slice(-period - 1).map((x) => x.close);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((s, x) => s + (x - mean) ** 2, 0) / returns.length);
  return +(sd * Math.sqrt(252) * 100).toFixed(1);
};

// ATR Trailing Stop (UT Bot Alerts style).
// Calculates ATR(period), then trails a stop line at `multiplier × ATR` below price in uptrends,
// flipping above price in downtrends. Returns each candle augmented with atrStop + atrTrend ("long"/"short").
const atrTrailingStop = (data, period = 10, multiplier = 2) => {
  if (data.length < period + 1) return data.map((d) => ({ ...d, atrStop: null, atrTrend: null }));
  // Compute true range and ATR (Wilder's smoothing)
  const trs = [];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { trs.push(data[i].high - data[i].low); continue; }
    const p = data[i - 1].close;
    trs.push(Math.max(data[i].high - data[i].low, Math.abs(data[i].high - p), Math.abs(data[i].low - p)));
  }
  const atrs = [];
  let atrPrev = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { atrs.push(null); continue; }
    if (i === period - 1) {
      atrPrev = trs.slice(0, period).reduce((s, x) => s + x, 0) / period;
      atrs.push(atrPrev);
    } else {
      atrPrev = (atrPrev * (period - 1) + trs[i]) / period;
      atrs.push(atrPrev);
    }
  }
  // Trail logic
  let trend = "long";
  let stop = null;
  return data.map((d, i) => {
    const atr = atrs[i];
    if (atr == null) return { ...d, atrStop: null, atrTrend: null };
    const longStop = d.close - multiplier * atr;
    const shortStop = d.close + multiplier * atr;
    if (stop == null) { stop = longStop; trend = "long"; }
    else if (trend === "long") {
      if (d.close < stop) { trend = "short"; stop = shortStop; }
      else { stop = Math.max(stop, longStop); }
    } else {
      if (d.close > stop) { trend = "long"; stop = longStop; }
      else { stop = Math.min(stop, shortStop); }
    }
    return { ...d, atrStop: +stop.toFixed(2), atrTrend: trend };
  });
};

// ============================================================
// CANDLESTICK CHART
// ============================================================
function CandlestickChart({ data, height = 400, isMobile, onPriceScaleWidth }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !data?.length) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth, height,
      layout: { background: { type: "solid", color: "#ffffff" }, textColor: "#1a1f2c", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 },
      grid: { vertLines: { color: "#efece5" }, horzLines: { color: "#efece5" } },
      rightPriceScale: { borderColor: "#e6e3db", scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: "#e6e3db", timeVisible: false, secondsVisible: false, rightOffset: 4 },
      crosshair: {
        mode: 1,
        vertLine: { color: "#d4a017", style: 2, labelBackgroundColor: "#1a1f2c" },
        horzLine: { color: "#d4a017", style: 2, labelBackgroundColor: "#1a1f2c" },
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#0a8554", downColor: "#c4314b",
      borderUpColor: "#0a8554", borderDownColor: "#c4314b",
      wickUpColor: "#0a8554", wickDownColor: "#c4314b",
    });
    candleSeries.setData(data.map((d) => ({
      time: d.date, open: d.open, high: d.high, low: d.low, close: d.close,
    })));

    const addLine = (key, color) => {
      const series = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const lineData = data.filter((d) => d[key] != null).map((d) => ({ time: d.date, value: d[key] }));
      if (lineData.length) series.setData(lineData);
    };
    addLine("sma20", "#d4a017");
    addLine("sma50", "#86b09c");
    addLine("sma200", "#7ba2cc");

    chart.timeScale().fitContent();

    setTimeout(() => {
      try {
        const w = chart.priceScale("right").width();
        if (onPriceScaleWidth && w) onPriceScaleWidth(w);
      } catch (e) {}
    }, 50);

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); chart.remove(); };
  }, [data, height]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}

// ============================================================
// LIVE QUOTE
// ============================================================
function useLiveQuote(symbol) {
  const [quote, setQuote] = useState(null);
  const [status, setStatus] = useState("idle");
  const [lastUpdate, setLastUpdate] = useState(null);
  const intervalRef = useRef(null);
  useEffect(() => {
    if (!symbol) return;
    if (!FINNHUB_KEY) { setStatus("unconfigured"); return; }
    let cancelled = false; setQuote(null); setStatus("idle");
    const fetchQuote = async () => {
      try {
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.c == null || data.c === 0) return;
        setQuote({ current: data.c, change: data.d, changePct: data.dp, high: data.h, low: data.l, open: data.o, prevClose: data.pc });
        setLastUpdate(new Date());
        setStatus(isMarketOpen() ? "live" : "closed");
      } catch (e) { if (!cancelled) setStatus("error"); }
    };
    fetchQuote();
    intervalRef.current = setInterval(fetchQuote, REFRESH_MS);
    return () => { cancelled = true; if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [symbol]);
  return { quote, status, lastUpdate };
}

// ============================================================
// TIMEFRAME-AWARE CANDLE FETCHING
// ============================================================
const TIMEFRAMES = [
  { key: "1M", range: "1mo", interval: "1d", label: "1M" },
  { key: "6M", range: "6mo", interval: "1d", label: "6M" },
  { key: "YTD", range: "ytd", interval: "1d", label: "YTD" },
  { key: "1Y", range: "1y", interval: "1d", label: "1Y", isDefault: true },
  { key: "5Y", range: "5y", interval: "1wk", label: "5Y" },
];

async function fetchYahooCandles(symbol, range, interval) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  const url = `https://corsproxy.io/?url=${encodeURIComponent(target)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    const isIntraday = interval.includes("m") || interval.includes("h");
    candles.push({
      date: isIntraday ? new Date(ts[i] * 1000).toISOString() : new Date(ts[i] * 1000).toISOString().slice(0, 10),
      time: ts[i],
      open: +(q.open[i] || q.close[i]).toFixed(2),
      high: +(q.high[i] || q.close[i]).toFixed(2),
      low: +(q.low[i] || q.close[i]).toFixed(2),
      close: +q.close[i].toFixed(2),
      volume: q.volume[i] || 0,
    });
  }
  return candles;
}

async function yahooSummaryProxied(sym) {
  const modules = "financialData,defaultKeyStatistics,summaryDetail,price,recommendationTrend,upgradeDowngradeHistory,earningsTrend,earningsHistory,insiderTransactions";
  const target = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${modules}`;
  try {
    const res = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(target)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.quoteSummary?.result?.[0] || null;
  } catch (e) { return null; }
}

const yvAdHoc = (obj, ...path) => {
  let cur = obj;
  for (const p of path) { if (cur == null) return null; cur = cur[p]; }
  if (cur == null) return null;
  if (typeof cur === "object" && "raw" in cur) return cur.raw;
  return cur;
};

async function fetchAdHoc(symbol) {
  if (!FINNHUB_KEY) throw new Error("Finnhub key not configured");
  const f = (path, params) => fetch(`https://finnhub.io/api/v1${path}?${new URLSearchParams({ ...params, token: FINNHUB_KEY })}`).then(r => r.ok ? r.json() : null);

  const [quote, profile, metrics, recs, summary, candles] = await Promise.all([
    f("/quote", { symbol }),
    f("/stock/profile2", { symbol }),
    f("/stock/metric", { symbol, metric: "all" }),
    f("/stock/recommendation", { symbol }),
    yahooSummaryProxied(symbol),
    fetchYahooCandles(symbol, "1y", "1d").catch(() => []),
  ]);
  if (!quote || quote.c == null || quote.c === 0) throw new Error(`No data for "${symbol}"`);

  const m = metrics?.metric || {};
  const ks = summary?.defaultKeyStatistics || {};
  const sd = summary?.summaryDetail || {};
  const fd = summary?.financialData || {};

  const latestRec = recs?.[0] || {};
  const totalRecs = (latestRec.strongBuy || 0) + (latestRec.buy || 0) + (latestRec.hold || 0) + (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const buys = (latestRec.strongBuy || 0) + (latestRec.buy || 0);
  const sells = (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const score = totalRecs ? (5 * (latestRec.strongBuy || 0) + 4 * (latestRec.buy || 0) + 3 * (latestRec.hold || 0) + 2 * (latestRec.sell || 0) + (latestRec.strongSell || 0)) / totalRecs : null;
  const rating = score == null ? "—" : score >= 4.5 ? "Strong Buy" : score >= 3.7 ? "Buy" : score >= 2.7 ? "Hold" : score >= 1.7 ? "Sell" : "Strong Sell";

  const recTrend = summary?.recommendationTrend?.trend || [];
  const upgrades = summary?.upgradeDowngradeHistory?.history || [];
  const analystData = yvAdHoc(fd, "targetMeanPrice") ? {
    targetMean: yvAdHoc(fd, "targetMeanPrice"),
    targetHigh: yvAdHoc(fd, "targetHighPrice"),
    targetLow: yvAdHoc(fd, "targetLowPrice"),
    targetMedian: yvAdHoc(fd, "targetMedianPrice"),
    numAnalysts: yvAdHoc(fd, "numberOfAnalystOpinions"),
    monthlyTrend: recTrend.slice(0, 4).reverse().map((r) => ({
      period: r.period, strongBuy: r.strongBuy ?? 0, buy: r.buy ?? 0,
      hold: r.hold ?? 0, sell: r.sell ?? 0, strongSell: r.strongSell ?? 0,
    })),
    latestActions: upgrades.slice(0, 5).map((u) => ({
      date: u.epochGradeDate ? new Date(u.epochGradeDate * 1000).toISOString().slice(0, 10) : null,
      firm: u.firm ?? null, toGrade: u.toGrade ?? null,
      fromGrade: u.fromGrade ?? null, action: u.action ?? null,
    })),
  } : null;

  const mcapRaw = yvAdHoc(sd, "marketCap");
  const revG = yvAdHoc(fd, "revenueGrowth");
  let lynchCategory = "—";
  if (mcapRaw && revG != null) {
    if (mcapRaw > 200e9 && Math.abs(revG) < 0.05) lynchCategory = "Stalwart";
    else if (revG > 0.20) lynchCategory = "Fast Grower";
    else if (revG < -0.05) lynchCategory = "Turnaround";
    else if (revG < 0.05) lynchCategory = "Slow Grower";
    else lynchCategory = "Stalwart";
  }

  const earningsTrend = summary?.earningsTrend?.trend || [];
  const nextYrTrend = earningsTrend.find((e) => e.period === "+1y") || {};
  const fiveYrTrend = earningsTrend.find((e) => e.period === "+5y") || {};
  const insiderTxs = summary?.insiderTransactions?.transactions || [];
  let insiderBuys = 0, insiderSells = 0, insiderBuyValue = 0, insiderSellValue = 0;
  insiderTxs.forEach((tx) => {
    const txt = (tx.transactionText || "").toLowerCase();
    const isBuy = txt.includes("purchase") || txt.includes("buy");
    const isSell = txt.includes("sale") || txt.includes("sell");
    const value = yvAdHoc(tx, "value") ?? 0;
    if (isBuy) { insiderBuys++; insiderBuyValue += value; }
    if (isSell) { insiderSells++; insiderSellValue += value; }
  });

  const lynchData = summary ? {
    category: lynchCategory,
    epsGrowthNextYr: yvAdHoc(nextYrTrend, "growth") != null ? yvAdHoc(nextYrTrend, "growth") * 100 : null,
    epsGrowth5Yr: yvAdHoc(fiveYrTrend, "growth") != null ? yvAdHoc(fiveYrTrend, "growth") * 100 : null,
    epsCoefVar: null, epsHistory: [],
    insiderBuys, insiderSells,
    insiderBuyValue: Math.round(insiderBuyValue),
    insiderSellValue: Math.round(insiderSellValue),
    netInsiderActivity: insiderBuyValue - insiderSellValue,
    heldByInsiders: yvAdHoc(ks, "heldPercentInsiders"),
    heldByInstitutions: yvAdHoc(ks, "heldPercentInstitutions"),
    shortRatio: yvAdHoc(ks, "shortRatio"),
    shortPctFloat: yvAdHoc(ks, "shortPercentOfFloat"),
    pegRatio: yvAdHoc(ks, "pegRatio") ?? yvAdHoc(ks, "trailingPegRatio") ?? m.pegRatio ?? null,
  } : null;

  return {
    symbol, name: profile?.name || symbol, sector: profile?.finnhubIndustry || "—",
    peers: [], peerData: {}, fetchedAt: new Date().toISOString(),
    quote: { current: quote.c, change: quote.d, changePct: quote.dp, high: quote.h, low: quote.l, open: quote.o, prevClose: quote.pc },
    candles, candles5Y: [],
    fundamentals: {
      pe: yvAdHoc(sd, "trailingPE") ?? m.peBasicExclExtraTTM ?? null,
      fwdPe: yvAdHoc(ks, "forwardPE") ?? yvAdHoc(sd, "forwardPE") ?? null,
      peg: yvAdHoc(ks, "pegRatio") ?? yvAdHoc(ks, "trailingPegRatio") ?? null,
      pb: yvAdHoc(ks, "priceToBook") ?? null,
      ps: yvAdHoc(sd, "priceToSalesTrailing12Months") ?? null,
      evEbitda: yvAdHoc(ks, "enterpriseToEbitda") ?? null,
      divYield: yvAdHoc(sd, "dividendYield") != null ? yvAdHoc(sd, "dividendYield") * 100 : null,
      qtrlyDivAmt: yvAdHoc(ks, "lastDividendValue"),
      payout: yvAdHoc(sd, "payoutRatio") != null ? yvAdHoc(sd, "payoutRatio") * 100 : null,
      roe: yvAdHoc(fd, "returnOnEquity") != null ? yvAdHoc(fd, "returnOnEquity") * 100 : null,
      debtEq: yvAdHoc(fd, "debtToEquity") ?? null,
      eps: yvAdHoc(ks, "trailingEps") ?? null,
      epsForward: yvAdHoc(ks, "forwardEps"),
      revGrowth: yvAdHoc(fd, "revenueGrowth") != null ? yvAdHoc(fd, "revenueGrowth") * 100 : null,
      opMargin: yvAdHoc(fd, "operatingMargins") != null ? yvAdHoc(fd, "operatingMargins") * 100 : null,
      profitMargin: yvAdHoc(fd, "profitMargins") != null ? yvAdHoc(fd, "profitMargins") * 100 : null,
      mcap: mcapRaw != null ? mcapRaw / 1e6 : null,
      mcapRaw,
      week52High: yvAdHoc(sd, "fiftyTwoWeekHigh") ?? null,
      week52Low: yvAdHoc(sd, "fiftyTwoWeekLow") ?? null,
      avgVol: yvAdHoc(sd, "averageVolume"),
      beta: yvAdHoc(ks, "beta") ?? null,
      currentRatio: yvAdHoc(fd, "currentRatio"),
      quickRatio: yvAdHoc(fd, "quickRatio"),
      totalCash: yvAdHoc(fd, "totalCash"),
      totalDebt: yvAdHoc(fd, "totalDebt"),
    },
    consensus: {
      rating, score: score != null ? +score.toFixed(2) : null, analysts: totalRecs || null,
      strongBuy: latestRec.strongBuy ?? 0, buy: latestRec.buy ?? 0, buys,
      hold: latestRec.hold ?? 0, sell: latestRec.sell ?? 0, strongSell: latestRec.strongSell ?? 0,
      sells,
    },
    analyst: analystData,
    lynch: lynchData,
    simons: null,
    options: null,
    catalysts: null,
    summary: null,
    isAdHoc: true,
  };
}

// ============================================================
// HELPERS
// ============================================================
const fmt = (n, d = 2) => (n == null || isNaN(n) ? "—" : Number(n).toFixed(d));
const pct = (n) => (n == null || isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${Number(n).toFixed(2)}%`);
const colorFor = (n) => (n > 0 ? "#0a8554" : n < 0 ? "#c4314b" : "#5a6573");
const labelFromDate = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const formatMcap = (raw) => {
  if (!raw && raw !== 0) return "—";
  if (raw === 0) return "0";
  if (raw >= 1e12) return `${(raw / 1e12).toFixed(2)}T`;
  if (raw >= 1e9) return `${(raw / 1e9).toFixed(2)}B`;
  if (raw >= 1e6) return `${(raw / 1e6).toFixed(2)}M`;
  if (raw >= 1e3) return `${(raw / 1e3).toFixed(1)}K`;
  return Math.round(raw).toString();
};

// ============================================================
// MAIN
// ============================================================
export default function App() {
  const [index, setIndex] = useState(null);
  const [ticker, setTicker] = useState(null);
  const [data, setData] = useState(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [timeframe, setTimeframe] = useState("1Y");
  const [tfCandles, setTfCandles] = useState(null);
  const [tfLoading, setTfLoading] = useState(false);
  const [tfError, setTfError] = useState(null);
  const [priceScaleWidth, setPriceScaleWidth] = useState(null);
  const [macro, setMacro] = useState(null);
  const [showBehavior, setShowBehavior] = useState(false);
  const [showRisk, setShowRisk] = useState(false);
  const isMobile = useIsMobile();
  const live = useLiveQuote(ticker);

  useEffect(() => {
    fetch(`${BASE}data/index.json?v=${Date.now()}`)
      .then((r) => { if (!r.ok) throw new Error("No data found. Run the fetch workflow."); return r.json(); })
      .then((idx) => { setIndex(idx); if (idx.tickers?.length) setTicker(idx.tickers[0].symbol); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
    // Load macro snapshot (separate file)
    fetch(`${BASE}data/macro.json?v=${Date.now()}`)
      .then((r) => r.ok ? r.json() : null)
      .then(setMacro)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!ticker) return;
    setData(null); setSearchError(null); setTfCandles(null); setTimeframe("1Y"); setTfError(null);
    fetch(`${BASE}data/${ticker}.json?v=${Date.now()}`)
      .then((r) => r.ok ? r.json() : fetchAdHoc(ticker))
      .then(setData)
      .catch((e) => setError(e.message));
  }, [ticker]);

  // Live-fetch candles for ALL timeframes (including 1Y) so chart is always current.
  // Falls back to baked-in JSON data if Yahoo fails.
  useEffect(() => {
    if (!data || !ticker) return;
    const tf = TIMEFRAMES.find((t) => t.key === timeframe);
    if (!tf) return;
    setTfLoading(true); setTfError(null);
    fetchYahooCandles(ticker, tf.range, tf.interval)
      .then((c) => { setTfCandles(c); if (!c.length) setTfError("No data returned"); })
      .catch((e) => {
        console.error(`Timeframe fetch failed: ${e.message}`);
        if (timeframe === "1Y" && data.candles?.length) { setTfCandles(data.candles); setTfError(null); }
        else if (timeframe === "5Y" && data.candles5Y?.length) { setTfCandles(data.candles5Y); setTfError(null); }
        else { setTfCandles([]); setTfError(e.message); }
      })
      .finally(() => setTfLoading(false));
  }, [timeframe, ticker, data]);

  useEffect(() => { if (isMobile) setSidebarOpen(false); }, [ticker, isMobile]);

  const handleSearch = async (e) => {
    e?.preventDefault();
    const sym = searchInput.trim().toUpperCase();
    if (!sym) return;
    if (index?.tickers.some((t) => t.symbol === sym)) { setTicker(sym); setSearchInput(""); return; }
    setSearchLoading(true); setSearchError(null);
    try {
      const adhocData = await fetchAdHoc(sym);
      setTicker(sym); setData(adhocData); setSearchInput("");
    } catch (err) { setSearchError(err.message); } finally { setSearchLoading(false); }
  };

  const activeCandles = useMemo(() => {
    if (tfCandles !== null) return tfCandles;
    return data?.candles || [];
  }, [data, tfCandles]);

  const enriched = useMemo(() => {
    if (!activeCandles || activeCandles.length < 30) return null;
    let d = activeCandles.map((c) => ({ ...c, label: labelFromDate(c.date) }));
    if (d.length >= 20) d = sma(d, 20);
    if (d.length >= 50) d = sma(d, 50);
    if (d.length >= 200) d = sma(d, 200);
    d = rsi(d); d = macd(d); d = sqzmom(d); d = zscore(d, 20);
    d = atrTrailingStop(d, 10, 2);
    return d;
  }, [activeCandles]);

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorScreen message={error} />;
  if (!index || !data) return <LoadingScreen />;

  const displayQuote = live.quote || data.quote;
  const f = data.fundamentals || {};
  const c = data.consensus || {};
  const a = data.analyst;
  const ly = data.lynch;
  const sm = data.simons;
  const op = data.options;

  let last, lastRsi, lastZ, sqzActive, hurst, rv30, rv90, chartData,
      trendSignal, momentumSignal, reversionSignal, regimeSignal;
  if (enriched && enriched.length >= 30) {
    last = enriched[enriched.length - 1];
    lastRsi = last.rsi; lastZ = last.zscore; sqzActive = last.sqz_on;
    hurst = hurstExponent(enriched, Math.min(100, enriched.length - 1));
    rv30 = realizedVol(enriched, 30); rv90 = realizedVol(enriched, 90);
    chartData = enriched.slice(-Math.min(120, enriched.length));
    trendSignal = last.sma200 ? (last.close > last.sma50 && last.sma50 > last.sma200 ? "Bullish trend" :
                  last.close < last.sma50 && last.sma50 < last.sma200 ? "Bearish trend" : "Mixed") : "—";
    momentumSignal = lastRsi > 70 ? "Overbought" : lastRsi < 30 ? "Oversold" : "Neutral";
    reversionSignal = lastZ > 2 ? "Stretched ↑ (fade)" : lastZ < -2 ? "Stretched ↓ (buy)" : Math.abs(lastZ) < 0.5 ? "At mean" : "In range";
    regimeSignal = hurst > 0.55 ? "Trending" : hurst < 0.45 ? "Mean-reverting" : "Random walk";
  }

  const paneRightPad = priceScaleWidth || (isMobile ? RIGHT_PAD_MOBILE : RIGHT_PAD_DESKTOP);

  const peerRows = [
    { ticker: data.symbol, name: data.name, price: displayQuote.current, pe: f.pe, fwdPe: f.fwdPe, peg: f.peg, ps: f.ps, evEbitda: f.evEbitda, roe: f.roe, mcap: f.mcap, isSelf: true },
    ...Object.entries(data.peerData || {}).map(([sym, p]) => ({ ticker: sym, name: sym, ...p })),
  ];
  const peerAvg = (key) => {
    const vals = peerRows.filter((r) => !r.isSelf && r[key] != null).map((r) => r[key]);
    return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
  };

  const holdings = (index.tickers || []).filter((t) => t.holding);
  const rest = (index.tickers || []).filter((t) => !t.holding);
  const sidebarVisible = !isMobile || sidebarOpen;

  return (
    <div style={{ fontFamily: "'IBM Plex Sans', -apple-system, sans-serif", background: "#fafaf7", minHeight: "100vh", color: "#1a1f2c" }}>
      <Styles />

      <header style={{ background: "#1a1f2c", color: "#fff", padding: isMobile ? "10px 14px" : "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "3px solid #d4a017", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {isMobile && (
            <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{ background: "transparent", border: "none", color: "#fff", padding: 4, cursor: "pointer", display: "flex", alignItems: "center" }}>
              {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          )}
          <span className="serif" style={{ fontSize: isMobile ? 16 : 20, fontWeight: 600, letterSpacing: "-0.01em" }}>TERMINAL</span>
          {!isMobile && <span className="mono" style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.15em", marginLeft: 4 }}>EQUITY · QUANT · DESK</span>}
        </div>
        <div className="mono" style={{ fontSize: isMobile ? 9 : 10, color: "#8a93a3", display: "flex", gap: isMobile ? 8 : 12, alignItems: "center" }}>
          <button onClick={() => { setShowRisk(!showRisk); setShowBehavior(false); }} style={{ background: showRisk ? "#c4314b" : "transparent", color: showRisk ? "#fff" : "#fff", border: "1px solid #c4314b", padding: "3px 8px", borderRadius: 2, cursor: "pointer", fontSize: isMobile ? 9 : 10, fontWeight: 600, letterSpacing: "0.1em" }}>
            {showRisk ? "← BACK" : "RISK"}
          </button>
          <button onClick={() => { setShowBehavior(!showBehavior); setShowRisk(false); }} style={{ background: showBehavior ? "#d4a017" : "transparent", color: showBehavior ? "#1a1f2c" : "#fff", border: "1px solid #d4a017", padding: "3px 8px", borderRadius: 2, cursor: "pointer", fontSize: isMobile ? 9 : 10, fontWeight: 600, letterSpacing: "0.1em" }}>
            {showBehavior ? "← BACK" : "MY TRADES"}
          </button>
          <LiveStatus status={live.status} lastUpdate={live.lastUpdate} compact={isMobile} />
        </div>
      </header>

      {macro && <MacroStrip macro={macro} isMobile={isMobile} />}

      {isMobile && sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 40, top: 50 }} />
      )}

      {showBehavior ? (
        <BehaviorTracker isMobile={isMobile} />
      ) : showRisk ? (
        <RiskHelper isMobile={isMobile} macro={macro} />
      ) : (
      <div style={{ display: isMobile ? "block" : "grid", gridTemplateColumns: isMobile ? undefined : "240px 1fr", position: "relative" }}>
        {sidebarVisible && (
          <aside style={{
            borderRight: isMobile ? "none" : "1px solid #e6e3db", background: "#f5f3ed",
            position: isMobile ? "fixed" : "static", top: isMobile ? 50 : "auto", left: 0, bottom: 0,
            width: isMobile ? "85vw" : "auto", maxWidth: isMobile ? 320 : "auto",
            minHeight: isMobile ? "calc(100vh - 50px)" : "calc(100vh - 53px)",
            maxHeight: isMobile ? "calc(100vh - 50px)" : "calc(100vh - 53px)",
            overflowY: "auto", zIndex: 45, boxShadow: isMobile ? "2px 0 8px rgba(0,0,0,0.15)" : "none",
          }}>
            <div style={{ padding: "16px 14px 8px", position: "sticky", top: 0, background: "#f5f3ed", zIndex: 1, borderBottom: "1px solid #e6e3db" }}>
              <form onSubmit={handleSearch} style={{ position: "relative" }}>
                <Search size={12} style={{ position: "absolute", left: 8, top: 9, color: "#8a93a3", pointerEvents: "none" }} />
                <input value={searchInput} onChange={(e) => { setSearchInput(e.target.value); setSearchError(null); }}
                  placeholder="Search any ticker…" className="mono"
                  style={{ width: "100%", padding: "6px 28px 6px 26px", fontSize: 11, border: "1px solid #d6d2c7", background: "#fff", borderRadius: 2, outline: "none", textTransform: "uppercase" }} />
                {searchLoading && <Loader2 size={11} className="spin" style={{ position: "absolute", right: 8, top: 9, color: "#d4a017" }} />}
              </form>
              {searchError && <div style={{ marginTop: 6, fontSize: 10, color: "#c4314b", lineHeight: 1.4 }}>{searchError}</div>}
            </div>

            {holdings.length > 0 && (
              <div>
                <div className="section-head"><Briefcase size={11} color="#d4a017" strokeWidth={2} /><span>My Holdings</span><span style={{ marginLeft: "auto", color: "#8a93a3" }}>{holdings.length}</span></div>
                {holdings.map((t) => <TickerButton key={t.symbol} t={t} active={t.symbol === ticker} onClick={() => setTicker(t.symbol)} isHolding />)}
              </div>
            )}
            {rest.length > 0 && (
              <div>
                <div className="section-head" style={{ marginTop: holdings.length ? 0 : 8 }}><span>Watchlist</span><span style={{ marginLeft: "auto", color: "#8a93a3" }}>{rest.length}</span></div>
                {rest.map((t) => <TickerButton key={t.symbol} t={t} active={t.symbol === ticker} onClick={() => setTicker(t.symbol)} />)}
              </div>
            )}
          </aside>
        )}

        <main style={{ padding: isMobile ? 12 : 16, minWidth: 0 }}>
          <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "flex-start" : "flex-end", justifyContent: "space-between", gap: isMobile ? 8 : 0, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #e6e3db", position: "sticky", top: isMobile ? 50 : 53, background: "#fafaf7", zIndex: 30, paddingTop: 12, marginTop: -12 }}>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: isMobile ? 8 : 12, flexWrap: "wrap" }}>
                <span className="serif" style={{ fontSize: isMobile ? 24 : 32, fontWeight: 600, letterSpacing: "-0.02em" }}>{data.symbol}</span>
                <span style={{ fontSize: isMobile ? 12 : 14, color: "#5a6573" }}>{data.name}</span>
                {!isMobile && data.sector && <span className="pill" style={{ background: "#f5f3ed", color: "#5a6573" }}>{data.sector}</span>}
                {data.isAdHoc && <span className="pill" style={{ background: "#fff8e1", color: "#8b6914" }}>Ad-hoc</span>}
                {holdings.find((h) => h.symbol === data.symbol) && <span className="pill" style={{ background: "#0a8554", color: "#fff" }}>Holding</span>}
                {data.summary && (
                  <span className="pill" style={{ background: data.summary.stanceColor === "positive" ? "#0a8554" : data.summary.stanceColor === "negative" ? "#c4314b" : "#5a6573", color: "#fff" }}>{data.summary.stance}</span>
                )}
              </div>
              <div style={{ fontSize: 9, color: "#8a93a3", marginTop: 4, letterSpacing: "0.1em" }}>
                {live.status === "live" ? "● LIVE" : live.status === "closed" ? "AFTER HOURS" : "USD · DAILY"}
                {live.lastUpdate && ` · ${live.lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`}
              </div>
            </div>
            <div style={{ textAlign: isMobile ? "left" : "right", width: isMobile ? "100%" : "auto" }}>
              <div className="mono" style={{ fontSize: isMobile ? 28 : 36, fontWeight: 500, lineHeight: 1 }}>{fmt(displayQuote.current)}</div>
              <div className="mono" style={{ fontSize: isMobile ? 12 : 13, marginTop: 4, color: colorFor(displayQuote.change) }}>
                {displayQuote.change >= 0 ? "▲" : "▼"} {fmt(Math.abs(displayQuote.change ?? 0))} ({pct(displayQuote.changePct)})
              </div>
            </div>
          </div>

          {enriched && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
              <SignalCard icon={Activity} label="Technical" value={trendSignal} />
              <SignalCard icon={DollarSign} label="Value" value={f.pe ? (peerAvg("pe") && f.pe < peerAvg("pe") ? "Below peers" : "Premium") : "—"} />
              <SignalCard icon={Users} label="Consensus" value={c.rating} />
              <SignalCard icon={MessageSquare} label="Momentum" value={momentumSignal} />
            </div>
          )}

          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head">
              <span className="panel-title">Candlestick · {timeframe}</span>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {TIMEFRAMES.map((tf) => (
                  <button key={tf.key} onClick={() => setTimeframe(tf.key)} className={`tf-btn ${timeframe === tf.key ? "active" : ""}`}>
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ padding: 4, position: "relative", minHeight: isMobile ? 280 : 420 }}>
              {tfLoading && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.7)", zIndex: 5 }}>
                  <Loader2 size={20} className="spin" color="#d4a017" />
                </div>
              )}
              {activeCandles?.length > 0 ? (
                <CandlestickChart key={`${ticker}-${timeframe}`} data={enriched || activeCandles} height={isMobile ? 280 : 420} isMobile={isMobile} onPriceScaleWidth={setPriceScaleWidth} />
              ) : (
                <div style={{ padding: 32, color: "#8a93a3", textAlign: "center", fontSize: 13 }}>
                  {tfError ? `Could not load ${timeframe} data: ${tfError}` : "No data for this timeframe"}
                </div>
              )}
            </div>

            {f && (
              <div style={{ borderTop: "1px solid #efece5", padding: isMobile ? "10px 12px" : "12px 16px", display: "grid",
                gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: isMobile ? "10px 16px" : "10px 24px" }}>
                <GStat label="Open" value={fmt(displayQuote.open)} />
                <GStat label="High" value={fmt(displayQuote.high)} />
                <GStat label="Low" value={fmt(displayQuote.low)} />
                <GStat label="Mkt cap" value={formatMcap(f.mcapRaw)} />
                <GStat label="P/E ratio" value={fmt(f.pe, 2)} />
                <GStat label="52-wk high" value={fmt(f.week52High)} />
                <GStat label="Dividend" value={f.divYield != null ? `${fmt(f.divYield, 3)}%` : "—"} />
                <GStat label="52-wk low" value={fmt(f.week52Low)} />
                <GStat label="Forward P/E" value={fmt(f.fwdPe, 2)} />
                <GStat label="Qtrly Div Amt" value={f.qtrlyDivAmt ? fmt(f.qtrlyDivAmt, 3) : "—"} />
                <GStat label="EPS" value={f.eps ? `$${fmt(f.eps, 2)}` : "—"} />
                <GStat label="Avg Vol" value={f.avgVol ? formatMcap(f.avgVol) : "—"} />
              </div>
            )}

            {enriched && (
              <>
                <div style={{ padding: "0 4px", borderTop: "1px solid #efece5" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 0" }}>
                    <span className="panel-title" style={{ fontSize: 10 }}>RSI(14)</span>
                    <span className="mono" style={{ fontSize: 10, color: lastRsi > 70 ? "#c4314b" : lastRsi < 30 ? "#0a8554" : "#1a1f2c" }}>{fmt(lastRsi, 1)}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={isMobile ? 70 : 90}>
                    <LineChart data={chartData} margin={{ top: 4, right: paneRightPad, left: 0, bottom: 0 }}>
                      <XAxis dataKey="label" hide />
                      <YAxis domain={[0, 100]} ticks={[30, 70]} tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={paneRightPad} />
                      <ReferenceLine y={70} stroke="#c4314b" strokeDasharray="2 2" strokeWidth={0.8} />
                      <ReferenceLine y={30} stroke="#0a8554" strokeDasharray="2 2" strokeWidth={0.8} />
                      <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                      <Line type="monotone" dataKey="rsi" stroke="#7c3aed" strokeWidth={1.2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ padding: "0 4px", borderTop: "1px solid #efece5" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 0" }}>
                    <span className="panel-title" style={{ fontSize: 10 }}>MACD</span>
                    <span className="mono" style={{ fontSize: 10 }}>{fmt(last?.macd, 2)} / {fmt(last?.signal, 2)}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={isMobile ? 70 : 90}>
                    <ComposedChart data={chartData} margin={{ top: 4, right: paneRightPad, left: 0, bottom: 0 }}>
                      <XAxis dataKey="label" hide />
                      <YAxis tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={paneRightPad} />
                      <ReferenceLine y={0} stroke="#5a6573" strokeWidth={0.5} />
                      <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                      <Bar dataKey="hist">{chartData.map((d, i) => (<Cell key={i} fill={d.hist >= 0 ? "#0a8554" : "#c4314b"} fillOpacity={0.6} />))}</Bar>
                      <Line type="monotone" dataKey="macd" stroke="#1a4f8c" strokeWidth={1.2} dot={false} />
                      <Line type="monotone" dataKey="signal" stroke="#c4314b" strokeWidth={1} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ padding: "0 4px 8px", borderTop: "1px solid #efece5" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 0" }}>
                    <span className="panel-title" style={{ fontSize: 10 }}>SQZMOM_LB</span>
                    <span className="mono" style={{ fontSize: 10 }}>{sqzActive ? <span style={{ color: "#c4314b" }}>● ON</span> : <span style={{ color: "#0a8554" }}>○ off</span>} · {fmt(last?.sqz_mom, 2)}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={isMobile ? 70 : 90}>
                    <BarChart data={chartData} margin={{ top: 4, right: paneRightPad, left: 0, bottom: 0 }}>
                      <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" interval={Math.floor(chartData.length / (isMobile ? 4 : 8))} />
                      <YAxis tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={paneRightPad} />
                      <ReferenceLine y={0} stroke="#5a6573" strokeWidth={0.5} />
                      <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                      <Bar dataKey="sqz_mom">
                        {chartData.map((d, i) => {
                          const prev = i > 0 ? chartData[i - 1].sqz_mom : 0;
                          const rising = d.sqz_mom >= prev; let fill = "#5a6573";
                          if (d.sqz_mom > 0) fill = rising ? "#0a8554" : "#86b09c";
                          else fill = rising ? "#e89aa6" : "#c4314b";
                          return <Cell key={i} fill={fill} />;
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </div>

          {/* === REORDERED: Risk Flags directly under chart (warn first) === */}
          <RiskFlagsPanel data={data} ly={ly} f={f} op={op} displayQuote={displayQuote} isMobile={isMobile} />

          {/* === Summary as collapsible (since stance is now in sticky header) === */}
          {data.summary && <SummaryPanel summary={data.summary} symbol={data.symbol} data={data} ly={ly} f={f} op={op} isMobile={isMobile} collapsible />}

          {/* === Catalysts: what's coming up === */}
          {data.catalysts && <CatalystPanel catalysts={data.catalysts} symbol={data.symbol} isMobile={isMobile} />}

          {/* === Options flow (positioning) === */}
          {op && <OptionsFlowPanel op={op} isMobile={isMobile} />}

          {/* === Analyst targets === */}
          {a && a.targetMean && (
            <AnalystInsightsPanel data={data} a={a} c={c} currentPrice={displayQuote.current} isMobile={isMobile} />
          )}

          {/* === Long-term lens: Lynch fundamentals === */}
          {ly && <LynchPanel ly={ly} f={f} isMobile={isMobile} />}

          {enriched && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head"><span className="panel-title">Quant · Statistical</span><Sigma size={13} color="#d4a017" /></div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.2fr 1fr" }}>
                <div style={{ padding: "12px 14px", borderRight: isMobile ? "none" : "1px solid #efece5", borderBottom: isMobile ? "1px solid #efece5" : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="panel-title" style={{ fontSize: 10 }}>Z-Score(20)</span>
                    <span className="mono" style={{ fontSize: 11, color: Math.abs(lastZ) > 2 ? "#c4314b" : "#1a1f2c", fontWeight: 600 }}>{fmt(lastZ, 2)}σ · {reversionSignal}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={isMobile ? 110 : 140}>
                    <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                      <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" interval={Math.floor(chartData.length / (isMobile ? 4 : 6))} />
                      <YAxis domain={[-3, 3]} ticks={[-2, 0, 2]} tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={28} />
                      <ReferenceLine y={2} stroke="#c4314b" strokeDasharray="3 3" strokeWidth={0.8} />
                      <ReferenceLine y={0} stroke="#5a6573" strokeWidth={0.5} />
                      <ReferenceLine y={-2} stroke="#0a8554" strokeDasharray="3 3" strokeWidth={0.8} />
                      <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                      <Line type="monotone" dataKey="zscore" stroke="#d4a017" strokeWidth={1.4} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ padding: "12px 14px" }}>
                  <StatRow label="Hurst" value={<span className="mono">{fmt(hurst, 2)} <span className="pill" style={{ background: hurst > 0.55 ? "#0a8554" : hurst < 0.45 ? "#d4a017" : "#5a6573", color: "#fff", marginLeft: 4 }}>{regimeSignal}</span></span>} />
                  <StatRow label="Vol 30d" value={<span className="mono">{fmt(rv30, 1)}%</span>} />
                  <StatRow label="Vol 90d" value={<span className="mono">{fmt(rv90, 1)}%</span>} />
                  <StatRow label="Vol-of-Vol" value={<span className="mono" style={{ color: rv30 > rv90 ? "#c4314b" : "#0a8554" }}>{fmt(rv30 / rv90, 2)}×</span>} />
                  {op && (op.ivATMLong ?? op.ivATM) != null && rv30 > 0 && (
                    <StatRow label="IV / RV (30d)" value={<span className="mono" style={{ color: (op.ivATMLong ?? op.ivATM) / rv30 > 1.2 ? "#c4314b" : (op.ivATMLong ?? op.ivATM) / rv30 < 0.9 ? "#0a8554" : "#1a1f2c" }} title="Implied vs Realized vol. >1.2 = options overpriced (sellers favored). <0.9 = options cheap (buyers favored).">{fmt((op.ivATMLong ?? op.ivATM) / rv30, 2)}×</span>} />
                  )}
                  <StatRow label="Squeeze" value={<span className="mono">{sqzActive ? <span style={{ color: "#c4314b" }}>Compressed</span> : <span style={{ color: "#0a8554" }}>Released</span>}</span>} />
                  <StatRow label="50/200" value={<span className="mono">{last?.sma50 > last?.sma200 ? <span style={{ color: "#0a8554" }}>Golden</span> : <span style={{ color: "#c4314b" }}>Death</span>}</span>} />
                  <StatRow label="ATR Trail Stop" value={<span className="mono" title="ATR(10) × 2 trailing stop. Long = green (stop below price), Short = red (stop above price). A close beyond the stop flips the trend.">{last?.atrStop != null ? <><span style={{ color: last.atrTrend === "long" ? "#0a8554" : "#c4314b" }}>${fmt(last.atrStop, 2)} {last.atrTrend === "long" ? "▲" : "▼"}</span></> : "—"}</span>} />
                  <StatRow label="Beta" value={<span className="mono">{fmt(f.beta, 2)}</span>} />
                </div>
              </div>
            </div>
          )}

          {sm && <SimonsPanel sm={sm} isMobile={isMobile} />}

          {data.correlations && Object.keys(data.correlations).length > 0 && (
            <CorrelationsPanel correlations={data.correlations} symbol={data.symbol} isMobile={isMobile} />
          )}

          {peerRows.length > 1 && !data.isAdHoc && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head"><span className="panel-title">Peer Comparison</span><GitCompare size={13} color="#d4a017" /></div>
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                <table className="peers">
                  <thead>
                    <tr><th>Ticker</th><th>Price</th><th>P/E</th><th>Fwd P/E</th><th>PEG</th><th>P/S</th><th>EV/EBITDA</th><th>ROE %</th><th>Mkt Cap</th></tr>
                  </thead>
                  <tbody>
                    {peerRows.map((r) => {
                      const peColor = r.pe && peerAvg("pe") && !r.isSelf ? (r.pe < peerAvg("pe") ? "#0a8554" : "#c4314b") : "#1a1f2c";
                      const fwdColor = r.fwdPe && peerAvg("fwdPe") && !r.isSelf ? (r.fwdPe < peerAvg("fwdPe") ? "#0a8554" : "#c4314b") : "#1a1f2c";
                      return (
                        <tr key={r.ticker} className={r.isSelf ? "self" : ""}>
                          <td><span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span>{r.isSelf && <span className="pill" style={{ background: "#d4a017", color: "#fff", marginLeft: 6 }}>Self</span>}</td>
                          <td className="mono">${fmt(r.price)}</td>
                          <td className="mono" style={{ color: peColor }}>{fmt(r.pe, 1)}</td>
                          <td className="mono" style={{ color: fwdColor }}>{fmt(r.fwdPe, 1)}</td>
                          <td className="mono">{fmt(r.peg, 2)}</td>
                          <td className="mono">{fmt(r.ps, 1)}</td>
                          <td className="mono">{fmt(r.evEbitda, 1)}</td>
                          <td className="mono" style={{ color: r.roe > 15 ? "#0a8554" : r.roe < 0 ? "#c4314b" : "#1a1f2c" }}>{fmt(r.roe, 1)}</td>
                          <td className="mono">{r.mcap ? formatMcap(r.mcap * 1e6) : "—"}</td>
                        </tr>
                      );
                    })}
                    <tr className="avg">
                      <td>Peer Avg</td><td>—</td>
                      <td className="mono">{fmt(peerAvg("pe"), 1)}</td><td className="mono">{fmt(peerAvg("fwdPe"), 1)}</td>
                      <td className="mono">{fmt(peerAvg("peg"), 2)}</td><td className="mono">{fmt(peerAvg("ps"), 1)}</td>
                      <td className="mono">{fmt(peerAvg("evEbitda"), 1)}</td><td className="mono">{fmt(peerAvg("roe"), 1)}</td><td>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: isMobile ? 12 : 16 }}>
            <div className="panel">
              <div className="panel-head"><span className="panel-title">Value · Fundamentals</span><DollarSign size={13} color="#d4a017" /></div>
              <div style={{ padding: "10px 14px" }}>
                <StatRow label="P/E (TTM)" value={<span className="mono">{fmt(f.pe, 2)}</span>} />
                <StatRow label="Forward P/E" value={<span className="mono">{fmt(f.fwdPe, 2)}</span>} />
                <StatRow label="PEG" value={<span className="mono" style={{ color: f.peg && f.peg < 1 ? "#0a8554" : f.peg > 2 ? "#c4314b" : "#1a1f2c" }}>{fmt(f.peg, 2)}</span>} />
                <StatRow label="P/B" value={<span className="mono">{fmt(f.pb, 2)}</span>} />
                <StatRow label="P/S" value={<span className="mono">{fmt(f.ps, 2)}</span>} />
                <StatRow label="EV/EBITDA" value={<span className="mono">{fmt(f.evEbitda, 2)}</span>} />
                <StatRow label="Div Yield" value={<span className="mono">{f.divYield != null ? fmt(f.divYield, 3) + "%" : "—"}</span>} />
                <StatRow label="ROE" value={<span className="mono" style={{ color: f.roe > 15 ? "#0a8554" : "#1a1f2c" }}>{f.roe != null ? fmt(f.roe, 2) + "%" : "—"}</span>} />
                <StatRow label="ROIC (approx)" value={<span className="mono" style={{ color: f.roic > 15 ? "#0a8554" : "#1a1f2c" }} title="Return on Invested Capital. Buffett's favorite quality metric. >15% = excellent.">{f.roic != null ? fmt(f.roic, 2) + "%" : "—"}</span>} />
                <StatRow label="Debt/Equity" value={<span className="mono" style={{ color: f.debtEq != null && f.debtEq < 0.5 ? "#0a8554" : f.debtEq > 1.5 ? "#c4314b" : "#1a1f2c" }}>{fmt(f.debtEq, 2)}</span>} />
                <StatRow label="FCF Yield" value={<span className="mono" style={{ color: f.fcfYield > 5 ? "#0a8554" : f.fcfYield < 1 ? "#c4314b" : "#1a1f2c" }} title="Free Cash Flow / Market Cap. Like dividend yield but for total cash generation. >5% = cheap, <2% = expensive.">{f.fcfYield != null ? fmt(f.fcfYield, 2) + "%" : "—"}</span>} />
                <StatRow label="Earnings Yield" value={<span className="mono" title="1/PE. Compare to 10Y Treasury (~4%). If lower, stock yields less than bonds.">{f.earningsYield != null ? fmt(f.earningsYield, 2) + "%" : "—"}</span>} />
                <StatRow label="Op. Margin" value={<span className="mono">{f.opMargin != null ? fmt(f.opMargin, 2) + "%" : "—"}</span>} />
                <StatRow label="Profit Margin" value={<span className="mono">{f.profitMargin != null ? fmt(f.profitMargin, 2) + "%" : "—"}</span>} />
                <StatRow label="Rev Growth" value={<span className="mono" style={{ color: colorFor(f.revGrowth) }}>{f.revGrowth != null ? pct(f.revGrowth) : "—"}</span>} />
                <StatRow label="EPS (TTM)" value={<span className="mono">${fmt(f.eps, 2)}</span>} />
                <StatRow label="EPS Forward" value={<span className="mono">${fmt(f.epsForward, 2)}</span>} />
                <StatRow label="Mkt Cap" value={<span className="mono">{formatMcap(f.mcapRaw)}</span>} />
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="panel-title">Analyst Consensus</span><Users size={13} color="#d4a017" /></div>
              <div style={{ padding: "14px" }}>
                <div style={{ textAlign: "center", marginBottom: 14, padding: "12px 0", background: "#f5f3ed", borderRadius: 2 }}>
                  <div className="panel-title" style={{ fontSize: 9 }}>Consensus</div>
                  <div className="serif" style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{c.rating}</div>
                  <div className="mono" style={{ fontSize: 10, color: "#5a6573", marginTop: 2 }}>{c.score ? `${fmt(c.score, 1)}/5.0` : "—"} · {c.analysts ?? 0} analysts</div>
                </div>
                {c.analysts > 0 && (
                  <>
                    <div style={{ display: "flex", height: 6, borderRadius: 1, overflow: "hidden", marginBottom: 6 }}>
                      <div style={{ flex: c.buys, background: "#0a8554" }} />
                      <div style={{ flex: c.hold, background: "#d4a017" }} />
                      <div style={{ flex: c.sells, background: "#c4314b" }} />
                    </div>
                    <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#5a6573", marginBottom: 12 }}>
                      <span><span style={{ color: "#0a8554" }}>●</span> Buy {c.buys}</span>
                      <span><span style={{ color: "#d4a017" }}>●</span> Hold {c.hold}</span>
                      <span><span style={{ color: "#c4314b" }}>●</span> Sell {c.sells}</span>
                    </div>
                  </>
                )}
                <StatRow label="Strong Buy" value={<span className="mono">{c.strongBuy ?? 0}</span>} />
                <StatRow label="Buy" value={<span className="mono">{c.buy ?? 0}</span>} />
                <StatRow label="Hold" value={<span className="mono">{c.hold ?? 0}</span>} />
                <StatRow label="Sell" value={<span className="mono">{c.sell ?? 0}</span>} />
                <StatRow label="Strong Sell" value={<span className="mono">{c.strongSell ?? 0}</span>} />
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="panel-title">52-Week Range</span><Activity size={13} color="#d4a017" /></div>
              <div style={{ padding: "14px" }}>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 6 }}>
                    <span className="mono" style={{ color: "#c4314b" }}>${fmt(f.week52Low)}</span>
                    <span className="mono" style={{ color: "#0a8554" }}>${fmt(f.week52High)}</span>
                  </div>
                  <div style={{ height: 6, background: "#efece5", borderRadius: 2, position: "relative" }}>
                    {f.week52High && f.week52Low && displayQuote.current && (
                      <div style={{ position: "absolute", left: `${Math.min(100, Math.max(0, ((displayQuote.current - f.week52Low) / (f.week52High - f.week52Low)) * 100))}%`, top: -2, width: 2, height: 10, background: "#1a1f2c", transform: "translateX(-50%)" }} />
                    )}
                  </div>
                  <div style={{ textAlign: "center", fontSize: 10, color: "#5a6573", marginTop: 6 }}>
                    Current: ${fmt(displayQuote.current)} ({f.week52High && f.week52Low ? fmt(((displayQuote.current - f.week52Low) / (f.week52High - f.week52Low)) * 100, 0) : "—"}% of range)
                  </div>
                </div>
                <StatRow label="Day High" value={<span className="mono">${fmt(displayQuote.high)}</span>} />
                <StatRow label="Day Low" value={<span className="mono">${fmt(displayQuote.low)}</span>} />
                <StatRow label="Day Open" value={<span className="mono">${fmt(displayQuote.open)}</span>} />
                <StatRow label="Prev Close" value={<span className="mono">${fmt(displayQuote.prevClose)}</span>} />
                <StatRow label="52W High" value={<span className="mono">${fmt(f.week52High)}</span>} />
                <StatRow label="52W Low" value={<span className="mono">${fmt(f.week52Low)}</span>} />
              </div>
            </div>
          </div>

          {enriched && (
            <div className="panel" style={{ marginTop: 16, padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, background: "#1a1f2c", color: "#fff", borderColor: "#1a1f2c", position: "sticky", bottom: 0, zIndex: 30 }}>
              <AlertCircle size={16} color="#d4a017" />
              <div style={{ flex: 1, fontSize: isMobile ? 11 : 12, lineHeight: 1.6 }}>
                <span style={{ color: "#d4a017", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", fontSize: 10 }}>Composite · </span>
                Trend <strong>{trendSignal?.toLowerCase()}</strong>, momentum {momentumSignal?.toLowerCase()} (RSI {fmt(lastRsi, 0)}). Z-score {fmt(lastZ, 1)}σ — {reversionSignal?.toLowerCase()}. Regime: <strong>{regimeSignal?.toLowerCase()}</strong>. Street: <strong>{c.rating?.toLowerCase() ?? "n/a"}</strong>{a?.targetMean ? `. Target $${fmt(a.targetMean, 0)} (${pct(((a.targetMean - displayQuote.current) / displayQuote.current) * 100)} upside)` : ""}{ly?.category && ly.category !== "—" ? `. Lynch: ${ly.category.toLowerCase()}` : ""}.
              </div>
              {!isMobile && <ChevronRight size={16} color="#8a93a3" />}
            </div>
          )}
        </main>
      </div>
      )}
    </div>
  );
}

// ============================================================
// MACRO STRIP - always-visible top bar with market context
// ============================================================
function MacroStrip({ macro, isMobile }) {
  if (!macro?.items?.length) return null;
  return (
    <div style={{ background: "#fff", borderBottom: "1px solid #e6e3db", padding: isMobile ? "6px 10px" : "6px 16px", display: "flex", gap: isMobile ? 8 : 16, alignItems: "center", overflowX: "auto", fontSize: 10 }}>
      <span style={{ color: "#8a93a3", fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0 }}>Macro:</span>
      {macro.items.map((m) => {
        const isYield = m.symbol === "^TNX";
        const valueStr = isYield ? `${m.value.toFixed(2)}%` : m.value.toFixed(2);
        const arrow = m.dayChange > 0 ? "▲" : m.dayChange < 0 ? "▼" : "→";
        const color = m.dayChange > 0 ? "#0a8554" : m.dayChange < 0 ? "#c4314b" : "#8a93a3";
        const shortName = m.symbol === "^TNX" ? "10Y" : m.symbol === "^VIX" ? "VIX" : m.symbol === "DX-Y.NYB" ? "DXY" : m.symbol;
        return (
          <span key={m.symbol} className="mono" style={{ flexShrink: 0 }} title={`${m.name}: ${m.explain}`}>
            <span style={{ color: "#5a6573" }}>{shortName}</span>{" "}
            <strong style={{ color: "#1a1f2c" }}>{valueStr}</strong>{" "}
            <span style={{ color }}>{arrow}{Math.abs(m.dayChange).toFixed(2)}%</span>
          </span>
        );
      })}
    </div>
  );
}

// ============================================================
// AI SUMMARY PANEL — the deterministic "second opinion"
// ============================================================
function SummaryPanel({ summary, symbol, data, ly, f, op, isMobile, collapsible }) {
  const [expanded, setExpanded] = useState(!collapsible);
  if (!summary) return null;
  const stanceColors = {
    positive: { bg: "#0a8554", fg: "#fff" },
    negative: { bg: "#c4314b", fg: "#fff" },
    neutral:  { bg: "#5a6573", fg: "#fff" },
  };
  const sc = stanceColors[summary.stanceColor] || stanceColors.neutral;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head" style={collapsible ? { cursor: "pointer", userSelect: "none" } : null} onClick={collapsible ? () => setExpanded(!expanded) : undefined}>
        <span className="panel-title">
          {collapsible && <span style={{ marginRight: 6, fontSize: 10, color: "#8a93a3" }}>{expanded ? "▼" : "▶"}</span>}
          Dashboard Summary · {symbol}
        </span>
        <span className="pill" style={{ background: sc.bg, color: sc.fg }}>{summary.stance}</span>
      </div>
      {!expanded && (
        <div style={{ padding: "10px 14px", fontSize: 12, color: "#1a1f2c", lineHeight: 1.5 }}>
          {summary.paragraph} <span style={{ color: "#8a93a3", fontSize: 11 }}>(click to expand)</span>
        </div>
      )}
      {expanded && (
        <div style={{ padding: "12px 14px", lineHeight: 1.6 }}>
          <div style={{ fontSize: 12, color: "#1a1f2c", marginBottom: 12 }}>{summary.paragraph}</div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
            {summary.positives?.length > 0 && (
              <div style={{ padding: "10px 12px", background: "#f0f7f1", borderLeft: "3px solid #0a8554", borderRadius: 2 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#0a8554", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>What's working</div>
                {summary.positives.map((p, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#1a1f2c", lineHeight: 1.5, marginBottom: 3 }}>✓ {p}</div>
                ))}
              </div>
            )}
            {(summary.negatives?.length > 0 || summary.flags?.length > 0) && (
              <div style={{ padding: "10px 12px", background: "#fdf3f3", borderLeft: "3px solid #c4314b", borderRadius: 2 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#c4314b", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Watch out for</div>
                {summary.negatives?.map((n, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#1a1f2c", lineHeight: 1.5, marginBottom: 3 }}>· {n}</div>
                ))}
                {summary.flags?.map((f, i) => (
                  <div key={`f${i}`} style={{ fontSize: 11, color: "#1a1f2c", lineHeight: 1.5, marginBottom: 3, fontWeight: 600 }}>⚠ {f}</div>
                ))}
              </div>
            )}
          </div>

          {/* === Multi-Master Investor Check (Buffett, Lynch, Simons, Marks, Druckenmiller, Munger) === */}
          <MultiMasterCheck summary={summary} symbol={symbol} data={data} ly={ly} f={f} op={op} isMobile={isMobile} />

          <div style={{ marginTop: 10, padding: 8, background: "#f5f3ed", fontSize: 10, color: "#5a6573", lineHeight: 1.5, borderRadius: 2 }}>
            <em>This summary is rule-based, computed from dashboard data — not AI commentary. It synthesizes the layers below for a quick read. Always do your own work before any trade.</em>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// MULTI-MASTER CHECK — Run dashboard data through 6 famous investor lenses
// Buffett, Lynch, Simons, Marks, Druckenmiller, Munger
// ============================================================
function MultiMasterCheck({ summary, symbol, data, ly, f, op, isMobile }) {
  const [expandedMaster, setExpandedMaster] = useState(null);

  // Pull values safely, fallback to nulls
  const pe = f?.pe ?? null;
  const fwdPe = f?.fwdPe ?? null;
  const peg = ly?.pegRatio ?? null;
  const roe = ly?.roe ?? null;
  const roic = ly?.roic ?? null;
  const debtEq = ly?.debtEq ?? null;
  const fcfYield = ly?.fcfYield ?? null;
  const earningsYield = ly?.earningsYield ?? null;
  const revGrowth = ly?.revGrowthPct ?? null;
  const epsGrowth = ly?.epsGrowthPct ?? null;
  const insiderNet = ly?.netInsiderActivity ?? null;
  const insiderBuys = ly?.insiderBuys ?? 0;
  const pcr = op?.pcrVolume ?? null;
  const consensusScore = data?.consensusScore ?? null;
  const targetMean = data?.targetMean ?? null;
  const currentPrice = data?.quote?.current ?? null;
  const week52High = data?.quote?.week52High ?? null;
  const sector = data?.sector ?? "";
  const beta = f?.beta ?? null;
  const lynchCat = ly?.category ?? null;

  // ========== BUFFETT LENS — Business quality, moat, fair price ==========
  const buffettChecks = [];
  // Q1: Is this a great business? (ROE > 15, ROIC > 12)
  if (roe != null && roe > 20) {
    buffettChecks.push({ verdict: "match", q: "Is this a wonderful business?", remark: `ROE ${roe.toFixed(0)}% — yes, this earns high returns on shareholder capital. Buffett: "Time is the friend of the wonderful business."` });
  } else if (roe != null && roe < 10) {
    buffettChecks.push({ verdict: "diverge", q: "Is this a wonderful business?", remark: `ROE ${roe.toFixed(0)}% — Buffett would pass. He wants 15%+ ROE consistently.` });
  } else if (roe != null) {
    buffettChecks.push({ verdict: "neutral", q: "Is this a wonderful business?", remark: `ROE ${roe.toFixed(0)}% — decent but not exceptional. Buffett wants 15%+.` });
  }
  // Q2: Is the price fair?
  if (peg != null && peg > 0 && peg < 1.5) {
    buffettChecks.push({ verdict: "match", q: "Is the price fair?", remark: `PEG ${peg.toFixed(2)} — paying a reasonable amount for the growth. "Price is what you pay, value is what you get."` });
  } else if (peg != null && peg > 2.5) {
    buffettChecks.push({ verdict: "diverge", q: "Is the price fair?", remark: `PEG ${peg.toFixed(2)} — Buffett would say "I'd never pay this much for any business." Margin of safety is gone.` });
  } else if (earningsYield != null && earningsYield > 6) {
    buffettChecks.push({ verdict: "match", q: "Is the price fair?", remark: `Earnings yield ${earningsYield.toFixed(1)}% — better than long-term Treasuries. Reasonable.` });
  } else if (earningsYield != null && earningsYield < 3) {
    buffettChecks.push({ verdict: "diverge", q: "Is the price fair?", remark: `Earnings yield ${earningsYield.toFixed(1)}% below 10Y Treasury (~4.4%). Bonds offer better risk-adjusted yield.` });
  }
  // Q3: Strong balance sheet?
  if (debtEq != null && debtEq < 0.5) {
    buffettChecks.push({ verdict: "match", q: "Is the balance sheet conservative?", remark: `D/E ${debtEq.toFixed(2)} — minimal debt. Buffett loves clean balance sheets.` });
  } else if (debtEq != null && debtEq > 2) {
    buffettChecks.push({ verdict: "diverge", q: "Is the balance sheet conservative?", remark: `D/E ${debtEq.toFixed(2)} — heavily levered. Bad in a downturn.` });
  }

  // ========== LYNCH LENS — Growth at reasonable price, story you understand ==========
  const lynchChecks = [];
  // Q1: PEG below 1?
  if (peg != null && peg > 0) {
    if (peg < 1) lynchChecks.push({ verdict: "match", q: "Is PEG below 1?", remark: `PEG ${peg.toFixed(2)} — Lynch's favorite signal. "The P/E of any company that's fairly priced will equal its growth rate."` });
    else if (peg < 1.5) lynchChecks.push({ verdict: "neutral", q: "Is PEG below 1?", remark: `PEG ${peg.toFixed(2)} — slightly above Lynch's sweet spot but still reasonable.` });
    else lynchChecks.push({ verdict: "diverge", q: "Is PEG below 1?", remark: `PEG ${peg.toFixed(2)} — too rich on Lynch's framework. Growth not justifying the multiple.` });
  }
  // Q2: Steady earnings/revenue growth?
  if (revGrowth != null && revGrowth > 15) {
    lynchChecks.push({ verdict: "match", q: "Is growth real?", remark: `Revenue +${revGrowth.toFixed(0)}% — strong organic growth. Classic Lynch "fast grower" territory.` });
  } else if (revGrowth != null && revGrowth < 0) {
    lynchChecks.push({ verdict: "diverge", q: "Is growth real?", remark: `Revenue ${revGrowth.toFixed(0)}% — declining. Lynch would skip "stalwarts in decline."` });
  } else if (revGrowth != null) {
    lynchChecks.push({ verdict: "neutral", q: "Is growth real?", remark: `Revenue +${revGrowth.toFixed(0)}% — modest. Stalwart territory, not "fast grower."` });
  }
  // Q3: Lynch category fits the story?
  if (lynchCat && lynchCat !== "—") {
    const catLower = lynchCat.toLowerCase();
    if (catLower.includes("fast grower")) lynchChecks.push({ verdict: "match", q: "What kind of stock is this?", remark: `Classified as "Fast Grower" — Lynch's favorite category if PEG is sane. These can 10x.` });
    else if (catLower.includes("stalwart")) lynchChecks.push({ verdict: "neutral", q: "What kind of stock is this?", remark: `Classified as "Stalwart" — 10-15% growth annually. Boring but reliable.` });
    else if (catLower.includes("slow")) lynchChecks.push({ verdict: "diverge", q: "What kind of stock is this?", remark: `Classified as "Slow Grower" — Lynch would skip. Wait for the dividend or move on.` });
    else if (catLower.includes("cyclical")) lynchChecks.push({ verdict: "neutral", q: "What kind of stock is this?", remark: `Cyclical — depends on macro timing. PE doesn't work the same here.` });
  }

  // ========== SIMONS LENS — Pure data, no story, statistical edge ==========
  const simonsChecks = [];
  // Q1: Insiders agree?
  if (insiderNet != null && insiderNet < -100e6 && insiderBuys === 0) {
    simonsChecks.push({ verdict: "diverge", q: "Are insiders buying or selling?", remark: `Insiders sold $${formatMcap(Math.abs(insiderNet))} with zero purchases. Smart money exits — that's a data signal, not noise.` });
  } else if (insiderNet != null && insiderBuys > 0 && insiderNet > 0) {
    simonsChecks.push({ verdict: "match", q: "Are insiders buying or selling?", remark: `Net insider buying. Strong data signal — people closest to the business are voting with dollars.` });
  }
  // Q2: Crowd over-positioned? (PCR extreme = contrarian)
  if (pcr != null) {
    if (pcr < 0.4) simonsChecks.push({ verdict: "diverge", q: "Is the crowd over-positioned?", remark: `P/C ratio ${pcr.toFixed(2)} — extreme bullishness. Statistically, this often precedes pullbacks.` });
    else if (pcr > 1.8) simonsChecks.push({ verdict: "match", q: "Is the crowd over-positioned?", remark: `P/C ratio ${pcr.toFixed(2)} — extreme bearishness. Crowds get washed out at the wrong time.` });
    else simonsChecks.push({ verdict: "neutral", q: "Is the crowd over-positioned?", remark: `P/C ratio ${pcr.toFixed(2)} — balanced positioning. No edge from sentiment.` });
  }
  // Q3: Statistical composite signal
  if (summary.stanceColor === "positive") {
    simonsChecks.push({ verdict: "match", q: "What does the composite signal say?", remark: `Dashboard stance is "${summary.stance}" — your data signal supports the position.` });
  } else if (summary.stanceColor === "negative") {
    simonsChecks.push({ verdict: "diverge", q: "What does the composite signal say?", remark: `Dashboard stance is "${summary.stance}" — model says weight of evidence is against you.` });
  } else {
    simonsChecks.push({ verdict: "neutral", q: "What does the composite signal say?", remark: `Dashboard stance is "${summary.stance}" — no clear statistical edge.` });
  }

  // ========== MARKS LENS — Risk-first, second-level thinking ==========
  const marksChecks = [];
  // Q1: What's the reward-to-risk asymmetry?
  if (week52High && currentPrice) {
    const pctOfHigh = (currentPrice / week52High) * 100;
    if (pctOfHigh > 95) {
      marksChecks.push({ verdict: "diverge", q: "What's the asymmetry of risk vs reward?", remark: `At ${pctOfHigh.toFixed(0)}% of 52w high. Limited upside, full downside risk. Marks: "Move toward what's hated, not what's loved."` });
    } else if (pctOfHigh < 60) {
      marksChecks.push({ verdict: "match", q: "What's the asymmetry of risk vs reward?", remark: `At ${pctOfHigh.toFixed(0)}% of 52w high — there's room to run. Marks-favored "uncomfortable opportunity."` });
    } else {
      marksChecks.push({ verdict: "neutral", q: "What's the asymmetry of risk vs reward?", remark: `At ${pctOfHigh.toFixed(0)}% of 52w high — middle of range. Average asymmetry.` });
    }
  }
  // Q2: Is consensus already priced in?
  if (consensusScore != null && targetMean != null && currentPrice) {
    const upside = ((targetMean - currentPrice) / currentPrice) * 100;
    if (consensusScore >= 4.3 && upside < 5) {
      marksChecks.push({ verdict: "diverge", q: "Is the consensus already priced in?", remark: `Wall St rates this "${data?.consensusRating || "buy"}" but stock is already at target. The good news is in the price. Marks: "Trees don't grow to the sky."` });
    } else if (upside > 25) {
      marksChecks.push({ verdict: "match", q: "Is the consensus already priced in?", remark: `Analyst target implies +${upside.toFixed(0)}% — meaningful upside still ahead per consensus.` });
    } else {
      marksChecks.push({ verdict: "neutral", q: "Is the consensus already priced in?", remark: `Modest implied upside (${upside.toFixed(0)}%). Limited consensus edge either way.` });
    }
  }
  // Q3: Where are we in the cycle?
  if (sector.toLowerCase().includes("semi") || sector.toLowerCase().includes("ai")) {
    marksChecks.push({ verdict: "diverge", q: "Where are we in the cycle?", remark: `${sector} is late-cycle territory. AI cap-ex peaks happen, then ratios compress. Marks: "Risk is highest when it feels safest."` });
  }

  // ========== DRUCKENMILLER LENS — Concentrated conviction + macro tailwind ==========
  const druckChecks = [];
  // Q1: Macro alignment
  if (sector.toLowerCase().includes("ai") || sector.toLowerCase().includes("semi") || sector.toLowerCase().includes("hyperscaler")) {
    druckChecks.push({ verdict: "match", q: "Is there a macro tailwind?", remark: `AI/Semis/Hyperscaler — multi-year capex cycle from MSFT, GOOG, META, AMZN. Druckenmiller would call this a thematic tailwind worth riding.` });
  } else if (sector.toLowerCase().includes("financ") && data?.macroContext?.rates10Y > 4) {
    druckChecks.push({ verdict: "match", q: "Is there a macro tailwind?", remark: `Higher rates = better bank NIM. Macro is on your side.` });
  }
  // Q2: Conviction-worthy thesis?
  if (revGrowth != null && roe != null && revGrowth > 15 && roe > 20) {
    druckChecks.push({ verdict: "match", q: "Does this deserve concentration?", remark: `Revenue +${revGrowth.toFixed(0)}%, ROE ${roe.toFixed(0)}%. Druckenmiller philosophy: "Bet big when you have an edge — but only then."` });
  } else if (revGrowth != null && revGrowth < 5) {
    druckChecks.push({ verdict: "diverge", q: "Does this deserve concentration?", remark: `Slow growth (revenue +${revGrowth.toFixed(0)}%). No reason to concentrate. Druckenmiller cuts losers fast.` });
  }

  // ========== MUNGER LENS — Inversion, avoid stupidity ==========
  const mungerChecks = [];
  // Q1: Inversion — what could go wrong?
  const risks = [];
  if (debtEq != null && debtEq > 2) risks.push("balance sheet leverage");
  if (peg != null && peg > 2.5) risks.push("valuation compression");
  if (insiderNet != null && insiderNet < -100e6) risks.push("insider exit");
  if (pcr != null && pcr < 0.4) risks.push("crowded long");
  if (week52High && currentPrice && (currentPrice / week52High) > 0.97) risks.push("priced for perfection");
  if (risks.length >= 3) {
    mungerChecks.push({ verdict: "diverge", q: "Inverting — what could go wrong?", remark: `Multiple risk vectors: ${risks.join(", ")}. Munger: "All I want to know is where I'm going to die, so I'll never go there."` });
  } else if (risks.length === 0) {
    mungerChecks.push({ verdict: "match", q: "Inverting — what could go wrong?", remark: `No obvious red flags. Munger: "Take a simple idea and take it seriously."` });
  } else {
    mungerChecks.push({ verdict: "neutral", q: "Inverting — what could go wrong?", remark: `Some risks present (${risks.join(", ")}) but manageable. Watch them.` });
  }
  // Q2: Is the sector hated or loved? (We want hated)
  if (pcr != null && pcr < 0.4 && summary.flags?.some((f) => f.toLowerCase().includes("near 52"))) {
    mungerChecks.push({ verdict: "diverge", q: "Are people too excited about this?", remark: `Near 52w high + crowd extremely bullish = peak euphoria. Munger: "The big money is not in the buying or selling, but in the waiting."` });
  }

  // ========== Compute master overall verdicts ==========
  const summarize = (checks) => {
    const m = checks.filter((c) => c.verdict === "match").length;
    const d = checks.filter((c) => c.verdict === "diverge").length;
    const total = checks.length;
    if (total === 0) return { score: "neutral", color: "#5a6573", label: "No data" };
    if (m >= 2 && d === 0) return { score: "match", color: "#0a8554", label: "Approves" };
    if (m > d) return { score: "match-weak", color: "#86b09c", label: "Leans positive" };
    if (d >= 2 && m === 0) return { score: "diverge", color: "#c4314b", label: "Would pass" };
    if (d > m) return { score: "diverge-weak", color: "#d4a017", label: "Cautious" };
    return { score: "neutral", color: "#5a6573", label: "Mixed" };
  };

  const masters = [
    { name: "Buffett",       lens: "Quality & price",            checks: buffettChecks, ...summarize(buffettChecks), color: "#0a8554" },
    { name: "Lynch",         lens: "Growth at fair price",       checks: lynchChecks,   ...summarize(lynchChecks),   color: "#5a6573" },
    { name: "Simons",        lens: "Pure data, no story",        checks: simonsChecks,  ...summarize(simonsChecks),  color: "#7ba2cc" },
    { name: "Marks",         lens: "Risk-first, second-level",   checks: marksChecks,   ...summarize(marksChecks),   color: "#d4a017" },
    { name: "Druckenmiller", lens: "Concentrated + macro",       checks: druckChecks,   ...summarize(druckChecks),   color: "#c4314b" },
    { name: "Munger",        lens: "Inversion, avoid stupidity", checks: mungerChecks,  ...summarize(mungerChecks),  color: "#1a1f2c" },
  ].filter((m) => m.checks.length > 0);

  // Overall: average of master scores
  const approveCount = masters.filter((m) => m.score === "match" || m.score === "match-weak").length;
  const passCount = masters.filter((m) => m.score === "diverge" || m.score === "diverge-weak").length;
  const consensus = approveCount >= 4 ? "Broad approval" :
                    approveCount >= passCount + 2 ? "Most masters approve" :
                    passCount >= 4 ? "Broad caution" :
                    passCount >= approveCount + 2 ? "Most masters cautious" :
                    "Masters split";
  const consensusColor = approveCount >= 4 ? "#0a8554" :
                         approveCount >= passCount + 2 ? "#86b09c" :
                         passCount >= 4 ? "#c4314b" :
                         passCount >= approveCount + 2 ? "#d4a017" :
                         "#5a6573";

  return (
    <div style={{ marginTop: 14, padding: "14px 16px", background: "#222837", color: "#fff", borderRadius: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "#d4a017", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Multi-Master Check · {symbol}</span>
        <span className="pill" style={{ background: consensusColor === "#5a6573" ? "#7a8497" : consensusColor, color: "#fff", fontWeight: 700 }}>{consensus}</span>
      </div>
      <div style={{ fontSize: 11, color: "#c0c6d0", lineHeight: 1.5, marginBottom: 14 }}>
        How would the great investors evaluate this stock based on actual data? Click a master to see their detailed checks.
      </div>

      {/* Master cards grid */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
        {masters.map((m) => {
          const isOpen = expandedMaster === m.name;
          // Verdict color — semantic (green/red/yellow/gray based on score, not which master)
          const verdictBg = m.color === "#0a8554" ? "rgba(10, 133, 84, 0.18)"
                         : m.color === "#86b09c" ? "rgba(134, 176, 156, 0.18)"
                         : m.color === "#d4a017" ? "rgba(212, 160, 23, 0.18)"
                         : m.color === "#c4314b" ? "rgba(196, 49, 75, 0.18)"
                         : "rgba(255, 255, 255, 0.06)";
          const verdictText = m.color === "#0a8554" ? "#7fd9a8"
                            : m.color === "#86b09c" ? "#a8d4be"
                            : m.color === "#d4a017" ? "#f4cc4d"
                            : m.color === "#c4314b" ? "#f08fa0"
                            : "#c0c6d0";
          return (
            <div key={m.name}
              onClick={() => setExpandedMaster(isOpen ? null : m.name)}
              style={{ padding: "10px 12px", background: isOpen ? "#3a4150" : "#2a3040", border: isOpen ? `2px solid ${verdictText}` : "1px solid #3a4150", borderRadius: 4, cursor: "pointer", transition: "background 0.15s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", letterSpacing: "0.02em" }}>{m.name}</div>
                <div style={{ fontSize: 9, color: "#fff", opacity: 0.5 }}>{isOpen ? "▼" : "▶"}</div>
              </div>
              <div style={{ fontSize: 10, color: "#a4abb8", marginBottom: 8, lineHeight: 1.3 }}>{m.lens}</div>
              <div style={{ display: "inline-block", padding: "3px 8px", background: verdictBg, color: verdictText, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", borderRadius: 2, textTransform: "uppercase" }}>{m.label}</div>
            </div>
          );
        })}
      </div>

      {/* Expanded master detail */}
      {expandedMaster && (() => {
        const m = masters.find((x) => x.name === expandedMaster);
        if (!m) return null;
        return (
          <div style={{ padding: "12px 14px", background: "#2a3040", border: `2px solid ${m.color === "#1a1f2c" ? "#5a6573" : m.color}`, borderRadius: 4, marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: "#fff", marginBottom: 10 }}>
              <strong>{m.name}'s perspective:</strong> <span style={{ color: "#c0c6d0" }}>{m.lens}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {m.checks.map((c, i) => {
                const icon = c.verdict === "match" ? "✓" : c.verdict === "diverge" ? "✗" : "·";
                const color = c.verdict === "match" ? "#7fd9a8" : c.verdict === "diverge" ? "#f08fa0" : "#c0c6d0";
                return (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 11, lineHeight: 1.55 }}>
                    <span style={{ color, fontWeight: 700, fontSize: 15, flexShrink: 0, width: 16, textAlign: "center" }}>{icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "#fff", fontWeight: 600, marginBottom: 3, fontSize: 12 }}>{c.q}</div>
                      <div style={{ color: "#c0c6d0", fontSize: 11, lineHeight: 1.5 }}>{c.remark}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Overall consensus interpretation */}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #3a4150", fontSize: 11, color: "#c0c6d0", lineHeight: 1.65 }}>
        <strong style={{ color: "#fff" }}>Overall:</strong> <span style={{ color: consensusColor === "#5a6573" ? "#c0c6d0" : consensusColor, fontWeight: 600 }}>{approveCount}/{masters.length} approve, {passCount}/{masters.length} cautious.</span>{" "}
        {consensus === "Broad approval" && "Strong multi-framework support. Position with conviction."}
        {consensus === "Most masters approve" && "Solid setup with some dissenting views worth noting."}
        {consensus === "Masters split" && "Each lens shows a different angle. No clear consensus — your conviction has to come from elsewhere."}
        {consensus === "Most masters cautious" && "More cautions than approvals. Consider trimming or waiting for better entry."}
        {consensus === "Broad caution" && "Multiple frameworks see problems. Even if you believe in the story, the math is against you. Re-evaluate."}
      </div>
    </div>
  );
}

// ============================================================
// RISK FLAGS PANEL — extracted as component so it can sit near top
// ============================================================
function RiskFlagsPanel({ data, ly, f, op, displayQuote, isMobile }) {
  const flags = [];
  if (ly && ly.insiderSells > 0 && (ly.insiderBuys ?? 0) === 0 && (ly.netInsiderActivity ?? 0) < -100e6) {
    flags.push({
      level: "yellow",
      title: "Heavy insider selling, zero insider buying",
      body: `Insiders sold $${formatMcap(Math.abs(ly.netInsiderActivity))} in the last 6 months across ${ly.insiderSells} transactions with no recorded purchases. Could be normal diversification, but worth noting.`,
    });
  }
  const chinaExposed = ["NVDA", "AMD", "TSM", "INTC", "AAPL", "QCOM", "AVGO", "ASML", "MU", "MRVL"];
  if (chinaExposed.includes(data.symbol)) {
    flags.push({
      level: "yellow",
      title: "Significant China / export-control exposure",
      body: `${data.symbol} has material revenue tied to China or is affected by US chip export rules. Earnings can swing on policy changes outside the company's control.`,
    });
  }
  if (op && op.pcrVolume != null) {
    if (op.pcrVolume < 0.3) flags.push({
      level: "yellow",
      title: "Options crowd extremely bullish (contrarian warning)",
      body: `P/C ratio of ${fmt(op.pcrVolume, 2)} means call volume is over 3x put volume. When sentiment is this lopsided, short-term local tops sometimes follow.`,
    });
    else if (op.pcrVolume > 2.0) flags.push({
      level: "yellow",
      title: "Options crowd extremely bearish (contrarian warning)",
      body: `P/C ratio of ${fmt(op.pcrVolume, 2)} means put volume is over 2x call volume. When everyone is hedged, the worst may already be priced in.`,
    });
  }
  if (f.debtEq != null && f.debtEq > 2) flags.push({
    level: "red",
    title: "High leverage",
    body: `Debt/Equity of ${fmt(f.debtEq, 2)} is well above the typical 0.5-1.0 range. Higher financial risk if business conditions deteriorate.`,
  });
  if (f.earningsYield != null && f.earningsYield < 4) flags.push({
    level: "yellow",
    title: "Earnings yield below bond yield",
    body: `${data.symbol}'s earnings yield is ${fmt(f.earningsYield, 1)}% vs ~4.4% 10-year Treasury. You're paying a premium for growth — works if growth continues, expensive if it slows.`,
  });
  if (f.week52High && displayQuote.current && (displayQuote.current / f.week52High) > 0.97) flags.push({
    level: "blue",
    title: "Trading near 52-week high",
    body: `Price is ${fmt((displayQuote.current / f.week52High) * 100, 0)}% of the 52-week high (${fmt(f.week52High)}). Limited room to run unless it breaks out.`,
  });
  if (data.catalysts?.daysToEarnings != null && data.catalysts.daysToEarnings >= 0 && data.catalysts.daysToEarnings <= 14) {
    flags.push({
      level: "yellow",
      title: `Earnings in ${data.catalysts.daysToEarnings} day${data.catalysts.daysToEarnings === 1 ? "" : "s"}`,
      body: `High-volatility window. Expected move from options is the price range to watch (see Options Flow).`,
    });
  }

  if (flags.length === 0) return null;
  const colorMap = { red: "#c4314b", yellow: "#d4a017", blue: "#7ba2cc" };
  const counts = { red: 0, yellow: 0, blue: 0 };
  flags.forEach((fg) => counts[fg.level]++);

  return (
    <div className="panel" style={{ marginBottom: 16, borderColor: counts.red > 0 ? "#c4314b" : counts.yellow > 0 ? "#d4a017" : "#e6e3db", borderWidth: counts.red > 0 ? 2 : 1 }}>
      <div className="panel-head">
        <span className="panel-title">Risk Flags · {flags.length} {flags.length === 1 ? "item" : "items"} worth knowing</span>
        <AlertCircle size={13} color={counts.red > 0 ? "#c4314b" : "#d4a017"} />
      </div>
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {flags.map((flag, i) => (
          <div key={i} style={{ padding: "8px 10px", background: "#fff", borderLeft: `3px solid ${colorMap[flag.level]}`, borderRadius: 2 }}>
            <div style={{ fontWeight: 600, fontSize: 11, color: "#1a1f2c", marginBottom: 3 }}>
              {flag.level === "red" ? "🔴" : flag.level === "yellow" ? "⚠️" : "🔵"} {flag.title}
            </div>
            <div style={{ fontSize: 11, color: "#5a6573", lineHeight: 1.5 }}>{flag.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// CATALYST CALENDAR — upcoming events that move this stock
// ============================================================
function CatalystPanel({ catalysts, symbol, isMobile }) {
  if (!catalysts || (!catalysts.earningsDate && !catalysts.exDividendDate && !catalysts.hyperscalerWatch?.length)) return null;

  const allEvents = [];
  if (catalysts.earningsDate && catalysts.daysToEarnings != null) {
    allEvents.push({
      kind: "EARNINGS",
      date: catalysts.earningsDate,
      days: catalysts.daysToEarnings,
      title: `${symbol} earnings`,
      detail: catalysts.epsEstimate != null ? `EPS estimate: $${catalysts.epsEstimate.toFixed(2)} (range $${catalysts.epsLow?.toFixed(2) ?? "—"} to $${catalysts.epsHigh?.toFixed(2) ?? "—"})` : null,
      color: "#d4a017",
    });
  }
  if (catalysts.exDividendDate) {
    const d = catalysts.exDividendDate;
    const days = Math.round((new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (days >= -7) allEvents.push({ kind: "EX-DIV", date: d, days, title: `${symbol} ex-dividend`, detail: "Buy before this date to receive the next dividend.", color: "#7ba2cc" });
  }
  // Static FOMC dates 2026 (manually maintained — Fed publishes meeting schedule annually)
  const FOMC_2026 = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];
  for (const fd of FOMC_2026) {
    const days = Math.round((new Date(fd).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (days >= 0 && days <= 60) {
      allEvents.push({ kind: "FED", date: fd, days, title: "FOMC rate decision", detail: "Affects growth stocks. Rate cuts bullish, hikes bearish.", color: "#86b09c" });
      break; // only show next FOMC
    }
  }
  // Hyperscaler watch (no dates available without separate fetch, but the names are useful)
  if (catalysts.hyperscalerWatch?.length) {
    allEvents.push({
      kind: "WATCH",
      date: null,
      days: null,
      title: `Watch hyperscaler earnings`,
      detail: `${symbol} demand is driven by capex of: ${catalysts.hyperscalerWatch.join(", ")}. Their earnings reports usually move ${symbol} too.`,
      color: "#7c3aed",
    });
  }
  // Sort: events with dates first, sorted by days
  allEvents.sort((a, b) => {
    if (a.days == null) return 1;
    if (b.days == null) return -1;
    return a.days - b.days;
  });
  if (!allEvents.length) return null;
  const daysColor = (d) => d == null ? "#8a93a3" : d <= 7 ? "#c4314b" : d <= 21 ? "#d4a017" : "#0a8554";

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Catalyst Calendar · Events That Move This Stock</span>
        <span className="mono" style={{ fontSize: 10, color: "#5a6573" }}>Next ~60 days</span>
      </div>
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {allEvents.map((e, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px", background: "#fff", borderLeft: `3px solid ${e.color}`, borderRadius: 2 }}>
            <div style={{ minWidth: isMobile ? 60 : 90, textAlign: "left", flexShrink: 0 }}>
              <div className="mono" style={{ fontSize: 10, fontWeight: 600, color: e.color, letterSpacing: "0.08em" }}>{e.kind}</div>
              {e.days != null && <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: daysColor(e.days), lineHeight: 1 }}>{e.days}d</div>}
              {e.date && <div style={{ fontSize: 9, color: "#8a93a3", marginTop: 2 }}>{e.date}</div>}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1a1f2c", marginBottom: 2 }}>{e.title}</div>
              {e.detail && <div style={{ fontSize: 11, color: "#5a6573", lineHeight: 1.5 }}>{e.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// BEHAVIOR TRACKER — your trades, your reasoning, your patterns
// ============================================================
function BehaviorTracker({ isMobile }) {
  const [trades, setTrades] = useState([]);
  const [form, setForm] = useState({ symbol: "", action: "BUY", shares: "", price: "", thesis: "", exitPlan: "", stopLoss: "", date: new Date().toISOString().slice(0, 10) });

  useEffect(() => {
    try {
      const stored = localStorage.getItem("trading-dashboard-trades");
      if (stored) setTrades(JSON.parse(stored));
    } catch (e) {}
  }, []);

  const saveTrades = (next) => {
    setTrades(next);
    try { localStorage.setItem("trading-dashboard-trades", JSON.stringify(next)); } catch (e) {}
  };
  const addTrade = () => {
    if (!form.symbol || !form.shares || !form.price) return;
    const t = { ...form, id: Date.now(), symbol: form.symbol.toUpperCase(), shares: parseFloat(form.shares), price: parseFloat(form.price), stopLoss: form.stopLoss ? parseFloat(form.stopLoss) : null };
    saveTrades([t, ...trades]);
    setForm({ symbol: "", action: "BUY", shares: "", price: "", thesis: "", exitPlan: "", stopLoss: "", date: new Date().toISOString().slice(0, 10) });
  };
  const removeTrade = (id) => { if (confirm("Remove this entry?")) saveTrades(trades.filter((t) => t.id !== id)); };

  // Stats
  const buys = trades.filter((t) => t.action === "BUY");
  const sells = trades.filter((t) => t.action === "SELL");
  const totalTrades = trades.length;
  const last30 = trades.filter((t) => (Date.now() - new Date(t.date).getTime()) < 30 * 24 * 3600 * 1000).length;
  const last90 = trades.filter((t) => (Date.now() - new Date(t.date).getTime()) < 90 * 24 * 3600 * 1000).length;

  return (
    <div style={{ padding: isMobile ? 12 : 20, maxWidth: 1100, margin: "0 auto" }}>
      <h2 className="serif" style={{ fontSize: isMobile ? 22 : 28, fontWeight: 600, letterSpacing: "-0.02em", margin: "0 0 4px" }}>My Trade Journal</h2>
      <p style={{ fontSize: 13, color: "#5a6573", margin: "0 0 20px", lineHeight: 1.5 }}>
        Tracking your behavior is more predictive of long-term returns than any indicator. Before every trade, write your reasoning. Look back monthly. The patterns you find are worth more than any signal.
      </p>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <span className="panel-title">Behavior Stats</span>
        </div>
        <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 12 }}>
          <div><div style={{ fontSize: 10, color: "#8a93a3", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Total Entries</div><div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{totalTrades}</div></div>
          <div><div style={{ fontSize: 10, color: "#8a93a3", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Buys / Sells</div><div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{buys.length} / {sells.length}</div></div>
          <div><div style={{ fontSize: 10, color: "#8a93a3", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Last 30d</div><div className="mono" style={{ fontSize: 22, fontWeight: 600, color: last30 > 5 ? "#c4314b" : "#1a1f2c" }}>{last30}{last30 > 5 ? " ⚠" : ""}</div></div>
          <div><div style={{ fontSize: 10, color: "#8a93a3", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Last 90d</div><div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{last90}</div></div>
        </div>
        {last30 > 5 && (
          <div style={{ padding: "10px 14px", background: "#fdf3f3", borderTop: "1px solid #efece5", fontSize: 11, color: "#1a1f2c", lineHeight: 1.5 }}>
            ⚠ {last30} trades in the last 30 days. High activity correlates with lower returns. Are you trading based on new information, or reacting to price moves?
          </div>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><span className="panel-title">Log a New Decision</span></div>
        <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "auto auto 1fr 1fr 1fr", gap: 8, alignItems: "end" }}>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Date</div>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} style={{ padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", width: "100%" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Action</div>
            <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} style={{ padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, width: "100%" }}>
              <option>BUY</option><option>SELL</option><option>TRIM</option><option>ADD</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Symbol</div>
            <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="NVDA" style={{ padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", textTransform: "uppercase", width: "100%" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Shares</div>
            <input type="number" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} placeholder="10" style={{ padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", width: "100%" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Price</div>
            <input type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="219.50" style={{ padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", width: "100%" }} />
          </div>
        </div>
        <div style={{ padding: "0 14px 12px", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 8 }}>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Why are you doing this trade? (Be specific.)</div>
            <textarea value={form.thesis} onChange={(e) => setForm({ ...form, thesis: e.target.value })} placeholder="Earnings beat, raised guidance, hyperscaler capex strong..." rows={3} style={{ padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, width: "100%", resize: "vertical", fontFamily: "inherit" }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Exit plan / what would change your mind?</div>
            <textarea value={form.exitPlan} onChange={(e) => setForm({ ...form, exitPlan: e.target.value })} placeholder="Sell if revenue growth slows 2 quarters, or below $180." rows={3} style={{ padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, width: "100%", resize: "vertical", fontFamily: "inherit" }} />
          </div>
        </div>
        <div style={{ padding: "0 14px 14px", display: "flex", alignItems: "center", gap: 12 }}>
          <input type="number" step="0.01" value={form.stopLoss} onChange={(e) => setForm({ ...form, stopLoss: e.target.value })} placeholder="Optional stop loss price" style={{ flex: 1, padding: "6px 8px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12 }} />
          <button onClick={addTrade} style={{ padding: "8px 16px", background: "#1a1f2c", color: "#fff", border: "none", borderRadius: 2, cursor: "pointer", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>+ LOG TRADE</button>
        </div>
        <div style={{ padding: "8px 14px 14px", fontSize: 10, color: "#8a93a3", lineHeight: 1.5 }}>
          Data is stored only in your browser (localStorage). It's private to you on this device — clearing browser data will erase it. No account, no server.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><span className="panel-title">Your Trade Log</span><span className="mono" style={{ fontSize: 10, color: "#5a6573" }}>{trades.length} entries</span></div>
        {trades.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "#8a93a3", fontSize: 12 }}>No trades logged yet. Start by logging your most recent buy/sell.</div>
        ) : (
          <div style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            {trades.map((t) => (
              <div key={t.id} style={{ padding: "10px 12px", background: "#fff", border: "1px solid #efece5", borderRadius: 2, borderLeft: `4px solid ${t.action === "BUY" || t.action === "ADD" ? "#0a8554" : "#c4314b"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                    <span style={{ color: t.action === "BUY" || t.action === "ADD" ? "#0a8554" : "#c4314b" }}>{t.action}</span>{" "}{t.shares} {t.symbol} @ ${t.price.toFixed(2)}{t.stopLoss ? ` · stop $${t.stopLoss.toFixed(2)}` : ""}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#5a6573" }}>{t.date}</span>
                    <button onClick={() => removeTrade(t.id)} style={{ background: "transparent", border: "none", color: "#c4314b", fontSize: 12, cursor: "pointer", padding: 2 }}>×</button>
                  </div>
                </div>
                {t.thesis && <div style={{ fontSize: 11, color: "#1a1f2c", marginTop: 6, lineHeight: 1.5 }}><strong>Thesis:</strong> {t.thesis}</div>}
                {t.exitPlan && <div style={{ fontSize: 11, color: "#1a1f2c", marginTop: 4, lineHeight: 1.5 }}><strong>Exit plan:</strong> {t.exitPlan}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// RISK HELPER — Portfolio risk calculator using VaR
// ============================================================
function RiskHelper({ isMobile, macro }) {
  const [positions, setPositions] = useState([]); // {symbol, shares, costBasis, currentPrice, var95, var955day, cvar95, maxDD}
  const [form, setForm] = useState({ symbol: "", shares: "", costBasis: "" });
  const [accountSize, setAccountSize] = useState("");
  const [riskPct, setRiskPct] = useState(1); // % of account willing to lose per trade
  const [cash, setCash] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Load saved positions from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("trading-dashboard-portfolio");
      if (stored) setPositions(JSON.parse(stored));
      const acct = localStorage.getItem("trading-dashboard-account-size");
      if (acct) setAccountSize(acct);
      const rpct = localStorage.getItem("trading-dashboard-risk-pct");
      if (rpct) setRiskPct(parseFloat(rpct));
      const c = localStorage.getItem("trading-dashboard-cash");
      if (c) setCash(c);
    } catch (e) {}
  }, []);

  const savePositions = (next) => {
    setPositions(next);
    try { localStorage.setItem("trading-dashboard-portfolio", JSON.stringify(next)); } catch (e) {}
  };
  const saveAccountSize = (v) => {
    setAccountSize(v);
    try { localStorage.setItem("trading-dashboard-account-size", v); } catch (e) {}
  };
  const saveRiskPct = (v) => {
    setRiskPct(v);
    try { localStorage.setItem("trading-dashboard-risk-pct", String(v)); } catch (e) {}
  };
  const saveCash = (v) => {
    setCash(v);
    try { localStorage.setItem("trading-dashboard-cash", v); } catch (e) {}
  };

  // Parse bulk text in flexible formats:
  // "NVDA:7.4, MSFT:6, TSM:3"
  // "NVDA 7.4\nMSFT 6\nTSM 3"
  // JSON: {"NVDA": 7.4, "MSFT": 6}
  // JSON array: [{"symbol":"NVDA","shares":7.4}]
  const parseBulk = (txt) => {
    if (!txt || !txt.trim()) return [];
    const t = txt.trim();
    // Try JSON object first
    try {
      const obj = JSON.parse(t);
      if (Array.isArray(obj)) {
        return obj.map((x) => ({
          symbol: (x.symbol || x.ticker || "").toUpperCase(),
          shares: parseFloat(x.shares ?? x.qty ?? x.quantity),
          costBasis: x.costBasis ?? x.cost ?? null,
        })).filter((x) => x.symbol && !isNaN(x.shares));
      }
      if (typeof obj === "object" && obj !== null) {
        return Object.entries(obj).map(([sym, val]) => ({
          symbol: sym.toUpperCase(),
          shares: typeof val === "number" ? val : parseFloat(val.shares ?? val),
          costBasis: typeof val === "object" ? val.costBasis : null,
        })).filter((x) => !isNaN(x.shares));
      }
    } catch (e) {}
    // Fall back to "SYMBOL:NUM, SYMBOL NUM" parsing
    const out = [];
    // Split by comma, newline, or semicolon
    const items = t.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
      // Match SYMBOL followed by colon/space/equals, then number
      const m = item.match(/^([A-Za-z][\w\.\-]*)[\s:=]+([\d.]+)/);
      if (m) {
        const shares = parseFloat(m[2]);
        if (!isNaN(shares) && shares > 0) {
          out.push({ symbol: m[1].toUpperCase(), shares, costBasis: null });
        }
      }
    }
    return out;
  };

  const applyBulk = async () => {
    const parsed = parseBulk(bulkText);
    if (!parsed.length) { setError("Couldn't parse anything. Try format like 'NVDA:7.4, MSFT:6' or JSON."); return; }
    setLoading(true);
    setError(null);
    const next = [];
    for (const p of parsed) {
      const risk = await fetchRiskFor(p.symbol);
      if (risk) {
        next.push({ ...p, ...risk, addedAt: new Date().toISOString().slice(0, 10) });
      } else {
        next.push({ ...p, currentPrice: null, var95: null, var955day: null, cvar95: null, maxDD: null, atr14: null, addedAt: new Date().toISOString().slice(0, 10) });
      }
    }
    savePositions(next);  // REPLACES existing positions
    setBulkText("");
    setShowBulk(false);
    setLoading(false);
  };

  // Fetch position risk data from the per-ticker JSON files
  const fetchRiskFor = async (symbol) => {
    try {
      const res = await fetch(`${BASE}data/${symbol}.json?v=${Date.now()}`);
      if (!res.ok) throw new Error(`No data for ${symbol}`);
      const data = await res.json();
      // Compute peer-average PE for valuation risk
      const peers = data.peerData || {};
      const peerPEs = Object.entries(peers)
        .filter(([k]) => k !== symbol)
        .map(([, v]) => v?.pe)
        .filter((p) => typeof p === "number" && isFinite(p) && p > 0 && p < 200);
      const peerAvgPE = peerPEs.length ? peerPEs.reduce((s, x) => s + x, 0) / peerPEs.length : null;
      return {
        currentPrice: data.quote?.current ?? null,
        var95: data.simons?.var95daily ?? null,
        var955day: data.simons?.var955day ?? null,
        cvar95: data.simons?.cvar95daily ?? null,
        maxDD: data.simons?.maxDrawdown ?? null,
        atr14: data.simons?.atr14 ?? null,
        pe: data.fundamentals?.pe ?? null,
        fwdPe: data.fundamentals?.fwdPe ?? null,
        peerAvgPE,
        sector: data.sector ?? "Unknown",
        correlations: data.correlations ?? {},
        beta: data.fundamentals?.beta ?? null,
      };
    } catch (e) {
      return null;
    }
  };

  const addPosition = async () => {
    if (!form.symbol || !form.shares) return;
    const sym = form.symbol.toUpperCase();
    setLoading(true);
    setError(null);
    const risk = await fetchRiskFor(sym);
    setLoading(false);
    if (!risk) { setError(`Could not find risk data for ${sym}. Make sure it's a ticker in your watchlist.`); return; }
    const next = [...positions, {
      symbol: sym,
      shares: parseFloat(form.shares),
      costBasis: form.costBasis ? parseFloat(form.costBasis) : null,
      ...risk,
      addedAt: new Date().toISOString().slice(0, 10),
    }];
    savePositions(next);
    setForm({ symbol: "", shares: "", costBasis: "" });
  };
  const removePosition = (idx) => { if (confirm("Remove this position?")) savePositions(positions.filter((_, i) => i !== idx)); };

  // Refresh all positions (refetch latest prices and VaR)
  const refreshAll = async () => {
    setLoading(true);
    const next = [];
    for (const p of positions) {
      const risk = await fetchRiskFor(p.symbol);
      if (risk) next.push({ ...p, ...risk });
      else next.push(p);
    }
    savePositions(next);
    setLoading(false);
  };

  // ============ AGGREGATE PORTFOLIO RISK ============
  // Position value = shares × currentPrice
  // Dollar VaR per position = positionValue × (var95 / 100)
  // Portfolio VaR (simple sum) = sum of dollar VaRs. Note: this is the worst case (assumes
  // all positions move together). True portfolio VaR factors in correlations, but for
  // a tech-heavy retail portfolio that's close enough.
  const enriched = positions.map((p) => {
    const value = (p.shares && p.currentPrice) ? p.shares * p.currentPrice : 0;
    const dollarVar95 = (p.var95 != null && value) ? value * (p.var95 / 100) : 0;
    const dollarVar5d = (p.var955day != null && value) ? value * (p.var955day / 100) : 0;
    const dollarCVar = (p.cvar95 != null && value) ? value * (p.cvar95 / 100) : 0;
    const dollarMaxDD = (p.maxDD != null && value) ? value * (Math.abs(p.maxDD) / 100) : 0;
    const unrealizedGain = (p.costBasis && p.currentPrice) ? (p.currentPrice - p.costBasis) * p.shares : null;
    const unrealizedPct = (p.costBasis && p.currentPrice) ? ((p.currentPrice - p.costBasis) / p.costBasis) * 100 : null;
    return { ...p, value, dollarVar95, dollarVar5d, dollarCVar, dollarMaxDD, unrealizedGain, unrealizedPct };
  });
  const totalValue = enriched.reduce((s, p) => s + p.value, 0);
  const totalVar95 = enriched.reduce((s, p) => s + p.dollarVar95, 0);
  const totalVar5d = enriched.reduce((s, p) => s + p.dollarVar5d, 0);
  const totalCVar = enriched.reduce((s, p) => s + p.dollarCVar, 0);
  const totalDD = enriched.reduce((s, p) => s + p.dollarMaxDD, 0);
  const totalGain = enriched.reduce((s, p) => s + (p.unrealizedGain ?? 0), 0);
  const cashNum = parseFloat(cash) || 0;
  // If user entered cash explicitly, use that. Otherwise derive from accountSize - invested.
  const explicitCash = cashNum > 0;
  const totalAccountValue = explicitCash ? (totalValue + cashNum) : (parseFloat(accountSize) || 0);
  const acctNum = totalAccountValue || 0;
  const cashRemaining = explicitCash ? cashNum : Math.max(0, acctNum - totalValue);
  // VaR as % — uses portfolio value (not account size) since that's the relevant base.
  // Account size matters separately for "% of account" framing in snapshot.
  const portfolioVarPct = totalValue > 0 ? (totalVar95 / totalValue) * 100 : null;

  // ============ POSITION SIZING ============
  // Risk per trade = riskPct% of account. Suggested max position uses 95% VaR.
  const riskBudgetPerTrade = (acctNum * riskPct) / 100;

  return (
    <div style={{ padding: isMobile ? 12 : 20, maxWidth: 1200, margin: "0 auto" }}>
      <h2 className="serif" style={{ fontSize: isMobile ? 22 : 28, fontWeight: 600, letterSpacing: "-0.02em", margin: "0 0 4px" }}>Portfolio Risk Calculator</h2>
      <p style={{ fontSize: 13, color: "#5a6573", margin: "0 0 16px", lineHeight: 1.5 }}>
        Enter your positions to see your real risk in dollars. Click any panel header to expand details.
      </p>

      {/* ===== RISK SNAPSHOT — the 3 numbers that matter most ===== */}
      {positions.length > 0 && totalValue > 0 && (
        <RiskSnapshot
          totalValue={totalValue}
          totalVar95={totalVar95}
          totalDD={totalDD}
          portfolioVarPct={portfolioVarPct}
          isMobile={isMobile}
        />
      )}

      {/* Account size + risk tolerance + cash */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><span className="panel-title">Your Setup</span></div>
        <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3, letterSpacing: "0.08em", textTransform: "uppercase" }}>Cash ($) — Optional</div>
            <input type="number" value={cash} onChange={(e) => saveCash(e.target.value)} placeholder="3300" style={{ padding: "8px 10px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 14, fontFamily: "monospace", width: "100%" }} />
            <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 4 }}>If set, total account = cash + positions.</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3, letterSpacing: "0.08em", textTransform: "uppercase" }}>Total account size ($) — fallback</div>
            <input type="number" value={accountSize} onChange={(e) => saveAccountSize(e.target.value)} placeholder="10000" disabled={cashNum > 0} style={{ padding: "8px 10px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 14, fontFamily: "monospace", width: "100%", opacity: cashNum > 0 ? 0.5 : 1, background: cashNum > 0 ? "#f5f3ed" : "#fff" }} />
            <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 4 }}>{cashNum > 0 ? "Using cash + positions instead." : "Used only if Cash is empty."}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3, letterSpacing: "0.08em", textTransform: "uppercase" }}>Risk per trade (% of account)</div>
            <input type="number" step="0.5" value={riskPct} onChange={(e) => saveRiskPct(parseFloat(e.target.value) || 1)} style={{ padding: "8px 10px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 14, fontFamily: "monospace", width: "100%" }} />
            <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 4 }}>1-2% conservative. 3-5% aggressive. 10%+ suicidal.</div>
          </div>
        </div>
      </div>

      {/* Portfolio summary */}
      {positions.length > 0 && (
        <div className="panel" style={{ marginBottom: 16, background: totalVar95 > acctNum * 0.05 ? "#fdf3f3" : "#fff" }}>
          <div className="panel-head">
            <span className="panel-title">Portfolio Risk Summary</span>
            <button onClick={refreshAll} disabled={loading} style={{ background: "transparent", border: "1px solid #d6d2c7", padding: "3px 8px", borderRadius: 2, fontSize: 10, cursor: "pointer" }}>{loading ? "Refreshing..." : "Refresh prices"}</button>
          </div>
          <div style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 14, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Portfolio value</div>
              <div className="mono" style={{ fontSize: isMobile ? 18 : 22, fontWeight: 600 }}>${formatMcap(totalValue)}</div>
              {acctNum > 0 && <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 2 }}>{((totalValue / acctNum) * 100).toFixed(0)}% invested · ${formatMcap(Math.max(0, cashRemaining))} cash</div>}
            </div>
            <div>
              <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Unrealized P/L</div>
              {(() => {
                const hasAnyCostBasis = enriched.some((p) => p.costBasis);
                if (!hasAnyCostBasis) return <div className="mono" style={{ fontSize: isMobile ? 18 : 22, fontWeight: 600, color: "#8a93a3" }}>—</div>;
                return <div className="mono" style={{ fontSize: isMobile ? 18 : 22, fontWeight: 600, color: totalGain >= 0 ? "#0a8554" : "#c4314b" }}>{totalGain >= 0 ? "+" : "-"}${formatMcap(Math.abs(totalGain))}</div>;
              })()}
              {!enriched.some((p) => p.costBasis) && <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 2 }}>Add cost basis to see P/L</div>}
            </div>
            <div title="On a typical bad day (worst 5% of days historically), you could lose this much.">
              <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Bad day loss (95% VaR)</div>
              <div className="mono" style={{ fontSize: isMobile ? 18 : 22, fontWeight: 600, color: "#c4314b" }}>-${formatMcap(totalVar95)}</div>
              {portfolioVarPct != null && <div style={{ fontSize: 10, color: portfolioVarPct > 5 ? "#c4314b" : "#8a93a3", marginTop: 2 }}>{portfolioVarPct.toFixed(1)}% of account</div>}
            </div>
            <div title="On the worst 5% of days, the AVERAGE loss is this. Tail risk.">
              <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Tail loss (CVaR)</div>
              <div className="mono" style={{ fontSize: isMobile ? 18 : 22, fontWeight: 600, color: "#c4314b" }}>-${formatMcap(totalCVar)}</div>
            </div>
          </div>
          <div style={{ padding: "0 16px 14px", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 14 }}>
            <div style={{ padding: "10px 12px", background: "#fff8e1", borderLeft: "3px solid #d4a017", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "#8b6914", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>1-week bad case</div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: "#1a1f2c" }}>-${formatMcap(totalVar5d)}</div>
              <div style={{ fontSize: 10, color: "#5a6573", marginTop: 2 }}>What you could lose over 5 trading days in a 95th-percentile bad week.</div>
            </div>
            <div style={{ padding: "10px 12px", background: "#fdf3f3", borderLeft: "3px solid #c4314b", borderRadius: 2 }}>
              <div style={{ fontSize: 10, color: "#c4314b", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Historical worst case</div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: "#1a1f2c" }}>-${formatMcap(totalDD)}</div>
              <div style={{ fontSize: 10, color: "#5a6573", marginTop: 2 }}>If each stock matches its 1-year max drawdown (peak-to-trough). This has already happened once.</div>
            </div>
          </div>
          {portfolioVarPct != null && portfolioVarPct > 5 && (
            <div style={{ padding: "10px 14px", background: "#fdf3f3", borderTop: "1px solid #efece5", fontSize: 11, color: "#1a1f2c", lineHeight: 1.5 }}>
              ⚠️ Your 1-day VaR is over 5% of your account. That's aggressive. A bad week could draw down 15-25%.
            </div>
          )}
          {enriched.length > 0 && enriched.every((p) => p.var95 == null) && (
            <div style={{ padding: "10px 14px", background: "#fff8e1", borderTop: "1px solid #efece5", fontSize: 11, color: "#1a1f2c", lineHeight: 1.5 }}>
              ⚠️ VaR data not yet available. Run the fetch workflow to compute these:{" "}
              <a href="https://github.com/Daisyapex/trading-dashboard/actions/workflows/fetch-data.yml" target="_blank" rel="noopener noreferrer" style={{ color: "#1a4c80", textDecoration: "underline" }}>Run workflow</a>
              {" "}— then click "Refresh prices" above. The Historical Worst Case is shown using older data that was already fetched.
            </div>
          )}
        </div>
      )}

      {/* Risk Spectrum — always open, visual snapshot of where you sit */}
      {positions.length > 0 && portfolioVarPct != null && (
        <CollapsibleSection title="Risk Spectrum · Where You Sit vs Benchmarks" subtitle={`~${portfolioVarPct.toFixed(1)}% daily`} defaultOpen={true}>
          <RiskSpectrumPanel portfolioVarPct={portfolioVarPct} isMobile={isMobile} embedded macro={macro} />
        </CollapsibleSection>
      )}

      {/* Concentration Risk — always open, the diversification reality check */}
      {enriched.length > 0 && (
        <CollapsibleSection title="Concentration Risk · How Diversified Are You Really" subtitle={`${enriched.length} positions`} defaultOpen={true}>
          <ConcentrationRiskPanel positions={enriched} totalValue={totalValue} isMobile={isMobile} embedded macro={macro} />
        </CollapsibleSection>
      )}

      {/* Valuation Risk — collapsed, deep dive on PE compression */}
      {enriched.length > 0 && enriched.some((p) => p.pe != null) && (
        <CollapsibleSection title="Valuation Risk · If P/E Compresses" subtitle="3 sector-aware scenarios" defaultOpen={false}>
          <ValuationRiskPanel positions={enriched} isMobile={isMobile} embedded />
        </CollapsibleSection>
      )}

      {/* Dalio-Style Diversification Suggestions */}
      {enriched.length > 0 && macro?.benchmarks?.length > 0 && (
        <CollapsibleSection title="Diversification Suggestions · Equity-Focused" subtitle="Stock-only · Holy Grail principle" defaultOpen={true}>
          <DalioSuggestionsPanel positions={enriched} totalValue={totalValue} cashRemaining={cashRemaining} macro={macro} isMobile={isMobile} embedded />
        </CollapsibleSection>
      )}

      {/* Macro Stress Test — collapsed */}
      {enriched.length > 0 && enriched.some((p) => p.correlations && Object.keys(p.correlations).length > 0) && (
        <CollapsibleSection title="Macro Stress Test · Scripted Scenarios" subtitle="5 macro shocks" defaultOpen={false}>
          <MacroStressPanel positions={enriched} totalValue={totalValue} isMobile={isMobile} embedded />
        </CollapsibleSection>
      )}

      {/* Position list */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><span className="panel-title">Your Positions</span><span className="mono" style={{ fontSize: 10, color: "#5a6573" }}>{positions.length} {positions.length === 1 ? "position" : "positions"}</span></div>
        {enriched.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "#8a93a3", fontSize: 12 }}>No positions yet. Add your holdings below to see risk.</div>
        ) : (
          <div style={{ padding: "8px 0", overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", minWidth: 700 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e6e3db", color: "#8a93a3" }}>
                  <th style={{ padding: "6px 10px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Ticker</th>
                  <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Shares</th>
                  <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Price</th>
                  <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Value</th>
                  <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>P/L</th>
                  <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Bad day</th>
                  <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Max DD risk</th>
                  <th style={{ padding: "6px 10px", textAlign: "center", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}></th>
                </tr>
              </thead>
              <tbody>
                {enriched.map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px dotted #efece5" }}>
                    <td className="mono" style={{ padding: "6px 10px", fontWeight: 600 }}>{p.symbol}</td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right" }}>{p.shares}</td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right" }}>${fmt(p.currentPrice, 2)}</td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right", fontWeight: 500 }}>${formatMcap(p.value)}</td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right", color: p.unrealizedPct == null ? "#8a93a3" : p.unrealizedPct > 0 ? "#0a8554" : "#c4314b" }}>
                      {p.unrealizedPct != null ? (p.unrealizedPct >= 0 ? "+" : "") + p.unrealizedPct.toFixed(1) + "%" : "—"}
                    </td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right", color: "#c4314b" }}>-${formatMcap(p.dollarVar95)}</td>
                    <td className="mono" style={{ padding: "6px 10px", textAlign: "right", color: "#c4314b" }}>-${formatMcap(p.dollarMaxDD)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "center" }}>
                      <button onClick={() => removePosition(i)} style={{ background: "transparent", border: "none", color: "#c4314b", fontSize: 14, cursor: "pointer" }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add position form */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <span className="panel-title">{showBulk ? "Bulk Paste Positions" : "Add Position"}</span>
          <button onClick={() => { setShowBulk(!showBulk); setError(null); }} style={{ background: "transparent", border: "1px solid #d6d2c7", padding: "3px 8px", borderRadius: 2, fontSize: 10, cursor: "pointer", letterSpacing: "0.05em" }}>
            {showBulk ? "↶ Single entry" : "📋 Bulk paste"}
          </button>
        </div>
        {showBulk ? (
          <div style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: 11, color: "#5a6573", marginBottom: 8, lineHeight: 1.5 }}>
              Paste your positions in any of these formats. This <strong>replaces</strong> all current positions:
            </div>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={`Examples:\nTSM:3, NVDA:7.4, NOW:14, MSFT:6\n\nOr line by line:\nTSM 3\nNVDA 7.4\nNOW 14\nMSFT 6\n\nOr JSON:\n{"NVDA": 7.4, "MSFT": 6, "TSM": 3}`}
              rows={isMobile ? 6 : 7}
              style={{ width: "100%", padding: 10, border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={applyBulk} disabled={loading || !bulkText.trim()} style={{ padding: "8px 16px", background: "#0a8554", color: "#fff", border: "none", borderRadius: 2, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{loading ? "Loading..." : "✓ APPLY"}</button>
              <button onClick={() => setBulkText("")} disabled={!bulkText} style={{ padding: "8px 14px", background: "transparent", color: "#5a6573", border: "1px solid #d6d2c7", borderRadius: 2, cursor: "pointer", fontSize: 12 }}>Clear</button>
              <span style={{ fontSize: 10, color: "#8a93a3" }}>{parseBulk(bulkText).length} positions parsed</span>
            </div>
            {error && <div style={{ marginTop: 8, color: "#c4314b", fontSize: 11 }}>{error}</div>}
          </div>
        ) : (
          <>
            <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "auto auto auto auto", gap: 8, alignItems: "end" }}>
              <div>
                <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Symbol</div>
                <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="NVDA" style={{ padding: "6px 10px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", textTransform: "uppercase", width: isMobile ? "100%" : 100 }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Shares</div>
                <input type="number" value={form.shares} onChange={(e) => setForm({ ...form, shares: e.target.value })} placeholder="10" style={{ padding: "6px 10px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", width: isMobile ? "100%" : 80 }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#8a93a3", marginBottom: 3 }}>Cost basis ($/share, optional)</div>
                <input type="number" step="0.01" value={form.costBasis} onChange={(e) => setForm({ ...form, costBasis: e.target.value })} placeholder="200.50" style={{ padding: "6px 10px", border: "1px solid #d6d2c7", borderRadius: 2, fontSize: 12, fontFamily: "monospace", width: isMobile ? "100%" : 120 }} />
              </div>
              <button onClick={addPosition} disabled={loading} style={{ padding: "8px 16px", background: "#1a1f2c", color: "#fff", border: "none", borderRadius: 2, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{loading ? "Loading..." : "+ ADD"}</button>
            </div>
            {error && <div style={{ padding: "0 14px 12px", color: "#c4314b", fontSize: 11 }}>{error}</div>}
          </>
        )}
      </div>

      {/* Position sizing helper */}
      {acctNum > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head"><span className="panel-title">Position Sizing Helper · For Future Trades</span></div>
          <div style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: 12, color: "#1a1f2c", marginBottom: 12, lineHeight: 1.6 }}>
              At <strong>{riskPct}% risk per trade</strong> on a <strong>${formatMcap(acctNum)}</strong> account, your budget per trade is <strong style={{ color: "#c4314b" }}>${formatMcap(riskBudgetPerTrade)}</strong>.
              Using each stock's 1-day 95% VaR, this is the maximum position size to keep within that budget:
            </div>
            <PositionSizingTable accountSize={acctNum} riskBudget={riskBudgetPerTrade} isMobile={isMobile} />
          </div>
        </div>
      )}

      <div style={{ padding: 12, background: "#f5f3ed", fontSize: 11, color: "#5a6573", lineHeight: 1.6, borderRadius: 2, marginTop: 16 }}>
        <strong>How to read VaR honestly:</strong> "95% one-day VaR is $7" means: on 95% of trading days, your loss will be less than $7. On the worst 5% of days, you could lose more — sometimes a lot more. VaR assumes the future looks like the past 1 year of returns. Black swans (2008, COVID, flash crashes) are NOT captured. Use this for sanity-checking position sizes, not as a guarantee.
      </div>
    </div>
  );
}


// ============================================================
// RISK SPECTRUM — visual reference of where portfolio sits vs benchmarks
// ============================================================
function RiskSpectrumPanel({ portfolioVarPct, isMobile, embedded, macro }) {
  // Build reference markers from REAL ETF data in macro.benchmarks.
  // Fallback to hardcoded approximations only if macro data isn't available yet.
  const benchmarks = macro?.benchmarks || [];
  const find = (sym) => benchmarks.find((b) => b.symbol === sym);
  // Convert daily vol % → daily 95% VaR % (multiply by 1.645)
  const volToVar = (vol) => vol != null ? vol * 1.645 : null;

  // Curated set: span the spectrum with 8-9 canonical reference points.
  // Avoid near-duplicates (no XLK if we have SPY+QQQ; no VEA+EWJ+VGK all together).
  const realRefs = [
    { label: "Cash / T-bills",   var: 0.05, color: "#5a6573", source: "static" },
    { label: "Bonds (TLT)",      var: volToVar(find("TLT")?.dailyVol),  color: "#5a6573", source: "real" },
    { label: "S&P 500",          var: volToVar(find("SPY")?.dailyVol),  color: "#86b09c", source: "real" },
    { label: "Nasdaq-100",       var: volToVar(find("QQQ")?.dailyVol),  color: "#86b09c", source: "real" },
    { label: "Semis (SMH)",      var: volToVar(find("SMH")?.dailyVol),  color: "#d4a017", source: "real" },
    { label: "Small cap (IWM)",  var: volToVar(find("IWM")?.dailyVol),  color: "#d4a017", source: "real" },
    { label: "Memory (HBM)",     var: volToVar(find("HBM")?.dailyVol),  color: "#d4a017", source: "real" },
    { label: "Bitcoin (IBIT)",   var: volToVar(find("IBIT")?.dailyVol), color: "#c4314b", source: "real" },
    { label: "Crypto cos (BITQ)", var: volToVar(find("BITQ")?.dailyVol), color: "#c4314b", source: "real" },
  ];
  // Drop refs without data
  const refs = realRefs.filter((r) => r.var != null && r.var > 0).sort((a, b) => a.var - b.var);

  // Bucket ranges
  const bands = [
    { label: "Cash",          min: 0,   max: 0.5, color: "#dcefe6" },
    { label: "Conservative",  min: 0.5, max: 1.5, color: "#daf0d0" },
    { label: "Moderate",      min: 1.5, max: 2.5, color: "#dde5f5" },
    { label: "Aggressive",    min: 2.5, max: 4.5, color: "#fff4d6" },
    { label: "Speculative",   min: 4.5, max: 7,   color: "#f7d8db" },
    { label: "Extreme / Casino", min: 7, max: 100, color: "#fde6e6" },
  ];
  // Visual cap scales to max of (10%, the biggest ref + 1)
  const maxScale = Math.max(10, ...refs.map((r) => r.var + 1));
  const xFor = (v) => Math.min(99, (v / maxScale) * 100);
  const yourBand = bands.find((b) => portfolioVarPct >= b.min && portfolioVarPct < b.max) || bands[bands.length - 1];

  // Smart row assignment — assign each ref to a row such that no two refs within 8% of each other share a row.
  // We have 3 rows for variety. Rows 0, 1, 2 alternate vertical position.
  const NUM_ROWS = 3;
  const MIN_X_GAP = 8; // refs within this x% on adjacent rows need spacing
  const rowAssignments = [];
  for (const r of refs) {
    const x = xFor(r.var);
    // Pick the first row where no other ref is within MIN_X_GAP horizontally
    let chosenRow = 0;
    for (let row = 0; row < NUM_ROWS; row++) {
      const conflict = rowAssignments.some((a) => a.row === row && Math.abs(a.x - x) < MIN_X_GAP);
      if (!conflict) { chosenRow = row; break; }
      if (row === NUM_ROWS - 1) chosenRow = row; // fall through to last row if all conflict
    }
    rowAssignments.push({ ref: r, x, row: chosenRow });
  }

  const content = (
      <div style={{ padding: "20px 16px 12px", background: "#1a1f2c", color: "#fff" }}>
        {/* Bands strip */}
        <div style={{ position: "relative", height: 32, display: "flex", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
          {bands.map((b, i) => {
            const widthPct = ((Math.min(b.max, maxScale) - Math.max(b.min, 0)) / maxScale) * 100;
            return (
              <div key={i} style={{ width: `${widthPct}%`, background: b.color, display: "flex", alignItems: "center", justifyContent: "center", borderRight: i < bands.length - 1 ? "1px solid #fff" : "none" }}>
                <span style={{ fontSize: 10, color: "#1a1f2c", fontWeight: 600, letterSpacing: "0.02em", padding: "0 4px", textAlign: "center" }}>{!isMobile || widthPct > 12 ? b.label : ""}</span>
              </div>
            );
          })}
        </div>
        {/* Scale tick marks */}
        <div style={{ position: "relative", height: 14, marginBottom: 24 }}>
          {[0, 1, 2, 3, 4, 5, 7, 10].map((v) => (
            <span key={v} className="mono" style={{ position: "absolute", left: `${xFor(v)}%`, fontSize: 9, color: "#8a93a3", transform: "translateX(-50%)" }}>{v}%</span>
          ))}
        </div>
        {/* Reference markers - 3 rows, smart-assigned to avoid label collision */}
        <div style={{ position: "relative", height: 130 }}>
          {rowAssignments.map((a, i) => {
            const top = a.row * 38; // 0, 38, 76 — 3 vertical lanes
            return (
              <div key={i} style={{ position: "absolute", left: `${a.x}%`, top, transform: "translateX(-50%)", textAlign: "center", maxWidth: 80 }}>
                {/* Vertical connector line from dot down to its position on the bar */}
                <div style={{ width: 1, height: a.row === 0 ? 0 : a.row * 38, background: "#3a4050", margin: "0 auto", position: "absolute", left: "50%", top: -a.row * 38, opacity: 0.4 }} />
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: a.ref.color, margin: "0 auto 4px", border: "1px solid #fff", position: "relative", zIndex: 2 }} />
                <div style={{ fontSize: 9, color: "#fff", lineHeight: 1.2, whiteSpace: "nowrap" }}>{a.ref.label}</div>
                <div className="mono" style={{ fontSize: 9, color: "#8a93a3" }}>~{a.ref.var.toFixed(1)}%</div>
              </div>
            );
          })}
          {/* Your portfolio marker (large, blue) - always on row 0 (top) for visibility */}
          <div style={{ position: "absolute", left: `${xFor(portfolioVarPct)}%`, top: 0, transform: "translateX(-50%)", textAlign: "center", zIndex: 10 }}>
            <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#7ba2cc", margin: "-4px auto 2px", border: "2px solid #fff", boxShadow: "0 0 0 3px #7ba2cc44" }} />
            <div style={{ fontSize: 10, color: "#7ba2cc", fontWeight: 700, whiteSpace: "nowrap" }}>Your portfolio</div>
            <div className="mono" style={{ fontSize: 10, color: "#fff", fontWeight: 600 }}>~{portfolioVarPct.toFixed(1)}%</div>
          </div>
        </div>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #2a2f3c", fontSize: 11, color: "#8a93a3", lineHeight: 1.5 }}>
          Daily VaR as % of total account. Your portfolio's bad-day risk shown alongside common asset classes. Anything green-yellow is normal retail. Red implies you can lose 10%+ in a week without anything unusual happening. Bucket: <strong style={{ color: yourBand.color }}>{yourBand.label}</strong>.
        </div>
      </div>
  );

  if (embedded) return content;
  return (
    <div className="panel" style={{ marginBottom: 16, background: "#1a1f2c", color: "#fff", borderColor: "#1a1f2c" }}>
      <div className="panel-head" style={{ background: "#0f131a", borderBottom: "1px solid #2a2f3c" }}>
        <span className="panel-title" style={{ color: "#fff" }}>Risk Spectrum · Where Your Portfolio Sits</span>
        <span className="pill" style={{ background: yourBand.color, color: "#1a1f2c" }}>{yourBand.label}</span>
      </div>
      {content}
    </div>
  );
}

// ============================================================
// RISK SNAPSHOT — the 3 numbers that matter most, at top of page
// ============================================================
function RiskSnapshot({ totalValue, totalVar95, totalDD, portfolioVarPct, isMobile }) {
  const ddPct = totalValue > 0 ? (totalDD / totalValue) * 100 : 0;
  // The single number to remember: max sustainable drawdown
  const stomachLevel = ddPct < 15 ? "comfortable" : ddPct < 25 ? "moderate" : ddPct < 35 ? "stretched" : "uncomfortable";
  const stomachColor = ddPct < 15 ? "#0a8554" : ddPct < 25 ? "#86b09c" : ddPct < 35 ? "#d4a017" : "#c4314b";
  return (
    <div style={{ marginBottom: 16, padding: isMobile ? 14 : 18, background: "#1a1f2c", color: "#fff", borderRadius: 4 }}>
      <div style={{ fontSize: 10, color: "#d4a017", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Risk Snapshot</div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: isMobile ? 12 : 20, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Typical bad day</div>
          <div className="mono" style={{ fontSize: isMobile ? 24 : 28, fontWeight: 600, lineHeight: 1, color: "#fff", marginTop: 6 }}>-${formatMcap(totalVar95)}</div>
          <div style={{ fontSize: 11, color: "#8a93a3", marginTop: 2 }}>{portfolioVarPct?.toFixed(1)}% of portfolio · happens ~12 days/year</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Historical worst case</div>
          <div className="mono" style={{ fontSize: isMobile ? 24 : 28, fontWeight: 600, lineHeight: 1, color: "#fff", marginTop: 6 }}>-${formatMcap(totalDD)}</div>
          <div style={{ fontSize: 11, color: "#8a93a3", marginTop: 2 }}>{ddPct.toFixed(0)}% drawdown · happened once in past year</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Stomach test</div>
          <div className="mono" style={{ fontSize: isMobile ? 24 : 28, fontWeight: 600, lineHeight: 1, color: stomachColor, marginTop: 6 }}>{stomachLevel}</div>
          <div style={{ fontSize: 11, color: "#8a93a3", marginTop: 2 }}>Can you handle losing ${formatMcap(totalDD)} without panic-selling?</div>
        </div>
      </div>
      <div style={{ paddingTop: 10, borderTop: "1px solid #2a2f3c", fontSize: 11, color: "#8a93a3", lineHeight: 1.5 }}>
        The number that matters most: <strong style={{ color: "#fff" }}>historical worst case</strong>. If you'd panic-sell at <strong style={{ color: stomachColor }}>-${formatMcap(totalDD)}</strong>, you're oversized. If you'd happily buy more, you might be undersized. Detail panels below.
      </div>
    </div>
  );
}

// Reusable collapsible wrapper for panels
function CollapsibleSection({ title, subtitle, defaultOpen, children, icon, marginBottom = 16 }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="panel" style={{ marginBottom }}>
      <div className="panel-head" style={{ cursor: "pointer", userSelect: "none" }} onClick={() => setOpen(!open)}>
        <span className="panel-title">
          <span style={{ marginRight: 6, fontSize: 10, color: "#8a93a3", display: "inline-block", width: 10 }}>{open ? "▼" : "▶"}</span>
          {title}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {subtitle && <span className="mono" style={{ fontSize: 10, color: "#5a6573" }}>{subtitle}</span>}
          {icon}
        </div>
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

// ============================================================
// VALUATION RISK — multiple compression scenarios (sector-aware)
// ============================================================
function ValuationRiskPanel({ positions, isMobile, embedded }) {
  // Each stock has its OWN realistic bear-case PE, based on sector norms
  // Format: { sectorKeyword: { typical, bear, severe } }
  const SECTOR_PE_HISTORY = {
    "Semiconductor": { typical: 25, bear: 18, severe: 14, desc: "Semi sector typical PE 22-28. 2022 bottomed near 14x." },
    "Hyperscaler":   { typical: 28, bear: 22, severe: 18, desc: "Mega-cap tech typical PE 25-30. 2022 lows around 18x." },
    "AI Software":   { typical: 45, bear: 30, severe: 22, desc: "Growth SaaS typical PE 40-60. 2022 SaaS bear bottomed at 22x." },
    "Software":      { typical: 40, bear: 28, severe: 20, desc: "Software typical PE 30-45. Bear case 20-28x." },
    "Healthcare":    { typical: 22, bear: 17, severe: 14, desc: "Healthcare typical PE 18-25. Bear case 14-17x." },
    "Financial":     { typical: 14, bear: 10, severe: 7,  desc: "Banks typical PE 11-15. Bear case 7-10x." },
    "Energy":        { typical: 14, bear: 9,  severe: 6,  desc: "Energy cyclical. Bear case 6-9x." },
    "Consumer":      { typical: 22, bear: 16, severe: 12, desc: "Consumer typical PE 18-25. Bear case 12-16x." },
    "Default":       { typical: 20, bear: 15, severe: 12, desc: "S&P 500 historical average ~18x. Bear ~15x. Severe ~12x." },
  };
  const getSectorAnchors = (sectorRaw) => {
    if (!sectorRaw) return SECTOR_PE_HISTORY.Default;
    const s = sectorRaw.toLowerCase();
    if (s.includes("semi")) return { ...SECTOR_PE_HISTORY.Semiconductor, label: "Semiconductors" };
    if (s.includes("hyperscaler") || s.includes("internet content")) return { ...SECTOR_PE_HISTORY.Hyperscaler, label: "Mega-Cap Tech" };
    if (s.includes("ai") || s.includes("software")) return { ...SECTOR_PE_HISTORY["AI Software"], label: "Software" };
    if (s.includes("health")) return { ...SECTOR_PE_HISTORY.Healthcare, label: "Healthcare" };
    if (s.includes("financ") || s.includes("bank") || s.includes("insur")) return { ...SECTOR_PE_HISTORY.Financial, label: "Financials" };
    if (s.includes("energ") || s.includes("oil")) return { ...SECTOR_PE_HISTORY.Energy, label: "Energy" };
    if (s.includes("consumer") || s.includes("retail")) return { ...SECTOR_PE_HISTORY.Consumer, label: "Consumer" };
    return { ...SECTOR_PE_HISTORY.Default, label: "Diversified" };
  };

  const rows = positions.filter((p) => p.pe != null && p.pe > 0).map((p) => {
    const anchors = getSectorAnchors(p.sector);
    // For each anchor PE, compute price implied: newPrice = currentPrice × (anchorPE / currentPE)
    // Then total $ impact = (newPrice - currentPrice) × shares = value × (anchorPE/currentPE - 1)
    const impactPct = (anchor) => p.pe > 0 ? ((anchor / p.pe) - 1) * 100 : 0;
    return {
      ...p,
      sectorAnchors: anchors,
      pctToTypical: impactPct(anchors.typical),
      pctToBear: impactPct(anchors.bear),
      pctToSevere: impactPct(anchors.severe),
      dollarToTypical: p.value * (impactPct(anchors.typical) / 100),
      dollarToBear: p.value * (impactPct(anchors.bear) / 100),
      dollarToSevere: p.value * (impactPct(anchors.severe) / 100),
    };
  });
  if (!rows.length) return null;
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalToTypical = rows.reduce((s, r) => s + r.dollarToTypical, 0);
  const totalToBear = rows.reduce((s, r) => s + r.dollarToBear, 0);
  const totalToSevere = rows.reduce((s, r) => s + r.dollarToSevere, 0);

  const inner = (
      <div style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 12, color: "#1a1f2c", lineHeight: 1.6, marginBottom: 16 }}>
          What if investors decide to pay less per dollar of earnings? Each stock is compared against its <strong>own sector's historical P/E range</strong> — not an unrealistic broad-market average.
        </div>

        {/* Big number cards */}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
          <ScenarioCard
            label="Sector typical PE"
            sub="If valuations normalize to sector norm"
            dollarImpact={totalToTypical}
            totalValue={totalValue}
            color={totalToTypical >= 0 ? "#0a8554" : "#d4a017"}
            isMobile={isMobile}
          />
          <ScenarioCard
            label="Sector bear case"
            sub="2022-style sentiment shift"
            dollarImpact={totalToBear}
            totalValue={totalValue}
            color="#d4a017"
            isMobile={isMobile}
          />
          <ScenarioCard
            label="Sector severe"
            sub="Like 2008/2022 trough"
            dollarImpact={totalToSevere}
            totalValue={totalValue}
            color="#c4314b"
            isMobile={isMobile}
          />
        </div>

        {/* Per-stock breakdown - compact, single line each */}
        <div className="panel-title" style={{ fontSize: 10, marginBottom: 6 }}>Per-Position Detail</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", minWidth: 600 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e6e3db", color: "#8a93a3" }}>
                <th style={{ padding: "6px 8px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Ticker</th>
                <th style={{ padding: "6px 8px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Sector</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Now PE</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Typical</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Bear</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Severe</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} style={{ borderBottom: "1px dotted #efece5" }}>
                  <td className="mono" style={{ padding: "6px 8px", fontWeight: 600 }}>{r.symbol}</td>
                  <td style={{ padding: "6px 8px", fontSize: 10, color: "#5a6573" }}>{r.sectorAnchors.label}</td>
                  <td className="mono" style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(r.pe, 1)}×</td>
                  <td className="mono" style={{ padding: "6px 8px", textAlign: "right", color: r.dollarToTypical >= 0 ? "#0a8554" : "#c4314b" }}>
                    <div>{r.sectorAnchors.typical}×</div>
                    <div style={{ fontSize: 9 }}>{r.dollarToTypical >= 0 ? "+" : "-"}${formatMcap(Math.abs(r.dollarToTypical))}</div>
                  </td>
                  <td className="mono" style={{ padding: "6px 8px", textAlign: "right", color: "#c4314b" }}>
                    <div>{r.sectorAnchors.bear}×</div>
                    <div style={{ fontSize: 9 }}>-${formatMcap(Math.abs(r.dollarToBear))}</div>
                  </td>
                  <td className="mono" style={{ padding: "6px 8px", textAlign: "right", color: "#c4314b", fontWeight: 600 }}>
                    <div>{r.sectorAnchors.severe}×</div>
                    <div style={{ fontSize: 9 }}>-${formatMcap(Math.abs(r.dollarToSevere))}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12, padding: 10, background: "#f5f3ed", fontSize: 11, color: "#5a6573", lineHeight: 1.6, borderRadius: 2 }}>
          <strong>How to read:</strong> "Bear" = your stock's PE falls to its sector's typical 2022-bear-low. "Severe" = like a full sector crash. Tech rarely goes below ~14x (semis) or ~22x (software) even in crashes. NVDA at 18x like the broad market isn't realistic — it would re-rate to ~14-18x in a true semi crash.
        </div>
      </div>
  );

  if (embedded) return inner;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Valuation Risk · If P/E Compresses</span>
        <DollarSign size={13} color="#d4a017" />
      </div>
      {inner}
    </div>
  );
}

// Helper card component used by ValuationRiskPanel
function ScenarioCard({ label, sub, dollarImpact, totalValue, color, isMobile }) {
  const pctImpact = totalValue > 0 ? (dollarImpact / totalValue) * 100 : 0;
  const isLoss = dollarImpact < 0;
  return (
    <div style={{ padding: "12px 14px", background: "#fff", border: `1px solid ${color}`, borderLeft: `4px solid ${color}`, borderRadius: 2 }}>
      <div style={{ fontSize: 10, color, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600 }}>{label}</div>
      <div className="mono" style={{ fontSize: isMobile ? 20 : 24, fontWeight: 600, color: isLoss ? "#c4314b" : "#0a8554", marginTop: 6, lineHeight: 1 }}>
        {dollarImpact === 0 ? "~$0" : (isLoss ? "-" : "+") + "$" + formatMcap(Math.abs(dollarImpact))}
      </div>
      <div style={{ fontSize: 11, color: isLoss ? "#c4314b" : "#0a8554", marginTop: 2, fontWeight: 600 }}>
        {pctImpact >= 0 ? "+" : ""}{pctImpact.toFixed(1)}% of portfolio
      </div>
      <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 6, lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}

// ============================================================
// CONCENTRATION RISK — single-stock, sector, effective diversification
// ============================================================
function ConcentrationRiskPanel({ positions, totalValue, isMobile, embedded, macro }) {
  if (!totalValue) return null;
  // Single stock concentration
  const sorted = [...positions].sort((a, b) => b.value - a.value);
  const top = sorted[0];
  const topPct = (top.value / totalValue) * 100;
  const top3Pct = sorted.slice(0, 3).reduce((s, p) => s + p.value, 0) / totalValue * 100;

  // Sector concentration
  const sectorMap = {};
  for (const p of positions) {
    const sector = p.sector || "Unknown";
    sectorMap[sector] = (sectorMap[sector] || 0) + p.value;
  }
  const sectorRows = Object.entries(sectorMap)
    .map(([sector, value]) => ({ sector, value, pct: (value / totalValue) * 100 }))
    .sort((a, b) => b.value - a.value);
  const dominantSector = sectorRows[0];

  // Effective diversification using average pairwise correlation with SPY
  // (simpler proxy: stocks with high SPY correlation are essentially the same bet)
  const spyCorrs = positions.map((p) => p.correlations?.["SPY"]).filter((c) => c != null);
  const avgSpyCorr = spyCorrs.length ? spyCorrs.reduce((s, x) => s + x, 0) / spyCorrs.length : null;
  // SOXX correlation tells you tech-specific exposure
  const soxxCorrs = positions.map((p) => p.correlations?.["SOXX"]).filter((c) => c != null);
  const avgSoxxCorr = soxxCorrs.length ? soxxCorrs.reduce((s, x) => s + x, 0) / soxxCorrs.length : null;
  // Effective N = N / (1 + (N-1) * avg_correlation_among_positions)
  // For simplicity use SOXX correlation as a proxy for "how much do my stocks move together"
  const N = positions.length;
  const avgCorr = avgSoxxCorr ?? avgSpyCorr ?? 0;
  const effectiveN = avgCorr > 0 && N > 1 ? N / (1 + (N - 1) * avgCorr) : N;

  // Warning levels
  const concentrationFlags = [];
  if (topPct > 30) concentrationFlags.push({ level: "red", msg: `${top.symbol} is ${topPct.toFixed(0)}% of portfolio. Single-stock risk is extreme.` });
  else if (topPct > 20) concentrationFlags.push({ level: "yellow", msg: `${top.symbol} is ${topPct.toFixed(0)}% of portfolio. Single-stock risk is elevated.` });
  if (dominantSector.pct > 60) concentrationFlags.push({ level: "red", msg: `${dominantSector.pct.toFixed(0)}% of portfolio is ${dominantSector.sector}. Sector risk is extreme.` });
  else if (dominantSector.pct > 40) concentrationFlags.push({ level: "yellow", msg: `${dominantSector.pct.toFixed(0)}% of portfolio is ${dominantSector.sector}. Sector concentration is high.` });
  if (avgSoxxCorr > 0.7) concentrationFlags.push({ level: "yellow", msg: `Average correlation with semis is ${avgSoxxCorr.toFixed(2)}. Your positions move together — limited diversification benefit.` });

  const inner = (
      <div style={{ padding: "12px 14px" }}>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
          <div title="The largest single position as % of portfolio.">
            <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Top Position</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: topPct > 30 ? "#c4314b" : topPct > 20 ? "#d4a017" : "#1a1f2c", marginTop: 4 }}>{top.symbol} · {topPct.toFixed(0)}%</div>
          </div>
          <div title="Top 3 positions as % of portfolio.">
            <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Top 3 Concentration</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: top3Pct > 80 ? "#c4314b" : top3Pct > 60 ? "#d4a017" : "#1a1f2c", marginTop: 4 }}>{top3Pct.toFixed(0)}%</div>
          </div>
          <div title="Effective number of truly independent bets, adjusted for correlation. Lower = less diversified.">
            <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Effective Bets</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: effectiveN < 2 ? "#c4314b" : effectiveN < 3 ? "#d4a017" : "#0a8554", marginTop: 4 }}>{effectiveN.toFixed(1)} <span style={{ color: "#8a93a3", fontWeight: 400 }}>of {N}</span></div>
          </div>
          <div title="Average correlation with the semiconductor ETF. >0.7 means your positions are essentially one tech bet.">
            <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Avg corr w/ Semis</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: avgSoxxCorr > 0.7 ? "#c4314b" : avgSoxxCorr > 0.5 ? "#d4a017" : "#0a8554", marginTop: 4 }}>{avgSoxxCorr != null ? avgSoxxCorr.toFixed(2) : "—"}</div>
          </div>
        </div>

        {/* Sector breakdown */}
        <div className="panel-title" style={{ fontSize: 10, marginBottom: 8, marginTop: 14 }}>Sector Breakdown</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {sectorRows.map((s, i) => {
            const color = s.pct > 60 ? "#c4314b" : s.pct > 40 ? "#d4a017" : "#7ba2cc";
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: isMobile ? 100 : 180, fontSize: 11, color: "#5a6573", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.sector}</span>
                <div style={{ flex: 1, height: 16, background: "#efece5", borderRadius: 2, position: "relative" }}>
                  <div style={{ width: `${s.pct}%`, height: "100%", background: color, borderRadius: 2 }} />
                </div>
                <span className="mono" style={{ width: 50, textAlign: "right", fontSize: 11, fontWeight: 600, flexShrink: 0 }}>{s.pct.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>

        {concentrationFlags.length > 0 && (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            {concentrationFlags.map((f, i) => (
              <div key={i} style={{ padding: "8px 10px", background: f.level === "red" ? "#fdf3f3" : "#fff8e1", borderLeft: `3px solid ${f.level === "red" ? "#c4314b" : "#d4a017"}`, fontSize: 11, color: "#1a1f2c", lineHeight: 1.5, borderRadius: 2 }}>
                {f.level === "red" ? "🔴" : "⚠️"} {f.msg}
              </div>
            ))}
          </div>
        )}

        {/* ===== Per-position Volatility Table with Industry Benchmarks ===== */}
        <div className="panel-title" style={{ fontSize: 10, marginTop: 18, marginBottom: 8 }}>Volatility vs Industry Benchmarks</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", minWidth: 600 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e6e3db", color: "#8a93a3" }}>
                <th style={{ padding: "6px 8px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Ticker</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }} title="Daily expected move based on 1-year historical volatility.">Daily Vol</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Sector Norm</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>vs S&P 500 (1%)</th>
                <th style={{ padding: "6px 8px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Assessment</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Build lookups from macro.benchmarks (real ETF daily vol data)
                const benchmarks = macro?.benchmarks || [];
                const spy = benchmarks.find((b) => b.symbol === "SPY");
                const spyVol = spy?.dailyVol || 1.0;
                // Per-ticker manual map for cases where stock has specific best-fit benchmark
                const TICKER_BENCHMARK = {
                  // Memory stocks
                  "MU": "HBM",
                  // Logic semis
                  "NVDA": "SMH", "AMD": "SMH", "TSM": "SMH", "AVGO": "SMH", "ASML": "SMH",
                  "ARM": "SMH", "MRVL": "SMH", "QCOM": "SMH", "INTC": "SMH",
                  // AI infrastructure hardware
                  "SMCI": "ARTY", "ANET": "ARTY", "VRT": "ARTY", "DELL": "ARTY", "NBIS": "ARTY",
                  // Software/SaaS
                  "NOW": "IGV", "ORCL": "IGV", "PLTR": "IGV", "TEM": "IGV", "PATH": "IGV",
                  // Cybersecurity
                  "CRWD": "CIBR", "PANW": "CIBR",
                  // Mega cap tech
                  "MSFT": "OEF", "AAPL": "OEF", "GOOGL": "OEF", "AMZN": "OEF", "META": "OEF",
                  // Crypto-related
                  "MSTR": "BITQ", "COIN": "BITQ",
                  // Power for AI
                  "VST": "XLK", "CEG": "XLK",
                  // Energy
                  "CVX": "XLE", "OXY": "XLE",
                  // Healthcare
                  "LLY": "XLV", "UNH": "XLV", "HIMS": "XLV",
                  // Financials
                  "JPM": "XLF", "GS": "XLF", "AXP": "XLF", "SOFI": "XLF", "HOOD": "XLF",
                  // Consumer
                  "TSLA": "XLY", "NFLX": "XLY", "RDDT": "XLY", "CMG": "XLY", "DIS": "XLY",
                  "AMD2": "XLY", // placeholder
                  // Small-cap special situations
                  "RKLB": "IWM", "ASTS": "IWM", "OPEN": "IWM",
                };
                // Sector-keyword fallback for tickers not in manual map
                const sectorMatch = (sectorRaw) => {
                  if (!sectorRaw) return "SPY";
                  const s = sectorRaw.toLowerCase();
                  if (s.includes("semi")) return "SMH";
                  if (s.includes("hyperscaler") || s.includes("internet content")) return "OEF";
                  if (s.includes("ai infrastructure")) return "ARTY";
                  if (s.includes("ai software") || s.includes("software")) return "IGV";
                  if (s.includes("cyber")) return "CIBR";
                  if (s.includes("health")) return "XLV";
                  if (s.includes("financ") || s.includes("bank") || s.includes("payment")) return "XLF";
                  if (s.includes("energ") || s.includes("oil")) return "XLE";
                  if (s.includes("consumer") || s.includes("retail") || s.includes("entertain")) return "XLY";
                  if (s.includes("crypto")) return "BITQ";
                  return "SPY";
                };

                return positions.map((p) => {
                  const dailyVol = p.var95 != null ? p.var95 / 1.645 : (p.atr14 && p.currentPrice ? (p.atr14 / p.currentPrice) * 100 : null);
                  if (dailyVol == null) return null;
                  // Find best benchmark
                  const benchmarkSym = TICKER_BENCHMARK[p.symbol] || sectorMatch(p.sector);
                  const bench = benchmarks.find((b) => b.symbol === benchmarkSym);
                  const benchVol = bench?.dailyVol || spyVol;
                  const benchLabel = bench?.vol_label || "S&P 500";
                  const vsSP500 = dailyVol / spyVol;
                  const vsBench = dailyVol / benchVol;
                  const assessment = vsBench > 1.4 ? { text: "Well above sector", color: "#c4314b" }
                                   : vsBench > 1.15 ? { text: "Above sector", color: "#d4a017" }
                                   : vsBench > 0.85 ? { text: "Normal for sector", color: "#0a8554" }
                                   : { text: "Below sector", color: "#0a8554" };
                  return (
                    <tr key={p.symbol} style={{ borderBottom: "1px dotted #efece5" }}>
                      <td className="mono" style={{ padding: "6px 8px", fontWeight: 600 }}>{p.symbol}</td>
                      <td className="mono" style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>{dailyVol.toFixed(2)}%</td>
                      <td className="mono" style={{ padding: "6px 8px", textAlign: "right", color: "#5a6573" }}>
                        {bench ? bench.dailyVol.toFixed(2) + "%" : "—"} <span style={{ fontSize: 9, color: "#8a93a3" }}>{benchLabel}</span>
                      </td>
                      <td className="mono" style={{ padding: "6px 8px", textAlign: "right", color: vsSP500 > 2 ? "#c4314b" : vsSP500 > 1.5 ? "#d4a017" : "#1a1f2c" }}>{vsSP500.toFixed(1)}×</td>
                      <td style={{ padding: "6px 8px", fontSize: 10, color: assessment.color, fontWeight: 600 }}>{assessment.text}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, padding: 8, background: "#f5f3ed", fontSize: 10, color: "#5a6573", lineHeight: 1.5, borderRadius: 2 }}>
          <strong>Daily Vol</strong> = the typical 1-day price move (std dev from last 90 days). <strong>Benchmark</strong> = the volatility of the sector ETF most relevant to that stock (e.g., NVDA → SMH, MU → HBM, NOW → IGV, MSFT → OEF). Benchmark numbers are <strong>computed from real market data</strong>, not hardcoded. S&P 500 (SPY) is the baseline for "average stock."
        </div>

        <div style={{ marginTop: 12, padding: 10, background: "#f5f3ed", fontSize: 11, color: "#5a6573", lineHeight: 1.6, borderRadius: 2 }}>
          <strong>Effective bets vs nominal count:</strong> Holding 4 tech stocks isn't 4 bets — it's closer to 1.5 because they all rise and fall together. True diversification comes from owning things that move <em>differently</em>: stocks + bonds + gold + international, or tech + utilities + healthcare + energy.
        </div>
      </div>
  );

  if (embedded) return inner;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Concentration Risk · How Diversified Are You Really</span>
        <AlertCircle size={13} color="#d4a017" />
      </div>
      {inner}
    </div>
  );
}

// ============================================================
// DIVERSIFICATION SUGGESTIONS — equity-focused (not Dalio All Weather)
// Uses Dalio's "Holy Grail" principle (uncorrelated bets) but applied to stocks
// since user prefers equity-only diversification with cash as the tactical reserve.
// ============================================================
function DalioSuggestionsPanel({ positions, totalValue, cashRemaining, macro, isMobile, embedded }) {
  // Candidate diversifiers — ALL equity. Cash is treated separately.
  const CANDIDATES = [
    // Geographic diversification
    { symbol: "VEA",  name: "Developed Markets ex-US (VEA)", category: "Geographic", desc: "Europe, Japan, UK, Australia. Different economic cycles than the US. Currently trades at much lower P/E than the US — Europe ~14× vs US ~22×.", targetPct: 12 },
    { symbol: "VWO",  name: "Emerging Markets (VWO)",         category: "Geographic", desc: "China, India, Taiwan, Brazil, S Korea. Lower valuations, higher growth potential, but more political risk. Often inversely correlated with US dollar strength.", targetPct: 8 },
    { symbol: "INDA", name: "India (INDA)",                   category: "Geographic", desc: "Fastest-growing major economy. Trades on different fundamentals than US tech. Demographic tailwind for decades.", targetPct: 5 },
    { symbol: "EWJ",  name: "Japan (EWJ)",                    category: "Geographic", desc: "Decades of underperformance, now in early bull market. Different rate cycle from US.", targetPct: 5 },
    { symbol: "VGK",  name: "Europe (VGK)",                   category: "Geographic", desc: "European banks, industrials, luxury, healthcare. Cheap relative to US (P/E ~14×).", targetPct: 5 },
    // Sector diversification (US, but uncorrelated with tech)
    { symbol: "XLV",  name: "Healthcare (XLV)",               category: "Sector",     desc: "Defensive sector with aging-demographics tailwind. Pharma, biotech, hospitals, insurance. Low correlation with tech.", targetPct: 8 },
    { symbol: "XLF",  name: "Financials (XLF)",               category: "Sector",     desc: "Banks and insurance. Benefits from higher rates (opposite of tech). Cyclical but cheap relative to broad market.", targetPct: 7 },
    { symbol: "XLE",  name: "Energy (XLE)",                   category: "Sector",     desc: "Oil & gas. Often inversely correlated with tech. Inflation hedge AND geopolitical hedge. Pays dividends.", targetPct: 5 },
    { symbol: "XLY",  name: "Consumer Discretionary (XLY)",   category: "Sector",     desc: "Includes Amazon, Tesla, but also auto, retail, hotels. More cyclical than tech but different drivers.", targetPct: 5 },
    { symbol: "XLP",  name: "Consumer Staples (XLP)",         category: "Sector",     desc: "Coca-Cola, P&G, Walmart. Recession-resistant. Low growth but very low volatility.", targetPct: 5 },
    // Market cap diversification
    { symbol: "IWM",  name: "Small Cap (IWM)",                category: "Market Cap", desc: "Russell 2000. Different cycle than mega-cap tech — often runs when rates fall and risk-on resumes. Higher growth potential, higher vol.", targetPct: 7 },
    { symbol: "AVUV", name: "Small Cap Value (AVUV)",         category: "Market Cap", desc: "The factor that has outperformed historically. Cheap small companies — Buffett's hunting ground.", targetPct: 5 },
    { symbol: "MDY",  name: "Mid Cap (MDY)",                  category: "Market Cap", desc: "S&P 400. The 'sweet spot' — too big to fail, small enough to grow. Often outperforms large caps over long periods.", targetPct: 7 },
    // Style/factor diversification
    { symbol: "VYM",  name: "Dividend Value (VYM)",           category: "Style",      desc: "Mature companies with stable dividends. Low correlation with growth stocks. Generates income.", targetPct: 6 },
    { symbol: "VNQ",  name: "Real Estate REITs (VNQ)",        category: "Style",      desc: "Real estate as a stock. Pays dividends from rents. Different drivers than operating companies.", targetPct: 5 },
  ];

  // Find each candidate's actual data + correlation with portfolio
  const benchmarks = macro?.benchmarks || [];

  // Compute portfolio-weighted correlation with a target symbol.
  const portfolioCorrWith = (sym) => {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const p of positions) {
      const corr = p.correlations?.[sym];
      if (corr == null || !p.value) continue;
      weightedSum += corr * p.value;
      totalWeight += p.value;
    }
    return totalWeight > 0 ? weightedSum / totalWeight : null;
  };

  // Score each candidate by Dalio's principle: low correlation = high impact
  const candidatesScored = CANDIDATES.map((c) => {
    const bench = benchmarks.find((b) => b.symbol === c.symbol);
    if (!bench) return null;
    const corr = portfolioCorrWith(c.symbol);
    const candidateVol = bench.dailyVol ?? 1.0;
    // Score: -1 corr = 100, 0 = 50, +1 = 0
    const diversificationScore = corr != null ? 50 * (1 - corr) : 50;
    // Estimate risk reduction from a 10% reallocation
    const portVol = positions.reduce((s, p) => s + (p.var95 || 0) / 1.645 * p.value, 0) / totalValue || 2.0;
    const w = 0.10;
    const newVol = Math.sqrt(
      Math.pow((1 - w) * portVol, 2) +
      Math.pow(w * candidateVol, 2) +
      2 * (1 - w) * w * (corr || 0) * portVol * candidateVol
    );
    const riskReductionPct = portVol > 0 ? ((portVol - newVol) / portVol) * 100 : 0;
    return { ...c, bench, corr, candidateVol, diversificationScore, riskReductionPct };
  }).filter(Boolean).sort((a, b) => b.diversificationScore - a.diversificationScore);

  const topPicks = candidatesScored.slice(0, 4);

  // Compute current diversification breakdown of the user's portfolio
  // Bucket each position by category (using sector field)
  const categorize = (sector) => {
    if (!sector) return "Other";
    const s = sector.toLowerCase();
    if (s.includes("semi")) return "US Semis";
    if (s.includes("hyperscaler") || s.includes("internet content")) return "US Mega Cap Tech";
    if (s.includes("ai infrastructure")) return "US AI Hardware";
    if (s.includes("ai software") || s.includes("software")) return "US Software";
    if (s.includes("cyber")) return "US Cybersecurity";
    if (s.includes("health")) return "US Healthcare";
    if (s.includes("financ")) return "US Financials";
    if (s.includes("energ")) return "US Energy";
    return "US Other";
  };

  const userBuckets = {};
  for (const p of positions) {
    const cat = categorize(p.sector);
    userBuckets[cat] = (userBuckets[cat] || 0) + p.value;
  }
  const userBucketArray = Object.entries(userBuckets)
    .map(([cat, val]) => ({ category: cat, value: val, pct: (val / totalValue) * 100 }))
    .sort((a, b) => b.pct - a.pct);

  // Cash percentage
  const totalAccount = totalValue + (cashRemaining || 0);
  const cashPct = totalAccount > 0 ? ((cashRemaining || 0) / totalAccount) * 100 : 0;
  const stocksPct = totalAccount > 0 ? (totalValue / totalAccount) * 100 : 0;

  // Equity-only "ideal" framework. This is more aggressive than All Weather since user
  // explicitly wants stock-only diversification with cash as tactical reserve.
  const EQUITY_DIVERSIFIED_TARGET = [
    { name: "Cash (tactical reserve)",     symbol: "cash",  target: 15, current: cashPct,    note: "For opportunities & sleep-well-at-night money" },
    { name: "US Mega Cap Tech (MSFT, etc)", symbol: "USTech", target: 25, current: userBuckets["US Mega Cap Tech"] ? userBuckets["US Mega Cap Tech"] / totalAccount * 100 : 0, note: "Your highest-conviction core" },
    { name: "US Semis & AI Hardware",       symbol: "USSemi", target: 15, current: ((userBuckets["US Semis"] || 0) + (userBuckets["US AI Hardware"] || 0)) / totalAccount * 100, note: "AI cycle exposure" },
    { name: "US Other Sectors (XLV, XLF, XLE, XLP)", symbol: "USOther", target: 15, current: ((userBuckets["US Healthcare"] || 0) + (userBuckets["US Financials"] || 0) + (userBuckets["US Energy"] || 0)) / totalAccount * 100, note: "Sector diversification within US" },
    { name: "International Developed (VEA, EWJ, VGK)", symbol: "Intl",   target: 15, current: 0, note: "Different cycles, cheaper valuations" },
    { name: "Emerging Markets (VWO, INDA)",  symbol: "EM",    target: 8,  current: 0, note: "Higher growth, different macro" },
    { name: "Small/Mid Cap (IWM, MDY)",      symbol: "SmallMid", target: 7, current: 0, note: "Size factor diversification" },
  ];

  const inner = (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ padding: "10px 12px", background: "#fff8e1", borderLeft: "3px solid #d4a017", marginBottom: 16, borderRadius: 2 }}>
        <div style={{ fontSize: 11, color: "#1a1f2c", lineHeight: 1.6 }}>
          <strong>Dalio's Holy Grail (equity-focused):</strong> "By owning 15-20 uncorrelated bets, you can reduce risk by 80% without sacrificing return." Below are <strong>stock-only diversifiers</strong> (no bonds, no gold) — ranked by how much they would actually reduce YOUR risk based on real correlation data.
        </div>
      </div>

      {/* Top 4 picks */}
      <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Top 4 Stock Diversifiers for Your Portfolio</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {topPicks.map((c, i) => (
          <div key={c.symbol} style={{ padding: "12px 14px", background: "#fff", border: "1px solid #efece5", borderRadius: 2, borderLeft: `4px solid ${i === 0 ? "#0a8554" : i === 1 ? "#7ba2cc" : "#86b09c"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: i === 0 ? "#0a8554" : "#1a1f2c" }}>#{i + 1}: {c.name}</span>
                  <span className="pill" style={{ background: "#f5f3ed", color: "#5a6573", fontSize: 9 }}>{c.category}</span>
                </div>
                <div style={{ fontSize: 11, color: "#5a6573", lineHeight: 1.5 }}>{c.desc}</div>
              </div>
              <div style={{ textAlign: "right", minWidth: isMobile ? "100%" : 140 }}>
                <div style={{ fontSize: 9, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Correlation w/ you</div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: c.corr < 0 ? "#0a8554" : c.corr < 0.4 ? "#86b09c" : c.corr < 0.65 ? "#d4a017" : "#c4314b", marginTop: 2 }}>
                  {c.corr != null ? (c.corr >= 0 ? "+" : "") + c.corr.toFixed(2) : "—"}
                </div>
                <div style={{ fontSize: 10, color: "#5a6573", marginTop: 2 }}>{c.corr < 0 ? "Inversely tied 🎯" : c.corr < 0.4 ? "Low correlation ✓" : c.corr < 0.65 ? "Some correlation" : "High correlation"}</div>
                <div style={{ fontSize: 10, color: "#0a8554", marginTop: 4, fontWeight: 600 }}>~{c.riskReductionPct.toFixed(0)}% risk reduction</div>
                <div style={{ fontSize: 9, color: "#8a93a3", marginTop: 1 }}>(at 10% allocation)</div>
              </div>
            </div>
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dotted #efece5", fontSize: 11, color: "#5a6573" }}>
              <strong style={{ color: "#1a1f2c" }}>Suggested allocation:</strong> ~{c.targetPct}% = <span className="mono">${formatMcap(totalAccount * c.targetPct / 100)}</span>
              {cashRemaining > 0 && <span> · You have <span className="mono">${formatMcap(cashRemaining)}</span> in cash</span>}
            </div>
          </div>
        ))}
      </div>

      {/* All candidates table (compact) */}
      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: "pointer", fontSize: 11, color: "#5a6573", fontWeight: 600, padding: "6px 0" }}>Show all {candidatesScored.length} ranked candidates</summary>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", minWidth: 540 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e6e3db", color: "#8a93a3" }}>
                <th style={{ padding: "5px 8px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>ETF</th>
                <th style={{ padding: "5px 8px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Category</th>
                <th style={{ padding: "5px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Corr w/ you</th>
                <th style={{ padding: "5px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Risk ↓</th>
                <th style={{ padding: "5px 8px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Daily Vol</th>
              </tr>
            </thead>
            <tbody>
              {candidatesScored.map((c) => (
                <tr key={c.symbol} style={{ borderBottom: "1px dotted #efece5" }}>
                  <td className="mono" style={{ padding: "5px 8px", fontWeight: 600 }}>{c.symbol}</td>
                  <td style={{ padding: "5px 8px", fontSize: 10, color: "#5a6573" }}>{c.category}</td>
                  <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: c.corr < 0.4 ? "#0a8554" : c.corr < 0.65 ? "#d4a017" : "#c4314b" }}>{c.corr != null ? (c.corr >= 0 ? "+" : "") + c.corr.toFixed(2) : "—"}</td>
                  <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: c.riskReductionPct > 10 ? "#0a8554" : "#1a1f2c" }}>{c.riskReductionPct.toFixed(0)}%</td>
                  <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#5a6573" }}>{c.candidateVol.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* Diversified Equity Framework comparison */}
      <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Your Allocation vs Diversified Equity Framework</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
        {EQUITY_DIVERSIFIED_TARGET.map((row) => {
          const gap = row.target - row.current;
          const overTarget = row.current > row.target;
          return (
            <div key={row.symbol}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: isMobile ? 140 : 220, fontSize: 11, color: "#5a6573", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
                <div style={{ flex: 1, height: 16, background: "#efece5", borderRadius: 2, position: "relative" }}>
                  <div style={{ width: `${Math.min(row.target, 100)}%`, height: "100%", background: "#d6d2c7", borderRadius: 2 }} />
                  <div style={{ position: "absolute", top: 0, left: 0, width: `${Math.min(row.current, 100)}%`, height: "100%", background: overTarget ? "#c4314b" : "#0a8554", borderRadius: 2, opacity: 0.85 }} />
                </div>
                <span className="mono" style={{ width: 90, textAlign: "right", fontSize: 10, color: "#5a6573", flexShrink: 0 }}>
                  <span style={{ color: overTarget ? "#c4314b" : "#0a8554", fontWeight: 600 }}>{row.current.toFixed(0)}%</span> / <span style={{ color: "#8a93a3" }}>{row.target}%</span>
                </span>
              </div>
              <div style={{ marginLeft: isMobile ? 0 : 220, fontSize: 9, color: "#8a93a3", marginTop: 1, marginBottom: 3 }}>{row.note}</div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: 10, background: "#f5f3ed", fontSize: 11, color: "#5a6573", lineHeight: 1.6, borderRadius: 2 }}>
        <strong>The framework:</strong> Equity-only diversification with cash as the tactical reserve. Gray bar = target. Color = your current. Green = below target (room to add). Red = above target (consider trimming). This framework is more aggressive than Dalio's All Weather — designed for someone with 10+ year horizon who wants growth but with proper geographic & sector spread.
      </div>

      <div style={{ marginTop: 12, padding: 10, background: "#fff8e1", borderLeft: "3px solid #d4a017", fontSize: 11, color: "#5a6573", lineHeight: 1.6, borderRadius: 2 }}>
        <strong>Practical note:</strong> You don't have to hit every target. Even adding ONE uncorrelated piece (say, 10% in VEA international) reduces portfolio risk meaningfully. The "Holy Grail" effect is steepest with the first few additions — the 10th uncorrelated asset adds less than the 2nd. Start with the top pick above and see how your dashboard's risk numbers change.
      </div>
    </div>
  );

  if (embedded) return inner;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Diversification Suggestions · Stock-Focused</span>
        <Target size={13} color="#d4a017" />
      </div>
      {inner}
    </div>
  );
}

// ============================================================
// MACRO STRESS TEST — what happens to portfolio in scripted scenarios
// ============================================================
function MacroStressPanel({ positions, totalValue, isMobile, embedded }) {
  if (!totalValue) return null;
  // Scenarios: each defines a shock to a macro asset and we use stock correlations to estimate impact
  const scenarios = [
    {
      key: "rates_up_100bps",
      title: "Rates spike +100bps",
      detail: "10Y Treasury yield rises 1 percentage point. Growth stocks typically compress as discount rates rise.",
      macroSymbol: "^TNX",
      // 100bps move on TNX is roughly +25% in TNX index value historically. Use simpler: assume ~5% market move down for full correlation = -1.
      macroMovePct: 25, // ^TNX index change
      color: "#c4314b",
    },
    {
      key: "vix_spike_30",
      title: "VIX spikes to 30",
      detail: "From current ~18 to 30. Typically a -7% to -10% market move triggering this. Tech and high-beta sell off hardest.",
      macroSymbol: "^VIX",
      macroMovePct: 67,  // VIX 18 → 30 = +67%
      color: "#c4314b",
    },
    {
      key: "spy_minus_10",
      title: "Broad market -10%",
      detail: "S&P 500 declines 10%. Standard correction. Higher-beta stocks fall more.",
      macroSymbol: "SPY",
      macroMovePct: -10,
      color: "#d4a017",
    },
    {
      key: "soxx_minus_15",
      title: "Semis crash -15%",
      detail: "Semiconductor ETF declines 15%. Hits NVDA, AMD, TSM, MU directly. Triggered by chip cycle, China policy, or AI bubble fears.",
      macroSymbol: "SOXX",
      macroMovePct: -15,
      color: "#c4314b",
    },
    {
      key: "dollar_surge",
      title: "Dollar surge +5%",
      detail: "DXY rallies 5%. Hurts multinationals' overseas revenue. Helps domestics.",
      macroSymbol: "DX-Y.NYB",
      macroMovePct: 5,
      color: "#7ba2cc",
    },
  ];

  // For each scenario, sum across positions: position_value × correlation × macro_move
  const results = scenarios.map((sc) => {
    let totalImpact = 0;
    let coveredValue = 0;
    for (const p of positions) {
      const corr = p.correlations?.[sc.macroSymbol];
      if (corr == null || !p.value) continue;
      // Beta-adjusted estimate. For ETFs ^TNX and ^VIX, we treat their pct change as a "rates/vol move".
      // For SPY/SOXX/DXY, we treat their pct change as a price move that scales by correlation.
      // Use a damping factor for ^TNX/^VIX because correlation isn't beta — actual transmission is partial.
      const damping = (sc.macroSymbol === "^TNX" || sc.macroSymbol === "^VIX") ? 0.4 : 1.0;
      const stockMovePct = corr * sc.macroMovePct * damping;
      totalImpact += p.value * (stockMovePct / 100);
      coveredValue += p.value;
    }
    const coveragePct = totalValue > 0 ? (coveredValue / totalValue) * 100 : 0;
    return { ...sc, dollarImpact: totalImpact, pctImpact: totalValue > 0 ? (totalImpact / totalValue) * 100 : 0, coveragePct };
  });

  const inner = (
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 12, color: "#1a1f2c", lineHeight: 1.6, marginBottom: 14 }}>
          Estimated portfolio impact in different stress scenarios. Uses each position's 30-day correlation with macro assets. <strong>Approximate, not exact</strong> — actual market events vary.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {results.map((r) => {
            const isLoss = r.dollarImpact < 0;
            return (
              <div key={r.key} style={{ padding: "10px 12px", background: "#fff", border: "1px solid #efece5", borderRadius: 2, borderLeft: `3px solid ${r.color}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: "#1a1f2c", marginBottom: 3 }}>{r.title}</div>
                    <div style={{ fontSize: 11, color: "#5a6573", lineHeight: 1.5 }}>{r.detail}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: isLoss ? "#c4314b" : "#0a8554" }}>
                      {isLoss ? "-" : "+"}${formatMcap(Math.abs(r.dollarImpact))}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "#5a6573" }}>{r.pctImpact >= 0 ? "+" : ""}{r.pctImpact.toFixed(1)}% of portfolio</div>
                    {r.coveragePct < 100 && <div style={{ fontSize: 9, color: "#8a93a3", marginTop: 2 }}>{r.coveragePct.toFixed(0)}% positions covered</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, padding: 10, background: "#fff8e1", borderLeft: "3px solid #d4a017", fontSize: 11, color: "#5a6573", lineHeight: 1.6, borderRadius: 2 }}>
          <strong>Caveats:</strong> These are linear approximations based on recent correlations. Real shocks can be non-linear — when VIX spikes 60%, correlations between stocks themselves spike too ("everything goes down together"), making losses larger than this model suggests. Use as a rough sanity check, not as a forecast.
        </div>
      </div>
  );

  if (embedded) return inner;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Macro Stress Test · How Your Portfolio Reacts to Shocks</span>
        <Activity size={13} color="#d4a017" />
      </div>
      {inner}
    </div>
  );
}

// Position sizing table — pulls VaR from watchlist tickers
function PositionSizingTable({ accountSize, riskBudget, isMobile }) {
  const [tickers, setTickers] = useState([]);
  useEffect(() => {
    fetch(`${BASE}data/index.json?v=${Date.now()}`)
      .then((r) => r.json())
      .then((idx) => {
        // Get top tickers - holdings first, then a sample of others
        const holdings = idx.tickers.filter((t) => t.holding);
        const others = idx.tickers.filter((t) => !t.holding).slice(0, 8);
        const sample = [...holdings, ...others];
        // Fetch detail for each
        return Promise.all(sample.map((t) =>
          fetch(`${BASE}data/${t.symbol}.json?v=${Date.now()}`).then((r) => r.ok ? r.json() : null).catch(() => null)
        ));
      })
      .then((all) => {
        const rows = all.filter(Boolean).map((d) => ({
          symbol: d.symbol,
          price: d.quote?.current,
          var95: d.simons?.var95daily,
          holding: !!d.holding,
        })).filter((r) => r.var95 != null && r.price);
        setTickers(rows);
      })
      .catch(() => {});
  }, []);

  if (!tickers.length) return <div style={{ fontSize: 11, color: "#8a93a3" }}>Loading...</div>;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", minWidth: 500 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #e6e3db", color: "#8a93a3" }}>
            <th style={{ padding: "6px 10px", textAlign: "left", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Ticker</th>
            <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Price</th>
            <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Daily VaR</th>
            <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Max position $</th>
            <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>Max shares</th>
            <th style={{ padding: "6px 10px", textAlign: "right", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 500 }}>% of acct</th>
          </tr>
        </thead>
        <tbody>
          {tickers.map((t) => {
            const maxPositionValue = riskBudget / (t.var95 / 100); // budget / VaR% = position $
            const maxShares = Math.floor(maxPositionValue / t.price);
            const pctOfAccount = (maxPositionValue / accountSize) * 100;
            return (
              <tr key={t.symbol} style={{ borderBottom: "1px dotted #efece5", background: t.holding ? "#fffdf4" : "transparent" }}>
                <td className="mono" style={{ padding: "6px 10px", fontWeight: 600 }}>{t.symbol}{t.holding ? " ★" : ""}</td>
                <td className="mono" style={{ padding: "6px 10px", textAlign: "right" }}>${fmt(t.price, 2)}</td>
                <td className="mono" style={{ padding: "6px 10px", textAlign: "right", color: "#c4314b" }}>-{fmt(t.var95, 2)}%</td>
                <td className="mono" style={{ padding: "6px 10px", textAlign: "right", fontWeight: 500 }}>${formatMcap(maxPositionValue)}</td>
                <td className="mono" style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600 }}>{maxShares}</td>
                <td className="mono" style={{ padding: "6px 10px", textAlign: "right", color: pctOfAccount > 30 ? "#c4314b" : pctOfAccount > 15 ? "#d4a017" : "#0a8554" }}>{pctOfAccount.toFixed(0)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// OPTIONS FLOW PANEL
// ============================================================
function OptionsFlowPanel({ op, isMobile }) {
  const pcrV = op.pcrVolume;
  let pcrInterp = "—"; let pcrColor = "#5a6573"; let pcrPlain = "—";
  if (pcrV != null) {
    if (pcrV < 0.7) {
      pcrInterp = "BULLISH (calls dominating)"; pcrColor = "#0a8554";
      pcrPlain = "Traders are buying many more calls than puts. Often a bullish signal, but extremely low values (PCR < 0.5) can be a contrarian warning that the crowd is too euphoric.";
    } else if (pcrV > 1.2) {
      pcrInterp = "BEARISH (puts dominating)"; pcrColor = "#c4314b";
      pcrPlain = "Traders are buying many more puts than calls. Could mean fear, but contrarians watch for extremes (PCR > 1.5) as a buy signal — when everyone is hedged, the worst is often priced in.";
    } else {
      pcrInterp = "Neutral"; pcrColor = "#5a6573";
      pcrPlain = "Roughly balanced put and call activity. No strong directional signal from options flow.";
    }
  }

  const skew = op.skew;
  let skewInterp = "—"; let skewColor = "#5a6573"; let skewPlain = "—";
  if (skew != null) {
    if (skew > 5) {
      skewInterp = "FEAR pricing"; skewColor = "#c4314b";
      skewPlain = "OTM puts are much more expensive than OTM calls. The market is pricing in downside risk. This is normal for indices and large caps; very high skew can signal heightened tail-risk worry.";
    } else if (skew < -2) {
      skewInterp = "GREED pricing"; skewColor = "#0a8554";
      skewPlain = "OTM calls cost more than OTM puts. Rare and bullish — speculators are paying up for upside, often seen in hot growth names.";
    } else {
      skewInterp = "Normal"; skewColor = "#1a1f2c";
      skewPlain = "Moderate fear premium typical of most US stocks. No unusual positioning.";
    }
  }

  // Prefer long-dated ATM IV (~30 days) for stability. Short-dated collapses near expiry.
  const ivDisplay = op.ivATMLong ?? op.ivATM;
  const ivDisplayDays = op.ivATMLong != null ? op.ivATMLongDays : op.daysToExpiry;
  let ivPlain = "—";
  if (ivDisplay != null) {
    if (ivDisplay > 60) ivPlain = "Very high implied volatility — options are expensive. Often happens before earnings or after big moves. Good for sellers, bad for buyers.";
    else if (ivDisplay > 35) ivPlain = "Elevated implied volatility. Market expects bigger-than-normal moves.";
    else if (ivDisplay < 20) ivPlain = "Low implied volatility — options are cheap. Market expects calm. Good time to buy options if you expect a move.";
    else ivPlain = "Normal implied volatility for a US large cap.";
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head" style={{ flexWrap: "wrap", gap: 4 }}>
        <span className="panel-title">Options Flow · What Traders Are Betting</span>
        <span className="mono" style={{ fontSize: 10, color: "#5a6573", whiteSpace: "nowrap" }}>
          {op.expiry ? `${op.expiry} (${op.daysToExpiry}d)` : ""}
          <Zap size={11} color="#d4a017" style={{ display: "inline", marginLeft: 6, verticalAlign: "middle" }} />
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 0 }}>
        <div style={{ padding: "14px 16px", borderRight: isMobile ? "none" : "1px solid #efece5", borderBottom: "1px solid #efece5" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Put / Call Ratio</div>
          <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "flex-start" : "baseline", justifyContent: "space-between", gap: 6, marginBottom: 6 }}>
            <span className="mono" style={{ fontSize: 24, fontWeight: 600, color: pcrColor }}>{fmt(pcrV, 2)}</span>
            <span className="pill" style={{ background: pcrColor, color: "#fff", maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pcrInterp}</span>
          </div>
          <div style={{ fontSize: 11, color: "#5a6573", marginBottom: 10, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 4 }}>
            <span><span style={{ color: "#0a8554" }}>●</span> Call vol: {formatMcap(op.callVolTotal)}</span>
            <span><span style={{ color: "#c4314b" }}>●</span> Put vol: {formatMcap(op.putVolTotal)}</span>
          </div>
          <ExplainBox text={pcrPlain} />
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dotted #e6e3db" }}>
            <StatRow label="P/C Ratio (Open Interest)" value={<span className="mono">{fmt(op.pcrOI, 2)}</span>} />
            <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 4, lineHeight: 1.4 }}>
              <em>Open interest counts all existing contracts (positioning over time), volume counts today's trades (today's intent).</em>
            </div>
          </div>
        </div>

        <div style={{ padding: "14px 16px", borderBottom: "1px solid #efece5" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Implied Volatility & Skew</div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div style={{ gridColumn: isMobile ? "1 / -1" : "auto" }}>
              <div style={{ fontSize: 9, color: "#8a93a3", marginBottom: 2 }} title="Annualized implied volatility, read from the ~30-day option chain (more stable than short-dated).">ATM IV (annualized)</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{fmt(ivDisplay, 1)}%</div>
              <div style={{ fontSize: 9, color: "#8a93a3", marginTop: 2 }}>
                {ivDisplayDays != null ? `from ${ivDisplayDays}d chain` : ""}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#8a93a3", marginBottom: 2 }}>OTM Put IV</div>
              <div className="mono" style={{ fontSize: 16, color: "#c4314b" }}>{fmt(op.ivOTMPut, 1)}%</div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#8a93a3", marginBottom: 2 }}>OTM Call IV</div>
              <div className="mono" style={{ fontSize: 16, color: "#0a8554" }}>{fmt(op.ivOTMCall, 1)}%</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center", gap: 6, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: "#5a6573" }}>Skew (Put IV − Call IV):</span>
            <span className="pill" style={{ background: skewColor, color: "#fff", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fmt(skew, 1)} pts · {skewInterp}</span>
          </div>
          <ExplainBox text={skewPlain} />
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dotted #e6e3db" }}>
            <ExplainBox text={`Implied Volatility = "${ivPlain}"`} />
          </div>
        </div>

        {op.expectedMove && (
          <div style={{ padding: "14px 16px", gridColumn: isMobile ? "1" : "1 / -1", borderBottom: "1px solid #efece5", background: "#fffdf4" }}>
            <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Expected Move (1 standard deviation)</div>
            <div style={{ fontSize: 13, color: "#1a1f2c", lineHeight: 1.6, marginBottom: 8 }}>
              The options market is pricing a <strong>±${fmt(op.expectedMove.dollar, 2)} (~{fmt(op.expectedMove.pct, 1)}%)</strong> move over the next <strong>{op.expectedMove.days} day{op.expectedMove.days === 1 ? "" : "s"}</strong>.
              <br />
              <span className="mono" style={{ fontSize: 12 }}>
                Expected range: <span style={{ color: "#c4314b" }}>${fmt(op.expectedMove.low, 2)}</span> — <span style={{ color: "#0a8554" }}>${fmt(op.expectedMove.high, 2)}</span>
              </span>
            </div>
            <ExplainBox text={`This is what the options market is "betting" on. The stock has roughly a 68% chance of finishing within this range and a 32% chance of moving more. Around earnings or big events, expected moves widen. If the stock moves more than this, you're outside what was priced in.`} /></div>
        )}

        {op.skewCurve?.length >= 3 && (
          <div style={{ padding: "14px 16px", gridColumn: isMobile ? "1" : "1 / -1", borderBottom: "1px solid #efece5", minWidth: 0 }}>
            <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Volatility Smile (IV across strikes)</div>
            <div style={{ width: "100%", overflow: "hidden" }}>
              <ResponsiveContainer width="100%" height={isMobile ? 140 : 180}>
                <LineChart data={op.skewCurve} margin={{ top: 8, right: isMobile ? 8 : 30, left: isMobile ? 0 : 0, bottom: 4 }}>
                  <XAxis dataKey="moneyness" tick={{ fontSize: 10, fill: "#8a93a3" }} stroke="#e6e3db"
                    interval={isMobile ? "preserveStartEnd" : "preserveEnd"}
                    label={{ value: isMobile ? "% from spot" : "% from current price", position: "insideBottom", offset: -2, fontSize: 10, fill: "#5a6573" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={isMobile ? 32 : 40}
                    label={{ value: "IV %", angle: 0, position: "insideTopRight", fontSize: 9, fill: "#5a6573" }} />
                  <ReferenceLine x={0} stroke="#1a1f2c" strokeDasharray="3 3" strokeWidth={0.8} label={{ value: "ATM", fontSize: 9, fill: "#1a1f2c" }} />
                  <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }}
                    formatter={(value, name) => [`${value}%`, "IV"]}
                    labelFormatter={(label) => `${label > 0 ? "+" : ""}${label}% from spot`} />
                  <Line type="monotone" dataKey="iv" stroke="#d4a017" strokeWidth={2} dot={{ fill: "#d4a017", r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <ExplainBox text="Each dot is an option strike. A U-shape ('smile') means OTM options on both sides cost more — typical. A downward slope to the right ('smirk') means puts are pricier than calls — the market is pricing fear of downside." />
          </div>
        )}

        <div style={{ padding: "14px 16px", gridColumn: isMobile ? "1" : "1 / -1" }}>
          {(() => {
            // Calculate dollar flow for each row and find the highlights
            const enrichedStrikes = op.topStrikes.map((s) => ({
              ...s,
              dollarFlow: (s.lastPrice != null && s.volume) ? s.lastPrice * 100 * s.volume : 0,
              breakeven: s.lastPrice != null ? (s.type === "CALL" ? s.strike + s.lastPrice : s.strike - s.lastPrice) : null,
              contractCost: s.lastPrice != null ? s.lastPrice * 100 : null,
            }));
            const mostVolume = [...enrichedStrikes].sort((a, b) => b.volume - a.volume)[0];
            const mostDollars = [...enrichedStrikes].sort((a, b) => b.dollarFlow - a.dollarFlow)[0];
            const biggestFresh = [...enrichedStrikes].filter((x) => x.unusual).sort((a, b) => b.dollarFlow - a.dollarFlow)[0];
            const totalCallDollars = enrichedStrikes.filter((x) => x.type === "CALL").reduce((s, x) => s + x.dollarFlow, 0);
            const totalPutDollars = enrichedStrikes.filter((x) => x.type === "PUT").reduce((s, x) => s + x.dollarFlow, 0);
            const callPutBias = totalCallDollars + totalPutDollars > 0 ? totalCallDollars / (totalCallDollars + totalPutDollars) * 100 : 50;

            const HighlightCard = ({ label, item, color }) => (
              <div style={{ flex: isMobile ? "1 1 100%" : "1 1 180px", minWidth: 0, padding: "10px 12px", background: "#fff", border: `1px solid ${color}`, borderRadius: 2, borderLeft: `4px solid ${color}` }}>
                <div style={{ fontSize: 9, color: "#8a93a3", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4, fontWeight: 600, wordBreak: "break-word" }}>{label}</div>
                {item ? (
                  <>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: item.type === "CALL" ? "#0a8554" : "#c4314b" }}>
                      {item.type} ${fmt(item.strike, 0)}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "#5a6573", marginTop: 2 }}>
                      {formatMcap(item.volume)} contracts · <strong>${formatMcap(item.dollarFlow)} flow</strong>
                    </div>
                    <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 4, lineHeight: 1.4 }}>
                      {item.type === "CALL" ? "Bet stock rises above" : "Bet stock falls below"} <strong>${fmt(item.breakeven, 2)}</strong> by {op.expiry || "expiry"}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: "#8a93a3" }}>None</div>
                )}
              </div>
            );

            return (
              <>
                <div className="panel-title" style={{ fontSize: 10, marginBottom: 10 }}>Smart Summary · The 3 Biggest Bets</div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                  <HighlightCard label="Most Contracts" item={mostVolume} color="#7ba2cc" />
                  <HighlightCard label="Most Money Flowing" item={mostDollars} color="#d4a017" />
                  <HighlightCard label="Biggest Fresh Bet (UNUSUAL)" item={biggestFresh} color="#0a8554" />
                </div>

                <div style={{ padding: "10px 12px", background: "#f5f3ed", borderRadius: 2, marginBottom: 14, fontSize: 11, color: "#1a1f2c", lineHeight: 1.6 }}>
                  <strong>Dollar Bias:</strong> Of all dollars flowing into the top 8 active strikes, <strong style={{ color: "#0a8554" }}>{fmt(callPutBias, 0)}% went to CALLS</strong> and <strong style={{ color: "#c4314b" }}>{fmt(100 - callPutBias, 0)}% to PUTS</strong>. Total call dollars: <strong>${formatMcap(totalCallDollars)}</strong>. Total put dollars: <strong>${formatMcap(totalPutDollars)}</strong>.
                  {callPutBias > 80 && <span> ⚠️ Heavily one-sided bullish positioning — contrarians watch for this as a potential local top.</span>}
                  {callPutBias < 20 && <span> ⚠️ Heavily one-sided bearish positioning — contrarians watch for this as a potential bottom.</span>}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                  <div className="panel-title" style={{ fontSize: 10 }}>Most Active Strikes Today (Full Detail)</div>
                  <div className="mono" style={{ fontSize: 10, color: "#5a6573" }}>
                    All contracts below expire on <strong style={{ color: "#1a1f2c" }}>{op.expiry || "—"}</strong>
                    {op.daysToExpiry != null && <span> ({op.daysToExpiry > 0 ? `${op.daysToExpiry} days from now` : op.daysToExpiry === 0 ? "TODAY" : "expired"})</span>}
                  </div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 720 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #e6e3db" }}>
                        <th style={{ padding: "6px 8px", textAlign: "left", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="CALL = bet stock goes UP. PUT = bet stock goes DOWN.">Type</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="The target price.">Strike</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="Stock price needed at expiry to break even.">Breakeven</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="Contracts traded today.">Volume</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="Open Interest.">OI</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="Implied Volatility.">IV %</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="Cost per share.">Last</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }} title="One contract = 100 shares.">$/Contract</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", background: "#fff8e1" }} title="Today's dollar flow = Volume × $/Contract.">Total $ Today</th>
                        <th style={{ padding: "6px 8px", textAlign: "center", color: "#8a93a3", fontWeight: 500, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase" }}>Flag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enrichedStrikes.map((s, i) => (
                        <tr key={i} style={{ borderBottom: "1px dotted #efece5", background: s.unusual ? "#fffdf4" : "transparent" }}>
                          <td style={{ padding: "5px 8px" }}><span className="mono" style={{ fontWeight: 600, color: s.type === "CALL" ? "#0a8554" : "#c4314b" }}>{s.type}</span></td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>${fmt(s.strike, 0)}</td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#5a6573" }}>${fmt(s.breakeven, 2)}</td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>{formatMcap(s.volume)}</td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#8a93a3" }}>{formatMcap(s.openInterest)}</td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>{fmt(s.iv, 0)}</td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>${fmt(s.lastPrice, 2)}</td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>${s.contractCost != null ? formatMcap(s.contractCost) : "—"}</td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right", fontWeight: 600, background: "#fff8e1", color: s.type === "CALL" ? "#0a8554" : "#c4314b" }}>${formatMcap(s.dollarFlow)}</td>
                          <td style={{ padding: "5px 8px", textAlign: "center" }}>
                            {s.unusual && <span className="pill" style={{ background: "#d4a017", color: "#1a1f2c" }}>UNUSUAL</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 10 }}>
                  <ExplainBox text={`Reading order: (1) Smart Summary tells you the answers. (2) The Total $ Today column shows real money flow per strike (volume × cost). (3) UNUSUAL flagged rows (yellow-tinted) are fresh positions being opened, not just existing positions being adjusted. The dollar bias percentage above tells you whether the crowd is betting up (calls) or down (puts) with their money — not just their contract count.`} />
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

const ExplainBox = ({ text }) => (
  <div style={{ padding: 8, background: "#fff8e1", borderLeft: "3px solid #d4a017", borderRadius: 2, fontSize: 11, color: "#5a6573", lineHeight: 1.5, wordBreak: "break-word", overflowWrap: "break-word", whiteSpace: "normal" }}>
    {text}
  </div>
);

// ============================================================
// LYNCH PANEL
// ============================================================
function LynchPanel({ ly, f, isMobile }) {
  const peg = ly.pegRatio ?? f.peg;
  const insiderNet = ly.netInsiderActivity;
  const insiderColor = insiderNet > 0 ? "#0a8554" : insiderNet < 0 ? "#c4314b" : "#5a6573";
  const cashDebtRatio = f.totalCash && f.totalDebt ? f.totalCash / f.totalDebt : null;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Peter Lynch · Fundamental Lens</span>
        <span className="pill" style={{ background: "#d4a017", color: "#1a1f2c" }}>{ly.category}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 0 }}>
        <div style={{ padding: "12px 14px", borderRight: isMobile ? "none" : "1px solid #efece5", borderBottom: isMobile ? "1px solid #efece5" : "none" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Growth & Valuation</div>
          <StatRow label="PEG (Lynch's pick)" value={<span className="mono" style={{ color: peg && peg < 1 ? "#0a8554" : peg > 2 ? "#c4314b" : "#1a1f2c", fontWeight: 600 }}>{fmt(peg, 2)}</span>} />
          <StatRow label="EPS Growth (Next Yr)" value={<span className="mono" style={{ color: colorFor(ly.epsGrowthNextYr) }}>{ly.epsGrowthNextYr != null ? pct(ly.epsGrowthNextYr) : "—"}</span>} />
          <StatRow label="EPS Growth (5 Yr)" value={<span className="mono" style={{ color: colorFor(ly.epsGrowth5Yr) }}>{ly.epsGrowth5Yr != null ? pct(ly.epsGrowth5Yr) : "—"}</span>} />
          <StatRow label="EPS Stability (CV)" value={<span className="mono" title="Coefficient of variation. Lower = more stable.">{ly.epsCoefVar != null ? `${fmt(ly.epsCoefVar, 2)}${ly.epsCoefVar < 0.3 ? " ✓" : ""}` : "—"}</span>} />
          <StatRow label="Rev Growth (TTM)" value={<span className="mono" style={{ color: colorFor(f.revGrowth) }}>{f.revGrowth != null ? pct(f.revGrowth) : "—"}</span>} />
        </div>
        <div style={{ padding: "12px 14px", borderRight: isMobile ? "none" : "1px solid #efece5", borderBottom: isMobile ? "1px solid #efece5" : "none" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Balance Sheet</div>
          <StatRow label="Debt/Equity" value={<span className="mono" style={{ color: f.debtEq != null && f.debtEq < 0.5 ? "#0a8554" : f.debtEq > 1.5 ? "#c4314b" : "#1a1f2c" }}>{fmt(f.debtEq, 2)}</span>} />
          <StatRow label="Current Ratio" value={<span className="mono" style={{ color: f.currentRatio && f.currentRatio > 1.5 ? "#0a8554" : f.currentRatio < 1 ? "#c4314b" : "#1a1f2c" }}>{fmt(f.currentRatio, 2)}</span>} />
          <StatRow label="Quick Ratio" value={<span className="mono">{fmt(f.quickRatio, 2)}</span>} />
          <StatRow label="Cash" value={<span className="mono">{f.totalCash ? formatMcap(f.totalCash) : "—"}</span>} />
          <StatRow label="Total Debt" value={<span className="mono">{f.totalDebt ? formatMcap(f.totalDebt) : "—"}</span>} />
          <StatRow label="Cash/Debt" value={<span className="mono" style={{ color: cashDebtRatio > 1 ? "#0a8554" : cashDebtRatio < 0.3 ? "#c4314b" : "#1a1f2c" }}>{fmt(cashDebtRatio, 2)}</span>} />
          <StatRow label="Free Cash Flow" value={<span className="mono" style={{ color: f.freeCashflow > 0 ? "#0a8554" : "#c4314b" }} title="Cash generated by operations after capex. The 'owner earnings' that matter most to Buffett-style investors.">{f.freeCashflow ? formatMcap(f.freeCashflow) : "—"}</span>} />
          <StatRow label="FCF Yield" value={<span className="mono" style={{ color: f.fcfYield > 5 ? "#0a8554" : f.fcfYield < 1 ? "#c4314b" : "#1a1f2c" }} title="FCF / Market Cap. >5% = generous, <2% = paying premium.">{f.fcfYield != null ? fmt(f.fcfYield, 2) + "%" : "—"}</span>} />
        </div>
        <div style={{ padding: "12px 14px" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Insider & Ownership</div>
          <StatRow label="Insiders %" value={<span className="mono">{ly.heldByInsiders != null ? fmt(ly.heldByInsiders * 100, 2) + "%" : "—"}</span>} />
          <StatRow label="Institutions %" value={<span className="mono">{ly.heldByInstitutions != null ? fmt(ly.heldByInstitutions * 100, 1) + "%" : "—"}</span>} />
          <StatRow label="Insider Buys (6M)" value={<span className="mono" style={{ color: ly.insiderBuys > ly.insiderSells ? "#0a8554" : "#1a1f2c" }}>{ly.insiderBuys ?? 0}</span>} />
          <StatRow label="Insider Sells (6M)" value={<span className="mono">{ly.insiderSells ?? 0}</span>} />
          <StatRow label="Net Insider $" value={<span className="mono" style={{ color: insiderColor, fontWeight: 600 }}>{ly.netInsiderActivity ? (ly.netInsiderActivity > 0 ? "+" : "") + formatMcap(Math.abs(ly.netInsiderActivity)) : "—"}</span>} />
          <StatRow label="SBC % of Revenue" value={<span className="mono" style={{ color: ly.sbcPctRevenue == null ? "#1a1f2c" : ly.sbcPctRevenue > 10 ? "#c4314b" : ly.sbcPctRevenue > 5 ? "#d4a017" : "#0a8554" }} title="Stock-based compensation as % of revenue. <5% = lean. 5-10% = typical tech. >10% = high dilution.">{ly.sbcPctRevenue != null ? fmt(ly.sbcPctRevenue, 1) + "%" : "—"}</span>} />
          <StatRow label="Short Ratio" value={<span className="mono" style={{ color: ly.shortRatio > 5 ? "#c4314b" : "#1a1f2c" }}>{fmt(ly.shortRatio, 2)}</span>} />
          <StatRow label="Short % Float" value={<span className="mono" style={{ color: ly.shortPctFloat > 0.1 ? "#c4314b" : "#1a1f2c" }}>{ly.shortPctFloat != null ? fmt(ly.shortPctFloat * 100, 2) + "%" : "—"}</span>} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SIMONS PANEL
// ============================================================
// ============================================================
// CORRELATIONS PANEL — what's really driving this stock day-to-day
// ============================================================
function CorrelationsPanel({ correlations, symbol, isMobile }) {
  const labelMap = {
    "^TNX": "10Y Yield", "^VIX": "VIX", "DX-Y.NYB": "Dollar", "SPY": "S&P 500",
    "QQQ": "Nasdaq-100", "SOXX": "Semis", "TLT": "Bonds (20Y)",
  };
  const items = Object.entries(correlations || {}).map(([k, v]) => ({ key: k, label: labelMap[k] || k, value: v }));
  items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  if (!items.length) return null;
  const colorFor = (v) => v > 0.7 ? "#0a8554" : v > 0.3 ? "#86b09c" : v > -0.3 ? "#5a6573" : v > -0.7 ? "#e89aa6" : "#c4314b";
  const interpret = (v) => v > 0.7 ? "strongly tied" : v > 0.3 ? "moves with" : v > -0.3 ? "uncorrelated" : v > -0.7 ? "inversely tied" : "strongly inverse";
  const top = items[0];
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Cross-Asset Correlations · What Drives This Stock</span>
        <span className="mono" style={{ fontSize: 10, color: "#5a6573" }}>30-day</span>
      </div>
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 12, color: "#1a1f2c", marginBottom: 12, lineHeight: 1.5 }}>
          Over the last 30 days, <strong>{symbol}</strong> has been most {interpret(top.value).toLowerCase()} with <strong>{top.label}</strong> ({top.value > 0 ? "+" : ""}{top.value.toFixed(2)}). This is what really moves the stock day-to-day.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)", gap: 6 }}>
          {items.map((item) => {
            const pct = Math.abs(item.value) * 100;
            const isNeg = item.value < 0;
            return (
              <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <span style={{ width: 100, fontSize: 11, color: "#5a6573", flexShrink: 0 }}>{item.label}</span>
                <div style={{ flex: 1, height: 14, position: "relative", background: "#efece5", borderRadius: 2 }}>
                  <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "#5a6573" }} />
                  <div style={{ position: "absolute", left: isNeg ? `${50 - pct/2}%` : "50%", width: `${pct/2}%`, top: 1, bottom: 1, background: colorFor(item.value), borderRadius: 2 }} />
                </div>
                <span className="mono" style={{ width: 50, textAlign: "right", fontSize: 11, fontWeight: 600, color: colorFor(item.value), flexShrink: 0 }}>{item.value > 0 ? "+" : ""}{item.value.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10, padding: 8, background: "#fff8e1", borderLeft: "3px solid #d4a017", borderRadius: 2, fontSize: 11, color: "#5a6573", lineHeight: 1.5 }}>
          +1.0 = moves perfectly with that asset. -1.0 = moves perfectly opposite. ±0.3 to 0.7 = meaningful linkage. Negative correlation with rates (10Y, Bonds) is typical for growth stocks: when rates rise, growth falls.
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SIMONS PANEL
// ============================================================
function SimonsPanel({ sm, isMobile }) {
  const dowNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <span className="panel-title">Simons-Style · Statistical Edge</span>
        <BarChart3 size={13} color="#d4a017" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 0 }}>
        <div style={{ padding: "12px 14px", borderRight: isMobile ? "none" : "1px solid #efece5", borderBottom: isMobile ? "1px solid #efece5" : "none" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Autocorrelation (returns)</div>
          <StatRow label="Lag-1" value={<span className="mono" title="Short-term return correlation. Negative = mean-reverting day-to-day.">{fmt(sm.autocorrLag1, 3)}</span>} />
          <StatRow label="Lag-5" value={<span className="mono">{fmt(sm.autocorrLag5, 3)}</span>} />
          <StatRow label="Lag-20" value={<span className="mono">{fmt(sm.autocorrLag20, 3)}</span>} />
          <div style={{ marginTop: 10, padding: 8, background: "#f5f3ed", borderRadius: 2, fontSize: 10, color: "#5a6573", lineHeight: 1.5 }}>
            <strong style={{ color: "#1a1f2c" }}>Read:</strong> negative lag-1 favors short-term mean reversion; positive favors momentum.
          </div>
        </div>
        <div style={{ padding: "12px 14px", borderRight: isMobile ? "none" : "1px solid #efece5", borderBottom: isMobile ? "1px solid #efece5" : "none" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Risk & Money Flow</div>
          <StatRow label="ATR(14)" value={<span className="mono" title="Avg True Range. Use for vol-based position sizing.">{fmt(sm.atr14, 2)}</span>} />
          <StatRow label="Sharpe (1Y)" value={<span className="mono" style={{ color: sm.sharpe1Y > 1 ? "#0a8554" : sm.sharpe1Y < 0 ? "#c4314b" : "#1a1f2c" }}>{fmt(sm.sharpe1Y, 2)}</span>} />
          <StatRow label="Sortino (1Y)" value={<span className="mono" style={{ color: sm.sortino1Y > 1.5 ? "#0a8554" : sm.sortino1Y < 0 ? "#c4314b" : "#1a1f2c" }} title="Like Sharpe but only counts downside volatility. Better for upside-heavy stocks. >1.5 is good.">{fmt(sm.sortino1Y, 2)}</span>} />
          <StatRow label="Max Drawdown (1Y)" value={<span className="mono" style={{ color: "#c4314b" }}>{fmt(sm.maxDrawdown, 2)}%</span>} />
          <StatRow label="OBV Trend" value={<span className="mono" style={{ color: sm.obvTrend === "Accumulation" ? "#0a8554" : sm.obvTrend === "Distribution" ? "#c4314b" : "#1a1f2c" }}>{sm.obvTrend}</span>} />
        </div>
        <div style={{ padding: "12px 14px" }}>
          <div className="panel-title" style={{ fontSize: 10, marginBottom: 8 }}>Calendar Effect (avg daily return)</div>
          {sm.dowAvgReturns?.map((v, i) => (
            <StatRow key={i} label={dowNames[i]} value={<span className="mono" style={{ color: colorFor(v) }}>{v != null ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%` : "—"}</span>} />
          ))}
          <div style={{ marginTop: 6, fontSize: 10, color: "#5a6573", lineHeight: 1.4 }}>Renaissance founders famously studied day-of-week effects.</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ANALYST INSIGHTS PANEL
// ============================================================
function AnalystInsightsPanel({ data, a, c, currentPrice, isMobile }) {
  const upside = currentPrice && a.targetMean ? ((a.targetMean - currentPrice) / currentPrice) * 100 : null;
  const targetPct = a.targetHigh && a.targetLow && currentPrice ?
    ((currentPrice - a.targetLow) / (a.targetHigh - a.targetLow)) * 100 : 50;
  const meanPct = a.targetHigh && a.targetLow ?
    ((a.targetMean - a.targetLow) / (a.targetHigh - a.targetLow)) * 100 : 50;

  return (
    <div className="panel" style={{ marginBottom: 16, background: "#1a1f2c", borderColor: "#1a1f2c", color: "#fff" }}>
      <div style={{ padding: isMobile ? "12px 14px 8px" : "14px 18px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #2d3548" }}>
        <span style={{ fontSize: isMobile ? 13 : 15, fontWeight: 600, letterSpacing: "-0.01em" }}>Analyst Insights: <span style={{ color: "#d4a017" }}>{data.symbol}</span></span>
        {a.numAnalysts && <span className="mono" style={{ fontSize: 10, color: "#8a93a3" }}>{a.numAnalysts} analysts</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1.4fr 1.2fr 1fr", gap: 0 }}>
        <div style={{ padding: "14px 16px", borderRight: isMobile ? "none" : "1px solid #2d3548", borderBottom: isMobile ? "1px solid #2d3548" : "none" }}>
          <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10, fontWeight: 600 }}>Top Analyst Rating</div>
          <div className="serif" style={{ fontSize: 22, fontWeight: 600, color: "#fff", marginBottom: 6 }}>{c.rating}</div>
          {c.score && (
            <>
              <div style={{ height: 6, background: "#2d3548", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
                <div style={{ width: `${(c.score / 5) * 100}%`, height: "100%", background: c.score >= 4 ? "#4ade80" : c.score >= 3 ? "#d4a017" : "#f87171" }} />
              </div>
              <div className="mono" style={{ fontSize: 10, color: "#8a93a3" }}>{fmt(c.score, 1)}/5.0 · {c.buys} BUY · {c.hold} HOLD · {c.sells} SELL</div>
            </>
          )}
        </div>
        <div style={{ padding: "14px 16px", borderRight: isMobile ? "none" : "1px solid #2d3548", borderBottom: isMobile ? "1px solid #2d3548" : "none" }}>
          <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10, fontWeight: 600 }}>Analyst Price Targets</div>
          <div style={{ position: "relative", marginBottom: 24, marginTop: 24 }}>
            <div style={{ height: 4, background: "#2d3548", borderRadius: 2, position: "relative" }}>
              {currentPrice && (
                <div style={{ position: "absolute", left: `${Math.max(2, Math.min(98, targetPct))}%`, top: -22, transform: "translateX(-50%)", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#8a93a3", marginBottom: 2 }}>Current</div>
                  <div className="mono" style={{ background: "#fff", color: "#1a1f2c", padding: "2px 6px", borderRadius: 2, fontSize: 11, fontWeight: 600 }}>${fmt(currentPrice)}</div>
                </div>
              )}
              <div style={{ position: "absolute", left: `${Math.max(2, Math.min(98, meanPct))}%`, top: 12, transform: "translateX(-50%)", textAlign: "center" }}>
                <div className="mono" style={{ background: "#d4a017", color: "#1a1f2c", padding: "2px 6px", borderRadius: 2, fontSize: 11, fontWeight: 600 }}>${fmt(a.targetMean, 0)}</div>
                <div style={{ fontSize: 9, color: "#8a93a3", marginTop: 2 }}>Avg Target</div>
              </div>
              <div style={{ position: "absolute", left: 0, top: -3, width: 10, height: 10, borderRadius: "50%", background: "#c4314b" }} />
              <div style={{ position: "absolute", right: 0, top: -3, width: 10, height: 10, borderRadius: "50%", background: "#0a8554" }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 28 }}>
            <div><div className="mono" style={{ fontSize: 13, fontWeight: 500, color: "#f87171" }}>${fmt(a.targetLow, 0)}</div><div style={{ fontSize: 9, color: "#8a93a3" }}>Low</div></div>
            <div style={{ textAlign: "right" }}><div className="mono" style={{ fontSize: 13, fontWeight: 500, color: "#4ade80" }}>${fmt(a.targetHigh, 0)}</div><div style={{ fontSize: 9, color: "#8a93a3" }}>High</div></div>
          </div>
          {upside != null && (
            <div style={{ marginTop: 10, padding: "6px 10px", background: upside > 0 ? "rgba(74,222,128,0.1)" : "rgba(248,113,113,0.1)", border: `1px solid ${upside > 0 ? "#4ade80" : "#f87171"}`, borderRadius: 2, fontSize: 11, color: upside > 0 ? "#4ade80" : "#f87171", fontWeight: 600 }}>
              {upside > 0 ? <TrendingUp size={11} style={{ display: "inline", marginRight: 4 }} /> : <TrendingDown size={11} style={{ display: "inline", marginRight: 4 }} />}
              {pct(upside)} implied upside
            </div>
          )}
        </div>
        <div style={{ padding: "14px 16px", borderRight: isMobile ? "none" : "1px solid #2d3548", borderBottom: isMobile ? "1px solid #2d3548" : "none" }}>
          <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10, fontWeight: 600 }}>Recommendations · Trend</div>
          {a.monthlyTrend?.length ? (
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-around", gap: 8, height: 90 }}>
              {a.monthlyTrend.map((m, i) => {
                const total = m.strongBuy + m.buy + m.hold + m.sell + m.strongSell;
                if (!total) return <div key={i} style={{ flex: 1, fontSize: 9, color: "#8a93a3", textAlign: "center" }}>—</div>;
                const monthLabel = m.period === "0m" ? "Now" : m.period;
                return (
                  <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%" }}>
                    <div className="mono" style={{ fontSize: 10, color: "#fff", fontWeight: 600, marginBottom: 2 }}>{total}</div>
                    <div style={{ width: "100%", maxWidth: 32, flex: 1, display: "flex", flexDirection: "column", borderRadius: 2, overflow: "hidden", background: "#2d3548" }}>
                      {m.strongBuy > 0 && <div style={{ flex: m.strongBuy, background: "#4ade80" }} />}
                      {m.buy > 0 && <div style={{ flex: m.buy, background: "#86efac" }} />}
                      {m.hold > 0 && <div style={{ flex: m.hold, background: "#d4a017" }} />}
                      {m.sell > 0 && <div style={{ flex: m.sell, background: "#fb923c" }} />}
                      {m.strongSell > 0 && <div style={{ flex: m.strongSell, background: "#f87171" }} />}
                    </div>
                    <div style={{ fontSize: 9, color: "#8a93a3", marginTop: 4 }}>{monthLabel}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "#8a93a3" }}>No trend data</div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 9, marginTop: 10, color: "#8a93a3" }}>
            <span><span style={{ color: "#4ade80" }}>●</span> Strong Buy</span>
            <span><span style={{ color: "#86efac" }}>●</span> Buy</span>
            <span><span style={{ color: "#d4a017" }}>●</span> Hold</span>
            <span><span style={{ color: "#f87171" }}>●</span> Sell</span>
          </div>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10, fontWeight: 600 }}>Latest Action</div>
          {a.latestActions?.length ? (
            <div>
              <AnalystRow label="Date" value={a.latestActions[0].date} />
              <AnalystRow label="Firm" value={a.latestActions[0].firm} />
              <AnalystRow label="Action" value={a.latestActions[0].action || "—"} />
              <AnalystRow label="Rating" value={a.latestActions[0].toGrade || "—"} />
              {a.latestActions[0].fromGrade && <AnalystRow label="From" value={a.latestActions[0].fromGrade} />}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "#8a93a3" }}>No recent actions</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SUBCOMPONENTS
// ============================================================
const GStat = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px dotted #efece5", paddingBottom: 2 }}>
    <span style={{ fontSize: 11, color: "#5a6573" }}>{label}</span>
    <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{value}</span>
  </div>
);

const AnalystRow = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px dotted #2d3548", fontSize: 11 }}>
    <span style={{ color: "#8a93a3" }}>{label}</span>
    <span style={{ color: "#fff", textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{value}</span>
  </div>
);

const TickerButton = ({ t, active, onClick, isHolding }) => (
  <button onClick={onClick} className={`ticker-btn ${active ? "active" : ""}`} style={{ borderLeftColor: isHolding && !active ? "#d4a017" : undefined }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{t.symbol}</span>
      <span className="mono" style={{ fontSize: 10, color: t.changePct > 0 ? "#0a8554" : t.changePct < 0 ? "#c4314b" : "inherit", opacity: 0.9 }}>
        {t.changePct != null ? pct(t.changePct) : "—"}
      </span>
    </div>
    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{t.name}</div>
  </button>
);

const LiveStatus = ({ status, lastUpdate, compact }) => {
  const config = {
    live: { color: "#4ade80", label: "LIVE", pulse: true },
    closed: { color: "#d4a017", label: compact ? "CLOSED" : "AFTER HOURS", pulse: false },
    error: { color: "#f87171", label: "OFFLINE", pulse: false },
    idle: { color: "#8a93a3", label: compact ? "..." : "CONNECTING", pulse: false },
    unconfigured: { color: "#8a93a3", label: compact ? "DAILY" : "DAILY ONLY", pulse: false },
  }[status] || { color: "#8a93a3", label: "—", pulse: false };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: config.color, animation: config.pulse ? "pulse 1.5s infinite" : "none" }} />
      <span style={{ color: config.color, fontWeight: 600, letterSpacing: "0.1em" }}>{config.label}</span>
      {!compact && lastUpdate && status !== "unconfigured" && <span>· {lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>}
    </span>
  );
};

const SignalCard = ({ icon: Icon, label, value }) => (
  <div className="panel" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
    <Icon size={16} color="#d4a017" strokeWidth={1.5} style={{ flexShrink: 0 }} />
    <div style={{ minWidth: 0 }}>
      <div className="panel-title" style={{ fontSize: 9 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 500, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
    </div>
  </div>
);

const StatRow = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted #e6e3db", fontSize: 12, gap: 8 }}>
    <span style={{ color: "#5a6573", flexShrink: 0 }}>{label}</span>
    <span style={{ textAlign: "right" }}>{value}</span>
  </div>
);

const LoadingScreen = () => (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", color: "#5a6573", background: "#fafaf7" }}>Loading market data…</div>
);
const ErrorScreen = ({ message }) => (
  <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 32, background: "#fafaf7" }}>
    <AlertCircle size={48} color="#c4314b" style={{ marginBottom: 16 }} />
    <h2 style={{ margin: "0 0 8px", color: "#1a1f2c" }}>Cannot load data</h2>
    <p style={{ color: "#5a6573", textAlign: "center", maxWidth: 480 }}>{message}</p>
  </div>
);

const Styles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Serif:wght@400;500;600&display=swap');
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; overflow-x: hidden; }
    body { -webkit-text-size-adjust: 100%; }
    /* Critical mobile overflow guards */
    .panel { min-width: 0; max-width: 100%; overflow-wrap: break-word; }
    .panel-head > * { min-width: 0; max-width: 100%; }
    .panel-head { word-break: break-word; }
    /* Grid and flex items must allow shrink below their natural content size */
    .panel > div, .panel > div > div { min-width: 0; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { animation: spin 0.8s linear infinite; }
    .mono { font-family: 'IBM Plex Mono', monospace; font-feature-settings: 'tnum' 1; }
    .serif { font-family: 'IBM Plex Serif', serif; }
    .panel { background: #fff; border: 1px solid #e6e3db; border-radius: 2px; }
    .panel-head { padding: 10px 14px; border-bottom: 1px solid #efece5; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .panel-title { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #5a6573; font-weight: 600; word-break: break-word; overflow-wrap: break-word; }
    .section-head { display: flex; align-items: center; gap: 6px; padding: 14px 14px 6px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #5a6573; font-weight: 600; flex-wrap: wrap; }
    .ticker-btn { background: transparent; border: none; padding: 10px 12px; cursor: pointer; text-align: left; width: 100%; border-left: 2px solid transparent; transition: all 0.12s; min-height: 44px; }
    .ticker-btn:hover { background: #fff; }
    .ticker-btn.active { background: #1a1f2c; color: #fff; border-left-color: #d4a017; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 2px; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
    .tf-btn { background: transparent; border: 1px solid #e6e3db; padding: 4px 10px; font-size: 11px; font-family: 'IBM Plex Mono', monospace; cursor: pointer; border-radius: 2px; color: #5a6573; transition: all 0.12s; min-height: 30px; }
    .tf-btn:hover { background: #f5f3ed; border-color: #d4a017; }
    .tf-btn.active { background: #1a1f2c; color: #fff; border-color: #1a1f2c; font-weight: 600; }
    table.peers { width: 100%; border-collapse: collapse; font-size: 11px; min-width: 600px; }
    table.peers th { text-align: right; padding: 6px 8px; color: #8a93a3; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; font-size: 9px; border-bottom: 1px solid #e6e3db; white-space: nowrap; }
    table.peers th:first-child, table.peers td:first-child { text-align: left; position: sticky; left: 0; background: inherit; }
    table.peers td { text-align: right; padding: 6px 8px; border-bottom: 1px dotted #efece5; white-space: nowrap; }
    table.peers tr.self { background: #fff8e1; }
    table.peers tr.self td { font-weight: 600; }
    table.peers tr.self td:first-child { background: #fff8e1; }
    table.peers tr.avg { background: #f5f3ed; font-style: italic; color: #5a6573; }
    table.peers tr.avg td:first-child { background: #f5f3ed; }
    @media (max-width: 768px) {
      input, button, select, textarea { font-size: 16px; }
      input.mono { font-size: 13px; }
      .tf-btn { font-size: 12px; }
    }
  `}</style>
);
