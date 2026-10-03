import { pickCoords, nkey, hash16 } from './util.js';

// Generic "does this JSON contain map points?" detector, so an unknown site can be captured with no site-specific code.
const ID_KEYS = ['id', 'uuid', 'guid', 'pk', '_id', 'objectid', 'fid', 'placeid', 'locationid', 'siteid', 'shopid', 'storeid', 'slug'];
const MIN_FRACTION = 0.6;
const SAMPLE = 50;
const MAX_SETS = 5;
const MAX_ITEMS = 50000;

export function idOf(item) {
  if (item.type === 'Feature' && item.id != null && typeof item.id !== 'object') return { id: String(item.id), from: 'feature.id' };
  const pools = [['', item]];
  if (item.type === 'Feature' && item.properties && typeof item.properties === 'object') pools.unshift(['properties.', item.properties]);
  if (item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)) pools.push(['attributes.', item.attributes]);
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (item.type !== 'Feature' && isObj(item.data)) {
    if (isObj(item.data.properties)) pools.unshift(['data.properties.', item.data.properties]);
    else pools.unshift(['data.', item.data]);
  } else if (item.type !== 'Feature' && isObj(item.properties)) pools.unshift(['properties.', item.properties]);
  for (const [prefix, o] of pools) for (const want of ID_KEYS) for (const [k, v] of Object.entries(o)) {
    if (nkey(k) === want && v != null && typeof v !== 'object' && v !== '') return { id: String(v), from: prefix + k };
  }
  return { id: `h${hash16(JSON.stringify(item))}`, from: 'content-hash' };
}

export function pathSignature(pathname) {
  return pathname.split('/').map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? ':id' : s)).join('/');
}

export function findRecordSets(json) {
  const sets = [];
  const hasCoords = (x) => x && typeof x === 'object' && !Array.isArray(x) && pickCoords(x).lat != null;
  const visit = (v, path, depth) => {
    if (sets.length >= MAX_SETS) return;
    if (Array.isArray(v)) {
      const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length && objs.length >= v.length * 0.8) {
        const sample = objs.slice(0, SAMPLE);
        if (sample.filter(hasCoords).length / sample.length >= MIN_FRACTION) { sets.push({ path, items: objs.slice(0, MAX_ITEMS) }); return; }
      }
      if (depth < 4) objs.slice(0, 3).forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1));
    } else if (v && typeof v === 'object') {
      if ((depth === 0 || idOf(v).from !== 'content-hash') && hasCoords(v)) { sets.push({ path, items: [v] }); return; }
      if (depth < 4) for (const [k, val] of Object.entries(v)) visit(val, `${path}.${k}`, depth + 1);
    }
  };
  visit(json, '$', 0);
  return sets;
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const MIN_DETAIL = 3;

/**
 * Lists of objects that carry an id but NO coordinates: typically the "details" half of a map API (the pins arrive in
 * one response, titles/types/etc. in another). Needs >=3 items that each have an id and >=3 fields.
 */
export function findDetailSets(json) {
  const sets = [];
  const visit = (v, path, depth) => {
    if (sets.length >= MAX_SETS) return;
    if (Array.isArray(v)) {
      const objs = v.filter(isObj);
      if (objs.length >= MIN_DETAIL && objs.length >= v.length * 0.8) {
        const sample = objs.slice(0, SAMPLE);
        const ok = sample.filter((x) => Object.keys(x).length >= 3 && idOf(x).from !== 'content-hash' && pickCoords(x).lat == null).length;
        if (ok / sample.length >= MIN_FRACTION) { sets.push({ path, items: objs.slice(0, MAX_ITEMS) }); return; }
      }
      if (depth < 4) objs.slice(0, 3).forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1));
    } else if (isObj(v) && depth < 4) for (const [k, val] of Object.entries(v)) visit(val, `${path}.${k}`, depth + 1);
  };
  visit(json, '$', 0);
  return sets;
}

/** The record "source" the generic path assigns: the page's host without www. */
export const sourceFor = (pageHost, url) => (pageHost || url.hostname).replace(/^www\./, '');

/** json -> coordinate-less detail records (meta.detail = true), to be joined to pins by id at export time. */
export function sniffDetails(json, { url: u, pageHost }) {
  const source = sourceFor(pageHost, u);
  const sig = `${u.hostname}${pathSignature(u.pathname)}`;
  const out = [];
  for (const set of findDetailSets(json)) {
    const kind = `${sig}${set.path === '$' ? '' : `#${set.path.slice(2)}`}`;
    for (const item of set.items) {
      const { id, from } = idOf(item);
      out.push({ source, kind, id, native: item, lat: null, lng: null, geometry: null, meta: { id_from: from, api_host: u.hostname, detail: true } });
    }
  }
  return out;
}

/** json -> native records for an arbitrary site. `u` is the response URL object, `pageHost` the page's hostname. */
export function sniffRecords(json, { url: u, pageHost }) {
  const source = sourceFor(pageHost, u);
  const sig = `${u.hostname}${pathSignature(u.pathname)}`;
  const out = [];
  for (const set of findRecordSets(json)) {
    const kind = `${sig}${set.path === '$' ? '' : `#${set.path.slice(2)}`}`;
    for (const item of set.items) {
      const { lat, lng, geometry, assumed } = pickCoords(item);
      const { id, from } = idOf(item);
      out.push({ source, kind, id, native: item, lat, lng, geometry: geometry ?? null, meta: { id_from: from, api_host: u.hostname, ...(assumed ? { coord_note: assumed } : {}) } });
    }
  }
  return out;
}
