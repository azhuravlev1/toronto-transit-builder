// App bootstrap & orchestration.
(function () {
  const G = TB.geo, M = TB.model;
  let map, densityLayer = null, raf = null, surveyTimer = null, redrawTimer = null, hoverMarker = null;
  const phone = window.innerWidth <= 640;

  function initMap() {
    map = L.map('map', {
      center: phone ? [43.660, -79.395] : [43.665, -79.40], zoom: phone ? 12 : 12.5,
      minZoom: 9, maxZoom: 18, zoomSnap: 0.5, zoomControl: false, preferCanvas: false,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
    try {
      L.maplibreGL({
        style: 'https://tiles.openfreemap.org/styles/positron',
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>',
      }).addTo(map);
    } catch (e) { // no WebGL – fall back to a faded raster basemap
      console.warn('Vector basemap unavailable, using raster fallback', e);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tb-raster-base',
        attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>' }).addTo(map);
    }
    map.attributionControl.addAttribution('Census 2021 © Statistics Canada · Terrain: AWS Terrain Tiles (Mapzen) · Parking & Green P: City of Toronto');
    const panes = { densityPane: 380, transitPane: 410, transitStationPane: 430, parcelPane: 440, userLinePane: 450, userBoxPane: 460, userLabelPane: 620, handlePane: 640 };
    for (const [n, z] of Object.entries(panes)) { const p = map.createPane(n); p.style.zIndex = z; }
    map.getPane('densityPane').style.pointerEvents = 'none';
    map.getPane('userLabelPane').style.pointerEvents = 'none';
    TB.network.render(map);
    hoverMarker = L.circleMarker([0, 0], { radius: 6, color: '#111', weight: 2, fillColor: '#fff', fillOpacity: 1, pane: 'handlePane', interactive: false });
    map.on('moveend', () => {
      if (TB.state.mode !== 'acquire' || map.getZoom() < 15) return;
      const b = map.getBounds();
      TB.osm.ensure(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
      TB.render.drawParcels(M.project, TB.app.result, TB.state);
    });
    // density hover read-out
    map.on('mousemove', (e) => {
      if (!TB.state.showDensity || TB.state.mode === 'draw') return TB.ui.densityReadout(null);
      TB.ui.densityReadout(TB.population.at(e.latlng.lat, e.latlng.lng));
    });
  }

  // ---------------------------------------------------------------------------------------
  function compute() { TB.app.result = TB.analysis.analyzeProject(M.project); return TB.app.result; }

  let committedTotal = null, pointer = { x: innerWidth / 2, y: innerHeight / 2 };
  document.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('pointerdown', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, true);

  // after a user change: show the cost delta floating up (+) or down (−) next to the pointer
  function onModelChange(info) {
    if (autoName()) M.save();
    redraw(true);
    const total = TB.app.result.total;
    if (committedTotal != null && !(info && info.replaced)) {
      const d = total - committedTotal;
      if (Math.abs(d) >= 1e5) TB.ui.costFloat(d, pointer.x, pointer.y - 14);
    }
    committedTotal = total;
    scheduleSurvey();
  }

  function redraw(fromChange) {
    clearTimeout(redrawTimer); redrawTimer = null;
    const res = compute();
    if (fromChange !== true) committedTotal = res.total;
    TB.render.draw(M.project, res, TB.state);
    TB.ui.update(res);
    TB.profile.update(res);
  }
  // cheap path while dragging
  function redrawLive() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const res = compute();
      TB.render.draw(M.project, res, TB.state, { dragging: true });
      TB.ui.update(res, { live: true });
      TB.profile.update(res);
    });
  }
  function redrawSoon() { if (!redrawTimer) redrawTimer = setTimeout(redraw, 250); }

  function afterChange() { redraw(); scheduleSurvey(); }

  // fetch terrain + OSM data the analyses need
  function scheduleSurvey() {
    clearTimeout(surveyTimer);
    surveyTimer = setTimeout(survey, 500);
  }
  function survey() {
    const res = TB.app.result; if (!res) return;
    const pts = [];
    for (const r of res.lines.values()) {
      const S = r.S || [];
      for (let k = 0; k < S.length; k += 15) pts.push([S[k].lat, S[k].lon]);
      if (S.length) pts.push([S[S.length - 1].lat, S[S.length - 1].lon]);
      for (const st of r.stations || []) {
        TB.osm.ensureAround(st.lat, st.lon, 220);
        for (const cn of st.conns) TB.osm.ensureAround(cn.ex.lat, cn.ex.lon, 110);
      }
      for (const sp of r.spans || []) {
        if (sp.type === 'bored' || !sp.pending) continue;
        for (let k = 0; k < S.length; k += 12) if (S[k].span === sp.i) TB.osm.ensureAround(S[k].lat, S[k].lon, 40);
      }
    }
    for (const ic of res.interchanges) { const m = [(ic.a.lat + ic.b.lat) / 2, (ic.a.lon + ic.b.lon) / 2]; TB.osm.ensureAround(m[0], m[1], 90); }
    TB.terrain.ensure(pts);
  }

  // name stations after the nearest cross streets once the survey has arrived
  const SUFFIX = / (Street|Avenue|Road|Drive|Boulevard|Crescent|Court|Parkway|Place|Lane|Way|Trail|Gardens|Circle|Terrace|Square)( (East|West|North|South))?$/;
  function autoName() {
    let changed = false;
    const used = new Set();
    for (const l of M.project.lines) for (const n of l.nodes) if (n.kind === 'station' && n.autoName !== true) used.add(n.name);
    for (const l of M.project.lines) for (const n of l.nodes) {
      if (n.kind !== 'station' || n.autoName !== true || !TB.osm.covered(n.lat, n.lon)) continue;
      const p = G.toXY(n.lat, n.lon), roads = [];
      for (const f of TB.osm.near([p[0] - 150, p[1] - 150, p[0] + 150, p[1] + 150])) {
        if (f.kind !== 'roadname' || /service|path|track/.test(f.cls)) continue;
        const d = G.polylineDist(p, f.pts); if (d > 150) continue;
        const rank = { motorway: 0, trunk: 1, primary: 1, secondary: 2, tertiary: 3 }[f.cls] ?? 4;
        roads.push({ name: f.name.replace(SUFFIX, ''), score: d + rank * 35 });
      }
      roads.sort((a, b) => a.score - b.score);
      const names = [...new Set(roads.map(r => r.name))].slice(0, 2);
      if (!names.length) continue;
      let name = names.length > 1 && roads.find(r => r.name === names[1]).score < 140 ? names.join(' & ') : names[0];
      if (used.has(name) && names.length > 1) name = names.join(' & ');
      if (used.has(name)) name += ' ' + l.name.replace(/^Line /, 'L');
      used.add(name);
      if (n.name !== name) { n.name = name; changed = true; }
      n.autoName = 'done';
    }
    if (changed) { M.save(); }
    return changed;
  }

  function toggleDensity(force) {
    const on = force ?? !TB.state.showDensity;
    TB.state.showDensity = on;
    document.body.classList.toggle('density-on', on);
    if (on) {
      TB.ui.toast('Loading 2021 Census population density…', 1500);
      TB.population.load().then(() => {
        if (!TB.state.showDensity) return;
        if (!densityLayer) densityLayer = TB.population.layer();
        densityLayer.addTo(map); redraw();
      });
    } else if (densityLayer) densityLayer.remove();
    TB.ui.updateToolbar();
  }
  function toggleNetwork(force) {
    TB.state.showNetwork = force ?? !TB.state.showNetwork;
    TB.network.setVisible(map, TB.state.showNetwork);
    TB.ui.updateToolbar();
  }

  async function start() {
    initMap();
    const fromLink = await M.fromHash().catch(e => { console.warn(e); return false; });
    if (!fromLink) M.load();
    TB.app.map = map;
    TB.editor.init(map);
    TB.ui.init(map);
    TB.profile.init();
    M.on('change', onModelChange);
    TB.osm.onChange(() => { if (autoName()) M.save(); redrawSoon(); });
    TB.terrain.onChange(() => redrawSoon());
    if (M.project.lines.length) TB.state.activeLine = M.project.lines[0].id;
    redraw(); scheduleSurvey();
    if (fromLink) TB.ui.toast('Loaded a shared network (your previous one was backed up).');
    if (!localStorage.getItem('tb.seenHelp')) { TB.ui.help(); localStorage.setItem('tb.seenHelp', '1'); }
    // preload census data in the background for catchment stats
    setTimeout(() => TB.population.load().then(redrawSoon).catch(() => {}), 1500);
  }

  TB.app = {
    start, redraw, redrawLive, afterChange, toggleDensity, toggleNetwork, scheduleSurvey,
    hover(lat, lon) { if (lat == null) hoverMarker.remove(); else hoverMarker.setLatLng([lat, lon]).addTo(map); },
    fit(latlngs, maxZoom = 16) { if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.2), { maxZoom, paddingBottomRight: [380, 180] }); },
  };
  document.addEventListener('DOMContentLoaded', start);
})();
