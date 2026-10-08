"""Bring the cached OSM data up to date with changesets, from OSM's own API: seconds, and current to the
second, where Overpass takes minutes and runs a minute or two behind (an upload's refresh used to show the
upload undone).

    python3 tool/patch.py <changeset id> [...]      patch cache/*-osm-pt.json and *-osm-roads.json in place
    python3 tool/patch.py --since-base             every changeset over the feed's area since the data's own time
                                                   (a day-old regional extract, caught up to now)

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


class _Index:
    """An Overpass JSON's elements by (type, id), and how many of its ways hold each node, kept up to date as
    elements are replaced, added and removed: a big city's roads are millions of elements, too many to look
    through again for every element a changeset changes. A removed element leaves a gap (None) until close()."""
    def __init__(self, data):
        self.els = data['elements']
        self.at = {}                 # (type, id) -> its positions in els (two copies of one: the last counts)
        self.nodes = {}              # node id -> how many node elements there are of it
        self.held = {}               # node id -> how many ways hold it
        for i, e in enumerate(self.els):
            self._add(i, e)

    def _add(self, i, e):
        self.at.setdefault((e['type'], e['id']), []).append(i)
        if e['type'] == 'node':
            self.nodes[e['id']] = self.nodes.get(e['id'], 0) + 1
        elif e['type'] == 'way':
            for nd in set(e.get('nodes', [])):
                self.held[nd] = self.held.get(nd, 0) + 1

    def _drop(self, e):
        if e['type'] == 'node':
            self.nodes[e['id']] -= 1
        elif e['type'] == 'way':
            for nd in set(e.get('nodes', [])):
                self.held[nd] -= 1

    def get(self, key):
        at = self.at.get(key)
        return at[-1] if at else None

    def append(self, e):
        self.els.append(e)
        self._add(len(self.els) - 1, e)

    def put(self, i, e):
        self._drop(self.els[i])
        self.els[i] = e
        self.at[(e['type'], e['id'])].remove(i)
        self._add(i, e)
        self.at[(e['type'], e['id'])].sort()

    def remove(self, i):
        e = self.els[i]
        self._drop(e)
        self.at[(e['type'], e['id'])].remove(i)
        self.els[i] = None

    def has_node(self, nid):
        return self.nodes.get(nid, 0) > 0

    def holds(self, nid):
        return self.held.get(nid, 0) > 0

    def close(self):
        self.els[:] = [e for e in self.els if e is not None]


def apply(pt, roads, cs_list, fill=True):
    """Patch the two Overpass JSON caches in place. fill: give pt every road its routes list (not for a roads file
    patched alone, whose pt is a throwaway). -> how many elements changed."""
    n, latest = 0, None
    ix = {id(pt): _Index(pt), id(roads): _Index(roads)}
    for cs in sorted(cs_list, key=int):   # in the order they were made
        ch, closed = changes(cs)
        latest = max(filter(None, [latest, closed]))
        ch_nodes = {}
        for _, x in ch:
            if x['type'] == 'node':
                ch_nodes.setdefault(x['id'], []).append(x)
        for action, el in ch:
            key = (el['type'], el['id'])
            P, R = ix[id(pt)], ix[id(roads)]
            for data, wanted in ((pt, is_pt(el) or P.get(key) is not None), (roads, (el['type'] == 'way' and el['tags'].get('highway') in ROADS) or R.get(key) is not None
                                                                         or (el['type'] == 'node' and R.holds(el['id'])))):
                X = ix[id(data)]
                i = X.get(key)
                # a changeset older than what the cache has for this object (given out of order) doesn't undo it
                if i is not None and (data['elements'][i].get('version') or 0) >= el['version'] and action != 'delete':
                    continue
                if action == 'delete':
                    if i is not None:
                        X.remove(i); n += 1
                elif wanted:
                    rec = dict(el)
                    if data is roads and el['type'] == 'node':
                        rec = {'type': 'node', 'id': el['id'], 'lat': el['lat'], 'lon': el['lon']}   # roads keep bare nodes
                    if i is None:
                        X.append(rec)
                    else:
                        X.put(i, rec)
                    n += 1
            # a new or changed way's nodes, so it can be drawn and routed
            if action != 'delete' and el['type'] == 'way':
                for data in (pt, roads):
                    X = ix[id(data)]
                    if X.get(key) is not None:
                        for nid in el['nodes']:
                            if X.has_node(nid):
                                continue
                            for e in ch_nodes.get(nid, []):
                                X.append({'type': 'node', 'id': nid, 'lat': e['lat'], 'lon': e['lon']})
    for X in ix.values():
        X.close()
    if fill:
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


BIG = 10000   # changes: a changeset this big over the area is an import or a bot's, mostly elsewhere; read, it's slow


def since(base, bbox):
    """Closed changesets whose box meets the area (south, west, north, east), made since `base` (an ISO time), oldest
    first. The API gives 100 at a time, newest first: page back by time."""
    s_, w, n_, e = bbox
    out, until = {}, None
    while True:
        q = f"bbox={w},{s_},{e},{n_}&closed=true&time={base}" + (f",{until}" if until else '')
        cs = json.loads(get(f'{API}/changesets.json?{q}'))['changesets']
        new = [c for c in cs if c['id'] not in out]
        for c in new:
            out[c['id']] = c
        if len(cs) < 100 or not new:
            break
        until = min(c['created_at'] for c in cs)
    big = [c['id'] for c in out.values() if (c.get('changes_count') or 0) > BIG]
    if big:
        print(f'patch: left out {len(big)} changeset{"s" if len(big) > 1 else ""} of over {BIG} changes: {", ".join(map(str, big))}', file=sys.stderr)
    return sorted(i for i, c in out.items() if i not in big)


def main(argv):
    cache = os.environ.get('FLAGSTOP_CACHE') or os.path.join(ROOT, 'cache')   # a sandbox run keeps its files apart
    newest = lambda pat: max(glob.glob(os.path.join(cache, pat)), key=os.path.getmtime)
    ids = [int(x) for x in argv if x.isdigit()]
    if '--since-base' in argv:
        # the data's own time, and its area: every changeset since, over it
        p = newest('*-osm-pt.json')
        base = (json.load(open(p)).get('osm3s') or {}).get('timestamp_osm_base')
        box = json.load(open(p + '.bbox')) if os.path.exists(p + '.bbox') else None
        if not base or not box:
            raise SystemExit(f'patch: {os.path.basename(p)} has no time or no area (.bbox) to catch up from')
        ids = since(base, box)
        print(f'patch: {len(ids)} changeset{"s" if len(ids) != 1 else ""} over the area since {base}', file=sys.stderr)
        if not ids:
            return
    if not ids:
        raise SystemExit(__doc__)
    # the stops-and-routes data, and every roads file: the whole area's (if any) and each route's (cache/roads/)
    pt_path = newest('*-osm-pt.json')
    road_paths = glob.glob(os.path.join(cache, '*-osm-roads.json')) + glob.glob(os.path.join(cache, 'roads', '*.json'))
    pt = json.load(open(pt_path))
    # each changeset read once, several at a time: the API is the slow part, not the patching
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(changes, ids))
    n = 0
    every = []   # every roads file's elements once patched: where a route's roads are found, before asking the API
    for rp in road_paths:
        roads = json.load(open(rp))
        n += apply({'elements': []}, roads, ids, fill=False)
        every += roads['elements']
        json.dump(roads, open(rp + '.tmp', 'w')); os.replace(rp + '.tmp', rp)
    n += apply(pt, {'elements': every}, ids)
    json.dump(pt, open(pt_path + '.tmp', 'w')); os.replace(pt_path + '.tmp', pt_path)
    print(f'patched {n} elements from changeset{"s" if len(ids) > 1 else ""} {", ".join(map(str, ids))}', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
