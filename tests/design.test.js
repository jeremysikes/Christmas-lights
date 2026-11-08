const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = LP.require('catalog');
const design = LP.require('design');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

// ------------------------------------------------------------------ fixtures (shapes per SPEC §4 and §5.5)
const DEFAULT_PARAMS = { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false,
  overrideWidthFt: null, overrideHeightFt: null };
/** Feature per SPEC §4. opts override any field; opts.params is merged over the defaults (null keeps null). */
function feature(id, type, opts = {}) {
  const { params, ...rest } = opts;
  return Object.assign({
    id, imageId: 'img_1', planeId: 'pl_front', type, label: id,
    points: [[0, 0], [100, 0]], closed: catalog.FEATURE_TYPES[type].closedDefault,
    overrideFt: null, productId: null, color: null,
  }, rest, { params: params === null ? null : Object.assign({}, DEFAULT_PARAMS, params || {}) });
}

/** FeatureMeasurement for a linear feature of the given true length. */
function linearFm(id, type, lengthFt, wastePct = 10, extra = {}) {
  const linear = catalog.LINEAR_TYPES.includes(type);
  return Object.assign({
    ok: true, featureId: id, type, method: 'plane', measuredFt: lengthFt, wrapFt: null, lengthFt,
    withWasteFt: linear ? lengthFt * (1 + wastePct / 100) : lengthFt, areaSqFt: null, widthFt: null, heightFt: null,
    lights: null, pitchEstimate: null, overridden: false, confidence: { level: 'high', score: 90, reasons: [] },
  }, extra);
}
/** Spiral wrap per SPEC §5.5: turns = H_in / s; wrapFt = turns · hypot(π·D, s) / 12. */
function wrapFm(id, type, heightFt, D, s) {
  const wrapFt = ((heightFt * 12) / s) * Math.hypot(Math.PI * D, s) / 12;
  return linearFm(id, type, wrapFt, 10, { measuredFt: heightFt, wrapFt, lengthFt: wrapFt, withWasteFt: wrapFt, heightFt });
}
function bushFm(id, widthFt, heightFt, lights) {
  return linearFm(id, 'bush', null, 10, {
    measuredFt: 2 * (widthFt + heightFt), lengthFt: null, withWasteFt: null, widthFt, heightFt,
    areaSqFt: widthFt * heightFt, lights: lights === undefined ? 100 * (heightFt / 1.5) * widthFt : lights,
  });
}
function project(features, extra = {}) {
  return Object.assign({
    schema: 'lightplan/project', version: 1, id: 'prj_test', name: 'Test',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: ['#ff0000', '#00ff00'], lengthFormat: 'ft-in' },
    images: [{ id: 'img_1', width: 2000, height: 1000 }],
    planes: [{ id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall', rect: null, refs: [], derived: null },
      { id: 'pl_side', imageId: 'img_1', name: 'Side wall', kind: 'wall', rect: null, refs: [], derived: null }],
    features, outlets: [], circuits: [], library: { products: null, config: null },
  }, extra);
}
function measured(fms, planes = { pl_front: { ok: true }, pl_side: { ok: false } }) {
  const features = {};
  for (const fm of fms) features[fm.featureId] = fm;
  return { planes, features, totals: {}, warnings: [] };
}
const lib = catalog.getLibrary(null);
const runOf = (runs, featureId) => runs.find((r) => r.featureId === featureId);

