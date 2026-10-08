"""Where a bus can drive on OpenStreetMap's roads, and how that compares with the line the agency drew.

    g = Graph(osm_roads_json)
    r = trace(g, stops_lonlat, shape_lonlat)   # -> ways in order, legs, divergences, scores

The trace is a shortest path between consecutive stops over roads a bus may use (oneway, access and
bus/psv exceptions honoured), with a cost for straying from the GTFS shape. So it follows the drawn
line wherever the map allows, and leaves it only where the map does not: a road that is missing, cut,
one-way the wrong way, or closed to buses. Those places are the divergences, each with a guess at why.
"""
import bisect, heapq, math

# How much a bus would rather not: cost multipliers by highway class.
PREFER = {'motorway': 1.0, 'trunk': 1.0, 'primary': 1.0, 'secondary': 1.0, 'tertiary': 1.05, 'unclassified': 1.15,
          'residential': 1.2, 'living_street': 1.6, 'busway': 0.9, 'road': 1.3, 'service': 1.8,
          'motorway_link': 1.0, 'trunk_link': 1.0, 'primary_link': 1.0, 'secondary_link': 1.0, 'tertiary_link': 1.05}
SERVICE_PENALTY = {'driveway': 3.0, 'parking_aisle': 2.2, 'alley': 2.5, 'emergency_access': 6.0}
STRAY = 20       # m from the shape a road may be for free
STRAY_COST = 0.2   # extra cost per metre of road, per metre beyond STRAY: 50 m off costs 7x, so the bus rounds a block
                 # to stay on the line rather than cut through, but still leaves it when the map gives no choice
SKIP_SLACK = 25  # m: how far the path may get ahead of (or behind) the distance it has driven along the line
SKIP_COST = 3.0  # cost per metre of line skipped or driven backwards: more than driving it on a service road (1.8),
                 # so a loop whose end passes its own start can't cut across to it
SNAP = 60        # m: a stop further than this from any road is placed on no road at all
SNAP_HANDICAP = {'parking_aisle': 15, 'driveway': 15, 'drive-through': 15}   # m: a stop by the kerb is on the street,
                 # not on the parking aisle that happens to run a few metres closer to its sign
