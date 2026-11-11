// Tests for ui.export: the PDF writer (structure, fonts, encoding, JPEG embedding), the report and quote
// layouts, the pure helpers, and saving files through window.claude.use('downloads') or the <a download> fallback.
// External checks (pdftotext, python3 + pypdf / PIL / reportlab) run when the tools are installed and are skipped
// otherwise.
const LP = require('./loader');
require('../src/ui/export.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const exp = LP.require('ui.export');
const sampleModule = LP.require('sample');
const planModule = LP.require('plan');
const schema = LP.require('schema');

// ---------------------------------------------------------------- tools and fixtures
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lightplan-export-'));
const run = (cmd, args, input) => spawnSync(cmd, args, { encoding: 'utf8', input, timeout: 60000 });
const has = (cmd, args) => { const r = run(cmd, args); return !r.error && r.status === 0; };
const HAS_PDFTOTEXT = has('pdftotext', ['-v']);
const HAS_PY = has('python3', ['-I', '-c', 'pass']);
const HAS_PYPDF = HAS_PY && has('python3', ['-I', '-c', 'import pypdf']);
const HAS_PIL = HAS_PY && has('python3', ['-I', '-c', 'import PIL.Image']);
const HAS_REPORTLAB = HAS_PY && has('python3', ['-I', '-c', 'import reportlab.pdfbase.pdfmetrics']);

/** An 8 × 6 baseline RGB JPEG (made with PIL, quality 80). */
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCl4W+Hln8nKflRRRXmYzH4j2r99m/DmZ4v6lH94z//2Q==';
const JPEG = new Uint8Array(Buffer.from(JPEG_B64, 'base64'));
const JPEG_DATA_URL = 'data:image/jpeg;base64,' + JPEG_B64;

/** Extra JPEG variants made with PIL when it is available: {gray, progressive, cmyk} → bytes. */
function pilFixtures() {
  if (!HAS_PIL) return null;
  const dir = path.join(TMP, 'jpeg');
  fs.mkdirSync(dir, { recursive: true });
  const code = [
    'import sys', 'from PIL import Image', 'd = sys.argv[1]',
    "rgb = Image.new('RGB', (40, 30), (200, 120, 40))",
    "rgb.convert('L').save(d + '/gray.jpg', 'JPEG', quality=85)",
    "rgb.save(d + '/progressive.jpg', 'JPEG', quality=85, progressive=True)",
    "rgb.convert('CMYK').save(d + '/cmyk.jpg', 'JPEG', quality=85)",
    "Image.new('RGB', (1600, 1100), (16, 24, 48)).save(d + '/preview.jpg', 'JPEG', quality=85)",
  ].join('\n');
  const r = run('python3', ['-I', '-c', code, dir]);
  if (r.status !== 0) return null;
  const read = (n) => new Uint8Array(fs.readFileSync(path.join(dir, n)));
  return { gray: read('gray.jpg'), progressive: read('progressive.jpg'), cmyk: read('cmyk.jpg'), preview: read('preview.jpg') };
}
const PIL = pilFixtures();

function writePdf(name, bytes) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, bytes);
  return file;
}
function pdfText(file, page) {
  const args = page ? ['-f', String(page), '-l', String(page), file, '-'] : [file, '-'];
  const r = run('pdftotext', args);
  assert.equal(r.status, 0, 'pdftotext failed: ' + r.stderr);
  return r.stdout;
}
/** Strict pypdf parse: returns {pages, info} or fails the test. */
function pypdfCheck(file) {
  const code = [
    'import sys, json, pypdf',
    'r = pypdf.PdfReader(sys.argv[1], strict=True)',
    'out = {"pages": len(r.pages), "title": (r.metadata or {}).get("/Title"), "producer": (r.metadata or {}).get("/Producer"), "images": []}',
    'for p in r.pages:',
    '    res = p["/Resources"]',
    '    xo = res.get("/XObject") if res is not None else None',
    '    if xo:',
    '        for k in xo:',
    '            o = xo[k].get_object()',
    '            out["images"].append({"name": k, "w": o["/Width"], "h": o["/Height"], "cs": o["/ColorSpace"], "filter": o["/Filter"], "decode": list(o["/Decode"]) if "/Decode" in o else None})',
    '    p.extract_text()',
    'print(json.dumps(out))',
  ].join('\n');
  const r = run('python3', ['-I', '-c', code, file]);
  assert.equal(r.status, 0, 'pypdf strict parse failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

/** Check the cross-reference table: every in-use entry points exactly at "n 0 obj". */
function checkXref(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'), 'header');
  assert.ok(text.endsWith('%%EOF\n'), 'trailer end');
  const m = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  assert.ok(m, 'startxref');
  const xrefAt = Number(m[1]);
  assert.equal(text.slice(xrefAt, xrefAt + 5), 'xref\n');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(xrefAt));
  const count = Number(head[1]);
  let p = xrefAt + head[0].length;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const entry = text.slice(p, p + 20);
    assert.match(entry, /^\d{10} \d{5} [nf] \n$/, 'entry ' + i + ' is 20 bytes');
    entries.push(entry);
    p += 20;
  }
  assert.equal(entries[0], '0000000000 65535 f \n');
  for (let n = 1; n < count; n++) {
    const off = Number(entries[n].slice(0, 10));
    assert.equal(text.slice(off, off + String(n).length + 6), n + ' 0 obj', 'object ' + n + ' offset');
  }
  assert.match(text.slice(p), new RegExp('^trailer\\n<< /Size ' + count + ' /Root 1 0 R /Info \\d+ 0 R /ID \\[<[0-9A-F]{32}> <[0-9A-F]{32}>\\] >>'));
  // Each stream's /Length matches its data.
  const re = /\/Length (\d+) >>\nstream\n/g;
  let s;
  while ((s = re.exec(text))) {
    const start = s.index + s[0].length;
    assert.equal(text.slice(start + Number(s[1]), start + Number(s[1]) + 10), '\nendstream', 'stream length at ' + s.index);
  }
  return count;
}

/** The traced sample house with a customer and installer mode on, and its plan. */
function sampleFixture(mutate) {
  const project = JSON.parse(JSON.stringify(sampleModule.createSample({ traced: true }).project));
  project.customer = { name: 'Dana Whitfield', address: '123 Maple St, Springfield', phone: '555-0100', email: 'dana@example.com' };
  project.quote.enabled = true;
  project.quote.company = 'Bright Nights Lighting Co.';
  project.quote.notes = 'Install the week after Thanksgiving. We bring ladders and all clips.';
  if (mutate) mutate(project);
  return { project, plan: planModule.computePlan(project) };
}
const DATE = new Date(2026, 10, 9, 10, 30, 0); // November 9, 2026 (local time)

