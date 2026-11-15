// Ground elevation from AWS / Mapzen "Terrarium" terrain tiles (public, CORS-enabled).
// elevation (m) = R*256 + G + B/256 − 32768
(function () {
  const Z = 13, URL = (x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${Z}/${x}/${y}.png`;
  const tiles = new Map(); // key -> {data: Float32Array} | Promise
  const N = 2 ** Z;

  const tileXY = (lat, lon) => {
    const x = (lon + 180) / 360 * N;
    const r = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N;
    return [x, y];
  };

  function load(tx, ty) {
    const key = tx + '/' + ty;
    if (tiles.has(key)) return tiles.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, 256, 256).data, data = new Float32Array(256 * 256);
        for (let i = 0; i < data.length; i++) data[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        const t = { data }; tiles.set(key, t); resolve(t); changed();
      };
      img.onerror = () => { const t = { data: null }; tiles.set(key, t); resolve(t); changed(); };
      img.src = URL(tx, ty);
    });
    tiles.set(key, p);
    return p;
  }

  let timer = null;
  const listeners = [];
  function changed() {
    TB.terrain.version++;
    clearTimeout(timer); timer = setTimeout(() => listeners.forEach(f => f()), 120);
  }

  TB.terrain = {
    version: 0,
    onChange: (f) => listeners.push(f),
    // make sure tiles covering these [lat,lon] points are loaded
    ensure(points) {
      const need = new Set();
      for (const [lat, lon] of points) {
        const [x, y] = tileXY(lat, lon);
        need.add(Math.floor(x) + '/' + Math.floor(y));
      }
      return Promise.all([...need].map(k => { const [x, y] = k.split('/').map(Number); return load(x, y); }));
    },
    ready(lat, lon) {
      const [x, y] = tileXY(lat, lon), t = tiles.get(Math.floor(x) + '/' + Math.floor(y));
      return !!(t && !(t instanceof Promise));
    },
    // bilinear sample; null if tile not loaded
    sample(lat, lon) {
      const [fx, fy] = tileXY(lat, lon);
      const get = (gx, gy) => {
        const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
        const t = tiles.get(tx + '/' + ty);
        if (!t || t instanceof Promise || !t.data) return null;
        return t.data[(gy - ty * 256) * 256 + (gx - tx * 256)];
      };
      const px = fx * 256 - 0.5, py = fy * 256 - 0.5, x0 = Math.floor(px), y0 = Math.floor(py), ax = px - x0, ay = py - y0;
      const a = get(x0, y0), b = get(x0 + 1, y0), c = get(x0, y0 + 1), d = get(x0 + 1, y0 + 1);
      if (a == null || b == null || c == null || d == null) return a ?? b ?? c ?? d;
      return a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + c * (1 - ax) * ay + d * ax * ay;
    },
  };
})();
