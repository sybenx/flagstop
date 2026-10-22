# A sandbox OSM: test flagstop end to end without touching the map

2026-10-04. A local stand-in for OpenStreetMap, holding the Cache Valley as it was before flagstop's first
upload, that the whole tool runs against: the review build, the page, sign-in, the change basket, upload, the
refresh after an upload. Every edit lands in the sandbox and nowhere else, the sandbox resets to the snapshot
in a second, and a report says whether what the tool put there is good and safe. JOSM, RapiD and iD stay
outside it: everything flagstop should be able to do, it should do itself, and that is what gets tested.

**What the tool talks to today** (the seams the sandbox replaces):
- the OSM API 0.6, from the page: `web/edits.js` (`OSM_API`: object reads before upload, user details,
  changeset create / upload / close), `web/app.js` (objects by id, a node's ways and relations, the user's
  changesets with discussion), `web/roads.js` (`map.json?bbox`, ways by id, a way's history),
  `web/fix.js` (a way with its nodes); and from Python: `tool/patch.py` (a changeset's download after an
  upload), `tool/osm.py` (notes);
- the OSM website for OAuth (`OSM_WWW` in edits.js: authorize, token);
- Overpass, from Python (`tool/osm.py`: `PT_QUERY`, `ROADS_QUERY`, `fetch_roads_near`; `OVERPASS_URL` is
  already an override) and from the page (`web/app.js roadsQuery()`, used when `tool/serve.py` isn't there);
- `tool/serve.py` itself (`/api/*`), which stays as it is and just runs against the sandbox.

Items in the order to do them.

---

## 1. The snapshot: the Cache Valley before flagstop

**Why.** The baseline every evaluation resets to. "Before" is a date: the first commit is 2026-09-28; 2026-09-27 is the day before, so the
map as of `2026-09-27T00:00:00Z` predates every flagstop upload, and everything else that happened since
(other mappers' edits, Sytys's by hand) is frozen out too, which is what a test bed wants.

**Build.** `tool/sandbox.py snapshot [--date 2026-09-27T00:00:00Z] [--bbox ...]`: Overpass attic queries
(`[date:"…"]` in the query header; `overpass-api.de` keeps full history, the mirrors may not) for the agency's
bbox (the one `review.py` works out from the feed, padded): every node, way and relation with `out meta`, so
versions, timestamps and users are the real ones. Written to `cache/sandbox/base.json` (one file, every
object, by id). A second run with the same date is a no-op; a different date makes a new base, named by date.

Fallback if attic isn't available: fetch the area as it is now, list flagstop's changesets (`created_by=flagstop`,
your user, via `changesets.json`), and roll each touched object back to the version before the first of them
(`/history.json`). Same result for what flagstop touched; other mappers' later edits stay in.

**Proves it.** The snapshot parses, holds the CVTD bus routes as relations (count matches the `osm-pt`
fetch minus what flagstop created), and no object in it carries `created_by=flagstop` in its last changeset.

## 2. The sandbox server: OSM API 0.6, OAuth, Overpass, in one process

**Why.** One origin for the page, so `OSM_API`, `OSM_WWW` and Overpass all point at it and nothing is asked
of the real servers.

**Build.** `tool/sandbox.py serve [--port 8766]`, zero dependencies like the rest, in-memory from `base.json`
plus an edit log (`cache/sandbox/changes.json`: every changeset uploaded, in order) replayed on start; reset
is deleting the log. It answers, exactly as api.openstreetmap.org does for the calls the tool makes
(JSON and XML, the same shapes, the same status codes):
- reads: `node|way|relation/{id}.json`, `nodes|ways|relations.json?ids`, `way/{id}/full.json`,
  `way/{id}/history.json`, `node/{id}/ways.json` and `/relations.json`, `map.json?bbox`,
  `changesets.json?user`, `changeset/{id}.json?include_discussion`, `changeset/{id}/download`,
  `user/details.json`, `notes.json`;
- writes: `changeset/create` (PUT, an id), `changeset/{id}/upload` (POST osmChange, a `diffResult` with
  `old_id`/`new_id`/`new_version`, `if-unused` honoured: a used object is kept and reported as OSM does),
  `changeset/{id}/close`. Versions checked: a modify or delete with a stale version is a 409, as on OSM, so
  the tool's `check()` and conflict handling are exercised for real;
- OAuth: `/oauth2/authorize` sends the browser straight back with a code, `/oauth2/token` gives a token, and
  `user/details` names a sandbox user. The page's real sign-in code runs, unchanged;
- Overpass at `/api/interpreter`: not a QL interpreter. The tool sends four query shapes (`PT_QUERY`,
  `ROADS_QUERY`, `fetch_roads_near`, `roadsQuery()`); the server recognises each by its structure (bbox or
  box list, tag filters, the recursions) and answers from the snapshot with the same element shapes
  (`out meta` / `out body` / `out skel`). A query it doesn't recognise is a 400 that names it, so a new query
  in the tool shows up as a sandbox gap, not a silent wrong answer. `[date:]` is accepted and ignored.
- Where the page gets its addresses: `web/config.js` grows `FLAGSTOP_OSM.api`, `.www`, `.overpass` (empty =
  the real ones); `edits.js`/`app.js` read them. `serve.py --sandbox` serves a `config.js` pointing at the
  sandbox and sets `OVERPASS_URL` for its own `review.py`/`patch.py` subprocesses. `patch.py` and `osm.py`
  take `OSM_API_URL` from the environment the same way.

**Proves it.** `tests/sandbox_test.py`: start the server on a port, run the API calls above against it and
against recorded real answers' shapes (status, keys); an upload with a stale version gets a 409 and changes
nothing; `if-unused` keeps a node a way still uses. The page's `edits_test.js` upload tests run once more
against the live sandbox instead of the mocked fetch.

## 3. The tool, pointed at it, end to end

**Build.** `python3 tool/sandbox.py run`: snapshot if needed, reset, start the sandbox, run `review.py --refresh`
against it (Overpass → sandbox), start `serve.py --sandbox`, open the page. From there the ordinary workflow:
sign in (sandbox), review a route, Check stops, Fix relation → changes, road edits, upload, the refresh after
upload (`patch.py` reads the changeset back from the sandbox). Also `tool/sandbox.py reset` and
`tool/sandbox.py status` (how many changesets in the log, what they touched).

**Proves it.** A route reviewed and uploaded in the sandbox shows as done after the refresh, with nothing in
`cache/` or `web/data/` pointing at the real OSM; `git status` is clean apart from `cache/`.

## 4. The report: is what went up good and safe?

**Why.** "Until the data it outputs is good and safe" needs the judging written down, or it is a feeling.

**Build.** `tool/sandbox.py report [changeset ...]`: for the log's changesets (or the given ones), the objects
they touched, and checks on the *result*, not the diff:
- every bus route relation touched is whole: PTv2 member order (stops and platforms, then ways), ways
  chained end to end (`compare.chain_breaks` on the sandbox's own data), no way twice in a row, no
  one-way driven against, roundtrip tag vs geometry (relatify's check);
- every `stop_position` in a touched route lies on a way of that route; every platform node has the tags
  the review proposed and no tag the review didn't mean to touch;
- no object was deleted that another object still referred to; no new node within 1 m of an existing one
  with the same tags (the duplicate trap); no way left with a single node;
- turn restrictions and other relations through a split way still make sense (`Roads.repair`'s promise);
- versions: everything the tool modified was at the version it read (no overwrite of a sandbox edit made
  between read and upload, which the report can provoke on purpose: see 5);
- the changeset itself: comment length, `created_by`, `source`, one changeset per upload.
Each line is pass / fail with the object ids. The report is what an "improvement" is measured against:
run it before and after a change to the tool on the same scenario.

**Proves it.** A fixture changeset with each fault, planted by hand, fails exactly its line.

## 5. Scenarios: the same evaluation, every time

**Why.** "Evaluate each improvement fully" means re-running the same situations, not clicking around.

**Build.** `tests/scenarios/*.json`: a scenario is a snapshot date, a feed, a list of steps the tool's own
modules can take without a browser (`Edits`, `Roads`, `Router`, `Review` under node, the way
`edits_test.js` drives them, with `Edits.fetch` pointed at the sandbox), and the report lines expected to
pass. Start with: *a route with no relation* (create), *a relation with the wrong ways* (rewrite, with ways
kept where the mapper's are fine), *a split where the bus turns* (repair of every relation on the road),
*a stop moved to the agency's spot*, *a stale object* (the sandbox edits a node between the tool's read and
its upload; the upload must stop with the object named), *your real changesets replayed*: the flagstop
changesets you made on the real map, downloaded once, applied to the snapshot, reported on; the baseline
the tool should at least match. `python3 tests/scenarios.py` runs them all; wired into `publish.yml` with
the other tests once the snapshot is in the cache.

What stays manual: the experience. The sandbox is also what you open in the browser to feel a change, with
nothing at stake; the preview in the Claude app already starts `serve.py` from `.claude/launch.json`, and a
second entry starts the sandbox.

## Not in scope

JOSM, RapiD, iD handoffs (they open the real editors on the real map; in the sandbox the links are shown and
not followed). The Mobility Database and the feed itself (the real feed is fine to use: it is read-only).
A general Overpass QL interpreter. Notes: served from a fixed list.

## Where it stands (2026-10-04)

Items 1 to 4 are built and in `tool/sandbox.py` (`snapshot`, `serve`, `run`, `reset`, `status`, `report`) with
`tests/test_sandbox.py`; the snapshot of 2026-09-27 is in `cache/sandbox/` (231k nodes, 28k ways, 103 relations:
33 bus route relations, their 10 route_masters, all 34 turn restrictions, nothing dangling). The masters come from
the API's history, not Overpass: attic queries answer neither `<` nor `br` for a relation of relations. Run once end to end in the browser: sign-in,
the Blue LOOP's relation rewritten and uploaded (changeset 1), brought back in through `patch.py`, the page then
showing it whole at v40. Two things the sandbox found on its first run: the report's roundtrip rule had to allow a
loop closing along its own terminal road; the page stamped an upload's overlay after the changeset closed, so a
refresh never settled it (now stamped when the upload begins). The stale-object case was tried in the page too: a
stop renamed in the sandbox by "someone else" after the page read it, the upload stopped with the node named
(v5 → v6: name) and no changeset opened. Item 5 is built: `tests/test_scenarios.py` runs `tests/scenarios/*.json`
through the page's own modules under node, and `tool/sandbox.py replay` applies flagstop's 16 real changesets
(user Sytys, 2026-09-28 to 10-02) to the snapshot.

**What the replay says about the tool so far** (every bus route judged before and after, keyed by object):
24 faults were in the snapshot already and still are (route 9, 11 and 15 chain gaps and one-ways against,
loops tagged roundtrip that end 150 m or more from where they set off); the uploads fixed 6 (route 1 and route
7 Saturday chained and without a road twice, a one-way, a platform role); they introduced 1: **16 PM Northbound
(r12721122), rebuilt by changeset 189856305, went from 0 chain breaks to 4** (146 ways → 116; four places where
a listed way meets the next partway along it). That is *Fix relation → changes* putting the routed ways in
without splitting where the bus turns off a road mid-way: the Merge card splits first (`Roads.splitAt` for each
`chain_break`), the plain proposal doesn't. Next item for the tool, and the first thing the sandbox has to show
for itself: `proposeRelation` must split as Merge does, or refuse with the places named.

The replay scenario pins the checks that fail so a change to the tool shows as a change in that list.

**2026-10-05: the fix-it flow** (`web/fixit.js`, *Fix this route*) is built on the proposal, the stop review and
Merge's pieces, and was run in the sandbox on route 6 (15 stops, the Saturday duplicate merged away) and route
12 (44 stops, one added, one moved, 3 roads off the line dropped, the duplicate merged, 48 changes as one undo
step). The sandbox found one more of its own faults on the way: its who-uses-what index wasn't kept current
within an upload, so a relation dropped from its master and deleted in the same changeset was kept, as OSM
wouldn't. Answers to the review's questions are kept (`Edits.answers`), and a stop found at a distance is that node
whichever way its position was answered, so the relation lists it (route 12 had lost one). The whole sandbox
log, five changesets (the four 16s, route 6, route 12), judges clean: 0 failing of 299 checks. Not yet: the
fix-it plan can't run under node (it needs the page), so its scenarios are browser runs; the plan counts a
relation rewrite even when it would change nothing.

Done after that (2026-10-04, late): the proposal splits where the bus turns (the same code as Merge), traces
again on the result and refuses to put a broken chain in Changes; a route's masters are the ones holding its
relations (16 AM and 16 PM share master 17015541, ref 16: no second master); the mapper's ref stays when the
agency's is it plus a qualifier ("16" against "16 PM"). Tried on 16 PM Northbound in the sandbox: 4 splits,
every relation through those roads repaired, the relation at v40 with 117 roads and 24 stops, 0 chain breaks,
the line covered 100%; the report passes every line, including the new master checks.

Then all four 16 relations in one basket (the sandbox reset first): reused, ref 16 and the master kept, 4 splits
for the lot (the other three needed none of their own), every relation whole after the upload, all stops in, the
line covered 100%, the report passing 142 checks. Three more things the sandbox found on the way, all fixed:
splitting a long road (US 91, 3.9 km) counted the split way's own pieces against the 800 m limit meant for
guessed connections, so every relation through it went up without the pieces; a road repair pending on a relation
counted as another itinerary's claim, so the proposal made duplicates; the upload's overlay never settled because
OSM stamps whole seconds.

**The 16s, to decide.** The rewrite follows the agency's lines exactly and drops the roads the hand-mapped
relations drove beyond them: 16 PM Northbound lost 41 ways (1350 East, 400 North, 600 North, 600 West, 700
North), 16 AM Southbound 51 (those, plus 800 West, Aggie Boulevard, Main Street), the other two 5 and 11. The
feed's 16 AM Southbound runs Preston → Distance Ed Bldg, 16 AM Northbound Intermodal Transit Center → Preston;
the mapped relations ran further through Logan. Either the agency's shapes stop short of what the bus drives,
or the mapper drew more than the route. The tool can't know; the one-click flow must show this as a review
item ("the relation drove these roads the agency's line doesn't: dropped, unless the bus does drive them") and
not decide it.

## Decisions taken

- Snapshot by Overpass attic date, 2026-09-27T00:00:00Z, over the agency's padded bbox; rollback of
  flagstop's changesets is the fallback, not the plan.
- The sandbox recognises the tool's query shapes rather than interpreting Overpass QL: a new query shape
  is a sandbox error to fix, which is the honest failure.
- `config.js` carries the addresses; nothing in the tool checks "am I in the sandbox". The tool must not
  behave differently, or the test is of something else.
