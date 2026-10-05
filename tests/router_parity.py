"""Route every itinerary with tool/routes.py and web/router.js on the same roads; the answers must match.

    python3 tests/router_parity.py [roads.json]     (default: the whole-area roads in cache/)
"""
import glob, json, os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tool'))
import gtfs, osm, review, serve, routes as routing


def main(argv):
    roads_path = argv[0] if argv else (glob.glob(os.path.join(ROOT, 'cache', '*-osm-roads.json')) or [None])[0]
    feeds = glob.glob(os.path.join(ROOT, 'cache', '*.zip'))
    pt = glob.glob(os.path.join(ROOT, 'cache', '*-osm-pt.json'))
    if not (roads_path and feeds and pt):
        print('no roads, feed or OSM data in cache/: skipped'); return 0
    feed = gtfs.load(max(feeds, key=os.path.getmtime))
    osm_stops, *_ = osm.parse_pt(osm.load(pt[0]))
    stop_areas = list(getattr(osm.parse_pt, 'stop_areas', {}).values())
    rj = json.load(open(os.path.join(ROOT, 'web', 'data', 'review.json')))
    match = {k: s['match'] for k, s in rj['stops'].items()}
    g = routing.Graph(osm.load(roads_path))
    cases = {'roads': roads_path, 'osm_stops': {k: {'id': v['id'], 'lat': v['lat'], 'lon': v['lon'], 'tags': v['tags']} for k, v in osm_stops.items()},
             'stop_areas': stop_areas, 'match': match, 'patterns': []}
    for p in feed.patterns:
        cases['patterns'].append({'p': {'id': p.id, 'stops': p.stops, 'shape': feed.shapes.get(p.shape_id, [])},
                                  'stopsLL': {s: [feed.stops[s].lon, feed.stops[s].lat] for s in p.stops},
                                  'python': review.route_pattern(feed, p, g, match, osm_stops, stop_areas)})
    # the reviewer's say, on the first two itineraries with a path of three ways or more: keep off the middle way of
    # the path, drive a road near the line's middle that the path doesn't use, and go through a point on the line
    cases['constraints'] = []
    for c in cases['patterns']:
        ways, shape = c['python']['routed']['ways'], c['p']['shape']
        if len(ways) < 3 or len(shape) < 2:
            continue
        mid = tuple(shape[len(shape) // 2])
        avoid = [ways[len(ways) // 2]]
        require = [w for w in sorted(g.nearby_ways(mid, 150)) if w not in ways][:1]
        pts = [tuple(c['stopsLL'][s]) for s in c['p']['stops']]
        gg = g.patched(avoid=avoid)
        seq, pins = routing.fold_vias(gg, pts, [mid], require)
        res = routing.trace(gg, seq, shape, pins)
        cases['constraints'].append({'p': c['p'], 'stopsLL': c['stopsLL'], 'vias': [mid], 'avoid': avoid, 'require': require,
                                     'python': serve.trace_json(res, [mid], avoid, require)})
        if len(cases['constraints']) >= 2:
            break
    path = os.path.join(ROOT, 'cache', 'router_cases.json')
    json.dump(cases, open(path, 'w'))
    return subprocess.run(['node', os.path.join(ROOT, 'tests', 'router_parity.js'), path]).returncode


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
