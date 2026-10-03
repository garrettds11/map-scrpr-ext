// Synthetic "unknown site" fixtures in common map-data shapes. Run: node test/run-generic.mjs
import assert from 'node:assert/strict';
import { routeCapture } from '../lib/route.js';

const call = (url, body, page = 'https://maps.example.org/', opts) => routeCapture({ url, method: 'GET', status: 200, body: JSON.stringify(body), page }, opts);
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok  -', name); };

t('GeoJSON FeatureCollection (points): ids, coords, native verbatim, props normalized', () => {
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 7, geometry: { type: 'Point', coordinates: [-95.37, 29.76] }, properties: { Name: 'Harbor Cafe', Phone: '(713) 555-0101', Street: '1 Main St', City: 'Springfield', State: 'TX', Zip: '77002', Website: 'https://harborcafe.example', Category: 'Cafe' } },
    { type: 'Feature', id: 8, geometry: { type: 'Point', coordinates: [-94.8, 29.3] }, properties: { Name: 'Corner Bakery' } } ] };
  const r = call('https://maps.example.org/api/pois?bbox=1,2,3,4', fc);
  assert.equal(r.records.length, 2); assert.equal(r.records[0].id, '7'); assert.equal(r.records[0].lat, 29.76); assert.equal(r.records[0].lng, -95.37);
  assert.deepEqual(r.records[0].native, fc.features[0]);
  const n = r.records[0].norm;
  assert.equal(n.name, 'Harbor Cafe'); assert.equal(n.city, 'Springfield'); assert.equal(n.region, 'TX'); assert.equal(n.postal_code, '77002');
  assert.equal(n.website, 'https://harborcafe.example'); assert.deepEqual(n.categories, ['Cafe']); assert.match(n.phone, /555/);
  assert.match(r.records[0].norm_from.name, /Name \(heuristic\)/);
});

t('GeoJSON polygon keeps original geometry; point derived as bbox centre', () => {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-90, 30], [-89, 30], [-89, 31], [-90, 31], [-90, 30]]] }, properties: { name: 'Nature Reserve' } }] };
  const r = call('https://maps.example.org/api/zones', fc);
  assert.equal(r.records[0].geometry.type, 'Polygon'); assert.equal(r.records[0].lat, 30.5); assert.equal(r.records[0].lng, -89.5);
  assert.match(r.records[0].id, /^h[0-9a-f]{16}$/); assert.equal(r.records[0].meta.id_from, 'content-hash');
});

t('wrapped list with nested location + address objects', () => {
  const body = { data: { results: [{ id: 'a1', title: 'Old Mill', location: { latitude: 17.3, longitude: -87.5 }, address: { street: '9 Elm Rd', city: 'Springfield', country: 'US' }, tags: ['food', 'historic'] }, { id: 'a2', title: 'Fox Lane', location: { latitude: 17.1, longitude: -87.2 } }] } };
  const r = call('https://maps.example.org/v2/sites/search', body);
  assert.equal(r.records.length, 2); assert.equal(r.records[0].kind, 'maps.example.org/v2/sites/search#data.results');
  assert.equal(r.records[0].norm.name, 'Old Mill'); assert.equal(r.records[0].norm.city, 'Springfield'); assert.deepEqual(r.records[0].norm.categories, ['food', 'historic']);
});

t('Leaflet-style markers with lat/lng/title', () => {
  const r = call('https://maps.example.org/markers.json', { markers: [{ lat: '40.1', lng: '-74.2', title: 'A', id: 1 }, { lat: '40.2', lng: '-74.3', title: 'B', id: 2 }] });
  assert.equal(r.records.length, 2); assert.equal(r.records[0].lat, 40.1); assert.equal(r.records[0].native.lat, '40.1');
});

t('array coordinates: [lat,lng] under "latlng", [lng,lat] under "coordinates"; ambiguity flagged', () => {
  const a = call('https://maps.example.org/a', [{ id: 1, latlng: [48.85, 2.35] }, { id: 2, latlng: [48.9, 2.4] }]);
  assert.deepEqual([a.records[0].lat, a.records[0].lng], [48.85, 2.35]);
  const b = call('https://maps.example.org/b', [{ id: 1, coordinates: [2.35, 48.85] }, { id: 2, coordinates: [2.4, 48.9] }]);
  assert.deepEqual([b.records[0].lat, b.records[0].lng], [48.85, 2.35]); assert.ok(b.records[0].meta.coord_note);
  const c = call('https://maps.example.org/c', [{ id: 1, coordinates: [-122.4, 37.8] }, { id: 2, coordinates: [-122.3, 37.7] }]);
  assert.deepEqual([c.records[0].lat, c.records[0].lng], [37.8, -122.4]); assert.equal(c.records[0].meta.coord_note, undefined);
});

