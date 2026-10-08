/* review.js — a route's stops, with flagstop's suggestion for every difference, for a person to check.

   tool/review.py decides each difference (stops.decide): take the agency's value, keep OSM's, or ask, with
   a reason. Nothing here is applied by itself: the reviewer goes down the route on the map, flips what's
   wrong, answers the questions, and adds the route to Changes. Like RapiD's cap on AI suggestions, at most
   UPLOAD_CAP changes go in one upload; past that, upload first. */
'use strict';

const UPLOAD_CAP = Edits.CAP;   // changes per upload (edits.js)
const KEY_WORDS = {ref: 'code', 'gtfs:stop_id': 'GTFS id', route_ref: 'routes', description: 'announcement', name: 'name', position: 'position', wheelchair: 'wheelchair', tagging: 'PTv2 tags'};

const Review = {
  picks: {},   // stop id -> {key: 'agency' | 'keep' | null}; null = a question not yet answered


  /** The route's stops in order, once each, with their decisions. */
  stops(p) {
    const seen = new Set(), out = [];
    p.stops.forEach((sid, i) => {
      if (seen.has(sid)) return;
      seen.add(sid);
      const s = D.stops[sid], m = s.match, o = m && m.osm && m.osm[0] ? D.osm_stops[m.osm[0].id] : null;
      out.push({i, s, o, decide: (m && m.decide) || {}, status: stopStatus(s), inChanges: !!(o && Edits.get('n' + osmNumId(o)))});
    });
    return out;
  },
  pick(st) {
    const sid = st.s.id;
    if (!this.picks[sid]) {
      this.picks[sid] = {};
      const was = Edits.answers[sid] || {};   // answered before (this or another session): not asked again
      for (const [k, d] of Object.entries(st.decide)) this.picks[sid][k] = d.pick === 'ask' ? (was[k] || null) : d.pick;
    }
    return this.picks[sid];
  },
  /** What a stop's row would add: the tags and position the agency side is picked for. */
  change(st) {
    const pk = this.pick(st), diff = (st.s.match && st.s.match.diff) || {}, tags = {};
    let move = false;
    for (const [k, v] of Object.entries(pk)) {
      if (v !== 'agency') continue;
      if (k === 'position') move = true;
      else if (k === 'tagging') Object.assign(tags, {highway: 'bus_stop', public_transport: 'platform', bus: 'yes'});
      else if (diff[k]) tags[k] = diff[k].gtfs;
    }
    // the stop code travels with the GTFS id
    if (tags['gtfs:stop_id'] && st.s.proposed_tags['gtfs:stop_code'] && !(st.o.tags['gtfs:stop_code'])) tags['gtfs:stop_code'] = st.s.proposed_tags['gtfs:stop_code'];
    return {tags, move, any: move || Object.keys(tags).length > 0};
  },
  open(pid) { S.review = pid; S.reviewStop = null; render(); draw(); },
  close() { S.review = null; S.reviewStop = null; render(); draw(); },
  focus(sid) {
    S.reviewStop = sid; render(); draw();
    const s = D.stops[sid], o = matchedOsm(s), at = o ? osmPos(o) : [s.lon, s.lat];
    map.flyTo({center: at, zoom: Math.max(map.getZoom(), 18), duration: 400});
    const row = document.querySelector(`[data-review="${sid}"]`); if (row) row.scrollIntoView({block: 'nearest'});
  },
  /** The next stop with an unanswered question (or, failing that, the next with a change), after the current one. */
  next(dir = 1) {
    const p = patternById(S.review), list = this.stops(p).filter(st => st.o && !st.inChanges && (Object.values(this.pick(st)).includes(null) || this.change(st).any));
    if (!list.length) return;
    const i = list.findIndex(st => st.s.id === S.reviewStop);
    this.focus(list[(i + dir + list.length) % list.length].s.id);
  },
  answerCurrent(v) {
    const p = patternById(S.review), st = p && this.stops(p).find(x => x.s.id === S.reviewStop);
    if (!st) return;
    const pk = this.pick(st), k = Object.keys(pk).find(x => pk[x] === null);
    if (k) { pk[k] = v; render(); draw(); }
  },

  render(P, p) {
    const r = routeOf(p), list = this.stops(p);
    const live = list.filter(st => st.o && !st.inChanges && (st.status === 'matched' || st.status === 'moved'));
    const changing = live.filter(st => this.change(st).any);
    const open = live.reduce((n, st) => n + Object.values(this.pick(st)).filter(v => v === null).length, 0);   // questions, not stops
    const inBasket = Edits.count(), after = inBasket + changing.length;
    P.append(el('button', {class: 'back', onclick: () => this.close()}, `← ${r.long || 'route ' + r.short}`));
    const d = el('div', {class: 'detail'});
    d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, 'Check the stops')),
      el('div', {class: 'hint', style: 'padding-left:0'}, 'flagstop has made a call on every difference between the agency and OSM, with its reason. Go down the route on the map: untick what\'s wrong, answer the questions, then add the route to Changes. Nothing is applied until you do.'),
      el('div', {class: 'kv'},
        el('span', {class: 'k'}, 'this route'), el('span', {}, `${changing.length} stop${changing.length === 1 ? '' : 's'} to change · ${open ? `${open} question${open > 1 ? 's' : ''} to answer` : 'no questions left'}`),
        el('span', {class: 'k'}, 'upload'), el('span', {class: after > UPLOAD_CAP ? 'bad' : ''}, `${after} of ${UPLOAD_CAP} changes with this route`)),
      el('div', {class: 'muted small'}, 'Keys: ↓ ↑ next / previous stop · A agency\'s · O keep OSM\'s'));
    const ul = el('div', {class: 'reviewlist'});
    let quiet = 0;
    for (const st of list) {
      const {s, o} = st, on = S.reviewStop === s.id;
      if (!o || st.status === 'missing' || st.status === 'ambiguous') {
        ul.append(el('div', {class: 'reviewrow dim', 'data-review': s.id, onclick: () => showStop(s.id)}, el('span', {class: 'n'}, st.i + 1), el('span', {class: 'dotc ' + st.status}),
          el('span', {class: 'grow'}, s.name, el('div', {class: 'muted'}, st.status === 'missing' ? 'not in OSM: add it from Stops' : 'more than one OSM stop could be it: pick in Stops'))));
        continue;
      }
      if (st.inChanges) {
        ul.append(el('div', {class: 'reviewrow dim', 'data-review': s.id, onclick: () => this.focus(s.id)}, el('span', {class: 'n'}, st.i + 1), el('span', {class: 'dotc ' + st.status}),
          el('span', {class: 'grow'}, s.name, el('span', {class: 'chip edit', style: 'margin-left:6px'}, Edits.ops['n' + osmNumId(st.o)] ? 'in Changes' : 'uploaded'))));
        continue;
      }
      const pk = this.pick(st), keys = Object.keys(st.decide);
      // a stop whose every difference is kept (as OSM has it) has nothing to check: it's only counted
      if (!keys.some(k => pk[k] !== 'keep') && !(s.osm_notes || []).length) { quiet++; continue; }
      const diff = (s.match && s.match.diff) || {};
      const row = el('div', {class: 'reviewrow' + (on ? ' on' : ''), 'data-review': s.id, onclick: e => { if (!e.target.closest('button, input, label')) this.focus(s.id); }},
        el('span', {class: 'n'}, st.i + 1), el('span', {class: 'dotc ' + st.status}));
      const body = el('div', {class: 'grow'}, el('div', {}, el('b', {}, s.name), o.tags.name && o.tags.name !== s.name ? el('span', {class: 'muted'}, ` · OSM: ${o.tags.name}`) : null));
      if ((s.osm_notes || []).length) body.append(noteLines(s.osm_notes));
      const kept = el('span', {class: 'kept'}), chips = el('div', {class: 'chips'});
      const short = x => x.length > 28 ? x.slice(0, 27) + '…' : x;
      for (const k of keys) {
        const dk = st.decide[k], v = pk[k], what = KEY_WORDS[k] || k;
        const from = k === 'position' ? '' : (diff[k] && diff[k].osm) || '—', to = k === 'position' ? '' : (diff[k] && diff[k].gtfs) || '';
        if (dk.pick === 'ask') {
          // where a stop goes is decided looking at it on the map, not from the text
          const wait = k === 'position' && !looked(s.id), off = wait ? {disabled: '', title: 'Look at it on the map first'} : {};
          body.append(el('div', {class: 'ask' + (v ? ' answered' : '')},
            el('div', {}, el('b', {}, `? ${what}`), k === 'position' ? '' : ` ${from} → ${to}`), el('div', {class: 'why'}, dk.why),
            k === 'position' ? el('div', {style: 'margin:4px 0'}, lookButtons(s, o)) : null,
            el('span', {class: 'btns'},
              el('button', {class: 'b tiny' + (v === 'agency' ? ' chosen' : ''), ...off, onclick: () => { pk[k] = v === 'agency' ? null : 'agency'; Edits.answer(s.id, k, pk[k]); render(); draw(); }}, (v === 'agency' ? '✓ ' : '') + (k === 'position' ? (s.match && s.match.move_how === 'shift' ? 'move it as the agency did' : "move to the agency's point") : "agency's")),
              el('button', {class: 'b tiny' + (v === 'keep' ? ' chosen' : ''), ...off, onclick: () => { pk[k] = v === 'keep' ? null : 'keep'; Edits.answer(s.id, k, pk[k]); render(); draw(); }}, (v === 'keep' ? '✓ ' : '') + (k === 'position' ? 'leave it' : "keep OSM's")),
              k === 'position' && !wait ? el('a', {href: '#', class: 'muted', onclick: e => { e.preventDefault(); showStop(s.id); }}, 'or place it by hand') : null)));
        } else {
          // one chip per difference: filled = the agency's value goes in, outlined = OSM's stays. Click flips it;
          // the reason is on hover.
          const label = k === 'position' ? 'move to agency\'s point' : k === 'gtfs:stop_id' ? 'GTFS id' :
            k === 'description' ? `announcement “${short(to)}”` : from && from !== '—' ? `${what} ${short(from)} → ${short(to)}` : `${what} ${short(to)}`;
          const chip = el('button', {class: 'pickchip' + (v === 'agency' ? ' take' : ''), title: `${v === 'agency' ? 'Goes in' : 'Stays as OSM has it'}: ${dk.why}. Click to ${v === 'agency' ? 'keep OSM\'s' : 'take the agency\'s'}.`,
            onclick: () => { pk[k] = v === 'agency' ? 'keep' : 'agency'; render(); draw(); }}, v === 'agency' ? `✓ ${label}` : `${what} kept`);
          (v === 'agency' ? chips : kept).append(chip);
        }
      }
      if (kept.childNodes.length) chips.append(kept);
      body.append(chips);
      row.append(body);
      ul.append(row);
    }
    if (quiet) ul.append(el('div', {class: 'muted small', style: 'padding:6px 0'}, `${quiet} more stop${quiet > 1 ? 's' : ''}: nothing to change (any differences are only in how they're written, or a few metres).`));
    d.append(ul);
    const why = open ? `Answer the ${open} question${open > 1 ? 's' : ''} first` : !changing.length ? 'Nothing to add' :
      after > UPLOAD_CAP ? `That makes ${after} changes; ${UPLOAD_CAP} at most per upload. Upload what's in Changes first, or untick some.` : null;
    d.append(el('div', {class: 'reviewfoot'},
      el('button', {class: 'b primary', disabled: why ? '' : null, onclick: () => this.accept(p, changing)}, `Add ${changing.length} checked stop${changing.length === 1 ? '' : 's'} to Changes`),
      why ? el('div', {class: 'muted small'}, why) : null));
    P.append(d);
  },
  async accept(p, changing) {
    const r = routeOf(p);
    Edits.hold(`stops on route ${r.short}, checked (${changing.length})`);
    const kept = [];
    try {
      // a stop the review found at a distance ('moved') is that OSM node whichever way its position was answered:
      // the relation lists it from now on
      for (const st of this.stops(p)) if (st.o && st.status === 'moved' && this.pick(st).position) Edits.decisions[st.s.id] = st.o.id;
      for (const st of changing) {
        const c = this.change(st), s = st.s, o = st.o;
        const key = Edits.modify('node', osmNumId(o), nodeBase(o), {tags: c.tags, ...(c.move ? moveLL(s) : {})}, `${s.ref} ${s.name}`);
        Edits.ops[key].suggested = true;   // counts toward the per-upload cap
        Edits.ops[key].route = r.short;    // and the changeset comment names the route that was checked
        // two stops the agency made one: the one moved here stays, the other goes
        if (c.move && mergedWith(s)) kept.push(...await removeStops([mergedWith(s)], new Set(), `merged into ${s.name}`));
      }
      Edits.save();
    } finally { Edits.release(); }
    toast(`${changing.length} stops on route ${r.short} added to Changes` + (kept.length ? `; not removed, something else uses it: ${kept.join('; ')}` : ''), kept.length ? 8000 : 4000);
    render(); draw();
  },
};

document.addEventListener('keydown', e => {
  if (!S.review || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); Review.next(1); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); Review.next(-1); }
  else if (e.key === 'a') Review.answerCurrent('agency');
  else if (e.key === 'o') Review.answerCurrent('keep');
});
