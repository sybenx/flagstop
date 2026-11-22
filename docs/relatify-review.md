# What flagstop can take from relatify

A review of [Zaczero/osm-relatify](https://github.com/Zaczero/osm-relatify) (upstream, stalled Jan 2026) and
[ryan-bush/osm-relatify](https://github.com/ryan-bush/osm-relatify) (active fork, v1.2.0 Sep 2026) against this
codebase, 2026-10-04. Decision: keep building flagstop. Relatify's engine (one relation at a time, the mapper
picks the ways, a DFS strings them together) is the part a GTFS-first tool replaces, not the part it reuses.
Below is what it does that flagstop doesn't, as work items.

**Licence.** Both relatifies are AGPL-3; flagstop is MIT. Read them for ideas; copy no code. Where a fork file is
named below it's a reference to look at, not a source to port.

Items are in the order to do them. Each says why, where in this code, what to build, and what proves it.

---

## 1. Way constraints beside via points: "the bus uses this road" / "the bus doesn't"

**Why.** Relatify's one UX idea flagstop lacks. A via point says *go through here*; it can't say *never use
that street*, and when the agency's shape is itself wrong (drawn down a parallel street, or through a bus-only
link that OSM has right) the shape-guided router follows the shape and a via point can't pull it off. Also
closes the README "Not yet" item: via points don't persist.

**Where.**
- `web/router.js` — `trace(g, stops, shape)` (~l.334), `traceWithVias(p, stopsLL, g, vias)` (l.628),
  `Graph.patched()` (l.178–190: the copy-with-edits mechanism, already clears `blocked` for edited ways).
- `tool/routes.py` — `Graph.astar(..., no_first, no_last)` (l.309), `trace()` (l.398), `Graph.patched()` (l.203),
  `Graph.blocked` (way → reason). Keep the two routers identical; `tests/router_parity.{py,js}` checks that.
- `web/fix.js` — `traceWith(pid, extra, vias)` (l.28), `retrace()`; `web/app.js` — `S.vias`, `S.viaMode`,
  `addVia()` (l.436–441), map click handler (l.311).
- `tool/serve.py` — `/api/trace?via=` and `/api/relation?pattern&via=` (l.12–13, 209–211).
- `web/edits.js` — `decisions` is the per-agency persisted store (`state()` l.32); vias/constraints belong beside it.

**Build.**
- Replace `S.vias: [[lon,lat]]` with per-pattern `S.route[pid] = {vias: [...], avoid: [wayId], require: [wayId]}`,
  persisted in `Edits` next to `decisions` (so `cache/state/` and the browser copy carry it; the newer wins, as now).
- *Avoid*: in both routers, `patched()` takes `avoid` and puts each way in `blocked` with reason
  `"excluded by you"`. Divergence text already reads `blocked` (router.js l.469–487, routes.py `_why_blocked`),
  so an avoided way the shape follows is explained for free.
- *Require*: fold into the via list as two points, the way's end nodes in travel order (travel order = the end
  nearer the previous via/stop first). No new A* state needed. Then `traceWithVias` is unchanged.
- UI: in via mode, clicking a *road* (not empty map) opens the way popup that divergences already use
  (the one with `oneway`/`bus=yes` tag editing) with two more buttons: *bus uses this road* / *bus doesn't*.
  Show avoided ways hatched, required ways solid, same colour as vias.
- *Fix relation → changes* and `/api/relation` take `avoid`/`require` as they take `via`; the proposed relation
  follows them. `web/merge.js` builds its proposal through the same `traceWith`, so it inherits them.

**Proves it.**
- `tests/test_flagstop.py`: a pattern whose shape runs down way A; with `avoid=[A]` the trace uses the parallel
  way B and reports a divergence over A with reason *excluded by you*; with `require=[C]` (a way the shape never
  touches) the legs include C.
- `tests/router_cases.json` gets one case with constraints, so `router_parity` covers them in both languages.
- Reload the page: constraints and the re-routed path are still there.

---

## 2. Stop positions as part of a stop, not a footnote

**Why.** README "Not yet": `stop_position` nodes are ignored in matching. `review.stop_positions()` picks the
nearest one within 25 m whose nearest platform is this one — distance only, no name, no side of road, no
one-to-one guarantee. Relatify's `bus_collection_builder.py` treats platform + stop position (+ stop area) as one
*collection* chosen by area → name → best-of-each; the fork's `stop_areas.py` / `static/js/stopPositions.js`
extend that to creating them. Your end goal (correct PTv2 relations everywhere) needs every stop to have its
position on the road, in order, before the platform.

