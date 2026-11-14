/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// Turns recorded steps into human/agent-readable text. Shared by the side panel and export.
const WAIT_MS = 1500; // pauses shorter than this are not worth mentioning
const LONG_IDLE_MS = 60000;

function fmtDur(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return s.toFixed(1).replace(/\.0$/, '') + 's';
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtOffset(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function code(v) {
  const s = String(v ?? '');
  return s.includes('`') ? '`` ' + s + ' ``' : '`' + s + '`';
}

// ---- how an element is named for people and agents
// A label that is only a number ("0", "1.5") is a sample value / placeholder, not a name — an agent would read it as
// the field's current value. Such labels are left out.
const NUMERIC_LABEL = /^[-+]?[\d\s.,%]*$/;
const usableLabel = (t) => { const l = (t && t.label) || ''; return l && !NUMERIC_LABEL.test(l) ? l : ''; };
const kindWord = (t) => (t.kind === 'radio' ? 'radio option' : t.kind || 'element');
// Older recordings have no row / column names: the position in the table is in the selector.
function cellPosition(sel) {
  const m = /tr:nth-of-type\((\d+)\)\s*>\s*td:nth-of-type\((\d+)\)/.exec(sel || '');
  return m ? { rowNo: Number(m[1]), colNo: Number(m[2]) } : null;
}
function elementName(t) {
  if (!t) return 'element';
  const l = usableLabel(t);
  let name = l ? `${kindWord(t)} "${l}"` : kindWord(t);
  if (t.cell && (t.cell.row || t.cell.col)) {
    const parts = [t.cell.row ? `row "${t.cell.row}"` : '', t.cell.col ? `column "${t.cell.col}"` : ''].filter(Boolean);
    name += ` in ${parts.join(', ')}${t.cell.table ? ` of table "${t.cell.table}"` : ''}`;
  } else if (!l) {
    const pos = cellPosition(t.selector);
    if (pos) name += ` in table row ${pos.rowNo}, column ${pos.colNo}`;
  }
  if (t.group) name += ` (question "${t.group}")`;
  if (t.dialog) name += ` in dialog ${t.dialog.title ? `"${t.dialog.title}"` : t.dialog.selector}`;
  return name;
}

function navVerb(s) {
  if (s.transition === 'start') return 'Start on';
  if (s.transition === 'resume') return 'Open';
  if (s.qualifiers && s.qualifiers.includes('forward_back')) return 'Browser back/forward to';
  if (s.transition === 'reload') return 'Reload';
  if (['typed', 'auto_bookmark', 'generated', 'keyword', 'start_page'].includes(s.transition)) return 'Go to';
  return 'Page opens';
}

function dialogAnswer(s) {
  if (s.kind === 'alert') return 'OK';
  if (s.kind === 'confirm') return s.result ? 'OK' : 'Cancel';
  return s.result == null ? 'Cancel' : `type "${s.result}" and OK`;
}
const DIALOG_NAMES = { alert: 'Browser alert', confirm: 'Browser confirm', prompt: 'Browser prompt' };

const MD_TABLE_ROWS = 200; // rows put into Markdown; the full data is in the CSV/JSON export

function mdTable(fields, rows, max = MD_TABLE_ROWS) {
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 200);
  const out = [`| # | ${fields.map(cell).join(' | ')} |`, `|---|${fields.map(() => '---').join('|')}|`];
  rows.slice(0, max).forEach((r, i) => out.push(`| ${i + 1} | ${fields.map((f) => cell(r[f])).join(' | ')} |`));
  if (rows.length > max) out.push('', `_…${rows.length - max} more rows not shown — see the CSV/JSON export._`);
  return out.join('\n');
}

// ---- variables: {{NAME}} placeholders in step values
const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
const BUILTIN_VARS = ['item', 'index'];
// Variables filled in by the replay for the "After the run" requests.
const AFTER_VARS = {
  FLOW_NAME: 'name of the flow', FLOW_VERSION: 'version, e.g. 4', RUN_RESULT: 'PASSED, FAILED or STOPPED',
  RUN_SUMMARY: 'the final message, e.g. "Replay finished — 9 of 9 steps done"', FAILED_STEPS: 'the failed steps and why (or "none")',
  DURATION: 'how long the run took, e.g. 1m 05s', STARTED_AT: 'start time', FINISHED_AT: 'end time', ENV: 'environment name',
  RUN_REPORT: 'the whole run report (Markdown)',
  TEST_RESULTS: 'the test steps, e.g. "3 of 4 passed — failed: TC-02 Login"', TEST_TABLE: 'the test steps as a Markdown table',
};
const AFTER_WHEN = { always: 'always (whatever the result)', success: 'only if the run PASSED', failure: 'only if it FAILED or was STOPPED' };
// Variables the "After the run" requests need from the user / environment (not the run ones).
const afterVars = (flow) => usedVars((flow.after || []).map((h) => ({ ...h, type: 'http' }))).filter((n) => !(n in AFTER_VARS));

// Names of the variables a list of steps refers to (built-ins and values asked for during the run excluded).
// 🧪 Test steps: a name (e.g. "TC-03 Login shows the dashboard"), an expected result, and conditions that must all hold.
const testTitle = (s) => `"${s.name || 'Test step'}"`;
const testConds = (s, and = ' and ') => (s.conds || []).map(condText).join(and) || '(no condition)';

function usedVars(steps) {
  const asked = new Set([...steps.filter((s) => (s.type === 'approval' && s.mode === 'input') || s.type === 'capture').map((s) => s.varName),
    ...steps.filter((s) => s.saveAs).map((s) => s.saveAs),
    ...steps.filter((s) => s.type === 'http').flatMap((s) => (s.save || []).map((x) => x && x.varName))]);
  const names = new Set();
  const scan = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(VAR_RE)) names.add(m[1]);
    else if (Array.isArray(v)) v.forEach(scan);
  };
  for (const s of steps) [s.value, s.url, s.key, s.text, s.result, s.check?.keywords, s.when?.value, s.body, (s.headers || []).map((h) => h && h.value)].forEach(scan);
  for (const s of steps) if (s.when?.var && whenSource(s.when) === 'var') names.add(s.when.var);
  for (const s of steps) if (s.cond?.var && whenSource(s.cond) === 'var') names.add(s.cond.var);
  for (const s of steps) if (s.cond?.value) scan(s.cond.value);
  for (const s of steps) for (const c of s.conds || []) { if (c?.var && whenSource(c) === 'var') names.add(c.var); if (c?.value) scan(c.value); }
  return [...names].filter((n) => !BUILTIN_VARS.includes(n) && !asked.has(n));
}

// ---- secrets: a variable typed into a password field is a secret, whatever its flag says
function passwordVars(steps) {
  const out = new Set();
  for (const s of steps || []) {
    if (s.type === 'type' && s.sensitive && typeof s.value === 'string') for (const m of s.value.matchAll(VAR_RE)) out.add(m[1]);
  }
  return out;
}
// The flow's variables with password variables made 🔒 (value removed). Returns the same array if nothing changed.
function secureVars(steps, vars) {
  const pw = passwordVars(steps);
  let changed = false;
  const out = (vars || []).map((v) => {
    if (!pw.has(v.name) || (v.secret && !v.value)) return v;
    changed = true;
    return { ...v, secret: true, value: '' };
  });
  return changed ? out : vars;
}

