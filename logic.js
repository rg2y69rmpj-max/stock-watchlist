/* Pure logic, no DOM. Works in the browser (window.SWL) and in Node (module.exports). */
(function (root) {
  'use strict';
  const NA_FREE = 'n/a (not on free tier)';
  const NA_NONE = 'n/a (not reported)';
  const KEYS = { watchlist: 'stockwatch.watchlist.v1', settings: 'stockwatch.settings.v1', apiKeys: 'stockwatch.keys.v1', usage: 'stockwatch.usage.v1' };
  const CACHE_PREFIX = 'stockwatch.cache.';
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const TTL = { quote: MIN, profile: 7 * DAY, metrics: 12 * HOUR, recommendation: 12 * HOUR, earnings: 12 * HOUR, priceTarget: 12 * HOUR, spark: 12 * HOUR,
    i5: 5 * MIN, i30: 30 * MIN, d1y: 6 * HOUR, w5y: DAY };

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
  function fmtPrice(n) {
    if (!isNum(n)) return '—';
    const d = Math.abs(n) < 1 ? 4 : 2;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
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
  function addSymbol(wl, sym, name) {
    const s = normalizeSymbol(sym); if (!s) throw new Error('Invalid ticker: use letters, digits or a dot, e.g. AAPL or BRK.B');
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
  function loadWatchlist(storage, defaults) {
    let raw = null; try { raw = JSON.parse(storage.getItem(KEYS.watchlist)); } catch (e) { raw = null; }
    if (!raw || !Array.isArray(raw.symbols)) return defaultWatchlist(defaults);
    const wl = defaultWatchlist([]);
    const seen = new Set();
    for (const x of raw.symbols) { const s = normalizeSymbol(x && x.symbol); if (s && !seen.has(s)) { seen.add(s); wl.symbols.push({ symbol: s, name: String(x.name || '') }); } }
    wl.favourites = (Array.isArray(raw.favourites) ? raw.favourites : []).filter(s => seen.has(s));
    if (raw.sort && ['symbol', 'changePct', 'price', 'marketCap'].includes(raw.sort.key)) wl.sort = { key: raw.sort.key, dir: raw.sort.dir === 'asc' ? 'asc' : 'desc' };
    wl.favouritesFirst = !!raw.favouritesFirst;
    return wl;
  }
  function saveWatchlist(storage, wl) { storage.setItem(KEYS.watchlist, JSON.stringify(wl)); }

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
  function classifyError(provider, status, body) {
    const msg = String((body && (body.error || body.message)) || (typeof body === 'string' ? body : '') || '');
    const code = body && body.code;
    if (status === 429 || code === 429 || /limit|credits/i.test(msg) && !/access/i.test(msg)) {
      const daily = /day|daily/i.test(msg);
      return { type: 'rate-limit', daily, message: provider === 'twelvedata'
        ? 'Twelve Data free limit reached (8 credits/min, 800/day)' + (daily ? ' for today.' : '. Waiting for the next minute.')
        : 'Finnhub free limit reached (60 calls/min). Waiting a minute.' };
    }
    if (status === 401 || code === 401 || /invalid api key|api key|apikey/i.test(msg) && !/access/i.test(msg)) return { type: 'auth', message: (provider === 'twelvedata' ? 'Twelve Data' : 'Finnhub') + ' rejected the API key. Check it in Settings.' };
    if (status === 403 || code === 403 || /access|premium|subscription|plan/i.test(msg)) return { type: 'premium', message: NA_FREE };
    if (status === 404 || code === 404 || code === 400) return { type: 'not-found', message: msg || 'Symbol not found' };
    if (status === 0) return { type: 'network', message: 'Network error. Showing cached data if available.' };
    return { type: 'other', message: msg || ('HTTP ' + status) };
  }
  // Display helper: undefined = provider never sends the field (free tier), null = sent but empty.
  function show(v, fmt) { if (v === undefined) return NA_FREE; if (v === null || (typeof v === 'number' && !isFinite(v))) return NA_NONE; return fmt(v); }

  const api = { NA_FREE, NA_NONE, KEYS, CACHE_PREFIX, TTL, DATASETS, RANGES, RANGE_ORDER, MIN, HOUR, DAY,
    fmtPrice, fmtChange, fmtPct, fmtBig, fmtVolume, fmtRatio, fmtPercentValue, fmtBarTime, fmtAsOf, direction, isoDate, isNum, toNum,
    normalizeSymbol, sortRows, searchRows, defaultWatchlist, addSymbol, removeSymbol, toggleFavourite, setName, loadWatchlist, saveWatchlist,
    createCache, waitTime, parseFinnhubQuote, parseFinnhubProfile, parseFinnhubMetrics, latestRecommendation, consensus, nextEarnings,
    parseFinnhubPriceTarget, parseTwelveSeries, sliceRange, rangeChange, sessionVolume, sparkPath, marketCap, classifyError, show };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SWL = api;
})(typeof self !== 'undefined' ? self : this);
