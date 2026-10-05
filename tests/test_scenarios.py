"""python3 -m unittest discover -s tests   (or: python3 tests/test_scenarios.py [-k name])

Scenarios: the same situations, every time. Each tests/scenarios/*.json is run against a fresh sandbox
(tool/sandbox.py, in this process, on a free port, no log): a node driver (tests/scenario_driver.js) takes the
steps with the page's own modules (web/edits.js, web/roads.js), then sandbox.report() judges what is in the
sandbox, and the scenario's expectations are compared with it.

A scenario:
  {"name": ..., "about": ..., "base": "tiny" | "snapshot", "steps": [...], "expect": {...}}
  base      "tiny": test_sandbox.tiny_map(); "snapshot": the newest cache/sandbox/base-*.json (skipped when there is none)
  steps     in order, each an object with one key, the kind of step:
    {"createNode": {lat, lon, tags, note, as}}                a new node in the basket; `as` names it for later steps
    {"modify": {type, id | as, changes, note}}                base version/tags/members are read from the sandbox. changes:
                                                              {tags, removeTags, lat, lon, nodes, members,
                                                               insertMembers: {at, members}}; a member is {type, ref, role}
                                                               or {as, role}; a way's node may be {as}
    {"delete": {type, id, note}}
    {"split": {way, node, bbox: [l, b, r, t], as}}            Roads.load(bbox), Roads.splitAt (relations repaired); `as` = the new way
    {"sandboxEdit": {osc, comment}}                           an edit by someone else, straight to the API, its own changeset;
                                                              "{cs}" in the osmChange stands for the changeset id
    {"upload": {comment, expect: "ok" | "conflict"}}          Edits.upload. "conflict": it must stop naming the keys, no changeset made
    {"replay": {changesets: [ids]}}                           real OSM changesets (read-only, cached in cache/sandbox/replay/) rewritten
                                                              for the sandbox and uploaded, in order (tool/sandbox.py replay)
  expect    {report, steps, data}, all optional but report
    report  "all pass" | ["name of a check that must fail", ...] (those, and no others)
    steps   [{step: N, path, equals | contains | exists}]     against the driver's JSON line for step N (0-based)
    data    [{get: "/api/0.6/...", path, equals | contains | exists}]   against the sandbox after the run, or
            (contains: a value in a list or a string; a list in a list is a run of items in that order)
            {changesets: N}                                            the number of changesets in the sandbox
  path      dotted: a key, a list index, or * for every item ("elements.0.members.*.ref")
  $name     in a get URL or an equals/contains value: the id the sandbox gave what was made `as` name
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile, threading, unittest, urllib.request
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tool'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sandbox                      # noqa: E402
from test_sandbox import tiny_map   # noqa: E402

SCENARIOS = sorted(glob.glob(os.path.join(ROOT, 'tests', 'scenarios', '*.json')))
SNAPSHOT = sandbox.latest_base()    # looked up now: the tests move sandbox.DIR to a temp dir


def walk(obj, path):
    """obj at a dotted path; '*' maps over a list. KeyError when it isn't there."""
    if not path:
        return obj
    head, _, rest = path.partition('.')
    if head == '*':
        return [walk(x, rest) for x in obj]
    try:
        return walk(obj[int(head)] if isinstance(obj, list) else obj[head], rest)
    except (KeyError, IndexError, TypeError, ValueError):
        raise KeyError(path)


def subst(x, names):
    if isinstance(x, str):
        return names[x[1:]] if re.fullmatch(r'\$\w+', x) and x[1:] in names else re.sub(r'\$(\w+)', lambda m: str(names.get(m.group(1), m.group(0))), x)
    if isinstance(x, list):
        return [subst(y, names) for y in x]
    return x


