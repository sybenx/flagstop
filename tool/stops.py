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
from collections import Counter

NEAR = 60      # m: a stop across the street is ~20-30 m away, so beyond this the name has to carry it
CLOSE = 40     # m: this near and nobody else's, it is the same stop even with no name to go on
FOOTPRINT = 400  # m from any GTFS stop: an OSM stop further out is not this agency's business
REF_FAR = 300    # m: a matching ref further than this is a stale code, not the stop
MOVED = 300      # m: nothing near, but a stop of the same name/ref this far away has probably moved
FAR = 25         # m: closer than this, GTFS and OSM positions are the same stop placed by two hands; set from
                 # the feed by calibrate(), since how exact an agency's points are varies
TYPICAL = None   # m: how far apart the agency's and OSM's points usually are, for this feed


def calibrate(results):
    """Set FAR from the feed: three times the usual (median) distance between a stop and the OSM stop it
    matched by code or id, at least 10 m. An agency whose points sit on the sign gets a tight FAR; one whose
    points are rough gets room. -> (typical, FAR)"""
    global FAR, TYPICAL
    ds = sorted(r['osm'][0]['dist'] for r in results.values() if r and r['status'] == 'matched' and r['osm'] and r['osm'][0]['how'] == 'ref')
    if len(ds) >= 20:
        TYPICAL = ds[len(ds) // 2]
        FAR = max(10, 3 * TYPICAL)
    return TYPICAL, FAR
def rings(lat, r, cell):
    """How many grid cells of `cell` degrees out a search of r metres at this latitude has to look: (north-south,
    east-west)."""
    return math.ceil(r / (cell * 110540)), math.ceil(r / (cell * 111320 * max(0.05, math.cos(math.radians(lat)))))


TEMP = re.compile(r'\b(temp(orary)?|detour|closed)\b', re.I)


def dist(lat1, lon1, lat2, lon2):
    return math.hypot((lat2 - lat1) * 110540, (lon2 - lon1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2)))


STOPWORDS = {'the', 'of', 'and', '&', 'at', 'st', 'street', 'ave', 'avenue', 'dr', 'drive', 'rd', 'road', 'hwy', 'highway',
             'north', 'south', 'east', 'west', 'n', 's', 'e', 'w', 'nb', 'sb', 'eb', 'wb', 'route', 'stop', 'bus', 'temp'}


def words(x):
    x = re.sub(r'\(.*?\)', ' ', x or '')
    return {w for w in re.sub(r"[^\w\s]", ' ', x.lower().replace("'", '')).split() if w not in STOPWORDS}


def numbers(x):
    return set(re.findall(r'\d+', x or ''))


def street(x):
    """'649 North 200 West' -> 'north 200 west'; '781 S Main, Smithfield' -> 's main'. The address without its number."""
    x = re.sub(r'\(.*?\)', ' ', x or '').split(',')[0].split(' - ')[0]
    x = re.sub(r"[^\w\s]", ' ', x.lower()).strip()
    x = re.sub(r'^\d+\s+', '', x)
    x = re.sub(r'\b(street|st|avenue|ave|drive|dr|road|rd|lane|ln|highway|hwy)\b', '', x)
    x = re.sub(r'\b(north|n)\b', 'n', x); x = re.sub(r'\b(south|s)\b', 's', x); x = re.sub(r'\b(east|e)\b', 'e', x); x = re.sub(r'\b(west|w)\b', 'w', x)
    return ' '.join(x.split())


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


def is_platform(o):
    """A platform, where people wait: highway=bus_stop or public_transport=platform (not a stop position or station)."""
    t = o['tags']
    return t.get('highway') == 'bus_stop' or t.get('public_transport') == 'platform'


