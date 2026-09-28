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


def pair(feed, patterns_traced, rels, ways, coords, stop_match):
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
                # Which way do the relation's ways run along this shape? Same direction counts for it.
                d = _direction_agreement(shapes[p.id], geoms[rid])
                # And do its platform members, in order, follow this pattern's stops?
                o = _order_agreement(p, r, stop_match)
                scores[(rid, p.id)] = (round(a, 3), round(b, 3), round(d, 2), round(o, 2))
    # Direction: which pattern's stop order the relation's platforms follow.
    total = lambda sc: sc[0] + sc[1] + 0.3 * sc[2] + 0.3 * sc[3]
    best_for_pattern, chosen = {}, {}
    for (rid, pid), sc in sorted(scores.items(), key=lambda kv: -total(kv[1])):
        best_for_pattern.setdefault(pid, []).append(rid)
    # A relation belongs to the pattern it covers best — and to a second pattern of the same route as well
    # when it covers that one nearly as fully: one relation drawn for both directions.
    for rid in rels:
        cands = sorted([(pid, s) for (r, pid), s in scores.items() if r == rid], key=lambda c: -total(c[1]))
        if not cands:
            chosen[rid] = []
            continue
        top = cands[0]
        both = [top[0]]
        for pid, sc in cands[1:]:
            # The same relation is also the other direction's when it covers that shape too, and either
            # runs both ways (no direction signal) or holds that direction's stops as members.
            if (sc[0] >= 0.85 and _route(feed, pid) == _route(feed, top[0]) and _direction(feed, pid) != _direction(feed, top[0])
                    and (abs(sc[2]) < 0.5 or sc[3] >= 0.5)):
                both.append(pid)
        chosen[rid] = both
    return best_for_pattern, chosen, scores


