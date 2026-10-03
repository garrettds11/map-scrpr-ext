// Joins coordinate-less "detail" records (meta.detail) onto point records of the same source, by id.
// Pure functions (no chrome / IndexedDB) so they are Node-testable.
//
// Different endpoints can reuse the same ids (e.g. two kinds of place both numbered 1, 2, 3...), so a detail kind is
// only joined to the ONE point kind of the same source whose ids it overlaps most (at least half of the detail ids).

const hasGeometry = (r) => !!(r.geometry || (r.lat != null && r.lng != null));
const MIN_OVERLAP = 0.5;

/** Map "source|detailKind" -> "source|pinKind" for every detail kind that has a convincing pin kind. */
export function planJoins(records) {
  const pins = new Map();      // "source|kind" -> Set(ids)
  const details = new Map();   // "source|kind" -> Set(ids)
  for (const r of records) {
    const k = `${r.source}|${r.kind}`;
    if (r.meta?.detail) { if (!details.has(k)) details.set(k, new Set()); details.get(k).add(r.id); }
    else if (hasGeometry(r)) { if (!pins.has(k)) pins.set(k, new Set()); pins.get(k).add(r.id); }
  }
  const plan = new Map();
  for (const [dk, dids] of details) {
    const source = dk.split('|')[0];
    let best = null, bestN = 0;
    for (const [pk, pids] of pins) {
      if (pk.split('|')[0] !== source) continue;
      let n = 0; for (const id of dids) if (pids.has(id)) n++;
      if (n > bestN) { best = pk; bestN = n; }
    }
    if (best && bestN / dids.size >= MIN_OVERLAP) plan.set(dk, best);
  }
  return plan;
}

const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

/**
 * Normalized GeoJSON features with details merged in. Point records get any still-empty uniform field filled from
 * their joined detail (marked `detail:<field>` in _norm_from), and the whole native detail object is kept verbatim in
 * attributes.details[<detail kind>]. Detail records themselves are not emitted (they have no geometry).
 * `toFeature` is db.js's recordToNormFeature.
 */
export function joinedNormFeatures(records, toFeature) {
  const plan = planJoins(records);
  const byPin = new Map();     // "source|pinKind" -> Map(id -> [{kind, rec}])
  for (const r of records) {
    if (!r.meta?.detail) continue;
    const pk = plan.get(`${r.source}|${r.kind}`);
    if (!pk) continue;
    if (!byPin.has(pk)) byPin.set(pk, new Map());
    const m = byPin.get(pk); if (!m.has(r.id)) m.set(r.id, []);
    m.get(r.id).push(r);
  }
  const out = [];
  for (const r of records) {
    if (r.meta?.detail) continue;
    const f = toFeature(r);
    const ds = byPin.get(`${r.source}|${r.kind}`)?.get(r.id);
    if (ds) {
      const p = f.properties; p.attributes = { ...(p.attributes || {}) }; p._norm_from = { ...(p._norm_from || {}) };
      p.attributes.details = {};
      for (const d of ds) {
        p.attributes.details[d.kind] = d.native;
        for (const [k, v] of Object.entries(d.norm || {})) {
          if (k === 'attributes') { for (const [ak, av] of Object.entries(v || {})) if (!(ak in p.attributes)) p.attributes[ak] = av; continue; }
          if (empty(p[k]) && !empty(v)) { p[k] = v; p._norm_from[k] = `detail:${d.norm_from?.[k] ?? 'derived'}`; }
        }
      }
    }
    out.push(f);
  }
  return out;
}

/** How many detail records have a pin kind to join to, for the popup's summary. */
export function joinSummary(records) {
  const plan = planJoins(records);
  let detail = 0, joined = 0;
  for (const r of records) if (r.meta?.detail) { detail++; if (plan.has(`${r.source}|${r.kind}`)) joined++; }
  return { detail, joined };
}