def match(feed, osm_stops, across=None):
    """-> {gtfs_stop_id: result}, [extra osm stops]

    result: {status, osm: [candidate...], diff: {...}}  candidate = {id, dist, score, how}
    across(stop_id, osm_stop): True when the OSM stop is across the street from where the buses pull in. Then
    it's the other direction's stop: never a candidate, whatever its name or code says.
    """
    across = across or (lambda sid, o: False)
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
        # as many cells out as r needs: a cell is ~220 m north-south, and less east-west the further from the
        # equator (166 m at 42°): one ring of neighbours misses stops due east or west
        ni, nj = rings(lat, r, cell)
        for i in range(ci - ni, ci + ni + 1):
            for j in range(cj - nj, cj + nj + 1):
                for o in grid.get((i, j), []):
                    d = dist(lat, lon, o['lat'], o['lon'])
                    if d <= r:
                        out.append((d, o))
        return sorted(out, key=lambda x: x[0])

    # A stop is matched to its platform, where people wait: not the stop_position on the road (where the bus
    # halts) or a station (the whole place). Those stay in the data for the relations, not as candidates.
    def platform(o):
        t = o['tags']
        return t.get('highway') == 'bus_stop' or t.get('public_transport') == 'platform'

    # The agency's networks as OSM names them (often several: CVTD, its new brand, a shared shuttle's): every
    # network on a platform that already carries one of the feed's codes or ids. A platform tagged with another network (an intercity coach's stop in the same
    # transit centre) is probably someone else's stop: it ranks below the agency's own nearby. Not ruled out:
    # network tags are messy (CVTD, Cache Valley Transit District, a stop shared with a university shuttle).
    nets = Counter(o['tags'].get('network') for s in feed.stops.values()
                   for o in by_gtfs_id.get(s.id, []) + by_ref.get(s.code, []) if platform(o) and o['tags'].get('network'))
    def other_network(o):
        return bool(nets) and o['tags'].get('network') and o['tags']['network'] not in nets

    codes = {s.code for s in feed.stops.values() if s.code}
    results, claimed = {}, {}
    for s in feed.stops.values():
        if s.location_type not in ('0', ''):
            continue  # stations, entrances: not a platform to match
        if getattr(s, 'other_modes', False) and not s.routes:
            continue  # a tram's or a train's platform: not a bus stop
        cands, notes = [], []
        # OSM's ref is the stop code; a stop_id in it counts too (some mappers put that there), unless the id is
        # also another stop's code, when the ref is that stop's
        ids = by_gtfs_id.get(s.id, []) + by_ref.get(s.code, []) + (by_ref.get(s.id, []) if s.id != s.code and s.id not in codes else [])
        for o in filter(platform, ids):
            d = dist(s.lat, s.lon, o['lat'], o['lon'])
            if across(s.id, o):
                notes.append(f"OSM {o['id']} carries code {s.ref or s.id} but is across the street, where the other direction's buses stop: its code may be wrong")
                continue
            if d <= REF_FAR:
                cands.append({'id': o['id'], 'dist': round(d), 'score': 1.0, 'how': 'ref'})
            else:  # the same ref far away: OSM's code is stale, or another agency's numbering
                notes.append(f"OSM {o['id']} carries ref {s.ref or s.id} but is {round(d)} m away")
        if not any(c['how'] == 'ref' for c in cands):
            for d, o in near(s.lat, s.lon, NEAR):
                sim = alike(_gtfs_text(s), _osm_text(o))
                if not platform(o) or across(s.id, o):
                    continue
                if d <= CLOSE or sim >= 0.5:
                    cands.append({'id': o['id'], 'dist': round(d), 'score': round(0.5 * (1 - d / NEAR) + 0.5 * sim - (0.2 if other_network(o) else 0), 3), 'how': 'close' if d <= CLOSE else 'name'})
        cands.sort(key=lambda c: -c['score'])
        seen, uniq = set(), []
        for c in cands:
            if c['id'] not in seen:
                seen.add(c['id']); uniq.append(c)
        cands = uniq
        if not cands:
            status = 'missing'
        elif cands[0]['how'] == 'moved':
            status = 'moved'
        elif len(cands) > 1 and cands[1]['score'] >= cands[0]['score'] - 0.12:
            status = 'ambiguous'
        else:
            status = 'matched'
        results[s.id] = {'status': status, 'osm': cands[:4], 'diff': None, 'notes': notes, 'temporary': bool(TEMP.search(s.name) or TEMP.search(s.desc))}
        if status == 'matched':
            claimed.setdefault(cands[0]['id'], []).append(s.id)
            results[s.id]['diff'] = diff(feed, s, osm_stops[cands[0]['id']])

    # Second pass: a stop with nothing near it, but an unclaimed OSM stop on the same street within MOVED
    # metres (or with its ref), has probably been moved along the street.
    for s in feed.stops.values():
        r = results.get(s.id)
        if not r or r['status'] != 'missing':
            continue
        cands = []
        for d, o in near(s.lat, s.lon, MOVED):
            if o['id'] in claimed or o['type'] != 'node' or not platform(o) or across(s.id, o):
                continue
            t = o['tags']
            byref = (bool(s.ref) and t.get('ref') == s.ref) or s.id in [v.strip() for v in (t.get('gtfs:stop_id') or '').split(';')]
            sim = alike(_gtfs_text(s), _osm_text(o))
            same_street = street(s.name) and street(s.name) == street(t.get('name', ''))
            if byref or sim >= 0.5 or same_street:
                cands.append({'id': o['id'], 'dist': round(d), 'score': round(0.4 * sim + (0.5 if byref else 0) + (0.3 if same_street else 0) - d / 2000, 3), 'how': 'moved'})
        if cands:
            cands.sort(key=lambda c: -c['score'])
            r['status'] = 'moved'; r['osm'] = cands[:3]
            r['diff'] = diff(feed, s, osm_stops[cands[0]['id']])

    # Two stops made one: nothing at the agency's spot, and OSM has two stops nobody else claims on the same
    # street and side, one either side of it. The nearer is the one to move here (it keeps its history and
    # takes the agency's name and codes); the other goes.
    taken = {r['osm'][0]['id'] for r in results.values() if r and r['status'] == 'matched' and r['osm']}
    for s in feed.stops.values():
        r = results.get(s.id)
        if not r or r['status'] != 'moved' or not r['osm'] or not street(s.name):
            continue
        a = osm_stops[r['osm'][0]['id']]
        k = math.cos(math.radians(s.lat))
        vec = lambda o: ((o['lon'] - s.lon) * 111320 * k, (o['lat'] - s.lat) * 110540)
        best = None
        for d, o in near(s.lat, s.lon, MOVED):
            if o['id'] in taken or o['id'] == a['id'] or not platform(o) or across(s.id, o) or street(o['tags'].get('name', '')) != street(s.name):
                continue
            (ax, ay), (ox, oy) = vec(a), vec(o)
            if ax * ox + ay * oy < 0 and (best is None or d < best[0]):   # the other side of the agency's point
                best = (d, o)
        if not best:
            continue
        da = dist(s.lat, s.lon, a['lat'], a['lon'])
        if best[0] < da:   # move the nearer
            r['osm'] = [{'id': best[1]['id'], 'dist': round(best[0]), 'score': r['osm'][0]['score'], 'how': 'moved'}] + r['osm']
            r['merged_with'] = {'id': a['id'], 'dist': round(da)}
        else:
            r['merged_with'] = {'id': best[1]['id'], 'dist': round(best[0])}
        r['diff'] = diff(feed, s, osm_stops[r['osm'][0]['id']])

    # An OSM stop claimed twice is really ambiguous for both.
    for oid, sids in claimed.items():
        if len(sids) > 1:
            for sid in sids:
                results[sid]['status'] = 'ambiguous'
                results[sid]['shared_with'] = [x for x in sids if x != sid]

    # OSM stops the feed's stops claim, so not 'OSM only' (offered for removal on the page): the one a stop matched,
    # the one it moved from, and every one an ambiguous stop could be (a second candidate of a matched stop may
    # well be a pole no route uses any more; one an unanswered question could pick is not)
    used = {c['id'] for r in results.values() for c in (r['osm'][:1] if r['status'] in ('matched', 'moved') else r['osm'] if r['status'] == 'ambiguous' else [])}
    extra = []
    gt = [(s.lat, s.lon) for s in feed.stops.values()]
    ggrid = {}
    for lat, lon in gt:
        ggrid.setdefault((int(lat / 0.004), int(lon / 0.004)), []).append((lat, lon))
    for o in osm:
        if o['id'] in used or not platform(o):
            continue
        ci, cj = int(o['lat'] / 0.004), int(o['lon'] / 0.004)
        ni, nj = rings(o['lat'], FOOTPRINT, 0.004)
        close = any(dist(o['lat'], o['lon'], la, lo) <= FOOTPRINT for i in range(ci - ni, ci + ni + 1) for j in range(cj - nj, cj + nj + 1) for la, lo in ggrid.get((i, j), []))
        if close:
            extra.append(o['id'])
    return results, extra


