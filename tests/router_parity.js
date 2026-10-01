// Route each itinerary in tests/router_cases.json with web/router.js; compare with what tool/routes.py gave.
const fs = require('fs'), path = require('path');
const Router = require(path.join(__dirname, '..', 'web', 'router.js'));
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const roads = JSON.parse(fs.readFileSync(cases.roads, 'utf8'));
const g = new Router.Graph(roads);
const norm = x => JSON.parse(JSON.stringify(x));
// the same, numbers within 2e-6 (the last of six decimals rounds differently in Python and JS: 0.1 m)
const close = (a, b) => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 2e-6 * Math.max(1, Math.abs(b)) :
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => close(x, b[i])) :
  a && b && typeof a === 'object' && typeof b === 'object' ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => close(a[k], b[k])) : a === b;
let bad = 0;
for (const c of cases.patterns) {
  const js = norm(Router.routePattern(c.p, c.stopsLL, g, cases.osm_stops, cases.stop_areas, sid => cases.match[sid]));
  const py = norm(c.python);
  const same = close(js, py);
  if (!same) {
    bad++;
    for (const k of Object.keys(py)) if (!close(js[k], py[k])) {
      const a = JSON.stringify(js[k]), b = JSON.stringify(py[k]); let i = 0; while (a[i] === b[i]) i++;
      console.log(c.p.id, k, 'differs at', i, '\n  js:', a.slice(Math.max(0, i - 80), i + 120), '\n  py:', b.slice(Math.max(0, i - 80), i + 120));
    }
  } else console.log(c.p.id, 'same');
}
console.log(bad ? `${bad} differ` : 'all same');
process.exit(bad ? 1 : 0);
