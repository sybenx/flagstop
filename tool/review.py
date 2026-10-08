#!/usr/bin/env python3
"""Compare a GTFS feed with OpenStreetMap and write the review for the web page.

    python3 tool/review.py FEED.zip [--osm-pt cache/osm-pt.json] [--osm-roads cache/osm-roads.json] [--out web/data]

Without --osm-* files the OSM data is fetched from Overpass for the feed's bounding box and cached in
cache/. Writes web/data/review.json and one proposed relation per pattern, web/data/rel-<id>.osm, for
JOSM to import.
"""
import math, re, argparse, datetime, json, os, sys, time
from xml.sax.saxutils import quoteattr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtfs, osm, stops as stopmatch, routes as routing, compare, feeddiff, others, positions

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def days_of(c):
    """calendar.txt row -> 'Mo-Fr', 'Sa', 'Mo,We', … in OSM's opening_hours spelling."""
    if not c:
        return ''
    names = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
    on = [c.get(k) == '1' for k in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
    out, i = [], 0
    while i < 7:
        if not on[i]:
            i += 1; continue
        j = i
        while j + 1 < 7 and on[j + 1]:
            j += 1
        out.append(names[i] if i == j else f'{names[i]}{"-" if j > i + 1 else ","}{names[j]}')
        i = j + 1
    return ','.join(out)


def side(p, geom, kerb=3):
    """Which side of a bus path a point is on: 'right' (the kerb buses pull into; traffic drives on the right),
    'left' (across the street), or None (within kerb metres of the line, or beyond either end of it, where a side
    means nothing)."""
    best = None
    for i in range(len(geom) - 1):
        a, b = geom[i], geom[i + 1]
        kx = 111320 * math.cos(math.radians(a[1]))
        vx, vy = (b[0] - a[0]) * kx, (b[1] - a[1]) * 110540
        wx, wy = (p[0] - a[0]) * kx, (p[1] - a[1]) * 110540
        L2 = vx * vx + vy * vy
        if not L2:
            continue
        u = max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
        d = math.hypot(wx - u * vx, wy - u * vy)
        if best is None or d < best[0]:
            best = (d, vx * wy - vy * wx, (i == 0 and u == 0.0) or (i == len(geom) - 2 and u == 1.0))
    if not best or best[0] < kerb or best[2]:
        return None
    return 'left' if best[1] > 0 else 'right'


def stop_paths(feed, traced):
    """{stop_id: [path just before and after the stop, per itinerary calling there]}: so a loop down a street
    and back up it isn't confused."""
    out = {}
    for p in feed.patterns:
        legs = traced[p.id]['legs']
        for k, sid in enumerate(p.stops):
            geom = (legs[k - 1]['geometry'][-12:] if k and legs[k - 1]['ok'] else []) + (legs[k]['geometry'][:12] if k < len(legs) and legs[k]['ok'] else [])
            if len(geom) >= 2:
                out.setdefault(sid, []).append(geom)
    return out


def shape_paths(feed):
    """{stop_id: [the agency's line just before and after the stop, per itinerary calling there]}: which way the
    buses go past each stop, from the feed alone (no roads needed). Without a shape, the stops before and after."""
    out = {}
    for p in feed.patterns:
        shape = feed.shapes.get(p.shape_id) or []
        guide = routing.Polyline(shape) if len(shape) > 1 else None
        prev_seg = 0
        for k, sid in enumerate(p.stops):
            s = feed.stops[sid]
            if guide:
                d, i, m = guide.nearest((s.lon, s.lat))
                if k and i < prev_seg:   # a loop passes the same place twice: the pass after the previous stop
                    d2, i2, m2 = guide.nearest((s.lon, s.lat), lo=prev_seg, hi=len(guide.pts) - 2)
                    if d2 <= d + 30:
                        i, m = i2, m2
                prev_seg = max(prev_seg, i)
                geom = guide.slice(m - 120, m + 120)
            else:
                geom = [(feed.stops[x].lon, feed.stops[x].lat) for x in p.stops[max(0, k - 1):k + 2]]
            if len(geom) >= 2:
                out.setdefault(sid, []).append(geom)
    return out


def route_pattern(feed, p, g, match, osm_stops, stop_areas=()):
    """What needs roads, for one itinerary: the path a bus can drive, where it parts from the agency's line and
    why, whether its roads join up, the stop positions on them. -> the pattern's route fields."""
    tr = routing.trace(g, [(feed.stops[s].lon, feed.stops[s].lat) for s in p.stops], feed.shapes.get(p.shape_id))
    routed_breaks = compare.chain_breaks(tr['ways'], g.ways)
    # In and out of a dead end is a turnaround when the agency's line goes there too; when it doesn't,
    # a stop was put on the wrong way (the parking aisle beside the street), and the path is wrong.
    guide = routing.Polyline(feed.shapes[p.shape_id]) if len(feed.shapes.get(p.shape_id) or []) > 1 else None
    for b in routed_breaks:
        if b['kind'] == 'spur':
            far = [n for n in (g.ways[b['b']]['nodes'][0], g.ways[b['b']]['nodes'][-1]) if n != b['node'] and n in g.coord]
            b['turnaround'] = bool(guide and far and guide.nearest(g.coord[far[0]])[0] <= routing.DIVERGE)
    one = type('F', (), {'patterns': [p], 'stops': feed.stops})
    return {
        'chain_ok': all(l['ok'] for l in tr['legs']) and not any(b['kind'] == 'gap' or (b['kind'] == 'spur' and not b['turnaround']) for b in routed_breaks),
        'chain_breaks': [{**b, 'lon': g.coord[b['node']][0], 'lat': g.coord[b['node']][1]} for b in routed_breaks if b['node'] in g.coord],
        'way_tags': {w: g.ways[w].get('tags', {}) for w in tr['ways'] if w in g.ways},
        'way_nodes': {w: g.ways[w].get('nodes', []) for w in tr['ways'] if w in g.ways},
        'stop_positions': stop_positions(one, {p.id: tr}, match, osm_stops, g, list(stop_areas)).get(p.id, {}),
        'routed': {'ways': tr['ways'], 'geometry': [[round(x, 6), round(y, 6)] for x, y in tr['geometry']],
                   'legs': [{'from': l['from'], 'to': l['to'], 'ok': l['ok'], 'why': l['why'], 'ways': l['ways']} for l in tr['legs']],
                   'divergences': [{**{k: (round_pts(v) if k in ('shape', 'path') else v) for k, v in d.items()},
                                    'way_tags': {w: g.ways[w].get('tags', {}) for w in d['ways'] if w in g.ways}} for d in tr['divergences']],
                   'score': tr['score']},
    }


def across_fn(feed, paths):
    """-> across(stop_id, osm_stop): the OSM stop is across the street from where every bus calling there pulls
    in, and the agency's point isn't. Then it's the other direction's stop, never this one moved."""
    def across(sid, o):
        gs = paths.get(sid)
        if not gs:
            return False
        s = feed.stops[sid]
        # 5 m: closer than that to the middle of the road, which side it's on is inside how exactly roads are drawn
        return {side((o['lon'], o['lat']), g, kerb=5) for g in gs} == {'left'} and 'left' not in {side((s.lon, s.lat), g) for g in gs}
    return across


def stop_sides(feed, paths, match, osm_stops):
    """{stop_id: {'osm': side, 'gtfs': side}}: a stop some itinerary has on its right is on the right; only 'left'
    for every one of them counts as across."""
    pick = lambda xs: 'right' if 'right' in xs else 'left' if 'left' in xs else None
    out = {}
    for sid, gs in paths.items():
        s, m = feed.stops[sid], match.get(sid)
        o = osm_stops.get(m['osm'][0]['id']) if m and m['osm'] else None
        out[sid] = {'gtfs': pick({side((s.lon, s.lat), g) for g in gs}), 'osm': pick({side((o['lon'], o['lat']), g, kerb=5) for g in gs}) if o else None}
    return out


def stop_positions(feed, traced, match, osm_stops, g, stop_areas, near=25):
    """{pattern id: {stop id: node id}}: the stop position each stop has on the roads its buses drive, for the
    route relation (PTv2 lists it before the platform). One the stop's stop area names comes first; else the
    nearest stop_position node within `near` metres of the platform that's a point of a way the route uses, and
    that's level with this platform rather than another (each stop position belongs to its nearest platform)."""
    sp = {o['osm_id']: o for o in osm_stops.values() if o['tags'].get('public_transport') == 'stop_position' and o['id'][0] == 'n'}
    if not sp:
        return {}
    plats = [o for o in osm_stops.values() if o['tags'].get('public_transport') == 'platform' or o['tags'].get('highway') == 'bus_stop']
    bay = {n: min(plats, key=lambda q: stopmatch.dist(x['lat'], x['lon'], q['lat'], q['lon']))['id'] for n, x in sp.items()} if plats else {}
    grouped = {}
    for a in stop_areas:
        stops_ = {m['ref'] for m in a['members'] if m['role'] == 'stop' and m['type'] == 'node'}
        for m in a['members']:
            if m['role'] == 'platform':
                grouped.setdefault(f"{m['type'][0]}{m['ref']}", set()).update(stops_)
    out = {}
    for p in feed.patterns:
        legs, got = traced[p.id]['legs'], {}
        for k, sid in enumerate(p.stops):
            ways = set((legs[k - 1]['ways'] if k else []) + (legs[k]['ways'] if k < len(legs) else []))
            on = {n for w in ways if w in g.ways for n in g.ways[w].get('nodes', [])}
            m = match.get(sid) or {}
            o = osm_stops.get(m['osm'][0]['id']) if m.get('status') == 'matched' and m.get('osm') else None
            if not o:
                continue
            cands = [(n, stopmatch.dist(o['lat'], o['lon'], x['lat'], x['lon'])) for n, x in sp.items() if n in on and bay.get(n) == o['id']]
            cands = [c for c in cands if c[1] <= near]
            if not cands:
                continue
            pref = grouped.get(o['id'], set()) if o else set()
            got[sid] = min(cands, key=lambda c: (c[0] not in pref, c[1]))[0]
        if got:
            out[p.id] = got
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('feed')
    ap.add_argument('--osm-pt')
    ap.add_argument('--osm-roads')
    ap.add_argument('--out', default=os.environ.get('FLAGSTOP_DATA') or os.path.join(ROOT, 'web', 'data'))        # FLAGSTOP_DATA, FLAGSTOP_CACHE: a sandbox
    ap.add_argument('--cache', default=os.environ.get('FLAGSTOP_CACHE') or os.path.join(ROOT, 'cache'))             # run keeps its files apart (tool/sandbox.py)
    ap.add_argument('--refresh', action='store_true', help='fetch OSM again even if cached (roads too, if a day old)')
    ap.add_argument('--refresh-roads', action='store_true', help='fetch the roads again, however recent')
    ap.add_argument('--also', action='append', default=[], help="another operator's GTFS zip (path or URL) whose stops share this area")
    ap.add_argument('--no-others', action='store_true', help="don't look up other agencies' feeds in the Mobility Database")
    ap.add_argument('--route-all', action='store_true', help='route every itinerary now, with all the roads (else each is routed when opened)')
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True); os.makedirs(a.cache, exist_ok=True)
    feed = gtfs.load(a.feed)
    box = gtfs.bbox(feed)
    slug = ''.join(c if c.isalnum() else '-' for c in feed.agency.get('agency_name', 'feed').lower()).strip('-')[:40]
    pt_raw = osm.load(a.osm_pt) if a.osm_pt else osm.cached(os.path.join(a.cache, f'{slug}-osm-pt.json'), osm.fetch_pt, box, a.refresh)
    # roads: the biggest fetch and the slowest (Overpass often busy); they change less than stops and routes, and
    # an upload's own road edits come in by tool/patch.py. Again when asked, or when a day old.
    rp = os.path.join(a.cache, f'{slug}-osm-roads.json')
    stale = not os.path.exists(rp) or time.time() - os.path.getmtime(rp) > 86400
    roads_raw = (osm.load(a.osm_roads) if a.osm_roads else osm.cached(rp, osm.fetch_roads, box, a.refresh_roads or (a.refresh and stale))) if a.route_all else None
    notes_raw = osm.cached(os.path.join(a.cache, f'{slug}-notes.json'), osm.fetch_notes, box, a.refresh)
    osm_fetched = datetime.datetime.fromtimestamp(os.path.getmtime(a.osm_pt or os.path.join(a.cache, f'{slug}-osm-pt.json'))).isoformat(timespec='minutes')

    feed_changes = feeddiff.track(feed, a.cache, slug)
    other_stops = [] if a.no_others else others.gather(box, a.cache, feed.agency.get('agency_name', ''), a.also)   # what changed since the last feed version reviewed
    osm_stops, rels, masters, rel_ways, coords = osm.parse_pt(pt_raw)
    print(f'{len(feed.stops)} GTFS stops, {len(feed.patterns)} patterns; OSM: {len(osm_stops)} stops, {len(rels)} route relations, {len(masters)} masters', file=sys.stderr)

    # Which way the buses go past each stop, from the agency's line: a stop across the street from where they
    # pull in is the other direction's, so matching has to know which side is which. No roads needed.
    paths = shape_paths(feed)

    # who else stops at each OSM stop, by their own feeds: a shared stop is known, not guessed from its tags
    for o in osm_stops.values():
        o['served_by'] = sorted({x['agency'] for x in other_stops if stopmatch.dist(o['lat'], o['lon'], x['lat'], x['lon']) <= 20})
    match, extra = stopmatch.match(feed, osm_stops, across_fn(feed, paths))
    typical, far = stopmatch.calibrate(match)
    print(f'positions: usually {typical} m apart; the same spot within {far} m', file=sys.stderr)
    # The agency's moves, from the feed versions kept: a stop it moved is found in OSM where it used to be
    vs = positions.versions(a.cache, slug)
    jumped = positions.jumps(vs)
    if jumped:
        print(f'positions: the agency moved {len(jumped)} stops since an earlier feed version', file=sys.stderr)
    claimed = {m['osm'][0]['id'] for m in match.values() if m and m['status'] == 'matched' and m.get('osm')}
    for sid, j in jumped.items():
        m = match.get(sid)
        if not m or m['status'] != 'missing':
            continue
        old = [(stopmatch.dist(j['from'][1], j['from'][0], o['lat'], o['lon']), o) for o in osm_stops.values()
               if o['id'] not in claimed and stopmatch.is_platform(o) and stopmatch.dist(j['from'][1], j['from'][0], o['lat'], o['lon']) <= far]
        if old:
            d, o = min(old, key=lambda x: x[0])
            s = feed.stops[sid]
            m.update(status='moved', osm=[{'id': o['id'], 'dist': round(stopmatch.dist(s.lat, s.lon, o['lat'], o['lon'])), 'score': 1.0, 'how': 'moved'}])
            claimed.add(o['id'])
            if o['id'] in extra:
                extra.remove(o['id'])   # the stop it was: not 'OSM only' any more
    for sid, m in match.items():   # what counts as a different position, now that it's known
        if m and m['status'] in ('matched', 'moved') and m['osm'] and m['osm'][0]['id'] in osm_stops:
            m['diff'] = stopmatch.diff(feed, feed.stops[sid], osm_stops[m['osm'][0]['id']])
    conv = stopmatch.conventions(feed, match, osm_stops)
    print(f'local conventions: {conv}', file=sys.stderr)
    aliases = osm.nsi_aliases(conv.get('network'), os.path.join(a.cache, 'nsi-bus.json'), a.refresh) if conv.get('network') else set()
    for sid, m in match.items():
        if m and m['status'] in ('matched', 'moved') and m['osm'] and m['osm'][0]['id'] in osm_stops:
            m['diff'].update(stopmatch.network_diff(feed, osm_stops[m['osm'][0]['id']], conv, aliases))
            stopmatch.keep_foreign_routes(feed, osm_stops[m['osm'][0]['id']], m['diff'])
    # Which side of the street each stop is on, for the buses that call there; then what to suggest per difference.
    sides = stop_sides(feed, paths, match, osm_stops)
    names = {stopmatch.address(st.name): (st.id, st.name) for st in feed.stops.values()}
    for sid, m in match.items():
        if m and m['status'] in ('matched', 'moved') and m['osm'] and m['osm'][0]['id'] in osm_stops:
            m['decide'] = stopmatch.decide(feed.stops[sid], osm_stops[m['osm'][0]['id']], m['diff'], sides.get(sid), names)
            if m.get('merged_with'):   # two stops made one
                near_, far_ = osm_stops[m['osm'][0]['id']], osm_stops[m['merged_with']['id']]
                m['decide']['position'] = {'pick': 'ask', 'why': f"The agency has one stop here where OSM has two, either side: '{near_['tags'].get('name') or near_['id']}' ({m['osm'][0]['dist']} m) and '{far_['tags'].get('name') or far_['id']}' ({m['merged_with']['dist']} m). Probably merged into this one: move the nearer here (it takes the agency's name and codes) and remove the other"}
            m['side'] = sides.get(sid)
    # A stop the agency moved: where OSM's node goes, by how the node got where it is (its history)
    api = os.environ.get('OSM_API_URL', 'https://api.openstreetmap.org').rstrip('/')
    for sid, j in jumped.items():
        m = match.get(sid)
        if not (m and m['status'] in ('matched', 'moved') and m.get('osm') and m['osm'][0]['id'] in osm_stops and m.get('decide') is not None):
            continue
        o = osm_stops[m['osm'][0]['id']]
        if o['id'][0] != 'n':
            continue
        prov = positions.provenance(positions.history(api, o['osm_id'], a.cache, a.refresh), positions.agency_points(vs, sid))
        pl = positions.plan(feed.stops[sid], o, j, prov, stopmatch.FAR)
        if pl:
            m['decide']['position'] = {'pick': 'ask', 'why': pl['why']}
            m.update(move_to=pl['to'], move_how=pl['how'], provenance=prov, jump=j)
    stop_areas = list(getattr(osm.parse_pt, 'stop_areas', {}).values())
    # Which relation is which pattern.
    best, chosen, scores = compare.pair(feed, None, rels, rel_ways, coords, match)
    # the roads, only when asked to route everything now (tests, a hosted build); else each route when opened
    g = routing.Graph(roads_raw) if roads_raw else None
    masters_by_ref, masters_of_rel = {}, {}
    for m in masters.values():
        masters_by_ref.setdefault((m['tags'].get('ref') or '').strip(), []).append(m['id'])
        for mm in m['members']:
            if mm['type'] == 'relation':
                masters_of_rel.setdefault(mm['ref'], []).append(m['id'])

    patterns_out = []
    for p in feed.patterns:
        audits = [compare.audit(feed, p, rels[rid], rel_ways, coords, match, None, conv) for rid in best.get(p.id, []) if p.id in chosen.get(rid, [])]
        for au in audits:
            au['duplicate'] = len(audits) > 1
            au['both_directions'] = len(chosen.get(au['id'], [])) > 1
            au['also_covers'] = [x for x in chosen.get(au['id'], []) if x != p.id]
        patterns_out.append({
            'id': p.id, 'route_id': p.route_id, 'direction': p.direction, 'direction_name': p.direction_name, 'headsign': p.headsign,
            'shape_id': p.shape_id, 'stops': p.stops, 'trips': p.trips, 'variants': p.variants, 'temporary': p.temporary,
            'alt_shapes': p.alt_shapes, 'alt_stops': p.alt_stops, 'loop': p.loop, 'split_at': p.split_at,
            'services': [{'id': sid, 'days': days_of(feed.calendar.get(sid)), 'first': h[0], 'last': h[1], 'trips': h[2], 'every': h[3], 'steady': h[4]} for sid, h in sorted(p.hours.items())],
            **(route_pattern(feed, p, g, match, osm_stops, stop_areas) if g else {}),
            'shape': [[round(x, 6), round(y, 6)] for x, y in feed.shapes.get(p.shape_id, [])],
            'relations': audits,
            'proposed_tags': compare.proposed_relation_tags(feed, p, match, conv),
        })
        write_gpx(os.path.join(a.out, f'shape-{safe(p.id)}.gpx'), feed, p)

    routes_out = []
    for r in sorted(feed.routes.values(), key=lambda r: (len(r.short), r.short)):
        pids = [p.id for p in feed.patterns if p.route_id == r.id]
        if not pids:
            continue
        # the route's masters: those holding a relation paired with one of its itineraries (route 16's "16 AM" and
        # "16 PM" share one master, ref 16), else one with its ref; a new master is proposed only when there is neither
        held = sorted({mid for pid in pids for rid in best.get(pid, []) if pid in chosen.get(rid, []) for mid in masters_of_rel.get(rid, [])})
        routes_out.append({'id': r.id, 'short': r.short, 'long': r.long, 'desc': r.desc, 'color': r.color, 'text_color': r.text_color, 'url': r.url,
                           'patterns': pids, 'masters': held or masters_by_ref.get(r.short, []), 'proposed_master_tags': compare.proposed_master_tags(feed, r.id, conv)})

    # open OSM notes by a stop (its agency point or its OSM node): someone saw something there
    notes = [{'id': f['properties']['id'], 'lon': f['geometry']['coordinates'][0], 'lat': f['geometry']['coordinates'][1],
              'text': (f['properties']['comments'] or [{}])[0].get('text', ''), 'date': (f['properties'].get('date_created') or '')[:10]}
             for f in notes_raw.get('features', [])]
    # by a stop: within 30 m, or within 150 m when it talks about a bus stop (a note is often dropped where the
    # stop should be, not on the mapped one)
    busy = re.compile(r'\b(bus|stop|shelter|bench)\b', re.I)
    near_note = lambda la, lo, x: stopmatch.dist(la, lo, x['lat'], x['lon']) <= (150 if busy.search(x['text']) else 30)
    brief = lambda x: {k: x[k] for k in ('id', 'text', 'date')}
    def notes_by(s):
        m = match.get(s.id) or {}
        o = osm_stops.get(m['osm'][0]['id']) if m.get('osm') else None
        pts = [(s.lat, s.lon)] + ([(o['lat'], o['lon'])] if o else [])
        return [brief(x) for x in notes if any(near_note(la, lo, x) for la, lo in pts)]
    for o in osm_stops.values():
        o['notes'] = [brief(x) for x in notes if near_note(o['lat'], o['lon'], x)]
    stops_out = {}
    for s in feed.stops.values():
        stops_out[s.id] = {'id': s.id, 'code': s.code, 'ref': s.ref, 'name': s.name, 'lat': s.lat, 'lon': s.lon, 'desc': s.desc, 'tts': s.tts, 'url': s.url,
                           'wheelchair': s.wheelchair, 'platform_code': s.platform_code, 'parent': s.parent, 'location_type': s.location_type,
                           'routes': sorted(s.routes), 'trips': s.trips, 'match': match.get(s.id), 'proposed_tags': stopmatch.proposed_tags(feed, s, conv), 'osm_notes': notes_by(s)}

    unpaired = [compare_lite(rels[rid], rel_ways, coords) for rid, pids in chosen.items() if not pids]

    out = {
        'generated': datetime.datetime.now().isoformat(timespec='minutes'),
        'agency': feed.agency, 'feed': {**feed.info, 'file': os.path.basename(a.feed), 'bbox': box}, 'osm_fetched': osm_fetched,
        # how current the data is: Overpass runs behind OSM, so this, not when it was fetched
        'positions': {'typical': stopmatch.TYPICAL, 'far': stopmatch.FAR},
        'osm_base': min(filter(None, [(r.get('osm3s') or {}).get('timestamp_osm_base') for r in (pt_raw, roads_raw) if r]), default=None),
        'routes': routes_out, 'patterns': patterns_out, 'stops': stops_out,
        'osm_stops': {k: {'id': v['id'], 'lat': v['lat'], 'lon': v['lon'], 'tags': v['tags'], 'version': v['version'], 'timestamp': v['timestamp'], 'user': v['user'],
                          **({'nodes': v['nodes']} if v.get('nodes') else {}), **({'notes': v['notes']} if v.get('notes') else {}), **({'served_by': v['served_by']} if v.get('served_by') else {})} for k, v in osm_stops.items()},
        'stop_areas': list(getattr(osm.parse_pt, 'stop_areas', {}).values()),
        'feed_changes': feed_changes,
        'extra_stops': extra,
        'extra_owner': {k: 'other' if osm_stops[k].get('served_by') else stopmatch.owner(feed, osm_stops[k], conv, aliases) for k in extra if k in osm_stops},
        'other_agencies': sorted({x['agency'] for x in other_stops}),
        'unpaired_relations': unpaired,
        'masters': [{'id': m['id'], 'tags': m['tags'], 'version': m['version'], 'members': [{'type': x['type'], 'ref': x['ref'], 'role': x['role']} for x in m['members']],
                     'routes': [x['ref'] for x in m['members'] if x['type'] == 'relation']} for m in masters.values()],
        'conventions': conv,
        'summary': summary(feed, match, extra, patterns_out, unpaired),
    }
    os.makedirs(a.out, exist_ok=True)
    # files from itineraries that aren't in this run (two halves now joined into a loop, a route gone)
    keep = {f'rel-{safe(p.id)}.osm' for p in feed.patterns} | {f'shape-{safe(p.id)}.gpx' for p in feed.patterns}
    for f in os.listdir(a.out):
        if (f.startswith('rel-') and f.endswith('.osm') or f.startswith('shape-') and f.endswith('.gpx')) and f not in keep:
            os.remove(os.path.join(a.out, f))
    json.dump(out, open(os.path.join(a.out, 'review.json'), 'w'), separators=(',', ':'))
    s = out['summary']
    print(f"stops: {s['stops']}  patterns: {s['patterns']}  → {os.path.join(a.out, 'review.json')}", file=sys.stderr)


