/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
const $ = (id) => document.getElementById(id);
const DEFAULTS = { recording: false, paused: false, activeLoop: null, editingFlowId: null, editingFlowName: null, vars: [], insertAfter: null, activeWhen: null, openIfs: [], startedAt: null, stoppedAt: null, steps: [] };
let state = { ...DEFAULTS };
let flows = [];        // saved flows: { id, name, savedAt, startedAt, stoppedAt, steps }
let replayer = null;   // active Replayer, if any
let groups = [];       // flow groups, in display order: { name, collapsed }
let envs = [];         // shared environments: { id, name, vars: [{ name, value, secret }] }
let view = 'rec';
let timerId = null;
let whenStepId = null; // step whose ⑂ condition editor is open
let blockEdit = null;  // { id, mode: 'cond' | 'elif' } — editor under an If / Else if row

const send = (msg) => chrome.runtime.sendMessage(msg);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // textContent only: page labels are untrusted
  return n;
}

const countSteps = (steps) => steps.filter((s) => !['note', 'pause', 'loopStart', 'loopEnd', 'ifStart', 'elif', 'else', 'ifEnd'].includes(s.type)).length;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The description part of a step row, shared by the recording and replay lists.
function stepBody(s, showRecordedResult = true) {
  const body = el('div', 'body');
  const d = describeStep(s);
  const verbCls = ['navigate', 'urlchange', 'tab'].includes(s.type) ? 'verb nav'
    : s.type === 'note' ? 'verb is-note' : s.type === 'dialog' ? 'verb is-dialog' : s.type === 'verify' || s.type === 'test' ? 'verb is-check' : s.type === 'approval' ? 'verb is-approval' : s.type === 'capture' ? 'verb is-capture' : 'verb';
  body.append(el('span', verbCls, d.verb + ' '), el('span', 'text', d.text));
  if (s.type === 'verify' && s.result && showRecordedResult) {
    const chip = el('span', 'res ' + (s.result.passed ? 'pass' : 'fail'), s.result.passed ? '✓ passes now' : '✗ fails now');
    chip.title = checkResultText(s.check, s.result);
    body.append(chip);
  }
  if (s.type === 'verify' && s.check.scope) body.append(el('span', 'sel', s.check.scope.selector));
  if (s.notClicked) {
    const chip = el('span', 'dlg', 'added without clicking');
    chip.title = 'This click was not performed while recording; it is performed on replay';
    body.append(chip);
  }
  if (s.target?.inItem) {
    const chip = el('span', 'itemchip', '⟳ each item');
    chip.title = `Recorded on item "${s.target.inItem.key}" — replayed on every item (selector inside the item: ${s.target.inItem.rel})`;
    body.append(chip);
  }
  if (s.optional) {
    const chip = el('span', 'optchip', `optional (${s.optionalWait || 3} s)`);
    chip.title = 'Skipped (not failed) when the element is not on the page';
    body.append(chip);
  }
  if (isWhen(s.when)) {
    const chip = el('span', 'whenchip', whenSource(s.when) === 'else' ? '⑂ else (none of the cases above)' : s.when.branch === 'elif' ? `⑂ ${whenText(s.when)}` : `⑂ only if ${whenText(s.when)}${s.when.branch === 'else' ? ' (else)' : ''}`);
    chip.title = 'This step runs only when the condition is true; otherwise it is skipped';
    body.append(chip);
  }
  if (s.target?.dialog) body.append(el('span', 'dlg', '⧉ in dialog ' + (s.target.dialog.title ? `"${s.target.dialog.title}"` : s.target.dialog.selector)));
  if (s.target?.selector) body.append(el('span', 'sel', (s.target.shadowHosts ? s.target.shadowHosts.join(' › ') + ' › ' : '') + s.target.selector));
  return body;
}

// ---------------------------------------------------------------- ⚠ flow check
// The list of findings; in the editor a click on one scrolls to its step.
function checkList(items, jump) {
  const ul = el('ul', 'checklist');
  items.forEach((c) => {
    const li = el('li', c.level, (c.level === 'warn' ? '⚠ ' : 'ℹ ') + c.text);
    if (jump && c.id) {
      li.classList.add('jump');
      li.title = 'Show this step';
      li.addEventListener('click', () => {
        const row = document.querySelector(`#steps li[data-id="${CSS.escape(c.id)}"]`);
        if (!row) return;
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add('flash');
        setTimeout(() => row.classList.remove('flash'), 1600);
      });
    }
    ul.append(li);
  });
  return ul;
}

// ---------------------------------------------------------------- views
function show(v) {
  view = v;
  $('recView').hidden = v !== 'rec';
  $('flowsView').hidden = v !== 'flows';
  $('replayView').hidden = v !== 'replay';
  $('extractView').hidden = v !== 'extract';
  $('shotView').hidden = v !== 'shots';
  $('tabExtract').classList.toggle('active', v === 'extract');
  $('tabShots').classList.toggle('active', v === 'shots');
  $('tabRec').classList.toggle('active', v === 'rec');
  $('tabFlows').classList.toggle('active', v === 'flows' || v === 'replay');
}
$('tabRec').addEventListener('click', () => show('rec'));
$('tabFlows').addEventListener('click', () => show(replayer ? 'replay' : 'flows'));
$('tabExtract').addEventListener('click', () => { show('extract'); renderExtract(); });

// ---------------------------------------------------------------- recording view
function render() {
  const { recording, paused, startedAt, steps } = state;
  const live = recording && !paused;
  const canAdd = recording; // adding steps (⑂ If, 🌐, ⏸, 🖱, ✓, ⤓) also works while the recording is paused
  const stopped = !recording && steps.length > 0;
  const busy = !!replayer;

  $('dot').classList.toggle('on', live);
  $('dot').classList.toggle('paused', recording && paused);
  $('statusText').textContent = live ? 'Recording' : paused && recording ? 'Paused' : stopped ? 'Stopped' : 'Idle';
  $('toggle').textContent = recording ? '■ Stop' : stopped ? (state.insertAfter ? '▶ Record here' : '▶ Continue') : '● Start recording';
  $('toggle').title = busy ? 'Not available while a flow is replaying' : stopped ? 'Keep adding steps to this recording' : '';
  $('toggle').disabled = busy && !recording;
  const sec = $('secondary');
  sec.hidden = !recording && !stopped;
  sec.disabled = busy && !recording;
  sec.textContent = recording ? (paused ? '▶ Resume' : '❚❚ Pause') : '● New';
  sec.title = recording ? '' : 'Discard this recording and start a new one';
  $('noteForm').hidden = !recording;
  $('checkBtn').hidden = !canAdd;
  // ⑂ If: while recording, and while a stopped recording / saved flow is edited (adds an empty block at ⤵ or the end).
  $('ifBtn').hidden = !(canAdd || (!recording && steps.length));
  if ($('ifBtn').hidden) $('ifForm').hidden = true;
  // ⤵ Where the next steps go, when it is not the end of the flow.
  const insAt = state.insertAfter ? steps.findIndex((x) => x.id === state.insertAfter) : -1;
  $('insBar').hidden = insAt < 0;
  if (insAt >= 0) $('insText').textContent = `⤵ ${recording ? 'Recording' : 'New steps go'} ${insertWhere(steps, insAt)}`;
  const openIfs = recording ? state.openIfs || [] : [];
  $('ifBar').hidden = !openIfs.length;
  if (openIfs.length) {
    const top = openIfs[openIfs.length - 1];
    const head = steps.find((x) => x.type === 'ifStart' && x.blockId === top.blockId);
    const lastCase = [...steps].reverse().find((x) => x.blockId === top.blockId && ['ifStart', 'elif', 'else'].includes(x.type));
    $('ifText').textContent = top.kind === 'else' ? `⑂ Recording the Else case of "If ${condText(head?.cond)}"`
      : top.kind === 'elif' ? `⑂ Recording the case "Else if ${condText(lastCase?.cond)}"`
      : `⑂ Recording the case "If ${condText(head?.cond)}"`;
    $('ifElse').hidden = $('ifElif').hidden = top.kind === 'else';
  }
  $('capBtn').hidden = !canAdd;
  $('clickBtn').hidden = !(canAdd || (!recording && steps.length));
  if (!canAdd && !$('capForm').hidden) closeCapture();
  $('apprBtn').hidden = !(canAdd || (!recording && steps.length));
  $('httpBtn').hidden = $('apprBtn').hidden;
  if ($('httpBtn').hidden) $('httpForm').hidden = true;
  $('testBtn').hidden = $('apprBtn').hidden;
  if ($('testBtn').hidden) $('testForm').hidden = true;
  if ($('apprBtn').hidden) $('apprForm').hidden = true;
  $('varsBox').hidden = recording || !steps.length;
  if (!$('varsBox').hidden) renderVars();
  $('loopBtn').hidden = !live || !!state.activeLoop;
  $('loopBar').hidden = !recording || !state.activeLoop;
  if (state.activeLoop) {
    const ls = state.steps.find((x) => x.id === state.activeLoop.id);
    const nx = ls?.loop.next;
    if (!lpPicking) {
      $('lpNextInfo').textContent = nx ? `${nx.kind} "${nx.label || nx.selector}"` : 'none — only the first page';
      $('lpPickNext').textContent = nx ? 'Pick another' : 'Pick Next button';
    }
    $('lpNoNext').hidden = !nx;
    $('lpPagesBox').hidden = !nx;
  }
  if (!canAdd && !$('checkForm').hidden) closeCheckForm();
  // "+ Add ▾" shows when at least one of its tools applies (or while a click is being picked: then it cancels).
  const picking = !!$('clickBtn').dataset.picking;
  $('addBtn').hidden = !picking && ![...$('addMenu').children].some((b) => !b.hidden);
  $('addBtn').textContent = picking ? '✕ Cancel click' : '+ Add ▾';
  if ($('addBtn').hidden) closeAddMenu();
  const has = steps.length > 0;
  ['copyMd', 'exportMd', 'exportJson'].forEach((id) => { $(id).disabled = !has || live; });
  $('saveFlow').disabled = !has || recording;
  const editing = !!state.editingFlowId;
  $('editBar').hidden = !editing;
  const ef = editing && flows.find((f) => f.id === state.editingFlowId);
  $('editName').textContent = `"${state.editingFlowName || ''}"${ef ? ` (v${flowVersion(ef)}, updated ${fmtDate(flowUpdated(ef))})` : ''}`;
  // ⚠ Flow check of the steps being edited (also for a stopped recording that is not saved yet).
  const fcBox = $('flowCheck');
  const findings = !recording && steps.length ? flowCheck({ steps, vars: state.vars || [] }, envs) : [];
  fcBox.hidden = !findings.length;
  if (findings.length) {
    const warns = findings.filter((c) => c.level === 'warn').length;
    const open = fcBox.open;
    fcBox.replaceChildren(el('summary', '', `${warns ? '⚠' : 'ℹ'} Flow check — ${warns ? plural(warns, 'warning') : ''}${warns && findings.length - warns ? ', ' : ''}${findings.length - warns ? plural(findings.length - warns, 'hint') : ''}`), checkList(findings, true));
    fcBox.open = open;
  }
  if (!$('saveFlow').dataset.flash) $('saveFlow').textContent = editing ? 'Update flow' : 'Save';
  // The same Save next to ▶ Continue, where it is easy to find after ■ Stop.
  $('saveTop').hidden = !has || recording;
  $('saveTop').disabled = busy;
  if (!$('saveFlow').dataset.flash) $('saveTop').textContent = editing ? '💾 Update flow' : '💾 Save';
  $('saveTop').title = editing ? 'Save the changes as a new version of this flow' : 'Save this recording as a flow (Saved flows tab)';
  $('saveFlow').classList.toggle('primary', editing);
  $('saveNew').hidden = !editing;
  $('saveNew').disabled = !has || recording;
  $('clear').disabled = !has || recording;
  $('empty').hidden = has;
  $('count').textContent = plural(countSteps(steps), 'step');

  const list = $('steps');
  const box = list.parentElement;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  list.replaceChildren();
  const offsets = flowOffsets(steps);
  const depths = ifDepths(steps);
  let num = 0;
  let inLoop = false;
  steps.forEach((s, i) => {
    if (s.type === 'pause') {
      const what = s.reason === 'stopped' ? '■ Stopped, then continued' : '❚❚ Paused';
      list.append(el('li', 'pause', s.tEnd ? `${what} · ${fmtDur(s.tEnd - s.t)} (not recorded)` : `${what} — nothing is recorded until you resume`));
      return;
    }
    const gap = waitBefore(steps, i);
    if (gap >= WAIT_MS) {
      const idle = gap >= LONG_IDLE_MS;
      const w = el('li', 'wait' + (idle ? ' idle' : ''), idle ? `⏳ idle ${fmtDur(gap)} — not waited on replay` : `⏳ wait ${fmtDur(gap)}`);
      if (!recording) {
        const x = el('button', 'del', '×');
        x.title = 'Remove this wait';
        x.addEventListener('click', () => send({ type: 'updateStep', id: s.id, patch: { waitMs: 0 } }));
        w.append(' ', x);
      }
      list.append(w);
    }

    if (s.type === 'loopEnd') inLoop = false;
    const li = el('li', 'step' + (inLoop ? ' inloop' : '') + (s.type === 'loopStart' || s.type === 'loopEnd' ? ' loopmark' : '') +
      (isIfMarker(s) ? ' ifmark' : '') + (depths[i] ? ' inif' : ''));
    if (depths[i]) li.style.setProperty('--d', String(depths[i]));
    li.dataset.id = s.id || '';
    if (state.insertAfter && state.insertAfter === s.id) li.classList.add('inshere');
    if (s.type === 'loopStart') inLoop = true;
    // Only actions are numbered (as in the export and the flow check); ⑂ rows, loop ends and notes are not.
    const isAct = !isIfMarker(s) && !['note', 'loopEnd'].includes(s.type);
    li.append(el('span', 'num', isAct ? String(++num) : ''));
    const body = stepBody(s);
    if (s.type === 'navigate' && s.transition !== 'start' && s.tEnd - s.t >= 500) body.append(el('div', 'load', `page load ${fmtDur(s.tEnd - s.t)}`));
    li.append(body);

    const meta = el('div', 'meta');
    meta.append(el('span', 'time', '+' + fmtOffset(offsets[i] || 0)));
    const btns = el('div', 'stepbtns');
    if (isIfMarker(s)) {
      // ⑂ Block rows (also while recording): change the condition, add cases, insert steps into a case, remove.
      const b = (txt, title, fn, cls = 'del') => { const x = el('button', cls, txt); x.title = title; x.addEventListener('click', fn); btns.append(x); };
      if (s.type === 'ifStart' || s.type === 'elif') {
        b('✎', 'Change the condition', () => { blockEdit = blockEdit?.id === s.id && blockEdit.mode === 'cond' ? null : { id: s.id, mode: 'cond' }; render(); });
      }
      if (s.type === 'ifStart') {
        b('+ Else if', 'Add another case (checked when the cases above are false)', () => { blockEdit = { id: s.id, mode: 'elif' }; render(); }, 'del addcase');
        if (!steps.some((x) => x.type === 'else' && x.blockId === s.blockId)) {
          b('+ Else', 'Add the case for "none of the above"', () => send({ type: 'ifBranch', kind: 'else', blockId: s.blockId }), 'del addcase');
        }
      }
      b('⤵', s.type === 'ifEnd' ? 'Insert new steps after the block' : 'Insert new steps into this case', () => send({ type: 'setInsert', id: state.insertAfter === s.id ? null : s.id }),
        'del' + (state.insertAfter === s.id ? ' on' : ''));
      if (s.type !== 'ifEnd') {
        b('×', s.type === 'ifStart' ? 'Remove the If block (its steps stay and then always run)' : 'Remove this case and its steps', () => {
          const caseSteps = (() => { let n = 0; for (let j = i + 1; j < steps.length && !(steps[j].blockId === s.blockId && isIfMarker(steps[j])); j++) n++; return n; })();
          const ask = s.type === 'ifStart' ? 'Remove this If block? Its steps stay in the flow and will then always run.'
            : `Remove this ${s.type === 'else' ? 'Else' : 'Else if'} case${caseSteps ? ` and its ${plural(caseSteps, 'step')}` : ''}?`;
          if (confirm(ask)) send({ type: 'deleteStep', id: s.id });
        });
      }
    } else if (!recording) {
      // Editing tools (only when not recording).
      if (editorFor(s)) {
        const ed = el('button', 'del', '✎');
        ed.title = 'Edit this step';
        ed.addEventListener('click', () => { editingStepId = editingStepId === s.id ? null : s.id; render(); });
        btns.append(ed);
      }
      if (isWhen(s.when)) { // old per-step condition (flows from 3.6–3.10 that could not be turned into a block)
        const cond = el('button', 'del' + (isWhen(s.when) ? ' on' : ''), '⑂');
        cond.title = isWhen(s.when) ? `Runs only if ${whenText(s.when)} — click to change` : 'Run this step only if … (a variable, a text on the page or the page URL)';
        cond.addEventListener('click', () => { whenStepId = whenStepId === s.id ? null : s.id; editingStepId = null; render(); });
        btns.append(cond);
      }
      const ins = el('button', 'del', '⤵');
      ins.title = state.insertAfter === s.id ? 'Cancel: add new steps at the end again' : 'Insert new steps after this step';
      if (state.insertAfter === s.id) ins.classList.add('on');
      ins.addEventListener('click', () => send({ type: 'setInsert', id: state.insertAfter === s.id ? null : s.id }));
      btns.append(ins);
      const movable = !['loopStart', 'loopEnd'].includes(s.type) && s.transition !== 'start';
      if (movable) {
        const up = el('button', 'del', '↑');
        up.title = 'Move up';
        up.addEventListener('click', () => send({ type: 'moveStep', id: s.id, dir: -1 }));
        const down = el('button', 'del', '↓');
        down.title = 'Move down';
        down.addEventListener('click', () => send({ type: 'moveStep', id: s.id, dir: 1 }));
        btns.append(up, down);
      }
    }
    if (recording && s.type !== 'pause' && !isIfMarker(s)) {
      // While recording: choose where the next recorded steps go (e.g. into an If case that is already closed).
      const here = state.insertAfter === s.id;
      const ins = el('button', 'del' + (here ? ' on' : ''), '⤵');
      ins.title = here ? 'Cancel: record at the end again'
        : 'Record the next steps after this step';
      ins.addEventListener('click', () => send({ type: 'setInsert', id: here ? null : s.id }));
      btns.append(ins);
    }
    if (s.type !== 'loopEnd' && !isIfMarker(s)) {
      const del = el('button', 'del', '×');
      del.title = s.type === 'loopStart' ? 'Remove the loop (its steps stay as normal steps)' : 'Remove this step';
      del.addEventListener('click', () => send({ type: 'deleteStep', id: s.id }));
      btns.append(del);
    }
    meta.append(btns);
    li.append(meta);
    if (!recording && editingStepId === s.id) li.append(editorFor(s));
    if (!recording && whenStepId === s.id) li.append(whenEditor(s));
    if (blockEdit?.id === s.id) li.append(blockEditor(s, blockEdit.mode));
    list.append(li);
    if (state.insertAfter === s.id) {
      // Where the next new steps will go.
      const mark = el('li', 'insmark');
      if (recording) {
        mark.textContent = paused ? '▼ new steps go here (recording paused)' : '● recording here — new steps are inserted at this point';
      } else {
        mark.append('▼ New steps go here — press ', el('b', '', '▶ Record here'), ' (or add a ⏸ approval). ');
        const cancel = el('button', 'del', 'cancel');
        cancel.addEventListener('click', () => send({ type: 'setInsert', id: null }));
        mark.append(cancel);
      }
      list.append(mark);
      if (recording) requestAnimationFrame(() => mark.scrollIntoView({ block: 'nearest' }));
    }
  });
  if (recording && atBottom) box.scrollTop = box.scrollHeight;

  updateTimer();
  clearInterval(timerId);
  if (recording) timerId = setInterval(updateTimer, 1000);
}

