/* flagstop — review a GTFS feed against OpenStreetMap. Reads data/review.json (from tool/review.py);
   talks to JOSM's remote control on 127.0.0.1:8111 and, when tool/serve.py is running, re-routes
   a pattern through via points via /api/trace. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmtPct = x => x == null ? '—' : Math.round(x * 100) + '%';
const m = (a, b) => Math.hypot((b[1] - a[1]) * 110540, (b[0] - a[0]) * 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180));

let D, map, S = {tab: 'routes', pattern: null, stop: null, vias: [], routed: null, filter: 'all', q: '', hoverStop: null};

function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- JOSM remote control / iD links ----------
const JOSM = 'http://127.0.0.1:8111/';
async function josm(cmd, params) {
  const u = JOSM + cmd + '?' + new URLSearchParams(params).toString();
  try { await fetch(u, {mode: 'no-cors'}); toast('Sent to JOSM: ' + cmd); }
  catch (e) { toast('JOSM not reachable — is it running with remote control on?', 4000); }
}
const bboxOf = pts => {
  let l = 180, r = -180, b = 90, t = -90;
  for (const [x, y] of pts) { l = Math.min(l, x); r = Math.max(r, x); b = Math.min(b, y); t = Math.max(t, y); }
  return {left: l - 0.0015, right: r + 0.0015, bottom: b - 0.001, top: t + 0.001};
};
const josmZoom = (pts, select = []) => josm('load_and_zoom', {...bboxOf(pts), select: select.join(',')});
const idLink = (lon, lat, obj) => `https://www.openstreetmap.org/edit?editor=id${obj ? '&' + obj.replace(/^n/, 'node=').replace(/^w/, 'way=').replace(/^r/, 'relation=') : ''}#map=19/${lat.toFixed(5)}/${lon.toFixed(5)}`;
const osmLink = id => `https://www.openstreetmap.org/${id[0] === 'n' ? 'node' : id[0] === 'w' ? 'way' : 'relation'}/${id.slice(1)}`;
const tagStr = t => Object.entries(t).map(([k, v]) => `${k}=${v}`).join('|');

// ---------- data helpers ----------
const routeOf = p => D.routes.find(r => r.id === p.route_id);
const patternById = id => D.patterns.find(p => p.id === id);
const stopStatus = s => s.match ? s.match.status : 'missing';
const matchedOsm = s => (s.match && s.match.status === 'matched' && s.match.osm[0]) ? D.osm_stops[s.match.osm[0].id] : null;
function patternGrade(p) {
  const rels = p.relations;
  if (!rels.length) return {chip: 'no relation', cls: 'bad', order: 0};
  if (rels.some(r => r.duplicate)) return {chip: `${rels.length} relations`, cls: 'warn', order: 1};
  const r = rels[0];
  const n = r.stops.missing.length + r.stops.extra.length + r.ways.off_shape.length + (r.stops.out_of_order ? 1 : 0);
  if (n) return {chip: 'needs work', cls: 'warn', order: 2};
  if (r.tag_issues.length) return {chip: 'tags', cls: 'info', order: 3};
  return {chip: 'ok', cls: 'good', order: 4};
}
const routedOf = p => (S.pattern === p.id && S.routed) ? S.routed : p.routed;

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
    const src = id => map.addSource(id, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    ['rel', 'shape', 'routed', 'div', 'divpath', 'stops', 'osmstops', 'vias', 'leg'].forEach(src);
    map.addLayer({id: 'rel', type: 'line', source: 'rel', paint: {'line-color': css('--rel'), 'line-width': 7, 'line-opacity': 0.35}});
    map.addLayer({id: 'routed', type: 'line', source: 'routed', paint: {'line-color': css('--routed'), 'line-width': 4}});
    map.addLayer({id: 'shape', type: 'line', source: 'shape', paint: {'line-color': css('--shape'), 'line-width': 2, 'line-dasharray': [2, 2]}});
    map.addLayer({id: 'leg', type: 'line', source: 'leg', paint: {'line-color': css('--accent'), 'line-width': 8, 'line-opacity': 0.3}});
    map.addLayer({id: 'divpath', type: 'line', source: 'divpath', paint: {'line-color': css('--div'), 'line-width': 5, 'line-opacity': 0.6}});
    map.addLayer({id: 'div', type: 'circle', source: 'div', paint: {'circle-radius': 11, 'circle-color': css('--div'), 'circle-opacity': 0.25, 'circle-stroke-color': css('--div'), 'circle-stroke-width': 2}});
    map.addLayer({id: 'osmstops', type: 'circle', source: 'osmstops', paint: {'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': css('--extra'), 'circle-stroke-width': 1.5}});
    map.addLayer({id: 'stops', type: 'circle', source: 'stops', paint: {'circle-radius': ['case', ['get', 'on'], 7, 5], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5}});
    map.addLayer({id: 'stoplabels', type: 'symbol', source: 'stops', minzoom: 15, layout: {'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Open Sans Semibold']},
      paint: {'text-color': css('--ink'), 'text-halo-color': css('--panel'), 'text-halo-width': 1.5}});
    map.addLayer({id: 'vias', type: 'circle', source: 'vias', paint: {'circle-radius': 6, 'circle-color': css('--div'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
    for (const layer of ['stops', 'osmstops', 'div']) {
      map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', layer, () => map.getCanvas().style.cursor = S.viaMode ? 'crosshair' : '');
    }
    map.on('click', 'stops', e => { e.preventDefault(); showStop(e.features[0].properties.id); });
    map.on('click', 'osmstops', e => { e.preventDefault(); popupOsm(e.features[0].properties.id, e.lngLat); });
    map.on('click', 'div', e => { e.preventDefault(); popupDiv(JSON.parse(e.features[0].properties.d), e.lngLat); });
    map.on('click', e => { if (S.viaMode && !e.defaultPrevented) addVia([e.lngLat.lng, e.lngLat.lat]); });
    draw();
  });
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fc = feats => ({type: 'FeatureCollection', features: feats});
const line = (coords, props = {}) => ({type: 'Feature', geometry: {type: 'LineString', coordinates: coords}, properties: props});
const point = (c, props = {}) => ({type: 'Feature', geometry: {type: 'Point', coordinates: c}, properties: props});
const set = (id, feats) => map.getSource(id) && map.getSource(id).setData(fc(feats));

function stopColor(s) { return css({matched: '--ok', ambiguous: '--amb', missing: '--miss'}[stopStatus(s)] || '--miss'); }

function draw() {
  if (!map || !map.getSource('stops')) return;
  const p = S.pattern && patternById(S.pattern);
  if (p) {
    const r = routedOf(p);
    set('shape', p.shape.length ? [line(p.shape)] : []);
    set('routed', r.geometry.length ? [line(r.geometry)] : []);
    set('rel', p.relations.flatMap(a => a.geometry.map(g => line(g, {id: a.id}))));
    set('div', r.divergences.map(d => point([d.lon, d.lat], {d: JSON.stringify({...d, shape: undefined, path: undefined})})));
    set('divpath', r.divergences.flatMap(d => [d.shape && d.shape.length > 1 ? line(d.shape) : null, d.path && d.path.length > 1 ? line(d.path) : null].filter(Boolean)));
    set('stops', p.stops.map((id, i) => { const s = D.stops[id]; return point([s.lon, s.lat], {id, color: stopColor(s), label: `${i + 1} · ${s.name}`, on: S.stop === id}); }));
    const inP = new Set(p.stops.map(id => matchedOsm(D.stops[id])).filter(Boolean).map(o => o.id));
    set('osmstops', Object.values(D.osm_stops).filter(o => !inP.has(o.id) && o.tags.public_transport !== 'stop_position').map(o => point([o.lon, o.lat], {id: o.id})));
    set('vias', S.vias.map(v => point(v)));
  } else {
    set('shape', []); set('routed', []); set('rel', []); set('div', []); set('divpath', []); set('vias', []); set('leg', []);
    const stops = Object.values(D.stops).filter(stopFilter);
    set('stops', stops.map(s => point([s.lon, s.lat], {id: s.id, color: stopColor(s), label: s.name, on: S.stop === s.id})));
    const claimed = new Set(Object.values(D.stops).map(s => matchedOsm(s)).filter(Boolean).map(o => o.id));
    set('osmstops', (S.tab === 'extra' ? D.extra_stops.map(id => D.osm_stops[id]) : Object.values(D.osm_stops).filter(o => !claimed.has(o.id))).filter(o => o.tags.public_transport !== 'stop_position').map(o => point([o.lon, o.lat], {id: o.id})));
  }
}

function fit(pts, pad = 60) {
  if (!pts.length) return;
  const b = bboxOf(pts);
  map.fitBounds([[b.left, b.bottom], [b.right, b.top]], {padding: {top: pad, bottom: pad, left: pad, right: pad}, duration: 500, maxZoom: 17});
}

// ---------- popups ----------
function popupOsm(id, ll) {
  const o = D.osm_stops[id];
  const t = o.tags;
  const html = `<b>${esc(t.name || '(no name)')}</b><br><span style="color:#666">${esc(id)} · ${esc(Object.entries(t).filter(([k]) => ['ref', 'route_ref', 'highway', 'public_transport', 'operator', 'network'].includes(k)).map(([k, v]) => k + '=' + v).join(' · '))}</span><br>
    <a href="${osmLink(id)}" target="_blank">osm.org</a> · <a href="${idLink(o.lon, o.lat, id)}" target="_blank">iD</a> · <a href="#" data-josm="${id}">JOSM</a>`;
  const pop = new maplibregl.Popup({closeButton: false}).setLngLat(ll).setHTML(html).addTo(map);
  pop.getElement().querySelector('[data-josm]').onclick = e => { e.preventDefault(); josmZoom([[o.lon, o.lat]], [id.replace(/^n/, 'node')]); };
}
function popupDiv(d, ll) {
  const html = `<b>${esc(d.kind)}</b> · ${d.length} m${d.max ? ` (up to ${d.max} m off)` : ''}<br>${esc(d.why)}<br>` +
    (d.ways.length ? `ways: ${d.ways.map(w => `<a href="https://www.openstreetmap.org/way/${w}" target="_blank">${w}</a>`).join(', ')}<br>` : '') +
    `<a href="#" data-josm>open in JOSM</a> · <a href="${idLink(d.lon, d.lat)}" target="_blank">iD</a>`;
  const pop = new maplibregl.Popup({closeButton: false}).setLngLat(ll).setHTML(html).addTo(map);
  pop.getElement().querySelector('[data-josm]').onclick = e => { e.preventDefault(); josmZoom(d.shape && d.shape.length ? d.shape : [[d.lon, d.lat]], d.ways.map(w => 'way' + w)); };
}

// ---------- re-routing through via points ----------
async function addVia(v) {
  S.vias.push(v); await retrace();
}
async function retrace() {
  const p = patternById(S.pattern);
  const q = new URLSearchParams({pattern: p.id});
  for (const v of S.vias) q.append('via', v.join(','));
  try {
    const r = await fetch('/api/trace?' + q.toString());
    if (!r.ok) throw new Error((await r.json()).error || r.status);
    S.routed = await r.json();
    toast(`Re-routed through ${S.vias.length} via point${S.vias.length === 1 ? '' : 's'}: ${S.routed.ways.length} ways`);
  } catch (e) { toast('Re-routing needs tool/serve.py running with the feed loaded (' + e.message + ')', 5000); S.vias.pop(); }
  render(); draw();
}

// ---------- panel: routes ----------
function render() {
  const P = $('#panel'); P.innerHTML = '';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  if (S.tab === 'routes') S.pattern ? renderPattern(P, patternById(S.pattern)) : renderRoutes(P);
  else if (S.tab === 'stops') S.stop ? renderStop(P, D.stops[S.stop]) : renderStops(P);
  else if (S.tab === 'extra') renderExtra(P);
  else renderAbout(P);
}

function renderRoutes(P) {
  const s = D.summary;
  P.append(el('div', {class: 'tiles'},
    tile(D.patterns.length, 'patterns'), tile(s.patterns['no relation'] || 0, 'no OSM relation'), tile(s.patterns['duplicate relations'] || 0, 'duplicated'),
    tile(s.stops.matched || 0, 'stops matched'), tile((s.stops.ambiguous || 0), 'ambiguous'), tile(s.stops.missing || 0, 'missing in OSM')));
  P.append(el('h2', {}, 'Patterns, worst first'));
  const rows = D.patterns.map(p => ({p, g: patternGrade(p), sc: p.routed.score ? p.routed.score.shape_covered : 0}));
  rows.sort((a, b) => a.g.order - b.g.order || a.sc - b.sc || b.p.trips - a.p.trips);
  for (const {p, g, sc} of rows) {
    const r = routeOf(p);
    P.append(el('div', {class: 'row', onclick: () => selectPattern(p.id)},
      refBadge(r),
      el('div', {class: 'grow'}, el('div', {class: 't'}, p.headsign || p.direction_name || r.long || ('direction ' + p.direction)),
        el('div', {class: 's'}, `${p.stops.length} stops · ${p.trips} trips${p.variants ? ` · ${p.variants} short variants` : ''}${p.routed.divergences.length ? ` · ${p.routed.divergences.length} divergence${p.routed.divergences.length > 1 ? 's' : ''}` : ''}`)),
      el('span', {class: 'pct', title: 'share of the agency line a bus can follow on OSM roads'}, fmtPct(sc)),
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
const tile = (n, label) => el('div', {class: 'tile'}, el('b', {}, n), el('span', {}, label));
const refBadge = r => el('span', {class: 'ref', style: r.color ? `background:#${r.color};color:#${r.text_color || '000'}` : ''}, r.short);

function selectPattern(id) {
  S.pattern = id; S.stop = null; S.vias = []; S.routed = null; S.viaMode = false; S.tab = 'routes';
  render(); draw();
  const p = patternById(id);
  fit(p.shape.length ? p.shape : p.stops.map(s => [D.stops[s].lon, D.stops[s].lat]));
}

function renderPattern(P, p) {
  const r = routeOf(p), rt = routedOf(p);
  P.append(el('button', {class: 'back', onclick: () => { S.pattern = null; S.vias = []; S.routed = null; render(); draw(); }}, '← all patterns'));
  const d = el('div', {class: 'detail'});
  d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, p.headsign || p.direction_name || r.long), el('span', {class: 'muted small'}, `shape ${p.shape_id}`)));
  d.append(el('div', {class: 'muted small'}, `${r.long}${r.desc ? ' — ' + r.desc : ''} · direction ${p.direction} · ${p.stops.length} stops · ${p.trips} trips`));
  const sc = rt.score || {};
  d.append(el('div', {class: 'kv'},
    el('span', {class: 'k'}, 'line on OSM roads'), el('span', {}, `${fmtPct(sc.shape_covered)} of the agency's line can be driven on OSM as mapped; ${fmtPct(sc.path_on_shape)} of the drivable path stays on the line`),
    el('span', {class: 'k'}, 'routed'), el('span', {}, `${rt.ways.length} ways, ${rt.legs.filter(l => l.ok).length}/${rt.legs.length} legs connected`)));

  const btns = el('div', {class: 'btns'});
  btns.append(el('button', {class: 'b primary', onclick: () => loadRelationInJosm(p)}, p.relations.length ? 'Load proposed relation in JOSM' : 'Create relation in JOSM'));
  btns.append(el('button', {class: 'b', onclick: () => josmZoom(p.shape.length ? p.shape : rt.geometry, p.relations.map(a => 'relation' + a.id))}, 'Open area in JOSM'));
  btns.append(el('button', {class: 'b' + (S.viaMode ? ' on' : ''), onclick: () => { S.viaMode = !S.viaMode; map.getCanvas().style.cursor = S.viaMode ? 'crosshair' : ''; render(); }}, S.viaMode ? 'Click the map to add a via point…' : 'Re-route via a point'));
  if (S.vias.length) btns.append(el('button', {class: 'b', onclick: () => { S.vias = []; S.routed = null; render(); draw(); }}, `Clear ${S.vias.length} via`));
  btns.append(el('a', {href: `data/rel-${p.id.replace(/[^A-Za-z0-9]/g, '_')}.osm`, download: '', class: 'small', style: 'align-self:center'}, '.osm file'));
  d.append(btns);

  if (rt.divergences.length) {
    d.append(el('h2', {style: 'margin-left:0'}, `Where the map and the line disagree (${rt.divergences.length})`));
    const ul = el('ul', {class: 'plain'});
    for (const dv of rt.divergences) {
      ul.append(el('li', {class: 'item click', onclick: () => { fit(dv.shape && dv.shape.length ? dv.shape : [[dv.lon, dv.lat]], 120); popupDiv(dv, [dv.lon, dv.lat]); }},
        el('div', {}, el('b', {}, dv.kind === 'no-path' ? 'no path' : dv.kind === 'uncovered' ? 'line not followed' : 'detour'), ` · ${dv.length} m`, dv.max ? el('span', {class: 'muted'}, ` · up to ${dv.max} m off`) : null,
          dv.leg != null ? el('span', {class: 'muted'}, ` · after stop ${dv.leg + 1}`) : null),
        el('div', {class: 'why'}, dv.why)));
    }
    d.append(ul);
  }

  d.append(el('h2', {style: 'margin-left:0'}, p.relations.length ? `OSM relation${p.relations.length > 1 ? 's' : ''}` : 'OSM relation'));
  if (!p.relations.length) d.append(el('div', {class: 'small'}, 'Nothing in OSM covers this pattern. The proposed relation above has the matched platforms in order and the routed ways; open it in JOSM, run the validator, and upload.'));
  for (const a of p.relations) d.append(renderAudit(a, p));
  if (!p.relations.length || p.relations.length) {
    d.append(el('details', {class: 'small'}, el('summary', {}, 'Proposed relation tags'), el('div', {class: 'kv'}, ...Object.entries(p.proposed_tags).flatMap(([k, v]) => [el('span', {class: 'k'}, k), el('span', {}, v)]))));
  }
  if (r.masters.length === 0) d.append(el('div', {class: 'small muted', style: 'margin-top:6px'}, `No route_master for route ${r.short} in OSM; one should hold all its directions (tags: ${Object.entries(r.proposed_master_tags).map(([k, v]) => k + '=' + v).join(', ')}).`));

  d.append(el('h2', {style: 'margin-left:0'}, 'Stops in order'));
  const ul = el('ul', {class: 'plain stoplist'});
  p.stops.forEach((id, i) => {
    const s = D.stops[id], st = stopStatus(s), o = matchedOsm(s);
    const leg = rt.legs[i - 1];
    ul.append(el('li', {class: 'item click', onclick: () => showStop(id), onmouseenter: () => { const lg = rt.legs[i]; set('leg', lg && lg.ok && i < rt.legs.length ? [line(legGeom(rt, i))] : []); }, onmouseleave: () => set('leg', [])},
      el('span', {class: 'n'}, i + 1), el('span', {class: 'dotc ' + ({matched: 'ok', ambiguous: 'amb', missing: 'miss'}[st])}),
      el('span', {class: 'grow'}, s.name, s.desc ? el('span', {class: 'd'}, ' · ' + s.desc) : null, o && o.tags.name && o.tags.name !== s.name ? el('span', {class: 'd', style: 'color:var(--rel)'}, ` · OSM: ${o.tags.name}`) : null),
      leg && !leg.ok ? el('span', {class: 'chip bad', title: leg.why}, 'gap before') : null));
  });
  d.append(ul);
  P.append(d);
}
function legGeom(rt, i) {
  // routed geometry isn't split per leg in the JSON; approximate by the stops' projections. Cheap: highlight from stop i to i+1 along the path.
  const p = patternById(S.pattern), a = D.stops[p.stops[i]], b = D.stops[p.stops[i + 1]];
  const g = rt.geometry; if (!g.length) return [];
  const near = q => { let bi = 0, bd = 1e9; g.forEach((c, k) => { const d = m(c, [q.lon, q.lat]); if (d < bd) { bd = d; bi = k; } }); return bi; };
  let ia = near(a), ib = near(b); if (ib < ia) [ia, ib] = [ib, ia];
  return g.slice(ia, ib + 1);
}

function renderAudit(a, p) {
  const box = el('div', {class: 'small', style: 'border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0'});
  box.append(el('div', {}, el('b', {}, a.name || `relation ${a.id}`), ' ', el('a', {href: 'https://www.openstreetmap.org/relation/' + a.id, target: '_blank'}, `r${a.id}`),
    el('span', {class: 'muted'}, ` · v${a.version} by ${a.user} · ${(a.timestamp || '').slice(0, 10)}`),
    a.duplicate ? el('span', {class: 'chip warn', style: 'margin-left:6px'}, 'duplicate') : null));
  box.append(el('div', {class: 'muted'}, `covers ${fmtPct(a.cover.shape_covered)} of the line; ${fmtPct(a.cover.ways_on_shape)} of its ways are on it · ${a.ways.in_relation} ways · ${a.stops.in_relation} stop members`));
  const issues = [];
  if (a.duplicate) issues.push(el('li', {}, 'Another relation covers this same pattern — OSM has one relation per itinerary, not per service day; merge them and keep the older id.'));
  if (a.stops.missing.length) issues.push(el('li', {}, `${a.stops.missing.length} matched platforms are not members: `, ...a.stops.missing.slice(0, 8).flatMap(x => [el('a', {href: '#', onclick: e => { e.preventDefault(); showStop(x.stop); }}, `#${x.i + 1}`), ' ']), a.stops.missing.length > 8 ? '…' : ''));
  if (a.stops.extra.length) issues.push(el('li', {}, `${a.stops.extra.length} platform members are not on this pattern`, p.direction !== '' && D.patterns.some(q => q.route_id === p.route_id && q.id !== p.id) ? ' (the other direction, probably: PTv2 wants one relation per direction)' : '', ': ',
    ...a.stops.extra.slice(0, 6).flatMap(id => [el('a', {href: osmLink(id), target: '_blank'}, id), ' ']), a.stops.extra.length > 6 ? '…' : ''));
  if (a.stops.out_of_order) issues.push(el('li', {}, `platform members are out of order in ${a.stops.out_of_order} place${a.stops.out_of_order > 1 ? 's' : ''}`));
  if (a.stops.unmatched.length) issues.push(el('li', {}, `${a.stops.unmatched.length} GTFS stops have no matched OSM platform yet (see Stops)`));
  if (a.ways.off_shape.length) issues.push(el('li', {}, `${a.ways.off_shape.length} member ways are off the line: `, ...a.ways.off_shape.slice(0, 8).flatMap(w => [el('a', {href: '#', title: w.name, onclick: e => { e.preventDefault(); map.flyTo({center: [w.lon, w.lat], zoom: 16}); josmZoom([[w.lon, w.lat]], ['way' + w.way]); }}, `w${w.way}`), ' ']), a.ways.off_shape.length > 8 ? '…' : ''));
  if (a.ways.routed_not_in_relation.length) issues.push(el('li', {}, `${a.ways.routed_not_in_relation.length} ways the routed path uses are not members (may be fine if the relation takes a parallel way; check the map)`));
  for (const t of a.tag_issues) issues.push(el('li', {}, el('code', {}, t.key), ': ', t.osm ? el('span', {}, el('span', {style: 'color:var(--rel)'}, t.osm), ' → ') : 'add ', el('span', {style: 'color:var(--shape)'}, t.gtfs)));
  box.append(issues.length ? el('ul', {style: 'margin:6px 0 0;padding-left:18px'}, ...issues) : el('div', {style: 'color:var(--ok)'}, 'Members and tags agree with the feed.'));
  return box;
}

async function loadRelationInJosm(p) {
  const rt = routedOf(p);
  const objs = [...rt.ways.map(w => 'w' + w), ...p.stops.map(id => matchedOsm(D.stops[id])).filter(o => o && o.id[0] === 'n').map(o => o.id), ...p.relations.map(a => 'r' + a.id)];
  await josm('load_object', {objects: objs.join(','), new_layer: 'false', relation_members: 'false'});
  const url = S.vias.length ? `${location.origin}/api/relation?pattern=${encodeURIComponent(p.id)}&${S.vias.map(v => 'via=' + v.join(',')).join('&')}`
    : `${location.origin}/data/rel-${p.id.replace(/[^A-Za-z0-9]/g, '_')}.osm`;
  await josm('import', {url, new_layer: 'false'});
  toast('JOSM: the proposed relation is in the current layer as a new relation. Run the validator, compare with the existing one, upload.', 6000);
}

// ---------- panel: stops ----------
function stopFilter(s) {
  const st = stopStatus(s);
  if (S.filter === 'missing' && st !== 'missing') return false;
  if (S.filter === 'ambiguous' && st !== 'ambiguous') return false;
  if (S.filter === 'diff' && !(st === 'matched' && s.match.diff && Object.keys(s.match.diff).some(k => k !== 'gtfs:stop_id'))) return false;
  if (S.filter === 'name' && !(st === 'matched' && s.match.diff && s.match.diff.name)) return false;
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
  for (const [v, l] of [['all', 'all stops'], ['missing', 'missing in OSM'], ['ambiguous', 'ambiguous'], ['diff', 'tags differ'], ['name', 'name differs'], ['desc', 'has announcement']]) sel.append(el('option', {value: v, selected: S.filter === v ? '' : null}, l));
  f.append(sel, el('input', {placeholder: 'search name, announcement, code', value: S.q, oninput: e => { S.q = e.target.value; render(); draw(); }}));
  P.append(f);
  const list = Object.values(D.stops).filter(stopFilter).sort((a, b) => ({missing: 0, ambiguous: 1, matched: 2}[stopStatus(a)] - {missing: 0, ambiguous: 1, matched: 2}[stopStatus(b)]) || b.trips - a.trips);
  P.append(el('h2', {}, `${list.length} stops`));
  for (const s of list.slice(0, 400)) {
    const st = stopStatus(s), o = matchedOsm(s);
    const diffs = st === 'matched' && s.match.diff ? Object.keys(s.match.diff).filter(k => k !== 'gtfs:stop_id') : [];
    P.append(el('div', {class: 'row' + (S.stop === s.id ? ' on' : ''), onclick: () => showStop(s.id)},
      el('span', {class: 'dotc ' + ({matched: 'ok', ambiguous: 'amb', missing: 'miss'}[st])}),
      el('div', {class: 'grow'}, el('div', {class: 't'}, s.name), el('div', {class: 's'}, [s.ref, s.desc, o && o.tags.name && o.tags.name !== s.name ? 'OSM: ' + o.tags.name : null].filter(Boolean).join(' · '))),
      st === 'ambiguous' ? el('span', {class: 'chip warn'}, `${s.match.osm.length} candidates`) : st === 'missing' ? el('span', {class: 'chip bad'}, 'missing') : diffs.length ? el('span', {class: 'chip'}, diffs.join(', ')) : null));
  }
}
function showStop(id) {
  S.stop = id; S.tab = 'stops';
  render(); draw();
  const s = D.stops[id];
  map.flyTo({center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 17), duration: 500});
}
function renderStop(P, s) {
  P.append(el('button', {class: 'back', onclick: () => { S.stop = null; render(); draw(); }}, S.pattern ? '← back' : '← all stops'));
  if (S.pattern) $('.back', P).onclick = () => { S.stop = null; S.tab = 'routes'; render(); draw(); };
  const d = el('div', {class: 'detail'}), st = stopStatus(s);
  d.append(el('div', {class: 'head'}, el('span', {class: 'dotc ' + ({matched: 'ok', ambiguous: 'amb', missing: 'miss'}[st])}), el('h3', {}, s.name)));
  d.append(el('div', {class: 'kv'},
    el('span', {class: 'k'}, 'code'), el('span', {}, `${s.ref}${s.code && s.code !== s.id ? ` (stop_id ${s.id})` : ''}`),
    s.desc ? el('span', {class: 'k'}, 'stop_desc') : null, s.desc ? el('span', {}, s.desc) : null,
    s.tts ? el('span', {class: 'k'}, 'tts name') : null, s.tts ? el('span', {}, s.tts) : null,
    el('span', {class: 'k'}, 'routes'), el('span', {}, s.routes.map(rid => (D.routes.find(r => r.id === rid) || {short: rid}).short).join(', ') + ` · ${s.trips} trips`),
    s.wheelchair && s.wheelchair !== '0' ? el('span', {class: 'k'}, 'wheelchair') : null, s.wheelchair && s.wheelchair !== '0' ? el('span', {}, {1: 'yes', 2: 'no'}[s.wheelchair]) : null,
    s.platform_code ? el('span', {class: 'k'}, 'platform') : null, s.platform_code ? el('span', {}, s.platform_code) : null,
    s.url ? el('span', {class: 'k'}, 'url') : null, s.url ? el('a', {href: s.url, target: '_blank'}, s.url) : null));
  const btns = el('div', {class: 'btns'});
  if (st === 'missing') {
    btns.append(el('button', {class: 'b primary', onclick: () => josm('add_node', {lon: s.lon, lat: s.lat, addtags: tagStr(s.proposed_tags)})}, 'Add stop in JOSM'));
  }
  btns.append(el('button', {class: 'b', onclick: () => josmZoom([[s.lon, s.lat]], s.match ? s.match.osm.map(c => c.id.replace(/^n/, 'node').replace(/^w/, 'way')) : [])}, 'Open in JOSM'));
  btns.append(el('a', {href: idLink(s.lon, s.lat, matchedOsm(s) ? matchedOsm(s).id : null), target: '_blank', class: 'small', style: 'align-self:center'}, 'open in iD'));
  d.append(btns);
  if (s.match && s.match.notes && s.match.notes.length) d.append(el('div', {class: 'small', style: 'color:var(--amb)'}, ...s.match.notes.map(n => el('div', {}, '⚠ ' + n))));

  if (st === 'missing') {
    d.append(el('h2', {style: 'margin-left:0'}, 'Not in OSM'));
    d.append(el('div', {class: 'small'}, 'No bus stop within 60 m of the agency\'s position. Verify it on the ground or imagery before adding; the tags below are the proposal.'));
    d.append(el('div', {class: 'kv'}, ...Object.entries(s.proposed_tags).flatMap(([k, v]) => [el('span', {class: 'k'}, k), el('span', {}, v)])));
  } else {
    d.append(el('h2', {style: 'margin-left:0'}, st === 'ambiguous' ? 'Candidates — which is it?' : 'OSM stop'));
    for (const c of s.match.osm) {
      const o = D.osm_stops[c.id]; if (!o) continue;
      const box = el('div', {class: 'small', style: 'border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0'});
      box.append(el('div', {}, el('b', {}, o.tags.name || '(no name)'), ' ', el('a', {href: osmLink(o.id), target: '_blank'}, o.id), el('span', {class: 'muted'}, ` · ${c.dist} m · by ${c.how} · v${o.version} ${(o.timestamp || '').slice(0, 10)} ${o.user}`)));
      box.append(el('div', {class: 'muted', style: 'font-family:var(--mono);font-size:11px;word-break:break-all'}, Object.entries(o.tags).map(([k, v]) => `${k}=${v}`).join('  ')));
      if (st === 'matched' && s.match.diff && Object.keys(s.match.diff).length) {
        const g = el('div', {class: 'diff'}, el('span', {class: 'hd'}, ''), el('span', {class: 'hd'}, 'GTFS'), el('span', {class: 'hd'}, 'OSM'));
        for (const [k, v] of Object.entries(s.match.diff)) g.append(el('span', {class: 'k'}, k), el('span', {class: 'g'}, v.gtfs || '—'), el('span', {class: 'o'}, v.osm || '—'));
        box.append(g);
        box.append(el('div', {class: 'btns'}, el('button', {class: 'b', onclick: () => josm('load_object', {objects: o.id.replace(/^n/, 'n'), addtags: tagStr(Object.fromEntries(Object.entries(s.match.diff).filter(([k]) => k !== 'tagging' && k !== 'name').map(([k, v]) => [k, v.gtfs])))})}, 'Apply GTFS tags in JOSM (not the name)'),
          el('span', {class: 'muted', style: 'align-self:center'}, 'ref, gtfs:stop_id, route_ref, description')));
      }
      if (st === 'ambiguous') box.append(el('div', {class: 'btns'}, el('button', {class: 'b', onclick: () => josmZoom([[o.lon, o.lat]], [o.id.replace(/^n/, 'node').replace(/^w/, 'way')])}, 'This one — open in JOSM')));
      d.append(box);
    }
  }
  const nearby = Object.values(D.osm_stops).filter(o => o.tags.public_transport !== 'stop_position' && m([o.lon, o.lat], [s.lon, s.lat]) < 150 && !(s.match && s.match.osm.some(c => c.id === o.id))).sort((a, b) => m([a.lon, a.lat], [s.lon, s.lat]) - m([b.lon, b.lat], [s.lon, s.lat]));
  if (nearby.length) {
    d.append(el('h2', {style: 'margin-left:0'}, 'Other OSM stops within 150 m'));
    d.append(el('ul', {class: 'plain small'}, ...nearby.slice(0, 6).map(o => el('li', {class: 'item'}, el('a', {href: osmLink(o.id), target: '_blank'}, o.tags.name || o.id), el('span', {class: 'muted'}, ` · ${Math.round(m([o.lon, o.lat], [s.lon, s.lat]))} m · ${['ref', 'route_ref', 'operator'].filter(k => o.tags[k]).map(k => k + '=' + o.tags[k]).join(' ')}`)))));
  }
  P.append(d);
}

// ---------- panel: OSM-only stops ----------
function renderExtra(P) {
  P.append(el('div', {class: 'about'}, el('p', {}, `${D.extra_stops.length} bus stops in OSM within 400 m of this network that no GTFS stop claims: another operator's, moved, or gone. Click to look.`)));
  const nearestGtfs = o => { let b = null, bd = 1e9; for (const s of Object.values(D.stops)) { const d = m([o.lon, o.lat], [s.lon, s.lat]); if (d < bd) { bd = d; b = s; } } return [b, bd]; };
  const rows = D.extra_stops.map(id => D.osm_stops[id]).filter(Boolean).map(o => ({o, ng: nearestGtfs(o)})).sort((a, b) => a.ng[1] - b.ng[1]);
  for (const {o, ng} of rows) {
    P.append(el('div', {class: 'row', onclick: () => { map.flyTo({center: [o.lon, o.lat], zoom: 17}); popupOsm(o.id, [o.lon, o.lat]); }},
      el('span', {class: 'dotc extra'}),
      el('div', {class: 'grow'}, el('div', {class: 't'}, o.tags.name || '(no name)'), el('div', {class: 's'}, [o.tags.ref ? 'ref ' + o.tags.ref : null, o.tags.operator || o.tags.network, o.tags.route_ref ? 'routes ' + o.tags.route_ref : null, `${Math.round(ng[1])} m from ${ng[0].name}`].filter(Boolean).join(' · '))),
      el('span', {class: 'muted small'}, `v${o.version}`)));
  }
}

function renderAbout(P) {
  const f = D.feed;
  P.append(el('div', {class: 'about'},
    el('p', {}, el('b', {}, D.agency.agency_name), el('br'), `feed ${f.file} · version "${f.feed_version || '?'}" · ${f.feed_start_date || ''}–${f.feed_end_date || ''}`, el('br'), `OSM data fetched ${D.osm_fetched} · review built ${D.generated}`),
    el('p', {}, 'The ', el('span', {style: 'color:var(--shape)'}, 'dashed orange line'), ' is the agency\'s drawn shape. The ', el('span', {style: 'color:var(--routed)'}, 'blue line'), ' is where a bus can drive on OSM\'s roads while hugging that shape (oneway, access and bus/psv tags honoured). Where they part, something is wrong on one side: a road missing or cut in OSM, a oneway the wrong way, or a sloppy shape. ', el('span', {style: 'color:var(--rel)'}, 'Purple'), ' is what OSM\'s route relation currently contains.'),
    el('p', {}, el('b', {}, 'JOSM'), ': enable Remote Control in preferences. "Open in JOSM" loads and zooms; "Load proposed relation" downloads the ways and platforms and imports a new relation built from them into the current layer. Compare it with the existing relation (if any), fix, validate, upload. Re-route via a point when the proposed path takes a wrong turn; the imported relation then follows your vias (needs ', el('code', {}, 'tool/serve.py'), ').'),
    el('p', {}, el('b', {}, 'Stops'), ': matched by gtfs:stop_id/ref, then by distance and name. "Apply GTFS tags" adds ref, gtfs:stop_id, route_ref and description to the matched node in JOSM; the name is left to you, since the agency\'s name is often an address and OSM\'s a place.'),
    el('p', {}, el('b', {}, 'Before uploading many changes'), ', read ', el('a', {href: 'https://wiki.openstreetmap.org/wiki/Import/Guidelines', target: '_blank'}, 'Import/Guidelines'), ' and ', el('a', {href: 'https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct', target: '_blank'}, 'the automated-edits code of conduct'), '. Reviewing route by route and uploading what you\'ve checked is mapping; uploading all of it unread is an import, and needs the licence checked and the community told first.')));
}

// ---------- boot ----------
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; if (S.tab !== 'routes') { S.pattern = null; S.vias = []; S.routed = null; } if (S.tab !== 'stops') S.stop = null; render(); draw(); });
fetch('data/review.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(d => {
  D = d;
  $('#agency').textContent = `${d.agency.agency_name} · feed ${(d.feed.feed_version || '').slice(0, 40)} · OSM ${d.osm_fetched.slice(0, 10)}`;
  render();
  try { initMap(); } catch (e) { toast('Map failed to start: ' + e.message, 8000); console.error(e); }
}).catch(e => { $('#agency').textContent = 'no data/review.json — run tool/review.py'; console.error(e); });
