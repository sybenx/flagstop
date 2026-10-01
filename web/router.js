/* router.js — where a bus can drive on OSM's roads, and how that compares with the agency's line: the browser's
   copy of tool/routes.py (with compare.chain_breaks and review.stop_positions / route_pattern), so a route can be
   routed without the Python server. Kept in step with the Python by tests/test_router.js, which routes every
   itinerary both ways and wants the same answer.

   Line for line on purpose: the same constants, the same order of looking, the same tie-breaks (Python's int()
   truncates, its round() rounds half to even, its heap compares whole tuples). */
'use strict';

const Router = (() => {
  const PREFER = {motorway: 1.0, trunk: 1.0, primary: 1.0, secondary: 1.0, tertiary: 1.05, unclassified: 1.15,
    residential: 1.2, living_street: 1.6, busway: 0.9, road: 1.3, service: 1.8,
    motorway_link: 1.0, trunk_link: 1.0, primary_link: 1.0, secondary_link: 1.0, tertiary_link: 1.05};
  const SERVICE_PENALTY = {driveway: 3.0, parking_aisle: 2.2, alley: 2.5, emergency_access: 6.0};
  const STRAY = 20, STRAY_COST = 0.2, SKIP_SLACK = 25, SKIP_COST = 3.0, SNAP = 60;
  const SNAP_HANDICAP = {parking_aisle: 15, driveway: 15, 'drive-through': 15};
  const SNAP_CROSS = 12, DIVERGE = 30;
  const trunc = Math.trunc, RAD = Math.PI / 180;
  const get = (o, k, d) => (o && Object.prototype.hasOwnProperty.call(o, k)) ? o[k] : d;
  // Python's round(x, n): half to even
  const pyround = (x, n = 0) => {
    const f = 10 ** n, v = x * f, r = Math.round(v);
    return (Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r) / f;
  };

  const metres = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * RAD), (b[1] - a[1]) * 110540);

  function project(p, a, b) {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const kx = 111320 * Math.cos(ay * RAD), ky = 110540;
    const dx = (bx - ax) * kx, dy = (by - ay) * ky;
    if (dx === 0 && dy === 0) return [a, metres(p, a), 0.0];
    const t = Math.max(0.0, Math.min(1.0, ((px - ax) * kx * dx + (py - ay) * ky * dy) / (dx * dx + dy * dy)));
    const q = [ax + (bx - ax) * t, ay + (by - ay) * t];
    return [q, metres(p, q), t];
  }

  class Polyline {
    constructor(pts, cell = 0.003) {
      this.pts = pts; this.cell = cell; this.grid = new Map(); this.cum = [0.0];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        this.cum.push(this.cum[this.cum.length - 1] + metres(a, b));
        for (let ci = trunc(Math.min(a[1], b[1]) / cell) - 1; ci < trunc(Math.max(a[1], b[1]) / cell) + 2; ci++)
          for (let cj = trunc(Math.min(a[0], b[0]) / cell) - 1; cj < trunc(Math.max(a[0], b[0]) / cell) + 2; cj++) {
            const k = ci + ',' + cj; if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(i);
          }
      }
      this.length = this.cum[this.cum.length - 1];
    }
    nearest(p, lo = null, hi = null) {
      let best = [Infinity, -1, 0.0];
      for (const i of this.grid.get(trunc(p[1] / this.cell) + ',' + trunc(p[0] / this.cell)) || []) {
        if (lo !== null && (i < lo || i > hi)) continue;
        const [, d, t] = project(p, this.pts[i], this.pts[i + 1]);
        if (d < best[0]) best = [d, i, this.cum[i] + t * (this.cum[i + 1] - this.cum[i])];
      }
      if (best[1] < 0) {
        const from = lo !== null ? lo : 0, to = lo !== null ? hi : this.pts.length - 2;
        for (let i = from; i <= to; i++) {
          const [, d, t] = project(p, this.pts[i], this.pts[i + 1]);
          if (d < best[0]) best = [d, i, this.cum[i] + t * (this.cum[i + 1] - this.cum[i])];
        }
      }
      return best;
    }
    positions(p, r, lo = null, hi = null) {
      const hits = [];
      for (const i of this.grid.get(trunc(p[1] / this.cell) + ',' + trunc(p[0] / this.cell)) || []) {
        if (lo !== null && (i < lo || i > hi)) continue;
        const [, d, t] = project(p, this.pts[i], this.pts[i + 1]);
        if (d <= r) hits.push([i, d, this.cum[i] + t * (this.cum[i + 1] - this.cum[i])]);
      }
      hits.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
      const out = []; let last = null;
      for (const [i, d, m] of hits) {
        if (last !== null && i === last[0] + 1) {
          if (d < last[1]) out[out.length - 1] = m;
          last = [i, Math.min(d, last[1])];
        } else { out.push(m); last = [i, d]; }
      }
      return out;
    }
    slice(m0, m1) {
      const out = [];
      for (let i = 0; i < this.pts.length - 1; i++) {
        if (this.cum[i + 1] < m0 || this.cum[i] > m1) continue;
        const a = this.pts[i], b = this.pts[i + 1], L = (this.cum[i + 1] - this.cum[i]) || 1;
        const t0 = Math.max(0.0, (m0 - this.cum[i]) / L), t1 = Math.min(1.0, (m1 - this.cum[i]) / L);
        if (!out.length) out.push([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
        out.push([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]);
      }
      return out;
    }
  }

  function busMay(tags) {
    const hw = tags.highway;
    if (!(hw in PREFER)) return null;
    if (!['bus', 'psv'].some(k => ['yes', 'designated', 'official'].includes(tags[k]))) {
      if (['no', 'private'].includes(tags.access) || ['no', 'private'].includes(tags.motor_vehicle) || ['no', 'private'].includes(tags.vehicle)) {
        if (!['bus', 'psv', 'motor_vehicle'].some(k => ['yes', 'designated', 'permissive'].includes(tags[k]))) return null;
      }
      if (tags.bus === 'no' || tags.psv === 'no') return null;
    }
    let ow = tags['oneway:bus'] || tags['oneway:psv'] || tags.oneway;
    if (ow === undefined && ['roundabout', 'circular'].includes(tags.junction)) ow = 'yes';
    if (['yes', 'true', '1'].includes(ow)) return [true, false];
    if (ow === '-1') return [false, true];
    return [true, true];
  }

  function restrictions(raw) {
    const no = new Set(), only = new Map();
    for (const el of raw.elements || []) {
      const t = el.tags || {};
      if (el.type !== 'relation' || t.type !== 'restriction') continue;
      if ((t.except || '').split(';').map(x => x.trim()).some(x => x === 'bus' || x === 'psv')) continue;
      const kind = t['restriction:bus'] || t['restriction:psv'] || t.restriction || '';
      const ms = el.members || [];
      const frm = ms.filter(m => m.role === 'from' && m.type === 'way').map(m => m.ref);
      const via = ms.filter(m => m.role === 'via');
      const to = ms.filter(m => m.role === 'to' && m.type === 'way').map(m => m.ref);
      if (frm.length !== 1 || via.length !== 1 || via[0].type !== 'node' || !to.length) continue;
      if (kind.startsWith('no_')) for (const w of to) no.add(`${frm[0]},${via[0].ref},${w}`);
      else if (kind.startsWith('only_')) {
        const k = `${frm[0]},${via[0].ref}`; if (!only.has(k)) only.set(k, new Set());
        for (const w of to) only.get(k).add(w);
      }
    }
    return [no, only];
  }

  function whyBlocked(t) {
    const hw = t.highway || '?';
    if (!(hw in PREFER)) return `highway=${hw}`;
    for (const k of ['access', 'motor_vehicle', 'vehicle', 'bus', 'psv']) if (['no', 'private'].includes(t[k])) return `${k}=${t[k]}`;
    return 'not drivable';
  }

  class Graph {
    constructor(raw) {
      if (!raw) return;
      this.coord = new Map(); this.ways = new Map();
      for (const el of raw.elements || []) {
        if (el.type === 'node') this.coord.set(el.id, [el.lon, el.lat]);
        else if (el.type === 'way') this.ways.set(el.id, el);
      }
      this.adj = new Map();
      [this.noTurn, this.onlyTurn] = restrictions(raw);
      this.blocked = new Map(); this.cell = 0.002; this.sgrid = new Map();
      for (const [wid, w] of this.ways) this._add(wid, w);
    }
    _add(wid, w) {
      const t = w.tags || {}, may = busMay(t);
      if (may === null) { this.blocked.set(wid, whyBlocked(t)); return; }
      const f = PREFER[t.highway] * get(SERVICE_PENALTY, t.service || '', 1.0);
      const nodes = w.nodes.filter(n => this.coord.has(n));
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i], b = nodes[i + 1], L = metres(this.coord.get(a), this.coord.get(b));
        if (may[0]) { if (!this.adj.has(a)) this.adj.set(a, []); this.adj.get(a).push([b, wid, f, L]); }
        if (may[1]) { if (!this.adj.has(b)) this.adj.set(b, []); this.adj.get(b).push([a, wid, f, L]); }
        for (const cell of this._cells(a, b)) { if (!this.sgrid.has(cell)) this.sgrid.set(cell, []); this.sgrid.get(cell).push([wid, i, a, b]); }
      }
    }
    _cells(a, b) {
      const A = this.coord.get(a), B = this.coord.get(b), c = this.cell, out = [];
      for (let ci = trunc(Math.min(A[1], B[1]) / c); ci < trunc(Math.max(A[1], B[1]) / c) + 1; ci++)
        for (let cj = trunc(Math.min(A[0], B[0]) / c); cj < trunc(Math.max(A[0], B[0]) / c) + 1; cj++) out.push(ci + ',' + cj);
      return out;
    }
    /** A copy with some ways replaced or added and some nodes placed (edits not yet uploaded). */
    patched(ways = {}, nodes = {}) {
      const g = new Graph(null);
      g.cell = this.cell; g.noTurn = this.noTurn; g.onlyTurn = this.onlyTurn;
      g.coord = new Map(this.coord);
      for (const [id, ll] of Object.entries(nodes)) g.coord.set(+id, ll);
      g.ways = new Map(this.ways); g.blocked = new Map(this.blocked);
      const wids = new Set(Object.keys(ways).map(Number)), touched = new Set();
      for (const wid of wids) { const old = this.ways.get(wid); if (old) for (const n of old.nodes) touched.add(n); }
      g.adj = new Map();
      for (const [n, es] of this.adj) g.adj.set(n, touched.has(n) ? es.filter(e => !wids.has(e[1])) : es);
      g.sgrid = new Map(this.sgrid);
      for (const wid of wids) {
        const old = this.ways.get(wid);
        if (old) {
          const ns = old.nodes.filter(n => this.coord.has(n));
          for (let i = 0; i < ns.length - 1; i++) for (const cell of this._cells(ns[i], ns[i + 1])) if (g.sgrid.has(cell)) g.sgrid.set(cell, g.sgrid.get(cell).filter(s => s[0] !== wid));
        }
        g.blocked.delete(wid);
      }
      for (const [k, w] of Object.entries(ways)) {
        const wid = +k;
        g.ways.set(wid, {id: wid, nodes: w.nodes, tags: w.tags || {}});
        for (const n of w.nodes) if (g.adj.has(n) && g.adj.get(n) === this.adj.get(n)) g.adj.set(n, [...g.adj.get(n)]);
        const ns = w.nodes.filter(n => g.coord.has(n));
        for (let i = 0; i < ns.length - 1; i++) for (const cell of g._cells(ns[i], ns[i + 1])) if (g.sgrid.has(cell) && g.sgrid.get(cell) === this.sgrid.get(cell)) g.sgrid.set(cell, [...g.sgrid.get(cell)]);
        g._add(wid, g.ways.get(wid));
      }
      return g;
    }
    snap(p, r = SNAP, along = null) {
      const kx = 111320 * Math.cos(p[1] * RAD);
      let ux = null, uy = null;
      if (along) {
        ux = (along[1][0] - along[0][0]) * kx; uy = (along[1][1] - along[0][1]) * 110540;
        const n = Math.hypot(ux, uy);
        if (n > 5) { ux /= n; uy /= n; } else { ux = uy = null; }
      }
      const ci = trunc(p[1] / this.cell), cj = trunc(p[0] / this.cell);
      let best = null;
      for (const i of [ci - 1, ci, ci + 1]) for (const j of [cj - 1, cj, cj + 1]) {
        for (const [wid, , a, b] of this.sgrid.get(i + ',' + j) || []) {
          const [, d, t] = project(p, this.coord.get(a), this.coord.get(b));
          if (d > r) continue;
          let e = d + get(SNAP_HANDICAP, (this.ways.get(wid).tags || {}).service || '', 0);
          if (ux !== null) {
            const [ax, ay] = this.coord.get(a), [bx, by] = this.coord.get(b);
            const sx = (bx - ax) * kx, sy = (by - ay) * 110540, L = Math.hypot(sx, sy);
            if (L) e += SNAP_CROSS * Math.abs(ux * sy - uy * sx) / L;
          }
          if (best === null || e < best[0]) best = [e, wid, a, b, t, d];
        }
      }
      return best && [best[5], best[1], best[2], best[3], best[4]];
    }
    nearbyWays(p, r) {
      const out = new Map(), ci = trunc(p[1] / this.cell), cj = trunc(p[0] / this.cell);
      for (const i of [ci - 1, ci, ci + 1]) for (const j of [cj - 1, cj, cj + 1])
        for (const [wid, , a, b] of this.sgrid.get(i + ',' + j) || []) {
          const [, d] = project(p, this.coord.get(a), this.coord.get(b));
          if (d <= r && d < (out.has(wid) ? out.get(wid) : r + 1)) out.set(wid, d);
        }
      return out;
    }
    blockedNear(p, r) {
      const out = new Map();
      for (const [wid, why] of this.blocked) {
        const nodes = this.ways.get(wid).nodes.filter(n => this.coord.has(n));
        for (let i = 0; i < nodes.length - 1; i++) {
          const a = this.coord.get(nodes[i]), b = this.coord.get(nodes[i + 1]);
          if (Math.abs(a[1] - p[1]) > 0.003 && Math.abs(b[1] - p[1]) > 0.003) continue;
          const [, d] = project(p, a, b);
          if (d <= r) { out.set(wid, [d, why]); break; }
        }
      }
      return out;
    }
    astar(starts, goals, guide = null, lo = null, hi = null, {limit = 250000, startAt = null, endAt = null, noFirst = null, noLast = null} = {}) {
      const goalPts = [...goals.keys()].map(g => this.coord.get(g));
      const h = n => { const p = this.coord.get(n); let m = Infinity; for (const q of goalPts) m = Math.min(m, metres(p, q)); return m * 0.9; };
      const stray = new Map();
      const strayCost = n => {
        if (guide === null) return 0.0;
        if (!stray.has(n)) stray.set(n, Math.max(0.0, guide.nearest(this.coord.get(n), lo, hi)[0] - STRAY) * STRAY_COST);
        return stray.get(n);
      };
      const passes = new Map();
      const progress = (q0, m, L) => {
        if (q0 === null) return [null, 0.0];
        if (!passes.has(m)) passes.set(m, guide.positions(this.coord.get(m), STRAY + 10, lo, hi));
        const ps = passes.get(m);
        if (!ps.length) return [q0 + L, 0.0];
        const want = q0 + L;
        let q = ps[0];
        for (const x of ps) if (Math.abs(x - want) < Math.abs(q - want)) q = x;
        const ahead = q - q0;
        return [q, (Math.max(0.0, ahead - L * 1.5 - SKIP_SLACK) + Math.max(0.0, -ahead - SKIP_SLACK)) * SKIP_COST];
      };
      const BAND = 40, band = q => q === null ? null : Math.floor(q / BAND);
      const key = st => st[0] + '|' + st[1];
      const dist = new Map(), prev = new Map(), pw = new Map(), at = new Map();
      // the heap orders as Python's tuples do: f, then c, then the state (node, band), then arrived
      const heap = [];
      const less = (x, y) => {
        if (x[0] !== y[0]) return x[0] < y[0];
        if (x[1] !== y[1]) return x[1] < y[1];
        if (x[2][0] !== y[2][0]) return x[2][0] < y[2][0];
        const bx = x[2][1], by = y[2][1];
        if (bx !== by) return bx === null ? true : by === null ? false : bx < by;
        return !x[3] && y[3];
      };
      const push = e => { heap.push(e); let i = heap.length - 1; while (i > 0) { const pi = (i - 1) >> 1; if (!less(heap[i], heap[pi])) break; [heap[i], heap[pi]] = [heap[pi], heap[i]]; i = pi; } };
      const pop = () => {
        const top = heap[0], last = heap.pop();
        if (heap.length) {
          heap[0] = last; let i = 0;
          for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; }
        }
        return top;
      };
      for (const [s, c] of starts) {
        const q = guide !== null ? startAt : null, st = [s, band(q)];
        dist.set(key(st), c); at.set(key(st), q);
        push([c + h(s), c, st, false]);
      }
      let seen = 0;
      while (heap.length) {
        const [, c, st0, arrived] = pop();
        let st = st0;
        if (arrived) {
          const path = [st[0]], ways = [];
          while (prev.has(key(st))) { ways.push(pw.get(key(st))); st = prev.get(key(st)); path.push(st[0]); }
          return [c, path.reverse(), ways.reverse()];
        }
        const sk = key(st);
        if (c > (dist.has(sk) ? dist.get(sk) : Infinity)) continue;
        const n = st[0];
        if (goals.has(n) && !(noLast && prev.has(sk) && prev.get(sk)[0] === noLast.get(n))) {
          const short = endAt !== null && at.get(sk) !== null ? Math.max(0.0, endAt - at.get(sk) - SKIP_SLACK) * SKIP_COST : 0.0;
          push([c + goals.get(n) + short, c + goals.get(n) + short, st, true]);
        }
        seen += 1;
        if (seen > limit) return null;
        const back = prev.has(sk) ? prev.get(sk)[0] : (noFirst ? noFirst.get(n) : undefined);
        const came = pw.has(sk) ? pw.get(sk) : null;
        const only = came !== null ? this.onlyTurn.get(`${came},${n}`) : undefined;
        for (const [m, wid, fac, L] of this.adj.get(n) || []) {
          if (m === back) continue;
          if (came !== null && (this.noTurn.has(`${came},${n},${wid}`) || (only && !only.has(wid)))) continue;
          const [q, jump] = progress(at.get(sk), m, L);
          const nc = c + L * (fac + strayCost(m)) + jump;
          const mt = [m, band(q)], mk = key(mt);
          if (nc < (dist.has(mk) ? dist.get(mk) : Infinity)) {
            dist.set(mk, nc); prev.set(mk, st); pw.set(mk, wid); at.set(mk, q);
            push([nc + h(m), nc, mt, false]);
          }
        }
      }
      return null;
    }
  }

  function trace(g, stops, shape) {
    const guide = shape && shape.length > 1 ? new Polyline(shape) : null;
    const at = [];
    if (guide) {
      let prevSeg = 0;
      stops.forEach((p, k) => {
        let [d, i, m] = guide.nearest(p);
        if (k && i < prevSeg) {
          const [d2, i2, m2] = guide.nearest(p, prevSeg, guide.pts.length - 2);
          if (d2 <= d + 30) { i = i2; m = m2; }
        }
        at.push([i, m]); prevSeg = Math.max(prevSeg, i);
      });
    }
    const along = k => { const sl = guide ? guide.slice(at[k][1] - 15, at[k][1] + 15) : []; return sl.length > 1 ? [sl[0], sl[sl.length - 1]] : null; };
    const snaps = stops.map((p, k) => g.snap(p, SNAP, along(k)));
    const legs = [], allWays = [], geom = [];
    let divs = [], prevEnd = null;
    const adjHas = (n, m, w) => (g.adj.get(n) || []).some(e => e[0] === m && e[1] === w);
    for (let k = 0; k < stops.length - 1; k++) {
      const s0 = snaps[k], s1 = snaps[k + 1];
      const leg = {from: k, to: k + 1, ok: false, ways: [], geometry: [], why: ''};
      if (s0 === null || s1 === null) {
        leg.why = `stop ${s0 === null ? k : k + 1} is more than ${SNAP} m from any road a bus can use`;
        legs.push(leg); prevEnd = null; continue;
      }
      let lo = null, hi = null;
      if (guide) {
        lo = Math.min(at[k][0], at[k + 1][0]); hi = Math.max(at[k][0], at[k + 1][0]);
        lo = Math.max(0, lo - 3); hi = Math.min(guide.pts.length - 2, hi + 3);
      }
      const La = metres(g.coord.get(s0[2]), g.coord.get(s0[3]));
      let starts;
      if (prevEnd !== null && (prevEnd === s0[2] || prevEnd === s0[3])) starts = new Map([[prevEnd, 0.0]]);
      else {
        starts = new Map([[s0[3], (1 - s0[4]) * La]]);
        if (g.adj.has(s0[2]) && adjHas(s0[3], s0[2], s0[1])) starts.set(s0[2], s0[4] * La);
      }
      const Lb = metres(g.coord.get(s1[2]), g.coord.get(s1[3]));
      const goals = new Map([[s1[2], s1[4] * Lb]]);
      if (adjHas(s1[3], s1[2], s1[1])) goals.set(s1[3], (1 - s1[4]) * Lb);
      const A = new Set([s0[2], s0[3]]), B = new Set([s1[2], s1[3]]);
      const same = A.size === B.size && [...A].every(x => B.has(x));
      const fresh = !(prevEnd !== null && (prevEnd === s0[2] || prevEnd === s0[3]));
      const res = g.astar(starts, goals, guide, lo, hi, {startAt: guide ? at[k][1] : null, endAt: guide ? at[k + 1][1] : null,
        noFirst: fresh && !same ? new Map([[s0[2], s0[3]], [s0[3], s0[2]]]) : null, noLast: same ? null : new Map([[s1[2], s1[3]], [s1[3], s1[2]]])});
      if (res === null) { leg.why = 'no drivable path between these stops on the map'; legs.push(leg); prevEnd = null; continue; }
      const [, path, ways] = res;
      leg.ok = true;
      leg.ways = ways.length ? [s0[1], ...ways, s1[1]] : s0[1] !== s1[1] ? [s0[1], s1[1]] : [s0[1]];
      leg.ways = leg.ways.filter((w, i) => i === 0 || w !== leg.ways[i - 1]);
      const on = sn => { const A = g.coord.get(sn[2]), B = g.coord.get(sn[3]); return [A[0] + (B[0] - A[0]) * sn[4], A[1] + (B[1] - A[1]) * sn[4]]; };
      let pts = path.map(n => g.coord.get(n));
      if (path.length > 1 && ((path[0] === s0[2] && path[1] === s0[3]) || (path[0] === s0[3] && path[1] === s0[2]))) pts = pts.slice(1);
      leg.geometry = [on(s0), ...pts, on(s1)];
      prevEnd = path[path.length - 1];
      legs.push(leg);
      for (const w of leg.ways) if (!allWays.length || allWays[allWays.length - 1] !== w) allWays.push(w);
      geom.push(...leg.geometry);
    }
    if (guide) divs = divergences(g, guide, legs, stops, at);
    const score = guide ? coverage(guide, geom) : null;
    return {legs, ways: allWays, geometry: geom, divergences: divs, score};
  }

  function coverage(guide, geom) {
    if (!geom.length || guide.length === 0) return {shape_covered: 0.0, path_on_shape: 0.0};
    const routed = new Polyline(geom), step = 15.0;
    const n = trunc(guide.length / step) + 1;
    let on = 0;
    for (let i = 0; i < n; i++) { const p = guide.slice(i * step, i * step + 0.01); if (p.length && routed.nearest(p[0])[0] <= DIVERGE) on++; }
    const m = trunc(routed.length / step) + 1;
    let on2 = 0;
    for (let i = 0; i < m; i++) { const p = routed.slice(i * step, i * step + 0.01); if (p.length && guide.nearest(p[0])[0] <= DIVERGE) on2++; }
    return {shape_covered: pyround(on / n, 3), path_on_shape: pyround(on2 / m, 3)};
  }

  function divergences(g, guide, legs, stops, at) {
    const out = [];
    for (const leg of legs) {
      const k = leg.from;
      if (!leg.ok) {
        const [m0, m1] = [at[k][1], at[k + 1][1]].sort((a, b) => a - b);
        const mid = guide.slice((m0 + m1) / 2, (m0 + m1) / 2 + 0.01);
        out.push({kind: 'no-path', leg: k, lon: mid.length ? mid[0][0] : stops[k][0], lat: mid.length ? mid[0][1] : stops[k][1],
          length: pyround(m1 - m0), why: leg.why, ways: [], shape: guide.slice(m0, m1)});
        continue;
      }
      let run = null;
      const pts = leg.geometry;
      const lo = Math.max(0, Math.min(at[k][0], at[k + 1][0]) - 3), hi = Math.min(guide.pts.length - 2, Math.max(at[k][0], at[k + 1][0]) + 3);
      pts.forEach((p, i) => {
        const [d, , m] = guide.nearest(p, lo, hi);
        if (d > DIVERGE) {
          if (run === null) run = {kind: 'detour', leg: k, start: i, lon: p[0], lat: p[1], max: d, m0: m};
          run.max = Math.max(run.max, d); run.m1 = m;
        } else if (run !== null) { run.end = i; out.push(finish(g, guide, run, pts, leg)); run = null; }
      });
      if (run !== null) { run.end = pts.length - 1; out.push(finish(g, guide, run, pts, leg)); }
    }
    const routed = legs.some(l => l.ok) ? new Polyline(legs.flatMap(l => l.geometry)) : null;
    if (routed && routed.length) {
      const step = 15.0, n = trunc(guide.length / step) + 1;
      let gap = null;
      for (let i = 0; i < n + 1; i++) {
        const m = Math.min(i * step, guide.length), p = guide.slice(m, m + 0.01);
        const far = i < n && p.length && routed.nearest(p[0])[0] > DIVERGE;
        if (far && gap === null) gap = [m, m];
        else if (far) gap[1] = m;
        else if (gap !== null) {
          if (gap[1] - gap[0] >= 40) {
            const mid = guide.slice((gap[0] + gap[1]) / 2, (gap[0] + gap[1]) / 2 + 0.01)[0];
            const [why, ways, fix] = explainGap(g, guide, gap);
            if (!out.some(o => o.kind !== 'no-path' && Math.abs((o.m0 !== undefined ? o.m0 : -1e9) - gap[0]) < 60))
              out.push({kind: 'uncovered', lon: mid[0], lat: mid[1], length: pyround(gap[1] - gap[0]), why, ways, fix, shape: guide.slice(gap[0], gap[1]), m0: gap[0]});
          }
          gap = null;
        }
      }
    }
    out.sort((a, b) => b.length - a.length);
    return out;
  }

  function finish(g, guide, run, pts, leg) {
    const seg = pts.slice(run.start, run.end + 1);
    let L = 0; for (let i = 0; i < seg.length - 1; i++) L += metres(seg[i], seg[i + 1]);
    const [m0, m1] = [run.m0, run.m1 !== undefined ? run.m1 : run.m0].sort((a, b) => a - b);
    const [why, ways, fix] = explainGap(g, guide, [m0, m1]);
    return {kind: 'detour', leg: leg.from, lon: run.lon, lat: run.lat, length: pyround(L), max: pyround(run.max), why, ways, fix, path: seg, shape: guide.slice(m0, m1), m0};
  }

  function explainGap(g, guide, gap) {
    const [m0, m1] = gap;
    const samples = [0.25, 0.5, 0.75].map(f => m0 + (m1 - m0) * f).filter(m => guide.slice(m, m + 0.01).length).map(m => guide.slice(m, m + 0.01)[0]);
    const drivable = new Map(), blocked = new Map();
    for (const p of samples) {
      for (const [w, d] of g.nearbyWays(p, 25)) drivable.set(w, Math.min(d, drivable.has(w) ? drivable.get(w) : 99));
      for (const [w, [, why]] of g.blockedNear(p, 25)) blocked.set(w, why);
    }
    if (blocked.size && !drivable.size) { const [w, why] = blocked.entries().next().value; return [`the line follows way ${w} which a bus may not use (${why})`, [...blocked.keys()], null]; }
    if (drivable.size) {
      const ag = against(g, guide, samples, gap, drivable);
      if (ag) {
        const [w, , wdir, ldir] = ag, t = g.ways.get(w).tags || {}, name = t.name || t.highway || 'road';
        return [`a bus can't drive ${ldir} here: ${name} (way ${w}) is one-way ${wdir}, against the agency's line. ` +
          'Wrong direction on the map, or does the bus really go another way?', [w, ...[...drivable.keys()].filter(x => x !== w)],
          {kind: 'reverse', way: w, name, now: `one-way ${wdir}`, want: `one-way ${ldir}`}];
      }
      const ows = [...drivable.keys()].filter(w => { const m = busMay(g.ways.get(w).tags || {}); return !(m === null || (m[0] && m[1])); });
      if (ows.length) return ["roads are mapped here but one-way; check oneway=* against the line's direction", [...drivable.keys()], null];
      return ["roads are mapped here but the router didn't connect through them: a missing junction node or a gap between ways?", [...drivable.keys()], null];
    }
    if (blocked.size) { const [w, why] = blocked.entries().next().value; return [`only way ${w} is here and a bus may not use it (${why})`, [...blocked.keys()], null]; }
    return ["no road here in OpenStreetMap: missing, or the agency's line is drawn off the street", [], null];
  }

  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const heading = (a, b) => {
    const dx = (b[0] - a[0]) * Math.cos(a[1] * RAD), dy = b[1] - a[1];
    return COMPASS[pyround(((Math.atan2(dx, dy) / RAD + 360) % 360) / 45) % 8];
  };

  function against(g, guide, samples, gap, drivable) {
    const [m0, m1] = gap;
    let best = null;
    const near = new Set(drivable.keys());
    for (let i = 0; i < trunc((m1 - m0) / 10) + 1; i++) {
      const m = m0 + i * 10, line = guide.slice(m - 8, m + 8);
      if (line.length < 2) continue;
      const lv = [(line[line.length - 1][0] - line[0][0]) * Math.cos(line[0][1] * RAD), line[line.length - 1][1] - line[0][1]];
      const p = line[trunc(line.length / 2)];
      for (const w of g.nearbyWays(p, 25).keys()) near.add(w);
      let withLine = false; const ag = [];
      for (const w of near) {
        const may = busMay(g.ways.get(w).tags || {});
        if (may === null) continue;
        const nodes = g.ways.get(w).nodes.filter(n => g.coord.has(n));
        for (let j = 0; j < nodes.length - 1; j++) {
          const a = g.coord.get(nodes[j]), b = g.coord.get(nodes[j + 1]);
          const [, d] = project(p, a, b);
          if (d > 20) continue;
          const wv = [(b[0] - a[0]) * Math.cos(a[1] * RAD), b[1] - a[1]];
          const dot = wv[0] * lv[0] + wv[1] * lv[1];
          if (Math.abs(dot) < 0.5 * Math.hypot(...wv) * Math.hypot(...lv)) continue;
          const fwd = dot > 0;
          if ((fwd && may[0]) || (!fwd && may[1])) withLine = true;
          else ag.push([w, d, may[1] && !may[0] ? heading(b, a) : heading(a, b), heading(line[0], line[line.length - 1])]);
        }
      }
      if (!withLine && ag.length) {
        let c = ag[0]; for (const x of ag) if (x[1] < c[1]) c = x;
        if (best === null || c[1] < best[1]) best = c;
      }
    }
    return best;
  }

  // ---- compare.chain_breaks: where member ways don't run end to end ----
  function chainBreaks(wayIds, ways) {
    const out = [];
    const nodesOf = w => (ways.get(w) || {}).nodes || [];
    let prev = null, at = null;
    wayIds.forEach((w, i) => {
      const nodes = nodesOf(w);
      if (!nodes.length) { prev = null; at = null; return; }
      const closed = nodes[0] === nodes[nodes.length - 1];
      const pn = prev !== null ? new Set(nodesOf(prev)) : null;
      if (prev === null) at = null;
      else if (closed || (at === null && nodes.some(n => pn.has(n)))) { /* fine */ }
      else if (at === nodes[0] || at === nodes[nodes.length - 1]) { /* fine */ }
      else if (at !== null && nodes.includes(at)) out.push({i, a: prev, b: w, kind: 'split', node: at, split: w});
      else {
        const shared = nodes.filter(n => pn.has(n));
        if (shared.length) { const n = shared[0]; out.push({i, a: prev, b: w, kind: 'split', node: n, split: (n === nodes[0] || n === nodes[nodes.length - 1]) ? prev : w}); }
        else out.push({i, a: prev, b: w, kind: 'gap', node: nodes[0], split: null});
      }
      if (closed) at = null;
      else if (at === nodes[0]) at = nodes[nodes.length - 1];
      else if (at === nodes[nodes.length - 1]) at = nodes[0];
      else {
        const nxt = new Set(i + 1 < wayIds.length ? nodesOf(wayIds[i + 1]) : []);
        at = nxt.has(nodes[0]) && !nxt.has(nodes[nodes.length - 1]) ? nodes[0] : nodes[nodes.length - 1];
      }
      prev = w;
    });
    let res = out;
    for (let i = 1; i < wayIds.length - 1; i++) {
      const a = wayIds[i - 1], b = wayIds[i], bn = nodesOf(b);
      if (a === wayIds[i + 1] && a !== b && bn.length && bn[0] !== bn[bn.length - 1]) {
        const an = new Set(nodesOf(a)), shared = bn.filter(n => an.has(n));
        res = res.filter(x => x.i !== i && x.i !== i + 1);
        res.push({i, a, b, kind: 'spur', node: shared.length ? shared[0] : bn[0], split: null});
      }
    }
    return res.sort((x, y) => x.i - y.i);
  }

  // ---- review.stop_positions: each stop's stop position on its route's roads ----
  const sdist = (lat1, lon1, lat2, lon2) => Math.hypot((lat2 - lat1) * 110540, (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * RAD));
  function stopPositions(p, tr, osmStops, g, stopAreas, matchOf, near = 25) {
    const sp = new Map();
    for (const o of Object.values(osmStops)) if (o.tags.public_transport === 'stop_position' && o.id[0] === 'n') sp.set(+o.id.slice(1), o);
    if (!sp.size) return {};
    const plats = Object.values(osmStops).filter(o => o.tags.public_transport === 'platform' || o.tags.highway === 'bus_stop');
    const bay = new Map();
    if (plats.length) for (const [n, x] of sp) { let b = plats[0], bd = Infinity; for (const q of plats) { const d = sdist(x.lat, x.lon, q.lat, q.lon); if (d < bd) { bd = d; b = q; } } bay.set(n, b.id); }
    const grouped = new Map();
    for (const a of stopAreas || []) {
      const stops = a.members.filter(m => m.role === 'stop' && m.type === 'node').map(m => m.ref);
      for (const m of a.members) if (m.role === 'platform') { const k = m.type[0] + m.ref; if (!grouped.has(k)) grouped.set(k, new Set()); for (const s of stops) grouped.get(k).add(s); }
    }
    const legs = tr.legs, got = {};
    p.stops.forEach((sid, k) => {
      const ways = new Set([...(k ? legs[k - 1].ways : []), ...(k < legs.length ? legs[k].ways : [])]);
      const on = new Set(); for (const w of ways) if (g.ways.has(w)) for (const n of g.ways.get(w).nodes || []) on.add(n);
      const m = matchOf(sid) || {};
      const o = m.status === 'matched' && m.osm && m.osm.length ? osmStops[m.osm[0].id] : null;
      if (!o) return;
      const cands = [...sp].filter(([n]) => on.has(n) && bay.get(n) === o.id).map(([n, x]) => [n, sdist(o.lat, o.lon, x.lat, x.lon)]).filter(c => c[1] <= near);
      if (!cands.length) return;
      const pref = grouped.get(o.id) || new Set();
      let best = cands[0];
      for (const c of cands) { const kc = [pref.has(c[0]) ? 0 : 1, c[1]], kb = [pref.has(best[0]) ? 0 : 1, best[1]]; if (kc[0] < kb[0] || (kc[0] === kb[0] && kc[1] < kb[1])) best = c; }
      got[sid] = best[0];
    });
    return got;
  }

  const roundPts = pts => pts.map(([x, y]) => [pyround(x, 6), pyround(y, 6)]);
  /** review.route_pattern: what needs roads, for one itinerary. p: {id, stops, shape}; stopsLL: {sid: [lon, lat]}. */
  function routePattern(p, stopsLL, g, osmStops, stopAreas, matchOf) {
    const tr = trace(g, p.stops.map(s => stopsLL[s]), p.shape && p.shape.length > 1 ? p.shape : null);
    const breaks = chainBreaks(tr.ways, g.ways);
    const guide = p.shape && p.shape.length > 1 ? new Polyline(p.shape) : null;
    for (const b of breaks) if (b.kind === 'spur') {
      const bn = g.ways.get(b.b).nodes, far = [bn[0], bn[bn.length - 1]].filter(n => n !== b.node && g.coord.has(n));
      b.turnaround = !!(guide && far.length && guide.nearest(g.coord.get(far[0]))[0] <= DIVERGE);
    }
    const tags = w => (g.ways.get(w) || {}).tags || {};
    return {
      chain_ok: tr.legs.every(l => l.ok) && !breaks.some(b => b.kind === 'gap' || (b.kind === 'spur' && !b.turnaround)),
      chain_breaks: breaks.filter(b => g.coord.has(b.node)).map(b => ({...b, lon: g.coord.get(b.node)[0], lat: g.coord.get(b.node)[1]})),
      way_tags: Object.fromEntries(tr.ways.filter(w => g.ways.has(w)).map(w => [w, tags(w)])),
      way_nodes: Object.fromEntries(tr.ways.filter(w => g.ways.has(w)).map(w => [w, g.ways.get(w).nodes || []])),
      stop_positions: stopPositions(p, tr, osmStops, g, stopAreas, matchOf),
      routed: {ways: tr.ways, geometry: roundPts(tr.geometry), legs: tr.legs.map(l => ({from: l.from, to: l.to, ok: l.ok, why: l.why, ways: l.ways})),
        divergences: tr.divergences.map(d => ({...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'shape' || k === 'path' ? roundPts(v) : v])),
          way_tags: Object.fromEntries(d.ways.filter(w => g.ways.has(w)).map(w => [w, tags(w)]))})),
        score: tr.score},
    };
  }

  /** serve.trace_with_vias: the stops, with via points folded in at the nearest leg. */
  function traceWithVias(p, stopsLL, g, vias) {
    const pts = p.stops.map(s => stopsLL[s]), order = pts.map((_, i) => i);
    for (const v of vias) {
      let best = null, bi = 0;
      for (let i = 0; i < order.length - 1; i++) { const [, d] = project(v, pts[order[i]], pts[order[i + 1]]); if (best === null || d < best) { best = d; bi = i; } }
      pts.push(v); order.splice(bi + 1, 0, pts.length - 1);
    }
    const res = trace(g, order.map(i => pts[i]), p.shape && p.shape.length > 1 ? p.shape : null);
    return {ways: res.ways, geometry: roundPts(res.geometry), legs: res.legs.map(l => ({from: l.from, to: l.to, ok: l.ok, why: l.why, ways: l.ways})),
      divergences: res.divergences.map(d => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'shape' || k === 'path' ? roundPts(v) : v]))), score: res.score, vias};
  }

  return {Graph, Polyline, trace, routePattern, traceWithVias, chainBreaks, busMay, metres, project, pyround};
})();

if (typeof module !== 'undefined') module.exports = Router;
