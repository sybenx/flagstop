/* fix.js — "this is what OSM says, it's wrong, it should be like this: does it look right?"

   A problem flagstop can explain comes with a proposed fix (tool/routes.py: a one-way pointing against the
   agency's line -> turn it round). This shows the road as OSM has it and as it would be, with the bus route
   re-routed both ways (tool/serve.py, on a copy of the roads), and asks. Looks right -> Changes (only to undo an
   edit that turned the road round: its history says so). Otherwise, or to edit it: RapiD. Not right -> nothing.

   Also: any route on screen is re-routed with the road edits waiting in Changes, so a fixed problem stops
   showing as one before it's uploaded. */
'use strict';

/** Road edits waiting in Changes, as the server's re-routing takes them; `extra` overrides on top. */
function roadPatches(extra = {}) {
  const ways = {}, nodes = {};
  for (const op of Object.values(Edits.ops)) {
    if (op.type === 'way' && op.kind !== 'delete' && op.nodes) ways[op.id] = {nodes: op.nodes, tags: op.tags};
    if (op.type === 'node' && op.kind !== 'delete' && op.lat != null) nodes[op.id] = [op.lon, op.lat];
  }
  Object.assign(ways, extra.ways || {}); Object.assign(nodes, extra.nodes || {});
  return {ways, nodes};
}
const hasRoadEdits = () => Object.values(Edits.ops).some(o => o.type === 'way' && o.nodes && String(o.note || '').startsWith('road: '));

async function traceWith(pid, extra, vias = []) {
  const r = await fetch('/api/trace', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({pattern: pid, vias, ...roadPatches(extra)})});
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}
/** The open route as it would run with what's in Changes (and any via points). */
async function liveRoute() {
  const p = S.pattern && patternById(S.pattern);
  if (!p) return;
  if (!hasRoadEdits() && !S.vias.length) { if (S.routedBy === 'changes') { S.routed = null; S.routedBy = null; render(); draw(); } return; }
  try {
    S.routed = await traceWith(p.id, {}, S.vias);
    S.routedBy = S.vias.length ? 'vias' : 'changes';
  } catch (e) { return; }   // no server re-routing: the review's own path stays
  render(); draw();
}

