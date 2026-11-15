# Notes for agents

- Static site, no build step. Plain `<script>` files sharing the `window.TB` namespace (no ES modules,
  so it also works from `file://`). Load order is set in `index.html`.
- Serve locally: `python3 -m http.server 8765` from the repo root.
- Syntax check: `for f in js/*.js; do node --check "$f"; done`
- Headless testing: playwright-core with the system Chrome
  (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`). Pass
  `--use-angle=swiftshader --enable-unsafe-swiftshader` so the maplibre basemap gets WebGL.
  Don't return Leaflet objects from `page.evaluate` (serialising them breaks the context).
- Data scripts live in `tools/`. Python venv in `.venv` (`pyshp`, `shapely`, `pyproj`, `requests`).
  `build_parking.py` needs `pyshp`.
- Public Overpass servers are often slow or down. The app's land survey therefore uses OpenFreeMap
  vector tiles (`js/survey.js`, decoded by `js/mvt.js`) plus the pre-tiled City parking data, not
  Overpass.
- statcan www12 blocks scripted downloads; use the geo.statcan.gc.ca ArcGIS REST services instead.
