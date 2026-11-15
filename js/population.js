// Population density layer (2021 Census, Dissemination Areas) + catchment analysis.
(function () {
  const G = TB.geo;
  const BREAKS = [500, 2500, 5000, 7500, 10000, 15000, 25000, 50000];
  const COLORS = ['#fffbe0', '#fde9a1', '#fdc86a', '#fd9d45', '#f26b2f', '#d9402a', '#b0182e', '#7a0b3c', '#45084f'];
  const color = (d) => { let i = 0; while (i < BREAKS.length && d >= BREAKS[i]) i++; return COLORS[i]; };

  let feats = null, cell = new Map(), loading = null;
  let pts = null, ptGrid = null, existingCovered = null;
  const CELL = 0.02;

  const merc = (lat, lon) => {
    const s = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };

  function decode() {
    const P = window.POPULATION, sc = P.scale;
    feats = P.features.map(([id, pop, dens, area, rings]) => {
      const ll = rings.map(flat => {
        const r = []; let x = 0, y = 0;
        for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; r.push([y / sc, x / sc]); }
        return r;
      });
      const m = ll.map(r => r.map(p => merc(p[0], p[1])));
      let s = 90, w = 180, n = -90, e = -180;
      for (const r of ll) for (const [la, lo] of r) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
      return { id, pop, dens, area, ll, m, bb: [s, w, n, e], col: color(dens) };
    });
    feats.forEach((f, idx) => {
      for (let i = Math.floor(f.bb[0] / CELL); i <= Math.floor(f.bb[2] / CELL); i++)
        for (let j = Math.floor(f.bb[1] / CELL); j <= Math.floor(f.bb[3] / CELL); j++) {
          const k = i + ',' + j; if (!cell.has(k)) cell.set(k, []); cell.get(k).push(idx);
        }
    });
    buildPoints();
  }

  function inBB(f, s, w, n, e) { return !(f.bb[2] < s || f.bb[0] > n || f.bb[3] < w || f.bb[1] > e); }
  function candidates(s, w, n, e) {
    const out = new Set();
    for (let i = Math.floor(s / CELL); i <= Math.floor(n / CELL); i++)
      for (let j = Math.floor(w / CELL); j <= Math.floor(e / CELL); j++) for (const idx of cell.get(i + ',' + j) || []) out.add(idx);
    return [...out].map(i => feats[i]).filter(f => inBB(f, s, w, n, e));
  }

  // population "points": each DA's population spread over a regular grid of points inside it
  function buildPoints() {
    pts = []; ptGrid = new G.Grid(400);
    for (const f of feats) {
      if (!f.pop) continue;
      const rings = f.ll.map(r => r.map(p => G.toXY(p[0], p[1])));
      const bb = G.bbox(rings.flat());
      const n = Math.max(1, Math.min(40, Math.round(f.area / 0.015)));
      const step = Math.sqrt(((bb[2] - bb[0]) * (bb[3] - bb[1])) / n) || 1;
      let inside = [];
      for (let x = bb[0] + step / 2; x < bb[2]; x += step) for (let y = bb[1] + step / 2; y < bb[3]; y += step)
        if (G.pointInRings([x, y], rings)) inside.push([x, y]);
      if (!inside.length) { const r = rings[0]; inside = [[r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length]]; }
      const w = f.pop / inside.length;
      for (const p of inside) { const o = { x: p[0], y: p[1], w, i: pts.length }; pts.push(o); ptGrid.insert([p[0], p[1], p[0], p[1]], o); }
    }
    existingCovered = new Uint8Array(pts.length);
    for (const line of [...(window.TRANSIT || []), ...(window.CONSTRUCTION || [])]) for (const s of line.stations) {
      const c = G.toXY(s.lat, s.lon);
      for (const o of ptGrid.query([c[0] - 800, c[1] - 800, c[0] + 800, c[1] + 800]))
        if (Math.hypot(o.x - c[0], o.y - c[1]) <= 800) existingCovered[o.i] = 1;
    }
  }

  const Layer = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas'), size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      const z2 = 2 ** coords.z * size.x, ox = coords.x * size.x, oy = coords.y * size.y;
      const nw = this._map.unproject([ox, oy], coords.z), se = this._map.unproject([ox + size.x, oy + size.y], coords.z);
      const ctx = tile.getContext('2d');
      const list = candidates(se.lat, nw.lng, nw.lat, se.lng);
      for (const f of list) {
        if (!f.pop) continue;
        ctx.beginPath();
        for (const r of f.m) {
          for (let i = 0; i < r.length; i++) {
            const x = r[i][0] * z2 - ox, y = r[i][1] * z2 - oy;
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          }
          ctx.closePath();
        }
        ctx.fillStyle = f.col;
        ctx.fill('evenodd');
        if (coords.z >= 13) { ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.6; ctx.stroke(); }
      }
      return tile;
    },
  });

  TB.population = {
    BREAKS, COLORS, color,
    loaded: () => !!feats,
    load() {
      if (feats) return Promise.resolve();
      if (loading) return loading;
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'data/population.js';
        s.onload = () => { decode(); resolve(); };
        s.onerror = reject;
        document.head.appendChild(s);
      });
      return loading;
    },
    layer: (opts) => new Layer(Object.assign({ pane: 'densityPane', opacity: 0.62, updateWhenZooming: false, keepBuffer: 3 }, opts)),
    at(lat, lon) {
      if (!feats) return null;
      const m = merc(lat, lon);
      for (const f of candidates(lat, lon, lat, lon)) {
        let c = 0; for (const r of f.m) if (G.pointInRing(m, r)) c++;
        if (c % 2) return f;
      }
      return null;
    },
    // centres: xy points; returns {pop, newPop, perStation[]} within radius (union, no double counting)
    catchment(centres, radius = 800) {
      if (!pts) return null;
      const seen = new Uint8Array(pts.length);
      let pop = 0, newPop = 0;
      const per = centres.map(c => {
        let own = 0;
        for (const o of ptGrid.query([c[0] - radius, c[1] - radius, c[0] + radius, c[1] + radius])) {
          if (Math.hypot(o.x - c[0], o.y - c[1]) > radius) continue;
          own += o.w;
          if (!seen[o.i]) { seen[o.i] = 1; pop += o.w; if (!existingCovered[o.i]) newPop += o.w; }
        }
        return own;
      });
      return { pop, newPop, per };
    },
  };
})();
