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

    def test_a_feed_in_capitals_says_nothing_about_case(self):
        # OSM's well-cased name stays; a new stop gets the name in ordinary case, spelled out
        self.assertEqual(name_pick('MAIN ST & 1ST AVE', 'Main Street & 1st Avenue'), (None, None))
        self.assertEqual(name_pick('USU TAGGART STUDENT CENTER', 'USU Taggart Student Center'), (None, None))
        self.assertEqual(stops.spelled('2470 N MAIN ST, N LOGAN'), '2470 North Main Street, North Logan')
        self.assertEqual(stops.spelled('BUILDING E'), 'Building E')
        self.assertEqual(stops.spelled('St Thomas & Main St'), 'St Thomas & Main Street')

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

    def test_another_network_on_the_pole_is_listed_with_and_not_asked_about(self):
        """1111 North 800 East: USU's Aggie Bus and ours both sign the pole; nobody knows whose it is. Both, theirs first."""
        d = self.nd(network='Aggie Bus', operator='Utah State university')
        self.assertEqual(d['network']['gtfs'], 'Aggie Bus;Connect Public Transit')
        self.assertEqual(d['operator']['gtfs'], 'Utah State university;Connect Public Transit')
        o = osm('x', network='Aggie Bus', operator='Utah State university')
        dec = stops.decide(Stop('1111 North 800 East'), o, d)
        self.assertEqual((dec['network']['pick'], dec['operator']['pick']), ('agency', 'agency'))

    def test_a_route_number_in_network_is_replaced_and_asked_about(self):
        feed = Feed(); feed.routes = {'5': type('R', (), {'short': '2'})}
        d = stops.network_diff(feed, osm('x', network='2'), self.conv, aliases=set())
        self.assertEqual(d['network']['gtfs'], 'Connect Public Transit')
        self.assertEqual(stops.decide(Stop('x'), osm('x', network='2'), d)['network']['pick'], 'ask')

    def test_the_other_networks_routes_stay_in_route_ref(self):
        feed = Feed(); feed.routes = {'5': type('R', (), {'short': '2'})}
        o = osm('x', network='Aggie Bus', route_ref='Blue;Green')
        diff = {'route_ref': {'gtfs': '2', 'osm': 'Blue;Green'}, 'network': {'gtfs': 'Aggie Bus;Connect Public Transit', 'osm': 'Aggie Bus', 'old': [], 'other': ['Aggie Bus']}}
        self.assertEqual(stops.keep_foreign_routes(feed, o, diff)['route_ref']['gtfs'], '2;Blue;Green')
        # nothing of ours in it yet, theirs already there: no change to make once ours is added... and all there already: no row
        o2 = osm('x', network='Aggie Bus', route_ref='2;Blue;Green')
        self.assertNotIn('route_ref', stops.keep_foreign_routes(feed, o2, {'route_ref': {'gtfs': '2', 'osm': '2;Blue;Green'}, 'network': diff['network']}))


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


