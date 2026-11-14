/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// 📷 Screenshot notes: mark elements on the page (a red numbered frame on a screenshot), write notes, export a PDF.
// Screenshots stay in this browser profile (IndexedDB) until "Clear all".

let shotDoc = { title: '', shots: [] }; // shots: [{ id, img (PNG data URL), w, h, vw, vh, scroll, url, title, at, note, marks: [{ id, rect, name, note }] }]

// ---------------------------------------------------------------- storage (IndexedDB: screenshots are large)
function shotDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('action-recorder-shots', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function shotLoad() {
  try {
    const db = await shotDb();
    const doc = await new Promise((resolve, reject) => {
      const r = db.transaction('kv').objectStore('kv').get('doc');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (doc && Array.isArray(doc.shots)) shotDoc = doc;
  } catch { /* first use / storage blocked: start empty */ }
}
let shotSaveTimer = null;
function shotSave(now = false) {
  clearTimeout(shotSaveTimer);
  const write = async () => {
    try {
      const db = await shotDb();
      db.transaction('kv', 'readwrite').objectStore('kv').put(shotDoc, 'doc');
    } catch (err) { $('shMsg').textContent = `Could not save the screenshots: ${err.message}`; }
  };
  if (now) return write();
  shotSaveTimer = setTimeout(write, 400);
}

// ---------------------------------------------------------------- capture
async function shotCapture() {
  const win = await chrome.windows.getCurrent();
  const img = await chrome.tabs.captureVisibleTab(win.id, { format: 'png' });
  const size = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => reject(new Error('The screenshot could not be read'));
    i.src = img;
  });
  return { img, ...size };
}

const shotNewId = () => crypto.randomUUID();
const samePlace = (shot, w) => shot.url === w.url && shot.vw === w.vw && shot.vh === w.vh &&
  shot.scroll?.x === w.scroll?.x && shot.scroll?.y === w.scroll?.y;

async function newShot(where) {
  const cap = await shotCapture();
  const shot = { id: shotNewId(), ...cap, vw: where.vw, vh: where.vh, scroll: where.scroll, url: where.url, title: where.title, at: Date.now(), note: '', marks: [] };
  shotDoc.shots.push(shot);
  return shot;
}

let shotFocus = null; // input to focus after rendering: { shot, mark } ids

// ▣ Mark an element — on a new screenshot, or (onShot) on that screenshot when the page did not move since.
async function shotMark(onShotId) {
  const busy = [$('shPick'), $('shFull')];
  try {
    const tab = await activeTab();
    busy.forEach((b) => { b.disabled = true; });
    $('shMsg').textContent = 'Click the element in the page (↑ / ↓ make the frame bigger / smaller, Esc to cancel)';
    const r = await pageCall(tab.id, { type: 'list:pick', mode: 'shot' });
    if (r.cancelled || !r.shot) { $('shMsg').textContent = ''; return; }
    const w = r.shot;
    let shot = onShotId ? shotDoc.shots.find((x) => x.id === onShotId) : null;
    let msg = '';
    if (shot && !samePlace(shot, w)) {
      msg = 'The page was scrolled or changed since that screenshot — the mark is on a new screenshot.';
      shot = null;
    }
    if (!shot) shot = await newShot(w);
    const mark = { id: shotNewId(), rect: w.rect, name: w.name || '', note: '' };
    shot.marks.push(mark);
    shotFocus = { shot: shot.id, mark: mark.id };
    $('shMsg').textContent = msg || 'Write the note for the mark, then mark the next element.';
    shotSave(true);
    renderShots();
  } catch (err) {
    $('shMsg').textContent = err.message;
  } finally {
    busy.forEach((b) => { b.disabled = false; });
  }
}

async function shotWhole() {
  try {
    const tab = await activeTab();
    const where = await pageCall(tab.id, { type: 'shot:where' }).catch(() => ({ vw: tab.width, vh: tab.height, url: tab.url, title: tab.title, scroll: { x: 0, y: 0 } }));
    const shot = await newShot(where);
    shotFocus = { shot: shot.id };
    $('shMsg').textContent = 'Screenshot taken — add a note for it if you like.';
    shotSave(true);
    renderShots();
  } catch (err) {
    $('shMsg').textContent = err.message;
  }
}

// ---------------------------------------------------------------- list
function shotNumbers() {
  const no = new Map();
  let k = 0;
  shotDoc.shots.forEach((s) => s.marks.forEach((m) => no.set(m.id, ++k)));
  return no;
}

function renderShots() {
  const list = $('shList');
  list.replaceChildren();
  $('shTitle').value = shotDoc.title || '';
  $('shFoot').hidden = !shotDoc.shots.length;
  const no = shotNumbers();
  shotDoc.shots.forEach((s, k) => {
    const li = el('li', 'shot');
    const head = el('div', 'shhead');
    head.append(el('b', '', `Screen ${k + 1}`), el('span', 'xinfo', ` · ${s.title || s.url} · ${new Date(s.at).toLocaleTimeString()}`));
    const btns = el('span', 'shbtns');
    const b = (txt, title, fn, cls = 'del') => { const x = el('button', cls, txt); x.type = 'button'; x.title = title; x.addEventListener('click', fn); btns.append(x); return x; };
    b('+ mark', 'Mark another element on this same screen (the page must not be scrolled in between)', () => shotMark(s.id));
    if (k > 0) b('↑', 'Move up', () => { shotDoc.shots.splice(k - 1, 0, shotDoc.shots.splice(k, 1)[0]); shotSave(); renderShots(); });
    if (k < shotDoc.shots.length - 1) b('↓', 'Move down', () => { shotDoc.shots.splice(k + 1, 0, shotDoc.shots.splice(k, 1)[0]); shotSave(); renderShots(); });
    b('×', 'Remove this screenshot', () => { if (confirm(`Remove screen ${k + 1} and its notes?`)) { shotDoc.shots.splice(k, 1); shotSave(); renderShots(); } });
    head.append(btns);

    const pic = el('div', 'shimg');
    const img = el('img');
    img.src = s.img;
    img.alt = `Screenshot ${k + 1}`;
    pic.append(img);
    const px = s.w / s.vw; // screenshot pixels per CSS pixel (the same in both directions)
    s.marks.forEach((m) => {
      const f = el('div', 'shmark');
      Object.assign(f.style, {
        left: `${(m.rect.x / s.vw) * 100}%`, top: `${((m.rect.y * px) / s.h) * 100}%`,
        width: `${(m.rect.w / s.vw) * 100}%`, height: `${((m.rect.h * px) / s.h) * 100}%`,
      });
      f.append(el('span', 'shbadge', String(no.get(m.id))));
      pic.append(f);
    });

    const note = el('textarea', 'shnote');
    note.rows = 1;
    note.placeholder = 'Note for the whole screen (optional)';
    note.value = s.note || '';
    note.addEventListener('input', () => { s.note = note.value; shotSave(); });
    li.append(head, pic, note);
    if (shotFocus?.shot === s.id && !shotFocus.mark) requestAnimationFrame(() => note.focus());

    s.marks.forEach((m, j) => {
      const row = el('div', 'shmrow');
      const inp = el('textarea', 'shnote');
      inp.rows = 2;
      inp.placeholder = `Note for ${m.name ? `"${m.name}"` : 'this mark'}`;
      inp.value = m.note || '';
      inp.addEventListener('input', () => { m.note = inp.value; shotSave(); });
      const x = el('button', 'del', '×');
      x.type = 'button';
      x.title = 'Remove this mark';
      x.addEventListener('click', () => { s.marks.splice(j, 1); shotSave(); renderShots(); });
      row.append(el('span', 'shbadge', String(no.get(m.id))), inp, x);
      li.append(row);
      if (shotFocus?.mark === m.id) requestAnimationFrame(() => { inp.focus(); row.scrollIntoView({ block: 'nearest' }); });
    });
    list.append(li);
  });
  shotFocus = null;
}

// ---------------------------------------------------------------- PDF
const SHOT_RED = '#e53935';
const loadImg = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });

