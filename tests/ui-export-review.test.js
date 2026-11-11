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

// ---------------------------------------------------------------- Phase 1.1 (SPEC §8.5): cords, taps and rough lengths
test('8.5 the report\'s cords table says what each cord plugs into, how it runs, and where the 3-way taps go', { skip: !HAS_PDFTOTEXT }, () => {
  const { project, plan } = fixture();
  const text = pdfText(exp.buildReportPdf({ project, plan, image: null, date: DATE }), 'cords.pdf').replace(/\s+/g, ' ');
  // Source: an outlet for a cord that goes back to one, the run before it for a jumper cord.
  assert.ok(text.includes('15 ft cord, 16 AWG'), 'the cord from the Porch outlet');
  assert.ok(text.includes('6 ft jumper cord, 16 AWG'), 'a jumper cord is called a jumper cord');
  assert.ok(text.includes('The end of Front door'), 'a jumper names the run it plugs into');
  assert.ok(/The 3-way tap at the start of Walkway left edge/.test(text), 'a jumper from a tap names the tap');
  // Route in words, from the planner.
  for (const f of plan.power.feeds) {
    const route = f.cord.routeText;
    assert.ok(text.includes(route.charAt(0).toUpperCase() + route.slice(1) + '.'), 'route of ' + f.id + ': ' + route);
  }
  // Taps, and the counts block.
  assert.ok(text.includes('3-way tap at its start') && text.includes('3-way tap at its end'));
  const c = plan.power.counts;
  assert.deepEqual([c.homeRuns, c.jumpers, c.taps], [2, 10, 4]);
  assert.ok(new RegExp('\\b' + c.homeRuns + ' ' + c.jumpers + ' ' + c.taps + ' ' + c.timers + ' Cords to outlets Jumper cords 3-way taps Timers').test(text), 'counts: cords to outlets, jumper cords, 3-way taps');
  // The outlet table counts the cords at the outlet (1), not every run it powers (11).
  assert.ok(/Porch outlet Porch circuit Yes 1 11 98\.4 W/.test(text), 'Porch outlet row: 1 cord here, 11 runs fed');
  assert.ok(!/Cords and feeds/.test(text), 'the heading no longer says "feeds"');
});

test('8.5 a run that plugs straight in reads "Plugs straight in" in the report, never "Length unknown"', { skip: !HAS_PDFTOTEXT }, () => {
  const { project, plan } = fixture();
  const edited = JSON.parse(JSON.stringify(plan));
  const jumper = edited.power.feeds.find((f) => f.id === 'feed_ft_walk_right_1');
  jumper.plugIn = true;
  jumper.cord = null;
  jumper.cordPath = [];
  const unknown = edited.power.feeds.find((f) => f.id === 'feed_ft_tree_1');
  unknown.cord = null;
  unknown.cordUnknown = true;
  const text = pdfText(exp.buildReportPdf({ project, plan: edited, image: null, date: DATE }), 'plugin.pdf').replace(/\s+/g, ' ');
  assert.ok(text.includes('Plugs straight in') && text.includes('No cord needed.'), 'the plug-in run says so');
  assert.equal((text.match(/Length unknown/g) || []).length, 1, 'only the cord that really is unknown says "Length unknown"');
  assert.ok(text.includes('Set the scale of its wall to size this cord.'));
});

test('8.5 Low-confidence measurements are listed in the report with the range each could be, and the cost is marked rough', { skip: !HAS_PDFTOTEXT }, () => {
  const { project, plan } = fixture();
  const rough = exp.roughMeasurements(plan, project);
  const lows = project.features.filter((f) => plan.measured.features[f.id].confidence.level === 'low');
  assert.deepEqual(rough.map((r) => r.featureId), lows.map((f) => f.id), 'every Low item, in traced order');
  assert.ok(rough.length >= 3);
  const ridge = rough.find((r) => r.featureId === 'ft_ridge');
  assert.equal(ridge.text, 'about 34 ft, could be 30 to 38 ft');
  assert.ok(ridge.lowFt < 34.04 && ridge.highFt > 34.04);
  const walk = rough.find((r) => r.featureId === 'ft_walk_left');
  assert.match(walk.text, /^about 15 ft, but that is a rough guess/, 'an expected error above 60% gets no made-up range');
  assert.equal(rough.find((r) => r.featureId === 'ft_tree').kind, 'height', 'a tree is checked by its height');
  assert.match(rough.find((r) => r.featureId === 'ft_bush_1').text, /wide by .* tall, each side could be off by about \d+%$/);
  const text = pdfText(exp.buildReportPdf({ project, plan, image: null, date: DATE }), 'rough.pdf').replace(/\s+/g, ' ');
  assert.ok(text.includes('Measurements to double-check (' + rough.length + ')'));
  assert.ok(text.includes('Ridge: about 34 ft, could be 30 to 38 ft.'));
  assert.ok(text.includes('Materials cost (rough)'));
  // A tape-measured length takes the item off the list; with every item taped the report has no such block.
  const taped = fixture((p) => { p.features.find((f) => f.id === 'ft_ridge').overrideFt = 33.5; });
  assert.ok(!exp.roughMeasurements(taped.plan, taped.project).some((r) => r.featureId === 'ft_ridge'));
  const all = fixture((p) => { for (const f of p.features) { f.overrideFt = 20; f.params.overrideWidthFt = 4; f.params.overrideHeightFt = 3; } });
  assert.deepEqual(exp.roughMeasurements(all.plan, all.project), []);
  const clean = pdfText(exp.buildReportPdf({ project: all.project, plan: all.plan, image: null, date: DATE }), 'rough-none.pdf').replace(/\s+/g, ' ');
  assert.ok(!clean.includes('Measurements to double-check') && !clean.includes('(rough)'));
  // A Medium item counts once its expected error is above 6%.
  const fake = { measured: { features: {
    a: { ok: true, lengthFt: 40, uncertaintyPct: 6.5, confidence: { level: 'medium' } },
    b: { ok: true, lengthFt: 40, uncertaintyPct: 5.9, confidence: { level: 'medium' } },
    c: { ok: true, lengthFt: 40, uncertaintyPct: 2, confidence: { level: 'high' } },
    d: { ok: false, confidence: null },
  } } };
  const list = exp.roughMeasurements(fake, { features: [{ id: 'a', type: 'roofline', label: 'A' }, { id: 'b', type: 'roofline', label: 'B' }, { id: 'c', type: 'roofline', label: 'C' }, { id: 'd', type: 'roofline', label: 'D' }] });
  assert.deepEqual(list.map((r) => r.featureId), ['a']);
  assert.equal(list[0].text, 'about 40 ft, could be 37 to 43 ft');
  assert.deepEqual(exp.roughMeasurements(null, null), []);
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
