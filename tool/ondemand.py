#!/usr/bin/env python3
"""An on-demand service's pickup points (a zone booked by app or phone, picked up at signed stops), where its feed
doesn't have them: from the planning tool the agency publishes its map with.

    python3 tool/ondemand.py remix:<project id>:<zone name>      the zone and its pickups, printed

Remix (platform.remix.com, whose Via arm runs many such services) publishes a project's on-demand zones with their
named places, the pickup points the agency draws, through its public map API. Read once a day at most, kept in
cache/ondemand/; nothing is written to OSM from here. A pickup is a signed stop on the street: it's in OSM as a bus
stop, with the service in its route_ref (one at a bus stop already: that stop; one of its own: a stop of its own).
"""
import json, os, sys, time, urllib.request

UA = {'User-Agent': 'flagstop (on-demand pickups; read-only)', 'Accept': 'application/json'}
KEEP = 20 * 3600   # s: a day's copy is new enough


def parse(spec):
    """'remix:<project>:<zone>' -> {'kind': 'remix', 'project', 'zone'}"""
    kind, project, *zone = spec.split(':', 2)
    if kind != 'remix' or not project:
        raise SystemExit(f'ondemand: "{spec}" is not remix:<project id>:<zone name>')
    return {'kind': kind, 'project': project, 'zone': zone[0] if zone else ''}


def fetch(spec, cache_dir):
    """The service: {name, zone: [[lon, lat]...], pickups: [{id, label, lat, lon}]}. A day's copy is kept; a day the
    API can't be read, the last copy stands (and None if there's none)."""
    s = parse(spec)
    d = os.path.join(cache_dir, 'ondemand')
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{s['kind']}-{s['project']}.json")
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > KEEP:
        try:
            with urllib.request.urlopen(urllib.request.Request(f"https://platform.remix.com/api/projects/{s['project']}", headers=UA), timeout=60) as r:
                raw = json.load(r)
            json.dump(raw, open(path + '.tmp', 'w')); os.replace(path + '.tmp', path)
        except Exception as e:
            print(f'ondemand: {spec} not read ({e}); {"the last copy stands" if os.path.exists(path) else "nothing to use"}', file=sys.stderr)
    if not os.path.exists(path):
        return None
    raw = json.load(open(path))
    zones = [z for sc in raw.get('scenarios', []) for z in sc.get('onDemandZones', []) if not z.get('isHidden')]
    want = s['zone'].strip().upper()
    zone = next((z for z in zones if (z.get('name') or '').strip().upper() == want), None) if want else (zones[0] if zones else None)
    if not zone:
        print(f"ondemand: no zone {s['zone']!r} in {s['project']} (has: {', '.join(z.get('name') or '?' for z in zones)})", file=sys.stderr)
        return None
    geom = zone.get('geometry') or {}
    ring = geom.get('coordinates', [[]])[0] if geom.get('type') == 'Polygon' else []
    pickups = [{'id': str(q.get('id')), 'label': ' '.join(str(q.get('label') or '').replace('(', ' (').split()),
                'lon': q['geometry']['coordinates'][0], 'lat': q['geometry']['coordinates'][1]}
               for q in zone.get('places', []) if (q.get('geometry') or {}).get('type') == 'Point']
    return {'name': zone.get('name') or want or 'on demand', 'zone': [[round(x, 6), round(y, 6)] for x, y in ring], 'pickups': pickups}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    svc = fetch(sys.argv[1], os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'cache'))
    if not svc:
        raise SystemExit('ondemand: nothing read')
    print(f"{svc['name']}: {len(svc['pickups'])} pickups, a zone of {len(svc['zone'])} points")
    for q in svc['pickups']:
        print(f"  {q['lat']:.5f},{q['lon']:.5f}  {q['label']}")
