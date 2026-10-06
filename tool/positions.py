"""Where a stop is: reconciling the agency's point with OSM's.

The two are good at different things. The agency's point is how you learn a stop *moved*: it changes when
the stop does, often before anyone edits OSM. But it's rough in absolute terms (often the road's centre line,
from scheduling software). A carefully mapped OSM node is good at the exact spot: the pole, the kerb, from
imagery or a GPS on site. So the question isn't which is more accurate; it's whether the stop moved.

    jumps(cache_dir, slug)        {stop id: the agency's latest move of its point, between feed versions}
    provenance(node, history,     how OSM's node got where it is: 'feed' (placed at an agency point and never
               agency_points)     moved since), 'hand' (moved after it was made), or 'unknown'
    plan(...)                     what to suggest for the stop's position

A move the agency made goes to OSM as the agency's new point when OSM's node came from the agency anyway, and
as OSM's node shifted by the agency's move when a mapper placed it by hand: the mapper's precision is kept,
the move followed. With one feed version there's no history yet, and the position question is as before.
"""
import json, math, os, sys, urllib.request

JUMP = 10      # m: the agency's point moving at least this much between feed versions is the stop moving
SAME = 2.5     # m: a node within this of an agency point was put there from the agency's data
HELD = 1.0     # m: a node version this far from the one before it was moved by someone


def dist(lat1, lon1, lat2, lon2):
    return math.hypot((lat2 - lat1) * 110540, (lon2 - lon1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2)))


def versions(cache_dir, slug):
    """The feed summaries kept (feeddiff.track), oldest first: [{version, start, stops: {id: {lat, lon, ...}}}]."""
    index_path = os.path.join(cache_dir, f'{slug}-feeds.json')
    out = []
    for tag in (json.load(open(index_path)) if os.path.exists(index_path) else []):
        p = os.path.join(cache_dir, f'{slug}-feed-{tag}.json')
        if os.path.exists(p):
            out.append(json.load(open(p)))
    return out


def jumps(vs, jump=JUMP):
    """{stop id: {'m', 'from': [lon, lat], 'to': [lon, lat], 'version', 'start'}}: for each stop, the latest pair of
    consecutive feed versions between which its point moved at least `jump` metres. vs: versions(), oldest first."""
    out = {}
    for a, b in zip(vs, vs[1:]):
        for sid, nb in b['stops'].items():
            na = a['stops'].get(sid)
            if not na:
                continue
            d = dist(na['lat'], na['lon'], nb['lat'], nb['lon'])
            if d >= jump:
                out[sid] = {'m': round(d), 'from': [na['lon'], na['lat']], 'to': [nb['lon'], nb['lat']], 'version': b.get('version'), 'start': b.get('start')}
    return out


def agency_points(vs, sid):
    """Every point the agency has given this stop, across the feed versions kept: [(lat, lon)]."""
    return [(v['stops'][sid]['lat'], v['stops'][sid]['lon']) for v in vs if sid in v['stops']]


def provenance(history, points):
    """How an OSM node got where it is, from its history ([{version, lat, lon, user, timestamp}], oldest first):
    'hand'    a version after the first moved it (someone placed it with care, or corrected it);
    'feed'    never moved, and made at one of the agency's points (copied from the agency's data);
    'unknown' never moved, made elsewhere: perhaps by hand from imagery, perhaps from a feed version not kept."""
    hs = [h for h in history if h.get('lat') is not None]
    if not hs:
        return 'unknown'
    for x, y in zip(hs, hs[1:]):
        if dist(x['lat'], x['lon'], y['lat'], y['lon']) > HELD:
            return 'hand'
    first = hs[0]
    if any(dist(first['lat'], first['lon'], la, lo) <= SAME for la, lo in points):
        return 'feed'
    return 'unknown'


def history(api, node_id, cache_dir, refresh=False):
    """A node's versions from the OSM API (api: its base URL), kept in cache_dir/history/. [] if unreachable."""
    path = os.path.join(cache_dir, 'history', f'node-{node_id}.json')
    if not refresh and os.path.exists(path):
        return json.load(open(path))
    try:
        req = urllib.request.Request(f'{api}/api/0.6/node/{node_id}/history.json', headers={'User-Agent': 'flagstop (GTFS/OSM route review)'})
        with urllib.request.urlopen(req, timeout=60) as r:
            hs = [{k: e.get(k) for k in ('version', 'lat', 'lon', 'user', 'timestamp')} for e in json.load(r)['elements']]
    except Exception as e:
        print(f'history of n{node_id}: {e}', file=sys.stderr)
        return []
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(hs, open(path, 'w'))
    return hs


def plan(stop, node, jump, prov, far):
    """What to say about the stop's position when the agency moved its point. -> {'pick', 'why', 'to': [lon, lat],
    'how'} or None (no move in the feed's history to go on: the position question stays as it was).
    OSM's node still near the agency's old point means OSM hasn't caught up; near the new one, it already has."""
    if not jump:
        return None
    lat, lon = node['lat'], node['lon']
    near_old = dist(lat, lon, jump['from'][1], jump['from'][0]) <= far
    near_new = dist(lat, lon, jump['to'][1], jump['to'][0]) <= far
    if near_new or not near_old:
        return None   # OSM already has it at the new spot, or never had it at the old one: nothing the move explains
    when = f" (feed {jump['version'] or jump['start']})" if jump.get('version') or jump.get('start') else ''
    if prov == 'hand':
        dx, dy = jump['to'][0] - jump['from'][0], jump['to'][1] - jump['from'][1]
        return {'pick': 'ask', 'how': 'shift', 'to': [lon + dx, lat + dy],
                'why': f"The agency moved this stop {jump['m']} m{when}. OSM's node was placed by hand, so it moves by the same amount, keeping where the mapper put it relative to the agency's point"}
    return {'pick': 'ask', 'how': 'agency', 'to': list(jump['to']),
            'why': f"The agency moved this stop {jump['m']} m{when}, and OSM still has it at the old spot" +
                   (" (its node came from the agency's data, so the agency's new point is as good)" if prov == 'feed' else '')}
