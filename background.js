/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
importScripts('format.js'); // waitBefore()
// Service worker: owns the recording state and listens for navigations / tab switches.
const DEFAULTS = { recording: false, paused: false, suspended: false, activeLoop: null, editingFlowId: null, editingFlowName: null, vars: [], insertAfter: null, activeWhen: null, openIfs: [], startedAt: null, stoppedAt: null, steps: [] };
// `suspended`: the extension itself is driving the page (list extraction) — don't record its navigations.
const capturing = (s) => s.recording && !s.paused && !s.suspended;

const enablePanel = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onStartup.addListener(enablePanel);
enablePanel();

// All state changes go through one queue so concurrent events never overwrite each other.
let queue = Promise.resolve();
// Insertion point: when set, new steps go right after this step (and it moves along) instead of by time.
let insertAfter = null;
// Real time from which waits between inserted steps count (set when recording starts/resumes at an insertion point).
let insertSince = 0;
let backToEndAt = 0; // ⤵ "Back to the end" while recording: the next step at the end waits only for the time since then
// ⑂ While recording "only if …": new steps get this condition.
let activeWhen = null;

function mutate(fn) {
  queue = queue.then(async () => {
    const state = await chrome.storage.local.get(DEFAULTS);
    insertAfter = state.insertAfter || null;
    activeWhen = state.recording ? state.activeWhen || null : null;
    const before = insertAfter;
    let update = await fn(state);
    if (update && 'insertAfter' in update) insertAfter = update.insertAfter;
    else if (insertAfter !== before) update = { ...(update || {}), insertAfter };
    if (update) await chrome.storage.local.set(update);
  }).catch((err) => console.error('[Action Recorder]', err));
  return queue;
}

const newId = () => crypto.randomUUID();
// The step recorded last for a tab — at the ⤵ insertion point when there is one.
const upToInsert = (steps) => {
  const at = insertAfter ? steps.findIndex((x) => x.id === insertAfter) : -1;
  return at >= 0 ? steps.slice(0, at + 1) : steps;
};
const lastFor = (steps, tabId) => [...upToInsert(steps)].reverse().find((s) => s.tabId === tabId);

function insert(steps, step) {
  step.id = step.id || newId();
  if (activeWhen && !['pause', 'loopEnd'].includes(step.type) && !step.when) step.when = { ...activeWhen };
  step.t = Math.round(step.t || Date.now());
  if (insertAfter) {
    const at = steps.findIndex((x) => x.id === insertAfter);
    if (at >= 0) {
      // Steps are inserted later than the steps around them were recorded, so their time stamps cannot be used for
      // waits: the step after the insertion point keeps its original wait, and an inserted step only waits for the
      // real time since recording (re)started here — never for the time between the recording and this edit.
      const next = steps[at + 1];
      if (next && next.type !== 'pause' && next.waitMs == null) next.waitMs = waitBefore(steps, at + 1);
      if (step.type !== 'pause' && step.waitMs == null) {
        const prev = steps[at];
        if (!insertSince || (prev.tEnd || prev.t) < insertSince) step.waitMs = insertSince ? Math.max(0, step.t - insertSince) : 0;
      }
      steps.splice(at + 1, 0, step);
      if (step.type !== 'pause') insertAfter = step.id; // the next new step goes after this one
      return steps;
    }
    insertAfter = null; // the anchor step was removed: back to normal
  }
  if (backToEndAt && step.type !== 'pause') {
    if (step.waitMs == null) step.waitMs = Math.max(0, step.t - backToEndAt);
    backToEndAt = 0;
  }
  let i = steps.length;
  while (i > 0 && steps[i - 1].t > step.t) i--;
  steps.splice(i, 0, step);
  return steps;
}

// Steps added while the recording is paused (⑂ rows, checks, requests …) go just before the pause marker, so the
// first step after Resume does not look like it waited through the pause.
function addTime(s, t) {
  if (!s.paused) return t;
  const p = [...s.steps].reverse().find((x) => x.type === 'pause' && !x.tEnd);
  return p ? p.t - 1 : t;
}

const recordable = (url) => /^(https?|file):/.test(url || '');

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!recordable(tab.url)) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['page-hooks.js'], world: 'MAIN' }).catch(() => {});
  }
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const now = Date.now();
  const steps = [];
  if (tab && recordable(tab.url)) {
    steps.push({ id: newId(), type: 'navigate', transition: 'start', t: now, tEnd: now, tabId: tab.id, url: tab.url, title: tab.title });
  }
  await mutate(() => ({ recording: true, paused: false, suspended: false, activeLoop: null, activeWhen: null, openIfs: [], editingFlowId: null, editingFlowName: null, vars: [], insertAfter: null, startedAt: now, stoppedAt: null, steps }));
  await injectIntoOpenTabs();
}

