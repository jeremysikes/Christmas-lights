const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = LP.require('plan');

// The full pipeline needs measure, design and power (written in parallel by other modules).
const HAS_PIPELINE = ['measure', 'design', 'power'].every((m) => LP.has(m));
const pipeline = { skip: HAS_PIPELINE ? false : 'measure, design and power are not loaded yet' };

// ------------------------------------------------------------------ fixtures
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const PARAMS = { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false, overrideWidthFt: null, overrideHeightFt: null };
function feature(id, type, label, points, o = {}) {
  return Object.assign({ id, imageId: 'img_1', planeId: 'pl_front', type, label, points, closed: false, overrideFt: null, productId: null, color: null }, o,
    { params: Object.assign({}, PARAMS, o.params || {}) });
}
/**
 * One straight-on front wall calibrated by a 16 × 7 ft rectangle: 100 px per foot,
 * u = (x − 100) / 100 and v = (900 − y) / 100.
 */
function project(o = {}) {
  return Object.assign({
    schema: 'lightplan/project', version: 1, id: 'prj_plan', name: '12 Elm St', createdAt: null, updatedAt: null,
    customer: { name: '', address: '', phone: '', email: '' },
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    images: [{ id: 'img_1', name: 'front.jpg', width: 2400, height: 1200, source: { kind: 'upload', capturedAt: null, attribution: null },
      exif: null, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img_1' }],
    activeImageId: 'img_1',
    planes: [{ id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall', color: '#4f9dff',
      rect: { corners: [[100, 200], [1700, 200], [1700, 900], [100, 900]], widthFt: 16, heightFt: 7, presetId: 'custom-rect' }, refs: [], derived: null }],
    features: [
      feature('ft_eave', 'roofline', 'Front eave', [[100, 150], [1900, 150]]),
      feature('ft_gutter', 'gutter', 'Porch gutter', [[1920, 150], [2300, 150]]),
      feature('ft_win', 'window', 'Bay window', [[400, 400], [700, 400], [700, 700], [400, 700]], { closed: true }),
      feature('ft_rail', 'railing', 'Porch railing', [[900, 800], [1500, 800]], { color: { mode: 'multicolor' } }),
      feature('ft_post', 'column', 'Porch post', [[1600, 900], [1600, 500]]),
      feature('ft_lost', 'gutter', 'Side gutter', [[0, 0], [10, 0]], { planeId: null }),
    ],
    outlets: [{ id: 'out_1', imageId: 'img_1', planeId: 'pl_front', point: [1000, 880], label: 'Porch outlet', type: 'garage', gfci: false, circuitId: 'cir_1', receptacles: 2 }],
    circuits: [{ id: 'cir_1', name: 'Porch circuit', breakerAmps: 15, voltage: 120, existingLoadW: 0 }],
    library: { products: null, config: null },
    pricing: { overrides: {} },
    quote: { enabled: false, company: '', laborMethod: 'perFt', ratePerFt: 3.5, ratePerHour: 65, markupPct: 30, takedownFee: 150, storageFee: 75, taxPct: 0, validDays: 30, notes: '' },
  }, o);
}
const PLAN_KEYS = ['library', 'measured', 'runs', 'power', 'bom', 'quote', 'checklist', 'warnings', 'summary'];
const SUMMARY_KEYS = ['totalFt', 'totalWithWasteFt', 'byType', 'strings', 'clips', 'cords', 'timers', 'watts', 'amps', 'circuits', 'outletsUsed', 'cost', 'quoteTotal'];
const LEVELS = { danger: 0, warn: 1, info: 2 };
function assertSorted(warnings) {
  for (let i = 1; i < warnings.length; i++) assert.ok(LEVELS[warnings[i - 1].level] <= LEVELS[warnings[i].level], 'warnings sorted by severity');
  assert.equal(new Set(warnings.map((w) => w.message)).size, warnings.length, 'no duplicate messages');
}

// ================================================================ full pipeline
test('computePlan runs the whole pipeline and merges power info into the runs', pipeline, () => {
  const out = plan.computePlan(project());
  assert.deepEqual(Object.keys(out), PLAN_KEYS);
  assert.equal(out.runs.length, 6);
  const byId = Object.fromEntries(out.runs.map((r) => [r.id, r]));
  for (const id of ['run_ft_eave', 'run_ft_gutter', 'run_ft_win', 'run_ft_rail', 'run_ft_post']) {
    const r = byId[id];
    const info = out.power.runInfo[id];
    assert.ok(r.quantity > 0, id + ' is planned');
    assert.equal(r.outletId, 'out_1');
    assert.equal(r.circuitId, 'cir_1');
    assert.ok(r.feedIds.length > 0);
    assert.deepEqual([r.start, r.end, r.reversed, r.chainId, r.feedIds], [info.start, info.end, info.reversed, info.chainId, info.feedIds]);
    assert.notEqual(r.feedIds, info.feedIds, 'merged arrays are copies');
  }
  assert.equal(byId.run_ft_eave.chainId, byId.run_ft_gutter.chainId, 'eave and gutter are chained end to end');
  assert.equal(byId.run_ft_lost.quantity, 0);
  assert.equal(byId.run_ft_lost.outletId, null);
  assert.ok(out.bom.lines.length > 0 && out.bom.subtotal > 0);
  assert.equal(out.checklist[0].outletId, 'out_1');
  assert.equal(out.checklist[out.checklist.length - 1].title, 'Safety and final test');
  assert.ok(!out.warnings.some((w) => w.code === 'internal-error'), JSON.stringify(out.warnings));
});

test('summary totals agree with the parts of the plan', pipeline, () => {
  const out = plan.computePlan(project());
  const s = out.summary;
  assert.deepEqual(Object.keys(s), SUMMARY_KEYS);
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  assert.equal(s.strings, sum(out.runs.filter((r) => r.unit === 'string'), (r) => r.quantity));
  assert.equal(s.clips, sum(out.runs, (r) => (r.clips ? r.clips.count : 0)));
  assert.equal(s.cords, sum(out.power.cords, (c) => c.count));
  assert.ok(s.cords >= out.power.feeds.length, 'at least one cord piece per powered feed');
  assert.equal(s.timers, out.power.counts.timers);
  assert.equal(s.watts, out.power.totals.watts);
  assert.equal(s.cost, out.bom.subtotal);
  assert.equal(s.quoteTotal, null, 'installer mode is off');
  assert.equal(s.outletsUsed, 1);
  assert.equal(s.circuits, 1);
  assert.equal(s.totalFt, Math.round(out.measured.totals.totalFt * 100) / 100);
  assert.ok(Math.abs(s.byType.roofline.lengthFt - 18) < 0.01, 'the 18 ft eave measures 18 ft');
  const quoted = plan.computePlan(project({ quote: Object.assign({}, project().quote, { enabled: true }) }));
  assert.equal(quoted.summary.quoteTotal, quoted.quote.total);
  assert.ok(quoted.quote.total > quoted.bom.subtotal);
});

test('warnings are merged, deduplicated and ordered danger first', pipeline, () => {
  // 300 ft of 175 W incandescent strings on one 15 A circuit is far over the 1,440 W limit.
  const p = project({ features: project().features.concat([
    feature('ft_big', 'roofline', 'Back eave', [[100, 120], [1900, 120]], { productId: 'c9-incan', overrideFt: 300 }),
  ]) });
  const out = plan.computePlan(p);
  assertSorted(out.warnings);
  assert.equal(out.warnings[0].level, 'danger');
  assert.ok(out.warnings.some((w) => w.code === 'circuit-overload'));
  assert.ok(out.warnings.some((w) => w.code === 'no-gfci'));
  assert.ok(out.warnings.some((w) => w.code === 'disclaimer' && w.level === 'info'));
  const lost = out.warnings.filter((w) => w.featureId === 'ft_lost');
  assert.equal(lost.length, 1, 'an unmeasured feature is reported once: ' + JSON.stringify(lost));
  assert.equal(lost[0].code, 'feature-unmeasured');
  for (const w of out.warnings) assert.ok(typeof w.message === 'string' && w.message.length > 0 && typeof w.code === 'string');
});

test('computePlan is deterministic and does not mutate the project', pipeline, () => {
  const p = deepFreeze(project());
  const before = JSON.stringify(p);
  const a = plan.computePlan(p);
  const b = plan.computePlan(p);
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(a, b);
});

test('computePlan never throws on partial or bad project data', pipeline, () => {
  const inputs = [null, undefined, 42, 'x', [], {}, { features: 'nope' }, { planes: [null], features: [null, { type: 'roofline' }] },
    { features: [feature('a', 'roofline', 'A', [[0, 0]])], outlets: [{ id: 'o' }] }];
  inputs.forEach((input, i) => {
    const out = plan.computePlan(input);
    assert.deepEqual(Object.keys(out), PLAN_KEYS, 'input #' + i);
    assert.deepEqual(Object.keys(out.summary), SUMMARY_KEYS);
    assert.ok(Array.isArray(out.runs) && Array.isArray(out.checklist) && Array.isArray(out.warnings));
    assert.ok(Array.isArray(out.bom.lines));
    assertSorted(out.warnings);
  });
});

test('a failing stage becomes a danger warning and later stages still run', pipeline, () => {
  const p = project();
  Object.defineProperty(p, 'features', { enumerable: true, get() { throw new Error('boom'); } });
  const out = plan.computePlan(p);
  assert.deepEqual(Object.keys(out), PLAN_KEYS);
  const internal = out.warnings.filter((w) => w.code === 'internal-error');
  assert.ok(internal.some((w) => w.stage === 'design'), JSON.stringify(out.warnings));
  assert.equal(out.warnings[0].code, 'internal-error');
  assert.equal(out.warnings[0].level, 'danger');
  assert.match(internal[0].message, /^LightPlan could not work out .+, so that part of the plan is empty\./);
  assert.deepEqual(out.runs, []);
  assert.equal(out.summary.strings, 0);
  assert.ok(Array.isArray(out.checklist));
});

// ================================================================ helpers (no other modules needed)
test('mergeRunInfo copies power annotations onto new run objects', () => {
  const runs = deepFreeze([
    { id: 'run_a', quantity: 2, start: null, end: null, reversed: false, chainId: null, feedIds: [], outletId: null, circuitId: null },
    { id: 'run_b', quantity: 0, start: null, end: null, reversed: false, chainId: null, feedIds: [], outletId: null, circuitId: null },
    null,
  ]);
  const power = deepFreeze({ runInfo: { run_a: { chainId: 'chain_a', feedIds: ['feed_a_1'], outletId: 'out_1', circuitId: 'cir_1', start: [1, 2], end: [3, 4], reversed: true } } });
  const merged = plan.mergeRunInfo(runs, power);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { id: 'run_a', quantity: 2, start: [1, 2], end: [3, 4], reversed: true, chainId: 'chain_a', feedIds: ['feed_a_1'], outletId: 'out_1', circuitId: 'cir_1' });
  assert.notEqual(merged[0], runs[0]);
  assert.notEqual(merged[0].start, power.runInfo.run_a.start);
  assert.deepEqual(merged[1], runs[1]);
  assert.deepEqual(plan.mergeRunInfo(null, null), []);
});

test('collectWarnings dedupes by message, keeps the most severe level and sorts danger first', () => {
  const measured = { warnings: [
    { level: 'info', code: 'pitch-estimated', message: 'Roof pitch estimated at 7/12.' },
    { level: 'warn', code: 'feature-unmeasured', message: 'Side gutter cannot be measured yet: pick a plane.', featureId: 'ft_lost' },
    { level: 'info', code: 'dup', message: 'Same thing.' },
  ] };
  const power = { warnings: [
    { level: 'danger', code: 'circuit-overload', message: 'Porch circuit is overloaded.', circuitId: 'cir_1' },
    { level: 'warn', code: 'dup', message: 'Same thing.' },
    { level: 'bogus', code: 'odd', message: 'Odd level.' },
    { level: 'warn', message: '   ' },
    null,
  ] };
  const runs = [
    { id: 'run_ft_lost', featureId: 'ft_lost', warnings: ['Not measured yet: put Side gutter on a wall, roof or ground plane first'] },
    { id: 'run_ft_x', featureId: 'ft_x', warnings: ['Not measured yet: calibrate Back wall first', 'Bay window: C9 is not sold in cool white.', 42] },
  ];
  const internal = [{ level: 'danger', code: 'internal-error', stage: 'bom', message: 'LightPlan could not work out the bill of materials.' }];
  const out = plan.collectWarnings(internal, measured, power, runs);
  assert.deepEqual(out, [
    { level: 'danger', code: 'internal-error', message: 'LightPlan could not work out the bill of materials.', stage: 'bom' },
    { level: 'danger', code: 'circuit-overload', message: 'Porch circuit is overloaded.', circuitId: 'cir_1' },
    { level: 'warn', code: 'feature-unmeasured', message: 'Side gutter cannot be measured yet: pick a plane.', featureId: 'ft_lost' },
    { level: 'warn', code: 'dup', message: 'Same thing.' },
    { level: 'warn', code: 'odd', message: 'Odd level.' },
    { level: 'warn', code: 'run', message: 'Not measured yet: calibrate Back wall first', featureId: 'ft_x' },
    { level: 'warn', code: 'run', message: 'Bay window: C9 is not sold in cool white.', featureId: 'ft_x' },
    { level: 'info', code: 'pitch-estimated', message: 'Roof pitch estimated at 7/12.' },
  ]);
  assert.deepEqual(plan.collectWarnings(null, null, null, null), []);
});

test('summarize falls back to run watts when there is no power plan', () => {
  const runs = [
    { unit: 'string', quantity: 2, watts: 19.2, clips: { type: 'allInOne', count: 41 } },
    { unit: 'set', quantity: 1, watts: 3, clips: null },
    { unit: 'string', quantity: 'x', watts: NaN },
  ];
  const s = plan.summarize(null, runs, null, { subtotal: 12.5 }, { enabled: true, total: 99 }, 120);
  assert.deepEqual([s.strings, s.clips, s.cords, s.timers, s.watts, s.amps, s.circuits, s.outletsUsed, s.cost, s.quoteTotal],
    [2, 41, 0, 0, 22.2, 0.185, 0, 0, 12.5, 99]);
  assert.equal(s.totalFt, 0);
  assert.deepEqual(Object.keys(s.byType), LP.require('catalog').TYPE_ORDER);
});