function updateTimer() {
  const { startedAt, stoppedAt, recording, steps } = state;
  if (!startedAt) return ($('timer').textContent = '00:00');
  if (state.editingFlowId || state.insertAfter) {
    // Editing a saved flow: show the flow's own length, not the time since it was first recorded.
    const offs = flowOffsets(steps).filter((x) => x != null);
    return ($('timer').textContent = fmtOffset(offs.length ? offs[offs.length - 1] : 0));
  }
  const end = recording ? Date.now() : stoppedAt || Date.now();
  $('timer').textContent = fmtOffset(end - startedAt - pausedBefore(steps, end, end)); // active time only
}

// ---------------------------------------------------------------- files
function fileStamp(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const slug = (s) => (s || 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'flow';

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = old), 1200);
}

// ---------------------------------------------------------------- recording controls
$('toggle').addEventListener('click', () => {
  if (state.recording) return send({ type: 'stop' });
  if (replayer) return;
  send({ type: state.steps.length ? 'continue' : 'start' });
});
$('secondary').addEventListener('click', () => {
  if (state.recording) return send({ type: state.paused ? 'resume' : 'pause' });
  if (!confirm('Start a new recording? The current one will be replaced (save or export it first if you need it).')) return;
  send({ type: 'start' });
});
$('clear').addEventListener('click', () => { if (confirm('Delete this recording?')) send({ type: 'clear' }); });
$('exportMd').addEventListener('click', () => download(`recording-${fileStamp(state.startedAt)}.md`, toMarkdown(state), 'text/markdown'));
$('exportJson').addEventListener('click', () => download(`recording-${fileStamp(state.startedAt)}.json`, JSON.stringify(state, null, 2), 'application/json'));
$('copyMd').addEventListener('click', (e) => copy(toMarkdown(state), e.currentTarget));
$('noteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('noteInput').value.trim();
  if (!text) return;
  send({ type: 'note', text });
  $('noteInput').value = '';
});

// ---------------------------------------------------------------- check text
let ckScope = null; // area target picked in the page, or null for the whole page
let ckTabId = null;

function setCkScope(scope) {
  ckScope = scope;
  $('ckScope').textContent = scope ? `"${scope.name}"` : 'whole page';
  $('ckClear').hidden = !scope;
}

function closeCheckForm() {
  $('checkForm').hidden = true;
  if (ckTabId != null) pageCall(ckTabId, { type: 'list:cancel' }).catch(() => {});
}

$('checkBtn').addEventListener('click', async () => {
  if (!$('checkForm').hidden) return closeCheckForm();
  $('ckMsg').textContent = '';
  setCkScope(null);
  $('checkForm').hidden = false;
  try {
    const tab = await activeTab();
    ckTabId = tab.id;
    // Prefill with the text selected on the page (any frame).
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => String(getSelection() || '').trim() });
    const sel = res.map((r) => r.result).find(Boolean);
    $('ckWords').value = sel ? sel.slice(0, 300) : '';
  } catch (err) {
    $('ckMsg').textContent = err.message;
  }
  $('ckWords').focus();
});
$('ckClose').addEventListener('click', closeCheckForm);
$('ckClear').addEventListener('click', () => setCkScope(null));

$('ckPick').addEventListener('click', async () => {
  try {
    const tab = await activeTab();
    ckTabId = tab.id;
    $('ckPick').disabled = true;
    $('ckMsg').textContent = 'Click the area in the page (↑ / ↓ to make it bigger / smaller, Esc to cancel)';
    const r = await pageCall(tab.id, { type: 'list:pick', mode: 'area' });
    $('ckMsg').textContent = '';
    if (!r.cancelled) setCkScope(r.area);
  } catch (err) {
    $('ckMsg').textContent = err.message;
  } finally {
    $('ckPick').disabled = false;
  }
});

$('checkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const keywords = $('ckWords').value.split('\n').map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) { $('ckMsg').textContent = 'Enter at least one keyword.'; return; }
  const check = { keywords, mode: $('ckMode').value, match: $('ckMatch').value, caseSensitive: $('ckCase').checked, scope: ckScope };
  if (check.match === 'regex') {
    for (const k of keywords) {
      try { new RegExp(k, 'u'); } catch (err) { $('ckMsg').textContent = `Invalid regex "${k}": ${err.message}`; return; }
    }
  }
  try {
    const tab = await activeTab();
    // Variables captured earlier in this recording are known: test the check with their recorded values.
    const known = Object.fromEntries(state.steps.filter((x) => x.type === 'capture').map((x) => [x.varName, x.sample || '']));
    const now = { ...check, keywords: check.keywords.map((k) => k.replace(VAR_RE, (m, n) => (n in known ? known[n] : m))) };
    const result = await pageCall(tab.id, { type: 'check:run', check: now, timeout: 0 });
    delete result.ok;
    check.textLen = result.textLength; // replay waits until the area has roughly this much text again
    await send({ type: 'addStep', step: { type: 'verify', t: Date.now(), tabId: tab.id, url: tab.url, title: tab.title, check, result } });
    $('ckWords').value = '';
    setCkScope(null);
    $('checkForm').hidden = true;
  } catch (err) {
    $('ckMsg').textContent = err.message;
  }
});

// ---------------------------------------------------------------- for each item (loop)
let lpPicking = false;

$('lpPickNext').addEventListener('click', async () => {
  const L = state.activeLoop;
  if (!L) return;
  const start = state.steps.find((x) => x.id === L.id);
  if (lpPicking) {
    lpPicking = false;
    pageCall(start.tabId, { type: 'list:cancel' }).catch(() => {});
    return render();
  }
  try {
    lpPicking = true;
    $('lpNextInfo').textContent = 'click the "Next page" / "Load more" button in the page (Esc cancels)';
    $('lpPickNext').textContent = 'Cancel';
    const r = await pageCall(start.tabId, { type: 'list:pick', mode: 'next', list: L.list });
    lpPicking = false;
    if (!r.cancelled) await send({ type: 'updateStep', id: L.id, patch: { loop: { ...start.loop, next: r.next } } });
  } catch (err) {
    lpPicking = false;
    $('lpMsg').textContent = err.message;
  }
  render();
});

$('lpNoNext').addEventListener('click', async () => {
  const L = state.activeLoop;
  const start = L && state.steps.find((x) => x.id === L.id);
  if (start) await send({ type: 'updateStep', id: L.id, patch: { loop: { ...start.loop, next: null } } });
});

$('loopBtn').addEventListener('click', async () => {
  try {
    const tab = await activeTab();
    $('loopBtn').disabled = true;
    $('lpMsg').textContent = '';
    const r = await pageCall(tab.id, { type: 'list:pick', mode: 'item' });
    if (r.cancelled) return;
    const id = crypto.randomUUID();
    await send({ type: 'addStep', step: {
      type: 'loopStart', id, t: Date.now(), tabId: tab.id, url: tab.url, title: tab.title,
      loop: { list: r.list, next: r.next, count: r.count, maxPages: 20, maxItems: 100, onFail: 'continue' },
    } });
    $('lpMaxPages').value = 20;
    $('lpMax').value = 100;
    $('lpFail').value = 'continue';
    await send({ type: 'setLoop', loop: { id, list: r.list, hasNext: !!r.next } });
  } catch (err) {
    alert(err.message);
  } finally {
    $('loopBtn').disabled = false;
  }
});

$('lpEnd').addEventListener('click', async () => {
  const L = state.activeLoop;
  if (!L) return;
  const startIdx = state.steps.findIndex((x) => x.id === L.id);
  const start = state.steps[startIdx];
  const body = state.steps.slice(startIdx + 1);
  if (!body.some((x) => x.target?.inItem) &&
      !confirm('No click on a list item was recorded inside this loop, so every round would do exactly the same thing. End the loop anyway?')) return;
  if (start) {
    await send({ type: 'updateStep', id: L.id, patch: { loop: {
      ...start.loop,
      maxPages: Math.max(1, Number($('lpMaxPages').value) || 20),
      maxItems: Math.max(1, Number($('lpMax').value) || 100),
      onFail: $('lpFail').value,
    } } });
  }
  await send({ type: 'addStep', step: { type: 'loopEnd', loopId: L.id, t: Date.now() } });
  await send({ type: 'setLoop', loop: null });
});

// ---------------------------------------------------------------- editing steps
let editingStepId = null;

// Type / Set steps: replace the value (default), add to / subtract from the number in the field, or append text;
// optionally keep the resulting value in a variable.
function valueOpFields(s, input, replaceLabel) {
  const box = el('div', 'valueop');
  const mode = selectEl(Object.entries(VALUE_OPS), s.valueOp || 'replace');
  const lbl = el('label', '', '');
  const save = inputEl(s.saveAs || '');
  save.placeholder = 'optional, e.g. NEW_QTY';
  save.className = 'vname';
  const sync = () => {
    lbl.firstChild.textContent = { replace: replaceLabel, add: 'Amount to add (a number or a variable, e.g. {{STEP}})',
      sub: 'Amount to subtract (a number or a variable, e.g. {{STEP}})', append: 'Text to append' }[mode.value];
  };
  lbl.append(document.createTextNode(''), input);
  mode.addEventListener('change', sync);
  sync();
  box.append(field('What to do', mode), lbl, field('Save the new value as variable', save));
  return {
    box,
    read: () => {
      const name = save.value.trim().replace(/^\{\{|\}\}$/g, '');
      if (name && !/^[A-Za-z_][\w.-]*$/.test(name)) throw new Error('Variable name: letters, digits and _ only (e.g. NEW_QTY)');
      if (['add', 'sub'].includes(mode.value) && !input.value.trim()) throw new Error('Enter the amount, e.g. 1 or {{STEP}}');
      return { valueOp: mode.value === 'replace' ? null : mode.value, saveAs: name || null };
    },
  };
}

// 🌐 HTTP request: the fields of a new or edited request step.
function httpFields(s = {}) {
  const box = el('div', 'httpform');
  let last = null;
  box.addEventListener('focusin', (e) => { if (e.target.matches('input[type=text], textarea')) last = e.target; });
  const method = selectEl(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => [m, m]), (s.method || 'POST').toUpperCase());
  const url = inputEl(s.url || '');
  url.placeholder = 'http://host/api/path — variables allowed, e.g. {{BASE_URL}}/api';
  const from = selectEl([['extension', 'from the extension (any URL; auth only via headers/body)'], ['page', 'from the current page (same site, uses your login)']], s.from || 'extension');
  const headers = el('textarea');
  headers.rows = 2;
  headers.placeholder = 'One per line, e.g.\nAuthorization: Bearer {{TOKEN}}';
  headers.value = (s.headers || []).filter((h) => h && h.name).map((h) => `${h.name}: ${h.value}`).join('\n');
  const bodyType = selectEl([['json', 'JSON'], ['form', 'Form fields (name=value per line)'], ['text', 'Plain text'], ['none', 'No body']], s.bodyType || 'json');
  const body = el('textarea');
  body.rows = 5;
  body.className = 'mono';
  body.value = s.body || '';
  const expect = inputEl(s.expect || '2xx');
  expect.placeholder = '2xx, 200, 200,201, 4xx or any';
  const save = el('textarea');
  save.rows = 2;
  save.placeholder = 'Optional, one per line: path → VARIABLE\ne.g. data.id → ORDER_ID   ·   @status → STATUS   ·   @text → RESPONSE';
  save.value = (s.save || []).filter((x) => x && x.varName).map((x) => `${x.path || '@text'} → ${x.varName}`).join('\n');
  const timeout = inputEl(String(s.timeoutSec || 30), 'number');
  timeout.min = '1';
  timeout.style.width = '70px';
  const sync = () => {
    const noBody = ['GET'].includes(method.value) || bodyType.value === 'none';
    body.hidden = noBody;
    body.placeholder = bodyType.value === 'json' ? '{\n  "content": "Build finished",\n  "receiver": "{{WELINK_GROUP_ID}}",\n  "auth": "{{TOKEN}}"\n}'
      : bodyType.value === 'form' ? 'name=value\nreceiver={{GROUP}}' : 'text';
  };
  method.addEventListener('change', sync);
  bodyType.addEventListener('change', sync);
  sync();
  const top = el('div', 'crow');
  top.append(method, url);
  box.append(top, field('Send', from), field('Headers', headers), field('Body', bodyType), body,
    field('Expected status (otherwise the step fails)', expect), field('Save from the response', save), field('Timeout (s)', timeout));
  const read = () => {
    const u = url.value.trim();
    if (!u) throw new Error('Enter the URL');
    const hs = headers.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const k = l.indexOf(':');
      if (k <= 0) throw new Error(`Header "${l}" must look like Name: value`);
      return { name: l.slice(0, k).trim(), value: l.slice(k + 1).trim() };
    });
    const sv = save.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.*?)\s*(?:→|->|=>)\s*\{?\{?([A-Za-z_][\w.-]*)\}?\}?$/);
      if (!m) throw new Error(`"${l}" must look like path → VARIABLE (e.g. data.id → ORDER_ID)`);
      return { path: m[1].trim() || '@text', varName: m[2] };
    });
    const bt = method.value === 'GET' ? 'none' : bodyType.value;
    if (bt === 'json' && body.value.trim()) {
      // Variables are filled in at run time; check the JSON with placeholder values.
      const probe = body.value.replace(/"[^"\n]*\{\{[^}]+\}\}[^"\n]*"/g, '"x"').replace(/\{\{[^}]+\}\}/g, '0');
      try { JSON.parse(probe); } catch (e) { throw new Error(`The JSON body is not valid: ${e.message}`); }
    }
    const ex = expect.value.trim() || '2xx';
    if (!/^(any|(\dxx|\d{3})([\s,]+(\dxx|\d{3}))*)$/i.test(ex)) throw new Error('Expected status: e.g. 2xx, 200, "200, 201" or any');
    return { method: method.value, url: u, from: from.value, headers: hs, bodyType: bt, body: bt === 'none' ? '' : body.value,
      expect: ex, save: sv, timeoutSec: Math.max(1, Number(timeout.value) || 30) };
  };
  return { box, read, target: () => last || url, focus: () => url.focus() };
}

function field(labelText, input) {
  const l = el('label', '', labelText);
  l.append(input);
  return l;
}
function inputEl(value, type = 'text') {
  const i = el('input');
  i.type = type;
  i.value = value ?? '';
  return i;
}
function selectEl(options, value) {
  const sel = el('select');
  options.forEach(([v, t]) => { const o = el('option', '', t); o.value = v; sel.append(o); });
  sel.value = value;
  return sel;
}

