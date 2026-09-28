#!/usr/bin/env python3
"""Compare a GTFS feed with OpenStreetMap and write the review for the web page.

    python3 tool/review.py FEED.zip [--osm-pt cache/osm-pt.json] [--osm-roads cache/osm-roads.json] [--out web/data]

Without --osm-* files the OSM data is fetched from Overpass for the feed's bounding box and cached in
cache/. Writes web/data/review.json and one proposed relation per pattern, web/data/rel-<id>.osm, for
JOSM to import.
"""
import argparse, datetime, json, os, sys
from xml.sax.saxutils import quoteattr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtfs, osm, stops as stopmatch, routes as routing, compare

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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

    match, extra = stopmatch.match(feed, osm_stops)
    g = routing.Graph(roads_raw)
    print(f'road graph: {len(g.ways)} ways, {len(g.coord)} nodes', file=sys.stderr)

    traced = {}
    for p in feed.patterns:
        traced[p.id] = routing.trace(g, [(feed.stops[s].lon, feed.stops[s].lat) for s in p.stops], feed.shapes.get(p.shape_id))
    # Which relation is which pattern.
    best, chosen, scores = compare.pair(feed, traced, rels, rel_ways, coords)
    masters_by_ref = {}
    for m in masters.values():
        masters_by_ref.setdefault((m['tags'].get('ref') or '').strip(), []).append(m['id'])

    patterns_out = []
    for p in feed.patterns:
        tr = traced[p.id]
        audits = [compare.audit(feed, p, rels[rid], rel_ways, coords, match, tr) for rid in best.get(p.id, []) if chosen.get(rid) == p.id]
        for au in audits:
            au['duplicate'] = len(audits) > 1
        patterns_out.append({
            'id': p.id, 'route_id': p.route_id, 'direction': p.direction, 'direction_name': p.direction_name, 'headsign': p.headsign,
            'shape_id': p.shape_id, 'stops': p.stops, 'trips': p.trips, 'variants': p.variants,
            'shape': [[round(x, 6), round(y, 6)] for x, y in feed.shapes.get(p.shape_id, [])],
            'routed': {'ways': tr['ways'], 'geometry': [[round(x, 6), round(y, 6)] for x, y in tr['geometry']],
                       'legs': [{'from': l['from'], 'to': l['to'], 'ok': l['ok'], 'why': l['why'], 'ways': l['ways']} for l in tr['legs']],
                       'divergences': [{k: (round_pts(v) if k in ('shape', 'path') else v) for k, v in d.items()} for d in tr['divergences']],
                       'score': tr['score']},
            'relations': audits,
            'proposed_tags': compare.proposed_relation_tags(feed, p, match),
        })
        write_relation_osm(os.path.join(a.out, f'rel-{safe(p.id)}.osm'), feed, p, tr, match, osm_stops)

    routes_out = []
    for r in sorted(feed.routes.values(), key=lambda r: (len(r.short), r.short)):
        pids = [p.id for p in feed.patterns if p.route_id == r.id]
        if not pids:
            continue
        routes_out.append({'id': r.id, 'short': r.short, 'long': r.long, 'desc': r.desc, 'color': r.color, 'text_color': r.text_color, 'url': r.url,
                           'patterns': pids, 'masters': masters_by_ref.get(r.short, []), 'proposed_master_tags': compare.proposed_master_tags(feed, r.id)})

    stops_out = {}
    for s in feed.stops.values():
        stops_out[s.id] = {'id': s.id, 'code': s.code, 'ref': s.ref, 'name': s.name, 'lat': s.lat, 'lon': s.lon, 'desc': s.desc, 'tts': s.tts, 'url': s.url,
                           'wheelchair': s.wheelchair, 'platform_code': s.platform_code, 'parent': s.parent, 'location_type': s.location_type,
                           'routes': sorted(s.routes), 'trips': s.trips, 'match': match.get(s.id), 'proposed_tags': stopmatch.proposed_tags(feed, s)}

    unpaired = [compare_lite(rels[rid], rel_ways, coords) for rid, pid in chosen.items() if pid is None]

    out = {
        'generated': datetime.datetime.now().isoformat(timespec='minutes'),
        'agency': feed.agency, 'feed': {**feed.info, 'file': os.path.basename(a.feed), 'bbox': box}, 'osm_fetched': osm_fetched,
        'routes': routes_out, 'patterns': patterns_out, 'stops': stops_out,
        'osm_stops': {k: {'id': v['id'], 'lat': v['lat'], 'lon': v['lon'], 'tags': v['tags'], 'version': v['version'], 'timestamp': v['timestamp'], 'user': v['user']} for k, v in osm_stops.items()},
        'extra_stops': extra,
        'unpaired_relations': unpaired,
        'masters': [{'id': m['id'], 'tags': m['tags'], 'routes': [x['ref'] for x in m['members'] if x['type'] == 'relation']} for m in masters.values()],
        'summary': summary(feed, match, extra, patterns_out, unpaired),
    }
    os.makedirs(a.out, exist_ok=True)
    json.dump(out, open(os.path.join(a.out, 'review.json'), 'w'), separators=(',', ':'))
    s = out['summary']
    print(f"stops: {s['stops']}  patterns: {s['patterns']}  → {os.path.join(a.out, 'review.json')}", file=sys.stderr)


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


def write_relation_osm(path, feed, p, tr, match, osm_stops):
    """A PTv2 route relation for JOSM: platforms (existing OSM nodes where matched, new nodes otherwise)
    then the routed ways in order. Existing objects are referenced by id; JOSM fetches them when the
    page loads them first (remote control load_object), or on 'download incomplete members'."""
    tags = compare.proposed_relation_tags(feed, p, match)
    nid = -1
    nodes, members = [], []
    for sid in p.stops:
        s = feed.stops[sid]
        m = match.get(sid)
        if m and m['status'] == 'matched' and m['osm'] and m['osm'][0]['id'].startswith('n'):
            members.append(('node', int(m['osm'][0]['id'][1:]), 'platform'))
        else:
            t = stopmatch.proposed_tags(feed, s)
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
