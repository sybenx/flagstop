/* roads.js — road edits that keep the bus routes on them whole.

   iD and RapiD refuse to disconnect a junction that a route relation runs through, and a split or a
   moved connection elsewhere quietly leaves routes broken for someone else to find. flagstop knows the
   routes, so it makes the change and repairs every relation that used those roads, in the same changeset:
     - public transport routes are re-chained end to end over the new pieces (one-ways respected);
     - turn restrictions keep the piece at their via;
     - any other relation gets every piece, in order.
   What can't be repaired is said, with the place, before anything is added to Changes.

   Works on live OSM data (the API's map call for the view, so versions are current), with the change
   basket layered on top: an edit here builds on edits already in Changes. */
'use strict';

const PT_ROUTES = new Set(['bus', 'trolleybus', 'share_taxi', 'minibus', 'coach', 'tram', 'light_rail']);
const DIRECTIONAL = /:(forward|backward|left|right)\b|^direction$|:direction$|^incline$/;   // tags that mean something relative to a way's direction
const PATHS = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'bridleway', 'corridor', 'platform', 'track']);
const MIN_ZOOM = 17;       // the map call is capped at 0.25 square degrees and 50,000 nodes; a few streets is plenty
const GAP_LIMIT = 800;     // m: longest stretch a repair may fill between two members of a route
const ARM_PX = 110;   // a selected junction's arms, in screen pixels: each is the end of a road, and is what you drag
const ARM_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#8f5e15', '#f08c00', '#0c8599', '#d6336c'];   // no purple: that's roads with routes
const ARM_NAMES = {'#e8590c': 'orange', '#1c7ed6': 'blue', '#2f9e44': 'green', '#8f5e15': 'brown', '#f08c00': 'yellow', '#0c8599': 'teal', '#d6336c': 'pink'};

