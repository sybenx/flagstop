"""A GTFS feed, reduced to what a route review needs: stops, routes, and each route's distinct
trip patterns (an ordered stop sequence with the shape drawn for it).

    feed = load('cvtd.zip')
    feed.stops[stop_id]            -> Stop
    feed.routes[route_id]          -> Route
    feed.patterns                  -> [Pattern], one per (route, direction, shape, stop sequence)
    feed.shapes[shape_id]          -> [(lon, lat), ...]
"""
import csv, io, zipfile
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
    seq = defaultdict(list)
    for r in _rows(z, 'stop_times.txt'):
        if r['trip_id'] in trips and r['stop_id'] in stops:
            try:
                seq[r['trip_id']].append((int(r['stop_sequence']), r['stop_id']))
            except ValueError:
                continue

    # Group trips into patterns: same route, direction, shape and stop sequence.
    groups = {}
    for tid, t in trips.items():
        order = tuple(s for _, s in sorted(seq.get(tid, [])))
        if not order:
            continue
        key = (t['route_id'], t.get('direction_id', ''), t.get('shape_id', ''), order)
        g = groups.setdefault(key, {'trips': 0, 'services': set(), 'headsigns': defaultdict(int)})
        g['trips'] += 1
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
    for (rid, d, sid, order), g in sorted(groups.items(), key=lambda kv: (-len(kv[0][3]), -kv[1]['trips'])):
        parent = next((p for p in by_shape[(rid, d, sid)] if subseq(order, p.stops)), None)
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
    patterns.sort(key=lambda p: (-p.trips, p.route_id, p.direction))

    return Feed(agency=agency, info=info, stops=stops, routes=routes, patterns=patterns, shapes=dict(shapes), calendar=calendar)


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
