/* merge.js — two OSM relations for one route: say why there are probably two, what GTFS says, what flagstop
   would do, and ask.

   The usual story: mappers made one relation per timetable (weekday, Saturday), but GTFS runs the same stops
   on the same streets every day, and OSM maps the route, not the timetable. So: keep the older relation (its
   history carries on), give it the feed's stops in order and the roads in driving order (split where the bus
   turns partway along one), take the other out of the route master and delete it. When it runs can go on the
   relation as opening_hours, from the feed. */
'use strict';

const SERVICE_DAY = /\s*[-–(]?\s*\b(weekdays?|saturdays?|sundays?|weekends?|mon(day)?s?\s*-\s*fri(day)?s?|sat|sun)\b\)?/gi;
const NAMED_FOR_DAYS = /\b(weekdays?|saturdays?|sundays?|weekends?)\b/i;   // a test (no 'g': .test on a global regex remembers where it got to)

const Merge = {
  /** What flagstop would do for an itinerary with more than one relation. */
  plan(p) {
    const r = routeOf(p), rels = p.relations.filter(a => (Edits.get('r' + a.id) || {}).kind !== 'delete');
    if (rels.length < 2) return null;
    const keep = [...rels].sort((a, b) => a.id - b.id)[0], drop = rels.filter(a => a !== keep);
    const master = (D.masters || []).find(m => m.routes.some(id => rels.some(a => a.id === id)));
    // the name: the route master's (the local style, no service day), else the kept one's with the day taken out
    const name = (master && master.tags.name) || keep.tags.name.replace(SERVICE_DAY, '').replace(/\s*-\s*$/, '').trim();
    const tags = {...keep.tags, name};
    for (const k of ['gtfs:route_id', 'gtfs:shape_id', 'public_transport:version', 'roundtrip']) if (p.proposed_tags[k]) tags[k] = p.proposed_tags[k];
    // stops: the feed's, in order; where OSM has more than one candidate, the best, marked for checking
    const stops = [], guessed = [], absent = [];
    for (const sid of p.stops) {
      const s = D.stops[sid], o = matchedOsm(s) || (s.match && s.match.osm && s.match.osm[0] ? D.osm_stops[s.match.osm[0].id] : null);
      if (!o) { absent.push(s); continue; }
      if (!matchedOsm(s) && !guessed.some(g => g.s.id === s.id)) guessed.push({s, o});   // a loop's terminal comes twice
      stops.push({s, o});
    }
    const had = new Map();
    for (const a of rels) for (const m of a.members) if (m.type === 'node' && /platform/.test(m.role || '')) had.set(m.ref, a);
    const now = new Set(stops.map(x => osmNumId(x.o)));
    const stale = [...had.keys()].filter(id => !now.has(id)).map(id => D.osm_stops['n' + id] || {id: 'n' + id, tags: {}});
    const splits = (p.chain_breaks || []).filter(b => b.kind === 'split');
    const hours = (p.services || []).filter(x => x.trips && x.days).map(x => `${x.days} ${hhmm(x.first)}-${hhmm(x.last)}`).join('; ');
    return {p, r, rels, keep, drop, master, name, tags, stops, guessed, absent, stale, splits, hours};
  },
  /** A road as a person would know it: its name, its ref, or what it is and which stop it's by. */
  roadName(p, b) {
    const t = p.way_tags[b.split] || {};
    if (t.name || t.ref) return t.name || t.ref;
    const near = p.stops.map(id => D.stops[id]).reduce((best, s) => { const dd = m([s.lon, s.lat], [b.lon, b.lat]); return !best || dd < best.d ? {s, d: dd} : best; }, null);
    return `an unnamed ${t.highway || 'road'}${t.service ? ' (' + t.service + ')' : ''}${near ? ` by ${near.s.name}` : ''}`;
  },
  open(p) { S.merge = {pid: p.id, view: 'proposed', hours: false}; document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove()); render(); draw(); },
  close() { S.merge = null; render(); draw(); },
  show(view) { S.merge.view = view; render(); draw(); },
  /** On the map: the stops the merge takes out, as red rings. */
  staleFeatures() {
    if (!S.merge || S.merge.view !== 'now') return [];
    const x = this.plan(patternById(S.merge.pid));
    return x ? x.stale.filter(o => o.lon != null).map(o => point([o.lon, o.lat], {})) : [];
  },

  render(P) {
    const p = patternById(S.merge.pid), x = this.plan(p);
    if (!x) { S.merge = null; return renderPattern(P, p); }
    const {r, rels, keep, drop} = x, svc = p.services || [];
    const days = svc.map(v => `${v.trips} ${p.loop && p.loop.length ? 'loop' : 'trip'}${v.trips === 1 ? '' : 's'} ${v.days}`).join(', ');
    P.append(el('button', {class: 'back', onclick: () => this.close()}, `← ${p.headsign || r.long}`));
    const d = el('div', {class: 'detail fixcard'});
    d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, `${rels.length} relations for one route`)));
    d.append(
      el('div', {class: 'fixstep now'}, el('div', {class: 'k'}, 'OSM has'),
        ...rels.map(a => el('div', {}, el('a', {href: `https://www.openstreetmap.org/relation/${a.id}`, target: '_blank'}, a.name || `r${a.id}`),
          el('span', {class: 'muted'}, ` · ${a.stops.in_relation ? `${a.stops.in_relation} stops` : 'no stops'} · ${a.ways.chain_breaks.length ? `${a.ways.chain_breaks.length} places its roads don't join up` : 'roads join up'}`)))),
      el('div', {class: 'fixstep why'}, el('div', {class: 'k'}, 'Why two, probably'),
        el('div', {}, rels.some(a => NAMED_FOR_DAYS.test(a.name || '')) ? `They're named for different days, and the timetables do differ: ${days}.` : `Different timetables, most likely: ${days}.`),
        el('div', {}, `But GTFS runs the same ${p.stops.length} stops on the same streets every day. OSM maps the route, not the timetable, so it's one relation; when it runs can be a tag on it.`)),
      el('div', {class: 'fixstep want'}, el('div', {class: 'k'}, 'flagstop would'),
        el('ul', {class: 'mergelist'},
          el('li', {}, 'keep ', el('a', {href: `https://www.openstreetmap.org/relation/${keep.id}`, target: '_blank'}, `r${keep.id}`), ` (the older; its history carries on), named "${x.name}"`),
          el('li', {}, `give it the feed's ${x.stops.length} stops in order` + (x.stale.length ? `; ${x.stale.length} it has now aren't on the route any more: ${x.stale.slice(0, 6).map(o => o.tags.name || o.id).join(', ')}${x.stale.length > 6 ? ', …' : ''}` : '')),
          el('li', {}, 'list its roads in driving order, so they join up end to end' + (x.splits.length ? `, splitting ${x.splits.length} where the bus turns partway along: ${[...new Set(x.splits.map(b => this.roadName(p, b)))].join('; ')}` : '')),
          ...drop.map(a => el('li', {}, `delete r${a.id} "${a.name}"` + (x.master ? `, and take it out of the route master "${x.master.tags.name}"` : ''))),
          x.hours ? el('li', {}, el('label', {}, el('input', {type: 'checkbox', checked: S.merge.hours ? '' : null, onchange: e => { S.merge.hours = e.target.checked; }}), ` and say when it runs: opening_hours=${x.hours}`)) : null)),
      x.guessed.length || x.absent.length ? el('div', {class: 'fixstep', style: 'border-left-color:var(--amb)'}, el('div', {class: 'k'}, 'Check'),
        x.guessed.length ? el('div', {}, `${x.guessed.length} stop${x.guessed.length > 1 ? 's' : ''} where OSM has more than one candidate: flagstop picked the likeliest. `,
          ...x.guessed.flatMap(({s}, i) => [i ? ', ' : '', el('a', {href: '#', onclick: e => { e.preventDefault(); showStop(s.id); }}, s.name)])) : null,
        x.absent.length ? el('div', {}, `${x.absent.length} stop${x.absent.length > 1 ? 's' : ''} not in OSM yet, left out: `, ...x.absent.flatMap((s, i) => [i ? ', ' : '', el('a', {href: '#', onclick: e => { e.preventDefault(); showStop(s.id); }}, s.name)]), ' (add them from Stops, then propose again)') : null) : null);
    d.append(el('div', {class: 'seg'},
      el('button', {class: 'b' + (S.merge.view === 'now' ? ' on' : ''), onclick: () => this.show('now')}, 'OSM now'),
      el('button', {class: 'b' + (S.merge.view === 'proposed' ? ' on' : ''), onclick: () => this.show('proposed')}, 'Proposed')),
      el('div', {class: 'muted small'}, S.merge.view === 'now' ? 'On the map: the relations as they are (purple); red rings are the stops that would come out.' : 'On the map: the route as the one relation would have it (blue), and its stops.'));
    d.append(el('h2', {style: 'margin-left:0'}, 'Does this look right?'),
      el('div', {class: 'btns'},
        el('button', {class: 'b primary', onclick: () => this.accept()}, 'Looks right: add to Changes'),
        el('button', {class: 'b', onclick: () => openIn('rapid', {...centerOf(p.shape.length ? p.shape : p.routed.geometry), zoom: 14, select: rels.map(a => 'r' + a.id), pattern: p, comment: `Bus route ${r.short}: one relation`})}, 'Let me edit it (RapiD)'),
        el('button', {class: 'b', onclick: () => { this.close(); toast('Left as OSM has it'); }}, 'Not right')),
      el('div', {class: 'muted small'}, 'Not right? If the days really do run different streets or stops, they should stay separate relations: one per way the route is run.'));
    P.append(d);
  },

  /** Split where needed, re-route on that, check the roads join up, then write the one relation. */
  async accept() {
    const p = patternById(S.merge.pid), x = this.plan(p), hours = S.merge.hours;
    const say = m => toast(m, 8000);
    Edits.hold(`one relation for route ${x.r.short}`);   // the splits and the relation: one undo
    try {
      for (const b of x.splits) {
        say(`Splitting ${this.roadName(p, b)} where the bus turns…`);
        await Roads.load([b.lon - 0.003, b.lat - 0.002, b.lon + 0.003, b.lat + 0.002]);
        if (Roads.way(b.split) && Roads.way(b.split).nodes.includes(b.node)) await Roads.splitAt(b.split, b.node);
      }
      say('Routing it on the result…');
      const tr = await traceWith(p.id, {});
      await Roads.fetchWays(tr.ways.filter(w => w > 0));
      const breaks = Roads.chainBreaks(tr.ways.map(w => Roads.way(w)));
      if (breaks) return say(`Stopped: the roads still don't join up in ${breaks} place${breaks > 1 ? 's' : ''}. The splits are in Changes; nothing else was changed.`);
      const members = [...x.stops.map(({o}) => ({type: 'node', ref: osmNumId(o), role: 'platform'})), ...tr.ways.map(w => ({type: 'way', ref: w, role: ''}))];
      const tags = {...x.tags, ...(hours && x.hours ? {opening_hours: x.hours} : {})};
      const key = Edits.modify('relation', x.keep.id, relBase(x.keep), {tags, members}, `${x.r.short}: one relation for one route`);
      Edits.ops[key].suggested = true; Edits.ops[key].route = x.r.short;
      for (const a of x.drop) {
        Edits.delete('relation', a.id, relBase(a), `duplicate of route ${x.r.short}`);
        editMasters([], a.id, {type: 'relation', ref: x.keep.id});
      }
      Edits.save();
      S.merge = null;
      await liveRoute();
      toast(`Route ${x.r.short}: one relation, in Changes`, 5000);
      render(); draw();
    } catch (e) { say(e.message); console.error(e); }
    finally { Edits.release(); }
  },
};

const hhmm = s => { const h = Math.floor(s / 3600) % 24, m = Math.floor(s % 3600 / 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
