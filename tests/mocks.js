// Mock Finnhub / Twelve Data / Marketstack / Frankfurter / Google Sheets (CSV) responses, shared by api.test.js and e2e.js. Numbers are made up for tests only.
function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function quote(sym) { const h = hash(sym), pc = 50 + (h % 900), dp = ((h % 801) - 400) / 100; const c = +(pc * (1 + dp / 100)).toFixed(2); return { c, d: +(c - pc).toFixed(2), dp, h: c * 1.01, l: c * 0.99, o: pc, pc, t: 1791403200 }; }
function profile(sym) { return { ticker: sym, name: sym + ' Mock Corp', marketCapitalization: 1000 + (hash(sym) % 50000), shareOutstanding: 100 + (hash(sym) % 9000), currency: 'USD', exchange: 'NASDAQ' }; }
function metric(sym) {
  return { symbol: sym, metricType: 'all', metric: { peTTM: 31.25, epsTTM: 7.5, currentDividendYieldTTM: 0.42, '52WeekHigh': 350.1, '52WeekLow': 190.2, beta: 1.11,
    '10DayAverageTradingVolume': 41.5, revenuePerShareTTM: 27.1, grossMarginTTM: 46.9, operatingMarginTTM: 31.6, netProfitMarginTTM: 24.3, marketCapitalization: 4000000 }, series: {} };
}
function recommendation(sym) { return [{ symbol: sym, period: '2026-10-01', strongBuy: 12, buy: 20, hold: 8, sell: 1, strongSell: 1 }, { symbol: sym, period: '2026-09-01', strongBuy: 1, buy: 1, hold: 30, sell: 5, strongSell: 5 }]; }
function earnings(sym) { return { earningsCalendar: [{ symbol: sym, date: '2026-10-29', hour: 'amc', epsEstimate: 1.8 }] }; }
const DAY = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
function news(sym, now) {
  const t = Math.floor(now / 1000);
  return [
    { category: 'company', datetime: t - 3600, headline: sym + ' mock headline one', id: 1, source: 'MockWire', url: 'https://example.com/news/1', summary: '' },
    { category: 'company', datetime: t - 7200, headline: sym + ' mock headline two', id: 2, source: 'MockTimes', url: 'https://example.com/news/2', summary: '' },
    { category: 'company', datetime: t - 3600, headline: sym + ' mock headline one', id: 3, source: 'MockWire', url: 'https://example.com/news/1', summary: '' }, // duplicate
    { category: 'company', datetime: t - 9000, headline: 'Bad link', id: 4, source: 'X', url: 'javascript:alert(1)', summary: '' } // must be dropped
  ];
}
// Whole-market calendar (no symbol): a few watchlist names inside the window, one outside, one not in any list.
function calendar(from) {
  const base = Date.parse(from + 'T12:00:00Z'), d = n => iso(base + n * DAY);
  return { earningsCalendar: [
    { symbol: 'AAPL', date: d(2), hour: 'amc', epsEstimate: 1.85, revenueEstimate: 1e11, quarter: 4, year: 2026 },
    { symbol: 'MSFT', date: d(5), hour: 'bmo', epsEstimate: null, quarter: 1, year: 2027 },
    { symbol: 'AAPL', date: d(2), hour: 'amc', epsEstimate: 1.85 }, // duplicate row
    { symbol: 'NVDA', date: d(20), hour: 'amc', epsEstimate: 1.1 }, // outside 14 days
    { symbol: 'XYZQ', date: d(1), hour: 'bmo', epsEstimate: 0.1 } // not in any list
  ] };
}
// Marketstack /v2/eod: daily closes from date_from to today for each requested SYMBOL.AX, newest first.
function marketstackEod(symbols, dateFrom, now) {
  const data = [], start = Date.parse(dateFrom + 'T00:00:00Z');
  for (const full of symbols) {
    const code = full.replace(/\.AX$/, ''); if (code === 'ZZZ') continue;
    const h = hash(code), base = 5 + (h % 100);
    for (let t = Date.parse(iso(now) + 'T00:00:00Z'), i = 0; t >= start; t -= DAY) {
      const wd = new Date(t).getUTCDay(); if (!wd || wd === 6) continue;
      const close = +(base * (1 + Math.sin((h % 7) + i / 6) * 0.04) + (i === 0 ? (h % 2 ? 0.5 : -0.5) : 0)).toFixed(2); i++;
      data.push({ open: close, high: close, low: close, close, volume: 1000000 + (h % 1000) * 1000, adj_close: close, symbol: full, exchange: 'XASX', date: iso(t) + 'T00:00:00+0000' });
    }
  }
  return { pagination: { limit: 1000, offset: 0, count: data.length, total: data.length }, data };
}
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
// A user's Google Sheet built from the app's formula, as CSV (published or shared link). Prices are made up.
// opts.sheetCodes: tickers in the sheet (default FANG, SEMI, IVV, BHP, CBA, STW), opts.sheetBlank: codes whose price is #N/A, opts.sheetStatus: HTTP status.
const SHEET_CODES = ['FANG', 'SEMI', 'IVV', 'BHP', 'CBA', 'STW'];
function sheetPrice(code) { const h = hash('sheet' + code); const prev = +(10 + (h % 9000) / 100).toFixed(2), price = +(prev * (1 + ((h % 401) - 200) / 10000)).toFixed(2); return { price, prev }; }
function sheetCsv(codes = SHEET_CODES, blank = []) {
  const lines = ['Symbol,Price,PrevClose,TradeTime'];
  for (const c of codes) { const p = sheetPrice(c); lines.push(blank.includes(c) ? `${c},#N/A,#N/A,` : `${c},"A$${p.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}",${p.prev},2026-10-08 15:20`); }
  return lines.join('\r\n');
}
// Returns {status, body} (or {status, text, contentType} for CSV) for a URL, or null if the host isn't mocked.
function respond(url, opts = {}) {
  const u = new URL(url), sym = u.searchParams.get('symbol') || '';
  if (u.hostname === 'finnhub.io') {
    if (opts.finnhubLimit) return { status: 429, body: { error: 'API limit reached. Please try again later. Remaining Limit: 0' } };
    if (!u.searchParams.get('token')) return { status: 401, body: { error: 'Please use an API key.' } };
    const p = u.pathname.replace('/api/v1', '');
    if (p === '/quote') {
      if (opts.quoteOverride && opts.quoteOverride[sym]) { const q = quote(sym), c = opts.quoteOverride[sym]; return { status: 200, body: { ...q, c, d: +(c - q.pc).toFixed(2), dp: +((c - q.pc) / q.pc * 100).toFixed(4) } }; }
      return { status: 200, body: sym === 'ZZZZ' ? { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 } : quote(sym) };
    }
    if (p === '/stock/profile2') return { status: 200, body: sym === 'ZZZZ' ? {} : profile(sym) };
    if (p === '/stock/metric') return { status: 200, body: metric(sym) };
    if (p === '/stock/recommendation') return { status: 200, body: recommendation(sym) };
    if (p === '/calendar/earnings') return { status: 200, body: sym ? earnings(sym) : calendar(u.searchParams.get('from')) };
    if (p === '/company-news') return { status: 200, body: news(sym, opts.now || Date.now()) };
    if (p === '/stock/price-target' || p === '/stock/candle') return { status: 403, body: { error: "You don't have access to this resource." } };
    return { status: 404, body: { error: 'not mocked' } };
  }
  if (u.hostname === 'api.twelvedata.com') {
    if (opts.twelveLimit) return { status: 200, body: { code: 429, message: 'You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8.', status: 'error' } };
    if (!/^apikey .+/.test(opts.authorization || '')) return { status: 200, body: { code: 401, message: '**apikey** parameter is incorrect or not specified.', status: 'error' } };
    if (u.pathname === '/exchange_rate') return { status: 200, body: { symbol: sym, rate: 1.5, timestamp: Math.floor((opts.now || Date.now()) / 1000) - 60 } };
    const interval = u.searchParams.get('interval'), n = +u.searchParams.get('outputsize') || 30, syms = sym.split(',');
    if (syms.length === 1) return { status: 200, body: series(sym, interval, n) };
    const body = {}; for (const s of syms) body[s] = s === 'ZZZZ' ? { code: 400, message: '**symbol** not found', status: 'error' } : series(s, interval, n);
    return { status: 200, body };
  }
  if (u.hostname === 'api.marketstack.com') {
    if (!u.searchParams.get('access_key')) return { status: 401, body: { error: { code: 'missing_access_key', message: 'You have not supplied an API Access Key.' } } };
    if (opts.marketstackLimit) return { status: 429, body: { error: { code: 104, type: 'usage_limit_reached', info: 'Your monthly usage limit has been reached.' } } };
    if (u.pathname === '/v2/eod') return { status: 200, body: marketstackEod((u.searchParams.get('symbols') || '').split(','), u.searchParams.get('date_from'), opts.now || Date.now()) };
    return { status: 404, body: { error: { code: 'not_found', message: 'not mocked' } } };
  }
  if (u.hostname === 'docs.google.com' && u.pathname.startsWith('/spreadsheets/d/')) {
    if (opts.sheetStatus && opts.sheetStatus !== 200) return { status: opts.sheetStatus, text: '<!DOCTYPE html><html>Sign in</html>', contentType: 'text/html' };
    if (!/\/pub$|\/gviz\/tq$/.test(u.pathname) || (u.pathname.endsWith('/pub') && u.searchParams.get('output') !== 'csv')) return { status: 404, text: 'not mocked', contentType: 'text/plain' };
    return { status: 200, text: sheetCsv(opts.sheetCodes || SHEET_CODES, opts.sheetBlank || []), contentType: 'text/csv' };
  }
  if (u.hostname === 'api.frankfurter.dev') {
    if (opts.frankfurterDown) return { status: 500, body: { message: 'down' } };
    return { status: 200, body: { amount: 1, base: 'USD', date: '2026-10-07', rates: { AUD: 1.4 } } };
  }
  return null;
}
module.exports = { respond, quote, profile, metric, recommendation, earnings, series, news, calendar, marketstackEod, sheetCsv, sheetPrice, SHEET_CODES };
