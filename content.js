/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// Runs in every page/frame. Captures user actions and sends them to the background worker.
(() => {
  if (window.__actionRecorderInjected) return;
  window.__actionRecorderInjected = true;

  const pending = new Map(); // field element -> first-keystroke time
  // `recording` here means "actively capturing": recording and not paused.
  let rec = false, paused = false, recording = false;
  let activeLoop = null; // { id, list } while a "For each item" loop is being recorded
  const sync = () => { recording = rec && !paused; if (!recording) pending.clear(); };
  chrome.storage.local.get(['recording', 'paused', 'activeLoop']).then((r) => { rec = !!r.recording; paused = !!r.paused; activeLoop = r.activeLoop || null; sync(); }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.recording) rec = !!changes.recording.newValue;
    if (changes.paused) paused = !!changes.paused.newValue;
    if (changes.activeLoop) activeLoop = changes.activeLoop.newValue || null;
    if (changes.recording || changes.paused) sync();
  });

  const isTop = window === window.top;
  let picker = null; // active list picker (see "List extraction"); user input is not recorded while it runs

  function send(step) {
    if (!recording || picker) return;
    if (!step.t) step.t = Date.now();
    if (!isTop) step.frame = location.href;
    try {
      chrome.runtime.sendMessage({ type: 'step', step }).catch(() => {});
    } catch (_) { /* extension was reloaded; ignore */ }
  }

  // ---------- element description ----------
  const NON_TEXT_INPUTS = ['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color'];
  const GOOD_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'title', 'alt'];
  const CLICKABLE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],' +
    '[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=radio],' +
    '[role=switch],[role=treeitem],[onclick],[tabindex]:not([tabindex="-1"])';

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // Modal / popup containers: native <dialog>, ARIA dialogs and the common UI-library modals.
  const DIALOG_SEL = 'dialog,[role=dialog],[role=alertdialog],[aria-modal="true"],.modal,.MuiDialog-paper,.ant-modal,' +
    '.el-dialog,.v-dialog,.swal2-popup,.ReactModal__Content,.mat-mdc-dialog-container,.mat-dialog-container,.p-dialog,' +
    '.chakra-modal__content,.modal-dialog';

  // The real element an event happened on, even inside (open) shadow DOM.
  function realTarget(e) {
    const p = e.composedPath ? e.composedPath() : [];
    const first = p.find((n) => n && n.nodeType === 1);
    return first || e.target;
  }

  // closest() that also climbs out of shadow roots.
  function closestDeep(el, sel) {
    while (el) {
      const c = el.closest?.(sel);
      if (c) return c;
      const r = el.getRootNode();
      el = r instanceof ShadowRoot ? r.host : null;
    }
    return null;
  }

  const byId = (el, id) => (el.getRootNode().getElementById?.(id) || document.getElementById(id));

  function dialogTitle(d) {
    const lb = d.getAttribute('aria-labelledby');
    if (lb) {
      const t = clean(lb.split(/\s+/).map((id) => byId(d, id)?.innerText || '').join(' '));
      if (t) return t.slice(0, 80);
    }
    const a = d.getAttribute('aria-label');
    if (a && clean(a)) return clean(a).slice(0, 80);
    const h = d.querySelector('h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="header" i]');
    const t = h && clean(h.innerText);
    return t ? t.slice(0, 80) : '';
  }

  function isTextLike(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.includes((el.type || 'text').toLowerCase());
    return false;
  }

  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && clean(aria)) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = clean(lb.split(/\s+/).map((id) => byId(el, id)?.innerText || '').join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map((l) => l.innerText).join(' '));
      if (t) return t;
    }
    const tag = el.tagName;
    if (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      // A placeholder such as "0" or "0.00" is a sample value, not a name — an agent would read it as the value.
      const ph = [el.placeholder, el.getAttribute('data-placeholder')].map(clean).find((x) => x && !/^[-+]?[\d\s.,%]*$/.test(x));
      const t = ph || el.title || (el.name && !/^[-+]?\d+$/.test(el.name) ? el.name : '') || (el.id && !looksGenerated(el.id) ? el.id : '');
      if (t) return clean(t);
      if (tag === 'INPUT' && el.value && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
      return '';
    }
    const txt = clean(el.innerText);
    if (txt && txt.length <= 120) return txt;
    return clean(el.title || el.getAttribute('alt') || el.querySelector?.('img[alt]')?.alt || '');
  }

  function kindOf(el) {
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'file') return 'file input';
      if (t === 'range') return 'slider';
      return 'field';
    }
    if (tag === 'textarea' || el.isContentEditable) return 'field';
    if (tag === 'select') return 'dropdown';
    if (role) return role;
    return tag;
  }

  function looksGenerated(id) {
    return /\d{4,}|[a-f0-9]{8,}|^(ember|react|mui|radix|headlessui|rc-)/i.test(id) || id.includes(':');
  }

  // Selectors are unique within the element's own root (the document, or its shadow root).
  function selectorFor(el) {
    const root = el.getRootNode();
    const unique = (sel) => { try { return root.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
    const tag = el.tagName.toLowerCase();
    if (el.id && !looksGenerated(el.id)) {
      const s = '#' + CSS.escape(el.id);
      if (unique(s)) return s;
    }
    for (const a of GOOD_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) {
        const s = `${tag}[${a}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
        if (unique(s)) return s;
      }
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML') {
      if (cur !== el && cur.id && !looksGenerated(cur.id)) {
        const s = ['#' + CSS.escape(cur.id), ...parts].join(' > ');
        if (unique(s)) return s;
      }
      let part = cur.tagName.toLowerCase();
      const p = cur.parentElement;
      if (p) {
        const sibs = [...p.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const s = parts.join(' > ');
      if (unique(s)) return s;
      cur = p;
    }
    return parts.join(' > ');
  }

  // Where an element sits in a table: the row's name (first cell / row header) and the column header.
  function cellOf(el) {
    const td = el.closest?.('td,th');
    const tr = td?.closest('tr');
    const table = tr?.closest('table');
    if (!td || !tr || !table) return null;
    const cells = [...tr.children];
    let col = 0;
    for (const c of cells) { if (c === td) break; col += Number(c.colSpan) || 1; }
    const nameCell = cells.find((c) => c !== td && !c.querySelector('input,select,textarea,button') && clean(c.innerText));
    const row = clean(nameCell?.innerText || '').slice(0, 60);
    let header = '';
    const headRow = table.tHead?.rows?.[table.tHead.rows.length - 1] || [...table.rows].find((r) => r.querySelector('th') && r !== tr);
    if (headRow) {
      let k = 0;
      for (const h of headRow.cells) { const span = Number(h.colSpan) || 1; if (col >= k && col < k + span) { header = clean(h.innerText).slice(0, 60); break; } k += span; }
    }
    const tname = clean(table.caption?.innerText || table.getAttribute('aria-label') || '').slice(0, 60);
    return row || header ? { row, col: header, ...(tname ? { table: tname } : {}) } : null;
  }

  // Extra, more stable ways to find the element (used by the export and as replay fallbacks).
  function altSelectors(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const q = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const root = el.getRootNode();
    const add = (sel) => { try { if (root.querySelectorAll(sel).length === 1 && !out.includes(sel)) out.push(sel); } catch (_) { /* ignore */ } };
    const type = (el.getAttribute('type') || '').toLowerCase();
    if ((type === 'radio' || type === 'checkbox') && el.value && el.value !== 'on') {
      add(`input[type="${type}"]${el.name ? `[name="${q(el.name)}"]` : ''}[value="${q(el.value)}"]`);
    }
    if (el.name) add(`${tag}[name="${q(el.name)}"]`);
    for (const a of ['data-testid', 'aria-label', 'placeholder', 'title']) { const v = el.getAttribute(a); if (v && v.length < 80) add(`${tag}[${a}="${q(v)}"]`); }
    if (type === 'password') add('input[type="password"]');
    return out.slice(0, 3);
  }

  function describe(el) {
    const d = { tag: el.tagName.toLowerCase(), kind: kindOf(el), label: labelOf(el), selector: selectorFor(el) };
    if (itemEls.has(el)) { d.kind = 'item'; d.item = true; } // found again by its text if the list order changes
    const cell = cellOf(el);
    if (cell) d.cell = cell;
    const alts = altSelectors(el).filter((x) => x !== d.selector);
    if (alts.length) d.alt = alts;
    if (['radio', 'checkbox'].includes(d.kind)) {
      // The question the radio / checkbox answers (e.g. the fieldset legend or the group's label).
      const grp = el.closest('fieldset,[role=radiogroup],[role=group]');
      const g = clean(grp?.querySelector('legend')?.innerText || grp?.getAttribute('aria-label') || '');
      if (g) d.group = g.slice(0, 60);
    }
    if (recording && activeLoop && !picker) {
      const ii = inItemOf(el);
      if (ii) d.inItem = ii;
    }
    const dlg = closestDeep(el, DIALOG_SEL);
    if (dlg) d.dialog = { title: dialogTitle(dlg), selector: selectorFor(dlg) };
    const hosts = [];
    for (let r = el.getRootNode(); r instanceof ShadowRoot; r = r.host.getRootNode()) hosts.unshift(selectorFor(r.host));
    if (hosts.length) d.shadowHosts = hosts;
    return d;
  }

  // ---------- typing (buffered until the field is left) ----------
  // (pending is declared near the top so sync() can clear it)
  const lastValue = new WeakMap();

  const fieldValue = (el) => (el.isContentEditable ? clean(el.innerText).slice(0, 500) : el.value);

  function flush(el) {
    if (!pending.has(el)) return;
    const t = pending.get(el);
    pending.delete(el);
    const v = fieldValue(el);
    if (lastValue.get(el) === v) return;
    lastValue.set(el, v);
    const sensitive = el.type === 'password';
    send({ type: 'type', t, tEnd: Date.now(), target: describe(el), value: sensitive ? null : v, sensitive });
  }
  const flushAll = () => { for (const el of [...pending.keys()]) flush(el); };

  window.addEventListener('input', (e) => {
    if (!recording || !e.isTrusted) return;
    const el = realTarget(e);
    if (isTextLike(el) && !pending.has(el)) pending.set(el, Date.now());
  }, true);

  window.addEventListener('focusout', (e) => { if (recording) flush(realTarget(e)); }, true);
  window.addEventListener('pagehide', () => { if (recording) flushAll(); }, true);

  // 'change' does not cross shadow-DOM boundaries, so also listen on every shadow root the user touches.
  const watchedRoots = new WeakSet();
  function watchShadowRoots(e) {
    for (const n of e.composedPath ? e.composedPath() : []) {
      if (n instanceof ShadowRoot && !watchedRoots.has(n)) {
        watchedRoots.add(n);
        n.addEventListener('change', onChange, true);
      }
    }
  }
  ['pointerdown', 'focusin', 'keydown'].forEach((t) => window.addEventListener(t, watchShadowRoots, true));

  window.addEventListener('change', onChange, true);
  function onChange(e) {
    if (!recording || !e.isTrusted) return;
    const el = realTarget(e);
    if (isTextLike(el)) return flush(el);
    if (el.tagName === 'SELECT') {
      const opts = [...el.selectedOptions].map((o) => clean(o.text) || o.value);
      return send({ type: 'select', target: describe(el), value: opts.join(', ') });
    }
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return send({ type: 'check', target: describe(el), checked: el.checked });
      if (t === 'file') return send({ type: 'upload', target: describe(el), value: [...(el.files || [])].map((f) => f.name).join(', ') });
      if (t === 'range' || t === 'color') return send({ type: 'set', target: describe(el), value: el.value });
    }
  }

  // ---------- keys ----------
  window.addEventListener('keydown', (e) => {
    if (!recording || !e.isTrusted) return;
    const mods = ['Control', 'Shift', 'Alt', 'Meta'];
    if (mods.includes(e.key)) return;
    const combo = e.ctrlKey || e.metaKey || e.altKey;
    if (!(combo || e.key === 'Enter' || e.key === 'Escape')) return;
    flushAll();
    const keys = [];
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.metaKey) keys.push('Meta');
    if (e.altKey) keys.push('Alt');
    if (e.shiftKey && combo) keys.push('Shift');
    keys.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    const el = realTarget(e);
    const target = el && el.nodeType === 1 && el !== document.body && el !== document.documentElement ? describe(el) : null;
    send({ type: 'key', key: keys.join('+'), target });
  }, true);

  // ---------- native alert / confirm / prompt ----------
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__actionRecorder !== 'dialog' || !recording) return;
    if (!['alert', 'confirm', 'prompt'].includes(d.kind)) return;
    flushAll();
    const result = d.kind === 'confirm' ? !!d.result : d.kind === 'prompt' ? (d.result == null ? null : String(d.result).slice(0, 500)) : undefined;
    send({ type: 'dialog', kind: d.kind, message: String(d.message || '').slice(0, 300), result, t: Number(d.t) || Date.now(), tEnd: Number(d.tEnd) || Date.now() });
  });

  // ---------- clicks ----------
  // Only focusable (tabindex) / onclick: often a whole tree, list or panel that handles the clicks of all its items.
  const WEAK_CLICKABLE = '[onclick],[tabindex]:not([tabindex="-1"])';
  const STRONG_CLICKABLE = CLICKABLE.split(',').filter((x) => !WEAK_CLICKABLE.split(',').includes(x)).join(',');
  const itemEls = new WeakSet(); // elements recorded as "the item clicked inside a container"

  // The item that was clicked inside a container: climb from the clicked node while the parent adds no other text
  // (icon + title → the row), and stop before the part that also holds the other items.
  function itemIn(hit, box) {
    let cur = hit;
    while (cur && !(cur instanceof HTMLElement)) cur = cur.parentElement;
    if (!cur || cur === box) return box;
    const own = clean(cur.innerText);
    if (!own) return box; // an icon / empty spot: nothing to tell the items apart
    while (cur.parentElement && cur.parentElement !== box && clean(cur.parentElement.innerText) === own) cur = cur.parentElement;
    return clean(box.innerText) === own ? box : cur; // the container holds only this one item: keep the container
  }

  function clickTarget(e) {
    let el = realTarget(e);
    if (!el || el.nodeType !== 1) return null;
    const hit = el;
    el = el.closest(CLICKABLE) || el;
    if (el !== hit && el.matches(WEAK_CLICKABLE) && !el.matches(STRONG_CLICKABLE)) {
      const item = itemIn(hit, el);
      if (item !== el) { itemEls.add(item); el = item; }
    }
    while (el && !(el instanceof HTMLElement)) el = el.parentElement; // e.g. clicks on SVG icons
    // A click on the empty page background (just to leave a field) does nothing and cannot be replayed.
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  function skipClick(el) {
    if (!el || isTextLike(el)) return true;
    const tag = el.tagName;
    if (tag === 'SELECT' || tag === 'OPTION') return true;
    if (tag === 'INPUT' && ['checkbox', 'radio', 'file'].includes((el.type || '').toLowerCase())) return true;
    if (tag === 'LABEL' && el.control) return true; // the resulting change/typing is recorded instead
    return false;
  }

  window.addEventListener('click', (e) => {
    if (!recording || !e.isTrusted) return;
    flushAll();
    const el = clickTarget(e);
    if (skipClick(el)) return;
    send({ type: 'click', target: describe(el) });
  }, true);

  window.addEventListener('dblclick', (e) => {
    if (!recording || !e.isTrusted) return;
    const el = clickTarget(e);
    if (!el || isTextLike(el)) return;
    send({ type: 'dblclick', target: describe(el) });
  }, true);

  // =====================================================================
  // Replay: the side panel sends one step at a time; this frame performs it.
  // =====================================================================
  const FIELDS = CLICKABLE + ',input,select,textarea,[contenteditable],[contenteditable="true"]';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function deepAll(root, sel) {
    let out = [];
    try { out = [...root.querySelectorAll(sel)]; } catch (_) { return out; }
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) out.push(...deepAll(e.shadowRoot, sel));
    return out;
  }

  function bySelector(t) {
    let root = document;
    for (const h of t.shadowHosts || []) {
      let host = null;
      try { host = root.querySelector(h); } catch (_) { /* bad selector */ }
      if (!host || !host.shadowRoot) return [];
      root = host.shadowRoot;
    }
    try { return [...root.querySelectorAll(t.selector)]; } catch (_) { return []; }
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  const pickOne = (list) => {
    const vis = list.filter(isVisible);
    if (vis.length === 1) return vis[0];
    return list.length === 1 ? list[0] : null;
  };

  function findOnce(t) {
    const sel = t.selector ? bySelector(t) : [];
    const sameLabel = t.label ? sel.filter((e) => labelOf(e) === t.label) : sel;
    let el = pickOne(sameLabel.length ? sameLabel : t.item && t.label ? [] : sel);
    if (el) return el;
    if (t.item && t.label) {
      // An item inside a tree / list: the one with the same text (the innermost such element), wherever it is now.
      const hits = deepAll(document, t.tag || '*').filter((e) => labelOf(e) === t.label && isVisible(e));
      const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
      if (inner.length === 1) return inner[0];
      if (inner.length > 1) return null; // several items with this text: do not guess
    }
    if (t.label) {
      let scopes = [document];
      if (t.dialog) {
        const dialogs = deepAll(document, DIALOG_SEL).filter((d) => isVisible(d) && (!t.dialog.title || dialogTitle(d) === t.dialog.title));
        if (dialogs.length) scopes = dialogs;
      }
      const list = scopes.flatMap((sc) => deepAll(sc, FIELDS)).filter((e) => labelOf(e) === t.label && kindOf(e) === t.kind);
      el = pickOne(list) || list.find(isVisible);
      if (el) return el;
    }
    const vis = sel.find(isVisible);
    if (vis) return vis;
    // Fallbacks: the stable alternative selectors, then the table cell (row name + column header).
    for (const alt of t.alt || []) {
      try { const x = document.querySelectorAll(alt); if (x.length === 1) return x[0]; } catch (_) { /* ignore */ }
    }
    if (t.cell) {
      const want = (x) => clean(x).toLowerCase();
      for (const table of document.querySelectorAll('table')) {
        const headRow = table.tHead?.rows?.[table.tHead.rows.length - 1] || [...table.rows].find((r) => r.querySelector('th'));
        let colIdx = -1;
        if (t.cell.col && headRow) {
          let k = 0;
          for (const h of headRow.cells) { if (want(h.innerText) === want(t.cell.col)) { colIdx = k; break; } k += Number(h.colSpan) || 1; }
          if (colIdx < 0) continue;
        }
        for (const tr of table.rows) {
          if (tr === headRow) continue;
          const cells = [...tr.cells];
          if (t.cell.row && !cells.some((c) => want(c.innerText) === want(t.cell.row))) continue;
          if (colIdx < 0) { // no column header: only if the row has exactly one such element
            const xs = [...tr.querySelectorAll(FIELDS)].filter((e) => kindOf(e) === t.kind);
            if (xs.length === 1) return xs[0];
            continue;
          }
          let k = 0;
          for (const c of cells) {
            const span = Number(c.colSpan) || 1;
            if (colIdx >= k && colIdx < k + span) {
              const x = [...c.querySelectorAll(FIELDS)].find((e) => kindOf(e) === t.kind);
              if (x) return x;
            }
            k += span;
          }
        }
      }
    }
    return null;
  }

  async function findElement(t, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      const el = findOnce(t);
      if (el) return el;
      if (Date.now() > end) {
        const what = t.label ? `${t.kind} "${t.label}"` : t.kind;
        throw new Error(`Element not found: ${what}${t.dialog ? ` in dialog "${t.dialog.title}"` : ''} (selector ${t.selector})`);
      }
      await sleep(250);
    }
  }

  function flash(el) {
    const old = el.style.outline;
    el.style.outline = '3px solid #d93025';
    setTimeout(() => { el.style.outline = old; }, 700);
  }

  function fire(el, type, Ctor = Event, init = {}) {
    return el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  function doClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const xy = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
    fire(el, 'pointerdown', PointerEvent, xy);
    fire(el, 'mousedown', MouseEvent, xy);
    el.focus?.({ preventScroll: true });
    fire(el, 'pointerup', PointerEvent, xy);
    fire(el, 'mouseup', MouseEvent, xy);
    el.click();
  }

  function setValue(el, v) {
    el.scrollIntoView({ block: 'center' });
    el.focus?.({ preventScroll: true });
    if (el.isContentEditable) {
      document.execCommand('selectAll');
      if (v) document.execCommand('insertText', false, v); else document.execCommand('delete');
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    fire(el, 'input', InputEvent);
    fire(el, 'change');
  }

  function selectOptions(el, value) {
    const v = String(value);
    const opts = [...el.options];
    const matches = (o, want) => clean(o.text) === want || o.value === want;
    let hit = opts.filter((o) => matches(o, v));
    if (!hit.length && el.multiple) { const parts = v.split(', '); hit = opts.filter((o) => parts.some((p) => matches(o, p))); }
    if (!hit.length) throw new Error(`Option "${v}" not found in dropdown`);
    opts.forEach((o) => { o.selected = hit.includes(o); });
    fire(el, 'input');
    fire(el, 'change');
  }

  function pressKey(el, combo) {
    const parts = combo.split('+');
    const key = parts.pop();
    const init = {
      key: key.length === 1 ? key.toLowerCase() : key,
      ctrlKey: parts.includes('Ctrl'), metaKey: parts.includes('Meta'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'),
    };
    const target = el || document.activeElement || document.body;
    const notCancelled = fire(target, 'keydown', KeyboardEvent, init);
    fire(target, 'keyup', KeyboardEvent, init);
    const plain = !init.ctrlKey && !init.metaKey && !init.altKey;
    if (!notCancelled || !plain) return;
    // Synthetic keys have no default action, so do what the browser would have done.
    if (key === 'Enter' && target.tagName === 'INPUT' && target.form) target.form.requestSubmit();
    if (key === 'Escape') deepAll(document, 'dialog[open]').pop()?.close();
  }

  async function findInItem(t, loop, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      const items = listItems(loop.list);
      if (items.length) {
        const keys = itemKeys(items, loop.list);
        let idx = keys.indexOf(loop.key);
        if (idx < 0) idx = loop.index;
        const item = items[idx];
        const el = item && (t.inItem.rel === ':scope' ? item : item.querySelector(t.inItem.rel));
        if (el) return el;
      }
      if (Date.now() > end) throw new Error(`Could not find ${t.kind || 'element'} inside list item "${loop.key}" (selector ${t.inItem.rel})`);
      await sleep(250);
    }
  }

  // ---------- waiting for the page to be ready ----------
  // Requests in flight in the page (counted by page-hooks.js in the page's own world). 0 if unknown.
  function netBusy() {
    const root = document.documentElement;
    try { window.dispatchEvent(new Event('action-recorder-net')); } catch (_) { return 0; }
    const v = root.getAttribute('data-action-recorder-net');
    root.removeAttribute('data-action-recorder-net');
    return v == null ? 0 : Number(v) || 0;
  }

  // Wait until the page is quiet: loaded, no requests in flight, no DOM changes for QUIET_MS. Gives up after maxMs
  // (pages with clocks/animations never get fully quiet) — never fails. `extra()` can add a condition.
  const QUIET_MS = 300;
  async function waitQuiet(maxMs, extra = () => true) {
    const end = Date.now() + maxMs;
    let lastMut = Date.now();
    const mo = new MutationObserver((ms) => {
      if (ms.some((m) => !(m.type === 'attributes' && /^data-action-recorder/.test(m.attributeName || '')))) lastMut = Date.now();
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      while (Date.now() < end) {
        if (document.readyState === 'complete' && Date.now() - lastMut >= QUIET_MS && netBusy() === 0 && extra()) return true;
        await sleep(100);
      }
      return false;
    } finally { mo.disconnect(); }
  }

  const isOff = (el) => !!el.disabled || el.getAttribute('aria-disabled') === 'true';

  // Something (a loading overlay, a spinner layer, a modal backdrop) lies on top of the element.
  function covered(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return false;
    if (hit.closest('label')?.contains(el) || el.closest('label')?.contains(hit)) return false; // styled checkbox / radio
    for (let b = hit; b && b !== document.body; b = b.parentElement) {
      if (b.contains(el)) return false;
      const pos = getComputedStyle(b).position;
      if (!['fixed', 'absolute', 'sticky'].includes(pos)) continue;
      const br = b.getBoundingClientRect();
      const coversEl = br.left <= r.left && br.top <= r.top && br.right >= r.right && br.bottom >= r.bottom;
      const decoration = b.parentElement?.contains(el) && br.width * br.height < 4 * r.width * r.height; // icon/badge next to it
      if (coversEl && !decoration) return true;
    }
    return false;
  }

  // Before acting on an element: wait until it is enabled (fails if it never becomes enabled), not covered by an
  // overlay and the page has settled (both only up to a few seconds).
  async function waitReady(el, step, timeout) {
    const start = Date.now();
    const clicky = ['click', 'dblclick', 'check'].includes(step.type);
    if (clicky) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) el.scrollIntoView({ block: 'center', inline: 'center' });
    }
    await waitQuiet(Math.min(5000, timeout), () => el.isConnected && !isOff(el) && !(clicky && covered(el)));
    while (el.isConnected && isOff(el)) {
      if (Date.now() - start > timeout) {
        const l = labelOf(el);
        throw new Error(`${kindOf(el)}${l ? ` "${l.slice(0, 60)}"` : ''} is still disabled after ${Math.round(timeout / 1000)} s — the page may need more time or an earlier step did not work`);
      }
      await sleep(200);
    }
    return el.isConnected;
  }

  // ---------- "Increase / Decrease / Append": new value from the value already in the field ----------
  // Numbers like 1234.5, 1,234.5 and 1.234,5 (Turkish/European) are understood; the result keeps the field's style.
  function parseNum(raw) {
    const t = String(raw ?? '').replace(/[\s\u00a0']/g, '');
    if (t === '') return { n: 0, dec: 0, comma: false, empty: true };
    const m = t.match(/^([+-]?)([\d.,]*\d)$/);
    if (!m) return null;
    let body = m[2];
    let comma = false;
    let group = false;
    if (/,\d+$/.test(body) && (!body.includes('.') || body.lastIndexOf(',') > body.lastIndexOf('.')) && !/^\d{1,3}(,\d{3})+$/.test(body)) {
      comma = true; // 1.234,5 or 12,5
      group = body.includes('.');
      body = body.replace(/\./g, '').replace(',', '.');
    } else {
      group = body.includes(',');
      body = body.replace(/,/g, '');
    }
    const n = Number(m[1] + body);
    if (!Number.isFinite(n)) return null;
    return { n, dec: (body.split('.')[1] || '').length, comma, group };
  }
  function computeValue(current, op, amount) {
    if (op === 'append') return String(current ?? '') + String(amount ?? '');
    const a = parseNum(current);
    const b = parseNum(amount);
    if (!a) throw new Error(`The field does not contain a number ("${String(current).slice(0, 40)}"), so it cannot be ${op === 'add' ? 'increased' : 'decreased'}`);
    if (!b || b.empty) throw new Error(`"${amount}" is not a number`);
    const dec = Math.max(a.dec, b.dec);
    const out = (op === 'sub' ? a.n - b.n : a.n + b.n).toFixed(dec);
    let [int, frac] = out.split('.');
    if (a.group) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, a.comma ? '.' : ',');
    return frac ? int + (a.comma ? ',' : '.') + frac : int;
  }

  async function runStep(step, dialogs, timeout, loop) {
    const root = document.documentElement;
    if (dialogs.length) root.setAttribute('data-action-recorder-answers', JSON.stringify(dialogs));
    else root.removeAttribute('data-action-recorder-answers');

    let el = null;
    const started = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = Math.max(1000, timeout - (Date.now() - started));
      if (step.type === 'key') {
        // The focused element is good enough for key presses if the recorded one is gone.
        if (step.target) el = await findElement(step.target, Math.min(left, 2000)).catch(() => null);
        break;
      } else if (step.target?.inItem && loop) {
        el = await findInItem(step.target, loop, left);
      } else if (step.target) {
        el = await findElement(step.target, left);
      }
      // Optional steps: an element that is in the page but hidden (e.g. a closed banner) counts as "not there".
      if (el && step.optional && !isVisible(el)) {
        const until = started + timeout;
        while (Date.now() < until && el.isConnected && !isVisible(el)) await sleep(200);
        if (!isVisible(el)) {
          const t = step.target;
          throw new Error(`Element not found: ${t.label ? `${t.kind} "${t.label}"` : t.kind} is hidden (selector ${t.selector})`);
        }
      }
      // Wait for the page to finish loading around it; if the page re-rendered it meanwhile, find it again.
      if (!el || (await waitReady(el, step, Math.max(1000, timeout - (Date.now() - started))))) break;
    }
    let computed = null;
    if (el && !el.isConnected && step.target) el = findOnce(step.target) || el; // re-rendered right at the end
    if (el) flash(el);
    switch (step.type) {
      case 'click': doClick(el); break;
      case 'dblclick': doClick(el); doClick(el); fire(el, 'dblclick', MouseEvent, { detail: 2, view: window }); break;
      case 'type': case 'set': {
        if (step.valueOp && step.valueOp !== 'replace') {
          const before = el.isContentEditable ? el.innerText.trim() : el.value;
          const after = computeValue(before, step.valueOp, step.value ?? '');
          setValue(el, after);
          computed = { before, value: after };
        } else {
          setValue(el, step.value ?? '');
          if (step.saveAs) computed = { value: step.value ?? '' };
        }
        break;
      }
      case 'select': selectOptions(el, step.value); break;
      case 'check': if (el.checked !== step.checked) doClick(el); break;
      case 'key': pressKey(el, step.key); break;
      default: throw new Error(`Cannot replay step type "${step.type}"`);
    }
    const acted = el ? { kind: kindOf(el), label: labelOf(el), href: el.closest?.('a[href]')?.href || '' } : null;
    return { ok: true, acted, ...(computed ? { computed } : {}) };
  }

  // Debug mode: outline what the next step will use.
  async function debugShow(step, loop) {
    let el = null;
    let what = 'element';
    if (step.type === 'loopStart') {
      const items = listItems(step.loop.list);
      setOverlay({ items, banner: '' });
      setTimeout(() => { if (!picker) clearOverlay(); }, 3000);
      return { found: items.length > 0, what: `list (${items.length} items)` };
    }
    if (step.check?.scope) { what = `check area "${step.check.scope.name}"`; el = await findElement(step.check.scope, 1500).catch(() => null); }
    else if ((step.target || step.fill)?.inItem && loop) { el = await findInItem(step.target || step.fill, loop, 1500).catch(() => null); }
    else if (step.target || step.fill) { el = await findElement(step.target || step.fill, 1500).catch(() => null); }
    if (step.target) what = `${step.target.kind}${step.target.label ? ` "${step.target.label}"` : ''}`;
    if (el && !step.check?.scope) { const l = labelOf(el); what = `${kindOf(el)}${l ? ` "${l.slice(0, 60)}"` : ''}`; } // what is really there
    if (el) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      setOverlay({ hover: el, banner: '' });
      setTimeout(() => { if (!picker) clearOverlay(); }, 3000);
    }
    return { found: !!el, what };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'debug:show') {
      if (!isTop) return;
      debugShow(msg.step, msg.loop).then(sendResponse, () => sendResponse({ found: false, what: 'element' }));
      return true;
    }
    if (msg.type !== 'replayStep') return;
    runStep(msg.step, msg.dialogs || [], msg.timeout || 10000, msg.loop || null)
      .then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  });

  // =====================================================================
  // List extraction: pick a list item, detect all items + fields + the Next button, extract pages.
  // Only runs in the top frame.
  // =====================================================================
  const STATE_CLASS = /^(active|selected|current|odd|even|first|last|hover|focus|open|show|visible|is-|has-)/i;
  const goodClasses = (el) => [...el.classList].filter((c) => c.length < 40 && !STATE_CLASS.test(c) && !looksGenerated(c) && !/^(ng-|css-|sc-|jsx-|svelte-|_)/.test(c));
  const NEXT_TEXT = /^(next|next page|sonraki|sonraki sayfa|ileri|›|»|>|→|more|load more|show more|daha fazla|daha fazla göster|devamı)$/i;
  const NEXT_HINT = /next|sonraki|ileri|load more|show more|daha fazla/i;

  function similar(a, b) {
    if (a.tagName !== b.tagName) return false;
    const ca = goodClasses(a);
    const cb = goodClasses(b);
    if (!ca.length && !cb.length) return true;
    return ca.some((c) => cb.includes(c));
  }
  const siblingsLike = (el) => (el.parentElement ? [...el.parentElement.children].filter((c) => similar(c, el)) : [el]);

  // From a clicked element, find the repeated "item" it belongs to (the ancestor with the most look-alike siblings).
  function detectItem(start) {
    let best = null;
    for (let el = start, d = 0; el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && d < 12; el = el.parentElement, d++) {
      const n = siblingsLike(el).length;
      if (el.tagName === 'TR' && n >= 2) return el;
      if (n >= 2 && (!best || n >= best.n)) best = { el, n };
    }
    return best ? best.el : null;
  }

  function shadowHostsOf(el) {
    const hosts = [];
    for (let r = el.getRootNode(); r instanceof ShadowRoot; r = r.host.getRootNode()) hosts.unshift(selectorFor(r.host));
    return hosts;
  }

  function listSpecFor(item) {
    const sibs = siblingsLike(item);
    const common = goodClasses(item).filter((c) => sibs.every((x) => x.classList.contains(c)));
    const tail = item.tagName.toLowerCase() + common.map((c) => '.' + CSS.escape(c)).join('');
    const spec = { selector: `${selectorFor(item.parentElement)} > ${tail}`, isRow: item.tagName === 'TR' };
    const hosts = shadowHostsOf(item);
    if (hosts.length) spec.shadowHosts = hosts;
    return spec;
  }

  function listItems(list) {
    let items = bySelector(list);
    if (list.isRow) items = items.filter((r) => r.querySelector('td'));
    const vis = items.filter(isVisible);
    return vis.length ? vis : items;
  }

  // ---- fields
  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return clean(t);
  }
  function leafKey(el, item) {
    const parts = [];
    for (let e = el; e && e !== item; e = e.parentElement) {
      const c = goodClasses(e)[0];
      parts.unshift(e.tagName.toLowerCase() + (c ? '.' + c : ''));
    }
    return parts.join('>') || '.';
  }
  function textMap(item) {
    const m = new Map();
    for (const el of [item, ...item.querySelectorAll('*')]) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(el.tagName.toUpperCase())) continue;
      const t = ownText(el);
      if (!t) continue;
      const k = leafKey(el, item);
      m.set(k, m.has(k) ? m.get(k) + ' | ' + t : t);
    }
    return m;
  }
  const tableOf = (row) => row.closest('table');
  function tableHeaders(row) {
    const t = tableOf(row);
    const th = t && (t.tHead?.rows[0] || [...t.rows].find((r) => r.querySelector('th') && !r.querySelector('td')));
    return th ? [...th.cells].map((c) => clean(c.innerText)) : [];
  }
  const fieldName = (key) => {
    const last = key.split('>').pop();
    const cls = last.split('.')[1];
    const tag = last.split('.')[0];
    const plain = /^h[1-6]$/.test(tag) ? 'title' : ['p', 'span', 'div', 'td', 'li'].includes(tag) ? 'text' : tag;
    return (cls || plain).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'text';
  };

  function detectFields(items, list) {
    const fields = [];
    const names = new Set();
    const add = (f) => {
      let n = f.name || 'field';
      for (let i = 2; names.has(n); i++) n = `${f.name}_${i}`;
      names.add(n);
      fields.push({ ...f, name: n });
    };
    const sample = items.slice(0, 50);
    if (list.isRow) {
      const heads = tableHeaders(sample[0]);
      const cols = Math.max(...sample.map((r) => r.cells.length));
      for (let i = 0; i < cols; i++) add({ kind: 'cell', index: i, name: heads[i] || `column_${i + 1}` });
    } else {
      const counts = new Map();
      for (const it of sample) for (const k of textMap(it).keys()) counts.set(k, (counts.get(k) || 0) + 1);
      const min = Math.max(1, Math.ceil(sample.length * 0.3));
      [...counts].filter(([, c]) => c >= min).slice(0, 15).forEach(([k]) => add({ kind: 'text', key: k, name: fieldName(k) }));
      if (!fields.length) add({ kind: 'all', name: 'text' });
    }
    if (sample.some((it) => it.matches('a[href]') || it.querySelector('a[href]'))) add({ kind: 'link', name: 'link' });
    if (sample.some((it) => it.querySelector('img'))) add({ kind: 'image', name: 'image' });
    return fields;
  }

  function rowOf(item, fields) {
    const row = {};
    let tm = null;
    for (const f of fields) {
      let v = '';
      if (f.kind === 'cell') v = clean(item.cells?.[f.index]?.innerText);
      else if (f.kind === 'text') { tm = tm || textMap(item); v = tm.get(f.key) || ''; }
      else if (f.kind === 'all') v = clean(item.innerText).slice(0, 1000);
      else if (f.kind === 'link') v = item.matches('a[href]') ? item.href : item.querySelector('a[href]')?.href || '';
      else if (f.kind === 'image') { const img = item.querySelector('img'); v = img ? img.currentSrc || img.src : ''; }
      row[f.name] = v;
    }
    return row;
  }

  // A readable, stable name per item (first text field), made unique within the page.
  function itemKeys(items, list) {
    const fields = detectFields(items, list).filter((f) => ['text', 'cell', 'all'].includes(f.kind));
    const seen = new Map();
    return items.map((it) => {
      const row = rowOf(it, fields);
      let k = (fields.map((f) => row[f.name]).find(Boolean) || clean(it.innerText)).slice(0, 80) || 'item';
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      if (n > 1) k = `${k} (${n})`;
      return k;
    });
  }

  // Selector for `el` relative to its list item, built from things that repeat in every item (classes, tags, structure).
  function relSelector(el, item) {
    const tag = el.tagName.toLowerCase();
    const uniq = (sel) => { try { return item.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
    const cls = goodClasses(el).map((c) => '.' + CSS.escape(c)).join('');
    if (cls && uniq(tag + cls)) return tag + cls;
    if (uniq(tag)) return tag;
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'role', 'type']) {
      const v = el.getAttribute(a);
      if (v && v.length < 60) {
        const sel = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
        if (uniq(sel)) return sel;
      }
    }
    const parts = [];
    for (let cur = el; cur && cur !== item; cur = cur.parentElement) {
      const p = cur.parentElement;
      const sibs = p ? [...p.children].filter((c) => c.tagName === cur.tagName) : [];
      parts.unshift(cur.tagName.toLowerCase() + (sibs.length > 1 ? `:nth-of-type(${sibs.indexOf(cur) + 1})` : ''));
    }
    return ':scope > ' + parts.join(' > ');
  }

  function inItemOf(el) {
    const items = listItems(activeLoop.list);
    const idx = items.findIndex((it) => it === el || it.contains(el));
    if (idx < 0) return null;
    return { index: idx, key: itemKeys(items, activeLoop.list)[idx], rel: el === items[idx] ? ':scope' : relSelector(el, items[idx]) };
  }

  const signatureOf = (items) => `${items.length}|${clean(items[0]?.innerText).slice(0, 80)}|${clean(items[items.length - 1]?.innerText).slice(0, 80)}`;

  // ---- next / load-more button
  function isDisabled(el) {
    return el.disabled || el.getAttribute('aria-disabled') === 'true' ||
      /(^|\s|-)disabled(\s|$)/i.test(el.className || '') || !!el.closest('.disabled,[aria-disabled="true"]');
  }
  function detectNext(items) {
    const last = items[items.length - 1];
    let best = null;
    for (const el of deepAll(document, 'a,button,[role=button],[role=link],input[type=button],input[type=submit]')) {
      if (!isVisible(el) || (last && last.contains(el)) || items.some((it) => it.contains(el))) continue;
      const text = clean(el.innerText || el.value);
      const hint = [el.getAttribute('aria-label'), el.title, el.getAttribute('rel'), el.className].join(' ');
      let score = 0;
      if (/(^|\s)next(\s|$)/i.test(el.getAttribute('rel') || '')) score += 10;
      if (NEXT_TEXT.test(text)) score += 7;
      else if (text.length < 30 && NEXT_HINT.test(text)) score += 5;
      if (NEXT_HINT.test(hint)) score += 5;
      if (!score) continue;
      if (el.closest('[class*="paginat" i],nav[aria-label*="pag" i],[role=navigation]')) score += 2;
      if (last && last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) score += 1;
      if (!best || score > best.score) best = { el, score };
    }
    return best ? best.el : null;
  }

  // ---- overlay (visual selection)
  let overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .b{position:fixed;box-sizing:border-box;border:2px solid #1a73e8;background:rgba(26,115,232,.08);border-radius:3px}
      .b.item{border-color:#188038;background:rgba(24,128,56,.10)}
      .b.next{border-color:#e8710a;background:rgba(232,113,10,.15);border-width:3px}
      .b i{position:absolute;top:-1px;left:-1px;font:600 10px/14px system-ui;background:#188038;color:#fff;padding:0 4px;border-radius:2px;font-style:normal}
      .b.next i{background:#e8710a}
      .banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);max-width:90vw;font:13px/1.4 system-ui;
        background:#1c1f24;color:#fff;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3)}
      .banner:empty{display:none}.banner.bottom{top:auto;bottom:12px}</style><div class="boxes"></div><div class="banner"></div>`;
    document.documentElement.append(host);
    overlay = { host, boxes: root.querySelector('.boxes'), banner: root.querySelector('.banner'), items: [], next: null, hover: null };
    const redraw = () => overlay && drawOverlay();
    window.addEventListener('scroll', redraw, true);
    window.addEventListener('resize', redraw);
    overlay.off = () => { window.removeEventListener('scroll', redraw, true); window.removeEventListener('resize', redraw); };
    return overlay;
  }
  function drawOverlay() {
    const o = overlay;
    const frag = document.createDocumentFragment();
    const box = (el, cls, label) => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || (!r.width && !r.height)) return;
      const d = document.createElement('div');
      d.className = 'b ' + cls;
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      if (label) { const i = document.createElement('i'); i.textContent = label; d.append(i); }
      frag.append(d);
    };
    o.items.slice(0, 300).forEach((el, i) => box(el, 'item', String(i + 1)));
    if (o.next) box(o.next, 'next', 'NEXT');
    if (o.hover) box(o.hover, '', '');
    o.boxes.replaceChildren(frag);
    // Keep the instruction banner out of the way of what is being pointed at.
    const focus = o.hover || o.next || o.items[0];
    const fr = focus && focus.getBoundingClientRect();
    o.banner.classList.toggle('bottom', !!fr && fr.top < 110);
  }
  function setOverlay({ items = [], next = null, hover = null, banner = '' }) {
    const o = ensureOverlay();
    Object.assign(o, { items, next, hover });
    o.banner.textContent = banner;
    drawOverlay();
  }
  function clearOverlay() {
    if (!overlay) return;
    overlay.off();
    overlay.host.remove();
    overlay = null;
  }

  // ---- picker
  const clickableOf = (t) => {
    let el = t.closest?.(CLICKABLE) || t;
    while (el && !(el instanceof HTMLElement)) el = el.parentElement; // e.g. an SVG icon inside a button
    return el || t;
  };
  const fieldOf = (t) => {
    const f = t.closest?.('input,textarea,[contenteditable],[contenteditable="true"]');
    return f && isTextLike(f) ? f : null;
  };

  function stopPicker(result) {
    if (!picker) return;
    const p = picker;
    picker = null;
    for (const [t, fn] of p.listeners) window.removeEventListener(t, fn, true);
    if (result && result.cancelled) clearOverlay();
    p.done(result);
  }

  function startPicker(mode, list, done) {
    stopPicker({ cancelled: true });
    if (recording) flushAll(); // keep text typed just before picking (the picker's own click is not recorded)
    const listEls = mode === 'next' && list ? listItems(list) : [];
    const banner = mode === 'item'
      ? 'Action Recorder: click one item of the list you want to extract · Esc to cancel'
      : mode === 'shot'
        ? 'Action Recorder: click the element to mark on the screenshot · ↑ / ↓ make it bigger / smaller · Esc to cancel'
      : mode === 'area'
        ? 'Action Recorder: click the area to check · ↑ / ↓ make it bigger / smaller · Esc to cancel'
        : mode === 'field'
          ? 'Action Recorder: click the field the answer should be typed into · Esc to cancel'
          : mode === 'click'
            ? 'Action Recorder: click the element the step should click — it will NOT be clicked now · Esc to cancel'
        : 'Action Recorder: click the "Next page" / "Load more" button · Esc to cancel';
    let hoverItems = [];
    let areaBase = null; // element under the mouse
    let areaUp = 0;      // how many levels up the user went with ↑
    const areaEl = () => {
      let el = areaBase;
      for (let k = 0; k < areaUp && el && el.parentElement && el.parentElement !== document.documentElement; k++) el = el.parentElement;
      return el;
    };
    const showArea = () => setOverlay({ hover: areaEl(), banner });
    const onMove = (e) => {
      const t = realTarget(e);
      if (!t || t.nodeType !== 1) return;
      if (mode === 'area' || mode === 'shot') {
        if (t !== areaBase) { areaBase = t; areaUp = 0; }
        showArea();
      } else if (mode === 'field') {
        setOverlay({ hover: fieldOf(t) || t, banner });
      } else if (mode === 'click') {
        setOverlay({ hover: clickableOf(t), banner });
      } else if (mode === 'item') {
        const item = detectItem(t);
        hoverItems = item ? siblingsLike(item) : [];
        setOverlay({ items: hoverItems, hover: item ? null : t, banner: item ? `${banner}  —  ${hoverItems.length} items` : banner });
      } else {
        const btn = t.closest(CLICKABLE) || t;
        setOverlay({ items: listEls, next: btn, banner });
      }
    };
    const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const onClick = (e) => {
      block(e);
      const t = realTarget(e);
      if (mode === 'click') {
        // Record a click on this element without performing it (the event is blocked above).
        const c = clickableOf(t);
        const d = describe(c);
        if (recording && activeLoop) { const ii = inItemOf(c); if (ii) d.inItem = ii; }
        setOverlay({ hover: c, banner: '' });
        setTimeout(() => { if (!picker) clearOverlay(); }, 1200);
        stopPicker({ click: d });
        return;
      }
      if (mode === 'field') {
        const f = fieldOf(t);
        if (!f) { setOverlay({ hover: t, banner: 'That is not a text field — click an input or text area' }); return; }
        const d = describe(f);
        if (recording && activeLoop) { const ii = inItemOf(f); if (ii) d.inItem = ii; }
        setOverlay({ hover: f, banner: '' });
        setTimeout(() => { if (!picker) clearOverlay(); }, 1200);
        stopPicker({ field: d });
        return;
      }
      if (mode === 'shot') {
        // 📷 Screenshot notes: where the element is on the screen now. The frame is drawn on the screenshot later,
        // so the page overlay is removed (and painted away) before answering — the screenshot is taken right after.
        if (t !== areaBase) { areaBase = t; areaUp = 0; }
        const el = areaEl();
        const r = el.getBoundingClientRect();
        const shot = {
          rect: { x: r.left, y: r.top, w: r.width, h: r.height }, vw: window.innerWidth, vh: window.innerHeight,
          scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }, url: location.href, title: document.title,
          name: clean(el.getAttribute('aria-label')) || clean(el.innerText).slice(0, 60) || describe(el).label || areaTarget(el).name,
        };
        clearOverlay();
        const p = picker;
        picker = null;
        for (const [ty, fn] of p.listeners) window.removeEventListener(ty, fn, true);
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => p.done({ shot }), 60)));
        return;
      }
      if (mode === 'area') {
        if (t !== areaBase) { areaBase = t; areaUp = 0; }
        const el = areaEl();
        setOverlay({ hover: el, banner: '' });
        setTimeout(() => { if (!picker) clearOverlay(); }, 1500);
        stopPicker({ area: areaTarget(el) });
      } else if (mode === 'item') {
        const item = detectItem(t);
        if (!item) { setOverlay({ banner: 'No repeating list found here — try clicking directly on one item' }); return; }
        const spec = listSpecFor(item);
        const items = listItems(spec);
        const fields = detectFields(items, spec);
        const next = detectNext(items);
        setOverlay({ items, next, banner: '' });
        setTimeout(() => { if (!picker) clearOverlay(); }, 4000);
        stopPicker({ list: spec, fields, count: items.length, preview: items.slice(0, 5).map((it) => rowOf(it, fields)), next: next ? describe(next) : null });
      } else {
        const btn = t.closest(CLICKABLE) || t;
        setOverlay({ items: listEls, next: btn, banner: '' });
        setTimeout(() => { if (!picker) clearOverlay(); }, 2500);
        stopPicker({ next: describe(btn) });
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { block(e); stopPicker({ cancelled: true }); }
      if ((mode === 'area' || mode === 'shot') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        block(e);
        areaUp = Math.max(0, areaUp + (e.key === 'ArrowUp' ? 1 : -1));
        showArea();
      }
    };
    const listeners = [['mousemove', onMove], ['click', onClick], ['keydown', onKey],
      ['mousedown', block], ['mouseup', block], ['pointerdown', block], ['pointerup', block], ['dblclick', block], ['auxclick', block]];
    picker = { done, listeners };
    for (const [t, fn] of listeners) window.addEventListener(t, fn, true);
    setOverlay({ items: listEls, banner });
  }

  // ---- text checks
  // An area to check is found by its selector; its visible text is what gets checked, so don't match on it.
  function areaTarget(el) {
    const d = describe(el);
    if (recording && activeLoop) { const ii = inItemOf(el); if (ii) d.inItem = ii; } // inside a "For each item" loop
    const heading = el.querySelector?.('h1,h2,h3,h4,h5,h6,legend,[class*="title" i],[class*="header" i]');
    const name = clean(el.getAttribute('aria-label')) || clean(heading?.innerText).slice(0, 60) ||
      (el.id ? '#' + el.id : '') || d.selector;
    return { ...d, label: '', name };
  }

  function deepText(node) {
    let t = node instanceof ShadowRoot ? [...node.children].map((c) => c.innerText || '').join('\n') : (node.innerText || '');
    for (const e of node.querySelectorAll('*')) if (e.shadowRoot) t += '\n' + deepText(e.shadowRoot);
    return t;
  }

  function keywordRe(k, c) {
    const flags = 'gu' + (c.caseSensitive ? '' : 'i');
    if (c.match === 'regex') return new RegExp(k, flags);
    const esc = k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(c.match === 'word' ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, flags);
  }

  function evalCheck(c) {
    let scope = document.body;
    if (c.scope) {
      scope = findOnce(c.scope);
      if (!scope) return { passed: false, details: [], error: `area "${c.scope.name}" not found` };
    }
    const text = clean(deepText(scope));
    const details = c.keywords.map((k) => {
      let re;
      try { re = keywordRe(k, c); } catch (err) { return { keyword: k, count: 0, error: `invalid regex: ${err.message}` }; }
      let count = 0;
      let first = null;
      for (const m of text.matchAll(re)) {
        if (!first) first = m;
        if (++count >= 999) break;
      }
      const sample = first ? '…' + text.slice(Math.max(0, first.index - 40), first.index + first[0].length + 40) + '…' : '';
      return { keyword: k, count, sample, match: first ? first[0] : '' };
    });
    const bad = details.find((d) => d.error);
    if (bad) return { passed: false, details, error: bad.error };
    const passed = c.mode === 'absent' ? details.every((d) => !d.count) : details.every((d) => d.count > 0);
    return { passed, details, textLength: text.length, text };
  }

  // ---- capture a value from an element (for {{VARIABLES}} in later steps)
  function readValue(el, c) {
    let v = c.what === 'value' ? (el.value ?? el.textContent ?? '')
      : c.what === 'attr' ? (c.attr === 'href' && el.href ? el.href : el.getAttribute(c.attr) || '')
      : (el.innerText || el.textContent || '');
    v = clean(v);
    if (c.regex) {
      const m = new RegExp(c.regex, 'u').exec(v);
      v = m ? (m[1] ?? m[0]) : '';
    }
    return v;
  }
  async function captureValue(c, loop, timeout) {
    await waitQuiet(Math.min(3000, timeout)); // let late content (e.g. "Loading…" placeholders) settle first
    const end = Date.now() + timeout;
    for (;;) {
      const el = c.target.inItem && loop ? await findInItem(c.target, loop, 300).catch(() => null) : findOnce(c.target);
      const v = el ? readValue(el, c) : '';
      if (v || Date.now() >= end) {
        if (!el) throw new Error(`Element to capture not found (selector ${c.target.selector})`);
        return { value: v, found: true };
      }
      await sleep(300);
    }
  }

  // Keep re-checking until it passes or the timeout ends (pages often render text late).
  // "must exist": passes as soon as the text shows up.
  // "must NOT exist": a page that is still loading would pass too early, so only decide once the
  // area's text has stopped changing — and, if we know how much text it had when recorded, once it
  // looks loaded (at least 40% of that). If it never settles, report it with a warning.
  const SETTLE_MS = 2000;
  const MIN_WAIT_MS = 3000;
  async function runCheck(c, timeout) {
    const done = (r, warning) => {
      delete r.text;
      if (warning) r.warning = warning;
      return r;
    };
    const start = Date.now();
    if (!timeout) return done(evalCheck(c));
    let lastText = null;
    let stableSince = start;
    for (;;) {
      const r = evalCheck(c);
      const now = Date.now();
      if (r.text !== lastText) { lastText = r.text; stableSince = now; }
      if (r.error && !r.error.startsWith('area')) return done(r);
      const loaded = !c.textLen || (r.textLength || 0) >= c.textLen * 0.4;
      if (c.mode !== 'absent') {
        if (r.passed) return done(r);
      } else if (!r.error && now - stableSince >= SETTLE_MS && now - start >= MIN_WAIT_MS && (loaded || !r.passed)) {
        return done(r);
      }
      if (now >= start + timeout) {
        const warn = c.mode === 'absent' && r.passed && !loaded
          ? `content looked incomplete (${r.textLength} of ~${c.textLen} characters when recorded)`
          : c.mode === 'absent' && r.passed && now - stableSince < SETTLE_MS ? 'content was still changing' : '';
        return done(r, warn);
      }
      await sleep(300);
    }
  }

  async function waitForItems(list, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      const items = listItems(list);
      if (items.length) return items;
      if (Date.now() > end) throw new Error(`List not found on this page (selector ${list.selector})`);
      await sleep(300);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isTop || !/^(list|check|loop):/.test(msg.type || '')) return;
    const fail = (err) => sendResponse({ ok: false, error: String(err && err.message || err) });
    switch (msg.type) {
      case 'check:capture':
        captureValue(msg.capture, msg.loop || null, msg.timeout || 0).then((r) => sendResponse({ ok: true, ...r }), fail);
        return true;
      case 'check:run':
        runCheck(msg.check, msg.timeout || 0).then((r) => sendResponse({ ok: true, ...r }), fail);
        return true;
      case 'check:cond':
        // ⑂ "only if the page shows …": let the page settle, then look for the text (briefly, it may render late).
        (async () => {
          await waitQuiet(Math.min(4000, msg.timeout || 4000));
          const want = String(msg.value || '').trim().toLocaleLowerCase();
          const has = () => !!want && deepText(document.body || document.documentElement).toLocaleLowerCase().replace(/\s+/g, ' ').includes(want.replace(/\s+/g, ' '));
          let found = has();
          const end = Date.now() + 1500;
          while (!found && Date.now() < end) { await sleep(250); found = has(); }
          return { found };
        })().then((r) => sendResponse({ ok: true, ...r }), fail);
        return true;
      case 'list:pick':
        startPicker(msg.mode, msg.list, (r) => sendResponse({ ok: true, ...r }));
        return true;
      case 'shot:where':
        // 📷 Whole-screen screenshot: the scroll position / viewport now (no element).
        sendResponse({ ok: true, vw: window.innerWidth, vh: window.innerHeight, url: location.href, title: document.title,
          scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) } });
        return;
      case 'list:cancel':
        stopPicker({ cancelled: true });
        clearOverlay();
        sendResponse({ ok: true });
        return;
      case 'list:show': {
        const items = listItems(msg.list);
        const next = msg.next ? findOnce(msg.next) : null;
        setOverlay({ items, next, banner: '' });
        setTimeout(() => { if (!picker) clearOverlay(); }, msg.ms || 3000);
        sendResponse({ ok: true, count: items.length, nextFound: !!next });
        return;
      }
      case 'list:page':
        waitForItems(msg.list, msg.timeout || 10000).then((items) => {
          const fields = msg.fields || detectFields(items, msg.list);
          sendResponse({ ok: true, fields, rows: items.map((it) => rowOf(it, fields)), signature: signatureOf(items) });
        }, fail);
        return true;
      case 'loop:items':
        waitForItems(msg.list, msg.timeout || 10000).then((items) => {
          const fields = detectFields(items, msg.list);
          sendResponse({
            ok: true,
            items: itemKeys(items, msg.list).map((key, index) => ({ index, key, row: rowOf(items[index], fields) })),
            signature: signatureOf(items),
          });
        }, fail);
        return true;
      case 'list:signature': {
        const items = listItems(msg.list);
        sendResponse({ ok: true, signature: items.length ? signatureOf(items) : '' });
        return;
      }
      case 'list:next':
        (async () => {
          let el = null;
          const end = Date.now() + (msg.timeout || 3000);
          while (!el && Date.now() < end) { el = findOnce(msg.next); if (!el) await sleep(250); }
          if (!el) return { ok: true, clicked: false, reason: 'no Next button any more' };
          if (isDisabled(el)) return { ok: true, clicked: false, reason: 'Next button is disabled' };
          flash(el);
          doClick(el);
          return { ok: true, clicked: true };
        })().then(sendResponse, fail);
        return true;
    }
  });
})();