def judge(got_fn, a, names):
    """One assertion {path, equals | contains | exists}: [] when it holds, else what's wrong."""
    path = a.get('path', '')
    try:
        got = walk(got_fn, path)
    except KeyError:
        return [] if a.get('exists') is False else [f'{path}: not there']
    if 'exists' in a:
        return [] if a['exists'] else [f'{path}: is there ({got!r})']
    if 'equals' in a:
        want = subst(a['equals'], names)
        return [] if got == want else [f'{path}: {got!r}, wanted {want!r}']
    if 'contains' in a:
        want = subst(a['contains'], names)
        if isinstance(want, list) and isinstance(got, list):   # a run of items, in that order, somewhere in the list
            ok = any(got[i:i + len(want)] == want for i in range(len(got) - len(want) + 1))
        else:
            ok = want in got
        return [] if ok else [f'{path}: {got!r} does not contain {want!r}']
    return [f'{a}: nothing to check']


class Sandboxed:
    """A sandbox on a free port with a base map, in this process, the way tests/test_sandbox.py starts one."""
    def __init__(self, base):
        self.dir = tempfile.mkdtemp()
        self.saved = (sandbox.DIR, sandbox.LOG, os.environ.get('SANDBOX_QUIET'), sandbox.Handler.__dict__.get('store'), sandbox.Handler.__dict__.get('overpass'))
        sandbox.DIR = self.dir
        sandbox.LOG = os.path.join(self.dir, 'changes.json')
        os.environ['SANDBOX_QUIET'] = '1'
        if base == 'tiny':
            path = os.path.join(self.dir, 'base-tiny.json')
            json.dump(tiny_map(), open(path, 'w'))
        else:
            path = SNAPSHOT
        self.store = sandbox.Store(path)
        sandbox.Handler.store, sandbox.Handler.overpass = self.store, sandbox.Overpass(self.store)
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), sandbox.Handler)
        self.url = f'http://127.0.0.1:{self.srv.server_port}'
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown(); self.srv.server_close()
        sandbox.DIR, sandbox.LOG = self.saved[:2]
        if self.saved[2] is None:
            os.environ.pop('SANDBOX_QUIET', None)
        else:
            os.environ['SANDBOX_QUIET'] = self.saved[2]
        if self.saved[3] is not None:
            sandbox.Handler.store, sandbox.Handler.overpass = self.saved[3], self.saved[4]
        shutil.rmtree(self.dir, ignore_errors=True)

    def get(self, path):
        with urllib.request.urlopen(self.url + path, timeout=30) as r:
            return json.loads(r.read().decode())


def run_scenario(sc):
    """-> (problems [str], the driver's lines [dict], the report [dict]) for a scenario dict."""
    sb = Sandboxed(sc['base'])
    try:
        fd, path = tempfile.mkstemp(suffix='.json'); os.close(fd)
        json.dump(sc, open(path, 'w'))
        try:
            r = subprocess.run(['node', os.path.join(ROOT, 'tests', 'scenario_driver.js'), sb.url, path], capture_output=True, text=True, timeout=900)
        finally:
            os.remove(path)
        lines = [json.loads(x) for x in r.stdout.splitlines() if x.startswith('{')]
        problems = []
        final = lines[-1] if lines else {}
        if r.returncode != 0 or not final.get('ok'):
            bad = [x for x in lines if x.get('ok') is False and 'step' in x]
            return [f'the driver stopped: {bad[0] if bad else r.stdout[-500:] + r.stderr[-800:]}'], lines, []
        names = final.get('names', {})
        steps = {x['step']: x for x in lines if 'step' in x}
        rep = sandbox.report(sb.store)
        expect = sc.get('expect', {})
        failing = sorted({x['check'] for x in rep if not x['ok']})
        want = expect.get('report', 'all pass')
        if want == 'all pass':
            if failing:
                problems.append('the report should pass, and fails: ' + '; '.join(f'{x["check"]}: {x["what"]}' for x in rep if not x['ok']))
            elif not rep:
                problems.append('the report has no checks: nothing was judged')
        elif failing != sorted(want):
            problems.append(f'the report should fail exactly {sorted(want)}, and fails {failing}')
        for a in expect.get('steps', []):
            problems += [f'step {a["step"]} {p}' for p in judge(steps.get(a['step'], {}), a, names)]
        for a in expect.get('data', []):
            if 'changesets' in a:
                n = len(sb.store.changesets)
                if n != a['changesets']:
                    problems.append(f'{n} changesets in the sandbox, wanted {a["changesets"]}')
                continue
            url = subst(a['get'], names)
            try:
                got = sb.get(url)
            except Exception as e:
                problems.append(f'{url}: {e}'); continue
            problems += [f'{url} {p}' for p in judge(got, a, names)]
        return problems, lines, rep
    finally:
        sb.close()


