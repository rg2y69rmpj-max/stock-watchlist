/* Data layer: Finnhub (US quotes, profile, metrics, ratings, earnings, news), Twelve Data (price history, live USD/AUD),
   your own Google Sheet (ASX prices via GOOGLEFINANCE, no key), Marketstack (optional: ASX end-of-day closes and 1-year charts, monthly budget)
   and Frankfurter (ECB daily USD/AUD fallback, no key).
   Keys come from getKeys() at call time; they're never cached, logged or put in error messages.
   Works in the browser (window.SWAPI) and in Node for tests (inject fetch/storage/clock). */
(function (root) {
  'use strict';
  const L = root.SWL || (typeof require !== 'undefined' ? require('./logic.js') : null);
  const FH = 'https://finnhub.io/api/v1', TD = 'https://api.twelvedata.com', MS = 'https://api.marketstack.com/v2', FR = 'https://api.frankfurter.dev/v1';
  const LIMITS = {
    finnhub: { max: 55, windowMs: 60e3, minGapMs: 120 },
    twelvedata: { max: 8, windowMs: 60e3, minGapMs: 0, daily: 800 },
    marketstack: { max: 4, windowMs: 1000, minGapMs: 250, monthly: 100 }, // free: 100 requests/month, 5/second
    frankfurter: { max: 10, windowMs: 60e3, minGapMs: 0 }, // no published limit; we cache for 6 h anyway
    sheet: { max: 6, windowMs: 60e3, minGapMs: 1000 } // Google re-publishes about every 5 min; one request covers every ASX ticker
  };
  const MS_CHUNK = 25; // symbols per Marketstack call (each symbol is counted against the monthly budget)
  const SPARK_CHUNK = 6; // leaves 2 Twelve Data credits a minute for a chart you open while sparklines load

  function apiError(info, extra) { return Object.assign(new Error(info.message), info, extra || {}); }

  // Fetch + parse a Google Sheet CSV (shared or published link). Used by the data source and by Settings → Test link.
  async function fetchSheet(fetchFn, rawUrl) {
    let n; try { n = L.normalizeSheetUrl(rawUrl); } catch (e) { throw apiError({ type: 'sheet', provider: 'sheet', message: e.message }); }
    if (!n) throw apiError({ type: 'nokey', provider: 'sheet', message: 'Add your Google Sheet link in Settings to see ASX prices.' });
    let res;
    try { res = await fetchFn(n.url); } catch (e) { throw apiError({ type: 'network', provider: 'sheet', message: 'Couldn\u2019t reach Google Sheets. Check your connection, and that the sheet is shared (Anyone with the link) or published.' }); }
    const text = res.text ? await res.text().catch(() => '') : '';
    if (!res.ok) {
      const msg = [400, 401, 403, 404].includes(res.status) ? `Google Sheets refused the link (HTTP ${res.status}). Share the sheet as \u201cAnyone with the link: Viewer\u201d, or use File \u2192 Share \u2192 Publish to web \u2192 CSV.` : 'Google Sheets error (HTTP ' + res.status + ').';
      throw apiError({ type: res.status === 429 ? 'rate-limit' : 'sheet', provider: 'sheet', status: res.status, message: msg });
    }
    try { return Object.assign(L.parseSheetQuotes(text), { kind: n.kind }); } catch (e) { throw apiError({ type: 'sheet', provider: 'sheet', message: e.message }); }
  }

  // persist: optional {storage, key} so the last minute of calls survives an app relaunch (iOS kills PWAs often).
  function createLimiter(cfg, now, sleep, persist) {
    const queue = []; let running = false, pausedUntil = 0, seq = 0, history = [];
    if (persist) { try { const h = JSON.parse(persist.storage.getItem(persist.key)); if (h && Array.isArray(h.h)) { history = h.h.filter(x => now() - x.t < cfg.windowMs); pausedUntil = +h.p || 0; } } catch (e) { history = []; } }
    const save = () => { if (persist) try { persist.storage.setItem(persist.key, JSON.stringify({ h: history, p: pausedUntil })); } catch (e) { /* storage full */ } };
    async function pump() {
      if (running) return; running = true;
      try {
        while (queue.length) {
          const t = now();
          const wait = Math.max(pausedUntil - t, L.waitTime(history, t, cfg, queue[0].cost));
          if (wait > 0) { await sleep(Math.min(wait, 1000)); continue; } // re-check often so urgent jobs can jump ahead
          const job = queue.shift();
          history.push({ t: now(), cost: job.cost });
          while (history.length && now() - history[0].t > cfg.windowMs) history.shift();
          save();
          let run; try { run = Promise.resolve(job.fn()); } catch (e) { run = Promise.reject(e); } // start now, at the time we recorded
          run.then(job.resolve, job.reject);
        }
      } finally { running = false; }
    }
    return {
      schedule(fn, { cost = 1, prio = 5, view = null } = {}) {
        return new Promise((resolve, reject) => {
          queue.push({ fn, cost, prio, view, resolve, reject, seq: seq++ });
          queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq); pump();
        });
      },
      pause(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); save(); },
      pausedFor() { return Math.max(0, pausedUntil - now()); },
      usedLastMinute() { const t = now(); return history.filter(h => t - h.t < cfg.windowMs).reduce((s, h) => s + h.cost, 0); },
      pending() { return queue.length; },
      // Drop queued (not yet sent) jobs that belong to a screen the user has left. Untagged jobs (alerts, FX) are kept.
      dropExcept(view) {
        let n = 0;
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].view && queue[i].view !== view) { queue.splice(i, 1)[0].reject(apiError({ type: 'cancelled', message: 'cancelled' })); n++; }
        return n;
      },
      clear() { queue.splice(0).forEach(j => j.reject(apiError({ type: 'cancelled', message: 'cancelled' }))); }
    };
  }

  function createDataSource(opts) {
    const storage = opts.storage, fetchFn = opts.fetch, now = opts.now || (() => Date.now());
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const getKeys = opts.getKeys || (() => ({})), emit = opts.onEvent || (() => {});
    const cache = L.createCache(storage, now);
    const fh = createLimiter(LIMITS.finnhub, now, sleep, { storage, key: 'stockwatch.rate.finnhub' });
    const td = createLimiter(LIMITS.twelvedata, now, sleep, { storage, key: 'stockwatch.rate.twelvedata' });
    const ms = createLimiter(LIMITS.marketstack, now, sleep), fr = createLimiter(LIMITS.frankfurter, now, sleep), sh = createLimiter(LIMITS.sheet, now, sleep);
    const sheetNorm = () => { try { return L.normalizeSheetUrl(opts.getSheetUrl ? opts.getSheetUrl() : ''); } catch (e) { return null; } };
    const sheetSet = () => !!sheetNorm();
    const sheetKey = () => { let h = 2166136261; for (const c of (sheetNorm() || { url: '' }).url) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return 'sheet:' + (h >>> 0).toString(36); }; // a new link never shows the old sheet's prices
    const msCap = () => { const c = Number(opts.marketstackCap ? opts.marketstackCap() : LIMITS.marketstack.monthly); return isFinite(c) && c >= 0 ? Math.min(c, 100000) : LIMITS.marketstack.monthly; };
    const inflight = new Map(), sparkPending = new Set();
    const qs = p => Object.keys(p).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
    const utcDay = () => new Date(now()).toISOString().slice(0, 10);

    function usage() { let u = null; try { u = JSON.parse(storage.getItem(L.KEYS.usage)); } catch (e) { u = null; } return u && u.day === utcDay() ? u : { day: utcDay(), td: 0, fh: 0, fr: 0, sh: 0 }; }
    function bump(field, n) { const u = usage(); u[field] = (u[field] || 0) + n; try { storage.setItem(L.KEYS.usage, JSON.stringify(u)); } catch (e) { /* full */ } }
    // Marketstack budget per calendar month (UTC), counted on this device. Your account quota resets on your billing date.
    function monthUsage() { let u = null; try { u = JSON.parse(storage.getItem(L.KEYS.usageMonth)); } catch (e) { u = null; } const m = L.monthKey(now()); return u && u.month === m ? u : { month: m, ms: 0 }; }
    function bumpMonth(n) { const u = monthUsage(); u.ms += n; try { storage.setItem(L.KEYS.usageMonth, JSON.stringify(u)); } catch (e) { /* full */ } }
    const msBudget = () => { const used = monthUsage().ms, cap = msCap(); return { used, cap, left: Math.max(0, cap - used), month: monthUsage().month }; };

    async function readBody(res) { try { return await res.json(); } catch (e) { return null; } }

    function fhGet(path, params, prio, view) {
      const key = (getKeys().finnhub || '').trim();
      if (!key) return Promise.reject(apiError({ type: 'nokey', provider: 'finnhub', message: 'Add a Finnhub API key in Settings.' }));
      return fh.schedule(async () => {
        let res;
        try { res = await fetchFn(FH + path + '?' + qs(params) + '&token=' + encodeURIComponent(key)); }
        catch (e) { throw apiError(L.classifyError('finnhub', 0, null)); }
        bump('fh', 1);
        const body = await readBody(res);
        if (!res.ok || (body && body.error)) {
          const info = L.classifyError('finnhub', res.status, body);
          if (info.type === 'rate-limit') { fh.pause(60e3); emit('limit', { provider: 'finnhub', message: info.message }); }
          if (info.type === 'auth') emit('auth', { provider: 'finnhub', message: info.message });
          throw apiError(info, { provider: 'finnhub', status: res.status });
        }
        return body;
      }, { prio, view });
    }

    function tdGet(path, params, cost, prio, view) {
      const key = (getKeys().twelvedata || '').trim();
      if (!key) return Promise.reject(apiError({ type: 'nokey', provider: 'twelvedata', message: 'Add a free Twelve Data key in Settings to see charts.' }));
      return td.schedule(async () => {
        if (usage().td + cost > LIMITS.twelvedata.daily) {
          const info = L.classifyError('twelvedata', 429, { message: 'daily credits used' });
          emit('limit', { provider: 'twelvedata', message: info.message }); throw apiError(info, { provider: 'twelvedata' });
        }
        let res;
        try { res = await fetchFn(TD + path + '?' + qs(params), { headers: { Authorization: 'apikey ' + key } }); } // header auth keeps the key out of URLs and caches
        catch (e) { throw apiError(L.classifyError('twelvedata', 0, null)); }
        bump('td', cost);
        const body = await readBody(res);
        if (!res.ok || (body && body.status === 'error' && body.code)) {
          const info = L.classifyError('twelvedata', res.status, body);
          if (info.type === 'rate-limit') {
            if (info.daily) bump('td', LIMITS.twelvedata.daily); else td.pause(61e3 - (now() % 60e3));
            emit('limit', { provider: 'twelvedata', message: info.message });
          }
          if (info.type === 'auth') emit('auth', { provider: 'twelvedata', message: info.message });
          throw apiError(info, { provider: 'twelvedata', status: res.status });
        }
        return body;
      }, { cost, prio, view });
    }

    function msGet(path, params, cost, prio, view) {
      const key = (getKeys().marketstack || '').trim();
      if (!key) return Promise.reject(apiError({ type: 'nokey', provider: 'marketstack', message: 'ASX prices need a free Marketstack key (end-of-day closes). Add one in Settings.' }));
      const pre = msBudget();
      if (pre.used + cost > pre.cap) return Promise.reject(apiError({ type: 'budget', provider: 'marketstack', message: `Marketstack budget for this month is used (${pre.used}/${pre.cap} requests). ASX prices stay as last loaded.` }));
      return ms.schedule(async () => {
        const b = msBudget();
        if (b.used + cost > b.cap) throw apiError({ type: 'budget', provider: 'marketstack', message: `Marketstack budget for this month is used (${b.used}/${b.cap} requests).` });
        let res;
        try { res = await fetchFn(MS + path + '?' + qs(params) + '&access_key=' + encodeURIComponent(key)); } // Marketstack only accepts the key as a query parameter
        catch (e) { throw apiError(L.classifyError('marketstack', 0, null)); }
        bumpMonth(cost);
        const body = await readBody(res);
        if (!res.ok || (body && body.error)) {
          const info = L.classifyError('marketstack', res.status, body);
          if (info.type === 'rate-limit') { if (info.monthly) bumpMonth(b.cap); else ms.pause(2000); emit('limit', { provider: 'marketstack', message: info.message }); }
          if (info.type === 'auth') emit('auth', { provider: 'marketstack', message: info.message });
          throw apiError(info, { provider: 'marketstack', status: res.status });
        }
        return body;
      }, { cost, prio, view });
    }

    function frGet(path, params) {
      return fr.schedule(async () => {
        let res;
        try { res = await fetchFn(FR + path + '?' + qs(params)); } catch (e) { throw apiError(L.classifyError('frankfurter', 0, null)); }
        bump('fr', 1);
        const body = await readBody(res);
        if (!res.ok || !body) throw apiError(L.classifyError('frankfurter', res.status, body), { provider: 'frankfurter' });
        return body;
      }, { prio: 3 });
    }

    function sheetGet(prio, view) {
      return sh.schedule(async () => {
        bump('sh', 1);
        try { return await fetchSheet(fetchFn, opts.getSheetUrl ? opts.getSheetUrl() : ''); }
        catch (e) { if (e.type === 'rate-limit') { sh.pause(60e3); emit('limit', { provider: 'sheet', message: 'Google Sheets is busy (HTTP 429). Waiting a minute.' }); } throw e; }
      }, { prio, view });
    }

    // Fresh cache -> return it. Otherwise fetch; on failure fall back to stale cache (flagged) or throw.
    // Premium-only responses are cached as {unavailable:'premium'} so we don't keep spending calls on them.
    function cached(key, ttl, loader, o = {}) {
      const e = cache.entry(key);
      if (e && e.fresh && !o.force) return Promise.resolve({ value: e.value, savedAt: e.savedAt, fresh: true });
      if (inflight.has(key)) return inflight.get(key);
      const p = loader().then(v => { cache.set(key, v, typeof ttl === 'function' ? ttl(v) : ttl); return { value: v, savedAt: now(), fresh: true }; })
        .catch(err => {
          if (err.type === 'premium') { const v = { unavailable: 'premium' }; cache.set(key, v, typeof ttl === 'function' ? L.HOUR * 12 : ttl); return { value: v, savedAt: now(), fresh: true }; }
          if (e) return { value: e.value, savedAt: e.savedAt, fresh: false, error: err };
          throw err;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p); return p;
    }
    const peek = key => { const e = cache.entry(key); return e ? e.value : null; };

    const daysAgo = n => L.isoDate(new Date(now() - n * L.DAY));
    const api = {
      demo: false,
      quote: (s, o = {}) => cached('q:' + s, L.TTL.quote, () => fhGet('/quote', { symbol: s }, o.prio ?? 3, o.view).then(j => L.parseFinnhubQuote(j) || { notFound: true }), o),
      profile: (s, o = {}) => cached('p:' + s, L.TTL.profile, () => fhGet('/stock/profile2', { symbol: s }, o.prio ?? 6, o.view).then(j => L.parseFinnhubProfile(j) || { notFound: true }), o),
      metrics: (s, o = {}) => cached('m:' + s, L.TTL.metrics, () => fhGet('/stock/metric', { symbol: s, metric: 'all' }, o.prio ?? 1, o.view).then(L.parseFinnhubMetrics), o),
      recommendation: (s, o = {}) => cached('r:' + s, L.TTL.recommendation, () => fhGet('/stock/recommendation', { symbol: s }, o.prio ?? 1, o.view).then(j => L.latestRecommendation(j) || { none: true }), o),
      earnings: (s, o = {}) => {
        const from = new Date(now()), to = new Date(now() + 200 * L.DAY);
        return cached('e:' + s, L.TTL.earnings, () => fhGet('/calendar/earnings', { from: L.isoDate(from), to: L.isoDate(to), symbol: s }, o.prio ?? 2, o.view)
          .then(j => L.nextEarnings(j, L.isoDate(from)) || { none: true }), o);
      },
      // Premium on Finnhub's free tier: the first call returns 403, which is cached for 12 h and shown as "n/a (not on free tier)".
      priceTarget: (s, o = {}) => cached('pt:' + s, L.TTL.priceTarget, () => fhGet('/stock/price-target', { symbol: s }, o.prio ?? 2, o.view).then(j => L.parseFinnhubPriceTarget(j) || { none: true }), o),
      // Company news, last 7 days (Finnhub free covers North American companies). One call per ticker, cached 30 min.
      news: (s, o = {}) => cached('n:' + s, L.TTL.news, () => fhGet('/company-news', { symbol: s, from: L.usDate(now(), -7), to: L.usDate(now()) }, o.prio ?? 2, o.view).then(j => L.parseNews(j)), o),
      // Whole-market earnings calendar for the next 14 days: one call, cached 6 h, trimmed to the fields we show. Filtered on the device.
      earningsCalendar: (o = {}) => cached('ec:' + L.usDate(now()), L.TTL.earningsCal, () => fhGet('/calendar/earnings', { from: L.usDate(now()), to: L.usDate(now(), 14) }, o.prio ?? 2, o.view)
        .then(j => L.parseEarningsCalendar(j).map(e => ({ symbol: e.symbol, date: e.date, hour: e.hour, epsEstimate: e.epsEstimate })) ), o),
      candles(s, range, o = {}) {
        const ds = L.RANGES[range].dataset, cfg = L.DATASETS[ds];
        return cached('c:' + ds + ':' + s, L.TTL[ds], () => tdGet('/time_series', { symbol: s, interval: cfg.interval, outputsize: cfg.outputsize }, 1, o.prio ?? 0, o.view).then(j => {
          const bars = L.parseTwelveSeries(j, [s])[s];
          if (bars.error) throw apiError(L.classifyError('twelvedata', 200, { message: bars.error, code: bars.code }));
          if (ds === 'd1y') cache.set('s:' + s, bars.slice(-22).map(b => b.c), L.TTL.spark); // reuse for the sparkline
          return bars;
        }), o);
      },
      /* ----- ASX (Marketstack end-of-day). Every symbol counts against the monthly budget, so nothing here runs on a timer by itself,
         and closes stay cached until the next ASX close is out (see L.asxTtl): at most one request per ticker per trading day. ----- */
      // Where ASX prices come from: your Google Sheet if its link is set, else Marketstack if its key is set.
      asxMode: () => (sheetSet() ? 'sheet' : (getKeys().marketstack || '').trim() ? 'marketstack' : 'none'),
      // Google Sheet: one request returns every ticker in the sheet (cached 5 min). Tickers that aren't in the sheet are marked notInSheet.
      sheetQuotes(o = {}) {
        return cached(sheetKey(), L.TTL.sheet, () => sheetGet(o.prio ?? 3, o.view).then(r => {
          for (const c of Object.keys(r.quotes)) cache.set('aq:' + c, r.quotes[c], L.TTL.sheet);
          for (const c of r.skipped) cache.set('aq:' + c, { notFound: true, sheetBlank: true }, L.TTL.sheet);
          return { codes: Object.keys(r.quotes), skipped: r.skipped, kind: r.kind };
        }), o);
      },
      asxCost(codes, o = {}) { return sheetSet() ? 0 : codes.filter(c => o.force || !cache.get('aq:' + c)).length; },
      asxQuotes(codes, o = {}) {
        if (sheetSet()) {
          return api.sheetQuotes(o).then(r => {
            const got = new Set(r.value.codes.concat(r.value.skipped));
            for (const c of new Set(codes)) if (!got.has(c)) cache.set('aq:' + c, { notFound: true, notInSheet: true }, L.TTL.sheet);
            if (o.onUpdate) o.onUpdate(codes);
            return { requested: 0, sheet: true, fresh: r.fresh !== false, error: r.error || null, missing: codes.filter(c => !got.has(c)) };
          });
        }
        const todo = [...new Set(codes)].filter(c => o.force || !cache.get('aq:' + c));
        if (!todo.length) return Promise.resolve({ requested: 0 });
        const jobs = [];
        for (let i = 0; i < todo.length; i += MS_CHUNK) {
          const chunk = todo.slice(i, i + MS_CHUNK);
          jobs.push(msGet('/eod', { symbols: chunk.map(c => c + '.AX').join(','), date_from: daysAgo(10), limit: 1000 }, chunk.length, o.prio ?? 3, o.view).then(j => {
            const parsed = L.parseMarketstackEod(j);
            for (const c of chunk) cache.set('aq:' + c, parsed[c] && parsed[c].length ? L.eodQuote(parsed[c]) : { notFound: true }, L.asxTtl(now()));
            if (o.onUpdate) o.onUpdate(chunk);
          }));
        }
        return Promise.all(jobs).then(() => ({ requested: todo.length }));
      },
      asxHistory(code, o = {}) {
        return cached('ah:' + code, () => L.asxTtl(now()), () => msGet('/eod', { symbols: code + '.AX', date_from: daysAgo(366), limit: 400 }, 1, o.prio ?? 0, o.view).then(j => {
          const bars = L.parseMarketstackEod(j)[code] || [];
          if (!sheetSet()) cache.set('aq:' + code, bars.length ? L.eodQuote(bars) : { notFound: true }, L.asxTtl(now())); // the sheet's price is fresher
          return bars;
        }), o);
      },
      peekAsxQuote: c => peek('aq:' + c), peekAsxHistory: c => peek('ah:' + c),
      asxBudget: () => msBudget(),
      // USD -> AUD. Live from Twelve Data when that key is set (1 credit, cached 10 min); otherwise, or if it fails, the ECB daily reference rate from Frankfurter.
      fx(o = {}) {
        const frank = () => frGet('/latest', { base: 'USD', symbols: 'AUD' }).then(j => {
          const r = L.parseFrankfurter(j); if (!r) throw apiError({ type: 'other', message: 'No USD/AUD rate' });
          return { rate: r.rate, date: r.date, live: false, source: 'ECB reference rate (Frankfurter)' };
        });
        const loader = () => (getKeys().twelvedata || '').trim()
          ? tdGet('/exchange_rate', { symbol: 'USD/AUD' }, 1, o.prio ?? 3).then(j => { const r = L.parseTwelveRate(j); if (!r) throw apiError({ type: 'other', message: 'No rate' }); return { rate: r.rate, t: r.t || now(), live: true, source: 'Twelve Data' }; })
            .catch(e => { if (e.type === 'cancelled') throw e; return frank(); })
          : frank();
        return cached('fx:USDAUD', v => v.live ? L.TTL.fxLive : L.TTL.fxDaily, loader, o);
      },
      peekFx: () => peek('fx:USDAUD'),
      peekCandles: (s, ds) => peek('c:' + ds + ':' + s),
      peekQuote: s => peek('q:' + s), peekProfile: s => peek('p:' + s), peekSpark: s => peek('s:' + s),
      // Sparklines: Twelve Data batch requests (one HTTP call for up to SPARK_CHUNK symbols; each symbol costs 1 credit).
      sparklines(symbols, onUpdate, view) {
        if (!(getKeys().twelvedata || '').trim()) return Promise.resolve(0);
        const todo = symbols.filter(s => !cache.get('s:' + s) && !sparkPending.has(s));
        const jobs = [];
        for (let i = 0; i < todo.length; i += SPARK_CHUNK) {
          const chunk = todo.slice(i, i + SPARK_CHUNK); chunk.forEach(s => sparkPending.add(s));
          jobs.push(tdGet('/time_series', { symbol: chunk.join(','), interval: L.DATASETS.spark.interval, outputsize: L.DATASETS.spark.outputsize }, chunk.length, 8, view)
            .then(j => {
              const parsed = L.parseTwelveSeries(j, chunk);
              for (const s of chunk) {
                const b = parsed[s];
                cache.set('s:' + s, b.error ? [] : b.map(x => x.c), b.error ? L.HOUR : L.TTL.spark);
                if (onUpdate) onUpdate(s);
              }
            })
            .catch(err => { if (err.type === 'premium' || err.type === 'not-found') chunk.forEach(s => cache.set('s:' + s, [], L.HOUR)); })
            .finally(() => chunk.forEach(s => sparkPending.delete(s))));
        }
        return Promise.all(jobs).then(() => todo.length);
      },
      usage: () => ({ fhLastMinute: fh.usedLastMinute(), fhPending: fh.pending(), fhPausedMs: fh.pausedFor(), tdLastMinute: td.usedLastMinute(), tdPending: td.pending(),
        tdToday: usage().td, fhToday: usage().fh, frToday: usage().fr || 0, shToday: usage().sh || 0, msPending: ms.pending(), ms: msBudget(), pending: fh.pending() + td.pending() + ms.pending() + fr.pending() + sh.pending(), limits: LIMITS }),
      focus: view => fh.dropExcept(view) + td.dropExcept(view) + ms.dropExcept(view) + sh.dropExcept(view),
      clearCache: () => cache.clear(),
      prune: () => cache.prune(),
      cancelAll() { fh.clear(); td.clear(); ms.clear(); fr.clear(); sh.clear(); sparkPending.clear(); }
    };
    return api;
  }

  /* ---------- DEMO source: synthetic, deterministic numbers. Every screen shows a DEMO badge when this is active. ---------- */
  function createDemoSource(opts = {}) {
    const now = opts.now || (() => Date.now()), names = opts.names || {}, caps = opts.caps || {};
    const memo = new Map();
    const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
    const rng = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const p2 = n => String(n).padStart(2, '0');
    const ds = d => d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
    function build(s) {
      if (memo.has(s)) return memo.get(s);
      const r = rng(hash(s)), gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const days = []; const d = new Date(now()); d.setUTCHours(0, 0, 0, 0);
      while (days.length < 1300) { const wd = d.getUTCDay(); if (wd && wd < 6) days.unshift(ds(d)); d.setUTCDate(d.getUTCDate() - 1); }
      const vol = 0.012 + r() * 0.012, drift = (r() - 0.35) * 0.0012; let p = 100;
      const closes = days.map(() => (p *= Math.exp(drift + vol * gauss())));
      const target = 30 + r() * 600, k = target / closes[closes.length - 1];
      const daily = days.map((dd, i) => ({ d: dd, c: +(closes[i] * k).toFixed(2), v: Math.round(5e6 + r() * 6e7) }));
      const intraday = (n, step, sessions) => {
        const out = [];
        for (let si = sessions; si >= 1; si--) {
          const day = daily[daily.length - si], prev = daily[daily.length - si - 1].c; let x = prev;
          for (let i = 0; i < n; i++) {
            const m = 570 + i * step, t = day.d + ' ' + p2(Math.floor(m / 60)) + ':' + p2(m % 60) + ':00';
            x = i === n - 1 ? day.c : x + (day.c - x) / (n - i) + gauss() * prev * vol / Math.sqrt(n) * 0.8;
            out.push({ d: t, c: +x.toFixed(2), v: Math.round(day.v / n * (0.5 + r())) });
          }
        }
        return out;
      };
      const last = daily[daily.length - 1], prev = daily[daily.length - 2], y = daily.slice(-252).map(b => b.c);
      const pe = 12 + r() * 40, sharesM = caps[s] ? caps[s] / last.c / 1e6 : 500 + r() * 8000;
      const today = new Date(now()); const ed = new Date(today.getTime() + (8 + Math.floor(r() * 70)) * 864e5); while (ed.getUTCDay() === 0 || ed.getUTCDay() === 6) ed.setUTCDate(ed.getUTCDate() + 1);
      const v = {
        daily, i5: intraday(78, 5, 1), i30: intraday(13, 30, 5),
        w5y: daily.filter((b, i) => (daily.length - 1 - i) % 5 === 0).slice(-262),
        quote: { price: last.c, change: +(last.c - prev.c).toFixed(2), changePct: (last.c - prev.c) / prev.c * 100, prevClose: prev.c, high: last.c * 1.01, low: last.c * 0.99, open: prev.c, t: now() },
        profile: { name: names[s] || s, exchange: 'DEMO', industry: 'DEMO', sharesM, marketCapM: last.c * sharesM, currency: 'USD' },
        metrics: { peTTM: pe, forwardPE: pe * (0.75 + r() * 0.2), epsTTM: last.c / pe, dividendYield: r() < 0.3 ? null : r() * 3, high52: Math.max(...y), low52: Math.min(...y),
          beta: 0.6 + r() * 1.2, avgVolume10dM: 5 + r() * 80, revenueTTM: undefined, revenuePerShareTTM: 5 + r() * 60, grossMargin: 30 + r() * 50, operatingMargin: 10 + r() * 30, netMargin: 5 + r() * 25, marketCapM: last.c * sharesM },
        rec: { period: ds(today).slice(0, 8) + '01', strongBuy: Math.floor(r() * 20), buy: Math.floor(r() * 25), hold: Math.floor(r() * 15), sell: Math.floor(r() * 4), strongSell: Math.floor(r() * 2) },
        earnings: { date: ds(ed), hour: r() < 0.5 ? 'bmo' : 'amc', epsEstimate: null }
      };
      memo.set(s, v); return v;
    }
    const wrap = v => Promise.resolve({ value: v, savedAt: now(), fresh: true, demo: true });
    // ASX in DEMO: synthetic end-of-day closes in AUD (no intraday, matching what the free tier offers live).
    const asxBars = c => { const x = build('ASX:' + c), k = 2 + (hash(c) % 140); return x.daily.slice(-252).map(b => ({ d: b.d, c: +(b.c / x.daily[x.daily.length - 1].c * k).toFixed(2), v: Math.round(b.v / 10) })); };
    const DEMO_HEADLINES = ['%s shares in focus after sector update', 'Analysts discuss %s outlook ahead of earnings', '%s announces product update', 'What the latest market moves mean for %s', '%s added to more fund portfolios, filings show', '%s management comments at industry conference'];
    function demoNews(s) {
      const r = rng(hash('news' + s)), out = [];
      for (let i = 0; i < 5; i++) out.push({ headline: 'DEMO: ' + DEMO_HEADLINES[(hash(s) + i) % DEMO_HEADLINES.length].replace('%s', names[s] || s), source: 'DEMO (synthetic)', t: now() - Math.round((i * 9 + r() * 8) * 3600e3), url: null, demo: true });
      return out;
    }
    function demoCalendar() {
      const out = [], syms = Object.keys(names).filter(s => !s.startsWith('ASX:'));
      for (const s of syms) {
        const r = rng(hash('cal' + s)), off = Math.floor(r() * 45);
        if (off > 14) continue;
        const d = new Date(now() + off * 864e5); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        out.push({ symbol: s, date: ds(d), hour: ['bmo', 'amc', 'amc', ''][Math.floor(r() * 4)], epsEstimate: r() < 0.85 ? +(0.2 + r() * 4).toFixed(2) : null });
      }
      return out;
    }
    return {
      demo: true,
      quote: s => wrap(build(s).quote), profile: s => wrap(build(s).profile), metrics: s => wrap(build(s).metrics),
      recommendation: s => wrap(build(s).rec), earnings: s => wrap(build(s).earnings),
      priceTarget: () => wrap({ unavailable: 'premium' }), // mirrors the free tier
      candles: (s, range) => { const x = build(s), d = L.RANGES[range].dataset; return wrap(d === 'd1y' ? x.daily.slice(-260) : x[d]); },
      peekCandles: (s, d) => { const x = build(s); return d === 'd1y' ? x.daily.slice(-260) : x[d] || null; },
      peekQuote: s => build(s).quote, peekProfile: s => build(s).profile, peekSpark: s => build(s).daily.slice(-22).map(b => b.c),
      sparklines: (symbols, onUpdate) => { symbols.forEach(s => onUpdate && onUpdate(s)); return Promise.resolve(symbols.length); },
      news: s => wrap(demoNews(s)), earningsCalendar: () => wrap(demoCalendar()),
      asxMode: () => 'demo', sheetQuotes: () => Promise.resolve({ value: { codes: [], skipped: [] }, fresh: true }),
      asxCost: () => 0, asxQuotes: (codes, o = {}) => { if (o.onUpdate) o.onUpdate(codes); return Promise.resolve({ requested: 0 }); },
      asxHistory: c => wrap(asxBars(c)), peekAsxQuote: c => L.eodQuote(asxBars(c)), peekAsxHistory: c => asxBars(c),
      asxBudget: () => ({ used: 0, cap: LIMITS.marketstack.monthly, left: LIMITS.marketstack.monthly, month: L.monthKey(now()), demo: true }),
      fx: () => wrap({ rate: 1.5, t: now(), live: false, demo: true, source: 'DEMO rate (synthetic)' }), peekFx: () => ({ rate: 1.5, t: now(), demo: true, source: 'DEMO rate (synthetic)' }),
      usage: () => ({ fhLastMinute: 0, fhPending: 0, fhPausedMs: 0, tdLastMinute: 0, tdPending: 0, tdToday: 0, fhToday: 0, frToday: 0, shToday: 0, msPending: 0, pending: 0, ms: { used: 0, cap: 100, left: 100 }, limits: LIMITS }),
      focus: () => 0, clearCache() { memo.clear(); }, prune() { return 0; }, cancelAll() {}
    };
  }

  const out = { createDataSource, createDemoSource, createLimiter, fetchSheet, LIMITS, SPARK_CHUNK, MS_CHUNK };
  if (typeof module !== 'undefined' && module.exports) module.exports = out; else root.SWAPI = out;
})(typeof self !== 'undefined' ? self : this);
