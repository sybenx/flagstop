"""Where a bus can drive on OpenStreetMap's roads, and how that compares with the line the agency drew.

    g = Graph(osm_roads_json)
    r = trace(g, stops_lonlat, shape_lonlat)   # -> ways in order, legs, divergences, scores

The trace is a shortest path between consecutive stops over roads a bus may use (oneway, access and
bus/psv exceptions honoured), with a cost for straying from the GTFS shape. So it follows the drawn
line wherever the map allows, and leaves it only where the map does not: a road that is missing, cut,
one-way the wrong way, or closed to buses. Those places are the divergences, each with a guess at why.
"""
import heapq, math

# How much a bus would rather not: cost multipliers by highway class.
PREFER = {'motorway': 1.0, 'trunk': 1.0, 'primary': 1.0, 'secondary': 1.0, 'tertiary': 1.05, 'unclassified': 1.15,
          'residential': 1.2, 'living_street': 1.6, 'busway': 0.9, 'road': 1.3, 'service': 1.8,
          'motorway_link': 1.0, 'trunk_link': 1.0, 'primary_link': 1.0, 'secondary_link': 1.0, 'tertiary_link': 1.05}
SERVICE_PENALTY = {'driveway': 3.0, 'parking_aisle': 2.2, 'alley': 2.5, 'emergency_access': 6.0}
STRAY = 25       # m from the shape a road may be for free
STRAY_COST = 0.06  # extra cost per metre of road, per metre beyond STRAY (a 100 m detour 50 m off the line ~ doubles)
SNAP = 60        # m: a stop further than this from any road is placed on no road at all
DIVERGE = 30     # m: the routed path this far from the shape is a divergence


def metres(a, b):
    return math.hypot((b[0] - a[0]) * 111320 * math.cos(math.radians((a[1] + b[1]) / 2)), (b[1] - a[1]) * 110540)


def project(p, a, b):
    """Nearest point on segment a-b to p, its distance in metres, and the fraction along."""
    ax, ay = a; bx, by = b; px, py = p
    kx = 111320 * math.cos(math.radians(ay)); ky = 110540
    dx, dy = (bx - ax) * kx, (by - ay) * ky
    if dx == 0 and dy == 0:
        return a, metres(p, a), 0.0
    t = max(0.0, min(1.0, ((px - ax) * kx * dx + (py - ay) * ky * dy) / (dx * dx + dy * dy)))
    q = (ax + (bx - ax) * t, ay + (by - ay) * t)
    return q, metres(p, q), t


class Polyline:
    """A line with a grid over its segments, for 'how far is this point from the line' in a hurry."""
    def __init__(self, pts, cell=0.003):
        self.pts = pts
        self.cell = cell
        self.grid = {}
        self.cum = [0.0]
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            self.cum.append(self.cum[-1] + metres(a, b))
            for ci in range(int(min(a[1], b[1]) / cell) - 1, int(max(a[1], b[1]) / cell) + 2):
                for cj in range(int(min(a[0], b[0]) / cell) - 1, int(max(a[0], b[0]) / cell) + 2):
                    self.grid.setdefault((ci, cj), []).append(i)
        self.length = self.cum[-1]

    def nearest(self, p, lo=None, hi=None):
        """(distance m, segment index, position along in m) of the nearest segment, optionally within [lo, hi]."""
        best = (float('inf'), -1, 0.0)
        for i in self.grid.get((int(p[1] / self.cell), int(p[0] / self.cell)), []):
            if lo is not None and (i < lo or i > hi):
                continue
            _, d, t = project(p, self.pts[i], self.pts[i + 1])
            if d < best[0]:
                best = (d, i, self.cum[i] + t * (self.cum[i + 1] - self.cum[i]))
        if best[1] < 0:  # nothing in this cell: search wider (rare, the caller is usually near the line)
            for i in (range(lo, hi + 1) if lo is not None else range(len(self.pts) - 1)):
                _, d, t = project(p, self.pts[i], self.pts[i + 1])
                if d < best[0]:
                    best = (d, i, self.cum[i] + t * (self.cum[i + 1] - self.cum[i]))
        return best

    def slice(self, m0, m1):
        """Points along the line between two distances in metres."""
        out = []
        for i in range(len(self.pts) - 1):
            if self.cum[i + 1] < m0 or self.cum[i] > m1:
                continue
            a, b = self.pts[i], self.pts[i + 1]
            L = self.cum[i + 1] - self.cum[i] or 1
            t0 = max(0.0, (m0 - self.cum[i]) / L); t1 = min(1.0, (m1 - self.cum[i]) / L)
            if not out:
                out.append((a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0))
            out.append((a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1))
        return out


