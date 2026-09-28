#!/usr/bin/env python3
"""Serve the review page, and re-route a pattern on request.

    python3 tool/serve.py [--port 8765] [--feed FEED.zip] [--osm-roads cache/osm-roads.json]

Static files come from web/. With a feed and roads file loaded, the page can ask for a fresh trace
of a pattern through extra via points the reviewer drops on the map:

    GET /api/trace?pattern=<id>&via=<lon>,<lat>&via=...     -> the same shape as review.json's routed{}
    GET /api/relation?pattern=<id>&via=...                  -> the proposed relation as .osm

Runs on 127.0.0.1 only: JOSM's remote control (port 8111) accepts requests from a local page.
"""
import argparse, glob, json, os, sys, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtfs, osm, routes as routing, compare, stops as stopmatch, review

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
STATE = {}


def load(feed_path, roads_path, pt_path):
    feed = gtfs.load(feed_path)
    STATE['feed'] = feed
    STATE['patterns'] = {p.id: p for p in feed.patterns}
    STATE['graph'] = routing.Graph(osm.load(roads_path))
    if pt_path and os.path.exists(pt_path):
        osm_stops, *_ = osm.parse_pt(osm.load(pt_path))
        STATE['match'], _ = stopmatch.match(feed, osm_stops)
        STATE['osm_stops'] = osm_stops
    else:
        STATE['match'], STATE['osm_stops'] = {}, {}
    print(f'loaded {os.path.basename(feed_path)}: {len(feed.patterns)} patterns; graph {len(STATE["graph"].ways)} ways', file=sys.stderr)


def trace_with_vias(pid, vias):
    """Trace the pattern with via points folded into the stop list at the nearest leg."""
    feed, g = STATE['feed'], STATE['graph']
    p = STATE['patterns'][pid]
    pts = [(feed.stops[s].lon, feed.stops[s].lat) for s in p.stops]
    order = list(range(len(pts)))          # index into pts; vias get appended
    for v in vias:
        # Put the via between the two consecutive points whose segment it is nearest.
        best, bi = None, 0
        for i in range(len(order) - 1):
            _, d, _ = routing.project(v, pts[order[i]], pts[order[i + 1]])
            if best is None or d < best:
                best, bi = d, i
        pts.append(v)
        order.insert(bi + 1, len(pts) - 1)
    seq = [pts[i] for i in order]
    res = routing.trace(g, seq, feed.shapes.get(p.shape_id))
    # Legs are between consecutive points of seq; report them by their pattern stop index where that applies.
    is_stop = [i < len(p.stops) for i in order]
    return p, res, order, is_stop


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)

    def log_message(self, fmt, *args):
        if '/api/' in (args[0] if args else ''):
            super().log_message(fmt, *args)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith('/api/'):
            return super().do_GET()
        q = urllib.parse.parse_qs(u.query)
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
        p, res, order, is_stop = trace_with_vias(pid, vias)
        if u.path == '/api/trace':
            return self._json({
                'ways': res['ways'], 'geometry': [[round(x, 6), round(y, 6)] for x, y in res['geometry']],
                'legs': [{'from': l['from'], 'to': l['to'], 'ok': l['ok'], 'why': l['why'], 'ways': l['ways']} for l in res['legs']],
                'divergences': [{k: (review.round_pts(v) if k in ('shape', 'path') else v) for k, v in d.items()} for d in res['divergences']],
                'score': res['score'], 'vias': vias})
        if u.path == '/api/relation':
            path = os.path.join(ROOT, 'cache', f'rel-{review.safe(pid)}-via.osm')
            review.write_relation_osm(path, STATE['feed'], p, res, STATE['match'], STATE['osm_stops'])
            body = open(path, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/xml')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return
        self._json({'error': 'no such call'}, 404)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--feed', help='GTFS zip (default: newest in cache/)')
    ap.add_argument('--osm-roads', help='Overpass roads JSON (default: newest *roads*.json in cache/)')
    ap.add_argument('--osm-pt', help='Overpass PT JSON (default: newest *pt*.json in cache/)')
    a = ap.parse_args()
    newest = lambda pat: max(glob.glob(os.path.join(ROOT, 'cache', pat)), key=os.path.getmtime, default=None)
    feed = a.feed or newest('*.zip')
    roads = a.osm_roads or newest('*roads*.json')
    pt = a.osm_pt or newest('*pt*.json')
    if feed and roads:
        load(feed, roads, pt)
    else:
        print('no feed/roads in cache/: serving the page without re-routing', file=sys.stderr)
    print(f'http://127.0.0.1:{a.port}/', file=sys.stderr)
    ThreadingHTTPServer(('127.0.0.1', a.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