// If the user is now on a different page than the last recorded one, add a "Continue on <url>" step
// so the agent knows where the flow picks up again.
async function addContextStep(steps, now) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !recordable(tab.url)) return;
  // The page the flow is on at the insertion point (or at the end).
  const upTo = insertAfter ? steps.findIndex((x) => x.id === insertAfter) + 1 : steps.length;
  const lastUrl = steps.slice(0, upTo > 0 ? upTo : steps.length).reverse().find((x) => x.url)?.url;
  if (lastUrl === tab.url) return;
  insert(steps, { type: 'navigate', transition: 'resume', t: now + 1, tEnd: now + 1, tabId: tab.id, url: tab.url, title: tab.title });
}

const closeOpenPause = (steps, now) => {
  const p = [...steps].reverse().find((x) => x.type === 'pause' && !x.tEnd);
  if (p) p.tEnd = now;
};

function pause() {
  return mutate((s) => {
    if (!capturing(s)) return null;
    return { paused: true, steps: insert(s.steps, { type: 'pause', reason: 'paused', t: Date.now() }) };
  });
}

function resume() {
  return mutate(async (s) => {
    if (!s.recording || !s.paused) return null;
    const now = Date.now();
    closeOpenPause(s.steps, now);
    insertSince = now;
    await addContextStep(s.steps, now);
    return { paused: false, steps: s.steps };
  });
}

async function continueRecording() {
  await mutate(async (s) => {
    if (s.recording || !s.startedAt) return null;
    const now = Date.now();
    // Time between Stop and Continue counts as a pause, not as a wait (not needed when inserting in the middle).
    if (!insertAfter) insert(s.steps, { type: 'pause', reason: 'stopped', t: s.stoppedAt || now, tEnd: now });
    insertSince = now;
    await addContextStep(s.steps, now);
    return { recording: true, paused: false, stoppedAt: null, steps: s.steps };
  });
  await injectIntoOpenTabs();
}

