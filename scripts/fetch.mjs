// scripts/fetch.mjs — direct HTTP, manual Yahoo crumb auth (no external library)
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ====================================================================
// EPS history accumulation — Yahoo's earningsHistory endpoint only returns
// 4 most recent quarters. By reading the previously-saved JSON for each
// ticker before re-writing it, we accumulate quarters over time and build
// a deeper history naturally (cap at 20 quarters = 5 years).
// ====================================================================
function mergeEpsHistory(existing, fresh) {
  if (!Array.isArray(existing) || !existing.length) return fresh || [];
  if (!Array.isArray(fresh) || !fresh.length) return existing;
  const byKey = new Map();
  const keyFor = (row) => row.quarter || `pos:${row.actual}|${row.estimate}|${row.surprise}`;
  for (const row of existing) {
    if (row.actual == null) continue;
    byKey.set(keyFor(row), row);
  }
  for (const row of fresh) {
    if (row.actual == null) continue;
    byKey.set(keyFor(row), row); // new data wins for revisions
  }
  return Array.from(byKey.values())
    .sort((a, b) => {
      const da = a.quarter ? new Date(a.quarter).getTime() : 0;
      const db = b.quarter ? new Date(b.quarter).getTime() : 0;
      return da - db;
    })
    .slice(-20);
}

// ====================================================================
// P/E snapshot accumulator — saves (date, ttmEps, price) at each fetch run
// so we can build a high-resolution historical P/E chart that uses the SAME
// methodology as the current displayed P/E (price ÷ Yahoo's trailingEps).
// Dedup by date (later writes win — so the post-close run is what's stored).
// Cap at 1500 snapshots (~4 years of daily data).
// ====================================================================
function appendPeSnapshot(existingSnapshots, newSnapshot) {
  if (!newSnapshot || newSnapshot.ttmEps == null || newSnapshot.price == null || !newSnapshot.date) {
    return Array.isArray(existingSnapshots) ? existingSnapshots : [];
  }
  const byDate = new Map();
  if (Array.isArray(existingSnapshots)) {
    for (const s of existingSnapshots) {
      if (s?.date && s.ttmEps != null && s.price != null) byDate.set(s.date, s);
    }
  }
  byDate.set(newSnapshot.date, newSnapshot); // same-day overwrite (post-close run wins)
  return Array.from(byDate.values())
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(-1500);
}

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

