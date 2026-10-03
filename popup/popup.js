import { getAllRecords, countResponses, streamStore, clearAll, recordToFeature, recordToNormFeature, updateAllRecords } from '../lib/db.js';
import { normalizeFor } from '../lib/route.js';
import { joinedNormFeatures, joinSummary } from '../lib/join.js';

const $ = (id) => document.getElementById(id);
const say = (t) => { $('msg').textContent = t; };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const safeName = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 80);

function save(name, parts, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(parts, { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const byKind = (recs) => { const m = new Map(); for (const r of recs) { const k = `${r.source} · ${r.kind}`; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

// ---------- per-site enablement ----------
let origin = null;
const scriptIds = (o) => { const id = btoa(o).replace(/=/g, ''); return [`ms-hook-${id}`, `ms-bridge-${id}`]; };

async function renderSite() {
  const el = $('site');
  if (!origin) { el.innerHTML = '<span class="muted">Open a normal web page, then click the icon again.</span>'; return; }
  const { sites = {} } = await chrome.storage.local.get('sites');
  const entry = sites[origin];
  const enabled = !!(entry && entry.enabled);
  el.innerHTML = `<div><b>${origin}</b> — ${enabled ? 'enabled' : 'not enabled'}</div>`;
  if (!enabled) {
    el.innerHTML += '<button id="enable">Enable capture on this site</button><div class="muted">Asks Chrome for permission on this one site only, then reload the tab.</div>';
    $('enable').onclick = async () => {
      // permissions.request must run directly in the click handler (user gesture)
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) return say('Permission declined; nothing enabled.');
      const [hid, bid] = scriptIds(origin);
      try { await chrome.scripting.unregisterContentScripts({ ids: [hid, bid] }); } catch {}
      await chrome.scripting.registerContentScripts([
        { id: hid, matches: [`${origin}/*`], js: ['hook.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
        { id: bid, matches: [`${origin}/*`], js: ['bridge.js'], runAt: 'document_start', world: 'ISOLATED', persistAcrossSessions: true },
      ]);
      const s = (await chrome.storage.local.get('sites')).sites || {};
      s[origin] = { enabled: true, learn: false, since: new Date().toISOString() };
      await chrome.storage.local.set({ sites: s });
      say('Enabled. Reload the tab, then use the map.');
      renderSite();
    };
    return;
  }
  el.innerHTML += `<label><input type="checkbox" id="learn" ${entry.learn ? 'checked' : ''}> Learn mode: also archive every JSON response from this site (except login/account paths)</label>
    <div class="muted">Off: only responses that contain map points (or match a site rule) are kept; everything else is discarded unstored.</div>
    <button id="disable">Disable on this site</button>`;
  $('learn').onchange = async (e) => {
    const s = (await chrome.storage.local.get('sites')).sites || {};
    s[origin] = { ...(s[origin] || { enabled: true }), learn: e.target.checked };
    await chrome.storage.local.set({ sites: s });
  };
  $('disable').onclick = async () => {
    try { await chrome.scripting.unregisterContentScripts({ ids: scriptIds(origin) }); } catch {}
    try { await chrome.permissions.remove({ origins: [`${origin}/*`] }); } catch {}
    const s = (await chrome.storage.local.get('sites')).sites || {};
    delete s[origin];
    await chrome.storage.local.set({ sites: s });
    say('Disabled. Captured data is kept.'); renderSite();
  };
}

// ---------- stats / coverage ----------
function drawCoverage(recs) {
  const c = $('cov'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = '#cfd8e2';
  for (let lng = -180; lng <= 180; lng += 30) { const x = (lng + 180) / 360 * c.width; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
  for (let lat = -90; lat <= 90; lat += 30) { const y = (90 - lat) / 180 * c.height; g.beginPath(); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke(); }
  const palette = ['#d33', '#07c', '#2a2', '#c70', '#939', '#088'];
  const colors = new Map();
  g.globalAlpha = 0.7;
  for (const r of recs) {
    if (r.lat == null || r.lng == null) continue;
    if (!colors.has(r.source)) colors.set(r.source, palette[colors.size % palette.length]);
    g.fillStyle = colors.get(r.source);
    g.fillRect((r.lng + 180) / 360 * c.width - 1, (90 - r.lat) / 180 * c.height - 1, 3, 3);
  }
  g.globalAlpha = 1;
}

async function refresh() {
  const [recs, nResp, st] = await Promise.all([getAllRecords(), countResponses(), chrome.storage.local.get(['archiveBytes', 'archiveFull', 'lastError'])]);
  const tb = $('tbl').querySelector('tbody'); tb.innerHTML = '';
  for (const [k, list] of [...byKind(recs)].sort()) {
    const tr = document.createElement('tr'); tr.innerHTML = `<td>${k}</td><td class="n">${list.length}</td>`; tb.appendChild(tr);
  }
  if (!recs.length) tb.innerHTML = '<tr><td colspan="2" class="muted">Nothing captured yet — open a map page and pan around.</td></tr>';
  const noCoords = recs.filter((r) => (r.lat == null || r.lng == null) && !r.meta?.detail).length;
  const js = joinSummary(recs);
  const noNorm = recs.filter((r) => !r.norm).length;
  const mb = ((st.archiveBytes || 0) / 1048576).toFixed(1);
  $('info').textContent = `${nResp} raw responses archived (~${mb} MB) · ${noCoords} records without coordinates${js.detail ? ` · ${js.detail} detail records (${js.joined} joinable to pins by id)` : ''}${noNorm ? ` · ${noNorm} not yet normalized (use Re-normalize)` : ''}`;
  $('warn').textContent = [
    st.archiveFull ? 'Raw archive is full (300 MB): new raw responses are no longer archived; native records still are. Export, then Clear, to resume.' : '',
    st.lastError ? `Last error: ${st.lastError}` : '',
  ].filter(Boolean).join(' ');
  drawCoverage(recs);
}

// ---------- exports ----------
$('norm').onclick = async () => {
  const recs = await getAllRecords();
  const features = joinedNormFeatures(recs, recordToNormFeature);
  const js = joinSummary(recs);
  save(`normalized_${stamp()}.geojson`, [JSON.stringify({ type: 'FeatureCollection', features })]);
  say(`Exported ${features.length} normalized features from ${new Set(recs.map((r) => r.source)).size} source(s). Same property keys for every source.${js.detail ? ` ${js.joined} of ${js.detail} detail records were joined to pins by id.` : ''}`);
};
$('geo').onclick = async () => {
  const groups = byKind(await getAllRecords());
  for (const [k, list] of groups) save(`${safeName(k)}_${stamp()}.geojson`, [JSON.stringify({ type: 'FeatureCollection', features: list.map(recordToFeature) })]);
  say(`Exported ${groups.size} native GeoJSON file(s); properties are the native fields plus _capture.`);
};
$('ndjson').onclick = async () => {
  const groups = byKind(await getAllRecords());
  for (const [k, list] of groups) save(`${safeName(k)}_${stamp()}.ndjson`, list.map((r) => JSON.stringify(r.native) + '\n'), 'application/x-ndjson');
  say(`Exported ${groups.size} file(s): one native object per line.`);
};
$('raw').onclick = async () => {
  // Stream with a cursor and wrap each batch in its own Blob; Chrome keeps large Blobs on disk, so memory stays flat.
  const parts = []; let n = 0;
  await streamStore('responses', (batch) => {
    parts.push(new Blob(batch.map((x) => JSON.stringify({ ts: x.ts, method: x.method, url: x.url, status: x.status, page: x.page, via: x.via, reqBody: x.reqBody, body: x.body }) + '\n')));
    n += batch.length;
  }, 100);
  save(`raw_responses_${stamp()}.ndjson`, parts, 'application/x-ndjson');
  say(`Exported ${n} raw responses (bodies verbatim, as strings).`);
};

// ---------- maintenance ----------
$('renorm').onclick = async () => {
  const n = await updateAllRecords((r) => { const { norm, from } = normalizeFor(r); return { ...r, norm, norm_from: from }; });
  await refresh(); say(`Re-normalized ${n} records from their native data (native untouched).`);
};
$('clear').onclick = async () => {
  if (!confirm('Delete all captured data?')) return;
  await clearAll(); await chrome.storage.local.remove(['archiveBytes', 'archiveFull', 'lastError']); await chrome.action.setBadgeText({ text: '' });
  await refresh(); say('Cleared.');
};

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) origin = u.origin;
  } catch {}
  await renderSite();
  await refresh();
})();
