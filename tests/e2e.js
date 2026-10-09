// Headless check on an iPhone-sized screen with mocked Finnhub / Twelve Data / Marketstack / Frankfurter / Google Sheets responses (no real keys, no real network calls).
// Needs puppeteer-core on NODE_PATH and Chrome. Serve the app first:  python3 -m http.server 8765
// Env: BASE_URL (default http://localhost:8765/), CHROME_PATH (default /usr/bin/google-chrome), SHOTS_DIR (optional: save the DEMO screenshots there).
const puppeteer = require('puppeteer-core');
const path = require('path');
const mocks = require('./mocks.js');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS_DIR || '';
const DEBUG_SHOTS = process.env.DEBUG_SHOTS_DIR || ''; // optional: snapshots of the mocked live screens, for eyeballing layout
const FH_KEY = 'FAKE_FINNHUB_KEY_FOR_TESTS', TD_KEY = 'FAKE_TWELVE_KEY_FOR_TESTS', MS_KEY = 'FAKE_MARKETSTACK_KEY_FOR_TESTS';
const MOCK_HOSTS = ['finnhub.io', 'api.twelvedata.com', 'api.marketstack.com', 'api.frankfurter.dev', 'docs.google.com', 'doc-0s-sheets.googleusercontent.com'];
const SHEET_LINK = 'https://docs.google.com/spreadsheets/d/e/2PACX-FAKE_PUBLISHED_SHEET_ID_FOR_TESTS/pubhtml';
const fs = require('fs'), os = require('os');
const IPHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TIMEOUT = +process.env.E2E_TIMEOUT || 120000;

const errs = [], mockOpts = { finnhubLimit: false, twelveLimit: false, quoteOverride: {} }, apiLog = [];
let passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { errs.push('FAIL ' + m); console.log('FAIL -', m); } };