class Constraints(unittest.TestCase):
    """The reviewer's say over the router: a road the bus doesn't use (avoid), a road it does (require)."""
    # three east-west streets 445 m long: A (the agency's line runs along it), B 55 m north, C 110 m south,
    # joined at both ends by cross streets
    COORDS = {1: (0, 0), 2: (0.004, 0), 5: (0, 0.0005), 6: (0.004, 0.0005), 3: (0, -0.001), 4: (0.004, -0.001)}
    WAYS = {10: [1, 2], 11: [5, 6], 12: [3, 4], 20: [1, 5], 21: [2, 6], 22: [1, 3], 23: [2, 4]}
    STOPS = [(0.0002, 0), (0.0038, 0)]
    SHAPE = [(0, 0), (0.004, 0)]

    def graph(self, oneway=()):
        import routes
        els = [{'type': 'node', 'id': i, 'lon': x, 'lat': y} for i, (x, y) in self.COORDS.items()]
        els += [{'type': 'way', 'id': w, 'nodes': ns, 'tags': {'highway': 'residential', **({'oneway': 'yes'} if w in oneway else {})}} for w, ns in self.WAYS.items()]
        return routes.Graph({'elements': els})

    def folded(self, g, **say):
        import routes
        seq, pins = routes.fold_vias(g, self.STOPS, **say)
        return seq, self.SHAPE, pins

    def test_follows_the_line(self):
        import routes
        r = routes.trace(self.graph(), self.STOPS, self.SHAPE)
        self.assertEqual(r['ways'], [10])
        self.assertEqual(r['divergences'], [])

    def test_avoid_takes_the_parallel_street_and_says_why(self):
        import routes
        r = routes.trace(self.graph().patched(avoid=[10]), self.STOPS, self.SHAPE)
        self.assertNotIn(10, r['ways'])
        self.assertIn(11, r['ways'])
        over = [d for d in r['divergences'] if 10 in d['ways']]
        self.assertTrue(over, r['divergences'])
        self.assertIn(routes.EXCLUDED, over[0]['why'])

    def test_require_drives_the_way_once_end_to_end(self):
        import routes
        g = self.graph()
        r = routes.trace(g, *self.folded(g, require=[12]))
        self.assertEqual(r['ways'], [10, 22, 12, 23, 10])
        self.assertTrue(all(l['ok'] for l in r['legs']))

    def test_require_a_one_way_drives_it_its_way(self):
        import routes
        g = self.graph(oneway=[12])   # C runs east only
        r = routes.trace(g, *self.folded(g, require=[12]))
        self.assertEqual(r['ways'], [10, 22, 12, 23, 10])
        self.WAYS[12] = [4, 3]       # C runs west only: it can still be driven, from its east end
        try:
            g = self.graph(oneway=[12])
            r = routes.trace(g, *self.folded(g, require=[12]))
        finally:
            self.WAYS[12] = [3, 4]
        self.assertEqual(r['ways'], [10, 23, 12, 22, 10])

    def test_two_stops_on_one_stretch(self):
        """Stops on the same stretch of road: the leg is that stretch, not a spike to one end of it."""
        import routes
        g = self.graph()
        r = routes.trace(g, [(0.0002, 0), (0.0020, 0), (0.0038, 0)], self.SHAPE)
        self.assertEqual(r['ways'], [10])
        self.assertEqual([len(l['geometry']) for l in r['legs']], [2, 2])


class FeedChanges(unittest.TestCase):
    def test_versions_told_apart_by_what_they_hold(self):
        import tempfile, feeddiff
        d = tempfile.mkdtemp()
        try:
            def feed(lat, version=''):
                f = Feed()
                s = Stop('100 Main St', lat=lat); s.location_type = '0'
                f.stops, f.info = {'1': s}, {'feed_version': version}
                return f
            self.assertIsNone(feeddiff.track(feed(41.74), d, 'x'))             # no feed_info: 'unversioned'
            ch = feeddiff.track(feed(41.7404), d, 'x')                          # moved, still no label: a new version
            self.assertEqual([m['id'] for m in ch['stops_moved']], ['1'])
            feeddiff.track(feed(41.7404, 'daily-2'), d, 'x')                    # a new label, nothing changed: not kept twice
            index = json.load(open(os.path.join(d, 'x-feeds.json')))
            self.assertEqual(len(index), 2)
            import positions
            self.assertIn('1', positions.jumps(positions.versions(d, 'x')))
        finally:
            shutil.rmtree(d, ignore_errors=True)

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
    def test_a_passio_go_shuttle_counts_as_another_agency(self):
        """A campus shuttle with no GTFS, on Passio GO (as the Aggie Shuttle is): its stops, read from the app's own
        answer, say which of this agency's stops are shared."""
        import others
        raw = {'stops': {'a': {'stopId': 154475, 'name': ' Public Safety ', 'latitude': '41.754534', 'longitude': '-111.812388'},
                         'b': {'stopId': 154475, 'name': 'Public Safety', 'latitude': '41.754534', 'longitude': '-111.812388'},   # listed twice: once
                         'c': {'stopId': 9, 'name': 'Far', 'latitude': '40.0', 'longitude': '-111.8'}}}
        got = others.passio_stops(raw, (41.6, -111.9, 42.1, -111.7), 'Utah State University')
        self.assertEqual(got, [{'agency': 'Utah State University', 'id': '154475', 'code': '', 'name': 'Public Safety', 'lat': 41.754534, 'lon': -111.812388}])


    def test_shared_stop_by_their_feed_lists_both(self):
        conv = {'network': 'Connect Public Transit', 'operator': 'Connect Public Transit'}
        o = osm('x', operator='Utah State University')
        df = stops.network_diff(Feed(), o, conv)
        self.assertEqual(stops.decide(Stop('x'), o, df)['operator']['pick'], 'agency')   # a shared pole: both, theirs first
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


