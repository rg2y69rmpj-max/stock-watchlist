// Headless check on an iPhone-sized screen with mocked Finnhub/Twelve Data responses (no real keys, no real network calls).
// Needs puppeteer-core on NODE_PATH and Chrome. Serve the app first:  python3 -m http.server 8765
// Env: BASE_URL (default http://localhost:8765/), CHROME_PATH (default /usr/bin/google-chrome), SHOTS_DIR (optional: save list/detail screenshots there).
const puppeteer = require('puppeteer-core');
const path = require('path');
const mocks = require('./mocks.js');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS_DIR || '';
const FH_KEY = 'FAKE_FINNHUB_KEY_FOR_TESTS', TD_KEY = 'FAKE_TWELVE_KEY_FOR_TESTS';
const IPHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const errs = [], mockOpts = { finnhubLimit: false, twelveLimit: false }, apiLog = [];
let passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('ok -', m); } else { errs.push('FAIL ' + m); console.log('FAIL -', m); } };

async function newPage(ctx, { bypassSW = true } = {}) {
  const p = await ctx.newPage();
  await p.setViewport(IPHONE); await p.setUserAgent(UA);
  if (bypassSW) await p.setBypassServiceWorker(true); // so page-level request interception sees every API call
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|429)/.test(m.text())) errs.push('console: ' + m.text()); });
  p.on('dialog', d => d.accept());
  await p.setRequestInterception(true);
  p.on('request', req => {
    const url = req.url(), host = new URL(url).hostname;
    if (host !== 'finnhub.io' && host !== 'api.twelvedata.com') { if (host === 'localhost' || host === '127.0.0.1') return req.continue(); errs.push('unexpected request: ' + host); return req.abort(); }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    const headers = req.headers();
    apiLog.push({ host, url, auth: headers.authorization || '' });
    const r = mocks.respond(url, { ...mockOpts, authorization: headers.authorization });
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
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    // ---------- static files ----------
    const ctx0 = await browser.createBrowserContext(); const p0 = await newPage(ctx0);
    for (const u of ['index.html', 'manifest.webmanifest', 'sw.js', 'data/default-watchlist.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon-180.png', 'favicon.ico']) {
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
    await p.waitForFunction(() => [...document.querySelectorAll('#list .price')].every(e => e.textContent !== '—'), { timeout: 30000 });
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
    await p.waitForFunction(() => { const li = document.querySelector('#list li[data-sym=IBM]'); return li && li.querySelector('.price').textContent !== '—'; }, { timeout: 90000 }); // may wait for the 55/min window
    ok(true, 'add ticker IBM: row appears with a price');
    await p.type('#addInput', 'IBM'); await p.click('#addForm button[type=submit]'); ok((await text(p, '#addMsg')).includes('already'), 'adding a duplicate is refused');
    await p.type('#addInput', '$$'); await p.click('#addForm button[type=submit]'); ok((await text(p, '#addMsg')).includes('Invalid ticker'), 'invalid ticker is refused');
    await p.$eval('#addInput', e => { e.value = ''; }); await p.type('#addInput', 'ZZZZ'); await p.click('#addForm button[type=submit]');
    await p.waitForFunction(() => (document.querySelector('#list li[data-sym=ZZZZ] .nm') || {}).textContent?.includes('No quote found'), { timeout: 90000 });
    ok(true, 'unknown ticker is flagged "No quote found", not shown with fake numbers');
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
    ok((await text(p, '#usage')).includes('Finnhub:') && (await text(p, '#usage')).includes('/800 today'), 'usage counters shown: ' + (await text(p, '#usage')).slice(0, 80));
    await p.select('#refreshSel', '300'); ok(await p.evaluate(() => JSON.parse(localStorage.getItem('stockwatch.settings.v1')).refreshSec) === 300, 'auto-refresh setting persists');
    await p.click('#back'); await p.waitForSelector('#v-list:not([hidden])');
    await p.waitForFunction(() => document.querySelectorAll('#list svg.spark').length >= 6, { timeout: 15000 });
    const tdCalls = apiLog.filter(a => a.host === 'api.twelvedata.com');
    ok(tdCalls.length === 1 && new URL(tdCalls[0].url).searchParams.get('symbol').split(',').length === 6, 'sparklines: first batch request covers 6 symbols (1 call, 6 credits)');
    ok(tdCalls.every(a => a.auth === 'apikey ' + TD_KEY && !a.url.includes(TD_KEY)), 'Twelve Data key sent only in the Authorization header');
    const ls = await p.evaluate(() => Object.keys(localStorage).filter(k => k !== 'stockwatch.keys.v1').map(k => localStorage.getItem(k)).join('\n'));
    ok(!ls.includes(FH_KEY) && !ls.includes(TD_KEY), 'keys stored only under stockwatch.keys.v1, never inside cached data');

    // ---------- rate limit error ----------
    mockOpts.finnhubLimit = true;
    await p.click('#refresh');
    await p.waitForFunction(() => /limit reached/.test(document.querySelector('#bannerText').textContent), { timeout: 15000 });
    ok((await text(p, '#bannerText')).includes('60 calls/min'), 'clear message when the Finnhub limit is hit: ' + await text(p, '#bannerText'));
    rows = await rowsOf(p); ok(rows.every(r => priceNum(r.price) > 0), 'cached prices stay visible while rate-limited');
    mockOpts.finnhubLimit = false;
    await ctx.close();

    // ---------- detail page (fresh context with keys already saved) ----------
    const ctx2 = await browser.createBrowserContext(); const d = await newPage(ctx2);
    await d.goto(BASE, { waitUntil: 'domcontentloaded' });
    await d.evaluate((a, b) => { localStorage.setItem('stockwatch.keys.v1', JSON.stringify({ finnhub: a, twelvedata: b })); localStorage.setItem('stockwatch.settings.v1', JSON.stringify({ refreshSec: 0 })); }, FH_KEY, TD_KEY);
    apiLog.length = 0;
    await d.goto(BASE + '#/s/AAPL'); await d.reload({ waitUntil: 'networkidle0' }); // deep link, fresh boot with keys
    await d.waitForFunction(() => document.querySelector('#dPrice').textContent.startsWith('$') && window.__app.chart.data().length > 1, { timeout: 15000 });
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
    await d.click('#tryDemo'); await d.waitForSelector('#v-list:not([hidden])');
    await d.waitForFunction(() => document.querySelectorAll('#list svg.spark').length >= 50);
    ok(!(await d.$eval('#demoBadge', e => e.hidden)) && !(await d.$eval('#demoBanner', e => e.hidden)) && (await text(d, '#delayed')) === 'DEMO data' && (await text(d, '#foot')).includes('DEMO'), 'DEMO mode is labelled in header, banner, status and footer');
    await d.evaluate(() => window.scrollTo(0, 0));
    if (SHOTS) { await d.screenshot({ path: path.join(SHOTS, 'list-demo.png') }); console.log('   saved list-demo.png'); }
    await tap(d, '#list li[data-sym=NVDA]'); await d.waitForFunction(() => window.__app.chart.data().length > 1 && document.querySelector('#consensusLabel'));
    ok((await text(d, '#dChange')).includes('DEMO'), 'detail price is marked DEMO');
    if (SHOTS) {
      // Grow the viewport to the page height (so the fixed footer sits at the bottom), then hold a finger on the chart to show the crosshair.
      const h = await d.evaluate(() => document.documentElement.scrollHeight);
      await d.setViewport({ ...IPHONE, height: h }); await sleep(300);
      const b2 = await (await d.$('#chart')).boundingBox();
      await d.touchscreen.touchStart(b2.x + b2.width * 0.62, b2.y + b2.height / 2); await sleep(150);
      await d.screenshot({ path: path.join(SHOTS, 'detail-demo.png') }); await d.touchscreen.touchEnd();
      await d.setViewport(IPHONE);
      console.log('   saved detail-demo.png');
    }
    ok(apiLog.length === mark, 'DEMO mode makes no API calls (' + (apiLog.length - mark) + ')');
    await ctx2.close();

    // ---------- service worker ----------
    const ctx3 = await browser.createBrowserContext(); const s = await newPage(ctx3, { bypassSW: false });
    await s.goto(BASE, { waitUntil: 'networkidle0' });
    const swOk = await s.evaluate(async () => { const reg = await navigator.serviceWorker.ready; const ks = await caches.keys(); const c = await caches.open('stockwatch-shell-v1'); return { active: !!reg.active, ks, idx: !!(await c.match('index.html')), list: !!(await c.match('data/default-watchlist.json')) }; });
    ok(swOk.active && swOk.idx && swOk.list, 'service worker active and app shell cached: ' + swOk.ks.join());
    await s.setOfflineMode(true); await s.reload({ waitUntil: 'domcontentloaded' });
    ok(await s.$('#v-setup') !== null, 'app shell loads offline from the cache');
    await ctx3.close();
  } catch (e) { errs.push('exception: ' + (e.stack || e)); }
  await browser.close();
  console.log(`\ne2e: ${passed} passed, ${errs.length} problems`);
  if (errs.length) { console.log(errs.join('\n')); process.exitCode = 1; }
})();
