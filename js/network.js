// Existing TTC / GO / UP network – drawn per the "Toronto transit layer" design spec, with
// Line 6 and the at-grade parts of Line 5 drawn thinner (they are not fully grade-separated).
(function () {
  const G = TB.geo;
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  const THIN = 0.62; // width factor for Line 6 and Line 5's at-grade sections
  const canHover = window.matchMedia('(hover: hover)').matches;

  const ttcW = (z) => clamp(2, 7, (z - 9) * 0.9);
  const goW = (z) => clamp(1, 3.2, (z - 9) * 0.4);
  const ttcR = (z) => clamp(1.6, 5, (z - 10) * 0.75);
  const goR = (z) => clamp(1.2, 3.6, (z - 10) * 0.5);

  // approximate rail depth (m below ground) of existing stations, for interchange design
  const DEPTH_OVERRIDE = { 'L2:Bloor-Yonge': 16, 'L1:Bloor-Yonge': 7, 'L5:Cedarvale': 28, 'L5:Eglinton': 26, 'L1:Union': 10, 'L2:St. George': 14, 'L1:St. George': 8, 'L1:Spadina': 12, 'L2:Spadina': 14 };
  function estDepth(line, st, grade) {
    const k = line.id + ':' + st.name;
    if (DEPTH_OVERRIDE[k] != null) return DEPTH_OVERRIDE[k];
    if (line.kind === 'go' || grade !== 'tunnel') return 0;
    if (line.id === 'L1') {
      if (st.lat > 43.75 && st.lon < -79.48) return 20;           // TYSSE (Vaughan extension)
      if (st.lon > -79.392 && st.lat < 43.72) return 8;          // Yonge (shallow cut-and-cover)
      return 12;
    }
    return ({ L2: 12, L4: 20, L5: 22, L6: 12 })[line.id] || 12;
  }

  const stations = [];
  let lineLayers = [], stationLayers = [], group = null;

  function nearestGrade(line, p) {
    if (!line.grades) return line.kind === 'go' ? 'surface' : 'tunnel';
    let best = Infinity, g = 'tunnel';
    line.segments.forEach((seg, i) => {
      const d = G.polylineDist(p, seg.map(c => G.toXY(c[1], c[0])));
      if (d < best) { best = d; g = line.grades[i]; }
    });
    return g;
  }

  function build() {
    for (const line of window.TRANSIT || []) for (const st of line.stations) {
      const xy = G.toXY(st.lat, st.lon), grade = nearestGrade(line, xy);
      stations.push({ key: line.id + ':' + st.name, name: st.name, lineId: line.id, lineName: line.name, kind: line.kind,
        color: line.color, lat: st.lat, lon: st.lon, xy, grade, depth: estDepth(line, st, grade) });
    }
    // lines under construction: connectable, and counted as "served" for catchment stats
    for (const line of window.CONSTRUCTION || []) for (const st of line.stations) {
      const grade = st.grade || 'tunnel';
      stations.push({ key: line.id + ':' + st.name, name: st.name, lineId: line.id, lineName: line.name, kind: 'construction',
        opening: line.opening, color: line.color, lat: st.lat, lon: st.lon, xy: G.toXY(st.lat, st.lon), grade,
        depth: grade === 'tunnel' ? line.depth : grade === 'bridge' ? -9 : 0 });
    }
  }

  function render(map) {
    group = L.layerGroup().addTo(map);
    const lineR = L.canvas({ pane: 'transitPane', padding: 0.5 });
    const stR = L.canvas({ pane: 'transitStationPane', padding: 0.5 });
    const ordered = [...TRANSIT.filter(l => l.kind === 'go'), ...TRANSIT.filter(l => l.kind !== 'go')];
    for (const line of ordered) {
      line.segments.forEach((seg, i) => {
        let f = 1;
        if (line.id === 'L6' || (line.atGrade && line.atGrade[i])) f = THIN;
        const pl = L.polyline(seg.map(c => [c[1], c[0]]), { renderer: lineR, pane: 'transitPane', color: line.color,
          opacity: line.kind === 'go' ? 0.4 : 0.55, lineCap: 'round', lineJoin: 'round', interactive: false });
        pl._tb = { kind: line.kind, f };
        lineLayers.push(pl); group.addLayer(pl);
      });
    }
    // under construction: dashed, same width rules as the TTC (thinner where at grade for LRT)
    for (const line of window.CONSTRUCTION || []) {
      line.segments.forEach((seg, i) => {
        const g = (line.grades || [])[i] || 'tunnel';
        const pl = L.polyline(seg.map(c => [c[1], c[0]]), { renderer: lineR, pane: 'transitPane', color: line.color,
          opacity: 0.7, lineCap: 'butt', lineJoin: 'round', interactive: false });
        pl._tb = { kind: 'construction', f: line.mode === 'lrt' && g === 'surface' ? THIN : 1 };
        lineLayers.push(pl); group.addLayer(pl);
      });
    }
    const tip = (st, line) => `<b>${st.name}</b> <span class="chip" style="background:${line.color}"></span> ${line.name}` +
      (line.kind === 'construction' ? `<br><span class="muted">Under construction · opening ${line.opening}${line.approx ? ' · approximate alignment' : ''}</span>` : '');
    for (const line of [...ordered, ...(window.CONSTRUCTION || [])]) for (const st of line.stations) {
      const uc = line.kind === 'construction';
      const m = L.circleMarker([st.lat, st.lon], { renderer: stR, pane: 'transitStationPane', color: line.color, weight: line.kind === 'go' ? 1.2 : 1.6,
        opacity: uc ? 0.7 : 0.85, fillColor: '#fff', fillOpacity: 0.85, interactive: canHover, bubblingMouseEvents: true });
      m._tb = { kind: line.kind, f: line.id === 'L6' || (uc && line.mode === 'lrt' && st.grade === 'surface') ? THIN : 1 };
      if (canHover) m.bindTooltip(tip(st, line), { className: 'tb-tip', direction: 'top', offset: [0, -4], opacity: 1 });
      stationLayers.push(m); group.addLayer(m);
    }
    const restyle = () => {
      const z = map.getZoom();
      for (const l of lineLayers) {
        const w = (l._tb.kind === 'go' ? goW(z) : ttcW(z)) * l._tb.f;
        l.setStyle(l._tb.kind === 'construction' ? { weight: w, dashArray: `${(w * 1.8).toFixed(1)} ${(w * 1.4).toFixed(1)}` } : { weight: w });
      }
      for (const m of stationLayers) m.setRadius(m._tb.kind === 'go' ? goR(z) : ttcR(z) * (m._tb.f < 1 ? 0.85 : 1));
    };
    map.on('zoomend', restyle); restyle();
  }

  build();
  TB.network = {
    stations,
    byKey: (k) => stations.find(s => s.key === k),
    near(xy, r) { return stations.filter(s => G.dxy(s.xy, xy) <= r).sort((a, b) => G.dxy(a.xy, xy) - G.dxy(b.xy, xy)); },
    render,
    setVisible(map, v) { if (!group) return; v ? group.addTo(map) : group.remove(); },
    ttcW,
  };
})();
