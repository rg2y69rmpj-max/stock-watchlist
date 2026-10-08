/* Canvas price chart with a touch/mouse crosshair. No libraries. */
(function (root) {
  'use strict';
  const COLORS = { up: '#22c55e', down: '#f05252', grid: 'rgba(148,163,184,0.12)', text: '#8b97a8', cross: 'rgba(226,232,240,0.55)', base: 'rgba(148,163,184,0.35)' };
  function niceTicks(lo, hi, count) {
    const span = hi - lo || Math.abs(hi) || 1, raw = span / Math.max(1, count - 1), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
  }
  function PriceChart(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    let bars = [], meta = {}, hover = -1;
    const pad = { l: 6, r: 54, t: 14, b: 24 };
    const fmtY = v => v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2);
    function xLabel(d) {
      if (meta.intraday) { const m = /(\d{2}):(\d{2})/.exec(d); if (!m) return d; let h = +m[1]; const ap = h >= 12 ? 'p' : 'a'; h = h % 12 || 12; return meta.range === '5D' ? d.slice(5, 10).replace('-', '/') : h + ':' + m[2] + ap; }
      const [y, mo, da] = d.slice(0, 10).split('-'); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1];
      return meta.range === '5Y' ? M + ' ' + y.slice(2) : meta.range === '1Y' || meta.range === '6M' ? M + ' ' + y.slice(2) : M + ' ' + (+da);
    }
    function size() {
      const dpr = root.devicePixelRatio || 1, w = canvas.clientWidth || 300, h = canvas.clientHeight || 220;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { w, h };
    }
    function geom() {
      const { w, h } = size(), cs = bars.map(b => b.c);
      let lo = Math.min(...cs), hi = Math.max(...cs);
      if (meta.baseline != null) { lo = Math.min(lo, meta.baseline); hi = Math.max(hi, meta.baseline); }
      const padV = (hi - lo) * 0.08 || hi * 0.01 || 1; lo -= padV; hi += padV;
      const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
      return { w, h, lo, hi, pw, ph, x: i => pad.l + (bars.length < 2 ? pw / 2 : i * pw / (bars.length - 1)), y: v => pad.t + ph * (1 - (v - lo) / (hi - lo)) };
    }
    function draw() {
      const { w, h } = size(); ctx.clearRect(0, 0, w, h);
      ctx.font = '11px -apple-system, system-ui, sans-serif'; ctx.textBaseline = 'middle';
      if (meta.demo) { ctx.save(); ctx.fillStyle = 'rgba(250,204,21,0.10)'; ctx.font = 'bold 54px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('DEMO', w / 2, h / 2); ctx.restore(); }
      if (bars.length < 2) { ctx.fillStyle = COLORS.text; ctx.textAlign = 'center'; ctx.fillText(meta.message || 'No chart data', w / 2, h / 2); return; }
      const g = geom(), up = bars[bars.length - 1].c >= (meta.baseline ?? bars[0].c), col = up ? COLORS.up : COLORS.down;
      ctx.textAlign = 'left';
      for (const t of niceTicks(g.lo, g.hi, 4)) {
        const y = g.y(t); if (y < pad.t - 2 || y > g.h - pad.b + 2) continue;
        ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(g.w - pad.r, y); ctx.stroke();
        ctx.fillStyle = COLORS.text; ctx.fillText(fmtY(t), g.w - pad.r + 6, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      [0, Math.floor((bars.length - 1) / 2), bars.length - 1].forEach((i, k) => {
        ctx.textAlign = k === 0 ? 'left' : k === 2 ? 'right' : 'center'; ctx.fillStyle = COLORS.text; ctx.fillText(xLabel(bars[i].d), k === 2 ? g.w - pad.r : g.x(i), g.h - 6);
      });
      if (meta.baseline != null) { const y = g.y(meta.baseline); ctx.setLineDash([3, 4]); ctx.strokeStyle = COLORS.base; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(g.w - pad.r, y); ctx.stroke(); ctx.setLineDash([]); }
      const grad = ctx.createLinearGradient(0, pad.t, 0, g.h - pad.b); grad.addColorStop(0, up ? 'rgba(34,197,94,0.28)' : 'rgba(240,82,82,0.28)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath(); bars.forEach((b, i) => i ? ctx.lineTo(g.x(i), g.y(b.c)) : ctx.moveTo(g.x(i), g.y(b.c)));
      ctx.lineTo(g.x(bars.length - 1), g.h - pad.b); ctx.lineTo(g.x(0), g.h - pad.b); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); bars.forEach((b, i) => i ? ctx.lineTo(g.x(i), g.y(b.c)) : ctx.moveTo(g.x(i), g.y(b.c))); ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
      if (hover >= 0 && hover < bars.length) {
        const b = bars[hover], x = g.x(hover), y = g.y(b.c);
        ctx.strokeStyle = COLORS.cross; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, g.h - pad.b); ctx.moveTo(pad.l, y); ctx.lineTo(g.w - pad.r, y); ctx.stroke();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#0b0f14'; ctx.lineWidth = 2; ctx.stroke();
        const label = '$' + b.c.toFixed(2) + '  ' + (opts.formatTime ? opts.formatTime(b.d, meta.intraday) : b.d);
        ctx.font = '600 12px -apple-system, system-ui, sans-serif'; const tw = ctx.measureText(label).width + 14;
        const bx = Math.min(Math.max(x - tw / 2, pad.l), g.w - pad.r - tw);
        ctx.fillStyle = 'rgba(15,20,28,0.92)'; ctx.strokeStyle = 'rgba(148,163,184,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx, 0, tw, 20, 6); else ctx.rect(bx, 0, tw, 20); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e5e7eb'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, bx + 7, 10);
      }
    }
    function setHover(clientX) {
      if (bars.length < 2) return;
      const r = canvas.getBoundingClientRect(), g = geom();
      const i = Math.round(((clientX - r.left) - pad.l) / g.pw * (bars.length - 1));
      const ni = Math.max(0, Math.min(bars.length - 1, i));
      if (ni !== hover) { hover = ni; draw(); if (opts.onHover) opts.onHover(bars[hover], hover); }
    }
    function clearHover() { if (hover !== -1) { hover = -1; draw(); if (opts.onHover) opts.onHover(null, -1); } }
    canvas.addEventListener('pointerdown', e => { setHover(e.clientX); if (e.pointerType !== 'mouse') try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } });
    canvas.addEventListener('pointermove', e => setHover(e.clientX));
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => canvas.addEventListener(t, e => { if (t !== 'pointerleave' || e.pointerType === 'mouse') clearHover(); }));
    if (root.ResizeObserver) new root.ResizeObserver(() => draw()).observe(canvas);
    return {
      set(newBars, newMeta) { bars = (newBars || []).filter(b => b && isFinite(b.c)); meta = newMeta || {}; hover = -1; draw(); },
      redraw: draw, hoverIndex: () => hover, data: () => bars
    };
  }
  const out = { PriceChart, niceTicks };
  if (typeof module !== 'undefined' && module.exports) module.exports = out; else root.SWChart = out;
})(typeof self !== 'undefined' ? self : this);