def bus_may(tags):
    """Can a bus drive this way at all, and which way? -> (forward, backward) or None."""
    hw = tags.get('highway')
    if hw not in PREFER:
        return None
    for k in ('bus', 'psv'):
        if tags.get(k) in ('yes', 'designated', 'official'):
            break
    else:
        if tags.get('access') in ('no', 'private') or tags.get('motor_vehicle') in ('no', 'private') or tags.get('vehicle') in ('no', 'private'):
            if not any(tags.get(k) in ('yes', 'designated', 'permissive') for k in ('bus', 'psv', 'motor_vehicle')):
                return None
        if tags.get('bus') == 'no' or tags.get('psv') == 'no':
            return None
    ow = tags.get('oneway:bus') or tags.get('oneway:psv') or tags.get('oneway')
    if ow is None and tags.get('junction') in ('roundabout', 'circular'):
        ow = 'yes'
    if ow in ('yes', 'true', '1'):
        return (True, False)
    if ow == '-1':
        return (False, True)
    return (True, True)


class Graph:
    def __init__(self, raw):
        self.coord = {}
        self.ways = {}
        for el in raw.get('elements', []):
            if el['type'] == 'node':
                self.coord[el['id']] = (el['lon'], el['lat'])
            elif el['type'] == 'way':
                self.ways[el['id']] = el
        self.adj = {}          # node -> [(node, way, cost_per_m, length)]
        self.segs = []         # (way, i, a, b) every drivable segment, for snapping
        self.blocked = {}      # way -> reason a bus can't use it (for explaining a divergence)
        for wid, w in self.ways.items():
            t = w.get('tags', {})
            may = bus_may(t)
            if may is None:
                self.blocked[wid] = self._why_blocked(t)
                continue
            f = PREFER[t['highway']] * SERVICE_PENALTY.get(t.get('service', ''), 1.0)
            nodes = [n for n in w['nodes'] if n in self.coord]
            for i in range(len(nodes) - 1):
                a, b = nodes[i], nodes[i + 1]
                L = metres(self.coord[a], self.coord[b])
                if may[0]:
                    self.adj.setdefault(a, []).append((b, wid, f, L))
                if may[1]:
                    self.adj.setdefault(b, []).append((a, wid, f, L))
                self.segs.append((wid, i, a, b))
        cell = 0.002
        self.cell = cell
        self.sgrid = {}
        for s in self.segs:
            a, b = self.coord[s[2]], self.coord[s[3]]
            for ci in range(int(min(a[1], b[1]) / cell), int(max(a[1], b[1]) / cell) + 1):
                for cj in range(int(min(a[0], b[0]) / cell), int(max(a[0], b[0]) / cell) + 1):
                    self.sgrid.setdefault((ci, cj), []).append(s)

    @staticmethod
    def _why_blocked(t):
        hw = t.get('highway', '?')
        if hw not in PREFER:
            return f'highway={hw}'
        for k in ('access', 'motor_vehicle', 'vehicle', 'bus', 'psv'):
            if t.get(k) in ('no', 'private'):
                return f'{k}={t[k]}'
        return 'not drivable'

    def snap(self, p, r=SNAP):
        """Nearest drivable segment to a point: (dist, way, node a, node b, fraction along) or None."""
        ci, cj = int(p[1] / self.cell), int(p[0] / self.cell)
        best = None
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for wid, k, a, b in self.sgrid.get((i, j), []):
                    _, d, t = project(p, self.coord[a], self.coord[b])
                    if d <= r and (best is None or d < best[0]):
                        best = (d, wid, a, b, t)
        return best

    def nearby_ways(self, p, r):
        """Every way (drivable or not) with a segment within r metres of p -> {way: dist}."""
        out = {}
        ci, cj = int(p[1] / self.cell), int(p[0] / self.cell)
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for wid, k, a, b in self.sgrid.get((i, j), []):
                    _, d, _ = project(p, self.coord[a], self.coord[b])
                    if d <= r and d < out.get(wid, r + 1):
                        out[wid] = d
        # blocked ways are not in the segment grid; scan them the slow way only when asked
        return out

    def blocked_near(self, p, r):
        out = {}
        for wid, why in self.blocked.items():
            w = self.ways[wid]
            nodes = [n for n in w['nodes'] if n in self.coord]
            for i in range(len(nodes) - 1):
                a, b = self.coord[nodes[i]], self.coord[nodes[i + 1]]
                if abs(a[1] - p[1]) > 0.003 and abs(b[1] - p[1]) > 0.003:
                    continue
                _, d, _ = project(p, a, b)
                if d <= r:
                    out[wid] = (d, why); break
        return out

    def astar(self, starts, goals, guide=None, lo=None, hi=None, limit=250000):
        """Cheapest path from any start to any goal.
        starts/goals: {node: initial cost}. guide: Polyline the path should hug (with segment range lo..hi).
        -> (cost, [nodes], [ways]) or None"""
        goal_pts = [self.coord[g] for g in goals]

        def h(n):
            p = self.coord[n]
            return min(metres(p, q) for q in goal_pts) * 0.9

        stray = {}

        def stray_cost(n):
            if guide is None:
                return 0.0
            if n not in stray:
                d = guide.nearest(self.coord[n], lo, hi)[0]
                stray[n] = max(0.0, d - STRAY) * STRAY_COST
            return stray[n]

        dist, prev, pw = {}, {}, {}
        pq = []
        for s, c in starts.items():
            dist[s] = c
            heapq.heappush(pq, (c + h(s), c, s))
        seen = 0
        while pq:
            f, c, n = heapq.heappop(pq)
            if c > dist.get(n, float('inf')):
                continue
            if n in goals:
                path, ways = [n], []
                while n in prev:
                    ways.append(pw[n]); n = prev[n]; path.append(n)
                return c + goals[path[0]], path[::-1], ways[::-1]
            seen += 1
            if seen > limit:
                return None
            for m, wid, fac, L in self.adj.get(n, []):
                nc = c + L * (fac + stray_cost(m))
                if nc < dist.get(m, float('inf')):
                    dist[m] = nc; prev[m] = n; pw[m] = wid
                    heapq.heappush(pq, (nc + h(m), nc, m))
        return None


