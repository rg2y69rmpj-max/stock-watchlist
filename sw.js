/* Service worker: cache-first app shell, network-first market data.
   API responses are cached under a URL with any key parameter removed, so keys never land in Cache Storage.
   Notifications are only shown by the open app (no push: that would need a server); tapping one focuses the app. */
const SHELL = 'stockwatch-shell-v3';
const DATA = 'stockwatch-data-v3';
const ASSETS = ['./', 'index.html', 'styles.css', 'logic.js', 'api.js', 'chart.js', 'app.js', 'manifest.webmanifest', 'data/default-watchlist.json', 'data/asx-watchlist.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon-180.png', 'favicon.ico'];
const API_HOSTS = ['finnhub.io', 'api.twelvedata.com', 'api.marketstack.com', 'api.frankfurter.dev'];
const MAX_DATA_ENTRIES = 300;

self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function sanitized(url) {
  const u = new URL(url);
  ['token', 'apikey', 'api_key', 'key', 'access_key'].forEach(p => u.searchParams.delete(p));
  return u.toString();
}
async function trim(cache) {
  const ks = await cache.keys();
  for (let i = 0; i < ks.length - MAX_DATA_ENTRIES; i++) await cache.delete(ks[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (API_HOSTS.includes(url.hostname)) {
    const key = sanitized(req.url);
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then(c => c.put(key, copy).then(() => trim(c))).catch(() => {}); }
      return res;
    }).catch(() => caches.open(DATA).then(c => c.match(key)).then(r => r || Response.error())));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(SHELL).then(x => x.put(req, c)); }
    return res;
  })).catch(() => caches.match('index.html')));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => 'focus' in x);
    return c ? c.focus().then(w => (w && 'navigate' in w ? w.navigate('./#/alerts') : w)).catch(() => {}) : self.clients.openWindow('./#/alerts');
  }));
});
