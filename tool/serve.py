#!/usr/bin/env python3
"""Serve the review page, and re-route a pattern on request.

    python3 tool/serve.py [--port 8765] [--feed FEED.zip] [--osm-roads cache/osm-roads.json] [--sandbox http://127.0.0.1:8766]

--sandbox: the page, the review's rebuild and the patching after an upload all talk to tool/sandbox.py at that
address instead of OpenStreetMap (config.js is served pointing there; OSM_API_URL and OVERPASS_URL are set for
the subprocesses). The tool itself doesn't know: that is the point.

Static files come from web/. With a feed and roads file loaded, the page can ask for a fresh trace
of a pattern through extra via points the reviewer drops on the map:

    GET /api/roads?pattern=<id>                             -> the roads around the itinerary (Overpass JSON), kept a day
    GET /api/route?pattern=<id>                             -> the itinerary's route fields (path, divergences, joins,
                                                               stop positions), from its own roads, fetched when first asked
    GET /api/trace?pattern=<id>&via=<lon>,<lat>&via=...     -> the same shape as review.json's routed{}
          &avoid=<way id>&require=<way id>...                  (avoid: roads the bus doesn't use; require: roads it does)
    POST /api/refresh                                       -> fetch OSM again and rebuild the review (after an upload);
                                                               GET /api/refresh says whether it's still running
    POST /api/trace {pattern, vias, avoid, require, ways: {id: {nodes, tags}}, nodes: {id: [lon, lat]}}
    GET /api/state?key=<k>, POST /api/state {key, state, at}  -> your decisions and Changes, kept in cache/state/
                                                               so another browser, or cleared site data, doesn't lose
                                                               them (this page's own origin only)
                                                            -> the trace as it would be with those road edits made
                                                               (Changes not yet uploaded, or a proposed fix)

Runs on 127.0.0.1 only: JOSM's remote control (port 8111) accepts requests from a local page.
"""
import re, argparse, glob, json, os, subprocess, sys, threading, time, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtfs, osm, routes as routing, compare, stops as stopmatch, review

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
STATE = {}
# where the review's files live: cache/ and web/data/, or wherever a sandbox run keeps its own (tool/sandbox.py)
cache_dir = lambda: os.environ.get('FLAGSTOP_CACHE') or os.path.join(ROOT, 'cache')
data_dir = lambda: os.environ.get('FLAGSTOP_DATA') or os.path.join(WEB, 'data')


def load(feed_path, roads_path, pt_path):
    feed = gtfs.load(feed_path)
    STATE['feed'] = feed
    STATE['patterns'] = {p.id: p for p in feed.patterns}
    STATE['graph'] = True   # roads are loaded per route, when it's opened (graph_for)
    ROUTED.clear(); GRAPHS.clear()
    STATE['osm_stops'], STATE['stop_areas'] = {}, []
    if pt_path and os.path.exists(pt_path):
        STATE['osm_stops'], *_ = osm.parse_pt(osm.load(pt_path))
        STATE['stop_areas'] = list(getattr(osm.parse_pt, 'stop_areas', {}).values())
    # the matches the page shows (review.json), so a route's stop positions are worked out for the same stops
    rj = os.path.join(data_dir(), 'review.json')
    STATE['match'] = {k: s.get('match') for k, s in json.load(open(rj))['stops'].items()} if os.path.exists(rj) else {}
    print(f'loaded {os.path.basename(feed_path)}: {len(feed.patterns)} patterns; roads per route, when opened', file=sys.stderr)


ROUTED = {}   # pattern id -> its route fields, as /api/route gives them (until the next refresh)
GRAPHS = {}   # pattern id -> the road graph around it