async function newPage(ctx, { bypassSW = true } = {}) {
  const p = await ctx.newPage();
  p.setDefaultTimeout(TIMEOUT); p.setDefaultNavigationTimeout(TIMEOUT); // generous: the e2e box can be heavily loaded
  await p.setViewport(IPHONE); await p.setUserAgent(UA);
  if (bypassSW) await p.setBypassServiceWorker(true); // so page-level request interception sees every API call
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|429)/.test(m.text())) errs.push('console: ' + m.text()); });
  p.on('dialog', d => d.accept());
  await p.setRequestInterception(true);
  p.on('request', req => {
    const url = req.url(), host = new URL(url).hostname;
    if (!MOCK_HOSTS.includes(host)) { if (host === 'localhost' || host === '127.0.0.1' || /^(data|blob):/.test(url)) return req.continue(); errs.push('unexpected request: ' + url.slice(0, 80)); return req.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    const headers = req.headers();
    apiLog.push({ host, url, auth: headers.authorization || '' });
    // A published Google Sheet answers with a 307 to googleusercontent.com, like the real one (so the CSP for the redirect is exercised too).
    if (host === 'docs.google.com' && new URL(url).pathname.endsWith('/pub')) return req.respond({ status: 307, headers: { ...cors, Location: 'https://doc-0s-sheets.googleusercontent.com/pub/x/y' + new URL(url).search }, body: '' });
    const r = mocks.respond(host === 'doc-0s-sheets.googleusercontent.com' ? 'https://docs.google.com/spreadsheets/d/e/X/pub' + new URL(url).search : url, { ...mockOpts, authorization: headers.authorization });
    if (r.text !== undefined) return req.respond({ status: r.status, headers: cors, contentType: r.contentType, body: r.text });
    req.respond({ status: r.status, headers: cors, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return p;
}
const rowsOf = p => p.$$eval('#list li', lis => lis.map(li => ({ sym: li.dataset.sym, price: li.querySelector('.price').textContent, pct: li.querySelector('.pill').textContent, cls: li.querySelector('.pill').className, star: !!li.querySelector('.star.on'), spark: !!li.querySelector('svg.spark'), sub: li.querySelector('.nm').textContent })));
const pctNum = s => s === '—' ? null : parseFloat(s.replace('−', '-').replace('+', ''));
const priceNum = s => s === '—' ? null : parseFloat(s.replace(/[$,]/g, ''));
const text = (p, sel) => p.$eval(sel, e => e.textContent);
const tap = (p, sel) => p.$eval(sel, e => e.click()); // atomic: the list may re-render between find and click
const visible = (p, sel) => p.$eval(sel, e => !e.hidden && !e.closest('[hidden]'));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], protocolTimeout: TIMEOUT * 3 });
  try {
    // ---------- static files ----------
    const ctx0 = await browser.createBrowserContext(); const p0 = await newPage(ctx0);
    for (const u of ['index.html', 'manifest.webmanifest', 'sw.js', 'data/default-watchlist.json', 'data/asx-watchlist.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon-180.png', 'favicon.ico']) {
      const r = await p0.goto(BASE + u); ok(r.status() === 200, 'serves ' + u);
    }
    const manifest = JSON.parse(await p0.evaluate(() => document.body.innerText).catch(() => '{}') || '{}');
    await ctx0.close();

    // ---------- first run: setup screen ----------
    const ctx = await browser.createBrowserContext(); const p = await newPage(ctx);
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    ok(await visible(p, '#v-setup'), 'no key: friendly setup screen shown');
    ok((await text(p, '#foot')).includes('Not financial advice'), 'footer reads Not financial advice');
    ok(await p.$eval('meta[name=apple-mobile-web-app-capable]', e => e.content) === 'yes' && !!(await p.$('link[rel=apple-touch-icon]')) && !!(await p.$('link[rel=manifest]')), 'iOS Add to Home Screen meta + icon + manifest linked');
    await p.click('#setupForm button[type=submit]');
    ok((await text(p, '#bannerText')).includes('Finnhub key'), 'empty setup form explains what is needed');

    // ---------- live mode (mocked), Finnhub key only ----------
    await p.type('#setupForm [name=finnhub]', FH_KEY); await p.click('#setupForm button[type=submit]');
    await p.waitForSelector('#v-list:not([hidden])');
    ok(await p.$$eval('#list li', x => x.length) === 50, 'list shows the 50 default tickers');
    await p.waitForFunction(() => [...document.querySelectorAll('#list .price')].every(e => e.textContent !== '—'), { timeout: TIMEOUT });
    let rows = await rowsOf(p);
    ok(rows.every(r => priceNum(r.price) > 0), 'every row has a price from the (mocked) quote API');
    ok(rows.every(r => (pctNum(r.pct) > 0 && r.cls.includes('up')) || (pctNum(r.pct) < 0 && r.cls.includes('down')) || pctNum(r.pct) === 0), 'daily % change coloured green/red by sign');
    const aapl = rows.find(r => r.sym === 'AAPL'), mq = mocks.quote('AAPL');
    ok(priceNum(aapl.price) === mq.c && Math.abs(pctNum(aapl.pct) - mq.dp) < 0.006, 'AAPL row matches mock quote: ' + aapl.price + ' ' + aapl.pct);
    ok((await text(p, '#delayed')) === 'Delayed data' && (await text(p, '#asof')).startsWith('as of'), 'Delayed data label with as-of time: ' + await text(p, '#asof'));
    ok(await p.$eval('#demoBadge', e => e.hidden), 'no DEMO badge in live mode');
    ok((await text(p, '#listNote')).includes('Twelve Data'), 'explains sparklines need a Twelve Data key');
    ok(apiLog.filter(a => a.host === 'finnhub.io').every(a => a.url.includes('token=' + FH_KEY)), 'Finnhub calls carry the key as token param');

    // ---------- sorting ----------
    await p.select('#sortKey', 'changePct'); rows = await rowsOf(p);
    ok(rows.every((r, i) => !i || pctNum(rows[i - 1].pct) >= pctNum(r.pct)), 'sort by % change (desc)');
    await p.click('#sortDir'); rows = await rowsOf(p);
    ok(rows.every((r, i) => !i || pctNum(rows[i - 1].pct) <= pctNum(r.pct)), 'toggle direction: % change ascending');
    await p.select('#sortKey', 'symbol'); rows = await rowsOf(p);
    ok(rows.every((r, i) => !i || rows[i - 1].sym.localeCompare(r.sym) <= 0) && rows[0].sym === 'AAPL', 'sort by ticker A→Z');
    await p.select('#sortKey', 'price'); rows = await rowsOf(p);
    ok(rows.every((r, i) => !i || priceNum(rows[i - 1].price) >= priceNum(r.price)), 'sort by price (desc)');
    await p.select('#sortKey', 'marketCap'); rows = await rowsOf(p);
    // Profiles (shares outstanding) load after quotes at low priority; until then a row sorts by the snapshot cap in the default list.
    const snap = Object.fromEntries(require('../data/default-watchlist.json').symbols.map(x => [x.symbol, x.marketCapUSD]));
    const cap = r => r.sub.includes(' · $') ? mocks.quote(r.sym).c * mocks.profile(r.sym).shareOutstanding * 1e6 : snap[r.sym];
    const liveN = rows.filter(r => r.sub.includes(' · $')).length;
    ok(rows.every((r, i) => !i || cap(rows[i - 1]) >= cap(r)), `sort by market cap (live price × shares for ${liveN} loaded profiles, snapshot for the rest)`);

    // ---------- search ----------
    await p.type('#search', 'nvda'); rows = await rowsOf(p); ok(rows.length === 1 && rows[0].sym === 'NVDA', 'search by ticker');
    await p.$eval('#search', e => { e.value = ''; }); await p.type('#search', 'micro'); rows = await rowsOf(p);
    ok(rows.map(r => r.sym).sort().join() === 'MSFT,MU', 'search by company name: ' + rows.map(r => r.sym));
    await p.$eval('#search', e => { e.value = ''; e.dispatchEvent(new Event('input')); });
    ok(await p.$$eval('#list li', x => x.length) === 50, 'clearing search restores the list');

    // ---------- favourites ----------
    await tap(p, '#list li[data-sym=MSFT] .star'); await tap(p, '#list li[data-sym=KO] .star');
    await p.click('#favFirst'); rows = await rowsOf(p);
    ok(rows[0].star && rows[1].star && rows.slice(0, 2).map(r => r.sym).sort().join() === 'KO,MSFT' && !rows[2].star, 'favourites-first filter puts starred rows on top');
    await p.reload({ waitUntil: 'networkidle0' }); rows = await rowsOf(p);
    ok(rows.slice(0, 2).map(r => r.sym).sort().join() === 'KO,MSFT' && await p.$eval('#favFirst', e => e.getAttribute('aria-pressed')) === 'true', 'favourites + filter persist after reload');
    await p.click('#favFirst');

    // ---------- add / remove ----------
    await p.click('#addBtn'); await p.type('#addInput', 'ibm'); await p.click('#addForm button[type=submit]');
    await p.waitForFunction(() => { const li = document.querySelector('#list li[data-sym=IBM]'); return li && li.querySelector('.price').textContent !== '—'; }, { timeout: 2 * TIMEOUT }); // may wait for the 55/min window
    ok(true, 'add ticker IBM: row appears with a price');
    await p.type('#addInput', 'IBM'); await p.click('#addForm button[type=submit]'); ok((await text(p, '#addMsg')).includes('already'), 'adding a duplicate is refused');
    await p.type('#addInput', '$$'); await p.click('#addForm button[type=submit]'); ok((await text(p, '#addMsg')).includes('Invalid ticker'), 'invalid ticker is refused');
    await p.$eval('#addInput', e => { e.value = ''; }); await p.type('#addInput', 'ZZZZ'); await p.click('#addForm button[type=submit]');
    await p.waitForFunction(() => (document.querySelector('#list li[data-sym=ZZZZ] .nm') || {}).textContent?.includes('No price found'), { timeout: 2 * TIMEOUT });
    ok(true, 'unknown ticker is flagged "No price found", not shown with fake numbers');
    await p.click('#editBtn'); await tap(p, '#list li[data-sym=ZZZZ] [data-rm]'); await tap(p, '#list li[data-sym=IBM] [data-rm]'); await p.click('#editBtn');
    ok(!(await p.$('#list li[data-sym=IBM]')) && !(await p.$('#list li[data-sym=ZZZZ]')), 'remove tickers in edit mode');
    await p.click('#editBtn'); await tap(p, '#list li[data-sym=TSLA] [data-rm]'); await p.click('#editBtn');
    await p.reload({ waitUntil: 'networkidle0' });
    ok(await p.$$eval('#list li', x => x.length) === 49 && !(await p.$('#list li[data-sym=TSLA]')), 'removal persists in localStorage after reload');
    const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.watchlist.v1')));
    ok(stored.symbols.length === 49 && stored.favourites.includes('MSFT'), 'watchlist saved under stockwatch.watchlist.v1');

    // ---------- settings: add Twelve Data key -> sparklines ----------
    await p.click('#gear'); await p.waitForSelector('#v-settings:not([hidden])');
    ok(await p.$eval('#keysForm [name=finnhub]', e => e.type === 'password' && e.value.length > 0), 'saved key shown masked in Settings');
    await p.click('#showKeys'); ok(await p.$eval('#keysForm [name=finnhub]', e => e.type) === 'text', 'Show keys reveals them'); await p.click('#showKeys');
    await p.type('#keysForm [name=twelvedata]', TD_KEY); await p.click('#keysForm button[type=submit]');
    ok((await text(p, '#keysMsg')).includes('Saved'), 'keys saved');
    ok((await text(p, '#usage')).includes('Finnhub') && (await text(p, '#usage')).includes('/800 today'), 'usage counters shown: ' + (await text(p, '#usage')).slice(0, 80));
    await p.select('#refreshSel', '300'); ok(await p.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.settings.v1')).refreshSec) === 300, 'auto-refresh setting persists');
    await p.click('#back'); await p.waitForSelector('#v-list:not([hidden])');
    await p.waitForFunction(() => document.querySelectorAll('#list svg.spark').length >= 6, { timeout: TIMEOUT });
    const tdCalls = apiLog.filter(a => a.host === 'api.twelvedata.com');
    ok(tdCalls.length === 1 && new URL(tdCalls[0].url).searchParams.get('symbol').split(',').length === 6, 'sparklines: first batch request covers 6 symbols (1 call, 6 credits)');
    ok(tdCalls.every(a => a.auth === 'apikey ' + TD_KEY && !a.url.includes(TD_KEY)), 'Twelve Data key sent only in the Authorization header');
    const ls = await p.evaluate(() => Object.keys(localStorage).filter(k => k !== 'stockwatch.keys.v1').map(k => localStorage.getItem(k)).join('\n'));
    ok(!ls.includes(FH_KEY) && !ls.includes(TD_KEY), 'keys stored only under stockwatch.keys.v1, never inside cached data');

    // ---------- rate limit error ----------
    mockOpts.finnhubLimit = true;
    await p.click('#refresh');
    await p.waitForFunction(() => /limit reached/.test(document.querySelector('#bannerText').textContent), { timeout: 2 * TIMEOUT }); // may wait for the 55/min window first
    ok((await text(p, '#bannerText')).includes('60 calls/min'), 'clear message when the Finnhub limit is hit: ' + await text(p, '#bannerText'));
    rows = await rowsOf(p); ok(rows.every(r => priceNum(r.price) > 0), 'cached prices stay visible while rate-limited');
    mockOpts.finnhubLimit = false;
    await ctx.close();

    // ---------- detail page (fresh context with keys already saved) ----------
    const ctx2 = await browser.createBrowserContext(); await ctx2.overridePermissions(new URL(BASE).origin, ['notifications']); const d = await newPage(ctx2);
    await d.goto(BASE, { waitUntil: 'domcontentloaded' });
    await d.evaluate((a, b) => { localStorage.setItem('stockwatch.keys.v1', JSON.stringify({ finnhub: a, twelvedata: b })); localStorage.setItem('stockwatch.settings.v1', JSON.stringify({ refreshSec: 0 })); }, FH_KEY, TD_KEY);
    apiLog.length = 0;
    await d.goto(BASE + '#/s/AAPL'); await d.reload({ waitUntil: 'networkidle0' }); // deep link, fresh boot with keys
    await d.waitForFunction(() => document.querySelector('#dPrice').textContent.startsWith('$') && window.__app.chart.data().length > 1, { timeout: TIMEOUT });
    ok(await text(d, '#title') === 'AAPL' && (await text(d, '#dPrice')) === '$' + mocks.quote('AAPL').c.toFixed(2), 'detail shows ticker and price');
    ok((await text(d, '#dChange')).includes('delayed, as of'), 'detail shows delayed/as-of note');
    const len = () => d.evaluate(() => window.__app.chart.data().length);
    ok(await len() === 78 && await d.$eval('#ranges [data-range="1D"]', e => e.classList.contains('on')), '1D chart: 78 five-minute bars, 1D active');
    const expectRange = async (r, check, label) => {
      await d.click(`#ranges [data-range="${r}"]`);
      await d.waitForFunction(r => document.querySelector(`#ranges [data-range="${r}"]`).classList.contains('on') && window.__app.chart.data().length > 1 && !/Loading/.test(document.querySelector('#chartMsg').textContent), {}, r);
      await sleep(150); const n = await len(); ok(check(n), label + ' (' + n + ' points)');
    };
    await expectRange('5D', n => n === 65, '5D chart: 5 sessions of 30-minute bars');
    await expectRange('1M', n => n >= 20 && n <= 24, '1M chart: daily bars');
    await expectRange('6M', n => n >= 124 && n <= 134, '6M chart: daily bars');
    await expectRange('1Y', n => n >= 250 && n <= 262, '1Y chart: daily bars');
    await expectRange('5Y', n => n === 262, '5Y chart: weekly bars');
    const intervals = apiLog.filter(a => a.host === 'api.twelvedata.com').map(a => new URL(a.url).searchParams.get('interval'));
    ok(intervals.join() === '5min,30min,1day,1week', 'range switching: 1M/6M/1Y share one daily request: ' + intervals.join());
    await d.click('#ranges [data-range="1D"]'); await d.waitForFunction(() => window.__app.chart.data().length === 78);
    // touch crosshair
    const box = await (await d.$('#chart')).boundingBox();
    await d.touchscreen.touchStart(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await d.touchscreen.touchMove(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await sleep(100);
    const tip = await text(d, '#chartTip');
    ok(/^\$\d+\.\d{2} · Oct \d+, \d+:\d{2} (am|pm) ET$/.test(tip) && await d.evaluate(() => window.__app.chart.hoverIndex()) > 0, 'touch crosshair shows price and date: ' + tip);
    await d.touchscreen.touchEnd(); await sleep(50);
    ok(await d.evaluate(() => window.__app.chart.hoverIndex()) === -1, 'crosshair clears when the finger lifts');
    await d.click('#ranges [data-range="1Y"]'); await d.waitForFunction(() => window.__app.chart.data().length > 200);
    await d.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4); await sleep(80);
    ok(/^\$\d+\.\d{2} · [A-Z][a-z]{2} \d+, 20\d\d$/.test(await text(d, '#chartTip')), 'crosshair on daily chart shows date: ' + await text(d, '#chartTip'));
    await d.mouse.move(5, 5);
    // ratings, targets, metrics
    await d.waitForSelector('#consensusLabel');
    const counts = await d.$$eval('[data-count]', e => e.map(x => x.textContent).join());
    ok(counts === '12,20,8,1,1', 'analyst counts strong buy/buy/hold/sell/strong sell: ' + counts);
    ok(await text(d, '#consensusLabel') === 'Buy' && (await text(d, '#ratings')).includes('score 2.02'), 'consensus label and average score');
    await d.waitForFunction(() => document.querySelectorAll('[data-target]').length === 3);
    ok((await d.$$eval('[data-target]', e => e.map(x => x.textContent))).every(t => t === 'n/a (not on free tier)'), 'price targets (premium) show n/a (not on free tier)');
    await d.waitForFunction(() => { const e = document.querySelector('[data-metric="Next earnings"]'); return e && e.textContent !== '…'; });
    const metric = k => d.$eval(`[data-metric="${k}"]`, e => e.textContent);
    ok(await metric('P/E (trailing)') === '31.25' && await metric('EPS (TTM)') === '$7.50' && await metric('Dividend yield') === '0.42%' && await metric('Beta') === '1.11', 'P/E, EPS, dividend yield, beta');
    ok(await metric('P/E (forward)') === 'n/a (not on free tier)', 'field missing from the response shows n/a (not on free tier)');
    ok(await metric('52-week high') === '$350.10' && await metric('52-week low') === '$190.20', '52-week high/low');
    ok(await metric('Gross margin') === '46.90%' && await metric('Operating margin') === '31.60%' && await metric('Net margin') === '24.30%', 'margins');
    ok((await metric('Revenue (TTM)')).includes('≈ revenue/share × shares') && (await metric('Market cap')).startsWith('$'), 'revenue (derived, labelled) and market cap: ' + await metric('Revenue (TTM)'));
    ok(await metric('Volume (last session)') === '34.13M' && await metric('Avg volume (10 day)') === '41.50M', 'volume (Twelve Data daily bar) and 10-day average');
    ok(await metric('Next earnings') === 'Oct 29, 2026 (after close)', 'next earnings date');
    await d.click('#dFav'); ok(await d.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.watchlist.v1')).favourites.includes('AAPL')), 'favourite from the detail page');
    await d.click('#back'); await d.waitForSelector('#v-list:not([hidden])'); ok(true, 'back button returns to the list');
    // settings: remove keys -> setup
    await d.click('#gear'); await d.click('#clearKeys'); await d.click('#back');
    await d.waitForSelector('#v-setup:not([hidden])'); ok(true, 'removing keys returns to the setup screen');
    ok(await d.evaluate(() => { const k = JSON.parse(localStorage.getItem('stockwatch.keys.v1')); return !k.finnhub && !k.twelvedata; }), 'keys removed from localStorage');

    // ---------- DEMO mode + screenshots ----------
    await sleep(300); const mark = apiLog.length;
    await d.$eval('#tryDemo', e => e.scrollIntoView({ block: 'center' })); await d.click('#tryDemo'); await d.waitForSelector('#v-list:not([hidden])'); // the button sits under the fixed footer until scrolled
    await d.waitForFunction(() => document.querySelectorAll('#list svg.spark').length >= 50);
    ok(!(await d.$eval('#demoBadge', e => e.hidden)) && !(await d.$eval('#demoBanner', e => e.hidden)) && (await text(d, '#delayed')) === 'DEMO data' && (await text(d, '#foot')).includes('DEMO'), 'DEMO mode is labelled in header, banner, status and footer');
    await d.evaluate(() => window.scrollTo(0, 0));
    await d.waitForFunction(() => document.querySelectorAll('#gainers li').length === 5 && document.querySelectorAll('.ov-tile').length === 3);
    ok((await text(d, '#overview')).includes('DEMO numbers') && (await text(d, '#overview')).includes('SPY ETF proxy'), 'DEMO overview: proxies and movers, labelled DEMO');
    const shot = async (name, full) => {
      if (!SHOTS) return;
      if (full) { const h = await d.evaluate(() => document.documentElement.scrollHeight); await d.setViewport({ ...IPHONE, height: h }); await sleep(300); } // grow to page height so fixed bars sit at the bottom
      await d.screenshot({ path: path.join(SHOTS, name) }); if (full) await d.setViewport(IPHONE);
      console.log('   saved ' + name);
    };
    await shot('1-list-overview-demo.png');
    // detail with news
    await tap(d, '#list li[data-sym=NVDA]'); await d.waitForFunction(() => window.__app.chart.data().length > 1 && document.querySelector('#consensusLabel') && document.querySelectorAll('#news li .meta').length >= 3);
    ok((await text(d, '#dChange')).includes('DEMO'), 'detail price is marked DEMO');
    ok((await text(d, '#news')).includes('DEMO, no link') && !(await d.$('#news a')), 'DEMO news is labelled and has no external links');
    if (SHOTS) {
      const h = await d.evaluate(() => document.documentElement.scrollHeight);
      await d.setViewport({ ...IPHONE, height: h }); await sleep(300);
      const b2 = await (await d.$('#chart')).boundingBox();
      await d.touchscreen.touchStart(b2.x + b2.width * 0.62, b2.y + b2.height / 2); await sleep(150);
      await d.screenshot({ path: path.join(SHOTS, '3-detail-news-demo.png') }); await d.touchscreen.touchEnd();
      await d.setViewport(IPHONE); console.log('   saved 3-detail-news-demo.png');
    }
    // portfolio: example amounts typed in through the UI (they live only in this test browser's localStorage)
    await d.click('#tabPortfolio'); await d.waitForSelector('#v-portfolio:not([hidden])');
    for (const [hid, units, cost] of [['ASX:FANG', '100', '20'], ['ASX:SEMI', '200', '10'], ['ASX:IVV', '50', '60']]) {
      await tap(d, `#pfList li[data-hid="${hid}"]`); await d.waitForSelector('#pfForm:not([hidden])');
      await d.type('#pfForm [name=units]', units); await d.type('#pfForm [name=avgCost]', cost); await tap(d, '#pfForm button[type=submit]');
      await d.waitForSelector('#pfForm[hidden]');
    }
    await tap(d, '#pfAddBtn'); await d.type('#pfForm [name=symbol]', 'NVDA'); await d.select('#pfForm [name=exchange]', 'US');
    await d.type('#pfForm [name=units]', '10'); await d.type('#pfForm [name=avgCost]', '100'); await tap(d, '#pfForm button[type=submit]');
    await d.waitForFunction(() => document.querySelector('#pfValue').textContent.startsWith('A$') && /DEMO rate/.test(document.querySelector('#pfFx').textContent) && document.querySelector('#pfPrompt').hidden);
    ok((await text(d, '#pfNote')).includes('DEMO') && (await d.$$eval('[data-weight]', e => e.filter(x => x.textContent).length)) === 4, 'DEMO portfolio: values, weights and FX labelled DEMO');
    await d.evaluate(() => window.scrollTo(0, 0)); await shot('2-portfolio-demo.png', true);
    // portfolio value chart (DEMO): synthetic closes × the typed units, labelled DEMO, nothing saved to the real history
    await d.waitForFunction(() => window.__app.pfChart.data().length > 200);
    const dAll = await d.evaluate(() => window.__app.pfChart.data().length);
    ok(await visible(d, '#pfChartBadge') && (await text(d, '#pfChartNote')).includes('DEMO') && (await text(d, '#pfChartNow')) === (await text(d, '#pfValue')) && /^[+−]A\$/.test(await text(d, '#pfChartChange')) && /^Now vs /.test(await text(d, '#pfChartStart')),
      'DEMO value chart: ' + dAll + ' daily points, current total vs start shown, labelled DEMO: ' + (await text(d, '#pfChartHead')).replace(/\s+/g, ' '));
    ok(await d.evaluate(() => localStorage.getItem('stockwatch.pfvalue.v1')) === null, 'DEMO totals are never saved to the chart history');
    await tap(d, '#pfRanges [data-pfrange="1M"]'); await d.waitForFunction(n => window.__app.pfChart.data().length < n, {}, dAll);
    const d1m = await d.evaluate(() => window.__app.pfChart.data());
    ok(d1m.length >= 15 && d1m.length <= 24 && (Date.parse(d1m[d1m.length - 1].d) - Date.parse(d1m[0].d)) / 864e5 <= 31 && await d.$eval('#pfRanges [data-pfrange="1M"]', b => b.classList.contains('on')), '1M range: last month of daily points (' + d1m.length + ')');
    await tap(d, '#pfRanges [data-pfrange="All"]');
    const pb = await (await d.$('#pfChart')).boundingBox();
    await d.touchscreen.touchStart(pb.x + pb.width * 0.5, pb.y + pb.height / 2); await sleep(150);
    ok(/^A\$[\d,]+\.\d\d · .+ · DEMO$/.test(await text(d, '#pfChartTip')), 'touching the value chart shows value and date: ' + await text(d, '#pfChartTip')); await d.touchscreen.touchEnd();
    // alerts
    await d.click('#tabAlerts'); await d.waitForSelector('#v-alerts:not([hidden])');
    const px = await d.evaluate(() => ({ nvda: window.__app.src.peekQuote('NVDA').price, msft: window.__app.src.peekQuote('MSFT').price, bhp: window.__app.src.peekAsxQuote('BHP').price }));
    const addAlert = async (sym, market, type, value) => {
      await d.$eval('#alForm [name=sym]', e => { e.value = ''; }); await d.type('#alForm [name=sym]', sym); await d.select('#alForm [name=market]', market);
      await d.select('#alForm [name=type]', type); await d.$eval('#alForm [name=value]', e => { e.value = ''; }); await d.type('#alForm [name=value]', String(value)); await tap(d, '#alForm button[type=submit]'); await sleep(250);
    };
    await addAlert('NVDA', 'US', 'above', Math.floor(px.nvda - 5)); await addAlert('BHP', 'ASX', 'below', Math.ceil(px.bhp + 1));
    await addAlert('MSFT', 'US', 'below', Math.floor(px.msft * 0.8)); await addAlert('AAPL', 'US', 'movePct', 5);
    ok((await d.$$eval('#alHistory li[data-hist]', e => e.map(x => x.textContent))).every(t => t.startsWith('DEMO: ')) && await d.$$eval('#alHistory li[data-hist]', e => e.length) >= 2, 'DEMO alerts fire and are labelled DEMO in the history');
    await d.evaluate(() => window.scrollTo(0, 0)); await shot('4-alerts-demo.png', true);
    // earnings
    await d.click('#bannerClose'); await d.click('#tabEarnings'); await d.waitForSelector('[data-earn], #earnEmpty');
    ok((await text(d, '#earnInfo')).includes('DEMO'), 'DEMO earnings calendar labelled DEMO');
    await d.evaluate(() => window.scrollTo(0, 0)); await shot('5-earnings-demo.png', true);
    ok(apiLog.length === mark, 'DEMO mode makes no API calls (' + (apiLog.length - mark) + ')');
    await ctx2.close();

    // ---------- turn 2: overview, ASX, portfolio, earnings, news, alerts, provider status (live mode, mocked) ----------
    const ctx4 = await browser.createBrowserContext();
    await ctx4.overridePermissions(new URL(BASE).origin, ['notifications']);
    const q = await newPage(ctx4);
    await q.goto(BASE, { waitUntil: 'domcontentloaded' });
    await q.evaluate((a, b) => { localStorage.setItem('stockwatch.keys.v1', JSON.stringify({ finnhub: a, twelvedata: b })); localStorage.setItem('stockwatch.settings.v1', JSON.stringify({ refreshSec: 0 })); }, FH_KEY, TD_KEY);
    apiLog.length = 0;
    await q.reload({ waitUntil: 'domcontentloaded' }); await q.waitForSelector('#v-list:not([hidden])');
    const dbg = async name => { if (!DEBUG_SHOTS) return; const h = await q.evaluate(() => document.documentElement.scrollHeight); await q.setViewport({ ...IPHONE, height: h }); await sleep(250); await q.screenshot({ path: path.join(DEBUG_SHOTS, name + '.png') }); await q.setViewport(IPHONE); };
    const money = s => parseFloat(String(s).replace(/[A$,+\s]/g, '').replace('−', '-'));
    const aud = v => 'A$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ok(await q.$$eval('#tabs [data-tab]', b => b.map(x => x.dataset.tab).join()) === 'list,portfolio,earnings,alerts' && await visible(q, '#tabs'), 'bottom tabs: Watchlist, Portfolio, Earnings, Alerts');
    await q.waitForFunction(() => document.querySelectorAll('.ov-tile .v').length === 3 && [...document.querySelectorAll('.ov-tile .v')].every(e => e.textContent !== '—'), { timeout: TIMEOUT });
    const tiles = await q.$$eval('.ov-tile', t => t.map(x => ({ n: x.querySelector('.n').textContent, p: x.querySelector('.p').textContent, v: x.querySelector('.v').textContent })));
    ok(tiles.map(t => t.n).join() === 'S&P 500,Nasdaq-100,Dow Jones' && tiles.map(t => t.p).join() === 'SPY ETF proxy,QQQ ETF proxy,DIA ETF proxy', 'overview: S&P 500 / Nasdaq / Dow labelled as SPY / QQQ / DIA proxies');
    ok(money(tiles[0].v) === mocks.quote('SPY').c && money(tiles[2].v) === mocks.quote('DIA').c, 'overview proxy prices come from the quote API: ' + tiles.map(t => t.v).join(' '));
    await q.waitForFunction(() => [...document.querySelectorAll('#list .price')].every(e => e.textContent !== '—') && document.querySelectorAll('#gainers li').length === 5, { timeout: 2 * TIMEOUT });
    const dps = require('../data/default-watchlist.json').symbols.map(x => mocks.quote(x.symbol).dp);
    const shownG = (await q.$$eval('#gainers li span', e => e.map(x => x.textContent))).map(pctNum), shownL = (await q.$$eval('#losers li span', e => e.map(x => x.textContent))).map(pctNum);
    const expG = dps.filter(x => x > 0).sort((a, b) => b - a).slice(0, 5), expL = dps.filter(x => x < 0).sort((a, b) => a - b).slice(0, 5);
    ok(JSON.stringify(shownG) === JSON.stringify(expG) && JSON.stringify(shownL) === JSON.stringify(expL), 'top 5 gainers and losers within the watchlist: ' + shownG.join(' ') + ' / ' + shownL.join(' '));
    // ASX without a Marketstack key: n/a with an explanation, no calls
    await q.click('#mkASX');
    let arows = await rowsOf(q);
    ok(arows.length === 23 && arows.slice(0, 3).map(r => r.sym).sort().join() === 'FANG,IVV,SEMI' && arows.slice(0, 3).every(r => r.star) && !arows[3].star, 'ASX list: 23 tickers, the three ETFs starred and pinned on top');
    const bar0 = await text(q, '#asxBar');
    ok(arows.every(r => r.price === 'n/a') && bar0.includes('ASX prices aren\u2019t set up yet') && bar0.includes('Google Sheet') && bar0.includes('free') && !/paid|upgrade|pricing|subscri/i.test(bar0), 'ASX prices show n/a and point to the free Google Sheet setup (no paid plan): ' + bar0.slice(0, 60));
    ok((await text(q, '#overview')).includes('ASX 200') && (await text(q, '#overview')).includes('STW proxy') && (await text(q, '#asof')) === 'ASX prices: not set up (free Google Sheet in Settings)' && (await q.$eval('.ov-tile .v', e => e.textContent)) === 'n/a', 'ASX overview: ASX 200 (STW proxy) is n/a until a source is set up');
    await dbg('asx-nokey');
    await tap(q, '#list li[data-sym=BHP]'); await q.waitForSelector('#v-detail:not([hidden])'); await dbg('asx-detail-nokey');
    ok(await text(q, '#title') === 'BHP · ASX' && (await text(q, '#dPrice')) === 'n/a' && (await text(q, '#dNote')).includes('US-listed stocks only'), 'ASX detail: price n/a and the free-tier gap explained');
    ok(await q.$eval('#ranges [data-range="1D"]', e => e.disabled) && await q.$eval('#ranges [data-range="5Y"]', e => e.disabled) && (await text(q, '#news')).startsWith('n/a') && (await text(q, '#ratings')).startsWith('n/a'), 'ASX detail: 1D/5D/5Y disabled; news and ratings n/a');
    ok(!apiLog.some(a => /symbol=(BHP|FANG)/.test(a.url) || a.host === 'api.marketstack.com' || a.host === 'docs.google.com'), 'no API calls for ASX tickers before a source is set up');
    // add a Marketstack key
    await q.click('#gear'); await q.waitForSelector('#v-settings:not([hidden])');
    await q.type('#keysForm [name=marketstack]', MS_KEY); await q.click('#keysForm button[type=submit]');
    await q.waitForFunction(() => /0\/100 requests this month/.test(document.querySelector('#usage').textContent), { timeout: TIMEOUT });
    ok(true, 'Settings shows Marketstack 0/100 requests this month');
    await q.click('#tabList'); await q.waitForSelector('#asxLoad');
    ok((await text(q, '#asxLoad')) === 'Load closes for 24 tickers (uses 24 requests)' && (await text(q, '#msLeft')) === '100 of 100', 'ASX list: explicit load button shows the cost (23 tickers + STW proxy)');
    await tap(q, '#asxLoad');
    await q.waitForFunction(() => [...document.querySelectorAll('#list .price')].every(e => e.textContent.startsWith('A$')), { timeout: TIMEOUT });
    arows = await rowsOf(q);
    const msNow = Date.now(), lastClose = c => mocks.marketstackEod([c + '.AX'], new Date(msNow - 10 * 864e5).toISOString().slice(0, 10), msNow).data[0].close;
    ok(money(arows.find(r => r.sym === 'BHP').price) === lastClose('BHP') && arows.find(r => r.sym === 'BHP').sub.includes('close '), 'ASX rows show the end-of-day close in A$: BHP ' + arows.find(r => r.sym === 'BHP').price);
    const msCalls = apiLog.filter(a => a.host === 'api.marketstack.com');
    ok(msCalls.length === 1 && new URL(msCalls[0].url).searchParams.get('symbols').split(',').length === 24 && msCalls[0].url.includes('BHP.AX') && msCalls[0].url.endsWith('access_key=' + MS_KEY), 'one Marketstack call for 24 symbols (SYMBOL.AX), key as access_key');
    await q.waitForFunction(() => document.querySelector('#asxLoad') && /up to date/.test(document.querySelector('#asxLoad').textContent));
    ok((await text(q, '#msLeft')) === '76 of 100', 'budget counts every symbol: 76 of 100 left');
    ok(/^ASX end-of-day closes, latest [A-Z][a-z]{2} \d+, 20\d\d$/.test(await text(q, '#asof')), 'status line says ASX prices are end-of-day closes, with the date: ' + await text(q, '#asof'));
    ok(money(await q.$eval('.ov-tile .v', e => e.textContent)) === lastClose('STW') && (await q.$$eval('#gainers li, #losers li', e => e.length)) > 0, 'ASX overview: STW proxy close and end-of-day movers');
    await dbg('asx-loaded');
    await tap(q, '#list li[data-sym=CBA]');
    await q.waitForFunction(() => window.__app.chart.data().length > 200 && document.querySelector('#dPrice').textContent.startsWith('A$'), { timeout: TIMEOUT });
    ok((await text(q, '#dChange')).includes('end-of-day close') && await q.$eval('#ranges [data-range="1Y"]', e => e.classList.contains('on')), 'ASX detail: 1 year of end-of-day closes, labelled');
    ok((await q.$eval('[data-metric="52-week high (closes)"]', e => e.textContent)).startsWith('A$') && (await q.$eval('[data-metric="P/E (trailing)"]', e => e.textContent)) === 'n/a (not on free tier)', 'ASX metrics: 52-week range from closes, the rest n/a');
    ok((await text(q, '#chartMsg')).includes('75 requests left'), 'ASX history costs 1 request: ' + await text(q, '#chartMsg'));
    await dbg('asx-detail');
    // portfolio
    const msBefore = apiLog.filter(a => a.host === 'api.marketstack.com').length;
    await q.click('#tabPortfolio'); await q.waitForSelector('#v-portfolio:not([hidden])');
    ok((await text(q, '#pfPrompt')).includes('FANG, SEMI, IVV') && await visible(q, '#pfPrompt'), 'portfolio: seeded FANG, SEMI, IVV with a prompt to enter units and cost');
    ok((await q.$$eval('#pfList li', l => l.map(x => x.dataset.hid).join())) === 'ASX:FANG,ASX:SEMI,ASX:IVV' && (await text(q, '#pfValue')) === '—', 'seed holdings have no amounts (units 0), so no total yet');
    const seed = await q.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.portfolio.v1')));
    ok(seed.holdings.every(h => h.units === 0 && h.avgCost === null), 'stored seed: units 0, cost blank');
    await tap(q, '#pfList li[data-hid="ASX:FANG"]'); await q.waitForSelector('#pfForm:not([hidden])');
    ok((await text(q, '#pfFormTitle')) === 'Edit FANG (ASX)' && (await text(q, '#pfCur')) === 'A$', 'tap a holding to edit it (AUD)');
    await q.type('#pfForm [name=units]', '10'); await q.type('#pfForm [name=avgCost]', '20'); await tap(q, '#pfForm button[type=submit]');
    const fangV = 10 * lastClose('FANG');
    await q.waitForFunction(v => document.querySelector('#pfValue').textContent === v, { timeout: TIMEOUT }, aud(fangV));
    ok((await text(q, '#pfGain')).startsWith(fangV - 200 >= 0 ? '+A$' : '−A$') && (await text(q, '#pfCost')) === 'A$200.00', 'FANG value = units × close; cost and unrealised gain in AUD: ' + await text(q, '#pfGain'));
    ok(apiLog.filter(a => a.host === 'api.marketstack.com').length === msBefore, 'FANG close came from cache (no extra Marketstack request)');
    await tap(q, '#pfAddBtn'); await q.type('#pfForm [name=symbol]', 'aapl'); await q.select('#pfForm [name=exchange]', 'US');
    ok((await text(q, '#pfCur')) === 'US$', 'US holding cost entered in US$');
    await q.type('#pfForm [name=units]', '2'); await q.type('#pfForm [name=avgCost]', '100'); await tap(q, '#pfForm button[type=submit]');
    const aaplV = 2 * mocks.quote('AAPL').c * 1.5;
    await q.waitForFunction(v => document.querySelector('#pfValue').textContent === v, { timeout: 2 * TIMEOUT }, aud(fangV + aaplV));
    const fxTxt = await text(q, '#pfFx');
    ok(/^USD→AUD 1\.5000 · Twelve Data, as of /.test(fxTxt), 'US holding converted at a live USD/AUD rate, labelled with source and time: ' + fxTxt);
    const weights = (await q.$$eval('[data-weight]', e => e.map(x => x.textContent))).filter(Boolean).map(parseFloat);
    ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 100) < 0.3 && Math.abs(weights[0] - fangV / (fangV + aaplV) * 100) < 0.06, 'weights per holding add up to 100%: ' + weights.join(', '));
    ok((await text(q, '#pfDay')) !== '—', 'today\u2019s change shown: ' + await text(q, '#pfDay'));
    const qHist = await q.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.pfvalue.v1') || 'null'));
    ok(qHist && qHist.days.length === 1 && Math.abs(qHist.days[0].v - (fangV + aaplV)) < 0.011 && qHist.days[0].sig === 'AAPL=2,ASX:FANG=10' && await q.evaluate(() => window.__app.pfChart.data().length) >= 1 && (await text(q, '#pfChartNow')) === (await text(q, '#pfValue')),
      'live total saved once for today (AUD, ticker=units only) and charted: ' + JSON.stringify(qHist && qHist.days.map(x => [x.d, x.v, x.pc])));
    await tap(q, '#pfAddBtn'); await q.type('#pfForm [name=symbol]', 'AAPL'); await q.select('#pfForm [name=exchange]', 'US'); await tap(q, '#pfForm button[type=submit]');
    ok((await text(q, '#pfMsg')).includes('already'), 'duplicate holding refused'); await tap(q, '#pfCancel');
    await dbg('portfolio-live');
    ok(!apiLog.some(a => a.host === 'api.frankfurter.dev'), 'with a Twelve Data key the ECB fallback is not needed');
    // earnings
    await q.click('#tabEarnings');
    await q.waitForSelector('[data-earn]', { timeout: 2 * TIMEOUT });
    const earn = await q.$$eval('[data-earn]', e => e.map(x => x.textContent));
    ok(earn.length === 2 && earn[0].includes('AAPL') && earn[0].includes('watchlist') && earn[0].includes('portfolio') && earn[0].includes('After market close') && earn[0].includes('$1.85'), 'earnings: AAPL (watchlist + portfolio), after close, EPS estimate: ' + earn[0]);
    ok(earn[1].includes('MSFT') && earn[1].includes('Before market open') && earn[1].includes('n/a'), 'earnings: MSFT before open, EPS estimate n/a when absent');
    const calCalls = apiLog.filter(a => a.url.includes('/calendar/earnings') && !new URL(a.url).searchParams.get('symbol'));
    ok(calCalls.length === 1 && (await text(q, '#earnInfo')).includes('ASX earnings dates: n/a'), 'one calendar call for 14 days; NVDA (day 20) and other tickers filtered out; ASX gap explained');
    await dbg('earnings-live');
    // news on a US detail page
    await q.goto(BASE + '#/s/AAPL');
    await q.waitForFunction(() => document.querySelectorAll('#news a').length === 2, { timeout: 2 * TIMEOUT });
    const links = await q.$$eval('#news a', a => a.map(x => ({ href: x.getAttribute('href'), t: x.target, rel: x.rel })));
    ok(links[0].href === 'https://example.com/news/1' && links.every(l => l.t === '_blank' && l.rel === 'noopener noreferrer'), 'news: headlines link out in a new tab (noopener, noreferrer); bad/duplicate links dropped');
    ok(/MockWire · \d+ (min|h) ago/.test(await text(q, '#news')), 'news shows source and time');
    // alerts
    await q.click('#dAlert'); await q.waitForSelector('#v-alerts:not([hidden])');
    ok(await q.$eval('#alForm [name=sym]', e => e.value) === 'AAPL', 'Alert button on the detail page pre-fills the ticker');
    ok((await text(q, '#alHow')).includes('Background push') && (await text(q, '#alHow')).includes('needs a server') && (await text(q, '#notifState')).includes('Notifications are on'), 'honest note: checks only while open, no background push; notification permission state shown');
    await q.type('#alForm [name=value]', String(Math.floor(mocks.quote('AAPL').c - 1))); await tap(q, '#alForm button[type=submit]');
    await q.waitForFunction(() => document.querySelectorAll('#alHistory li[data-hist]').length === 1, { timeout: TIMEOUT });
    ok((await text(q, '#bannerText')).includes('AAPL is above') && (await text(q, '#alHistory')).includes('AAPL is above'), 'price-above alert fires on check: banner + history');
    const msftC = mocks.quote('MSFT').c;
    await q.$eval('#alForm [name=sym]', e => { e.value = ''; }); await q.type('#alForm [name=sym]', 'MSFT'); await q.type('#alForm [name=value]', String(Math.ceil(msftC + 5)));
    await tap(q, '#alForm button[type=submit]'); await sleep(500);
    ok(await q.$$eval('#alRules li[data-rule]', e => e.length) === 2 && await q.$$eval('#alHistory li[data-hist]', e => e.length) === 1, 'second alert (MSFT above) saved, not fired yet');
    await q.click('#tabList'); if (await q.$eval('#mkUS', e => !e.classList.contains('on'))) await q.click('#mkUS');
    mockOpts.quoteOverride = { MSFT: Math.ceil(msftC + 10) };
    const nBefore = await q.evaluate(() => window.__app.notifyCount);
    await q.click('#refresh');
    await q.waitForFunction(() => !document.querySelector('#alertBadge').hidden, { timeout: 2 * TIMEOUT });
    ok((await text(q, '#alertBadge')) === '1' && (await text(q, '#bannerText')).includes('MSFT is above'), 'alert fires on refresh while on another tab: badge 1 + banner');
    ok(await q.evaluate(() => window.__app.notifyCount) === nBefore + 1, 'a notification is raised when permission is granted');
    await q.click('#tabAlerts'); await q.waitForSelector('#v-alerts:not([hidden])');
    ok(await q.$$eval('#alHistory li[data-hist]', e => e.length) === 2 && await q.$eval('#alertBadge', e => e.hidden), 'alert history lists both; badge clears once seen');
    await q.reload({ waitUntil: 'networkidle0' }); await sleep(2000);
    const al = await q.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.alerts.v1')));
    ok(al.rules.length === 2 && al.history.length === 2, 'alerts and history persist; no duplicate firing on app open');
    mockOpts.quoteOverride = {};
    // provider status
    await q.click('#gear'); await q.waitForSelector('#usageTable');
    const usage = await q.$$eval('[data-usage]', e => Object.fromEntries(e.map(x => [x.dataset.usage, x.textContent])));
    ok(/calls in the last minute/.test(usage.finnhub) && /\/800 today/.test(usage.twelvedata) && usage.marketstack.startsWith('25/100 requests this month') && /today/.test(usage.frankfurter), 'Settings: calls used per provider: ' + JSON.stringify(usage));
    await q.$eval('#msCap', e => { e.value = '30'; e.dispatchEvent(new Event('change')); });
    await q.waitForFunction(() => /25\/30 requests/.test(document.querySelector('#usage').textContent));
    ok(true, 'Marketstack monthly cap is adjustable'); await dbg('settings-live');
    const ls4 = await q.evaluate(() => Object.keys(localStorage).filter(k => k !== 'stockwatch.keys.v1').map(k => localStorage.getItem(k)).join('\n'));
    ok(![FH_KEY, TD_KEY, MS_KEY].some(k => ls4.includes(k)), 'no key inside cached data, portfolio or alerts');
    await ctx4.close();

    // ---------- ASX prices from your own Google Sheet (no API keys at all), then backup + restore ----------
    const ctx5 = await browser.createBrowserContext();
    await ctx5.overridePermissions(new URL(BASE).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const g = await newPage(ctx5);
    // Share-sheet stand-in: records the File given to navigator.share. localStorage 'test.share' = ok | abort | none (none = no Web Share, like desktop Chrome).
    await g.evaluateOnNewDocument(() => {
      window.__shared = []; window.__downloads = [];
      const mode = () => localStorage.getItem('test.share') || 'none';
      Object.defineProperty(navigator, 'canShare', { configurable: true, get: () => (mode() === 'none' ? undefined : d => !!(d && d.files && d.files.length && d.files[0] instanceof File)) });
      Object.defineProperty(navigator, 'share', { configurable: true, get: () => (mode() === 'none' ? undefined : async d => {
        if (mode() === 'abort') throw new DOMException('Share canceled', 'AbortError');
        const f = d.files[0]; window.__shared.push({ name: f.name, type: f.type, title: d.title, text: await f.text() });
      }) });
      const blobs = {}, mk = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { const u = mk(b); blobs[u] = b; return u; };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.download && blobs[this.href]) { const a = this; window.__downloads.push(blobs[a.href].text().then(t => ({ name: a.download, text: t }))); return; } return click.call(this); };
    });
    await g.goto(BASE, { waitUntil: 'domcontentloaded' }); await g.waitForSelector('#v-setup:not([hidden])');
    apiLog.length = 0;
    const gm = s => parseFloat(String(s).replace(/[A$,+\s]/g, '').replace('−', '-'));
    const audG = v => 'A$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ok((await text(g, '#v-setup')).includes('free through a Google Sheet') && !/signup\/free|pricing|paid/i.test(await g.$eval('#v-setup', e => e.innerHTML)), 'setup screen explains free ASX prices via a Google Sheet, no paid sign-up link');
    await tap(g, '#setupAsx'); await g.waitForSelector('#v-settings:not([hidden])'); await sleep(150);
    ok(await g.$eval('#sheetHow', e => e.open) && /Anyone with the link/.test(await text(g, '#sheetHow')) && /Copy formula/.test(await text(g, '#sheetHow')), '"Only want ASX prices?" opens the step-by-step Google Sheet guide');
    await tap(g, '#sheetCopy'); await g.waitForFunction(() => /Formula copied|Couldn/.test(document.querySelector('#sheetMsg').textContent));
    const formula = await g.evaluate(() => window.__app.lastFormula);
    ok(formula.startsWith('={"Symbol","Price","PrevClose","TradeTime";"FANG",') && /GOOGLEFINANCE\("ASX:SEMI","price"\)/.test(formula) && /"IVV",/.test(formula) && /"STW",/.test(formula) && formula.split(';').length === 25,
      'Copy formula: one A1 formula for FANG, SEMI, IVV, the rest of the ASX list and STW (24 tickers): ' + (await text(g, '#sheetMsg')).slice(0, 50));
    const clip = await g.evaluate(() => navigator.clipboard.readText().catch(() => null));
    ok(clip === null || clip === formula, 'clipboard holds the formula' + (clip === null ? ' (clipboard not readable here)' : ''));
    await g.type('#sheetUrl', 'https://example.com/prices.csv'); await tap(g, '#sheetSave');
    ok((await text(g, '#sheetMsg')).includes('docs.google.com') && !apiLog.length, 'a non-Google link is refused with a reason, nothing fetched');
    mockOpts.sheetStatus = 401;
    await g.$eval('#sheetUrl', e => { e.value = ''; }); await g.type('#sheetUrl', SHEET_LINK); await tap(g, '#sheetSave');
    await g.waitForFunction(() => /wasn\u2019t saved/.test(document.querySelector('#sheetMsg').textContent));
    ok((await text(g, '#sheetMsg')).includes('Anyone with the link') && await g.evaluate(() => !JSON.parse(localStorage.getItem('stockwatch.settings.v1') || '{}').asxSheetUrl), 'unshared sheet: explained, link not saved');
    mockOpts.sheetStatus = 200; await tap(g, '#sheetSave');
    await g.waitForFunction(() => /^Saved/.test(document.querySelector('#sheetMsg').textContent));
    const smsg = await text(g, '#sheetMsg');
    ok(smsg.startsWith('Saved. Found 6 ASX prices (FANG, SEMI, IVV, BHP, CBA…)') && /Not in the sheet: .*WES/.test(smsg), 'Save and test: link saved, prices found, missing tickers listed: ' + smsg.slice(0, 90));
    ok(apiLog.some(a => a.host === 'docs.google.com' && a.url.endsWith('/pub?output=csv')) && apiLog.some(a => a.host === 'doc-0s-sheets.googleusercontent.com'), 'published link fetched as CSV, following Google\u2019s redirect (allowed by the CSP)');
    ok(/Google Sheet/.test(await text(g, '#usage')), 'Settings usage table lists the Google Sheet');
    await g.click('#tabList'); await g.waitForSelector('#v-list:not([hidden])');
    if (await g.$eval('#mkASX', e => !e.classList.contains('on'))) await g.click('#mkASX');
    await g.waitForFunction(() => { const li = document.querySelector('#list li[data-sym=FANG] .price'); return li && li.textContent.startsWith('A$'); }, { timeout: TIMEOUT });
    let grows = await rowsOf(g);
    const fp = mocks.sheetPrice('FANG'), row = sym => grows.find(r => r.sym === sym);
    ok(row('FANG').price === audG(fp.price) && Math.abs(pctNum(row('FANG').pct) - +((fp.price / fp.prev - 1) * 100).toFixed(2)) < 0.006 && row('SEMI').price === audG(mocks.sheetPrice('SEMI').price) && row('IVV').price === audG(mocks.sheetPrice('IVV').price),
      'ASX list: FANG, SEMI and IVV priced from the sheet: ' + ['FANG', 'SEMI', 'IVV'].map(s => s + ' ' + row(s).price + ' ' + row(s).pct).join(', '));
    ok(row('WES').sub.includes('Not in your sheet yet') && (await text(g, '#asxMissing')).includes('WES') && !!(await g.$('#asxCopy')), 'tickers missing from the sheet say so, with a Copy updated formula button');
    ok((await text(g, '#asxBar')).includes('your Google Sheet') && (await text(g, '#asof')).startsWith('ASX prices from your Google Sheet, delayed, last trade') && (await text(g, '#pxHead')) === 'Price · Day (A$)', 'ASX bar, header and status line say: Google Sheet, delayed');
    ok(gm(await g.$eval('.ov-tile .v', e => e.textContent)) === mocks.sheetPrice('STW').price && (await g.$eval('.ov-tile .p', e => e.textContent)) === 'STW proxy · delayed', 'ASX 200 tile: STW price from the sheet');
    ok(!apiLog.some(a => a.host === 'api.marketstack.com' || a.host === 'finnhub.io' || a.host === 'api.twelvedata.com') && apiLog.filter(a => a.host === 'docs.google.com').length <= 4, 'no keys needed: only Google Sheets was called (' + apiLog.filter(a => a.host === 'docs.google.com').length + ' sheet requests)');
    await tap(g, '#list li[data-sym=FANG]'); await g.waitForSelector('#v-detail:not([hidden])');
    await g.waitForFunction(() => document.querySelector('#dPrice').textContent.startsWith('A$'));
    ok((await text(g, '#dPrice')) === audG(fp.price) && (await text(g, '#dChange')).includes('Google Finance via your sheet') && (await text(g, '#chartMsg')).includes('Marketstack') && (await text(g, '#dNote')).includes('Google Finance'), 'ASX detail: sheet price, labelled; chart explains it needs the optional Marketstack key');
    await g.click('#tabPortfolio'); await g.waitForSelector('#v-portfolio:not([hidden])');
    await tap(g, '#pfList li[data-hid="ASX:FANG"]'); await g.waitForSelector('#pfForm:not([hidden])');
    await g.type('#pfForm [name=units]', '100'); await g.type('#pfForm [name=avgCost]', '20'); await tap(g, '#pfForm button[type=submit]');
    await g.waitForFunction(() => document.querySelector('#pfValue').textContent.startsWith('A$'), { timeout: TIMEOUT });
    ok(gm(await text(g, '#pfValue')) === +(100 * fp.price).toFixed(2) && !(await text(g, '#pfList')).includes(' close') && (await text(g, '#pfNote')).includes('Google Finance'), 'portfolio values FANG at the sheet price: ' + await text(g, '#pfValue'));
    // value chart on the first day with only a Google Sheet: previous close → now, labelled honestly, no extra requests
    const reqBefore = apiLog.length; await sleep(800);
    const gBars = await g.evaluate(() => window.__app.pfChart.data()), gHist = await g.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.pfvalue.v1') || 'null'));
    ok(gBars.length === 2 && gBars[0].src === 'prev' && gBars[0].c === +(100 * fp.prev).toFixed(2) && gBars[1].c === +(100 * fp.price).toFixed(2) && gBars[1].d === '2026-10-08' && gBars[0].d === '2026-10-07',
      'first-day value chart: previous close then the sheet total, dated by the sheet\u2019s trade date: ' + JSON.stringify(gBars.map(b => [b.d, b.c, b.src])));
    ok(gHist && gHist.days.length === 1 && gHist.days[0].d === '2026-10-08' && gHist.days[0].pc === +(100 * fp.prev).toFixed(2), 'sheet total and previous close saved on this device for the chart');
    const gHead = await text(g, '#pfChartHead'), gRange = await text(g, '#pfChartRange'), gNote = await text(g, '#pfChartNote');
    ok(/vs .*\(previous close\)/.test(gHead) && gRange.includes('2 daily points') && gRange.includes('all the history on this device') && /can\u2019t share past prices/.test(gNote) && /Hollow dots: the previous close/.test(gNote) && await g.$eval('#pfChartBadge', e => e.hidden),
      'thin history is labelled as such: ' + gRange);
    ok(await g.$$eval('#pfRanges button', bs => bs.filter(b => b.disabled).map(b => b.dataset.pfrange).join()) === '3M,1Y' && !apiLog.slice(reqBefore).some(a => a.host !== 'docs.google.com' && a.host !== 'doc-0s-sheets.googleusercontent.com'),
      'ranges longer than the history are disabled; the chart made no requests and needed no key');
    await g.click('#tabAlerts'); await g.waitForSelector('#v-alerts:not([hidden])');
    await g.$eval('#alForm [name=sym]', e => { e.value = ''; }); await g.type('#alForm [name=sym]', 'FANG'); await g.select('#alForm [name=market]', 'ASX'); await g.select('#alForm [name=type]', 'below');
    await g.type('#alForm [name=value]', String(Math.ceil(fp.price + 1))); await tap(g, '#alForm button[type=submit]'); await sleep(500);
    ok(await g.$$eval('#alHistory li[data-hist]', e => e.length) === 1 && (await text(g, '#alHistory')).includes('FANG'), 'ASX alert fires from the sheet price');

    // backup reminder (pretend first use was 15 days ago) -> Back up now from the nudge -> share sheet gets a JSON File
    await g.evaluate(k => { const m = JSON.parse(localStorage.getItem('stockwatch.backup.v1')); m.firstSeenAt = Date.now() - 15 * 864e5; localStorage.setItem('stockwatch.backup.v1', JSON.stringify(m));
      localStorage.setItem('test.share', 'ok'); localStorage.setItem('stockwatch.keys.v1', JSON.stringify({ finnhub: '', twelvedata: '', marketstack: k })); }, MS_KEY);
    await g.goto(BASE + '#/', { waitUntil: 'domcontentloaded' }); await g.reload({ waitUntil: 'domcontentloaded' });
    await g.waitForSelector('#backupNudge:not([hidden])');
    ok((await text(g, '#backupNudge')).includes('No backup yet'), 'gentle reminder on the watchlist after 14 days without a backup');
    await tap(g, '#nudgeBackup'); await g.waitForFunction(() => window.__shared.length === 1);
    const sh1 = (await g.evaluate(() => window.__shared))[0], b1 = JSON.parse(sh1.text);
    ok(/^stock-watchlist-backup-\d{4}-\d{2}-\d{2}\.json$/.test(sh1.name) && sh1.type === 'application/json', 'Back up now hands a JSON File to the iPhone share sheet: ' + sh1.name);
    ok(b1.app === 'stock-watchlist' && b1.includesKeys === false && !sh1.text.includes(MS_KEY) && !('keys' in b1.data), 'backup leaves API keys out by default');
    ok(b1.data.portfolio.holdings.find(h => h.symbol === 'FANG').units === 100 && b1.data.alerts.rules.length === 1 && b1.data.alerts.history.length === 1 && b1.data.watchlists.ASX.symbols.length === 23 && b1.data.watchlists.ASX.favourites.length === 3 && b1.data.watchlists.US.symbols.length === 50 && b1.data.settings.asxSheetUrl === SHEET_LINK,
      'backup has watchlists, favourites, portfolio, alerts and settings (incl. the sheet link)');
    ok(await g.$eval('#backupNudge', e => e.hidden), 'reminder goes away after a backup');
    await g.click('#gear'); await g.waitForSelector('#v-settings:not([hidden])');
    ok(/^Last backup: .+\(today\)$/.test(await text(g, '#backupLast')), 'Settings shows the last backup date: ' + await text(g, '#backupLast'));
    await tap(g, '#backupKeys'); await tap(g, '#backupNow'); await g.waitForFunction(() => window.__shared.length === 2);
    const b2 = JSON.parse((await g.evaluate(() => window.__shared))[1].text);
    ok(b2.includesKeys === true && b2.data.keys.marketstack === MS_KEY, 'ticking "Include API keys" puts them in the file');
    await tap(g, '#backupKeys');
    await g.evaluate(() => localStorage.setItem('test.share', 'abort')); await tap(g, '#backupNow');
    await g.waitForFunction(() => /cancelled/.test(document.querySelector('#backupMsg').textContent)); ok(true, 'closing the share sheet: "Backup cancelled", nothing saved');
    await g.evaluate(() => localStorage.setItem('test.share', 'none')); await tap(g, '#backupNow');
    await g.waitForFunction(() => window.__downloads.length === 1);
    const dl = await g.evaluate(() => window.__downloads[0]);
    ok(/^stock-watchlist-backup-.*\.json$/.test(dl.name) && JSON.parse(dl.text).app === 'stock-watchlist' && (await text(g, '#backupMsg')).startsWith('Backup downloaded'), 'no Web Share: falls back to a file download');

    // restore: wrong file refused; right file previewed, confirmed, restored
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-e2e-')), goodFile = path.join(tmp, sh1.name), gymFile = path.join(tmp, 'gym-tracker-backup.json'), junkFile = path.join(tmp, 'notes.json');
    fs.writeFileSync(goodFile, sh1.text); fs.writeFileSync(gymFile, JSON.stringify({ app: 'gym-tracker', kind: 'backup', version: 1, data: { sets: [] } })); fs.writeFileSync(junkFile, 'hello');
    await (await g.$('#restoreFile')).uploadFile(gymFile);
    await g.waitForFunction(() => /Gym Tracker backup/.test(document.querySelector('#backupMsg').textContent));
    await (await g.$('#restoreFile')).uploadFile(junkFile);
    await g.waitForFunction(() => /valid JSON/.test(document.querySelector('#backupMsg').textContent));
    ok(await g.$eval('#restorePreview', e => e.hidden), 'restore refuses a Gym Tracker file and a non-JSON file, with the reason');
    await g.evaluate(() => { const w = JSON.parse(localStorage.getItem('stockwatch.watchlist.asx.v1')) || JSON.parse(JSON.stringify(window.__app.wls.ASX)); w.symbols = w.symbols.filter(s => s.symbol !== 'BHP'); localStorage.setItem('stockwatch.watchlist.asx.v1', JSON.stringify(w));
      const p = JSON.parse(localStorage.getItem('stockwatch.portfolio.v1')); p.holdings.find(h => h.symbol === 'FANG').units = 1; localStorage.setItem('stockwatch.portfolio.v1', JSON.stringify(p));
      localStorage.setItem('stockwatch.alerts.v1', JSON.stringify({ version: 1, rules: [], history: [] })); });
    await (await g.$('#restoreFile')).uploadFile(goodFile);
    await g.waitForSelector('#restorePreview:not([hidden])');
    const prev = await g.$$eval('#restoreTable tr', t => t.map(r => [...r.children].map(c => c.textContent)));
    const pr = name => prev.find(r => r[0] === name) || [];
    ok(pr('ASX watchlist')[1] === '22 tickers' && pr('ASX watchlist')[2] === '23 tickers' && pr('Portfolio')[1].includes('3 holdings') && pr('Alerts')[1] === '0 rules, 0 fired' && pr('Alerts')[2] === '1 rules, 1 fired' && pr('API keys')[2] === 'kept',
      'restore preview shows what will be replaced (now vs backup), keys kept: ' + JSON.stringify(prev.slice(1, 4)));
    await tap(g, '#restoreCancel'); ok(await g.$eval('#restorePreview', e => e.hidden) && (await text(g, '#backupMsg')).includes('Nothing changed'), 'Cancel leaves everything as it was');
    // Merge: keeps this device's FANG units (1), adds BHP back and the alert rule
    await (await g.$('#restoreFile')).uploadFile(goodFile); await g.waitForSelector('#restorePreview:not([hidden])');
    ok(await g.$('#restoreMerge') !== null && await g.$('#restoreGo') !== null, 'restore preview offers Merge and Replace');
    await Promise.all([g.waitForNavigation({ waitUntil: 'domcontentloaded' }), tap(g, '#restoreMerge')]);
    await g.waitForFunction(() => /Merged the backup/.test(document.querySelector('#bannerText').textContent) && !document.querySelector('#banner').hidden, { timeout: TIMEOUT });
    const merged = await g.evaluate(() => ({ asx: JSON.parse(localStorage.getItem('stockwatch.watchlist.asx.v1')).symbols.map(s => s.symbol), fang: JSON.parse(localStorage.getItem('stockwatch.portfolio.v1')).holdings.find(h => h.symbol === 'FANG').units,
      rules: JSON.parse(localStorage.getItem('stockwatch.alerts.v1')).rules.length }));
    ok(merged.asx.includes('BHP') && merged.asx.length === 23 && merged.fang === 1 && merged.rules === 1, 'Merge adds what is only in the backup and keeps this device\'s values: ' + JSON.stringify({ n: merged.asx.length, fang: merged.fang, rules: merged.rules }));
    if (await g.$eval('#v-settings', e => e.hidden)) { await tap(g, '#gear'); await g.waitForSelector('#v-settings:not([hidden])'); }
    await (await g.$('#restoreFile')).uploadFile(goodFile); await g.waitForSelector('#restorePreview:not([hidden])');
    await Promise.all([g.waitForNavigation({ waitUntil: 'domcontentloaded' }), tap(g, '#restoreGo')]);
    await g.waitForFunction(() => /Restored from backup/.test(document.querySelector('#bannerText').textContent) && !document.querySelector('#banner').hidden, { timeout: TIMEOUT });
    const after = await g.evaluate(() => ({ asx: JSON.parse(localStorage.getItem('stockwatch.watchlist.asx.v1')).symbols.map(s => s.symbol), fang: JSON.parse(localStorage.getItem('stockwatch.portfolio.v1')).holdings.find(h => h.symbol === 'FANG').units,
      rules: JSON.parse(localStorage.getItem('stockwatch.alerts.v1')).rules.length, keys: JSON.parse(localStorage.getItem('stockwatch.keys.v1')) }));
    ok(after.asx.includes('BHP') && after.asx.length === 23 && after.fang === 100 && after.rules === 1 && after.keys.marketstack === MS_KEY, 'confirmed restore brings everything back after a reload; keys on the device are kept');
    fs.rmSync(tmp, { recursive: true, force: true });
    await ctx5.close();

    // ---------- service worker ----------
    const ctx3 = await browser.createBrowserContext(); const s = await newPage(ctx3, { bypassSW: false });
    await s.goto(BASE, { waitUntil: 'networkidle0' });
    const swOk = await s.evaluate(async () => { const reg = await navigator.serviceWorker.ready; const ks = await caches.keys(); const c = await caches.open('stockwatch-shell-v5'); return { active: !!reg.active, ks, idx: !!(await c.match('index.html')), list: !!(await c.match('data/default-watchlist.json')) && !!(await c.match('data/asx-watchlist.json')) }; });
    ok(swOk.active && swOk.idx && swOk.list, 'service worker active and app shell cached: ' + swOk.ks.join());
    await s.setOfflineMode(true); await s.reload({ waitUntil: 'domcontentloaded' });
    ok(await s.$('#v-setup') !== null, 'app shell loads offline from the cache');
    await ctx3.close();
  } catch (e) { errs.push('exception: ' + (e.stack || e)); }
  await browser.close();
  console.log(`\ne2e: ${passed} passed, ${errs.length} problems`);
  if (errs.length) { console.log(errs.join('\n')); process.exitCode = 1; }
})();
