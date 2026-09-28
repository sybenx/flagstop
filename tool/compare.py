"""Which OpenStreetMap route relation is which GTFS pattern, and how far apart they've drifted.

A relation is paired with the pattern whose shape its ways cover best (ref agreeing where both have
one). Then, for the pair: stops the relation lacks or has extra, stops out of order, ways off the
shape, tags to add (the GTFS tagging scheme), and duplicates (two relations for one pattern).
"""
from routes import Polyline, DIVERGE, metres

MASTER_TAGS = ('ref', 'name', 'network', 'operator', 'colour')


def relation_geometry(rel, ways, coords):
    """The coordinates of a relation's way members, in member order (each way as drawn, not chained)."""
    out = []
    for m in rel['members']:
        if m['type'] == 'way' and m['role'] in ('', 'forward', 'backward') and m['ref'] in ways:
            pts = [coords[n] for n in ways[m['ref']]['nodes'] if n in coords]
            if pts:
                out.append((m['ref'], pts))
    return out


def relation_way_ids(rel):
    return [m['ref'] for m in rel['members'] if m['type'] == 'way' and m['role'] in ('', 'forward', 'backward')]


def relation_platforms(rel):
    """Member ids like 'n123' for platform/stop members, in order."""
    out = []
    for m in rel['members']:
        if m['role'].startswith(('platform', 'stop')):
            out.append(f"{m['type'][0]}{m['ref']}")
    return out


