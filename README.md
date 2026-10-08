# Stock Watchlist (PWA)

A mobile-first stock watchlist for iPhone with a clean dark theme. It's static files only: plain HTML, CSS and vanilla JS, with no build step, no backend and no CDNs. Market data comes straight from free data APIs using keys you paste into Settings. The keys stay in this browser's `localStorage` on the phone.

## Run locally
```bash
cd stock-watchlist
python3 -m http.server 8000
# open http://localhost:8000
```
The service worker needs `http://localhost` or HTTPS. It won't run from `file://`.

## Features
- **Watchlist:** defaults to the top 50 S&P 500 companies by market cap (`data/default-watchlist.json`). Each row shows the ticker, name (plus live market cap once loaded), price, daily % change (green or red), and a 1-month sparkline. You can sort by market cap, ticker, % change or price (tap ↓/↑ to flip the direction), search by ticker or company name, star favourites and turn on **★ first** to put favourites at the top. **＋** adds a ticker and **Edit** removes them. The list, favourites, sort and filter are saved in `localStorage`.
- **Detail page** (tap a row): price and daily change, then an interactive canvas chart (1D, 5D, 1M, 6M, 1Y, 5Y) with a touch crosshair that shows the price and date. Intraday times are US Eastern (ET). Below that:
  - **Analyst ratings:** strong buy, buy, hold, sell and strong sell counts, a consensus label, and the average score (1 = strong buy … 5 = strong sell, weighted by analyst count).
  - **Price targets:** average, high and low.
  - **Key metrics:** market cap, trailing and forward P/E, EPS, dividend yield, 52-week high and low, beta, volume, revenue, gross, operating and net margins, and the next earnings date.
