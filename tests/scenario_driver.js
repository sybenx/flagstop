// node tests/scenario_driver.js <sandbox url> <scenario.json> — the tool's own modules (web/edits.js, web/roads.js)
// taking a scenario's steps against a running tool/sandbox.py, as the page would, with no browser. Run by
// tests/test_scenarios.py, which judges the result; see the top of that file for the scenario format.
//
// One JSON line per step on stdout: {step, kind, ok, ...what happened}; then a last line {ok, names, steps}.
// Exit status 1 when a step doesn't do what it was expected to do.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const WEB = path.join(__dirname, '..', 'web');
const [url, file] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));

// the addresses the page reads from config.js: the sandbox for the API and for sign-in
global.FLAGSTOP_OSM = {api: url, www: url};
// and nothing else is reachable: a request to anywhere but the sandbox is a failure of the test
const realFetch = global.fetch;
global.fetch = (u, opts) => {
  if (!String(u).startsWith(url + '/')) throw new Error('the scenario reached for ' + u + ', which is not the sandbox');
  return realFetch(u, opts);
};
const Edits = require(path.join(WEB, 'edits.js'));
global.Edits = Edits;
global.OSM_API = url;
global.m = new Function('return ' + fs.readFileSync(path.join(WEB, 'app.js'), 'utf8').match(/^const m = (.*);$/m)[1])();
// what Roads.run() takes from the page: it tells the reviewer (toast), asks when a repair can't be done (confirm),
// and redraws. Here it listens: a question is answered no, and said.
const said = [];
global.toast = msg => said.push(msg);
global.confirm = msg => { said.push('asked: ' + msg); return false; };
global.render = global.draw = global.liveRoute = () => {};
global.map = {getCanvas: () => ({style: {}})};
const Roads = require(path.join(WEB, 'roads.js'));
Roads.card = Roads.drawAll = Roads.status = () => {};
Edits.persist = function () {};
Edits.auth.token = () => 'scenario-token';

const names = {};   // "as" -> the basket key ('new:n-1'), for what a step made
const ids = {};     // "as" -> the id OSM gave it, once uploaded
const TYPES = {n: 'node', w: 'way', r: 'relation'};
const out = o => console.log(JSON.stringify(o));

async function api(method, p, body) {
  const r = await realFetch(url + p, {method, body, headers: {Authorization: 'Bearer scenario-token', 'Content-Type': 'text/xml'}});
  return {status: r.status, text: await r.text()};
}
async function read(type, id) {
  const r = await realFetch(`${url}/api/0.6/${type}/${id}.json`);
  if (!r.ok) throw new Error(`${type} ${id}: the sandbox says ${r.status}`);
  return (await r.json()).elements[0];
}
const changesetCount = async () => (await (await realFetch(url + '/api/0.6/changesets.json?limit=1000')).json()).changesets.length;
const baseOf = (type, e) => type === 'node' ? {version: e.version, tags: e.tags || {}, lat: e.lat, lon: e.lon}
  : type === 'way' ? {version: e.version, tags: e.tags || {}, nodes: e.nodes}
  : {version: e.version, tags: e.tags || {}, members: e.members.map(x => ({type: x.type, ref: x.ref, role: x.role}))};
const keyOf = n => { if (!(n in names)) throw new Error(`no step made "${n}"`); return names[n]; };
// a member as a scenario writes it: {type, ref, role}, or {as, role} for something the scenario made
const member = x => !x.as ? x : ids[x.as] ? {type: TYPES[keyOf(x.as).match(/^new:(\w)/)[1]], ref: ids[x.as], role: x.role || ''} : {key: keyOf(x.as), role: x.role || ''};
const nodeRef = x => typeof x !== 'object' ? x : ids[x.as] || Edits.ops[keyOf(x.as)].id;