const Roads = {
  on: false,
  nodes: {}, ways: {}, rels: {},   // live, from the last map call
  bbox: null,
  pick: null,                      // waiting for a map click: {kind: 'move'|'attach'|'segment', ...}
  sel: null,                       // {node} or {way} highlighted

  // ---------- the working copy: live data, with Changes on top ----------
  node(id) {
    const op = Edits.get(id < 0 ? 'new:n' + id : 'n' + id), b = this.nodes[id];
    if (op && op.kind === 'delete') return null;
    if (op && op.lat != null) return {...(b || {}), id, lat: op.lat, lon: op.lon, tags: op.tags};
    return b || null;
  },
  way(id) {
    const op = Edits.get(id < 0 ? 'new:w' + id : 'w' + id), b = this.ways[id];
    if (op && op.kind === 'delete') return null;
    if (op) return {...(b || {}), id, nodes: op.nodes || (b && b.nodes), tags: op.tags};
    return b || null;
  },
  rel(id) {
    const op = Edits.get(id < 0 ? 'new:r' + id : 'r' + id), b = this.rels[id];
    if (op && op.kind === 'delete') return null;
    if (op && op.members) return {...(b || {}), id, members: op.members.map(m => Edits.resolveMember(m)).filter(Boolean), tags: op.tags};
    return b || null;
  },
  wayIds() {
    const ids = new Set(Object.keys(this.ways).map(Number));
    for (const op of Object.values(Edits.ops)) if (op.type === 'way' && op.kind === 'create') ids.add(op.id);
    return [...ids];
  },
  relIds() {
    const ids = new Set(Object.keys(this.rels).map(Number));
    for (const op of Object.values(Edits.ops)) if (op.type === 'relation' && op.kind === 'create') ids.add(op.id);
    return [...ids];
  },

  async load(b) {
    const r = await fetch(`${OSM_API}/api/0.6/map.json?bbox=${b.map(x => x.toFixed(6)).join(',')}`);
    if (!r.ok) throw new Error(`OSM map call ${r.status}: ${(await r.text()).slice(0, 160)}`);
    this.nodes = {}; this.ways = {}; this.rels = {};
    for (const e of (await r.json()).elements) {
      if (e.type === 'node') this.nodes[e.id] = {id: e.id, lat: e.lat, lon: e.lon, tags: e.tags || {}, version: e.version};
      else if (e.type === 'way') this.ways[e.id] = {id: e.id, nodes: e.nodes, tags: e.tags || {}, version: e.version};
      else if (e.type === 'relation') this.rels[e.id] = {id: e.id, members: e.members.map(m => ({type: m.type, ref: m.ref, role: m.role})), tags: e.tags || {}, version: e.version};
    }
    this.bbox = b;
  },
  /** Member ways outside the loaded area: their node lists, so a route can be walked end to end. */
  async fetchWays(ids) {
    const want = [...new Set(ids)].filter(id => id > 0 && !this.ways[id]);
    for (let i = 0; i < want.length; i += 100) {
      const r = await fetch(`${OSM_API}/api/0.6/ways.json?ways=${want.slice(i, i + 100).join(',')}`);
      if (!r.ok) throw new Error(`OSM ways call ${r.status}`);
      for (const e of (await r.json()).elements) this.ways[e.id] = {id: e.id, nodes: e.nodes, tags: e.tags || {}, version: e.version, outside: true};
    }
  },

  // ---------- a transaction: edits worked out on top of the working copy, then saved to Changes ----------
  tx() {
    const R = this;
    return {
      nodes: {}, ways: {}, del: new Set(), split: {}, orig: {}, touched: new Set(), what: [],
      node(id) { return this.del.has(id) ? null : this.nodes[id] || R.node(id); },
      way(id) { return this.ways[id] || R.way(id); },
      wayIds() { return [...new Set([...R.wayIds(), ...Object.keys(this.ways).map(Number)])]; },
      waysAt(nid) { return this.wayIds().filter(w => { const x = this.way(w); return x && x.nodes.includes(nid); }); },
    };
  },
  len(t, nodes) { let L = 0; for (let i = 1; i < nodes.length; i++) L += m(this.ll(t, nodes[i - 1]), this.ll(t, nodes[i])); return L; },
  ll(t, nid) { const n = t.node(nid); return n ? [n.lon, n.lat] : [0, 0]; },
  label(w) { const t = (w && w.tags) || {}; return t.name || t.ref || (t.highway ? `${t.highway}${t.service ? ' ' + t.service : ''}` : 'way'); },

  /** Split way wid at interior node nid. The longer piece keeps the id (and its history). */
  split(t, wid, nid) {
    const w = t.way(wid), i = w.nodes.indexOf(nid);
    if (i <= 0 || i >= w.nodes.length - 1 || w.nodes[0] === w.nodes[w.nodes.length - 1]) throw new Error(`w${wid} can't be split at n${nid}: not a point inside it`);
    const a = w.nodes.slice(0, i + 1), b = w.nodes.slice(i);
    const [keep, give] = this.len(t, a) >= this.len(t, b) ? [a, b] : [b, a];
    const nid2 = Edits.newId();
    const orig = Object.keys(t.split).map(Number).find(o => t.split[o].includes(wid)) ?? wid;
    if (!t.orig[orig]) t.orig[orig] = w.nodes;
    t.ways[wid] = {...w, nodes: keep};
    t.ways[nid2] = {id: nid2, nodes: give, tags: {...w.tags}, created: true};
    t.split[orig] = [...new Set([...(t.split[orig] || [orig]), wid, nid2])];
    t.touched.add(wid); t.touched.add(nid2);
    return nid2;
  },
  /** A new node on way wid's segment i (between nodes i and i+1), at pt. */
  insert(t, wid, i, pt) {
    const w = t.way(wid), id = Edits.newId();
    t.nodes[id] = {id, lon: pt[0], lat: pt[1], tags: {}, created: true};
    t.ways[wid] = {...w, nodes: [...w.nodes.slice(0, i + 1), id, ...w.nodes.slice(i + 1)]};
    t.touched.add(wid);
    return id;
  },
  /** A click -> a node id: the vertex it hit, a new node on the road it hit, or a new node in the open. */
  nodeFor(t, s) {
    if (s.node != null) return s.node;
    if (s.way != null) return this.insert(t, s.way, s.index, s.point);
    const id = Edits.newId();
    t.nodes[id] = {id, lon: s.free[0], lat: s.free[1], tags: {}, created: true};
    return id;
  },
  inRoute(t, wid) { return this.relIds().some(r => { const x = this.rel(r); return x && x.members.some(mm => mm.type === 'way' && mm.ref === wid); }); },

  // ---------- relation repair ----------
  /** Bus-legal direction along a way's node order: 1 forward only, -1 backward only, 0 both. */
  dir(tags) {
    if (tags['oneway:bus'] === 'no' || tags['oneway:psv'] === 'no') return 0;
    if (['yes', 'true', '1'].includes(tags.oneway)) return 1;
    if (['-1', 'reverse'].includes(tags.oneway)) return -1;
    if (['roundabout', 'circular'].includes(tags.junction) && tags.oneway !== 'no') return 1;
    return 0;
  },
  /** Shortest bus-legal way sequence from any of `starts` to an end of way `target` (any node, if it is
      closed), over the candidate ways only. -> {start, ways, end} or null */
  connect(t, starts, target, cand) {
    const tw = t.way(target), closed = tw.nodes[0] === tw.nodes[tw.nodes.length - 1];
    const goals = new Set(closed ? tw.nodes : [tw.nodes[0], tw.nodes[tw.nodes.length - 1]]);
    for (const s of starts) if (goals.has(s)) return {start: s, ways: [], end: s};
    const adj = {};
    for (const wid of cand) {
      if (wid === target) continue;
      const w = t.way(wid); if (!w) continue;
      const d = this.dir(w.tags);
      for (let i = 1; i < w.nodes.length; i++) {
        const a = w.nodes[i - 1], b = w.nodes[i], L = m(this.ll(t, a), this.ll(t, b));
        if (d >= 0) (adj[a] = adj[a] || []).push([b, wid, L]);
        if (d <= 0) (adj[b] = adj[b] || []).push([a, wid, L]);
      }
    }
    const dist = {}, prev = {}, q = starts.map(s => [0, s]);
    for (const s of starts) dist[s] = 0;
    while (q.length) {
      q.sort((x, y) => x[0] - y[0]);
      const [c, n] = q.shift();
      if (c > dist[n]) continue;
      if (goals.has(n)) {
        const ways = []; let k = n;
        while (prev[k]) { const [p, wid] = prev[k]; if (ways[0] !== wid) ways.unshift(wid); k = p; }
        return {start: k, ways, end: n};
      }
      for (const [b, wid, L] of adj[n] || []) {
        if (c + L > GAP_LIMIT || c + L >= (dist[b] ?? Infinity)) continue;
        dist[b] = c + L; prev[b] = [n, wid]; q.push([c + L, b]);
      }
    }
    return null;
  },
  /** Pieces of a split way in travel order starting from node `at`. -> {ways, at} */
  orderFrom(t, pieces, at) {
    const left = new Set(pieces), out = [];
    for (;;) {
      const p = [...left].find(w => { const n = t.way(w).nodes; return n[0] === at || n[n.length - 1] === at; });
      if (p == null) return {ways: out, at};
      const n = t.way(p).nodes; out.push(p); left.delete(p); at = n[0] === at ? n[n.length - 1] : n[0];
    }
  },
  /** Re-chain a public transport route's ways. items: [{ref, role}] with split originals as {gap, pieces, role}. */
  chain(t, items, cand) {
    const out = [], bad = [];
    const push = (ref, role) => { if (!out.length || out[out.length - 1].ref !== ref) out.push({type: 'way', ref, role}); };
    let opts = null, lead = null, last = null;
    for (const it of items) {
      if (it.gap) { if (!out.length) lead = [...(lead || []), ...it.pieces]; continue; }
      const w = t.way(it.ref);
      if (!w || !w.nodes) { bad.push({after: last, before: it.ref, why: `w${it.ref} not loaded`}); continue; }
      const ends = [w.nodes[0], w.nodes[w.nodes.length - 1]], closed = ends[0] === ends[1];
      const touches = n => closed ? w.nodes.includes(n) : ends.includes(n);
      let entry = null;
      if (!out.length) {
        if (lead) {   // the route starts on a way that was split: the pieces that lead into this one
          for (const e of ends) { const o = this.orderFrom(t, lead, e); if (o.ways.length) { o.ways.reverse().forEach(p => push(p, it.role)); entry = e; break; } }
        }
      } else {
        entry = opts.find(touches);
        if (entry == null) {
          const c = this.connect(t, opts, it.ref, cand);
          if (c) { c.ways.forEach(x => push(x, it.role)); entry = c.end; }
          else bad.push({after: last, before: it.ref, why: 'no bus-legal connection between them'});
        }
      }
      push(it.ref, it.role);
      opts = closed ? w.nodes : entry == null ? ends : [entry === ends[0] ? ends[1] : ends[0]];
      last = it.ref;
    }
    // the route ends on a way that was split: carry on over its pieces from where it got to
    const tail = items.length && items[items.length - 1].gap ? items[items.length - 1] : null;
    if (tail && opts) for (const s of opts) { const o = this.orderFrom(t, tail.pieces, s); if (o.ways.length) { o.ways.forEach(p => push(p, tail.role)); break; } }
    return {ways: out, bad};
  },
  /** Every relation that uses an affected way, repaired. -> [{id, tags, members, bad}] */
  async repair(t) {
    const affected = new Set([...Object.keys(t.split).map(Number), ...t.touched]);
    const rels = this.relIds().map(id => this.rel(id)).filter(r => r && r.members.some(x => x.type === 'way' && affected.has(x.ref)));
    // routes are walked end to end, so every member way's nodes are needed, not only the ones on screen
    await this.fetchWays(rels.filter(r => this.isPT(r)).flatMap(r => r.members.filter(x => x.type === 'way').map(x => x.ref)));
    const cand = new Set([...Object.values(t.split).flat(), ...t.touched]);
    for (const n of [...Object.keys(t.nodes).map(Number), ...(t.hinge || [])]) for (const w of t.waysAt(n)) cand.add(w);
    const out = [];
    for (const r of rels) {
      let members, bad = [];
      if (this.isPT(r)) {
        // Only the stretch around the edited roads is re-chained: from the member before them to the one
        // after. The rest of the relation is left exactly as it is, breaks and all (not ours to guess at).
        const isRoad = x => x.type === 'way' && !/platform|stop/.test(x.role || '');
        const roads = r.members.filter(isRoad);
        const hit = roads.map((x, i) => affected.has(x.ref) ? i : -1).filter(i => i >= 0);
        const spans = [];
        for (const i of hit) {
          const a = Math.max(0, i - 1), b = Math.min(roads.length - 1, i + 1);
          if (spans.length && a <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = b; else spans.push([a, b]);
        }
        let out = roads.slice(0, spans.length ? spans[0][0] : roads.length);
        spans.forEach(([a, b], k) => {
          const win = roads.slice(a, b + 1);
          // A stretch that was already broken before this edit isn't re-routed (a guess at what the mapper
          // meant): split ways just get all their pieces, in place, and the break is left as it was.
          let ways;
          if (this.chainBreaks(win.map(x => this.way(x.ref)))) {
            ways = win.flatMap((x, i) => {
              if (!t.split[x.ref]) return [x];
              const o = t.orig[x.ref], seq = this.orderFrom(t, t.split[x.ref], o[0]).ways;
              const prev = i ? this.way(win[i - 1].ref) : null, next = i + 1 < win.length ? this.way(win[i + 1].ref) : null;
              // driven against its node order: the member before it meets its last node, or the one after its first
              const back = (prev && prev.nodes.includes(o[o.length - 1]) && !prev.nodes.includes(o[0])) || (next && next.nodes.includes(o[0]) && !next.nodes.includes(o[o.length - 1]));
              return (back ? seq.reverse() : seq).map(ref => ({type: 'way', ref, role: x.role}));
            });
          } else {
            const c = this.chain(t, win.map(x => t.split[x.ref] ? {gap: true, pieces: t.split[x.ref], role: x.role} : {ref: x.ref, role: x.role}), cand);
            ways = c.ways; bad.push(...c.bad);
          }
          out = [...out, ...ways, ...roads.slice(b + 1, k + 1 < spans.length ? spans[k + 1][0] : roads.length)];
        });
        // the road members go back where the first of them was; stops and platforms stay where they were
        const first = r.members.findIndex(isRoad), rest = r.members.filter(x => !isRoad(x));
        const k = first < 0 ? rest.length : r.members.slice(0, first).filter(x => !isRoad(x)).length;
        members = [...rest.slice(0, k), ...out, ...rest.slice(k)];
      } else if (r.tags.type === 'restriction') {
        const via = r.members.find(x => x.role === 'via');
        members = r.members.map(x => {
          if (x.type !== 'way' || !t.split[x.ref] || !['from', 'to'].includes(x.role)) return x;
          const viaNodes = !via ? [] : via.type === 'node' ? [via.ref] : (t.way(via.ref) || {nodes: []}).nodes;
          const p = t.split[x.ref].find(w => { const n = t.way(w).nodes; return viaNodes.includes(n[0]) || viaNodes.includes(n[n.length - 1]); });
          if (p == null) bad.push({after: null, before: x.ref, why: `restriction ${x.role} way no longer meets its via`});
          return {...x, ref: p ?? x.ref};
        });
      } else {
        members = [];
        r.members.forEach((x, i) => {
          if (x.type !== 'way' || !t.split[x.ref]) return members.push(x);
          const prevWay = members.length && members[members.length - 1].type === 'way' ? t.way(members[members.length - 1].ref) : null;
          const start = prevWay && t.split[x.ref].map(w => t.way(w).nodes).flatMap(n => [n[0], n[n.length - 1]]).find(n => prevWay.nodes.includes(n));
          const o = this.orderFrom(t, t.split[x.ref], start ?? t.orig[x.ref][0]);
          const missed = t.split[x.ref].filter(w => !o.ways.includes(w));
          for (const w of [...o.ways, ...missed]) members.push({type: 'way', ref: w, role: x.role});
        });
      }
      if (JSON.stringify(members) !== JSON.stringify(r.members) || bad.length) out.push({id: r.id, tags: r.tags, members, bad});
    }
    return out;
  },
  /** How many places a list of ways fails to run end to end. */
  chainBreaks(ws) {
    let opts = null, n = 0;
    for (const w of ws) {
      if (!w || !w.nodes) { n++; opts = null; continue; }
      const e = [w.nodes[0], w.nodes[w.nodes.length - 1]], closed = e[0] === e[1];
      let entry = null;
      if (opts) { entry = opts.find(x => closed ? w.nodes.includes(x) : e.includes(x)); if (entry == null) n++; }
      opts = closed ? w.nodes : entry == null ? e : [entry === e[0] ? e[1] : e[0]];
    }
    return n;
  },
  isPT(r) { return r.tags.type === 'route' && (PT_ROUTES.has(r.tags.route) || r.tags['public_transport:version'] === '2'); },

  /** Save a transaction and its repairs to Changes, as one decision. */
  commit(t, repairs, what) {
    const note = 'road: ' + what;
    // the undo button's words: what happened on the street, without the ids ("reconnect service to 500 North")
    Edits.label(what.replace(/\s*\((?:w|n)-?\d+\)/g, '').replace(/\s+(?:at|from) n-?\d+/g, '').replace(/^Move n-?\d+$/, 'move a junction').replace(/^\w/, c => c.toLowerCase()));
    const g = Edits.roadBegin(what), touch = (type, id) => Edits.roadTouch(g, id < 0 ? `new:${type[0]}${id}` : type[0] + id);
    for (const id of Object.keys(t.nodes)) touch('node', +id);
    for (const id of Object.keys(t.ways)) touch('way', +id);
    for (const id of t.del) touch('node', id);
    for (const r of repairs) touch('relation', r.id);
    for (const [id, n] of Object.entries(t.nodes).map(([k, v]) => [+k, v])) {
      if (n.created) Edits.createNode(n.lat, n.lon, n.tags, note, id);
      else if (id < 0) { const op = Edits.get('new:n' + id); op.lat = n.lat; op.lon = n.lon; }
      else Edits.modify('node', id, this.baseNode(id), {lat: n.lat, lon: n.lon}, note);
    }
    for (const [id, w] of Object.entries(t.ways).map(([k, v]) => [+k, v])) {
      if (w.created) Edits.createWay(w.tags, w.nodes, note, id);
      else if (id < 0) { const op = Edits.get('new:w' + id); op.nodes = w.nodes; op.note = note; }
      else {
        const before = this.way(id).tags || {};
        const changes = {nodes: w.nodes};
        if (JSON.stringify(before) !== JSON.stringify(w.tags)) { changes.tags = w.tags; changes.removeTags = Object.keys(before).filter(k => !(k in w.tags)); }
        this.modifyWay(id, changes, note);
      }
    }
    for (const id of t.del) Edits.delete('node', id, this.baseNode(id), note);
    if (this.undoes && Edits.get('w' + this.undoes.wid)) Edits.get('w' + this.undoes.wid).undoes = this.undoes.info;
    for (const r of repairs) {
      if (r.id < 0) { const op = Edits.get('new:r' + r.id); op.members = r.members; continue; }
      const b = this.rels[r.id];
      Edits.modify('relation', r.id, {version: b.version, tags: b.tags, members: b.members}, {members: r.members}, Edits.get('r' + r.id)?.note || note);
    }
    Edits.roadEnd(g);
  },
  baseNode(id) { const n = this.nodes[id]; return {version: n.version, tags: n.tags, lat: n.lat, lon: n.lon}; },
  /** A way edit on the live base. A tag edit made from the review data (no version) is lifted onto it. */
  modifyWay(id, changes, note) {
    const b = this.ways[id], op = Edits.get('w' + id);
    if (op && op.base && op.base.version == null && b) { op.base = {version: b.version, tags: {...b.tags}, nodes: [...b.nodes]}; if (!changes.nodes && !op.nodes) op.nodes = [...b.nodes]; }
    Edits.modify('way', id, {version: b.version, tags: b.tags, nodes: b.nodes}, changes, note);
  },

  /** Run an edit: work it out, repair relations, show what happens, add to Changes. */
  async run(what, build) {
    const t = this.tx();
    try {
      build(t);
      const repairs = await this.repair(t);
      const bad = repairs.flatMap(r => r.bad.map(b => ({...b, rel: r})));
      if (bad.length && !confirm(`${what}\n\n${bad.length} place${bad.length > 1 ? 's' : ''} in the routes can't be repaired automatically:\n` +
        bad.slice(0, 8).map(b => `  r${b.rel.id} ${b.rel.tags.name || ''}: ${b.why}${b.after ? ` (after w${b.after}, before w${b.before})` : ''}`).join('\n') +
        '\n\nAdd the edit anyway, and fix those by hand?')) { this.pick = null; this.drawAll(); return; }
      this.commit(t, repairs, what);
      const fixed = repairs.filter(r => !r.bad.length).length;
      toast(`${what}${repairs.length ? ` · ${fixed} relation${fixed === 1 ? '' : 's'} repaired` : ''}${bad.length ? ` · ${bad.length} to fix by hand` : ''}`, 5000);
    } catch (e) { toast(e.message, 6000); console.error(e); }
    this.pick = null; this.sel = null; map.getCanvas().style.cursor = ''; this.card(null);
    render(); draw(); this.drawAll(); this.status();
    liveRoute();
  },


  // ---------- the operations ----------
  splitAt(wid, nid) {
    const w = this.way(wid);
    return this.run(`Split ${this.label(w)} (w${wid}) at n${nid}`, t => this.split(t, wid, nid));
  },
  splitHere(s) {
    const w = this.way(s.way);
    return this.run(`Split ${this.label(w)} (w${s.way})`, t => { const n = this.insert(t, s.way, s.index, s.point); this.split(t, s.way, n); });
  },
  move(nid, pt) {
    return this.run(`Move n${nid}`, t => { const n = t.node(nid); t.nodes[nid] = {...n, lon: pt[0], lat: pt[1]}; });
  },
  /** Take the end of way wid off node `from` and put it on the snapped spot; split the road it lands on
      there when a route could use it, so the route can turn onto the right piece. */
  attach(wid, from, s) {
    const w = this.way(wid);
    const onto = s.node != null ? `n${s.node}` : `${this.label(this.way(s.way))} (w${s.way})`;
    return this.run(`Reconnect ${this.label(w)} (w${wid}) from n${from} to ${onto}`, t => {
      const cur = t.way(wid), at = cur.nodes[0] === from ? 0 : cur.nodes[cur.nodes.length - 1] === from ? cur.nodes.length - 1 : -1;
      if (at < 0) throw new Error(`w${wid} doesn't end at n${from}`);
      const to = this.nodeFor(t, s);
      if (cur.nodes.includes(to)) throw new Error('That is on the same way');
      const nodes = [...cur.nodes]; nodes[at] = to;
      t.ways[wid] = {...cur, nodes}; t.touched.add(wid);
      t.hinge = [from, to];
      for (const r of t.waysAt(to).filter(x => x !== wid)) {
        const rn = t.way(r).nodes, i = rn.indexOf(to);
        if (i > 0 && i < rn.length - 1 && rn[0] !== rn[rn.length - 1] && (this.inRoute(t, r) || this.inRoute(t, wid))) this.split(t, r, to);
      }
      // the old junction, if nothing uses it any more and it says nothing, goes
      const n = this.nodes[from];
      if (n && !Object.keys(n.tags).length && !t.waysAt(from).length && !this.relIds().some(r => (this.rel(r) || {members: []}).members.some(x => x.type === 'node' && x.ref === from))) t.del.add(from);
    });
  },
  /** A new road between two snapped spots. */
  /** Turn a road round: its nodes the other way, and the tags that are relative to its direction swapped
      (forward/backward, left/right), as iD does — so a one-way runs the other way and its lanes and sides
      still describe the same road. */
  async reverse(wid, context = null) {
    // already changed in Changes: an ordinary reversal of that; otherwise, check whether this undoes someone's
    const w = this.way(wid), back = Edits.get('w' + wid) ? null : await this.reversedFrom(wid);
    const what = back ? `Turn ${this.label(w)} (w${wid}) back, as before changeset ${back.changeset}` : `Reverse ${this.label(w)} (w${wid})`;
    // undoing someone's edit: remember whose, on the edit itself, so after upload they can be told
    this.undoes = back ? {wid, info: {user: back.user, date: back.date, changeset: back.changeset, way: wid, name: this.label(w),
      their: this.ways[wid] && this.ways[wid].version, restored: back.version, tags: Object.entries(w.tags).filter(([k]) => ['highway', 'junction', 'oneway'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', '),
      was: this.direction(w), now: this.direction({...w, ...this.turned(w, back)}), ...(context || {})}} : null;
    await this.run(what, t => {
      const cur = t.way(wid);
      t.ways[wid] = {...cur, ...this.turned(cur, back)};
      t.touched.add(wid);
    });
    this.undoes = null;
  },
  /** A road turned round -> {nodes, tags}. Undoing someone's reversal (back: the version before it), that
      version's direction tags come back as they were; otherwise the direction tags swap, as iD does. */
  turned(cur, back) {
    let tags = {};
    if (back) {
      tags = {...cur.tags};
      for (const k of new Set([...Object.keys(cur.tags), ...Object.keys(back.tags)])) if (DIRECTIONAL.test(k)) { if (k in back.tags) tags[k] = back.tags[k]; else delete tags[k]; }
    } else {
      const swap = k => k.replace(/:(forward|backward|left|right)\b/g, (_, x) => ':' + {forward: 'backward', backward: 'forward', left: 'right', right: 'left'}[x]);
      for (const [k, v] of Object.entries(cur.tags)) {
        let nv = v;
        if (k === 'direction' || k.endsWith(':direction')) nv = {forward: 'backward', backward: 'forward'}[v] || v;
        if (k === 'incline') nv = {up: 'down', down: 'up'}[v] || (/^-?\d/.test(v) ? (v.startsWith('-') ? v.slice(1) : '-' + v) : v);
        tags[swap(k)] = nv;
      }
    }
    return {nodes: [...cur.nodes].reverse(), tags};
  },
  turnedBy: {},   // way -> the version before someone reversed it: {version, tags, user, date, changeset}
  /** Was this way, as it is now, made by reversing an earlier version? Then that's what turning it round restores. */
  async reversedFrom(wid) {
    if (wid < 0 || wid in this.turnedBy) return this.turnedBy[wid];
    this.turnedBy[wid] = null;
    try {
      const r = await fetch(`${OSM_API}/api/0.6/way/${wid}/history.json`);
      const vs = (await r.json()).elements, cur = vs[vs.length - 1];
      for (let i = vs.length - 2; i >= 0; i--) {
        if (JSON.stringify(vs[i].nodes) === JSON.stringify([...cur.nodes].reverse())) {
          const by = vs.find(v => v.version > vs[i].version && JSON.stringify(v.nodes) === JSON.stringify(cur.nodes));
          this.turnedBy[wid] = {version: vs[i].version, tags: vs[i].tags || {}, user: by.user, date: by.timestamp.slice(0, 10), changeset: by.changeset};
          break;
        }
      }
    } catch (e) { /* no history to go on: an ordinary reversal */ }
    return this.turnedBy[wid];
  },
  /** Which way a road lets traffic go, as a word: 'one-way north', 'two-way'. */
  direction(w) {
    const d = this.dir(w.tags);
    if (!d) return 'two-way';
    const t = this.tx(), a = t.node(w.nodes[0]), b = t.node(w.nodes[w.nodes.length - 1]);
    if (!a || !b) return 'one-way';
    const [p, q] = d > 0 ? [a, b] : [b, a];
    return 'one-way ' + compass([p.lon, p.lat], [q.lon, q.lat]);
  },
  segment(a, b, tags) {
    return this.run(`Add ${tags.highway || 'road'}${tags.name ? ' ' + tags.name : ''}`, t => {
      const na = this.nodeFor(t, a), nb = this.nodeFor(t, b);
      if (na === nb) throw new Error('Both ends are the same point');
      const id = Edits.newId();
      t.ways[id] = {id, nodes: [na, nb], tags, created: true};
    });
  },

  // ---------- map ----------
  init() {
    for (const id of ['roads', 'roadnodes', 'roadsel', 'roadarms', 'roadarmtips', 'roadghost', 'roadsnap']) map.addSource(id, {type: 'geojson', data: fc([])});
    const below = 'tether';   // over the route lines (they're what the edit is about), under the stops
    map.addLayer({id: 'roadsel', type: 'line', source: 'roadsel', paint: {'line-color': css('--edit'), 'line-width': 10, 'line-opacity': 0.35}}, below);
    map.addLayer({id: 'roads', type: 'line', source: 'roads', paint: {'line-color': ['case', ['get', 'path'], '#9a9a9a', ['get', 'edited'], css('--edit'), ['get', 'route'], css('--rel'), '#2b2b2b'],
      'line-width': ['case', ['get', 'path'], 1, 2.5], 'line-opacity': 0.85}}, below);
    // a selected junction: each road that meets it as a coloured arm; a road passing through is dashed
    // the end of a road at the junction, as a ribbon you can take hold of: a white edge, thicker under the pointer,
    // faded while its end is being dragged somewhere else
    map.addLayer({id: 'roadarms-edge', type: 'line', source: 'roadarms', filter: ['!', ['get', 'through']], layout: {'line-cap': 'round'},
      paint: {'line-color': '#fff', 'line-width': ['case', ['get', 'hover'], 17, 13], 'line-opacity': ['case', ['get', 'dragging'], 0, 0.95]}}, below);
    map.addLayer({id: 'roadarms', type: 'line', source: 'roadarms', filter: ['!', ['get', 'through']], layout: {'line-cap': 'round'},
      paint: {'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'hover'], 12, 8], 'line-opacity': ['case', ['get', 'dragging'], 0.25, 1]}}, below);
    map.addLayer({id: 'roadarms-thru', type: 'line', source: 'roadarms', filter: ['get', 'through'], paint: {'line-color': ['get', 'color'], 'line-width': 7, 'line-opacity': 0.9, 'line-dasharray': [1.2, 0.8]}}, below);
    // which way one-way roads go, as arrows along them: a road pointing the wrong way shows
    map.addLayer({id: 'roadarrows', type: 'symbol', source: 'roads', filter: ['!=', ['get', 'oneway'], 0], minzoom: 16,
      layout: {'symbol-placement': 'line', 'symbol-spacing': 45, 'text-field': ['case', ['>', ['get', 'oneway'], 0], '›', '‹'], 'text-size': 18, 'text-font': ['Open Sans Semibold'],
        'text-keep-upright': false, 'text-allow-overlap': true}, paint: {'text-color': ['case', ['get', 'route'], css('--rel'), '#2b2b2b'], 'text-halo-color': '#fff', 'text-halo-width': 1.5}}, below);
    map.addLayer({id: 'roadnodes', type: 'circle', source: 'roadnodes', paint: {'circle-radius': ['case', ['get', 'sel'], 8, ['get', 'junction'], 5, 3.5], 'circle-color': ['case', ['get', 'edited'], css('--edit'), '#fff'],
      'circle-stroke-color': ['case', ['get', 'sel'], '#1c1b18', '#2b2b2b'], 'circle-stroke-width': ['case', ['get', 'sel'], 3, 1.5]}}, below);
    // while dragging: the road as it would be, its end following the pointer
    map.addLayer({id: 'roadghost-edge', type: 'line', source: 'roadghost', layout: {'line-cap': 'round'}, paint: {'line-color': '#fff', 'line-width': 12}}, below);
    map.addLayer({id: 'roadghost', type: 'line', source: 'roadghost', layout: {'line-cap': 'round'}, paint: {'line-color': ['get', 'color'], 'line-width': 8}}, below);
    map.addLayer({id: 'roadarmlabels', type: 'symbol', source: 'roadarmtips', layout: {'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Open Sans Semibold'], 'text-offset': [0, 1], 'text-anchor': 'top', 'text-allow-overlap': false, 'text-optional': true},
      paint: {'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 2}}, below);
    map.addLayer({id: 'roadsnap', type: 'circle', source: 'roadsnap', paint: {'circle-radius': ['case', ['get', 'vertex'], 11, 8], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3}}, below);
    map.addLayer({id: 'roadsnaplabel', type: 'symbol', source: 'roadsnap', layout: {'text-field': ['get', 'label'], 'text-size': 12, 'text-font': ['Open Sans Semibold'], 'text-offset': [0, -1.6], 'text-anchor': 'bottom', 'text-allow-overlap': true},
      paint: {'text-color': '#1c1b18', 'text-halo-color': '#fff', 'text-halo-width': 2}}, below);

    map.on('click', e => {
      if (!this.on) return;
      if (this.dragged) { this.dragged = false; e.preventDefault(); return; }
      if (this.pick) { e.preventDefault(); return this.picked(e); }
      const f = map.queryRenderedFeatures(e.point, {layers: ['roadnodes', 'roadarms', 'roadarms-thru', 'roads']});
      const n = f.find(x => x.layer.id === 'roadnodes'), a = f.find(x => x.layer.id === 'roadarms' || x.layer.id === 'roadarms-thru'), w = f.find(x => x.layer.id === 'roads');
      if (n) { e.preventDefault(); this.selectNode(n.properties.id); }
      else if (a) { e.preventDefault(); toast(a.properties.through ? 'This road passes through: it can be split here (✂ in the card), not moved' : `Drag ${a.properties.name} off the junction to where it should join`); }
      else if (w) { e.preventDefault(); this.selectWay(w.properties.id, e.lngLat); }
      else if (this.sel) this.deselect();
    });
    map.on('mousedown', 'roadarms', e => { if (this.on && !this.pick && this.sel && this.sel.node != null) this.dragStart(e, 'attach', e.features[0].properties); });
    map.on('mousedown', 'roadnodes', e => { if (this.on && !this.pick && this.sel && this.sel.node === e.features[0].properties.id) this.dragStart(e, 'move', {}); });
    for (const l of ['roadnodes', 'roads']) {
      map.on('mouseenter', l, () => { if (this.on && !this.drag) map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { if (this.on && !this.drag) map.getCanvas().style.cursor = this.pick ? 'crosshair' : ''; });
    }
    // over a road's end: it thickens, the hand says it can be taken, the bar says what dragging it does
    map.on('mousemove', 'roadarms', e => {
      if (!this.on || this.drag) return;
      const p = e.features[0].properties;
      map.getCanvas().style.cursor = 'grab';
      if (this.hover !== p.way) { this.hover = p.way; this.drawArms(); this.status(`Drag the ${ARM_NAMES[p.color] || ''} road (${p.name}) off the junction, and drop it where it should join`); }
    });
    map.on('mouseleave', 'roadarms', () => { if (!this.on || this.drag) return; map.getCanvas().style.cursor = ''; this.hover = null; this.drawArms(); this.status(); });
    map.on('move', () => { if (this.on && this.sel && this.sel.node != null) this.drawArms(); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !this.on) return;
      if (this.drag) { this.drag.cancelled = true; this.panel().classList.remove('dragging'); this.clearGhost(); this.status(); this.drawArms(); }
      else if (this.pick) { this.pick = null; this.status(); map.getCanvas().style.cursor = ''; }
      else if (this.sel) this.deselect();
    });
    const ctl = el('div', {class: 'maplibregl-ctrl maplibregl-ctrl-group'}, el('button', {id: 'roadsbtn', class: 'roadsbtn', title: 'Edit roads here: split, reconnect, move, add; routes on them are repaired', onclick: () => this.toggle()}, 'Edit roads'));
    map.addControl({onAdd: () => ctl, onRemove: () => ctl.remove()}, 'top-right');
    // undo/redo where the editing happens: under Edit roads, saying what they'd take back
    const ur = el('div', {id: 'roadundo', class: 'maplibregl-ctrl maplibregl-ctrl-group'},
      el('button', {id: 'roadundobtn', onclick: () => undoRedo('undo')}), el('button', {id: 'roadredobtn', onclick: () => undoRedo('redo')}));
    map.addControl({onAdd: () => ur, onRemove: () => ur.remove()}, 'top-right');
    this.undoCtl();
    // like iD: once zoomed in, the roads in view load by themselves
    map.on('moveend', () => { if (this.on && !this.pick && !this.drag && !this.loading && map.getZoom() >= MIN_ZOOM - 0.01 && !this.covers()) this.reload(); else if (this.on && !this.drag) this.status(); });
  },
  covers() {
    const b = map.getBounds(), x = this.bbox;
    return x && b.getWest() >= x[0] && b.getSouth() >= x[1] && b.getEast() <= x[2] && b.getNorth() <= x[3];
  },
  async toggle() {
    if (this.on) { this.on = false; this.pick = null; this.sel = null; this.drawAll(); this.status(); $('#roadsbtn').classList.remove('on'); return; }
    this.on = true; $('#roadsbtn').classList.add('on');
    // roads load a few streets at a time: from further out, wait for the zoom in to wherever it's needed
    if (map.getZoom() < MIN_ZOOM - 0.01) return this.status();
    await this.reload();
  },
  /** Straight to a place with road editing on (from a divergence, a stop). */
  async editAt(ll) {
    map.jumpTo({center: ll, zoom: Math.max(map.getZoom(), MIN_ZOOM + 1.5)});
    if (this.on) await this.reload(); else await this.toggle();
  },
  async reload() {
    const b = map.getBounds(), pad = 0.0005;
    this.status('loading roads from OSM…'); this.loading = true;
    try { await this.load([b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad]); }
    catch (e) { this.status(); return toast(e.message, 6000); }
    finally { this.loading = false; }
    this.drawAll(); this.status();
  },
  status(msg) {
    let s = $('#roadstatus');
    if (!s) { s = el('div', {id: 'roadstatus'}); this.panel().prepend(s); }
    const text = msg || (this.pick ? this.pick.hint + ' · Esc to cancel' : !this.on ? '' : map.getZoom() < MIN_ZOOM - 0.01 ? 'Editing roads: zoom in to street level, and the roads there load.' :
      'Editing roads: click a junction or a road. Live OSM data; routes on what you change are repaired.');
    s.textContent = text; s.style.display = text ? '' : 'none';
    if (this.on) s.append(el('button', {class: 'b tiny', style: 'margin-left:8px', onclick: () => this.toggle()}, 'stop'));
    this.undoCtl();
  },
  drawAll() {
    if (!map || !map.getSource('roads')) return;
    if (!this.on) { for (const id of ['roads', 'roadnodes', 'roadsel', 'roadarms', 'roadarmtips', 'roadghost', 'roadsnap']) set(id, []); this.card(null); return; }
    const t = this.tx(), used = {}, lines = [], inRel = new Set();
    for (const r of this.relIds()) { const x = this.rel(r); if (x && this.isPT(x)) for (const mm of x.members) if (mm.type === 'way') inRel.add(mm.ref); }
    const edited = new Set(Object.values(Edits.ops).filter(o => o.type === 'way' && (o.kind === 'create' || (o.nodes && o.base && JSON.stringify(o.nodes) !== JSON.stringify(o.base.nodes)))).map(o => o.id));
    for (const id of t.wayIds()) {
      const w = t.way(id);
      if (!w || !w.nodes || !w.tags.highway || w.outside) continue;
      const path = PATHS.has(w.tags.highway);
      const coords = w.nodes.map(n => t.node(n)).filter(Boolean).map(n => [n.lon, n.lat]);
      if (coords.length > 1) lines.push(line(coords, {id, path, route: inRel.has(id), edited: edited.has(id), oneway: path ? 0 : this.dir(w.tags)}));
      if (!path) for (const n of w.nodes) used[n] = (used[n] || 0) + 1;
    }
    const pts = [];
    // dots only where something can be done: junctions and road ends (and every point of a selected road),
    // not every bend
    const ends = new Set(), selWay = this.sel && this.sel.way != null && t.way(this.sel.way);
    for (const id of t.wayIds()) { const w = t.way(id); if (w && w.nodes && w.tags.highway && !PATHS.has(w.tags.highway)) { ends.add(w.nodes[0]); ends.add(w.nodes[w.nodes.length - 1]); } }
    if (map.getZoom() >= MIN_ZOOM - 1) for (const [id, k] of Object.entries(used)) {
      if (k < 2 && !ends.has(+id) && !(selWay && selWay.nodes.includes(+id)) && !(this.sel && this.sel.node === +id)) continue;
      const n = t.node(+id); if (!n) continue;
      pts.push(point([n.lon, n.lat], {id: +id, junction: k > 1, sel: this.sel && this.sel.node === +id, edited: !!(Edits.get('n' + id) || Edits.get('new:n' + id))}));
    }
    set('roads', lines); set('roadnodes', pts);
    const sw = this.sel && this.sel.way != null && t.way(this.sel.way);
    set('roadsel', sw ? [line(sw.nodes.map(n => t.node(n)).filter(Boolean).map(n => [n.lon, n.lat]))] : []);
    this.drawArms();
  },
  /** A click -> the nearest road vertex (8 px) or road segment (12 px). */
  snap(ll, skipWay) {
    const p = map.project(ll), t = this.tx();
    let best = null;
    for (const id of t.wayIds()) {
      const w = t.way(id);
      if (!w || !w.nodes || !w.tags.highway || PATHS.has(w.tags.highway) || w.outside || id === skipWay) continue;
      const px = w.nodes.map(n => t.node(n)).map(n => n && map.project([n.lon, n.lat]));
      for (let i = 0; i < px.length; i++) {
        if (!px[i]) continue;
        const d = Math.hypot(px[i].x - p.x, px[i].y - p.y);
        if (d <= 8 && (!best || best.node == null || d < best.d)) best = {d, node: w.nodes[i]};
        if (i && px[i - 1] && (!best || best.node == null)) {
          const a = px[i - 1], b = px[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
          const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)), q = {x: a.x + u * dx, y: a.y + u * dy};
          const e = Math.hypot(q.x - p.x, q.y - p.y);
          if (e <= 12 && (!best || e < best.d)) { const g = map.unproject(q); best = {d: e, way: id, index: i - 1, point: [g.lng, g.lat]}; }
        }
      }
    }
    return best;
  },
  startPick(pick) { this.pick = pick; map.getCanvas().style.cursor = 'crosshair'; this.status(); document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove()); },
  picked(e) {
    const p = this.pick, ll = [e.lngLat.lng, e.lngLat.lat];
    if (p.kind === 'move') return this.move(p.node, ll);
    const s = this.snap(e.lngLat, p.kind === 'attach' ? p.way : null);
    if (p.kind === 'attach') return s ? this.attach(p.way, p.node, s) : toast('Click on a road or a junction');
    if (p.kind === 'segment') return this.segmentForm(p.from, s || {free: ll}, e.lngLat);
  },

  // ---------- a selected junction: the roads' ends, and dragging them ----------
  /** The roads meeting at a node, as arms a fixed number of pixels long: one per direction a road leaves in.
      An arm is the end of a road: drag it to move where that road joins. A road passing through is dashed. */
  arms(nid) {
    const t = this.tx(), c = t.node(nid);
    if (!c) return [];
    const out = [];
    let k = 0;
    for (const wid of t.waysAt(nid)) {
      const w = t.way(wid);
      if (!w.tags.highway || PATHS.has(w.tags.highway)) continue;
      const i = w.nodes.indexOf(nid), closed = w.nodes[0] === w.nodes[w.nodes.length - 1];
      const end = !closed && (i === 0 || i === w.nodes.length - 1);
      const color = ARM_COLORS[k++ % ARM_COLORS.length];
      const dirs = closed ? [1, -1] : [i < w.nodes.length - 1 ? 1 : null, i > 0 ? -1 : null].filter(Boolean);
      dirs.forEach((d, n) => {
        const pts = [[c.lon, c.lat]];
        for (let j = i + d, hops = 0; hops < w.nodes.length; j += d, hops++) {
          if (closed) j = (j + w.nodes.length - 1) % (w.nodes.length - 1);
          else if (j < 0 || j >= w.nodes.length) break;
          const q = t.node(w.nodes[j]); if (!q) break;
          pts.push([q.lon, q.lat]);
          if (this.pxLen(pts) >= ARM_PX) break;
        }
        const coords = this.cutPx(pts, ARM_PX);
        out.push({way: wid, color, end, through: !end, coords, first: n === 0, anchor: w.nodes[i + d] ?? null});
      });
    }
    return out;
  },
  pxLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) { const a = map.project(pts[i - 1]), b = map.project(pts[i]); L += Math.hypot(b.x - a.x, b.y - a.y); } return L; },
  /** The first `px` screen pixels of a line. */
  cutPx(pts, px) {
    const out = [pts[0]];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = map.project(pts[i - 1]), b = map.project(pts[i]), L = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + L >= px) { const u = (px - acc) / (L || 1), g = map.unproject({x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u}); out.push([g.lng, g.lat]); return out; }
      out.push(pts[i]); acc += L;
    }
    return out;
  },
  drawArms() {
    if (!map || !map.getSource('roadarms')) return;
    const nid = this.sel && this.sel.node;
    if (nid == null || !this.on) { set('roadarms', []); set('roadarmtips', []); return; }
    const t = this.tx(), arms = this.arms(nid), dragging = this.drag && this.drag.moved && this.drag.kind === 'attach' ? this.drag.way : null;
    set('roadarms', arms.map(a => line(a.coords, {way: a.way, color: a.color, through: a.through, end: a.end, anchor: a.anchor, name: this.label(t.way(a.way)),
      hover: this.hover === a.way && !a.through, dragging: dragging === a.way})));
    set('roadarmtips', arms.filter(a => a.first).map(a => {
      const pt = this.relsOf(a.way).filter(r => this.isPT(r)).length;
      return point(a.coords[a.coords.length - 1], {color: a.color, label: `${this.label(t.way(a.way))}${pt ? ` · ${pt} route${pt > 1 ? 's' : ''}` : ''}`});
    }));
  },
  clearGhost() { set('roadghost', []); set('roadsnap', []); },

  dragStart(e, kind, info) {
    e.preventDefault();   // no map pan while dragging
    const nid = this.sel.node, t = this.tx();
    this.drag = {kind, way: info.way, color: info.color || css('--edit'), anchor: info.anchor, start: e.point, moved: false};
    this.hover = null;
    const who = info.color ? `the ${ARM_NAMES[info.color] || ''} road (${this.label(t.way(info.way))})` : '';
    map.getCanvas().style.cursor = 'grabbing';
    const move = ev => {
      const d = this.drag;
      if (!d || d.cancelled) return;
      if (!d.moved && Math.hypot(ev.point.x - d.start.x, ev.point.y - d.start.y) < 4) return;
      if (!d.moved) { d.moved = true; this.drawArms(); this.panel().classList.add('dragging'); }
      if (d.kind === 'attach') {
        let s = this.snap(ev.lngLat, d.way);
        if (s && s.node === nid) s = null;   // back on its own junction: nothing to do
        d.snap = s;
        const at = s ? (s.node != null ? this.ll(t, s.node) : s.point) : [ev.lngLat.lng, ev.lngLat.lat];
        const from = d.anchor != null ? this.ll(t, d.anchor) : this.ll(t, nid);
        set('roadghost', [line([from, at], {color: d.color})]);
        const onto = s ? (s.node != null ? 'joins this junction' : `joins ${this.label(t.way(s.way))} here`) : '';
        set('roadsnap', [point(at, {color: d.color, vertex: !!s, label: s ? onto : ''})]);
        this.status(s ? `Let go: ${who} ${onto} · Esc to cancel` : `Drop the end of ${who} on another road · Esc to cancel`);
      } else {
        const at = [ev.lngLat.lng, ev.lngLat.lat];
        const nbrs = t.waysAt(nid).flatMap(w => { const n = t.way(w).nodes, i = n.indexOf(nid); return [n[i - 1], n[i + 1]].filter(x => x != null); });
        set('roadghost', nbrs.map(n => line([this.ll(t, n), at], {color: css('--edit')})));
        set('roadsnap', [point(at, {color: css('--edit'), vertex: true, label: ''})]);
        this.status('Release to move the junction here · Esc to cancel');
      }
    };
    const up = ev => {
      map.off('mousemove', move);
      const d = this.drag; this.drag = null;
      map.getCanvas().style.cursor = '';
      this.panel().classList.remove('dragging');
      this.clearGhost(); this.drawArms();
      if (!d || d.cancelled || !d.moved) { this.status(); return; }
      this.dragged = true;   // the click that follows this mouseup is not a selection
      setTimeout(() => { this.dragged = false; }, 0);
      if (d.kind === 'attach') {
        if (d.snap) this.attach(d.way, nid, d.snap);
        else { toast('Drop it on a road or a junction'); this.status(); }
      } else this.move(nid, [ev.lngLat.lng, ev.lngLat.lat]);
    };
    map.on('mousemove', move);
    map.once('mouseup', up);
  },

  // ---------- the card: what's selected, in words, with the colours of the map ----------
  card(content) {
    let c = $('#roadcard');
    if (!c) { c = el('div', {id: 'roadcard', class: 'small'}); this.panel().append(c); }
    c.innerHTML = ''; c.style.display = content ? '' : 'none';
    if (content) c.append(el('button', {class: 'b tiny close', title: 'Esc', onclick: () => this.deselect()}, '×'), content);
  },
  /** The map's undo/redo: shown while editing roads, or whenever there's something to take back. */
  undoCtl() {
    const box = $('#roadundo'), u = $('#roadundobtn'), r = $('#roadredobtn');
    if (!box) return;
    const last = Edits.history[Edits.history.length - 1], next = Edits.future[Edits.future.length - 1];
    box.style.display = this.on || last || next ? '' : 'none';
    const cut = t => t && t.length > 34 ? t.slice(0, 33) + '…' : t;
    u.disabled = !last; r.disabled = !next;
    u.innerHTML = ''; r.innerHTML = '';
    u.append(el('span', {class: 'ico'}, '↶'), el('span', {}, last ? `Undo${last.label ? ': ' + cut(last.label) : ''}` : 'Nothing to undo'));
    r.append(el('span', {class: 'ico'}, '↷'), el('span', {}, 'Redo'));
    u.title = last ? `Undo${last.label ? ': ' + last.label : ''} (⌘Z / Ctrl+Z)` : 'Nothing to undo';
    r.title = next ? `Redo${next.label ? ': ' + next.label : ''} (⇧⌘Z / Ctrl+Y)` : 'Nothing to redo';
  },
  /** Top left of the map: the status line, and under it the card. */
  panel() { let p = $('#roadpanel'); if (!p) { p = el('div', {id: 'roadpanel'}); $('#map').append(p); } return p; },
  deselect() { this.sel = null; this.card(null); this.drawAll(); },
  relsOf(wid) { return this.relIds().map(r => this.rel(r)).filter(r => r && r.members.some(x => x.type === 'way' && x.ref === wid)); },
  routeCount(wid) {
    const rs = this.relsOf(wid), pt = rs.filter(r => this.isPT(r)).length;
    return [pt ? `${pt} route${pt > 1 ? 's' : ''}` : null, rs.length - pt ? `${rs.length - pt} other` : null].filter(Boolean).join(', ');
  },
  selectNode(nid) {
    const t = this.tx();
    this.sel = {node: nid}; this.drawAll();
    const arms = this.arms(nid), seen = new Set(), rows = el('div', {class: 'roadkey'});
    for (const a of arms) {
      if (seen.has(a.way)) continue;
      seen.add(a.way);
      const w = t.way(a.way);
      rows.append(el('div', {class: 'roadkeyrow'},
        el('i', {class: 'sw' + (a.through ? ' thru' : ''), style: `--c:${a.color}`}),
        el('span', {class: 'grow'}, el('b', {}, this.label(w)), el('span', {class: 'muted'}, ` ${a.through ? 'passes through' : 'ends here'}${w.tags.oneway ? ' · one-way' : ''}${this.routeCount(a.way) ? ' · ' + this.routeCount(a.way) : ''}`)),
        a.through && w.nodes[0] !== w.nodes[w.nodes.length - 1] ? el('button', {class: 'b tiny', title: `Split w${a.way} here`, onclick: () => this.splitAt(a.way, nid)}, '✂ split') : null));
    }
    const ends = arms.filter(a => a.end).length;
    const n = t.node(nid);
    this.card(el('div', {},
      el('div', {}, el('b', {}, seen.size > 1 ? `Junction · ${seen.size} roads` : 'Point on a road'), ' ',
        nid > 0 ? el('a', {href: `https://www.openstreetmap.org/node/${nid}`, target: '_blank', class: 'muted'}, `n${nid}`) : el('span', {class: 'muted'}, '(new)'),
        n && Object.keys(n.tags || {}).length ? el('span', {class: 'muted'}, ' · ' + Object.entries(n.tags).map(([k, v]) => `${k}=${v}`).join(' ')) : null),
      rows,
      el('div', {class: 'roadhint'}, ends ? 'Each coloured stub is the end of that road. Drag one off the junction and drop it on another road to make it join there instead. ' : '', 'Drag the white dot to move the junction itself.'),
      el('div', {class: 'btns'}, el('button', {class: 'b tiny', onclick: () => this.startPick({kind: 'segment', from: {node: nid}, hint: 'Click where the new road ends (on a road, or anywhere)'})}, '+ road from here'))));
    this.clearOfCard([n.lon, n.lat]);
  },
  /** If a place (and the arms around it) sits under the card, slide the map so it doesn't. */
  clearOfCard(ll) {
    const c = $('#roadcard'), m = map.getContainer().getBoundingClientRect();
    if (!c || c.style.display === 'none') return;
    const r = c.getBoundingClientRect(), p = map.project(ll), pad = ARM_PX + 20;
    const right = r.right - m.left, bottom = r.bottom - m.top;
    if (p.x - pad > right || p.y - pad > bottom) return;
    // to the middle of the free space right of the card
    const want = {x: right + (m.width - right) / 2, y: Math.max(p.y, bottom / 2 + m.height / 4)};
    map.panBy([p.x - want.x, p.y - want.y], {duration: 300});
  },
  selectWay(wid, ll) {
    const w = this.way(wid), s = this.snap(ll);
    // if someone turned this road round, say so on the button, and turning it back restores what it was
    if (this.dir(w.tags) && !Edits.get('w' + wid)) this.reversedFrom(wid).then(b => {
      const btn = $('#reversebtn');
      if (b && btn && this.sel && this.sel.way === wid) {
        btn.textContent = `⇄ turn it back to ${this.direction({...w, nodes: [...w.nodes].reverse()})}, as before ${b.user}'s edit (${b.date})`;
        btn.title = `Version ${b.version} ran the other way; changeset ${b.changeset} reversed it. Turning it back restores version ${b.version}'s direction and side tags.`;
      }
    });
    this.sel = {way: wid}; this.drawAll();
    const rc = this.routeCount(wid);
    this.card(el('div', {},
      el('div', {}, el('b', {}, this.label(w)), ' ', wid > 0 ? el('a', {href: `https://www.openstreetmap.org/way/${wid}`, target: '_blank', class: 'muted'}, `w${wid}`) : el('span', {class: 'muted'}, '(new)'),
        el('span', {class: 'muted'}, ' · ' + this.direction(w)), rc ? el('span', {class: 'muted'}, ' · ' + rc) : null),
      el('div', {class: 'muted mono', style: 'margin:4px 0'}, Object.entries(w.tags).map(([k, v]) => `${k}=${v}`).join('  ')),
      el('div', {class: 'roadhint'}, 'Click one of its white points to reconnect or move it.'),
      el('div', {class: 'btns'},
        s && s.way === wid && w.nodes[0] !== w.nodes[w.nodes.length - 1] ? el('button', {class: 'b tiny', title: 'where you clicked', onclick: () => this.splitHere(s)}, '✂ split where I clicked') : null,
        s && s.way === wid ? el('button', {class: 'b tiny', onclick: () => this.startPick({kind: 'segment', from: s, hint: 'Click where the new road ends'})}, '+ road from here') : null,
        this.dir(w.tags) ? el('button', {class: 'b tiny', id: 'reversebtn', title: 'Turn it round: traffic goes the other way. Routes on it are checked.', onclick: () => this.reverse(wid)}, `⇄ make it ${this.direction({...w, nodes: [...w.nodes].reverse()})}`) : null,
        wid > 0 ? el('button', {class: 'b tiny', onclick: () => wayTagEditor(wid, w.tags, [ll.lng, ll.lat], {version: this.ways[wid].version, tags: this.ways[wid].tags, nodes: this.ways[wid].nodes})}, 'edit tags') : null)));
  },
  segmentForm(from, to, ll) {
    const t = this.tx();
    const near = [...new Set([from, to].flatMap(s => s.node != null ? t.waysAt(s.node) : s.way != null ? [s.way] : []))].map(w => t.way(w)).filter(w => w && w.tags.highway && !PATHS.has(w.tags.highway));
    const hw = el('select', {class: 'b'}, ...['service', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'busway'].map(v => el('option', {value: v}, v)));
    const svc = el('select', {class: 'b'}, el('option', {value: ''}, '(no service=*)'), ...['driveway', 'parking_aisle', 'alley', 'bus'].map(v => el('option', {value: v}, v)));
    const name = el('input', {placeholder: 'name (optional)'}), oneway = el('select', {class: 'b'}, el('option', {value: ''}, 'two-way'), el('option', {value: 'yes'}, 'oneway, as drawn'), el('option', {value: '-1'}, 'oneway, against'));
    const copy = el('select', {class: 'b'}, el('option', {value: ''}, 'or copy tags from…'), ...near.map(w => el('option', {value: w.id}, `${this.label(w)} w${w.id}`)));
    const box = el('div', {class: 'small'}, el('b', {}, 'New road'), el('div', {class: 'muted'}, 'A straight segment; add bends in JOSM or RapiD afterwards if it needs them.'),
      el('div', {class: 'btns'}, hw, svc, oneway), el('div', {class: 'btns'}, name, copy),
      el('div', {class: 'btns'}, el('button', {class: 'b primary tiny', onclick: () => {
        const tags = copy.value ? {...t.way(+copy.value).tags} : Object.fromEntries([['highway', hw.value], ['service', svc.value], ['name', name.value.trim()], ['oneway', oneway.value]].filter(([, v]) => v));
        pop.remove();
        this.segment(from, to, tags);
      }}, 'Add to changes')));
    const pop = new maplibregl.Popup({closeButton: true, maxWidth: '400px'}).setLngLat(ll).setDOMContent(box).addTo(map);
    this.pick = null; map.getCanvas().style.cursor = ''; this.status();
  },
};