def roads_for(pid):
    """The roads around one itinerary: cache/roads/<it>.json if under a day old, else fetched (a small Overpass
    query); an older copy if Overpass can't be had; the whole-area roads, if there are any, as a last resort."""
    feed, p = STATE['feed'], STATE['patterns'][pid]
    path = os.path.join(cache_dir(), 'roads', review.safe(pid) + '.json')
    fresh = os.path.exists(path) and time.time() - os.path.getmtime(path) < 86400
    if not fresh:
        try:
            one = type('F', (), {'patterns': [p], 'shapes': feed.shapes, 'stops': feed.stops})
            raw = osm.fetch_roads_near(osm.corridors(one, step=100), tries=1)   # someone is waiting: one round, then the older copy
            os.makedirs(os.path.dirname(path), exist_ok=True)
            json.dump(raw, open(path + '.tmp', 'w')); os.replace(path + '.tmp', path)
            return raw
        except Exception as e:
            print(f'roads for {pid}: {e}', file=sys.stderr)
    if os.path.exists(path):
        return osm.load(path)
    whole = STATE.get('paths', (None, None, None))[1]
    if whole and os.path.exists(whole):
        return osm.load(whole)
    raise RuntimeError("couldn't get this route's roads from Overpass; try again in a minute")


def graph_for(pid):
    if pid not in GRAPHS:
        GRAPHS[pid] = routing.Graph(roads_for(pid))
    return GRAPHS[pid]


def route_for(pid):
    """The pattern's route fields (path, divergences, joins, stop positions), from its own roads."""
    if pid not in ROUTED:
        ROUTED[pid] = review.route_pattern(STATE['feed'], STATE['patterns'][pid], graph_for(pid), STATE['match'], STATE['osm_stops'], STATE['stop_areas'])
    return ROUTED[pid]


def trace_with_vias(pid, vias, g=None, require=(), avoid=()):
    """Trace the pattern through the reviewer's via points and required ways, keeping off the avoided ones; on
    graph g (already patched with road edits) if given."""
    feed = STATE['feed']
    g = g or graph_for(pid)
    if avoid:
        g = g.patched(avoid=avoid)
    p = STATE['patterns'][pid]
    pts = [(feed.stops[s].lon, feed.stops[s].lat) for s in p.stops]
    seq, pins = routing.fold_vias(g, pts, vias, require)
    res = routing.trace(g, seq, feed.shapes.get(p.shape_id), pins)
    return p, res


REFRESH = {'running': False, 'error': None, 'done': None}


def sandbox_info():
    """What the sandbox says of itself (its date, generation, uploads), when this server runs against one."""
    import urllib.request as ur
    try:
        with ur.urlopen(STATE['sandbox'] + '/sandbox.json', timeout=10) as r:
            return json.load(r)
    except Exception:
        return {}


def start_refresh(changesets=()):
    """Bring OSM up to date and rebuild review.json, then reload the roads the re-routing uses. After an upload
    (changesets given): those changesets, straight from OSM's API, in seconds. Otherwise: Overpass again (roads
    only if a day old). In the background."""
    if REFRESH['running']:
        return REFRESH
    if not STATE.get('paths'):
        return {**REFRESH, 'error': 'the server was started without a feed'}
    REFRESH.update(running=True, error=None)

    def run():
        feed, roads, pt = STATE['paths']
        if changesets:
            r = subprocess.run([sys.executable, os.path.join(ROOT, 'tool', 'patch.py'), *map(str, changesets)], capture_output=True, text=True)
            if r.returncode:
                REFRESH.update(running=False, error=(r.stderr.strip().splitlines() or ['patch.py failed'])[-1])
                return
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'tool', 'review.py'), feed, '--cache', cache_dir(), '--out', data_dir(), *([] if changesets else ['--refresh'])], capture_output=True, text=True)
        if r.returncode:
            REFRESH.update(running=False, error=(r.stderr.strip().splitlines() or ['review.py failed'])[-1])
            return
        try:
            load(feed, roads, pt)
        except Exception as e:
            REFRESH.update(running=False, error=str(e)); return
        import datetime
        REFRESH.update(running=False, done=datetime.datetime.now().isoformat(timespec='seconds'))
    threading.Thread(target=run, daemon=True).start()
    return REFRESH


