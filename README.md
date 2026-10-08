# Stock Watchlist (PWA)

A mobile-first stock watchlist and portfolio tracker for iPhone with a clean dark theme. It's static files only: plain HTML, CSS and vanilla JS, with no build step, no backend and no CDNs. Market data comes straight from free data APIs using keys you paste into Settings. The keys, your holdings and your alerts stay in this browser's `localStorage` on the phone.

## Run locally
```bash
cd stock-watchlist
python3 -m http.server 8000
# open http://localhost:8000
```
The service worker needs `http://localhost` or HTTPS. It won't run from `file://`.

## Features
Four tabs at the bottom: **Watchlist**, **Portfolio**, **Earnings** and **Alerts**. Settings is behind the ⚙ button.

- **Watchlist:** defaults to the top 50 S&P 500 companies by market cap (`data/default-watchlist.json`). Each row shows the ticker, name (plus live market cap once loaded), price, daily % change (green or red), and a 1-month sparkline. You can sort by market cap, ticker, % change or price (tap ↓/↑ to flip the direction), search by ticker or company name, star favourites and turn on **★ first** to put favourites at the top. **＋** adds a ticker and **Edit** removes them. The list, favourites, sort and filter are saved in `localStorage`.
- **US / ASX switcher** at the top of the watchlist. The ASX list (`data/asx-watchlist.json`) holds the three ETFs from the portfolio (FANG, SEMI, IVV; starred and pinned on top by default) plus the top 20 ASX companies by market cap. ASX prices are in AUD and are **end-of-day closes** (see *ASX data* below). Each list keeps its own tickers, favourites and sort.
- **Market overview** above the list. US: S&P 500, Nasdaq-100 and Dow, shown through the ETFs that track them (**SPY, QQQ, DIA**, labelled as proxies, ETF prices not index points), plus the top 5 gainers and losers in your watchlist. ASX: ASX 200 through the **STW** ETF (end-of-day close, needs a Marketstack key, otherwise `n/a`) and end-of-day movers in your ASX list.
- **Portfolio:** holdings (ticker, exchange, units, average cost, optional buy date), saved only in `localStorage` (`stockwatch.portfolio.v1`). For each holding: value, cost, unrealised gain/loss in $ and %, today's change and weight; plus totals. Everything is in **AUD**. ASX holdings use the latest close; US holdings are converted at a live **USD/AUD** rate (Twelve Data, or the ECB daily reference rate via Frankfurter if there's no Twelve Data key or it fails), and the rate, its source and as-of time are shown. The cost of a US holding is converted at the same current rate, so the gain is the share-price move only. On first run it's seeded with **FANG, SEMI and IVV (ASX) at 0 units and blank cost**, with a prompt to fill them in. The seed is only the tickers; no amounts are in the code. Holdings with a missing price are left out of the total and listed, never estimated.
- **Earnings:** upcoming earnings in the next 14 days for your US watchlist and portfolio tickers, grouped by date, with before/after market and the EPS estimate when Finnhub has one (`n/a` otherwise). Dates are US Eastern.
- **Alerts:** per ticker (US or ASX), *price rises above*, *price falls below*, or *daily move ≥ ±X%*. Checked on this device when the app opens and on every refresh. A price alert fires once when the level is crossed and re-arms after the price moves back; a move alert fires at most once per trading day. A fired alert shows a banner and a badge on the Alerts tab, and goes into the alert history (last 200). Optional system notifications (Notification API) when you allow them, only while the app is open. On iPhone that needs the app added to the Home Screen (iOS 16.4+). **Background push isn't supported**: alerts while the app is closed would need a server, and this is a static site. The Alerts screen says so. The 🔔 button on a detail page pre-fills a new alert.
- **Detail page** (tap a row): price and daily change, then an interactive canvas chart (1D, 5D, 1M, 6M, 1Y, 5Y) with a touch crosshair that shows the price and date. Intraday times are US Eastern (ET). Below that:
  - **Analyst ratings:** strong buy, buy, hold, sell and strong sell counts, a consensus label, and the average score (1 = strong buy … 5 = strong sell, weighted by analyst count).
  - **Price targets:** average, high and low.
  - **Key metrics:** market cap, trailing and forward P/E, EPS, dividend yield, 52-week high and low, beta, volume, revenue, gross, operating and net margins, and the next earnings date.
  - **News:** company news from the last 7 days (headline, source, time); links open in a new tab with `noopener noreferrer`. Cached 30 min.
  - **ASX tickers:** end-of-day price and a 1M / 6M / 1Y chart of daily closes (1 year of history). 1D, 5D and 5Y are disabled, and ratings, price targets, most metrics, news and earnings show `n/a` with the reason (52-week high/low and last volume are worked out from the closes).
