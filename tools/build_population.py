#!/usr/bin/env python3
"""Build data/population.js – 2021 Census population density by Dissemination Area
(the finest geography for which Statistics Canada publishes population counts with
boundaries; ~400–700 residents each, i.e. a few city blocks downtown).

Sources
  * Boundaries: Statistics Canada 2021 cartographic boundary file (shoreline-clipped DAs),
    served from geo.statcan.gc.ca ArcGIS REST.
  * Counts:     Statistics Canada 2021 Census population & land area per DA, as republished
    by Esri Canada ("Stats Canada 2021 Population And Dwelling" feature service).
    (www12.statcan.gc.ca blocks scripted downloads, so the REST mirrors are used.)

Covers Toronto, Peel, York, Durham and Halton (CD 3520, 3521, 3519, 3518, 3524).
Only the standard library is needed.
"""
import json, os, sys, time, urllib.parse, urllib.request

GEOM = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/12/query"
POP = ("https://services.arcgis.com/wjcPoefzjpzCgffS/arcgis/rest/services/"
       "Stats_Canada_2021_Population_And_Dwelling/FeatureServer/3/query")
CDS = ["3520", "3521", "3519", "3518", "3524"]
UA = "Mozilla/5.0 (TorontoTransitBuilder data build)"
SCALE = 1e5            # 5 decimals ≈ 1 m
SIMPLIFY_DEG = 0.00003  # ≈ 3 m generalisation


def get(url, params):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:
            print(f"  retry ({e})", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    raise SystemExit("request failed: " + url)


def paged(url, where, fields, geometry):
    out, offset = [], 0
    while True:
        params = {"where": where, "outFields": fields, "f": "json", "resultOffset": offset,
                  "resultRecordCount": 1000, "orderByFields": "DAUID",
                  "returnGeometry": "true" if geometry else "false"}
        if geometry:
            params.update(outSR=4326, geometryPrecision=5, maxAllowableOffset=SIMPLIFY_DEG)
        d = get(url, params)
        feats = d.get("features", [])
        out += feats
        offset += len(feats)
        if not feats or not d.get("exceededTransferLimit"):
            return out


def encode_ring(ring):
    """Flat delta-encoded integer ring: [x0, y0, dx1, dy1, ...] at 1e-5 degrees."""
    flat, px, py = [], 0, 0
    pts = [(round(x * SCALE), round(y * SCALE)) for x, y in ring]
    dedup = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
    if len(dedup) < 4:
        return None
    for x, y in dedup[:-1]:  # closing point implied
        flat += [x - px, y - py]
        px, py = x, y
    return flat


def main():
    pops = {}
    for cd in CDS:
        print(f"Counts for CD {cd}…")
        for f in paged(POP, f"DAUID LIKE '{cd}%'", "DAUID,Population2021,LandAreaSqKm2021,PopPerSqKm2021", False):
            a = f["attributes"]
            pops[a["DAUID"]] = a
    print(f"  {len(pops)} DAs with counts")

    features, total = [], 0
    for cd in CDS:
        print(f"Boundaries for CD {cd}…")
        for f in paged(GEOM, f"DAUID LIKE '{cd}%'", "DAUID,LANDAREA", True):
            uid = f["attributes"]["DAUID"]
            a = pops.get(uid)
            if not a or "geometry" not in f:
                continue
            rings = [r for r in (encode_ring(r) for r in f["geometry"]["rings"]) if r]
            if not rings:
                continue
            pop = a["Population2021"] or 0
            area = a["LandAreaSqKm2021"] or f["attributes"]["LANDAREA"] or 0
            dens = round(pop / area) if area else 0
            total += pop
            features.append([uid, pop, dens, round(area, 4), rings])
    print(f"  {len(features)} polygons, population {total:,}")

    path = os.path.join(os.path.dirname(__file__), "..", "data", "population.js")
    with open(path, "w") as fh:
        fh.write("// 2021 Census population by Dissemination Area. Source: Statistics Canada "
                 "(boundaries: 2021 cartographic boundary file; counts: 2021 Census, via Esri Canada). "
                 "Statistics Canada Open Licence.\n")
        fh.write("// Feature: [DAUID, population, people per km², land km², rings (delta-encoded 1e-5°)]\n")
        fh.write("window.POPULATION = ")
        json.dump({"year": 2021, "scale": SCALE, "features": features}, fh, separators=(",", ":"))
        fh.write(";\n")
    print(f"Wrote {path} ({os.path.getsize(path) // 1024} KB)")


if __name__ == "__main__":
    main()
