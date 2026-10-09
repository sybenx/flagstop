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

/** What's often in a transit station, with hours of its own: nobody's data says what this one has, so the reviewer
 *  says (nothing is ticked), and OSM gets a point for each, inside the station. extra: the few details that matter. */
const THINGS = [
  {key: 'toilets', label: 'Toilets', tags: {amenity: 'toilets'}, is: t => t.amenity === 'toilets', hours: true,
    extra: [['fee', ['no', 'yes']], ['access', ['yes', 'customers']], ['wheelchair', ['yes', 'limited', 'no']]]},
  {key: 'lost', label: 'Lost and found', tags: {amenity: 'lost_property_office'}, is: t => t.amenity === 'lost_property_office', hours: true, operator: true, extra: []},
  {key: 'tickets', label: 'Ticket office or customer service window', tags: {shop: 'ticket', 'tickets:public_transport': 'yes'}, is: t => t.shop === 'ticket' || t.amenity === 'ticket_office', hours: true, operator: true, extra: []},
  {key: 'info', label: 'Information desk', tags: {tourism: 'information', information: 'office'}, is: t => t.tourism === 'information' && t.information === 'office', hours: true, operator: true, extra: []},
  {key: 'machine', label: 'Ticket machine', tags: {amenity: 'vending_machine', vending: 'public_transport_tickets'}, is: t => t.amenity === 'vending_machine' && /ticket/.test(t.vending || ''), hours: false, operator: true,
    extra: [['payment:cards', ['yes', 'no']], ['payment:cash', ['yes', 'no']]]},
  {key: 'water', label: 'Drinking water', tags: {amenity: 'drinking_water'}, is: t => t.amenity === 'drinking_water', hours: false, extra: [['bottle', ['yes', 'no']]]},
  {key: 'bikes', label: 'Bike parking', tags: {amenity: 'bicycle_parking'}, is: t => t.amenity === 'bicycle_parking', hours: false, extra: [['covered', ['no', 'yes']], ['capacity', null]]},
];

/** opening_hours, typed or built: days and times, more than one range, a note in quotes ("often until 19:00").
 *  The OSM wiki's syntax, the common part of it; anything else can be typed. */
