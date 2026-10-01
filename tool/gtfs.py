"""A GTFS feed, reduced to what a route review needs: stops, routes, and each route's distinct
trip patterns (an ordered stop sequence with the shape drawn for it).

    feed = load('cvtd.zip')
    feed.stops[stop_id]            -> Stop
    feed.routes[route_id]          -> Route
    feed.patterns                  -> [Pattern], one per (route, direction, shape, stop sequence)
    feed.shapes[shape_id]          -> [(lon, lat), ...]
"""
import csv, datetime, io, zipfile
from collections import defaultdict
from dataclasses import dataclass, field


@dataclass
class Stop:
    id: str
    code: str
    name: str
    lat: float
    lon: float
    desc: str = ''              # stop_desc: at CVTD the on-bus announcement ("Intermodal Transit Center")
    tts: str = ''               # tts_stop_name
    url: str = ''
    wheelchair: str = ''        # 0 unknown, 1 yes, 2 no
    platform_code: str = ''
    parent: str = ''
    location_type: str = '0'
    routes: set = field(default_factory=set)   # route ids that call here
    trips: int = 0                              # trips a week-ish that call here (a rough weight)

    @property
    def ref(self):
        return self.code or self.id


@dataclass
class Route:
    id: str
    short: str
    long: str
    desc: str
    type: str
    color: str
    text_color: str
    url: str
    agency: str


@dataclass
class Pattern:
    """One way a route is run: this stop sequence, drawn with this shape."""
    id: str
    route_id: str
    direction: str
    headsign: str
    shape_id: str
    stops: list                 # [stop_id, ...] in order
    trips: int                  # how many trips use it (in the whole feed)
    service_ids: set
    direction_name: str = ''    # directions.txt, if the feed has it
    variants: int = 0           # shorter runs folded into this one
    temporary: bool = False     # only run by a short-dated service: a detour or a special
    alt_shapes: list = field(default_factory=list)   # shapes of runs folded into this pattern
    alt_stops: list = field(default_factory=list)    # stops only those runs call at (a different terminal bay)
    loop: list = field(default_factory=list)         # joined from these patterns: one bus runs them back to back
    split_at: str = ''                               # ... and the feed splits the trip at this stop
    hours: dict = field(default_factory=dict)        # service_id -> [first departure s, last arrival s, trips, typical gap between departures s]


@dataclass
class Feed:
    agency: dict
    info: dict
    stops: dict
    routes: dict
    patterns: list
    shapes: dict
    calendar: dict              # service_id -> row


def _rows(z, name):
    if name not in z.namelist():
        return []
    with z.open(name) as f:
        text = io.TextIOWrapper(f, encoding='utf-8-sig', newline='')
        return [{k.strip(): (v or '').strip() for k, v in r.items() if k} for r in csv.DictReader(text)]


