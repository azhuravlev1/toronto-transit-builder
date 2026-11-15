// Export to KML / KMZ (Google Earth, Google My Maps, QGIS…). Geometry and the key numbers
// are kept; editor-only state (depth overrides, undo history…) is not.
(function () {
  const C = TB.costs, esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const kcol = (hex, a = 'ff') => { const h = hex.replace('#', ''); return a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2); }; // aabbggrr
  const coords = (pts) => pts.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)},0`).join(' ');
  const ring = (r) => coords(r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]]);

  function kml() {
    const P = TB.model.project, res = TB.app.result;
    const styles = [], folders = [];
    for (const line of P.lines) {
      const r = res.lines.get(line.id); if (!r || r.empty) continue;
      const id = 'l' + line.id;
      styles.push(`<Style id="${id}"><LineStyle><color>${kcol(line.color)}</color><width>5</width></LineStyle><PolyStyle><color>${kcol(line.color, '55')}</color></PolyStyle>
        <IconStyle><color>${kcol(line.color)}</color><scale>0.9</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_square.png</href></Icon></IconStyle></Style>`);
      const pm = [];
      // track, split by construction type
      let cur = null; const groups = [];
      for (let k = 1; k < r.S.length; k++) {
        if (!cur || cur.span !== r.S[k].span) { cur = { span: r.S[k].span, pts: [[r.S[k - 1].lat, r.S[k - 1].lon]] }; groups.push(cur); }
        if (k % 2 === 0 || k === r.S.length - 1 || r.S[k + 1] && r.S[k + 1].span !== cur.span) cur.pts.push([r.S[k].lat, r.S[k].lon]);
      }
      for (const g of groups) {
        const sp = r.spans[g.span];
        pm.push(`<Placemark><name>${esc(C.SPANS[sp.type].label)} · ${(sp.len / 1000).toFixed(2)} km</name><description>${esc(C.fmt(sp.cost))}</description><styleUrl>#${id}</styleUrl>
          <LineString><tessellate>1</tessellate><coordinates>${coords(g.pts)}</coordinates></LineString></Placemark>`);
      }
      for (const st of r.stations) {
        const total = st.structure + st.fit + st.finishes + st.land + st.exitCost + st.connCost + st.takingCost;
        const desc = `<b>${esc(line.name)}</b><br>${st.level === 'under' ? Math.round(st.depth) + ' m deep' : st.level === 'above' ? 'Elevated' : 'At grade'} · ${st.L} × ${Math.round(st.W)} m (${st.layout} platform${st.layout === 'side' ? 's' : ''})<br>` +
          `Construction ${C.fmt(st.structure + st.fit + st.finishes)} · Land ${C.fmt(st.land + st.takingCost)} · Exits ${C.fmt(st.exitCost)}${st.connCost ? ' · Connections ' + C.fmt(st.connCost) : ''}<br><b>Total ${C.fmt(total)}</b>`;
        pm.push(`<Placemark><name>${esc(st.node.name)}</name><description><![CDATA[${desc}]]></description><styleUrl>#${id}</styleUrl><Point><coordinates>${st.lon},${st.lat},0</coordinates></Point></Placemark>`);
        pm.push(`<Placemark><name>${esc(st.node.name)} – station box</name><styleUrl>#${id}</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(st.rectLL)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
        st.exits.forEach((e, n) => pm.push(`<Placemark><name>${esc(st.node.name)} – exit ${n + 1}</name><description>${esc(C.fmt(e.cost))}</description><Point><coordinates>${e.ex.lon},${e.ex.lat},0</coordinates></Point></Placemark>`));
        for (const e of st.exitEdges) pm.push(`<Placemark><name>Exit passage</name><Style><LineStyle><color>ff205e1b</color><width>2</width></LineStyle></Style><LineString><coordinates>${coords([e.from, e.to])}</coordinates></LineString></Placemark>`);
        for (const cn of st.conns) pm.push(`<Placemark><name>Transfer to ${esc(cn.ex.name)} (${esc(cn.ex.lineName)})</name><description>${esc(cn.type)} · ${Math.round(cn.passage)} m · ${esc(C.fmt(cn.cost))}</description><Style><LineStyle><color>ff111111</color><width>3</width></LineStyle></Style><LineString><coordinates>${coords(cn.ptsLL)}</coordinates></LineString></Placemark>`);
        for (const p of st.parcels) {
          const pc = C.parcelCost(p, p.lat, p.lon);
          const [outer, ...inner] = p.ringsLL;
          pm.push(`<Placemark><name>${esc(pc.label)} (acquired for ${esc(st.node.name)})</name><description>${Math.round(p.area)} m² · ${esc(C.fmt(pc.total))}</description><styleUrl>#${id}</styleUrl>
            <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(outer)}</coordinates></LinearRing></outerBoundaryIs>${inner.map(h => `<innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`).join('')}</Polygon></Placemark>`);
        }
      }
      folders.push(`<Folder><name>${esc(line.name)} – ${esc(C.fmt(r.cost.total))}, ${(r.metrics.length / 1000).toFixed(1)} km</name>${pm.join('\n')}</Folder>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(P.name)}</name>
<description>Made with Toronto Transit Builder · total ${esc(C.fmt(res.total))}</description>
${styles.join('\n')}
${folders.join('\n')}
</Document></kml>`;
  }

  // minimal ZIP writer (stored, no compression) – enough for a single-file KMZ
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(name, data) {
    const fn = new TextEncoder().encode(name), crc = crc32(data), n = data.length;
    const lh = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, n, 4], [22, n, 4], [26, fn.length, 2], [28, 0, 2]]
      .forEach(([o, v, s]) => s === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true));
    const ch = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, n, 4], [24, n, 4], [28, fn.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, 0, 4]]
      .forEach(([o, v, s]) => s === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true));
    const cdOff = 30 + fn.length + n, cdLen = 46 + fn.length;
    const end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, 1, 2], [10, 1, 2], [12, cdLen, 4], [16, cdOff, 4], [20, 0, 2]]
      .forEach(([o, v, s]) => s === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
    return new Blob([lh, fn, data, ch, fn, end], { type: 'application/vnd.google-earth.kmz' });
  }

  function download(kind) {
    if (!TB.model.project.lines.some(l => l.nodes.length > 1)) { TB.ui.toast('Draw a line first.'); return; }
    const text = kml(), base = (TB.model.project.name || 'network').replace(/[^\w-]+/g, '_');
    const blob = kind === 'kmz' ? zip('doc.kml', new TextEncoder().encode(text)) : new Blob([text], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = base + '.' + kind; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    TB.ui.toast(`Exported ${base}.${kind} – open it in Google Earth or Google My Maps`);
  }

  TB.exporter = { kml, download, zip };
})();