// ------------------------------------------------------------------ string products (linear)
test('roofline: C9 LED strings with waste, bulbs, watts, amps, clips and the arithmetic in words', () => {
  const p = project([feature('ft_1', 'roofline', { label: 'Front eave' })]);
  const runs = design.planRuns(p, measured([linearFm('ft_1', 'roofline', 35.2)]), lib);
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.id, 'run_ft_1');
  assert.equal(r.featureType, 'roofline');
  assert.equal(r.label, 'Front eave');
  assert.equal(r.productId, 'c9-led');
  assert.equal(r.category, 'c9');
  assert.equal(r.tech, 'LED');
  assert.equal(r.unit, 'string');
  assert.equal(r.method, 'linear');
  close(r.lengthFt, 35.2, 1e-9);
  close(r.withWasteFt, 38.72, 1e-9);
  assert.equal(r.quantity, 2);            // 38.72 / 25 → 2 strings
  assert.equal(r.bulbs, 50);              // 2 × 25
  close(r.watts, 19.2, 1e-9);             // 2 × 9.6 W
  close(r.amps, 0.16, 1e-9);              // 19.2 W / 120 V
  assert.deepEqual(r.clips, { type: 'allInOne', count: 37 }); // ceil(35.2·12/12) + 1
  assert.equal(r.lightStakes, 0);
  assert.equal(r.detail, '35.2 ft + 10% = 38.7 ft / 25 ft per string = 2 strings');
  assert.equal(r.colorMode, 'warmWhite');
  assert.deepEqual(r.colors, ['#ffc46b']);
  assert.deepEqual(r.warnings, []);
  // power annotations are left for plan.js
  assert.equal(r.start, null); assert.equal(r.chainId, null); assert.deepEqual(r.feedIds, []);
  assert.equal(r.outletId, null); assert.equal(r.circuitId, null); assert.equal(r.reversed, false);
});

test('string quantity rounds up exactly at the string boundary', () => {
  const p = project([feature('a', 'roofline'), feature('b', 'roofline')]);
  // 50 ft with waste exactly → 2 strings; 50.01 ft → 3 strings
  const runs = design.planRuns(p, measured([linearFm('a', 'roofline', 50, 0), linearFm('b', 'roofline', 50.01, 0)]),
    lib);
  assert.equal(runOf(runs, 'a').quantity, 2);
  assert.equal(runOf(runs, 'b').quantity, 3);
});

test('waste of 0% leaves the "+ x%" step out of the explanation; tape-measured lengths say so', () => {
  const p = project([feature('a', 'gutter'), feature('b', 'roofline')], { settings: { wastePct: 0, colorMode: 'warmWhite' } });
  const runs = design.planRuns(p, measured([
    linearFm('a', 'gutter', 30, 0),
    linearFm('b', 'roofline', 40, 10, { overridden: true, method: 'override' }),
  ]), lib);
  assert.equal(runOf(runs, 'a').detail, '30.0 ft / 25 ft per string = 2 strings');
  assert.match(runOf(runs, 'b').detail, /^Tape-measured 40\.0 ft \+ 10% = 44\.0 ft/);
});

// ------------------------------------------------------------------ product resolution
test('product: feature.productId → typeDefaults → first enabled suitable product', () => {
  const custom = catalog.deepClone(lib);
  custom.config.typeDefaults.gutter = 'track-permanent'; // disabled by default
  const p = project([
    feature('pick', 'roofline', { productId: 'c7-led' }),
    feature('off', 'roofline', { productId: 'track-permanent', label: 'Garage eave' }),
    feature('gone', 'roofline', { productId: 'no-such-product', label: 'Porch eave' }),
    feature('fallback', 'gutter'),
  ]);
  const m = measured(['pick', 'off', 'gone', 'fallback'].map((id) => linearFm(id, id === 'fallback' ? 'gutter' : 'roofline', 20)));
  const runs = design.planRuns(p, m, custom);
  assert.equal(runOf(runs, 'pick').productId, 'c7-led');
  assert.deepEqual(runOf(runs, 'pick').warnings, []);
  assert.equal(runOf(runs, 'off').productId, 'c9-led');
  assert.match(runOf(runs, 'off').warnings[0], /Garage eave: Permanent RGBW track lighting \(per ft\) is turned off/);
  assert.equal(runOf(runs, 'gone').productId, 'c9-led');
  assert.match(runOf(runs, 'gone').warnings[0], /no longer in the product library/);
  // typeDefault is disabled → first enabled product whose suitableFor includes 'gutter' (library order)
  assert.equal(runOf(runs, 'fallback').productId, design.suitableProducts('gutter', custom)[0].id);
  assert.equal(runOf(runs, 'fallback').productId, 'c9-led');
});