**Where.**
- `tool/review.py` `stop_positions(feed, traced, match, osm_stops, g, stop_areas, near=25)` (l.149) and its
  mirror `web/router.js` `stopPositions()` (l.572–619) — parity-tested.
- `tool/stops.py` — `alike()` (l.68), `bearing()` (l.365), and the side-of-road logic behind `test_sides` /
  `test_across` (test_flagstop.py l.107–112), already decides "across the street"; reuse it here.
- `web/station.js` l.258–283 — already creates a stop position on a way (tag a plain existing point, else insert
  2 m from a junction/tagged point via `Roads.insert`), with `Roads.commit` for undo. Generalise, don't duplicate.
- `web/review.js` — Check stops' per-stop diff rows (l.38–47 `pick`, l.153 apply).
- `web/app.js` l.363/371, l.1000 — OSM-only and nearby lists filter `stop_position` out.

**Build.**
- Matching: a stop position belongs to a platform when it's within `near`, on a way the route drives, on the
  platform's side of the road (bearing of the way at the node vs. bearing platform→node), and the names agree
  when both have one (`alike`). Assign one-to-one, nearest first (greedy is enough; relatify's Hungarian
  assignment is overkill at bus-stop density). Record the reason when none qualifies: *none within 25 m*,
  *the one there is across the street*, *named for another stop*.
- Proposals: a matched platform with no stop position gets a ticked row in Check stops, *add stop position on
  <way>*, using the station.js insertion code moved to `roads.js` (e.g. `Roads.stopPositionFor(t, platform,
  wayId, point, tags)`). Name and `local_ref` copied from the platform, `bus=yes`, `public_transport=stop_position`.