def trace_json(res, vias, avoid=(), require=()):
    return {'ways': res['ways'], 'geometry': [[round(x, 6), round(y, 6)] for x, y in res['geometry']],
            'legs': [{'from': l['from'], 'to': l['to'], 'ok': l['ok'], 'why': l['why'], 'ways': l['ways']} for l in res['legs']],
            'divergences': [{k: (review.round_pts(v) if k in ('shape', 'path') else v) for k, v in d.items()} for d in res['divergences']],
            'score': res['score'], 'vias': list(vias), 'avoid': list(avoid), 'require': list(require)}


def way_ids(values):
    """Way ids from query values or a JSON list ('12,34', [12, '34']): ints, bad ones dropped."""
    out = []
    for v in values or []:
        for x in (v.split(',') if isinstance(v, str) else [v]):
            try:
                out.append(int(x))
            except (TypeError, ValueError):
                pass
    return out


# Who may talk to this server: requests addressed to this machine by name (a page on another site that points its
# own name at 127.0.0.1, DNS rebinding, addresses it by that name and is refused), and for anything that changes
# something, sent from flagstop's own page (another site open in the browser can send a POST here too).
LOCAL_HOST = re.compile(r'^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$')
LOCAL_ORIGIN = re.compile(r'^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$')
STATE_LOCK = threading.Lock()   # one /api/state write at a time
MAX_BODY = 64 * 1024 * 1024   # bytes: a saved basket or a road patch is far less


