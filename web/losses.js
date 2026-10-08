/* losses.js — what uploads took away: every object a mapper's changesets deleted, with all its tags as they were,
   and every tag those changesets removed or changed on what stayed. So nothing a merge (or a slip) took out goes
   unseen. Read-only: the OSM API's changesets, their osmChange, and each object's version before. The same as
   tool/deleted.py, in the page. */
'use strict';

const Losses = {
  /** Look: the user's changesets since `days` ago, each read for what it deleted, removed or changed. */
  async look(user, days) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    S.losses = {user, days, loading: 'changesets…', list: null, error: null};
    render();
    try {
      let all = [], before = null;
      for (;;) {   // 100 at a time, newest first
        const q = new URLSearchParams({display_name: user, time: before ? `${since},${before}` : since});
        const r = await fetch(`${OSM_API}/api/0.6/changesets.json?${q}`);
        if (!r.ok) throw new Error(r.status === 404 ? `no OSM user "${user}"` : `OSM said ${r.status}`);
        const js = (await r.json()).changesets.filter(c => !all.some(x => x.id === c.id));
        all = all.concat(js);
        if (js.length < 100) break;
        before = js.map(c => c.created_at).sort()[0];
      }
      all.sort((a, b) => a.id - b.id);
      const out = [];
      let n = 0;
      const one = async c => {
        const r = await this.audit(c.id);
        n++; if (S.losses) { S.losses.loading = `changeset ${n} of ${all.length}…`; render(); }
        if (r.deleted.length || r.removed.length) out.push({...r, id: c.id, comment: (c.tags || {}).comment || '', date: (c.created_at || '').slice(0, 10), tool: (c.tags || {}).created_by || ''});
      };
      for (let i = 0; i < all.length; i += 4) await Promise.all(all.slice(i, i + 4).map(one));   // four at a time: kind to the API
      out.sort((a, b) => b.id - a.id);
      if (S.losses) { S.losses.list = out; S.losses.count = all.length; S.losses.loading = null; render(); }
    } catch (e) { if (S.losses) { S.losses.error = e.message; S.losses.loading = null; render(); } }
  },

  async version(t, id, v) {
    const r = await fetch(`${OSM_API}/api/0.6/${t}/${id}/${v}.json`);
    if (!r.ok) throw new Error(`${t} ${id} v${v}: OSM said ${r.status}`);
    return (await r.json()).elements[0];
  },

  /** One changeset: {deleted: [{type, id, tags, into?, lost?}], removed: [{type, id, name, removed, changed}]} */
  async audit(cs) {
    const r = await fetch(`${OSM_API}/api/0.6/changeset/${cs}/download`);
    if (!r.ok) throw new Error(`changeset ${cs}: OSM said ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const ch = [];
    for (const act of doc.documentElement.children) for (const e of act.children)
      ch.push({action: act.tagName, type: e.tagName, id: +e.getAttribute('id'), version: +e.getAttribute('version'),
        tags: Object.fromEntries([...e.querySelectorAll('tag')].map(t => [t.getAttribute('k'), t.getAttribute('v')])),
        lat: e.getAttribute('lat') != null ? +e.getAttribute('lat') : null, lon: e.getAttribute('lon') != null ? +e.getAttribute('lon') : null});
    const kept = ch.filter(e => e.action !== 'delete'), stop = t => t.highway === 'bus_stop' || ['platform', 'stop_position', 'station'].includes(t.public_transport) || t.amenity === 'bus_station';
    const deleted = [], removed = [];
    await Promise.all(ch.map(async e => {
      if (e.action === 'delete') {
        const was = await this.version(e.type, e.id, e.version - 1), t = was.tags || {};
        const d = {type: e.type, id: e.id, tags: t, by: `${was.user}, ${(was.timestamp || '').slice(0, 10)}`};
        // where it went, if anywhere: what the changeset kept of its kind close by (a stop), or of its route (a relation)
        let into = null;
        if (e.type === 'node' && stop(t)) into = kept.filter(k => k.type === 'node' && stop(k.tags) && k.lat != null).map(k => ({k, d: m([k.lon, k.lat], [was.lon, was.lat])})).sort((a, b) => a.d - b.d).find(x => x.d <= 150);
        else if (e.type === 'relation') { const k = kept.find(k => k.type === 'relation' && k.tags.ref === t.ref && k.tags.type === t.type); into = k && {k}; }
        if (into) { d.into = {type: into.k.type, id: into.k.id, name: into.k.tags.name, d: into.d, tags: into.k.tags}; d.lost = Object.fromEntries(Object.entries(t).filter(([k, v]) => into.k.tags[k] !== v)); }
        deleted.push(d);
      } else if (e.action === 'modify' && e.version > 1) {
        const t = (await this.version(e.type, e.id, e.version - 1)).tags || {};
        const gone = Object.fromEntries(Object.entries(t).filter(([k]) => !(k in e.tags)));
        const changed = Object.fromEntries(Object.entries(t).filter(([k, v]) => k in e.tags && e.tags[k] !== v).map(([k, v]) => [k, [v, e.tags[k]]]));
        if (Object.keys(gone).length || Object.keys(changed).length) removed.push({type: e.type, id: e.id, name: e.tags.name || t.name, removed: gone, changed, tags: e.tags});
      }
    }));
    return {deleted, removed};
  },

  /** What to do about a tag that went, and why: {act: 'putback' | 'onto' | 'describe', why, value?} or {none: why}.
   *  From what took it (flagstop, or a mapper by hand) and what it was. */
  verdict(it) {
    const {k, how, x, c} = it, rel = x.type === 'relation';
    if (!/^flagstop/.test(c.tool || '')) return {none: `edited by hand${c.tool ? ` (${c.tool.split(' ')[0]})` : ''}: as you meant it, presumably`};
    if (how === 'deleted with it') return {none: rel ? 'a relation deleted whole' : x.tags.highway === 'bus_stop' || x.tags.public_transport ? "the stop is gone from the agency's data; its pole's details went with it" : 'deleted whole'};
    if (it.onto) {
      const kept = (x.into.tags || {})[k];
      if (it.w === 0) return {none: /name/.test(k) ? "a service day's name: the relations it named are one now" : "the agency's feed sets this"};
      if (kept != null) return {none: `${x.into.type} ${x.into.id} has its own: ${k}=${kept}`};
      if (!rel && it.w === 2) return {none: 'it described the pole that went, not this one'};
      if (!rel) return {none: "this stop's own name and codes are the agency's"};
      return {act: 'onto', why: `only the deleted relation had it: it belongs on the one kept`};
    }
    if (it.w === 0) return {none: /name/.test(k) ? "a service day's name: the relations it named are one now" : "the agency's feed sets this"};
    if (how === 'removed') return {act: 'putback', why: 'flagstop took it off; nothing replaced it'};
    // changed
    if (/^(ref|gtfs:stop_code)$/.test(k)) return {none: "the agency's code for the stop, in place of an old one"};
    if (/^(network|operator)(:wikidata)?$/.test(k)) return {none: "the agency's current name"};
    if (k === 'route_ref') return {none: 'the routes calling there, per the timetable'};
    if (k === 'wheelchair' && it.old === 'designated' && it.now === 'yes') return {act: 'putback', why: 'designated says more than yes (a stop built for wheelchairs); flagstop only adds yes where OSM has nothing'};
    if (/name$/.test(k)) {
      if (rel) {
        // the route master's name is the local style a merge names a route by: that's no loss
        const master = ((typeof D !== 'undefined' && D && D.masters) || []).find(mm => mm.tags.ref && mm.tags.ref === (x.tags || {}).ref);
        if (master && master.tags.name === it.now) return {none: `the route master's name for it, the local style ("${master.tags.name}")`};
        return {act: 'putback', value: master && master.tags.name ? master.tags.name : it.value, why: `a mapper's name for the route${master ? `, as its route master has it` : ''}; flagstop keeps those now (this was an early upload)`};
      }
      // "On Request" in a name is a fact with a tag of its own
      if (/\bon request\b|\brequest stop\b/i.test(it.old || '') && !/\bon request\b/i.test(it.now || '') && (x.tags || {}).request_stop !== 'yes')
        return {act: 'tag', key: 'request_stop', value: 'yes', why: `the old name said "on request": buses stop there only when asked, and OSM says so with request_stop=yes (if it's still so)`};
      const num = v => +(((v || '').match(/^\d+/) || [])[0] || NaN);
      if (Math.abs(num(it.old) - num(it.now)) > 50) return {none: `the stop moved: its old landmark may not be by it now (${num(it.old)} → ${num(it.now)})`};
      // a landmark or note in the old name ("700 West 200 North - The Meadows - TIMEPOINT"): not a name, but worth keeping
      const m = (it.old || '').match(/\((.*?)\)/) || (it.old || '').match(/\s+-\s+(.*)$/);
      const mark = m && m[1].split(/\s+-\s+/).filter(w => !/^(timepoint|route\b.*|\(?\d+\)?)$/i.test(w.trim())).join(' - ').trim();
      const desc = (x.tags || {}).description || '';
      // already said in description (the agency's announcement for it, maybe spelt another way): nothing to add
      const words = t => (t || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2), dw = new Set(words(desc));
      const said = mark && words(mark).filter(w => dw.has(w) || [...dw].some(d => d.slice(0, 4) === w.slice(0, 4))).length * 2 >= words(mark).length;
      if (mark && said) return {none: `description says it already ("${desc}")`};
      if (mark && !(it.now || '').includes(mark)) return {act: 'describe', value: desc ? `${desc}; ${mark}` : mark, why: `"${mark}" isn't part of the address, but it says where the stop is: description keeps it`};
      return {none: "the agency's address for the stop"};
    }
    if (it.w === 2) return {act: 'putback', why: 'flagstop changed a fact someone surveyed; the agency\'s data says nothing about it'};
    return {none: 'flagstop\'s change, as it does now'};
  },

  /** A tag a changeset took away, back into Changes: read as OSM has the object now, and only if nobody has changed
   *  that tag since (else said, and left alone). */
  async putBack(it) {
    const v = it.v || {};
    if (v.act === 'describe') it = {...it, target: it.x, k: 'description', value: v.value, now: (it.x.tags || {}).description};
    else if (v.act === 'tag') it = {...it, target: it.x, k: v.key, value: v.value, now: (it.x.tags || {})[v.key]};
    else if (v.act === 'putback' && v.value) it = {...it, value: v.value};
    const t = it.target.type, id = it.target.id;
    const r = await fetch(`${OSM_API}/api/0.6/${t}/${id}.json`);
    if (!r.ok) return toast(`${t} ${id}: OSM said ${r.status}`, 6000);
    const o = (await r.json()).elements[0], tags = o.tags || {};
    if (!it.onto && (tags[it.k] ?? null) !== (it.now ?? null)) return toast(`${it.k} on ${t} ${id} has changed since (it's ${tags[it.k] ?? 'gone'} now): left as it is`, 8000);
    const base = {version: o.version, tags, ...(t === 'node' ? {lat: o.lat, lon: o.lon} : t === 'way' ? {nodes: o.nodes} : {members: o.members})};
    const added = v.act === 'tag' || v.act === 'describe';   // new, from what an old name said; not as it was
    const key = Edits.modify(t, id, base, {tags: {[it.k]: it.value}}, `${tags.name || `${t} ${id}`}: ${it.k} ${added ? `from its name before changeset ${it.c.id}` : `put back as it was before changeset ${it.c.id}`}`);
    Edits.ops[key][added ? 'fromOldName' : 'putBack'] = it.c.id;   // said so in the changeset comment
    Edits.save();
    toast(`${it.k}=${it.value} on ${tags.name || `${t} ${id}`}: in Changes`, 5000); render();
  },

  /** The Changes tab's section: a way to look, then what was found. */
  render(d) {
    const L = S.losses, me = Edits.auth.user();
    const box = el('div', {class: 'fixstep'}, el('div', {class: 'k'}, 'What uploads took away'),
      el('div', {class: 'muted small'}, 'Every object a mapper\'s changesets deleted, with all its tags as they were, and every tag they removed or changed on what stayed. Read from OSM; nothing is changed.'));
    const name = el('input', {value: (L && L.user) || (me && me.display_name) || '', placeholder: 'OSM user name', size: 14});
    const days = el('select', {class: 'b'}, ...[[7, 'a week'], [30, '30 days'], [90, '90 days'], [365, 'a year']].map(([v, l]) => el('option', {value: v, selected: ((L && L.days) || 30) === v ? '' : null}, l)));
    box.append(el('div', {class: 'btns'}, name, days, el('button', {class: 'b tiny', disabled: L && L.loading ? '' : null, onclick: () => name.value.trim() && this.look(name.value.trim(), +days.value)}, L && L.loading ? L.loading : 'Look')));
    if (L && L.error) box.append(el('div', {class: 'note warn'}, L.error));
    if (L && L.list) {
      const del = L.list.flatMap(c => c.deleted).filter(x => x.type !== 'node' || Object.keys(x.tags).length), lost = del.filter(x => x.lost && Object.keys(x.lost).length), whole = del.filter(x => !x.into), rem = L.list.flatMap(c => c.removed);
      box.append(el('div', {class: 'small', style: 'margin:6px 0'}, `${L.count} changeset${L.count === 1 ? '' : 's'}: ${del.length} object${del.length === 1 ? '' : 's'} deleted (${whole.length} with nothing of its kind kept by it, ${lost.length} merged with tags that didn't go across); `,
        `${rem.reduce((n, x) => n + Object.keys(x.removed).length, 0)} tags removed and ${rem.reduce((n, x) => n + Object.keys(x.changed).length, 0)} changed on what stayed.`));
      const kv = t => Object.entries(t).sort().map(([k, v]) => `${k}=${v}`).join('  ');
      const link = (t, id, label) => el('a', {href: `${OSM_WWW}/${t}/${id}/history`, target: '_blank'}, label || `${t} ${id}`);
      // every tag that went, ranked: a surveyed fact (wheelchair, hours) first, what the feed gives back anyway last
      const items = [];
      for (const c of L.list) {
        for (const x of c.deleted) {
          if (x.type === 'node' && !Object.keys(x.tags).length) continue;
          for (const [k, v] of Object.entries(x.into ? x.lost : x.tags)) items.push({c, x, k, what: `${k}=${v}`, how: x.into ? `not carried onto ${x.into.type} ${x.into.id}` : 'deleted with it', w: tagWeight(k, v, x.tags),
            ...(x.into ? {target: x.into, value: v, onto: true} : {})});
        }
        for (const x of c.removed) {
          for (const [k, v] of Object.entries(x.removed)) items.push({c, x, k, what: `${k}=${v}`, how: 'removed', w: tagWeight(k, v, {}), target: x, value: v, now: undefined});
          // a name changed only by its service day going (a merge) is low; changed otherwise, it's the new name that counts
          const bare = v => (v || '').replace(SERVICE_DAY, '').replace(/\s*[-–,]\s*$/, '').trim();
          // put back: as it was, but a name without the service day it had (the relations it named are one now)
          for (const [k, [p, n]] of Object.entries(x.changed)) items.push({c, x, k, what: `${k}: ${p} → ${n}`, how: 'changed', w: /name$/.test(k) && bare(p) !== n ? Math.max(1, tagWeight(k, n, {})) : tagWeight(k, p, {}),
            target: x, value: /name$/.test(k) && bare(p) && bare(p) !== n ? bare(p) : p, now: n, old: p});
        }
      }
      // each with what to do about it, and why: the suggestions first, the rest said and folded away
      for (const it of items) it.v = this.verdict(it);
      const head = it => [el('b', {style: it.w === 2 ? 'color:var(--miss)' : ''}, it.what), ` · ${it.how} · `, link(it.x.type, it.x.id, `${it.x.type[0]}${it.x.id}`), ` "${(it.x.tags || {}).name || it.x.name || ''}" · `,
        el('a', {href: `${OSM_WWW}/changeset/${it.c.id}`, target: '_blank'}, it.c.id), el('span', {class: 'muted'}, ` ${it.c.date} · ${WEIGHT_WORDS[it.w]}`)];
      const act = it => it.v.act === 'onto' ? `Put ${it.k}=${it.value} onto ${it.x.into.type} ${it.x.into.id}` : it.v.act === 'describe' ? `Put "${it.v.value}" in description` : it.v.act === 'tag' ? `Add ${it.v.key}=${it.v.value}` : `Put back: ${it.k}=${it.v.value || it.value}`;
      const sugg = items.filter(it => it.v.act).sort((a, b) => b.w - a.w), rest = items.filter(it => !it.v.act);
      box.append(el('details', {class: 'small', open: sugg.length ? '' : null}, el('summary', {}, el('b', {}, `Suggested: ${sugg.length}`)),
        ...(sugg.length ? sugg.map(it => el('div', {class: 'carry'}, el('div', {}, ...head(it)), el('div', {}, el('b', {}, 'Suggest: '), act(it), el('span', {class: 'muted'}, ` — ${it.v.why}`)),
          el('button', {class: 'b tiny primary', onclick: () => this.putBack(it)}, act(it)))) : [el('div', {class: 'muted'}, 'Nothing: what went, went as it should.')])));
      const why = new Map();
      const kind = t => t.replace(/\s*\(.*\)\s*$/, '').replace(/^(relation|node|way) \d+ has its own: .*/, 'what it went into has its own value');   // the reason, without its particulars
      for (const it of rest) why.set(kind(it.v.none), [...(why.get(kind(it.v.none)) || []), it]);
      box.append(el('details', {class: 'small'}, el('summary', {}, el('b', {}, `Nothing to do: ${rest.length}`), el('span', {class: 'muted'}, ' (each says why)')),
        ...[...why].sort((a, b) => Math.max(...b[1].map(x => x.w)) - Math.max(...a[1].map(x => x.w))).map(([w, its]) => el('details', {}, el('summary', {}, `${w}: ${its.length}`),
          ...its.sort((a, b) => b.w - a.w).map(it => el('div', {style: 'margin:2px 0 2px 12px'}, ...head(it), kind(it.v.none) !== it.v.none ? el('span', {class: 'muted'}, ` — ${it.v.none}`) : null, ' ', it.target && it.w ? el('button', {class: 'b tiny', title: "Not suggested, but yours to do", onclick: () => this.putBack(it)}, act(it)) : null))))));
      box.append(el('div', {class: 'k', style: 'margin-top:8px'}, 'By changeset'));
      for (const c of L.list) {
        const sec = el('details', {class: 'small'},
          el('summary', {}, el('a', {href: `${OSM_WWW}/changeset/${c.id}`, target: '_blank'}, c.id), ` ${c.date} · ${c.comment.slice(0, 90)}`,
            el('span', {class: 'muted'}, ` · ${c.deleted.length ? `${c.deleted.length} deleted` : ''}${c.deleted.length && c.removed.length ? ', ' : ''}${c.removed.length ? `${c.removed.length} retagged` : ''}`)));
        // a deleted way's points, untagged: said in one line, not one each
        const bare = c.deleted.filter(x => x.type === 'node' && !Object.keys(x.tags).length);
        if (bare.length) sec.append(el('div', {class: 'muted', style: 'margin:3px 0'}, `${bare.length} untagged point${bare.length > 1 ? 's' : ''} deleted (a deleted way's): `, ...bare.flatMap((x, i) => [i ? ', ' : '', link(x.type, x.id, `n${x.id}`)])));
        for (const x of c.deleted.filter(x => !bare.includes(x))) sec.append(el('div', {class: 'carry'},
          el('div', {}, el('b', {}, 'deleted '), link(x.type, x.id), ` "${x.tags.name || ''}"`, el('span', {class: 'muted'}, ` (last edited by ${x.by})`)),
          el('div', {class: 'mono muted'}, kv(x.tags) || '(no tags)'),
          x.into ? el('div', {}, '→ into ', link(x.into.type, x.into.id, `${x.into.type} ${x.into.id}`), ` "${x.into.name || ''}"${x.into.d != null ? `, ${Math.round(x.into.d)} m away` : ''}: `,
            Object.keys(x.lost).length ? el('span', {style: Object.entries(x.lost).some(([k, v]) => tagWeight(k, v, x.tags) === 2) ? 'color:var(--miss)' : '', class: Object.entries(x.lost).some(([k, v]) => tagWeight(k, v, x.tags) === 2) ? '' : 'muted'}, `not there: ${kv(x.lost)}`) : el('span', {style: 'color:var(--ok)'}, 'all its tags are there'))
            : el('div', {style: 'color:var(--amb)'}, 'nothing of its kind kept by this changeset nearby: all of it is gone')));
        for (const x of c.removed) sec.append(el('div', {style: 'margin:3px 0'}, link(x.type, x.id), ` "${x.name || ''}": `,
          ...Object.entries(x.removed).map(([k, v]) => el('span', {style: tagWeight(k, v, {}) === 2 ? 'color:var(--miss)' : ''}, ` −${k}=${v}`)),
          ...Object.entries(x.changed).map(([k, [a, b]]) => el('span', {}, ` ${k}: ${a} → ${b};`))));
        box.append(sec);
      }
      if (!L.list.length) box.append(el('div', {class: 'muted small'}, 'Nothing deleted, removed or changed.'));
    }
    d.append(box);
  },
};
