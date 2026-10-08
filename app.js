/* UI. Depends on logic.js (SWL), api.js (SWAPI) and chart.js (SWChart). */
(function () {
  'use strict';
  const L = window.SWL, A = window.SWAPI;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = window.localStorage;
  const readJSON = (k, d) => { try { const v = JSON.parse(store.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };

  let defaults = [], defaultsMeta = {}, snapshotCap = {};
  let wl, settings = readJSON(L.KEYS.settings, {}), keys = readJSON(L.KEYS.apiKeys, {});
  settings = Object.assign({ demo: false, refreshSec: 120, range: '1D' }, settings);
  let src = null, editMode = false, query = '', currentSym = null, latestAsOf = 0, refreshTimer = null, renderQueued = false, detailToken = 0;
  const rowErr = {}; // symbol -> short message

  const saveSettings = () => store.setItem(L.KEYS.settings, JSON.stringify(settings));
  const saveKeys = () => store.setItem(L.KEYS.apiKeys, JSON.stringify({ finnhub: keys.finnhub || '', twelvedata: keys.twelvedata || '' }));
  const hasLiveKey = () => !!(keys.finnhub || '').trim();

  /* ---------- banner + status ---------- */
  let bannerTimer = null;
  function banner(msg, kind = 'error', ms = 12000) {
    $('#bannerText').textContent = msg; $('#banner').className = 'banner' + (kind === 'info' ? ' info' : ''); $('#banner').hidden = false;
    clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => { $('#banner').hidden = true; }, ms);
  }
  $('#bannerClose').onclick = () => { $('#banner').hidden = true; };
  function onEvent(type, info) {
    if (type === 'limit') banner(info.message + ' Showing cached data meanwhile.', 'error', 15000);
    else if (type === 'auth') banner(info.message, 'error', 0);
  }
  function updateStatus() {
    const demo = !!(src && src.demo);
    $('#demoBadge').hidden = !demo; $('#demoBanner').hidden = !demo;
    $('#delayed').textContent = demo ? 'DEMO data' : 'Delayed data';
    $('#delayed').className = 'badge ' + (demo ? 'demo' : 'delayed');
    $('#asof').textContent = latestAsOf ? (demo ? 'generated ' : 'as of ') + L.fmtAsOf(latestAsOf) : (src && !demo ? 'waiting for prices…' : '');
    const u = src ? src.usage() : null;
    $('#queue').textContent = u && !demo && (u.fhPending + u.tdPending) ? '· loading ' + (u.fhPending + u.tdPending) + ' requests' : '';
    $('#foot').textContent = 'Not financial advice · ' + (demo ? 'DEMO data (synthetic)' : 'Delayed data' + (latestAsOf ? ', as of ' + L.fmtAsOf(latestAsOf) : ''));
  }
  function noteAsOf(t) { if (L.isNum(t) && t > latestAsOf) { latestAsOf = t; updateStatus(); } }

  /* ---------- data source ---------- */
  function makeSource() {
    if (src) src.cancelAll();
    latestAsOf = 0;
    if (settings.demo) src = A.createDemoSource({ names: Object.fromEntries(wl.symbols.map(s => [s.symbol, s.name])), caps: snapshotCap });
    else if (hasLiveKey()) src = A.createDataSource({ storage: store, fetch: (u, o) => window.fetch(u, Object.assign({ referrerPolicy: 'no-referrer', cache: 'no-store' }, o || {})), getKeys: () => keys, onEvent });
    else src = null;
    if (src) src.prune();
    updateStatus();
  }

  /* ---------- routing ---------- */
  function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
  function route() {
    const h = location.hash || '#/';
    const views = ['setup', 'list', 'detail', 'settings'];
    let v = 'list', m;
    if (h.startsWith('#/settings')) v = 'settings';
    else if ((m = /^#\/s\/([^/]+)$/.exec(h))) v = 'detail';
    if (!src && v !== 'settings') v = 'setup';
    views.forEach(x => { $('#v-' + x).hidden = x !== v; });
    $('#back').hidden = !(v === 'detail' || v === 'settings');
    $('#gear').hidden = v === 'settings';
    if (v !== 'detail') currentSym = null;
    if (v === 'list') { $('#title').textContent = 'Watchlist'; renderList(); loadList(); }
    if (v === 'setup') $('#title').textContent = 'Set up';
    if (v === 'settings') { $('#title').textContent = 'Settings'; renderSettings(); }
    if (v === 'detail') openDetail(decodeURIComponent(m[1]));
    window.scrollTo(0, 0);
  }
  $('#back').onclick = () => { if (sessionStorage.getItem('sw.nav')) history.back(); else go('#/'); }; // deep link: no in-app history to go back to
  $('#gear').onclick = () => go('#/settings');
  window.addEventListener('hashchange', () => { sessionStorage.setItem('sw.nav', '1'); route(); });

  /* ---------- list ---------- */
  function rowData(s) {
    const q = src ? src.peekQuote(s.symbol) : null, p = src ? src.peekProfile(s.symbol) : null;
    const quote = q && !q.notFound ? q : null, prof = p && !p.notFound ? p : null;
    const live = L.marketCap(quote, prof, null);
    return { symbol: s.symbol, name: s.name || (prof && prof.name) || '', price: quote ? quote.price : null, changePct: quote ? quote.changePct : null,
      marketCap: live ?? snapshotCap[s.symbol] ?? null, liveCap: live, notFound: !!(q && q.notFound), spark: src ? src.peekSpark(s.symbol) : null };
  }
  function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; if (!$('#v-list').hidden) renderList(); updateStatus(); }); }
  function renderList() {
    $('#sortKey').value = wl.sort.key; $('#sortDir').textContent = wl.sort.dir === 'asc' ? '↑' : '↓';
    $('#favFirst').setAttribute('aria-pressed', String(wl.favouritesFirst)); $('#editBtn').setAttribute('aria-pressed', String(editMode));
    $('#editBtn').textContent = editMode ? 'Done' : 'Edit';
    const favs = new Set(wl.favourites);
    const rows = L.searchRows(L.sortRows(wl.symbols.map(rowData), wl.sort.key, wl.sort.dir, { favourites: favs, favouritesFirst: wl.favouritesFirst }), query);
    // Patch rows in place when the order is unchanged, so a tap on a star isn't lost while prices stream in.
    const parts = r => {
      const dir = L.direction(r.changePct), sp = r.spark && r.spark.length > 1 ? r.spark : null, fav = favs.has(r.symbol);
      const sdir = sp ? L.direction(sp[sp.length - 1] - sp[0]) : 'flat';
      const left = editMode ? `<button class="rm" data-rm="${esc(r.symbol)}" aria-label="Remove ${esc(r.symbol)}" type="button">−</button>`
        : `<button class="star${fav ? ' on' : ''}" data-fav="${esc(r.symbol)}" aria-label="Favourite ${esc(r.symbol)}" aria-pressed="${fav}" type="button">${fav ? '★' : '☆'}</button>`;
      const sub = r.notFound ? '<span class="err-t">No quote found. Check the ticker.</span>' : rowErr[r.symbol] ? `<span class="err-t">${esc(rowErr[r.symbol])}</span>`
        : esc(r.name) + (r.liveCap ? ' · ' + L.fmtBig(r.liveCap) : '');
      return [left, `<div class="min0"><div class="tk">${esc(r.symbol)}</div><div class="nm">${sub}</div></div>`,
        sp ? `<svg class="spark ${sdir}" viewBox="0 0 72 28" preserveAspectRatio="none" aria-hidden="true"><path d="${L.sparkPath(sp, 72, 28)}"/></svg>` : '<div class="spark-empty" aria-hidden="true"></div>',
        `<div class="px"><div class="price">${L.fmtPrice(r.price)}</div><span class="pill ${dir}">${L.fmtPct(r.changePct)}</span></div>`];
    };
    const list = $('#list'), cur = [...list.children], next = rows.map(parts);
    if (cur.length === rows.length && cur.every((li, i) => li.dataset.sym === rows[i].symbol)) {
      cur.forEach((li, i) => { const old = li._p || []; next[i].forEach((h, j) => { if (old[j] !== h) li.children[j].outerHTML = h; }); li._p = next[i]; });
    } else {
      list.innerHTML = rows.map((r, i) => `<li data-sym="${esc(r.symbol)}">${next[i].join('')}</li>`).join('');
      [...list.children].forEach((li, i) => { li._p = next[i]; });
    }
    $('#listEmpty').hidden = rows.length > 0;
    const kTd = (keys.twelvedata || '').trim();
    $('#listNote').textContent = src && !src.demo && !kTd ? 'Sparklines and charts need a free Twelve Data key (Settings).' : '';
  }
  function visibleOrder() { return [...document.querySelectorAll('#list li')].map(li => li.dataset.sym); }
  function loadList(force) {
    if (!src) return;
    const order = visibleOrder().length ? visibleOrder() : wl.symbols.map(s => s.symbol);
    order.forEach((s, i) => {
      src.quote(s, { force, prio: i < 15 ? 3 : 4 }).then(r => { delete rowErr[s]; if (r.value && r.value.t) noteAsOf(r.value.t); if (r.error && r.error.type !== 'rate-limit') rowErr[s] = r.error.message; scheduleRender(); })
        .catch(e => { if (e.type !== 'cancelled' && e.type !== 'rate-limit') rowErr[s] = e.type === 'nokey' ? 'Add a key in Settings' : e.message; scheduleRender(); });
    });
    order.forEach(s => src.profile(s).then(r => { if (r.value && r.value.name && L.setName(wl, s, r.value.name)) L.saveWatchlist(store, wl); scheduleRender(); }).catch(() => {}));
    src.sparklines(order, scheduleRender).catch(() => {});
    updateStatus();
  }
  function startRefresh() {
    clearInterval(refreshTimer);
    if (settings.refreshSec > 0) refreshTimer = setInterval(() => { if (document.visibilityState === 'visible' && !$('#v-list').hidden) loadList(); }, settings.refreshSec * 1000);
  }
  setInterval(updateStatus, 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !$('#v-list').hidden) loadList(); });

  $('#search').addEventListener('input', e => { query = e.target.value; renderList(); });
  $('#sortKey').addEventListener('change', e => { wl.sort.key = e.target.value; wl.sort.dir = e.target.value === 'symbol' ? 'asc' : 'desc'; L.saveWatchlist(store, wl); renderList(); });
  $('#sortDir').onclick = () => { wl.sort.dir = wl.sort.dir === 'asc' ? 'desc' : 'asc'; L.saveWatchlist(store, wl); renderList(); };
  $('#favFirst').onclick = () => { wl.favouritesFirst = !wl.favouritesFirst; L.saveWatchlist(store, wl); renderList(); };
  $('#editBtn').onclick = () => { editMode = !editMode; renderList(); };
  $('#refresh').onclick = () => { loadList(true); banner('Refreshing prices (rate-limited to stay inside the free tier)…', 'info', 3000); };
  $('#addBtn').onclick = () => { $('#addForm').hidden = !$('#addForm').hidden; if (!$('#addForm').hidden) $('#addInput').focus(); $('#addMsg').textContent = ''; };
  $('#addCancel').onclick = () => { $('#addForm').hidden = true; $('#addMsg').textContent = ''; };
  $('#addForm').addEventListener('submit', e => {
    e.preventDefault();
    const raw = $('#addInput').value, sym = L.normalizeSymbol(raw);
    try {
      if (!L.addSymbol(wl, raw)) { $('#addMsg').textContent = sym + ' is already in your watchlist.'; return; }
    } catch (err) { $('#addMsg').textContent = err.message; return; }
    L.saveWatchlist(store, wl); $('#addInput').value = ''; $('#addMsg').textContent = 'Added ' + sym + '.';
    query = ''; $('#search').value = ''; renderList(); loadList();
  });
  $('#list').addEventListener('click', e => {
    const fav = e.target.closest('[data-fav]'), rm = e.target.closest('[data-rm]'), li = e.target.closest('li[data-sym]');
    if (fav) { L.toggleFavourite(wl, fav.dataset.fav); L.saveWatchlist(store, wl); renderList(); return; }
    if (rm) { L.removeSymbol(wl, rm.dataset.rm); L.saveWatchlist(store, wl); renderList(); return; }
    if (li && !editMode) go('#/s/' + encodeURIComponent(li.dataset.sym));
  });

  /* ---------- detail ---------- */
  const chart = window.SWChart.PriceChart($('#chart'), {
    formatTime: (d, intraday) => L.fmtBarTime(d, intraday),
    onHover: (bar) => { const t = $('#chartTip'); if (bar) { t.textContent = L.fmtPrice(bar.c) + ' · ' + L.fmtBarTime(bar.d, isIntraday()); t.classList.add('on'); } else { t.textContent = 'Touch and drag on the chart to see price and date'; t.classList.remove('on'); } }
  });
  const isIntraday = () => settings.range === '1D' || settings.range === '5D';
  $('#ranges').innerHTML = L.RANGE_ORDER.map(r => `<button type="button" role="tab" data-range="${r}">${r}</button>`).join('');
  $('#ranges').addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (b && currentSym) { settings.range = b.dataset.range; saveSettings(); loadChart(currentSym); } });

  function openDetail(sym) {
    currentSym = sym; const token = ++detailToken;
    const entry = wl.symbols.find(s => s.symbol === sym);
    $('#title').textContent = sym; $('#dName').textContent = (entry && entry.name) || '';
    $('#dPrice').textContent = '—'; $('#dChange').textContent = ''; $('#dRangeChange').textContent = '';
    $('#dRemove').hidden = !entry; renderFav();
    $('#ratings').innerHTML = $('#targets').innerHTML = '<span class="muted small">Loading…</span>'; $('#metrics').innerHTML = '';
    const ok = fn => r => { if (token === detailToken) fn(r); };
    const fail = (el) => e => { if (token === detailToken && el) el.innerHTML = `<span class="err-t">${esc(e.message)}</span>`; };
    const st = { quote: null, profile: null, metrics: null };
    const redrawMetrics = () => renderMetrics(sym, st);
    src.quote(sym, { prio: 0 }).then(ok(r => { st.quote = r.value && !r.value.notFound ? r.value : null; renderQuote(sym, r); noteAsOf(st.quote && st.quote.t); redrawMetrics(); })).catch(fail($('#dChange')));
    src.profile(sym, { prio: 0 }).then(ok(r => { st.profile = r.value && !r.value.notFound ? r.value : null; if (st.profile && st.profile.name) $('#dName').textContent = st.profile.name; redrawMetrics(); })).catch(() => {});
    src.metrics(sym, { prio: 1 }).then(ok(r => { st.metrics = r.value; redrawMetrics(); })).catch(fail($('#metrics')));
    src.earnings(sym, { prio: 2 }).then(ok(r => { st.earnings = r.value; redrawMetrics(); })).catch(ok(e => { st.earnings = { error: e.message }; redrawMetrics(); }));
    src.recommendation(sym, { prio: 1 }).then(ok(r => renderRatings(r.value))).catch(fail($('#ratings')));
    src.priceTarget(sym, { prio: 2 }).then(ok(r => renderTargets(r.value))).catch(fail($('#targets')));
    st.chartLoaded = () => redrawMetrics();
    currentDetailState = st;
    loadChart(sym);
  }
  let currentDetailState = null;
  function renderFav() { const on = wl.favourites.includes(currentSym); $('#dFav').textContent = on ? '★' : '☆'; $('#dFav').classList.toggle('on', on); $('#dFav').setAttribute('aria-pressed', String(on)); }
  $('#dFav').onclick = () => { if (!wl.symbols.some(s => s.symbol === currentSym)) L.addSymbol(wl, currentSym); L.toggleFavourite(wl, currentSym); L.saveWatchlist(store, wl); renderFav(); $('#dRemove').hidden = false; };
  $('#dRemove').onclick = () => { L.removeSymbol(wl, currentSym); L.saveWatchlist(store, wl); go('#/'); };
  function renderQuote(sym, r) {
    const q = r.value;
    if (!q || q.notFound) { $('#dPrice').textContent = '—'; $('#dChange').innerHTML = '<span class="err-t">No quote found for this ticker.</span>'; return; }
    $('#dPrice').textContent = L.fmtPrice(q.price);
    const d = L.direction(q.change);
    $('#dChange').innerHTML = `<span class="${d}-t">${L.fmtChange(q.change)} (${L.fmtPct(q.changePct)})</span> <span class="muted small">today${src.demo ? ' · DEMO' : ' · delayed, as of ' + esc(L.fmtAsOf(q.t))}${r.fresh === false ? ' · cached' : ''}</span>`;
  }
  function loadChart(sym) {
    const range = settings.range;
    document.querySelectorAll('#ranges button').forEach(b => { b.classList.toggle('on', b.dataset.range === range); b.setAttribute('aria-selected', String(b.dataset.range === range)); });
    $('#chartMsg').textContent = ''; $('#dRangeChange').textContent = '';
    chart.set([], { message: 'Loading chart…', demo: src.demo, range });
    const token = detailToken;
    src.candles(sym, range, { prio: 0 }).then(r => {
      if (token !== detailToken || range !== settings.range) return;
      const bars = L.sliceRange(r.value, range);
      const q = src.peekQuote(sym);
      chart.set(bars, { intraday: range === '1D' || range === '5D', range, demo: src.demo, baseline: range === '1D' && q && q.prevClose ? q.prevClose : null, message: 'No chart data for this range' });
      const ch = L.rangeChange(bars);
      if (ch) $('#dRangeChange').innerHTML = `<span class="${L.direction(ch.change)}-t">${L.fmtPct(ch.changePct)}</span> over ${range} (chart${src.demo ? ', DEMO' : ', times ET'})`;
      $('#chartMsg').textContent = r.fresh === false ? 'Showing cached chart (could not refresh: ' + (r.error && r.error.message) + ')' : '';
      if (currentDetailState && currentDetailState.chartLoaded) currentDetailState.chartLoaded();
    }).catch(e => {
      if (token !== detailToken || range !== settings.range) return;
      chart.set([], { message: e.type === 'nokey' ? 'Charts need a free Twelve Data key' : e.type === 'rate-limit' ? 'Rate limit reached. Try again shortly.' : 'Chart unavailable', demo: src.demo, range });
      $('#chartMsg').textContent = e.message;
    });
  }
  function renderRatings(rec) {
    const el = $('#ratings');
    if (!rec || rec.none) { el.innerHTML = '<span class="muted small">No analyst recommendations reported.</span>'; return; }
    if (rec.unavailable) { el.innerHTML = `<span class="na">${L.NA_FREE}</span>`; return; }
    const c = L.consensus(rec), total = c ? c.total : 0;
    const parts = [['strongBuy', 'Strong buy', 'r-sb'], ['buy', 'Buy', 'r-b'], ['hold', 'Hold', 'r-h'], ['sell', 'Sell', 'r-s'], ['strongSell', 'Strong sell', 'r-ss']];
    el.innerHTML = (c ? `<div class="consensus"><span class="lbl ${c.score <= 2.5 ? 'up-t' : c.score > 3.5 ? 'down-t' : ''}" id="consensusLabel">${c.label}</span><span class="muted small">score ${c.score.toFixed(2)} on 1 (strong buy) to 5 (strong sell) · ${total} analysts</span></div>` : '') +
      `<div class="ratingbar">${parts.map(([k, , cls]) => total && rec[k] ? `<span class="${cls}" style="width:${(rec[k] / total * 100).toFixed(1)}%"></span>` : '').join('')}</div>` +
      `<div class="rcounts">${parts.map(([k, lbl]) => `<div><b data-count="${k}">${rec[k]}</b>${lbl}</div>`).join('')}</div>` +
      `<p class="small muted" style="margin:8px 0 0">Period ${esc(rec.period)}${src.demo ? ' · DEMO' : ' · Finnhub recommendation trends'}</p>`;
  }
  function renderTargets(t) {
    const na = v => `<span class="na">${v}</span>`;
    const rows = !t || t.unavailable ? [['Average', na(L.NA_FREE)], ['High', na(L.NA_FREE)], ['Low', na(L.NA_FREE)]]
      : t.none ? [['Average', na(L.NA_NONE)], ['High', na(L.NA_NONE)], ['Low', na(L.NA_NONE)]]
      : [['Average', L.show(t.mean, L.fmtPrice)], ['High', L.show(t.high, L.fmtPrice)], ['Low', L.show(t.low, L.fmtPrice)]];
    $('#targets').innerHTML = rows.map(([k, v]) => `<div class="kv"><span class="muted">${k}</span><span data-target="${k.toLowerCase()}">${v}</span></div>`).join('');
  }
  function renderMetrics(sym, st) {
    const m = st.metrics || {}, q = st.quote, p = st.profile;
    const have = !!st.metrics;
    const val = (v, fmt) => !have && v === undefined ? '…' : L.show(v, fmt);
    const cap = L.marketCap(q, p, m);
    let revenue = m.revenueTTM, revNote = '';
    if (revenue === undefined && L.isNum(m.revenuePerShareTTM) && p && L.isNum(p.sharesM)) { revenue = m.revenuePerShareTTM * p.sharesM * 1e6; revNote = ' (≈ revenue/share × shares)'; }
    const vol = L.sessionVolume(src.peekCandles(sym, 'd1y'), src.peekCandles(sym, 'i5'));
    const e = st.earnings;
    const earn = !e ? '…' : e.error ? L.NA_NONE : e.none ? 'Not announced yet' : L.fmtBarTime(e.date) + (e.hour === 'bmo' ? ' (before open)' : e.hour === 'amc' ? ' (after close)' : '');
    const items = [
      ['Market cap', cap != null ? L.fmtBig(cap) : (have || p ? L.NA_NONE : '…')],
      ['P/E (trailing)', val(m.peTTM, L.fmtRatio)], ['P/E (forward)', val(m.forwardPE, L.fmtRatio)],
      ['EPS (TTM)', val(m.epsTTM, v => '$' + v.toFixed(2))], ['Dividend yield', val(m.dividendYield, L.fmtPercentValue)],
      ['52-week high', val(m.high52, L.fmtPrice)], ['52-week low', val(m.low52, L.fmtPrice)], ['Beta', val(m.beta, L.fmtRatio)],
      ['Volume (last session)', vol ? L.fmtVolume(vol.value) : ((keys.twelvedata || src.demo) ? 'loads with the chart' : 'needs Twelve Data key')],
      ['Avg volume (10 day)', val(m.avgVolume10dM === undefined || m.avgVolume10dM === null ? m.avgVolume10dM : m.avgVolume10dM * 1e6, L.fmtVolume)],
      ['Revenue (TTM)', val(revenue, L.fmtBig) + revNote], ['Gross margin', val(m.grossMargin, L.fmtPercentValue)],
      ['Operating margin', val(m.operatingMargin, L.fmtPercentValue)], ['Net margin', val(m.netMargin, L.fmtPercentValue)],
      ['Next earnings', earn]
    ];
    $('#metrics').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd class="${/^n\/a/.test(v) ? 'na' : ''}" data-metric="${esc(k)}">${esc(v)}</dd></div>`).join('');
  }

  /* ---------- settings + setup ---------- */
  function renderSettings() {
    const f = $('#keysForm'); f.finnhub.value = keys.finnhub || ''; f.twelvedata.value = keys.twelvedata || '';
    $('#demoToggle').checked = !!settings.demo; $('#refreshSel').value = String(settings.refreshSec);
    $('#defaultInfo').textContent = 'Default list: top ' + defaults.length + ' S&P 500 companies by market cap as of ' + (defaultsMeta.asOf || '?') + '. You have ' + wl.symbols.length + ' tickers, ' + wl.favourites.length + ' favourites.';
    renderUsage();
  }
  function renderUsage() {
    if ($('#v-settings').hidden) return;
    const u = src ? src.usage() : null;
    $('#usage').innerHTML = !u || src.demo ? 'No API calls in DEMO mode.' :
      `Finnhub: ${u.fhLastMinute}/${u.limits.finnhub.max} calls in the last minute (free limit 60), ${u.fhToday} today${u.fhPausedMs ? ', paused ' + Math.ceil(u.fhPausedMs / 1000) + ' s after hitting the limit' : ''}.<br>` +
      `Twelve Data: ${u.tdLastMinute}/8 credits this minute, ${u.tdToday}/800 today (resets at 00:00 UTC).`;
  }
  setInterval(renderUsage, 2000);
  function applyKeys(form, msgEl) {
    keys = { finnhub: form.finnhub.value.trim(), twelvedata: form.twelvedata.value.trim() };
    saveKeys();
    if (keys.finnhub) settings.demo = false;
    saveSettings(); makeSource();
    if (msgEl) msgEl.textContent = keys.finnhub ? 'Saved on this device.' : 'Saved. A Finnhub key is needed for live prices.';
  }
  $('#keysForm').addEventListener('submit', e => { e.preventDefault(); applyKeys(e.target, $('#keysMsg')); renderSettings(); });
  $('#setupForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!e.target.finnhub.value.trim()) { banner('Paste a Finnhub key, or try DEMO data.', 'error', 5000); return; }
    applyKeys(e.target); e.target.reset(); go('#/');
  });
  $('#showKeys').addEventListener('change', e => { ['finnhub', 'twelvedata'].forEach(n => { $('#keysForm')[n].type = e.target.checked ? 'text' : 'password'; }); });
  $('#clearKeys').onclick = () => { if (!confirm('Remove both API keys from this device?')) return; keys = { finnhub: '', twelvedata: '' }; saveKeys(); makeSource(); renderSettings(); $('#keysMsg').textContent = 'Keys removed.'; };
  $('#demoToggle').addEventListener('change', e => { settings.demo = e.target.checked; saveSettings(); makeSource(); renderSettings(); });
  $('#refreshSel').addEventListener('change', e => { settings.refreshSec = +e.target.value; saveSettings(); startRefresh(); });
  $('#tryDemo').onclick = () => { settings.demo = true; saveSettings(); makeSource(); go('#/'); };
  $('#resetList').onclick = () => { if (!confirm('Replace your watchlist and favourites with the default list?')) return; wl = L.defaultWatchlist(defaults); L.saveWatchlist(store, wl); makeSource(); renderSettings(); $('#listMsg').textContent = 'Watchlist reset.'; };
  $('#clearCache').onclick = () => { if (src) src.clearCache(); L.createCache(store).clear(); makeSource(); $('#listMsg').textContent = 'Cached market data cleared.'; };

  /* ---------- boot ---------- */
  async function boot() {
    try {
      const res = await fetch('data/default-watchlist.json'); const j = await res.json();
      defaultsMeta = j; defaults = j.symbols || [];
    } catch (e) { defaults = []; banner('Could not load the default list.', 'error'); }
    defaults.forEach(d => { if (d.marketCapUSD) snapshotCap[d.symbol] = d.marketCapUSD; });
    wl = L.loadWatchlist(store, defaults);
    makeSource(); startRefresh(); route();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = { get src() { return src; }, get wl() { return wl; }, chart };
  boot();
})();
