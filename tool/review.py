#!/usr/bin/env python3
"""Compare a GTFS feed with OpenStreetMap and write the review for the web page.

    python3 tool/review.py FEED.zip [--osm-pt cache/osm-pt.json] [--osm-roads cache/osm-roads.json] [--out web/data]

Without --osm-* files the OSM data is fetched from Overpass for the feed's bounding box and cached in
cache/. Writes web/data/review.json and one proposed relation per pattern, web/data/rel-<id>.osm, for
JOSM to import.
"""
import math, argparse, datetime, json, os, sys
from xml.sax.saxutils import quoteattr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtfs, osm, stops as stopmatch, routes as routing, compare

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
    'left' (across the street), or None (within kerb metres of the line)."""
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
            best = (d, vx * wy - vy * wx)
    if not best or best[0] < kerb:
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('feed')
    ap.add_argument('--osm-pt')
    ap.add_argument('--osm-roads')
    ap.add_argument('--out', default=os.path.join(ROOT, 'web', 'data'))
    ap.add_argument('--cache', default=os.path.join(ROOT, 'cache'))
    ap.add_argument('--refresh', action='store_true', help='fetch OSM again even if cached')
    a = ap.parse_args()

    feed = gtfs.load(a.feed)
    box = gtfs.bbox(feed)
    slug = ''.join(c if c.isalnum() else '-' for c in feed.agency.get('agency_name', 'feed').lower()).strip('-')[:40]
    pt_raw = osm.load(a.osm_pt) if a.osm_pt else osm.cached(os.path.join(a.cache, f'{slug}-osm-pt.json'), osm.fetch_pt, box, a.refresh)
    roads_raw = osm.load(a.osm_roads) if a.osm_roads else osm.cached(os.path.join(a.cache, f'{slug}-osm-roads.json'), osm.fetch_roads, box, a.refresh)
    osm_fetched = datetime.datetime.fromtimestamp(os.path.getmtime(a.osm_pt or os.path.join(a.cache, f'{slug}-osm-pt.json'))).isoformat(timespec='minutes')

    osm_stops, rels, masters, rel_ways, coords = osm.parse_pt(pt_raw)
    print(f'{len(feed.stops)} GTFS stops, {len(feed.patterns)} patterns; OSM: {len(osm_stops)} stops, {len(rels)} route relations, {len(masters)} masters', file=sys.stderr)

    # The buses' paths first (they only need the feed and the roads): a stop across the street from where the
    # buses pull in is the other direction's, so matching has to know which side is which.
    g = routing.Graph(roads_raw)
    print(f'road graph: {len(g.ways)} ways, {len(g.coord)} nodes', file=sys.stderr)
    traced = {}
    for p in feed.patterns:
        traced[p.id] = routing.trace(g, [(feed.stops[s].lon, feed.stops[s].lat) for s in p.stops], feed.shapes.get(p.shape_id))
    paths = stop_paths(feed, traced)

    match, extra = stopmatch.match(feed, osm_stops, across_fn(feed, paths))
    typical, far = stopmatch.calibrate(match)
    print(f'positions: usually {typical} m apart; the same spot within {far} m', file=sys.stderr)
    for sid, m in match.items():   # what counts as a different position, now that it's known
        if m and m['status'] in ('matched', 'moved') and m['osm'] and m['osm'][0]['id'] in osm_stops:
            m['diff'] = stopmatch.diff(feed, feed.stops[sid], osm_stops[m['osm'][0]['id']])
    conv = stopmatch.conventions(feed, match, osm_stops)
    print(f'local conventions: {conv}', file=sys.stderr)
    aliases = osm.nsi_aliases(conv.get('network'), os.path.join(a.cache, 'nsi-bus.json'), a.refresh) if conv.get('network') else set()
    for sid, m in match.items():
        if m and m['status'] in ('matched', 'moved') and m['osm'] and m['osm'][0]['id'] in osm_stops:
            m['diff'].update(stopmatch.network_diff(feed, osm_stops[m['osm'][0]['id']], conv, aliases))
    # Which side of the street each stop is on, for the buses that call there; then what to suggest per difference.
    sides = stop_sides(feed, paths, match, osm_stops)
    names = {stopmatch.address(st.name): (st.id, st.name) for st in feed.stops.values()}
    for sid, m in match.items():
        if m and m['status'] in ('matched', 'moved') and m['osm'] and m['osm'][0]['id'] in osm_stops:
            m['decide'] = stopmatch.decide(feed.stops[sid], osm_stops[m['osm'][0]['id']], m['diff'], sides.get(sid), names)
            m['side'] = sides.get(sid)
    # Which relation is which pattern.
    best, chosen, scores = compare.pair(feed, traced, rels, rel_ways, coords, match)
    masters_by_ref = {}
    for m in masters.values():
        masters_by_ref.setdefault((m['tags'].get('ref') or '').strip(), []).append(m['id'])

    patterns_out = []
    for p in feed.patterns:
        tr = traced[p.id]
        audits = [compare.audit(feed, p, rels[rid], rel_ways, coords, match, tr, conv) for rid in best.get(p.id, []) if p.id in chosen.get(rid, [])]
        for au in audits:
            au['duplicate'] = len(audits) > 1
            au['both_directions'] = len(chosen.get(au['id'], [])) > 1
            au['also_covers'] = [x for x in chosen.get(au['id'], []) if x != p.id]
        routed_breaks = compare.chain_breaks(tr['ways'], g.ways)
        # In and out of a dead end is a turnaround when the agency's line goes there too; when it doesn't,
        # a stop was put on the wrong way (the parking aisle beside the street), and the path is wrong.
        guide = routing.Polyline(feed.shapes[p.shape_id]) if len(feed.shapes.get(p.shape_id) or []) > 1 else None
        for b in routed_breaks:
            if b['kind'] == 'spur':
                far = [n for n in (g.ways[b['b']]['nodes'][0], g.ways[b['b']]['nodes'][-1]) if n != b['node'] and n in g.coord]
                b['turnaround'] = bool(guide and far and guide.nearest(g.coord[far[0]])[0] <= routing.DIVERGE)
        patterns_out.append({
            'id': p.id, 'route_id': p.route_id, 'direction': p.direction, 'direction_name': p.direction_name, 'headsign': p.headsign,
            'shape_id': p.shape_id, 'stops': p.stops, 'trips': p.trips, 'variants': p.variants, 'temporary': p.temporary,
            'alt_shapes': p.alt_shapes, 'alt_stops': p.alt_stops, 'loop': p.loop, 'split_at': p.split_at,
            'services': [{'id': sid, 'days': days_of(feed.calendar.get(sid)), 'first': h[0], 'last': h[1], 'trips': h[2], 'every': h[3], 'steady': h[4]} for sid, h in sorted(p.hours.items())],
            'chain_ok': all(l['ok'] for l in tr['legs']) and not any(b['kind'] == 'gap' or (b['kind'] == 'spur' and not b['turnaround']) for b in routed_breaks),
            'chain_breaks': [{**b, 'lon': g.coord[b['node']][0], 'lat': g.coord[b['node']][1]} for b in routed_breaks if b['node'] in g.coord],
            'way_tags': {w: g.ways[w].get('tags', {}) for w in tr['ways'] if w in g.ways},
            'way_nodes': {w: g.ways[w].get('nodes', []) for w in tr['ways'] if w in g.ways},
            'shape': [[round(x, 6), round(y, 6)] for x, y in feed.shapes.get(p.shape_id, [])],
            'routed': {'ways': tr['ways'], 'geometry': [[round(x, 6), round(y, 6)] for x, y in tr['geometry']],
                       'legs': [{'from': l['from'], 'to': l['to'], 'ok': l['ok'], 'why': l['why'], 'ways': l['ways']} for l in tr['legs']],
                       'divergences': [{**{k: (round_pts(v) if k in ('shape', 'path') else v) for k, v in d.items()},
                                        'way_tags': {w: g.ways[w].get('tags', {}) for w in d['ways'] if w in g.ways}} for d in tr['divergences']],
                       'score': tr['score']},
            'relations': audits,
            'proposed_tags': compare.proposed_relation_tags(feed, p, match, conv),
        })
        write_relation_osm(os.path.join(a.out, f'rel-{safe(p.id)}.osm'), feed, p, tr, match, osm_stops, conv)
        write_gpx(os.path.join(a.out, f'shape-{safe(p.id)}.gpx'), feed, p)

    routes_out = []
    for r in sorted(feed.routes.values(), key=lambda r: (len(r.short), r.short)):
        pids = [p.id for p in feed.patterns if p.route_id == r.id]
        if not pids:
            continue
        routes_out.append({'id': r.id, 'short': r.short, 'long': r.long, 'desc': r.desc, 'color': r.color, 'text_color': r.text_color, 'url': r.url,
                           'patterns': pids, 'masters': masters_by_ref.get(r.short, []), 'proposed_master_tags': compare.proposed_master_tags(feed, r.id, conv)})

    stops_out = {}
    for s in feed.stops.values():
        stops_out[s.id] = {'id': s.id, 'code': s.code, 'ref': s.ref, 'name': s.name, 'lat': s.lat, 'lon': s.lon, 'desc': s.desc, 'tts': s.tts, 'url': s.url,
                           'wheelchair': s.wheelchair, 'platform_code': s.platform_code, 'parent': s.parent, 'location_type': s.location_type,
                           'routes': sorted(s.routes), 'trips': s.trips, 'match': match.get(s.id), 'proposed_tags': stopmatch.proposed_tags(feed, s, conv)}

    unpaired = [compare_lite(rels[rid], rel_ways, coords) for rid, pids in chosen.items() if not pids]

    out = {
        'generated': datetime.datetime.now().isoformat(timespec='minutes'),
        'agency': feed.agency, 'feed': {**feed.info, 'file': os.path.basename(a.feed), 'bbox': box}, 'osm_fetched': osm_fetched,
        # how current the data is: Overpass runs behind OSM, so this, not when it was fetched
        'positions': {'typical': stopmatch.TYPICAL, 'far': stopmatch.FAR},
        'osm_base': min(filter(None, [(r.get('osm3s') or {}).get('timestamp_osm_base') for r in (pt_raw, roads_raw)]), default=None),
        'routes': routes_out, 'patterns': patterns_out, 'stops': stops_out,
        'osm_stops': {k: {'id': v['id'], 'lat': v['lat'], 'lon': v['lon'], 'tags': v['tags'], 'version': v['version'], 'timestamp': v['timestamp'], 'user': v['user'],
                          **({'nodes': v['nodes']} if v.get('nodes') else {})} for k, v in osm_stops.items()},
        'stop_areas': list(getattr(osm.parse_pt, 'stop_areas', {}).values()),
        'extra_stops': extra,
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
        if p['routed']['divergences']:
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
