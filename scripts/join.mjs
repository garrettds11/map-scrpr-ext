#!/usr/bin/env node
// Offline join: put "details" (titles, types, ...) onto map pins by id, using files exported from the extension.
// It never makes a network request. Requires Node 18+, no dependencies.
//
//   node scripts/join.mjs --pins pins.geojson --details raw_responses.ndjson --url 'dive-sites/' [options]
//
//   --pins FILE      pins: GeoJSON (native or normalized export) or .ndjson of native objects with coordinates
//   --details FILE   details: raw-responses .ndjson (needs --url), native .ndjson, GeoJSON, or a .json file
//   --url REGEX      for raw-responses files: only use responses whose URL matches this
//   --key NAME       field holding the id in pins and details (default: id)
//   --all            keep pins that have no matching detail (default: matched pins only)
//   --out FILE       output GeoJSON (default: joined_<timestamp>.geojson next to the pins file)
//
// Output: one Feature per pin. properties = the pin's properties, plus `detail` = the matching detail object, verbatim.
// If the same id appears in several detail responses, the last one in the file wins.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findDetailSets } from '../lib/sniff.js';

function parseArgs(argv) {
  const a = { key: 'id', all: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--all') a.all = true;
    else if (['--pins', '--details', '--url', '--key', '--out'].includes(t)) a[t.slice(2)] = argv[++i];
    else if (t === '-h' || t === '--help') a.help = true;
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

const scalar = (v) => v != null && typeof v !== 'object' && v !== '';

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) if (l.trim()) yield l;
}

/** Items (objects) from a file of pins or details, whatever the container. */
async function* itemsFrom(file, { url, key }) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ndjson' || ext === '.jsonl') {
    for await (const l of lines(file)) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o && typeof o.url === 'string' && typeof o.body === 'string') {            // a raw-response line
        if (url && !url.test(o.url)) continue;
        let json; try { json = JSON.parse(o.body); } catch { continue; }
        yield* itemsFromJson(json, key);
      } else if (o && typeof o === 'object') yield o;                                   // a native record line
    }
    return;
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json && json.type === 'FeatureCollection') { for (const f of json.features || []) yield { __feature: f }; return; }
  yield* itemsFromJson(json, key);
}

function* itemsFromJson(json, key) {
  const sets = findDetailSets(json);
  for (const s of sets) yield* s.items;
  if (!sets.length) {
    if (Array.isArray(json)) { for (const x of json) if (x && typeof x === 'object' && scalar(x[key])) yield x; }
    else if (json && typeof json === 'object' && scalar(json[key])) yield json;      // a single detail response
  }
}

const idOfFeature = (f, key) => {
  const p = f.properties || {};
  const v = p[key] ?? p.source_id ?? p._capture?.source_id;
  return scalar(v) ? String(v) : null;
};

export async function join({ pins, details, url, key = 'id', all = false }) {
  // 1) details, last one wins
  const detailById = new Map();
  let detailItems = 0;
  for await (const it of itemsFrom(details, { url, key })) {
    const o = it.__feature ? { ...it.__feature.properties } : it;
    if (it.__feature) delete o._capture;
    if (!scalar(o[key])) continue;
    detailItems++;
    detailById.set(String(o[key]), o);
  }
  // 2) pins
  const features = [];
  for await (const it of itemsFrom(pins, { key })) {
    if (it.__feature) { features.push(it.__feature); continue; }
    const lat = it.latitude ?? it.lat, lng = it.longitude ?? it.lng ?? it.lon;
    if (Number.isFinite(+lat) && Number.isFinite(+lng) && lat !== null && lng !== null) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [+lng, +lat] }, properties: it });
  }
  const out = []; const used = new Set();
  for (const f of features) {
    const id = idOfFeature(f, key);
    const d = id != null ? detailById.get(id) : undefined;
    if (d) used.add(id);
    if (!d && !all) continue;
    const props = { ...(f.properties || {}) };
    delete props._capture;
    out.push({ type: 'Feature', id: f.id ?? id, geometry: f.geometry ?? null, properties: d ? { ...props, detail: d } : props });
  }
  const stats = { pins: features.length, detail_items: detailItems, detail_ids: detailById.size, matched: used.size, detail_without_pin: detailById.size - used.size, written: out.length };
  return { collection: { type: 'FeatureCollection', features: out }, stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.pins || !a.details) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(a.help ? 0 : 1); }
  const url = a.url ? new RegExp(a.url) : null;
  if (!url && /\.(ndjson|jsonl)$/i.test(a.details)) console.error('Note: no --url given; if the details file is a raw-responses export, ids from unrelated responses can collide. Use --url to select the detail responses.');
  const { collection, stats } = await join({ pins: a.pins, details: a.details, url, key: a.key, all: a.all });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const out = a.out || path.join(path.dirname(a.pins), `joined_${stamp}.geojson`);
  fs.writeFileSync(out, JSON.stringify(collection));
  console.error(`pins: ${stats.pins}  detail objects: ${stats.detail_items} (${stats.detail_ids} unique ids)`);
  console.error(`matched: ${stats.matched}  detail ids without a pin: ${stats.detail_without_pin}`);
  console.error(`wrote ${stats.written} features -> ${out}`);
  if (!stats.matched) console.error('No ids matched. Check --key, and that --url selects the detail responses (not the pin responses).');
}
