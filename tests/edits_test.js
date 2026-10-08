// node tests/edits_test.js — the upload path, with no browser and no network: web/edits.js (the change basket,
// the osmChange it builds, the check before an upload, what an upload leaves behind) and web/roads.js (splitting
// a road, and repairing the relations that used it). Plain assertions; exits non-zero when any fails.
const assert = require('assert'), fs = require('fs'), path = require('path');
const WEB = path.join(__dirname, '..', 'web');
const Edits = require(path.join(WEB, 'edits.js'));

// what roads.js takes from the page: Edits (edits.js), m (app.js: metres between two [lon, lat]), OSM_API
global.Edits = Edits;
global.OSM_API = 'https://api.openstreetmap.org';
// the page's own m, taken from app.js so the metres here are the page's metres
global.m = new Function('return ' + fs.readFileSync(path.join(WEB, 'app.js'), 'utf8').match(/^const m = (.*);$/m)[1])();
const Roads = require(path.join(WEB, 'roads.js'));

Edits.persist = function () {};          // the basket is kept in memory here: no localStorage, no local server
Edits.auth.token = () => 'test-token';

const tests = [];
const test = (name, fn) => tests.push({name, fn});
function reset() {
  Edits.ops = {}; Edits.uploaded = {}; Edits.roads = []; Edits.decisions = {}; Edits.nextId = -1; Edits.fetch = null; Edits._unsure = null;
  Roads.nodes = {}; Roads.ways = {}; Roads.rels = {};
}

// ---------------------------------------------------------------------------------------------------------
// 1. osmChange
// ---------------------------------------------------------------------------------------------------------
const elements = (xml, section) => {   // [{tag, attrs}] of the <create>/<modify>/<delete> block, in order
  const block = (xml.match(new RegExp(`<${section}[^>]*>([\\s\\S]*?)</${section}>`)) || [])[1] || '';
  return [...block.matchAll(/<(node|way|relation) ([^>]*?)>/g)].map(x => ({tag: x[1], attrs: Object.fromEntries([...x[2].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]))}));
};

test('osmChange: creations get negative ids, member keys resolve to them, changeset on every element', () => {
  reset();
  // the relation is made first on purpose: its member keys are only looked up when the document is built
  const rel = Edits.createRelation({type: 'route', route: 'bus'}, [{key: 'new:n-2', role: 'platform'}, {key: 'new:w-3', role: ''}, {type: 'node', ref: 77, role: 'platform'}], 'r');
  const nd = Edits.createNode(41.74, -111.83, {highway: 'bus_stop'}, 'n');
  const wy = Edits.createWay({highway: 'residential'}, [-2, 500], 'w');
  assert.deepStrictEqual([rel, nd, wy], ['new:r-1', 'new:n-2', 'new:w-3']);
  const xml = Edits.osc(4242);
  assert.match(xml, /<create>/); assert.doesNotMatch(xml, /<modify>|<delete/);
  const els = elements(xml, 'create');
  assert.deepStrictEqual(els.map(e => e.tag), ['node', 'way', 'relation']);   // members exist before they're referred to
  assert.deepStrictEqual(els.map(e => e.attrs.id), ['-2', '-3', '-1']);
  for (const e of els) { assert.strictEqual(e.attrs.changeset, '4242'); assert.ok(!('version' in e.attrs), 'a creation has no version'); }
  assert.match(xml, /<nd ref="-2"\/>\s*<nd ref="500"\/>/);                    // the way: the new node, then an existing one
  assert.match(xml, /<member type="node" ref="-2" role="platform"\/>/);       // new:n-2 -> the placeholder id
  assert.match(xml, /<member type="way" ref="-3" role=""\/>/);
  assert.match(xml, /<member type="node" ref="77" role="platform"\/>/);       // an existing object stays as it is
  assert.match(xml, /<node id="-2" changeset="4242" lat="41.7400000" lon="-111.8300000">/);
});

// a node delete takes its position from the base: the osmChange can be built (the JOSM download) before check() has read OSM
const delNode = (id, version) => Edits.delete('node', id, {version, tags: {}, lat: 41.7, lon: -111.8}, '');

