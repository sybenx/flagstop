#!/usr/bin/env python3
"""A sandbox OpenStreetMap: the Cache Valley as it was before flagstop's first upload, served the way
api.openstreetmap.org, osm.org's sign-in and Overpass serve it, so the whole tool runs against it and every
edit lands here and nowhere else.

    python3 tool/sandbox.py snapshot [--date 2026-09-27T00:00:00Z] [--feed FEED.zip]   the area as of that date,
                                                                                      from Overpass attic -> cache/sandbox/base-<date>.json
    python3 tool/sandbox.py serve [--port 8766] [--base cache/sandbox/base-*.json]    the sandbox API; uploads go to cache/sandbox/changes.json
    python3 tool/sandbox.py run [--port 8765] [--sandbox-port 8766] [--reset] [--refresh]
                                            everything at once: the sandbox, the review built from it (its own files,
                                            under cache/sandbox/work/), tool/serve.py --sandbox: open the page and work
    python3 tool/sandbox.py reset                                                     forget every upload: the snapshot again
    python3 tool/sandbox.py status                                                    what has gone up, by changeset

What it answers (what the tool asks, in the shapes the real servers give):
    /api/0.6/{node,way,relation}/{id}.json            /api/0.6/{nodes,ways,relations}.json?ids
    /api/0.6/way/{id}/full.json                       /api/0.6/way/{id}/history.json
    /api/0.6/node/{id}/{ways,relations}.json          /api/0.6/map.json?bbox=l,b,r,t
    /api/0.6/changeset/create (PUT)                   /api/0.6/changeset/{id}/upload (POST osmChange -> diffResult)
    /api/0.6/changeset/{id}/close (PUT)               /api/0.6/changeset/{id}[.json][?include_discussion]  /download
    /api/0.6/changesets.json?user=                    /api/0.6/user/details.json        /api/0.6/notes.json
    /oauth2/authorize -> back with a code             /oauth2/token -> a token
    /api/interpreter (Overpass): the tool's own query shapes (tool/osm.py, web/app.js), answered from the data;
                                 any other query is a 400 naming it, so a new query is a gap here, not a wrong answer
Versions are checked as OSM checks them (409 on a stale modify or delete), a delete with if-unused keeps an
object something still uses, new ids are given as OSM gives them. Nothing the tool does differs: it is pointed
here by web/config.js (serve.py --sandbox) and OSM_API_URL / OVERPASS_URL in the environment.
"""
import argparse, datetime, glob, json, os, re, sys, threading, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import quoteattr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'cache', 'sandbox')
LOG = os.path.join(DIR, 'changes.json')
DATE = '2026-09-27T00:00:00Z'
UA = {'User-Agent': 'flagstop sandbox (GTFS/OSM route review)'}
USER = {'id': 1, 'display_name': 'sandbox', 'account_created': '2026-09-27T00:00:00Z'}
ROAD_CLASSES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road'


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ---------------------------------------------------------------- the snapshot
SNAPSHOT_QUERY = """[out:json][timeout:300][maxsize:536870912][date:"{date}"];
(
  way["highway"]({bbox});
  nwr["public_transport"]({bbox});
  nwr["highway"="bus_stop"]({bbox});
  nwr["amenity"="bus_station"]({bbox});
  relation["type"="route"]({bbox});
)->.a;
(.a; .a >; .a <;)->.b;
(.b; .b >;);
out meta;
"""


