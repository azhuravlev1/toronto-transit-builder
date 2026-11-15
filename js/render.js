// Map rendering of the user's network.
(function () {
  const G = TB.geo, C = TB.costs;
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  let map, vec, labels, handleLayer, parcelLayer;
  const handles = new Map(), exitHandles = new Map();
  let ghosts = [];
  const H = {}; // handlers set by editor

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

  function icon(html, cls, size, anchor) {
    return L.divIcon({ html, className: cls, iconSize: size, iconAnchor: anchor || [size[0] / 2, size[1] / 2] });
  }

  function stationIcon(st, line, z, selected, active) {
    const s = z >= 15 ? 16 : z >= 13 ? 13 : 10;
    const ic = st && st.interchange && st.interchange.length;
    const cls = 'tb-st' + (selected ? ' sel' : '') + (ic ? ' ic' : '') + (st && st.level === 'under' ? ' under' : '') + (active ? '' : ' dim');
    return icon(`<div style="--c:${line.color};width:${s}px;height:${s}px"></div>`, cls, [s, s]);
  }

  function upsertHandle(key, latlng, iconObj, opts, events) {
    let m = handles.get(key);
    if (!m) {
      m = L.marker(latlng, { icon: iconObj, draggable: opts.draggable, pane: 'handlePane', keyboard: false, autoPan: true, zIndexOffset: opts.z || 0 });
      for (const ev in events) m.on(ev, events[ev]);
      m.addTo(handleLayer); handles.set(key, m);
    } else {
      if (!m._tbDragging) m.setLatLng(latlng);
      m.setIcon(iconObj);
      m.setZIndexOffset(opts.z || 0);
      if (m.dragging) opts.draggable ? m.dragging.enable() : m.dragging.disable();
    }
    m._tbSeen = true;
    return m;
  }

  // ---------------------------------------------------------------------------------------
  function draw(project, res, st, opts = {}) {
    const z = map.getZoom(), W = lineW(z);
    vec.clearLayers(); labels.clearLayers();
    for (const m of handles.values()) m._tbSeen = false;
    for (const m of exitHandles.values()) m._tbSeen = false;
    ghosts.forEach(g => g.remove()); ghosts = [];

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
          for (const style of spanStyles(node.out.type, line.color, w, isSel)) {
            const pl = L.polyline(gr.pts, { ...style, interactive: false });
            vec.addLayer(pl);
          }
          // invisible fat hit-line
          const hit = L.polyline(gr.pts, { color: '#000', opacity: 0, weight: Math.max(14, w + 10), pane: 'userLinePane', className: 'tb-hit' });
          hit.on('click', (e) => { L.DomEvent.stopPropagation(e); H.spanClick(line, gr.span, e); });
          hit.on('mousemove', (e) => H.spanHover && H.spanHover(line, gr.span, e));
          hit.on('mouseout', () => H.spanHover && H.spanHover(null));
          vec.addLayer(hit);
        }
      }

      // station boxes, labels, distance labels
      const stations = r.stations || [];
      for (const s of stations) {
        const isSel = sel.type === 'station' && sel.nodeId === s.node.id;
        if (z >= 14.5 || isSel) {
          const poly = L.polygon(s.rectLL, { pane: 'userBoxPane', color: line.color, weight: isSel ? 2.2 : 1.4, opacity: 0.95,
            fillColor: line.color, fillOpacity: isSel ? 0.32 : 0.18, dashArray: s.level === 'under' ? '5 4' : null, interactive: false });
          vec.addLayer(poly);
        }
        // exits
        for (const e of s.exits) {
          const p = G.toXY(e.ex.lat, e.ex.lon);
          const v = G.sub(p, s.c), a = clamp(-s.L / 2, s.L / 2, G.dot(v, s.dir)), nr = [-s.dir[1], s.dir[0]], b = clamp(-s.W / 2, s.W / 2, G.dot(v, nr));
          const edge = G.add(s.c, G.add(G.mul(s.dir, a), G.mul(nr, b)));
          vec.addLayer(L.polyline([G.toLL(edge[0], edge[1]), [e.ex.lat, e.ex.lon]], { pane: 'userBoxPane', color: '#1b5e20', weight: 2, dashArray: '3 4', opacity: 0.9, interactive: false }));
          const key = 'exit:' + e.ex.id;
          let m = exitHandles.get(key);
          const ic = icon(`<div title="Exit">${s.exits.indexOf(e) + 1}</div>`, 'tb-exit' + (sel.exitId === e.ex.id ? ' sel' : ''), [16, 16]);
          if (!m) {
            m = L.marker([e.ex.lat, e.ex.lon], { icon: ic, draggable: true, pane: 'handlePane', zIndexOffset: 500 });
            m.on('dragstart', () => { m._tbDragging = true; H.exitDragStart(e.ex); });
            m.on('drag', (ev) => H.exitDrag(e.ex.id, ev.target.getLatLng()));
            m.on('dragend', (ev) => { m._tbDragging = false; H.exitDragEnd(e.ex.id, ev.target.getLatLng()); });
            m.on('click', (ev) => { L.DomEvent.stopPropagation(ev); H.exitClick(s.node, e.ex); });
            m.addTo(handleLayer); exitHandles.set(key, m);
          } else { if (!m._tbDragging) m.setLatLng([e.ex.lat, e.ex.lon]); m.setIcon(ic); }
          m._tbSeen = true;
        }
        // connections to existing stations
        for (const cn of s.conns) {
          vec.addLayer(L.polyline([[s.lat, s.lon], [cn.ex.lat, cn.ex.lon]], { pane: 'userLinePane', color: '#111', weight: 3.5, opacity: 0.85, dashArray: '1 5', lineCap: 'round', interactive: false }));
          vec.addLayer(L.circleMarker([cn.ex.lat, cn.ex.lon], { pane: 'userBoxPane', radius: 6, color: '#111', weight: 2.5, fillColor: '#fff', fillOpacity: 1, interactive: false }));
        }
        if (z >= 13 || isSel) {
          const lbl = icon(`<span>${esc(s.node.name)}</span>`, 'tb-stlabel' + (active ? '' : ' dim'), [0, 0], [-10, 8]);
          labels.addLayer(L.marker([s.lat, s.lon], { icon: lbl, pane: 'userLabelPane', interactive: false }));
        }
      }
      if (z >= 12 && stations.length > 1) {
        for (let a = 0; a < stations.length - 1; a++) {
          const k0 = r.nodeIdx[stations[a].index], k1 = r.nodeIdx[stations[a + 1].index];
          const dist = S[k1].s - S[k0].s, target = S[k0].s + dist / 2;
          let km = k0; while (km < k1 && S[km].s < target) km++;
          const lbl = icon(`<span style="--c:${line.color}">${G.fmtLen(dist)}</span>`, 'tb-dist' + (active ? '' : ' dim'), [0, 0], [0, 0]);
          labels.addLayer(L.marker(ll(S, km), { icon: lbl, pane: 'userLabelPane', interactive: false }));
        }
      }

      // handles (stations always, waypoints when active)
      line.nodes.forEach((nd, i) => {
        if (nd.kind === 'station') {
          const s = stations.find(x => x.node.id === nd.id);
          const isSel = sel.type === 'station' && sel.nodeId === nd.id;
          upsertHandle(nd.id, [nd.lat, nd.lon], stationIcon(s, line, z, isSel, active), { draggable: st.mode !== 'draw' || active, z: isSel ? 1000 : 100 }, nodeEvents(nd.id));
        } else if (active || z >= 15) {
          const isSel = sel.type === 'waypoint' && sel.nodeId === nd.id;
          const s = z >= 15 ? 12 : 10;
          upsertHandle(nd.id, [nd.lat, nd.lon], icon(`<div style="--c:${line.color};width:${s}px;height:${s}px"></div>`, 'tb-wp' + (isSel ? ' sel' : '') + (nd.corner ? ' corner' : '') + (active ? '' : ' dim'), [s, s]),
            { draggable: true, z: isSel ? 900 : 50 }, nodeEvents(nd.id));
        }
      });

      // ghost midpoints to insert waypoints
      if (active && st.mode === 'select' && !opts.dragging && S.length > 1) {
        for (let i = 0; i < line.nodes.length - 1; i++) {
          const k0 = r.nodeIdx[i], k1 = r.nodeIdx[i + 1];
          if (S[k1].s - S[k0].s < 60) continue;
          const target = S[k0].s + (S[k1].s - S[k0].s) * 0.3; let km = k0; while (km < k1 && S[km].s < target) km++;
          const gm = L.marker(ll(S, km), { icon: icon(`<div style="--c:${line.color}"></div>`, 'tb-ghost', [12, 12]), draggable: true, pane: 'handlePane', zIndexOffset: 10 });
          gm.bindTooltip('Drag to bend · click to add a station here', { className: 'tb-tip', direction: 'top', offset: [0, -6] });
          gm.on('dragstart', () => { gm._tbDragging = true; H.ghostDragStart(line, i, gm.getLatLng()); });
          gm.on('drag', (ev) => H.ghostDrag(ev.target.getLatLng()));
          gm.on('dragend', (ev) => H.ghostDragEnd(ev.target.getLatLng()));
          gm.on('click', (ev) => { L.DomEvent.stopPropagation(ev); H.ghostClick(line, i, gm.getLatLng()); });
          gm.addTo(handleLayer); ghosts.push(gm);
        }
      }

      // warnings (active line)
      if (active && !opts.dragging) {
        const seen = new Set();
        for (const wv of r.warnings) {
          if (wv.lat == null || wv.sev === 'info') continue;
          const k = wv.lat.toFixed(4) + wv.lon.toFixed(4) + wv.sev; if (seen.has(k)) continue; seen.add(k);
          const m = L.marker([wv.lat, wv.lon], { icon: icon('!', 'tb-warn ' + wv.sev, [16, 16], [-6, 22]), pane: 'userLabelPane', interactive: true });
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

    // cleanup handles not seen
    for (const [k, m] of handles) if (!m._tbSeen) { m.remove(); handles.delete(k); }
    for (const [k, m] of exitHandles) if (!m._tbSeen) { m.remove(); exitHandles.delete(k); }

    if (!opts.dragging) drawParcels(project, res, st);
  }

  function nodeEvents(id) {
    return {
      dragstart: (e) => { e.target._tbDragging = true; H.nodeDragStart(id); },
      drag: (e) => H.nodeDrag(id, e.target.getLatLng()),
      dragend: (e) => { e.target._tbDragging = false; H.nodeDragEnd(id, e.target.getLatLng()); },
      click: (e) => { L.DomEvent.stopPropagation(e); H.nodeClick(id, e); },
      contextmenu: (e) => { L.DomEvent.stopPropagation(e); H.nodeContext && H.nodeContext(id, e); },
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
    // acquired parcels
    for (const p of Object.values(project.parcels)) {
      const owner = TB.model.findNode(p.nodeId);
      const color = owner ? owner.line.color : '#333';
      const poly = L.polygon(p.ringsLL, { pane: 'parcelPane', color: '#111', weight: 1.5, fillColor: color, fillOpacity: 0.45, fillRule: 'evenodd', interactive });
      poly.bindTooltip(() => parcelTip(p, true), { className: 'tb-tip wide', sticky: true });
      poly.on('click', (e) => { L.DomEvent.stopPropagation(e); H.parcelClick(p.key, e); });
      parcelLayer.addLayer(poly);
    }
    // candidates
    const showCandidates = st.mode === 'acquire' || (st.sel && st.sel.type === 'station');
    if (!showCandidates || map.getZoom() < 15) return;
    let centre, radius;
    if (st.mode === 'acquire') { const c = map.getCenter(), b = map.getBounds(); centre = G.toXY(c.lat, c.lng); radius = Math.min(700, G.dist([b.getNorth(), c.lng], [c.lat, c.lng]) * 1.2); }
    else { const f = TB.model.findNode(st.sel.nodeId); if (!f) return; centre = G.toXY(f.node.lat, f.node.lon); radius = 260; }
    const bb = [centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius];
    let count = 0;
    const list = [...TB.osm.near(bb)].filter(f => f.kind === 'area' && PARCEL_STYLE[parcelKind(f)] && !project.parcels[f.key] && f.area > 25)
      .sort((a, b) => b.area - a.area);
    for (const f of list) {
      if (count++ > 1500) break;
      const sty = PARCEL_STYLE[parcelKind(f)];
      const poly = L.polygon(f.ringsLL, { pane: 'parcelPane', color: sty.color, weight: 0.8, opacity: 0.8, fillColor: sty.fill,
        fillOpacity: f.cat === 'building' ? 0.22 : 0.3, fillRule: 'evenodd', className: 'tb-parcel', interactive });
      poly.bindTooltip(() => parcelTip(f, false), { className: 'tb-tip wide', sticky: true });
      poly.on('click', (e) => { L.DomEvent.stopPropagation(e); H.parcelClick(f.key, e); });
      parcelLayer.addLayer(poly);
    }
  }

  function parcelTip(f, acquired) {
    const [lat, lon] = f.lat != null ? [f.lat, f.lon] : centroidLL(f.ringsLL[0]);
    const c = C.parcelCost(f, lat, lon);
    return `<b>${esc(c.label)}</b>${f.name ? ' · ' + esc(f.name) : ''}<br>${Math.round(f.area).toLocaleString()} m² · ` +
      (c.feasible ? `<b>${c.total < 1e5 ? 'Free*' : C.fmt(c.total)}</b>` : '<b>not acquirable</b>') +
      (c.notes.length ? `<br><i>${c.notes.map(esc).join('<br>')}</i>` : '') +
      `<br><span class="muted">${acquired ? 'Acquired – click to release' : 'Click to acquire for the selected station'}</span>`;
  }
  function centroidLL(r) { let a = 0, b = 0; for (const p of r) { a += p[0]; b += p[1]; } return [a / r.length, b / r.length]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  TB.render = { init, draw, drawParcels, centroidLL, esc, parcelKind, PARCEL_STYLE, handles };
})();