test('no enabled product for a type → run with quantity 0 and a plain warning', () => {
  const custom = catalog.deepClone(lib);
  for (const pr of custom.products) if (pr.suitableFor.includes('walkway')) pr.enabled = false;
  const p = project([feature('w', 'walkway', { label: 'Front walk' })]);
  const runs = design.planRuns(p, measured([linearFm('w', 'walkway', 40)]), custom);
  const r = runOf(runs, 'w');
  assert.equal(r.productId, null);
  assert.equal(r.quantity, 0);
  assert.equal(r.watts, 0);
  close(r.lengthFt, 40, 1e-9); // the measured length still counts
  assert.match(r.warnings.join(' '), /no enabled product suits a walkway \/ driveway edge/);
});

test('suitableProducts lists only enabled products made for the type', () => {
  const ids = design.suitableProducts('bush', lib).map((p) => p.id);
  assert.deepEqual(ids, ['mini-led-100', 'mini-incan-100', 'net-led-4x6', 'treewrap-led']);
  assert.ok(!design.suitableProducts('roofline', lib).some((p) => p.id === 'track-permanent'));
  const custom = catalog.deepClone(lib);
  custom.products.find((p) => p.id === 'track-permanent').enabled = true;
  assert.ok(design.suitableProducts('roofline', custom).some((p) => p.id === 'track-permanent'));
  assert.deepEqual(design.suitableProducts('nonsense', lib), []);
});

// ------------------------------------------------------------------ every product unit
test('unit "net" on a bush: width × height × cover factor / coverage', () => {
  const p = project([
    feature('b1', 'bush', { productId: 'net-led-4x6', closed: true }),
    feature('b2', 'bush', { productId: 'net-led-4x6', closed: true }),
  ]);
  const runs = design.planRuns(p, measured([bushFm('b1', 4, 3), bushFm('b2', 6, 4)]), lib);
  const r1 = runOf(runs, 'b1'), r2 = runOf(runs, 'b2');
  assert.equal(r1.method, 'bush-net');
  assert.equal(r1.quantity, 1);                    // 4 × 3 × 1.5 = 18 sq ft / 24 → 1 net
  assert.equal(r2.quantity, 2);                    // 6 × 4 × 1.5 = 36 sq ft / 24 → 2 nets
  assert.equal(r2.bulbs, 300);                     // 2 × 150
  close(r2.watts, 14.4, 1e-9);                     // 2 × 7.2 W
  assert.equal(r2.detail, '6.0 ft × 4.0 ft × 1.5 to drape = 36.0 sq ft / 24 sq ft per net = 2 nets');
  assert.equal(r2.clips, null);
  assert.equal(r2.lengthFt, 0);
});

test('unit "net" on a line feature is estimated as a 4 ft band (with a note)', () => {
  const p = project([feature('n', 'roofline', { productId: 'net-led-4x6', label: 'Low eave' })]);
  const runs = design.planRuns(p, measured([linearFm('n', 'roofline', 20)]), lib);
  const r = runOf(runs, 'n');
  assert.equal(r.quantity, 4);                     // 22 ft × 4 ft = 88 sq ft / 24 → 4 nets
  assert.match(r.warnings.join(' '), /estimated as a 4 ft wide band/);
});

test('unit "set" (path stakes): stakes = floor(L·12/spacing)+1, sets = ceil(stakes/per set)', () => {
  const p = project([feature('w', 'walkway', { label: 'Front walk' }), feature('s', 'stakes', { productId: 'path-stakes' })]);
  const runs = design.planRuns(p, measured([linearFm('w', 'walkway', 42), linearFm('s', 'stakes', 15)]), lib);
  const w = runOf(runs, 'w');
  assert.equal(w.productId, 'path-stakes');
  assert.equal(w.method, 'path-sets');
  assert.equal(w.quantity, 3);                     // floor(42·12/18)+1 = 29 stakes → 3 sets of 10
  assert.equal(w.bulbs, 30);
  close(w.watts, 9, 1e-9);
  assert.equal(w.detail, '42.0 ft at 18 in spacing = 29 stakes / 10 per set = 3 sets');
  assert.equal(w.clips, null);                     // stake mount → no clips
  assert.equal(w.lightStakes, 0);
  const s = runOf(runs, 's');
  assert.equal(s.quantity, 2);                     // floor(15·12/18)+1 = 11 stakes → 2 sets
  assert.equal(s.lightStakes, 0);                  // path sets bring their own stakes
});

