"""Which GTFS stop is which OpenStreetMap stop, and what differs between them.

Matching, in order of confidence:
  1. an id both sides carry: OSM gtfs:stop_id = stop_id, or OSM ref = stop_code (or stop_id)
  2. the nearest OSM stop within NEAR metres whose name or description resembles the GTFS stop's
  3. the nearest OSM stop within CLOSE metres, whatever it is called (a bare highway=bus_stop node)
Two candidates that both fit make an 'ambiguous' match: the reviewer decides.

Each GTFS stop ends up in one bucket:
  matched     one OSM stop, tags may still differ (the diff says how)
  ambiguous   several plausible OSM stops
  missing     nothing in OSM near enough
and OSM stops nobody claimed, inside the feed's footprint, are 'extra' (another operator's, moved, or gone).
"""
import math, re

NEAR = 60      # m: a stop across the street is ~20-30 m away, so beyond this the name has to carry it
CLOSE = 18     # m: this near, it is the same stop even with no name to go on
FOOTPRINT = 400  # m from any GTFS stop: an OSM stop further out is not this agency's business
REF_FAR = 300    # m: a matching ref further than this is a stale code, not the stop


def dist(lat1, lon1, lat2, lon2):
    return math.hypot((lat2 - lat1) * 110540, (lon2 - lon1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2)))


STOPWORDS = {'the', 'of', 'and', '&', 'at', 'st', 'street', 'ave', 'avenue', 'dr', 'drive', 'rd', 'road', 'hwy', 'highway',
             'north', 'south', 'east', 'west', 'n', 's', 'e', 'w', 'nb', 'sb', 'eb', 'wb', 'route', 'stop', 'bus', 'temp'}


def words(x):
    x = re.sub(r'\(.*?\)', ' ', x or '')
    return {w for w in re.sub(r"[^\w\s]", ' ', x.lower().replace("'", '')).split() if w not in STOPWORDS}


def numbers(x):
    return set(re.findall(r'\d+', x or ''))


def alike(a, b):
    """0..1: how much two stop names share, numbers counting double (a Utah grid address is all numbers)."""
    A, B = words(a), words(b)
    if not A or not B:
        return 0.0
    na, nb = numbers(a), numbers(b)
    w = len(A & B) / min(len(A), len(B))
    n = len(na & nb) / min(len(na), len(nb)) if na and nb else w
    return (w + n) / 2 if (na and nb) else w


def _gtfs_text(s):
    return ' '.join(x for x in (s.name, s.desc, s.tts) if x)


def _osm_text(o):
    t = o['tags']
    return ' '.join(x for x in (t.get('name'), t.get('description'), t.get('alt_name'), t.get('official_name')) if x)