- Removal: when a platform is removed (*It's gone*, OSM-only), offer its orphaned stop position in the same
  step, as station.js does for unused ones (l.286–289).
- OSM-only: list stop positions no route and no platform claims (today they're filtered out and never offered).
- Stop areas: when a platform and its position are both known and no `stop_area` groups them, offer one (the
  station card does this for stations; a plain stop needs the same, smaller).

**Proves it.**
- Fixture: one road, two platforms either side, two stop positions in the carriageway; each platform gets its
  own, and swapping their names makes the far one *named for another stop*.
- A stop position 10 m away but on a way the route doesn't drive isn't taken.
- Snapshot (`tests/snapshot.py`) shows which CVTD stops gained a position and from where.

---

## 3. Pin the upload path with tests

**Why.** Relatify's public trouble ([community thread](https://community.openstreetmap.org/t/what-is-osm-relatify-and-is-there-a-problem-with-it/121526))
was duplicated ways and broken parent relations from uploading over stale Overpass data. flagstop's design is
right — re-read every object before upload (`Edits.check()`), repair every parent relation on a split
(`Roads.repair`), overlay what went up until OSM has it — but the 25 Python tests cover the matching rules,
and nothing runs the JS edit basket at all. This is the code that, when wrong, gets a tool asked to stop.

**Where.**
- `web/edits.js` — `modify()` (l.134, builds on `uploaded[].newVersion`), `level0()` (l.215), `check()` (l.289),
  `upload()` (l.320), the osmChange builder.
- `web/roads.js` — `split()` (l.98), `orderFrom()` (l.174), `chain()` (l.183), `repair()` (l.216–280: PT routes
  re-chained, restriction `from`/`to` keep the piece at `via`, other relations get every piece in order).
- `tests/router_parity.js` is the only Node test and the pattern to follow: plain `node`, no dependencies,
  `module.exports` guard at the bottom of the module (router.js l.643).

**Build.**
- Give `edits.js` and `roads.js` the same `if (typeof module !== 'undefined') module.exports = …` guard, with
  the few DOM/`fetch`/`Edits`↔`Roads` references injectable (pass `fetch` and the live-data loader in, default to
  the globals).
- `tests/edits_test.js`, run by `node`, covering at least:
  1. osmChange: create node/way/relation with negative ids; a relation member referencing a `new:n` key resolves
     to the placeholder; `version` is carried on every modify/delete; `changeset` placeholder on all.
  2. Split a way at an interior node → the longer piece keeps the id; a PT relation through it lists both pieces
     in travel order; a one-way split keeps direction; a `type=restriction` with the way as `from` keeps the
     piece touching `via`; an unrelated relation (boundary, say) gets all pieces, in place.
  3. Split at a way's own end node throws (l.100), split of a closed way throws.
  4. `check()` with a mocked API returning a higher `version` for one object aborts with that object named, and
     nothing is uploaded.
  5. After a successful mocked upload, `modify()` on the same object starts from `newVersion` and the uploaded
     tags, not the pre-upload base.
  6. `repair()` where the gap exceeds `GAP_LIMIT` (800 m) reports `bad` rather than guessing.
- Python side: a test that every `web/data/rel-*.osm` from a build parses, each stop's `stop` member precedes its
  `platform` member, and no way member repeats consecutively.
- Wire both into `.github/workflows/publish.yml` before the build step (and the README's Tests section).

**Proves it.** The tests themselves; failing any one blocks publish.

---

## 4. Left-hand traffic

*Done: `review.kerb_side` finds the side from OSM's coded stops (10-07), then the agency's time zone (`zone_side`);
`--left`/`--right` override it; stored as `positions.kerb` in `review.json`.*

**Why.** CVTD is right-hand traffic and so are the assumptions in "across the street" (`stops.py` sides/bearing),
`review.stop_positions`, and relatify had the same gap (its fork added `driving_side.py`). The first non-US
feed will match every stop to the wrong side.

**Where.** `tool/stops.py` side logic (behind `test_sides`/`test_across`), `tool/review.py stop_positions`,
`web/router.js stopPositions`, and the station card's "which side of the road is the bay" (`station.js`).

**Build.** One `driving_side` for the feed: from `feed_info.feed_lang`/`agency_timezone` country → a short LHT
country list, overridable by `--left`/`--right` on `review.py` and stored in `review.json`. Every side test reads
it; nothing hard-codes right.

**Proves it.** Run the existing `test_sides`/`test_across` cases mirrored (swap lon offsets) under `left` and
expect the mirrored answers.

---

## 5. Turn restrictions with a way as via

**Why.** README "Not yet". Restrictions like *no U-turn via this short link way* are the common kind at bus
loops and terminals — exactly where flagstop's routed path most needs to be right.

**Where.** `tool/routes.py restrictions()` (l.137) and `router.js` l.122–127 skip any restriction whose `via`
isn't a single node. `Graph.astar` keys state by node (plus the `no_first`/`no_last` exceptions).

**Build.** Pre-expand each way-via restriction into a node-via one at the junction of the via way and the `to`
way, conditioned on having arrived along the via way from `from`. In A*, carry the previous way in the state key
only for nodes that are the far end of some via way (a small set), so the search stays node-keyed elsewhere.
Same change in both routers; parity test.

**Proves it.** A unit case: a `from` way, a 30 m via way, a `to` way with `no_u_turn`; the path goes round the
block instead. The existing `test_no_right_turn_goes_round` / `test_except_bus` (l.157–163) show the shape.

---

## Smaller borrowings

- **Roundtrip sanity** (relatify `_check_for_roundtrip_not_roundtrip`): `compare.proposed_relation_tags` sets
  `roundtrip=yes` (l.278); add an audit line when a relation is tagged `roundtrip=yes` but its routed geometry
  doesn't close within 50 m, or vice versa.
- **Unused member ways** (relatify `_check_for_unused_ways`): `compare.audit` reports member ways off the line;
  make sure it also names ways that are *on* the line but that the routed path never drove (a stub left from an
  old alignment).
- **Route masters**: `merge.js` removes a deleted relation from its master; `compare.proposed_master_tags`
  exists. The fork's `route_masters.py` is the reference for the rest: create the master when a route has ≥2
  patterns and OSM has none; add a new direction relation to it; audit masters that list a relation flagstop
  would delete.
- **Version in the page** (fork): show the build's date/commit in the footer; the published page is rebuilt
  daily and a mapper should be able to say which build they used in a changeset discussion.

## Not borrowed, on purpose

- Relatify's server (FastAPI, scikit-learn, scipy, Cython, Sentry). flagstop's zero-dependency Python + static
  page is a feature: it publishes to GitHub Pages and anyone can run it.
- Click-to-pick-every-way as the *primary* interaction. Item 1 adds it as an override; the shape-guided router
  stays the default.
- Tile-based incremental download (relatify `download_triggers`). Per-route roads fetching already bounds the
  query; revisit only if a route's bbox gets too big for Overpass.
- NaPTAN. UK-specific; the general shape (external stop ids → tags) is what `gtfs:*` already does.

## Still outside both tools

Free-hand geometry editing — move any node, redraw any way. flagstop moves geometry only inside a card that
justified it (junction arms in `roads.js`, stop moves in Check stops) and hands the rest to RapiD with the
agency line as an overlay. Neither relatify does geometry at all. If "moving nodes, fixing ways" means more
than the card-driven cases, that's a separate UI project, and the RapiD handoff is the right answer until it
exists.