// ---------------------------------------------------------------- WinAnsi encoding and metrics
test('toWinAnsi maps typographic characters to WinAnsi bytes and the rest to ?', () => {
  const codes = (s) => Array.from(exp.toWinAnsi(s), (c) => c.charCodeAt(0));
  assert.deepEqual(codes('×–—’“”•°'), [0xd7, 0x96, 0x97, 0x92, 0x93, 0x94, 0x95, 0xb0]);
  assert.deepEqual(codes('‘…€™é'), [0x91, 0x85, 0x80, 0x99, 0xe9]);
  assert.equal(exp.toWinAnsi('34′ 5″'), '34\' 5"');
  assert.equal(exp.toWinAnsi('a\tb\nc\rd'), 'a b c d');
  assert.equal(exp.toWinAnsi('x\u0001\u0007y\u0085z'), 'xyz'); // control characters dropped
  assert.equal(exp.toWinAnsi('snow ☃ and 🎄!'), 'snow ? and ?!'); // one ? per character, even outside the BMP
  assert.equal(exp.toWinAnsi('\u00a0\u2009\u200b-\u2212\u00ad'), '\u00a0 --'); // nbsp kept, thin space → space, zero-width and soft hyphen dropped
  assert.equal(exp.toWinAnsi(null), '');
  assert.equal(exp.toWinAnsi(12.5), '12.5');
});

test('fromWinAnsi reverses the encoding', () => {
  const s = 'C9 × 25 – “warm” • 5° €12 — Noël';
  assert.equal(exp.fromWinAnsi(exp.toWinAnsi(s)), s);
});

test('textWidth uses the standard Helvetica AFM widths', () => {
  // Helvetica: H 722, e 556, l 222, o 556. Helvetica-Bold: H 722, e 556, l 278, o 611.
  assert.ok(Math.abs(exp.textWidth('Hello', 10, false) - 22.78) < 1e-9);
  assert.ok(Math.abs(exp.textWidth('Hello', 10, true) - 24.45) < 1e-9);
  assert.ok(Math.abs(exp.textWidth('W', 1000, false) - 944) < 1e-9);
  assert.ok(Math.abs(exp.textWidth(' ', 12, false) - 3.336) < 1e-9);
  assert.ok(Math.abs(exp.textWidth('×', 10, false) - 5.84) < 1e-9);
  assert.ok(Math.abs(exp.textWidth('—', 10, true) - 10) < 1e-9);
  assert.ok(Math.abs(exp.textWidth('′', 10, false) - exp.textWidth("'", 10, false)) < 1e-9);
  assert.equal(exp.textWidth('', 10, false), 0);
  assert.equal(exp.HELVETICA_WIDTHS.length, 224);
  assert.equal(exp.HELVETICA_BOLD_WIDTHS.length, 224);
});

test('textWidth matches reportlab for every printable WinAnsi character', { skip: !HAS_REPORTLAB && 'reportlab not installed' }, () => {
  const samples = ['The quick brown fox jumps over the lazy dog', 'C9 LED string, 25 bulbs - Warm white', '$1,234.56 (80%)', 'Noël · 5° × 3 – “quoted” — ‘ok’ • €',
    Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(''), Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)).filter((c) => c !== '\u00ad').join('')]; // soft hyphen is dropped on purpose
  const code = [
    'import sys, json', 'from reportlab.pdfbase.pdfmetrics import stringWidth',
    'items = json.loads(sys.stdin.read())',
    'print(json.dumps([[stringWidth(s, "Helvetica", 11), stringWidth(s, "Helvetica-Bold", 11)] for s in items]))',
  ].join('\n');
  const r = run('python3', ['-I', '-c', code], JSON.stringify(samples));
  assert.equal(r.status, 0, r.stderr);
  const ref = JSON.parse(r.stdout);
  samples.forEach((s, i) => {
    assert.ok(Math.abs(exp.textWidth(s, 11, false) - ref[i][0]) < 1e-6, 'regular: ' + s);
    assert.ok(Math.abs(exp.textWidth(s, 11, true) - ref[i][1]) < 1e-6, 'bold: ' + s);
  });
});

test('wrapText fits every line in maxWidth and keeps all words', () => {
  const text = 'Hang 2 × warm white C9 LED strings along Front eave, starting at the left end. Plug the first string into the cord.';
  const lines = exp.wrapText(text, 9, false, 150);
  assert.ok(lines.length > 2);
  for (const l of lines) assert.ok(exp.textWidth(l, 9, false) <= 150 + 1e-9, l);
  assert.equal(lines.join(' '), text);
  // explicit line breaks are kept; a word wider than the box is broken between characters
  assert.deepEqual(exp.wrapText('one\ntwo', 10, false, 500), ['one', 'two']);
  const long = exp.wrapText('W'.repeat(40), 10, true, 60);
  assert.ok(long.length > 1);
  for (const l of long) assert.ok(exp.textWidth(l, 10, true) <= 60 + 1e-9);
  assert.equal(long.join(''), 'W'.repeat(40));
  assert.deepEqual(exp.wrapText('', 10, false, 100), ['']);
  assert.deepEqual(exp.wrapText('34′ 5″', 10, false, 0), ['34\' 5"']);
});

// ---------------------------------------------------------------- pure helpers
test('slug, filenames and quote numbers', () => {
  assert.equal(exp.slug('123 Maple St.'), '123-maple-st');
  assert.equal(exp.slug('  Café Noël / Front yard!  '), 'cafe-noel-front-yard');
  assert.equal(exp.slug(''), 'project');
  assert.equal(exp.slug(null), 'project');
  assert.equal(exp.slug('★★★'), 'project');
  const long = exp.slug('a'.repeat(30) + ' ' + 'b'.repeat(30));
  assert.ok(long.length <= 40 && !long.endsWith('-'));
  const p = { id: 'prj_ab12cd', name: '123 Maple St' };
  assert.equal(exp.exportFilename(p, 'report'), 'lightplan-123-maple-st-report.pdf');
  assert.equal(exp.exportFilename(p, 'quote'), 'lightplan-123-maple-st-quote.pdf');
  assert.equal(exp.exportFilename(p, 'csv'), 'lightplan-123-maple-st-bom.csv');
  assert.equal(exp.exportFilename(p, 'json'), 'lightplan-123-maple-st-project.json');
  assert.equal(exp.exportFilename({}, 'report'), 'lightplan-project-report.pdf');
  assert.equal(exp.quoteNumber(p), 'Q-AB12CD');
  assert.equal(exp.quoteNumber({ id: 'prj_x-9' }), 'Q-X9');
  assert.equal(exp.quoteNumber({}), 'Q-DRAFT');
  assert.equal(exp.quoteNumber(null), 'Q-DRAFT');
});

test('money, number and date formatting', () => {
  assert.equal(exp.formatMoney(1234.5), '$1,234.50');
  assert.equal(exp.formatMoney(0), '$0.00');
  assert.equal(exp.formatMoney(-5), '-$5.00');
  assert.equal(exp.formatMoney(1.005), '$1.01');
  assert.equal(exp.formatMoney(-0.001), '$0.00');
  assert.equal(exp.formatMoney(1234567.891), '$1,234,567.89');
  assert.equal(exp.formatMoney(NaN), '—');
  assert.equal(exp.formatMoney(null), '—');
  assert.equal(exp.formatNumber(1234567.891, 1), '1,234,567.9');
  assert.equal(exp.formatNumber(999.96, 1), '1,000.0');
  assert.equal(exp.formatNumber(-0.04, 1), '0.0');
  assert.equal(exp.formatNumber(42), '42');
  assert.equal(exp.formatNumber('x'), '—');
  assert.equal(exp.formatDate(new Date(2026, 10, 9)), 'November 9, 2026');
  assert.equal(exp.formatDate(new Date(2027, 0, 31, 23, 59)), 'January 31, 2027');
  assert.equal(exp.formatDate('not a date'), '');
  assert.equal(exp.formatDate(null), '');
});