class StopMoves(unittest.TestCase):
    """The agency's point says when a stop moved; a hand-placed OSM node says exactly where (tool/positions.py)."""
    def setUp(self):
        import positions
        self.P = positions
        self.v1 = {'version': 'v1', 'stops': {'a': {'lat': 41.7400, 'lon': -111.8300}, 'b': {'lat': 41.7500, 'lon': -111.8300}}}
        self.v2 = {'version': 'v2', 'stops': {'a': {'lat': 41.7404, 'lon': -111.8300}, 'b': {'lat': 41.75002, 'lon': -111.8300}}}   # a: 44 m; b: 2 m (jitter)

    def test_jumps(self):
        j = self.P.jumps([self.v1, self.v2])
        self.assertEqual(list(j), ['a'])
        self.assertEqual((j['a']['m'], j['a']['version']), (44, 'v2'))

    def test_provenance(self):
        P = self.P
        moved = [{'version': 1, 'lat': 41.74, 'lon': -111.83}, {'version': 2, 'lat': 41.74005, 'lon': -111.83}]   # 5.5 m: moved by someone
        copied = [{'version': 1, 'lat': 41.74001, 'lon': -111.83}, {'version': 2, 'lat': 41.74001, 'lon': -111.83}]   # 1 m off the feed's point, never moved
        elsewhere = [{'version': 1, 'lat': 41.7401, 'lon': -111.83}]
        pts = [(41.74, -111.83)]
        self.assertEqual(P.provenance(moved, pts), 'hand')
        self.assertEqual(P.provenance(copied, pts), 'feed')
        self.assertEqual(P.provenance(elsewhere, pts), 'unknown')

    def test_plan(self):
        P = self.P
        j = P.jumps([self.v1, self.v2])['a']
        old = {'lat': 41.74003, 'lon': -111.82995}    # OSM still at the old spot, 4-5 m off the agency's old point
        new = {'lat': 41.74041, 'lon': -111.83}
        by_hand = P.plan(None, old, j, 'hand', far=15)
        self.assertEqual(by_hand['how'], 'shift')
        self.assertAlmostEqual(by_hand['to'][1], 41.74003 + 0.0004, places=7)   # the node's own offset kept
        self.assertAlmostEqual(by_hand['to'][0], -111.82995, places=7)
        self.assertEqual(P.plan(None, old, j, 'feed', far=15)['to'], j['to'])     # copied from the feed: the feed's new point
        self.assertIsNone(P.plan(None, new, j, 'hand', far=15))                     # OSM already has it at the new spot
        self.assertIsNone(P.plan(None, old, None, 'hand', far=15))                  # no move in the feed's history

    def test_moved_away_from_the_agency_spot(self):
        P = self.P
        at = {'lat': 41.719789, 'lon': -111.835135}
        hist = [{'version': 1, **at, 'user': 'a', 'timestamp': '2024-01-09T00:00:00Z', 'changeset': 1},
                {'version': 2, **at, 'user': 'b', 'timestamp': '2025-04-02T00:00:00Z', 'changeset': 2},
                {'version': 3, 'lat': 41.717576, 'lon': -111.836611, 'user': 'c', 'timestamp': '2026-02-05T00:00:00Z', 'changeset': 3}]
        away = P.moved_away(hist, (41.719811, -111.835184), 15)
        self.assertEqual((away['user'], away['date'], away['changeset'], away['back']), ('c', '2026-02-05', 3, [-111.835135, 41.719789]))
        self.assertGreater(away['m'], 250)
        self.assertIsNone(P.moved_away(hist[:2], (41.719811, -111.835184), 15), 'still at the spot')
        self.assertIsNone(P.moved_away(hist[2:], (41.719811, -111.835184), 15), 'never was at it: made elsewhere')
        placed = hist[:2] + [{'version': 3, 'lat': 41.719789 + 24 / 110540, 'lon': -111.835135, 'user': 'd', 'timestamp': '2025-08-05T00:00:00Z', 'changeset': 4}]
        self.assertIsNone(P.moved_away(placed, (41.719811, -111.835184), 15), 'moved 24 m onto its sign: placed by hand, not moved away')

    def test_a_move_across_a_version_without_the_stop_still_counts(self):
        gap = {'version': 'detour', 'stops': {'b': self.v1['stops']['b']}}   # 'a' dropped for a detour
        j = self.P.jumps([self.v1, gap, self.v2])
        self.assertEqual((j['a']['m'], j['a']['version']), (44, 'v2'))

    def test_an_id_given_to_a_stop_far_away_is_not_a_move(self):
        far = {'version': 'v3', 'stops': {'a': {'lat': 41.7600, 'lon': -111.8300}}}   # 2 km on
        self.assertNotIn('a', self.P.jumps([self.v1, self.v2, far]))

    def test_history_read_again_when_osm_is_newer_and_none_when_it_cant_be(self):
        import tempfile
        d = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(d, 'history'))
            json.dump([{'version': 1, 'lat': 41.74, 'lon': -111.83, 'changeset': 7}], open(os.path.join(d, 'history', 'node-5.json'), 'w'))
            nowhere = 'http://127.0.0.1:9'   # nothing listens: a fetch fails
            self.assertEqual(len(self.P.history(nowhere, 5, d, version=1)), 1, 'the copy kept is current')
            self.assertIsNone(self.P.history(nowhere, 5, d, version=2), 'OSM has a newer version: the old copy is not used')
            self.assertIsNone(self.P.provenance(None, [(41.74, -111.83)]), "no history: no guess")
        finally:
            shutil.rmtree(d, ignore_errors=True)


