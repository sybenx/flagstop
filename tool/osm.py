"""OpenStreetMap, as much of it as a route review needs, from Overpass: the bus stops and route
relations already mapped, and the roads a bus could drive.

    pt    = fetch_pt(bbox)      # or load('cache/osm-pt.json')
    roads = fetch_roads(bbox)   # or load('cache/osm-roads.json')

Both are the raw Overpass JSON; `parse_pt` and `Graph` (in routes.py) read them.
"""
import json, os, sys, time, urllib.parse, urllib.request

# the main public server, then others: one busy server shouldn't stall a refresh
OVERPASS = [u for u in [os.environ.get('OVERPASS_URL')] if u] + ['https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']

# Stops and routes, with every member way's geometry so an existing relation can be drawn and scored.
PT_QUERY = """[out:json][timeout:180];
relation["type"="route"]["route"~"^(bus|trolleybus|share_taxi)$"]({bbox})->.routes;
(
  .routes;
  // A route_master holds only relations, so it has no geometry for a bbox to find: reach it from its routes.
  relation(br.routes)["type"="route_master"];
  nwr["highway"="bus_stop"]({bbox});
  nwr["public_transport"="platform"]["bus"="yes"]({bbox});
  nwr["public_transport"="platform"]["highway"="bus_stop"]({bbox});
  nwr["public_transport"="stop_position"]["bus"="yes"]({bbox});
  nwr["amenity"="bus_station"]({bbox});
  nwr["public_transport"="station"]["bus"="yes"]({bbox});
  // what groups a station's parts
  relation["public_transport"="stop_area"]({bbox});
);
out meta;
>;
out meta;
"""

# Everything a bus might be driven on. Footways, paths and rail are left out; a route that uses a
# service road or a parking aisle to reach a stop still needs those.
ROADS_QUERY = """[out:json][timeout:300];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road)$"]({bbox})->.roads;
.roads out body;
// turns a bus may not make (or must)
relation(bw.roads)["type"="restriction"];
out body;
.roads >;
out skel qt;
"""


def _bbox(b):
    s, w, n, e = b
    return f'{s:.5f},{w:.5f},{n:.5f},{e:.5f}'


def fetch(query, tries=3):
    """Run an Overpass query: each server in turn, a short wait between rounds."""
    data = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for i in range(tries):
        for url in OVERPASS:
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=data, headers={'User-Agent': 'flagstop (GTFS/OSM route review)'}), timeout=90) as r:
                    j = json.load(r)
                # Overpass can answer 200 having given up part way ('runtime error: Query timed out', 'out of
                # memory'): what came back is part of the answer, and taken as all of it, stops OSM has would
                # read as missing. Not an answer: the next server.
                remark = j.get('remark') or ''
                if 'error' in remark.lower() or 'timed out' in remark.lower():
                    raise RuntimeError(f'gave up part way: {remark.strip()[:200]}')
                return j
            except Exception as e:   # 429 / 504 / timeouts when a public server is busy
                last = e
                print(f'overpass: {url.split("/")[2]}: {e}', file=sys.stderr)
        if i < tries - 1:
            print(f'overpass: all busy; again in {20 * (i + 1)}s', file=sys.stderr)
            time.sleep(20 * (i + 1))
    raise last


def fetch_pt(bbox):
    return fetch(PT_QUERY.format(bbox=_bbox(bbox)))


NOTES_API = os.environ.get('OSM_API_URL', 'https://api.openstreetmap.org').rstrip('/') + '/api/0.6/notes.json'   # OSM_API_URL: a sandbox (tool/sandbox.py)


def fetch_notes(bbox):
    """Open OSM notes in the box: what other people reported (a stop that isn't where it's mapped, a sign gone)."""
    s, w, n, e = bbox
    url = f'{NOTES_API}?bbox={w:.5f},{s:.5f},{e:.5f},{n:.5f}&closed=0&limit=10000'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'flagstop (GTFS/OSM route review)'}), timeout=120) as r:
            return json.load(r)
    except Exception as ex:
        print(f'notes: {ex}; none shown', file=sys.stderr)
        return {'features': []}


ROAD_CLASSES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road'
TILE = 0.005     # degrees (~550 m): the routes are covered by tiles this size and their neighbours, so every road
                 # within a tile or so of a line comes, not the whole county (a search around the lines is too slow)