class Server(ThreadingHTTPServer):
    # a page load asks for fifteen things at once (scripts, data, roads); the default queue of 5 waiting
    # connections let macOS reset the rest, and a script that didn't load broke the page
    request_queue_size = 128
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def parse_request(self):
        if not super().parse_request():
            return False
        if not LOCAL_HOST.match(self.headers.get('Host', '')):
            self.send_error(403, 'flagstop answers only to 127.0.0.1 and localhost')
            return False
        return True

    def _body(self):
        """The request's body, at most MAX_BODY: b'' for none; None (after answering 413) for too much."""
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            self._json({'error': 'request too large'}, 413, cors=False)
            return None
        return self.rfile.read(n)

    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)

    def translate_path(self, path):
        """The page's data/ from wherever this run's review was written (a sandbox keeps its own)."""
        p = urllib.parse.urlparse(path).path
        if p.startswith('/data/'):
            return os.path.join(data_dir(), *[x for x in p[6:].split('/') if x and x != '..'])
        return super().translate_path(path)

    def end_headers(self):
        # the page's data may be read from other sites (RapiD opening a route's line); what's saved here may not
        if not getattr(self, '_private', False):
            self.send_header('Access-Control-Allow-Origin', '*')
        self._private = False
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/api/' in str(args[0] if args else ''):   # a 404's first arg is an HTTPStatus, not the request line
            super().log_message(fmt, *args)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/config.js' and STATE.get('sandbox'):
            # the page pointed at the sandbox: the real config.js with its addresses filled in
            sb = STATE['sandbox']
            body = open(os.path.join(WEB, 'config.js')).read()
            body = re.sub(r"clientId: '[^']*'", "clientId: 'sandbox'", body)
            body = re.sub(r"redirects: \[[^\]]*\]", f"redirects: ['http://127.0.0.1:{self.server.server_port}/', 'http://localhost:{self.server.server_port}/']", body)
            for k in ('api', 'www', 'overpass'):
                body = re.sub(rf"\b{k}: ''", f"{k}: '{sb}'" if k != 'overpass' else f"{k}: '{sb}/api/interpreter'", body)
            body = re.sub(r"\bworld: ''", f"world: '{sandbox_info().get('generation', '0')}'", body)
            return self._raw(body.encode(), 'application/javascript')
        if u.path == '/api/sandbox':
            return self._json(sandbox_info() if STATE.get('sandbox') else {})
        if not u.path.startswith('/api/'):
            return super().do_GET()
        if u.path == '/api/state':
            if not self._own():
                return self._json({'error': 'not from this page'}, 403, cors=False)
            path = self._state_path(urllib.parse.parse_qs(u.query).get('key', [''])[0])
            return self._json(json.load(open(path)) if os.path.exists(path) else {}, cors=False)
        if u.path == '/api/refresh':
            return self._json(REFRESH)
        q = urllib.parse.parse_qs(u.query)
        if u.path == '/api/roads':   # a route's roads, raw, for the page to route itself
            pid = (q.get('pattern') or [''])[0]
            if pid not in STATE.get('patterns', {}):
                return self._json({'error': 'unknown pattern'}, 404)
            try:
                return self._json(roads_for(pid))
            except Exception as e:
                return self._json({'error': str(e)}, 503)
        if u.path == '/api/route':
            pid = (q.get('pattern') or [''])[0]
            if pid not in STATE.get('patterns', {}):
                return self._json({'error': 'unknown pattern'}, 404)
            try:
                return self._json(route_for(pid))
            except Exception as e:
                return self._json({'error': str(e)}, 503)
        if 'graph' not in STATE:
            return self._json({'error': 'server started without --feed/--osm-roads; re-routing is off'}, 503)
        pid = (q.get('pattern') or [''])[0]
        if pid not in STATE['patterns']:
            return self._json({'error': 'unknown pattern'}, 404)
        vias = []
        for v in q.get('via', []):
            try:
                lon, lat = map(float, v.split(','))
                vias.append((lon, lat))
            except ValueError:
                pass
        avoid, require = way_ids(q.get('avoid')), way_ids(q.get('require'))
        p, res = trace_with_vias(pid, vias, require=require, avoid=avoid)
        if u.path == '/api/trace':
            return self._json(trace_json(res, vias, avoid, require))
        self._json({'error': 'no such call'}, 404)

    def _own(self):
        """Only flagstop's own page may read the saved state or change anything: not another site open in the
        browser. (The Host was checked already: it's this machine by name.)"""
        o = self.headers.get('Origin')
        return o is None or o in (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}', f'http://[::1]:{self.server.server_port}')

    def _state_path(self, key):
        return os.path.join(os.environ.get('FLAGSTOP_STATE_DIR') or os.path.join(cache_dir(), 'state'), re.sub(r'[^\w.-]+', '_', key or 'default')[:120] + '.json')

    def do_POST(self):
        if not self._own():
            return self._json({'error': 'not from this page'}, 403, cors=False)
        if urllib.parse.urlparse(self.path).path == '/api/state':
            raw = self._body()
            if raw is None:
                return
            try:
                body = json.loads(raw or b'{}')
            except ValueError:
                return self._json({'error': 'not JSON'}, 400, cors=False)
            path = self._state_path(body.get('key'))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with STATE_LOCK:
                # an older copy (a tab that hasn't caught up) doesn't replace a newer one
                try:
                    kept = json.load(open(path)).get('at') or 0
                except (OSError, ValueError):
                    kept = 0
                if (body.get('at') or 0) < kept:
                    return self._json({'ok': False, 'why': 'a newer copy is kept'}, cors=False)
                with open(path + '.tmp', 'w') as f:
                    json.dump({'state': body.get('state'), 'at': body.get('at')}, f)
                os.replace(path + '.tmp', path)
            return self._json({'ok': True}, cors=False)
        if urllib.parse.urlparse(self.path).path == '/api/sandbox/reset' and STATE.get('sandbox'):
            # the sandbox forgets its uploads (a new generation), this server's review is built again from it
            import urllib.request as ur
            try:
                with ur.urlopen(ur.Request(STATE['sandbox'] + '/reset', data=b'', method='POST'), timeout=30) as r:
                    gen = json.load(r).get('generation')
            except Exception as e:
                return self._json({'error': f'the sandbox did not reset: {e}'}, 503)
            import shutil
            for p in glob.glob(os.path.join(cache_dir(), '*-osm-*.json')) + glob.glob(os.path.join(cache_dir(), 'roads', '*.json')):
                os.remove(p)
            shutil.rmtree(os.path.join(cache_dir(), 'state'), ignore_errors=True)
            os.makedirs(data_dir(), exist_ok=True)   # the sandbox's reset may have taken the whole work directory
            ROUTED.clear(); GRAPHS.clear()
            return self._json({**start_refresh(), 'generation': gen})
        if urllib.parse.urlparse(self.path).path == '/api/refresh':
            raw = self._body()
            if raw is None:
                return
            try:
                body = json.loads(raw or b'{}')
            except ValueError:
                body = {}
            return self._json(start_refresh([int(x) for x in body.get('changesets', []) if str(x).isdigit()][:20]))
        if urllib.parse.urlparse(self.path).path != '/api/trace':
            return self._json({'error': 'no such call'}, 404)
        if 'graph' not in STATE:
            return self._json({'error': 'server started without --feed/--osm-roads; re-routing is off'}, 503)
        raw = self._body()
        if raw is None:
            return
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            return self._json({'error': 'not JSON'}, 400)
        pid = body.get('pattern')
        if pid not in STATE['patterns']:
            return self._json({'error': 'unknown pattern'}, 404)
        ways = {int(k): {'nodes': [int(n) for n in v['nodes']], 'tags': v.get('tags', {})} for k, v in (body.get('ways') or {}).items()}
        nodes = {int(k): tuple(v) for k, v in (body.get('nodes') or {}).items()}
        vias = [tuple(v) for v in body.get('vias') or []]
        avoid, require = way_ids(body.get('avoid')), way_ids(body.get('require'))
        g = graph_for(pid).patched(ways, nodes) if ways or nodes else None
        p, res = trace_with_vias(pid, vias, g, require=require, avoid=avoid)
        return self._json(trace_json(res, vias, avoid, require))

    def _raw(self, body, ctype):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200, cors=True):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._private = not cors   # end_headers says whether other sites may read it
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--feed', help='GTFS zip (default: newest in cache/)')
    ap.add_argument('--osm-roads', help='Overpass roads JSON (default: newest *roads*.json in cache/)')
    ap.add_argument('--osm-pt', help='Overpass PT JSON (default: newest *pt*.json in cache/)')
    ap.add_argument('--sandbox', help='a tool/sandbox.py address: the page and the rebuilds talk to it instead of OSM')
    a = ap.parse_args()
    if a.sandbox:
        STATE['sandbox'] = a.sandbox.rstrip('/')
        os.environ['OSM_API_URL'] = STATE['sandbox']
        os.environ['OVERPASS_URL'] = STATE['sandbox'] + '/api/interpreter'
        # its own cache and data, apart from the real review's
        os.environ.setdefault('FLAGSTOP_CACHE', os.path.join(ROOT, 'cache', 'sandbox', 'work'))
        os.environ.setdefault('FLAGSTOP_DATA', os.path.join(os.environ['FLAGSTOP_CACHE'], 'data'))
        print(f'sandbox: {STATE["sandbox"]} stands in for OpenStreetMap; files under {cache_dir()}', file=sys.stderr)
    newest = lambda pat: max(glob.glob(os.path.join(cache_dir(), pat)), key=os.path.getmtime, default=None)
    feed = a.feed or newest('*.zip')
    roads = a.osm_roads or newest('*roads*.json')
    pt = a.osm_pt or newest('*pt*.json')
    if feed:
        load(feed, roads, pt)
        STATE['paths'] = (feed, roads, pt)
    else:
        print('no feed/roads in cache/: serving the page without re-routing', file=sys.stderr)
    print(f'http://127.0.0.1:{a.port}/', file=sys.stderr)
    Server(('127.0.0.1', a.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