class Web(unittest.TestCase):
    def test_scripts_parse(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('no node')
        for f in sorted(os.listdir(os.path.join(ROOT, 'web'))):
            if f.endswith('.js'):
                r = subprocess.run([node, '--check', os.path.join(ROOT, 'web', f)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f'{f}: {r.stderr}')



class Search(unittest.TestCase):
    """Where flagstop looks for a stop's OSM node: as far east and west as north and south, and by whole ids."""

    def feed_with(self, stop):
        f = Feed()
        stop.location_type = '0'
        f.stops = {stop.id: stop}
        return f

    def test_a_moved_stop_is_found_due_east_as_due_west(self):
        import math
        lon0 = -111.8329   # near a grid cell's edge: one ring of cells reached ~166 m east-west here
        dlon = 290 / (111320 * math.cos(math.radians(41.74)))
        for sign in (1, -1):
            with self.subTest(side='east' if sign > 0 else 'west'):
                s = Stop('100 North Main St', lon=lon0, code='', id='77')
                o = osm('120 North Main Street', lon=lon0 + sign * dlon)
                res, _ = stops.match(self.feed_with(s), {'n1': {**o, 'type': 'node'}})
                self.assertEqual(res['77']['status'], 'moved')

    def test_a_node_claimed_twice_goes_to_the_stop_that_is_it(self):
        # route 12's temporary stop, matched by its code; a stop no bus uses parked 2 m from it by the agency
        temp = Stop('214 West 300 North (Temp Stop)', id='12532091', code='6016'); temp.location_type = '0'; temp.routes = {'r12'}
        idle = Stop('380 North 200 West, Hyrum', id='7548560', code='1220', lat=41.74 + 2 / 110540); idle.location_type = '0'
        f = Feed(); f.stops = {temp.id: temp, idle.id: idle}
        o = osm('214 West 300 North (Temp Stop)', ref='6016')
        res, _ = stops.match(f, {'n1': {**o, 'type': 'node'}})
        self.assertEqual(res['12532091']['status'], 'matched')
        self.assertEqual(res['7548560']['status'], 'missing')
        # both served, neither by code: still a question for both
        idle.routes = {'r9'}; o2 = osm('somewhere', ref='')
        res, _ = stops.match(f, {'n1': {**o2, 'type': 'node'}})
        self.assertEqual({res[x]['status'] for x in res}, {'ambiguous'})

    def test_a_stop_id_is_matched_whole_not_inside_another(self):
        s = Stop('100 North Main St', id='12', code='12')
        o = osm('Elsewhere Road', lat=41.74 + 150 / 110540, **{'gtfs:stop_id': '1234'})
        res, _ = stops.match(self.feed_with(s), {'n1': {**o, 'type': 'node'}})
        self.assertEqual(res['12']['status'], 'missing')


def synthetic_feed(path):
    """A feed with what CVTD's hasn't: two agencies, no stop codes, a route with no short name, a tram, a calendar a
    month long, no shapes.txt, and a route whose two directions call at the same stops the other way round."""
    import zipfile
    files = {
        'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA,Alpha Bus,http://a,America/Denver\nB,Beta Lines,http://b,America/Denver\n',
        'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n' + ''.join(f's{i},{100 * i} MAIN ST,{41.70 + i * 0.003:.4f},-111.83\n' for i in range(1, 6)) +
                     't1,TRAM PLATFORM,41.75,-111.80\nt2,TRAM END,41.76,-111.80\n',
        'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nr1,A,1,Main Street,3\nr2,B,,Crosstown,3\nr3,A,T,Tramway,0\n',
        'trips.txt': 'route_id,service_id,trip_id,direction_id\nr1,m,a1,0\nr1,m,a2,1\nr2,m,b1,0\nr3,m,c1,0\n',
        'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
            ''.join(f'a1,08:0{i}:00,08:0{i}:00,s{i},{i}\n' for i in range(1, 6)) +
            ''.join(f'a2,09:0{i}:00,09:0{i}:00,s{6 - i},{i}\n' for i in range(1, 6)) +
            'b1,10:00:00,10:00:00,s1,1\nb1,10:05:00,10:05:00,s3,2\nc1,11:00:00,11:00:00,t1,1\nc1,11:05:00,11:05:00,t2,2\n',
        'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nm,1,1,1,1,1,0,0,20261001,20261031\n',
    }
    with zipfile.ZipFile(path, 'w') as z:
        for k, v in files.items():
            z.writestr(k, v)


class OtherFeeds(unittest.TestCase):
    """What another agency's feed may be that CVTD's isn't (tests/test_flagstop.py synthetic_feed)."""

    @classmethod
    def setUpClass(cls):
        import tempfile, gtfs, compare
        cls.dir = tempfile.mkdtemp()
        cls.zip = os.path.join(cls.dir, 'feed.zip')
        synthetic_feed(cls.zip)
        cls.feed = gtfs.load(cls.zip)
        cls.compare = compare

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_buses_only_and_the_two_directions_apart(self):
        f = self.feed
        self.assertEqual(sorted((p.route_id, p.direction) for p in f.patterns), [('r1', '0'), ('r1', '1'), ('r2', '0')])
        self.assertEqual(f.left_out, {'0': 1})
        res, _ = stops.match(f, {})
        self.assertNotIn('t1', res, "a tram's platform isn't a bus stop to add")

    def test_a_month_long_calendar_is_not_a_detour(self):
        self.assertFalse(any(p.temporary for p in self.feed.patterns))

    def test_tags_each_agency_its_own_no_empty_refs(self):
        f = self.feed
        r2 = next(p for p in f.patterns if p.route_id == 'r2')
        t = self.compare.proposed_relation_tags(f, r2, {})
        self.assertEqual(t['operator'], 'Beta Lines')
        self.assertNotIn('ref', t)
        self.assertEqual(t['name'], 'Bus Crosstown')
        m = self.compare.proposed_master_tags(f, 'r2', {})
        self.assertNotIn('ref', m)
        st = stops.proposed_tags(f, f.stops['s1'])
        self.assertNotIn('ref', st, 'no stop code: no ref (the stop_id is an internal key)')
        self.assertEqual(st['route_ref'], '1', 'no empty route number in route_ref')
        self.assertEqual(st['gtfs:stop_id'], 's1')
        self.assertEqual(st['name'], '100 Main Street')
        self.assertEqual(stops.proposed_tags(f, f.stops['s2'])['operator'], 'Alpha Bus')

    def test_a_feed_without_codes_leaves_osm_ref_alone(self):
        d = stops.diff(self.feed, self.feed.stops['s1'], osm('100 Main Street', lat=41.703, ref='5501'))
        self.assertNotIn('ref', d)

    def test_it_builds(self):
        pt = os.path.join(self.dir, 'pt.json')
        json.dump({'elements': []}, open(pt, 'w'))
        out = os.path.join(self.dir, 'out')
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'tool', 'review.py'), self.zip, '--osm-pt', pt, '--out', out, '--cache', os.path.join(self.dir, 'cache'), '--no-others'],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn('not reviewed (flagstop maps buses): 1 tram route', r.stderr)
        d = json.load(open(os.path.join(out, 'review.json')))
        self.assertEqual(len(d['patterns']), 3)

