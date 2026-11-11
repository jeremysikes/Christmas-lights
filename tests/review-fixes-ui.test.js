// Phase 1.1 review fixes (UI helpers that need no page): one test per finding, named with the finding ids.
// What happens on the page itself (focus, layout, tap targets) is checked in tests/e2e/smoke.mjs, pass "fixes".
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions', 'preview', 'viewport', 'export', 'panels', 'app']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const schema = LP.require('schema');
const sample = LP.require('sample');
const planner = LP.require('plan');
const panels = LP.require('ui.panels');
const exp = LP.require('ui.export');
const actionsMod = LP.require('ui.actions');
const viewport = LP.require('ui.viewport');
const app = LP.require('ui.app');
const storeMod = LP.require('ui.store');
const fx = require('./power-fixtures');

const tracedSample = () => schema.normalizeProject(sample.createSample({ traced: true }).project);
function planned(mutate) {
  const project = tracedSample();
  if (mutate) mutate(project);
  return { project, plan: planner.computePlan(project) };
}

// ================================================================ U02
test('U02: a bush stays on the "double-check" list until both its width and its height are tape-measured', () => {
  const base = planned();
  const rough = exp.roughMeasurements(base.plan, base.project);
  const bush = rough.find((r) => r.kind === 'bush');
  assert.ok(bush, 'the sample has a rough bush');
  assert.equal(bush.taped, null);
  const id = bush.featureId;
  // Width typed, height not yet: still listed, still counted, and the row says which side is left.
  const half = planned((p) => { p.features.find((f) => f.id === id).params.overrideWidthFt = 4.5; });
  const list = exp.roughMeasurements(half.plan, half.project);
  const row = list.find((r) => r.featureId === id);
  assert.ok(row, 'the bush is still on the list after one of its two sizes');
  assert.equal(list.length, rough.length, 'a half-checked bush is not counted as checked');
  assert.deepEqual([row.taped, row.widthFt], ['width', 4.5]);
  assert.match(row.text, /^4\.5 ft wide by tape, about [\d.]+ ft tall from the photo: measure the height too$/);
  // Height only: the same, the other way round.
  const other = planned((p) => { p.features.find((f) => f.id === id).params.overrideHeightFt = 3; });
  const orow = exp.roughMeasurements(other.plan, other.project).find((r) => r.featureId === id);
  assert.equal(orow.taped, 'height');
  assert.match(orow.text, /^about [\d.]+ ft wide from the photo, 3 ft tall by tape: measure the width too$/);
  // Both typed: checked, and off the list.
  const both = planned((p) => { Object.assign(p.features.find((f) => f.id === id).params, { overrideWidthFt: 4.5, overrideHeightFt: 3 }); });
  const done = exp.roughMeasurements(both.plan, both.project);
  assert.ok(!done.some((r) => r.featureId === id));
  assert.equal(done.length, rough.length - 1);
  // A length with a tape value is off the list at once, as before.
  const eave = rough.find((r) => r.kind === 'length');
  if (eave) {
    const taped = planned((p) => { p.features.find((f) => f.id === eave.featureId).overrideFt = 20; });
    assert.ok(!exp.roughMeasurements(taped.plan, taped.project).some((r) => r.featureId === eave.featureId));
  }
});

// ================================================================ U06
test('U06: the two parts of a run fed from its middle are named apart, and the tap says where along the run it is', () => {
  const { F, feature, outlet } = fx;
  const p = fx.project({
    features: [feature('ft_eave', 'roofline', [F(0, 10), F(40, 10)], { label: 'Eave 1', params: { ownCord: true } })],
    outlets: [outlet('out_1', F(20, 1.5), { label: 'Outlet A' })],
  });
  const r = fx.plan(p);
  const runs = planner.mergeRunInfo(r.runs, r.power);
  const cords = exp.describeCords({ power: r.power, runs }, p);
  const rows = cords.rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((x) => x.lights).sort(), ['Eave 1, left part', 'Eave 1, right part']);
  const home = rows.find((x) => x.kind === 'home'), plug = rows.find((x) => x.kind === 'plugIn');
  assert.match(home.line, /^25 ft cord from Outlet A$/);
  assert.match(plug.line, /^Plugs straight into the 3-way tap 20 ft from the (left|right) end of Eave 1 \(no cord needed\)$/);
  assert.ok(!/at the start of Eave 1/.test(plug.line));
  // A run on one cord keeps its plain name; a run longer than one cord may feed is "part 1 of 3" when there are three.
  const one = planned();
  assert.ok(exp.describeCords(one.plan, one.project).rows.every((x) => !/ part\b/.test(x.lights)));
  const long = fx.project({ features: [feature('ft_eave', 'roofline', [F(0, 10), F(60, 10)], { label: 'Long eave', productId: 'c9-incan', overrideFt: 200 })], outlets: [outlet('out_1', F(1, 1.5))] });
  const lr = fx.plan(long);
  const lrows = exp.describeCords({ power: lr.power, runs: planner.mergeRunInfo(lr.runs, lr.power) }, long).rows;
  assert.ok(lrows.length >= 3);
  assert.deepEqual(lrows.map((x) => x.lights), lrows.map((_, i) => 'Long eave, part ' + (i + 1) + ' of ' + lrows.length));
});

