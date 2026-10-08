/* flagstop — review a GTFS feed against OpenStreetMap. Reads data/review.json (from tool/review.py).
   Decisions go into a local change basket (edits.js) and leave as one OSM changeset, an osmChange
   file, or Level0 text. Road edits that routes depend on (split, reconnect, move, add) are made here
   with the routes repaired (roads.js); drawing and shaping roads is handed to RapiD/iD with the
   agency's line overlaid. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const pct = x => x == null ? '—' : Math.round(x * 100) + '%';
const m = (a, b) => Math.hypot((b[1] - a[1]) * 110540, (b[0] - a[0]) * 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180));
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let D, map, S = {looked: new Set(), lookStop: null, tab: 'routes', pattern: null, div: null, stop: null, routed: null, filter: 'all', q: '', viaMode: false, placing: null};

function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- editors: RapiD first, iD, JOSM ----------
const dataUrl = p => p ? new URL(`data/shape-${p.id.replace(/[^A-Za-z0-9]/g, '_')}.gpx`, location.href).href : null;   // works under a path (a published copy) too
function editorUrl(which, {lon, lat, zoom = 18, select = [], pattern = null, comment = ''}) {
  const h = new URLSearchParams();
  h.set('map', `${zoom}/${lat.toFixed(6)}/${lon.toFixed(6)}`);
  if (select.length) h.set('id', select.join(','));
  if (pattern) { h.set('data', dataUrl(pattern)); h.set('gpx', dataUrl(pattern)); }
  if (comment) h.set('comment', comment);
  h.set('source', `${D.agency.agency_name} GTFS`);
  const hash = '#' + h.toString().replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%3A/g, ':');
  if (which === 'rapid') return 'https://rapideditor.org/edit' + hash;
  return 'https://www.openstreetmap.org/edit?editor=id' + hash;
}
const openIn = (which, opts) => window.open(editorUrl(which, opts), 'flagstop-' + which);
const bboxOf = (pts, margin = true) => {   // margin: ~120 m round it (an area to fetch); false: just the points
  let l = 180, r = -180, b = 90, t = -90;
  for (const [x, y] of pts) { l = Math.min(l, x); r = Math.max(r, x); b = Math.min(b, y); t = Math.max(t, y); }
  const mx = margin ? 0.0015 : 0, my = margin ? 0.001 : 0;
  return {left: l - mx, right: r + mx, bottom: b - my, top: t + my};
};
const centerOf = pts => { const b = bboxOf(pts); return {lon: (b.left + b.right) / 2, lat: (b.top + b.bottom) / 2}; };
async function josm(cmd, params) {
  try { await fetch('http://127.0.0.1:8111/' + cmd + '?' + new URLSearchParams(params).toString(), {mode: 'no-cors'}); toast('Sent to JOSM'); }
  catch (e) { toast('JOSM not reachable', 3000); }
}
const osmLink = id => `https://www.openstreetmap.org/${id[0] === 'n' ? 'node' : id[0] === 'w' ? 'way' : 'relation'}/${id.replace(/^\D+/, '')}`;
function editorButtons(opts, {primaryLabel = 'Open in RapiD', small = false} = {}) {
  const b = el('span', {class: 'btns', style: small ? 'display:inline-flex;gap:4px;margin:0' : ''});
  b.append(el('button', {class: 'b' + (small ? ' tiny' : ''), onclick: () => openIn('rapid', opts)}, primaryLabel));
  b.append(el('button', {class: 'b' + (small ? ' tiny' : ''), onclick: () => openIn('id', opts)}, 'iD'));
  b.append(el('button', {class: 'b' + (small ? ' tiny' : ''), title: 'JOSM remote control', onclick: () => josm('load_and_zoom', {...bboxOf(opts.pts || [[opts.lon, opts.lat]]), select: opts.select.map(x => x.replace(/^n/, 'node').replace(/^w/, 'way').replace(/^r/, 'relation')).join(',')})}, 'JOSM'));
  return b;
}

// ---------- data helpers ----------
const routeOf = p => D.routes.find(r => r.id === p.route_id);
const patternById = id => D.patterns.find(p => p.id === id);
function stopStatus(s) {
  if (Edits.decisions[s.id]) return 'matched';
  return s.match ? s.match.status : 'missing';
}
function matchedOsm(s) {
  const dec = Edits.decisions[s.id];
  if (dec) return dec === 'none' ? null : D.osm_stops[dec];
  return (s.match && s.match.status === 'matched' && s.match.osm[0]) ? D.osm_stops[s.match.osm[0].id] : null;
}
/** The stop's OSM node, counting nodes this session created for it. */
function stopNodeRef(s) {
  const o = matchedOsm(s);
  if (o) return {type: 'node', ref: o.osm_id ?? +o.id.slice(1)};
  const all = Edits.all(), key = Object.keys(all).find(k => all[k].kind === 'create' && all[k].type === 'node' && all[k].tags['gtfs:stop_id'] === s.id);
  if (!key) return null;
  return all[key].uploaded && all[key].newId ? {type: 'node', ref: all[key].newId} : {key, role: 'platform'};   // uploaded: it has a real id now
}
function patternGrade(p) {
  if (p.temporary) return {chip: 'temporary', cls: '', order: 9};
  const rels = p.relations;
  if (!rels.length) return {chip: 'no relation', cls: 'bad', order: 0};
  if (rels.some(r => r.duplicate)) return {chip: `${rels.length} relations`, cls: 'warn', order: 1};
  if (rels.some(r => r.both_directions)) return {chip: 'both directions', cls: 'warn', order: 2};
  const r = rels[0];
  const n = r.stops.missing.length + r.stops.extra.length + r.ways.off_shape.length + r.ways.chain_breaks.length + (r.stops.out_of_order ? 1 : 0);
  if (n) return {chip: 'needs work', cls: 'warn', order: 3};
  if (r.tag_issues.length) return {chip: 'tags', cls: 'info', order: 4};
  return {chip: 'ok', cls: 'good', order: 5};
}
// a route not routed yet (its roads load when it's opened): nothing to draw or say about the path
const NOT_ROUTED = {ways: [], geometry: [], legs: [], divergences: [], score: null};
const routedOf = p => (S.pattern === p.id && S.routed) ? S.routed : (p.routed || NOT_ROUTED);
/** Has the reviewer re-routed this itinerary (via points, roads the bus uses or doesn't)? */
const constrainedRouting = p => { const r = Edits.routingOf(p.id); return !!(r.vias.length || r.avoid.length || r.require.length); };
// ---------- a route's roads, and routing it here in the page (web/router.js) ----------
// public Overpass servers that answer a page (CORS); which one is up changes by the minute
const OVERPASS = typeof FLAGSTOP_OSM !== 'undefined' && FLAGSTOP_OSM.overpass ? [FLAGSTOP_OSM.overpass] : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const ROAD_CLASSES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road';
/** The Overpass query for the roads within a tile or so of a route's line (tool/osm.py's fetch_roads_near). */
function roadsQuery(p) {
  const pts = p.shape.length > 1 ? p.shape : p.stops.map(s => [D.stops[s].lon, D.stops[s].lat]);
  const line = [pts[0]];
  for (const x of pts.slice(1)) if (Math.hypot((x[0] - line[line.length - 1][0]) * 83000, (x[1] - line[line.length - 1][1]) * 111000) >= 100) line.push(x);
  line.push(pts[pts.length - 1]);
  const T = 0.005, cells = new Set();
  for (const [lon, lat] of line) { const i = Math.floor(lat / T), j = Math.floor(lon / T); for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) cells.add(`${i + a},${j + b}`); }
  const rows = {};
  for (const c of cells) { const [i, j] = c.split(',').map(Number); (rows[i] = rows[i] || []).push(j); }
  const boxes = [];
  for (const [i, js] of Object.entries(rows)) {
    js.sort((a, b) => a - b);
    let start = js[0], prev = js[0];
    for (const j of [...js.slice(1), null]) {
      if (j !== null && j === prev + 1) { prev = j; continue; }
      boxes.push([+i * T, start * T, (+i + 1) * T, (prev + 1) * T]);
      if (j !== null) start = prev = j;
    }
  }
  return `[out:json][timeout:120];\n(\n${boxes.map(([s, w, n, e]) => `  way["highway"~"^(${ROAD_CLASSES})$"](${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)});\n`).join('')})->.roads;\n.roads out body;\nrelation(bw.roads)["type"="restriction"];\nout body;\n.roads >;\nout skel qt;\n`;
}
/** A route's roads: from the local server's day-old copy when there is one (tool/serve.py), else Overpass. */
async function roadsFor(p) {
  // twice: a dropped connection (a reload, a busy moment) shouldn't send this route to Overpass, slow and rationed
  for (let i = 0; i < (SERVER ? 2 : 1); i++) {
    try {
      const r = await fetch(`api/roads?pattern=${encodeURIComponent(p.id)}`);
      if (r.ok) return await r.json();
      break;   // the server answered, without roads for it
    } catch (e) { /* no server (a published copy of the page), or the connection dropped */ }
  }
  // a published copy: the roads its build fetched, the same day as its review (review.py --roads-per-route)
  if (!SERVER) {
    try {
      const r = await fetch(`data/roads/${p.id.replace(/[^A-Za-z0-9]/g, '_')}.json`);
      if (r.ok) return await r.json();
    } catch (e) { /* not there: Overpass */ }
  }
  let last = null;
  // each server, then again after a pause (a busy one is often free a few seconds on); the one that answers is
  // asked first next time
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise(r => setTimeout(r, 5000));
    for (const url of [...OVERPASS]) {
      try {
        // a minute at most: a busy server can hold a query for its whole timeout, and the next may be free
        const stop = new AbortController(), t = setTimeout(() => stop.abort(), 60000);
        const r = await fetch(url, {method: 'POST', body: new URLSearchParams({data: roadsQuery(p)}), signal: stop.signal}).finally(() => clearTimeout(t));
        if (!r.ok) { last = new Error(`Overpass ${r.status}`); continue; }
        const j = await r.json();
        // a 200 that gave up part way ('runtime error: Query timed out'): part of the roads, taken as all of them,
        // would route the bus around roads that are there. Not an answer: the next server.
        if (/error|timed out/i.test(j.remark || '')) { last = new Error(`Overpass gave up part way: ${j.remark.trim().slice(0, 120)}`); continue; }
        OVERPASS.splice(OVERPASS.indexOf(url), 1); OVERPASS.unshift(url);
        return j;
      } catch (e) { last = e; }
    }
  }
  throw last || new Error('no roads');
}
const stopsLL = p => Object.fromEntries(p.stops.map(s => [s, [D.stops[s].lon, D.stops[s].lat]]));
/** A route's roads and path: its roads when first needed, then routed here; kept on the pattern. -> true when it's there. */
async function ensureRouted(p) {
  if (p.routed) return true;
  if (p.routing) return p.routing;
  p.routing = (async () => {
    try {
      if (!p.graph) p.graph = new Router.Graph(await roadsFor(p));
      Object.assign(p, Router.routePattern({id: p.id, stops: p.stops, shape: p.shape}, stopsLL(p), p.graph, D.osm_stops, D.stop_areas || [], sid => D.stops[sid].match));
      markInRoad(p);
      return true;
    } catch (e) { p.routeError = e.message; return false; }
    finally { p.routing = null; }
  })();
  return p.routing;
}
/** What changed on OSM since flagstop's copy, for a route you open: its relations and its stops, read live
 *  (like iD), a request or two. Kept on the pattern for its page to say, with the changesets that did it. */
async function liveCheck(p) {
  const rels = p.relations.map(a => a.id);
  const nodes = [...new Set(p.stops.map(sid => matchedOsm(D.stops[sid])).filter(o => o && o.id[0] === 'n').map(o => osmNumId(o)))];
  const known = {};
  for (const a of p.relations) known['r' + a.id] = {v: a.version, name: a.name || 'r' + a.id};
  for (const n of nodes) { const o = D.osm_stops['n' + n]; known['n' + n] = {v: o.version, name: o.tags.name || 'n' + n}; }
  const read = async (kind, ids) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const r = await fetch(`${OSM_API}/api/0.6/${kind}s.json?${kind}s=${ids.slice(i, i + 100).join(',')}`);
      if (r.ok) out.push(...(await r.json()).elements);
    }
    return out;
  };
  try {
    const now = [...(rels.length ? await read('relation', rels) : []), ...(nodes.length ? await read('node', nodes) : [])];
    p.live = {at: Date.now(), changed: now.filter(e => known[e.type[0] + e.id] && e.version > known[e.type[0] + e.id].v)
      .map(e => ({key: e.type[0] + e.id, name: known[e.type[0] + e.id].name, from: known[e.type[0] + e.id].v, to: e.version, gone: e.visible === false, user: e.user, changeset: e.changeset, date: (e.timestamp || '').slice(0, 10)}))};
  } catch (e) { p.live = null; }   // offline: the copy is all there is
  if (S.pattern === p.id) render();
}
/** Bring a route's changes on OSM in: those changesets, from OSM's API, then the review rebuilt (seconds). */
async function bringIn(changesets) {
  try {
    let st = await (await fetch('api/refresh', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({changesets})})).json();
    if (st.error) return toast(`Couldn't: ${st.error}`, 8000);
    toast('Reading those edits from OSM and rebuilding…', 60000);
    while (st.running) { await new Promise(r => setTimeout(r, 1500)); st = await (await fetch('api/refresh')).json(); }
    if (st.error) return toast(`Couldn't: ${st.error}`, 8000);
    location.reload();
  } catch (e) { toast('Needs tool/serve.py running (' + e.message + ')', 6000); }
}
/** Route every itinerary in the background, one at a time, so the list fills in while you work. */
async function routeAll() {
  let fails = 0;
  for (const p of D.patterns) {
    if (p.routed || p.temporary) continue;
    let ok = await ensureRouted(p);
    // Overpass busy: a minute's rest and once more; three routes in a row without roads, stop asking (opening
    // a route tries again)
    if (!ok && fails < 2) { await new Promise(r => setTimeout(r, 60000)); ok = await ensureRouted(p); }
    if (ok && S.tab === 'routes' && !S.pattern) render();
    fails = ok ? 0 : fails + 1;
    if (fails >= 3) break;
  }
}
const FAR = () => (D.positions && D.positions.far) || 25;   // m: closer than this, the same spot (from the feed)
const relBase = a => ({version: a.version, tags: a.tags, members: a.members});
// Of an itinerary's relations, the one to keep: the oldest not marked for deletion (it carries the history).
const keptRelation = p => p.relations.filter(a => (Edits.get('r' + a.id) || {}).kind !== 'delete').sort((a, b) => a.id - b.id)[0];
const sameMember = (x, y) => (x.key && x.key === y.key) || (!x.key && !y.key && x.type === y.type && x.ref === y.ref);
/** Change the route_masters that list relation `drop` (by id) and/or route `r`: drop it, add `add` ({type, ref} or {key}). */
function editMasters(ids, drop, add) {
  for (const m of (D.masters || []).filter(m => ids.includes(m.id) || (drop && m.routes.includes(drop)))) {
    const cur = (Edits.get('r' + m.id) || {}).members || m.members;
    let members = drop ? cur.filter(x => !(x.type === 'relation' && x.ref === drop)) : cur;
    if (add && !members.some(x => sameMember(x, add))) members = [...members, {...add, role: ''}];
    if (JSON.stringify(members) !== JSON.stringify(cur)) Edits.modify('relation', m.id, relBase(m), {members}, 'master:' + m.id);
  }
}
function markDuplicate(a, p) {
  const keep = keptRelation({...p, relations: p.relations.filter(x => x.id !== a.id)});
  if (keep) Carry.onto({...a, id: 'r' + a.id}, asWillBe({...keep, id: 'r' + keep.id}), CARRY.relation);   // what of it is ticked, onto the one kept
  Edits.delete('relation', a.id, relBase(a), `duplicate of route ${routeOf(p).short}`);
  // A relation still in a route_master is not deleted by OSM (the upload uses if-unused): take it out, put the kept one in.
  editMasters([], a.id, keep ? {type: 'relation', ref: keep.id} : null);
  toast('Marked for deletion' + ((D.masters || []).some(m => m.routes.includes(a.id)) ? ', and swapped in its route_master' : '')); render();
}
// what an edit starts from: a point's position, or a way's node list (without it, an upload would empty the way)
const nodeBase = o => o.nodes ? {version: o.version, tags: o.tags, nodes: o.nodes} : {version: o.version, tags: o.tags, lat: o.lat, lon: o.lon};
const osmNumId = o => o.osm_id ?? +o.id.slice(1);

