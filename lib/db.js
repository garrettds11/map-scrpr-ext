// IndexedDB shared by background.js (writes) and the popup (reads/export).
//   responses: every archived HTTP response, verbatim (lossless), deduped by SHA-256 of method+url+request+body
//   records:   one per source/kind/id: `native` exactly as sent (latest wins) + DERIVED fields (lat/lng, geometry, norm)
const DB_NAME = 'map_scrpr';
const DB_VERSION = 3;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const old of ['features', 'raw']) if (db.objectStoreNames.contains(old)) db.deleteObjectStore(old); // v1 schema
      if (!db.objectStoreNames.contains('records')) {
        const rs = db.createObjectStore('records', { keyPath: 'key' });
        rs.createIndex('kind', 'kind'); rs.createIndex('source', 'source');
      } else if (!req.transaction.objectStore('records').indexNames.contains('source')) {
        req.transaction.objectStore('records').createIndex('source', 'source');   // v2 -> v3: lets the worker ask "does this source have records yet?" cheaply
      }
      if (!db.objectStoreNames.contains('responses')) db.createObjectStore('responses', { keyPath: 'hash' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Store a response verbatim. Returns false if an identical one is already archived. */
export async function addResponse(r) {
  const hash = await sha256(`${r.method}\n${r.url}\n${r.reqBody ?? ''}\n${r.body ?? ''}`);
  const db = await openDb();
  const tx = db.transaction('responses', 'readwrite');
  const store = tx.objectStore('responses');
  const exists = await reqP(store.getKey(hash));
  if (exists === undefined) store.put({ hash, ts: new Date().toISOString(), url: r.url, method: r.method, status: r.status, page: r.page, via: r.via ?? null, reqBody: r.reqBody ?? null, body: r.body });
  await done(tx); db.close();
  return exists === undefined;
}

export async function putRecords(records) {
  const db = await openDb();
  const tx = db.transaction('records', 'readwrite');
  const store = tx.objectStore('records');
  const now = new Date().toISOString();
  for (const r of records) {
    const key = `${r.source}:${r.kind}:${r.id}`;
    const old = await reqP(store.get(key));
    store.put({
      key, source: r.source, kind: r.kind, id: r.id,
      native: r.native,                                                  // untouched, latest capture
      lat: r.lat ?? old?.lat ?? null, lng: r.lng ?? old?.lng ?? null,    // derived (placement only)
      geometry: r.geometry ?? old?.geometry ?? null,                     // original GeoJSON geometry if the source had one
      norm: r.norm ?? old?.norm ?? null, norm_from: r.norm_from ?? old?.norm_from ?? null,   // derived, recomputable
      meta: r.meta,
      first_seen: old?.first_seen ?? now, last_seen: now, n_captures: (old?.n_captures ?? 0) + 1,
    });
  }
  await done(tx); db.close();
}

const all = async (store) => { const db = await openDb(); const v = await reqP(db.transaction(store).objectStore(store).getAll()); db.close(); return v; };
export const getAllRecords = () => all('records');
export async function countResponses() { const db = await openDb(); const n = await reqP(db.transaction('responses').objectStore('responses').count()); db.close(); return n; }
export async function countBySource(source) { const db = await openDb(); const n = await reqP(db.transaction('records').objectStore('records').index('source').count(IDBKeyRange.only(source))); db.close(); return n; }
export async function countRecords() { const db = await openDb(); const n = await reqP(db.transaction('records').objectStore('records').count()); db.close(); return n; }

/** Walk a store with a cursor in batches so callers never hold the whole table in memory. */
export async function streamStore(storeName, onBatch, batchSize = 200) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName);
    let batch = [];
    const req = tx.objectStore(storeName).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { batch.push(cur.value); if (batch.length >= batchSize) { onBatch(batch); batch = []; } cur.continue(); }
      else { if (batch.length) onBatch(batch); resolve(); }
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
}

/** Rewrite every record through fn (used to re-derive `norm` without touching `native`). */
export async function updateAllRecords(fn) {
  const db = await openDb();
  let n = 0;
  await new Promise((res, rej) => {
    const tx = db.transaction('records', 'readwrite');
    const req = tx.objectStore('records').openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { c.update(fn(c.value)); n++; c.continue(); } };
    tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
  db.close();
  return n;
}

export async function clearAll() {
  const db = await openDb(); const tx = db.transaction(['records', 'responses'], 'readwrite');
  tx.objectStore('records').clear(); tx.objectStore('responses').clear(); await done(tx); db.close();
}

const geometryOf = (r) => (r.geometry ? r.geometry : r.lat != null && r.lng != null ? { type: 'Point', coordinates: [r.lng, r.lat] } : null);

/** NATIVE GeoJSON: properties = native fields verbatim + one added key `_capture`. */
export function recordToFeature(r) {
  const props = r.native && r.native.type === 'Feature' && r.native.properties ? r.native.properties : r.native;
  return { type: 'Feature', id: r.key, geometry: geometryOf(r), properties: { ...props, _capture: { source: r.source, kind: r.kind, source_id: r.id, first_seen: r.first_seen, last_seen: r.last_seen, n_captures: r.n_captures, ...r.meta } } };
}

/** NORMALIZED GeoJSON: identical property keys for every source, so any site's records load into one dataset. */
export function recordToNormFeature(r) {
  const n = r.norm || {};
  return {
    type: 'Feature', id: r.key, geometry: geometryOf(r),
    properties: { source: r.source, kind: r.kind, source_id: r.id, ...n, first_seen: r.first_seen, last_seen: r.last_seen, _norm_from: r.norm_from || {} },
  };
}