def conventions(feed, results, osm_stops):
    """What the local mappers already write for operator/network on this agency's stops: the value most
    of the matched stops carry, if a clear majority does. Proposals follow the mappers, not the feed."""
    from collections import Counter, Counter
    out = {}
    matched = [osm_stops[r['osm'][0]['id']] for r in results.values() if r['status'] == 'matched' and r['osm']]
    for k in ('operator', 'network', 'network:wikidata', 'operator:wikidata'):
        c = Counter(o['tags'][k] for o in matched if o['tags'].get(k))
        if c:
            v, n = c.most_common(1)[0]
            if n >= 0.4 * len(matched) and n >= 5:
                out[k] = v
    return out


def network_diff(feed, o, conv, aliases=()):
    """network, operator and their Wikidata items against what this agency's stops in OSM carry (conv), so
    the agency's stops say the same thing. An old name of the agency (one the feed's agency_name contains, or
    one iD's name-suggestion-index lists for the network) is swapped for the current one. Anything else is
    another operator or network whose buses stop here too (a shared pole, both signs on it: a university
    shuttle, a coach line): the suggestion lists both, theirs first (a;b). The one exception: a network value
    that is one of this agency's own route numbers is a route name in the wrong tag, and is replaced."""
    t, out = o['tags'], {}
    agency = feed.agency.get('agency_name', '').lower()
    shorts = {(r.short or '').lower() for r in getattr(feed, 'routes', {}).values()} - {''}
    for k in ('network', 'operator'):
        cur = conv.get(k)
        if not cur:
            continue
        known = aliases if cur == conv.get('network') else ()
        parts = [x.strip() for x in (t.get(k) or '').split(';') if x.strip()]
        # an old or shortened name: listed as one, inside the feed's agency name, or all its words in the current name
        old = lambda x: x.lower() in known or (len(x) > 2 and x.lower() in agency) or set(x.lower().split()) <= set(cur.lower().split())
        new = list(dict.fromkeys(cur if old(x) else x for x in parts)) or [cur]
        if cur not in new:   # something else only: theirs, then ours (a route number of ours in network: ours instead)
            new = [cur] if k == 'network' and all(x.lower() in shorts for x in parts) else parts + [cur]
        if ';'.join(new) != (t.get(k) or ''):
            out[k] = {'gtfs': ';'.join(new), 'osm': t.get(k, ''),
                      'old': [x for x in parts if old(x)], 'other': [x for x in parts if not old(x) and x != cur]}
    wd = conv.get('network:wikidata')
    if wd and t.get('network:wikidata') != wd and wd not in (t.get('network:wikidata') or '').split(';'):
        out['network:wikidata'] = {'gtfs': wd, 'osm': t.get('network:wikidata', '')}
    return out