def snapshot(date, feed_path, out=None, overpass='https://overpass-api.de/api/interpreter', strip=0.05):
    """The roads, the public transport, every relation on them and every node of them, as of `date`: the area in
    strips `strip` degrees tall (one attic query over a whole valley times out), each tried a few times."""
    sys.path.insert(0, os.path.join(ROOT, 'tool'))
    import gtfs
    feed = gtfs.load(feed_path)
    s, w, n, e = gtfs.bbox(feed, margin=0.02)
    print(f'overpass attic at {date} over {s:.3f},{w:.3f},{n:.3f},{e:.3f}, in strips of {strip} degrees ...', file=sys.stderr)
    t0 = time.time()
    seen, elements, osm3s = set(), [], {}
    lo = s
    while lo < n:
        hi = min(n, lo + strip)
        q = SNAPSHOT_QUERY.format(date=date, bbox=f'{lo:.5f},{w:.5f},{hi:.5f},{e:.5f}')
        for attempt in range(5):
            try:
                with urllib.request.urlopen(urllib.request.Request(overpass, data=urllib.parse.urlencode({'data': q}).encode(), headers=UA), timeout=400) as r:
                    part = json.load(r)
                break
            except Exception as ex:
                wait = 30 * (attempt + 1)
                print(f'  {lo:.3f}-{hi:.3f}: {ex}; again in {wait}s', file=sys.stderr)
                if attempt == 4:
                    raise
                time.sleep(wait)
        osm3s = part.get('osm3s', osm3s)
        new = 0
        for el in part.get('elements', []):
            key = (el['type'], el['id'])
            if key not in seen:
                seen.add(key); elements.append(el); new += 1
        print(f'  {lo:.3f}-{hi:.3f}: {new} new elements ({len(elements)} so far, {time.time() - t0:.0f}s)', file=sys.stderr)
        lo = hi
    raw = {'version': 0.6, 'generator': 'flagstop sandbox snapshot', 'osm3s': osm3s, 'elements': elements}
    raw['sandbox'] = {'date': date, 'bbox': [s, w, n, e], 'feed': os.path.basename(feed_path), 'fetched': now()}
    out = out or os.path.join(DIR, f'base-{date[:10]}.json')
    os.makedirs(DIR, exist_ok=True)
    json.dump(raw, open(out + '.tmp', 'w')); os.replace(out + '.tmp', out)
    kinds = {}
    for el in raw['elements']:
        kinds[el['type']] = kinds.get(el['type'], 0) + 1
    print(f'{out}: {kinds} in {time.time() - t0:.0f}s', file=sys.stderr)
    return out


def latest_base():
    bases = sorted(glob.glob(os.path.join(DIR, 'base-*.json')))
    return bases[-1] if bases else None


# ---------------------------------------------------------------- the data
class Conflict(Exception):
    def __init__(self, code, text):
        super().__init__(text); self.code = code


