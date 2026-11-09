// Regression tests for export review findings: the report's circuit sentence, one cord length per cord, the quote's
// running header, and saving inside the viewer (no blob fallback there, distinct refusals, one save at a time).
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lightplan-export-review-'));
const HAS_PDFTOTEXT = (() => { const r = spawnSync('pdftotext', ['-v']); return !r.error && r.status === 0; })();
const DATE = new Date(2026, 10, 9, 10, 30, 0);

function pdfText(doc, name, extra) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, doc.toBytes());
  const r = spawnSync('pdftotext', (extra || []).concat([file, '-']), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function fixture(mutate) {
  const project = JSON.parse(JSON.stringify(sampleModule.createSample({ traced: true }).project));
  if (mutate) mutate(project);
  return { project, plan: planModule.computePlan(project) };
}

test('electrical:U2 the report does not claim every circuit is within 80% when one is overloaded', { skip: !HAS_PDFTOTEXT }, () => {
  const { project, plan } = fixture((p) => {
    p.features = p.features.filter((f) => f.id === 'ft_eave');
    p.features[0].overrideFt = 300;
    p.features[0].productId = 'c9-incan';
    p.outlets = p.outlets.filter((o) => o.id === 'out_porch');
  });
  assert.ok(plan.power.circuits.some((c) => c.overloaded), 'the fixture overloads a circuit');
  const text = pdfText(exp.buildReportPdf({ project, plan, image: null, date: DATE }), 'u2.pdf').replace(/\s+/g, ' ');
  assert.ok(!/Each circuit is kept at or below/.test(text), 'no blanket 80% claim');
  assert.ok(/over its safe limit/i.test(text), 'it says which circuit is over its limit');
  // The sample house (no overload) still states the rule.
  const ok = fixture();
  const okText = pdfText(exp.buildReportPdf({ project: ok.project, plan: ok.plan, image: null, date: DATE }), 'u2-ok.pdf').replace(/\s+/g, ' ');
  assert.ok(/Each circuit is kept at or below 80%/.test(okText));
});

test('data-export:F10 the cord table and the checklist give the same length for each cord', { skip: !HAS_PDFTOTEXT }, () => {
  const { project, plan } = fixture();
  const text = pdfText(exp.buildReportPdf({ project, plan, image: null, date: DATE }), 'f10.pdf').replace(/\s+/g, ' ');
  const feeds = plan.power.feeds.filter((f) => f.cord && f.cord.lengthFt > 0);
  assert.ok(feeds.length > 2);
  for (const f of feeds) {
    const up = Math.ceil(f.cord.lengthFt);
    assert.ok(text.includes('Needs ' + up + ' ft'), 'the cord table rounds ' + f.cord.lengthFt + ' ft up to ' + up);
    const down = Math.round(f.cord.lengthFt);
    if (down !== up) assert.ok(!text.includes('Needs ' + down + ' ft,') || feeds.some((g) => Math.ceil(g.cord.lengthFt) === down), 'no rounded-down ' + down + ' ft');
  }
});

test('data-export:F12 the quote running header stays inside the right margin with a long company name', { skip: !HAS_PDFTOTEXT }, () => {
  const { project, plan } = fixture((p) => {
    p.quote.enabled = true;
    p.quote.company = 'A'.repeat(60) + ' Holiday Lighting and Seasonal Decorating Company of the Greater Springfield Area';
    p.quote.notes = 'Long notes. '.repeat(180);
  });
  const doc = exp.buildQuotePdf({ project, plan, image: null, date: DATE });
  assert.ok(doc.pageCount >= 2);
  const file = path.join(TMP, 'f12.pdf');
  fs.writeFileSync(file, doc.toBytes());
  const r = spawnSync('pdftotext', ['-bbox', '-f', '2', '-l', '2', file, '-'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const words = Array.from(r.stdout.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g))
    .map((m) => ({ xMax: Number(m[3]), yMin: Number(m[2]), text: m[5] }));
  const header = words.filter((w) => w.yMin < 40);
  assert.ok(header.length > 0, 'page 2 has a running header');
  for (const w of header) assert.ok(w.xMax <= 612 - 54 + 0.5, 'header word "' + w.text + '" ends at ' + w.xMax);
  assert.ok(header.some((w) => /Q-/.test(w.text)), 'the quote number stays visible');
});

// ---------------------------------------------------------------- saving inside the viewer
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
function fakeDocument() {
  const clicks = [];
  const body = { appendChild(el) { el.parentNode = this; }, removeChild() {} };
  return { clicks, document: { body, createElement: (tag) => ({ tag, style: {}, click() { clicks.push(this.download); } }) } };
}

test('data-export:F4 inside the viewer a missing downloads capability is "unavailable", never a fake blob save', async (t) => {
  const fd = fakeDocument();
  const claude = { use: () => Promise.resolve(null) };
  withGlobals(t, { window: { claude }, document: fd.document, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} } });
  assert.equal(await exp.saveFile('a.json', '{}', 'application/json'), 'unavailable');
  assert.equal(fd.clicks.length, 0, 'no blocked <a download> is tried inside the viewer');
});

test('data-export:F4 a use() that never answers inside the viewer is "unavailable" too', async (t) => {
  const fd = fakeDocument();
  const claude = { use: () => new Promise(() => {}) };
  withGlobals(t, { window: { claude }, document: fd.document, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} } });
  assert.equal(await exp.initDownloads({ timeoutMs: 15 }), null);
  assert.equal(await exp.saveFile('a.csv', 'x', 'text/csv'), 'unavailable');
  assert.equal(fd.clicks.length, 0);
});

test('data-export:F4 save refusals keep their meaning and a second save while one is open is refused', async (t) => {
  let code = 'rate_limited';
  let release = null;
  const downloads = {
    save: () => (code === 'hold' ? new Promise((res) => { release = () => res({ status: 'saved' }); }) : Promise.reject({ code })),
  };
  withGlobals(t, { window: { claude: { use: () => Promise.resolve(downloads) } } });
  assert.equal(await exp.saveFile('a.pdf', 'x', 'application/pdf'), 'busy');
  code = 'unavailable';
  assert.equal(await exp.saveFile('a.pdf', 'x', 'application/pdf'), 'unavailable');
  code = 'not_granted';
  assert.equal(await exp.saveFile('a.pdf', 'x', 'application/pdf'), 'unavailable');
  code = 'too_large';
  assert.equal(await exp.saveFile('a.pdf', 'x', 'application/pdf'), 'too_large');
  code = 'declined';
  assert.equal(await exp.saveFile('a.pdf', 'x', 'application/pdf'), 'declined');
  code = 'hold';
  const first = exp.saveFile('a.json', '{}', 'application/json');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await exp.saveFile('b.json', '{}', 'application/json'), 'busy', 'one save prompt at a time');
  release();
  assert.equal(await first, 'saved');
});
