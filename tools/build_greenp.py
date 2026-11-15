#!/usr/bin/env python3
"""Build data/greenp.js – City of Toronto (Toronto Parking Authority) Green P car parks.
These are municipally owned, so the game treats them as negotiable at (almost) no land cost.
Source: City of Toronto Open Data, "Green P Parking" (Open Government Licence – Toronto).
"""
import json, os, urllib.request

PKG = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=green-p-parking"


def main():
    with urllib.request.urlopen(PKG, timeout=60) as r:
        res = json.load(r)["result"]["resources"]
    url = sorted((x for x in res if x["format"].upper() == "JSON"), key=lambda x: x["name"])[-1]["url"]
    with urllib.request.urlopen(url, timeout=120) as r:
        carparks = json.load(r)["carparks"]
    out = [{"lat": round(float(c["lat"]), 6), "lon": round(float(c["lng"]), 6), "address": c["address"],
            "type": c.get("carpark_type", ""), "capacity": int(c.get("capacity") or 0), "ttc": bool(c.get("is_ttc"))}
           for c in carparks if c.get("lat") and c.get("lng")]
    path = os.path.join(os.path.dirname(__file__), "..", "data", "greenp.js")
    with open(path, "w") as f:
        f.write("// Green P car parks – City of Toronto Open Data (Open Government Licence – Toronto)\n")
        f.write("window.GREENP = ")
        json.dump(out, f, separators=(",", ":"))
        f.write(";\n")
    print(f"Wrote {path}: {len(out)} car parks")


if __name__ == "__main__":
    main()
