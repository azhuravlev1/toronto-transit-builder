// Map interactions: drawing lines, dragging stations / waypoints, bending, exits, land.
(function () {
  const G = TB.geo, M = TB.model;
  const S = TB.state = { mode: 'select', activeLine: null, sel: null, showDensity: false, showNetwork: true, drawEnd: 'end', profile: true };
  let map, rubber = null, rubberTip = null, dragNode = null;

  const ll = (e) => [+e.lat.toFixed(6), +e.lng.toFixed(6)];
  const app = () => TB.app;

  function setMode(mode) {
    S.mode = mode;
    if (mode !== 'draw') clearRubber();
    if (mode === 'draw') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    document.body.dataset.mode = mode;
    if (mode === 'exit' && !(S.sel && S.sel.type === 'station')) TB.ui.toast('Select a station first, then click on the map to place its exits.');
    if (mode === 'acquire') TB.ui.toast('Zoom in (≥ 16) near a station – click lots and buildings to acquire them for the selected (or nearest) station.');
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
      if (snap && snap.existing) { n.connect = [snap.existing.key]; n.name = snap.existing.name; n.autoName = false; toastMsg = `Connected to ${snap.existing.name} (${snap.existing.lineName}) – see the station panel for the cost`; }
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
    M.change(p => {
      const l = p.lines.find(x => x.id === f.line.id);
      l.nodes.splice(l.nodes.findIndex(n => n.id === id), 1);
      for (const k of Object.keys(p.parcels)) if (p.parcels[k].nodeId === id) delete p.parcels[k];
    });
    S.sel = { type: 'line', lineId: f.line.id };
    app().afterChange();
  }

  function deleteSelection() {
    const s = S.sel; if (!s) return;
    if (s.exitId) {
      M.change(p => { for (const l of p.lines) for (const n of l.nodes) if (n.exits) n.exits = n.exits.filter(e => e.id !== s.exitId); });
      S.sel = { type: 'station', lineId: s.lineId, nodeId: s.nodeId };
      app().afterChange();
    } else if (s.type === 'station' || s.type === 'waypoint') deleteNode(s.nodeId);
  }

  function acquire(key) {
    const p0 = M.project.parcels[key];
    if (p0) { M.change(p => { delete p.parcels[key]; }); app().afterChange(); TB.ui.toast('Released'); return; }
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
      p.parcels[key] = { key, cat: f.cat, sub: f.sub, area: Math.round(f.area), levels: f.levels, public: f.public, heritage: f.heritage, greenp: f.greenp,
        name: f.name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), nodeId: target.node.id, lineId: target.line.id,
        ringsLL: f.ringsLL.map(r => r.map(q => [+q[0].toFixed(6), +q[1].toFixed(6)])) };
    });
    TB.ui.toast(`Acquired ${c.label.toLowerCase()} for ${target.node.name}: ${c.total < 1e5 ? 'free' : TB.costs.fmt(c.total)}`);
    app().afterChange();
  }

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
      if (S.mode === 'exit' && f.node.kind === 'station') { select({ type: 'station', lineId: f.line.id, nodeId: id }); return; }
      select({ type: f.node.kind, lineId: f.line.id, nodeId: id });
    },
    nodeContext(id) { const f = M.findNode(id); if (f && confirm(`Delete ${f.node.kind === 'station' ? f.node.name : 'this waypoint'}?`)) deleteNode(id); },
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
    ghostDrag(latlng) { handlers.nodeDrag(dragNode, latlng); },
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
    exitDragStart() { M.begin(); },
    exitDrag(id, latlng) {
      for (const l of M.project.lines) for (const n of l.nodes) for (const e of n.exits || []) if (e.id === id) { e.lat = +latlng.lat.toFixed(6); e.lon = +latlng.lng.toFixed(6); }
      app().redrawLive();
    },
    exitDragEnd() { M.end(); app().afterChange(); },
    exitClick(node, ex) { const f = M.findNode(node.id); select({ type: 'station', lineId: f.line.id, nodeId: node.id, exitId: ex.id }); },
    parcelClick(key) { acquire(key); },
  };

  function init(m) {
    map = m;
    TB.render.init(map, handlers);
    map.on('click', (e) => {
      const p = ll(e.latlng);
      if (S.mode === 'draw') addNode(p, e.originalEvent.shiftKey || e.originalEvent.altKey ? 'waypoint' : 'station');
      else if (S.mode === 'exit') {
        const f = S.sel && S.sel.type === 'station' && M.findNode(S.sel.nodeId);
        if (!f) { TB.ui.toast('Select a station first.'); return; }
        M.change(() => { f.node.exits = f.node.exits || []; f.node.exits.push({ id: M.uid(), lat: p[0], lon: p[1] }); });
        TB.osm.ensureAround(p[0], p[1], 60);
        app().afterChange();
      } else if (S.mode === 'select' || S.mode === 'acquire') { if (S.sel) select(S.activeLine ? { type: 'line', lineId: S.activeLine } : null); }
    });
    map.on('dblclick', () => { if (S.mode === 'draw') setMode('select'); });
    map.on('mousemove', (e) => {
      if (S.mode !== 'draw') return;
      const line = M.line(S.activeLine);
      if (!line || !line.nodes.length) { clearRubber(); return; }
      const end = S.drawEnd === 'start' ? line.nodes[0] : line.nodes[line.nodes.length - 1];
      const a = [end.lat, end.lon], b = [e.latlng.lat, e.latlng.lng];
      if (!rubber) rubber = L.polyline([a, b], { color: line.color, weight: 3, dashArray: '6 6', opacity: 0.8, interactive: false, pane: 'userLinePane' }).addTo(map);
      else rubber.setLatLngs([a, b]);
      const txt = G.fmtLen(G.dist(a, b)) + (e.originalEvent.shiftKey ? ' · waypoint' : '');
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
      if (k === 'escape' || k === 'enter') { if (S.mode !== 'select') setMode('select'); else select(null); }
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

  TB.editor = { init, setMode, select, deleteNode, deleteSelection, insertNode, acquire, handlers, isDragging: () => !!dragNode };
})();