def corridors(feed, step=80):
    """Each route's line (its shape, or its stops in order), thinned to a point every `step` metres: what the
    roads fetch follows."""
    import math
    lines, seen = [], set()
    for p in feed.patterns:
        pts = feed.shapes.get(p.shape_id) or [(feed.stops[s].lon, feed.stops[s].lat) for s in p.stops if s in feed.stops]
        key = (p.shape_id, len(pts))
        if len(pts) < 2 or key in seen:
            continue
        seen.add(key)
        out = [pts[0]]
        for x in pts[1:]:
            if math.hypot((x[0] - out[-1][0]) * 83000, (x[1] - out[-1][1]) * 111000) >= step:
                out.append(x)
        out.append(pts[-1])
        lines.append(out)
    return lines


def fetch_roads(bbox, feed=None):
    """The roads a bus could drive, near the routes (or in the whole box, without a feed), with the turn
    restrictions on them."""
    if not feed:
        return fetch(ROADS_QUERY.format(bbox=_bbox(bbox)))
    return fetch_roads_near(corridors(feed, step=100))


def fetch_roads_near(lines, tries=3):
    """The roads a bus could drive within a tile or so of these lines ([(lon, lat), ...] each), with the turn
    restrictions on them: what one route needs, in one small query."""
    cells = set()
    for line in lines:
        for lon, lat in line:
            i, j = int(lat // TILE), int(lon // TILE)
            cells |= {(i + di, j + dj) for di in (-1, 0, 1) for dj in (-1, 0, 1)}
    # neighbouring tiles in a row as one box: fewer, longer boxes are quicker for Overpass
    rows = {}
    for i, j in cells:
        rows.setdefault(i, []).append(j)
    boxes = []
    for i, js in rows.items():
        js.sort(); start = prev = js[0]
        for j in js[1:] + [None]:
            if j is not None and j == prev + 1:
                prev = j; continue
            boxes.append((i * TILE, start * TILE, (i + 1) * TILE, (prev + 1) * TILE))
            if j is not None:
                start = prev = j
    parts = ''.join(f'  way["highway"~"^({ROAD_CLASSES})$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});\n' for s, w, n, e in boxes)
    return fetch(tries=tries, query=f"""[out:json][timeout:300];
(
{parts})->.roads;
.roads out body;
relation(bw.roads)["type"="restriction"];
out body;
.roads >;
out skel qt;
""")


def load(path):
    return json.load(open(path))


def save(obj, path):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    json.dump(obj, open(path, 'w'))


def cached(path, fetcher, bbox, refresh=False):
    """What fetcher(bbox) gives, kept at path: fetched again when asked, or when the area asked for reaches outside
    the one it was fetched for (a new feed version serving a new town: its stops would read as missing)."""
    area = path + '.bbox'
    if not refresh and os.path.exists(path):
        try:
            s, w, n, e = json.load(open(area))
            inside = s <= bbox[0] and w <= bbox[1] and n >= bbox[2] and e >= bbox[3]
        except (OSError, ValueError):
            inside = True   # kept before areas were: taken as it is
        if inside:
            return load(path)
        print(f'overpass: {os.path.basename(path)} was fetched for a smaller area', file=sys.stderr)
    print(f'overpass: fetching {os.path.basename(path)} for {_bbox(bbox)}', file=sys.stderr)
    obj = fetcher(bbox)
    save(obj, path)
    json.dump(list(bbox), open(area, 'w'))
    return obj


NSI_BUS = 'https://raw.githubusercontent.com/osmlab/name-suggestion-index/main/data/transit/route/bus.json'


def nsi_aliases(network, path, refresh=False):
    """Other names the name-suggestion-index (what iD suggests from) knows for a bus network: its matchNames,
    e.g. 'cvtd' for Connect Public Transit. Lower case. Empty if NSI can't be reached and nothing is cached."""
    if refresh or not os.path.exists(path):
        try:
            with urllib.request.urlopen(urllib.request.Request(NSI_BUS, headers={'User-Agent': 'flagstop (GTFS/OSM route review)'}), timeout=60) as r:
                save(json.load(r), path)
        except Exception as e:
            print(f'name-suggestion-index: {e}; network aliases from the feed only', file=sys.stderr)
    if not os.path.exists(path):
        return set()
    out = set()
    for it in load(path).get('items', []):
        if it.get('tags', {}).get('network') == network:
            out |= {n.lower() for n in it.get('matchNames', [])} | {it['tags']['network'].lower()}
    return out


STOP_TAGS = ('highway', 'public_transport', 'bus', 'amenity')


def parse_pt(raw):
    """-> (stops, routes, masters, ways, nodes)   (stop areas: parse_pt.stop_areas, after a call)

    stops:   {id: {id, type, lat, lon, tags}} for every stop-like object (a way gets its centroid, and its
             node list, so it can be edited without losing its shape)
    routes:  {id: {id, tags, members:[{type, ref, role}]}} for type=route
    masters: same for type=route_master
    ways:    {id: {tags, nodes:[node ids]}}   member ways of the routes
    nodes:   {id: (lon, lat)}                 every node fetched
    """
    nodes, ways, rels = {}, {}, {}
    for el in raw.get('elements', []):
        if el['type'] == 'node':
            nodes[el['id']] = el
        elif el['type'] == 'way':
            ways[el['id']] = el
        elif el['type'] == 'relation':
            rels[el['id']] = el

    def is_stop(tags):
        return (tags.get('highway') == 'bus_stop' or tags.get('amenity') == 'bus_station' or (tags.get('public_transport') == 'station' and tags.get('bus') == 'yes')
                or (tags.get('public_transport') in ('platform', 'stop_position') and (tags.get('bus') == 'yes' or tags.get('highway') == 'bus_stop')))

    stops = {}
    for n in nodes.values():
        t = n.get('tags', {})
        if is_stop(t):
            stops[f"n{n['id']}"] = {'id': f"n{n['id']}", 'osm_id': n['id'], 'type': 'node', 'lat': n['lat'], 'lon': n['lon'], 'tags': t,
                                    'version': n.get('version'), 'timestamp': n.get('timestamp'), 'user': n.get('user')}
    for w in ways.values():
        t = w.get('tags', {})
        if is_stop(t):
            pts = [(nodes[i]['lon'], nodes[i]['lat']) for i in w.get('nodes', []) if i in nodes]
            if pts:
                stops[f"w{w['id']}"] = {'id': f"w{w['id']}", 'osm_id': w['id'], 'type': 'way', 'lon': sum(p[0] for p in pts) / len(pts), 'lat': sum(p[1] for p in pts) / len(pts), 'tags': t,
                                        'nodes': w.get('nodes', []), 'version': w.get('version'), 'timestamp': w.get('timestamp'), 'user': w.get('user')}

    routes, masters, areas = {}, {}, {}
    for r in rels.values():
        t = r.get('tags', {})
        rec = {'id': r['id'], 'tags': t, 'members': r.get('members', []), 'version': r.get('version'), 'timestamp': r.get('timestamp'), 'user': r.get('user')}
        if t.get('public_transport') == 'stop_area':
            areas[r['id']] = rec
        elif t.get('type') == 'route_master':
            masters[r['id']] = rec
        elif t.get('type') == 'route':
            routes[r['id']] = rec

    parse_pt.stop_areas = areas
    coords = {i: (n['lon'], n['lat']) for i, n in nodes.items()}
    wayrecs = {i: {'id': i, 'tags': w.get('tags', {}), 'nodes': w.get('nodes', [])} for i, w in ways.items()}
    return stops, routes, masters, wayrecs, coords


if __name__ == '__main__':
    stops, routes, masters, ways, nodes = parse_pt(load(sys.argv[1]))
    print(len(stops), 'stops', len(routes), 'route relations', len(masters), 'route_masters', len(ways), 'member ways')
    for r in sorted(routes.values(), key=lambda r: (r['tags'].get('ref', ''), r['id'])):
        t = r['tags']
        n_ways = sum(1 for m in r['members'] if m['type'] == 'way' and m['role'] == '')
        n_stops = sum(1 for m in r['members'] if m['role'].startswith(('platform', 'stop')))
        print(f"  r{r['id']:<10} ref={t.get('ref', ''):<6} {t.get('name', '')[:50]:<50} {n_ways:3d} ways {n_stops:3d} stops  ptv2={'yes' if t.get('public_transport:version') == '2' else 'no '} gtfs={t.get('gtfs:route_id') or t.get('gtfs:shape_id') or '-'}")