def _direction_agreement(shape, pieces):
    """-1..1: do the relation's member ways, taken in order, run from the shape's start to its end?"""
    if len(pieces) < 2:
        return 0.0
    pos = []
    for _, pts in pieces:
        mid = pts[len(pts) // 2]
        d, _, m = shape.nearest(mid)
        if d <= DIVERGE:
            pos.append(m)
    if len(pos) < 4:
        return 0.0
    up = sum(1 for i in range(len(pos) - 1) if pos[i + 1] > pos[i])
    down = sum(1 for i in range(len(pos) - 1) if pos[i + 1] < pos[i])
    return (up - down) / max(1, up + down)


def _order_agreement(p, rel, stop_match):
    """0..1: share of the relation's platform members that are this pattern's stops, in its order."""
    have = relation_platforms(rel)
    if not have:
        return 0.0
    idx = {}
    for i, sid in enumerate(p.stops):
        mm = stop_match.get(sid)
        if mm and mm['status'] == 'matched' and mm['osm']:
            idx[mm['osm'][0]['id']] = i
    seq = [idx[o] for o in have if o in idx]
    if not seq:
        return 0.0
    inorder = sum(1 for i in range(len(seq) - 1) if seq[i + 1] > seq[i])
    return (len(seq) / len(have)) * ((inorder + 1) / len(seq))


def _route(feed, pid):
    return next(p.route_id for p in feed.patterns if p.id == pid)


def _direction(feed, pid):
    return next(p.direction for p in feed.patterns if p.id == pid)


def chain_breaks(way_ids, ways):
    """Places where consecutive member ways don't touch. -> [(index, way a, way b)]"""
    out = []
    prev = None
    for i, w in enumerate(way_ids):
        nodes = ways.get(w, {}).get('nodes', [])
        if not nodes:
            prev = None
            continue
        ends = {nodes[0], nodes[-1]}
        if prev is not None and not (ends & prev['ends']) and not (set(nodes) & prev['ends']) and not (ends & prev['all']):
            out.append((i, prev['id'], w))
        prev = {'id': w, 'ends': ends, 'all': set(nodes)}
    return out


def audit(feed, p, rel, ways, coords, stop_match, traced, conv=None):
    """Everything about one relation that a reviewer should know, against its GTFS pattern."""
    t = rel['tags']
    route = feed.routes[p.route_id]
    issues = []
    # --- tags
    want = proposed_relation_tags(feed, p, stop_match, conv)
    # Structural tags must agree; free-text ones (name, from, to, operator, network) only need to exist.
    for k in ('type', 'route', 'ref', 'public_transport:version', 'gtfs:route_id', 'gtfs:shape_id'):
        if k in want and t.get(k) != want[k]:
            issues.append({'kind': 'tag', 'key': k, 'osm': t.get(k, ''), 'gtfs': want[k]})
    for k in ('network', 'operator', 'from', 'to', 'name'):
        if k in want and not t.get(k):
            issues.append({'kind': 'tag', 'key': k, 'osm': '', 'gtfs': want[k]})
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
    breaks = chain_breaks(rel_ways, ways)
    # Stops on the sibling pattern (the other direction) explain 'extra' members of a two-direction relation.
    sibling_stops = set()
    for q in feed.patterns:
        if q.route_id == p.route_id and q.id != p.id:
            for sid in q.stops:
                mm = stop_match.get(sid)
                if mm and mm['status'] == 'matched' and mm['osm']:
                    sibling_stops.add(mm['osm'][0]['id'])
    extra_other_dir = [oid for oid in extra if oid in sibling_stops]
    a, b = cover(shape, relation_geometry(rel, ways, coords)) if shape else (0, 0)
    return {
        'id': rel['id'], 'name': t.get('name', ''), 'ref': t.get('ref', ''), 'tags': t, 'version': rel.get('version'), 'timestamp': rel.get('timestamp'), 'user': rel.get('user'),
        'cover': {'shape_covered': round(a, 3), 'ways_on_shape': round(b, 3)},
        'tag_issues': issues,
        'stops': {'in_relation': len(have), 'wanted': len([w for w in wanted if w]), 'missing': [{'i': i, 'stop': sid} for i, sid in missing],
                  'extra': extra, 'extra_other_direction': extra_other_dir, 'unmatched': [{'i': i, 'stop': sid} for i, sid in unmatched], 'out_of_order': out_of_order},
        'ways': {'in_relation': len(rel_ways), 'off_shape': off_ways, 'routed_not_in_relation': missing_ways, 'ids': rel_ways,
                 'chain_breaks': [{'i': i, 'a': a, 'b': b, 'lon': coords[ways[b]['nodes'][0]][0], 'lat': coords[ways[b]['nodes'][0]][1]} for i, a, b in breaks if ways[b]['nodes'] and ways[b]['nodes'][0] in coords]},
        'members': [{'type': m['type'], 'ref': m['ref'], 'role': m['role']} for m in rel['members']],
        'geometry': [pts for _, pts in relation_geometry(rel, ways, coords)],
    }


def proposed_relation_tags(feed, p, stop_match, conv=None):
    conv = conv or {}
    route = feed.routes[p.route_id]
    agency = feed.agency.get('agency_name', '')
    first, last = feed.stops[p.stops[0]], feed.stops[p.stops[-1]]
    t = {'type': 'route', 'route': {'0': 'tram', '1': 'subway', '2': 'train', '3': 'bus', '11': 'trolleybus'}.get(route.type, 'bus'),
         'public_transport:version': '2', 'ref': route.short, 'operator': conv.get('operator') or agency,
         'from': first.desc or first.name, 'to': last.desc or last.name,
         'gtfs:route_id': p.route_id, 'gtfs:shape_id': p.shape_id}
    for k in ('network', 'network:wikidata', 'operator:wikidata'):
        if conv.get(k):
            t[k] = conv[k]
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


def proposed_master_tags(feed, route_id, conv=None):
    conv = conv or {}
    route = feed.routes[route_id]
    t = {'type': 'route_master', 'route_master': 'bus', 'ref': route.short, 'name': f'Bus {route.short}' + (f': {route.long}' if route.long else ''),
         'operator': conv.get('operator') or feed.agency.get('agency_name', ''), 'gtfs:route_id': route_id}
    for k in ('network', 'network:wikidata'):
        if conv.get(k):
            t[k] = conv[k]
    if route.color:
        t['colour'] = '#' + route.color.upper()
    return t
