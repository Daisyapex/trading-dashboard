import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell, ComposedChart,
} from "recharts";
import {
  Activity, DollarSign, Users, MessageSquare, AlertCircle,
  Search, ChevronRight, Sigma, GitCompare, Briefcase, Loader2,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL;

// ============================================================
// CONFIG — paste your Finnhub key here
// ============================================================
const FINNHUB_KEY = "d7v2oe9r01qp7l70qf20d7v2oe9r01qp7l70qf2g";
const REFRESH_MS = 60_000;

function isMarketOpen() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
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
  let prev = data[0][key];
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

// ============================================================
// LIVE FETCHING HOOKS
// ============================================================

// Live quote — polls Finnhub every 60s
function useLiveQuote(symbol) {
  const [quote, setQuote] = useState(null);
  const [status, setStatus] = useState("idle");
  const [lastUpdate, setLastUpdate] = useState(null);
  const intervalRef = useRef(null);
  useEffect(() => {
    if (!symbol) return;
    if (!FINNHUB_KEY || FINNHUB_KEY === "PASTE_YOUR_FINNHUB_KEY_HERE") { setStatus("unconfigured"); return; }
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

// Ad-hoc ticker fetcher — for tickers NOT in the daily snapshot
async function fetchAdHoc(symbol) {
  if (!FINNHUB_KEY || FINNHUB_KEY === "PASTE_YOUR_FINNHUB_KEY_HERE") {
    throw new Error("Finnhub key not configured");
  }
  const f = (path, params) => fetch(`https://finnhub.io/api/v1${path}?${new URLSearchParams({ ...params, token: FINNHUB_KEY })}`).then(r => r.ok ? r.json() : null);

  // Yahoo for candles (no key)
  const candlesUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`;

  const [quote, profile, metrics, recs, candlesRes] = await Promise.all([
    f("/quote", { symbol }),
    f("/stock/profile2", { symbol }),
    f("/stock/metric", { symbol, metric: "all" }),
    f("/stock/recommendation", { symbol }),
    fetch(candlesUrl).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (!quote || quote.c == null || quote.c === 0) {
    throw new Error(`No data found for "${symbol}". Check the ticker symbol.`);
  }

  // Parse Yahoo candles
  let candles = [];
  if (candlesRes?.chart?.result?.[0]) {
    const r = candlesRes.chart.result[0];
    const ts = r.timestamp || []; const q = r.indicators?.quote?.[0] || {};
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue;
      candles.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: +q.open[i].toFixed(2), high: +q.high[i].toFixed(2),
        low: +q.low[i].toFixed(2), close: +q.close[i].toFixed(2),
        volume: q.volume[i] || 0,
      });
    }
  }

  const m = metrics?.metric || {};
  const latestRec = recs?.[0] || {};
  const totalRecs = (latestRec.strongBuy || 0) + (latestRec.buy || 0) + (latestRec.hold || 0) + (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const buys = (latestRec.strongBuy || 0) + (latestRec.buy || 0);
  const sells = (latestRec.sell || 0) + (latestRec.strongSell || 0);
  const score = totalRecs ? (5 * (latestRec.strongBuy || 0) + 4 * (latestRec.buy || 0) + 3 * (latestRec.hold || 0) + 2 * (latestRec.sell || 0) + (latestRec.strongSell || 0)) / totalRecs : null;
  const rating = score == null ? "—" : score >= 4.5 ? "Strong Buy" : score >= 3.7 ? "Buy" : score >= 2.7 ? "Hold" : score >= 1.7 ? "Sell" : "Strong Sell";

  return {
    symbol, name: profile?.name || symbol,
    sector: profile?.finnhubIndustry || "—",
    peers: [], peerData: {},
    fetchedAt: new Date().toISOString(),
    quote: { current: quote.c, change: quote.d, changePct: quote.dp, high: quote.h, low: quote.l, open: quote.o, prevClose: quote.pc },
    candles,
    fundamentals: {
      pe: m.peBasicExclExtraTTM ?? m.peTTM ?? null,
      fwdPe: m.peExclExtraAnnual ?? null, peg: m.pegRatio ?? null,
      pb: m.pbAnnual ?? m.pbQuarterly ?? null, ps: m.psTTM ?? null,
      evEbitda: m["enterpriseValue/EBITDATTM"] ?? null,
      divYield: m.dividendYieldIndicatedAnnual ?? m.currentDividendYieldTTM ?? null,
      payout: m.payoutRatioTTM ?? null, roe: m.roeTTM ?? m.roeRfy ?? null,
      roic: m.roiTTM ?? null, debtEq: m["totalDebt/totalEquityAnnual"] ?? null,
      eps: m.epsBasicExclExtraItemsTTM ?? m.epsTTM ?? null,
      revGrowth: m.revenueGrowthTTMYoy ?? null, opMargin: m.operatingMarginTTM ?? null,
      mcap: m.marketCapitalization ?? null,
      week52High: m["52WeekHigh"] ?? null, week52Low: m["52WeekLow"] ?? null,
      beta: m.beta ?? null,
    },
    consensus: {
      rating, score: score != null ? +score.toFixed(2) : null, analysts: totalRecs || null,
      strongBuy: latestRec.strongBuy ?? 0, buy: latestRec.buy ?? 0, buys,
      hold: latestRec.hold ?? 0, sell: latestRec.sell ?? 0, strongSell: latestRec.strongSell ?? 0,
      sells, period: latestRec.period ?? null,
    },
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

  const live = useLiveQuote(ticker);

  useEffect(() => {
    fetch(`${BASE}data/index.json`)
      .then((r) => { if (!r.ok) throw new Error("No data found. Has the fetch workflow run yet?"); return r.json(); })
      .then((idx) => {
        setIndex(idx);
        if (idx.tickers?.length) setTicker(idx.tickers[0].symbol);
        setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!ticker) return;
    setData(null); setSearchError(null);
    // Try snapshot first
    fetch(`${BASE}data/${ticker}.json`)
      .then((r) => {
        if (r.ok) return r.json();
        // Not in snapshot — fetch ad-hoc
        return fetchAdHoc(ticker);
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [ticker]);

  // Handle search submit — load ad-hoc ticker
  const handleSearch = async (e) => {
    e?.preventDefault();
    const sym = searchInput.trim().toUpperCase();
    if (!sym) return;
    // Check if it's already in the watchlist — just switch
    if (index?.tickers.some((t) => t.symbol === sym)) {
      setTicker(sym); setSearchInput(""); return;
    }
    // Otherwise, fetch ad-hoc
    setSearchLoading(true); setSearchError(null);
    try {
      const adhocData = await fetchAdHoc(sym);
      setTicker(sym);
      setData(adhocData);
      setSearchInput("");
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearchLoading(false);
    }
  };

  const enriched = useMemo(() => {
    if (!data?.candles || data.candles.length < 30) return null;
    let d = data.candles.map((c) => ({ ...c, label: labelFromDate(c.date) }));
    d = sma(d, 20); d = sma(d, 50); d = sma(d, 200);
    d = rsi(d); d = macd(d); d = sqzmom(d); d = zscore(d, 20);
    return d;
  }, [data]);

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorScreen message={error} />;
  if (!index || !data) return <LoadingScreen />;

  const displayQuote = live.quote || data.quote;
  const f = data.fundamentals;
  const c = data.consensus;

  // Indicator-derived signals (only if we have enough candles)
  let last, lastRsi, lastZ, sqzActive, hurst, rv30, rv90, chartData,
      trendSignal, momentumSignal, reversionSignal, regimeSignal;
  if (enriched) {
    last = enriched[enriched.length - 1];
    lastRsi = last.rsi; lastZ = last.zscore; sqzActive = last.sqz_on;
    hurst = hurstExponent(enriched, Math.min(100, enriched.length - 1));
    rv30 = realizedVol(enriched, 30); rv90 = realizedVol(enriched, 90);
    chartData = enriched.slice(-120);
    trendSignal = last.close > last.sma50 && last.sma50 > last.sma200 ? "Bullish trend" :
                  last.close < last.sma50 && last.sma50 < last.sma200 ? "Bearish trend" : "Mixed";
    momentumSignal = lastRsi > 70 ? "Overbought" : lastRsi < 30 ? "Oversold" : "Neutral";
    reversionSignal = lastZ > 2 ? "Stretched ↑ (fade)" : lastZ < -2 ? "Stretched ↓ (buy)" : Math.abs(lastZ) < 0.5 ? "At mean" : "In range";
    regimeSignal = hurst > 0.55 ? "Trending" : hurst < 0.45 ? "Mean-reverting" : "Random walk";
  }

  const peerRows = [
    { ticker: data.symbol, name: data.name, price: displayQuote.current, pe: f.pe, fwdPe: f.fwdPe, peg: f.peg, ps: f.ps, evEbitda: f.evEbitda, roe: f.roe, mcap: f.mcap, isSelf: true },
    ...Object.entries(data.peerData || {}).map(([sym, p]) => ({ ticker: sym, name: sym, ...p })),
  ];
  const peerAvg = (key) => {
    const vals = peerRows.filter((r) => !r.isSelf && r[key] != null).map((r) => r[key]);
    return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
  };

  // Split watchlist into holdings and rest
  const holdings = (index.tickers || []).filter((t) => t.holding);
  const rest = (index.tickers || []).filter((t) => !t.holding);

  return (
    <div style={{ fontFamily: "'IBM Plex Sans', -apple-system, sans-serif", background: "#fafaf7", minHeight: "100vh", color: "#1a1f2c" }}>
      <Styles />

      <header style={{ background: "#1a1f2c", color: "#fff", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "3px solid #d4a017" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span className="serif" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>TERMINAL</span>
          <span className="mono" style={{ fontSize: 10, color: "#8a93a3", letterSpacing: "0.15em" }}>EQUITY · QUANT · DESK</span>
        </div>
        <div className="mono" style={{ fontSize: 10, color: "#8a93a3", display: "flex", gap: 16, alignItems: "center" }}>
          <LiveStatus status={live.status} lastUpdate={live.lastUpdate} />
          <span>· Snapshot: {new Date(index.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr" }}>
        <aside style={{ borderRight: "1px solid #e6e3db", background: "#f5f3ed", minHeight: "calc(100vh - 53px)", maxHeight: "calc(100vh - 53px)", overflowY: "auto" }}>
          {/* SEARCH BAR */}
          <div style={{ padding: "16px 14px 8px", position: "sticky", top: 0, background: "#f5f3ed", zIndex: 1, borderBottom: "1px solid #e6e3db" }}>
            <form onSubmit={handleSearch} style={{ position: "relative" }}>
              <Search size={12} style={{ position: "absolute", left: 8, top: 9, color: "#8a93a3", pointerEvents: "none" }} />
              <input
                value={searchInput}
                onChange={(e) => { setSearchInput(e.target.value); setSearchError(null); }}
                placeholder="Search any ticker (e.g. PLTR)…"
                className="mono"
                style={{ width: "100%", padding: "6px 28px 6px 26px", fontSize: 11, border: "1px solid #d6d2c7", background: "#fff", borderRadius: 2, outline: "none", textTransform: "uppercase" }}
              />
              {searchLoading && <Loader2 size={11} className="spin" style={{ position: "absolute", right: 8, top: 9, color: "#d4a017" }} />}
            </form>
            {searchError && (
              <div style={{ marginTop: 6, fontSize: 10, color: "#c4314b", lineHeight: 1.4 }}>
                {searchError}
              </div>
            )}
            {!searchInput && !searchError && (
              <div style={{ marginTop: 6, fontSize: 9, color: "#8a93a3", lineHeight: 1.4 }}>
                Type any US ticker. Press Enter.
              </div>
            )}
          </div>

          {/* MY HOLDINGS SECTION */}
          {holdings.length > 0 && (
            <div>
              <div className="section-head">
                <Briefcase size={11} color="#d4a017" strokeWidth={2} />
                <span>My Holdings</span>
                <span style={{ marginLeft: "auto", color: "#8a93a3" }}>{holdings.length}</span>
              </div>
              {holdings.map((t) => (
                <TickerButton key={t.symbol} t={t} active={t.symbol === ticker} onClick={() => setTicker(t.symbol)} isHolding />
              ))}
            </div>
          )}

          {/* WATCHLIST SECTION */}
          {rest.length > 0 && (
            <div>
              <div className="section-head" style={{ marginTop: holdings.length ? 0 : 8 }}>
                <span>Watchlist</span>
                <span style={{ marginLeft: "auto", color: "#8a93a3" }}>{rest.length}</span>
              </div>
              {rest.map((t) => (
                <TickerButton key={t.symbol} t={t} active={t.symbol === ticker} onClick={() => setTicker(t.symbol)} />
              ))}
            </div>
          )}
        </aside>

        <main style={{ padding: 16 }}>
          {/* TICKER HEADER */}
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #e6e3db" }}>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <span className="serif" style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em" }}>{data.symbol}</span>
                <span style={{ fontSize: 14, color: "#5a6573" }}>{data.name}</span>
                {data.sector && <span className="pill" style={{ background: "#f5f3ed", color: "#5a6573" }}>{data.sector}</span>}
                {data.isAdHoc && <span className="pill" style={{ background: "#fff8e1", color: "#8b6914" }}>Ad-hoc</span>}
                {holdings.find((h) => h.symbol === data.symbol) && <span className="pill" style={{ background: "#0a8554", color: "#fff" }}>Holding</span>}
              </div>
              <div style={{ fontSize: 10, color: "#8a93a3", marginTop: 4, letterSpacing: "0.1em" }}>
                {live.status === "live" ? "● LIVE QUOTE" : live.status === "closed" ? "MARKET CLOSED · LAST PRICE" : "USD · DAILY"}
                {live.lastUpdate && ` · UPDATED ${live.lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="mono" style={{ fontSize: 36, fontWeight: 500, lineHeight: 1 }}>{fmt(displayQuote.current)}</div>
              <div className="mono" style={{ fontSize: 13, marginTop: 4, color: colorFor(displayQuote.change) }}>
                {displayQuote.change >= 0 ? "▲" : "▼"} {fmt(Math.abs(displayQuote.change ?? 0))} ({pct(displayQuote.changePct)})
              </div>
            </div>
          </div>

          {/* SIGNAL STRIP */}
          {enriched && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
              <SignalCard icon={Activity} label="Technical" value={trendSignal} />
              <SignalCard icon={DollarSign} label="Value" value={f.pe ? (peerAvg("pe") && f.pe < peerAvg("pe") ? "Below peers" : "Premium to peers") : "—"} />
              <SignalCard icon={Users} label="Consensus" value={c.rating} />
              <SignalCard icon={MessageSquare} label="Momentum" value={momentumSignal} />
            </div>
          )}

          {!enriched && data.candles?.length > 0 && (
            <div className="panel" style={{ padding: 16, marginBottom: 16, fontSize: 12, color: "#5a6573" }}>
              ⚠️ Limited price history available for {data.symbol} ({data.candles.length} bars). Indicators need at least 30 days. Showing fundamentals and quote only.
            </div>
          )}

          {!data.candles?.length && (
            <div className="panel" style={{ padding: 16, marginBottom: 16, fontSize: 12, color: "#5a6573" }}>
              ⚠️ No price history available for {data.symbol}. This is common for OTC, foreign, or low-volume tickers. Showing quote and fundamentals only.
            </div>
          )}

          {/* TECHNICAL CHARTS — only if we have enough candles */}
          {enriched && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head">
                <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  <span className="panel-title">Technicals · 120D · Daily</span>
                  <span className="mono" style={{ fontSize: 10, color: "#5a6573" }}>
                    <span style={{ color: "#1a1f2c" }}>━</span> Close &nbsp;
                    <span style={{ color: "#d4a017" }}>━</span> SMA20 &nbsp;
                    <span style={{ color: "#0a8554" }}>━</span> SMA50 &nbsp;
                    <span style={{ color: "#1a4f8c" }}>━</span> SMA200
                  </span>
                </div>
              </div>
              <div style={{ padding: "8px 8px 0" }}>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={chartData} margin={{ top: 8, right: 50, left: 0, bottom: 0 }} syncId="tech">
                    <XAxis dataKey="label" hide />
                    <YAxis tick={{ fontSize: 10, fill: "#8a93a3" }} stroke="#e6e3db" domain={["auto", "auto"]} orientation="right" width={50} />
                    <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", borderRadius: 2, fontSize: 11 }} labelStyle={{ color: "#d4a017", fontWeight: 600 }} itemStyle={{ color: "#fff" }} />
                    <Line type="monotone" dataKey="close" stroke="#1a1f2c" strokeWidth={1.5} dot={false} name="Close" />
                    <Line type="monotone" dataKey="sma20" stroke="#d4a017" strokeWidth={1} dot={false} name="SMA 20" />
                    <Line type="monotone" dataKey="sma50" stroke="#0a8554" strokeWidth={1} dot={false} name="SMA 50" />
                    <Line type="monotone" dataKey="sma200" stroke="#1a4f8c" strokeWidth={1} dot={false} name="SMA 200" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ padding: "0 8px", borderTop: "1px solid #efece5" }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 0" }}>
                  <span className="panel-title" style={{ fontSize: 10 }}>RSI(14)</span>
                  <span className="mono" style={{ fontSize: 10, color: lastRsi > 70 ? "#c4314b" : lastRsi < 30 ? "#0a8554" : "#1a1f2c" }}>{fmt(lastRsi, 1)}</span>
                </div>
                <ResponsiveContainer width="100%" height={90}>
                  <LineChart data={chartData} margin={{ top: 4, right: 50, left: 0, bottom: 0 }} syncId="tech">
                    <XAxis dataKey="label" hide />
                    <YAxis domain={[0, 100]} ticks={[30, 50, 70]} tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={50} />
                    <ReferenceLine y={70} stroke="#c4314b" strokeDasharray="2 2" strokeWidth={0.8} />
                    <ReferenceLine y={50} stroke="#8a93a3" strokeDasharray="1 3" strokeWidth={0.5} />
                    <ReferenceLine y={30} stroke="#0a8554" strokeDasharray="2 2" strokeWidth={0.8} />
                    <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", borderRadius: 2, fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                    <Line type="monotone" dataKey="rsi" stroke="#7c3aed" strokeWidth={1.2} dot={false} name="RSI" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ padding: "0 8px", borderTop: "1px solid #efece5" }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 0" }}>
                  <span className="panel-title" style={{ fontSize: 10 }}>MACD(12,26,9)</span>
                  <span className="mono" style={{ fontSize: 10 }}>
                    <span style={{ color: "#1a4f8c" }}>━</span> MACD {fmt(last.macd, 2)} &nbsp;
                    <span style={{ color: "#c4314b" }}>━</span> Signal {fmt(last.signal, 2)}
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={90}>
                  <ComposedChart data={chartData} margin={{ top: 4, right: 50, left: 0, bottom: 0 }} syncId="tech">
                    <XAxis dataKey="label" hide />
                    <YAxis tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={50} />
                    <ReferenceLine y={0} stroke="#5a6573" strokeWidth={0.5} />
                    <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", borderRadius: 2, fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                    <Bar dataKey="hist" name="Histogram">
                      {chartData.map((d, i) => (<Cell key={i} fill={d.hist >= 0 ? "#0a8554" : "#c4314b"} fillOpacity={0.6} />))}
                    </Bar>
                    <Line type="monotone" dataKey="macd" stroke="#1a4f8c" strokeWidth={1.2} dot={false} name="MACD" />
                    <Line type="monotone" dataKey="signal" stroke="#c4314b" strokeWidth={1} dot={false} name="Signal" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div style={{ padding: "0 8px 8px", borderTop: "1px solid #efece5" }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 0" }}>
                  <span className="panel-title" style={{ fontSize: 10 }}>SQZMOM_LB · Squeeze Momentum</span>
                  <span className="mono" style={{ fontSize: 10 }}>
                    {sqzActive ? <span style={{ color: "#c4314b" }}>● SQUEEZE ON</span> : <span style={{ color: "#0a8554" }}>○ released</span>}
                    &nbsp;· mom {fmt(last.sqz_mom, 2)}
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={90}>
                  <BarChart data={chartData} margin={{ top: 4, right: 50, left: 0, bottom: 0 }} syncId="tech">
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" interval={Math.floor(chartData.length / 8)} />
                    <YAxis tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={50} />
                    <ReferenceLine y={0} stroke="#5a6573" strokeWidth={0.5} />
                    <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", borderRadius: 2, fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                    <Bar dataKey="sqz_mom">
                      {chartData.map((d, i) => {
                        const prevMom = i > 0 ? chartData[i - 1].sqz_mom : 0;
                        const rising = d.sqz_mom >= prevMom;
                        let fill = "#5a6573";
                        if (d.sqz_mom > 0) fill = rising ? "#0a8554" : "#86b09c";
                        else fill = rising ? "#e89aa6" : "#c4314b";
                        return <Cell key={i} fill={fill} />;
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* QUANT */}
          {enriched && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head"><span className="panel-title">Quant · Statistical Signals</span><Sigma size={13} color="#d4a017" /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr" }}>
                <div style={{ padding: "12px 14px", borderRight: "1px solid #efece5" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="panel-title" style={{ fontSize: 10 }}>Z-Score(20) · Mean Reversion</span>
                    <span className="mono" style={{ fontSize: 11, color: Math.abs(lastZ) > 2 ? "#c4314b" : "#1a1f2c", fontWeight: 600 }}>{fmt(lastZ, 2)}σ · {reversionSignal}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                      <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" interval={Math.floor(chartData.length / 6)} />
                      <YAxis domain={[-3, 3]} ticks={[-2, -1, 0, 1, 2]} tick={{ fontSize: 9, fill: "#8a93a3" }} stroke="#e6e3db" orientation="right" width={32} />
                      <ReferenceLine y={2} stroke="#c4314b" strokeDasharray="3 3" strokeWidth={0.8} />
                      <ReferenceLine y={0} stroke="#5a6573" strokeWidth={0.5} />
                      <ReferenceLine y={-2} stroke="#0a8554" strokeDasharray="3 3" strokeWidth={0.8} />
                      <Tooltip contentStyle={{ background: "#1a1f2c", border: "none", fontSize: 11 }} labelStyle={{ color: "#d4a017" }} itemStyle={{ color: "#fff" }} />
                      <Line type="monotone" dataKey="zscore" stroke="#d4a017" strokeWidth={1.4} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ padding: "12px 14px" }}>
                  <StatRow label="Hurst Exponent" value={<span className="mono">{fmt(hurst, 2)} <span className="pill" style={{ background: hurst > 0.55 ? "#0a8554" : hurst < 0.45 ? "#d4a017" : "#5a6573", color: "#fff", marginLeft: 4 }}>{regimeSignal}</span></span>} />
                  <StatRow label="Realized Vol (30d)" value={<span className="mono">{fmt(rv30, 1)}%</span>} />
                  <StatRow label="Realized Vol (90d)" value={<span className="mono">{fmt(rv90, 1)}%</span>} />
                  <StatRow label="Vol-of-Vol (30/90)" value={<span className="mono" style={{ color: rv30 > rv90 ? "#c4314b" : "#0a8554" }}>{fmt(rv30 / rv90, 2)}×</span>} />
                  <StatRow label="Squeeze" value={<span className="mono">{sqzActive ? <span style={{ color: "#c4314b" }}>Compressed</span> : <span style={{ color: "#0a8554" }}>Released</span>}</span>} />
                  <StatRow label="Trend (50/200)" value={<span className="mono">{last.sma50 > last.sma200 ? <span style={{ color: "#0a8554" }}>Golden cross</span> : <span style={{ color: "#c4314b" }}>Death cross</span>}</span>} />
                  <StatRow label="Beta" value={<span className="mono">{fmt(f.beta, 2)}</span>} />
                  <div style={{ marginTop: 12, padding: 8, background: "#f5f3ed", borderRadius: 2, fontSize: 10, color: "#5a6573", lineHeight: 1.5 }}>
                    <strong style={{ color: "#1a1f2c" }}>Regime:</strong> {regimeSignal}. {hurst < 0.45 ? "Mean-reversion strategies historically outperform." : hurst > 0.55 ? "Trend-following historically outperforms." : "Mixed regime — reduce sizing."}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* PEER COMPARISON — only for non-ad-hoc */}
          {peerRows.length > 1 && !data.isAdHoc && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-head"><span className="panel-title">Peer Comparison · Relative Value</span><GitCompare size={13} color="#d4a017" /></div>
              <div style={{ overflowX: "auto" }}>
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
                          <td className="mono">{r.mcap ? fmt(r.mcap, 0) : "—"}</td>
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

          {/* VALUE / CONSENSUS / 52W */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            <div className="panel">
              <div className="panel-head"><span className="panel-title">Value · Fundamentals</span><DollarSign size={13} color="#d4a017" /></div>
              <div style={{ padding: "10px 14px" }}>
                <StatRow label="P/E (TTM)" value={<span className="mono">{fmt(f.pe, 1)}</span>} />
                <StatRow label="Forward P/E" value={<span className="mono">{fmt(f.fwdPe, 1)}</span>} />
                <StatRow label="PEG Ratio" value={<span className="mono" style={{ color: f.peg && f.peg < 1 ? "#0a8554" : f.peg > 2 ? "#c4314b" : "#1a1f2c" }}>{fmt(f.peg, 2)}</span>} />
                <StatRow label="P/B" value={<span className="mono">{fmt(f.pb, 1)}</span>} />
                <StatRow label="P/S" value={<span className="mono">{fmt(f.ps, 1)}</span>} />
                <StatRow label="EV/EBITDA" value={<span className="mono">{fmt(f.evEbitda, 1)}</span>} />
                <StatRow label="Div Yield" value={<span className="mono">{f.divYield ? fmt(f.divYield, 2) + "%" : "—"}</span>} />
                <StatRow label="ROE" value={<span className="mono" style={{ color: f.roe > 15 ? "#0a8554" : "#1a1f2c" }}>{f.roe ? fmt(f.roe, 1) + "%" : "—"}</span>} />
                <StatRow label="Debt/Equity" value={<span className="mono">{fmt(f.debtEq, 2)}</span>} />
                <StatRow label="Op. Margin" value={<span className="mono">{f.opMargin ? fmt(f.opMargin, 1) + "%" : "—"}</span>} />
                <StatRow label="Rev Growth" value={<span className="mono" style={{ color: colorFor(f.revGrowth) }}>{f.revGrowth != null ? pct(f.revGrowth) : "—"}</span>} />
                <StatRow label="EPS (TTM)" value={<span className="mono">${fmt(f.eps, 2)}</span>} />
                <StatRow label="Mkt Cap ($M)" value={<span className="mono">{fmt(f.mcap, 0)}</span>} />
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><span className="panel-title">Analyst Consensus</span><Users size={13} color="#d4a017" /></div>
              <div style={{ padding: "14px" }}>
                <div style={{ textAlign: "center", marginBottom: 14, padding: "12px 0", background: "#f5f3ed", borderRadius: 2 }}>
                  <div className="panel-title" style={{ fontSize: 9 }}>Consensus Rating</div>
                  <div className="serif" style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{c.rating}</div>
                  <div className="mono" style={{ fontSize: 10, color: "#5a6573", marginTop: 2 }}>{c.score ? `${fmt(c.score, 1)} / 5.0` : "—"} · {c.analysts ?? 0} analysts</div>
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
            <div className="panel" style={{ marginTop: 16, padding: "12px 16px", display: "flex", alignItems: "center", gap: 16, background: "#1a1f2c", color: "#fff", borderColor: "#1a1f2c" }}>
              <AlertCircle size={16} color="#d4a017" />
              <div style={{ flex: 1, fontSize: 12, lineHeight: 1.6 }}>
                <span style={{ color: "#d4a017", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", fontSize: 10 }}>Composite · </span>
                Trend <strong>{trendSignal.toLowerCase()}</strong>, momentum {momentumSignal.toLowerCase()} (RSI {fmt(lastRsi, 0)}). Z-score {fmt(lastZ, 1)}σ — {reversionSignal.toLowerCase()}. Regime: <strong>{regimeSignal.toLowerCase()}</strong>. Street: <strong>{c.rating?.toLowerCase() ?? "n/a"}</strong>. P/E {fmt(f.pe, 1)} {peerAvg("pe") ? `vs peers ${fmt(peerAvg("pe"), 1)}` : ""}.
              </div>
              <ChevronRight size={16} color="#8a93a3" />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ============================================================
// SUBCOMPONENTS
// ============================================================
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

const LiveStatus = ({ status, lastUpdate }) => {
  const config = {
    live: { color: "#4ade80", label: "LIVE", pulse: true },
    closed: { color: "#d4a017", label: "AFTER HOURS", pulse: false },
    error: { color: "#f87171", label: "OFFLINE", pulse: false },
    idle: { color: "#8a93a3", label: "CONNECTING", pulse: false },
    unconfigured: { color: "#8a93a3", label: "DAILY ONLY", pulse: false },
  }[status] || { color: "#8a93a3", label: "—", pulse: false };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: config.color, animation: config.pulse ? "pulse 1.5s infinite" : "none" }} />
      <span style={{ color: config.color, fontWeight: 600, letterSpacing: "0.1em" }}>{config.label}</span>
      {lastUpdate && status !== "unconfigured" && <span>· {lastUpdate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
    </span>
  );
};

const Styles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Serif:wght@400;500;600&display=swap');
    * { box-sizing: border-box; }
    body { margin: 0; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { animation: spin 0.8s linear infinite; }
    .mono { font-family: 'IBM Plex Mono', monospace; font-feature-settings: 'tnum' 1; }
    .serif { font-family: 'IBM Plex Serif', serif; }
    .panel { background: #fff; border: 1px solid #e6e3db; border-radius: 2px; }
    .panel-head { padding: 10px 14px; border-bottom: 1px solid #efece5; display: flex; align-items: center; justify-content: space-between; }
    .panel-title { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #5a6573; font-weight: 600; }
    .section-head { display: flex; align-items: center; gap: 6px; padding: 14px 14px 6px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #5a6573; font-weight: 600; }
    .ticker-btn { background: transparent; border: none; padding: 8px 12px; cursor: pointer; text-align: left; width: 100%; border-left: 2px solid transparent; transition: all 0.12s; }
    .ticker-btn:hover { background: #fff; }
    .ticker-btn.active { background: #1a1f2c; color: #fff; border-left-color: #d4a017; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 2px; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
    table.peers { width: 100%; border-collapse: collapse; font-size: 11px; }
    table.peers th { text-align: right; padding: 6px 8px; color: #8a93a3; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; font-size: 9px; border-bottom: 1px solid #e6e3db; }
    table.peers th:first-child, table.peers td:first-child { text-align: left; }
    table.peers td { text-align: right; padding: 6px 8px; border-bottom: 1px dotted #efece5; }
    table.peers tr.self { background: #fff8e1; }
    table.peers tr.self td { font-weight: 600; }
    table.peers tr.avg { background: #f5f3ed; font-style: italic; color: #5a6573; }
  `}</style>
);

const SignalCard = ({ icon: Icon, label, value }) => (
  <div className="panel" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
    <Icon size={18} color="#d4a017" strokeWidth={1.5} />
    <div>
      <div className="panel-title" style={{ fontSize: 10 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500, marginTop: 2 }}>{value}</div>
    </div>
  </div>
);

const StatRow = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dotted #e6e3db", fontSize: 12 }}>
    <span style={{ color: "#5a6573" }}>{label}</span>
    <span>{value}</span>
  </div>
);

const LoadingScreen = () => (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", color: "#5a6573", background: "#fafaf7" }}>
    Loading market data…
  </div>
);

const ErrorScreen = ({ message }) => (
  <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 32, background: "#fafaf7" }}>
    <AlertCircle size={48} color="#c4314b" style={{ marginBottom: 16 }} />
    <h2 style={{ margin: "0 0 8px", color: "#1a1f2c" }}>Cannot load data</h2>
    <p style={{ color: "#5a6573", textAlign: "center", maxWidth: 480 }}>{message}</p>
    <p style={{ color: "#8a93a3", fontSize: 12, marginTop: 16 }}>If this is a fresh deploy, run the "Fetch Market Data" workflow once from the Actions tab on GitHub.</p>
  </div>
);