class Lines(unittest.TestCase):
    """'16 AM' and '16 PM': one line run two ways at two times. One route_master (ref 16), a relation per way it's run
    (ref 16, the time in its name), stops list 16."""

    def routes(self, *shorts):
        import gtfs
        rs = {str(i): gtfs.Route(id=str(i), short=x, long='', desc='Logan, Preston', type='3', color='', text_color='', url='', agency='') for i, x in enumerate(shorts)}
        gtfs.lines(rs)
        return rs

    def test_time_of_day_routes_are_one_line(self):
        rs = self.routes('16 AM', '16 PM', '9 Express', '9', '4 Night', '21')
        self.assertEqual({r.short: r.ref for r in rs.values()}, {'16 AM': '16', '16 PM': '16', '9 Express': '9 Express', '9': '9', '4 Night': '4 Night', '21': '21'})

    def test_one_master_and_their_refs(self):
        import compare
        f = Feed()
        f.routes = self.routes('16 AM', '16 PM')
        m0, m1 = compare.proposed_master_tags(f, '0', {}), compare.proposed_master_tags(f, '1', {})
        self.assertEqual(m0, m1)
        self.assertEqual((m0['ref'], m0['name'], m0['gtfs:route_id']), ('16', 'Bus 16: Logan, Preston', '0;1'))
        s = Stop('100 Main St'); s.routes = {'0', '1'}
        self.assertEqual(stops.proposed_tags(f, s)['route_ref'], '16')