def trace(g, stops, shape):
    """Route a pattern over the graph.
    stops: [(lon, lat), ...] in order.  shape: [(lon, lat), ...] or None.
    -> dict(legs, ways, geometry, divergences, score)"""
    guide = Polyline(shape) if shape and len(shape) > 1 else None
    # Where each stop sits along the shape, so each leg only hugs its own part of the line.
    at = []
    if guide:
        pos = 0.0
        for p in stops:
            d, i, m = guide.nearest(p)
            if m < pos - 200:  # a loop passes the same place twice: keep moving forward
                d2, i2, m2 = guide.nearest(p, lo=max(0, i), hi=len(guide.pts) - 2)
                if d2 < d + 30:
                    i, m = i2, m2
            at.append((i, m)); pos = max(pos, m)
    snaps = [g.snap(p) for p in stops]
    legs, all_ways, geom, divs = [], [], [], []
    prev_end = None
    for k in range(len(stops) - 1):
        s0, s1 = snaps[k], snaps[k + 1]
        leg = {'from': k, 'to': k + 1, 'ok': False, 'ways': [], 'geometry': [], 'why': ''}
        if s0 is None or s1 is None:
            leg['why'] = f'stop {k if s0 is None else k + 1} is more than {SNAP} m from any road a bus can use'
            legs.append(leg); prev_end = None
            continue
        lo = hi = None
        if guide:
            lo, hi = min(at[k][0], at[k + 1][0]), max(at[k][0], at[k + 1][0])
            lo, hi = max(0, lo - 3), min(len(guide.pts) - 2, hi + 3)
        # Start from either end of the stop's segment, paying the distance along it; same for the goal.
        La = metres(g.coord[s0[2]], g.coord[s0[3]])
        starts = {}
        if prev_end is not None and prev_end in (s0[2], s0[3]):
            starts = {prev_end: 0.0}
        else:
            starts = {s0[3]: (1 - s0[4]) * La}
            if s0[2] in g.adj and (s0[2], s0[1]) in {(m, w) for (m, w, _, _) in g.adj.get(s0[3], [])}:
                starts[s0[2]] = s0[4] * La   # two-way segment: may leave backwards too
        Lb = metres(g.coord[s1[2]], g.coord[s1[3]])
        goals = {s1[2]: s1[4] * Lb}
        if (s1[2], s1[1]) in {(m, w) for (m, w, _, _) in g.adj.get(s1[3], [])}:
            goals[s1[3]] = (1 - s1[4]) * Lb
        res = g.astar(starts, goals, guide, lo, hi)
        if res is None:
            leg['why'] = 'no drivable path between these stops on the map'
            legs.append(leg); prev_end = None
            continue
        cost, path, ways = res
        leg['ok'] = True
        leg['ways'] = [s0[1]] + ways + [s1[1]] if ways else [s0[1], s1[1]] if s0[1] != s1[1] else [s0[1]]
        leg['ways'] = [w for i, w in enumerate(leg['ways']) if i == 0 or w != leg['ways'][i - 1]]
        leg['geometry'] = [g.coord[n] for n in path]
        prev_end = path[-1]
        legs.append(leg)
        for w in leg['ways']:
            if not all_ways or all_ways[-1] != w:
                all_ways.append(w)
        geom.extend(leg['geometry'])
    if guide:
        divs = divergences(g, guide, legs, stops, at)
    score = coverage(guide, geom) if guide else None
    return {'legs': legs, 'ways': all_ways, 'geometry': geom, 'divergences': divs, 'score': score}


