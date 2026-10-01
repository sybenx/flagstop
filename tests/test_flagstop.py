"""python3 -m unittest discover -s tests

The rules flagstop decides by, each pinned to a case it was built for, and the whole review against its
snapshot (tests/snapshot.py), so a change to one rule shows what else it moved."""
import json, os, shutil, subprocess, sys, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tool'))
sys.path.insert(0, os.path.join(ROOT, 'tests'))
import stops, review, snapshot   # noqa: E402


class Stop:
    """A GTFS stop as gtfs.py makes one, with only what a test needs."""
    def __init__(self, name, lat=41.74, lon=-111.83, id='1', code='100', desc='', wheelchair='0'):
        self.id, self.code, self.ref, self.name, self.lat, self.lon, self.desc, self.wheelchair = id, code, code, name, lat, lon, desc, wheelchair
        self.routes, self.tts = set(), ''


class Feed:
    def __init__(self, agency='CVTD Cache Valley Transit District', lang='en-US'):
        self.agency = {'agency_name': agency, 'agency_lang': lang}
        self.routes, self.stops, self.patterns = {}, {}, []


def osm(name='', lat=41.74, lon=-111.83, **tags):
    return {'id': 'n1', 'lat': lat, 'lon': lon, 'tags': {'highway': 'bus_stop', 'public_transport': 'platform', 'name': name, **tags}}


def name_pick(gtfs_name, osm_name, d_m=0, desc=''):
    s = Stop(gtfs_name, desc=desc)
    o = osm(osm_name, lat=41.74 + d_m / 110540)
    df = stops.diff(Feed(), s, o)
    return (stops.decide(s, o, df).get('name') or {}).get('pick'), df.get('name')


class Names(unittest.TestCase):
    """The agency's name is its address for the stop, and it's right; OSM's way of writing it (spelled out)."""

    def test_same_address_spelled_out_is_no_difference(self):
        self.assertEqual(name_pick('296 East Center St', '296 East Center Street'), (None, None))

    def test_abbreviated_osm_name_gets_spelled_out_agency_name(self):
        pick, d = name_pick('1111 North 800 East', '1111 N 800 E')
        self.assertEqual(pick, 'agency')

    def test_spelled_out(self):
        self.assertEqual(stops.spelled('2470 N Main St, N Logan'), '2470 North Main Street, North Logan')
        self.assertEqual(stops.spelled('124 S Hwy 91, Richmond'), '124 South Highway 91, Richmond')
        self.assertEqual(stops.spelled('1559 South Talon Dr'), '1559 South Talon Drive')
        self.assertEqual(stops.spelled('781 S Main, Smithfield'), '781 South Main, Smithfield')
        # St before a name is Saint, not Street
        self.assertEqual(stops.spelled('St Thomas Church'), 'St Thomas Church')
        # only English names are expanded
        self.assertEqual(stops.spelled('12 Rue St Denis', lang='fr'), '12 Rue St Denis')

    def test_landmark_in_osm_name_goes(self):
        pick, _ = name_pick('100 E 1600 N', '100 E 1600 N(Walmart)')
        self.assertEqual(pick, 'agency')

    def test_bay_only_name_takes_the_agency_address(self):
        pick, _ = name_pick('150 East 500 North - Route 7 (700)', 'Route 7')
        self.assertEqual(pick, 'agency')

    def test_new_number_same_spot_is_the_agency_name(self):
        pick, _ = name_pick('186 North 400 West', '190 North 400 West', d_m=3)
        self.assertEqual(pick, 'agency')

    def test_new_number_far_off_is_a_question(self):
        pick, _ = name_pick('649 North 200 West', '583 North 200 West', d_m=138)
        self.assertEqual(pick, 'ask')


class Wheelchair(unittest.TestCase):
    def test_agency_no_is_never_written(self):
        s = Stop('1 Main St', wheelchair='2')
        self.assertNotIn('wheelchair', stops.diff(Feed(), s, osm('1 Main Street')))
        self.assertNotIn('wheelchair', stops.proposed_tags(Feed(), s))

    def test_agency_yes_is(self):
        s = Stop('1 Main St', wheelchair='1')
        self.assertEqual(stops.diff(Feed(), s, osm('1 Main Street'))['wheelchair']['gtfs'], 'yes')


