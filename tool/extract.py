#!/usr/bin/env python3
"""OSM for the review from a regional extract (Geofabrik), not Overpass: what the published build uses.

Overpass is the right tool for a question asked now and then, and a public one is often busy. A build that runs
every day can read a file instead: the smallest Geofabrik region holding the feed's area (Utah for CVTD, 170 MB),
downloaded once, kept, and brought up to date each day with Geofabrik's daily changes (a few MB); a feed that
crosses a state line reads each state's (CVTD: Utah and Idaho, for Preston). What it holds
is a day old at most, as the published page is; your own uploads, and what's live on a route you open, come
from OSM's API on the page as before.

    python3 tool/extract.py FEED.zip [--cache cache]

writes what the review reads from its cache, as Overpass gives it (tool/osm.py's queries): the stops and routes
(<slug>-osm-pt.json), and each itinerary's roads (roads/<it>.json). Then: review.py FEED.zip --no-overpass.
Needs pyosmium (pip install osmium). Public extracts carry no user names: the page says when a stop was edited,
not by whom (the history checks read OSM's API, which does).
"""
import argparse, json, os, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtfs, osm

INDEX = 'https://download.geofabrik.de/index-v1.json'
UA = {'User-Agent': 'flagstop (GTFS/OSM route review)'}
ROADS = set(osm.ROAD_CLASSES.split('|'))
PT_ROUTES = {'bus', 'trolleybus', 'share_taxi'}


def get(url, path):
    """Download url to path, a piece at a time (the extract is hundreds of MB)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r, open(path + '.part', 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(path + '.part', path)


def _inside(pt, rings):
    """pt (lon, lat) in a polygon: its outer ring (rings[0]) and not in a hole."""
    def ring(r):
        x, y, c = pt[0], pt[1], False
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c
    return ring(rings[0]) and not any(ring(h) for h in rings[1:])


def regions(points, cache_dir, index=None):
    """The Geofabrik regions to read: for each point (lon, lat), the smallest region holding it, and so as few
    regions as cover where the routes go (a feed crossing a state line: both states, not the whole country).
    [{'id', 'pbf', 'updates'}]. index: Geofabrik's index (GeoJSON), else fetched and kept a week."""
    if index is None:
        path = os.path.join(cache_dir, 'geofabrik', 'index-v1.json')
        if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 7 * 86400:
            get(INDEX, path)
        index = json.load(open(path))
    regs = []
    for f in index['features']:
        g, u = f.get('geometry') or {}, f['properties'].get('urls', {})
        if not u.get('pbf') or g.get('type') not in ('Polygon', 'MultiPolygon'):
            continue
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        xs = [x for p in polys for x, _ in p[0]]; ys = [y for p in polys for _, y in p[0]]
        regs.append(((max(xs) - min(xs)) * (max(ys) - min(ys)), (min(xs), min(ys), max(xs), max(ys)), polys,
                     {'id': f['properties']['id'], 'pbf': u['pbf'], 'updates': u.get('updates')}))
    regs.sort(key=lambda r: r[0])
    out = {}
    for pt in {(round(x / 0.05) * 0.05, round(y / 0.05) * 0.05) for x, y in points}:   # ~5 km apart is plenty
        for _, (x0, y0, x1, y1), polys, info in regs:
            if x0 <= pt[0] <= x1 and y0 <= pt[1] <= y1 and any(_inside(pt, p) for p in polys):
                out[info['id']] = info
                break
        else:
            raise RuntimeError(f'no Geofabrik region holds {pt}')
    return sorted(out.values(), key=lambda r: r['id'])


def fetch(reg, cache_dir, log=print):
    """The region's extract, kept in cache_dir/geofabrik/: brought up to date with its daily changes when there's
    a copy (a few MB, not hundreds), downloaded when there isn't (or the changes can't be applied)."""
    import osmium
    from osmium.replication.server import ReplicationServer
    from osmium.replication.utils import get_replication_header
    path = os.path.join(cache_dir, 'geofabrik', reg['id'].replace('/', '-') + '.osm.pbf')
    if os.path.exists(path):
        try:
            h = get_replication_header(path)
            with ReplicationServer(h.url or reg['updates']) as srv:
                new = path + '.new.pbf'
                if os.path.exists(new):
                    os.remove(new)
                done = srv.apply_diffs_to_file(path, new, h.sequence + 1, max_size=200 * 1024)
                if done:
                    os.replace(new, path)
                    log(f'extract: {reg["id"]} brought up to change {done[0]} ({done[1]})')
                else:
                    log(f'extract: {reg["id"]} already up to date')
            return path
        except Exception as e:
            log(f'extract: {reg["id"]}: changes not applied ({e}); downloading it again')
    log(f'extract: downloading {reg["pbf"]}')
    get(reg['pbf'], path)
    return path


