// Vertical profile (long section) of the active line against real terrain.
(function () {
  const G = TB.geo, C = TB.costs;
  let box, canvas, ctx, title, cur = null, hoverX = null;
  const TYPE_COL = { bored: '#455a64', cutcover: '#78909c', trench: '#a1887f', atgrade: '#8bc34a', street: '#cddc39', rail: '#795548', elevated: '#ff9800', bridge: '#f44336', oldbridge: '#ff7043' };
  const PAD = { l: 46, r: 12, t: 24, b: 26 };

  function init() {
    box = document.getElementById('profile');
    box.innerHTML = `<div class="pf-h"><span id="pf-title"></span><span class="muted small" id="pf-read"></span></div><canvas></canvas>`;
    canvas = box.querySelector('canvas'); ctx = canvas.getContext('2d'); title = box.querySelector('#pf-title');
    canvas.addEventListener('mousemove', (e) => { hoverX = e.offsetX; draw(); });
    canvas.addEventListener('mouseleave', () => { hoverX = null; TB.app.hover(null); draw(); });
    canvas.addEventListener('click', (e) => {
      if (!cur || cur.empty) return;
      const k = idxAt(e.offsetX); if (k == null) return;
      const sp = cur.S[k].span; TB.editor.select({ type: 'span', lineId: cur.line.id, span: sp });
    });
    new ResizeObserver(() => draw()).observe(box);
  }

  function update(res) {
    const id = TB.state.activeLine;
    cur = id ? res.lines.get(id) : null;
    document.body.classList.toggle('has-profile', !!(cur && !cur.empty) && TB.state.profile);
    draw();
  }

  let X, Y, W, H;
  function idxAt(px) {
    if (!cur || cur.empty) return null;
    const s = (px - PAD.l) / (W - PAD.l - PAD.r) * cur.metrics.length;
    if (s < 0 || s > cur.metrics.length) return null;
    const S = cur.S; let lo = 0, hi = S.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].s < s) lo = m + 1; else hi = m; }
    return lo;
  }

  function draw() {
    if (!box || !cur || cur.empty || !TB.state.profile) return;
    const dpr = window.devicePixelRatio || 1;
    W = box.clientWidth; H = box.clientHeight - 22;
    if (W <= 0 || H <= 0) return;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { S } = cur, { g, z, type } = cur.profile, len = cur.metrics.length, K = S.length;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < K; k++) { lo = Math.min(lo, g[k], z[k] - 2); hi = Math.max(hi, g[k], z[k] + 8); }
    lo = Math.floor((lo - 4) / 10) * 10; hi = Math.ceil((hi + 4) / 10) * 10;
    X = (s) => PAD.l + s / len * (W - PAD.l - PAD.r);
    Y = (e) => PAD.t + (hi - e) / (hi - lo) * (H - PAD.t - PAD.b);
    title.innerHTML = `<i class="sw" style="background:${cur.line.color}"></i><b>${TB.render.esc(cur.line.name)}</b> long section <span class="muted small">· vertical exaggeration ×${Math.round((len / (W - PAD.l - PAD.r)) / ((hi - lo) / (H - PAD.t - PAD.b)))}${cur.groundReady ? '' : ' · loading terrain…'}</span>`;

    // grid
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#888'; ctx.strokeStyle = '#eee'; ctx.lineWidth = 1;
    const step = (hi - lo) > 120 ? 40 : (hi - lo) > 60 ? 20 : 10;
    for (let e = lo; e <= hi; e += step) { ctx.beginPath(); ctx.moveTo(PAD.l, Y(e)); ctx.lineTo(W - PAD.r, Y(e)); ctx.stroke(); ctx.fillText(e + ' m', 4, Y(e) + 3); }
    const kmStep = len > 15000 ? 2000 : len > 6000 ? 1000 : len > 2000 ? 500 : 200;
    for (let s = 0; s <= len; s += kmStep) ctx.fillText(G.fmtLen(s), X(s) - 10, H - 4);

    // ground
    ctx.beginPath(); ctx.moveTo(X(0), Y(lo));
    for (let k = 0; k < K; k++) ctx.lineTo(X(S[k].s), Y(g[k]));
    ctx.lineTo(X(len), Y(lo)); ctx.closePath();
    ctx.fillStyle = '#efe6d6'; ctx.fill();
    ctx.beginPath(); for (let k = 0; k < K; k++) k ? ctx.lineTo(X(S[k].s), Y(g[k])) : ctx.moveTo(X(S[k].s), Y(g[k]));
    ctx.strokeStyle = '#a88f6a'; ctx.lineWidth = 1.2; ctx.stroke();

    // structures
    const col = cur.line.color;
    for (let k = 1; k < K; k++) {
      const t = type[k], fam = C.SPANS[t].family, x0 = X(S[k - 1].s), x1 = X(S[k].s);
      if (fam === 'under') { ctx.fillStyle = hexA(col, 0.18); ctx.fillRect(x0, Y(z[k] + 6.5), Math.max(1, x1 - x0 + 0.5), Y(z[k] - 1) - Y(z[k] + 6.5)); }
      if ((fam === 'above' || fam === 'bridge') && Math.floor(S[k].s / 40) !== Math.floor(S[k - 1].s / 40) && z[k] - g[k] > 1) {
        ctx.strokeStyle = '#9e9e9e'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x1, Y(z[k] - 1)); ctx.lineTo(x1, Y(g[k])); ctx.stroke();
      }
      ctx.fillStyle = TYPE_COL[t]; ctx.fillRect(x0, H - PAD.b + 4, Math.max(1, x1 - x0 + 0.5), 5);
    }
    // rail
    ctx.beginPath(); for (let k = 0; k < K; k++) k ? ctx.lineTo(X(S[k].s), Y(z[k])) : ctx.moveTo(X(S[k].s), Y(z[k]));
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();

    // stations
    ctx.textAlign = 'center';
    for (const st of cur.stations) {
      const k = cur.nodeIdx[st.index], s = S[k].s, zz = z[k];
      const x0 = X(s - st.L / 2), x1 = X(s + st.L / 2);
      ctx.fillStyle = hexA(col, 0.85); ctx.fillRect(x0, Y(zz + 7), Math.max(3, x1 - x0), Y(zz - 1) - Y(zz + 7));
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.strokeRect(x0, Y(zz + 7), Math.max(3, x1 - x0), Y(zz - 1) - Y(zz + 7));
      ctx.fillStyle = '#333'; ctx.fillText(st.node.name.length > 18 ? st.node.name.slice(0, 17) + '…' : st.node.name, X(s), 12);
      ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.beginPath(); ctx.moveTo(X(s), 15); ctx.lineTo(X(s), Y(zz + 7)); ctx.stroke();
    }
    ctx.textAlign = 'left';
    // warnings
    for (const w of cur.warnings) {
      if (w.sev !== 'error' || w.lat == null) continue;
      let best = 0, bd = Infinity; for (let k = 0; k < K; k += 2) { const d = Math.abs(S[k].lat - w.lat) + Math.abs(S[k].lon - w.lon); if (d < bd) { bd = d; best = k; } }
      ctx.fillStyle = '#d32f2f'; ctx.beginPath(); ctx.arc(X(S[best].s), Y(z[best]), 5, 0, 7); ctx.fill();
    }
    // hover
    const read = document.getElementById('pf-read');
    if (hoverX != null) {
      const k = idxAt(hoverX);
      if (k != null) {
        const x = X(S[k].s);
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke(); ctx.setLineDash([]);
        const d = g[k] - z[k];
        read.textContent = `${G.fmtLen(S[k].s)} · ground ${g[k].toFixed(0)} m · rail ${z[k].toFixed(0)} m (${d > 1 ? d.toFixed(0) + ' m deep' : d < -1 ? (-d).toFixed(0) + ' m up' : 'at grade'}) · ${C.SPANS[type[k]].label}`;
        TB.app.hover(S[k].lat, S[k].lon);
      }
    } else read.textContent = 'hover to inspect · click to select a span';
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  TB.profile = { init, update, draw };
})();
