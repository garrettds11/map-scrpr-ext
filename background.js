import { routeCapture } from './lib/route.js';
import { sourceFor } from './lib/sniff.js';
import { addResponse, putRecords, countRecords, countBySource } from './lib/db.js';

// Soft cap on the raw-response archive (characters ~ bytes). Past it, new raw responses are no longer
// archived, but native records keep being captured. Export + Clear resets it.
const ARCHIVE_BUDGET = 300 * 1024 * 1024;

let queue = Promise.resolve();
const hasRecords = new Set();   // sources already known to have records (avoids a lookup per response)

async function setBadge() {
  const { lastError, archiveFull } = await chrome.storage.local.get(['lastError', 'archiveFull']);
  if (lastError) { await chrome.action.setBadgeBackgroundColor({ color: '#c00' }); await chrome.action.setBadgeText({ text: '!' }); return; }
  const n = await countRecords();
  await chrome.action.setBadgeBackgroundColor({ color: archiveFull ? '#d80' : '#555' });
  await chrome.action.setBadgeText({ text: n > 0 ? (n > 9999 ? '9k+' : String(n)) : '' });
}

async function noteError(text) {
  await chrome.storage.local.set({ lastError: `${new Date().toISOString()} ${text}`.slice(0, 500) });
  try { await setBadge(); } catch {}
}

async function handleCapture(msg) {
  if (msg.body == null) { await noteError(`response too large to capture (${msg.oversize ?? '?'} chars): ${msg.url}`); return; }

  let origin = '';
  try { origin = new URL(msg.page).origin; } catch {}
  const { sites = {} } = await chrome.storage.local.get('sites');

  // Decide what this response is. Anything that is neither a known site rule, nor contains map points,
  // nor on a site in learn mode is dropped here without ever being stored.
  // Coordinate-less lists of items with ids ("details") are only kept once this source already has records, so
  // sites that show no map data never get anything written (other than in Learn mode).
  let details = false;
  try {
    const src = sourceFor(new URL(msg.page).hostname, new URL(msg.url));
    details = hasRecords.has(src) || (await countBySource(src)) > 0;
    if (details) hasRecords.add(src);
  } catch {}
  const res = routeCapture(msg, { learn: !!sites[origin]?.learn, details });
  if (!res.archive && !res.records.length) return;

  // 1) lossless raw archive, within budget
  const { archiveBytes = 0 } = await chrome.storage.local.get('archiveBytes');
  if (archiveBytes < ARCHIVE_BUDGET) {
    if (await addResponse({ ...msg, via: res.via })) await chrome.storage.local.set({ archiveBytes: archiveBytes + msg.body.length + (msg.reqBody?.length ?? 0) + (msg.url?.length ?? 0) });
  } else {
    await chrome.storage.local.set({ archiveFull: true });
  }
  // 2) native records (+ derived normalized view)
  if (res.records.length) await putRecords(res.records);
  await setBadge();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'capture') return;
  queue = queue.then(() => handleCapture(msg)).catch((e) => noteError(`${e?.name || 'Error'}: ${e?.message || e}`));
});