def keep_foreign_routes(feed, o, diff):
    """On a shared stop (another network or operator listed in OSM), the other network's route numbers in
    route_ref stay beside this agency's: a number none of this agency's routes has is theirs."""
    rr = diff.get('route_ref')
    if not rr or not any(diff.get(k, {}).get('other') for k in ('network', 'operator')):
        return diff
    shorts = {(r.short or '').lower() for r in getattr(feed, 'routes', {}).values()}
    theirs = [x.strip() for x in (o['tags'].get('route_ref') or '').split(';') if x.strip() and x.strip().lower() not in shorts]
    ours = [x for x in rr['gtfs'].split(';') if x]
    want = ';'.join(sorted(dict.fromkeys(theirs + ours), key=lambda x: (len(x), x)))
    if want == (o['tags'].get('route_ref') or ''):
        diff.pop('route_ref', None)
    else:
        rr['gtfs'] = want
    return diff


def owner(feed, o, conv, aliases=()):
    """Whose stop an OSM stop is, by its network and operator: 'agency' (this agency's current name, or an old
    or short one, as network_diff knows them), 'other' (someone else's: a university shuttle, a coach line),
    or None (it says nothing)."""
    vals = [x.strip() for k in ('network', 'operator') for x in (o['tags'].get(k) or '').split(';') if x.strip()]
    if not vals:
        return None
    agency = feed.agency.get('agency_name', '').lower()
    for cur in {conv.get('network'), conv.get('operator')} - {None}:
        for x in vals:
            if x == cur or x.lower() in aliases or (len(x) > 2 and x.lower() in agency) or set(x.lower().split()) <= set(cur.lower().split()):
                return 'agency'
    return 'other'


