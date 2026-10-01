"""What changed between two versions of an agency's feed: stops added, removed, moved, renamed, and routes'
itineraries added, removed or with different stops. Keeping a network current runs on this, not on reviewing
everything again.

Each build keeps a short summary of the feed it reviewed (cache/<agency>-feed-<version>.json); a build with a
new version compares against the last different one it kept.
"""
import json, math, os, re


def summary(feed):
    """The parts of a feed a mapper keeps OSM in step with: stops (name, code, where, which routes) and, per
    route, its itineraries as stop sequences."""
    routes = {}
    for p in feed.patterns:
        r = feed.routes.get(p.route_id)
        short = r.short if r else p.route_id
        routes.setdefault(short, []).append({'headsign': getattr(p, 'headsign', '') or '', 'stops': list(p.stops)})
    return {
        'version': feed.info.get('feed_version') or '', 'start': feed.info.get('feed_start_date') or '',
        'stops': {s.id: {'name': s.name, 'code': s.code, 'lat': round(s.lat, 6), 'lon': round(s.lon, 6),
                         'routes': sorted(feed.routes[r].short for r in s.routes if r in feed.routes)} for s in feed.stops.values() if s.location_type in ('0', '')},
        'routes': routes,
    }


def metres(a, b):
    return math.hypot((b['lat'] - a['lat']) * 110540, (b['lon'] - a['lon']) * 111320 * math.cos(math.radians(a['lat'])))


def diff(old, new, moved=15):
    """-> {since, stops_added, stops_removed, stops_moved, stops_renamed, routes_added, routes_removed, routes_changed}"""
    so, sn = old['stops'], new['stops']
    out = {'since': old.get('version'), 'since_start': old.get('start'),
           'stops_added': [{'id': k, **sn[k]} for k in sn if k not in so],
           'stops_removed': [{'id': k, **so[k]} for k in so if k not in sn],
           'stops_moved': [], 'stops_renamed': [], 'routes_added': [], 'routes_removed': [], 'routes_changed': []}
    for k in sn.keys() & so.keys():
        a, b = so[k], sn[k]
        d = metres(a, b)
        if d >= moved:
            out['stops_moved'].append({'id': k, 'name': b['name'], 'm': round(d)})
        if a['name'] != b['name']:
            out['stops_renamed'].append({'id': k, 'from': a['name'], 'to': b['name']})
    ro, rn = old['routes'], new['routes']
    out['routes_added'] = sorted(set(rn) - set(ro))
    out['routes_removed'] = sorted(set(ro) - set(rn))
    for r in sorted(set(rn) & set(ro)):
        a = {tuple(x['stops']) for x in ro[r]}
        b = {tuple(x['stops']) for x in rn[r]}
        if a == b:
            continue
        before, after = set().union(*a) if a else set(), set().union(*b) if b else set()
        out['routes_changed'].append({'route': r, 'stops_added': sorted(after - before, key=lambda k: (sn.get(k) or {}).get('name', k)),
                                      'stops_removed': sorted(before - after, key=lambda k: (so.get(k) or {}).get('name', k)),
                                      'itineraries': [len(a), len(b)]})
    return out


def track(feed, cache_dir, slug):
    """Keep this version's summary; -> the diff from the last different version kept, or None (the first one)."""
    os.makedirs(cache_dir, exist_ok=True)
    cur = summary(feed)
    tag = re.sub(r'[^\w.-]+', '-', cur['version'] or cur['start'] or 'unversioned')[:80]
    index_path = os.path.join(cache_dir, f'{slug}-feeds.json')
    index = json.load(open(index_path)) if os.path.exists(index_path) else []
    json.dump(cur, open(os.path.join(cache_dir, f'{slug}-feed-{tag}.json'), 'w'))
    if not index or index[-1] != tag:
        index = [t for t in index if t != tag] + [tag]
        json.dump(index, open(index_path, 'w'))
    prev = next((t for t in reversed(index[:-1]) if os.path.exists(os.path.join(cache_dir, f'{slug}-feed-{t}.json'))), None)
    if not prev:
        return None
    return diff(json.load(open(os.path.join(cache_dir, f'{slug}-feed-{prev}.json'))), cur)
