// Cost model – 2026 Canadian dollars, assuming a lean, experienced builder (Transit Costs
// Project "low-cost" benchmarks: Italy / Istanbul / Spain / Nordics ≈ US$120–200 M per km of
// underground metro incl. stations) rather than recent Ontario practice (C$1 B+/km).
(function () {
  const G = TB.geo;
  const M = 1e6;

  // Station box widths: island platform (one platform between the tracks) vs side platforms
  // (tracks in the middle). A box at least `thr` wide is laid out with side platforms.
  const MODES = {
    metro: { label: 'Metro (heavy rail)', platform: 150, grade: 0.035, vmax: 90,
      layout: { under: { island: 20, side: 26, thr: 23 }, surface: { island: 14, side: 18, thr: 16 }, above: { island: 18, side: 22, thr: 20 } },
      minR: 250, hardR: 150, systemsKm: 16 * M, trainPerM: 0.17 * M, headway: 180, yard: 220 * M, row: 12, lineW: 1 },
    lightmetro: { label: 'Light metro (automated)', platform: 100, grade: 0.045, vmax: 80,
      layout: { under: { island: 17, side: 22, thr: 20 }, surface: { island: 12, side: 16, thr: 14 }, above: { island: 15, side: 19, thr: 17 } },
      minR: 150, hardR: 100, systemsKm: 13 * M, trainPerM: 0.19 * M, headway: 120, yard: 160 * M, row: 10, lineW: 0.85 },
    lrt: { label: 'Light rail (LRT)', platform: 90, grade: 0.06, vmax: 70,
      layout: { under: { island: 15, side: 19, thr: 17 }, surface: { island: 12, side: 15, thr: 13.5 }, above: { island: 13, side: 17, thr: 15 } },
      minR: 50, hardR: 25, systemsKm: 9 * M, trainPerM: 0.22 * M, headway: 300, yard: 120 * M, row: 8, lineW: 0.7 },
  };
  const ROT_MAX = 20; // degrees a station may be rotated off the natural track direction

  // family: under | cut | surface | above | bridge
  const SPANS = {
    bored: { label: 'Bored tunnel (TBM)', family: 'under', perM: 95e3, rel: -18, desc: 'Twin-bore or single large-bore tunnel, ~18 m deep. No surface disruption.' },
    cutcover: { label: 'Cut-and-cover tunnel', family: 'under', perM: 68e3, rel: -9, desc: 'Shallow box dug from the surface – cheaper, but needs a clear corridor (roads, open land).' },
    trench: { label: 'Open trench', family: 'cut', perM: 40e3, rel: -7, desc: 'Retained cut below street level, open to the sky.' },
    atgrade: { label: 'At-grade (own right-of-way)', family: 'surface', perM: 20e3, rel: 0, desc: 'Fenced surface track with level crossings or grade-separated roads.' },
    street: { label: 'Street median (shared road)', family: 'surface', perM: 24e3, rel: 0, desc: 'Reclaims road lanes for a median LRT. Road reconstruction included, no land needed.' },
    rail: { label: 'Existing rail corridor', family: 'surface', perM: 14e3, rel: 0, desc: 'Adds tracks inside an existing rail corridor (negotiated access).' },
    elevated: { label: 'Elevated viaduct', family: 'above', perM: 48e3, rel: 9, desc: 'Precast guideway on columns, ~9 m up.' },
    bridge: { label: 'New bridge', family: 'bridge', perM: 25e3, perMHeight: 1300, rel: null, desc: 'Long-span crossing of a valley or river. Cost grows with height.' },
    oldbridge: { label: 'Existing bridge (retrofit)', family: 'bridge', perM: 12e3, rel: null, desc: 'Re-uses an existing bridge deck (like Line 2 on the Prince Edward Viaduct).' },
  };
  const PORTAL = 22 * M;

  const STYLES = {
    utilitarian: { label: 'Utilitarian', mult: 0.7, desc: 'Bare concrete, minimal finishes' },
    standard: { label: 'Standard', mult: 1, desc: 'Durable tiles, good lighting' },
    architectural: { label: 'Architectural', mult: 1.8, desc: 'Daylight, feature ceilings, art' },
    iconic: { label: 'Iconic', mult: 3.2, desc: 'A landmark – think Stockholm or Moscow' },
  };

  // What sits on the surface above a station box → construction-method multiplier
  const SITE = {
    acquired: { f: 1.0, label: 'Acquired site (open excavation)', color: '#2e9d57' },
    vacant: { f: 1.05, label: 'Vacant land', color: '#9ccc65' },
    open: { f: 1.15, label: 'Open land', color: '#c5e1a5' },
    parking: { f: 1.25, label: 'Parking lot (not acquired)', color: '#ffd54f' },
    park: { f: 1.25, label: 'Park (not acquired)', color: '#81c784' },
    road: { f: 1.3, label: 'Road (decked excavation under traffic)', color: '#90a4ae' },
    school: { f: 1.45, label: 'School grounds', color: '#ce93d8' },
    raillands: { f: 1.6, label: 'Rail lands', color: '#8d6e63' },
    rail: { f: 1.8, label: 'Operating railway', color: '#6d4c41' },
    building: { f: 2.3, label: 'Under buildings (mined + underpinning)', color: '#e57373' },
    hospital: { f: 2.3, label: 'Hospital', color: '#e57373' },
    water: { f: 2.6, label: 'Water', color: '#4fc3f7' },
    cemetery: { f: 3.0, label: 'Cemetery', color: '#757575' },
    unknown: { f: 1.3, label: 'Not surveyed yet', color: '#cfd8dc' },
  };

  // ---- land value model ($ per m² of land) -----------------------------------------------
  const PEAKS = [
    [43.6487, -79.3817, 42000, 1.3],  // Financial District
    [43.6700, -79.3900, 14000, 1.1],  // Bloor–Yorkville
    [43.7066, -79.3984, 11000, 0.9],  // Yonge–Eglinton
    [43.7680, -79.4128, 8000, 1.0],   // North York Centre
    [43.7754, -79.2578, 3500, 1.0],   // Scarborough Centre
    [43.5932, -79.6420, 6000, 1.2],   // Mississauga City Centre
    [43.7942, -79.5273, 3500, 1.0],   // Vaughan Metropolitan Centre
    [43.6452, -79.4233, 6000, 1.0],   // Liberty Village / King West
  ];
  function landValue(lat, lon) {
    const d0 = G.dist([lat, lon], [43.6487, -79.3817]) / 1000;
    let v = 1100 + 14000 * Math.exp(-d0 / 4.5);
    for (const [a, b, A, r] of PEAKS) v += A * Math.exp(-G.dist([lat, lon], [a, b]) / 1000 / r);
    return v;
  }

  const DEF_LEVELS = { house: 2, apartments: 6, commercial: 2, industrial: 1, worship: 1, institution: 3, garage: 3, transit: 1 };
  const BLDG_VAL = { house: 2800, apartments: 3800, commercial: 3200, industrial: 1100, worship: 2500, institution: 3500, garage: 1200, transit: 1500 };

  // f: {cat, sub, area, levels, public, heritage, greenp}; lat/lon of the parcel
  function parcelCost(f, lat, lon) {
    const lv = landValue(lat, lon), A = f.area;
    const r = { total: 0, land: 0, building: 0, demolition: 0, notes: [], feasible: true, label: '' };
    switch (f.cat) {
      case 'building': {
        let lev = f.levels || DEF_LEVELS[f.sub] || 2;
        if (!f.levels && f.sub === 'commercial' && lv > 20000) lev = 8;
        const gfa = A * lev;
        r.land = A * 1.3 * lv;
        r.building = gfa * (BLDG_VAL[f.sub] || 3000);
        r.demolition = gfa * 180;
        let k = 1.15; // disturbance damages & relocation (Ontario Expropriations Act)
        if (f.heritage) { k *= 1.6; r.notes.push('Heritage-listed – extra approvals'); }
        if (f.sub === 'worship') { k *= 1.3; r.notes.push('Place of worship – community relocation'); }
        if (f.sub === 'institution') { k *= 2; r.notes.push('Public institution – must be rebuilt elsewhere'); }
        if (f.sub === 'apartments' && lev >= 4) r.notes.push(`~${Math.round(gfa / 85)} homes displaced`);
        r.land *= k; r.building *= k;
        r.label = `${({ house: 'House', apartments: 'Apartment building', commercial: 'Commercial building', industrial: 'Industrial building', worship: 'Place of worship', institution: 'Institution', garage: 'Parking garage', transit: 'Transit building' })[f.sub] || 'Building'} · ${lev} storey${lev > 1 ? 's' : ''}`;
        break;
      }
      case 'parking':
        if (f.public) {
          r.demolition = f.sub === 'garage' ? A * (f.levels || 3) * 220 : A * 120;
          r.notes.push(`${f.owner || (f.greenp ? 'Green P (City of Toronto)' : 'Publicly owned')}${f.greenp && !f.owner ? ' · ' + f.greenp : ''} – negotiated at no cost; restore afterwards`);
          r.label = f.sub === 'garage' ? 'Public parking garage' : f.owner && /GO/.test(f.owner) ? 'GO station parking' : 'Public parking lot';
        } else {
          r.land = A * lv * (f.sub === 'garage' ? 1.0 : 0.85) * 1.1;
          if (f.sub === 'garage') r.building = A * (f.levels || 3) * 1200;
          r.label = f.sub === 'garage' ? 'Private parking garage' : 'Private parking lot';
        }
        break;
      case 'park':
        if (f.public) { r.demolition = A * 220; r.notes.push('City parkland – temporary construction easement, replanted afterwards'); r.label = 'Public park'; }
        else { r.land = A * lv * 0.6; r.label = 'Private green space'; }
        break;
      case 'vacant': r.land = A * lv * 0.7; r.label = 'Vacant / brownfield land'; break;
      case 'school': r.land = A * lv * 0.35; r.notes.push('School board land – easement on part of the yard'); r.label = 'School grounds'; break;
      case 'raillands': r.land = A * lv * 0.5; r.notes.push('Rail lands – negotiated with the railway'); r.label = 'Rail lands'; break;
      default: r.feasible = false; r.label = ({ water: 'Water', cemetery: 'Cemetery', hospital: 'Hospital' })[f.cat] || f.cat; r.notes.push('Cannot be acquired');
    }
    r.total = r.land + r.building + r.demolition;
    return r;
  }

  const fmt = (v) => {
    const a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  };

  // exit passages ($/m) and the vertical part of an entrance, by station level
  const EXIT = {
    passage: { under: 38e3, above: 12e3, surface: 3e3 },
    portal: (level, depth) => level === 'under' ? 3.5e6 + 0.3e6 * Math.max(0, depth) : level === 'above' ? 2.5e6 : 0.4e6,
    junction: { under: 1.5e6, above: 0.3e6, surface: 0 },
  };

  TB.costs = {
    MODES, SPANS, STYLES, SITE, PORTAL, EXIT, ROT_MAX, landValue, parcelCost, fmt,
    SOFT: 0.14, CONTINGENCY: 0.15, DWELL: 30,
    BENCHMARKS: [
      { name: 'Efficient builders (Italy, Istanbul, Spain)', perKm: 250e6 },
      { name: 'Finch West LRT (≈C$2.5B, 11 km)', perKm: 230e6 },
      { name: 'Eglinton Crosstown (≈C$13B, 19 km)', perKm: 680e6 },
      { name: 'Scarborough Subway Ext. (≈C$5.5B, 7.8 km)', perKm: 700e6 },
      { name: 'Ontario Line (≈C$19B, 15.6 km)', perKm: 1220e6 },
    ],
  };
})();
