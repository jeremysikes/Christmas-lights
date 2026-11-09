// Unit tests for the DOM-free helpers of ui.panels (product/config validation, warning routing).
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions', 'panels']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const catalog = LP.require('catalog');
const sample = LP.require('sample');
const plan = LP.require('plan');
const panels = LP.require('ui.panels');

test('validateProducts accepts the defaults and explains bad entries', () => {
  assert.deepEqual(panels.validateProducts(catalog.DEFAULT_PRODUCTS), { ok: true, errors: [] });
  assert.equal(panels.validateProducts({}).ok, false);
  const bad = catalog.deepClone(catalog.DEFAULT_PRODUCTS.slice(0, 2));
  bad[1].id = bad[0].id;
  bad[0].unit = 'yard';
  bad[0].maxEndToEnd = 0;
  bad[1].suitableFor = ['roof'];
  const r = panels.validateProducts(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /"unit"/.test(e)));
  assert.ok(r.errors.some((e) => /maxEndToEnd/.test(e)));
  assert.ok(r.errors.some((e) => /twice/.test(e)));
  assert.ok(r.errors.some((e) => /suitableFor/.test(e)));
});

test('diffConfig keeps only changed leaves', () => {
  const edited = catalog.deepClone(catalog.DEFAULT_CONFIG);
  edited.clipSpacingIn = 6;
  edited.power.cordSlackFt = 6;
  assert.deepEqual(panels.diffConfig(catalog.DEFAULT_CONFIG, edited), { clipSpacingIn: 6, power: { cordSlackFt: 6 } });
  assert.deepEqual(panels.diffConfig(catalog.DEFAULT_CONFIG, catalog.DEFAULT_CONFIG), {});
});

test('warnings are routed to the step that can fix them', () => {
  assert.equal(panels.warningStep({ code: 'circuit-overload', circuitId: 'c' }), 5);
  assert.equal(panels.warningStep({ code: 'cord-walkway', featureId: 'f' }), 5);
  assert.equal(panels.warningStep({ code: 'run', featureId: 'f' }), 4);
  assert.equal(panels.warningStep({ code: 'feature-unmeasured', featureId: 'f' }), 3);
  assert.equal(panels.warningStep({ code: 'ref-disagree', planeId: 'p' }), 2);
  assert.equal(panels.warningStep({ code: 'internal-error', stage: 'power' }), 5);
  assert.equal(panels.warningStep({ code: 'something-else' }), 6);
  const s = sample.createSample({ traced: true });
  const counts = panels.stepWarnings(plan.computePlan(s.project));
  assert.equal(counts[5].count, 1, 'the sample has one cord-across-walkway warning');
  assert.equal(counts[5].level, 'warn');
  assert.equal(counts[1].count, 0, 'info and the disclaimer are not counted');
});