def write_gpx(path, feed, p):
    """The agency's shape as a GPX track, for iD/RapiD's custom data layer."""
    r = feed.routes[p.route_id]
    pts = ''.join(f'      <trkpt lat="{lat:.6f}" lon="{lon:.6f}"/>\n' for lon, lat in feed.shapes.get(p.shape_id, []))
    with open(path, 'w') as f:
        f.write(f'<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="flagstop" xmlns="http://www.topografix.com/GPX/1/1">\n'
                f'  <trk><name>{r.short} {p.headsign or p.direction_name}</name><desc>GTFS shape {p.shape_id}</desc><trkseg>\n{pts}    </trkseg></trk>\n</gpx>\n')


def round_pts(pts):
    return [[round(x, 6), round(y, 6)] for x, y in pts]


def safe(x):
    return ''.join(c if c.isalnum() else '_' for c in x)


def compare_lite(rel, ways, coords):
    return {'id': rel['id'], 'tags': rel['tags'], 'ways': len(compare.relation_way_ids(rel)), 'stops': len(compare.relation_platforms(rel)),
            'geometry': [pts for _, pts in compare.relation_geometry(rel, ways, coords)], 'version': rel.get('version'), 'user': rel.get('user'), 'timestamp': rel.get('timestamp')}


def summary(feed, match, extra, patterns, unpaired):
    from collections import Counter
    st = Counter(m['status'] for m in match.values())
    diffs = Counter(k for m in match.values() if m.get('diff') for k in m['diff'])
    pat = Counter()
    for p in patterns:
        if p['temporary']:
            pat['temporary'] += 1
            continue
        if not p['relations']:
            pat['no relation'] += 1
        elif any(r['duplicate'] for r in p['relations']):
            pat['duplicate relations'] += 1
        elif any(r['stops']['missing'] or r['stops']['extra'] or r['stops']['out_of_order'] or r['ways']['off_shape'] or r['tag_issues'] for r in p['relations']):
            pat['relation needs work'] += 1
        else:
            pat['relation ok'] += 1
        if (p.get('routed') or {}).get('divergences'):
            pat['map divergences'] += 1
    return {'stops': dict(st), 'stop_diffs': dict(diffs), 'extra_osm_stops': len(extra), 'patterns': dict(pat), 'unpaired_relations': len(unpaired)}


