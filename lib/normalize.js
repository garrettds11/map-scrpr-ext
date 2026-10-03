import { decodeEntities, nkey } from './util.js';

/**
 * Normalized layer: ONE uniform shape for any site. Always DERIVED from `native` (which is never modified),
 * so it can be recomputed ("Re-normalize") whenever these rules improve. Every filled field records where it came
 * from in `from`, so a wrong guess is visible and traceable.
 *
 * Fill order: (1) the site's declarative profile, (2) generic key-name heuristics for anything still empty.
 */
export const CORE = ['name', 'description', 'categories', 'address_text', 'street', 'city', 'region', 'postal_code', 'country', 'website', 'phone', 'email', 'image', 'url', 'rating'];

const ALIASES = {
  name: ['displayname', 'displayname1', 'name', 'title', 'businessname', 'companyname', 'shopname', 'storename', 'sitename', 'locationname', 'poiname', 'placename', 'fullname', 'organization', 'orgname'],
  description: ['description', 'summary', 'about', 'snippet', 'blurb', 'shortdescription', 'longdescription', 'desc', 'details', 'overview'],
  categories: ['categories', 'category', 'categoryname', 'type', 'types', 'kind', 'tags', 'tag', 'classification', 'subtype', 'activitytypes', 'services', 'programs', 'specialties'],
  address_text: ['fulladdress', 'formattedaddress', 'displayaddress', 'addresstext', 'addressline', 'address'],
  street: ['street', 'streetaddress', 'address1', 'addressline1', 'addr', 'street1', 'line1', 'streetname'],
  city: ['city', 'town', 'locality', 'municipality', 'addresslocality', 'cityname'],
  region: ['state', 'region', 'province', 'stateprovince', 'statecode', 'administrativearea', 'addressregion', 'stateabbr'],
  postal_code: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode', 'zip5', 'zipcode5'],
  country: ['country', 'countrycode', 'countryname', 'iso2', 'addresscountry', 'iso3'],
  website: ['website', 'web', 'websiteurl', 'homepage', 'site', 'externalurl', 'siteurl', 'companyurl'],
  phone: ['phone', 'tel', 'telephone', 'phonenumber', 'mobile', 'contactphone', 'phone1'],
  email: ['email', 'emailaddress', 'mail', 'contactemail'],
  image: ['image', 'imageurl', 'photo', 'photourl', 'thumbnail', 'thumb', 'logo', 'logourl', 'picture', 'img', 'imagesrc'],
  url: ['url', 'link', 'permalink', 'detailurl', 'pageurl', 'descriptiveurl', 'href', 'profileurl'],
  rating: ['rating', 'averagerating', 'stars', 'score', 'reviewscore'],
};
const BAD_CAT = new Set(['feature', 'point', 'featurecollection', 'polygon', 'linestring', 'multipolygon', 'multipoint', 'multilinestring']);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URLISH = /^(https?:\/\/|www\.)\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i;

const scalar = (v) => v == null || typeof v !== 'object';
const str = (v) => (typeof v === 'string' ? decodeEntities(v).trim() : typeof v === 'number' ? String(v) : '');

/** Validate/clean one candidate for a field. Returns the cleaned value or undefined. */
function clean(field, v) {
  switch (field) {
    case 'categories': {
      const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;|]/) : [];
      const out = arr.filter(scalar).map(str).filter((s) => s && !BAD_CAT.has(s.toLowerCase()));
      return out.length ? out : undefined;
    }
    case 'rating': { const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN; return Number.isFinite(n) ? n : undefined; }
    case 'email': { const s = str(v); return EMAIL.test(s) ? s : undefined; }
    case 'website': case 'url': case 'image': { const s = str(v); return s && URLISH.test(s) ? s : (s.startsWith('/') && field !== 'website' ? s : undefined); }
    case 'phone': { const s = str(v); return (s.match(/\d/g) || []).length >= 7 ? s : undefined; }
    case 'name': { const s = str(v); return s && s.length <= 200 ? s : undefined; }
    default: { if (Array.isArray(v) || !scalar(v)) return undefined; const s = str(v); return s || undefined; }
  }
}

/** Scalars (and scalar arrays) up to 2 levels deep, indexed by normalised key, shallowest first. */
function flatten(obj, maxDepth = 2) {
  const m = new Map();
  const walk = (o, path, depth) => {
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      const isScalarArr = Array.isArray(v) && v.every(scalar);
      if (scalar(v) || isScalarArr) {
        const nk = nkey(k);
        if (!m.has(nk)) m.set(nk, []);
        m.get(nk).push({ path: p, value: v, depth });
      } else if (!Array.isArray(v) && depth < maxDepth) walk(v, p, depth + 1);
    }
  };
  walk(obj, '', 0);
  for (const l of m.values()) l.sort((a, b) => a.depth - b.depth);
  return m;
}

const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function fromSpec(src, spec) {
  if (typeof spec === 'string') return { path: spec, value: getPath(src, spec) };
  const raw = getPath(src, spec.from);
  return { path: spec.from, value: raw === undefined || raw === null ? undefined : spec.map ? spec.map(raw) : raw };
}
const deepDecode = (v) => (typeof v === 'string' ? decodeEntities(v) : Array.isArray(v) ? v.map(deepDecode) : v);

/**
 * profile = { fields: { <core field>: 'native.path' | ['a','b'] | {from, map} }, attributes: { <name>: spec } }
 * Returns { norm, from }.
 */
export function normalizeRecord(native, profile) {
  const src = native && native.type === 'Feature' && native.properties && typeof native.properties === 'object'
    ? native.properties
    : native && native.attributes && typeof native.attributes === 'object' && !Array.isArray(native.attributes) && native.geometry ? { ...native.attributes } : native || {};
  const norm = {}, from = {};
  const flat = flatten(src);

  for (const f of CORE) {                                   // 1) site profile
    let specs = profile?.fields?.[f];
    if (!specs) continue;
    if (!Array.isArray(specs)) specs = [specs];
    for (const spec of specs) {
      const got = fromSpec(src, spec);
      const v = got.value === undefined ? undefined : clean(f, got.value);
      if (v !== undefined) { norm[f] = v; from[f] = got.path; break; }
    }
  }
  for (const f of CORE) {                                   // 2) generic heuristics for what is still empty
    if (f in norm) continue;
    outer: for (const alias of ALIASES[f]) {
      for (const cand of flat.get(alias) || []) {
        const v = clean(f, cand.value);
        if (v !== undefined) { norm[f] = v; from[f] = `${cand.path} (heuristic)`; break outer; }
      }
    }
  }
  const attributes = {};
  for (const [k, spec] of Object.entries(profile?.attributes || {})) {
    const got = fromSpec(src, spec);
    if (got.value !== undefined && got.value !== null && got.value !== '') { attributes[k] = deepDecode(got.value); from[`attributes.${k}`] = got.path; }
  }
  const out = {};
  for (const f of CORE) out[f] = f === 'categories' ? norm[f] || [] : norm[f] ?? null;
  out.attributes = attributes;
  return { norm: out, from };
}
