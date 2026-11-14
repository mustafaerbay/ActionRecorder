/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// Replays a saved flow. Runs inside the side panel, so a replay lives as long as the panel is open.
// Each page action is sent to content.js in the right tab/frame; navigation and tabs are handled here.
const REPLAY = {
  ELEMENT_TIMEOUT: 15000, // how long to wait for an element (or a modal) to appear
  NAV_TIMEOUT: 10000,     // how long to wait for a click to cause the recorded page change
  LOAD_TIMEOUT: 30000,
  STEP_DELAY: 300,        // small pause between steps so pages can react
  CHECK_TIMEOUT: 12000,   // how long a check waits for its text to (dis)appear / the area to finish loading
};

const DIRECT_NAV = ['typed', 'auto_bookmark', 'generated', 'keyword', 'start_page', 'start', 'resume'];

class ManualStep extends Error {}
class CheckFailed extends Error {} // a failed check in "continue and report" mode
class Rejected extends Error {}    // the user rejected a ⏸ approval step
class NotOnPage extends Error {}   // an optional step whose element is not on the page: skipped, not failed

// How long an optional step waits for its element (seconds).
const optionalWait = (step) => Math.max(1, Number(step.optionalWait) || 3) * 1000;

// Make sure a (variable-filled) URL is a real web address. "wiki.example.com/x" gets https:// added;
// anything else that is not http(s)/file (e.g. "asd") is an error instead of opening a broken page.
function webUrl(raw, original) {
  const u = String(raw || '').trim();
  const hint = /\{\{/.test(original || '') ? ` — check the value of ${(original.match(VAR_RE) || []).join(', ')}` : '';
  if (/^(https?|file):\/\//i.test(u)) return u;
  if (/^[\w.-]+:\d+([/?#].*)?$/.test(u)) { // host:port without a scheme
    return `${/^(localhost|\d{1,3}(\.\d{1,3}){3})(:|$)/.test(u) ? 'http' : 'https'}://${u}`;
  }
  if (/^[a-z][\w+.-]*:/i.test(u)) throw new Error(`"${u}" is not a web address (only http, https and file)${hint}`);
  if (/^\d{1,3}(\.\d{1,3}){3}([/?#].*)?$/.test(u)) return `http://${u}`;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(u)) return `https://${u}`;
  throw new Error(`"${u}" is not a web address${hint}`);
}

class Replayer {
  constructor(flow, { recordedWaits = false, debug = false, vars = {}, secrets = [], envName = '' } = {}, onChange = () => {}) {
    this.flow = flow;
    // How long to wait for an element / the page to be ready (per flow: slow systems can use more).
    this.elementTimeout = Math.max(5, Number(flow.elementTimeout) || REPLAY.ELEMENT_TIMEOUT / 1000) * 1000;
    this.vars = { ...vars };   // variable values for this run (environment + flow defaults + what the user typed)
    this.secretNames = new Set([...(flow.vars || []).filter((v) => v.secret).map((v) => v.name), ...secrets, ...passwordVars(flow.steps)]);
    this.envName = envName;
    this.recordedWaits = recordedWaits;
    // Debug mode: pause before steps (all of them while stepping, otherwise only at breakpoints).
    this.debug = debug;
    this.stepping = debug;
    this.breakpoints = new Set(flow.breakpoints || []);
    this.onChange = onChange;
    // Pause markers are not steps; work out the waits before dropping them.
    this.steps = [];
    this.gaps = [];
    flow.steps.forEach((s, i) => {
      if (s.type === 'pause') return;
      this.steps.push(s);
      this.gaps.push(waitBefore(flow.steps, i));
    });
    this.results = this.steps.map(() => ({ status: 'pending', msg: '' }));
    this.index = 0;
    this.status = 'idle'; // running | waiting | failed | done | stopped
    this.message = '';
    this.tabMap = new Map(); // recorded tabId -> live tabId
    this.newTabs = [];       // tabs opened during replay, not yet matched to a recorded tab
    this.commits = new Map(); // live tabId -> { t, url } of last main-frame navigation
    this.decide = null;
    this.extracted = []; // data from "extract" steps: { title, fields, rows }
    this.checks = new Map(); // step index (or "index#item") -> { step, passed, text, url, at, item }
    this.tests = new Map();  // 🧪 test steps: step index (or "index#item") -> { step, passed, details: [{ cond, ok, detail }], item }
    this.loopCtx = null;     // while a "For each item" loop runs: { list, index, key, no, onFail, listUrl }
    this.itemTabs = [];      // tabs opened while handling the current loop item
    this.loopResults = [];   // one entry per loop: { title, rows }

    this.onCreated = (tab) => {
      this.newTabs.push(tab.id);
      if (this.loopCtx) this.itemTabs.push(tab.id);
    };
    this.onCommitted = (d) => { if (d.frameId === 0) this.commits.set(d.tabId, { t: Date.now(), url: d.url }); };
    // Pages that could not be opened at all (server down, unknown address, certificate error …).
    this.navErrors = new Map(); // live tabId -> { t, error, url }
    this.onNavError = (d) => {
      if (d.frameId === 0 && !/ERR_ABORTED/.test(d.error)) this.navErrors.set(d.tabId, { t: Date.now(), error: d.error, url: d.url });
    };
  }

  set(status, message = '') {
    this.status = status;
    this.message = message;
    this.onChange(this);
  }

  mark(i, status, msg = '') {
    this.results[i] = { status, msg };
    this.onChange(this);
  }

  // ↩ While the run waits (a failed step, a step for you to do, a debug pause) you can go back and run again from an
  // earlier step: one that is not inside a "For each item" loop, and not an Else if / Else / End if row.
  canGoBack(k) {
    if (!this.decide || this.loopCtx || !['failed', 'waiting', 'paused'].includes(this.status)) return false;
    if (k < 0 || k >= this.index || ['elif', 'else', 'ifEnd', 'loopEnd'].includes(this.steps[k].type)) return false;
    for (let j = k - 1; j >= 0; j--) {
      if (this.steps[j].type === 'loopEnd') break;
      if (this.steps[j].type === 'loopStart') return false;
    }
    return true;
  }

  goBack(k) {
    if (!this.canGoBack(k)) return false;
    this.backTo = k;
    this.answer('back');
    return true;
  }

  // Continue from the chosen earlier step: it and the steps after it run again.
  rewind(i) {
    const k = this.backTo;
    this.backTo = null;
    for (let j = k; j <= Math.max(i, this.index); j++) this.mark(j, 'pending');
    this.index = k;
    this.jumpedTo = null;
    this.skipTo = null;
    this.set('running', `Running again from step ${k + 1}`);
  }

  toggleBreakpoint(stepId) {
    if (this.breakpoints.has(stepId)) this.breakpoints.delete(stepId); else this.breakpoints.add(stepId);
    this.onChange(this);
    return [...this.breakpoints];
  }

  // Debug pause point before step k. Returns 'run' | 'skip' | 'stop'.
  async gate(k) {
    if (!this.debug || this.stopped) return 'run';
    const s = this.steps[k];
    if (!this.stepping && !this.breakpoints.has(s.id)) return 'run';
    const prev = this.results[k];
    this.mark(k, 'paused', prev.status === 'pending' ? '' : prev.msg);
    const where = this.loopCtx ? ` — item ${this.loopCtx.no}: ${this.loopCtx.key}` : '';
    const reason = this.breakpoints.has(s.id) && !this.stepping ? '● Breakpoint: ' : '';
    const ask = this.ask('paused', `${reason}paused before step ${k + 1}${where}`);
    this.highlight(k, `${reason}paused before step ${k + 1}${where}`); // show the element this step will use
    const choice = await ask;
    if (choice === 'stop') { this.stopped = true; return 'stop'; }
    if (choice === 'back') return 'back';
    if (choice === 'resume') this.stepping = false;
    if (choice === 'step' || choice === 'skip') this.stepping = true;
    this.mark(k, 'pending');
    return choice === 'skip' ? 'skip' : 'run';
  }

  // While paused: outline the element (or check area / list) the next step will use.
  async highlight(k, base) {
    const s = this.steps[k];
    const tabId = (await this.tabFor(s).catch(() => null)) || this.mainTab;
    if (!tabId || !(s.target || s.check?.scope || s.loop || s.fill)) return;
    const r = await chrome.tabs.sendMessage(tabId, {
      type: 'debug:show', step: s,
      loop: this.loopCtx ? { list: this.loopCtx.list, index: this.loopCtx.index, key: this.loopCtx.key } : null,
    }, { frameId: 0 }).catch(() => null);
    if (this.status !== 'paused' || this.message !== base) return; // the user already moved on
    if (r) this.set('paused', `${base} · ${r.found ? `${r.what} highlighted on the page ✓` : `⚠ ${r.what} not found on the page yet`}`);
  }

  // A skipped optional step (e.g. a click on a "Continue" button that is not there) did not open a page, so the
  // "Page opens" / "URL changes" steps recorded right after it are not expected either. Returns the last index skipped.
  skipNavAfter(i) {
    let k = i;
    const t0 = this.steps[i].t || 0;
    while (k + 1 < this.steps.length) {
      const n = this.steps[k + 1];
      const caused = ['navigate', 'urlchange'].includes(n.type) && !DIRECT_NAV.includes(n.transition) && !n.optional && (n.t || 0) - t0 < 5000;
      if (!caused) break;
      k++;
      this.mark(k, 'off', 'not expected — the optional step before it was skipped');
    }
    return k;
  }

  // ⑂ "Only if" condition of a step: null = run it, otherwise the reason it is not needed.
  // Consecutive steps with the same condition form a block that is decided once, at its first step (the page
  // changes while the block runs — e.g. "Sign in" disappears after logging in). An "else" block recorded with
  // Else is the opposite of its "if" block when that one was decided in this run.
  condVars() {
    return { ...this.vars, ...(this.loopCtx ? { item: this.loopCtx.key, index: String(this.loopCtx.no) } : {}) };
  }
  async condOff(step, i) {
    const w = step.when;
    if (!isWhen(w)) { this.condBlock = null; return null; }
    const scope = this.loopCtx ? `#${this.loopCtx.no}` : '';
    const key = JSON.stringify(w) + scope;
    if (this.condBlock && this.condBlock.key === key && (this.condBlock.last === i - 1 || this.condBlock.last === i)) {
      this.condBlock.last = i;
      return this.condBlock.off;
    }
    // condGroups: block id -> true once one of its cases (if / else if) has run
    this.condGroups = this.condGroups || new Map();
    const gkey = w.group ? w.group + scope : null;
    const decided = gkey && this.condGroups.has(gkey);
    let ok;
    let detail = '';
    if (whenSource(w) === 'else' || (w.branch === 'else' && decided)) {
      ok = decided ? !this.condGroups.get(gkey) : true;
      detail = ok ? 'no case above ran' : 'a case above already ran';
    } else if (w.branch === 'elif' && decided && this.condGroups.get(gkey)) {
      ok = false;
      detail = 'a case above already ran';
    } else {
      ({ ok, detail } = await this.evalCondition(w, step));
      if (gkey && w.branch !== 'else') this.condGroups.set(gkey, (this.condGroups.get(gkey) || false) || ok);
    }
    const off = ok ? null : `not needed — ${whenText(w)}: no (${detail})`;
    this.condBlock = { key, last: i, off, detail };
    return off;
  }
  // Evaluate a condition (variable / page text / page URL) now. Returns { ok, detail }.
  async evalCondition(w, step) {
    const src = whenSource(w);
    const page = {};
    if (src === 'page' || src === 'url') {
      const tabId = (await this.tabFor(step).catch(() => null)) || this.mainTab;
      if (tabId) {
        const end = Date.now() + 5000;
        let tab = await chrome.tabs.get(tabId).catch(() => null);
        while (tab && tab.status !== 'complete' && Date.now() < end && !this.stopped) { await this.sleep(200); tab = await chrome.tabs.get(tabId).catch(() => null); }
        page.url = tab?.url || '';
        if (src === 'page') {
          const r = await pageCall(tabId, { type: 'check:cond', value: this.resolve({ value: w.value }).value, timeout: 4000 }, 9000).catch(() => null);
          page.found = !!r?.found;
        }
      }
    }
    const r = evalWhen(src === 'var' ? w : { ...w, value: this.resolve({ value: w.value }).value }, this.condVars(), page);
    const detail = src === 'page' ? `the text is ${r.actual}` : src === 'url' ? `the URL is ${page.url || 'unknown'}`
      : `it is ${!r.known ? 'not set' : this.secretNames.has(w.var) ? '••••' : `"${r.actual}"`}`;
    return { ok: r.ok, detail };
  }

  // ⑂ If blocks: called when the replay reaches a marker row. `byJump`: we came here because an earlier case was
  // false (not by finishing the steps of a case). Marks the rows / skipped steps and returns the next index.
  nextBranch(k) {
    const id = this.steps[k].blockId;
    for (let j = k + 1; j < this.steps.length; j++) {
      const x = this.steps[j];
      if (x.blockId === id && ['elif', 'else', 'ifEnd'].includes(x.type)) return j;
    }
    return this.steps.length;
  }
  blockEnd(k) {
    const id = this.steps[k].blockId;
    for (let j = k + 1; j < this.steps.length; j++) if (this.steps[j].type === 'ifEnd' && this.steps[j].blockId === id) return j;
    return this.steps.length;
  }
  skipRange(a, b, why) { for (let j = a; j < b; j++) this.mark(j, 'off', why); }
  async branch(k, byJump) {
    const s = this.steps[k];
    if (s.type === 'ifEnd') { this.mark(k, 'done'); return k + 1; }
    if (!byJump && (s.type === 'elif' || s.type === 'else')) {
      // The case above ran: the rest of the block is not needed.
      const e = this.blockEnd(k);
      this.skipRange(k, e, 'not needed — a case above ran');
      return e;
    }
    if (s.type === 'else') { this.mark(k, 'done', 'none of the cases above was true'); return k + 1; }
    const { ok, detail } = await this.evalCondition(s.cond || {}, s);
    if (ok) { this.mark(k, 'done', `${condText(s.cond)}: yes`); return k + 1; }
    const n = this.nextBranch(k);
    this.mark(k, 'done', `${condText(s.cond)}: no (${detail})`);
    this.skipRange(k + 1, n, 'not needed — its case is false');
    this.jumpedTo = n;
    return n;
  }

  condNote(step, note) {
    if (!isWhen(step.when)) return note || '';
    return `⑂ ${whenText(step.when)}: yes${note ? ` · ${note}` : ''}`;
  }

  // Replace {{NAME}} placeholders in a step's values (never in selectors).
  // Value of {{name}} for this run (loops add {{item}} / {{index}}).
  varValue(name) {
    if (name === 'item' || name === 'index') {
      if (!this.loopCtx) throw new Error(`{{${name}}} can only be used inside a "For each item" loop`);
      return String(name === 'item' ? this.loopCtx.key : this.loopCtx.no);
    }
    if (!(name in this.vars) || this.vars[name] == null) throw new Error(`Variable {{${name}}} has no value`);
    return String(this.vars[name]);
  }

  resolve(step) {
    const sub = (v) => (typeof v !== 'string' ? v : v.replace(VAR_RE, (_, name) => {
      if (name === 'item' || name === 'index') {
        if (!this.loopCtx) throw new Error(`{{${name}}} can only be used inside a "For each item" loop`);
        return String(name === 'item' ? this.loopCtx.key : this.loopCtx.no);
      }
      if (!(name in this.vars) || this.vars[name] == null) throw new Error(`Variable {{${name}}} has no value`);
      return String(this.vars[name]);
    }));
    const r = { ...step };
    for (const k of ['value', 'url', 'key', 'text', 'result']) if (typeof r[k] === 'string') r[k] = sub(r[k]);
    if (r.check) r.check = { ...r.check, keywords: r.check.keywords.map(sub) };
    return r;
  }

  // Called by the panel buttons: 'continue' | 'retry' | 'skip' | 'stop' | debug: 'step' | 'resume'
  // | approval: 'approve' | 'reject' | input: 'ok' (with the typed value)
  answer(choice, value) {
    this.inputValue = value;
    if (choice === 'stop') this.stopped = true;
    if (this.decide) {
      const d = this.decide;
      this.decide = null;
      if (choice !== 'stop') this.set('running', 'Running…'); // hide the pause buttons right away
      d(choice);
    }
  }

  // A step failed: ask Retry / Skip / Stop — or, with "If a step fails: stop the run", end the run right away
  // so the report and the "After the run" requests go out without anybody answering.
  failed(message, k) {
    if (this.flow.onStepFail === 'stop') {
      this.failStopAt = k + 1;
      this.stopped = true;
      return Promise.resolve('stop');
    }
    const hint = (this.flow.after || []).length ? ' — the "After the run" requests are sent when the run ends (press Skip or Stop)' : '';
    return this.ask('failed', message + hint).then((choice) => {
      if (choice === 'stop') { this.failStopAt = k + 1; this.userStopped = true; } // stopped because of the failure: the result is FAILED, not STOPPED
      return choice;
    });
  }

  ask(status, message) {
    const answered = new Promise((resolve) => { this.decide = resolve; }); // before set(): the panel shows what can be answered
    this.set(status, message);
    return answered;
  }

  async run() {
    this.startedAt = Date.now();
    chrome.tabs.onCreated.addListener(this.onCreated);
    chrome.webNavigation.onCommitted.addListener(this.onCommitted);
    chrome.webNavigation.onErrorOccurred.addListener(this.onNavError);
    try {
      try {
      while (this.index < this.steps.length && !this.stopped) {
        const i = this.index;
        const step = this.steps[i];
        const gap = this.gaps[i];
        if (this.recordedWaits && gap >= WAIT_MS && gap < LONG_IDLE_MS) {
          this.set('running', `Waiting ${fmtDur(gap)} (as recorded)`);
          await this.sleep(gap);
          if (this.stopped) break;
        }
        if (isIfMarker(step)) {
          const byJump = this.jumpedTo === i;
          this.jumpedTo = null;
          try {
            this.index = await this.branch(i, byJump);
          } catch (err) {
            if (this.stopped) break;
            this.mark(i, 'failed', err.message);
            const choice = await this.failed(err.message, i);
            if (choice === 'stop') break;
            if (choice === 'back') { this.rewind(i); continue; }
            if (choice === 'skip') { const e = this.blockEnd(i); this.skipRange(i, e, 'skipped'); this.index = e; }
          }
          continue;
        }
        const g = await this.gate(i);
        if (g === 'stop' || this.stopped) break;
        if (g === 'back') { this.rewind(i); continue; }
        if (g === 'skip') {
          this.mark(i, 'skipped', 'skipped in debug mode');
          const endIdx = step.type === 'loopStart' ? this.steps.findIndex((x, k) => k > i && x.type === 'loopEnd' && x.loopId === step.id) : -1;
          this.index = endIdx >= 0 ? endIdx + 1 : this.index + 1;
          continue;
        }
        let off;
        try { off = await this.condOff(step, i); } catch (err) { off = null; this.mark(i, 'failed', err.message); }
        if (off) {
          this.mark(i, 'off', off);
          const endIdx = step.type === 'loopStart' ? this.steps.findIndex((x, k) => k > i && x.type === 'loopEnd' && x.loopId === step.id) : -1;
          if (endIdx >= 0) for (let k = i + 1; k <= endIdx; k++) this.mark(k, 'off', 'the loop did not run (condition)');
          this.index = endIdx >= 0 ? endIdx + 1 : this.index + 1;
          continue;
        }
        this.mark(i, 'running');
        this.set('running', `Step ${i + 1} of ${this.steps.length}`);
        try {
          const note = await this.exec(step, i);
          this.mark(i, 'done', this.condNote(step, note));
          this.index = this.skipTo ?? this.index + 1; // a loop jumps past its own steps
          this.skipTo = null;
        } catch (err) {
          if (this.stopped) break;
          if (err instanceof Rejected) {
            this.mark(i, 'failed', `✗ ${err.message}`);
            this.rejectedAt = i + 1;
            this.stopped = true;
            break;
          }
          if (err instanceof NotOnPage) {
            this.mark(i, 'off', err.message);
            this.index = this.skipNavAfter(i) + 1; // the page change this step would have caused is not expected either
            if (!this.stopped) await this.sleep(REPLAY.STEP_DELAY);
            continue;
          }
          if (err instanceof CheckFailed) {
            this.mark(i, 'failed', err.message);
            this.index++;
            if (!this.stopped) await this.sleep(REPLAY.STEP_DELAY);
            continue;
          }
          const manual = err instanceof ManualStep;
          this.mark(i, manual ? 'waiting' : 'failed', err.message);
          const choice = manual ? await this.ask('waiting', err.message) : await this.failed(err.message, i);
          if (choice === 'stop') break;
          if (choice === 'back') { this.rewind(i); continue; }
          if (choice === 'continue') { this.mark(i, 'done', 'done by you'); this.index++; }
          if (choice === 'skip') {
            this.mark(i, 'skipped');
            // Skipping a loop skips everything inside it.
            const endIdx = step.type === 'loopStart' ? this.steps.findIndex((x, k) => k > i && x.type === 'loopEnd' && x.loopId === step.id) : -1;
            this.index = endIdx >= 0 ? endIdx + 1 : this.index + 1;
          }
          // 'retry' leaves the index where it is
        }
        if (!this.stopped) await this.sleep(REPLAY.STEP_DELAY);
      }
      } catch (err) {
        // Something unexpected (not a step failure): still finish the run, report it and send the "After the run" requests.
        this.crashed = `step ${this.index + 1}: ${err?.message || err}`;
        if (this.results[this.index]) this.mark(this.index, 'failed', err?.message || String(err));
      }
      this.endedAt = Date.now(); // before the final status, so listeners (chains, reports) see it
      let final;
      let msg;
      let outcome;
      if (this.rejectedAt || (this.stopped && !this.failStopAt)) {
        final = 'stopped';
        msg = this.rejectedAt ? `Replay stopped — rejected at step ${this.rejectedAt}` : 'Replay stopped';
        outcome = 'STOPPED';
      } else {
        const real = this.results.filter((r, k) => !isIfMarker(this.steps[k])); // ⑂ rows are not actions
        const done = real.filter((r) => r.status === 'done').length;
        const n = this.checks.size;
        const passed = [...this.checks.values()].filter((c) => c.passed).length;
        const off = real.filter((r) => r.status === 'off').length;
        final = 'done';
        msg = (this.failStopAt ? `Replay stopped — step ${this.failStopAt} failed · ` : this.crashed ? `Replay ended by an error at ${this.crashed} · ` : '') +
          `${this.failStopAt || this.crashed ? '' : 'Replay finished — '}${done} of ${real.length} steps done` + (off ? ` (${off} not needed)` : '') +
          (n ? ` · checks: ${passed} passed, ${n - passed} failed` : '') + this.testSummary(' · test steps: ') +
          this.loopResults.map((L) => ` · loop: ${L.rows.length} items, ${L.rows.filter((r) => r.result === 'PASS').length} passed`).join('');
        const failedItems = this.loopResults.some((L) => L.rows.some((r) => r.result !== 'PASS'));
        const testFailed = [...this.tests.values()].some((t) => !t.passed);
        outcome = this.failStopAt || this.crashed || real.some((r) => r.status === 'failed') || passed < n || failedItems || testFailed ? 'FAILED' : 'PASSED';
      }
      this.outcome = outcome;
      msg += await this.afterRun(outcome, msg);
      this.endedAt = Date.now();
      this.set(final, msg);
    } finally {
      this.endedAt = this.endedAt || Date.now();
      chrome.tabs.onCreated.removeListener(this.onCreated);
      chrome.webNavigation.onCommitted.removeListener(this.onCommitted);
      chrome.webNavigation.onErrorOccurred.removeListener(this.onNavError);
      this.onChange(this);
    }
  }

  stop() { this.answer('stop'); this.stopped = true; }

  checkCount() { return this.checks.size + this.loopResults.length; }

  // ---------- "For each item" loops ----------
  async listKeys(tabId, list, timeout = 10000) {
    const r = await pageCall(tabId, { type: 'loop:items', list, timeout }, timeout + 2000);
    return r.items;
  }

  async runLoop(i) {
    const start = this.steps[i];
    const L = start.loop;
    let end = this.steps.findIndex((x, k) => k > i && x.type === 'loopEnd' && x.loopId === start.id);
    if (end < 0) end = this.steps.length;
    const body = [];
    for (let k = i + 1; k < end; k++) body.push(k);
    const tabId = (await this.tabFor(start)) || this.mainTab;
    if (!tabId) throw new Error('No tab with the list');
    const listUrl = (await chrome.tabs.get(tabId)).url;
    const sameUrl = (a, b) => (a || '').split('#')[0] === (b || '').split('#')[0];
    const recordedListUrl = start.url;
    const maxItems = L.maxItems || 100;
    const maxPages = L.next ? (L.maxPages || 20) : 1;
    const rows = [];
    const seen = new Set();
    let pageNo = 1;
    let pageUrl = listUrl;
    const summary = () => {
      const ok = rows.filter((r) => r.result === 'PASS').length;
      return `${rows.length} items: ${ok} passed, ${rows.length - ok} failed`;
    };

    try {
      pages: for (;;) {
        const items = await this.listKeys(tabId, L.list);
        for (let n = 0; n < items.length; n++) {
          const it = items[n];
          if (this.stopped || rows.length >= maxItems) break pages;
          if (seen.has(it.key)) continue; // e.g. "Load more" keeps the earlier items
          seen.add(it.key);
          const no = rows.length + 1;
          this.loopCtx = { list: L.list, index: it.index, key: it.key, no, onFail: L.onFail || 'continue', listUrl };
          this.itemTabs = [];
          body.forEach((k) => this.mark(k, 'pending'));
          this.mark(i, 'running', `item ${no}: ${it.key} · ${summary()}`);
          this.set('running', `Item ${no}: ${it.key}`);
          const t0 = Date.now();
          const res = await this.runItem(body, recordedListUrl, sameUrl);
          if (this.stopped) break pages;
          // Which page did this item open? (a new tab, or the list tab after navigating)
          const openedId = this.itemTabs.filter((id) => id !== tabId).pop() ?? tabId;
          const ot = await chrome.tabs.get(openedId).catch(() => null);
          const opened = !ot ? '' : sameUrl(ot.url, pageUrl) ? 'same page (popup / inline)' : `${ot.title} — ${ot.url}`;
          const details = Object.entries(it.row || {}).filter(([, v]) => v && v !== it.key).map(([k, v]) => [`item: ${k}`, v]);
          rows.push({
            '#': no, item: it.key, ...Object.fromEntries(details),
            clicked: res.actions.join(' → '), 'opened page': opened,
            ...res.checkCols,
            result: res.passed ? 'PASS' : 'FAIL', errors: res.details, 'time (s)': ((Date.now() - t0) / 1000).toFixed(1),
          });
          this.mark(i, 'running', summary());
          const nextKey = items.slice(n + 1).find((x) => !seen.has(x.key))?.key;
          await this.backToList(tabId, L, pageUrl, pageNo, nextKey);
        }
        if (!L.next || pageNo >= maxPages || rows.length >= maxItems || this.stopped) break;
        await this.backToList(tabId, L, pageUrl, pageNo, null);
        const moved = await clickNextAndWait(tabId, L.list, L.next, () => this.stopped);
        if (!moved.ok) break;
        pageNo++;
        pageUrl = (await chrome.tabs.get(tabId)).url;
      }
    } finally {
      this.loopCtx = null;
      const fields = [];
      rows.forEach((r) => Object.keys(r).forEach((k) => { if (!fields.includes(k)) fields.push(k); }));
      this.loopResults.push({ title: `For each item in ${start.title || 'list'}`, rows, fields });
      this.extracted.push({ title: 'loop results', fields, rows });
    }
    if (end < this.steps.length) this.mark(end, 'done');
    this.skipTo = end + 1;
    this.lastActionAt = Date.now();
    return summary();
  }

  // Run the loop body for the current item. Returns { passed, details }.
  async runItem(body, recordedListUrl, sameUrl) {
    let passed = true;
    const problems = [];
    const actions = [];  // what was actually clicked / typed on this item
    const checkCols = {}; // one column per check: "✓ PASS" / "✗ FAIL — …"
    let checkNo = 0;
    const noteCheck = (k, s) => {
      checkNo++;
      const c = this.checks.get(`${k}#${this.loopCtx.no}`);
      const name = `check ${checkNo}: ${checkCondition(s.check)}`.slice(0, 80);
      checkCols[name] = !c ? 'not run' : c.passed ? `✓ PASS — ${c.text}` : `✗ FAIL — ${c.text}`;
    };
    const noteAction = (s) => {
      const a = this.lastActed;
      this.lastActed = null;
      if (!a || !['click', 'dblclick', 'type', 'select', 'check', 'set', 'key'].includes(s.type)) return;
      const what = `${a.kind}${a.label ? ` "${a.label}"` : ''}`;
      const verb = describeStep(s).verb;
      actions.push(s.type === 'type' ? `Type "${s.sensitive ? '••••' : s.value}" into ${what}`
        : s.type === 'select' ? `Select "${s.value}" in ${what}`
        : s.type === 'key' ? `Press ${s.key}` : `${verb} ${what}`);
    };
    let jumped = null;
    for (let b = 0; b < body.length && !this.stopped; b++) {
      const k = body[b];
      const s = this.steps[k];
      if (isIfMarker(s)) {
        // ⑂ If blocks inside the loop: decided for each item.
        let next;
        try {
          next = await this.branch(k, jumped === k);
        } catch (err) {
          passed = false;
          problems.push(err.message);
          this.mark(k, 'failed', err.message);
          next = this.blockEnd(k);
        }
        jumped = this.jumpedTo === next ? next : null;
        this.jumpedTo = null;
        const pos = body.indexOf(next);
        b = (pos >= 0 ? pos : body.length) - 1;
        continue;
      }
      // "Back to the list" navigations are done by the loop itself (it knows the right page).
      if (['navigate', 'urlchange'].includes(s.type) && sameUrl(s.url, recordedListUrl)) {
        this.mark(k, 'done', 'back to the list (handled by the loop)');
        continue;
      }
      const g = await this.gate(k);
      if (g === 'stop' || this.stopped) break;
      if (g === 'skip') { this.mark(k, 'skipped', 'skipped in debug mode'); continue; }
      let off;
      try { off = await this.condOff(s, k); } catch (err) { off = null; }
      if (off) { this.mark(k, 'off', off); continue; }
      this.mark(k, 'running');
      this.set('running', `Item ${this.loopCtx.no}: ${this.loopCtx.key} — step ${k + 1}`);
      this.lastActed = null;
      try {
        const note = await this.exec(s, k);
        this.mark(k, 'done', this.condNote(s, note));
        noteAction(s);
        if (s.type === 'verify') noteCheck(k, s);
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof NotOnPage) {
          this.mark(k, 'off', err.message);
          const last = this.skipNavAfter(k);
          while (b + 1 < body.length && body[b + 1] <= last) b++; // skip the page change it would have caused
          continue;
        }
        if (err instanceof CheckFailed) { passed = false; this.mark(k, 'failed', err.message); noteCheck(k, s); continue; } // shown in its check column
        if (err instanceof Rejected) {
          passed = false;
          problems.push(`⏸ ${err.message}`);
          this.mark(k, 'failed', `✗ ${err.message}`);
          if (this.loopCtx.onFail === 'stop') { this.rejectedAt = k + 1; this.stopped = true; }
          break;
        }
        if (err instanceof ManualStep || this.loopCtx.onFail === 'stop') {
          const manual = err instanceof ManualStep;
          this.mark(k, manual ? 'waiting' : 'failed', err.message);
          const what = `Item ${this.loopCtx.no} (${this.loopCtx.key}): ${err.message}`;
          const choice = manual ? await this.ask('waiting', what) : await this.failed(what, k);
          this.set('running', `Item ${this.loopCtx.no}: ${this.loopCtx.key}`);
          if (choice === 'stop') { this.stopped = true; break; }
          if (choice === 'retry') { b--; continue; }
          if (choice === 'continue') { this.mark(k, 'done', 'done by you'); continue; }
          this.mark(k, 'skipped');
          if (s.type === 'verify') noteCheck(k, s);
          if (!manual) { passed = false; if (s.type !== 'verify') problems.push(`skipped: ${err.message}`); }
          continue;
        }
        // "On failure: next item" — note the error and give up on this item.
        passed = false;
        problems.push(err.message);
        this.mark(k, 'failed', err.message);
        break;
      }
      await this.sleep(REPLAY.STEP_DELAY);
    }
    return { passed, details: problems.join('; '), actions, checkCols };
  }

  // Make sure the list tab shows the list page again (and the page with `expectKey` on it).
  async backToList(tabId, L, pageUrl, pageNo, expectKey) {
    for (const id of this.itemTabs) if (id !== tabId) await chrome.tabs.remove(id).catch(() => {});
    for (const [rec, live] of [...this.tabMap]) if (this.itemTabs.includes(live) && live !== tabId) this.tabMap.delete(rec);
    this.newTabs = this.newTabs.filter((id) => !this.itemTabs.includes(id));
    this.itemTabs = [];
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});

    const ready = async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status !== 'complete') return false;
      const keys = await this.listKeys(tabId, L.list, 2500).catch(() => null);
      return !!keys && keys.length > 0 && (!expectKey || keys.some((x) => x.key === expectKey));
    };
    if (await ready()) return;
    // The item opened a page in the same tab: go back like the user did.
    for (let k = 0; k < 3 && !this.stopped; k++) {
      await chrome.tabs.goBack(tabId).catch(() => {});
      await this.waitLoad(tabId);
      if (await ready()) return;
    }
    // Still not there: open the list page again, and page forward for pages that don't change the URL.
    await chrome.tabs.update(tabId, { url: pageUrl });
    await this.waitLoad(tabId);
    for (let p = 1; p < pageNo && !(await ready()) && !this.stopped; p++) {
      await clickNextAndWait(tabId, L.list, L.next, () => this.stopped);
    }
  }

  // Markdown report of all checks in this replay.
  // Markdown report of this run: summary, every step with its result, loops and checks.
  // "3 passed, 1 failed" for the 🧪 test steps ('' when the flow has none).
  testSummary(prefix = '') {
    const all = [...this.tests.values()];
    if (!all.length) return '';
    const ok = all.filter((t) => t.passed).length;
    return `${prefix}${ok} passed${all.length - ok ? `, ${all.length - ok} failed` : ''}`;
  }

  // The 🧪 Test steps table (Markdown) — test steps that did not run are listed as NOT RUN.
  testTable() {
    const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    const rows = [];
    this.steps.forEach((st, k) => {
      if (st.type !== 'test') return;
      const runs = [...this.tests.entries()].filter(([key]) => key === k || String(key).startsWith(`${k}#`)).map(([, t]) => t);
      const res = this.results[k];
      if (!runs.length) rows.push([st, null, res.status === 'off' ? '– not needed (⑂ condition)' : res.status === 'skipped' ? '↷ SKIPPED' : '· NOT RUN', '']);
      runs.forEach((t) => rows.push([st, t, t.passed ? '✓ PASS' : '✗ FAIL', t.details.map((d) => `${d.ok ? '✓' : '✗'} ${d.cond} — ${d.detail}`).join('<br>')]));
    });
    if (!rows.length) return '';
    const items = rows.some(([, t]) => t?.item);
    return [`| # | Test step | Expected result |${items ? ' Item |' : ''} Result | What was seen |`, `|---|---|---|${items ? '---|' : ''}---|---|`,
      ...rows.map(([st, t, r, seen], k) => `| ${k + 1} | ${cell(st.name || 'Test step')} | ${cell(st.expected || '')} |${items ? ` ${cell(t?.item || '')} |` : ''} ${r} | ${cell(seen).replace(/&lt;br&gt;/g, '<br>')} |`)].join('\n');
  }

  checkReport() {
    const all = [...this.checks.values()];
    const passed = all.filter((c) => c.passed).length;
    const counts = { done: 0, failed: 0, skipped: 0, waiting: 0, pending: 0, off: 0 };
    this.results.forEach((r, k) => { if (!isIfMarker(this.steps[k])) counts[r.status in counts ? r.status : 'pending']++; });
    const realCount = this.steps.filter((x) => !isIfMarker(x)).length;
    const verdict = this.rejectedAt ? '✗ REJECTED' : this.stopped ? '■ STOPPED' : counts.failed ? '✗ FAILED' : '✓ PASSED';
    const dt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
    const out = [
      `# Run report — ${this.flow.name}`, '',
      ...(this.flow.description ? [...String(this.flow.description).trim().split('\n').map((l) => `> ${l}`), ''] : []),
      `- **Flow version:** v${this.flow.version || 1}${this.flow.updatedAt || this.flow.savedAt ? ` (updated ${new Date(this.flow.updatedAt || this.flow.savedAt).toLocaleString()})` : ''}`,
      `- **Mode:** ${this.debug ? 'Debug' : 'Replay'}`,
      `- **Started:** ${dt(this.startedAt)} · **Finished:** ${dt(this.endedAt)}${this.startedAt && this.endedAt ? ` · **Duration:** ${fmtDur(this.endedAt - this.startedAt)}` : ''}`,
      ...(this.envName ? [`- **Environment:** ${this.envName}`] : []),
      ...(Object.keys(this.vars).filter((k) => !(k in AFTER_VARS)).length ? [`- **Variables:** ${Object.entries(this.vars).filter(([k]) => !(k in AFTER_VARS))
        .map(([k, v]) => `${k} = ${this.secretNames.has(k) ? '••••' : v}`).join(', ')}`] : []),
      `- **Result:** ${verdict} — ${counts.done} of ${realCount} steps done` +
        `${counts.failed ? `, ${counts.failed} failed` : ''}${counts.skipped ? `, ${counts.skipped} skipped` : ''}${counts.off ? `, ${counts.off} not needed (⑂ condition)` : ''}${counts.pending + counts.waiting ? `, ${counts.pending + counts.waiting} not run` : ''}` +
        `${all.length ? ` · checks: ${passed} of ${all.length} passed` : ''}${this.testSummary(' · test steps: ')}`, '',
    ];
    const tt = this.testTable();
    if (tt) out.push('## Test steps', '', tt, '');
    const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    const ICONS = { done: '✓', failed: '✗', skipped: '↷', off: '–', waiting: '✋', pending: '·', running: '▶', paused: '⏸' };
    if ((this.afterResults || []).length) {
      out.push('## After the run', '', '| Request | When | Result |', '|---|---|---|');
      this.afterResults.forEach((x) => out.push(`| ${cell(`${(x.hook.method || 'GET').toUpperCase()} ${x.hook.url}`)} | ${cell(AFTER_WHEN[x.hook.when] || AFTER_WHEN.always)} | ${x.ok ? '✓' : '✗'} ${cell(x.note)} |`));
      out.push('');
    }
    out.push('## Steps', '', '| # | Step | Result | Note |', '|---|---|---|---|');
    this.steps.forEach((st, k) => {
      const d = describeStep(st);
      const r = this.results[k];
      out.push(`| ${k + 1} | ${cell(`${d.verb} ${d.text}`)} | ${ICONS[r.status] || r.status} | ${cell(r.msg)} |`);
    });
    out.push('');
    for (const L of this.loopResults) {
      const ok = L.rows.filter((r) => r.result === 'PASS').length;
      const checkCols = L.fields.filter((f) => f.startsWith('check '));
      const itemCols = L.fields.filter((f) => f.startsWith('item: '));
      out.push(`## ${L.title} — ${L.rows.length} items: ${ok} passed, ${L.rows.length - ok} failed`, '',
        `| # | Item | Item details | Clicked | Opened page | ${checkCols.map(cell).join(' | ')}${checkCols.length ? ' | ' : ''}Result | Errors | Time (s) |`,
        `|---|---|---|---|---|${checkCols.map(() => '---|').join('')}---|---|---|`);
      L.rows.forEach((r) => out.push(
        `| ${r['#']} | ${cell(r.item)} | ${cell(itemCols.filter((f) => r[f]).map((f) => `${f.slice(6)}: ${r[f]}`).join('; '))} | ` +
        `${cell(r.clicked)} | ${cell(r['opened page'])} | ${checkCols.map((f) => cell(r[f] ?? '')).join(' | ')}${checkCols.length ? ' | ' : ''}` +
        `${r.result === 'PASS' ? '✓ PASS' : '✗ FAIL'} | ${cell(r.errors)} | ${r['time (s)']} |`));
      out.push('');
    }
    if (all.length) {
      out.push('## All checks', '', '| # | Result | Item | Where | Condition | Details | URL |', '|---|---|---|---|---|---|---|');
      all.forEach((c, k) => out.push(`| ${k + 1} | ${c.passed ? '✓ PASS' : '✗ FAIL'} | ${cell(c.item)} | ${cell(c.step.check.scope ? c.step.check.scope.name : 'page')} | ${cell(checkCondition(c.step.check))} | ${cell(c.text)} | ${cell(c.url)} |`));
    }
    return out.join('\n') + '\n';
  }

  sleep(ms) {
    return new Promise((r) => {
      const end = Date.now() + ms;
      const tick = () => (this.stopped || Date.now() >= end ? r() : setTimeout(tick, Math.min(200, end - Date.now())));
      tick();
    });
  }

  // ---------- tabs ----------
  async tabFor(step) {
    if (this.tabMap.has(step.tabId)) {
      const id = this.tabMap.get(step.tabId);
      if (await chrome.tabs.get(id).catch(() => null)) return id;
    }
    // A new recorded tab: use a tab the replay just opened (e.g. a link with target=_blank).
    while (this.newTabs.length) {
      const id = this.newTabs.shift();
      if ([...this.tabMap.values()].includes(id)) continue;
      if (!(await chrome.tabs.get(id).catch(() => null))) continue;
      this.tabMap.set(step.tabId, id);
      return id;
    }
    return null;
  }

  async openTab(step) {
    const since = Date.now();
    const tab = await chrome.tabs.create({ url: step.url, active: true });
    this.newTabs = this.newTabs.filter((id) => id !== tab.id);
    this.tabMap.set(step.tabId, tab.id);
    this.mainTab = this.mainTab || tab.id;
    await this.waitLoad(tab.id, since);
    return tab.id;
  }

  // Wait until the tab has loaded. Fails when the page could not be opened (a network error after `since`).
  async waitLoad(tabId, since = Date.now()) {
    await this.sleep(300);
    const end = Date.now() + REPLAY.LOAD_TIMEOUT;
    while (!this.stopped && Date.now() < end) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error('The replay tab was closed');
      this.checkNavError(tabId, since);
      if (tab.status === 'complete') {
        await this.sleep(150); // the error event can arrive just after "complete"
        this.checkNavError(tabId, since);
        return;
      }
      await this.sleep(200);
    }
  }

  checkNavError(tabId, since) {
    const e = this.navErrors.get(tabId);
    if (!e || e.t < since) return;
    const code = e.error.replace(/^net::/, '');
    const why = [
      [/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED/, 'the address was not found (check the host name / DNS / VPN)'],
      [/CONNECTION_REFUSED/, 'the server refused the connection — is it running on that port?'],
      [/TIMED_OUT/, 'the server did not respond in time'],
      [/INTERNET_DISCONNECTED|NETWORK_CHANGED/, 'there is no network connection'],
      [/ADDRESS_UNREACHABLE|CONNECTION_FAILED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE/, 'the server could not be reached'],
      [/CERT_|SSL_/, 'the site\'s security certificate was not accepted'],
      [/BLOCKED/, 'the page was blocked'],
      [/FILE_NOT_FOUND/, 'the file does not exist'],
    ].find(([re]) => re.test(code))?.[1] || 'the browser could not load it';
    throw new Error(`Page could not be opened: ${why} (${code}) — ${e.url}`);
  }

  // ---------- one step ----------
  async exec(step, i) {
    if (step.type === 'approval') return this.approval(step);
    if (step.type === 'http') return this.http(step);
    if (!['loopStart', 'loopEnd'].includes(step.type)) {
      const original = step.url;
      step = this.resolve(step);
      if (['navigate', 'tab'].includes(step.type)) step.url = webUrl(step.url, original);
    }
    switch (step.type) {
      case 'navigate': return this.navigate(step, i);
      case 'urlchange': {
        if (this.loopCtx) return ''; // URLs differ per item; nothing to wait for
        const tabId = (await this.tabFor(step)) || this.mainTab;
        const end = Date.now() + 5000;
        while (Date.now() < end && !this.stopped) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (tab && tab.url === step.url) return '';
          await this.sleep(200);
        }
        return 'URL differs from the recording (continued)';
      }
      case 'tab': {
        let tabId = await this.tabFor(step);
        if (!tabId) {
          const [match] = await chrome.tabs.query({ url: step.url.split('#')[0] }).catch(() => []);
          if (match) { tabId = match.id; this.tabMap.set(step.tabId, tabId); }
        }
        if (!tabId) return this.openTab(step).then(() => 'opened in a new tab');
        await chrome.tabs.update(tabId, { active: true });
        return '';
      }
      case 'note':
        throw new ManualStep(`Note: ${step.text} — press Continue when ready`);
      case 'dialog':
        return 'answered automatically';
      case 'capture': {
        const tabId = (await this.tabFor(step)) || this.mainTab;
        const wait = step.optional ? Math.min(this.elementTimeout, optionalWait(step)) : this.elementTimeout;
        const r = await pageCall(tabId, {
          type: 'check:capture', capture: step, timeout: wait,
          loop: this.loopCtx ? { list: this.loopCtx.list, index: this.loopCtx.index, key: this.loopCtx.key } : null,
        }, wait + 6000).catch((err) => {
          if (step.optional && /not found/i.test(err.message)) throw new NotOnPage(`skipped — not on the page (optional step); {{${step.varName}}} is not set`);
          throw err;
        });
        this.vars[step.varName] = r.value;
        if (!r.value) return `⚠ {{${step.varName}}} is empty (the element had no matching value)`;
        return `{{${step.varName}}} = "${r.value}"`;
      }
      case 'loopStart':
        return this.runLoop(i);
      case 'loopEnd':
        return '';
      case 'test': {
        // 🧪 Test step: every condition must hold. Nothing on the page is changed.
        const details = [];
        for (const c of step.conds || []) {
          const r = await this.evalCondition(c, step).catch((err) => ({ ok: false, detail: err.message }));
          details.push({ cond: condText(c), ok: r.ok, detail: r.detail });
        }
        const passed = details.length > 0 && details.every((d) => d.ok);
        this.tests.set(this.loopCtx ? `${i}#${this.loopCtx.no}` : i, { step, passed, details, item: this.loopCtx?.key || '' });
        const name = step.name || `step ${i + 1}`;
        if (passed) return `✓ PASS — ${name}`;
        const why = details.filter((d) => !d.ok).map((d) => `${d.cond}: ${d.detail}`).join('; ') || 'no condition';
        if (step.onFail === 'stop') throw new Error(`Test step failed — ${name}: ${why}`);
        throw new CheckFailed(`✗ FAIL — ${name}: ${why}`);
      }
      case 'verify': {
        const tabId = (await this.tabFor(step)) || this.mainTab;
        const r = await pageCall(tabId, { type: 'check:run', check: step.check, timeout: REPLAY.CHECK_TIMEOUT });
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const text = checkResultText(step.check, r);
        const key = this.loopCtx ? `${i}#${this.loopCtx.no}` : i;
        this.checks.set(key, { step, passed: r.passed, text, url: tab?.url || step.url, at: Date.now(), item: this.loopCtx?.key || '' });
        if (r.passed) return `✓ PASS — ${text}`;
        const cont = this.loopCtx ? this.loopCtx.onFail === 'continue' : this.flow.onCheckFail === 'continue';
        if (cont) throw new CheckFailed(`✗ FAIL — ${text}`);
        throw new Error(`Check failed — ${text}`);
      }
      case 'extract': {
        const tabId = (await this.tabFor(step)) || this.mainTab;
        const res = await extractAll(tabId, step.spec, {
          onProgress: (p) => this.set('running', `Extracting list… page ${p.pages}, ${p.rows} items`),
          shouldStop: () => this.stopped,
        });
        this.extracted.push({ title: step.title || 'list', fields: res.fields, rows: res.rows });
        this.lastActionAt = Date.now();
        return `${res.rows.length} items from ${res.pages} page${res.pages === 1 ? '' : 's'}${res.stopReason ? ` (${res.stopReason})` : ''}`;
      }
      case 'upload':
        throw new ManualStep(`Choose the file (${step.value || 'file'}) in ${this.thing(step)} yourself, then press Continue`);
      case 'type':
        if (step.sensitive && !step.value) throw new ManualStep(`Type the password into ${this.thing(step)} yourself, then press Continue`);
        return this.pageAction(step, i);
      default:
        return this.pageAction(step, i);
    }
  }

  // "After the run": the flow's requests that run once the steps are over (always / only on success / only on
  // failure), with the run's result in variables such as {{RUN_RESULT}}. Their errors do not change the result.
  async afterRun(outcome, summary) {
    const hooks = (this.flow.after || []).filter((h) => !h.when || h.when === 'always' || (h.when === 'success') === (outcome === 'PASSED'));
    this.afterResults = [];
    if (!hooks.length) return '';
    const failed = this.results.map((r, k) => {
      if (r.status !== 'failed') return null;
      const d = describeStep(this.steps[k]);
      return `${k + 1}. ${d.verb} ${d.text}: ${r.note || 'failed'}`;
    }).filter(Boolean);
    const t = (ms) => new Date(ms).toLocaleString();
    Object.assign(this.vars, {
      FLOW_NAME: this.flow.name || '', FLOW_VERSION: String(this.flow.version || 1), RUN_RESULT: outcome, RUN_SUMMARY: summary,
      FAILED_STEPS: failed.join('\n') || 'none', DURATION: fmtDur((this.endedAt || Date.now()) - this.startedAt),
      STARTED_AT: t(this.startedAt), FINISHED_AT: t(this.endedAt || Date.now()), ENV: this.envName || '',
    });
    const failedTests = [...this.tests.values()].filter((t) => !t.passed).map((t) => t.step.name || 'test step');
    this.vars.TEST_RESULTS = this.tests.size
      ? `${this.tests.size - failedTests.length} of ${this.tests.size} passed${failedTests.length ? ` — failed: ${failedTests.join(', ')}` : ''}` : 'none';
    this.vars.TEST_TABLE = this.testTable() || 'none';
    this.vars.RUN_REPORT = this.checkReport();
    const wasStopped = this.stopped;
    this.stopped = false; // a stopped run still sends its "After the run" requests
    for (const h of hooks) {
      try {
        const note = await this.http({ ...h, type: 'http' });
        this.afterResults.push({ hook: h, ok: true, note });
      } catch (err) {
        this.afterResults.push({ hook: h, ok: false, note: err.message });
      }
    }
    this.stopped = wasStopped;
    const ok = this.afterResults.filter((x) => x.ok).length;
    return ` · after the run: ${ok === hooks.length ? `${ok} request${ok > 1 ? 's' : ''} sent` : `${hooks.length - ok} of ${hooks.length} requests failed`}`;
  }

  // 🌐 HTTP request: from the extension (any URL, no CORS; only what is in the headers/body authenticates) or
  // from the page (same site as the tab, with the user's login cookies).
  async http(step) {
    const masked = (t) => [...this.secretNames].reduce((acc, n) => (this.vars[n] ? acc.split(String(this.vars[n])).join('••••') : acc), String(t));
    const sub = (t) => String(t ?? '').replace(VAR_RE, (_, n) => this.varValue(n));
    // In a JSON body, values are escaped so quotes / new lines in a variable cannot break the JSON.
    const subJson = (t) => String(t ?? '').replace(VAR_RE, (_, n) => JSON.stringify(this.varValue(n)).slice(1, -1));
    const method = (step.method || 'GET').toUpperCase();
    let url = sub(step.url).trim();
    if (!/^https?:\/\//i.test(url)) url = webUrl(url, step.url);
    const headers = {};
    for (const h of step.headers || []) if (h && h.name) headers[h.name.trim()] = sub(h.value);
    let body;
    const bt = step.bodyType || 'none';
    if (!['GET', 'HEAD'].includes(method) && bt !== 'none') {
      if (bt === 'json') {
        body = subJson(step.body);
        try { JSON.parse(body); } catch (e) { throw new Error(`The JSON body is not valid after filling in the variables: ${e.message}`); }
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      } else if (bt === 'form') {
        const form = new URLSearchParams();
        String(step.body || '').split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
          const k = l.indexOf('=');
          form.append(sub(k < 0 ? l : l.slice(0, k)).trim(), sub(k < 0 ? '' : l.slice(k + 1)));
        });
        body = form.toString();
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else body = sub(step.body);
    }
    const timeout = Math.max(1, Number(step.timeoutSec) || 30) * 1000;
    this.set('running', `🌐 ${method} ${masked(url)}`);
    const t0 = Date.now();
    let res;
    if (step.from === 'page') {
      const tabId = (await this.tabFor(step).catch(() => null)) || this.mainTab;
      if (!tabId) throw new Error('No page is open to send the request from — choose "from the extension" or add a start page');
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [url, method, headers, body ?? null, timeout],
        func: async (u, m, h, b, ms) => {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), ms);
          try {
            const x = await fetch(u, { method: m, headers: h, body: b, credentials: 'include', signal: ctl.signal });
            return { status: x.status, statusText: x.statusText, text: (await x.text()).slice(0, 200000) };
          } catch (e) {
            return { error: e.name === 'AbortError' ? `no answer within ${Math.round(ms / 1000)} s` : String(e.message || e) };
          } finally { clearTimeout(timer); }
        },
      });
      res = r?.result || { error: 'the page did not run the request' };
    } else {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const x = await fetch(url, { method, headers, body, credentials: 'include', signal: ctl.signal });
        res = { status: x.status, statusText: x.statusText, text: (await x.text()).slice(0, 200000) };
      } catch (e) {
        res = { error: e.name === 'AbortError' ? `no answer within ${Math.round(timeout / 1000)} s` : String(e.message || e) };
      } finally { clearTimeout(timer); }
    }
    const ms = Date.now() - t0;
    const head = `${method} ${masked(url)}`;
    if (res.error) throw new Error(`${head} failed: ${res.error}${/fetch/i.test(res.error) ? ' (server not reachable, blocked, or — when sent from the page — another site)' : ''}`);
    const snippet = masked(res.text.replace(/\s+/g, ' ').trim().slice(0, 300));
    const okStatus = httpStatusOk(step, res.status);
    if (!okStatus) throw new Error(`${head} → ${res.status} ${res.statusText || ''} (expected ${httpExpectText(step)})${snippet ? ` — ${snippet}` : ''}`);
    // Keep values from the response for later steps.
    let json;
    try { json = JSON.parse(res.text); } catch (_) { json = undefined; }
    const notes = [`${head} → ${res.status} ${res.statusText || ''}`.trim() + ` (${ms < 1000 ? `${ms} ms` : fmtDur(ms)})`];
    for (const sv of step.save || []) {
      if (!sv || !sv.varName) continue;
      const v = responseValue(sv.path, { status: res.status, text: res.text, json });
      if (v === undefined) throw new Error(`${head} → ${res.status}, but "${sv.path}" is not in the response${snippet ? ` — ${snippet}` : ''}`);
      this.vars[sv.varName] = v;
      notes.push(`{{${sv.varName}}} = "${masked(String(v)).slice(0, 60)}"`);
    }
    if (!(step.save || []).length && snippet) notes.push(`response: ${snippet.slice(0, 120)}`);
    return notes.join(' · ');
  }

  // ⏸ steps: wait for the user's approval, or ask them for a value and keep it as a variable.
  async approval(step) {
    if (step.mode === 'input') {
      this.inputSpec = { varName: step.varName, secret: !!step.secret };
      const choice = await this.ask('input', step.text);
      this.inputSpec = null;
      if (this.stopped) return '';
      if (choice !== 'ok') throw new Rejected(`No value given for {{${step.varName}}}`);
      this.vars[step.varName] = this.inputValue ?? '';
      if (step.secret) this.secretNames.add(step.varName);
      const shown = `{{${step.varName}}} set${step.secret ? '' : ` to "${this.inputValue}"`}`;
      if (step.fill) {
        // "…and type it into a field": fill the picked field with the answer.
        await this.pageAction({ type: 'type', target: step.fill, tabId: step.tabId, value: this.inputValue ?? '', sensitive: !!step.secret }, this.steps.indexOf(step));
        return `${shown} and typed into ${step.fill.kind}${step.fill.label ? ` "${step.fill.label}"` : ''}`;
      }
      return shown;
    }
    const choice = await this.ask('approval', step.text);
    if (this.stopped) return '';
    if (choice === 'approve') return 'approved';
    throw new Rejected('rejected');
  }

  thing(step) {
    const t = step.target || {};
    return t.label ? `${t.kind} "${t.label}"` : t.kind || 'the field';
  }

  async navigate(step) {
    // Network errors from the action that led here (a link click, a submit) count too.
    let since = Math.min(Date.now(), this.lastActionAt || Date.now());
    let tabId = await this.tabFor(step);
    if (!tabId && this.loopCtx) {
      // In a loop, a new recorded tab is the tab the item click opens — give it a moment to appear.
      const end = Date.now() + REPLAY.NAV_TIMEOUT;
      while (!tabId && Date.now() < end && !this.stopped) { await this.sleep(200); tabId = await this.tabFor(step); }
      if (!tabId) throw new Error('The item did not open a new tab as it did when recorded');
      await this.waitLoad(tabId, since);
      return '';
    }
    if (!tabId) {
      if (!this.mainTab || step.transition === 'start') return this.openTab(step).then(() => '');
      return this.openTab(step).then(() => 'opened in a new tab');
    }
    const tab = await chrome.tabs.get(tabId);
    const direct = DIRECT_NAV.includes(step.transition) || (step.qualifiers || []).includes('forward_back');
    if (step.transition === 'reload') {
      since = Date.now();
      await chrome.tabs.reload(tabId);
    } else if (direct || this.navErrors.has(tabId)) {
      // Also after a failed attempt (Retry): load the page again.
      if (tab.url !== step.url || this.navErrors.has(tabId)) {
        since = Date.now();
        this.navErrors.delete(tabId);
        await chrome.tabs.update(tabId, { url: step.url });
      }
    } else {
      // The page change should come from the previous action (a link, a form submit, a redirect).
      const end = Date.now() + REPLAY.NAV_TIMEOUT;
      let commit = this.commits.get(tabId);
      while ((!commit || commit.t < this.lastActionAt) && Date.now() < end && !this.stopped) {
        await this.sleep(200);
        commit = this.commits.get(tabId);
      }
      if ((!commit || commit.t < this.lastActionAt) && this.loopCtx) return 'no page change for this item';
      if (!commit || commit.t < this.lastActionAt) {
        const now = await chrome.tabs.get(tabId);
        if (now.url !== step.url) {
          since = Date.now();
          await chrome.tabs.update(tabId, { url: step.url });
          await this.waitLoad(tabId, since);
          return 'page did not change by itself — opened the recorded URL';
        }
      }
    }
    await this.waitLoad(tabId, since);
    return '';
  }

  async frameFor(tabId, step) {
    if (!step.frame) return 0;
    const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) || [];
    const exact = frames.find((f) => f.url === step.frame);
    if (exact) return exact.frameId;
    try {
      const want = new URL(step.frame);
      const near = frames.find((f) => { try { const u = new URL(f.url); return u.origin === want.origin && u.pathname === want.pathname; } catch (_) { return false; } });
      if (near) return near.frameId;
    } catch (_) { /* ignore */ }
    return null; // iframe not loaded yet
  }

  async pageAction(step, i) {
    const tabId = (await this.tabFor(step)) || this.mainTab;
    if (!tabId) throw new Error('No tab to replay in — the flow has no start page');
    // Native alert/confirm/prompt that followed this step in the recording get answered the same way.
    const dialogs = [];
    for (let k = i + 1; k < this.steps.length && this.steps[k].type === 'dialog'; k++) {
      dialogs.push({ kind: this.steps[k].kind, result: this.resolve(this.steps[k]).result });
    }
    const end = Date.now() + (step.optional ? Math.min(this.elementTimeout, optionalWait(step)) : this.elementTimeout);
    let injected = false;
    let lastErr = '';
    while (!this.stopped) {
      const frameId = await this.frameFor(tabId, step);
      if (frameId != null) {
        try {
          this.lastActionAt = Date.now();
          const res = await chrome.tabs.sendMessage(tabId, {
            type: 'replayStep', step, dialogs, timeout: Math.max(1000, end - Date.now()),
            loop: this.loopCtx ? { list: this.loopCtx.list, index: this.loopCtx.index, key: this.loopCtx.key } : null,
          }, { frameId });
          if (res && res.ok) {
            this.lastActed = res.acted || null;
            const notes = [res.warning || ''];
            if (res.computed) {
              const c = res.computed;
              if (step.valueOp === 'add' || step.valueOp === 'sub') notes.push(`${c.before === '' ? '(empty)' : c.before} ${step.valueOp === 'add' ? '+' : '−'} ${step.value} = ${c.value}`);
              else if (step.valueOp === 'append') notes.push(`now "${String(c.value).slice(0, 60)}"`);
              if (step.saveAs) { this.vars[step.saveAs] = c.value; notes.push(`{{${step.saveAs}}} = "${String(c.value).slice(0, 60)}"`); }
            }
            return notes.filter(Boolean).join(' · ');
          }
          if (res) {
            if (step.optional && /^Element not found/.test(res.error || '')) throw new NotOnPage(`skipped — not on the page (optional step): ${res.error.replace(/^Element not found: /, '')}`);
            throw new Error(res.error);
          }
        } catch (err) {
          if (err instanceof NotOnPage) throw err;
          lastErr = err.message;
          if (!/Receiving end|message port closed|No frame/i.test(lastErr)) throw err;
          if (!injected) {
            injected = true; // page opened before the extension was (re)loaded
            await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
            await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['page-hooks.js'], world: 'MAIN' }).catch(() => {});
          }
        }
      }
      if (Date.now() > end) throw new Error(step.frame ? `Frame not found: ${step.frame}` : `Page did not respond (${lastErr})`);
      await this.sleep(300);
    }
    return '';
  }
}