class ScenarioTest(unittest.TestCase):
    pass


def _make(path):
    sc = json.load(open(path))

    def test(self):
        if not shutil.which('node'):
            self.skipTest('no node')
        if sc['base'] == 'snapshot' and not SNAPSHOT:
            self.skipTest('no snapshot in cache/sandbox/ (python3 tool/sandbox.py snapshot)')
        wanted = [i for st in sc['steps'] for i in st.get('replay', {}).get('changesets', [])]
        if any(not os.path.exists(os.path.join(ROOT, 'cache', 'sandbox', 'replay', f'{i}.{x}')) for i in wanted for x in ('osc', 'json')):
            try:   # the first run downloads them, read-only, from the real API
                urllib.request.urlopen(urllib.request.Request(sandbox.REAL_API + '/api/0.6/capabilities', headers=sandbox.UA), timeout=10).close()
            except Exception as e:
                self.skipTest(f'the real changesets are not in cache/sandbox/replay/ and the real API is not reachable ({e})')
        problems, lines, rep = run_scenario(sc)
        self.assertEqual(problems, [], f'{sc["name"]}\n' + '\n'.join(json.dumps(x)[:400] for x in lines))
    test.__doc__ = sc['name']
    return test


for _p in SCENARIOS:
    setattr(ScenarioTest, 'test_' + re.sub(r'\W+', '_', os.path.basename(_p)[:-5]), _make(_p))


