// Tests for scripts/join.mjs with fictional fixtures. Run: node test/run-scripts.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { join } from '../scripts/join.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscrpr-'));
const w = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok  -', name); };

const pinsGeo = w('pins.geojson', JSON.stringify({ type: 'FeatureCollection', features: [1, 2, 3, 4].map((i) => ({ type: 'Feature', id: `x:pin:${i}`, geometry: { type: 'Point', coordinates: [10 + i, 20 + i] }, properties: { id: i, latitude: 20 + i, longitude: 10 + i, _capture: { source_id: String(i) } } })) }));
const detailsFor = (ids) => ids.map((i) => ({ id: i, title: `Place ${i}`, types: ['a'], depth: i * 2 }));
const raw = (url, body) => JSON.stringify({ ts: 't', method: 'GET', url, status: 200, page: 'https://x.test/', via: null, reqBody: null, body: JSON.stringify(body) }) + '\n';

await t('raw responses: --url selects detail responses; ids joined; detail kept verbatim', async () => {
  const f = w('raw.ndjson', raw('https://api.x.test/places/list?page=1', { results: detailsFor([1, 2, 3]) }) + raw('https://api.x.test/other', { items: detailsFor([4, 9, 10]).map((d) => ({ ...d, title: 'WRONG' })) }));
  const { collection, stats } = await join({ pins: pinsGeo, details: f, url: /places\/list/ });
  assert.equal(stats.matched, 3); assert.equal(collection.features.length, 3);
  assert.deepEqual(collection.features[0].properties.detail, detailsFor([1])[0]);
  assert.equal(collection.features[0].properties._capture, undefined);
  assert.deepEqual(collection.features[0].geometry, { type: 'Point', coordinates: [11, 21] });
});

await t('last occurrence of an id wins; --all keeps unmatched pins', async () => {
  const f = w('raw2.ndjson', raw('https://api.x.test/places/list?page=1', { results: detailsFor([1, 2, 3]) }) + raw('https://api.x.test/places/list?page=2', { results: detailsFor([1, 2, 3]).map((d) => ({ ...d, title: 'newer' })) }));
  const { collection, stats } = await join({ pins: pinsGeo, details: f, url: /places/, all: true });
  assert.equal(collection.features.length, 4); assert.equal(stats.matched, 3);
  assert.equal(collection.features[0].properties.detail.title, 'newer'); assert.equal(collection.features[3].properties.detail, undefined);
});

await t('native ndjson pins and details; custom --key', async () => {
  const pins = w('pins.ndjson', [1, 2].map((i) => JSON.stringify({ code: `c${i}`, lat: 1 + i, lng: 2 + i })).join('\n'));
  const det = w('det.ndjson', [1, 2].map((i) => JSON.stringify({ code: `c${i}`, name: `N${i}` })).join('\n'));
  const { collection } = await join({ pins, details: det, key: 'code' });
  assert.equal(collection.features.length, 2); assert.equal(collection.features[1].properties.detail.name, 'N2');
});

await t('normalized pins (source_id) and a single-object detail response', async () => {
  const pins = w('norm.geojson', JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { source_id: '7', name: null } }] }));
  const f = w('one.ndjson', raw('https://api.x.test/place/7', { id: 7, title: 'Seven', extra: 1 }));
  const { collection, stats } = await join({ pins, details: f, url: /place\// });
  assert.equal(stats.matched, 1); assert.equal(collection.features[0].properties.detail.title, 'Seven');
});

await t('no matches reports zero and writes nothing for pins', async () => {
  const f = w('raw3.ndjson', raw('https://api.x.test/places/list', { results: detailsFor([50, 51, 52]) }));
  const { collection, stats } = await join({ pins: pinsGeo, details: f, url: /places/ });
  assert.equal(stats.matched, 0); assert.equal(collection.features.length, 0); assert.equal(stats.detail_without_pin, 3);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} tests passed`);