class Store:
    """Every object by type and id, with its history; every changeset. A grid over the nodes for map calls;
    the ways of each node and the relations of each member, for recursion."""
    CELL = 0.01

    def __init__(self, base):
        with open(base) as f:
            raw = json.load(f)
        self.base = base
        self.meta = raw.get('sandbox', {})
        self.el = {'node': {}, 'way': {}, 'relation': {}}
        self.hist = {}
        for e in raw['elements']:
            e = dict(e); e.setdefault('tags', {}); e.setdefault('visible', True)
            if e['type'] == 'way':
                e.setdefault('nodes', [])
            if e['type'] == 'relation':
                e.setdefault('members', [])
            self.el[e['type']][e['id']] = e
            self.hist[(e['type'], e['id'])] = [e]
        self.next_id = {t: max(self.el[t], default=0) + 1 for t in self.el}
        self.changesets = {}
        self.next_cs = 1
        self.lock = threading.RLock()
        self._index()

    def _index(self):
        self.grid, self.ways_of, self.rels_of = {}, {}, {}
        for n in self.el['node'].values():
            if n['visible']:
                self.grid.setdefault(self._cell(n['lat'], n['lon']), []).append(n['id'])
        for w in self.el['way'].values():
            if w['visible']:
                for nid in w['nodes']:
                    self.ways_of.setdefault(nid, set()).add(w['id'])
        for r in self.el['relation'].values():
            if r['visible']:
                for m in r['members']:
                    self.rels_of.setdefault((m['type'], m['ref']), set()).add(r['id'])

    def _cell(self, lat, lon):
        return int(lat // self.CELL), int(lon // self.CELL)

    def get(self, t, i, gone_ok=False):
        e = self.el[t].get(i)
        if e is None:
            raise Conflict(404, f'{t} {i} not found')
        if not e['visible'] and not gone_ok:
            raise Conflict(410, f'{t} {i} is gone')
        return e

    def nodes_in(self, s, w, n, e):
        out = []
        for ci in range(int(s // self.CELL), int(n // self.CELL) + 1):
            for cj in range(int(w // self.CELL), int(e // self.CELL) + 1):
                for nid in self.grid.get((ci, cj), []):
                    x = self.el['node'][nid]
                    if x['visible'] and s <= x['lat'] <= n and w <= x['lon'] <= e:
                        out.append(nid)
        return out

    def ways_in(self, s, w, n, e):
        return sorted({wid for nid in self.nodes_in(s, w, n, e) for wid in self.ways_of.get(nid, ())})

    # --- the log: what went up, replayed on start ---
    def load_log(self):
        if not os.path.exists(LOG):
            return 0
        with open(LOG) as f:
            log = json.load(f)
        for cs in log:
            self.create_changeset(cs['tags'], cs['created_at'])
            self.upload(cs['id'], cs['osc'])
            self.close_changeset(cs['id'], cs['closed_at'])
            self.changesets[cs['id']]['comments'] = cs.get('comments', [])
        return len(self.changesets)

    def save_log(self):
        os.makedirs(DIR, exist_ok=True)
        json.dump([{'id': c['id'], 'tags': c['tags'], 'created_at': c['created_at'], 'closed_at': c['closed_at'], 'osc': c['osc'], 'comments': c['comments']}
                   for c in self.changesets.values() if not c['open']], open(LOG + '.tmp', 'w'), indent=0)
        os.replace(LOG + '.tmp', LOG)

    # --- changesets ---
    def create_changeset(self, tags, at=None):
        with self.lock:
            cs = {'id': self.next_cs, 'tags': tags, 'created_at': at or now(), 'closed_at': None, 'open': True, 'user': USER['display_name'], 'uid': USER['id'],
                  'osc': '', 'changes': [], 'comments': [], 'bbox': None}
            self.changesets[cs['id']] = cs; self.next_cs += 1
            return cs['id']

    def close_changeset(self, cid, at=None):
        with self.lock:
            cs = self.changesets.get(cid)
            if not cs:
                raise Conflict(404, f'changeset {cid} not found')
            if not cs['open']:
                raise Conflict(409, f'The changeset {cid} was closed at {cs["closed_at"]}')
            cs['open'] = False; cs['closed_at'] = at or now()

    def upload(self, cid, osc):
        """Apply an osmChange document as one changeset upload: all of it, or none of it. -> diffResult XML."""
        with self.lock:
            cs = self.changesets.get(cid)
            if not cs:
                raise Conflict(404, f'changeset {cid} not found')
            if not cs['open']:
                raise Conflict(409, f'The changeset {cid} was closed at {cs["closed_at"]}')
            root = ET.fromstring(osc)
            journal, placeholders, results, applied = [], {}, [], []
            when = now()

            def record(t, i):
                journal.append((t, i, self.el[t].get(i), list(self.hist.get((t, i), []))))

            try:
                for block in root:
                    action = block.tag
                    for x in block:
                        t = x.tag
                        if t not in self.el:
                            raise Conflict(400, f'unknown element <{t}>')
                        old_id = int(x.get('id'))
                        if str(x.get('changeset')) != str(cid):
                            raise Conflict(409, f'Changeset mismatch: Provided {x.get("changeset")} but only {cid} is allowed')
                        tags = {k.get('k'): k.get('v') for k in x.findall('tag')}
                        new = {'type': t, 'id': old_id, 'tags': tags, 'visible': True, 'timestamp': when, 'changeset': cid, 'user': USER['display_name'], 'uid': USER['id']}
                        if t == 'node':
                            if action != 'delete':
                                if x.get('lat') is None or x.get('lon') is None:
                                    raise Conflict(400, f'node {old_id} has no position')
                                new['lat'], new['lon'] = float(x.get('lat')), float(x.get('lon'))
                        elif t == 'way':
                            new['nodes'] = [self._resolve('node', int(nd.get('ref')), placeholders) for nd in x.findall('nd')]
                            if action != 'delete' and len(new['nodes']) < 2:
                                raise Conflict(412, f'Precondition failed: Way {old_id} must have at least 2 nodes')
                        else:
                            new['members'] = [{'type': m.get('type'), 'ref': self._resolve(m.get('type'), int(m.get('ref')), placeholders), 'role': m.get('role') or ''} for m in x.findall('member')]
                        if action == 'create':
                            if old_id >= 0:
                                raise Conflict(400, f'{t} {old_id}: a creation needs a placeholder id below zero')
                            self._check_refs(new)
                            new['id'] = self.next_id[t]; self.next_id[t] += 1
                            new['version'] = 1
                            placeholders[(t, old_id)] = new['id']
                            record(t, new['id'])
                            self._put(new)
                            results.append(f'<{t} old_id="{old_id}" new_id="{new["id"]}" new_version="1"/>')
                            applied.append(('create', new))
                        else:
                            cur = self.el[t].get(old_id)
                            if cur is None:
                                raise Conflict(404, f'{t} {old_id} not found')
                            if not cur['visible']:
                                raise Conflict(410, f'{t} {old_id} is gone')
                            v = int(x.get('version') or 0)
                            if v != cur['version']:
                                raise Conflict(409, f'Version mismatch: Provided {v}, server had: {cur["version"]} of {t.capitalize()} {old_id}')
                            if action == 'modify':
                                self._check_refs(new)
                                new['version'] = v + 1
                                record(t, old_id); self._put(new)
                                results.append(f'<{t} old_id="{old_id}" new_id="{old_id}" new_version="{new["version"]}"/>')
                                applied.append(('modify', new))
                            elif action == 'delete':
                                used = self._used_by(t, old_id)
                                if used:
                                    if block.get('if-unused') is not None:
                                        results.append(f'<{t} old_id="{old_id}" new_id="{old_id}" new_version="{cur["version"]}"/>')
                                        continue
                                    raise Conflict(412, f'Precondition failed: {t.capitalize()} {old_id} is still used by {used}')
                                gone = {**cur, 'tags': {}, 'visible': False, 'version': v + 1, 'timestamp': when, 'changeset': cid, 'user': USER['display_name'], 'uid': USER['id']}
                                record(t, old_id); self._put(gone)
                                results.append(f'<{t} old_id="{old_id}"/>')
                                applied.append(('delete', gone))
                            else:
                                raise Conflict(400, f'unknown action <{action}>')
            except Exception:
                for t, i, old, h in reversed(journal):
                    if old is None:
                        self.el[t].pop(i, None); self.hist.pop((t, i), None)
                    else:
                        self.el[t][i] = old; self.hist[(t, i)] = h
                self._index()
                raise
            cs['osc'] = (cs['osc'] + '\n' + osc) if cs['osc'] else osc
            cs['changes'].extend(applied)
            self._index()
            return '<?xml version="1.0" encoding="UTF-8"?>\n<diffResult version="0.6" generator="flagstop sandbox">\n' + ''.join('  ' + r + '\n' for r in results) + '</diffResult>\n'

    def _resolve(self, t, ref, placeholders):
        if ref < 0:
            if (t, ref) not in placeholders:
                raise Conflict(412, f'Precondition failed: placeholder {t} {ref} is not defined before it is used')
            return placeholders[(t, ref)]
        return ref

    def _check_refs(self, e):
        for t, refs in (('node', e.get('nodes', [])), ('member', e.get('members', []))):
            for m in refs:
                mt, ref = (m['type'], m['ref']) if t == 'member' else ('node', m)
                x = self.el.get(mt, {}).get(ref)
                if x is None or not x['visible']:
                    raise Conflict(412, f'Precondition failed: {e["type"].capitalize()} {e["id"]} requires {mt} {ref}, which {"does not exist" if x is None else "is deleted"}')

    def _used_by(self, t, i):
        users = []
        if t == 'node':
            users += [f'way {w}' for w in self.ways_of.get(i, ()) if self.el['way'][w]['visible']]
        users += [f'relation {r}' for r in self.rels_of.get((t, i), ()) if self.el['relation'][r]['visible']]
        return ', '.join(users)

    def _put(self, e):
        self.el[e['type']][e['id']] = e
        self.hist.setdefault((e['type'], e['id']), []).append(e)


# ---------------------------------------------------------------- answering as OSM does
def xml_element(e, inner=True):
    a = f'id="{e["id"]}" version="{e["version"]}" timestamp="{e["timestamp"]}" changeset="{e["changeset"]}" user={quoteattr(e["user"])} uid="{e["uid"]}" visible="{"true" if e["visible"] else "false"}"'
    if e['type'] == 'node' and e['visible']:
        a += f' lat="{e["lat"]:.7f}" lon="{e["lon"]:.7f}"'
    body = ''
    if e['type'] == 'way':
        body += ''.join(f'    <nd ref="{n}"/>\n' for n in e['nodes'])
    if e['type'] == 'relation':
        body += ''.join(f'    <member type="{m["type"]}" ref="{m["ref"]}" role={quoteattr(m["role"])}/>\n' for m in e['members'])
    body += ''.join(f'    <tag k={quoteattr(k)} v={quoteattr(str(v))}/>\n' for k, v in e['tags'].items())
    return f'  <{e["type"]} {a}>\n{body}  </{e["type"]}>\n' if body else f'  <{e["type"]} {a}/>\n'


def api_json(e, meta=True):
    """An element as the API's .json gives it (and as Overpass's `out meta` does)."""
    o = {'type': e['type'], 'id': e['id']}
    if e['type'] == 'node' and e['visible']:
        o['lat'], o['lon'] = e['lat'], e['lon']
    if meta:
        o.update(timestamp=e['timestamp'], version=e['version'], changeset=e['changeset'], user=e['user'], uid=e['uid'])
    if not e['visible']:
        o['visible'] = False
    if e['type'] == 'way':
        o['nodes'] = list(e['nodes'])
    if e['type'] == 'relation':
        o['members'] = [dict(m) for m in e['members']]
    if e['tags']:
        o['tags'] = dict(e['tags'])
    return o


def changeset_json(cs, discussion=False):
    o = {'type': 'changeset', 'id': cs['id'], 'created_at': cs['created_at'], 'closed_at': cs['closed_at'], 'open': cs['open'], 'user': cs['user'], 'uid': cs['uid'],
         'changes_count': len(cs['changes']), 'comments_count': len(cs['comments']), 'tags': cs['tags']}
    if discussion:
        o['comments'] = cs['comments']
    return o


class Overpass:
    """The tool's queries, recognised by shape, answered from the store."""
    BBOX = re.compile(r'\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)')

    def __init__(self, store):
        self.st = store

    def run(self, q):
        if '"type"="route_master"' in q and '"highway"="bus_stop"' in q:
            return self.pt(q)
        if 'way["highway"~' in q:
            return self.roads(q)
        raise Conflict(400, 'the sandbox does not know this query shape; teach tool/sandbox.py Overpass.run:\n' + q[:400])

    def out(self, elements):
        return {'version': 0.6, 'generator': 'flagstop sandbox', 'osm3s': {'timestamp_osm_base': now(), 'copyright': 'sandbox'}, 'elements': elements}

    def pt(self, q):
        st = self.st
        s, w, n, e = map(float, self.BBOX.search(q).groups())
        in_box = set(st.nodes_in(s, w, n, e))
        ways_touching = set(st.ways_in(s, w, n, e))

        def rel_in_box(r):
            for m in r['members']:
                if m['type'] == 'node' and m['ref'] in in_box:
                    return True
                if m['type'] == 'way' and m['ref'] in ways_touching:
                    return True
            return False
        want = {}
        routes = [r for r in st.el['relation'].values() if r['visible'] and r['tags'].get('type') == 'route' and re.match(r'^(bus|trolleybus|share_taxi)$', r['tags'].get('route', '')) and rel_in_box(r)]
        for r in routes:
            want[('relation', r['id'])] = r
            for mid in st.rels_of.get(('relation', r['id']), ()):
                m = st.el['relation'][mid]
                if m['visible'] and m['tags'].get('type') == 'route_master':
                    want[('relation', mid)] = m

        def stoplike(t):
            return (t.get('highway') == 'bus_stop' or (t.get('public_transport') == 'platform' and (t.get('bus') == 'yes' or t.get('highway') == 'bus_stop'))
                    or (t.get('public_transport') == 'stop_position' and t.get('bus') == 'yes') or t.get('amenity') == 'bus_station'
                    or (t.get('public_transport') == 'station' and t.get('bus') == 'yes'))
        for nid in in_box:
            x = st.el['node'][nid]
            if stoplike(x['tags']):
                want[('node', nid)] = x
        for wid in ways_touching:
            x = st.el['way'][wid]
            if stoplike(x['tags']):
                want[('way', wid)] = x
        for r in st.el['relation'].values():
            if r['visible'] and (stoplike(r['tags']) or r['tags'].get('public_transport') == 'stop_area') and rel_in_box(r):
                want[('relation', r['id'])] = r
        # >: members of the relations, nodes of the ways
        out = dict(want)
        for key, x in list(want.items()):
            if x['type'] == 'relation':
                for m in x['members']:
                    y = st.el[m['type']].get(m['ref'])
                    if y and y['visible'] and m['type'] != 'relation':
                        out[(m['type'], m['ref'])] = y
        for key, x in list(out.items()):
            if x['type'] == 'way':
                for nid in x['nodes']:
                    y = st.el['node'].get(nid)
                    if y and y['visible']:
                        out[('node', nid)] = y
        order = {'node': 0, 'way': 1, 'relation': 2}
        return self.out([api_json(x) for x in sorted(out.values(), key=lambda x: (order[x['type']], x['id']))])

    def roads(self, q):
        st = self.st
        classes = re.search(r'"highway"~"\^\((.*?)\)\$"', q)
        ok = set((classes.group(1) if classes else ROAD_CLASSES).split('|'))
        boxes = [tuple(map(float, m)) for m in self.BBOX.findall(q)]
        roads = {}
        for s, w, n, e in boxes:
            for wid in st.ways_in(s, w, n, e):
                x = st.el['way'][wid]
                if x['tags'].get('highway') in ok:
                    roads[wid] = x
        rels = {}
        for wid in roads:
            for rid in st.rels_of.get(('way', wid), ()):
                r = st.el['relation'][rid]
                if r['visible'] and r['tags'].get('type') == 'restriction':
                    rels[rid] = r
        nodes = {}
        for x in roads.values():
            for nid in x['nodes']:
                y = st.el['node'].get(nid)
                if y and y['visible']:
                    nodes[nid] = y
        els = [api_json(x, meta=False) for x in sorted(roads.values(), key=lambda x: x['id'])]
        els += [api_json(x, meta=False) for x in sorted(rels.values(), key=lambda x: x['id'])]
        els += [{'type': 'node', 'id': y['id'], 'lat': y['lat'], 'lon': y['lon']} for y in sorted(nodes.values(), key=lambda x: x['id'])]
        return self.out(els)


class Handler(BaseHTTPRequestHandler):
    store = None
    overpass = None

    def log_message(self, fmt, *args):
        if os.environ.get('SANDBOX_QUIET'):
            return
        super().log_message(fmt, *args)

    # --- replies ---
    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj), 'application/json; charset=utf-8')

    def _osm_json(self, elements):
        self._json({'version': '0.6', 'generator': 'flagstop sandbox', 'copyright': 'sandbox', 'elements': elements})

    def _xml(self, inner, code=200, root='osm'):
        self._send(code, f'<?xml version="1.0" encoding="UTF-8"?>\n<{root} version="0.6" generator="flagstop sandbox">\n{inner}</{root}>\n', 'application/xml; charset=utf-8')

    def _text(self, text, code=200):
        self._send(code, text, 'text/plain; charset=utf-8')

    def _body(self):
        return self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()

    def _signed_in(self):
        if not (self.headers.get('Authorization') or '').startswith('Bearer '):
            raise Conflict(401, "Couldn't authenticate you")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.send_header('Access-Control-Max-Age', '600'); self.end_headers()

    def _route(self, method):
        try:
            self._handle(method)
        except Conflict as c:
            self._text(str(c), c.code)
        except Exception as e:
            import traceback; traceback.print_exc()
            self._text(f'sandbox error: {e}', 500)

    def do_GET(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def do_PUT(self):
        self._route('PUT')

    def _handle(self, method):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        path = u.path
        st = self.store
        # --- sign-in ---
        if path == '/oauth2/authorize':
            back = q.get('redirect_uri', [''])[0]
            sep = '&' if '?' in back else '?'
            self.send_response(302); self.send_header('Location', f'{back}{sep}code=sandbox'); self.end_headers(); return
        if path == '/oauth2/token' and method == 'POST':
            return self._json({'access_token': 'sandbox-token', 'token_type': 'Bearer', 'scope': 'read_prefs write_api', 'created_at': int(time.time())})
        if path == '/api/0.6/user/details.json':
            self._signed_in()
            return self._json({'version': '0.6', 'user': {**USER, 'changesets': {'count': len(st.changesets)}}})
        # --- Overpass ---
        if path == '/api/interpreter':
            data = (urllib.parse.parse_qs(self._body()).get('data') if method == 'POST' else q.get('data')) or ['']
            return self._json(self.overpass.run(data[0]))
        # --- the API ---
        m = re.match(r'^/api/0\.6/(.*)$', path)
        if not m:
            return self._text('not here', 404)
        rest = m.group(1)
        if rest == 'notes.json':
            return self._json({'type': 'FeatureCollection', 'features': []})
        if rest == 'map.json':
            l, b, r, t = map(float, q['bbox'][0].split(','))
            if (r - l) * (t - b) > 0.25:
                return self._text('The maximum bbox size is 0.25', 400)
            nodes = st.nodes_in(b, l, t, r)
            ways = st.ways_in(b, l, t, r)
            all_nodes = dict.fromkeys(nodes)
            for wid in ways:
                for nid in st.el['way'][wid]['nodes']:
                    all_nodes[nid] = None
            rels = set()
            for nid in all_nodes:
                rels |= st.rels_of.get(('node', nid), set())
            for wid in ways:
                rels |= st.rels_of.get(('way', wid), set())
            els = [api_json(st.el['node'][n]) for n in all_nodes if st.el['node'][n]['visible']]
            els += [api_json(st.el['way'][w]) for w in ways]
            els += [api_json(st.el['relation'][r]) for r in sorted(rels) if st.el['relation'][r]['visible']]
            return self._osm_json(els)
        mm = re.match(r'^(nodes|ways|relations)\.json$', rest)
        if mm:
            t = mm.group(1)[:-1]
            ids = [int(x) for x in (q.get(mm.group(1), [''])[0]).split(',') if x.strip().lstrip('-').isdigit()]
            missing = [i for i in ids if i not in st.el[t]]
            if missing:
                return self._text(f'{t} {missing[0]} not found', 404)
            return self._osm_json([api_json(st.el[t][i]) for i in ids])
        mm = re.match(r'^(node|way|relation)/(\d+)(?:/(full|history|ways|relations))?(\.json)?$', rest)
        if mm and method == 'GET':
            t, i, sub, js = mm.group(1), int(mm.group(2)), mm.group(3), mm.group(4)
            if sub == 'history':
                return self._osm_json([api_json(v) for v in st.hist.get((t, i), [])]) if (t, i) in st.hist else self._text(f'{t} {i} not found', 404)
            e = st.get(t, i)
            if sub == 'full':
                els = []
                if t == 'way':
                    els = [api_json(st.el['node'][n]) for n in e['nodes'] if n in st.el['node']]
                elif t == 'relation':
                    for mem in e['members']:
                        y = st.el[mem['type']].get(mem['ref'])
                        if y and y['visible']:
                            els.append(api_json(y))
                            if mem['type'] == 'way':
                                els += [api_json(st.el['node'][n]) for n in y['nodes'] if n in st.el['node']]
                return self._osm_json(els + [api_json(e)])
            if sub == 'ways':
                return self._osm_json([api_json(st.el['way'][w]) for w in sorted(st.ways_of.get(i, ())) if st.el['way'][w]['visible']])
            if sub == 'relations':
                return self._osm_json([api_json(st.el['relation'][r]) for r in sorted(st.rels_of.get((t, i), ())) if st.el['relation'][r]['visible']])
            if js:
                return self._osm_json([api_json(e)])
            return self._xml(xml_element(e))
        # --- changesets ---
        if rest == 'changeset/create' and method == 'PUT':
            self._signed_in()
            root = ET.fromstring(self._body())
            tags = {t.get('k'): t.get('v') for t in root.iter('tag')}
            return self._text(str(st.create_changeset(tags)))
        if rest == 'changesets.json':
            uid = q.get('user', [None])[0]
            limit = int(q.get('limit', ['100'])[0])
            cs = [changeset_json(c) for c in sorted(st.changesets.values(), key=lambda c: -c['id']) if uid is None or str(c['uid']) == uid]
            return self._json({'version': '0.6', 'changesets': cs[:limit]})
        mm = re.match(r'^changeset/(\d+)(?:/(upload|close|download|comment))?(\.json)?$', rest)
        if mm:
            cid, sub, js = int(mm.group(1)), mm.group(2), mm.group(3)
            cs = st.changesets.get(cid)
            if not cs:
                return self._text(f'changeset {cid} not found', 404)
            if sub == 'upload' and method == 'POST':
                self._signed_in()
                diff = st.upload(cid, self._body())
                st.save_log()
                return self._send(200, diff, 'application/xml; charset=utf-8')
            if sub == 'close' and method == 'PUT':
                self._signed_in()
                st.close_changeset(cid); st.save_log()
                return self._text('')
            if sub == 'comment' and method == 'POST':
                self._signed_in()
                text = urllib.parse.parse_qs(self._body()).get('text', [''])[0]
                cs['comments'].append({'id': len(cs['comments']) + 1, 'date': now(), 'uid': 2, 'user': 'another mapper', 'text': text})
                st.save_log()
                return self._json({'version': '0.6', 'changeset': changeset_json(cs, True)})
            if sub == 'download':
                inner, last = '', None
                for action, e in cs['changes']:   # as OSM gives it: one block per run of the same action
                    if action != last:
                        inner += (f'</{last}>\n' if last else '') + f'<{action}>\n'; last = action
                    inner += xml_element(e)
                inner += f'</{last}>\n' if last else ''
                return self._send(200, f'<?xml version="1.0" encoding="UTF-8"?>\n<osmChange version="0.6" generator="flagstop sandbox">\n{inner}</osmChange>\n', 'application/xml; charset=utf-8')
            if js:
                return self._json({'version': '0.6', 'changeset': changeset_json(cs, 'include_discussion' in q)})
            a = f'id="{cs["id"]}" created_at="{cs["created_at"]}"' + (f' closed_at="{cs["closed_at"]}"' if cs['closed_at'] else '') + f' open="{"true" if cs["open"] else "false"}" user={quoteattr(cs["user"])} uid="{cs["uid"]}" changes_count="{len(cs["changes"])}" comments_count="{len(cs["comments"])}"'
            return self._xml(f'  <changeset {a}>\n' + ''.join(f'    <tag k={quoteattr(k)} v={quoteattr(str(v))}/>\n' for k, v in cs['tags'].items()) + '  </changeset>\n')
        return self._text(f'the sandbox has no {method} {path}', 404)


def serve(port, base):
    store = Store(base)
    n = store.load_log()
    Handler.store, Handler.overpass = store, Overpass(store)
    print(f'sandbox: {os.path.basename(base)} ({len(store.el["node"])} nodes, {len(store.el["way"])} ways, {len(store.el["relation"])} relations) as of {store.meta.get("date", "?")}, '
          f'{n} changeset{"" if n == 1 else "s"} uploaded so far', file=sys.stderr)
    print(f'http://127.0.0.1:{port}/', file=sys.stderr)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()


def run(port, sb_port, feed, reset=False, refresh=False):
    """The sandbox, the review built against it, the page served against it: one command, until Ctrl-C."""
    import subprocess
    base = latest_base()
    if not base:
        raise SystemExit('no snapshot in cache/sandbox/: run `python3 tool/sandbox.py snapshot` first')
    if reset and os.path.exists(LOG):
        os.remove(LOG); print('reset: every upload forgotten', file=sys.stderr)
    work = os.path.join(DIR, 'work')
    os.makedirs(os.path.join(work, 'data'), exist_ok=True)
    store = Store(base)
    n = store.load_log()
    Handler.store, Handler.overpass = store, Overpass(store)
    srv = ThreadingHTTPServer(('127.0.0.1', sb_port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    sb = f'http://127.0.0.1:{sb_port}'
    print(f'sandbox: {os.path.basename(base)} as of {store.meta.get("date", "?")}, {n} changeset{"" if n == 1 else "s"} so far, at {sb}', file=sys.stderr)
    env = {**os.environ, 'OSM_API_URL': sb, 'OVERPASS_URL': sb + '/api/interpreter', 'FLAGSTOP_CACHE': work, 'FLAGSTOP_DATA': os.path.join(work, 'data'), 'SANDBOX_QUIET': '1'}
    if refresh or not os.path.exists(os.path.join(work, 'data', 'review.json')):
        print('the review, from the sandbox ...', file=sys.stderr)
        subprocess.run([sys.executable, os.path.join(ROOT, 'tool', 'review.py'), feed, *(['--refresh'] if refresh else [])], env=env, check=True)
    try:
        subprocess.run([sys.executable, os.path.join(ROOT, 'tool', 'serve.py'), '--port', str(port), '--feed', feed, '--sandbox', sb], env=env)
    except KeyboardInterrupt:
        pass
    srv.shutdown()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd')
    s = sub.add_parser('snapshot'); s.add_argument('--date', default=DATE); s.add_argument('--feed'); s.add_argument('--out'); s.add_argument('--overpass', default='https://overpass-api.de/api/interpreter')
    s = sub.add_parser('serve'); s.add_argument('--port', type=int, default=8766); s.add_argument('--base')
    s = sub.add_parser('run'); s.add_argument('--port', type=int, default=8765); s.add_argument('--sandbox-port', type=int, default=8766); s.add_argument('--feed')
    s.add_argument('--reset', action='store_true', help='forget every upload first'); s.add_argument('--refresh', action='store_true', help='build the review again from the sandbox')
    sub.add_parser('reset')
    sub.add_parser('status')
    a = ap.parse_args(argv)
    newest = lambda pat: max(glob.glob(os.path.join(ROOT, 'cache', pat)), key=os.path.getmtime, default=None)
    if a.cmd == 'snapshot':
        return snapshot(a.date, a.feed or newest('*.zip'), a.out, a.overpass)
    base = getattr(a, 'base', None) or latest_base()
    if a.cmd == 'serve':
        if not base:
            raise SystemExit('no snapshot in cache/sandbox/: run `python3 tool/sandbox.py snapshot` first')
        return serve(a.port, base)
    if a.cmd == 'run':
        return run(a.port, a.sandbox_port, a.feed or newest('*.zip'), a.reset, a.refresh)
    if a.cmd == 'reset':
        if os.path.exists(LOG):
            os.remove(LOG); print('every upload forgotten: the snapshot again (restart the sandbox)', file=sys.stderr)
        else:
            print('nothing uploaded: the snapshot as it was', file=sys.stderr)
        return
    if a.cmd == 'status':
        log = json.load(open(LOG)) if os.path.exists(LOG) else []
        print(f'snapshot: {base or "none"}; {len(log)} changeset{"" if len(log) == 1 else "s"} uploaded')
        for cs in log:
            kinds = {}
            for blk in re.findall(r'<(create|modify|delete)\b', cs['osc']):
                kinds[blk] = kinds.get(blk, 0) + 1
            print(f"  {cs['id']}  {cs['closed_at']}  {cs['tags'].get('comment', '')[:70]}  {kinds}")
        return
    ap.print_help()


if __name__ == '__main__':
    main()
