/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// Pagination loop for list extraction. Runs in the side panel (used by the Extract tab and by replay).
const EXTRACT = { MAX_ROWS: 5000, PAGE_CHANGE_TIMEOUT: 15000 };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Send a message to the top frame of a tab, retrying while the page is (re)loading.
async function pageCall(tabId, msg, timeout = 10000) {
  const end = Date.now() + timeout;
  let injected = false;
  for (;;) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
      if (res && res.ok) return res;
      if (res) throw Object.assign(new Error(res.error), { fromPage: true });
    } catch (err) {
      if (err.fromPage) throw err;
      if (!/Receiving end|message port closed|No frame|back\/forward cache/i.test(err.message)) throw err;
      if (!injected) {
        injected = true; // page was opened before the extension was (re)loaded
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
      }
      if (Date.now() > end) throw new Error('The page did not respond');
      await pause(300);
      continue;
    }
    // No answer at all (nobody handled the message): don't wait forever.
    if (Date.now() > end) throw new Error('The page did not respond');
    await pause(300);
  }
}

const rowKey = (row) => JSON.stringify(row);

// Click the Next / Load-more button and wait until the list shows something different.
async function clickNextAndWait(tabId, list, next, shouldStop = () => false, before = null) {
  if (before == null) before = (await pageCall(tabId, { type: 'list:signature', list }).catch(() => ({}))).signature || '';
  const click = await pageCall(tabId, { type: 'list:next', next });
  if (!click.clicked) return { ok: false, reason: click.reason };
  const end = Date.now() + EXTRACT.PAGE_CHANGE_TIMEOUT;
  while (Date.now() < end && !shouldStop()) {
    await pause(400);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('The tab was closed');
    if (tab.status !== 'complete') continue;
    const sig = await pageCall(tabId, { type: 'list:signature', list }).then((r) => r.signature, () => '');
    if (sig && sig !== before) { await pause(300); return { ok: true }; }
  }
  return { ok: false, reason: shouldStop() ? 'stopped' : 'the list did not change after clicking Next' };
}

/**
 * Extract every item of `spec.list` on the current page, then click `spec.next` and repeat
 * until the button disappears / is disabled, the page stops changing, or `spec.maxPages` is reached.
 */
async function extractAll(tabId, spec, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const rows = [];
  const seen = new Set();
  let fields = spec.fields;
  let pages = 0;
  let stopReason = '';
  const maxPages = spec.next ? Math.max(1, spec.maxPages || 20) : 1;

  for (;;) {
    const page = await pageCall(tabId, { type: 'list:page', list: spec.list, fields });
    fields = fields || page.fields;
    pages++;
    let added = 0;
    for (const r of page.rows) {
      const k = rowKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(r);
      added++;
    }
    onProgress({ pages, rows: rows.length });

    if (pages > 1 && added === 0) { stopReason = 'page repeated the previous items'; break; }
    if (rows.length >= EXTRACT.MAX_ROWS) { stopReason = `limit of ${EXTRACT.MAX_ROWS} items reached`; break; }
    if (!spec.next) { stopReason = 'no pagination'; break; }
    if (pages >= maxPages) { stopReason = `page limit (${maxPages}) reached`; break; }
    if (shouldStop()) { stopReason = 'stopped'; break; }

    const moved = await clickNextAndWait(tabId, spec.list, spec.next, shouldStop, page.signature);
    if (!moved.ok) { stopReason = moved.reason; break; }
    await pause(300); // let late rendering settle
  }
  return { fields: fields.map((f) => f.name), fieldSpecs: fields, rows, pages, stopReason };
}

// ---------- output formats ----------
function toCSV(fields, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [fields.map(esc).join(','), ...rows.map((r) => fields.map((f) => esc(r[f])).join(','))].join('\r\n');
}