test('base64 and data URL decoding', () => {
  assert.deepEqual(Array.from(exp.base64ToBytes('AAEC/w==')), [0, 1, 2, 255]);
  assert.deepEqual(Array.from(exp.base64ToBytes('AAEC_w')), [0, 1, 2, 255]); // URL-safe, no padding
  assert.deepEqual(Array.from(exp.base64ToBytes('AA EC\n/w==')), [0, 1, 2, 255]);
  assert.deepEqual(Array.from(exp.dataUrlToBytes(JPEG_DATA_URL)), Array.from(JPEG));
  assert.equal(exp.dataUrlToBytes('data:text/plain,hello'), null);
  assert.equal(exp.dataUrlToBytes(42), null);
});

// ---------------------------------------------------------------- JPEG parsing
test('parseJpeg reads the frame header of a baseline JPEG (bytes or data URL)', () => {
  const info = exp.parseJpeg(JPEG);
  assert.deepEqual(info, { width: 8, height: 6, components: 3, bitsPerComponent: 8, colorSpace: 'DeviceRGB', adobe: false, progressive: false });
  assert.deepEqual(exp.parseJpeg(JPEG_DATA_URL), info);
  assert.deepEqual(exp.parseJpeg(JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength)), info);
});

test('parseJpeg rejects data that is not an embeddable JPEG', () => {
  assert.equal(exp.parseJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null); // PNG
  assert.equal(exp.parseJpeg(JPEG.slice(0, 40)), null); // truncated before the frame header
  assert.equal(exp.parseJpeg(new Uint8Array(0)), null);
  assert.equal(exp.parseJpeg(null), null);
  assert.equal(exp.parseJpeg('data:image/png;base64,iVBORw0KGgo='), null);
  // An arithmetic-coded frame (SOF9) is refused: many PDF readers cannot decode it.
  const sof = JPEG.indexOf(0xc0, 2);
  const arith = JPEG.slice();
  assert.equal(arith[sof - 1], 0xff);
  arith[sof] = 0xc9;
  assert.equal(exp.parseJpeg(arith), null);
});

test('parseJpeg handles grayscale, progressive and Adobe CMYK JPEGs', { skip: !PIL && 'python3 PIL not installed' }, () => {
  assert.equal(exp.parseJpeg(PIL.gray).colorSpace, 'DeviceGray');
  assert.equal(exp.parseJpeg(PIL.gray).components, 1);
  const prog = exp.parseJpeg(PIL.progressive);
  assert.equal(prog.progressive, true);
  assert.equal(prog.width, 40);
  assert.equal(prog.height, 30);
  const cmyk = exp.parseJpeg(PIL.cmyk);
  assert.equal(cmyk.colorSpace, 'DeviceCMYK');
  assert.equal(cmyk.components, 4);
  assert.equal(cmyk.adobe, true);
});

// ---------------------------------------------------------------- PdfDoc
test('PdfDoc writes top-left coordinates, alignment, colors, escaping and shapes', () => {
  const doc = new exp.PdfDoc({ size: 'letter' });
  assert.equal(doc.width, 612);
  assert.equal(doc.height, 792);
  doc.addPage();
  const r = doc.text('Hello', 100, 50, { size: 10, align: 'right', color: '#ff8000' });
  assert.deepEqual(r, { lines: 1, width: exp.textWidth('Hello', 10), height: 12 });
  const ops = doc.pages[0].ops;
  // Right edge at x = 100; baseline = top + (12 − 9.25)/2 + 7.18 = 58.555 → PDF y = 792 − 58.555.
  assert.equal(ops[0], 'BT /F1 10 Tf 1 0.502 0 rg 77.22 733.445 Td (Hello) Tj ET');
  doc.text('Hi', 0, 0, { size: 10, bold: true, align: 'center', maxWidth: 200 });
  const cx = Math.round(((200 - exp.textWidth('Hi', 10, true)) / 2) * 1000) / 1000;
  assert.equal(ops[1], 'BT /F2 10 Tf 0 0 0 rg ' + cx + ' 783.445 Td (Hi) Tj ET');
  doc.text('a(b)c\\d × é', 10, 10);
  assert.match(ops[2], /\(a\\\(b\\\)c\\\\d \\327 \\351\) Tj/);
  doc.line(10, 20, 110, 20, { width: 2, color: '#123' });
  assert.equal(ops[3], 'q 2 w 0.067 0.133 0.2 RG 10 772 m 110 772 l S Q');
  doc.rect(10, 20, 100, 50, { fill: '#ffffff' });
  assert.equal(ops[4], 'q 1 1 1 rg 10 722 100 50 re f Q');
  doc.rect(10, 20, 100, 50, { stroke: '#000000', width: 0.5 });
  assert.equal(ops[5], 'q 0 0 0 RG 0.5 w 10 722 100 50 re S Q');
  doc.rect(10, 20, 100, 50, { fill: '#ff0000', stroke: '#00ff00', radius: 6 });
  assert.match(ops[6], /^q 1 0 0 rg 0 1 0 RG 1 w 16 722 m .* c h B Q$/);
  doc.rect(0, 0, 10, 10);
  assert.match(ops[7], / re S Q$/); // no paint given → black stroke
  const wrapped = doc.text('one two three four five six', 40, 100, { size: 10, maxWidth: 60, maxLines: 2 });
  assert.equal(wrapped.lines, 2);
  assert.match(ops[ops.length - 1], /\\205\) Tj ET$/); // ellipsis on the cut line
});