def match(feed, osm_stops):
    """-> {gtfs_stop_id: result}, [extra osm stops]

    result: {status, osm: [candidate...], diff: {...}}  candidate = {id, dist, score, how}
    """
    osm = list(osm_stops.values())
    by_ref, by_gtfs_id = {}, {}
    for o in osm:
        t = o['tags']
        for k in ('gtfs:stop_id',):
            for v in (t.get(k) or '').split(';'):
                if v.strip():
                    by_gtfs_id.setdefault(v.strip(), []).append(o)
        for k in ('ref', 'gtfs:stop_code', 'stop_code'):
            for v in (t.get(k) or '').split(';'):
                if v.strip():
                    by_ref.setdefault(v.strip(), []).append(o)

    # A coarse grid so each GTFS stop only looks at its neighbours.
    cell = 0.002  # ~200 m
    grid = {}
    for o in osm:
        grid.setdefault((int(o['lat'] / cell), int(o['lon'] / cell)), []).append(o)

    def near(lat, lon, r):
        ci, cj = int(lat / cell), int(lon / cell)
        out = []
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for o in grid.get((i, j), []):
                    d = dist(lat, lon, o['lat'], o['lon'])
                    if d <= r:
                        out.append((d, o))
        return sorted(out, key=lambda x: x[0])

    results, claimed = {}, {}
    for s in feed.stops.values():
        if s.location_type not in ('0', ''):
            continue  # stations, entrances: not a platform to match
        cands, notes = [], []
        ids = by_gtfs_id.get(s.id, []) + by_ref.get(s.code, []) + (by_ref.get(s.id, []) if s.id != s.code else [])
        for o in ids:
            d = dist(s.lat, s.lon, o['lat'], o['lon'])
            if d <= REF_FAR:
                cands.append({'id': o['id'], 'dist': round(d), 'score': 1.0, 'how': 'ref'})
            else:  # the same ref far away: OSM's code is stale, or another agency's numbering
                notes.append(f"OSM {o['id']} carries ref {s.ref} but is {round(d)} m away")
        if not any(c['how'] == 'ref' for c in cands):
            for d, o in near(s.lat, s.lon, NEAR):
                sim = alike(_gtfs_text(s), _osm_text(o))
                if o['type'] != 'node' and o['tags'].get('amenity') == 'bus_station':
                    continue  # a station area is not the platform
                if d <= CLOSE or sim >= 0.5:
                    cands.append({'id': o['id'], 'dist': round(d), 'score': round(0.5 * (1 - d / NEAR) + 0.5 * sim, 3), 'how': 'close' if d <= CLOSE else 'name'})
        cands.sort(key=lambda c: -c['score'])
        seen, uniq = set(), []
        for c in cands:
            if c['id'] not in seen:
                seen.add(c['id']); uniq.append(c)
        cands = uniq
        if not cands:
            status = 'missing'
        elif len(cands) > 1 and cands[1]['score'] >= cands[0]['score'] - 0.12:
            status = 'ambiguous'
        else:
            status = 'matched'
        results[s.id] = {'status': status, 'osm': cands[:4], 'diff': None, 'notes': notes}
        if status == 'matched':
            claimed.setdefault(cands[0]['id'], []).append(s.id)
            results[s.id]['diff'] = diff(feed, s, osm_stops[cands[0]['id']])

    # An OSM stop claimed twice is really ambiguous for both.
    for oid, sids in claimed.items():
        if len(sids) > 1:
            for sid in sids:
                results[sid]['status'] = 'ambiguous'
                results[sid]['shared_with'] = [x for x in sids if x != sid]

    used = {c['id'] for r in results.values() for c in r['osm'][:1] if r['status'] == 'matched'}
    extra = []
    gt = [(s.lat, s.lon) for s in feed.stops.values()]
    ggrid = {}
    for lat, lon in gt:
        ggrid.setdefault((int(lat / 0.004), int(lon / 0.004)), []).append((lat, lon))
    for o in osm:
        if o['id'] in used or o['tags'].get('public_transport') == 'stop_position':
            continue
        ci, cj = int(o['lat'] / 0.004), int(o['lon'] / 0.004)
        close = any(dist(o['lat'], o['lon'], la, lo) <= FOOTPRINT for i in (ci - 1, ci, ci + 1) for j in (cj - 1, cj, cj + 1) for la, lo in ggrid.get((i, j), []))
        if close:
            extra.append(o['id'])
    return results, extra


def proposed_tags(feed, s):
    """The tags a fresh platform node for this GTFS stop would carry (the GTFS tagging scheme, 2024)."""
    agency = feed.agency.get('agency_name', '')
    t = {'highway': 'bus_stop', 'public_transport': 'platform', 'bus': 'yes',
         'name': s.name, 'ref': s.ref, 'gtfs:stop_id': s.id}
    if s.code:
        t['gtfs:stop_code'] = s.code
    if agency:
        t['operator'] = agency
    routes = sorted({feed.routes[r].short for r in s.routes if r in feed.routes}, key=lambda x: (len(x), x))
    if routes:
        t['route_ref'] = ';'.join(routes)
    if s.wheelchair == '1':
        t['wheelchair'] = 'yes'
    elif s.wheelchair == '2':
        t['wheelchair'] = 'no'
    if s.desc:
        t['description'] = s.desc
    return t


def diff(feed, s, o):
    """What a reviewer would want to look at, GTFS side by OSM side. Only real differences."""
    t = o['tags']
    out = {}
    if (t.get('name') or '') != s.name:
        out['name'] = {'gtfs': s.name, 'osm': t.get('name', '')}
    if t.get('ref', '') != s.ref:
        out['ref'] = {'gtfs': s.ref, 'osm': t.get('ref', '')}
    if not t.get('gtfs:stop_id'):
        out['gtfs:stop_id'] = {'gtfs': s.id, 'osm': ''}
    want = ';'.join(sorted({feed.routes[r].short for r in s.routes if r in feed.routes}, key=lambda x: (len(x), x)))
    have = ';'.join(sorted((t.get('route_ref') or '').split(';'), key=lambda x: (len(x), x))) if t.get('route_ref') else ''
    if want != have:
        out['route_ref'] = {'gtfs': want, 'osm': t.get('route_ref', '')}
    w = {'1': 'yes', '2': 'no'}.get(s.wheelchair)
    if w and t.get('wheelchair') != w:
        out['wheelchair'] = {'gtfs': w, 'osm': t.get('wheelchair', '')}
    if s.desc and (t.get('description') or '') != s.desc:
        out['description'] = {'gtfs': s.desc, 'osm': t.get('description', '')}
    if t.get('highway') != 'bus_stop' or t.get('public_transport') != 'platform':
        out['tagging'] = {'gtfs': 'highway=bus_stop + public_transport=platform', 'osm': ' '.join(f'{k}={t[k]}' for k in ('highway', 'public_transport', 'bus', 'amenity') if k in t)}
    return out
