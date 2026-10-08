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
      assert.ok(!/(token|apikey|api_key)=[A-Za-z0-9]{12,}/i.test(s), f + ': key in a URL');
      assert.ok(!/\b[a-f0-9]{32}\b/.test(s), f + ': 32-hex string');
      assert.ok(!/\b[a-z0-9]{20}\b/.test(s.replace(/[a-z]{20,}/g, '')) || f.endsWith('.json'), f + ': 20-char token-like string');
      const quoted = s.match(/\b(finnhub|twelvedata)\s*:\s*'[^']+'/g) || [];
      assert.deepStrictEqual(quoted.filter(q => !/FAKE_|MOCK_/.test(q)), [], f + ': literal key assignment');
    }
  });
  await test('no remote scripts, styles or fonts (no CDN)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html)); assert.ok(!/<link[^>]+href=["']https?:/i.test(html)); assert.ok(!/@import|fonts\.googleapis/.test(html));
    assert.ok(/connect-src 'self' https:\/\/finnhub\.io https:\/\/api\.twelvedata\.com;/.test(html), 'CSP limits network access to the two APIs');
  });
  await test('service worker caches every app-shell file that exists', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const assets = JSON.parse(sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
    for (const a of assets) if (a !== './') assert.ok(fs.existsSync(path.join(ROOT, a)), a);
    for (const f of ['index.html', 'app.js', 'logic.js', 'api.js', 'chart.js', 'styles.css', 'data/default-watchlist.json']) assert.ok(assets.includes(f), f);
  });
  await test('footer says Not financial advice and the delayed-data label exists', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(/<footer[^>]*>Not financial advice/.test(html)); assert.ok(/Delayed data/.test(html));
  });
  summary('hygiene (' + text.length + ' files)');
})();
