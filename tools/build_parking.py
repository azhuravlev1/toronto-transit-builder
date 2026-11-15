#!/usr/bin/env python3
"""Build data/parking/*.js – every surface parking lot in the City of Toronto, tiled for
on-demand loading, with City-owned (Green P / TTC commuter) lots flagged as public.

Source: City of Toronto Open Data, "Topographic Mapping – Physical area of parking lots"
(Open Government Licence – Toronto). Needs: pip install pyshp
Run:    python3 tools/build_parking.py
"""
import io, json, math, os, sys, urllib.request, zipfile
import shapefile  # pyshp

PKG = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=topographic-mapping-physical-area-of-parking-lots"
TILE = 0.02          # degrees; must match js/survey.js
SCALE = 1e5
ROOT = os.path.join(os.path.dirname(__file__), "..")


def ring_area_m2(ring):
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110574
    a = 0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return a / 2


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def near_ring(x, y, ring, metres):
    k = 111320 * math.cos(math.radians(y))
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        dx, dy = (x2 - x1) * k, (y2 - y1) * 110574
        px, py = (x - x1) * k, (y - y1) * 110574
        L = dx * dx + dy * dy
        t = 0 if L == 0 else max(0, min(1, (px * dx + py * dy) / L))
        if math.hypot(px - t * dx, py - t * dy) < metres:
            return True
    return False


def encode(ring):
    pts = [(round(x * SCALE), round(y * SCALE)) for x, y in ring]
    pts = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    out, px, py = [], 0, 0
    for x, y in pts:
        out += [x - px, y - py]; px, py = x, y
    return out


def main():
    with urllib.request.urlopen(PKG, timeout=60) as r:
        res = json.load(r)["result"]["resources"]
    url = next(x["url"] for x in res if x["format"].upper() == "SHP" and "4326" in x["name"])
    print("Downloading", url)
    with urllib.request.urlopen(url, timeout=600) as r:
        z = zipfile.ZipFile(io.BytesIO(r.read()))
    names = z.namelist()
    base = next(n[:-4] for n in names if n.endswith(".shp"))
    sf = shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")),
                          shx=io.BytesIO(z.read(base + ".shx")))

    sys.path.insert(0, ROOT)
    gp_txt = open(os.path.join(ROOT, "data", "greenp.js")).read()
    greenp = json.loads(gp_txt[gp_txt.index("["): gp_txt.rindex("]") + 1])

    tiles = {}
    n_pub = 0
    for shp in sf.iterShapes():
        parts = list(shp.parts) + [len(shp.points)]
        rings = [shp.points[parts[i]:parts[i + 1]] for i in range(len(parts) - 1)]
        rings = [[(p[0], p[1]) for p in r] for r in rings if len(r) >= 4]
        if not rings:
            continue
        area = abs(sum(ring_area_m2(r) for r in rings[:1])) - sum(abs(ring_area_m2(r)) for r in rings[1:])
        if area < 40:
            continue
        outer = rings[0]
        cx = sum(p[0] for p in outer) / len(outer); cy = sum(p[1] for p in outer) / len(outer)
        pub = 0
        for g in greenp:
            if abs(g["lat"] - cy) < 0.004 and abs(g["lon"] - cx) < 0.005:
                if point_in_ring(g["lon"], g["lat"], outer) or near_ring(g["lon"], g["lat"], outer, 25):
                    pub = 2 if g.get("ttc") else 1
                    break
        n_pub += pub > 0
        enc = [e for e in (encode(r) for r in rings) if e]
        if not enc:
            continue
        key = f"{math.floor(cy / TILE)}_{math.floor(cx / TILE)}"
        tiles.setdefault(key, []).append([pub, round(area), enc])

    out_dir = os.path.join(ROOT, "data", "parking")
    os.makedirs(out_dir, exist_ok=True)
    total = 0
    for key, feats in tiles.items():
        p = os.path.join(out_dir, key + ".js")
        with open(p, "w") as f:
            f.write(f'TB.parkingTile("{key}",')
            json.dump(feats, f, separators=(",", ":"))
            f.write(");\n")
        total += os.path.getsize(p)
    with open(os.path.join(out_dir, "index.js"), "w") as f:
        f.write("// City of Toronto parking lots (Open Government Licence – Toronto). Feature: [public(0/1 Green P/2 TTC), m², rings]\n")
        f.write("window.PARKING_TILES = " + json.dumps(sorted(tiles)) + ";\n")
    print(f"{sum(len(v) for v in tiles.values())} lots ({n_pub} public) in {len(tiles)} tiles, {total // 1024} KB")


if __name__ == "__main__":
    main()