// Every variable this flow can use: asked / captured in its steps, flow defaults, environments, loop built-ins.
// ---------------------------------------------------------------- ⑂ conditions ("only if")
// A small form: variable, operator, value. onSave(when) gets { var, op, value }.
function whenFields(initial = {}) {
  const box = el('div', 'whenrow');
  const src = selectEl(Object.entries(WHEN_SOURCES), whenSource(initial));
  src.title = 'What to look at: a variable, a text on the page (e.g. "Sign in" when the login expired) or the page URL (e.g. /login)';
  const v = inputEl(initial.var || '');
  v.placeholder = 'VARIABLE';
  v.className = 'vname';
  const listId = 'whenvars-' + Math.random().toString(36).slice(2, 7);
  const dl = el('datalist');
  dl.id = listId;
  knownVars().forEach(([n, src2]) => { const o = el('option'); o.value = n; o.label = src2; dl.append(o); });
  v.setAttribute('list', listId);
  const op = el('select');
  const val = inputEl(initial.value || '');
  const PAGE_OP_LABELS = { contains: 'shows', notContains: 'does not show' };
  const fillOps = (keep) => {
    const kind = src.value;
    op.replaceChildren();
    WHEN_SOURCE_OPS[kind].forEach((k) => {
      const o = el('option', '', kind === 'page' ? PAGE_OP_LABELS[k] : WHEN_OPS[k]);
      o.value = k;
      op.append(o);
    });
    op.value = WHEN_SOURCE_OPS[kind].includes(keep) ? keep : WHEN_SOURCE_OPS[kind][0];
  };
  const sync = () => {
    v.hidden = src.value !== 'var';
    val.hidden = !whenNeedsValue(op.value);
    val.placeholder = src.value === 'page' ? 'text on the page, e.g. Sign in' : src.value === 'url' ? 'e.g. /login' : 'value';
  };
  fillOps(initial.op || (whenSource(initial) === 'var' ? 'eq' : 'contains'));
  src.addEventListener('change', () => { fillOps(src.value === 'var' ? 'eq' : 'contains'); sync(); }); // each source starts with its usual comparison
  op.addEventListener('change', sync);
  sync();
  box.append(el('span', 'xinfo', 'only if'), src, v, dl, op, val);
  const read = () => {
    const kind = src.value;
    if (kind !== 'var') {
      if (!val.value.trim()) throw new Error(kind === 'page' ? 'Enter the text to look for on the page' : 'Enter a part of the URL, e.g. /login');
      if (['regex', 'notRegex'].includes(op.value)) { try { new RegExp(val.value); } catch (e) { throw new Error(`Regex is not valid: ${e.message}`); } }
      return { source: kind, op: op.value, value: val.value.trim() };
    }
    const name = v.value.trim().replace(/^\{\{|\}\}$/g, '');
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new Error('Enter the variable name, e.g. TYPE (without {{ }})');
    if (['regex', 'notRegex'].includes(op.value)) { try { new RegExp(val.value); } catch (e) { throw new Error(`Regex is not valid: ${e.message}`); } }
    return { var: name, op: op.value, ...(whenNeedsValue(op.value) ? { value: val.value } : {}) };
  };
  return { box, read, focus: () => (src.value === 'var' && !v.value ? v : val).focus() };
}

// 🌐 Add an HTTP request step (while recording, or while editing at the ⤵ point / at the end).
// 🧪 Test step fields: name, expected result, conditions (all must be true), what to do when it fails.
function testFields(initial = {}) {
  const box = el('div', 'testfields');
  const name = inputEl(initial.name || '');
  name.placeholder = 'e.g. TC-03 Login shows the dashboard';
  const expected = inputEl(initial.expected || '');
  expected.placeholder = 'e.g. The dashboard opens with the user name';
  const list = el('div', 'testconds');
  const rows = [];
  const addRow = (c = {}) => {
    const f = whenFields(c);
    f.box.firstChild.textContent = rows.length ? 'and' : 'check';
    const x = el('button', 'del', '×');
    x.type = 'button';
    x.title = 'Remove this condition';
    x.addEventListener('click', () => {
      if (rows.length === 1) return;
      rows.splice(rows.indexOf(f), 1);
      f.box.remove();
      rows.forEach((r, k) => { r.box.firstChild.textContent = k ? 'and' : 'check'; });
    });
    f.box.append(x);
    rows.push(f);
    list.append(f.box);
  };
  (initial.conds && initial.conds.length ? initial.conds : [{ source: 'page', op: 'contains' }]).forEach(addRow);
  const more = el('button', '', '+ condition');
  more.type = 'button';
  more.title = 'Add another condition — the test step passes only when all of them are true';
  more.addEventListener('click', () => { addRow({ source: 'page', op: 'contains' }); rows[rows.length - 1].focus(); });
  const onFail = selectEl([['continue', 'mark FAIL and continue'], ['stop', 'stop the run (Retry / Skip / Stop)']], initial.onFail === 'stop' ? 'stop' : 'continue');
  box.append(field('Test step name', name), field('Expected result (optional)', expected),
    el('div', 'xinfo', 'Passes when all of these are true:'), list, more, field('If it fails:', onFail));
  return {
    box,
    focus: () => name.focus(),
    read: () => {
      if (!name.value.trim()) throw new Error('Give the test step a name, e.g. TC-03 Login shows the dashboard');
      const conds = rows.map((r) => r.read());
      return { name: name.value.trim(), expected: expected.value.trim(), conds, onFail: onFail.value };
    },
  };
}

function openTestForm() {
  const f = $('testForm');
  f.replaceChildren();
  const tf = testFields();
  const msg = el('span', 'xinfo');
  const add = el('button', 'primary', 'Add test step');
  const cancel = el('button', '', 'Cancel');
  add.type = cancel.type = 'button';
  add.addEventListener('click', async () => {
    let t;
    try { t = tf.read(); } catch (err) { msg.textContent = err.message; return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // waitMs 0: the time spent filling this form is not a wait (the page conditions wait a few seconds by themselves)
    await send({ type: 'addStep', step: { type: 'test', t: Date.now(), waitMs: 0, tabId: tab?.id, url: tab?.url, ...t } });
    f.hidden = true;
  });
  cancel.addEventListener('click', () => { f.hidden = true; });
  const row = el('div', 'crow');
  row.append(add, cancel, msg);
  f.append(el('div', 'chead', '🧪 Test step'), tf.box, row,
    el('div', 'xinfo', 'Nothing is clicked — at this point of the run the conditions are checked, and the run report lists every test step as PASS / FAIL.'));
  f.hidden = false;
  requestAnimationFrame(tf.focus);
}
$('testBtn').addEventListener('click', () => { if ($('testForm').hidden) openTestForm(); else $('testForm').hidden = true; });

function openHttpForm() {
  const f = $('httpForm');
  f.replaceChildren();
  const hf = httpFields();
  const msg = el('span', 'xinfo');
  const add = el('button', 'primary', 'Add request');
  const cancel = el('button', '', 'Cancel');
  add.type = cancel.type = 'button';
  add.addEventListener('click', async () => {
    let req;
    try { req = hf.read(); } catch (err) { msg.textContent = err.message; return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await send({ type: 'addStep', step: { type: 'http', t: Date.now(), tabId: tab?.id, ...req } });
    f.hidden = true;
  });
  cancel.addEventListener('click', () => { f.hidden = true; });
  const row = el('div', 'crow');
  row.append(add, cancel, varPicker(hf.target), msg);
  f.append(el('div', 'chead', '🌐 HTTP request — sent when the flow reaches this step'), hf.box, row);
  f.hidden = false;
  requestAnimationFrame(hf.focus);
}
$('httpBtn').addEventListener('click', () => { if ($('httpForm').hidden) openHttpForm(); else $('httpForm').hidden = true; });

// Recording: "⑂ If" → the steps recorded next get the condition, until "End if".
// ⑂ The If form at the top: a new block (recording or editing) or, while recording inside a block, an Else if case.
function openIfForm(elif = false) {
  const f = $('ifForm');
  f.replaceChildren();
  const fields = whenFields();
  const msg = el('span', 'xinfo');
  const start = el('button', 'primary', state.recording ? 'Start' : 'Add If block');
  const cancel = el('button', '', 'Cancel');
  start.type = cancel.type = 'button';
  start.addEventListener('click', async () => {
    let cond;
    try { cond = fields.read(); } catch (err) { msg.textContent = err.message; return; }
    await send(elif ? { type: 'ifBranch', kind: 'elif', cond } : { type: 'ifOpen', cond });
    f.hidden = true;
  });
  cancel.addEventListener('click', () => { f.hidden = true; });
  const row = el('div', 'crow');
  row.append(start, cancel, msg);
  const help = state.recording
    ? 'Do the steps for this case in the page. Then press Else if… / Else for other cases, or End if.'
    : `An empty If block is added ${state.insertAfter ? 'at the ⤵ point' : 'at the end'}; new steps (▶ Record here, 🌐, ⏸, 🖱) go into it. Use + Else if / + Else on its row for more cases.`;
  f.append(el('div', 'chead', elif ? '⑂ Else if — another case:' : '⑂ If'), fields.box, row,
    el('div', 'xinfo', 'Example: page text · shows · "Sign in" → the login steps; they only run when the session has expired.'),
    el('div', 'xinfo', help));
  f.hidden = false;
  requestAnimationFrame(fields.focus);
}
// ---------------------------------------------------------------- "+ Add ▾" menu
function closeAddMenu() {
  $('addMenu').hidden = true;
  $('addBtn').setAttribute('aria-expanded', 'false');
}
$('addBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('clickBtn').dataset.picking) { $('clickBtn').click(); return; } // cancel the click picker
  const open = $('addMenu').hidden;
  $('addMenu').hidden = !open;
  $('addBtn').setAttribute('aria-expanded', String(open));
  if (open) [...$('addMenu').children].find((b) => !b.hidden)?.focus();
});
$('addMenu').addEventListener('click', () => { closeAddMenu(); setTimeout(render, 0); }); // after the item's own handler
document.addEventListener('click', (e) => { if (!$('addMenu').hidden && !e.target.closest('.addwrap')) closeAddMenu(); });
document.addEventListener('keydown', (e) => {
  if ($('addMenu').hidden) return;
  if (e.key === 'Escape') { closeAddMenu(); $('addBtn').focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = [...$('addMenu').children].filter((b) => !b.hidden);
    const k = items.indexOf(document.activeElement);
    items[(k + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    e.preventDefault();
  }
});

$('ifBtn').addEventListener('click', () => { if ($('ifForm').hidden) openIfForm(); else $('ifForm').hidden = true; });
$('ifElse').addEventListener('click', () => send({ type: 'ifBranch', kind: 'else' }));
$('ifElif').addEventListener('click', () => openIfForm(true));
$('ifEnd').addEventListener('click', () => send({ type: 'ifClose' }));

// Under an If / Else if row: change its condition, or (mode 'elif') add an Else if case to the block.
function blockEditor(s, mode) {
  const box = el('div', 'stepedit');
  const fields = whenFields(mode === 'cond' ? s.cond || {} : {});
  const msg = el('span', 'xinfo');
  const save = el('button', 'primary', mode === 'cond' ? 'Save' : 'Add Else if');
  const cancel = el('button', '', 'Cancel');
  save.type = cancel.type = 'button';
  save.addEventListener('click', async () => {
    let cond;
    try { cond = fields.read(); } catch (err) { msg.textContent = err.message; return; }
    blockEdit = null;
    if (mode === 'cond') await send({ type: 'updateStep', id: s.id, patch: { cond } });
    else await send({ type: 'ifBranch', kind: 'elif', cond, blockId: s.blockId });
  });
  cancel.addEventListener('click', () => { blockEdit = null; render(); });
  const row = el('div', 'crow');
  row.append(save, cancel, msg);
  box.append(el('div', 'xinfo', mode === 'cond' ? '⑂ Condition of this case' : '⑂ Else if — checked when the cases above are false'), fields.box, row);
  requestAnimationFrame(fields.focus);
  return box;
}

// Editing: ⑂ on a step — set / change / remove its condition (optionally for the following steps too).
function whenEditor(s) {
  const box = el('div', 'stepedit');
  const isElse = whenSource(s.when) === 'else';
  const fields = whenFields(isElse ? {} : s.when || {});
  const idx = state.steps.findIndex((x) => x.id === s.id);
  // If / Else if / Else: "else" cases belong to the condition block above this step.
  const above = state.steps.slice(0, idx).reverse().find((x) => x.when?.group && x.when.group !== (s.when?.branch === 'if' ? s.when.group : null));
  const kindOpts = [['if', 'If (a new condition)']];
  if (above) kindOpts.push(['elif', `Else if (another case of the block above: ${whenText({ ...above.when, branch: 'if' }).slice(0, 40)}…)`], ['else', 'Else (none of the cases above ran)']);
  const kind = selectEl(kindOpts, isElse ? 'else' : s.when?.branch === 'elif' && above ? 'elif' : 'if');
  const syncKind = () => { fields.box.hidden = kind.value === 'else'; };
  kind.addEventListener('change', syncKind);
  syncKind();
  const rest = state.steps.slice(idx + 1).filter((x) => !['pause', 'loopEnd'].includes(x.type));
  const more = inputEl('0', 'number');
  more.min = '0';
  more.max = String(rest.length);
  more.style.width = '56px';
  const moreRow = el('label', 'check', 'also for the next');
  moreRow.append(more, ' steps');
  const msg = el('span', 'xinfo');
  const save = el('button', 'primary', 'Save');
  const remove = el('button', '', 'Remove condition');
  const cancel = el('button', '', 'Cancel');
  [save, remove, cancel].forEach((b) => { b.type = 'button'; });
  remove.hidden = !isWhen(s.when);
  const targets = () => [s, ...rest.slice(0, Math.max(0, Math.min(rest.length, Number(more.value) || 0)))];
  save.addEventListener('click', async () => {
    let when;
    try {
      if (kind.value === 'else') when = { source: 'else', group: above.when.group, branch: 'else' };
      else if (kind.value === 'elif') when = { ...fields.read(), group: above.when.group, branch: 'elif' };
      else when = { ...fields.read(), group: (s.when?.branch === 'if' && s.when.group) || Math.random().toString(36).slice(2, 8), branch: 'if' };
    } catch (err) { msg.textContent = err.message; return; }
    whenStepId = null;
    for (const t of targets()) await send({ type: 'updateStep', id: t.id, patch: { when } });
  });
  remove.addEventListener('click', async () => {
    whenStepId = null;
    for (const t of targets()) await send({ type: 'updateStep', id: t.id, patch: { when: null } });
  });
  cancel.addEventListener('click', () => { whenStepId = null; render(); });
  const row = el('div', 'crow');
  row.append(save, remove, cancel, msg);
  box.append(el('div', 'xinfo', '⑂ Run this step only if … (otherwise it is skipped on replay)'), kind, fields.box, moreRow, row);
  requestAnimationFrame(fields.focus);
  return box;
}

function knownVars() {
  const out = new Map();
  const add = (name, src) => { if (name && !out.has(name)) out.set(name, src); };
  for (const st of state.steps) {
    if (st.type === 'approval' && st.mode === 'input') add(st.varName, 'asked during the run');
    if (st.type === 'capture') add(st.varName, 'captured from the page');
    if (st.saveAs) add(st.saveAs, 'new value of a field');
    if (st.type === 'http') (st.save || []).forEach((x) => x && add(x.varName, 'from an HTTP response'));
  }
  (state.vars || []).forEach((v) => add(v.name, v.secret ? 'flow variable 🔒' : 'flow variable'));
  envs.forEach((e) => e.vars.forEach((v) => add(v.name, `environment ${e.name}`)));
  if (state.steps.some((st) => st.type === 'loopStart')) { add('item', 'current list item (loops)'); add('index', 'item number (loops)'); }
  return [...out];
}

// "Insert variable ▾": puts {{NAME}} at the cursor of `input`.
function varPicker(target, vars = knownVars()) {
  const sel = el('select', 'varpick');
  const first = el('option', '', vars.length ? 'Insert variable ▾' : 'no variables yet');
  first.value = '';
  sel.append(first);
  vars.forEach(([name, src]) => { const o = el('option', '', `{{${name}}} — ${src}`); o.value = name; sel.append(o); });
  sel.disabled = !vars.length;
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    const token = `{{${sel.value}}}`;
    const input = typeof target === 'function' ? target() : target; // a field, or "the field last used"
    if (!input) { sel.value = ''; return; }
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, a) + token + input.value.slice(b);
    input.focus();
    input.setSelectionRange?.(a + token.length, a + token.length);
    sel.value = '';
  });
  return sel;
}

// Returns an inline editor for a step, or null if the step has nothing editable.
const OPTIONAL_TYPES = ['click', 'dblclick', 'type', 'set', 'select', 'check', 'key', 'capture'];
// "Optional": skip the step (instead of failing) when its element is not on the page.
function optionalRow(s) {
  const row = el('label', 'check optrow');
  const cb = inputEl('', 'checkbox');
  cb.checked = !!s.optional;
  const secs = inputEl(String(s.optionalWait || 3), 'number');
  secs.min = '1';
  secs.max = '60';
  secs.style.width = '50px';
  row.append(cb, 'Optional — skip this step if the element does not appear within', secs, 's');
  row.title = 'For things that are only sometimes there: a cookie banner, a "What\'s new" popup, a Close button…';
  return { box: row, read: () => ({ optional: cb.checked || null, optionalWait: cb.checked ? Math.max(1, Math.min(60, Number(secs.value) || 3)) : null }) };
}

