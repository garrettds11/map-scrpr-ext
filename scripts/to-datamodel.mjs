#!/usr/bin/env node
// Convert a normalized GeoJSON export into import-ready GeoJSON for the GeoVivé data model.
// Offline, no dependencies, Node 18+.
//
//   node scripts/to-datamodel.mjs --in normalized.geojson [options]
//
//   --in FILE             normalized GeoJSON from the extension (or the output of scripts/join.mjs)
//   --out-dir DIR         where to write (default: next to the input)
//   --source LABEL        value for the `source` property (default: the record's source host)
//   --name-fallback TPL   name for features that have none, e.g. "Place {id}" ({id} = the source id).
//                         Without it (and without a matching --name-kind), features with no name are skipped,
//                         because `name` is required.
//   --name-kind MATCH=TPL name template for features whose `kind` contains MATCH (case-insensitive); repeat it for
//                         several kinds, e.g. --name-kind "/shops/=Shop {id}" --name-kind "/sites/=Site {id}".
//                         The first match wins; --name-fallback covers the rest.
//   --include-contact     also write phone and email into the description (default: left out)
//   --max-features N      split the output into parts of at most N features (default: 20000, the import limit)
//   --max-mb N            ...and at most about N MB per part (default: 45, the import limit is 50)
//
// The data model allows only a fixed set of feature properties (name, category, description, source, externalId, ...)
// and says specifics go in `description`. So each output feature has exactly: name, category, description (Markdown:
// address, categories, links, then a short "Details" list of everything else), source and externalId. Every feature is
// category "location": events and alerts need an eventTime, which captured map data does not have.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = { name: 200, description: 5000, source: 200, externalId: 200, details: 15, detailValue: 200 };
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const scalar = (v) => v != null && typeof v !== 'object' && v !== '';
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const labelOf = (k) => { const t = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);
const fmt = (v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : clip(String(v).replace(/\s+/g, ' ').trim(), LIMITS.detailValue));

/** Short "key: value" facts from an object: scalars and lists of scalars only, skipping ids and nested data. */
function detailsFrom(o, out, seen, skipText) {
  for (const [k, v] of Object.entries(o)) {
    if (/^(id|uuid|guid|pk|_id)$/i.test(k) || seen.has(k)) continue;
    let text = null;
    if (scalar(v)) text = fmt(v);
    else if (Array.isArray(v) && v.length && v.every(scalar)) text = clip(v.map(fmt).join(', '), LIMITS.detailValue);
    if (text && skipText.has(text.toLowerCase())) continue;       // already shown as the name or categories
    if (text) { seen.add(k); out.push(`- ${labelOf(k)}: ${isUrl(text) ? `<${text}>` : text}`); }
  }
}

export function toFeature(f, opts = {}) {
  const p = f.properties || {};
  const notes = [];
  let name = typeof p.name === 'string' ? p.name.trim() : '';
  let fromFallback = false;
  if (!name) {
    const kind = String(p.kind || '').toLowerCase();
    const tpl = (opts.nameKinds || []).find((k) => kind.includes(k.match.toLowerCase()))?.template ?? opts.nameFallback;
    if (tpl) { name = tpl.replace(/\{id\}/g, String(p.source_id ?? '')).trim(); fromFallback = !!name; }
  }
  if (!name) return { skip: 'no name' };
  if (!f.geometry || !f.geometry.type) return { skip: 'no geometry' };
  if (name.length > LIMITS.name) { name = clip(name, LIMITS.name); notes.push('name'); }

  const parts = [];
  if (typeof p.description === 'string' && p.description.trim()) parts.push(p.description.trim());
  const facts = [];
  const addr = p.address_text || [p.street, p.city, [p.region, p.postal_code].filter(Boolean).join(' '), p.country].filter(Boolean).join(', ');
  if (addr) facts.push(`**Address:** ${addr}`);
  if (Array.isArray(p.categories) && p.categories.length) facts.push(`**Categories:** ${p.categories.join(', ')}`);
  if (typeof p.website === 'string' && isUrl(p.website)) facts.push(`**Website:** <${p.website}>`);
  if (typeof p.url === 'string' && isUrl(p.url)) facts.push(`**Link:** <${p.url}>`);
  if (p.rating != null && p.rating !== '') facts.push(`**Rating:** ${p.rating}`);
  if (opts.includeContact) {
    if (p.phone) facts.push(`**Phone:** ${p.phone}`);
    if (p.email) facts.push(`**Email:** ${p.email}`);
  }
  if (facts.length) parts.push(facts.join('  \n'));

  const det = [], seen = new Set();
  const skipText = new Set([name.toLowerCase(), (Array.isArray(p.categories) ? p.categories.join(', ') : '').toLowerCase()].filter(Boolean));
  const attrs = isObj(p.attributes) ? p.attributes : {};
  detailsFrom(Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'details')), det, seen, skipText);
  for (const d of Object.values(isObj(attrs.details) ? attrs.details : {})) if (isObj(d)) detailsFrom(d, det, seen, skipText);
  if (isObj(p.detail)) detailsFrom(p.detail, det, seen, skipText);      // output of scripts/join.mjs
  if (det.length) parts.push(`**Details**\n${det.slice(0, LIMITS.details).join('\n')}`);

  let description = parts.join('\n\n');
  if (description.length > LIMITS.description) { description = clip(description, LIMITS.description); notes.push('description'); }

  const props = { name, category: opts.category || 'location' };
  if (description) props.description = description;
  const source = opts.source || p.source;
  if (source) props.source = clip(String(source), LIMITS.source);
  if (p.source_id != null) props.externalId = clip(`${p.kind ? `${p.kind}:` : ''}${p.source_id}`, LIMITS.externalId);
  return { feature: { type: 'Feature', geometry: f.geometry, properties: props }, notes, fromFallback };
}