class Networks(unittest.TestCase):
    conv = {'network': 'Connect Public Transit', 'operator': 'Connect Public Transit', 'network:wikidata': 'Q129798316'}

    def nd(self, **tags):
        return stops.network_diff(Feed(), osm('x', **tags), self.conv, aliases={'cvtd', 'connect public transit'})

    def test_old_names_become_the_current_one(self):
        for old in ('CVTD', 'Cache Valley Transit District', 'Connect Transit'):
            self.assertEqual(self.nd(network=old, operator=old)['network']['gtfs'], 'Connect Public Transit', old)
            self.assertEqual(self.nd(network=old, operator=old)['operator']['gtfs'], 'Connect Public Transit', old)

    def test_another_operator_is_listed_with(self):
        self.assertEqual(self.nd(operator='Utah State University')['operator']['gtfs'], 'Utah State University;Connect Public Transit')

    def test_a_shared_stop_already_listing_both_is_left(self):
        self.assertNotIn('network', self.nd(network='Aggie Shuttle;Connect Public Transit', **{'network:wikidata': 'Q129798316'}))


class Sides(unittest.TestCase):
    """A stop across the street from where the buses pull in is the other direction's, never this one."""
    north = [(-111.83, 41.74), (-111.83, 41.741)]   # a bus driving north: its kerb is the east side

    def test_sides(self):
        self.assertEqual(review.side((-111.8299, 41.7405), self.north), 'right')    # ~8 m east
        self.assertEqual(review.side((-111.8301, 41.7405), self.north), 'left')     # ~8 m west
        self.assertIsNone(review.side((-111.83002, 41.7405), self.north))           # ~2 m: on the line

    def test_across(self):
        feed = Feed()
        feed.stops = {'1': Stop('928 North 200 West', lat=41.7405, lon=-111.8299)}
        across = review.across_fn(feed, {'1': [self.north]})
        self.assertTrue(across('1', osm(lat=41.7405, lon=-111.8301)))        # 8 m west: across
        self.assertFalse(across('1', osm(lat=41.7405, lon=-111.83004)))      # 3 m west: drawing noise
        self.assertFalse(across('1', osm(lat=41.7406, lon=-111.8299)))       # same side


class StopPositions(unittest.TestCase):
    """A route lists the stop position level with its stop's platform, on a road it drives; never another bay's."""
    def test_nearest_platform_only(self):
        feed = Feed()
        feed.stops = {'1': Stop('bay A', lat=41.7400, lon=-111.8300)}
        P = type('P', (), {'id': 'p', 'stops': ['1']})
        feed.patterns = [P]
        osm_stops = {
            'n10': {'id': 'n10', 'osm_id': 10, 'lat': 41.7400, 'lon': -111.8300, 'tags': {'highway': 'bus_stop', 'public_transport': 'platform'}},
            'n11': {'id': 'n11', 'osm_id': 11, 'lat': 41.7401, 'lon': -111.8300, 'tags': {'highway': 'bus_stop', 'public_transport': 'platform'}},
            'n20': {'id': 'n20', 'osm_id': 20, 'lat': 41.74000, 'lon': -111.83006, 'tags': {'public_transport': 'stop_position', 'bus': 'yes'}},   # level with bay A
            'n21': {'id': 'n21', 'osm_id': 21, 'lat': 41.74010, 'lon': -111.83006, 'tags': {'public_transport': 'stop_position', 'bus': 'yes'}},   # level with the other bay
        }
        match = {'1': {'status': 'matched', 'osm': [{'id': 'n10'}]}}
        traced = {'p': {'legs': [{'ways': [5]}]}}
        g = type('G', (), {'ways': {5: {'nodes': [1, 20, 21, 2]}}})
        self.assertEqual(review.stop_positions(feed, traced, match, osm_stops, g, []), {'p': {'1': 20}})


class Turns(unittest.TestCase):
    """The router keeps to turn restrictions, unless they except buses."""
    def graph(self, rel_tags, to=12):
        import routes
        # a plus-shaped junction (node 0), arms north (1), east (2), south (3), west (4), plus a way round the
        # north-east block (1 -> 5 -> 2) so a bus barred from turning right at 0 still has a way east
        coords = {0: (0, 0), 1: (0, 0.001), 2: (0.001, 0), 3: (0, -0.001), 4: (-0.001, 0), 5: (0.001, 0.001)}
        ways = {10: [3, 0], 11: [0, 1], 12: [0, 2], 13: [0, 4], 14: [1, 5, 2]}
        els = [{'type': 'node', 'id': i, 'lon': x, 'lat': y} for i, (x, y) in coords.items()]
        els += [{'type': 'way', 'id': w, 'nodes': ns, 'tags': {'highway': 'residential'}} for w, ns in ways.items()]
        els.append({'type': 'relation', 'id': 1, 'tags': {'type': 'restriction', **rel_tags},
                    'members': [{'type': 'way', 'ref': 10, 'role': 'from'}, {'type': 'node', 'ref': 0, 'role': 'via'}, {'type': 'way', 'ref': to, 'role': 'to'}]})
        return routes.Graph({'elements': els})

    def path(self, g):
        return g.astar({3: 0}, {2: 0})[2]

    def test_no_right_turn_goes_round(self):
        self.assertNotEqual(self.path(self.graph({'restriction': 'no_right_turn'})), [10, 12])

    def test_except_bus(self):
        self.assertEqual(self.path(self.graph({'restriction': 'no_right_turn', 'except': 'bus'})), [10, 12])

    def test_only_straight_on(self):
        self.assertNotEqual(self.path(self.graph({'restriction': 'only_straight_on'}, to=11))[:2], [10, 12])


