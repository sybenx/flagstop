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
  // (a window: one of these may be at another's window, the same office: then it's one point, the others in its description)
  {key: 'lost', label: 'Lost and found', words: 'lost and found', tags: {amenity: 'lost_property_office'}, is: t => t.amenity === 'lost_property_office', hours: true, operator: true, window: true, extra: []},
  {key: 'info', label: 'Customer service or information desk', words: 'customer service and information', tags: {tourism: 'information', information: 'office'}, is: t => t.tourism === 'information' && t.information === 'office', hours: true, operator: true, window: true, extra: []},
  {key: 'tickets', label: 'Ticket window (sells tickets or passes)', words: 'tickets and passes', tags: {shop: 'ticket', 'tickets:public_transport': 'yes'}, is: t => t.shop === 'ticket' || t.amenity === 'ticket_office', hours: true, operator: true, window: true, extra: []},
  {key: 'machine', label: 'Ticket machine', tags: {amenity: 'vending_machine', vending: 'public_transport_tickets'}, is: t => t.amenity === 'vending_machine' && /ticket/.test(t.vending || ''), hours: false, operator: true,
    extra: [['payment:cards', ['yes', 'no']], ['payment:cash', ['yes', 'no']]]},
  {key: 'water', label: 'Drinking water', tags: {amenity: 'drinking_water'}, is: t => t.amenity === 'drinking_water', hours: false, extra: [['bottle', ['yes', 'no']]]},
  {key: 'bikes', label: 'Bike parking', tags: {amenity: 'bicycle_parking'}, is: t => t.amenity === 'bicycle_parking', hours: false, extra: [['bicycle_parking', ['stands', 'wall_loops', 'rack', 'shed', 'lockers']], ['covered', ['no', 'yes']], ['capacity', null]]},
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
    // what's built goes into the hours as it's built: no button to forget (the button stays, for the sure-minded)
    const write = () => { const v = this.build(rows, state.note); if (v) { state.oh = v; done(); } };
    const row = r => el('div', {class: 'btns', style: 'align-items:center;flex-wrap:wrap'},
      ...this.DAYS.map(dd => el('label', {class: 'small', style: 'margin-right:2px'}, el('input', {type: 'checkbox', checked: r.days.includes(dd) ? '' : null, onchange: e => { r.days = e.target.checked ? [...r.days, dd] : r.days.filter(x => x !== dd); write(); }}), dd)),
      el('input', {type: 'time', value: r.from, onchange: e => { r.from = e.target.value; write(); }}), '–', el('input', {type: 'time', value: r.to, onchange: e => { r.to = e.target.value; write(); }}),
      rows.length > 1 ? el('a', {href: '#', class: 'muted small', onclick: e => { e.preventDefault(); rows.splice(rows.indexOf(r), 1); done(); }}, 'remove') : null);
    return el('div', {class: 'small'}, el('div', {}, 'Hours ', txt, Hours.ok(state.oh) ? null : el('div', {style: 'color:var(--amb)'}, "That doesn't read as opening_hours: check it (the OSM wiki has the syntax).")),
      // (open stays open when the card is drawn again: adding a range, taking one out)
      el('details', {open: state.building ? '' : null, ontoggle: e => { state.building = e.target.open; }}, el('summary', {class: 'muted'}, 'build them'), ...rows.map(row),
        el('div', {class: 'btns'}, el('a', {href: '#', class: 'small', onclick: e => { e.preventDefault(); rows.push({days: ['Sa'], from: '', to: ''}); done(); }}, '+ another range'),
          el('input', {value: state.note || '', placeholder: 'note, e.g. often until 19:00', size: 22, onchange: e => { state.note = e.target.value.trim(); write(); }}),
          el('button', {class: 'b tiny primary', onclick: write}, 'Use these hours'))));
  },
};