test('unit "foot" (permanent track): ceil(length with waste), watts per foot', () => {
  const custom = catalog.deepClone(lib);
  custom.products.find((p) => p.id === 'track-permanent').enabled = true;
  const p = project([feature('t', 'roofline', { productId: 'track-permanent' })]);
  const runs = design.planRuns(p, measured([linearFm('t', 'roofline', 35.2)]), custom);
  const r = runOf(runs, 't');
  assert.equal(r.method, 'per-foot');
  assert.equal(r.quantity, 39);                    // 38.72 ft → 39 ft
  close(r.watts, 46.8, 1e-9);                      // 39 × 1.2 W/ft
  assert.equal(r.bulbs, 78);                       // 39 × 2 pixels per ft
  assert.equal(r.detail, '35.2 ft + 10% = 38.7 ft, rounded up = 39 ft');
  assert.equal(r.clips, null);                     // not clip eligible, all-in-one mount
});

// ------------------------------------------------------------------ bush / tree / column
test('bush with a string product uses the light-count rule of thumb', () => {
  const p = project([feature('b', 'bush', { closed: true, label: 'Left bush' })]);
  const runs = design.planRuns(p, measured([bushFm('b', 4, 3)]), lib);
  const r = runOf(runs, 'b');
  assert.equal(r.productId, 'mini-led-100');
  assert.equal(r.method, 'bush-rule');
  assert.equal(r.quantity, 8);                     // 100 · (3/1.5) · (4/1) = 800 lights / 100
  assert.equal(r.bulbs, 800);
  close(r.watts, 38.4, 1e-9);
  assert.equal(r.lengthFt, 0);
  assert.equal(r.withWasteFt, 0);
  assert.equal(r.clips, null);
  assert.equal(r.detail, '4.0 ft wide × 3.0 ft tall at 100 lights per 1 ft of width per 1.5 ft of height = 800 lights / 100 per string = 8 strings');
  // lights missing from the measurement → computed from width and height with the same rule
  const runs2 = design.planRuns(p, measured([bushFm('b', 4, 3, null)]), lib);
  assert.equal(runOf(runs2, 'b').quantity, 8);
});

test('tree trunk wrap and column wrap use the spiral wire length', () => {
  const p = project([
    feature('t', 'tree', { label: 'Oak', points: [[100, 900], [100, 500]] }),
    feature('c', 'column', { label: 'Porch post', points: [[300, 900], [300, 700]] }),
  ]);
  const runs = design.planRuns(p, measured([wrapFm('t', 'tree', 8, 10, 4), wrapFm('c', 'column', 9, 8, 6)]), lib);
  const t = runOf(runs, 't');
  assert.equal(t.productId, 'treewrap-led');
  assert.equal(t.method, 'spiral');
  close(t.lengthFt, 24 * Math.hypot(Math.PI * 10, 4) / 12, 1e-3); // 63.3 ft of wire
  assert.equal(t.quantity, 2);                     // 63.3 / 37.5 → 2
  assert.equal(t.bulbs, 300);
  assert.equal(t.detail, '8.0 ft tall, 10 in across, wrapped every 4 in = 63.3 ft of lights / 37.5 ft per string = 2 strings');
  const c = runOf(runs, 'c');
  assert.equal(c.method, 'spiral');
  assert.equal(c.quantity, 2);                     // 18 turns × 25.8 in ≈ 38.8 ft / 37.5 → 2
  assert.equal(c.clips, null);
});