// ---------- map ----------
function initMap() {
  const b = D.feed.bbox;
  map = new maplibregl.Map({
    container: 'map', center: [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2], zoom: 11, attributionControl: {compact: false},
    style: {version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf', sources: {
      osm: {type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'},
      // aerial imagery, for where a stop's sign or shelter is: Esri's, as iD offers it for OSM editing
      sat: {type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'}},
      layers: [{id: 'sat', type: 'raster', source: 'sat', layout: {visibility: 'none'}}, {id: 'osm', type: 'raster', source: 'osm', paint: {'raster-saturation': -0.6, 'raster-opacity': 0.85}}]},
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  // imagery on or off: a button by the zoom buttons, and on by itself when a stop's place is the question
  const satCtl = {onAdd() { this.b = el('button', {class: 'sat', title: 'Aerial imagery (I)', onclick: () => imagery(!S.imagery)}, 'Imagery'); const d = el('div', {class: 'maplibregl-ctrl maplibregl-ctrl-group'}, this.b); return d; }, onRemove() {}};
  map.addControl(satCtl, 'top-right');
  window.imagery = on => {
    S.imagery = on; satCtl.b.classList.toggle('on', on);
    const apply = () => { map.setLayoutProperty('sat', 'visibility', S.imagery ? 'visible' : 'none'); map.setPaintProperty('osm', 'raster-opacity', S.imagery ? 0.3 : 0.85); };
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);   // asked before the map is up (a link straight to a stop): once it is
  };
  map.on('load', () => {
    setTimeout(() => hashRead ? draw() : applyHash());   // after the layers below exist: draw what's open
    for (const id of ['rel', 'shape', 'routed', 'div', 'divpath', 'gtfs', 'tether', 'stops', 'osmstops', 'vias', 'constraints', 'leg', 'edits', 'fixroad', 'stale', 'look', 'station']) map.addSource(id, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    map.addLayer({id: 'rel', type: 'line', source: 'rel', paint: {'line-color': css('--rel'), 'line-width': 7, 'line-opacity': 0.35}});
    map.addLayer({id: 'routed', type: 'line', source: 'routed', paint: {'line-color': css('--routed'), 'line-width': 4}});
    map.addLayer({id: 'shape', type: 'line', source: 'shape', paint: {'line-color': css('--shape'), 'line-width': 2, 'line-dasharray': [2, 2]}});
    map.addLayer({id: 'leg', type: 'line', source: 'leg', paint: {'line-color': css('--accent'), 'line-width': 8, 'line-opacity': 0.3}});
    map.addLayer({id: 'divpath', type: 'line', source: 'divpath', paint: {'line-color': css('--div'), 'line-width': 5, 'line-opacity': 0.6}});
    map.addLayer({id: 'div', type: 'circle', source: 'div', paint: {'circle-radius': 11, 'circle-color': css('--div'), 'circle-opacity': 0.25, 'circle-stroke-color': css('--div'), 'circle-stroke-width': 2}});
    // a proposed fix: the road, red as OSM has it or green as it would be, arrows the way traffic may go
    map.addLayer({id: 'fixroad', type: 'line', source: 'fixroad', layout: {'line-cap': 'round'}, paint: {'line-color': ['get', 'color'], 'line-width': 9, 'line-opacity': 0.75}});
    map.addLayer({id: 'fixarrows', type: 'symbol', source: 'fixroad', layout: {'symbol-placement': 'line', 'symbol-spacing': 28, 'text-field': '›', 'text-size': 22, 'text-font': ['Open Sans Semibold'], 'text-keep-upright': false, 'text-allow-overlap': true},
      paint: {'text-color': '#fff'}});
    map.addLayer({id: 'stale', type: 'circle', source: 'stale', paint: {'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': css('--miss'), 'circle-stroke-width': 3}});
    map.addLayer({id: 'tether', type: 'line', source: 'tether', paint: {'line-color': css('--muted'), 'line-width': 1, 'line-dasharray': [1, 1]}});
    // the agency's position: a soft hollow ring, deliberately not a hard dot
    map.addLayer({id: 'gtfs', type: 'circle', source: 'gtfs', paint: {'circle-radius': ['case', ['get', 'on'], 9, 7], 'circle-color': ['get', 'color'], 'circle-opacity': 0.12, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.7}});
    map.addLayer({id: 'osmstops', type: 'circle', source: 'osmstops', paint: {'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': css('--extra'), 'circle-stroke-width': 1.5}});
    // the OSM node: solid
    map.addLayer({id: 'stops', type: 'circle', source: 'stops', paint: {'circle-radius': ['case', ['get', 'on'], 7, 5], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5}});
    map.addLayer({id: 'stoplabels', type: 'symbol', source: 'stops', minzoom: 15, layout: {'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Open Sans Semibold'], 'text-optional': true},
      paint: {'text-color': css('--ink'), 'text-halo-color': css('--panel'), 'text-halo-width': 1.5}});
    map.addLayer({id: 'edits', type: 'circle', source: 'edits', paint: {'circle-radius': 10, 'circle-color': css('--edit'), 'circle-opacity': 0.2, 'circle-stroke-color': css('--edit'), 'circle-stroke-width': 2}});
    // a stop being looked at before deciding: where OSM has it (red), where the agency has it (green), the move between
    map.addLayer({id: 'lookline', type: 'line', source: 'look', filter: ['==', ['geometry-type'], 'LineString'], layout: {'line-cap': 'round'},
      paint: {'line-color': '#1c1b18', 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.8}});
    map.addLayer({id: 'lookarrows', type: 'symbol', source: 'look', filter: ['==', ['geometry-type'], 'LineString'],
      layout: {'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '›', 'text-size': 16, 'text-font': ['Open Sans Semibold'], 'text-keep-upright': false, 'text-allow-overlap': true},
      paint: {'text-color': '#1c1b18', 'text-halo-color': '#fff', 'text-halo-width': 2}});
    map.addLayer({id: 'looklen', type: 'symbol', source: 'look', filter: ['==', ['geometry-type'], 'LineString'],
      layout: {'symbol-placement': 'line-center', 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': ['Open Sans Semibold'], 'text-offset': [0, -1], 'text-allow-overlap': true},
      paint: {'text-color': '#1c1b18', 'text-halo-color': '#fff', 'text-halo-width': 2}});
    map.addLayer({id: 'lookpts', type: 'circle', source: 'look', filter: ['==', ['geometry-type'], 'Point'],
      paint: {'circle-radius': ['case', ['==', ['get', 'kind'], 'other'], 8, 10], 'circle-color': 'rgba(255,255,255,0.25)',
        'circle-stroke-color': ['match', ['get', 'kind'], 'now', css('--miss'), 'to', css('--ok'), '#8a857b'], 'circle-stroke-width': ['case', ['==', ['get', 'kind'], 'other'], 2, 3]}});
    map.addLayer({id: 'looklabels', type: 'symbol', source: 'look', filter: ['==', ['geometry-type'], 'Point'],
      layout: {'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Open Sans Semibold'], 'text-anchor': 'left', 'text-offset': [1.2, 0], 'text-allow-overlap': true, 'text-max-width': 14},
      paint: {'text-color': ['match', ['get', 'kind'], 'now', css('--miss'), 'to', '#1f6b38', '#6f6a60'], 'text-halo-color': '#fff', 'text-halo-width': 2.5}});
    // a station card: the station points, the bays, stop positions now, and the ones it would add (green) or remove (red)
    map.addLayer({id: 'stationline', type: 'line', source: 'station', filter: ['==', ['geometry-type'], 'LineString'], paint: {'line-color': css('--edit'), 'line-width': 1.5, 'line-dasharray': [1, 1]}});
    map.addLayer({id: 'stationpts', type: 'circle', source: 'station', filter: ['==', ['geometry-type'], 'Point'],
      paint: {'circle-radius': ['match', ['get', 'kind'], 'station', 9, 'bay', 7, 'other', 6, 5],
        'circle-color': ['match', ['get', 'kind'], 'station', '#1c1b18', 'bay', css('--accent'), 'other', '#fff', 'new', css('--edit'), 'going', css('--miss'), '#8a857b'],
        'circle-stroke-color': ['match', ['get', 'kind'], 'other', '#8a857b', '#fff'], 'circle-stroke-width': 2}});
    map.addLayer({id: 'stationlabels', type: 'symbol', source: 'station', filter: ['==', ['geometry-type'], 'Point'],
      layout: {'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Open Sans Semibold'], 'text-anchor': 'left', 'text-offset': [1, 0], 'text-allow-overlap': false, 'text-optional': true},
      paint: {'text-color': '#1c1b18', 'text-halo-color': '#fff', 'text-halo-width': 2}});
    // the reviewer's say: roads the bus doesn't use hatched, roads it does solid, via points as dots, all one colour
    map.addLayer({id: 'avoid', type: 'line', source: 'constraints', filter: ['==', ['get', 'kind'], 'avoid'], paint: {'line-color': css('--div'), 'line-width': 5, 'line-dasharray': [0.6, 1.2], 'line-opacity': 0.85}});
    map.addLayer({id: 'require', type: 'line', source: 'constraints', filter: ['==', ['get', 'kind'], 'require'], paint: {'line-color': css('--div'), 'line-width': 5, 'line-opacity': 0.85}});
    map.addLayer({id: 'vias', type: 'circle', source: 'vias', paint: {'circle-radius': 6, 'circle-color': css('--div'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
    for (const layer of ['stops', 'gtfs', 'osmstops', 'div']) {
      map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', layer, () => map.getCanvas().style.cursor = S.viaMode ? 'crosshair' : '');
    }
    map.on('click', 'stops', e => { e.preventDefault(); if (S.stopDragged) { S.stopDragged = false; return; } showStop(e.features[0].properties.id); });
    // the selected stop's OSM node can be dragged to where the sign is
    map.on('mousedown', 'stops', e => {
      const id = e.features[0].properties.id, s = D.stops[id], o = s && matchedOsm(s);
      if (Roads.on || S.tab !== 'stops' || S.stop !== id || !o) return;
      e.preventDefault();
      const start = e.point; let moved = false;
      map.getCanvas().style.cursor = 'grabbing';
      const move = ev => {
        if (!moved && Math.hypot(ev.point.x - start.x, ev.point.y - start.y) < 4) return;
        moved = true; S.stopDrag = [ev.lngLat.lng, ev.lngLat.lat]; draw();
      };
      map.on('mousemove', move);
      map.once('mouseup', () => {
        map.off('mousemove', move); map.getCanvas().style.cursor = '';
        const at = S.stopDrag; S.stopDrag = null;
        if (!moved || !at) return draw();
        S.stopDragged = true; setTimeout(() => { S.stopDragged = false; }, 0);
        Edits.label(`move stop ${s.ref} ${s.name}`);
        Edits.modify('node', osmNumId(o), nodeBase(o), {lat: at[1], lon: at[0]}, `${s.ref} ${s.name}`);
        toast(`Stop moved ${Math.round(m([o.lon, o.lat], at))} m (in Changes)`); render(); draw();
      });
    });
    map.on('mouseenter', 'stops', e => { const id = e.features[0].properties.id; if (!Roads.on && S.tab === 'stops' && S.stop === id) map.getCanvas().style.cursor = 'grab'; });
    map.on('click', 'gtfs', e => { e.preventDefault(); showStop(e.features[0].properties.id); });
    map.on('click', 'osmstops', e => { e.preventDefault(); popupOsm(e.features[0].properties.id, e.lngLat); });
    map.on('click', 'div', e => { e.preventDefault(); popupDiv(JSON.parse(e.features[0].properties.d), e.lngLat); });
    map.on('click', e => { if (S.viaMode && !e.defaultPrevented) viaClick([e.lngLat.lng, e.lngLat.lat]); });
    Roads.init();
    draw();
  });
}
const fc = feats => ({type: 'FeatureCollection', features: feats});
const line = (coords, props = {}) => ({type: 'Feature', geometry: {type: 'LineString', coordinates: coords}, properties: props});
const point = (c, props = {}) => ({type: 'Feature', geometry: {type: 'Point', coordinates: c}, properties: props});
const set = (id, feats) => map && map.getSource(id) && map.getSource(id).setData(fc(feats));
const statusColor = st => css({matched: '--ok', ambiguous: '--amb', moved: '--amb', missing: '--miss'}[st] || '--miss');

function stopFeatures(ids) {
  const solid = [], rings = [], tethers = [];
  for (const id of ids) {
    const s = D.stops[id], st = stopStatus(s), o = matchedOsm(s), color = statusColor(st), on = S.stop === id || S.reviewStop === id || S.lookStop === id;
    const label = ids.length < 60 ? `${ids.indexOf(id) + 1} · ${s.name}` : s.name;
    if (o) {
      const at = on && S.stopDrag ? S.stopDrag : osmPos(o);
      solid.push(point(at, {id, color, label, on}));
      // the selected stop always shows the agency's point too, so there's something to drag towards
      if (on || m(at, [s.lon, s.lat]) > FAR()) { rings.push(point([s.lon, s.lat], {id, color, on})); tethers.push(line([at, [s.lon, s.lat]])); }
    } else {
      rings.push(point([s.lon, s.lat], {id, color, on, label}));
      if ((st === 'moved' || st === 'ambiguous') && s.match) for (const c of s.match.osm) { const x = D.osm_stops[c.id]; if (x) { solid.push(point([x.lon, x.lat], {id, color, label: x.tags.name || '', on: false})); tethers.push(line([[x.lon, x.lat], [s.lon, s.lat]])); } }
    }
  }
  return {solid, rings, tethers};
}
function editFeatures() {
  return Object.values(Edits.ops).filter(op => op.type === 'node' && op.lat != null).map(op => point([op.lon, op.lat], {key: op.kind}));
}
function draw() {
  if (!map || !map.getSource('stops')) return;
  const p = S.pattern && patternById(S.pattern);
  set('edits', editFeatures());
  set('fixroad', typeof Fix !== 'undefined' ? Fix.features() : []);
  set('stale', typeof Merge !== 'undefined' ? Merge.staleFeatures() : []);
  set('look', lookFeatures());
  set('station', typeof Station !== 'undefined' ? Station.features() : []);
  Roads.drawAll();
  if (p) {
    const r = routedOf(p);
    set('shape', p.shape.length ? [line(p.shape)] : []);
    // proposing a merge: show the relations as they are, or the route as the one relation would have it
    const mv = S.merge && S.merge.pid === p.id ? S.merge.view : null;
    // (on a detour, the one relation is the kept one as it is: its roads, not the detour's path)
    const asIs = mv === 'proposed' && detoured(p), kept = asIs && keptRelation(p);
    set('routed', r.geometry.length && mv !== 'now' && !asIs ? [line(r.geometry)] : []);
    set('rel', asIs ? (kept ? kept.geometry.map(g => line(g, {id: kept.id})) : []) : mv === 'proposed' ? [] : p.relations.flatMap(a => a.geometry.map(g => line(g, {id: a.id}))));
    set('div', r.divergences.map(d => point([d.lon, d.lat], {d: JSON.stringify({...d, shape: undefined, path: undefined})})));
    set('divpath', r.divergences.flatMap(d => [d.shape && d.shape.length > 1 ? line(d.shape) : null, d.path && d.path.length > 1 ? line(d.path) : null].filter(Boolean)));
    const f = stopFeatures(p.stops);
    set('stops', f.solid); set('gtfs', f.rings); set('tether', f.tethers);
    const inP = new Set(p.stops.map(id => matchedOsm(D.stops[id])).filter(Boolean).map(o => o.id));
    set('osmstops', Object.values(D.osm_stops).filter(o => !inP.has(o.id) && o.tags.public_transport !== 'stop_position').map(o => point([o.lon, o.lat], {id: o.id})));
    const rc = Edits.routingOf(p.id);
    set('vias', rc.vias.map(v => point(v)));
    set('constraints', constraintFeatures(p, rc));
  } else {
    for (const id of ['shape', 'routed', 'rel', 'div', 'divpath', 'vias', 'constraints', 'leg']) set(id, []);
    const ids = Object.values(D.stops).filter(stopFilter).map(s => s.id);
    const f = stopFeatures(ids);
    set('stops', f.solid); set('gtfs', f.rings); set('tether', f.tethers);
    const claimed = new Set(Object.values(D.stops).map(s => matchedOsm(s)).filter(Boolean).map(o => o.id));
    set('osmstops', (S.tab === 'extra' ? D.extra_stops.map(id => D.osm_stops[id]) : Object.values(D.osm_stops).filter(o => !claimed.has(o.id))).filter(o => o && o.tags.public_transport !== 'stop_position').map(o => point([o.lon, o.lat], {id: o.id})));
  }
}
function fit(pts, pad = 60) {
  if (!pts.length) return;
  const b = bboxOf(pts);
  map.fitBounds([[b.left, b.bottom], [b.right, b.top]], {padding: {top: pad, bottom: pad, left: pad, right: pad}, duration: 500, maxZoom: 17});
}

// ---------- popups ----------
function popupOsm(id, ll) {
  const o = D.osm_stops[id], t = o.tags;
  const pop = new maplibregl.Popup({closeButton: false, maxWidth: '320px'}).setLngLat(ll).setDOMContent(el('div', {},
    el('b', {}, t.name || '(no name)'), el('div', {class: 'muted'}, `${id} · ${Object.entries(t).filter(([k]) => ['ref', 'route_ref', 'highway', 'public_transport', 'operator', 'network'].includes(k)).map(([k, v]) => k + '=' + v).join(' · ')}`),
    el('div', {}, el('a', {href: osmLink(id), target: '_blank'}, 'osm.org'), ' · ', editorButtons({lon: o.lon, lat: o.lat, select: [id]}, {small: true})),
    Station.ofOsm(id) ? el('div', {style: 'margin-top:6px'}, el('button', {class: 'b tiny primary', onclick: () => { pop.remove(); Station.open(Station.ofOsm(id).id); }}, `${Station.ofOsm(id).stations[0].tags.name || 'The station'}: how it's mapped`)) : null)).addTo(map);
}
// What a divergence means, in words: the map stopping the bus, not the bus going somewhere else.
const divTitle = d => d.kind === 'no-path' ? 'no way through on the map' : d.kind === 'uncovered' ? 'line not followed' : "bus can't follow the line";
function popupDiv(d, ll) {
  const box = el('div', {});
  box.append(el('b', {}, divTitle(d)), ` · ${d.length} m${d.max ? ` (up to ${d.max} m off)` : ''}`, el('div', {}, d.why),
    d.kind === 'detour' ? el('div', {class: 'muted', style: 'margin-top:4px'}, 'The blue line goes round because of this: it\'s the nearest way a bus could legally drive on the map as it is, not a suggested route. Fix the map and it follows the orange line again.') : null);
  // the fix first: flagstop's proposal, shown as before and after, for a yes or no
  if (d.fix && S.routedBy !== 'changes') box.append(el('div', {style: 'margin-top:8px'}, el('button', {class: 'b primary', onclick: () => Fix.open(d)}, `See the fix: ${d.fix.name} ${d.fix.want}`)));
  // the roads under it, for looking closer: folded away
  const list = el('details', {class: 'small', style: 'margin-top:6px'}, el('summary', {}, `the ${d.ways.length} road${d.ways.length === 1 ? '' : 's'} here`));
  for (const w of d.ways) {
    const t = (d.way_tags || {})[w] || {};
    const row = el('div', {style: 'margin-top:3px'}, el('a', {href: 'https://www.openstreetmap.org/way/' + w, target: '_blank'}, 'w' + w), ' ', el('span', {class: 'muted'}, `${t.highway || ''} ${t.name || ''} ${t.oneway ? 'oneway=' + t.oneway : ''} ${t.access ? 'access=' + t.access : ''}`));
    row.append(' ', el('a', {href: '#', onclick: e => { e.preventDefault(); wayTagEditor(w, t, [d.lon, d.lat]); }}, 'edit tags'));
    list.append(row);
  }
  if (d.ways.length) box.append(list);
  box.append(el('div', {style: 'margin-top:6px'},
    editorButtons({lon: d.lon, lat: d.lat, zoom: 17, select: d.ways.map(w => 'w' + w), pattern: patternById(S.pattern), pts: d.shape, comment: `Bus route ${routeOf(patternById(S.pattern)).short}: ${d.why.slice(0, 80)}`}, {small: true})));
  new maplibregl.Popup({closeButton: true, maxWidth: '360px'}).setLngLat(ll).setDOMContent(box).addTo(map);
}
/** A tiny tag editor for a way: enough for oneway/access/bus fixes. base: the live way, when the road editor has it. */
function wayTagEditor(wid, tags, at, base) {
  const cur = Edits.get('w' + wid);
  const t = {...(cur ? cur.tags : tags)};
  const box = el('div', {class: 'small'}, el('b', {}, `way ${wid}`), el('div', {class: 'muted'}, 'Tags. Its shape is for RapiD or iD.'));
  // with an itinerary open: the reviewer's say over the router, kept with the decisions
  if (S.pattern && patternById(S.pattern)) {
    const r = Edits.routingOf(S.pattern);
    const b = (kind, label) => el('button', {class: 'b tiny' + (r[kind].includes(wid) ? ' on' : ''), title: r[kind].includes(wid) ? 'Said already: again takes it back' : `Re-routes route ${routeOf(patternById(S.pattern)).short} with that`,
      onclick: () => { pop.remove(); wayConstraint(wid, kind); }}, label);
    box.append(el('div', {class: 'btns', style: 'margin:6px 0'}, b('require', 'bus uses this road'), b('avoid', "bus doesn't")));
  }
  const grid = el('div', {class: 'kv', style: 'grid-template-columns:max-content 1fr auto'});
  const rows = {};
  const addRow = (k, v) => {
    const kin = el('input', {value: k, placeholder: 'key', style: 'width:110px'}), vin = el('input', {value: v, placeholder: 'value'});
    const rm = el('button', {class: 'b tiny', onclick: () => { grid.removeChild(kin); grid.removeChild(vin); grid.removeChild(rm); delete rows[k]; }}, '×');
    rows[k] = [kin, vin]; grid.append(kin, vin, rm);
  };
  for (const [k, v] of Object.entries(t)) addRow(k, v);
  box.append(grid, el('div', {class: 'btns'},
    el('button', {class: 'b tiny', onclick: () => addRow('', '')}, '+ tag'),
    el('button', {class: 'b tiny', onclick: () => { rows.oneway ? (rows.oneway[1].value = rows.oneway[1].value === 'yes' ? '-1' : 'yes') : addRow('oneway', 'yes'); }}, 'flip oneway'),
    el('button', {class: 'b tiny', onclick: () => { if (!rows['bus']) addRow('bus', 'yes'); else rows.bus[1].value = 'yes'; }}, 'bus=yes'),
    el('button', {class: 'b primary tiny', onclick: () => {
      const nt = {};
      for (const [kin, vin] of Object.values(rows)) if (kin.value.trim()) nt[kin.value.trim()] = vin.value.trim();
      const removed = Object.keys(tags).filter(k => !(k in nt));
      if (base) Roads.modifyWay(wid, {tags: nt, removeTags: removed}, `way ${wid}: ${(tags.name || tags.highway || '')}`);
      else Edits.modify('way', wid, {version: null, tags, nodes: (patternById(S.pattern) || {}).way_nodes?.[wid]}, {tags: nt, removeTags: removed}, `way ${wid}: ${(tags.name || tags.highway || '')}`);
      toast('Way tags added to changes'); pop.remove(); render(); draw();
    }}, 'Add to changes')));
  const pop = new maplibregl.Popup({closeButton: true, maxWidth: '380px'}).setLngLat(at).setDOMContent(box).addTo(map);
}

// ---------- re-routing: via points, roads the bus uses, roads it doesn't (Edits.routing: kept, undoable) ----------
/** In via mode, a click on a road (within 12 m, of the route's own roads) is about the road; on open map, a via point. */
function viaClick(ll) {
  const p = patternById(S.pattern), hit = p && p.graph && p.graph.snap(ll, 12);
  if (hit) return wayTagEditor(hit[1], (p.graph.ways.get(hit[1]) || {}).tags || {}, ll);
  addVia(ll);
}
function setRouting(pid, r) { S.routedWith = JSON.stringify(r || {vias: [], avoid: [], require: []}); Edits.setRouting(pid, r); }
async function addVia(v) { const p = patternById(S.pattern), r = Edits.routingOf(p.id); r.vias.push(v); Edits.label('via point'); setRouting(p.id, r); await retrace(); }
/** The bus uses this road (require) or doesn't (avoid); the same again takes it back. */
async function wayConstraint(wid, kind) {
  const p = patternById(S.pattern), r = Edits.routingOf(p.id), other = kind === 'avoid' ? 'require' : 'avoid';
  const on = r[kind].includes(wid);
  r[kind] = r[kind].filter(w => w !== wid); r[other] = r[other].filter(w => w !== wid);
  if (!on) r[kind].push(wid);
  Edits.label(`${kind === 'avoid' ? "bus doesn't use" : 'bus uses'} way ${wid}`); setRouting(p.id, r);
  await retrace();
}
const describeRouting = r => [r.vias.length ? `through ${r.vias.length} via point${r.vias.length === 1 ? '' : 's'}` : '',
  r.require.length ? `on ${r.require.length} road${r.require.length === 1 ? '' : 's'} you picked` : '',
  r.avoid.length ? `off ${r.avoid.length} road${r.avoid.length === 1 ? '' : 's'} you excluded` : ''].filter(Boolean).join(', ');
async function retrace() {
  const p = patternById(S.pattern), r = Edits.routingOf(p.id);
  await liveRoute();
  if (S.routedBy === 'vias') toast(`Re-routed ${describeRouting(r)}: ${S.routed.ways.length} ways`);
  else if (r.vias.length || r.avoid.length || r.require.length) toast(`Couldn't re-route: ${p.routeError || "this route's roads haven't loaded"}`, 5000);
  else toast('Re-routing cleared: the route as flagstop traced it');
  render(); draw();
}
/** The roads the reviewer ruled in or out, as lines, once the route's roads are loaded. */
function constraintFeatures(p, r) {
  if (!p.graph) return [];
  const feat = (w, kind) => { const way = p.graph.ways.get(w), c = way ? way.nodes.filter(n => p.graph.coord.has(n)).map(n => p.graph.coord.get(n)) : []; return c.length > 1 ? line(c, {kind, id: w}) : null; };
  return [...r.avoid.map(w => feat(w, 'avoid')), ...r.require.map(w => feat(w, 'require'))].filter(Boolean);
}

// ---------- panel ----------
function render() {
  const P = $('#panel'); P.innerHTML = '';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#tabs button[data-tab=changes]').textContent = Edits.count() ? `Changes (${Edits.count()})` : 'Changes';
  if (S.tab === 'routes') S.fixit && S.pattern ? FixIt.render(P) : S.merge && S.pattern ? Merge.render(P) : S.fix && S.pattern ? Fix.render(P) : S.review && patternById(S.review) ? Review.render(P, patternById(S.review)) : S.pattern ? renderPattern(P, patternById(S.pattern)) : renderRoutes(P);
  else if (S.tab === 'stops') S.station ? Station.render(P) : S.stop ? renderStop(P, D.stops[S.stop]) : renderStops(P);
  else if (S.tab === 'extra') renderExtra(P);
  else if (S.tab === 'changes') { renderChanges(P); const x = el('div', {class: 'detail'}); Losses.render(x); P.append(x); }   // and what uploads took away
  else renderAbout(P);
  syncHash();
}
/** A count at the top of a list; with `go`, a way into what it counts (nothing to go to at 0). */
const tile = (n, label, cls = '', go = null, on = false) => go && n
  ? el('button', {class: `tile go ${cls}${on ? ' on' : ''}`, title: on ? 'Showing only these: click to show all' : `Show only these: ${label}`, onclick: go}, el('b', {}, n), el('span', {}, label))
  : el('div', {class: 'tile ' + cls}, el('b', {}, n), el('span', {}, label));
/** Open the Stops tab with one of its filters. */
const stopsWith = f => { S.tab = 'stops'; S.stop = null; S.filter = f; S.q = ''; render(); draw(); $('#panel').scrollTop = 0; };
/** Itineraries the Routes list can be narrowed to, by the tiles over it. */
const ROUTE_FILTERS = {norel: ['no OSM relation', p => !p.temporary && !p.relations.length], twice: ['mapped twice', p => !p.temporary && p.relations.some(r => r.duplicate)]};
const refBadge = r => el('span', {class: 'ref', style: r.color ? `background:#${r.color};color:#${r.text_color || '000'}` : ''}, r.short);

/** What's waiting in Changes for an itinerary (not uploaded yet): a merge, its relation, its stops. With
 *  from = Edits.uploaded: what went up for it that the OSM data here doesn't have yet. */
function pending(p, from = Edits.ops) {
  const rels = p.relations.map(a => from['r' + a.id]).filter(Boolean);
  const osm = new Set(p.stops.map(id => { const s = D.stops[id], o = matchedOsm(s) || (s.match && s.match.osm && s.match.osm[0] && D.osm_stops[s.match.osm[0].id]); return o && osmNumId(o); }).filter(Boolean));
  const stops = new Set(Object.values(from).filter(o => o.type === 'node' && (osm.has(o.id) || (o.kind === 'create' && p.stops.includes(o.tags['gtfs:stop_id'])))).map(o => o.id)).size;
  const bits = [rels.some(o => o.kind === 'delete') ? 'merge' : rels.length ? 'relation' : null, stops ? `${stops} stop${stops > 1 ? 's' : ''}` : null].filter(Boolean);
  return bits;
}
function pendingChip(p) {
  const bits = pending(p);
  if (bits.length) return el('span', {class: 'chip edit', title: 'Waiting in Changes, not uploaded yet'}, `in Changes: ${bits.join(', ')}`);
  const up = pending(p, Edits.uploaded);
  return up.length ? el('span', {class: 'chip edit', title: "Uploaded. The rest of this page shows OSM as it was until the next refresh"}, `uploaded: ${up.join(', ')}`) : null;
}
/** Open OSM notes someone left by a stop: worth reading before deciding anything about it. */
function noteLines(notes) {
  if (!notes || !notes.length) return null;
  return el('div', {class: 'note warn'}, ...notes.map(n => el('div', {}, el('b', {}, 'OSM note: '), `“${n.text.length > 220 ? n.text.slice(0, 219) + '…' : n.text}” `,
    el('span', {class: 'muted'}, n.date + ' · '), el('a', {href: `https://www.openstreetmap.org/note/${n.id}`, target: '_blank'}, `note ${n.id}`))));
}
/** Comments other mappers left on your changesets: a question about an edit wants an answer. */
async function changesetTalk(box) {
  const me = Edits.auth.user();
  if (!me) return;
  try {
    const list = (await (await fetch(`${OSM_API}/api/0.6/changesets.json?user=${me.id}&limit=25`)).json()).changesets || [];
    const talked = list.filter(c => c.comments_count > 0);
    if (!talked.length) return;
    const full = await Promise.all(talked.map(async c => (await (await fetch(`${OSM_API}/api/0.6/changeset/${c.id}.json?include_discussion=true`)).json()).changeset || c));
    const lines = full.flatMap(c => (c.comments || []).filter(x => x.uid !== me.id).map(x => ({c, x})));
    if (!lines.length) return;
    box.append(el('div', {class: 'note warn'}, el('b', {}, `Comments on your changesets: ${lines.length}`),
      ...lines.slice(-8).map(({c, x}) => el('div', {style: 'margin-top:4px'}, el('a', {href: `https://www.openstreetmap.org/changeset/${c.id}`, target: '_blank'}, `${c.id}`), ` ${x.user}, ${(x.date || '').slice(0, 10)}: “${x.text.length > 200 ? x.text.slice(0, 199) + '…' : x.text}”`))));
  } catch (e) { /* offline: nothing to say */ }
}
/** What changed since the last feed version reviewed: where to look first after the agency publishes. */
function feedChanges() {
  const c = D.feed_changes;
  if (!c) return null;
  const n = c.stops_added.length + c.stops_removed.length + c.stops_moved.length + c.stops_renamed.length + c.routes_added.length + c.routes_removed.length + c.routes_changed.length;
  const box = el('details', {class: 'note' + (n ? ' warn' : ''), open: n ? '' : null}, el('summary', {}, n ? `Since the last feed (${c.since || c.since_start}): ${n} change${n > 1 ? 's' : ''}` : `No changes since the last feed (${c.since || c.since_start})`));
  const stop = (id, label) => D.stops[id] ? el('a', {href: '#', onclick: e => { e.preventDefault(); showStop(id); }}, label || D.stops[id].name) : el('span', {}, label || id);
  const line = (title, items) => items.length ? el('div', {style: 'margin:4px 0'}, el('b', {}, `${title}: `), ...items.flatMap((x, i) => [i ? ', ' : '', x])) : null;
  box.append(...[
    line('New stops', c.stops_added.map(s => stop(s.id, `${s.name} (${s.routes.join(', ')})`))),
    line('Stops gone', c.stops_removed.map(s => el('span', {}, `${s.name} (code ${s.code})`))),
    c.stops_removed.length ? el('div', {class: 'muted small'}, 'A stop gone from the feed shows up in OSM only, to remove after a look.') : null,
    line('Stops moved', c.stops_moved.map(s => stop(s.id, `${s.name} (${s.m} m)`))),
    line('Renamed', c.stops_renamed.map(s => stop(s.id, `${s.from} → ${s.to}`))),
    line('New routes', c.routes_added.map(r => el('span', {}, r))),
    line('Routes gone', c.routes_removed.map(r => el('span', {}, r))),
    line('Routes with different stops', c.routes_changed.map(r => el('span', {}, `${r.route} (+${r.stops_added.length} −${r.stops_removed.length})`))),
  ].filter(Boolean));
  return box;
}
function renderRoutes(P) {
  const s = D.summary;
  const rf = ROUTE_FILTERS[S.routeFilter] ? S.routeFilter : null, only = f => () => { S.routeFilter = S.routeFilter === f ? null : f; render(); };
  P.append(el('div', {class: 'tiles'},
    tile(D.patterns.filter(p => !p.temporary).length, 'itineraries', '', rf ? only(null) : null), tile(s.patterns['no relation'] || 0, 'no OSM relation', s.patterns['no relation'] ? 'bad' : '', only('norel'), rf === 'norel'), tile((s.patterns['duplicate relations'] || 0), 'mapped twice', s.patterns['duplicate relations'] ? 'warn' : '', only('twice'), rf === 'twice'),
    tile(s.stops.matched || 0, 'stops matched', '', () => stopsWith('matched')), tile((s.stops.ambiguous || 0) + (s.stops.moved || 0), 'to decide', 'warn', () => stopsWith('decide')), tile(s.stops.missing || 0, 'not in OSM', s.stops.missing ? 'bad' : '', () => stopsWith('missing'))));
  // a station with something to sort out (two station points, no stop area, …): its card, from here too
  for (const pl of rf ? [] : Station.places()) {
    const is = Station.issues(pl);
    if (is.length) P.append(el('div', {class: 'row', onclick: () => Station.open(pl.id)},
      el('span', {class: 'dotc ambiguous'}), el('div', {class: 'grow'}, el('div', {class: 't'}, `${pl.stations[0].tags.name || 'A station'}: ${pl.bays.length} bays`), el('div', {class: 's', style: 'white-space:normal'}, is.join(' · '))),
      el('span', {class: 'chip warn'}, 'station')));
  }
  const fc = feedChanges();
  if (fc) P.append(fc);
  P.append(el('h2', {}, rf ? `Itineraries: ${ROUTE_FILTERS[rf][0]}` : 'Itineraries, worst first'), ...(rf ? [el('div', {class: 'hint'}, el('a', {href: '#', onclick: e => { e.preventDefault(); S.routeFilter = null; render(); }}, 'show all'))] : []),
    el('div', {class: 'hint'}, 'The percentage is how much of the agency\'s line a bus can drive on OSM\'s roads as mapped. Below 100%, something on the map is in the way.'));
  const rows = D.patterns.filter(p => !rf || ROUTE_FILTERS[rf][1](p)).map(p => ({p, g: patternGrade(p), sc: p.routed ? (p.routed.score ? p.routed.score.shape_covered : 0) : 1}));
  rows.sort((a, b) => a.g.order - b.g.order || a.sc - b.sc || b.p.trips - a.p.trips);
  for (const {p, g, sc} of rows) {
    const r = routeOf(p), nd = routedOf(p).divergences.length;
    P.append(el('div', {class: 'row' + (p.temporary ? ' dim' : ''), onclick: () => selectPattern(p.id)},
      refBadge(r),
      el('div', {class: 'grow'}, el('div', {class: 't'}, p.headsign || p.direction_name || r.long || ('direction ' + p.direction)),
        el('div', {class: 's'}, `${p.stops.length} stops · ${p.trips} trips${nd ? ` · ${nd} place${nd > 1 ? 's' : ''} to look at` : ''}${p.routed && !p.chain_ok ? ' · path broken' : ''}`)),
      p.routed ? el('span', {class: 'pct' + (sc < 0.97 ? ' low' : ''), title: 'share of the agency line drivable on OSM roads'}, pct(sc))
        : el('span', {class: 'pct muted', title: "its roads haven't loaded yet"}, p.routeError ? '?' : '…'),
      pendingChip(p),
      el('span', {class: 'chip ' + g.cls}, g.chip)));
  }
  if (D.unpaired_relations.length && !rf) {
    P.append(el('h2', {}, 'OSM bus relations not in this feed'));
    for (const u of D.unpaired_relations) {
      P.append(el('div', {class: 'row', onclick: () => { set('rel', u.geometry.map(g => line(g))); fit(u.geometry.flat()); }},
        el('span', {class: 'ref'}, u.tags.ref || '?'),
        el('div', {class: 'grow'}, el('div', {class: 't'}, u.tags.name || `relation ${u.id}`), el('div', {class: 's'}, `${u.tags.operator || u.tags.network || ''} · ${u.ways} ways · ${u.stops} stops`)),
        el('a', {href: 'https://www.openstreetmap.org/relation/' + u.id, target: '_blank', class: 'small'}, 'osm')));
    }
  }
}

/** After undoing someone's edit: a record of it for their changeset. It reads as what it is, tool output:
    facts (ids, versions, changesets, effect), no greeting, no thanks. The reviewer posts it, or doesn't. */
function revertNote(u, newId) {
  const text = u.kind === 'stop'
    ? `[flagstop] Moved bus stop node ${u.node} (${u.name}) back ${u.m} m to its position before this edit, in changeset ${newId}. The agency's stop is at that position (GTFS).`
    : `[flagstop] Reverted direction of way ${u.way} (${u.name}) in changeset ${newId}. This edit made it ${u.was}, leaving no ${u.now.replace('one-way ', '')}bound way here.${u.route ? ` Used by bus route ${u.route}.` : ''}`;
  const ta = el('textarea', {rows: 3, style: 'width:100%;margin-top:4px'}); ta.value = text;
  return el('div', {class: 'note', style: 'margin-top:10px'},
    el('b', {}, `Record for ${u.user}'s changeset ${u.changeset}`), el('div', {class: 'muted'}, 'This upload undid part of it. To leave a record there, copy this into the comment box on their changeset:'),
    ta, el('div', {class: 'btns'},
      el('button', {class: 'b tiny', onclick: () => navigator.clipboard.writeText(ta.value).then(() => toast('Copied'))}, 'Copy'),
      el('a', {class: 'b tiny', href: `${OSM_WWW}/changeset/${u.changeset}`, target: '_blank', style: 'text-decoration:none'}, `Open changeset ${u.changeset}`)));
}

/** What this basket uploaded ('lastUpload', 'uploads'), kept beside it: per agency, and per sandbox generation,
 *  so another agency or a sandbox reset doesn't show (or refresh with) changesets that aren't its own. Before
 *  they were kept this way they had one key for everything: still read, for the real OSM only. */
function myUploads(what) {
  const world = typeof FLAGSTOP_OSM !== 'undefined' && FLAGSTOP_OSM.world;
  try { return JSON.parse(localStorage.getItem(Edits.key + '.' + what) || (!world && localStorage.getItem('flagstop.' + what)) || 'null'); } catch (e) { return null; }
}
/** Fetch OSM again and rebuild the review on the server, then show it. */
async function refreshOSM() {
  try {
    // your uploads the data doesn't have yet: read straight from OSM (seconds), not Overpass (minutes, and behind)
    const ups = myUploads('uploads') || [];
    const changesets = ups.filter(u => !D.osm_base || new Date(u.at) > new Date(D.osm_base)).map(u => u.id);
    let st = await (await fetch('api/refresh', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({changesets})})).json();
    if (st.error) return toast(`Refresh failed: ${st.error}`, 8000);
    toast(changesets.length ? `Reading your upload${changesets.length > 1 ? 's' : ''} from OSM and rebuilding the review…` : 'Fetching OSM again and rebuilding the review: a minute or two…', 120000);
    while (st.running) { await new Promise(r => setTimeout(r, 3000)); st = await (await fetch('api/refresh')).json(); }
    if (st.error) return toast(`Refresh failed: ${st.error}`, 8000);
    location.reload();
  } catch (e) { toast('Refreshing needs tool/serve.py running (' + e.message + ')', 6000); }
}

// ---------- looking before deciding: a stop's move is decided on the map, not from text ----------
/** Show a stop on the map: the agency's point and OSM's stop, both in view, with the line between them.
    Deciding to move it (or not) waits until this has been done for it. */
function lookAt(sid) {
  const s = D.stops[sid], c = s.match && s.match.osm || [];
  const o = matchedOsm(s) || (c[0] && D.osm_stops[c[0].id]);
  S.looked.add(sid); S.lookStop = sid;
  render(); draw();
  const pts = [[s.lon, s.lat], ...(o ? [osmPos(o)] : []), ...c.slice(1).map(x => D.osm_stops[x.id]).filter(Boolean).map(x => [x.lon, x.lat]), ...(mergedWith(s) ? [[mergedWith(s).lon, mergedWith(s).lat]] : [])];
  if (!S.imagery && typeof imagery === 'function') imagery(true);   // the sign, the shelter, the kerb: what decides where a stop is
  frame(pts, 18.5);   // close enough to see the kerb
}
/** Every point in view, as close as maxZoom at most: never so close that one of them is off the map. */
function frame(pts, maxZoom) {
  const b = bboxOf(pts, false), w = map.getContainer().clientWidth, pad = Math.min(110, Math.floor(w / 5));
  const cam = map.cameraForBounds([[b.left, b.bottom], [b.right, b.top]], {padding: pad});
  if (cam) map.easeTo({center: cam.center, zoom: Math.min(cam.zoom, maxZoom), duration: 500});
  else fit(pts, 40);
}
const looked = sid => S.looked.has(sid);
/** Where a stop goes when it's moved: OSM's node shifted by the agency's move, when the agency moved it and a mapper
 *  had placed the node by hand (its offset from the agency's point kept; tool/positions.py); else the agency's
 *  point, or the kerb beside it when that's in the road, as for a new stop (newStopSpot). -> {at: [lon, lat], kerb} */
const moveSpot = s => s.match && (s.match.move_how === 'shift' || s.match.move_how === 'restore') && s.match.move_to ? {at: s.match.move_to, restore: s.match.move_how === 'restore'} :
  s.match && s.match.inroad ? {at: s.match.inroad.at, kerb: true, inroad: true} : newStopSpot(s, S.pattern && patternById(S.pattern));
const moveTo = s => moveSpot(s).at;
const moveLL = s => { const [lon, lat] = moveTo(s); return {lat, lon}; };
/** A stop moved back to where it was before someone moved it away (tool/positions.py moved_away): the op says whose
 *  edit it undoes, so the Changes tab says so and offers a record for their changeset after the upload. */
function markUndo(key, s) {
  const a = s.match && s.match.move_how === 'restore' && s.match.moved_away, op = key && Edits.ops[key];
  if (!a || !op) return;
  op.undoes = {kind: 'stop', user: a.user, changeset: a.changeset, date: a.date, node: op.id, m: a.m, name: s.name};
  Edits.save();
}
/** Where a new stop goes: the agency's point, unless that's in the road (often the centre line, or the middle of a
 *  junction): then at the kerb beside it, on the side buses pull in at (the build finds which, D.positions.kerb).
 *  A point already beside the road stays (a stop on the left of a one-way street is one). p: the itinerary it's
 *  added for, else any routed one calling there. -> {at: [lon, lat], kerb: true if moved there} */
function newStopSpot(s, p) {
  return kerbFor([s.lon, s.lat], [p, ...D.patterns.filter(x => x.stops.includes(s.id))], -0.5, false, s.id);
}
/** Where each of an itinerary's stops is along its routed path, in order: the segment index for each, found going
 *  forward from the one before, so a loop that drives a street both ways puts each stop on its own pass of it (route
 *  15 on 600 South, Smithfield: east past one stop, west past another much later). Kept per routed path. */
function stopSegments(q, g) {
  if (q._segOf === g) return q._seg;
  const out = [];
  let from = 0;
  for (const sid of q.stops) {
    const t = D.stops[sid], kx = 111320 * Math.cos(t.lat * Math.PI / 180), ky = 110540;
    let best = null;
    for (let i = from; i < g.length - 1; i++) {
      const a = g[i], b = g[i + 1], vx = (b[0] - a[0]) * kx, vy = (b[1] - a[1]) * ky, wx = (t.lon - a[0]) * kx, wy = (t.lat - a[1]) * ky, L2 = vx * vx + vy * vy;
      const u = L2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2)) : 0, d = Math.hypot(wx - u * vx, wy - u * vy);
      if (!best || d < best.d - 0.01) best = {i, d};
      else if (best.d < 40 && d > best.d + 150) break;   // past it: the nearest pass, not a later one of the same street
    }
    out.push(best ? best.i : from);
    if (best) from = best.i;
  }
  q._segOf = g; q._seg = out;
  return out;
}
/** The way the bus goes at a point of its path (segment i, fraction u): from 15 m before it to 15 m after, along the
 *  path, so a short piece at a junction doesn't decide it. -> [dx, dy] in metres. */
function heading(g, i, u, kx, ky, reach = 15) {
  const at = (j, f) => [g[j][0] + (g[j + 1][0] - g[j][0]) * f, g[j][1] + (g[j + 1][1] - g[j][1]) * f];
  const len = j => Math.hypot((g[j + 1][0] - g[j][0]) * kx, (g[j + 1][1] - g[j][1]) * ky);
  let j = i, left = reach, back = at(i, u), f = u;   // back: walk 15 m against the path
  for (let rem = len(j) * f; ; ) { if (rem >= left || j === 0) { const L = len(j) || 1; back = at(j, Math.max(0, (rem - Math.min(left, rem)) / L)); break; } left -= rem; j--; rem = len(j); }
  let k = i, right = reach, fwd = at(i, u);
  for (let rem = len(k) * (1 - f); ; ) { if (rem >= right || k === g.length - 2) { const L = len(k) || 1; fwd = at(k, Math.min(1, 1 - (rem - Math.min(right, rem)) / L)); break; } right -= rem; k++; rem = len(k); }
  return [(fwd[0] - back[0]) * kx, (fwd[1] - back[1]) * ky];
}
/** A point beside the bus's road or in it: {at: [lon, lat], kerb: true if in it (at: the kerb beside it, on the side
 *  buses pull in at), d: metres from the middle of the road, half: centre to kerb (m)}. pats: itineraries to measure
 *  against, the first routed one. margin: how far inside the kerb counts as in the road (0.5 m past it, for a new
 *  stop's rough point; well inside it for a node someone placed). */
function kerbFor(pt, pats, margin = -0.5, ownSide = false, sid = null) {
  const q = pats.find(x => x && x.routed && x.graph);
  if (!q) return {at: pt};
  const rt = routedOf(q), geom = rt.geometry || [];
  const kx = 111320 * Math.cos(pt[1] * Math.PI / 180), ky = 110540;
  const near = (line, f) => {   // each segment of a line, with how far the point is from it, in metres
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1], vx = (b[0] - a[0]) * kx, vy = (b[1] - a[1]) * ky, wx = (pt[0] - a[0]) * kx, wy = (pt[1] - a[1]) * ky, L2 = vx * vx + vy * vy;
      if (!L2) continue;
      const u = Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2));
      f({d: Math.hypot(wx - u * vx, wy - u * vy), a, vx, vy, u, L: Math.sqrt(L2), left: vx * wy - vy * wx > 0});
    }
  };
  // a stop of this itinerary: looked for only on its own stretch of the path, between the stops either side of it
  let lo = 0, hi = geom.length - 2;
  const k = sid ? q.stops.indexOf(sid) : -1;
  if (k >= 0) { const seg = stopSegments(q, geom); lo = k > 0 ? seg[k - 1] : 0; hi = k + 1 < seg.length ? seg[k + 1] : geom.length - 2; }
  let best = null, bi = -1;
  near(geom.slice(lo, hi + 2), x => { if (!best || x.d < best.d) best = x; });
  if (!best) return {at: pt};
  bi = lo + geom.slice(lo, hi + 2).indexOf(best.a);
  // the way the bus goes there, over 30 m of path (not one short piece at a junction)
  const [hx, hy] = heading(geom, bi, best.u, kx, ky), hl = Math.hypot(hx, hy) || 1;
  const L = best.L, dir = {vx: hx / hl * L, vy: hy / hl * L};
  // how wide the road is: its width, its lanes, or what its kind usually is (centre to kerb, m)
  let road = null;
  for (const wid of rt.ways || []) {
    const w = q.graph.ways.get(wid);
    if (w) near(w.nodes.map(n => q.graph.coord.get(n)).filter(Boolean), x => { if (!road || x.d < road.d) road = {d: x.d, tags: w.tags || {}}; });
  }
  const t = (road && road.tags) || {}, hw = String(t.highway || '').replace(/_link$/, '');
  const half = parseFloat(t.width) > 0 ? parseFloat(t.width) / 2 : parseInt(t.lanes) > 0 ? parseInt(t.lanes) * 3.25 / 2 :
    ({motorway: 7.5, trunk: 7, primary: 6, secondary: 5.5, tertiary: 4.5, unclassified: 3.5, residential: 4, living_street: 3, service: 2.5, busway: 3.5}[hw] || 4);
  const fx = (pt[0] - best.a[0]) * kx - best.u * best.vx, fy = (pt[1] - best.a[1]) * ky - best.u * best.vy;   // from the path to the point
  const isLeft = dir.vx * fy - dir.vy * fx > 0;
  if (best.d > half + margin) return {at: pt, d: best.d, half, left: isLeft};   // beside the road already
  // the kerb, a step onto the pavement: on the side buses pull in at; for a node someone placed (ownSide), the kerb
  // on the side it's on (a stop on the left of a one-way street isn't taken across), unless it's on the middle line
  const side = ownSide && best.d > 1 ? (isLeft ? 'left' : 'right') : ((D.positions && D.positions.kerb) || 'right');
  const sign = side === 'right' ? 1 : -1, off = half + 1.5;
  const nx = sign * dir.vy / L, ny = -sign * dir.vx / L;
  return {at: [best.a[0] + (best.u * best.vx + nx * off) / kx, best.a[1] + (best.u * best.vy + ny * off) / ky], kerb: true, d: best.d, half, left: side === 'left'};
}
/** OSM's stops in the road (a node placed on the centre line, at the agency's point, say), on a route just routed:
 *  each a question, to the nearer kerb (on the middle line: the side buses pull in at). A node that's a point of the road itself
 *  isn't moved (it would bend the road), nor one already asked about for another reason (moved, too far off). */
