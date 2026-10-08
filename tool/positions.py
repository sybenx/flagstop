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
AWAY = 50      # m: a move this long, leaving the node this far from the agency's spot, is away from the stop (a
               #    mapper putting a node on its sign moves it less: that's placing it, not moving it away)
REUSED = 400   # m: past this it isn't the stop moving along its street; the id is another stop's now


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


def jumps(vs, jump=JUMP, reused=REUSED):
    """{stop id: {'m', 'from': [lon, lat], 'to': [lon, lat], 'version', 'start'}}: for each stop, its latest move of at
    least `jump` metres, from where the feed last had it (a version without it, a detour's, in between, doesn't
    hide the move). A move past `reused` isn't one: the id names another stop now. vs: versions(), oldest first."""
    out, last = {}, {}
    for b in vs:
        for sid, nb in b['stops'].items():
            na = last.get(sid)
            last[sid] = nb
            if not na:
                continue
            d = dist(na['lat'], na['lon'], nb['lat'], nb['lon'])
            if d > reused:
                out.pop(sid, None)   # what came before was another stop's history
            elif d >= jump:
                out[sid] = {'m': round(d), 'from': [na['lon'], na['lat']], 'to': [nb['lon'], nb['lat']], 'version': b.get('version'), 'start': b.get('start')}
    return out


def agency_points(vs, sid):
    """Every point the agency has given this stop, across the feed versions kept: [(lat, lon)]."""
    return [(v['stops'][sid]['lat'], v['stops'][sid]['lon']) for v in vs if sid in v['stops']]


def provenance(history, points):
    """How an OSM node got where it is, from its history ([{version, lat, lon, user, timestamp}], oldest first):
    'hand'    a version after the first moved it (someone placed it with care, or corrected it);
    'feed'    never moved, and made at one of the agency's points (copied from the agency's data);
    'unknown' never moved, made elsewhere: perhaps by hand from imagery, perhaps from a feed version not kept.
    None when the history couldn't be had: nothing is suggested then (a guess would lean to the agency's point)."""
    if history is None:
        return None
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


def history(api, node_id, cache_dir, refresh=False, version=None):
    """A node's versions from the OSM API (api: its base URL), kept in cache_dir/history/: read again when OSM's node
    (version: its current one) is newer than the copy kept. None if it can't be had."""
    path = os.path.join(cache_dir, 'history', f'node-{node_id}.json')
    if not refresh and os.path.exists(path):
        hs = json.load(open(path))
        # (kept before the changeset was: read again, once)
        if (not version or (hs and (hs[-1].get('version') or 0) >= version)) and (not hs or 'changeset' in hs[-1]):
            return hs
    try:
        req = urllib.request.Request(f'{api}/api/0.6/node/{node_id}/history.json', headers={'User-Agent': 'flagstop (GTFS/OSM route review)'})
        with urllib.request.urlopen(req, timeout=60) as r:
            hs = [{k: e.get(k) for k in ('version', 'lat', 'lon', 'user', 'timestamp', 'changeset')} for e in json.load(r)['elements']]
    except Exception as e:
        print(f'history of n{node_id}: {e}', file=sys.stderr)
        return None
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(hs, open(path, 'w'))
    return hs


def moved_away(history, point, far, away=AWAY):
    """OSM's node was at the agency's spot and someone moved it away: {'user', 'date', 'changeset', 'm', 'back':
    [lon, lat]} of the edit that did (back: where it was before), or None. history: oldest first; point: the
    agency's (lat, lon); far: metres within which it counts as at the agency's spot. Only the latest such edit,
    and only if nothing after it brought the node back."""
    hs = [h for h in history or [] if h.get('lat') is not None]
    near = lambda h: dist(h['lat'], h['lon'], point[0], point[1]) <= far
    if len(hs) < 2 or dist(hs[-1]['lat'], hs[-1]['lon'], point[0], point[1]) < away:
        return None   # at the spot, or near enough that someone may have placed it on the sign
    for i in range(len(hs) - 1, 0, -1):
        if near(hs[i - 1]) and not near(hs[i]):
            a, b = hs[i - 1], hs[i]
            if dist(a['lat'], a['lon'], b['lat'], b['lon']) < away:
                return None   # a short move, placing it: the mapper's
            return {'user': b.get('user'), 'date': (b.get('timestamp') or '')[:10], 'changeset': b.get('changeset'),
                    'm': round(dist(a['lat'], a['lon'], b['lat'], b['lon'])), 'back': [a['lon'], a['lat']], 'version': b.get('version')}
    return None


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