test('tree canopy is planned by light count', () => {
  const p = project([feature('t', 'tree', { label: 'Maple', params: { wrapMode: 'canopy' }, points: [[100, 900], [100, 400]] })]);
  const fm = linearFm('t', 'tree', 12, 10, { measuredFt: 12, heightFt: 12, wrapFt: null, lengthFt: 12, withWasteFt: 12, lights: 1200 });
  const r = runOf(design.planRuns(p, measured([fm]), lib), 't');
  assert.equal(r.method, 'bush-rule');
  assert.equal(r.quantity, 8);                     // 1200 lights / 150 per tree-wrap string
  assert.equal(r.bulbs, 1200);
  assert.match(r.detail, /^12\.0 ft tall canopy × 100 lights per ft = 1,200 lights \/ 150 per string = 8 strings$/);
});

// ------------------------------------------------------------------ clips and stakes
test('clip type follows the mount and the product', () => {
  const p = project([
    feature('win', 'window', { closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }),
    feature('rail', 'railing'),
    feature('gut', 'gutter'),
    feature('rake', 'rake'),
    feature('ridge', 'ridge'),
    feature('doorc9', 'door', { productId: 'c9-led' }),
    feature('colc9', 'column', { productId: 'c9-led' }),
    feature('mini-eave', 'roofline', { productId: 'mini-led-100' }),
    feature('none', 'roofline', { params: { mount: 'none' } }),
    feature('shingle', 'roofline', { params: { mount: 'shingle' } }),
    feature('stk', 'stakes'),
    feature('icicle', 'gutter', { productId: 'icicle-led-300' }),
  ]);
  const types = { win: 'window', rail: 'railing', gut: 'gutter', rake: 'rake', ridge: 'ridge', doorc9: 'door', colc9: 'column',
    'mini-eave': 'roofline', none: 'roofline', shingle: 'roofline', stk: 'stakes', icicle: 'gutter' };
  const m = measured(Object.keys(types).map((id) => linearFm(id, types[id], 20)));
  const runs = design.planRuns(p, m, lib);
  const clip = (id) => runOf(runs, id).clips;
  assert.deepEqual(clip('win'), { type: 'adhesive', count: 21 });     // mini lights on a window
  assert.deepEqual(clip('rail'), { type: 'zipTie', count: 21 });      // railing → zip ties
  assert.equal(clip('gut').type, 'gutter');
  assert.equal(clip('rake').type, 'shingle');
  assert.equal(clip('ridge').type, 'ridge');
  assert.equal(clip('doorc9').type, 'adhesive');                       // clip-eligible + adhesive mount
  assert.equal(clip('colc9').type, 'allInOne');                        // clip-eligible, mount 'none' by default
  assert.equal(clip('mini-eave'), null);                               // mini lights are not clip eligible
  assert.equal(clip('none'), null);                                    // explicit "no clips"
  assert.equal(clip('shingle').type, 'shingle');                       // explicit mount wins
  assert.equal(clip('icicle').type, 'gutter');
  // C9 on ground stakes: no clips, one light stake every 12 in plus one
  assert.equal(clip('stk'), null);
  assert.equal(runOf(runs, 'stk').lightStakes, 21);
});

// ------------------------------------------------------------------ colors
test('colors resolve from the feature, then the project settings', () => {
  const p = project([
    feature('a', 'roofline'),
    feature('b', 'roofline', { color: { mode: 'multicolor' } }),
    feature('c', 'roofline', { color: { mode: 'custom', colors: ['#123456'] } }),
  ], { settings: { wastePct: 10, colorMode: 'coolWhite' } });
  const runs = design.planRuns(p, measured(['a', 'b', 'c'].map((id) => linearFm(id, 'roofline', 10))), lib);
  assert.equal(runOf(runs, 'a').colorMode, 'coolWhite');
  assert.deepEqual(runOf(runs, 'a').colors, ['#dfeaff']);
  assert.equal(runOf(runs, 'b').colors.length, 5);
  assert.deepEqual(runOf(runs, 'c').colors, ['#123456']);
});