function markInRoad(p) {
  if (!p.graph) return;
  const vertices = p.graph._vertices || (p.graph._vertices = new Set([...p.graph.ways.values()].flatMap(w => w.nodes)));
  for (const sid of new Set(p.stops)) {
    const s = D.stops[sid], o = matchedOsm(s), m = s.match;
    if (!o || o.id[0] !== 'n' || !m || m.inroad !== undefined || vertices.has(osmNumId(o))) continue;
    const pos = (m.decide || {}).position;
    if (pos && pos.pick !== 'keep') { m.inroad = null; continue; }
    const k = kerbFor(osmPos(o), [p], -1, true, sid);   // well inside the kerb: a node someone placed, not a rough point
    m.inroad = k.kerb ? {at: k.at, d: Math.round(k.d)} : null;
    if (k.kerb) (m.decide = m.decide || {}).position = {pick: 'ask', inroad: true,
      why: `OSM's stop is in the road, ${Math.round(k.d)} m from its middle: to the kerb beside it?`};
  }
}
/** The OSM stop that goes when this one moves to the agency's spot (two stops the agency made one), or null. */
const mergedWith = s => (s && s.match && s.match.merged_with && D.osm_stops[s.match.merged_with.id]) || null;
/** The stop being looked at, drawn to stand out: OSM's stop now, the agency's spot, and the move between. */
function lookFeatures() {
  const s = S.lookStop && D.stops[S.lookStop];
  if (!s) return [];
  const c = (s.match && s.match.osm) || [], o = matchedOsm(s) || (c[0] && D.osm_stops[c[0].id]);
  const shift = s.match && s.match.move_how === 'shift';
  // where it goes, moved or new: at the kerb, when the agency's point is in the road
  const spot = moveSpot(s), to = spot.at;
  const out = [point(to, {kind: 'to', label: shift ? "goes here: OSM's spot, moved as the agency moved it" : spot.restore ? 'goes back: where it was before it was moved away' : spot.inroad ? 'goes here: the kerb beside it' : spot.kerb ? `goes here: at the kerb by the agency's point` : `agency: ${s.name}`})];
  if (shift || spot.restore || (spot.kerb && !spot.inroad)) out.push(point([s.lon, s.lat], {kind: 'other', label: `agency's point: ${s.name}`}));
  if (o) {
    const now = osmPos(o), dm = Math.round(m(now, to));
    out.push(point(now, {kind: 'now', label: `now: ${o.tags.name || o.id} (OSM)`}));
    // a move from one side of the road to the other: said on the map, not left to be noticed
    const pats = [S.pattern && patternById(S.pattern), ...D.patterns.filter(x => x.stops.includes(s.id))];
    const a = kerbFor(now, pats, -1e9, true, s.id), b = kerbFor(to, pats, -1e9, true, s.id);
    const across = a.d > 2 && b.d > 2 && a.left != null && b.left != null && a.left !== b.left;
    if (dm >= 3) out.push(line([now, to], {label: across ? `${dm} m, across the road` : `${dm} m`}));
  }
  for (const x of spot.restore ? [] : c.slice(1)) { const q = D.osm_stops[x.id]; if (q && q !== o) out.push(point([q.lon, q.lat], {kind: 'other', label: `also: ${q.tags.name || q.id} (OSM)`})); }
  const g = mergedWith(s);
  if (g && !c.some(x => x.id === g.id)) out.push(point([g.lon, g.lat], {kind: 'now', label: `goes: ${g.tags.name || g.id} (OSM)`}));
  return out;
}
/** 'Show on map' (what enables the choice), and once shown, a small link to imagery to judge by. */
function lookButtons(s, o) {
  const at = o ? osmPos(o) : [s.lon, s.lat];
  return el('span', {}, el('button', {class: 'b tiny' + (looked(s.id) ? '' : ' primary'), onclick: () => lookAt(s.id)}, 'Show on map'),
    looked(s.id) ? el('a', {href: '#', class: 'muted small', style: 'margin-left:8px', title: 'Aerial imagery in RapiD: where the shelter or sign is',
      onclick: e => { e.preventDefault(); openIn('rapid', {lon: (at[0] + s.lon) / 2, lat: (at[1] + s.lat) / 2, zoom: 19, select: o ? [o.id] : []}); }}, 'imagery') : null);
}