function editorFor(s) {
  const box = el('div', 'stepedit');
  let read = null;
  let makeVar = null; // { input, secret?, url? } — the value that "→ Make variable" turns into {{NAME}}
  let varTarget = null; // the text field "Insert variable ▾" writes into
  switch (s.type) {
    case 'type': {
      if (s.sensitive) {
        const i = inputEl(s.value || '');
        i.placeholder = '{{PASSWORD}}';
        box.append(field('Password — use a 🔒 secret variable, e.g. {{PASSWORD}} (empty = you type it during the run)', i));
        read = () => {
          const v = i.value.trim();
          if (v && !/^\{\{\s*[A-Za-z_][\w.-]*\s*\}\}$/.test(v)) throw new Error('For a password field only a variable like {{PASSWORD}} is allowed — never the password itself.');
          return { value: v || null };
        };
        makeVar = { input: i, secret: true };
        break;
      }
      const i = inputEl(s.value);
      const vo = valueOpFields(s, i, 'Text to type');
      box.append(vo.box);
      read = () => ({ value: i.value, ...vo.read() });
      makeVar = { input: i };
      break;
    }
    case 'set': {
      const i = inputEl(s.value);
      const vo = valueOpFields(s, i, 'Value');
      box.append(vo.box);
      read = () => ({ value: i.value, ...vo.read() });
      makeVar = { input: i };
      break;
    }
    case 'select': {
      const i = inputEl(s.value);
      box.append(field(s.type === 'select' ? 'Option to select (visible text)' : 'Value', i));
      read = () => ({ value: i.value });
      makeVar = { input: i };
      break;
    }
    case 'key': {
      const i = inputEl(s.key);
      box.append(field('Key (e.g. Enter, Escape, Ctrl+S)', i));
      read = () => ({ key: i.value.trim() || s.key });
      break;
    }
    case 'note': {
      const i = inputEl(s.text);
      box.append(field('Note', i));
      read = () => ({ text: i.value });
      varTarget = i;
      break;
    }
    case 'navigate': case 'urlchange': {
      const i = inputEl(s.url);
      box.append(field('URL (variables allowed, e.g. {{BASE_URL}}/merge_requests)', i));
      read = () => ({ url: i.value.trim() || s.url });
      makeVar = { input: i, url: true };
      break;
    }
    case 'check': {
      const sel = selectEl([['1', 'Check (tick)'], ['0', 'Uncheck']], s.checked ? '1' : '0');
      box.append(field('Checkbox', sel));
      read = () => ({ checked: sel.value === '1' });
      break;
    }
    case 'dialog': {
      if (s.kind === 'alert') return null;
      const sel = selectEl([['ok', 'OK'], ['cancel', 'Cancel']], s.kind === 'confirm' ? (s.result ? 'ok' : 'cancel') : (s.result == null ? 'cancel' : 'ok'));
      box.append(field('Answer', sel));
      let i = null;
      if (s.kind === 'prompt') { i = inputEl(s.result ?? ''); box.append(field('Text to enter', i)); }
      read = () => ({ result: s.kind === 'confirm' ? sel.value === 'ok' : sel.value === 'ok' ? i.value : null });
      if (i) makeVar = { input: i };
      break;
    }
    case 'capture': {
      const what = selectEl([['text', 'Visible text'], ['value', 'Field value'], ['attr', 'Attribute']], s.what || 'text');
      const attr = inputEl(s.attr || '');
      attr.placeholder = 'href';
      const regex = inputEl(s.regex || '');
      regex.placeholder = 'optional, e.g. #(\\d+)';
      const name = inputEl(s.varName);
      const row = el('div', 'crow');
      row.append(what, field('Attribute', attr));
      box.append(row, field('Regex (keeps the first ( ) group)', regex), field('Save as variable', name));
      read = () => {
        if (!/^[A-Za-z_][\w.-]*$/.test(name.value.trim())) throw new Error('Enter a variable name (letters, digits, _).');
        if (regex.value) { try { new RegExp(regex.value, 'u'); } catch (err) { throw new Error(`Invalid regex: ${err.message}`); } }
        if (what.value === 'attr' && !attr.value.trim()) throw new Error('Enter the attribute name, e.g. href');
        return { what: what.value, attr: what.value === 'attr' ? attr.value.trim() : undefined, regex: regex.value || undefined, varName: name.value.trim() };
      };
      break;
    }
    case 'approval': {
      const mode = selectEl([['approve', 'Wait for approval'], ['input', 'Ask for a value']], s.mode);
      const text = inputEl(s.text);
      const v = inputEl(s.varName || '');
      const sec = inputEl('', 'checkbox');
      sec.checked = !!s.secret;
      const row = el('div', 'crow');
      row.append(field('Save the answer as', v), field('🔒 secret', sec));
      box.append(mode, field('Message', text), row);
      let keepFill = null;
      if (s.fill) {
        keepFill = inputEl('', 'checkbox');
        keepFill.checked = true;
        box.append(field(`Type the answer into ${s.fill.kind}${s.fill.label ? ` "${s.fill.label}"` : ''}`, keepFill));
      }
      read = () => {
        if (mode.value === 'input' && !/^[A-Za-z_][\w.-]*$/.test(v.value.trim())) throw new Error('Enter a variable name (letters, digits, _).');
        return {
          mode: mode.value, text: text.value, varName: mode.value === 'input' ? v.value.trim() : undefined, secret: mode.value === 'input' && sec.checked,
          fill: mode.value === 'input' && keepFill?.checked ? s.fill : undefined,
        };
      };
      break;
    }
    case 'verify': {
      const c = s.check;
      const words = el('textarea');
      words.rows = 2;
      words.value = c.keywords.join('\n');
      const mode = selectEl([['present', 'must exist'], ['absent', 'must NOT exist']], c.mode);
      const match = selectEl([['contains', 'contains'], ['word', 'whole word'], ['regex', 'regex']], c.match);
      const cs = inputEl('', 'checkbox');
      cs.checked = !!c.caseSensitive;
      const row = el('div', 'crow');
      row.append(mode, match, field('Match case', cs));
      box.append(field('Keywords — one per line', words), row);
      varTarget = words;
      read = () => {
        const keywords = words.value.split('\n').map((k) => k.trim()).filter(Boolean);
        if (!keywords.length) throw new Error('Enter at least one keyword.');
        if (match.value === 'regex') keywords.forEach((k) => { try { new RegExp(k, 'u'); } catch (err) { throw new Error(`Invalid regex "${k}": ${err.message}`); } });
        // The result recorded earlier no longer applies to the changed check.
        return { check: { ...c, keywords, mode: mode.value, match: match.value, caseSensitive: cs.checked }, result: null };
      };
      break;
    }
    case 'loopStart': {
      const L = s.loop;
      const items = inputEl(L.maxItems || 100, 'number');
      const pages = inputEl(L.maxPages || 20, 'number');
      const fail = selectEl([['continue', 'On failure: next item'], ['stop', 'On failure: stop']], L.onFail || 'continue');
      const row = el('div', 'crow');
      row.append(field('Max items', items));
      if (L.next) row.append(field('Max pages', pages));
      row.append(fail);
      box.append(row);
      read = () => ({ loop: { ...L, maxItems: Math.max(1, +items.value || 100), maxPages: Math.max(1, +pages.value || 20), onFail: fail.value } });
      break;
    }
    case 'extract': {
      if (!s.spec.next) return null;
      const pages = inputEl(s.spec.maxPages || 20, 'number');
      box.append(field('Max pages', pages));
      read = () => ({ spec: { ...s.spec, maxPages: Math.max(1, +pages.value || 20) } });
      break;
    }
    case 'click': case 'dblclick':
      read = () => ({});
      break;
    case 'test': {
      const tf = testFields(s);
      box.append(tf.box);
      read = tf.read;
      break;
    }
    case 'http': {
      const hf = httpFields(s);
      box.append(hf.box);
      read = () => hf.read();
      varTarget = hf.target;
      break;
    }
    default:
      return null;
  }
  if (s.target && OPTIONAL_TYPES.includes(s.type)) {
    const opt = optionalRow(s);
    box.append(opt.box);
    const base = read;
    read = () => ({ ...base(), ...opt.read() });
  }
  const msg = el('span', 'xinfo');
  const save = el('button', 'primary', 'Apply');
  save.addEventListener('click', async () => {
    try {
      const patch = read();
      editingStepId = null;
      await send({ type: 'updateStep', id: s.id, patch });
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  const cancel = el('button', '', 'Cancel');
  cancel.addEventListener('click', () => { editingStepId = null; render(); });
  const row = el('div', 'crow');
  row.append(save, cancel);
  if (!varTarget && makeVar) varTarget = makeVar.input;
  if (varTarget) row.append(varPicker(varTarget));
  if (makeVar && !/\{\{/.test(makeVar.input.value)) {
    // Replace the recorded value with {{NAME}} and keep the recorded value as the flow's default.
    const mv = el('button', '', '→ Make variable');
    mv.title = 'Use a variable here instead of the fixed value';
    mv.addEventListener('click', async () => {
      const guess = (s.target?.label || s.target?.selector || (makeVar.url ? 'BASE_URL' : 'VALUE')).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'VALUE';
      const name = prompt('Variable name (letters, digits, _):', makeVar.secret ? 'PASSWORD' : guess);
      if (!name || !/^[A-Za-z_][\w.-]*$/.test(name.trim())) return;
      const n = name.trim();
      let value = makeVar.input.value;
      if (makeVar.url) {
        // For URLs the variable is the site part (https://host), so one flow can run on several systems.
        try { const u = new URL(value); value = u.origin; makeVar.input.value = `{{${n}}}` + makeVar.input.value.slice(u.origin.length); } catch (_) { makeVar.input.value = `{{${n}}}`; }
      } else {
        makeVar.input.value = `{{${n}}}`;
      }
      const vars = (state.vars || []).filter((v) => v.name !== n);
      vars.push(makeVar.secret ? { name: n, value: '', secret: true } : { name: n, value, secret: false });
      try {
        const patch = read(); // apply right away (re-rendering would otherwise lose the change)
        editingStepId = null;
        await send({ type: 'setVars', vars });
        await send({ type: 'updateStep', id: s.id, patch });
        $('varsBox').open = true;
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    row.append(mv);
  }
  row.append(msg);
  box.append(row);
  return box;
}

$('stopEdit').addEventListener('click', () => send({ type: 'stopEditing' }));

// ---------------------------------------------------------------- variables (flow defaults)
// True while the user is typing in a text field inside `box` (buttons and checkboxes don't count).
const isTyping = (box) => {
  const a = document.activeElement;
  return !!a && box.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'button'].includes(a.type)));
};
function varRow(v, onChange, onDelete, { nameEditable = true, sourceText = '', requiredToggle = false } = {}) {
  const row = el('div', 'varrow' + (requiredToggle ? ' withreq' : ''));
  const name = inputEl(v.name);
  name.className = 'vname';
  name.placeholder = 'NAME';
  name.readOnly = !nameEditable;
  const val = inputEl(v.secret ? '' : v.value, v.secret ? 'password' : 'text');
  val.placeholder = v.secret ? '🔒 asked at every run' : 'value';
  val.disabled = !!v.secret && nameEditable; // secrets are never stored, so no value to edit here
  const sec = el('label', 'check', '🔒');
  const cb = inputEl('', 'checkbox');
  cb.checked = !!v.secret;
  cb.title = 'Secret: never stored, asked at every run';
  sec.prepend(cb);
  const req = el('label', 'check req', 'Required');
  const rq = inputEl('', 'checkbox');
  rq.checked = !!v.required;
  rq.title = 'Required: the flow cannot be replayed until this variable has a value (from the environment, the flow default or typed when you run it)';
  req.title = rq.title;
  req.prepend(rq);
  const del = el('button', 'del', '×');
  del.title = 'Remove';
  const emit = () => onChange({ name: name.value.trim(), value: cb.checked ? '' : val.value, secret: cb.checked, ...(rq.checked ? { required: true } : {}) });
  name.addEventListener('change', emit);
  val.addEventListener('change', emit);
  cb.addEventListener('change', emit);
  rq.addEventListener('change', emit);
  del.addEventListener('click', onDelete);
  row.append(name, val, sec);
  if (requiredToggle) row.append(req);
  row.append(del);
  if (sourceText) row.append(el('span', 'src', sourceText));
  return row;
}

function renderVars() {
  if (isTyping($('varsBox'))) return; // don't rebuild while typing
  const vars = state.vars || [];
  const used = usedVars(state.steps);
  const missing = used.filter((n) => !vars.some((v) => v.name === n));
  $('varsInfo').textContent = used.length
    ? `— used: ${used.join(', ')}${missing.length ? ` · no default: ${missing.join(', ')} (set in an environment or at run time)` : ''}`
    : vars.length ? `— ${vars.length} defined` : '— none';
  const box = $('varsRows');
  box.replaceChildren();
  vars.forEach((v, k) => box.append(varRow(v,
    (nv) => send({ type: 'setVars', vars: vars.map((x, j) => (j === k ? nv : x)) }),
    () => send({ type: 'setVars', vars: vars.filter((_, j) => j !== k) }), { requiredToggle: true })));
  // Variables the steps use but the flow does not define yet (their value comes from an environment or the run form):
  // shown too, so they can be given a default or marked Required.
  missing.forEach((n) => {
    const row = varRow({ name: n, value: '', secret: false }, (nv) => send({ type: 'setVars', vars: [...vars, nv] }), () => {},
      { nameEditable: false, requiredToggle: true, sourceText: 'no default — from an environment or typed at run time' });
    row.querySelector('.del').style.visibility = 'hidden';
    box.append(row);
  });
}

// Variables that must have a value before a flow may run.
const requiredVars = (flow) => (flow.vars || []).filter((v) => v.required && v.name).map((v) => v.name);
$('varsAdd').addEventListener('click', () => {
  const name = prompt('Variable name (letters, digits, _):', '');
  if (!name || !/^[A-Za-z_][\w.-]*$/.test(name.trim())) return;
  send({ type: 'setVars', vars: [...(state.vars || []).filter((v) => v.name !== name.trim()), { name: name.trim(), value: '', secret: false }] });
  $('varsBox').open = true;
});

// ---------------------------------------------------------------- 🖱 add a click without clicking
$('clickBtn').addEventListener('click', async () => {
  const b = $('clickBtn');
  if (b.dataset.picking) {
    delete b.dataset.picking;
    b.textContent = '🖱 Add click';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) pageCall(tab.id, { type: 'list:cancel' }).catch(() => {});
    return;
  }
  try {
    const tab = await activeTab();
    b.dataset.picking = '1';
    b.textContent = 'Cancel';
    const r = await pageCall(tab.id, { type: 'list:pick', mode: 'click' });
    if (!r.cancelled && r.click) {
      await send({ type: 'addStep', step: { type: 'click', t: Date.now(), tabId: tab.id, url: tab.url, title: tab.title, target: r.click, notClicked: true } });
    }
  } catch (err) {
    alert(err.message);
  } finally {
    delete b.dataset.picking;
    b.textContent = '🖱 Add click';
  }
});

// ---------------------------------------------------------------- ⤓ capture value
let cap = null; // { tabId, target }

function closeCapture() {
  $('capForm').hidden = true;
  if (cap?.tabId) pageCall(cap.tabId, { type: 'list:cancel' }).catch(() => {});
  cap = null;
}
const capSpec = () => ({ target: cap?.target, what: $('cpWhat').value, attr: $('cpAttr').value.trim() || 'href', regex: $('cpRegex').value || undefined });

async function capPreview() {
  if (!cap?.target) return;
  try {
    if ($('cpRegex').value) new RegExp($('cpRegex').value, 'u');
    const r = await pageCall(cap.tabId, { type: 'check:capture', capture: capSpec(), timeout: 0 });
    $('cpPreview').textContent = r.value ? `"${r.value}"` : '(empty)';
  } catch (err) {
    $('cpPreview').textContent = `⚠ ${err.message}`;
  }
}

async function capPick() {
  try {
    const tab = await activeTab();
    cap = { tabId: tab.id, target: cap?.target || null };
    $('cpEl').textContent = 'click the element on the page (↑ / ↓ bigger / smaller, Esc cancels)…';
    $('cpPick').disabled = true;
    const r = await pageCall(tab.id, { type: 'list:pick', mode: 'area' });
    if (!cap) return;
    if (!r.cancelled) cap.target = r.area;
    $('cpEl').textContent = cap.target ? `${cap.target.name}${cap.target.inItem ? ' (in the current list item)' : ''}` : 'none';
    if (cap.target && !$('cpVar').value) {
      $('cpVar').value = (cap.target.name || 'VALUE').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'VALUE';
    }
    await capPreview();
  } catch (err) {
    $('cpMsg').textContent = err.message;
  } finally {
    $('cpPick').disabled = false;
  }
}

$('capBtn').addEventListener('click', () => {
  if (!$('capForm').hidden) return closeCapture();
  cap = null;
  $('capForm').hidden = false;
  $('cpVar').value = '';
  $('cpRegex').value = '';
  $('cpWhat').value = 'text';
  $('cpAttr').hidden = true;
  $('cpPreview').textContent = '—';
  $('cpMsg').textContent = '';
  capPick();
});
$('cpClose').addEventListener('click', closeCapture);
$('cpPick').addEventListener('click', capPick);
$('cpWhat').addEventListener('change', () => { $('cpAttr').hidden = $('cpWhat').value !== 'attr'; capPreview(); });
$('cpAttr').addEventListener('change', capPreview);
$('cpRegex').addEventListener('input', () => { clearTimeout(capPreview.t); capPreview.t = setTimeout(capPreview, 400); });
$('capForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!cap?.target) { $('cpMsg').textContent = 'Pick the element first.'; return; }
  const varName = $('cpVar').value.trim();
  if (!/^[A-Za-z_][\w.-]*$/.test(varName)) { $('cpMsg').textContent = 'Enter a variable name, e.g. ORDER_ID'; return; }
  try {
    if ($('cpRegex').value) new RegExp($('cpRegex').value, 'u');
    const spec = capSpec();
    const r = await pageCall(cap.tabId, { type: 'check:capture', capture: spec, timeout: 0 });
    const tab = await chrome.tabs.get(cap.tabId);
    await send({ type: 'addStep', step: {
      type: 'capture', t: Date.now(), tabId: cap.tabId, url: tab.url, title: tab.title,
      target: spec.target, what: spec.what, attr: spec.what === 'attr' ? spec.attr : undefined, regex: spec.regex, varName, sample: r.value,
    } });
    closeCapture();
  } catch (err) {
    $('cpMsg').textContent = err.message;
  }
});

// ---------------------------------------------------------------- ⏸ approval steps
$('apprBtn').addEventListener('click', () => {
  $('apprForm').hidden = !$('apprForm').hidden;
  $('apMsg').textContent = '';
  if (!$('apprForm').hidden) $('apText').focus();
});
$('apClose').addEventListener('click', () => { $('apprForm').hidden = true; });
let apFill = null; // field the answer is typed into
const showApFill = () => {
  $('apFillName').textContent = apFill ? `${apFill.kind}${apFill.label ? ` "${apFill.label}"` : ''}${apFill.inItem ? ' (in the current list item)' : ''}` : 'none';
  $('apFillOn').checked = !!apFill;
};
$('apMode').addEventListener('change', () => {
  $('apVarRow').hidden = $('apMode').value !== 'input';
  $('apFillRow').hidden = $('apMode').value !== 'input';
});
$('apFillOn').addEventListener('change', () => { if ($('apFillOn').checked && !apFill) $('apFillPick').click(); if (!$('apFillOn').checked) { apFill = null; showApFill(); } });
$('apFillPick').addEventListener('click', async () => {
  try {
    const tab = await activeTab();
    $('apFillName').textContent = 'click the field on the page (Esc cancels)…';
    $('apFillPick').disabled = true;
    const r = await pageCall(tab.id, { type: 'list:pick', mode: 'field' });
    if (!r.cancelled) apFill = r.field;
  } catch (err) {
    $('apMsg').textContent = err.message;
  } finally {
    $('apFillPick').disabled = false;
    showApFill();
  }
});
$('apprForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = $('apMode').value;
  const text = $('apText').value.trim() || (mode === 'input' ? 'Enter a value' : 'Approve to continue');
  const varName = $('apVar').value.trim();
  if (mode === 'input' && !/^[A-Za-z_][\w.-]*$/.test(varName)) { $('apMsg').textContent = 'Enter a variable name, e.g. OTP'; return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await send({ type: 'addStep', step: {
    type: 'approval', t: Date.now(), tabId: tab?.id, mode, text,
    ...(mode === 'input' ? { varName, secret: $('apSecret').checked, ...(apFill && $('apFillOn').checked ? { fill: apFill } : {}) } : {}),
  } });
  $('apText').value = '';
  $('apVar').value = '';
  $('apSecret').checked = false;
  apFill = null;
  showApFill();
  $('apprForm').hidden = true;
});

// ---------------------------------------------------------------- environments (shared)
const saveEnvs = (list) => chrome.storage.local.set({ envs: list.map((e) => ({ ...e, vars: e.vars.map((v) => (v.secret ? { ...v, value: '' } : v)) })) });

// Environments for an export: no 🔒 values and no values of variables used in a password field of any flow.
function envsForExport() {
  const pw = new Set(flows.flatMap((f) => [...passwordVars(f.steps)]));
  return envs.map((e) => ({ ...e, vars: e.vars.map((v) => (v.secret || pw.has(v.name) ? { ...v, value: '' } : v)) }));
}

// 🔒 rows of an environment: the value can be saved on this computer (encrypted, never in the environment itself).
function secretVaultField(row, env, name) {
  const input = row.querySelectorAll('input')[1];
  input.disabled = false;
  input.value = '';
  input.placeholder = '🔒 type to save on this computer';
  input.title = 'Saved encrypted in this Chrome profile on this computer — filled in automatically when you run a flow with this environment. Never exported.';
  const status = el('span', 'src', '');
  row.append(status);
  const show = (saved) => {
    input.placeholder = saved ? '🔑 saved on this computer — type to replace' : '🔒 type to save on this computer';
    status.textContent = saved ? '🔑 saved on this computer (encrypted) — filled in automatically' : 'not saved — asked at every run';
    if (!saved) return;
    const forget = el('button', 'del forget', 'forget');
    forget.title = 'Delete the saved value';
    forget.addEventListener('click', async () => { await vaultDelete(env.id, name); show(false); });
    status.append(forget);
  };
  vaultGet(env.id, name).then((x) => show(x != null));
  input.addEventListener('change', async (e) => {
    e.stopImmediatePropagation(); // the value is not stored in the environment
    if (!input.value) return;
    await vaultSet(env.id, name, input.value);
    input.value = '';
    show(true);
  }, true);
}

function renderEnvs() {
  const box = $('envList');
  if (isTyping(box)) return; // don't rebuild while typing
  box.replaceChildren();
  if (!envs.length) box.append(el('p', 'xinfo', 'No environments yet — e.g. DEV, TEST, PROD with BASE_URL, USERNAME …'));
  envs.forEach((env) => {
    const card = el('div', 'env');
    const head = el('div', 'crow');
    const name = inputEl(env.name);
    name.addEventListener('change', () => saveEnvs(envs.map((x) => (x.id === env.id ? { ...x, name: name.value.trim() || x.name } : x))));
    const add = el('button', '', '+ Variable');
    add.addEventListener('click', () => saveEnvs(envs.map((x) => (x.id === env.id ? { ...x, vars: [...x.vars, { name: '', value: '', secret: false }] } : x))));
    const del = el('button', 'danger', 'Delete');
    del.addEventListener('click', () => { if (confirm(`Delete environment "${env.name}"?`)) saveEnvs(envs.filter((x) => x.id !== env.id)); });
    head.append(name, add, del);
    card.append(head);
    env.vars.forEach((v, k) => {
      const row = varRow(v,
        (nv) => saveEnvs(envs.map((x) => (x.id === env.id ? { ...x, vars: x.vars.map((y, j) => (j === k ? nv : y)) } : x))),
        () => saveEnvs(envs.map((x) => (x.id === env.id ? { ...x, vars: x.vars.filter((_, j) => j !== k) } : x))));
      if (v.secret && v.name) secretVaultField(row, env, v.name);
      card.append(row);
    });
    box.append(card);
  });
}
$('envBtn').addEventListener('click', () => { $('envBox').hidden = !$('envBox').hidden; $('runForm').hidden = true; renderEnvs(); });
$('envClose').addEventListener('click', () => { $('envBox').hidden = true; });
$('envAdd').addEventListener('click', () => {
  const name = prompt('Environment name (e.g. DEV, TEST, PROD):', envs.length ? '' : 'DEV');
  if (!name || !name.trim()) return;
  saveEnvs([...envs, { id: crypto.randomUUID(), name: name.trim(), vars: [{ name: 'BASE_URL', value: '', secret: false }] }]);
});
$('envExport').addEventListener('click', () => download(`environments-${fileStamp()}.json`, JSON.stringify({ environments: envsForExport() }, null, 2), 'application/json'));
$('envImport').addEventListener('click', () => $('envFile').click());
$('envFile').addEventListener('change', async (e) => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    const list = (data.environments || data).filter((x) => x && x.name && Array.isArray(x.vars));
    if (!list.length) throw new Error('no environments found');
    saveEnvs([...envs.filter((x) => !list.some((y) => y.name === x.name)), ...list.map((x) => ({ ...x, id: crypto.randomUUID() }))]);
  } catch (err) {
    alert(`Could not import: ${err.message}`);
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- run form (choose environment / values)
let runReq = null; // { flow, debug }

function lastEnvId() { try { return localStorage.getItem('lastEnv') || ''; } catch (_) { return ''; } }

function openRunForm(flow, debug, chainSpec = null) {
  const names = [...new Set([...usedVars(flow.steps), ...afterVars(flow), ...requiredVars(flow)])];
  if (!names.length && !chainSpec) return startReplay(flow, debug);
  runReq = { flow, debug, names, chain: chainSpec };
  $('rfTitle').textContent = chainSpec ? `⛓ Run group: ${chainSpec.group} (${plural(chainSpec.flows.length, 'flow')})`
    : `${debug ? '🐞 Debug' : '▶ Replay'}: ${flow.name}`;
  $('rfChainRow').hidden = !chainSpec;
  $('rfChainInfo').hidden = !chainSpec;
  if (chainSpec) {
    $('rfChainInfo').textContent = 'Runs in this order: ' + chainSpec.flows.map((f, k) => `${k + 1}. ${f.name}`).join(' → ') +
      (names.length ? '' : ' · no variables needed');
  }
  const sel = $('rfEnv');
  sel.replaceChildren();
  [['', '(no environment — flow defaults)'], ...envs.map((x) => [x.id, x.name])].forEach(([v, t]) => {
    const o = el('option', '', t);
    o.value = v;
    sel.append(o);
  });
  sel.value = envs.some((x) => x.id === lastEnvId()) ? lastEnvId() : '';
  $('envBox').hidden = true;
  $('runForm').hidden = false;
  fillRunRows();
}

function fillRunRows() {
  const { flow, names } = runReq;
  const env = envs.find((x) => x.id === $('rfEnv').value);
  const box = $('rfRows');
  box.replaceChildren();
  names.forEach((n) => {
    const fv = (flow.vars || []).find((v) => v.name === n);
    const ev = env?.vars.find((v) => v.name === n);
    const pw = passwordVars(flow.steps).has(n); // typed into a password field: always hidden
    const secret = !!(fv?.secret || ev?.secret || pw);
    // A password kept in an environment (on this computer) is filled in, but stays hidden.
    const envPw = pw && ev && !ev.secret && ev.value !== '';
    const value = envPw ? ev.value : secret ? '' : ev ? ev.value : fv?.value ?? '';
    const required = !!fv?.required;
    const src = (required ? 'required · ' : '') + (envPw ? `from ${env.name} (hidden)` : secret ? 'secret — type it' : ev ? `from ${env.name}` : fv && fv.value !== '' ? 'flow default' : 'no value yet');
    const row = varRow({ name: n, value, secret }, () => {}, () => {}, { nameEditable: false, sourceText: src });
    if (envPw) row.querySelectorAll('input')[1].value = value;
    row.querySelector('.del').remove();
    row.querySelector('label').remove();
    const input = row.querySelectorAll('input')[1];
    input.disabled = false;
    input.dataset.var = n;
    input.dataset.secret = secret ? '1' : '';
    input.dataset.required = required ? '1' : '';
    row.classList.toggle('missing', (required || !secret) && value === '');
    row.querySelector('.vname').value = required ? `${n} ✱` : n;
    input.addEventListener('input', () => { row.classList.toggle('missing', input.value === '' && (required || !secret)); delete input.dataset.saved; });
    box.append(row);
    if (secret && !envPw) {
      // 🔑 A value saved on this computer for this environment is filled in (hidden).
      vaultGet(env?.id, n).then((saved) => {
        if (saved == null || input.value !== '' || !row.isConnected) return;
        input.value = saved;
        input.dataset.saved = '1';
        row.classList.remove('missing');
        row.querySelector('.src').textContent = `${required ? 'required · ' : ''}🔑 saved on this computer${env ? ` for ${env.name}` : ''}`;
        const forget = el('button', 'del', 'forget');
        forget.type = 'button';
        forget.title = 'Delete the saved value — it will be asked again';
        forget.addEventListener('click', async () => {
          await vaultDelete(env?.id, n);
          input.value = '';
          delete input.dataset.saved;
          row.classList.toggle('missing', true);
          row.querySelector('.src').textContent = `${required ? 'required · ' : ''}secret — type it`;
        });
        row.querySelector('.src').append(forget);
      });
    }
  });
  const anySecret = names.some((n) => passwordVars(flow.steps).has(n) || (flow.vars || []).some((v) => v.name === n && v.secret) || env?.vars.some((v) => v.name === n && v.secret));
  $('rfRememberRow').hidden = !anySecret;
  $('rfRememberScope').textContent = env ? `for ${env.name}` : 'without an environment';
  $('rfMsg').textContent = '';
}
$('rfEnv').addEventListener('change', fillRunRows);
const closeRunForm = () => { $('runForm').hidden = true; runReq = null; };
$('rfClose').addEventListener('click', closeRunForm);
$('rfCancel').addEventListener('click', closeRunForm);
$('rfRun').addEventListener('click', () => {
  const vars = {};
  const secrets = [];
  const empty = [];
  const missingRequired = [];
  $('rfRows').querySelectorAll('input[data-var]').forEach((i) => {
    vars[i.dataset.var] = i.value;
    if (i.dataset.secret) secrets.push(i.dataset.var);
    if (i.value.trim() === '') (i.dataset.required ? missingRequired : empty).push(i.dataset.var);
  });
  if (missingRequired.length) {
    $('rfMsg').textContent = `✱ Required — enter a value or choose an environment that has it: ${missingRequired.map((n) => `{{${n}}}`).join(', ')}`;
    $('rfRows').querySelector(`input[data-var="${missingRequired[0]}"]`)?.focus();
    return;
  }
  if (empty.length && !confirm(`No value for ${empty.map((n) => `{{${n}}}`).join(', ')}. Run anyway with empty values?`)) return;
  const env = envs.find((x) => x.id === $('rfEnv').value);
  try { localStorage.setItem('lastEnv', env?.id || ''); } catch (_) { /* ignore */ }
  // 🔑 Remember newly typed 🔒 values on this computer (encrypted; never in the flow or an export).
  if ($('rfRemember').checked && !$('rfRememberRow').hidden) {
    $('rfRows').querySelectorAll('input[data-var][data-secret="1"]').forEach((i) => {
      if (i.value !== '' && !i.dataset.saved) vaultSet(env?.id, i.dataset.var, i.value);
    });
  }
  const { flow, debug, chain: chainSpec } = runReq;
  closeRunForm();
  if (chainSpec) return startChain(chainSpec, { vars, secrets, envName: env?.name || '' }, $('rfOnFail').value);
  startReplay(flow, debug, { vars, secrets, envName: env?.name || '' });
});

// ---------------------------------------------------------------- saved flows
const saveFlows = (list) => chrome.storage.local.set({ flows: list.map(secureFlow) }); // never store password values

// ---- flow versions: every "Update flow" with changes makes a new version; older ones are kept in `history`.
const MAX_HISTORY = 20;
const flowVersion = (f) => f.version || 1;
const flowCreated = (f) => f.createdAt || f.savedAt;
const flowUpdated = (f) => f.updatedAt || f.savedAt;
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const stripSecrets = (vars) => (vars || []).map((v) => (v.secret ? { ...v, value: '' } : v));
// Make password variables 🔒 in a flow (and its history); returns the flow unchanged if nothing to do.
function secureFlow(f) {
  const vars = secureVars(f.steps, f.vars);
  const history = (f.history || []).map((h) => { const hv = secureVars(h.steps, h.vars); return hv === h.vars ? h : { ...h, vars: hv }; });
  const histChanged = history.some((h, k) => h !== f.history[k]);
  return vars === f.vars && !histChanged ? f : { ...f, vars, ...(f.history ? { history } : {}) };
}

// New version of a saved flow from steps/vars; the current one moves into the history.
function nextVersion(f, steps, vars, note) {
  const prev = { version: flowVersion(f), savedAt: flowUpdated(f), note: f.note || '', steps: f.steps, vars: f.vars || [] };
  return {
    ...f, steps, vars: stripSecrets(vars), version: flowVersion(f) + 1, note: note || '',
    createdAt: flowCreated(f), updatedAt: Date.now(), savedAt: Date.now(),
    history: [prev, ...(f.history || [])].slice(0, MAX_HISTORY),
  };
}

function makeFlow(src, name) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: (name || '').trim() || src.steps.find((s) => s.type === 'navigate')?.title || 'Untitled flow',
    version: 1, createdAt: now, updatedAt: now, note: 'first version',
    savedAt: now,
    startedAt: src.startedAt || src.steps[0]?.t || Date.now(),
    stoppedAt: src.stoppedAt || src.steps[src.steps.length - 1]?.t || Date.now(),
    steps: src.steps,
    vars: (src.vars || []).map((v) => (v.secret ? { ...v, value: '' } : v)),
    ...(src.description ? { description: String(src.description) } : {}),
    ...(src.group ? { group: String(src.group) } : {}),
    ...(Array.isArray(src.after) && src.after.length ? { after: src.after } : {}),
  };
}

async function saveAsNew() {
  const suggested = state.editingFlowName ? `${state.editingFlowName} (copy)` : state.steps.find((s) => s.type === 'navigate')?.title || 'My flow';
  const name = prompt('Name this flow:', suggested);
  if (name == null) return;
  const from = flows.find((x) => x.id === state.editingFlowId);
  const f = makeFlow({ ...state, description: from?.description || '', group: from?.group, after: from?.after }, name); // a copy keeps description, group, After the run
  await saveFlows([f, ...flows]);
  if (state.editingFlowId) await send({ type: 'loadFlow', flow: f }); // keep editing the new copy
  show('flows');
}

function flashSave(text) {
  const b = $('saveFlow');
  b.dataset.flash = '1';
  b.textContent = text;
  $('saveTop').textContent = text;
  setTimeout(() => { delete b.dataset.flash; render(); }, 1800);
}

$('saveTop').addEventListener('click', () => $('saveFlow').click());
$('saveFlow').addEventListener('click', async () => {
  const orig = state.editingFlowId && flows.find((f) => f.id === state.editingFlowId);
  if (!orig) return saveAsNew();
  // Update the saved flow: a new version (keeps its name and settings).
  const same = JSON.stringify(orig.steps) === JSON.stringify(state.steps) &&
    JSON.stringify(stripSecrets(orig.vars)) === JSON.stringify(stripSecrets(state.vars));
  if (same) return flashSave('No changes');
  const note = prompt(`Saving as version v${flowVersion(orig) + 1}. What changed? (optional)`, '');
  if (note == null) return;
  await saveFlows(flows.map((f) => (f.id === orig.id
    ? { ...nextVersion(f, state.steps, state.vars, note.trim()), startedAt: state.startedAt, stoppedAt: state.stoppedAt }
    : f)));
  flashSave(`Saved as v${flowVersion(orig) + 1} ✓`);
});
$('saveNew').addEventListener('click', saveAsNew);

const openHistory = new Set(); // flows whose version history is shown
const openDesc = new Set();    // flows whose description editor is open
const openChecks = new Set();  // flows whose ⚠ flow check list is shown
const descOpenFull = new Set(); // flows whose long description is expanded

// ---------------------------------------------------------------- "After the run" requests of a flow
const openAfter = new Set(); // flows whose "After the run" editor is open
let afterEdit = null;        // { flowId, index } — request being edited (index -1 = new)

function afterEditor(f) {
  const box = el('div', 'aftereditor');
  const hooks = f.after || [];
  const save = (list) => saveFlows(flows.map((x) => (x.id === f.id ? { ...x, after: list } : x)));
  box.append(el('div', 'xinfo', 'Sent when the flow has ended — also when a step failed or the replay was stopped. They can use the run\'s result: {{RUN_RESULT}}, {{RUN_SUMMARY}}, {{FAILED_STEPS}}, {{DURATION}} …'));
  hooks.forEach((h, k) => {
    if (afterEdit && afterEdit.flowId === f.id && afterEdit.index === k) { box.append(afterForm(f, h, k, save)); return; }
    const row = el('div', 'afterrow');
    row.append(el('span', 'verb', `🌐 ${(h.method || 'GET').toUpperCase()}`), el('span', 'aurl', h.url), el('span', 'xinfo', AFTER_WHEN[h.when] || AFTER_WHEN.always));
    const ed = el('button', 'del', '✎');
    ed.title = 'Change this request';
    ed.addEventListener('click', () => { afterEdit = { flowId: f.id, index: k }; renderFlows(); });
    const del = el('button', 'del', '×');
    del.title = 'Remove this request';
    del.addEventListener('click', () => { if (confirm('Remove this request?')) save(hooks.filter((_, j) => j !== k)); });
    row.append(ed, del);
    box.append(row);
  });
  if (afterEdit && afterEdit.flowId === f.id && afterEdit.index === -1) box.append(afterForm(f, {}, -1, save));
  else {
    const add = el('button', '', '+ HTTP request');
    add.addEventListener('click', () => { afterEdit = { flowId: f.id, index: -1 }; renderFlows(); });
    box.append(add);
  }
  return box;
}

function afterForm(f, h, k, save) {
  const box = el('div', 'stepedit');
  const when = selectEl(Object.entries(AFTER_WHEN), h.when || 'always');
  const hf = httpFields(h);
  const msg = el('span', 'xinfo');
  const ok = el('button', 'primary', k < 0 ? 'Add' : 'Save');
  const cancel = el('button', '', 'Cancel');
  ok.addEventListener('click', () => {
    let req;
    try { req = hf.read(); } catch (err) { msg.textContent = err.message; return; }
    const hooks = [...(f.after || [])];
    const item = { id: h.id || Math.random().toString(36).slice(2, 10), when: when.value, ...req };
    if (k < 0) hooks.push(item); else hooks[k] = item;
    afterEdit = null;
    save(hooks);
  });
  cancel.addEventListener('click', () => { afterEdit = null; renderFlows(); });
  // Insert variable: the run's own values first, then the flow's variables.
  const flowVars = [...new Set([...(f.vars || []).map((v) => v.name), ...usedVars(f.steps)])].map((n) => [n, 'flow variable']);
  const picker = varPicker(hf.target, [...Object.entries(AFTER_VARS), ...flowVars]);
  const row = el('div', 'crow');
  row.append(ok, cancel, picker, msg);
  box.append(field('Send', when), hf.box, row);
  return box;
}

// Flow description: what the flow is for, when to run it, prerequisites … (not versioned, like the name).
function descEditor(f) {
  const box = el('div', 'fdescedit');
  const ta = el('textarea');
  ta.rows = 4;
  ta.maxLength = 4000;
  ta.placeholder = 'What does this flow do? When should it be run, what must be ready first, what is the expected result?';
  ta.value = f.description || '';
  const save = el('button', 'primary', 'Save');
  const cancel = el('button', '', 'Cancel');
  const close = () => { openDesc.delete(f.id); renderFlows(); };
  save.addEventListener('click', async () => {
    const description = ta.value.trim();
    openDesc.delete(f.id);
    await saveFlows(flows.map((x) => (x.id === f.id ? { ...x, description } : x)));
  });
  cancel.addEventListener('click', close);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click();
  });
  const row = el('div', 'fdescbtns');
  row.append(save, cancel, el('span', 'xinfo', 'Ctrl+Enter to save · shown on the card, in the .md export and in run reports'));
  box.append(ta, row);
  requestAnimationFrame(() => ta.focus());
  return box;
}

