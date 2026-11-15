# Toronto Transit Builder

A browser game / design tool for drawing fantasy rapid-transit lines in Toronto on top of the
real TTC, GO and UP network – with real terrain, 2021 Census population density and a land survey
of every building and parking lot – and seeing what they would cost if built by a lean, world-class
team.

**Play:** open `index.html` (works from `file://`) or the GitHub Pages site.

## Features

- **Existing network**: TTC Lines 1–6 plus GO / UP in a light diagram style. Line 6 and the at-grade
  sections of Line 5 east of Laird are drawn thinner, because they share streets with traffic.
- **Draw lines** like Google Maps' measuring tool: click to drop stations, with the track length shown
  between each pair. Shift-click adds bend points. Drag stations, bend points, or the hollow dots
  mid-span to bend the track (smoothed curves, straight platforms).
- **Construction type per span**: bored tunnel, cut-and-cover, open trench, at-grade, street median,
  existing rail corridor, elevated, new bridge, existing bridge. Portals are added where the line
  changes level.
- **Vertical profile** against real terrain (AWS Terrain Tiles). Grade limits, tunnel cover under
  valleys (the Don!), bridge heights.
- **True-scale station boxes** (semi-transparent), with depth, platform length, width and design
  ambition (utilitarian to iconic), plus multiple **exits** with passage lengths.
- **Land acquisition**: click parking lots, parks and buildings to buy them as dig sites. City-owned
  Green P and TTC lots are free; downtown towers are not. Digging from acquired land makes the
  station cheaper (open excavation instead of mining under buildings), and a staging site saves
  more.
- **Connections** to existing stations, costed by how built-up and busy the location is (College on
  Line 1 is extreme; a parking lot next to Line 5 in Scarborough is easy), and by rail-level
  conflicts.
- **Interchanges between your own lines**: cross-platform, stacked, or connected by a passage, with
  space and level checks.
- **Population density** toggle (2021 Census, 8,508 dissemination areas across the GTA), plus catchment
  stats: residents within 800 m, and residents *newly* served by rapid transit.
- Budget, cost per km against real benchmarks, run time, fleet size, autosave, undo/redo, JSON
  export/import and share links.

## Cost model

Rough 2026 CAD, calibrated to the [Transit Costs Project](https://transitcosts.com/final-report/)
low-cost cases (Italy, Istanbul, Spain, Nordics), not recent Ontario projects. All constants are in
`js/costs.js`; the full method is under ⋯ → *Methodology & sources* in the app.

## Data (rebuild with the scripts in `tools/`)

| File | Source | Script |
|---|---|---|
| `data/transit.js` | OpenStreetMap route relations via Overpass (ODbL) | `python3 tools/build_transit.py` |
| `data/population.js` | Statistics Canada 2021 Census: DA boundaries (geo.statcan.gc.ca) + counts (Esri Canada mirror) | `python3 tools/build_population.py` |
| `data/greenp.js` | City of Toronto Open Data – Green P Parking | `python3 tools/build_greenp.py` |
| `data/parking/*.js` | City of Toronto Open Data – Topographic Mapping, parking lots | `python3 tools/build_parking.py` (needs `pyshp`) |

Loaded live at runtime: the OpenFreeMap basemap and OSM vector tiles (buildings, parks, land use, roads
and water for the land survey), and AWS Terrain Tiles (elevation).

## Development

No build step. Serve the folder with any static server, e.g. `python3 -m http.server`, then open
<http://localhost:8000>.
