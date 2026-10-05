"""python3 -m unittest discover -s tests

The relation files the review writes for JOSM (web/data/rel-*.osm, review.write_relation_osm): what a mapper
would load and upload. Parsed as XML, the stops and platforms before the roads, no road listed twice in a row.
Needs a build's files: skipped when there are none."""
import glob, os, unittest
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = sorted(glob.glob(os.path.join(ROOT, 'web', 'data', 'rel-*.osm')))
STOP_ROLES = ('stop', 'platform')   # write_relation_osm gives the stops 'platform'; PTv2 also has 'stop'


class RelationFiles(unittest.TestCase):
    def setUp(self):
        if not FILES:
            self.skipTest('no web/data/rel-*.osm: run tool/review.py first')

    def each(self):
        for path in FILES:
            with self.subTest(file=os.path.basename(path)):
                root = ET.parse(path).getroot()   # parses, or the subtest fails
                rels = root.findall('relation')
                self.assertEqual(len(rels), 1, 'one proposed relation per file')
                yield root, [(m.get('type'), m.get('ref'), m.get('role')) for m in rels[0].findall('member')]

    def test_parses_with_a_route_and_members(self):
        for root, members in self.each():
            self.assertEqual(root.tag, 'osm')
            self.assertTrue(members, 'a relation with no members')
            self.assertTrue(any(t == 'way' for t, _, _ in members), 'a route with no roads')
            for t, ref, role in members:
                self.assertIn(t, ('node', 'way'))
                self.assertTrue(ref.lstrip('-').isdigit(), ref)
            tags = {t.get('k'): t.get('v') for t in root.find('relation').findall('tag')}
            self.assertEqual(tags.get('type'), 'route')

    def test_stops_come_before_the_roads(self):
        for root, members in self.each():
            kinds = [t for t, _, _ in members]
            first_way = kinds.index('way')
            self.assertNotIn('node', kinds[first_way:], 'a stop listed after the roads started')
            for t, _, role in members:
                self.assertEqual(role in STOP_ROLES, t == 'node', f'{t} with role {role!r}')

    def test_a_stop_member_precedes_its_platform(self):
        """In PTv2 order a stop position comes right before its platform. Only holds where a file has any `stop`."""
        for root, members in self.each():
            platform_at = {}
            for i, (t, ref, role) in enumerate(members):
                if role == 'stop':
                    platform_at[i] = ref
            for i in platform_at:
                nxt = members[i + 1] if i + 1 < len(members) else None
                self.assertTrue(nxt and nxt[2] == 'platform', f'stop {platform_at[i]} not followed by its platform')

    def test_no_road_twice_in_a_row(self):
        for root, members in self.each():
            ways = [ref for t, ref, _ in members if t == 'way']
            for a, b in zip(ways, ways[1:]):
                self.assertNotEqual(a, b, f'way {a} listed twice in a row')

    def test_new_nodes_are_defined_in_the_file(self):
        """A negative member id is a node this file makes; a member that refers to one must find it."""
        for root, members in self.each():
            defined = {n.get('id') for n in root.findall('node')}
            for t, ref, _ in members:
                if ref.startswith('-'):
                    self.assertIn(ref, defined, f'{t} {ref} is not in the file')


if __name__ == '__main__':
    unittest.main()