const Fix = {
  async open(d) {
    const p = patternById(S.pattern), f = d.fix;
    S.fix = {d, f, view: 'fixed', loading: true};
    document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove());
    render(); draw();
    try {
      // the road as OSM has it now, and whether someone turned it round before
      const j = await (await fetch(`${OSM_API}/api/0.6/way/${f.way}/full.json`)).json();
      const w = j.elements.find(e => e.type === 'way'), coord = {};
      for (const e of j.elements) if (e.type === 'node') coord[e.id] = [e.lon, e.lat];
      const back = await Roads.reversedFrom(f.way);
      const after = Roads.turned({nodes: w.nodes, tags: w.tags || {}}, back);
      S.fix.way = w; S.fix.coord = coord; S.fix.back = back; S.fix.after = after;
      S.fix.before = routedOf(p);
      S.fix.with = await traceWith(p.id, {ways: {[f.way]: after}});
      S.fix.loading = false;
    } catch (e) { S.fix.error = e.message; S.fix.loading = false; }
    if (S.fix) this.show(S.fix.view);
  },
  close() { S.fix = null; if (S.routedBy === 'fix') { S.routed = null; S.routedBy = null; } render(); draw(); liveRoute(); },
  /** Map and route as OSM has them now, or as they'd be with the fix. */
  show(view) {
    const x = S.fix; if (!x) return;
    x.view = view;
    S.routed = view === 'fixed' && x.with ? x.with : null; S.routedBy = S.routed ? 'fix' : null;
    render(); draw();
    if (x.way) fit(x.way.nodes.map(n => x.coord[n]).filter(Boolean).concat(x.d.shape || []), 90);
  },
  /** The road being fixed, with arrows the way traffic may go: red as it is, green as proposed. */
  features() {
    const x = S.fix;
    if (!x || !x.way) return [];
    const nodes = x.view === 'fixed' ? x.after.nodes : x.way.nodes;
    return [line(nodes.map(n => x.coord[n]).filter(Boolean), {color: x.view === 'fixed' ? css('--ok') : css('--miss')})];
  },
  async accept() {
    const x = S.fix, p = patternById(S.pattern);
    try {
      // the road editor makes the change (and checks the routes on that road): it needs the road loaded
      const pts = x.way.nodes.map(n => x.coord[n]).filter(Boolean), b = bboxOf(pts);
      await Roads.load([b.left, b.bottom, b.right, b.top]);
      await Roads.reverse(x.f.way, {route: routeOf(p).short, detour: x.d.length});
    } catch (e) { return toast(e.message, 6000); }
    S.fix = null; S.routed = null; S.routedBy = null;
    await liveRoute();
    toast(`${x.f.name} is ${x.f.want} in Changes. The route is shown with it.`, 5000);
    render(); draw();
    if (p) fit(x.d.shape && x.d.shape.length ? x.d.shape : [[x.d.lon, x.d.lat]], 120);
  },
  edit() {
    const x = S.fix, p = patternById(S.pattern);
    openIn('rapid', {lon: x.d.lon, lat: x.d.lat, zoom: 18, select: ['w' + x.f.way], pattern: p, comment: `Bus route ${routeOf(p).short}: ${x.f.name}`});
  },

  render(P) {
    const x = S.fix, p = patternById(S.pattern), r = routeOf(p);
    P.append(el('button', {class: 'back', onclick: () => this.close()}, `← ${p.headsign || r.long}`));
    const d = el('div', {class: 'detail fixcard'});
    d.append(el('div', {class: 'head'}, refBadge(r), el('h3', {}, `${x.f.name}: a fix to check`)));
    if (x.loading) { d.append(el('div', {class: 'muted'}, 'Looking at the road on OSM…')); P.append(d); return; }
    if (x.error) { d.append(el('div', {class: 'bad'}, `Couldn't read the road from OSM: ${x.error}`)); P.append(d); return; }
    const ld = x.f.want.replace('one-way ', ''), wd = x.f.now.replace('one-way ', '');
    const lostTo = x.before && x.before.score ? Math.round((1 - x.before.score.shape_covered) * 100) : null;
    d.append(
      el('div', {class: 'fixstep now'}, el('div', {class: 'k'}, 'OSM says'),
        el('div', {}, `${x.f.name} (way ${x.f.way}) is `, el('b', {}, x.f.now), '.')),
      el('div', {class: 'fixstep why'}, el('div', {class: 'k'}, 'Why that looks wrong'),
        el('div', {}, `Route ${r.short} goes ${ld} here, on the agency's line. With the road one-way ${wd}, a bus can't legally drive it, so the only way round on the map is the detour through the side streets and parking lot (${x.d.length} m).`),
        x.back ? el('div', {}, `It was one-way ${ld} until `, el('a', {href: `https://www.openstreetmap.org/changeset/${x.back.changeset}`, target: '_blank'}, `${x.back.user}'s edit on ${x.back.date}`), ', which turned it round.') : null),
      el('div', {class: 'fixstep want'}, el('div', {class: 'k'}, 'It should be'),
        el('div', {}, el('b', {}, x.f.want), x.back ? `: as it was before ${x.back.date}, side tags included.` : ': turned round, its side tags (sidewalk:left/right) swapped to stay on the same sides.'),
        x.with && x.with.score ? el('div', {class: 'muted'}, `With that, the bus can follow ${Math.round(x.with.score.shape_covered * 100)}% of the agency's line${x.with.divergences.length < x.before.divergences.length ? ', and this detour is gone' : ''}.`) : null));
    d.append(el('div', {class: 'seg'},
      el('button', {class: 'b' + (x.view === 'now' ? ' on' : ''), onclick: () => this.show('now')}, 'OSM now'),
      el('button', {class: 'b' + (x.view === 'fixed' ? ' on' : ''), onclick: () => this.show('fixed')}, 'With the fix')),
      el('div', {class: 'muted small'}, x.view === 'fixed' ? 'On the map: the road in green, arrows the way it would go; the blue line is the bus route with it.' : 'On the map: the road in red, arrows the way OSM has it; the blue line is the bus route now.'));
    d.append(el('h2', {style: 'margin-left:0'}, 'Does this look right?'),
      el('div', {class: 'btns'},
        // flagstop turns a road round only to undo an edit that turned it: a one-way against the line with no
        // such history may be right (a contraflow bus lane, a detour drawn as the line), and a mistake sends every car the wrong way
        x.back ? el('button', {class: 'b primary', onclick: () => this.accept()}, 'Looks right: add to Changes') : null,
        el('button', {class: x.back ? 'b' : 'b primary', onclick: () => this.edit()}, x.back ? 'Let me edit it (RapiD)' : 'Look in RapiD'),
        el('button', {class: 'b', onclick: () => { this.close(); toast('Left as OSM has it'); }}, 'Not right')),
      x.back ? el('div', {class: 'muted small'}, 'Not right? Then the bus may really go another way here: the agency\'s line could be a detour, or drawn off the street.')
        : el('div', {class: 'note'}, "Nothing in this road's history says it ran the other way, so flagstop leaves it to you. If buses may go against the one-way here, it wants oneway:bus=no (edit tags, from the place on the route); if the road itself is wrong, fix it in RapiD."));
    P.append(d);
  },
};
