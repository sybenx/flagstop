/* fixit.js — one route, one click: everything flagstop can do for an itinerary without a person is done, and
   what it can't decide is listed first, with the choice.

   Done by itself: the review's calls on every stop (tags the agency's where the review said so), stops the agency
   has that OSM hasn't (added: new, useful data), the relation rewritten from the agency's line (PTv2 order, the
   roads split where the bus turns, duplicates merged away, its route_master kept or made), the agency's timetable
   on it. The mapper's roads the agency's line doesn't drive are dropped (the agency's shapes are the record of
   where the bus goes), and listed. Decided by a person: where a stop goes (a look at the map first), which of two
   OSM stops is the agency's, a name the review wasn't sure of, a routed path that doesn't join up. */
'use strict';

const FixIt = {
  open(pid) { S.fixit = {pid, answers: {}, keepDuplicates: false}; document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove()); render(); draw(); },
  close() { S.fixit = null; render(); draw(); },

  /** The plan: what will be done, what has to be decided first. */
  plan(p) {
    const r = routeOf(p), ans = S.fixit.answers;
    const stops = [], decide = [], done = [];
    for (const st of Review.stops(p)) {
      const s = st.s, m = s.match || {};
      if (st.inChanges) { done.push(`${s.name}: already in Changes`); continue; }
      if (st.status === 'ambiguous') {
        const cands = (m.osm || []).map(c => ({...c, o: D.osm_stops[c.id]})).filter(c => c.o), a = ans[s.id + ':which'];
        decide.push({kind: 'which', s, cands, answer: a});
        if (a === 'none') stops.push({st, add: true}); else if (a) stops.push({st, pick: a});
        continue;
      }
      if (!st.o) { stops.push({st, add: true}); continue; }   // not in OSM: added
      const pk = Review.pick(st);
      for (const [k, dk] of Object.entries(st.decide)) {
        if (dk.pick !== 'ask') continue;
        const a = ans[s.id + ':' + k];
        if (a) pk[k] = a;
        decide.push({kind: k === 'position' ? 'where' : 'tag', s, o: st.o, k, why: dk.why, answer: pk[k]});
      }
      const c = Review.change(st);
      if (c.any) stops.push({st, change: c});
    }
    const x = relationPlan(p);
    if (x.gaps || !x.chainOk) decide.push({kind: 'broken', why: x.chainOk ? `the routed path has ${x.gaps} gap${x.gaps > 1 ? 's' : ''}: a road missing or cut on the map` : "the routed path is broken: a leg didn't connect"});
    const timetable = Merge.timetable(p, x.reuse ? [x.reuse] : []);
    const hours = !timetable.clash.length && Object.keys(timetable.tags).length;
    const open = decide.filter(q => q.kind === 'broken' || !q.answer).length;
    const adds = stops.filter(y => y.add).length, changes = stops.filter(y => y.change).length;
    const splitOps = x.keepWays ? 0 : x.splits * 2;   // a split: the way and its new piece (repairs of other relations too, uncounted)
    const count = adds + changes + 1 + splitOps + (S.fixit.keepDuplicates ? 0 : x.duplicates.length) + (x.masters.length ? 0 : 1);
    return {p, r, stops, decide, open, done, x, timetable, hours, adds, changes, count};
  },

  render(P) {
    const p = patternById(S.fixit.pid), x = this.plan(p), r = x.r, rp = x.x;
    P.append(el('button', {class: 'back', onclick: () => this.close()}, `← ${p.headsign || r.long}`));
    const d = el('div', {class: 'detail fixcard'});
    d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, `Fix ${r.short} ${p.headsign || ''}`.trim())));
    const inBasket = Edits.count(), after = inBasket + x.count;
    d.append(el('div', {class: 'kv'},
      el('span', {class: 'k'}, 'this route'), el('span', {}, `${x.count} change${x.count === 1 ? '' : 's'}${x.open ? ` · ${x.open} to decide first` : ' · nothing to decide'}`),
      el('span', {class: 'k'}, 'upload'), el('span', {class: after > UPLOAD_CAP ? 'bad' : ''}, `${after} of ${UPLOAD_CAP} changes with this route`)));
    if (x.decide.length) {
      const box = el('div', {class: 'fixstep', style: 'border-left-color:var(--amb)'}, el('div', {class: 'k'}, `Decide first: ${x.decide.length}`));
      for (const q of x.decide) box.append(this.question(q));
      d.append(box);
    }
    // what will be done
    const will = el('div', {class: 'fixstep want'}, el('div', {class: 'k'}, 'Done for you'));
    const ul = el('ul', {class: 'plain small'});
    if (x.changes) ul.append(el('li', {}, `${x.changes} stop${x.changes > 1 ? 's' : ''} updated to the agency's data (codes, names, announcements, routes), as the review decided`,
      el('a', {href: '#', class: 'muted', style: 'margin-left:6px', onclick: e => { e.preventDefault(); Review.open(p.id); }}, 'see each')));
    if (x.adds) ul.append(el('li', {}, `${x.adds} stop${x.adds > 1 ? 's' : ''} the agency has and OSM hasn't: added at the agency's point, with its tags`));
    const relWhat = rp.reuse ? `relation ${rp.reuse.tags.name || 'r' + rp.reuse.id} rewritten` : 'a new relation';
    ul.append(el('li', {}, `${relWhat}: the agency's ${p.stops.length} stops in order, then the roads of its line` +
      (rp.keepWays ? ' (the mapper\'s roads kept: they already follow the line)' : rp.splits ? `, split where the bus turns partway along a road (${rp.splits})` : '') +
      (rp.refKept ? `; ref ${rp.refKept} kept (the agency's "${rp.tags.ref}" is it with a qualifier)` : '')));
    if (rp.dropped.length) ul.append(el('li', {}, `${rp.dropped.length} road${rp.dropped.length > 1 ? 's' : ''} the relation drove that the agency's line doesn't, dropped: `,
      el('span', {class: 'muted'}, [...new Set(rp.dropped.map(w => w.name || `w${w.way}`))].slice(0, 8).join(', ') + (new Set(rp.dropped.map(w => w.name || w.way)).size > 8 ? ', …' : '')),
      el('span', {class: 'muted'}, ' (if the bus does drive one, say so on the map: "bus uses this road")')));
    if (x.hours) ul.append(el('li', {}, `the timetable on it: ${Object.entries(x.timetable.tags).map(([k, v]) => `${k}=${v}`).join(', ')}`));
    else if (x.timetable.clash.length) ul.append(el('li', {class: 'muted'}, `the timetable left as OSM has it (${x.timetable.clash.join(', ')} differ)`));
    if (rp.duplicates.length) ul.append(el('li', {}, S.fixit.keepDuplicates ? `${rp.duplicates.length} other relation${rp.duplicates.length > 1 ? 's' : ''} for this itinerary left as they are` :
      `${rp.duplicates.length} other relation${rp.duplicates.length > 1 ? 's' : ''} for this itinerary (${rp.duplicates.map(a => a.tags.name || 'r' + a.id).join(', ')}) deleted, the one kept swapped into the route_master`,
      ' ', el('a', {href: '#', class: 'muted', onclick: e => { e.preventDefault(); S.fixit.keepDuplicates = !S.fixit.keepDuplicates; render(); }}, S.fixit.keepDuplicates ? 'merge them' : 'keep them')));
    ul.append(el('li', {}, rp.masters.length ? `in its route_master (r${rp.masters[0]})` : 'a route_master made for it'));
    will.append(ul);
    d.append(will);
    if (x.done.length) d.append(el('div', {class: 'muted small'}, x.done.join(' · ')));
    const why = x.open ? `Decide the ${x.open} above first` : after > UPLOAD_CAP ? `That makes ${after} changes; ${UPLOAD_CAP} at most per upload. Upload what's in Changes first.` : null;
    d.append(el('div', {class: 'btns', style: 'margin-top:10px'},
      el('button', {class: 'b primary', disabled: why ? '' : null, title: why || '', onclick: () => this.apply(p)}, `Do it: ${x.count} change${x.count === 1 ? '' : 's'} to Changes`),
      el('button', {class: 'b', onclick: () => this.close()}, 'Not now')),
      why ? el('div', {class: 'muted small'}, why) : el('div', {class: 'muted small'}, 'Then upload from Changes. Nothing goes to OSM until you do.'));
    P.append(d);
  },

  /** One thing to decide, with its choice. */
  question(q) {
    const row = el('div', {class: 'decide' + (q.answer ? ' answered' : '')});
    const set = (key, v) => { S.fixit.answers[key] = S.fixit.answers[key] === v ? null : v; render(); draw(); };
    if (q.kind === 'broken') {
      row.append(el('div', {}, el('b', {}, 'The route can\'t be traced whole'), el('div', {class: 'why'}, q.why + '. Re-route it (via a point, a road), or fix the map, then come back.')));
      return row;
    }
    const s = q.s, key = s.id + ':' + (q.kind === 'which' ? 'which' : q.k);
    row.append(el('div', {}, el('b', {}, s.name), el('span', {class: 'muted'}, q.kind === 'which' ? ' · which OSM stop is it?' : q.kind === 'where' ? ' · where does it go?' : ` · ${KEY_WORDS[q.k] || q.k}`)));
    if (q.kind === 'which') {
      row.append(el('div', {class: 'why'}, 'More than one OSM stop could be the agency\'s. Look at them on the map.'), el('div', {style: 'margin:4px 0'}, lookButtons(s, null)));
      const b = el('div', {class: 'btns'});
      for (const c of q.cands) b.append(el('button', {class: 'b tiny' + (q.answer === c.id ? ' chosen' : ''), onclick: () => set(key, c.id)}, `${q.answer === c.id ? '✓ ' : ''}${c.o.tags.name || c.id} (${c.dist} m)`));
      b.append(el('button', {class: 'b tiny' + (q.answer === 'none' ? ' chosen' : ''), onclick: () => set(key, 'none')}, (q.answer === 'none' ? '✓ ' : '') + 'none of these: add the agency\'s'));
      row.append(b);
    } else if (q.kind === 'where') {
      const wait = !looked(s.id), off = wait ? {disabled: '', title: 'Look at it on the map first'} : {};
      row.append(el('div', {class: 'why'}, q.why), el('div', {style: 'margin:4px 0'}, lookButtons(s, q.o)),
        el('div', {class: 'btns'},
          el('button', {class: 'b tiny' + (q.answer === 'agency' ? ' chosen' : ''), ...off, onclick: () => set(key, 'agency')}, (q.answer === 'agency' ? '✓ ' : '') + "move OSM's stop to the agency's point"),
          el('button', {class: 'b tiny' + (q.answer === 'keep' ? ' chosen' : ''), ...off, onclick: () => set(key, 'keep')}, (q.answer === 'keep' ? '✓ ' : '') + 'leave it where it is')));
    } else {
      const diff = (s.match && s.match.diff) || {}, from = (diff[q.k] && diff[q.k].osm) || '—', to = (diff[q.k] && diff[q.k].gtfs) || '';
      row.append(el('div', {class: 'why'}, `${from} → ${to}. ${q.why}`),
        el('div', {class: 'btns'},
          el('button', {class: 'b tiny' + (q.answer === 'agency' ? ' chosen' : ''), onclick: () => set(key, 'agency')}, (q.answer === 'agency' ? '✓ ' : '') + `agency's: ${to}`),
          el('button', {class: 'b tiny' + (q.answer === 'keep' ? ' chosen' : ''), onclick: () => set(key, 'keep')}, (q.answer === 'keep' ? '✓ ' : '') + `keep OSM's: ${from}`)));
    }
    return row;
  },

  /** Everything into Changes, as one undo step. Stops first (the relation lists them), then the relation (split
   *  roads, repairs), the duplicates, the master. A failure part way leaves what was done and says what wasn't. */
  async apply(p) {
    const x = this.plan(p), r = x.r;
    if (x.open) return;
    const say = m => toast(m, 8000);
    Edits.hold(`fix route ${r.short} ${p.headsign || ''}`.trim());
    const kept = [];
    try {
      for (const y of x.stops) {
        const s = y.st.s;
        if (y.pick) Edits.decisions[s.id] = y.pick;
        if (y.add) { const k = Edits.createNode(s.lat, s.lon, s.proposed_tags, `${s.ref} ${s.name}`); Edits.ops[k].suggested = true; Edits.ops[k].route = r.short; continue; }
        if (y.change) {
          const o = y.st.o, c = y.change;
          const key = Edits.modify('node', osmNumId(o), nodeBase(o), {tags: c.tags, ...(c.move ? {lat: s.lat, lon: s.lon} : {})}, `${s.ref} ${s.name}`);
          Edits.ops[key].suggested = true; Edits.ops[key].route = r.short;
          if (c.move && mergedWith(s)) kept.push(...await removeStops([mergedWith(s)], new Set(), `merged into ${s.name}`));
        }
      }
      Edits.save();
      const res = await proposeRelation(p, {quiet: true, extraTags: x.hours ? x.timetable.tags : {}});
      if (!res.ok) { say(`The stops are in Changes; the relation isn't: ${res.why}.`); return; }
      const keep = x.x.reuse ? {type: 'relation', ref: x.x.reuse.id} : {key: res.key};
      if (!S.fixit.keepDuplicates) for (const a of x.x.duplicates) {
        Edits.delete('relation', a.id, relBase(a), `duplicate of route ${r.short}`);
        editMasters([], a.id, keep);   // out of its master, the kept one in (OSM keeps a relation a master still lists)
      }
      if (!x.x.masters.length) proposeMaster(r);
    } catch (e) { say(e.message); console.error(e); }
    finally { Edits.release(); }
    S.fixit = null;
    await liveRoute();
    toast(`Route ${r.short} ${p.headsign || ''}: in Changes. Upload when you're ready.` + (kept.length ? ` Not removed, something else uses it: ${kept.join('; ')}` : ''), 6000);
    render(); draw();
  },
};