function historyList(f) {
  const box = el('div', 'hist');
  const cur = el('div', 'hrow current');
  cur.append(el('b', '', `v${flowVersion(f)}`), el('span', 'hdate', fmtDate(flowUpdated(f))), el('span', 'hnote', f.note || ''), el('span', 'hnote', 'current'));
  box.append(cur);
  for (const h of f.history) {
    const row = el('div', 'hrow');
    row.append(el('b', '', `v${h.version}`), el('span', 'hdate', fmtDate(h.savedAt)), el('span', 'hnote', h.note || ''));
    const acts = el('span', 'actions');
    const restore = el('button', '', 'Restore');
    restore.title = `Make v${h.version} the current flow again (saved as a new version; nothing is lost)`;
    restore.addEventListener('click', async () => {
      if (!confirm(`Restore v${h.version} of "${f.name}"? It becomes v${flowVersion(f) + 1}; the current v${flowVersion(f)} stays in the history.`)) return;
      const updated = nextVersion(f, h.steps, h.vars, `restored from v${h.version}`);
      await saveFlows(flows.map((x) => (x.id === f.id ? updated : x)));
      if (state.editingFlowId === f.id && !state.recording) await send({ type: 'loadFlow', flow: updated });
    });
    const exp = el('button', '', '.json');
    exp.title = `Export v${h.version}`;
    exp.addEventListener('click', () => download(`${slug(f.name)}-v${h.version}.json`,
      JSON.stringify({ ...f, ...h, history: undefined, updatedAt: h.savedAt }, null, 2), 'application/json'));
    acts.append(restore, exp);
    row.append(acts);
    box.append(row);
  }
  return box;
}