// ---------- undo / redo: every change to the basket, stop tags to road edits ----------
function undoRedo(which) {
  const what = which === 'undo' ? Edits.undo() : Edits.redo();
  if (!what) return toast(which === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  toast(`${which === 'undo' ? 'Undone' : 'Redone'}: ${what}`);
  if (Roads.sel) Roads.deselect();   // what was selected may be gone (a new node) or somewhere else now
  render(); draw(); Roads.status();
  liveRoute();
}
function undoBar() {
  const b = $('#undobar'); if (!b) return;
  b.innerHTML = '';
  const last = Edits.history[Edits.history.length - 1], next = Edits.future[Edits.future.length - 1];
  b.append(el('button', {class: 'b tiny', disabled: last ? null : '', title: last ? `Undo${last.label ? ': ' + last.label : ''} (⌘Z / Ctrl+Z)` : 'Nothing to undo', onclick: () => undoRedo('undo')}, '↶'),
           el('button', {class: 'b tiny', disabled: next ? null : '', title: next ? `Redo${next.label ? ': ' + next.label : ''} (⇧⌘Z / Ctrl+Y)` : 'Nothing to redo', onclick: () => undoRedo('redo')}, '↷'));
}
document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  // typing in a field keeps the field's own undo
  const t = e.target;
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
  if (!D) return;
  e.preventDefault();
  undoRedo(k === 'y' || e.shiftKey ? 'redo' : 'undo');
});

// ---------- links: the address says what is open, so a place can be shared or bookmarked ----------
// #pattern=5741:0:29240:19&div=0 · #stop=9837984 · #tab=changes
function linkTo(o) { return '#' + new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString().replace(/%3A/g, ':'); }
function copyLink(o) {
  const url = location.origin + location.pathname + linkTo(o);
  history.replaceState(null, '', linkTo(o));
  navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast(url, 8000));
}
let hashRead = false;   // until the address has been read on load, it is not ours to overwrite
function syncHash() {
  if (!hashRead) return;
  // the merge card's answers survive a reload of this tab (not shared, not for later: sessionStorage)
  try { if (S.merge) sessionStorage.setItem('flagstop.merge', JSON.stringify({merge: S.merge, looked: [...S.looked]})); } catch (e) { /* storage off */ }
  try { if (S.extraGone) sessionStorage.setItem('flagstop.extra', JSON.stringify({gone: S.extraGone, looked: [...S.looked].filter(k => k.startsWith('osm:'))})); } catch (e) { /* storage off */ }
  try { if (S.station) sessionStorage.setItem('flagstop.station', JSON.stringify({id: S.station.id, answers: S.station.answers, looked: [...S.looked]})); } catch (e) { /* storage off */ }
  const h = S.tab === 'stops' && S.station ? linkTo({station: S.station.id}) : S.tab === 'stops' && S.stop ? linkTo({stop: S.stop}) : S.tab === 'routes' && S.merge && S.pattern ? linkTo({merge: S.pattern}) : S.tab === 'routes' && S.review ? linkTo({review: S.review}) : S.tab === 'routes' && S.pattern ? linkTo({pattern: S.pattern, div: S.div}) : S.tab !== 'routes' ? linkTo({tab: S.tab}) : '';
  if (h !== location.hash && !(h === '' && !location.hash)) history.replaceState(null, '', h || location.pathname);
}
function applyHash() {
  hashRead = true;
  const q = new URLSearchParams(location.hash.slice(1).replace(/\+/g, '%2B'));   // a loop's id has a '+': not a space
  if (q.get('merge') && patternById(q.get('merge'))) {
    const p = patternById(q.get('merge'));
    let saved = null;   // read before opening: opening saves a fresh card over it
    try { saved = JSON.parse(sessionStorage.getItem('flagstop.merge') || 'null'); } catch (e) { /* storage off */ }
    selectPattern(p.id);
    Merge.open(p).then(() => { if (S.merge && saved && saved.merge && saved.merge.pid === p.id) { S.merge = saved.merge; for (const k of saved.looked || []) S.looked.add(k); render(); draw(); } });
  } else if (q.get('station') && Station.place(q.get('station'))) {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('flagstop.station') || 'null'); } catch (e) { /* storage off */ }
    Station.open(q.get('station'));
    if (saved && saved.id === q.get('station')) { S.station.answers = saved.answers; for (const k of saved.looked || []) S.looked.add(k); render(); draw(); }
  } else if (q.get('review') && patternById(q.get('review'))) { selectPattern(q.get('review')); Review.open(q.get('review')); }
  else if (q.get('pattern') && patternById(q.get('pattern'))) {
    selectPattern(q.get('pattern'));
    const pp = patternById(q.get('pattern'));
    if (q.get('div') != null) ensureRouted(pp).then(() => { const dv = routedOf(pp).divergences[+q.get('div')]; if (dv && S.pattern === pp.id) { S.div = +q.get('div'); render(); draw(); showDivergence(dv); } });
  } else if (q.get('stop') && D.stops[q.get('stop')]) showStop(q.get('stop'));
  else if (['stops', 'extra', 'changes', 'about'].includes(q.get('tab'))) {
    if (q.get('tab') === 'extra') try { const x = JSON.parse(sessionStorage.getItem('flagstop.extra') || 'null'); if (x) { S.extraGone = x.gone; for (const k of x.looked) S.looked.add(k); } } catch (e) { /* storage off */ }
    S.tab = q.get('tab'); render(); draw();
  }
}
function showDivergence(dv) {
  document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove());
  fit(dv.shape && dv.shape.length ? dv.shape : [[dv.lon, dv.lat]], 120);
  map.once('moveend', () => popupDiv(dv, [dv.lon, dv.lat]));   // open it where it lands, not mid-flight
}

function selectPattern(id) {
  S.pattern = id; S.stop = null; S.routed = null; S.routedBy = null; S.routedWith = null; S.viaMode = false; S.tab = 'routes'; S.div = null; S.review = null; S.fix = null; S.merge = null; S.fixit = null; S.station = null; S.lookStop = null;
  liveRoute();   // with road edits waiting in Changes, show the route as it would run
  render(); draw();
  const p = patternById(id);
  fit(p.shape.length ? p.shape : p.stops.map(s => [D.stops[s].lon, D.stops[s].lat]));
  if (!p.routed) ensureRouted(p).then(() => { if (S.pattern === id) { render(); draw(); } });
  if (!p.live || Date.now() - p.live.at > 60000) liveCheck(p);   // anything changed on OSM since flagstop's copy?
}

function renderPattern(P, p) {
  const r = routeOf(p), rt = routedOf(p);
  P.append(el('button', {class: 'back', onclick: () => { S.pattern = null; S.div = null; S.routed = null; S.routedBy = null; render(); draw(); }}, '← all itineraries'));
  if (p.live && p.live.changed.length) {
    const c = p.live.changed, cs = [...new Set(c.map(x => x.changeset))];
    P.append(el('div', {class: 'note warn'}, el('b', {}, `Changed on OSM since flagstop's copy: ${c.length}`),
      ...c.slice(0, 6).map(x => el('div', {class: 'small'}, `${x.name}: ${x.gone ? 'deleted' : `v${x.from} → v${x.to}`} by ${x.user}, ${x.date} (`,
        el('a', {href: `https://www.openstreetmap.org/changeset/${x.changeset}`, target: '_blank'}, x.changeset), ')')),
      c.length > 6 ? el('div', {class: 'small muted'}, `and ${c.length - 6} more`) : null,
      SERVER ? el('button', {class: 'b primary tiny', style: 'margin-top:4px', onclick: () => bringIn(cs)}, 'Bring them in') : el('div', {class: 'small muted'}, 'This copy is rebuilt from OSM daily; until then, check these on OSM before deciding.')));
  }
  if (!p.routed) P.append(el('div', {class: 'note'}, p.routing || !p.routeError ? "Loading this route's roads from OSM…" : `Couldn't load this route's roads: ${p.routeError}. `,
    !p.routing && p.routeError ? el('button', {class: 'b tiny', onclick: () => { p.routeError = null; ensureRouted(p).then(() => { render(); draw(); }); render(); }}, 'Try again') : null));
  const d = el('div', {class: 'detail'});
  d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, p.headsign || p.direction_name || r.long), pendingChip(p), el('span', {class: 'muted small'}, `shape ${p.shape_id}`)));
  d.append(el('div', {class: 'muted small'}, `${r.long}${r.desc ? ' — ' + r.desc : ''} · ${p.loop && p.loop.length ? 'loop' : 'direction ' + p.direction} · ${p.stops.length} stops · ${p.trips} trips${p.variants ? ` · ${p.variants} short or end-of-day variants folded in` : ''}`));
  {
    const live = p.relations.filter(a => (Edits.get('r' + a.id) || {}).kind !== 'delete');
    if (live.length > 1) d.append(el('div', {class: 'note'}, el('b', {}, `${live.length} OSM relations for this one route. `),
      'Probably one per timetable; GTFS says it\'s the same route every day. ', el('button', {class: 'b primary tiny', onclick: () => Merge.open(p)}, 'See the proposed merge')));
  }
  for (const pl of [...new Set(p.stops.map(sid => Station.ofStop(D.stops[sid])).filter(Boolean))]) {
    const is = Station.issues(pl);
    d.append(el('div', {class: 'note'}, `Stops at ${pl.stations[0].tags.name || 'a station'}, a station with ${pl.bays.length} bays${is.length ? `: ${is.join(', ')}` : ''}. `,
      el('button', {class: 'b tiny', onclick: () => Station.open(pl.id)}, "The station: how it's mapped")));
  }
  if (p.loop && p.loop.length) d.append(el('div', {class: 'note'}, `One loop, run by one bus: the feed splits each trip in two at ${D.stops[p.split_at] ? D.stops[p.split_at].name : 'a stop'}, but the bus carries straight on and passengers ride through. In OSM it's one round-trip relation.`));
  if (p.detour) {
    // on a detour: mapped as the agency runs it (a detour of weeks), or the regular route kept; restorable from history
    const names = ids => ids.map(x => (D.stops[x] || {}).name || ((D.osm_stops[x] || {}).tags || {}).name || x);
    const keep = keepsRegular(p), dt = p.detour;
    const what = `The agency runs it through ${names(dt.temporary).join(', ')}` + (dt.skipped.length ? `, and skips ${dt.skipped.length} stop${dt.skipped.length > 1 ? 's' : ''} OSM's relation has (${names(dt.skipped).join(', ')})` : '') + '. ';
    const now = dt.followed ? "OSM's relation follows the detour now. " : '';
    const plan = keep ? "The regular route is kept: the relation's stops and roads stay as they are; its codes, names and timetable are still brought up to date."
      : "Mapped as the agency runs it while it lasts (worth it for a detour of weeks), with a note on the relation saying it's a diversion. The stops it goes round stay in OSM.";
    d.append(el('div', {class: 'note'}, el('b', {}, 'On a detour. '), what, now, plan,
      el('div', {class: 'btns'},
        dt.skipped.length || keep ? el('button', {class: 'b tiny', onclick: () => { Edits.answer('route:' + p.id, 'detour', keep ? null : 'keep'); render(); draw(); }},
          keep ? 'Map the detour instead' : 'Keep the regular route instead (a short detour)') : null,
        dt.followed ? el('button', {class: 'b tiny', onclick: () => restoreRegular(p)}, 'Restore the regular route (from the relation\'s history)') : null)));
  }
  if (p.temporary) d.append(el('div', {class: 'note warn'}, 'Only run by a short-dated service: a detour or a special. Usually not mapped; see ? for the convention.'));
  const sc = rt.score || {};
  d.append(el('div', {class: 'kv'},
    el('span', {class: 'k'}, 'drivable'), el('span', {}, `${pct(sc.shape_covered)} of the agency's line can be driven on OSM as mapped (${pct(sc.path_on_shape)} of the drivable path stays on the line)`),
    el('span', {class: 'k'}, 'path'), el('span', {}, `${rt.ways.length} ways · ${rt.legs.filter(l => l.ok).length}/${rt.legs.length} legs connect · ${p.chain_ok ? 'continuous' : 'BROKEN — a router would reject this'}`),
    (!S.routed && (p.chain_breaks || []).length) ? el('span', {class: 'k'}, 'chain') : null,
    (!S.routed && (p.chain_breaks || []).length) ? el('span', {}, `${p.chain_breaks.filter(b => b.kind === 'split').length} ways to split (Roads, on the map) before the relation validates `, ...chainLinks(p.chain_breaks.filter(b => b.kind !== 'split')), el('details', {style: 'display:inline'}, el('summary', {style: 'display:inline;cursor:pointer'}, 'where'), ' ', ...chainLinks(p.chain_breaks.filter(b => b.kind === 'split')))) : null));

  if (S.routedBy === 'changes') d.append(el('div', {class: 'note'}, 'Shown with your road edits waiting in Changes: the route as it will run once they\'re uploaded.'));
  if (S.routedBy === 'vias') d.append(el('div', {class: 'note'}, `Shown as you re-routed it, ${describeRouting(Edits.routingOf(p.id))}${hasRoadEdits() ? ', with your road edits in Changes' : ''}. The relation you propose follows this. Kept with your decisions; undo takes a step back.`));
  const cen = centerOf(p.shape.length ? p.shape : rt.geometry);
  const btns = el('div', {class: 'btns'});
  btns.append(el('button', {class: 'b primary', title: 'Everything flagstop can do for this route without you, done; what it can\'t decide, listed', onclick: () => FixIt.open(p.id)}, 'Fix this route'));
  btns.append(el('button', {class: 'b', onclick: () => proposeRelation(p)}, p.relations.length ? 'Fix relation → changes' : 'Create relation → changes'));
  {
    const sts = Review.stops(p).filter(st => st.o && !st.inChanges && (st.status === 'matched' || st.status === 'moved'));
    const asks = sts.reduce((n, st) => n + Object.values(st.decide).filter(d => d.pick === 'ask').length, 0);
    btns.append(el('button', {class: 'b', title: "flagstop's suggestion for every difference between the agency and OSM on this route's stops, for you to check", onclick: () => Review.open(p.id)},
      `Check stops${asks ? ` (${asks} question${asks > 1 ? 's' : ''})` : ''}`));
  }
  btns.append(el('button', {class: 'b', onclick: () => openIn('rapid', {...cen, zoom: 14, select: p.relations.map(a => 'r' + a.id), pattern: p, comment: `Bus route ${r.short} ${p.headsign || ''}`.trim()})}, 'Open in RapiD with line'));
  btns.append(el('button', {class: 'b', onclick: () => openIn('id', {...cen, zoom: 14, select: p.relations.map(a => 'r' + a.id), pattern: p})}, 'iD'));
  btns.append(el('button', {class: 'b' + (S.viaMode ? ' on' : ''), onclick: () => { S.viaMode = !S.viaMode; map.getCanvas().style.cursor = S.viaMode ? 'crosshair' : ''; render(); }}, S.viaMode ? 'Click the map: a point to go through, or a road the bus uses or doesn\'t…' : 'Re-route: via a point, a road'));
  { const rc = Edits.routingOf(p.id), n = rc.vias.length + rc.avoid.length + rc.require.length;
    if (n) btns.append(el('button', {class: 'b', onclick: () => { Edits.label('clear re-routing'); setRouting(p.id, null); retrace(); }}, `Clear re-routing (${n})`)); }
  d.append(btns);

  if (rt.divergences.length) {
    d.append(el('h2', {style: 'margin-left:0'}, `Where a bus can't follow the agency's line on the map (${rt.divergences.length})`));
    const ul = el('ul', {class: 'plain'});
    rt.divergences.forEach((dv, i) => {
      ul.append(el('li', {class: 'item click' + (S.div === i && !S.routed ? ' on' : ''), onclick: () => { if (!S.routed) { S.div = i; syncHash(); } showDivergence(dv); }},
        el('div', {}, el('b', {}, divTitle(dv)), ` · ${dv.length} m`, dv.max ? el('span', {class: 'muted'}, ` · up to ${dv.max} m off`) : null,
          dv.leg != null ? el('span', {class: 'muted'}, ` · after stop ${dv.leg + 1}`) : null,
          S.routed ? null : el('a', {href: linkTo({pattern: p.id, div: i}), class: 'muted', style: 'float:right', title: 'link to this place', onclick: e => { e.stopPropagation(); e.preventDefault(); copyLink({pattern: p.id, div: i}); }}, 'link')),
        el('div', {class: 'why'}, dv.why)));
    });
    d.append(ul);
  }

  d.append(el('h2', {style: 'margin-left:0'}, p.relations.length ? `OSM relation${p.relations.length > 1 ? 's' : ''}` : 'OSM relation'));
  if (!p.relations.length) d.append(el('div', {class: 'small'}, 'Nothing in OSM covers this itinerary. "Create relation" builds one from the matched platforms in order and the routed ways.'));
  for (const a of p.relations) d.append(renderAudit(a, p));
  d.append(el('details', {class: 'small'}, el('summary', {}, 'Proposed relation tags'), el('div', {class: 'kv'}, ...Object.entries(p.proposed_tags).flatMap(([k, v]) => [el('span', {class: 'k'}, k), el('span', {}, v)]))));
  if (r.masters.length === 0) d.append(el('div', {class: 'small muted', style: 'margin-top:6px'}, `No route_master for route ${r.short}. `, el('a', {href: '#', onclick: e => { e.preventDefault(); proposeMaster(r); }}, 'Create one → changes'), ' once its directions have relations.'));

  d.append(el('h2', {style: 'margin-left:0'}, 'Stops in order'));
  const ul = el('ul', {class: 'plain stoplist'});
  p.stops.forEach((id, i) => {
    const s = D.stops[id], st = stopStatus(s), o = matchedOsm(s);
    const leg = rt.legs[i - 1];
    ul.append(el('li', {class: 'item click', onclick: () => showStop(id), onmouseenter: () => { const lg = rt.legs[i]; set('leg', lg && lg.ok ? [line(legGeom(rt, i))] : []); }, onmouseleave: () => set('leg', [])},
      el('span', {class: 'n'}, i + 1), el('span', {class: 'dotc ' + st}),
      el('span', {class: 'grow'}, s.name, s.desc ? el('span', {class: 'd'}, ' · ' + s.desc) : null, o && o.tags.name && o.tags.name !== s.name ? el('span', {class: 'd', style: 'color:var(--rel)'}, ` · OSM: ${o.tags.name}`) : null),
      leg && !leg.ok ? el('span', {class: 'chip bad', title: leg.why}, 'gap before') : null));
  });
  d.append(ul);
  P.append(d);
}
const BREAK = {gap: 'gap', spur: 'in and out of a dead end', split: 'needs a split'};
const breakLabel = b => b.turnaround ? 'turnaround' : BREAK[b.kind] || '';
function chainLinks(breaks) {
  return [...breaks.slice(0, 6).flatMap(b => [el('a', {href: '#', title: b.split ? `split way ${b.split} at node ${b.node}` : `w${b.a} → w${b.b}`, onclick: e => { e.preventDefault(); map.flyTo({center: [b.lon, b.lat], zoom: 17}); }}, `#${b.i} ${breakLabel(b)}`.trim()), ' ']), breaks.length > 6 ? '…' : ''];
}
function legGeom(rt, i) {
  const p = patternById(S.pattern), a = D.stops[p.stops[i]], b = D.stops[p.stops[i + 1]];
  const g = rt.geometry; if (!g.length || !b) return [];
  const near = q => { let bi = 0, bd = 1e9; g.forEach((c, k) => { const d = m(c, [q.lon, q.lat]); if (d < bd) { bd = d; bi = k; } }); return bi; };
  let ia = near(a), ib = near(b); if (ib < ia) [ia, ib] = [ib, ia];
  return g.slice(ia, ib + 1);
}

