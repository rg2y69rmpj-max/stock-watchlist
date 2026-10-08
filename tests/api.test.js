// Run: node tests/api.test.js   (data layer with a fake fetch, fake clock and in-memory localStorage)
const assert = require('assert');
const L = require('../logic.js');
const A = require('../api.js');
const mocks = require('./mocks.js');
const { memStorage, clock, test, summary } = require('./helpers.js');
const FH_KEY = 'FAKE_FINNHUB_KEY_FOR_TESTS', TD_KEY = 'FAKE_TWELVE_KEY_FOR_TESTS', MS_KEY = 'FAKE_MARKETSTACK_KEY_FOR_TESTS';

function setup(o = {}) {
  const st = memStorage(), c = clock(), calls = [], events = [];
  const state = { finnhubLimit: false, twelveLimit: false, marketstackLimit: false, frankfurterDown: false, fail: false };
  const fetch = async (url, init) => {
    calls.push({ url, t: c.now(), auth: init && init.headers && init.headers.Authorization });
    if (state.fail) throw new TypeError('Failed to fetch');
    const r = mocks.respond(url, { ...state, now: c.now(), authorization: init && init.headers && init.headers.Authorization });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const keys = { finnhub: FH_KEY, twelvedata: TD_KEY, marketstack: MS_KEY, ...(o.keys || {}) };
  const cap = { v: o.cap ?? 100 };
  const src = A.createDataSource({ storage: st, fetch, now: c.now, sleep: c.sleep, getKeys: () => keys, onEvent: (t, i) => events.push({ t, ...i }), marketstackCap: () => cap.v });
  return { st, c, calls, events, state, src, keys, cap, fetch };
}

(async () => {
  await test('quote: fetched once, served from cache within 1 min, refetched after TTL', async () => {
    const { src, calls, c } = setup();
    const a = await src.quote('AAPL'); assert.strictEqual(a.value.price, mocks.quote('AAPL').c); assert.strictEqual(calls.length, 1);
    await src.quote('AAPL'); assert.strictEqual(calls.length, 1, 'cache hit');
    c.advance(61e3); await src.quote('AAPL'); assert.strictEqual(calls.length, 2, 'refetch after TTL');
    await src.quote('AAPL', { force: true }); assert.strictEqual(calls.length, 3, 'force refresh');
  });
  await test('concurrent requests for the same thing share one call', async () => {
    const { src, calls } = setup();
    await Promise.all([src.metrics('MSFT'), src.metrics('MSFT'), src.metrics('MSFT')]); assert.strictEqual(calls.length, 1);
  });
  await test('Finnhub key goes in the token param only; Twelve Data key only in the Authorization header', async () => {
    const { src, calls } = setup();
    await src.quote('AAPL'); await src.candles('AAPL', '1M');
    assert.ok(calls[0].url.includes('token=' + FH_KEY)); assert.ok(calls[0].url.startsWith('https://finnhub.io/api/v1/quote?symbol=AAPL'));
    assert.ok(!calls[1].url.includes(TD_KEY)); assert.strictEqual(calls[1].auth, 'apikey ' + TD_KEY);
  });
  await test('no API key is ever written to the cache or usage entries', async () => {
    const { src, st } = setup();
    await src.quote('AAPL'); await src.metrics('AAPL'); await src.candles('AAPL', '1D'); await src.sparklines(['MSFT', 'NVDA']);
    for (const [k, v] of st.dump()) { assert.ok(!v.includes(FH_KEY) && !v.includes(TD_KEY), k); }
  });
  await test('metrics/ratings/earnings parsed; recommendation cached 12 h', async () => {
    const { src, calls, c } = setup();
    const m = await src.metrics('AAPL'); assert.strictEqual(m.value.peTTM, 31.25); assert.strictEqual(m.value.forwardPE, undefined);
    const r = await src.recommendation('AAPL'); assert.strictEqual(r.value.period, '2026-10-01'); assert.strictEqual(L.consensus(r.value).label, 'Buy');
    const e = await src.earnings('AAPL'); assert.strictEqual(e.value.date, '2026-10-29');
    const n = calls.length; c.advance(11 * 3600e3); await src.recommendation('AAPL'); assert.strictEqual(calls.length, n);
    c.advance(2 * 3600e3); await src.recommendation('AAPL'); assert.strictEqual(calls.length, n + 1);
  });
  await test('price target (premium) is cached as unavailable, so it costs one call per 12 h', async () => {
    const { src, calls } = setup();
    const a = await src.priceTarget('AAPL'); assert.deepStrictEqual(a.value, { unavailable: 'premium' });
    await src.priceTarget('AAPL'); assert.strictEqual(calls.length, 1);
  });
  await test('unknown symbol is reported as notFound, not as zeros', async () => {
    const { src } = setup(); const q = await src.quote('ZZZZ'); assert.deepStrictEqual(q.value, { notFound: true });
  });
  await test('candles: 1M, 6M and 1Y reuse one daily request; 1D, 5D, 5Y use their own', async () => {
    const { src, calls } = setup();
    const m1 = await src.candles('AAPL', '1M'); await src.candles('AAPL', '6M'); await src.candles('AAPL', '1Y');
    assert.strictEqual(calls.length, 1); assert.ok(calls[0].url.includes('interval=1day'));
    assert.ok(L.sliceRange(m1.value, '1M').length < L.sliceRange(m1.value, '1Y').length);
    await src.candles('AAPL', '1D'); await src.candles('AAPL', '5D'); await src.candles('AAPL', '5Y');
    assert.deepStrictEqual(calls.slice(1).map(x => new URL(x.url).searchParams.get('interval')), ['5min', '30min', '1week']);
    const d1 = L.sliceRange((await src.candles('AAPL', '1D')).value, '1D'); assert.strictEqual(d1.length, 78);
    assert.ok(src.peekSpark('AAPL').length === 22, 'daily series also fills the sparkline');
  });
  await test('sparklines: batched 6 symbols per request, cost counted per symbol, stays under 8 credits/min', async () => {
    const { src, calls, c } = setup();
    const syms = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'AVGO', 'TSLA', 'LLY', 'JPM', 'V', 'ZZZZ', 'WMT', 'XOM'];
    const t0 = c.now(); await src.sparklines(syms);
    const td = calls.filter(x => x.url.includes('twelvedata'));
    assert.strictEqual(td.length, 3); assert.strictEqual(new URL(td[0].url).searchParams.get('symbol').split(',').length, 6);
    assert.ok(c.now() - t0 >= 60e3, 'second batch of 6 had to wait for the next minute');
    const cost = x => new URL(x.url).searchParams.get('symbol').split(',').length;
    for (const a of td) assert.ok(td.filter(b => b.t >= a.t && b.t - a.t < 60e3).reduce((s, b) => s + cost(b), 0) <= 8, 'never more than 8 credits in any 60 s window');
    assert.strictEqual(src.peekSpark('AAPL').length, 22); assert.deepStrictEqual(src.peekSpark('ZZZZ'), []);
    assert.strictEqual(src.usage().tdToday, 13);
    await src.sparklines(syms); assert.strictEqual(calls.length, 3, 'all cached now');
  });
  await test('Finnhub limiter: 60 quotes take more than a minute (55/min budget), user requests jump the queue', async () => {
    const { src, calls, c } = setup();
    const syms = Array.from({ length: 60 }, (_, i) => 'S' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)));
    const t0 = c.now(); const order = [];
    const all = syms.map(s => src.quote(s, { prio: 4 }).then(() => order.push(s)));
    const urgent = src.metrics('AAPL', { prio: 0 }).then(() => order.push('URGENT'));
    await Promise.all([...all, urgent]);
    assert.ok(c.now() - t0 >= 60e3, 'had to wait for the window'); assert.strictEqual(calls.length, 61);
    assert.ok(order.indexOf('URGENT') < 3, 'urgent request served almost immediately: ' + order.indexOf('URGENT'));
    for (const a of calls) assert.ok(calls.filter(b => b.t >= a.t && b.t - a.t < 60e3).length <= 55, 'never more than 55 calls in any 60 s window');
  });
  await test('rate-limit history survives a relaunch (new data source on the same storage)', async () => {
    const { st, c, src } = setup();
    await src.sparklines(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'AVGO']); // 6 credits
    const calls2 = []; const fetch2 = async (url, init) => { calls2.push(c.now()); const r = mocks.respond(url, { authorization: init.headers.Authorization }); return { ok: true, status: 200, json: async () => r.body }; };
    const relaunched = A.createDataSource({ storage: st, fetch: fetch2, now: c.now, sleep: c.sleep, getKeys: () => ({ twelvedata: TD_KEY }) });
    const t0 = c.now(); await relaunched.sparklines(['TSLA', 'LLY', 'JPM']); // 3 more credits would make 9 in the same minute
    assert.ok(calls2[0] - t0 >= 59e3, 'waited for the window instead of exceeding 8/min');
  });
  await test('Finnhub 429: emits a limit event, pauses ~60 s, falls back to stale cache', async () => {
    const { src, state, events, c } = setup();
    await src.quote('AAPL'); c.advance(61e3); state.finnhubLimit = true;
    const r = await src.quote('AAPL'); assert.strictEqual(r.fresh, false); assert.strictEqual(r.error.type, 'rate-limit'); assert.strictEqual(r.value.price, mocks.quote('AAPL').c);
    assert.strictEqual(events[0].t, 'limit'); assert.ok(/60 calls\/min/.test(events[0].message));
    assert.ok(src.usage().fhPausedMs > 50e3);
    await assert.rejects(src.quote('MSFT'), e => e.type === 'rate-limit', 'no cache -> error surfaces');
  });
  await test('Twelve Data minute limit and daily 800-credit cap', async () => {
    const { src, state, events, st, c } = setup();
    state.twelveLimit = true;
    await assert.rejects(src.candles('AAPL', '1D'), e => e.type === 'rate-limit'); assert.ok(/8 credits\/min/.test(events.at(-1).message));
    state.twelveLimit = false;
    st.setItem(L.KEYS.usage, JSON.stringify({ day: new Date(c.now()).toISOString().slice(0, 10), td: 800, fh: 0 }));
    const before = events.length;
    await assert.rejects(src.candles('MSFT', '1D'), e => e.type === 'rate-limit' && e.daily); assert.ok(events.length > before);
    c.advance(86400e3); const ok = await src.candles('MSFT', '1D'); assert.ok(ok.value.length > 0, 'resets the next UTC day');
  });
  await test('bad key: auth event with a clear message; missing keys reject without calling', async () => {
    const { src, events, calls } = setup({ keys: { twelvedata: '' } });
    await assert.rejects(src.candles('AAPL', '1D'), e => e.type === 'nokey'); assert.strictEqual(calls.length, 0);
    assert.strictEqual(await src.sparklines(['AAPL']), 0);
    const s2 = setup({ keys: { finnhub: '' } }); await assert.rejects(s2.src.quote('AAPL'), e => e.type === 'nokey'); assert.strictEqual(s2.calls.length, 0);
    const s3 = setup(); const fetch401 = async () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid API key.' }) });
    const src3 = A.createDataSource({ storage: memStorage(), fetch: fetch401, now: s3.c.now, sleep: s3.c.sleep, getKeys: () => ({ finnhub: 'FAKE_BAD_KEY' }), onEvent: (t, i) => s3.events.push({ t, ...i }) });
    await assert.rejects(src3.quote('AAPL'), e => e.type === 'auth' && !String(e.message).includes('FAKE_BAD_KEY')); assert.strictEqual(s3.events[0].t, 'auth');
  });
  await test('network failure: stale cache returned, error messages never contain the key', async () => {
    const { src, state, c } = setup();
    await src.metrics('AAPL'); c.advance(13 * 3600e3); state.fail = true;
    const r = await src.metrics('AAPL'); assert.strictEqual(r.fresh, false); assert.strictEqual(r.error.type, 'network');
    try { await src.quote('NEW'); assert.fail('should throw'); } catch (e) { assert.ok(!JSON.stringify({ m: e.message, ...e }).includes(FH_KEY)); }
  });
  await test('demo source: deterministic, complete, price targets mirror the free tier', async () => {
    const d = A.createDemoSource({ names: { AAPL: 'Apple' }, caps: { AAPL: 4.9e12 } });
    assert.strictEqual(d.demo, true);
    const q1 = (await d.quote('AAPL')).value, q2 = (await A.createDemoSource().quote('AAPL')).value; assert.strictEqual(q1.price, q2.price);
    for (const r of L.RANGE_ORDER) assert.ok(L.sliceRange((await d.candles('AAPL', r)).value, r).length > 1, r);
    assert.deepStrictEqual((await d.priceTarget('AAPL')).value, { unavailable: 'premium' });
    assert.ok(Math.abs(L.marketCap(q1, (await d.profile('AAPL')).value) / 4.9e12 - 1) < 1e-6);
    assert.ok(L.consensus((await d.recommendation('AAPL')).value) !== undefined);
  });
  /* ---------- turn 2 ---------- */
  await test('Marketstack: key only in access_key, every symbol counts against the monthly budget, chunked, cached until the next close', async () => {
    const { src, calls, c } = setup();
    const codes = Array.from({ length: 30 }, (_, i) => 'A' + String(i).padStart(2, '0'));
    assert.strictEqual(src.asxCost(codes), 30);
    const r = await src.asxQuotes(codes); assert.strictEqual(r.requested, 30);
    const ms = calls.filter(x => x.url.startsWith('https://api.marketstack.com/v2/eod?'));
    assert.strictEqual(ms.length, 2, '25 + 5 symbols per call'); assert.ok(ms[0].url.includes('symbols=A00.AX%2CA01.AX')); assert.ok(ms[0].url.endsWith('&access_key=' + MS_KEY));
    assert.deepStrictEqual(src.asxBudget(), { used: 30, cap: 100, left: 70, month: '2026-10' });
    const q = src.peekAsxQuote('A05'); assert.strictEqual(q.eod, true); assert.ok(L.isNum(q.price) && L.isNum(q.changePct));
    await src.asxQuotes(codes); assert.strictEqual(calls.length, 2, 'served from cache'); assert.strictEqual(src.asxCost(codes), 0);
    c.advance(15 * 3600e3); assert.strictEqual(src.asxCost(codes), 0, 'still fresh before 6 pm Sydney');
    c.advance(2 * 3600e3); assert.strictEqual(src.asxCost(codes.slice(0, 3)), 3, 'stale once the next close is out');
  });
  await test('Marketstack: refuses to go over the monthly budget (no call made) and resets next month', async () => {
    const { src, calls, c, cap } = setup({ cap: 5 });
    await assert.rejects(src.asxQuotes(['BHP', 'CBA', 'NAB', 'WBC', 'ANZ', 'MQG']), e => e.type === 'budget' && /0\/5/.test(e.message));
    assert.strictEqual(calls.length, 0);
    await src.asxQuotes(['BHP', 'CBA']); assert.strictEqual(src.asxBudget().left, 3);
    await src.asxHistory('CSL'); assert.strictEqual(src.asxBudget().used, 3, 'history = 1 request');
    await assert.rejects(src.asxQuotes(['NAB', 'WBC', 'ANZ']), e => e.type === 'budget');
    cap.v = 100; await src.asxQuotes(['NAB']); assert.strictEqual(src.asxBudget().used, 4, 'cap is read live from settings');
    c.advance(25 * 864e5); assert.strictEqual(src.asxBudget().used, 0, 'new calendar month');
  });
  await test('Marketstack: monthly limit from the server marks the budget used; unknown ticker cached as not found; missing key', async () => {
    const t = setup();
    await t.src.asxQuotes(['ZZZ']); assert.deepStrictEqual(t.src.peekAsxQuote('ZZZ'), { notFound: true });
    t.state.marketstackLimit = true;
    await assert.rejects(t.src.asxQuotes(['BHP']), e => e.type === 'rate-limit' && e.monthly);
    assert.strictEqual(t.src.asxBudget().left, 0); assert.ok(t.events.some(e => e.t === 'limit' && e.provider === 'marketstack'));
    const n = setup({ keys: { marketstack: '' } });
    await assert.rejects(n.src.asxHistory('BHP'), e => e.type === 'nokey' && /Marketstack/.test(e.message)); assert.strictEqual(n.calls.length, 0);
  });
  await test('ASX history: ~1 year of closes, also fills the quote; cached until the next close', async () => {
    const { src, calls, c } = setup();
    const r = await src.asxHistory('FANG');
    assert.ok(r.value.length > 240 && r.value.length < 270, String(r.value.length)); assert.ok(r.value[0].d < r.value.at(-1).d);
    assert.ok(calls[0].url.includes('symbols=FANG.AX') && calls[0].url.includes('date_from=2025-10-0'));
    assert.strictEqual(src.peekAsxQuote('FANG').price, r.value.at(-1).c);
    await src.asxHistory('FANG'); assert.strictEqual(calls.length, 1); c.advance(17 * 3600e3); await src.asxHistory('FANG'); assert.strictEqual(calls.length, 2);
  });
  await test('FX: live Twelve Data rate (10 min cache), falls back to Frankfurter ECB rate, Frankfurter alone without a TD key', async () => {
    const a = setup();
    const r = await a.src.fx(); assert.strictEqual(r.value.rate, 1.5); assert.strictEqual(r.value.live, true); assert.strictEqual(r.value.source, 'Twelve Data');
    assert.ok(a.calls[0].url.startsWith('https://api.twelvedata.com/exchange_rate?symbol=USD%2FAUD')); assert.strictEqual(a.calls[0].auth, 'apikey ' + TD_KEY);
    await a.src.fx(); assert.strictEqual(a.calls.length, 1); a.c.advance(11 * 60e3); await a.src.fx(); assert.strictEqual(a.calls.length, 2);
    const b = setup(); b.state.twelveLimit = true;
    const fb = await b.src.fx(); assert.strictEqual(fb.value.rate, 1.4); assert.strictEqual(fb.value.live, false); assert.strictEqual(fb.value.date, '2026-10-07');
    assert.ok(b.calls[1].url.startsWith('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD')); assert.strictEqual(b.calls[1].auth, undefined);
    const n = setup({ keys: { twelvedata: '' } });
    const nr = await n.src.fx(); assert.strictEqual(nr.value.source, 'ECB reference rate (Frankfurter)'); assert.strictEqual(n.calls.length, 1);
    n.c.advance(3 * 3600e3); await n.src.fx(); assert.strictEqual(n.calls.length, 1, 'ECB rate cached 6 h'); assert.strictEqual(n.src.usage().frToday, 1);
    const d = setup({ keys: { twelvedata: '' } }); d.state.frankfurterDown = true; await assert.rejects(d.src.fx());
  });
  await test('news: last 7 days from Finnhub, parsed, cached 30 min', async () => {
    const { src, calls, c } = setup();
    const r = await src.news('AAPL'); assert.strictEqual(r.value.length, 2);
    assert.ok(calls[0].url.startsWith('https://finnhub.io/api/v1/company-news?symbol=AAPL&from=2026-09-30&to=2026-10-07&'), calls[0].url);
    await src.news('AAPL'); assert.strictEqual(calls.length, 1); c.advance(31 * 60e3); await src.news('AAPL'); assert.strictEqual(calls.length, 2);
  });
  await test('earnings calendar: one whole-market call for 14 days, trimmed, cached 6 h', async () => {
    const { src, calls, c, st } = setup();
    const r = await src.earningsCalendar(); assert.strictEqual(calls.length, 1);
    assert.ok(/\/calendar\/earnings\?from=2026-10-07&to=2026-10-21&token=/.test(calls[0].url), calls[0].url);
    assert.deepStrictEqual(Object.keys(r.value[0]).sort(), ['date', 'epsEstimate', 'hour', 'symbol']);
    c.advance(5 * 3600e3); await src.earningsCalendar(); assert.strictEqual(calls.length, 1);
    assert.ok(!st.dump().some(([, v]) => v.includes(FH_KEY)), 'key never stored');
  });
  await test('focus(view): queued requests for a screen you left are dropped; untagged (alerts/FX) and current ones kept', async () => {
    const { src, calls, c } = setup();
    for (let i = 0; i < 55; i++) src.quote('F' + i).catch(() => {}); // fill the minute
    await new Promise(r => setImmediate(r));
    const listJobs = ['L1', 'L2', 'L3'].map(s => src.quote(s, { view: 'list' }).then(() => 'ok', e => e.type));
    const alertJob = src.quote('AL1', { prio: 5 }).then(() => 'ok', e => e.type);
    const pfJob = src.quote('P1', { view: 'portfolio' }).then(() => 'ok', e => e.type);
    assert.strictEqual(src.focus('portfolio'), 3);
    assert.deepStrictEqual(await Promise.all(listJobs), ['cancelled', 'cancelled', 'cancelled']);
    c.advance(61e3);
    assert.strictEqual(await pfJob, 'ok'); assert.strictEqual(await alertJob, 'ok');
    assert.ok(!calls.some(x => /symbol=L\d/.test(x.url)), 'dropped jobs never hit the network');
    const order = calls.slice(55).map(x => new URL(x.url).searchParams.get('symbol')); assert.deepStrictEqual(order, ['P1', 'AL1'], 'visible screen first');
  });
  await test('usage() reports all four providers', async () => {
    const { src } = setup();
    await src.quote('AAPL'); await src.candles('AAPL', '1M'); await src.asxQuotes(['BHP', 'CBA']);
    const u = src.usage();
    assert.strictEqual(u.fhToday, 1); assert.strictEqual(u.tdToday, 1); assert.deepStrictEqual([u.ms.used, u.ms.cap], [2, 100]); assert.strictEqual(u.frToday, 0); assert.strictEqual(u.pending, 0);
  });
  await test('DEMO source: news has no links and is labelled, calendar/ASX/FX are synthetic and labelled', async () => {
    const d = A.createDemoSource({ names: { AAPL: 'Apple', MSFT: 'Microsoft' } });
    const n = (await d.news('AAPL')).value; assert.ok(n.length && n.every(x => x.url === null && /^DEMO: /.test(x.headline) && x.demo));
    assert.ok((await d.fx()).value.demo); assert.ok(/DEMO/.test(d.peekFx().source)); assert.strictEqual(d.peekAsxQuote('BHP').eod, true);
    assert.ok((await d.asxHistory('BHP')).value.length > 200); assert.strictEqual(d.asxCost(['BHP']), 0); assert.ok(d.asxBudget().demo);
    const cal = (await d.earningsCalendar()).value; assert.ok(Array.isArray(cal));
  });
  summary('api');
})();