// Replay notifications (created by the side panel): clicking one brings the replay's tab and window to the front.
// Notification ids look like "ar-<tabId>-<random>".
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const tabId = Number((/^ar-(\d+)-/.exec(id) || [])[1]);
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'start':
      start().then(() => sendResponse({ ok: true }));
      return true;
    case 'stop':
      mutate((s) => {
        if (!s.recording) return null;
        const now = Date.now();
        closeOpenPause(s.steps, now);
        // ⑂ If blocks and a "For each item" loop still open when recording stops end here.
        for (const b of [...(s.openIfs || [])].reverse()) insert(s.steps, { type: 'ifEnd', blockId: b.blockId, t: now, waitMs: 0 });
        if (s.activeLoop) insert(s.steps, { type: 'loopEnd', loopId: s.activeLoop.id, t: now });
        return { recording: false, paused: false, activeLoop: null, activeWhen: null, openIfs: [], insertAfter: null, stoppedAt: now, steps: s.steps };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'pause':
      pause().then(() => sendResponse({ ok: true }));
      return true;
    case 'resume':
      resume().then(() => sendResponse({ ok: true }));
      return true;
    case 'continue':
      continueRecording().then(() => sendResponse({ ok: true }));
      return true;
    case 'suspend':
      mutate(() => ({ suspended: !!msg.on })).then(() => sendResponse({ ok: true }));
      return true;
    case 'addStep':
      // A step produced by the side panel itself (extraction, checks, approvals).
      // While recording it goes in at its time; when a stopped recording / flow is being edited it goes at the end.
      mutate((s) => {
        if (s.recording) return { steps: insert(s.steps, { ...msg.step, t: addTime(s, msg.step.t || Date.now()) }) };
        if (!s.steps.length) return null;
        if (insertAfter) return { steps: insert(s.steps, { ...msg.step, waitMs: 0 }) }; // added while editing: no wait
        const last = Math.max(...s.steps.map((x) => x.tEnd || x.t || 0));
        return { steps: insert(s.steps, { ...msg.step, t: last + 1 }) };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'loadFlow': {
      // Open a saved flow in the Recording tab for editing.
      const f = msg.flow;
      mutate((s) => {
        if (s.recording) return null;
        const steps = convertWhens(f.steps.map((x) => ({ ...x, id: x.id || newId() }))); // old per-step conditions → If rows
        // Old password steps without a variable get one (🔒), like new recordings.
        let vars = secureVars(steps, f.vars || []);
        for (const x of steps) if (x.type === 'type' && x.sensitive && !x.value) vars = withPasswordVar(x, steps, vars);
        return {
          recording: false, paused: false, suspended: false, activeLoop: null,
          editingFlowId: f.id, editingFlowName: f.name, insertAfter: null, activeWhen: null, openIfs: [],
          startedAt: f.startedAt || f.steps[0]?.t || Date.now(), stoppedAt: f.stoppedAt || f.steps[f.steps.length - 1]?.t || Date.now(),
          steps, vars: secureVars(steps, vars),
        };
      }).then(() => sendResponse({ ok: true }));
      return true;
    }
    case 'setInsert':
      // Choose where new steps go (null = at the end) — also while recording: the next recorded steps go there.
      mutate((s) => {
        const live = s.recording && !s.paused;
        insertSince = live ? Date.now() : 0; // inserted steps only wait for the time from now on
        backToEndAt = live && insertAfter && !msg.id ? Date.now() : 0;
        return { insertAfter: msg.id || null };
      }).then(() => sendResponse({ ok: true }));
      return true;
    // ---- ⑂ If / Else if / Else / End if rows
    case 'ifOpen':
      mutate((s) => {
        const blockId = newId();
        if (s.recording) {
          // Recording: the If row goes in now; the steps recorded next belong to its first case.
          insert(s.steps, { id: blockId, type: 'ifStart', blockId, cond: msg.cond, t: addTime(s, Date.now()), waitMs: 0 });
          return { steps: s.steps, openIfs: [...(s.openIfs || []), { blockId, kind: 'if' }] };
        }
        if (!s.steps.length) return null;
        // Editing: an empty block at the ⤵ point (or at the end); new steps then go into its first case.
        let pos = insertAfter ? s.steps.findIndex((x) => x.id === insertAfter) + 1 : s.steps.length;
        if (pos <= 0) pos = s.steps.length;
        const prev = s.steps[pos - 1];
        const t = prev ? (prev.tEnd || prev.t) : Date.now();
        s.steps.splice(pos, 0, { id: blockId, type: 'ifStart', blockId, cond: msg.cond, t, waitMs: 0 }, { id: newId(), type: 'ifEnd', blockId, t, waitMs: 0 });
        insertAfter = blockId;
        return { steps: s.steps };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'ifBranch':
      // An "Else if" (msg.cond) or "Else" case.
      mutate((s) => {
        const marker = (blockId, t) => (msg.kind === 'else'
          ? { id: newId(), type: 'else', blockId, t, waitMs: 0 }
          : { id: newId(), type: 'elif', blockId, cond: msg.cond, t, waitMs: 0 });
        if (s.recording && !msg.blockId) {
          const open = [...(s.openIfs || [])];
          if (!open.length) return null;
          const top = open[open.length - 1];
          insert(s.steps, marker(top.blockId, addTime(s, Date.now())));
          open[open.length - 1] = { ...top, kind: msg.kind };
          return { steps: s.steps, openIfs: open };
        }
        // Editing: the new case goes at the end of the block (just before End if); new steps go into it.
        const end = s.steps.findIndex((x) => x.type === 'ifEnd' && x.blockId === msg.blockId);
        if (end < 0) return null;
        if (msg.kind !== 'else' && s.steps.some((x) => x.type === 'else' && x.blockId === msg.blockId)) {
          // An Else if goes before the Else.
          const els = s.steps.findIndex((x) => x.type === 'else' && x.blockId === msg.blockId);
          const m = marker(msg.blockId, s.steps[els].t);
          s.steps.splice(els, 0, m);
          insertAfter = m.id;
          return { steps: s.steps };
        }
        const prev = s.steps[end - 1];
        const m = marker(msg.blockId, prev ? (prev.tEnd || prev.t) : Date.now());
        s.steps.splice(end, 0, m);
        insertAfter = m.id;
        return { steps: s.steps };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'ifClose':
      mutate((s) => {
        const open = [...(s.openIfs || [])];
        if (!s.recording || !open.length) return null;
        const top = open.pop();
        insert(s.steps, { type: 'ifEnd', blockId: top.blockId, t: addTime(s, Date.now()), waitMs: 0 });
        return { steps: s.steps, openIfs: open };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'setWhen':
      // ⑂ Steps recorded from now on run only if … (null = end of the condition).
      mutate((s) => (s.recording ? { activeWhen: msg.when || null } : null)).then(() => sendResponse({ ok: true }));
      return true;
    case 'setVars':
      // Flow variables (defaults) of the recording / flow being edited.
      mutate((s) => ({ vars: secureVars(s.steps, msg.vars || []) })).then(() => sendResponse({ ok: true }));
      return true;
    case 'stopEditing':
      mutate(() => ({ editingFlowId: null, editingFlowName: null })).then(() => sendResponse({ ok: true }));
      return true;
    case 'moveStep':
      // Swap a step with its neighbour (skipping pause markers); times are swapped too so the order stays consistent.
      mutate((s) => {
        const i = s.steps.findIndex((x) => x.id === msg.id);
        if (i < 0 || ['pause', 'loopStart', 'loopEnd', 'ifStart', 'elif', 'else', 'ifEnd'].includes(s.steps[i].type) || s.steps[i].transition === 'start') return null;
        let j = i + (msg.dir < 0 ? -1 : 1);
        while (j >= 0 && j < s.steps.length && s.steps[j].type === 'pause') j += msg.dir < 0 ? -1 : 1;
        if (j < 0 || j >= s.steps.length) return null;
        if (s.steps[j].type === 'navigate' && s.steps[j].transition === 'start') return null; // the start page stays first
        // Keep the waits as they are: each moved step keeps its own wait, and so does the step after them.
        const after = Math.max(i, j) + 1;
        for (const k of [i, j, after]) {
          const x = s.steps[k];
          if (x && x.type !== 'pause' && x.waitMs == null) x.waitMs = waitBefore(s.steps, k);
        }
        const a = s.steps[i];
        const b = s.steps[j];
        const da = a.tEnd ? a.tEnd - a.t : null;
        const db = b.tEnd ? b.tEnd - b.t : null;
        [a.t, b.t] = [b.t, a.t];
        if (da != null) a.tEnd = a.t + da;
        if (db != null) b.tEnd = b.t + db;
        s.steps[i] = b;
        s.steps[j] = a;
        return { steps: s.steps };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'clear':
      mutate(() => ({ ...DEFAULTS })).then(() => sendResponse({ ok: true }));
      return true;
    case 'deleteStep':
      mutate((s) => {
        const target = s.steps.find((x) => x.id === msg.id);
        if (!target || target.type === 'pause' || target.type === 'loopEnd' || target.type === 'ifEnd') return null;
        if (target.type === 'ifStart') {
          // Removing an If block removes its rows; the steps inside stay as normal steps (they then always run).
          if (insertAfter && s.steps.some((x) => x.id === insertAfter && x.blockId === target.blockId && x.type !== 'ifStart')) insertAfter = null;
          if (insertAfter === target.id) insertAfter = null;
          return {
            steps: s.steps.filter((x) => !(['ifStart', 'elif', 'else', 'ifEnd'].includes(x.type) && x.blockId === target.blockId)),
            openIfs: (s.openIfs || []).filter((o) => o.blockId !== target.blockId), // removed while still open (recording)
          };
        }
        if (target.type === 'elif' || target.type === 'else') {
          // Removing an Else if / Else case removes its steps too.
          const a = s.steps.indexOf(target);
          let b = a + 1;
          while (b < s.steps.length && !(s.steps[b].blockId === target.blockId && ['elif', 'else', 'ifEnd'].includes(s.steps[b].type))) b++;
          const gone = new Set(s.steps.slice(a, b).map((x) => x.id));
          if (gone.has(insertAfter)) insertAfter = null;
          // The case was still being recorded: the open block goes back to its previous case.
          const open = (s.openIfs || []).map((o) => {
            if (o.blockId !== target.blockId) return o;
            const left = s.steps.filter((x) => !gone.has(x.id) && x.blockId === target.blockId && ['ifStart', 'elif', 'else'].includes(x.type)).at(-1);
            return { ...o, kind: left?.type === 'ifStart' ? 'if' : left?.type || 'if' };
          });
          return { steps: s.steps.filter((x) => !gone.has(x.id)), openIfs: open };
        }
        // Removing a loop removes its end marker too; the recorded steps inside it stay as normal steps.
        const steps = s.steps.filter((x) => x.id !== msg.id && !(target.type === 'loopStart' && x.type === 'loopEnd' && x.loopId === target.id));
        const update = { steps };
        if (target.type === 'loopStart' && s.activeLoop?.id === target.id) update.activeLoop = null;
        return update;
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'updateStep':
      mutate((s) => {
        const st = s.steps.find((x) => x.id === msg.id);
        if (!st) return null;
        Object.assign(st, msg.patch);
        return { steps: s.steps };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'setLoop':
      mutate(() => ({ activeLoop: msg.loop || null })).then(() => sendResponse({ ok: true }));
      return true;
    case 'note':
      mutate((s) => {
        if (!s.startedAt) return null;
        return { steps: insert(s.steps, { type: 'note', text: msg.text, t: addTime(s, Date.now()) }) };
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'step': {
      if (!sender.tab) return;
      const step = { ...msg.step, tabId: sender.tab.id, url: sender.tab.url, title: sender.tab.title };
      mutate((s) => {
        if (!capturing(s)) return null;
        let steps = s.steps;
        if (step.type === 'dblclick') {
          // A double-click also fires two clicks; fold them into the dblclick step.
          for (let k = 0; k < 2; k++) {
            let idx = -1;
            for (let j = steps.length - 1; j >= 0; j--) {
              const x = steps[j];
              if (x.type === 'click' && x.target?.selector === step.target?.selector && step.t - x.t < 800 && step.t >= x.t) { idx = j; break; }
            }
            if (idx < 0) break;
            if (insertAfter === steps[idx].id) insertAfter = steps[idx - 1]?.id || null;
            steps.splice(idx, 1);
          }
        }
        // A password typed while recording is never stored: the step gets a 🔒 variable instead, so the value can
        // be asked once (or saved on this computer) and filled in on every replay.
        const vars = withPasswordVar(step, steps, s.vars || []);
        return { steps: insert(steps, step), ...(vars !== s.vars ? { vars } : {}) };
      });
      return;
    }
  }
});

// Give a password step (typed without a variable) a 🔒 variable, e.g. {{PASSWORD}} or {{NEW_PASSWORD}}; returns the vars.
function withPasswordVar(step, steps, vars) {
  if (step.type !== 'type' || !step.sensitive || step.value) return vars;
  const label = String(step.target?.label || '');
  let name;
  if (/confirm|repeat|again|tekrar|onay/i.test(label)) {
    // "Confirm password": the same value as the password field before it
    const prev = [...steps].reverse().find((x) => x.type === 'type' && x.sensitive && /^\{\{\w+\}\}$/.test(x.value || ''));
    if (prev) name = prev.value.slice(2, -2);
  }
  if (!name) {
    const words = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    name = !words || /^(PASSWORD|PASS|PWD|SIFRE|PAROLA)$/.test(words) ? 'PASSWORD' : /PASSWORD|SIFRE|PAROLA/.test(words) ? words.slice(0, 30) : `${words.slice(0, 20)}_PASSWORD`;
  }
  step.value = `{{${name}}}`;
  if (vars.some((v) => v.name === name)) return vars.map((v) => (v.name === name ? { ...v, secret: true, value: '' } : v));
  return [...vars, { name, value: '', secret: true }];
}

// ---------- navigation ----------
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || !recordable(d.url)) return;
  mutate((s) => {
    if (!capturing(s)) return null;
    const last = lastFor(s.steps, d.tabId);
    if (last && last.type === 'navigate' && last.url === d.url && d.timeStamp - last.t < 1000) return null;
    return {
      steps: insert(s.steps, {
        type: 'navigate', transition: d.transitionType, qualifiers: d.transitionQualifiers,
        t: d.timeStamp, tabId: d.tabId, url: d.url,
      }),
    };
  });
});

chrome.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  mutate((s) => {
    if (!capturing(s)) return null;
    const nav = [...s.steps].reverse().find((x) => x.tabId === d.tabId && x.type === 'navigate' && !x.tEnd);
    if (!nav) return null;
    nav.tEnd = Math.round(d.timeStamp);
    if (tab) nav.title = tab.title;
    return { steps: s.steps };
  });
});

function onInPageNav(d) {
  if (d.frameId !== 0 || !recordable(d.url)) return;
  mutate((s) => {
    if (!capturing(s)) return null;
    const last = lastFor(s.steps, d.tabId);
    if (last && last.url === d.url && ['navigate', 'urlchange'].includes(last.type)) return null;
    return { steps: insert(s.steps, { type: 'urlchange', t: d.timeStamp, tabId: d.tabId, url: d.url }) };
  });
}
chrome.webNavigation.onHistoryStateUpdated.addListener(onInPageNav);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onInPageNav);

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !recordable(tab.url)) return;
  mutate((s) => {
    if (!capturing(s)) return null;
    const last = upToInsert(s.steps).at(-1);
    if (last && last.tabId === tabId) return null;
    return { steps: insert(s.steps, { type: 'tab', t: Date.now(), tabId, url: tab.url, title: tab.title }) };
  });
});