def coverage(guide, geom):
    """How much of the shape the routed path follows, and vice versa, within DIVERGE metres. 0..1 each."""
    if not geom or guide.length == 0:
        return {'shape_covered': 0.0, 'path_on_shape': 0.0}
    routed = Polyline(geom)
    step = 15.0
    n = int(guide.length / step) + 1
    on = 0
    for i in range(n):
        p = guide.slice(i * step, i * step + 0.01)
        if p and routed.nearest(p[0])[0] <= DIVERGE:
            on += 1
    m = int(routed.length / step) + 1
    on2 = 0
    for i in range(m):
        p = routed.slice(i * step, i * step + 0.01)
        if p and guide.nearest(p[0])[0] <= DIVERGE:
            on2 += 1
    return {'shape_covered': round(on / n, 3), 'path_on_shape': round(on2 / m, 3)}


def divergences(g, guide, legs, stops, at):
    """Runs where the routed path and the shape part company, with a guess at the reason."""
    out = []
    for leg in legs:
        k = leg['from']
        if not leg['ok']:
            m0, m1 = sorted((at[k][1], at[k + 1][1]))
            mid = guide.slice((m0 + m1) / 2, (m0 + m1) / 2 + 0.01)
            out.append({'kind': 'no-path', 'leg': k, 'lon': mid[0][0] if mid else stops[k][0], 'lat': mid[0][1] if mid else stops[k][1],
                        'length': round(m1 - m0), 'why': leg['why'], 'ways': [], 'shape': guide.slice(m0, m1)})
            continue
        # Walk the routed geometry; open a run where it strays, close it where it returns.
        run, run_ways = None, []
        pts = leg['geometry']
        lo, hi = max(0, min(at[k][0], at[k + 1][0]) - 3), min(len(guide.pts) - 2, max(at[k][0], at[k + 1][0]) + 3)
        wi = 0
        for i, p in enumerate(pts):
            d, seg, m = guide.nearest(p, lo, hi)
            if d > DIVERGE:
                if run is None:
                    run = {'kind': 'detour', 'leg': k, 'start': i, 'lon': p[0], 'lat': p[1], 'max': d, 'm0': m}
                run['max'] = max(run['max'], d); run['m1'] = m
            elif run is not None:
                run['end'] = i
                out.append(_finish(g, guide, run, pts, leg))
                run = None
        if run is not None:
            run['end'] = len(pts) - 1
            out.append(_finish(g, guide, run, pts, leg))
    # Shape stretches no routed path comes near: roads the map hasn't got (or won't let a bus on).
    routed = Polyline([p for l in legs for p in l['geometry']]) if any(l['ok'] for l in legs) else None
    if routed and routed.length:
        step, gap = 15.0, None
        n = int(guide.length / step) + 1
        for i in range(n + 1):
            m = min(i * step, guide.length)
            p = guide.slice(m, m + 0.01)
            far = i < n and p and routed.nearest(p[0])[0] > DIVERGE
            if far and gap is None:
                gap = [m, m]
            elif far:
                gap[1] = m
            elif gap is not None:
                if gap[1] - gap[0] >= 40:
                    mid = guide.slice((gap[0] + gap[1]) / 2, (gap[0] + gap[1]) / 2 + 0.01)[0]
                    why, ways = _explain_gap(g, guide, gap)
                    if not any(o['kind'] != 'no-path' and abs(o.get('m0', -1e9) - gap[0]) < 60 for o in out):
                        out.append({'kind': 'uncovered', 'lon': mid[0], 'lat': mid[1], 'length': round(gap[1] - gap[0]), 'why': why, 'ways': ways,
                                    'shape': guide.slice(gap[0], gap[1]), 'm0': gap[0]})
                gap = None
    out.sort(key=lambda d: -d['length'])
    return out


