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
    assert.ok(/connect-src 'self' https:\/\/finnhub\.io https:\/\/api\.twelvedata\.com https:\/\/api\.marketstack\.com https:\/\/api\.frankfurter\.dev https:\/\/docs\.google\.com https:\/\/\*\.googleusercontent\.com;/.test(html), 'CSP limits network access to the four data APIs plus Google Sheets (docs.google.com and its googleusercontent.com CSV redirect)');
  });
  await test('service worker caches every app-shell file that exists', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const assets = JSON.parse(sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
    for (const a of assets) if (a !== './') assert.ok(fs.existsSync(path.join(ROOT, a)), a);
    for (const f of ['index.html', 'app.js', 'logic.js', 'api.js', 'chart.js', 'styles.css', 'data/default-watchlist.json', 'data/asx-watchlist.json']) assert.ok(assets.includes(f), f);
    assert.ok(/stockwatch-shell-v4/.test(sw) && /stockwatch-data-v4/.test(sw), 'cache version bumped');
    for (const p of ['token', 'apikey', 'access_key']) assert.ok(sw.includes("'" + p + "'"), 'SW strips ' + p + ' before caching');
    for (const h of ['finnhub.io', 'api.twelvedata.com', 'api.marketstack.com', 'api.frankfurter.dev', 'docs.google.com']) assert.ok(sw.includes("'" + h + "'"), 'SW knows API host ' + h);
    assert.ok(/new Request\(a, \{ cache: 'reload' \}\)/.test(sw), 'install fetches the shell fresh (cache: reload), not from the HTTP cache');
  });
  await test('app picks up a new service worker: updateViaCache none, update on visibility, one reload on controllerchange', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    assert.ok(/register\('sw\.js', \{ updateViaCache: 'none' \}\)/.test(app)); assert.ok(/visibilitychange[\s\S]{0,120}reg\.update\(\)/.test(app)); assert.ok(/controllerchange[\s\S]{0,80}!reloaded/.test(app));
  });
  await test('UI copy never sends you to a paid plan; ASX setup points to the free Google Sheet', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const [f, s] of [['index.html', html], ['app.js', app]]) {
      assert.ok(!/(upgrade|paid plan|pricing|subscribe|premium plan|signup\/free)/i.test(s), f + ': no upsell copy or paid sign-up links');
      assert.ok(!/marketstack\.com\/(signup|pricing|product)/i.test(s), f + ': no Marketstack sign-up/pricing link');
    }
    const G = require(path.join(ROOT, 'logic.js')).SHEET_GUIDE, all = G.steps.concat(G.byHand, G.notes).join('\n');
    assert.ok(/Copy formula/.test(all) && /Anyone with the link/.test(all) && /Publish to web/.test(html) && /id="sheetSteps"/.test(html) && /renderGuide\(\)/.test(app), 'in-app Google Sheet steps (SHEET_GUIDE rendered in Settings)');
    for (const c of ['FANG', 'SEMI', 'IVV']) assert.ok(all.includes('=GOOGLEFINANCE("ASX:' + c + '","price")'), 'guide has the ' + c + ' formula');
    for (const line of [G.title].concat(G.steps, G.byHand, G.notes)) assert.ok(readme.includes(line), 'README has the in-app guide line word for word: ' + line.slice(0, 40));
    assert.ok(!/(API|CORS|CSV|endpoint|localStorage|JSON)/.test(G.steps.concat(G.notes).join(' ')), 'guide steps are plain language (no jargon)');
    assert.ok(/GOOGLEFINANCE/.test(readme) && /Anyone with the link/.test(readme), 'README has the Google Sheet steps');
  });
  await test('Google Sheet formula holds tickers only (no personal data)', () => {
    const L = require(path.join(ROOT, 'logic.js'));
    const f = L.sheetFormula(['FANG', 'SEMI', 'IVV']); assert.ok(!/\d{2,}/.test(f.replace(/yyyy-mm-dd hh:mm/, '')), 'formula holds tickers only, no amounts');
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
  // Names and other private words are passed in at run time (HYGIENE_TERMS="word1,word2") so they're never written into the repo themselves.
  const TERMS = (process.env.HYGIENE_TERMS || '').split(',').map(x => x.trim()).filter(Boolean);
  await test('no personal details' + (TERMS.length ? ' (plus ' + TERMS.length + ' private terms)' : ' (set HYGIENE_TERMS to also check names)'), () => {
    for (const { f, s } of text) {
      assert.ok(!/\b0[45]\d{2}[ -]?\d{3}[ -]?\d{3}\b|\+61\s?\d/.test(s), f + ': phone number');
      assert.ok(!/\b\d{3}-\d{3}\b.{0,20}\b\d{6,10}\b/.test(s), f + ': BSB/account number');
      if (TERMS.length) { const m = s.match(new RegExp('\\b(' + TERMS.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i')); assert.ok(!m, f + ': private term "' + (m && m[0]) + '"'); }
    }
  });
  summary('hygiene (' + text.length + ' files)');
})();
