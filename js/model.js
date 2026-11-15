// Project state, undo/redo, autosave, import/export and share links.
(function () {
  const KEY = 'tb.project.v1';
  const PALETTE = ['#E4007C', '#1F6FD1', '#00A6A6', '#7B3FB8', '#D84315', '#2E7D32', '#5D4037', '#C2185B', '#0097A7', '#AFB42B'];
  const listeners = { change: [], live: [] };
  let undoStack = [], redoStack = [], pending = null;

  const uid = () => Math.random().toString(36).slice(2, 9);
  const empty = () => ({ v: 1, name: 'My Toronto network', lines: [], parcels: {}, budget: 20e9 });

  const M = {
    project: empty(),
    uid,
    on(ev, f) { listeners[ev].push(f); },
    emit(ev, info) { for (const f of listeners[ev]) f(info); },

    snapshot: () => JSON.stringify(M.project),
    change(fn, info) {
      const snap = M.snapshot();
      fn(M.project);
      if (M.snapshot() === snap) return;
      undoStack.push(snap); if (undoStack.length > 150) undoStack.shift();
      redoStack = [];
      M.save(); M.emit('change', info);
    },
    // for drags: begin → many live updates → end
    begin() { pending = M.snapshot(); },
    live(info) { M.emit('live', info); },
    end(info) {
      if (pending && pending !== M.snapshot()) { undoStack.push(pending); redoStack = []; }
      pending = null; M.save(); M.emit('change', info);
    },
    undo() { if (!undoStack.length) return; redoStack.push(M.snapshot()); M.project = JSON.parse(undoStack.pop()); M.save(); M.emit('change', { undo: true }); },
    redo() { if (!redoStack.length) return; undoStack.push(M.snapshot()); M.project = JSON.parse(redoStack.pop()); M.save(); M.emit('change', { undo: true }); },
    canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,

    save() { try { localStorage.setItem(KEY, M.snapshot()); } catch (e) { console.warn('save failed', e); } },
    load() {
      try { const s = localStorage.getItem(KEY); if (s) M.project = Object.assign(empty(), JSON.parse(s)); } catch (e) { console.warn(e); }
    },
    replace(p, keepUndo = true) {
      if (keepUndo) undoStack.push(M.snapshot());
      M.project = Object.assign(empty(), p); M.save(); M.emit('change', { replaced: true });
    },
    reset() { M.replace(empty()); },

    // ---- helpers -----------------------------------------------------------------------
    line: (id) => M.project.lines.find(l => l.id === id),
    findNode(nodeId) {
      for (const l of M.project.lines) { const i = l.nodes.findIndex(n => n.id === nodeId); if (i >= 0) return { line: l, node: l.nodes[i], index: i }; }
      return null;
    },
    newLine() {
      const used = new Set(M.project.lines.map(l => l.color));
      const color = PALETTE.find(c => !used.has(c)) || PALETTE[M.project.lines.length % PALETTE.length];
      let n = 7; while (M.project.lines.some(l => l.name === 'Line ' + n)) n++;
      return { id: uid(), name: 'Line ' + n, color, mode: 'metro', visible: true, nodes: [] };
    },
    newNode(kind, lat, lon, line) {
      const n = { id: uid(), kind, lat, lon, out: { type: line.mode === 'lrt' ? 'street' : 'bored' } };
      if (kind === 'station') Object.assign(n, { name: 'Station ' + (line.nodes.filter(x => x.kind === 'station').length + 1), autoName: true, style: 'standard', exits: [], connect: [] });
      return n;
    },
    stationParcels: (nodeId) => Object.values(M.project.parcels).filter(p => p.nodeId === nodeId),

    // ---- files & links -----------------------------------------------------------------
    exportFile() {
      const blob = new Blob([JSON.stringify(M.project, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (M.project.name || 'network').replace(/[^\w-]+/g, '_') + '.json';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    async importFile(file) { const p = JSON.parse(await file.text()); if (!Array.isArray(p.lines)) throw new Error('Not a Transit Builder file'); M.replace(p); },
    async shareLink() {
      const json = new TextEncoder().encode(M.snapshot());
      let b;
      if (window.CompressionStream) {
        const s = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        b = 'z' + b64(new Uint8Array(await new Response(s).arrayBuffer()));
      } else b = 'j' + b64(json);
      return location.origin + location.pathname + '#p=' + b;
    },
    async fromHash() {
      const m = location.hash.match(/#p=([zj])(.+)$/);
      if (!m) return false;
      let bytes = unb64(m[2]);
      if (m[1] === 'z') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      const p = JSON.parse(new TextDecoder().decode(bytes));
      try { localStorage.setItem(KEY + '.backup', M.snapshot()); } catch (e) { /* ignore */ }
      M.project = Object.assign(empty(), p); M.save();
      history.replaceState(null, '', location.pathname);
      return true;
    },
  };

  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64(s) { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  TB.model = M;
})();
