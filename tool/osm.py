"""OpenStreetMap, as much of it as a route review needs, from Overpass: the bus stops and route
relations already mapped, and the roads a bus could drive.

    pt    = fetch_pt(bbox)      # or load('cache/osm-pt.json')
    roads = fetch_roads(bbox)   # or load('cache/osm-roads.json')

Both are the raw Overpass JSON; `parse_pt` and `Graph` (in routes.py) read them.
"""
import json, os, sys, time, urllib.parse, urllib.request

OVERPASS = os.environ.get('OVERPASS_URL', 'https://overpass-api.de/api/interpreter')

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
);
out meta;
>;
out meta;
"""

# Everything a bus might be driven on. Footways, paths and rail are left out; a route that uses a
# service road or a parking aisle to reach a stop still needs those.
ROADS_QUERY = """[out:json][timeout:300];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road)$"]({bbox});
out body;
>;
out skel qt;
"""


def _bbox(b):
    s, w, n, e = b
    return f'{s:.5f},{w:.5f},{n:.5f},{e:.5f}'


def fetch(query, tries=3):
    data = urllib.parse.urlencode({'data': query}).encode()
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(OVERPASS, data=data, headers={'User-Agent': 'flagstop (GTFS/OSM route review)'}), timeout=400) as r:
                return json.load(r)
        except Exception as e:  # 429 / 504 when the public server is busy
            if i == tries - 1:
                raise
            print(f'overpass: {e}; retrying in {30 * (i + 1)}s', file=sys.stderr)
            time.sleep(30 * (i + 1))


def fetch_pt(bbox):
    return fetch(PT_QUERY.format(bbox=_bbox(bbox)))


def fetch_roads(bbox):
    return fetch(ROADS_QUERY.format(bbox=_bbox(bbox)))


def load(path):
    return json.load(open(path))


def save(obj, path):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    json.dump(obj, open(path, 'w'))


def cached(path, fetcher, bbox, refresh=False):
    if not refresh and os.path.exists(path):
        return load(path)
    print(f'overpass: fetching {os.path.basename(path)} for {_bbox(bbox)}', file=sys.stderr)
    obj = fetcher(bbox)
    save(obj, path)
    return obj


STOP_TAGS = ('highway', 'public_transport', 'bus', 'amenity')


def parse_pt(raw):
    """-> (stops, routes, masters, ways, nodes)

    stops:   {id: {id, type, lat, lon, tags}} for every stop-like object (a way/relation gets its centroid)
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
        return (tags.get('highway') == 'bus_stop' or tags.get('amenity') == 'bus_station'
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
                                        'version': w.get('version'), 'timestamp': w.get('timestamp'), 'user': w.get('user')}

    routes, masters = {}, {}
    for r in rels.values():
        t = r.get('tags', {})
        rec = {'id': r['id'], 'tags': t, 'members': r.get('members', []), 'version': r.get('version'), 'timestamp': r.get('timestamp'), 'user': r.get('user')}
        if t.get('type') == 'route_master':
            masters[r['id']] = rec
        elif t.get('type') == 'route':
            routes[r['id']] = rec

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
