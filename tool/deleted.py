#!/usr/bin/env python3
"""What uploads took away: every object a mapper's changesets deleted, with all its tags as they were, and every tag
those changesets removed or changed on what stayed. So nothing taken out by a merge (or by mistake) goes unseen.

    python3 tool/deleted.py --user NAME [--since 2026-09-27] [--comment REGEX]   their changesets (OSM API, read-only)
    python3 tool/deleted.py 189856236 190175183 ...                               these changesets
    [--json out.json]                                                             the same, as data (for the page)

A deleted stop or relation is looked for among what the same changeset kept of its kind nearby (a stop within 150 m,
a relation with the same ref): its tags that didn't go there are listed as lost. Read-only; histories cached in
cache/history/.
"""
import argparse, json, math, os, re, sys, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

API = os.environ.get('OSM_API_URL', 'https://api.openstreetmap.org').rstrip('/')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'cache', 'history')
UA = 'flagstop (deleted.py; read-only)'


def get(url, cache=None):
    if cache and os.path.exists(cache):
        with open(cache, 'rb') as f:
            return f.read()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60) as r:
                data = r.read()
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    if cache:
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, 'wb') as f:
            f.write(data)
    return data


def changesets(user, since, comment):
    """A user's changesets since a date, oldest first (the API gives 100 at a time, newest first)."""
    out, before = [], None
    while True:
        q = {'display_name': user, 'time': since}
        if before:
            q['time'] = f'{since},{before}'
        js = json.loads(get(f'{API}/api/0.6/changesets.json?' + urllib.parse.urlencode(q)))['changesets']
        out += [c for c in js if c['id'] not in {x['id'] for x in out}]
        if len(js) < 100:
            break
        before = min(c['created_at'] for c in js)
    out = [c for c in out if not comment or re.search(comment, (c.get('tags') or {}).get('comment', ''), re.I)]
    return sorted(out, key=lambda c: c['id'])


def download(cs):
    """A closed changeset's osmChange: [(action, type, id, version, tags, lat, lon, members)]."""
    root = ET.fromstring(get(f'{API}/api/0.6/changeset/{cs}/download', os.path.join(CACHE, f'cs-{cs}.osc')))
    out = []
    for act in root:
        for e in act:
            out.append({'action': act.tag, 'type': e.tag, 'id': int(e.get('id')), 'version': int(e.get('version')),
                        'tags': {t.get('k'): t.get('v') for t in e.findall('tag')},
                        'lat': float(e.get('lat')) if e.get('lat') else None, 'lon': float(e.get('lon')) if e.get('lon') else None})
    return out


def version(t, i, v):
    """One version of an object: {tags, lat, lon, visible}."""
    js = json.loads(get(f'{API}/api/0.6/{t}/{i}/{v}.json', os.path.join(CACHE, f'{t}-{i}-v{v}.json')))['elements'][0]
    return {'tags': js.get('tags', {}), 'lat': js.get('lat'), 'lon': js.get('lon'), 'visible': js.get('visible', True), 'user': js.get('user'), 'timestamp': js.get('timestamp')}


def dist(a, b):
    if None in (a.get('lat'), b.get('lat')):
        return 1e9
    k = math.cos(math.radians(a['lat']))
    return math.hypot((a['lat'] - b['lat']) * 110540, (a['lon'] - b['lon']) * 111320 * k)


def is_stop(t):
    return t.get('highway') == 'bus_stop' or t.get('public_transport') in ('platform', 'stop_position', 'station') or t.get('amenity') == 'bus_station'


def audit(cs):
    """What one changeset took away. -> {deleted: [...], removed: [...]}"""
    ch = download(cs)
    kept = [e for e in ch if e['action'] in ('modify', 'create')]
    deleted, removed = [], []
    for e in ch:
        if e['action'] == 'delete':
            was = version(e['type'], e['id'], e['version'] - 1)   # the last version with its tags
            d = {'type': e['type'], 'id': e['id'], 'tags': was['tags'], 'lat': was['lat'], 'lon': was['lon'], 'last_edit': f"{was['user']} {was['timestamp'][:10]}"}
            # where it went, if anywhere: what the changeset kept of its kind, close by (a stop) or of its route (a relation)
            if e['type'] == 'node' and is_stop(was['tags']):
                near = sorted((dist(was, k), k) for k in kept if k['type'] == 'node' and is_stop(k['tags']) and k['lat'] is not None)
                into = near[0][1] if near and near[0][0] <= 150 else None
            elif e['type'] == 'relation':
                into = next((k for k in kept if k['type'] == 'relation' and k['tags'].get('ref') == was['tags'].get('ref') and k['tags'].get('type') == was['tags'].get('type')), None)
            else:
                into = None
            if into:
                d['into'] = {'type': into['type'], 'id': into['id'], 'name': into['tags'].get('name'), 'dist': round(dist(was, into)) if e['type'] == 'node' else None}
                d['lost'] = {k: v for k, v in was['tags'].items() if into['tags'].get(k) != v}
            deleted.append(d)
        elif e['action'] == 'modify' and e['version'] > 1:
            was = version(e['type'], e['id'], e['version'] - 1)['tags']
            gone = {k: v for k, v in was.items() if k not in e['tags']}
            changed = {k: [v, e['tags'][k]] for k, v in was.items() if k in e['tags'] and e['tags'][k] != v}
            if gone or changed:
                removed.append({'type': e['type'], 'id': e['id'], 'name': e['tags'].get('name') or was.get('name'), 'removed': gone, 'changed': changed})
    return {'deleted': deleted, 'removed': removed}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('changesets', nargs='*', type=int)
    ap.add_argument('--user')
    ap.add_argument('--since', default='2026-09-27')
    ap.add_argument('--comment', help='only changesets whose comment matches')
    ap.add_argument('--json')
    a = ap.parse_args()
    css = [{'id': i} for i in a.changesets] or changesets(a.user, a.since, a.comment)
    out = []
    for c in css:
        r = audit(c['id'])
        r.update(id=c['id'], comment=(c.get('tags') or {}).get('comment', ''), date=(c.get('created_at') or '')[:10])
        out.append(r)
        if not (r['deleted'] or r['removed']):
            continue
        print(f"\nchangeset {c['id']} {r['date']}  {r['comment'][:100]}")
        for d in r['deleted']:
            tags = ' '.join(f'{k}={v}' for k, v in sorted(d['tags'].items()))
            print(f"  deleted {d['type']} {d['id']} \"{d['tags'].get('name', '')}\" (last edit {d['last_edit']}): {tags}")
            if d.get('into'):
                lost = d['lost']
                print(f"    -> into {d['into']['type']} {d['into']['id']} \"{d['into']['name']}\"" + (f" {d['into']['dist']} m away" if d['into']['dist'] is not None else '') +
                      (f"; not there: {' '.join(f'{k}={v}' for k, v in sorted(lost.items()))}" if lost else '; all its tags are there'))
            else:
                print('    -> nothing of its kind kept nearby in this changeset: all of it is gone')
        for m in r['removed']:
            bits = [f'-{k}={v}' for k, v in sorted(m['removed'].items())] + [f'{k}: {v[0]} -> {v[1]}' for k, v in sorted(m['changed'].items())]
            print(f"  {m['type']} {m['id']} \"{m['name'] or ''}\": " + '; '.join(bits))
    if a.json:
        with open(a.json, 'w') as f:
            json.dump(out, f, indent=1)


if __name__ == '__main__':
    main()
