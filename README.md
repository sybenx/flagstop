# flagstop

Review a transit agency's GTFS feed against OpenStreetMap, route by route, and hand each fix to JOSM.

Nothing here uploads to OpenStreetMap. The tool compares, explains, and proposes; a person looks and decides.

## What it does

Given a GTFS feed and a box of OpenStreetMap data, flagstop

- **matches stops** — by `gtfs:stop_id` or `ref`, then by distance and name, but never to a stop across the street from where the buses calling there pull in (that's the other direction's, whatever its name or code says) — and sorts every stop into *matched* (with a tag-by-tag diff), *ambiguous* (you pick), or *missing*, plus the OSM stops nobody in the feed claims;
- **routes every pattern over OSM's roads** the way a bus could drive them (`oneway`, `access`, `bus`/`psv` and turn restrictions honoured), pulled toward the agency's drawn shape, so the path follows the line wherever the map allows and leaves it only where the map doesn't. Each departure is listed with a guess at why: a one-way against the line, a road a bus may not use, a gap between ways, or no road at all;
- **audits the OSM route relation** that covers each pattern: platforms missing or extra or out of order, member ways off the line, tags to add, and duplicates (two relations for one itinerary);
- **proposes a PTv2 relation** for each pattern — matched platforms in order (each after its stop position on the road, where OSM has one), routed ways in order, tags per the [GTFS tagging scheme](https://wiki.openstreetmap.org/wiki/Proposal:GTFS_Tagging_Standard) — as a `.osm` file JOSM can import;
- **shows what the feed knows that OSM might not**: `stop_desc` (at CVTD, the on-bus announcement — "Intermodal Transit Center", "Across from Firehouse Pizza"), `tts_stop_name`, `wheelchair_boarding`, `platform_code`.

Timetables themselves stay out: OSM holds a route's hours and frequency (`opening_hours`, `interval`, `interval:conditional`), not its departures.

## Run it

Python 3.9+, no dependencies.

```bash
# 1. find the feed (Mobility Database catalog, no key needed)
python3 tool/catalog.py "cache valley" --get          # → cache/cvtd-cache-valley-transit-district.zip

# 2. compare with OSM: stops and route relations for the feed's area (Overpass, cached in cache/)
python3 tool/review.py cache/cvtd-*.zip               # → web/data/review.json

# 3. look
python3 tool/serve.py                                  # → http://127.0.0.1:8765/

Roads are loaded a route at a time, and routed in the page (`web/router.js`, the same router as `tool/routes.py`, checked against it on every itinerary): opening a route (or the list, in the background) fetches the roads around that one route, a small query, kept a day in `cache/roads/`. So a big system costs no more up front than a small one. `--route-all` routes everything at build time instead, with one roads fetch for the whole area (the tests, or a build to publish).
```

After you upload, the page shows it done at once, as iD does: what went up is laid over flagstop's copy, with the ids and versions OSM gave it, until the OSM data includes it. With `tool/serve.py`, *refresh* also reads your changesets straight from OSM's API (`tool/patch.py`): seconds, and current, where Overpass takes minutes and runs behind. A plain refresh fetches stops and routes again, and the roads only if they're a day old (`--refresh-roads` to force). Overpass servers are tried in turn when one is busy.

If Overpass or the agency is unreachable from where you run this, fetch by hand and pass the files:

```bash
python3 tool/review.py feed.zip --osm-pt osm-pt.json --osm-roads osm-roads.json
```
The queries are in `tool/osm.py` (`PT_QUERY`, `ROADS_QUERY`).

## Reviewing

The page lists itineraries worst first. Open one:

- **dashed orange** is the agency's shape; **blue** is where a bus can drive on OSM; **purple** is what the existing OSM relation contains. Where orange and blue part, something is wrong on one side, and the divergence says which ways are involved and why.
- **Rings** are the agency's stop positions, **dots** are OSM nodes. How far the agency's points usually are from OSM's is measured per feed (here: 5 m); a stop well past that (three times it, at least 10 m) is a question to look at on the map. Nothing moves unless you say so.
- *Fix relation → changes* rewrites the existing relation (or creates one) with the matched platforms in order and the routed ways, keeping the mapper's free-text tags and adding the GTFS scheme's. A relation that holds both directions is kept for one and a new one created for the other. Duplicates ("Weekday"/"Saturday") can be marked for deletion.
- *Fix this route*, one click: everything flagstop can do for an itinerary without you is done (the review's calls on every stop, stops the agency has and OSM hasn't added, the relation rewritten from the agency's line with the roads split where the bus turns, duplicates merged away, its route_master kept or made, the timetable on it; the mapper's roads the agency's line doesn't drive are dropped and named), and what it can't decide is listed first with the choice: where a stop goes (after a look at the map), which of two OSM stops is the agency's, a name it wasn't sure of, a path that doesn't trace whole. Then upload from Changes. A route with nothing to decide is one click and an upload.
- *Re-route* when the routed path takes a wrong turn: click the map for a via point (go through here), or a road to say *the bus uses this road* or *the bus doesn't*. The path re-traces, the relation you then propose follows it, and your say is kept with your decisions (a reload, another browser) and undone like any edit.
- A way's tags — a wrong `oneway`, a missing `bus=yes` — can be edited from the divergence popup.
- **Roads**: flagstop changes a road's shape only as part of a card that showed it first — a merge's splits where the bus turns partway along, a station's stop positions, turning back a one-way that an earlier edit turned round (its history has to say so; a one-way against the line with no such history may be right, and is left to you). Tags (`oneway:bus`, `bus=yes`) can be edited from a divergence. Shaping roads — reconnecting, moving, drawing — is RapiD's and iD's: *Open in RapiD* carries the agency line as an overlay and pre-fills the changeset comment.
- **Stops**: *to decide* lists what needs a human — not in OSM, probably moved (same street, further off), ambiguous (pick one). For matched stops the diff lets you tick which agency values to apply, ticked as Check stops would: the agency's codes and its address in, position out (OSM's node is usually on the sign).
- **Two relations for one route** (usually one per timetable: "… - Weekday", "… - Saturday"): GTFS says whether it's the same route every day, and OSM maps the route, not the timetable. *See the proposed merge* explains what OSM has, why there are probably two, and what flagstop would do — keep the older relation (its history carries on), give it the feed's stops in order and its roads in driving order (splitting roads where the bus turns partway along), delete the other and take it out of the route master, put the timetable on it as tags (`opening_hours`, `interval`, `interval:conditional`: first departure from its first stop to last arrival, and the usual gap, per day; the usual gap, said so, where it drifts through the day; ticked unless OSM already has other values, which are shown) — with the map showing it both ways. Stops that end up on no route (the old relation's stop the feed no longer calls at, the candidate you didn't pick) are listed: look on the map, and if one isn't there any more, *It's gone* removes it from OSM (or just its stop tags, if it's part of a way); one that another route still uses is left alone. Looks right puts it in Changes as one step; it stops instead if the roads still wouldn't join up.
- **Timetable**, under each OSM relation: the route's hours and how often it runs, as OSM tags (`opening_hours`, `interval`, `interval:conditional`), next to what OSM has, with *Add to changes*. Times are at the relation's first stop; where the gap between buses drifts through the day, the interval is the usual one and the page says so. A relation mapped twice gets it in the merge instead.
- **Check stops** (on an itinerary) goes down the route's stops with flagstop's call on every difference between the agency and OSM, and its reason: the agency's code, id and route list go in; the stop's name is the agency's address for it, and the agency is right about that: written the OSM way, abbreviations spelled out ("2470 N Main St, N Logan" → "2470 North Main Street, North Logan"; English feeds only), and a landmark or note added to OSM's name ("(Walmart)", "TIMEPOINT") goes, the agency's announcement going in `description`; a new number in the address at the same spot is the agency's current name; a stop within 25 m is the same spot. `network` follows what this agency's other stops in OSM carry: an old name for the same network (one in the feed's agency name, or one iD's [name-suggestion-index](https://github.com/osmlab/name-suggestion-index) lists, like `CVTD`) becomes the current one, with its `network:wikidata`; anything else is a question. `operator` is left alone. Two stops the agency made one — nothing at its spot, and OSM still has a stop either side of it on the same street and side — is one question: move the nearer here (it keeps its history and takes the agency's name and codes) and remove the other, which also comes out of the routes that list it. What it can't call — a stop 200 m away with a new number, OSM's stop across the street from where buses going that way pull in, two neighbouring stops with each other's names — is a question you answer. Nothing goes in until you've been down the list and added it, a route at a time. An upload takes at most 50 changes, so each changeset is small enough for others to review. Adding `gtfs:stop_id` across a whole network is still a systematic change: tell the local mappers before you start.
- **Stations** (a line over the Routes list when one has something to sort out; the top of Stops; any bay's stop page, a route calling there, or the station on the map): a place where two or more of the agency's stops sit round a bus station in OSM. The card says how a station is mapped — one station, a platform per bay, a stop position per bay on the road, a stop area relation grouping them, routes listing the bay not the station — ticked where this one has it. flagstop then does what's tags, relations or a point on a road: asks which of two station points is the station (the other is something in it, an office — a lost and found by its name, `amenity=lost_property_office` — keeping its hours, phone and address; or it's folded in, each of its tags ticked to go onto the station, its name as `alt_name`, and anything unticked said to be lost with it), adds a stop position for each bay where the road its buses use passes closest (tagging a plain point already there, never a junction), offers to remove a stop position no route uses (after a look), takes the bay signs' letters if you type them (`local_ref`), and groups it all in a stop area (or fills in the one there). Drawing the station as an area is RapiD's.
- **OSM only** lists bus stops in OSM that no stop in the agency's data claims. This agency's (by network or operator, old names included, or tagged with neither) can be shown on the map and, if gone, removed: a stop another relation still uses is left and said, one that's a point in a sidewalk loses only its stop tags. Other operators' are listed, never touched.
- **Changes** holds everything you decided, with a before/after per object. It leaves as one changeset uploaded with your OSM login, as an osmChange file for JOSM, or as Level0 text. Before uploading, every touched object is re-read from OSM and the upload stops if someone edited it since flagstop looked.

