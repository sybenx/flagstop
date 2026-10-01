/* station.js — a place where several of the agency's stops sit together (a transit centre): how OSM maps one,
   what this one has of that, and what flagstop would do about the rest.

   Found from OSM itself, not from any agency's habits: a bus station object with two or more of the agency's
   platforms near it. The parts, as public transport mapping (PTv2) has them:
     the station   one object for the place (amenity=bus_station + public_transport=station), best as an area
     a platform    per bay, where people wait (highway=bus_stop + public_transport=platform)
     a stop position per bay, the point on the road where the bus halts (public_transport=stop_position)
     a stop area   relation grouping them (public_transport=stop_area)
   Route relations list the bay (and its stop position), never the station.

   flagstop does what is tags, relations or a point on a road, and decided from data or one answer; drawing the
   station as an area is RapiD's. */
'use strict';

const typeOf = o => ({n: 'node', w: 'way', r: 'relation'})[o.id[0]];
// a way can be edited only with its node list (else the upload would empty it); the review data has them now
const isPoint = o => o.id[0] === 'n' || (o.id[0] === 'w' && Array.isArray(o.nodes) && o.nodes.length > 1);

const Station = {
  NEAR: 80,    // m: a platform this close to a station point is one of its bays
  SAME: 60,    // m: station points this close are one place
  SNAP: 30,    // m: furthest a stop position goes from its bay

  isStation: o => o.tags.amenity === 'bus_station' || o.tags.public_transport === 'station',
  isPlatform: o => o.tags.highway === 'bus_stop' || o.tags.public_transport === 'platform',

  /** Every place: its station points, the platforms around it (the agency's bays first), its stop positions. */
  places() {
    if (this._places && this._for === D) return this._places;
    const st = Object.values(D.osm_stops).filter(o => this.isStation(o) && o.lon != null);
    const groups = [];
    for (const o of st) {
      const g = groups.find(g => g.some(x => m(osmPos(x), osmPos(o)) <= this.SAME));
      if (g) g.push(o); else groups.push([o]);
    }
    const claim = {};
    for (const s of Object.values(D.stops)) { const o = matchedOsm(s); if (o) (claim[o.id] = claim[o.id] || []).push(s); }
    const usedStops = new Set(D.patterns.flatMap(p => p.relations).flatMap(a => a.members).filter(x => x.type === 'node').map(x => 'n' + x.ref));
    this._places = groups.map(stations => {
      const around = Object.values(D.osm_stops).filter(o => o.lon != null && stations.some(x => m(osmPos(x), osmPos(o)) <= this.NEAR));
      const platforms = around.filter(o => this.isPlatform(o) && !this.isStation(o));
      const bays = platforms.filter(o => claim[o.id]).map(o => ({o, stops: claim[o.id]})).sort((a, b) => (+a.stops[0].ref || 0) - (+b.stops[0].ref || 0));
      return {id: stations.map(x => x.id).sort()[0], stations, bays, others: platforms.filter(o => !claim[o.id]),
        positions: around.filter(o => o.tags.public_transport === 'stop_position').map(o => ({o, used: usedStops.has(o.id)}))};
    }).filter(p => p.bays.length >= 2);
    this._for = D;
    return this._places;
  },
  place(id) { return this.places().find(p => p.id === id); },
  ofStop(s) { const o = matchedOsm(s); return o && this.places().find(p => p.bays.some(b => b.o.id === o.id)); },
  name(p) { const a = S.station && S.station.answers || {}; const main = p.stations.find(x => x.id === a.main) || (p.stations.length === 1 ? p.stations[0] : null); return (main || p.stations[0]).tags.name || 'the station'; },

  open(id) {
    S.station = {id, answers: {stopPos: true, gone: {}, localRef: {}}, live: null};
    S.tab = 'stops'; S.stop = null;
    render(); draw();
    const p = this.place(id), pts = [...p.stations, ...p.bays.map(b => b.o)].map(osmPos);
    fit(pts, 80);
    this.look(p);
  },
  close() { S.station = null; render(); draw(); },

  /** Live OSM around the place: the roads, an existing stop area, what uses the stop positions. Then where
   *  each bay's stop position would go: the nearest point on a road the buses calling there use. */
  async look(p) {
    const pts = [...p.stations, ...p.bays.map(b => b.o)].map(osmPos);
    const lons = pts.map(x => x[0]), lats = pts.map(x => x[1]);
    try {
      await Roads.load([Math.min(...lons) - 0.002, Math.min(...lats) - 0.0015, Math.max(...lons) + 0.002, Math.max(...lats) + 0.0015]);
    } catch (e) { if (S.station) { S.station.live = {error: e.message}; render(); } return; }
    if (!S.station || S.station.id !== p.id) return;
    const ids = new Set([...p.stations, ...p.bays.map(b => b.o), ...p.others, ...p.positions.map(x => x.o)].map(o => osmNumId(o)));
    const area = Object.values(Roads.rels).find(r => r.tags.public_transport === 'stop_area' && r.members.some(x => x.type === 'node' && ids.has(x.ref)));
    const routesOn = n => Object.values(Roads.rels).filter(r => r.tags.type === 'route' && r.members.some(x => x.type === 'node' && x.ref === n));
    const onWay = n => Object.values(Roads.ways).some(w => w.nodes.includes(n));
    const positions = p.positions.map(x => ({...x, routes: routesOn(osmNumId(x.o)), onWay: onWay(osmNumId(x.o))}));
    // per bay: the roads its buses drive (the routed paths of the itineraries calling there), nearest point on them
    const plan = [];
    for (const b of p.bays) {
      const sids = new Set(b.stops.map(s => s.id));
      const wanted = new Set(D.patterns.filter(q => q.stops.some(id => sids.has(id))).flatMap(q => routedOf(q).ways));
      let best = null;
      for (const wid of wanted) {
        const w = Roads.ways[wid]; if (!w) continue;
        const near = this.nearestOn(w.nodes.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat]), osmPos(b.o));
        if (near && (!best || near.d < best.d)) best = {...near, wid};
      }
      if (!best || best.d > this.SNAP) { plan.push({bay: b, none: best ? `the nearest road its buses use is ${Math.round(best.d)} m away` : 'no road its buses use nearby'}); continue; }
      // a stop position already there, for this bay or shared with the next: kept, not doubled
      const have = positions.find(x => m(osmPos(x.o), best.point) <= 8);
      const shared = plan.find(x => x.point && m(x.point, best.point) <= 4);
      plan.push({bay: b, point: best.point, wid: best.wid, have: have && have.o, with: shared && shared.bay});
    }
    S.station.live = {area, positions, plan};
    render(); draw();
  },
  /** The nearest point on a line to pt: {point, index (segment), d (m)}. Flat-earth over a few hundred metres. */
  nearestOn(line, pt) {
    const k = Math.cos(pt[1] * Math.PI / 180), xy = c => [(c[0] - pt[0]) * 111320 * k, (c[1] - pt[1]) * 110540];
    let best = null;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = xy(line[i]), b = xy(line[i + 1]), dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / L)) : 0, x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(x, y);
      if (!best || d < best.d) best = {d, index: i, t, point: [line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])]};
    }
    return best;
  },

  /** What the card proposes, from the place, the live look and the answers. */
  plan(p) {
    const a = S.station.answers, live = S.station.live || {};
    const main = p.stations.length === 1 ? p.stations[0] : p.stations.find(x => x.id === a.main);
    const extra = p.stations.filter(x => x !== main);
    const newPos = (live.plan || []).filter(x => x.point && !x.have && !x.with);
    const unused = (live.positions || []).filter(x => !x.routes.length && !(live.plan || []).some(y => y.have === x.o));
    const open = (p.stations.length > 1 && !main ? 1 : 0) + (main ? extra.filter(x => !a.other || !a.other[x.id]).length : 0);
    return {main, extra, newPos, unused, open, live};
  },

  /** How a station is mapped, part by part, ticked where OSM has it here: the practice, shown on this place. */
  practice(p, x) {
    const live = x.live, n = p.bays.length;
    const coded = p.bays.filter(b => b.o.tags.ref).length;
    const posFor = (live.plan || []).filter(y => y.have).length;
    const inRoutes = D.patterns.flatMap(q => q.relations).filter(r => r.members.some(mm => p.stations.some(st => st.id[0] === mm.type[0] && osmNumId(st) === mm.ref)));
    const row = (ok, what, how, now) => el('li', {class: ok ? 'ok' : 'no'}, el('span', {class: 'tick'}, ok ? '✓' : ok === null ? '·' : '✗'), el('div', {},
      el('b', {}, what), ' ', el('span', {class: 'muted'}, how), now ? el('div', {class: 'small'}, now) : null));
    const isArea = s => s && typeOf(s) !== 'node';
    return el('ul', {class: 'practice'},
      row(p.stations.length === 1, 'One station', '(amenity=bus_station + public_transport=station) for the whole place, best drawn as an area round the bays.',
        p.stations.length > 1 ? `OSM has ${p.stations.length} station points here: ${p.stations.map(s => `"${s.tags.name || s.id}"`).join(', ')}.` : isArea(p.stations[0]) ? null : 'Here it is a point.'),
      row(true, 'A platform per bay', '(highway=bus_stop + public_transport=platform) where people wait, with the agency\'s code in ref, the routes in route_ref, and the letter or number on the bay\'s sign in local_ref.',
        `${n} bays${coded < n ? `, ${n - coded} without the agency's code (Check stops adds it)` : ''}${p.bays.some(b => !b.o.tags.local_ref) ? `; ${p.bays.filter(b => !b.o.tags.local_ref).length} without local_ref` : ''}.`),
      row(live.plan ? posFor === n : null, 'A stop position per bay', '(public_transport=stop_position + bus=yes): the point on the road where the bus halts.',
        live.plan ? `${posFor} of ${n} bays have one${p.positions.length ? `; ${p.positions.length} stop position${p.positions.length > 1 ? 's' : ''} here in all` : ''}.` : 'Looking at OSM…'),
      row(live.plan ? !!live.area : null, 'A stop area', '(relation, public_transport=stop_area) grouping the station, its platforms and stop positions.',
        live.area ? `r${live.area.id}${live.area.tags.name ? ` "${live.area.tags.name}"` : ''}.` : live.plan ? 'None here.' : null),
      row(!inRoutes.length, 'Routes list the bay', 'they stop at (and its stop position), not the station.',
        inRoutes.length ? `${inRoutes.length} route relation${inRoutes.length > 1 ? 's list' : ' lists'} the station: ${inRoutes.map(r => r.name || 'r' + r.id).join(', ')}. Fix relation puts the bay in its place.` : null));
  },

  render(P) {
    const p = this.place(S.station.id);
    if (!p) { S.station = null; return renderStops(P); }
    const x = this.plan(p), live = x.live, a = S.station.answers, name = this.name(p);
    P.append(el('button', {class: 'back', onclick: () => this.close()}, '← all stops'));
    const d = el('div', {class: 'detail fixcard'});
    d.append(el('div', {class: 'head'}, el('h3', {}, name)));
    d.append(el('div', {class: 'fixstep why'}, el('div', {class: 'k'}, 'How a station is mapped'), this.practice(p, x)));
    if (live.error) d.append(el('div', {class: 'note warn'}, `Couldn't read OSM around it: ${live.error}`));
    // the questions
    if (p.stations.length > 1) {
      const pick = (label, key, val, on) => el('button', {class: 'b tiny' + (on ? ' chosen' : ''), onclick: () => { a[key] = on ? null : val; render(); draw(); }}, (on ? '✓ ' : '') + label);
      const what = s => { const t = s.tags, bits = [t.opening_hours && 'hours', (t.phone || t['contact:phone']) && 'a phone', (t.website || t['contact:website']) && 'a website', t['addr:street'] && 'an address'].filter(Boolean);
        return bits.length ? ` (has ${bits.join(', ')})` : ''; };
      const box = el('div', {class: 'fixstep', style: 'border-left-color:var(--amb)'}, el('div', {class: 'k'}, 'Decide first'),
        el('div', {class: 'why'}, `${p.stations.length} station points, ${Math.round(m(osmPos(p.stations[0]), osmPos(p.stations[1])))} m apart. Which is the station?`),
        el('div', {class: 'btns'}, ...p.stations.map(s => pick(`"${s.tags.name || s.id}"${what(s)}`, 'main', s.id, a.main === s.id))));
      if (x.main) for (const s of x.extra) {
        const o = (a.other = a.other || {}), cur = o[s.id], set = v => { o[s.id] = cur === v ? null : v; render(); };
        const btn = (label, v) => el('button', {class: 'b tiny' + (cur === v ? ' chosen' : ''), onclick: () => set(v)}, (cur === v ? '✓ ' : '') + label);
        box.append(el('div', {class: 'decide'}, el('div', {}, el('b', {}, `"${s.tags.name || s.id}"`), ' is:'),
          el('div', {class: 'btns'}, btn('Something in it, like an office: keep it, not as a station', 'office'), btn('The same station twice: fold it in', 'same'), btn('Leave both', 'leave')),
          cur === 'office' ? el('div', {class: 'why'}, `Loses the station tags, keeps its name${what(s).replace(/^ \(has/, ',').replace(/\)$/, '')}, and becomes office=yes (iD can make that more exact).`) : null,
          cur === 'same' ? el('div', {class: 'why'}, `What it says that "${x.main.tags.name || x.main.id}" doesn't goes onto it, then it's deleted.`) : null));
      }
      d.append(box);
    }
    // what flagstop would do
    const ul = el('ul', {class: 'mergelist'});
    if (live.plan) {
      const members = 1 + p.bays.length + p.others.length + (a.stopPos ? x.newPos.length : 0) + (live.positions || []).filter(y => y.routes.length || (live.plan || []).some(z => z.have === y.o)).length;
      const plats = p.bays.length + p.others.length;
      ul.append(el('li', {}, live.area ? `add what's missing to the stop area r${live.area.id}` : `group them in a stop area "${name}": the station, its ${plats} platforms (the ${p.bays.length} bays the agency's stops match, and ${p.others.length} more: other networks', or not matched yet) and the stop positions, ${members} members`));
      if (x.newPos.length || (live.plan || []).some(y => y.none)) ul.append(el('li', {}, el('label', {}, el('input', {type: 'checkbox', checked: a.stopPos ? '' : null, onchange: e => { a.stopPos = e.target.checked; render(); draw(); }}),
        ` add a stop position for ${x.newPos.length} bay${x.newPos.length === 1 ? '' : 's'}, on the road its buses use, level with the bay (teal on the map)`),
        ...(live.plan || []).filter(y => y.none).map(y => el('div', {class: 'muted small'}, `${y.bay.o.tags.name || y.bay.o.id}: none, ${y.none}.`))));
    } else if (!live.error) ul.append(el('li', {class: 'muted'}, 'Looking at OSM around it…'));
    d.append(el('div', {class: 'fixstep want'}, el('div', {class: 'k'}, 'flagstop would'), ul));
    // stop positions no route uses (one generic point for the whole place, usually): remove after a look
    if (x.unused.length) {
      const box = el('div', {class: 'fixstep'}, el('div', {class: 'k'}, `Stop position${x.unused.length > 1 ? 's' : ''} no route uses`),
        el('div', {class: 'why'}, a.stopPos && x.newPos.length ? 'With one per bay, these say nothing more.' : 'Not in any route relation.'));
      for (const y of x.unused) {
        const o = y.o, seen = S.looked.has('osm:' + o.id), on = a.gone[o.id] === 'remove';
        box.append(el('div', {class: 'decide'}, el('b', {}, o.tags.name || o.id),
          el('div', {style: 'margin:4px 0'}, el('button', {class: 'b tiny' + (seen ? '' : ' primary'), onclick: () => { S.looked.add('osm:' + o.id); render(); map.flyTo({center: osmPos(o), zoom: 19}); }}, 'Show on map')),
          el('div', {class: 'btns'},
            el('button', {class: 'b tiny' + (on ? ' chosen' : ''), disabled: seen ? null : '', title: seen ? '' : 'Show it on the map first', onclick: () => { a.gone[o.id] = on ? null : 'remove'; render(); }}, (on ? '✓ ' : '') + (y.onWay ? 'Remove it (the point stays in the road, untagged)' : 'Remove it')),
            el('button', {class: 'b tiny' + (!on ? ' chosen' : ''), onclick: () => { a.gone[o.id] = null; render(); }}, (!on ? '✓ ' : '') + 'Leave it'))));
      }
      d.append(box);
    }
    // bay signs: nobody's data has them; typed, they go in local_ref
    const signs = el('details', {class: 'small', open: Object.values(a.localRef).some(Boolean) ? '' : null}, el('summary', {}, 'Bay signs (local_ref), if you know them'),
      el('div', {class: 'muted'}, "The letter or number on each bay's sign. Neither the agency's data nor OSM has them; leave blank if unsure."),
      ...p.bays.map(b => el('div', {class: 'signrow'}, el('span', {}, `${b.o.tags.name || b.o.id}`, el('span', {class: 'muted'}, ` · ${b.stops.map(s => s.ref).join(', ')}`)),
        el('input', {value: a.localRef[b.o.id] ?? b.o.tags.local_ref ?? '', placeholder: b.o.tags.local_ref || '—', size: 4,
          oninput: e => { a.localRef[b.o.id] = e.target.value.trim(); syncHash(); }}))));
    d.append(signs);
    const main = x.main || (p.stations.length === 1 && p.stations[0]);
    if (main && typeOf(main) === 'node') d.append(el('div', {class: 'small', style: 'margin:6px 0'}, 'The station is a point. Drawing it as an area round the bays is ',
      el('a', {href: '#', onclick: e => { e.preventDefault(); openIn('rapid', {lon: main.lon, lat: main.lat, zoom: 19, select: [main.id], comment: `${name}: station as an area`}); }}, 'for RapiD'), '.'));
    d.append(el('h2', {style: 'margin-left:0'}, 'Does this look right?'),
      el('div', {class: 'btns'},
        el('button', {class: 'b primary', disabled: x.open || !live.plan ? '' : null, onclick: () => this.accept()}, x.open ? 'Looks right (decide above first)' : 'Looks right: add to Changes'),
        el('button', {class: 'b', onclick: () => { this.close(); toast('Left as OSM has it'); }}, 'Not right')));
    P.append(d);
  },

  /** On the map: the station points, the bays, stop positions now (grey), new ones (green), ones going (red). */
  features() {
    if (!S.station || S.tab !== 'stops') return [];
    const p = this.place(S.station.id); if (!p) return [];
    const x = this.plan(p), a = S.station.answers, out = [];
    for (const s of p.stations) out.push(point(osmPos(s), {kind: 'station', label: s.tags.name || 'station'}));
    for (const b of p.bays) out.push(point(osmPos(b.o), {kind: 'bay', label: a.localRef[b.o.id] || b.o.tags.local_ref || b.stops.map(s => s.ref).join(',')}));
    for (const o of p.others) out.push(point(osmPos(o), {kind: 'other', label: o.tags.name || ''}));
    for (const y of x.live.positions || []) out.push(point(osmPos(y.o), {kind: a.gone[y.o.id] === 'remove' ? 'going' : 'pos', label: ''}));
    if (a.stopPos) for (const y of x.newPos) { out.push(point(y.point, {kind: 'new', label: ''})); out.push(line([osmPos(y.bay.o), y.point], {kind: 'new'})); }
    return out;
  },

  async accept() {
    const p = this.place(S.station.id), x = this.plan(p), a = S.station.answers, live = x.live, name = this.name(p);
    const say = msg => toast(msg, 8000);
    Edits.hold(`${name}: station`);
    try {
      const main = x.main;
      const members = [{type: 'node', ref: osmNumId(main), role: ''}];
      if (typeOf(main) !== 'node') members[0].type = typeOf(main);
      // the other station points
      for (const s of x.extra) {
        const v = (a.other || {})[s.id];
        if ((v === 'office' || v === 'same') && (!isPoint(s) || !isPoint(main))) { say(`"${s.tags.name || s.id}" or the station is drawn as a shape: change it in iD`); continue; }
        if (v === 'office') {
          const drop = ['amenity', 'public_transport', 'bus'].filter(k => s.tags[k]);
          const tags = s.tags.office || s.tags.shop || s.tags.amenity !== 'bus_station' && s.tags.amenity ? {} : {office: 'yes'};
          Edits.modify(typeOf(s), osmNumId(s), nodeBase(s), {removeTags: drop, tags}, `${s.tags.name || s.id}: not a second station, ${name}`);
        } else if (v === 'same') {
          const add = Object.fromEntries(Object.entries(s.tags).filter(([k]) => !(k in main.tags)));
          if (Object.keys(add).length) Edits.modify(typeOf(main), osmNumId(main), nodeBase(main), {tags: add}, `${name}: station`);
          if (Object.values(Roads.rels).some(r => r.members.some(mm => mm.type === typeOf(s) && mm.ref === osmNumId(s)))) say(`"${s.tags.name || s.id}" is in a relation: not deleted`);
          else Edits.delete(typeOf(s), osmNumId(s), nodeBase(s), `${s.tags.name || s.id}: the same station as ${name}`);
        }
      }
      for (const b of p.bays) members.push({type: typeOf(b.o), ref: osmNumId(b.o), role: 'platform'});
      for (const o of p.others) members.push({type: typeOf(o), ref: osmNumId(o), role: 'platform'});
      // local_ref, where typed
      for (const b of p.bays) {
        const v = a.localRef[b.o.id];
        if (v != null && v !== (b.o.tags.local_ref || '') && isPoint(b.o)) Edits.modify(typeOf(b.o), osmNumId(b.o), nodeBase(b.o), v ? {tags: {local_ref: v}} : {removeTags: ['local_ref']}, `${b.o.tags.name || b.o.id}: bay sign`);
      }
      // stop positions: the ones kept, then new ones on the road (one road edit, so they undo together)
      for (const y of live.positions || []) if (a.gone[y.o.id] !== 'remove' && (y.routes.length || (live.plan || []).some(z => z.have === y.o))) members.push({type: 'node', ref: osmNumId(y.o), role: 'stop'});
      if (a.stopPos && x.newPos.length) {
        const t = Roads.tx(), made = [];
        for (const y of x.newPos) {
          const w = t.way(y.wid), near = this.nearestOn(w.nodes.map(n => Roads.ll(t, n)), y.point);
          const tags = {public_transport: 'stop_position', bus: 'yes', name};
          const ref = a.localRef[y.bay.o.id] || y.bay.o.tags.local_ref; if (ref) tags.local_ref = ref;
          // on a plain point of the road already there (untagged, in no other way): tag it. A junction or a
          // tagged point keeps what it is: the new point goes 2 m along the road from it instead.
          const at = [w.nodes[near.index], w.nodes[near.index + 1]].find(n => m(Roads.ll(t, n), near.point) < 1.5);
          const plain = at != null && at > 0 && !Object.keys((Roads.nodes[at] || {}).tags || {}).length && t.waysAt(at).length === 1;
          if (plain) { made.push({id: at, tags, existing: true}); continue; }
          let pt = near.point;
          if (at != null) {
            const other = Roads.ll(t, at === w.nodes[near.index] ? w.nodes[near.index + 1] : w.nodes[near.index]), L = m(Roads.ll(t, at), other);
            const f = Math.min(0.5, 2 / Math.max(L, 0.1)), from = Roads.ll(t, at);
            pt = [from[0] + f * (other[0] - from[0]), from[1] + f * (other[1] - from[1])];
          }
          const id = Roads.insert(t, y.wid, near.index, pt);
          t.nodes[id].tags = tags; made.push({id});
        }
        if (made.some(z => !z.existing)) Roads.commit(t, [], `Add ${made.filter(z => !z.existing).length} stop position${made.filter(z => !z.existing).length > 1 ? 's' : ''} at ${name}`);
        for (const z of made) {
          if (z.existing) { Edits.modify('node', z.id, Roads.baseNode(z.id), {tags: z.tags}, `${name}: stop position`); members.push({type: 'node', ref: z.id, role: 'stop'}); }
          else members.push({key: 'new:n' + z.id, role: 'stop'});
        }
      }
      // generic stop positions going: only if no route uses them (checked live); a point in a road is untagged
      for (const y of x.unused.filter(y => a.gone[y.o.id] === 'remove')) {
        if (y.onWay) Edits.modify('node', osmNumId(y.o), nodeBase(y.o), {removeTags: Object.keys(y.o.tags)}, `${y.o.tags.name || y.o.id}: stop position no route uses (point kept: it's in a road)`);
        else Edits.delete('node', osmNumId(y.o), nodeBase(y.o), `${y.o.tags.name || y.o.id}: stop position no route uses`);
      }
      // the stop area: the one there, with what's missing; or a new one
      const same = (u, v) => Edits.resolveMember(u) && Edits.resolveMember(v) && Edits.resolveMember(u).type === Edits.resolveMember(v).type && Edits.resolveMember(u).ref === Edits.resolveMember(v).ref;
      if (live.area) {
        const gone = new Set(x.unused.filter(y => a.gone[y.o.id] === 'remove').map(y => osmNumId(y.o)));
        const cur = live.area.members.filter(mm => !(mm.type === 'node' && gone.has(mm.ref)));
        const add = members.filter(mm => !cur.some(c => same(c, mm)));
        if (add.length || cur.length !== live.area.members.length) Edits.modify('relation', live.area.id, {version: live.area.version, tags: live.area.tags, members: live.area.members}, {members: [...cur, ...add]}, `${name}: stop area`);
      } else {
        Edits.createRelation({type: 'public_transport', public_transport: 'stop_area', name}, members, `${name}: stop area`);
      }
      Edits.save();
      say(`${name}: in Changes`);
      S.station = null;
      render(); draw();
    } catch (e) { say(e.message); console.error(e); }
    finally { Edits.release(); }
  },
};