class FeedChanges(unittest.TestCase):
    def test_diff(self):
        import feeddiff
        stop = lambda name, lat=41.74, routes=('9',): {'name': name, 'code': '1', 'lat': lat, 'lon': -111.83, 'routes': list(routes)}
        old = {'version': 'v1', 'stops': {'a': stop('928 North 200 West'), 'b': stop('987 North 200 West'), 'c': stop('Old stop')},
               'routes': {'9': [{'headsign': '', 'stops': ['a', 'b', 'c']}], '4': [{'headsign': '', 'stops': ['c']}]}}
        new = {'version': 'v2', 'stops': {'a': stop('930 North 200 West', lat=41.7402), 'b': stop('987 North 200 West'), 'd': stop('New stop')},
               'routes': {'9': [{'headsign': '', 'stops': ['a', 'b', 'd']}]}}
        d = feeddiff.diff(old, new)
        self.assertEqual([s['id'] for s in d['stops_added']], ['d'])
        self.assertEqual([s['id'] for s in d['stops_removed']], ['c'])
        self.assertEqual([(s['id'], s['m']) for s in d['stops_moved']], [('a', 22)])
        self.assertEqual(d['stops_renamed'], [{'id': 'a', 'from': '928 North 200 West', 'to': '930 North 200 West'}])
        self.assertEqual(d['routes_removed'], ['4'])
        self.assertEqual(d['routes_changed'][0]['stops_added'], ['d'])


class OtherAgencies(unittest.TestCase):
    def test_shared_stop_by_their_feed_lists_both(self):
        conv = {'network': 'Connect Public Transit', 'operator': 'Connect Public Transit'}
        o = osm('x', operator='Utah State University')
        df = stops.network_diff(Feed(), o, conv)
        self.assertEqual(stops.decide(Stop('x'), o, df)['operator']['pick'], 'ask')
        o['served_by'] = ['Utah State University']
        self.assertEqual(stops.decide(Stop('x'), o, df)['operator']['pick'], 'agency')
        self.assertEqual(df['operator']['gtfs'], 'Utah State University;Connect Public Transit')

    def test_stops_in_area(self):
        import io, tempfile, zipfile, others
        path = os.path.join(tempfile.mkdtemp(), 'x.zip')
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon,location_type\n1,In,41.74,-111.83,0\n2,Out,40.0,-111.83,0\n3,Station,41.74,-111.83,1\n')
        got = others.stops_in(path, (41.6, -111.9, 41.8, -111.7), 'Shuttle')
        self.assertEqual([x['name'] for x in got], ['In'])


class Positions(unittest.TestCase):
    def test_same_spot_distance_comes_from_the_feed(self):
        res = {str(i): {'status': 'matched', 'osm': [{'dist': 5, 'how': 'ref'}]} for i in range(30)}
        far = (stops.FAR, stops.TYPICAL)
        try:
            self.assertEqual(stops.calibrate(res), (5, 15))
            res = {str(i): {'status': 'matched', 'osm': [{'dist': 2, 'how': 'ref'}]} for i in range(30)}
            self.assertEqual(stops.calibrate(res), (2, 10))   # never under 10 m
        finally:
            stops.FAR, stops.TYPICAL = far


class Review(unittest.TestCase):
    def test_review_matches_snapshot(self):
        if not os.path.exists(snapshot.REVIEW) or not os.path.exists(snapshot.SNAP):
            self.skipTest('no review built, or no snapshot')
        lines = snapshot.compare(json.load(open(snapshot.SNAP)), snapshot.brief(json.load(open(snapshot.REVIEW))))
        self.assertFalse(lines, f'{len(lines)} differences from the snapshot (if they are meant, python3 tests/snapshot.py --update):\n' + '\n'.join(lines[:60]))


class RouterParity(unittest.TestCase):
    """web/router.js routes every itinerary as tool/routes.py does (needs node and OSM data in cache/)."""
    def test_same_answers(self):
        if not shutil.which('node'):
            self.skipTest('no node')
        import router_parity
        self.assertEqual(router_parity.main([]), 0)


class Web(unittest.TestCase):
    def test_scripts_parse(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('no node')
        for f in sorted(os.listdir(os.path.join(ROOT, 'web'))):
            if f.endswith('.js'):
                r = subprocess.run([node, '--check', os.path.join(ROOT, 'web', f)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f'{f}: {r.stderr}')


if __name__ == '__main__':
    unittest.main()