## Where a stop is

The agency's point and OSM's node are good at different things: the agency's point changes when the stop moves (often before anyone edits OSM), but is rough in absolute terms; a carefully mapped node is on the pole. So flagstop asks whether the stop moved, not which is right (`tool/positions.py`). It keeps every feed version's stop points; when the agency's point jumped (10 m or more) between versions and OSM's node is still at the old spot, that's a question to look at, and the node goes:
- to the agency's new point, when the node came from the agency's data in the first place (made at one of its points, never moved since);
- by the same amount as the agency's move, when a mapper placed the node by hand (its history shows it moved after it was made): the mapper's precision is kept, the move followed.

Without a jump, a difference within the usual gap is two placements of the same stop and OSM's spot stays; a larger one is a question, as before. A stop the agency moved is also found in OSM where it used to be, not reported missing. And OSM's node read against its own history: one that sat at the agency's spot until someone moved it away (50 m or more: further than putting it on its sign) is the node that moved, not the stop. Putting it back where it was is the suggestion, and the Changes tab offers a note for that mapper's changeset after the upload.

A stop OSM hasn't got goes in at the agency's point, unless that point is in the road (often the centre line, or the middle of a junction): then at the kerb beside it, on the side buses pull in at as they drive past (the route's direction there), by the road's width (its `width` or `lanes`, else what its kind usually is). Which side buses pull in at is found from where OSM's stops with the agency's codes already are, relative to the buses' direction: the right, or the left where traffic keeps left. A point already off the road stays (a stop on the left of a one-way street is one). Moving OSM's stop to the agency's point does the same: to the kerb, when the agency's point is in the road (a shift, above, keeps the mapper's offset instead). And OSM's own stop found well inside the road is a question of its own: to the nearer kerb (on the middle line, the buses' side); a stop that's a point of the road itself isn't moved, it would bend the road. Imagery decides the last metre: drag the stop onto the sign.

A stop shared with another network (a university shuttle's, say) is one node with both networks and operators on it. When the agency's point lands on another network's stop and OSM's node with the agency's code is further off than its points usually are, nothing is assumed: the stop asks whether it's one stop for both (the other network's node takes the agency's ids, routes and network; the old node goes, its routes listing the shared one), or still its own (kept where it is, or moved to the agency's point). On a stop that is another network's, or shared with one, its `name` and `ref` are theirs (what their riders read on the sign) and stay; the agency's code goes in `gtfs:stop_code`.

Route numbers with a time of day ("16 AM", "16 PM"; "9 Night", "4 Saturday") are one line run differently at different times: one route master with the number as its `ref`, a relation for each way it's run (each `ref` the number, the time in its name), and stops' `route_ref` lists the number once.

## A new feed

Each build keeps a short summary of the feed version it reviewed (in `cache/`). When the agency publishes a new one, the Routes page opens with what changed since the last version: stops added, gone, moved or renamed, routes added or gone, routes calling at different stops. That's where to look first; a stop gone from the feed turns up in *OSM only*, to remove after a look.

## Live where you look

Opening a route reads its relations and stops from OSM's API (a request or two, like iD) and says what changed since flagstop's copy, by whom, in which changeset. *Bring them in* applies those changesets (`tool/patch.py`) and rebuilds: no waiting for Overpass.

## Other mappers

Open OSM notes by a stop (within 30 m, or 150 m when the note talks about a bus stop) show on its page, in Check stops and in *OSM only*: someone saw something there. Comments other mappers leave on your changesets show at the top of Changes once you're signed in.

Other operators: the Mobility Database is searched for other agencies' feeds covering the area (active, no key needed), and only their stops here are read. An OSM stop one of them serves is known to be shared: its network/operator lists both without a question, and it's never offered for removal. A feed the catalog doesn't have can be given by hand: `tool/review.py feed.zip --also shuttle.zip`; `--no-others` skips the lookup.

## What the agency is authoritative for

Identity and structure: that a stop exists, its code, which routes call at it and in what order, which itineraries a route has. Everything else — position, name, the drawn shape — is a hint. Proposals follow the local mappers' conventions (`operator`, `network`, `network:wikidata` are taken from the majority of already-mapped stops, not from the feed).

## Detours

Short detours (days) aren't mapped: OSM can't keep up, and the churn is worse than the lag. Long ones (weeks and more) are worth mapping while they last, since apps route on OSM: put a `note=*` on the relation saying it's a diversion and what the normal route is, with a `check_date`, and revert it afterwards.

GTFS doesn't say which part of a route is a detour, but the feed's own words often do: stops named Temp, Temporary or Detour. An itinerary that calls at one, while OSM's relation for it goes round it by the regular route (stops it has that the itinerary skips) or follows it already, is **on a detour**, and its page says so. Some agencies (CVTD) publish a detour in GTFS only when it'll last weeks or more, which is worth mapping while it lasts: by default the relation follows the feed, with a `note=*` saying it's a diversion, and the stops it goes round stay in OSM (marked in *OSM only* as coming back, with no removal). For a short one, *Keep the regular route instead* leaves the relation's stops and roads as they are (merges and *Fix this route* then only bring its tags up to date). *Restore the regular route* puts it back from the relation's own history: its newest version without the detour's stops, checked to still be there and to join up, without the diversion note or the detour's shape. When the feed goes back to normal, the usual proposal does the same from the feed, and takes the note off. Itineraries run only by a short-dated service are marked *temporary* and left out of proposals.

A stop missing from the feed isn't necessarily gone: a feed published during a detour leaves out stops that come back after it. Removing one of this agency's stops from OSM takes a second step that says so: only after seeing it isn't there any more, or the agency saying it's gone for good.

## Where your work is kept

Changes and stop decisions are kept in the browser and, while `tool/serve.py` runs, in `cache/state/` too: another browser on this machine, or this one after its site data is cleared, picks up where you left off (the newer copy wins). Only flagstop's own page can read or write it. Answers on a card you haven't added to Changes yet (a merge, a station) last for the browser tab.

## Publishing it

`.github/workflows/publish.yml` builds the review (the agency's feed from the Mobility Database, OSM's stops and routes) and publishes `web/` on GitHub Pages, daily and when run by hand. The build reads OSM from Geofabrik's regional extract (`tool/extract.py`), not public Overpass: the smallest regions covering where the routes go (CVTD: Utah and Idaho, for Preston), kept between runs and brought up to date with Geofabrik's daily changes, so a day old at most, the same as the page; if that fails, yesterday's data is used, and Overpass is never asked (`review.py --no-overpass`). Public extracts carry no user names: the published page says when a stop was edited, not by whom. Your own copy (`tool/serve.py`) still reads Overpass, minutes behind OSM. The published page needs no server: it routes in the browser, with each route's roads as the build cut them (`review.py --roads-per-route`; it asks Overpass itself only for a route the build couldn't get); your uploads show at once; what others change is checked live when you open a route, and comes in with the next build. It's off until you turn it on: Settings → Pages → Source: GitHub Actions, and a repository variable `PUBLISH` = `yes` (optionally `FEED_QUERY` for another agency). Check the feed's licence first: the page republishes its stops and shapes.

## Uploading from the page

Sign in with OSM from the Changes tab. flagstop signs in through one OSM app (a public OAuth 2 client, no secret, like iD's), set in `web/config.js` with the addresses it's registered for. Until that's filled in, or at an address it doesn't cover, register your own once at <https://www.openstreetmap.org/oauth2/applications/new> — name `flagstop`, redirect URI exactly what the Changes tab shows, untick *Confidential application*, tick *read user preferences* and *modify the map* — and paste its client ID there. The token stays in your browser.

## Before uploading much

One reviewed route at a time is mapping. All of it at once is an import: read [Import/Guidelines](https://wiki.openstreetmap.org/wiki/Import/Guidelines) and the [Automated Edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct), check the feed's licence is compatible with ODbL (many agency feeds aren't, or need written permission), and tell the local community first.

## The sandbox: the whole tool against a copy of OSM, nothing at stake

`tool/sandbox.py` is a stand-in for OpenStreetMap: the Cache Valley's roads, stops and routes as they were on
2026-09-27 (before flagstop's first upload, from Overpass's history), served the way api.openstreetmap.org,
the sign-in and Overpass serve them. Pointed at it, the tool doesn't know the difference: the review builds from
it, the page signs in to it, uploads land in it (versions checked, `if-unused` honoured, new ids given back), the
refresh after an upload reads them back from it. Every upload is logged under `cache/sandbox/`; `reset` is the
snapshot again.

```bash
python3 tool/sandbox.py snapshot        # once: the area as of 2026-09-27 -> cache/sandbox/base-2026-09-27.json
python3 tool/sandbox.py run             # the sandbox, the review built from it, the page at :8765 (its own files under cache/sandbox/work/)
python3 tool/sandbox.py run --reset     # forget every upload first
python3 tool/sandbox.py reset           # the same while it runs (a new generation: the page's basket, decisions and answers
                                        # start afresh); or the "Reset the sandbox" button on the page's ? tab, which
                                        # also builds the review again — run it through again from the start
python3 tool/sandbox.py status          # what has gone up, by changeset
python3 tool/sandbox.py report          # is it good and safe? pass/fail lines on the result (routes whole, PTv2 order, one-ways, stop positions, ...)
```

`run` is also the `flagstop-sandbox` entry in `.claude/launch.json`. By hand: `tool/sandbox.py serve` on one port,
`tool/serve.py --sandbox http://127.0.0.1:8766` on another. A query shape the sandbox doesn't know is a 400 that
names it (`Overpass.run` in `tool/sandbox.py`): a new query in the tool is a gap there, not a wrong answer.

## Tests

```bash
python3 -m unittest discover -s tests     # the rules, each pinned to the case it was built for; the review against its snapshot; the relation files
node tests/edits_test.js                  # the upload path, no browser or network: osmChange, split + relation repair, check() before upload
                                          # (discover also runs tests/test_sandbox.py: the sandbox API, and the page's upload code against it)
                                          # and tests/test_scenarios.py: tests/scenarios/*.json through the page's modules into a sandbox, judged by its report (snapshot ones skip without one)
python3 tests/snapshot.py                 # after rebuilding the review: what changed, stop by stop
python3 tests/snapshot.py --update        # when the changes are meant
```

A shuttle that shares your stops but publishes no GTFS (a campus shuttle on Passio GO): `tool/review.py FEED.zip
--also passio:<system id>:<agency name>` reads its stops from the Passio GO app's own endpoint, so the shared
stops are known to be shared (both networks and operators listed, their route numbers kept) rather than
guessed from tags. The system id is in the Passio GO app's URL for that agency.

```bash
```

## Layout

```
tool/gtfs.py      the feed → stops, routes, patterns (one per distinct itinerary; short runs folded in)
tool/osm.py       Overpass queries and parsing
tool/stops.py     stop conflation and tag diff
tool/routes.py    road graph, bus-legal shape-guided routing, divergences
tool/compare.py   relation ↔ pattern pairing and audit; proposed tags
tool/review.py    runs it all → web/data/ (review.json, a GPX per itinerary, a .osm per proposed relation)
tool/patch.py     the cached OSM data brought up to date with changesets, from OSM's API
tool/serve.py     static server + /api/trace for re-routing through via points and around roads the bus does or doesn't use
tool/sandbox.py   a stand-in OSM (API, sign-in, Overpass) from a dated snapshot: the tool end to end, every edit kept local
tool/catalog.py   Mobility Database search and download
tool/feeddiff.py  what changed between two versions of the feed
tool/positions.py where a stop is: the agency's moves (feed history) and how OSM's node got where it is (node history)
tool/others.py    other agencies' stops in the area, from their own feeds
web/app.js        the page (MapLibre, vendored; OSM raster tiles)
web/edits.js      the change basket: osmChange, Level0, OAuth sign-in, upload with conflict check
web/roads.js      road changes on live OSM data that repair the relations on them (used by the cards; no free-hand editor)
web/review.js     checking a route's stops against flagstop's suggestions, 50 per upload
web/fix.js        a proposed map fix shown before/after ("OSM says / should be"); re-routing with Changes
web/merge.js      two relations for one route -> one, explained and shown
web/station.js    a station: how it's mapped, shown on it, and the parts it lacks
tests/            unit tests for the rules; snapshot.json, what the review decided, to diff against
```

## Not yet

- The router keeps to turn restrictions with a node as via (bus exceptions honoured); one with a way as via is ignored.
- A divergence over a road OSM has as `highway=footway`/`track` etc. reads as "no road here"; the roads query only fetches classes a bus can use.
- Stations (`location_type=1`) and `stop_position` nodes are ignored; only platforms are matched. A platform tagged with a network none of the agency's coded stops use (an intercity coach's bay) ranks below the agency's own.

## Built against

Cache Valley Transit District (Connect), Logan, Utah — 15 routes, 334 stops, 28 patterns. First run found OSM `ref` codes shifted onto the wrong stops across Routes 11 and 12, twelve itineraries mapped twice as "Weekday" and "Saturday" relations, several relations holding both directions, no `route_master`s, and the Bear River Health Department stop 274 m from where the agency moved it.
