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

let D, map, S = {looked: new Set(), lookStop: null, tab: 'routes', pattern: null, div: null, stop: null, vias: [], routed: null, filter: 'all', q: '', viaMode: false, placing: null};

function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- editors: RapiD first, iD, JOSM ----------
const dataUrl = p => p ? `${location.origin}/data/shape-${p.id.replace(/[^A-Za-z0-9]/g, '_')}.gpx` : null;
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
const bboxOf = pts => {
  let l = 180, r = -180, b = 90, t = -90;
  for (const [x, y] of pts) { l = Math.min(l, x); r = Math.max(r, x); b = Math.min(b, y); t = Math.max(t, y); }
  return {left: l - 0.0015, right: r + 0.0015, bottom: b - 0.001, top: t + 0.001};
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
  const key = Object.keys(Edits.ops).find(k => Edits.ops[k].kind === 'create' && Edits.ops[k].type === 'node' && Edits.ops[k].tags['gtfs:stop_id'] === s.id);
  return key ? {key, role: 'platform'} : null;
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
const routedOf = p => (S.pattern === p.id && S.routed) ? S.routed : p.routed;
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
  Edits.delete('relation', a.id, relBase(a), `duplicate of route ${routeOf(p).short}`);
  // A relation still in a route_master is not deleted by OSM (the upload uses if-unused): take it out, put the kept one in.
  editMasters([], a.id, keep ? {type: 'relation', ref: keep.id} : null);
  toast('Marked for deletion' + ((D.masters || []).some(m => m.routes.includes(a.id)) ? ', and swapped in its route_master' : '')); render();
}
const nodeBase = o => ({version: o.version, tags: o.tags, lat: o.lat, lon: o.lon});
const osmNumId = o => o.osm_id ?? +o.id.slice(1);

