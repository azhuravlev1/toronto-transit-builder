// Minimal Mapbox Vector Tile (protobuf) decoder: layers → features {type, props, geom}
// geom: array of rings/lines of [x, y] in tile units (0 … extent).
(function () {
  function Reader(buf) { this.b = buf; this.p = 0; }
  Reader.prototype = {
    varint() {
      let r = 0, s = 0, b;
      do { b = this.b[this.p++]; if (s < 28) r |= (b & 0x7f) << s; else r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80);
      return r >>> 0 === r ? r : r;
    },
    svarint() { const v = this.varint(); return (v % 2 === 1) ? (v + 1) / -2 : v / 2; },
    bytes() { const n = this.varint(), s = this.p; this.p += n; return this.b.subarray(s, s + n); },
    string() { return new TextDecoder().decode(this.bytes()); },
    skip(wt) {
      if (wt === 0) this.varint(); else if (wt === 1) this.p += 8; else if (wt === 2) this.p += this.varint(); else if (wt === 5) this.p += 4;
      else throw new Error('bad wire type ' + wt);
    },
    packed() { const end = this.varint() + this.p, out = []; while (this.p < end) out.push(this.varint()); return out; },
  };
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  function value(buf) {
    const r = new Reader(buf); let v = null;
    while (r.p < buf.length) {
      const tag = r.varint(), f = tag >> 3, wt = tag & 7;
      if (f === 1) v = r.string();
      else if (f === 2) { v = dv(r.b).getFloat32(r.p, true); r.p += 4; }
      else if (f === 3) { v = dv(r.b).getFloat64(r.p, true); r.p += 8; }
      else if (f === 4 || f === 5) v = r.varint();
      else if (f === 6) v = r.svarint();
      else if (f === 7) v = !!r.varint();
      else r.skip(wt);
    }
    return v;
  }

  function geometry(cmds) {
    const out = []; let x = 0, y = 0, cur = null, i = 0;
    while (i < cmds.length) {
      const c = cmds[i++], id = c & 7, n = c >> 3;
      if (id === 1 || id === 2) {
        for (let k = 0; k < n; k++) {
          const dx = cmds[i++], dy = cmds[i++];
          x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
          if (id === 1) { cur = []; out.push(cur); }
          cur.push([x, y]);
        }
      } else if (id === 7 && cur) cur.push(cur[0].slice());
    }
    return out;
  }

  function layer(buf) {
    const r = new Reader(buf), keys = [], vals = [], feats = [];
    let name = '', extent = 4096;
    while (r.p < buf.length) {
      const tag = r.varint(), f = tag >> 3, wt = tag & 7;
      if (f === 1) name = r.string();
      else if (f === 2) feats.push(r.bytes());
      else if (f === 3) keys.push(r.string());
      else if (f === 4) vals.push(value(r.bytes()));
      else if (f === 5) extent = r.varint();
      else r.skip(wt);
    }
    const features = feats.map(fb => {
      const fr = new Reader(fb); let id = null, tags = [], type = 0, geom = [];
      while (fr.p < fb.length) {
        const tag = fr.varint(), f = tag >> 3, wt = tag & 7;
        if (f === 1) id = fr.varint();
        else if (f === 2) tags = fr.packed();
        else if (f === 3) type = fr.varint();
        else if (f === 4) geom = fr.packed();
        else fr.skip(wt);
      }
      const props = {};
      for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
      return { id, type, props, geom: geometry(geom) };
    });
    return { name, extent, features };
  }

  function decode(buf) {
    const r = new Reader(buf), layers = {};
    while (r.p < buf.length) {
      const tag = r.varint(), f = tag >> 3, wt = tag & 7;
      if (f === 3) { const l = layer(r.bytes()); layers[l.name] = l; } else r.skip(wt);
    }
    return layers;
  }

  (typeof window !== 'undefined' ? (window.TB = window.TB || {}) : module.exports).mvt = { decode };
})();
