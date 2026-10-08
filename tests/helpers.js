// Shared test helpers (Node only).
function memStorage(limitBytes) {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      v = String(v);
      if (limitBytes) { let used = 0; for (const [kk, vv] of m) if (kk !== k) used += kk.length + vv.length; if (used + k.length + v.length > limitBytes) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } }
      m.set(k, v);
    },
    removeItem: k => { m.delete(k); },
    dump: () => [...m.entries()]
  };
}
function clock(start = Date.UTC(2026, 9, 7, 15, 0, 0)) {
  const c = { t: start, now: () => c.t, sleep: ms => { c.t += ms; return Promise.resolve(); }, advance: ms => { c.t += ms; } };
  return c;
}
let n = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); n++; console.log('ok -', name); }
  catch (e) { failed++; console.log('FAIL -', name, '\n   ', e && e.stack || e); process.exitCode = 1; }
}
const summary = label => console.log(`\n${label}: ${n} passed, ${failed} failed`);
module.exports = { memStorage, clock, test, summary };