// ---------- map ----------
function initMap() {
  const b = D.feed.bbox;
  map = new maplibregl.Map({
    container: 'map', center: [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2], zoom: 11, attributionControl: {compact: false},
    style: {version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf', sources: {osm: {type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}},
      layers: [{id: 'osm', type: 'raster', source: 'osm', paint: {'raster-saturation': -0.6, 'raster-opacity': 0.85}}]},
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.on('load', () => {
    setTimeout(applyHash);   // after the layers below exist
    for (const id of ['rel', 'shape', 'routed', 'div', 'divpath', 'gtfs', 'tether', 'stops', 'osmstops', 'vias', 'leg', 'edits', 'fixroad', 'stale', 'look', 'station']) map.addSource(id, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
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
    map.on('click', e => { if (S.viaMode && !e.defaultPrevented) addVia([e.lngLat.lng, e.lngLat.lat]); });
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
    set('routed', r.geometry.length && mv !== 'now' ? [line(r.geometry)] : []);
    set('rel', mv === 'proposed' ? [] : p.relations.flatMap(a => a.geometry.map(g => line(g, {id: a.id}))));
    set('div', r.divergences.map(d => point([d.lon, d.lat], {d: JSON.stringify({...d, shape: undefined, path: undefined})})));
    set('divpath', r.divergences.flatMap(d => [d.shape && d.shape.length > 1 ? line(d.shape) : null, d.path && d.path.length > 1 ? line(d.path) : null].filter(Boolean)));
    const f = stopFeatures(p.stops);
    set('stops', f.solid); set('gtfs', f.rings); set('tether', f.tethers);
    const inP = new Set(p.stops.map(id => matchedOsm(D.stops[id])).filter(Boolean).map(o => o.id));
    set('osmstops', Object.values(D.osm_stops).filter(o => !inP.has(o.id) && o.tags.public_transport !== 'stop_position').map(o => point([o.lon, o.lat], {id: o.id})));
    set('vias', S.vias.map(v => point(v)));
  } else {
    for (const id of ['shape', 'routed', 'rel', 'div', 'divpath', 'vias', 'leg']) set(id, []);
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
    el('div', {}, el('a', {href: osmLink(id), target: '_blank'}, 'osm.org'), ' · ', editorButtons({lon: o.lon, lat: o.lat, select: [id]}, {small: true})))).addTo(map);
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
  box.append(el('div', {style: 'margin-top:6px'}, el('button', {class: 'b primary tiny', style: 'margin-right:4px', onclick: () => { document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove()); Roads.editAt([d.lon, d.lat]); }}, 'Edit roads here'),
    editorButtons({lon: d.lon, lat: d.lat, zoom: 17, select: d.ways.map(w => 'w' + w), pattern: patternById(S.pattern), pts: d.shape, comment: `Bus route ${routeOf(patternById(S.pattern)).short}: ${d.why.slice(0, 80)}`}, {small: true})));
  new maplibregl.Popup({closeButton: true, maxWidth: '360px'}).setLngLat(ll).setDOMContent(box).addTo(map);
}
/** A tiny tag editor for a way: enough for oneway/access/bus fixes. base: the live way, when the road editor has it. */
function wayTagEditor(wid, tags, at, base) {
  const cur = Edits.get('w' + wid);
  const t = {...(cur ? cur.tags : tags)};
  const box = el('div', {class: 'small'}, el('b', {}, `way ${wid}`), el('div', {class: 'muted'}, 'Tags. To split or reconnect it, turn on Roads (map, top right).'));
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

// ---------- re-routing through via points ----------
async function addVia(v) { S.vias.push(v); await retrace(); }
async function retrace() {
  const p = patternById(S.pattern);
  try {
    S.routed = await traceWith(p.id, {}, S.vias); S.routedBy = 'vias';   // with what's in Changes, too
    toast(`Re-routed through ${S.vias.length} via point${S.vias.length === 1 ? '' : 's'}: ${S.routed.ways.length} ways`);
  } catch (e) { toast('Re-routing needs tool/serve.py running with the feed loaded (' + e.message + ')', 5000); S.vias.pop(); }
  render(); draw();
}

// ---------- panel ----------
/** The OSM data predates the last upload (Overpass hadn't caught up when it was fetched): what's here would
 *  suggest redoing it. Said at the top until a refresh gets newer data. */
function staleNote() {
  let last = null; try { last = JSON.parse(localStorage.getItem('flagstop.lastUpload') || 'null'); } catch (e) { /* storage off */ }
  if (!last || !last.at || !D.osm_base || new Date(D.osm_base) >= new Date(last.at)) return null;
  const t = s => new Date(s).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  return el('div', {class: 'note warn'}, `This OSM data is from ${t(D.osm_base)}, before your upload at ${t(last.at)} (changeset ${last.id}): Overpass hadn't caught up yet, so it may suggest what you just did. `,
    el('button', {class: 'b tiny', onclick: () => refreshOSM()}, 'Refresh again'));
}
function render() {
  const P = $('#panel'); P.innerHTML = '';
  if (S.tab === 'routes' || S.tab === 'stops') { const n = staleNote(); if (n) P.append(n); }
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#tabs button[data-tab=changes]').textContent = Edits.count() ? `Changes (${Edits.count()})` : 'Changes';
  if (S.tab === 'routes') S.merge && S.pattern ? Merge.render(P) : S.fix && S.pattern ? Fix.render(P) : S.review && patternById(S.review) ? Review.render(P, patternById(S.review)) : S.pattern ? renderPattern(P, patternById(S.pattern)) : renderRoutes(P);
  else if (S.tab === 'stops') S.station ? Station.render(P) : S.stop ? renderStop(P, D.stops[S.stop]) : renderStops(P);
  else if (S.tab === 'extra') renderExtra(P);
  else if (S.tab === 'changes') renderChanges(P);
  else renderAbout(P);
  syncHash();
}
const tile = (n, label, cls = '') => el('div', {class: 'tile ' + cls}, el('b', {}, n), el('span', {}, label));
const refBadge = r => el('span', {class: 'ref', style: r.color ? `background:#${r.color};color:#${r.text_color || '000'}` : ''}, r.short);

/** What's waiting in Changes for an itinerary (not uploaded yet): a merge, its relation, its stops. */
function pending(p) {
  const rels = p.relations.map(a => Edits.get('r' + a.id)).filter(Boolean);
  const osm = new Set(p.stops.map(id => { const s = D.stops[id], o = matchedOsm(s) || (s.match && s.match.osm && s.match.osm[0] && D.osm_stops[s.match.osm[0].id]); return o && osmNumId(o); }).filter(Boolean));
  const stops = Object.values(Edits.ops).filter(o => o.type === 'node' && (osm.has(o.id) || (o.kind === 'create' && p.stops.includes(o.tags['gtfs:stop_id'])))).length;
  const bits = [rels.some(o => o.kind === 'delete') ? 'merge' : rels.length ? 'relation' : null, stops ? `${stops} stop${stops > 1 ? 's' : ''}` : null].filter(Boolean);
  return bits;
}
function pendingChip(p) {
  const bits = pending(p);
  return bits.length ? el('span', {class: 'chip edit', title: 'Waiting in Changes, not uploaded yet'}, `in Changes: ${bits.join(', ')}`) : null;
}
function renderRoutes(P) {
  const s = D.summary;
  P.append(el('div', {class: 'tiles'},
    tile(D.patterns.filter(p => !p.temporary).length, 'itineraries'), tile(s.patterns['no relation'] || 0, 'no OSM relation', s.patterns['no relation'] ? 'bad' : ''), tile((s.patterns['duplicate relations'] || 0), 'mapped twice', s.patterns['duplicate relations'] ? 'warn' : ''),
    tile(s.stops.matched || 0, 'stops matched'), tile((s.stops.ambiguous || 0) + (s.stops.moved || 0), 'to decide', 'warn'), tile(s.stops.missing || 0, 'not in OSM', s.stops.missing ? 'bad' : '')));
  P.append(el('h2', {}, 'Itineraries, worst first'), el('div', {class: 'hint'}, 'The percentage is how much of the agency\'s line a bus can drive on OSM\'s roads as mapped. Below 100%, something on the map is in the way.'));
  const rows = D.patterns.map(p => ({p, g: patternGrade(p), sc: p.routed.score ? p.routed.score.shape_covered : 0}));
  rows.sort((a, b) => a.g.order - b.g.order || a.sc - b.sc || b.p.trips - a.p.trips);
  for (const {p, g, sc} of rows) {
    const r = routeOf(p), nd = p.routed.divergences.length;
    P.append(el('div', {class: 'row' + (p.temporary ? ' dim' : ''), onclick: () => selectPattern(p.id)},
      refBadge(r),
      el('div', {class: 'grow'}, el('div', {class: 't'}, p.headsign || p.direction_name || r.long || ('direction ' + p.direction)),
        el('div', {class: 's'}, `${p.stops.length} stops · ${p.trips} trips${nd ? ` · ${nd} place${nd > 1 ? 's' : ''} to look at` : ''}${p.chain_ok ? '' : ' · path broken'}`)),
      el('span', {class: 'pct' + (sc < 0.97 ? ' low' : ''), title: 'share of the agency line drivable on OSM roads'}, pct(sc)),
      pendingChip(p),
      el('span', {class: 'chip ' + g.cls}, g.chip)));
  }
  if (D.unpaired_relations.length) {
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
  const dir = u.now.replace('one-way ', '');
  const text = `[flagstop] Reverted direction of way ${u.way} (${u.name}) in changeset ${newId}. This edit made it ${u.was}, leaving no ${dir}bound way here.${u.route ? ` Used by bus route ${u.route}.` : ''}`;
  const ta = el('textarea', {rows: 3, style: 'width:100%;margin-top:4px'}); ta.value = text;
  return el('div', {class: 'note', style: 'margin-top:10px'},
    el('b', {}, `Record for ${u.user}'s changeset ${u.changeset}`), el('div', {class: 'muted'}, 'This upload undid part of it. To leave a record there, copy this into the comment box on their changeset:'),
    ta, el('div', {class: 'btns'},
      el('button', {class: 'b tiny', onclick: () => navigator.clipboard.writeText(ta.value).then(() => toast('Copied'))}, 'Copy'),
      el('a', {class: 'b tiny', href: `https://www.openstreetmap.org/changeset/${u.changeset}`, target: '_blank', style: 'text-decoration:none'}, `Open changeset ${u.changeset}`)));
}

/** Fetch OSM again and rebuild the review on the server, then show it. */
async function refreshOSM() {
  try {
    let st = await (await fetch('/api/refresh', {method: 'POST'})).json();
    if (st.error) return toast(`Refresh failed: ${st.error}`, 8000);
    toast('Fetching OSM again and rebuilding the review: a minute or two…', 120000);
    while (st.running) { await new Promise(r => setTimeout(r, 3000)); st = await (await fetch('/api/refresh')).json(); }
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
  const pts = [[s.lon, s.lat], ...(o ? [osmPos(o)] : []), ...c.slice(1).map(x => D.osm_stops[x.id]).filter(Boolean).map(x => [x.lon, x.lat])];
  fit(pts, 110);
}
const looked = sid => S.looked.has(sid);
/** The stop being looked at, drawn to stand out: OSM's stop now, the agency's spot, and the move between. */
function lookFeatures() {
  const s = S.lookStop && D.stops[S.lookStop];
  if (!s) return [];
  const c = (s.match && s.match.osm) || [], o = matchedOsm(s) || (c[0] && D.osm_stops[c[0].id]);
  const to = [s.lon, s.lat], out = [point(to, {kind: 'to', label: `agency: ${s.name}`})];
  if (o) {
    const now = osmPos(o), dm = Math.round(m(now, to));
    out.push(point(now, {kind: 'now', label: `now: ${o.tags.name || o.id} (OSM)`}));
    if (dm >= 3) out.push(line([now, to], {label: `${dm} m`}));
  }
  for (const x of c.slice(1)) { const q = D.osm_stops[x.id]; if (q && q !== o) out.push(point([q.lon, q.lat], {kind: 'other', label: `also: ${q.tags.name || q.id} (OSM)`})); }
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
    selectPattern(p.id); Merge.open(p);
    if (saved && saved.merge && saved.merge.pid === p.id) { S.merge = saved.merge; for (const k of saved.looked || []) S.looked.add(k); render(); draw(); }
  } else if (q.get('station') && Station.place(q.get('station'))) {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('flagstop.station') || 'null'); } catch (e) { /* storage off */ }
    Station.open(q.get('station'));
    if (saved && saved.id === q.get('station')) { S.station.answers = saved.answers; for (const k of saved.looked || []) S.looked.add(k); render(); draw(); }
  } else if (q.get('review') && patternById(q.get('review'))) { selectPattern(q.get('review')); Review.open(q.get('review')); }
  else if (q.get('pattern') && patternById(q.get('pattern'))) {
    selectPattern(q.get('pattern'));
    const dv = patternById(q.get('pattern')).routed.divergences[+q.get('div')];
    if (q.get('div') != null && dv) { S.div = +q.get('div'); render(); map.once('moveend', () => showDivergence(dv)); }
  } else if (q.get('stop') && D.stops[q.get('stop')]) showStop(q.get('stop'));
  else if (['stops', 'extra', 'changes', 'about'].includes(q.get('tab'))) { S.tab = q.get('tab'); render(); draw(); }
}
function showDivergence(dv) {
  document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove());
  fit(dv.shape && dv.shape.length ? dv.shape : [[dv.lon, dv.lat]], 120);
  map.once('moveend', () => popupDiv(dv, [dv.lon, dv.lat]));   // open it where it lands, not mid-flight
}

function selectPattern(id) {
  S.pattern = id; S.stop = null; S.vias = []; S.routed = null; S.routedBy = null; S.viaMode = false; S.tab = 'routes'; S.div = null; S.review = null; S.fix = null; S.merge = null; S.station = null; S.lookStop = null;
  liveRoute();   // with road edits waiting in Changes, show the route as it would run
  render(); draw();
  const p = patternById(id);
  fit(p.shape.length ? p.shape : p.stops.map(s => [D.stops[s].lon, D.stops[s].lat]));
}

function renderPattern(P, p) {
  const r = routeOf(p), rt = routedOf(p);
  P.append(el('button', {class: 'back', onclick: () => { S.pattern = null; S.div = null; S.vias = []; S.routed = null; render(); draw(); }}, '← all itineraries'));
  const d = el('div', {class: 'detail'});
  d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, p.headsign || p.direction_name || r.long), pendingChip(p), el('span', {class: 'muted small'}, `shape ${p.shape_id}`)));
  d.append(el('div', {class: 'muted small'}, `${r.long}${r.desc ? ' — ' + r.desc : ''} · ${p.loop && p.loop.length ? 'loop' : 'direction ' + p.direction} · ${p.stops.length} stops · ${p.trips} trips${p.variants ? ` · ${p.variants} short or end-of-day variants folded in` : ''}`));
  {
    const live = p.relations.filter(a => (Edits.get('r' + a.id) || {}).kind !== 'delete');
    if (live.length > 1) d.append(el('div', {class: 'note'}, el('b', {}, `${live.length} OSM relations for this one route. `),
      'Probably one per timetable; GTFS says it\'s the same route every day. ', el('button', {class: 'b primary tiny', onclick: () => Merge.open(p)}, 'See the proposed merge')));
  }
  if (p.loop && p.loop.length) d.append(el('div', {class: 'note'}, `One loop, run by one bus: the feed splits each trip in two at ${D.stops[p.split_at] ? D.stops[p.split_at].name : 'a stop'}, but the bus carries straight on and passengers ride through. In OSM it's one round-trip relation.`));
  if (p.temporary) d.append(el('div', {class: 'note warn'}, 'Only run by a short-dated service: a detour or a special. Usually not mapped; see ? for the convention.'));
  const sc = rt.score || {};
  d.append(el('div', {class: 'kv'},
    el('span', {class: 'k'}, 'drivable'), el('span', {}, `${pct(sc.shape_covered)} of the agency's line can be driven on OSM as mapped (${pct(sc.path_on_shape)} of the drivable path stays on the line)`),
    el('span', {class: 'k'}, 'path'), el('span', {}, `${rt.ways.length} ways · ${rt.legs.filter(l => l.ok).length}/${rt.legs.length} legs connect · ${p.chain_ok ? 'continuous' : 'BROKEN — a router would reject this'}`),
    (!S.routed && (p.chain_breaks || []).length) ? el('span', {class: 'k'}, 'chain') : null,
    (!S.routed && (p.chain_breaks || []).length) ? el('span', {}, `${p.chain_breaks.filter(b => b.kind === 'split').length} ways to split (Roads, on the map) before the relation validates `, ...chainLinks(p.chain_breaks.filter(b => b.kind !== 'split')), el('details', {style: 'display:inline'}, el('summary', {style: 'display:inline;cursor:pointer'}, 'where'), ' ', ...chainLinks(p.chain_breaks.filter(b => b.kind === 'split')))) : null));

  if (S.routedBy === 'changes') d.append(el('div', {class: 'note'}, 'Shown with your road edits waiting in Changes: the route as it will run once they\'re uploaded.'));
  const cen = centerOf(p.shape.length ? p.shape : rt.geometry);
  const btns = el('div', {class: 'btns'});
  btns.append(el('button', {class: 'b primary', onclick: () => proposeRelation(p)}, p.relations.length ? 'Fix relation → changes' : 'Create relation → changes'));
  {
    const sts = Review.stops(p).filter(st => st.o && !st.inChanges && (st.status === 'matched' || st.status === 'moved'));
    const asks = sts.reduce((n, st) => n + Object.values(st.decide).filter(d => d.pick === 'ask').length, 0);
    btns.append(el('button', {class: 'b primary', title: "flagstop's suggestion for every difference between the agency and OSM on this route's stops, for you to check", onclick: () => Review.open(p.id)},
      `Check stops${asks ? ` (${asks} question${asks > 1 ? 's' : ''})` : ''}`));
  }
  btns.append(el('button', {class: 'b', onclick: () => openIn('rapid', {...cen, zoom: 14, select: p.relations.map(a => 'r' + a.id), pattern: p, comment: `Bus route ${r.short} ${p.headsign || ''}`.trim()})}, 'Open in RapiD with line'));
  btns.append(el('button', {class: 'b', onclick: () => openIn('id', {...cen, zoom: 14, select: p.relations.map(a => 'r' + a.id), pattern: p})}, 'iD'));
  btns.append(el('button', {class: 'b' + (S.viaMode ? ' on' : ''), onclick: () => { S.viaMode = !S.viaMode; map.getCanvas().style.cursor = S.viaMode ? 'crosshair' : ''; render(); }}, S.viaMode ? 'Click the map to add a via point…' : 'Re-route via a point'));
  if (S.vias.length) btns.append(el('button', {class: 'b', onclick: () => { S.vias = []; S.routed = null; render(); draw(); }}, `Clear ${S.vias.length} via`));
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
    op ? el('span', {class: 'chip edit', style: 'margin-left:6px'}, op.kind === 'delete' ? 'to delete' : 'edited') : null));
  box.append(el('div', {class: 'muted'}, `covers ${pct(a.cover.shape_covered)} of the line; ${pct(a.cover.ways_on_shape)} of its ways are on it · ${a.ways.in_relation} ways · ${a.stops.in_relation} stop members`));
  const issues = [];
  if (a.both_directions) issues.push(el('li', {}, 'One relation holds both directions. PTv2 wants one per direction: this one is kept for one, and a new one created for the other (see "Fix relation").'));
  const kept = keptRelation(p);
  if (a.duplicate && kept && kept.id === a.id) issues.push(el('li', {}, 'Another relation covers this same itinerary — OSM has one relation per itinerary, not per service day. This one is the oldest: it is kept, and "Fix relation" rewrites it.'));
  else if (a.duplicate && (!op || op.kind !== 'delete')) issues.push(el('li', {}, `Another relation covers this same itinerary — OSM has one relation per itinerary, not per service day. r${kept ? kept.id : '?'} is kept; `, el('a', {href: '#', onclick: e => { e.preventDefault(); markDuplicate(a, p); }}, 'mark this one for deletion'), '.'));
  if (a.ways.chain_breaks.length) issues.push(el('li', {}, `the way chain breaks in ${a.ways.chain_breaks.length} place${a.ways.chain_breaks.length > 1 ? 's' : ''} (routers and validators reject it): `, ...chainLinks(a.ways.chain_breaks)));
  if (a.stops.missing.length) issues.push(el('li', {}, `${a.stops.missing.length} matched platforms are not members: `, ...a.stops.missing.slice(0, 8).flatMap(x => [el('a', {href: '#', onclick: e => { e.preventDefault(); showStop(x.stop); }}, `#${x.i + 1}`), ' ']), a.stops.missing.length > 8 ? '…' : ''));
  const extra = a.stops.extra.length, other = a.stops.extra_other_direction.length;
  if (extra) issues.push(el('li', {}, `${extra} platform members are not on this itinerary${other ? ` (${other} are the other direction's)` : ''}: `, ...a.stops.extra.slice(0, 6).flatMap(id => [el('a', {href: osmLink(id), target: '_blank'}, id), ' ']), extra > 6 ? '…' : ''));
  if (a.stops.out_of_order) issues.push(el('li', {}, `platform members are out of order in ${a.stops.out_of_order} place${a.stops.out_of_order > 1 ? 's' : ''}`));
  if (a.stops.unmatched.length) issues.push(el('li', {}, `${a.stops.unmatched.length} GTFS stops have no OSM platform yet (see Stops)`));
  if (a.ways.off_shape.length) issues.push(el('li', {}, `${a.ways.off_shape.length} member ways are off the line: `, ...a.ways.off_shape.slice(0, 8).flatMap(w => [el('a', {href: '#', title: w.name, onclick: e => { e.preventDefault(); map.flyTo({center: [w.lon, w.lat], zoom: 16}); }}, `w${w.way}`), ' ']), a.ways.off_shape.length > 8 ? '…' : ''));
  for (const t of a.tag_issues) issues.push(el('li', {}, el('code', {}, t.key), ': ', t.osm ? el('span', {}, el('span', {style: 'color:var(--rel)'}, t.osm), ' → ') : 'add ', el('span', {style: 'color:var(--shape)'}, t.gtfs)));
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
function proposeRelation(p) {
  const rt = routedOf(p);
  if (!p.chain_ok && !S.routed) { if (!confirm('The routed path is broken (a leg did not connect). Add the relation anyway?')) return; }
  // The routed path and the relations here were read before any road edit in Changes: building from them
  // would put back ways that were split or reconnected, and undo the repair made to the relation.
  const reshaped = new Set(Object.values(Edits.ops).filter(o => o.type === 'way' && String(o.note || '').startsWith('road: ')).map(o => o.id));
  const hit = [...rt.ways, ...p.relations.flatMap(a => a.members.filter(x => x.type === 'way').map(x => x.ref))].filter(w => reshaped.has(w));
  if (hit.length && !confirm(`Road edits in Changes reshape ${[...new Set(hit)].map(w => 'w' + w).join(', ')}, which this itinerary uses. The relations on them were already repaired; this proposal is from before those edits and would undo that.\n\nUpload the road edits and re-run tool/review.py --refresh first. Propose anyway?`)) return;
  const members = [];
  const missing = [];
  for (const sid of p.stops) {
    const ref = stopNodeRef(D.stops[sid]);
    if (ref) members.push(ref.key ? {key: ref.key, role: 'platform'} : {type: 'node', ref: ref.ref, role: 'platform'});
    else missing.push(D.stops[sid]);
  }
  const tags = {...p.proposed_tags};
  // Which existing relation to reuse: the oldest one paired with this pattern that no other pattern has claimed.
  const claimed = new Set(Object.values(Edits.ops).filter(o => o.type === 'relation' && o.kind === 'modify' && o.note !== p.id).map(o => o.id));
  const reuse = p.relations.filter(a => !claimed.has(a.id) && !(Edits.get('r' + a.id) || {}).kind?.startsWith('del')).sort((a, b) => a.id - b.id)[0];
  // The mapper's ways stay when they already run end to end along the whole line: they may follow it where the
  // router can't (a one-way it doesn't trust, a turn it doesn't know). Via points mean the reviewer wants the route.
  const keepWays = reuse && !S.vias.length && !reuse.both_directions && !reuse.ways.chain_breaks.length && !reuse.ways.off_shape.length &&
    reuse.cover.shape_covered >= ((rt.score || {}).shape_covered || 0);
  if (keepWays) for (const m of reuse.members) { if (m.type === 'way') members.push({...m}); }
  else for (const w of rt.ways) members.push({type: 'way', ref: w, role: ''});
  if (reuse) {
    // keep name if the mapper's is fine and only add what's missing? No: the proposed tags are the GTFS scheme; keep theirs where ours is generic.
    // The GTFS scheme's structural tags go in; the mapper's free text stays unless it names a service day,
    // which is the very thing being merged away.
    const merged = {...reuse.tags, ...tags};
    for (const k of ['name', 'from', 'to', 'description', 'colour']) if (reuse.tags[k] && !/\b(weekday|saturday|sunday|weekend|mon|tue|wed|thu|fri)\b/i.test(reuse.tags[k])) merged[k] = reuse.tags[k];
    if (reuse.both_directions && reuse.tags.name && !/bound|inbound|outbound/i.test(reuse.tags.name)) merged.name = tags.name;
    Edits.modify('relation', reuse.id, relBase(reuse), {tags: merged, members}, p.id);
    editMasters(routeOf(p).masters, null, {type: 'relation', ref: reuse.id});
    toast(`Relation r${reuse.id} rewritten in changes: ${members.length} members${keepWays ? ' (its ways kept: they already follow the line)' : ''}`);
  } else {
    const key = Edits.createRelation(tags, members, p.id);
    editMasters(routeOf(p).masters, null, {key});
    toast(`New relation in changes: ${members.length} members${routeOf(p).masters.length ? ', added to its route_master' : ''}`);
  }
  if (missing.length) toast(`${missing.length} stops have no OSM node yet — add them (Stops) and propose again`, 6000);
  render(); draw();
}
function proposeMaster(r) {
  const members = [];
  for (const pid of r.patterns) {
    const p = patternById(pid);
    if (p.temporary) continue;
    const key = Object.keys(Edits.ops).find(k => Edits.ops[k].type === 'relation' && Edits.ops[k].note === pid);
    if (key) members.push(Edits.ops[key].kind === 'create' ? {key, role: ''} : {type: 'relation', ref: Edits.ops[key].id, role: ''});
    else if (p.relations.length) members.push({type: 'relation', ref: p.relations.sort((a, b) => a.id - b.id)[0].id, role: ''});
  }
  if (!members.length) return toast('No relations to put in it yet');
  Edits.createRelation(r.proposed_master_tags, members, 'master:' + r.id);
  toast('route_master added to changes'); render();
}

// ---------- stops ----------
function stopFilter(s) {
  const st = stopStatus(s);
  if (S.filter === 'todo' && !(st === 'missing' || st === 'ambiguous' || st === 'moved')) return false;
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
  for (const [v, l] of [['all', 'all stops'], ['todo', 'to decide'], ['missing', 'not in OSM'], ['moved', 'probably moved'], ['ambiguous', 'ambiguous'], ['diff', 'tags differ'], ['name', 'name differs'], ['position', 'position differs'], ['desc', 'has announcement']]) sel.append(el('option', {value: v, selected: S.filter === v ? '' : null}, l));
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
      s.match && s.match.temporary ? el('span', {class: 'chip'}, 'temporary') : st === 'ambiguous' ? el('span', {class: 'chip warn'}, `${s.match.osm.length} candidates`) : st === 'moved' ? el('span', {class: 'chip warn'}, `moved ${s.match.osm[0].dist} m?`) : st === 'missing' ? el('span', {class: 'chip bad'}, 'not in OSM') : diffs.length ? el('span', {class: 'chip'}, diffs.join(', ')) : null));
  }
}
function showStop(id) {
  S.stop = id; S.tab = 'stops';
  render(); draw();
  const s = D.stops[id], o = matchedOsm(s);
  map.flyTo({center: o ? [o.lon, o.lat] : [s.lon, s.lat], zoom: Math.max(map.getZoom(), 17), duration: 500});
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
    s.wheelchair && s.wheelchair !== '0' ? el('span', {class: 'k'}, 'wheelchair') : null, s.wheelchair && s.wheelchair !== '0' ? el('span', {}, {1: 'yes', 2: 'no'}[s.wheelchair]) : null,
    s.platform_code ? el('span', {class: 'k'}, 'platform') : null, s.platform_code ? el('span', {}, s.platform_code) : null));
  if (s.match && s.match.notes && s.match.notes.length) d.append(el('div', {class: 'note warn'}, ...s.match.notes.map(n => el('div', {}, n))));
  const place = Station.ofStop(s);
  if (place) d.append(el('div', {class: 'note'}, `A bay at ${place.stations[0].tags.name || 'a station'}. `, el('button', {class: 'b tiny', onclick: () => Station.open(place.id)}, 'The station: how it\'s mapped')));
  const existing = Object.keys(Edits.ops).find(k => Edits.ops[k].kind === 'create' && Edits.ops[k].tags['gtfs:stop_id'] === s.id);

  if (st === 'missing') {
    d.append(el('h2', {style: 'margin-left:0'}, 'Not in OSM'));
    d.append(el('div', {class: 'small'}, 'No bus stop within 60 m of the agency\'s position, and none on the same street further off. The position is the agency\'s: drop the node, then drag it onto the sign in RapiD or here.'));
    d.append(el('div', {class: 'btns'},
      existing ? el('span', {class: 'chip edit'}, 'added to changes') : el('button', {class: 'b primary', onclick: () => placeNewStop(s)}, 'Add stop here → changes'),
      editorButtons({lon: s.lon, lat: s.lat, zoom: 19, select: [], comment: `Bus stop ${s.ref} ${s.name}`}, {primaryLabel: 'Look in RapiD'})));
    d.append(el('details', {class: 'small'}, el('summary', {}, 'Tags it would get'), el('div', {class: 'kv'}, ...Object.entries(s.proposed_tags).flatMap(([k, v]) => [el('span', {class: 'k'}, k), el('span', {}, v)]))));
  } else if (st === 'moved') {
    const c = s.match.osm[0], oo = D.osm_stops[c.id];
    d.append(el('h2', {style: 'margin-left:0'}, 'Probably moved'));
    d.append(el('div', {class: 'small'}, `Nothing within 60 m, but OSM has `, el('b', {}, oo.tags.name || oo.id), ` ${c.dist} m away on the same street${oo.tags.ref === s.ref ? ' with the same code' : ''}. Most likely the stop moved and OSM still has the old spot.`));
    d.append(el('div', {class: 'btns'},
      el('button', {class: 'b primary', onclick: () => { Edits.decisions[s.id] = oo.id; Edits.modify('node', osmNumId(oo), nodeBase(oo), {lat: s.lat, lon: s.lon, tags: identityTags(s)}, `${s.ref} ${s.name}: moved ${c.dist} m`); toast('Node move added to changes'); render(); draw(); }}, `Move that node here (${c.dist} m)`),
      el('button', {class: 'b', onclick: () => { Edits.decisions[s.id] = oo.id; Edits.save(); toast('Treated as the same stop, position kept'); render(); draw(); }}, 'Same stop, keep OSM\'s position'),
      el('button', {class: 'b', onclick: () => placeNewStop(s)}, 'Different stop — add new')));
    d.append(osmStopBox(s, oo, c, false));
    for (const c2 of s.match.osm.slice(1)) d.append(osmStopBox(s, D.osm_stops[c2.id], c2, false));
  } else {
    d.append(el('h2', {style: 'margin-left:0'}, st === 'ambiguous' ? 'Which is it?' : 'OSM stop'));
    if (st === 'ambiguous') d.append(el('div', {class: 'small muted'}, 'Several OSM stops fit. Pick one, or say none does.'));
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
  box.append(el('div', {}, el('b', {}, o.tags.name || '(no name)'), ' ', el('a', {href: osmLink(o.id), target: '_blank'}, o.id), el('span', {class: 'muted'}, ` · ${Math.round(m(osmPos(o), [s.lon, s.lat]))} m from the agency's point · by ${c.how} · v${o.version} ${(o.timestamp || '').slice(0, 10)} ${o.user}`), op ? el('span', {class: 'chip edit', style: 'margin-left:6px'}, 'edited') : null));
  box.append(el('div', {class: 'muted mono'}, Object.entries(o.tags).map(([k, v]) => `${k}=${v}`).join('  ')));
  const base = (Edits.decisions[s.id] || (s.match && s.match.status === 'matched' && s.match.osm[0] && s.match.osm[0].id === o.id)) ? (s.match.diff || {}) : null;
  const diff = base && {...base};
  // The review only calls a position different past FAR (closer is the same stop placed by two hands), but
  // moving it to the agency's point is always on offer, as long as there's a distance to speak of.
  // Measured from where the stop is now: moved in Changes (by hand, say), or as OSM has it.
  const cur = osmPos(o), d = m(cur, [s.lon, s.lat]), placed = cur[0] !== o.lon || cur[1] !== o.lat;
  if (diff) delete diff.position;
  if (diff && d >= 2) diff.position = {gtfs: `${Math.round(d)} m ${compass(cur, [s.lon, s.lat])} of the OSM stop${placed ? ' as you placed it' : ''}`, osm: 'kept', near: d <= FAR()};
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
        el('span', {class: 'o'}, k === 'position' ? (v.near ? 'close enough to be the same spot' : 'on the sign, probably') : (v.osm || '—')));
    }
    box.append(g);
    if (diff.tagging) box.append(el('div', {class: 'muted'}, `tagging: OSM has ${diff.tagging.osm}; PTv2 wants ${diff.tagging.gtfs}`));
    box.append(el('div', {class: 'btns'}, el('button', {class: 'b primary tiny', onclick: () => {
      const tags = {}; let move = false;
      for (const [k, cb] of Object.entries(checks)) { if (!cb.checked) continue; if (k === 'position') move = true; else tags[k] = diff[k].gtfs; }
      if (diff.tagging && (o.tags.highway !== 'bus_stop' || o.tags.public_transport !== 'platform')) Object.assign(tags, {highway: 'bus_stop', public_transport: 'platform', bus: 'yes'});
      if (!s.proposed_tags['gtfs:stop_id'] || true) tags['gtfs:stop_id'] = s.id;
      Edits.modify('node', osmNumId(o), nodeBase(o), {tags, ...(move ? {lat: s.lat, lon: s.lon} : {})}, `${s.ref} ${s.name}`);
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
  const key = Edits.createNode(s.lat, s.lon, s.proposed_tags, `${s.ref} ${s.name}: new stop`);
  const mk = new maplibregl.Marker({draggable: true, color: css('--edit')}).setLngLat([s.lon, s.lat]).addTo(map);
  mk.on('dragend', () => { const ll = mk.getLngLat(); const op = Edits.get(key); if (op) { op.lat = ll.lat; op.lon = ll.lng; Edits.save(); } });
  S.placing = mk;
  toast('Node added at the agency\'s position. Drag the marker onto the sign (imagery), then it\'s in Changes.', 6000);
  render(); draw();
}

// ---------- OSM-only stops ----------
function renderExtra(P) {
  P.append(el('div', {class: 'hint'}, `${D.extra_stops.length} bus stops in OSM within 400 m of this network that no feed stop claims: another operator's, moved, or gone. Nothing here is deleted by flagstop; look, and decide in RapiD.`));
  const nearestGtfs = o => { let b = null, bd = 1e9; for (const s of Object.values(D.stops)) { const d = m([o.lon, o.lat], [s.lon, s.lat]); if (d < bd) { bd = d; b = s; } } return [b, bd]; };
  const rows = D.extra_stops.map(id => D.osm_stops[id]).filter(Boolean).map(o => ({o, ng: nearestGtfs(o)})).sort((a, b) => a.ng[1] - b.ng[1]);
  for (const {o, ng} of rows) {
    P.append(el('div', {class: 'row', onclick: () => { map.flyTo({center: [o.lon, o.lat], zoom: 17}); popupOsm(o.id, [o.lon, o.lat]); }},
      el('span', {class: 'dotc extra'}),
      el('div', {class: 'grow'}, el('div', {class: 't'}, o.tags.name || '(no name)'), el('div', {class: 's'}, [o.tags.ref ? 'ref ' + o.tags.ref : null, o.tags.operator || o.tags.network, o.tags.route_ref ? 'routes ' + o.tags.route_ref : null, `${Math.round(ng[1])} m from ${ng[0].name}`].filter(Boolean).join(' · '))),
      el('span', {class: 'muted small'}, `v${o.version}`)));
  }
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
  const rels = ops.filter(o => o.type === 'relation' && !String(o.note || '').startsWith('master:') && !isRoad(o) && o.tags.public_transport !== 'stop_area');
  for (const o of rels) {
    const r = o.route || (o.kind === 'delete' ? (String(o.note || '').match(/route (\S+)/) || [])[1] : (routeOf(patternById(o.note) || {}) || {}).short);
    if (r) routes.add(r);
  }
  const dropped = rels.filter(o => o.kind === 'delete').length, kept = rels.filter(o => o.kind === 'modify'), made = rels.filter(o => o.kind === 'create');
  if (dropped && kept.length) parts.push(`merged ${n(dropped + kept.length, 'relation')} into ${kept.length === 1 ? 'one' : kept.length}`);
  else if (dropped) parts.push(`removed ${n(dropped, 'duplicate relation')}`);
  const rebuilt = kept.filter(o => Edits.diff(o).some(x => x.k === 'members')).length;
  if (kept.some(o => Edits.diff(o).some(x => x.k === 'opening_hours'))) parts.push('timetable hours added');
  if (rebuilt && !dropped) parts.push(`${n(rebuilt, 'relation')} rebuilt from the timetable`);
  if (made.length) parts.push(`${n(made.length, 'relation')} added`);
  // stops
  const nodes = ops.filter(o => o.type === 'node' && !isRoad(o) && !/stop position|second station|same station as|: station$/.test(o.note || ''));
  for (const o of nodes) if (o.route) routes.add(o.route);
  const added = nodes.filter(o => o.kind === 'create').length, moved = nodes.filter(o => o.kind === 'modify' && Edits.diff(o).some(x => x.k === 'position')).length;
  const tagged = nodes.filter(o => o.kind === 'modify' && Edits.diff(o).some(x => x.k !== 'position') && !Edits.diff(o).every(x => x.after == null));
  const removed = nodes.filter(o => o.kind === 'delete' || (o.kind === 'modify' && !Edits.diff(o).some(x => x.k === 'position') && Edits.diff(o).every(x => x.after == null))).length;
  const stopBits = [moved ? `${n(moved, 'stop')} moved` : null, added ? `${added} added` : null, removed ? `${removed} removed` : null].filter(Boolean);
  if (stopBits.length) parts.push(stopBits.join(', ').replace(/^(\d+) (added|removed)$/, (_, k, w) => `${n(+k, 'stop')} ${w}`));
  if (tagged.length) {
    const keys = new Set(tagged.flatMap(o => Edits.diff(o).map(x => x.k)));
    const what = [['ref', 'codes'], ['gtfs:stop_id', 'ids'], ['route_ref', 'routes'], ['name', 'names'], ['description', 'announcements'], ['network', 'network names']].filter(([k]) => keys.has(k)).map(([, w]) => w);
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
  let last = null; try { last = JSON.parse(localStorage.getItem('flagstop.lastUpload') || 'null'); } catch (e) {}
  if (last) d.append(el('div', {class: 'note'}, el('b', {}, 'Last upload: '),
    el('a', {href: `https://www.openstreetmap.org/changeset/${last.id}`, target: '_blank'}, `changeset ${last.id}`),
    ` · ${last.n} change${last.n === 1 ? '' : 's'} · ${new Date(last.at).toLocaleString()}`, el('div', {class: 'muted'}, `"${last.comment}"`),
    (last.skipped || []).length ? el('div', {style: 'color:var(--miss)'}, `OSM did not delete ${last.skipped.join(', ')}: something still uses ${last.skipped.length > 1 ? 'them' : 'it'} (a route_master, another relation, a way). Still in Changes: remove the parent's reference, then upload again.`) : null,
    ...(last.undid || []).map(u => revertNote(u, last.id)),
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
      btns.append(el('button', {class: 'b primary', onclick: async () => {
        if (!confirm(`Upload ${ops.length} change${ops.length > 1 ? 's' : ''} to OpenStreetMap as ${user.display_name}?`)) return;
        try {
          const n = ops.length;
          const {id, skipped, undid} = await Edits.upload(comment.value, `${D.agency.agency_name} GTFS`, s => status.textContent = s);
          // remembered, so the changeset stays findable after the page redraws or reloads
          // remembered with what goes with it (records for undone edits, deletes OSM skipped), so it all
          // survives the redraw that follows, and a reload
          try { localStorage.setItem('flagstop.lastUpload', JSON.stringify({id, comment: comment.value, n, at: new Date().toISOString(), undid: undid || [], skipped})); } catch (e) {}
          S.comment = null;
          toast(`Uploaded: changeset ${id}`, 6000);
          render();
        } catch (e) {
          status.textContent = '';
          if (e.conflicts) { status.append(el('div', {style: 'color:var(--miss)'}, 'Not uploaded — these changed on OSM since flagstop looked:'), el('ul', {}, ...e.conflicts.map(c => el('li', {}, `${c.key}: ${c.why}`))), el('div', {}, 'Remove those lines or refresh the OSM data (tool/review.py --refresh) and decide again.')); }
          else if (e.signedOut) { Edits.auth.lost = true; render(); }   // shows why, and the sign-in button
          else status.textContent = 'Upload failed: ' + e.message;
        }
      }}, `Upload to OSM as ${user.display_name}`));
      btns.append(el('button', {class: 'b', onclick: () => { Edits.auth.signOut(); render(); }}, 'sign out'));
    } else {
      btns.append(el('button', {class: 'b primary', onclick: () => { Edits.auth.lost = false; Edits.auth.signIn().catch(e => toast(e.message)); }}, 'Sign in to OSM to upload'));
    }
    btns.append(el('button', {class: 'b', onclick: () => download('flagstop.osc', Edits.osc(), 'application/xml')}, 'Download .osc (JOSM)'));
    btns.append(el('button', {class: 'b', onclick: () => { navigator.clipboard.writeText(Edits.level0()).then(() => toast('Level0 text copied — paste at level0.osmz.ru')); }}, 'Copy Level0 text'));

    d.append(btns, status);
  }
  // OAuth setup
  const cid = Edits.auth.clientId();
  d.append(el('details', {class: 'small', open: ((!cid || Edits.auth.lost) && ops.length) ? '' : null}, el('summary', {}, user ? `Signed in as ${user.display_name}` : 'Set up upload (once)'),
    el('p', {}, 'Uploading uses OSM\'s own login (OAuth 2). Register flagstop as an application on your account: ', el('a', {href: 'https://www.openstreetmap.org/oauth2/applications/new', target: '_blank'}, 'osm.org → OAuth 2 applications → Register'), '. Name: flagstop. Redirect URI: ', el('code', {}, Edits.auth.redirect()), '. Untick "Confidential application". Permissions: read user preferences, modify the map. Paste the client ID here:'),
    el('div', {class: 'btns'}, el('input', {value: cid, placeholder: 'client id', style: 'flex:1', onchange: e => { Edits.auth.setClientId(e.target.value); toast('saved'); }}))));
  P.append(d);
}
function download(name, text, type) {
  const a = el('a', {href: URL.createObjectURL(new Blob([text], {type})), download: name}); document.body.append(a); a.click(); a.remove();
}

function renderAbout(P) {
  const f = D.feed;
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
  if (S.tab !== 'routes' || again) { S.pattern = null; S.review = null; S.fix = null; S.merge = null; S.div = null; S.vias = []; S.routed = null; S.routedBy = null; S.viaMode = false; }
  if (S.tab !== 'stops' || again) S.stop = null;
  document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove());
  render(); draw();
  $('#panel').scrollTop = 0; $('#side').scrollTop = 0;   // a list starts at its top
});
fetch('data/review.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(async d => {
  D = d;
  Edits.load(d.agency.agency_name);
  Edits.listeners.push(() => { const b = $('#tabs button[data-tab=changes]'); if (b) b.textContent = Edits.count() ? `Changes (${Edits.count()})` : 'Changes'; undoBar(); Roads.undoCtl(); if (Roads.on && !Roads.drag && !Roads.pick && !Roads.loading) Roads.status(); });
  undoBar();
  $('#agency').textContent = `${d.agency.agency_name} · feed ${(d.feed.feed_version || '').slice(0, 40)} · OSM ${d.osm_fetched.replace('T', ' ')} `;
  $('#agency').append(el('a', {href: '#', title: 'Fetch OSM again and rebuild the review: after an upload, to see it', onclick: e => { e.preventDefault(); refreshOSM(); }}, 'refresh'));
  try { if (await Edits.auth.complete()) { S.tab = 'changes'; toast('Signed in to OSM'); } } catch (e) { toast('Sign-in failed: ' + e.message, 8000); }
  render();
  try { initMap(); } catch (e) { toast('Map failed to start: ' + e.message, 8000); console.error(e); }
}).catch(e => { $('#agency').textContent = 'no data/review.json — run tool/review.py'; console.error(e); });

window.addEventListener('hashchange', () => { if (D && map) applyHash(); });