const steps = {
  async createNode(a) {
    const key = Edits.createNode(a.lat, a.lon, a.tags || {}, a.note || '');
    if (a.as) names[a.as] = key;
    return {key};
  },
  async modify(a) {
    const changes = {...(a.changes || {})};
    delete changes.insertMembers;
    if (changes.members) changes.members = changes.members.map(member);
    if (changes.nodes) changes.nodes = changes.nodes.map(nodeRef);
    let id = a.id;
    if (a.as && Edits.ops[names[a.as]]) {   // something made in this run and not yet uploaded: change the creation itself
      const op = Edits.ops[names[a.as]];
      if (changes.tags) op.tags = {...op.tags, ...changes.tags};
      for (const k of changes.removeTags || []) delete op.tags[k];
      if (changes.lat != null) { op.lat = changes.lat; op.lon = changes.lon; }
      if (changes.members) op.members = changes.members;
      if (changes.nodes) op.nodes = changes.nodes;
      Edits.save();
      return {key: names[a.as]};
    }
    if (a.as) id = ids[a.as];
    const e = await read(a.type, id), base = baseOf(a.type, e);
    const ins = a.changes && a.changes.insertMembers;   // {at, members}: into the members as the basket has them, else the sandbox
    if (ins) {
      const have = (Edits.ops[a.type[0] + id] || base).members;
      changes.members = [...have.slice(0, ins.at), ...ins.members.map(member), ...have.slice(ins.at)];
    }
    const key = Edits.modify(a.type, id, base, changes, a.note || '');
    return {key, version: base.version};
  },
  async delete(a) {
    const e = await read(a.type, a.id);
    return {key: Edits.delete(a.type, a.id, baseOf(a.type, e), a.note || '')};
  },
  async split(a) {
    const before = new Set(Object.keys(Edits.ops));
    await Roads.load(a.bbox);
    said.length = 0;
    await Roads.splitAt(a.way, a.node);
    const added = Object.keys(Edits.ops).filter(k => !before.has(k));
    if (!added.length) throw new Error('the split added nothing' + (said.length ? ': ' + said.join(' / ') : ''));
    const piece = added.find(k => k.startsWith('new:w'));
    if (a.as && piece) names[a.as] = piece;
    return {ops: added, said: [...said]};
  },
  async sandboxEdit(a) {   // an edit by someone else, straight to the API: its own changeset
    const cs = (await api('PUT', '/api/0.6/changeset/create', `<osm><changeset><tag k="comment" v="${a.comment || 'an edit by someone else'}"/><tag k="created_by" v="scenario"/><tag k="source" v="scenario"/></changeset></osm>`)).text.trim();
    const up = await api('POST', `/api/0.6/changeset/${cs}/upload`, `<osmChange version="0.6" generator="scenario">\n${a.osc.replace(/\{cs\}/g, cs)}\n</osmChange>`);
    await api('PUT', `/api/0.6/changeset/${cs}/close`);
    if (up.status !== 200) throw new Error(`the sandbox refused the edit: ${up.status} ${up.text.slice(0, 300)}`);
    return {changeset: +cs};
  },
  async replay(a) {   // real changesets, rewritten for the sandbox by tool/sandbox.py (the only thing here that reads the real OSM, read-only)
    const r = cp.spawnSync('python3', [path.join(__dirname, '..', 'tool', 'sandbox.py'), 'replay', '--url', url, ...a.changesets.map(String)], {encoding: 'utf8', timeout: 600000});
    let results;
    try { results = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { throw new Error('replay: ' + (r.stderr || r.stdout).slice(-600)); }
    const bad = results.filter(x => !x.ok);
    if (bad.length) throw Object.assign(new Error(`replay: changeset ${bad[0].real} did not go in: ${bad[0].error}`), {results});
    return {changesets: results.length, results};
  },
  async upload(a) {
    const before = await changesetCount(), want = a.expect || 'ok';
    let res = null, conflicts = null;
    try { res = await Edits.upload(a.comment || 'scenario', a.source || 'scenario'); }
    catch (e) { if (!e.conflicts) throw e; conflicts = e.conflicts; }
    const o = {expect: want, changesetsCreated: (await changesetCount()) - before};
    if (conflicts) {
      Object.assign(o, {conflicts: conflicts.map(c => c.key), why: conflicts.map(c => c.why)});
      if (want !== 'conflict') throw Object.assign(new Error('the upload stopped on a conflict: ' + o.why.join('; ')), o);
      if (o.changesetsCreated !== 0) throw Object.assign(new Error('a conflict stopped the upload, but a changeset was created'), o);
    } else {
      Object.assign(o, {changeset: +res.id, skipped: res.skipped, left: Object.keys(Edits.ops)});
      if (want !== 'ok') throw Object.assign(new Error('expected a conflict, the upload went through'), o);
      for (const [n, k] of Object.entries(names)) if (Edits.uploaded[k] && Edits.uploaded[k].newId) ids[n] = Edits.uploaded[k].newId;
      o.ids = {...ids};
    }
    return o;
  },
};

(async () => {
  let i = 0;
  for (const step of scenario.steps) {
    const kind = Object.keys(step).find(k => k in steps);
    if (!kind) { out({step: i, ok: false, error: 'unknown step: ' + JSON.stringify(step).slice(0, 100)}); out({ok: false, failed: i}); process.exit(1); }
    try { out({step: i, kind, ok: true, ...(await steps[kind](step[kind]))}); }
    catch (e) { out({step: i, kind, ok: false, error: String(e && e.message || e), ...(e.results ? {results: e.results} : {})}); out({ok: false, failed: i, names: ids}); process.exit(1); }
    i++;
  }
  out({ok: true, steps: i, names: ids});
})();
