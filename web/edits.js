/* edits.js — flagstop's change basket: what the reviewer decided, kept locally until it is uploaded
   as one changeset through OSM's API, downloaded as osmChange for JOSM, or copied as Level0 text.

   Every op holds the object's base state as flagstop saw it (tags, version, position, members), so the
   review screen can show a before/after and the upload can refuse if the object changed meanwhile. */
'use strict';

const OSM_API = 'https://api.openstreetmap.org';
const OSM_WWW = 'https://www.openstreetmap.org';

const Edits = {
  key: 'flagstop.edits',
  ops: {},          // key -> op ; key is 'n123' / 'w123' / 'r123' for existing, 'new:n-1' for new
  nextId: -1,
  decisions: {},    // stop id -> osm id chosen for an ambiguous match
  roads: [],        // road edits, oldest first: {what, before: {key: op as it was, or null}} — so their parts can't be removed singly
  listeners: [],
  // Undo/redo: every save() records the basket as it was before, one entry per user action (all the saves a
  // single action makes in one go — a road edit's node, ways and relations — land in the same entry).
  history: [], future: [], committed: null, batching: false, nextLabel: null,

  load(agency) {
    this.key = 'flagstop.edits.' + (agency || '').replace(/\W+/g, '_');
    try {
      const s = JSON.parse(localStorage.getItem(this.key) || '{}');
      this.ops = s.ops || {}; this.nextId = s.nextId || -1; this.decisions = s.decisions || {}; this.roads = s.roads || [];
    } catch (e) { this.ops = {}; }
    this.history = []; this.future = []; this.committed = this.state();
  },
  state() { return JSON.stringify({ops: this.ops, nextId: this.nextId, decisions: this.decisions, roads: this.roads}); },
  save() {
    const now = this.state();
    if (this.committed != null && now !== this.committed) {
      if (!this.batching) {
        this.history.push({state: this.committed, label: this.nextLabel});
        if (this.history.length > 200) this.history.shift();
        this.future = [];
        this.batching = true;
        queueMicrotask(() => { this.batching = false; this.nextLabel = null; });
      }
      this.committed = now;
    }
    this.persist(now);
  },
  persist(now = this.state()) {
    try { localStorage.setItem(this.key, now); } catch (e) {}
    this.listeners.forEach(f => f());
  },
  /** Name the action about to be saved, for the undo toast ("Undone: split 500 North"). */
  label(text) { this.nextLabel = text; },
  restore(json) { const s = JSON.parse(json); this.ops = s.ops; this.nextId = s.nextId; this.decisions = s.decisions; this.roads = s.roads || []; this.committed = json; this.persist(json); },
  /** What changed between two states, in a few words, when the action had no name. */
  describe(a, b) {
    const x = JSON.parse(a).ops, y = JSON.parse(b).ops, keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
    const name = k => { const op = y[k] || x[k]; return op.note && !String(op.note).includes(':') ? op.note : (k.startsWith('new:') ? 'new ' : '') + k.replace(/^new:/, ''); };
    return keys.length === 1 ? name(keys[0]) : keys.length <= 3 ? keys.map(name).join(', ') : `${keys.length} changes`;
  },
  undo() {
    const e = this.history.pop();
    if (!e) return null;
    const now = this.state();
    this.future.push({state: now, label: e.label});
    this.restore(e.state);
    return e.label || this.describe(e.state, now);
  },
  redo() {
    const e = this.future.pop();
    if (!e) return null;
    const now = this.state();
    this.history.push({state: now, label: e.label});
    this.restore(e.state);
    return e.label || this.describe(now, e.state);
  },
  count() { return Object.keys(this.ops).length; },
  get(key) { return this.ops[key]; },
  remove(key) { delete this.ops[key]; this.save(); },
  clear() { this.ops = {}; this.roads = []; this.save(); },
  /** A road edit is many ops that only make sense together (a new node, the way using it, the relations
      repaired around it): record what each key was before, so it can be taken back as one. */
  roadBegin(what) { return {what, before: {}}; },
  roadTouch(g, key) { if (!(key in g.before)) g.before[key] = this.ops[key] ? JSON.parse(JSON.stringify(this.ops[key])) : null; },
  roadEnd(g) { this.roads.push(g); this.save(); },
  /** The road edit a key belongs to (it can only go with it), or null. */
  roadOf(key) { return this.roads.find(g => key in g.before) || null; },

  // --- ops -------------------------------------------------------------
  /** A fresh negative id, for building several new objects that refer to each other before saving. */
  newId() { return this.nextId--; },
  /** A new node. base is null. Returns the op key. */
  createNode(lat, lon, tags, note, id = this.nextId--) {
    const key = 'new:n' + id;
    this.ops[key] = {kind: 'create', type: 'node', id, tags: {...tags}, lat, lon, note};
    this.save();
    return key;
  },
  /** Modify an existing object's tags and/or position. base = {version, tags, lat, lon, members, nodes}. */
  modify(type, id, base, changes, note) {
    const key = type[0] + id;
    const op = this.ops[key] || {kind: 'modify', type, id, base: JSON.parse(JSON.stringify(base)), tags: {...base.tags}, lat: base.lat, lon: base.lon, members: base.members, nodes: base.nodes, note};
    if (changes.tags) op.tags = {...op.tags, ...changes.tags};
    for (const k of changes.removeTags || []) delete op.tags[k];
    if (changes.lat != null) { op.lat = changes.lat; op.lon = changes.lon; }
    if (changes.members) op.members = changes.members;
    if (changes.nodes) op.nodes = changes.nodes;
    if (note) op.note = note;
    this.ops[key] = op;
    this.save();
    return key;
  },
  /** A new way (a piece split off another, or a drawn segment). nodes may include new nodes' negative ids. */
  createWay(tags, nodes, note, id = this.nextId--) {
    const key = 'new:w' + id;
    this.ops[key] = {kind: 'create', type: 'way', id, tags: {...tags}, nodes: [...nodes], note};
    this.save();
    return key;
  },
  createRelation(tags, members, note) {
    const id = this.nextId--;
    const key = 'new:r' + id;
    this.ops[key] = {kind: 'create', type: 'relation', id, tags: {...tags}, members, note};
    this.save();
    return key;
  },
  delete(type, id, base, note) {
    const key = type[0] + id;
    this.ops[key] = {kind: 'delete', type, id, base: JSON.parse(JSON.stringify(base)), tags: base.tags, note};
    this.save();
    return key;
  },
  /** Members may reference ops by key ('new:r-3'); resolve to {type, ref, role} with negative ids. */
  resolveMember(m) {
    if (m.key) { const op = this.ops[m.key]; return op ? {type: op.type, ref: op.id, role: m.role} : null; }
    return m;
  },
  /** What changed in a modify op: [{k, before, after}] */
  diff(op) {
    const out = [];
    const b = op.base ? op.base.tags : {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(op.tags)])) if ((b[k] || '') !== (op.tags[k] || '')) out.push({k, before: b[k], after: op.tags[k]});
    if (op.base && op.lat != null && (op.lat !== op.base.lat || op.lon !== op.base.lon)) out.push({k: 'position', before: `${op.base.lat.toFixed(6)}, ${op.base.lon.toFixed(6)}`, after: `${op.lat.toFixed(6)}, ${op.lon.toFixed(6)}`});
    if (op.base && op.members && JSON.stringify(op.members) !== JSON.stringify(op.base.members)) out.push({k: 'members', before: `${(op.base.members || []).length} members`, after: `${op.members.length} members`});
    if (op.base && op.nodes && op.base.nodes && JSON.stringify(op.nodes) !== JSON.stringify(op.base.nodes)) out.push({k: 'nodes', before: `${op.base.nodes.length} nodes`, after: `${op.nodes.length} nodes`});
    return out;
  },

  // --- serialisation ----------------------------------------------------
  xmlEsc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); },
  elementXml(op, changeset, version) {
    const t = Object.entries(op.tags || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `    <tag k="${this.xmlEsc(k)}" v="${this.xmlEsc(v)}"/>\n`).join('');
    const attrs = `id="${op.id}"${version != null ? ` version="${version}"` : ''}${changeset ? ` changeset="${changeset}"` : ''}`;
    if (op.type === 'node') return `  <node ${attrs} lat="${op.lat.toFixed(7)}" lon="${op.lon.toFixed(7)}">\n${t}  </node>\n`;
    if (op.type === 'way') return `  <way ${attrs}>\n${(op.nodes || []).map(n => `    <nd ref="${n}"/>\n`).join('')}${t}  </way>\n`;
    const mem = (op.members || []).map(m => this.resolveMember(m)).filter(Boolean).map(m => `    <member type="${m.type}" ref="${m.ref}" role="${this.xmlEsc(m.role || '')}"/>\n`).join('');
    return `  <relation ${attrs}>\n${mem}${t}  </relation>\n`;
  },
  /** osmChange document. versions: {key: version} for modify/delete (from base, or freshly fetched). */
  osc(changeset, versions = {}) {
    const by = {create: [], modify: [], delete: []};
    // creations: nodes before relations, so relation members resolve
    const order = op => (op.type === 'node' ? 0 : op.type === 'way' ? 1 : 2);
    for (const [key, op] of Object.entries(this.ops).sort((a, b) => order(a[1]) - order(b[1]))) {
      if (op.kind === 'modify' && !this.diff(op).length) continue;   // nothing changed: don't bump its version
      const v = versions[key] ?? (op.base && op.base.version);
      by[op.kind].push(this.elementXml(op, changeset, op.kind === 'create' ? null : v));
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<osmChange version="0.6" generator="flagstop">\n` +
      (by.create.length ? `<create>\n${by.create.join('')}</create>\n` : '') +
      (by.modify.length ? `<modify>\n${by.modify.join('')}</modify>\n` : '') +
      (by.delete.length ? `<delete if-unused="true">\n${by.delete.join('')}</delete>\n` : '') + `</osmChange>\n`;
  },
  /** Level0L text (level0.osmz.ru): paste, review, upload with your own login. */
  level0() {
    const lines = [];
    for (const op of Object.values(this.ops)) {
      if (op.kind === 'delete') { lines.push(`# delete ${op.type} ${op.id} by hand: Level0 text has no delete`); continue; }
      const head = op.type === 'node' ? `node ${op.id}: ${op.lat.toFixed(7)}, ${op.lon.toFixed(7)}` : `${op.type} ${op.id}`;
      lines.push(head);
      if (op.type === 'way') for (const n of op.nodes || []) lines.push(`  nd ${n}`);
      if (op.type === 'relation') for (const m of (op.members || []).map(m => this.resolveMember(m)).filter(Boolean)) lines.push(`  ${m.type[0] === 'n' ? 'nd' : m.type[0] === 'w' ? 'wy' : 'rel'} ${m.ref}${m.role ? ' ' + m.role : ''}`);
      for (const [k, v] of Object.entries(op.tags || {})) if (v !== '' && v != null) lines.push(`  ${k} = ${v}`);
      lines.push('');
    }
    return lines.join('\n');
  },

  // --- OSM sign-in (OAuth 2, PKCE, no secret) ------------------------------
  auth: {
    clientId() { return localStorage.getItem('flagstop.osm.client_id') || ''; },
    setClientId(v) { localStorage.setItem('flagstop.osm.client_id', v.trim()); },
    token() { return localStorage.getItem('flagstop.osm.token') || ''; },
    user() { try { return JSON.parse(localStorage.getItem('flagstop.osm.user') || 'null'); } catch (e) { return null; } },
    signOut() { localStorage.removeItem('flagstop.osm.token'); localStorage.removeItem('flagstop.osm.user'); },
    redirect() { return location.origin + location.pathname; },
    async signIn() {
      const id = this.clientId();
      if (!id) throw new Error('no client id');
      const verifier = [...crypto.getRandomValues(new Uint8Array(48))].map(b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66]).join('');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      sessionStorage.setItem('flagstop.pkce', verifier);
      const u = new URL(OSM_WWW + '/oauth2/authorize');
      u.search = new URLSearchParams({response_type: 'code', client_id: id, redirect_uri: this.redirect(), scope: 'read_prefs write_api', code_challenge: challenge, code_challenge_method: 'S256'}).toString();
      location.href = u.toString();
    },
    /** Call on page load: finishes a sign-in if we came back with ?code=. */
    async complete() {
      const code = new URLSearchParams(location.search).get('code');
      if (!code) return false;
      const verifier = sessionStorage.getItem('flagstop.pkce');
      history.replaceState(null, '', location.pathname);
      if (!verifier) return false;
      const r = await fetch(OSM_WWW + '/oauth2/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: this.redirect(), client_id: this.clientId(), code_verifier: verifier})});
      if (!r.ok) throw new Error('token exchange failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      localStorage.setItem('flagstop.osm.token', j.access_token);
      const me = await fetch(OSM_API + '/api/0.6/user/details.json', {headers: {Authorization: 'Bearer ' + j.access_token}});
      if (me.ok) localStorage.setItem('flagstop.osm.user', JSON.stringify((await me.json()).user));
      return true;
    },
  },

  // --- upload ------------------------------------------------------------
  async api(path, opts = {}) {
    const r = await fetch(OSM_API + path, {...opts, headers: {Authorization: 'Bearer ' + this.auth.token(), ...(opts.headers || {})}});
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r;
  },
  /** Fetch current versions of every existing object we touch; report conflicts where tags moved on. */
  async check() {
    const versions = {}, conflicts = [];
    for (const [key, op] of Object.entries(this.ops)) {
      if (op.kind === 'create') continue;
      const r = await fetch(`${OSM_API}/api/0.6/${op.type}/${op.id}.json`);
      if (r.status === 410 || r.status === 404) { conflicts.push({key, why: 'deleted on OSM'}); continue; }
      const el = (await r.json()).elements[0];
      versions[key] = el.version;
      const cur = el.tags || {};
      const base = op.base ? op.base.tags : {};
      const changed = [...new Set([...Object.keys(cur), ...Object.keys(base)])].filter(k => (cur[k] || '') !== (base[k] || ''));
      const moves = op.type === 'node' && op.base && op.lat != null && (op.lat !== op.base.lat || op.lon !== op.base.lon);
      // A change to a way's nodes or a relation's members was worked out from the version flagstop read:
      // any newer version, even one that left the tags alone, may have moved what it depends on.
      const topo = (op.type === 'way' && op.base && op.base.nodes && JSON.stringify(op.nodes) !== JSON.stringify(op.base.nodes)) ||
        (op.type === 'relation' && op.base && op.base.members && op.members && JSON.stringify(op.members) !== JSON.stringify(op.base.members));
      if (op.base && op.base.version != null && el.version !== op.base.version && (changed.length || moves || topo)) conflicts.push({key, why: `edited on OSM since flagstop looked (v${op.base.version} → v${el.version}${changed.length ? ': ' + changed.join(', ') : ''})`, current: el});
      else if (op.base && op.base.version == null) {
        // ways from the roads snapshot carry no version; accept if the tags we saw are still the tags
        if (changed.length) conflicts.push({key, why: `tags differ from what flagstop saw: ${changed.join(', ')}`, current: el});
        else { op.base.version = el.version; if (op.type === 'way' && !op.nodes) op.nodes = el.nodes; }
      }
      if (op.type === 'way' && !op.nodes) op.nodes = el.nodes;
      if (op.type === 'node' && op.lat == null) { op.lat = el.lat; op.lon = el.lon; }
    }
    return {versions, conflicts};
  },
  async upload(comment, source, onStatus = () => {}) {
    if (!this.auth.token()) throw new Error('not signed in');
    onStatus('checking objects on OSM…');
    const {versions, conflicts} = await this.check();
    if (conflicts.length) throw Object.assign(new Error('conflicts'), {conflicts});
    onStatus('opening changeset…');
    const tags = {created_by: 'flagstop', comment, source: source || 'GTFS', host: location.origin};
    const csXml = `<osm><changeset>${Object.entries(tags).map(([k, v]) => `<tag k="${this.xmlEsc(k)}" v="${this.xmlEsc(v)}"/>`).join('')}</changeset></osm>`;
    const id = (await (await this.api('/api/0.6/changeset/create', {method: 'PUT', headers: {'Content-Type': 'text/xml'}, body: csXml})).text()).trim();
    onStatus(`uploading to changeset ${id}…`);
    let diff;
    try {
      const res = await this.api(`/api/0.6/changeset/${id}/upload`, {method: 'POST', headers: {'Content-Type': 'text/xml'}, body: this.osc(id, versions)});
      diff = new DOMParser().parseFromString(await res.text(), 'text/xml');
    } finally {
      onStatus('closing changeset…');
      await this.api(`/api/0.6/changeset/${id}/close`, {method: 'PUT'});
    }
    // <delete if-unused> quietly keeps an object something still uses (a route in a route_master, a node
    // in a way): the diffResult then gives it a new_id instead of none. Those stay in the basket.
    const skipped = Object.entries(this.ops).filter(([, op]) => op.kind === 'delete' &&
      [...diff.getElementsByTagName(op.type)].some(e => e.getAttribute('old_id') === String(op.id) && e.hasAttribute('new_id'))).map(([key]) => key);
    for (const key of Object.keys(this.ops)) if (!skipped.includes(key)) delete this.ops[key];
    this.roads = [];
    this.save();
    this.history = []; this.future = [];   // what went to OSM isn't taken back from here
    return {id, skipped};
  },
};
