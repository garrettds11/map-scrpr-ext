// Replays captured HAR responses through the real router/normalizer (no browser needed).
//   node test/run-har.mjs a.har [b.har ...]
// Checks: native records are verbatim copies of what the site sent; normalized view is populated and traceable.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { routeCapture } from '../lib/route.js';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node test/run-har.mjs file.har [...]'); process.exit(1); }
const recs = new Map(); let responses = 0, archiveOnly = 0, dropped = 0, mismatches = 0;
const vias = {};
const h16 = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const allObjects = (n, out = new Set()) => { if (n && typeof n === 'object') { out.add(h16(n)); for (const v of Object.values(n)) allObjects(v, out); } return out; };

for (const f of files) {
  const har = JSON.parse(fs.readFileSync(f, 'utf8')).log;
  const page = har.pages?.[0]?.title || har.entries[0]?.request.url || 'https://example.com/';
  for (const e of har.entries) {
    if (e.request.method === 'OPTIONS') continue;
    const c = e.response.content; if (!c?.text || !/json|text\/plain|javascript/.test(c.mimeType || '')) continue;
    const text = c.encoding === 'base64' ? Buffer.from(c.text, 'base64').toString('utf8') : c.text;
    if (!/^\s*[\[{]/.test(text)) continue;
    let reqBody = null;
    const pd = e.request.postData?.text;
    if (pd) { const m = pd.match(/name="request"\r?\n\r?\n([\s\S]*?)\r?\n------/); reqBody = m ? JSON.stringify({ request: m[1] }) : pd; }
    responses++;
    const res = routeCapture({ url: e.request.url, method: e.request.method, reqBody, status: e.response.status, body: text, page });
    vias[res.via] = (vias[res.via] || 0) + 1;
    if (!res.archive && !res.records.length) dropped++;
    else if (!res.records.length) archiveOnly++;
    const json = JSON.parse(text);
    const objs = allObjects(json);
    for (const r of res.records) {
      if (!objs.has(h16(r.native))) mismatches++;
      recs.set(`${r.source}:${r.kind}:${r.id}`, r);
    }
  }
}
const kinds = {}; for (const r of recs.values()) kinds[`${r.source}:${r.kind}`] = (kinds[`${r.source}:${r.kind}`] || 0) + 1;
console.log(`JSON responses replayed: ${responses}  (records: ${responses - archiveOnly - dropped}, archive-only: ${archiveOnly}, dropped unstored: ${dropped})`);
console.log('routing:', vias);
console.log('unique records by kind:', kinds);
console.log(`native != original object: ${mismatches} (expect 0)`);
for (const k of Object.keys(kinds)) {
  const r = [...recs.values()].find((x) => `${x.source}:${x.kind}` === k);
  console.log(`\n== ${k}\nnorm: ${JSON.stringify(r.norm)}\nfrom: ${JSON.stringify(r.norm_from)}`);
}
