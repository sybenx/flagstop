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
    // stops: the feed's, in order. Each has to be settled before the route can be: which OSM stop it is,
    // and whether it's where buses stop. What isn't settled is a decision in the card, not a guess.
    const ans = (S.merge && S.merge.answers) || {}, decide = [], stops = [];
    for (const sid of p.stops) {
      const s = D.stops[sid], m = s.match || {}, cands = (m.osm || []).map(c => ({...c, o: D.osm_stops[c.id]})).filter(c => c.o);
      const pos = (m.decide || {}).position, a = ans[sid];
      let o = matchedOsm(s), q = null;
      if (o && pos && pos.pick === 'ask') q = {kind: 'where', s, o, why: pos.why};
      else if (!o && m.status === 'moved' && cands[0]) { o = cands[0].o; q = {kind: 'where', s, o, why: pos ? pos.why : `OSM's stop is ${cands[0].dist} m from the agency's point`}; }
      else if (!o && m.status === 'ambiguous' && cands.length) { o = a && a.pick ? D.osm_stops[a.pick] : null; q = {kind: 'which', s, cands}; }
      else if (!o) q = {kind: 'missing', s};
      if (q && o && Edits.get('n' + osmNumId(o)) && Edits.diff(Edits.get('n' + osmNumId(o))).some(x => x.k === 'position')) q = null;   // already moved in Changes
      if (q && !decide.some(x => x.s.id === sid)) decide.push({...q, answer: a ? a.choice : null});   // a loop's terminal comes twice
      if (q && q.kind === 'missing') { if (a && a.choice === 'add') stops.push({s, add: true}); continue; }
      if (o) stops.push({s, o});
    }
    const open = decide.filter(x => !x.answer).length;
    const questions = p.stops.filter((sid, i) => p.stops.indexOf(sid) === i).map(sid => D.stops[sid]).filter(s => !decide.some(x => x.s.id === s.id))
      .flatMap(s => Object.entries((s.match && s.match.decide) || {}).filter(([k, v]) => v.pick === 'ask' && k !== 'position').map(([k, v]) => ({s, k, why: v.why})));
    const had = new Map();
    for (const a of rels) for (const m of a.members) if (m.type === 'node' && /platform/.test(m.role || '')) had.set(m.ref, a);
    const now = new Set(stops.filter(x => x.o).map(x => osmNumId(x.o)));
    const stale = [...had.keys()].filter(id => !now.has(id)).map(id => D.osm_stops['n' + id] || {id: 'n' + id, tags: {}});
    const splits = (p.chain_breaks || []).filter(b => b.kind === 'split');
    const hours = (p.services || []).filter(x => x.trips && x.days).map(x => `${x.days} ${hhmm(x.first)}-${hhmm(x.last)}`).join('; ');
    return {p, r, rels, keep, drop, master, name, tags, stops, decide, open, questions, stale, splits, hours};
  },
  /** Stops the route can't be right without settling, each with its choice, in the card. */
  decisions(x) {
    const box = el('div', {class: 'fixstep', style: 'border-left-color:var(--amb)'}, el('div', {class: 'k'}, `Decide first: ${x.decide.length} stop${x.decide.length > 1 ? 's' : ''}`));
    const set = (sid, choice, pick) => { S.merge.answers = {...(S.merge.answers || {}), [sid]: {choice, pick}}; render(); draw(); };
    for (const q of x.decide) {
      const name = el('a', {href: '#', onclick: e => { e.preventDefault(); const at = q.o ? osmPos(q.o) : [q.s.lon, q.s.lat]; map.flyTo({center: at, zoom: 17.5}); }}, q.s.name);
      const btn = (label, choice, pick) => el('button', {class: 'b tiny' + (q.answer === choice && (!pick || (S.merge.answers[q.s.id] || {}).pick === pick) ? ' primary' : ''), onclick: () => set(q.s.id, choice, pick)}, label);
      const row = el('div', {class: 'decide' + (q.answer ? ' answered' : '')}, el('div', {}, name));
      if (q.kind === 'where') {
        // what's different, in one go: where OSM has it, what it calls it, and the agency's, then the question
        const on = q.o.tags.name, nameQ = ((q.s.match.decide || {}).name || {});
        const dist = Math.round(m(osmPos(q.o), [q.s.lon, q.s.lat]));
        row.append(el('div', {class: 'why'}, on && on !== q.s.name ? `OSM calls it "${on}", ${dist} m from the agency's "${q.s.name}".` : `OSM has it ${dist} m from the agency's point.`),
          el('div', {class: 'why'}, nameQ.pick === 'ask' && /name says/.test(nameQ.why || '') ? nameQ.why.replace(/, and they're \d+ m apart/, '') : q.why),
          el('div', {class: 'btns'}, btn("Move it to the agency's spot", 'move'), btn('Keep it where it is', 'keep')));
        // moving it there: what else about it differs goes along by default (its address, its code), each one flippable
        if (q.answer === 'move') {
          const t = this.moveTags(q), chips = el('div', {class: 'chips'});
          for (const [k, v] of Object.entries(t)) {
            const d = q.s.match.diff[k];
            chips.append(el('button', {class: 'pickchip' + (v ? ' take' : ''), title: v ? "Goes with it. Click to keep OSM's" : "Stays as OSM has it. Click to take the agency's",
              onclick: () => { S.merge.answers[q.s.id].tags = {...t, [k]: !v}; render(); }}, v ? `✓ ${KEY_WORDS[k] || k}: ${d.osm || '—'} → ${d.gtfs}` : `${KEY_WORDS[k] || k} kept`));
          }
          if (chips.childNodes.length) row.append(el('div', {class: 'why'}, 'Moving it to the agency\'s spot, its address and codes go with it (click one to keep OSM\'s):'), chips);
        }
      }
      if (q.kind === 'which') row.append(el('div', {class: 'why'}, `OSM has ${q.cands.length} stops that could be it. Which?`),
        el('div', {class: 'btns'}, ...q.cands.map(c => btn(`${c.o.tags.name || c.id} (${c.dist} m)`, 'pick', c.id))));
      if (q.kind === 'missing') row.append(el('div', {class: 'why'}, 'Not in OSM yet.' + ((q.s.match && q.s.match.temporary) || /\b(temp(orary)?|detour)\b/i.test(q.s.name) ?
          " The feed calls it temporary, but runs it as part of this route now: add it to map the route as it runs, or leave it out if the detour will be over soon." : '')), el('div', {class: 'btns'}, btn("Add it at the agency's spot", 'add'), btn('Leave it out of the relation', 'skip')));
      box.append(row);
    }
    return box;
  },
  /** For a stop being moved to the agency's spot: which of its other differences go with it -> {key: true|false}.
      Everything that differs, by default (it's the agency's stop at the agency's spot now), unless already answered. */
  moveTags(q) {
    const a = S.merge.answers[q.s.id] || {}, diff = (q.s.match && q.s.match.diff) || {}, out = {};
    // all of it by default, except an announcement flagstop doubts (an internal note with a date in it)
    const dec = (q.s.match && q.s.match.decide) || {};
    for (const k of ['name', 'ref', 'gtfs:stop_id', 'route_ref', 'description']) if (diff[k] && diff[k].gtfs) out[k] = a.tags && k in a.tags ? a.tags[k] : !(k === 'description' && dec[k] && dec[k].pick === 'ask');
    return out;
  },
  /** A road as a person would know it: its name, its ref, or what it is and which stop it's by. */
  roadName(p, b) {
    const t = p.way_tags[b.split] || {};
    if (t.name || t.ref) return t.name || t.ref;
    const near = p.stops.map(id => D.stops[id]).reduce((best, s) => { const dd = m([s.lon, s.lat], [b.lon, b.lat]); return !best || dd < best.d ? {s, d: dd} : best; }, null);
    return `an unnamed ${t.highway || 'road'}${t.service ? ' (' + t.service + ')' : ''}${near ? ` by ${near.s.name}` : ''}`;
  },
  open(p) { S.merge = {pid: p.id, view: 'proposed', hours: false, answers: {}}; document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove()); render(); draw(); },
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
      ...[x.decide.length ? this.decisions(x) : null,
      x.questions.length ? el('div', {class: 'muted small', style: 'margin:6px 0'}, `${x.questions.length} other stop question${x.questions.length > 1 ? 's' : ''} on this route (names, codes) don't change the route; settle them in Check stops: `,
        ...x.questions.slice(0, 5).flatMap((q, i) => [i ? ', ' : '', el('a', {href: '#', title: q.why, onclick: e => { e.preventDefault(); showStop(q.s.id); }}, q.s.name)]), x.questions.length > 5 ? ', …' : '') : null].filter(Boolean));   // DOM append writes 'null' for null
    d.append(el('div', {class: 'seg'},
      el('button', {class: 'b' + (S.merge.view === 'now' ? ' on' : ''), onclick: () => this.show('now')}, 'OSM now'),
      el('button', {class: 'b' + (S.merge.view === 'proposed' ? ' on' : ''), onclick: () => this.show('proposed')}, 'Proposed')),
      el('div', {class: 'muted small'}, S.merge.view === 'now' ? 'On the map: the relations as they are (purple); red rings are the stops that would come out.' : 'On the map: the route as the one relation would have it (blue), and its stops.'));
    d.append(el('h2', {style: 'margin-left:0'}, 'Does this look right?'),
      el('div', {class: 'btns'},
        el('button', {class: 'b primary', disabled: x.open ? '' : null, title: x.open ? 'Decide the stops above first' : '', onclick: () => this.accept()}, x.open ? `Looks right (decide ${x.open} stop${x.open > 1 ? 's' : ''} first)` : 'Looks right: add to Changes'),
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
      // the stop decisions: moves, a stop picked out of several, stops added
      const added = {};
      for (const q of x.decide) {
        if (q.kind === 'where' && q.answer === 'move') {
          const tags = {}, diff = q.s.match.diff || {};
          for (const [k, on] of Object.entries(this.moveTags(q))) if (on) tags[k] = diff[k].gtfs;
          if (tags['gtfs:stop_id'] && q.s.proposed_tags['gtfs:stop_code'] && !q.o.tags['gtfs:stop_code']) tags['gtfs:stop_code'] = q.s.proposed_tags['gtfs:stop_code'];
          Edits.modify('node', osmNumId(q.o), nodeBase(q.o), {lat: q.s.lat, lon: q.s.lon, tags}, `${q.s.ref} ${q.s.name}: moved to the agency's spot`);
        }
        if (q.kind === 'which') { Edits.decisions[q.s.id] = (S.merge.answers[q.s.id] || {}).pick; }
        if (q.kind === 'missing' && q.answer === 'add') added[q.s.id] = Edits.createNode(q.s.lat, q.s.lon, q.s.proposed_tags, `${q.s.ref} ${q.s.name}`);
      }
      const plat = ({s, o, add}) => add ? {key: added[s.id], role: 'platform'} : {type: 'node', ref: osmNumId(o), role: 'platform'};
      const members = [...x.stops.map(plat), ...tr.ways.map(w => ({type: 'way', ref: w, role: ''}))];
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