// ---- conditions: a step runs only if a variable matches ("when")
const WHEN_OPS = {
  eq: 'is', ne: 'is not', contains: 'contains', notContains: 'does not contain',
  empty: 'is empty', notEmpty: 'is not empty', regex: 'matches regex', notRegex: 'does not match regex',
};
const WHEN_NEGATE = { eq: 'ne', ne: 'eq', contains: 'notContains', notContains: 'contains', empty: 'notEmpty', notEmpty: 'empty', regex: 'notRegex', notRegex: 'regex' };
const whenNeedsValue = (op) => !['empty', 'notEmpty'].includes(op);
// Conditions can look at a variable (default), at the text of the page, or at the page's address.
const WHEN_SOURCES = { var: 'variable', page: 'page text', url: 'page URL' };
// source "else": the Else case of an If / Else if block (runs when none of the cases above ran)
const WHEN_SOURCE_OPS = { var: Object.keys(WHEN_OPS), page: ['contains', 'notContains'], url: ['contains', 'notContains', 'regex', 'notRegex'] };
const whenSource = (w) => (w && w.source) || 'var';
const isWhen = (w) => !!w && (whenSource(w) !== 'var' || !!w.var);
function whenText(w) {
  if (!isWhen(w)) return '';
  const src = whenSource(w);
  if (src === 'else') return 'none of the cases above (else)';
  if (w.branch === 'elif') return `else if ${whenText({ ...w, branch: 'if' })}`;
  if (src === 'page') return `the page ${w.op === 'notContains' ? 'does not show' : 'shows'} "${w.value ?? ''}"`;
  if (src === 'url') return `the page URL ${WHEN_OPS[w.op] || w.op} "${w.value ?? ''}"`;
  return `{{${w.var}}} ${WHEN_OPS[w.op] || w.op}${whenNeedsValue(w.op) ? ` "${w.value ?? ''}"` : ''}`;
}
// Compare trimmed and case-insensitively. Unknown variables count as empty.
function evalWhen(w, vars, page = {}) {
  const src = whenSource(w);
  if (src === 'else') return { ok: true, actual: '', known: true };
  if (src === 'page') {
    // page.found: whether the text is on the page (looked up by the replay)
    const ok = w.op === 'notContains' ? !page.found : !!page.found;
    return { ok, actual: page.found ? 'shown' : 'not shown', known: true };
  }
  if (src === 'url') return evalWhen({ ...w, source: 'var', var: '__url' }, { ...vars, __url: page.url || '' });
  const raw = vars[w.var];
  const actual = raw == null ? '' : String(raw).trim();
  const want = String(w.value ?? '').replace(VAR_RE, (m, n) => (vars[n] == null ? '' : String(vars[n]))).trim();
  const a = actual.toLocaleLowerCase();
  const b = want.toLocaleLowerCase();
  let ok;
  switch (w.op) {
    case 'ne': ok = a !== b; break;
    case 'contains': ok = a.includes(b); break;
    case 'notContains': ok = !a.includes(b); break;
    case 'empty': ok = a === ''; break;
    case 'notEmpty': ok = a !== ''; break;
    case 'regex': case 'notRegex': {
      let re;
      try { re = new RegExp(want, 'i'); } catch (e) { throw new Error(`Condition regex is not valid: ${e.message}`); }
      ok = re.test(actual) === (w.op === 'regex');
      break;
    }
    default: ok = a === b;
  }
  return { ok, actual, known: raw != null };
}

// ---- value operations of "Type" / "Set" steps: replace (default), add to / subtract from the number in the field, append
const VALUE_OPS = { replace: 'Replace the value with', add: 'Add to the number in the field', sub: 'Subtract from the number in the field', append: 'Append to the text in the field' };
const saveAsText = (s) => (s.saveAs ? ` → {{${s.saveAs}}}` : '');

// ---- ⑂ If blocks: marker steps ifStart (cond) / elif (cond) / else / ifEnd, linked by blockId
const IF_MARKERS = ['ifStart', 'elif', 'else', 'ifEnd'];
const isIfMarker = (s) => !!s && IF_MARKERS.includes(s.type);
const condText = (c) => whenText({ ...(c || {}), branch: 'if' });
// Nesting depth of each step (rows of the If / Else if / Else / End if markers sit at the block's own depth).
function ifDepths(steps) {
  let d = 0;
  return steps.map((s) => {
    if (s.type === 'ifStart') return d++;
    if (s.type === 'ifEnd') return (d = Math.max(0, d - 1));
    if (s.type === 'elif' || s.type === 'else') return Math.max(0, d - 1);
    return d;
  });
}

// Flows saved with 3.6–3.10 kept conditions on each step ("when"). Turn runs of steps with the same condition
// (and their Else if / Else cases) into If / Else if / Else / End if rows. Steps that cannot be converted keep "when".
function convertWhens(steps) {
  const rid = () => Math.random().toString(36).slice(2, 10);
  const keyOf = (w) => JSON.stringify(w);
  const strip = (w) => { const { group, branch, ...c } = w; return c; };
  const out = [];
  let i = 0;
  while (i < steps.length) {
    const s = steps[i];
    if (!isWhen(s.when) || whenSource(s.when) === 'else' || s.when.branch === 'else' || s.when.branch === 'elif' || s.type === 'loopEnd') { out.push(s); i++; continue; }
    const first = s.when;
    const blockId = rid();
    out.push({ id: blockId, type: 'ifStart', blockId, cond: strip(first), t: s.t, waitMs: 0 });
    let cur = keyOf(first);
    let lastT = s.t;
    while (i < steps.length) {
      const x = steps[i];
      if (!isWhen(x.when) || x.type === 'loopEnd') break;
      const k = keyOf(x.when);
      if (k !== cur) {
        if (!first.group || x.when.group !== first.group) break; // a different block
        const isElse = whenSource(x.when) === 'else' || x.when.branch === 'else';
        out.push(isElse ? { id: rid(), type: 'else', blockId, t: x.t, waitMs: 0 } : { id: rid(), type: 'elif', blockId, cond: strip(x.when), t: x.t, waitMs: 0 });
        cur = k;
      }
      const { when, ...plain } = x;
      out.push(plain);
      lastT = x.t;
      i++;
      if (x.type === 'loopStart') { // keep the whole loop inside the case
        while (i < steps.length && !(steps[i].type === 'loopEnd' && steps[i].loopId === x.id)) { out.push(steps[i]); i++; }
        if (i < steps.length) { out.push(steps[i]); lastT = steps[i].t; i++; }
      }
    }
    out.push({ id: rid(), type: 'ifEnd', blockId, t: lastT, waitMs: 0 });
  }
  return out;
}

