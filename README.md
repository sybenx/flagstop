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

Timetables themselves stay out: OSM holds a route's hours and frequency (`opening_hours`, `interval`, `interval:conditional`), not its departures.

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

The page lists itineraries worst first. Open one:

- **dashed orange** is the agency's shape; **blue** is where a bus can drive on OSM; **purple** is what the existing OSM relation contains. Where orange and blue part, something is wrong on one side, and the divergence says which ways are involved and why.
- **Rings** are the agency's stop positions, **dots** are OSM nodes. Agency coordinates are routinely 10–30 m off; the node on the sign is usually right. Nothing moves unless you say so.
- *Fix relation → changes* rewrites the existing relation (or creates one) with the matched platforms in order and the routed ways, keeping the mapper's free-text tags and adding the GTFS scheme's. A relation that holds both directions is kept for one and a new one created for the other. Duplicates ("Weekday"/"Saturday") can be marked for deletion.
- *Re-route via a point* when the routed path takes a wrong turn: click the map, the path re-traces through your via points, and the relation you then propose follows them (needs `tool/serve.py`).
- A way's tags — a wrong `oneway`, a missing `bus=yes` — can be edited from the divergence popup.
- **Roads** (map, top right, zoom 17+) edits the road network the routes run on, from live OSM data: split a road, reconnect a road's end somewhere else (a driveway that should join a few metres along), move a junction, add a straight segment. These are the edits iD and RapiD refuse or leave half-done when route relations run through them. flagstop makes the change and repairs every relation that used those roads in the same changeset: bus routes are re-chained end to end over the new pieces (one-ways respected), turn restrictions keep the piece at their via, other relations get every piece. Only the stretch around the edit is touched; a relation that was already broken elsewhere stays as it was. If a route can't be repaired (the new connection is one-way the wrong way, say), you're told which and where before anything is added. A road edit is several lines in Changes that only work together, so it is undone as a whole, newest first. Shaping roads — curves, drawing by eye — stays with RapiD: *Open in RapiD* carries the agency line as an overlay, selects the objects, and pre-fills the changeset comment.
- **Stops**: *to decide* lists what needs a human — not in OSM, probably moved (same street, further off), ambiguous (pick one). For matched stops the diff lets you tick which agency values to apply; identity (`ref`, `gtfs:stop_id`, `route_ref`) is ticked by default, name and position are not.
- **Two relations for one route** (usually one per timetable: "… - Weekday", "… - Saturday"): GTFS says whether it's the same route every day, and OSM maps the route, not the timetable. *See the proposed merge* explains what OSM has, why there are probably two, and what flagstop would do — keep the older relation (its history carries on), give it the feed's stops in order and its roads in driving order (splitting roads where the bus turns partway along), delete the other and take it out of the route master, put the timetable on it as tags (`opening_hours`, `interval`, `interval:conditional`: first departure from its first stop to last arrival, and the usual gap, per day; the usual gap, said so, where it drifts through the day; ticked unless OSM already has other values, which are shown) — with the map showing it both ways. Stops that end up on no route (the old relation's stop the feed no longer calls at, the candidate you didn't pick) are listed: look on the map, and if one isn't there any more, *It's gone* removes it from OSM (or just its stop tags, if it's part of a way); one that another route still uses is left alone. Looks right puts it in Changes as one step; it stops instead if the roads still wouldn't join up.
- **Timetable**, under each OSM relation: the route's hours and how often it runs, as OSM tags (`opening_hours`, `interval`, `interval:conditional`), next to what OSM has, with *Add to changes*. Times are at the relation's first stop; where the gap between buses drifts through the day, the interval is the usual one and the page says so. A relation mapped twice gets it in the merge instead.
- **Check stops** (on an itinerary) goes down the route's stops with flagstop's call on every difference between the agency and OSM, and its reason: the agency's code, id and route list go in; a name that only differs in how it's written ("Main St, N Logan" / "Main Street") stays as OSM has it; a new number in the address at the same spot is the agency's current name; a stop within 25 m is the same spot. What it can't call — a stop 200 m away with a new number, OSM's stop across the street from where buses going that way pull in, two neighbouring stops with each other's names — is a question you answer. Nothing goes in until you've been down the list and added it, a route at a time. An upload takes at most 50 changes, so each changeset is small enough for others to review. Adding `gtfs:stop_id` across a whole network is still a systematic change: tell the local mappers before you start.
- **Changes** holds everything you decided, with a before/after per object. It leaves as one changeset uploaded with your OSM login, as an osmChange file for JOSM, or as Level0 text. Before uploading, every touched object is re-read from OSM and the upload stops if someone edited it since flagstop looked.

## What the agency is authoritative for

Identity and structure: that a stop exists, its code, which routes call at it and in what order, which itineraries a route has. Everything else — position, name, the drawn shape — is a hint. Proposals follow the local mappers' conventions (`operator`, `network`, `network:wikidata` are taken from the majority of already-mapped stops, not from the feed).

## Detours

Short detours (days) aren't mapped: OSM can't keep up, and the churn is worse than the lag. Long ones (weeks and more) are worth mapping while they last, since apps route on OSM: put a `note=*` on the relation saying it's a diversion and what the normal route is, with a `check_date`, and revert it afterwards.

flagstop follows the routes the feed gives. Some agencies only publish a detour in GTFS when it'll last weeks or more (CVTD does), and then the feed is the route to map. If yours publishes every short detour, check before following it. Stops named Temp/Detour and itineraries run only by a short-dated service are marked *temporary* and left out of proposals either way.

## Uploading from the page

Once: register flagstop as an OAuth 2 application on your OSM account at <https://www.openstreetmap.org/oauth2/applications/new> — name `flagstop`, redirect URI exactly what the Changes tab shows (`http://127.0.0.1:8765/` by default), untick *Confidential application*, tick *read user preferences* and *modify the map*. Paste the client ID into the Changes tab. Sign-in is OSM's own page; the token stays in your browser.

## Before uploading much

One reviewed route at a time is mapping. All of it at once is an import: read [Import/Guidelines](https://wiki.openstreetmap.org/wiki/Import/Guidelines) and the [Automated Edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct), check the feed's licence is compatible with ODbL (many agency feeds aren't, or need written permission), and tell the local community first.

## Layout

```
tool/gtfs.py      the feed → stops, routes, patterns (one per distinct itinerary; short runs folded in)
tool/osm.py       Overpass queries and parsing
tool/stops.py     stop conflation and tag diff
tool/routes.py    road graph, bus-legal shape-guided routing, divergences
tool/compare.py   relation ↔ pattern pairing and audit; proposed tags
tool/review.py    runs it all → web/data/ (review.json, a GPX per itinerary, a .osm per proposed relation)
tool/serve.py     static server + /api/trace for re-routing through via points
tool/catalog.py   Mobility Database search and download
web/app.js        the page (MapLibre, vendored; OSM raster tiles)
web/edits.js      the change basket: osmChange, Level0, OAuth sign-in, upload with conflict check
web/roads.js      road edits on live OSM data (split, reconnect, move, add) that repair the relations on them
web/review.js     checking a route's stops against flagstop's suggestions, 50 per upload
web/fix.js        a proposed map fix shown before/after ("OSM says / should be"); re-routing with Changes
web/merge.js      two relations for one route -> one, explained and shown
```

## Not yet

- Turn restrictions aren't honoured by the router.
- A divergence over a road OSM has as `highway=footway`/`track` etc. reads as "no road here"; the roads query only fetches classes a bus can use.
- Stations (`location_type=1`) and `stop_position` nodes are ignored; only platforms are matched. A platform tagged with a network none of the agency's coded stops use (an intercity coach's bay) ranks below the agency's own.
- Deleting a stop is only offered in a merge, for a stop the route no longer uses, after you've looked; other OSM-only stops are listed for you to look at.
- The via-point re-route doesn't persist across reloads.

## Built against

Cache Valley Transit District (Connect), Logan, Utah — 15 routes, 334 stops, 28 patterns. First run found OSM `ref` codes shifted onto the wrong stops across Routes 11 and 12, twelve itineraries mapped twice as "Weekday" and "Saturday" relations, several relations holding both directions, no `route_master`s, and the Bear River Health Department stop 274 m from where the agency moved it.
