// node tests/sandbox_upload.js <sandbox url> — the page's own upload code (web/edits.js) against a live
// tool/sandbox.py: a new stop, a renamed one, a relation rewritten, uploaded as one changeset; then what the
// sandbox says it has. Run by tests/test_sandbox.py; prints JSON for it to check.
const path = require('path');
const Edits = require(path.join(__dirname, '..', 'web', 'edits.js'));
const url = process.argv[2];
Edits.persist = function () {};
Edits.auth.token = () => 'sandbox-token';
Edits.fetch = (u, opts) => fetch(String(u).replace('https://api.openstreetmap.org', url), opts);

(async () => {
  const get = async p => (await (await fetch(url + p)).json()).elements[0];
  const n10 = await get('/api/0.6/node/10.json'), r300 = await get('/api/0.6/relation/300.json');
  const key = Edits.createNode(41.7405, -111.8285, {highway: 'bus_stop', public_transport: 'platform', bus: 'yes', name: 'New stop'}, 'new stop');
  Edits.modify('node', 10, {version: n10.version, tags: n10.tags, lat: n10.lat, lon: n10.lon}, {tags: {name: 'Main & 3rd (renamed)'}}, 'rename');
  Edits.modify('relation', 300, {version: r300.version, tags: r300.tags, members: r300.members}, {members: [...r300.members, {key, role: 'platform'}]}, 'add the stop');
  const statuses = [];
  const res = await Edits.upload('sandbox upload test', 'GTFS', s => statuses.push(s));
  const after = {node10: await get('/api/0.6/node/10.json'), rel300: await get('/api/0.6/relation/300.json'),
    created: Edits.uploaded[key] ? await get(`/api/0.6/node/${Edits.uploaded[key].newId}.json`) : null};
  console.log(JSON.stringify({id: res.id, skipped: res.skipped, statuses, uploaded: Object.keys(Edits.uploaded), left: Object.keys(Edits.ops), after}));
})().catch(e => { console.log(JSON.stringify({error: String(e && e.message || e), conflicts: e && e.conflicts})); process.exit(1); });