def is_pt(t):
    """What tool/osm.py's PT_QUERY asks for, by its tags."""
    return (t.get('highway') == 'bus_stop' or t.get('amenity') == 'bus_station'
            or (t.get('public_transport') == 'platform' and (t.get('bus') == 'yes' or t.get('highway') == 'bus_stop'))
            or (t.get('public_transport') in ('stop_position', 'station') and t.get('bus') == 'yes'))


def read(path, bbox):
    """The extract's stops and routes and roads in bbox, as Overpass gives them for tool/osm.py's queries:
    (pt, roads), each {'osm3s': {'timestamp_osm_base'}, 'elements': [...]}. Two passes: the relations (a route, a
    stop area, a route master, a restriction), then nodes and ways with their positions."""
    import osmium
    import osmium.filter as F
    s, w, n, e = bbox
    inbox = lambda lat, lon: s <= lat <= n and w <= lon <= e
    meta = lambda o: {'version': o.version, 'timestamp': o.timestamp.strftime('%Y-%m-%dT%H:%M:%SZ') if o.timestamp else None}
    tags = lambda o: {t.k: t.v for t in o.tags}
    # 1. the relations that might matter, wherever they are
    rels = {}
    for r in osmium.FileProcessor(path, osmium.osm.RELATION):
        t = tags(r)
        kind = 'route' if t.get('type') == 'route' and t.get('route') in PT_ROUTES else t.get('type') if t.get('type') in ('route_master', 'restriction') else \
            'stop_area' if t.get('public_transport') == 'stop_area' else None
        if kind:
            rels[r.id] = {'kind': kind, 'type': 'relation', 'id': r.id, 'tags': t, **meta(r),
                          'members': [{'type': {'n': 'node', 'w': 'way', 'r': 'relation'}[m.type], 'ref': m.ref, 'role': m.role} for m in r.members]}
    want_ways = {m['ref'] for x in rels.values() if x['kind'] in ('route', 'stop_area') for m in x['members'] if m['type'] == 'way'}
    want_nodes = {m['ref'] for x in rels.values() if x['kind'] in ('route', 'stop_area') for m in x['members'] if m['type'] == 'node'}
    # 2. nodes and ways, with every way's node positions (untagged nodes are positions only)
    nodes, ways, at = {}, {}, {}
    pt_nodes, pt_ways, road_ways = set(), set(), set()
    for o in osmium.FileProcessor(path).with_locations().with_filter(F.EmptyTagFilter()):
        if o.is_node():
            t = tags(o)
            if (is_pt(t) and inbox(o.lat, o.lon)) or o.id in want_nodes:
                nodes[o.id] = {'type': 'node', 'id': o.id, 'lat': o.lat, 'lon': o.lon, 'tags': t, **meta(o)}
                if is_pt(t) and inbox(o.lat, o.lon):
                    pt_nodes.add(o.id)
        elif o.is_way():
            t = tags(o)
            pts = [(x.ref, x.lat, x.lon) for x in o.nodes if x.location.valid()]
            here = any(inbox(la, lo) for _, la, lo in pts)
            road, pt = t.get('highway') in ROADS and here, is_pt(t) and here
            if road or pt or o.id in want_ways:
                ways[o.id] = {'type': 'way', 'id': o.id, 'nodes': [x.ref for x in o.nodes], 'tags': t, **meta(o)}
                for ref, la, lo in pts:
                    at[ref] = (la, lo)
                if road:
                    road_ways.add(o.id)
                if pt:
                    pt_ways.add(o.id)
    # which relations are in the area: a member in it (Overpass's relation(bbox))
    here = lambda x: any((m['type'] == 'node' and m['ref'] in pt_nodes) or (m['type'] == 'way' and (m['ref'] in road_ways or m['ref'] in pt_ways)) for m in x['members'])
    routes = {i: x for i, x in rels.items() if x['kind'] == 'route' and here(x)}
    masters = {i: x for i, x in rels.items() if x['kind'] == 'route_master' and any(m['type'] == 'relation' and m['ref'] in routes for m in x['members'])}
    areas = {i: x for i, x in rels.items() if x['kind'] == 'stop_area' and here(x)}
    clean = lambda x: {k: v for k, v in x.items() if k != 'kind'}
    # the stops and routes, and down: every member, every member way's nodes (Overpass's '>;')
    top = list(routes.values()) + list(masters.values()) + list(areas.values())
    w_ids = set(pt_ways) | {m['ref'] for x in routes.values() for m in x['members'] if m['type'] == 'way'} | {m['ref'] for x in areas.values() for m in x['members'] if m['type'] == 'way'}
    n_ids = set(pt_nodes) | {m['ref'] for x in top for m in x['members'] if m['type'] == 'node'} | {r for i in w_ids if i in ways for r in ways[i]['nodes']}
    stamp = None
    try:
        r = osmium.io.Reader(path, osmium.osm.osm_entity_bits.NOTHING)
        stamp = r.header().get('osmosis_replication_timestamp'); r.close()
    except Exception:
        pass
    osm3s = {'timestamp_osm_base': stamp, 'copyright': 'OpenStreetMap contributors, ODbL; extract by Geofabrik'}
    node_el = lambda i: nodes[i] if i in nodes else {'type': 'node', 'id': i, 'lat': at[i][0], 'lon': at[i][1]} if i in at else None
    pt = {'version': 0.6, 'generator': 'flagstop extract', 'osm3s': osm3s,
          'elements': [clean(x) for x in top] + [ways[i] for i in sorted(w_ids) if i in ways] + [x for x in (node_el(i) for i in sorted(n_ids)) if x]}
    road_nodes = {r for i in road_ways for r in ways[i]['nodes']}
    restr = [clean(x) for x in rels.values() if x['kind'] == 'restriction' and any(m['type'] == 'way' and m['ref'] in road_ways for m in x['members'])]
    roads = {'version': 0.6, 'generator': 'flagstop extract', 'osm3s': osm3s,
             'elements': [{k: v for k, v in ways[i].items() if k not in ('version', 'timestamp')} for i in sorted(road_ways)] + restr +
                         [{'type': 'node', 'id': i, 'lat': at[i][0], 'lon': at[i][1]} for i in sorted(road_nodes) if i in at]}
    return pt, roads