t('ArcGIS FeatureServer shape {attributes, geometry:{x,y}}', () => {
  const r = call('https://gis.example.org/arcgis/rest/services/Sites/FeatureServer/0/query', { features: [{ attributes: { OBJECTID: 11, NAME: 'Statue X', TYPE: 'Statue' }, geometry: { x: -80.1, y: 25.7 } }, { attributes: { OBJECTID: 12, NAME: 'Statue Y', TYPE: 'Statue' }, geometry: { x: -80.2, y: 25.8 } }] }, 'https://gis.example.org/viewer');
  assert.equal(r.records.length, 2); assert.equal(r.records[0].id, '11'); assert.deepEqual([r.records[0].lat, r.records[0].lng], [25.7, -80.1]); assert.equal(r.records[0].norm.name, 'Statue X');
});

t('WKT point and "lat,lng" strings', () => {
  const r = call('https://maps.example.org/w', [{ id: 1, point: 'POINT(-70.5 41.2)' }, { id: 2, point: '41.3,-70.6' }]);
  assert.deepEqual([r.records[0].lat, r.records[0].lng], [41.2, -70.5]); assert.deepEqual([r.records[1].lat, r.records[1].lng], [41.3, -70.6]);
});

t('single detail object with coordinates', () => {
  const r = call('https://maps.example.org/api/place/12345', { id: 12345, name: 'Solo Store', lat: 10.5, lng: 20.5, phone: '+1 555 123 4567', email: 'hi@solo.example' });
  assert.equal(r.records.length, 1); assert.equal(r.records[0].kind, 'maps.example.org/api/place/:id'); assert.equal(r.records[0].norm.email, 'hi@solo.example');
});

t('non-map JSON is discarded unstored; learn mode archives it; login paths never are', () => {
  const junk = { user: { id: 1, plan: 'pro' }, flags: { a: true } };
  let r = call('https://maps.example.org/api/config', junk); assert.equal(r.archive, false); assert.equal(r.records.length, 0);
  r = call('https://maps.example.org/api/config', junk, undefined, { learn: true }); assert.equal(r.archive, true); assert.equal(r.records.length, 0);
  r = call('https://maps.example.org/api/auth/session', junk, undefined, { learn: true }); assert.equal(r.archive, false);
  r = call('https://maps.example.org/api/account/me', { id: 1, lat: 10, lng: 10 }); assert.equal(r.records.length, 0);
});

t('invalid / null-island / out-of-range coordinates are not treated as points', () => {
  const r = call('https://maps.example.org/bad', [{ id: 1, lat: 0, lng: 0 }, { id: 2, lat: 91, lng: 10 }, { id: 3, lat: 'x', lng: 'y' }]);
  assert.equal(r.records.length, 0);
});

t('wrapper records {data:{properties:{lat,lng}}} are found', () => {
  const body = { result: { elements: [1, 2].map((i) => ({ type: 'entry', data: { properties: { id: String(i), lat: 30 + i, lng: -97 - i, name: 'Spot ' + i } } })) } };
  const r = call('https://maps.example.org/api/locations', body);
  assert.equal(r.records.length, 2); assert.equal(r.records[0].id, '1'); assert.equal(r.records[0].norm.name, 'Spot 1');
  assert.deepEqual(r.records[0].native, body.result.elements[0]); // native = the element exactly as sent
});

t('site rule beats heuristic; normalized shape identical across sources', () => {
  const g = call('https://maps.example.org/api/pois', { features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'X' } }] }).records[0].norm;
  const places = [{ pid: 'p1', lat: 30.1, lon: -97.7, title: 'Tom &amp; Co', town: 'Austin', path: '/p/p1', tags: 'food  historic', is_verified: '1' }];
  const rec = routeCapture({ url: 'https://api.example.test/v1/places?x=1', method: 'GET', status: 200, page: 'https://example.test/', body: JSON.stringify({ places }) }).records[0];
  assert.equal(rec.source, 'example'); assert.equal(rec.kind, 'example_place');
  assert.deepEqual(Object.keys(g), Object.keys(rec.norm));
  assert.equal(rec.norm.name, 'Tom & Co'); assert.equal(rec.norm.city, 'Austin'); assert.deepEqual(rec.norm.categories, ['food', 'historic']);
  assert.equal(rec.norm.url, 'https://example.test/p/p1'); assert.equal(rec.norm.attributes.verified, true);
  assert.equal(rec.native.title, 'Tom &amp; Co'); // native untouched
});

console.log(`\n${pass} tests passed`);
