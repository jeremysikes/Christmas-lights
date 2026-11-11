/* LightPlan UI: export (SPEC §6.5).
 * Files that leave the app: the PDF report, the customer quote PDF, the CSV shopping list, the project JSON,
 * opening a saved project, and saving any of them through the viewer's download prompt.
 *
 *  - PdfDoc is a small PDF writer in plain JS (no DOM), so it runs in Node tests. The artifact frame blocks
 *    window.print(), so every PDF is built byte by byte here: letter pages, the standard Helvetica and
 *    Helvetica-Bold fonts (WinAnsi encoding, real Adobe AFM widths for word wrapping and alignment), lines,
 *    rectangles, and JPEG photos embedded as-is (DCTDecode). Callers use points from the TOP-left corner; the
 *    writer flips to PDF's bottom-left coordinates internally.
 *  - buildReportPdf / buildQuotePdf lay out the two documents from a project and its plan. They are pure (the
 *    date and the preview picture are passed in) and never throw on partial data: a section that cannot be drawn
 *    is replaced by a one-line note, so the rest of the PDF is still useful.
 *  - The store-level exports (exportPdfReport, exportQuotePdf, exportCsv, exportJson) do the browser work: render
 *    the night preview to a JPEG, collect photos as data URLs, and hand the file to saveFile.
 *  - saveFile uses window.claude.use('downloads') (cached once by initDownloads, because use() can take up to
 *    10 s to answer) and falls back to a blob-URL <a download> click only when the page runs as a standalone file
 *    (no window.claude). Inside the viewer, where blob downloads are blocked, a missing or silent capability
 *    resolves 'unavailable' rather than a false 'saved'.
 *
 * Deviations from SPEC §6.5 (documented signatures unchanged; the result set is widened):
 *  - saveFile (and so the export functions) resolve 'saved' | 'declined' | 'failed' | 'busy' (a save prompt is
 *    already open, or the viewer said rate_limited) | 'unavailable' (no downloads capability in the viewer, or
 *    unavailable / not_granted / capability_*) | 'too_large'. Only one save runs at a time. The export functions
 *    reject with a plain-language Error when there is nothing to export (no project, or installer mode off for
 *    the quote).
 *  - initDownloads(opts) also accepts {timeoutMs} (default 12000): if use() never answers, saving stops waiting
 *    (standalone: the <a download> path; viewer: 'unavailable'). It returns the cached promise.
 *  - PdfDoc: the constructor also takes {title, author, subject, creationDate}; text() also takes lineHeight
 *    (multiple of size, default 1.2) and maxLines, treats y as the TOP of the first line box, and returns
 *    {lines, width, height}. With maxWidth, align is relative to the box [x, x + maxWidth]; without it, x is the
 *    left edge, the right edge ('right') or the center ('center'). Extra members: width, height, pageCount,
 *    setPage(index), wrapText(str, size, bold, maxWidth) → lines. line() also takes {dash: [on, off]}; rect() also
 *    takes {width, radius}. image() throws a plain Error when the bytes are not a JPEG it can embed (baseline or
 *    progressive, 8-bit, gray/RGB/CMYK) and returns {width, height} of the drawn box.
 *  - Extra exports: buildReportPdf, buildQuotePdf, parseJpeg, toWinAnsi, fromWinAnsi, textWidth, wrapText,
 *    base64ToBytes, dataUrlToBytes, slug, formatMoney, formatNumber, formatDate, quoteNumber, exportFilename,
 *    collectImages, HELVETICA_WIDTHS, HELVETICA_BOLD_WIDTHS, and _resetDownloads (tests only).
 *  - describeCords(plan, project) puts the power plan into plain words, cord by cord, grouped by outlet and
 *    supply tree (SPEC §8.2, §8.5). The PDF report and the Power step both read it, so they say the same thing.
 *    gaugeText(awg) → "16-gauge". roughMeasurements(plan, project) lists the Low-confidence items with the range
 *    each could be ("about 38 ft, could be 33 to 44 ft"); the report prints them under the measurements table and
 *    marks the materials cost "rough", and the Review step shows the same list with tape-measure fields.
 *  - Suppliers (SPEC §8.3, §8.5), in plain words and shared by the Design and Review steps and the PDF report:
 *    supplierFacts(library, id) (site, phone, wholesale facts, the free-shipping line when its note has one),
 *    supplierItems(library, id, overrides) (everything on file that can be ordered there), priceStatusLabel(item)
 *    ("as of Nov 11, 2026 · checked" / "… · check price" / "your price" / "typical price"), priceSentence(items)
 *    (the honest sentence about a set of prices), orderUseText(line, library) ("1 spool (1,000 ft): 143 ft used,
 *    857 ft left"), describeBulk(product) (what a cut-to-length product is ordered as), whereToBuy(plan) (one entry
 *    per order sheet) and orderSheetText(entry). exportOrderCsv(store, supplierId) saves one supplier's order sheet.
 *  - The report's materials table shows the supplier and part number of each line, the sentence "Prices were last
 *    checked on ...; confirm at checkout." under it, and a "Where to buy" block per supplier with its site, phone
 *    and every product link. Its heading is "Shopping list" ("Bill of materials" in installer mode). The customer
 *    quote never shows a supplier, a part number or a unit price.
 *  - PdfDoc.link(x, y, w, h, url) makes an area of the page open a web address (https only).
 */
