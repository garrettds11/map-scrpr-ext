// Tests for lib/join.js (details joined onto pins at export). Run: node test/run-join.mjs
import assert from 'node:assert/strict';
import { routeCapture } from '../lib/route.js';
import { planJoins, joinedNormFeatures, joinSummary } from '../lib/join.js';

const cap = (url, body, opts) => routeCapture({ url, method: 'GET', status: 200, body: JSON.stringify(body), page: 'https://maps.example.org/' }, opts).records;
const mk = (recs) => recs.map((r) => ({ ...r, key: `${r.source}:${r.kind}:${r.id}`, first_seen: 't', last_seen: 't', n_captures: 1 }));
const toFeature = (r) => ({ type: 'Feature', id: r.key, geometry: r.lat != null ? { type: 'Point', coordinates: [r.lng, r.lat] } : null, properties: { source: r.source, kind: r.kind, source_id: r.id, ...r.norm, _norm_from: r.norm_from } });
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok  -', name); };

const pins = (path, ids) => cap(`https://api.example.org/${path}`, ids.map((i) => ({ id: i, lat: 10 + (i % 50), lng: 20 + (i % 50) })));
const details = (path, ids, label) => cap(`https://api.example.org/${path}`, { results: ids.map((i) => ({ id: i, title: `${label}${i}`, types: ['x'], depth: i })) }, { details: true });

t('detail kind joins to the pin kind whose ids it overlaps; colliding ids in another kind are not used', () => {
  const recs = mk([...pins('shops/map', [1, 2, 3, 4, 5, 6]), ...pins('sites/map', [100, 101, 102, 103]), ...details('sites/list', [100, 101, 102], 'Site ')]);
  const plan = planJoins(recs);
  assert.equal(plan.size, 1);
  assert.match([...plan.values()][0], /sites\/map/);
  const f = joinedNormFeatures(recs, toFeature);
  assert.equal(f.length, 10);                                   // detail records are not emitted themselves
  const joined = f.find((x) => x.properties.source_id === '101' && /sites\/map/.test(x.properties.kind));
  assert.equal(joined.properties.name, 'Site 101'); assert.match(joined.properties._norm_from.name, /^detail:/);
  assert.deepEqual(Object.values(joined.properties.attributes.details)[0], { id: 101, title: 'Site 101', types: ['x'], depth: 101 });
  assert.equal(f.find((x) => x.properties.source_id === '103').properties.name, null);   // pin without a detail stays as is
  assert.equal(f.find((x) => /shops\/map/.test(x.properties.kind) && x.properties.source_id === '1').properties.name, null);
});

t('colliding ids: details never attach to a pin kind they do not overlap', () => {
  const recs = mk([...pins('shops/map', [1, 2, 3, 4]), ...pins('sites/map', [1, 2, 3, 4, 5, 6, 7, 8]), ...details('sites/list', [5, 6, 7, 8], 'S')]);
  assert.match([...planJoins(recs).values()][0], /sites\/map/);
});

t('no join when overlap is under half', () => {
  const recs = mk([...pins('p/map', [1, 2]), ...details('p/list', [1, 50, 51, 52], 'D')]);
  assert.equal(planJoins(recs).size, 0);
  assert.equal(joinedNormFeatures(recs, toFeature).length, 2);
  assert.deepEqual(joinSummary(recs), { detail: 4, joined: 0 });
});

t('pin values win; only empty fields are filled from a detail', () => {
  const p = mk(cap('https://api.example.org/p/map', [1, 2, 3].map((i) => ({ id: i, lat: 10 + i, lng: 20 + i, name: `Pin ${i}` }))));
  const d = mk(details('p/list', [1, 2, 3], 'D'));
  const f = joinedNormFeatures([...p, ...d], toFeature);
  assert.equal(f[0].properties.name, 'Pin 1'); assert.deepEqual(joinSummary([...p, ...d]), { detail: 3, joined: 3 });
});

console.log(`\n${pass} tests passed`);
