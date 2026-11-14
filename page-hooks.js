/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// Runs in the page's own JavaScript world (not the isolated extension world), because only there
// can window.alert / confirm / prompt be observed. It reports each native dialog and the user's
// answer to content.js via postMessage; content.js decides whether a recording is active.
(() => {
  if (window.__actionRecorderHooks) return;
  window.__actionRecorderHooks = true;

  // During replay, the extension pre-loads the recorded answers here (a DOM attribute, so it is readable
  // synchronously from this world) and the next native dialogs are answered without being shown.
  const ATTR = 'data-action-recorder-answers';
  function takeAnswer(kind) {
    const root = document.documentElement;
    const raw = root && root.getAttribute(ATTR);
    if (!raw) return null;
    let queue;
    try { queue = JSON.parse(raw); } catch (_) { return null; }
    if (!Array.isArray(queue) || !queue.length || queue[0].kind !== kind) return null;
    const answer = queue.shift();
    if (queue.length) root.setAttribute(ATTR, JSON.stringify(queue)); else root.removeAttribute(ATTR);
    return answer;
  }

  // Requests still in flight (fetch / XHR), so a replay can wait until the page has finished loading its content.
  // Only counted here; content.js asks for the number with an "action-recorder-net" event (answered synchronously
  // through a DOM attribute). Requests open longer than 10 s (long polling, streams) are not counted.
  const pending = new Map();
  let seq = 0;
  const begin = () => { const id = ++seq; pending.set(id, Date.now()); return id; };
  const end = (id) => pending.delete(id);
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const id = begin();
      try {
        const p = origFetch.apply(this, args);
        p.then(() => end(id), () => end(id));
        return p;
      } catch (err) { end(id); throw err; }
    };
  }
  if (window.XMLHttpRequest) {
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      const id = begin();
      this.addEventListener('loadend', () => end(id), { once: true });
      try { return origSend.apply(this, args); } catch (err) { end(id); throw err; }
    };
  }
  window.addEventListener('action-recorder-net', () => {
    const now = Date.now();
    let n = 0;
    for (const [id, t] of pending) { if (now - t < 10000) n++; else if (now - t > 120000) pending.delete(id); }
    document.documentElement?.setAttribute('data-action-recorder-net', String(n));
  });

  for (const kind of ['alert', 'confirm', 'prompt']) {
    const original = window[kind];
    if (typeof original !== 'function') continue;
    window[kind] = function (...args) {
      const replayed = takeAnswer(kind);
      if (replayed) return kind === 'alert' ? undefined : replayed.result;
      const t = Date.now();
      const result = original.apply(window, args);
      try {
        window.postMessage({ __actionRecorder: 'dialog', kind, message: String(args[0] ?? ''), result, t, tEnd: Date.now() }, '*');
      } catch (_) { /* ignore */ }
      return result;
    };
  }
})();
