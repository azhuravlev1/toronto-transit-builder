#!/usr/bin/env python3
"""Build data/construction.js – rapid-transit lines under construction (Nov 2026), drawn dashed.

Track comes from OpenStreetMap ways tagged railway=construction (one track kept where both are
mapped); stations from construction-tagged OSM features, or from road intersections where OSM has
none yet. The Yonge North Subway Extension isn't mapped in OSM, so its alignment is approximated
through its stations (flagged `approx`).

Run:  python3 tools/build_construction.py      (standard library only)
"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from build_transit import overpass, dist_m, simplify, grade_of, point_seg_dist  # noqa: E402

BBOX = "43.45,-79.85,43.95,-79.15"

# id, name, mode, colour, opening, OSM way name, extends existing line, tunnel-station depth (m)
PROJECTS = [
    dict(id="OL", name="Line 3 Ontario", short="Ontario Line", mode="subway", color="#7C55C7", opening="≈2031",
         way="Ontario Line", depth=25),
    dict(id="SSE", name="Line 2 Scarborough Subway Extension", short="Scarborough Subway Ext.", mode="subway", color="#00923F",
         opening="≈2030", way="Line 2 Bloor-Danforth", extends="L2", from_station="Kennedy", depth=30,
         stations=[("Lawrence-McCowan", "McCowan Road", "Lawrence Avenue East"),
                   ("Scarborough Centre", "McCowan Road", "Ellesmere Road"),
                   ("Sheppard-McCowan", "McCowan Road", "Sheppard Avenue East")]),
    dict(id="ECWE", name="Line 5 Eglinton West Extension", short="Eglinton West Ext.", mode="lrt", color="#FF8000",
         opening="≈2031", way="Eglinton LRT West Extension", extends="L5", from_station="Mount Dennis", depth=18,
         stations=[("Jane", "Eglinton Avenue West", "Jane Street"),
                   ("Scarlett", "Eglinton Avenue West", "Scarlett Road"),
                   ("Royal York", "Eglinton Avenue West", "Royal York Road"),
                   ("Islington", "Eglinton Avenue West", "Islington Avenue"),
                   ("Kipling", "Eglinton Avenue West", "Kipling Avenue"),
                   ("Martin Grove", "Eglinton Avenue West", "Martin Grove Road"),
                   ("Renforth", "Eglinton Avenue West", "Renforth Drive")],
         elevated=["Jane", "Scarlett"], surface=["Renforth"]),
    dict(id="YNSE", name="Line 1 Yonge North Subway Extension", short="Yonge North Ext.", mode="subway", color="#F8C300",
         opening="≈2032", way=None, extends="L1", from_station="Finch", depth=20, approx=True,
         stations=[("Steeles", "Yonge Street", "^Steeles Avenue"),
                   ("Clark", "Yonge Street", "^Clark Avenue"),
                   ("Royal Orchard", "Yonge Street", "Royal Orchard Boulevard"),
                   ("Bridge", "Yonge Street", "^Highway 7"),
                   ("High Tech", "Yonge Street", "High Tech Road")],
         surface=["Bridge", "High Tech"]),
    dict(id="HU", name="Hazel McCallion Line (Hurontario LRT)", short="Hurontario LRT", mode="lrt", color="#00A3AD",
         opening="≈2028", way="Hurontario LRT", depth=0, color_note="provisional colour"),
]


def dedupe_tracks(ways, tol=30):
    """Keep one of two parallel tracks: drop ways that mostly run within `tol` m of kept ones."""
    kept = []
    for w in sorted(ways, key=lambda w: -sum(dist_m(a, b) for a, b in zip(w["c"], w["c"][1:]))):
        pts = w["c"]
        near = sum(1 for p in pts if any(min(point_seg_dist(p, a, b) for a, b in zip(k["c"], k["c"][1:])) < tol for k in kept))
        if not kept or near / len(pts) < 0.5:
            kept.append(w)
    return kept


def main():
    names = [p["way"] for p in PROJECTS if p["way"]]
    q = "[out:json][timeout:240];(" + "".join(
        f'way["railway"="construction"]["name"="{n}"]({BBOX});' for n in names) + ");out geom;"
    data = overpass(q)
    by_name = {}
    for e in data["elements"]:
        t = e.get("tags", {})
        if t.get("service") in ("yard", "spur", "siding") and t.get("name") != "Line 2 Bloor-Danforth":
            continue
        by_name.setdefault(t.get("name"), []).append({"c": [(p["lon"], p["lat"]) for p in e["geometry"]], "g": grade_of(t)})

    # construction-tagged stations near each project's track
    # (bbox query + distance filter here; Overpass "around" proved unreliable under load)
    st = overpass(f'[out:json][timeout:180];(nwr["construction:railway"="station"]["name"]({BBOX});'
                  f'nwr["railway"="construction"]["construction"="station"]["name"]({BBOX}););out center tags;')
    osm_st = {}
    for n in (p["way"] for p in PROJECTS if p["way"] and not p.get("stations")):
        track = [w["c"] for w in by_name.get(n, [])]
        for e in st["elements"]:
            c = e.get("center", e)
            pt = (c["lon"], c["lat"])
            if min(point_seg_dist(pt, a, b) for t in track for a, b in zip(t, t[1:])) > 250:
                continue
            nm = e["tags"]["name"].replace(" Station", "").replace(" LRT", "").strip()
            osm_st.setdefault(n, {}).setdefault(nm, (round(pt[0], 5), round(pt[1], 5)))

    # road intersections for stations OSM doesn't have yet
    iq = "[out:json][timeout:240];"
    for p in PROJECTS:
        for nm, a, b in p.get("stations", []):
            fa = f'["name"~"{a}"]' if a.startswith("^") else f'["name"="{a}"]'
            fb = f'["name"~"{b}"]' if b.startswith("^") else f'["name"="{b}"]'
            iq += f'way["highway"]{fa}({BBOX})->.a;way["highway"]{fb}({BBOX})->.b;node(w.a)(w.b)->.n;make marker k="{p["id"]}|{nm}";out;.n out;'
    inter, cur = {}, None
    for e in overpass(iq)["elements"]:
        if e["type"] == "marker":
            cur = e["tags"]["k"]; continue
        inter.setdefault(cur, []).append((e["lon"], e["lat"]))

    existing = {}
    tsrc = open(os.path.join(os.path.dirname(__file__), "..", "data", "transit.js")).read()
    for l in json.loads(tsrc[tsrc.index("["): tsrc.rindex("]") + 1]):
        for s in l["stations"]:
            existing[(l["id"], s["name"])] = (s["lon"], s["lat"])

    out = []
    for p in PROJECTS:
        ways = dedupe_tracks(by_name.get(p["way"], [])) if p["way"] else []
        segs = [[[round(x, 5), round(y, 5)] for x, y in simplify(w["c"], 15)] for w in ways]
        grades = [w["g"] for w in ways]
        stations = []
        if p.get("stations"):
            for nm, _, _ in p["stations"]:
                pts = inter.get(f'{p["id"]}|{nm}')
                if not pts:
                    print(f"  !! no intersection for {p['id']} {nm}", file=sys.stderr); continue
                x = sum(q[0] for q in pts) / len(pts); y = sum(q[1] for q in pts) / len(pts)
                stations.append({"name": nm, "lon": x, "lat": y})
        else:
            for nm, (x, y) in osm_st.get(p["way"], {}).items():
                stations.append({"name": nm, "lon": x, "lat": y})
        # snap stations onto the track
        for s in stations:
            best, bp = 1e9, None
            for si, seg in enumerate(segs):
                for a, b in zip(seg, seg[1:]):
                    d = point_seg_dist((s["lon"], s["lat"]), a, b)
                    if d < best:
                        best = d
                        s["_grade"] = grades[si]
                        k = math.cos(math.radians(s["lat"]))
                        dx, dy = (b[0] - a[0]) * k, b[1] - a[1]
                        L = dx * dx + dy * dy
                        t = 0 if L == 0 else max(0, min(1, (((s["lon"] - a[0]) * k) * dx + (s["lat"] - a[1]) * dy) / L))
                        bp = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
            if bp and best < 600:
                s["lon"], s["lat"] = bp
            s["lon"], s["lat"] = round(s["lon"], 5), round(s["lat"], 5)
            s["_off"] = best
        # stations OSM track doesn't reach (or no track at all): connect them in order
        if p.get("extends"):
            start = existing.get((p["extends"], p["from_station"]))
            chain = [start] + [(s["lon"], s["lat"]) for s in stations]
            if not segs:
                segs = [[[round(x, 5), round(y, 5)] for x, y in chain]]; grades = ["tunnel"]
            else:  # bridge small gaps between the mapped track and the terminal / stations
                verts = [q for seg in segs for q in seg]
                for q in chain:
                    near = min(verts, key=lambda v: dist_m(q, v))
                    if dist_m(q, near) > 40:
                        segs.append([[round(near[0], 5), round(near[1], 5)], [round(q[0], 5), round(q[1], 5)]]); grades.append("tunnel")
        for s in stations:
            g = s.pop("_grade", "tunnel") if p["way"] else "tunnel"
            if p["id"] == "HU": g = "surface"
            if s["name"] in p.get("elevated", []): g = "bridge"
            if s["name"] in p.get("surface", []): g = "surface"
            s["grade"] = g
            s.pop("_off", None)
        entry = {"id": p["id"], "name": p["name"], "short": p["short"], "kind": "construction", "mode": p["mode"], "color": p["color"],
                 "opening": p["opening"], "extends": p.get("extends"), "depth": p["depth"], "segments": segs, "grades": grades,
                 "stations": stations}
        if p.get("approx"): entry["approx"] = True
        if p.get("color_note"): entry["colorNote"] = p["color_note"]
        out.append(entry)
        km = sum(dist_m(a, b) for seg in segs for a, b in zip(seg, seg[1:])) / 1000
        print(f"  {p['id']}: {len(segs)} segments, {km:.1f} km, {len(stations)} stations: {', '.join(s['name'] for s in stations)}")

    path = os.path.join(os.path.dirname(__file__), "..", "data", "construction.js")
    with open(path, "w") as f:
        f.write("// Generated by tools/build_construction.py – lines under construction (© OpenStreetMap contributors, ODbL)\n")
        f.write("window.CONSTRUCTION = ")
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("Wrote", path)


if __name__ == "__main__":
    main()