// ---------- groups & ordering ----------
const saveGroups = (list) => chrome.storage.local.set({ groups: list });
let flowSearch = '';

// Stored groups plus any group a flow names that is not in the list yet (e.g. after an import).
function allGroups() {
  const list = groups.filter((g) => g && g.name);
  for (const f of flows) if (f.group && !list.some((g) => g.name === f.group)) list.push({ name: f.group, collapsed: false });
  return list;
}

function matchesSearch(f) {
  if (!flowSearch) return true;
  const q = flowSearch.toLocaleLowerCase('tr');
  return [f.name, f.description, f.group].some((t) => (t || '').toLocaleLowerCase('tr').includes(q));
}

// Move a flow up/down among the flows of its own group (the order of `flows` is the display order).
function moveFlow(f, dir) {
  const same = flows.filter((x) => (x.group || '') === (f.group || ''));
  const k = same.findIndex((x) => x.id === f.id);
  const other = same[k + dir];
  if (!other) return;
  const list = [...flows];
  const a = list.findIndex((x) => x.id === f.id);
  const b = list.findIndex((x) => x.id === other.id);
  [list[a], list[b]] = [list[b], list[a]];
  saveFlows(list);
}

async function setFlowGroup(f, value) {
  let name = value;
  if (value === '__new__') {
    name = (prompt('New group name:', '') || '').trim();
    if (!name) return renderFlows();
  }
  if (name && !allGroups().some((g) => g.name === name)) await saveGroups([...allGroups(), { name, collapsed: false }]);
  await saveFlows(flows.map((x) => (x.id === f.id ? { ...x, group: name || undefined } : x)));
}

function groupHeader(g, k, all, count) {
  const li = el('li', 'ghead');
  const searching = !!flowSearch;
  const t = el('button', 'gtoggle', `${g.collapsed && !searching ? '▸' : '▾'} 📁 ${g.name}`);
  t.append(el('span', 'badge', String(count)));
  t.title = g.collapsed ? 'Show the flows of this group' : 'Hide the flows of this group';
  t.addEventListener('click', () => saveGroups(all.map((x, j) => (j === k ? { ...x, collapsed: !x.collapsed } : x))));
  const btns = el('div', 'stepbtns');
  const mv = (dir, label) => {
    const b = el('button', 'del', label);
    b.title = dir < 0 ? 'Move the group up' : 'Move the group down';
    b.disabled = !all[k + dir];
    b.addEventListener('click', () => { const l = [...all]; [l[k], l[k + dir]] = [l[k + dir], l[k]]; saveGroups(l); });
    return b;
  };
  const ren = el('button', 'del', '✎');
  ren.title = 'Rename the group';
  ren.addEventListener('click', async () => {
    const name = (prompt('Rename group:', g.name) || '').trim();
    if (!name || name === g.name) return;
    if (all.some((x) => x.name === name)) { alert(`A group "${name}" already exists.`); return; }
    await saveGroups(all.map((x, j) => (j === k ? { ...x, name } : x)));
    await saveFlows(flows.map((x) => (x.group === g.name ? { ...x, group: name } : x)));
  });
  const del = el('button', 'del', '×');
  del.title = 'Delete the group (its flows are kept, without a group)';
  del.addEventListener('click', async () => {
    if (count && !confirm(`Delete the group "${g.name}"? Its ${plural(count, 'flow')} are kept, without a group.`)) return;
    await saveFlows(flows.map((x) => (x.group === g.name ? { ...x, group: undefined } : x)));
    await saveGroups(all.filter((_, j) => j !== k));
  });
  const run = el('button', 'primary grun', '▶ Run');
  run.title = 'Run all flows of this group one after another, in this order (one environment, one report)';
  run.disabled = !count || state.recording || !!replayer;
  run.addEventListener('click', () => openChainForm(g.name));
  btns.append(run, mv(-1, '↑'), mv(1, '↓'), ren, del);
  li.append(t, btns);
  return li;
}

function renderFlows() {
  $('flowCount').textContent = String(flows.length);
  $('flowsEmpty').hidden = flows.length > 0;
  const list = $('flows');
  list.replaceChildren();
  const all = allGroups();
  const shown = flows.filter(matchesSearch);
  $('flowSearchInfo').textContent = flowSearch ? `${shown.length} of ${plural(flows.length, 'flow')}` : '';
  // Flows without a group first (new flows land there), then the groups in their order.
  const loose = shown.filter((f) => !f.group || !all.some((g) => g.name === f.group));
  if (all.length && loose.length) list.append(el('li', 'ghead plain', 'Not grouped'));
  loose.forEach((f) => list.append(flowCard(f, all)));
  all.forEach((g, k) => {
    const members = shown.filter((f) => f.group === g.name);
    if (flowSearch && !members.length) return;
    list.append(groupHeader(g, k, all, flows.filter((f) => f.group === g.name).length));
    if (g.collapsed && !flowSearch) return;
    if (!members.length) list.append(el('li', 'gempty', 'No flows yet — choose this group in a flow\'s 📁 menu.'));
    members.forEach((f) => list.append(flowCard(f, all, true)));
  });
  if (flowSearch && !shown.length) list.append(el('li', 'gempty', 'No flow matches the search.'));
}

function flowCard(f, all, grouped = false) {
  {
    const li = el('li', 'flow' + (grouped ? ' ingroup' : ''));
    const info = el('div', 'finfo');
    const nm = el('div', 'fname', f.name);
    nm.append(el('span', 'fver', `v${flowVersion(f)}`));
    const same = flows.filter((x) => (x.group || '') === (f.group || ''));
    const pos = same.findIndex((x) => x.id === f.id);
    const order = el('span', 'stepbtns forder');
    const up = el('button', 'del', '↑');
    up.title = 'Move up';
    up.disabled = pos <= 0;
    up.addEventListener('click', () => moveFlow(f, -1));
    const down = el('button', 'del', '↓');
    down.title = 'Move down';
    down.disabled = pos >= same.length - 1;
    down.addEventListener('click', () => moveFlow(f, 1));
    order.append(up, down);
    nm.append(order);
    info.append(nm);
    if (f.description && !openDesc.has(f.id)) {
      const d = el('div', 'fdesc' + (descOpenFull.has(f.id) ? ' full' : ''), f.description);
      d.title = descOpenFull.has(f.id) ? 'Click to collapse' : 'Click to show all';
      d.addEventListener('click', () => { if (descOpenFull.has(f.id)) descOpenFull.delete(f.id); else descOpenFull.add(f.id); renderFlows(); });
      info.append(d);
    }
    if (openDesc.has(f.id)) info.append(descEditor(f));
    info.append(el('div', 'fmeta', `updated ${fmtDate(flowUpdated(f))}${flowVersion(f) > 1 ? ` · created ${fmtDate(flowCreated(f))}` : ''}` +
      (f.note && flowVersion(f) > 1 ? ` · "${f.note}"` : '')));
    const start = f.steps.find((s) => s.type === 'navigate')?.url;
    let host = '';
    try { host = start ? new URL(start).host : ''; } catch (_) { /* ignore */ }
    const req = requiredVars(f);
    const fv = [...new Set([...usedVars(f.steps), ...req])].map((n) => (req.includes(n) ? `${n} ✱` : n));
    info.append(el('div', 'fmeta', [plural(countSteps(f.steps), 'step'), host,
      fv.length ? `variables: ${fv.join(', ')}` : ''].filter(Boolean).join(' · ')));
    const findings = flowCheck(f, envs);
    const warns = findings.filter((c) => c.level === 'warn').length;
    if (findings.length) {
      const chip = el('button', 'checkchip' + (warns ? ' warn' : ''), warns ? `⚠ ${plural(warns, 'warning')}` : `ℹ ${plural(findings.length, 'hint')}`);
      chip.title = 'Flow check: things that can make a replay or an agent go wrong';
      chip.addEventListener('click', () => { if (openChecks.has(f.id)) openChecks.delete(f.id); else openChecks.add(f.id); renderFlows(); });
      nm.append(chip);
      if (openChecks.has(f.id)) info.append(checkList(findings, false), el('div', 'xinfo', 'Fix it with Edit — the same list is shown there, with links to the steps.'));
    }
    li.append(info);

    const wopt = el('label', 'fopt', '⏱ Wait for elements up to');
    const wsel = el('select', 'fwait');
    wsel.title = 'Before each step the replay waits for the element to appear and be ready (page loaded, not disabled or covered by a loading overlay). Slow systems need more.';
    [[15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min']].forEach(([v, t]) => {
      const o = el('option', '', t);
      o.value = String(v);
      wsel.append(o);
    });
    wsel.value = String(f.elementTimeout || 15);
    wsel.addEventListener('change', () => saveFlows(flows.map((x) => (x.id === f.id ? { ...x, elementTimeout: Number(wsel.value) } : x))));
    wopt.append(wsel);
    li.append(wopt);

    const fopt = el('label', 'fopt', 'If a step fails:');
    const fsel = el('select', 'fstepfail');
    fsel.title = '"Ask me" pauses with Retry / Skip / Stop and waits for you. "Stop the run" ends it right away as FAILED — use it for runs nobody watches, so the report and the "After the run" requests always go out.';
    [['ask', 'ask me (Retry / Skip / Stop)'], ['stop', 'stop the run and report']].forEach(([v, t]) => {
      const o = el('option', '', t);
      o.value = v;
      fsel.append(o);
    });
    fsel.value = f.onStepFail === 'stop' ? 'stop' : 'ask';
    fsel.addEventListener('change', () => saveFlows(flows.map((x) => (x.id === f.id ? { ...x, onStepFail: fsel.value } : x))));
    fopt.append(fsel);
    li.append(fopt);

    if (f.steps.some((s) => s.type === 'verify')) {
      const opt = el('label', 'fopt', 'If a check fails:');
      const sel = el('select');
      [['stop', 'stop the replay'], ['continue', 'continue and report']].forEach(([v, t]) => {
        const o = el('option', '', t);
        o.value = v;
        sel.append(o);
      });
      sel.value = f.onCheckFail || 'stop';
      sel.addEventListener('change', () => saveFlows(flows.map((x) => (x.id === f.id ? { ...x, onCheckFail: sel.value } : x))));
      opt.append(sel);
      li.append(opt);
    }

    const acts = el('div', 'actions');
    const play = el('button', 'primary', '▶ Replay');
    play.disabled = state.recording || !!replayer;
    play.title = state.recording ? 'Stop recording first' : 'Replay this flow in a new tab';
    play.addEventListener('click', () => openRunForm(f, false));
    const dbg = el('button', '', '🐞 Debug');
    dbg.disabled = play.disabled;
    dbg.title = 'Run step by step: pause before each step, breakpoints (●), highlight the next element';
    dbg.addEventListener('click', () => openRunForm(f, true));
    const md = el('button', '', '.md');
    md.title = 'Export as Markdown (agent prompt)';
    md.addEventListener('click', () => download(`${slug(f.name)}-v${flowVersion(f)}.md`, toMarkdown(f), 'text/markdown'));
    const js = el('button', '', '.json');
    js.title = 'Export as JSON (can be imported again)';
    js.addEventListener('click', () => download(`${slug(f.name)}-v${flowVersion(f)}.json`, JSON.stringify(f, null, 2), 'application/json'));
    const ren = el('button', '', 'Rename');
    ren.addEventListener('click', () => {
      const name = prompt('Rename flow:', f.name);
      if (name && name.trim()) saveFlows(flows.map((x) => (x.id === f.id ? { ...x, name: name.trim() } : x)));
    });
    const edit = el('button', '', 'Edit');
    edit.title = 'Open this flow in the Recording tab to change, reorder, remove or add steps';
    edit.disabled = state.recording || !!replayer;
    edit.addEventListener('click', async () => {
      const unsaved = state.steps.length && state.editingFlowId !== f.id &&
        !(state.editingFlowId && JSON.stringify(flows.find((x) => x.id === state.editingFlowId)?.steps) === JSON.stringify(state.steps));
      if (unsaved && !confirm('The current recording will be replaced by this flow (save it first if you need it). Continue?')) return;
      editingStepId = null;
      await send({ type: 'loadFlow', flow: f });
      show('rec');
    });
    const del = el('button', 'danger', 'Delete');
    del.addEventListener('click', () => { if (confirm(`Delete "${f.name}"?`)) saveFlows(flows.filter((x) => x.id !== f.id)); });
    const hist = el('button', '', `History (${(f.history || []).length})`);
    hist.title = 'Earlier versions of this flow';
    hist.disabled = !(f.history || []).length;
    hist.addEventListener('click', () => { if (openHistory.has(f.id)) openHistory.delete(f.id); else openHistory.add(f.id); renderFlows(); });
    const aft = el('button', '', `After the run${(f.after || []).length ? ` (${f.after.length})` : ''}`);
    aft.title = 'Requests sent when the flow has ended (e.g. notify a chat group with the result)';
    aft.addEventListener('click', () => { if (openAfter.has(f.id)) openAfter.delete(f.id); else openAfter.add(f.id); afterEdit = null; renderFlows(); });
    const dsc = el('button', '', 'Description');
    dsc.title = f.description ? 'Edit the description of this flow' : 'Add a description: what this flow does and when to use it';
    dsc.addEventListener('click', () => { if (openDesc.has(f.id)) openDesc.delete(f.id); else openDesc.add(f.id); renderFlows(); });
    const grp = el('select', 'fgroup');
    grp.title = 'Group of this flow';
    [['', '📁 No group'], ...all.map((g) => [g.name, `📁 ${g.name}`]), ['__new__', '+ New group…']].forEach(([v, t]) => {
      const o = el('option', '', t);
      o.value = v;
      grp.append(o);
    });
    grp.value = f.group && all.some((g) => g.name === f.group) ? f.group : '';
    grp.addEventListener('change', () => setFlowGroup(f, grp.value));
    acts.append(play, dbg, edit, hist, md, js, ren, dsc, aft, grp, del);
    li.append(acts);
    if (openAfter.has(f.id)) li.append(afterEditor(f));
    if (openHistory.has(f.id) && (f.history || []).length) li.append(historyList(f));
    return li;
  }
}

