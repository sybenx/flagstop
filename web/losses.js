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
        if (r.deleted.length || r.removed.length) out.push({...r, id: c.id, comment: (c.tags || {}).comment || '', date: (c.created_at || '').slice(0, 10)});
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
        if (into) { d.into = {type: into.k.type, id: into.k.id, name: into.k.tags.name, d: into.d}; d.lost = Object.fromEntries(Object.entries(t).filter(([k, v]) => into.k.tags[k] !== v)); }
        deleted.push(d);
      } else if (e.action === 'modify' && e.version > 1) {
        const t = (await this.version(e.type, e.id, e.version - 1)).tags || {};
        const gone = Object.fromEntries(Object.entries(t).filter(([k]) => !(k in e.tags)));
        const changed = Object.fromEntries(Object.entries(t).filter(([k, v]) => k in e.tags && e.tags[k] !== v).map(([k, v]) => [k, [v, e.tags[k]]]));
        if (Object.keys(gone).length || Object.keys(changed).length) removed.push({type: e.type, id: e.id, name: e.tags.name || t.name, removed: gone, changed});
      }
    }));
    return {deleted, removed};
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
      for (const c of L.list) {
        const sec = el('details', {class: 'small', open: c.deleted.some(x => !x.into || (x.lost && Object.keys(x.lost).length)) || c.removed.some(x => Object.keys(x.removed).length) ? '' : null},
          el('summary', {}, el('a', {href: `${OSM_WWW}/changeset/${c.id}`, target: '_blank'}, c.id), ` ${c.date} · ${c.comment.slice(0, 90)}`,
            el('span', {class: 'muted'}, ` · ${c.deleted.length ? `${c.deleted.length} deleted` : ''}${c.deleted.length && c.removed.length ? ', ' : ''}${c.removed.length ? `${c.removed.length} retagged` : ''}`)));
        // a deleted way's points, untagged: said in one line, not one each
        const bare = c.deleted.filter(x => x.type === 'node' && !Object.keys(x.tags).length);
        if (bare.length) sec.append(el('div', {class: 'muted', style: 'margin:3px 0'}, `${bare.length} untagged point${bare.length > 1 ? 's' : ''} deleted (a deleted way's): `, ...bare.flatMap((x, i) => [i ? ', ' : '', link(x.type, x.id, `n${x.id}`)])));
        for (const x of c.deleted.filter(x => !bare.includes(x))) sec.append(el('div', {class: 'carry'},
          el('div', {}, el('b', {}, 'deleted '), link(x.type, x.id), ` "${x.tags.name || ''}"`, el('span', {class: 'muted'}, ` (last edited by ${x.by})`)),
          el('div', {class: 'mono muted'}, kv(x.tags) || '(no tags)'),
          x.into ? el('div', {}, '→ into ', link(x.into.type, x.into.id, `${x.into.type} ${x.into.id}`), ` "${x.into.name || ''}"${x.into.d != null ? `, ${Math.round(x.into.d)} m away` : ''}: `,
            Object.keys(x.lost).length ? el('span', {style: 'color:var(--miss)'}, `not there: ${kv(x.lost)}`) : el('span', {style: 'color:var(--ok)'}, 'all its tags are there'))
            : el('div', {style: 'color:var(--amb)'}, 'nothing of its kind kept by this changeset nearby: all of it is gone')));
        for (const x of c.removed) sec.append(el('div', {style: 'margin:3px 0'}, link(x.type, x.id), ` "${x.name || ''}": `,
          ...Object.entries(x.removed).map(([k, v]) => el('span', {style: 'color:var(--miss)'}, ` −${k}=${v}`)),
          ...Object.entries(x.changed).map(([k, [a, b]]) => el('span', {}, ` ${k}: ${a} → ${b};`))));
        box.append(sec);
      }
      if (!L.list.length) box.append(el('div', {class: 'muted small'}, 'Nothing deleted, removed or changed.'));
    }
    d.append(box);
  },
};