// ================================================================ U07
test('U07: opening a file whose saved totals differ from the fresh plan says what moved', () => {
  const { project, plan } = planned((p) => { p.quote.enabled = true; });
  const text = actionsMod.replannedText;
  assert.equal(text({ cost: plan.summary.cost, quoteTotal: plan.summary.quoteTotal }, plan), '', 'the same totals: nothing to say');
  assert.equal(text(null, plan), '');
  assert.equal(text({ cost: 1131.29, quoteTotal: null }, null), '');
  assert.equal(text({ cost: plan.summary.cost + 0.5, quoteTotal: null }, plan), '', 'under a dollar is rounding, not news');
  const said = text({ cost: 1131.29, quoteTotal: 2424.56 }, plan);
  assert.equal(said, 'This plan was saved with different planning rules (an older LightPlan, most likely). Cords, lights and prices were worked out again: ' +
    'materials were $1,131.29, now $' + plan.summary.cost.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '; the customer quote was $2,424.56, now $' +
    plan.summary.quoteTotal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '. Check the shopping list before you order or quote.');
  // Installer mode off: only the materials are compared.
  const home = planned();
  assert.match(text({ cost: 1131.29, quoteTotal: 2424.56 }, home.plan), /: materials were \$1,131\.29, now \$767\.51\. Check the shopping list/);
  // The file carries those totals in its "derived" block; importProject hands them over and nothing else of it.
  const file = schema.exportProject(project, { summary: { cost: 1131.29, quoteTotal: 2424.56 }, bom: { lines: ['x'] } }, {}, null);
  const res = schema.importProject(JSON.stringify(file));
  assert.deepEqual(res.saved, { cost: 1131.29, quoteTotal: 2424.56 });
  assert.deepEqual(Object.keys(res).sort(), ['images', 'project', 'saved']);
});

// ================================================================ U17
test('U17: prices typed by hand are read the way people write them, and a price for an item off the list can still be reset', () => {
  for (const [typed, want] of [['12.5', 12.5], ['12.50', 12.5], ['$12', 12], ['$ 12.40', 12.4], ['12,50', 12.5], ['1,234.50', 1234.5], ['0', 0], ['.5', 0.5], [' 7 ', 7], ['1000', 1000]]) {
    assert.equal(panels.parseMoney(typed), want, typed);
  }
  for (const bad of ['', '-5', 'abc', '12.5.1', '1e3', '$', '12,5,0', null, undefined, '5 dollars']) assert.equal(panels.parseMoney(bad), null, String(bad));
  // The reviewer's case: 1000Bulbs, $1,000 typed on the 100 ft wire. The mix drops that size, the price stays in the
  // plan, and the list says so with a Reset.
  const before = planned((p) => { p.library = { products: null, config: null, supplierId: '1000bulbs' }; });
  assert.ok(before.plan.bom.lines.some((l) => l.sku === '1000bulbs:CMS-10124'));
  assert.deepEqual(panels.strayOverrides(before.project, before.plan), []);
  const after = planned((p) => { p.library = { products: null, config: null, supplierId: '1000bulbs' }; p.pricing.overrides['1000bulbs:CMS-10124'] = 1000; });
  assert.ok(!after.plan.bom.lines.some((l) => l.sku === '1000bulbs:CMS-10124'), 'the dear size is no longer bought');
  assert.deepEqual(panels.strayOverrides(after.project, after.plan), [{
    sku: '1000bulbs:CMS-10124', name: 'C9 socket wire, 100 ft ready-made length, a socket every 12 in, green SPT-1, 18 gauge (male plug only)', price: 1000,
  }]);
  // A price on a line that is on the list is not stray; a key nobody knows is shown by its key; junk is ignored.
  const mixed = planned((p) => { p.pricing.overrides = { 'c9-led': 30, 'no-such-thing': 5, broken: 'abc' }; });
  assert.deepEqual(panels.strayOverrides(mixed.project, mixed.plan), [{ sku: 'no-such-thing', name: 'no-such-thing', price: 5 }]);
  assert.deepEqual(panels.strayOverrides(null, null), []);
  // A tape value far from what the photo says is asked about; a near one is not.
  assert.equal(panels.tapeMismatch(150, 15), 10);
  assert.equal(panels.tapeMismatch(1000, 15) > 60, true);
  assert.equal(panels.tapeMismatch(4, 15), 3.75);
  assert.equal(panels.tapeMismatch(15.6, 15), null);
  assert.equal(panels.tapeMismatch(40, 15), null, 'within 3 times: a rough photo measurement can be that far off');
  assert.equal(panels.tapeMismatch(15, null), null);
  assert.equal(panels.tapeMismatch(0, 15), null);
});