// ------------------------------------------------------------------ unmeasured and bad data
test('features that are not measured yet still produce a run with quantity 0 and a warning', () => {
  const p = project([
    feature('a', 'roofline', { label: 'Side eave', planeId: 'pl_side' }),
    feature('b', 'window', { label: 'Lost window', planeId: 'pl_missing' }),
    feature('c', 'roofline', { label: 'Half traced' }),
  ]);
  const m = measured([{ ok: false, featureId: 'c', type: 'roofline', method: 'uncalibrated', measuredFt: null, lengthFt: null }]);
  const runs = design.planRuns(p, m, lib);
  assert.equal(runs.length, 3);
  for (const r of runs) {
    assert.equal(r.quantity, 0);
    assert.equal(r.watts, 0);
    assert.equal(r.bulbs, 0);
    assert.equal(r.clips, null);
    assert.equal(r.productId !== null, true); // the product is still chosen so the UI can show it
  }
  assert.ok(runOf(runs, 'a').warnings.includes('Not measured yet: calibrate Side wall first'));
  assert.match(runOf(runs, 'b').warnings.join(' '), /Not measured yet: put Lost window on a wall, roof or ground plane first/);
  assert.match(runOf(runs, 'c').warnings.join(' '), /Not measured yet: check the points traced for Half traced/);
});

test('never throws on partial or bad input, and never mutates its inputs', () => {
  assert.deepEqual(design.planRuns(null, null, null), []);
  assert.deepEqual(design.planRuns({}, {}, undefined), []);
  const p = project([
    null, 7, { id: 'x', type: 'spaceship' }, { type: 'roofline' },
    feature('ok', 'roofline', { params: null }),
    feature('nolabel', 'gutter', { label: '' }),
  ]);
  const m = measured([linearFm('ok', 'roofline', 12), linearFm('nolabel', 'gutter', 12, 10, { withWasteFt: NaN })]);
  const pBefore = JSON.stringify(p), mBefore = JSON.stringify(m), lBefore = JSON.stringify(lib);
  const runs = design.planRuns(p, m, lib);
  assert.equal(JSON.stringify(p), pBefore);
  assert.equal(JSON.stringify(m), mBefore);
  assert.equal(JSON.stringify(lib), lBefore);
  assert.deepEqual(runs.map((r) => r.featureId), ['ok', 'nolabel']);
  assert.equal(runOf(runs, 'nolabel').label, 'Gutter');
  assert.equal(runOf(runs, 'nolabel').quantity, 1); // falls back to length × (1 + waste)
  // library omitted → defaults from the project
  assert.equal(design.planRuns(p, m).length, 2);
  // broken product data (no lit length) → quantity 0 with a reason, no NaN
  const broken = catalog.deepClone(lib);
  broken.products.find((x) => x.id === 'c9-led').stringLengthFt = 0;
  const r = runOf(design.planRuns(p, m, broken), 'ok');
  assert.equal(r.quantity, 0);
  assert.match(r.warnings.join(' '), /has no lit length/);
});

test('bulbs always equal quantity × bulbs per unit', () => {
  const p = project([
    feature('a', 'roofline'), feature('b', 'window', { closed: true, points: [[0, 0], [5, 0], [5, 5]] }),
    feature('c', 'walkway'), feature('d', 'bush', { closed: true }), feature('e', 'tree'),
  ]);
  const m = measured([linearFm('a', 'roofline', 77), linearFm('b', 'window', 18, 10), linearFm('c', 'walkway', 31),
    bushFm('d', 3, 2), wrapFm('e', 'tree', 6, 12, 4)]);
  for (const r of design.planRuns(p, m, lib)) {
    const product = catalog.getProduct(lib.products, r.productId);
    assert.equal(r.bulbs, r.quantity * product.bulbsPerUnit, r.featureId);
    close(r.watts, r.quantity * product.wattsPerUnit, 1e-6, r.featureId);
    close(r.amps, r.watts / 120, 1e-4, r.featureId);
  }
});
