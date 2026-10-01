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
FAR = 25         # m: closer than this, GTFS and OSM positions are the same stop placed by two hands
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

    results, claimed = {}, {}
    for s in feed.stops.values():
        if s.location_type not in ('0', ''):
            continue  # stations, entrances: not a platform to match
        cands, notes = [], []
        ids = by_gtfs_id.get(s.id, []) + by_ref.get(s.code, []) + (by_ref.get(s.id, []) if s.id != s.code else [])
        for o in filter(platform, ids):
            d = dist(s.lat, s.lon, o['lat'], o['lon'])
            if d <= REF_FAR:
                cands.append({'id': o['id'], 'dist': round(d), 'score': 1.0, 'how': 'ref'})
            else:  # the same ref far away: OSM's code is stale, or another agency's numbering
                notes.append(f"OSM {o['id']} carries ref {s.ref} but is {round(d)} m away")
        if not any(c['how'] == 'ref' for c in cands):
            for d, o in near(s.lat, s.lon, NEAR):
                sim = alike(_gtfs_text(s), _osm_text(o))
                if not platform(o):
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
            if o['id'] in claimed or o['type'] != 'node':
                continue
            t = o['tags']
            byref = bool(s.ref) and (t.get('ref') == s.ref or s.id in (t.get('gtfs:stop_id') or ''))
            sim = alike(_gtfs_text(s), _osm_text(o))
            same_street = street(s.name) and street(s.name) == street(t.get('name', ''))
            if byref or sim >= 0.5 or same_street:
                cands.append({'id': o['id'], 'dist': round(d), 'score': round(0.4 * sim + (0.5 if byref else 0) + (0.3 if same_street else 0) - d / 2000, 3), 'how': 'moved'})
        if cands:
            cands.sort(key=lambda c: -c['score'])
            r['status'] = 'moved'; r['osm'] = cands[:3]
            r['diff'] = diff(feed, s, osm_stops[cands[0]['id']])

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
        if o['id'] in used or not platform(o):
            continue
        ci, cj = int(o['lat'] / 0.004), int(o['lon'] / 0.004)
        close = any(dist(o['lat'], o['lon'], la, lo) <= FOOTPRINT for i in (ci - 1, ci, ci + 1) for j in (cj - 1, cj, cj + 1) for la, lo in ggrid.get((i, j), []))
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
    """network / network:wikidata against what this agency's stops in OSM carry (conv). An old name of the same
    network (one the feed's agency_name contains, or one iD's name-suggestion-index lists) is swapped for the
    current one; anything else is a question (a route name typed as the network, or another network sharing
    the stop, which then wants both: a;b). operator is left alone: it's who runs the
    buses, which a rebrand doesn't change."""
    t, out, net = o['tags'], {}, conv.get('network')
    agency = feed.agency.get('agency_name', '').lower()
    if net:
        parts = [x.strip() for x in (t.get('network') or '').split(';') if x.strip()]
        old = lambda x: x.lower() in aliases or (len(x) > 2 and x.lower() in agency)
        new = list(dict.fromkeys(net if old(x) else x for x in parts)) or [net]
        if net not in new:   # something else only: the question is whether to replace it
            new = [net]
        if ';'.join(new) != (t.get('network') or ''):
            out['network'] = {'gtfs': ';'.join(new), 'osm': t.get('network', ''),
                              'old': [x for x in parts if old(x)], 'other': [x for x in parts if not old(x) and x != net]}
    wd = conv.get('network:wikidata')
    if wd and t.get('network:wikidata') != wd and wd not in (t.get('network:wikidata') or '').split(';'):
        out['network:wikidata'] = {'gtfs': wd, 'osm': t.get('network:wikidata', '')}
    return out


def proposed_tags(feed, s, conv=None):
    """The tags a fresh platform node for this GTFS stop would carry (the GTFS tagging scheme, 2024)."""
    conv = conv or {}
    agency = feed.agency.get('agency_name', '')
    t = {'highway': 'bus_stop', 'public_transport': 'platform', 'bus': 'yes',
         'name': s.name, 'ref': s.ref, 'gtfs:stop_id': s.id}
    if s.code:
        t['gtfs:stop_code'] = s.code
    for k in ('operator', 'network', 'network:wikidata', 'operator:wikidata'):
        if conv.get(k):
            t[k] = conv[k]
    if 'operator' not in t and agency:
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
            elif v['other']:
                out[k] = {'pick': 'ask', 'why': f"OSM says '{v['osm']}', not this agency's network. A route name in the wrong tag? If another network's buses stop here too, it wants both ('{v['osm']};{v['gtfs']}'): edit that by hand"}
            else:
                out[k] = {'pick': 'agency', 'why': f"'{v['osm']}' is the old name: this agency's other stops in OSM, and iD's name suggestions, say '{v['gtfs']}'"}
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
            elif same_address(g, m):
                out[k] = {'pick': 'keep', 'why': 'same address, written differently' + (f" (OSM adds '{extra(m)}')" if extra(m) else '')}
            elif set(re.sub(r"[^\w\s]", ' ', m.lower()).split()) <= set(re.sub(r"[^\w\s]", ' ', g.lower()).split()) | {'and'}:
                out[k] = {'pick': 'keep', 'why': "OSM's name is part of the agency's: it names the bay, the agency adds the address"}
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
                out[k] = {'pick': 'ask', 'why': f"they name different streets: is OSM's '{m}' the same place as the agency's '{g}'?"}
    # position: within FAR it's the same stop placed by two hands, unless OSM has it across the street
    wrong = side and side.get('osm') == 'left' and side.get('gtfs') == 'right'
    if wrong:
        out['position'] = {'pick': 'ask', 'why': f"OSM has it across the street from where buses going this way stop; the agency's point is on their side ({round(d)} m)"}
    elif d > FAR:
        out['position'] = {'pick': 'ask', 'why': f"{round(d)} m apart: the agency's points are often 10–30 m off, but this is more"}
    elif d >= 2:
        out['position'] = {'pick': 'keep', 'why': f'{round(d)} m apart: the same spot, placed by two hands'}
    return out
