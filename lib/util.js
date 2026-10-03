export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Decode HTML entities. Used ONLY on derived/normalized values, never on native data. */
export function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const code = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[g.toLowerCase()] ?? m;
  });
}

/** Key normaliser: "Postal_Code", "postalCode", "postal-code" -> "postalcode". */
export const nkey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fast non-crypto 64-bit-ish hash (sync) for stable fallback IDs. */
export function hash16(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x85ebca6b) >>> 0; h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ---------- coordinates (DERIVED placement only; never written into native) ----------
const none = { lat: null, lng: null };
const ok = (lat, lng) => lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const LAT = new Set(['latitude', 'lat', 'ycoord', 'ycoordinate', 'latdeg']);
const LNG = new Set(['longitude', 'lng', 'lon', 'long', 'longitud', 'xcoord', 'xcoordinate', 'londeg']);
const NESTED = new Set(['geometry', 'location', 'position', 'point', 'coordinates', 'coords', 'latlng', 'latlon', 'latlong', 'lnglat', 'center', 'geo', 'geolocation', 'gps', 'geopoint', 'geocode', 'address', 'venue', 'data', 'properties']);
const LATLNG_ORDER = new Set(['latlng', 'latlon', 'latlong']);
const GEOM = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);

function fromGeometry(g) {
  if (!g || typeof g !== 'object' || !g.type) return none;
  if (g.type === 'GeometryCollection') return g.geometries?.length ? fromGeometry(g.geometries[0]) : none;
  const pts = [];
  const walk = (c) => { if (Array.isArray(c) && typeof c[0] === 'number') pts.push(c); else if (Array.isArray(c)) c.forEach(walk); };
  walk(g.coordinates);
  if (!pts.length) return none;
  let lat, lng;
  if (g.type === 'Point') [lng, lat] = pts[0];
  else {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    lng = (Math.min(...xs) + Math.max(...xs)) / 2; lat = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  return ok(lat, lng) ? { lat, lng, geometry: g } : none;
}

function parseCoordString(s) {
  let m = s.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (m) { const lng = +m[1], lat = +m[2]; return ok(lat, lng) ? { lat, lng } : null; }
  m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { let lat = +m[1], lng = +m[2]; if (Math.abs(lat) > 90) [lat, lng] = [lng, lat]; return ok(lat, lng) ? { lat, lng } : null; }
  return null;
}

/**
 * Find a point for any record shape we are likely to meet: lat/lng-like keys, GeoJSON Feature/geometry,
 * nested location objects, [lat,lng]/[lng,lat] arrays, "lat,lng" strings, WKT POINT, ArcGIS {x,y}.
 * Returns {lat,lng[,geometry][,assumed]}; `geometry` is the original GeoJSON geometry when there was one.
 */
export function pickCoords(o, depth = 0) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return none;
  if (o.type === 'Feature' && o.geometry) return fromGeometry(o.geometry);
  if (typeof o.type === 'string' && GEOM.has(o.type) && o.coordinates) return fromGeometry(o);

  let lat = null, lng = null;
  for (const k of Object.keys(o)) {
    const nk = nkey(k);
    if (LAT.has(nk) && lat === null) lat = num(o[k]);
    else if (LNG.has(nk) && lng === null) lng = num(o[k]);
  }
  if (ok(lat, lng)) return { lat, lng };
  if (depth >= 2) return none;

  for (const k of Object.keys(o)) {
    const nk = nkey(k);
    if (!NESTED.has(nk)) continue;
    const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (nk === 'geometry' && typeof v.x === 'number' && typeof v.y === 'number' && ok(v.y, v.x)) return { lat: v.y, lng: v.x };
      const r = pickCoords(v, depth + 1);
      if (r.lat != null) return r;
    } else if (Array.isArray(v) && v.length >= 2 && typeof v[0] !== 'object') {
      const a = num(v[0]), b = num(v[1]);
      if (a === null || b === null) continue;
      let la, lo, assumed;
      if (LATLNG_ORDER.has(nk)) { la = a; lo = b; }
      else if (Math.abs(a) > 90 && Math.abs(b) <= 90) { lo = a; la = b; }
      else if (Math.abs(b) > 90 && Math.abs(a) <= 90) { la = a; lo = b; }
      else { lo = a; la = b; assumed = 'array treated as [lng,lat]'; }
      if (ok(la, lo)) return assumed ? { lat: la, lng: lo, assumed } : { lat: la, lng: lo };
    } else if (typeof v === 'string') {
      const r = parseCoordString(v);
      if (r) return r;
    }
  }
  return none;
}