def proposed_tags(feed, s, conv=None):
    """The tags a fresh platform node for this GTFS stop would carry (the GTFS tagging scheme, 2024)."""
    conv = conv or {}
    agency = feed.agency.get('agency_name', '')
    t = {'highway': 'bus_stop', 'public_transport': 'platform', 'bus': 'yes',
         'name': spelled(s.name, lang_of(feed)), 'gtfs:stop_id': s.id}
    if s.ref:
        t['ref'] = s.ref   # the code on the sign; a feed without codes has none to give (its stop_id is a key)
    if s.code:
        t['gtfs:stop_code'] = s.code
    for k in ('operator', 'network', 'network:wikidata', 'operator:wikidata'):
        if conv.get(k):
            t[k] = conv[k]
    # in a feed of several agencies, the one whose buses call here (if it's one)
    names = {feed.agency_name(r) for r in s.routes} if hasattr(feed, 'agency_name') and s.routes else set()
    agency = names.pop() if len(names) == 1 else agency
    if 'operator' not in t and agency:
        t['operator'] = agency
    routes = sorted({feed.routes[r].short for r in s.routes if r in feed.routes} - {''}, key=lambda x: (len(x), x))
    if routes:
        t['route_ref'] = ';'.join(routes)
    # An agency's 'not accessible' (2) isn't trusted: it's too often wrong (a default, an old survey). Only
    # 'yes' is taken from the feed.
    if s.wheelchair == '1':
        t['wheelchair'] = 'yes'
    if s.desc:
        t['description'] = s.desc
    return t


def diff(feed, s, o):
    """What a reviewer would want to look at, GTFS side by OSM side. Only real differences."""
    t = o['tags']
    out = {}
    name = spelled(s.name, lang_of(feed))   # the agency's address, written the OSM way
    # (a feed in capitals says nothing about case: OSM's name that differs from it only there is no difference)
    if (t.get('name') or '') != name and not (shouting(s.name) and (t.get('name') or '').lower() == name.lower()):
        out['name'] = {'gtfs': name, 'osm': t.get('name', '')}
    if s.ref and t.get('ref', '') != s.ref:   # no code in the feed: OSM's ref is left as it is
        out['ref'] = {'gtfs': s.ref, 'osm': t.get('ref', '')}
    if not t.get('gtfs:stop_id'):
        out['gtfs:stop_id'] = {'gtfs': s.id, 'osm': ''}
    want = ';'.join(sorted({feed.routes[r].short for r in s.routes if r in feed.routes} - {''}, key=lambda x: (len(x), x)))
    have = ';'.join(sorted((t.get('route_ref') or '').split(';'), key=lambda x: (len(x), x))) if t.get('route_ref') else ''
    if want != have:
        out['route_ref'] = {'gtfs': want, 'osm': t.get('route_ref', '')}
    w = {'1': 'yes'}.get(s.wheelchair)   # never 'no' from the feed: see proposed_tags
    if w and t.get('wheelchair') != w:
        out['wheelchair'] = {'gtfs': w, 'osm': t.get('wheelchair', '')}
    if s.desc and (t.get('description') or '') != s.desc:
        out['description'] = {'gtfs': s.desc, 'osm': t.get('description', '')}
    d = dist(s.lat, s.lon, o['lat'], o['lon'])
    if d > FAR:
        out['position'] = {'gtfs': f'{round(d)} m {bearing(o["lat"], o["lon"], s.lat, s.lon)} of the OSM node', 'osm': 'kept'}
    if t.get('highway') != 'bus_stop' or t.get('public_transport') != 'platform':
        out['tagging'] = {'gtfs': 'highway=bus_stop + public_transport=platform', 'osm': ' '.join(f'{k}={t[k]}' for k in ('highway', 'public_transport', 'bus', 'amenity') if k in t)}
    return out