test('PdfDoc builds a valid multi-page PDF with text, a table, unicode and a JPEG', () => {
  const doc = new exp.PdfDoc({ size: 'letter', title: 'Test – Noël ☃', creationDate: new Date(Date.UTC(2026, 10, 9, 12, 0, 0)) });
  doc.addPage();
  doc.text('LightPlan writer test', 40, 40, { size: 18, bold: true });
  doc.text('Unicode: 16′ × 7″ door – 25° pitch — “warm white” • it’s ‘fine’ … 5 €', 40, 70, { size: 11 });
  const para = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(12);
  doc.text(para, 40, 100, { size: 10, maxWidth: 300 });
  // a small table with right-aligned numbers
  const rows = [['C9 LED string', '8', '$32.99', '$263.92'], ['Mini LED string', '31', '$12.99', '$402.69'], ['Timer', '2', '$19.99', '$39.98']];
  let y = 300;
  doc.rect(40, y, 400, 16, { fill: '#f4f6f3' });
  ['Item', 'Qty', 'Unit price', 'Total'].forEach((h, i) => doc.text(h, [44, 250, 340, 436][i], y + 3, { size: 8, bold: true, align: i ? 'right' : 'left' }));
  for (const row of rows) {
    y += 18;
    row.forEach((c, i) => doc.text(c, [44, 250, 340, 436][i], y + 3, { size: 9, align: i ? 'right' : 'left' }));
    doc.line(40, y + 17, 440, y + 17, { width: 0.5, color: '#d5ddd8' });
  }
  const placed = doc.image(JPEG, 40, 400, 160);
  assert.equal(placed.width, 160);
  assert.equal(placed.height, 120); // aspect 6:8 kept
  doc.image(JPEG, 220, 400, 80, 60); // same bytes again → one XObject
  doc.addPage();
  doc.text('Second page', 40, 40, { size: 14 });
  doc.image(JPEG_DATA_URL, 40, 80, 64, 48);
  doc.addPage();
  doc.text('Third page (empty below)', 40, 40);
  assert.equal(doc.pageCount, 3);
  assert.equal(doc.images.length, 2); // byte array and data URL are separate sources
  doc.setPage(0);
  doc.text('Footer on page 1', 306, 760, { align: 'center', size: 8 });

  const bytes = doc.toBytes();
  assert.ok(bytes instanceof Uint8Array);
  const objects = checkXref(bytes);
  assert.equal(objects, 1 + 4 + 2 + 3 * 2 + 1); // free entry, catalog/pages/fonts, 2 images, 3 page+content pairs, info
  const file = writePdf('writer.pdf', bytes);

  if (HAS_PDFTOTEXT) {
    const text = pdfText(file);
    assert.match(text, /LightPlan writer test/);
    assert.match(text, /Unicode: 16' × 7" door – 25° pitch — “warm white” • it’s ‘fine’ … 5 €/);
    assert.match(text, /Lorem ipsum dolor sit amet/);
    assert.match(text, /\$402\.69/);
    assert.match(pdfText(file, 2), /Second page/);
    assert.match(pdfText(file, 1), /Footer on page 1/);
  }
  if (HAS_PYPDF) {
    const info = pypdfCheck(file);
    assert.equal(info.pages, 3);
    assert.equal(info.title, 'Test – Noël ☃');
    assert.equal(info.producer, 'LightPlan');
    assert.deepEqual(info.images[0], { name: '/Im1', w: 8, h: 6, cs: '/DeviceRGB', filter: '/DCTDecode', decode: null });
  }
});

test('PdfDoc embeds grayscale, progressive and CMYK JPEGs with the right color space', { skip: !PIL && 'python3 PIL not installed' }, () => {
  const doc = new exp.PdfDoc();
  doc.image(PIL.gray, 40, 40, 80);
  doc.image(PIL.progressive, 140, 40, 80);
  doc.image(PIL.cmyk, 240, 40, 80);
  const bytes = doc.toBytes();
  checkXref(bytes);
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /\/ColorSpace \/DeviceGray/);
  assert.match(text, /\/ColorSpace \/DeviceCMYK \/BitsPerComponent 8 \/Filter \/DCTDecode \/Decode \[1 0 1 0 1 0 1 0\]/);
  if (HAS_PYPDF) {
    const info = pypdfCheck(writePdf('jpegs.pdf', bytes));
    assert.deepEqual(info.images.map((i) => i.cs), ['/DeviceGray', '/DeviceRGB', '/DeviceCMYK']);
    assert.deepEqual(info.images[2].decode, [1, 0, 1, 0, 1, 0, 1, 0]);
  }
});

test('PdfDoc refuses pictures that are not JPEGs and still writes an empty document', () => {
  const doc = new exp.PdfDoc();
  assert.throws(() => doc.image(new Uint8Array([1, 2, 3]), 0, 0, 10, 10), /Only JPEG photos/);
  assert.throws(() => doc.image('data:image/png;base64,iVBORw0KGgo=', 0, 0, 10, 10), /Only JPEG photos/);
  const bytes = doc.toBytes(); // the failed image() added a page; nothing else
  checkXref(bytes);
  const empty = new exp.PdfDoc({ size: 'a4' }).toBytes();
  checkXref(empty);
  assert.match(Buffer.from(empty).toString('latin1'), /\/MediaBox \[0 0 595.28 841.89\]/);
  if (HAS_PYPDF) assert.equal(pypdfCheck(writePdf('empty.pdf', empty)).pages, 1);
});

