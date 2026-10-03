// Tests for scripts/to-datamodel.mjs with fictional fixtures. Run: node test/run-to-datamodel.mjs
import assert from 'node:assert/strict';
import { convert, split, toFeature, LIMITS } from '../scripts/to-datamodel.mjs';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok  -', name); };
const ALLOWED = new Set(['name', 'category', 'description', 'source', 'externalId']);
const pt = (n) => ({ type: 'Point', coordinates: [n % 180, (n % 80)] });
const norm = (over = {}) => ({ type: 'Feature', geometry: pt(5), properties: { source: 'maps.example.org', kind: 'api.example.org/places', source_id: '5', name: 'Harbor Cafe', description: null, categories: ['food', 'historic'], street: '1 Main St', city: 'Springfield', region: 'IL', postal_code: '62701', country: 'US', website: 'https://harbor.example', phone: '+1 555 0100', email: 'hi@harbor.example', image: null, url: null, rating: 4.5, attributes: { verified: true }, _norm_from: {}, ...over } });

t('output has only the allowed properties; category is location; description is Markdown with the facts', () => {
  const { feature } = toFeature(norm());
  assert.deepEqual(Object.keys(feature.properties).filter((k) => !ALLOWED.has(k)), []);
  assert.equal(feature.properties.category, 'location'); assert.equal(feature.properties.source, 'maps.example.org');
  assert.equal(feature.properties.externalId, 'api.example.org/places:5');
  const d = feature.properties.description;
  assert.match(d, /\*\*Address:\*\* 1 Main St, Springfield, IL 62701, US/); assert.match(d, /\*\*Categories:\*\* food, historic/);
  assert.match(d, /\*\*Website:\*\* <https:\/\/harbor\.example>/); assert.match(d, /\*\*Rating:\*\* 4\.5/); assert.match(d, /- Verified: yes/);
  assert.deepEqual(feature.geometry, pt(5));
});

t('phone and email are left out unless asked', () => {
  assert.doesNotMatch(toFeature(norm()).feature.properties.description, /555|hi@harbor/);
  const d = toFeature(norm(), { includeContact: true }).feature.properties.description;
  assert.match(d, /\*\*Phone:\*\* \+1 555 0100/); assert.match(d, /\*\*Email:\*\* hi@harbor\.example/);
});

t('no name: skipped by default, kept with --name-fallback; no geometry always skipped', () => {
  const c = { type: 'FeatureCollection', features: [norm({ name: null }), { ...norm(), geometry: null }, norm({ source_id: '9' })] };
  const a = convert(c); assert.equal(a.stats.written, 1); assert.equal(a.stats.skipped_no_name, 1); assert.equal(a.stats.skipped_no_geometry, 1);
  const b = convert(c, { nameFallback: 'Place {id}' }); assert.equal(b.stats.written, 2); assert.equal(b.features[0].properties.name, 'Place 5');
});

t('joined details become a short Details list; duplicates of name/categories and ids are dropped; nested data is skipped', () => {
  const p = { attributes: { details: { 'api.example.org/spots#results': { id: 5, title: 'Harbor Cafe', types: ['food', 'historic'], maximumDepth: 30, fish: ['cod', 'bass'], images: [{ u: 'x' }], nested: { a: 1 } } } } };
  const d = toFeature(norm(p)).feature.properties.description;
  assert.match(d, /- Maximum depth: 30/); assert.match(d, /- Fish: cod, bass/);
  assert.doesNotMatch(d, /Title|Types|Images|Nested|- Id/);
});

t('also reads a plain `detail` object (output of scripts/join.mjs)', () => {
  const f = { type: 'Feature', geometry: pt(1), properties: { id: 1, source_id: '1', name: 'Joined', detail: { depth: 12, note: 'ok' } } };
  assert.match(toFeature(f).feature.properties.description, /- Depth: 12/);
});

t('limits: details list capped, long description and name truncated', () => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, `v${i}`]));
  const d = toFeature(norm({ attributes: many })).feature.properties.description;
  assert.equal((d.match(/^- /gm) || []).length, LIMITS.details);
  const long = toFeature(norm({ description: 'x'.repeat(9000), name: 'n'.repeat(500) }));
  assert.equal(long.feature.properties.description.length, LIMITS.description); assert.equal(long.feature.properties.name.length, LIMITS.name);
  assert.ok(long.notes.includes('description') && long.notes.includes('name'));
});

t('split: by feature count and by size', () => {
  const fs_ = Array.from({ length: 25 }, (_, i) => toFeature(norm({ source_id: String(i) })).feature);
  assert.deepEqual(split(fs_, { maxFeatures: 10 }).map((p) => p.length), [10, 10, 5]);
  assert.ok(split(fs_, { maxBytes: 1500 }).length > 1);
  assert.equal(split(fs_).length, 1);
});

console.log(`\n${pass} tests passed`);