const Hours = {
  DAYS: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
  /** Mo,Tu,We,Th,Fr -> Mo-Fr; Mo,We -> Mo,We */
  days(ds) {
    const i = ds.map(d => this.DAYS.indexOf(d)).filter(x => x >= 0).sort((a, b) => a - b), runs = [];
    for (const x of i) { const r = runs[runs.length - 1]; if (r && x === r[1] + 1) r[1] = x; else runs.push([x, x]); }
    return runs.map(([a, b]) => b - a >= 2 ? `${this.DAYS[a]}-${this.DAYS[b]}` : b > a ? `${this.DAYS[a]},${this.DAYS[b]}` : this.DAYS[a]).join(',');
  },
  build(rows, note) {
    const rules = rows.filter(r => r.days.length && r.from && r.to).map(r => `${r.days.length === 7 ? 'Mo-Su' : this.days(r.days)} ${r.from}-${r.to}`);
    if (rules.length && note) rules[rules.length - 1] += ` "${note.replace(/"/g, "'")}"`;
    return rules.join('; ');
  },
  /** Plausible as opening_hours: each rule days and times, off, or 24/7, with a note in quotes if any. A warning, not a gate. */
  ok(v) {
    if (!v) return true;
    const d = '(Mo|Tu|We|Th|Fr|Sa|Su|PH)', days = `${d}(-${d})?(,${d}(-${d})?)*`, t = '\\d\\d:\\d\\d-\\d\\d:\\d\\d', times = `${t}(,${t})*`;
    const rule = new RegExp(`^((${days})\\s+)?(${times}|off|closed)(\\s+"[^"]*")?$|^24/7$`);
    return v.split(/\s*;\s*/).every(r => rule.test(r.trim()));
  },
  /** The editor: the value as text, and a builder that writes it. state: {oh, rows?, note?}; done(): re-render. */
  editor(state, done) {
    const txt = el('input', {value: state.oh || '', placeholder: 'e.g. Mo-Fr 07:00-19:00; Sa 09:00-17:00', style: 'width:100%', onchange: e => { state.oh = e.target.value.trim(); done(); }});
    const rows = state.rows || (state.rows = [{days: ['Mo', 'Tu', 'We', 'Th', 'Fr'], from: '', to: ''}]);
    const write = () => { const v = this.build(rows, state.note); if (v) { state.oh = v; done(); } };
    const row = r => el('div', {class: 'btns', style: 'align-items:center;flex-wrap:wrap'},
      ...this.DAYS.map(dd => el('label', {class: 'small', style: 'margin-right:2px'}, el('input', {type: 'checkbox', checked: r.days.includes(dd) ? '' : null, onchange: e => { r.days = e.target.checked ? [...r.days, dd] : r.days.filter(x => x !== dd); }}), dd)),
      el('input', {type: 'time', value: r.from, onchange: e => { r.from = e.target.value; }}), '–', el('input', {type: 'time', value: r.to, onchange: e => { r.to = e.target.value; }}),
      rows.length > 1 ? el('a', {href: '#', class: 'muted small', onclick: e => { e.preventDefault(); rows.splice(rows.indexOf(r), 1); done(); }}, 'remove') : null);
    return el('div', {class: 'small'}, el('div', {}, 'Hours ', txt, Hours.ok(state.oh) ? null : el('div', {style: 'color:var(--amb)'}, "That doesn't read as opening_hours: check it (the OSM wiki has the syntax).")),
      el('details', {}, el('summary', {class: 'muted'}, 'build them'), ...rows.map(row),
        el('div', {class: 'btns'}, el('a', {href: '#', class: 'small', onclick: e => { e.preventDefault(); rows.push({days: ['Sa'], from: '', to: ''}); done(); }}, '+ another range'),
          el('input', {value: state.note || '', placeholder: 'note, e.g. often until 19:00', size: 22, onchange: e => { state.note = e.target.value.trim(); }}),
          el('button', {class: 'b tiny', onclick: write}, 'Use these hours'))));
  },
};

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
  /** The place an OSM object is part of: a station point, a platform or a stop position there. */
  ofOsm(id) { return this.places().find(p => [...p.stations, ...p.bays.map(b => b.o), ...p.others, ...p.positions.map(x => x.o)].some(o => o.id === id)); },
  /** The place an agency stop is a bay of: by its OSM stop, or, not settled yet (several fit), by any it could be. */
  ofStop(s) {
    const o = matchedOsm(s), ids = o ? [o.id] : ((s.match && s.match.osm) || []).map(c => c.id);
    return this.places().find(p => [...p.bays.map(b => b.o), ...p.others].some(x => ids.includes(x.id)));
  },
  /** What a place hasn't got of how a station is mapped, as far as the review data tells (the card looks closer):
   *  several station points, no stop area, bays without a stop position. -> [short phrases] */
  issues(p) {
    const ids = new Set([...p.stations, ...p.bays.map(b => b.o), ...p.others].map(o => o.id));
    const area = (D.stop_areas || []).some(a => (a.members || []).some(mm => ids.has(mm.type[0] + mm.ref)));
    return [p.stations.length > 1 ? `${p.stations.length} station points` : null, area ? null : 'no stop area',
      p.positions.length < p.bays.length ? `${p.positions.length} stop position${p.positions.length === 1 ? '' : 's'} for ${p.bays.length} bays` : null].filter(Boolean);
  },
  /** Of two station points, one plainly something in the station by its name or what it says it is (a lost and found,
   *  an office, a ticket window): the other is the station, and that one is something in it. Answered so, to change
   *  if it's wrong; nothing answered when it isn't plain. -> {main, other} or {} */
  likely(p) {
    if (!p || p.stations.length !== 2) return {};
    const inside = s => /lost\s*(and|&|\+|n)?\s*found|lost property|office|ticket|customer service|information|travel cent(er|re)/i.test(s.tags.name || '') || !!s.tags.office || !!s.tags.shop;
    const [a, b] = p.stations, ia = inside(a), ib = inside(b);
    if (ia === ib) return {};
    const main = ia ? b : a, other = ia ? a : b;
    return {main: main.id, other: {[other.id]: 'office'}, guessed: true};
  },
  /** What a point that isn't the station becomes: a lost property office by its name, else an office (iD can make
   *  that more exact). Something it already says it is (an office, a shop, another amenity) stays. */
  notStation(s) {
    const t = s.tags;
    if (t.office || t.shop || (t.amenity && t.amenity !== 'bus_station')) return {};
    return /lost\s*(and|&|\+|n)?\s*found|lost property/i.test(t.name || '') ? {amenity: 'lost_property_office'} : {office: 'yes'};
  },
  name(p) { const a = S.station && S.station.answers || {}; const main = p.stations.find(x => x.id === a.main) || (p.stations.length === 1 ? p.stations[0] : null); return (main || p.stations[0]).tags.name || 'the station'; },

  open(id) {
    // stop positions are PTv2's optional part, and many careful mappers leave them out: offered, not ticked
    S.station = {id, answers: {stopPos: false, gone: {}, localRef: {}, ...this.likely(this.place(id))}, live: null};
    S.tab = 'stops'; S.stop = null;
    render(); draw();
    const p = this.place(id), pts = [...p.stations, ...p.bays.map(b => b.o)].map(osmPos);
    frame(pts, 19);   // close enough to tell the bays apart
    this.look(p);
  },
  close() { S.station = null; this.syncMarkers(); render(); draw(); },

  /** Live OSM around the place: the roads, an existing stop area, what uses the stop positions. Then where
   *  each bay's stop position would go: the nearest point on a road the buses calling there use. */
  async look(p) {
    // the routes calling at its bays, routed: their roads are where the stop positions go
    const sids = new Set(p.bays.flatMap(b => b.stops.map(s => s.id)));
    await Promise.all(D.patterns.filter(q => q.stops.some(id => sids.has(id))).map(ensureRouted));
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
    // what's in the station already, by kind: points and shapes within its reach
    const things = {}, here = ll => p.stations.some(st => m(osmPos(st), ll) <= this.NEAR);
    const cand = [...Object.values(Roads.nodes).filter(n => n.tags && Object.keys(n.tags).length).map(n => ({id: 'n' + n.id, tags: n.tags, lat: n.lat, lon: n.lon, version: n.version})),
      ...Object.values(Roads.ways).filter(w => w.tags && Object.keys(w.tags).length).map(w => { const n0 = Roads.nodes[w.nodes[0]]; return n0 && {id: 'w' + w.id, tags: w.tags, lat: n0.lat, lon: n0.lon, nodes: w.nodes, version: w.version}; }).filter(Boolean)];
    for (const k of THINGS) things[k.key] = cand.filter(o => k.is(o.tags) && here([o.lon, o.lat]));
    S.station.live = {area, positions, plan, things};
    S.station.live.own = this.own(p);
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

  /** Things in the station: its own hours (its doors), and what's often in one (THINGS): there already, to edit; or
   *  ticked to add, as a point placed on the map. Nothing is ticked: nobody's data says what's there. */
  thingsBox(p, x) {
    const a = S.station.answers, live = x.live || {}, main0 = x.main || (p.stations.length === 1 ? p.stations[0] : null), main = main0 && this.now(main0);
    const T = a.things = a.things || {}, E = a.edits = a.edits || {};
    const re = () => { render(); draw(); };
    const box = el('div', {class: 'fixstep'}, el('div', {class: 'k'}, 'Things in the station'),
      el('div', {class: 'why'}, "What's there with hours of its own. Nobody's data says, so tick only what you know is there: each goes in OSM as a point inside the station, where you put it on the map."));
    if (!live.things) { box.append(el('div', {class: 'muted small'}, live.error ? '' : 'Looking at OSM around it…')); return box; }
    if (main) {
      const st = E[main.id] = E[main.id] || {oh: main.tags.opening_hours || '', extra: {}};
      box.append(el('div', {class: 'decide'}, el('div', {}, el('b', {}, `${main.tags.name || 'The station'}: when its doors are open`),
        main.tags.opening_hours ? el('span', {class: 'muted'}, ` (OSM: ${main.tags.opening_hours})`) : el('span', {class: 'muted'}, ' (OSM: none)')), Hours.editor(st, re)));
    } else box.append(el('div', {class: 'muted small'}, 'Say which point is the station (above), then its hours go on it.'));
    // a second station point said to be a lost and found in it: that's the lost and found
    // (one already a lost and found in OSM as it is now, after an upload the data here doesn't have yet, isn't twice)
    const there = new Set(Object.values(live.things).flat().map(o => o.id));
    const office = (x.extra || []).filter(o => !there.has(o.id) && (a.other || {})[o.id] === 'office' && this.notStation(o).amenity === 'lost_property_office');
    for (const k of THINGS) {
      const have = [...(live.things[k.key] || []), ...(k.key === 'lost' ? office : [])];
      const row = el('div', {class: 'decide'});
      if (have.length) for (const o of have) {
        const st = E[o.id] = E[o.id] || {oh: o.tags.opening_hours || '', extra: {}};
        row.append(el('div', {}, el('b', {}, k.label), ': there, ', el('a', {href: osmLink(o.id), target: '_blank'}, o.tags.name || o.id),
          el('span', {class: 'muted'}, o.tags.opening_hours ? ` · ${o.tags.opening_hours}` : k.hours ? ' · no hours in OSM' : '')),
          ...[k.hours ? Hours.editor(st, re) : null, this.extras(k, o.tags, st)].filter(Boolean));   // (DOM append writes 'null')
      } else {
        const t = T[k.key] = T[k.key] || {add: false, oh: '', extra: {}};
        row.append(el('label', {}, el('input', {type: 'checkbox', checked: t.add ? '' : null, onchange: e => { t.add = e.target.checked; if (t.add && !t.at) t.at = this.spot(p, main, k); re(); }}),
          ` ${k.label}`, el('span', {class: 'muted'}, ' — not in OSM here')));
        if (t.add) row.append(...[el('div', {class: 'muted small'}, 'On the map: drag its marker to where it is.'), k.hours ? Hours.editor(t, re) : null, this.extras(k, {}, t)].filter(Boolean));
      }
      box.append(row);
    }
    return box;
  },
  // ---------- the station as an area ----------
  /** A corner more on the outline, where it was double-clicked: in the side nearest the click. */
  addCorner(q) {
    const A = S.station && S.station.answers.area;
    if (!A || !A.on || !A.ring) return;
    const closed = [...A.ring, A.ring[0]], near = this.nearestOn(closed, q);
    A.ring.splice(near.index + 1, 0, near.point);
    this.syncMarkers(true); render(); draw(); syncHash();
  },
  /** The outline's corner at a point on screen (within 12 px), or -1. */
  cornerAt(pt) {
    const A = S.station && S.station.answers.area;
    if (!A || !A.on || !A.ring) return -1;
    return A.ring.findIndex(q => { const p = map.project(q); return Math.hypot(p.x - pt.x, p.y - pt.y) < 12; });
  },
  /** A corner fewer (three at least: it's an area). */
  removeCorner(i) {
    const A = S.station && S.station.answers.area;
    if (!A || !A.ring || A.ring.length <= 3) return toast('An area needs three corners at least', 3000);
    A.ring.splice(i, 1);
    this.syncMarkers(true); render(); draw(); syncHash();
  },
  /** Convex hull of [lon, lat] points, in order round it. */
  hull(pts) {
    const P = [...new Map(pts.map(q => [q.join(), q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (P.length < 3) return P;
    const k = Math.cos(P[0][1] * Math.PI / 180), cr = (o, a, b) => ((a[0] - o[0]) * k) * (b[1] - o[1]) - (a[1] - o[1]) * ((b[0] - o[0]) * k);
    const lo = [], up = [];
    for (const q of P) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of [...P].reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  },
  /** A ring pushed out by d metres from its middle (a hull, so the middle is inside). */
  grow(ring, d) {
    const c = [ring.reduce((a, q) => a + q[0], 0) / ring.length, ring.reduce((a, q) => a + q[1], 0) / ring.length], k = Math.cos(c[1] * Math.PI / 180);
    return ring.map(q => { const dx = (q[0] - c[0]) * 111320 * k, dy = (q[1] - c[1]) * 110540, L = Math.hypot(dx, dy) || 1;
      return [q[0] + d * dx / L / (111320 * k), q[1] + d * dy / L / 110540]; });
  },
  inside(q, ring) {
    let r = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > q[1]) !== (yj > q[1]) && q[0] < (xj - xi) * (q[1] - yi) / (yj - yi) + xi) r = !r;
    }
    return r;
  },
  /** What OSM has mapped as this station's, read live: its platforms (points and areas), the shelters for its buses,
   *  the buildings among its platforms or named for whoever runs it, its bike parking. A neighbour (a theatre over
   *  the road) isn't. -> {parts: [{id, tags, ll: [[lon, lat]...]}], buildings: [...], ring: the draft outline} */
  own(p) {
    const ll = n => Roads.nodes[n] && [Roads.nodes[n].lon, Roads.nodes[n].lat];
    const ways = Object.values(Roads.ways).filter(w => w.tags && Object.keys(w.tags).length).map(w => ({id: 'w' + w.id, tags: w.tags, version: w.version, nodes: w.nodes, ll: w.nodes.map(ll).filter(Boolean)})).filter(w => w.ll.length);
    const mid = w => [w.ll.reduce((a, q) => a + q[0], 0) / w.ll.length, w.ll.reduce((a, q) => a + q[1], 0) / w.ll.length];
    const near = w => p.stations.some(st => m(osmPos(st), mid(w)) <= this.NEAR);
    const plats = ways.filter(w => w.tags.public_transport === 'platform' && near(w));
    // the core: where the buses stop (bays, platform areas) and the station points
    const core = this.grow(this.hull([...p.bays.map(b => osmPos(b.o)), ...p.stations.map(osmPos), ...plats.flatMap(w => w.ll)]), 6);
    const words = [...new Set(p.stations.flatMap(st => ['operator', 'network'].map(k => st.tags[k] || '')).join(' ').toLowerCase().split(/\W+/).filter(w => w.length > 3))];
    const theirs = t => words.some(w => `${t.name || ''} ${t.operator || ''} ${t.website || ''}`.toLowerCase().includes(w));
    const parts = [...plats, ...ways.filter(w => near(w) && !plats.includes(w) && (
      (w.tags.amenity === 'shelter' && (w.tags.shelter_type === 'public_transport' || this.inside(mid(w), core))) ||
      (w.tags.amenity === 'bicycle_parking' && theirs(w.tags)) ||
      (w.tags.building && !/^(roof|house|residential|apartments)$/.test(w.tags.building) && !this.elsewhere(w.tags) && (this.inside(mid(w), core) || theirs(w.tags)))))];
    const buildings = parts.filter(w => w.tags.building && w.tags.building !== 'roof' && w.tags.amenity !== 'shelter' && w.tags.amenity !== 'bicycle_parking');
    // the draft outline: round all of it, but never over a neighbour's building; the part furthest out that takes it
    // over one is left out (it's still the station's: the reviewer drags the edge round it, or not)
    const theirsNot = ways.filter(w => w.tags.building && !parts.includes(w) && near(w)), c0 = osmPos(p.stations[0]);
    const pool = [...parts].sort((x, y) => m(c0, mid(x)) - m(c0, mid(y)));
    let ring;
    for (;;) {
      ring = this.grow(this.hull([...p.bays.map(b => osmPos(b.o)), ...p.stations.map(osmPos), ...pool.flatMap(w => w.ll)]), 4);
      if (!pool.length || !theirsNot.some(w => w.ll.some(q => this.inside(q, ring)))) break;
      pool.pop();
    }
    return {parts, buildings: buildings.map(w => ({...w, theirs: theirs(w.tags)})), ring};
  },
  /** A building with a purpose of its own that isn't the station's (a theatre, a clinic, a shop next door). */
  elsewhere(t) {
    return !!(t.shop || t.healthcare || t.leisure || t.tourism || t.craft || (t.amenity && !/^(shelter|bus_station|bicycle_parking|toilets|ticket_office|lost_property_office|waiting_room)$/.test(t.amenity)));
  },
  /** building=yes on a station's building, as it says it is: an office (office=*), or the station's own (named for
   *  whoever runs it). Otherwise nothing suggested; anything more exact than yes already there stays. */
  buildingFor(b) {
    if (b.tags.building !== 'yes') return null;
    if (b.tags.office) return 'office';
    return b.theirs ? 'transportation' : null;
  },
  areaBox(p, x) {
    const a = S.station.answers, main = x.main || (p.stations.length === 1 ? p.stations[0] : null), live = x.live || {};
    if (!main || typeOf(main) !== 'node' || !live.own) return null;
    const A = a.area = a.area || {on: false, ring: null}, B = a.buildings = a.buildings || {}, own = live.own, re = () => { render(); draw(); };
    const box = el('div', {class: 'fixstep'}, el('div', {class: 'k'}, 'The station as an area'),
      el('div', {class: 'why'}, `${main.tags.name || 'The station'} is a point. A station is best an area round the whole place: OSM has ${own.parts.length} things mapped as this one's (platforms, shelters, buildings) to draw it round.`),
      el('label', {}, el('input', {type: 'checkbox', checked: A.on ? '' : null, onchange: e => { A.on = e.target.checked; if (A.on && !A.ring) A.ring = own.ring.map(q => [...q]); re(); }}),
        ' Draw it as an area: a draft round what\'s mapped there, its corners dragged to the edge of the site (imagery helps)'));
    if (A.on) {
      box.append(el('div', {class: 'muted small'}, `${A.ring.length} corners on the map: drag them to the edge of the site; double-click the line for a corner more; drop a corner on another, or double-click it, to remove it. `, el('a', {href: '#', onclick: e => { e.preventDefault(); A.ring = own.ring.map(q => [...q]); this.syncMarkers(true); re(); }}, 'start again')),
        Carry.box(this.now(main), {id: 'the area', tags: {}}, () => true, {title: `The point's tags, onto the area`}),
        el('div', {class: 'muted small'}, 'The point goes; the stop area lists the area instead.'));
    }
    if (own.buildings.length) {
      box.append(el('div', {style: 'margin-top:6px'}, el('b', {}, 'Its buildings')));
      for (const b of own.buildings) {
        const sug = this.buildingFor(b), cur = B[b.id] ?? sug ?? '';
        box.append(el('div', {class: 'small', style: 'margin:3px 0'}, el('a', {href: osmLink(b.id), target: '_blank'}, b.tags.name || b.id), ` building=${b.tags.building} `,
          el('select', {class: 'b', onchange: e => { B[b.id] = e.target.value; }}, ...[['', 'leave it'], ['transportation', 'transportation (the station\'s own)'], ['office', 'office'], ['commercial', 'commercial'], ['retail', 'retail'], ['service', 'service (a shed, a plant room)']]
            .map(([v, l]) => el('option', {value: v, selected: cur === v ? '' : null}, v ? `→ ${l}` : l))),
          sug ? el('span', {class: 'muted'}, ` (suggested: ${sug}${sug === 'office' ? ', it says office=' + b.tags.office : ''})`) : null));
      }
    }
    return box;
  },

  /** An OSM object as OSM has it now, where the card's live look read it (an upload since the data here was built
   *  shows), else as the data here has it. */
  now(o) {
    const r = o.id[0] === 'n' ? Roads.nodes[osmNumId(o)] : o.id[0] === 'w' ? Roads.ways[osmNumId(o)] : null;
    return r && r.tags ? {...o, tags: r.tags, version: r.version ?? o.version} : o;
  },
  /** A kind's few details: a choice, or a number. Left at "—" (or OSM's own, in brackets), nothing changes. */
  extras(k, tags, st) {
    if (!k.extra.length) return null;
    return el('div', {class: 'btns small', style: 'align-items:center;flex-wrap:wrap'}, ...k.extra.map(([key, vals]) => el('label', {}, `${key} `, vals
      ? el('select', {class: 'b', onchange: e => { st.extra[key] = e.target.value; }}, el('option', {value: ''}, tags[key] ? `(${tags[key]})` : '—'), ...vals.map(v => el('option', {value: v, selected: st.extra[key] === v ? '' : null}, v)))
      : el('input', {size: 4, value: st.extra[key] ?? tags[key] ?? '', onchange: e => { st.extra[key] = e.target.value.trim(); }}))));
  },
  /** Where a new thing starts: a few metres from the station point, each kind its own way round, to be dragged. */
  spot(p, main, k) {
    const c = osmPos(main || p.stations[0]), ang = THINGS.indexOf(k) * 2 * Math.PI / THINGS.length;
    return [c[0] + 10 * Math.cos(ang) / (111320 * Math.cos(c[1] * Math.PI / 180)), c[1] + 10 * Math.sin(ang) / 110540];
  },
  /** The new things' markers on the map, draggable: one per ticked kind, gone when unticked or the card closes. */
  markers: {},
  corners: [],
  syncMarkers(again) {
    // the area's corners: one draggable dot each, while it's being drawn
    const A = S.station && S.station.answers.area, ring = A && A.on && A.ring;
    if (again || !ring || this.corners.length !== ring.length) { for (const c of this.corners) c.remove(); this.corners = []; }
    if (ring && !this.corners.length) this.corners = ring.map((q, i) => {
      const dot = document.createElement('div');
      dot.style.cssText = `width:14px;height:14px;border-radius:50%;background:${css('--edit')};border:2px solid #fff;box-shadow:0 0 2px #000;cursor:grab`;
      dot.title = 'Drag to the edge of the site; double-click to remove';
      dot.addEventListener('dblclick', e => { e.stopPropagation(); e.preventDefault(); this.removeCorner(i); });
      const mk = new maplibregl.Marker({element: dot, draggable: true}).setLngLat(q).addTo(map);
      mk.on('drag', () => { const ll = mk.getLngLat(); ring[i] = [ll.lng, ll.lat]; draw(); });
      // dropped onto another corner: the two are one (the one dragged goes)
      mk.on('dragend', () => {
        const at = map.project(mk.getLngLat()), on = ring.findIndex((r, j) => j !== i && Math.hypot(map.project(r).x - at.x, map.project(r).y - at.y) < 12);
        if (on >= 0 && ring.length > 3) return this.removeCorner(i);
        syncHash();
      });
      return mk;
    });
    const T = (S.station && S.station.answers.things) || {};
    for (const k of Object.keys(this.markers)) if (!(T[k] && T[k].add)) { this.markers[k].remove(); delete this.markers[k]; }
    for (const [k, t] of Object.entries(T)) {
      if (!t.add || this.markers[k]) continue;
      const kind = THINGS.find(x => x.key === k);
      const mk = new maplibregl.Marker({draggable: true, color: css('--edit')}).setLngLat(t.at).setPopup(new maplibregl.Popup({offset: 24, closeButton: false}).setText(kind.label)).addTo(map);
      mk.on('dragend', () => { const ll = mk.getLngLat(); t.at = [ll.lng, ll.lat]; syncHash(); });
      mk.togglePopup();
      this.markers[k] = mk;
    }
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
      const box = el('div', {class: 'fixstep', style: a.guessed && x.main ? '' : 'border-left-color:var(--amb)'}, el('div', {class: 'k'}, a.guessed && x.main ? 'Two station points' : 'Decide first'),
        el('div', {class: 'why'}, `${p.stations.length} station points, ${Math.round(m(osmPos(p.stations[0]), osmPos(p.stations[1])))} m apart. Which is the station?` +
          (a.guessed ? ` Answered by their names (one is plainly something in the station); change it if that's wrong.` : '')),
        el('div', {class: 'btns'}, ...p.stations.map(s => pick(`"${s.tags.name || s.id}"${what(s)}`, 'main', s.id, a.main === s.id))));
      if (x.main) for (const s of x.extra) {
        const o = (a.other = a.other || {}), cur = o[s.id], set = v => { o[s.id] = cur === v ? null : v; render(); };
        const btn = (label, v) => el('button', {class: 'b tiny' + (cur === v ? ' chosen' : ''), onclick: () => set(v)}, (cur === v ? '✓ ' : '') + label);
        box.append(el('div', {class: 'decide'}, el('div', {}, el('b', {}, `"${s.tags.name || s.id}"`), ' is:'),
          el('div', {class: 'btns'}, btn('Something in it, like an office: keep it, not as a station', 'office'), btn('The same station twice: fold it in', 'same'), btn('Leave both', 'leave')),
          cur === 'office' ? el('div', {class: 'why'}, `Loses the station tags, keeps its name${what(s).replace(/^ \(has/, ',').replace(/\)$/, '')}, and becomes ${Object.entries(this.notStation(s)).map(([k, v]) => `${k}=${v}`).join(' ') || 'what it already says it is'}${this.notStation(s).office ? ' (iD can make that more exact)' : ''}.`) : null,
          cur === 'same' ? Carry.box(s, x.main, CARRY.station, {rename: {name: 'alt_name'}}) : null,
          cur === 'same' && Object.keys(Carry.tags(s, x.main, CARRY.station, {name: 'alt_name'})).some(k => /^(opening_hours|phone|contact:|website|email)/.test(k))
            ? el('div', {class: 'why'}, el('b', {}, "The station would then have its hours or contact details. "), 'If those are an office\'s in the station (a lost and found, a ticket window), it\'s "something in it" instead.') : null));
      }
      d.append(box);
    }
    d.append(this.thingsBox(p, x));
    { const ab = this.areaBox(p, x); if (ab) d.append(ab); }
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
    if (main && typeOf(main) === 'node') d.append(el('div', {class: 'small', style: 'margin:6px 0'}, 'Or draw the station as an area yourself, traced from imagery: ',
      el('a', {href: '#', onclick: e => { e.preventDefault(); openIn('rapid', {lon: main.lon, lat: main.lat, zoom: 19, select: [main.id], comment: `${name}: station as an area`}); }}, 'in RapiD'), '.'));
    d.append(el('h2', {style: 'margin-left:0'}, 'Does this look right?'),
      el('div', {class: 'btns'},
        el('button', {class: 'b primary', disabled: x.open || !live.plan ? '' : null, onclick: () => this.accept()}, x.open ? 'Looks right (decide above first)' : 'Looks right: add to Changes'),
        el('button', {class: 'b', onclick: () => { this.close(); toast('Left as OSM has it'); }}, 'Not right')));
    P.append(d);
    this.syncMarkers();
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
    if (a.area && a.area.on && a.area.ring) out.push(line([...a.area.ring, a.area.ring[0]], {kind: 'area'}));
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
      // drawn as an area: the point's tags (as ticked) go onto it, with what's folded in and the doors' hours
      const A = a.area, areaOn = !!(A && A.on && A.ring && A.ring.length >= 3 && typeOf(main) === 'node');
      const areaTags = areaOn ? Carry.tags(this.now(main), {tags: {}}, () => true) : null;
      // the other station points
      for (const s of x.extra) {
        const v = (a.other || {})[s.id];
        if ((v === 'office' || v === 'same') && (!isPoint(s) || !isPoint(main))) { say(`"${s.tags.name || s.id}" or the station is drawn as a shape: change it in iD`); continue; }
        if (v === 'office') {
          const tags = this.notStation(s), drop = ['amenity', 'public_transport', 'bus'].filter(k => s.tags[k] && !(k in tags) && !(k === 'amenity' && s.tags.amenity !== 'bus_station'));
          Edits.modify(typeOf(s), osmNumId(s), nodeBase(s), {removeTags: drop, tags}, `${s.tags.name || s.id}: not a second station, ${name}`);
        } else if (v === 'same') {
          const add = Carry.tags(s, main, CARRY.station, {name: 'alt_name'});
          if (areaOn) Object.assign(areaTags, add);
          else if (Object.keys(add).length) Edits.modify(typeOf(main), osmNumId(main), nodeBase(main), {tags: add}, `${name}: station`);
          if (Object.values(Roads.rels).some(r => r.members.some(mm => mm.type === typeOf(s) && mm.ref === osmNumId(s)))) say(`"${s.tags.name || s.id}" is in a relation: not deleted`);
          else Edits.delete(typeOf(s), osmNumId(s), nodeBase(s), `${s.tags.name || s.id}: the same station as ${name}`);
        }
      }
      // things in the station: the doors' hours on the station, what's there with its hours and details, what's added
      const objs = new Map([...x.extra.map(o => this.now(o)), ...Object.values(live.things || {}).flat(), ...(main ? [this.now(main)] : [])].map(o => [o.id, o]));
      for (const [id, st] of Object.entries(a.edits || {})) {
        const o = objs.get(id);
        if (!o || !isPoint(o)) continue;
        if (areaOn && o.id === main.id) { if (st.oh) areaTags.opening_hours = st.oh; else delete areaTags.opening_hours; continue; }   // onto the area
        const tags = {}, removeTags = [];
        if ((st.oh || '') !== (o.tags.opening_hours || '')) { if (st.oh) tags.opening_hours = st.oh; else removeTags.push('opening_hours'); }
        for (const [k, v] of Object.entries(st.extra || {})) if (v && v !== o.tags[k]) tags[k] = v;
        if (!Object.keys(tags).length && !removeTags.length) continue;
        const kind = main && o.id === main.id ? null : THINGS.find(k => k.is({...o.tags, ...((a.other || {})[o.id] === 'office' ? this.notStation(o) : {})}));
        const key = Edits.modify(typeOf(o), osmNumId(o), nodeBase(o), {tags, removeTags}, `${o.tags.name || id}: ${kind ? kind.label.toLowerCase() : 'its hours'}`);
        Edits.ops[key].thing = kind ? `the ${kind.label.toLowerCase()}` : 'the station';
      }
      for (const k of THINGS) {
        const t = (a.things || {})[k.key];
        if (!t || !t.add || !t.at) continue;
        const tags = {...k.tags, ...(k.operator && main.tags.operator ? {operator: main.tags.operator} : {}), ...(t.oh ? {opening_hours: t.oh} : {}),
          ...Object.fromEntries(Object.entries(t.extra || {}).filter(([, v]) => v))};
        const key = Edits.createNode(t.at[1], t.at[0], tags, `${name}: ${k.label.toLowerCase()}`);
        Edits.ops[key].thing = k.label.toLowerCase();
      }
      if (areaOn) {
        const ids = A.ring.map(([lon, lat]) => Edits.ops[Edits.createNode(lat, lon, {}, `${name}: station area`)].id);
        const wkey = Edits.createWay(areaTags, [...ids, ids[0]], `${name}: station area`);
        Edits.ops[wkey].stationArea = name;
        members[0] = {key: wkey, role: ''};
        // the point: gone, its tags on the area; kept (and said) if another relation lists it
        const pt = this.now(main), in_ = Object.values(Roads.rels).filter(r => r.members.some(mm => mm.type === 'node' && mm.ref === osmNumId(main)));
        if (in_.length) say(`The station point is in ${in_.map(r => r.tags.name || 'r' + r.id).join(', ')}: kept; take it out there, then delete it`);
        else Edits.delete('node', osmNumId(main), nodeBase(pt), `${name}: the station point, now its area`);
      }
      for (const bd of (live.own || {}).buildings || []) {
        const v = (a.buildings || {})[bd.id] ?? this.buildingFor(bd);
        if (v && v !== bd.tags.building) { const k = Edits.modify('way', osmNumId(bd), {version: bd.version, tags: bd.tags, nodes: bd.nodes}, {tags: {building: v}}, `${bd.tags.name || bd.id}: building=${v}`); Edits.ops[k].building = v; }
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
      this.syncMarkers();
      render(); draw();
    } catch (e) { say(e.message); console.error(e); }
    finally { Edits.release(); }
  },
};