// ---------------------------------------------------------------- report and quote layouts
test('buildReportPdf lays out the full report for the sample house', () => {
  const { project, plan } = sampleFixture();
  const image = PIL ? PIL.preview : JPEG;
  const doc = exp.buildReportPdf({ project, plan, image, date: DATE });
  const bytes = doc.toBytes();
  checkXref(bytes);
  const n = doc.pageCount;
  assert.ok(n >= 3, 'report has several pages');
  const file = writePdf('report.pdf', bytes);
  if (HAS_PYPDF) {
    const info = pypdfCheck(file);
    assert.equal(info.pages, n);
    assert.equal(info.title, 'LightPlan report - Sample house');
    assert.equal(info.images.length, 1);
  }
  if (!HAS_PDFTOTEXT) return;
  const all = pdfText(file);
  for (const s of ['LightPlan', 'Sample house', 'Dana Whitfield · 123 Maple St, Springfield', 'November 9, 2026', 'Summary', 'Measurements',
    'Bill of materials', 'Power plan', 'Circuits', 'Outlets', 'Cords', 'Listed in the order they are put up', 'PLUGS INTO', 'CORD AND ROUTE',
    'Cords to outlets', 'Jumper cords', '3-way taps', 'Measurements to double-check', 'Warnings', 'Install checklist', 'About this plan',
    'Subtotal', exp.formatMoney(plan.bom.subtotal), 'Porch circuit', 'Garage outlet', '1,440 W', 'Front eave', 'Walkway right edge']) {
    assert.ok(all.includes(s), 'report mentions ' + s);
  }
  for (const line of plan.bom.lines) assert.ok(all.includes(exp.formatMoney(line.lineTotal)), 'BOM total ' + line.lineTotal);
  assert.ok(all.includes('Plug an outdoor timer'), 'checklist steps are listed');
  assert.ok(/34' 0"/.test(all), 'ft-in lengths use straight quotes after WinAnsi mapping');
  // Footer on every page.
  for (let p = 1; p <= n; p++) {
    const t = pdfText(file, p);
    assert.ok(t.includes('Planning estimate, not an electrical inspection.'), 'footer disclaimer on page ' + p);
    assert.ok(t.includes('Page ' + p + ' of ' + n), 'page number on page ' + p);
  }
  // The measurements table runs over a page break and repeats its header there.
  const runPages = [];
  for (let p = 1; p <= n; p++) {
    const t = pdfText(file, p);
    if (/Front eave|Walkway right edge|Bush 2/.test(t) && /CONFIDENCE/.test(t)) runPages.push(p);
  }
  assert.ok(runPages.length >= 2, 'measurement rows on two pages, each with the header: ' + runPages);
});

test('report tables right-align their number columns', { skip: !HAS_PDFTOTEXT && 'pdftotext not installed' }, () => {
  const { project, plan } = sampleFixture();
  const file = writePdf('report-align.pdf', exp.buildReportPdf({ project, plan, image: null, date: DATE }).toBytes());
  const r = run('pdftotext', ['-bbox', file, '-']);
  assert.equal(r.status, 0);
  // Money words in the BOM's line-total column (the rightmost column) share one right edge.
  const words = Array.from(r.stdout.matchAll(/<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">(\$[\d,]+\.\d\d)<\/word>/g))
    .map((m) => ({ xMax: Number(m[2]), text: m[3] }));
  const rightCol = words.filter((w) => w.xMax > 540);
  assert.ok(rightCol.length >= plan.bom.lines.length, 'found the line-total column');
  const edges = rightCol.map((w) => w.xMax);
  assert.ok(Math.max(...edges) - Math.min(...edges) < 0.6, 'right edges align: ' + edges.join(', '));
});

test('buildReportPdf never throws on empty or damaged data', () => {
  const cases = [
    {},
    { project: null, plan: null },
    { project: { name: 'Empty' }, plan: planModule.computePlan(schema.createProject({ now: '2026-11-09T00:00:00.000Z' })) },
    { project: { name: 'Broken', features: 'x', planes: [null], images: [{ id: 'i' }] }, plan: { runs: 'nope', power: 5, bom: { lines: [null, { name: 3 }] }, summary: [], checklist: [{ steps: 'x' }], warnings: [null, { level: 'odd', message: 'Odd' }] }, image: new Uint8Array([1, 2]) },
  ];
  cases.forEach((c, i) => {
    const doc = exp.buildReportPdf(c);
    const bytes = doc.toBytes();
    checkXref(bytes);
    if (HAS_PYPDF) assert.ok(pypdfCheck(writePdf('report-edge-' + i + '.pdf', bytes)).pages >= 1);
    if (HAS_PDFTOTEXT) {
      const t = pdfText(writePdf('report-edge-' + i + '.pdf', bytes));
      assert.ok(t.includes('Planning estimate, not an electrical inspection.'));
    }
  });
  if (HAS_PDFTOTEXT) {
    const t = pdfText(writePdf('report-empty.pdf', exp.buildReportPdf(cases[2]).toBytes()));
    assert.ok(t.includes('Nothing traced yet'));
    assert.ok(t.includes('No photo in this project yet'));
  }
});

test('buildQuotePdf makes a one-page customer quote', () => {
  const { project, plan } = sampleFixture();
  const doc = exp.buildQuotePdf({ project, plan, image: PIL ? PIL.preview : JPEG, date: DATE });
  assert.equal(doc.pageCount, 1);
  const bytes = doc.toBytes();
  checkXref(bytes);
  const file = writePdf('quote.pdf', bytes);
  if (HAS_PYPDF) {
    const info = pypdfCheck(file);
    assert.equal(info.pages, 1);
    assert.equal(info.title, 'Quote Q-SAMPLE - Bright Nights Lighting Co.');
    assert.equal(info.images.length, 1);
  }
  if (!HAS_PDFTOTEXT) return;
  const t = pdfText(file);
  for (const s of ['Bright Nights Lighting Co.', 'QUOTE', 'Q-SAMPLE', 'November 9, 2026', 'December 9, 2026', 'PREPARED FOR', 'Dana Whitfield',
    '123 Maple St, Springfield', 'dana@example.com', 'WHAT IS INCLUDED', 'Rooflines and eaves', 'Total', exp.formatMoney(plan.quote.total),
    'valid for 30 days', 'Install the week after Thanksgiving', 'Signature', 'not an electrical inspection', 'Page 1 of 1']) {
    assert.ok(t.includes(s), 'quote mentions ' + s);
  }
  for (const l of plan.quote.lines) assert.ok(t.includes(exp.formatMoney(l.amount)), 'quote line ' + l.description);
  assert.ok(!t.includes('Co..'), 'no doubled period after the company name');
});

test('buildQuotePdf flows long notes onto more pages with footers and survives bad data', () => {
  const { project, plan } = sampleFixture((p) => { p.quote.notes = 'Includes a free mid-season bulb check. '.repeat(80); p.quote.company = ''; });
  const doc = exp.buildQuotePdf({ project, plan, image: null, date: DATE });
  assert.ok(doc.pageCount >= 2);
  const file = writePdf('quote-long.pdf', doc.toBytes());
  if (HAS_PYPDF) assert.equal(pypdfCheck(file).pages, doc.pageCount);
  if (HAS_PDFTOTEXT) {
    for (let p = 1; p <= doc.pageCount; p++) assert.ok(pdfText(file, p).includes('Page ' + p + ' of ' + doc.pageCount));
    assert.ok(pdfText(file, 1).includes('Holiday lighting quote'), 'falls back to a generic title without a company');
  }
  for (const c of [{}, { project: { quote: 7 }, plan: { quote: { lines: 'x' } } }]) checkXref(exp.buildQuotePdf(c).toBytes());
});

// ---------------------------------------------------------------- saving files
function withGlobals(t, globals) {
  const saved = {};
  for (const k of Object.keys(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: globals[k], configurable: true, writable: true });
  }
  exp._resetDownloads();
  t.after(() => {
    for (const k of Object.keys(globals)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
    exp._resetDownloads();
  });
}
/** A fake window.claude whose downloads.save records calls and answers with `answer(req)`. */
function fakeClaude(answer, opts) {
  const calls = { use: 0, saves: [] };
  const downloads = { save: (req) => { calls.saves.push(req); return answer(req); } };
  const claude = {
    use: (name) => {
      calls.use += 1;
      if (opts && opts.never) return new Promise(() => {});
      return Promise.resolve(name === 'downloads' && !(opts && opts.nullUse) ? downloads : null);
    },
  };
  return { claude, calls };
}
function fakeDocument() {
  const clicks = [];
  const body = { children: [], appendChild(el) { this.children.push(el); el.parentNode = this; }, removeChild(el) { this.children = this.children.filter((c) => c !== el); } };
  return {
    clicks,
    body,
    document: { body, createElement: (tag) => ({ tag, style: {}, click() { clicks.push({ href: this.href, download: this.download }); } }) },
  };
}

test('saveFile hands a Blob to downloads.save and caches use()', async (t) => {
  const { claude, calls } = fakeClaude(() => Promise.resolve({ status: 'saved' }));
  withGlobals(t, { window: { claude } });
  assert.equal(await exp.saveFile('a.csv', 'x,y\r\n', 'text/csv'), 'saved');
  assert.equal(await exp.saveFile('b.pdf', new Uint8Array([37, 80, 68, 70]), 'application/pdf'), 'saved');
  assert.equal(calls.use, 1, 'use() is asked once');
  assert.equal(calls.saves[0].filename, 'a.csv');
  assert.ok(calls.saves[0].data instanceof Blob);
  assert.equal(await calls.saves[0].data.text(), 'x,y\r\n');
  assert.equal(await calls.saves[1].data.text(), '%PDF');
});

test('saveFile resolves declined quietly, busy for rate_limited and failed for other refusals', async (t) => {
  let code = 'declined';
  const { claude } = fakeClaude(() => Promise.reject({ code, message: 'no' }));
  withGlobals(t, { window: { claude } });
  assert.equal(await exp.saveFile('a.pdf', 'x', 'application/pdf'), 'declined');
  code = 'rate_limited';
  assert.equal(await exp.saveFile('a.pdf', 'x', 'application/pdf'), 'busy');
  code = 'rejected_extension';
  assert.equal(await exp.saveFile('a.exe', 'x', 'application/pdf'), 'failed');
});

// Inside the viewer (window.claude present) a null use() is 'unavailable' (tests/ui-export-review.test.js): the
// <a download> fallback is for the standalone file, where there is no window.claude.
test('saveFile falls back to an <a download> click when there is no window.claude', async (t) => {
  const fd = fakeDocument();
  const revoked = [];
  const created = [];
  const FakeURL = { createObjectURL: (b) => { created.push(b); return 'blob:fake/1'; }, revokeObjectURL: (u) => revoked.push(u) };
  withGlobals(t, { window: {}, document: fd.document, URL: FakeURL });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = await exp.saveFile('lightplan-x-bom.csv', 'a,b', 'text/csv');
  assert.equal(result, 'saved');
  assert.deepEqual(fd.clicks, [{ href: 'blob:fake/1', download: 'lightplan-x-bom.csv' }]);
  assert.equal(await created[0].text(), 'a,b');
  t.mock.timers.tick(6000);
  assert.deepEqual(revoked, ['blob:fake/1']);
  assert.equal(fd.body.children.length, 0, 'the temporary link is removed');
});

test('saveFile without window.claude uses the fallback, and reports failed with no DOM', async (t) => {
  withGlobals(t, { window: {}, document: undefined });
  assert.equal(await exp.saveFile('a.json', '{}', 'application/json'), 'failed');
});

test('initDownloads gives up on a use() that never answers (inside the viewer saving is then unavailable)', async (t) => {
  const { claude } = fakeClaude(() => Promise.resolve({ status: 'saved' }), { never: true });
  const fd = fakeDocument();
  withGlobals(t, { window: { claude }, document: fd.document, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} } });
  assert.equal(await exp.initDownloads({ timeoutMs: 15 }), null);
  assert.equal(await exp.saveFile('a.csv', 'x', 'text/csv'), 'unavailable');
  assert.equal(fd.clicks.length, 0, 'no blocked blob link is clicked inside the viewer');
});

// ---------------------------------------------------------------- store-level exports
function fakeStore(project, extra) {
  let plan = null;
  return Object.assign({
    project: () => project,
    plan: () => plan || (plan = planModule.computePlan(project)),
    getImage: () => null,
    getImageData: () => null,
  }, extra || {});
}
function captureSaves(t) {
  const { claude, calls } = fakeClaude(() => Promise.resolve({ status: 'saved' }));
  withGlobals(t, { window: { claude } });
  return calls;
}

test('exportCsv saves the BOM as CSV with a UTF-8 byte-order mark', async (t) => {
  const calls = captureSaves(t);
  const { project, plan } = sampleFixture((p) => { p.name = '123 Maple St'; });
  assert.equal(await exp.exportCsv(fakeStore(project)), 'saved');
  const save = calls.saves[0];
  assert.equal(save.filename, 'lightplan-123-maple-st-bom.csv');
  const bytes = new Uint8Array(await save.data.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.slice(3));
  assert.ok(text.startsWith('SKU,Item,Category,Qty,Unit,Unit Price,Line Total,Notes\r\n'));
  assert.equal(text, LP.require('bom').bomToCsv(plan.bom));
});

test('exportJson saves the project, plan and photos, and importJsonFile reads it back', async (t) => {
  const calls = captureSaves(t);
  const { project } = sampleFixture((p) => {
    p.name = 'Maple house';
    p.images[0].storageKey = 'img_upload';
    p.images[0].source.kind = 'upload';
  });
  const store = fakeStore(project, { getImageData: (id) => (id === project.images[0].id ? JPEG_DATA_URL : null) });
  assert.equal(await exp.exportJson(store), 'saved');
  const save = calls.saves[0];
  assert.equal(save.filename, 'lightplan-maple-house-project.json');
  const json = await save.data.text();
  const data = JSON.parse(json);
  assert.equal(data.schema, 'lightplan/export');
  assert.match(data.exportedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(data.images, { img_upload: JPEG_DATA_URL });
  assert.ok(data.derived && Array.isArray(data.derived.runs) && data.derived.summary, 'plan is included as derived');
  assert.equal(data.project.id, project.id);

  const back = await exp.importJsonFile({ text: () => Promise.resolve(json) });
  assert.equal(back.project.name, 'Maple house');
  assert.equal(back.project.features.length, project.features.length);
  assert.deepEqual(back.images, { img_upload: JPEG_DATA_URL });

  assert.equal(await exp.exportJson(store, { includeImages: false }), 'saved');
  assert.deepEqual(JSON.parse(await calls.saves[1].data.text()).images, {});
});

test('collectImages falls back to stored photos and skips what it cannot read', async () => {
  const project = { images: [{ id: 'a', storageKey: 'k1' }, { id: 'b', storageKey: 'sample', source: { kind: 'sample' } }, { id: 'c', storageKey: null }] };
  const images = await exp.collectImages({ getImageData: (id) => (id === 'a' ? JPEG_DATA_URL : null), getImage: () => null }, project);
  assert.deepEqual(images, { k1: JPEG_DATA_URL }); // the sample cannot be re-rendered without a DOM
  assert.deepEqual(await exp.collectImages(null, null), {});
});

test('importJsonFile rejects files that are not LightPlan projects with a plain message', async () => {
  await assert.rejects(exp.importJsonFile({ text: () => Promise.resolve('not json') }), /not a LightPlan project/);
  await assert.rejects(exp.importJsonFile({ text: () => Promise.resolve('{"hello": 1}') }), /not a LightPlan project/);
  await assert.rejects(exp.importJsonFile({ text: () => Promise.reject(new Error('io')) }), /could not be read/);
  await assert.rejects(exp.importJsonFile(null), /Choose a LightPlan project file/);
});

test('exportPdfReport and exportQuotePdf save PDFs named after the project', async (t) => {
  const calls = captureSaves(t);
  const { project } = sampleFixture((p) => { p.name = 'Maple house'; });
  const store = fakeStore(project);
  assert.equal(await exp.exportPdfReport(store), 'saved');
  assert.equal(await exp.exportQuotePdf(store), 'saved');
  assert.deepEqual(calls.saves.map((s) => s.filename), ['lightplan-maple-house-report.pdf', 'lightplan-maple-house-quote.pdf']);
  for (const s of calls.saves) {
    const bytes = new Uint8Array(await s.data.arrayBuffer());
    checkXref(bytes);
  }
  if (HAS_PDFTOTEXT) {
    const t1 = pdfText(writePdf('store-report.pdf', new Uint8Array(await calls.saves[0].data.arrayBuffer())));
    assert.ok(t1.includes('The preview picture could not be made'), 'no preview module in Node: the report says so and carries on');
  }
});

test('exports reject with a plain message when there is nothing to export', async (t) => {
  captureSaves(t);
  await assert.rejects(exp.exportPdfReport(fakeStore(null)), /no project to export yet/);
  await assert.rejects(exp.exportCsv({ project: () => undefined }), /no project to export yet/);
  await assert.rejects(exp.exportJson(null), /no project to export yet/);
  const { project } = sampleFixture((p) => { p.quote.enabled = false; });
  await assert.rejects(exp.exportQuotePdf(fakeStore(project)), /Turn on installer mode/);
});

test('exports still work when the plan cannot be computed', async (t) => {
  const calls = captureSaves(t);
  const { project } = sampleFixture();
  const store = fakeStore(project, { plan: () => { throw new Error('boom'); } });
  assert.equal(await exp.exportPdfReport(store), 'saved');
  assert.equal(await exp.exportCsv(store), 'saved');
  assert.equal(await exp.exportJson(store), 'saved');
  checkXref(new Uint8Array(await calls.saves[0].data.arrayBuffer()));
  assert.equal(JSON.parse(await calls.saves[2].data.text()).derived, null);
});

// ---------------------------------------------------------------- suppliers in the exports (SPEC §8.3, §8.5)
const suppliers = LP.require('suppliers');
const bomModule = LP.require('bom');
const SUPPLIER_IDS = suppliers.SUPPLIERS.map((s) => s.id).filter((id) => id !== suppliers.GENERIC_ID);
const PRICE_DATE = suppliers.formatDate(suppliers.PRICE_AS_OF);   // "Nov 11, 2026"
/** The sample planned for a supplier (installer mode as in sampleFixture unless `mutate` says otherwise). */
function supplierFixture(supplierId, buying, mutate) {
  return sampleFixture((p) => {
    p.library = { products: null, config: buying ? { buying } : null, supplierId };
    if (mutate) mutate(p);
  });
}
/** RFC 4180 rows of a CSV text (quoted fields, doubled quotes, CRLF). */
function csvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const hostOfLink = (u) => (/^https:\/\/([^/:?#]+)/.exec(u) || [])[1] || '';

test('PdfDoc.link adds a clickable area for a plain https address and ignores anything else', () => {
  const doc = new exp.PdfDoc({ size: 'letter' });
  doc.addPage();
  assert.equal(doc.link(40, 100, 200, 12, 'https://www.christmaslightsetc.com/p/C9-(Warm)-White.htm'), true);
  assert.equal(doc.link(40, 120, 200, 12, 'javascript:alert(1)'), false);
  assert.equal(doc.link(40, 120, 200, 12, 'http://example.com/'), false);
  assert.equal(doc.link(40, 120, 0, 12, 'https://example.com/'), false, 'an empty box is not a link');
  assert.equal(doc.link(40, 120, 200, 12, 'https://example.com/é'), false, 'only printable ASCII goes into a link');
  doc.addPage();
  const bytes = doc.toBytes();
  checkXref(bytes);
  const text = Buffer.from(bytes).toString('latin1');
  // Top-left (40, 100), 200 × 12 → PDF rectangle [40 680 240 692] on a letter page; parentheses are escaped.
  assert.ok(text.includes('/Annots [<< /Type /Annot /Subtype /Link /Rect [40 680 240 692] /Border [0 0 0] /A << /S /URI /URI (https://www.christmaslightsetc.com/p/C9-\\(Warm\\)-White.htm) >> >>]'));
  assert.equal(text.split('/Subtype /Link').length - 1, 1, 'one link, on the first page only');
  if (HAS_PYPDF) assert.equal(pypdfCheck(writePdf('links.pdf', bytes)).pages, 2);
});

test('8.3 the shopping-list CSV gains Supplier, Part number, Price status and Link columns when a supplier is chosen', async (t) => {
  const calls = captureSaves(t);
  for (const sid of SUPPLIER_IDS) {
    const { project, plan } = supplierFixture(sid);
    assert.equal(await exp.exportCsv(fakeStore(project)), 'saved');
    const text = new TextDecoder().decode(new Uint8Array(await calls.saves[calls.saves.length - 1].data.arrayBuffer())).replace(/^﻿/, '');
    const rows = csvRows(text);
    assert.deepEqual(rows[0], ['SKU', 'Item', 'Category', 'Qty', 'Unit', 'Unit Price', 'Line Total', 'Notes', 'Supplier', 'Part number', 'Price status', 'Link']);
    const col = (name) => rows[0].indexOf(name);
    plan.bom.lines.forEach((l, i) => {
      const r = rows[i + 1];
      assert.equal(r[col('Item')], l.name);
      assert.equal(r[col('Qty')], String(l.qty));
      assert.equal(r[col('Supplier')], l.supplierName);
      assert.equal(r[col('Part number')], l.supplierSku || '');
      assert.equal(r[col('Link')], l.url || l.findUrl || '');
      if (l.supplierId) {
        assert.equal(r[col('Supplier')], suppliers.getSupplier(sid).name);
        assert.ok(r[col('Price status')].startsWith('as of ' + PRICE_DATE), 'a supplier price says when it was seen: ' + r[col('Price status')]);
        assert.ok(suppliers.linkHosts().includes(hostOfLink(r[col('Link')])), 'the link is on the supplier\'s own site');
      } else assert.equal(r[col('Supplier')], 'Any store');
    });
    assert.ok(plan.bom.lines.some((l) => l.supplierSku), 'the plan has part numbers to print');
    assert.ok(text.includes('Prices were last checked on ' + PRICE_DATE + '; confirm at checkout.'));
  }
});

test('8.5 exportOrderCsv saves one supplier\'s order sheet, with quantities equal to the shopping list', async (t) => {
  const calls = captureSaves(t);
  for (const sid of SUPPLIER_IDS) {
    const { project, plan } = supplierFixture(sid, null, (p) => { p.name = 'Maple house'; });
    const store = fakeStore(project);
    assert.equal(await exp.exportOrderCsv(store, sid), 'saved');
    const save = calls.saves[calls.saves.length - 1];
    assert.equal(save.filename, 'lightplan-maple-house-order-' + exp.slug(suppliers.getSupplier(sid).name) + '.csv');
    const bytes = new Uint8Array(await save.data.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf], 'a byte-order mark, like the shopping-list CSV');
    const rows = csvRows(new TextDecoder().decode(bytes.slice(3)));
    assert.deepEqual(rows[0], ['Part number', 'Item', 'Qty', 'Unit', 'Unit Price', 'Total', 'Price status', 'Link', 'Notes']);
    const mine = plan.bom.lines.filter((l) => l.supplierId === sid);
    assert.ok(mine.length > 3);
    mine.forEach((l, i) => {
      assert.deepEqual(rows[i + 1].slice(0, 3), [l.supplierSku, l.name, String(l.qty)], 'part number, item and quantity of ' + l.name);
      assert.equal(rows[i + 1][7], l.url);
    });
    assert.equal(rows[mine.length + 1].join(''), '', 'a blank row after the lines');
    assert.deepEqual(rows[mine.length + 2].slice(0, 2), ['Subtotal', mine.reduce((s, l) => s + l.buyTotal, 0).toFixed(2)]);
    // The any-store sheet is everything else.
    assert.equal(await exp.exportOrderCsv(store, 'generic'), 'saved');
    const any = calls.saves[calls.saves.length - 1];
    assert.equal(any.filename, 'lightplan-maple-house-order-any-store.csv');
    const anyRows = csvRows(new TextDecoder().decode(new Uint8Array(await any.data.arrayBuffer()).slice(3)));
    const rest = plan.bom.lines.filter((l) => !l.supplierId);
    rest.forEach((l, i) => assert.deepEqual(anyRows[i + 1].slice(0, 3), ['', l.name, String(l.qty)]));
    const other = SUPPLIER_IDS.find((x) => x !== sid);
    await assert.rejects(exp.exportOrderCsv(store, other), /nothing to order from that supplier/);
  }
  await assert.rejects(exp.exportOrderCsv(fakeStore(null), 'cle'), /no project to export yet/);
});

test('8.5 the report\'s materials table shows supplier and part number, the price sentence, and a "Where to buy" block with every link', { skip: !HAS_PDFTOTEXT && 'pdftotext not installed' }, () => {
  for (const sid of SUPPLIER_IDS) {
    const { project, plan } = supplierFixture(sid, null, (p) => { p.quote.enabled = false; });
    const s = suppliers.getSupplier(sid);
    const doc = exp.buildReportPdf({ project, plan, image: null, date: DATE });
    const bytes = doc.toBytes();
    checkXref(bytes);
    const file = writePdf('report-' + sid + '.pdf', bytes);
    if (HAS_PYPDF) assert.equal(pypdfCheck(file).pages, doc.pageCount);
    const all = pdfText(file);
    const flat = all.replace(/\s+/g, ' ');
    // A homeowner's report says "Shopping list"; the materials table names the supplier and the part number.
    assert.ok(all.includes('Shopping list') && !all.includes('Bill of materials'));
    assert.ok(all.includes('WHERE TO BUY') && !/\bSKU\b/.test(all), 'the column is "Where to buy", and no "SKU" anywhere');
    const mine = plan.bom.lines.filter((l) => l.supplierId === sid);
    for (const l of mine) assert.ok(all.includes('Part number ' + l.supplierSku), 'part number ' + l.supplierSku);
    assert.ok(all.includes('as of ' + PRICE_DATE + ' · checked'));
    assert.ok(all.includes('typical price'), 'any-store lines say their price is a typical one');
    // Under the table.
    assert.ok(flat.includes('Prices were last checked on ' + PRICE_DATE + '; confirm at checkout.'));
    // Where to buy: site, phone, the sentence about the prices, and the link of every line.
    const where = flat.slice(flat.indexOf('Where to buy'), flat.indexOf('Power plan'));
    assert.ok(where.includes(s.name) && where.includes('Site: ' + s.url), 'the supplier and its site');
    assert.ok(where.includes('Phone ' + s.wholesale.phone));
    assert.ok(where.includes(exp.priceSentence(mine).replace(/\s+/g, ' ')), 'the price sentence for its lines');
    assert.equal(where.includes('Business accounts: '), !!s.wholesale.url, 'an account link only when the supplier has an account page');
    assert.ok(where.includes(plan.bom.lines.filter((l) => l.supplierId === sid).length + ' items'));
    assert.ok(where.includes('Any store') && where.includes('No part number is on file for these at ' + s.name));
    const raw = Buffer.from(bytes).toString('latin1');
    const linked = Array.from(raw.matchAll(/\/S \/URI \/URI \(([^)]*)\)/g)).map((m) => m[1].replace(/\\([()\\])/g, '$1'));
    for (const l of plan.bom.lines) {
      const u = l.url || l.findUrl;
      if (u) assert.ok(linked.includes(u), 'the report links to ' + u);
    }
    assert.ok(linked.includes(s.url));
    assert.ok(linked.every((u) => suppliers.linkHosts().includes(hostOfLink(u))), 'every link in the report is on a supplier\'s own site');
    // A search link that was never confirmed says so.
    const unsure = plan.bom.lines.some((l) => !l.url && l.findUrl && s.searchUrlTemplate && l.findUrl.startsWith(s.searchUrlTemplate.split('{query}')[0])) && s.searchUrlWorks !== true;
    assert.equal(where.includes('About the search links: '), unsure);
    assert.ok(flat.includes('Supplier prices are the public prices seen on the date shown'), 'the About box no longer calls every price typical retail');
  }
  // Installer mode keeps "Bill of materials"; cost basis "used" explains the two totals.
  const used = supplierFixture('cle', { costBasis: 'used' });
  const t2 = pdfText(writePdf('report-used.pdf', exp.buildReportPdf({ project: used.project, plan: used.plan, image: null, date: DATE }).toBytes()));
  assert.ok(t2.includes('Bill of materials') && !t2.includes('Shopping list'));
  const share = used.plan.bom.lines.find((l) => l.usedQty < l.qty);
  assert.ok(t2.includes('to order: ' + exp.formatMoney(share.buyTotal)) && t2.includes(exp.formatMoney(share.lineTotal)));
  assert.ok(t2.replace(/\s+/g, ' ').includes('Line totals count only the share of the wire, bulbs and plugs that this job uses'));
  // Any store: the Phase 1 report, with no supplier block and no links.
  const plain = sampleFixture((p) => { p.quote.enabled = false; });
  const plainBytes = exp.buildReportPdf({ project: plain.project, plan: plain.plan, image: null, date: DATE }).toBytes();
  const t3 = pdfText(writePdf('report-plain.pdf', plainBytes));
  assert.ok(t3.includes('Shopping list') && !t3.includes('Where to buy') && !t3.includes('Prices were last checked'));
  assert.ok(!Buffer.from(plainBytes).toString('latin1').includes('/Subtype /Link'));
  assert.ok(t3.includes('Prices are typical retail and change often.'));
});

test('8.5 the customer quote never shows a supplier, a part number, a link or a supplier unit price', () => {
  for (const sid of SUPPLIER_IDS) {
    for (const buying of [null, { style: 'strings' }, { costBasis: 'used' }]) {
      const { project, plan } = supplierFixture(sid, buying);
      const mine = plan.bom.lines.filter((l) => l.supplierId === sid);
      assert.ok(mine.length > 3, 'the plan really buys from ' + sid);
      const bytes = exp.buildQuotePdf({ project, plan, image: null, date: DATE }).toBytes();
      checkXref(bytes);
      const raw = Buffer.from(bytes).toString('latin1');
      const text = HAS_PDFTOTEXT ? pdfText(writePdf('quote-' + sid + '.pdf', bytes)) : '';
      for (const hay of [raw, text]) {
        for (const s of suppliers.SUPPLIERS.filter((x) => x.id !== suppliers.GENERIC_ID)) {
          assert.ok(!hay.includes(s.name), 'no supplier name (' + s.name + ')');
          assert.ok(!hay.includes(s.short), 'no supplier short name (' + s.short + ')');
          assert.ok(!hay.includes(hostOfLink(s.url).replace(/^www\./, '')), 'no supplier site');
          if (s.wholesale) assert.ok(!hay.includes(s.wholesale.phone), 'no supplier phone');
        }
        assert.ok(!/Any store|Part number|part number|as of |checked|wholesale|https?:/i.test(hay), 'no supplier wording or link');
        assert.ok(!hay.includes('/Subtype /Link'));
        for (const l of mine) assert.ok(!hay.includes(l.supplierSku), 'no part number (' + l.supplierSku + ')');
      }
      if (text) {
        // The only amounts are the quote's own lines: no supplier unit price leaks in.
        const amounts = new Set(plan.quote.lines.map((l) => exp.formatMoney(l.amount)));
        const shown = text.match(/\$[\d,]+\.\d\d/g) || [];
        assert.ok(shown.length >= plan.quote.lines.length);
        for (const a of shown) assert.ok(amounts.has(a), 'the quote shows ' + a + ', which is not one of its own lines');
        assert.ok(text.includes(exp.formatMoney(plan.quote.total)));
      }
    }
  }
});