EXCLUDED = 'excluded by you'   # why a way the reviewer ruled out is blocked
SNAP_CROSS = 12  # m: a stop at a corner belongs to the street the line runs along, not the one crossing it
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
        # each segment as project() takes it, and its bounding box with the least a degree of longitude can be
        # along it in metres: so a segment that can't be nearer than the nearest yet is passed over unmeasured
        self.seg, self.box = [], []
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            self.cum.append(self.cum[-1] + metres(a, b))
            for ci in range(int(min(a[1], b[1]) / cell) - 1, int(max(a[1], b[1]) / cell) + 2):
                for cj in range(int(min(a[0], b[0]) / cell) - 1, int(max(a[0], b[0]) / cell) + 2):
                    self.grid.setdefault((ci, cj), []).append(i)
            kx = 111320 * math.cos(math.radians(a[1]))
            dx, dy = (b[0] - a[0]) * kx, (b[1] - a[1]) * 110540
            self.seg.append((a[0], a[1], b[0], b[1], kx, dx, dy, dx * dx + dy * dy))
            self.box.append((min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1]),
                             math.cos(math.radians(min(90.0, max(abs(a[1]), abs(b[1])))))))
        self.length = self.cum[-1]
        self.fine = cell / 8
        self.order = {}   # fine cell -> (its cell's segments nearest-first by how near they can be, up to KEEP; more?): made when asked
        self.span = self.cmin = None   # (the grid's extent, the narrowest degree of longitude: for _wide)

    KEEP = 48   # of a fine cell's segments, the nearest kept: what's further is rarely asked for (and then worked out again)

    def _all(self, p):
        """[(bound, segment)] for p's cell's segments, by how near they can be to anywhere in p's fine cell (empty
        if p's cell has none)."""
        f = self.fine
        fi, fj = int(p[1] / f), int(p[0] / f)
        cands = self.grid.get((int(p[1] / self.cell), int(p[0] / self.cell)))
        if not cands:
            return []
        # every point that int() puts in fine cell (fi, fj) is within a fine cell of its corner either way
        x0, x1, y0, y1 = (fj - 1) * f, (fj + 1) * f, (fi - 1) * f, (fi + 1) * f
        c = math.cos(math.radians(min(90.0, max(abs(y0), abs(y1)))))
        # the least distance each segment can be from there (a little under, for floating point)
        box = self.box
        return sorted((max(max(sy0 - y1, y0 - sy1, 0.0) * 110540, max(sx0 - x1, x0 - sx1, 0.0) * 111320 * (cs if cs < c else c)) * (1 - 1e-9) - 1e-6, i)
                      for i in cands for sx0, sx1, sy0, sy1, cs in (box[i],))

    def _sorted(self, p):
        """_all(p), nearest-first, as it's needed: the first KEEP kept for the next point in this fine cell."""
        key = (int(p[1] / self.fine), int(p[0] / self.fine))
        got = self.order.get(key)
        if got is None:
            lst = self._all(p)
            got = self.order[key] = (lst[:self.KEEP], len(lst) > self.KEEP)
        yield from got[0]
        if got[1]:
            yield from self._all(p)[self.KEEP:]

    def _empty(self, p):
        """Does p's cell hold no segment?"""
        return not self.grid.get((int(p[1] / self.cell), int(p[0] / self.cell)))

    def _measure(self, px, py, i):
        """(distance m, fraction along) from (px, py) to segment i, exactly as project() and metres() work it out."""
        ax, ay, bx, by, kx, dx, dy, den = self.seg[i]
        if dx == 0 and dy == 0:
            return math.hypot((ax - px) * 111320 * math.cos(math.radians((py + ay) / 2)), (ay - py) * 110540), 0.0
        t = max(0.0, min(1.0, ((px - ax) * kx * dx + (py - ay) * 110540 * dy) / den))
        qx, qy = ax + (bx - ax) * t, ay + (by - ay) * t
        return math.hypot((qx - px) * 111320 * math.cos(math.radians((py + qy) / 2)), (qy - py) * 110540), t

    def nearest(self, p, lo=None, hi=None):
        """(distance m, segment index, position along in m) of the nearest segment, optionally within [lo, hi]."""
        bd, bi, bt = float('inf'), -1, 0.0
        px, py = p
        # the nearest of p's cell's segments (the lowest index of those as near): nearest-first, until the rest
        # can't be as near
        for lb, i in self._sorted(p):
            if lb > bd:
                break
            if lo is not None and (i < lo or i > hi):
                continue
            d, t = self._measure(px, py, i)
            if d < bd or (d == bd and i < bi):
                bd, bi, bt = d, i, t
        if bi < 0 and lo is None:  # nothing in this cell: search wider, ring by ring of cells around it
            return self._wide(px, py)
        if bi < 0:  # nothing of [lo, hi] in this cell: search all of it (the caller is usually near the line)
            cp = math.cos(math.radians(min(90.0, abs(py))))
            for i in range(lo, hi + 1):
                if self._far(px, py, i, bd, cp):
                    continue
                d, t = self._measure(px, py, i)
                if d < bd:
                    bd, bi, bt = d, i, t
        if bi < 0:
            return (bd, bi, 0.0)
        return (bd, bi, self.cum[bi] + bt * (self.cum[bi + 1] - self.cum[bi]))

    def _wide(self, px, py):
        """nearest() for a point whose cell holds no segment: the cells around it ring by ring, each segment
        measured once, until the rings left can't hold one as near (a segment is in every cell within a cell of
        its box, so one in no cell R rings out or less is more than R cells away); every segment, if that's
        quicker. The same answer as measuring them all."""
        if not self.seg:
            return (float('inf'), -1, 0.0)
        if self.span is None:
            self._extent()
        ci, cj = int(py / self.cell), int(px / self.cell)
        cp = math.cos(math.radians(min(90.0, abs(py))))
        step = self.cell * min(110540, 111320 * min(cp, self.cmin)) * (1 - 1e-9)
        i0, i1, j0, j1 = self.span
        last = max(ci - i0, i1 - ci, cj - j0, j1 - cj)
        bd, bi, bt = float('inf'), -1, 0.0
        seen, cells = set(), 0
        for R in range(1, last + 1):
            if bd < R * step - 1e-6 - step:   # (after ring R - 1: what's left is more than R - 1 cells away)
                break
            cells += 8 * R
            if cells > 2 * len(self.seg) + 64:   # far from it all: measuring every segment is quicker
                seen = None
                break
            for di in range(-R, R + 1):
                for dj in ((-R, R) if abs(di) < R else range(-R, R + 1)):
                    for i in self.grid.get((ci + di, cj + dj), ()):
                        if i in seen:
                            continue
                        seen.add(i)
                        if self._far(px, py, i, bd, cp):
                            continue
                        d, t = self._measure(px, py, i)
                        if d < bd or (d == bd and i < bi):
                            bd, bi, bt = d, i, t
        if seen is None:
            bd, bi, bt = float('inf'), -1, 0.0
            for i in range(len(self.seg)):
                if self._far(px, py, i, bd, cp):
                    continue
                d, t = self._measure(px, py, i)
                if d < bd:
                    bd, bi, bt = d, i, t
        if bi < 0:
            return (bd, bi, 0.0)
        return (bd, bi, self.cum[bi] + bt * (self.cum[bi + 1] - self.cum[bi]))

    def near(self, p, r):
        """nearest(p)[0] <= r, without finding the nearest: a segment within r will do, and none further than
        r is measured."""
        px, py = p
        if not self._empty(p):   # (as nearest(): the nearest of p's cell's segments)
            for lb, i in self._sorted(p):
                if lb > r:
                    return False
                if self._measure(px, py, i)[0] <= r:
                    return True
            return False
        if not self.seg:
            return False
        # else every segment's: but only one in a cell within r (and a cell) of p's can be within r
        if self.span is None:
            self._extent()
        ci, cj = int(py / self.cell), int(px / self.cell)
        cp = math.cos(math.radians(min(90.0, abs(py))))
        step = self.cell * min(110540, 111320 * min(cp, self.cmin)) * (1 - 1e-9)
        if step <= 0:
            return self.nearest(p)[0] <= r
        seen = set()
        for R in range(1, min(int(r / step) + 2, max(abs(ci - self.span[0]), abs(self.span[1] - ci), abs(cj - self.span[2]), abs(self.span[3] - cj))) + 1):
            for di in range(-R, R + 1):
                for dj in ((-R, R) if abs(di) < R else range(-R, R + 1)):
                    for i in self.grid.get((ci + di, cj + dj), ()):
                        if i not in seen:
                            seen.add(i)
                            if not self._far(px, py, i, r, cp) and self._measure(px, py, i)[0] <= r:
                                return True
        return False

    def _extent(self):
        ks = list(self.grid)
        self.span = (min(k[0] for k in ks), max(k[0] for k in ks), min(k[1] for k in ks), max(k[1] for k in ks))
        self.cmin = min(b[4] for b in self.box)

    def _far(self, px, py, i, bd, cp):
        """Is segment i surely further than bd metres from (px, py) (cp: the cosine of py), by its box?"""
        sx0, sx1, sy0, sy1, cs = self.box[i]
        lim = bd * (1 + 1e-9) + 1e-6
        return ((sy0 - py if py < sy0 else py - sy1 if py > sy1 else 0.0) * 110540 > lim or
                (sx0 - px if px < sx0 else px - sx1 if px > sx1 else 0.0) * 111320 * min(cs, cp) > lim)

    def positions(self, p, r, lo=None, hi=None):
        """Every place the line passes within r metres of p: [position along in m], one per pass."""
        hits = []
        px, py = p
        for lb, i in self._sorted(p):
            if lb > r:
                break
            if lo is not None and (i < lo or i > hi):
                continue
            d, t = self._measure(px, py, i)
            if d <= r:
                hits.append((i, d, self.cum[i] + t * (self.cum[i + 1] - self.cum[i])))
        # consecutive segments near p are one pass; keep the nearest point of each
        out, last = [], None
        for i, d, m in sorted(hits):
            if last is not None and i == last[0] + 1:
                if d < last[1]:
                    out[-1] = m
                last = (i, min(d, last[1]))
            else:
                out.append(m); last = (i, d)
        return out

    def slice(self, m0, m1):
        """Points along the line between two distances in metres."""
        out = []
        # the segments ending before m0 and those starting after m1: the cumulative lengths are in order
        for i in range(max(0, bisect.bisect_left(self.cum, m0, 1) - 1), len(self.pts) - 1):
            if self.cum[i] > m1:
                break
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