def merge(raws):
    """Several extracts' answers as one: what's near a border is in both (the newer version kept); the data is as
    old as the oldest."""
    if len(raws) == 1:
        return raws[0]
    els = {}
    for r in raws:
        for e in r['elements']:
            k = (e['type'], e['id'])
            if k not in els or (e.get('version') or 0) > (els[k].get('version') or 0):
                els[k] = e
    stamps = [r['osm3s'].get('timestamp_osm_base') for r in raws if r['osm3s'].get('timestamp_osm_base')]
    order = {'relation': 0, 'way': 1, 'node': 2}
    return {**raws[0], 'osm3s': {**raws[0]['osm3s'], 'timestamp_osm_base': min(stamps) if stamps else None},
            'elements': sorted(els.values(), key=lambda e: (order[e['type']], e['id']))}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('feed')
    ap.add_argument('--cache', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'cache'))
    a = ap.parse_args()
    import review   # its slug and file names: the review reads what this writes
    feed = gtfs.load(a.feed)
    box = gtfs.bbox(feed)
    slug = review.slug_of(feed)
    t0 = time.time()
    log = lambda m: print(m, file=sys.stderr)
    # where the routes go: the stops, and the agency's lines
    pts = [(st.lon, st.lat) for st in feed.stops.values()] + [q for sh in feed.shapes.values() for q in sh[::20]]
    regs = regions(pts, a.cache)
    parts = [read(fetch(reg, a.cache, log), box) for reg in regs]
    pt, roads = merge([x[0] for x in parts]), merge([x[1] for x in parts])
    reg = {'id': ' + '.join(r['id'] for r in regs)}
    osm.save(pt, os.path.join(a.cache, f'{slug}-osm-pt.json'))
    json.dump(list(box), open(os.path.join(a.cache, f'{slug}-osm-pt.json.bbox'), 'w'))
    d = os.path.join(a.cache, 'roads')
    os.makedirs(d, exist_ok=True)
    n = 0
    for p in feed.patterns:
        if p.temporary:
            continue
        one = type('F', (), {'patterns': [p], 'shapes': feed.shapes, 'stops': feed.stops})
        osm.save(osm.roads_near(roads, osm.corridors(one, step=100)), os.path.join(d, review.safe(p.id) + '.json'))
        n += 1
    log(f"extract: {reg['id']} as of {pt['osm3s']['timestamp_osm_base']}: {sum(1 for x in pt['elements'] if x['type'] == 'relation')} relations, "
        f"{sum(1 for x in roads['elements'] if x['type'] == 'way')} roads; {n} itineraries' roads ({time.time() - t0:.0f} s)")


if __name__ == '__main__':
    main()