def cover(polyline, pieces, tol=DIVERGE, step=15.0):
    """(fraction of polyline within tol of the pieces, fraction of the pieces' length within tol of polyline)."""
    if not pieces or polyline.length == 0:
        return 0.0, 0.0
    flat = [p for _, pts in pieces for p in pts]
    pl = Polyline(flat)
    n = int(polyline.length / step) + 1
    on = sum(1 for i in range(n) if pl.nearest(polyline.slice(i * step, i * step + 0.01)[0])[0] <= tol)
    tot = hit = 0
    for _, pts in pieces:
        for i in range(len(pts) - 1):
            L = metres(pts[i], pts[i + 1]); tot += L
            mid = ((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)
            if polyline.nearest(mid)[0] <= tol:
                hit += L
    return on / n, (hit / tot if tot else 0.0)


def _ref_of(tags):
    return (tags.get('ref') or '').strip()


def pair(feed, patterns_traced, rels, ways, coords):
    """-> {pattern_id: [relation ids best-first]}, {relation id: pattern_id or None}, scores"""
    shapes = {p.id: Polyline(feed.shapes[p.shape_id]) for p in feed.patterns if p.shape_id in feed.shapes and len(feed.shapes[p.shape_id]) > 1}
    geoms = {rid: relation_geometry(r, ways, coords) for rid, r in rels.items()}
    scores = {}
    for rid, r in rels.items():
        for p in feed.patterns:
            if p.id not in shapes:
                continue
            route = feed.routes[p.route_id]
            ref = _ref_of(r['tags'])
            if ref and route.short and ref.split()[0] != route.short.split()[0]:
                continue  # 'ref' disagrees outright: not this route
            a, b = cover(shapes[p.id], geoms[rid])
            if a > 0.3:
                scores[(rid, p.id)] = (round(a, 3), round(b, 3))
    # Direction: which pattern's stop order the relation's platforms follow.
    best_for_pattern, chosen = {}, {}
    for (rid, pid), (a, b) in sorted(scores.items(), key=lambda kv: -(kv[1][0] + kv[1][1])):
        best_for_pattern.setdefault(pid, []).append(rid)
    for rid in rels:
        cands = [(pid, s) for (r, pid), s in scores.items() if r == rid]
        chosen[rid] = max(cands, key=lambda c: c[1][0] + c[1][1])[0] if cands else None
    return best_for_pattern, chosen, scores


def audit(feed, p, rel, ways, coords, stop_match, traced):
    """Everything about one relation that a reviewer should know, against its GTFS pattern."""
    t = rel['tags']
    route = feed.routes[p.route_id]
    issues = []
    # --- tags
    want = proposed_relation_tags(feed, p, stop_match)
    for k in ('type', 'route', 'ref', 'public_transport:version', 'network', 'operator', 'from', 'to', 'gtfs:route_id', 'gtfs:shape_id'):
        if k in want and t.get(k) != want[k]:
            issues.append({'kind': 'tag', 'key': k, 'osm': t.get(k, ''), 'gtfs': want[k]})
    # --- stops
    have = relation_platforms(rel)
    wanted = []
    for sid in p.stops:
        m = stop_match.get(sid)
        wanted.append(m['osm'][0]['id'] if m and m['status'] == 'matched' and m['osm'] else None)
    have_set = set(have)
    missing = [(i, sid) for i, (sid, oid) in enumerate(zip(p.stops, wanted)) if oid and oid not in have_set]
    unmatched = [(i, sid) for i, (sid, oid) in enumerate(zip(p.stops, wanted)) if not oid]
    extra = [oid for oid in have if oid not in set(w for w in wanted if w)]
    # Order: the relation's platforms that are wanted, in relation order, vs their pattern order.
    idx = {oid: i for i, oid in enumerate(wanted) if oid}
    seq = [idx[o] for o in have if o in idx]
    out_of_order = sum(1 for i in range(len(seq) - 1) if seq[i + 1] < seq[i])
    # --- ways
    shape = Polyline(feed.shapes[p.shape_id]) if p.shape_id in feed.shapes else None
    off_ways = []
    if shape:
        for wid, pts in relation_geometry(rel, ways, coords):
            L = sum(metres(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
            far = sum(metres(pts[i], pts[i + 1]) for i in range(len(pts) - 1)
                      if shape.nearest(((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2))[0] > DIVERGE)
            if L and far / L > 0.5:
                off_ways.append({'way': wid, 'length': round(far), 'lon': pts[len(pts) // 2][0], 'lat': pts[len(pts) // 2][1], 'name': ways[wid]['tags'].get('name', '')})
    rel_ways = relation_way_ids(rel)
    routed = traced['ways'] if traced else []
    missing_ways = [w for w in routed if w not in set(rel_ways)]
    a, b = cover(shape, relation_geometry(rel, ways, coords)) if shape else (0, 0)
    return {
        'id': rel['id'], 'name': t.get('name', ''), 'ref': t.get('ref', ''), 'tags': t, 'version': rel.get('version'), 'timestamp': rel.get('timestamp'), 'user': rel.get('user'),
        'cover': {'shape_covered': round(a, 3), 'ways_on_shape': round(b, 3)},
        'tag_issues': issues,
        'stops': {'in_relation': len(have), 'wanted': len([w for w in wanted if w]), 'missing': [{'i': i, 'stop': sid} for i, sid in missing],
                  'extra': extra, 'unmatched': [{'i': i, 'stop': sid} for i, sid in unmatched], 'out_of_order': out_of_order},
        'ways': {'in_relation': len(rel_ways), 'off_shape': off_ways, 'routed_not_in_relation': missing_ways, 'ids': rel_ways},
        'geometry': [pts for _, pts in relation_geometry(rel, ways, coords)],
    }


def proposed_relation_tags(feed, p, stop_match):
    route = feed.routes[p.route_id]
    agency = feed.agency.get('agency_name', '')
    first, last = feed.stops[p.stops[0]], feed.stops[p.stops[-1]]
    t = {'type': 'route', 'route': {'0': 'tram', '1': 'subway', '2': 'train', '3': 'bus', '11': 'trolleybus'}.get(route.type, 'bus'),
         'public_transport:version': '2', 'ref': route.short, 'operator': agency,
         'from': first.name, 'to': last.name,
         'gtfs:route_id': p.route_id, 'gtfs:shape_id': p.shape_id}
    name = f"{'Bus' if t['route'] == 'bus' else t['route'].title()} {route.short}"
    if p.headsign:
        name += f': {p.headsign}'
    elif p.direction_name:
        name += f': {p.direction_name}'
    elif route.long:
        name += f': {route.long}'
    t['name'] = name
    if route.color:
        t['colour'] = '#' + route.color.upper()
    if route.long and route.long != route.short:
        t['description'] = route.long + (f' — {route.desc}' if route.desc else '')
    if feed.info.get('feed_publisher_url') or feed.agency.get('agency_url'):
        pass
    return t


def proposed_master_tags(feed, route_id):
    route = feed.routes[route_id]
    t = {'type': 'route_master', 'route_master': 'bus', 'ref': route.short, 'name': f'Bus {route.short}' + (f': {route.long}' if route.long else ''),
         'operator': feed.agency.get('agency_name', ''), 'gtfs:route_id': route_id}
    if route.color:
        t['colour'] = '#' + route.color.upper()
    return t
