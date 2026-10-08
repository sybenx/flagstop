/* merge.js — two OSM relations for one route: say why there are probably two, what GTFS says, what flagstop
   would do, and ask.

   The usual story: mappers made one relation per timetable (weekday, Saturday), but GTFS runs the same stops
   on the same streets every day, and OSM maps the route, not the timetable. So: keep the older relation (its
   history carries on), give it the feed's stops in order and the roads in driving order (split where the bus
   turns partway along one), take the other out of the route master and delete it. When it runs can go on the
   relation as opening_hours, from the feed. */
'use strict';

const SERVICE_DAY = /\s*[-–(]?\s*\b(weekdays?|saturdays?|sundays?|weekends?|mon(day)?s?\s*-\s*fri(day)?s?|sat|sun)\b\)?/gi;

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
    const {tags: timetable, clash, uneven} = this.timetable(p, rels);
    // stops this merge leaves: in the relations now but not on the route, and candidates not picked. Those no
    // stop in the agency's data uses may be gone for real: offered for removal from OSM (after a look).
    // which stop in the agency's data each OSM stop is the likeliest match for
    const claim = {};
    for (const t of Object.values(D.stops)) for (const c of (t.match && t.match.osm || []).slice(0, 1)) (claim[c.id] = claim[c.id] || new Set()).add(t.id);
    const usedBy = (o, but) => [...(claim[o.id] || [])].some(id => id !== but);
    const picked = new Set(stops.filter(x => x.o).map(x => x.o.id));
    // a stop OSM had twice: the one not picked (here, or earlier in Check stops or the Stops tab)
    const unpicked = stops.filter(x => x.o && (x.s.match || {}).status === 'ambiguous')
      .flatMap(x => x.s.match.osm.map(c => ({o: D.osm_stops[c.id], sid: x.s.id}))).filter(x => x.o && !picked.has(x.o.id) && !usedBy(x.o, x.sid)).map(x => x.o);
    // (a stop's own, left for a shared one: that goes with the sharing, its routes given the shared one)
    const shares = new Set(stops.filter(x => x.o && (x.s.match || {}).shared && x.s.match.shared.id === x.o.id).map(x => x.s.match.shared.own));
    // (and a stop that could still be either, its question unanswered: not leaving yet)
    for (const q of decide) if (q.kind === 'which' && !(ans[q.s.id] || {}).pick) for (const c of q.cands) shares.add(c.id);
    const gone = [...new Map([...stale.filter(o => !claim[o.id] && !shares.has(o.id)), ...unpicked.filter(o => !shares.has(o.id))].filter(o => o && o.lon != null && !picked.has(o.id)).map(o => [o.id, o])).values()];
    // on a detour (and not told to map it): the kept relation's stops and roads stay as they are, the regular route;
    // so nothing is left off it, nothing split, and the detour's temporary stops aren't asked about
    if (detoured(p)) {
      if (keep.tags['gtfs:shape_id']) tags['gtfs:shape_id'] = keep.tags['gtfs:shape_id']; else delete tags['gtfs:shape_id'];   // the detour's shape isn't the route's
      const asked = decide.filter(q => !(q.kind === 'missing' && q.s.match && q.s.match.temporary));
      return {p, r, rels, keep, drop, master, name, tags, stops, decide: asked, open: asked.filter(q => !q.answer).length, questions, stale: [], splits: [], timetable, clash, uneven, gone: [], detour: true};
    }
    if (mapsDetour(p)) tags.note = DIVERSION;   // mapping the detour: say so on the relation
    const removeTags = tags.note === DIVERSION && !mapsDetour(p) ? (delete tags.note, ['note']) : [];   // the detour's over: the note goes
    // stops a detour goes round are coming back: not offered for removal
    const kept = gone.filter(o => !(D.detoured || {})[o.id]);
    return {p, r, rels, keep, drop, master, name, tags, removeTags, stops, decide, open, questions, stale, splits, timetable, clash, uneven, gone: kept};
  },
  /** Stops the merge leaves out that nothing in the agency's data uses: remove from OSM, or leave (the default). */
  goneStops(x) {
    const box = el('div', {class: 'fixstep'}, el('div', {class: 'k'}, `Not on any route now: ${x.gone.length} stop${x.gone.length > 1 ? 's' : ''}`),
      el('div', {class: 'why'}, "Leaving the relation either way. If one isn't there any more, it can come out of OSM too."));
    const g = S.merge.gone || (S.merge.gone = {});
    for (const o of x.gone) {
      const seen = S.looked.has('osm:' + o.id), on = g[o.id] === 'remove';
      box.append(el('div', {class: 'decide'}, el('div', {}, el('b', {}, o.tags.name || o.id), el('span', {class: 'muted'}, ` (${o.id})`)),
        el('div', {style: 'margin:4px 0'}, el('button', {class: 'b tiny' + (seen ? '' : ' primary'), onclick: () => { S.looked.add('osm:' + o.id); S.lookStop = null; render(); draw(); map.flyTo({center: [o.lon, o.lat], zoom: 18}); }}, 'Show on map'),
          seen ? el('a', {href: '#', class: 'muted small', style: 'margin-left:8px', onclick: e => { e.preventDefault(); openIn('rapid', {lon: o.lon, lat: o.lat, zoom: 19, select: [o.id]}); }}, 'imagery') : null),
        el('div', {class: 'btns'},
          ...goneButtons(g, o, seen), g[o.id] ? null : el('button', {class: 'b tiny chosen', onclick: () => { g[o.id] = null; render(); }}, '✓ Leave it'))));
    }
    return box;
  },
  /** Stops the route can't be right without settling, each with its choice, in the card. */
  decisions(x) {
    const box = el('div', {class: 'fixstep', style: 'border-left-color:var(--amb)'}, el('div', {class: 'k'}, `Decide first: ${x.decide.length} stop${x.decide.length > 1 ? 's' : ''}`));
    // choosing the chosen answer again takes it back
    const set = (sid, choice, pick) => {
      const a = {...(S.merge.answers || {})}, cur = a[sid];
      if (cur && cur.choice === choice && cur.pick === pick) delete a[sid]; else a[sid] = {choice, pick};
      S.merge.answers = a; render(); draw();
    };
    for (const q of x.decide) {
      // the choice waits until the stop has been looked at on the map: a move isn't decided from text
      const seen = looked(q.s.id);
      const btn = (label, choice, pick) => {
        const on = q.answer === choice && (!pick || (S.merge.answers[q.s.id] || {}).pick === pick);
        return el('button', {class: 'b tiny' + (on ? ' chosen' : ''), disabled: seen ? null : '', title: seen ? (on ? 'Chosen: click again to take it back' : '') : 'Show it on the map first',
          onclick: () => set(q.s.id, choice, pick)}, (on ? '✓ ' : '') + label);
      };
      const row = el('div', {class: 'decide' + (q.answer ? ' answered' : '')}, el('div', {}, el('b', {}, q.s.name)));
      const look = () => el('div', {style: 'margin:4px 0'}, lookButtons(q.s, q.o || (q.cands && q.cands[0] && q.cands[0].o)));
      if (q.kind === 'where') {
        // what's different, in one go: where OSM has it, what it calls it, and the agency's, then the question
        const on = q.o.tags.name, nameQ = ((q.s.match.decide || {}).name || {});
        const dist = Math.round(m(osmPos(q.o), [q.s.lon, q.s.lat]));
        const changes = Object.keys(this.moveTags(q)).length;
        row.append(el('div', {class: 'why'}, (on && on !== q.s.name ? `OSM calls it "${on}", ${dist} m away. ` : `OSM has it ${dist} m away. `) +
            (nameQ.pick === 'ask' && /address says/.test(nameQ.why || '') ? nameQ.why.replace(/, and they're \d+ m apart/, '') : q.why)),
          look(),
          el('div', {class: 'btns'}, btn(mergedWith(q.s) ? `Move it here, remove ${mergedWith(q.s).tags.name || 'the other'}` : 'Move it here', 'move'), btn('Keep it', 'keep')),
          changes ? el('div', {class: 'why'}, "Moving it also gives it the agency's address and codes.") : null);
      }
      const sh = q.kind === 'which' && q.s.match.shared;
      if (sh) row.append(el('div', {class: 'why'}, `The agency's point is on ${sh.network}'s ${(D.osm_stops[sh.id] || {tags: {}}).tags.name || sh.id} (${sh.dist} m); OSM's stop with its code is ${sh.own_dist} m away. One stop for both networks (the old one goes), or its own?`), look(),
        el('div', {class: 'btns'}, ...q.cands.map(c => btn(c.id === sh.id ? `One stop: ${c.o.tags.name || c.id}` : `Its own: ${c.o.tags.name || c.id} (${c.dist} m)`, 'pick', c.id))));
      else if (q.kind === 'which') row.append(el('div', {class: 'why'}, `OSM has ${q.cands.length} stops that could be it. Which?`), look(),
        el('div', {class: 'btns'}, ...q.cands.map(c => btn(`${c.o.tags.name || c.id} (${c.dist} m)`, 'pick', c.id))));
      if (q.kind === 'missing') row.append(look(), el('div', {class: 'why'}, 'Not in OSM yet.' + ((q.s.match && q.s.match.temporary) || /\b(temp(orary)?|detour)\b/i.test(q.s.name) ?
          " The feed calls it temporary, but runs it as part of this route now: add it to map the route as it runs, or leave it out if the detour will be over soon." : '')), el('div', {class: 'btns'}, btn(newStopSpot(q.s, patternById(S.merge.pid)).kerb ? "Add it, at the kerb by the agency's point" : "Add it at the agency's spot", 'add'), btn('Leave it out of the relation', 'skip')));
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
  async open(p) {
    if (!p.routed && !(await ensureRouted(p))) return toast(`Couldn't load this route's roads: ${p.routeError}`, 6000);
    S.merge = {pid: p.id, view: 'proposed', hours: null, answers: {}}; document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove()); render(); draw(); },
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
    // 'weekdays (30 trips) and Saturdays (9)': days in words, the unit said once
    const unit = p.loop && p.loop.length ? 'loop' : 'trip';
    const dayWords = d => ({'Mo-Fr': 'weekdays', 'Sa': 'Saturdays', 'Su': 'Sundays', 'Sa,Su': 'weekends', 'Mo-Su': 'every day', 'Mo-Sa': 'Mondays to Saturdays'}[d] || d);
    const parts = svc.map((v, i) => `${dayWords(v.days)} (${v.trips}${i ? '' : ` ${unit}${v.trips === 1 ? '' : 's'}`})`);
    const days = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('');
    P.append(el('button', {class: 'back', onclick: () => this.close()}, `← ${p.headsign || r.long}`));
    const d = el('div', {class: 'detail fixcard'});
    d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, `${rels.length} relations for one route`)));
    d.append(
      el('div', {class: 'fixstep now'}, el('div', {class: 'k'}, 'OSM has'),
        ...rels.map(a => el('div', {}, el('a', {href: `https://www.openstreetmap.org/relation/${a.id}`, target: '_blank'}, a.name || `r${a.id}`),
          el('span', {class: 'muted'}, ` · ${a.stops.in_relation ? `${a.stops.in_relation} stops` : 'no stops'} · ${a.ways.chain_breaks.length ? `${a.ways.chain_breaks.length} places its roads don't join up` : 'roads join up'}`)))),
      el('div', {class: 'fixstep why'}, el('div', {class: 'k'}, `Why ${rels.length === 2 ? 'two' : rels.length}`),
        el('div', {}, `Probably one per timetable: ${days}. In OSM a route is one relation (one per direction, or one for a loop), and its timetable goes on it as tags, not as a relation per day. Both days use the same ${p.stops.length} stops and streets here, so it should be one relation.`)),
      el('div', {class: 'fixstep want'}, el('div', {class: 'k'}, 'flagstop would'),
        el('ul', {class: 'mergelist'},
          el('li', {}, 'keep ', el('a', {href: `https://www.openstreetmap.org/relation/${keep.id}`, target: '_blank'}, `r${keep.id}`), ` (the older; its history carries on), named "${x.name}"`),
          x.detour ? el('li', {}, "keep its stops and roads as OSM has them: the route is on a detour, and OSM maps the regular route (see the route's page to map the detour instead)") : null,
          x.detour ? null : el('li', {}, (x.stops.length < p.stops.length
            // (a stop OSM hasn't got counts once it's added, below)
            ? `give it ${x.stops.length} of the feed's ${p.stops.length} stops in order, and ${p.stops.length - x.stops.length > 1 ? 'those' : 'the one'} not in OSM if you add ${p.stops.length - x.stops.length > 1 ? 'them' : 'it'} below`
            : `give it the feed's ${x.stops.length} stops in order`) + (x.stale.length ? `; ${x.stale.length} it has now ${x.stale.length > 1 ? "aren't" : "isn't"} on the route any more: ${x.stale.slice(0, 6).map(o => o.tags.name || o.id).join(', ')}${x.stale.length > 6 ? ', …' : ''}` : '')
            + (mapsDetour(p) && x.stale.some(o => (D.detoured || {})[o.id]) ? " (the detour goes round them: they stay in OSM, for when it's over)" : '')),
          mapsDetour(p) ? el('li', {}, `note on it that it's a diversion (note=${DIVERSION}): the route is on a detour, mapped while it lasts`) : null,
          x.detour ? null : el('li', {}, 'list its roads in driving order, so they join up end to end' + (x.splits.length ? `, splitting ${x.splits.length} where the bus turns partway along: ${[...new Set(x.splits.map(b => this.roadName(p, b)))].join('; ')}` : '')),
          ...drop.map(a => el('li', {}, `delete r${a.id} "${a.name}"` + (x.master ? `, and take it out of the route master "${x.master.tags.name}"` : ''))),
          Object.keys(x.timetable).length ? el('li', {}, el('label', {}, el('input', {type: 'checkbox', checked: this.hours(x) ? '' : null, onchange: e => { S.merge.hours = e.target.checked; }}),
            ` and put the timetable on it (times at its first stop, ${D.stops[p.stops[0]].name}): `, el('code', {}, Object.entries(x.timetable).map(([k, v]) => `${k}=${v}`).join('  ')),
            x.uneven ? el('div', {class: 'muted small'}, "The gap between buses drifts through the day here; the interval is the usual one.") : null,
            x.clash.length ? el('div', {class: 'muted small'}, 'OSM has ', el('code', {}, [...new Set(x.rels.flatMap(a => x.clash.filter(k => a.tags[k]).map(k => `${k}=${a.tags[k]}`)))].join('  ')), '. Ticking replaces it.') : null)) : null)),
      ...[x.decide.length ? this.decisions(x) : null, x.gone.length ? this.goneStops(x) : null,
      x.questions.length ? el('div', {class: 'muted small', style: 'margin:6px 0'}, `${x.questions.length} other stop question${x.questions.length > 1 ? 's' : ''} on this route (names, codes) don't change the route; settle them in Check stops: `,
        ...x.questions.slice(0, 5).flatMap((q, i) => [i ? ', ' : '', el('a', {href: '#', title: q.why, onclick: e => { e.preventDefault(); showStop(q.s.id); }}, q.s.name)]), x.questions.length > 5 ? ', …' : '') : null].filter(Boolean));   // DOM append writes 'null' for null
    d.append(el('div', {class: 'seg'},
      el('button', {class: 'b' + (S.merge.view === 'now' ? ' on' : ''), onclick: () => this.show('now')}, 'OSM now'),
      el('button', {class: 'b' + (S.merge.view === 'proposed' ? ' on' : ''), onclick: () => this.show('proposed')}, 'Proposed')),
      el('div', {class: 'muted small'}, S.merge.view === 'now' ? 'On the map: the relations as they are (purple); red rings are the stops that would come out.' : x.detour ? 'On the map: the kept relation, as it stays: the regular route (purple), not the detour.' : 'On the map: the route as the one relation would have it (blue), and its stops.'));
    d.append(el('h2', {style: 'margin-left:0'}, 'Does this look right?'),
      el('div', {class: 'btns'},
        el('button', {class: 'b primary', disabled: x.open ? '' : null, title: x.open ? 'Decide the stops above first' : '', onclick: () => this.accept()}, x.open ? `Looks right (decide ${x.open} stop${x.open > 1 ? 's' : ''} first)` : 'Looks right: add to Changes'),
        el('button', {class: 'b', onclick: () => openIn('rapid', {...centerOf(p.shape.length ? p.shape : p.routed.geometry), zoom: 14, select: rels.map(a => 'r' + a.id), pattern: p, comment: `Bus route ${r.short}: one relation`})}, 'Let me edit it (RapiD)'),
        el('button', {class: 'b', onclick: () => { this.close(); toast('Left as OSM has it'); }}, 'Not right')),
      el('div', {class: 'muted small'}, 'Not right? If the days really do run different streets or stops, they should stay separate relations: one per way the route is run.'));
    P.append(d);
  },

  /** The timetable the OSM way, as tags on the route's relation: when it runs (first departure from its first
   *  stop to last arrival), and how often (the busiest days' usual gap as interval, the other days' as
   *  interval:conditional; where the gap drifts through the day, the usual one, and uneven says so).
   *  clash: the keys where OSM (any of rels) already has another value, a question rather than an overwrite. */
  timetable(p, rels) {
    const svc = (p.services || []).filter(x => x.trips && x.days), main = [...svc].sort((a, b) => b.trips - a.trips)[0];
    const tags = svc.length ? {opening_hours: svc.map(x => `${x.days} ${hhmm(x.first)}-${hhmm(x.last)}`).join('; ')} : {};
    if (main && main.every) {
      tags.interval = hhmm(main.every);
      const cond = svc.filter(x => x !== main && x.every && x.every !== main.every).map(x => `${hhmm(x.every)} @ (${x.days})`);
      if (cond.length) tags['interval:conditional'] = cond.join('; ');
    }
    const clash = Object.keys(tags).filter(k => rels.some(a => a.tags[k] && a.tags[k] !== tags[k]));
    const uneven = svc.some(x => x.every && !x.steady);
    return {tags, clash, uneven, first: D.stops[p.stops[0]]};
  },

  /** Timetable tags: in by default, unless OSM already has other values (then it's the user's call). */
  hours(x) { return S.merge.hours != null ? S.merge.hours : !x.clash.length; },

  /** Split where needed, re-route on that, check the roads join up, then write the one relation. */
  async accept() {
    const p = patternById(S.merge.pid), x = this.plan(p), hours = this.hours(x);
    const say = m => toast(m, 8000);
    Edits.hold(`one relation for route ${x.r.short}`);   // the splits and the relation: one undo
    try {
      await splitWhereTheBusTurns(p, x.splits, new Set(x.rels.map(a => a.id)), say);   // its own relations are rewritten after: not repaired here
      say(x.detour ? 'Keeping its stops and roads…' : 'Routing it on the result…');
      const tr = x.detour ? {ways: []} : await traceWith(p.id, {});
      await Roads.fetchWays(tr.ways.filter(w => w > 0));
      const breaks = x.detour ? 0 : Roads.chainBreaks(tr.ways.map(w => Roads.way(w)));
      if (breaks) return say(`Stopped: the roads still don't join up in ${breaks} place${breaks > 1 ? 's' : ''}. The splits are in Changes; nothing else was changed.`);
      // the stop decisions: moves, a stop picked out of several, stops added
      const added = {};
      for (const q of x.decide) {
        if (q.kind === 'where' && q.answer === 'move') {
          const tags = {}, diff = q.s.match.diff || {};
          for (const [k, on] of Object.entries(this.moveTags(q))) if (on) tags[k] = diff[k].gtfs;
          if (tags['gtfs:stop_id'] && q.s.proposed_tags['gtfs:stop_code'] && !q.o.tags['gtfs:stop_code']) tags['gtfs:stop_code'] = q.s.proposed_tags['gtfs:stop_code'];
          markUndo(Edits.modify('node', osmNumId(q.o), nodeBase(q.o), {...moveLL(q.s), tags}, `${q.s.ref} ${q.s.name}: ${q.s.match.move_how === 'restore' ? 'put back where it was' : "moved to the agency's spot"}`), q.s);
          const gone = mergedWith(q.s);   // two stops made one: the other goes
          if (gone) { const kept = await removeStops([gone], new Set(x.rels.map(a => a.id)), `merged into ${q.s.name}`); if (kept.length) say(`Not removed: ${kept.join('; ')}`); }
        }
        if (q.kind === 'which') {
          const pick = (S.merge.answers[q.s.id] || {}).pick, sh = q.s.match.shared;
          if (sh && pick === sh.id && D.osm_stops[sh.own]) { const kept = await shareStop(q.s, D.osm_stops[pick], D.osm_stops[sh.own]); if (kept.length) say(`Not removed: ${kept.join('; ')}`); }
          else Edits.decisions[q.s.id] = pick;
        }
        if (q.kind === 'missing' && q.answer === 'add') { const [lon, lat] = newStopSpot(q.s, p).at; added[q.s.id] = Edits.createNode(lat, lon, q.s.proposed_tags, `${q.s.ref} ${q.s.name}`); }
      }
      const plat = ({s, o, add}) => add ? {key: added[s.id], role: 'platform'} : {type: 'node', ref: osmNumId(o), role: 'platform'};
      const sp = p.stop_positions || {};   // PTv2: a stop's stop position on the road, then its platform
      const members = x.detour ? ((Edits.get('r' + x.keep.id) || {}).members || x.keep.members).map(m => ({...m}))   // the regular route, as it is
        : [...x.stops.flatMap(st => [...(sp[st.s.id] ? [{type: 'node', ref: sp[st.s.id], role: 'stop'}] : []), plat(st)]), ...tr.ways.map(w => ({type: 'way', ref: w, role: ''}))];
      const tags = {...x.tags, ...(hours ? x.timetable : {})};
      // stops gone for real: only if nothing else on OSM uses them (another relation); a stop that's a point on a
      // sidewalk line loses its bus stop tags instead of being deleted (deleting it would break the line)
      const kept = await removeStops(x.gone.filter(o => (S.merge.gone || {})[o.id] === 'remove'), new Set(x.rels.map(a => a.id)));
      if (kept.length) say(`Not removed, something else uses them: ${kept.join('; ')}`);
      const key = Edits.modify('relation', x.keep.id, relBase(x.keep), {tags, members, removeTags: x.removeTags || []}, `${x.r.short}: one relation for one route`);
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