class KerbSide(unittest.TestCase):
    """Which side buses pull in at, from where OSM's stops with the agency's codes are: right, or left where traffic
    keeps left; and 'across the street' follows it."""

    def setup(self, east):
        f = Feed()
        path = [(-111.83, 41.70 + i * 0.001) for i in range(25)]   # northward
        osm_stops, paths = {}, {}
        for i in range(12):
            s = Stop(f'{i} Main St', lat=41.701 + i * 0.0015, lon=-111.83, id=str(i), code=f'c{i}')
            f.stops[s.id] = s
            paths[s.id] = [path]
            osm_stops[f'n{i}'] = {'id': f'n{i}', 'lat': s.lat, 'lon': -111.83 + (1 if east else -1) * 10 / 83000, 'tags': {'highway': 'bus_stop', 'ref': f'c{i}'}}
        return f, paths, osm_stops

    def test_right_and_left(self):
        for east, want in ((True, 'right'), (False, 'left')):
            with self.subTest(east=east):
                f, paths, os_ = self.setup(east)
                self.assertEqual(review.kerb_side(f, paths, os_), want)

    def test_the_kerb_side_is_never_across(self):
        f, paths, os_ = self.setup(False)
        try:
            review.KERB = review.kerb_side(f, paths, os_)
            self.assertEqual(review.side((os_['n3']['lon'], os_['n3']['lat']), paths['3'][0], kerb=5), 'right', "where traffic keeps left, the left kerb is the stop's side")
        finally:
            review.KERB = 'right'


class Detours(unittest.TestCase):
    """An itinerary on a detour: temporary stops, and stops of OSM's relation it skips."""

    def test_detour_of(self):
        p = type('P', (), {'stops': ['a', 'temp', 'b']})
        match = {'a': {'osm': [{'id': 'n1'}]}, 'temp': {'temporary': True, 'osm': []}, 'b': {'osm': [{'id': 'n3'}]}}
        rel = {'members': [{'type': 'node', 'ref': 1, 'role': 'platform'}, {'type': 'node', 'ref': 2, 'role': 'platform'}, {'type': 'node', 'ref': 3, 'role': 'platform'}, {'type': 'way', 'ref': 9, 'role': ''}]}
        self.assertEqual(review.detour_of(p, [rel], match), {'temporary': ['temp'], 'skipped': ['n2'], 'followed': False})
        rel_same = {'members': [m for m in rel['members'] if m['ref'] != 2]}
        self.assertIsNone(review.detour_of(p, [rel_same], match), "nothing skipped, the temporary stop not in it: nothing to say")
        on = dict(match, temp={'temporary': True, 'status': 'matched', 'osm': [{'id': 'n5'}]})
        rel_followed = {'members': rel_same['members'] + [{'type': 'node', 'ref': 5, 'role': 'platform'}]}
        self.assertEqual(review.detour_of(p, [rel_followed], on), {'temporary': ['temp'], 'skipped': [], 'followed': True}, 'OSM follows the detour: restorable')
        self.assertIsNone(review.detour_of(p, [], match), 'no relation')


if __name__ == '__main__':
    unittest.main()