$('flowSearch').addEventListener('input', (e) => { flowSearch = e.target.value.trim(); renderFlows(); });
$('newGroupBtn').addEventListener('click', async () => {
  const name = (prompt('New group name:', '') || '').trim();
  if (!name) return;
  if (allGroups().some((g) => g.name === name)) { alert(`A group "${name}" already exists.`); return; }
  await saveGroups([...allGroups(), { name, collapsed: false }]);
});

$('importBtn').addEventListener('click', () => $('importFile').click());
// Export all: one backup file with every flow (incl. versions/history) and the shared environments.
$('exportAllBtn').addEventListener('click', () => {
  if (!flows.length && !envs.length) { alert('There are no saved flows to export yet.'); return; }
  const clean = (vars) => stripSecrets(vars);
  const backup = {
    type: 'action-recorder-backup',
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    flows: flows.map((f) => ({ ...f, vars: clean(f.vars), history: (f.history || []).map((h) => ({ ...h, vars: clean(h.vars) })) })),
    envs: envsForExport(),
    groups: allGroups(),
  };
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  download(`action-recorder-flows-${stamp}.json`, JSON.stringify(backup, null, 2), 'application/json');
});

$('importFile').addEventListener('change', async (e) => {
  const added = [];
  const importedGroups = []; // group order from an Export-all backup
  let skipped = 0;
  const newEnvs = envs.map((x) => ({ ...x, vars: [...x.vars] }));
  let envsChanged = 0;
  for (const file of e.target.files) {
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : Array.isArray(data.flows) ? data.flows : [data];
      if (Array.isArray(data.groups)) data.groups.forEach((g) => g?.name && importedGroups.push(String(g.name)));
      for (const it of items) {
        if (!it || !Array.isArray(it.steps) || !it.steps.length) throw new Error('no steps found');
        const known = [...flows, ...added].find((x) => it.id && x.id === it.id);
        if (known && flowVersion(known) >= (it.version || 1)) { skipped++; continue; } // already have this (or newer)
        const nf = makeFlow(it, it.name || file.name.replace(/\.json$/i, ''));
        if (it.id && !known) nf.id = it.id; // keep the id so re-importing the same backup is skipped
        if (it.description) nf.description = String(it.description);
        if (it.group) nf.group = String(it.group);
        if (it.version) Object.assign(nf, { version: it.version, createdAt: it.createdAt || it.savedAt || nf.createdAt, updatedAt: it.updatedAt || it.savedAt || nf.updatedAt, note: it.note || '', history: it.history || [] });
        added.push(nf);
      }
      // Environments from an Export-all backup: add new ones, add missing variables to existing ones (never overwrite).
      for (const env of Array.isArray(data.envs) ? data.envs : []) {
        if (!env || !env.name || !Array.isArray(env.vars)) continue;
        const cur = newEnvs.find((x) => x.name === env.name);
        if (!cur) { newEnvs.push({ id: crypto.randomUUID(), name: env.name, vars: stripSecrets(env.vars) }); envsChanged++; continue; }
        const missing = env.vars.filter((v) => v.name && !cur.vars.some((c) => c.name === v.name));
        if (missing.length) { cur.vars.push(...stripSecrets(missing)); envsChanged++; }
      }
    } catch (err) {
      alert(`Could not import ${file.name}: ${err.message}`);
    }
  }
  e.target.value = '';
  const newGroups = [...allGroups()];
  for (const name of importedGroups) if (!newGroups.some((g) => g.name === name)) newGroups.push({ name, collapsed: false });
  if (newGroups.length !== allGroups().length) await saveGroups(newGroups);
  if (added.length) await saveFlows([...added, ...flows]);
  if (envsChanged) await saveEnvs(newEnvs);
  if (skipped || envsChanged) {
    const parts = [`${added.length} flow(s) imported`];
    if (skipped) parts.push(`${skipped} skipped (already saved, same or newer version)`);
    if (envsChanged) parts.push(`${envsChanged} environment(s) added or extended`);
    alert(parts.join(', ') + '.');
  }
});

try { $('notifyOn').checked = localStorage.getItem('notify') !== '0'; } catch (_) { /* ignore */ }
$('notifyOn').addEventListener('change', (e) => {
  try { localStorage.setItem('notify', e.target.checked ? '1' : '0'); } catch (_) { /* ignore */ }
});
try { $('recordedWaits').checked = localStorage.getItem('recordedWaits') === '1'; } catch (_) { /* ignore */ }
$('recordedWaits').addEventListener('change', (e) => {
  try { localStorage.setItem('recordedWaits', e.target.checked ? '1' : '0'); } catch (_) { /* ignore */ }
});

// ---------------------------------------------------------------- replay
let replayFlowName = '';
const ICON = { pending: '', running: '▶', done: '✓', failed: '✗', waiting: '✋', skipped: '↷', paused: '⏸', off: '–' };

// ---------------------------------------------------------------- ⛓ run a group as a chain
// The flows of a group run one after another with one environment; values captured or asked in one flow are
// available to the next ones. One combined report at the end.
let chain = null; // { group, flows, index, onFail, run, vars, results: [], startedAt, endedAt, done, stoppedBy }

function chainFlows(group) { return flows.filter((f) => f.group === group); }

function openChainForm(group) {
  const list = chainFlows(group);
  if (!list.length || state.recording || replayer) return;
  // One form for all flows: their variables merged (first definition wins; required / secret if any flow says so).
  const vars = [];
  for (const f of list) {
    for (const v of f.vars || []) {
      const cur = vars.find((x) => x.name === v.name);
      if (!cur) vars.push({ ...v });
      else {
        if (v.required) cur.required = true;
        if (v.secret) { cur.secret = true; cur.value = ''; }
        if (cur.value === '' && !cur.secret && v.value) cur.value = v.value;
      }
    }
  }
  const merged = { id: `chain:${group}`, name: `📁 ${group}`, vars, steps: list.flatMap((f) => f.steps), after: list.flatMap((f) => f.after || []) };
  // Values captured / asked inside the chain are not needed up front.
  openRunForm(merged, false, { group, flows: list });
}

function startChain(spec, run, onFail) {
  chain = { group: spec.group, flows: spec.flows, index: 0, onFail, run, vars: { ...run.vars }, results: [], startedAt: Date.now() };
  runChainFlow();
}

function runChainFlow() {
  const f = chain.flows[chain.index];
  replayer = null;
  startReplay(f, false, { ...chain.run, vars: { ...chain.vars }, inChain: true });
}

// Called when the current flow of the chain has finished (done or stopped).
function chainFlowFinished(r) {
  if (!chain || r.chainHandled) return;
  r.chainHandled = true;
  const failedSteps = r.results.filter((x) => x.status === 'failed').length;
  const skipped = r.results.filter((x) => x.status === 'skipped').length;
  const checks = [...r.checks.values()];
  const failedChecks = checks.filter((c) => !c.passed).length;
  const failedItems = r.loopResults.reduce((n, L) => n + L.rows.filter((x) => x.result !== 'PASS').length, 0);
  const userStop = r.userStopped || (r.stopped && !r.rejectedAt && !r.failStopAt);
  const passed = r.status === 'done' && !failedSteps && !failedChecks && !failedItems;
  chain.results.push({
    flow: r.flow, passed, status: r.status, message: r.message, startedAt: r.startedAt, endedAt: r.endedAt || Date.now(),
    steps: `${r.results.filter((x, k) => x.status === 'done' && !isIfMarker(r.steps[k])).length}/${r.steps.filter((x) => !isIfMarker(x)).length - r.results.filter((x, k) => x.status === 'off' && !isIfMarker(r.steps[k])).length}`, skipped,
    checks: [checks.length ? `${checks.length - failedChecks}/${checks.length}` : '', r.tests?.size ? `🧪 ${[...r.tests.values()].filter((t) => t.passed).length}/${r.tests.size}` : ''].filter(Boolean).join(' · '), failedItems,
    report: r.checkReport(), extracted: r.extracted,
  });
  Object.assign(chain.vars, r.vars); // captured / asked values are available to the next flows
  const more = chain.index < chain.flows.length - 1;
  if (userStop) chain.stoppedBy = 'you stopped it';
  else if (!passed && chain.onFail === 'stop' && more) chain.stoppedBy = `flow ${chain.index + 1} failed`;
  if (more && !chain.stoppedBy) {
    chain.index++;
    setTimeout(() => { if (chain && !chain.done) runChainFlow(); }, 1500);
    return;
  }
  chain.done = true;
  chain.endedAt = Date.now();
  notifyChain();
}

function chainSummary() {
  const n = chain.flows.length;
  const ok = chain.results.filter((x) => x.passed).length;
  const notRun = n - chain.results.length;
  return `Chain finished — ${ok} of ${n} flows passed` + (chain.stoppedBy ? ` · stopped: ${chain.stoppedBy}` : '') +
    (notRun ? ` · ${notRun} not run` : '');
}

function renderChain() {
  const box = $('rChain');
  box.hidden = !chain;
  if (!chain) return;
  box.replaceChildren();
  chain.flows.forEach((f, k) => {
    const res = chain.results[k];
    const cur = !chain.done && k === chain.index && !res;
    const icon = res ? (res.passed ? '✓' : '✗') : cur ? '▶' : '·';
    const li = el('li', res ? (res.passed ? 'ok' : 'bad') : cur ? 'cur' : 'todo');
    li.append(el('span', 'ci', icon), el('span', '', `${k + 1}. ${f.name}`));
    if (res) li.append(el('span', 'cnote', `steps ${res.steps}${res.checks ? ` · checks ${res.checks}` : ''}${res.failedItems ? ` · ${res.failedItems} items failed` : ''}${res.status === 'stopped' ? ' · stopped' : ''}`));
    box.append(li);
  });
}

function chainReport() {
  const dt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  const out = [`# Chain run report — 📁 ${chain.group}`, '',
    `- **Started:** ${dt(chain.startedAt)} · **Finished:** ${dt(chain.endedAt)} · **Duration:** ${fmtDur((chain.endedAt || Date.now()) - chain.startedAt)}`,
    ...(chain.run.envName ? [`- **Environment:** ${chain.run.envName}`] : []),
    `- **If a flow fails:** ${chain.onFail === 'stop' ? 'stop the chain' : 'continue with the next flow'}`,
    `- **Result:** ${chainSummary()}`, '',
    '| # | Flow | Result | Steps done | Checks passed | Duration |', '|---|---|---|---|---|---|'];
  chain.flows.forEach((f, k) => {
    const r = chain.results[k];
    out.push(r
      ? `| ${k + 1} | ${f.name} v${flowVersion(f)} | ${r.passed ? '✓ PASS' : r.status === 'stopped' ? '■ STOPPED' : '✗ FAIL'} | ${r.steps}${r.skipped ? ` (${r.skipped} skipped)` : ''} | ${r.checks || '—'} | ${fmtDur((r.endedAt || 0) - (r.startedAt || 0))} |`
      : `| ${k + 1} | ${f.name} v${flowVersion(f)} | not run | — | — | — |`);
  });
  out.push('');
  chain.results.forEach((r, k) => {
    out.push('---', '', ...r.report.split('\n').map((l) => (/^#+ /.test(l) ? '#' + l.replace(/^# Run report — /, `# ${k + 1}. `) : l)), '');
  });
  return out.join('\n');
}

function notifyChain() {
  if (!notifyOn() || (document.hasFocus() && document.visibilityState === 'visible')) return;
  const tabId = replayer?.mainTab || 0;
  const bad = chain.results.some((x) => !x.passed) || chain.results.length < chain.flows.length;
  chrome.notifications.create(`ar-${tabId}-${Math.random().toString(36).slice(2, 8)}`, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: 1,
    title: bad ? `Chain finished with problems — 📁 ${chain.group}` : `Chain finished — 📁 ${chain.group}`,
    message: chainSummary(), contextMessage: `${chain.flows.length} flows`,
  }, () => void chrome.runtime.lastError);
}

function startReplay(flow, debug = false, run = {}) {
  if (state.recording || replayer) return;
  const lacking = requiredVars(flow).filter((n) => !String(run.vars?.[n] ?? '').trim());
  if (lacking.length) return openRunForm(flow, debug); // required variables are checked in the run form
  lastNotifyStatus = '';
  replayFlowName = `${flow.name} v${flowVersion(flow)}`;
  replayer = new Replayer(flow, { recordedWaits: $('recordedWaits').checked, debug, ...run }, renderReplay);
  $('rTitle').textContent = run.inChain && chain
    ? `⛓ ${chain.group} — ${chain.index + 1}/${chain.flows.length}: ${flow.name} v${flowVersion(flow)}${run.envName ? ` · ${run.envName}` : ''}`
    : `${debug ? '🐞 Debugging' : 'Replaying'}: ${flow.name} v${flowVersion(flow)}${run.envName ? ` · ${run.envName}` : ''}`;
  $('replayView').classList.toggle('debugmode', debug);
  $('rHint').hidden = !debug;
  show('replay');
  render();
  renderFlows();
  renderReplay(replayer);
  replayer.run();
}

// ---------- desktop notifications for replays ----------
const NOTIFY = {
  waiting: { title: 'Replay needs you', ask: true },
  approval: { title: 'Replay waiting for your approval', ask: true },
  input: { title: 'Replay needs a value', ask: true },
  failed: { title: 'Replay step failed — Retry, Skip or Stop?', ask: true },
  paused: { title: 'Replay paused at a breakpoint', ask: true, only: /^● Breakpoint/ },
  done: { title: 'Replay finished' },
  stopped: { title: 'Replay stopped' },
};
let lastNotifyStatus = '';
let openNotification = null;
function notifyOn() { try { return localStorage.getItem('notify') !== '0'; } catch (_) { return true; } }

function notifyReplay(r) {
  if (r.status === lastNotifyStatus) return;
  lastNotifyStatus = r.status;
  if (openNotification) { chrome.notifications.clear(openNotification); openNotification = null; } // the previous question is answered
  const n = NOTIFY[r.status];
  if (chain && ['done', 'stopped'].includes(r.status)) return; // the chain sends one notification at the end
  if (!n || !notifyOn() || (n.only && !n.only.test(r.message))) return;
  if (document.hasFocus() && document.visibilityState === 'visible') return; // you are looking at the panel already
  const step = r.steps[r.index];
  const tabId = (step && r.tabMap.get(step.tabId)) || r.mainTab || 0;
  const id = `ar-${tabId}-${Math.random().toString(36).slice(2, 8)}`;
  const failedChecks = [...r.checks.values()].filter((c) => !c.passed).length;
  chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icons/icon128.png', priority: n.ask ? 2 : 1,
    title: r.status === 'done' && failedChecks ? `Replay finished — ${failedChecks} check(s) failed` : n.title,
    message: r.message || '', contextMessage: replayFlowName,
    requireInteraction: !!n.ask, // questions stay on screen until you react
  }, () => void chrome.runtime.lastError);
  if (n.ask) openNotification = id;
}