class ReplayRewriteTest(unittest.TestCase):
    """tool/sandbox.py replay_rewrite: a real changeset's osmChange in, the sandbox's out."""
    REAL = '''<?xml version="1.0" encoding="UTF-8"?>
<osmChange version="0.6" generator="openstreetmap-cgimap">
<modify>
 <relation id="300" visible="true" version="9" changeset="189856236" timestamp="2026-10-02T02:44:48Z" user="Sytys" uid="11660817">
  <member type="way" ref="5000000002" role=""/><member type="node" ref="5000000001" role="platform"/><member type="node" ref="10" role="platform"/>
  <tag k="type" v="route"/><tag k="name" v="A &amp; B"/>
 </relation>
 <node id="10" visible="true" version="4" changeset="189856236" timestamp="2026-10-02T02:44:48Z" user="Sytys" uid="11660817" lat="41.74" lon="-111.83"><tag k="name" v="Ten"/></node>
</modify>
<create>
 <way id="5000000002" visible="true" version="1" changeset="189856236" timestamp="2026-10-02T02:44:48Z" user="Sytys" uid="11660817"><nd ref="5000000001"/><nd ref="3"/><tag k="highway" v="service"/></way>
 <node id="5000000001" visible="true" version="1" changeset="189856236" timestamp="2026-10-02T02:44:48Z" user="Sytys" uid="11660817" lat="41.7401" lon="-111.829"><tag k="highway" v="bus_stop"/></node>
</create>
<delete>
 <node id="21" visible="false" version="3" changeset="189856236" timestamp="2026-10-02T02:44:48Z" user="Sytys" uid="11660817" lat="41.7" lon="-111.8"/>
 <way id="200" visible="false" version="3" changeset="189856236" timestamp="2026-10-02T02:44:48Z" user="Sytys" uid="11660817"><nd ref="20"/><nd ref="21"/></way>
</delete>
</osmChange>
'''

    def test_creates_become_placeholders_and_references_follow(self):
        import xml.etree.ElementTree as ET
        osc, ph = sandbox.replay_rewrite(self.REAL, 77, {}, lambda t, i: {('relation', 300): 2, ('node', 10): 5, ('node', 21): 1, ('way', 200): 1}[(t, i)])
        root = ET.fromstring(osc)
        self.assertEqual([b.tag for b in root], ['create', 'modify', 'delete'], 'creations first, whatever the order they came in')
        create, modify, delete = root
        self.assertEqual([(e.tag, e.get('id')) for e in create], [('node', '-1'), ('way', '-2')], 'nodes before ways')
        self.assertEqual(ph, {('node', -1): ('node', 5000000001), ('way', -2): ('way', 5000000002)})
        self.assertEqual([nd.get('ref') for nd in create[1].findall('nd')], ['-1', '3'], 'the way follows its new node, and keeps the old one')
        rel = modify.find('relation')
        self.assertEqual([m.get('ref') for m in rel.findall('member')], ['-2', '-1', '10'])
        self.assertEqual((rel.get('version'), rel.get('id')), ('2', '300'), 'the sandbox version, not the real one')
        self.assertEqual(modify.find('node').get('version'), '5')
        self.assertEqual({k for e in root.iter() for k in e.attrib} & {'timestamp', 'user', 'uid', 'visible'}, set(), 'what the server sets is dropped')
        self.assertTrue(all(e.get('changeset') == '77' for b in root for e in b), 'one changeset for all of it')
        self.assertEqual(rel.find("tag[@k='name']").get('v'), 'A & B')
        self.assertEqual(delete.get('if-unused'), 'true')
        self.assertEqual([e.tag for e in delete], ['way', 'node'], 'deleted the other way round: the way before its nodes')
        self.assertNotIn('lat', delete[0].attrib)

    def test_what_an_earlier_changeset_made_is_referred_to_by_the_sandboxs_id(self):
        import xml.etree.ElementTree as ET
        osc, ph = sandbox.replay_rewrite(self.REAL, 1, {('node', 5000000001): 9001}, None)
        # an object created by this changeset gets a placeholder even if an earlier replay knew it (the real id is not reused)
        root = ET.fromstring(osc)
        self.assertEqual(root.find('modify/relation').findall('member')[1].get('ref'), '-1')
        # a modify of something an earlier changeset created goes to the id the sandbox gave it
        later = '<osmChange><modify><node id="5000000001" version="1" changeset="2" lat="1" lon="2"><tag k="a" v="b"/></node></modify></osmChange>'
        osc2, ph2 = sandbox.replay_rewrite(later, 2, {('node', 5000000001): 9001}, lambda t, i: {('node', 9001): 1}[(t, i)])
        self.assertEqual((ET.fromstring(osc2).find('modify/node').get('id'), ph2), ('9001', {}))

    def test_an_object_the_sandbox_lacks_is_said(self):
        with self.assertRaises(sandbox.ReplayGap) as cm:
            sandbox.replay_rewrite(self.REAL, 1, {}, lambda t, i: None)
        self.assertIn('is not in the sandbox', str(cm.exception))

    def test_or_left_out_and_listed(self):
        import xml.etree.ElementTree as ET
        missing = []
        osc, _ = sandbox.replay_rewrite(self.REAL, 1, {}, lambda t, i: None if (t, i) in (('relation', 300), ('way', 200)) else 3, missing)
        self.assertEqual(missing, ['relation 300', 'way 200'])
        root = ET.fromstring(osc)
        self.assertEqual([(b.tag, [e.tag + e.get('id') for e in b]) for b in root], [('create', ['node-1', 'way-2']), ('modify', ['node10']), ('delete', ['node21'])])

    def test_learning_the_ids_from_the_diff(self):
        osc, ph = sandbox.replay_rewrite(self.REAL, 1, {}, lambda t, i: 1)
        idmap = {}
        sandbox.replay_learn('<diffResult><node old_id="-1" new_id="9100" new_version="1"/><way old_id="-2" new_id="9200" new_version="1"/><node old_id="10" new_id="10" new_version="5"/></diffResult>', ph, idmap)
        self.assertEqual(idmap, {('node', 5000000001): 9100, ('way', 5000000002): 9200})


def main():
    unittest.main(module=sys.modules[__name__])


if __name__ == '__main__':
    main()
