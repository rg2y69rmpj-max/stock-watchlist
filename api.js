/* Data layer: Finnhub (quotes, profile, metrics, ratings, earnings) + Twelve Data (price history).
   Keys come from getKeys() at call time; they're never cached, logged or put in error messages.
   Works in the browser (window.SWAPI) and in Node for tests (inject fetch/storage/clock). */
(function (root) {
  'use strict';
  const L = root.SWL || (typeof require !== 'undefined' ? require('./logic.js') : null);
  const FH = 'https://finnhub.io/api/v1', TD = 'https://api.twelvedata.com';
  const LIMITS = { finnhub: { max: 55, windowMs: 60e3, minGapMs: 120 }, twelvedata: { max: 8, windowMs: 60e3, minGapMs: 0, daily: 800 } };
  const SPARK_CHUNK = 6; // leaves 2 Twelve Data credits a minute for a chart you open while sparklines load

  function apiError(info, extra) { return Object.assign(new Error(info.message), info, extra || {}); }

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
      schedule(fn, { cost = 1, prio = 5 } = {}) {
        return new Promise((resolve, reject) => {
          queue.push({ fn, cost, prio, resolve, reject, seq: seq++ });
          queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq); pump();
        });
      },
      pause(ms) { pausedUntil = Math.max(pausedUntil, now() + ms); save(); },
      pausedFor() { return Math.max(0, pausedUntil - now()); },
      usedLastMinute() { const t = now(); return history.filter(h => t - h.t < cfg.windowMs).reduce((s, h) => s + h.cost, 0); },
      pending() { return queue.length; },
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
    const inflight = new Map(), sparkPending = new Set();
    const qs = p => Object.keys(p).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
    const utcDay = () => new Date(now()).toISOString().slice(0, 10);

    function usage() { let u = null; try { u = JSON.parse(storage.getItem(L.KEYS.usage)); } catch (e) { u = null; } return u && u.day === utcDay() ? u : { day: utcDay(), td: 0, fh: 0 }; }
    function bump(field, n) { const u = usage(); u[field] = (u[field] || 0) + n; try { storage.setItem(L.KEYS.usage, JSON.stringify(u)); } catch (e) { /* full */ } }

    async function readBody(res) { try { return await res.json(); } catch (e) { return null; } }

    function fhGet(path, params, prio) {
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
      }, { prio });
    }

    function tdGet(path, params, cost, prio) {
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
      }, { cost, prio });
    }

    // Fresh cache -> return it. Otherwise fetch; on failure fall back to stale cache (flagged) or throw.
    // Premium-only responses are cached as {unavailable:'premium'} so we don't keep spending calls on them.
    function cached(key, ttl, loader, o = {}) {
      const e = cache.entry(key);
      if (e && e.fresh && !o.force) return Promise.resolve({ value: e.value, savedAt: e.savedAt, fresh: true });
      if (inflight.has(key)) return inflight.get(key);
      const p = loader().then(v => { cache.set(key, v, ttl); return { value: v, savedAt: now(), fresh: true }; })
        .catch(err => {
          if (err.type === 'premium') { const v = { unavailable: 'premium' }; cache.set(key, v, ttl); return { value: v, savedAt: now(), fresh: true }; }
          if (e) return { value: e.value, savedAt: e.savedAt, fresh: false, error: err };
          throw err;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p); return p;
    }
    const peek = key => { const e = cache.entry(key); return e ? e.value : null; };

    const api = {
      demo: false,
      quote: (s, o = {}) => cached('q:' + s, L.TTL.quote, () => fhGet('/quote', { symbol: s }, o.prio ?? 3).then(j => L.parseFinnhubQuote(j) || { notFound: true }), o),
      profile: (s, o = {}) => cached('p:' + s, L.TTL.profile, () => fhGet('/stock/profile2', { symbol: s }, o.prio ?? 6).then(j => L.parseFinnhubProfile(j) || { notFound: true }), o),
      metrics: (s, o = {}) => cached('m:' + s, L.TTL.metrics, () => fhGet('/stock/metric', { symbol: s, metric: 'all' }, o.prio ?? 1).then(L.parseFinnhubMetrics), o),
      recommendation: (s, o = {}) => cached('r:' + s, L.TTL.recommendation, () => fhGet('/stock/recommendation', { symbol: s }, o.prio ?? 1).then(j => L.latestRecommendation(j) || { none: true }), o),
      earnings: (s, o = {}) => {
        const from = new Date(now()), to = new Date(now() + 200 * L.DAY);
        return cached('e:' + s, L.TTL.earnings, () => fhGet('/calendar/earnings', { from: L.isoDate(from), to: L.isoDate(to), symbol: s }, o.prio ?? 2)
          .then(j => L.nextEarnings(j, L.isoDate(from)) || { none: true }), o);
      },
      // Premium on Finnhub's free tier: the first call returns 403, which is cached for 12 h and shown as "n/a (not on free tier)".
      priceTarget: (s, o = {}) => cached('pt:' + s, L.TTL.priceTarget, () => fhGet('/stock/price-target', { symbol: s }, o.prio ?? 2).then(j => L.parseFinnhubPriceTarget(j) || { none: true }), o),
      candles(s, range, o = {}) {
        const ds = L.RANGES[range].dataset, cfg = L.DATASETS[ds];
        return cached('c:' + ds + ':' + s, L.TTL[ds], () => tdGet('/time_series', { symbol: s, interval: cfg.interval, outputsize: cfg.outputsize }, 1, o.prio ?? 0).then(j => {
          const bars = L.parseTwelveSeries(j, [s])[s];
          if (bars.error) throw apiError(L.classifyError('twelvedata', 200, { message: bars.error, code: bars.code }));
          if (ds === 'd1y') cache.set('s:' + s, bars.slice(-22).map(b => b.c), L.TTL.spark); // reuse for the sparkline
          return bars;
        }), o);
      },
      peekCandles: (s, ds) => peek('c:' + ds + ':' + s),
      peekQuote: s => peek('q:' + s), peekProfile: s => peek('p:' + s), peekSpark: s => peek('s:' + s),
      // Sparklines: Twelve Data batch requests (one HTTP call for up to SPARK_CHUNK symbols; each symbol costs 1 credit).
      sparklines(symbols, onUpdate) {
        if (!(getKeys().twelvedata || '').trim()) return Promise.resolve(0);
        const todo = symbols.filter(s => !cache.get('s:' + s) && !sparkPending.has(s));
        const jobs = [];
        for (let i = 0; i < todo.length; i += SPARK_CHUNK) {
          const chunk = todo.slice(i, i + SPARK_CHUNK); chunk.forEach(s => sparkPending.add(s));
          jobs.push(tdGet('/time_series', { symbol: chunk.join(','), interval: L.DATASETS.spark.interval, outputsize: L.DATASETS.spark.outputsize }, chunk.length, 8)
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
      usage: () => ({ fhLastMinute: fh.usedLastMinute(), fhPending: fh.pending(), fhPausedMs: fh.pausedFor(), tdLastMinute: td.usedLastMinute(), tdPending: td.pending(), tdToday: usage().td, fhToday: usage().fh, limits: LIMITS }),
      clearCache: () => cache.clear(),
      prune: () => cache.prune(),
      cancelAll() { fh.clear(); td.clear(); sparkPending.clear(); }
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
    return {
      demo: true,
      quote: s => wrap(build(s).quote), profile: s => wrap(build(s).profile), metrics: s => wrap(build(s).metrics),
      recommendation: s => wrap(build(s).rec), earnings: s => wrap(build(s).earnings),
      priceTarget: () => wrap({ unavailable: 'premium' }), // mirrors the free tier
      candles: (s, range) => { const x = build(s), d = L.RANGES[range].dataset; return wrap(d === 'd1y' ? x.daily.slice(-260) : x[d]); },
      peekCandles: (s, d) => { const x = build(s); return d === 'd1y' ? x.daily.slice(-260) : x[d] || null; },
      peekQuote: s => build(s).quote, peekProfile: s => build(s).profile, peekSpark: s => build(s).daily.slice(-22).map(b => b.c),
      sparklines: (symbols, onUpdate) => { symbols.forEach(s => onUpdate && onUpdate(s)); return Promise.resolve(symbols.length); },
      usage: () => ({ fhLastMinute: 0, fhPending: 0, fhPausedMs: 0, tdLastMinute: 0, tdPending: 0, tdToday: 0, fhToday: 0, limits: LIMITS }),
      clearCache() { memo.clear(); }, prune() { return 0; }, cancelAll() {}
    };
  }

  const out = { createDataSource, createDemoSource, createLimiter, LIMITS, SPARK_CHUNK };
  if (typeof module !== 'undefined' && module.exports) module.exports = out; else root.SWAPI = out;
})(typeof self !== 'undefined' ? self : this);
