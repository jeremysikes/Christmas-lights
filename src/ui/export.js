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
 *    10 s to answer) and falls back to a blob-URL <a download> click when the page runs as a standalone file.
 *
 * Deviations from SPEC §6.5 (documented signatures unchanged; all additive):
 *  - Export functions resolve saveFile's result ('saved' | 'declined' | 'failed') and reject with a plain-language
 *    Error when there is nothing to export (no project, or installer mode off for the quote).
 *  - initDownloads(opts) also accepts {timeoutMs} (default 12000): if use() never answers, saving falls back to the
 *    <a download> path instead of hanging. It returns the cached promise.
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
 */
LP.define('ui.export', ['catalog', 'bom', 'schema'], function (catalog, bomModule, schema) {
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
      this.pages.push({ ops: [], images: new Set() });
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
        startObj(pageNum);
        write('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(this.width) + ' ' + num(this.height) + ']' +
          ' /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + (xobjects ? ' /XObject << ' + xobjects + ' >>' : '') +
          ' /ProcSet [/PDF /Text /ImageB /ImageC] >> /Contents ' + (pageNum + 1) + ' 0 R >>\nendobj\n');
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
  const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'], pack: ['pack', 'packs'], each: ['', ''] };
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

  function reportSummary(L, parts, fmtLen) {
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
      { label: 'Materials cost', value: formatMoney(s.cost), sub: isNum(s.quoteTotal) ? 'Customer quote ' + formatMoney(s.quoteTotal) : null, accent: true },
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

  function reportBom(L, parts) {
    heading(L, 'Bill of materials', 70);
    let edited = false;
    const rows = parts.bom.lines.map((l) => {
      if (l.overridden) edited = true;
      return [
        { text: str(l.name) || str(l.sku) || 'Item', sub: str(l.notes) || null },
        { text: str(l.sku), color: C.muted },
        qtyText(l.qty, l.unit),
        formatMoney(l.unitPrice) + (l.overridden ? '*' : ''),
        formatMoney(l.lineTotal),
      ];
    });
    if (rows.length) rows.push({ style: 'total', cells: ['Subtotal', '', '', '', formatMoney(parts.bom.subtotal)] });
    table(L, [
      { title: 'Item', w: 240 },
      { title: 'SKU', w: 82 },
      { title: 'Qty', w: 66, align: 'right' },
      { title: 'Unit price', w: 68, align: 'right' },
      { title: 'Line total', w: 76, align: 'right' },
    ], rows, { empty: 'Nothing to buy yet.', after: edited ? 4 : 12 });
    if (edited) paragraph(L, '* Unit price edited to match your store.', { size: 7.5, color: C.muted, after: 10 });
  }

  function reportPower(L, project, parts) {
    const pw = parts.power;
    const s = parts.summary;
    const factor = isObj(parts.config.power) && isNum(parts.config.power.continuousFactor) ? parts.config.power.continuousFactor : 0.8;
    heading(L, 'Power plan', 70);
    paragraph(L, 'Total load ' + watts(s.watts) + (isNum(s.amps) ? ' (' + formatNumber(s.amps, 1) + ' A)' : '') + ' from ' +
      plural(isNum(s.outletsUsed) ? s.outletsUsed : 0, 'outlet', 'outlets') + ' on ' + plural(isNum(s.circuits) ? s.circuits : 0, 'circuit', 'circuits') +
      '. Each circuit is kept at or below ' + Math.round(factor * 100) + '% of its breaker rating for continuous use.', { after: 8 });

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
    const outletRows = pw.outlets.map((o) => {
      const src = byId(project.outlets, o.id) || {};
      const circuit = byId(project.circuits, o.circuitId) || byId(pw.circuits, o.circuitId);
      const feeds = arr(o.feedIds).length;
      const extras = [];
      if (o.timer) extras.push('Timer');
      if (isNum(o.splitters) && o.splitters > 0) extras.push(plural(o.splitters, 'power stake', 'power stakes'));
      if (feeds > 0 && src.gfci === false) extras.push('GFCI adapter');
      return [
        { text: str(o.label) || str(src.label) || 'Outlet', bold: true },
        circuit ? str(circuit.name) || 'Circuit' : 'Not set',
        src.gfci === false ? { text: 'No', color: C.danger } : src.gfci === true ? 'Yes' : '—',
        formatNumber(feeds, 0),
        watts(o.watts),
        extras.join(', ') || (feeds ? '—' : 'Not used'),
      ];
    });
    table(L, [
      { title: 'Outlet', w: 128 },
      { title: 'Circuit', w: 108 },
      { title: 'GFCI', w: 38 },
      { title: 'Cords', w: 42, align: 'right' },
      { title: 'Load', w: 60, align: 'right' },
      { title: 'Also needs', w: 156 },
    ], outletRows, { empty: 'No outlets placed yet. Place each outdoor outlet you can use on the photo.' });

    L.ensure(60);
    L.doc.text('Cords and feeds', L.left, L.y, { size: 10, bold: true, color: C.ink });
    L.y += 15;
    const runById = new Map(parts.runs.map((r) => [r.id, r]));
    const feedRows = pw.feeds.map((f, i) => {
      const fruns = arr(f.runIds).map((id) => runById.get(id)).filter(Boolean);
      const names = fruns.map((r) => str(r.label)).filter(Boolean);
      const units = Array.from(new Set(fruns.map((r) => r.unit)));
      const outlet = byId(project.outlets, f.outletId) || byId(pw.outlets, f.outletId);
      let cord = f.outletId ? 'Length unknown' : 'No outlet yet';
      let cordSub = null;
      if (isObj(f.cord) && arr(f.cord.pieces).length) {
        cord = arr(f.cord.pieces).map((p) => formatNumber(p, 0) + ' ft').join(' + ') + ', ' + f.cord.awg + ' AWG';
        cordSub = 'Needs ' + formatNumber(f.cord.lengthFt, 0) + ' ft' + (isNum(f.cord.voltageDropPct) ? ', ' + formatNumber(f.cord.voltageDropPct, 1) + '% voltage drop' : '');
      }
      const notes = [];
      if (f.crossesWalkway) notes.push('Cord cover');
      if (isObj(f.cord) && f.cord.ok === false) notes.push('Check cord');
      return [
        { text: String(i + 1), color: C.muted },
        { text: names.join(', ') || 'Lights', sub: f.start && str(f.start.label) ? 'Starts at the ' + f.start.label : null },
        outlet ? str(outlet.label) || 'Outlet' : { text: 'None', color: C.danger },
        { text: watts(f.watts), sub: isNum(f.strings) && units.length === 1 ? qtyText(f.strings, units[0]) : null },
        { text: cord, sub: cordSub },
        notes.length ? { text: notes.join(', '), color: C.warn } : '',
      ];
    });
    table(L, [
      { title: '#', w: 20, align: 'right' },
      { title: 'Lights on this cord', w: 168 },
      { title: 'Outlet', w: 86 },
      { title: 'Load', w: 58, align: 'right' },
      { title: 'Cord', w: 136 },
      { title: 'Note', w: 64 },
    ], feedRows, { empty: 'Cords appear once there are lights and an outlet.' });

    const c = pw.counts;
    const cordsToBuy = pw.cords.slice().sort((a, b) => (a.awg - b.awg) || (a.lengthFt - b.lengthFt))
      .map((x) => formatNumber(x.count, 0) + ' × ' + formatNumber(x.lengthFt, 0) + ' ft ' + x.awg + ' AWG');
    L.ensure(70);
    tiles(L, [
      { label: 'Timers', value: formatNumber(isNum(c.timers) ? c.timers : 0, 0) },
      { label: 'Power stakes (3-outlet)', value: formatNumber(isNum(c.splitters) ? c.splitters : 0, 0) },
      { label: 'Walkway cord covers', value: formatNumber(isNum(c.cordCovers) ? c.cordCovers : 0, 0) },
      { label: 'GFCI adapters', value: formatNumber(isNum(c.gfciAdapters) ? c.gfciAdapters : 0, 0) },
    ], { height: 40, valueSize: 13 });
    if (cordsToBuy.length) paragraph(L, 'Extension cords to buy: ' + cordsToBuy.join(', ') + '.', { size: 8.5, after: 8 });
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
    const text = 'Lengths are measured from one photo using the reference sizes you entered, so check the low-confidence runs ' +
      'with a tape measure before you buy. Linear runs include ' + formatNumber(wastePct, 0) + '% extra for waste, corners and drops. ' +
      'Prices are typical retail and change often. ' + (dis ? dis.message : DISCLAIMER_LONG);
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
    section(L, () => reportSummary(L, parts, fmtLen));
    section(L, () => reportMeasurements(L, project, parts, fmtLen));
    section(L, () => reportBom(L, parts));
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
        doc.text((company ? company + '  ·  ' : '') + 'Quote ' + number, lay.left, 26, { size: 8.5, color: C.muted });
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
  function saveFile(filename, data, mime) {
    let blob;
    try {
      blob = toBlob(data, mime);
    } catch (e) {
      return Promise.resolve('failed');
    }
    return initDownloads().then((dl) => {
      if (!dl) return anchorDownload(filename, blob);
      let call;
      try {
        call = dl.save({ filename, data: blob });
      } catch (e) {
        return 'failed';
      }
      return Promise.resolve(call).then(
        (res) => (res === 'declined' || (isObj(res) && res.status === 'declined') ? 'declined' : 'saved'),
        (err) => (err && (err.code === 'declined' || err === 'declined') ? 'declined' : 'failed'));
    }).catch(() => 'failed');
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
  function snapshotJpeg(store, project, plan, maxWidth, quality) {
    try {
      const preview = optional('ui.preview');
      const im = activeImage(project);
      if (!preview || typeof preview.renderSnapshot !== 'function' || !im) return null;
      const el = typeof store.getImage === 'function' ? store.getImage(im.id) : null;
      const canvas = preview.renderSnapshot({ project, plan, image: el, imageId: im.id, maxWidth, night: true, labels: true });
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
        const image = snapshotJpeg(store, project, plan, 1100, 0.85);
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
  };
});
