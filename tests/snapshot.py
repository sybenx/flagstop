"""What the review decided, in brief, so a change to matching or deciding shows up as a list of what moved.

  python3 tests/snapshot.py            compare web/data/review.json with tests/snapshot.json
  python3 tests/snapshot.py --update   accept the current review as the new snapshot

Per stop: how it matched, which OSM stop, and flagstop's pick for every difference. Per itinerary: its
relations, whether its roads join up, how many divergences, and its timetable. Rebuild the review first
(python3 tool/review.py <feed>); the snapshot is only as current as the last build.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REVIEW = os.path.join(ROOT, 'web', 'data', 'review.json')
SNAP = os.path.join(ROOT, 'tests', 'snapshot.json')


def brief(review):
    stops = review['stops'] if isinstance(review['stops'], dict) else {s['id']: s for s in review['stops']}
    out = {'stops': {}, 'patterns': {}, 'positions': review.get('positions')}
    for sid, s in sorted(stops.items()):
        m = s.get('match') or {}
        out['stops'][sid] = {
            'name': s['name'], 'status': m.get('status'), 'osm': (m.get('osm') or [{}])[0].get('id'),
            'picks': {k: v['pick'] + (f": {m['diff'][k]['gtfs']}" if k in (m.get('diff') or {}) and v['pick'] == 'agency' and k in ('name', 'network', 'operator') else '')
                      for k, v in sorted((m.get('decide') or {}).items())},
        }
    for p in review['patterns']:
        out['patterns'][p['id']] = {
            'relations': sorted(a['id'] for a in p['relations']),
            # routed only in a full build (--route-all); a light build's routes are compared on the rest
            **({'chain_ok': p.get('chain_ok'), 'divergences': len(p['routed']['divergences'])} if p.get('routed') else {}),
            'services': [f"{x['days']} {x['first']}-{x['last']} every {x['every']}{'' if x.get('steady') else ' (drifts)'}" for x in p.get('services', [])],
        }
    return out


def compare(old, new):
    """-> lines saying what changed, stop by stop and itinerary by itinerary."""
    lines = []
    for kind in ('stops', 'patterns'):
        for k in sorted(set(old[kind]) | set(new[kind])):
            a, b = old[kind].get(k), new[kind].get(k)
            if a == b:
                continue
            label = f"{kind[:-1]} {k} {(b or a).get('name', '')}".rstrip()
            if a is None or b is None:
                lines.append(f"{label}: {'added' if a is None else 'gone'}")
                continue
            for f in sorted(set(a) & set(b) if kind == 'patterns' else set(a) | set(b)):   # a light build has no route fields
                if a.get(f) != b.get(f):
                    if isinstance(a.get(f), dict) and isinstance(b.get(f), dict):
                        for kk in sorted(set(a[f]) | set(b[f])):
                            if a[f].get(kk) != b[f].get(kk):
                                lines.append(f"{label}: {f}.{kk} {a[f].get(kk)!r} -> {b[f].get(kk)!r}")
                    else:
                        lines.append(f"{label}: {f} {a.get(f)!r} -> {b.get(f)!r}")
    if old.get('positions') != new.get('positions'):
        lines.append(f"positions {old.get('positions')} -> {new.get('positions')}")
    return lines


def main():
    new = brief(json.load(open(REVIEW)))
    if '--update' in sys.argv:
        json.dump(new, open(SNAP, 'w'), indent=1, sort_keys=True)
        print(f'snapshot updated: {len(new["stops"])} stops, {len(new["patterns"])} itineraries')
        return 0
    lines = compare(json.load(open(SNAP)), new)
    print('\n'.join(lines) if lines else 'no change')
    return 1 if lines else 0


if __name__ == '__main__':
    sys.exit(main())
