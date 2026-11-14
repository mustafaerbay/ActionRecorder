/*!
 * Action Recorder — Chrome extension
 * Copyright (c) 2026 Mustafa Erbay. All rights reserved.
 * Proprietary and confidential. Unauthorized copying, modification or distribution of this file,
 * via any medium, is strictly prohibited. See the LICENSE file for details.
 */
// Minimal PDF writer: one JPEG image per page (the page is the size of the image). Text is drawn into the images,
// so any language works without embedding fonts.

const pdfText = (s) => new TextEncoder().encode(s);

// PDF text string: ASCII as (…), anything else as UTF-16BE hex with a byte-order mark.
function pdfString(s) {
  s = String(s || '');
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, (c) => '\\' + c)})`;
  let hex = 'FEFF';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    units.forEach((u) => { hex += u.toString(16).padStart(4, '0').toUpperCase(); });
  }
  return `<${hex}>`;
}

// pages: [{ jpeg: Uint8Array, w, h (image pixels), pw (page width in points) }] → Blob (application/pdf)
function makePdf(pages, info = {}) {
  const parts = [];
  const offsets = [];
  let size = 0;
  const put = (x) => { const b = typeof x === 'string' ? pdfText(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };

  put('%PDF-1.4\n');
  const n = pages.length;
  // 1 catalog, 2 pages, 3 info, then per page: page, contents, image
  const pageNo = (k) => 4 + k * 3;
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, k) => `${pageNo(k)} 0 R`).join(' ')}] >>`));
  obj(3, () => put(`<< /Title ${pdfString(info.title)} /Producer (Action Recorder) /Creator (Action Recorder) >>`));
  pages.forEach((p, k) => {
    const pw = p.pw || 842;
    const ph = Math.round(pw * (p.h / p.w) * 100) / 100;
    const [po, co, io] = [pageNo(k), pageNo(k) + 1, pageNo(k) + 2];
    obj(po, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${k} ${io} 0 R >> >> /Contents ${co} 0 R >>`));
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im${k} Do Q`;
    obj(co, () => { put(`<< /Length ${content.length} >>\nstream\n`); put(content); put('\nendstream'); });
    obj(io, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      put(p.jpeg);
      put('\nendstream');
    });
  });
  const total = 4 + n * 3;
  const xref = size;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  put(x);
  put(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

if (typeof module !== 'undefined') module.exports = { makePdf, pdfString };