// ---- 🌐 HTTP request steps
function httpStatusOk(step, status) {
  const ex = String(step.expect || '2xx').trim();
  if (ex === 'any') return true;
  if (ex === '2xx') return status >= 200 && status < 300;
  return ex.split(/[\s,]+/).filter(Boolean).some((c) => (/^\dxx$/i.test(c) ? Math.floor(status / 100) === Number(c[0]) : Number(c) === status));
}
const httpExpectText = (step) => { const ex = String(step.expect || '2xx').trim(); return ex === 'any' ? 'any status' : ex === '2xx' ? 'a 2xx status' : `status ${ex}`; };
// "data.items[0].id", "$.data.id", "@status" (status code), "@text" (whole response text)
function responseValue(path, res) {
  const p = String(path || '').trim();
  if (p === '@status') return String(res.status);
  if (p === '@text' || p === '') return res.text;
  if (res.json === undefined) return undefined;
  let cur = res.json;
  for (const part of p.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur !== null && typeof cur === 'object' ? JSON.stringify(cur) : cur;
}
const httpSaveText = (s) => (s.save || []).filter((x) => x && x.varName).map((x) => `${x.path || '@text'} → {{${x.varName}}}`).join(', ');

const captureWhat = (s) => (s.what === 'value' ? 'field value' : s.what === 'attr' ? `"${s.attr}" attribute` : 'text');

// ---- text checks
const quoteList = (ks) => ks.map((k) => `"${k}"`).join(', ');
function checkCondition(c) {
  const verb = c.mode === 'absent'
    ? (c.keywords.length > 1 ? 'contains none of' : 'does not contain')
    : (c.keywords.length > 1 ? 'contains all of' : 'contains');
  const opts = [c.match === 'word' ? 'whole word' : c.match === 'regex' ? 'regex' : '', c.caseSensitive ? 'match case' : ''].filter(Boolean);
  return `${verb} ${quoteList(c.keywords)}${opts.length ? ` (${opts.join(', ')})` : ''}`;
}
const checkWhere = (c) => (c.scope ? `area "${c.scope.name}"` : 'page');

// One line describing a check result, e.g. 'found "OK" (2×)' or 'not found: "Done"'.
function checkResultText(c, r) {
  if (!r) return '';
  if (r.error) return r.error;
  const found = r.details.filter((d) => d.count);
  const missing = r.details.filter((d) => !d.count);
  if (c.mode === 'absent') {
    const checked = r.textLength != null ? ` (checked ${r.textLength} characters)` : '';
    return r.passed ? `none found${checked}${r.warning ? ` — ⚠ ${r.warning}` : ''}` : `found ${found.map((d) => `"${d.keyword}" (${d.count}×) ${d.sample}`).join('; ')}`;
  }
  const shown = (d) => (d.match && d.match.toLowerCase() !== d.keyword.toLowerCase() ? `"${d.keyword}" → "${d.match}"` : `"${d.keyword}"`);
  return r.passed ? `found ${found.map((d) => `${shown(d)} (${d.count}×)`).join(', ')}` : `not found: ${quoteList(missing.map((d) => d.keyword))}`;
}

function extractSummary(s) {
  const r = s.result || {};
  return `${r.rows?.length ?? 0} items from ${r.pages ?? 0} page${r.pages === 1 ? '' : 's'}`;
}

// Structured description used by both the panel (plain) and Markdown export.
function describeStep(s) {
  const t = s.target || {};
  const thing = elementName(t);
  switch (s.type) {
    case 'navigate': return { verb: navVerb(s), text: s.url };
    case 'urlchange': return { verb: 'URL changes to', text: s.url };
    case 'tab': return { verb: 'Switch to tab', text: `${s.title || ''} — ${s.url}` };
    case 'click': return { verb: 'Click', text: thing };
    case 'dblclick': return { verb: 'Double-click', text: thing };
    case 'type': case 'set':
      if (s.valueOp === 'add') return { verb: 'Increase', text: `${thing} by "${s.value}"${saveAsText(s)}` };
      if (s.valueOp === 'sub') return { verb: 'Decrease', text: `${thing} by "${s.value}"${saveAsText(s)}` };
      if (s.valueOp === 'append') return { verb: 'Append', text: `"${s.value}" to ${thing}${saveAsText(s)}` };
      if (s.type === 'set') return { verb: 'Set', text: `${thing} to ${s.value}${saveAsText(s)}` };
      if (s.sensitive && s.value) return { verb: 'Type', text: `${s.value} 🔒 into ${thing}` };
      if (s.sensitive) return { verb: 'Type password into', text: thing };
      if (s.value === '') return { verb: 'Clear', text: thing };
      return { verb: 'Type', text: `"${s.value}" into ${thing}${saveAsText(s)}` };
    case 'select': return { verb: 'Select', text: `"${s.value}" in ${thing}` };
    case 'check': return { verb: t.kind === 'radio' ? 'Choose' : s.checked ? 'Tick' : 'Untick', text: thing };
    case 'upload': return { verb: 'Upload', text: `${s.value || 'file'} via ${thing}` };
    case 'key': return { verb: 'Press', text: s.key + (s.target ? ` in ${thing}` : '') };
    case 'note': return { verb: 'Note', text: s.text };
    case 'capture': return { verb: '⤓ Capture', text: `${captureWhat(s)} of ${s.target.name || s.target.selector} → {{${s.varName}}}${s.sample ? ` (was "${s.sample}")` : ''}` };
    case 'ifStart': return { verb: '⑂ If', text: condText(s.cond) };
    case 'elif': return { verb: '⑂ Else if', text: condText(s.cond) };
    case 'else': return { verb: '⑂ Else', text: '(none of the cases above)' };
    case 'ifEnd': return { verb: '⑂ End if', text: '' };
    case 'http': {
      const save = httpSaveText(s);
      return { verb: `🌐 ${(s.method || 'GET').toUpperCase()}`, text: `${s.url}${s.from === 'page' ? ' (from the page)' : ''}${save ? ` · ${save}` : ''}` };
    }
    case 'approval': return s.mode === 'input'
      ? { verb: '⏸ Ask', text: `"${s.text}" → {{${s.varName}}}${s.secret ? ' 🔒' : ''}${s.fill ? ` → type into ${s.fill.kind}${s.fill.label ? ` "${s.fill.label}"` : ''}` : ''}` }
      : { verb: '⏸ Approval', text: s.text };
    case 'loopStart': return { verb: '⟳ For each item', text: `in list ${s.loop.list.selector} · ${s.loop.count ?? '?'} items on the first page${s.loop.next ? ' · + next pages' : ''} · max ${s.loop.maxItems || 100} items` };
    case 'loopEnd': return { verb: '⟳ End of loop', text: 'back to the list, next item' };
    case 'verify': return { verb: 'Check', text: `${checkWhere(s.check)} ${checkCondition(s.check)}` };
    case 'test': return { verb: '🧪 Test step', text: `${testTitle(s)} — ${testConds(s)}` };
    case 'extract': return { verb: 'Extract list', text: `${extractSummary(s)} · fields: ${(s.result?.fields || []).join(', ')}` };
    case 'dialog': return { verb: DIALOG_NAMES[s.kind] || 'Browser dialog', text: `"${s.message}" → ${dialogAnswer(s)}` };
    case 'pause': return { verb: s.reason === 'stopped' ? 'Stopped' : 'Paused', text: s.tEnd ? fmtDur(s.tEnd - s.t) : '' };
    default: return { verb: s.type, text: '' };
  }
}

// Gap between the end of the previous step and the start of this one.
function waitBefore(steps, i) {
  if (i === 0 || steps[i].type === 'pause') return 0;
  if (steps[i].waitMs != null) return steps[i].waitMs; // fixed wait (steps inserted or moved while editing)
  const prev = steps[i - 1];
  if (prev.type === 'pause' && !prev.tEnd) return 0; // e.g. a note added while paused
  return Math.max(0, steps[i].t - (prev.tEnd || prev.t));
}

// Flow time of each step (ms from the start), built from the waits and step durations, so steps inserted or moved
// while editing a flow get sensible times. Pause markers get null.
function flowOffsets(steps) {
  const out = [];
  let clock = 0;
  let prev = null;
  steps.forEach((s, i) => {
    if (s.type === 'pause') { out.push(null); return; }
    if (prev) clock += Math.max(0, (prev.tEnd || prev.t) - prev.t) + waitBefore(steps, i);
    out.push(clock);
    prev = s;
  });
  return out;
}

// Total paused time (ms) that ended at or before time t; an open pause counts up to `now`.
function pausedBefore(steps, t, now = Date.now()) {
  let ms = 0;
  for (const s of steps) if (s.type === 'pause' && s.t < t) ms += Math.min(s.tEnd || now, t) - s.t;
  return ms;
}

function markdownStep(s) {
  const t = s.target || {};
  const shadow = t.shadowHosts ? ` (inside shadow DOM of ${t.shadowHosts.map(code).join(' › ')})` : '';
  // How to find it: the name first (label / row + column), then selectors — the most stable one first.
  const sels = [...(t.alt || []), t.selector].filter(Boolean);
  let sel = sels.length ? ` — selector ${sels.map(code).join(' or ')}` + shadow : shadow;
  let thing = `**${elementName(t)}**`;
  if (t.inItem) {
    // Inside a "For each item" loop: the same element of whichever item is current.
    thing = `${t.kind || 'element'} of the **current list item**${t.label ? ` (on the recorded item it was "${t.label}")` : ''}`;
    sel = ` — selector inside the item ${code(t.inItem.rel)}`;
  }
  switch (s.type) {
    case 'navigate': return `**${navVerb(s)}** ${s.url}${s.title ? ` _(${s.title})_` : ''}`;
    case 'urlchange': return `**URL changes to** ${s.url} _(in-page navigation, no reload)_`;
    case 'tab': return `**Switch to tab** "${s.title || ''}" — ${s.url}`;
    case 'click': return `**Click** ${thing}${sel}${s.notClicked ? ' _(this click was not done during the recording, so its result was not seen — check what happens)_' : ''}`;
    case 'dblclick': return `**Double-click** ${thing}${sel}`;
    case 'type': case 'set': {
      const keep = s.saveAs ? ` — then remember the new value as \`{{${s.saveAs}}}\` for the later steps` : '';
      if (s.valueOp === 'add' || s.valueOp === 'sub') {
        const plus = s.valueOp === 'add';
        const n = Number(String(s.value).replace(',', '.'));
        const ex = Number.isFinite(n) && !/\{\{/.test(s.value) ? ` Example: if it shows 2 now, type ${+(plus ? 2 + n : 2 - n).toFixed(6)}.` : '';
        return `**${plus ? 'Increase' : 'Decrease'}** the number in ${thing} by ${code(s.value)}${sel} — ` +
          `read the number it shows **now** → ${plus ? 'add' : 'subtract'} ${code(s.value)} → clear the field → type the result → check it shows the result.${ex}${keep}`;
      }
      if (s.valueOp === 'append') return `**Append** ${code(s.value)} to the text already in ${thing}${sel} — keep the existing text, add this at its end${keep}`;
      if (s.type === 'set') return `**Set** ${thing} to ${code(s.value)}${sel}${keep}`;
      if (s.sensitive && s.value) return `**Type the password** ${code(s.value)} into ${thing}${sel} _(🔒 secret — ask the user for it; never write it in your report)_`;
      if (s.sensitive) return `**Type the password** into ${thing}${sel} _(not recorded — ask the user for it)_`;
      if (s.value === '') return `**Clear** ${thing}${sel}`;
      return `**Type** ${code(s.value)} into ${thing}${sel} — replace what the field contains${keep}`;
    }
    case 'select': return `**Select** the option ${code(s.value)} in ${thing}${sel}`;
    case 'check': return t.kind === 'radio'
      ? `**Choose** ${thing}${sel} (click it so it is selected)`
      : `**${s.checked ? 'Tick' : 'Untick'}** ${thing}${sel} (make sure it ends up ${s.checked ? 'ticked' : 'not ticked'})`;
    case 'upload': return `**Upload file** ${code(s.value)} via ${thing}${sel}`;
    case 'key': return `**Press** ${code(s.key)}${s.target ? ` in ${thing}${sel}` : ''}`;
    case 'note': return `📝 **Note from user:** ${s.text}`;
    case 'capture':
      return `⤓ **Capture** the ${captureWhat(s)} of ${s.target.inItem ? 'the element in the **current list item**' : `**"${s.target.name}"**`}` +
        ` — selector ${code(s.target.inItem ? s.target.inItem.rel : s.target.selector)}${s.regex ? `, keep the part matching regex ${code(s.regex)}` : ''}` +
        ` — save it as \`{{${s.varName}}}\` for the later steps${s.sample ? ` (value when recorded: ${code(s.sample)})` : ''}`;
    case 'ifStart': return `⑂ **If** ${condText(s.cond)}: do the steps marked › below only in that case; otherwise go to the next **Else if** / **Else** / **End if** of this block${['page', 'url'].includes(whenSource(s.cond)) ? ' (look at the page once, when you reach this line)' : ''}`;
    case 'elif': return `⑂ **Else if** ${condText(s.cond)}: only if no case above ran — then do the steps marked › below`;
    case 'else': return '⑂ **Else**: only if none of the cases above ran — do the steps marked › below';
    case 'ifEnd': return '⑂ **End if** — continue here in every case';
    case 'http': {
      const hs = (s.headers || []).filter((h) => h && h.name).map((h) => `\`${h.name}: ${h.value}\``).join(', ');
      const save = (s.save || []).filter((x) => x && x.varName).map((x) => `${code(x.path || '@text')} as \`{{${x.varName}}}\``).join(', ');
      const body = s.bodyType && s.bodyType !== 'none' && s.body ? `\n\n   Body (${s.bodyType === 'json' ? 'JSON' : s.bodyType === 'form' ? 'form fields, one per line' : 'text'}):\n\n   \`\`\`${s.bodyType === 'json' ? 'json' : ''}\n${String(s.body).split('\n').map((l) => '   ' + l).join('\n')}\n   \`\`\`` : '';
      return `🌐 **Send an HTTP request** ${code(`${(s.method || 'GET').toUpperCase()} ${s.url}`)}` +
        (s.from === 'page' ? ' from the current page (with the user\'s login)' : '') +
        (hs ? ` with headers ${hs}` : '') +
        ` — it must answer with ${httpExpectText(s)}, otherwise stop and report the status and response text` +
        (save ? `; then save ${save} from the response for the later steps` : '') + body;
    }
    case 'approval':
      return s.mode === 'input'
        ? `⏸ **Ask the user:** "${s.text}" — use the answer as \`{{${s.varName}}}\` in later steps${s.secret ? ' (secret: do not log it)' : ''}` +
          (s.fill ? ` and type it into ${s.fill.kind}${s.fill.label ? ` **"${s.fill.label}"**` : ''} — selector ${code(s.fill.inItem ? s.fill.inItem.rel : s.fill.selector)}` : '')
        : `⏸ **Manual approval:** "${s.text}" — stop and wait until the user approves; if they reject, stop the flow`;
    case 'loopStart': {
      const L = s.loop;
      const pages = L.next
        ? `, also on the next pages (Next: ${L.next.kind} ${L.next.label ? `"${L.next.label}"` : '(icon, no text)'} — selector ${code(L.next.selector)}, up to ${L.maxPages || 20} pages)`
        : '';
      return `**For each item** in the list ${code(L.list.selector)}${pages}, max ${L.maxItems || 100} items — ` +
        'do the steps marked ↻ below for every item, then return to the list and continue with the next item';
    }
    case 'loopEnd':
      return '**End of loop** — return to the list (browser Back / close the popup or tab) and continue with the next item. When all items are done, report one row per item: item name, each check PASS/FAIL, any error';
    case 'test':
      return `**🧪 Test step ${testTitle(s)}** — check that ${(s.conds || []).length > 1 ? '**all** of these are true' : 'this is true'}: ` +
        `${testConds(s, ' **and** ')}${s.expected ? `. Expected result: ${s.expected}` : ''}. Record **PASS** or **FAIL** with what you saw` +
        `${s.onFail === 'stop' ? '; if it FAILS, stop and report' : '; if it FAILS, note it and continue'}`;
    case 'verify': {
      const c = s.check;
      const where = c.scope ? `the area **"${c.scope.name}"** (selector ${code(c.scope.selector)})` : 'the page';
      return `**Check** that ${where} ${checkCondition(c)}`;
    }
    case 'extract': {
      const f = (s.result?.fields || []).join(', ');
      return `**Extract all items of the list** — item selector ${code(s.spec.list.selector)}` +
        (s.spec.list.shadowHosts ? ` (inside shadow DOM of ${s.spec.list.shadowHosts.map(code).join(' › ')})` : '') +
        (f ? ` — fields: ${f}` : '');
    }
    case 'dialog': {
      const name = { alert: 'Browser alert', confirm: 'Browser confirm dialog', prompt: 'Browser prompt' }[s.kind] || 'Browser dialog';
      const answer = s.kind === 'alert' ? 'click **OK**'
        : s.kind === 'confirm' ? `click **${s.result ? 'OK' : 'Cancel'}**`
        : s.result == null ? 'click **Cancel**' : `type ${code(s.result)} and click **OK**`;
      return `**${name} appears:** "${s.message}" → ${answer}`;
    }
    default: return `**${s.type}**`;
  }
}

// ---- ⑂ block helpers for the export
// Allowed values of each variable, taken from the If / Else if conditions that compare it ("is" / "is not").
function conditionValues(steps) {
  const map = new Map();
  for (const s of steps) {
    const c = s.cond || s.when;
    if (!c || whenSource(c) !== 'var' || !c.var || !['eq', 'ne'].includes(c.op) || /\{\{/.test(c.value || '')) continue;
    if (!map.has(c.var)) map.set(c.var, []);
    if (!map.get(c.var).includes(c.value)) map.get(c.var).push(c.value);
  }
  return map;
}
// Block ids B1, B2 … in order of their If rows.
function blockLabels(steps) {
  const ids = new Map();
  for (const s of steps) if (s.type === 'ifStart' && !ids.has(s.blockId)) ids.set(s.blockId, `B${ids.size + 1}`);
  return ids;
}
const condCode = (c) => {
  if (!c) return '';
  const src = whenSource(c);
  if (src === 'page') return `page ${c.op === 'notContains' ? 'does not show' : 'shows'} "${c.value}"`;
  if (src === 'url') return `URL ${WHEN_OPS[c.op] || c.op} "${c.value}"`;
  const ops = { eq: '==', ne: '!=', contains: 'contains', notContains: 'does not contain', empty: 'is empty', notEmpty: 'is not empty', regex: 'matches', notRegex: 'does not match' };
  return `{{${c.var}}} ${ops[c.op] || c.op}${whenNeedsValue(c.op) ? ` "${c.value ?? ''}"` : ''}`;
};

// ---- ⚠ Flow check: things that make replays or agents go wrong. Returns [{ level: 'warn' | 'info', id?, text }].
function flowCheck(flow, envs = []) {
  const steps = (flow.steps || []).filter((x) => x.type !== 'pause');
  const out = [];
  const num = new Map();
  steps.forEach((x) => { if (!isIfMarker(x) && !['note', 'loopEnd'].includes(x.type)) num.set(x.id, num.size + 1); });
  const no = (x) => num.get(x.id);
  const positional = (sel) => /nth-of-type|^[a-z]+$/i.test(sel || '') && !/[#[]/.test(sel || '');
  // 1) one selector, different elements
  const bySel = new Map();
  for (const x of steps) {
    const t = x.target;
    if (!t || !t.selector || t.inItem) continue;
    if (!bySel.has(t.selector)) bySel.set(t.selector, []);
    bySel.get(t.selector).push(x);
  }
  for (const [sel, xs] of bySel) {
    const names = [...new Set(xs.map((x) => usableLabel(x.target) || x.target.kind))];
    if (names.length > 1) out.push({ level: 'warn', id: xs[1].id, text: `Steps ${xs.map(no).filter(Boolean).join(', ')} use the same selector \`${sel}\` for different elements (${names.map((n) => `"${n}"`).join(', ')}) — an agent may pick the wrong one. Re-record these steps (5.0 records more stable selectors).` });
    // Several clicks on one unnamed element: usually a tree / list container recorded instead of its items (before 5.3.1).
    const clicks = xs.filter((x) => x.type === 'click' && !usableLabel(x.target));
    if (names.length === 1 && clicks.length > 1) out.push({ level: 'warn', id: clicks[1].id, text: `Steps ${clicks.map(no).filter(Boolean).join(', ')} all click the same unnamed element \`${sel}\` — probably a tree or list whose items were not told apart, so the replay clicks the same spot every time. Re-record these clicks (5.3.1 records the item you click).` });
  }
  const noName = [];
  for (const x of steps) {
    const t = x.target;
    if (!t || t.inItem) continue;
    // 2) no usable name
    if (!usableLabel(t) && !(t.cell && (t.cell.row || t.cell.col)) && ['field', 'dropdown', 'radio', 'checkbox'].includes(t.kind)) {
      noName.push(x);
    } else if (positional(t.selector) && !(t.alt || []).length && !usableLabel(t) && !t.cell) {
      out.push({ level: 'info', id: x.id, text: `Step ${no(x)} is found only by its position on the page (\`${t.selector}\`).` });
    }
    if (x.type === 'type' && x.sensitive && !x.value) out.push({ level: 'info', id: x.id, text: `Step ${no(x)}: the password has no variable, so every replay stops there for you to type it. Open the flow with Edit and press Update flow — the step then gets a 🔒 {{PASSWORD}} variable that can be saved on this computer and filled in automatically.` });
    if (x.notClicked) out.push({ level: 'info', id: x.id, text: `Step ${no(x)} (${describeStep(x).verb} ${describeStep(x).text}) was added without clicking — its result was never seen. Run the flow once to check it.` });
  }
  if (noName.length) {
    const numeric = noName.filter((x) => x.target.label);
    const inTable = noName.some((x) => cellPosition(x.target.selector));
    out.push({ level: 'warn', id: noName[0].id, text: `${noName.length > 1 ? `Steps ${noName.map(no).join(', ')}: these elements have` : `Step ${no(noName[0])}: the ${kindWord(noName[0].target)} has`} no name` +
      `${numeric.length ? ` (a label like "${numeric[0].target.label}" is only a number — the value shown when recorded, which an agent can mistake for the current value)` : ''}` +
      ` and can only be found by position. Re-record ${noName.length > 1 ? 'them' : 'it'} with 5.0 to get ${inTable ? 'the table row / column names' : 'the labels'}.` });
  }
  // no way to confirm the result
  const acts = steps.filter((x) => num.has(x.id));
  const lastAct = acts[acts.length - 1];
  if (lastAct && lastAct.type === 'click' && !steps.some((x) => (x.type === 'verify' || x.type === 'test') && steps.indexOf(x) > steps.indexOf(lastAct))) {
    out.push({ level: 'info', id: lastAct.id, text: `The flow ends with step ${no(lastAct)} (${describeStep(lastAct).verb} ${describeStep(lastAct).text}) and nothing checks that it worked. Add a ✓ Check text after it (e.g. a success message) so a replay or an agent can confirm the result.` });
  }
  // 3) If blocks
  const labels = blockLabels(steps);
  for (const [bid, lab] of labels) {
    const rows = steps.filter((x) => x.blockId === bid && isIfMarker(x));
    const conds = rows.filter((x) => x.type === 'ifStart' || x.type === 'elif').map((x) => x.cond);
    for (let k = 0; k < rows.length - 1; k++) {
      const a = steps.indexOf(rows[k]);
      const b = steps.indexOf(rows[k + 1]);
      if (b === a + 1 && rows[k].type !== 'ifEnd') out.push({ level: 'warn', id: rows[k].id, text: `[${lab}] ${rows[k].type === 'ifStart' ? 'If' : rows[k].type === 'elif' ? 'Else if' : 'Else'} ${rows[k].cond ? condText(rows[k].cond) : ''} has no steps.` });
    }
    if (!rows.some((x) => x.type === 'else') && conds.length && conds.every((c) => whenSource(c) === 'var' && c.op === 'eq')) {
      out.push({ level: 'info', id: rows[0].id, text: `[${lab}] has no Else: when {{${conds[0].var}}} is none of ${[...new Set(conds.map((c) => `"${c.value}"`))].join(' / ')}, nothing in it is done. The export tells the agent the allowed values.` });
    }
  }
  // 4) variables
  const asked = new Set([...steps.filter((x) => (x.type === 'approval' && x.mode === 'input') || x.type === 'capture').map((x) => x.varName),
    ...steps.filter((x) => x.saveAs).map((x) => x.saveAs), ...steps.filter((x) => x.type === 'http').flatMap((x) => (x.save || []).map((v) => v && v.varName))]);
  const pw = passwordVars(steps);
  for (const nm of usedVars(steps)) {
    if (asked.has(nm) || pw.has(nm)) continue;
    const v = (flow.vars || []).find((d) => d.name === nm);
    const inEnv = envs.some((e) => e.vars.some((d) => d.name === nm && (d.value || d.secret)));
    if (!v && !inEnv) out.push({ level: 'info', id: null, text: `{{${nm}}} has no default and is in no environment — it is asked when the flow runs${(flow.vars || []).length ? '' : ' (add it under "Variables of this flow" to mark it ✱ required)'}.` });
  }
  for (const e of envs) for (const d of e.vars) if (pw.has(d.name) && d.value && !d.secret) out.push({ level: 'info', id: null, text: `Environment "${e.name}" keeps {{${d.name}}} (a password) in plain text. Tick 🔒 for it and type the value there once — it is then saved encrypted on this computer and still filled in automatically.` });
  return out;
}

function toMarkdown(state) {
  const steps = (state.steps || []).filter((s) => s.type !== 'pause');
  const first = steps.find((s) => s.type === 'navigate');
  const title = first?.title || 'Browser session';
  const has = (fn) => steps.some(fn);
  const isAction = (s) => !isIfMarker(s) && !['note', 'loopEnd'].includes(s.type);
  const labels = blockLabels(steps);
  const depths = ifDepths(steps);
  const pw = passwordVars(steps);
  const allowed = conditionValues(steps);

  // Number the actions only (the ⑂ rows and notes are not actions).
  const num = new Map();
  steps.forEach((s) => { if (isAction(s)) num.set(s, num.size + 1); });
  const nActions = num.size;

  const out = [];
  out.push(`# Flow: ${state.name || title}`, '');
  if (state.description) out.push(...String(state.description).trim().split('\n').map((l) => `> ${l}`), '');
  out.push(`- **Version:** v${state.version || 1}${state.updatedAt || state.savedAt ? ` (updated ${new Date(state.updatedAt || state.savedAt).toLocaleString()})` : ''}`);
  if (first) out.push(`- **Start URL:** ${first.url}`);
  out.push(`- **Actions:** ${nActions}${labels.size ? ` · ${labels.size} If block${labels.size > 1 ? 's' : ''}` : ''}${has((x) => x.type === 'loopStart') ? ' · contains a "for each item" loop' : ''}`, '');

  // ---- variables
  const defs = state.vars || [];
  const asked = new Set(steps.filter((x) => (x.type === 'approval' && x.mode === 'input') || x.type === 'capture').map((x) => x.varName));
  const made = new Set([...steps.filter((x) => x.saveAs).map((x) => x.saveAs), ...steps.filter((x) => x.type === 'http').flatMap((x) => (x.save || []).map((v) => v && v.varName))]);
  const names = [...new Set([...usedVars(steps), ...afterVars(state), ...defs.filter((d) => d.required).map((d) => d.name)])];
  const secretNames = new Set([...defs.filter((d) => d.secret).map((d) => d.name), ...pw]);
  const needed = names.filter((nm) => !asked.has(nm) && !made.has(nm));

  // ---- before you start
  out.push('## Before you start', '');
  let b = 0;
  if (needed.length) {
    out.push(`${++b}. Get a value for every variable in the table below${needed.some((nm) => !defs.find((d) => d.name === nm)?.value || secretNames.has(nm)) ? ' — ask the user for the ones without a value' : ''}. Do not guess values.`);
    const lim = [...allowed.entries()].filter(([nm]) => needed.includes(nm));
    if (lim.length) out.push(`${++b}. Check the values: ${lim.map(([nm, vs]) => `\`{{${nm}}}\` must be one of ${vs.map((v) => `"${v}"`).join(' / ')}`).join('; ')} (ignore upper/lower case). If a value is not in the list, ask the user before you continue — otherwise nothing in that ⑂ block would be done.`);
  }
  if (first) out.push(`${++b}. Open ${first.url} in the browser.`);
  if (has((x) => x.valueOp === 'add' || x.valueOp === 'sub' || x.valueOp === 'append')) {
    out.push(`${++b}. This flow **changes values relative to what is on the page** (Increase / Decrease / Append): every run adds again — that is intended when the user asks for a run. But within one run, if you have to retry a step (e.g. after an error), first look at the field: if the change is already there, do not do it again.`);
  }
  out.push('');

  if (names.length) {
    out.push('## Variables', '', '| Variable | Value | Notes |', '|---|---|---|');
    names.forEach((nm) => {
      const v = defs.find((d) => d.name === nm);
      const notes = [];
      if (v?.required) notes.push('✱ required');
      if (allowed.has(nm)) notes.push(`one of: ${allowed.get(nm).map((x) => `"${x}"`).join(', ')}`);
      if (asked.has(nm)) notes.push('asked from the user during the flow');
      if (made.has(nm) || steps.some((x) => x.type === 'capture' && x.varName === nm)) notes.push('set by a step of this flow');
      const val = secretNames.has(nm) ? '🔒 secret — ask the user; never write it down' : asked.has(nm) || made.has(nm) ? '—' : v?.value ? code(v.value) : '_ask the user (or take it from the environment they name)_';
      out.push(`| \`{{${nm}}}\` | ${val} | ${notes.join(' · ')} |`);
    });
    out.push('');
  }

  // ---- outline (only when the flow has blocks or loops)
  if (labels.size || has((x) => x.type === 'loopStart')) {
    out.push('## Flow outline', '', 'The structure at a glance (step numbers refer to the Steps below):', '', '```');
    let pending = [];
    const flush = (d) => {
      if (!pending.length) return;
      const a = num.get(pending[0]);
      const z = num.get(pending[pending.length - 1]);
      const what = (x) => { const ds = describeStep(x); const t = `${ds.verb} ${ds.text}`.replace(/\s+/g, ' '); return t.length > 90 ? `${t.slice(0, 88).replace(/\s+\S*$/, '')}…` : t; };
      out.push(`${'    '.repeat(d)}${a === z ? `step ${a}: ${what(pending[0])}` : `steps ${a}–${z}: ${what(pending[0])} … ${what(pending[pending.length - 1])}`}`);
      pending = [];
    };
    let loopDepth = 0;
    let lastD = 0;
    steps.forEach((s, i) => {
      const d = depths[i] + loopDepth;
      if (isAction(s) && s.type !== 'loopStart') { if (pending.length && d !== lastD) flush(lastD); pending.push(s); lastD = d; return; }
      flush(lastD);
      if (s.type === 'ifStart') out.push(`${'    '.repeat(d)}[${labels.get(s.blockId)}] if ${condCode(s.cond)}:`);
      else if (s.type === 'elif') out.push(`${'    '.repeat(d)}[${labels.get(s.blockId)}] elif ${condCode(s.cond)}:`);
      else if (s.type === 'else') out.push(`${'    '.repeat(d)}[${labels.get(s.blockId)}] else:`);
      else if (s.type === 'loopStart') { out.push(`${'    '.repeat(d)}step ${num.get(s)}: for each item of the list:`); loopDepth++; }
      else if (s.type === 'loopEnd') loopDepth = Math.max(0, loopDepth - 1);
      else if (s.type === 'ifEnd') {
        const noElse = !steps.some((x) => x.type === 'else' && x.blockId === s.blockId);
        const conds = steps.filter((x) => (x.type === 'ifStart' || x.type === 'elif') && x.blockId === s.blockId).map((x) => x.cond);
        if (noElse && conds.every((c) => whenSource(c) === 'var')) out.push(`${'    '.repeat(d)}[${labels.get(s.blockId)}] no case true → nothing of [${labels.get(s.blockId)}] is done (tell the user)`);
      }
    });
    flush(lastD);
    out.push('```', '');
  }

  // ---- rules (only the ones this flow needs)
  out.push('## How to do the steps', '');
  const rules = [];
  rules.push('Do the steps in order. Do only what a step says — no extra clicks, no extra typing. If the page is already in the state a click would create (a menu already open, a tab or option already selected), do not click again — clicking could close or undo it.');
  rules.push(`Find each element by its name in the step (label, or the row and column of a table), then by the selector. Before acting, wait until the page has finished loading: the element is visible and enabled and no loading spinner / overlay covers it (wait up to ${state.elementTimeout || 15} s${state.elementTimeout > 15 ? ' — this system is slow' : ''}). If you cannot find it, stop and report — do not use a different element.`);
  if (has((x) => x.type === 'type' && !x.valueOp && !x.sensitive)) rules.push('**Type** replaces the whole content of the field with the given text.');
  if (has((x) => x.valueOp === 'add' || x.valueOp === 'sub')) rules.push('**Increase / Decrease** steps: when you reach the step, read the number the field shows **at that moment** (an empty field counts as 0), calculate the new value from it, clear the field, type the new value and check that the field shows it. Never use a number from this file as the current value — the page has changed since it was recorded. Keep the field\'s number format (e.g. 1,5 stays with a comma).');
  if (has((x) => x.type === 'check')) rules.push('**Choose** (radio option) and **Tick / Untick** (checkbox) set a choice. They are not verifications.');
  if (has((x) => x.type === 'navigate' && x !== first)) rules.push('"Page opens" / "URL changes to" lines are the expected result of the step before — use them to confirm you are on the right page; do not open these URLs yourself unless the step says "Go to".');
  if (has((x) => x.target?.dialog)) rules.push('Steps "in dialog" happen inside a popup: wait for it to be visible and only use elements inside it.');
  if (has((x) => x.type === 'dialog')) rules.push('"Browser alert / confirm / prompt" steps are native popups: accept or dismiss them exactly as written.');
  if (labels.size) rules.push('**⑂ If blocks** (labelled [B1], [B2] …): when you reach an If line, decide **once** which case applies — the first case whose condition is true, otherwise Else. Do only the steps of that case (they are marked › one level deeper and numbered), skip the steps of the other cases, then continue after the matching End if. Compare text ignoring upper/lower case and spaces at the ends; "page shows" means the text is visible on the page at that moment. Do not check the condition again after the page has changed.');
  if (has((x) => isWhen(x.when))) rules.push('"⑂ Only if" lines: do that step only when its condition is true (same comparison rules); a run of steps with the same condition is decided once, at its first step.');
  if (has((x) => x.type === 'test')) rules.push('**🧪 Test steps** are the test cases of this flow: at that moment, check each condition (a variable value, a text visible on the page — wait a few seconds for it —, or the page URL). PASS only when all of them are true. Do not click or change anything for a test step.');
  if (has((x) => x.type === 'verify')) rules.push('**Check** steps are verifications: look at the visible text (wait a few seconds for it) and report PASS or FAIL with what you saw. If a check fails, stop and report it.');
  if (has((x) => x.type === 'loopStart')) rules.push('"For each item" loops: the ↻ steps were recorded on the first item; repeat them for every item (and the next pages if stated), using the same element of each item. One failing item does not stop the loop — note it and continue.');
  if (has((x) => x.type === 'extract')) rules.push('"Extract all items" steps: collect every item of the list, click Next / Load more and repeat until it is missing or disabled; return all items (no duplicates) as a table.');
  if (has((x) => x.type === 'capture')) rules.push('**⤓ Capture** steps read a value from the page and keep it as a variable for the later steps.');
  if (has((x) => x.type === 'approval')) rules.push('**⏸** steps need the user: wait for their approval, or ask them for the value.');
  if (has((x) => x.type === 'http')) rules.push('**🌐 HTTP request** steps: send exactly the request shown (method, URL, headers, body with the variables filled in). If the status is not the expected one, stop and report the status and response text.');
  if (has((x) => x.optional)) rules.push('**Optional** steps: if the element does not appear within the given time, skip the step (and the page change it would cause) and continue.');
  if (has((x) => x.sensitive) || secretNames.size) rules.push('Never invent passwords or secret values, and never write them in your messages or report.');
  if (has((x) => x.type === 'note')) rules.push('📝 Notes are hints from the person who recorded the flow.');
  rules.forEach((r, k) => out.push(`${k + 1}. ${r}`));
  out.push('');

  out.push('## Steps', '');
  let openDialog = null; // key of the modal the previous action happened in
  let inLoop = false;
  const waitOf = new Map();
  (state.steps || []).forEach((x, k) => waitOf.set(x, waitBefore(state.steps, k))); // waits need the pause rows
  steps.forEach((s, i) => {
    const ind = '› '.repeat(depths[i]);
    if (isIfMarker(s)) {
      const id = labels.get(s.blockId) || 'B?';
      if (s.type === 'ifStart') out.push(`**⑂ [${id}] If ${condText(s.cond)}**${['page', 'url'].includes(whenSource(s.cond)) ? ' — look at the page once, now' : ''} → do the steps below (until the next Else if / Else / End if of [${id}]) only in that case`);
      else if (s.type === 'elif') out.push(`${ind}**⑂ [${id}] Else if ${condText(s.cond)}** → only if no case of [${id}] above was true`);
      else if (s.type === 'else') out.push(`${ind}**⑂ [${id}] Else** → only if no case of [${id}] above was true`);
      else out.push(`${ind}**⑂ [${id}] End if** — continue here in every case`);
      if (s.type === 'ifStart' && depths[i]) out[out.length - 1] = ind + out[out.length - 1];
      out[out.length - 1] = '- ' + out[out.length - 1];
      return;
    }
    if (s.type === 'note') { out.push(`- ${ind}📝 **Note from the user:** ${s.text}`); return; }
    const sub = [];
    const dlg = s.target?.dialog;
    const key = dlg ? `${dlg.selector}|${dlg.title}` : null;
    if (dlg && key !== openDialog) sub.push(`⧉ Dialog ${dlg.title ? `"${dlg.title}"` : code(dlg.selector)} is open — wait for it to appear before this step`);
    if (s.target || ['navigate', 'urlchange', 'tab'].includes(s.type)) openDialog = key;
    const gap = waitOf.get(s) || 0;
    if (gap >= WAIT_MS && gap < LONG_IDLE_MS) sub.push(`⏳ The page needed ~${fmtDur(gap)} here when recorded — wait for the element instead of sleeping`);
    if (s.type === 'loopEnd') inLoop = false;
    if (s.optional) sub.unshift(`Optional: if this element does not appear within ${Number(s.optionalWait) || 3} s, skip this step${s.type === 'capture' ? ' (the variable stays unset)' : ''} — and the page change after it — and continue`);
    if (isWhen(s.when)) {
      const prev = steps.slice(0, i).reverse()[0];
      const cont = prev && JSON.stringify(prev.when || null) === JSON.stringify(s.when);
      const w = s.when;
      const head = whenSource(w) === 'else' ? '⑂ Else — do this only if none of the cases (if / else if) above ran'
        : w.branch === 'elif' ? `⑂ Else if ${condText(w)} — do this only if no case above ran and this is true`
        : `⑂ Only if ${whenText(w)}${w.branch === 'else' ? ' (the "else" case of the block above)' : ''} — otherwise skip this step`;
      sub.unshift(cont ? '⑂ (same condition as the step before — decided once for the whole group)'
        : `${head}${s.type === 'loopStart' ? ' (and the whole loop)' : ''}${['page', 'url'].includes(whenSource(w)) ? '; decide this once, when you reach this step' : ''}`);
    }
    const no = num.get(s);
    out.push(`- ${ind}${no ? `${no}. ` : ''}${inLoop ? '↻ ' : ''}${s === first ? markdownStep({ ...s, transition: 'start' }).replace('**Start on**', '**Open**') + ' _(start here)_' : markdownStep(s)}`);
    if (s.type === 'loopStart') inLoop = true;
    if (s.type === 'navigate' && s !== first && s.transition !== 'start' && s.tEnd - s.t >= 500) sub.push(`Wait for the page to finish loading (took ~${fmtDur(s.tEnd - s.t)})`);
    if (s.frame) sub.push(`Inside iframe: ${s.frame}`);
    if (s.type === 'verify' && s.result) sub.push(`When recorded it was: ${s.result.passed ? 'PASS' : 'FAIL'} — ${checkResultText(s.check, s.result)}`);
    if (s.type === 'extract') {
      const nx = s.spec.next;
      sub.push(nx
        ? `Pagination: after each page click ${nx.kind} ${nx.label ? `**"${nx.label}"**` : '(icon, no text)'} — selector ${code(nx.selector)}; stop when it is missing/disabled (max ${s.spec.maxPages} pages)`
        : 'No pagination — only the current page');
      sub.push(`Recorded result: ${extractSummary(s)}${s.result?.stopReason ? ` (stopped: ${s.result.stopReason})` : ''} — see "Extracted data" below`);
    }
    sub.forEach((line) => out.push(`  - ${line}`));
  });

  // ---- after the run
  const after = state.after || [];
  if (after.length) {
    out.push('', '## After the run', '', 'When the steps are finished — also when one failed or the user stopped — send these requests:', '');
    after.forEach((h, k) => {
      out.push(`${k + 1}. **${AFTER_WHEN[h.when] || AFTER_WHEN.always}:** ${markdownStep({ ...h, type: 'http' }).replace('otherwise stop and report', 'otherwise report')}`);
    });
    const used = usedVars(after.map((h) => ({ ...h, type: 'http' }))).filter((n) => n in AFTER_VARS);
    if (used.length) out.push('', 'Fill in: ' + used.map((n) => `\`{{${n}}}\` = ${AFTER_VARS[n]}`).join('; ') + '.');
  }

  // ---- what to report
  out.push('', '## When you are done', '', 'Report to the user:');
  const rep = [];
  if (labels.size) rep.push('for each ⑂ block: which case you took, and why (the variable value, or what the page showed)');
  if (has((x) => ['type', 'set', 'select', 'check'].includes(x.type) && !x.sensitive)) rep.push('every field you changed: its value before → after (for Increase / Decrease: the number you read, the calculation and the result)');
  if (has((x) => x.type === 'test')) rep.push('a **Test steps** table: test step, expected result, PASS / FAIL, and what you saw for each condition');
  if (has((x) => x.type === 'verify')) rep.push('each check: PASS or FAIL and what you saw');
  if (has((x) => x.type === 'http')) rep.push('each HTTP request: the status code (and the response text if it failed)');
  if (has((x) => x.type === 'extract' || x.type === 'loopStart')) rep.push('the collected items / one result row per loop item');
  rep.push('steps you skipped or that failed, with the reason — and whether the final action (e.g. Save) was done');
  rep.forEach((r, k) => out.push(`${k + 1}. ${r}`));
  out.push('', 'Never include passwords or 🔒 secret values in the report.');
  const extracts = steps.filter((s) => s.type === 'extract' && s.result?.rows?.length);
  if (extracts.length) {
    out.push('', '## Extracted data');
    extracts.forEach((s, k) => {
      out.push('', `### List ${k + 1} — ${extractSummary(s)}${s.title ? ` on "${s.title}"` : ''}`, '');
      out.push(mdTable(s.result.fields, s.result.rows));
    });
  }

  const pages = [...new Set(steps.filter((s) => ['navigate', 'urlchange', 'tab'].includes(s.type)).map((s) => s.url))];
  if (pages.length) {
    out.push('', '## Pages visited', '');
    pages.forEach((u) => out.push(`- ${u}`));
  }
  out.push('');
  return out.join('\n');
}

if (typeof module !== 'undefined') module.exports = { testTitle, testConds, AFTER_VARS, AFTER_WHEN, afterVars, flowCheck, passwordVars, secureVars, convertWhens, IF_MARKERS, isIfMarker, ifDepths, condText, httpStatusOk, responseValue, isWhen, whenSource, WHEN_SOURCES, WHEN_SOURCE_OPS, evalWhen, whenText, WHEN_OPS, WHEN_NEGATE, flowOffsets, usedVars, VAR_RE, checkResultText, checkCondition, mdTable, toMarkdown, describeStep, waitBefore, pausedBefore, fmtDur, fmtOffset, WAIT_MS };