def _finish(g, guide, run, pts, leg):
    seg = pts[run['start']:run['end'] + 1]
    L = sum(metres(seg[i], seg[i + 1]) for i in range(len(seg) - 1))
    m0, m1 = sorted((run['m0'], run.get('m1', run['m0'])))
    why, ways = _explain_gap(g, guide, (m0, m1))
    return {'kind': 'detour', 'leg': leg['from'], 'lon': run['lon'], 'lat': run['lat'], 'length': round(L), 'max': round(run['max']),
            'why': why, 'ways': ways, 'path': seg, 'shape': guide.slice(m0, m1), 'm0': m0}


def _explain_gap(g, guide, gap):
    """Look under the stretch of shape the bus didn't follow: what is there?"""
    m0, m1 = gap
    samples = [guide.slice(m, m + 0.01)[0] for m in [m0 + (m1 - m0) * f for f in (0.25, 0.5, 0.75)] if guide.slice(m, m + 0.01)]
    drivable, blocked = {}, {}
    for p in samples:
        for w, d in g.nearby_ways(p, 25).items():
            drivable[w] = min(d, drivable.get(w, 99))
        for w, (d, why) in g.blocked_near(p, 25).items():
            blocked[w] = why
    if blocked and not drivable:
        w, why = next(iter(blocked.items()))
        return f'the line follows way {w} which a bus may not use ({why})', list(blocked)
    if drivable:
        # Roads are there but the router avoided them: oneway against the line, or they don't join up.
        ows = [w for w in drivable if bus_may(g.ways[w].get('tags', {})) not in (None, (True, True))]
        if ows:
            return f'roads are mapped here but one-way; check oneway=* against the line\'s direction', list(drivable)
        return 'roads are mapped here but the router didn\'t connect through them: a missing junction node or a gap between ways?', list(drivable)
    if blocked:
        w, why = next(iter(blocked.items()))
        return f'only way {w} is here and a bus may not use it ({why})', list(blocked)
    return 'no road here in OpenStreetMap: missing, or the agency\'s line is drawn off the street', []
