// Geometry helpers. Local planar coordinates are metres east/north of a fixed origin in
// Toronto (equirectangular – < 1.5 % scale error across the GTA, plenty for a design game).
window.TB = window.TB || {};
(function () {
  const O = { lat: 43.70, lon: -79.40 };
  const KX = 111320 * Math.cos(O.lat * Math.PI / 180), KY = 110574;

  const geo = {
    origin: O,
    toXY: (lat, lon) => [(lon - O.lon) * KX, (lat - O.lat) * KY],
    toLL: (x, y) => [O.lat + y / KY, O.lon + x / KX],
    dist(a, b) { // [lat,lon]
      const k = 111320 * Math.cos((a[0] + b[0]) * Math.PI / 360);
      return Math.hypot((a[1] - b[1]) * k, (a[0] - b[0]) * 110574);
    },
    dxy: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
    norm(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; },
    sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1]],
    mul: (a, k) => [a[0] * k, a[1] * k],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1],

    pointSegDist(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    },
    polylineDist(p, pts) {
      let best = Infinity;
      for (let i = 1; i < pts.length; i++) best = Math.min(best, geo.pointSegDist(p, pts[i - 1], pts[i]));
      return best;
    },
    pointInRing(p, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
    // rings: [outer, ...holes or extra parts] – even-odd rule
    pointInRings(p, rings) {
      let c = 0;
      for (const r of rings) if (geo.pointInRing(p, r)) c++;
      return c % 2 === 1;
    },
    ringArea(ring) {
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
      return Math.abs(a / 2);
    },
    bbox(pts) {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of pts) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
      return b;
    },
    // rectangle centred at c (xy) with unit direction d, length L along d and width W
    rect(c, d, L, W) {
      const n = [-d[1], d[0]], hl = L / 2, hw = W / 2;
      return [
        [c[0] + d[0] * hl + n[0] * hw, c[1] + d[1] * hl + n[1] * hw],
        [c[0] - d[0] * hl + n[0] * hw, c[1] - d[1] * hl + n[1] * hw],
        [c[0] - d[0] * hl - n[0] * hw, c[1] - d[1] * hl - n[1] * hw],
        [c[0] + d[0] * hl - n[0] * hw, c[1] + d[1] * hl - n[1] * hw],
      ];
    },
    // distance from p to the edge of a rectangle (0 if inside)
    rectDist(p, c, d, L, W) {
      const v = geo.sub(p, c), along = Math.abs(geo.dot(v, d)), across = Math.abs(v[0] * -d[1] + v[1] * d[0]);
      return Math.hypot(Math.max(0, along - L / 2), Math.max(0, across - W / 2));
    },
    // radius of the circle through 3 points (Infinity if collinear)
    circumradius(a, b, c) {
      const A = geo.dxy(b, c), B = geo.dxy(a, c), C = geo.dxy(a, b);
      const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
      return area2 < 1e-9 ? Infinity : (A * B * C) / (2 * area2);
    },
    angleBetween(u, v) { return Math.acos(Math.max(-1, Math.min(1, geo.dot(geo.norm(u), geo.norm(v))))); },

    fmtLen: (m) => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km' : Math.round(m) + ' m',
  };

  // Simple uniform grid spatial index over xy bounding boxes
  geo.Grid = class {
    constructor(cell = 200) { this.cell = cell; this.m = new Map(); }
    _keys(b) {
      const c = this.cell, out = [];
      for (let i = Math.floor(b[0] / c); i <= Math.floor(b[2] / c); i++)
        for (let j = Math.floor(b[1] / c); j <= Math.floor(b[3] / c); j++) out.push(i + ',' + j);
      return out;
    }
    insert(b, item) { for (const k of this._keys(b)) { let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(item); } }
    query(b) {
      const s = new Set();
      for (const k of this._keys(b)) { const a = this.m.get(k); if (a) for (const it of a) s.add(it); }
      return s;
    }
  };

  TB.geo = geo;
})();