function renderAudit(a, p) {
  const box = el('div', {class: 'small box'});
  const op = Edits.get('r' + a.id);
  box.append(el('div', {}, el('b', {}, a.name || `relation ${a.id}`), ' ', el('a', {href: 'https://www.openstreetmap.org/relation/' + a.id, target: '_blank'}, `r${a.id}`),
    el('span', {class: 'muted'}, ` · v${a.version} by ${a.user} · ${(a.timestamp || '').slice(0, 10)}`),
    a.duplicate ? el('span', {class: 'chip warn', style: 'margin-left:6px'}, 'duplicate') : null, a.both_directions ? el('span', {class: 'chip warn', style: 'margin-left:6px'}, 'both directions') : null,
    op ? el('span', {class: 'chip edit', style: 'margin-left:6px'}, op.uploaded ? (op.kind === 'delete' ? 'deleted' : 'uploaded') : op.kind === 'delete' ? 'to delete' : 'edited') : null));
  box.append(el('div', {class: 'muted'}, `covers ${pct(a.cover.shape_covered)} of the line; ${pct(a.cover.ways_on_shape)} of its ways are on it · ${a.ways.in_relation} ways · ${a.stops.in_relation} stop members`));
  const issues = [];
  if (a.both_directions) issues.push(el('li', {}, 'One relation holds both directions. PTv2 wants one per direction: this one is kept for one, and a new one created for the other (see "Fix relation").'));
  const kept = keptRelation(p);
  if (a.duplicate && kept && kept.id === a.id) issues.push(el('li', {}, 'Another relation covers this same itinerary — OSM has one relation per itinerary, not per service day. This one is the oldest: it is kept, and "Fix relation" rewrites it.'));
  else if (a.duplicate && (!op || op.kind !== 'delete')) issues.push(el('li', {}, `Another relation covers this same itinerary — OSM has one relation per itinerary, not per service day. r${kept ? kept.id : '?'} is kept; `, el('a', {href: '#', onclick: e => { e.preventDefault(); markDuplicate(a, p); }}, 'mark this one for deletion'), '.',
    kept && kept.id !== a.id ? Carry.box({...a, id: 'r' + a.id}, asWillBe({...kept, id: 'r' + kept.id}), CARRY.relation, {title: `If it's deleted, r${a.id}'s tags`}) : null));
  if (a.ways.chain_breaks.length) issues.push(el('li', {}, `the way chain breaks in ${a.ways.chain_breaks.length} place${a.ways.chain_breaks.length > 1 ? 's' : ''} (routers and validators reject it): `, ...chainLinks(a.ways.chain_breaks)));
  if (a.stops.missing.length) issues.push(el('li', {}, `${a.stops.missing.length} matched platform${a.stops.missing.length > 1 ? 's are' : ' is'} not ${a.stops.missing.length > 1 ? 'members' : 'a member'}: `, ...a.stops.missing.slice(0, 8).flatMap(x => [el('a', {href: '#', onclick: e => { e.preventDefault(); showStop(x.stop); }}, `#${x.i + 1}`), ' ']), a.stops.missing.length > 8 ? '…' : ''));
  const extra = a.stops.extra.length, other = a.stops.extra_other_direction.length;
  if (extra) issues.push(el('li', {}, `${extra} platform member${extra > 1 ? 's are' : ' is'} not on this itinerary${other ? ` (${other} are the other direction's)` : ''}: `, ...a.stops.extra.slice(0, 6).flatMap(id => [el('a', {href: osmLink(id), target: '_blank'}, id), ' ']), extra > 6 ? '…' : ''));
  if (a.stops.out_of_order) issues.push(el('li', {}, `platform members are out of order in ${a.stops.out_of_order} place${a.stops.out_of_order > 1 ? 's' : ''}`));
  if (a.stops.unmatched.length) issues.push(el('li', {}, `${a.stops.unmatched.length} GTFS stops have no OSM platform yet (see Stops)`));
  if (a.ways.off_shape.length) issues.push(el('li', {}, `${a.ways.off_shape.length} member way${a.ways.off_shape.length > 1 ? 's are' : ' is'} off the line: `, ...a.ways.off_shape.slice(0, 8).flatMap(w => [el('a', {href: '#', title: w.name, onclick: e => { e.preventDefault(); map.flyTo({center: [w.lon, w.lat], zoom: 16}); }}, `w${w.way}`), ' ']), a.ways.off_shape.length > 8 ? '…' : ''));
  // (a ref the agency writes with a qualifier, '16 AM' for OSM's '16', is kept as OSM has it: relationPlan's refKept)
  for (const t of a.tag_issues.filter(t => !(t.key === 'ref' && t.osm && t.gtfs && t.gtfs.startsWith(t.osm + ' ')))) issues.push(el('li', {}, el('code', {}, t.key), ': ', t.osm ? el('span', {}, el('span', {style: 'color:var(--rel)'}, t.osm), ' → ') : 'add ', el('span', {style: 'color:var(--shape)'}, t.gtfs)));
  box.append(issues.length ? el('ul', {style: 'margin:6px 0 0;padding-left:18px'}, ...issues) : el('div', {style: 'color:var(--ok)'}, 'Members and tags agree with the feed.'));
  if (!a.duplicate && !a.both_directions && !p.temporary) box.append(timetableLine(a, p, op));
  return box;
}

/** The route's timetable as tags on its relation (opening_hours, interval): what OSM has, what the agency's
 *  timetable says, and a button to put it in Changes. A relation mapped twice gets it through the merge. */
function timetableLine(a, p, op) {
  const t = Merge.timetable(p, [a]), keys = Object.keys(t.tags);
  if (!keys.length) return null;
  const cur = op && op.kind !== 'delete' ? op.tags : a.tags;
  if (keys.every(k => cur[k] === t.tags[k])) return el('div', {class: 'muted', style: 'margin-top:6px'}, op && keys.some(k => a.tags[k] !== t.tags[k]) ? 'Timetable: in Changes.' : 'Timetable: as the agency has it.');
  const code = tags => el('code', {}, Object.entries(tags).map(([k, v]) => `${k}=${v}`).join('  '));
  const had = Object.fromEntries(keys.filter(k => a.tags[k]).map(k => [k, a.tags[k]]));
  return el('div', {style: 'margin-top:6px'},
    el('div', {}, el('b', {}, 'Timetable'), ` (times at its first stop, ${t.first.name}): `, code(t.tags)),
    Object.keys(had).length ? el('div', {class: 'muted'}, 'OSM has ', code(had), '.') : el('div', {class: 'muted'}, 'OSM has none. In OSM the times go on the route as tags like these, not as a relation per day.'),
    t.uneven ? el('div', {class: 'muted'}, 'The gap between buses drifts through the day here; the interval is the usual one.') : null,
    el('button', {class: 'b tiny', style: 'margin-top:4px', onclick: () => {
      Edits.modify('relation', a.id, relBase(a), {tags: t.tags}, op ? null : p.id);
      toast(`Timetable for r${a.id} in Changes`); render();
    }}, Object.keys(had).length ? "Use the agency's" : 'Add to changes'));
}

/** Build the relation op(s) for a pattern from the routed ways and matched platforms. */
/** Split the roads where the bus turns partway along one (breaks of kind 'split' from the router's chain check),
 *  each with every relation through it repaired (Roads), except `skip`: relations the caller rewrites anyway.
 *  -> how many were split */
async function splitWhereTheBusTurns(p, breaks, skip = new Set(), say = () => {}) {
  let n = 0;
  for (const b of breaks.filter(x => x.kind === 'split' && x.split)) {
    const name = ((p.way_tags || {})[b.split] || {}).name || `w${b.split}`;
    say(`Splitting ${name} where the bus turns…`);
    await Roads.load([b.lon - 0.003, b.lat - 0.002, b.lon + 0.003, b.lat + 0.002]);
    const w = Roads.way(b.split);
    if (w && w.nodes.includes(b.node) && w.nodes[0] !== b.node && w.nodes[w.nodes.length - 1] !== b.node) { await Roads.splitAt(b.split, b.node, skip); n++; }
  }
  return n;
}
/** The routed path's roads, split where the bus turns partway along one, and traced again on the result (with
 *  every road edit in Changes). -> {ways, breaks: how many places still don't join up} */
async function routedWaysSplit(p, skip, say) {
  const rt = routedOf(p), breaks = Router.chainBreaks(rt.ways, p.graph.ways).filter(b => p.graph.coord.has(b.node))
    .map(b => ({...b, lon: p.graph.coord.get(b.node)[0], lat: p.graph.coord.get(b.node)[1]}));
  if (breaks.some(b => b.kind === 'split')) await splitWhereTheBusTurns(p, breaks, skip, say);
  if (!hasRoadEdits() && !breaks.length) return {ways: rt.ways, breaks: 0};
  const tr = await traceWith(p.id, {});
  await Roads.fetchWays(tr.ways.filter(w => w > 0));
  return {ways: tr.ways, breaks: Roads.chainBreaks(tr.ways.map(w => Roads.way(w)))};
}
/** What the proposal for an itinerary's relation would do: which relation it reuses, whether its roads stay, what
 *  the routed path needs, which stops have no node yet. Shared by the proposal and the fix-it card. */
function relationPlan(p) {
  const rt = routedOf(p);
  // Road edits already in Changes reshaped roads this itinerary uses: the relations on them were repaired then, so
  // the mapper's members as read before can't be kept, and the path is traced again on the edited roads.
  const reshaped = new Set(Object.values(Edits.ops).filter(o => o.type === 'way' && String(o.note || '').startsWith('road: ')).map(o => o.id));
  const hit = [...rt.ways, ...p.relations.flatMap(a => a.members.filter(x => x.type === 'way').map(x => x.ref))].filter(w => reshaped.has(w));
  const missing = p.stops.filter((sid, i) => p.stops.indexOf(sid) === i && !stopNodeRef(D.stops[sid])).map(sid => D.stops[sid]);
  // Which existing relation to reuse: the oldest one paired with this pattern that no other pattern's proposal has
  // claimed (a road repair touching it, in Changes or just uploaded, is not a claim: it's still this route's relation).
  const pids = new Set(D.patterns.map(q => q.id));
  const claimed = new Set(Object.values(Edits.all()).filter(o => o.type === 'relation' && o.kind === 'modify' && pids.has(o.note) && o.note !== p.id).map(o => o.id));
  const rels = p.relations.filter(a => !claimed.has(a.id) && !(Edits.get('r' + a.id) || {}).kind?.startsWith('del')).sort((a, b) => a.id - b.id);
  const reuse = rels[0] || null, duplicates = rels.slice(1);
  // The mapper's ways stay when they already run end to end along the whole line, as well as the routed path does:
  // they may follow it where the router can't (a one-way it doesn't trust, a turn it doesn't know). Via points
  // mean the reviewer wants the route; a road edit in Changes means they were read before it.
  const keepWays = !!(reuse && !hit.length && !constrainedRouting(p) && !reuse.both_directions && !reuse.ways.chain_breaks.length && !reuse.ways.off_shape.length &&
    reuse.cover.shape_covered >= ((rt.score || {}).shape_covered || 0));
  const breaks = p.graph ? Router.chainBreaks(rt.ways, p.graph.ways) : [];
  const dropped = reuse && !keepWays ? reuse.ways.off_shape : [];   // the mapper's roads off the agency's line: not kept
  const tags = {...p.proposed_tags};
  let refKept = null;
  if (reuse && reuse.tags.ref && tags.ref && tags.ref !== reuse.tags.ref && tags.ref.startsWith(reuse.tags.ref + ' ')) refKept = reuse.tags.ref;
  return {p, rt, reuse, duplicates, keepWays, hit, missing, splits: breaks.filter(b => b.kind === 'split').length, gaps: breaks.filter(b => b.kind !== 'split').length,
    chainOk: p.chain_ok || !!S.routed, dropped, tags, refKept, masters: routeOf(p).masters};
}
/** The itinerary's relation into Changes: rewritten (reused) or new, PTv2 members in order, the roads split where
 *  the bus turns. opts.quiet: no toasts but failures; opts.extraTags: more tags (a timetable). -> {ok, why, key} */
/** An itinerary on a detour (tool/review.py detour_of: temporary stops, and OSM's relation going round them or
 *  following them). An agency that publishes only long detours (CVTD) has them worth mapping while they last: the
 *  relation follows the feed, with a note saying it's a diversion. The reviewer can keep the regular route instead
 *  (a short one): then the relation's stops and roads are left as they are, only its tags brought up to date. */
const keepsRegular = p => !!(p && p.detour && ((Edits.answers['route:' + p.id] || {}).detour === 'keep'));
const mapsDetour = p => !!(p && p.detour && !keepsRegular(p));
const detoured = p => keepsRegular(p);   // the regular route is OSM's (or restored, in Changes): leave the relation as it is
const DIVERSION = "Diversion: the agency's temporary route (detour); back to the regular route when it's over";
/** The regular route back: the relation's newest version without the detour's temporary stops, from its history
 *  (a request to OSM), its stops and roads as they were, checked to still be there and to join up. Its tags stay
 *  as they are now, but the diversion note. -> true when it's in Changes. */
async function restoreRegular(p) {
  const temp = new Set(p.detour.temporary.map(sid => matchedOsm(D.stops[sid])).filter(Boolean).map(o => osmNumId(o)));
  const rel = p.relations.find(a => a.members.some(m => m.type === 'node' && temp.has(m.ref))) || keptRelation(p);
  if (!rel) return toast('No relation to restore'), false;
  toast('Reading the relation\'s history…');
  let vs;
  try { vs = (await (await fetch(`${OSM_API}/api/0.6/relation/${rel.id}/history.json`)).json()).elements; } catch (e) { toast(`Couldn't read its history: ${e.message}`, 6000); return false; }
  const old = vs.slice(0, -1).reverse().find(v => v.visible !== false && !(v.members || []).some(m => m.type === 'node' && temp.has(m.ref)));
  if (!old) return toast("Its history has no version without the detour's stops", 6000), false;
  const members = old.members.map(m => ({type: m.type, ref: m.ref, role: m.role}));
  // what of it is still there: stops deleted since, or roads, can't come back this way
  const nodes = members.filter(m => m.type === 'node').map(m => m.ref), ways = members.filter(m => m.type === 'way').map(m => m.ref);
  let gone = new Set();
  try {
    if (nodes.length) for (const e of (await (await fetch(`${OSM_API}/api/0.6/nodes.json?nodes=${nodes.join(',')}`)).json()).elements) if (e.visible === false) gone.add('n' + e.id);
    await Roads.fetchWays(ways);
    for (const w of ways) if (!Roads.way(w)) gone.add('w' + w);
  } catch (e) { toast(`Couldn't check its members: ${e.message}`, 6000); return false; }
  if (gone.size) return toast(`Not restored: ${gone.size} of its stops or roads are gone from OSM since (${[...gone].slice(0, 4).join(', ')}). Restore it by hand in RapiD or JOSM.`, 9000), false;
  const breaks = Roads.chainBreaks(ways.map(w => Roads.way(w)));
  if (breaks) return toast(`Not restored: its roads don't join up any more in ${breaks} place${breaks > 1 ? 's' : ''} (split or redrawn since). Restore it by hand in RapiD or JOSM.`, 9000), false;
  const cur = Edits.get('r' + rel.id), tags = {...((cur && cur.tags) || rel.tags)};
  // the detour's: its note, and its shape (the regular route's shape id is the old version's, or none)
  const removeTags = [...(tags.note === DIVERSION ? ['note'] : []), ...(tags['gtfs:shape_id'] && !(old.tags || {})['gtfs:shape_id'] ? ['gtfs:shape_id'] : [])];
  const set = (old.tags || {})['gtfs:shape_id'] ? {'gtfs:shape_id': old.tags['gtfs:shape_id']} : {};
  Edits.hold(`${routeOf(p).short}: the regular route back`);
  try {
    const key = Edits.modify('relation', rel.id, relBase(rel), {members, tags: set, removeTags}, `${routeOf(p).short}: regular route restored (as v${old.version}, ${(old.timestamp || '').slice(0, 10)})`);
    Edits.ops[key].route = routeOf(p).short; Edits.save();
    Edits.answer('route:' + p.id, 'detour', 'keep');   // and kept: the next refresh doesn't map the detour again
  } finally { Edits.release(); }
  toast(`The regular route, as relation v${old.version} had it (${(old.timestamp || '').slice(0, 10)}), in Changes`, 6000);
  render(); draw();
  return true;
}
async function proposeRelation(p, opts = {}) {
  const say = (m, ms) => { if (!opts.quiet) toast(m, ms); };
  if (!p.routed) { toast("This route's roads are still loading: try again in a moment", 5000); return {ok: false, why: 'not routed yet'}; }
  // a relation made for it went up, and the data here doesn't have it yet: made again, it would be there twice
  const made = Object.values(Edits.uploaded).find(o => o.kind === 'create' && o.type === 'relation' && o.note === p.id);
  if (made) { const why = `its new relation went up in changeset ${made.uploaded}, and the data here doesn't have it yet: refresh from OSM first`; say(`Not added: ${why}`, 8000); return {ok: false, why}; }
  const x = relationPlan(p), rt = x.rt;
  const asIs = detoured(p) && x.reuse;   // on a detour: the regular route's stops and roads stay
  if (asIs) x.chainOk = true;
  if (!x.chainOk && !opts.quiet && !confirm('The routed path is broken (a leg did not connect). Add the relation anyway?')) return {ok: false, why: 'the routed path is broken'};
  if (!x.chainOk && opts.quiet) return {ok: false, why: "the routed path is broken (a leg didn't connect): re-route it first"};
  const members = asIs ? ((Edits.get('r' + x.reuse.id) || {}).members || x.reuse.members).map(m => ({...m})) : [];
  for (const sid of asIs ? [] : p.stops) {
    const ref = stopNodeRef(D.stops[sid]), sp = (p.stop_positions || {})[sid];
    // PTv2: the stop position on the road (where the stop has one), then the platform
    if (ref && sp) members.push({type: 'node', ref: sp, role: 'stop'});
    if (ref) members.push(ref.key ? {key: ref.key, role: 'platform'} : {type: 'node', ref: ref.ref, role: 'platform'});
  }
  const tags = {...x.tags, ...(opts.extraTags || {}), ...(p.detour && mapsDetour(p) ? {note: DIVERSION} : {})}, reuse = x.reuse, keepWays = x.keepWays;
  if (asIs) { if (reuse.tags['gtfs:shape_id']) tags['gtfs:shape_id'] = reuse.tags['gtfs:shape_id']; else delete tags['gtfs:shape_id']; }   // the detour's shape isn't the route's
  let out = {ok: true, why: '', key: null};
  Edits.hold(`relation for ${routeOf(p).short} ${p.headsign || ''}`.trim());   // the splits and the relation: one undo
  try {
    if (asIs) { /* its stops and roads, as they are */ }
    else if (keepWays) for (const m of reuse.members) { if (m.type === 'way') members.push({...m}); }
    else {
      // the routed path's roads, split where the bus turns partway along one: a relation whose roads don't join up
      // end to end is broken for every consumer, so that is never put in Changes
      const {ways, breaks} = await routedWaysSplit(p, new Set(reuse ? [reuse.id] : []), m => say(m, 8000));
      if (breaks) {
        toast(`Stopped: the roads still don't join up in ${breaks} place${breaks > 1 ? 's' : ''} after splitting. The splits are in Changes; the relation isn't. Re-route (via a point, a road) and try again.`, 10000);
        return {ok: false, why: `the roads don't join up in ${breaks} place${breaks > 1 ? 's' : ''} after splitting`};
      }
      for (const w of ways) members.push({type: 'way', ref: w, role: ''});
    }
    if (reuse) {
      // The GTFS scheme's structural tags go in; the mapper's free text stays unless it names a service day,
      // which is the very thing being merged away. The mapper's ref stays when the agency's is it plus a qualifier
      // ("16" on the bus; "16 AM" and "16 PM" in the feed): the qualifier is the relation's name's business.
      const merged = {...reuse.tags, ...tags};
      for (const k of ['name', 'from', 'to', 'description', 'colour']) if (reuse.tags[k] && !/\b(weekday|saturday|sunday|weekend|mon|tue|wed|thu|fri)\b/i.test(reuse.tags[k])) merged[k] = reuse.tags[k];
      // a name that names a service day keeps the mapper's wording with the day taken out ("Route 6 - Fairgrounds,
      // Woodruff Elementary - Weekday" -> "Route 6 - Fairgrounds, Woodruff Elementary"), the local style
      if (reuse.tags.name && merged.name !== reuse.tags.name) { const bare = reuse.tags.name.replace(SERVICE_DAY, '').replace(/\s*[-–,]\s*$/, '').trim(); if (bare.length > 3) merged.name = bare; }
      if (reuse.both_directions && reuse.tags.name && !/bound|inbound|outbound/i.test(reuse.tags.name)) merged.name = tags.name;
      if (x.refKept) merged.ref = x.refKept;
      // the detour's over (or kept as the regular route): its diversion note goes
      const unnote = merged.note === DIVERSION && !mapsDetour(p);
      if (unnote) delete merged.note;
      out.key = Edits.modify('relation', reuse.id, relBase(reuse), {tags: merged, members, ...(unnote ? {removeTags: ['note']} : {})}, p.id);
      editMasters(x.masters, null, {type: 'relation', ref: reuse.id});
      say(asIs ? `Relation r${reuse.id}: its tags in changes; its stops and roads as they are (the route is on a detour)` : `Relation r${reuse.id} rewritten in changes: ${members.length} members${keepWays ? ' (its ways kept: they already follow the line)' : ''}${x.refKept ? ` (ref ${x.refKept} kept: the agency's "${tags.ref}" is it with a qualifier)` : ''}`);
    } else {
      out.key = Edits.createRelation(tags, members, p.id);
      editMasters(x.masters, null, {key: out.key});
      say(`New relation in changes: ${members.length} members${x.masters.length ? ', added to its route_master' : ''}`);
    }
    Edits.ops[out.key].suggested = true; Edits.ops[out.key].route = routeOf(p).short;
    if (x.missing.length) say(`${x.missing.length} stops have no OSM node yet — add them (Stops) and propose again`, 6000);
  } catch (e) { toast(e.message, 8000); console.error(e); out = {ok: false, why: e.message}; }
  finally { Edits.release(); }
  if (!opts.quiet) { await liveRoute(); render(); draw(); }
  return out;
}
function proposeMaster(r) {
  // waiting in Changes, or uploaded and not in the data yet: either way it's there, and isn't made twice
  const all = Edits.all(), members = [];
  // a time-of-day line ('16 AM' and '16 PM'): one master for the line, every itinerary of it in it
  const key = 'master:' + (r.line_patterns && r.line_patterns.length > r.patterns.length ? 'line:' + r.line : r.id);
  for (const pid of r.line_patterns || r.patterns) {
    const p = patternById(pid);
    if (p.temporary) continue;
    const key = Object.keys(all).find(k => all[k].type === 'relation' && all[k].note === pid && all[k].kind !== 'delete');
    const op = key && all[key];
    if (op) members.push(op.kind !== 'create' ? {type: 'relation', ref: op.id, role: ''} : Edits.ops[key] ? {key, role: ''} : {type: 'relation', ref: op.newId, role: ''});
    else if (p.relations.length) members.push({type: 'relation', ref: p.relations.sort((a, b) => a.id - b.id)[0].id, role: ''});
  }
  if (!members.length) return toast('No relations to put in it yet');
  const sig = x => { const y = Edits.resolveMember(x) || x; return y.type + y.ref; };
  const mk = Object.keys(all).find(k => all[k].kind === 'create' && all[k].type === 'relation' && all[k].note === key);
  if (mk) {
    // made already (for the other direction): what's missing from it goes in
    const m = all[mk], have = new Set((m.members || []).map(sig)), add = members.filter(x => !have.has(sig(x)));
    if (!add.length) return;
    if (Edits.ops[mk]) { Edits.ops[mk].members = [...m.members, ...add]; Edits.save(); }
    else Edits.modify('relation', m.newId, {version: m.newVersion, tags: m.tags, members: m.members}, {members: [...m.members, ...add]}, key);
    toast('route_master: added to it in changes'); render();
    return;
  }
  Edits.createRelation(r.proposed_master_tags, members, key);
  toast('route_master added to changes'); render();
}

// ---------- stops ----------
function stopFilter(s) {
  const st = stopStatus(s);
  if (S.filter === 'todo' && !(st === 'missing' || st === 'ambiguous' || st === 'moved')) return false;
  if (S.filter === 'decide' && !(st === 'ambiguous' || st === 'moved')) return false;
  if (S.filter === 'matched' && st !== 'matched') return false;
  if (S.filter === 'missing' && st !== 'missing') return false;
  if (S.filter === 'moved' && st !== 'moved') return false;
  if (S.filter === 'ambiguous' && st !== 'ambiguous') return false;
  if (S.filter === 'diff' && !(st === 'matched' && s.match && s.match.diff && Object.keys(s.match.diff).some(k => k !== 'gtfs:stop_id'))) return false;
  if (S.filter === 'name' && !(st === 'matched' && s.match && s.match.diff && s.match.diff.name)) return false;
  if (S.filter === 'position' && !(s.match && s.match.diff && s.match.diff.position)) return false;
  if (S.filter === 'desc' && !s.desc) return false;
  if (S.q) {
    const q = S.q.toLowerCase(), o = matchedOsm(s);
    if (!(s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q) || s.ref.includes(q) || (o && (o.tags.name || '').toLowerCase().includes(q)))) return false;
  }
  return true;
}
function renderStops(P) {
  const f = el('div', {class: 'filters'});
  const sel = el('select', {class: 'b', onchange: e => { S.filter = e.target.value; render(); draw(); }});
  for (const [v, l] of [['all', 'all stops'], ['matched', 'matched'], ['decide', 'to decide (which, or moved)'], ['todo', 'to decide, or not in OSM'], ['missing', 'not in OSM'], ['moved', 'probably moved'], ['ambiguous', 'ambiguous'], ['diff', 'tags differ'], ['name', 'name differs'], ['position', 'position differs'], ['desc', 'has announcement']]) sel.append(el('option', {value: v, selected: S.filter === v ? '' : null}, l));
  f.append(sel, el('input', {placeholder: 'search name, announcement, code', value: S.q, oninput: e => { S.q = e.target.value; render(); draw(); }}));
  P.append(f);
  const places = Station.places();
  if (places.length && S.filter === 'all' && !S.q) {
    P.append(el('h2', {}, `${places.length} station${places.length > 1 ? 's' : ''}`));
    for (const pl of places) P.append(el('div', {class: 'row', onclick: () => Station.open(pl.id)},
      el('span', {class: 'dotc matched'}), el('div', {class: 'grow'}, el('div', {class: 't'}, pl.stations[0].tags.name || 'station'),
        el('div', {class: 's'}, `${pl.bays.length} bays${pl.stations.length > 1 ? ` · ${pl.stations.length} station points` : ''}`)), el('span', {class: 'chip'}, 'how it\'s mapped')));
  }
  const pos = D.positions || {};
  P.append(el('div', {class: 'hint'}, `Rings are the agency's positions${pos.typical != null ? `, usually within ${pos.typical} m of OSM's here` : ''}. Dots are OSM nodes. Nothing moves unless you say so.`));
  const rank = {missing: 0, moved: 1, ambiguous: 2, matched: 3};
  const list = Object.values(D.stops).filter(stopFilter).sort((a, b) => rank[stopStatus(a)] - rank[stopStatus(b)] || b.trips - a.trips);
  P.append(el('h2', {}, `${list.length} stops`));
  for (const s of list.slice(0, 400)) {
    const st = stopStatus(s), o = matchedOsm(s);
    const diffs = st === 'matched' && s.match && s.match.diff ? Object.keys(s.match.diff).filter(k => k !== 'gtfs:stop_id') : [];
    P.append(el('div', {class: 'row' + (S.stop === s.id ? ' on' : '') + (s.match && s.match.temporary ? ' dim' : ''), onclick: () => showStop(s.id)},
      el('span', {class: 'dotc ' + st}),
      el('div', {class: 'grow'}, el('div', {class: 't'}, s.name), el('div', {class: 's'}, [s.ref, s.desc, o && o.tags.name && o.tags.name !== s.name ? 'OSM: ' + o.tags.name : null].filter(Boolean).join(' · '))),
      s.match && s.match.temporary ? el('span', {class: 'chip'}, 'temporary') : s.routes && !s.routes.length ? el('span', {class: 'chip', title: 'In the feed, but no trip calls here now (a detour, say): its OSM stop stays as it is'}, 'no buses now') : st === 'ambiguous' ? el('span', {class: 'chip warn'}, `${s.match.osm.length} candidates`) : st === 'moved' ? el('span', {class: 'chip warn'}, `moved ${s.match.osm[0].dist} m?`) : st === 'missing' ? el('span', {class: 'chip bad'}, 'not in OSM') : diffs.length ? el('span', {class: 'chip'}, diffs.join(', ')) : null));
  }
}
function showStop(id) {
  S.stop = id; S.tab = 'stops';
  render(); draw();
  const s = D.stops[id], o = matchedOsm(s);
  // the agency's point and OSM's: the matched one, or every one the page asks about (moved from, which of two,
  // the one that goes when two were made one), all in view
  const asked = o ? [o] : ((s.match && s.match.osm) || []).slice(0, 4).map(x => D.osm_stops[x.id]).filter(Boolean);
  const gone = mergedWith(s);
  frame([[s.lon, s.lat], ...asked.map(osmPos), ...(gone ? [osmPos(gone)] : [])], Math.max(map.getZoom(), 17));
}
function renderStop(P, s) {
  P.append(el('button', {class: 'back', onclick: () => { S.stop = null; if (S.pattern) S.tab = 'routes'; render(); draw(); }}, S.pattern ? '← back to the route' : '← all stops'));
  const d = el('div', {class: 'detail'}), st = stopStatus(s), o = matchedOsm(s);
  d.append(el('div', {class: 'head'}, el('span', {class: 'dotc ' + st}), el('h3', {}, s.name)));
  if (s.match && s.match.temporary) d.append(el('div', {class: 'note warn'}, 'Looks temporary (detour). Convention: short detours are not mapped.'));
  d.append(el('div', {class: 'kv'},
    el('span', {class: 'k'}, 'code'), el('span', {}, `${s.ref}${s.code && s.code !== s.id ? ` (stop_id ${s.id})` : ''}`),
    s.desc ? el('span', {class: 'k'}, 'announced') : null, s.desc ? el('span', {}, s.desc) : null,
    s.tts ? el('span', {class: 'k'}, 'tts name') : null, s.tts ? el('span', {}, s.tts) : null,
    el('span', {class: 'k'}, 'routes'), el('span', {}, s.routes.map(rid => (D.routes.find(r => r.id === rid) || {short: rid}).short).join(', ') + ` · ${s.trips} trips`),
    s.wheelchair && s.wheelchair !== '0' ? el('span', {class: 'k'}, 'wheelchair') : null, s.wheelchair && s.wheelchair !== '0' ? el('span', {}, {1: 'yes', 2: "no, says the agency (not put in OSM: too often wrong)"}[s.wheelchair]) : null,
    s.platform_code ? el('span', {class: 'k'}, 'platform') : null, s.platform_code ? el('span', {}, s.platform_code) : null));
  if (s.match && s.match.notes && s.match.notes.length) d.append(el('div', {class: 'note warn'}, ...s.match.notes.map(n => el('div', {}, n))));
  { const nl = noteLines([...(s.osm_notes || [])]); if (nl) d.append(nl); }
  const place = Station.ofStop(s);
  if (place) d.append(el('div', {class: 'note'}, `${matchedOsm(s) ? 'A bay' : 'Probably a bay'} at ${place.stations[0].tags.name || 'a station'}. `, el('button', {class: 'b tiny', onclick: () => Station.open(place.id)}, 'The station: how it\'s mapped')));
  const existing = Object.keys(Edits.all()).find(k => Edits.all()[k].kind === 'create' && Edits.all()[k].tags['gtfs:stop_id'] === s.id);

  if (st === 'missing') {
    d.append(el('h2', {style: 'margin-left:0'}, 'Not in OSM'));
    d.append(el('div', {class: 'small'}, 'No bus stop within 60 m of the agency\'s position, and none on the same street further off. The position is the agency\'s: drop the node, then drag it onto the sign in RapiD or here.'));
    d.append(el('div', {class: 'btns'},
      existing ? el('span', {class: 'chip edit'}, 'added to changes') : el('button', {class: 'b primary', onclick: () => placeNewStop(s)}, 'Add stop here → changes'),
      editorButtons({lon: s.lon, lat: s.lat, zoom: 19, select: [], comment: `Bus stop ${s.ref} ${s.name}`}, {primaryLabel: 'Look in RapiD'})));
    d.append(el('details', {class: 'small'}, el('summary', {}, 'Tags it would get'), el('div', {class: 'kv'}, ...Object.entries(s.proposed_tags).flatMap(([k, v]) => [el('span', {class: 'k'}, k), el('span', {}, v)]))));
  } else if (st === 'moved' && s.routes && !s.routes.length) {
    // in the feed, but no bus calls here now: the agency's point (parked somewhere for a detour, say) moves nothing
    const c = s.match.osm[0], oo = D.osm_stops[c.id];
    d.append(el('h2', {style: 'margin-left:0'}, 'No bus calls here now'));
    d.append(el('div', {class: 'small'}, "The agency still lists it, but no trip stops here (a detour, say). Its OSM stop, ", el('b', {}, oo.tags.name || oo.id), `, ${c.dist} m from where the feed puts it now, stays where it is.`));
    d.append(osmStopBox(s, oo, c, false));
  } else if (st === 'moved') {
    const c = s.match.osm[0], oo = D.osm_stops[c.id];
    const gone = mergedWith(s);   // two stops the agency made one: the other goes when this one moves
    const away = s.match.move_how === 'restore' && s.match.moved_away;   // the node was here, until someone moved it
    d.append(el('h2', {style: 'margin-left:0'}, gone ? 'Two stops made one' : away ? 'Moved away from it' : 'Probably moved'));
    d.append(el('div', {class: 'small'}, gone ? s.match.decide.position.why + '.' : away
      ? [`OSM's `, el('b', {}, oo.tags.name || oo.id), ` was at the agency's spot until ${away.user} moved it ${away.m} m away on ${away.date} (`, el('a', {href: `https://www.openstreetmap.org/changeset/${away.changeset}`, target: '_blank'}, `changeset ${away.changeset}`), `). The stop didn't move: the node did. Putting it back is the suggestion.`]
      : [`Nothing within 60 m, but OSM has `, el('b', {}, oo.tags.name || oo.id), ` ${c.dist} m away on the same street${oo.tags.ref === s.ref ? ' with the same code' : ''}. Most likely the stop moved and OSM still has the old spot.`]));
    d.append(el('div', {class: 'btns'},
      el('button', {class: 'b primary', onclick: async () => {
        Edits.hold(`${s.name}: ${gone ? 'two stops made one' : 'moved'}`);
        try {
          Edits.decisions[s.id] = oo.id; markUndo(Edits.modify('node', osmNumId(oo), nodeBase(oo), {...moveLL(s), tags: identityTags(s)}, `${s.ref} ${s.name}: ${away ? 'put back' : `moved ${c.dist} m`}`), s);
          if (gone) carryGone(s, oo);   // what of the other's tags is ticked, onto this one
          const kept = gone ? await removeStops([gone], new Set(), `merged into ${s.name}`) : [];
          toast(kept.length ? `Moved; not removed, something else uses it: ${kept.join('; ')}` : gone ? 'Moved, and the other removed: in Changes' : 'Node move added to changes', 6000);
        } finally { Edits.release(); }
        render(); draw();
      }}, gone ? `Move it here (${c.dist} m) and remove ${gone.tags.name || gone.id}` : away ? 'Put it back where it was' : `Move that node here (${c.dist} m)`),
      gone ? el('button', {class: 'b', onclick: () => {
        Edits.hold(`${s.name}: moved`);
        try { Edits.decisions[s.id] = oo.id; markUndo(Edits.modify('node', osmNumId(oo), nodeBase(oo), {...moveLL(s), tags: identityTags(s)}, `${s.ref} ${s.name}: moved ${c.dist} m`), s); }
        finally { Edits.release(); }
        toast(`Moved; ${gone.tags.name || gone.id} kept`); render(); draw();
      }}, `Move it here, keep ${gone.tags.name || gone.id}`) : null,
      el('button', {class: 'b', onclick: () => { Edits.decisions[s.id] = oo.id; Edits.save(); toast('Treated as the same stop, position kept'); render(); draw(); }}, 'Same stop, keep OSM\'s position'),
      el('button', {class: 'b', onclick: () => placeNewStop(s)}, 'Different stop — add new')));
    if (gone) d.append(goneBox(s));
    d.append(osmStopBox(s, oo, c, false));
    // (its history explains it: the other stops of that name or street nearby aren't candidates)
    for (const c2 of away ? [] : s.match.osm.slice(1)) d.append(osmStopBox(s, D.osm_stops[c2.id], c2, false));
    if (gone && !s.match.osm.some(c2 => c2.id === gone.id)) d.append(osmStopBox(s, gone, {how: 'the other side', dist: s.match.merged_with.dist}, false));
  } else {
    const sh = st === 'ambiguous' && s.match.shared, a = sh && D.osm_stops[sh.id], own = sh && D.osm_stops[sh.own];
    d.append(el('h2', {style: 'margin-left:0'}, sh && a && own ? 'A shared stop, or its own?' : st === 'ambiguous' ? 'Which is it?' : 'OSM stop'));
    if (sh && a && own) {
      d.append(el('div', {class: 'small'}, `The agency's point is on ${sh.network}'s `, el('b', {}, a.tags.name || a.id), ` (${sh.dist} m). OSM's stop with its code, `,
        el('b', {}, own.tags.name || own.id), `, is ${sh.own_dist} m away. The agency may have moved its stop onto the shared one, or its point may be off.`));
      d.append(el('div', {class: 'btns'},
        el('button', {class: 'b primary', onclick: async () => {
          const kept = await shareStop(s, a, own);
          toast(kept.length ? `Shared; the old one not removed, something else uses it: ${kept.join('; ')}` : `Shared, and ${own.tags.name || own.id} removed: in Changes`, 6000);
          render(); draw();
        }}, `One stop: ${a.tags.name || a.id}, both networks (remove ${own.tags.name || own.id})`),
        el('button', {class: 'b', onclick: async () => { Edits.hold(`${s.name}: its own`); try { await pickStop(s, own.id, 'keep'); } finally { Edits.release(); } toast('Its own stop, where it is', 5000); render(); draw(); }}, `Keep ${own.tags.name || own.id} where it is`),
        el('button', {class: 'b', onclick: async () => { Edits.hold(`${s.name}: moved`); try { await pickStop(s, own.id, 'move'); } finally { Edits.release(); } toast('Node move added to changes'); render(); draw(); }}, `Move ${own.tags.name || own.id} here (${sh.own_dist} m)`)), shareBox(s));
    } else if (st === 'ambiguous') d.append(el('div', {class: 'small muted'}, 'Several OSM stops fit. Pick one, or say none does.'));
    const cands = Edits.decisions[s.id] ? [{id: Edits.decisions[s.id], dist: Math.round(m([o.lon, o.lat], [s.lon, s.lat])), how: 'chosen'}] : s.match.osm;
    for (const c of cands) if (D.osm_stops[c.id]) d.append(osmStopBox(s, D.osm_stops[c.id], c, st === 'ambiguous'));
    if (st === 'ambiguous') d.append(el('div', {class: 'btns'}, el('button', {class: 'b', onclick: () => { Edits.decisions[s.id] = 'none'; Edits.save(); render(); draw(); }}, 'None of these — it\'s missing')));
    if (Edits.decisions[s.id]) d.append(el('div', {class: 'small muted'}, 'Your choice. ', el('a', {href: '#', onclick: e => { e.preventDefault(); delete Edits.decisions[s.id]; Edits.save(); render(); draw(); }}, 'undo')));
  }
  const nearby = Object.values(D.osm_stops).filter(x => x.tags.public_transport !== 'stop_position' && m([x.lon, x.lat], [s.lon, s.lat]) < 150 && !(s.match && s.match.osm.some(c => c.id === x.id))).sort((a, b) => m([a.lon, a.lat], [s.lon, s.lat]) - m([b.lon, b.lat], [s.lon, s.lat]));
  if (nearby.length) {
    d.append(el('h2', {style: 'margin-left:0'}, 'Other OSM stops within 150 m'));
    d.append(el('ul', {class: 'plain small'}, ...nearby.slice(0, 6).map(x => el('li', {class: 'item'}, el('a', {href: osmLink(x.id), target: '_blank'}, x.tags.name || x.id), el('span', {class: 'muted'}, ` · ${Math.round(m([x.lon, x.lat], [s.lon, s.lat]))} m · ${['ref', 'route_ref', 'operator'].filter(k => x.tags[k]).map(k => k + '=' + x.tags[k]).join(' ')}`),
      st === 'ambiguous' || st === 'missing' ? el('a', {href: '#', style: 'margin-left:6px', onclick: e => { e.preventDefault(); Edits.decisions[s.id] = x.id; Edits.save(); render(); draw(); }}, 'this one') : null))));
  }
  P.append(d);
}
/** Tags GTFS is authoritative for: identity and service, not name or position. */
function identityTags(s) {
  const t = {};
  for (const k of ['ref', 'gtfs:stop_id', 'gtfs:stop_code', 'route_ref']) if (s.proposed_tags[k]) t[k] = s.proposed_tags[k];
  return t;
}
const compass = (a, b) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI) + 360) % 360 / 45) % 8];
/** Where an OSM stop is now: moved in Changes, or as OSM has it. */
function osmPos(o) { const op = Edits.get('n' + osmNumId(o)); return op && op.lat != null ? [op.lon, op.lat] : [o.lon, o.lat]; }
function osmStopBox(s, o, c, pickable) {
  const box = el('div', {class: 'small box'});
  const op = Edits.get('n' + osmNumId(o));
  box.append(el('div', {}, el('b', {}, o.tags.name || '(no name)'), ' ', el('a', {href: osmLink(o.id), target: '_blank'}, o.id), el('span', {class: 'muted'}, ` · ${Math.round(m(osmPos(o), [s.lon, s.lat]))} m from the agency's point · by ${c.how} · v${o.version} ${(o.timestamp || '').slice(0, 10)} ${o.user}`), op ? el('span', {class: 'chip edit', style: 'margin-left:6px'}, op.uploaded ? 'uploaded' : 'edited') : null));
  const now = op && op.kind !== 'delete' ? op.tags : o.tags;   // as it is now: with what's in Changes or went up
  box.append(el('div', {class: 'muted mono'}, Object.entries(now).map(([k, v]) => `${k}=${v}`).join('  ')));
  if (o.notes && o.notes.length && !(s.osm_notes || []).length) box.append(noteLines(o.notes));
  const base = (Edits.decisions[s.id] || (s.match && s.match.status === 'matched' && s.match.osm[0] && s.match.osm[0].id === o.id)) ? (s.match.diff || {}) : null;
  const diff = base && {...base};
  // what the tags now already say (in Changes, or uploaded) isn't a difference any more
  if (diff) for (const k of Object.keys(diff)) if (k !== 'position' && k !== 'tagging' && (now[k] || '') === (diff[k].gtfs || '')) delete diff[k];
  // The review only calls a position different past FAR (closer is the same stop placed by two hands), but
  // moving it to the agency's point is always on offer, as long as there's a distance to speak of.
  // Measured from where the stop is now: moved in Changes (by hand, say), or as OSM has it.
  const cur = osmPos(o), d = m(cur, [s.lon, s.lat]), placed = cur[0] !== o.lon || cur[1] !== o.lat;
  if (diff) delete diff.position;
  if (diff && d >= 2) diff.position = {gtfs: `${Math.round(d)} m ${compass(cur, [s.lon, s.lat])} of the OSM stop${placed ? ' as you placed it' : ''}`, osm: 'kept', near: d <= FAR()};
  // OSM's stop in the road (markInRoad): the move on offer is to the kerb beside it
  if (diff && !placed && s.match && s.match.inroad) diff.position = {gtfs: `the kerb beside it, ${Math.round(m(cur, s.match.inroad.at))} m ${compass(cur, s.match.inroad.at)}`, osm: `in the road, ${s.match.inroad.d} m from its middle`, inroad: true};
  if (diff && Object.keys(diff).length) {
    const g = el('div', {class: 'diff'}, el('span', {class: 'hd'}, 'use'), el('span', {class: 'hd'}, 'key'), el('span', {class: 'hd'}, 'agency says'), el('span', {class: 'hd'}, 'OSM has'));
    const checks = {};
    for (const [k, v] of Object.entries(diff)) {
      if (k === 'tagging') continue;
      // ticked as Check stops would have it: the agency's codes and its address in; what flagstop calls OSM's, or asks about, out
      const dec = ((s.match && s.match.decide) || {})[k], isIdentity = ['ref', 'gtfs:stop_id', 'route_ref'].includes(k);
      const on = isIdentity || (k !== 'position' && dec && dec.pick === 'agency');
      const cb = el('input', {type: 'checkbox', checked: on ? '' : null, title: dec ? dec.why : isIdentity ? "the agency's code for it" : ''});
      checks[k] = cb;
      g.append(cb, el('span', {class: 'k'}, k), el('span', {class: 'g'}, k === 'position' ? v.gtfs : (v.gtfs || '—')),
        el('span', {class: 'o'}, k === 'position' ? (v.inroad ? v.osm : v.near ? 'close enough to be the same spot' : 'on the sign, probably') : (v.osm || '—')));
    }
    box.append(g);
    if (diff.tagging) box.append(el('div', {class: 'muted'}, `tagging: OSM has ${diff.tagging.osm}; PTv2 wants ${diff.tagging.gtfs}`));
    box.append(el('div', {class: 'btns'}, el('button', {class: 'b primary tiny', onclick: () => {
      const tags = {}; let move = false;
      for (const [k, cb] of Object.entries(checks)) { if (!cb.checked) continue; if (k === 'position') move = true; else tags[k] = diff[k].gtfs; }
      if (diff.tagging && (o.tags.highway !== 'bus_stop' || o.tags.public_transport !== 'platform')) Object.assign(tags, {highway: 'bus_stop', public_transport: 'platform', bus: 'yes'});
      if (!s.proposed_tags['gtfs:stop_id'] || true) tags['gtfs:stop_id'] = s.id;
      const key = Edits.modify('node', osmNumId(o), nodeBase(o), {tags, ...(move ? moveLL(s) : {})}, `${s.ref} ${s.name}`);
      if (move) markUndo(key, s);
      toast('Added to changes'); render(); draw();
    }}, 'Apply ticked → changes'), el('span', {class: 'muted', style: 'align-self:center'}, 'gtfs:stop_id is always added')));
  } else if (diff) box.append(el('div', {style: 'color:var(--ok)'}, 'Tags agree with the feed.'));
  if (S.stop === s.id && diff) box.append(el('div', {class: 'muted'}, 'Or put it exactly where the sign is: drag its solid dot on the map.'));
  const row = el('div', {class: 'btns'});
  if (pickable) row.append(el('button', {class: 'b primary tiny', onclick: () => { Edits.decisions[s.id] = o.id; Edits.save(); render(); draw(); }}, 'This one'));
  row.append(editorButtons({lon: o.lon, lat: o.lat, zoom: 19, select: [o.id]}, {small: true, primaryLabel: 'RapiD'}));
  box.append(row);
  return box;
}
/** Drop a new node at the agency's position, draggable until the reviewer is happy. */
function placeNewStop(s) {
  const {at, kerb} = newStopSpot(s, S.pattern && patternById(S.pattern));
  const key = Edits.createNode(at[1], at[0], s.proposed_tags, `${s.ref} ${s.name}: new stop`);
  const mk = new maplibregl.Marker({draggable: true, color: css('--edit')}).setLngLat(at).addTo(map);
  mk.on('dragend', () => { const ll = mk.getLngLat(); const op = Edits.get(key); if (op) { op.lat = ll.lat; op.lon = ll.lng; Edits.save(); } });
  S.placing = mk;
  toast(`Node added ${kerb ? "at the kerb by the agency's point (theirs is in the road)" : "at the agency's position"}. Drag the marker onto the sign (imagery), then it's in Changes.`, 6000);
  render(); draw();
}

// ---------- OSM-only stops ----------
/** OSM stops no stop in the agency's data claims. The agency's own (its network, as its matched stops carry
 *  it) may be gone: look on the map, then remove. Other operators' are listed, never touched. */
/** Removing a stop that's out of the agency's feed: two steps. A feed published during a detour leaves out stops
 *  that come back after it, and nothing in GTFS says which: only someone who's seen it gone (imagery, the street) or
 *  the agency's word. g: {osm id: null | 'ask' | 'remove'}. */
function goneButtons(g, o, seen) {
  const st = g[o.id], stop = e => e && e.stopPropagation();
  if (st === 'remove') return [el('button', {class: 'b tiny chosen', onclick: e => { stop(e); g[o.id] = null; render(); }}, "✓ It's gone: remove it")];
  if (st === 'ask') return [el('div', {class: 'small', style: 'flex-basis:100%'}, "Not in the agency's feed now. If that's a detour, it'll be back. Remove it only if you've seen it isn't there any more (imagery, or on the street), or the agency says it's gone for good."),
    el('button', {class: 'b tiny', onclick: e => { stop(e); g[o.id] = 'remove'; render(); }}, "Yes, it's gone: remove it"),
    el('button', {class: 'b tiny', onclick: e => { stop(e); g[o.id] = null; render(); }}, 'Leave it')];
  return [el('button', {class: 'b tiny', disabled: seen ? null : '', title: seen ? '' : 'Show it on the map first', onclick: e => { stop(e); g[o.id] = 'ask'; render(); }}, "It's gone…")];
}
function renderExtra(P) {
  const mine = o => (D.extra_owner || {})[o.id] !== 'other';   // the agency's, by network/operator, or saying nothing
  const nearestGtfs = o => { let b = null, bd = 1e9; for (const s of Object.values(D.stops)) { const d = m([o.lon, o.lat], [s.lon, s.lat]); if (d < bd) { bd = d; b = s; } } return [b, bd]; };
  const rows = D.extra_stops.map(id => D.osm_stops[id]).filter(Boolean).map(o => ({o, ng: nearestGtfs(o)})).sort((a, b) => a.ng[1] - b.ng[1]);
  const ours = rows.filter(r => mine(r.o)), theirs = rows.filter(r => !mine(r.o));
  const g = S.extraGone || (S.extraGone = {});
  const chosen = ours.filter(r => g[r.o.id] === 'remove');
  P.append(el('div', {class: 'hint'}, `Bus stops in OSM within 400 m of this network that no stop in the agency's data claims. ${ours.length} look like this agency's (by their network or operator, or none): moved, gone, or left out of the feed for a while (a detour). Look at each on the map; only one that isn't there any more comes out of OSM.`));
  if (chosen.length) P.append(el('div', {class: 'btns'}, el('button', {class: 'b primary', onclick: async () => {
    Edits.hold(`remove ${chosen.length} stop${chosen.length > 1 ? 's' : ''} that are gone`);
    try {
      const kept = await removeStops(chosen.map(r => r.o));
      for (const r of chosen) delete g[r.o.id];
      toast(kept.length ? `Not removed, something else uses them: ${kept.join('; ')}` : `${chosen.length} in Changes`, kept.length ? 9000 : 4000);
    } catch (e) { toast(e.message, 8000); } finally { Edits.release(); }
    render(); draw();
  }}, `Remove ${chosen.length} from OSM → Changes`)));
  const row = ({o, ng}, removable) => {
    const seen = S.looked.has('osm:' + o.id), on = g[o.id] === 'remove', op = Edits.get('n' + osmNumId(o));
    const r = el('div', {class: 'row' + (on ? ' on' : '')},
      el('span', {class: 'dotc extra'}),
      el('div', {class: 'grow'}, el('div', {class: 't'}, o.tags.name || '(no name)'), el('div', {class: 's'}, [o.tags.ref ? 'ref ' + o.tags.ref : null, o.tags.operator || o.tags.network, o.tags.route_ref ? 'routes ' + o.tags.route_ref : null, `${Math.round(ng[1])} m from ${ng[0].name}`].filter(Boolean).join(' · ')),
        (o.served_by || []).length ? el('div', {class: 'small muted'}, `In ${o.served_by.join(', ')}'s own feed: still served, not gone.`) : null,
        (() => { const into = Object.values(D.stops).find(t => t.match && t.match.merged_with && t.match.merged_with.id === o.id); return into ? el('div', {class: 'small muted'}, 'The agency merged it into ', el('a', {href: '#', onclick: e => { e.preventDefault(); e.stopPropagation(); showStop(into.id); }}, into.name), ': removed when that one moves.') : null; })(),
        (D.detoured || {})[o.id] ? el('div', {class: 'small muted'}, `Route ${D.detoured[o.id].join(', ')}'s detour goes round it: back when the detour's over. Left as it is.`) : null,
        removable && !op && !(o.served_by || []).length && !(D.detoured || {})[o.id] ? el('div', {class: 'btns', style: 'margin-top:4px'},
          el('button', {class: 'b tiny' + (seen ? '' : ' primary'), onclick: e => { e.stopPropagation(); S.looked.add('osm:' + o.id); render(); map.flyTo({center: [o.lon, o.lat], zoom: 18}); popupOsm(o.id, [o.lon, o.lat]); }}, 'Show on map'),
          ...goneButtons(g, o, seen),
          seen ? el('a', {href: '#', class: 'muted small', style: 'margin-left:6px', onclick: e => { e.preventDefault(); e.stopPropagation(); openIn('rapid', {lon: o.lon, lat: o.lat, zoom: 19, select: [o.id]}); }}, 'imagery') : null) : null,
        op ? el('span', {class: 'chip edit'}, op.uploaded ? (op.kind === 'delete' ? 'removed' : 'uploaded') : op.kind === 'delete' ? 'to remove' : 'edited') : null,
        o.notes && o.notes.length ? noteLines(o.notes) : null),
      el('span', {class: 'muted small'}, `v${o.version}`));
    r.onclick = () => { map.flyTo({center: [o.lon, o.lat], zoom: 17}); popupOsm(o.id, [o.lon, o.lat]); };
    return r;
  };
  P.append(el('h2', {}, `This agency's: ${ours.length}`));
  for (const x of ours) P.append(row(x, true));
  if (theirs.length) {
    P.append(el('h2', {}, `Other operators': ${theirs.length}`), el('div', {class: 'hint'}, 'Their stops, not this agency\'s: listed so you know they\'re there, never changed here.'));
    for (const x of theirs) P.append(row(x, false));
  }
}

/** Take bus stops that are gone out of OSM, carefully: bus routes and stop areas that still list one lose it
 *  (a gone stop has no place in them); one any other relation uses is left (and said); one that's a point in a
 *  way (a sidewalk) loses only its stop tags, so the way keeps its shape; the rest are deleted.
 *  mine: relation ids this edit is rewriting anyway (their membership doesn't count). -> [kept, why] */
const STOP_KEYS = /^(highway|public_transport|bus|name|ref|local_ref|route_ref|network|network:wikidata|operator|operator:wikidata|description|shelter|bench|bin|lit|tactile_paving|departures_board|wheelchair|gtfs:.*)$/;
/** A route relation of this agency's: paired with one of its itineraries, or carrying its network or operator. */
function ours(e) {
  const t = e.tags || {}, c = D.conventions || {};
  return D.patterns.some(p => p.relations.some(a => a.id === e.id)) || ['network:wikidata', 'network', 'operator'].some(k => t[k] && c[k] && t[k] === c[k]);
}
/** The tags a stop's picked OSM stop takes, of what that choice would change: what flagstop suggests the agency's for. */
function choiceTags(s, oid) {
  const c = ((s.match && s.match.choices) || {})[oid] || {}, tags = {};
  for (const [k, v] of Object.entries(c.diff || {})) if (k !== 'position' && k !== 'tagging' && (c.decide || {})[k] && c.decide[k].pick === 'agency') tags[k] = v.gtfs;
  return tags;
}
/** One stop for two networks: the agency's stop is the other network's (their name and code stay, the agency's ids,
 *  routes and network go on it), and its own node goes, the agency's routes and stop areas listing the shared one in
 *  its place. -> what removeStops kept, and why */
async function shareStop(s, a, own) {
  Edits.hold(`${s.name}: shares ${a.tags.name || a.id}`);
  try {
    Edits.decisions[s.id] = a.id;
    const key = Edits.modify('node', osmNumId(a), nodeBase(a), {tags: choiceTags(s, a.id)}, `${s.ref} ${s.name}: shares ${a.tags.name || a.id}`);
    Edits.ops[key].share = s.match.shared.network;   // said so in the changeset comment
    Carry.onto(own, asWillBe(a), CARRY.stop);   // what of the old one's tags is ticked, onto the shared one
    const n = osmNumId(own), to = osmNumId(a);
    const rels = (await (await fetch(`${OSM_API}/api/0.6/node/${n}/relations.json`)).json()).elements.filter(ptRel);
    for (const e of rels) {   // as they are in Changes, if edited there
      const op = Edits.get('r' + e.id), cur = (op && op.members) || e.members;
      const has = cur.some(x => x.type === 'node' && x.ref === to), area = (e.tags || {}).public_transport === 'stop_area';
      const members = cur.flatMap(x => x.type === 'node' && x.ref === n ? (area && has ? [] : [{...x, ref: to}]) : [x]);
      const k = Edits.modify('relation', e.id, {version: e.version, tags: e.tags, members: e.members}, {members}, op ? null : `${(e.tags || {}).name || 'r' + e.id}: ${a.tags.name || a.id} for ${own.tags.name || own.id}`);
      if (!op) Edits.ops[k].swap = true;   // a stop swapped, not the route rebuilt
    }
    Edits.save();
    return await removeStops([own], new Set(rels.map(e => e.id)), `shared with ${a.tags.name || a.id}`);
  } finally { Edits.release(); }
}
/** A stop asked between OSM stops, answered: 'share' (the other network's stop, shareStop), 'keep' (that node
 *  where it is) or 'move' (that node to the agency's spot). The picked node gets what that choice changes, as a
 *  matched stop would (the agency's codes and routes). -> what shareStop couldn't remove, and why */
async function pickStop(s, oid, how, route) {
  const o = D.osm_stops[oid], sh = s.match && s.match.shared;
  if (!o) return [];
  if (how === 'share' && sh && D.osm_stops[sh.own]) return shareStop(s, o, D.osm_stops[sh.own]);
  Edits.decisions[s.id] = oid;
  const tags = choiceTags(s, oid);
  if (tags['gtfs:stop_id'] && s.proposed_tags['gtfs:stop_code'] && !o.tags['gtfs:stop_code']) tags['gtfs:stop_code'] = s.proposed_tags['gtfs:stop_code'];   // the code travels with the id
  if (how !== 'move' && !Object.keys(tags).length) { Edits.save(); return []; }
  const key = Edits.modify('node', osmNumId(o), nodeBase(o), {tags, ...(how === 'move' ? moveLL(s) : {})}, `${s.ref} ${s.name}` + (how === 'move' ? ": moved to the agency's spot" : ''));
  if (how === 'move') markUndo(key, s);
  if (route) { Edits.ops[key].suggested = true; Edits.ops[key].route = route; }
  return [];
}
/** Two things made one: the one that goes is deleted, and every one of its tags is listed with a keep option. Ticked,
 *  it goes onto the one that stays; nothing of it disappears unsaid. The defaults are per kind of merge (CARRY), as
 *  OSM practice has it; the reviewer's answer, kept per object (Edits.answers[its id]['keep:' + key]), overrides.
 *  rename: a key that goes on under another (a second station point's name as the station's alt_name). */
const CARRY = {
  // a second point for the same station: what it says that the station doesn't, kept; where they differ, the station's
  station: (k, v, now) => now == null,
  // a duplicate relation for the same itinerary: what only it has (a description, a website), kept; a service day's
  // own (its name, its timetable) isn't the route's, and where the two differ the kept relation's stays
  relation: (k, v, now) => now == null && !/^(name|opening_hours|interval|interval:conditional|gtfs:shape_id)$/.test(k),
  // another pole (a stop shared now, two stops made one): what it says describes that pole, not this one; the
  // agency's codes and routes go on by the share or the move. Kept only if ticked.
  stop: () => false,
};
/** How much a tag matters when it's lost: 2, worth a look (a fact someone surveyed: wheelchair, a shelter, opening hours,
 *  a phone; anything flagstop doesn't know, to be safe); 1, worth knowing (names, codes, who runs it); 0, low (what the
 *  agency's feed gives back anyway: its ids, a route's timetable and colour, a service day's name). */
const tagWeight = (k, v, tags = {}) => {
  const route = tags.type === 'route' || tags.type === 'route_master';
  if (/^gtfs:|^(type|route|route_master|public_transport:version|roundtrip|colour|interval(:conditional)?)$/.test(k) || (route && k === 'opening_hours')) return 0;
  if (/^(name|alt_name|old_name)$/.test(k) && /\b(weekdays?|saturdays?|sundays?|weekends?)\b/i.test(v || '')) return 0;
  if (/^(name|alt_name|old_name|official_name|short_name|ref|local_ref|from|to|via|network|operator|route_ref|description|highway|public_transport|bus|amenity)$|wikidata$|wikipedia$/.test(k)) return 1;
  return 2;
};
const WEIGHT_WORDS = ['low', 'worth knowing', 'worth a look'];
const Carry = {
  rows(from, into, def, rename = {}) {
    const a = Edits.answers[from.id] || {}, it = into.tags || {};
    return Object.entries(from.tags || {}).map(([k, v]) => {
      const to = rename[k] && !(rename[k] in it) && it[k] != null && it[k] !== v ? rename[k] : k, now = it[to];
      if (now === v) return {k, to, v, same: true};
      const ans = a['keep:' + k];
      return {k, to, v, now, on: ans ? ans === 'yes' : !!def(k, v, now), w: tagWeight(k, v, from.tags)};
    }).sort((x, y) => (y.w ?? -1) - (x.w ?? -1));   // what matters most first
  },
  /** The tags that go onto the one that stays: {key: value}. */
  tags(from, into, def, rename) { return Object.fromEntries(this.rows(from, into, def, rename).filter(r => r.on).map(r => [r.to, r.v])); },
  box(from, into, def, {rename, title} = {}) {
    const rows = this.rows(from, into, def, rename), diff = rows.filter(r => !r.same), same = rows.filter(r => r.same), lost = diff.filter(r => !r.on);
    const set = (k, on) => { Edits.answer(from.id, 'keep:' + k, on ? 'yes' : 'no'); render(); draw(); };
    return el('div', {class: 'carry small'},
      el('div', {}, el('b', {}, title || `${from.tags.name || from.id}'s tags`), ` — it's deleted; ticked goes onto ${into.tags.name || into.id || 'the one that stays'}:`),
      ...diff.map(r => el('div', {class: r.w === 0 ? 'muted' : ''}, el('label', {style: r.w === 2 && !r.on ? 'color:var(--miss)' : ''}, el('input', {type: 'checkbox', checked: r.on ? '' : null, onchange: e => set(r.k, e.target.checked)}), ` ${r.to}=${r.v}`,
        r.to !== r.k ? el('span', {class: 'muted'}, ` (its ${r.k})`) : r.now != null ? el('span', {class: 'muted'}, ` (instead of ${r.now})`) : null))),
      same.length ? el('div', {class: 'muted'}, `The same on both already: ${same.map(r => `${r.k}=${r.v}`).join(', ')}.`) : null,
      lost.length ? el('div', {}, 'Lost with it: ', ...[2, 1, 0].map(w => lost.filter(r => r.w === w)).filter(g => g.length).flatMap((g, i) => [i ? '; ' : '',
        el('span', {style: g[0].w === 2 ? 'color:var(--miss);font-weight:600' : '', class: g[0].w === 2 ? '' : 'muted'}, `${g.map(r => `${r.k}=${r.v}`).join(', ')} (${WEIGHT_WORDS[g[0].w]})`)]), '.')
        : el('div', {class: 'muted'}, 'Nothing of it is lost.'));
  },
  /** Onto the one that stays (into an edit already in Changes, if there is one). */
  onto(from, into, def, rename) {
    const t = this.tags(from, into, def, rename);
    if (Object.keys(t).length) Edits.modify(typeOf(into), osmNumId(into), into.nodes ? {version: into.version, tags: into.tags, nodes: into.nodes} : into.members ? relBase(into) : nodeBase(into), {tags: t});
    return t;
  },
};
/** What a stop's node will say once the share or move in Changes is done: for showing which of the other's tags are
 *  the same already. */
const asWillBe = o => { const op = Edits.get(o.id[0] + osmNumId(o)); return {...o, tags: op && op.kind !== 'delete' ? op.tags : o.tags}; };
/** A stop shared with another network: its own node goes; its tags, each with a keep option onto the shared one
 *  (as it will be, with the agency's codes on it). */
const shareBox = s => { const sh = s.match.shared, a = D.osm_stops[sh.id], own = D.osm_stops[sh.own];
  return a && own ? Carry.box(own, {...a, tags: {...a.tags, ...choiceTags(s, a.id)}}, CARRY.stop, {title: `If it's one stop, ${own.tags.name || own.id}'s tags`}) : null; };
/** Two stops made one: the other goes; its tags, each with a keep option onto the one moved here. */
const goneBox = s => { const g = mergedWith(s), o = s.match && s.match.osm[0] && D.osm_stops[s.match.osm[0].id];
  return g && o ? Carry.box(g, asWillBe(o), CARRY.stop, {title: `${g.tags.name || g.id}, removed: its tags`}) : null; };
const carryGone = (s, moved) => { const g = mergedWith(s); if (g) Carry.onto(g, asWillBe(moved), CARRY.stop); };
/** A relation a gone stop can leave: a route of this agency's, or a stop area. */
const ptRel = e => (e.tags || {}).public_transport === 'stop_area' || ((e.tags || {}).type === 'route' && ours(e));
async function removeStops(list, mine = new Set(), why = 'stop gone') {
  const kept = [];
  for (const o of list) {
    if (o.id[0] !== 'n') { kept.push(`${o.tags.name || o.id} (drawn as a shape: remove it in iD)`); continue; }
    const n = osmNumId(o);
    const rels = (await (await fetch(`${OSM_API}/api/0.6/node/${n}/relations.json`)).json()).elements.filter(e => !mine.has(e.id));
    // a route of this agency's, or a stop area, lets it go; anything else that lists it (another agency's route
    // still stopping there, a relation of another kind) keeps it, and it's left alone
    const other = rels.filter(e => !ptRel(e));
    if (other.length) { kept.push(`${o.tags.name || o.id} (also in ${other.map(e => (e.tags || {}).name || 'r' + e.id).join(', ')})`); continue; }
    for (const e of rels) {   // out of the routes and stop areas that list it, as they are in Changes if edited there
      const op = Edits.get('r' + e.id), cur = (op && op.members) || e.members;
      Edits.modify('relation', e.id, {version: e.version, tags: e.tags, members: e.members}, {members: cur.filter(x => !(x.type === 'node' && x.ref === n))}, op ? null : `${(e.tags || {}).name || 'r' + e.id}: without ${o.tags.name || o.id}`);
    }
    const ways = (await (await fetch(`${OSM_API}/api/0.6/node/${n}/ways.json`)).json()).elements;
    if (ways.length) Edits.modify('node', n, nodeBase(o), {removeTags: Object.keys(o.tags).filter(k => STOP_KEYS.test(k))}, `${o.tags.name || o.id}: ${why} (point kept: it's on a way)`);
    else Edits.delete('node', n, nodeBase(o), `${o.tags.name || o.id}: ${why}`);
  }
  return kept;
}

// ---------- changes ----------
/** A changeset comment that says what this basket does: which routes, which relations, which stop tags. */
function changesetComment() {
  // What a person reading the changeset wants: which routes, and what was done to them, in a few words.
  // No ids or tag keys: those are in the changeset itself.
  const ops = Object.values(Edits.ops).filter(o => o.kind !== 'modify' || Edits.diff(o).length);
  const list = xs => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join('');
  const n = (k, w, ws = w + 's') => `${k} ${k === 1 ? w : ws}`;
  const isRoad = o => String(o.note || '').startsWith('road: ');
  const routes = new Set(), parts = [];
  // relations
  const areas = ops.filter(o => o.type === 'relation' && o.tags.public_transport === 'stop_area');
  for (const o of areas) parts.push(`${o.tags.name || 'a station'} grouped as a stop area`);
  const place = areas.length === 1 && areas[0].tags.name;
  const extraSt = ops.filter(o => /second station|same station as/.test(o.note || '')).length;
  if (extraSt) parts.push(`${n(extraSt, 'second station point')} sorted out`);   // a station's changes, said once under its name
  // a route that only lost a stop that's gone is said with the stop ("1 removed"), not as a rebuilt relation
  // tags put back as they were before an earlier changeset (What uploads took away): said as that
  const back = ops.filter(o => o.putBack);
  for (const o of back) if (o.type === 'relation' && o.tags.type === 'route' && o.tags.ref) routes.add(o.tags.ref);
  if (back.length) parts.push(`${list([...new Set(back.flatMap(o => Edits.diff(o).map(x => x.k)))])} put back as before changeset ${list([...new Set(back.map(o => String(o.putBack)))])}${back.length > 1 ? ` on ${back.length} objects` : ''}`);
  const rels = ops.filter(o => o.type === 'relation' && !o.putBack && !String(o.note || '').startsWith('master:') && !isRoad(o) && o.tags.public_transport !== 'stop_area' && !/: without /.test(o.note || '') && !o.swap);
  for (const o of rels) {
    const r = o.route || (o.kind === 'delete' ? (String(o.note || '').match(/route (\S+)/) || [])[1] : (routeOf(patternById(o.note) || {}) || {}).short);
    if (r) routes.add(r);
  }
  for (const o of ops.filter(o => o.swap)) {   // a route given a shared stop (shareStop): said by its number
    const p = D.patterns.find(p => p.relations.some(a => a.id === o.id)), r = p && routeOf(p);
    if (r) routes.add(r.short);
  }
  const dropped = rels.filter(o => o.kind === 'delete').length, kept = rels.filter(o => o.kind === 'modify'), made = rels.filter(o => o.kind === 'create');
  if (dropped && kept.length) parts.push(`merged ${n(dropped + kept.length, 'relation')} into ${kept.length === 1 ? 'one' : kept.length}`);
  else if (dropped) parts.push(`removed ${n(dropped, 'duplicate relation')}`);
  const restored = kept.filter(o => /regular route restored/.test(o.note || '')).length;   // restoreRegular
  if (restored) parts.push(`regular route restored on ${n(restored, 'relation')} (the detour unmapped)`);
  const rebuilt = kept.filter(o => !/regular route restored/.test(o.note || '') && Edits.diff(o).some(x => x.k === 'members')).length;
  if (kept.some(o => Edits.diff(o).some(x => x.k === 'opening_hours'))) parts.push('timetable hours added');
  if (rebuilt && !dropped) parts.push(`${n(rebuilt, 'relation')} rebuilt from the timetable`);
  if (made.length) parts.push(`${n(made.length, 'relation')} added`);
  // stops
  const nodes = ops.filter(o => o.type === 'node' && !o.putBack && !isRoad(o) && !/stop position|second station|same station as|: station$/.test(o.note || ''));
  for (const o of nodes) if (o.route) routes.add(o.route);
  const added = nodes.filter(o => o.kind === 'create').length, moved = nodes.filter(o => o.kind === 'modify' && Edits.diff(o).some(x => x.k === 'position')).length;
  const tagged = nodes.filter(o => o.kind === 'modify' && Edits.diff(o).some(x => x.k !== 'position') && !Edits.diff(o).every(x => x.after == null));
  const removed = nodes.filter(o => !/: shared with /.test(o.note || '')).filter(o => o.kind === 'delete' || (o.kind === 'modify' && !Edits.diff(o).some(x => x.k === 'position') && Edits.diff(o).every(x => x.after == null))).length;
  const shared = [...new Set(nodes.filter(o => o.share).map(o => o.share))];   // shareStop
  if (shared.length) parts.push(`${n(nodes.filter(o => o.share).length, 'stop')} shared with ${list(shared)}'s (the old one removed)`);
  const stopBits = [moved ? `${n(moved, 'stop')} moved` : null, added ? `${added} added` : null, removed ? `${removed} removed` : null].filter(Boolean);
  if (stopBits.length) parts.push(stopBits.join(', ').replace(/^(\d+) (added|removed)$/, (_, k, w) => `${n(+k, 'stop')} ${w}`));
  if (tagged.length) {
    const keys = new Set(tagged.flatMap(o => Edits.diff(o).map(x => x.k)));
    const what = [['ref', 'codes'], ['gtfs:stop_id', 'ids'], ['route_ref', 'routes'], ['name', 'names'], ['description', 'announcements'], ['network', 'network names'], ['operator', 'operator names']].filter(([k]) => keys.has(k)).map(([, w]) => w);
    parts.push(`${what.length ? list(what) : 'tags'} on ${n(tagged.length, 'stop')}`);
  }
  if (!routes.size) for (const o of nodes) for (const r of (D.stops[o.tags['gtfs:stop_id']] || {}).routes || []) routes.add((D.routes.find(x => x.id === r) || {}).short);
  // roads: what was done, by road name
  const road = [...new Set(ops.filter(isRoad).map(o => o.note.slice(6)
    .replace(/\s*\((?:w|n)-?\d+\)/g, '').replace(/\s+(?:at|from) n-?\d+/g, '').replace(/,?\s*as before changeset \d+/, '')
    .replace(/^Turn (.*) back$/, 'turned $1 back').replace(/^\w/, c => c.toLowerCase())))];
  if (road.length) parts.unshift(list(road.slice(0, 3)) + (road.length > 3 ? ` and ${road.length - 3} more road edits` : ''));
  const ways = ops.filter(o => o.type === 'way' && !isRoad(o) && Edits.diff(o).some(x => x.k !== 'nodes'));
  if (ways.length) parts.push(`tags on ${n(ways.length, 'road')}`);
  const rs = [...routes].filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const what = parts.map(x => place && !rs.length ? x.replace(` at ${place}`, '').replace(`${place} grouped`, 'grouped') : x);
  const text = `${rs.length ? `Bus route${rs.length > 1 ? 's' : ''} ${list(rs)}` : place || 'Bus routes'}: ${what.join('; ')}`;
  return [...text].length <= 255 ? text : [...text].slice(0, 254).join('') + '…';   // OSM's limit
}
function renderChanges(P) {
  const ops = Object.entries(Edits.ops);
  const user = Edits.auth.user();
  const d = el('div', {class: 'detail'});
  const talk = el('div'); d.append(talk); changesetTalk(talk);
  d.append(el('h2', {style: 'margin-left:0'}, ops.length ? `${ops.length} of ${UPLOAD_CAP} changes` : 'No changes yet'));
  d.append(el('div', {class: 'hint', style: 'padding-left:0'}, 'Everything you decided, as one changeset. Review each line; remove what you don\'t want. Upload sends it to OSM under your account. Or take it to JOSM as osmChange, or Level0 as text.'));
  if (ops.length) d.append(el('div', {class: 'btns'}, el('button', {class: 'b tiny', onclick: () => { if (confirm(`Remove all ${ops.length} changes? (Undo brings them back.)`)) { Edits.clear(); render(); draw(); } }}, 'Remove all')));
  const over = ops.length > UPLOAD_CAP;
  if (over) d.append(el('div', {class: 'small bad', style: 'margin:4px 0'}, `Over the limit of ${UPLOAD_CAP} per upload: undo or remove some.`));
  if (Edits.roads.length) d.append(el('div', {class: 'small box'}, el('b', {}, `${Edits.roads.length} road edit${Edits.roads.length > 1 ? 's' : ''}`),
    el('span', {class: 'muted'}, ' — each is several lines below (new nodes, ways, the relations repaired around them) that only work together: take one back with Undo (⌘Z / Ctrl+Z), not line by line.')));
  for (const [key, op] of ops) {
    const box = el('div', {class: 'small box'});
    const label = op.kind === 'create' ? 'new ' + op.type : op.kind === 'delete' ? 'delete ' + op.type + ' ' + op.id : `${op.type} ${op.id}`;
    const road = Edits.roadOf(key);
    // the button in its own column at the top right: a long title wraps beside it, so after a remove the
    // next line's button is where the last one was (click, click, click)
    box.append(el('div', {class: 'changehead'}, el('span', {class: 'grow'}, el('b', {}, label), ' ', el('span', {class: 'muted'}, op.note || '')),
      road ? el('span', {class: 'chip edit', title: 'Part of a road edit: undo it (Undo, newest first) to take it back'}, 'road edit')
           : el('button', {class: 'b tiny', onclick: () => { Edits.remove(key); render(); draw(); }}, 'remove')));
    if (op.kind === 'create') {
      box.append(el('div', {class: 'mono muted'}, Object.entries(op.tags).map(([k, v]) => `${k}=${v}`).join('  ')));
      if (op.type === 'relation') box.append(el('div', {class: 'muted'}, `${op.members.length} members`));
      if (op.type === 'way') box.append(el('div', {class: 'muted'}, `${op.nodes.length} nodes`));
      if (op.type === 'node') box.append(el('a', {href: '#', class: 'muted', onclick: e => { e.preventDefault(); map.flyTo({center: [op.lon, op.lat], zoom: 18}); }}, `${op.lat.toFixed(5)}, ${op.lon.toFixed(5)}`));
    } else if (op.kind === 'delete') {
      box.append(el('div', {class: 'mono muted'}, (op.tags.name || '') + ' ' + (op.tags.ref || '')));
    } else {
      const g = el('div', {class: 'diff', style: 'grid-template-columns:max-content 1fr 1fr'});
      for (const x of Edits.diff(op)) g.append(el('span', {class: 'k'}, x.k), el('span', {class: 'o'}, x.before ?? '—'), el('span', {class: 'g'}, x.after ?? '(removed)'));
      box.append(g);
    }
    d.append(box);
  }
  // the stored sign-in may have been revoked on OSM: check once, and say so rather than fail at upload
  if (user && Edits.auth.checked == null) Edits.auth.check().then(ok => { if (ok === false) render(); });
  if (Edits.auth.lost) d.append(el('div', {class: 'note', style: 'background:color-mix(in srgb, var(--miss) 14%, transparent)'},
    el('b', {}, 'Signed out: '), "OSM didn't accept flagstop's sign-in any more (the app was revoked or re-registered on OSM, or the sign-in expired). Your changes are all still here. Sign in again below; if you registered flagstop again on OSM, paste its new client ID under \"Set up upload\" first."));
  // the last upload: its changeset, until the next one replaces it
  const unsure = Edits.unsure();
  if (unsure) d.append(el('div', {class: 'note', style: 'background:color-mix(in srgb, var(--miss) 14%, transparent)'}, el('b', {}, 'Not sure it went up: '),
    'the reply to ', el('a', {href: `${OSM_WWW}/changeset/${unsure.id}`, target: '_blank'}, `changeset ${unsure.id}`), " was lost, and OSM couldn't be asked about it yet. Nothing is sent twice: the next upload asks OSM first, and takes out of Changes whatever had gone up."));
  const last = myUploads('lastUpload');
  if (last) d.append(el('div', {class: 'note'}, el('b', {}, 'Last upload: '),
    el('a', {href: `${OSM_WWW}/changeset/${last.id}`, target: '_blank'}, `changeset ${last.id}`),
    ` · ${last.n} change${last.n === 1 ? '' : 's'} · ${new Date(last.at).toLocaleString()}`, el('div', {class: 'muted'}, `"${last.comment}"`),
    (last.skipped || []).length ? el('div', {style: 'color:var(--miss)'}, `OSM did not delete ${last.skipped.join(', ')}: something still uses ${last.skipped.length > 1 ? 'them' : 'it'} (a route_master, another relation, a way). Still in Changes: remove the parent's reference, then upload again.`) : null,
    ...(last.undid || []).map(u => revertNote(u, last.id)),
    // the data here has it already (refreshed since): nothing to refresh for
    // (last.at is this browser's clock after the upload; the data's is the changeset's close, a moment before)
    D.osm_base && new Date(D.osm_base).getTime() >= new Date(last.at).getTime() - 60000 ? el('div', {class: 'muted small'}, 'In the data shown here.') :
    el('div', {class: 'btns'}, el('button', {class: 'b tiny', onclick: () => refreshOSM()}, 'Refresh from OSM to see it'),
      el('span', {class: 'muted small', style: 'align-self:center'}, "flagstop shows OSM as it was before; OSM's copy for this can lag a few minutes"))));
  const undoing = ops.map(([, o]) => o.undoes).filter(Boolean);
  if (undoing.length) d.append(el('div', {class: 'note'}, el('b', {}, 'Undoes someone\'s edit: '),
    ...undoing.flatMap((u, i) => [i ? '; ' : '', `${u.name} as ${u.user} left it (`, el('a', {href: `https://www.openstreetmap.org/changeset/${u.changeset}`, target: '_blank'}, `changeset ${u.changeset}`), `, ${u.date})`]),
    '. After upload you get a record of it to post on their changeset.'));
  if (ops.length) {
    // OSM takes 255 characters at most in a changeset comment (counted as characters, not bytes)
    const count = el('div', {class: 'small muted', style: 'text-align:right'});
    const showCount = v => { const n = [...v].length; count.textContent = `${n} / 255`; count.style.color = n > 255 ? 'var(--miss)' : ''; };
    const comment = el('input', {placeholder: 'changeset comment', value: S.comment || changesetComment(), style: 'width:100%', maxlength: 255, oninput: e => { S.comment = e.target.value; showCount(e.target.value); }});
    showCount(comment.value);
    d.append(el('h2', {style: 'margin-left:0'}, 'Send'), comment, count);
    const status = el('div', {class: 'small muted', style: 'margin:6px 0'});
    const btns = el('div', {class: 'btns'});
    if (user && over) btns.append(el('button', {class: 'b primary', disabled: ''}, `Upload (over ${UPLOAD_CAP})`));
    else if (user) {
      btns.append(el('button', {class: 'b primary', onclick: async e => {
        if (Edits.uploading) return;
        if (!confirm(`Upload ${ops.length} change${ops.length > 1 ? 's' : ''} to OpenStreetMap as ${user.display_name}?`)) return;
        const button = e.currentTarget; button.disabled = true;
        try {
          const n = ops.length;
          const {id, skipped, undid, recovered} = await Edits.upload(comment.value, `${D.agency.agency_name} GTFS`, s => status.textContent = s);
          // remembered, so the changeset stays findable after the page redraws or reloads
          // remembered with what goes with it (records for undone edits, deletes OSM skipped), so it all
          // survives the redraw that follows, and a reload
          try {
            localStorage.setItem(Edits.key + '.lastUpload', JSON.stringify({id, comment: comment.value, n, at: new Date().toISOString(), undid: undid || [], skipped}));
            const ups = myUploads('uploads') || []; ups.push({id, at: new Date().toISOString()});
            localStorage.setItem(Edits.key + '.uploads', JSON.stringify(ups.slice(-50)));
          } catch (e) {}
          S.comment = null;
          toast(recovered ? `Changeset ${id} had gone up after all: taken out of Changes` : `Uploaded: changeset ${id}`, 6000);
          render();
        } catch (e) {
          status.textContent = '';
          if (e.conflicts) { status.append(el('div', {style: 'color:var(--miss)'}, 'Not uploaded — these changed on OSM since flagstop looked:'), el('ul', {}, ...e.conflicts.map(c => el('li', {}, `${c.key}: ${c.why}`))), el('div', {}, 'Remove those lines or refresh the OSM data (tool/review.py --refresh) and decide again.')); }
          else if (e.signedOut) { Edits.auth.lost = true; render(); }   // shows why, and the sign-in button
          else status.textContent = 'Upload failed: ' + e.message;
        } finally { button.disabled = false; }
      }}, `Upload to OSM as ${user.display_name}`));
      btns.append(el('button', {class: 'b', onclick: () => { Edits.auth.signOut(); render(); }}, 'sign out'));
    } else {
      btns.append(el('button', {class: 'b primary', onclick: () => { Edits.auth.lost = false; Edits.auth.signIn().catch(e => toast(e.message)); }}, 'Sign in to OSM to upload'));
    }
    btns.append(el('button', {class: 'b', onclick: () => download('flagstop.osc', Edits.osc(), 'application/xml')}, 'Download .osc (JOSM)'));
    btns.append(el('button', {class: 'b', onclick: () => { navigator.clipboard.writeText(Edits.level0()).then(() => toast('Level0 text copied — paste at level0.osmz.ru')); }}, 'Copy Level0 text'));

    d.append(btns, status);
  }
  // sign-in: flagstop's own app where it covers this address (one click); else your own app, set up once
  const cid = Edits.auth.clientId();
  if (Edits.auth.builtIn() && !localStorage.getItem('flagstop.osm.client_id')) {
    d.append(el('div', {class: 'small', style: 'margin-top:8px'}, user ? `Signed in to OSM as ${user.display_name}. ` : '',
      user ? el('a', {href: '#', onclick: e => { e.preventDefault(); Edits.auth.signOut(); render(); }}, 'sign out')
        : el('button', {class: 'b primary tiny', onclick: () => Edits.auth.signIn()}, 'Sign in with OSM')));
    P.append(d);
    return;
  }
  d.append(el('details', {class: 'small', open: ((!cid || Edits.auth.lost) && ops.length) ? '' : null}, el('summary', {}, user ? `Signed in as ${user.display_name}` : 'Set up upload (once)'),
    el('p', {}, 'Uploading uses OSM\'s own login (OAuth 2). Register flagstop as an application on your account: ', el('a', {href: 'https://www.openstreetmap.org/oauth2/applications/new', target: '_blank'}, 'osm.org → OAuth 2 applications → Register'), '. Name: flagstop. Redirect URI: ', el('code', {}, Edits.auth.redirect()), '. Untick "Confidential application". Permissions: read user preferences, modify the map. Paste the client ID here:'),
    el('div', {class: 'btns'}, el('input', {value: cid, placeholder: 'client id', style: 'flex:1', onchange: e => { Edits.auth.setClientId(e.target.value); toast('saved'); }}))));
  P.append(d);
}
function download(name, text, type) {
  const a = el('a', {href: URL.createObjectURL(new Blob([text], {type})), download: name}); document.body.append(a); a.click(); a.remove();
}

/** The sandbox this page runs against, if any: forget every upload, build the review again, start clean. */
async function resetSandbox() {
  if (!confirm('Reset the sandbox? Every upload to it is forgotten, the map is the snapshot again, and this page starts with an empty basket, no decisions and no answers.')) return;
  try {
    let st = await (await fetch('api/sandbox/reset', {method: 'POST'})).json();
    if (st.error) return toast(`Couldn't: ${st.error}`, 8000);
    toast('Sandbox reset: building the review again from the snapshot…', 60000);
    while (st.running) { await new Promise(r => setTimeout(r, 1500)); st = await (await fetch('api/refresh')).json(); }
    if (st.error) return toast(`Couldn't: ${st.error}`, 8000);
    location.reload();
  } catch (e) { toast('Needs tool/sandbox.py run (' + e.message + ')', 6000); }
}
function renderAbout(P) {
  const f = D.feed;
  const sandbox = typeof FLAGSTOP_OSM !== 'undefined' && FLAGSTOP_OSM.world;
  if (sandbox) P.append(el('div', {class: 'note', style: 'margin:10px'}, el('b', {}, 'This is the sandbox. '), `Nothing here reaches OpenStreetMap: uploads land in tool/sandbox.py's copy of the map (generation ${sandbox}). `,
    el('button', {class: 'b tiny', style: 'margin-left:6px', onclick: resetSandbox}, 'Reset the sandbox'), el('div', {class: 'small muted'}, 'Every upload forgotten, the review built again from the snapshot, this page\'s basket, decisions and answers emptied: run it through again from the start.')));
  P.append(el('div', {class: 'about'},
    el('p', {}, el('b', {}, D.agency.agency_name), el('br'), `feed ${f.file} · version "${f.feed_version || '?'}" · ${f.feed_start_date || ''}–${f.feed_end_date || ''}`, el('br'), `OSM data fetched ${D.osm_fetched} · review built ${D.generated}`),
    el('p', {}, el('b', {}, 'What the agency is good for.'), ' Which stops exist, their codes and addresses (the stop names), which routes call and in what order. Positions vary by agency: flagstop measures how far this feed\'s points usually are from OSM\'s and asks about the ones well past that. Shapes are drawn by hand: the route follows OSM\'s roads, pulled toward the shape. Where the agency is the source, flagstop suggests its value; where it isn\'t sure, it asks.'),
    el('p', {}, 'The ', el('span', {style: 'color:var(--shape)'}, 'dashed orange line'), ' is the agency\'s drawn shape. The ', el('span', {style: 'color:var(--routed)'}, 'blue line'), ' is where a bus can drive on OSM\'s roads while hugging that shape (oneway, access and bus/psv tags honoured). Where they part, something is wrong on one side: a road missing or cut in OSM, a oneway the wrong way, or a sloppy shape. ', el('span', {style: 'color:var(--rel)'}, 'Purple'), ' is what OSM\'s route relation currently contains. Rings are agency stop positions, dots are OSM nodes.'),
    el('p', {}, el('b', {}, 'Editing.'), ' Stop and relation decisions go into Changes and leave as one changeset (your OSM login), an osmChange file for JOSM, or Level0 text. Way tags (oneway, access) can be edited from a divergence. Roads (map, top right) splits, reconnects, moves and adds road segments on live OSM data and repairs every route on them in the same changeset — what RapiD refuses when a route runs through. Shaping roads by eye is RapiD\'s: every "Open in RapiD" carries the agency line as an overlay and pre-fills the changeset comment.'),
    el('p', {}, el('b', {}, 'Detours.'), ' Map the regular route. A detour of days or weeks isn\'t mapped; OSM can\'t keep up and the churn is worse than the lag. A long one (months) is, with a note=* on the relation saying it\'s a diversion, reverted afterwards. Stops named Temp/Detour and itineraries run only by a short-dated service are marked temporary here and left out of proposals.'),
    el('p', {}, el('b', {}, 'Before uploading much'), ', read ', el('a', {href: 'https://wiki.openstreetmap.org/wiki/Import/Guidelines', target: '_blank'}, 'Import/Guidelines'), ' and ', el('a', {href: 'https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct', target: '_blank'}, 'the automated-edits code of conduct'), '. Reviewing route by route and uploading what you\'ve checked is mapping; uploading all of it unread is an import, and needs the licence checked and the community told first.')));
}

// ---------- boot ----------
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  // the tab you're on, clicked again: back to its list (out of a route, a card, a stop)
  const again = S.tab === b.dataset.tab;
  S.tab = b.dataset.tab;
  if (S.tab === 'stops' && again) S.station = null;
  if (S.tab !== 'routes' || again) { S.pattern = null; S.review = null; S.fix = null; S.merge = null; S.fixit = null; S.div = null; S.routed = null; S.routedBy = null; S.viaMode = false; }
  if (S.tab !== 'stops' || again) S.stop = null;
  document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove());
  render(); draw();
  $('#panel').scrollTop = 0; $('#side').scrollTop = 0;   // a list starts at its top
});
// tool/serve.py running here? A published copy (GitHub Pages) has no server: no refresh or bring-in, and the
// data is rebuilt there on a schedule instead.
let SERVER = false;
fetch('api/refresh').then(r => r.ok ? r.json() : null).then(j => { SERVER = !!(j && 'running' in j); if (D) render(); }).catch(() => {});
// (a request that hangs, a server restarting under it, says so after a minute rather than 'loading…' for ever)
const dataTimeout = new AbortController(); setTimeout(() => dataTimeout.abort(), 60000);
fetch('data/review.json', {signal: dataTimeout.signal}).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(async d => {
  D = d;
  // a stop asked between two OSM stops with what each would change (a shared pole or its own): the picked one's
  for (const s of Object.values(D.stops)) if (s.match && s.match.choices) {
    const m = s.match, pick = () => m.choices[Edits.decisions[s.id]] || {};
    Object.defineProperty(m, 'diff', {get: () => pick().diff || null, configurable: true});
    Object.defineProperty(m, 'decide', {get: () => pick().decide, configurable: true});
    const notes = m.notes || [];
    Object.defineProperty(m, 'notes', {get: () => pick().note ? [...notes, pick().note] : notes, configurable: true});
  }
  Edits.load(d.agency.agency_name, typeof FLAGSTOP_OSM !== 'undefined' ? FLAGSTOP_OSM.world : '');   // a sandbox's generation: its own basket
  Edits.settle(d.osm_base);   // what went up and is in this data now stops being laid over it
  Edits.sync().then(took => { if (took) { toast('Your Changes and decisions, as saved from another browser', 5000); render(); draw(); } });
  // what this browser holds as uploaded and not yet in the data: only what OSM has a changeset of mine for
  if (Edits.auth.user()) Edits.verifyUploaded().then(n => { if (n) { toast(`${n} upload${n > 1 ? 's' : ''} this browser remembered aren't on OSM: forgotten`, 6000); render(); draw(); } });
  // the reviewer's say over the open route changed under it (undo, redo, another browser's copy): route again
  Edits.listeners.push(() => { if (S.pattern && S.routedWith != null && JSON.stringify(Edits.routingOf(S.pattern)) !== S.routedWith) liveRoute(); });
  // road edits taken out of Changes (removed, Remove all, undone): the open route runs on the roads as they are again,
  // not on pieces of a split that's gone
  let roadSig = JSON.stringify(roadPatches());
  Edits.listeners.push(() => { const sig = JSON.stringify(roadPatches()); if (sig !== roadSig) { roadSig = sig; if (S.pattern && S.routedBy === 'changes') liveRoute(); } });
  Edits.listeners.push(() => { const b = $('#tabs button[data-tab=changes]'); if (b) b.textContent = Edits.count() ? `Changes (${Edits.count()})` : 'Changes'; undoBar(); Roads.undoCtl(); if (Roads.on && !Roads.drag && !Roads.pick && !Roads.loading) Roads.status(); });
  undoBar();
  $('#agency').textContent = `${d.agency.agency_name} · feed ${(d.feed.feed_version || '').slice(0, 40)} · OSM ${d.osm_fetched.replace('T', ' ')} `;
  $('#agency').append(el('a', {href: '#', title: 'Fetch OSM again and rebuild the review', onclick: e => { e.preventDefault(); SERVER ? refreshOSM() : toast(`This copy is rebuilt from OSM daily (last ${d.generated}). Your uploads show at once anyway.`, 6000); }}, 'refresh'));
  try { if (await Edits.auth.complete()) { S.tab = 'changes'; toast('Signed in to OSM'); } } catch (e) { toast('Sign-in failed: ' + e.message, 8000); }
  render();
  try { initMap(); } catch (e) { toast('Map failed to start: ' + e.message, 8000); console.error(e); }
  // what the address says is open, now: not when the map has loaded (a background tab may not load it for a while)
  try { applyHash(); } catch (e) { console.error(e); }
  routeAll();   // each route's roads, one at a time, so the list's percentages fill in
}).catch(e => {
  console.error(e);
  if (D) return;   // it loaded; something after failed (and said so)
  $('#agency').textContent = '';
  $('#agency').append(String(e.message) === '404' ? 'no data/review.json — run tool/review.py' : `the review didn't load (${e.name === 'AbortError' ? 'no answer in a minute' : e.message}) `,
    el('a', {href: '#', onclick: ev => { ev.preventDefault(); location.reload(); }}, 'try again'));
});

window.addEventListener('hashchange', () => { if (D && map) applyHash(); });
// the basket changed in another tab of this browser (an answer, an upload): this tab takes it, so it doesn't save
// its own older copy over it later (and bring back what went up)
window.addEventListener('storage', e => {
  if (!D || !e.key || !(e.key === Edits.key || e.key === Edits.key + '.uploaded')) return;
  if (Edits.fromStorage()) { Edits.listeners.forEach(f => f()); render(); draw(); toast('Changes updated from another tab'); }
});
