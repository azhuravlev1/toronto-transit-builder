// Side panel, toolbar, mode banner, legend, cost breakdown, menus and modals.
(function () {
  const G = TB.geo, C = TB.costs, M = TB.model, esc = (s) => TB.render.esc(s ?? '');
  const $ = (s, r = document) => r.querySelector(s);
  let panel, ctlBox, statBox, sumBox, linesBox, lastSelKey = null, liveSlider = false, toastTimer = null, fixes = [];
  const openKeys = new Set();
  const fmt = C.fmt, num = (v) => Math.round(v).toLocaleString();
  const S = () => TB.state;

  const MODE_INFO = {
    select: { color: '#1f2328', label: 'Select & edit' },
    draw: { color: null, label: 'Drawing' },
    acquire: { color: '#2e7d32', label: 'Land acquisition' },
    exit: { color: '#00838f', label: 'Exit placement' },
  };

  // ---------------------------------------------------------------------------------------
  function init() {
    panel = $('#panel');
    sumBox = $('#summary'); linesBox = $('#lines'); ctlBox = $('#inspector-controls'); statBox = $('#inspector-stats');
    buildToolbar(); buildLegend();
    document.body.addEventListener('click', onClick);
    panel.addEventListener('input', onInput);
    panel.addEventListener('change', onChange);
    panel.addEventListener('toggle', (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) e.target.open ? openKeys.add(k) : openKeys.delete(k); }, true);
    $('#menu-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').classList.toggle('open'); });
    document.addEventListener('click', (e) => { $('#menu').classList.remove('open'); if (!e.target.closest('#ctxmenu')) closeMenu(); });
    document.addEventListener('contextmenu', (e) => { if (!e.target.closest('#map')) closeMenu(); });
    $('#import-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { await M.importFile(f); TB.state.activeLine = M.project.lines[0]?.id || null; TB.state.sel = null; toast('Imported ' + f.name); }
      catch (err) { toast('Import failed: ' + err.message); }
      e.target.value = '';
    });
    $('#project-name').addEventListener('change', (e) => M.change(p => { p.name = e.target.value.trim() || 'My Toronto network'; }));
    $('#panel-toggle').addEventListener('click', () => document.body.classList.toggle('panel-collapsed'));
  }

  function buildToolbar() {
    $('#toolbar').innerHTML = `
      <div class="grp modes">
        <button data-act="mode" data-mode="select" title="Select & edit (V)">${ico('cursor')}<span>Select</span></button>
        <button data-act="draw" data-mode="draw" title="Draw / extend a line (D) – click to add stations, Shift-click for a bend point, double-click or Esc to finish">${ico('pen')}<span>Draw</span></button>
        <button data-act="mode" data-mode="acquire" title="Acquire land (A) – click lots and buildings near a station">${ico('land')}<span>Land</span></button>
        <button data-act="mode" data-mode="exit" title="Place exits for the selected station (E)">${ico('exit')}<span>Exits</span></button>
      </div>
      <div class="grp">
        <button data-act="density" id="tb-density" title="2021 Census population density (P)">${ico('people')}<span>Density</span></button>
        <button data-act="network" id="tb-network" title="Existing TTC / GO network (T)">${ico('rail')}<span>Transit</span></button>
        <button data-act="profile" id="tb-profile" title="Vertical profile of the active line">${ico('profile')}<span>Profile</span></button>
      </div>
      <div class="grp"><button data-act="help" title="How to play (?)">?</button></div>`;
    updateToolbar();
  }
  function modeColor() {
    const m = S().mode, line = M.line(S().activeLine);
    return m === 'draw' ? (line ? line.color : '#E4007C') : MODE_INFO[m].color;
  }
  function updateToolbar() {
    const col = modeColor();
    document.body.style.setProperty('--mode', col);
    document.querySelectorAll('#toolbar [data-mode]').forEach(b => b.classList.toggle('on', S().mode === b.dataset.mode));
    $('#tb-density').classList.toggle('on', S().showDensity);
    $('#tb-network').classList.toggle('on', S().showNetwork);
    $('#tb-profile').classList.toggle('on', S().profile);
    updateBanner();
  }
  function updateBanner() {
    const m = S().mode, el = $('#mode-banner');
    const f = S().sel && S().sel.nodeId && M.findNode(S().sel.nodeId);
    const st = f && f.node.kind === 'station' ? f.node : null, line = M.line(S().activeLine);
    let html = '';
    if (m === 'draw') html = `<b>Drawing ${esc(line ? line.name : 'a new line')}</b> · click to add stations · Shift-click: bend point · click an end station to switch ends · Esc / double-click: finish`;
    else if (m === 'acquire') html = `<b>Land acquisition${st ? ' for ' + esc(st.name) : ''}</b> · zoom in and click lots & buildings · green = publicly owned (usually free) · right-click acquired land to release · Esc: done`;
    else if (m === 'exit') html = st ? `<b>Exits for ${esc(st.name)}</b> · click to add an exit (near an existing exit tunnel it branches off it; Shift-click: its own tunnel) · red land must be acquired first · drag to move · right-click to delete · Esc: done`
      : '<b>Exit placement</b> · click a station first';
    el.innerHTML = html; el.classList.toggle('show', !!html);
  }

  function ico(n) {
    const p = {
      cursor: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
      pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
      land: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 12h16M12 4v16" stroke-dasharray="2 2"/>',
      exit: '<path d="M10 4h9v16h-9"/><path d="M3 12h10M9 8l4 4-4 4"/>',
      people: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="9" r="2.5"/><path d="M3 20c0-4 3-6 5-6s5 2 5 6M13 20c0-3 1.5-5 3-5s4 2 4 5"/>',
      rail: '<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M8 21l2-4M16 21l-2-4M6 11h12"/>',
      profile: '<path d="M3 17c3-1 4-6 7-6s4 4 7 3 3-4 4-4"/><path d="M3 20h18"/>',
    }[n];
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  function buildLegend() {
    const ttc = TRANSIT.filter(l => l.kind === 'subway').map(l => `<span class="lg-ttc"><i style="background:${l.color};${l.id === 'L6' ? 'height:3px' : ''}"></i>${l.id.slice(1)}</span>`).join('');
    const go = `<span class="lg-ttc"><i class="go"></i>GO / UP</span>` +
      ((window.CONSTRUCTION || []).length ? `<span class="lg-ttc" title="${CONSTRUCTION.map(l => `${l.name} (${l.opening})`).join('\n')}"><i class="uc"></i>Under construction</span>` : '');
    const sample = (t) => `<svg width="34" height="12">${legendLine(t)}</svg>`;
    $('#legend').innerHTML = `
      <div class="lg-row">${ttc}${go}</div>
      <div class="lg-row lg-types">${['bored', 'atgrade', 'street', 'elevated', 'bridge'].map(t => `<span>${sample(t)}${C.SPANS[t].label.split(' (')[0]}</span>`).join('')}</div>
      <div class="lg-density"><div class="lg-title">People per km² (2021 Census, by dissemination area)</div>
        <div class="lg-ramp">${TB.population.COLORS.map((c, i) => `<span style="background:${c}" title="${i ? '≥ ' + num(TB.population.BREAKS[i - 1]) : '< ' + num(TB.population.BREAKS[0])}"></span>`).join('')}</div>
        <div class="lg-ticks"><span>0</span><span>2.5k</span><span>7.5k</span><span>15k</span><span>50k+</span></div></div>`;
  }
  function legendLine(t, c = '#E4007C') {
    const y = 6;
    const L = (st) => `<line x1="2" y1="${y}" x2="32" y2="${y}" stroke-linecap="round" ${st}/>`;
    return ({
      bored: L(`stroke="${c}" stroke-width="5"`),
      cutcover: L(`stroke="${c}" stroke-width="5"`),
      trench: L(`stroke="${c}" stroke-width="5"`) + L(`stroke="#fff" stroke-width="1.2" stroke-dasharray="1 4"`),
      atgrade: L(`stroke="#fff" stroke-width="7"`) + L(`stroke="${c}" stroke-width="5"`) + L(`stroke="#fff" stroke-width="1.5" stroke-dasharray="4 4"`),
      street: L(`stroke="${c}" stroke-width="3"`),
      rail: L(`stroke="#555" stroke-width="8" stroke-dasharray="2 4"`) + L(`stroke="${c}" stroke-width="4"`),
      elevated: L(`stroke="#2b2b2b" stroke-width="8"`) + L(`stroke="${c}" stroke-width="5"`),
      bridge: L(`stroke="#1d1d1d" stroke-width="11"`) + L(`stroke="#fff" stroke-width="7.5"`) + L(`stroke="${c}" stroke-width="5"`),
      oldbridge: L(`stroke="#6b6b6b" stroke-width="10" stroke-dasharray="4 3"`) + L(`stroke="#fff" stroke-width="7"`) + L(`stroke="${c}" stroke-width="5"`),
    })[t];
  }

  // ---------------------------------------------------------------------------------------
  function update(res, opts = {}) {
    fixes = [];
    renderSummary(res);
    if (!opts.live) renderLines(res);
    const sel = S().sel, key = selKey(sel);
    const focused = panel.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'radio';
    if (key !== lastSelKey || (!opts.live && !liveSlider && !focused)) { ctlBox.innerHTML = controls(sel, res); lastSelKey = key; }
    statBox.innerHTML = stats(sel, res);
    const kind = !sel ? (S().activeLine ? 'line' : '') : sel.exitId ? 'exit' : sel.type;
    $('#inspector').dataset.kind = kind || '';
    $('#undo').disabled = !M.canUndo(); $('#redo').disabled = !M.canRedo();
    $('#project-name').value = M.project.name;
    updateToolbar();
  }
  const selKey = (sel) => {
    if (!sel) return 'none:' + (S().activeLine || '');
    const f = sel.nodeId && M.findNode(sel.nodeId);
    return [sel.type, sel.lineId, sel.nodeId, sel.span].join(':') + ':' + (M.line(sel.lineId) || {}).mode + ':' +
      JSON.stringify(sel.type === 'span' ? (M.line(sel.lineId)?.nodes[sel.span]?.out) : f ? [f.node.depth ?? 'auto', f.node.width, f.node.rot] : '');
  };

  // ---- network summary + drill-down breakdown -----------------------------------------------
  function renderSummary(res) {
    const lines = [...res.lines.values()].filter(r => !r.empty);
    if (!lines.length) {
      sumBox.innerHTML = `<div class="empty">
        <p><b>Design your own Toronto rapid transit.</b></p>
        <p>Press <kbd>D</kbd> or <button class="link" data-act="newline">start a new line</button>, then click on the map to place stations. Watch the price tag as you build.</p></div>`;
      return;
    }
    const total = res.total, km = res.length / 1000, budget = M.project.budget || 20e9;
    const perKm = km ? total / km : 0;
    const bench = C.BENCHMARKS.reduce((best, b) => Math.abs(Math.log(b.perKm / perKm)) < Math.abs(Math.log(best.perKm / perKm)) ? b : best, C.BENCHMARKS[0]);
    const cm = res.catchment;
    const errs = res.warnings.filter(w => w.sev === 'error').length, warns = res.warnings.filter(w => w.sev === 'warn').length;
    const pct = Math.min(100, total / budget * 100), open = openKeys.has('bd');
    sumBox.innerHTML = `
      <div class="total"><button class="total-btn" data-act="breakdown" title="Click for the full cost breakdown">
          <div class="big">${fmt(total)} <span class="caret">${open ? '▾' : '▸'}</span></div>
          <div class="muted">${km.toFixed(1)} km · ${lines.reduce((a, r) => a + r.metrics.stations, 0)} stations · ${fmt(perKm)}/km</div></button>
        <div class="badges">${errs ? `<span class="badge error">${errs} problem${errs > 1 ? 's' : ''}</span>` : ''}${warns ? `<span class="badge warn">${warns} warning${warns > 1 ? 's' : ''}</span>` : ''}</div></div>
      ${open ? breakdown(res) : ''}
      <div class="budget" title="Budget ${fmt(budget)} – change it in the ⋯ menu"><div class="bar"><i style="width:${pct}%;background:${total > budget ? '#d32f2f' : '#2e7d32'}"></i></div>
        <span class="muted">${total > budget ? 'Over' : 'Within'} budget of ${fmt(budget)}</span></div>
      ${cm ? `<div class="kpis"><div><b>${num(cm.pop)}</b><span>residents within 800 m</span></div><div><b>${num(cm.newPop)}</b><span>newly served by rapid transit</span></div>
        <div><b>${cm.newPop > 0 ? fmt(total / cm.newPop) : '–'}</b><span>per newly served resident</span></div></div>` : '<div class="muted small">Loading census data for catchment stats…</div>'}
      <div class="bench muted small">Cost per km is closest to <b>${esc(bench.name)}</b> (${fmt(bench.perKm)}/km).</div>`;
  }

  function det(key, summary, body, extra = '') {
    return `<details data-k="${key}" ${openKeys.has(key) ? 'open' : ''} ${extra}><summary>${summary}</summary><div class="bd-body">${body}</div></details>`;
  }
  const row = (label, v, act = '') => `<div class="bd-row" ${act}><span>${label}</span><b>${fmt(v)}</b></div>`;
  const sumRow = (label, v, color) => `<span class="bd-l">${color ? `<i class="sw" style="background:${color}"></i>` : ''}${label}</span><b>${fmt(v)}</b>`;

  function breakdown(res) {
    const out = [];
    for (const [id, r] of res.lines) {
      if (r.empty) continue;
      const line = r.line, c = r.cost, mul = (1 + C.SOFT) * (1 + C.CONTINGENCY);
      const spanName = (sp) => {
        const a = line.nodes.slice(0, sp.i + 1).reverse().find(n => n.kind === 'station'), b = line.nodes.slice(sp.i + 1).find(n => n.kind === 'station');
        return `${esc(a ? a.name : 'start')} → ${esc(b ? b.name : 'end')}`;
      };
      const tunnels = r.spans.map(sp => row(`${spanName(sp)} <span class="muted">· ${C.SPANS[sp.type].label.split(' (')[0]} · ${G.fmtLen(sp.len)}</span>`, sp.cost,
        `data-act="bd-span" data-line="${id}" data-span="${sp.i}"`)).join('') + (r.portals ? row(`Portals × ${r.portals}`, r.portals * C.PORTAL) : '');
      const stations = r.stations.map(st => {
        const construction = st.structure + st.fit + st.finishes, total = construction + st.land + st.exitCost + st.connCost + st.takingCost;
        const land = st.parcels.map(p => { const pc = C.parcelCost(p, p.lat, p.lon); return row(`${esc(pc.label)} <span class="muted">${num(p.area)} m²</span>`, pc.total); }).join('');
        const body =
          det(`st-land:${st.node.id}`, sumRow('Land acquisition', st.land + st.takingCost), (land || '<div class="muted small">No land acquired</div>') + (st.takingCost ? row('Forced expropriation (footprint)', st.takingCost) : '')) +
          det(`st-con:${st.node.id}`, sumRow('Construction', construction), row('Station box / structure', st.structure) + row('Fit-out (escalators, MEP, systems)', st.fit) + row(`Finishes (${C.STYLES[st.node.style || 'standard'].label})`, st.finishes)) +
          det(`st-ex:${st.node.id}`, sumRow('Exits & passages', st.exitCost), st.exits.map((e, n) => row(`Exit ${n + 1} <span class="muted">· ${Math.round(e.passage)} m</span>`, e.cost)).join('') +
            st.junctions.map(j => row('Tunnel junction', j.cost)).join('') + (st.defaultExits ? row(`${st.defaultExits} default exit${st.defaultExits > 1 ? 's' : ''} (not placed yet)`, st.exitCost - st.exits.reduce((a, e) => a + e.cost, 0) - st.junctions.reduce((a, j) => a + j.cost, 0)) : '')) +
          (st.conns.length ? det(`st-cn:${st.node.id}`, sumRow('Connections', st.connCost), st.conns.map(cn => row(`${esc(cn.ex.name)} <span class="muted">(${esc(cn.ex.lineName)}) · ${cn.difficulty}</span>`, cn.cost)).join('')) : '') +
          `<button class="link small" data-act="bd-station" data-node="${st.node.id}">Show on map →</button>`;
        return det(`st:${st.node.id}`, sumRow(esc(st.node.name), total), body);
      }).join('');
      const corridor = [...r.takings.values()];
      const body =
        det(`tn:${id}`, sumRow('Tunnels, track & structures', c.track), tunnels || '<div class="muted small">–</div>') +
        det(`sts:${id}`, sumRow('Stations', r.stations.reduce((a, st) => a + st.structure + st.fit + st.finishes + st.land + st.exitCost + st.connCost + st.takingCost, 0)), stations) +
        (corridor.length ? det(`cor:${id}`, sumRow('Land along the track', corridor.reduce((a, t) => a + t.cost, 0)), corridor.map(t => row(esc(C.parcelCost(t.f, t.lat, t.lon).label), t.cost)).join('')) : '') +
        (c.interchange ? `<div class="bd-row"><span>Interchanges with new lines</span><b>${fmt(c.interchange)}</b></div>` : '') +
        `<div class="bd-row"><span>Systems (power, signals, track)</span><b>${fmt(c.systems)}</b></div>` +
        `<div class="bd-row"><span>Trains & yard</span><b>${fmt(c.fleet)}</b></div>` +
        `<div class="bd-row"><span>Design & management (14 %)</span><b>${fmt(c.soft)}</b></div>` +
        `<div class="bd-row"><span>Contingency (15 %)</span><b>${fmt(c.contingency + (c.interchange ? c.interchange * (mul - 1) : 0))}</b></div>`;
      out.push(det(`ln:${id}`, sumRow(esc(line.name), c.total, line.color), body));
    }
    return `<div class="breakdown">${out.join('')}<div class="muted small">Items are construction costs before design & contingency, which are added per line.</div></div>`;
  }

  function renderLines(res) {
    const P = M.project;
    linesBox.innerHTML = `<div class="sec-h"><span>Lines</span><button class="btn small" data-act="newline">+ New line</button></div>` +
      P.lines.map(l => {
        const r = res.lines.get(l.id), active = S().activeLine === l.id;
        return `<div class="line-row${active ? ' active' : ''}" data-act="selline" data-line="${l.id}" style="--c:${l.color}">
          <i class="sw" style="background:${l.color}"></i><span class="nm">${esc(l.name)}</span>
          <span class="muted small">${C.MODES[l.mode].label.split(' (')[0]} · ${G.fmtLen(r.metrics.length || 0)}</span>
          <span class="cost">${fmt(r.cost.total || 0)}</span>
          <button class="icon" data-act="vis" data-line="${l.id}" title="Show / hide">${l.visible === false ? '◌' : '●'}</button></div>`;
      }).join('');
  }

  // ---- inspector ---------------------------------------------------------------------------
  function crumb(line, kind, name) {
    const label = { line: 'Line', station: 'Station', waypoint: 'Bend point', span: 'Track', exit: 'Exit' }[kind];
    return `<div class="crumb"><span class="pill ${kind}">${label}</span>${kind !== 'line' ? `<button class="link" data-act="selline" data-line="${line.id}"><i class="sw" style="background:${line.color}"></i>${esc(line.name)}</button><span class="muted">›</span>` : ''}<span class="cn">${name}</span></div>`;
  }

  function controls(sel, res) {
    const lineId = sel ? sel.lineId : S().activeLine;
    const line = M.line(lineId);
    if (!line) return '';
    if (!sel || sel.type === 'line') return lineControls(line);
    if (sel.type === 'station' || sel.type === 'waypoint') {
      const f = M.findNode(sel.nodeId); if (!f) return '';
      return sel.type === 'station' ? stationControls(f.line, f.node, res) : waypointControls(f.line, f.node, f.index, res);
    }
    if (sel.type === 'span') return spanControls(line, sel.span, res);
    return '';
  }
  function stats(sel, res) {
    const lineId = sel ? sel.lineId : S().activeLine;
    const line = M.line(lineId); if (!line) return '';
    const r = res.lines.get(line.id); if (!r) return '';
    if (!sel || sel.type === 'line') return lineStats(line, r);
    if (sel.type === 'station') { const st = (r.stations || []).find(s => s.node.id === sel.nodeId); return st ? stationStats(line, st, r, res) : ''; }
    if (sel.type === 'waypoint') { const f = M.findNode(sel.nodeId); return f ? waypointStats(line, f.node, f.index, r) : ''; }
    if (sel.type === 'span') return spanStats(line, sel.span, r);
    return '';
  }

  function lineControls(line) {
    return `${crumb(line, 'line', '')}<div class="insp-h"><i class="sw big" style="background:${line.color}"></i><input class="title" data-f="line.name" value="${esc(line.name)}"></div>
      <div class="row"><label>Colour</label><input type="color" data-f="line.color" value="${line.color}">
        <label>Technology</label><select data-f="line.mode">${Object.entries(C.MODES).map(([k, m]) => `<option value="${k}"${k === line.mode ? ' selected' : ''}>${m.label}</option>`).join('')}</select></div>
      <div class="btns"><button class="btn primary" data-act="draw">${line.nodes.length ? 'Extend line' : 'Draw line'} (D)</button>
        <button class="btn" data-act="zoomline">Zoom to line</button>
        <button class="btn danger" data-act="delline">Delete line</button></div>`;
  }
  function lineStats(line, r) {
    if (r.empty) return `<p class="muted">Click on the map to place the first stations. Shift-click adds a bend point instead of a station.</p>`;
    const m = r.metrics, c = r.cost, cm = m.catchment;
    const rows = [['Tunnels, track & structures', c.track], ['Stations', c.stations], ['Exits & entrances', c.exits], ['Land & expropriation', c.land],
      ['Connections to TTC / GO', c.connections], ['Interchanges with new lines', c.interchange], ['Systems (power, signals, track)', c.systems],
      ['Trains & yard', c.fleet], ['Design & management (14 %)', c.soft], ['Contingency (15 %)', c.contingency]];
    return `<div class="kv">
        <div><span>Length</span><b>${G.fmtLen(m.length)}</b></div><div><span>Stations</span><b>${m.stations}</b></div>
        <div><span>Avg. spacing</span><b>${G.fmtLen(m.spacing)}</b></div><div><span>End to end</span><b>${(m.runtime / 60).toFixed(1)} min</b></div>
        <div><span>Avg. speed</span><b>${m.speed.toFixed(0)} km/h</b></div><div><span>Fleet</span><b>${m.trains} × ${m.trainLen} m</b></div>
        <div><span>Portals</span><b>${m.portals}</b></div><div><span>Cost / km</span><b>${fmt(c.total / (m.length / 1000))}</b></div>
        ${cm ? `<div><span>Residents ≤ 800 m</span><b>${num(cm.pop)}</b></div><div><span>Newly served</span><b>${num(cm.newPop)}</b></div>` : ''}
      </div>
      ${costTable(rows, c.total)}
      ${warnList(r.warnings)}`;
  }

  function costTable(rows, total) {
    const max = Math.max(...rows.map(r => r[1] || 0), 1);
    return `<table class="costs">${rows.filter(r => r[1] > 0).map(([k, v]) => `<tr><td>${k}</td><td class="bar"><i style="width:${v / max * 100}%"></i></td><td>${fmt(v)}</td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td></td><td>${fmt(total)}</td></tr></table>`;
  }
  function warnList(ws) {
    if (!ws.length) return `<div class="ok">✓ No engineering problems found</div>`;
    const order = { error: 0, warn: 1, info: 2 };
    return `<div class="warns">${ws.slice().sort((a, b) => order[a.sev] - order[b.sev]).map((w) => {
      let fixBtn = '';
      if (w.fix) { fixes.push(w.fix); fixBtn = `<button class="btn small fix" data-act="fix" data-fix="${fixes.length - 1}" title="${esc(w.fix.label)}">Fix: ${esc(w.fix.label)}</button>`; }
      return `<div class="w ${w.sev}" data-act="gowarn" data-lat="${w.lat ?? ''}" data-lon="${w.lon ?? ''}" data-node="${w.ref && w.ref.node || ''}" data-span="${w.ref && w.ref.span != null ? w.ref.span : ''}" data-line="${w.ref && w.ref.line || ''}">${w.sev === 'error' ? '⛔' : w.sev === 'warn' ? '⚠️' : 'ℹ️'} ${esc(w.msg)}${fixBtn}</div>`;
    }).join('')}</div>`;
  }

  function depthLabel(d) { return d > 3 ? `${Math.round(d)} m below ground` : d < -3 ? `elevated ${Math.round(-d)} m` : 'at grade'; }

  function layoutSvg(layout) {
    return layout === 'island'
      ? '<svg width="54" height="30" viewBox="0 0 54 30"><rect x="1" y="1" width="52" height="28" rx="3" fill="#f3f4f6" stroke="#999"/><line x1="3" y1="7" x2="51" y2="7" stroke="#333" stroke-width="2" stroke-dasharray="2 2"/><rect x="3" y="11" width="48" height="8" fill="#fff" stroke="#666"/><line x1="3" y1="23" x2="51" y2="23" stroke="#333" stroke-width="2" stroke-dasharray="2 2"/></svg>'
      : '<svg width="54" height="30" viewBox="0 0 54 30"><rect x="1" y="1" width="52" height="28" rx="3" fill="#f3f4f6" stroke="#999"/><rect x="3" y="3" width="48" height="6" fill="#fff" stroke="#666"/><line x1="3" y1="12" x2="51" y2="12" stroke="#333" stroke-width="2" stroke-dasharray="2 2"/><line x1="3" y1="18" x2="51" y2="18" stroke="#333" stroke-width="2" stroke-dasharray="2 2"/><rect x="3" y="21" width="48" height="6" fill="#fff" stroke="#666"/></svg>';
  }

  function stationControls(line, nd, res) {
    const r = res.lines.get(line.id), st = (r.stations || []).find(s => s.node.id === nd.id);
    const depth = st ? st.depth : (nd.depth ?? 18), mode = C.MODES[line.mode];
    const level = st ? st.level : 'under', lay = mode.layout[level];
    const L = nd.length || mode.platform, W = st ? st.W : lay.island, layout = W >= lay.thr ? 'side' : 'island';
    const rot = nd.rot || 0;
    return `${crumb(line, 'station', esc(nd.name))}
      <div class="insp-h"><i class="st-ico" style="--c:${line.color}"></i><input class="title" data-f="st.name" value="${esc(nd.name)}"></div>
      <div class="ctl"><label>Rail level <span class="val" id="v-depth">${depthLabel(depth)}</span></label>
        <div class="row"><input type="range" min="-15" max="50" step="1" value="${Math.round(depth)}" data-f="st.depth" ${nd.depth == null ? 'class="auto"' : ''}>
        <label class="chk"><input type="checkbox" data-f="st.autodepth" ${nd.depth == null ? 'checked' : ''}> auto</label></div></div>
      <div class="ctl"><label>Platform length <span class="val" id="v-length">${L} m</span></label><input type="range" min="30" max="250" step="5" value="${L}" data-f="st.length"></div>
      <div class="ctl"><label>Platforms</label>
        <div class="layout"><span id="v-layout-svg">${layoutSvg(layout)}</span>
          <div><b id="v-layout">${layout === 'island' ? 'Island platform' : 'Side platforms'}</b><div class="small muted" id="v-layout-d">${layout === 'island' ? 'One shared platform between the two tracks' : 'Tracks in the middle, a platform on each side'}</div>
          <button class="btn small" data-act="layout" data-to="${layout === 'island' ? 'side' : 'island'}">Switch to ${layout === 'island' ? 'side platforms' : 'island platform'}</button></div></div>
        <label class="sub">Box width <span class="val" id="v-width">${Math.round(W)} m</span></label>
        <div class="slider-mark" style="--thr:${((lay.thr - 5) / 40) * 100}%"><input type="range" min="5" max="45" step="1" value="${Math.round(W)}" data-f="st.width" data-thr="${lay.thr}"></div>
        <div class="small muted">≥ ${lay.thr} m wide → side platforms (for ${mode.label.split(' (')[0].toLowerCase()}, ${level === 'under' ? 'underground' : level === 'above' ? 'elevated' : 'at grade'})</div></div>
      <div class="ctl"><label>Rotation <span class="val" id="v-rot">${rot ? (rot > 0 ? '↺ ' : '↻ ') + Math.abs(rot) + '°' : 'aligned with track'}</span></label>
        <div class="row"><input type="range" min="${-C.ROT_MAX}" max="${C.ROT_MAX}" step="0.5" value="${rot}" data-f="st.rot"><button class="btn small" data-act="resetrot" ${rot ? '' : 'disabled'}>Reset</button></div>
        <div class="small muted">Or drag the ⟳ handle at the end of the box. Max ±${C.ROT_MAX}° – the track bends to fit.</div></div>
      <div class="ctl"><label>Design ambition</label><div class="seg">${Object.entries(C.STYLES).map(([k, s]) => `<button class="${(nd.style || 'standard') === k ? 'on' : ''}" data-act="style" data-style="${k}" title="${s.desc}">${s.label}</button>`).join('')}</div></div>
      <div class="btns"><button class="btn mode-exit" data-act="mode" data-mode="exit">+ Exits (E)</button><button class="btn mode-acquire" data-act="mode" data-mode="acquire">Acquire land (A)</button>
        <button class="btn" data-act="towaypoint">Make bend point</button><button class="btn danger" data-act="delnode">Delete station</button></div>`;
  }

  function siteBar(site) {
    return `<div class="sitebar">${Object.entries(site).sort((a, b) => b[1] - a[1]).map(([k, f]) => `<i style="width:${f * 100}%;background:${C.SITE[k].color}" title="${C.SITE[k].label}: ${Math.round(f * 100)} %"></i>`).join('')}</div>
      <div class="sitelegend">${Object.entries(site).sort((a, b) => b[1] - a[1]).map(([k, f]) => `<span><i style="background:${C.SITE[k].color}"></i>${C.SITE[k].label} ${Math.round(f * 100)} %</span>`).join('')}</div>`;
  }

  function connDetail(cn) {
    const pct = (v) => Math.round((v || 0) * 100) + ' %';
    return `<div class="conn-detail">
      <div class="seg small"><button class="${cn.type !== 'surface' ? 'on' : ''}" data-act="linktype" data-key="${cn.ex.key}" data-type="tunnel">Underground passage</button><button class="${cn.type === 'surface' ? 'on' : ''}" data-act="linktype" data-key="${cn.ex.key}" data-type="surface">Outdoor walkway</button></div>
      <div class="kv tight">
        <div><span>Built-up around ${esc(cn.ex.name)}</span><b>${pct(cn.coverage)}</b></div><div><span>Open space (lots, parks)</span><b>${pct(cn.open)}</b></div>
        <div><span>Land value</span><b>${fmt(cn.landValue)}/m²</b></div><div><span>Operating-station premium</span><b>×${cn.busy.toFixed(1)}</b></div>
        ${cn.conflict > 1 ? `<div><span>Level conflict</span><b>×${cn.conflict.toFixed(1)}</b></div>` : ''}${cn.discount < 1 ? `<div><span>Own staging site</span><b>−20 %</b></div>` : ''}
        <div><span>Station works</span><b>${fmt(cn.baseCost)}</b></div><div><span>Passage ${G.fmtLen(cn.passage)}</span><b>${fmt(cn.passageCost)}</b></div>
      </div>
      <div class="small muted">Drag the dots on the passage to reshape it · right-click it for options.${cn.surveyed ? '' : ' Surveying the area…'}</div></div>`;
  }

  function stationStats(line, st, r, res) {
    const nd = st.node, style = C.STYLES[nd.style || 'standard'];
    const nearby = TB.network.near(st.c, 350);
    const connected = new Set(nd.connect || []);
    const rows = [['Station structure', st.structure], ['Fit-out (escalators, MEP, systems)', st.fit], [`Finishes (${style.label})`, st.finishes],
      ['Exits & passages', st.exitCost], ['Land acquired', st.land], ['Forced expropriation', st.takingCost], ['Connections to TTC / GO', st.connCost]];
    const total = rows.reduce((a, x) => a + x[1], 0);
    const exSel = S().sel && S().sel.exitId;
    return `<div class="kv"><div><span>Type</span><b>${st.level === 'under' ? 'Underground' : st.level === 'above' ? 'Elevated' : 'At grade'}</b></div>
        <div><span>Box</span><b>${st.L} × ${Math.round(st.W)} m · ${st.layout === 'island' ? 'island' : 'side'}</b></div>
        <div><span>Ground</span><b>${Math.round(st.ground)} m ASL</b></div><div><span>Land value</span><b>${fmt(st.landValue)}/m²</b></div>
        ${st.catchment != null ? `<div><span>Residents ≤ 800 m</span><b>${num(st.catchment)}</b></div>` : ''}
        ${st.level === 'under' ? `<div><span>Construction factor</span><b>×${(st.methodF * st.region).toFixed(2)}</b></div>` : ''}</div>
      <h4>Station cost</h4>${costTable(rows, total)}
      <h4>Above the station box ${st.surveyed ? '' : '<span class="muted small">(surveying…)</span>'}</h4>
      ${siteBar(st.site)}
      ${st.level === 'under' ? `<p class="hint">Excavating from acquired land is cheapest (×1.0); under roads ×1.3; under buildings ×2.3. ${st.noStaging ? '<b>Tip:</b> acquire ≥ 2,500 m² nearby as a construction staging site to save 10 %.' : '✓ Staging site secured.'}</p>` : ''}
      <h4>Exits & passages <span class="muted small">${fmt(st.exitCost)}</span></h4>
      ${st.exits.length || st.junctions.length ? `<div class="list">${st.exits.map((e, i) => `<div class="li${exSel === e.ex.id ? ' sel' : ''}${e.ok ? '' : ' bad'}"><span><b>Exit ${i + 1}</b> · ${e.surf === 'acquired' ? 'on acquired land' : esc(e.surf)} · ${Math.round(e.passage)} m${e.ex.parent ? ' · branch' : ''}${e.ok ? '' : ' · ⚠ ' + esc(e.why)}</span><b>${fmt(e.cost)}</b><button class="icon" data-act="delexit" data-exit="${e.ex.id}" title="Delete this exit">✕</button></div>`).join('')}
        ${st.junctions.map(j => `<div class="li${exSel === j.j.id ? ' sel' : ''}"><span>Tunnel junction · ${Math.round(j.passage)} m from the box</span><b>${fmt(j.cost)}</b><button class="icon" data-act="delexit" data-exit="${j.j.id}" title="Remove junction">✕</button></div>`).join('')}</div>` : ''}
      <p class="hint">${st.level === 'under' ? 'Underground stations need ≥ 2 exits. ' : ''}Press <kbd>E</kbd> and click: an exit near an existing exit tunnel <b>branches off it</b> (handy for both sides of a road); Shift-click gives it its own tunnel. Exits must be on acquired or public land. Right-click an exit to delete it.</p>
      <h4>Connections to the existing network</h4>
      ${nearby.length ? `<div class="list">${nearby.map(ex => {
        const on = connected.has(ex.key), cn = st.conns.find(c => c.ex.key === ex.key) || TB.analysis.connectionCost(st, ex, line, {});
        return `<div class="li conn"><label class="chk"><input type="checkbox" data-act="conn" data-key="${ex.key}" ${on ? 'checked' : ''}><i class="sw" style="background:${ex.color}"></i>${esc(ex.name)} <span class="muted">${esc(ex.lineName)}${ex.kind === 'construction' ? ' (u/c)' : ''} · ${Math.round(G.dxy(ex.xy, st.c))} m</span></label>
          <b class="${on ? '' : 'muted'}">${on ? '' : '≈'}${fmt(cn.cost)}</b><span class="diff ${cn.difficulty.toLowerCase()}">${cn.difficulty}</span></div>${on ? connDetail(cn) : ''}`;
      }).join('')}</div>` : '<p class="muted small">No existing stations within 350 m.</p>'}
      ${(st.interchange || []).length ? `<h4>Interchanges with your lines</h4><div class="list">${st.interchange.map(ic => { const o = ic.a === st ? ic.b : ic.a, ol = M.line(o.lineId); return `<div class="li"><span><i class="sw" style="background:${ol.color}"></i>${esc(o.node.name)} · ${ic.kind} · ${Math.round(ic.d)} m</span><b>${fmt(ic.cost)}</b></div>`; }).join('')}</div>` : ''}
      <h4>Land (${st.parcels.length}) <span class="muted small">${Math.round(st.stagingArea).toLocaleString()} m² within 200 m</span></h4>
      ${st.parcels.length ? `<div class="list">${st.parcels.map(p => { const c = C.parcelCost(p, p.lat, p.lon); return `<div class="li"><span>${esc(c.label)}${p.name ? ' · ' + esc(p.name) : ''} <span class="muted">${num(p.area)} m²</span></span><b>${c.total < 1e5 ? 'free*' : fmt(c.total)}</b><button class="icon" data-act="release" data-key="${p.key}" title="Release">✕</button></div>`; }).join('')}</div>`
        : `<p class="hint">No land yet. Press <kbd>A</kbd> and click parking lots, parks or buildings around the station. Green = publicly owned (Green P, TTC, GO, City) – usually free.</p>`}
      ${st.takings.length ? `<p class="hint warn">${st.takings.length} building(s) in the station footprint will be expropriated (${fmt(st.takingCost)}).</p>` : ''}
      ${st.warnings.length ? warnList(r.warnings.filter(w => w.ref && w.ref.node === nd.id)) : ''}`;
  }

  function waypointControls(line, nd) {
    return `${crumb(line, 'waypoint', 'Bend point')}
      <p class="hint">Bend points shape the track between stations. Drag to move; the curve is smoothed automatically. Right-click for options.</p>
      <div class="ctl"><label>Rail level <span class="val" id="v-depth">${nd.depth == null ? 'auto' : depthLabel(nd.depth)}</span></label>
        <div class="row"><input type="range" min="-15" max="60" step="1" value="${Math.round(nd.depth ?? 18)}" data-f="wp.depth"><label class="chk"><input type="checkbox" data-f="wp.autodepth" ${nd.depth == null ? 'checked' : ''}> auto</label></div></div>
      <label class="chk"><input type="checkbox" data-f="wp.corner" ${nd.corner ? 'checked' : ''}> Sharp corner (street-running turns)</label>
      <div class="btns"><button class="btn" data-act="tostation">Make station</button><button class="btn danger" data-act="delnode">Delete bend point</button></div>`;
  }
  function waypointStats(line, nd, i, r) {
    if (r.empty) return '';
    const k = r.nodeIdx[i], s = r.S[k];
    return `<div class="kv"><div><span>Chainage</span><b>${G.fmtLen(s.s)}</b></div><div><span>Ground</span><b>${Math.round(r.profile.g[k])} m ASL</b></div>
      <div><span>Rail</span><b>${Math.round(r.profile.z[k])} m ASL</b></div><div><span>Depth</span><b>${depthLabel(r.profile.gS[k] - r.profile.z[k])}</b></div></div>
      <p class="hint">A bend point between an underground and a surface span becomes a <b>portal</b> (≈${fmt(C.PORTAL)}). Put one where you want the line to come up.</p>`;
  }

  function spanControls(line, i) {
    const nd = line.nodes[i]; if (!nd) return '';
    const a = line.nodes.slice(0, i + 1).reverse().find(n => n.kind === 'station'), b = line.nodes.slice(i + 1).find(n => n.kind === 'station');
    const sp = C.SPANS[nd.out.type];
    return `${crumb(line, 'span', `${esc(a ? a.name : 'start')} → ${esc(b ? b.name : 'end')}`)}
      <div class="types">${Object.entries(C.SPANS).map(([k, t]) => `<label class="type${k === nd.out.type ? ' on' : ''}"><input type="radio" name="spantype" data-f="span.type" value="${k}" ${k === nd.out.type ? 'checked' : ''}>
        <svg width="34" height="12">${legendLine(k, line.color)}</svg>
        <span><b>${t.label}</b> <span class="muted">from ${fmt(t.perM * 1000)}/km</span><br><span class="small muted">${t.desc}</span></span></label>`).join('')}</div>
      ${(sp.family === 'under' || sp.family === 'cut') ? `<div class="ctl"><label>Track depth <span class="val" id="v-sdepth">${nd.out.depth == null ? 'auto' : nd.out.depth + ' m'}</span></label>
        <div class="row"><input type="range" min="4" max="60" step="1" value="${nd.out.depth ?? -sp.rel}" data-f="span.depth"><label class="chk"><input type="checkbox" data-f="span.autodepth" ${nd.out.depth == null ? 'checked' : ''}> auto</label></div>
        <p class="hint">Auto keeps bored tunnels straight between stations and dives under valleys only as needed.</p></div>` : ''}
      <div class="btns"><button class="btn" data-act="splitspan" data-kind="waypoint">+ Bend point</button><button class="btn" data-act="splitspan" data-kind="station">+ Station mid-span</button>
        <button class="btn" data-act="allspans">Apply type to whole line</button></div>`;
  }
  function spanStats(line, i, r) {
    const sp = (r.spans || [])[i]; if (!sp) return '';
    return `<div class="kv"><div><span>Length</span><b>${G.fmtLen(sp.len)}</b></div><div><span>Cost</span><b>${fmt(sp.cost)}</b></div>
      <div><span>Tightest curve</span><b>${isFinite(sp.minR) ? 'R ' + G.fmtLen(sp.minR) : 'straight'}</b></div><div><span>Steepest grade</span><b>${(sp.maxGrade * 100).toFixed(1)} %</b></div>
      ${isFinite(sp.minCover) ? `<div><span>Min. ground cover</span><b>${sp.minCover.toFixed(0)} m</b></div>` : ''}${sp.maxH > 0 ? `<div><span>Max. height</span><b>${sp.maxH.toFixed(0)} m</b></div>` : ''}</div>
      ${sp.pending ? '<p class="muted small">Surveying the corridor…</p>' : ''}
      ${sp.notes.map(n => `<p class="hint">${esc(n)}</p>`).join('')}
      ${(() => { const tk = [...r.takings.values()].filter(t => t.span === i); return tk.length ? `<p class="hint warn">${tk.length} building(s) in the way – expropriation ${fmt(tk.reduce((a, t) => a + t.cost, 0))}</p>` : ''; })()}
      ${warnList(r.warnings.filter(w => w.ref && w.ref.span === i))}`;
  }

  // ---------------------------------------------------------------------------------------
  function curNode() { const s = S().sel; return s && s.nodeId ? M.findNode(s.nodeId) : null; }

  function onInput(e) {
    const f = e.target.dataset.f; if (!f || e.target.type !== 'range') return;
    if (!liveSlider) { liveSlider = true; M.begin(); }
    const v = +e.target.value, n = curNode();
    if (f === 'st.depth' && n) { n.node.depth = v; $('#v-depth').textContent = depthLabel(v); const cb = ctlBox.querySelector('[data-f="st.autodepth"]'); if (cb) cb.checked = false; }
    if (f === 'st.length' && n) { n.node.length = v; $('#v-length').textContent = v + ' m'; }
    if (f === 'st.width' && n) {
      n.node.width = v; $('#v-width').textContent = v + ' m';
      const layout = v >= +e.target.dataset.thr ? 'side' : 'island';
      $('#v-layout').textContent = layout === 'island' ? 'Island platform' : 'Side platforms';
      $('#v-layout-d').textContent = layout === 'island' ? 'One shared platform between the two tracks' : 'Tracks in the middle, a platform on each side';
      $('#v-layout-svg').innerHTML = layoutSvg(layout);
    }
    if (f === 'st.rot' && n) { n.node.rot = v; $('#v-rot').textContent = v ? (v > 0 ? '↺ ' : '↻ ') + Math.abs(v) + '°' : 'aligned with track'; }
    if (f === 'wp.depth' && n) { n.node.depth = v; $('#v-depth').textContent = depthLabel(v); const cb = ctlBox.querySelector('[data-f="wp.autodepth"]'); if (cb) cb.checked = false; }
    if (f === 'span.depth') { const l = M.line(S().sel.lineId); l.nodes[S().sel.span].out.depth = v; $('#v-sdepth').textContent = v + ' m'; const cb = ctlBox.querySelector('[data-f="span.autodepth"]'); if (cb) cb.checked = false; }
    TB.app.redrawLive();
  }

  function onChange(e) {
    const t = e.target, f = t.dataset.f, sel = S().sel;
    if (t.type === 'range') { liveSlider = false; M.end(); lastSelKey = null; return; }
    if (t.dataset.act === 'conn') {
      const n = curNode(); if (!n) return;
      M.change(() => { const s = new Set(n.node.connect || []); t.checked ? s.add(t.dataset.key) : s.delete(t.dataset.key); n.node.connect = [...s]; });
      return;
    }
    if (!f) return;
    const n = curNode(), line = M.line(sel ? sel.lineId : S().activeLine);
    M.change(() => {
      switch (f) {
        case 'line.name': line.name = t.value.trim() || line.name; break;
        case 'line.color': line.color = t.value; break;
        case 'line.mode': line.mode = t.value; break;
        case 'st.name': n.node.name = t.value.trim() || n.node.name; n.node.autoName = false; break;
        case 'st.autodepth': n.node.depth = t.checked ? null : (TB.app.result.lines.get(n.line.id).stations.find(s => s.node.id === n.node.id)?.depth ?? 18); break;
        case 'wp.autodepth': n.node.depth = t.checked ? null : 18; break;
        case 'wp.corner': n.node.corner = t.checked; break;
        case 'span.type': line.nodes[sel.span].out = { type: t.value }; break;
        case 'span.autodepth': { const o = line.nodes[sel.span].out; o.depth = t.checked ? null : -C.SPANS[o.type].rel; if (o.depth == null) delete o.depth; break; }
      }
    });
    lastSelKey = null;
    TB.app.redraw();
  }

  function applyFix(fix) {
    M.change(() => {
      for (const ch of fix.changes) {
        if (ch.node) { const f = M.findNode(ch.node); if (f) f.node.depth = ch.depth; }
        if (ch.span != null) { const l = M.line(S().activeLine); if (l && l.nodes[ch.span]) l.nodes[ch.span].out = { type: ch.type }; }
      }
    });
    toast('Applied: ' + fix.label);
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, sel = S().sel;
    if (el.type === 'checkbox') return; // handled on change
    const n = curNode();
    switch (act) {
      case 'mode': TB.editor.setMode(el.dataset.mode); break;
      case 'draw': startDrawing(); break;
      case 'density': TB.app.toggleDensity(); break;
      case 'network': TB.app.toggleNetwork(); break;
      case 'profile': S().profile = !S().profile; document.body.classList.toggle('profile-off', !S().profile); updateToolbar(); TB.app.redraw(); break;
      case 'help': help(); break;
      case 'about': about(); break;
      case 'newline': newLine(); break;
      case 'breakdown': openKeys.has('bd') ? openKeys.delete('bd') : openKeys.add('bd'); renderSummary(TB.app.result); break;
      case 'bd-span': TB.editor.select({ type: 'span', lineId: el.dataset.line, span: +el.dataset.span }); break;
      case 'bd-station': { const f = M.findNode(el.dataset.node); if (f) { TB.editor.select({ type: 'station', lineId: f.line.id, nodeId: f.node.id }); TB.app.map.setView([f.node.lat, f.node.lon], Math.max(TB.app.map.getZoom(), 16)); } break; }
      case 'selline': if (e.target.closest('[data-act="vis"]')) return; S().activeLine = el.dataset.line; TB.editor.select({ type: 'line', lineId: el.dataset.line }); break;
      case 'vis': { const id = el.dataset.line; M.change(p => { const l = p.lines.find(x => x.id === id); l.visible = l.visible === false; }); break; }
      case 'zoomline': { const l = M.line(S().activeLine); TB.app.fit(l.nodes.map(x => [x.lat, x.lon])); break; }
      case 'delline': { const l = M.line(S().activeLine); if (l && confirm(`Delete ${l.name} and all its stations?`)) { M.change(p => { p.lines = p.lines.filter(x => x.id !== l.id); for (const k of Object.keys(p.parcels)) if (p.parcels[k].lineId === l.id) delete p.parcels[k]; }); S().activeLine = M.project.lines[0]?.id || null; S().sel = null; TB.app.redraw(); toast(`Deleted ${l.name}`, 5000, { label: 'Undo', fn: () => M.undo() }); } break; }
      case 'style': M.change(() => { n.node.style = el.dataset.style; }); lastSelKey = null; TB.app.redraw(); break;
      case 'layout': {
        const st = TB.app.result.lines.get(n.line.id).stations.find(s => s.node.id === n.node.id);
        M.change(() => { n.node.width = st.lay[el.dataset.to]; }); lastSelKey = null; break;
      }
      case 'resetrot': M.change(() => { n.node.rot = 0; }); lastSelKey = null; break;
      case 'delnode': if (n) TB.editor.deleteNode(n.node.id); break;
      case 'towaypoint': M.change(p => { n.node.kind = 'waypoint'; for (const k in p.parcels) if (p.parcels[k].nodeId === n.node.id) delete p.parcels[k]; }); TB.editor.select({ type: 'waypoint', lineId: n.line.id, nodeId: n.node.id }); break;
      case 'tostation': M.change(() => { Object.assign(n.node, { kind: 'station', name: n.node.name || 'Station', autoName: true, style: 'standard', exits: [], connect: [] }); }); TB.editor.select({ type: 'station', lineId: n.line.id, nodeId: n.node.id }); break;
      case 'release': M.change(p => { delete p.parcels[el.dataset.key]; }); break;
      case 'delexit': if (n) TB.editor.deleteExitItem(n.node, el.dataset.exit); break;
      case 'linktype': if (n) M.change(() => { n.node.links = n.node.links || {}; const lk = n.node.links[el.dataset.key] = n.node.links[el.dataset.key] || { via: [] }; lk.type = el.dataset.type; }); break;
      case 'fix': e.stopPropagation(); applyFix(fixes[+el.dataset.fix]); break;
      case 'splitspan': {
        const line = M.line(sel.lineId), r = TB.app.result.lines.get(line.id), k0 = r.nodeIdx[sel.span], k1 = r.nodeIdx[sel.span + 1];
        const target = (r.S[k0].s + r.S[k1].s) / 2; let km = k0; while (km < k1 && r.S[km].s < target) km++;
        const id = TB.editor.insertNode(line, sel.span, [r.S[km].lat, r.S[km].lon], el.dataset.kind);
        TB.editor.select({ type: el.dataset.kind, lineId: line.id, nodeId: id }); TB.app.afterChange(); break;
      }
      case 'allspans': { const line = M.line(sel.lineId), t = line.nodes[sel.span].out.type; M.change(() => line.nodes.forEach(x => { x.out = { type: t }; })); break; }
      case 'gowarn': {
        if (e.target.closest('[data-act="fix"]')) return;
        const lat = +el.dataset.lat, lon = +el.dataset.lon;
        if (el.dataset.lat) TB.app.map.setView([lat, lon], Math.max(TB.app.map.getZoom(), 15));
        if (el.dataset.node) { const f = M.findNode(el.dataset.node); if (f) TB.editor.select({ type: f.node.kind, lineId: f.line.id, nodeId: f.node.id }); }
        else if (el.dataset.span !== '') TB.editor.select({ type: 'span', lineId: el.dataset.line, span: +el.dataset.span });
        break;
      }
      case 'undo': M.undo(); break;
      case 'redo': M.redo(); break;
      case 'export': M.exportFile(); break;
      case 'kml': TB.exporter.download('kml'); break;
      case 'kmz': TB.exporter.download('kmz'); break;
      case 'import': $('#import-file').click(); break;
      case 'share': M.shareLink().then(url => { navigator.clipboard?.writeText(url).then(() => toast('Share link copied to clipboard'), () => prompt('Copy this link', url)); }); break;
      case 'budget': { const v = prompt('Budget in billions of dollars', ((M.project.budget || 20e9) / 1e9).toString()); if (v && isFinite(+v)) M.change(p => { p.budget = +v * 1e9; }); break; }
      case 'newproject': if (confirm('Start a new, empty network? (Undo can bring it back.)')) { M.reset(); S().activeLine = null; S().sel = null; TB.app.redraw(); } break;
      case 'modal-close': $('#modal').classList.remove('open'); break;
    }
  }

  function newLine() {
    let id;
    M.change(p => { const l = M.newLine(); p.lines.push(l); id = l.id; });
    S().activeLine = id; S().sel = { type: 'line', lineId: id }; S().drawEnd = 'end';
    TB.editor.setMode('draw');
  }
  function startDrawing() {
    const l = M.line(S().activeLine);
    if (!l) return newLine();
    S().drawEnd = 'end'; S().sel = { type: 'line', lineId: l.id };
    TB.editor.setMode('draw');
  }

  // ---- feedback: toasts, floating cost deltas, flashes, context menu -------------------------
  function toast(msg, ms = 3800, action) {
    const t = $('#toast');
    t.innerHTML = esc(msg) + (action ? ` <button class="toast-act">${esc(action.label)}</button>` : '');
    if (action) t.querySelector('.toast-act').onclick = (e) => { e.stopPropagation(); action.fn(); t.classList.remove('show'); };
    t.classList.add('show'); t.classList.toggle('actionable', !!action);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function costFloat(delta, x, y) {
    const el = document.createElement('div');
    el.className = 'cost-float ' + (delta > 0 ? 'up' : 'down');
    el.textContent = (delta > 0 ? '+' : '−') + fmt(Math.abs(delta)).replace('$', '$');
    el.style.left = x + 'px'; el.style.top = y + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }
  function flash(latlng, text) {
    const p = TB.app.map.latLngToContainerPoint(latlng), r = $('#map').getBoundingClientRect();
    const el = document.createElement('div'); el.className = 'cost-float up'; el.textContent = text;
    el.style.left = (r.left + p.x) + 'px'; el.style.top = (r.top + p.y) + 'px'; document.body.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }
  function menu(x, y, items) {
    closeMenu();
    const el = document.createElement('div'); el.id = 'ctxmenu';
    el.innerHTML = items.map((it, i) => it.sep ? '<hr>' : it.title ? `<div class="ctx-title">${esc(it.title)}</div>`
      : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${it.checked ? '✓ ' : ''}${esc(it.label)}</button>`).join('');
    el.addEventListener('click', (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; e.stopPropagation(); closeMenu(); items[+b.dataset.i].fn(); });
    document.body.appendChild(el);
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.min(x, innerWidth - w - 8) + 'px'; el.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  }
  function closeMenu() { const el = $('#ctxmenu'); if (el) el.remove(); }

  function densityReadout(f) {
    const el = $('#density-readout');
    if (!f) { el.classList.remove('show'); return; }
    el.innerHTML = `<i style="background:${f.col}"></i><b>${num(f.dens)}</b> people/km² · ${num(f.pop)} residents · ${f.area.toFixed(2)} km² <span class="muted">DA ${f.id}</span>`;
    el.classList.add('show');
  }

  function modal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.add('open'); }
  function help() {
    modal(`<h2>Toronto Transit Builder</h2>
      <p>Design fantasy rapid-transit lines on top of the real TTC / GO network (dashed lines are under construction) and see what they would cost if built by a lean, world-class team.</p>
      <ol>
        <li><b>Draw</b> (<kbd>D</kbd>): click to drop stations; the track length between them is shown on the map. <kbd>Shift</kbd>-click adds a bend point. Double-click, right-click or <kbd>Esc</kbd> to finish. Click a station of another line (or an existing TTC/GO station) to make an interchange.</li>
        <li><b>Shape</b>: drag stations and bend points; drag the hollow dots mid-span to bend it. Select a station and drag its ⟳ handle to rotate it a little – the track bends to fit.</li>
        <li><b>Build type</b>: click a span (or its band in the profile) to choose bored tunnel, cut-and-cover, at-grade, street median, elevated, bridge, or re-using a rail corridor / existing bridge.</li>
        <li><b>Stations</b>: set depth, platform length, island vs side platforms (by box width), rotation and design ambition.</li>
        <li><b>Land</b> (<kbd>A</kbd>): click parking lots, parks and buildings to acquire them as dig sites. City, TTC and GO lots are free; downtown buildings are not.</li>
        <li><b>Exits</b> (<kbd>E</kbd>): click around a selected station. An exit placed near an existing exit tunnel branches off it. Exits can only go on acquired or public land.</li>
        <li><b>Connections</b>: link to existing stations from the station panel; drag the dots on the transfer passage to reshape it, or make it an outdoor walkway.</li>
        <li><b>Profile</b>: scroll / pinch to zoom, drag to pan, drag stations up or down to change depth (within grade limits), click a span band to change its type, and use <b>Fix</b> on problems.</li>
        <li><b>Right-click</b> anything for options, including delete. Click the total cost for a full breakdown.</li>
      </ol>
      <p class="muted small">Your work is saved in this browser automatically. Use ⋯ to export (JSON, Google Earth KML/KMZ), import or share a link. <kbd>Ctrl/⌘ Z</kbd> undoes.</p>
      <div class="btns"><button class="btn primary" data-act="modal-close">Start building</button><button class="btn" data-act="about">Methodology & sources</button></div>`);
  }
  function about() {
    const sp = Object.values(C.SPANS).map(s => `<tr><td>${s.label}</td><td>${fmt(s.perM * 1000)}/km${s.perMHeight ? ' + height' : ''}</td></tr>`).join('');
    modal(`<h2>How the costs work</h2>
      <p>All figures are rough 2026 Canadian dollars for a lean, experienced builder, calibrated to the <a href="https://transitcosts.com/final-report/" target="_blank">Transit Costs Project</a> low-cost cases (Italy, Istanbul, Spain, Nordics: roughly US$120–200 M per km of underground metro including stations), not to recent Ontario projects.</p>
      <table class="costs">${sp}<tr><td>Portal (tunnel ↔ surface)</td><td>${fmt(C.PORTAL)} each</td></tr></table>
      <ul>
        <li><b>Tunnels</b> get dearer with depth; the vertical profile is computed against real terrain with grade limits (3.5 % metro, 4.5 % light metro, 6 % LRT). A tunnel that would break into a valley is flagged.</li>
        <li><b>Stations</b>: underground boxes are priced by excavated volume (≈$800/m³) × a construction factor for what is above them (acquired land ×1.0, open land ×1.15, roads ×1.3, buildings ×2.3 – mined) × a downtown premium, plus fit-out, finishes (×0.7 … ×3.2 for design ambition).</li>
        <li><b>Exits</b>: each entrance costs its vertical circulation (more for deeper stations) plus its share of passage tunnel (≈$38k/m underground); branches share tunnel.</li>
        <li><b>Land</b> uses a modelled land-value surface (≈$45k/m² in the Financial District, ≈$2k/m² in outer Scarborough), building floor area from OpenStreetMap, demolition and Expropriations Act disturbance damages. City, TTC and GO lots and parks are negotiated at no cost (restoration only).</li>
        <li><b>Surface, cut-and-cover and elevated</b> alignments automatically expropriate buildings in their path.</li>
        <li><b>Connections</b> to existing stations scale with how built-up the surroundings are, how much open space there is to dig from, land value, whether the station is busy (Line 1/2 downtown, Union), and rail-level conflicts – plus the passage length. Stations still under construction are 30 % cheaper to tie into.</li>
        <li>Systems, trains, yard, 14 % design/management and 15 % contingency are added.</li>
      </ul>
      <h3>Data</h3>
      <ul class="small">
        <li>Existing network: © OpenStreetMap contributors (ODbL), fetched once by <code>tools/build_transit.py</code>. Lines under construction (dashed: Ontario Line, Scarborough, Eglinton West and Yonge North extensions, Hurontario LRT) come from OSM construction mapping; the Yonge North alignment is approximate.</li>
        <li>Population density: Statistics Canada 2021 Census, 8,508 dissemination areas across Toronto, Peel, York, Durham and Halton (Statistics Canada Open Licence).</li>
        <li>Land survey: buildings (with heights), parks, land use, roads, rail and water from OpenStreetMap via OpenFreeMap vector tiles; every parking lot in Toronto from the City's topographic mapping, with City-owned lots from the Green P dataset (City of Toronto Open Data). Lots outside Toronto aren't covered.</li>
        <li>Terrain: AWS Terrain Tiles (Mapzen / USGS / NRCan). Basemap: OpenFreeMap.</li>
      </ul>
      <div class="btns"><button class="btn primary" data-act="modal-close">Close</button></div>`);
  }

  TB.ui = { init, update, updateToolbar, toast, help, about, startDrawing, newLine, densityReadout, menu, closeMenu, costFloat, flash, applyFix, legendLine };
})();