function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (ctx.measureText(next).width > maxW && line.trim()) { lines.push(line.trimEnd()); line = word.trimStart(); } else line = next;
      while (ctx.measureText(line).width > maxW && line.length > 1) { // one very long word
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function badge(ctx, x, y, r, n) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = SHOT_RED;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(r * 1.1)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x, y + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// A page as a canvas: drawn by `paint(ctx, measureOnly)` which returns the height it needs.
function canvasPage(width, paint) {
  const probe = document.createElement('canvas').getContext('2d');
  const h = Math.ceil(paint(probe, true));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.max(h, 10);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  paint(ctx, false);
  return c;
}

const toJpeg = (canvas) => new Promise((resolve) => canvas.toBlob(async (b) => resolve(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', 0.88));

const PW = 1600; // page width in pixels (all pages)
const PAD = 48;

function coverPage(no) {
  const title = shotDoc.title || 'Screenshot notes';
  const marks = shotDoc.shots.reduce((n, s) => n + s.marks.length, 0);
  return canvasPage(PW, (ctx, measure) => {
    let y = PAD + 50;
    ctx.fillStyle = '#1c1f24';
    ctx.font = 'bold 48px system-ui, sans-serif';
    for (const l of wrapText(ctx, title, PW - 2 * PAD)) { if (!measure) ctx.fillText(l, PAD, y); y += 60; }
    ctx.font = '24px system-ui, sans-serif';
    ctx.fillStyle = '#5f6368';
    if (!measure) ctx.fillText(`${new Date().toLocaleString()} · ${shotDoc.shots.length} screen${shotDoc.shots.length === 1 ? '' : 's'} · ${marks} mark${marks === 1 ? '' : 's'}`, PAD, y);
    y += 56;
    ctx.font = '26px system-ui, sans-serif';
    shotDoc.shots.forEach((s, k) => {
      const items = [...(s.note ? [{ n: null, text: s.note }] : []), ...s.marks.map((m) => ({ n: no.get(m.id), text: m.note || m.name || '(no note)' }))];
      if (!items.length) return;
      ctx.fillStyle = '#1c1f24';
      ctx.font = 'bold 26px system-ui, sans-serif';
      if (!measure) ctx.fillText(`Screen ${k + 1} — ${s.title || s.url}`.slice(0, 110), PAD, y);
      y += 40;
      ctx.font = '24px system-ui, sans-serif';
      for (const it of items) {
        const lines = wrapText(ctx, it.text, PW - 2 * PAD - 60);
        if (!measure && it.n) badge(ctx, PAD + 18, y - 8, 16, it.n);
        lines.forEach((l, j) => { if (!measure) { ctx.fillStyle = '#1c1f24'; ctx.fillText(l, PAD + 50, y + j * 32); } });
        y += lines.length * 32 + 10;
      }
      y += 20;
    });
    return y + PAD;
  });
}

async function shotPage(s, k, no) {
  const img = await loadImg(s.img);
  const iw = PW - 2 * PAD;
  const ih = Math.round(img.naturalHeight * (iw / img.naturalWidth));
  const sx = iw / s.vw; // CSS pixels → page pixels (same scale in both directions)
  const sy = sx;
  return canvasPage(PW, (ctx, measure) => {
    let y = PAD + 30;
    ctx.fillStyle = '#1c1f24';
    ctx.font = 'bold 30px system-ui, sans-serif';
    if (!measure) ctx.fillText(`Screen ${k + 1} of ${shotDoc.shots.length}${s.title ? ` — ${s.title}` : ''}`.slice(0, 95), PAD, y);
    y += 30;
    ctx.font = '20px system-ui, sans-serif';
    ctx.fillStyle = '#5f6368';
    if (!measure) ctx.fillText(`${s.url}`.slice(0, 140) + ` · ${new Date(s.at).toLocaleString()}`, PAD, y);
    y += 22;
    const top = y;
    if (!measure) {
      ctx.drawImage(img, PAD, top, iw, ih);
      ctx.strokeStyle = '#dadce0';
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD, top, iw, ih);
      for (const m of s.marks) {
        const x = PAD + m.rect.x * sx;
        const yy = top + m.rect.y * sy;
        ctx.strokeStyle = SHOT_RED;
        ctx.lineWidth = 4;
        ctx.strokeRect(x - 2, yy - 2, m.rect.w * sx + 4, m.rect.h * sy + 4);
        const bx = Math.min(Math.max(x, PAD + 20), PAD + iw - 20);
        const by = Math.min(Math.max(yy, top + 20), top + ih - 20);
        badge(ctx, bx, by, 18, no.get(m.id));
      }
    }
    y = top + ih + 40;
    ctx.font = '24px system-ui, sans-serif';
    const items = [...(s.note ? [{ n: null, text: s.note }] : []), ...s.marks.map((m) => ({ n: no.get(m.id), text: m.note || m.name || '' }))].filter((x) => x.text);
    for (const it of items) {
      const lines = wrapText(ctx, it.text, iw - 60);
      if (!measure && it.n) badge(ctx, PAD + 18, y - 8, 16, it.n);
      lines.forEach((l, j) => { if (!measure) { ctx.fillStyle = '#1c1f24'; ctx.fillText(l, PAD + (it.n ? 50 : 0), y + j * 32); } });
      y += lines.length * 32 + 12;
    }
    return y + PAD - 20;
  });
}

async function shotPdf() {
  if (!shotDoc.shots.length) return;
  $('shPdf').disabled = true;
  try {
    const no = shotNumbers();
    const canvases = [coverPage(no)];
    for (let k = 0; k < shotDoc.shots.length; k++) {
      $('shMsg').textContent = `Making the PDF… screen ${k + 1} of ${shotDoc.shots.length}`;
      canvases.push(await shotPage(shotDoc.shots[k], k, no));
    }
    const pages = [];
    for (const c of canvases) pages.push({ jpeg: await toJpeg(c), w: c.width, h: c.height, pw: 842 });
    const blob = makePdf(pages, { title: shotDoc.title || 'Screenshot notes' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: shotFileName('pdf') });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('shMsg').textContent = `PDF ready — ${pages.length} pages (a summary page + ${shotDoc.shots.length} screen${shotDoc.shots.length === 1 ? '' : 's'}).`;
  } catch (err) {
    $('shMsg').textContent = `Could not make the PDF: ${err.message}`;
  } finally {
    $('shPdf').disabled = false;
  }
}

// ---------------------------------------------------------------- Word (.docx)
// The screenshot with its red numbered frames only (the notes are real, editable text in the Word file).
async function markedImage(s, no) {
  const img = await loadImg(s.img);
  const W = Math.min(img.naturalWidth, 1600);
  const H = Math.round(img.naturalHeight * (W / img.naturalWidth));
  const sx = W / s.vw; // CSS pixels → image pixels (same in both directions)
  const k = Math.max(0.6, W / 1500);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  for (const m of s.marks) {
    const x = m.rect.x * sx;
    const y = m.rect.y * sx;
    ctx.strokeStyle = SHOT_RED;
    ctx.lineWidth = 4 * k;
    ctx.strokeRect(x - 2, y - 2, m.rect.w * sx + 4, m.rect.h * sx + 4);
    const r = 18 * k;
    badge(ctx, Math.min(Math.max(x, r + 2), W - r - 2), Math.min(Math.max(y, r + 2), H - r - 2), r, no.get(m.id));
  }
  ctx.strokeStyle = '#dadce0';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  return { jpeg: await toJpeg(c), w: W, h: H };
}

const shotFileName = (ext) => `${slug(String(shotDoc.title || 'screenshot-notes').replace(/ı/g, 'i').replace(/İ/g, 'I').normalize('NFD').replace(/[\u0300-\u036f]/g, ''))}-${fileStamp()}.${ext}`;

async function shotDocx() {
  if (!shotDoc.shots.length) return;
  $('shDocx').disabled = true;
  try {
    const no = shotNumbers();
    const marks = shotDoc.shots.reduce((n, s) => n + s.marks.length, 0);
    const screens = [];
    for (let k = 0; k < shotDoc.shots.length; k++) {
      const s = shotDoc.shots[k];
      $('shMsg').textContent = `Making the Word file… screen ${k + 1} of ${shotDoc.shots.length}`;
      screens.push({
        heading: `Screen ${k + 1}${s.title ? ` — ${s.title}` : ''}`,
        meta: `${s.url} · ${new Date(s.at).toLocaleString()}`,
        note: s.note || '',
        image: await markedImage(s, no),
        marks: s.marks.map((m) => ({ n: no.get(m.id), note: m.note || '', name: m.name || '' })),
      });
    }
    const blob = makeDocx({
      title: shotDoc.title || 'Screenshot notes',
      subtitle: `${new Date().toLocaleString()} · ${screens.length} screen${screens.length === 1 ? '' : 's'} · ${marks} mark${marks === 1 ? '' : 's'}`,
      screens,
    });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: shotFileName('docx') });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('shMsg').textContent = `Word file ready — ${screens.length} screen${screens.length === 1 ? '' : 's'}; the notes can be edited in Word.`;
  } catch (err) {
    $('shMsg').textContent = `Could not make the Word file: ${err.message}`;
  } finally {
    $('shDocx').disabled = false;
  }
}

// ---------------------------------------------------------------- wiring
// ---------------------------------------------------------------- Markdown (.zip: notes.md + images/)
// Text for Markdown: keep it on one line per item and stop accidental formatting / tables.
const mdText = (t) => String(t ?? '').replace(/\r/g, '').replace(/([\\`*_[\]<>|])/g, '\\$1');
const mdLines = (t, indent = '') => mdText(t).split('\n').map((l, k) => (k ? indent : '') + l).join('  \n');

async function shotMarkdown() {
  if (!shotDoc.shots.length) return;
  $('shMd').disabled = true;
  try {
    const no = shotNumbers();
    const marks = shotDoc.shots.reduce((n, s) => n + s.marks.length, 0);
    const files = [];
    const md = [`# ${mdText(shotDoc.title || 'Screenshot notes')}`, '',
      `_${new Date().toLocaleString()} · ${shotDoc.shots.length} screen${shotDoc.shots.length === 1 ? '' : 's'} · ${marks} mark${marks === 1 ? '' : 's'}_`, ''];
    for (let k = 0; k < shotDoc.shots.length; k++) {
      const s = shotDoc.shots[k];
      $('shMsg').textContent = `Making the Markdown… screen ${k + 1} of ${shotDoc.shots.length}`;
      const img = await markedImage(s, no);
      const file = `images/screen-${String(k + 1).padStart(2, '0')}.jpg`;
      files.push({ name: file, data: img.jpeg });
      md.push(`## Screen ${k + 1}${s.title ? ` — ${mdText(s.title)}` : ''}`, '',
        `<${s.url}> · ${new Date(s.at).toLocaleString()}`, '', `![Screen ${k + 1}](${file})`, '');
      if (s.note) md.push(mdLines(s.note), '');
      for (const m of s.marks) {
        md.push(`- **[${no.get(m.id)}]** ${m.note ? mdLines(m.note, '  ') : '_(no note)_'}${m.name && m.name !== m.note ? ` — _${mdText(m.name)}_` : ''}`);
      }
      if (s.marks.length) md.push('');
    }
    files.unshift({ name: 'notes.md', data: md.join('\n') });
    const blob = new Blob([makeZip(files)], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: shotFileName('md.zip') });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('shMsg').textContent = 'Markdown ready — a .zip with notes.md and the images/ folder (unzip it, keep them together).';
  } catch (err) {
    $('shMsg').textContent = `Could not make the Markdown: ${err.message}`;
  } finally {
    $('shMd').disabled = false;
  }
}

$('shDocx').addEventListener('click', shotDocx);
$('shMd').addEventListener('click', shotMarkdown);
$('tabShots').addEventListener('click', () => { show('shots'); renderShots(); });
$('shPick').addEventListener('click', () => shotMark());
$('shFull').addEventListener('click', shotWhole);
$('shPdf').addEventListener('click', shotPdf);
$('shTitle').addEventListener('input', () => { shotDoc.title = $('shTitle').value; shotSave(); });
$('shClear').addEventListener('click', () => {
  if (!confirm('Remove all screenshots and notes?')) return;
  shotDoc = { title: '', shots: [] };
  shotSave(true);
  $('shMsg').textContent = '';
  renderShots();
});
shotLoad().then(() => { if (view === 'shots') renderShots(); });
