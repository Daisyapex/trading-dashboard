# Trading Dashboard

A Bloomberg-style equity terminal that auto-refreshes daily after market close. Tracks technical indicators (SMA, RSI, MACD, Squeeze Momentum), quant/stat-arb signals (Z-score, Hurst exponent, realized vol), value fundamentals (P/E, Forward P/E, PEG, ROE), analyst consensus, and peer comparisons.

Deployed via GitHub Pages. Data refreshes automatically every weekday after the US market close via GitHub Actions — no server, no API key in your browser, completely free to run.

---

## Setup — full walkthrough (no terminal required)

You'll do everything through the GitHub website. Allow yourself ~20 minutes for the first time.

### Step 1 — Create a GitHub account

1. Go to https://github.com and click **Sign up** if you don't have an account. The free tier is all you need.

### Step 2 — Get a free Finnhub API key

1. Go to https://finnhub.io/register and create a free account (no credit card needed).
2. Once logged in, copy your API key from the dashboard. It looks like `cuabc12345xyz...`. Keep this tab open — you'll paste it into GitHub in a minute.

### Step 3 — Create the repository

1. Make sure you're logged into GitHub.
2. Click the **+** in the top-right → **New repository**.
3. Name it `trading-dashboard` (lowercase, with hyphen). **The name must match what's in `vite.config.js`** — if you pick a different name, you'll need to edit that file in step 5.
4. Set it to **Public** (required for free GitHub Pages).
5. **Do not** check "Add a README" — we already have one.
6. Click **Create repository**.

### Step 4 — Upload all the project files

1. On the empty repo page, click **uploading an existing file** (the link in the middle of the page).
2. Drag **all** files and folders from this project into the upload area. Make sure folder structure is preserved — you should see `src/`, `scripts/`, `.github/workflows/`, `public/data/`, and root files like `package.json`, `index.html`, `vite.config.js`, `tickers.json`, `.gitignore`, `README.md`.
3. Scroll down, type "initial commit" in the message box, click **Commit changes**.

   **Note:** The browser upload skips hidden folders by default. After commit, check the repo file list — if you don't see `.github/`, you'll need to add the two workflow files manually. Click **Add file → Create new file**, type `.github/workflows/fetch-data.yml` (the slashes create the folders), paste the contents, commit. Repeat for `deploy.yml`.

### Step 5 — Verify the base path

1. In your repo, click `vite.config.js` → click the pencil icon to edit.
2. Confirm the line reads `base: "/trading-dashboard/",` — must match your repo name **exactly**, with the trailing slash.
3. If you named the repo something else, change it here and click **Commit changes**.

### Step 6 — Add your Finnhub key as a secret

1. In your repo, click **Settings** (top right of the repo nav).
2. In the left sidebar: **Secrets and variables** → **Actions**.
3. Click **New repository secret**.
4. Name: `FINNHUB_KEY` (exactly this — case sensitive, no quotes).
5. Secret: paste your Finnhub API key from Step 2.
6. Click **Add secret**.

### Step 7 — Enable GitHub Pages

1. Still in **Settings**, click **Pages** in the left sidebar.
2. Under **Build and deployment** → **Source**, select **GitHub Actions** (not "Deploy from branch").
3. That's it. The deploy workflow will trigger on the next commit.

### Step 8 — Run the data fetch for the first time

The fetch is scheduled for weekday evenings, but you'll want data immediately:

1. Go to the **Actions** tab of your repo.
2. If you see a banner saying "Workflows aren't being run", click **I understand my workflows, go ahead and enable them**.
3. In the left sidebar, click **Fetch Market Data**.
4. Click the **Run workflow** dropdown on the right → **Run workflow** (green button).
5. Wait ~2–3 minutes. The run appears at the top — click it to watch progress. When it goes green, the data has been fetched and committed back to the repo.

### Step 9 — Wait for the deploy

1. The commit from Step 8 automatically triggers the **Deploy to GitHub Pages** workflow.
2. Go back to **Actions** — you should see it running. Wait for it to complete.
3. Your site is live at `https://YOUR_USERNAME.github.io/trading-dashboard/`. The URL is also shown in **Settings → Pages**.

---

## Adding or removing companies

Edit `tickers.json` directly on GitHub (click the file → pencil icon). The format:

```json
{
  "symbol": "AAPL",
  "name": "Apple Inc.",
  "sector": "Technology",
  "peers": ["MSFT", "GOOGL", "META", "AMZN"]
}
```

Add up to ~30 tickers. Each ticker burns ~10 API calls (one for the ticker plus ~2 per peer), and Finnhub's free tier allows 60/min, so 30 tickers ≈ 5 minutes per fetch. The script throttles itself.

After saving, run **Fetch Market Data** manually (Step 8) to refresh, or wait for the next scheduled run.

---

## How the data flow works

```
GitHub Actions (weekdays, 22:00 UTC)
    │
    ├─→ scripts/fetch.mjs reads tickers.json
    │       │
    │       ├─→ Calls Finnhub for: quote, profile, fundamentals, recommendations
    │       └─→ Calls Yahoo Finance for: 1 year of daily OHLCV
    │
    ├─→ Writes one JSON file per ticker into public/data/
    │
    └─→ Commits the JSON files back to the repo
            │
            └─→ Deploy workflow auto-triggers
                    │
                    └─→ Site rebuilds and deploys to GitHub Pages
```

The browser only ever loads static JSON. No API key is ever exposed.

---

## Files you can edit

| File | What it does |
|------|--------------|
| `tickers.json` | Your watchlist — add/remove companies here |
| `vite.config.js` | The `base` path; only change if you rename the repo |
| `src/App.jsx` | The dashboard UI — colors, layout, panels |
| `scripts/fetch.mjs` | What data gets fetched and saved |
| `.github/workflows/fetch-data.yml` | When the fetch runs (cron schedule) |

The cron `"0 22 * * 1-5"` means "22:00 UTC, Monday–Friday." US market closes at 21:00 UTC, so this gives a 1-hour buffer for end-of-day data to settle. To change frequency, edit that line — for example `"0 22 * * *"` would run every day including weekends (pointless, since markets are closed).

---

## Troubleshooting

**The site loads but says "Cannot load data."**
The fetch workflow hasn't run yet, or it failed. Go to Actions → Fetch Market Data → Run workflow.

**Fetch workflow fails with "FINNHUB_KEY is not set."**
Re-do Step 6. The secret name must be exactly `FINNHUB_KEY`.

**Some tickers show no candle data.**
Yahoo's unofficial endpoint occasionally rate-limits. The script logs which tickers failed — re-run the workflow manually after a few minutes.

**Some fundamentals show "—".**
Not all metrics are returned by Finnhub for every ticker, especially smaller or international names. This is expected.

**404 when I open the site.**
Either the Pages source isn't set to "GitHub Actions" (Step 7), or the `base` in `vite.config.js` doesn't match your repo name (Step 5).

---

## What's NOT live (yet)

A few things in the original demo are stubbed out because Finnhub's free tier doesn't include them — the placeholder values just don't show:

- Analyst price targets and implied upside (paid tier)
- Social sentiment scores (paid tier)
- Insider transaction net flow (limited on free)
- Put/call ratios (not provided)

If you upgrade Finnhub or wire in another API (FMP, Polygon), extend `scripts/fetch.mjs` to pull these and they'll appear automatically.
