// Map rendering of the user's network.
(function () {
  const G = TB.geo, C = TB.costs;
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  let map, vec, labels, handleLayer, parcelLayer;
  const handles = new Map();  // persistent draggable markers, keyed
  let ghosts = [];            // transient "drag to insert" markers
  const H = {};               // handlers set by the editor

  const lineW = (z) => clamp(3, 9, (z - 9) * 1.1);

  function init(m, handlers) {
    map = m; Object.assign(H, handlers);
    parcelLayer = L.layerGroup().addTo(map);
    vec = L.layerGroup().addTo(map);
    labels = L.layerGroup().addTo(map);
    handleLayer = L.layerGroup().addTo(map);
    map.on('zoomend', () => TB.app.redraw());
  }

  const ll = (S, k) => [S[k].lat, S[k].lon];
  const ctx = (fn) => (e) => { L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e.originalEvent || e); fn(e); };

  function spanStyles(type, color, w, selected) {
    const base = { color, weight: w, opacity: 0.92, lineCap: 'round', lineJoin: 'round', pane: 'userLinePane' };
    const out = [];
    if (selected) out.push({ ...base, color: '#fff', weight: w + 8, opacity: 0.9 }, { ...base, color, weight: w + 8, opacity: 0.25 });
    switch (type) {
      case 'bored': case 'cutcover': out.push(base); break;
      case 'trench': out.push(base, { ...base, color: '#fff', weight: Math.max(1, w * 0.25), dashArray: '1 6', opacity: 0.9 }); break;
      case 'atgrade': out.push({ ...base, color: '#fff', weight: w + 2, opacity: 0.9 }, base, { ...base, color: '#fff', weight: Math.max(1, w * 0.3), dashArray: '6 8', opacity: 0.9 }); break;
      case 'street': out.push({ ...base, weight: w * 0.6 }); break;
      case 'rail': out.push({ ...base, color: '#555', weight: w + 3, dashArray: '2 5', opacity: 0.8 }, { ...base, weight: w * 0.8 }); break;
      case 'elevated': out.push({ ...base, color: '#2b2b2b', weight: w + 3.5, opacity: 0.85 }, base); break;
      case 'bridge': out.push({ ...base, color: '#1d1d1d', weight: w + 6, opacity: 0.85 }, { ...base, color: '#fff', weight: w + 2.5, opacity: 1 }, base); break;
      case 'oldbridge': out.push({ ...base, color: '#6b6b6b', weight: w + 5, opacity: 0.8, dashArray: '5 4' }, { ...base, color: '#fff', weight: w + 2, opacity: 1 }, base); break;
      default: out.push(base);
    }
    return out;
  }

  // A marker that survives redraws. While it is being dragged it is left completely alone
  // (re-creating its icon mid-drag is what used to make drags drop after a few pixels).
  function handle(key, latlng, html, cls, size, opts, events) {
    let m = handles.get(key);
    const sig = cls + '|' + html + '|' + size;
    if (m && m._tbDragging) { m._tbSeen = true; return m; }
    if (!m) {
      m = L.marker(latlng, { icon: L.divIcon({ html, className: cls, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        draggable: !!opts.draggable, pane: 'handlePane', keyboard: false, autoPan: true, zIndexOffset: opts.z || 0 });
      m._tbSig = sig;
      m.on('dragstart', () => { m._tbDragging = true; });
      m.on('dragend', () => { m._tbDragging = false; TB.render.lastDragEnd = Date.now(); });
      for (const ev in events) m.on(ev, events[ev]);
      m.addTo(handleLayer); handles.set(key, m);
    } else {
      const cur = m.getLatLng();
      if (Math.abs(cur.lat - latlng[0]) > 1e-9 || Math.abs(cur.lng - latlng[1]) > 1e-9) m.setLatLng(latlng);
      if (m._tbSig !== sig) { m.setIcon(L.divIcon({ html, className: cls, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })); m._tbSig = sig; }
      if (m.options.zIndexOffset !== (opts.z || 0)) m.setZIndexOffset(opts.z || 0);
      if (m.dragging) opts.draggable ? m.dragging.enable() : m.dragging.disable();
    }
    m._tbSeen = true;
    return m;
  }
  const dragging = () => [...handles.values()].some(m => m._tbDragging) || ghosts.some(g => g._tbDragging);

  function ghost(latlng, color, tip, events, cls = '') {
    const gm = L.marker(latlng, { icon: L.divIcon({ html: `<div style="--c:${color}"></div>`, className: 'tb-ghost ' + cls, iconSize: [12, 12], iconAnchor: [6, 6] }),
      draggable: true, pane: 'handlePane', zIndexOffset: 10 });
    if (tip) gm.bindTooltip(tip, { className: 'tb-tip', direction: 'top', offset: [0, -6] });
    gm.on('dragstart', () => { gm._tbDragging = true; });
    gm.on('dragend', () => { TB.render.lastDragEnd = Date.now(); });
    for (const ev in events) gm.on(ev, events[ev]);
    gm.addTo(handleLayer); ghosts.push(gm);
  }

  // ---------------------------------------------------------------------------------------
  function draw(project, res, st, opts = {}) {
    const z = map.getZoom(), W = lineW(z);
    const live = opts.dragging || dragging();
    vec.clearLayers(); labels.clearLayers();
    for (const m of handles.values()) m._tbSeen = false;
    if (!live) { ghosts.forEach(g => g.remove()); ghosts = []; }

    const sel = st.sel || {};
    for (const line of project.lines) {
      if (line.visible === false) continue;
      const r = res.lines.get(line.id); if (!r) continue;
      const active = st.activeLine === line.id;
      const mode = C.MODES[line.mode], w = W * mode.lineW;
      const S = r.S || [];
      // spans
      if (S.length > 1) {
        const groups = [];
        let cur = null;
        for (let k = 1; k < S.length; k++) {
          const span = S[k].span;
          if (!cur || cur.span !== span) { cur = { span, pts: [ll(S, k - 1)] }; groups.push(cur); }
          cur.pts.push(ll(S, k));
        }
        for (const gr of groups) {
          const node = line.nodes[gr.span];
          const isSel = sel.type === 'span' && sel.lineId === line.id && sel.span === gr.span;
          for (const style of spanStyles(node.out.type, line.color, w, isSel)) vec.addLayer(L.polyline(gr.pts, { ...style, interactive: false }));
          const hit = L.polyline(gr.pts, { color: '#000', opacity: 0, weight: Math.max(14, w + 10), pane: 'userLinePane', className: 'tb-hit' });
          hit.on('click', (e) => { L.DomEvent.stopPropagation(e); H.spanClick(line, gr.span, e); });
          hit.on('contextmenu', ctx((e) => H.spanContext(line, gr.span, e)));
          vec.addLayer(hit);
        }
      }

      const stations = r.stations || [];
      for (const s of stations) {
        const isSel = sel.type === 'station' && sel.nodeId === s.node.id;
        if (z >= 14.5 || isSel) drawBox(s, line, isSel, z);
        drawExits(s, line, isSel || (st.mode === 'exit' && isSel), z, st);
        drawConnections(s, line, isSel, live);
        if (isSel && !live || isSel && handles.get('rot:' + s.node.id)) drawRotHandle(s, line);
        if (z >= 13 || isSel) {
          const lbl = L.divIcon({ html: `<span>${esc(s.node.name)}</span>`, className: 'tb-stlabel' + (active ? '' : ' dim'), iconSize: [0, 0], iconAnchor: [-10, 8] });
          labels.addLayer(L.marker([s.lat, s.lon], { icon: lbl, pane: 'userLabelPane', interactive: false }));
        }
      }
      if (z >= 12 && stations.length > 1) {
        for (let a = 0; a < stations.length - 1; a++) {
          const k0 = r.nodeIdx[stations[a].index], k1 = r.nodeIdx[stations[a + 1].index];
          const dist = S[k1].s - S[k0].s, target = S[k0].s + dist / 2;
          let km = k0; while (km < k1 && S[km].s < target) km++;
          const lbl = L.divIcon({ html: `<span style="--c:${line.color}">${G.fmtLen(dist)}</span>`, className: 'tb-dist' + (active ? '' : ' dim'), iconSize: [0, 0], iconAnchor: [0, 0] });
          labels.addLayer(L.marker(ll(S, km), { icon: lbl, pane: 'userLabelPane', interactive: false }));
        }
      }

      // station + bend point handles
      line.nodes.forEach((nd) => {
        if (nd.kind === 'station') {
          const s = stations.find(x => x.node.id === nd.id);
          const isSel = sel.type === 'station' && sel.nodeId === nd.id;
          const size = z >= 15 ? 16 : z >= 13 ? 13 : 10;
          const ic = s && s.interchange && s.interchange.length;
          const cls = 'tb-st' + (isSel ? ' sel' : '') + (ic ? ' ic' : '') + (active ? '' : ' dim');
          handle(nd.id, [nd.lat, nd.lon], `<div style="--c:${line.color};width:${size}px;height:${size}px"></div>`, cls, size,
            { draggable: st.mode !== 'draw' || active, z: isSel ? 1000 : 100 }, nodeEvents(nd.id));
        } else if (active || z >= 15) {
          const isSel = sel.type === 'waypoint' && sel.nodeId === nd.id, size = z >= 15 ? 12 : 10;
          handle(nd.id, [nd.lat, nd.lon], `<div style="--c:${line.color};width:${size}px;height:${size}px"></div>`,
            'tb-wp' + (isSel ? ' sel' : '') + (nd.corner ? ' corner' : '') + (active ? '' : ' dim'), size, { draggable: true, z: isSel ? 900 : 50 }, nodeEvents(nd.id));
        }
      });

      // ghost midpoints to insert bend points
      if (active && st.mode === 'select' && !live && S.length > 1) {
        for (let i = 0; i < line.nodes.length - 1; i++) {
          const k0 = r.nodeIdx[i], k1 = r.nodeIdx[i + 1];
          if (S[k1].s - S[k0].s < 60) continue;
          const target = S[k0].s + (S[k1].s - S[k0].s) * 0.3; let km = k0; while (km < k1 && S[km].s < target) km++;
          ghost(ll(S, km), line.color, 'Drag to bend · click to add a station here', {
            dragstart: (e) => H.ghostDragStart(line, i, e.target.getLatLng()),
            drag: (e) => H.ghostDrag(e.target.getLatLng()),
            dragend: (e) => H.ghostDragEnd(e.target.getLatLng()),
            click: (e) => { L.DomEvent.stopPropagation(e); H.ghostClick(line, i, e.target.getLatLng()); },
          });
        }
      }

      // warnings (active line)
      if (active && !live) {
        const seen = new Set();
        for (const wv of r.warnings) {
          if (wv.lat == null || wv.sev === 'info') continue;
          const k = wv.lat.toFixed(4) + wv.lon.toFixed(4) + wv.sev; if (seen.has(k)) continue; seen.add(k);
          const m = L.marker([wv.lat, wv.lon], { icon: L.divIcon({ html: '!', className: 'tb-warn ' + wv.sev, iconSize: [16, 16], iconAnchor: [-6, 22] }), pane: 'userLabelPane' });
          m.bindTooltip(esc(wv.msg), { className: 'tb-tip wide', direction: 'top' });
          labels.addLayer(m);
        }
      }
    }

    // interchanges between user lines
    for (const ic of res.interchanges) {
      const a = [ic.a.lat, ic.a.lon], b = [ic.b.lat, ic.b.lon];
      vec.addLayer(L.polyline([a, b], { pane: 'userBoxPane', color: '#111', weight: 9, opacity: 0.9, lineCap: 'round', interactive: false }));
      vec.addLayer(L.polyline([a, b], { pane: 'userBoxPane', color: '#fff', weight: 4.5, opacity: 1, lineCap: 'round', interactive: false }));
    }

    for (const [k, m] of handles) if (!m._tbSeen) { m.remove(); handles.delete(k); }
    if (!live) drawParcels(project, res, st);
  }

  function drawBox(s, line, isSel, z) {
    vec.addLayer(L.polygon(s.rectLL, { pane: 'userBoxPane', color: line.color, weight: isSel ? 2.2 : 1.4, opacity: 0.95,
      fillColor: line.color, fillOpacity: isSel ? 0.22 : 0.14, dashArray: s.level === 'under' ? '5 4' : null, interactive: false }));
    if (z < 16 && !isSel) return;
    // platforms (light) and tracks (dark) inside the box
    const nr = [-s.dir[1], s.dir[0]], bay = 4.4, half = s.W / 2;
    const off = (o) => G.add(s.c, G.mul(nr, o));
    const rect = (o, w) => G.rect(off(o), s.dir, s.L - 2, Math.max(0.6, w)).map(p => G.toLL(p[0], p[1]));
    const track = (o) => [G.add(off(o), G.mul(s.dir, -s.L / 2)), G.add(off(o), G.mul(s.dir, s.L / 2))].map(p => G.toLL(p[0], p[1]));
    const plat = { pane: 'userBoxPane', color: '#fff', weight: 0.5, fillColor: '#fff', fillOpacity: 0.85, interactive: false };
    const trk = { pane: 'userBoxPane', color: '#333', weight: 1.4, opacity: 0.8, dashArray: '1 2', interactive: false };
    if (s.layout === 'island') {
      const tOff = half - bay / 2 - 0.4, pw = 2 * tOff - bay;
      vec.addLayer(L.polygon(rect(0, pw), plat));
      vec.addLayer(L.polyline(track(tOff), trk)); vec.addLayer(L.polyline(track(-tOff), trk));
    } else {
      const tOff = bay / 2, pw = half - bay - 0.4;
      vec.addLayer(L.polygon(rect(bay + pw / 2, pw), plat)); vec.addLayer(L.polygon(rect(-(bay + pw / 2), pw), plat));
      vec.addLayer(L.polyline(track(tOff), trk)); vec.addLayer(L.polyline(track(-tOff), trk));
    }
  }

  function drawExits(s, line, isSel, z, st) {
    const showHandles = isSel || st.mode === 'exit' && st.sel && st.sel.nodeId === s.node.id;
    for (const e of s.exitEdges) {
      const style = s.level === 'under' ? [{ color: '#1b5e20', weight: 5, opacity: 0.55 }, { color: '#a5d6a7', weight: 2, opacity: 0.9 }]
        : [{ color: '#1b5e20', weight: 2, dashArray: '3 4', opacity: 0.9 }];
      for (const sty of style) vec.addLayer(L.polyline([e.from, e.to], { pane: 'userBoxPane', lineCap: 'round', interactive: false, ...sty }));
    }
    if (z < 15 && !showHandles) return;
    for (const j of s.junctions) {
      handle('junc:' + j.j.id, [j.j.lat, j.j.lon], '<div></div>', 'tb-junc' + (st.sel && st.sel.exitId === j.j.id ? ' sel' : ''), 12,
        { draggable: true, z: 450 }, exitEvents(s.node.id, j.j.id, 'junction'));
    }
    s.exits.forEach((e, n) => {
      handle('exit:' + e.ex.id, [e.ex.lat, e.ex.lon], `<div title="Exit ${n + 1}">${n + 1}</div>`,
        'tb-exit' + (st.sel && st.sel.exitId === e.ex.id ? ' sel' : '') + (e.ok ? '' : ' bad'), 18, { draggable: true, z: 500 }, exitEvents(s.node.id, e.ex.id, 'exit'));
    });
  }

  // handlers get ids (not objects) so markers reused across undo/redo never act on stale data
  function exitEvents(nodeId, itemId, kind) {
    return {
      dragstart: (ev) => H.exitDragStart(nodeId, itemId, kind, ev),
      drag: (ev) => H.exitDrag(nodeId, itemId, kind, ev.target.getLatLng(), ev.target),
      dragend: (ev) => H.exitDragEnd(nodeId, itemId, kind, ev.target.getLatLng(), ev.target),
      click: (ev) => { L.DomEvent.stopPropagation(ev); H.exitClick(nodeId, itemId, kind); },
      contextmenu: ctx((ev) => H.exitContext(nodeId, itemId, kind, ev)),
    };
  }

  function drawConnections(s, line, isSel, live) {
    for (const cn of s.conns) {
      const pts = cn.ptsLL;
      const sty = cn.type === 'surface'
        ? [{ color: '#fff', weight: 6, opacity: 0.9 }, { color: '#555', weight: 3, dashArray: '2 5', opacity: 0.95 }]
        : [{ color: '#111', weight: 6, opacity: 0.8 }, { color: '#fff', weight: 2.5, opacity: 0.95 }];
      for (const o of sty) vec.addLayer(L.polyline(pts, { pane: 'userLinePane', lineCap: 'round', lineJoin: 'round', interactive: false, ...o }));
      const hit = L.polyline(pts, { pane: 'userLinePane', color: '#000', opacity: 0, weight: 14 });
      hit.bindTooltip(`Transfer to <b>${esc(cn.ex.name)}</b> (${esc(cn.ex.lineName)}) · ${cn.type === 'surface' ? 'outdoor path' : 'tunnel'} · ${G.fmtLen(cn.passage)} · ${C.fmt(cn.cost)}<br><span class="muted">Right-click for options${isSel ? ' · drag the dots to reshape' : ''}</span>`, { className: 'tb-tip wide', sticky: true });
      hit.on('contextmenu', ctx((e) => H.linkContext(s.node.id, cn.ex.key, e)));
      hit.on('click', (e) => { L.DomEvent.stopPropagation(e); H.nodeClick(s.node.id, e); });
      vec.addLayer(hit);
      vec.addLayer(L.circleMarker([cn.ex.lat, cn.ex.lon], { pane: 'userBoxPane', radius: 6, color: '#111', weight: 2.5, fillColor: '#fff', fillOpacity: 1, interactive: false }));
      if (!isSel) continue;
      const via = (s.node.links && s.node.links[cn.ex.key] && s.node.links[cn.ex.key].via) || [];
      const nid = s.node.id, key = cn.ex.key;
      via.forEach((q, k) => handle(`lv:${nid}:${key}:${k}`, q, '<div></div>', 'tb-lv', 12, { draggable: true, z: 420 }, {
        dragstart: () => H.linkDragStart(),
        drag: (e) => H.linkDrag(nid, key, k, e.target.getLatLng()),
        dragend: () => H.linkDragEnd(),
        contextmenu: ctx((e) => H.linkVertexContext(nid, key, k, e)),
      }));
      if (!live) for (let k = 0; k < pts.length - 1; k++) {
        const mid = [(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2];
        ghost(mid, '#111', 'Drag to reshape the transfer passage', {
          dragstart: (e) => H.linkGhostStart(nid, key, k, e.target.getLatLng()),
          drag: (e) => H.linkDrag(nid, key, k, e.target.getLatLng()),
          dragend: () => H.linkDragEnd(),
        }, 'link');
      }
    }
  }

  function drawRotHandle(s, line) {
    const p = G.add(s.c, G.mul(s.dir, s.L / 2 + 18)), q = G.toLL(p[0], p[1]);
    const a = G.toLL(...G.add(s.c, G.mul(s.dir, s.L / 2)));
    vec.addLayer(L.polyline([a, q], { pane: 'userBoxPane', color: line.color, weight: 1.5, dashArray: '2 3', interactive: false }));
    const nid = s.node.id;
    handle('rot:' + nid, q, '<div title="Drag to rotate the station">⟳</div>', 'tb-rot', 18, { draggable: true, z: 1100 }, {
      dragstart: () => H.rotStart(nid),
      drag: (e) => H.rotDrag(nid, e.target.getLatLng()),
      dragend: () => H.rotEnd(nid),
    });
  }

  function nodeEvents(id) {
    return {
      dragstart: () => H.nodeDragStart(id),
      drag: (e) => H.nodeDrag(id, e.target.getLatLng()),
      dragend: (e) => H.nodeDragEnd(id, e.target.getLatLng()),
      click: (e) => { L.DomEvent.stopPropagation(e); H.nodeClick(id, e); },
      contextmenu: ctx((e) => H.nodeContext(id, e)),
    };
  }

  // ---------------------------------------------------------------------------------------
  const PARCEL_STYLE = {
    building: { color: '#616161', fill: '#9e9e9e' },
    parkingPublic: { color: '#1b7f3b', fill: '#34c759' },
    parking: { color: '#b28704', fill: '#ffca28' },
    park: { color: '#2e7d32', fill: '#81c784' },
    vacant: { color: '#689f38', fill: '#c5e1a5' },
    school: { color: '#7b1fa2', fill: '#ce93d8' },
    raillands: { color: '#5d4037', fill: '#a1887f' },
  };
  function parcelKind(f) { return f.cat === 'parking' || (f.cat === 'building' && f.sub === 'garage' && f.public) ? (f.public ? 'parkingPublic' : 'parking') : f.cat; }

  function drawParcels(project, res, st) {
    parcelLayer.clearLayers();
    const interactive = st.mode === 'acquire';
    for (const p of Object.values(project.parcels)) {
      const owner = TB.model.findNode(p.nodeId);
      const color = owner ? owner.line.color : '#333';
      const poly = L.polygon(p.ringsLL, { pane: 'parcelPane', color: '#111', weight: 1.5, fillColor: color, fillOpacity: 0.45, fillRule: 'evenodd' });
      poly.bindTooltip(() => parcelTip(p, true), { className: 'tb-tip wide', sticky: true });
      poly.on('click', (e) => { if (!interactive) return; L.DomEvent.stopPropagation(e); H.parcelClick(p.key, e); });
      poly.on('contextmenu', ctx((e) => H.parcelContext(p.key, e)));
      parcelLayer.addLayer(poly);
    }
    // candidates
    const showCandidates = st.mode === 'acquire' || st.mode === 'exit' || (st.sel && st.sel.type === 'station');
    if (!showCandidates || map.getZoom() < 15) return;
    let centre, radius;
    if (st.mode === 'acquire') { const c = map.getCenter(), b = map.getBounds(); centre = G.toXY(c.lat, c.lng); radius = Math.min(700, G.dist([b.getNorth(), c.lng], [c.lat, c.lng]) * 1.2); }
    else { const f = st.sel && TB.model.findNode(st.sel.nodeId); if (!f) return; centre = G.toXY(f.node.lat, f.node.lon); radius = 260; }
    const bb = [centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius];
    let count = 0;
    const list = [...TB.osm.near(bb)].filter(f => f.kind === 'area' && PARCEL_STYLE[parcelKind(f)] && !project.parcels[f.key] && f.area > 25)
      .sort((a, b) => b.area - a.area);
    for (const f of list) {
      if (count++ > 1500) break;
      const sty = PARCEL_STYLE[parcelKind(f)];
      // in exit mode, land you'd still have to buy is hatched red: exits can't go there
      const blocked = st.mode === 'exit' && !TB.analysis.exitSurface(f.rings[0][0] && centroidXY(f.rings[0]), Object.values(project.parcels)).ok;
      const poly = L.polygon(f.ringsLL, { pane: 'parcelPane', color: blocked ? '#c62828' : sty.color, weight: blocked ? 0.6 : 0.8, opacity: 0.8,
        fillColor: blocked ? '#ef9a9a' : sty.fill, fillOpacity: blocked ? 0.25 : f.cat === 'building' ? 0.22 : 0.3, fillRule: 'evenodd', className: 'tb-parcel', interactive });
      if (interactive) {
        poly.bindTooltip(() => parcelTip(f, false), { className: 'tb-tip wide', sticky: true });
        poly.on('click', (e) => { L.DomEvent.stopPropagation(e); H.parcelClick(f.key, e); });
      }
      parcelLayer.addLayer(poly);
    }
  }
  const centroidXY = (r) => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];

  function parcelTip(f, acquired) {
    const [lat, lon] = f.lat != null ? [f.lat, f.lon] : centroidLL(f.ringsLL[0]);
    const c = C.parcelCost(f, lat, lon);
    return `<b>${esc(c.label)}</b>${f.name ? ' · ' + esc(f.name) : ''}<br>${Math.round(f.area).toLocaleString()} m² · ` +
      (c.feasible ? `<b>${c.total < 1e5 ? 'Free*' : C.fmt(c.total)}</b>` : '<b>not acquirable</b>') +
      (c.notes.length ? `<br><i>${c.notes.map(esc).join('<br>')}</i>` : '') +
      `<br><span class="muted">${acquired ? 'Acquired · right-click to release' : 'Click to acquire for the selected station'}</span>`;
  }
  function centroidLL(r) { let a = 0, b = 0; for (const p of r) { a += p[0]; b += p[1]; } return [a / r.length, b / r.length]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  TB.render = { lastDragEnd: 0, init, draw, drawParcels, centroidLL, esc, parcelKind, PARCEL_STYLE, handles, isDragging: dragging };
})();