def restrictions(raw):
    """Turn restrictions a bus is held to: -> ({(from way, via node, to way)}, {(from way, via node): {to ways}}).
    restriction:bus (or :psv) wins over restriction; one with except=bus/psv doesn't apply. Only a node as via:
    a way as via (a U-turn across a dual carriageway) is rare and left out."""
    no, only = set(), {}
    for el in raw.get('elements', []):
        t = el.get('tags', {})
        if el['type'] != 'relation' or t.get('type') != 'restriction':
            continue
        if {'bus', 'psv'} & {x.strip() for x in t.get('except', '').split(';')}:
            continue
        kind = t.get('restriction:bus') or t.get('restriction:psv') or t.get('restriction', '')
        frm = [m['ref'] for m in el.get('members', []) if m['role'] == 'from' and m['type'] == 'way']
        via = [m['ref'] for m in el.get('members', []) if m['role'] == 'via']
        vtype = [m['type'] for m in el.get('members', []) if m['role'] == 'via']
        to = [m['ref'] for m in el.get('members', []) if m['role'] == 'to' and m['type'] == 'way']
        if len(frm) != 1 or len(via) != 1 or vtype != ['node'] or not to:
            continue
        if kind.startswith('no_'):
            for w in to:
                no.add((frm[0], via[0], w))
        elif kind.startswith('only_'):
            only.setdefault((frm[0], via[0]), set()).update(to)
    return no, only


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
        self.no_turn, self.only_turn = restrictions(raw)   # {(from way, via node, to way)}, {(from way, via node): {to ways}}
        self.blocked = {}      # way -> reason a bus can't use it (for explaining a divergence)
        self.cell = 0.002
        self.sgrid = {}        # grid cell -> [(way, i, a, b)] the drivable segments in it, for snapping
        for wid, w in self.ways.items():
            self._add(wid, w)

    def _add(self, wid, w):
        t = w.get('tags', {})
        may = bus_may(t)
        if may is None:
            self.blocked[wid] = self._why_blocked(t)
            return
        f = PREFER[t['highway']] * SERVICE_PENALTY.get(t.get('service', ''), 1.0)
        nodes = [n for n in w['nodes'] if n in self.coord]
        for i in range(len(nodes) - 1):
            a, b = nodes[i], nodes[i + 1]
            L = metres(self.coord[a], self.coord[b])
            if may[0]:
                self.adj.setdefault(a, []).append((b, wid, f, L))
            if may[1]:
                self.adj.setdefault(b, []).append((a, wid, f, L))
            for cell in self._cells(a, b):
                self.sgrid.setdefault(cell, []).append((wid, i, a, b))

    def _cells(self, a, b):
        a, b, c = self.coord[a], self.coord[b], self.cell
        return [(ci, cj) for ci in range(int(min(a[1], b[1]) / c), int(max(a[1], b[1]) / c) + 1)
                for cj in range(int(min(a[0], b[0]) / c), int(max(a[0], b[0]) / c) + 1)]

    def patched(self, ways=None, nodes=None, avoid=()):
        """A copy with some ways replaced or added and some nodes placed (edits not yet uploaded), sharing
        everything else: what the bus could do once those edits are made. ways: {id: {'nodes', 'tags'}};
        nodes: {id: (lon, lat)}. Ways absent from both stay as they are.
        avoid: ways the reviewer has ruled out ("the bus doesn't use this road"): kept on the map, but a bus
        may not drive them, and a divergence over one says so (blocked, EXCLUDED)."""
        ways, nodes, avoid = ways or {}, nodes or {}, set(avoid or ())
        g = Graph.__new__(Graph)
        g.cell = self.cell
        g.no_turn, g.only_turn = self.no_turn, self.only_turn
        g.coord = {**self.coord, **nodes}
        g.ways = dict(self.ways)
        g.blocked = dict(self.blocked)
        drop = set(ways) | avoid
        touched = set()
        for wid in drop:
            old = self.ways.get(wid)
            if old:
                touched |= set(old['nodes'])
        g.adj = {n: [e for e in self.adj[n] if e[1] not in drop] if n in touched else self.adj[n] for n in self.adj}
        g.sgrid = dict(self.sgrid)
        for wid in drop:
            old = self.ways.get(wid)
            if old:
                ns = [n for n in old['nodes'] if n in self.coord]
                for i in range(len(ns) - 1):
                    for cell in self._cells(ns[i], ns[i + 1]):
                        if cell in g.sgrid:
                            g.sgrid[cell] = [s for s in g.sgrid[cell] if s[0] != wid]
            g.blocked.pop(wid, None)
        for wid, w in ways.items():
            g.ways[wid] = {'id': wid, 'nodes': w['nodes'], 'tags': w.get('tags', {})}
            if wid in avoid:
                continue
            # _add appends: give it fresh lists where it will write, so this graph's changes stay its own
            for n in w['nodes']:
                if n in g.adj and g.adj[n] is self.adj.get(n):
                    g.adj[n] = list(g.adj[n])
            ns = [n for n in w['nodes'] if n in g.coord]
            for i in range(len(ns) - 1):
                for cell in g._cells(ns[i], ns[i + 1]):
                    if cell in g.sgrid and g.sgrid[cell] is self.sgrid.get(cell):
                        g.sgrid[cell] = list(g.sgrid[cell])
            g._add(wid, g.ways[wid])
        for wid in avoid:
            if wid in g.ways:
                g.blocked[wid] = EXCLUDED
        return g

    @staticmethod
    def _why_blocked(t):
        hw = t.get('highway', '?')
        if hw not in PREFER:
            return f'highway={hw}'
        for k in ('access', 'motor_vehicle', 'vehicle', 'bus', 'psv'):
            if t.get(k) in ('no', 'private'):
                return f'{k}={t[k]}'
        return 'not drivable'

    def snap(self, p, r=SNAP, along=None):
        """Nearest drivable segment to a point: (dist, way, node a, node b, fraction along) or None.
        along: the agency line's direction at the stop, as two points; segments across it count as further off."""
        kx = 111320 * math.cos(math.radians(p[1]))
        ux = uy = None
        if along:
            ux, uy = (along[1][0] - along[0][0]) * kx, (along[1][1] - along[0][1]) * 110540
            n = math.hypot(ux, uy)
            ux, uy = (ux / n, uy / n) if n > 5 else (None, None)
        ci, cj = int(p[1] / self.cell), int(p[0] / self.cell)
        best = None
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for wid, k, a, b in self.sgrid.get((i, j), []):
                    _, d, t = project(p, self.coord[a], self.coord[b])
                    if d > r:
                        continue
                    e = d + SNAP_HANDICAP.get(self.ways[wid].get('tags', {}).get('service', ''), 0)
                    if ux is not None:
                        (ax, ay), (bx, by) = self.coord[a], self.coord[b]
                        sx, sy = (bx - ax) * kx, (by - ay) * 110540
                        L = math.hypot(sx, sy)
                        if L:
                            e += SNAP_CROSS * abs(ux * sy - uy * sx) / L   # |sin| of the angle between them
                    if best is None or e < best[0]:
                        best = (e, wid, a, b, t, d)
        return best and (best[5], *best[1:5])

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

    def astar(self, starts, goals, guide=None, lo=None, hi=None, limit=250000, start_at=None, end_at=None, no_first=None, no_last=None):
        """Cheapest path from any start to any goal.
        starts/goals: {node: initial cost}. guide: Polyline the path should hug (with segment range lo..hi).
        start_at, end_at: where along the guide (m) the path starts and ends; with them, the path also pays for
        getting ahead of or behind the line, not only for being far from it, and arriving pays for the line
        it never drove.
        no_first, no_last: {node: node} — a start may not set off to that node, a goal may not be reached from
        it: the stop's own stretch of road, so the path doesn't drive back through the stop it starts at, or
        past the stop it ends at and back.
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

        passes = {}

        def progress(q0, m, L):
            """-> (position along the line at m, cost of the jump from q0, the position one step back). Of the
            line's passes by m, the one that follows on; a path cutting across a loop lands far ahead of what it drove."""
            if q0 is None:
                return None, 0.0
            if m not in passes:
                passes[m] = guide.positions(self.coord[m], STRAY + 10, lo, hi)
            if not passes[m]:
                return q0 + L, 0.0
            want = q0 + L
            q = min(passes[m], key=lambda x: abs(x - want))
            ahead = q - q0
            return q, (max(0.0, ahead - L * 1.5 - SKIP_SLACK) + max(0.0, -ahead - SKIP_SLACK)) * SKIP_COST

        # A search state is a node *and* how far along the line the path is there (in BAND-metre steps):
        # the same corner reached by cutting across a loop and by driving it are different states, or the
        # cheap-looking shortcut would claim the node first and the path that follows the line never arrive.
        BAND = 40
        band = lambda q: None if q is None else int(q // BAND)
        dist, prev, pw, at = {}, {}, {}, {}
        pq = []
        for s, c in starts.items():
            q = start_at if guide is not None else None
            st = (s, band(q))
            dist[st] = c; at[st] = q
            heapq.heappush(pq, (c + h(s), c, st, False))
        seen = 0
        while pq:
            f, c, st, arrived = heapq.heappop(pq)
            if arrived:
                path, ways = [st[0]], []
                while st in prev:
                    ways.append(pw[st]); st = prev[st]; path.append(st[0])
                return c, path[::-1], ways[::-1]
            if c > dist.get(st, float('inf')):
                continue
            n = st[0]
            if n in goals and not (no_last and st in prev and prev[st][0] == no_last.get(n)):
                # Arriving costs the goal's own offset, and the line between here and the stop left undriven.
                short = max(0.0, end_at - at[st] - SKIP_SLACK) * SKIP_COST if end_at is not None and at[st] is not None else 0.0
                heapq.heappush(pq, (c + goals[n] + short, c + goals[n] + short, st, True))
            seen += 1
            if seen > limit:
                return None
            back = prev[st][0] if st in prev else (no_first or {}).get(n)
            came = pw.get(st)   # the way the path arrived on: a turn restriction is from it, at n, to the next
            only = self.only_turn.get((came, n)) if came is not None else None
            for m, wid, fac, L in self.adj.get(n, []):
                if m == back:
                    continue   # no U-turn in the street: revisiting a node is allowed now, so say so
                if came is not None and ((came, n, wid) in self.no_turn or (only and wid not in only)):
                    continue   # a turn the signs forbid
                q, jump = progress(at[st], m, L)
                nc = c + L * (fac + stray_cost(m)) + jump
                mt = (m, band(q))
                if nc < dist.get(mt, float('inf')):
                    dist[mt] = nc; prev[mt] = st; pw[mt] = wid; at[mt] = q
                    heapq.heappush(pq, (nc + h(m), nc, mt, False))
        return None


def trace(g, stops, shape, pins=None):
    """Route a pattern over the graph.
    stops: [(lon, lat), ...] in order.  shape: [(lon, lat), ...] or None.
    pins: per stop, None (snap it to the nearest road) or (way, node a, node b, fraction): the road it is on, said
    outright (a required way's points: a cross street at its junction must not take them).
    -> dict(legs, ways, geometry, divergences, score)"""
    guide = Polyline(shape) if shape and len(shape) > 1 else None
    # Where each stop sits along the shape, so each leg only hugs its own part of the line.
    at = []
    if guide:
        prev_seg = 0
        for k, p in enumerate(stops):
            d, i, m = guide.nearest(p)
            # A loop passes the same place twice (the terminal is the first stop again): the stop is
            # wherever on the line it is nearest *after* the previous stop, if that is nearly as close.
            if k and i < prev_seg:
                d2, i2, m2 = guide.nearest(p, lo=prev_seg, hi=len(guide.pts) - 2)
                if d2 <= d + 30:
                    i, m = i2, m2
            at.append((i, m)); prev_seg = max(prev_seg, i)
    # Snap each stop onto the street the line runs along there (30 m of line around the stop).
    def along(k):
        sl = guide.slice(at[k][1] - 15, at[k][1] + 15) if guide else []
        return (sl[0], sl[-1]) if len(sl) > 1 else None
    snaps = [(0.0, *pins[k]) if pins and pins[k] else g.snap(p, along=along(k)) for k, p in enumerate(stops)]
    # from the stop to the stop: the points on the road where they are, not the ends of their stretches
    on = lambda sn: (g.coord[sn[2]][0] + (g.coord[sn[3]][0] - g.coord[sn[2]][0]) * sn[4], g.coord[sn[2]][1] + (g.coord[sn[3]][1] - g.coord[sn[2]][1]) * sn[4])
    legs, all_ways, geom, divs = [], [], [], []
    for k in range(len(stops) - 1):
        s0, s1 = snaps[k], snaps[k + 1]
        leg = {'from': k, 'to': k + 1, 'ok': False, 'ways': [], 'geometry': [], 'why': ''}
        if s0 is None or s1 is None:
            leg['why'] = f'stop {k if s0 is None else k + 1} is more than {SNAP} m from any road a bus can use'
            legs.append(leg)
            continue
        adj_has = lambda n, m, w: (m, w) in {(x, y) for (x, y, _, _) in g.adj.get(n, [])}
        # Both on one stretch of road, drivable from the first to the second: the leg is that stretch. (A search
        # would give a path of one node, saying nothing about which way it went.)
        if (s0[1], s0[2], s0[3]) == (s1[1], s1[2], s1[3]) and (adj_has(s0[2], s0[3], s0[1]) if s1[4] >= s0[4] else adj_has(s0[3], s0[2], s0[1])):
            leg['ok'] = True; leg['ways'] = [s0[1]]; leg['geometry'] = [on(s0), on(s1)]
            legs.append(leg)
            if not all_ways or all_ways[-1] != s0[1]:
                all_ways.append(s0[1])
            geom.extend(leg['geometry'])
            continue
        lo = hi = None
        if guide:
            lo, hi = min(at[k][0], at[k + 1][0]), max(at[k][0], at[k + 1][0])
            lo, hi = max(0, lo - 3), min(len(guide.pts) - 2, hi + 3)
        # Start from either end of the stop's segment, paying the distance along it; same for the goal. Every leg
        # sets off from its stop afresh: where the last leg's search ended says only where the stop's stretch
        # begins, not which way the bus faces, and a stretch the bus must drive end to end (a required way, its
        # two points on one segment) would otherwise be left from the end it came in by.
        La = metres(g.coord[s0[2]], g.coord[s0[3]])
        starts = {s0[3]: (1 - s0[4]) * La}
        if s0[2] in g.adj and adj_has(s0[3], s0[2], s0[1]):
            starts[s0[2]] = s0[4] * La   # two-way segment: may leave backwards too
        Lb = metres(g.coord[s1[2]], g.coord[s1[3]])
        goals = {s1[2]: s1[4] * Lb}
        if adj_has(s1[3], s1[2], s1[1]):
            goals[s1[3]] = (1 - s1[4]) * Lb
        # Keep the path off the stops' own stretches the wrong way: leaving the first stop, it may set off
        # from either end of its stretch but not back through the stop; arriving, not past the stop and back.
        same = {s0[2], s0[3]} == {s1[2], s1[3]}
        res = g.astar(starts, goals, guide, lo, hi, start_at=at[k][1] if guide else None, end_at=at[k + 1][1] if guide else None,
                      no_first=None if same else {s0[2]: s0[3], s0[3]: s0[2]}, no_last=None if same else {s1[2]: s1[3], s1[3]: s1[2]})
        if res is None:
            leg['why'] = 'no drivable path between these stops on the map'
            legs.append(leg)
            continue
        cost, path, ways = res
        leg['ok'] = True
        leg['ways'] = [s0[1]] + ways + [s1[1]] if ways else [s0[1], s1[1]] if s0[1] != s1[1] else [s0[1]]
        leg['ways'] = [w for i, w in enumerate(leg['ways']) if i == 0 or w != leg['ways'][i - 1]]
        pts = [g.coord[n] for n in path]
        if len(path) > 1 and {path[0], path[1]} == {s0[2], s0[3]}:
            pts = pts[1:]          # it stood before the stop and drove through it: the leg starts at the stop
        leg['geometry'] = [on(s0)] + pts + [on(s1)]
        legs.append(leg)
        for w in leg['ways']:
            if not all_ways or all_ways[-1] != w:
                all_ways.append(w)
        geom.extend(leg['geometry'])
    if guide:
        divs = divergences(g, guide, legs, stops, at)
    score = coverage(guide, geom) if guide else None
    return {'legs': legs, 'ways': all_ways, 'geometry': geom, 'divergences': divs, 'score': score}


def fold_vias(g, stops, vias=(), require=()):
    """The stops with the reviewer's say folded in, as more points to route through. Each via point ("go through
    here") goes between the two consecutive points whose leg it is nearest. Each required way ("the bus uses this
    road") becomes two points a few metres in from either end, pinned to the way (not to a cross street at its
    junction), the way's own direction if it is one-way, else the end nearer the point before them first, so the
    path drives the way, that way round.
    -> ([(lon, lat)], pins) for trace()"""
    pts = [tuple(p) for p in stops]
    order = list(range(len(pts)))
    pin = {}

    def nearest_leg(p):
        best, bi = None, 0
        for i in range(len(order) - 1):
            _, d, _ = project(p, pts[order[i]], pts[order[i + 1]])
            if best is None or d < best:
                best, bi = d, i
        return best, bi
    for v in vias:
        _, bi = nearest_leg(v)
        pts.append(tuple(v)); order.insert(bi + 1, len(pts) - 1)
    for wid in require:
        w = g.ways.get(wid)
        nodes = [n for n in (w['nodes'] if w else []) if n in g.coord]
        if len(nodes) < 2:
            continue
        # a point on the first segment and one on the last, a few metres in from the way's ends
        def inside(a, b, from_a):
            A, B = g.coord[a], g.coord[b]
            L = metres(A, B)
            if not L:
                return None
            t = min(3.0, L / 3) / L
            t = t if from_a else 1 - t
            return ((A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t), (wid, a, b, t))
        p0, p1 = inside(nodes[0], nodes[1], True), inside(nodes[-2], nodes[-1], False)
        if p0 is None or p1 is None:
            continue
        da, ia = nearest_leg(p0[0]); db, ib = nearest_leg(p1[0])
        bi = ia if da is None or da <= db else ib
        may = bus_may(w.get('tags', {})) or (True, True)
        first = may[0] if may[0] != may[1] else metres(p0[0], pts[order[bi]]) <= metres(p1[0], pts[order[bi]])
        for q, s in ((p0, p1) if first else (p1, p0)):
            pts.append(q); pin[len(pts) - 1] = s
        order[bi + 1:bi + 1] = [len(pts) - 2, len(pts) - 1]
    return [pts[i] for i in order], [pin.get(i) for i in order]


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
        if p and routed.near(p[0], DIVERGE):
            on += 1
    m = int(routed.length / step) + 1
    on2 = 0
    for i in range(m):
        p = routed.slice(i * step, i * step + 0.01)
        if p and guide.near(p[0], DIVERGE):
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
            far = i < n and p and not routed.near(p[0], DIVERGE)
            if far and gap is None:
                gap = [m, m]
            elif far:
                gap[1] = m
            elif gap is not None:
                if gap[1] - gap[0] >= 40:
                    mid = guide.slice((gap[0] + gap[1]) / 2, (gap[0] + gap[1]) / 2 + 0.01)[0]
                    why, ways, fix = _explain_gap(g, guide, gap)
                    if not any(o['kind'] != 'no-path' and abs(o.get('m0', -1e9) - gap[0]) < 60 for o in out):
                        out.append({'kind': 'uncovered', 'lon': mid[0], 'lat': mid[1], 'length': round(gap[1] - gap[0]), 'why': why, 'ways': ways, 'fix': fix,
                                    'shape': guide.slice(gap[0], gap[1]), 'm0': gap[0]})
                gap = None
    out.sort(key=lambda d: -d['length'])
    return out


def _finish(g, guide, run, pts, leg):
    seg = pts[run['start']:run['end'] + 1]
    L = sum(metres(seg[i], seg[i + 1]) for i in range(len(seg) - 1))
    m0, m1 = sorted((run['m0'], run.get('m1', run['m0'])))
    why, ways, fix = _explain_gap(g, guide, (m0, m1))
    return {'kind': 'detour', 'leg': leg['from'], 'lon': run['lon'], 'lat': run['lat'], 'length': round(L), 'max': round(run['max']),
            'why': why, 'ways': ways, 'fix': fix, 'path': seg, 'shape': guide.slice(m0, m1), 'm0': m0}


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
    yours = [w for w, why in blocked.items() if why == EXCLUDED]
    if yours:
        return f"the line follows way {yours[0]}, {EXCLUDED}: the bus doesn't use it", yours + [x for x in drivable if x not in yours], None
    if blocked and not drivable:
        w, why = next(iter(blocked.items()))
        return f'the line follows way {w} which a bus may not use ({why})', list(blocked), None
    if drivable:
        # Roads are there but the router avoided them: one-way against the line, or they don't join up.
        against = _against(g, guide, samples, gap, drivable)
        if against:
            w, d, wdir, ldir = against
            t = g.ways[w].get('tags', {})
            name = t.get('name') or t.get('highway', 'road')
            return (f"a bus can't drive {ldir} here: {name} (way {w}) is one-way {wdir}, against the agency's line. "
                    f"Wrong direction on the map, or does the bus really go another way?"), [w] + [x for x in drivable if x != w], \
                {'kind': 'reverse', 'way': w, 'name': name, 'now': f'one-way {wdir}', 'want': f'one-way {ldir}'}
        ows = [w for w in drivable if bus_may(g.ways[w].get('tags', {})) not in (None, (True, True))]
        if ows:
            return f'roads are mapped here but one-way; check oneway=* against the line\'s direction', list(drivable), None
        return 'roads are mapped here but the router didn\'t connect through them: a missing junction node or a gap between ways?', list(drivable), None
    if blocked:
        w, why = next(iter(blocked.items()))
        return f'only way {w} is here and a bus may not use it ({why})', list(blocked), None
    return 'no road here in OpenStreetMap: missing, or the agency\'s line is drawn off the street', [], None


COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']


def _heading(a, b):
    """Compass word for going from a to b."""
    dx = (b[0] - a[0]) * math.cos(math.radians(a[1])); dy = b[1] - a[1]
    return COMPASS[round(((math.degrees(math.atan2(dx, dy)) + 360) % 360) / 45) % 8]


def _against(g, guide, samples, gap, drivable):
    """The one-way road that stops a bus following the line: at some point of the line, a road nearby lets
    traffic go only the other way and none nearby goes the line's way (a dual carriageway's other half
    doesn't count). -> (way, distance, its direction, the line's direction) or None"""
    m0, m1 = gap
    best = None
    near = set(drivable)
    for i in range(int((m1 - m0) / 10) + 1):
        m = m0 + i * 10
        line = guide.slice(m - 8, m + 8)
        if len(line) < 2:
            continue
        lv = ((line[-1][0] - line[0][0]) * math.cos(math.radians(line[0][1])), line[-1][1] - line[0][1])
        p = line[len(line) // 2]
        near |= set(g.nearby_ways(p, 25))
        with_line, against = False, []
        for w in near:
            may = bus_may(g.ways[w].get('tags', {}))
            if may is None:
                continue
            nodes = [n for n in g.ways[w]['nodes'] if n in g.coord]
            for j in range(len(nodes) - 1):
                a, b = g.coord[nodes[j]], g.coord[nodes[j + 1]]
                _, d, _ = project(p, a, b)
                if d > 20:
                    continue
                wv = ((b[0] - a[0]) * math.cos(math.radians(a[1])), b[1] - a[1])
                dot = wv[0] * lv[0] + wv[1] * lv[1]
                if abs(dot) < 0.5 * math.hypot(*wv) * math.hypot(*lv):
                    continue      # a cross street
                fwd = dot > 0
                if (fwd and may[0]) or (not fwd and may[1]):
                    with_line = True
                else:
                    against.append((w, d, _heading(*((b, a) if may[1] and not may[0] else (a, b))), _heading(line[0], line[-1])))
        if not with_line and against:
            c = min(against, key=lambda x: x[1])
            if best is None or c[1] < best[1]:
                best = c
    return best
