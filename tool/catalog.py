#!/usr/bin/env python3
"""Find a transit system's GTFS feed in the Mobility Database and download it.

    python3 tool/catalog.py "cache valley"            # list matches
    python3 tool/catalog.py "cache valley" --get      # download the first active match into cache/
    python3 tool/catalog.py --id mdb-1234 --get       # a specific feed

The catalog is MobilityData's public spreadsheet (files.mobilitydatabase.org/feeds_v2.csv), refetched
after a day. No key needed. Feeds that need authentication are listed but not downloaded.
"""
import argparse, csv, io, os, shutil, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv'
CACHE = os.path.join(ROOT, 'cache', 'feeds_v2.csv')


def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': 'flagstop (GTFS/OSM route review)'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read() if binary else r.read().decode('utf-8-sig', 'replace')


def fetch_to(url, path):
    """url into the file path, a piece at a time (a national feed is hundreds of MB): written beside it and
    moved into place when whole, so a download cut short leaves what was there."""
    req = urllib.request.Request(url, headers={'User-Agent': 'flagstop (GTFS/OSM route review)'})
    with urllib.request.urlopen(req, timeout=120) as r, open(path + '.part', 'wb') as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(path + '.part', path)


def catalog(refresh=False):
    if refresh or not os.path.exists(CACHE) or time.time() - os.path.getmtime(CACHE) > 86400:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        open(CACHE, 'w').write(get(CSV_URL))
    rows = list(csv.DictReader(io.StringIO(open(CACHE, encoding='utf-8').read())))
    if not rows:
        return []
    # The spreadsheet's headers have shifted between versions; find columns by what they contain.
    keys = list(rows[0].keys())
    def col(*needles):
        for n in needles:
            for k in keys:
                if n in k.lower():
                    return k
        return None
    C = {'id': col('id'), 'type': col('data_type'), 'provider': col('provider'), 'name': col('name'), 'country': col('country'),
         'region': col('subdivision'), 'city': col('municipality'), 'download': col('direct_download'), 'latest': col('latest'),
         'license': col('license'), 'status': col('status'), 'auth': col('authentication_type')}
    out = []
    for r in rows:
        if C['type'] and r.get(C['type'], '').strip() != 'gtfs':
            continue
        out.append({k: (r.get(c, '') or '').strip() if c else '' for k, c in C.items()})
    return out


def search(q, feeds):
    q = q.lower().split()
    hit = []
    for f in feeds:
        text = ' '.join(f[k] for k in ('provider', 'name', 'city', 'region', 'country', 'id')).lower()
        if all(w in text for w in q):
            hit.append(f)
    hit.sort(key=lambda f: (f['status'] not in ('active', ''), f['provider']))
    return hit


def download(f, out_dir):
    url = f['download'] or f['latest']
    if not url:
        raise SystemExit(f"{f['id']}: no download URL in the catalog")
    if f['auth'] and f['auth'] not in ('0', ''):
        raise SystemExit(f"{f['id']}: this feed needs authentication ({f['auth']}); fetch it yourself and pass the zip to review.py")
    os.makedirs(out_dir, exist_ok=True)
    slug = ''.join(c if c.isalnum() else '-' for c in (f['provider'] or f['id']).lower()).strip('-')[:40]
    path = os.path.join(out_dir, f'{slug}.zip')
    print(f'downloading {url}', file=sys.stderr)
    fetch_to(url, path + '.new')
    with open(path + '.new', 'rb') as z:
        head = z.read(40)
    if head[:2] != b'PK':
        os.remove(path + '.new')
        raise SystemExit(f'{url} did not return a zip (got {head!r})')
    os.replace(path + '.new', path)
    print(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('query', nargs='?', default='')
    ap.add_argument('--id')
    ap.add_argument('--get', action='store_true')
    ap.add_argument('--refresh', action='store_true')
    ap.add_argument('--out', default=os.path.join(ROOT, 'cache'))
    a = ap.parse_args()
    feeds = catalog(a.refresh)
    if a.id:
        hits = [f for f in feeds if f['id'] == a.id]
    elif a.query:
        hits = search(a.query, feeds)
    else:
        ap.error('give a search string or --id')
    if not hits:
        raise SystemExit('nothing matched')
    for f in hits[:30]:
        print(f"{f['id']:<12} {f['provider'][:40]:<40} {f['city'][:18]:<18} {f['region'][:14]:<14} {f['country']:<3} {f['status'] or '-':<10} {'auth' if f['auth'] not in ('', '0') else ''} {f['license'][:50]}")
    if len(hits) > 30:
        print(f'… {len(hits) - 30} more')
    if a.get:
        download(hits[0], a.out)


if __name__ == '__main__':
    main()
