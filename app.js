/* UI. Depends on logic.js (SWL), api.js (SWAPI) and chart.js (SWChart). */
(function () {
  'use strict';
  const L = window.SWL, A = window.SWAPI;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = window.localStorage;
  const readJSON = (k, d) => { try { const v = JSON.parse(store.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };

  const PROXIES = [{ sym: 'SPY', name: 'S&P 500', proxy: 'SPY ETF proxy' }, { sym: 'QQQ', name: 'Nasdaq-100', proxy: 'QQQ ETF proxy' }, { sym: 'DIA', name: 'Dow Jones', proxy: 'DIA ETF proxy' }];
  const ASX_PROXY = { code: 'STW', name: 'ASX 200', proxy: 'STW proxy · EOD' };
  const ASX_FREE_GAP = 'Finnhub\u2019s free tier covers US-listed stocks only';
  const DEF = { US: { list: [], meta: {}, cap: {} }, ASX: { list: [], meta: {}, cap: {} } };
  const WL_KEY = { US: L.KEYS.watchlist, ASX: L.KEYS.watchlistAsx };
  let wls = { US: null, ASX: null }, pf = null, alerts = null;
  let settings = readJSON(L.KEYS.settings, {}), keys = readJSON(L.KEYS.apiKeys, {});
  settings = Object.assign({ demo: false, refreshSec: 120, range: '1D', market: 'US', msCap: A.LIMITS.marketstack.monthly }, settings);
  let src = null, editMode = false, query = '', current = null, view = 'list', lastTab = 'list', latestAsOf = 0, refreshTimer = null, renderQueued = false, detailToken = 0, pfEditId = null;
  const rowErr = {}; // id -> short message

  const market = () => (settings.market === 'ASX' ? 'ASX' : 'US');
  const wl = (m = market()) => wls[m];
  const saveWl = (m = market()) => L.saveWatchlist(store, wls[m], WL_KEY[m]);
  const saveSettings = () => store.setItem(L.KEYS.settings, JSON.stringify(settings));
  const saveKeys = () => store.setItem(L.KEYS.apiKeys, JSON.stringify({ finnhub: keys.finnhub || '', twelvedata: keys.twelvedata || '', marketstack: keys.marketstack || '' }));
  const hasKey = k => !!(keys[k] || '').trim();
  const hasLiveKey = () => hasKey('finnhub');
  const asxLive = () => !!src && (src.demo || hasKey('marketstack'));
  const curOf = exchange => (exchange === 'ASX' ? 'AUD' : 'USD');
  const today = () => L.isoDate(new Date());

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
    const asxScreen = !!src && ((view === 'list' && market() === 'ASX') || (view === 'detail' && current && current.exchange === 'ASX'));
    if (asxScreen) {
      const dates = wls.ASX.symbols.concat([{ symbol: ASX_PROXY.code }]).map(x => quoteFor('ASX:' + x.symbol)).filter(Boolean).map(x => x.date).sort();
      $('#asof').textContent = !asxLive() ? 'ASX prices: n/a (no free source)' : 'ASX end-of-day closes' + (dates.length ? ', latest ' + L.fmtBarTime(dates[dates.length - 1]) : '') + (demo ? ' (DEMO)' : '');
    } else $('#asof').textContent = latestAsOf ? (demo ? 'generated ' : 'as of ') + L.fmtAsOf(latestAsOf) : (src && !demo ? 'waiting for prices…' : '');
    const u = src ? src.usage() : null;
    $('#queue').textContent = u && !demo && u.pending ? '· loading ' + u.pending + ' requests' : '';
    $('#foot').textContent = 'Not financial advice · ' + (demo ? 'DEMO data (synthetic)' : 'Delayed data' + (latestAsOf ? ', as of ' + L.fmtAsOf(latestAsOf) : ''));
  }
  function noteAsOf(t) { if (L.isNum(t) && t > latestAsOf && t <= Date.now() + 60e3) { latestAsOf = t; updateStatus(); } }

  /* ---------- data source ---------- */
  function makeSource() {
    if (src) src.cancelAll();
    latestAsOf = 0;
    const names = Object.fromEntries(wls.US.symbols.map(s => [s.symbol, s.name]));
    pf.holdings.filter(h => h.exchange === 'US').forEach(h => { if (!names[h.symbol]) names[h.symbol] = h.symbol; });
    if (settings.demo) src = A.createDemoSource({ names, caps: DEF.US.cap });
    else if (hasLiveKey()) src = A.createDataSource({ storage: store, fetch: (u, o) => window.fetch(u, Object.assign({ referrerPolicy: 'no-referrer', cache: 'no-store' }, o || {})), getKeys: () => keys, onEvent, marketstackCap: () => settings.msCap });
    else src = null;
    if (src) src.prune();
    updateStatus();
  }

  /* ---------- routing ---------- */
  const VIEWS = ['setup', 'list', 'detail', 'portfolio', 'earnings', 'alerts', 'settings'];
  function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
  function route() {
    const h = location.hash || '#/';
    let v = 'list', m, arg = null;
    if (h.startsWith('#/settings')) v = 'settings';
    else if ((m = /^#\/s\/([^/]+)$/.exec(h))) { v = 'detail'; arg = decodeURIComponent(m[1]); }
    else if (h.startsWith('#/portfolio')) v = 'portfolio';
    else if (h.startsWith('#/earnings')) v = 'earnings';
    else if ((m = /^#\/alerts(?:\/([^/]+))?$/.exec(h))) { v = 'alerts'; arg = m[1] ? decodeURIComponent(m[1]) : null; }
    if (!src && v !== 'settings') v = 'setup';
    view = v;
    if (['list', 'portfolio', 'earnings', 'alerts'].includes(v)) lastTab = v;
    VIEWS.forEach(x => { $('#v-' + x).hidden = x !== v; });
    $('#back').hidden = !(v === 'detail' || v === 'settings');
    $('#gear').hidden = v === 'settings';
    $('#tabs').hidden = v === 'setup';
    document.querySelectorAll('#tabs [data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === lastTab); b.setAttribute('aria-current', b.dataset.tab === lastTab ? 'page' : 'false'); });
    if (v !== 'detail') current = null;
    if (src) src.focus(v); // drop queued requests for screens you left, so the visible one goes first
    if (v === 'list') { $('#title').textContent = 'Watchlist'; renderList(); loadList(); }
    if (v === 'setup') $('#title').textContent = 'Set up';
    if (v === 'settings') { $('#title').textContent = 'Settings'; renderSettings(); }
    if (v === 'detail') openDetail(arg);
    if (v === 'portfolio') { $('#title').textContent = 'Portfolio'; renderPortfolio(); loadPortfolio(); }
    if (v === 'earnings') { $('#title').textContent = 'Earnings'; loadEarnings(); }
    if (v === 'alerts') { $('#title').textContent = 'Alerts'; openAlerts(arg); }
    window.scrollTo(0, 0);
  }
  $('#back').onclick = () => { if (sessionStorage.getItem('sw.nav')) history.back(); else go('#/'); }; // deep link: no in-app history to go back to
  $('#gear').onclick = () => go('#/settings');
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab === 'list' ? '#/' : '#/' + b.dataset.tab); });
  window.addEventListener('hashchange', () => { sessionStorage.setItem('sw.nav', '1'); route(); });
  const detailHash = id => '#/s/' + encodeURIComponent(id);

  /* ---------- quotes (shared) ---------- */
  function quoteFor(id) {
    if (!src) return null;
    const { symbol, exchange } = L.parseId(id);
    const q = exchange === 'ASX' ? src.peekAsxQuote(symbol) : src.peekQuote(symbol);
    return q && !q.notFound && !q.unavailable ? q : null;
  }

  /* ---------- list ---------- */
  function rowData(s) {
    const m = market();
    if (m === 'ASX') {
      const q = src ? src.peekAsxQuote(s.symbol) : null, quote = q && !q.notFound ? q : null, hist = src ? src.peekAsxHistory(s.symbol) : null;
      return { symbol: s.symbol, id: L.makeId(s.symbol, 'ASX'), name: s.name || '', price: quote ? quote.price : null, changePct: quote ? quote.changePct : null, date: quote ? quote.date : null,
        marketCap: DEF.ASX.cap[s.symbol] ?? null, liveCap: null, notFound: !!(q && q.notFound), spark: hist && hist.length > 1 ? hist.slice(-22).map(b => b.c) : null };
    }
    const q = src ? src.peekQuote(s.symbol) : null, p = src ? src.peekProfile(s.symbol) : null;
    const quote = q && !q.notFound ? q : null, prof = p && !p.notFound ? p : null;
    const live = L.marketCap(quote, prof, null);
    return { symbol: s.symbol, id: s.symbol, name: s.name || (prof && prof.name) || '', price: quote ? quote.price : null, changePct: quote ? quote.changePct : null,
      marketCap: live ?? DEF.US.cap[s.symbol] ?? null, liveCap: live, notFound: !!(q && q.notFound), spark: src ? src.peekSpark(s.symbol) : null };
  }
  function scheduleRender() {
    if (renderQueued) return; renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; if (view === 'list') renderList(); if (view === 'portfolio') renderPortfolio(); updateStatus(); });
  }
  const shortDate = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? (+m[3]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1] : ''; };
  function renderList() {
    const m = market(), w = wl();
    document.querySelectorAll('[data-market]').forEach(b => { b.classList.toggle('on', b.dataset.market === m); b.setAttribute('aria-selected', String(b.dataset.market === m)); });
    $('#sortKey').value = w.sort.key; $('#sortDir').textContent = w.sort.dir === 'asc' ? '↑' : '↓';
    $('#favFirst').setAttribute('aria-pressed', String(w.favouritesFirst)); $('#editBtn').setAttribute('aria-pressed', String(editMode));
    $('#editBtn').textContent = editMode ? 'Done' : 'Edit';
    $('#pxHead').textContent = m === 'ASX' ? 'Close · Day (A$)' : 'Price · Day';
    $('#addInput').placeholder = m === 'ASX' ? 'ASX code, e.g. WTC' : 'Ticker, e.g. IBM';
    const favs = new Set(w.favourites);
    const all = w.symbols.map(rowData);
    const rows = L.searchRows(L.sortRows(all, w.sort.key, w.sort.dir, { favourites: favs, favouritesFirst: w.favouritesFirst }), query);
    const cur = curOf(m), asxNa = m === 'ASX' && !asxLive();
    // Patch rows in place when the order is unchanged, so a tap on a star isn't lost while prices stream in.
    const parts = r => {
      const dir = L.direction(r.changePct), sp = r.spark && r.spark.length > 1 ? r.spark : null, fav = favs.has(r.symbol);
      const sdir = sp ? L.direction(sp[sp.length - 1] - sp[0]) : 'flat';
      const left = editMode ? `<button class="rm" data-rm="${esc(r.symbol)}" aria-label="Remove ${esc(r.symbol)}" type="button">−</button>`
        : `<button class="star${fav ? ' on' : ''}" data-fav="${esc(r.symbol)}" aria-label="Favourite ${esc(r.symbol)}" aria-pressed="${fav}" type="button">${fav ? '★' : '☆'}</button>`;
      let sub = r.notFound ? '<span class="err-t">No price found. Check the ticker.</span>' : rowErr[r.id] ? `<span class="err-t">${esc(rowErr[r.id])}</span>`
        : esc(r.name) + (r.liveCap ? ' · ' + L.fmtBig(r.liveCap) : '');
      if (m === 'ASX' && !r.notFound && !rowErr[r.id]) sub = esc(r.name) + (r.date ? ' · close ' + shortDate(r.date) : '');
      const px = asxNa ? `<div class="px"><div class="price na" data-na="1">n/a</div><span class="pill flat">no free source</span></div>`
        : `<div class="px"><div class="price">${L.fmtPrice(r.price, cur)}</div><span class="pill ${dir}">${L.fmtPct(r.changePct)}</span></div>`;
      return [left, `<div class="min0"><div class="tk">${esc(r.symbol)}</div><div class="nm">${sub}</div></div>`,
        sp ? `<svg class="spark ${sdir}" viewBox="0 0 72 28" preserveAspectRatio="none" aria-hidden="true"><path d="${L.sparkPath(sp, 72, 28)}"/></svg>` : '<div class="spark-empty" aria-hidden="true"></div>', px];
    };
    const list = $('#list'), curEls = [...list.children], next = rows.map(parts);
    const key = m + ':';
    if (curEls.length === rows.length && curEls.every((li, i) => li.dataset.key === key + rows[i].symbol)) {
      curEls.forEach((li, i) => { const old = li._p || []; next[i].forEach((h, j) => { if (old[j] !== h) li.children[j].outerHTML = h; }); li._p = next[i]; });
    } else {
      list.innerHTML = rows.map((r, i) => `<li data-sym="${esc(r.symbol)}" data-key="${esc(key + r.symbol)}">${next[i].join('')}</li>`).join('');
      [...list.children].forEach((li, i) => { li._p = next[i]; });
    }
    $('#listEmpty').hidden = rows.length > 0;
    $('#listNote').textContent = m === 'US' && src && !src.demo && !hasKey('twelvedata') ? 'Sparklines and charts need a free Twelve Data key (Settings).'
      : m === 'ASX' ? 'ASX list: the three portfolio ETFs plus the top 20 ASX companies by market cap (snapshot ' + (DEF.ASX.meta.asOf || '?') + '). Prices are end-of-day closes in AUD.' : '';
    renderOverview(all);
    renderAsxBar();
    updateStatus();
  }
  function renderOverview(rows) {
    const m = market(), el = $('#overview');
    if (!src) { el.innerHTML = ''; return; }
    const tile = (name, proxy, id, q, cur) => `<div class="ov-tile" data-go="${esc(id)}" role="button" tabindex="0"><div class="n">${esc(name)}</div><div class="p">${esc(proxy)}</div>` +
      `<div class="v">${q ? L.fmtPrice(q.price, cur) : '—'}</div><span class="pill ${L.direction(q && q.changePct)}" data-ov-pct="${esc(id)}">${L.fmtPct(q && q.changePct)}</span></div>`;
    let tiles;
    if (m === 'US') tiles = PROXIES.map(p => tile(p.name, p.proxy, p.sym, quoteFor(p.sym), 'USD')).join('');
    else {
      const q = asxLive() ? quoteFor('ASX:' + ASX_PROXY.code) : null;
      tiles = asxLive() ? tile(ASX_PROXY.name, ASX_PROXY.proxy, 'ASX:' + ASX_PROXY.code, q, 'AUD')
        : `<div class="ov-tile na-tile"><div class="n">${ASX_PROXY.name}</div><div class="p">${ASX_PROXY.proxy}</div><div class="v na">n/a</div></div>`;
      tiles += `<div class="ov-tile na-tile" style="grid-column: span 2"><div class="p" style="white-space:normal">${asxLive() ? 'ASX 200 shown via the STW ETF (end-of-day close). Index points aren\u2019t on any free tier.' : 'Needs a free Marketstack key for end-of-day closes. No free source has live ASX prices.'}</div></div>`;
    }
    const mv = L.topMovers(rows, 5);
    const ol = arr => arr.length ? `<ol>${arr.map(r => `<li data-go="${esc(r.id)}"><b>${esc(r.symbol)}</b><span class="${L.direction(r.changePct)}-t">${L.fmtPct(r.changePct)}</span></li>`).join('')}</ol>` : '<p class="small muted" style="margin:0">—</p>';
    const anyQuotes = rows.some(r => L.isNum(r.changePct));
    el.innerHTML = `<div class="ov-tiles">${tiles}</div>` +
      (anyQuotes ? `<div class="movers"><div id="gainers"><h3>Top gainers${m === 'ASX' ? ' (EOD)' : ''}</h3>${ol(mv.gainers)}</div><div id="losers"><h3>Top losers${m === 'ASX' ? ' (EOD)' : ''}</h3>${ol(mv.losers)}</div></div>`
        : `<div class="ov-note">${m === 'ASX' && !asxLive() ? 'Top movers: n/a without ASX prices.' : 'Top movers in your watchlist appear once prices load.'}</div>`) +
      (m === 'ASX' && !anyQuotes ? '' : `<div class="ov-note">${m === 'US' ? 'Index levels aren\u2019t on the free tiers, so the ETFs that track them are shown as proxies (ETF prices in USD, not index points).' : 'Movers are from your ASX list, by latest end-of-day change.'}${src.demo ? ' DEMO numbers.' : ''}</div>`);
  }
  function renderAsxBar() {
    const el = $('#asxBar');
    if (market() !== 'ASX' || !src) { el.hidden = true; return; }
    el.hidden = false;
    if (src.demo) { el.innerHTML = '<p><b>DEMO</b>: synthetic end-of-day closes in AUD. With real keys, ASX prices come from Marketstack (end-of-day only).</p>'; return; }
    if (!hasKey('marketstack')) {
      el.innerHTML = `<p><b>ASX prices: n/a.</b> We couldn\u2019t find a free source with live ASX quotes that a web app can call: Twelve Data and Finnhub free plans cover US markets only. A free Marketstack key gives end-of-day closes (100 requests a month).</p><button type="button" class="ghost wide" id="asxSettings">Add a Marketstack key in Settings</button>`;
      return;
    }
    const codes = wl('ASX').symbols.map(s => s.symbol).concat(ASX_PROXY.code), cost = src.asxCost(codes), b = src.asxBudget();
    const can = cost > 0 && cost <= b.left;
    el.innerHTML = `<p>End-of-day closes from Marketstack. Each ticker costs 1 request: <b id="msLeft">${b.left} of ${b.cap}</b> left this month on this device. Closes are kept until the next ASX close is out (after 6 pm Sydney time on trading days).</p>` +
      `<button type="button" class="primary wide" id="asxLoad" ${can ? '' : 'disabled'}>${cost === 0 ? 'All closes are up to date' : can ? `Load closes for ${cost} tickers (uses ${cost} requests)` : `Not enough requests left (${cost} needed)`}</button>`;
  }
  $('#asxBar').addEventListener('click', e => {
    if (e.target.closest('#asxSettings')) { go('#/settings'); return; }
    if (e.target.closest('#asxLoad')) {
      const codes = wl('ASX').symbols.map(s => s.symbol).concat(ASX_PROXY.code);
      $('#asxLoad').disabled = true; $('#asxLoad').textContent = 'Loading…';
      src.asxQuotes(codes, { prio: 3, view: 'list-asx', onUpdate: scheduleRender })
        .then(r => { banner('Loaded ' + r.requested + ' ASX end-of-day closes.', 'info', 4000); checkAlerts(); })
        .catch(err => { if (err.type !== 'cancelled') banner(err.message, 'error'); })
        .finally(scheduleRender);
    }
  });
  $('#overview').addEventListener('click', e => { const t = e.target.closest('[data-go]'); if (t) go(detailHash(t.dataset.go)); });
  document.querySelectorAll('[data-market]').forEach(b => { b.onclick = () => { settings.market = b.dataset.market; saveSettings(); editMode = false; if (src) src.focus(market() === 'ASX' ? 'list-asx' : 'list'); query = ''; $('#search').value = ''; $('#addForm').hidden = true; renderList(); loadList(); }; });
  function visibleOrder() { return [...document.querySelectorAll('#list li')].map(li => li.dataset.sym); }
  function loadList(force) {
    if (!src) return;
    if (market() === 'ASX') { renderList(); return; } // ASX closes only load when you tap the button (monthly budget)
    PROXIES.forEach(p => src.quote(p.sym, { force, prio: 2, view: 'list' }).then(r => { if (r.value && r.value.t) noteAsOf(r.value.t); scheduleRender(); }).catch(() => {}));
    const order = visibleOrder().length ? visibleOrder() : wl('US').symbols.map(s => s.symbol);
    order.forEach((s, i) => {
      src.quote(s, { force, prio: i < 15 ? 3 : 4, view: 'list' }).then(r => { delete rowErr[s]; if (r.value && r.value.t) noteAsOf(r.value.t); if (r.error && !['rate-limit', 'cancelled'].includes(r.error.type)) rowErr[s] = r.error.message; scheduleRender(); queueAlertCheck(); })
        .catch(e => { if (e.type !== 'cancelled' && e.type !== 'rate-limit') rowErr[s] = e.type === 'nokey' ? 'Add a key in Settings' : e.message; scheduleRender(); });
    });
    order.forEach(s => src.profile(s, { view: 'list' }).then(r => { if (r.value && r.value.name && L.setName(wl('US'), s, r.value.name)) saveWl('US'); scheduleRender(); }).catch(() => {}));
    src.sparklines(order, scheduleRender, 'list').catch(() => {});
    updateStatus();
  }
  function tick(force) {
    if (!src || document.visibilityState !== 'visible') return;
    if (view === 'list') loadList(force);
    if (view === 'portfolio') loadPortfolio(force);
    refreshAlertQuotes();
  }
  function startRefresh() {
    clearInterval(refreshTimer);
    if (settings.refreshSec > 0) refreshTimer = setInterval(() => tick(false), settings.refreshSec * 1000);
  }
  setInterval(updateStatus, 3000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(false); });

  $('#search').addEventListener('input', e => { query = e.target.value; renderList(); });
  $('#sortKey').addEventListener('change', e => { wl().sort.key = e.target.value; wl().sort.dir = e.target.value === 'symbol' ? 'asc' : 'desc'; saveWl(); renderList(); });
  $('#sortDir').onclick = () => { wl().sort.dir = wl().sort.dir === 'asc' ? 'desc' : 'asc'; saveWl(); renderList(); };
  $('#favFirst').onclick = () => { wl().favouritesFirst = !wl().favouritesFirst; saveWl(); renderList(); };
  $('#editBtn').onclick = () => { editMode = !editMode; renderList(); };
  $('#refresh').onclick = () => {
    if (market() === 'ASX') { banner(src && !src.demo && hasKey('marketstack') ? 'ASX closes change once a day. Use the Load button above (each ticker costs 1 Marketstack request).' : 'ASX prices are end-of-day only.', 'info', 5000); return; }
    loadList(true); refreshAlertQuotes(); banner('Refreshing prices (rate-limited to stay inside the free tier)…', 'info', 3000);
  };
  $('#addBtn').onclick = () => { $('#addForm').hidden = !$('#addForm').hidden; if (!$('#addForm').hidden) $('#addInput').focus(); $('#addMsg').textContent = ''; };
  $('#addCancel').onclick = () => { $('#addForm').hidden = true; $('#addMsg').textContent = ''; };
  $('#addForm').addEventListener('submit', e => {
    e.preventDefault();
    const m = market(), raw = $('#addInput').value, sym = m === 'ASX' ? L.normalizeAsx(raw) : L.normalizeSymbol(raw);
    try {
      if (!L.addSymbol(wl(), raw, undefined, m)) { $('#addMsg').textContent = sym + ' is already in your ' + m + ' watchlist.'; return; }
    } catch (err) { $('#addMsg').textContent = err.message; return; }
    saveWl(); $('#addInput').value = ''; $('#addMsg').textContent = 'Added ' + sym + '.';
    query = ''; $('#search').value = ''; renderList(); loadList();
  });
  $('#list').addEventListener('click', e => {
    const fav = e.target.closest('[data-fav]'), rm = e.target.closest('[data-rm]'), li = e.target.closest('li[data-sym]');
    if (fav) { L.toggleFavourite(wl(), fav.dataset.fav); saveWl(); renderList(); return; }
    if (rm) { L.removeSymbol(wl(), rm.dataset.rm); saveWl(); renderList(); return; }
    if (li && !editMode) go(detailHash(L.makeId(li.dataset.sym, market())));
  });

  /* ---------- detail ---------- */
  const chart = window.SWChart.PriceChart($('#chart'), {
    formatTime: (d, intraday) => L.fmtBarTime(d, intraday),
    onHover: (bar) => { const t = $('#chartTip'); if (bar) { t.textContent = L.fmtPrice(bar.c, current && curOf(current.exchange)) + ' · ' + L.fmtBarTime(bar.d, isIntraday()); t.classList.add('on'); } else { t.textContent = 'Touch and drag on the chart to see price and date'; t.classList.remove('on'); } }
  });
  const ASX_RANGES = ['1M', '6M', '1Y'];
  const effRange = () => (current && current.exchange === 'ASX' && !ASX_RANGES.includes(settings.range) ? '1Y' : settings.range);
  const isIntraday = () => effRange() === '1D' || effRange() === '5D';
  $('#ranges').innerHTML = L.RANGE_ORDER.map(r => `<button type="button" role="tab" data-range="${r}">${r}</button>`).join('');
  $('#ranges').addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (b && !b.disabled && current) { settings.range = b.dataset.range; saveSettings(); loadChart(); } });
  let currentDetailState = null;
  function openDetail(id) {
    const { symbol, exchange } = L.parseId(id);
    current = { id: L.makeId(symbol, exchange), symbol, exchange }; const token = ++detailToken;
    const entry = wl(exchange).symbols.find(s => s.symbol === symbol) || DEF[exchange].list.find(s => s.symbol === symbol);
    const proxy = PROXIES.find(p => p.sym === symbol);
    $('#title').textContent = exchange === 'ASX' ? symbol + ' · ASX' : symbol;
    $('#dName').textContent = (entry && entry.name) || (proxy ? proxy.name + ' (' + proxy.proxy + ')' : '');
    $('#dPrice').textContent = '—'; $('#dChange').textContent = ''; $('#dRangeChange').textContent = '';
    $('#dRemove').hidden = !wl(exchange).symbols.some(s => s.symbol === symbol); renderFav();
    $('#ratings').innerHTML = $('#targets').innerHTML = '<span class="muted small">Loading…</span>'; $('#metrics').innerHTML = ''; $('#news').innerHTML = '<li class="muted small">Loading…</li>';
    document.querySelectorAll('#ranges button').forEach(b => { b.disabled = exchange === 'ASX' && !ASX_RANGES.includes(b.dataset.range); });
    $('#dNote').hidden = exchange !== 'ASX';
    updateStatus();
    if (exchange === 'ASX') return openAsxDetail();
    const ok = fn => r => { if (token === detailToken) fn(r); };
    const fail = (el) => e => { if (token === detailToken && el && e.type !== 'cancelled') el.innerHTML = `<span class="err-t">${esc(e.message)}</span>`; };
    const st = { quote: null, profile: null, metrics: null };
    const redrawMetrics = () => renderMetrics(symbol, st);
    const o = p => ({ prio: p, view: 'detail' });
    src.quote(symbol, o(0)).then(ok(r => { st.quote = r.value && !r.value.notFound ? r.value : null; renderQuote(r); noteAsOf(st.quote && st.quote.t); redrawMetrics(); queueAlertCheck(); })).catch(fail($('#dChange')));
    src.profile(symbol, o(0)).then(ok(r => { st.profile = r.value && !r.value.notFound ? r.value : null; if (st.profile && st.profile.name && !proxy) $('#dName').textContent = st.profile.name; redrawMetrics(); })).catch(() => {});
    src.metrics(symbol, o(1)).then(ok(r => { st.metrics = r.value; redrawMetrics(); })).catch(fail($('#metrics')));
    src.earnings(symbol, o(2)).then(ok(r => { st.earnings = r.value; redrawMetrics(); })).catch(ok(e => { st.earnings = { error: e.message }; redrawMetrics(); }));
    src.recommendation(symbol, o(1)).then(ok(r => renderRatings(r.value))).catch(fail($('#ratings')));
    src.priceTarget(symbol, o(2)).then(ok(r => renderTargets(r.value))).catch(fail($('#targets')));
    src.news(symbol, o(2)).then(ok(r => renderNews(r.value, r))).catch(ok(e => { if (e.type !== 'cancelled') $('#news').innerHTML = `<li class="${e.type === 'premium' ? 'na' : 'err-t'}">${esc(e.type === 'premium' ? L.NA_FREE : e.message)}</li>`; }));
    st.chartLoaded = () => redrawMetrics();
    currentDetailState = st;
    loadChart();
  }
  function openAsxDetail() {
    currentDetailState = null;
    $('#dNote').textContent = 'ASX: end-of-day closes in AUD' + (src.demo ? ' (DEMO)' : ' from Marketstack') + '. Intraday (1D, 5D) and 5Y history aren\u2019t available on a free tier. Ratings, price targets, most metrics, news and earnings dates are n/a: ' + ASX_FREE_GAP + '.';
    const na = `<span class="na">n/a: ${ASX_FREE_GAP}</span>`;
    $('#ratings').innerHTML = na;
    $('#targets').innerHTML = ['Average', 'High', 'Low'].map(k => `<div class="kv"><span class="muted">${k}</span><span class="na" data-target="${k.toLowerCase()}">n/a (not on free tier for ASX)</span></div>`).join('');
    $('#news').innerHTML = `<li class="na" id="newsNa">n/a: Finnhub\u2019s free company news covers North American companies only.</li>`;
    renderAsxMetrics(null);
    loadChart();
  }
  function renderAsxMetrics(bars) {
    const NA = L.NA_FREE;
    const y = bars && bars.length ? bars.slice(-252) : null, last = bars && bars.length ? bars[bars.length - 1] : null;
    const items = [
      ['52-week high (closes)', y && y.length > 200 ? L.fmtPrice(Math.max(...y.map(b => b.c)), 'AUD') : bars ? 'n/a (not enough history)' : '…'],
      ['52-week low (closes)', y && y.length > 200 ? L.fmtPrice(Math.min(...y.map(b => b.c)), 'AUD') : bars ? 'n/a (not enough history)' : '…'],
      ['Volume (last session)', last && L.isNum(last.v) ? L.fmtVolume(last.v) : bars ? L.NA_NONE : '…'],
      ['Market cap', NA], ['P/E (trailing)', NA], ['EPS (TTM)', NA], ['Dividend yield', NA], ['Beta', NA], ['Next earnings', NA]
    ];
    if (!src.demo && !hasKey('marketstack')) items.slice(0, 3).forEach(i => { i[1] = 'n/a (needs Marketstack key)'; });
    $('#metrics').innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd class="${/^n\/a/.test(v) ? 'na' : ''}" data-metric="${esc(k)}">${esc(v)}</dd></div>`).join('');
  }
  function renderFav() {
    if (!current) return;
    const on = wl(current.exchange).favourites.includes(current.symbol);
    $('#dFav').textContent = on ? '★' : '☆'; $('#dFav').classList.toggle('on', on); $('#dFav').setAttribute('aria-pressed', String(on));
  }
  $('#dFav').onclick = () => {
    const w = wl(current.exchange);
    if (!w.symbols.some(s => s.symbol === current.symbol)) L.addSymbol(w, current.symbol, undefined, current.exchange);
    L.toggleFavourite(w, current.symbol); saveWl(current.exchange); renderFav(); $('#dRemove').hidden = false;
  };
  $('#dRemove').onclick = () => { L.removeSymbol(wl(current.exchange), current.symbol); saveWl(current.exchange); go('#/'); };
  $('#dAlert').onclick = () => go('#/alerts/' + encodeURIComponent(current.id));
  function renderQuote(r) {
    const q = r.value, cur = curOf(current.exchange);
    if (!q || q.notFound) { $('#dPrice').textContent = '—'; $('#dChange').innerHTML = '<span class="err-t">No price found for this ticker.</span>'; return; }
    $('#dPrice').textContent = L.fmtPrice(q.price, cur);
    const d = L.direction(q.change);
    const when = q.eod ? (src.demo ? ' · DEMO end-of-day' : ' · end-of-day close, ' + esc(L.fmtBarTime(q.date))) : (src.demo ? ' · DEMO' : ' · delayed, as of ' + esc(L.fmtAsOf(q.t)));
    $('#dChange').innerHTML = `<span class="${d}-t">${L.fmtChange(q.change)} (${L.fmtPct(q.changePct)})</span> <span class="muted small">${q.eod ? 'vs previous close' : 'today'}${when}${r.fresh === false ? ' · cached' : ''}</span>`;
  }
  function loadChart() {
    const range = effRange(), c = current, token = detailToken;
    document.querySelectorAll('#ranges button').forEach(b => { b.classList.toggle('on', b.dataset.range === range); b.setAttribute('aria-selected', String(b.dataset.range === range)); });
    $('#chartMsg').textContent = ''; $('#dRangeChange').textContent = '';
    chart.set([], { message: 'Loading chart…', demo: src.demo, range });
    const stale = () => token !== detailToken || range !== effRange();
    if (c.exchange === 'ASX') {
      if (!src.demo && !hasKey('marketstack')) {
        chart.set([], { message: 'ASX prices: n/a without a Marketstack key', demo: false, range });
        $('#dPrice').innerHTML = '<span class="na" style="font-size:16px">n/a</span>';
        $('#dChange').innerHTML = '<span class="muted small">No free source has live ASX prices. Add a free Marketstack key in Settings for end-of-day closes.</span>';
        renderAsxMetrics(null); return;
      }
      src.asxHistory(c.symbol, { prio: 0, view: 'detail' }).then(r => {
        if (stale()) return;
        const bars = r.value || [];
        const q = bars.length ? L.eodQuote(bars) : null;
        renderQuote({ value: q || { notFound: true }, fresh: r.fresh });
        chart.set(L.sliceRange(bars, range), { intraday: false, range, demo: src.demo, message: 'No end-of-day data for this range' });
        const ch = L.rangeChange(L.sliceRange(bars, range));
        if (ch) $('#dRangeChange').innerHTML = `<span class="${L.direction(ch.change)}-t">${L.fmtPct(ch.changePct)}</span> over ${range} (end-of-day closes${src.demo ? ', DEMO' : ''})`;
        renderAsxMetrics(bars);
        $('#chartMsg').textContent = (r.fresh === false ? 'Showing cached closes (' + (r.error && r.error.message) + '). ' : '') + (src.demo ? '' : 'History: 1 Marketstack request, kept until the next close. ' + src.asxBudget().left + ' requests left this month.');
        queueAlertCheck();
      }).catch(e => {
        if (stale() || e.type === 'cancelled') return;
        chart.set([], { message: e.type === 'budget' ? 'Monthly Marketstack budget used' : 'Chart unavailable', demo: src.demo, range });
        $('#chartMsg').textContent = e.message; renderAsxMetrics([]);
        $('#dPrice').innerHTML = '<span class="na" style="font-size:16px">n/a</span>';
      });
      return;
    }
    src.candles(c.symbol, range, { prio: 0, view: 'detail' }).then(r => {
      if (stale()) return;
      const bars = L.sliceRange(r.value, range);
      const q = src.peekQuote(c.symbol);
      chart.set(bars, { intraday: range === '1D' || range === '5D', range, demo: src.demo, baseline: range === '1D' && q && q.prevClose ? q.prevClose : null, message: 'No chart data for this range' });
      const ch = L.rangeChange(bars);
      if (ch) $('#dRangeChange').innerHTML = `<span class="${L.direction(ch.change)}-t">${L.fmtPct(ch.changePct)}</span> over ${range} (chart${src.demo ? ', DEMO' : ', times ET'})`;
      $('#chartMsg').textContent = r.fresh === false ? 'Showing cached chart (could not refresh: ' + (r.error && r.error.message) + ')' : '';
      if (currentDetailState && currentDetailState.chartLoaded) currentDetailState.chartLoaded();
    }).catch(e => {
      if (stale() || e.type === 'cancelled') return;
      chart.set([], { message: e.type === 'nokey' ? 'Charts need a free Twelve Data key' : e.type === 'rate-limit' ? 'Rate limit reached. Try again shortly.' : 'Chart unavailable', demo: src.demo, range });
      $('#chartMsg').textContent = e.message;
    });
  }
  function renderNews(items, r) {
    const el = $('#news');
    if (!items || items.unavailable) { el.innerHTML = `<li class="na">${L.NA_FREE}</li>`; return; }
    if (!items.length) { el.innerHTML = '<li class="muted small">No company news in the last 7 days.</li>'; return; }
    el.innerHTML = items.map(n => `<li>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a>` : `<span class="hl">${esc(n.headline)}</span>`}` +
      `<div class="meta">${esc(n.source)} · ${esc(L.fmtAgo(n.t))}${n.demo ? ' · DEMO, no link' : ''}</div></li>`).join('') +
      (r && r.fresh === false ? '<li class="muted small">Cached news (could not refresh).</li>' : '');
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

  /* ---------- portfolio ---------- */
  const savePf = () => L.savePortfolio(store, pf);
  const fmtUnits = n => (L.isNum(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—');
  function renderPortfolio() {
    if (!src) return;
    const fx = src.peekFx(), sum = L.portfolioSummary(pf.holdings, quoteFor, fx), t = sum.total;
    const prompt = $('#pfPrompt');
    prompt.hidden = !sum.needsInput.length;
    prompt.innerHTML = `<p><b>Enter your units and average cost</b> for ${esc(sum.needsInput.join(', '))} to see value and gain. Tap a holding below to edit it. Nothing is filled in for you.</p>`;
    const signed = (v, pct) => v === null ? '—' : `<span class="${L.direction(v)}-t">${L.fmtSignedMoney(v, 'AUD')}${pct !== null && pct !== undefined ? ' (' + L.fmtPct(pct) + ')' : ''}</span>`;
    const anyUnits = pf.holdings.some(h => h.units > 0);
    $('#pfValue').textContent = t.value === null || !anyUnits ? '—' : L.fmtPrice(t.value, 'AUD');
    $('#pfCost').textContent = t.cost === null ? '—' : L.fmtPrice(t.cost, 'AUD');
    $('#pfGain').innerHTML = signed(t.gain, t.gainPct);
    $('#pfDay').innerHTML = signed(t.dayChange, t.dayPct);
    let fxTxt = '';
    if (sum.needsFx) fxTxt = fx ? `USD→AUD ${fx.rate.toFixed(4)} · ${esc(fx.source)}${fx.demo ? '' : fx.live ? ', as of ' + esc(L.fmtAsOf(fx.t)) : ', ' + esc(L.fmtBarTime(fx.date)) + ' (daily)'}` : 'USD→AUD rate: loading…';
    $('#pfFx').innerHTML = fxTxt;
    const notes = [];
    if (src.demo) notes.push('DEMO prices and rate (synthetic). Your units and costs are your own entries.');
    if (!src.demo && !hasKey('marketstack') && pf.holdings.some(h => h.exchange === 'ASX' && h.units > 0)) notes.push('ASX values: n/a. No free source has live ASX prices; add a free Marketstack key (Settings) for end-of-day closes.');
    if (sum.missing.length) notes.push('Not in the total (no price yet): ' + sum.missing.join(', ') + '.');
    if (sum.fxMissing) notes.push('US holdings are left out until a USD/AUD rate loads.');
    $('#pfNote').innerHTML = notes.map(esc).join('<br>');
    $('#pfList').innerHTML = sum.rows.map(r => {
      const cur = r.currency, priceTxt = r.price === null ? (r.exchange === 'ASX' && !asxLive() ? 'n/a' : '—') : L.fmtPrice(r.price, cur) + (r.exchange === 'ASX' ? ' close' : '');
      const right = r.needsInput && !(r.units > 0) ? '<span class="needs">Enter units and cost</span>' : r.value === null ? '<span class="na">n/a</span>' : `<b>${L.fmtPrice(r.value, 'AUD')}</b>`;
      const gain = r.avgCost === null ? '<span class="needs">Add average cost</span>' : r.gain === null ? '—' : `<span class="${L.direction(r.gain)}-t">${L.fmtSignedMoney(r.gain, 'AUD')} (${L.fmtPct(r.gainPct)})</span>`;
      return `<li data-hid="${esc(r.id)}"><div class="pf-row"><span><span class="tk">${esc(r.symbol)}</span><span class="xchip">${r.exchange}</span></span>${right}</div>` +
        `<div class="pf-sub"><span>${fmtUnits(r.units)} × ${priceTxt}${r.avgCost !== null ? ' · cost ' + L.fmtPrice(r.avgCost, cur) : ''}</span><span data-gain="${esc(r.id)}">${r.units > 0 ? gain : ''}</span></div>` +
        `<div class="pf-sub"><span>${r.dayChange !== null ? 'Today ' + `<span class="${L.direction(r.dayChange)}-t">${L.fmtSignedMoney(r.dayChange, 'AUD')}</span>` : r.units > 0 ? 'Today —' : ''}${r.buyDate ? ' · bought ' + esc(L.fmtBarTime(r.buyDate)) : ''}</span><span data-weight="${esc(r.id)}">${r.weight !== null && r.units > 0 ? r.weight.toFixed(1) + '% of total' : ''}</span></div>` +
        (r.weight !== null && r.units > 0 ? `<div class="wbar"><span style="width:${Math.min(100, r.weight).toFixed(1)}%"></span></div>` : '') + '</li>';
    }).join('') || '<li class="muted">No holdings. Tap ＋ Holding.</li>';
  }
  function loadPortfolio(force) {
    if (!src) return;
    const us = pf.holdings.filter(h => h.exchange === 'US'), asx = pf.holdings.filter(h => h.exchange === 'ASX' && h.units > 0).map(h => h.symbol);
    us.forEach(h => src.quote(h.symbol, { force, prio: 3, view: 'portfolio' }).then(r => { if (r.value && r.value.t) noteAsOf(r.value.t); scheduleRender(); queueAlertCheck(); }).catch(() => {}));
    if (asx.length && asxLive()) src.asxQuotes(asx, { prio: 3, view: 'portfolio', onUpdate: scheduleRender }).then(() => { scheduleRender(); queueAlertCheck(); })
      .catch(e => { if (e.type !== 'cancelled') { $('#pfNote').textContent = 'ASX closes: ' + e.message; } });
    if (us.some(h => h.units > 0)) src.fx({ prio: 3 }).then(scheduleRender).catch(e => { if (e.type !== 'cancelled') $('#pfFx').textContent = 'USD→AUD rate unavailable: ' + e.message; });
  }
  function openPfForm(h) {
    pfEditId = h ? h.id : null;
    const f = $('#pfForm'); f.hidden = false; $('#pfMsg').textContent = '';
    $('#pfFormTitle').textContent = h ? 'Edit ' + h.symbol + ' (' + h.exchange + ')' : 'Add holding';
    f.symbol.value = h ? h.symbol : ''; f.exchange.value = h ? h.exchange : 'ASX';
    f.symbol.disabled = f.exchange.disabled = !!h;
    f.units.value = h && h.units ? h.units : ''; f.avgCost.value = h && h.avgCost !== null ? h.avgCost : ''; f.buyDate.value = h ? h.buyDate : '';
    f.buyDate.max = today();
    $('#pfCur').textContent = f.exchange.value === 'US' ? 'US$' : 'A$';
    $('#pfDelete').hidden = !h;
    (h ? f.units : f.symbol).focus();
    f.scrollIntoView({ block: 'center' });
  }
  $('#pfAddBtn').onclick = () => openPfForm(null);
  $('#pfRefresh').onclick = () => { loadPortfolio(true); banner('Refreshing portfolio prices…', 'info', 2500); };
  $('#pfCancel').onclick = () => { $('#pfForm').hidden = true; pfEditId = null; };
  $('#pfForm').exchange.addEventListener('change', e => { $('#pfCur').textContent = e.target.value === 'US' ? 'US$' : 'A$'; });
  $('#pfList').addEventListener('click', e => { const li = e.target.closest('[data-hid]'); if (li) openPfForm(pf.holdings.find(h => h.id === li.dataset.hid)); });
  $('#pfDelete').onclick = () => { if (!pfEditId || !confirm('Remove this holding from the portfolio?')) return; L.removeHolding(pf, pfEditId); savePf(); $('#pfForm').hidden = true; pfEditId = null; renderPortfolio(); };
  $('#pfForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target, data = { units: f.units.value, avgCost: f.avgCost.value, buyDate: f.buyDate.value };
    try {
      if (pfEditId) L.updateHolding(pf, pfEditId, data, today());
      else L.addHolding(pf, Object.assign({ symbol: f.symbol.value, exchange: f.exchange.value }, data), today());
    } catch (err) { $('#pfMsg').textContent = err.message; return; }
    savePf(); f.hidden = true; pfEditId = null; renderPortfolio(); loadPortfolio();
  });

  /* ---------- earnings ---------- */
  function loadEarnings() {
    const info = $('#earnInfo'), list = $('#earnList');
    const wlSyms = new Set(wl('US').symbols.map(s => s.symbol)), pfSyms = new Set(pf.holdings.filter(h => h.exchange === 'US').map(h => h.symbol));
    const all = new Set([...wlSyms, ...pfSyms]);
    info.innerHTML = `Upcoming earnings in the next 14 days for your ${all.size} US watchlist and portfolio tickers${src.demo ? ' (<b>DEMO</b> dates and estimates)' : ', from Finnhub\u2019s free earnings calendar (dates are US Eastern)'}.` +
      ` <span class="muted">ASX earnings dates: n/a. No free source covers them.${pf.holdings.some(h => h.exchange === 'ASX') ? ' Your ASX holdings aren\u2019t included.' : ''}</span>`;
    list.innerHTML = '<p class="muted pad">Loading…</p>';
    src.earningsCalendar({ prio: 2, view: 'earnings' }).then(r => {
      if (view !== 'earnings') return;
      const from = L.usDate(Date.now()), to = L.usDate(Date.now(), 14);
      const up = L.upcomingEarnings(r.value || [], all, from, to), groups = L.groupByDate(up);
      if (!groups.length) { list.innerHTML = '<p class="muted pad" id="earnEmpty">No earnings for your tickers in the next 14 days.</p>'; return; }
      const dayLbl = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      list.innerHTML = groups.map(g => `<div class="earn-day"><h3>${esc(dayLbl(g.date))}</h3>` + g.items.map(e =>
        `<div class="earn-item" data-go="${esc(e.symbol)}" data-earn="${esc(e.symbol)}"><div><span class="tk">${esc(e.symbol)}</span>${wlSyms.has(e.symbol) ? '<span class="tag">watchlist</span>' : ''}${pfSyms.has(e.symbol) ? '<span class="tag">portfolio</span>' : ''}` +
        `<div class="sub">${esc(L.HOUR_LABEL[e.hour] || L.HOUR_LABEL[''])}</div></div><div class="r"><div class="sub">EPS estimate</div><b>${L.isNum(e.epsEstimate) ? '$' + e.epsEstimate.toFixed(2) : '<span class="na">n/a</span>'}</b></div></div>`).join('') + '</div>').join('') +
        (r.fresh === false ? '<p class="muted small pad">Cached calendar (could not refresh).</p>' : '');
    }).catch(e => { if (e.type !== 'cancelled') list.innerHTML = `<p class="pad ${e.type === 'premium' ? 'na' : 'err-t'}">${esc(e.type === 'premium' ? L.NA_FREE : e.message)}</p>`; });
  }
  $('#earnList').addEventListener('click', e => { const t = e.target.closest('[data-go]'); if (t) go(detailHash(t.dataset.go)); });

  /* ---------- alerts ---------- */
  const saveAlerts = () => L.saveAlerts(store, alerts);
  function updateBadge() { const n = L.unseenAlerts(alerts); $('#alertBadge').hidden = !n; $('#alertBadge').textContent = n > 99 ? '99+' : String(n); }
  let alertTimer = null;
  function queueAlertCheck() { clearTimeout(alertTimer); alertTimer = setTimeout(checkAlerts, 300); }
  function checkAlerts() {
    if (!src || !alerts.rules.length) return [];
    const quotes = {};
    alerts.rules.forEach(r => { const q = quoteFor(r.sym); if (q) quotes[r.sym] = q; });
    const fired = L.evaluateAlerts(alerts, quotes, Date.now(), { demo: src.demo });
    saveAlerts();
    if (fired.length) {
      banner('🔔 ' + L.alertMessage(fired[0]) + (fired.length > 1 ? ` (+${fired.length - 1} more)` : ''), 'info', 15000);
      fired.slice(0, 3).forEach(notify);
      if (view === 'alerts') renderAlerts(); else updateBadge();
    }
    return fired;
  }
  function refreshAlertQuotes() {
    if (!src) return;
    const us = [...new Set(alerts.rules.filter(r => r.enabled && !r.sym.startsWith('ASX:')).map(r => r.sym))];
    if (!us.length) { queueAlertCheck(); return; }
    Promise.allSettled(us.map(s => src.quote(s, { prio: 5 }))).then(() => { if (view === 'list') scheduleRender(); checkAlerts(); });
  }
  function notify(e) {
    window.__app.notifyCount = (window.__app.notifyCount || 0) + 1;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const body = L.alertMessage(e), opts = { body, tag: e.id, icon: 'icons/icon-192.png' };
    const fallback = () => { try { new Notification('Price alert', opts); } catch (err) { /* not allowed outside a service worker (e.g. iOS) */ } };
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(reg => reg.showNotification('Price alert', opts)).catch(fallback);
    else fallback();
  }
  function renderNotif() {
    const st = $('#notifState'), btn = $('#notifBtn');
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!('Notification' in window)) { st.textContent = 'Notifications aren\u2019t available in this browser view. On iPhone they need the app added to the Home Screen (iOS 16.4 or later). Alerts still show as a badge and a banner.'; btn.hidden = true; return; }
    if (Notification.permission === 'granted') { st.textContent = 'Notifications are on: you\u2019ll get one when an alert fires while the app is open.'; btn.hidden = true; return; }
    if (Notification.permission === 'denied') { st.textContent = 'Notifications are blocked for this app in your device settings. Alerts still show as a badge and a banner.'; btn.hidden = true; return; }
    st.textContent = 'Optional: allow notifications so a fired alert also shows as a system notification (only while the app is open).' + (standalone ? '' : ' On iPhone, add the app to the Home Screen first.');
    btn.hidden = false;
  }
  $('#notifBtn').onclick = () => { try { Notification.requestPermission().then(renderNotif); } catch (e) { renderNotif(); } };
  function openAlerts(prefill) {
    if (prefill) { const { symbol, exchange } = L.parseId(prefill); const f = $('#alForm'); f.sym.value = symbol; f.market.value = exchange; const q = quoteFor(prefill); f.value.placeholder = q ? 'now ' + L.fmtPrice(q.price, curOf(exchange)) : 'e.g. 250'; f.value.focus(); }
    renderAlerts(); renderNotif();
    refreshAlertQuotes();
  }
  function renderAlerts() {
    const ruleTxt = r => { const { exchange } = L.parseId(r.sym); return r.type === 'movePct' ? 'daily move ≥ ±' + r.value + '%' : (r.type === 'above' ? 'above ' : 'below ') + L.fmtPrice(r.value, curOf(exchange)); };
    $('#alRules').innerHTML = alerts.rules.map(r => {
      const { symbol, exchange } = L.parseId(r.sym), q = quoteFor(r.sym);
      return `<li data-rule="${esc(r.id)}"><div><b>${esc(symbol)}</b>${exchange === 'ASX' ? '<span class="xchip">ASX</span>' : ''} ${esc(ruleTxt(r))}` +
        `<div class="sub">${q ? 'now ' + L.fmtPrice(q.price, curOf(exchange)) + (q.eod ? ' (close)' : '') + ' · ' + L.fmtPct(q.changePct) : exchange === 'ASX' && !asxLive() ? 'no ASX price (needs Marketstack key)' : 'waiting for a price'}${r.type !== 'movePct' && r.armed === false ? ' · fired, re-arms when price moves back' : ''}</div></div>` +
        `<div class="row"><button type="button" class="chip" data-toggle="${esc(r.id)}" aria-pressed="${r.enabled}">${r.enabled ? 'On' : 'Off'}</button><button type="button" class="chip" data-del="${esc(r.id)}" aria-label="Delete alert">✕</button></div></li>`;
    }).join('') || '<li class="muted small">No alerts yet.</li>';
    $('#alHistory').innerHTML = alerts.history.map(h => `<li class="${h.seen ? '' : 'unseen'}" data-hist="${esc(h.id)}"><div>${esc(L.alertMessage(h))}<div class="sub">${esc(L.fmtAsOf(h.t))}</div></div></li>`).join('') || '<li class="muted small">Nothing has fired yet.</li>';
    if (view === 'alerts') { let ch = false; alerts.history.forEach(h => { if (!h.seen) { h.seen = true; ch = true; } }); if (ch) saveAlerts(); }
    updateBadge();
  }
  $('#alForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target, m = f.market.value, code = m === 'ASX' ? L.normalizeAsx(f.sym.value) : L.normalizeSymbol(f.sym.value);
    try { if (!code) throw new Error(m === 'ASX' ? 'Enter an ASX code, e.g. BHP' : 'Enter a US ticker, e.g. AAPL'); L.addAlertRule(alerts, { sym: L.makeId(code, m), type: f.type.value, value: f.value.value }); }
    catch (err) { $('#alMsg').textContent = err.message; return; }
    saveAlerts(); $('#alMsg').textContent = 'Alert added for ' + code + '.'; f.value.value = '';
    renderAlerts();
    if (m === 'US') src.quote(code, { prio: 1 }).then(() => { checkAlerts(); renderAlerts(); }).catch(() => {});
    else checkAlerts();
  });
  $('#alRules').addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]'), d = e.target.closest('[data-del]');
    if (t) { const r = alerts.rules.find(x => x.id === t.dataset.toggle); if (r) { r.enabled = !r.enabled; saveAlerts(); renderAlerts(); } }
    if (d) { L.removeAlertRule(alerts, d.dataset.del); saveAlerts(); renderAlerts(); }
  });
  $('#alClear').onclick = () => { if (!alerts.history.length || !confirm('Clear the alert history?')) return; alerts.history = []; saveAlerts(); renderAlerts(); };

  /* ---------- settings + setup ---------- */
  function renderSettings() {
    const f = $('#keysForm'); f.finnhub.value = keys.finnhub || ''; f.twelvedata.value = keys.twelvedata || ''; f.marketstack.value = keys.marketstack || '';
    $('#demoToggle').checked = !!settings.demo; $('#refreshSel').value = String(settings.refreshSec); $('#msCap').value = String(settings.msCap);
    $('#defaultInfo').textContent = `US list: top ${DEF.US.list.length} S&P 500 companies by market cap (snapshot ${DEF.US.meta.asOf || '?'}); you have ${wls.US.symbols.length} tickers. ASX list: 3 ETFs + top ${Math.max(0, DEF.ASX.list.length - 3)} ASX companies (snapshot ${DEF.ASX.meta.asOf || '?'}); you have ${wls.ASX.symbols.length}. Reset doesn\u2019t touch your portfolio or alerts.`;
    renderUsage();
  }
  function renderUsage() {
    if ($('#v-settings').hidden) return;
    const u = src ? src.usage() : null;
    if (!u || src.demo) { $('#usage').innerHTML = '<p class="muted">No API calls in DEMO mode.</p>'; return; }
    const row = (name, txt) => `<tr><td>${name}</td><td>${txt}</td></tr>`;
    $('#usage').innerHTML = '<table class="usage-t" id="usageTable">' +
      row('Finnhub', `<span data-usage="finnhub">${u.fhLastMinute}/${u.limits.finnhub.max} calls in the last minute (free limit 60), ${u.fhToday} today</span>${u.fhPausedMs ? ', paused ' + Math.ceil(u.fhPausedMs / 1000) + ' s after hitting the limit' : ''}`) +
      row('Twelve Data', hasKey('twelvedata') ? `<span data-usage="twelvedata">${u.tdLastMinute}/8 credits this minute, ${u.tdToday}/800 today</span> (resets 00:00 UTC)` : '<span class="muted" data-usage="twelvedata">No key: charts, sparklines and live USD/AUD are off</span>') +
      row('Marketstack', hasKey('marketstack') ? `<span data-usage="marketstack">${u.ms.used}/${u.ms.cap} requests this month</span> (${u.ms.month}, counted on this device; your account\u2019s 100 reset on its billing date)` : '<span class="muted" data-usage="marketstack">No key: ASX prices are n/a</span>') +
      row('Frankfurter', `<span data-usage="frankfurter">${u.frToday} today</span> (no key; ECB rate cached 6 h)`) +
      row('Waiting', `${u.pending} queued request${u.pending === 1 ? '' : 's'} (the screen you\u2019re on goes first)`) + '</table>';
  }
  setInterval(renderUsage, 2000);
  function applyKeys(form, msgEl) {
    keys = { finnhub: form.finnhub.value.trim(), twelvedata: form.twelvedata.value.trim(), marketstack: form.marketstack ? form.marketstack.value.trim() : (keys.marketstack || '') };
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
  $('#showKeys').addEventListener('change', e => { ['finnhub', 'twelvedata', 'marketstack'].forEach(n => { $('#keysForm')[n].type = e.target.checked ? 'text' : 'password'; }); });
  $('#clearKeys').onclick = () => { if (!confirm('Remove all API keys from this device?')) return; keys = { finnhub: '', twelvedata: '', marketstack: '' }; saveKeys(); makeSource(); renderSettings(); $('#keysMsg').textContent = 'Keys removed.'; };
  $('#demoToggle').addEventListener('change', e => { settings.demo = e.target.checked; saveSettings(); makeSource(); renderSettings(); });
  $('#refreshSel').addEventListener('change', e => { settings.refreshSec = +e.target.value; saveSettings(); startRefresh(); });
  $('#msCap').addEventListener('change', e => { const v = Math.round(+e.target.value); settings.msCap = isFinite(v) && v >= 0 ? v : A.LIMITS.marketstack.monthly; e.target.value = settings.msCap; saveSettings(); renderUsage(); });
  $('#tryDemo').onclick = () => { settings.demo = true; saveSettings(); makeSource(); go('#/'); };
  $('#resetList').onclick = () => {
    if (!confirm('Replace both watchlists and their favourites with the default lists?')) return;
    wls.US = L.defaultWatchlist(DEF.US.list); wls.ASX = asxDefaults(L.defaultWatchlist(DEF.ASX.list)); saveWl('US'); saveWl('ASX');
    makeSource(); renderSettings(); $('#listMsg').textContent = 'Watchlists reset.';
  };
  $('#clearCache').onclick = () => { if (src) src.clearCache(); L.createCache(store).clear(); makeSource(); $('#listMsg').textContent = 'Cached market data cleared.'; };

  /* ---------- boot ---------- */
  // The three portfolio ETFs start starred and pinned to the top of the ASX list.
  function asxDefaults(w) { w.favourites = L.SEED_PORTFOLIO.map(h => h.symbol).filter(s => w.symbols.some(x => x.symbol === s)); w.favouritesFirst = true; return w; }
  async function loadDefaults(m, url, capField) {
    try { const j = await (await fetch(url)).json(); DEF[m].meta = j; DEF[m].list = j.symbols || []; }
    catch (e) { DEF[m].list = []; banner('Could not load the default ' + m + ' list.', 'error'); }
    DEF[m].list.forEach(d => { if (d[capField]) DEF[m].cap[d.symbol] = d[capField]; });
  }
  async function boot() {
    await Promise.all([loadDefaults('US', 'data/default-watchlist.json', 'marketCapUSD'), loadDefaults('ASX', 'data/asx-watchlist.json', 'marketCapAUD')]);
    wls.US = L.loadWatchlist(store, DEF.US.list, WL_KEY.US, L.normalizeSymbol);
    wls.ASX = L.loadWatchlist(store, DEF.ASX.list, WL_KEY.ASX, L.normalizeAsx);
    if (!store.getItem(WL_KEY.ASX)) asxDefaults(wls.ASX);
    pf = L.loadPortfolio(store); alerts = L.loadAlerts(store);
    if (!store.getItem(L.KEYS.portfolio)) savePf(); // seed: tickers only (units 0, cost blank)
    updateBadge();
    makeSource(); startRefresh(); route();
    if (src) { refreshAlertQuotes(); setTimeout(checkAlerts, 1500); } // check on app open
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = { get src() { return src; }, get wl() { return wls.US; }, get wls() { return wls; }, get pf() { return pf; }, get alerts() { return alerts; }, chart, checkAlerts, notifyCount: 0 };
  boot();
})();
