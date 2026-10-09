/* Pure logic, no DOM. Works in the browser (window.SWL) and in Node (module.exports). */
(function (root) {
  'use strict';
  const NA_FREE = 'n/a (not on free tier)';
  const NA_NONE = 'n/a (not reported)';
  const KEYS = { watchlist: 'stockwatch.watchlist.v1', watchlistAsx: 'stockwatch.watchlist.asx.v1', settings: 'stockwatch.settings.v1', apiKeys: 'stockwatch.keys.v1',
    usage: 'stockwatch.usage.v1', usageMonth: 'stockwatch.usage.month.v1', portfolio: 'stockwatch.portfolio.v1', alerts: 'stockwatch.alerts.v1', backup: 'stockwatch.backup.v1' };
  const CACHE_PREFIX = 'stockwatch.cache.';
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const TTL = { quote: MIN, profile: 7 * DAY, metrics: 12 * HOUR, recommendation: 12 * HOUR, earnings: 12 * HOUR, priceTarget: 12 * HOUR, spark: 12 * HOUR,
    i5: 5 * MIN, i30: 30 * MIN, d1y: 6 * HOUR, w5y: DAY,
    news: 30 * MIN, earningsCal: 6 * HOUR, fxLive: 10 * MIN, fxDaily: 6 * HOUR, sheet: 5 * MIN };

  // Chart ranges -> which Twelve Data series to fetch (1M, 6M and 1Y share one daily series, so they cost one credit together).
  const DATASETS = {
    i5: { interval: '5min', outputsize: 160 },   // ~2 sessions of 5-minute bars; we keep the latest session
    i30: { interval: '30min', outputsize: 80 },  // ~6 sessions of 30-minute bars; we keep the latest 5
    d1y: { interval: '1day', outputsize: 260 },
    w5y: { interval: '1week', outputsize: 262 },
    spark: { interval: '1day', outputsize: 22 }
  };
  const RANGES = { '1D': { dataset: 'i5', sessions: 1 }, '5D': { dataset: 'i30', sessions: 5 }, '1M': { dataset: 'd1y', days: 31 },
    '6M': { dataset: 'd1y', days: 183 }, '1Y': { dataset: 'd1y', days: 366 }, '5Y': { dataset: 'w5y' } };
  const RANGE_ORDER = ['1D', '5D', '1M', '6M', '1Y', '5Y'];

  const isNum = v => typeof v === 'number' && isFinite(v);
  const toNum = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };

  /* ---------- formatting ---------- */
  function fmtPrice(n, cur) {
    if (!isNum(n)) return '—';
    const d = Math.abs(n) < 1 ? 4 : 2;
    return (n < 0 ? '−' : '') + (cur === 'AUD' ? 'A$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // Money with sign for gains: +A$1,234.50 / −$12.00
  function fmtSignedMoney(n, cur) { if (!isNum(n)) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + (cur === 'AUD' ? 'A$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtChange(n) { if (!isNum(n)) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }
  function fmtPct(n) { if (!isNum(n)) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%'; }
  function fmtBig(n, prefix = '$') {
    if (!isNum(n)) return '—';
    const a = Math.abs(n), s = n < 0 ? '−' : '';
    for (const [v, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= v) return s + prefix + (a / v).toFixed(a / v >= 100 ? 0 : 2) + u;
    return s + prefix + a.toFixed(0);
  }
  const fmtVolume = n => fmtBig(n, '');
  const fmtRatio = n => isNum(n) ? n.toFixed(2) : '—';
  const fmtPercentValue = n => isNum(n) ? n.toFixed(2) + '%' : '—'; // value already in percent units
  const direction = n => !isNum(n) || n === 0 ? 'flat' : n > 0 ? 'up' : 'down';
  const pad = n => String(n).padStart(2, '0');
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Twelve Data datetimes are exchange-local strings ("2026-10-07 15:55:00" or "2026-10-07"); show them as-is, labelled ET.
  function fmtBarTime(s, intraday) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s || ''); if (!m) return s || '';
    const date = MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
    if (!intraday || m[4] === undefined) return date;
    let h = +m[4]; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + h + ':' + m[5] + ' ' + ap + ' ET';
  }
  function fmtAsOf(ms, locale) {
    if (!isNum(ms) || ms <= 0) return '—';
    try { return new Date(ms).toLocaleString(locale || undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
    catch (e) { return new Date(ms).toISOString(); }
  }

  /* ---------- symbols, sorting, search ---------- */
  function normalizeAsx(s) { const t = String(s || '').trim().toUpperCase().replace(/^ASX:/, '').replace(/\.(AX|XASX)$/, ''); return /^[A-Z0-9]{2,6}$/.test(t) ? t : null; }
  // Internal ids: US tickers as-is ('AAPL'), ASX as 'ASX:BHP'.
  const makeId = (symbol, exchange) => exchange === 'ASX' ? 'ASX:' + symbol : symbol;
  const parseId = id => String(id).startsWith('ASX:') ? { symbol: String(id).slice(4), exchange: 'ASX' } : { symbol: String(id), exchange: 'US' };
  function normalizeSymbol(s) {
    const t = String(s || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^([A-Z]+)[-/]([A-Z])$/, '$1.$2');
    return /^[A-Z][A-Z0-9.]{0,9}$/.test(t) ? t : null;
  }
  // rows: [{symbol, name, price, changePct, marketCap}]. Missing values always sort last.
  function sortRows(rows, key = 'marketCap', dir = 'desc', opts = {}) {
    const favs = opts.favourites instanceof Set ? opts.favourites : new Set(opts.favourites || []);
    const sign = dir === 'asc' ? 1 : -1;
    const val = r => key === 'symbol' ? r.symbol : (isNum(r[key]) ? r[key] : null);
    return rows.map((r, i) => ({ r, i })).sort((A, B) => {
      const a = A.r, b = B.r;
      if (opts.favouritesFirst) { const fa = favs.has(a.symbol), fb = favs.has(b.symbol); if (fa !== fb) return fa ? -1 : 1; }
      const va = val(a), vb = val(b);
      if (va === null && vb === null) return A.i - B.i;
      if (va === null) return 1; if (vb === null) return -1;
      const c = key === 'symbol' ? va.localeCompare(vb) : va - vb;
      return c !== 0 ? c * sign : A.i - B.i;
    }).map(x => x.r);
  }
  function searchRows(rows, query) {
    const q = String(query || '').trim().toLowerCase(); if (!q) return rows.slice();
    const scored = [];
    for (const r of rows) {
      const s = r.symbol.toLowerCase(), n = String(r.name || '').toLowerCase();
      const score = s === q ? 0 : s.startsWith(q) ? 1 : n.startsWith(q) ? 2 : (s.includes(q) || n.includes(q) || n.split(/[\s.&-]+/).some(w => w.startsWith(q))) ? 3 : -1;
      if (score >= 0) scored.push({ r, score });
    }
    return scored.sort((a, b) => a.score - b.score).map(x => x.r); // stable: keeps the caller's sort inside each tier
  }

  /* ---------- watchlist + persistence ---------- */
  function defaultWatchlist(defaults) {
    return { version: 1, symbols: (defaults || []).map(d => ({ symbol: d.symbol, name: d.name || '' })), favourites: [],
      sort: { key: 'marketCap', dir: 'desc' }, favouritesFirst: false };
  }
  function addSymbol(wl, sym, name, exchange) {
    const s = exchange === 'ASX' ? normalizeAsx(sym) : normalizeSymbol(sym);
    if (!s) throw new Error(exchange === 'ASX' ? 'Invalid ASX code: 2 to 6 letters or digits, e.g. BHP or FANG' : 'Invalid ticker: use letters, digits or a dot, e.g. AAPL or BRK.B');
    if (wl.symbols.some(x => x.symbol === s)) return false;
    wl.symbols.push({ symbol: s, name: name || '' }); return true;
  }
  function removeSymbol(wl, sym) {
    const n = wl.symbols.length; wl.symbols = wl.symbols.filter(x => x.symbol !== sym);
    wl.favourites = wl.favourites.filter(x => x !== sym); return wl.symbols.length !== n;
  }
  function toggleFavourite(wl, sym) {
    const i = wl.favourites.indexOf(sym); if (i >= 0) { wl.favourites.splice(i, 1); return false; }
    if (wl.symbols.some(x => x.symbol === sym)) { wl.favourites.push(sym); return true; } return false;
  }
  function setName(wl, sym, name) { const x = wl.symbols.find(s => s.symbol === sym); if (x && name && !x.name) { x.name = name; return true; } return false; }
  function loadWatchlist(storage, defaults, key = KEYS.watchlist, norm = normalizeSymbol) {
    let raw = null; try { raw = JSON.parse(storage.getItem(key)); } catch (e) { raw = null; }
    if (!raw || !Array.isArray(raw.symbols)) return defaultWatchlist(defaults);
    const wl = defaultWatchlist([]);
    const seen = new Set();
    for (const x of raw.symbols) { const s = norm(x && x.symbol); if (s && !seen.has(s)) { seen.add(s); wl.symbols.push({ symbol: s, name: String(x.name || '') }); } }
    wl.favourites = (Array.isArray(raw.favourites) ? raw.favourites : []).filter(s => seen.has(s));
    if (raw.sort && ['symbol', 'changePct', 'price', 'marketCap'].includes(raw.sort.key)) wl.sort = { key: raw.sort.key, dir: raw.sort.dir === 'asc' ? 'asc' : 'desc' };
    wl.favouritesFirst = !!raw.favouritesFirst;
    return wl;
  }
  function saveWatchlist(storage, wl, key = KEYS.watchlist) { storage.setItem(key, JSON.stringify(wl)); }

  /* ---------- localStorage cache with TTL ---------- */
  function createCache(storage, now = () => Date.now(), prefix = CACHE_PREFIX) {
    function read(key) { try { const e = JSON.parse(storage.getItem(prefix + key)); return e && typeof e.t === 'number' ? e : null; } catch (e) { return null; } }
    function keys() { const out = []; for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(prefix)) out.push(k); } return out; }
    function evictOldest(n) {
      const ents = keys().map(k => { let t = 0; try { t = JSON.parse(storage.getItem(k)).t || 0; } catch (e) { /* corrupt */ } return { k, t }; }).sort((a, b) => a.t - b.t);
      ents.slice(0, Math.max(1, n)).forEach(e => storage.removeItem(e.k)); return ents.length;
    }
    return {
      get(key) { const e = read(key); return e && now() - e.t < e.ttl ? e.v : null; },
      entry(key) { const e = read(key); return e ? { value: e.v, savedAt: e.t, ttl: e.ttl, fresh: now() - e.t < e.ttl, age: now() - e.t } : null; },
      set(key, value, ttl) {
        const s = JSON.stringify({ t: now(), ttl, v: value });
        for (let attempt = 0; attempt < 6; attempt++) {
          try { storage.setItem(prefix + key, s); return true; }
          catch (e) { if (!evictOldest(Math.ceil(keys().length / 4))) return false; } // quota full: drop the oldest quarter and retry
        }
        return false;
      },
      remove(key) { storage.removeItem(prefix + key); },
      clear() { keys().forEach(k => storage.removeItem(k)); },
      prune() { let n = 0; for (const k of keys()) { const e = read(k.slice(prefix.length)); if (!e || now() - e.t > Math.max(e.ttl * 4, 2 * DAY)) { storage.removeItem(k); n++; } } return n; },
      size() { return keys().length; }
    };
  }

  /* ---------- rate limiting (sliding window) ---------- */
  // history: [{t, cost}] of requests already sent. Returns ms to wait before a request of `cost` may go.
  function waitTime(history, now, { max, windowMs = MIN, minGapMs = 0 }, cost = 1) {
    const live = history.filter(h => now - h.t < windowMs);
    let wait = 0;
    if (live.length && minGapMs) wait = Math.max(wait, live[live.length - 1].t + minGapMs - now);
    let used = live.reduce((s, h) => s + h.cost, 0);
    if (used + cost > max) {
      for (const h of live) { used -= h.cost; if (used + cost <= max) { wait = Math.max(wait, h.t + windowMs - now); break; } }
    }
    return Math.max(0, Math.ceil(wait));
  }

  /* ---------- API response parsing ---------- */
  function parseFinnhubQuote(j) {
    if (!j || typeof j !== 'object') return null;
    const c = toNum(j.c), pc = toNum(j.pc);
    if (!c && !pc) return null; // Finnhub returns zeros for unknown symbols
    const d = toNum(j.d) ?? (c !== null && pc ? c - pc : null);
    const dp = toNum(j.dp) ?? (c !== null && pc ? (c - pc) / pc * 100 : null);
    return { price: c, change: d, changePct: dp, high: toNum(j.h), low: toNum(j.l), open: toNum(j.o), prevClose: pc, t: toNum(j.t) ? j.t * 1000 : null };
  }
  function parseFinnhubProfile(j) {
    if (!j || !j.ticker && !j.name) return null;
    return { name: j.name || '', exchange: j.exchange || '', industry: j.finnhubIndustry || '',
      marketCapM: toNum(j.marketCapitalization), sharesM: toNum(j.shareOutstanding), currency: j.currency || 'USD' };
  }
  // Keep only the fields we show (the full response is large). `undefined` = key absent from the response.
  const pick = (m, names) => { for (const n of names) if (Object.prototype.hasOwnProperty.call(m, n)) return m[n] === null ? null : toNum(m[n]); return undefined; };
  function parseFinnhubMetrics(j) {
    const m = (j && j.metric) || {};
    return {
      peTTM: pick(m, ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM', 'peInclExtraTTM']),
      forwardPE: pick(m, ['forwardPE']),
      epsTTM: pick(m, ['epsTTM', 'epsBasicExclExtraItemsTTM', 'epsExclExtraItemsTTM', 'epsInclExtraItemsTTM']),
      dividendYield: pick(m, ['currentDividendYieldTTM', 'dividendYieldIndicatedAnnual']),
      high52: pick(m, ['52WeekHigh']), low52: pick(m, ['52WeekLow']), beta: pick(m, ['beta']),
      avgVolume10dM: pick(m, ['10DayAverageTradingVolume']),
      revenueTTM: pick(m, ['revenueTTM']), revenuePerShareTTM: pick(m, ['revenuePerShareTTM']),
      grossMargin: pick(m, ['grossMarginTTM']), operatingMargin: pick(m, ['operatingMarginTTM']), netMargin: pick(m, ['netProfitMarginTTM']),
      marketCapM: pick(m, ['marketCapitalization'])
    };
  }
  function latestRecommendation(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    const r = arr.slice().sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
    return { period: r.period, strongBuy: r.strongBuy | 0, buy: r.buy | 0, hold: r.hold | 0, sell: r.sell | 0, strongSell: r.strongSell | 0 };
  }
  // Consensus: weighted mean on a 1 (strong buy) .. 5 (strong sell) scale.
  function consensus(rec) {
    if (!rec) return null;
    const w = [['strongBuy', 1], ['buy', 2], ['hold', 3], ['sell', 4], ['strongSell', 5]];
    const total = w.reduce((s, [k]) => s + (rec[k] || 0), 0); if (!total) return null;
    const score = w.reduce((s, [k, v]) => s + (rec[k] || 0) * v, 0) / total;
    const label = score <= 1.5 ? 'Strong Buy' : score <= 2.5 ? 'Buy' : score <= 3.5 ? 'Hold' : score <= 4.5 ? 'Sell' : 'Strong Sell';
    return { total, score: Math.round(score * 100) / 100, label };
  }
  function nextEarnings(j, todayIso) {
    const list = (j && j.earningsCalendar) || [];
    const up = list.filter(e => e && e.date && e.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date));
    return up.length ? { date: up[0].date, hour: up[0].hour || '', epsEstimate: toNum(up[0].epsEstimate) } : null;
  }
  function parseFinnhubPriceTarget(j) {
    if (!j || (j.targetMean == null && j.targetHigh == null)) return null;
    return { mean: toNum(j.targetMean), median: toNum(j.targetMedian), high: toNum(j.targetHigh), low: toNum(j.targetLow), updated: j.lastUpdated || '' };
  }
  // Twelve Data: single-symbol {meta, values, status} or batch {AAPL: {...}, MSFT: {...}}. Returns {SYMBOL: bars|{error}}.
  function parseTwelveSeries(j, symbols) {
    const out = {};
    const one = (x) => {
      if (!x || x.status === 'error' || !Array.isArray(x.values)) return { error: (x && x.message) || 'No data', code: x && x.code };
      return x.values.map(v => ({ d: v.datetime, c: toNum(v.close), v: toNum(v.volume) })).filter(b => b.c !== null).reverse(); // oldest first
    };
    if (j && (j.values || j.status === 'error' && !symbols.some(s => j[s]))) { for (const s of symbols) out[s] = one(j); return out; }
    for (const s of symbols) out[s] = one(j && j[s]);
    return out;
  }
  // Keep the bars a range needs. bars are oldest-first with d = 'YYYY-MM-DD[ HH:MM:SS]'.
  function sliceRange(bars, range) {
    const cfg = RANGES[range]; if (!cfg || !Array.isArray(bars) || !bars.length) return [];
    if (cfg.sessions) {
      const days = [...new Set(bars.map(b => b.d.slice(0, 10)))].slice(-cfg.sessions);
      return bars.filter(b => days.includes(b.d.slice(0, 10)));
    }
    if (cfg.days) {
      const last = new Date(bars[bars.length - 1].d.slice(0, 10) + 'T00:00:00Z');
      return bars.filter(b => b.d.slice(0, 10) >= fromUTC(last, cfg.days));
    }
    return bars.slice();
  }
  function fromUTC(last, days) { const d = new Date(last.getTime() - days * DAY); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function rangeChange(bars) {
    if (!bars || bars.length < 2) return null;
    const a = bars[0].c, b = bars[bars.length - 1].c; return { change: b - a, changePct: (b - a) / a * 100 };
  }
  function sessionVolume(dailyBars, intradayBars) {
    if (dailyBars && dailyBars.length && isNum(dailyBars[dailyBars.length - 1].v)) return { value: dailyBars[dailyBars.length - 1].v, date: dailyBars[dailyBars.length - 1].d };
    if (intradayBars && intradayBars.length) {
      const day = intradayBars[intradayBars.length - 1].d.slice(0, 10);
      const v = intradayBars.filter(b => b.d.startsWith(day) && isNum(b.v)).reduce((s, b) => s + b.v, 0);
      return v ? { value: v, date: day } : null;
    }
    return null;
  }
  // SVG path for a sparkline.
  function sparkPath(values, w, h, padY = 2) {
    const v = (values || []).filter(isNum); if (v.length < 2) return '';
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    return v.map((x, i) => (i ? 'L' : 'M') + (i * w / (v.length - 1)).toFixed(1) + ',' + (padY + (h - 2 * padY) * (1 - (x - lo) / span)).toFixed(1)).join('');
  }
  function marketCap(quote, profile, metrics) {
    if (quote && isNum(quote.price) && profile && isNum(profile.sharesM) && profile.sharesM > 0) return quote.price * profile.sharesM * 1e6;
    if (profile && isNum(profile.marketCapM)) return profile.marketCapM * 1e6;
    if (metrics && isNum(metrics.marketCapM)) return metrics.marketCapM * 1e6;
    return null;
  }
  // Classify an API failure so the UI can say something useful.
  const PROVIDER_NAMES = { finnhub: 'Finnhub', twelvedata: 'Twelve Data', marketstack: 'Marketstack', frankfurter: 'Frankfurter' };
  function classifyError(provider, status, body) {
    // Marketstack: {error: {code: 'missing_access_key', message}} or {error: {code: 104, type: 'usage_limit_reached', info}}
    const err = body && typeof body.error === 'object' && body.error ? body.error : null;
    const msg = String((err && (err.message || err.info)) || (body && (body.error || body.message)) || (typeof body === 'string' ? body : '') || '');
    const code = err ? (err.type || err.code) : body && body.code;
    const name = PROVIDER_NAMES[provider] || provider;
    if (provider === 'marketstack') {
      if (code === 'usage_limit_reached' || code === 'daily_usage_limit_reached') return { type: 'rate-limit', monthly: true, message: 'Marketstack free quota used up (100 requests/month). ASX prices stay as last loaded.' };
      if (status === 429 || code === 'rate_limit_reached' || code === 'fair_use_limit_reached') return { type: 'rate-limit', message: 'Marketstack rate limit (5 requests/second). Try again in a moment.' };
      if (code === 'invalid_access_key' || code === 'missing_access_key' || status === 401) return { type: 'auth', message: 'Marketstack rejected the access key. Check it in Settings.' };
      if (code === 'function_access_restricted' || code === 'https_access_restricted' || status === 403) return { type: 'premium', message: NA_FREE };
      if (code === 'no_valid_symbols_provided' || status === 404 || status === 422) return { type: 'not-found', message: 'Marketstack has no data for that ticker' };
    }
    if (status === 429 || code === 429 || /limit|credits/i.test(msg) && !/access/i.test(msg)) {
      const daily = /day|daily/i.test(msg);
      return { type: 'rate-limit', daily, message: provider === 'twelvedata'
        ? 'Twelve Data free limit reached (8 credits/min, 800/day)' + (daily ? ' for today.' : '. Waiting for the next minute.')
        : 'Finnhub free limit reached (60 calls/min). Waiting a minute.' };
    }
    if (status === 401 || code === 401 || /invalid api key|api key|apikey/i.test(msg) && !/access/i.test(msg)) return { type: 'auth', message: name + ' rejected the API key. Check it in Settings.' };
    if (status === 403 || code === 403 || /access|premium|subscription|plan/i.test(msg)) return { type: 'premium', message: NA_FREE };
    if (status === 404 || code === 404 || code === 400) return { type: 'not-found', message: msg || 'Symbol not found' };
    if (status === 0) return { type: 'network', message: 'Network error. Showing cached data if available.' };
    return { type: 'other', message: msg || ('HTTP ' + status) };
  }


  /* ---------- portfolio ---------- */
  const SEED_PORTFOLIO = [{ symbol: 'FANG', exchange: 'ASX' }, { symbol: 'SEMI', exchange: 'ASX' }, { symbol: 'IVV', exchange: 'ASX' }]; // tickers only, no amounts
  function defaultPortfolio() { return { version: 1, holdings: SEED_PORTFOLIO.map(h => ({ id: makeId(h.symbol, h.exchange), symbol: h.symbol, exchange: h.exchange, units: 0, avgCost: null, buyDate: '' })) }; }
  function cleanHolding(x, todayIso) {
    const exchange = x.exchange === 'US' ? 'US' : 'ASX';
    const symbol = exchange === 'ASX' ? normalizeAsx(x.symbol) : normalizeSymbol(x.symbol);
    if (!symbol) throw new Error('Invalid ticker');
    const units = x.units === '' || x.units == null ? 0 : Number(x.units);
    if (!isFinite(units) || units < 0) throw new Error('Units must be zero or more');
    const avgCost = x.avgCost === '' || x.avgCost == null ? null : Number(x.avgCost);
    if (avgCost !== null && (!isFinite(avgCost) || avgCost <= 0)) throw new Error('Average cost must be more than 0, or blank');
    const buyDate = x.buyDate ? String(x.buyDate) : '';
    if (buyDate && (!/^\d{4}-\d{2}-\d{2}$/.test(buyDate) || (todayIso && buyDate > todayIso))) throw new Error('Buy date must be a past date (YYYY-MM-DD)');
    return { id: makeId(symbol, exchange), symbol, exchange, units, avgCost, buyDate };
  }
  function loadPortfolio(storage) {
    let raw = null; try { raw = JSON.parse(storage.getItem(KEYS.portfolio)); } catch (e) { raw = null; }
    if (!raw || !Array.isArray(raw.holdings)) return defaultPortfolio();
    const pf = { version: 1, holdings: [] }, seen = new Set();
    for (const h of raw.holdings) { try { const c = cleanHolding(h); if (!seen.has(c.id)) { seen.add(c.id); pf.holdings.push(c); } } catch (e) { /* drop invalid */ } }
    return pf;
  }
  function savePortfolio(storage, pf) { storage.setItem(KEYS.portfolio, JSON.stringify(pf)); }
  function addHolding(pf, h, todayIso) {
    const c = cleanHolding(h, todayIso);
    if (pf.holdings.some(x => x.id === c.id)) throw new Error(c.symbol + ' is already in the portfolio. Edit it instead.');
    pf.holdings.push(c); return c;
  }
  function updateHolding(pf, id, patch, todayIso) {
    const i = pf.holdings.findIndex(x => x.id === id); if (i < 0) return null;
    const c = cleanHolding({ ...pf.holdings[i], ...patch, symbol: pf.holdings[i].symbol, exchange: pf.holdings[i].exchange }, todayIso);
    pf.holdings[i] = c; return c;
  }
  function removeHolding(pf, id) { const n = pf.holdings.length; pf.holdings = pf.holdings.filter(x => x.id !== id); return pf.holdings.length !== n; }
  // All values in AUD. getQuote(id) -> {price, change} in the listing currency; fx = {rate} AUD per USD (needed only for US holdings).
  function portfolioSummary(holdings, getQuote, fx) {
    const rate = fx && isNum(fx.rate) && fx.rate > 0 ? fx.rate : null;
    const rows = holdings.map(h => {
      const q = getQuote(h.id), mult = h.exchange === 'US' ? rate : 1, px = q && isNum(q.price) ? q.price : null;
      const value = px !== null && mult !== null ? h.units * px * mult : null;
      const cost = h.avgCost !== null && mult !== null ? h.units * h.avgCost * mult : null;
      const gain = value !== null && cost !== null ? value - cost : null;
      const day = q && isNum(q.change) && mult !== null ? h.units * q.change * mult : null;
      return { ...h, currency: h.exchange === 'US' ? 'USD' : 'AUD', price: px, value, cost, gain, gainPct: gain !== null && cost > 0 ? gain / cost * 100 : null,
        dayChange: day, dayPct: q && isNum(q.changePct) ? q.changePct : null, needsInput: !(h.units > 0) || h.avgCost === null, missingPrice: h.units > 0 && value === null, weight: null };
    });
    const valued = rows.filter(r => r.value !== null), complete = valued.filter(r => r.cost !== null);
    const totalValue = valued.reduce((s, r) => s + r.value, 0);
    rows.forEach(r => { r.weight = r.value !== null && totalValue > 0 ? r.value / totalValue * 100 : null; });
    const cCost = complete.reduce((s, r) => s + r.cost, 0), cGain = complete.reduce((s, r) => s + r.gain, 0);
    const dayRows = valued.filter(r => r.dayChange !== null), dayTotal = dayRows.reduce((s, r) => s + r.dayChange, 0);
    const prevValue = totalValue - dayTotal;
    return { rows, currency: 'AUD', needsFx: holdings.some(h => h.exchange === 'US' && h.units > 0), fxMissing: holdings.some(h => h.exchange === 'US' && h.units > 0) && rate === null,
      total: { value: valued.length ? totalValue : null, cost: complete.length ? cCost : null, gain: complete.length ? cGain : null, gainPct: cCost > 0 ? cGain / cCost * 100 : null,
        dayChange: dayRows.length ? dayTotal : null, dayPct: dayRows.length && prevValue > 0 ? dayTotal / prevValue * 100 : null },
      missing: rows.filter(r => r.missingPrice).map(r => r.symbol), needsInput: rows.filter(r => r.needsInput).map(r => r.symbol) };
  }

  /* ---------- alerts ---------- */
  const ALERT_TYPES = { above: 'Price above', below: 'Price below', movePct: 'Daily move ≥ %' };
  function emptyAlerts() { return { version: 1, rules: [], history: [] }; }
  function loadAlerts(storage) {
    let raw = null; try { raw = JSON.parse(storage.getItem(KEYS.alerts)); } catch (e) { raw = null; }
    if (!raw || !Array.isArray(raw.rules)) return emptyAlerts();
    return { version: 1, rules: raw.rules.filter(r => r && r.id && ALERT_TYPES[r.type] && isNum(r.value)), history: Array.isArray(raw.history) ? raw.history.slice(0, 200) : [] };
  }
  function saveAlerts(storage, st) { storage.setItem(KEYS.alerts, JSON.stringify(st)); }
  function addAlertRule(st, { sym, type, value }) {
    const id = parseId(sym), symbol = id.exchange === 'ASX' ? normalizeAsx(id.symbol) : normalizeSymbol(id.symbol);
    if (!symbol) throw new Error('Invalid ticker');
    if (!ALERT_TYPES[type]) throw new Error('Pick an alert type');
    const v = Number(value);
    if (!isFinite(v) || v <= 0 || (type === 'movePct' && v > 100)) throw new Error(type === 'movePct' ? 'Move must be between 0 and 100 %' : 'Price must be more than 0');
    const rule = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sym: makeId(symbol, id.exchange), type, value: v, enabled: true, armed: true, lastDay: '' };
    st.rules.push(rule); return rule;
  }
  function removeAlertRule(st, ruleId) { const n = st.rules.length; st.rules = st.rules.filter(r => r.id !== ruleId); return st.rules.length !== n; }
  // Price alerts fire once when crossed and re-arm after the price moves back. Move alerts fire at most once per trading day.
  function evaluateAlerts(st, quotes, now, opts = {}) {
    const fired = [];
    for (const r of st.rules) {
      const q = quotes[r.sym]; if (!r.enabled || !q || !isNum(q.price)) continue;
      let hit = false;
      if (r.type === 'above' || r.type === 'below') {
        const cond = r.type === 'above' ? q.price >= r.value : q.price <= r.value;
        if (cond && r.armed !== false) { hit = true; r.armed = false; } else if (!cond) r.armed = true;
      } else if (r.type === 'movePct' && isNum(q.changePct)) {
        const day = q.date || (isNum(q.t) ? isoDate(new Date(q.t)) : isoDate(new Date(now)));
        if (Math.abs(q.changePct) >= r.value && r.lastDay !== day) { hit = true; r.lastDay = day; }
      }
      if (hit) {
        const e = { id: 'h' + now.toString(36) + Math.random().toString(36).slice(2, 6), ruleId: r.id, sym: r.sym, type: r.type, value: r.value, price: q.price, changePct: isNum(q.changePct) ? q.changePct : null, t: now, seen: false, demo: !!opts.demo, eod: !!q.eod };
        st.history.unshift(e); fired.push(e);
      }
    }
    st.history = st.history.slice(0, 200);
    return fired;
  }
  function alertMessage(e) {
    const { symbol, exchange } = parseId(e.sym), cur = exchange === 'ASX' ? 'AUD' : 'USD';
    const base = e.type === 'above' ? `${symbol} is above ${fmtPrice(e.value, cur)} (now ${fmtPrice(e.price, cur)})`
      : e.type === 'below' ? `${symbol} is below ${fmtPrice(e.value, cur)} (now ${fmtPrice(e.price, cur)})`
      : `${symbol} moved ${fmtPct(e.changePct)} today (alert at ±${e.value}%)`;
    return (e.demo ? 'DEMO: ' : '') + base + (e.eod ? ' · end-of-day price' : '');
  }
  const unseenAlerts = st => st.history.filter(h => !h.seen).length;

  /* ---------- overview, earnings, news ---------- */
  function topMovers(rows, n = 5) {
    const ok = rows.filter(r => isNum(r.changePct));
    return { gainers: ok.filter(r => r.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, n),
      losers: ok.filter(r => r.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, n) };
  }
  function parseEarningsCalendar(j) {
    return ((j && j.earningsCalendar) || []).filter(e => e && e.symbol && e.date)
      .map(e => ({ symbol: e.symbol, date: e.date, hour: e.hour || '', epsEstimate: toNum(e.epsEstimate), revenueEstimate: toNum(e.revenueEstimate) }));
  }
  const HOUR_ORDER = { bmo: 0, dmh: 1, amc: 2, '': 3 };
  const HOUR_LABEL = { bmo: 'Before market open', amc: 'After market close', dmh: 'During market hours', '': 'Time not announced' };
  function upcomingEarnings(list, symbols, fromIso, toIso) {
    const want = symbols instanceof Set ? symbols : new Set(symbols);
    const seen = new Set();
    return list.filter(e => want.has(e.symbol) && e.date >= fromIso && e.date <= toIso)
      .filter(e => { const k = e.symbol + e.date; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.date.localeCompare(b.date) || (HOUR_ORDER[a.hour] ?? 3) - (HOUR_ORDER[b.hour] ?? 3) || a.symbol.localeCompare(b.symbol));
  }
  function groupByDate(list) { const out = []; for (const e of list) { let g = out[out.length - 1]; if (!g || g.date !== e.date) out.push(g = { date: e.date, items: [] }); g.items.push(e); } return out; }
  const safeUrl = u => (typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);
  function parseNews(arr, limit = 15) {
    const seen = new Set();
    return (Array.isArray(arr) ? arr : []).filter(n => n && n.headline && safeUrl(n.url) && isNum(n.datetime))
      .sort((a, b) => b.datetime - a.datetime)
      .filter(n => { const k = n.url + '|' + n.headline; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, limit).map(n => ({ headline: String(n.headline).slice(0, 300), source: String(n.source || ''), t: n.datetime * 1000, url: safeUrl(n.url) }));
  }
  function fmtAgo(ms, now = Date.now()) {
    const s = Math.max(0, (now - ms) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  /* ---------- ASX end-of-day (Marketstack) + FX ---------- */
  // Response: {data: [{symbol: 'BHP.AX', exchange: 'XASX', date: '2026-10-07T00:00:00+0000', close, volume}, ...]} newest first.
  function parseMarketstackEod(j) {
    const out = {};
    for (const r of (j && j.data) || []) {
      if (!r || !r.symbol || !isNum(toNum(r.close))) continue;
      const sym = String(r.symbol).replace(/\.(AX|XASX)$/i, '').toUpperCase();
      (out[sym] = out[sym] || []).push({ d: String(r.date).slice(0, 10), c: toNum(r.close), v: toNum(r.volume) });
    }
    for (const k in out) { const seen = new Set(); out[k] = out[k].filter(b => !seen.has(b.d) && seen.add(b.d)).sort((a, b) => a.d.localeCompare(b.d)); }
    return out;
  }
  function eodQuote(bars) {
    if (!bars || !bars.length) return null;
    const last = bars[bars.length - 1], prev = bars.length > 1 ? bars[bars.length - 2] : null;
    return { price: last.c, prevClose: prev ? prev.c : null, change: prev ? last.c - prev.c : null, changePct: prev && prev.c ? (last.c - prev.c) / prev.c * 100 : null,
      date: last.d, t: Date.parse(last.d + 'T00:00:00Z'), volume: last.v, eod: true };
  }
  function parseTwelveRate(j) { const r = toNum(j && j.rate); return r && r > 0 ? { rate: r, t: toNum(j.timestamp) ? j.timestamp * 1000 : null } : null; }
  function parseFrankfurter(j) { const r = toNum(j && j.rates && j.rates.AUD); return r && r > 0 ? { rate: r, date: j.date || '' } : null; }
  const monthKey = ms => new Date(ms).toISOString().slice(0, 7);
  // ASX closes at 4 pm Sydney time; end-of-day data is assumed ready by 6 pm. A cached close stays fresh until the next such time
  // (skipping weekends), so each ASX ticker costs at most one Marketstack request per trading day.
  function asxTtl(ms) {
    let wall;
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
      wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    } catch (e) { wall = ms + 10 * HOUR; }
    const off = wall - ms, t = new Date(wall);
    let target = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 18);
    if (wall >= target) target += DAY;
    while ([0, 6].includes(new Date(target).getUTCDay())) target += DAY;
    return Math.min(4 * DAY, Math.max(HOUR, target - off - ms));
  }
  /* ---------- ASX via your own Google Sheet (GOOGLEFINANCE, shared or published as CSV) ----------
     No key, no card, CORS allowed by Google. Prices are Google Finance's (delayed up to ~20 min), so they are not end-of-day only. */
  const SHEET_HEADER = ['Symbol', 'Price', 'PrevClose', 'TradeTime'];
  // Accepts a "Publish to web" link (…/spreadsheets/d/e/2PACX…/pubhtml or pub?output=csv) or a normal share link (…/spreadsheets/d/<id>/edit…).
  function normalizeSheetUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let u; try { u = new URL(s); } catch (e) { throw new Error('That isn\u2019t a link. Copy the whole link from Google Sheets (it starts with https://docs.google.com/spreadsheets/).'); }
    if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !u.pathname.startsWith('/spreadsheets/d/')) throw new Error('Use a Google Sheets link that starts with https://docs.google.com/spreadsheets/');
    const gid = u.searchParams.get('gid') || (/(?:^|[#&])gid=(\d+)/.exec(u.hash) || [])[1] || '';
    if (gid && !/^\d+$/.test(gid)) throw new Error('The link has an odd gid (sheet tab) value.');
    let m = /^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]{20,})\//.exec(u.pathname + '/');
    if (m) return { url: 'https://docs.google.com/spreadsheets/d/e/' + m[1] + '/pub?' + (gid ? 'gid=' + gid + '&single=true&' : '') + 'output=csv', kind: 'published' };
    m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(\/|$)/.exec(u.pathname);
    if (m) return { url: 'https://docs.google.com/spreadsheets/d/' + m[1] + '/gviz/tq?tqx=out:csv&headers=1' + (gid ? '&gid=' + gid : ''), kind: 'shared' };
    throw new Error('Couldn\u2019t find the sheet id in that link.');
  }
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    const s = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ''));
  }
  // "A$38.61", "38.61", "1,234.50" -> number; "#N/A", "Loading..." and blanks -> null.
  function sheetNum(v) {
    const t = String(v == null ? '' : v).trim();
    if (!t || /^#|loading/i.test(t)) return null;
    const c = t.replace(/[A-Z]{0,3}\$|AUD|\s|,/gi, '');
    return /^-?\d+(\.\d+)?$/.test(c) ? Number(c) : null;
  }
  // Wall-clock time in Sydney -> UTC ms (handles daylight saving).
  function sydneyToUtc(y, mo, d, h, mi) {
    const guess = Date.UTC(y, mo - 1, d, h, mi) - 10 * HOUR;
    for (let k = 0, t = guess; k < 2; k++) {
      let off = 10 * HOUR;
      try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          .formatToParts(new Date(t)).map(x => [x.type, x.value]));
        off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - t;
      } catch (e) { /* no Intl time zones */ }
      t = Date.UTC(y, mo - 1, d, h, mi) - off;
      if (k === 1) return t;
    }
    return guess;
  }
  // CSV -> {quotes: {FANG: {price, prevClose, change, changePct, date, t, sheet: true}}, rows, skipped: [...]}
  function parseSheetQuotes(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('The sheet is empty. Paste the formula from the app into cell A1.');
    if (/^\s*<(!doctype|html)/i.test(String(text))) throw new Error('Google sent a web page instead of CSV. Check the sheet is shared (Anyone with the link) or published to the web.');
    const norm = h => String(h).toLowerCase().replace(/[^a-z]/g, '');
    const hi = rows.findIndex(r => r.some(c => ['symbol', 'ticker', 'code', 'asxcode'].includes(norm(c))));
    let col = { sym: 0, price: 1, prev: 2, time: 3 }, body = rows;
    if (hi >= 0) {
      const h = rows[hi].map(norm), find = names => h.findIndex(x => names.includes(x));
      col = { sym: find(['symbol', 'ticker', 'code', 'asxcode']), price: find(['price', 'last', 'lastprice', 'close']), prev: find(['prevclose', 'closeyest', 'previousclose', 'prev']), time: find(['tradetime', 'time', 'datetime', 'date', 'asof']) };
      body = rows.slice(hi + 1);
      if (col.price < 0) throw new Error('The sheet has no Price column. Paste the formula from the app into cell A1.');
    }
    const quotes = {}, skipped = [];
    for (const r of body) {
      const code = normalizeAsx(r[col.sym]);
      if (!code) continue;
      const price = sheetNum(r[col.price]), prev = col.prev >= 0 ? sheetNum(r[col.prev]) : null;
      if (price === null || price <= 0) { skipped.push(code); continue; }
      const tt = col.time >= 0 ? String(r[col.time] || '').trim() : '';
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(tt);
      const date = m ? m[1] + '-' + m[2] + '-' + m[3] : null;
      const t = m ? sydneyToUtc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 16, m[5] ? +m[5] : 0) : null;
      quotes[code] = { price, prevClose: prev, change: prev ? price - prev : null, changePct: prev ? (price - prev) / prev * 100 : null, date, t, timeText: m && m[4] ? tt.slice(0, 16) : '', sheet: true, eod: false };
    }
    return { quotes, rows: Object.keys(quotes).length, skipped };
  }
  // One formula for cell A1 that builds the whole table (Australian/US/UK locale: commas between columns, semicolons between rows).
  function sheetFormula(codes) {
    const list = [...new Set((codes || []).map(normalizeAsx).filter(Boolean))];
    const gf = (c, a) => `IFERROR(GOOGLEFINANCE("ASX:${c}","${a}"),"")`;
    const row = c => `"${c}",${gf(c, 'price')},${gf(c, 'closeyest')},IFERROR(TEXT(GOOGLEFINANCE("ASX:${c}","tradetime"),"yyyy-mm-dd hh:mm"),"")`;
    return '={' + SHEET_HEADER.map(h => '"' + h + '"').join(',') + (list.length ? ';' + list.map(row).join(';') : '') + '}';
  }

  // Plain-language iPhone guide, shown in Settings → ASX prices and copied word for word into the README (the hygiene test checks they match).
  const SHEET_GUIDE = {
    title: 'Set up free ASX prices on your iPhone (about 5 minutes, one time only)',
    steps: [
      'In this app, go to Settings (the ⚙ button) and find "ASX prices". Tap "Copy formula".',
      'Open the Google Sheets app (free from the App Store) and sign in with your Google account.',
      'Tap the + button, then "New spreadsheet".',
      'Tap the top-left box (A1). Tap the long bar at the bottom of the screen, tap it again and choose "Paste". Then tap the tick (✓).',
      'Wait a few seconds. A small table appears with FANG, SEMI, IVV and their prices in A$.',
      'Tap the three dots (⋮) at the top right, then "Share & export", then "Manage access".',
      'Under "General access", change "Restricted" to "Anyone with the link" and check it says "Viewer". Go back.',
      'Tap "Copy link".',
      'Come back to this app: Settings → ASX prices. Paste the link into the "Google Sheet link" box and tap "Save and test". It should say "Saved. Found … ASX prices".',
      'Open Portfolio. Tap FANG, type how many units you own and the average price you paid per unit, and tap Save. Do the same for SEMI and IVV. You will now see the value and the gain or loss in A$.'
    ],
    byHand: [
      'If pasting doesn\u2019t work, type it in yourself instead, one box at a time:',
      'A1: Symbol',
      'B1: Price',
      'A2: FANG',
      'B2: =GOOGLEFINANCE("ASX:FANG","price")',
      'A3: SEMI',
      'B3: =GOOGLEFINANCE("ASX:SEMI","price")',
      'A4: IVV',
      'B4: =GOOGLEFINANCE("ASX:IVV","price")',
      'Then carry on from the "Share & export" step.'
    ],
    notes: [
      'Prices come from Google Finance and can be up to about 20 minutes behind. That is fine for checking value at the end of the day.',
      'The sheet only has ticker codes and prices in it. Your units and costs stay on your iPhone.',
      'Anyone you give the sheet link to can see those prices, nothing else.'
    ]
  };

  // Calendar date in New York (US earnings dates are exchange-local), plus or minus whole days.
  function usDate(ms, addDays = 0) {
    const t = ms + addDays * DAY;
    try { return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 10); } catch (e) { return new Date(t - 4 * HOUR).toISOString().slice(0, 10); }
  }

  /* ---------- backup + restore (one JSON file; API keys only if you tick "include keys") ---------- */
  const BACKUP_APP = 'stock-watchlist', BACKUP_VERSION = 1, BACKUP_REMIND_DAYS = 14;
  const readRaw = (storage, k) => { try { return JSON.parse(storage.getItem(k)); } catch (e) { return null; } };
  function memStore(obj) { const m = new Map(Object.entries(obj || {})); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; }
  function cleanSettings(raw) {
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, out = {};
    if (typeof s.demo === 'boolean') out.demo = s.demo;
    if ([0, 60, 120, 300].includes(s.refreshSec)) out.refreshSec = s.refreshSec;
    if (RANGE_ORDER.includes(s.range)) out.range = s.range;
    if (s.market === 'US' || s.market === 'ASX') out.market = s.market;
    if (isNum(s.msCap) && s.msCap >= 0) out.msCap = Math.min(100000, Math.round(s.msCap));
    if (typeof s.asxSheetUrl === 'string') { try { const n = normalizeSheetUrl(s.asxSheetUrl); out.asxSheetUrl = n ? s.asxSheetUrl.trim() : ''; } catch (e) { /* drop a bad link */ } }
    if (typeof s.includeKeysInBackup === 'boolean') out.includeKeysInBackup = s.includeKeysInBackup;
    return out;
  }
  function cleanKeys(raw) {
    const k = raw && typeof raw === 'object' ? raw : {}, ok = v => typeof v === 'string' && v.length <= 200 ? v.trim() : '';
    return { finnhub: ok(k.finnhub), twelvedata: ok(k.twelvedata), marketstack: ok(k.marketstack) };
  }
  // `current` (optional) is what the app holds in memory, used when something hasn't been saved yet (e.g. an untouched default list).
  function buildBackup(storage, { includeKeys = false, now = Date.now(), current = {} } = {}) {
    const pick = (key, mem) => { const v = readRaw(storage, key); return v != null ? v : mem != null ? JSON.parse(JSON.stringify(mem)) : null; };
    const data = {
      watchlists: { US: pick(KEYS.watchlist, current.US), ASX: pick(KEYS.watchlistAsx, current.ASX) },
      portfolio: pick(KEYS.portfolio, current.portfolio), alerts: pick(KEYS.alerts, current.alerts), settings: cleanSettings(readRaw(storage, KEYS.settings))
    };
    if (includeKeys) data.keys = cleanKeys(readRaw(storage, KEYS.apiKeys));
    return { app: BACKUP_APP, kind: 'backup', version: BACKUP_VERSION, createdAt: new Date(now).toISOString(), includesKeys: !!includeKeys, data };
  }
  const backupFileName = (now = Date.now()) => 'stock-watchlist-backup-' + isoDate(new Date(now)) + '.json';
  function backupSummary(d) {
    const wlN = w => (w && Array.isArray(w.symbols) ? w.symbols.length : 0), favN = w => (w && Array.isArray(w.favourites) ? w.favourites.length : 0);
    return { us: wlN(d.watchlists.US), asx: wlN(d.watchlists.ASX), favourites: favN(d.watchlists.US) + favN(d.watchlists.ASX),
      holdings: d.portfolio ? d.portfolio.holdings.length : 0, holdingsWithUnits: d.portfolio ? d.portfolio.holdings.filter(h => h.units > 0).length : 0,
      alertRules: d.alerts ? d.alerts.rules.length : 0, alertHistory: d.alerts ? d.alerts.history.length : 0,
      keys: d.keys ? ['finnhub', 'twelvedata', 'marketstack'].filter(k => d.keys[k]).length : 0, sheet: !!(d.settings && d.settings.asxSheetUrl) };
  }
  // What's on this device now, in the same shape (for the "this will replace" preview).
  function currentSummary(storage, current = {}) {
    const wlNow = (key, mem, norm) => (storage.getItem(key) == null && mem ? mem : loadWatchlist(storage, [], key, norm));
    const d = { watchlists: { US: wlNow(KEYS.watchlist, current.US, normalizeSymbol), ASX: wlNow(KEYS.watchlistAsx, current.ASX, normalizeAsx) },
      portfolio: loadPortfolio(storage), alerts: loadAlerts(storage), settings: cleanSettings(readRaw(storage, KEYS.settings)), keys: cleanKeys(readRaw(storage, KEYS.apiKeys)) };
    return backupSummary(d);
  }
  // Validates a backup file's text. Returns {createdAt, includesKeys, data (cleaned), summary}; throws an Error with a plain message.
  function parseBackup(text) {
    if (String(text).length > 5e6) throw new Error('That file is too big to be a Stock Watchlist backup.');
    let o; try { o = JSON.parse(text); } catch (e) { throw new Error('That file isn\u2019t valid JSON, so it can\u2019t be a backup.'); }
    if (!o || typeof o !== 'object') throw new Error('That file isn\u2019t a Stock Watchlist backup.');
    if (o.app !== BACKUP_APP || o.kind !== 'backup') throw new Error(o.app === 'gym-tracker' ? 'That\u2019s a Gym Tracker backup, not a Stock Watchlist one.' : 'That file isn\u2019t a Stock Watchlist backup.');
    if (!Number.isInteger(o.version) || o.version < 1) throw new Error('The backup has no valid version number.');
    if (o.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app. Update the app first (close and reopen it).');
    const d = o.data;
    if (!d || typeof d !== 'object' || !d.watchlists || typeof d.watchlists !== 'object') throw new Error('The backup is missing its watchlists.');
    const has = { US: !!(d.watchlists.US && Array.isArray(d.watchlists.US.symbols)), ASX: !!(d.watchlists.ASX && Array.isArray(d.watchlists.ASX.symbols)) };
    if (!has.US && !has.ASX) throw new Error('The backup has no watchlist data.');
    if (d.portfolio != null && !Array.isArray(d.portfolio.holdings)) throw new Error('The backup\u2019s portfolio is damaged.');
    if (d.alerts != null && !Array.isArray(d.alerts.rules)) throw new Error('The backup\u2019s alerts are damaged.');
    const tmp = memStore({ [KEYS.watchlist]: JSON.stringify(d.watchlists.US || null), [KEYS.watchlistAsx]: JSON.stringify(d.watchlists.ASX || null),
      [KEYS.portfolio]: JSON.stringify(d.portfolio || null), [KEYS.alerts]: JSON.stringify(d.alerts || null) });
    const data = {
      watchlists: { US: has.US ? loadWatchlist(tmp, [], KEYS.watchlist) : null, ASX: has.ASX ? loadWatchlist(tmp, [], KEYS.watchlistAsx, normalizeAsx) : null },
      portfolio: d.portfolio ? loadPortfolio(tmp) : null, alerts: d.alerts ? loadAlerts(tmp) : null, settings: cleanSettings(d.settings)
    };
    if (o.includesKeys && d.keys) data.keys = cleanKeys(d.keys);
    const createdAt = Date.parse(o.createdAt);
    return { createdAt: isFinite(createdAt) ? createdAt : null, includesKeys: !!data.keys, data, summary: backupSummary(data) };
  }
  // Restore. Keys are only touched when the backup has them; cached prices are left alone.
  // mode 'replace' (default): the backup's data replaces this device's. mode 'merge': nothing on this device is removed or overwritten;
  // tickers, favourites, holdings and alert rules that are only in the backup are added, and a seeded placeholder holding
  // (0 units, no cost) is filled in from the backup. Settings and keys only fill gaps (e.g. no Google Sheet link yet).
  // `current` (optional): in-memory lists that aren't saved yet (an untouched default list), same as buildBackup.
  function mergeWatchlist(cur, add) {
    if (!add) return cur; if (!cur) return add;
    const out = JSON.parse(JSON.stringify(cur)), have = new Set(out.symbols.map(x => x.symbol));
    for (const x of add.symbols) if (!have.has(x.symbol)) { have.add(x.symbol); out.symbols.push({ symbol: x.symbol, name: x.name || '' }); }
    for (const f of add.favourites || []) if (!out.favourites.includes(f)) out.favourites.push(f);
    return out;
  }
  function mergePortfolio(cur, add) {
    if (!add) return cur; if (!cur) return add;
    const out = JSON.parse(JSON.stringify(cur));
    for (const h of add.holdings) {
      const i = out.holdings.findIndex(x => x.id === h.id);
      if (i < 0) out.holdings.push(h);
      else if (!(out.holdings[i].units > 0) && out.holdings[i].avgCost == null) out.holdings[i] = h; // placeholder on this device: take the backup's
    }
    return out;
  }
  function mergeAlerts(cur, add) {
    if (!add) return cur; if (!cur) return add;
    const out = JSON.parse(JSON.stringify(cur)), sig = r => r.sym + '|' + r.type + '|' + r.value;
    const ids = new Set(out.rules.map(r => r.id)), sigs = new Set(out.rules.map(sig));
    for (const r of add.rules) if (!ids.has(r.id) && !sigs.has(sig(r))) { out.rules.push(r); ids.add(r.id); sigs.add(sig(r)); }
    const seen = new Set(out.history.map(h => JSON.stringify(h)));
    for (const h of add.history) if (!seen.has(JSON.stringify(h))) out.history.push(h);
    out.history.sort((a, b) => ((b && b.t) || 0) - ((a && a.t) || 0)); out.history = out.history.slice(0, 200);
    return out;
  }
  function applyBackup(storage, parsed, { mode = 'replace', current = {} } = {}) {
    const d = parsed.data, put = (k, v) => { if (v) storage.setItem(k, JSON.stringify(v)); };
    if (mode === 'merge') {
      const wlNow = (key, mem, norm) => (storage.getItem(key) == null ? (mem ? JSON.parse(JSON.stringify(mem)) : null) : loadWatchlist(storage, [], key, norm));
      put(KEYS.watchlist, mergeWatchlist(wlNow(KEYS.watchlist, current.US, normalizeSymbol), d.watchlists.US));
      put(KEYS.watchlistAsx, mergeWatchlist(wlNow(KEYS.watchlistAsx, current.ASX, normalizeAsx), d.watchlists.ASX));
      put(KEYS.portfolio, mergePortfolio(storage.getItem(KEYS.portfolio) == null ? (current.portfolio || null) : loadPortfolio(storage), d.portfolio));
      put(KEYS.alerts, mergeAlerts(storage.getItem(KEYS.alerts) == null ? (current.alerts || null) : loadAlerts(storage), d.alerts));
      const s = cleanSettings(readRaw(storage, KEYS.settings));
      if (!s.asxSheetUrl && d.settings.asxSheetUrl) s.asxSheetUrl = d.settings.asxSheetUrl;
      storage.setItem(KEYS.settings, JSON.stringify(s));
      if (d.keys) { const k = cleanKeys(readRaw(storage, KEYS.apiKeys)); for (const n of Object.keys(k)) if (!k[n] && d.keys[n]) k[n] = d.keys[n]; storage.setItem(KEYS.apiKeys, JSON.stringify(k)); }
      return;
    }
    put(KEYS.watchlist, d.watchlists.US); put(KEYS.watchlistAsx, d.watchlists.ASX); put(KEYS.portfolio, d.portfolio); put(KEYS.alerts, d.alerts);
    storage.setItem(KEYS.settings, JSON.stringify(Object.assign(cleanSettings(readRaw(storage, KEYS.settings)), d.settings)));
    if (d.keys) storage.setItem(KEYS.apiKeys, JSON.stringify(d.keys));
  }
  // Backup bookkeeping: {lastAt, firstSeenAt, snoozeUntil}. The reminder is due 14 days after the last backup (or after first use).
  function loadBackupMeta(storage, now = Date.now()) {
    const m = readRaw(storage, KEYS.backup) || {};
    const out = { lastAt: isNum(m.lastAt) ? m.lastAt : null, firstSeenAt: isNum(m.firstSeenAt) ? m.firstSeenAt : now, snoozeUntil: isNum(m.snoozeUntil) ? m.snoozeUntil : 0 };
    if (!isNum(m.firstSeenAt)) storage.setItem(KEYS.backup, JSON.stringify(out));
    return out;
  }
  function saveBackupMeta(storage, m) { storage.setItem(KEYS.backup, JSON.stringify(m)); }
  function backupReminder(meta, now = Date.now(), days = BACKUP_REMIND_DAYS) {
    const since = meta.lastAt || meta.firstSeenAt || now, daysSince = Math.floor((now - since) / DAY);
    return { due: daysSince >= days && now >= (meta.snoozeUntil || 0), daysSince, never: !meta.lastAt };
  }

  // Display helper: undefined = provider never sends the field (free tier), null = sent but empty.
  function show(v, fmt) { if (v === undefined) return NA_FREE; if (v === null || (typeof v === 'number' && !isFinite(v))) return NA_NONE; return fmt(v); }

  const api = { NA_FREE, NA_NONE, KEYS, CACHE_PREFIX, TTL, DATASETS, RANGES, RANGE_ORDER, MIN, HOUR, DAY,
    fmtPrice, fmtChange, fmtPct, fmtBig, fmtVolume, fmtRatio, fmtPercentValue, fmtBarTime, fmtAsOf, direction, isoDate, isNum, toNum,
    normalizeSymbol, sortRows, searchRows, defaultWatchlist, addSymbol, removeSymbol, toggleFavourite, setName, loadWatchlist, saveWatchlist,
    createCache, waitTime, parseFinnhubQuote, parseFinnhubProfile, parseFinnhubMetrics, latestRecommendation, consensus, nextEarnings,
    parseFinnhubPriceTarget, parseTwelveSeries, sliceRange, rangeChange, sessionVolume, sparkPath, marketCap, classifyError, show,
    fmtSignedMoney, normalizeAsx, makeId, parseId, SEED_PORTFOLIO, defaultPortfolio, loadPortfolio, savePortfolio, addHolding, updateHolding, removeHolding, portfolioSummary,
    ALERT_TYPES, emptyAlerts, loadAlerts, saveAlerts, addAlertRule, removeAlertRule, evaluateAlerts, alertMessage, unseenAlerts,
    topMovers, parseEarningsCalendar, upcomingEarnings, groupByDate, HOUR_LABEL, safeUrl, parseNews, fmtAgo,
    parseMarketstackEod, eodQuote, parseTwelveRate, parseFrankfurter, monthKey, usDate, asxTtl,
    SHEET_HEADER, SHEET_GUIDE, normalizeSheetUrl, parseCsv, sheetNum, sydneyToUtc, parseSheetQuotes, sheetFormula,
    BACKUP_APP, BACKUP_VERSION, BACKUP_REMIND_DAYS, buildBackup, backupFileName, backupSummary, currentSummary, parseBackup, applyBackup, mergeWatchlist, mergePortfolio, mergeAlerts, loadBackupMeta, saveBackupMeta, backupReminder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SWL = api;
})(typeof self !== 'undefined' ? self : this);
