import { SITES, siteForHost, siteBySource } from '../sites/index.js';
import { sniffRecords } from './sniff.js';
import { normalizeRecord } from './normalize.js';

// Paths that are about the user/session, not map data: never sniffed, never "learned".
const GLOBAL_SKIP = /\/(auth|oauth|login|logout|signin|token|tokens|session|sessions|account|accounts|user-?data|me|profile|password|checkout|payment|payments|billing)(\/|$|\?)/i;

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

export function normalizeFor(rec) {
  const site = siteBySource(rec.source);
  const profile = site ? site.profiles?.[rec.kind] ?? site.defaultProfile : null;
  return normalizeRecord(rec.native, profile);
}

/**
 * One captured response -> { records, archive, via }.
 *  - site registry rule matches  -> site parser (+ generic sniff if it found nothing), response archived
 *  - otherwise                   -> generic point sniffer; archived only if it found points (or `learn` is on)
 * Pure function (no chrome / IndexedDB) so it is Node-testable.
 */
export function routeCapture(msg, opts = {}) {
  const out = { records: [], archive: false, via: 'none' };
  let json;
  try { json = JSON.parse(msg.body); } catch { return out; }
  let u;
  try { u = new URL(msg.url); } catch { return out; }
  const pageHost = hostOf(msg.page);
  const site = siteForHost(u.hostname) || siteForHost(pageHost);
  const skipped = GLOBAL_SKIP.test(u.pathname);

  if (site && site.match.some((r) => r.test(msg.url)) && !(site.skip || []).some((r) => r.test(msg.url))) {
    out.archive = true; out.via = `site:${site.id}`;
    out.records = site.parse(msg.url, msg.reqBody, json) || [];
  }
  if (!out.records.length && !skipped) {
    const g = sniffRecords(json, { url: u, pageHost });
    if (g.length) { out.records = g; out.archive = true; out.via = out.via === 'none' ? 'generic' : `${out.via}+generic`; }
  }
  if (!out.archive && opts.learn && !skipped) { out.archive = true; out.via = 'learn'; }

  for (const r of out.records) { const { norm, from } = normalizeFor(r); r.norm = norm; r.norm_from = from; }
  return out;
}
