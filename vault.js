/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// 🔑 Saved passwords / 🔒 secret values — kept on this computer only.
// - Values are encrypted with AES-GCM. The key is generated once, is NOT extractable and is kept in this
//   extension's IndexedDB, so the values never appear in plain text in storage, exports or backups.
// - Stored per environment (scope = environment id, or "_none" when no environment is chosen) and variable name.
// - Never part of a flow, an export (.json / Export all / environments / Markdown) or a run report.
// Anyone who can use this Windows / macOS user account and this Chrome profile can still use the saved values
// (that is the point: they are filled in automatically) — like passwords saved in the browser.
const VAULT = { DB: 'action-recorder-vault', STORE: 'keys', KEY: 'k', DATA: 'vault' };

function vaultDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT.DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(VAULT.STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let vaultKeyPromise = null;
function vaultKey() {
  if (vaultKeyPromise) return vaultKeyPromise;
  vaultKeyPromise = (async () => {
    const db = await vaultDb();
    const get = () => new Promise((res, rej) => { const r = db.transaction(VAULT.STORE).objectStore(VAULT.STORE).get(VAULT.KEY); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    let key = await get();
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await new Promise((res, rej) => { const tx = db.transaction(VAULT.STORE, 'readwrite'); tx.objectStore(VAULT.STORE).put(key, VAULT.KEY); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }
    return key;
  })();
  return vaultKeyPromise;
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const vaultScope = (envId) => envId || '_none';

async function vaultAll() { return (await chrome.storage.local.get({ [VAULT.DATA]: {} }))[VAULT.DATA]; }
// { scope: [names] } — what is saved, without the values
async function vaultIndex() {
  const all = await vaultAll();
  return Object.fromEntries(Object.entries(all).map(([sc, m]) => [sc, Object.keys(m)]));
}
async function vaultSet(envId, name, value) {
  if (!name) return;
  const key = await vaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(value)));
  const all = await vaultAll();
  const sc = vaultScope(envId);
  all[sc] = { ...(all[sc] || {}), [name]: { iv: b64(iv), ct: b64(ct), savedAt: Date.now() } };
  await chrome.storage.local.set({ [VAULT.DATA]: all });
}
async function vaultGet(envId, name) {
  const all = await vaultAll();
  const rec = all[vaultScope(envId)]?.[name];
  if (!rec) return null;
  try {
    const key = await vaultKey();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct));
    return new TextDecoder().decode(pt);
  } catch (_) {
    return null; // the key is gone (e.g. extension data cleared) — the value has to be typed again
  }
}
async function vaultDelete(envId, name) {
  const all = await vaultAll();
  const sc = vaultScope(envId);
  if (!all[sc]) return;
  delete all[sc][name];
  if (!Object.keys(all[sc]).length) delete all[sc];
  await chrome.storage.local.set({ [VAULT.DATA]: all });
}
