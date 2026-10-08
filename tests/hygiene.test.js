// Run: node tests/hygiene.test.js
// Scans every file in the app folder for things that must never ship: local paths, emails, API keys, remote scripts.
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { test, summary } = require('./helpers.js');
const ROOT = path.join(__dirname, '..');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { if (f === '.git' || f === 'node_modules') continue; const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } })(ROOT);
const text = files.filter(f => /\.(js|json|html|css|md|webmanifest|py|txt)$|\.gitignore$/.test(f)).map(f => ({ f: path.relative(ROOT, f), s: fs.readFileSync(f, 'utf8') }));

(async () => {
  await test('no local filesystem paths', () => {
    const bad = new RegExp(['/work' + 'space', '/ho' + 'me/', '/Us' + 'ers/', 'C:\\\\Us' + 'ers'].join('|'), 'i'); // built from parts so this file passes its own check
    for (const { f, s } of text) assert.ok(!bad.test(s), f);
  });
  await test('no email addresses', () => {
    for (const { f, s } of text) assert.ok(!/[\w.+-]+@[\w-]+\.(com|org|net|io|dev|au|co)\b/i.test(s), f);
  });
  await test('no hardcoded API keys (only obvious FAKE_ placeholders in tests)', () => {
    for (const { f, s } of text) {
      assert.ok(!/(token|apikey|api_key|access_key)=[A-Za-z0-9]{12,}/i.test(s), f + ': key in a URL');
      assert.ok(!/\b[a-f0-9]{32}\b/.test(s), f + ': 32-hex string');
      assert.ok(!/\b[a-z0-9]{20}\b/.test(s.replace(/[a-z]{20,}/g, '')) || f.endsWith('.json'), f + ': 20-char token-like string');
      const quoted = s.match(/\b(finnhub|twelvedata|marketstack)\s*:\s*'[^']+'/g) || [];
      assert.deepStrictEqual(quoted.filter(q => !/FAKE_|MOCK_/.test(q) && /'[A-Za-z0-9_-]{12,}'/.test(q)), [], f + ': literal key assignment');
    }
  });
  await test('no remote scripts, styles or fonts (no CDN)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html)); assert.ok(!/<link[^>]+href=["']https?:/i.test(html)); assert.ok(!/@import|fonts\.googleapis/.test(html));
    assert.ok(/connect-src 'self' https:\/\/finnhub\.io https:\/\/api\.twelvedata\.com https:\/\/api\.marketstack\.com https:\/\/api\.frankfurter\.dev;/.test(html), 'CSP limits network access to the four data APIs');
  });
  await test('service worker caches every app-shell file that exists', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const assets = JSON.parse(sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
    for (const a of assets) if (a !== './') assert.ok(fs.existsSync(path.join(ROOT, a)), a);
    for (const f of ['index.html', 'app.js', 'logic.js', 'api.js', 'chart.js', 'styles.css', 'data/default-watchlist.json', 'data/asx-watchlist.json']) assert.ok(assets.includes(f), f);
    assert.ok(/stockwatch-shell-v2/.test(sw) && /stockwatch-data-v2/.test(sw), 'cache version bumped');
    for (const p of ['token', 'apikey', 'access_key']) assert.ok(sw.includes("'" + p + "'"), 'SW strips ' + p + ' before caching');
    for (const h of ['finnhub.io', 'api.twelvedata.com', 'api.marketstack.com', 'api.frankfurter.dev']) assert.ok(sw.includes("'" + h + "'"), 'SW knows API host ' + h);
  });
  await test('portfolio seed has tickers only, no amounts anywhere in the code', () => {
    const logic = fs.readFileSync(path.join(ROOT, 'logic.js'), 'utf8');
    const seed = logic.match(/const SEED_PORTFOLIO = (\[[^\]]*\]);/)[1];
    assert.ok(/FANG/.test(seed) && /SEMI/.test(seed) && /IVV/.test(seed)); assert.ok(!/\d/.test(seed), 'no numbers in the seed');
    for (const { f, s } of text) if (/\.(js|html)$/.test(f) && !f.startsWith('tests')) assert.ok(!/(units|avgCost)\s*:\s*[1-9]/.test(s), f + ': hardcoded holding amount');
  });
  await test('ASX list: 3 ETFs first, then top 20 by market cap, no prices', () => {
    const asx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/asx-watchlist.json'), 'utf8'));
    assert.deepStrictEqual(asx.symbols.slice(0, 3).map(s => s.symbol), ['FANG', 'SEMI', 'IVV']); assert.strictEqual(asx.symbols.length, 23);
    const caps = asx.symbols.slice(3).map(s => s.marketCapAUD); assert.deepStrictEqual(caps, caps.slice().sort((a, b) => b - a));
    assert.ok(asx.symbols.every(s => /^[A-Z0-9]{2,6}$/.test(s.symbol) && !('price' in s))); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(asx.asOf));
  });
  await test('external links open safely (new tab, no opener, no referrer)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    for (const a of (html + app).match(/<a [^>]*href="(https|\$\{)[^>]*>/g) || []) assert.ok(/target="_blank"/.test(a) && /rel="noopener noreferrer"/.test(a), a);
    assert.ok(/background push[\s\S]{0,80}needs a server/i.test(html), 'honest note about background push');
  });
  await test('footer says Not financial advice and the delayed-data label exists', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(/<footer[^>]*>Not financial advice/.test(html)); assert.ok(/Delayed data/.test(html));
  });
  summary('hygiene (' + text.length + ' files)');
})();
