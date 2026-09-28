# flagstop

Review a transit agency's GTFS feed against OpenStreetMap, route by route, and hand each fix to JOSM.

Nothing here uploads to OpenStreetMap. The tool compares, explains, and proposes; a person looks and decides.

## What it does

Given a GTFS feed and a box of OpenStreetMap data, flagstop

- **matches stops** — by `gtfs:stop_id` or `ref`, then by distance and name — and sorts every stop into *matched* (with a tag-by-tag diff), *ambiguous* (you pick), or *missing*, plus the OSM stops nobody in the feed claims;
- **routes every pattern over OSM's roads** the way a bus could drive them (`oneway`, `access`, `bus`/`psv` honoured), pulled toward the agency's drawn shape, so the path follows the line wherever the map allows and leaves it only where the map doesn't. Each departure is listed with a guess at why: a one-way against the line, a road a bus may not use, a gap between ways, or no road at all;
- **audits the OSM route relation** that covers each pattern: platforms missing or extra or out of order, member ways off the line, tags to add, and duplicates (two relations for one itinerary);
- **proposes a PTv2 relation** for each pattern — matched platforms in order, routed ways in order, tags per the [GTFS tagging scheme](https://wiki.openstreetmap.org/wiki/Proposal:GTFS_Tagging_Standard) — as a `.osm` file JOSM can import;
- **shows what the feed knows that OSM might not**: `stop_desc` (at CVTD, the on-bus announcement — "Intermodal Transit Center", "Across from Firehouse Pizza"), `tts_stop_name`, `wheelchair_boarding`, `platform_code`.

Timetables are out of scope on purpose: OSM doesn't hold them.

## Run it

Python 3.9+, no dependencies.

```bash
# 1. find the feed (Mobility Database catalog, no key needed)
python3 tool/catalog.py "cache valley" --get          # → cache/cvtd-cache-valley-transit-district.zip

# 2. compare with OSM (fetches Overpass for the feed's bounding box, cached in cache/)
python3 tool/review.py cache/cvtd-*.zip               # → web/data/review.json + rel-*.osm

# 3. look
python3 tool/serve.py                                  # → http://127.0.0.1:8765/
```

If Overpass or the agency is unreachable from where you run this, fetch by hand and pass the files:

```bash
python3 tool/review.py feed.zip --osm-pt osm-pt.json --osm-roads osm-roads.json
```
The queries are in `tool/osm.py` (`PT_QUERY`, `ROADS_QUERY`).

## Reviewing

The page lists patterns worst first. Open one:

- **dashed orange** is the agency's shape; **blue** is where a bus can drive on OSM; **purple** is what the existing OSM relation contains. Where orange and blue part, something is wrong on one side.
- Each divergence names the ways involved. *Open in JOSM* loads and zooms there with them selected (JOSM needs Remote Control on, in preferences).
- *Load proposed relation in JOSM* downloads the ways and platforms into the current layer and imports a new relation built from them. Compare with the existing relation, fix, validate, upload — and delete the duplicate if there was one.
- If the proposed path takes a wrong turn (the map is right but the shape is sloppy, say), *Re-route via a point* and click the map; the path re-traces through your via points, and the relation you then load follows them.
- Stops: filter to missing, ambiguous, or differing; *Add stop in JOSM* places a node with the proposed tags; *Apply GTFS tags* adds `ref`, `gtfs:stop_id`, `route_ref`, `description` to a matched node. The name is left to you — the agency's name is often an address, OSM's a place.
- *OSM only*: stops in OSM near the network that no feed stop claims. Another operator's, moved, or gone.

## Before uploading much

One reviewed route at a time is mapping. All of it at once is an import: read [Import/Guidelines](https://wiki.openstreetmap.org/wiki/Import/Guidelines) and the [Automated Edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct), check the feed's licence is compatible with ODbL (many agency feeds aren't, or need written permission), and tell the local community first.

## Layout

```
tool/gtfs.py      the feed → stops, routes, patterns (one per distinct itinerary; short runs folded in)
tool/osm.py       Overpass queries and parsing
tool/stops.py     stop conflation and tag diff
tool/routes.py    road graph, bus-legal shape-guided routing, divergences
tool/compare.py   relation ↔ pattern pairing and audit; proposed tags
tool/review.py    runs it all → web/data/
tool/serve.py     static server + /api/trace for re-routing through via points
tool/catalog.py   Mobility Database search and download
web/              the page (MapLibre, vendored; OSM raster tiles)
```

## Not yet

- Turn restrictions aren't honoured by the router.
- A divergence over a road OSM has as `highway=footway`/`track` etc. reads as "no road here"; the roads query only fetches classes a bus can use.
- Stations (`location_type=1`) and `stop_position` nodes are ignored; only platforms are matched.
- `route_master` relations are reported, not proposed as files.
- Editing ways happens in JOSM/iD, not here.

## Built against

Cache Valley Transit District (Connect), Logan, Utah — 15 routes, 334 stops, 28 patterns. First run found OSM `ref` codes shifted onto the wrong stops across Routes 11 and 12, nine itineraries mapped twice as "Weekday" and "Saturday" relations, eleven directions with no relation at all, and no `route_master`s.