// ================================================================ U16
test('U16: a cord label is placed clear of other cords (pathHitsBox)', () => {
  const box = { x: 100, y: 100, w: 60, h: 20 };
  assert.equal(viewport.pathHitsBox([[90, 110], [200, 110]], box), true, 'a cord straight through the box');
  assert.equal(viewport.pathHitsBox([[130, 0], [130, 300]], box), true, 'an upright cord through it');
  assert.equal(viewport.pathHitsBox([[0, 0], [90, 90]], box), false);
  assert.equal(viewport.pathHitsBox([[0, 130], [300, 130]], box), false, 'a cord 10 px below it');
  assert.equal(viewport.pathHitsBox([[0, 122], [300, 122]], box, 3), true, 'within the 3 px margin');
  assert.equal(viewport.pathHitsBox([[0, 0], [50, 50], [130, 110], [300, 300]], box), true, 'a later piece of a longer cord');
  assert.equal(viewport.pathHitsBox([], box), false);
  assert.equal(viewport.pathHitsBox([[130, 110]], box), false);
});

// ================================================================ U18 / U03 wording
test('U18 U03: the calibrate intro matches what the pinned button starts, and the tracing hint always shows its count', () => {
  assert.match(panels.CALIBRATE_SENTENCE, /^Tap the four corners of this wall, then one thing on it whose size you know/);
  assert.match(panels.CALIBRATE_SENTENCE, /choose it under "What is it\?" first\.$/);
  assert.ok(!/like the garage door, and LightPlan/.test(panels.CALIBRATE_SENTENCE));
  // The pinned button on a fresh photo still starts the wall's four corners.
  const p = schema.normalizeProject(sample.createSample({ traced: false }).project);
  const next = panels.nextAction(p, Object.assign(storeMod.defaultUI(), { step: 2 }), planner.computePlan(p));
  assert.equal(next.label, 'Mark the 4 corners');
  // Tracing: "0 points" from the start, so the bar does not grow when the first point lands.
  const ui = (pts) => Object.assign(storeMod.defaultUI(), { step: 3, mode: { name: 'trace', opts: { type: 'roofline', planeId: p.planes[0].id } }, draft: { points: pts } });
  assert.equal(app.hintFor(ui([]), p, null).count, '0 points');
  assert.equal(app.hintFor(ui([[1, 1]]), p, null).count, '1 point');
  assert.equal(app.hintFor(ui([[1, 1], [2, 2]]), p, null).count, '2 points');
  assert.equal(app.hintFor(Object.assign(ui([]), { mode: { name: 'trace', opts: { type: 'window', planeId: p.planes[0].id } } }), p, null).count, '0 points');
});

// ================================================================ U04 / U08
test('U04 U08: the shopping list is priced as ordered unless installer mode is on, and the order never changes with the basis', () => {
  const lib = (p, costBasis) => { p.library = { products: null, config: { buying: { costBasis } }, supplierId: 'cle' }; };
  const off = planned((p) => lib(p, 'used'));
  const bought = planned((p) => lib(p, 'bought'));
  assert.equal(off.plan.bom.costBasis, 'bought', 'installer mode is off in the sample');
  assert.equal(off.plan.summary.cost, bought.plan.summary.cost);
  const on = planned((p) => { lib(p, 'used'); p.quote.enabled = true; });
  assert.equal(on.plan.bom.costBasis, 'used');
  assert.ok(on.plan.summary.cost < bought.plan.summary.cost);
  assert.deepEqual(on.plan.bom.lines.map((l) => [l.sku, l.qty]), bought.plan.bom.lines.map((l) => [l.sku, l.qty]));
  assert.equal(on.plan.bom.orderTotal, bought.plan.bom.subtotal);
});
