// Run: node tests/logic.test.js
const assert = require('assert');
const L = require('../logic.js');
const mocks = require('./mocks.js');
const { memStorage, clock, test, summary } = require('./helpers.js');
const defaults = require('../data/default-watchlist.json');

(async () => {
  await test('default list: 50 unique, valid tickers with names and snapshot caps, sorted by cap', () => {
    const s = defaults.symbols; assert.strictEqual(s.length, 50);
    assert.strictEqual(new Set(s.map(x => x.symbol)).size, 50);
    s.forEach(x => { assert.ok(L.normalizeSymbol(x.symbol) === x.symbol, x.symbol); assert.ok(x.name); assert.ok(x.marketCapUSD > 1e11); });
    for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].marketCapUSD >= s[i].marketCapUSD);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(defaults.asOf));
    assert.ok(!s.some(x => x.symbol === 'GOOG'), 'one row per company');
  });

  await test('formatting: price, change, percent, big numbers, volume, ratios', () => {
    assert.strictEqual(L.fmtPrice(1234.5), '$1,234.50'); assert.strictEqual(L.fmtPrice(0.12345), '$0.1235'); assert.strictEqual(L.fmtPrice(null), '—');
    assert.strictEqual(L.fmtPct(1.234), '+1.23%'); assert.strictEqual(L.fmtPct(-0.5), '−0.50%'); assert.strictEqual(L.fmtPct(0), '0.00%'); assert.strictEqual(L.fmtPct(NaN), '—');
    assert.strictEqual(L.fmtChange(-2.5), '−2.50'); assert.strictEqual(L.fmtChange(3), '+3.00');
    assert.strictEqual(L.fmtBig(4.9134e12), '$4.91T'); assert.strictEqual(L.fmtBig(242.9e9), '$243B'); assert.strictEqual(L.fmtBig(12.5e6), '$12.50M'); assert.strictEqual(L.fmtBig(-3e9), '−$3.00B');
    assert.strictEqual(L.fmtVolume(34128200), '34.13M'); assert.strictEqual(L.fmtRatio(31.456), '31.46'); assert.strictEqual(L.fmtPercentValue(46.2), '46.20%');
    assert.strictEqual(L.direction(1), 'up'); assert.strictEqual(L.direction(-1), 'down'); assert.strictEqual(L.direction(0), 'flat'); assert.strictEqual(L.direction(null), 'flat');
    assert.strictEqual(L.fmtBarTime('2026-10-07 15:55:00', true), 'Oct 7, 3:55 pm ET'); assert.strictEqual(L.fmtBarTime('2026-10-07 09:30:00', true), 'Oct 7, 9:30 am ET');
    assert.strictEqual(L.fmtBarTime('2026-10-07', false), 'Oct 7, 2026'); assert.strictEqual(L.fmtBarTime('2026-10-07 12:05:00', false), 'Oct 7, 2026');
    assert.ok(L.fmtAsOf(Date.UTC(2026, 9, 7, 20, 0), 'en-US').includes('Oct')); assert.strictEqual(L.fmtAsOf(null), '—');
  });

  await test('show(): absent field = not on free tier, null = not reported, never invented', () => {
    assert.strictEqual(L.show(undefined, L.fmtRatio), 'n/a (not on free tier)');
    assert.strictEqual(L.show(null, L.fmtRatio), 'n/a (not reported)');
    assert.strictEqual(L.show(12.3, L.fmtRatio), '12.30');
  });

  await test('normalizeSymbol', () => {
    assert.strictEqual(L.normalizeSymbol(' aapl '), 'AAPL'); assert.strictEqual(L.normalizeSymbol('brk-b'), 'BRK.B'); assert.strictEqual(L.normalizeSymbol('BRK.B'), 'BRK.B');
    assert.strictEqual(L.normalizeSymbol(''), null); assert.strictEqual(L.normalizeSymbol('<script>'), null); assert.strictEqual(L.normalizeSymbol('1ABC'), null); assert.strictEqual(L.normalizeSymbol('TOOLONGSYMBOL'), null);
  });

  const rows = [
    { symbol: 'MSFT', name: 'Microsoft', price: 529.7, changePct: 0.09, marketCap: 3.9e12 },
    { symbol: 'AAPL', name: 'Apple', price: 336.6, changePct: 0.91, marketCap: 4.9e12 },
    { symbol: 'NVDA', name: 'NVIDIA', price: 237.4, changePct: -1.2, marketCap: 5.7e12 },
    { symbol: 'AMAT', name: 'Applied Materials', price: null, changePct: null, marketCap: 4.1e11 },
    { symbol: 'KO', name: 'Coca-Cola', price: 85.8, changePct: 2.5, marketCap: null }
  ];
  await test('sortRows: each key, both directions, missing values last, stable', () => {
    assert.deepStrictEqual(L.sortRows(rows, 'symbol', 'asc').map(r => r.symbol), ['AAPL', 'AMAT', 'KO', 'MSFT', 'NVDA']);
    assert.deepStrictEqual(L.sortRows(rows, 'symbol', 'desc').map(r => r.symbol), ['NVDA', 'MSFT', 'KO', 'AMAT', 'AAPL']);
    assert.deepStrictEqual(L.sortRows(rows, 'changePct', 'desc').map(r => r.symbol), ['KO', 'AAPL', 'MSFT', 'NVDA', 'AMAT']);
    assert.deepStrictEqual(L.sortRows(rows, 'changePct', 'asc').map(r => r.symbol), ['NVDA', 'MSFT', 'AAPL', 'KO', 'AMAT']);
    assert.deepStrictEqual(L.sortRows(rows, 'price', 'desc').map(r => r.symbol), ['MSFT', 'AAPL', 'NVDA', 'KO', 'AMAT']);
    assert.deepStrictEqual(L.sortRows(rows, 'marketCap', 'desc').map(r => r.symbol), ['NVDA', 'AAPL', 'MSFT', 'AMAT', 'KO']);
    assert.deepStrictEqual(L.sortRows(rows, 'marketCap', 'asc').map(r => r.symbol), ['AMAT', 'MSFT', 'AAPL', 'NVDA', 'KO']);
    assert.deepStrictEqual(rows.map(r => r.symbol), ['MSFT', 'AAPL', 'NVDA', 'AMAT', 'KO'], 'input not mutated');
  });
  await test('sortRows: favourites first keeps the sort inside each group', () => {
    const out = L.sortRows(rows, 'marketCap', 'desc', { favourites: ['KO', 'MSFT'], favouritesFirst: true }).map(r => r.symbol);
    assert.deepStrictEqual(out, ['MSFT', 'KO', 'NVDA', 'AAPL', 'AMAT']);
    assert.deepStrictEqual(L.sortRows(rows, 'marketCap', 'desc', { favourites: new Set(['KO']), favouritesFirst: false }).map(r => r.symbol)[0], 'NVDA');
  });
  await test('searchRows: ticker and name, case-insensitive, exact ticker first', () => {
    assert.deepStrictEqual(L.searchRows(rows, 'aapl').map(r => r.symbol), ['AAPL']);
    assert.deepStrictEqual(L.searchRows(rows, 'app').map(r => r.symbol), ['AAPL', 'AMAT']);
    assert.deepStrictEqual(L.searchRows(rows, 'materials').map(r => r.symbol), ['AMAT']);
    assert.deepStrictEqual(L.searchRows(rows, 'cola').map(r => r.symbol), ['KO']);
    assert.deepStrictEqual(L.searchRows(rows, 'ko').map(r => r.symbol)[0], 'KO');
    assert.strictEqual(L.searchRows(rows, '  ').length, 5); assert.strictEqual(L.searchRows(rows, 'zzz').length, 0);
  });

  await test('watchlist: add, duplicate, invalid, remove (also unfavourites), toggle favourite', () => {
    const wl = L.defaultWatchlist(defaults.symbols); assert.strictEqual(wl.symbols.length, 50);
    assert.strictEqual(L.addSymbol(wl, 'ibm'), true); assert.strictEqual(wl.symbols.at(-1).symbol, 'IBM');
    assert.strictEqual(L.addSymbol(wl, 'IBM'), false); assert.throws(() => L.addSymbol(wl, '$$$'));
    assert.strictEqual(L.toggleFavourite(wl, 'IBM'), true); assert.deepStrictEqual(wl.favourites, ['IBM']);
    assert.strictEqual(L.toggleFavourite(wl, 'NOPE'), false, 'cannot favourite a ticker not in the list');
    assert.strictEqual(L.removeSymbol(wl, 'IBM'), true); assert.deepStrictEqual(wl.favourites, []); assert.strictEqual(wl.symbols.length, 50);
    assert.strictEqual(L.removeSymbol(wl, 'IBM'), false);
    L.toggleFavourite(wl, 'AAPL'); assert.strictEqual(L.toggleFavourite(wl, 'AAPL'), false); assert.deepStrictEqual(wl.favourites, []);
    assert.ok(L.setName(L.defaultWatchlist([{ symbol: 'X' }]), 'X', 'X Corp'));
  });
  await test('watchlist persistence: save/load round trip, corrupt or missing data falls back to defaults', () => {
    const st = memStorage(); const wl = L.loadWatchlist(st, defaults.symbols); assert.strictEqual(wl.symbols.length, 50);
    L.addSymbol(wl, 'IBM', 'IBM'); L.removeSymbol(wl, 'NVDA'); L.toggleFavourite(wl, 'MSFT'); wl.sort = { key: 'changePct', dir: 'asc' }; wl.favouritesFirst = true;
    L.saveWatchlist(st, wl);
    const back = L.loadWatchlist(st, defaults.symbols);
    assert.strictEqual(back.symbols.length, 50); assert.ok(back.symbols.some(s => s.symbol === 'IBM')); assert.ok(!back.symbols.some(s => s.symbol === 'NVDA'));
    assert.deepStrictEqual(back.favourites, ['MSFT']); assert.deepStrictEqual(back.sort, { key: 'changePct', dir: 'asc' }); assert.strictEqual(back.favouritesFirst, true);
    st.setItem(L.KEYS.watchlist, '{not json'); assert.strictEqual(L.loadWatchlist(st, defaults.symbols).symbols.length, 50);
    st.setItem(L.KEYS.watchlist, JSON.stringify({ symbols: [{ symbol: 'aapl' }, { symbol: 'AAPL' }, { symbol: '<bad>' }], favourites: ['AAPL', 'GHOST'], sort: { key: 'evil', dir: 'x' } }));
    const cleaned = L.loadWatchlist(st, defaults.symbols);
    assert.deepStrictEqual(cleaned.symbols.map(s => s.symbol), ['AAPL']); assert.deepStrictEqual(cleaned.favourites, ['AAPL']); assert.strictEqual(cleaned.sort.key, 'marketCap');
    const emptyList = L.defaultWatchlist([]); L.saveWatchlist(st, emptyList); assert.strictEqual(L.loadWatchlist(st, defaults.symbols).symbols.length, 0, 'an emptied list stays empty');
  });

  await test('cache: fresh within TTL, expires after, stale entry still readable, clear and prune', () => {
    const st = memStorage(), c = clock(), cache = L.createCache(st, c.now);
    cache.set('q:AAPL', { price: 1 }, L.TTL.quote);
    assert.deepStrictEqual(cache.get('q:AAPL'), { price: 1 });
    c.advance(59e3); assert.ok(cache.get('q:AAPL'));
    c.advance(2e3); assert.strictEqual(cache.get('q:AAPL'), null, 'quote expires after 1 minute');
    const e = cache.entry('q:AAPL'); assert.strictEqual(e.fresh, false); assert.deepStrictEqual(e.value, { price: 1 });
    cache.set('m:AAPL', { pe: 30 }, L.TTL.metrics); c.advance(11.9 * 3600e3); assert.ok(cache.get('m:AAPL')); c.advance(0.2 * 3600e3); assert.strictEqual(cache.get('m:AAPL'), null, 'metrics expire after 12 h');
    assert.strictEqual(L.TTL.quote, 60e3); assert.strictEqual(L.TTL.metrics, 12 * 3600e3); assert.strictEqual(L.TTL.recommendation, 12 * 3600e3);
    assert.ok(L.TTL.i5 < L.TTL.i30 && L.TTL.i30 < L.TTL.d1y && L.TTL.d1y < L.TTL.w5y, 'candle TTLs grow with the range');
    st.setItem('unrelated', 'x'); c.advance(10 * 86400e3); assert.strictEqual(cache.prune(), 2); assert.strictEqual(st.getItem('unrelated'), 'x');
    cache.set('a', 1, 1000); cache.clear(); assert.strictEqual(cache.size(), 0); assert.strictEqual(st.getItem('unrelated'), 'x');
    st.setItem(L.CACHE_PREFIX + 'bad', 'not json'); assert.strictEqual(cache.get('bad'), null);
  });
  await test('cache: when storage is full it evicts the oldest entries instead of failing', () => {
    const st = memStorage(3000), c = clock(), cache = L.createCache(st, c.now);
    for (let i = 0; i < 40; i++) { c.advance(1000); assert.ok(cache.set('k' + i, 'x'.repeat(100), 1e9)); }
    assert.ok(cache.get('k39')); assert.strictEqual(cache.get('k0'), null);
  });

  await test('waitTime: sliding window, cost-weighted, min gap', () => {
    const cfg = { max: 3, windowMs: 60e3 };
    assert.strictEqual(L.waitTime([], 0, cfg), 0);
    const h = [{ t: 0, cost: 1 }, { t: 10e3, cost: 1 }, { t: 20e3, cost: 1 }];
    assert.strictEqual(L.waitTime(h, 30e3, cfg), 30e3, 'wait until the first call leaves the window');
    assert.strictEqual(L.waitTime(h, 61e3, cfg), 0);
    assert.strictEqual(L.waitTime([{ t: 0, cost: 2 }], 1000, cfg, 2), 59e3, 'a batch of 2 does not fit next to 2');
    assert.strictEqual(L.waitTime([{ t: 1000, cost: 1 }], 1050, { max: 50, windowMs: 60e3, minGapMs: 120 }), 70);
  });

  await test('consensus: weighted 1-5 score and label', () => {
    const c = L.consensus({ strongBuy: 13, buy: 24, hold: 7, sell: 0, strongSell: 0 });
    assert.strictEqual(c.total, 44); assert.strictEqual(c.score, 1.86); assert.strictEqual(c.label, 'Buy');
    assert.strictEqual(L.consensus({ strongBuy: 10, buy: 0, hold: 0, sell: 0, strongSell: 0 }).label, 'Strong Buy');
    assert.strictEqual(L.consensus({ strongBuy: 0, buy: 2, hold: 10, sell: 2, strongSell: 0 }).label, 'Hold');
    assert.strictEqual(L.consensus({ strongBuy: 0, buy: 0, hold: 1, sell: 6, strongSell: 1 }).label, 'Sell');
    assert.strictEqual(L.consensus({ strongBuy: 0, buy: 0, hold: 0, sell: 1, strongSell: 9 }).label, 'Strong Sell');
    assert.strictEqual(L.consensus({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }), null); assert.strictEqual(L.consensus(null), null);
    assert.strictEqual(L.consensus({ strongBuy: 1, buy: 1, hold: 0, sell: 0, strongSell: 0 }).label, 'Strong Buy', '1.5 boundary');
  });
  await test('latestRecommendation picks the newest period', () => {
    const r = L.latestRecommendation([{ period: '2026-08-01', strongBuy: 1, buy: 1, hold: 1, sell: 0, strongSell: 0 }, { period: '2026-10-01', strongBuy: 5, buy: 4, hold: 3, sell: 2, strongSell: 1 }]);
    assert.strictEqual(r.period, '2026-10-01'); assert.strictEqual(r.strongBuy, 5); assert.strictEqual(L.latestRecommendation([]), null);
  });

  await test('Finnhub parsing: quote, unknown symbol, profile, metrics keep absent vs null apart, earnings, price target', () => {
    const q = L.parseFinnhubQuote({ c: 336.67, d: 3.04, dp: 0.9112, h: 338.67, l: 332.78, o: 336.96, pc: 333.63, t: 1791403200 });
    assert.strictEqual(q.price, 336.67); assert.strictEqual(q.changePct, 0.9112); assert.strictEqual(q.t, 1791403200000);
    const q2 = L.parseFinnhubQuote({ c: 110, pc: 100, t: 1 }); assert.strictEqual(q2.change, 10); assert.strictEqual(q2.changePct, 10);
    assert.strictEqual(L.parseFinnhubQuote({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }), null);
    const p = L.parseFinnhubProfile({ ticker: 'AAPL', name: 'Apple Inc', marketCapitalization: 4913422, shareOutstanding: 14590 }); assert.strictEqual(p.sharesM, 14590);
    assert.strictEqual(L.parseFinnhubProfile({}), null);
    const m = L.parseFinnhubMetrics({ metric: { peTTM: 40.1, epsTTM: 8.4, '52WeekHigh': 340, '52WeekLow': 200, beta: 1.2, currentDividendYieldTTM: null, grossMarginTTM: 46.9, netProfitMarginTTM: 24.3, operatingMarginTTM: 31.5, '10DayAverageTradingVolume': 41.2 } });
    assert.strictEqual(m.peTTM, 40.1); assert.strictEqual(m.forwardPE, undefined); assert.strictEqual(m.dividendYield, null); assert.strictEqual(m.high52, 340); assert.strictEqual(m.avgVolume10dM, 41.2);
    assert.strictEqual(L.parseFinnhubMetrics({ metric: { peBasicExclExtraTTM: 22 } }).peTTM, 22, 'falls back to alternative key names');
    const e = L.nextEarnings({ earningsCalendar: [{ date: '2026-07-30', hour: 'amc' }, { date: '2026-10-29', hour: 'amc', epsEstimate: 1.8 }, { date: '2027-01-28' }] }, '2026-10-08');
    assert.deepStrictEqual(e, { date: '2026-10-29', hour: 'amc', epsEstimate: 1.8 }); assert.strictEqual(L.nextEarnings({ earningsCalendar: [] }, '2026-10-08'), null);
    assert.strictEqual(L.parseFinnhubPriceTarget({}), null); assert.strictEqual(L.parseFinnhubPriceTarget({ targetMean: 300, targetHigh: 400, targetLow: 200 }).high, 400);
  });
  await test('market cap: live price x shares, else profile, else metrics', () => {
    assert.strictEqual(L.marketCap({ price: 100 }, { sharesM: 10 }, null), 1e9);
    assert.strictEqual(L.marketCap(null, { marketCapM: 5 }, null), 5e6); assert.strictEqual(L.marketCap(null, null, { marketCapM: 7 }), 7e6); assert.strictEqual(L.marketCap(null, null, null), null);
  });

  await test('Twelve Data parsing: single, batch with a per-symbol error, top-level error', () => {
    const single = { meta: { symbol: 'AAPL' }, values: [{ datetime: '2026-10-07', close: '336.67', volume: '34128200' }, { datetime: '2026-10-06', close: '333.63', volume: '1' }], status: 'ok' };
    const s = L.parseTwelveSeries(single, ['AAPL']).AAPL; assert.strictEqual(s.length, 2); assert.strictEqual(s[0].d, '2026-10-06', 'oldest first'); assert.strictEqual(s[1].c, 336.67);
    const batch = { AAPL: single, ZZZZ: { code: 400, message: 'symbol not found', status: 'error' } };
    const b = L.parseTwelveSeries(batch, ['AAPL', 'ZZZZ']); assert.strictEqual(b.AAPL.length, 2); assert.ok(b.ZZZZ.error);
    const err = L.parseTwelveSeries({ code: 429, message: 'You have run out of API credits for the current minute.', status: 'error' }, ['AAPL', 'MSFT']);
    assert.strictEqual(err.AAPL.code, 429); assert.strictEqual(err.MSFT.code, 429);
  });
  await test('sliceRange: 1D = latest session, 5D = 5 sessions, 1M/6M/1Y by calendar days, 5Y all', () => {
    const intraday = [];
    for (const d of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']) for (const t of ['09:30', '12:00', '15:30']) intraday.push({ d: d + ' ' + t + ':00', c: 1 });
    const d1 = L.sliceRange(intraday, '1D'); assert.strictEqual(d1.length, 3); assert.ok(d1.every(b => b.d.startsWith('2026-10-07')));
    const d5 = L.sliceRange(intraday, '5D'); assert.strictEqual(d5.length, 15); assert.ok(d5[0].d.startsWith('2026-10-01'));
    const daily = []; const start = Date.UTC(2025, 9, 1); for (let i = 0; i <= 371; i++) { const d = new Date(start + i * 864e5); if (d.getUTCDay() % 6) daily.push({ d: d.toISOString().slice(0, 10), c: i }); }
    const m1 = L.sliceRange(daily, '1M'); assert.ok(m1[0].d >= '2026-09-06' && m1[0].d <= '2026-09-08', m1[0].d); assert.strictEqual(m1.at(-1).d, daily.at(-1).d);
    const m6 = L.sliceRange(daily, '6M'); assert.ok(m6.length > 120 && m6.length < 135, String(m6.length));
    const y1 = L.sliceRange(daily, '1Y'); assert.ok(y1.length >= 250 && y1.length <= 263, String(y1.length));
    assert.strictEqual(L.sliceRange(daily, '5Y').length, daily.length); assert.deepStrictEqual(L.sliceRange([], '1D'), []);
    assert.deepStrictEqual(L.RANGE_ORDER, ['1D', '5D', '1M', '6M', '1Y', '5Y']);
    assert.strictEqual(L.RANGES['1M'].dataset, L.RANGES['1Y'].dataset, '1M/6M/1Y share one daily request');
  });
  await test('rangeChange, sessionVolume, sparkPath', () => {
    assert.deepStrictEqual(L.rangeChange([{ c: 100 }, { c: 110 }]), { change: 10, changePct: 10 }); assert.strictEqual(L.rangeChange([{ c: 1 }]), null);
    assert.deepStrictEqual(L.sessionVolume([{ d: '2026-10-07', c: 1, v: 500 }], null), { value: 500, date: '2026-10-07' });
    assert.deepStrictEqual(L.sessionVolume(null, [{ d: '2026-10-06 15:55:00', v: 9 }, { d: '2026-10-07 09:30:00', v: 2 }, { d: '2026-10-07 09:35:00', v: 3 }]), { value: 5, date: '2026-10-07' });
    assert.strictEqual(L.sessionVolume(null, null), null);
    assert.strictEqual(L.sparkPath([1, 2, 3], 72, 28), 'M0.0,26.0L36.0,14.0L72.0,2.0'); assert.strictEqual(L.sparkPath([5], 72, 28), ''); assert.strictEqual(L.sparkPath([4, 4], 10, 10), 'M0.0,8.0L10.0,8.0');
  });
  await test('classifyError: rate limits, bad key, premium, not found, network', () => {
    assert.strictEqual(L.classifyError('finnhub', 429, { error: 'API limit reached. Please try again later. Remaining Limit: 0' }).type, 'rate-limit');
    const td = L.classifyError('twelvedata', 200, { code: 429, message: 'You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8.', status: 'error' });
    assert.strictEqual(td.type, 'rate-limit'); assert.strictEqual(td.daily, false); assert.ok(/8 credits\/min/.test(td.message));
    assert.strictEqual(L.classifyError('twelvedata', 200, { code: 429, message: 'You have run out of API credits for the day.' }).daily, true);
    assert.strictEqual(L.classifyError('finnhub', 401, { error: 'Invalid API key.' }).type, 'auth');
    assert.strictEqual(L.classifyError('finnhub', 403, { error: "You don't have access to this resource." }).type, 'premium');
    assert.strictEqual(L.classifyError('finnhub', 403, { error: "You don't have access to this resource." }).message, 'n/a (not on free tier)');
    assert.strictEqual(L.classifyError('twelvedata', 200, { code: 400, message: '**symbol** not found: ZZZZ' }).type, 'not-found');
    assert.strictEqual(L.classifyError('finnhub', 0, null).type, 'network');
  });
  /* ---------- turn 2: ASX ids, portfolio, alerts, overview, earnings, news, Marketstack, FX ---------- */
  await test('ASX codes and ids', () => {
    assert.strictEqual(L.normalizeAsx(' bhp '), 'BHP'); assert.strictEqual(L.normalizeAsx('fang.ax'), 'FANG'); assert.strictEqual(L.normalizeAsx('ASX:IVV'), 'IVV');
    assert.strictEqual(L.normalizeAsx('A'), null); assert.strictEqual(L.normalizeAsx('BRK.B'), null); assert.strictEqual(L.normalizeAsx('TOOLONG7'), null);
    assert.strictEqual(L.makeId('BHP', 'ASX'), 'ASX:BHP'); assert.strictEqual(L.makeId('AAPL', 'US'), 'AAPL');
    assert.deepStrictEqual(L.parseId('ASX:BHP'), { symbol: 'BHP', exchange: 'ASX' }); assert.deepStrictEqual(L.parseId('BRK.B'), { symbol: 'BRK.B', exchange: 'US' });
    const w = L.defaultWatchlist([]); assert.strictEqual(L.addSymbol(w, 'wtc', '', 'ASX'), true); assert.strictEqual(w.symbols[0].symbol, 'WTC');
    assert.throws(() => L.addSymbol(w, 'BRK.B', '', 'ASX'), /ASX code/);
    const st = memStorage(); L.saveWatchlist(st, { symbols: [{ symbol: 'bhp' }, { symbol: 'x' }], favourites: ['BHP'] }, L.KEYS.watchlistAsx);
    const back = L.loadWatchlist(st, [], L.KEYS.watchlistAsx, L.normalizeAsx); assert.deepStrictEqual(back.symbols.map(s => s.symbol), ['BHP']); assert.deepStrictEqual(back.favourites, ['BHP']);
    assert.strictEqual(L.fmtPrice(12.5, 'AUD'), 'A$12.50'); assert.strictEqual(L.fmtPrice(-3, 'USD'), '−$3.00'); assert.strictEqual(L.fmtSignedMoney(1234.5, 'AUD'), '+A$1,234.50'); assert.strictEqual(L.fmtSignedMoney(-2, 'USD'), '−$2.00');
  });
  await test('portfolio seed is tickers only: FANG, SEMI, IVV on ASX with units 0 and blank cost', () => {
    const pf = L.defaultPortfolio();
    assert.deepStrictEqual(pf.holdings.map(h => h.id), ['ASX:FANG', 'ASX:SEMI', 'ASX:IVV']);
    for (const h of pf.holdings) { assert.strictEqual(h.units, 0); assert.strictEqual(h.avgCost, null); assert.strictEqual(h.buyDate, ''); }
    assert.deepStrictEqual(L.SEED_PORTFOLIO.map(h => Object.keys(h).sort()), [['exchange', 'symbol'], ['exchange', 'symbol'], ['exchange', 'symbol']], 'seed carries no amounts');
    const st = memStorage(); assert.deepStrictEqual(L.loadPortfolio(st), pf, 'empty storage -> seed');
    const sum = L.portfolioSummary(pf.holdings, () => ({ price: 10, change: 1, changePct: 10 }), null);
    assert.deepStrictEqual(sum.needsInput, ['FANG', 'SEMI', 'IVV']); assert.strictEqual(sum.total.value, 0); assert.strictEqual(sum.total.cost, null);
  });
  await test('portfolio add/update/remove validation and storage round-trip', () => {
    const pf = L.defaultPortfolio(), st = memStorage();
    L.updateHolding(pf, 'ASX:FANG', { units: '10', avgCost: '20', buyDate: '2026-01-02' }, '2026-10-08');
    assert.deepStrictEqual(pf.holdings[0], { id: 'ASX:FANG', symbol: 'FANG', exchange: 'ASX', units: 10, avgCost: 20, buyDate: '2026-01-02' });
    assert.throws(() => L.updateHolding(pf, 'ASX:FANG', { units: -1 }), /Units/); assert.throws(() => L.updateHolding(pf, 'ASX:FANG', { avgCost: 0 }), /cost/);
    assert.throws(() => L.updateHolding(pf, 'ASX:FANG', { buyDate: '2099-01-01' }, '2026-10-08'), /past date/);
    L.updateHolding(pf, 'ASX:FANG', { avgCost: '' }); assert.strictEqual(pf.holdings[0].avgCost, null, 'blank cost allowed');
    L.addHolding(pf, { symbol: 'aapl', exchange: 'US', units: 2, avgCost: 150 });
    assert.throws(() => L.addHolding(pf, { symbol: 'AAPL', exchange: 'US' }), /already/); assert.throws(() => L.addHolding(pf, { symbol: '??', exchange: 'US' }), /Invalid/);
    L.savePortfolio(st, pf); assert.deepStrictEqual(L.loadPortfolio(st), pf);
    assert.strictEqual(L.removeHolding(pf, 'AAPL'), true); assert.strictEqual(L.removeHolding(pf, 'AAPL'), false);
    st.setItem(L.KEYS.portfolio, JSON.stringify({ holdings: [{ symbol: 'BHP', exchange: 'ASX', units: 'x' }, { symbol: 'CBA', exchange: 'ASX', units: 1, avgCost: null }] }));
    assert.deepStrictEqual(L.loadPortfolio(st).holdings.map(h => h.id), ['ASX:CBA'], 'invalid rows dropped');
  });
  await test('portfolioSummary: AUD values, USD converted at the FX rate, gains, day change, weights', () => {
    const holdings = [
      { id: 'ASX:FANG', symbol: 'FANG', exchange: 'ASX', units: 10, avgCost: 20, buyDate: '' },
      { id: 'AAPL', symbol: 'AAPL', exchange: 'US', units: 2, avgCost: 100, buyDate: '' },
      { id: 'ASX:SEMI', symbol: 'SEMI', exchange: 'ASX', units: 0, avgCost: null, buyDate: '' }
    ];
    const q = { 'ASX:FANG': { price: 30, change: 1, changePct: 3.45 }, AAPL: { price: 150, change: -5, changePct: -3.2 }, 'ASX:SEMI': { price: 9, change: 0, changePct: 0 } };
    const s = L.portfolioSummary(holdings, id => q[id], { rate: 1.5 });
    const [fang, aapl, semi] = s.rows;
    assert.strictEqual(fang.value, 300); assert.strictEqual(fang.cost, 200); assert.strictEqual(fang.gain, 100); assert.strictEqual(fang.gainPct, 50); assert.strictEqual(fang.dayChange, 10);
    assert.strictEqual(aapl.value, 450); assert.strictEqual(aapl.cost, 300); assert.strictEqual(aapl.gain, 150); assert.strictEqual(aapl.dayChange, -15); assert.strictEqual(aapl.currency, 'USD');
    assert.strictEqual(semi.value, 0); assert.strictEqual(semi.needsInput, true);
    assert.strictEqual(s.total.value, 750); assert.strictEqual(s.total.cost, 500); assert.strictEqual(s.total.gain, 250); assert.strictEqual(s.total.gainPct, 50);
    assert.strictEqual(s.total.dayChange, -5); assert.ok(Math.abs(s.total.dayPct - (-5 / 755 * 100)) < 1e-9);
    assert.strictEqual(fang.weight, 40); assert.strictEqual(aapl.weight, 60); assert.strictEqual(semi.weight, 0);
    const noFx = L.portfolioSummary(holdings, id => q[id], null);
    assert.strictEqual(noFx.fxMissing, true); assert.strictEqual(noFx.rows[1].value, null); assert.deepStrictEqual(noFx.missing, ['AAPL']); assert.strictEqual(noFx.total.value, 300, 'partial total, never guessed');
    const noPrice = L.portfolioSummary(holdings, id => (id === 'AAPL' ? q[id] : null), { rate: 1.5 });
    assert.deepStrictEqual(noPrice.missing, ['FANG']); assert.strictEqual(noPrice.rows[0].weight, null); assert.strictEqual(noPrice.rows[1].weight, 100);
  });
  await test('alerts: above/below fire once and re-arm, daily move once per day, history capped', () => {
    const st = L.emptyAlerts();
    const up = L.addAlertRule(st, { sym: 'AAPL', type: 'above', value: '200' }), dn = L.addAlertRule(st, { sym: 'ASX:BHP', type: 'below', value: 40 }), mv = L.addAlertRule(st, { sym: 'MSFT', type: 'movePct', value: 3 });
    assert.throws(() => L.addAlertRule(st, { sym: 'AAPL', type: 'above', value: 0 }), /more than 0/); assert.throws(() => L.addAlertRule(st, { sym: 'AAPL', type: 'nope', value: 1 }), /type/);
    assert.throws(() => L.addAlertRule(st, { sym: 'MSFT', type: 'movePct', value: 101 }), /between/);
    let f = L.evaluateAlerts(st, { AAPL: { price: 199 }, 'ASX:BHP': { price: 41 }, MSFT: { price: 1, changePct: 1, t: Date.UTC(2026, 9, 7) } }, 1000);
    assert.strictEqual(f.length, 0);
    f = L.evaluateAlerts(st, { AAPL: { price: 201 }, 'ASX:BHP': { price: 39.5, eod: true }, MSFT: { price: 1, changePct: -3.4, t: Date.UTC(2026, 9, 7, 15) } }, 2000);
    assert.deepStrictEqual(f.map(e => e.ruleId).sort(), [up.id, dn.id, mv.id].sort());
    assert.ok(/AAPL is above \$200\.00 \(now \$201\.00\)/.test(L.alertMessage(f.find(e => e.ruleId === up.id))));
    assert.ok(/BHP is below A\$40\.00.*end-of-day/.test(L.alertMessage(f.find(e => e.ruleId === dn.id))));
    assert.ok(/MSFT moved −3\.40% today/.test(L.alertMessage(f.find(e => e.ruleId === mv.id))));
    f = L.evaluateAlerts(st, { AAPL: { price: 205 }, 'ASX:BHP': { price: 39 }, MSFT: { price: 1, changePct: -5, t: Date.UTC(2026, 9, 7, 16) } }, 3000);
    assert.strictEqual(f.length, 0, 'no repeats while still past the level / same day');
    L.evaluateAlerts(st, { AAPL: { price: 190 } }, 4000); f = L.evaluateAlerts(st, { AAPL: { price: 210 } }, 5000);
    assert.strictEqual(f.length, 1, 're-armed after moving back');
    f = L.evaluateAlerts(st, { MSFT: { price: 1, changePct: 4, t: Date.UTC(2026, 9, 9, 15) } }, 6000); assert.strictEqual(f.length, 1, 'next day fires again');
    assert.strictEqual(L.unseenAlerts(st), 5); st.history.forEach(h => { h.seen = true; }); assert.strictEqual(L.unseenAlerts(st), 0);
    st.rules[0].enabled = false; assert.strictEqual(L.evaluateAlerts(st, { AAPL: { price: 1 } }, 7000).length, 0, 'disabled rule ignored');
    assert.strictEqual(L.evaluateAlerts(st, { AAPL: { price: null } }, 8000).length, 0, 'no price, no alert');
    const demo = L.evaluateAlerts(L.loadAlerts(memStorage()), {}, 1); assert.deepStrictEqual(demo, []);
    const s2 = L.emptyAlerts(); L.addAlertRule(s2, { sym: 'X', type: 'below', value: 5 });
    for (let i = 0; i < 260; i++) { L.evaluateAlerts(s2, { X: { price: 4 } }, i * 2); L.evaluateAlerts(s2, { X: { price: 6 } }, i * 2 + 1); }
    assert.strictEqual(s2.history.length, 200, 'history capped at 200');
    const ms = memStorage(); L.saveAlerts(ms, st); assert.deepStrictEqual(L.loadAlerts(ms).rules.length, 3); assert.strictEqual(L.removeAlertRule(st, mv.id), true);
    assert.ok(/^DEMO: /.test(L.alertMessage({ sym: 'AAPL', type: 'above', value: 1, price: 2, demo: true })));
  });
  await test('topMovers: five each way, ignores missing changes', () => {
    const rows = [3, -1, 7, null, -8, 2, 0, 5, -4, 9, -2, -6, 1].map((c, i) => ({ symbol: 'S' + i, changePct: c }));
    const m = L.topMovers(rows, 5);
    assert.deepStrictEqual(m.gainers.map(r => r.changePct), [9, 7, 5, 3, 2]); assert.deepStrictEqual(m.losers.map(r => r.changePct), [-8, -6, -4, -2, -1]);
    assert.deepStrictEqual(L.topMovers([{ changePct: null }]), { gainers: [], losers: [] });
  });
  await test('earnings calendar: parse, filter to my tickers and 14 days, dedupe, order, group', () => {
    const list = L.parseEarningsCalendar(mocks.calendar('2026-10-07'));
    const up = L.upcomingEarnings(list, new Set(['AAPL', 'MSFT', 'NVDA']), '2026-10-07', '2026-10-21');
    assert.deepStrictEqual(up.map(e => e.symbol + ' ' + e.date), ['AAPL 2026-10-09', 'MSFT 2026-10-12']);
    assert.strictEqual(up[0].epsEstimate, 1.85); assert.strictEqual(up[1].epsEstimate, null);
    assert.strictEqual(L.HOUR_LABEL.bmo, 'Before market open'); assert.strictEqual(L.HOUR_LABEL.amc, 'After market close');
    const g = L.groupByDate([{ date: 'a' }, { date: 'a' }, { date: 'b' }]); assert.deepStrictEqual(g.map(x => [x.date, x.items.length]), [['a', 2], ['b', 1]]);
    const same = L.upcomingEarnings([{ symbol: 'B', date: 'd', hour: 'amc' }, { symbol: 'A', date: 'd', hour: 'amc' }, { symbol: 'C', date: 'd', hour: 'bmo' }], ['A', 'B', 'C'], 'a', 'z');
    assert.deepStrictEqual(same.map(e => e.symbol), ['C', 'A', 'B'], 'before-open first, then by ticker');
    assert.strictEqual(L.usDate(Date.UTC(2026, 9, 8, 2)), '2026-10-07', 'New York date'); assert.strictEqual(L.usDate(Date.UTC(2026, 9, 8, 2), 14), '2026-10-21');
  });
  await test('news: newest first, deduped, unsafe links dropped, capped', () => {
    const n = L.parseNews(mocks.news('AAPL', Date.UTC(2026, 9, 7, 15)));
    assert.deepStrictEqual(n.map(x => x.headline), ['AAPL mock headline one', 'AAPL mock headline two']);
    assert.strictEqual(n[0].url, 'https://example.com/news/1'); assert.strictEqual(n[0].t, Date.UTC(2026, 9, 7, 14));
    assert.deepStrictEqual(L.parseNews(null), []); assert.strictEqual(L.parseNews(Array.from({ length: 40 }, (_, i) => ({ headline: 'h' + i, url: 'https://e.com/' + i, datetime: i }))).length, 15);
    assert.strictEqual(L.safeUrl('javascript:alert(1)'), null); assert.strictEqual(L.safeUrl('https://a.b/"x'), null);
    assert.strictEqual(L.fmtAgo(1000, 1000 + 5 * 60e3), '5 min ago'); assert.strictEqual(L.fmtAgo(0, 3 * 3600e3), '3 h ago'); assert.strictEqual(L.fmtAgo(0, 2 * 864e5), '2 d ago');
  });
  await test('Marketstack EOD parse + end-of-day quote; FX parsers', () => {
    const j = { data: [{ symbol: 'BHP.AX', date: '2026-10-07T00:00:00+0000', close: 41, volume: 10 }, { symbol: 'BHP.AX', date: '2026-10-06T00:00:00+0000', close: 40, volume: 9 },
      { symbol: 'CBA.AX', date: '2026-10-07T00:00:00+0000', close: '170.5' }, { symbol: 'BHP.AX', date: '2026-10-07T00:00:00+0000', close: 41 }, { symbol: 'X.AX', close: null }] };
    const p = L.parseMarketstackEod(j);
    assert.deepStrictEqual(Object.keys(p).sort(), ['BHP', 'CBA']); assert.deepStrictEqual(p.BHP.map(b => b.d), ['2026-10-06', '2026-10-07'], 'oldest first, deduped');
    const q = L.eodQuote(p.BHP); assert.strictEqual(q.price, 41); assert.strictEqual(q.change, 1); assert.strictEqual(q.changePct, 2.5); assert.strictEqual(q.date, '2026-10-07'); assert.strictEqual(q.eod, true);
    const one = L.eodQuote(p.CBA); assert.strictEqual(one.price, 170.5); assert.strictEqual(one.change, null, 'no previous close -> no change, not zero');
    assert.strictEqual(L.eodQuote([]), null);
    assert.deepStrictEqual(L.parseTwelveRate({ symbol: 'USD/AUD', rate: 1.5, timestamp: 100 }), { rate: 1.5, t: 100000 }); assert.strictEqual(L.parseTwelveRate({ status: 'error' }), null);
    assert.deepStrictEqual(L.parseFrankfurter({ date: '2026-10-07', rates: { AUD: 1.4386 } }), { rate: 1.4386, date: '2026-10-07' }); assert.strictEqual(L.parseFrankfurter({}), null);
    assert.strictEqual(L.monthKey(Date.UTC(2026, 9, 31, 23)), '2026-10');
    const H = 36e5; // ASX closes stay cached until 6 pm Sydney on the next trading day
    assert.strictEqual(L.asxTtl(Date.UTC(2026, 9, 7, 15)) / H, 16, 'Thu 2 am -> Thu 6 pm'); assert.strictEqual(L.asxTtl(Date.UTC(2026, 9, 8, 7, 30)) / H, 23.5, 'Thu 6:30 pm -> Fri 6 pm');
    assert.strictEqual(L.asxTtl(Date.UTC(2026, 9, 9, 8)) / H, 71, 'Fri 7 pm -> Mon 6 pm (weekend skipped)');
  });
  await test('classifyError: Marketstack codes', () => {
    assert.strictEqual(L.classifyError('marketstack', 429, { error: { code: 104, type: 'usage_limit_reached', info: 'Your monthly usage limit has been reached.' } }).monthly, true);
    assert.strictEqual(L.classifyError('marketstack', 429, { error: { code: 'rate_limit_reached', message: 'slow down' } }).type, 'rate-limit');
    assert.strictEqual(L.classifyError('marketstack', 401, { error: { code: 'missing_access_key', message: 'You have not supplied an API Access Key.' } }).type, 'auth');
    assert.strictEqual(L.classifyError('marketstack', 401, { error: { code: 101, type: 'invalid_access_key', info: 'bad' } }).type, 'auth');
    assert.strictEqual(L.classifyError('marketstack', 403, { error: { code: 105, type: 'function_access_restricted', info: 'Access Restricted' } }).type, 'premium');
    assert.strictEqual(L.classifyError('marketstack', 422, { error: { code: 'no_valid_symbols_provided', message: 'x' } }).type, 'not-found');
  });
  await test('Google Sheet link: published and shared links become CSV URLs; anything else is rejected', () => {
    const pub = L.normalizeSheetUrl('https://docs.google.com/spreadsheets/d/e/2PACX-FAKE_PUBLISHED_SHEET_ID_FOR_TESTS/pubhtml?gid=42&single=true');
    assert.deepStrictEqual(pub, { url: 'https://docs.google.com/spreadsheets/d/e/2PACX-FAKE_PUBLISHED_SHEET_ID_FOR_TESTS/pub?gid=42&single=true&output=csv', kind: 'published' });
    assert.strictEqual(L.normalizeSheetUrl(' https://docs.google.com/spreadsheets/d/e/2PACX-FAKE_PUBLISHED_SHEET_ID_FOR_TESTS/pub?output=csv ').url, 'https://docs.google.com/spreadsheets/d/e/2PACX-FAKE_PUBLISHED_SHEET_ID_FOR_TESTS/pub?output=csv');
    assert.deepStrictEqual(L.normalizeSheetUrl('https://docs.google.com/spreadsheets/d/FAKE_SHARED_SHEET_ID_FOR_TESTS_0001/edit?usp=sharing#gid=7'),
      { url: 'https://docs.google.com/spreadsheets/d/FAKE_SHARED_SHEET_ID_FOR_TESTS_0001/gviz/tq?tqx=out:csv&headers=1&gid=7', kind: 'shared' });
    assert.strictEqual(L.normalizeSheetUrl(''), null);
    for (const bad of ['not a link', 'http://docs.google.com/spreadsheets/d/FAKE_SHARED_SHEET_ID_FOR_TESTS_0001/edit', 'https://evil.example/spreadsheets/d/FAKE_SHARED_SHEET_ID_FOR_TESTS_0001/', 'https://docs.google.com/document/d/FAKE_SHARED_SHEET_ID_FOR_TESTS_0001/edit', 'https://docs.google.com/spreadsheets/d/short/edit'])
      assert.throws(() => L.normalizeSheetUrl(bad), Error, bad);
  });
  await test('CSV parser: quotes, escaped quotes, commas inside quotes, CRLF, BOM, blank lines', () => {
    assert.deepStrictEqual(L.parseCsv('\uFEFFa,"b,c","say ""hi"""\r\n\r\n1,2,3\n'), [['a', 'b,c', 'say "hi"'], ['1', '2', '3']]);
    assert.deepStrictEqual(L.parseCsv('x'), [['x']]); assert.deepStrictEqual(L.parseCsv(''), []);
  });
  await test('sheet numbers: A$, $, thousands separators; #N/A and Loading… are blank', () => {
    assert.strictEqual(L.sheetNum('A$38.61'), 38.61); assert.strictEqual(L.sheetNum('$1,074.50'), 1074.5); assert.strictEqual(L.sheetNum(' 12 '), 12); assert.strictEqual(L.sheetNum('-0.5'), -0.5);
    for (const v of ['#N/A', 'Loading...', '', null, 'abc', '1.2.3']) assert.strictEqual(L.sheetNum(v), null, String(v));
  });
  await test('parseSheetQuotes: header-driven columns, change vs previous close, Sydney trade time, skips blanks', () => {
    const r = L.parseSheetQuotes(mocks.sheetCsv(['FANG', 'SEMI', 'IVV'], ['SEMI']));
    assert.deepStrictEqual(Object.keys(r.quotes), ['FANG', 'IVV']); assert.deepStrictEqual(r.skipped, ['SEMI']);
    const q = r.quotes.FANG, p = mocks.sheetPrice('FANG');
    assert.strictEqual(q.price, p.price); assert.strictEqual(q.prevClose, p.prev); assert.ok(Math.abs(q.change - (p.price - p.prev)) < 1e-9);
    assert.strictEqual(q.date, '2026-10-08'); assert.strictEqual(q.timeText, '2026-10-08 15:20'); assert.strictEqual(q.t, Date.UTC(2026, 9, 8, 4, 20)); assert.ok(q.sheet && !q.eod);
    const cols = L.parseSheetQuotes('Ticker,Last,Prev,As of\nASX:BHP,45.10,44.00,2026-07-08 10:05\nbad row!,1,1,');
    assert.strictEqual(cols.quotes.BHP.price, 45.1); assert.strictEqual(cols.quotes.BHP.t, Date.UTC(2026, 6, 8, 0, 5), 'winter: AEST is UTC+10');
    const noHeader = L.parseSheetQuotes('FANG,38.5,38\nSEMI,40,');
    assert.strictEqual(noHeader.quotes.FANG.price, 38.5); assert.strictEqual(noHeader.quotes.SEMI.change, null, 'no previous close -> no change');
    assert.throws(() => L.parseSheetQuotes(''), /empty/); assert.throws(() => L.parseSheetQuotes('Symbol,Foo\nFANG,1'), /Price column/);
  });
  await test('sheetFormula: one A1 formula, header row + one row per unique valid ticker, GOOGLEFINANCE on ASX', () => {
    const f = L.sheetFormula(['FANG', 'fang', 'SEMI', 'IVV', 'bad code!']);
    assert.ok(f.startsWith('={"Symbol","Price","PrevClose","TradeTime";"FANG",IFERROR(GOOGLEFINANCE("ASX:FANG","price"),"")'));
    assert.strictEqual((f.match(/GOOGLEFINANCE\("ASX:FANG"/g) || []).length, 3); assert.ok(f.includes('GOOGLEFINANCE("ASX:IVV","closeyest")') && f.includes('"yyyy-mm-dd hh:mm"'));
    assert.strictEqual(f.split(';').length, 4, 'header + 3 tickers'); assert.ok(f.endsWith('}'));
    const r = L.parseSheetQuotes('Symbol,Price,PrevClose,TradeTime\nFANG,38,37,'); assert.strictEqual(r.rows, 1, 'the formula\u2019s own header is what the parser expects');
  });
  await test('backup: has watchlists, favourites, portfolio, alerts, settings; API keys only when asked', () => {
    const st = memStorage();
    const us = L.defaultWatchlist(defaults.symbols.slice(0, 5)); L.toggleFavourite(us, 'NVDA'); L.saveWatchlist(st, us);
    const asx = L.defaultWatchlist([{ symbol: 'FANG' }, { symbol: 'SEMI' }, { symbol: 'IVV' }]); L.toggleFavourite(asx, 'FANG'); L.saveWatchlist(st, asx, L.KEYS.watchlistAsx);
    const pf = L.defaultPortfolio(); L.updateHolding(pf, 'ASX:FANG', { units: 10, avgCost: 20 }); L.savePortfolio(st, pf);
    const al = L.emptyAlerts(); L.addAlertRule(al, { sym: 'ASX:IVV', type: 'below', value: 50 }); L.saveAlerts(st, al);
    st.setItem(L.KEYS.settings, JSON.stringify({ refreshSec: 300, market: 'ASX', asxSheetUrl: 'https://docs.google.com/spreadsheets/d/FAKE_SHARED_SHEET_ID_FOR_TESTS_0001/edit', junk: '<script>' }));
    st.setItem(L.KEYS.apiKeys, JSON.stringify({ finnhub: 'FAKE_FINNHUB_KEY_FOR_TESTS', twelvedata: '', marketstack: 'FAKE_MARKETSTACK_KEY_FOR_TESTS' }));
    st.setItem(L.CACHE_PREFIX + 'q:AAPL', JSON.stringify({ v: { price: 1 }, t: 0, ttl: 1 }));
    const b = L.buildBackup(st, { now: Date.UTC(2026, 9, 8) });
    assert.strictEqual(b.app, 'stock-watchlist'); assert.strictEqual(b.kind, 'backup'); assert.strictEqual(b.version, 1); assert.strictEqual(b.createdAt, '2026-10-08T00:00:00.000Z');
    const txt = JSON.stringify(b);
    assert.ok(!txt.includes('FAKE_FINNHUB') && !txt.includes('FAKE_MARKETSTACK') && !('keys' in b.data) && b.includesKeys === false, 'no keys by default');
    assert.ok(!txt.includes('q:AAPL') && !txt.includes('junk'), 'no cached prices, unknown settings dropped');
    assert.deepStrictEqual(b.data.watchlists.ASX.favourites, ['FANG']); assert.strictEqual(b.data.portfolio.holdings.find(h => h.symbol === 'FANG').units, 10);
    assert.strictEqual(b.data.settings.asxSheetUrl.includes('FAKE_SHARED'), true);
    const withKeys = L.buildBackup(st, { includeKeys: true });
    assert.ok(withKeys.includesKeys && withKeys.data.keys.finnhub === 'FAKE_FINNHUB_KEY_FOR_TESTS');
    assert.ok(/^stock-watchlist-backup-\d{4}-\d{2}-\d{2}\.json$/.test(L.backupFileName()));
    // an untouched default list isn't in storage yet: the in-memory one is backed up instead
    const st2 = memStorage(); L.saveWatchlist(st2, asx, L.KEYS.watchlistAsx);
    assert.strictEqual(L.buildBackup(st2).data.watchlists.US, null);
    const memUs = L.defaultWatchlist([{ symbol: 'AAPL' }, { symbol: 'MSFT' }]);
    const withMem = L.buildBackup(st2, { current: { US: memUs, ASX: L.defaultWatchlist([{ symbol: 'BHP' }]), portfolio: pf } });
    assert.deepStrictEqual(withMem.data.watchlists.US.symbols.map(x => x.symbol), ['AAPL', 'MSFT']);
    assert.strictEqual(withMem.data.portfolio.holdings.find(h => h.symbol === 'FANG').units, 10);
    assert.deepStrictEqual(withMem.data.watchlists.ASX.favourites, ['FANG'], 'what is saved wins over memory');
    assert.strictEqual(L.currentSummary(st2).us, 0); assert.strictEqual(L.currentSummary(st2, { US: memUs }).us, 2, 'preview counts the list on screen when it is not saved yet');
  });
  await test('restore: validates, previews counts, replaces data; keys kept unless the file has them', () => {
    const st = memStorage();
    L.saveWatchlist(st, L.defaultWatchlist(defaults.symbols.slice(0, 3)));
    st.setItem(L.KEYS.apiKeys, JSON.stringify({ finnhub: 'FAKE_FINNHUB_KEY_FOR_TESTS', twelvedata: '', marketstack: '' }));
    const src = memStorage();
    const us = L.defaultWatchlist(defaults.symbols.slice(0, 8)); L.toggleFavourite(us, us.symbols[0].symbol); L.saveWatchlist(src, us);
    L.saveWatchlist(src, L.defaultWatchlist([{ symbol: 'FANG' }, { symbol: 'BHP' }]), L.KEYS.watchlistAsx);
    const pf = L.defaultPortfolio(); L.updateHolding(pf, 'ASX:SEMI', { units: 5, avgCost: 11 }); L.savePortfolio(src, pf);
    src.setItem(L.KEYS.settings, JSON.stringify({ refreshSec: 60 }));
    const p = L.parseBackup(JSON.stringify(L.buildBackup(src)));
    assert.deepStrictEqual([p.summary.us, p.summary.asx, p.summary.favourites, p.summary.holdings, p.summary.holdingsWithUnits, p.summary.keys], [8, 2, 1, 3, 1, 0]);
    assert.strictEqual(L.currentSummary(st).us, 3);
    L.applyBackup(st, p);
    assert.strictEqual(L.loadWatchlist(st, [], L.KEYS.watchlist).symbols.length, 8); assert.strictEqual(L.loadPortfolio(st).holdings.find(h => h.symbol === 'SEMI').units, 5);
    assert.strictEqual(JSON.parse(st.getItem(L.KEYS.settings)).refreshSec, 60);
    assert.strictEqual(JSON.parse(st.getItem(L.KEYS.apiKeys)).finnhub, 'FAKE_FINNHUB_KEY_FOR_TESTS', 'keys untouched by a key-less backup');
    src.setItem(L.KEYS.apiKeys, JSON.stringify({ finnhub: 'FAKE_OTHER_KEY_FOR_TESTS' }));
    L.applyBackup(st, L.parseBackup(JSON.stringify(L.buildBackup(src, { includeKeys: true }))));
    assert.strictEqual(JSON.parse(st.getItem(L.KEYS.apiKeys)).finnhub, 'FAKE_OTHER_KEY_FOR_TESTS', 'keys restored when included');
  });
  await test('restore rejects bad files with a plain reason, and cleans what it accepts', () => {
    const good = L.buildBackup(memStorage());
    const bad = [['not json', /valid JSON/], ['[]', /isn\u2019t a Stock Watchlist backup/], [JSON.stringify({ app: 'gym-tracker', data: {} }), /Gym Tracker backup/],
      [JSON.stringify({ ...good, version: 99 }), /newer version/], [JSON.stringify({ ...good, version: 'x' }), /version/], [JSON.stringify({ ...good, data: {} }), /missing its watchlists/],
      [JSON.stringify({ ...good, data: { watchlists: { US: null, ASX: null } } }), /no watchlist data/],
      [JSON.stringify({ ...good, data: { watchlists: { US: { symbols: [] } }, portfolio: { holdings: 'x' } } }), /portfolio is damaged/],
      [JSON.stringify({ ...good, data: { watchlists: { US: { symbols: [] } }, alerts: { rules: 5 } } }), /alerts are damaged/]];
    for (const [t, re] of bad) assert.throws(() => L.parseBackup(t), re, t.slice(0, 40));
    const dirty = { app: 'stock-watchlist', kind: 'backup', version: 1, createdAt: 'nope', includesKeys: false,
      data: { watchlists: { US: { symbols: [{ symbol: 'aapl', name: 'Apple' }, { symbol: '<img>' }, { symbol: 'AAPL' }], favourites: ['AAPL', 'ZZZ'] } },
        portfolio: { holdings: [{ symbol: 'FANG', exchange: 'ASX', units: -5 }, { symbol: 'IVV', exchange: 'ASX', units: 3, avgCost: 60 }] }, settings: { refreshSec: 7, asxSheetUrl: 'https://evil.example/x' },
        keys: { finnhub: 'FAKE_SNEAKY_KEY_FOR_TESTS' } } };
    const p = L.parseBackup(JSON.stringify(dirty));
    assert.deepStrictEqual(p.data.watchlists.US.symbols, [{ symbol: 'AAPL', name: 'Apple' }]); assert.deepStrictEqual(p.data.watchlists.US.favourites, ['AAPL']);
    assert.deepStrictEqual(p.data.portfolio.holdings.map(h => h.symbol), ['IVV'], 'invalid holding dropped'); assert.deepStrictEqual(p.data.settings, {}, 'bad settings dropped');
    assert.strictEqual(p.data.watchlists.ASX, null, 'missing ASX list is left alone on restore'); assert.strictEqual(p.createdAt, null);
    assert.ok(!p.includesKeys && !p.data.keys, 'keys ignored when the file says it has none');
  });
  await test('backup reminder: due 14 days after the last backup (or first use), snooze works', () => {
    const st = memStorage(), t0 = Date.UTC(2026, 9, 1);
    const m = L.loadBackupMeta(st, t0); assert.strictEqual(m.firstSeenAt, t0); assert.strictEqual(L.loadBackupMeta(st, t0 + L.DAY).firstSeenAt, t0, 'first use is remembered');
    assert.deepStrictEqual(L.backupReminder(m, t0 + 13 * L.DAY), { due: false, daysSince: 13, never: true });
    assert.strictEqual(L.backupReminder(m, t0 + 14 * L.DAY).due, true);
    m.lastAt = t0 + 10 * L.DAY; assert.strictEqual(L.backupReminder(m, t0 + 20 * L.DAY).due, false); assert.strictEqual(L.backupReminder(m, t0 + 24 * L.DAY).due, true);
    m.snoozeUntil = t0 + 26 * L.DAY; assert.strictEqual(L.backupReminder(m, t0 + 25 * L.DAY).due, false); assert.strictEqual(L.backupReminder(m, t0 + 26 * L.DAY).due, true);
  });
  await test('restore merge: keeps this device\'s data, adds what is only in the backup, fills placeholders and gaps', () => {
    const st = memStorage(), src = memStorage();
    const us = L.defaultWatchlist([{ symbol: 'AAPL' }, { symbol: 'MSFT' }]); L.toggleFavourite(us, 'AAPL'); L.saveWatchlist(st, us);
    const pf = L.defaultPortfolio(); L.updateHolding(pf, 'ASX:IVV', { units: 4, avgCost: 60 }); L.savePortfolio(st, pf); // FANG, SEMI still 0-unit placeholders
    const al = L.emptyAlerts(); L.addAlertRule(al, { sym: 'ASX:IVV', type: 'below', value: 50 }); L.saveAlerts(st, al);
    st.setItem(L.KEYS.apiKeys, JSON.stringify({ finnhub: 'FAKE_FINNHUB_KEY_FOR_TESTS', twelvedata: '', marketstack: '' }));
    const bus = L.defaultWatchlist([{ symbol: 'MSFT' }, { symbol: 'NVDA' }]); L.toggleFavourite(bus, 'NVDA'); L.saveWatchlist(src, bus);
    const bpf = L.defaultPortfolio(); L.updateHolding(bpf, 'ASX:IVV', { units: 99, avgCost: 1 }); L.updateHolding(bpf, 'ASX:FANG', { units: 7, avgCost: 20 }); L.addHolding(bpf, { symbol: 'BHP', exchange: 'ASX', units: 2 }); L.savePortfolio(src, bpf);
    const bal = L.emptyAlerts(); L.addAlertRule(bal, { sym: 'ASX:IVV', type: 'below', value: 50 }); L.addAlertRule(bal, { sym: 'ASX:FANG', type: 'above', value: 40 }); L.saveAlerts(src, bal);
    src.setItem(L.KEYS.settings, JSON.stringify({ refreshSec: 60, asxSheetUrl: 'https://docs.google.com/spreadsheets/d/FAKE_SHARED_SHEET_ID_FOR_TESTS_0001/edit' }));
    src.setItem(L.KEYS.apiKeys, JSON.stringify({ finnhub: 'FAKE_OTHER_KEY_FOR_TESTS', twelvedata: 'FAKE_TWELVE_KEY_FOR_TESTS', marketstack: '' }));
    st.setItem(L.KEYS.settings, JSON.stringify({ refreshSec: 300 }));
    L.applyBackup(st, L.parseBackup(JSON.stringify(L.buildBackup(src, { includeKeys: true }))), { mode: 'merge' });
    const w = L.loadWatchlist(st, [], L.KEYS.watchlist);
    assert.deepStrictEqual(w.symbols.map(x => x.symbol), ['AAPL', 'MSFT', 'NVDA'], 'device order first, new tickers appended, no duplicates');
    assert.deepStrictEqual(w.favourites, ['AAPL', 'NVDA']);
    const p = L.loadPortfolio(st), u = s => p.holdings.find(h => h.symbol === s).units;
    assert.strictEqual(u('IVV'), 4, 'device holding with units wins'); assert.strictEqual(u('FANG'), 7, '0-unit placeholder filled from backup'); assert.strictEqual(u('BHP'), 2, 'new holding added'); assert.strictEqual(u('SEMI'), 0);
    const a = L.loadAlerts(st); assert.strictEqual(a.rules.length, 2, 'same rule (ticker, type, value) not duplicated');
    const s = JSON.parse(st.getItem(L.KEYS.settings)); assert.strictEqual(s.refreshSec, 300, 'device settings kept'); assert.ok(s.asxSheetUrl.includes('FAKE_SHARED'), 'missing sheet link filled');
    const k = JSON.parse(st.getItem(L.KEYS.apiKeys)); assert.strictEqual(k.finnhub, 'FAKE_FINNHUB_KEY_FOR_TESTS', 'existing key kept'); assert.strictEqual(k.twelvedata, 'FAKE_TWELVE_KEY_FOR_TESTS', 'empty key filled');
    // merge onto a device whose US list is the untouched default (only in memory)
    const st2 = memStorage(), mem = L.defaultWatchlist([{ symbol: 'GOOGL' }]);
    L.applyBackup(st2, L.parseBackup(JSON.stringify(L.buildBackup(src))), { mode: 'merge', current: { US: mem } });
    assert.deepStrictEqual(L.loadWatchlist(st2, [], L.KEYS.watchlist).symbols.map(x => x.symbol), ['GOOGL', 'MSFT', 'NVDA']);
    assert.strictEqual(st2.getItem(L.KEYS.apiKeys), null, 'no keys in file: keys untouched');
  });
  await test('hand-typed sheet from the iPhone guide (Symbol, Price only) values FANG, SEMI, IVV in AUD with gain/loss', () => {
    const G = L.SHEET_GUIDE, cells = {};
    for (const line of G.byHand.slice(1, -1)) { const m = /^([AB])(\d): (.+)$/.exec(line); cells[m[1] + m[2]] = m[3]; }
    // what Google would export for that sheet (formulas replaced by prices)
    const csv = [1, 2, 3, 4].map(r => '"' + cells['A' + r] + '","' + (r === 1 ? cells.B1 : { FANG: '38.33', SEMI: '39.32', IVV: '74.22' }[cells['A' + r]]) + '"').join('\n');
    assert.ok(/=GOOGLEFINANCE\("ASX:FANG","price"\)/.test(cells.B2));
    const r = L.parseSheetQuotes(csv);
    assert.deepStrictEqual(Object.keys(r.quotes).sort(), ['FANG', 'IVV', 'SEMI']);
    const pf = L.defaultPortfolio();
    L.updateHolding(pf, 'ASX:FANG', { units: 100, avgCost: 30 }); L.updateHolding(pf, 'ASX:SEMI', { units: 50, avgCost: 35 }); L.updateHolding(pf, 'ASX:IVV', { units: 20, avgCost: 60 });
    const sum = L.portfolioSummary(pf.holdings, id => r.quotes[id.replace('ASX:', '')], null); // ASX needs no FX rate
    const row = s => sum.rows.find(x => x.symbol === s);
    assert.strictEqual(row('FANG').currency, 'AUD'); assert.ok(Math.abs(row('FANG').value - 3833) < 1e-6); assert.ok(Math.abs(row('FANG').gain - 833) < 1e-6);
    assert.ok(Math.abs(row('SEMI').value - 1966) < 1e-6); assert.ok(Math.abs(row('IVV').gain - 284.4) < 1e-6);
    assert.ok(Math.abs(sum.total.value - 7283.4) < 1e-6 && Math.abs(sum.total.gain - 1333.4) < 1e-6, 'total ' + sum.total.value);
    assert.strictEqual(row('FANG').dayChange, null, 'no previous close column: today\'s change left blank, not guessed');
  });
  await test('value history: one complete snapshot per day, previous close kept, DEMO and incomplete totals never saved', () => {
    const st = memStorage();
    const pf = L.defaultPortfolio(); L.updateHolding(pf, 'ASX:FANG', { units: 100, avgCost: 30 }); L.updateHolding(pf, 'ASX:SEMI', { units: 50, avgCost: 35 });
    const q = { 'ASX:FANG': { price: 38, change: -0.5, changePct: -1.3, date: '2026-10-09' }, 'ASX:SEMI': { price: 40, change: 1, changePct: 2.5, date: '2026-10-09' } };
    const sum = L.portfolioSummary(pf.holdings, id => q[id], null);
    assert.strictEqual(L.snapshotDate([q['ASX:FANG'], q['ASX:SEMI']], '2026-10-11'), '2026-10-09', 'a weekend load files the value under the last trade date');
    assert.strictEqual(L.snapshotDate([{ price: 1 }], '2026-10-11'), '2026-10-11', 'no trade date: today');
    assert.strictEqual(L.recordValueSnapshot(st, sum, pf.holdings, { date: '2026-10-09', demo: true }), null, 'DEMO never saved');
    assert.strictEqual(st.getItem(L.KEYS.valueHistory), null);
    const e = L.recordValueSnapshot(st, sum, pf.holdings, { date: '2026-10-09', t: 1 });
    assert.strictEqual(e.v, 5800); assert.strictEqual(e.pc, 5800 - (-50 + 50)); assert.strictEqual(e.sig, 'ASX:FANG=100,ASX:SEMI=50');
    q['ASX:FANG'].price = 39; L.recordValueSnapshot(st, L.portfolioSummary(pf.holdings, id => q[id], null), pf.holdings, { date: '2026-10-09', t: 2 });
    let h = L.loadValueHistory(st); assert.strictEqual(h.days.length, 1, 'same day replaced, not duplicated'); assert.strictEqual(h.days[0].v, 5900);
    const missing = L.portfolioSummary(pf.holdings, id => (id === 'ASX:SEMI' ? null : q[id]), null);
    assert.strictEqual(L.recordValueSnapshot(st, missing, pf.holdings, { date: '2026-10-12' }), null, 'a holding without a price: not saved (would look like a crash)');
    const pfUs = { holdings: [{ id: 'AAPL', symbol: 'AAPL', exchange: 'US', units: 2, avgCost: 100 }] };
    assert.strictEqual(L.recordValueSnapshot(st, L.portfolioSummary(pfUs.holdings, () => ({ price: 200, change: 1 }), null), pfUs.holdings, { date: '2026-10-12' }), null, 'no FX rate: not saved');
    L.recordValueSnapshot(st, L.portfolioSummary(pf.holdings, id => ({ ...q[id], change: null }), null), pf.holdings, { date: '2026-10-12' });
    h = L.loadValueHistory(st); assert.deepStrictEqual(h.days.map(x => x.d), ['2026-10-09', '2026-10-12']); assert.strictEqual(h.days[1].pc, null, 'no day change: no previous close invented');
    st.setItem(L.KEYS.valueHistory, '{bad'); assert.deepStrictEqual(L.loadValueHistory(st).days, [], 'damaged history ignored');
  });

  await test('value history: capped, stored without keys or names beyond ticker=units', () => {
    const st = memStorage(), pf = { holdings: [{ id: 'ASX:IVV', symbol: 'IVV', exchange: 'ASX', units: 1, avgCost: null }] };
    for (let i = 0; i < L.VALUE_HISTORY_MAX + 5; i++) {
      const d = new Date(Date.UTC(2023, 0, 1) + i * L.DAY).toISOString().slice(0, 10);
      L.recordValueSnapshot(st, L.portfolioSummary(pf.holdings, () => ({ price: 50 + i % 7, change: 0.1 }), null), pf.holdings, { date: d, t: i });
    }
    const raw = st.getItem(L.KEYS.valueHistory), h = JSON.parse(raw);
    assert.strictEqual(h.days.length, L.VALUE_HISTORY_MAX); assert.ok(h.days[0].d > '2023-01-01', 'oldest dropped first');
    assert.deepStrictEqual(Object.keys(h.days[0]).sort(), ['d', 'pc', 'sig', 't', 'v']);
  });

  await test('backfill: cached closes × today\u2019s units, forward-filled across calendars, all-or-nothing', () => {
    const hs = [{ id: 'ASX:FANG', symbol: 'FANG', exchange: 'ASX', units: 10 }, { id: 'AAPL', symbol: 'AAPL', exchange: 'US', units: 2 }, { id: 'ASX:IVV', symbol: 'IVV', exchange: 'ASX', units: 0 }];
    const bars = { FANG: [{ d: '2026-10-05', c: 10 }, { d: '2026-10-06', c: 11 }, { d: '2026-10-08', c: 12 }], AAPL: [{ d: '2026-10-06 00:00:00', c: 100 }, { d: '2026-10-07', c: 110 }] };
    const r = L.backfillValues(hs, h => bars[h.symbol], { rate: 1.5 });
    assert.deepStrictEqual(r.missing, []);
    assert.deepStrictEqual(r.points.map(p => [p.d, p.v]), [['2026-10-06', 410], ['2026-10-07', 440], ['2026-10-08', 450]], 'starts when every holding has a close; gaps carry the last close');
    assert.deepStrictEqual(L.backfillValues(hs, h => (h.symbol === 'AAPL' ? null : bars[h.symbol]), { rate: 1.5 }), { points: [], missing: ['AAPL'] }, 'one holding without closes: nothing rebuilt');
    assert.deepStrictEqual(L.backfillValues(hs, h => bars[h.symbol], null).missing, ['AAPL'], 'US needs an FX rate');
    assert.deepStrictEqual(L.backfillValues([], () => [], null), { points: [], missing: [] });
  });

  await test('value series: saved days beat rebuilt ones, previous close fills the day before, range + honest change', () => {
    const backfill = [{ d: '2026-09-01', v: 900 }, { d: '2026-10-07', v: 990 }, { d: '2026-10-08', v: 995 }];
    const snaps = [{ d: '2026-10-08', v: 1000, pc: 980, sig: 'a' }, { d: '2026-10-12', v: 1010, pc: 1005, sig: 'a' }];
    const s = L.buildValueSeries({ snapshots: snaps, backfill, current: { d: '2026-10-12', v: 1020, sig: 'a' }, range: 'All' });
    assert.deepStrictEqual(s.points.map(p => p.d + ':' + p.v + ':' + p.src), ['2026-09-01:900:eod', '2026-10-07:990:eod', '2026-10-08:1000:snap', '2026-10-09:1005:prev', '2026-10-12:1020:now'],
      'snapshot replaces the rebuilt close; the prev close of Mon fills Fri; a rebuilt close is not overwritten by a prev close; live total is last');
    assert.strictEqual(s.change, 120); assert.ok(Math.abs(s.changePct - 120 / 9) < 1e-9); assert.strictEqual(s.available.from, '2026-09-01'); assert.strictEqual(s.holdingsChanged, false);
    const m = L.buildValueSeries({ snapshots: snaps, backfill, current: null, range: '1M' });
    assert.strictEqual(m.points[0].d, '2026-10-07', '1M counts back from the last point'); assert.strictEqual(m.available.from, '2026-09-01');
    const first = L.buildValueSeries({ snapshots: [{ d: '2026-10-09', v: 7283.4, pc: 7377.1, sig: 'x' }], backfill: [], range: 'All' });
    assert.deepStrictEqual(first.points.map(p => p.src), ['prev', 'snap'], 'first day: previous close → now (two honest points)'); assert.strictEqual(first.points[0].d, '2026-10-08');
    assert.strictEqual(L.buildValueSeries({ snapshots: [{ d: '2026-10-09', v: 5, pc: null }], range: 'All' }).change, null, 'one point: no change claimed');
    assert.strictEqual(L.buildValueSeries({ snapshots: [{ d: '2026-10-08', v: 5, sig: 'a' }, { d: '2026-10-09', v: 9, sig: 'b' }], range: 'All' }).holdingsChanged, true, 'holdings changed is flagged');
    assert.strictEqual(L.buildValueSeries({ snapshots: [], backfill: [], range: '1Y' }).points.length, 0);
    assert.strictEqual(L.prevWeekday('2026-10-12'), '2026-10-09'); assert.strictEqual(L.prevWeekday('2026-10-07'), '2026-10-06');
    assert.deepStrictEqual(L.PF_RANGE_ORDER, ['1M', '3M', '1Y', 'All']);
  });
  summary('logic');
})();
