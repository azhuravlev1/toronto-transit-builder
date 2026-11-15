// Vertical profile (long section) of the active line against real terrain.
// Scroll / pinch to zoom, drag to pan, drag stations & bend points up/down to set their depth
// (clamped by the grade limit), click a span to change how it is built.
(function () {
  const G = TB.geo, C = TB.costs, M = TB.model;
  let box, canvas, ctx, title, pop, cur = null, hoverX = null, hoverY = null;
  const views = new Map(); // lineId -> {s0, s1}
  let drag = null;
  const TYPE_COL = { bored: '#455a64', cutcover: '#78909c', trench: '#a1887f', atgrade: '#8bc34a', street: '#cddc39', rail: '#795548', elevated: '#ff9800', bridge: '#f44336', oldbridge: '#ff7043' };
  const PAD = { l: 46, r: 12, t: 34, b: 26 };
  let X, Y, Yinv, W, H;

  function init() {
    box = document.getElementById('profile');
    box.innerHTML = `<div class="pf-h"><span id="pf-title"></span><span class="pf-tools"><span class="muted small" id="pf-read"></span>
      <button class="icon" data-pf="out" title="Zoom out">−</button><button class="icon" data-pf="in" title="Zoom in">+</button><button class="btn small" data-pf="fit" title="Show the whole line (double-click)">Fit</button></span></div>
      <canvas></canvas><div id="pf-pop"></div>`;
    canvas = box.querySelector('canvas'); ctx = canvas.getContext('2d'); title = box.querySelector('#pf-title'); pop = box.querySelector('#pf-pop');
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('mousemove', (e) => { hoverX = e.offsetX; hoverY = e.offsetY; if (!drag) draw(); });
    canvas.addEventListener('mouseleave', () => { hoverX = null; TB.app.hover(null); draw(); });
    canvas.addEventListener('dblclick', () => { if (cur) { views.delete(cur.line.id); draw(); } });
    box.querySelector('.pf-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pf]'); if (!b || !cur) return;
      if (b.dataset.pf === 'fit') views.delete(cur.line.id); else zoomAt(view().s0 + (view().s1 - view().s0) / 2, b.dataset.pf === 'in' ? 0.6 : 1.6);
      draw();
    });
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]'); if (!b) return;
      TB.editor.setSpanType(pop.dataset.line, +pop.dataset.span, b.dataset.type);
      pop.classList.remove('open');
    });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#pf-pop') && e.target !== canvas) pop.classList.remove('open'); });
    new ResizeObserver(() => draw()).observe(box);
  }

  function update(res) {
    const id = TB.state.activeLine;
    cur = id ? res.lines.get(id) : null;
    document.body.classList.toggle('has-profile', !!(cur && !cur.empty) && TB.state.profile);
    draw();
  }

  function view() {
    const len = cur.metrics.length;
    let v = views.get(cur.line.id) || { s0: 0, s1: len };
    v.s1 = Math.min(v.s1, len); v.s0 = Math.max(0, Math.min(v.s0, v.s1 - 100));
    if (v.s1 - v.s0 < 100) v = { s0: 0, s1: len };
    return v;
  }
  function setView(s0, s1) {
    const len = cur.metrics.length, span = Math.max(150, Math.min(len, s1 - s0));
    s0 = Math.max(0, Math.min(len - span, s0));
    if (span >= len - 1) views.delete(cur.line.id); else views.set(cur.line.id, { s0, s1: s0 + span });
  }
  function zoomAt(s, f) { const v = view(); setView(s - (s - v.s0) * f, s + (v.s1 - s) * f); }
  const sAt = (px) => { const v = view(); return v.s0 + (px - PAD.l) / (W - PAD.l - PAD.r) * (v.s1 - v.s0); };

  function onWheel(e) {
    if (!cur || cur.empty) return;
    e.preventDefault();
    const v = view();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) setView(v.s0 + e.deltaX / W * (v.s1 - v.s0), v.s1 + e.deltaX / W * (v.s1 - v.s0));
    else if (e.shiftKey) setView(v.s0 + e.deltaY / W * (v.s1 - v.s0), v.s1 + e.deltaY / W * (v.s1 - v.s0));
    else zoomAt(sAt(e.offsetX), Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
    draw();
  }

  // ---- node dragging ---------------------------------------------------------------------------
  function hitNode(px, py) {
    if (!cur || cur.empty) return null;
    const { S } = cur, { z } = cur.profile;
    let best = null, bd = 14;
    cur.line.nodes.forEach((nd, i) => {
      const k = cur.nodeIdx[i]; if (k == null) return;
      const x = X(S[k].s), y = Y(z[k] + (nd.kind === 'station' ? 3 : 0));
      const st = nd.kind === 'station' && cur.stations.find(s => s.index === i);
      const halfW = st ? Math.max(8, (X(S[k].s + st.L / 2) - X(S[k].s - st.L / 2)) / 2) : 8;
      const dx = Math.abs(px - x), dy = Math.abs(py - y);
      if (dx <= halfW && dy < bd + 6) { bd = dy; best = { i, nd, k }; }
    });
    return best;
  }

  function depthRange(i, k) {
    // keep the grade to the neighbouring fixed points (stations, portals, set bend points) within the limit
    const Gmax = C.MODES[cur.line.mode].grade, s = cur.S[k].s, gS = cur.profile.gS[k];
    const others = cur.anchors.filter(a => a.i !== i);
    const prev = others.filter(a => a.s < s).pop(), next = others.find(a => a.s > s);
    let lo = -Infinity, hi = Infinity;
    if (prev) { lo = Math.max(lo, prev.z - Gmax * (s - prev.s)); hi = Math.min(hi, prev.z + Gmax * (s - prev.s)); }
    if (next) { lo = Math.max(lo, next.z - Gmax * (next.s - s)); hi = Math.min(hi, next.z + Gmax * (next.s - s)); }
    let dMin = -15, dMax = 60;
    if (lo <= hi) { dMin = Math.max(dMin, gS - hi); dMax = Math.min(dMax, gS - lo); }
    return { gS, dMin: Math.ceil(dMin), dMax: Math.floor(dMax), limited: lo <= hi };
  }

  function onDown(e) {
    if (!cur || cur.empty) return;
    pop.classList.remove('open');
    const h = hitNode(e.offsetX, e.offsetY);
    if (h) {
      M.begin();
      drag = { kind: 'node', nodeId: h.nd.id, i: h.i, k: h.k, range: depthRange(h.i, h.k), y0: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    } else drag = { kind: 'pan', x0: e.clientX, v0: { ...view() }, moved: false, px: e.offsetX, py: e.offsetY };
  }
  function onMove(e) {
    if (!drag) return;
    if (Math.abs(e.clientX - (drag.x0 ?? e.clientX)) > 3 || Math.abs(e.clientY - (drag.y0 ?? e.clientY)) > 3) drag.moved = true;
    if (drag.kind === 'pan') {
      if (!drag.moved) return;
      const ds = (e.clientX - drag.x0) / (W - PAD.l - PAD.r) * (drag.v0.s1 - drag.v0.s0);
      setView(drag.v0.s0 - ds, drag.v0.s1 - ds); draw();
    } else if (drag.moved) {
      const f = M.findNode(drag.nodeId); if (!f) return;
      const r = canvas.getBoundingClientRect(), zMouse = Yinv(e.clientY - r.top) - (f.node.kind === 'station' ? 3 : 0);
      let d = Math.round(drag.range.gS - zMouse);
      const { dMin, dMax } = drag.range;
      drag.clamped = d < dMin ? 'deep' : d > dMax ? 'shallow' : null;
      if (dMin <= dMax) d = Math.max(dMin, Math.min(dMax, d));
      f.node.depth = d;
      TB.app.redrawLive();
    }
  }
  function onUp() {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'node') {
      M.end(); TB.app.afterChange();
      if (!d.moved) { const f = M.findNode(d.nodeId); if (f) TB.editor.select({ type: f.node.kind, lineId: f.line.id, nodeId: f.node.id }); }
      else if (d.clamped) TB.ui.toast(`Limited by the ${(C.MODES[cur.line.mode].grade * 100).toFixed(1)} % grade limit to the neighbouring stations / portals`);
    } else if (!d.moved) openSpanPopover(d.px, d.py);
  }

  function openSpanPopover(px, py) {
    const k = idxAt(px); if (k == null) return;
    const span = cur.S[k].span, line = cur.line, curType = line.nodes[span].out.type;
    TB.editor.select({ type: 'span', lineId: line.id, span });
    pop.dataset.line = line.id; pop.dataset.span = span;
    pop.innerHTML = `<div class="pf-pop-h">Build this span as…</div>` + Object.entries(C.SPANS).map(([t, s]) =>
      `<button data-type="${t}" class="${t === curType ? 'on' : ''}"><svg width="34" height="12">${TB.ui.legendLine(t, line.color) || ''}</svg>${s.label}</button>`).join('');
    pop.classList.add('open');
    const bw = 230, bh = pop.offsetHeight || 300;
    pop.style.left = Math.min(px + 10, box.clientWidth - bw - 8) + 'px';
    pop.style.top = Math.max(4, Math.min(py - bh / 2, box.clientHeight - bh - 4)) + 'px';
  }

  function idxAt(px) {
    if (!cur || cur.empty) return null;
    const s = sAt(px);
    if (s < 0 || s > cur.metrics.length) return null;
    const S = cur.S; let lo = 0, hi = S.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (S[m].s < s) lo = m + 1; else hi = m; }
    return lo;
  }

  // ---- drawing ---------------------------------------------------------------------------------
  function draw() {
    if (!box || !cur || cur.empty || !TB.state.profile) return;
    const dpr = window.devicePixelRatio || 1;
    W = box.clientWidth; H = box.clientHeight - 24;
    if (W <= 0 || H <= 0) return;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { S } = cur, { g, z, type } = cur.profile, len = cur.metrics.length, K = S.length;
    const v = view(), zoomed = v.s0 > 0 || v.s1 < len;
    let k0 = 0, k1 = K - 1;
    while (k0 < K - 1 && S[k0 + 1].s < v.s0) k0++;
    while (k1 > 0 && S[k1 - 1].s > v.s1) k1--;
    let lo = Infinity, hi = -Infinity;
    for (let k = k0; k <= k1; k++) { lo = Math.min(lo, g[k], z[k] - 2); hi = Math.max(hi, g[k], z[k] + 8); }
    lo = Math.floor((lo - 4) / 10) * 10; hi = Math.ceil((hi + 4) / 10) * 10;
    X = (s) => PAD.l + (s - v.s0) / (v.s1 - v.s0) * (W - PAD.l - PAD.r);
    Y = (e) => PAD.t + (hi - e) / (hi - lo) * (H - PAD.t - PAD.b);
    Yinv = (y) => hi - (y - PAD.t) / (H - PAD.t - PAD.b) * (hi - lo);
    const exag = Math.round(((v.s1 - v.s0) / (W - PAD.l - PAD.r)) / ((hi - lo) / (H - PAD.t - PAD.b)));
    title.innerHTML = `<i class="sw" style="background:${cur.line.color}"></i><b>${TB.render.esc(cur.line.name)}</b> long section <span class="muted small">· vertical ×${exag}${zoomed ? ` · showing ${G.fmtLen(v.s0)}–${G.fmtLen(v.s1)}` : ''}${cur.groundReady ? '' : ' · loading terrain…'}</span>`;

    ctx.save(); ctx.beginPath(); ctx.rect(PAD.l, 0, W - PAD.l - PAD.r, H); ctx.clip();
    // grid
    ctx.font = '10px system-ui, sans-serif'; ctx.strokeStyle = '#eee'; ctx.lineWidth = 1; ctx.fillStyle = '#888';
    const step = (hi - lo) > 120 ? 40 : (hi - lo) > 60 ? 20 : 10;
    for (let e = lo; e <= hi; e += step) { ctx.beginPath(); ctx.moveTo(PAD.l, Y(e)); ctx.lineTo(W - PAD.r, Y(e)); ctx.stroke(); }
    const vis = v.s1 - v.s0, kmStep = vis > 15000 ? 2000 : vis > 6000 ? 1000 : vis > 2000 ? 500 : vis > 800 ? 200 : 100;
    for (let s = Math.ceil(v.s0 / kmStep) * kmStep; s <= v.s1; s += kmStep) ctx.fillText(G.fmtLen(s), X(s) - 10, H - 4);

    // ground
    ctx.beginPath(); ctx.moveTo(X(S[k0].s), Y(lo));
    for (let k = k0; k <= k1; k++) ctx.lineTo(X(S[k].s), Y(g[k]));
    ctx.lineTo(X(S[k1].s), Y(lo)); ctx.closePath();
    ctx.fillStyle = '#efe6d6'; ctx.fill();
    ctx.beginPath(); for (let k = k0; k <= k1; k++) k > k0 ? ctx.lineTo(X(S[k].s), Y(g[k])) : ctx.moveTo(X(S[k].s), Y(g[k]));
    ctx.strokeStyle = '#a88f6a'; ctx.lineWidth = 1.2; ctx.stroke();

    // structures + type band
    const col = cur.line.color;
    const selSpan = TB.state.sel && TB.state.sel.type === 'span' && TB.state.sel.lineId === cur.line.id ? TB.state.sel.span : null;
    for (let k = Math.max(1, k0); k <= k1; k++) {
      const t = type[k], fam = C.SPANS[t].family, x0 = X(S[k - 1].s), x1 = X(S[k].s);
      if (fam === 'under') { ctx.fillStyle = hexA(col, 0.18); ctx.fillRect(x0, Y(z[k] + 6.5), Math.max(1, x1 - x0 + 0.5), Y(z[k] - 1) - Y(z[k] + 6.5)); }
      if ((fam === 'above' || fam === 'bridge') && Math.floor(S[k].s / 40) !== Math.floor(S[k - 1].s / 40) && z[k] - g[k] > 1) {
        ctx.strokeStyle = '#9e9e9e'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x1, Y(z[k] - 1)); ctx.lineTo(x1, Y(g[k])); ctx.stroke();
      }
      ctx.fillStyle = TYPE_COL[t]; ctx.globalAlpha = selSpan == null || S[k].span === selSpan ? 1 : 0.45;
      ctx.fillRect(x0, H - PAD.b + 3, Math.max(1, x1 - x0 + 0.5), S[k].span === selSpan ? 8 : 6);
      ctx.globalAlpha = 1;
    }
    // rail
    ctx.beginPath(); for (let k = k0; k <= k1; k++) k > k0 ? ctx.lineTo(X(S[k].s), Y(z[k])) : ctx.moveTo(X(S[k].s), Y(z[k]));
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();

    // bend points (draggable)
    cur.line.nodes.forEach((nd, i) => {
      if (nd.kind === 'station') return;
      const k = cur.nodeIdx[i], s = S[k].s; if (s < v.s0 || s > v.s1) return;
      ctx.beginPath(); ctx.arc(X(s), Y(z[k]), 4.5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    });

    // stations (draggable) + labels without overlaps
    ctx.textAlign = 'center';
    const rows = [-Infinity, -Infinity];
    for (const st of cur.stations) {
      const k = cur.nodeIdx[st.index], s = S[k].s, zz = z[k];
      if (s + st.L / 2 < v.s0 || s - st.L / 2 > v.s1) continue;
      const x0 = X(s - st.L / 2), x1 = X(s + st.L / 2), sel = TB.state.sel && TB.state.sel.nodeId === st.node.id;
      ctx.fillStyle = hexA(col, 0.85); ctx.fillRect(x0, Y(zz + 7), Math.max(4, x1 - x0), Y(zz - 1) - Y(zz + 7));
      ctx.strokeStyle = sel ? '#000' : '#333'; ctx.lineWidth = sel ? 2 : 1; ctx.strokeRect(x0, Y(zz + 7), Math.max(4, x1 - x0), Y(zz - 1) - Y(zz + 7));
      const name = st.node.name.length > 22 ? st.node.name.slice(0, 21) + '…' : st.node.name;
      const tw = ctx.measureText(name).width, xc = X(s);
      const r = xc - tw / 2 > rows[0] + 6 ? 0 : xc - tw / 2 > rows[1] + 6 ? 1 : -1;
      if (r >= 0) {
        rows[r] = xc + tw / 2;
        ctx.fillStyle = sel ? '#000' : '#333'; ctx.font = (sel ? 'bold ' : '') + '10px system-ui, sans-serif';
        ctx.fillText(name, xc, 11 + r * 11);
        ctx.strokeStyle = 'rgba(0,0,0,.13)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xc, 14 + r * 11); ctx.lineTo(xc, Y(zz + 7)); ctx.stroke();
      }
    }
    ctx.textAlign = 'left';
    // problems
    for (const w of cur.warnings) {
      if (w.sev !== 'error' || w.lat == null) continue;
      let best = 0, bd = Infinity; for (let k = 0; k < K; k += 2) { const d = Math.abs(S[k].lat - w.lat) + Math.abs(S[k].lon - w.lon); if (d < bd) { bd = d; best = k; } }
      if (S[best].s < v.s0 || S[best].s > v.s1) continue;
      ctx.fillStyle = '#d32f2f'; ctx.beginPath(); ctx.arc(X(S[best].s), Y(z[best]), 5, 0, 7); ctx.fill();
    }
    ctx.restore();

    // axis labels
    ctx.fillStyle = '#888'; ctx.font = '10px system-ui, sans-serif';
    for (let e = lo; e <= hi; e += step) ctx.fillText(e + ' m', 4, Y(e) + 3);
    // scrollbar when zoomed
    if (zoomed) {
      const bx = PAD.l, bw = W - PAD.l - PAD.r;
      ctx.fillStyle = '#e5e7eb'; ctx.fillRect(bx, H - 3, bw, 3);
      ctx.fillStyle = '#6b7280'; ctx.fillRect(bx + v.s0 / len * bw, H - 3, Math.max(8, (v.s1 - v.s0) / len * bw), 3);
    }

    // hover read-out
    const read = document.getElementById('pf-read');
    if (drag && drag.kind === 'node') {
      const f = M.findNode(drag.nodeId), d = f && f.node.depth;
      read.textContent = `${f && f.node.kind === 'station' ? f.node.name : 'Bend point'}: ${d > 0 ? d + ' m deep' : d < 0 ? -d + ' m up' : 'at grade'}` +
        (drag.range.dMin <= drag.range.dMax ? ` · allowed ${drag.range.dMin}…${drag.range.dMax} m by the grade limit` : '');
    } else if (hoverX != null) {
      const k = idxAt(hoverX);
      if (k != null) {
        const x = X(S[k].s);
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke(); ctx.setLineDash([]);
        const d = g[k] - z[k];
        const onNode = hoverY != null && hitNode(hoverX, hoverY);
        canvas.style.cursor = onNode ? 'ns-resize' : drag ? 'grabbing' : 'grab';
        read.textContent = onNode ? 'drag up/down to change depth' : `${G.fmtLen(S[k].s)} · ground ${g[k].toFixed(0)} m · rail ${z[k].toFixed(0)} m (${d > 1 ? d.toFixed(0) + ' m deep' : d < -1 ? (-d).toFixed(0) + ' m up' : 'at grade'}) · ${C.SPANS[type[k]].label}`;
        TB.app.hover(S[k].lat, S[k].lon);
      }
    } else read.textContent = 'scroll to zoom · drag to pan · drag stations to set depth · click a span to change it';
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  TB.profile = { init, update, draw };
})();