test('osmChange: version on every modify and delete (a fresh one wins over the base), changeset on all', () => {
  reset();
  Edits.modify('node', 10, {version: 3, tags: {name: 'A'}, lat: 41.7, lon: -111.8}, {tags: {name: 'B'}}, 'n');
  Edits.modify('way', 20, {version: 5, tags: {highway: 'service'}, nodes: [1, 2]}, {tags: {highway: 'residential'}}, 'w');
  Edits.modify('relation', 30, {version: 7, tags: {type: 'route'}, members: [{type: 'way', ref: 20, role: ''}]}, {tags: {name: 'R'}}, 'r');
  Edits.modify('node', 11, {version: 4, tags: {name: 'same'}, lat: 41.7, lon: -111.8}, {tags: {name: 'same'}}, 'unchanged');
  Edits.delete('relation', 31, {version: 2, tags: {type: 'route'}}, 'dr');
  Edits.delete('way', 21, {version: 8, tags: {highway: 'service'}}, 'dw');
  delNode(12, 9);
  const xml = Edits.osc(99, {w20: 6});   // way 20 was re-read at version 6
  const mod = elements(xml, 'modify'), del = elements(xml, 'delete');
  assert.deepStrictEqual(mod.map(e => `${e.tag}${e.attrs.id}`), ['node10', 'way20', 'relation30']);   // node 11 changed nothing: not bumped
  assert.deepStrictEqual(mod.map(e => e.attrs.version), ['3', '6', '7']);
  assert.deepStrictEqual(del.map(e => e.attrs.version).sort(), ['2', '8', '9']);
  for (const e of [...mod, ...del]) assert.strictEqual(e.attrs.changeset, '99');
  assert.match(xml, /<delete if-unused="true">/);
  assert.match(xml, /<node id="12" version="9" changeset="99" lat="41\.7000000" lon="-111\.8000000">/);   // from its base, no check() first
});

test('osmChange: creations nodes, ways, relations; deletions relations, ways, nodes (whatever order they were added)', () => {
  reset();
  delNode(12, 1);
  Edits.createRelation({type: 'route'}, [], '');
  Edits.delete('way', 21, {version: 1, tags: {highway: 'service'}}, '');
  Edits.createWay({highway: 'service'}, [-3, -4], '');
  Edits.delete('relation', 31, {version: 1, tags: {type: 'route'}}, '');
  Edits.createNode(41.7, -111.8, {}, '');
  delNode(13, 1);
  Edits.delete('relation', 32, {version: 1, tags: {type: 'route'}}, '');
  const xml = Edits.osc(1);
  assert.deepStrictEqual(elements(xml, 'create').map(e => e.tag), ['node', 'way', 'relation']);
  assert.deepStrictEqual(elements(xml, 'delete').map(e => e.tag), ['relation', 'relation', 'way', 'node', 'node']);
  assert.ok(xml.indexOf('<create>') < xml.indexOf('<delete'));
});

