"""Other agencies' stops in this network's area, from their own GTFS feeds: so a stop shared with a university
shuttle or a coach line is known to be shared, not guessed from its tags.

Found in the Mobility Database catalog (active feeds that need no key, whose area covers this network), plus
any feed passed by hand (--also). Only their stops inside the area are read; the zips are kept in cache/others/.
"""
import csv, io, os, sys, time, zipfile

import catalog

KEEP = 7 * 86400   # s: how long a downloaded feed is used before fetching it again


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def candidates(bbox, own=''):
    """Catalog rows for active, open GTFS feeds whose bounding box covers bbox (s, w, n, e), but not this agency's
    own (own: its agency_name; a catalog provider name it contains is it)."""
    s, w, n, e = bbox
    catalog.catalog()   # fetched or refreshed into its cache; read raw here for the bounding boxes
    rows = list(csv.DictReader(io.StringIO(open(catalog.CACHE, encoding='utf-8').read())))
    col = lambda needle: next((k for k in (rows[0] if rows else {}) if needle in k.lower()), None)
    B = [col(x) for x in ('minimum_latitude', 'maximum_latitude', 'minimum_longitude', 'maximum_longitude')]
    out = []
    for r in rows:
        if r.get('data_type') != 'gtfs' or r.get('status') not in ('active', '') or r.get('urls.authentication_type') not in ('0', '', None):
            continue
        la0, la1, lo0, lo1 = (_f(r.get(k)) if k else None for k in B)
        if None in (la0, la1, lo0, lo1) or not (-90 <= la0 <= la1 <= 90 and -180 <= lo0 <= lo1 <= 180) or 0.0 in (la0, la1, lo0, lo1):
            continue   # a box with a 0 in it is the catalog's placeholder, not an area
        url = r.get('urls.latest') or r.get('urls.direct_download')
        if not url or (own and (r.get('provider') or '').lower() in own.lower()):
            continue
        if la0 <= n and la1 >= s and lo0 <= e and lo1 >= w and r.get('provider'):
            out.append({'id': r['id'], 'agency': r['provider'], 'url': url})
    return out


def stops_in(zpath, bbox, agency):
    """[{agency, id, code, name, lat, lon}] for the feed's stops (not stations) inside bbox."""
    s, w, n, e = bbox
    out = []
    with zipfile.ZipFile(zpath) as z:
        name = next((x for x in z.namelist() if x.endswith('stops.txt')), None)
        if not name:
            return out
        for r in csv.DictReader(io.TextIOWrapper(z.open(name), 'utf-8-sig')):
            la, lo = _f(r.get('stop_lat')), _f(r.get('stop_lon'))
            if la is None or lo is None or not (s <= la <= n and w <= lo <= e) or (r.get('location_type') or '0') not in ('0', ''):
                continue
            out.append({'agency': agency, 'id': r.get('stop_id'), 'code': r.get('stop_code') or '', 'name': r.get('stop_name') or '', 'lat': la, 'lon': lo})
    return out


def gather(bbox, cache_dir, own='', also=()):
    """Every other agency's stops in bbox: the catalog's feeds, then any given by hand (path or URL)."""
    d = os.path.join(cache_dir, 'others')
    os.makedirs(d, exist_ok=True)
    feeds = candidates(bbox, own)
    feeds += [{'id': os.path.basename(x).split('.')[0], 'agency': os.path.basename(x).split('.')[0], 'url': x} for x in also]
    out = []
    for f in feeds:
        path = f['url'] if os.path.exists(f['url']) else os.path.join(d, f"{f['id']}.zip")
        try:
            if path != f['url'] and (not os.path.exists(path) or time.time() - os.path.getmtime(path) > KEEP):
                print(f"other agencies: fetching {f['agency']} ({f['id']})", file=sys.stderr)
                open(path, 'wb').write(catalog.get(f['url'], binary=True))
            got = stops_in(path, bbox, f['agency'])
        except Exception as ex:
            print(f"other agencies: {f['agency']}: {ex}", file=sys.stderr)
            continue
        if got:
            print(f"other agencies: {f['agency']}: {len(got)} stops here", file=sys.stderr)
        out += got
    return out