def load(path):
    z = zipfile.ZipFile(path)
    agency = (_rows(z, 'agency.txt') or [{}])[0]
    info = (_rows(z, 'feed_info.txt') or [{}])[0]
    calendar = {r['service_id']: r for r in _rows(z, 'calendar.txt')}
    directions = {(r['route_id'], r['direction_id']): r.get('direction', '') for r in _rows(z, 'directions.txt')}

    stops = {}
    for r in _rows(z, 'stops.txt'):
        try:
            lat, lon = float(r['stop_lat']), float(r['stop_lon'])
        except (KeyError, ValueError):
            continue
        stops[r['stop_id']] = Stop(
            id=r['stop_id'], code=r.get('stop_code', ''), name=r.get('stop_name', ''), lat=lat, lon=lon,
            desc=r.get('stop_desc', ''), tts=r.get('tts_stop_name', ''), url=r.get('stop_url', ''),
            wheelchair=r.get('wheelchair_boarding', ''), platform_code=r.get('platform_code', ''),
            parent=r.get('parent_station', ''), location_type=r.get('location_type', '0') or '0')

    routes = {}
    for r in _rows(z, 'routes.txt'):
        routes[r['route_id']] = Route(
            id=r['route_id'], short=r.get('route_short_name', ''), long=r.get('route_long_name', ''),
            desc=r.get('route_desc', ''), type=r.get('route_type', '3'), color=r.get('route_color', ''),
            text_color=r.get('route_text_color', ''), url=r.get('route_url', ''), agency=r.get('agency_id', ''))

    shapes = defaultdict(list)
    for r in _rows(z, 'shapes.txt'):
        try:
            shapes[r['shape_id']].append((int(float(r.get('shape_pt_sequence') or 0)), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))
        except (KeyError, ValueError):
            continue
    shapes = {k: [(lon, lat) for _, lon, lat in sorted(v)] for k, v in shapes.items()}

    trips = {r['trip_id']: r for r in _rows(z, 'trips.txt')}
    seq, times = defaultdict(list), defaultdict(list)
    for r in _rows(z, 'stop_times.txt'):
        if r['trip_id'] in trips and r['stop_id'] in stops:
            try:
                n = int(r['stop_sequence'])
            except ValueError:
                continue
            seq[r['trip_id']].append((n, r['stop_id']))
            times[r['trip_id']].append((n, _secs(r.get('arrival_time')), _secs(r.get('departure_time'))))

    # Group trips into patterns: same route, direction, shape and stop sequence.
    groups = {}
    for tid, t in trips.items():
        order = tuple(s for _, s in sorted(seq.get(tid, [])))
        if not order:
            continue
        key = (t['route_id'], t.get('direction_id', ''), t.get('shape_id', ''), order)
        g = groups.setdefault(key, {'trips': 0, 'services': set(), 'headsigns': defaultdict(int), 'tids': []})
        g['trips'] += 1
        g['tids'].append(tid)
        g['services'].add(t.get('service_id', ''))
        g['headsigns'][t.get('trip_headsign', '')] += 1
        for s in order:
            stops[s].routes.add(t['route_id'])
            stops[s].trips += 1

    # A first or last trip of the day often runs part of the itinerary; that is the same route, not
    # another one. Fold any pattern whose stops are a subsequence of a fuller pattern on the same shape.
    def subseq(short, long):
        it = iter(long)
        return all(s in it for s in short)

    patterns = []
    by_shape = defaultdict(list)
    of_trip = {}      # trip -> the pattern it ended up in (after folding)
    for (rid, d, sid, order), g in sorted(groups.items(), key=lambda kv: (-len(kv[0][3]), -kv[1]['trips'])):
        parent = next((p for p in by_shape[(rid, d, sid)] if subseq(order, p.stops)), None)
        for tid in g['tids']:
            of_trip[tid] = parent
        if parent:
            parent.trips += g['trips']
            parent.service_ids |= g['services']
            parent.variants += 1
            continue
        headsign = max(g['headsigns'].items(), key=lambda kv: kv[1])[0]
        p = Pattern(
            id=f'{rid}:{d}:{sid}:{len(order)}', route_id=rid, direction=d, headsign=headsign,
            shape_id=sid, stops=list(order), trips=g['trips'], service_ids=set(g['services']),
            direction_name=directions.get((rid, d), ''))
        by_shape[(rid, d, sid)].append(p)
        patterns.append(p)
        for tid in g['tids']:
            of_trip[tid] = p
    patterns.sort(key=lambda p: (-p.trips, p.route_id, p.direction))
    # Two patterns of one route that differ by a stop or two at the ends (the last run of the day parks
    # at another bay) and whose shapes cover each other are one itinerary for the map's purposes.
    kept = []
    for p in patterns:
        parent = None
        for q in kept:
            if q.route_id != p.route_id:
                continue
            common = len(set(p.stops) & set(q.stops))
            if common >= max(len(p.stops), len(q.stops)) - 2 and _mutual_cover(shapes.get(p.shape_id), shapes.get(q.shape_id)) >= 0.9:
                parent = q; break
        if parent:
            for tid, x in of_trip.items():
                if x is p:
                    of_trip[tid] = parent
            parent.trips += p.trips; parent.service_ids |= p.service_ids; parent.variants += 1 + p.variants
            parent.alt_shapes.append(p.shape_id)
            parent.alt_stops.extend(x for x in p.stops if x not in parent.stops)
        else:
            kept.append(p)
    for tid, p in of_trip.items():
        xs = sorted(times.get(tid, []))
        if not p or not xs:
            continue
        dep, arr = xs[0][2] if xs[0][2] is not None else xs[0][1], xs[-1][1] if xs[-1][1] is not None else xs[-1][2]
        if dep is None or arr is None:
            continue
        h = p.hours.setdefault(trips[tid].get('service_id', ''), [dep, arr, 0, None, []])
        h[0], h[1], h[2] = min(h[0], dep), max(h[1], arr), h[2] + 1
        h[4].append(dep)
    # how often: the typical (median) gap between one departure and the next, per service
    seen = set()
    for p in of_trip.values():
        if not p or id(p) in seen:
            continue
        seen.add(id(p))
        for sid, h in p.hours.items():
            deps = sorted(h.pop(4)) if len(h) > 4 else []
            gaps = sorted(b - a for a, b in zip(deps, deps[1:]) if b > a)
            h[3] = gaps[len(gaps) // 2] if gaps else None
    patterns = _join_loops(kept, trips, times, of_trip, shapes)
    # A pattern run only by a service that lasts a few weeks is a detour, or a special; not the regular route.
    def days(sid):
        c = calendar.get(sid)
        if not c:
            return 9999
        try:
            a, b = (datetime.date(int(x[:4]), int(x[4:6]), int(x[6:8])) for x in (c['start_date'], c['end_date']))
            return (b - a).days
        except (KeyError, ValueError):
            return 9999
    for p in patterns:
        p.temporary = all(days(sid) < 45 for sid in p.service_ids) if p.service_ids else False

    return Feed(agency=agency, info=info, stops=stops, routes=routes, patterns=patterns, shapes=dict(shapes), calendar=calendar)


def _secs(t):
    """'25:10:00' -> seconds (GTFS times run past midnight)."""
    try:
        h, m, s = (int(x) for x in (t or '').split(':'))
        return h * 3600 + m * 60 + s
    except ValueError:
        return None


LAYOVER = 5 * 60   # s: a bus leaving within this of arriving, from the stop it arrived at, carries straight on


def _join_loops(patterns, trips, times, of_trip, shapes):
    """Two patterns one bus runs back to back, each starting where the other ends, are one loop split in
    two by the feed (CVTD's route 15: out to Richmond, 'inbound' from the same stop at the same minute).
    Passengers ride through; OSM maps it as one roundtrip relation. Joined when nearly every trip of one
    carries straight on into the other on the same block (same service day, same bus) within LAYOVER, and
    the other ends where the first began. (Back at that terminal the bus waits as long as it likes: that's
    where the loop starts and ends, not where it's split.)"""
    span = {}
    for tid, xs in times.items():
        xs = sorted(xs)
        span[tid] = (xs[0][2] if xs[0][2] is not None else xs[0][1], xs[-1][1] if xs[-1][1] is not None else xs[-1][2])
    blocks = defaultdict(list)
    for tid, t in trips.items():
        if t.get('block_id') and tid in of_trip and of_trip[tid] and tid in span and None not in span[tid]:
            blocks[(t.get('service_id', ''), t['block_id'])].append(tid)
    nxt, link = defaultdict(int), defaultdict(int)   # trips of a pattern that have a next trip on their bus; of those, carried straight into another
    for tids in blocks.values():
        tids.sort(key=lambda x: span[x][0])
        for a, b in zip(tids, tids[1:]):
            pa, pb = of_trip[a], of_trip[b]
            nxt[id(pa)] += 1
            if pa is not pb and pa.route_id == pb.route_id and pa.stops[-1] == pb.stops[0] and 0 <= span[b][0] - span[a][1] <= LAYOVER:
                link[(id(pa), id(pb))] += 1
    joined, out = set(), []
    for a in patterns:
        if id(a) in joined:
            continue
        b = next((b for b in patterns if b is not a and id(b) not in joined and b.route_id == a.route_id
                  and a.stops[-1] == b.stops[0] and b.stops[-1] == a.stops[0]
                  # nearly every trip of a that has a next trip on its bus carries straight on into b
                  and nxt[id(a)] and link[(id(a), id(b))] >= 0.8 * nxt[id(a)]), None)
        if not b:
            out.append(a)
            continue
        # a runs into b without stopping: a goes first, the loop starts and ends where a starts
        sid = f'{a.shape_id}+{b.shape_id}'
        shapes[sid] = list(shapes.get(a.shape_id, [])) + list(shapes.get(b.shape_id, []))
        out.append(Pattern(id=f'{a.id}+{b.id}', route_id=a.route_id, direction='loop', headsign=a.headsign or b.headsign,
                           shape_id=sid, stops=a.stops + b.stops[1:], trips=min(a.trips, b.trips), service_ids=a.service_ids | b.service_ids,
                           direction_name=a.direction_name, variants=a.variants + b.variants, alt_shapes=a.alt_shapes + b.alt_shapes,
                           alt_stops=a.alt_stops + b.alt_stops, loop=[a.id, b.id], split_at=b.stops[0],
                           hours={sid: [a.hours[sid][0], b.hours.get(sid, a.hours[sid])[1], a.hours[sid][2], a.hours[sid][3]] for sid in a.hours}))
        joined |= {id(a), id(b)}
    return out


def _mutual_cover(a, b, tol=30.0, step=25.0):
    """How much two polylines overlap, 0..1 (the smaller of each covering the other)."""
    if not a or not b or len(a) < 2 or len(b) < 2:
        return 0.0
    import math

    def near(p, line):
        best = 1e9
        for i in range(len(line) - 1):
            (ax, ay), (bx, by) = line[i], line[i + 1]
            kx = 111320 * math.cos(math.radians(ay)); ky = 110540
            dx, dy = (bx - ax) * kx, (by - ay) * ky
            L2 = dx * dx + dy * dy
            t = 0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - ax) * kx * dx + (p[1] - ay) * ky * dy) / L2))
            qx, qy = ax + (bx - ax) * t, ay + (by - ay) * t
            d = math.hypot((p[0] - qx) * kx, (p[1] - qy) * ky)
            if d < best:
                best = d
        return best

    def frac(x, y):
        pts = x[::max(1, len(x) // 150)]
        return sum(1 for p in pts if near(p, y) <= tol) / len(pts)
    return min(frac(a, b), frac(b, a))


def bbox(feed, margin=0.01):
    """(south, west, north, east) around every stop and shape point."""
    lats = [s.lat for s in feed.stops.values()] + [p[1] for sh in feed.shapes.values() for p in sh]
    lons = [s.lon for s in feed.stops.values()] + [p[0] for sh in feed.shapes.values() for p in sh]
    return min(lats) - margin, min(lons) - margin, max(lats) + margin, max(lons) + margin


if __name__ == '__main__':
    import sys
    f = load(sys.argv[1])
    print(f['agency'] if isinstance(f, dict) else f.agency.get('agency_name'), f.info.get('feed_version'))
    print(len(f.stops), 'stops', len(f.routes), 'routes', len(f.patterns), 'patterns', len(f.shapes), 'shapes')
    print('bbox', bbox(f))
    for p in f.patterns:
        r = f.routes[p.route_id]
        print(f'  {r.short:>6} dir {p.direction} {p.headsign[:28]:<28} shape {p.shape_id} {len(p.stops):3d} stops {p.trips:4d} trips')