- **Settings:** API keys (masked, with a Show toggle), DEMO mode, the auto-refresh interval (1, 2 or 5 min, or off), the Marketstack monthly request cap, a **calls-used-per-provider** table (Finnhub per minute and today, Twelve Data per minute and today, Marketstack this month, Frankfurter today, and how many requests are queued), reset both lists to default, and clear cached data.
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
| Market overview (US) | Finnhub `/quote` for SPY, QQQ, DIA | 1 min |
| Company news (last 7 days) | Finnhub `/company-news` | 30 min |
| Earnings calendar (14 days) | Finnhub `/calendar/earnings` with no symbol: one call for the whole market, filtered on the phone | 6 h |
| USD/AUD (live) | Twelve Data `/exchange_rate?symbol=USD/AUD` (1 credit) | 10 min |
| USD/AUD (fallback, no key) | Frankfurter `/v1/latest?base=USD&symbols=AUD` (ECB daily reference rate) | 6 h |
| ASX end-of-day closes (list, portfolio, STW proxy) | Marketstack `/v2/eod?symbols=BHP.AX,…` (last 10 days, for the previous close too) | until the next close (6 pm Sydney, trading days) |
| ASX chart (1 year of closes) | Marketstack `/v2/eod?symbols=CBA.AX&date_from=…` | until the next close |

### ASX data: what works for free and what doesn't
Researched October 2026. The app is a static page, so a source has to allow browser (CORS) calls without a server in between.