LP.define('ui.export', ['catalog', 'bom', 'schema', 'suppliers'], function (catalog, bomModule, schema, suppliers) {
  'use strict';

  const { FEATURE_TYPES } = catalog;

  // ================================================================ small helpers
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const byId = (list, id) => arr(list).find((x) => isObj(x) && x.id === id) || null;

  /** A module that may be missing (UI modules are looked up lazily so export still loads without them). */
  function optional(name) {
    try {
      return typeof LP !== 'undefined' && LP.has(name) ? LP.require(name) : null;
    } catch (e) {
      return null;
    }
  }

  // ================================================================ fonts: WinAnsi encoding and Helvetica metrics
  /*
   * Widths (1/1000 em) of WinAnsi codes 32..255 for the standard-14 Helvetica and Helvetica-Bold, taken from
   * Adobe's core AFM files. Codes 0x81, 0x8D, 0x8F, 0x90 and 0x9D have no glyph; toWinAnsi never emits them.
   */
  const HELVETICA_WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
    556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
    556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 222, 222, 333, 333, 350, 556, 1000,
    333, 1000, 500, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722,
    667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584,
    611, 556, 556, 556, 556, 500, 556, 500,
  ];
  const HELVETICA_BOLD_WIDTHS = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
    611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350,
    556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, 350, 278, 278, 500, 500, 350, 556, 1000,
    333, 1000, 556, 333, 944, 350, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722,
    667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584,
    611, 611, 611, 611, 611, 556, 611, 556,
  ];

  /** Unicode code points that WinAnsi places in 0x80..0x9F (the rest of 0xA0..0xFF is Latin-1). */
  const WINANSI_HIGH = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
    0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
    0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
    0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };
  const WINANSI_REVERSE = {};
  for (const cp of Object.keys(WINANSI_HIGH)) WINANSI_REVERSE[WINANSI_HIGH[cp]] = String.fromCharCode(Number(cp));
  /** Characters with no WinAnsi glyph, replaced by the closest look-alike ('' drops the character). */
  const LOOKALIKES = {
    0x2032: "'", 0x2033: '"', 0x2010: '-', 0x2011: '-', 0x2012: '-', 0x2212: '-', 0x2015: '\x97',
    0x2002: ' ', 0x2003: ' ', 0x2004: ' ', 0x2005: ' ', 0x2006: ' ', 0x2007: ' ', 0x2008: ' ', 0x2009: ' ', 0x200a: ' ',
    0x202f: ' ', 0x205f: ' ', 0x3000: ' ', 0x200b: '', 0x200c: '', 0x200d: '', 0x2060: '', 0xfeff: '', 0x00ad: '',
    0x2190: '<-', 0x2192: '->', 0x2264: '<=', 0x2265: '>=', 0x2248: '~', 0x2260: '!=', 0x2027: '\xb7', 0x2219: '\xb7',
    0x22c5: '\xb7', 0x2715: '\xd7', 0x2716: '\xd7', 0x2713: 'v', 0x2714: 'v',
  };

  /**
   * Encode text for a WinAnsi font: returns a "byte string" (every char code 0..255). Smart quotes, dashes,
   * bullets, ×, ° and the like keep their glyphs; ′ and ″ become ' and "; tabs and line breaks become spaces;
   * other control characters are dropped; anything else becomes "?".
   */
  function toWinAnsi(text) {
    const s = text === null || text === undefined ? '' : String(text);
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x20 && cp <= 0x7e) out += ch;
      else if (cp >= 0xa0 && cp <= 0xff && cp !== 0xad) out += ch;
      else if (WINANSI_HIGH[cp] !== undefined) out += String.fromCharCode(WINANSI_HIGH[cp]);
      else if (LOOKALIKES[cp] !== undefined) out += LOOKALIKES[cp];
      else if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += ' ';
      else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) out += '';
      else out += '?';
    }
    return out;
  }
  /** Inverse of toWinAnsi for one byte string (bytes 0x80..0x9F back to their Unicode characters). */
  function fromWinAnsi(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes.charCodeAt(i);
      out += c >= 0x80 && c <= 0x9f ? (WINANSI_REVERSE[c] || '?') : bytes[i];
    }
    return out;
  }

  /** Width in points of an already-encoded byte string. */
  function encodedWidth(enc, size, bold) {
    const W = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
    let units = 0;
    for (let i = 0; i < enc.length; i++) {
      const c = enc.charCodeAt(i);
      if (c >= 32 && c <= 255) units += W[c - 32];
    }
    return (units * size) / 1000;
  }
  /** Width in points of `text` set in Helvetica (bold: Helvetica-Bold) at `size` points. No kerning. */
  function textWidth(text, size, bold) {
    return encodedWidth(toWinAnsi(text), isNum(size) ? size : 10, !!bold);
  }

  /** Longest prefix (in chars, at least 1) of an encoded string that fits in maxWidth. */
  function fitChars(enc, size, bold, maxWidth) {
    const W = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
    let units = 0;
    const limit = (maxWidth * 1000) / size;
    for (let i = 0; i < enc.length; i++) {
      const c = enc.charCodeAt(i);
      units += c >= 32 ? W[c - 32] : 0;
      if (units > limit) return Math.max(1, i);
    }
    return enc.length;
  }

  /**
   * Greedy word wrap of an encoded string. Explicit line breaks are kept (the caller splits on them before
   * encoding); runs of spaces collapse; a word wider than the box is broken between characters.
   */
  function wrapEncoded(enc, size, bold, maxWidth) {
    if (!(maxWidth > 0)) return [enc];
    const words = enc.split(' ').filter((w) => w !== '');
    if (!words.length) return [''];
    const lines = [];
    let line = '';
    for (let word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (encodedWidth(candidate, size, bold) <= maxWidth + 1e-9) { line = candidate; continue; }
      if (line) lines.push(line);
      line = '';
      while (encodedWidth(word, size, bold) > maxWidth + 1e-9 && word.length > 1) {
        const n = fitChars(word, size, bold, maxWidth);
        lines.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    lines.push(line);
    return lines;
  }
  /** Encode and wrap `text` into lines of encoded bytes. */
  function wrapToEncoded(text, size, bold, maxWidth) {
    const s = text === null || text === undefined ? '' : String(text);
    const out = [];
    for (const para of s.split(/\r\n|\r|\n/)) out.push(...wrapEncoded(toWinAnsi(para), size, bold, maxWidth));
    return out;
  }
  /** Wrap `text` to lines no wider than maxWidth points (Unicode strings; ′ ″ come back as ' "). */
  function wrapText(text, size, bold, maxWidth) {
    return wrapToEncoded(text, isNum(size) ? size : 10, !!bold, maxWidth).map(fromWinAnsi);
  }

  /** Cut an encoded line so it fits with a trailing ellipsis. */
  function ellipsize(enc, size, bold, maxWidth) {
    const ell = '\x85';
    let s = enc.replace(/\s+$/, '');
    if (!(maxWidth > 0)) return s + ell;
    while (s.length && encodedWidth(s + ell, size, bold) > maxWidth) s = s.slice(0, -1).replace(/\s+$/, '');
    return s + ell;
  }

  // ================================================================ PDF primitives
  const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };
  /** Helvetica ascender and descender (AFM, per 1000 em): used to center glyphs in a line box. */
  const ASCENT = 0.718;
  const DESCENT = 0.207;

  /** A number for a content stream: at most 3 decimals, no exponent, no "-0". */
  function num(v) {
    if (!isNum(v)) return '0';
    const r = Math.round(v * 1000) / 1000;
    if (r === 0) return '0';
    let s = r.toFixed(3);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  /** '#rgb' / '#rrggbb' → "r g b" in 0..1, or null when it is not a color. */
  function rgb(color) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof color === 'string' ? color.trim() : '');
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return c.map(num).join(' ');
  }
  /** PDF literal string body: escape ( ) \ and write non-printable bytes as octal, so the file stays ASCII. */
  function pdfString(bytes) {
    let out = '(';
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes.charCodeAt(i) & 0xff;
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + bytes[i];
      else if (c < 0x20 || c > 0x7e) out += '\\' + ('00' + c.toString(8)).slice(-3);
      else out += bytes[i];
    }
    return out + ')';
  }
  /** A PDF text string for /Info: plain ASCII as a literal, anything else as UTF-16BE hex with a BOM. */
  function pdfTextString(text) {
    const s = String(text === null || text === undefined ? '' : text);
    if (/^[\x20-\x7e]*$/.test(s)) return pdfString(s);
    let hex = '<FEFF';
    for (let i = 0; i < s.length; i++) hex += ('000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
    return hex + '>';
  }
  function asciiBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  function pdfDate(d) {
    const p = (n, w) => ('000' + n).slice(-(w || 2));
    return 'D:' + p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  }
  /** 128-bit FNV-1a style digest (hex) for the trailer /ID. Not cryptographic; only needs to be stable. */
  function digestHex(chunks) {
    const lanes = [0x811c9dc5, 0x01000193 ^ 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        for (let k = 0; k < 4; k++) lanes[k] = Math.imul(lanes[k] ^ (chunk[i] + k), 0x01000193) >>> 0;
      }
    }
    return lanes.map((v) => ('0000000' + v.toString(16)).slice(-8)).join('').toUpperCase();
  }

  // ================================================================ bytes: base64, data URLs
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_INDEX = (() => {
    const t = new Int16Array(256).fill(-1);
    for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
    t['-'.charCodeAt(0)] = 62; // URL-safe alphabet
    t['_'.charCodeAt(0)] = 63;
    return t;
  })();
  /** Decode base64 (standard or URL-safe; whitespace and padding ignored). Invalid characters are skipped. */
  function base64ToBytes(b64) {
    const s = String(b64 || '');
    const out = new Uint8Array(Math.floor((s.length * 3) / 4) + 3);
    let n = 0, acc = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B64_INDEX[s.charCodeAt(i) & 0xff];
      if (v < 0 || s.charCodeAt(i) > 0xff) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (acc >> bits) & 0xff;
      }
    }
    return out.slice(0, n);
  }
  /** Bytes of a base64 data URL ("data:image/jpeg;base64,..."), or null when it is not one. */
  function dataUrlToBytes(url) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*?);base64,/i.exec(typeof url === 'string' ? url.slice(0, 200) : '');
    if (!m) return null;
    return base64ToBytes(url.slice(m[0].length));
  }
  /** Uint8Array view of bytes given as Uint8Array, ArrayBuffer, another typed array, or a data URL. */
  function toBytes(src) {
    if (src instanceof Uint8Array) return src;
    if (typeof ArrayBuffer !== 'undefined') {
      if (src instanceof ArrayBuffer) return new Uint8Array(src);
      if (ArrayBuffer.isView && ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    }
    if (typeof src === 'string') return dataUrlToBytes(src);
    return null;
  }

  // ================================================================ JPEG
  /** SOF markers PDF readers decode with DCTDecode: baseline, extended sequential and progressive Huffman. */
  const SOF_OK = { 0xc0: 'baseline', 0xc1: 'extended', 0xc2: 'progressive' };
  /** SOF markers for JPEG flavors PDF readers do not reliably decode (lossless, hierarchical, arithmetic). */
  const SOF_OTHER = [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

  /**
   * Read the frame header of a JPEG. Returns {width, height, components, bitsPerComponent, colorSpace, adobe,
   * progressive} or null when the bytes are not a JPEG that can go into a PDF as-is.
   * Adobe CMYK JPEGs (APP14 "Adobe") store inverted ink values, so they need /Decode [1 0 1 0 1 0 1 0].
   */
  function parseJpeg(src) {
    const b = toBytes(src);
    if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let pos = 2;
    let adobe = false;
    while (pos + 4 <= b.length) {
      if (b[pos] !== 0xff) return null; // lost sync: not a well-formed marker sequence
      while (pos < b.length && b[pos] === 0xff) pos++; // fill bytes
      if (pos >= b.length) return null;
      const marker = b[pos++];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length field
      if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any frame header
      if (pos + 2 > b.length) return null;
      const len = (b[pos] << 8) | b[pos + 1];
      if (len < 2 || pos + len > b.length) return null;
      if (marker === 0xee && len >= 14 && String.fromCharCode(b[pos + 2], b[pos + 3], b[pos + 4], b[pos + 5], b[pos + 6]) === 'Adobe') {
        adobe = true;
      }
      if (SOF_OK[marker] !== undefined) {
        if (len < 8) return null;
        const bits = b[pos + 2];
        const height = (b[pos + 3] << 8) | b[pos + 4];
        const width = (b[pos + 5] << 8) | b[pos + 6];
        const components = b[pos + 7];
        const colorSpace = components === 1 ? 'DeviceGray' : components === 3 ? 'DeviceRGB' : components === 4 ? 'DeviceCMYK' : null;
        if (bits !== 8 || !width || !height || !colorSpace) return null;
        // An APP14 segment after the frame header still counts: keep scanning for it, up to the first scan.
        let p2 = pos + len;
        while (!adobe && p2 + 4 <= b.length && b[p2] === 0xff) {
          const m2 = b[p2 + 1];
          if (m2 === 0xda || m2 === 0xd9) break;
          const l2 = (b[p2 + 2] << 8) | b[p2 + 3];
          if (l2 < 2) break;
          if (m2 === 0xee && l2 >= 14 && String.fromCharCode(b[p2 + 4], b[p2 + 5], b[p2 + 6], b[p2 + 7], b[p2 + 8]) === 'Adobe') adobe = true;
          p2 += 2 + l2;
        }
        return { width, height, components, bitsPerComponent: 8, colorSpace, adobe, progressive: marker === 0xc2 };
      }
      if (SOF_OTHER.indexOf(marker) >= 0) return null;
      pos += len;
    }
    return null;
  }

  // ================================================================ PdfDoc
  /**
   * Minimal PDF writer. Coordinates are points (1/72 in) from the TOP-left corner of the page.
   *   const doc = new PdfDoc({size: 'letter', title: 'Report'});
   *   doc.addPage(); doc.text('Hello', 40, 40, {size: 12, bold: true}); const bytes = doc.toBytes();
   */
  class PdfDoc {
    constructor(opts) {
      const o = isObj(opts) ? opts : {};
      const size = Array.isArray(o.size) && isNum(o.size[0]) && isNum(o.size[1]) ? o.size : PAGE_SIZES[o.size] || PAGE_SIZES.letter;
      this.width = size[0];
      this.height = size[1];
      this.info = {
        title: typeof o.title === 'string' ? o.title : '',
        author: typeof o.author === 'string' ? o.author : '',
        subject: typeof o.subject === 'string' ? o.subject : '',
        creationDate: o.creationDate instanceof Date && isNum(o.creationDate.getTime()) ? o.creationDate : null,
      };
      this.pages = [];
      this.current = -1;
      this.images = []; // [{name, bytes, info}]
      this.imageCache = new Map(); // source object → image record (the same photo twice is stored once)
    }

    get pageCount() { return this.pages.length; }

    /** Start a new page and make it current. Returns its index. */
    addPage() {
      this.pages.push({ ops: [], images: new Set(), links: [] });
      this.current = this.pages.length - 1;
      return this.current;
    }
    /** Make an existing page current (e.g. to draw footers once the page count is known). */
    setPage(index) {
      if (Number.isInteger(index) && index >= 0 && index < this.pages.length) this.current = index;
      return this.current;
    }
    page() {
      if (this.current < 0) this.addPage();
      return this.pages[this.current];
    }
    flipY(y) { return this.height - y; }

    textWidth(text, size, bold) { return textWidth(text, size, bold); }
    wrapText(text, size, bold, maxWidth) { return wrapText(text, size, bold, maxWidth); }

    /**
     * Draw text. y is the top of the first line box (line box = size × lineHeight; glyphs centered in it).
     * opts: size (10), bold, color ('#000000'), align ('left'|'right'|'center'), maxWidth (wrap), lineHeight (1.2),
     * maxLines (cut with an ellipsis). Returns {lines, width, height}.
     */
    text(text, x, y, opts) {
      const o = isObj(opts) ? opts : {};
      const size = isNum(o.size) && o.size > 0 ? o.size : 10;
      const bold = !!o.bold;
      const lh = (isNum(o.lineHeight) && o.lineHeight > 0 ? o.lineHeight : 1.2) * size;
      const maxWidth = isNum(o.maxWidth) && o.maxWidth > 0 ? o.maxWidth : null;
      let lines = wrapToEncoded(text, size, bold, maxWidth);
      if (Number.isInteger(o.maxLines) && o.maxLines > 0 && lines.length > o.maxLines) {
        lines = lines.slice(0, o.maxLines);
        lines[lines.length - 1] = ellipsize(lines[lines.length - 1], size, bold, maxWidth);
      }
      const color = rgb(o.color) || '0 0 0';
      const font = bold ? '/F2' : '/F1';
      const baseline = (lh - (ASCENT + DESCENT) * size) / 2 + ASCENT * size;
      const ops = this.page().ops;
      let widest = 0;
      lines.forEach((line, i) => {
        const w = encodedWidth(line, size, bold);
        widest = Math.max(widest, w);
        if (!line) return;
        let lx = isNum(x) ? x : 0;
        if (o.align === 'right') lx = maxWidth ? lx + maxWidth - w : lx - w;
        else if (o.align === 'center') lx = maxWidth ? lx + (maxWidth - w) / 2 : lx - w / 2;
        const by = this.flipY((isNum(y) ? y : 0) + i * lh + baseline);
        ops.push('BT ' + font + ' ' + num(size) + ' Tf ' + color + ' rg ' + num(lx) + ' ' + num(by) + ' Td ' + pdfString(line) + ' Tj ET');
      });
      return { lines: lines.length, width: widest, height: lines.length * lh };
    }

    /** Straight line. opts: width (1), color ('#000000'), dash ([on, off] in points). */
    line(x1, y1, x2, y2, opts) {
      const o = isObj(opts) ? opts : {};
      const w = isNum(o.width) && o.width >= 0 ? o.width : 1;
      const dash = Array.isArray(o.dash) && o.dash.every(isNum) ? '[' + o.dash.map(num).join(' ') + '] 0 d ' : '';
      this.page().ops.push('q ' + num(w) + ' w ' + dash + (rgb(o.color) || '0 0 0') + ' RG ' +
        num(x1) + ' ' + num(this.flipY(y1)) + ' m ' + num(x2) + ' ' + num(this.flipY(y2)) + ' l S Q');
    }

    /** Rectangle with its top-left corner at (x, y). opts: fill, stroke ('#hex'), width (stroke, 1), radius. */
    rect(x, y, w, h, opts) {
      const o = isObj(opts) ? opts : {};
      const fill = rgb(o.fill);
      let stroke = rgb(o.stroke);
      if (!fill && !stroke) stroke = '0 0 0';
      const lw = isNum(o.width) && o.width >= 0 ? o.width : 1;
      const X = isNum(x) ? x : 0, W = isNum(w) ? w : 0, H = isNum(h) ? h : 0;
      const Y = this.flipY((isNum(y) ? y : 0) + H); // PDF: bottom-left corner
      const r = isNum(o.radius) ? Math.max(0, Math.min(o.radius, Math.abs(W) / 2, Math.abs(H) / 2)) : 0;
      let path;
      if (r > 0) {
        // Quarter circles as cubic Béziers: control points at k·r from each corner (k = 4(√2 − 1)/3).
        const k = 0.5523 * r;
        const x0 = X, x1 = X + W, y0 = Y, y1 = Y + H;
        path = [
          num(x0 + r) + ' ' + num(y0) + ' m',
          num(x1 - r) + ' ' + num(y0) + ' l',
          num(x1 - r + k) + ' ' + num(y0) + ' ' + num(x1) + ' ' + num(y0 + r - k) + ' ' + num(x1) + ' ' + num(y0 + r) + ' c',
          num(x1) + ' ' + num(y1 - r) + ' l',
          num(x1) + ' ' + num(y1 - r + k) + ' ' + num(x1 - r + k) + ' ' + num(y1) + ' ' + num(x1 - r) + ' ' + num(y1) + ' c',
          num(x0 + r) + ' ' + num(y1) + ' l',
          num(x0 + r - k) + ' ' + num(y1) + ' ' + num(x0) + ' ' + num(y1 - r + k) + ' ' + num(x0) + ' ' + num(y1 - r) + ' c',
          num(x0) + ' ' + num(y0 + r) + ' l',
          num(x0) + ' ' + num(y0 + r - k) + ' ' + num(x0 + r - k) + ' ' + num(y0) + ' ' + num(x0 + r) + ' ' + num(y0) + ' c',
          'h',
        ].join(' ');
      } else {
        path = num(X) + ' ' + num(Y) + ' ' + num(W) + ' ' + num(H) + ' re';
      }
      const paint = fill && stroke ? 'B' : fill ? 'f' : 'S';
      this.page().ops.push('q ' + (fill ? fill + ' rg ' : '') + (stroke ? stroke + ' RG ' + num(lw) + ' w ' : '') + path + ' ' + paint + ' Q');
    }

    /**
     * Place a JPEG (bytes or a base64 data URL) with its top-left corner at (x, y). Give w and h in points; with
     * only one of them the other follows the picture's aspect; with neither it is drawn at 72 dpi.
     * Throws a plain Error when the picture is not a JPEG that can go into a PDF.
     */
    image(src, x, y, w, h) {
      let rec = (src && (typeof src === 'object' || typeof src === 'string')) ? this.imageCache.get(src) : null;
      if (!rec) {
        const bytes = toBytes(src);
        const info = bytes ? parseJpeg(bytes) : null;
        if (!info) throw new Error('This picture cannot go into the PDF. Only JPEG photos can be added.');
        rec = { name: 'Im' + (this.images.length + 1), bytes, info };
        this.images.push(rec);
        if (src && (typeof src === 'object' || typeof src === 'string')) this.imageCache.set(src, rec);
      }
      const aspect = rec.info.height / rec.info.width;
      let W = isNum(w) && w > 0 ? w : null;
      let H = isNum(h) && h > 0 ? h : null;
      if (W === null && H === null) { W = rec.info.width; H = rec.info.height; }
      else if (W === null) W = H / aspect;
      else if (H === null) H = W * aspect;
      const pg = this.page();
      pg.images.add(rec);
      pg.ops.push('q ' + num(W) + ' 0 0 ' + num(H) + ' ' + num(isNum(x) ? x : 0) + ' ' + num(this.flipY((isNum(y) ? y : 0) + H)) + ' cm /' + rec.name + ' Do Q');
      return { width: W, height: H };
    }

    /**
     * Make the box with its top-left corner at (x, y) open a web address when it is clicked. Only plain https
     * addresses in printable ASCII are accepted; anything else is ignored (returns false).
     */
    link(x, y, w, h, url) {
      const u = suppliers.safeUrl(url);
      if (!u || !/^[\x21-\x7e]+$/.test(u) || !(isNum(x) && isNum(y) && w > 0 && h > 0)) return false;
      this.page().links.push({ x, y, w, h, url: u });
      return true;
    }

    /** The finished PDF file. */
    toBytes() {
      if (!this.pages.length) this.addPage();
      const chunks = [];
      let offset = 0;
      const offsets = []; // object number → byte offset of "n 0 obj"
      const push = (u8) => { chunks.push(u8); offset += u8.length; };
      const write = (s) => push(asciiBytes(s));
      const startObj = (n) => { offsets[n] = offset; write(n + ' 0 obj\n'); };

      // Object numbers: 1 catalog, 2 page tree, 3-4 fonts, then images, then page + content pairs, then /Info.
      const imgBase = 5;
      const pageBase = imgBase + this.images.length;
      const infoNum = pageBase + this.pages.length * 2;
      const imageNum = new Map(this.images.map((im, i) => [im, imgBase + i]));

      write('%PDF-1.4\n');
      push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment, per the PDF spec

      startObj(1);
      write('<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>\nendobj\n');
      startObj(2);
      const kids = this.pages.map((p, i) => (pageBase + i * 2) + ' 0 R').join(' ');
      write('<< /Type /Pages /Kids [' + kids + '] /Count ' + this.pages.length + ' >>\nendobj\n');
      startObj(3);
      write('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
      startObj(4);
      write('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');

      this.images.forEach((im, i) => {
        const inf = im.info;
        const decode = inf.colorSpace === 'DeviceCMYK' && inf.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
        startObj(imgBase + i);
        write('<< /Type /XObject /Subtype /Image /Width ' + inf.width + ' /Height ' + inf.height +
          ' /ColorSpace /' + inf.colorSpace + ' /BitsPerComponent 8 /Filter /DCTDecode' + decode +
          ' /Length ' + im.bytes.length + ' >>\nstream\n');
        push(im.bytes);
        write('\nendstream\nendobj\n');
      });

      this.pages.forEach((pg, i) => {
        const pageNum = pageBase + i * 2;
        const xobjects = Array.from(pg.images).map((im) => '/' + im.name + ' ' + imageNum.get(im) + ' 0 R').join(' ');
        // Link areas: annotation dictionaries written straight into the page (no border, a URI action each).
        const annots = arr(pg.links).map((a) => '<< /Type /Annot /Subtype /Link /Rect [' + num(a.x) + ' ' + num(this.flipY(a.y + a.h)) + ' ' +
          num(a.x + a.w) + ' ' + num(this.flipY(a.y)) + '] /Border [0 0 0] /A << /S /URI /URI ' + pdfString(a.url) + ' >> >>').join(' ');
        startObj(pageNum);
        write('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(this.width) + ' ' + num(this.height) + ']' +
          ' /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + (xobjects ? ' /XObject << ' + xobjects + ' >>' : '') +
          ' /ProcSet [/PDF /Text /ImageB /ImageC] >>' + (annots ? ' /Annots [' + annots + ']' : '') +
          ' /Contents ' + (pageNum + 1) + ' 0 R >>\nendobj\n');
        const content = asciiBytes(pg.ops.join('\n'));
        startObj(pageNum + 1);
        write('<< /Length ' + content.length + ' >>\nstream\n');
        push(content);
        write('\nendstream\nendobj\n');
      });

      startObj(infoNum);
      const info = ['/Producer (LightPlan)', '/Creator (LightPlan)'];
      if (this.info.title) info.unshift('/Title ' + pdfTextString(this.info.title));
      if (this.info.author) info.push('/Author ' + pdfTextString(this.info.author));
      if (this.info.subject) info.push('/Subject ' + pdfTextString(this.info.subject));
      if (this.info.creationDate) info.push('/CreationDate (' + pdfDate(this.info.creationDate) + ')');
      write('<< ' + info.join(' ') + ' >>\nendobj\n');

      // Cross-reference table: one 20-byte entry per object ("oooooooooo ggggg n \n").
      const xrefAt = offset;
      const size = infoNum + 1;
      let xref = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
      for (let n = 1; n < size; n++) xref += ('000000000' + offsets[n]).slice(-10) + ' 00000 n \n';
      const id = digestHex(chunks);
      write(xref + 'trailer\n<< /Size ' + size + ' /Root 1 0 R /Info ' + infoNum + ' 0 R /ID [<' + id + '> <' + id + '>] >>\n' +
        'startxref\n' + xrefAt + '\n%%EOF\n');

      const out = new Uint8Array(offset);
      let p = 0;
      for (const c of chunks) { out.set(c, p); p += c.length; }
      return out;
    }
  }

  // ================================================================ formatting
  function groupInt(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** "1,234" / "1,234.50": fixed decimals with thousands separators; "—" when not a number. */
  function formatNumber(v, decimals) {
    if (!isNum(v)) return '—';
    const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 0;
    const fixed = (Math.round(Number((Math.abs(v) * Math.pow(10, d)).toPrecision(12))) / Math.pow(10, d)).toFixed(d);
    const parts = fixed.split('.');
    return (v < 0 && Number(fixed) !== 0 ? '-' : '') + groupInt(parts[0]) + (parts[1] ? '.' + parts[1] : '');
  }
  /** "$1,234.50" / "-$5.00"; "—" when not a number. Rounded to cents. */
  function formatMoney(v) {
    if (!isNum(v)) return '—';
    const s = formatNumber(Math.abs(v), 2);
    return (v < 0 && s !== '0.00' ? '-$' : '$') + s;
  }
  const watts = (v) => formatNumber(v, isNum(v) && Math.abs(v) < 100 && Math.abs(v - Math.round(v)) >= 0.05 ? 1 : 0) + ' W';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function toDate(v) {
    if (v instanceof Date) return isNum(v.getTime()) ? v : null;
    if (typeof v === 'string' && v) {
      const d = new Date(v);
      return isNum(d.getTime()) ? d : null;
    }
    return null;
  }
  /** "November 9, 2026" (local calendar date); '' for a missing or invalid date. */
  function formatDate(v) {
    const d = toDate(v);
    return d ? MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() : '';
  }
  function addDays(d, n) {
    const c = new Date(d.getTime());
    c.setDate(c.getDate() + n);
    return c;
  }
  /** File-name-safe slug: "123 Maple St." → "123-maple-st"; "project" when nothing usable is left. */
  function slug(name) {
    let s = String(name === null || name === undefined ? '' : name);
    try { s = s.normalize('NFKD'); } catch (e) { /* very old engines: keep as is */ }
    s = s.replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, '');
    return s || 'project';
  }
  /** lightplan-<slug>-report.pdf | -quote.pdf | -bom.csv | -project.json */
  function exportFilename(project, kind) {
    const suffix = { report: 'report.pdf', quote: 'quote.pdf', csv: 'bom.csv', bom: 'bom.csv', json: 'project.json', project: 'project.json' }[kind] || String(kind || 'file');
    return 'lightplan-' + slug(isObj(project) ? project.name : '') + '-' + suffix;
  }
  /** Quote number from the project id: "prj_ab12cd" → "Q-AB12CD". */
  function quoteNumber(project) {
    const id = isObj(project) && typeof project.id === 'string' ? project.id : '';
    const core = id.replace(/^prj_/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12);
    return core ? 'Q-' + core : 'Q-DRAFT';
  }
  function plural(n, one, many) { return formatNumber(n, 0) + ' ' + (n === 1 ? one : many); }
  const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'], pack: ['pack', 'packs'], spool: ['spool', 'spools'], each: ['', ''] };
  function qtyText(qty, unit) {
    if (!isNum(qty)) return '—';
    const w = UNIT_WORDS[unit] || ['', ''];
    const word = Math.abs(qty - 1) < 1e-9 ? w[0] : w[1];
    return formatNumber(qty, unit === 'foot' && !Number.isInteger(qty) ? 1 : Number.isInteger(qty) ? 0 : 2) + (word ? ' ' + word : '');
  }
  /** Length formatter for a project (ft-in or ft-decimal), via measure.formatLength when it is loaded. */
  function lengthFormatter(project) {
    const fmt = isObj(project) && isObj(project.settings) && project.settings.lengthFormat === 'ft-decimal' ? 'ft-decimal' : 'ft-in';
    const measure = optional('measure');
    return (ft) => {
      if (!isNum(ft)) return '—';
      if (measure && typeof measure.formatLength === 'function') {
        try { return measure.formatLength(ft, fmt); } catch (e) { /* fall through to the local format */ }
      }
      if (fmt === 'ft-decimal') return (Math.round(ft * 10) / 10).toFixed(1) + ' ft';
      const inches = Math.round(Math.abs(ft) * 12);
      return (ft < 0 && inches ? '-' : '') + Math.floor(inches / 12) + '′ ' + (inches % 12) + '″';
    };
  }

  // ================================================================ plan access (tolerates partial plans)
  /** The parts of a plan the documents use, each with a safe default. */
  function planParts(plan) {
    const p = isObj(plan) ? plan : {};
    const measured = isObj(p.measured) ? p.measured : {};
    const power = isObj(p.power) ? p.power : {};
    const bom = isObj(p.bom) ? p.bom : {};
    return {
      plan: p,
      runs: arr(p.runs).filter(isObj),
      measuredFeatures: isObj(measured.features) ? measured.features : {},
      totals: isObj(measured.totals) ? measured.totals : {},
      power: {
        feeds: arr(power.feeds).filter(isObj),
        outlets: arr(power.outlets).filter(isObj),
        circuits: arr(power.circuits).filter(isObj),
        cords: arr(power.cords).filter(isObj),
        counts: isObj(power.counts) ? power.counts : {},
        totals: isObj(power.totals) ? power.totals : {},
        warnings: arr(power.warnings).filter(isObj),
      },
      bom: { lines: arr(bom.lines).filter(isObj), subtotal: isNum(bom.subtotal) ? bom.subtotal : null },
      quote: isObj(p.quote) ? p.quote : {},
      checklist: arr(p.checklist).filter(isObj),
      warnings: arr(p.warnings).filter(isObj),
      summary: isObj(p.summary) ? p.summary : {},
      config: isObj(p.library) && isObj(p.library.config) ? p.library.config : catalog.DEFAULT_CONFIG,
    };
  }

  // ================================================================ cords in plain words (PDF report and Power step)
  /** "16-gauge": how a cord's thickness is said to a homeowner. The trade name (16 AWG) is kept for detail lines. */
  function gaugeText(awg) { return isNum(awg) ? formatNumber(awg, 0) + '-gauge' : ''; }
  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /**
   * The power plan in the order it is put up, in plain words. One row per feed (the lights on one cord): a cord
   * from an outlet, a jumper cord from one run to the next, or a run that plugs straight in. Rows are grouped by
   * outlet and, under each outlet, by supply tree (the cord from the outlet first, then everything hanging off it,
   * depth-first, as plan.power.groups lists them). Pure; tolerates partial plans.
   *
   * → { outlets: [{ id, label, cords (cords plugged into the outlet), runs (light runs it powers), feeds, watts,
   *                 splitters, trees: [[row, …]] }],
   *     loose: [row] (lights with no outlet yet), rows: [row] (everything, same order) }
   * row = { feedId, outletId, depth, kind: 'home' | 'jumper' | 'plugIn' | 'unknown' | 'none',
   *         names: [run labels; 'Eave 1, left part' when a run is on more than one cord], lights: 'Front eave, Ridge',
   *         featureIds, ownCord,
   *         what: '25 ft cord' | '6 ft jumper cord' | 'Plugs straight in' | 'Cord length unknown' | 'No outlet yet',
   *         source: 'Porch outlet' | 'the end of Front door' | 'the 3-way tap at the start of Walkway left edge' |
   *                 'the 3-way tap 19 ft from the left end of Eave 1' (a run fed from its middle) | '',
   *         line: what + where it comes from, as one sentence part ('6 ft jumper cord from the end of Front door'),
   *         route: cord.routeText | '', startLabel, pieces, boughtFt, neededFt (rounded up), awg, gauge: '16-gauge',
   *         dropPct, pathDropPct, watts (its own lights), carriesW (everything on its cord), strings, unit, taps,
   *         tapText: '' | '3-way tap at its start' | …, cover (needs a cord cover), doorway }
   */
  function describeCords(plan, project) {
    const p = isObj(plan) ? plan : {};
    const power = isObj(p.power) ? p.power : {};
    const prj = isObj(project) ? project : {};
    const feeds = arr(power.feeds).filter(isObj);
    const feedById = new Map(feeds.map((f) => [f.id, f]));
    const runById = new Map(arr(p.runs).filter(isObj).map((r) => [r.id, r]));
    const featureById = new Map(arr(prj.features).filter(isObj).map((f) => [f.id, f]));
    const outletLabel = (id) => { const o = byId(prj.outlets, id) || byId(power.outlets, id); return o ? str(o.label) || 'Outlet' : null; };
    const runsOf = (f) => arr(f.runIds).map((id) => runById.get(id)).filter(Boolean);
    // A run that is on more than one cord (fed from its middle, or longer than one cord may feed) has a row per
    // part: "Eave 1, left part" and "Eave 1, right part" (the end each part runs to), or "part 1 of 3".
    const feedsOfRun = new Map();
    for (const f of feeds) for (const id of arr(f.runIds)) { if (!feedsOfRun.has(id)) feedsOfRun.set(id, []); feedsOfRun.get(id).push(f); }
    const sideOf = (f) => {
      const st = isObj(f.start) ? f.start : {};
      const toward = /^(left|right|top|bottom) end of /.exec(str(st.toward));
      if (toward) return toward[1];
      // Starts at an end of the run and works away from it.
      const from = /^(left|right|top|bottom) end of /.exec(str(st.label));
      return from ? { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[from[1]] : null;
    };
    const partName = (f, run) => {
      const label = str(run.label);
      const sharing = feedsOfRun.get(run.id) || [];
      if (!label || sharing.length < 2) return label;
      if (sharing.length === 2) {
        const sides = sharing.map(sideOf);
        if (sides[0] && sides[1] && sides[0] !== sides[1]) return label + ', ' + sideOf(f) + ' part';
      }
      return label + ', part ' + (sharing.indexOf(f) + 1) + ' of ' + sharing.length;
    };
    const namesOf = (f) => runsOf(f).map((r) => partName(f, r)).filter(Boolean);
    /** "the 3-way tap 19 ft from the left end of Eave 1" for a cord that arrives part-way along a run. */
    const tapPlace = (parent, pn) => {
      const mid = /^point (.+)$/.exec(isObj(parent.start) ? str(parent.start.label) : '');
      return mid ? 'the 3-way tap ' + mid[1] : 'the 3-way tap at the start of ' + (pn[0] || 'the run before it');
    };

    const makeRow = (f) => {
      const fruns = runsOf(f);
      const names = namesOf(f);
      const src = isObj(f.source) ? f.source : null;
      const parent = src && src.kind === 'feed' ? feedById.get(src.feedId) || null : null;
      const pn = parent ? namesOf(parent) : [];
      const cord = isObj(f.cord) ? f.cord : null;
      let kind;
      if (!f.outletId && !src) kind = 'none';
      else if (f.plugIn === true) kind = 'plugIn';
      else if (cord) kind = cord.kind === 'jumper' || (src && src.kind === 'feed') ? 'jumper' : 'home';
      else kind = 'unknown';
      let source = '';
      if (parent) source = src.port === 'start' ? tapPlace(parent, pn) : 'the end of ' + (pn[pn.length - 1] || 'the run before it');
      else if (f.outletId || (src && src.kind === 'outlet')) source = outletLabel(src && src.outletId ? src.outletId : f.outletId) || 'the outlet';
      const pieces = cord ? arr(cord.pieces).filter(isNum) : [];
      const length = pieces.length ? pieces.map((x) => formatNumber(x, 0) + ' ft').join(' + ')
        : cord && isNum(cord.lengthFt) ? formatNumber(Math.ceil(cord.lengthFt), 0) + ' ft' : '';
      let what;
      let line;
      if (kind === 'home') { what = length + ' cord'; line = what + ' from ' + source; }
      else if (kind === 'jumper') { what = length + ' jumper cord'; line = what + ' from ' + source; }
      else if (kind === 'plugIn') { what = 'Plugs straight in'; line = 'Plugs straight into ' + (source || 'the run before it') + ' (no cord needed)'; }
      else if (kind === 'unknown') { what = 'Cord length unknown'; line = 'Cord from ' + (source || 'the outlet') + ': length unknown (set the scale of its wall in step 2)'; }
      else { what = 'No outlet yet'; line = 'No outlet yet'; }
      const kids = feeds.filter((c) => isObj(c.source) && c.source.kind === 'feed' && c.source.feedId === f.id);
      const atStart = kids.some((c) => c.source.port === 'start');
      const atEnd = kids.filter((c) => c.source.port === 'end').length > 1;
      const taps = isNum(f.taps) && f.taps > 0 ? f.taps : 0;
      const tapWhere = atStart && atEnd ? 'its start and its end' : atEnd ? 'its end' : 'its start';
      const units = Array.from(new Set(fruns.map((r) => r.unit)));
      const featureIds = fruns.map((r) => r.featureId).filter(Boolean);
      return {
        feedId: f.id, outletId: f.outletId || null, depth: isNum(f.depth) ? f.depth : 0, kind,
        names, lights: names.join(', ') || 'Lights', featureIds,
        ownCord: featureIds.some((id) => { const ft = featureById.get(id); return !!(ft && isObj(ft.params) && ft.params.ownCord === true); }),
        what, source, line, route: cord ? str(cord.routeText) : '', startLabel: isObj(f.start) ? str(f.start.label) : '',
        pieces, boughtFt: cord && isNum(cord.boughtFt) ? cord.boughtFt : null,
        neededFt: cord && isNum(cord.lengthFt) ? Math.ceil(cord.lengthFt) : null,
        awg: cord && isNum(cord.awg) ? cord.awg : null, gauge: cord ? gaugeText(cord.awg) : '',
        dropPct: cord && isNum(cord.voltageDropPct) ? cord.voltageDropPct : null,
        pathDropPct: isNum(f.pathDropPct) ? f.pathDropPct : null,
        watts: isNum(f.watts) ? f.watts : 0, carriesW: isNum(f.supplyW) ? f.supplyW : isNum(f.watts) ? f.watts : 0,
        strings: isNum(f.strings) ? f.strings : null, unit: units.length === 1 ? units[0] : null,
        taps, tapText: taps ? (taps === 1 ? '3-way tap' : formatNumber(taps, 0) + ' 3-way taps') + ' at ' + tapWhere : '',
        cover: !!f.crossesWalkway, doorway: f.crossesDoorway ? str(f.doorway) || 'a doorway' : '',
        cordOk: !(cord && cord.ok === false),
      };
    };

    const rows = [];
    const seen = new Set();
    const groups = arr(power.groups).filter(isObj);
    const outlets = [];
    for (const o of arr(power.outlets).filter(isObj)) {
      const trees = [];
      for (const g of groups) {
        if (g.outletId !== o.id) continue;
        const tree = [];
        for (const id of arr(g.feedIds)) {
          const f = feedById.get(id);
          if (!f || seen.has(id)) continue;
          seen.add(id);
          tree.push(makeRow(f));
        }
        if (tree.length) trees.push(tree);
      }
      // Feeds on this outlet that no supply tree lists (plans made before supply trees): one tree each.
      for (const f of feeds) {
        if (f.outletId !== o.id || seen.has(f.id)) continue;
        seen.add(f.id);
        trees.push([makeRow(f)]);
      }
      const all = trees.reduce((a, t) => a.concat(t), []);
      rows.push(...all);
      const runIds = new Set();
      for (const id of arr(o.feedIds)) { const f = feedById.get(id); if (f) arr(f.runIds).forEach((r) => runIds.add(r)); }
      outlets.push({
        id: o.id, label: str(o.label) || outletLabel(o.id) || 'Outlet',
        cords: Array.isArray(o.directFeedIds) ? o.directFeedIds.length : all.filter((r) => r.kind === 'home').length,
        runs: runIds.size, feeds: arr(o.feedIds).length, watts: isNum(o.watts) ? o.watts : 0,
        splitters: isNum(o.splitters) ? o.splitters : 0, trees,
      });
    }
    const loose = feeds.filter((f) => !seen.has(f.id)).map(makeRow);
    rows.push(...loose);
    return { outlets, loose, rows };
  }

  // ================================================================ measurements worth a tape measure
  const ROUGH_MEDIUM_PCT = 6;   // a Medium item is listed too when its expected error is above this
  /** Feet for a rough length: whole feet from 10 ft up, half feet below ("38 ft", "6.5 ft"). */
  function roughFeet(ft) {
    if (!isNum(ft)) return '?';
    const v = Math.abs(ft) >= 10 ? Math.round(ft) : Math.round(ft * 2) / 2;
    return formatNumber(v, Number.isInteger(v) ? 0 : 1) + ' ft';
  }
  /**
   * The traced items whose size should be checked with a tape before buying: every item rated Low and every
   * Medium item whose expected error is above 6%. Items that already use a tape-measured size are left out; a
   * bush has two sizes, so it stays on the list until both its width and its height are tape-measured
   * (taped: 'width' | 'height' says which one is done).
   * → [{ featureId, label, type, level, kind: 'length' | 'height' | 'bush', pct (expected error, % or null),
   *      lengthFt, lowFt, highFt, widthFt, heightFt, lights, taped,
   *      text: 'about 38 ft, could be 33 to 44 ft' }]   (text never claims more precision than the photo gives)
   */
  function roughMeasurements(plan, project) {
    const p = isObj(plan) ? plan : {};
    const measured = isObj(p.measured) && isObj(p.measured.features) ? p.measured.features : {};
    const out = [];
    for (const f of arr(isObj(project) ? project.features : null)) {
      if (!isObj(f)) continue;
      const m = measured[f.id];
      if (!isObj(m) || m.ok === false) continue;
      // A bush with only one of its two sizes typed is half checked: it stays, with the typed size in its field.
      const params = isObj(f.params) ? f.params : {};
      const tapedW = f.type === 'bush' && isNum(params.overrideWidthFt) && params.overrideWidthFt > 0;
      const tapedH = f.type === 'bush' && isNum(params.overrideHeightFt) && params.overrideHeightFt > 0;
      const half = tapedW !== tapedH;
      if (m.overridden && !half) continue;
      const level = isObj(m.confidence) ? m.confidence.level : null;
      const pct = isNum(m.uncertaintyPct) && m.uncertaintyPct >= 0 ? m.uncertaintyPct : m.uncertaintyPct === Infinity ? Infinity : null;
      if (!(level === 'low' || (level === 'medium' && pct !== null && pct > ROUGH_MEDIUM_PCT))) continue;
      const t = FEATURE_TYPES[f.type];
      const label = str(f.label) || (t ? t.label : 'Item');
      const item = { featureId: f.id, label, type: f.type, level, pct, kind: 'length', lengthFt: null, lowFt: null, highFt: null,
        widthFt: null, heightFt: null, lights: isNum(m.lights) ? m.lights : null, taped: half ? (tapedW ? 'width' : 'height') : null, text: '' };
      const offBy = pct !== null && pct !== Infinity ? 'about ' + formatNumber(Math.max(1, Math.round(pct)), 0) + '%' : null;
      if (f.type === 'bush') {
        item.kind = 'bush';
        item.widthFt = isNum(m.widthFt) ? m.widthFt : null;
        item.heightFt = isNum(m.heightFt) ? m.heightFt : null;
        if (item.widthFt === null || item.heightFt === null) continue;
        if (half) {
          item.text = tapedW ? roughFeet(item.widthFt) + ' wide by tape, about ' + roughFeet(item.heightFt) + ' tall from the photo: measure the height too'
            : 'about ' + roughFeet(item.widthFt) + ' wide from the photo, ' + roughFeet(item.heightFt) + ' tall by tape: measure the width too';
        } else {
          item.text = 'about ' + roughFeet(item.widthFt) + ' wide by ' + roughFeet(item.heightFt) + ' tall' +
            (offBy ? ', each side could be off by ' + offBy : ', a rough size');
        }
      } else {
        const vertical = !!(t && t.geometry === 'vertical');
        // A tree or column is checked by its height (the tape field sets the height; the wrap follows from it).
        const base = vertical ? (isNum(m.heightFt) ? m.heightFt : m.measuredFt) : m.lengthFt;
        if (!isNum(base) || base <= 0) continue;
        item.kind = vertical ? 'height' : 'length';
        item.lengthFt = base;
        const tail = vertical ? ' tall' : '';
        if (pct !== null && pct <= 60) {
          item.lowFt = base * (1 - pct / 100);
          item.highFt = base * (1 + pct / 100);
          const lo = roughFeet(item.lowFt), hi = roughFeet(item.highFt);
          item.text = 'about ' + roughFeet(base) + tail + (lo === hi ? ' (within ' + offBy + ')' : ', could be ' + lo.replace(/ ft$/, '') + ' to ' + hi);
        } else if (pct !== null) {
          item.text = 'about ' + roughFeet(base) + tail + ', but that is a rough guess: it could be far off';
        } else {
          item.text = 'about ' + roughFeet(base) + tail + ', a rough measurement';
        }
      }
      out.push(item);
    }
    return out;
  }

  // ================================================================ suppliers in plain words (SPEC §8.3, §8.5)
  // The Design step, the Review step and the PDF report all read these, so the screen and the paper say the same.
  const GENERIC = suppliers.GENERIC_ID;
  const ANY_STORE = 'Any store';
  /** The address when it is a plain https link, else null (every link shown or printed goes through this). */
  const linkOf = (u) => suppliers.safeUrl(u);
  /** "christmaslightsetc.com" from a link (no https, no www.); '' when it is not a plain https link. */
  function hostOf(url) {
    const m = /^https:\/\/([^/:?#]+)/i.exec(linkOf(url) || '');
    return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
  }
  const dateText = (iso) => (typeof iso === 'string' && iso ? suppliers.formatDate(iso) : '');
  const cents = (v) => (isNum(v) ? Math.round(v * 100) : null);

  /**
   * The price of a shopping-list line, a product or a part in a few honest words.
   * → { kind, text, date }
   *   'checked'  "as of Nov 11, 2026 · checked"      read on the supplier's own page that day (verified)
   *   'check'    "as of Nov 11, 2026 · check price"  seen in a listing only, not confirmed (observed)
   *   'yours'    "your price"                        typed in by the user
   *   'typical'  "typical price"                     any store: a typical retail figure, not one brand
   */
  function priceStatusLabel(item) {
    const it = isObj(item) ? item : {};
    if (it.priceStatus === 'yours' || it.overridden === true) return { kind: 'yours', text: 'your price', date: '' };
    const date = dateText(it.priceAsOf);
    if (it.priceStatus === 'verified') return { kind: 'checked', text: (date ? 'as of ' + date + ' · ' : '') + 'checked', date };
    if (it.priceStatus === 'observed') return { kind: 'check', text: (date ? 'as of ' + date + ' · ' : '') + 'check price', date };
    return { kind: 'typical', text: 'typical price', date: '' };
  }

  /**
   * One honest sentence (or two) about a set of prices, built from their dates and statuses: "Prices are as of
   * Nov 11, 2026: 27 checked on the supplier's page, 4 seen in a listing, not confirmed. Your account price may be
   * lower: edit any price." items: BOM lines, order-sheet lines, products or parts. opts.account: false leaves the
   * account sentence out (for a card that sits under one that already says it).
   */
  function priceSentence(items, opts) {
    let checked = 0, listed = 0, yours = 0, typical = 0;
    const dates = [];
    for (const it of arr(items)) {
      if (!isObj(it)) continue;
      const kind = priceStatusLabel(it).kind;
      if (kind === 'checked') checked += 1; else if (kind === 'check') listed += 1; else if (kind === 'yours') yours += 1; else typical += 1;
      if ((kind === 'checked' || kind === 'check') && typeof it.priceAsOf === 'string' && it.priceAsOf) dates.push(it.priceAsOf);
    }
    const out = [];
    const dated = checked + listed;
    if (dated) {
      const when = dates.length ? 'as of ' + dateText(dates.sort()[0]) : 'not dated';
      if (!listed) out.push('Prices are ' + when + ', checked on the supplier\'s page.');
      else if (!checked) out.push('Prices are ' + when + ', seen in a listing, not confirmed.');
      else out.push('Prices are ' + when + ': ' + formatNumber(checked, 0) + ' checked on the supplier\'s page, ' + formatNumber(listed, 0) + ' seen in a listing, not confirmed.');
    }
    if (yours) out.push(dated || typical ? formatNumber(yours, 0) + (yours === 1 ? ' is your own price.' : ' are your own prices.') : 'These are your own prices.');
    if (typical && !dated) out.push('Typical store prices, not one brand: check the price where you buy.');
    else if (typical) out.push(typical === 1 ? 'The 1 any-store item is a typical price.' : 'The ' + formatNumber(typical, 0) + ' any-store items are typical prices.');
    if (dated && !(isObj(opts) && opts.account === false)) out.push('Your account price may be lower: edit any price.');
    return out.join(' ');
  }

  /** The sentence of a supplier's note that says when an order ships free; '' when the note names no such offer. */
  function freeShippingLine(note) {
    const sentences = String(note || '').match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [];
    return sentences.map((x) => x.trim()).find((x) => /\bships? free\b|\bfree shipping (on|with|for|over|at)\b/i.test(x)) || '';
  }

  /**
   * What the app holds about a supplier, ready to show. Nothing here is made up: a field the supplier map does not
   * have comes back empty. → { id, generic, name, url, host, notes, priceAsOf, phone, freeShipping,
   *   wholesale: { name, url | null, phone, email, note } | null,
   *   searchPrefix (the start of its search links, '' when it has no search), searchChecked (true only when the
   *   search address was tested), searchNote }
   */
  function supplierFacts(library, supplierId) {
    const list = isObj(library) && Array.isArray(library.suppliers) && library.suppliers.length ? library.suppliers.filter(isObj) : suppliers.SUPPLIERS;
    const id = suppliers.knownSupplierId(supplierId);
    const s = list.find((x) => x.id === id) || suppliers.getSupplier(id) || suppliers.getSupplier(GENERIC) || {};
    const w = isObj(s.wholesale) ? s.wholesale : null;
    const note = w ? str(w.note) : '';
    return {
      id: s.id || GENERIC, generic: (s.id || GENERIC) === GENERIC, name: str(s.name) || ANY_STORE, url: linkOf(s.url), host: hostOf(s.url),
      notes: str(s.notes), priceAsOf: typeof s.priceAsOf === 'string' ? s.priceAsOf : null,
      phone: w ? str(w.phone) : '', freeShipping: freeShippingLine(note),
      wholesale: w ? { name: str(w.name), url: linkOf(w.url), phone: str(w.phone), email: str(w.email), note } : null,
      searchPrefix: typeof s.searchUrlTemplate === 'string' && s.searchUrlTemplate.indexOf('{query}') > 0 ? s.searchUrlTemplate.split('{query}')[0] : '',
      searchChecked: s.searchUrlWorks === true, searchNote: str(s.searchNote),
    };
  }
  /** True when `url` is one of the supplier's search links and that search address was never confirmed to work. */
  function isUncheckedSearch(facts, url) {
    return isObj(facts) && !!facts.searchPrefix && !facts.searchChecked && typeof url === 'string' && url.indexOf(facts.searchPrefix) === 0;
  }

  const partNumber = (o) => (isObj(o) && (typeof o.supplierSku === 'string' || typeof o.supplierSku === 'number') && String(o.supplierSku) ? String(o.supplierSku) : null);
  /**
   * The price of a product or part as the plan uses it (the same rule as the shopping list): the user's own price
   * wins, whether typed on a shopping-list line (overrides, keyed by sku) or edited in the product library, and is
   * then "your price" with no date. → { price, priceStatus, priceAsOf }
   */
  function pricedAs(o, overrides) {
    const it = isObj(o) ? o : {};
    const ov = isObj(overrides) && typeof it.sku === 'string' && Object.prototype.hasOwnProperty.call(overrides, it.sku) ? overrides[it.sku] : undefined;
    const typed = typeof ov === 'string' && ov.trim() !== '' ? Number(ov) : ov;
    const own = isNum(typed) && typed >= 0;
    const listed = typeof it.sku === 'string' ? suppliers.catalogPrice(it.sku) : null;
    const edited = own || (listed !== null && cents(listed) !== cents(it.price));
    return { price: own ? typed : isNum(it.price) ? it.price : null, priceStatus: edited ? 'yours' : it.priceStatus, priceAsOf: edited ? null : it.priceAsOf || null };
  }

  /**
   * Everything on file that can be ordered from a supplier: its ready-made products, the parts of its
   * cut-to-length products (the kit itself has no part number or page price) and its accessories.
   * `overrides` (project.pricing.overrides) and an edited price in the product library show as 'yours'.
   * → [{ sku, supplierSku, name, price, priceStatus, priceAsOf, url, what }]
   */
  function supplierItems(library, supplierId, overrides) {
    const out = [];
    const seen = new Set();
    const add = (o, what) => {
      if (!isObj(o) || typeof o.sku !== 'string' || !o.sku || seen.has(o.sku)) return;
      seen.add(o.sku);
      out.push(Object.assign({ sku: o.sku, supplierSku: partNumber(o), name: str(o.name), url: linkOf(o.url), what }, pricedAs(o, overrides)));
    };
    for (const p of arr(isObj(library) ? library.products : null)) {
      if (!isObj(p) || p.supplierId !== supplierId || p.enabled === false) continue;
      if (p.kind === 'bulk') for (const c of suppliers.componentOffers(p)) add(c.offer, c.part);
      else add(p, 'product');
    }
    const acc = suppliers.SUPPLIER_ACCESSORIES[supplierId];
    if (isObj(acc)) for (const k of Object.keys(acc)) add(acc[k], 'accessory');
    return out;
  }

  /** sku → {part, offer} for every part of the library's cut-to-length products (wire sizes, bulb colours, plugs). */
  function bulkPartIndex(library) {
    const map = new Map();
    for (const p of arr(isObj(library) ? library.products : null)) {
      if (!isObj(p) || p.kind !== 'bulk' || !isObj(p.components)) continue;
      for (const c of suppliers.componentOffers(p)) {
        if (isObj(c.offer) && typeof c.offer.sku === 'string' && !map.has(c.offer.sku)) map.set(c.offer.sku, { part: c.part, offer: c.offer });
      }
    }
    return map;
  }
  /**
   * For a line bought by the spool, box or pack (wire, bulbs and plugs of cut-to-length products): what is ordered
   * against what this job uses, e.g. "1 spool (1,000 ft): 143 ft used, 857 ft left" or "6 boxes (150 bulbs): 139
   * used, 11 spare". '' for a line that is used whole. Pass the library, or bulkPartIndex(library) when asking
   * about many lines.
   */
  function orderUseText(line, libraryOrIndex) {
    const l = isObj(line) ? line : {};
    if (!(isNum(l.qty) && l.qty > 0 && isNum(l.usedQty) && l.usedQty >= 0 && l.usedQty < l.qty - 1e-9)) return '';
    const index = libraryOrIndex instanceof Map ? libraryOrIndex : bulkPartIndex(libraryOrIndex);
    const sku = str(l.sku);
    let hit = index.get(sku) || null;
    // A colour the supplier does not list is priced like its default colour: "<default sku>:<colour>".
    if (!hit) for (const [k, v] of index) if (sku.indexOf(k + ':') === 0) { hit = v; break; }
    const n = (v) => formatNumber(v, 0);
    const count = (q, one, many) => n(q) + ' ' + (Math.abs(q - 1) < 1e-9 ? one : many);
    const name = hit ? str(hit.offer.name) : '';
    if (hit && hit.part === 'wire') {
      const each = isNum(hit.offer.lengthFt) && hit.offer.lengthFt > 0 ? hit.offer.lengthFt : hit.offer.spoolFt;
      if (isNum(each) && each > 0) {
        const bought = l.qty * each;
        const used = Math.min(bought, Math.round(l.usedQty * each));
        const spool = l.unit === 'spool' || /\bspool\b/i.test(name);
        return count(l.qty, spool ? 'spool' : 'length', spool ? 'spools' : 'lengths') + ' (' + n(bought) + ' ft): ' + n(used) + ' ft used, ' + n(bought - used) + ' ft left';
      }
    }
    if (hit && isNum(hit.offer.packQty) && hit.offer.packQty > 0) {
      const bought = l.qty * hit.offer.packQty;
      const used = Math.min(bought, Math.round(l.usedQty * hit.offer.packQty));
      const box = /\bbox of\b/i.test(name);
      return count(l.qty, box ? 'box' : 'pack', box ? 'boxes' : 'packs') + ' (' + n(bought) + ' ' + (hit.part === 'bulb' ? 'bulbs' : 'plugs') + '): ' +
        n(used) + ' used, ' + n(bought - used) + ' spare';
    }
    // A part the library does not describe: say the share in plain words.
    return n(l.qty) + ' ordered: about ' + n((l.usedQty / l.qty) * 100) + '% used on this job';
  }

  /**
   * A cut-to-length (bulk) product in plain words, for its card in the Design step. null when it is not one.
   * → { summary: 'Ordered as parts: socket wire by the spool or as a ready-made length, bulbs in boxes of 25 by
   *     colour, and a male and a female slide-on plug for every length you cut.',
   *     limit: 'One cord can feed at most 250 ft of this wire or 250 bulbs, whichever comes first.',
   *     perFoot: 'about $1.61 per ft with bulbs', prices: (priceSentence of the parts, no account sentence),
   *     statuses: [{ kind, text }] (the same in a few words: 'all 12 parts as of Nov 11, 2026 · checked', '1 part: check price'),
   *     parts: [{ group: 'wire' | 'bulb' | 'plug', label, sku, name, supplierSku, price, url, status, priceStatus, priceAsOf, note }] }
   * The kit itself has no part number and no page price, so only its parts carry a status; `overrides`
   * (project.pricing.overrides) shows a part whose price the user typed as "your price".
   */
  function describeBulk(product, overrides) {
    const p = isObj(product) ? product : {};
    const c = p.kind === 'bulk' && isObj(p.components) ? p.components : null;
    if (!c || !isObj(c.wire) || !isObj(c.bulb)) return null;
    const n = (v) => formatNumber(v, 0);
    const parts = [];
    const add = (group, label, o) => {
      if (!isObj(o)) return null;
      const priced = pricedAs(o, overrides);
      const part = Object.assign({ group, label, sku: str(o.sku), name: str(o.name), supplierSku: partNumber(o), url: linkOf(o.url), note: str(o.notes) }, priced);
      part.status = priceStatusLabel(part);
      parts.push(part);
      return part;
    };
    let ready = false;
    const spool = isNum(c.wire.spoolFt) && c.wire.spoolFt > 0 ? add('wire', n(c.wire.spoolFt) + ' ft spool', c.wire) : null;
    for (const s of arr(c.wire.sizes)) {
      if (!isObj(s) || !isNum(s.lengthFt)) continue;
      const made = !!s.plugsIncluded;
      if (made) ready = true;
      add('wire', n(s.lengthFt) + (made ? ' ft ready-made length' : ' ft spool'), s);
    }
    const variants = isObj(c.bulb.variants) ? c.bulb.variants : {};
    const packQty = isNum(c.bulb.packQty) && c.bulb.packQty > 0 ? c.bulb.packQty : 25;
    const box = /\bbox of\b/i.test(str(c.bulb.name) + ' ' + (isObj(variants[c.bulb.defaultVariant]) ? str(variants[c.bulb.defaultVariant].name) : ''));
    const keys = Object.keys(variants).sort((a, b) => {
      const ia = suppliers.VARIANT_ORDER.indexOf(a), ib = suppliers.VARIANT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    let defBulb = null;
    for (const k of keys) {
      const part = add('bulb', (suppliers.VARIANT_LABELS[k] || k) + ' bulbs, ' + (box ? 'box' : 'pack') + ' of ' + n(packQty), variants[k]);
      if (k === c.bulb.defaultVariant) defBulb = part;
    }
    const plugPack = (o) => (isObj(o) && isNum(o.packQty) && o.packQty > 1 ? ', pack of ' + n(o.packQty) : '');
    add('plug', 'Male slide-on plugs' + plugPack(c.plugMale), c.plugMale);
    add('plug', 'Female slide-on plugs' + plugPack(c.plugFemale), c.plugFemale);
    const maxFt = isNum(p.maxRunFt) && p.maxRunFt > 0 ? p.maxRunFt : isNum(p.maxEndToEnd) ? p.maxEndToEnd : null;
    const maxBulbs = isNum(p.maxBulbsPerRun) && p.maxBulbsPerRun > 0 ? p.maxBulbsPerRun : null;
    const limits = [maxFt ? n(maxFt) + ' ft of this wire' : null, maxBulbs ? n(maxBulbs) + ' bulbs' : null].filter(Boolean);
    // Per foot, from the whole spool and the default bulbs at the prices the plan uses: a guide, never a page price.
    const spacing = isNum(p.bulbSpacingIn) && p.bulbSpacingIn > 0 ? p.bulbSpacingIn : 12;
    const perFt = spool && defBulb && isNum(spool.price) && isNum(defBulb.price) ? spool.price / c.wire.spoolFt + (12 / spacing) * defBulb.price / packQty : isNum(p.price) ? p.price : null;
    // The statuses of the parts in a few words each, for the small labels on the card.
    const count = { checked: 0, check: 0, yours: 0, typical: 0 };
    const dates = [];
    for (const part of parts) {
      count[part.status.kind] += 1;
      if (part.priceAsOf && (part.status.kind === 'checked' || part.status.kind === 'check')) dates.push(part.priceAsOf);
    }
    const when = dates.length ? ' as of ' + dateText(dates.sort()[0]) : '';
    const some = (k, one, many) => (count[k] === 1 ? one : n(count[k]) + ' ' + many);
    const statuses = [];
    if (count.checked && count.checked === parts.length) statuses.push({ kind: 'checked', text: 'all ' + n(parts.length) + ' parts' + when + ' · checked' });
    else if (count.checked) statuses.push({ kind: 'checked', text: some('checked', '1 part', 'parts') + when + ' · checked' });
    if (count.check) statuses.push({ kind: 'check', text: some('check', '1 part', 'parts') + ': check price' });
    if (count.yours) statuses.push({ kind: 'yours', text: some('yours', '1 part', 'parts') + ' at your price' });
    if (count.typical) statuses.push({ kind: 'typical', text: some('typical', '1 part', 'parts') + ' at a typical price' });
    return {
      summary: 'Ordered as parts: socket wire ' + (ready ? 'by the spool or as a ready-made length' : 'by the spool') + ', bulbs in ' + (box ? 'boxes' : 'packs') + ' of ' +
        n(packQty) + ' by colour, and slide-on plugs for the ends you cut' + (ready ? ' (a ready-made length comes with plugs)' : '') + '.' +
        (str(c.wire.wireType) ? ' ' + c.wire.wireType + ' is the thin two-wire cord the sockets and plugs are made for.' : ''),
      short: 'Socket wire, bulbs and slide-on plugs, cut to fit each run.',
      limit: limits.length ? 'One cord can feed at most ' + limits.join(' or ') + (limits.length > 1 ? ', whichever comes first.' : '.') : '',
      perFoot: perFt !== null ? 'about ' + formatMoney(perFt) + ' per ft with bulbs' : '',
      prices: priceSentence(parts, { account: false }),
      statuses,
      parts,
    };
  }

  /**
   * Who to order from: one entry per order sheet (bom.orderSheets, suppliers first, then "Any store") with the
   * supplier's facts, its lines and the sentence about its prices.
   * → [supplierFacts + { supplierId (the sheet's own), name, lines, subtotal, sentence, sheet }]
   */
  function whereToBuy(plan) {
    const p = isObj(plan) ? plan : {};
    const lib = isObj(p.library) ? p.library : null;
    let sheets = [];
    try { sheets = bomModule.orderSheets(p.bom, lib); } catch (e) { sheets = []; }
    return arr(sheets).filter(isObj).map((sheet) => {
      const facts = supplierFacts(lib, sheet.supplierId);
      const lines = arr(sheet.lines).filter(isObj);
      return Object.assign(facts, {
        supplierId: typeof sheet.supplierId === 'string' && sheet.supplierId ? sheet.supplierId : GENERIC,
        name: str(sheet.supplierName) || facts.name, lines, subtotal: isNum(sheet.subtotal) ? sheet.subtotal : 0, sentence: priceSentence(lines), sheet,
      });
    });
  }

  /** One order sheet as plain text to paste into an email or a note: the list, then the phone and free-shipping line when known. */
  function orderSheetText(entry) {
    const e = isObj(entry) ? entry : {};
    const out = [bomModule.orderSheetToText(e.sheet)];
    if (str(e.phone)) out.push('Phone: ' + e.phone);
    if (str(e.freeShipping)) out.push(e.freeShipping);
    return out.join('\n');
  }

  // ================================================================ page layout
  const C = {
    ink: '#15302b', muted: '#5d6e69', faint: '#8a9894', line: '#d5ddd8', hair: '#e4e9e6', paper: '#f4f6f3',
    zebra: '#f8faf8', accent: '#d98a1c', accentSoft: '#fcf3e3', accentInk: '#9a5c07', ok: '#2f8f5b', warn: '#a86d00',
    danger: '#c8354a', white: '#ffffff',
  };
  const DISCLAIMER_SHORT = 'Planning estimate, not an electrical inspection.';
  const DISCLAIMER_LONG = 'This is a planning estimate, not an electrical inspection. Check your breaker sizes and what else ' +
    'shares each circuit, use outdoor-rated cords and GFCI protection, and ask a licensed electrician before adding outlets or circuits.';

  /**
   * A cursor over a PdfDoc: keeps the current y, starts new pages when content would run into the bottom
   * margin, and lets onPage draw a running header on each new page (it returns the y to continue from).
   */
  function createLayout(doc, o) {
    const L = {
      doc,
      left: o.margin,
      width: doc.width - 2 * o.margin,
      top: o.top,
      bottom: doc.height - o.bottom,
      y: o.top,
    };
    L.right = L.left + L.width;
    L.newPage = () => {
      doc.addPage();
      L.y = L.top;
      if (typeof o.onPage === 'function') {
        const y = o.onPage(doc.pageCount - 1, L);
        if (isNum(y)) L.y = y;
      }
    };
    /** Start a new page when fewer than h points are left. Returns true when it did. */
    L.ensure = (h) => {
      if (L.y + h > L.bottom + 1e-6 && L.y > L.top + 1e-6) { L.newPage(); return true; }
      return false;
    };
    return L;
  }

  /** Run one document section; if it fails on odd data, note it and carry on with the rest of the PDF. */
  function section(L, fn) {
    try {
      fn();
    } catch (e) {
      L.ensure(16);
      L.doc.text('This part could not be drawn from the project data. The rest of the document is complete.', L.left, L.y, { size: 9, color: C.danger, maxWidth: L.width });
      L.y += 18;
    }
  }

  /** Section title with a short accent rule. keep = points of content that must follow on the same page. */
  function heading(L, title, keep) {
    L.ensure(30 + (isNum(keep) ? keep : 60));
    if (L.y > L.top + 1) L.y += 10;
    L.doc.text(title, L.left, L.y, { size: 13, bold: true, color: C.ink });
    L.y += 17;
    L.doc.line(L.left, L.y, L.left + 28, L.y, { width: 2, color: C.accent });
    L.y += 9;
  }

  /** Wrapped paragraph that may continue onto the next page line by line. */
  function paragraph(L, text, o) {
    const opts = o || {};
    const size = opts.size || 9;
    const lh = size * (opts.lineHeight || 1.35);
    const indent = opts.indent || 0;
    const lines = L.doc.wrapText(text, size, !!opts.bold, L.width - indent);
    for (const line of lines) {
      L.ensure(lh);
      L.doc.text(line, L.left + indent, L.y, { size, bold: !!opts.bold, color: opts.color || C.ink, lineHeight: opts.lineHeight || 1.35 });
      L.y += lh;
    }
    L.y += isNum(opts.after) ? opts.after : 4;
  }

  function normCell(cell) {
    if (cell === null || cell === undefined) return { text: '' };
    if (typeof cell === 'string' || typeof cell === 'number') return { text: String(cell) };
    return isObj(cell) ? cell : { text: String(cell) };
  }

  /**
   * Table with wrapped cells. columns: [{title, w (relative width), align}]. rows: arrays of cells, or
   * {cells, style: 'total'}. A cell is text or {text, bold, color, sub (smaller muted text below)}.
   * The header row repeats on every page the table reaches; a row never splits across pages.
   */
  function table(L, columns, rows, o) {
    const opts = o || {};
    const doc = L.doc;
    const size = opts.size || 8.5;
    const lh = size * 1.3;
    const subSize = size - 1.2;
    const subLh = subSize * 1.3;
    const padX = 4.5, padY = 4;
    const MAX_LINES = 14;
    const total = columns.reduce((s, c) => s + c.w, 0);
    const ws = columns.map((c) => (c.w / total) * L.width);
    const xs = [];
    ws.reduce((x, w, i) => { xs[i] = x; return x + w; }, L.left);

    const headSize = 7.5;
    const headLines = columns.map((c, i) => wrapText(String(c.title || '').toUpperCase(), headSize, true, ws[i] - 2 * padX).length);
    const headH = Math.max(...headLines) * headSize * 1.25 + 2 * padY;
    const drawHeader = () => {
      doc.rect(L.left, L.y, L.width, headH, { fill: C.paper });
      columns.forEach((c, i) => {
        doc.text(String(c.title || '').toUpperCase(), xs[i] + padX, L.y + padY, { size: headSize, bold: true, color: C.muted, align: c.align, maxWidth: ws[i] - 2 * padX, lineHeight: 1.25 });
      });
      L.y += headH;
      doc.line(L.left, L.y, L.right, L.y, { width: 0.8, color: C.ink });
    };
    const measureRow = (row) => {
      const cells = Array.isArray(row) ? row : arr(row && row.cells);
      const style = Array.isArray(row) ? null : row && row.style;
      const laid = columns.map((col, i) => {
        const c = normCell(cells[i]);
        const inner = ws[i] - 2 * padX;
        const bold = !!(c.bold || style === 'total');
        const n = Math.min(MAX_LINES, wrapText(c.text, size, bold, inner).length);
        const subN = c.sub ? Math.min(MAX_LINES, wrapText(c.sub, subSize, false, inner).length) : 0;
        return { c, bold, inner, n, subN, h: n * lh + (subN ? subN * subLh + 1.5 : 0) };
      });
      return { laid, style, h: Math.max(...laid.map((x) => x.h)) + 2 * padY };
    };

    const measured = rows.map(measureRow);
    const fullH = headH + measured.reduce((t, r) => t + r.h, 0);
    // keepTogether: move the whole table to a new page when it would split but fits on one page.
    if (opts.keepTogether && fullH <= L.bottom - L.top) L.ensure(fullH + 2);
    else L.ensure(headH + (measured.length ? measured[0].h : 0) + 2);
    drawHeader();
    if (!measured.length) {
      doc.text(opts.empty || 'Nothing to list yet.', L.left + padX, L.y + padY, { size, color: C.muted, maxWidth: L.width - 2 * padX });
      L.y += lh + 2 * padY;
    }
    measured.forEach((row, ri) => {
      if (L.y + row.h > L.bottom + 1e-6) { L.newPage(); drawHeader(); }
      if (row.style === 'total') {
        doc.rect(L.left, L.y, L.width, row.h, { fill: C.accentSoft });
        doc.line(L.left, L.y, L.right, L.y, { width: 0.8, color: C.ink });
      } else if (opts.zebra !== false && ri % 2 === 1) {
        doc.rect(L.left, L.y, L.width, row.h, { fill: C.zebra });
      }
      row.laid.forEach((cell, i) => {
        const col = columns[i];
        doc.text(cell.c.text, xs[i] + padX, L.y + padY, { size, bold: cell.bold, color: cell.c.color || C.ink, align: col.align, maxWidth: cell.inner, lineHeight: 1.3, maxLines: MAX_LINES });
        if (cell.c.sub) {
          doc.text(cell.c.sub, xs[i] + padX, L.y + padY + cell.n * lh + 1.5, { size: subSize, color: C.muted, align: col.align, maxWidth: cell.inner, lineHeight: 1.3, maxLines: MAX_LINES });
        }
      });
      L.y += row.h;
      if (row.style !== 'total') doc.line(L.left, L.y, L.right, L.y, { width: 0.5, color: C.hair });
    });
    L.y += isNum(opts.after) ? opts.after : 12;
  }

  /** A row of summary tiles: [{label, value, sub, accent}]. */
  function tiles(L, items, o) {
    const opts = o || {};
    const cols = opts.cols || 4;
    const gap = 8;
    const h = opts.height || 50;
    const w = (L.width - gap * (cols - 1)) / cols;
    for (let i = 0; i < items.length; i += cols) {
      L.ensure(h);
      items.slice(i, i + cols).forEach((t, j) => {
        const x = L.left + j * (w + gap);
        L.doc.rect(x, L.y, w, h, t.accent ? { fill: C.accentSoft, stroke: C.accent, width: 0.8, radius: 5 } : { fill: C.paper, radius: 5 });
        let size = opts.valueSize || 15;
        while (size > 8 && textWidth(t.value, size, true) > w - 16) size -= 0.5;
        L.doc.text(t.value, x + 8, L.y + 7, { size, bold: true, color: t.accent ? C.accentInk : C.ink, maxLines: 1, maxWidth: w - 16 });
        L.doc.text(t.label, x + 8, L.y + 27, { size: 7.5, color: C.muted, maxLines: 1, maxWidth: w - 16 });
        if (t.sub) L.doc.text(t.sub, x + 8, L.y + 37, { size: 7, color: C.faint, maxLines: 1, maxWidth: w - 16 });
      });
      L.y += h + gap;
    }
    L.y += 4;
  }

  /** Footer on every page: left text, right "Page x of y", hairline above. */
  function drawFooters(doc, margin, leftText) {
    const n = doc.pageCount;
    for (let i = 0; i < n; i++) {
      doc.setPage(i);
      const y = doc.height - 34;
      doc.line(margin, y, doc.width - margin, y, { width: 0.5, color: C.line });
      doc.text(leftText, margin, y + 6, { size: 7.5, color: C.muted, maxWidth: doc.width - 2 * margin - 80, maxLines: 1 });
      doc.text('Page ' + (i + 1) + ' of ' + n, doc.width - margin, y + 6, { size: 7.5, color: C.muted, align: 'right' });
    }
  }

  /** Normalize the picture passed to a builder: {bytes, info} for a usable JPEG, else null. */
  function pictureOf(image) {
    if (!image) return null;
    const src = isObj(image) && !(image instanceof Uint8Array) && image.bytes ? image.bytes : image;
    const bytes = toBytes(src);
    const info = bytes ? parseJpeg(bytes) : null;
    return info ? { bytes, info } : null;
  }

  /** Draw a picture centered in the content width, at most maxH tall, with a thin frame. Returns its height. */
  function placePicture(L, pic, maxH) {
    let w = L.width;
    let h = (w * pic.info.height) / pic.info.width;
    if (h > maxH) { h = maxH; w = (h * pic.info.width) / pic.info.height; }
    L.ensure(h + 4);
    const x = L.left + (L.width - w) / 2;
    L.doc.image(pic.bytes, x, L.y, w, h);
    L.doc.rect(x, L.y, w, h, { stroke: C.line, width: 0.75 });
    L.y += h;
    return h;
  }

  // ================================================================ PDF report
  const LEVEL_TEXT = { high: 'High', medium: 'Medium', low: 'Low' };
  const LEVEL_COLOR = { high: C.ok, medium: C.warn, low: C.danger };

  function planeName(project, id) {
    const pl = byId(project.planes, id);
    return pl ? str(pl.name) || 'Unnamed surface' : '—';
  }
  function typeShort(type) {
    const t = FEATURE_TYPES[type];
    return t ? t.short : 'Other';
  }

  function confidenceCell(m) {
    if (!isObj(m)) return { text: 'Not measured', color: C.danger };
    if (m.overridden) return { text: 'Tape-measured', color: C.ok };
    if (m.ok === false) return { text: 'Not measured', color: C.danger };
    const c = isObj(m.confidence) ? m.confidence : {};
    const label = LEVEL_TEXT[c.level];
    if (!label) return { text: '—' };
    return { text: label + (isNum(c.score) ? ' (' + Math.round(c.score) + ')' : ''), color: LEVEL_COLOR[c.level] };
  }

  /** One measurements-table row for a run (or for a feature that has no run). */
  function measurementRow(project, parts, fmtLen, run, feature, index) {
    const fid = run ? run.featureId : feature && feature.id;
    const f = feature || byId(project.features, fid);
    const m = parts.measuredFeatures[fid];
    const type = (run && run.featureType) || (f && f.type);
    const label = (run && str(run.label)) || (f && str(f.label)) || typeShort(type);
    const planeId = (run && run.planeId) || (f && f.planeId);
    let length = '—', waste = '—';
    if (type === 'bush') {
      if (isObj(m) && isNum(m.widthFt) && isNum(m.heightFt)) length = fmtLen(m.widthFt) + ' × ' + fmtLen(m.heightFt);
      const lights = isObj(m) && isNum(m.lights) ? m.lights : null;
      if (lights !== null) waste = formatNumber(lights, 0) + ' lights';
    } else {
      const L0 = run && isNum(run.lengthFt) && run.lengthFt > 0 ? run.lengthFt : isObj(m) && isNum(m.lengthFt) ? m.lengthFt : null;
      const LW = run && isNum(run.withWasteFt) && run.withWasteFt > 0 ? run.withWasteFt : isObj(m) && isNum(m.withWasteFt) ? m.withWasteFt : null;
      if (L0 !== null) length = fmtLen(L0);
      if (LW !== null) waste = fmtLen(LW);
    }
    const detail = run && str(run.detail) ? run.detail : null;
    return [
      { text: index === null ? '–' : String(index), color: C.muted },
      { text: label, bold: true, sub: detail },
      typeShort(type),
      planeName(project, planeId),
      length,
      waste,
      confidenceCell(m),
    ];
  }

  function reportHeader(L, project, name, date) {
    const doc = L.doc;
    doc.text('LightPlan', L.left, L.y, { size: 22, bold: true, color: C.ink });
    doc.text('Lighting plan report', L.right, L.y + 3, { size: 10, color: C.muted, align: 'right' });
    doc.text(formatDate(date), L.right, L.y + 17, { size: 10, color: C.muted, align: 'right' });
    L.y += 32;
    const nameBox = doc.text(name, L.left, L.y, { size: 14, bold: true, color: C.ink, maxWidth: L.width, maxLines: 2 });
    L.y += nameBox.height + 1;
    const cu = isObj(project.customer) ? project.customer : {};
    const who = [str(cu.name), str(cu.address)].filter(Boolean).join(' · ');
    if (who) {
      const r = doc.text(who, L.left, L.y, { size: 10, color: C.muted, maxWidth: L.width, maxLines: 2 });
      L.y += r.height;
    }
    L.y += 6;
    doc.line(L.left, L.y, L.right, L.y, { width: 1.5, color: C.accent });
    L.y += 12;
  }

  function reportPreview(L, project, pic) {
    if (!arr(project.images).length) {
      paragraph(L, 'No photo in this project yet, so there is no preview picture.', { color: C.muted, size: 9 });
      return;
    }
    if (!pic) {
      paragraph(L, 'The preview picture could not be made in this browser. Everything else in the report is complete.', { color: C.muted, size: 9 });
      return;
    }
    placePicture(L, pic, 300);
    L.y += 4;
    L.doc.text('Night preview. Each number marks where a run starts and matches the # column in the measurements table.', L.left, L.y, { size: 7.5, color: C.muted, maxWidth: L.width });
    L.y += 16;
  }

  function reportSummary(L, parts, fmtLen, rough) {
    const s = parts.summary;
    const bushLights = isObj(s.byType) && isObj(s.byType.bush) && isNum(s.byType.bush.lights) ? s.byType.bush.lights : 0;
    heading(L, 'Summary', 110);
    tiles(L, [
      { label: 'Lights, feet incl. waste', value: formatNumber(s.totalWithWasteFt, 0) + ' ft', sub: fmtLen(s.totalFt) + ' measured' },
      { label: 'Light strings', value: formatNumber(s.strings, 0), sub: bushLights ? formatNumber(bushLights, 0) + ' lights on bushes' : null },
      { label: 'Clips', value: formatNumber(s.clips, 0) },
      { label: 'Extension cords', value: formatNumber(s.cords, 0) },
      { label: 'Timers', value: formatNumber(s.timers, 0) },
      { label: 'Total load', value: watts(s.watts), sub: isNum(s.amps) ? formatNumber(s.amps, 1) + ' A at 120 V' : null },
      { label: 'Circuits used', value: formatNumber(s.circuits, 0), sub: isNum(s.outletsUsed) ? plural(s.outletsUsed, 'outlet', 'outlets') : null },
      { label: rough ? 'Materials cost (rough)' : 'Materials cost', value: formatMoney(s.cost),
        sub: isNum(s.quoteTotal) ? 'Customer quote ' + formatMoney(s.quoteTotal) : rough ? plural(rough, 'length', 'lengths') + ' to double-check' : null, accent: true },
    ]);
  }

  function reportMeasurements(L, project, parts, fmtLen) {
    heading(L, 'Measurements', 70);
    const wastePct = isObj(project.settings) && isNum(project.settings.wastePct) ? project.settings.wastePct : 10;
    const rows = parts.runs.map((run, i) => measurementRow(project, parts, fmtLen, run, null, i + 1));
    const planned = new Set(parts.runs.map((r) => r.featureId));
    for (const f of arr(project.features)) {
      if (isObj(f) && !planned.has(f.id)) rows.push(measurementRow(project, parts, fmtLen, null, f, null));
    }
    const t = parts.totals;
    if (rows.length) {
      rows.push({ style: 'total', cells: ['', 'Total without bushes', '', '', fmtLen(t.totalFt), fmtLen(t.totalWithWasteFt), ''] });
    }
    table(L, [
      { title: '#', w: 22, align: 'right' },
      { title: 'Run', w: 152 },
      { title: 'Type', w: 54 },
      { title: 'Surface', w: 80 },
      { title: 'Length', w: 62, align: 'right' },
      { title: 'With ' + formatNumber(wastePct, 0) + '% waste', w: 70, align: 'right' },
      { title: 'Confidence', w: 92 },
    ], rows, { empty: 'Nothing traced yet. Trace rooflines, windows and other features to measure them.' });
  }

  /** The Low-confidence measurements, each with the range it could be, right under the measurements table. */
  function reportRough(L, list) {
    if (!list.length) return;
    L.ensure(64);
    L.doc.text('Measurements to double-check (' + formatNumber(list.length, 0) + ')', L.left, L.y, { size: 10, bold: true, color: C.ink });
    L.y += 15;
    paragraph(L, 'The photo could not measure these well. Check each one with a tape measure before you buy, then type the tape length into LightPlan (step 6) so the shopping list and the cost follow it.', { size: 8.5, color: C.muted, after: 4 });
    for (const it of list) paragraph(L, '-  ' + it.label + ': ' + it.text + '.', { size: 8.5, indent: 6, after: 1.5 });
    L.y += 8;
  }

  /**
   * The materials table: what to buy, from whom (supplier, part number, how fresh the price is), how many and what
   * it costs. Headed "Shopping list" for a homeowner and "Bill of materials" in installer mode.
   */
  function reportBom(L, parts, project) {
    const installer = isObj(project) && isObj(project.quote) && project.quote.enabled === true;
    heading(L, installer ? 'Bill of materials' : 'Shopping list', 70);
    let edited = false;
    let shares = false;
    const rows = parts.bom.lines.map((l) => {
      if (l.overridden) edited = true;
      // With the cost basis "only what is used", a spool, box or pack is costed for the share this job uses.
      const share = isNum(l.buyTotal) && isNum(l.lineTotal) && Math.abs(l.buyTotal - l.lineTotal) > 0.004;
      if (share) shares = true;
      const partNo = str(l.supplierSku) ? 'Part number ' + str(l.supplierSku) : '';
      return [
        { text: str(l.name) || str(l.sku) || 'Item', sub: str(l.notes) || null },
        { text: str(l.supplierName) || ANY_STORE, sub: [partNo, priceStatusLabel(l).text].filter(Boolean).join('\n') },
        qtyText(l.qty, l.unit),
        formatMoney(l.unitPrice) + (l.overridden ? '*' : ''),
        { text: formatMoney(l.lineTotal), sub: share ? 'to order: ' + formatMoney(l.buyTotal) : null },
      ];
    });
    if (rows.length) rows.push({ style: 'total', cells: ['Subtotal', '', '', '', formatMoney(parts.bom.subtotal)] });
    table(L, [
      { title: 'Item', w: 206 },
      { title: 'Where to buy', w: 118 },
      { title: 'Qty', w: 58, align: 'right' },
      { title: 'Unit price', w: 66, align: 'right' },
      { title: 'Line total', w: 84, align: 'right' },
    ], rows, { empty: 'Nothing to buy yet.', after: 4 });
    if (edited) paragraph(L, '* Unit price edited to match your store.', { size: 7.5, color: C.muted, after: 2 });
    if (shares) paragraph(L, 'Line totals count only the share of the wire, bulbs and plugs that this job uses; "to order" is what the whole spool, box or pack costs.', { size: 7.5, color: C.muted, after: 2 });
    let note = '';
    try { note = bomModule.priceNote(parts.bom); } catch (e) { note = ''; }
    if (note) paragraph(L, note, { size: 8.5, color: C.ink, after: 2 });
    L.y += 8;
  }

  const LINK_COLOR = '#1b5fa8';
  /**
   * Small text followed by a web address that can be clicked (and still read and typed from paper). The address
   * sits on the label's line when both fit, else on the line below; a long address wraps and stays one link.
   */
  function linkLine(L, label, url, o) {
    const u = linkOf(url);
    if (!u) return;
    const opts = o || {};
    const size = opts.size || 8;
    const lh = size * 1.35;
    const indent = opts.indent || 0;
    const x = L.left + indent;
    const width = L.width - indent;
    const lab = str(label);
    const labW = lab ? textWidth(lab + ' ', size, false) : 0;
    const sameLine = labW + textWidth(u, size, false) <= width;
    const urlLines = L.doc.wrapText(u, size, false, sameLine ? width - labW : width - 8);
    L.ensure((urlLines.length + (sameLine || !lab ? 0 : 1)) * lh);   // one link stays on one page
    if (lab) L.doc.text(lab, x, L.y, { size, color: opts.color || C.ink, lineHeight: 1.35, maxWidth: width, maxLines: 1 });
    if (lab && !sameLine) L.y += lh;
    const ux = sameLine ? x + labW : x + 8;
    const top = L.y;
    let widest = 0;
    for (const line of urlLines) {
      widest = Math.max(widest, L.doc.text(line, ux, L.y, { size, color: LINK_COLOR, lineHeight: 1.35 }).width);
      L.y += lh;
    }
    L.doc.link(ux, top, widest, urlLines.length * lh, u);
    L.y += isNum(opts.after) ? opts.after : 1;
  }

  /**
   * "Where to buy": one block per supplier in the plan with its site, phone, what its pages say about business
   * accounts, the sentence about its prices and the link of every item, so the paper carries what the screen links
   * to. Left out when the whole plan is for "Any store" (there is nothing to add).
   */
  function reportWhereToBuy(L, parts) {
    const list = whereToBuy(parts.plan).filter((e) => e.lines.length);
    if (!list.some((e) => !e.generic || e.lines.some((l) => linkOf(l.findUrl)))) return;
    const chosen = supplierFacts(isObj(parts.plan.library) ? parts.plan.library : null, isObj(parts.plan.library) ? parts.plan.library.supplierId : null);
    heading(L, 'Where to buy', 70);
    const doc = L.doc;
    const short = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/[\s,]+$/, '') + '…' : t);
    for (const e of list) {
      L.ensure(54);
      doc.text(e.name, L.left, L.y, { size: 10.5, bold: true, color: C.ink, maxWidth: L.width - 170, maxLines: 1 });
      doc.text(plural(e.lines.length, 'item', 'items') + ' · ' + formatMoney(e.subtotal) + ' to order', L.right, L.y + 1.5, { size: 8.5, color: C.muted, align: 'right' });
      L.y += 15;
      if (e.generic) {
        paragraph(L, 'No part number is on file for these' + (chosen.generic ? '' : ' at ' + chosen.name) + ': any store that carries them will do. ' + e.sentence, { size: 8.5, color: C.ink, after: 3 });
        // Where the chosen supplier keeps such things: one link per page, with what to look for there.
        const byLink = new Map();
        for (const l of e.lines) {
          const u = linkOf(l.findUrl);
          if (!u) continue;
          if (!byLink.has(u)) byLink.set(u, []);
          byLink.get(u).push(str(l.name) || 'Item');
        }
        for (const [u, names] of byLink) {
          const what = names.length > 2 ? names.slice(0, 2).map((t) => short(t, 44)).join('; ') + ' and ' + formatNumber(names.length - 2, 0) + ' more' : names.map((t) => short(t, 60)).join('; ');
          linkLine(L, '-  Look for ' + what + ':', u, { size: 7.5, indent: 6, color: C.muted });
        }
        if (Array.from(byLink.keys()).some((u) => isUncheckedSearch(chosen, u)) && chosen.searchNote) {
          paragraph(L, 'About the search links: ' + chosen.searchNote, { size: 7.5, color: C.muted, after: 2 });
        }
      } else {
        if (e.url) linkLine(L, 'Site:', e.url, { size: 8.5 });
        const w = e.wholesale;
        const contact = [w && w.phone ? 'Phone ' + w.phone : '', w && w.email ? 'Email ' + w.email : ''].filter(Boolean).join(' · ');
        if (contact) paragraph(L, (w.name ? w.name + ': ' : '') + contact, { size: 8.5, color: C.ink, after: 1 });
        if (w && w.url) linkLine(L, 'Business accounts:', w.url, { size: 8.5 });
        if (w && w.note) paragraph(L, w.note, { size: 7.5, color: C.muted, after: 2 });
        if (e.sentence) paragraph(L, e.sentence, { size: 8.5, color: C.ink, after: 4 });
        for (const l of e.lines) {
          const u = linkOf(l.url) || linkOf(l.findUrl);
          if (!u) continue;
          const part = str(l.supplierSku) ? 'Part ' + str(l.supplierSku) + ', ' : '';
          linkLine(L, '-  ' + part + short(str(l.name) || 'Item', 70) + ':', u, { size: 7.5, indent: 6, color: C.muted });
        }
      }
      L.y += 8;
    }
    L.y += 4;
  }

  function reportPower(L, project, parts) {
    const pw = parts.power;
    const s = parts.summary;
    const factor = isObj(parts.config.power) && isNum(parts.config.power.continuousFactor) ? parts.config.power.continuousFactor : 0.8;
    heading(L, 'Power plan', 70);
    // State the continuous-load rule as kept only when the plan keeps it; otherwise name the circuits over it.
    const over = arr(pw.circuits).filter((c) => c && (c.overloaded || (isNum(c.utilizationPct) && c.utilizationPct > 100)));
    const rule = over.length
      ? (over.length === 1 ? str(over[0].name) || 'One circuit' : over.map((c) => str(c.name) || 'Circuit').join(', ')) + (over.length === 1 ? ' is' : ' are') +
        ' over its safe limit (' + Math.round(factor * 100) + '% of the breaker rating for continuous use). Move some lights to another circuit before installing.'
      : 'Each circuit is kept at or below ' + Math.round(factor * 100) + '% of its breaker rating for continuous use.';
    paragraph(L, 'Total load ' + watts(s.watts) + (isNum(s.amps) ? ' (' + formatNumber(s.amps, 1) + ' A)' : '') + ' from ' +
      plural(isNum(s.outletsUsed) ? s.outletsUsed : 0, 'outlet', 'outlets') + ' on ' + plural(isNum(s.circuits) ? s.circuits : 0, 'circuit', 'circuits') +
      '. ' + rule, { after: 8 });

    L.ensure(60);
    L.doc.text('Circuits', L.left, L.y, { size: 10, bold: true, color: C.ink });
    L.y += 15;
    const circuitRows = pw.circuits.map((c) => {
      const load = isNum(c.loadW) ? c.loadW : 0;
      const existing = isNum(c.existingLoadW) ? c.existingLoadW : 0;
      const pct = isNum(c.utilizationPct) ? c.utilizationPct : isNum(c.limitW) && c.limitW > 0 ? (load / c.limitW) * 100 : null;
      const status = c.overloaded || (isNum(pct) && pct > 100) ? { text: 'Over limit', color: C.danger, bold: true }
        : isNum(pct) && pct > 90 ? { text: 'Near limit', color: C.warn, bold: true } : { text: 'OK', color: C.ok, bold: true };
      return [
        { text: str(c.name) || 'Circuit', bold: true },
        isNum(c.breakerAmps) ? formatNumber(c.breakerAmps, 0) + ' A' : '—',
        watts(load - existing),
        watts(existing),
        watts(load),
        watts(c.limitW),
        isNum(pct) ? formatNumber(pct, 0) + '%' : '—',
        status,
      ];
    });
    table(L, [
      { title: 'Circuit', w: 116 },
      { title: 'Breaker', w: 50, align: 'right' },
      { title: 'Lights', w: 58, align: 'right' },
      { title: 'Already on it', w: 64, align: 'right' },
      { title: 'Total load', w: 62, align: 'right' },
      { title: 'Safe limit (' + Math.round(factor * 100) + '%)', w: 68, align: 'right' },
      { title: 'Use', w: 44, align: 'right' },
      { title: 'Status', w: 70 },
    ], circuitRows, { empty: 'No circuits yet.' });

    L.ensure(60);
    L.doc.text('Outlets', L.left, L.y, { size: 10, bold: true, color: C.ink });
    L.y += 15;
    let described = { outlets: [], loose: [], rows: [] };
    try { described = describeCords(parts.plan, project); } catch (e) { /* the tables below fall back to plain counts */ }
    const outletInfo = new Map(described.outlets.map((o) => [o.id, o]));
    const outletRows = pw.outlets.map((o) => {
      const src = byId(project.outlets, o.id) || {};
      const circuit = byId(project.circuits, o.circuitId) || byId(pw.circuits, o.circuitId);
      const info = outletInfo.get(o.id);
      const feeds = arr(o.feedIds).length;
      // The cords that plug into the outlet itself, and the light runs they feed (jumper cords carry on from run to run).
      const cords = info ? info.cords : Array.isArray(o.directFeedIds) ? o.directFeedIds.length : feeds;
      const extras = [];
      if (o.timer) extras.push('Timer');
      if (isNum(o.splitters) && o.splitters > 0) extras.push(plural(o.splitters, 'power stake', 'power stakes'));
      if (feeds > 0 && src.gfci === false) extras.push('GFCI adapter');
      return [
        { text: str(o.label) || str(src.label) || 'Outlet', bold: true },
        circuit ? str(circuit.name) || 'Circuit' : 'Not set',
        src.gfci === false ? { text: 'No', color: C.danger } : src.gfci === true ? 'Yes' : '—',
        formatNumber(cords, 0),
        info ? formatNumber(info.runs, 0) : '—',
        watts(o.watts),
        extras.join(', ') || (feeds ? '—' : 'Not used'),
      ];
    });
    table(L, [
      { title: 'Outlet', w: 120 },
      { title: 'Circuit', w: 100 },
      { title: 'GFCI', w: 36 },
      { title: 'Cords here', w: 44, align: 'right' },
      { title: 'Runs fed', w: 40, align: 'right' },
      { title: 'Load', w: 56, align: 'right' },
      { title: 'Also needs', w: 136 },
    ], outletRows, { empty: 'No outlets placed yet. Place each outdoor outlet you can use on the photo.' });

    L.ensure(74);
    L.doc.text('Cords', L.left, L.y, { size: 10, bold: true, color: C.ink });
    L.y += 15;
    if (described.rows.length) {
      paragraph(L, 'Listed in the order they are put up: a cord from an outlet first, then what plugs into it. A jumper cord is a short cord from one run of lights to the next. A 3-way tap is a plug with three outlets.', { size: 8, color: C.muted, after: 5 });
    }
    const feedRows = described.rows.map((r, i) => {
      let cord = r.what;
      let cordSub = null;
      if (r.kind === 'home' || r.kind === 'jumper') {
        cord = (r.pieces.length ? r.pieces.map((x) => formatNumber(x, 0) + ' ft').join(' + ') : formatNumber(r.neededFt, 0) + ' ft') +
          (r.kind === 'jumper' ? ' jumper cord' : ' cord') + (r.awg !== null ? ', ' + r.awg + ' AWG' : '');
        // Rounded up, like the install checklist ("about N ft needed"), so one report gives one length per cord.
        // A voltage drop that rounds to 0.0% is left out: it says nothing a buyer needs.
        cordSub = (r.route ? capFirst(r.route) + '. ' : '') + 'Needs ' + formatNumber(r.neededFt, 0) + ' ft' +
          (r.dropPct !== null && r.dropPct >= 0.05 ? ', ' + formatNumber(r.dropPct, 1) + '% voltage drop' : '') + '.';
      } else if (r.kind === 'plugIn') {
        cord = 'Plugs straight in';
        cordSub = 'No cord needed.';
      } else if (r.kind === 'unknown') {
        cord = 'Length unknown';
        cordSub = 'Set the scale of its wall to size this cord.';
      }
      const notes = [];
      if (r.tapText) notes.push(capFirst(r.tapText));
      if (r.cover) notes.push('Cord cover');
      if (!r.cordOk) notes.push('Check cord');
      const loadSub = [];
      if (r.strings !== null && r.unit) loadSub.push(qtyText(r.strings, r.unit));
      if (r.carriesW > r.watts + 0.5) loadSub.push('cord carries ' + watts(r.carriesW));
      return [
        { text: String(i + 1), color: C.muted },
        { text: r.lights, bold: r.kind === 'home', sub: r.startLabel ? 'Starts at the ' + r.startLabel : null },
        r.kind === 'none' ? { text: 'No outlet yet', color: C.danger } : capFirst(r.source) || '—',
        { text: watts(r.watts), sub: loadSub.join('; ') || null },
        { text: cord, sub: cordSub, color: r.kind === 'unknown' ? C.warn : undefined },
        notes.length ? { text: notes.join('. '), color: C.warn } : '',
      ];
    });
    table(L, [
      { title: '#', w: 22, align: 'right' },
      { title: 'Lights on this cord', w: 114 },
      { title: 'Plugs into', w: 104 },
      { title: 'Load', w: 58, align: 'right' },
      { title: 'Cord and route', w: 170 },
      { title: 'Note', w: 64 },
    ], feedRows, { empty: 'Cords appear once there are lights and an outlet.' });

    const c = pw.counts;
    const cnt = (v) => formatNumber(isNum(v) ? v : 0, 0);
    const cordsToBuy = pw.cords.slice().sort((a, b) => (a.awg - b.awg) || (a.lengthFt - b.lengthFt))
      .map((x) => formatNumber(x.count, 0) + ' × ' + formatNumber(x.lengthFt, 0) + ' ft ' + x.awg + ' AWG');
    L.ensure(110);
    tiles(L, [
      { label: 'Cords to outlets', value: cnt(c.homeRuns) },
      { label: 'Jumper cords', value: cnt(c.jumpers) },
      { label: '3-way taps', value: cnt(c.taps) },
      { label: 'Timers', value: cnt(c.timers) },
      { label: 'Power stakes (3-outlet)', value: cnt(c.splitters) },
      { label: 'Walkway cord covers', value: cnt(c.cordCovers) },
      { label: 'GFCI adapters', value: cnt(c.gfciAdapters) },
    ], { height: 40, valueSize: 13 });
    if (cordsToBuy.length) paragraph(L, 'Extension cords to buy (cords to outlets and jumper cords together): ' + cordsToBuy.join(', ') + '.', { size: 8.5, after: 8 });
  }

  const WARN_LABEL = { danger: 'DANGER', warn: 'WARNING', info: 'NOTE' };
  const WARN_COLOR = { danger: C.danger, warn: C.warn, info: C.muted };
  function reportWarnings(L, parts) {
    const list = parts.warnings.filter((w) => w.code !== 'disclaimer' && str(w.message));
    heading(L, 'Warnings', 30);
    if (!list.length) {
      paragraph(L, 'No warnings. The plan found no measurement or power problems.', { color: C.ok, after: 8 });
      return;
    }
    const pillW = 50, gap = 8, size = 8.5, lh = size * 1.35;
    for (const w of list) {
      const lines = L.doc.wrapText(w.message, size, false, L.width - pillW - gap);
      L.ensure(Math.min(lines.length, 3) * lh + 4);
      const level = WARN_LABEL[w.level] ? w.level : 'info';
      L.doc.rect(L.left, L.y + 1.5, pillW, 10, { fill: WARN_COLOR[level], radius: 2 });
      L.doc.text(WARN_LABEL[level], L.left, L.y + 1.5, { size: 6.5, bold: true, color: C.white, align: 'center', maxWidth: pillW, lineHeight: 10 / 6.5 });
      for (const line of lines) {
        L.ensure(lh);
        L.doc.text(line, L.left + pillW + gap, L.y, { size, color: C.ink, lineHeight: 1.35 });
        L.y += lh;
      }
      L.y += 5;
    }
    L.y += 4;
  }

  function reportChecklist(L, parts) {
    heading(L, 'Install checklist', 50);
    if (!parts.checklist.length) {
      paragraph(L, 'The checklist appears once there are lights and an outlet.', { color: C.muted });
      return;
    }
    const size = 8.5, lh = size * 1.35, indent = 16;
    for (const g of parts.checklist) {
      const steps = arr(g.steps).map((s) => String(s));
      const firstLines = steps.length ? L.doc.wrapText(steps[0], size, false, L.width - indent).length : 0;
      L.ensure(18 + firstLines * lh);
      L.y += 4;
      L.doc.text(str(g.title) || 'Steps', L.left, L.y, { size: 10, bold: true, color: C.ink, maxWidth: L.width });
      L.y += 15;
      steps.forEach((step) => {
        const lines = L.doc.wrapText(step, size, false, L.width - indent);
        L.ensure(Math.min(lines.length, 2) * lh);
        L.doc.rect(L.left + 1, L.y + 2.6, 7, 7, { stroke: C.muted, width: 0.7, radius: 1 });
        lines.forEach((line, i) => {
          if (i > 0) L.ensure(lh);
          L.doc.text(line, L.left + indent, L.y, { size, color: C.ink, lineHeight: 1.35 });
          L.y += lh;
        });
        L.y += 2.5;
      });
    }
    L.y += 6;
  }

  function reportAbout(L, project, parts) {
    const dis = parts.warnings.find((w) => w.code === 'disclaimer' && str(w.message)) ||
      parts.power.warnings.find((w) => w.code === 'disclaimer' && str(w.message));
    const wastePct = isObj(project.settings) && isNum(project.settings.wastePct) ? project.settings.wastePct : 10;
    const fromSupplier = parts.bom.lines.some((l) => str(l.supplierId));
    const prices = fromSupplier
      ? 'Supplier prices are the public prices seen on the date shown, the other prices are typical retail, and all of them change: confirm at checkout. '
      : 'Prices are typical retail and change often. ';
    const text = 'Lengths are measured from one photo using the reference sizes you entered, so check the low-confidence runs ' +
      'with a tape measure before you buy. Linear runs include ' + formatNumber(wastePct, 0) + '% extra for waste, corners and drops. ' +
      prices + (dis ? dis.message : DISCLAIMER_LONG);
    const size = 8.5, lh = size * 1.4;
    const lines = L.doc.wrapText(text, size, false, L.width - 24);
    const h = 26 + lines.length * lh;
    L.ensure(Math.min(h, 200));
    L.y += 6;
    const boxTop = L.y;
    const fits = L.y + h <= L.bottom;
    if (fits) L.doc.rect(L.left, boxTop, L.width, h, { fill: C.paper, radius: 5 });
    L.doc.text('About this plan', L.left + 12, L.y + 9, { size: 10, bold: true, color: C.ink });
    L.y += 26;
    for (const line of lines) {
      L.ensure(lh);
      L.doc.text(line, L.left + 12, L.y, { size, color: C.ink, lineHeight: 1.4 });
      L.y += lh;
    }
    L.y += 10;
  }

  /**
   * The full PDF report. input: {project, plan, image (JPEG bytes / data URL / {bytes}) | null, date}.
   * Pure and never throws; returns a PdfDoc (call toBytes()).
   */
  function buildReportPdf(input) {
    const o = isObj(input) ? input : {};
    const project = isObj(o.project) ? o.project : {};
    const parts = planParts(o.plan);
    const date = toDate(o.date) || toDate(project.updatedAt);
    const name = str(project.name) || 'Untitled project';
    const fmtLen = lengthFormatter(project);
    const doc = new PdfDoc({ size: 'letter', title: 'LightPlan report - ' + name, subject: 'Holiday lighting plan', creationDate: date });
    const L = createLayout(doc, {
      margin: 40, top: 40, bottom: 50,
      onPage: (index, lay) => {
        if (index === 0) return lay.top;
        doc.text('LightPlan', lay.left, 22, { size: 8.5, bold: true, color: C.ink });
        doc.text(name, lay.left + textWidth('LightPlan', 8.5, true) + 8, 22, { size: 8.5, color: C.muted, maxWidth: lay.width - 200, maxLines: 1 });
        doc.text('Lighting plan report', lay.right, 22, { size: 8.5, color: C.muted, align: 'right' });
        doc.line(lay.left, 36, lay.right, 36, { width: 0.5, color: C.line });
        return 48;
      },
    });
    L.newPage();
    section(L, () => reportHeader(L, project, name, date));
    section(L, () => reportPreview(L, project, pictureOf(o.image)));
    let roughList = [];
    try { roughList = roughMeasurements(o.plan, project); } catch (e) { roughList = []; }
    section(L, () => reportSummary(L, parts, fmtLen, roughList.length));
    section(L, () => reportMeasurements(L, project, parts, fmtLen));
    section(L, () => reportRough(L, roughList));
    section(L, () => reportBom(L, parts, project));
    section(L, () => reportWhereToBuy(L, parts));
    section(L, () => reportPower(L, project, parts));
    section(L, () => reportWarnings(L, parts));
    section(L, () => reportChecklist(L, parts));
    section(L, () => reportAbout(L, project, parts));
    drawFooters(doc, 40, DISCLAIMER_SHORT + '  ·  ' + name);
    return doc;
  }

  // ================================================================ customer quote PDF
  /** Customer-facing names for each feature type in the quote's scope list. */
  const SCOPE_LABELS = {
    roofline: 'Rooflines and eaves', rake: 'Gable rakes', gutter: 'Gutters', ridge: 'Ridge line', window: 'Window outlines',
    door: 'Door outlines', railing: 'Railings', walkway: 'Walkway and driveway edges', stakes: 'Ground stake lights',
  };
  /** Customer-facing scope lines ("Rooflines and eaves: 34 ft of lights"). */
  function scopeLines(parts) {
    const byType = isObj(parts.summary.byType) ? parts.summary.byType : {};
    const out = [];
    for (const type of catalog.TYPE_ORDER) {
      const b = byType[type];
      if (!isObj(b) || !(b.count > 0)) continue;
      if (type === 'bush') out.push('Bushes: ' + plural(b.count, 'bush', 'bushes') + (b.lights > 0 ? ', about ' + formatNumber(b.lights, 0) + ' lights' : ''));
      else if (type === 'tree') out.push('Tree wraps: ' + plural(b.count, 'tree', 'trees'));
      else if (type === 'column') out.push('Column wraps: ' + plural(b.count, 'column', 'columns'));
      else if (b.lengthFt > 0) out.push((SCOPE_LABELS[type] || (FEATURE_TYPES[type] ? FEATURE_TYPES[type].label : type)) + ': ' + formatNumber(b.lengthFt, 0) + ' ft of lights');
    }
    return out;
  }

  /**
   * The customer quote. input: {project, plan, image, date}. Pure and never throws; returns a PdfDoc.
   * The layout is one page for typical jobs and flows onto more pages when the notes are long.
   */
  function buildQuotePdf(input) {
    const o = isObj(input) ? input : {};
    const project = isObj(o.project) ? o.project : {};
    const parts = planParts(o.plan);
    const q = parts.quote;
    const pq = isObj(project.quote) ? project.quote : {};
    const date = toDate(o.date) || toDate(project.updatedAt);
    const company = str(pq.company);
    const number = quoteNumber(project);
    const validDays = isNum(q.validDays) ? q.validDays : isNum(pq.validDays) ? pq.validDays : 30;
    const doc = new PdfDoc({ size: 'letter', title: 'Quote ' + number + (company ? ' - ' + company : ''), author: company, subject: 'Holiday lighting quote', creationDate: date });
    const L = createLayout(doc, {
      margin: 54, top: 46, bottom: 52,
      onPage: (index, lay) => {
        if (index === 0) return lay.top;
        // Keep 'Quote <number>' whole on the right; the company name takes the rest of the line, ellipsized.
        const qn = 'Quote ' + number;
        const qw = doc.textWidth(qn, 8.5, false);
        doc.text(qn, lay.right, 26, { size: 8.5, color: C.muted, align: 'right' });
        if (company) doc.text(company, lay.left, 26, { size: 8.5, color: C.muted, maxWidth: Math.max(20, lay.right - lay.left - qw - 16), maxLines: 1 });
        doc.line(lay.left, 40, lay.right, 40, { width: 0.5, color: C.line });
        return 54;
      },
    });
    L.newPage();

    section(L, () => {
      // Masthead: company left, quote facts right.
      const top = L.y;
      const leftW = L.width - 190;
      const title = doc.text(company || 'Holiday lighting quote', L.left, top, { size: 20, bold: true, color: C.ink, maxWidth: leftW, maxLines: 2 });
      let y = top + title.height + 2;
      if (company) {
        doc.text('Holiday lighting quote', L.left, y, { size: 11, color: C.muted });
        y += 16;
      }
      doc.text('QUOTE', L.right, top, { size: 20, bold: true, color: C.accent, align: 'right' });
      const facts = [['Quote no.', number], ['Date', formatDate(date) || '—']];
      if (date) facts.push(['Valid until', formatDate(addDays(date, validDays))]);
      let fy = top + 28;
      for (const [k, v] of facts) {
        doc.text(k, L.right - 92, fy, { size: 8.5, color: C.muted, align: 'right' });
        doc.text(v, L.right, fy, { size: 8.5, bold: true, color: C.ink, align: 'right' });
        fy += 12;
      }
      L.y = Math.max(y, fy) + 8;
      doc.line(L.left, L.y, L.right, L.y, { width: 1.5, color: C.accent });
      L.y += 16;
    });

    /** Small upper-case section label used throughout the quote. */
    const label = (text, keep) => {
      L.ensure(14 + (isNum(keep) ? keep : 30));
      doc.text(text.toUpperCase(), L.left, L.y, { size: 7.5, bold: true, color: C.muted });
      L.y += 13;
    };

    section(L, () => {
      // Customer on the left; the night preview on the right (or the customer block alone without a photo).
      const pic = pictureOf(o.image);
      const top = L.y;
      const picW = pic ? Math.min(L.width * 0.56, 290) : 0;
      const textW = pic ? L.width - picW - 18 : L.width;
      const cu = isObj(project.customer) ? project.customer : {};
      let y = top;
      doc.text('PREPARED FOR', L.left, y, { size: 7.5, bold: true, color: C.muted });
      y += 13;
      const nameLine = str(cu.name) || str(project.name) || 'Customer';
      y += doc.text(nameLine, L.left, y, { size: 12, bold: true, color: C.ink, maxWidth: textW, maxLines: 2 }).height + 1;
      const contact = [str(cu.address), str(cu.phone), str(cu.email)].filter(Boolean);
      if (str(cu.name) && str(project.name) && !str(cu.address)) contact.unshift(str(project.name));
      for (const line of contact) y += doc.text(line, L.left, y, { size: 9.5, color: C.ink, maxWidth: textW, maxLines: 2, lineHeight: 1.3 }).height;
      let picBottom = top;
      if (pic) {
        let h = (picW * pic.info.height) / pic.info.width;
        let w = picW;
        if (h > 150) { h = 150; w = (h * pic.info.width) / pic.info.height; }
        const x = L.right - w;
        doc.image(pic.bytes, x, top, w, h);
        doc.rect(x, top, w, h, { stroke: C.line, width: 0.75 });
        doc.text('Night preview of the finished display', x, top + h + 4, { size: 7, color: C.muted, maxWidth: w, align: 'center' });
        picBottom = top + h + 14;
      }
      L.y = Math.max(y, picBottom) + 14;
    });

    section(L, () => {
      const scope = scopeLines(parts);
      const extras = ['All lights, clips, extension cords, timers and power stakes'];
      const install = ['Installation'];
      if (isNum(q.takedownFee) ? q.takedownFee > 0 : pq.takedownFee > 0) install.push('takedown after the season');
      if (isNum(q.storageFee) ? q.storageFee > 0 : pq.storageFee > 0) install.push('storage until next season');
      extras.push(install.length === 1 ? install[0] : install.slice(0, -1).join(', ') + ' and ' + install[install.length - 1]);
      const items = scope.length ? scope.concat(extras) : ['Lighting design and installation as discussed'].concat(extras);
      label('What is included', 40);
      // Two columns when the list is long, filled top to bottom.
      const cols = items.length > 5 ? 2 : 1;
      const gap = 18;
      const colW = (L.width - gap * (cols - 1)) / cols;
      const size = 9.5, lh = size * 1.35;
      const perCol = Math.ceil(items.length / cols);
      const heights = items.map((it) => doc.wrapText(it, size, false, colW - 13).length * lh + 1);
      const colH = (c) => heights.slice(c * perCol, (c + 1) * perCol).reduce((a, b) => a + b, 0);
      const blockH = Math.max(...Array.from({ length: cols }, (_, c) => colH(c)));
      if (blockH <= L.bottom - L.top) L.ensure(blockH);
      const top = L.y;
      items.forEach((item, i) => {
        const c = Math.floor(i / perCol);
        if (i % perCol === 0) L.y = top;
        const x = L.left + c * (colW + gap);
        doc.text('•', x + 2, L.y, { size, color: C.accent, lineHeight: 1.35 });
        doc.text(item, x + 13, L.y, { size, color: C.ink, maxWidth: colW - 13, lineHeight: 1.35 });
        L.y += heights[i];
      });
      L.y = top + blockH + 14;
    });

    section(L, () => {
      const lines = arr(q.lines).filter((l) => isObj(l) && str(l.description));
      const totalLine = lines.find((l) => /^total$/i.test(str(l.description)));
      const rows = lines.filter((l) => l !== totalLine).map((l) => [l.description, formatMoney(l.amount)]);
      const total = totalLine ? totalLine.amount : q.total;
      rows.push({ style: 'total', cells: ['Total', formatMoney(total)] });
      label('Price', 20 * (rows.length + 1));
      table(L, [{ title: 'Description', w: 380 }, { title: 'Amount', w: 124, align: 'right' }], rows, { size: 9.5, zebra: false, keepTogether: true, after: 6 });
      paragraph(L, 'This quote is valid for ' + plural(validDays, 'day', 'days') + (date ? ', until ' + formatDate(addDays(date, validDays)) : '') + '.', { size: 8.5, color: C.muted, after: 10 });
    });

    section(L, () => {
      const notes = typeof q.notes === 'string' && q.notes.trim() ? q.notes.trim() : str(pq.notes);
      if (!notes) return;
      label('Notes', 13);
      paragraph(L, notes, { size: 9.5, after: 10 });
    });

    section(L, () => {
      // Acceptance block, never split across pages.
      const boxH = 66;
      L.ensure(boxH + 6);
      L.y += 4;
      doc.rect(L.left, L.y, L.width, boxH, { stroke: C.line, width: 0.75, radius: 5 });
      doc.text('Acceptance', L.left + 12, L.y + 9, { size: 10, bold: true, color: C.ink });
      const to = company ? ' to ' + company.replace(/[.\s]+$/, '') : '';
      doc.text('To accept this quote, sign below and return a copy' + to + '.', L.left + 12, L.y + 23, { size: 8.5, color: C.muted, maxWidth: L.width - 24, maxLines: 1 });
      const lineY = L.y + 47;
      const sigW = L.width * 0.58;
      doc.line(L.left + 12, lineY, L.left + 12 + sigW, lineY, { width: 0.75, color: C.ink });
      doc.line(L.left + 30 + sigW, lineY, L.right - 12, lineY, { width: 0.75, color: C.ink });
      doc.text('Signature and printed name', L.left + 12, lineY + 4, { size: 7.5, color: C.muted });
      doc.text('Date', L.left + 30 + sigW, lineY + 4, { size: 7.5, color: C.muted });
      L.y += boxH + 12;
    });

    section(L, () => {
      const text = 'Lengths were measured from a photo and are confirmed on site before installation. The lights plug into existing ' +
        'outdoor outlets: this quote does not include electrical work, and the power plan behind it is a planning estimate, not an electrical inspection.';
      L.ensure(doc.wrapText(text, 7.5, false, L.width).length * 7.5 * 1.4); // keep the disclaimer in one piece
      paragraph(L, text, { size: 7.5, color: C.muted, lineHeight: 1.4, after: 4 });
    });

    drawFooters(doc, 54, (company ? company + '  ·  ' : '') + 'Quote ' + number);
    return doc;
  }

  // ================================================================ downloads
  let downloadsPromise = null;
  const DOWNLOADS_TIMEOUT_MS = 12000;

  /**
   * Ask the viewer for the downloads capability once and cache the answer: resolves the namespace, or null
   * when there is no window.claude (standalone file), use() resolves null, fails, or never answers.
   */
  function initDownloads(opts) {
    if (downloadsPromise) return downloadsPromise;
    const timeoutMs = isObj(opts) && isNum(opts.timeoutMs) && opts.timeoutMs >= 0 ? opts.timeoutMs : DOWNLOADS_TIMEOUT_MS;
    downloadsPromise = new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let claude = null;
      try {
        claude = typeof window !== 'undefined' && window ? window.claude : null;
      } catch (e) {
        claude = null;
      }
      if (!claude || typeof claude.use !== 'function') { finish(null); return; }
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        Promise.resolve(claude.use('downloads')).then((dl) => {
          clearTimeout(timer);
          finish(dl && typeof dl.save === 'function' ? dl : null);
        }, () => { clearTimeout(timer); finish(null); });
      } catch (e) {
        clearTimeout(timer);
        finish(null);
      }
    });
    return downloadsPromise;
  }
  /** Tests only: forget the cached downloads answer. */
  function _resetDownloads() { downloadsPromise = null; }

  function toBlob(data, mime) {
    if (typeof Blob === 'undefined') return data;
    if (data instanceof Blob) return data;
    return new Blob([data], { type: mime || 'application/octet-stream' });
  }

  /** Standalone fallback: click a hidden <a download> pointing at a blob URL. */
  function anchorDownload(filename, blob) {
    try {
      if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return 'failed';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      // Revoke later: some browsers read the blob after click() returns.
      setTimeout(() => {
        try { a.parentNode && a.parentNode.removeChild(a); } catch (e) { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      }, 5000);
      return 'saved';
    } catch (e) {
      return 'failed';
    }
  }

  /**
   * Save a file. Resolves 'saved', 'declined' (the viewer said no; nothing to report) or 'failed'. Never rejects.
   * data: string | Blob | Uint8Array | ArrayBuffer.
   */
  let saving = false;
  /** True inside the claude.ai viewer (window.claude exists), where blob <a download> links are blocked. */
  function inViewer() {
    try { return typeof window !== 'undefined' && !!window && !!window.claude; } catch (e) { return false; }
  }
  /** Map a downloads.save refusal code to a saveFile result. */
  function refusal(err) {
    const code = err && typeof err === 'object' ? err.code : err;
    if (code === 'declined') return 'declined';
    if (code === 'rate_limited') return 'busy';
    if (code === 'too_large') return 'too_large';
    if (code === 'unavailable' || code === 'not_granted' || (typeof code === 'string' && code.indexOf('capability') === 0)) return 'unavailable';
    return 'failed';
  }
  function saveFile(filename, data, mime) {
    let blob;
    try {
      blob = toBlob(data, mime);
    } catch (e) {
      return Promise.resolve('failed');
    }
    // One save prompt at a time: a second tap while the viewer's prompt is open would be refused (rate_limited).
    if (saving) return Promise.resolve('busy');
    saving = true;
    return initDownloads().then((dl) => {
      // Inside the viewer a blob download is blocked, so claiming 'saved' would be false: report unavailable.
      if (!dl) return inViewer() ? 'unavailable' : anchorDownload(filename, blob);
      let call;
      try {
        call = dl.save({ filename, data: blob });
      } catch (e) {
        return refusal(e);
      }
      return Promise.resolve(call).then(
        (res) => (res === 'declined' || (isObj(res) && res.status === 'declined') ? 'declined' : 'saved'),
        (err) => refusal(err));
    }).catch(() => 'failed').then((r) => { saving = false; return r; });
  }

  // ================================================================ browser helpers (canvas → JPEG, images)
  /** Let the browser paint (e.g. a "Making PDF…" button state) before heavy synchronous work. */
  function nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const go = () => { if (!done) { done = true; resolve(); } };
      try {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(go, 0));
      } catch (e) { /* fall through to the timer */ }
      setTimeout(go, 60);
    });
  }

  /** Draw any canvas image source onto a fresh canvas (for elements that have no toDataURL). */
  function sourceToCanvas(el) {
    if (!el || typeof document === 'undefined') return null;
    if (typeof el.toDataURL === 'function') return el;
    const w = el.naturalWidth || el.videoWidth || el.width;
    const h = el.naturalHeight || el.videoHeight || el.height;
    if (!(w > 0 && h > 0)) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    // JPEG has no alpha: paint white first so transparent pixels do not turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(el, 0, 0, w, h);
    return c;
  }
  /** JPEG data URL of a canvas image source, or null (tainted canvas, no DOM, ...). */
  function elementToJpegDataUrl(el, quality) {
    try {
      const c = sourceToCanvas(el);
      if (!c) return null;
      const url = c.toDataURL('image/jpeg', isNum(quality) ? quality : 0.88);
      return typeof url === 'string' && /^data:image\/jpeg/i.test(url) ? url : null;
    } catch (e) {
      return null;
    }
  }

  function activeImage(project) {
    const images = arr(project && project.images).filter(isObj);
    return byId(images, project && project.activeImageId) || images[0] || null;
  }

  /** Night preview of the active photo as JPEG bytes ({bytes}), or null when it cannot be made. */
  function snapshotJpeg(store, project, plan, maxWidth, quality, labels) {
    try {
      const preview = optional('ui.preview');
      const im = activeImage(project);
      if (!preview || typeof preview.renderSnapshot !== 'function' || !im) return null;
      const el = typeof store.getImage === 'function' ? store.getImage(im.id) : null;
      const canvas = preview.renderSnapshot({ project, plan, image: el, imageId: im.id, maxWidth, night: true, labels: labels !== false });
      const url = canvas ? elementToJpegDataUrl(canvas, quality) : null;
      const bytes = url ? dataUrlToBytes(url) : null;
      return bytes && parseJpeg(bytes) ? { bytes } : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Photos for a JSON export as {storageKey: dataUrl}: the store's cached data URL, else the saved copy in
   * browser storage, else the decoded picture re-encoded (this is how the generated sample photo is included).
   */
  function collectImages(store, project) {
    const persist = optional('ui.persist');
    const tasks = arr(project && project.images).filter(isObj).map((im) => {
      const key = typeof im.storageKey === 'string' && im.storageKey ? im.storageKey : null;
      if (!key) return Promise.resolve(null);
      const cached = store && typeof store.getImageData === 'function' ? store.getImageData(im.id) : null;
      if (typeof cached === 'string' && /^data:image\//i.test(cached)) return Promise.resolve([key, cached]);
      const rerender = () => {
        const el = store && typeof store.getImage === 'function' ? store.getImage(im.id) : null;
        const url = el ? elementToJpegDataUrl(el, 0.9) : null;
        return url ? [key, url] : null;
      };
      const isSample = key === 'sample' || (isObj(im.source) && im.source.kind === 'sample');
      if (isSample || !persist || typeof persist.loadImage !== 'function') return Promise.resolve(rerender());
      return Promise.resolve(persist.loadImage(key))
        .then((url) => (typeof url === 'string' && /^data:image\//i.test(url) ? [key, url] : rerender()), () => rerender());
    });
    return Promise.all(tasks).then((pairs) => {
      const out = {};
      for (const p of pairs) if (p) out[p[0]] = p[1];
      return out;
    });
  }

  function requireProject(store) {
    const project = store && typeof store.project === 'function' ? store.project() : null;
    if (!isObj(project)) throw new Error('There is no project to export yet. Add a photo or open the sample house first.');
    return project;
  }
  function planOf(store) {
    try {
      return typeof store.plan === 'function' ? store.plan() : null;
    } catch (e) {
      return null;
    }
  }
  function pdfBlobData(doc) {
    const bytes = doc.toBytes();
    return typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'application/pdf' }) : bytes;
  }

  // ================================================================ store-level exports
  /** The full PDF report. Resolves 'saved' | 'declined' | 'failed'. */
  function exportPdfReport(store) {
    return Promise.resolve().then(() => {
      const project = requireProject(store);
      return nextFrame().then(() => {
        const plan = planOf(store);
        const image = snapshotJpeg(store, project, plan, 1600, 0.86);
        const doc = buildReportPdf({ project, plan, image, date: new Date() });
        return saveFile(exportFilename(project, 'report'), pdfBlobData(doc), 'application/pdf');
      });
    });
  }

  /** The customer quote PDF (installer mode). Resolves 'saved' | 'declined' | 'failed'. */
  function exportQuotePdf(store) {
    return Promise.resolve().then(() => {
      const project = requireProject(store);
      if (!(isObj(project.quote) && project.quote.enabled)) {
        throw new Error('Turn on installer mode in the Quote section to make a customer quote.');
      }
      return nextFrame().then(() => {
        const plan = planOf(store);
        // The customer sees a clean picture: no run-number tags (those belong to the installer's report).
        const image = snapshotJpeg(store, project, plan, 1100, 0.85, false);
        const doc = buildQuotePdf({ project, plan, image, date: new Date() });
        return saveFile(exportFilename(project, 'quote'), pdfBlobData(doc), 'application/pdf');
      });
    });
  }

  /** The shopping list as CSV (with a UTF-8 byte-order mark so spreadsheet apps read × and – correctly). */
  function exportCsv(store) {
    return Promise.resolve().then(() => {
      const project = requireProject(store);
      const plan = planOf(store);
      const csv = bomModule.bomToCsv(isObj(plan) ? plan.bom : null);
      return saveFile(exportFilename(project, 'csv'), '﻿' + csv, 'text/csv;charset=utf-8');
    });
  }

  /**
   * One supplier's order sheet as CSV (Part number, Item, Qty, Unit, Unit Price, Total, Price status, Link, Notes),
   * through the same save path as the other files. supplierId 'generic' = everything with no supplier.
   */
  function exportOrderCsv(store, supplierId) {
    return Promise.resolve().then(() => {
      const project = requireProject(store);
      const entry = whereToBuy(planOf(store)).find((e) => e.supplierId === supplierId && e.lines.length);
      if (!entry) throw new Error('There is nothing to order from that supplier in this plan.');
      const csv = bomModule.orderSheetToCsv(entry.sheet);
      return saveFile(exportFilename(project, 'order-' + slug(entry.name) + '.csv'), '\ufeff' + csv, 'text/csv;charset=utf-8');
    });
  }

  /** The project as JSON (schema.exportProject) with the plan as `derived` and, by default, the photos. */
  function exportJson(store, opts) {
    const includeImages = !(isObj(opts) && opts.includeImages === false);
    return Promise.resolve().then(() => {
      const project = requireProject(store);
      const plan = planOf(store);
      return (includeImages ? collectImages(store, project) : Promise.resolve({})).then((images) => {
        const data = schema.exportProject(project, plan, images, new Date().toISOString());
        return saveFile(exportFilename(project, 'json'), JSON.stringify(data, null, 2), 'application/json');
      });
    });
  }

  function readFileText(file) {
    if (file && typeof file.text === 'function') return Promise.resolve(file.text());
    return new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error('The file could not be read. Try choosing it again.'));
        fr.readAsText(file);
      } catch (e) {
        reject(new Error('The file could not be read. Try choosing it again.'));
      }
    });
  }

  /** Read a LightPlan JSON file. Resolves {project, images: {storageKey: dataUrl}}; rejects with a plain message. */
  function importJsonFile(file) {
    if (!file) return Promise.reject(new Error('Choose a LightPlan project file (.json) to open.'));
    return readFileText(file).then(
      (text) => schema.importProject(text),
      () => { throw new Error('The file could not be read. Try choosing it again.'); });
  }

  return {
    initDownloads, saveFile, exportPdfReport, exportQuotePdf, exportCsv, exportJson, importJsonFile,
    PdfDoc, buildReportPdf, buildQuotePdf, parseJpeg, toWinAnsi, fromWinAnsi, textWidth, wrapText,
    base64ToBytes, dataUrlToBytes, slug, formatMoney, formatNumber, formatDate, quoteNumber, exportFilename,
    collectImages, HELVETICA_WIDTHS, HELVETICA_BOLD_WIDTHS, _resetDownloads,
    describeCords, gaugeText, roughMeasurements, roughFeet,
    supplierFacts, supplierItems, priceStatusLabel, priceSentence, orderUseText, bulkPartIndex, describeBulk, whereToBuy, orderSheetText,
    freeShippingLine, hostOf, isUncheckedSearch, pricedAs, exportOrderCsv,
  };
});