- **Settings:** API keys (masked, with a Show toggle), DEMO mode, the auto-refresh interval (1, 2 or 5 min, or off), live API usage counters, reset to the default list, and clear cached data.
- **No key yet:** you get a setup screen with links to the sign-up pages, or you can **Try with DEMO data**. DEMO numbers are synthetic and labelled DEMO in the header, a banner, the status line, the chart watermark and the footer.
- A **Delayed data** label with the as-of time of the newest quote (in the phone's time zone), and the footer **Not financial advice**.

## Data sources
| Need | Provider and endpoint | Cache TTL |
|---|---|---|
| Price, daily change, as-of time | Finnhub `/quote` | 1 min |
| Name, shares outstanding (live market cap = price × shares) | Finnhub `/stock/profile2` | 7 days |
| P/E, EPS, dividend yield, 52-week range, beta, 10-day average volume, margins, revenue per share | Finnhub `/stock/metric?metric=all` | 12 h |
| Analyst rating counts (latest month) | Finnhub `/stock/recommendation` | 12 h |
| Next earnings date | Finnhub `/calendar/earnings` (next 200 days) | 12 h |
| Price targets | Finnhub `/stock/price-target`: **premium**. It's tried once per symbol per 12 h, and the 403 is cached. | 12 h |
| Chart 1D | Twelve Data `/time_series` 5-minute bars | 5 min |
| Chart 5D | Twelve Data 30-minute bars | 30 min |
| Chart 1M, 6M and 1Y (one shared request) | Twelve Data daily bars (260) | 6 h |
| Chart 5Y | Twelve Data weekly bars (262) | 24 h |
| Sparklines (1M) | Twelve Data daily bars, batched 6 symbols per request | 12 h |
| Volume (last session) | Last daily (or summed 5-minute) Twelve Data bar | with the chart |

### Free-tier limits and how the app stays inside them
- **Finnhub free:** 60 calls/min (plus Finnhub's documented 30 calls/s burst cap). The app budgets **55 calls/min** with at least 120 ms between calls. Requests go through a priority queue, so whatever you're looking at (the detail page) goes before background list refreshes, and profiles go last. A cold start of 50 tickers is about 50 quote calls plus 50 profile calls, so it takes about 2 minutes to fill completely. Until profiles arrive, rows sort by the snapshot market cap in the default list. Auto-refresh only re-requests quotes older than 1 minute, and only while the list is on screen.
- **Twelve Data free (Basic):** 8 API credits/min and 800/day, 1 credit per symbol per `time_series` call (batch requests cost 1 credit per symbol). Sparklines go out in batches of 6, which leaves room for a chart you open meanwhile. That means 50 sparklines take about 8 minutes on the first run, then come from cache for 12 h. The app counts the day's credits (reset 00:00 UTC) and stops at 800.
- The rolling one-minute call history is saved to `localStorage`, so relaunching the app doesn't reset the budget.
- If a limit is hit anyway (HTTP 429, or Twelve Data's `code: 429`), you get a red banner such as *"Finnhub free limit reached (60 calls/min). Waiting a minute. Showing cached data meanwhile."* The queue pauses and cached values stay on screen.

### Gaps on the free tiers (what shows `n/a`)
- **Price targets (average, high, low): `n/a (not on free tier)`.** Finnhub's price-target endpoint is premium, and no other free, CORS-enabled provider in this combination has them.
- **Forward P/E:** shown only if Finnhub's metric response includes `forwardPE`. If the field is absent, it shows `n/a (not on free tier)`.
- **Revenue (TTM):** uses `revenueTTM` if Finnhub sends it. Otherwise it's derived as revenue per share × shares outstanding and labelled "≈ revenue/share × shares".
- **Volume (last session)** needs the Twelve Data key, because Finnhub's free quote has no volume. The 10-day average volume comes from Finnhub.
- **Charts and sparklines** need the Twelve Data key, because Finnhub candles are premium.
- Where the field exists but is `null` for that company (for example no dividend), it shows `n/a (not reported)`. The app never fills in made-up numbers.

### Providers considered and not used
- **Financial Modeling Prep free:** 250 calls/day and 500 MB per 30 days, end-of-day data only, and its terms need a separate display licence to show the data. 250 calls a day isn't enough to refresh 50 quotes.
- **Alpha Vantage free:** 25 requests/day, which is far too few. Intraday is premium.
- **Tiingo:** sends no CORS headers, so it can't be called from a static site without a proxy.
- **Yahoo Finance:** unofficial and CORS-blocked. It would need someone else's proxy, so it isn't used.

## API keys (you need your own; sign-up is free)
1. **Finnhub** (required for live data): https://finnhub.io/register. Copy the API key from the dashboard.
2. **Twelve Data** (optional, for charts, sparklines and volume): https://twelvedata.com/register (Basic plan, free). Copy the API key from the dashboard.

Paste them into **Settings → API keys** (or the setup screen) on the phone. How the keys are protected:
- They're stored only in `localStorage` (key `stockwatch.keys.v1`) on that device. They are never written to any file in this repo, and never put in cached data or error messages.
- The Finnhub key has to go in the `token` URL parameter, because Finnhub's CORS preflight doesn't allow its header. The Twelve Data key goes in an `Authorization: apikey …` header, so it stays out of URLs.
- The service worker caches API responses under the URL with `token`/`apikey` removed.
- A Content-Security-Policy only allows network calls to the app itself, `finnhub.io` and `api.twelvedata.com`.
- Free keys are personal-use. Anyone holding your phone with the app open can see them under Settings → Show keys.

## Refreshing the default list
`data/default-watchlist.json` holds the top 50 S&P 500 constituents by total market cap, one ticker per company (Alphabet is listed once as GOOGL). It was researched on the `asOf` date in the file, from slickcharts.com/sp500 (constituents) and companiesmarketcap.com (market caps). To refresh it:
```bash
python3 tools/refresh_default_list.py      # optional arg: how many, default 50
```
The script scrapes those two public pages, so check its printed output, and fix the script or edit the JSON by hand if a site has changed. You can also edit the JSON directly: each entry is `{"symbol", "name", "marketCapUSD"}`. `marketCapUSD` is only used to order rows until live data loads. Existing users keep their own list; **Settings → Reset list to default** loads the new one. Bump `SHELL` in `sw.js` after changing any app file.

## Install on iPhone
Open the hosted URL in **Safari**, tap Share, then **Add to Home Screen**. It runs full-screen with the dark status bar, and the app shell works offline after the first load (with cached prices, if any). Your watchlist and keys are tied to the URL (origin). If you change hosts, re-enter the keys.

## Hosting (not done; for you to choose)
**GitHub Pages:** push this folder to a repo, then Settings → Pages → deploy from branch. All paths are relative, so a project subpath like `/stock-watchlist/` works. The code is public, but keys aren't in it. Any static HTTPS host works the same way.

## Tests
```bash
node tests/logic.test.js     # sorting, search, watchlist add/remove/persistence, cache + TTL, formatting, consensus, parsing, rate-limit maths
node tests/api.test.js       # data layer with a fake fetch/clock: caching, dedupe, priority queue, 55/min and 8/min budgets, 429 handling, daily cap, key never cached
node tests/hygiene.test.js   # no local paths, emails, hardcoded keys or CDN; service worker asset list is complete
# Headless iPhone-size check with mocked APIs (needs puppeteer-core on NODE_PATH and Chrome):
python3 -m http.server 8765 &
NODE_PATH=/path/to/node_modules SHOTS_DIR=/tmp/shots node tests/e2e.js   # CHROME_PATH and BASE_URL can be overridden
```
`tests/mocks.js` has the fake API responses. The keys in the tests are obvious placeholders (`FAKE_…`). The e2e run takes about 1.5 minutes because the real rate limiter is in play.

## Files
`index.html`, `styles.css`, `logic.js` (pure logic; also loads in Node), `api.js` (Finnhub + Twelve Data client, rate limiter, cache, DEMO generator), `chart.js` (canvas chart and crosshair), `app.js` (UI), `sw.js`, `manifest.webmanifest`, `favicon.ico`, `data/default-watchlist.json`, `icons/`, `tools/refresh_default_list.py`, `tests/`.

## Limitations
- No live API was called while building this. Signing up for keys wasn't possible, so everything was tested against mocks built from the providers' documented response formats (Twelve Data's format was checked against its public `demo` key). Check a few values against another source once you add real keys. Two things in particular: some Finnhub metric field names (the app tries known alternatives, then shows n/a), and the assumption that Finnhub sends margins and dividend yield as percentages (46.2 = 46.2%).
- Finnhub's free quote is near real-time for US stocks, but the app labels everything as delayed data. Twelve Data bars are in exchange time (ET).
- The first full load of 50 tickers takes about 2 minutes (Finnhub) and about 8 minutes for all sparklines (Twelve Data) because of the free-tier limits. After that, the caches keep it quick.
- Price targets aren't available on any free tier used here.
- No sync between devices, and iOS may clear site storage for apps you haven't opened in weeks (you'd re-enter the keys).
- Not financial advice.