| Source | ASX on the free tier? | Notes |
|---|---|---|
| **Marketstack free** | **Yes, end-of-day only** | 100 requests/month, about 1 year of history, non-commercial use, CORS allowed (`Access-Control-Allow-Origin: *`). ASX tickers use the `.AX` suffix (exchange `XASX`). **This is what the app uses for ASX.** Optional third key. |
| Twelve Data free (Basic) | No | ASX symbols (`FANG`, `BHP`, `CBA`… on `XASX`) and the ASX 200 index are Pro plan only. Used for US charts and the USD/AUD rate. |
| Finnhub free | No | Quotes for non-US exchanges are a paid tier; company news is North America only; ratings, metrics and earnings cover US companies. |
| Alpha Vantage free | No | No ASX coverage listed, and 25 requests/day. |
| EODHD, Stooq, Tiingo | Not from a browser | No CORS headers (EODHD's free tier is also 20 calls/day). |
| ASX website data, Yahoo Finance | Not usable | Unofficial endpoints, CORS-blocked; they'd need a proxy. |

So, on the free tiers:
- **Works:** ASX end-of-day closes in AUD, the change versus the previous close, a 1-year daily chart, 52-week range from closes, the ASX 200 through the STW ETF's close, ASX holdings valued at the latest close, ASX price alerts checked against closes.
- **Doesn't (shows `n/a` with the reason):** live or intraday ASX prices, 1D/5D/5Y ASX charts, ASX analyst ratings, price targets, fundamentals, news and earnings dates, and the ASX 200 index level itself.
- **Without a Marketstack key**, every ASX price shows `n/a` with an explanation and a button to Settings. No ASX numbers are invented.

**Marketstack budget.** Every symbol in a request counts as a request against the 100/month (the app counts this way to be safe). The app counts per calendar month (UTC) on the device, stops at the cap you set in Settings (default 100), and never goes over it. Your real quota resets on your Marketstack billing date, so the two can drift; the Marketstack dashboard is the source of truth. What spends requests:
- **Portfolio:** ASX holdings with more than 0 units, automatically, but a close is kept until the next ASX close is out (assumed by 6 pm Sydney time on weekdays), so it's at most one request per holding per trading day. The seeded 0-unit ETFs cost nothing.
- **ASX list:** only when you tap **Load closes** (it shows the cost first, e.g. 24 requests for 23 tickers + STW). Nothing ASX loads on a timer.
- **ASX detail page:** 1 request for a year of closes, kept until the next close.

Rough monthly maths: 3 ASX holdings checked every trading day ≈ 66 requests, which leaves about 34 for list loads (24 each) and detail pages. Lower the cap in Settings if you want a hard stop earlier. If you open the app before Marketstack has published that day's close, you'll see the previous close (with its date) until the next day.

### Free-tier limits and how the app stays inside them
- **Finnhub free:** 60 calls/min (plus Finnhub's documented 30 calls/s burst cap). The app budgets **55 calls/min** with at least 120 ms between calls. Requests go through a priority queue, so whatever you're looking at (the detail page) goes before background list refreshes, and profiles go last. A cold start of 50 tickers is about 50 quote calls plus 50 profile calls, so it takes about 2 minutes to fill completely. Until profiles arrive, rows sort by the snapshot market cap in the default list. Auto-refresh only re-requests quotes older than 1 minute, and only while the list is on screen.
- **Twelve Data free (Basic):** 8 API credits/min and 800/day, 1 credit per symbol per `time_series` call (batch requests cost 1 credit per symbol). Sparklines go out in batches of 6, which leaves room for a chart you open meanwhile. That means 50 sparklines take about 8 minutes on the first run, then come from cache for 12 h. The app counts the day's credits (reset 00:00 UTC) and stops at 800.
- The rolling one-minute call history is saved to `localStorage`, so relaunching the app doesn't reset the budget.
- **The visible screen goes first.** Requests are tagged with the screen that asked for them. When you switch tabs (or US/ASX), queued requests for the screen you left are dropped before they're sent, and the new screen's requests go to the front. Priorities, highest first: detail page (quote, chart) → ratings/metrics → overview, news, earnings calendar → visible list rows → portfolio quotes → alert checks → company profiles → sparklines. Alert checks and the FX rate aren't tied to a screen, so they're never dropped.
- **Marketstack:** a monthly budget (above), up to 25 symbols per call and at most 4 calls a second (the limit is 5). **Frankfurter** has no key or published limit; the rate is cached 6 h and only fetched when you hold US shares and have no working Twelve Data key.
- If a limit is hit anyway (HTTP 429, or Twelve Data's `code: 429`), you get a red banner such as *"Finnhub free limit reached (60 calls/min). Waiting a minute. Showing cached data meanwhile."* The queue pauses and cached values stay on screen.

### Gaps on the free tiers (what shows `n/a`)
- **Price targets (average, high, low): `n/a (not on free tier)`.** Finnhub's price-target endpoint is premium, and no other free, CORS-enabled provider in this combination has them.
- **Forward P/E:** shown only if Finnhub's metric response includes `forwardPE`. If the field is absent, it shows `n/a (not on free tier)`.
- **Revenue (TTM):** uses `revenueTTM` if Finnhub sends it. Otherwise it's derived as revenue per share × shares outstanding and labelled "≈ revenue/share × shares".
- **Volume (last session)** needs the Twelve Data key, because Finnhub's free quote has no volume. The 10-day average volume comes from Finnhub.
- **Charts and sparklines** need the Twelve Data key, because Finnhub candles are premium.
- Where the field exists but is `null` for that company (for example no dividend), it shows `n/a (not reported)`. The app never fills in made-up numbers.
- **News** is North American companies only on Finnhub free; other tickers show "No company news in the last 7 days".
- **ASX:** see the table above.

### Providers considered and not used
- **Financial Modeling Prep free:** 250 calls/day and 500 MB per 30 days, end-of-day data only, and its terms need a separate display licence to show the data. 250 calls a day isn't enough to refresh 50 quotes.
- **Alpha Vantage free:** 25 requests/day, which is far too few. Intraday is premium.
- **Tiingo:** sends no CORS headers, so it can't be called from a static site without a proxy.
- **Yahoo Finance:** unofficial and CORS-blocked. It would need someone else's proxy, so it isn't used.

## API keys (you need your own; sign-up is free)
1. **Finnhub** (required for live data): https://finnhub.io/register. Copy the API key from the dashboard.
2. **Twelve Data** (optional, for charts, sparklines, volume and the live USD/AUD rate): https://twelvedata.com/register (Basic plan, free). Copy the API key from the dashboard.
3. **Marketstack** (optional, for ASX end-of-day prices): https://marketstack.com/signup/free (Free plan, 100 requests/month, non-commercial). Copy the access key from the dashboard.

Paste them into **Settings → API keys** (or the setup screen) on the phone. How the keys are protected:
- They're stored only in `localStorage` (key `stockwatch.keys.v1`) on that device. They are never written to any file in this repo, and never put in cached data or error messages.
- The Finnhub key has to go in the `token` URL parameter, because Finnhub's CORS preflight doesn't allow its header. The Marketstack key likewise only works as the `access_key` URL parameter. The Twelve Data key goes in an `Authorization: apikey …` header, so it stays out of URLs. Frankfurter needs no key.
- The service worker caches API responses under the URL with `token`/`apikey`/`access_key` removed.
- A Content-Security-Policy only allows network calls to the app itself, `finnhub.io`, `api.twelvedata.com`, `api.marketstack.com` and `api.frankfurter.dev`.
- Free keys are personal-use. Anyone holding your phone with the app open can see them under Settings → Show keys.

## Refreshing the default lists
`data/default-watchlist.json` holds the top 50 S&P 500 constituents by total market cap, one ticker per company (Alphabet is listed once as GOOGL). It was researched on the `asOf` date in the file, from slickcharts.com/sp500 (constituents) and companiesmarketcap.com (market caps). To refresh it:
```bash
python3 tools/refresh_default_list.py        # US list; optional arg: how many, default 50
python3 tools/refresh_default_list.py --asx  # ASX list: FANG, SEMI, IVV + top N companies (default 20) from marketindex.com.au
```
`data/asx-watchlist.json` was built the same way from marketindex.com.au's ASX company list (market caps in AUD, ETFs excluded from the top 20). Entries are `{"symbol", "name", "marketCapAUD"}`; the snapshot cap only orders the list.
The script scrapes those two public pages, so check its printed output, and fix the script or edit the JSON by hand if a site has changed. You can also edit the JSON directly: each entry is `{"symbol", "name", "marketCapUSD"}`. `marketCapUSD` is only used to order rows until live data loads. Existing users keep their own lists; **Settings → Reset lists to default** loads the new ones (it doesn't touch the portfolio or alerts). Bump `SHELL` in `sw.js` after changing any app file (it's `stockwatch-shell-v2` now).

## Install on iPhone
Open the hosted URL in **Safari**, tap Share, then **Add to Home Screen**. It runs full-screen with the dark status bar, and the app shell works offline after the first load (with cached prices, if any). Your watchlist and keys are tied to the URL (origin). If you change hosts, re-enter the keys.

## Hosting (not done; for you to choose)
**GitHub Pages:** push this folder to a repo, then Settings → Pages → deploy from branch. All paths are relative, so a project subpath like `/stock-watchlist/` works. The code is public, but keys aren't in it. Any static HTTPS host works the same way.

## Tests
```bash
node tests/logic.test.js     # sorting, search, watchlists (US + ASX), cache + TTL, formatting, consensus, parsing, rate-limit maths,
                             # portfolio maths (AUD, FX, weights, partial totals), seed has no amounts, alerts (fire once, re-arm, daily),
                             # movers, earnings filter/grouping, news sanitising, Marketstack/FX parsing and errors
node tests/api.test.js       # data layer with a fake fetch/clock: caching, dedupe, priority queue, 55/min and 8/min budgets, 429 handling,
                             # Marketstack monthly budget (per-symbol, never exceeded, month rollover), FX live → ECB fallback,
                             # news/calendar caching, dropping queued requests for screens you left, per-provider usage
node tests/hygiene.test.js   # no local paths, emails, hardcoded keys or CDN; CSP allow-list; SW asset list, cache version and key stripping;
                             # portfolio seed has tickers only; ASX list shape; external links use noopener
# Headless iPhone-size check with mocked APIs (needs puppeteer-core on NODE_PATH and Chrome):
python3 -m http.server 8765 &
NODE_PATH=/path/to/node_modules SHOTS_DIR=/tmp/shots node tests/e2e.js   # CHROME_PATH and BASE_URL can be overridden
```
`tests/mocks.js` has the fake API responses. The keys in the tests are obvious placeholders (`FAKE_…`). The e2e run takes about 3–4 minutes because the real rate limiter is in play. With `SHOTS_DIR` set it saves the DEMO screenshots (list with overview, portfolio, detail with news, alerts, earnings); the portfolio numbers in them are example entries typed in by the test.

## Files
`index.html`, `styles.css`, `logic.js` (pure logic; also loads in Node), `api.js` (Finnhub, Twelve Data, Marketstack and Frankfurter client, rate limiters, budgets, cache, DEMO generator), `chart.js` (canvas chart and crosshair), `app.js` (UI), `sw.js`, `manifest.webmanifest`, `favicon.ico`, `data/default-watchlist.json`, `data/asx-watchlist.json`, `icons/`, `tools/refresh_default_list.py`, `tests/`.

## Limitations
- No live API was called while building this. Signing up for keys wasn't possible, so everything was tested against mocks built from the providers' documented response formats (Twelve Data's format was checked against its public `demo` key). Check a few values against another source once you add real keys. Two things in particular: some Finnhub metric field names (the app tries known alternatives, then shows n/a), and the assumption that Finnhub sends margins and dividend yield as percentages (46.2 = 46.2%).
- Finnhub's free quote is near real-time for US stocks, but the app labels everything as delayed data. Twelve Data bars are in exchange time (ET).
- The first full load of 50 tickers takes about 2 minutes (Finnhub) and about 8 minutes for all sparklines (Twelve Data) because of the free-tier limits. After that, the caches keep it quick.
- Price targets aren't available on any free tier used here.
- Marketstack wasn't called with a real key either. The `.AX` ticker format comes from Marketstack's v2 ticker list, the error format from its live API and docs. If ASX rows come back "No price found", check the format against your Marketstack dashboard.
- ASX prices are end-of-day only; alerts on ASX tickers compare against the latest close.
- Alerts only run while the app is open (no server, no background push).
- No sync between devices, and iOS may clear site storage for apps you haven't opened in weeks (you'd re-enter the keys).
- Not financial advice.
