"""Bring the cached OSM data up to date with changesets, from OSM's own API: seconds, and current to the
second, where Overpass takes minutes and runs a minute or two behind (an upload's refresh used to show the
upload undone).

    python3 tool/patch.py <changeset id> [...]      patch cache/*-osm-pt.json and *-osm-roads.json in place

Each changeset's osmChange (creates, modifies, deletes, with the new ids) is applied to both caches: stops
and relations to the stops-and-routes data, roads and their nodes to the roads data. A route that now runs
over a road the stops-and-routes data never had gets that road (and its nodes) from the roads data, or from
the API.
"""
import functools, glob, json, os, sys, urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.environ.get('OSM_API_URL', 'https://api.openstreetmap.org').rstrip('/') + '/api/0.6'   # OSM_API_URL: a sandbox (tool/sandbox.py)
UA = {'User-Agent': 'flagstop (GTFS/OSM route review)'}
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'busway',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road'}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


@functools.lru_cache(maxsize=None)   # each roads file is patched with the same changesets: fetch each once
def changes(cs):
    """-> [(action, element as Overpass JSON has it)], and when the changeset closed."""
    meta = ET.fromstring(get(f'{API}/changeset/{cs}')).find('changeset')
    root = ET.fromstring(get(f'{API}/changeset/{cs}/download'))
    out = []
    for block in root:
        for e in block:
            tags = {t.get('k'): t.get('v') for t in e.findall('tag')}
            el = {'type': e.tag, 'id': int(e.get('id')), 'version': int(e.get('version')), 'timestamp': e.get('timestamp'), 'user': e.get('user'), 'tags': tags}
            if e.tag == 'node' and e.get('lat') is not None:
                el['lat'], el['lon'] = float(e.get('lat')), float(e.get('lon'))
            if e.tag == 'way':
                el['nodes'] = [int(n.get('ref')) for n in e.findall('nd')]
            if e.tag == 'relation':
                el['members'] = [{'type': m.get('type'), 'ref': int(m.get('ref')), 'role': m.get('role')} for m in e.findall('member')]
            out.append((block.tag, el))
    return out, (meta.get('closed_at') or meta.get('created_at'))


def is_pt(el):
    t = el.get('tags', {})
    return (t.get('highway') == 'bus_stop' or t.get('amenity') == 'bus_station' or t.get('public_transport') in ('platform', 'stop_position', 'station', 'stop_area')
            or t.get('type') in ('route', 'route_master'))


def apply(pt, roads, cs_list):
    """Patch the two Overpass JSON caches in place. -> how many elements changed."""
    idx = lambda data: {(e['type'], e['id']): i for i, e in enumerate(data['elements'])}
    n, latest = 0, None
    for cs in sorted(cs_list, key=int):   # in the order they were made
        ch, closed = changes(cs)
        latest = max(filter(None, [latest, closed]))
        for action, el in ch:
            key = (el['type'], el['id'])
            for data, wanted in ((pt, is_pt(el) or key in idx(pt)), (roads, (el['type'] == 'way' and el['tags'].get('highway') in ROADS) or key in idx(roads)
                                                                     or (el['type'] == 'node' and any(el['id'] in w.get('nodes', []) for w in roads['elements'] if w['type'] == 'way')))):
                i = idx(data).get(key)
                # a changeset older than what the cache has for this object (given out of order) doesn't undo it
                if i is not None and (data['elements'][i].get('version') or 0) >= el['version'] and action != 'delete':
                    continue
                if action == 'delete':
                    if i is not None:
                        data['elements'].pop(i); n += 1
                elif wanted:
                    rec = dict(el)
                    if data is roads and el['type'] == 'node':
                        rec = {'type': 'node', 'id': el['id'], 'lat': el['lat'], 'lon': el['lon']}   # roads keep bare nodes
                    if i is None:
                        data['elements'].append(rec)
                    else:
                        data['elements'][i] = rec
                    n += 1
            # a new or changed way's nodes, so it can be drawn and routed
            if action != 'delete' and el['type'] == 'way':
                for data in (pt, roads):
                    have = {e['id'] for e in data['elements'] if e['type'] == 'node'}
                    if (el['type'], el['id']) in idx(data):
                        for nid, e in ((nid, x) for nid in el['nodes'] if nid not in have for a, x in ch if x['type'] == 'node' and x['id'] == nid):
                            data['elements'].append({'type': 'node', 'id': nid, 'lat': e['lat'], 'lon': e['lon']}); have.add(nid)
    complete(pt, roads)
    for data in (pt, roads):
        o = data.setdefault('osm3s', {})
        if latest and (o.get('timestamp_osm_base') or '') < latest:
            o['timestamp_osm_base'] = latest
    return n


def complete(pt, roads):
    """Every way a route relation lists, with its nodes, in the stops-and-routes data: from the roads data,
    else from the API."""
    have = {(e['type'], e['id']) for e in pt['elements']}
    want = {m['ref'] for e in pt['elements'] if e['type'] == 'relation' and e.get('tags', {}).get('type') == 'route'
            for m in e.get('members', []) if m['type'] == 'way' and ('way', m['ref']) not in have}
    if not want:
        return
    rw = {e['id']: e for e in roads['elements'] if e['type'] == 'way'}
    rn = {e['id']: e for e in roads['elements'] if e['type'] == 'node'}
    missing = [w for w in want if w not in rw]
    for i in range(0, len(missing), 100):
        for e in json.loads(get(f"{API}/ways.json?ways={','.join(map(str, missing[i:i + 100]))}"))['elements']:
            rw[e['id']] = e
    nodes_needed = set()
    for w in want:
        if w in rw:
            pt['elements'].append(rw[w]); nodes_needed |= set(rw[w]['nodes'])
    nodes_needed -= {e['id'] for e in pt['elements'] if e['type'] == 'node'}
    from_api = [n for n in nodes_needed if n not in rn]
    for i in range(0, len(from_api), 200):
        for e in json.loads(get(f"{API}/nodes.json?nodes={','.join(map(str, from_api[i:i + 200]))}"))['elements']:
            rn[e['id']] = e
    for nid in nodes_needed:
        if nid in rn:
            pt['elements'].append({'type': 'node', 'id': nid, 'lat': rn[nid]['lat'], 'lon': rn[nid]['lon']})


def main(argv):
    ids = [int(x) for x in argv if x.isdigit()]
    if not ids:
        raise SystemExit(__doc__)
    cache = os.environ.get('FLAGSTOP_CACHE') or os.path.join(ROOT, 'cache')   # a sandbox run keeps its files apart
    newest = lambda pat: max(glob.glob(os.path.join(cache, pat)), key=os.path.getmtime)
    # the stops-and-routes data, and every roads file: the whole area's (if any) and each route's (cache/roads/)
    pt_path = newest('*-osm-pt.json')
    road_paths = glob.glob(os.path.join(cache, '*-osm-roads.json')) + glob.glob(os.path.join(cache, 'roads', '*.json'))
    pt = json.load(open(pt_path))
    n = 0
    for i, rp in enumerate(road_paths or [None]):
        roads = json.load(open(rp)) if rp else {'elements': []}
        n += apply(pt, roads, ids) if i == 0 else apply({'elements': []}, roads, ids)
        if rp:
            json.dump(roads, open(rp + '.tmp', 'w')); os.replace(rp + '.tmp', rp)
    json.dump(pt, open(pt_path + '.tmp', 'w')); os.replace(pt_path + '.tmp', pt_path)
    print(f'patched {n} elements from changeset{"s" if len(ids) > 1 else ""} {", ".join(map(str, ids))}', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
