// "Site survey" of what is on the ground: buildings (with heights), parks, land use, roads,
// rail and water from OpenFreeMap's OpenStreetMap vector tiles (z14, fast CDN), plus every
// parking lot in the City of Toronto (City open data, pre-tiled in data/parking/).
// Exposes TB.osm (point/area queries over the surveyed features).
(function () {
  const G = TB.geo;
  const Z = 14, N = 2 ** Z, PTILE = 0.02;
  const TILEJSON = 'https://tiles.openfreemap.org/planet';
  const tiles = new Map();        // z14 "x/y" -> 'loading' | 'done' | 'error'
  const ptiles = new Map();       // parking key -> 'loading' | 'done'
  const ptileWaiters = new Map();
  const parkingIndex = new Set(window.PARKING_TILES || []);
  const feats = new Map(), grid = new G.Grid(150), listeners = [];
  let tileUrl = null, active = 0;
  const queue = [];

  const ROAD_W = { motorway: 32, trunk: 28, primary: 26, secondary: 22, tertiary: 20, minor: 15, service: 7, busway: 12, raceway: 10 };
  const PARK_SUB = /^(park|recreation_ground|village_green|garden|playground|dog_park|common)$/;

  const lon2x = (lon) => (lon + 180) / 360 * N;
  const lat2y = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N; };
  const x2lon = (x) => x / N * 360 - 180;
  const y2lat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) * 180 / Math.PI;
  const zkey = (lat, lon) => Math.floor(lon2x(lon)) + '/' + Math.floor(lat2y(lat));
  const pkey = (lat, lon) => Math.floor(lat / PTILE) + '_' + Math.floor(lon / PTILE);

  function emit() { TB.osm.version++; for (const f of listeners) f(); }

  // ---- polygon helpers -----------------------------------------------------------------------
  function clipRing(ring, E) { // Sutherland–Hodgman against [0,E]²
    let pts = ring;
    const edges = [[0, 0, 1], [0, E, -1], [1, 0, 1], [1, E, -1]]; // axis, value, sign (inside when sign*(p-v)>=0)
    for (const [ax, v, sg] of edges) {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ina = sg * (a[ax] - v) >= 0, inb = sg * (b[ax] - v) >= 0;
        if (ina) out.push(a);
        if (ina !== inb) { const t = (v - a[ax]) / (b[ax] - a[ax]); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
      }
      pts = out; if (pts.length < 3) return null;
    }
    return pts;
  }
  const signedArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; };
  const parseKey = (k) => k.split('/').map(Number);

  function addArea(key, cat, extra, ringsLL) {
    const rings = ringsLL.map(r => r.map(p => G.toXY(p[0], p[1])));
    const area = Math.abs(rings.reduce((a, r) => a + signedArea(r), 0));
    let f = feats.get(key);
    if (f) { // building split across tiles: merge pieces
      f.ringsLL.push(...ringsLL); f.rings.push(...rings); f.area += area; f.bb = G.bbox(f.rings.flat()); grid.insert(f.bb, f);
      return f;
    }
    f = Object.assign({ key, kind: 'area', cat, rings, ringsLL, area, bb: G.bbox(rings.flat()), name: '', levels: null, public: false, heritage: false }, extra);
    feats.set(key, f); grid.insert(f.bb, f);
    return f;
  }
  function addLine(key, kind, extra, ll) {
    if (feats.has(key) || ll.length < 2) return;
    const pts = ll.map(p => G.toXY(p[0], p[1]));
    const f = Object.assign({ key, kind, pts, name: '' }, extra);
    const pad = (f.width || 10) / 2, b = G.bbox(pts); f.bb = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    feats.set(key, f); grid.insert(f.bb, f);
  }

  // ---- vector tiles ---------------------------------------------------------------------------
  function ingest(tk, layers) {
    const [tx, ty] = parseKey(tk);
    const conv = (E) => (p) => [y2lat(ty + p[1] / E), x2lon(tx + p[0] / E)];
    // vector-tile features are often many polygons merged together: split them into
    // individual polygons (exterior ring + its holes), clipped to the tile
    const polysSplit = (f, E) => {
      const c = conv(E), out = [];
      let extSign = 0, cur = null;
      for (const r of f.geom) {
        const sa = signedArea(r);
        if (!sa) continue;
        if (!extSign) extSign = Math.sign(sa);
        const rr = clipRing(r.slice(0, -1), E);
        if (Math.sign(sa) === extSign) { cur = rr && rr.length >= 3 ? [rr.map(c)] : null; if (cur) out.push(cur); }
        else if (cur && rr && rr.length >= 3) cur.push(rr.map(c));
      }
      return out;
    };
    const L = (n) => layers[n] ? layers[n].features : [];
    const E = (n) => layers[n] ? layers[n].extent : 4096;
    const ctx = []; // land-use context for building typing
    const each = (layer, f, i, fn) => polysSplit(f, E(layer)).forEach((ringsLL, k) => fn(ringsLL, `${tk}:${i}:${k}`));
    L('landuse').forEach((f, i) => {
      if (f.type !== 3) return;
      const cl = f.props.class;
      let cat = null;
      if (/^(school|university|college|kindergarten|education)$/.test(cl)) cat = 'school';
      else if (cl === 'hospital') cat = 'hospital';
      else if (cl === 'cemetery') cat = 'cemetery';
      else if (cl === 'railway') cat = 'raillands';
      else if (/^(stadium|pitch|playground|track)$/.test(cl)) cat = 'park';
      each('landuse', f, i, (ringsLL, k) => {
        if (cat) addArea('lu' + k, cat, { public: cat !== 'raillands', name: f.props.name || '' }, ringsLL);
        ctx.push({ cl, rings: ringsLL.map(r => r.map(p => G.toXY(p[0], p[1]))) });
      });
    });
    L('park').forEach((f, i) => {
      if (f.type === 3) each('park', f, i, (ringsLL, k) => addArea('pk' + k, 'park', { public: true, name: f.props.name || '' }, ringsLL));
    });
    L('landcover').forEach((f, i) => {
      if (f.type !== 3) return;
      const cl = f.props.class, sub = f.props.subclass || '';
      let cat = null, pub = false;
      if (cl === 'wood' || (cl === 'grass' && PARK_SUB.test(sub))) { cat = 'park'; pub = true; }
      else if (cl === 'grass' || cl === 'farmland' || cl === 'sand') cat = 'vacant';
      else if (cl === 'wetland') cat = 'water';
      if (cat) each('landcover', f, i, (ringsLL, k) => addArea('lc' + k, cat, { public: pub, sub }, ringsLL));
    });
    L('water').forEach((f, i) => {
      if (f.type !== 3 || f.props.class === 'swimming_pool' || f.props.brunnel === 'tunnel') return;
      each('water', f, i, (ringsLL, k) => addArea('wa' + k, 'water', {}, ringsLL));
    });
    const worship = [];
    L('poi').forEach(f => { if (f.type === 1 && /place_of_worship/.test(f.props.class)) worship.push(G.toXY(...conv(E('poi'))(f.geom[0][0]))); });
    L('building').forEach((f, i) => {
      if (f.type !== 3) return;
      const h = Math.max(f.props.render_height || 0, 0);
      each('building', f, i, (ringsLL, k) => {
        const bf = addArea('b' + k, 'building', { levels: h > 0 ? Math.max(1, Math.round(h / 3.3)) : null, height: h }, ringsLL);
        bf._ctx = { ctx, worship };
      });
    });
    L('transportation').forEach((f, i) => {
      if (f.type !== 2) return;
      const cl = (f.props.class || '').replace('_construction', ''), brunnel = f.props.brunnel || '';
      const c = conv(E('transportation'));
      f.geom.forEach((ln, j) => {
        const ll = ln.map(c), key = `tr${tk}:${i}:${j}`;
        if (cl === 'rail' || cl === 'transit') addLine(key, 'rail', { cls: f.props.subclass || cl, width: 10, bridge: brunnel === 'bridge', tunnel: brunnel === 'tunnel' }, ll);
        else if (ROAD_W[cl]) addLine(key, 'road', { cls: cl, width: ROAD_W[cl], bridge: brunnel === 'bridge', tunnel: brunnel === 'tunnel' }, ll);
      });
    });
    L('transportation_name').forEach((f, i) => {
      if (f.type !== 2 || !f.props.name || f.props.class === 'path') return;
      const c = conv(E('transportation_name'));
      f.geom.forEach((ln, j) => addLine(`tn${tk}:${i}:${j}`, 'roadname', { cls: f.props.class, name: f.props.name, width: 4 }, ln.map(c)));
    });
    L('waterway').forEach((f, i) => {
      if (f.type !== 2 || !/^(river|canal)$/.test(f.props.class) || f.props.brunnel === 'tunnel') return;
      const c = conv(E('waterway'));
      f.geom.forEach((ln, j) => addLine(`ww${tk}:${i}:${j}`, 'waterline', { cls: f.props.class, name: f.props.name || '', width: 25, tunnel: false }, ln.map(c)));
    });
  }

  // classify buildings lazily (needs land-use context and Green P points)
  function typeBuilding(f) {
    if (!f._ctx) return;
    const { ctx, worship } = f._ctx; delete f._ctx;
    const r0 = f.rings[0], c = [r0.reduce((a, p) => a + p[0], 0) / r0.length, r0.reduce((a, p) => a + p[1], 0) / r0.length];
    const lu = (ctx.find(x => G.pointInRings(c, x.rings)) || {}).cl || '';
    const h = f.height || 0;
    let sub;
    if (worship.some(p => f.rings.some(r => G.pointInRing(p, r)))) sub = 'worship';
    else if (/school|university|college|kindergarten|hospital|education|library/.test(lu)) sub = 'institution';
    else if (/industrial|garages|railway|military/.test(lu)) sub = 'industrial';
    else if (/residential/.test(lu)) sub = f.area < 260 && h < 11 ? 'house' : 'apartments';
    else if (/commercial|retail/.test(lu)) sub = 'commercial';
    else sub = f.area < 220 && h < 11 ? 'house' : h >= 12 ? 'apartments' : 'commercial';
    for (const g of window.GREENP || []) {
      const p = G.toXY(g.lat, g.lon);
      if (Math.abs(p[0] - c[0]) < 200 && Math.abs(p[1] - c[1]) < 200 && f.rings.some(r => G.pointInRing(p, r))) { sub = 'garage'; f.public = true; f.greenp = g.address; break; }
    }
    f.sub = sub;
  }

  async function getTileUrl() {
    if (tileUrl) return tileUrl;
    try { const j = await (await fetch(TILEJSON)).json(); tileUrl = j.tiles[0]; } catch (e) { tileUrl = null; throw e; }
    return tileUrl;
  }

  async function loadTile(tk) {
    const [x, y] = parseKey(tk);
    try {
      const url = (await getTileUrl()).replace('{z}', Z).replace('{x}', x).replace('{y}', y);
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ingest(tk, TB.mvt.decode(new Uint8Array(await r.arrayBuffer())));
      tiles.set(tk, 'done');
    } catch (e) {
      console.warn('survey tile failed', tk, e);
      tiles.set(tk, 'error');
    }
  }
  function pump() {
    while (active < 6 && queue.length) {
      const tk = queue.shift(); active++;
      loadTile(tk).finally(() => { active--; emitSoon(); pump(); });
    }
  }
  let emitTimer = null;
  function emitSoon() { clearTimeout(emitTimer); emitTimer = setTimeout(emit, 60); }

  // ---- parking tiles (script injection, works from file://) ---------------------------------
  window.TB.parkingTile = (key, list) => {
    const [i, j] = key.split('_').map(Number);
    list.forEach(([pub, area, rings], n) => {
      const ringsLL = rings.map(flat => { const r = []; let x = 0, y = 0; for (let k = 0; k < flat.length; k += 2) { x += flat[k]; y += flat[k + 1]; r.push([y / 1e5, x / 1e5]); } return r; });
      addArea(`pl${key}:${n}`, 'parking', { sub: 'surface', public: pub > 0, greenp: pub ? (pub === 2 ? 'TTC commuter lot' : 'Green P') : null }, ringsLL);
    });
    ptiles.set(key, 'done');
    (ptileWaiters.get(key) || []).forEach(f => f()); ptileWaiters.delete(key);
    emitSoon();
  };
  function loadParking(key) {
    if (ptiles.has(key)) return;
    ptiles.set(key, 'loading');
    const s = document.createElement('script');
    s.src = `data/parking/${key}.js`;
    s.onerror = () => { ptiles.set(key, 'done'); emitSoon(); };
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------------------------
  TB.osm = {
    version: 0,
    onChange: (f) => listeners.push(f),
    pending: () => [...tiles.values()].filter(v => v === 'loading').length + [...ptiles.values()].filter(v => v === 'loading').length,
    ensure(s, w, n, e) {
      const x0 = Math.floor(lon2x(w)), x1 = Math.floor(lon2x(e)), y0 = Math.floor(lat2y(n)), y1 = Math.floor(lat2y(s));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const tk = x + '/' + y, st = tiles.get(tk);
        if (st === 'done' || st === 'loading') continue;
        tiles.set(tk, 'loading'); queue.push(tk);
      }
      for (let i = Math.floor(s / PTILE); i <= Math.floor(n / PTILE); i++)
        for (let j = Math.floor(w / PTILE); j <= Math.floor(e / PTILE); j++) { const k = i + '_' + j; if (parkingIndex.has(k)) loadParking(k); }
      pump();
      return Promise.resolve();
    },
    ensureAround(lat, lon, radius) {
      const dLat = radius / 110574, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
      return TB.osm.ensure(lat - dLat, lon - dLon, lat + dLat, lon + dLon);
    },
    covered(lat, lon) {
      if (tiles.get(zkey(lat, lon)) !== 'done') return false;
      const pk = pkey(lat, lon);
      return !parkingIndex.has(pk) || ptiles.get(pk) === 'done';
    },
    coveredXY(p) { const [lat, lon] = G.toLL(p[0], p[1]); return TB.osm.covered(lat, lon); },
    get: (key) => { const f = feats.get(key); if (f && f.cat === 'building') typeBuilding(f); return f; },
    near(bb) { const s = grid.query(bb); for (const f of s) if (f.cat === 'building') typeBuilding(f); return s; },
    areasAt(p) {
      const out = [];
      for (const f of grid.query([p[0], p[1], p[0], p[1]]))
        if (f.kind === 'area' && p[0] >= f.bb[0] && p[0] <= f.bb[2] && p[1] >= f.bb[1] && p[1] <= f.bb[3] && G.pointInRings(p, f.rings)) { if (f.cat === 'building') typeBuilding(f); out.push(f); }
      return out.sort((a, b) => a.area - b.area);
    },
    surfaceAt(p) {
      const areas = TB.osm.areasAt(p);
      const b = areas.find(f => f.cat === 'building');
      if (b) return { cat: 'building', f: b };
      const w = areas.find(f => f.cat === 'water');
      if (w) return { cat: 'water', f: w };
      const near = grid.query([p[0] - 20, p[1] - 20, p[0] + 20, p[1] + 20]);
      for (const f of near) if (f.kind === 'waterline' && G.polylineDist(p, f.pts) < f.width / 2) return { cat: 'water', f };
      const lot = areas.find(f => f.cat === 'parking') || areas[0];
      for (const f of near) if (f.kind === 'road' && !f.tunnel && f.cls !== 'service' && G.polylineDist(p, f.pts) < f.width / 2) return { cat: 'road', f };
      for (const f of near) if (f.kind === 'rail' && !f.tunnel && G.polylineDist(p, f.pts) < 7) return { cat: 'rail', f };
      if (lot) return { cat: lot.cat, f: lot };
      for (const f of near) if (f.kind === 'road' && !f.tunnel && G.polylineDist(p, f.pts) < f.width / 2) return { cat: 'road', f };
      return { cat: 'open', f: null };
    },
    nearestLinear(p, kind, filter, maxD = 30) {
      let best = null, bd = maxD;
      for (const f of grid.query([p[0] - maxD, p[1] - maxD, p[0] + maxD, p[1] + maxD])) {
        if (f.kind !== kind || (filter && !filter(f))) continue;
        const d = G.polylineDist(p, f.pts);
        if (d < bd) { bd = d; best = f; }
      }
      return best ? { f: best, d: bd } : null;
    },
  };
})();