def bearing(lat1, lon1, lat2, lon2):
    """Compass word from point 1 to point 2."""
    dy = (lat2 - lat1) * 110540
    dx = (lon2 - lon1) * 111320 * math.cos(math.radians(lat1))
    a = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][int((a + 22.5) // 45) % 8]


# ---------- what to do about each difference, and why: the reviewer checks these, flagstop doesn't apply them ----------
ABBR = {'st': 'street', 'ave': 'avenue', 'av': 'avenue', 'dr': 'drive', 'rd': 'road', 'hwy': 'highway', 'ln': 'lane', 'blvd': 'boulevard',
        'pkwy': 'parkway', 'ctr': 'center', 'cir': 'circle', 'ct': 'court', 'pl': 'place', 'n': 'north', 's': 'south', 'e': 'east', 'w': 'west'}


DIRECTIONS = {'n': 'North', 's': 'South', 'e': 'East', 'w': 'West'}
ALWAYS = {'hwy': 'Highway', 'pkwy': 'Parkway', 'blvd': 'Boulevard'}
AT_END = {'st': 'Street', 'dr': 'Drive', 'ave': 'Avenue', 'av': 'Avenue', 'rd': 'Road', 'ln': 'Lane', 'cir': 'Circle', 'ct': 'Court', 'pl': 'Place', 'ctr': 'Center'}


def shouting(name):
    """A name all in capitals ('MAIN ST & 1ST AVE'), as some feeds write every name: it says nothing about case."""
    letters = [c for c in name or '' if c.isalpha()]
    return len(letters) >= 4 and all(c.isupper() for c in letters)


def calm(name):
    """A name in capitals, in ordinary case: each word capitalised ('1ST' -> '1st', "MCDONALD'S" -> "Mcdonald's"); a
    lone letter stays as it is (N, Building E). An acronym can't be told from a word ('USU' -> 'Usu'): where OSM
    has the name already, differing only in case, OSM's stays."""
    return re.sub(r"\d*[A-Za-z]+(?:'[A-Za-z]+)?", lambda m: m.group(0) if len(m.group(0)) == 1 else m.group(0).lower() if m.group(0)[0].isdigit() else m.group(0).capitalize(), name)


def spelled(name, lang='en'):
    """A stop name with its abbreviations spelled out, as OSM writes names: '2470 N Main St, N Logan' ->
    '2470 North Main Street, North Logan'. English only (the list is). Careful with the ambiguous ones: a
    lone letter is a direction only next to a number or before a place name ('1600 N', 'N Logan', not
    'Building E'); St, Dr and the like only at the end of the street ('Main St,', not 'St Thomas')."""
    if not name:
        return name
    if shouting(name):
        name = calm(name)
    if not (lang or 'en').lower().startswith('en'):
        return name
    toks = re.findall(r"[A-Za-z]+\.?|\d+\w*|[^\w\s]+|\s+", name)
    words = [i for i, t in enumerate(toks) if not t.isspace()]
    out = list(toks)
    for n, i in enumerate(words):
        t = toks[i]
        if not t[0].isalpha():
            continue
        w = t.rstrip('.').lower()
        prev = toks[words[n - 1]] if n else None
        nxt = toks[words[n + 1]] if n + 1 < len(words) else None
        end = nxt is None or nxt[0] in ',-(/;&@'   # the street's name ends there ('Main St & 1st Ave')
        num = lambda x: bool(x) and x[0].isdigit()
        if w in DIRECTIONS and len(t.rstrip('.')) == 1 and t[0].isupper() and (num(prev) or num(nxt) or (nxt and nxt[0].isupper())):
            out[i] = DIRECTIONS[w]
        elif w in ALWAYS:
            out[i] = ALWAYS[w]
        elif w in AT_END and (end or (w not in ('st', 'dr') and num(nxt))):
            out[i] = AT_END[w]
    return re.sub(r'\s+([,)])', r'\1', re.sub(r'\s{2,}', ' ', ''.join(out))).strip()


def lang_of(feed):
    return feed.agency.get('agency_lang') or getattr(feed, 'info', {}).get('feed_lang', '') or ''


# a stop_desc with a date or a time in it is someone's note ("(Detour) added 10/13/2025 11:58:27"), not what the bus announces
NOTE = re.compile(r'\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(:\d{2})?\b|\badded\b', re.I)
SUFFIX = {'street', 'avenue', 'drive', 'road', 'lane', 'boulevard', 'parkway', 'circle', 'court', 'place'}


def address(x):
    """A stop name reduced to its address: abbreviations spelled out, the street type dropped ('Main' and
    'Main Street' are one road), and what follows the address dropped — a landmark in brackets or after a
    dash, a town after a comma ('2470 North Main St, N Logan')."""
    x = re.sub(r'\(.*?\)', ' ', x or '')
    x = re.split(r'\s+-\s+|,', x)[0]
    return ' '.join(w for w in (ABBR.get(w, w) for w in re.sub(r"[^\w\s]", ' ', x.lower()).split()) if w not in SUFFIX)


def extra(x):
    """What a name says beyond its address: '(Blue Square)', ' - Zootah - TIMEPOINT'."""
    m = re.search(r'\((.*?)\)', x or '') or re.search(r'\s+-\s+(.*)$', x or '')
    return m.group(1).strip() if m else ''


def same_address(a, b):
    a, b = address(a), address(b)
    return a.replace(' ', '') == b.replace(' ', '') or sorted(a.split()) == sorted(b.split())


def decide(s, o, diff, side=None, others=None):
    """For each difference: {'pick': 'agency' | 'keep' | 'ask', 'why': ...}.
    'agency' and 'keep' are suggestions the reviewer sees and can flip; 'ask' has no default.
    side: {'osm': 'right'|'left'|None, 'gtfs': ...} — where each point is relative to the buses' direction.
    others: {address: (stop_id, name)} of every stop in the feed, to notice a name that belongs to another stop."""
    t, out = o['tags'], {}
    d = dist(s.lat, s.lon, o['lat'], o['lon'])
    for k, v in (diff or {}).items():
        if k in ('ref', 'gtfs:stop_id', 'route_ref'):
            out[k] = {'pick': 'agency', 'why': {'ref': "the agency's stop code", 'gtfs:stop_id': "the agency's id for the stop",
                                                 'route_ref': 'which routes call here, per the timetable'}[k]}
        elif k == 'network':
            if not v['osm']:
                out[k] = {'pick': 'agency', 'why': "what this agency's other stops in OSM carry; OSM has none"}
            elif v['other'] and v['osm'] in v['gtfs']:
                out[k] = {'pick': 'agency', 'why': f"OSM says '{v['osm']}': another network's buses stop here too (a shared pole, both signs on it). Both, theirs first"}
            elif v['other']:
                out[k] = {'pick': 'ask', 'why': f"OSM says '{v['osm']}', one of this agency's route numbers: a route name in the wrong tag? Then it's '{v['gtfs']}'; if it's a network of its own, both ('{v['osm']};{v['gtfs']}'): edit that by hand"}
            else:
                out[k] = {'pick': 'agency', 'why': f"'{v['osm']}' is the old name: this agency's other stops in OSM, and iD's name suggestions, say '{v['gtfs']}'"}
        elif k == 'operator':
            if not v['osm']:
                out[k] = {'pick': 'agency', 'why': "what this agency's other stops and routes in OSM carry; OSM has none"}
            elif v['other'] and o.get('served_by'):
                out[k] = {'pick': 'agency', 'why': f"{', '.join(o['served_by'])}'s own feed has a stop here too: both"}
            elif v['other']:
                out[k] = {'pick': 'agency', 'why': f"OSM says '{v['osm']}': another operator's buses stop here too (a shared pole; whose it is, nobody can tell from here). Both, theirs first; if theirs don't stop here any more, make it '{v['gtfs'].split(';')[-1]}' alone"}
            else:
                out[k] = {'pick': 'agency', 'why': f"'{v['osm']}' is the agency's old name: its other stops and routes in OSM say '{v['gtfs']}'"}
        elif k == 'network:wikidata':
            out[k] = {'pick': 'agency' if not v['osm'] else 'ask', 'why': "the network's Wikidata item, as its other stops have it" + (f"; OSM says {v['osm']}" if v['osm'] else '')}
        elif k == 'tagging':
            out[k] = {'pick': 'agency', 'why': 'public transport tagging (PTv2) is incomplete'}
        elif k == 'description' and NOTE.search(v['gtfs']):
            out[k] = {'pick': 'ask', 'why': f"the agency's text looks like an internal note, not an announcement: \"{v['gtfs']}\""}
        elif k in ('description', 'wheelchair'):
            if v['osm']:
                out[k] = {'pick': 'ask', 'why': f"OSM says something else: {v['osm']}"}
            else:
                out[k] = {'pick': 'agency', 'why': "what the bus announces here; OSM has none" if k == 'description' else 'OSM has none'}
        elif k == 'name':
            g, m = v['gtfs'], v['osm']
            if not m:
                out[k] = {'pick': 'agency', 'why': 'OSM has no name'}
            # The agency's name is its address for the stop, and it's right; written the OSM way (spelled out:
            # Street, not St), which g already is. A landmark or note added to OSM's name goes; the agency's
            # announcement goes in description.
            elif same_address(g, m) and not extra(m):
                out[k] = {'pick': 'agency', 'why': "the same address, as the agency writes it, spelled out the OSM way"}
            elif same_address(g, m):
                out[k] = {'pick': 'agency', 'why': f"same address; OSM's name adds '{extra(m)}', which isn't part of a name" + (f" (the agency announces '{s.desc}', which goes in description)" if s.desc else '')}
            elif set(re.sub(r"[^\w\s]", ' ', m.lower()).split()) <= set(re.sub(r"[^\w\s]", ' ', g.lower()).split()) | {'and'}:
                out[k] = {'pick': 'agency', 'why': "OSM's name is only part of the agency's (the bay, without the address)"}
            elif others and address(m) in others and others[address(m)][0] != s.id:
                sid, nm = others[address(m)]
                out[k] = {'pick': 'ask', 'why': f"OSM's name is the agency's name for another stop ({nm}, code {sid}): swapped?"}
            elif street(address(g)) == street(address(m)) and numbers(address(g)) != numbers(address(m)):
                hn = lambda x: re.match(r'\d+', address(x)).group(0) if re.match(r'\d+', address(x)) else '?'
                if d <= FAR:
                    lost = f"; OSM's '{extra(m)}' goes" + (f" (the agency announces '{s.desc}')" if s.desc else '') if extra(m) else ''
                    out[k] = {'pick': 'agency', 'why': f"same spot ({round(d)} m), so not a move: the agency's current name ({hn(m)} → {hn(g)}){lost}"}
                else:
                    out[k] = {'pick': 'ask', 'why': f"OSM's address says {hn(m)}, the agency's says {hn(g)}, and they're {round(d)} m apart: has the stop moved?"}
            else:
                out[k] = {'pick': 'agency', 'why': f"the agency's address for it; OSM's '{m}' names another street (often the same road by another name)"}
    # position: within FAR it's the same stop placed by two hands, unless OSM has it across the street
    wrong = side and side.get('osm') == 'left' and side.get('gtfs') == 'right'
    if wrong:
        out['position'] = {'pick': 'ask', 'why': f"OSM has it across the street from where buses going this way stop; the agency's point is on their side ({round(d)} m)"}
    elif d > FAR:
        out['position'] = {'pick': 'ask', 'why': f"{round(d)} m apart" + (f": the agency's points are usually within {TYPICAL} m of OSM's" if TYPICAL else '')}
    elif d >= 2:
        out['position'] = {'pick': 'keep', 'why': f'{round(d)} m apart: the same spot, placed by two hands'}
    return out