async function finnhub(path, params = {}, retries = 2) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const url = `${FINNHUB}${path}?${qs}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        // Finnhub returns 200 + empty/null body when rate-limited silently.
        // For quote endpoint, null current price (c=0 or null) = treat as failure.
        if (path === "/quote" && (data == null || (data.c == null) || data.c === 0)) {
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, 4000 + attempt * 2000));
            continue;
          }
        }
        return data;
      }
      // 429 = rate limit, 403 = often rate-limit-related on Finnhub free tier
      if ((res.status === 429 || res.status === 403) && attempt < retries) {
        const waitMs = 5000 + attempt * 3000; // 5s, 8s
        console.warn(`  ↻ finnhub ${path} ${res.status}, retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${retries + 1})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (res.status !== 429 && res.status !== 403) {
        console.warn(`finnhub ${path} ${res.status} for ${params.symbol || ""}`);
      }
      return null;
    } catch (e) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      console.warn(`finnhub ${path} threw ${e.message} for ${params.symbol || ""}`);
      return null;
    }
  }
  return null;
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
    "earningsTrend", "earningsHistory", "earnings",
    "insiderTransactions", "majorHoldersBreakdown",
    "calendarEvents",
    "cashflowStatementHistory", "incomeStatementHistory",
    "incomeStatementHistoryQuarterly",
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
// Yahoo's /v7/finance/options/{symbol} default returns NEAREST expiry — which is
// often 0DTE (expires same day). 0DTE data has near-zero IV and garbage skew.
// We fetch the expirationDates list, pick the first one >=3 days out, then fetch that.
async function yahooOptions(symbol) {
  if (!YAHOO_CRUMB) await initYahooAuth();
  if (!YAHOO_CRUMB) return null;

  const fetchChain = async (urlSuffix = "") => {
    const url = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}?crumb=${encodeURIComponent(YAHOO_CRUMB)}${urlSuffix}`;
    let res = await fetch(url, { headers: { ...BROWSER_HEADERS, "Cookie": YAHOO_COOKIE || "" } });
    if (res.status === 401) {
      YAHOO_COOKIE = null; YAHOO_CRUMB = null;
      await initYahooAuth();
      if (!YAHOO_CRUMB) return null;
      const url2 = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}?crumb=${encodeURIComponent(YAHOO_CRUMB)}${urlSuffix}`;
      res = await fetch(url2, { headers: { ...BROWSER_HEADERS, "Cookie": YAHOO_COOKIE } });
    }
    if (!res.ok) {
      console.warn(`yahoo options ${symbol}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json())?.optionChain?.result?.[0] || null;
  };

  try {
    // Step 1: fetch the default chain to discover all expirationDates
    const first = await fetchChain();
    if (!first) return null;
    const dates = first.expirationDates || [];
    if (!dates.length) return first; // No date list — return what we got

    // Step 2: find first expiry >= 3 days out (skip 0DTE / next-day) — primary chain for flow data
    const minTs = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    const targetTs = dates.find((d) => d >= minTs) || dates[dates.length - 1];

    // If default chain is already that expiry, reuse it; else fetch it
    let primary;
    const defaultExpiry = first.options?.[0]?.expirationDate;
    if (defaultExpiry === targetTs) primary = first;
    else primary = (await fetchChain(`&date=${targetTs}`)) || first;

    // Step 3: also find a longer-dated expiry (~25-40 days out) for stable annualized IV.
    // Short-dated chains have collapsed time value and produce garbage ATM IV (e.g., 3.1%).
    const longTargetMin = Math.floor(Date.now() / 1000) + 25 * 24 * 3600;
    const longTargetMax = Math.floor(Date.now() / 1000) + 40 * 24 * 3600;
    const longTs = dates.find((d) => d >= longTargetMin && d <= longTargetMax) || dates.find((d) => d >= longTargetMin) || null;
    let longChain = null;
    if (longTs && longTs !== primary.options?.[0]?.expirationDate) {
      longChain = await fetchChain(`&date=${longTs}`);
    }

    // Attach the long chain to primary so computeOptionsMetrics can use it for IV reading
    if (longChain && primary) primary._longChain = longChain;
    return primary;
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

  // ---- IV filter: drop garbage values ----
  // Yahoo returns IV=0, IV=0.0001, or exactly IV=0.5 (50.0%) when it has no
  // real data. Real IV for liquid US equity options is typically 0.10–2.00.
  const validIV = (iv) => {
    if (iv == null || typeof iv !== "number" || !isFinite(iv)) return false;
    if (iv < 0.02 || iv > 4.0) return false;        // unrealistic range
    if (Math.abs(iv - 0.5) < 0.0001) return false;  // Yahoo's "no data" sentinel
    return true;
  };

  // Put/Call ratios — use volume / OI regardless of IV
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
    iv: validIV(c.impliedVolatility) ? +(c.impliedVolatility * 100).toFixed(1) : null,
    lastPrice: c.lastPrice ?? null,
    unusual: c.openInterest > 0 ? c.volume > 2 * c.openInterest : c.volume > 1000,
  }));

  // Volatility skew — IV at ~10% OTM strikes using ONLY valid IV data
  const targetOTMPct = 0.10;
  const otmCallTarget = spotPrice * (1 + targetOTMPct);
  const otmPutTarget = spotPrice * (1 - targetOTMPct);

  const callsWithIV = calls.filter((c) => validIV(c.impliedVolatility) && c.strike);
  const putsWithIV = puts.filter((p) => validIV(p.impliedVolatility) && p.strike);

  const closestCall = callsWithIV.filter((c) => c.strike >= spotPrice)
    .reduce((closest, c) => !closest || Math.abs(c.strike - otmCallTarget) < Math.abs(closest.strike - otmCallTarget) ? c : closest, null);
  const closestPut = putsWithIV.filter((p) => p.strike <= spotPrice)
    .reduce((closest, p) => !closest || Math.abs(p.strike - otmPutTarget) < Math.abs(closest.strike - otmPutTarget) ? p : closest, null);
  // ATM IV — average of ATM call + put if both available, else whichever exists
  const atmCall = callsWithIV.reduce((closest, c) => !closest || Math.abs(c.strike - spotPrice) < Math.abs(closest.strike - spotPrice) ? c : closest, null);
  const atmPut = putsWithIV.reduce((closest, p) => !closest || Math.abs(p.strike - spotPrice) < Math.abs(closest.strike - spotPrice) ? p : closest, null);

  let ivATM = null;
  if (atmCall && atmPut) ivATM = +(((atmCall.impliedVolatility + atmPut.impliedVolatility) / 2) * 100).toFixed(1);
  else if (atmCall) ivATM = +(atmCall.impliedVolatility * 100).toFixed(1);
  else if (atmPut) ivATM = +(atmPut.impliedVolatility * 100).toFixed(1);

  // Stable ATM IV from a longer-dated expiry (~30 days) to avoid the IV collapse
  // problem on very short-dated chains. This is the "real" annualized IV reading.
  let ivATMLong = null;
  let ivATMLongDays = null;
  if (optChain._longChain?.options?.[0]) {
    const longExpiry = optChain._longChain.options[0];
    const longCalls = (longExpiry.calls || []).filter((c) => validIV(c.impliedVolatility) && c.strike);
    const longPuts = (longExpiry.puts || []).filter((p) => validIV(p.impliedVolatility) && p.strike);
    const longAtmCall = longCalls.reduce((closest, c) => !closest || Math.abs(c.strike - spotPrice) < Math.abs(closest.strike - spotPrice) ? c : closest, null);
    const longAtmPut = longPuts.reduce((closest, p) => !closest || Math.abs(p.strike - spotPrice) < Math.abs(closest.strike - spotPrice) ? p : closest, null);
    if (longAtmCall && longAtmPut) ivATMLong = +(((longAtmCall.impliedVolatility + longAtmPut.impliedVolatility) / 2) * 100).toFixed(1);
    else if (longAtmCall) ivATMLong = +(longAtmCall.impliedVolatility * 100).toFixed(1);
    else if (longAtmPut) ivATMLong = +(longAtmPut.impliedVolatility * 100).toFixed(1);
    if (longExpiry.expirationDate) ivATMLongDays = Math.round((longExpiry.expirationDate * 1000 - Date.now()) / (1000 * 60 * 60 * 24));
  }

  const ivOTMPut = closestPut ? +(closestPut.impliedVolatility * 100).toFixed(1) : null;
  const ivOTMCall = closestCall ? +(closestCall.impliedVolatility * 100).toFixed(1) : null;
  const skew = (ivOTMPut != null && ivOTMCall != null) ? +(ivOTMPut - ivOTMCall).toFixed(1) : null;

  // Skew curve data — use ONLY puts on the left side of spot and ONLY calls on the right.
  // This avoids the zig-zag where put-IV and call-IV at the same strike overlap.
  const putsLeft = putsWithIV.filter((p) => p.strike < spotPrice);
  const callsRight = callsWithIV.filter((c) => c.strike >= spotPrice);
  const skewCurve = [...putsLeft, ...callsRight]
    .map((c) => ({
      strike: c.strike,
      iv: +(c.impliedVolatility * 100).toFixed(1),
      moneyness: +((c.strike / spotPrice - 1) * 100).toFixed(1),
    }))
    .sort((a, b) => a.strike - b.strike);

  const expiryDate = expiry.expirationDate ? new Date(expiry.expirationDate * 1000).toISOString().slice(0, 10) : null;
  const daysToExpiry = expiry.expirationDate ? Math.round((expiry.expirationDate * 1000 - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  // Expected move (1 standard deviation) = spot × IV × sqrt(days/365)
  // Uses long-dated IV (more reliable). Falls back to short-dated.
  const ivForMove = ivATMLong ?? ivATM;
  const daysForMove = ivATMLong != null ? ivATMLongDays : daysToExpiry;
  let expectedMove = null;
  if (ivForMove != null && daysForMove != null && daysForMove > 0 && spotPrice) {
    const moveDollar = spotPrice * (ivForMove / 100) * Math.sqrt(daysForMove / 365);
    expectedMove = {
      dollar: +moveDollar.toFixed(2),
      pct: +((moveDollar / spotPrice) * 100).toFixed(2),
      low: +(spotPrice - moveDollar).toFixed(2),
      high: +(spotPrice + moveDollar).toFixed(2),
      days: daysForMove,
    };
  }

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
    ivATMLong,
    ivATMLongDays,
    ivOTMPut,
    ivOTMCall,
    skew,
    skewCurve,
    topStrikes,
    expectedMove,
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

  // ====== Finnhub historical valuation series (free, ALREADY in the response we fetch) ======
  // The /stock/metric endpoint returns `series.quarterly` with historical PE/PS/PB time series.
  // Free tier may sometimes return empty arrays — code below handles that gracefully.
  const seriesQ = metrics?.series?.quarterly || {};
  // Try multiple possible key names Finnhub has used for TTM P/E over the years
  const pickFirstSeries = (obj, keys) => {
    for (const k of keys) {
      const arr = obj?.[k];
      if (Array.isArray(arr) && arr.length) return { key: k, arr };
    }
    return null;
  };
  const peSeriesPick = pickFirstSeries(seriesQ, ["pe", "peTTM", "peBasicExclExtraTTM", "peInclExtraTTM", "peNormalizedAnnual"]);
  const psSeriesPick = pickFirstSeries(seriesQ, ["psTTM", "ps"]);
  const pbSeriesPick = pickFirstSeries(seriesQ, ["pb", "pbAnnual", "pbQuarterly"]);
  const epsSeriesPick = pickFirstSeries(seriesQ, ["epsBasicExclExtraItemsTTM", "epsBasicExclExtraTTM", "epsTTM", "epsInclExtraTTM", "epsNormalizedAnnual"]);

  const normalizeSeries = (arr) => arr
    .filter((e) => e?.period && typeof e?.v === "number" && isFinite(e.v))
    .map((e) => ({ period: e.period, v: +e.v.toFixed(2) }))
    .sort((a, b) => new Date(a.period).getTime() - new Date(b.period).getTime());

  const valuationSeries = {
    pe: peSeriesPick ? { key: peSeriesPick.key, data: normalizeSeries(peSeriesPick.arr).filter((e) => e.v > 0) } : { key: null, data: [] },
    ps: psSeriesPick ? { key: psSeriesPick.key, data: normalizeSeries(psSeriesPick.arr).filter((e) => e.v > 0) } : { key: null, data: [] },
    pb: pbSeriesPick ? { key: pbSeriesPick.key, data: normalizeSeries(pbSeriesPick.arr).filter((e) => e.v > 0) } : { key: null, data: [] },
    eps: epsSeriesPick ? { key: epsSeriesPick.key, data: normalizeSeries(epsSeriesPick.arr) } : { key: null, data: [] },
  };

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
  const epsHistory = earningsHistoryArr.map((e) => {
    // Yahoo's `quarter` field has shape { raw: epoch_seconds, fmt: "yyyy-mm-dd" }
    // We store as ISO date string for stable sorting and deduplication across runs.
    const qRaw = e?.quarter?.raw;
    const quarter = qRaw ? new Date(qRaw * 1000).toISOString().slice(0, 10) : (e?.quarter?.fmt || null);
    return {
      quarter,
      actual: v(e, "epsActual"), estimate: v(e, "epsEstimate"),
      surprise: v(e, "epsDifference"), surprisePct: v(e, "surprisePercent"),
    };
  }).filter((e) => e.actual != null);
  const epsValues = epsHistory.map((e) => e.actual).filter((x) => x != null);
  const epsMean = epsValues.length ? epsValues.reduce((s, x) => s + x, 0) / epsValues.length : null;
  const epsStdev = epsValues.length > 1 ? Math.sqrt(epsValues.reduce((s, x) => s + (x - epsMean) ** 2, 0) / epsValues.length) : null;
  const epsCoefVar = epsMean && epsStdev ? Math.abs(epsStdev / epsMean) : null;

  // ===== Quarterly EPS with labels (estimate vs actual) =====
  // Yahoo's "earnings.earningsChart.quarterly" gives compact labels like "1Q2026" but
  // these labels can sometimes lag actual fiscal year (Yahoo's API quirk).
  // We derive fiscal labels from each quarter's endDate ourselves, using the company's
  // fiscal year end month from defaultKeyStatistics.
  // Get fiscal year end month (1-12). Default to December if missing (calendar year).
  const fyEndTs = v(ks, "lastFiscalYearEnd");
  let fyEndMonth = 12;
  if (fyEndTs) {
    // Yahoo timestamp is in seconds
    const fyEndDate = new Date(fyEndTs * 1000);
    fyEndMonth = fyEndDate.getUTCMonth() + 1; // 1-12
  }
  // For a calendar date, compute fiscal year and fiscal quarter.
  // Fiscal year N = year ending in fyEndMonth of calendar year N.
  // (NVDA's FY ends January, so calendar Jan 2026 = end of FY26.)
  // A quarter ending in calendar month M of year Y belongs to:
  //   if M <= fyEndMonth: fiscal year Y
  //   else: fiscal year Y + 1
  // And fiscal quarter = ((M - fyEndMonth - 1 + 12) % 12) / 3 + 1, rounded
  const calToFiscal = (yr, mo) => {
    const Y = parseInt(yr, 10);
    const M = parseInt(mo, 10);
    // Fiscal year
    const fy = M <= fyEndMonth ? Y : Y + 1;
    // Fiscal quarter: count quarters from fiscal year start
    // Fiscal year starts month = fyEndMonth + 1 (or 1 if fyEndMonth is 12)
    // We want to know which fiscal quarter this calendar month belongs to.
    // Easier: count quarters since fiscal year start.
    const fyStartMonth = (fyEndMonth % 12) + 1; // month after fyEnd
    const monthsSinceFyStart = ((M - fyStartMonth + 12) % 12);
    const fq = Math.floor(monthsSinceFyStart / 3) + 1;
    return { fq, fy };
  };
  const fiscalLabelFromDate = (endDateStr) => {
    if (!endDateStr) return null;
    const [yr, mo] = endDateStr.split("-");
    if (!yr || !mo) return null;
    const { fq, fy } = calToFiscal(yr, mo);
    return `Q${fq} FY${String(fy).slice(-2)}`;
  };

  // ===== Build EPS quarters with correct fiscal labels =====
  // Yahoo's earningsChart.quarterly doesn't include endDate, just compact label like "1Q2026".
  // We can't reliably derive fiscal year from these. Instead, match against
  // incomeStatementHistoryQuarterly which DOES have endDate.
  const incomeQ = summary?.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
  // Map endDates (most recent first) to fiscal labels
  const fiscalLabels = incomeQ.map((row) => fiscalLabelFromDate(row.endDate?.fmt));

  const epsQuartersRaw = summary?.earnings?.earningsChart?.quarterly || [];
  // Take the most recent 5 EPS quarters and pair them with the corresponding fiscal labels.
  // Both arrays should be in order (oldest first for earningsChart, most recent first for incomeQ).
  // We reverse fiscalLabels so they're oldest-first, then align by position from the END.
  const fiscalLabelsOldestFirst = [...fiscalLabels].reverse();
  const epsTail = epsQuartersRaw.slice(-5);
  // Use the END-aligned fiscal labels (i.e., last EPS quarter pairs with last fiscal label)
  const epsQuarters = epsTail.map((q, i) => {
    // index from the END (last EPS quarter = last fiscal label, second-to-last = second-to-last, etc.)
    const indexFromEnd = epsTail.length - 1 - i;
    const fiscalLabel = fiscalLabelsOldestFirst[fiscalLabelsOldestFirst.length - 1 - indexFromEnd] || null;
    return {
      label: fiscalLabel || (q.date ? `Q${q.date[0]} FY${String(q.date.slice(2)).slice(-2)}` : null),
      rawLabel: q.date || null,
      estimate: v(q, "estimate") ?? null,
      actual: v(q, "actual") ?? null,
    };
  }).filter((q) => q.label);
  // Add forward quarter estimate (one quarter AFTER the last actual)
  const nextQEstimate = v(summary?.earnings?.earningsChart, "currentQuarterEstimate");
  if (nextQEstimate != null && epsQuarters.length > 0) {
    // Derive next quarter's label by incrementing the last quarter
    const last = epsQuarters[epsQuarters.length - 1];
    const lm = String(last.label).match(/^Q(\d) FY(\d{2})$/);
    if (lm) {
      let q = parseInt(lm[1], 10) + 1;
      let fy = parseInt(lm[2], 10);
      if (q > 4) { q = 1; fy += 1; }
      epsQuarters.push({ label: `Q${q} FY${String(fy).padStart(2, "0")}`, estimate: nextQEstimate, actual: null });
    }
  }

  // ===== Quarterly Revenue + Earnings (Net Income) with fiscal labels =====
  const revEarnQuarters = incomeQ.slice(0, 5).map((row) => ({
    label: fiscalLabelFromDate(row.endDate?.fmt),
    revenue: v(row, "totalRevenue") ?? null,
    earnings: v(row, "netIncome") ?? null,
  })).filter((r) => r.label && (r.revenue != null || r.earnings != null)).reverse();

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

  // Stock-based compensation as % of revenue. Buffett's pet metric.
  // Yahoo's cashflowStatementHistory has stockBasedCompensation in the most recent annual.
  const cashflows = summary?.cashflowStatementHistory?.cashflowStatements || [];
  const income = summary?.incomeStatementHistory?.incomeStatementHistory || [];
  const sbcRaw = cashflows.length ? v(cashflows[0], "stockBasedCompensation") : null;
  const revAnnual = income.length ? v(income[0], "totalRevenue") : null;
  const sbcPctRev = (sbcRaw != null && revAnnual && revAnnual > 0) ? +((sbcRaw / revAnnual) * 100).toFixed(2) : null;

  const lynchData = {
    category: lynchCategory,
    epsGrowthNextYr: epsGrowthNext != null ? epsGrowthNext * 100 : null,
    epsGrowth5Yr: fiveYrGrowth != null ? fiveYrGrowth * 100 : null,
    epsCoefVar: epsCoefVar != null ? +epsCoefVar.toFixed(3) : null,
    epsHistory: epsHistory.slice(0, 8),
    epsQuarters,         // labeled quarterly EPS with estimate/actual
    revEarnQuarters,     // labeled quarterly revenue + earnings
    fyEndMonth,          // fiscal year end month (1-12), for computing fiscal quarter months
    insiderBuys, insiderSells,
    insiderBuyValue: Math.round(insiderBuyValue),
    insiderSellValue: Math.round(insiderSellValue),
    netInsiderActivity: insiderBuyValue - insiderSellValue,
    heldByInsiders: v(ks, "heldPercentInsiders"),
    heldByInstitutions: v(ks, "heldPercentInstitutions"),
    shortRatio: v(ks, "shortRatio"),
    shortPctFloat: v(ks, "shortPercentOfFloat"),
    pegRatio: v(ks, "pegRatio") ?? v(ks, "trailingPegRatio") ?? m.pegRatio ?? null,
    sbcPctRevenue: sbcPctRev,
    sbcRaw,
  };

  const simonsData = candles1Y && candles1Y.length >= 50 ? computeSimonsMetrics(candles1Y) : null;

  // ============ DERIVED METRICS ============
  // Yahoo returns debtToEquity as a percentage (e.g., 6.55 = 6.55%, not a ratio of 6.55).
  // Most US financial sites express it as a decimal ratio. We normalize: if Yahoo's value
  // is > 2 we assume percentage and divide by 100. This catches the Yahoo glitch but leaves
  // legitimate ratios alone (most companies have D/E < 2 anyway).
  let debtEqRaw = v(fd, "debtToEquity") ?? m["totalDebt/totalEquityAnnual"] ?? null;
  const debtEqNormalized = (debtEqRaw != null && debtEqRaw > 2) ? +(debtEqRaw / 100).toFixed(3) : debtEqRaw;

  // FCF yield = trailing 12-month FCF / market cap. Buffett's "owner earnings yield."
  const fcfRaw = v(fd, "freeCashflow");
  const fcfYield = (fcfRaw != null && mcapRaw && mcapRaw > 0) ? +((fcfRaw / mcapRaw) * 100).toFixed(2) : null;

  // Earnings yield = 1 / P/E. Flip of P/E. Compare to bond yields.
  const peTTM = v(sd, "trailingPE") ?? m.peBasicExclExtraTTM ?? m.peTTM ?? null;
  const earningsYield = (peTTM != null && peTTM > 0) ? +(100 / peTTM).toFixed(2) : null;

  // ROIC approximation. True ROIC = NOPAT / Invested Capital. We don't have NOPAT
  // directly, so use Yahoo's `returnOnAssets` if present, falling back to a rough
  // approximation: ROE * (1 - debt_share_of_capital). Not perfect but useful.
  let roicApprox = m.roiTTM ?? null;
  if (roicApprox == null) {
    const roa = v(fd, "returnOnAssets");
    if (roa != null) roicApprox = +(roa * 100).toFixed(2);
  }
  if (roicApprox == null) {
    const roeRaw = v(fd, "returnOnEquity");
    const dRatio = debtEqNormalized;
    if (roeRaw != null && dRatio != null) {
      const equityShare = 1 / (1 + dRatio);
      roicApprox = +(roeRaw * 100 * equityShare).toFixed(2);
    }
  }

  // ============ OPTIONS ============
  const spotPrice = quote?.c ?? options?.quote?.regularMarketPrice ?? null;
  const optionsData = options && spotPrice ? computeOptionsMetrics(options, spotPrice) : null;

  // ============ CATALYSTS ============
  const ce = summary?.calendarEvents || {};
  // Yahoo's earningsDate field can be an array, object, raw number, or string depending on the ticker.
  // Safely extract a Unix timestamp (seconds) from whatever shape it is.
  const extractTs = (obj) => {
    if (obj == null) return null;
    if (typeof obj === "number" && isFinite(obj) && obj > 1e8) return obj; // looks like a unix seconds timestamp
    if (typeof obj === "string") {
      const parsed = Date.parse(obj);
      return isNaN(parsed) ? null : Math.floor(parsed / 1000);
    }
    if (Array.isArray(obj) && obj.length) return extractTs(obj[0]);
    if (typeof obj === "object") {
      if (obj.raw != null) return extractTs(obj.raw);
      if (obj.fmt) return extractTs(obj.fmt);
    }
    return null;
  };
  // Convert a timestamp to "YYYY-MM-DD" — returns null if invalid (avoids the "Invalid time value" crash)
  const tsToDate = (ts) => {
    if (ts == null || !isFinite(ts)) return null;
    try {
      const d = new Date(ts * 1000);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    } catch (e) { return null; }
  };
  const tsToDays = (ts) => {
    if (ts == null || !isFinite(ts)) return null;
    try {
      return Math.round((ts * 1000 - Date.now()) / (1000 * 60 * 60 * 24));
    } catch (e) { return null; }
  };

  const earningsTs = extractTs(ce.earnings?.earningsDate);
  const exDivTs = extractTs(ce.exDividendDate);
  const divDateTs = extractTs(ce.dividendDate);

  const HYPERSCALER_DEPS = {
    NVDA: ["MSFT", "META", "GOOGL", "AMZN", "ORCL"],
    AMD:  ["MSFT", "META", "GOOGL", "AMZN", "ORCL"],
    AVGO: ["MSFT", "META", "GOOGL", "AMZN"],
    TSM:  ["NVDA", "AAPL", "AMD", "AVGO", "QCOM"],
    MU:   ["NVDA", "AMD", "MSFT", "META", "GOOGL"],
    MRVL: ["AMZN", "GOOGL", "META", "MSFT"],
    ASML: ["TSM", "NVDA", "INTC"],
    ARM:  ["AAPL", "QCOM", "NVDA"],
    SMCI: ["NVDA", "AMD", "MSFT", "META"],
    ANET: ["MSFT", "META", "GOOGL", "AMZN"],
    DELL: ["NVDA", "AMD", "MSFT"],
    VRT:  ["MSFT", "GOOGL", "AMZN", "META"],
    PLTR: ["MSFT", "GOOGL", "AMZN"],
    CRWD: ["MSFT", "GOOGL", "AMZN"],
    PANW: ["MSFT", "GOOGL", "AMZN"],
    NBIS: ["NVDA", "MSFT"],
    VST:  ["MSFT", "GOOGL", "AMZN", "META", "NVDA"],
    CEG:  ["MSFT", "GOOGL", "AMZN", "META", "NVDA"],
  };
  const catalystsData = {
    earningsDate: tsToDate(earningsTs),
    daysToEarnings: tsToDays(earningsTs),
    exDividendDate: tsToDate(exDivTs),
    dividendPaymentDate: tsToDate(divDateTs),
    epsEstimate: v(ce, "earnings", "earningsAverage"),
    epsLow: v(ce, "earnings", "earningsLow"),
    epsHigh: v(ce, "earnings", "earningsHigh"),
    revEstimate: v(ce, "earnings", "revenueAverage"),
    hyperscalerWatch: HYPERSCALER_DEPS[t.symbol] || [],
  };

  // ============ AI SUMMARY ============
  const summaryData = buildStockSummary({
    symbol: t.symbol,
    pe: v(sd, "trailingPE") ?? m.peBasicExclExtraTTM ?? null,
    fwdPe: v(ks, "forwardPE") ?? v(sd, "forwardPE") ?? null,
    pegRatio: lynchData.pegRatio,
    revGrowthPct: v(fd, "revenueGrowth") != null ? v(fd, "revenueGrowth") * 100 : null,
    roePct: v(fd, "returnOnEquity") != null ? v(fd, "returnOnEquity") * 100 : null,
    fcfYield,
    earningsYield,
    insiderNet: lynchData.netInsiderActivity,
    insiderBuys: lynchData.insiderBuys,
    insiderSells: lynchData.insiderSells,
    pcrVolume: optionsData?.pcrVolume,
    consensusRating: rating,
    consensusScore: score,
    targetMean: v(fd, "targetMeanPrice"),
    currentPrice: quote?.c ?? null,
    week52High: v(sd, "fiftyTwoWeekHigh"),
    week52Low: v(sd, "fiftyTwoWeekLow"),
    daysToEarnings: catalystsData.daysToEarnings,
    debtEq: debtEqNormalized,
    sector: t.sector,
    lynchCategory: lynchData.category,
  });

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
    valuationSeries,  // Finnhub historical P/E, P/S, P/B quarterly series (may be empty on free tier)
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
      roic: roicApprox,
      debtEq: debtEqNormalized,
      eps: v(ks, "trailingEps") ?? m.epsBasicExclExtraItemsTTM ?? null,
      epsForward: v(ks, "forwardEps"),
      earningsYield,
      fcfYield,
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
    catalysts: catalystsData,
    summary: summaryData,
    peerData,
  };
}

// ============ AI SUMMARY GENERATOR ============
// Rule-based stock summary computed from already-fetched signals.
// Categorizes the stock across 5 dimensions and writes a plain-English paragraph
// plus actionable bullets. NOT an LLM — just smart synthesis of the existing data.
function buildStockSummary(d) {
  const bullets = [];
  const flags = [];
  const positives = [];
  const negatives = [];

  // ====== LAYER 1: Business quality ======
  let businessGrade = "—";
  if (d.roePct != null && d.revGrowthPct != null) {
    if (d.roePct > 30 && d.revGrowthPct > 20) businessGrade = "Exceptional";
    else if (d.roePct > 15 && d.revGrowthPct > 10) businessGrade = "Strong";
    else if (d.roePct > 8 && d.revGrowthPct > 0) businessGrade = "Decent";
    else if (d.roePct < 5 || d.revGrowthPct < -5) businessGrade = "Weak";
    else businessGrade = "Average";
  }
  if (businessGrade === "Exceptional" || businessGrade === "Strong") {
    positives.push(`${businessGrade.toLowerCase()} business quality (ROE ${d.roePct?.toFixed(0)}%, revenue ${d.revGrowthPct > 0 ? "+" : ""}${d.revGrowthPct?.toFixed(0)}%)`);
  }
  if (businessGrade === "Weak") {
    negatives.push(`weak business metrics (ROE ${d.roePct?.toFixed(0)}%, revenue ${d.revGrowthPct?.toFixed(0)}%)`);
  }

  // ====== LAYER 2: Valuation ======
  let valuationGrade = "—";
  if (d.pegRatio != null && d.pegRatio > 0) {
    if (d.pegRatio < 1) valuationGrade = "Cheap vs growth";
    else if (d.pegRatio < 1.5) valuationGrade = "Fair";
    else if (d.pegRatio < 2.5) valuationGrade = "Premium";
    else valuationGrade = "Expensive";
  }
  if (valuationGrade === "Cheap vs growth") positives.push(`PEG ${d.pegRatio.toFixed(2)} (Lynch: under 1 is cheap)`);
  if (valuationGrade === "Expensive") negatives.push(`PEG ${d.pegRatio.toFixed(2)} (expensive vs growth rate)`);
  if (d.earningsYield != null && d.earningsYield < 4) {
    negatives.push(`earnings yield ${d.earningsYield.toFixed(1)}% below 10Y Treasury (~4.4%)`);
  }
  if (d.fcfYield != null && d.fcfYield > 5) positives.push(`generous FCF yield ${d.fcfYield.toFixed(1)}%`);
  if (d.fcfYield != null && d.fcfYield < 1.5 && d.fcfYield > 0) negatives.push(`low FCF yield ${d.fcfYield.toFixed(1)}% (paying premium for growth)`);

  // ====== LAYER 3: Street sentiment ======
  if (d.consensusScore != null) {
    if (d.consensusScore >= 4.3) positives.push(`strong analyst conviction (${d.consensusRating}, ${d.consensusScore.toFixed(1)}/5)`);
    else if (d.consensusScore <= 2.5) negatives.push(`weak analyst conviction (${d.consensusRating})`);
  }
  let upsidePct = null;
  if (d.targetMean && d.currentPrice) {
    upsidePct = ((d.targetMean - d.currentPrice) / d.currentPrice) * 100;
    if (upsidePct > 20) positives.push(`${upsidePct.toFixed(0)}% upside to analyst target ($${d.targetMean.toFixed(0)})`);
    if (upsidePct < -5) negatives.push(`trading ${Math.abs(upsidePct).toFixed(0)}% above analyst target`);
  }

  // ====== LAYER 4: Positioning / options sentiment ======
  if (d.pcrVolume != null) {
    if (d.pcrVolume < 0.4) {
      flags.push(`Options crowd extremely bullish (PCR ${d.pcrVolume.toFixed(2)}) — contrarian warning`);
    } else if (d.pcrVolume > 1.8) {
      flags.push(`Options crowd extremely bearish (PCR ${d.pcrVolume.toFixed(2)}) — possible bottom signal`);
    }
  }

  // ====== LAYER 5: Risks ======
  if (d.insiderNet != null && d.insiderNet < -100e6 && (d.insiderBuys ?? 0) === 0) {
    const m = Math.abs(d.insiderNet) >= 1e9 ? `$${(Math.abs(d.insiderNet)/1e9).toFixed(1)}B` : `$${(Math.abs(d.insiderNet)/1e6).toFixed(0)}M`;
    flags.push(`Heavy insider selling (${m} sold, zero bought in 6 months)`);
  }
  if (d.debtEq != null && d.debtEq > 2) {
    flags.push(`Elevated leverage (D/E ${d.debtEq.toFixed(2)})`);
  }
  if (d.week52High && d.currentPrice && (d.currentPrice / d.week52High) > 0.97) {
    flags.push(`Trading near 52-week high (limited room to run)`);
  }
  if (d.daysToEarnings != null && d.daysToEarnings >= 0 && d.daysToEarnings <= 14) {
    flags.push(`Earnings in ${d.daysToEarnings} day${d.daysToEarnings === 1 ? "" : "s"} (high volatility window)`);
  }

  // ====== Compose verdict ======
  let stance = "Mixed";
  let stanceColor = "neutral";
  const pos = positives.length;
  const neg = negatives.length + flags.length;
  if (pos >= 3 && neg <= 1) { stance = "Constructive"; stanceColor = "positive"; }
  else if (pos >= 2 && neg <= 2) { stance = "Cautiously positive"; stanceColor = "positive"; }
  else if (neg >= 3 && pos <= 1) { stance = "Cautious"; stanceColor = "negative"; }
  else if (neg >= 4) { stance = "Negative"; stanceColor = "negative"; }

  // Build prose paragraph
  let paragraph = `${d.symbol} reads as a `;
  if (d.lynchCategory && d.lynchCategory !== "—") paragraph += `${d.lynchCategory.toLowerCase()} in ${d.sector?.toLowerCase() || "its sector"}`;
  else paragraph += `${d.sector?.toLowerCase() || "stock"}`;
  paragraph += `. Business quality is ${businessGrade.toLowerCase()}`;
  if (valuationGrade !== "—") paragraph += `, valuation is ${valuationGrade.toLowerCase()}`;
  paragraph += `. `;
  if (d.consensusRating) paragraph += `Street is ${d.consensusRating.toLowerCase()}`;
  if (upsidePct != null) paragraph += ` with ${upsidePct >= 0 ? "+" : ""}${upsidePct.toFixed(0)}% to consensus target`;
  paragraph += `. `;
  if (flags.length > 0) paragraph += `Notable risks: ${flags.length} flag${flags.length > 1 ? "s" : ""} (see below).`;
  else paragraph += `No major risk flags.`;

  return {
    stance,
    stanceColor,
    paragraph,
    businessGrade,
    valuationGrade,
    positives,
    negatives,
    flags,
    upsidePct,
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
  // Sortino: like Sharpe but only counts downside volatility (returns < 0).
  // Better metric for assets with big upside moves (e.g., NVDA).
  const downside = returns.filter((r) => r < 0);
  const sortino = (() => {
    if (downside.length < 5) return null;
    const dsq = downside.reduce((s, x) => s + x * x, 0) / downside.length;
    const downsd = Math.sqrt(dsq);
    return downsd ? +(meanR / downsd * Math.sqrt(252)).toFixed(2) : null;
  })();
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

  // Historical VaR & CVaR using actual return distribution (more accurate than parametric for fat tails).
  // 95% 1-day VaR: the 5th percentile of daily returns. Translated to a positive "loss %" number.
  // CVaR: average of the returns BELOW that threshold (the average bad-day loss).
  const sorted = [...returns].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))];
  const var95daily = sorted.length >= 20 ? -pct(0.05) : null;
  const var99daily = sorted.length >= 100 ? -pct(0.01) : null;
  // CVaR = mean of losses worse than VaR threshold
  const tailSet = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05)));
  const cvar95daily = tailSet.length ? -(tailSet.reduce((s, x) => s + x, 0) / tailSet.length) : null;
  // 5-day VaR using sqrt-time scaling (approximation valid for uncorrelated returns)
  const var955day = var95daily != null ? var95daily * Math.sqrt(5) : null;

  return {
    autocorrLag1: autocorr(1), autocorrLag5: autocorr(5), autocorrLag20: autocorr(20),
    atr14: atr, maxDrawdown: +(mdd * 100).toFixed(2),
    sharpe1Y: sharpe, sortino1Y: sortino, obvTrend, dowAvgReturns: dowAvg,
    var95daily: var95daily != null ? +(var95daily * 100).toFixed(2) : null,
    var99daily: var99daily != null ? +(var99daily * 100).toFixed(2) : null,
    cvar95daily: cvar95daily != null ? +(cvar95daily * 100).toFixed(2) : null,
    var955day: var955day != null ? +(var955day * 100).toFixed(2) : null,
  };
}

async function main() {
  console.log("Initializing Yahoo Finance auth...");
  await ensureYahooAuth();

  const config = JSON.parse(readFileSync("tickers.json", "utf8"));
  const out = { generatedAt: new Date().toISOString(), tickers: [] };

  // ============ MACRO LAYER (fetched FIRST, used for correlations) ============
  console.log("\nFetching macro context (used for correlations)...");
  // STRIP_TICKERS: shown in top macro bar
  // BENCHMARK_TICKERS: used for sector volatility comparison (not shown in strip)
  const MACRO_TICKERS = [
    // Display in strip
    { symbol: "^TNX",     name: "10Y Treasury Yield", explain: "When this rises, growth stocks usually fall. >4.5% is restrictive.", strip: true },
    { symbol: "^VIX",     name: "Volatility Index",   explain: "Market fear gauge. <15 = calm. 15-25 = normal. >30 = fear.", strip: true },
    { symbol: "DX-Y.NYB", name: "Dollar Index",       explain: "Strong dollar hurts US multinationals' overseas revenue.", strip: true },
    { symbol: "SPY",      name: "S&P 500 ETF",        explain: "Overall US market direction.", strip: true, category: "Broad market", vol_label: "S&P 500" },
    { symbol: "QQQ",      name: "NASDAQ-100 ETF",     explain: "Tech-heavy index. Growth stock proxy.", strip: true, category: "Mega tech", vol_label: "Nasdaq-100" },
    { symbol: "SOXX",     name: "Semiconductor ETF",  explain: "Sector context — moves NVDA, AMD, TSM, etc together.", strip: true, category: "Semis", vol_label: "Semis (SOXX)" },
    { symbol: "TLT",      name: "20Y Treasury ETF",   explain: "Bond proxy. Negative correlation with growth stocks.", strip: true, category: "Bonds", vol_label: "Bonds (TLT)" },
    // Used as risk benchmarks (not in strip)
    { symbol: "SMH",      name: "Semi Logic ETF",     category: "Semi Logic",    vol_label: "Semi Logic (SMH)" },
    { symbol: "HBM",      name: "Memory Tech ETF",    category: "Memory/DRAM",   vol_label: "Memory (HBM)" },
    { symbol: "IGV",      name: "Software ETF",       category: "Software",      vol_label: "Software (IGV)" },
    { symbol: "CIBR",     name: "Cybersecurity ETF",  category: "Cybersecurity", vol_label: "Cyber (CIBR)" },
    { symbol: "ARTY",     name: "AI & Big Data ETF",  category: "AI Infra",      vol_label: "AI Infra (ARTY)" },
    { symbol: "XLK",      name: "Technology Sector",  category: "Broad Tech",    vol_label: "Tech (XLK)" },
    { symbol: "OEF",      name: "S&P 100 Mega Cap",   category: "Mega Cap",      vol_label: "Mega Cap (OEF)" },
    { symbol: "MDY",      name: "Mid-Cap ETF",        category: "Mid Cap",       vol_label: "Mid Cap (MDY)" },
    { symbol: "IWM",      name: "Russell 2000",       category: "Small Cap",     vol_label: "Small Cap (IWM)" },
    { symbol: "BITQ",     name: "Crypto Industry",    category: "Crypto Equity", vol_label: "Crypto Cos (BITQ)" },
    { symbol: "IBIT",     name: "iShares Bitcoin",    category: "Bitcoin",       vol_label: "Bitcoin (IBIT)" },
    { symbol: "XLV",      name: "Healthcare Sector",  category: "Healthcare",    vol_label: "Healthcare (XLV)" },
    { symbol: "XLF",      name: "Financial Sector",   category: "Financials",    vol_label: "Financials (XLF)" },
    { symbol: "XLE",      name: "Energy Sector",      category: "Energy",        vol_label: "Energy (XLE)" },
    { symbol: "XLY",      name: "Consumer Disc.",     category: "Consumer Disc", vol_label: "Cons Disc (XLY)" },
    { symbol: "XLP",      name: "Consumer Staples",   category: "Consumer Stpl", vol_label: "Cons Stpl (XLP)" },
    // Dalio All Weather diversifiers (uncorrelated to stocks)
    { symbol: "GLD",      name: "Gold ETF",                 category: "Gold",            vol_label: "Gold (GLD)",         dalio: "Crisis hedge, inflation, currency debasement" },
    { symbol: "DBC",      name: "Commodities ETF",          category: "Commodities",     vol_label: "Commodities (DBC)",  dalio: "Inflation hedge" },
    { symbol: "VEA",      name: "Developed Markets ex-US",  category: "Intl Developed",  vol_label: "Intl Dev (VEA)",     dalio: "Geographic diversification" },
    { symbol: "VWO",      name: "Emerging Markets",         category: "Emerging Markets", vol_label: "Emerging (VWO)",    dalio: "Different macro cycle" },
    { symbol: "IEF",      name: "7-10Y Treasury",           category: "Intermediate Bonds", vol_label: "7-10Y Treas (IEF)", dalio: "All Weather stability sleeve" },
    { symbol: "VNQ",      name: "Real Estate",              category: "Real Estate",     vol_label: "REITs (VNQ)",        dalio: "Inflation hedge, different cycle" },
    { symbol: "BIL",      name: "1-3 Month T-Bills",        category: "Cash",            vol_label: "T-Bills (BIL)",      dalio: "Dry powder, capital preservation" },
    { symbol: "TIP",      name: "TIPS Inflation-Protected", category: "TIPS",            vol_label: "TIPS (TIP)",         dalio: "Inflation protection" },
    // Additional equity diversifiers (for stock-only diversification)
    { symbol: "EWJ",      name: "Japan",                    category: "Japan",           vol_label: "Japan (EWJ)" },
    { symbol: "VGK",      name: "Europe",                   category: "Europe",          vol_label: "Europe (VGK)" },
    { symbol: "INDA",     name: "India",                    category: "India",           vol_label: "India (INDA)" },
    { symbol: "FXI",      name: "China Large Cap",          category: "China",           vol_label: "China (FXI)" },
    { symbol: "VYM",      name: "US Dividend Stocks",       category: "Dividend Value",  vol_label: "Dividend (VYM)" },
    { symbol: "AVUV",     name: "Small Cap Value",          category: "Small Cap Value", vol_label: "SC Value (AVUV)" },
  ];

  // Compute realized daily volatility from a candles series.
  const computeRealizedVol = (candles) => {
    if (!candles || candles.length < 30) return null;
    const closes = candles.slice(-90).map((c) => c.close); // last 90 days
    const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    if (returns.length < 20) return null;
    const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
    const sd = Math.sqrt(returns.reduce((s, x) => s + (x - mean) ** 2, 0) / returns.length);
    // Return daily vol % (not annualized)
    return +(sd * 100).toFixed(2);
  };

  const macroData = {
    fetchedAt: new Date().toISOString(),
    items: [],       // strip items
    benchmarks: [],  // sector vol benchmarks
  };
  // Store macro candles in memory so each ticker can compute correlations
  const macroCandles = {};
  for (const m of MACRO_TICKERS) {
    try {
      const candles = await yahooCandles(m.symbol, "3mo", "1d");
      if (!candles || candles.length < 2) continue;
      macroCandles[m.symbol] = candles;
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const monthStart = candles[Math.max(0, candles.length - 22)];
      const dayChange = ((last.close - prev.close) / prev.close) * 100;
      const monthChange = ((last.close - monthStart.close) / monthStart.close) * 100;
      const dailyVol = computeRealizedVol(candles);
      const entry = {
        symbol: m.symbol,
        name: m.name,
        explain: m.explain,
        value: last.close,
        dayChange: +dayChange.toFixed(2),
        monthChange: +monthChange.toFixed(2),
        dailyVol,
        category: m.category,
        vol_label: m.vol_label,
        dalio: m.dalio,
      };
      if (m.strip) macroData.items.push(entry);
      if (m.category) macroData.benchmarks.push(entry);
      console.log(`  ✓ ${m.symbol}  ${last.close.toFixed(2)}  ${dayChange >= 0 ? "+" : ""}${dayChange.toFixed(2)}%  vol:${dailyVol != null ? dailyVol + "%" : "—"}`);
    } catch (e) {
      console.warn(`  ✗ ${m.symbol} failed: ${e.message}`);
    }
    await sleep(300);
  }
  writeFileSync("public/data/macro.json", JSON.stringify(macroData, null, 2));

  console.log("\nFetching tickers...");
  for (const t of config.tickers) {
    try {
      const data = await fetchTicker(t);
      // Compute correlations vs macro tickers using candles1Y (last 30 trading days)
      data.correlations = computeCorrelations(data.candles, macroCandles);

      // Accumulate EPS history across fetch runs. Yahoo only gives us 4 most recent
      // quarters per call, so we read what we previously saved and merge in the new
      // ones. After 2+ years of running, we naturally build 8-20 quarters of history.
      // We ALSO append a (date, ttmEps, price) snapshot for the historical P/E chart.
      const tickerPath = `public/data/${t.symbol}.json`;
      const todaySnapshot = {
        date: new Date().toISOString().slice(0, 10),
        ttmEps: data.fundamentals?.eps ?? null,         // Yahoo's trailingEps — matches the displayed P/E
        price: data.quote?.current ?? null,
        pe: (data.fundamentals?.eps && data.quote?.current) ? +(data.quote.current / data.fundamentals.eps).toFixed(2) : null,
      };
      try {
        if (existsSync(tickerPath)) {
          const oldData = JSON.parse(readFileSync(tickerPath, "utf8"));
          // EPS history merge
          const oldEps = oldData?.lynch?.epsHistory;
          if (Array.isArray(oldEps) && oldEps.length && data.lynch) {
            const beforeCount = data.lynch.epsHistory?.length || 0;
            data.lynch.epsHistory = mergeEpsHistory(oldEps, data.lynch.epsHistory);
            const afterCount = data.lynch.epsHistory.length;
            if (afterCount > beforeCount) {
              console.log(`    (merged EPS history: ${beforeCount} fresh + ${oldEps.length} stored → ${afterCount} unique quarters)`);
            }
          }
          // P/E snapshot append
          data.peSnapshots = appendPeSnapshot(oldData.peSnapshots, todaySnapshot);
        } else {
          // First time we see this ticker — start the snapshot history with today's point
          data.peSnapshots = appendPeSnapshot([], todaySnapshot);
        }
      } catch (e) {
        console.warn(`    (eps merge / pe snapshot skipped for ${t.symbol}: ${e.message})`);
        data.peSnapshots = data.peSnapshots || appendPeSnapshot([], todaySnapshot);
      }

      writeFileSync(tickerPath, JSON.stringify(data));
      out.tickers.push({
        symbol: t.symbol, name: t.name, sector: t.sector,
        holding: !!t.holding,
        price: data.quote.current, change: data.quote.change, changePct: data.quote.changePct,
        stance: data.summary?.stance || null,
        stanceColor: data.summary?.stanceColor || null,
      });
      const fwd = data.fundamentals.fwdPe;
      const pcr = data.options?.pcrVolume;
      const fwdStr = (typeof fwd === "number" && isFinite(fwd)) ? fwd.toFixed(1) : "—";
      const pcrStr = (typeof pcr === "number" && isFinite(pcr)) ? pcr.toFixed(2) : "—";
      const peSeriesCount = data.valuationSeries?.pe?.data?.length || 0;
      const epsSeriesCount = data.valuationSeries?.eps?.data?.length || 0;
      const histNote = `peHist=${peSeriesCount}q epsHist=${epsSeriesCount}q`;
      console.log(`  ✓ ${t.symbol}  $${data.quote.current ?? "?"}  fwdPE=${fwdStr}  PCR=${pcrStr}  ${histNote}  ${t.holding ? "★" : ""}`);
    } catch (e) {
      console.error(`  ✗ ${t.symbol} failed: ${e.message}`);
    }
    await sleep(1200);
  }

  writeFileSync("public/data/index.json", JSON.stringify(out, null, 2));
  console.log(`\nDone. Wrote ${out.tickers.length} tickers (${out.tickers.filter(x=>x.holding).length} holdings) + macro snapshot.`);
}

// Compute 30-day correlation between this ticker's returns and each macro asset.
function computeCorrelations(candles, macroCandles) {
  if (!candles || candles.length < 30) return null;
  const tickerReturns = computeReturns(candles.slice(-31));
  const out = {};
  for (const [sym, mc] of Object.entries(macroCandles)) {
    if (!mc || mc.length < 31) continue;
    const macroReturns = computeReturns(mc.slice(-31));
    // Align by length (take minimum)
    const n = Math.min(tickerReturns.length, macroReturns.length);
    if (n < 20) continue;
    const a = tickerReturns.slice(-n);
    const b = macroReturns.slice(-n);
    const corr = pearson(a, b);
    if (corr != null) out[sym] = +corr.toFixed(2);
  }
  return Object.keys(out).length ? out : null;
}

function computeReturns(candles) {
  const closes = candles.map((c) => c.close).filter((c) => c != null);
  return closes.slice(1).map((c, i) => Math.log(c / closes[i]));
}

function pearson(a, b) {
  if (a.length !== b.length || a.length < 5) return null;
  const n = a.length;
  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - meanA) * (b[i] - meanB);
    dA += (a[i] - meanA) ** 2;
    dB += (b[i] - meanB) ** 2;
  }
  return dA && dB ? num / Math.sqrt(dA * dB) : null;
}

main().catch((e) => { console.error(e); process.exit(1); });
