// Map interactions: drawing lines, dragging stations / bend points, rotating stations,
// exit tunnels, transfer passages, land, and right-click menus.
(function () {
  const G = TB.geo, M = TB.model;
  const S = TB.state = { mode: 'select', activeLine: null, sel: null, showDensity: false, showNetwork: true, drawEnd: 'end', profile: true };
  let map, rubber = null, rubberTip = null, dragNode = null, dragOrig = null, linkIdx = null;

  const ll = (e) => [+e.lat.toFixed(6), +e.lng.toFixed(6)];
  const app = () => TB.app;
  const stationRes = (nodeId) => { for (const r of app().result.lines.values()) for (const s of r.stations || []) if (s.node.id === nodeId) return s; return null; };
  const exitItem = (nodeId, itemId) => {
    const f = M.findNode(nodeId); if (!f) return null;
    const item = (f.node.exits || []).find(e => e.id === itemId) || (f.node.junctions || []).find(j => j.id === itemId);
    return item ? { node: f.node, item } : null;
  };
  const menu = (e, items) => TB.ui.menu(e.originalEvent ? e.originalEvent.clientX : e.clientX, e.originalEvent ? e.originalEvent.clientY : e.clientY, items);

  function setMode(mode) {
    S.mode = mode;
    if (mode !== 'draw') clearRubber();
    if (mode === 'draw') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    document.body.dataset.mode = mode;
    if (mode === 'exit') {
      const f = S.sel && S.sel.nodeId && M.findNode(S.sel.nodeId);
      if (!f || f.node.kind !== 'station') TB.ui.toast('Click a station first – then click around it to place its exits.');
      else TB.osm.ensureAround(f.node.lat, f.node.lon, 280);
    }
    app().redraw();
  }

  function select(sel) {
    S.sel = sel;
    if (sel && sel.lineId) S.activeLine = sel.lineId;
    if (sel && sel.type === 'station') { const f = M.findNode(sel.nodeId); if (f) TB.osm.ensureAround(f.node.lat, f.node.lon, 280); }
    app().redraw();
  }

  function clearRubber() { if (rubber) { rubber.remove(); rubber = null; } if (rubberTip) { rubberTip.remove(); rubberTip = null; } }

  // Existing-network or user-line stations to snap to
  function snapTarget(latlng, line) {
    const p = G.toXY(latlng[0], latlng[1]);
    for (const l of M.project.lines) {
      if (l.id === line.id) continue;
      for (const n of l.nodes) if (n.kind === 'station' && G.dxy(G.toXY(n.lat, n.lon), p) < 45) return { user: n };
    }
    const ex = TB.network.near(p, 110)[0];
    return ex ? { existing: ex } : null;
  }

  function addNode(latlng, kind) {
    let line = M.line(S.activeLine);
    let created = null, toastMsg = null;
    M.change(p => {
      if (!line) { line = M.newLine(); p.lines.push(line); S.activeLine = line.id; }
      line = p.lines.find(l => l.id === S.activeLine);
      let pos = latlng;
      const snap = kind === 'station' ? snapTarget(latlng, line) : null;
      if (snap && snap.user) { pos = [snap.user.lat, snap.user.lon]; toastMsg = `Interchange with ${snap.user.name}`; }
      const n = M.newNode(kind, pos[0], pos[1], line);
      if (snap && snap.user) { n.name = snap.user.name; n.autoName = false; }
      if (snap && snap.existing) { n.connect = [snap.existing.key]; n.name = snap.existing.name; n.autoName = false; toastMsg = `Connected to ${snap.existing.name} (${snap.existing.lineName}) – drag the station to place it; the transfer passage follows`; }
      const nodes = line.nodes;
      if (nodes.length && S.drawEnd === 'start') { n.out = { ...nodes[0].out }; nodes.unshift(n); }
      else { if (nodes.length) n.out = { ...nodes[nodes.length - 1].out }; nodes.push(n); }
      created = n;
    });
    if (toastMsg) TB.ui.toast(toastMsg);
    if (created) S.sel = { type: created.kind, lineId: S.activeLine, nodeId: created.id };
    app().afterChange();
  }

  function insertNode(line, i, latlng, kind) {
    let id;
    M.change(p => {
      const l = p.lines.find(x => x.id === line.id);
      const n = M.newNode(kind, latlng[0], latlng[1], l);
      n.out = { ...l.nodes[i].out };
      l.nodes.splice(i + 1, 0, n); id = n.id;
    });
    return id;
  }

  function deleteNode(id) {
    const f = M.findNode(id); if (!f) return;
    const what = f.node.kind === 'station' ? `station “${f.node.name}”` : 'bend point';
    M.change(p => {
      const l = p.lines.find(x => x.id === f.line.id);
      l.nodes.splice(l.nodes.findIndex(n => n.id === id), 1);
      for (const k of Object.keys(p.parcels)) if (p.parcels[k].nodeId === id) delete p.parcels[k];
    });
    S.sel = { type: 'line', lineId: f.line.id };
    app().afterChange();
    TB.ui.toast(`Deleted ${what}`, 5000, { label: 'Undo', fn: () => M.undo() });
  }

  // ---- exits -------------------------------------------------------------------------------
  // Exits form a tree: box → (junctions) → street-level exits. A new exit joins the nearest
  // part of the existing tunnels (splitting a passage with a junction) or the box itself.
  function placeExit(node, latlng, forceBox) {
    const sf = TB.analysis.exitSurfaceLL(latlng[0], latlng[1]);
    if (sf.pending) { TB.osm.ensureAround(latlng[0], latlng[1], 80); TB.ui.toast('Surveying the land here – try again in a moment.'); return; }
    if (!sf.ok) { TB.ui.toast(`Can't put an exit here: ${sf.why}.`); TB.ui.flash(latlng, '✕'); return; }
    const st = stationRes(node.id); if (!st) return;
    const p = G.toXY(latlng[0], latlng[1]);
    const juncs = node.junctions || [], exits = node.exits || [];
    const pos = (id) => { const it = juncs.find(j => j.id === id) || exits.find(e => e.id === id); return it ? G.toXY(it.lat, it.lon) : null; };
    let best = { d: G.dxy(p, TB.analysis.nearestOnRect(p, st.c, st.dir, st.L, st.W)), parent: null };
    if (!forceBox) {
      for (const j of juncs) { const d = G.dxy(p, pos(j.id)); if (d < best.d) best = { d, parent: j.id }; }
      for (const item of [...juncs, ...exits]) {
        const a = pos(item.id), b = item.parent ? pos(item.parent) : TB.analysis.nearestOnRect(a, st.c, st.dir, st.L, st.W);
        if (!a || !b) continue;
        const L2 = G.dxy(a, b); if (L2 < 20) continue;
        const t = Math.max(0, Math.min(1, G.dot(G.sub(p, b), G.sub(a, b)) / (L2 * L2)));
        let tt = Math.min(t, 1 - 12 / L2); // keep the junction a little before the exit it splits
        if (tt * L2 < 8) continue;
        const q = G.add(b, G.mul(G.sub(a, b), tt)), d = G.dxy(p, q);
        if (d < best.d - 5) best = { d, split: item.id, q };
      }
    }
    M.change(() => {
      node.exits = node.exits || []; node.junctions = node.junctions || [];
      const ex = { id: M.uid(), lat: latlng[0], lon: latlng[1], parent: best.parent };
      if (best.split) {
        const item = node.exits.find(e => e.id === best.split) || node.junctions.find(j => j.id === best.split);
        const [jl, jn] = G.toLL(best.q[0], best.q[1]);
        const j = { id: M.uid(), lat: +jl.toFixed(6), lon: +jn.toFixed(6), parent: item.parent || null };
        node.junctions.push(j); item.parent = j.id; ex.parent = j.id;
      }
      node.exits.push(ex);
    });
    if (best.split) TB.ui.toast('Branched off the existing exit tunnel');
    app().afterChange();
  }

  function deleteExitItem(node, id) {
    M.change(() => {
      const juncs = node.junctions || [];
      const j = juncs.find(x => x.id === id);
      if (j) { // re-attach children to the junction's parent
        for (const it of [...(node.exits || []), ...juncs]) if (it.parent === id) it.parent = j.parent || null;
        node.junctions = juncs.filter(x => x.id !== id);
      } else node.exits = (node.exits || []).filter(e => e.id !== id);
      // prune junctions that no longer lead anywhere
      let changed = true;
      while (changed) {
        changed = false;
        for (const x of node.junctions || []) {
          if (![...(node.exits || []), ...node.junctions].some(it => it.parent === x.id)) { node.junctions = node.junctions.filter(y => y !== x); changed = true; }
        }
      }
    });
    if (S.sel && S.sel.exitId === id) S.sel = { type: 'station', lineId: S.sel.lineId, nodeId: node.id };
    app().afterChange();
  }

  function deleteSelection() {
    const s = S.sel; if (!s) return;
    if (s.exitId) { const f = M.findNode(s.nodeId); if (f) deleteExitItem(f.node, s.exitId); }
    else if (s.type === 'station' || s.type === 'waypoint') deleteNode(s.nodeId);
  }

  // ---- land ---------------------------------------------------------------------------------
  function acquire(key) {
    const p0 = M.project.parcels[key];
    if (p0) { release(key); return; }
    const f = TB.osm.get(key); if (!f) return;
    const [lat, lon] = TB.render.centroidLL(f.ringsLL[0]);
    const c = TB.costs.parcelCost(f, lat, lon);
    if (!c.feasible) { TB.ui.toast(`${c.label} can't be acquired.`); return; }
    let target = S.sel && (S.sel.type === 'station') ? M.findNode(S.sel.nodeId) : null;
    if (!target) {
      const p = G.toXY(lat, lon); let best = 450;
      for (const l of M.project.lines) for (const n of l.nodes) if (n.kind === 'station') {
        const d = G.dxy(G.toXY(n.lat, n.lon), p); if (d < best) { best = d; target = { line: l, node: n }; }
      }
    }
    if (!target) { TB.ui.toast('Select a station first (or click land within 450 m of one).'); return; }
    M.change(p => {
      p.parcels[key] = { key, cat: f.cat, sub: f.sub, area: Math.round(f.area), levels: f.levels, public: f.public, heritage: f.heritage, greenp: f.greenp, owner: f.owner,
        name: f.name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), nodeId: target.node.id, lineId: target.line.id,
        ringsLL: f.ringsLL.map(r => r.map(q => [+q[0].toFixed(6), +q[1].toFixed(6)])) };
    });
    TB.ui.toast(`Acquired ${c.label.toLowerCase()} for ${target.node.name}: ${c.total < 1e5 ? 'free' : TB.costs.fmt(c.total)}`);
    app().afterChange();
  }
  function release(key) { M.change(p => { delete p.parcels[key]; }); app().afterChange(); TB.ui.toast('Land released'); }

  // ---- span type helper (also used by the profile) -----------------------------------------
  function setSpanType(lineId, span, type) {
    M.change(() => { const l = M.line(lineId); l.nodes[span].out = { type }; });
  }

  const typeItems = (lineId, span) => Object.entries(TB.costs.SPANS).map(([k, t]) => ({ label: t.label, checked: M.line(lineId).nodes[span].out.type === k, fn: () => setSpanType(lineId, span, k) }));

  const handlers = {
    nodeClick(id) {
      const f = M.findNode(id); if (!f) return;
      if (S.mode === 'draw') {
        const line = M.line(S.activeLine);
        if (line && f.line.id === line.id) {
          const i = f.index, last = line.nodes.length - 1;
          if ((i === last && S.drawEnd === 'end') || (i === 0 && S.drawEnd === 'start')) { setMode('select'); select({ type: f.node.kind, lineId: line.id, nodeId: id }); return; }
          if (i === 0 || i === last) { S.drawEnd = i === 0 ? 'start' : 'end'; TB.ui.toast(`Now extending from ${f.node.name || 'this end'}`); return; }
        } else if (line && f.node.kind === 'station') { addNode([f.node.lat, f.node.lon], 'station'); return; }
      }
      select({ type: f.node.kind, lineId: f.line.id, nodeId: id });
    },
    nodeContext(id, e) {
      const f = M.findNode(id); if (!f) return;
      const n = f.node;
      if (n.kind === 'station') menu(e, [
        { title: `Station · ${n.name}` },
        { label: 'Select', fn: () => select({ type: 'station', lineId: f.line.id, nodeId: id }) },
        { label: 'Place exits…', fn: () => { select({ type: 'station', lineId: f.line.id, nodeId: id }); setMode('exit'); } },
        { label: 'Acquire land…', fn: () => { select({ type: 'station', lineId: f.line.id, nodeId: id }); setMode('acquire'); } },
        { label: 'Reset rotation', disabled: !n.rot, fn: () => { M.change(() => { n.rot = 0; }); } },
        { label: 'Make it a bend point', fn: () => { M.change(p => { n.kind = 'waypoint'; for (const k in p.parcels) if (p.parcels[k].nodeId === id) delete p.parcels[k]; }); } },
        { sep: true },
        { label: 'Delete station', danger: true, fn: () => deleteNode(id) },
      ]);
      else menu(e, [
        { title: 'Bend point' },
        { label: n.corner ? 'Make it a smooth curve' : 'Make it a sharp corner', fn: () => M.change(() => { n.corner = !n.corner; }) },
        { label: 'Make it a station', fn: () => { M.change(() => Object.assign(n, { kind: 'station', name: 'Station', autoName: true, style: 'standard', exits: [], connect: [] })); select({ type: 'station', lineId: f.line.id, nodeId: id }); } },
        { sep: true },
        { label: 'Delete bend point', danger: true, fn: () => deleteNode(id) },
      ]);
    },
    nodeDragStart(id) { M.begin(); dragNode = id; },
    nodeDrag(id, latlng) {
      const f = M.findNode(id); if (!f) return;
      f.node.lat = +latlng.lat.toFixed(6); f.node.lon = +latlng.lng.toFixed(6);
      app().redrawLive();
    },
    nodeDragEnd(id, latlng) {
      const f = M.findNode(id);
      if (f) {
        let pos = ll(latlng);
        if (f.node.kind === 'station') {
          const snap = snapTarget(pos, f.line);
          if (snap && snap.user) pos = [snap.user.lat, snap.user.lon];
        }
        f.node.lat = pos[0]; f.node.lon = pos[1];
        if (f.node.autoName === 'done') f.node.autoName = true;
      }
      dragNode = null; M.end(); app().afterChange();
      if (f && f.node.kind !== 'waypoint') select({ type: f.node.kind, lineId: f.line.id, nodeId: id });
    },
    ghostDragStart(line, i, latlng) { M.begin(); const l = M.line(line.id); const n = M.newNode('waypoint', latlng.lat, latlng.lng, l); n.out = { ...l.nodes[i].out }; l.nodes.splice(i + 1, 0, n); dragNode = n.id; },
    ghostDrag(latlng) { if (dragNode) handlers.nodeDrag(dragNode, latlng); },
    ghostDragEnd(latlng) {
      const f = M.findNode(dragNode); if (f) { f.node.lat = +latlng.lat.toFixed(6); f.node.lon = +latlng.lng.toFixed(6); }
      const id = dragNode; dragNode = null; M.end(); app().afterChange();
      const g = M.findNode(id); if (g) select({ type: 'waypoint', lineId: g.line.id, nodeId: id });
    },
    ghostClick(line, i, latlng) {
      const id = insertNode(line, i, ll(latlng), 'station');
      select({ type: 'station', lineId: line.id, nodeId: id }); app().afterChange();
    },
    spanClick(line, span, e) {
      if (S.mode === 'draw') { addNode(ll(e.latlng), e.originalEvent.shiftKey || e.originalEvent.altKey ? 'waypoint' : 'station'); return; }
      if (S.mode === 'exit' && S.sel && S.sel.type === 'station') { map.fire('click', e); return; }
      select({ type: 'span', lineId: line.id, span });
    },
    spanContext(line, span, e) {
      const at = ll(e.latlng);
      menu(e, [
        { title: 'Track · ' + TB.costs.SPANS[line.nodes[span].out.type].label },
        { label: 'Add a station here', fn: () => { const id = insertNode(line, span, at, 'station'); select({ type: 'station', lineId: line.id, nodeId: id }); app().afterChange(); } },
        { label: 'Add a bend point here', fn: () => { const id = insertNode(line, span, at, 'waypoint'); select({ type: 'waypoint', lineId: line.id, nodeId: id }); app().afterChange(); } },
        { sep: true }, { title: 'Build as' }, ...typeItems(line.id, span),
      ]);
    },

    // exits & junctions (handlers receive ids and resolve them on every event)
    exitDragStart(nodeId, itemId) { M.begin(); const r = exitItem(nodeId, itemId); dragOrig = r && [r.item.lat, r.item.lon]; },
    exitDrag(nodeId, itemId, kind, latlng, marker) {
      const r = exitItem(nodeId, itemId); if (!r) return;
      r.item.lat = +latlng.lat.toFixed(6); r.item.lon = +latlng.lng.toFixed(6);
      if (kind === 'exit') { const ok = TB.analysis.exitSurfaceLL(r.item.lat, r.item.lon).ok; const el = marker.getElement(); if (el) el.classList.toggle('bad', !ok); }
      app().redrawLive();
    },
    exitDragEnd(nodeId, itemId, kind) {
      const r = exitItem(nodeId, itemId);
      if (r && kind === 'exit') {
        const sf = TB.analysis.exitSurfaceLL(r.item.lat, r.item.lon);
        if (!sf.ok && dragOrig) { r.item.lat = dragOrig[0]; r.item.lon = dragOrig[1]; TB.ui.toast(`Exit moved back: ${sf.why}.`); }
      }
      M.end(); app().afterChange();
    },
    exitClick(nodeId, itemId) { const f = M.findNode(nodeId); if (f) select({ type: 'station', lineId: f.line.id, nodeId, exitId: itemId }); },
    exitContext(nodeId, itemId, kind, e) {
      const r = exitItem(nodeId, itemId); if (!r) return;
      const { node, item } = r, n = (node.exits || []).indexOf(item) + 1;
      menu(e, [
        { title: kind === 'exit' ? `Exit ${n} · ${node.name}` : `Tunnel junction · ${node.name}` },
        ...(kind === 'exit' ? [{ label: 'Own tunnel straight to the station', disabled: !item.parent, fn: () => { M.change(() => { item.parent = null; }); } }] : []),
        { sep: true },
        { label: kind === 'exit' ? 'Delete exit' : 'Remove junction', danger: true, fn: () => deleteExitItem(node, item.id) },
      ]);
    },

    // rotation
    rotStart() { M.begin(); },
    rotDrag(nodeId, latlng) {
      const f = M.findNode(nodeId), st = stationRes(nodeId); if (!f || !st) return;
      const v = G.sub(G.toXY(latlng.lat, latlng.lng), st.c), b = st.baseDir;
      let ang = Math.atan2(b[0] * v[1] - b[1] * v[0], G.dot(b, v)) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      const lim = TB.costs.ROT_MAX;
      f.node.rot = Math.round(Math.max(-lim, Math.min(lim, ang)) * 2) / 2;
      app().redrawLive();
    },
    rotEnd(nodeId) {
      const f = M.findNode(nodeId);
      if (f && Math.abs(f.node.rot || 0) >= TB.costs.ROT_MAX) TB.ui.toast(`Stations can rotate at most ±${TB.costs.ROT_MAX}° off the track direction.`);
      M.end(); app().afterChange();
    },

    // transfer passages to existing stations
    linkDragStart() { M.begin(); },
    linkGhostStart(nodeId, key, k, latlng) {
      M.begin();
      const f = M.findNode(nodeId); if (!f) return;
      const node = f.node;
      node.links = node.links || {}; const lk = node.links[key] = node.links[key] || { type: 'tunnel', via: [] };
      lk.via = lk.via || []; lk.via.splice(k, 0, [+latlng.lat.toFixed(6), +latlng.lng.toFixed(6)]);
      linkIdx = k;
    },
    linkDrag(nodeId, key, k, latlng) {
      const f = M.findNode(nodeId), lk = f && f.node.links && f.node.links[key]; if (!lk) return;
      lk.via[linkIdx != null ? linkIdx : k] = [+latlng.lat.toFixed(6), +latlng.lng.toFixed(6)];
      app().redrawLive();
    },
    linkDragEnd() { linkIdx = null; M.end(); app().afterChange(); },
    linkContext(nodeId, key, e) {
      const f = M.findNode(nodeId); if (!f) return;
      const node = f.node, lk = (node.links || {})[key] || {}, ex = TB.network.byKey(key);
      const setLink = (fn) => M.change(() => { node.links = node.links || {}; node.links[key] = node.links[key] || { type: 'tunnel', via: [] }; fn(node.links[key]); });
      menu(e, [
        { title: `Transfer to ${ex ? ex.name : key}` },
        { label: 'Underground passage', checked: lk.type !== 'surface', fn: () => setLink(l => { l.type = 'tunnel'; }) },
        { label: 'Outdoor walkway (cheaper)', checked: lk.type === 'surface', fn: () => setLink(l => { l.type = 'surface'; }) },
        { label: 'Straighten passage', disabled: !(lk.via && lk.via.length), fn: () => setLink(l => { l.via = []; }) },
        { sep: true },
        { label: 'Remove connection', danger: true, fn: () => M.change(() => { node.connect = (node.connect || []).filter(k => k !== key); if (node.links) delete node.links[key]; }) },
      ]);
    },
    linkVertexContext(nodeId, key, k, e) {
      const f = M.findNode(nodeId); if (!f) return;
      menu(e, [{ label: 'Delete bend in passage', danger: true, fn: () => M.change(() => { f.node.links[key].via.splice(k, 1); }) }]);
    },

    parcelClick(key) { acquire(key); },
    parcelContext(key, e) {
      const p = M.project.parcels[key]; if (!p) return;
      const owner = M.findNode(p.nodeId);
      menu(e, [{ title: `${TB.costs.parcelCost(p, p.lat, p.lon).label}${owner ? ' · for ' + owner.node.name : ''}` }, { label: 'Release this land', danger: true, fn: () => release(key) }]);
    },
  };

  function init(m) {
    map = m;
    TB.render.init(map, handlers);
    map.on('click', (e) => {
      if (Date.now() - TB.render.lastDragEnd < 400) return; // the click that ends a drag
      const p = ll(e.latlng);
      if (S.mode === 'draw') addNode(p, e.originalEvent.shiftKey || e.originalEvent.altKey ? 'waypoint' : 'station');
      else if (S.mode === 'exit') {
        const f = S.sel && S.sel.nodeId && M.findNode(S.sel.nodeId);
        if (!f || f.node.kind !== 'station') { TB.ui.toast('Click a station first.'); return; }
        placeExit(f.node, p, e.originalEvent.shiftKey);
      } else if (S.mode === 'select' || S.mode === 'acquire') { if (S.sel) select(S.activeLine ? { type: 'line', lineId: S.activeLine } : null); }
    });
    map.on('contextmenu', (e) => { if (S.mode === 'draw') setMode('select'); });
    map.getContainer().addEventListener('contextmenu', (e) => e.preventDefault());
    map.on('dblclick', () => { if (S.mode === 'draw') setMode('select'); });
    map.on('mousemove', (e) => {
      if (S.mode !== 'draw') return;
      const line = M.line(S.activeLine);
      if (!line || !line.nodes.length) { clearRubber(); return; }
      const end = S.drawEnd === 'start' ? line.nodes[0] : line.nodes[line.nodes.length - 1];
      const a = [end.lat, end.lon], b = [e.latlng.lat, e.latlng.lng];
      if (!rubber) rubber = L.polyline([a, b], { color: line.color, weight: 3, dashArray: '6 6', opacity: 0.8, interactive: false, pane: 'userLinePane' }).addTo(map);
      else rubber.setLatLngs([a, b]);
      const txt = G.fmtLen(G.dist(a, b)) + (e.originalEvent.shiftKey ? ' · bend point' : '');
      if (!rubberTip) rubberTip = L.tooltip({ permanent: true, direction: 'right', className: 'tb-tip', offset: [12, 0] }).setLatLng(b).setContent(txt).addTo(map);
      else rubberTip.setLatLng(b).setContent(txt);
    });
    map.on('mouseout', clearRubber);

    document.addEventListener('keydown', (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? M.redo() : M.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); M.redo(); return; }
      if (mod) return;
      if (k === 'escape' || k === 'enter') { TB.ui.closeMenu(); if (S.mode !== 'select') setMode('select'); else select(null); }
      else if (k === 'v') setMode('select');
      else if (k === 'd') TB.ui.startDrawing();
      else if (k === 'a') setMode('acquire');
      else if (k === 'e') setMode('exit');
      else if (k === 'p') TB.app.toggleDensity();
      else if (k === 't') TB.app.toggleNetwork();
      else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); }
      else if (k === '?') TB.ui.help();
    });
  }

  TB.editor = { init, setMode, select, deleteNode, deleteSelection, deleteExitItem, insertNode, acquire, release, setSpanType, typeItems, placeExit, handlers,
    isDragging: () => !!dragNode };
})();
