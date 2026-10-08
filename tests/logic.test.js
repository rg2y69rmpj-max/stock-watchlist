// Run: node tests/logic.test.js
const assert = require('assert');
const L = require('../logic.js');
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
  summary('logic');
})();
