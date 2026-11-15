// Line analysis: horizontal alignment (Hermite spline with straight platforms), vertical
// profile against real terrain, curves & speeds, station sites, exits, land, interchanges and
// a full cost estimate.
(function () {
  const G = TB.geo, C = TB.costs;
  const fam = (t) => C.SPANS[t].family;
  const UNDER = (t) => fam(t) === 'under';
  const parcelXY = new Map();

  function parcelRings(p) {
    let r = parcelXY.get(p.key);
    if (!r || r.src !== p.ringsLL) { r = { src: p.ringsLL, rings: p.ringsLL.map(rr => rr.map(q => G.toXY(q[0], q[1]))) }; r.bb = G.bbox(r.rings.flat()); parcelXY.set(p.key, r); }
    return r;
  }
  function acquiredAt(p, parcels) {
    for (const pc of parcels) {
      const r = parcelRings(pc);
      if (p[0] < r.bb[0] || p[0] > r.bb[2] || p[1] < r.bb[1] || p[1] > r.bb[3]) continue;
      if (G.pointInRings(p, r.rings)) return pc;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------
  function stationDims(line, node, level) {
    const m = C.MODES[line.mode], lay = m.layout[level];
    const W = node.width || lay.island;
    return { L: node.length || m.platform, W, layout: W >= lay.thr ? 'side' : 'island', lay };
  }
  const rotate = (v, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
  const clampRot = (r) => Math.max(-C.ROT_MAX, Math.min(C.ROT_MAX, r || 0));
  function defaultStationDepth(tb, ta) {
    const ts = [tb, ta].filter(Boolean);
    if (ts.some(UNDER)) return ts.includes('bored') ? 18 : 10;
    if (ts.some(t => fam(t) === 'cut')) return 7;
    if (ts.some(t => fam(t) === 'above')) return -9;
    return 0;
  }
  const levelOf = (depth) => depth > 3 ? 'under' : depth < -3 ? 'above' : 'surface';
  function transitionDepth(tb, ta) {
    const f = new Set([fam(tb), fam(ta)]);
    if (f.has('above') && f.has('bridge')) return -9;
    if (f.has('under') && f.has('cut')) return 7;
    return 0;
  }

  function buildPath(line) {
    const nodes = line.nodes, n = nodes.length;
    const P = nodes.map(nd => G.toXY(nd.lat, nd.lon));
    const tin = [], tout = [], depth = [], base = [];
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? G.norm(G.sub(P[i], P[i - 1])) : null, b = i < n - 1 ? G.norm(G.sub(P[i + 1], P[i])) : null;
      let t = a && b ? G.norm(G.add(a, b)) : (a || b || [1, 0]);
      base[i] = t;
      if (nodes[i].kind === 'station' && nodes[i].rot) t = rotate(t, clampRot(nodes[i].rot)); // tracks bend to fit the rotated box
      if (nodes[i].corner && a && b && nodes[i].kind !== 'station') { tin[i] = a; tout[i] = b; } else tin[i] = tout[i] = t;
      const tb = i > 0 ? nodes[i - 1].out.type : null, ta = i < n - 1 ? nodes[i].out.type : null;
      depth[i] = nodes[i].kind === 'station' ? (nodes[i].depth ?? defaultStationDepth(tb, ta)) : nodes[i].depth;
    }
    const ctrls = [];
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      if (nd.kind === 'station' && n > 1) {
        const { L } = stationDims(line, nd, levelOf(depth[i])), h = L / 2, t = tin[i];
        if (i > 0 && G.dxy(P[i], P[i - 1]) > h + 15) ctrls.push({ p: G.sub(P[i], G.mul(t, h)), tin: t, tout: t, node: i, part: -1 });
        ctrls.push({ p: P[i], tin: t, tout: t, node: i, part: 0 });
        if (i < n - 1 && G.dxy(P[i], P[i + 1]) > h + 15) ctrls.push({ p: G.add(P[i], G.mul(t, h)), tin: t, tout: t, node: i, part: 1 });
      } else ctrls.push({ p: P[i], tin: tin[i], tout: tout[i], node: i, part: 0 });
    }
    const S = [], nodeIdx = new Array(n).fill(0);
    let s = 0;
    const push = (p, span, inSt) => { const ll = G.toLL(p[0], p[1]); S.push({ x: p[0], y: p[1], lat: ll[0], lon: ll[1], s, span, inSt }); };
    if (!ctrls.length) return { P, S, nodeIdx, tin, depth, base };
    push(ctrls[0].p, 0, nodes[ctrls[0].node].kind === 'station' ? ctrls[0].node : -1);
    for (let k = 0; k < ctrls.length - 1; k++) {
      const c0 = ctrls[k], c1 = ctrls[k + 1], D = G.dxy(c0.p, c1.p);
      let span = c1.node > c0.node ? c0.node : (c0.part < 0 ? c0.node - 1 : c0.node);
      span = Math.max(0, Math.min(n - 2, span));
      const inSt = c0.node === c1.node ? c0.node : -1;
      const steps = Math.max(1, Math.ceil(D / 8));
      const m0 = G.mul(c0.tout, D), m1 = G.mul(c1.tin, D);
      let prev = c0.p;
      for (let j = 1; j <= steps; j++) {
        const t = j / steps, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        const p = [h00 * c0.p[0] + h10 * m0[0] + h01 * c1.p[0] + h11 * m1[0], h00 * c0.p[1] + h10 * m0[1] + h01 * c1.p[1] + h11 * m1[1]];
        s += G.dxy(prev, p); prev = p;
        push(p, span, inSt);
      }
      if (c1.part === 0) nodeIdx[c1.node] = S.length - 1;
    }
    return { P, S, nodeIdx, tin, depth, base };
  }

  // ---------------------------------------------------------------------------------------
  function analyzeLine(line, project) {
    const mode = C.MODES[line.mode], nodes = line.nodes, n = nodes.length;
    const R = { line, warnings: [], stations: [], spans: [], takings: new Map(), cost: {}, metrics: {} };
    const warn = (sev, msg, where, ref, fix) => R.warnings.push({ sev, msg, lat: where && where[0], lon: where && where[1], ref, fix });
    if (n < 2) {
      Object.assign(R, buildPath(line)); R.empty = true;
      R.cost = { total: 0, interchange: 0 }; R.metrics = { length: 0, stations: 0 };
      return R;
    }
    const path = buildPath(line); Object.assign(R, path);
    const { S, nodeIdx, depth } = path;
    const parcels = Object.values(project.parcels);
    const K = S.length;

    // ground
    const g = new Float64Array(K); let have = 0, last = null;
    for (let k = 0; k < K; k++) { const v = TB.terrain.sample(S[k].lat, S[k].lon); if (v != null) { g[k] = v; last = v; have++; } else g[k] = NaN; }
    R.groundReady = have === K;
    for (let k = 0; k < K; k++) if (isNaN(g[k])) g[k] = last ?? 100;
    const win = (k, r, fn, init) => { let a = init, c = 0; for (let j = Math.max(0, k - r); j <= Math.min(K - 1, k + r); j++) { a = fn(a, g[j]); c++; } return [a, c]; };
    const gS = new Float64Array(K), gLow = new Float64Array(K);
    for (let k = 0; k < K; k++) { const [sum, c] = win(k, 5, (a, v) => a + v, 0); gS[k] = sum / c; gLow[k] = win(k, 6, Math.min, Infinity)[0]; }

    // anchors
    const anchors = [];
    for (let i = 0; i < n; i++) {
      const tb = i > 0 ? nodes[i - 1].out.type : null, ta = i < n - 1 ? nodes[i].out.type : null;
      let d = depth[i];
      if (d == null) {
        if (i === 0 || i === n - 1) { const t = ta || tb; d = C.SPANS[t].rel == null ? 0 : -C.SPANS[t].rel; }
        else if (fam(tb) !== fam(ta)) d = transitionDepth(tb, ta);
      }
      if (d != null) {
        depth[i] = d;
        const portal = nodes[i].kind !== 'station' && !!tb && !!ta && UNDER(tb) !== UNDER(ta);
        anchors.push({ i, k: nodeIdx[i], s: S[nodeIdx[i]].s, z: gS[nodeIdx[i]] - d, portal });
      }
    }
    anchors.sort((a, b) => a.s - b.s);
    R.anchors = anchors.map(a => ({ ...a, g: gS[a.k], node: nodes[a.i].id }));
    const anchorsAround = (s) => {
      let A = anchors[0], B = anchors[anchors.length - 1];
      for (const a of anchors) { if (a.s <= s) A = a; if (a.s >= s) { B = a; break; } }
      return [A, B];
    };
    const depthLimits = (a) => nodes[a.i].kind === 'station' && levelOf(depth[a.i]) === 'under' ? [8, 55] : nodes[a.i].kind === 'station' ? [-15, 3] : [-15, 55];
    // Suggested repair for a tunnel that breaks out into a valley: deepen the anchors on either
    // side just enough (respecting the grade limit) for the tunnel to pass under with cover.
    const fixBreakout = (k, spanI) => {
      const zreq = gLow[k] - 14, s = S[k].s, changes = [];
      for (const a of anchorsAround(s)) {
        if (a.portal) return { label: 'Make this span a bridge', changes: [{ span: spanI, type: 'bridge' }] };
        const need = Math.ceil(gS[a.k] - (zreq + Gmax * Math.abs(s - a.s)));
        if (need > depth[a.i] + 0.5) {
          if (need > depthLimits(a)[1]) return { label: 'Too deep to tunnel under – make this span a bridge', changes: [{ span: spanI, type: 'bridge' }] };
          changes.push({ node: nodes[a.i].id, depth: need, name: nodes[a.i].name || 'bend point' });
        }
      }
      return changes.length ? { label: 'Go deeper: ' + changes.map(c => `${c.name} → ${c.depth} m`).join(', '), changes } : null;
    };
    // Suggested repair for an over-steep grade: move one end's depth just enough.
    const fixGrade = (k) => {
      const [A, B] = anchorsAround(S[k].s);
      if (A === B) return null;
      const maxD = Gmax * (B.s - A.s) * 0.98, opts = [];
      for (const [X, Y, sign] of [[A, B, 1], [B, A, -1]]) {
        // move X so that |zX - zY| ≤ maxD
        const target = X.z > Y.z + maxD ? Y.z + maxD : X.z < Y.z - maxD ? Y.z - maxD : null;
        if (target == null) continue;
        const d = Math.round(gS[X.k] - target), [lo, hi] = depthLimits(X);
        if (d < lo || d > hi) continue;
        opts.push({ X, d, cost: Math.abs(d - depth[X.i]) + (nodes[X.i].kind === 'station' ? 5 : 0) });
      }
      if (!opts.length) return null;
      const o = opts.sort((a, b) => a.cost - b.cost)[0];
      const nm = nodes[o.X.i].name || 'bend point';
      return { label: `Set ${nm} to ${o.d > 0 ? o.d + ' m deep' : o.d < 0 ? (-o.d) + ' m up' : 'ground level'}`, changes: [{ node: nodes[o.X.i].id, depth: o.d }] };
    };

    // vertical profile: per-sample target level, made grade-feasible, then pinned to anchors
    const z = new Float64Array(K), type = S.map(p => nodes[p.span].out.type), Gmax = mode.grade;
    const target = new Float64Array(K), lin = new Float64Array(K), seg = new Int32Array(K);
    let ai = 0;
    for (let k = 0; k < K; k++) {
      const s = S[k].s;
      while (ai < anchors.length - 2 && anchors[ai + 1].s <= s) ai++;
      const A = anchors[ai], B = anchors[Math.min(ai + 1, anchors.length - 1)];
      seg[k] = ai;
      lin[k] = B.s > A.s ? A.z + (B.z - A.z) * (s - A.s) / (B.s - A.s) : A.z;
      const t = type[k], sp = C.SPANS[t], od = nodes[S[k].span].out.depth;
      let tg;
      if (sp.family === 'bridge') tg = lin[k];
      else if (t === 'bored') tg = od != null ? gS[k] - od : Math.min(lin[k], gLow[k] - 14);
      else if (od != null && (sp.family === 'under' || sp.family === 'cut')) tg = gS[k] - od;
      else tg = gS[k] + sp.rel;
      if (S[k].inSt >= 0) tg = gS[nodeIdx[S[k].inSt]] - depth[S[k].inSt];
      target[k] = tg;
    }
    // lower envelope with slope ≤ Gmax (tunnels dive gradually under valleys, cuts ease into hills)
    for (let k = 1; k < K; k++) target[k] = Math.min(target[k], target[k - 1] + Gmax * (S[k].s - S[k - 1].s));
    for (let k = K - 2; k >= 0; k--) target[k] = Math.min(target[k], target[k + 1] + Gmax * (S[k + 1].s - S[k].s));
    for (let k = 0; k < K; k++) {
      const s = S[k].s, A = anchors[seg[k]], B = anchors[Math.min(seg[k] + 1, anchors.length - 1)];
      const lo = Math.max(A.z - Gmax * (s - A.s), B.z - Gmax * (B.s - s)), hi = Math.min(A.z + Gmax * (s - A.s), B.z + Gmax * (B.s - s));
      z[k] = lo <= hi ? Math.max(lo, Math.min(hi, target[k])) : lin[k];
    }
    R.profile = { g, gS, z, type };

    // curvature & speed
    const radius = new Float64Array(K).fill(Infinity);
    for (let k = 3; k < K - 3; k++) radius[k] = G.circumradius([S[k - 3].x, S[k - 3].y], [S[k].x, S[k].y], [S[k + 3].x, S[k + 3].y]);

    // ---- spans -------------------------------------------------------------------------
    for (let i = 0; i < n - 1; i++) {
      const t = nodes[i].out.type, sp = C.SPANS[t];
      const sp0 = S[nodeIdx[i]].s, sp1 = S[nodeIdx[i + 1]].s;
      const span = { i, type: t, node: nodes[i], s0: sp0, s1: sp1, len: sp1 - sp0, cost: 0, minR: Infinity, maxGrade: 0, minCover: Infinity, maxH: 0, surveyed: true, notes: [] };
      let validLen = 0, okLen = 0, waterLen = 0, under = sp.family === 'under';
      const nearPortal = (s) => anchors.some(a => (a.portal || (nodes[a.i].kind === 'station' && depth[a.i] <= 3)) && Math.abs(a.s - s) < (8 / Gmax + 40));
      for (let k = 1; k < K; k++) {
        if (S[k].span !== i) continue;
        const ds = S[k].s - S[k - 1].s, P = [S[k].x, S[k].y];
        const dep = gS[k] - z[k], h = z[k] - g[k];
        if (radius[k] < span.minR && S[k].inSt < 0) { span.minR = radius[k]; span.minRAt = k; }
        if (k > 5) { const gr = Math.abs(z[k] - z[k - 5]) / Math.max(1, S[k].s - S[k - 5].s); if (gr > span.maxGrade) { span.maxGrade = gr; span.gradeAt = k; } }
        const box = S[k].inSt >= 0 && levelOf(depth[S[k].inSt]) !== 'surface';
        if (box) continue; // the station box includes this track
        let perM;
        switch (sp.family) {
          case 'under': perM = t === 'bored' ? sp.perM * (1 + Math.max(0, dep - 20) / 80) : sp.perM * (1 + Math.max(0, dep - 10) / 14); break;
          case 'bridge': perM = sp.perM + (t === 'bridge' ? sp.perMHeight * Math.max(0, h) : 0); break;
          case 'above': perM = sp.perM + 1300 * Math.max(0, h - 12); break;
          default: perM = sp.perM;
        }
        if (under) {
          const cover = g[k] - z[k] - 6.5;
          if (!nearPortal(S[k].s)) {
            if (cover < span.minCover) { span.minCover = cover; span.coverAt = k; }
          }
          if (t === 'cutcover' && dep > 24 && !span.deepCC) { span.deepCC = k; }
        }
        if (sp.family === 'above' || sp.family === 'bridge') span.maxH = Math.max(span.maxH, h);
        // corridor survey checks
        const surveyed = TB.osm.coveredXY(P);
        if (!surveyed) span.surveyed = false;
        if (surveyed && (t === 'rail' || t === 'oldbridge' || t === 'street')) {
          validLen += ds;
          let ok;
          if (t === 'rail') ok = !!TB.osm.nearestLinear(P, 'rail', f => !f.tunnel && f.cls === 'rail', 25);
          else if (t === 'oldbridge') ok = !!TB.osm.nearestLinear(P, 'road', f => f.bridge, 15) || !!TB.osm.nearestLinear(P, 'rail', f => f.bridge, 15);
          else ok = !!TB.osm.nearestLinear(P, 'road', f => !f.tunnel && !/service|pedestrian|living_street/.test(f.cls), 14);
          if (ok) okLen += ds;
          else perM = t === 'rail' ? C.SPANS.atgrade.perM : t === 'oldbridge' ? C.SPANS.bridge.perM + C.SPANS.bridge.perMHeight * Math.max(0, h) : C.SPANS.atgrade.perM;
        }
        if (surveyed && (sp.family === 'bridge' || sp.family === 'above')) {
          if (TB.osm.surfaceAt(P).cat === 'water') { waterLen += ds; perM *= 1.3; }
        }
        // property takings along surface / shallow alignments
        if (surveyed && (sp.family !== 'under' || t === 'cutcover') && t !== 'oldbridge') {
          const dir = G.norm([S[Math.min(K - 1, k + 1)].x - S[k - 1].x, S[Math.min(K - 1, k + 1)].y - S[k - 1].y]);
          const nr = [-dir[1], dir[0]], hw = (t === 'street' ? mode.row * 0.6 : mode.row) / 2;
          for (const off of sp.family === 'bridge' ? [0] : [-hw, 0, hw]) {
            const q = [P[0] + nr[0] * off, P[1] + nr[1] * off];
            const b = TB.osm.areasAt(q).find(f => f.cat === 'building');
            if (b && !project.parcels[b.key] && !R.takings.has(b.key)) R.takings.set(b.key, { f: b, span: i, lat: S[k].lat, lon: S[k].lon });
          }
        }
        span.cost += perM * ds;
      }
      if (validLen > 50 && okLen / validLen < 0.7) {
        const msg = { rail: 'No existing rail corridor along much of this span – costed as new at-grade track there',
          oldbridge: 'No existing bridge found along much of this span – costed as a new bridge there',
          street: 'Street-running track leaves the street – costed as new right-of-way there' }[t];
        span.notes.push(msg); warn('warn', msg, [S[nodeIdx[i]].lat, S[nodeIdx[i]].lon], { span: i, line: line.id });
      }
      if (waterLen > 0) span.notes.push(`${Math.round(waterLen)} m over water (+30 %)`);
      if (span.minCover < 1.5) {
        const p = S[span.coverAt];
        warn('error', `Tunnel breaks out of the ground (${(span.minCover + 6.5).toFixed(0)} m to surface incl. tunnel) – the valley is too deep here. Go deeper, or switch this span to a bridge.`, [p.lat, p.lon], { span: i, line: line.id }, fixBreakout(span.coverAt, i));
      } else if (span.minCover < 6 && t === 'bored') {
        const p = S[span.coverAt];
        warn('warn', `Very shallow bored tunnel (${span.minCover.toFixed(0)} m cover) – ground treatment needed`, [p.lat, p.lon], { span: i, line: line.id });
        span.cost *= 1.08;
      }
      if (span.deepCC) warn('warn', 'Cut-and-cover deeper than 24 m – a bored tunnel would be cheaper here', [S[span.deepCC].lat, S[span.deepCC].lon], { span: i, line: line.id });
      if (span.maxGrade > Gmax + 0.003) {
        const p = S[span.gradeAt];
        warn('error', `Grade ${(span.maxGrade * 100).toFixed(1)} % exceeds the ${(Gmax * 100).toFixed(1)} % limit for ${mode.label.toLowerCase()} – move stations apart or change depths`, [p.lat, p.lon], { span: i, line: line.id }, fixGrade(span.gradeAt));
      }
      if (span.minR < mode.hardR && !(t === 'street' && line.mode === 'lrt')) {
        const p = S[span.minRAt];
        warn('warn', `Very tight curve (R ≈ ${Math.round(span.minR)} m) – slow running and wheel squeal`, [p.lat, p.lon], { span: i, line: line.id });
      }
      if (t === 'street' && line.mode !== 'lrt') warn('warn', `${mode.label} can't share streets with traffic – choose LRT mode or a grade-separated span`, [S[nodeIdx[i]].lat, S[nodeIdx[i]].lon], { span: i, line: line.id });
      if (!span.surveyed && (t !== 'bored' && t !== 'bridge')) span.pending = true;
      R.spans.push(span);
    }

    // portals: changes between underground and anything else along the line
    const levels = [];
    for (let i = 0; i < n; i++) {
      if (nodes[i].kind === 'station') levels.push(levelOf(depth[i]) === 'under');
      if (i < n - 1) levels.push(UNDER(nodes[i].out.type));
    }
    let portals = 0; for (let i = 1; i < levels.length; i++) if (levels[i] !== levels[i - 1]) portals++;
    R.portals = portals;

    // ---- stations ------------------------------------------------------------------------
    for (let i = 0; i < n; i++) {
      const nd = nodes[i]; if (nd.kind !== 'station') continue;
      R.stations.push(analyzeStation(line, nd, i, path, depth[i], parcels, project, warn, gS[nodeIdx[i]]));
    }

    // ---- running time --------------------------------------------------------------------
    const vlim = new Float64Array(K), a = 1.0, b = 1.1;
    for (let k = 0; k < K; k++) {
      let v = mode.vmax / 3.6;
      if (type[k] === 'street') v = Math.min(v, 50 / 3.6);
      v = Math.min(v, Math.sqrt(1.1 * radius[k]));
      vlim[k] = Math.max(v, 15 / 3.6);
    }
    const stopK = new Set(R.stations.map(s => nodeIdx[s.index]));
    const vf = new Float64Array(K), vb = new Float64Array(K);
    for (let k = 1; k < K; k++) vf[k] = stopK.has(k) ? 0 : Math.min(vlim[k], Math.sqrt(vf[k - 1] ** 2 + 2 * a * (S[k].s - S[k - 1].s)));
    for (let k = K - 2; k >= 0; k--) vb[k] = stopK.has(k) ? 0 : Math.min(vlim[k], Math.sqrt(vb[k + 1] ** 2 + 2 * b * (S[k + 1].s - S[k].s)));
    let T = 0, streetLen = 0;
    for (let k = 1; k < K; k++) {
      const v0 = Math.min(vf[k - 1], vb[k - 1]), v1 = Math.min(vf[k], vb[k]), ds = S[k].s - S[k - 1].s;
      T += ds / Math.max(0.6, (v0 + v1) / 2);
      if (type[k] === 'street') streetLen += ds;
    }
    T += Math.max(0, R.stations.length - 2) * C.DWELL + streetLen / 1000 * 18;
    const length = S[K - 1].s;

    // ---- totals --------------------------------------------------------------------------
    const sum = (arr, f) => arr.reduce((acc, x) => acc + f(x), 0);
    const track = sum(R.spans, s => s.cost) + portals * C.PORTAL;
    const stations = sum(R.stations, s => s.structure + s.fit + s.finishes);
    const exits = sum(R.stations, s => s.exitCost);
    let takings = 0;
    for (const tk of R.takings.values()) { tk.cost = C.parcelCost(tk.f, tk.lat, tk.lon).total * 1.2; takings += tk.cost; }
    const land = sum(R.stations, s => s.land + s.takingCost) + takings;
    const connections = sum(R.stations, s => s.connCost);
    const systems = mode.systemsKm * length / 1000;
    const trainLen = Math.min(...R.stations.map(s => s.L), mode.platform);
    const cycle = 2 * T + 600, trains = Math.ceil(Math.ceil(cycle / mode.headway) * 1.1);
    const fleet = R.stations.length >= 2 ? trains * trainLen * mode.trainPerM + (length > 1500 ? mode.yard : 0) : 0;
    const hard = track + stations + exits + connections + systems;
    const soft = hard * C.SOFT;
    const contingency = (hard + soft + land + fleet) * C.CONTINGENCY;
    R.cost = { track, stations, exits, land, connections, systems, fleet, soft, contingency, interchange: 0 };
    R.cost.total = track + stations + exits + land + connections + systems + fleet + soft + contingency;
    R.metrics = { length, stations: R.stations.length, runtime: T, speed: T > 0 ? length / T * 3.6 : 0, trains, trainLen, portals,
      spacing: R.stations.length > 1 ? length / (R.stations.length - 1) : 0 };
    return R;
  }

  // ---------------------------------------------------------------------------------------
  function analyzeStation(line, nd, i, path, depth, parcels, project, warn, groundZ) {
    const level = levelOf(depth), { L, W, layout, lay } = stationDims(line, nd, level);
    const c = path.P[i], dir = path.tin[i];
    const st = { node: nd, index: i, lineId: line.id, level, depth, L, W, layout, lay, c, dir, baseDir: path.base[i], rot: clampRot(nd.rot),
      ground: groundZ, lat: nd.lat, lon: nd.lon, rect: G.rect(c, dir, L, W), site: {}, warnings: [], exits: [], junctions: [], exitEdges: [], conns: [] };
    st.rectLL = st.rect.map(p => G.toLL(p[0], p[1]));
    const where = [nd.lat, nd.lon], ref = { node: nd.id, line: line.id };
    const w = (sev, msg) => { st.warnings.push({ sev, msg }); warn(sev, `${nd.name}: ${msg}`, where, ref); };
    const lv = C.landValue(nd.lat, nd.lon); st.landValue = lv;

    // what's above the box
    const nx = Math.max(3, Math.ceil(L / 6)), ny = Math.max(2, Math.ceil(W / 4)), counts = {}, nrm = [-dir[1], dir[0]];
    const buildingsHit = new Map();
    let total = 0;
    for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
      const u = ((a + 0.5) / nx - 0.5) * L, v = ((b + 0.5) / ny - 0.5) * W;
      const p = [c[0] + dir[0] * u + nrm[0] * v, c[1] + dir[1] * u + nrm[1] * v];
      let cat;
      if (acquiredAt(p, parcels)) cat = 'acquired';
      else if (!TB.osm.coveredXY(p)) cat = 'unknown';
      else {
        const sAt = TB.osm.surfaceAt(p); cat = sAt.cat;
        if (cat === 'building') buildingsHit.set(sAt.f.key, sAt.f);
        if (!C.SITE[cat]) cat = 'open';
      }
      counts[cat] = (counts[cat] || 0) + 1; total++;
    }
    for (const k in counts) st.site[k] = counts[k] / total;
    st.surveyed = !counts.unknown;
    const methodF = Object.entries(st.site).reduce((acc, [k, f]) => acc + f * C.SITE[k].f, 0);
    st.methodF = methodF;
    const style = C.STYLES[nd.style || 'standard'];
    const own = parcels.filter(p => p.nodeId === nd.id);
    st.parcels = own;
    st.land = own.reduce((acc, p) => acc + C.parcelCost(p, p.lat, p.lon).total, 0);
    const stagingArea = own.reduce((acc, p) => acc + (G.rectDist(G.toXY(p.lat, p.lon), c, dir, L, W) < 200 ? p.area : 0), 0);
    st.stagingArea = stagingArea;
    st.takingCost = 0; st.takings = [];

    if (level === 'under') {
      const region = 1 + 0.3 * Math.min(1, lv / 40000);
      st.region = region;
      st.structure = L * W * (depth + 7) * 800 * methodF * region;
      if (stagingArea < 2500) { st.structure *= 1.1; st.noStaging = true; }
      st.fit = 14e6 + Math.max(0, depth) * 0.45e6;
      st.finishes = 0.18 * st.structure * style.mult;
      if (depth > 35) w('info', `Deep station (${Math.round(depth)} m) – long escalator rides`);
      if ((st.site.building || 0) > 0.4) w('warn', `${Math.round(st.site.building * 100)} % of the box is under buildings – mined construction (×${C.SITE.building.f}). Acquire them, or move the box under a road or lot.`);
      if (st.noStaging && st.surveyed) w('info', 'No construction staging site (≥ 2,500 m² acquired within 200 m) – +10 % on the box');
    } else {
      const unit = level === 'above' ? 9000 : 1800, fixed = level === 'above' ? 8e6 : (line.mode === 'lrt' ? 1.5e6 : 3e6);
      st.structure = L * W * unit + fixed;
      st.fit = level === 'above' ? 3e6 : 0.5e6;
      st.finishes = (level === 'above' ? 0.2 : 0.25) * st.structure * style.mult;
      for (const f of buildingsHit.values()) {
        const cst = C.parcelCost(f, nd.lat, nd.lon).total * 1.2;
        st.takings.push({ f, cost: cst }); st.takingCost += cst;
      }
      if (st.takings.length) w('warn', `Footprint needs ${st.takings.length} building${st.takings.length > 1 ? 's' : ''} demolished (${C.fmt(st.takingCost)} forced expropriation)`);
      if (line.mode !== 'lrt' && level === 'surface' && (st.site.road || 0) > 0.5) w('warn', 'Heavy-rail station in the middle of a road');
    }

    // exits: a tree of passages from the box through optional junctions to street-level portals
    const exits = nd.exits || [], juncs = nd.junctions || [];
    const pos = new Map();
    for (const j of juncs) pos.set(j.id, G.toXY(j.lat, j.lon));
    for (const e of exits) pos.set(e.id, G.toXY(e.lat, e.lon));
    const boxEdge = (p) => nearestOnRect(p, c, dir, L, W);
    const perM = C.EXIT.passage[level];
    const chainLen = new Map(); // walking distance box → item
    const lenTo = (item, guard = 0) => {
      if (chainLen.has(item.id)) return chainLen.get(item.id);
      const p = pos.get(item.id), parent = item.parent && pos.has(item.parent) && guard < 30 ? juncs.find(j => j.id === item.parent) : null;
      const from = parent ? pos.get(parent.id) : boxEdge(p);
      const l = G.dxy(p, from) + (parent ? lenTo(parent, guard + 1) : 0);
      chainLen.set(item.id, l);
      return l;
    };
    let exitCost = 0;
    for (const item of [...juncs, ...exits]) {
      const p = pos.get(item.id), parent = item.parent && pos.has(item.parent) ? pos.get(item.parent) : null;
      const from = parent || boxEdge(p), len = G.dxy(p, from);
      st.exitEdges.push({ from: G.toLL(from[0], from[1]), to: [item.lat, item.lon], len, id: item.id });
      exitCost += len * perM;
    }
    for (const j of juncs) {
      const cst = C.EXIT.junction[level];
      st.junctions.push({ j, cost: cst, passage: lenTo(j) }); exitCost += cst;
    }
    exits.forEach((ex, n) => {
      const p = pos.get(ex.id), sf = exitSurface(p, parcels);
      const f = { acquired: 0.85, road: 1.0, park: 0.95, parking: 0.9, open: 1 }[sf.cat] || (sf.ok ? 1 : 1.6);
      const own = st.exitEdges.find(e => e.id === ex.id).len * perM;
      const portal = C.EXIT.portal(level, depth) * f;
      st.exits.push({ ex, surf: sf.cat, ok: sf.ok, why: sf.why, passage: lenTo(ex), cost: portal + own, portal });
      exitCost += portal;
      if (!sf.ok) w('warn', `Exit ${n + 1}: ${sf.why} (+60 %)`);
      if (lenTo(ex) > 150) w('info', `Exit ${n + 1} has a ${Math.round(lenTo(ex))} m passage`);
    });
    if (level === 'under' && exits.length < 2) {
      w(exits.length ? 'warn' : 'info', exits.length ? 'Only one exit – fire code (NFPA 130) needs two; a second is costed automatically' : 'No exits placed – two default sidewalk exits are costed');
      st.defaultExits = 2 - exits.length;
      exitCost += st.defaultExits * (C.EXIT.portal(level, depth) + 25 * perM);
    }
    st.exitCost = exitCost;

    // connections to the existing network (with an optional hand-shaped passage)
    st.connCost = 0;
    for (const key of nd.connect || []) {
      const ex = TB.network.byKey(key); if (!ex) continue;
      st.conns.push(connectionCost(st, ex, line, (nd.links || {})[key] || {}));
      st.connCost += st.conns[st.conns.length - 1].cost;
    }
    for (const cn of st.conns) for (const m of cn.warnings) w(m.sev, m.msg);
    return st;
  }

  function nearestOnRect(p, c, d, L, W) {
    const v = G.sub(p, c), nr = [-d[1], d[0]];
    let a = G.dot(v, d), b = G.dot(v, nr);
    const ca = Math.max(-L / 2, Math.min(L / 2, a)), cb = Math.max(-W / 2, Math.min(W / 2, b));
    if (ca === a && cb === b) { // inside: push to the nearest edge
      if (L / 2 - Math.abs(a) < W / 2 - Math.abs(b)) a = Math.sign(a || 1) * L / 2; else b = Math.sign(b || 1) * W / 2;
      return G.add(c, G.add(G.mul(d, a), G.mul(nr, b)));
    }
    return G.add(c, G.add(G.mul(d, ca), G.mul(nr, cb)));
  }

  // Can a street-level exit go here? Allowed on acquired land, public land (parks, public
  // parking, roads / sidewalks) and unclaimed grey space – not on private land you haven't bought.
  function exitSurface(p, parcels) {
    if (acquiredAt(p, parcels)) return { cat: 'acquired', ok: true };
    if (!TB.osm.coveredXY(p)) return { cat: 'unknown', ok: true, pending: true };
    const s = TB.osm.surfaceAt(p), f = s.f;
    switch (s.cat) {
      case 'road': case 'open': return { cat: s.cat, ok: true };
      case 'park': return f && f.public ? { cat: 'park', ok: true } : { cat: 'park', ok: false, why: 'private green space – acquire it first' };
      case 'parking': return f && f.public ? { cat: 'parking', ok: true } : { cat: 'parking', ok: false, why: 'private parking lot – acquire it first' };
      case 'building': return { cat: 'building', ok: false, why: 'inside a building you don\'t own – acquire it first' };
      case 'vacant': return { cat: 'vacant', ok: false, why: 'private land – acquire it first' };
      case 'water': return { cat: 'water', ok: false, why: 'in the water' };
      case 'rail': return { cat: 'rail', ok: false, why: 'on an operating railway' };
      default: return { cat: s.cat, ok: false, why: `on ${(C.SITE[s.cat] || {}).label || s.cat} – acquire it first` };
    }
  }

  // Share of built-up and open land around a point
  function siteAround(xy, r) {
    let n = 0, b = 0, o = 0, unk = 0;
    for (let x = -r; x <= r; x += 12) for (let y = -r; y <= r; y += 12) {
      if (x * x + y * y > r * r) continue;
      const p = [xy[0] + x, xy[1] + y]; n++;
      if (!TB.osm.coveredXY(p)) { unk++; continue; }
      const cat = TB.osm.surfaceAt(p).cat;
      if (cat === 'building') b++;
      else if (/parking|park|vacant|open/.test(cat)) o++;
    }
    const m = n - unk;
    return { frac: m > 0 ? b / m : null, open: m > 0 ? o / m : null, surveyed: unk === 0 };
  }
  const buildingFraction = siteAround;

  function existingDir(ex) {
    const line = TRANSIT.find(l => l.id === ex.lineId) || (window.CONSTRUCTION || []).find(l => l.id === ex.lineId);
    let best = Infinity, dir = [1, 0];
    for (const seg of line.segments) for (let i = 1; i < seg.length; i++) {
      const a = G.toXY(seg[i - 1][1], seg[i - 1][0]), b = G.toXY(seg[i][1], seg[i][0]);
      const d = G.pointSegDist(ex.xy, a, b);
      if (d < best) { best = d; dir = G.norm(G.sub(b, a)); }
    }
    return dir;
  }

  function connectionCost(st, ex, line, link) {
    const warnings = [], lv = C.landValue(ex.lat, ex.lon);
    // how cramped is the existing station? built-up land makes it harder, open lots / parks easier
    const sa = siteAround(ex.xy, 90), cov = sa.frac ?? Math.min(0.7, lv / 40000 + 0.2), open = sa.open ?? 0.2;
    const crowd = 1 + 1.3 * cov, landF = 1 + lv / 25000, space = 1 - 0.35 * open;
    const loc = crowd * landF * space;
    const uc = ex.kind === 'construction';
    const busy = uc ? 1 : ex.name === 'Union' ? 1.8 : (ex.lineId === 'L1' || ex.lineId === 'L2') && lv > 12000 ? 1.6 : 1;
    // passage: box edge → (hand-shaped bend points) → existing station
    const via = (link.via || []).map(q => G.toXY(q[0], q[1]));
    const start = nearestOnRect(via[0] || ex.xy, st.c, st.dir, st.L, st.W);
    const ptsXY = [start, ...via, ex.xy];
    let passage = 0; for (let k = 1; k < ptsXY.length; k++) passage += G.dxy(ptsXY[k - 1], ptsXY[k]);
    const surface = link.type === 'surface';
    // tying into a station that is still being built is cheaper than retrofitting an operating one
    const base = (ex.kind === 'go' ? 22e6 : ex.grade === 'tunnel' ? 45e6 : 9e6) * (uc ? 0.7 : 1) * (surface ? 0.45 : 1);
    if (uc) warnings.push({ sev: 'info', msg: `${ex.name} (${ex.lineName}) is still under construction – design changes now are 30 % cheaper than a retrofit` });
    let conflict = 1;
    const ang = G.angleBetween(existingDir(ex), st.dir) * 180 / Math.PI, crossing = Math.min(ang, 180 - ang) > 25;
    const dz = st.depth - ex.depth;
    if (passage < 60 && crossing) {
      if (st.level === 'under' && ex.grade === 'tunnel' && Math.abs(dz) < 8) {
        conflict = 1.5;
        warnings.push({ sev: 'warn', msg: `Rail level too close to ${ex.lineName} (≈${ex.depth} m deep) – set depth ≥ ${ex.depth + 9} m to pass underneath (+50 % connection cost)` });
      } else if (st.level === 'under' && ex.grade !== 'tunnel' && st.depth < 8) {
        conflict = 1.3;
        warnings.push({ sev: 'warn', msg: `Too shallow to pass under ${ex.lineName} – needs ≥ 8 m` });
      } else if (st.level === 'surface' && ex.grade === 'surface') {
        conflict = 1.4;
        warnings.push({ sev: 'info', msg: `At-grade crossing of ${ex.lineName} – needs a diamond crossing or grade separation` });
      }
    }
    if (passage > 250) warnings.push({ sev: 'warn', msg: `${ex.name} is ${Math.round(passage)} m away – very long transfer walk` });
    if (surface && passage > 120) warnings.push({ sev: 'info', msg: `Transfer to ${ex.name} is an outdoor ${Math.round(passage)} m walk` });
    const discount = st.stagingArea >= 2000 ? 0.8 : 1;
    const baseCost = base * loc * busy * conflict, passageCost = passage * (surface ? 6e3 : 45e3 * loc);
    const cost = (baseCost + passageCost) * discount;
    const diff = loc * busy * conflict;
    return { ex, cost, baseCost, passageCost, passage, loc, crowd, landF, space, landValue: lv, open, busy, conflict, discount, coverage: cov,
      surveyed: sa.surveyed, warnings, type: surface ? 'surface' : 'tunnel', ptsLL: ptsXY.map(q => G.toLL(q[0], q[1])),
      difficulty: diff < 1.6 ? 'Easy' : diff < 2.3 ? 'Moderate' : diff < 3.2 ? 'Hard' : 'Extreme' };
  }

  // ---------------------------------------------------------------------------------------
  function analyzeProject(project) {
    const res = { lines: new Map(), interchanges: [], warnings: [] };
    for (const line of project.lines) res.lines.set(line.id, analyzeLine(line, project));
    // interchanges between user lines
    const all = [];
    for (const r of res.lines.values()) for (const s of r.stations || []) all.push(s);
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
      const A = all[a], B = all[b];
      if (A.lineId === B.lineId) continue;
      const d = G.dxy(A.c, B.c);
      if (d > 150) continue;
      const mid = G.mul(G.add(A.c, B.c), 0.5), [mlat, mlon] = G.toLL(mid[0], mid[1]);
      const lv = C.landValue(mlat, mlon), bf = buildingFraction(mid, 80), cov = bf.frac ?? 0.4;
      const loc = 1 + 1.2 * cov + lv / 30000;
      const ang = G.angleBetween(A.dir, B.dir) * 180 / Math.PI, a2 = Math.min(ang, 180 - ang);
      const both = A.level === 'under' && B.level === 'under', dz = Math.abs(A.depth - B.depth);
      const passage = Math.max(0, d - (A.W + B.W) / 2);
      let cost = (both ? 14e6 : 6e6) * loc + passage * 40e3 * loc;
      const notes = [], warns = [];
      let kind = 'connected';
      if (both && a2 > 25 && d < (Math.max(A.L, B.L) / 2 + 10) && dz < 9) {
        cost += 0.35 * Math.min(A.structure, B.structure);
        warns.push(`${A.node.name} / ${B.node.name}: station boxes cross at almost the same level (Δ ${dz.toFixed(0)} m) – stack them ≥ 9 m apart`);
      } else if (a2 < 15 && dz < 3 && d < 45 && A.level === B.level) {
        kind = 'cross-platform';
        cost += 0.25 * (A.structure + B.structure) / 2;
        notes.push('Cross-platform interchange – best possible transfer');
      } else if (both && a2 > 25) { kind = 'stacked'; notes.push(`Stacked crossing, Δ ${dz.toFixed(0)} m`); }
      const tight = ((A.site.building || 0) + (B.site.building || 0)) / 2;
      if (tight > 0.5) { cost *= 1.3; warns.push(`${A.node.name} / ${B.node.name}: very constrained site for an interchange – acquire land or shift the boxes`); }
      const ic = { a: A, b: B, d, cost, kind, notes, loc, angle: a2, dz };
      res.interchanges.push(ic);
      A.interchange = (A.interchange || []).concat(ic); B.interchange = (B.interchange || []).concat(ic);
      for (const st of [A, B]) {
        const r = res.lines.get(st.lineId);
        r.cost.interchange += cost / 2;
        r.cost.total += cost / 2 * (1 + C.SOFT) * (1 + C.CONTINGENCY);
      }
      for (const m of warns) res.lines.get(A.lineId).warnings.push({ sev: 'warn', msg: m, lat: A.lat, lon: A.lon, ref: { node: A.node.id, line: A.lineId } });
    }
    for (const r of res.lines.values()) res.warnings.push(...r.warnings);
    // catchment
    const centres = all.map(s => s.c);
    res.catchment = TB.population.catchment(centres, 800);
    for (const r of res.lines.values()) {
      const cm = TB.population.catchment((r.stations || []).map(s => s.c), 800);
      r.metrics.catchment = cm;
      if (cm) (r.stations || []).forEach((s, k) => { s.catchment = cm.per[k]; });
    }
    res.total = [...res.lines.values()].reduce((a, r) => a + (r.cost.total || 0), 0);
    res.length = [...res.lines.values()].reduce((a, r) => a + (r.metrics.length || 0), 0);
    return res;
  }

  TB.analysis = { analyzeProject, analyzeLine, buildPath, levelOf, stationDims, exitSurface, nearestOnRect, connectionCost, clampRot,
    exitSurfaceLL: (lat, lon) => exitSurface(G.toXY(lat, lon), Object.values(TB.model.project.parcels)) };
})();
