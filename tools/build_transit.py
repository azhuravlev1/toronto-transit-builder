#!/usr/bin/env python3
"""Fetch TTC rapid transit + GO/UP rail geometry from OpenStreetMap (Overpass)
and write a static data/transit.js (window.TRANSIT = [...]).

Run:  python3 tools/build_transit.py
Only the standard library is needed.
"""
import json, math, os, sys, time, urllib.parse, urllib.request

ENDPOINTS = ["https://overpass-api.de/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter"]
UA = "TorontoTransitBuilder/1.0 (static data build)"

LINES = [
    # osm_id, id, name, kind, colour
    (102388, "L1", "Line 1 Yonge–University", "subway", "#F8C300"),
    (102386, "L2", "Line 2 Bloor–Danforth", "subway", "#00923F"),
    (7871815, "L4", "Line 4 Sheppard", "subway", "#A21A68"),
    (6549497, "L5", "Line 5 Eglinton", "subway", "#FF8000"),
    (19931999, "L6", "Line 6 Finch West", "subway", "#969594"),
    (10094533, "LW", "GO Lakeshore West", "go", "#98002E"),
    (207770, "LE", "GO Lakeshore East", "go", "#EE3124"),
    (149440, "MI", "GO Milton", "go", "#F57F25"),
    (113816, "KI", "GO Kitchener", "go", "#00853F"),
    (148585, "BR", "GO Barrie", "go", "#003767"),
    (365949, "RH", "GO Richmond Hill", "go", "#0099C7"),
    (166145, "ST", "GO Stouffville", "go", "#794500"),
    (7641341, "UP", "UP Express", "go", "#5B2C86"),
]
GO_BBOX = (43.0, -80.8, 44.6, -78.6)