test('Level0 text: ids, members with their roles, tags; a delete is left to be done by hand', () => {
  reset();
  Edits.createNode(41.74, -111.83, {highway: 'bus_stop', name: 'X'}, '');
  Edits.createRelation({type: 'route'}, [{key: 'new:n-1', role: 'platform'}, {type: 'way', ref: 5, role: ''}], '');
  Edits.delete('way', 21, {version: 1, tags: {}}, '');
  const text = Edits.level0();
  assert.match(text, /node -1: 41\.7400000, -111\.8300000\n {2}highway = bus_stop\n {2}name = X/);
  assert.match(text, /relation -2\n {2}nd -1 platform\n {2}wy 5\n/);
  assert.match(text, /# delete way 21 by hand/);
});

// ---------------------------------------------------------------------------------------------------------
// 2, 3, 6. Roads: split, and the repair of the relations that used the road
// ---------------------------------------------------------------------------------------------------------
// A straight east-west street at Logan's latitude: node i sits i * step degrees of longitude from n0.
// Step 0.001 is about 83 m, 0.003 about 250 m.
const LAT = 41.74, LON0 = -111.83;
function street(step = 0.001, count = 12) {
  reset();
  for (let i = 0; i < count; i++) Roads.nodes[i] = {id: i, lat: LAT, lon: LON0 + i * step, tags: {}, version: 1};
}
const way = (id, nodes, tags = {highway: 'residential'}) => { Roads.ways[id] = {id, nodes, tags, version: 1}; return Roads.ways[id]; };
const rel = (id, tags, members) => { Roads.rels[id] = {id, tags, members, version: 1}; return Roads.rels[id]; };
const mem = (type, ref, role = '') => ({type, ref, role});
const wayRefs = r => r.members.filter(x => x.type === 'way').map(x => x.ref);
const bus = {type: 'route', route: 'bus', public_transport: 'version'};

test('split: the longer piece keeps the id, the shorter is new; together they are the original', () => {
  street();
  way(100, [1, 2, 3, 4, 5]);
  let t = Roads.tx();
  const give = Roads.split(t, 100, 2);        // [1,2] is one segment, [2,3,4,5] is three
  assert.strictEqual(give, -1);
  assert.deepStrictEqual(t.ways[100].nodes, [2, 3, 4, 5]);
  assert.deepStrictEqual(t.ways[-1].nodes, [1, 2]);
  assert.deepStrictEqual(t.ways[-1].tags, {highway: 'residential'});
  assert.deepStrictEqual(t.split[100], [100, -1]);
  // the other way round: the first piece is the longer one
  t = Roads.tx();
  const give2 = Roads.split(t, 100, 4);
  assert.deepStrictEqual(t.ways[100].nodes, [1, 2, 3, 4]);
  assert.deepStrictEqual(t.ways[give2].nodes, [4, 5]);
});

test('split: a way\'s own end node, a node it doesn\'t have, or a closed way, throws', () => {
  street();
  way(100, [1, 2, 3, 4, 5]);
  way(101, [1, 2, 3, 4, 1]);   // a loop
  assert.throws(() => Roads.split(Roads.tx(), 100, 1), /can't be split at n1/);
  assert.throws(() => Roads.split(Roads.tx(), 100, 5), /can't be split at n5/);
  assert.throws(() => Roads.split(Roads.tx(), 100, 9), /can't be split at n9/);
  assert.throws(() => Roads.split(Roads.tx(), 101, 3), /can't be split at n3/);
  assert.throws(() => Roads.split(Roads.tx(), 101, 1), /can't be split/);
});

test('repair: a bus route through the split lists both pieces in travel order, the rest of the relation as it was', async () => {
  street();
  way(99, [0, 1]); way(100, [1, 2, 3, 4, 5]); way(101, [5, 6]);
  rel(10, bus, [mem('node', 500, 'platform'), mem('way', 99), mem('way', 100), mem('way', 101), mem('node', 501, 'platform')]);
  const t = Roads.tx();
  const piece = Roads.split(t, 100, 2);
  const out = await Roads.repair(t);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].bad, []);
  assert.deepStrictEqual(wayRefs(out[0]), [99, piece, 100, 101]);   // [1,2] then [2..5]
  assert.deepStrictEqual(out[0].members.filter(x => x.type === 'node'), [mem('node', 500, 'platform'), mem('node', 501, 'platform')]);
  assert.strictEqual(out[0].members[0].ref, 500);                   // stops stay where they were
  assert.strictEqual(out[0].members[out[0].members.length - 1].ref, 501);
  // driven the other way, the pieces come the other way round
  Roads.rels[10].members = [mem('way', 101), mem('way', 100), mem('way', 99)];
  const t2 = Roads.tx();
  const piece2 = Roads.split(t2, 100, 2);
  assert.deepStrictEqual(wayRefs((await Roads.repair(t2))[0]), [101, 100, piece2, 99]);
});

test('repair: a one-way split keeps its direction, and the route follows it', async () => {
  street();
  // runs west: n6 -> n1, tagged oneway=yes in node order
  way(99, [7, 6]); way(100, [6, 5, 4, 3, 2, 1], {highway: 'residential', oneway: 'yes'}); way(101, [1, 0]);
  rel(10, bus, [mem('way', 99), mem('way', 100), mem('way', 101)]);
  const t = Roads.tx();
  const piece = Roads.split(t, 100, 5);                              // [6,5] new; [5,4,3,2,1] keeps 100
  assert.deepStrictEqual(t.ways[piece].nodes, [6, 5]);
  assert.deepStrictEqual(t.ways[100].nodes, [5, 4, 3, 2, 1]);
  assert.strictEqual(t.ways[piece].tags.oneway, 'yes');
  assert.strictEqual(t.ways[100].tags.oneway, 'yes');
  const out = await Roads.repair(t);
  assert.deepStrictEqual(out[0].bad, []);
  assert.deepStrictEqual(wayRefs(out[0]), [99, piece, 100, 101]);
  // the same route driven against the one-way can't be put together: said, not guessed
  Roads.rels[10].members = [mem('way', 101), mem('way', 100), mem('way', 99)];
  const t2 = Roads.tx();
  Roads.split(t2, 100, 5);
  const against = await Roads.repair(t2);
  assert.ok(against[0].bad.length, 'against the one-way is reported');
});

test('repair: a restriction\'s from way becomes the piece that touches its via', async () => {
  street();
  way(100, [1, 2, 3, 4, 5]); way(300, [1, 9]);
  rel(20, {type: 'restriction', restriction: 'no_left_turn'}, [mem('way', 100, 'from'), mem('node', 1, 'via'), mem('way', 300, 'to')]);
  let t = Roads.tx();
  const piece = Roads.split(t, 100, 2);            // [1,2] is the new piece, and it is the one at n1
  let out = await Roads.repair(t);
  assert.deepStrictEqual(out[0].members, [mem('way', piece, 'from'), mem('node', 1, 'via'), mem('way', 300, 'to')]);
  assert.deepStrictEqual(out[0].bad, []);
  // via at the other end: the piece that keeps the id
  Roads.rels[20].members = [mem('way', 100, 'from'), mem('node', 5, 'via'), mem('way', 300, 'to')];
  t = Roads.tx(); Roads.split(t, 100, 2);
  out = await Roads.repair(t);
  assert.strictEqual(out.length, 0, 'the from way is still the one at via: nothing to change');
  // a via way
  way(301, [5, 6]);
  Roads.rels[20].members = [mem('way', 100, 'from'), mem('way', 301, 'via'), mem('way', 300, 'to')];
  t = Roads.tx(); Roads.split(t, 100, 2);
  assert.strictEqual((await Roads.repair(t)).length, 0);
  // the via way itself split: both pieces are the via, in order from the from way's end
  way(302, [5, 7, 8]); way(303, [8, 10]);
  Roads.rels[20].members = [mem('way', 100, 'from'), mem('way', 302, 'via'), mem('way', 303, 'to')];
  t = Roads.tx();
  const vp = Roads.split(t, 302, 7);
  out = await Roads.repair(t);
  const pieces = out[0].members.filter(x => x.role === 'via').map(x => x.ref);
  assert.strictEqual(pieces.length, 2);
  assert.ok(t.way(pieces[0]).nodes.includes(5) && t.way(pieces[1]).nodes.includes(8), 'from the from way\'s end to the to way\'s');
  assert.ok(pieces.includes(vp) && pieces.includes(302));
  assert.deepStrictEqual(out[0].bad, []);
});

test('repair: any other relation gets every piece, in order, where the way was', async () => {
  street();
  way(98, [0, 1]); way(100, [1, 2, 3, 4, 5]); way(102, [5, 6]);
  rel(40, {type: 'boundary', boundary: 'administrative'}, [mem('way', 98, 'outer'), mem('way', 100, 'outer'), mem('way', 102, 'outer'), mem('node', 600, 'admin_centre')]);
  let t = Roads.tx();
  const piece = Roads.split(t, 100, 4);            // [1,2,3,4] keeps 100, [4,5] is new
  let out = await Roads.repair(t);
  assert.deepStrictEqual(out[0].members, [mem('way', 98, 'outer'), mem('way', 100, 'outer'), mem('way', piece, 'outer'), mem('way', 102, 'outer'), mem('node', 600, 'admin_centre')]);
  // listed the other way round, they come the other way round
  Roads.rels[40].members = [mem('way', 102, 'outer'), mem('way', 100, 'outer'), mem('way', 98, 'outer')];
  t = Roads.tx(); const piece2 = Roads.split(t, 100, 4);
  out = await Roads.repair(t);
  assert.deepStrictEqual(wayRefs(out[0]), [102, piece2, 100, 98]);
  // a relation that doesn't use the way is left out
  rel(41, {type: 'boundary'}, [mem('way', 98, 'outer')]);
  assert.ok(!out.some(r => r.id === 41));
});

test('repair: a split way\'s own pieces are driven whatever their length; other roads only within GAP_LIMIT', async () => {
  // roads 250 m a node: the pieces of the split way run 1.25 km between the route's neighbouring members. They were
  // the route's own road (16 PM Northbound's US 91, 3.9 km): no guess, so the route gets them whole
  street(0.003);
  way(99, [0, 1]); way(100, [1, 2, 3, 4, 5, 6]); way(101, [6, 7]);
  rel(10, bus, [mem('way', 99), mem('way', 100), mem('way', 101)]);
  const t = Roads.tx();
  const piece = Roads.split(t, 100, 2);
  assert.ok(Roads.len(t, t.ways[100].nodes) + Roads.len(t, t.ways[piece].nodes) > 800);
  const out = await Roads.repair(t);
  assert.deepStrictEqual(out[0].bad, []);
  assert.deepStrictEqual(wayRefs(out[0]), [99, piece, 100, 101]);
  // a connection over roads that were not the route's is a guess: taken within GAP_LIMIT, refused beyond it
  way(101, [10, 11]); way(103, [6, 7, 8, 9, 10]);   // the next member two blocks on; a 1 km road between, not a member
  const t2 = Roads.tx();
  assert.strictEqual(Roads.connect(t2, [6], 101, new Set([103])), null, 'nothing within 800 m');
  street(0.001);
  way(99, [0, 1]); way(100, [1, 2, 3, 4, 5, 6]); way(101, [10, 11]); way(103, [6, 7, 8, 9, 10]);
  const t3 = Roads.tx();
  const c = Roads.connect(t3, [6], 101, new Set([103]));
  assert.deepStrictEqual(c && c.ways, [103], '333 m over a road that was not a member: bridged');
});

// ---------------------------------------------------------------------------------------------------------
// 4, 5. check() and upload() against a mocked API
// ---------------------------------------------------------------------------------------------------------
const reply = (status, body) => ({status, ok: status >= 200 && status < 300, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body)});
/** A fake OSM API: objects: {'node/10': element | 410}; records every request as 'METHOD path'. */
function fakeOsm(objects, {changeset = '777', diffResult = '<diffResult/>', upload = null, download = null} = {}) {
  const log = [];
  const f = async (url, opts = {}) => {
    const p = String(url).replace(OSM_API, ''), method = opts.method || 'GET';
    log.push({method, path: p, body: opts.body});
    let mm;
    if ((mm = p.match(/^\/api\/0\.6\/(node|way|relation)\/(\d+)\.json$/))) {
      const o = objects[`${mm[1]}/${mm[2]}`];
      return o === 410 ? reply(410, 'gone') : o ? reply(200, {elements: [{type: mm[1], id: +mm[2], ...o}]}) : reply(404, 'nope');
    }
    if (method === 'PUT' && p === '/api/0.6/changeset/create') return reply(200, changeset + '\n');
    if (method === 'POST' && p === `/api/0.6/changeset/${changeset}/upload`) {
      if (upload === 'network') throw new TypeError('Failed to fetch');   // the reply lost, whatever OSM did
      if (typeof upload === 'number') return reply(upload, 'refused');
      return reply(200, diffResult);
    }
    if (method === 'GET' && p === `/api/0.6/changeset/${changeset}/download`) return download == null ? reply(503, 'busy') : reply(200, download);
    if (method === 'PUT' && p === `/api/0.6/changeset/${changeset}/close`) return reply(200, '');
    return reply(400, 'unexpected ' + method + ' ' + p);
  };
  f.log = log;
  return f;
}
const wrote = log => log.filter(r => r.method !== 'GET');

test('check: a newer version with other tags is a conflict naming the object; upload sends nothing', async () => {
  reset();
  Edits.modify('node', 10, {version: 1, tags: {name: 'A'}, lat: LAT, lon: LON0}, {tags: {name: 'B'}}, 'n');
  Edits.modify('way', 20, {version: 2, tags: {highway: 'service'}, nodes: [1, 2]}, {tags: {highway: 'residential'}}, 'w');
  Edits.createNode(LAT, LON0, {}, 'new');
  const api = Edits.fetch = fakeOsm({
    'node/10': {version: 2, tags: {name: 'C'}, lat: LAT, lon: LON0},                  // someone renamed it
    'way/20': {version: 2, tags: {highway: 'service'}, nodes: [1, 2]},               // untouched
  });
  const {versions, conflicts} = await Edits.check();
  assert.deepStrictEqual(conflicts.map(c => c.key), ['n10']);
  assert.match(conflicts[0].why, /v1 → v2: name/);
  assert.deepStrictEqual(versions, {n10: 2, w20: 2});
  await assert.rejects(() => Edits.upload('a comment', 'GTFS'), e => e.message === 'conflicts' && e.conflicts.length === 1 && e.conflicts[0].key === 'n10');
  assert.deepStrictEqual(wrote(api.log), [], 'nothing but reads reached the API: no changeset was opened');
  assert.strictEqual(Edits.count(), 3, 'and the basket is as it was');
});

test('check: a newer version that left what we change alone is carried; one deleted on OSM is a conflict', async () => {
  reset();
  Edits.modify('way', 20, {version: 2, tags: {highway: 'service'}, nodes: [1, 2]}, {tags: {highway: 'residential'}}, 'tag edit');
  Edits.modify('way', 21, {version: 2, tags: {highway: 'service'}, nodes: [1, 2]}, {nodes: [1, 3, 2]}, 'shape edit');
  Edits.modify('node', 11, {version: 1, tags: {}, lat: LAT, lon: LON0}, {tags: {a: 'b'}}, 'gone');
  Edits.fetch = fakeOsm({
    'way/20': {version: 3, tags: {highway: 'service'}, nodes: [1, 4, 2]},   // somebody added a node to it
    'way/21': {version: 3, tags: {highway: 'service'}, nodes: [1, 4, 2]},   // the nodes moved under an edit made from the old ones
    'node/11': 410,
  });
  const {versions, conflicts} = await Edits.check();
  assert.deepStrictEqual(conflicts.map(c => c.key).sort(), ['n11', 'w21']);
  assert.strictEqual(conflicts.find(c => c.key === 'n11').why, 'deleted on OSM');
  assert.strictEqual(versions.w20, 3);
  assert.deepStrictEqual(Edits.ops.w20.nodes, [1, 4, 2], 'a tag edit goes up on OSM\'s nodes, not the older copy\'s');
  assert.match(Edits.osc(5, versions), /<way id="20" version="3" changeset="5">\s*<nd ref="1"\/>\s*<nd ref="4"\/>\s*<nd ref="2"\/>/);
});

const diffResult = `<?xml version="1.0" encoding="UTF-8"?>
<diffResult generator="OpenStreetMap server" version="0.6">
  <node old_id="-1" new_id="9001" new_version="1"/>
  <node old_id="10" new_id="10" new_version="2"/>
  <way old_id="30" new_id="30" new_version="4"/>
</diffResult>`;

test('upload: opens, uploads, closes; what went up is kept as uploaded, and the next edit builds on it', async () => {
  reset();
  Edits.createNode(LAT, LON0, {highway: 'bus_stop'}, 'new stop');
  Edits.modify('node', 10, {version: 1, tags: {name: 'A'}, lat: LAT, lon: LON0}, {tags: {name: 'B'}}, 'rename');
  Edits.delete('way', 30, {version: 3, tags: {highway: 'service'}}, 'in a route still');   // diffResult gives it a new_id: kept
  Edits.delete('node', 40, {version: 2, tags: {}, lat: LAT, lon: LON0}, 'stop position no route uses');   // check() gives it its position
  const api = Edits.fetch = fakeOsm({'node/10': {version: 1, tags: {name: 'A'}, lat: LAT, lon: LON0}, 'way/30': {version: 3, tags: {highway: 'service'}, nodes: [1, 2]}, 'node/40': {version: 2, tags: {}, lat: LAT, lon: LON0}}, {diffResult});
  const statuses = [];
  const res = await Edits.upload('Add a stop', 'GTFS', s => statuses.push(s));
  assert.strictEqual(res.id, '777');
  assert.deepStrictEqual(res.skipped, ['w30']);
  assert.deepStrictEqual(wrote(api.log).map(r => `${r.method} ${r.path}`), ['PUT /api/0.6/changeset/create', 'POST /api/0.6/changeset/777/upload', 'PUT /api/0.6/changeset/777/close']);
  const body = wrote(api.log)[1].body;
  assert.match(body, /<node id="10" version="1" changeset="777"/);
  assert.match(body, /<node id="-1" changeset="777" lat=/);
  assert.match(body, /<way id="30" version="3" changeset="777"/);
  assert.match(body, /<delete if-unused="true">[\s\S]*<way id="30"[\s\S]*<node id="40" version="2" changeset="777" lat="41\.7400000"/);   // way before node
  assert.match(wrote(api.log)[0].body, /k="created_by" v="flagstop"/);
  assert.deepStrictEqual(Object.keys(Edits.ops), ['w30'], 'the delete OSM kept stays in the basket');
  // the uploaded node: under its new id as well as its placeholder
  assert.strictEqual(Edits.uploaded['n10'].newVersion, 2);
  assert.strictEqual(Edits.uploaded['new:n-1'].newId, 9001);
  assert.strictEqual(Edits.uploaded['n9001'].newVersion, 1);
  assert.strictEqual(Edits.uploaded['w30'], undefined);
  // a later edit of node 10, made from the old copy of it, starts from the uploaded one
  const stale = {version: 1, tags: {name: 'A'}, lat: LAT, lon: LON0};
  Edits.modify('node', 10, stale, {tags: {ref: 'x'}}, 'second');
  const op = Edits.ops.n10;
  assert.strictEqual(op.base.version, 2);
  assert.deepStrictEqual(op.base.tags, {name: 'B'});
  assert.deepStrictEqual(op.tags, {name: 'B', ref: 'x'});
  assert.match(Edits.osc(8), /<node id="10" version="2" changeset="8"/);
  // the upload is shown done: Roads sees the node with its uploaded tags
  Roads.nodes = {10: {id: 10, lat: LAT, lon: LON0, tags: {name: 'A'}, version: 1}};
  assert.deepStrictEqual(Roads.node(10).tags, {name: 'B', ref: 'x'});
});

test('upload: a basket whose every change OSM already has opens no changeset', async () => {
  reset();
  Edits.modify('node', 10, {version: 1, tags: {name: 'A'}, lat: LAT, lon: LON0}, {tags: {name: 'A'}}, 'no change');
  const api = Edits.fetch = fakeOsm({'node/10': {version: 1, tags: {name: 'A'}, lat: LAT, lon: LON0}});
  await assert.rejects(() => Edits.upload('nothing', 'GTFS'), /nothing to upload/);
  assert.deepStrictEqual(wrote(api.log), []);
});

test('upload: refuses without a sign-in, or a comment OSM would cut, before reading or sending anything', async () => {
  reset();
  Edits.modify('node', 10, {version: 1, tags: {name: 'A'}, lat: LAT, lon: LON0}, {tags: {name: 'B'}}, 'n');
  const api = Edits.fetch = fakeOsm({});
  await assert.rejects(() => Edits.upload('x'.repeat(256), 'GTFS'), /255 at most/);
  const token = Edits.auth.token; Edits.auth.token = () => '';
  try { await assert.rejects(() => Edits.upload('ok', 'GTFS'), /not signed in/); } finally { Edits.auth.token = token; }
  assert.deepStrictEqual(api.log, []);
});

// what OSM has in changeset 777 when it took the upload and the reply was lost: as /changeset/777/download gives it
const took = `<?xml version="1.0" encoding="UTF-8"?>
<osmChange version="0.6" generator="OpenStreetMap server">
<create>
  <node id="9001" visible="true" version="1" changeset="777" lat="41.7400000" lon="-111.8300000"><tag k="highway" v="bus_stop"/><tag k="name" v="A &amp; B"/></node>
</create>
<create>
  <relation id="9100" visible="true" version="1" changeset="777"><member type="node" ref="9001" role="platform"/><tag k="type" v="route"/></relation>
</create>
<modify>
  <node id="10" visible="true" version="2" changeset="777" lat="41.7400000" lon="-111.8300000"><tag k="name" v="B"/></node>
</modify>
</osmChange>`;
const lostBasket = () => {
  reset();
  const n = Edits.createNode(41.74, -111.83, {highway: 'bus_stop', name: 'A & B'}, 'new stop');
  Edits.createRelation({type: 'route'}, [{key: n, role: 'platform'}], 'new route');
  Edits.modify('node', 10, {version: 1, tags: {name: 'A'}, lat: 41.74, lon: -111.83}, {tags: {name: 'B'}}, 'rename');
};

test('upload: the reply lost after OSM took it: found in the changeset, kept as uploaded, nothing waits to go again', async () => {
  lostBasket();
  const api = Edits.fetch = fakeOsm({'node/10': {version: 1, tags: {name: 'A'}, lat: 41.74, lon: -111.83}}, {upload: 'network', download: took});
  const res = await Edits.upload('x', 'GTFS');
  assert.strictEqual(res.id, '777');
  assert.deepStrictEqual(Object.keys(Edits.ops), [], 'nothing left to send twice');
  assert.strictEqual(Edits.uploaded['new:n-1'].newId, 9001);
  assert.strictEqual(Edits.uploaded['new:r-2'].newId, 9100);
  assert.deepStrictEqual(Edits.uploaded['new:r-2'].members, [{type: 'node', ref: 9001, role: 'platform'}], 'its member by the id OSM gave');
  assert.strictEqual(Edits.uploaded['n10'].newVersion, 2);
  assert.strictEqual(Edits.unsure(), null);
  assert.ok(wrote(api.log).some(r => r.path === '/api/0.6/changeset/777/close'));
});

test('upload: the reply lost and OSM can\'t be asked: all stays in Changes, and the next upload asks before sending', async () => {
  lostBasket();
  const objs = {'node/10': {version: 1, tags: {name: 'A'}, lat: 41.74, lon: -111.83}};
  Edits.fetch = fakeOsm(objs, {upload: 'network', download: null});
  await assert.rejects(() => Edits.upload('x', 'GTFS'), /couldn't be asked/);
  assert.strictEqual(Edits.count(), 3);
  assert.strictEqual(Edits.unsure().id, '777');
  // still can't ask: refused, nothing sent
  let api = Edits.fetch = fakeOsm(objs, {download: null});
  await assert.rejects(() => Edits.upload('x', 'GTFS'), /Nothing was sent/);
  assert.deepStrictEqual(wrote(api.log), []);
  // now it can, and it had gone up: taken as uploaded, no second changeset
  api = Edits.fetch = fakeOsm(objs, {download: took});
  const res = await Edits.upload('x', 'GTFS');
  assert.ok(res.recovered);
  assert.deepStrictEqual(wrote(api.log), [], 'nothing uploaded a second time');
  assert.strictEqual(Edits.count(), 0);
  assert.strictEqual(Edits.uploaded['new:n-1'].newId, 9001);
});

test('upload: the reply lost and the changeset is empty: it didn\'t go through, and can be sent again', async () => {
  lostBasket();
  Edits.fetch = fakeOsm({'node/10': {version: 1, tags: {name: 'A'}, lat: 41.74, lon: -111.83}}, {upload: 'network', download: '<osmChange version="0.6"/>'});
  await assert.rejects(() => Edits.upload('x', 'GTFS'), /didn't go through/);
  assert.strictEqual(Edits.count(), 3);
  assert.strictEqual(Edits.unsure(), null);
});

test('upload: OSM refusing it (409) leaves Changes as it was, with no asking after', async () => {
  lostBasket();
  const api = Edits.fetch = fakeOsm({'node/10': {version: 1, tags: {name: 'A'}, lat: 41.74, lon: -111.83}}, {upload: 409});
  await assert.rejects(() => Edits.upload('x', 'GTFS'), /409/);
  assert.strictEqual(Edits.count(), 3);
  assert.strictEqual(Edits.unsure(), null);
  assert.ok(!api.log.some(r => r.path.endsWith('/download')));
});

test('upload: one at a time; more than the cap is refused before anything is read', async () => {
  reset();
  Edits.createNode(41.74, -111.83, {highway: 'bus_stop'}, 'n');
  let api = Edits.fetch = fakeOsm({}, {diffResult: '<diffResult><node old_id="-1" new_id="5" new_version="1"/></diffResult>'});
  const [a, b] = await Promise.allSettled([Edits.upload('x', 'GTFS'), Edits.upload('x', 'GTFS')]);
  assert.strictEqual(a.status, 'fulfilled');
  assert.match(String(b.reason), /already running/);
  assert.strictEqual(wrote(api.log).filter(r => r.path.endsWith('/upload')).length, 1);
  reset();
  for (let i = 0; i <= Edits.CAP; i++) Edits.createNode(41.74, -111.83 + i * 1e-4, {}, 'n');
  api = Edits.fetch = fakeOsm({});
  await assert.rejects(() => Edits.upload('x', 'GTFS'), /at most go in one upload/);
  assert.deepStrictEqual(api.log, []);
});

test('upload: a relation edited again after its new member went up keeps that member, by its OSM id', async () => {
  reset();
  const r = Edits.createRelation({type: 'route_master'}, [{type: 'relation', ref: 50, role: ''}], 'master');
  const route = Edits.createRelation({type: 'route'}, [], 'route A');
  Edits.modify('relation', 500, {version: 1, tags: {type: 'route_master'}, members: [{type: 'relation', ref: 50, role: ''}]}, {members: [{type: 'relation', ref: 50, role: ''}, {key: route, role: ''}]}, 'A in its master');
  Edits.fetch = fakeOsm({'relation/500': {version: 1, tags: {type: 'route_master'}, members: [{type: 'relation', ref: 50, role: ''}]}},
    {diffResult: '<diffResult><relation old_id="-1" new_id="901" new_version="1"/><relation old_id="-2" new_id="902" new_version="1"/><relation old_id="500" new_id="500" new_version="2"/></diffResult>'});
  await Edits.upload('x', 'GTFS');
  // direction B, built from what flagstop knows of r500 now: the uploaded copy
  const now = Edits.get('r500');
  Edits.modify('relation', 500, {version: 1, tags: {}, members: []}, {members: [...now.members, {type: 'relation', ref: 77, role: ''}]}, 'B in its master');
  assert.match(Edits.osc(8), /<relation id="500" version="2" changeset="8">\s*<member type="relation" ref="50" role=""\/>\s*<member type="relation" ref="902" role=""\/>\s*<member type="relation" ref="77" role=""\/>/);
  // and a member by key to something uploaded since resolves to its OSM id, not to nothing
  assert.deepStrictEqual(Edits.resolveMember({key: route, role: 'x'}), {type: 'relation', ref: 902, role: 'x'});
  void r;
});

test('a new object already uploaded as it is, in an older copy of the basket, is dropped rather than sent twice', () => {
  reset();
  const k = Edits.createNode(41.74, -111.83, {highway: 'bus_stop', name: 'A'}, 'n');
  Edits.uploaded[k] = {...Edits.ops[k], uploaded: '5', newId: 9, newVersion: 1};
  const k2 = Edits.createNode(41.75, -111.83, {highway: 'bus_stop', name: 'B'}, 'n2');   // not uploaded: stays
  assert.strictEqual(Edits.dropUploaded(), 1);
  assert.deepStrictEqual(Object.keys(Edits.ops), [k2]);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n' + String(e.stack || e).split('\n').map(l => '     ' + l).join('\n')); }
  }
  console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