const Station = {
  NEAR: 80,    // m: a platform this close to a station point is one of its bays
  SAME: 60,    // m: station points this close are one place
  SNAP: 30,    // m: furthest a stop position goes from its bay
  LANE: 4,     // m: a bay this far from the station's own roadway (service, busway) is at a curb of its own: a lane along it
  CURB: 2,     // m: a lane's middle from the curb (half a bus and a little)

  isStation: o => o.tags.amenity === 'bus_station' || o.tags.public_transport === 'station',
  isPlatform: o => o.tags.highway === 'bus_stop' || o.tags.public_transport === 'platform',
  /** Tags that say nothing of what a thing is: what iD's and RapiD's Extract leave on an area they take a point out of
   *  (area=yes, and a detail or two that stayed). */
  bare: t => Object.keys(t || {}).every(k => /^(area|type|wheelchair|source(:.*)?|note|fixme|check_date|created_by|layer|level|surface)$/.test(k)),
  drivable: t => /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|road)(_link)?$/.test((t || {}).highway || ''),

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
      // (the nearest the bay: one on a lane by its curb before one out on the roadway)
      const have = positions.filter(x => m(osmPos(x.o), best.point) <= 8 || m(osmPos(x.o), osmPos(b.o)) <= best.d).sort((u, v) => m(osmPos(u.o), osmPos(b.o)) - m(osmPos(v.o), osmPos(b.o)))[0];
      const shared = plan.find(x => x.point && m(x.point, best.point) <= 4);
      plan.push({bay: b, point: best.point, wid: best.wid, d: best.d, have: have && have.o, with: shared && shared.bay});
    }
    // what's in the station already, by kind: points and shapes within its reach
    // what's in the station already, by kind: inside the station (its area, if it's drawn as one; else the draft round
    // what's mapped as its own, which stops short of the neighbours), not merely near it (a store's bike rack over the way)
    const own = this.own(p);
    const outline = p.stations.map(x => x.id[0] !== 'n' && this.ringOf(x)).find(r => r && r.length >= 3) || own.ring;
    const things = {}, inner = outline.length >= 3 ? this.grow(this.hull(outline), 3) : null;
    // (what's the station's own by its tags, its operator's bike shed say, is in it wherever the outline runs)
    const ownIds = new Set(own.parts.map(w => w.id));
    const here = (ll, o) => (o && ownIds.has(o.id)) || (inner ? this.inside(ll, inner) : p.stations.some(st => m(osmPos(st), ll) <= 40));
    const cand = [...Object.values(Roads.nodes).filter(n => n.tags && Object.keys(n.tags).length).map(n => ({id: 'n' + n.id, tags: n.tags, lat: n.lat, lon: n.lon, version: n.version})),
      ...Object.values(Roads.ways).filter(w => w.tags && Object.keys(w.tags).length).map(w => { const n0 = Roads.nodes[w.nodes[0]]; return n0 && {id: 'w' + w.id, tags: w.tags, lat: n0.lat, lon: n0.lon, nodes: w.nodes, version: w.version}; }).filter(Boolean)];
    for (const k of THINGS) things[k.key] = cand.filter(o => k.is(o.tags) && here([o.lon, o.lat], o));
    const islands = this.islands(p), strays = this.strays(p), lanes = this.lanes(p, plan, islands);
    const husks = this.husks(p);
    S.station.live = {area, positions, plan, things, own, islands, strays, lanes, husks};
    render(); draw();
    // what each empty outline was: its history (a request each)
    await Promise.all(husks.map(h => this.was(h)));
    if (S.station && S.station.id === p.id) { render(); draw(); }
  },

  // ---------- what's drawn there: an empty outline, islands, stray platform lines, the bays' lanes ----------
  /** Rings of [lon, lat] from ways (a multipolygon's outers): joined end to end. */
  rings(ways) {
    const left = ways.map(w => [...w]).filter(w => w.length > 1), out = [];
    while (left.length) {
      let r = left.shift();
      for (let grew = true; grew && r[0] !== r[r.length - 1];) {
        grew = false;
        for (let i = 0; i < left.length; i++) {
          const w = left[i], e = r[r.length - 1];
          if (w[0] === e) r = [...r, ...w.slice(1)]; else if (w[w.length - 1] === e) r = [...r, ...[...w].reverse().slice(1)]; else continue;
          left.splice(i, 1); grew = true; break;
        }
      }
      if (r[0] === r[r.length - 1]) out.push(r);
    }
    return out.map(r => r.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat]));
  },
  /** Areas at the station that say nothing of what they are (only area=yes, say): what iD's Extract leaves when a
   *  point is taken out of an area. One round the station may be its own old outline (its history says). */
  husks(p) {
    const at = p.stations.map(st => { const w = st.id[0] === 'w' && Roads.ways[osmNumId(st)]; return w ? this.mid(w.nodes) : osmPos(st); });
    const own = new Set(p.stations.map(st => st.id));
    const out = [];
    for (const w of Object.values(Roads.ways)) {
      if (!w.tags || !w.tags.area || !this.bare(w.tags) || w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1] || own.has('w' + w.id)) continue;
      const ring = w.nodes.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat]);
      if (at.some(q => this.inside(q, ring))) out.push({id: 'w' + w.id, type: 'way', num: w.id, tags: w.tags, version: w.version, nodes: w.nodes, ring});
    }
    for (const r of Object.values(Roads.rels)) {
      if (r.tags.type !== 'multipolygon' || !this.bare(r.tags) || own.has('r' + r.id)) continue;
      const ws = r.members.filter(mm => mm.type === 'way' && mm.role !== 'inner').map(mm => Roads.ways[mm.ref]);
      if (ws.some(w => !w)) continue;   // a part outside what was read: not this place's
      const ring = this.rings(ws.map(w => w.nodes))[0];
      if (ring && at.some(q => this.inside(q, ring))) out.push({id: 'r' + r.id, type: 'relation', num: r.id, tags: r.tags, version: r.version, members: r.members, ring});
    }
    return out;
  },
  mid(nodes) { const ps = nodes.map(n => Roads.nodes[n]).filter(Boolean); return [ps.reduce((a, n) => a + n.lon, 0) / ps.length, ps.reduce((a, n) => a + n.lat, 0) / ps.length]; },
  /** What an empty outline was, before: its last version that said something, and the change after it. */
  async was(h) {
    try {
      const vs = (await (await fetch(`${OSM_API}/api/0.6/${h.type}/${h.num}/history.json`)).json()).elements;
      for (let i = vs.length - 1; i >= 0; i--) if (!this.bare(vs[i].tags)) {
        const after = vs[i + 1] || {};
        h.was = {version: vs[i].version, tags: vs[i].tags || {}, since: vs[0].timestamp.slice(0, 10), until: (after.timestamp || '').slice(0, 10), changeset: after.changeset};
        break;
      }
    } catch (e) { /* no history to go on: it's an empty outline, nothing more said */ }
    h.read = true;
  },
  /** Of two rings, how much they're the same place: the shared part over all of either (1: the same outline). */
  sameness(a, b) {
    const all = [...a, ...b], lo = [Math.min(...all.map(q => q[0])), Math.min(...all.map(q => q[1]))], hi = [Math.max(...all.map(q => q[0])), Math.max(...all.map(q => q[1]))];
    let both = 0, either = 0;
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
      const q = [lo[0] + (hi[0] - lo[0]) * i / 40, lo[1] + (hi[1] - lo[1]) * j / 40], x = this.inside(q, a), y = this.inside(q, b);
      if (x && y) both++; if (x || y) either++;
    }
    return either ? both / either : 0;
  },
  /** A platform drawn round two bays or more (an island, its building and flowerbeds too): the ground the bays stand
   *  on. Each bay is its own platform already, so this one is the walkable area, not a platform. */
  islands(p) {
    const bays = [...p.bays.map(b => b.o), ...p.others].filter(o => o.id[0] === 'n').map(osmPos);
    const near = q => p.stations.some(st => m(osmPos(st), q) <= this.NEAR * 1.5);
    return Object.values(Roads.ways).filter(w => w.tags && w.tags.public_transport === 'platform' && w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1])
      .map(w => ({id: 'w' + w.id, num: w.id, tags: w.tags, version: w.version, nodes: w.nodes, ring: w.nodes.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat])}))
      .filter(w => near(this.mid(w.nodes)) && bays.filter(q => this.inside(q, w.ring) || this.nearestOn(w.ring, q).d <= 2).length >= 2);
  },
  /** A platform line of a point or two with no name or code, by a bay: the same platform again, the bay's point saying it. */
  strays(p) {
    const bays = [...p.bays.map(b => b.o), ...p.others].filter(o => o.id[0] === 'n');
    const out = [];
    for (const w of Object.values(Roads.ways)) {
      const t = w.tags || {};
      if (t.public_transport !== 'platform' || w.nodes.length > 3 || w.nodes[0] === w.nodes[w.nodes.length - 1] || t.name || t.ref || t.local_ref) continue;
      const c = this.mid(w.nodes), bay = bays.map(o => ({o, d: m(osmPos(o), c)})).sort((x, y) => x.d - y.d)[0];
      if (!bay || bay.d > 25) continue;
      const rels = Object.values(Roads.rels).filter(r => r.tags.public_transport !== 'stop_area' && r.members.some(mm => mm.type === 'way' && mm.ref === w.id));
      out.push({id: 'w' + w.id, num: w.id, tags: t, version: w.version, nodes: w.nodes, bay: bay.o, d: Math.round(bay.d), rels});
    }
    return out;
  },

  /** The bays at a curb of their own, off the station's roadway (a wide apron, buses along each side of it): per side,
   *  a lane along that curb, joined to the roadway at both ends, for the bays' stop positions to be on. A draft:
   *  along the island's edge if one's drawn, else along the bays; its points dragged on the map. */
  lanes(p, plan, islands) {
    const cand = plan.filter(y => y.point && y.d >= this.LANE && /^(service|busway)$/.test((Roads.ways[y.wid].tags || {}).highway || ''));
    if (!cand.length) return [];
    const chains = this.chains([...new Set(cand.map(y => y.wid))]);
    const curbs = [...islands.map(w => w.ring), ...Object.values(Roads.ways).filter(w => w.tags && (w.tags.highway === 'pedestrian' || w.tags.area === 'yes') && w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1])
      .map(w => w.nodes.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat]))];
    const out = [];
    for (const ch of chains) {
      const P = ch.pts, cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + m(P[i - 1], P[i]));
      const at = s => { s = Math.max(0, Math.min(cum[cum.length - 1], s)); let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
        const f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [P[i - 1][0] + f * (P[i][0] - P[i - 1][0]), P[i - 1][1] + f * (P[i][1] - P[i - 1][1])]; };
      const sides = {};
      for (const y of cand.filter(y => ch.ways.includes(y.wid))) {
        const q = osmPos(y.bay.o), nr = this.nearestOn(P, q), a = P[nr.index], b = P[nr.index + 1];
        const k = Math.cos(q[1] * Math.PI / 180), cross = (b[0] - a[0]) * k * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) * k;
        (sides[cross > 0 ? 'left' : 'right'] = sides[cross > 0 ? 'left' : 'right'] || []).push({...y, s: cum[nr.index] + nr.t * m(a, b)});
      }
      for (const [side, g] of Object.entries(sides)) {
        if (g.length < 2) continue;   // a curb of bays: one off on its own is more likely a point a little off
        const lo = Math.min(...g.map(y => y.s)), hi = Math.max(...g.map(y => y.s));
        // the curb: the drawn edge the bays stand on
        const curb = curbs.map(r => ({r, d: g.reduce((a, y) => a + this.nearestOn([...r, r[0]], osmPos(y.bay.o)).d, 0) / g.length})).sort((x, y) => x.d - y.d)[0];
        const toward = (q, c, d) => { const L = m(q, c) || 1; return [q[0] + (c[0] - q[0]) * d / L, q[1] + (c[1] - q[1]) * d / L]; };
        let pts = [];
        if (curb && curb.d <= 3) {
          for (let s = lo - 4; s <= hi + 4; s += 5) {
            const c = at(s), nq = this.nearestOn([...curb.r, curb.r[0]], c);
            if (nq.d > this.CURB + 1 && nq.d < 30) pts.push(toward(nq.point, c, this.CURB));
          }
        } else pts = [...g].sort((x, y) => x.s - y.s).map(y => toward(osmPos(y.bay.o), y.point, Math.min(3, y.d - 1)));
        pts = this.simplify(pts, 1);
        if (!pts.length) continue;
        // the side, as a compass point: from the road to the bays' middle
        const mid = [g.reduce((a, y) => a + osmPos(y.bay.o)[0], 0) / g.length, g.reduce((a, y) => a + osmPos(y.bay.o)[1], 0) / g.length];
        out.push({key: `${ch.ways[0]}-${side}`, side: compass(this.nearestOn(P, mid).point, mid), bays: g.map(y => y.bay.o), ways: ch.ways, pts: [at(lo - 15), ...pts, at(hi + 15)]});
      }
    }
    return out;
  },
  /** Roads (way ids) joined end to end into lines: {ways, pts}. */
  chains(wids) {
    const left = wids.map(id => Roads.ways[id]).filter(Boolean), out = [];
    while (left.length) {
      let w0 = left.shift(), nodes = [...w0.nodes], ways = [w0.id];
      for (let grew = true; grew;) {
        grew = false;
        for (let i = 0; i < left.length; i++) {
          const n = left[i].nodes, a = nodes[0], b = nodes[nodes.length - 1];
          if (n[0] === b) nodes = [...nodes, ...n.slice(1)]; else if (n[n.length - 1] === b) nodes = [...nodes, ...[...n].reverse().slice(1)];
          else if (n[n.length - 1] === a) nodes = [...n.slice(0, -1), ...nodes]; else if (n[0] === a) nodes = [...[...n].reverse().slice(0, -1), ...nodes];
          else continue;
          ways.push(left[i].id); left.splice(i, 1); grew = true; break;
        }
      }
      out.push({ways, pts: nodes.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat])});
    }
    return out;
  },
  /** Fewer points, the same line within tol metres (Douglas-Peucker). */
  simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
    const go = (i, j) => { let best = -1, bd = tol;
      for (let k = i + 1; k < j; k++) { const d = this.nearestOn([pts[i], pts[j]], pts[k]).d; if (d > bd) { bd = d; best = k; } }
      if (best >= 0) { keep[best] = true; go(i, best); go(best, j); } };
    go(0, pts.length - 1);
    return pts.filter((_, i) => keep[i]);
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

  /** The lanes ticked, as drawn (their points as dragged). */
  lanesOn(live) {
    const A = (S.station && S.station.answers.lanes) || {};
    return ((live && live.lanes) || []).filter(L => A[L.key] && A[L.key].on && A[L.key].pts).map(L => ({...L, pts: A[L.key].pts}));
  },
  /** What the card proposes, from the place, the live look and the answers. */
  plan(p) {
    const a = S.station.answers, live = S.station.live || {};
    const main = p.stations.length === 1 ? p.stations[0] : p.stations.find(x => x.id === a.main);
    const extra = p.stations.filter(x => x !== main);
    // a bay with a lane drawn along its curb has its stop position on the lane (with the lane), not on the roadway
    const laned = new Set(this.lanesOn(live).flatMap(L => L.bays.map(b => b.id)));
    const newPos = (live.plan || []).filter(x => x.point && !x.have && !x.with && !laned.has(x.bay.o.id));
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
    const haveOf = Object.fromEntries(THINGS.map(k => [k.key, [...(live.things[k.key] || []), ...(k.key === 'lost' ? office : [])]]));
    // the new ones, each its own entry ({kind, at, oh, extra, same}): a kind can be there more than once (bike racks)
    const fresh = k => Object.entries(T).filter(([, t]) => t.kind === k.key);
    for (const k of THINGS) {
      const have = haveOf[k.key], mine = fresh(k);
      const row = el('div', {class: 'decide'}, el('div', {}, el('b', {}, k.label), have.length || mine.length ? '' : el('span', {class: 'muted'}, ' — none in OSM here')));
      for (const o of have) {
        const st = E[o.id] = E[o.id] || {oh: o.tags.opening_hours || '', extra: {}};
        row.append(el('div', {style: 'margin-top:4px'}, 'There: ', el('a', {href: osmLink(o.id), target: '_blank'}, o.tags.name || o.id),
          el('span', {class: 'muted'}, o.tags.opening_hours ? ` · ${o.tags.opening_hours}` : k.hours ? ' · no hours in OSM' : ''),
          // a point that's in the wrong spot: a marker to drag it where it is
          o.id[0] === 'n' ? el('a', {href: '#', class: 'small', style: 'margin-left:8px', onclick: e => { e.preventDefault(); st.at = st.at ? null : [o.lon, o.lat]; re(); }},
            st.at ? 'leave it where it is' : 'move it') : null,
          st.at ? el('div', {class: 'muted small'}, 'On the map: drag its marker to where it is.') : null),
          ...[k.hours ? Hours.editor(st, re) : null, this.extras(k, o.tags, st)].filter(Boolean));   // (DOM append writes 'null')
      }
      for (const [eid, t] of mine) {
        const sub = el('div', {style: 'margin-top:6px;padding-left:8px;border-left:2px solid var(--edit)'}, el('div', {}, 'New',
          el('a', {href: '#', class: 'muted small', style: 'margin-left:8px', onclick: e => { e.preventDefault(); delete T[eid]; re(); }}, 'take it out')));
        // a window: at another's window, the same office? Then it's that point (one office, one point), said in its description
        const at = k.window ? [
          ...THINGS.filter(j => j.window && j !== k).flatMap(j => haveOf[j.key].map(o => ({v: 'id:' + o.id, label: `${j.label} (${o.tags.name || 'there'})`}))),
          ...Object.entries(T).filter(([id, u]) => id !== eid && !u.same && (THINGS.find(j => j.key === u.kind) || {}).window && u.kind !== k.key).map(([id, u]) => ({v: 'new:' + id, label: `${THINGS.find(j => j.key === u.kind).label} (new)`}))] : [];
        if (t.same && !at.some(x => x.v === t.same)) t.same = '';
        if (at.length) sub.append(el('div', {class: 'small'}, 'Is it ', el('select', {class: 'b', onchange: e => { t.same = e.target.value; re(); }},
          el('option', {value: ''}, 'a window of its own'), ...at.map(x => el('option', {value: x.v, selected: t.same === x.v ? '' : null}, `at the same window as: ${x.label}`))), '?'));
        if (t.same) sub.append(el('div', {class: 'muted small'}, `One office, one point: no point of its own; the other's description says it does ${k.words} too, and its hours are the office's.`));
        else sub.append(...[el('div', {class: 'muted small'}, 'On the map: drag its marker to where it is.'), k.hours ? Hours.editor(t, re) : null, this.extras(k, {}, t)].filter(Boolean));
        row.append(sub);
      }
      row.append(el('div', {style: 'margin-top:4px'}, el('a', {href: '#', class: 'small', onclick: e => { e.preventDefault();
        const n = Object.keys(T).length + 1, eid = `${k.key}-${Date.now().toString(36)}-${n}`;
        T[eid] = {kind: k.key, oh: '', extra: {}, at: this.spot(p, main, k, mine.length)}; re(); }}, `+ add ${mine.length || have.length ? 'another' : 'one'}`)));
      box.append(row);
    }
    return box;
  },
  // ---------- the station as an area ----------
  /** What's being drawn on the map: the station's outline (closed), the bays' lanes (open, their ends on a road). */
  shapes() {
    const a = S.station && S.station.answers;
    if (!a) return [];
    const out = [];
    if (a.area && a.area.on && a.area.ring && (a.outline || 'draw') === 'draw') out.push({key: 'area', pts: a.area.ring, closed: true});
    for (const [k, L] of Object.entries(a.lanes || {})) if (L.on && L.pts) out.push({key: 'lane:' + k, pts: L.pts, closed: false});
    return out;
  },
  shape(key) { return this.shapes().find(s => s.key === key); },
  /** A corner more, where the line was double-clicked: in the side nearest the click. */
  addCorner(q, key = 'area') {
    const sh = this.shape(key);
    if (!sh) return;
    const near = this.nearestOn(sh.closed ? [...sh.pts, sh.pts[0]] : sh.pts, q);
    sh.pts.splice(near.index + 1, 0, near.point);
    this.syncMarkers(true); render(); draw(); syncHash();
  },
  /** The corner at a point on screen (within 12 px): {key, i}, or null. */
  cornerAt(pt) {
    for (const sh of this.shapes()) {
      const i = sh.pts.findIndex(q => { const p = map.project(q); return Math.hypot(p.x - pt.x, p.y - pt.y) < 12; });
      if (i >= 0) return {key: sh.key, i};
    }
    return null;
  },
  /** A corner fewer: an area keeps three at least; a lane its two ends (each on a road), and a point between. */
  removeCorner(key, i) {
    const sh = this.shape(key);
    if (!sh) return;
    if (sh.closed && sh.pts.length <= 3) return toast('An area needs three corners at least', 3000);
    if (!sh.closed && (i === 0 || i === sh.pts.length - 1)) return toast("That's the lane's end, on the road: drag it along the road instead", 4000);
    if (!sh.closed && sh.pts.length <= 3) return toast('A lane needs a point between its ends', 3000);
    sh.pts.splice(i, 1);
    this.syncMarkers(true); render(); draw(); syncHash();
  },
  /** The nearest point on a road buses can drive, within d metres of q: {point, wid, d}, or null. */
  onRoad(q, d = 15) {
    let best = null;
    for (const w of Object.values(Roads.ways)) {
      if (!this.drivable(w.tags)) continue;
      const nr = this.nearestOn(w.nodes.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat]), q);
      if (nr && nr.d <= d && (!best || nr.d < best.d)) best = {...nr, wid: w.id};
    }
    return best;
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
  /** An empty outline at the station that was the station, its history says: {h, how} with the answer, or null. */
  oldOutline(live) {
    const h = (live.husks || []).find(h => h.was && this.isStation({tags: h.was.tags}));
    return h || null;
  },
  /** The station's outline: an empty one there that was the station (its tags back on it keeps its history); else
   *  one drawn here; and an empty outline that wasn't, offered to go. */
  outlineBox(p, x) {
    const a = S.station.answers, main = x.main || (p.stations.length === 1 ? p.stations[0] : null), live = x.live || {};
    if (!main || !live.own) return null;
    const old = this.oldOutline(live), isNode = typeOf(main) === 'node', re = () => { render(); draw(); syncHash(); };
    const others = (live.husks || []).filter(h => h !== old);
    if (!old && !others.length) return isNode ? this.areaBox(p, x) : null;
    const box = (!old && isNode && this.areaBox(p, x)) || el('div', {class: 'fixstep'}, el('div', {class: 'k'}, 'The station as an area'));
    const link = h => el('a', {href: osmLink(h.id), target: '_blank'}, `${h.type} ${h.num}`);
    const go = h => el('a', {href: '#', class: 'small', style: 'margin-left:6px', onclick: e => { e.preventDefault(); fit(h.ring, 60); }}, 'show it');
    if (old) {
      const w = old.was, said = Object.entries(w.tags).filter(([k]) => /^(amenity|public_transport|name)$/.test(k)).map(([k, v]) => `${k}=${v}`).join(', ');
      box.append(el('div', {class: 'why'}, `OSM has the station's own outline here, emptied: `, link(old), ` (dashed on the map)`, go(old), `. It was the station (${said}) from ${w.since} until changeset `,
        el('a', {href: `${OSM_WWW}/changeset/${w.changeset}`, target: '_blank'}, String(w.changeset)), ` (${w.until}) moved its tags off it, leaving ${Object.entries(old.tags).map(([k, v]) => `${k}=${v}`).join(', ') || 'nothing'}: what iD's and RapiD's Extract leave behind. Its tags back on it keep the station's history with the station.`));
      const pick = (v, label) => el('button', {class: 'b tiny' + (a.outline === v ? ' chosen' : ''), onclick: () => { a.outline = v; re(); }}, (a.outline === v ? '✓ ' : '') + label);
      if (isNode) {
        if (a.outline == null) a.outline = 'old';
        box.append(el('div', {class: 'btns'}, pick('old', 'Its old outline back'), pick('draw', 'Draw a new one'), pick('point', 'Leave it a point')));
        if (a.outline === 'old') box.append(Carry.box(this.now(main), {id: old.id, tags: old.tags}, () => true, {title: `${main.tags.name || 'The point'}'s tags`, lead: `the point goes; ticked goes onto its old outline, ${old.type} ${old.num}:`}),
          el('div', {class: 'muted small'}, 'The stop area lists the outline instead of the point.'));
        if (a.outline === 'draw') { const ab = this.areaBox(p, x, true); if (ab) box.append(ab); }
      } else {
        // the station drawn as an area already: the old outline, or this one; one of them, not both
        const close = this.sameness(old.ring, this.ringOf(main) || []);
        if (a.outline == null) a.outline = close >= 0.7 ? 'back' : old.type === 'relation' ? 'shape' : 'drop';
        box.append(el('div', {class: 'why'}, `The station is drawn as an area too: ${main.id.replace(/^w/, 'way ')}, ${Math.round(close * 100)}% the same place. One outline, not two:`),
          el('div', {class: 'btns'}, pick('back', 'The old outline back, this one removed'), old.type === 'relation' ? pick('shape', "The old outline, in this one's shape") : null, pick('drop', 'Keep this one, the empty one deleted'), pick('leave', 'Leave both')));
        const into = {id: old.id, tags: old.tags};
        if (a.outline === 'back') box.append(Carry.box(this.now(main), into, () => true, {title: `${main.tags.name || 'This outline'}'s tags`, lead: `it's deleted, and its corners; ticked goes onto ${old.type} ${old.num}:`}));
        if (a.outline === 'shape') box.append(Carry.box(this.now(main), into, () => true, {title: `${main.tags.name || 'This outline'}'s tags`, lead: `it stays, as the relation's outline, untagged; ticked goes onto relation ${old.num}:`}),
          el('div', {class: 'muted small'}, 'A relation round one closed way: right, if plainer drawn as the way alone. It keeps both histories.'));
        if (a.outline === 'drop') box.append(el('div', {class: 'muted small'}, `${old.type === 'relation' ? `Relation ${old.num} goes, and its ways` : `Way ${old.num} goes, and its corners`} that nothing else uses.`));
      }
      if (isNode) { const b = this.buildingsPart(live); if (b) box.append(b); }
    }
    // an empty outline with no station in its history: what it was, and a way to remove it
    for (const h of others) {
      const g = a.gone[h.id] === 'remove';
      box.append(el('div', {class: 'decide'}, el('div', {}, el('b', {}, 'An empty outline here: '), link(h), go(h)),
        el('div', {class: 'small muted'}, `${Object.entries(h.tags).map(([k, v]) => `${k}=${v}`).join(', ')}${h.was ? `; it was ${Object.entries(h.was.tags).filter(([k]) => !/^(area|type)$/.test(k)).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', ')} until ${h.was.until}` : h.read ? '; never more than that' : ''}.`),
        el('div', {class: 'btns'}, el('button', {class: 'b tiny' + (g ? ' chosen' : ''), onclick: () => { a.gone[h.id] = g ? null : 'remove'; re(); }}, (g ? '✓ ' : '') + 'Delete it'),
          el('button', {class: 'b tiny' + (!g ? ' chosen' : ''), onclick: () => { a.gone[h.id] = null; re(); }}, (!g ? '✓ ' : '') + 'Leave it'))));
    }
    return box;
  },
  /** A way's ring of [lon, lat], read live. */
  ringOf(o) {
    if (o.id[0] === 'r') { const r = Roads.rels[osmNumId(o)], ws = r && r.members.filter(mm => mm.type === 'way' && mm.role !== 'inner').map(mm => Roads.ways[mm.ref]);
      return ws && ws.length && ws.every(Boolean) ? this.rings(ws.map(w => w.nodes))[0] || null : null; }
    const w = o.id[0] === 'w' && Roads.ways[osmNumId(o)]; return w ? w.nodes.map(n => Roads.nodes[n]).filter(Boolean).map(n => [n.lon, n.lat]) : null;
  },
  /** Islands (a platform round several bays) as the walkable ground they are; each tag shown, with a keep option. */
  islandsBox(p, x) {
    const live = x.live || {}, a = S.station.answers, I = a.islands = a.islands || {}, re = () => { render(); draw(); };
    if (!(live.islands || []).length && !(live.strays || []).length) return null;
    const box = el('div', {class: 'fixstep'}, el('div', {class: 'k'}, 'Platforms'),
      el('div', {class: 'why'}, "Each bay is a platform already (its point, with its code and routes). A platform drawn round several bays, an island with its building and flowerbeds, is the ground they stand on: a walkable area (highway=pedestrian + area=yes), not one more platform with no name."));
    for (const w of live.islands || []) {
      const on = I[w.id] !== 'leave', n = [...p.bays.map(b => b.o), ...p.others].filter(o => o.id[0] === 'n' && (this.inside(osmPos(o), w.ring) || this.nearestOn(w.ring, osmPos(o)).d <= 2)).length;
      const pick = (v, label) => el('button', {class: 'b tiny' + ((I[w.id] || 'walk') === v ? ' chosen' : ''), onclick: () => { I[w.id] = v; re(); }}, ((I[w.id] || 'walk') === v ? '✓ ' : '') + label);
      box.append(el('div', {class: 'decide'}, el('div', {}, el('a', {href: osmLink(w.id), target: '_blank'}, `way ${w.num}`), ` round ${n} bays`,
        el('a', {href: '#', class: 'small', style: 'margin-left:6px', onclick: e => { e.preventDefault(); fit(w.ring, 60); }}, 'show it'), w.tags.area ? null : el('span', {class: 'muted small'}, ' (no area=yes: read as a loop of line by some)')),
        el('div', {class: 'btns'}, pick('walk', 'A walkable area'), pick('leave', 'Leave it a platform')),
        on ? Carry.box({id: w.id, tags: w.tags}, {id: w.id, tags: {highway: 'pedestrian', area: 'yes'}}, CARRY.island, {title: 'Its tags', lead: 'ticked stay on it; the bays have their own (their bench, shelter, sign):'}) : null));
    }
    for (const w of live.strays || []) {
      const g = a.gone[w.id] !== 'leave';
      box.append(el('div', {class: 'decide'}, el('div', {}, el('a', {href: osmLink(w.id), target: '_blank'}, `way ${w.num}`), `: a platform line of ${w.nodes.length} points, no name or code, ${w.d} m from ${w.bay.tags.name || w.bay.id}`,
        el('a', {href: '#', class: 'small', style: 'margin-left:6px', onclick: e => { e.preventDefault(); frame([this.mid(w.nodes), osmPos(w.bay)], 20); }}, 'show it')),
        w.rels.length ? el('div', {class: 'small muted'}, `${w.rels.map(r => r.tags.name || 'r' + r.id).join(', ')} list${w.rels.length > 1 ? '' : 's'} it: left as it is (take it out there first).`) : el('div', {},
          el('div', {class: 'btns'}, el('button', {class: 'b tiny' + (g ? ' chosen' : ''), onclick: () => { a.gone[w.id] = null; re(); }}, (g ? '✓ ' : '') + 'Delete it: the bay is the platform'),
            el('button', {class: 'b tiny' + (!g ? ' chosen' : ''), onclick: () => { a.gone[w.id] = 'leave'; re(); }}, (!g ? '✓ ' : '') + 'Leave it')),
          g ? Carry.box({id: w.id, tags: w.tags}, this.now(w.bay), CARRY.stop, {title: 'Its tags'}) : null)));
    }
    return box;
  },
  /** Bays at a curb of their own, off the roadway: a lane along it, the bays' stop positions on it. */
  lanesBox(p, x) {
    const live = x.live || {}, a = S.station.answers, A = a.lanes = a.lanes || {}, re = () => { this.syncMarkers(true); render(); draw(); syncHash(); };
    if (!(live.lanes || []).length) return null;
    const box = el('div', {class: 'fixstep'}, el('div', {class: 'k'}, 'The bays and the road to them'),
      el('div', {class: 'why'}, `Buses here stop at the curbs of a wide paved area, off the one road drawn through it. A lane along each curb (highway=busway, one lane, either way), joined to that road at both ends, says where they drive and halt: each bay gets its stop position on it, and routes run along the lane their bay is on (each route as you review it).`));
    for (const L of live.lanes) {
      const st = A[L.key] = A[L.key] || {on: false, pts: null}, names = L.bays.map(b => (b.tags.name || b.id).replace(/^.* - /, '')).join(', ');
      box.append(el('div', {class: 'decide'}, el('label', {}, el('input', {type: 'checkbox', checked: st.on ? '' : null, onchange: e => { st.on = e.target.checked; if (st.on && !st.pts) st.pts = L.pts.map(q => [...q]); re(); }}),
        ` A lane along the ${L.bays.length} bays on the ${L.side} side: `, el('span', {class: 'muted'}, names)),
        st.on ? el('div', {class: 'muted small'}, `${st.pts.length} points on the map: drag them to the middle of the lane (imagery helps); the square ends go along the road it joins. Double-click the line for a point more, a point to remove it. `,
          el('a', {href: '#', onclick: e => { e.preventDefault(); st.pts = L.pts.map(q => [...q]); re(); }}, 'start again')) : null));
    }
    return box;
  },
  areaBox(p, x, inner = false) {
    const a = S.station.answers, main = x.main || (p.stations.length === 1 ? p.stations[0] : null), live = x.live || {};
    if (!main || typeOf(main) !== 'node' || !live.own) return null;
    const A = a.area = a.area || {on: false, ring: null}, own = live.own, re = () => { render(); draw(); };
    if (inner && !A.on) { A.on = true; if (!A.ring) A.ring = own.ring.map(q => [...q]); }
    const box = inner ? el('div', {}) : el('div', {class: 'fixstep'}, el('div', {class: 'k'}, 'The station as an area'),
      el('div', {class: 'why'}, `${main.tags.name || 'The station'} is a point. A station is best an area round the whole place: OSM has ${own.parts.length} things mapped as this one's (platforms, shelters, buildings) to draw it round.`),
      el('label', {}, el('input', {type: 'checkbox', checked: A.on ? '' : null, onchange: e => { A.on = e.target.checked; if (A.on && !A.ring) A.ring = own.ring.map(q => [...q]); re(); }}),
        ' Draw it as an area: a draft round what\'s mapped there, its corners dragged to the edge of the site (imagery helps)'));
    if (A.on) {
      box.append(el('div', {class: 'muted small'}, `${A.ring.length} corners on the map: drag them to the edge of the site; double-click the line for a corner more; drop a corner on another, or double-click it, to remove it. `, el('a', {href: '#', onclick: e => { e.preventDefault(); A.ring = own.ring.map(q => [...q]); this.syncMarkers(true); re(); }}, 'start again')),
        Carry.box(this.now(main), {id: 'the area', tags: {}}, () => true, {title: `The point's tags, onto the area`}),
        el('div', {class: 'muted small'}, 'The point goes; the stop area lists the area instead.'));
    }
    if (!inner) { const b = this.buildingsPart(live); if (b) box.append(b); }
    return box;
  },
  /** The station's buildings, and what each is (building=*), as suggested or chosen. */
  buildingsPart(live) {
    const B = S.station.answers.buildings = S.station.answers.buildings || {}, own = live.own;
    if (!own || !own.buildings.length) return null;
    const box = el('div', {}, el('div', {style: 'margin-top:6px'}, el('b', {}, 'Its buildings')));
    for (const b of own.buildings) {
      const sug = this.buildingFor(b), cur = B[b.id] ?? sug ?? '';
      box.append(el('div', {class: 'small', style: 'margin:3px 0'}, el('a', {href: osmLink(b.id), target: '_blank'}, b.tags.name || b.id), ` building=${b.tags.building} `,
        el('select', {class: 'b', onchange: e => { B[b.id] = e.target.value; }}, ...[['', 'leave it'], ['transportation', 'transportation (the station\'s own)'], ['office', 'office'], ['commercial', 'commercial'], ['retail', 'retail'], ['service', 'service (a shed, a plant room)']]
          .map(([v, l]) => el('option', {value: v, selected: cur === v ? '' : null}, v ? `→ ${l}` : l))),
        sug ? el('span', {class: 'muted'}, ` (suggested: ${sug}${sug === 'office' ? ', it says office=' + b.tags.office : ''})`) : null));
    }
    return box;
  },

  /** An OSM object as OSM has it now, where the card's live look read it (an upload since the data here was built
   *  shows), else as the data here has it. */
  now(o) {
    const r = o.id[0] === 'n' ? Roads.nodes[osmNumId(o)] : o.id[0] === 'w' ? Roads.ways[osmNumId(o)] : Roads.rels[osmNumId(o)];
    return r && r.tags ? {...o, tags: r.tags, version: r.version ?? o.version, ...(r.members ? {members: r.members} : {}), ...(r.nodes ? {nodes: r.nodes} : {})} : o;
  },
  /** What an edit of its tags starts from: a node's position, a way's nodes, a relation's members (else the upload
   *  would empty it); null when they aren't known. */
  baseOf(o) {
    if (o.id[0] === 'n') return nodeBase(o);
    if (o.id[0] === 'w') return Array.isArray(o.nodes) && o.nodes.length > 1 ? nodeBase(o) : null;
    return Array.isArray(o.members) && o.members.length ? {version: o.version, tags: o.tags, members: o.members} : null;
  },
  /** A kind's few details: a choice, or a number. Left at "—" (or OSM's own, in brackets), nothing changes. */
  extras(k, tags, st) {
    if (!k.extra.length) return null;
    return el('div', {class: 'btns small', style: 'align-items:center;flex-wrap:wrap'}, ...k.extra.map(([key, vals]) => el('label', {}, `${key} `, vals
      ? el('select', {class: 'b', onchange: e => { st.extra[key] = e.target.value; }}, el('option', {value: ''}, tags[key] ? `(${tags[key]})` : '—'), ...vals.map(v => el('option', {value: v, selected: st.extra[key] === v ? '' : null}, v)))
      : el('input', {size: 4, value: st.extra[key] ?? tags[key] ?? '', onchange: e => { st.extra[key] = e.target.value.trim(); }}))));
  },
  /** Where a new thing starts: a few metres from the station point, each kind its own way round, to be dragged. */
  spot(p, main, k, nth = 0) {
    const c = osmPos(main || p.stations[0]), ang = THINGS.indexOf(k) * 2 * Math.PI / THINGS.length + nth * 0.35, d = 10 + nth * 4;
    return [c[0] + d * Math.cos(ang) / (111320 * Math.cos(c[1] * Math.PI / 180)), c[1] + d * Math.sin(ang) / 110540];
  },
  /** The new things' markers on the map, draggable: one per ticked kind, gone when unticked or the card closes. */
  markers: {},
  moving: {},
  corners: [],
  syncMarkers(again) {
    // the corners of what's being drawn (the outline, the lanes): one draggable dot each
    const shapes = this.shapes(), sig = shapes.map(s => `${s.key}:${s.pts.length}`).join('|');
    if (again || sig !== this.cornerSig) { for (const c of this.corners) c.remove(); this.corners = []; this.cornerSig = sig; }
    if (!this.corners.length) for (const sh of shapes) sh.pts.forEach((q, i) => {
      const end = !sh.closed && (i === 0 || i === sh.pts.length - 1), dot = document.createElement('div');
      dot.style.cssText = `width:${end ? 16 : 14}px;height:${end ? 16 : 14}px;border-radius:${end ? '3px' : '50%'};background:${css('--edit')};border:2px solid #fff;box-shadow:0 0 2px #000;cursor:grab`;
      dot.title = sh.closed ? 'Drag to the edge of the site; double-click to remove' : end ? "The lane's end: drag it along the road it joins" : 'Drag to the middle of the lane; double-click to remove';
      dot.addEventListener('dblclick', e => { e.stopPropagation(); e.preventDefault(); this.removeCorner(sh.key, i); });
      const mk = new maplibregl.Marker({element: dot, draggable: true}).setLngLat(q).addTo(map);
      let from = q;
      mk.on('dragstart', () => { from = [...sh.pts[i]]; });
      mk.on('drag', () => { const ll = mk.getLngLat(); sh.pts[i] = [ll.lng, ll.lat]; draw(); });
      mk.on('dragend', () => {
        // a lane's end stays on a road: dropped near one, onto it; away from any, back where it was
        if (end) { const r = this.onRoad(sh.pts[i]); sh.pts[i] = r ? r.point : from; mk.setLngLat(sh.pts[i]); if (!r) toast("A lane's end goes on a road", 3000); draw(); syncHash(); return; }
        // dropped onto another corner: the two are one (the one dragged goes)
        const at = map.project(mk.getLngLat()), on = sh.pts.findIndex((r, j) => j !== i && Math.hypot(map.project(r).x - at.x, map.project(r).y - at.y) < 12);
        if (on >= 0) return this.removeCorner(sh.key, i);
        syncHash();
      });
      this.corners.push(mk);
    });
    // things already there, being moved: one marker each
    const E = (S.station && S.station.answers.edits) || {};
    for (const k of Object.keys(this.moving)) if (!(E[k] && E[k].at)) { this.moving[k].remove(); delete this.moving[k]; }
    for (const [id, st] of Object.entries(E)) {
      if (!st.at || this.moving[id]) continue;
      const mk = new maplibregl.Marker({draggable: true, color: css('--edit')}).setLngLat(st.at).addTo(map);
      mk.on('dragend', () => { const ll = mk.getLngLat(); st.at = [ll.lng, ll.lat]; syncHash(); });
      this.moving[id] = mk;
    }
    const T = (S.station && S.station.answers.things) || {};
    for (const k of Object.keys(this.markers)) if (!(T[k] && T[k].kind && !T[k].same)) { this.markers[k].remove(); delete this.markers[k]; }
    for (const [k, t] of Object.entries(T)) {
      if (!t.kind || t.same || this.markers[k]) continue;
      const kind = THINGS.find(x => x.key === t.kind);
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
    for (const b of [this.outlineBox(p, x), this.islandsBox(p, x), this.lanesBox(p, x)]) if (b) d.append(b);
    // what flagstop would do
    const ul = el('ul', {class: 'mergelist'});
    if (live.plan) {
      const members = 1 + p.bays.length + p.others.length + (a.stopPos ? x.newPos.length : 0) + (live.positions || []).filter(y => y.routes.length || (live.plan || []).some(z => z.have === y.o)).length;
      const plats = p.bays.length + p.others.length;
      ul.append(el('li', {}, live.area ? `add what's missing to the stop area r${live.area.id}` : `group them in a stop area "${name}": the station, its ${plats} platforms (the ${p.bays.length} bays the agency's stops match, and ${p.others.length} more: other networks', or not matched yet) and the stop positions, ${members} members`));
      if (x.newPos.length || (live.plan || []).some(y => y.none)) ul.append(el('li', {}, el('label', {}, el('input', {type: 'checkbox', checked: a.stopPos ? '' : null, onchange: e => { a.stopPos = e.target.checked; render(); draw(); }}),
        ` add a stop position for ${x.newPos.length} bay${x.newPos.length === 1 ? '' : 's'}, on the road its buses use, level with the bay (teal on the map)`),
        ...(live.plan || []).filter(y => y.none).map(y => el('div', {class: 'muted small'}, `${y.bay.o.tags.name || y.bay.o.id}: none, ${y.none}.`))));
      for (const L of this.lanesOn(live)) ul.append(el('li', {}, `add a bus lane along ${L.bays.length} bay${L.bays.length > 1 ? 's' : ''} (${L.pts.length} points, joined to the road at both ends), with a stop position on it for each`));
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
    for (const sh of this.shapes()) out.push(line(sh.closed ? [...sh.pts, sh.pts[0]] : sh.pts, {kind: sh.closed ? 'area' : 'lane', shape: sh.key}));
    // the bays' stop positions on a lane: where each would go
    for (const L of this.lanesOn(x.live)) for (const b of L.bays) { const q = this.nearestOn(L.pts.slice(1, -1).length > 1 ? L.pts.slice(1, -1) : L.pts, osmPos(b)).point; out.push(point(q, {kind: 'new', label: ''})); out.push(line([osmPos(b), q], {kind: 'new'})); }
    // an empty outline: where it runs (the station's old one, its history says, maybe)
    for (const h of x.live.husks || []) out.push(line(h.ring, {kind: 'old'}));
    return out;
  },

  /** A lane's end: the point on a road there (a new one in it, or one it has within 1.5 m). The road isn't split: a
   *  point more leaves every route on it whole, and a route turning onto the lane is split there when it's built
   *  (as reviewed, route by route). skip: the lanes drawn in this same go. */
  joinAt(t, q, skip = new Set()) {
    let best = null;
    for (const wid of t.wayIds()) {
      const w = t.way(wid);
      if (!w || skip.has(wid) || !this.drivable(w.tags)) continue;
      const nr = this.nearestOn(w.nodes.map(n => Roads.ll(t, n)), q);
      if (nr && (!best || nr.d < best.d)) best = {...nr, wid};
    }
    if (!best || best.d > 3) throw new Error("A lane's end isn't on a road: drag its square end onto one");
    const w = t.way(best.wid);
    return [w.nodes[best.index], w.nodes[best.index + 1]].find(n => m(Roads.ll(t, n), best.point) < 1.5) ?? Roads.insert(t, best.wid, best.index, best.point);
  },
  /** A shape deleted, with its corners nothing else uses (a relation: its ways nothing else uses). Kept, and said, if
   *  a relation other than this one or the stop area lists it. quiet: part of something going, kept without a word. */
  async dropShape(h, note, exceptRel = null, quiet = false) {
    const area = (S.station && S.station.live && S.station.live.area || {}).id;
    let rels = [];
    try { rels = (await (await fetch(`${OSM_API}/api/0.6/${h.type}/${h.num}/relations.json`)).json()).elements.filter(e => e.id !== exceptRel && e.id !== area); }
    catch (e) { rels = Object.values(Roads.rels).filter(r => r.id !== exceptRel && r.id !== area && r.members.some(mm => mm.type === h.type && mm.ref === h.num)); }
    if (rels.length) { if (!quiet) toast(`${h.type} ${h.num} is in ${rels.map(r => (r.tags || {}).name || 'r' + r.id).join(', ')}: kept`, 6000); return false; }
    const base = h.type === 'relation' ? {version: h.version, tags: h.tags, members: h.members} : {version: h.version, tags: h.tags, nodes: h.nodes};
    Edits.ops[Edits.delete(h.type, h.num, base, note)].station = 'gone';
    if (h.type === 'way') for (const n of new Set(h.nodes)) {
      const nd = Roads.nodes[n];
      if (!nd || Object.keys(nd.tags || {}).length || Object.values(Roads.ways).some(w => w.id !== h.num && w.nodes.includes(n)) ||
        Object.values(Roads.rels).some(r => r.members.some(mm => mm.type === 'node' && mm.ref === n)) || Edits.get('n' + n)) continue;
      Edits.ops[Edits.delete('node', n, {version: nd.version, tags: nd.tags, lat: nd.lat, lon: nd.lon}, note)].station = 'gone';
    }
    if (h.type === 'relation') for (const mm of h.members) {
      const w = mm.type === 'way' && Roads.ways[mm.ref];
      if (w && !Object.keys(w.tags || {}).length) await this.dropShape({type: 'way', num: w.id, id: 'w' + w.id, tags: w.tags, version: w.version, nodes: w.nodes}, note, h.num, true);
    }
    return true;
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
      const old = this.oldOutline(live), how = old ? a.outline : null;
      const A = a.area, areaOn = !!(A && A.on && A.ring && A.ring.length >= 3 && typeOf(main) === 'node' && (!old || how === 'draw'));
      const goneRefs = new Set();   // what leaves the stop area: 'w123', 'r45'
      const toOld = !!(old && ['old', 'back', 'shape'].includes(how)), oldExtra = {};   // the station's tags going onto its old outline
      let ohMain = null;
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
          else if (toOld) Object.assign(oldExtra, add);
          else if (Object.keys(add).length) Edits.modify(typeOf(main), osmNumId(main), nodeBase(main), {tags: add}, `${name}: station`);
          if (Object.values(Roads.rels).some(r => r.members.some(mm => mm.type === typeOf(s) && mm.ref === osmNumId(s)))) say(`"${s.tags.name || s.id}" is in a relation: not deleted`);
          else Edits.delete(typeOf(s), osmNumId(s), nodeBase(s), `${s.tags.name || s.id}: the same station as ${name}`);
        }
      }
      // things in the station: the doors' hours on the station, what's there with its hours and details, what's added
      const objs = new Map([...x.extra.map(o => this.now(o)), ...Object.values(live.things || {}).flat(), ...(main ? [this.now(main)] : [])].map(o => [o.id, o]));
      for (const [id, st] of Object.entries(a.edits || {})) {
        const o = objs.get(id), base = o && this.baseOf(o);
        if (!base) continue;
        if (areaOn && o.id === main.id) { if (st.oh) areaTags.opening_hours = st.oh; else delete areaTags.opening_hours; continue; }   // onto the area
        if (toOld && o.id === main.id) { ohMain = st.oh; continue; }   // onto its old outline
        const tags = {}, removeTags = [];
        if ((st.oh || '') !== (o.tags.opening_hours || '')) { if (st.oh) tags.opening_hours = st.oh; else removeTags.push('opening_hours'); }
        for (const [k, v] of Object.entries(st.extra || {})) if (v && v !== o.tags[k]) tags[k] = v;
        const moved = st.at && o.id[0] === 'n' && m(st.at, [o.lon, o.lat]) >= 0.5 ? {lat: st.at[1], lon: st.at[0]} : {};
        if (!Object.keys(tags).length && !removeTags.length && !moved.lat) continue;
        const kind = main && o.id === main.id ? null : THINGS.find(k => k.is({...o.tags, ...((a.other || {})[o.id] === 'office' ? this.notStation(o) : {})}));
        const key = Edits.modify(typeOf(o), osmNumId(o), base, {tags, removeTags, ...moved}, `${o.tags.name || id}: ${kind ? kind.label.toLowerCase() : 'its hours'}`);
        Edits.ops[key].thing = kind ? `the ${kind.label.toLowerCase()}` : 'the station';
      }
      // windows at another's window: one office, one point; its description says what else it does
      const folded = {}, kindOf = t => THINGS.find(j => j.key === t.kind);
      for (const t of Object.values(a.things || {})) if (t.kind && t.same) (folded[t.same] = folded[t.same] || []).push(kindOf(t));
      const says = (k, desc, more) => {
        const line = [k.words, ...more.map(j => j.words)].join(', ').replace(/^./, c => c.toUpperCase());
        return !desc ? line : desc.toLowerCase().includes(line.toLowerCase()) ? desc : `${desc}; ${line}`;
      };
      for (const [to, more] of Object.entries(folded)) {
        if (!to.startsWith('id:')) continue;
        const o = objs.get(to.slice(3));
        if (!o || !isPoint(o)) continue;
        const k = THINGS.find(j => j.is({...o.tags, ...((a.other || {})[o.id] === 'office' ? this.notStation(o) : {})}));
        if (!k) continue;
        const key = Edits.modify(typeOf(o), osmNumId(o), nodeBase(o), {tags: {description: says(k, (Edits.get(typeOf(o)[0] + osmNumId(o)) || o).tags.description, more)}}, `${o.tags.name || o.id}: ${k.label.toLowerCase()}`);
        Edits.ops[key].thing = `the ${k.label.toLowerCase()}`;
      }
      for (const [eid, t] of Object.entries(a.things || {})) {
        const k = t.kind && kindOf(t);
        if (!k || t.same || !t.at) continue;
        const tags = {...k.tags, ...(k.operator && main.tags.operator ? {operator: main.tags.operator} : {}), ...(t.oh ? {opening_hours: t.oh} : {}),
          ...Object.fromEntries(Object.entries(t.extra || {}).filter(([, v]) => v))};
        if (folded['new:' + eid]) tags.description = says(k, '', folded['new:' + eid]);
        const key = Edits.createNode(t.at[1], t.at[0], tags, `${name}: ${k.label.toLowerCase()}`);
        Edits.ops[key].thing = k.label.toLowerCase();
      }
      if (areaOn) {
        const ids = A.ring.map(([lon, lat]) => Edits.ops[Edits.createNode(lat, lon, {}, `${name}: station area`)].id);
        const wkey = Edits.createWay(areaTags, [...ids, ids[0]], `${name}: station area`);
        Edits.ops[wkey].stationArea = name;
        members[0] = {key: wkey, role: ''};
        // the point: gone, its tags on the area; kept (and said) if another relation lists it
        const pt = this.now(main), in_ = Object.values(Roads.rels).filter(r => r.id !== (live.area || {}).id && r.members.some(mm => mm.type === 'node' && mm.ref === osmNumId(main)));
        goneRefs.add(main.id);
        if (in_.length) say(`The station point is in ${in_.map(r => r.tags.name || 'r' + r.id).join(', ')}: kept; take it out there, then delete it`);
        else Edits.delete('node', osmNumId(main), nodeBase(pt), `${name}: the station point, now its area`);
      }
      // the station's old outline: its tags back on it (from the point, or from the outline drawn since); or it goes
      if (old && how && how !== 'leave' && how !== 'point' && how !== 'draw') {
        const base = old.type === 'relation' ? {version: old.version, tags: old.tags, members: old.members} : {version: old.version, tags: old.tags, nodes: old.nodes};
        const mainNow = this.now(main), cur = this.ringOf(main);
        if (how === 'drop') {
          await this.dropShape(old, `${name}: an empty outline, the station drawn as its own`);
        } else {
          const tags = {...Carry.tags(mainNow, {tags: old.tags}, () => true), ...oldExtra};
          if (ohMain != null) { if (ohMain) tags.opening_hours = ohMain; else delete tags.opening_hours; }
          const key = Edits.modify(old.type, old.num, base, {tags, removeTags: ['area'].filter(k => k in old.tags), ...(how === 'shape' ? {members: [{type: 'way', ref: osmNumId(main), role: 'outer'}]} : {})}, `${name}: the station's outline, its tags back`);
          Edits.ops[key].outline = {changeset: old.was.changeset, how};
          members[0] = {type: old.type, ref: old.num, role: ''};
          goneRefs.add(main.id);
          if (how === 'old') {   // the point: gone, its tags on the outline
            const in_ = Object.values(Roads.rels).filter(r => r.id !== (live.area || {}).id && r.members.some(mm => mm.type === 'node' && mm.ref === osmNumId(main)));
            if (in_.length) say(`The station point is in ${in_.map(r => r.tags.name || 'r' + r.id).join(', ')}: kept; take it out there, then delete it`);
            else { const k2 = Edits.delete('node', osmNumId(main), nodeBase(mainNow), `${name}: the station point, its tags back on its outline`); Edits.ops[k2].outline = {how}; }
          } else if (how === 'back') {   // the outline drawn since: gone, and its corners
            await this.dropShape({type: 'way', num: osmNumId(main), id: main.id, tags: mainNow.tags, version: mainNow.version, nodes: Roads.ways[osmNumId(main)].nodes}, `${name}: the station's outline drawn again, its old one back`);
          } else if (how === 'shape') {   // the drawn one stays, as the relation's outline; its tags on the relation
            const w = Roads.ways[osmNumId(main)], k3 = Edits.modify('way', w.id, {version: w.version, tags: w.tags, nodes: w.nodes}, {removeTags: Object.keys(w.tags)}, `${name}: the station's outline, as its old relation's`);
            Edits.ops[k3].outline = {how};
            for (const mm of old.members) if (mm.type === 'way' && mm.ref !== w.id) { const mw = Roads.ways[mm.ref]; if (mw && !Object.keys(mw.tags || {}).length) await this.dropShape({type: 'way', num: mw.id, id: 'w' + mw.id, tags: mw.tags, version: mw.version, nodes: mw.nodes}, `${name}: the old outline's part, not used now`, old.num, true); }
          }
          if (!cur && how !== 'old') say('The outline drawn since was not read: change it in iD');
        }
      }
      // an empty outline that wasn't the station, said to go
      for (const h of (live.husks || []).filter(h => h !== old && a.gone[h.id] === 'remove')) await this.dropShape(h, `${name}: an empty outline (${Object.keys(h.tags).join(', ')})`);
      // islands: the walkable area they are, with the tags kept that were ticked; out of the stop area
      for (const w of live.islands || []) {
        if ((a.islands || {})[w.id] === 'leave') continue;
        const keep = Carry.tags({id: w.id, tags: w.tags}, {tags: {highway: 'pedestrian', area: 'yes'}}, CARRY.island), tags = {highway: 'pedestrian', area: 'yes', ...keep};
        const key = Edits.modify('way', w.num, {version: w.version, tags: w.tags, nodes: w.nodes}, {tags, removeTags: Object.keys(w.tags).filter(k => !(k in tags))}, `${name}: an island, a walkable area (the bays are its platforms)`);
        Edits.ops[key].station = 'island';
        goneRefs.add(w.id);
      }
      // a stray platform line by a bay: gone (and its points), what was ticked onto the bay
      for (const w of live.strays || []) {
        if (a.gone[w.id] === 'leave' || w.rels.length) continue;
        Carry.onto({id: w.id, tags: w.tags}, this.now(w.bay), CARRY.stop);
        await this.dropShape({type: 'way', ...w}, `${name}: a platform line by ${w.bay.tags.name || w.bay.id}, the same platform`);
        goneRefs.add(w.id);
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
      const lanes = this.lanesOn(live);
      if ((a.stopPos && x.newPos.length) || lanes.length) {
        const t = Roads.tx(), made = [];
        const spTags = bay => { const tags = {public_transport: 'stop_position', bus: 'yes', name}, ref = a.localRef[bay.id] || bay.tags.local_ref; if (ref) tags.local_ref = ref; return tags; };
        if (a.stopPos) for (const y of x.newPos) {
          const w = t.way(y.wid), near = this.nearestOn(w.nodes.map(n => Roads.ll(t, n)), y.point);
          const tags = spTags(y.bay.o);
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
        // the lanes: their ends on the road, their points, each bay's stop position on it in order along it
        const laneIds = new Set();
        for (const L of lanes) {
          const ends = [this.joinAt(t, L.pts[0], laneIds), this.joinAt(t, L.pts[L.pts.length - 1], laneIds)];
          const inner = L.pts.slice(1, -1), line = [Roads.ll(t, ends[0]), ...inner, Roads.ll(t, ends[1])];
          const along = q => { const nr = this.nearestOn(line, q); let s = 0; for (let i = 0; i < nr.index; i++) s += m(line[i], line[i + 1]); return {s: s + nr.t * m(line[nr.index], line[nr.index + 1]), point: nr.point}; };
          let items = [...inner.map(q => ({pt: q, s: along(q).s})), ...L.bays.map(b => { const z = along(osmPos(b)); return {pt: z.point, s: z.s, bay: b}; })];
          // a point of the lane within a metre of a stop position: the stop position is that point
          items = items.filter(it => it.bay || !items.some(u => u.bay && Math.abs(u.s - it.s) < 1)).sort((u, v) => u.s - v.s);
          const ids = items.map(it => { const id = Edits.newId(); t.nodes[id] = {id, lon: it.pt[0], lat: it.pt[1], tags: it.bay ? spTags(it.bay) : {}, created: true}; if (it.bay) made.push({id}); return id; });
          const road = t.waysAt(ends[0]).map(w => t.way(w)).find(w => w && this.drivable(w.tags)), wid = Edits.newId();
          t.ways[wid] = {id: wid, nodes: [ends[0], ...ids, ends[1]], tags: {highway: 'busway', lanes: '1', ...(road && road.tags.surface ? {surface: road.tags.surface} : {})}, created: true};
          laneIds.add(wid);
        }
        const fresh = made.filter(z => !z.existing).length;
        // (points added to roads, nothing split: no route relation changes)
        if (fresh || lanes.length) {
          Roads.commit(t, [], [lanes.length ? `Add ${lanes.length} bus lane${lanes.length > 1 ? 's' : ''} by the bays at ${name}` : null,
            fresh ? `${lanes.length ? '' : 'Add '}${fresh} stop position${fresh > 1 ? 's' : ''}${lanes.length ? '' : ` at ${name}`}` : null].filter(Boolean).join(', '));
        }
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
      for (const y of x.unused.filter(y => a.gone[y.o.id] === 'remove')) goneRefs.add(y.o.id);
      for (let i = members.length - 1; i >= 0; i--) { const r = Edits.resolveMember(members[i]); if (r && goneRefs.has(r.type[0] + r.ref)) members.splice(i, 1); }
      if (live.area) {
        const cur = live.area.members.filter(mm => !goneRefs.has(mm.type[0] + mm.ref));
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