def overpass(query):
    last = None
    for ep in ENDPOINTS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(ep, data=urllib.parse.urlencode({"data": query}).encode(),
                                             headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=300) as r:
                    return json.load(r)
            except Exception as e:  # busy / rate limited -> retry, then next mirror
                last = e
                print(f"  {ep} failed ({e}); retrying", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
    raise SystemExit(f"Overpass unavailable: {last}")


def dist_m(a, b):
    """a, b = (lon, lat)"""
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320


def simplify(pts, min_d):
    if len(pts) < 3:
        return pts
    out = [pts[0]]
    for p in pts[1:-1]:
        if dist_m(out[-1], p) >= min_d:
            out.append(p)
    out.append(pts[-1])
    return out


def grade_of(tags):
    """Classify a way: 'tunnel', 'bridge' or 'surface'."""
    layer = tags.get("layer", "0")
    try:
        layer = float(layer.split(";")[0])
    except ValueError:
        layer = 0
    if tags.get("tunnel") in ("yes", "building_passage", "culvert") or tags.get("location") == "underground" or layer < 0:
        return "tunnel"
    if tags.get("bridge") not in (None, "no"):
        return "bridge"
    return "surface"


def chain(ways):
    """Join consecutive member ways into continuous runs that share a grade.
    ways: list of (coords[(lon,lat)], grade). Returns list of (coords, grade)."""
    ways = [(list(c), g) for c, g in ways if len(c) >= 2]
    near = lambda a, b: dist_m(a, b) < 1
    # orient every way so it continues from the previous one
    for i, (c, g) in enumerate(ways):
        if i == 0:
            if len(ways) > 1:
                n0, n1 = ways[1][0][0], ways[1][0][-1]
                if near(c[0], n0) or near(c[0], n1):
                    c.reverse()
        else:
            prev_end = ways[i - 1][0][-1]
            if not near(c[0], prev_end) and near(c[-1], prev_end):
                c.reverse()
    runs = []
    for i, (c, g) in enumerate(ways):
        if runs and near(runs[-1][0][-1], c[0]):
            if runs[-1][1] == g:
                runs[-1][0].extend(c[1:])
            else:
                runs.append((c, g))
        else:
            runs.append((c, g))
    return runs


def clean_name(n):
    n = n.split(";")[-1].strip()
    for suf in (" Subway Station", " Station", " Subway", " GO Centre", " Central Station", " GO"):
        if n.endswith(suf):
            n = n[: -len(suf)]
    if n.startswith("Toronto Union"):
        n = "Union"
    return n.strip()


def main():
    ids = ",".join(str(l[0]) for l in LINES)
    print("Fetching route relations…")
    data = overpass(f"[out:json][timeout:240];rel(id:{ids})->.r;.r out geom;way(r.r);out tags;node(r.r);out;")
    rels = {e["id"]: e for e in data["elements"] if e["type"] == "relation"}
    way_tags = {e["id"]: e.get("tags", {}) for e in data["elements"] if e["type"] == "way"}
    nodes = {e["id"]: e for e in data["elements"] if e["type"] == "node"}

    print("Fetching GO / UP stations…")
    s, w, n, e = GO_BBOX
    st = overpass(f"[out:json][timeout:180];(node[railway=station]({s},{w},{n},{e});way[railway=station]({s},{w},{n},{e}););out center tags;")
    go_stations = []
    for el in st["elements"]:
        t = el.get("tags", {})
        net = (t.get("network", "") + " " + t.get("operator", "")).lower()
        if "go" not in net.split() and "go transit" not in net and "up express" not in net and "metrolinx" not in net:
            continue
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if lat is None or not t.get("name"):
            continue
        go_stations.append({"name": clean_name(t["name"]), "lat": round(lat, 5), "lon": round(lon, 5)})

    out = []
    for osm_id, lid, name, kind, color in LINES:
        rel = rels.get(osm_id)
        if not rel:
            print(f"  !! relation {osm_id} ({name}) missing", file=sys.stderr)
            continue
        min_d = 15 if kind == "subway" else 40
        ways = []
        for m in rel["members"]:
            if m["type"] == "way" and m.get("role", "") in ("", "forward", "backward") and "geometry" in m:
                coords = [(p["lon"], p["lat"]) for p in m["geometry"]]
                ways.append((coords, grade_of(way_tags.get(m["ref"], {})) if kind == "subway" else "surface"))
        runs = chain(ways)
        segments, grades = [], []
        for coords, g in runs:
            pts = [[round(x, 5), round(y, 5)] for x, y in simplify(coords, min_d)]
            if len(pts) >= 2:
                segments.append(pts)
                grades.append(g)

        stations, seen = [], set()
        for m in rel["members"]:
            if m["type"] == "node" and m.get("role", "").startswith("stop") and m["ref"] in nodes:
                nd = nodes[m["ref"]]
                nm = clean_name(nd.get("tags", {}).get("name", ""))
                if nm and nm not in seen:
                    seen.add(nm)
                    stations.append({"name": nm, "lat": round(nd["lat"], 5), "lon": round(nd["lon"], 5)})

        if kind == "go":
            def near_track(lon, lat):
                best = 1e9
                for seg in segments:
                    for a, b in zip(seg, seg[1:]):
                        best = min(best, point_seg_dist((lon, lat), a, b))
                return best
            for gs in go_stations:
                if near_track(gs["lon"], gs["lat"]) > 120:
                    continue
                if any(x["name"] == gs["name"] or dist_m((gs["lon"], gs["lat"]), (x["lon"], x["lat"])) < 400
                       for x in stations):
                    continue
                stations.append(dict(gs))

        entry = {"id": lid, "name": name, "kind": kind, "color": color, "segments": segments, "stations": stations}
        if lid == "L5":
            # At-grade runs east of the Laird portal (Don valley + Eglinton East median) are drawn
            # thinner; the short grade-separated viaduct at Mount Dennis stays full width.
            entry["atGrade"] = [int(g != "tunnel" and sum(p[0] for p in s) / len(s) > -79.40)
                                for s, g in zip(segments, grades)]
        if kind == "subway":
            entry["grades"] = grades
        out.append(entry)
        print(f"  {lid}: {len(segments)} segments, {sum(len(s) for s in segments)} pts, {len(stations)} stations")

    os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data"), exist_ok=True)
    path = os.path.join(os.path.dirname(__file__), "..", "data", "transit.js")
    with open(path, "w") as f:
        f.write("// Generated by tools/build_transit.py from OpenStreetMap (© OpenStreetMap contributors, ODbL)\n")
        f.write("window.TRANSIT = ")
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"Wrote {path} ({os.path.getsize(path) // 1024} KB)")


def point_seg_dist(p, a, b):
    k = math.cos(math.radians(p[1]))
    px, py = p[0] * k * 111320, p[1] * 111320
    ax, ay = a[0] * k * 111320, a[1] * 111320
    bx, by = b[0] * k * 111320, b[1] * 111320
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


if __name__ == "__main__":
    main()