def write_relation_osm(path, feed, p, tr, match, osm_stops, conv=None):
    """A PTv2 route relation for JOSM: platforms (existing OSM nodes where matched, new nodes otherwise)
    then the routed ways in order. Existing objects are referenced by id; JOSM fetches them when the
    page loads them first (remote control load_object), or on 'download incomplete members'."""
    tags = compare.proposed_relation_tags(feed, p, match, conv)
    nid = -1
    nodes, members = [], []
    for sid in p.stops:
        s = feed.stops[sid]
        m = match.get(sid)
        if m and m['status'] == 'matched' and m['osm'] and m['osm'][0]['id'].startswith('n'):
            members.append(('node', int(m['osm'][0]['id'][1:]), 'platform'))
        else:
            t = stopmatch.proposed_tags(feed, s, conv)
            nodes.append(f'  <node id="{nid}" lat="{s.lat:.6f}" lon="{s.lon:.6f}" version="0">\n' + ''.join(f'    <tag k={quoteattr(k)} v={quoteattr(str(v))}/>\n' for k, v in t.items()) + '  </node>\n')
            members.append(('node', nid, 'platform')); nid -= 1
    for w in tr['ways']:
        members.append(('way', w, ''))
    rel = f'  <relation id="-1" version="0">\n' + ''.join(f'    <member type="{t}" ref="{r}" role="{role}"/>\n' for t, r, role in members) + ''.join(f'    <tag k={quoteattr(k)} v={quoteattr(str(v))}/>\n' for k, v in tags.items()) + '  </relation>\n'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="flagstop" upload="true">\n' + ''.join(nodes) + rel + '</osm>\n')


if __name__ == '__main__':
    main()
