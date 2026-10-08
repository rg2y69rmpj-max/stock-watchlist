// Mock Finnhub / Twelve Data responses, shared by api.test.js and e2e.js. Numbers are made up for tests only.
function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function quote(sym) { const h = hash(sym), pc = 50 + (h % 900), dp = ((h % 801) - 400) / 100; const c = +(pc * (1 + dp / 100)).toFixed(2); return { c, d: +(c - pc).toFixed(2), dp, h: c * 1.01, l: c * 0.99, o: pc, pc, t: 1791403200 }; }
function profile(sym) { return { ticker: sym, name: sym + ' Mock Corp', marketCapitalization: 1000 + (hash(sym) % 50000), shareOutstanding: 100 + (hash(sym) % 9000), currency: 'USD', exchange: 'NASDAQ' }; }
function metric(sym) {
  return { symbol: sym, metricType: 'all', metric: { peTTM: 31.25, epsTTM: 7.5, currentDividendYieldTTM: 0.42, '52WeekHigh': 350.1, '52WeekLow': 190.2, beta: 1.11,
    '10DayAverageTradingVolume': 41.5, revenuePerShareTTM: 27.1, grossMarginTTM: 46.9, operatingMarginTTM: 31.6, netProfitMarginTTM: 24.3, marketCapitalization: 4000000 }, series: {} };
}
function recommendation(sym) { return [{ symbol: sym, period: '2026-10-01', strongBuy: 12, buy: 20, hold: 8, sell: 1, strongSell: 1 }, { symbol: sym, period: '2026-09-01', strongBuy: 1, buy: 1, hold: 30, sell: 5, strongSell: 5 }]; }
function earnings(sym) { return { earningsCalendar: [{ symbol: sym, date: '2026-10-29', hour: 'amc', epsEstimate: 1.8 }] }; }
function bars(interval, n) {
  const out = []; let p = 300;
  if (interval === '5min' || interval === '30min') {
    const step = interval === '5min' ? 5 : 30, per = interval === '5min' ? 78 : 13, days = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'];
    for (const d of days) for (let i = 0; i < per; i++) { const m = 570 + i * step; p += Math.sin(out.length / 5) * 0.8; out.push({ datetime: `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`, open: p, high: p, low: p, close: p.toFixed(2), volume: '100000' }); }
  } else {
    const stepDays = interval === '1week' ? 7 : 1; let t = Date.UTC(2026, 9, 7);
    while (out.length < n) { const d = new Date(t); if (stepDays === 7 || (d.getUTCDay() % 6)) { p -= Math.sin(out.length / 9) * 2; out.push({ datetime: d.toISOString().slice(0, 10), open: p, high: p, low: p, close: p.toFixed(2), volume: '34128200' }); } t -= stepDays * 864e5; }
    return out; // already newest first
  }
  return out.slice(-n).reverse(); // newest first, like the real API
}
function series(sym, interval, n) { return { meta: { symbol: sym, interval, currency: 'USD', exchange_timezone: 'America/New_York' }, values: bars(interval, n), status: 'ok' }; }
// Returns {status, body} for a URL, or null if the host isn't mocked.
function respond(url, opts = {}) {
  const u = new URL(url), sym = u.searchParams.get('symbol') || '';
  if (u.hostname === 'finnhub.io') {
    if (opts.finnhubLimit) return { status: 429, body: { error: 'API limit reached. Please try again later. Remaining Limit: 0' } };
    if (!u.searchParams.get('token')) return { status: 401, body: { error: 'Please use an API key.' } };
    const p = u.pathname.replace('/api/v1', '');
    if (p === '/quote') return { status: 200, body: sym === 'ZZZZ' ? { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 } : quote(sym) };
    if (p === '/stock/profile2') return { status: 200, body: sym === 'ZZZZ' ? {} : profile(sym) };
    if (p === '/stock/metric') return { status: 200, body: metric(sym) };
    if (p === '/stock/recommendation') return { status: 200, body: recommendation(sym) };
    if (p === '/calendar/earnings') return { status: 200, body: earnings(sym) };
    if (p === '/stock/price-target' || p === '/stock/candle') return { status: 403, body: { error: "You don't have access to this resource." } };
    return { status: 404, body: { error: 'not mocked' } };
  }
  if (u.hostname === 'api.twelvedata.com') {
    if (opts.twelveLimit) return { status: 200, body: { code: 429, message: 'You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8.', status: 'error' } };
    if (!/^apikey .+/.test(opts.authorization || '')) return { status: 200, body: { code: 401, message: '**apikey** parameter is incorrect or not specified.', status: 'error' } };
    const interval = u.searchParams.get('interval'), n = +u.searchParams.get('outputsize') || 30, syms = sym.split(',');
    if (syms.length === 1) return { status: 200, body: series(sym, interval, n) };
    const body = {}; for (const s of syms) body[s] = s === 'ZZZZ' ? { code: 400, message: '**symbol** not found', status: 'error' } : series(s, interval, n);
    return { status: 200, body };
  }
  return null;
}
module.exports = { respond, quote, profile, metric, recommendation, earnings, series };
