/* ondemand.js — an on-demand service (a zone booked by app or phone, picked up at signed stops on the street) whose
   pickups the agency's feed doesn't have: where each is, and what OSM has there. A pickup is a stop in OSM with the
   service in its route_ref: a bus stop it's at gains it; one of its own is added (the address as its name, the
   landmark the agency gives it as description). Read from the agency's published map (tool/ondemand.py). */
'use strict';

const OnDemand = {
  svc(name) { return (D.ondemand || []).find(x => x.name === name); },
  /** Its pickups as they are now: with what's in Changes (POOL added, a stop added) counted. */
  state(q, svc) {
    if (q.osm) {
      const o = D.osm_stops[q.osm], op = o && Edits.get(q.osm[0] + osmNumId(o)), t = (op && op.kind !== 'delete' ? op.tags : o && o.tags) || {};
      return (t.route_ref || '').split(';').map(x => x.trim()).includes(svc.name) ? 'there' : 'add_ref';
    }
    return this.added(q) ? 'added' : 'missing';
  },
  added(q) { return Object.entries(Edits.all()).find(([, o]) => o.kind === 'create' && o.type === 'node' && o.ondemand === q.id); },
  open(name) { S.ondemand = name; S.tab = 'stops'; S.stop = null; S.station = null; render(); draw();
    const svc = this.svc(name); if (svc) fit(svc.pickups.map(q => [q.lon, q.lat]), 40); },
  close() { S.ondemand = null; if (S.placing) { S.placing.remove(); S.placing = null; } render(); draw(); },

  /** POOL on an OSM stop's route_ref, the rest of it as it is. */
  addRef(q, svc) {
    const o = D.osm_stops[q.osm];
    if (!o || o.id[0] !== 'n') return toast(`${(o && o.tags.name) || q.osm} is drawn as a shape: add ${svc.name} in iD`, 5000);
    const op = Edits.get('n' + osmNumId(o)), t = (op && op.tags) || o.tags;
    const refs = (t.route_ref || '').split(';').map(x => x.trim()).filter(Boolean);
    if (refs.includes(svc.name)) return;
    const key = Edits.modify('node', osmNumId(o), nodeBase(o), {tags: {route_ref: [...refs, svc.name].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).join(';')}}, `${t.name || o.id}: ${svc.name} stops here`);
    Edits.ops[key].ondemand = q.id; Edits.ops[key].service = svc.name; Edits.save();
  },
  /** A stop of its own for a pickup, at the agency's point: a marker to drag onto the sign. */
  addStop(q, svc) {
    if (this.added(q)) return;
    const tags = {...svc.tags, name: q.name, ...(q.description ? {description: q.description} : {})};
    const key = Edits.createNode(q.lat, q.lon, tags, `${q.name}: ${svc.name} stop`);
    Edits.ops[key].ondemand = q.id; Edits.ops[key].service = svc.name; Edits.save();
    if (S.placing) S.placing.remove();
    const mk = new maplibregl.Marker({draggable: true, color: css('--edit')}).setLngLat([q.lon, q.lat]).addTo(map);
    mk.on('dragend', () => { const ll = mk.getLngLat(), op = Edits.get(key); if (op) { op.lat = ll.lat; op.lon = ll.lng; Edits.save(); draw(); } });
    S.placing = mk;
  },
  show(q) { S.ondemandAt = q.id; draw(); map.flyTo({center: [q.lon, q.lat], zoom: Math.max(map.getZoom(), 18), duration: 500}); },

  /** The Routes tab's line for it. */
  line(svc) {
    const n = k => svc.pickups.filter(q => this.state(q, svc) === k).length, todo = n('add_ref') + n('missing');
    return el('div', {class: 'row', onclick: () => this.open(svc.name)},
      el('span', {class: 'dotc ' + (todo ? 'ambiguous' : 'matched')}), el('div', {class: 'grow'}, el('div', {class: 't'}, `${svc.name}: on demand, ${svc.pickups.length} pickups`),
        el('div', {class: 's', style: 'white-space:normal'}, [n('add_ref') ? `${n('add_ref')} stops to give ${svc.name}` : null, n('missing') ? `${n('missing')} not in OSM` : null, n('added') ? `${n('added')} added in Changes` : null].filter(Boolean).join(' · ') || 'all in OSM')),
      el('span', {class: 'chip ' + (todo ? 'warn' : 'good')}, 'on demand'));
  },

  render(P) {
    const svc = this.svc(S.ondemand);
    if (!svc) { S.ondemand = null; return renderStops(P); }
    P.append(el('button', {class: 'back', onclick: () => this.close()}, '← all stops'));
    const d = el('div', {class: 'detail fixcard'});
    d.append(el('div', {class: 'head'}, el('h3', {}, `${svc.name}: on demand`)),
      el('div', {class: 'why'}, `Booked by app or phone in its zone, picked up at signed stops. The agency's timetable doesn't have it; its map does: ${svc.pickups.length} pickups. Each is a stop in OSM with ${svc.name} in its route_ref: a bus stop it's at gains it, and one of its own is added (its address as the name, the landmark as description), dragged onto its sign.`));
    const by = k => svc.pickups.filter(q => this.state(q, svc) === k);
    const row = (q, ...rest) => el('div', {class: 'decide go-row', onclick: e => { if (!e.target.closest('a, button')) this.show(q); }},
      el('div', {}, el('b', {}, q.label)), ...rest);
    const ref = by('add_ref');
    if (ref.length) d.append(el('div', {class: 'fixstep'}, el('div', {class: 'k'}, `A stop in OSM, without ${svc.name}: ${ref.length}`),
      el('div', {class: 'btns'}, el('button', {class: 'b tiny primary', onclick: () => { Edits.hold(`${svc.name} on ${ref.length} stops`); try { for (const q of ref) this.addRef(q, svc); } finally { Edits.release(); } toast(`${svc.name} on ${ref.length} stops: in Changes`); render(); draw(); }}, `Add ${svc.name} to all ${ref.length}`)),
      ...ref.map(q => { const o = D.osm_stops[q.osm] || {tags: {}}; return row(q, el('div', {class: 'small muted'}, `OSM: ${o.tags.name || q.osm}, ${q.dist} m · route_ref=${o.tags.route_ref || '(none)'}`),
        el('div', {class: 'btns'}, el('button', {class: 'b tiny', onclick: () => { this.addRef(q, svc); render(); draw(); }}, `Add ${svc.name} to it`))); })));
    const miss = by('missing');
    if (miss.length) d.append(el('div', {class: 'fixstep'}, el('div', {class: 'k'}, `Not in OSM: ${miss.length}`),
      el('div', {class: 'why'}, "Added at the agency's point: drag its marker onto the sign (imagery helps). Its name is the address; the landmark goes in description."),
      ...miss.map(q => row(q, el('div', {class: 'btns'}, el('button', {class: 'b tiny', onclick: () => { this.show(q); this.addStop(q, svc); render(); draw(); }}, 'Add the stop'))))));
    const done = [...by('added'), ...by('there')];
    if (done.length) d.append(el('details', {class: 'small'}, el('summary', {}, `In OSM with ${svc.name}, or added in Changes: ${done.length}`),
      ...done.map(q => row(q, el('div', {class: 'small muted'}, this.state(q, svc) === 'added' ? 'added, in Changes' : `OSM: ${(D.osm_stops[q.osm] || {tags: {}}).tags.name || q.osm}`)))));
    P.append(d);
  },

  /** On the map: the zone, and its pickups by state. */
  features() {
    const svc = S.ondemand && S.tab === 'stops' && this.svc(S.ondemand);
    if (!svc) return [];
    const out = svc.zone.length > 2 ? [line([...svc.zone, svc.zone[0]], {kind: 'zone'})] : [];
    for (const q of svc.pickups) out.push(point([q.lon, q.lat], {kind: this.state(q, svc), label: q.id === S.ondemandAt ? q.label : ''}));
    return out;
  },
};