function renderReplay(r) {
  if (chain && r === replayer && ['done', 'stopped'].includes(r.status) && !r.chainHandled) chainFlowFinished(r);
  notifyReplay(r);
  const finished = ['done', 'stopped'].includes(r.status);
  $('rDot').className = 'dot ' + (r.status === 'running' ? 'on' : r.status === 'waiting' || r.status === 'failed' ? 'paused' : '');
  $('rMsg').textContent = r.message;
  $('rBar').className = 'rbar ' + r.status;
  $('rContinue').hidden = r.status !== 'waiting';
  $('rStep').hidden = r.status !== 'paused';
  $('rApprove').hidden = r.status !== 'approval';
  $('rReject').hidden = r.status !== 'approval';
  const asking = r.status === 'input';
  if (asking && $('rInputBox').hidden) {
    $('rInput').value = '';
    $('rInput').type = r.inputSpec?.secret ? 'password' : 'text';
    $('rInput').placeholder = r.inputSpec ? `{{${r.inputSpec.varName}}}` : '';
    requestAnimationFrame(() => $('rInput').focus());
  }
  $('rInputBox').hidden = !asking;
  $('rResume').hidden = r.status !== 'paused';
  $('rRetry').hidden = r.status !== 'failed';
  $('rSkip').hidden = !['failed', 'waiting', 'paused'].includes(r.status);
  const chainEnd = !chain || chain.done; // in a chain, the buttons appear when the last flow has finished
  $('rStop').hidden = finished && chainEnd;
  $('rClose').hidden = !finished || !chainEnd;
  $('rData').hidden = !finished || !chainEnd || !(chain ? chain.results.some((x) => x.extracted.length) : r.extracted.length);
  $('rReport').hidden = !finished || !chainEnd;
  $('rReport').textContent = chain ? 'Download chain report' : 'Download run report';
  if (chain && chain.done) $('rMsg').textContent = chainSummary();
  else if (chain && finished && r.chainHandled) $('rMsg').textContent = `${r.message} — next: ${chain.flows[chain.index].name} …`;
  renderChain();
  $('rData').textContent = r.loopResults.length && r.extracted.length === r.loopResults.length ? 'Download item results (.csv)'
    : r.extracted.length > 1 ? `Download data (${r.extracted.length} files)` : 'Download extracted data (.csv)';

  const canBack = r.steps.some((_, k) => r.canGoBack(k));
  $('rHint').hidden = !r.debug && !canBack;
  $('rHint').textContent = canBack ? '↩ To run again from an earlier step (e.g. after fixing something on the page), press ↩ from here on that step.'
    : '🐞 Debug mode — click a step number to set or remove a breakpoint ●';

  const list = $('rSteps');
  list.replaceChildren();
  let inLoop = false;
  const rDepths = ifDepths(r.steps);
  r.steps.forEach((s, i) => {
    const res = r.results[i];
    if (s.type === 'loopEnd') inLoop = false;
    const li = el('li', `step r-${res.status}` + (inLoop ? ' inloop' : '') + (s.type === 'loopStart' || s.type === 'loopEnd' ? ' loopmark' : '') +
      (isIfMarker(s) ? ' ifmark' : '') + (rDepths[i] ? ' inif' : ''));
    if (rDepths[i]) li.style.setProperty('--d', String(rDepths[i]));
    if (s.type === 'loopStart') inLoop = true;
    const bp = r.debug && r.breakpoints.has(s.id);
    const num = el('span', 'num' + (bp && !ICON[res.status] ? ' bp' : ''), ICON[res.status] || (bp ? '●' : String(i + 1)));
    if (r.debug && s.type !== 'loopEnd') {
      num.title = bp ? 'Remove breakpoint' : 'Set a breakpoint here (pause before this step)';
      num.addEventListener('click', () => {
        const list = r.toggleBreakpoint(s.id);
        saveFlows(flows.map((f) => (f.id === r.flow.id ? { ...f, breakpoints: list } : f))); // remembered with the flow
      });
    }
    li.append(num);
    const body = stepBody(s, false);
    if (res.msg) body.append(el('div', 'rnote', res.msg));
    li.append(body);
    const meta = el('span', 'meta');
    meta.append(el('span', 'time', String(i + 1)));
    if (r.canGoBack(i)) {
      const back = el('button', 'rback', '↩ from here');
      back.title = `Run again from step ${i + 1}: this step and the ones after it run again (variables keep their values)`;
      back.addEventListener('click', () => r.goBack(i));
      meta.append(back);
    }
    li.append(meta);
    list.append(li);
    if (['running', 'failed', 'waiting', 'paused'].includes(res.status)) {
      requestAnimationFrame(() => li.scrollIntoView({ block: 'nearest' }));
    }
  });
}

// "after step 3, inside: If {{ENV}} is "prod"" — the ⤵ insertion point in words.
function insertWhere(steps, at) {
  const s = steps[at];
  let n = 0;
  for (let j = 0; j <= at; j++) if (!isIfMarker(steps[j]) && !['note', 'loopEnd'].includes(steps[j].type)) n++;
  const caseName = (m) => {
    const head = steps.find((x) => x.type === 'ifStart' && x.blockId === m.blockId);
    return m.type === 'else' ? `Else of "If ${condText(head?.cond)}"` : m.type === 'elif' ? `"Else if ${condText(m.cond)}"` : `"If ${condText(m.cond)}"`;
  };
  let where = '';
  for (let j = at, skip = 0; j >= 0; j--) {
    const m = steps[j];
    if (m.type === 'ifEnd') skip++;
    else if (m.type === 'ifStart' && skip) skip--;
    else if (!skip && ['ifStart', 'elif', 'else'].includes(m.type)) { where = caseName(m); break; }
  }
  const pos = isIfMarker(s) && s.type !== 'ifEnd' ? 'at the start of the case' : s.type === 'ifEnd' ? 'right after the If block' : n ? `after step ${n}` : 'at the start';
  return where ? `${pos}, inside ${where}` : pos;
}

$('insEnd').addEventListener('click', () => send({ type: 'setInsert', id: null }));

$('rContinue').addEventListener('click', () => replayer?.answer('continue'));
$('rStep').addEventListener('click', () => replayer?.answer('step'));
$('rApprove').addEventListener('click', () => replayer?.answer('approve'));
$('rReject').addEventListener('click', () => replayer?.answer('reject'));
$('rInputOk').addEventListener('click', () => replayer?.answer('ok', $('rInput').value));
$('rInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') replayer?.answer('ok', $('rInput').value); });
$('rInputCancel').addEventListener('click', () => replayer?.answer('cancel'));
$('rResume').addEventListener('click', () => replayer?.answer('resume'));
$('rReport').addEventListener('click', () => {
  if (chain) return download(`${slug(chain.group)}-chain-run-${fileStamp(chain.startedAt)}.md`, chainReport(), 'text/markdown');
  if (replayer) download(`${slug(replayer.flow.name)}-v${replayer.flow.version || 1}-run-${fileStamp(replayer.startedAt)}.md`, replayer.checkReport(), 'text/markdown');
});
$('rData').addEventListener('click', () => {
  if (chain) {
    chain.results.forEach((res) => res.extracted.forEach((x, k) => download(`${slug(res.flow.name)}-data${k ? '-' + (k + 1) : ''}-${fileStamp()}.csv`, toCSV(x.fields, x.rows), 'text/csv')));
    return;
  }
  replayer?.extracted.forEach((x, k) => download(`${slug(replayer.flow.name)}-data${k ? '-' + (k + 1) : ''}-${fileStamp()}.csv`, toCSV(x.fields, x.rows), 'text/csv'));
});
$('rRetry').addEventListener('click', () => replayer?.answer('retry'));
$('rSkip').addEventListener('click', () => replayer?.answer('skip'));
$('rStop').addEventListener('click', () => {
  if (chain && !chain.done && replayer && ['done', 'stopped'].includes(replayer.status)) {
    // Between two flows: stop the chain here.
    chain.stoppedBy = 'you stopped it';
    chain.done = true;
    chain.endedAt = Date.now();
    return renderReplay(replayer);
  }
  replayer?.stop();
});
$('rClose').addEventListener('click', () => {
  replayer = null;
  chain = null;
  renderChain();
  show('flows');
  render();
  renderFlows();
});

// ---------------------------------------------------------------- extract list
// xs: { tabId, url, title, list, fieldSpecs, count, preview, next, maxPages, result, running, picking }
let xs = {};
let xStopFlag = false;

function tableEl(fields, rows, max = 100) {
  const t = el('table');
  const head = el('tr');
  head.append(el('th', '', '#'));
  fields.forEach((f) => head.append(el('th', '', f)));
  t.append(head);
  rows.slice(0, max).forEach((r, i) => {
    const tr = el('tr');
    tr.append(el('td', '', String(i + 1)));
    fields.forEach((f) => { const td = el('td', '', r[f] ?? ''); td.title = r[f] ?? ''; tr.append(td); });
    t.append(tr);
  });
  return t;
}

function renderExtract() {
  const has = !!xs.list;
  const fieldNames = (xs.fieldSpecs || []).map((f) => f.name);
  $('xPick').textContent = xs.picking === 'item' ? 'Cancel picking' : has ? '⊞ Pick again' : '⊞ Pick list item';
  $('xPick').disabled = !!xs.running || xs.picking === 'next';
  $('xShow').hidden = !has || !!xs.picking;
  $('xListInfo').replaceChildren();
  if (xs.picking === 'item') $('xListInfo').textContent = 'Hover over the page — matching items are outlined in green. Click one item to select the list. Esc cancels.';
  else if (has) $('xListInfo').append(el('b', '', `${xs.count} items on this page`), ` · fields: ${fieldNames.join(', ')}`);
  else $('xListInfo').textContent = xs.error || 'Pick one item of the list in the page. All items like it are highlighted while you hover.';
  $('xPreview').hidden = !has;
  if (has) $('xPreview').replaceChildren(tableEl(fieldNames, xs.preview || [], 5));

  $('xNextBox').hidden = !has;
  if (has) {
    const n = xs.next;
    $('xNextInfo').replaceChildren();
    if (xs.picking === 'next') $('xNextInfo').textContent = 'Click the "Next page" or "Load more" button in the page (shown in orange). Esc cancels.';
    else if (n) $('xNextInfo').append('Next button: ', el('b', '', `${n.kind} "${n.label || n.selector}"`), xs.nextAuto ? ' (auto-detected — shown in orange)' : '');
    else $('xNextInfo').textContent = 'No pagination — only the current page will be extracted.';
    $('xPickNext').textContent = xs.picking === 'next' ? 'Cancel picking' : n ? 'Pick another' : 'Pick Next button';
    $('xPickNext').disabled = !!xs.running || xs.picking === 'item';
    $('xNoNext').hidden = !n;
    $('xMax').disabled = !n || !!xs.running;
  }

  $('xRunBox').hidden = !has;
  const capturing = state.recording && !state.paused;
  $('xRecInfo').textContent = capturing ? 'Recording is on: this extraction will be added to the recording as a step, with its data.' : '';
  $('xRun').disabled = !has || !!xs.running || !!xs.picking || !!replayer;
  $('xRun').textContent = xs.next ? 'Extract all pages' : 'Extract this page';
  $('xStop').hidden = !xs.running;
  $('xResult').hidden = !xs.result;
  if (xs.result) $('xData').replaceChildren(tableEl(xs.result.fields, xs.result.rows));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^(https?|file):/.test(tab.url || '')) throw new Error('Open a normal web page first (this does not work on browser or extension pages).');
  return tab;
}

async function pick(mode) {
  if (xs.picking) {
    xs.picking = null;
    renderExtract();
    if (xs.tabId) pageCall(xs.tabId, { type: 'list:cancel' }).catch(() => {});
    return;
  }
  try {
    const tab = mode === 'item' ? await activeTab() : await chrome.tabs.get(xs.tabId);
    if (mode === 'item') xs = { tabId: tab.id, maxPages: xs.maxPages };
    xs.picking = mode;
    xs.error = '';
    renderExtract();
    const r = await pageCall(tab.id, { type: 'list:pick', mode, list: xs.list });
    xs.picking = null;
    if (r.cancelled) return renderExtract();
    if (mode === 'item') {
      Object.assign(xs, { url: tab.url, title: tab.title, list: r.list, fieldSpecs: r.fields, count: r.count, preview: r.preview, next: r.next, nextAuto: !!r.next, result: null });
    } else {
      Object.assign(xs, { next: r.next, nextAuto: false });
    }
  } catch (err) {
    xs.picking = null;
    xs.error = err.message;
    if (mode === 'next') alert(err.message);
  }
  renderExtract();
}

$('xPick').addEventListener('click', () => pick('item'));
$('xPickNext').addEventListener('click', () => pick('next'));
$('xNoNext').addEventListener('click', () => { xs.next = null; renderExtract(); });
$('xShow').addEventListener('click', () => pageCall(xs.tabId, { type: 'list:show', list: xs.list, next: xs.next, ms: 4000 }).catch((e) => alert(e.message)));
$('xStop').addEventListener('click', () => { xStopFlag = true; });

$('xRun').addEventListener('click', async () => {
  const spec = { list: xs.list, fields: xs.fieldSpecs, next: xs.next, maxPages: Math.max(1, Number($('xMax').value) || 20) };
  const addToRecording = state.recording && !state.paused;
  const t = Date.now();
  xs.running = true;
  xs.result = null;
  xStopFlag = false;
  $('xProgress').textContent = 'Starting…';
  renderExtract();
  if (addToRecording) await send({ type: 'suspend', on: true });
  try {
    const tab = await chrome.tabs.get(xs.tabId);
    const res = await extractAll(xs.tabId, spec, {
      onProgress: (p) => { $('xProgress').textContent = `Page ${p.pages} · ${p.rows} items so far…`; },
      shouldStop: () => xStopFlag,
    });
    xs.result = res;
    $('xProgress').textContent = `Done: ${res.rows.length} items from ${res.pages} page${res.pages === 1 ? '' : 's'}${res.stopReason ? ` — stopped because ${res.stopReason}` : ''}.`;
    if (addToRecording) {
      await send({ type: 'addStep', step: {
        type: 'extract', t, tEnd: Date.now(), tabId: xs.tabId, url: tab.url, title: xs.title,
        spec: { ...spec, fields: res.fieldSpecs },
        result: { fields: res.fields, rows: res.rows, pages: res.pages, stopReason: res.stopReason },
      } });
    }
  } catch (err) {
    $('xProgress').textContent = `Error: ${err.message}`;
  } finally {
    if (addToRecording) await send({ type: 'suspend', on: false });
    xs.running = false;
    renderExtract();
  }
});

const xName = () => slug(xs.title || 'list');
$('xCsv').addEventListener('click', () => download(`${xName()}-${fileStamp()}.csv`, toCSV(xs.result.fields, xs.result.rows), 'text/csv'));
$('xJson').addEventListener('click', () => download(`${xName()}-${fileStamp()}.json`, JSON.stringify({ url: xs.url, title: xs.title, extractedAt: new Date().toISOString(), pages: xs.result.pages, fields: xs.result.fields, items: xs.result.rows }, null, 2), 'application/json'));
$('xMd').addEventListener('click', (e) => copy(`# ${xs.title || 'Extracted list'}\n\nSource: ${xs.url}\n\n${xs.result.rows.length} items from ${xs.result.pages} pages.\n\n${mdTable(xs.result.fields, xs.result.rows, Infinity)}\n`, e.currentTarget));

// ---------------------------------------------------------------- state sync
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let rec = false;
  for (const [k, v] of Object.entries(changes)) {
    if (k in DEFAULTS) { state[k] = v.newValue ?? DEFAULTS[k]; rec = true; }
  }
  if (changes.flows) {
    flows = changes.flows.newValue || [];
    if (state.editingFlowId) rec = true; // the editing banner shows the flow's version
  }
  if (changes.envs) { envs = changes.envs.newValue || []; renderEnvs(); }
  if (changes.groups) groups = changes.groups.newValue || [];
  if (rec) { render(); renderExtract(); }
  renderFlows();
});

document.querySelectorAll('.version').forEach((n) => { n.textContent = 'v' + chrome.runtime.getManifest().version; });
document.querySelectorAll('.credit').forEach((n) => {
  n.textContent = `© ${new Date().getFullYear()} Mustafa Erbay. All rights reserved.`;
});
chrome.storage.local.get({ ...DEFAULTS, flows: [], envs: [], groups: [] }).then((s) => {
  flows = s.flows;
  // Flows saved before 5.0 could keep a password as a variable default: remove it once.
  if (flows.some((f) => secureFlow(f) !== f)) saveFlows(flows);
  envs = s.envs;
  groups = s.groups;
  delete s.flows;
  delete s.envs;
  delete s.groups;
  state = s;
  render();
  renderFlows();
  renderExtract();
});