export function convert(collection, opts = {}) {
  const stats = { in: 0, written: 0, skipped_no_name: 0, skipped_no_geometry: 0, truncated_description: 0, truncated_name: 0, placeholder_names: 0 };
  const features = [];
  for (const f of collection.features || []) {
    stats.in++;
    const r = toFeature(f, opts);
    if (r.skip === 'no name') { stats.skipped_no_name++; continue; }
    if (r.skip === 'no geometry') { stats.skipped_no_geometry++; continue; }
    if (r.fromFallback) stats.placeholder_names++;
    if (r.notes.includes('description')) stats.truncated_description++;
    if (r.notes.includes('name')) stats.truncated_name++;
    features.push(r.feature); stats.written++;
  }
  return { features, stats };
}

/** Split into parts by feature count and approximate size. */
export function split(features, { maxFeatures = 20000, maxBytes = 45 * 1024 * 1024 } = {}) {
  const parts = []; let cur = [], bytes = 0;
  for (const f of features) {
    const n = Buffer.byteLength(JSON.stringify(f)) + 1;
    if (cur.length && (cur.length >= maxFeatures || bytes + n > maxBytes)) { parts.push(cur); cur = []; bytes = 0; }
    cur.push(f); bytes += n;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function parseArgs(argv) {
  const a = { 'max-features': 20000, 'max-mb': 45, nameKinds: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--include-contact') a.includeContact = true;
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t === '--name-kind') {
      const v = argv[++i] ?? ''; const eq = v.indexOf('=');
      if (eq < 1 || eq === v.length - 1) throw new Error(`--name-kind needs MATCH=TEMPLATE, got: ${v}`);
      a.nameKinds.push({ match: v.slice(0, eq), template: v.slice(eq + 1) });
    }
    else if (['--in', '--out-dir', '--source', '--name-fallback', '--max-features', '--max-mb'].includes(t)) a[t.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  if (a.help || !a.in) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(a.help ? 0 : 1); }
  const { features, stats } = convert(JSON.parse(fs.readFileSync(a.in, 'utf8')), { source: a.source, nameFallback: a['name-fallback'], nameKinds: a.nameKinds, includeContact: a.includeContact });
  const parts = split(features, { maxFeatures: +a['max-features'], maxBytes: +a['max-mb'] * 1024 * 1024 });
  const dir = a['out-dir'] || path.dirname(a.in);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  if (parts.length) fs.mkdirSync(dir, { recursive: true });
  const files = parts.map((part, i) => {
    const file = path.join(dir, `import_${stamp}${parts.length > 1 ? `_part${i + 1}of${parts.length}` : ''}.geojson`);
    fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: part })); return file;
  });
  console.error(`read ${stats.in} features -> wrote ${stats.written}`);
  if (stats.skipped_no_name) console.error(`  skipped, no name: ${stats.skipped_no_name} (use --name-fallback "Place {id}" or --name-kind to keep them)`);
  if (stats.placeholder_names) console.error(`  placeholder names used: ${stats.placeholder_names}`);
  if (stats.skipped_no_geometry) console.error(`  skipped, no geometry: ${stats.skipped_no_geometry}`);
  if (stats.truncated_description) console.error(`  descriptions cut to ${LIMITS.description} characters: ${stats.truncated_description}`);
  if (stats.truncated_name) console.error(`  names cut to ${LIMITS.name} characters: ${stats.truncated_name}`);
  for (const f of files) console.error(`  ${f}`);
  if (!files.length) console.error('Nothing written.');
}
