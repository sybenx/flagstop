"""python3 -m unittest discover -s tests

tool/sandbox.py, the stand-in for OpenStreetMap: a tiny map of its own (no snapshot needed), served on a port,
asked the questions the tool asks, in the shapes the real servers answer. Versions are checked, if-unused is
honoured, an upload is all or nothing, new ids are given back, the log replays."""
import json, os, shutil, sys, tempfile, threading, unittest, urllib.error, urllib.request
import xml.etree.ElementTree as ET
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tool'))
import sandbox   # noqa: E402

LAT, LON = 41.74, -111.83


def tiny_map():
    """A street west to east in two ways meeting at node 3 (way 100: nodes 1..3, way 102: nodes 3..5), a side
    street from there (way 101: node 3 north to 6), a bus stop (node 10) by the junction, a stop position (node 3),
    a bus route along the street, a turn restriction at the junction, and a building (way 200) in the corner."""
    meta = {'version': 1, 'timestamp': '2026-09-01T00:00:00Z', 'changeset': 1000, 'user': 'mapper', 'uid': 7}
    els = []
    for i in range(1, 6):
        els.append({'type': 'node', 'id': i, 'lat': LAT, 'lon': LON + (i - 1) * 0.001, **meta})
    els.append({'type': 'node', 'id': 6, 'lat': LAT + 0.001, 'lon': LON + 0.002, **meta})
    els.append({'type': 'node', 'id': 10, 'lat': LAT - 0.0001, 'lon': LON + 0.002, 'tags': {'highway': 'bus_stop', 'public_transport': 'platform', 'bus': 'yes', 'name': 'Main & 3rd'}, **meta})
    els[2]['tags'] = {'public_transport': 'stop_position', 'bus': 'yes'}
    els.append({'type': 'way', 'id': 100, 'nodes': [1, 2, 3], 'tags': {'highway': 'residential', 'name': 'Main Street'}, **meta})
    els.append({'type': 'way', 'id': 102, 'nodes': [3, 4, 5], 'tags': {'highway': 'residential', 'name': 'Main Street'}, **meta})
    els.append({'type': 'way', 'id': 101, 'nodes': [3, 6], 'tags': {'highway': 'service'}, **meta})
    for i in (20, 21, 22):
        els.append({'type': 'node', 'id': i, 'lat': LAT + 0.0005 + (i - 20) * 0.0001, 'lon': LON + 0.0005, **meta})
    els.append({'type': 'way', 'id': 200, 'nodes': [20, 21, 22, 20], 'tags': {'building': 'yes'}, **meta})
    els.append({'type': 'relation', 'id': 300, 'tags': {'type': 'route', 'route': 'bus', 'ref': '1', 'name': 'Bus 1'},
                'members': [{'type': 'node', 'ref': 3, 'role': 'stop'}, {'type': 'node', 'ref': 10, 'role': 'platform'}, {'type': 'way', 'ref': 100, 'role': ''}, {'type': 'way', 'ref': 102, 'role': ''}], **meta})
    els.append({'type': 'relation', 'id': 301, 'tags': {'type': 'route_master', 'route_master': 'bus', 'ref': '1'}, 'members': [{'type': 'relation', 'ref': 300, 'role': ''}], **meta})
    els.append({'type': 'relation', 'id': 302, 'tags': {'type': 'restriction', 'restriction': 'no_left_turn'},
                'members': [{'type': 'way', 'ref': 100, 'role': 'from'}, {'type': 'node', 'ref': 3, 'role': 'via'}, {'type': 'way', 'ref': 101, 'role': 'to'}], **meta})
    return {'version': 0.6, 'elements': els, 'sandbox': {'date': '2026-09-27T00:00:00Z'}}


class SandboxTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        sandbox.DIR = cls.dir
        sandbox.LOG = os.path.join(cls.dir, 'changes.json')
        cls.base = os.path.join(cls.dir, 'base-test.json')
        json.dump(tiny_map(), open(cls.base, 'w'))
        os.environ['SANDBOX_QUIET'] = '1'
        cls.start()

    @classmethod
    def start(cls):
        cls.store = sandbox.Store(cls.base)
        cls.store.load_log()
        sandbox.Handler.store, sandbox.Handler.overpass = cls.store, sandbox.Overpass(cls.store)
        cls.srv = ThreadingHTTPServer(('127.0.0.1', 0), sandbox.Handler)
        cls.url = f'http://127.0.0.1:{cls.srv.server_port}'
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        # every test starts from the snapshot: a fresh store on the same server
        self.store.__init__(self.base)
        sandbox.Handler.store, sandbox.Handler.overpass = self.store, sandbox.Overpass(self.store)
        if os.path.exists(sandbox.LOG):
            os.remove(sandbox.LOG)

    # --- a client like the tool's ---
    def call(self, method, path, body=None, ctype='text/xml', auth=True):
        req = urllib.request.Request(self.url + path, data=body.encode() if isinstance(body, str) else body, method=method,
                                     headers={'Content-Type': ctype, **({'Authorization': 'Bearer t'} if auth else {})})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read().decode()

    def get(self, path):
        code, body = self.call('GET', path)
        self.assertEqual(code, 200, body)
        return json.loads(body)

    def upload(self, osc_body, comment='test'):
        code, cid = self.call('PUT', '/api/0.6/changeset/create', f'<osm><changeset><tag k="comment" v="{comment}"/><tag k="created_by" v="flagstop"/></changeset></osm>')
        self.assertEqual(code, 200, cid)
        code, diff = self.call('POST', f'/api/0.6/changeset/{cid}/upload', f'<osmChange version="0.6" generator="flagstop">\n{osc_body.replace("CS", cid)}</osmChange>')
        if code == 200:
            self.assertEqual(self.call('PUT', f'/api/0.6/changeset/{cid}/close')[0], 200)
        return code, diff, int(cid)

    # --- reads ---
    def test_reads_as_the_api_answers(self):
        n = self.get('/api/0.6/node/10.json')['elements'][0]
        self.assertEqual((n['version'], n['tags']['name'], n['lat']), (1, 'Main & 3rd', LAT - 0.0001))
        w = self.get('/api/0.6/way/100/full.json')['elements']
        self.assertEqual([e['type'] for e in w], ['node'] * 3 + ['way'])
        self.assertEqual(self.get('/api/0.6/way/100/history.json')['elements'][0]['version'], 1)
        self.assertEqual([e['id'] for e in self.get('/api/0.6/node/3/ways.json')['elements']], [100, 101, 102])
        self.assertEqual(sorted(e['id'] for e in self.get('/api/0.6/node/3/relations.json')['elements']), [300, 302])
        self.assertEqual([e['id'] for e in self.get('/api/0.6/nodes.json?nodes=1,10')['elements']], [1, 10])
        m = self.get(f'/api/0.6/map.json?bbox={LON + 0.0015},{LAT - 0.0005},{LON + 0.0025},{LAT + 0.0005}')['elements']
        self.assertEqual({e['type'] + str(e['id']) for e in m if e['type'] != 'node'}, {'way100', 'way101', 'way102', 'relation300', 'relation302'})
        self.assertTrue({e['id'] for e in m if e['type'] == 'node'} >= {1, 2, 3, 4, 5, 6, 10}, 'the ways come whole')
        self.assertEqual(self.call('GET', '/api/0.6/node/999.json')[0], 404)
        self.assertEqual(self.get('/api/0.6/notes.json?bbox=0,0,1,1')['features'], [])
        self.assertEqual(self.get('/api/0.6/user/details.json')['user']['display_name'], 'sandbox')
        self.assertEqual(self.call('GET', '/api/0.6/user/details.json', auth=False)[0], 401)

    def test_sign_in_round_trip(self):
        req = urllib.request.Request(self.url + '/oauth2/authorize?response_type=code&client_id=sandbox&redirect_uri=http://127.0.0.1:1/&code_challenge=x')
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        try:
            urllib.request.build_opener(NoRedirect).open(req)
        except urllib.error.HTTPError as e:
            with e:
                self.assertEqual(e.code, 302); self.assertEqual(e.headers['Location'], 'http://127.0.0.1:1/?code=sandbox')
        code, body = self.call('POST', '/oauth2/token', 'grant_type=authorization_code&code=sandbox', 'application/x-www-form-urlencoded')
        self.assertEqual(code, 200); self.assertIn('access_token', json.loads(body))

    # --- Overpass ---
    def test_overpass_answers_the_tools_queries(self):
        import osm
        bbox = f'{LAT - 0.01},{LON - 0.01},{LAT + 0.01},{LON + 0.01}'
        code, body = self.call('POST', '/api/interpreter', urllib.parse.urlencode({'data': osm.PT_QUERY.format(bbox=bbox)}), 'application/x-www-form-urlencoded')
        self.assertEqual(code, 200, body)
        stops, routes, masters, ways, nodes = osm.parse_pt(json.loads(body))
        self.assertEqual((set(stops), set(routes), set(masters), set(ways)), ({'n10', 'n3'}, {300}, {301}, {100, 102}))
        self.assertEqual(stops['n10']['version'], 1)
        code, body = self.call('POST', '/api/interpreter', urllib.parse.urlencode({'data': osm.ROADS_QUERY.format(bbox=bbox)}), 'application/x-www-form-urlencoded')
        self.assertEqual(code, 200, body)
        els = json.loads(body)['elements']
        self.assertEqual({(e['type'], e['id']) for e in els if e['type'] != 'node'}, {('way', 100), ('way', 101), ('way', 102), ('relation', 302)})
        self.assertEqual({e['id'] for e in els if e['type'] == 'node'}, {1, 2, 3, 4, 5, 6})   # not the building's
        self.assertNotIn('version', els[0], 'out body: no meta')
        code, body = self.call('POST', '/api/interpreter', urllib.parse.urlencode({'data': 'node["amenity"="cafe"](1,2,3,4);out;'}), 'application/x-www-form-urlencoded')
        self.assertEqual(code, 400); self.assertIn('query shape', body)

    # --- writes ---
    def test_upload_creates_modifies_deletes_and_answers_with_new_ids(self):
        code, diff, cid = self.upload('''<create>
  <node id="-1" changeset="CS" lat="41.7401" lon="-111.8290"><tag k="highway" v="bus_stop"/></node>
  <way id="-2" changeset="CS"><nd ref="-1"/><nd ref="5"/><tag k="highway" v="service"/></way>
  <relation id="-3" changeset="CS"><member type="node" ref="-1" role="platform"/><member type="way" ref="-2" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/></relation>
</create>
<modify>
  <node id="10" version="1" changeset="CS" lat="41.7399" lon="-111.828"><tag k="highway" v="bus_stop"/><tag k="name" v="Main &amp; 3rd"/><tag k="ref" v="123"/></node>
</modify>
<delete if-unused="true">
  <node id="3" version="1" changeset="CS" lat="41.74" lon="-111.828"/>
  <way id="200" version="1" changeset="CS"/>
  <node id="20" version="1" changeset="CS" lat="0" lon="0"/>
</delete>
''')
        self.assertEqual(code, 200, diff)
        got = {(e.tag, e.get('old_id')): e.attrib for e in ET.fromstring(diff)}
        self.assertEqual(got[('node', '-1')]['new_version'], '1'); nid = int(got[('node', '-1')]['new_id']); self.assertGreater(nid, 22)
        self.assertEqual(got[('node', '10')]['new_version'], '2')
        self.assertIn('new_id', got[('node', '3')], 'if-unused: a node in a way and a route is kept, and said')
        self.assertNotIn('new_id', got[('way', '200')], 'deleted')
        self.assertNotIn('new_id', got[('node', '20')], 'deleted, its way going in the same upload')
        # what the data says now
        self.assertEqual(self.get(f'/api/0.6/node/{nid}.json')['elements'][0]['tags'], {'highway': 'bus_stop'})
        new_way = int(got[('way', '-2')]['new_id'])
        self.assertEqual(self.get(f'/api/0.6/way/{new_way}.json')['elements'][0]['nodes'], [nid, 5])
        self.assertEqual(self.get(f'/api/0.6/relation/{int(got[("relation", "-3")]["new_id"])}.json')['elements'][0]['members'][1]['ref'], new_way)
        n10 = self.get('/api/0.6/node/10.json')['elements'][0]
        self.assertEqual((n10['version'], n10['tags']['ref'], n10['changeset']), (2, '123', cid))
        self.assertEqual(self.call('GET', '/api/0.6/way/200.json')[0], 410)
        self.assertEqual(self.get('/api/0.6/node/3.json')['elements'][0]['version'], 1, 'kept')
        self.assertEqual(self.get('/api/0.6/ways.json?ways=200')['elements'][0]['visible'], False)
        self.assertEqual(self.get('/api/0.6/node/3.json')['elements'][0]['version'], 1)
        self.assertEqual(len(self.get('/api/0.6/way/200/history.json')['elements']), 2)
        # the changeset, as patch.py reads it
        cs = ET.fromstring(self.call('GET', f'/api/0.6/changeset/{cid}')[1]).find('changeset')
        self.assertTrue(cs.get('closed_at')); self.assertEqual(cs.get('open'), 'false')
        dl = ET.fromstring(self.call('GET', f'/api/0.6/changeset/{cid}/download')[1])
        self.assertEqual([b.tag for b in dl], ['create', 'modify', 'delete'])
        self.assertEqual([e.tag for e in dl[0]], ['node', 'way', 'relation'])
        self.assertEqual(dl[0][1].find('nd').get('ref'), str(nid), 'the download carries the real ids')
        self.assertEqual(dl[1][0].get('version'), '2')
        self.assertEqual(sorted(e.get('id') for e in dl[2]), ['20', '200'])
        js = self.get(f'/api/0.6/changeset/{cid}.json?include_discussion=true')['changeset']
        self.assertEqual((js['tags']['comment'], js['comments'], js['changes_count']), ('test', [], 6))
        self.assertEqual(self.call('GET', '/api/0.6/way/102.json')[0], 200)
        self.assertEqual(self.get('/api/0.6/changesets.json?user=1&limit=25')['changesets'][0]['id'], cid)

    def test_a_relation_dropped_from_its_master_can_go_in_the_same_upload(self):
        """The master loses the route in <modify>, then <delete if-unused> takes the route: OSM judges if-unused on the
        data as it then is, so it goes. (A flagstop merge does exactly this.)"""
        code, diff, cid = self.upload('<modify>\n  <relation id="301" version="1" changeset="CS"><tag k="type" v="route_master"/><tag k="route_master" v="bus"/><tag k="ref" v="1"/></relation>\n</modify>\n'
                                      '<delete if-unused="true">\n  <relation id="300" version="1" changeset="CS"/>\n</delete>\n')
        self.assertEqual(code, 200, diff)
        got = {(e.tag, e.get('old_id')): e.attrib for e in ET.fromstring(diff)}
        self.assertNotIn('new_id', got[('relation', '300')], 'deleted, not kept')
        self.assertEqual(self.call('GET', '/api/0.6/relation/300.json')[0], 410)

    def test_stale_version_is_a_conflict_and_nothing_changes(self):
        code, diff, cid = self.upload('''<modify>
  <node id="10" version="1" changeset="CS" lat="41.7399" lon="-111.828"><tag k="name" v="A"/></node>
  <node id="1" version="7" changeset="CS" lat="41.74" lon="-111.83"/>
</modify>
''')
        self.assertEqual(code, 409); self.assertIn('Version mismatch', diff); self.assertIn('Node 1', diff)
        self.assertEqual(self.get('/api/0.6/node/10.json')['elements'][0]['tags']['name'], 'Main & 3rd', 'the first modify was rolled back too')
        self.assertEqual(self.get('/api/0.6/node/10.json')['elements'][0]['version'], 1)
        self.assertEqual(self.get(f'/api/0.6/changeset/{cid}.json')['changeset']['changes_count'], 0)

    def test_delete_of_a_used_object_without_if_unused_is_refused(self):
        code, diff, _ = self.upload('<delete>\n  <node id="3" version="1" changeset="CS" lat="0" lon="0"/>\n</delete>\n')
        self.assertEqual(code, 412); self.assertIn('still used by', diff)
        code, diff, _ = self.upload('<delete>\n  <way id="100" version="1" changeset="CS"/>\n</delete>\n')
        self.assertEqual(code, 412); self.assertIn('relation 300', diff)

    def test_a_way_needs_its_nodes_and_two_of_them(self):
        code, diff, _ = self.upload('<create>\n  <way id="-1" changeset="CS"><nd ref="1"/><nd ref="999"/></way>\n</create>\n')
        self.assertEqual(code, 412); self.assertIn('node 999', diff)
        code, diff, _ = self.upload('<create>\n  <way id="-1" changeset="CS"><nd ref="1"/></way>\n</create>\n')
        self.assertEqual(code, 412)

    def test_closed_changeset_takes_no_more(self):
        code, diff, cid = self.upload('<modify>\n  <node id="1" version="1" changeset="CS" lat="41.74" lon="-111.83"/>\n</modify>\n')
        self.assertEqual(code, 200)
        code, body = self.call('POST', f'/api/0.6/changeset/{cid}/upload', '<osmChange/>')
        self.assertEqual(code, 409)

    def test_the_pages_own_upload_code_against_it(self):
        """web/edits.js, under node, as the page runs it: check(), a changeset, the osmChange, the diffResult read back."""
        import subprocess
        if not shutil.which('node'):
            self.skipTest('no node')
        r = subprocess.run(['node', os.path.join(ROOT, 'tests', 'sandbox_upload.js'), self.url], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(out['id'], '1'); self.assertEqual(out['skipped'], []); self.assertEqual(out['left'], [])
        self.assertEqual(out['after']['node10']['tags']['name'], 'Main & 3rd (renamed)')
        self.assertEqual(out['after']['node10']['version'], 2)
        self.assertEqual(out['after']['created']['tags']['name'], 'New stop')
        self.assertEqual(out['after']['rel300']['members'][-1], {'type': 'node', 'ref': out['after']['created']['id'], 'role': 'platform'})
        self.assertIn('n10', out['uploaded']); self.assertIn('r300', out['uploaded'])
        self.assertEqual(self.get('/api/0.6/changesets.json?user=1')['changesets'][0]['tags']['created_by'], 'flagstop')

    def test_a_live_reset_is_the_snapshot_again_and_a_new_generation(self):
        code, diff, cid = self.upload('<modify>\n  <node id="10" version="1" changeset="CS" lat="41.7399" lon="-111.828"><tag k="name" v="Renamed"/></node>\n</modify>\n')
        self.assertEqual(code, 200, diff)
        before = self.get('/sandbox.json')
        self.assertEqual(before['changesets'], 1)
        code, body = self.call('POST', '/reset', '', 'text/plain', auth=False)
        self.assertEqual(code, 200, body)
        after = self.get('/sandbox.json')
        self.assertEqual(after['changesets'], 0)
        self.assertNotEqual(after['generation'], before['generation'])
        self.assertEqual(self.get('/api/0.6/node/10.json')['elements'][0]['tags']['name'], 'Main & 3rd', 'the snapshot again')
        self.assertFalse(os.path.exists(sandbox.LOG))
        # the server now answers from the fresh store (the class attribute was swapped): later tests start from it too
        self.store = sandbox.Handler.store

    def test_the_log_replays_on_start(self):
        code, diff, cid = self.upload('<create>\n  <node id="-1" changeset="CS" lat="41.7401" lon="-111.829"><tag k="highway" v="bus_stop"/></node>\n</create>\n', 'first')
        nid = int(ET.fromstring(diff)[0].get('new_id'))
        code, diff, cid2 = self.upload(f'<modify>\n  <node id="{nid}" version="1" changeset="CS" lat="41.7402" lon="-111.829"><tag k="highway" v="bus_stop"/><tag k="name" v="New"/></node>\n</modify>\n', 'second')
        self.assertEqual(code, 200, diff)
        # the server comes up again from the snapshot and the log
        fresh = sandbox.Store(self.base)
        self.assertEqual(fresh.load_log(), 2)
        self.assertEqual((fresh.el['node'][nid]['version'], fresh.el['node'][nid]['tags']['name']), (2, 'New'))
        self.assertEqual(fresh.changesets[cid2]['tags']['comment'], 'second')
        self.assertEqual(fresh.next_id['node'], nid + 1)
        # reset: the snapshot again
        os.remove(sandbox.LOG)
        self.assertEqual(sandbox.Store(self.base).load_log(), 0)


class ReportTest(unittest.TestCase):
    """sandbox.report: each fault planted by hand fails exactly its line; a clean upload passes them all."""
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        sandbox.DIR = cls.dir; sandbox.LOG = os.path.join(cls.dir, 'changes.json')
        cls.base = os.path.join(cls.dir, 'base-test.json')
        json.dump(tiny_map(), open(cls.base, 'w'))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def uploaded(self, osc, tags=None):
        st = sandbox.Store(self.base)
        cid = st.create_changeset(tags if tags is not None else {'comment': 'a test', 'created_by': 'flagstop', 'source': 'GTFS'})
        st.upload(cid, f'<osmChange version="0.6">{osc.replace("CS", str(cid))}</osmChange>')
        st.close_changeset(cid)
        return st

    def failing(self, st):
        return {x['check']: x for x in sandbox.report(st) if not x['ok']}

    def test_a_clean_rewrite_passes(self):
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="node" ref="3" role="stop"/><member type="node" ref="10" role="platform"/>'
                           '<member type="way" ref="100" role=""/><member type="way" ref="102" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/><tag k="name" v="Bus 1"/><tag k="roundtrip" v="no"/></relation></modify>')
        self.assertEqual(self.failing(st), {})
        self.assertGreater(len(sandbox.report(st)), 8)

    def test_stops_after_the_roads(self):
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="way" ref="100" role=""/><member type="node" ref="10" role="platform"/><tag k="type" v="route"/><tag k="route" v="bus"/></relation></modify>')
        self.assertEqual(set(self.failing(st)), {'PTv2 order: stops and platforms, then the roads'})

    def test_a_road_twice_and_a_gap(self):
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="node" ref="10" role="platform"/><member type="way" ref="100" role=""/><member type="way" ref="100" role=""/>'
                           '<member type="way" ref="101" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/></relation></modify>')
        f = self.failing(st)
        self.assertEqual(set(f), {'no road twice in a row', 'roads chained end to end'})
        self.assertIn('between w100 and w101', f['roads chained end to end']['what'])

    def test_not_a_road(self):
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="node" ref="10" role="platform"/><member type="way" ref="200" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/></relation></modify>')
        f = self.failing(st)
        self.assertEqual(set(f), {'roads drivable by a bus'})
        self.assertIn('w200', f['roads drivable by a bus']['what'])   # a building is not a road

    def test_roundtrip_that_does_not_close(self):
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="node" ref="10" role="platform"/><member type="way" ref="100" role=""/><member type="way" ref="102" role=""/>'
                           '<tag k="type" v="route"/><tag k="route" v="bus"/><tag k="roundtrip" v="yes"/></relation></modify>')
        self.assertEqual(set(self.failing(st)), {'roundtrip=yes closes'})

    def test_a_one_way_driven_against(self):
        # the side street made one-way northbound, and the route driving it south into the street
        st = self.uploaded('<modify><way id="101" version="1" changeset="CS"><nd ref="3"/><nd ref="6"/><tag k="highway" v="service"/><tag k="oneway" v="yes"/></way>'
                           '<relation id="300" version="1" changeset="CS"><member type="node" ref="10" role="platform"/><member type="way" ref="101" role=""/><member type="way" ref="102" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/></relation></modify>')
        f = self.failing(st)
        self.assertEqual(set(f), {'no one-way driven against'}); self.assertEqual(f['no one-way driven against']['objects'], ['w101'])

    def test_a_stop_position_off_the_route(self):
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="node" ref="3" role="stop"/><member type="way" ref="101" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/></relation></modify>')
        self.assertEqual(self.failing(st), {})   # n3 is on w101
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="node" ref="6" role="stop"/><member type="way" ref="100" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/></relation></modify>')
        self.assertEqual(set(self.failing(st)), {"stop positions on the route's roads", 'a stop role is a stop_position'})

    def test_a_new_node_doubling_an_old_one(self):
        st = self.uploaded('<create><node id="-1" changeset="CS" lat="41.7399001" lon="-111.828"><tag k="highway" v="bus_stop"/><tag k="public_transport" v="platform"/><tag k="bus" v="yes"/><tag k="name" v="Main &amp; 3rd"/></node></create>')
        f = self.failing(st)
        self.assertEqual(set(f), {"a new node doesn't double an old one"}); self.assertIn('n10', f["a new node doesn't double an old one"]['what'])

    def test_a_split_repaired_and_one_not(self):
        # w100 [1,2,3] split at 2: the piece at the junction keeps the id, the route lists both pieces: all whole
        st = self.uploaded('<create><way id="-1" changeset="CS"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></create>'
                           '<modify><way id="100" version="1" changeset="CS"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way>'
                           '<relation id="300" version="1" changeset="CS"><member type="node" ref="3" role="stop"/><member type="node" ref="10" role="platform"/><member type="way" ref="-1" role=""/><member type="way" ref="100" role=""/><member type="way" ref="102" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/></relation></modify>')
        self.assertEqual(self.failing(st), {})
        # the piece at the junction given to the new way, and nothing told: the restriction's from no longer reaches via, the route has a gap
        st = self.uploaded('<create><way id="-1" changeset="CS"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way></create>'
                           '<modify><way id="100" version="1" changeset="CS"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></modify>')
        f = self.failing(st)
        self.assertEqual(set(f), {'restriction from/to still touch via', 'roads chained end to end'})
        self.assertEqual(f['restriction from/to still touch via']['objects'], ['r302', 'w100'])

    def test_a_second_relation_for_the_same_itinerary(self):
        st = self.uploaded('<modify><relation id="300" version="1" changeset="CS"><member type="node" ref="10" role="platform"/><member type="way" ref="100" role=""/><member type="way" ref="102" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/><tag k="gtfs:route_id" v="1"/><tag k="gtfs:shape_id" v="s1"/></relation></modify>'
                           '<create><relation id="-1" changeset="CS"><member type="node" ref="10" role="platform"/><member type="way" ref="100" role=""/><member type="way" ref="102" role=""/><tag k="type" v="route"/><tag k="route" v="bus"/><tag k="gtfs:route_id" v="1"/><tag k="gtfs:shape_id" v="s1"/></relation></create>')
        f = self.failing(st)
        self.assertEqual(set(f), {'one relation per itinerary'})

    def test_a_second_master_for_the_same_route(self):
        st = self.uploaded('<create><relation id="-1" changeset="CS"><member type="relation" ref="300" role=""/><tag k="type" v="route_master"/><tag k="route_master" v="bus"/><tag k="ref" v="1 AM"/></relation></create>')
        f = self.failing(st)
        self.assertEqual(set(f), {'a route is in one master', 'no second master for the same routes'})
        self.assertIn('r301', f['no second master for the same routes']['what'])

    def test_the_changeset_itself(self):
        st = self.uploaded('<modify><node id="1" version="1" changeset="CS" lat="41.74" lon="-111.83"/></modify>', tags={'comment': 'x' * 300})
        f = self.failing(st)
        self.assertEqual(set(f), {'changeset says who and why', 'changeset comment fits'})


if __name__ == '__main__':
    unittest.main()
