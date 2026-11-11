// Unit tests for the DOM-free helpers of ui.panels (product/config validation, warning routing).
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions', 'export', 'panels']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const catalog = LP.require('catalog');
const schema = LP.require('schema');
const sample = LP.require('sample');
const plan = LP.require('plan');
const panels = LP.require('ui.panels');
const exp = LP.require('ui.export');
const storeMod = LP.require('ui.store');
const actionsMod = LP.require('ui.actions');

const clone = (v) => JSON.parse(JSON.stringify(v));
const tracedSample = () => schema.normalizeProject(sample.createSample({ traced: true }).project);

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
  const step5Of = (pl) => pl.warnings.filter((w) => (w.level === 'warn' || w.level === 'danger') && panels.warningStep(w) === 5).map((w) => w.code);
  // Phase 1.1: with runs linked by jumpers, two cords go back to the outlets and none crosses the door or the walkway.
  assert.deepEqual(step5Of(plan.computePlan(s.project)), [], 'the linked sample plan has no power warnings');
  // One cord per run (daisy chains off): the cord to the door lights ends just inside the walkway in front of the door.
  const flat = JSON.parse(JSON.stringify(s.project));
  flat.library = { products: null, config: { power: { daisyChain: false } } };
  const samplePlan = plan.computePlan(flat);
  const counts = panels.stepWarnings(samplePlan);
  const step5 = step5Of(samplePlan);
  assert.deepEqual(step5.slice().sort(), ['cord-walkway'], 'without jumpers the sample has a walkway warning');
  assert.equal(counts[5].count, step5.length);
  assert.equal(counts[5].level, 'warn');
  assert.equal(counts[1].count, 0, 'info and the disclaimer are not counted');
});

// ---------------------------------------------------------------- Phase 1.1: rough measurements (UX-03, SPEC §8.5 "Step 6")
test('UX-03 Low-confidence items are counted on the Trace step and listed for Review until they are tape-measured', () => {
  const p = tracedSample();
  const pl = plan.computePlan(p);
  const lows = p.features.filter((f) => pl.measured.features[f.id].confidence.level === 'low').map((f) => f.id);
  assert.ok(lows.length >= 3, 'the sample has rough measurements (' + lows.length + ')');
  const counts = panels.stepWarnings(pl);
  assert.equal(counts[3].low, lows.length, 'the Trace step counts them');
  assert.equal(counts[3].count, 0, 'they are not warnings: the badge stays neutral');
  assert.equal(counts[3].level, null);
  assert.deepEqual([1, 2, 4, 5, 6].map((n) => counts[n].low), [0, 0, 0, 0, 0]);
  assert.deepEqual(panels.roughList(pl, p).map((r) => r.featureId), lows);
  // Typing a tape-measured length takes the item off both.
  const taped = clone(p);
  taped.features.find((f) => f.id === lows[0]).overrideFt = 16;
  const tp = plan.computePlan(taped);
  assert.equal(panels.stepWarnings(tp)[3].low, lows.length - 1);
  assert.ok(!panels.roughList(tp, taped).some((r) => r.featureId === lows[0]));
  // No plan, no count.
  assert.equal(panels.stepWarnings(null)[3].low, 0);
  assert.deepEqual(panels.roughList(null, null), []);
});

// ---------------------------------------------------------------- Phase 1.1: Power step (SPEC §8.5 "Step 5")
test('8.5 the Power step opens with one plain sentence: good to go, or what to fix', () => {
  const p = tracedSample();
  const ok = panels.powerVerdict(plan.computePlan(p));
  assert.equal(ok.level, 'ok');
  assert.equal(ok.lead + ok.text, 'Good to go: these lights use 233 W, 16% of one outlet\'s safe limit.');

  // No outlet placed: it says so and how, with the load, without the planner's word "feed".
  const none = clone(p);
  none.outlets = [];
  const v0 = panels.powerVerdict(plan.computePlan(none));
  assert.equal(v0.level, 'warn');
  assert.match(v0.lead + v0.text, /^Place an outlet: these lights use 233 W\. Tap Place outlet/);
  assert.ok(!/feed/i.test(v0.lead + v0.text));

  // Nothing traced: nothing to judge yet.
  const empty = clone(p);
  empty.features = [];
  assert.equal(panels.powerVerdict(plan.computePlan(empty)).level, 'info');

  // A circuit close to its limit: the first thing to fix, and how many more there are.
  const hot = clone(p);
  hot.circuits[0].existingLoadW = 1400;
  const v1 = panels.powerVerdict(plan.computePlan(hot));
  assert.equal(v1.level, 'warn');
  assert.match(v1.lead, /^One thing to fix first:/);
  assert.match(v1.text, /Porch circuit would carry/);
  assert.equal(v1.more, 0);

  // An overloaded circuit is a danger, named first even when other warnings exist.
  const over = clone(p);
  over.features = over.features.filter((f) => f.id === 'ft_eave');
  over.features[0].overrideFt = 300;
  over.features[0].productId = 'c9-incan';
  over.outlets = over.outlets.filter((o) => o.id === 'out_porch');
  const overPlan = plan.computePlan(over);
  assert.ok(overPlan.power.warnings.some((w) => w.level === 'danger'));
  const v2 = panels.powerVerdict(overPlan);
  assert.equal(v2.level, 'danger');
  assert.match(v2.lead, /^Not safe yet:/);
  assert.equal(v2.more, overPlan.power.warnings.filter((w) => w.level === 'danger' || w.level === 'warn').length - 1);
  // Partial plans never throw.
  assert.equal(panels.powerVerdict({}).level, 'info');
  assert.equal(panels.powerVerdict(null).level, 'info');
});

test('8.5 an outlet card counts the cords plugged into it, not every run it powers', () => {
  const p = tracedSample();
  const pl = plan.computePlan(p);
  const info = exp.describeCords(pl, p);
  const porch = info.outlets.find((o) => o.id === 'out_porch');
  // The old card read "10 cords · 185 W": ten feeds hang off this outlet, but one cord goes back to it.
  assert.equal(pl.power.outlets.find((o) => o.id === 'out_porch').feedIds.length, 10);
  assert.equal(porch.cords, 1);
  assert.equal(porch.runs, 11);
  assert.equal(panels.outletSummaryText(porch), '1 cord at this outlet feeding 11 runs · 185 W');
  const garage = info.outlets.find((o) => o.id === 'out_garage');
  assert.equal(panels.outletSummaryText(garage), '1 cord at this outlet feeding 4 runs · 48.0 W');
  assert.equal(porch.runs + garage.runs, pl.runs.length, 'every run is counted once');
  assert.equal(panels.outletSummaryText({ feeds: 0, cords: 0, runs: 0, watts: 0 }), 'Nothing plugged in yet');
  assert.equal(panels.outletSummaryText(null), 'Nothing plugged in yet');
  // One cord per run (daisy chains off): six cords and power stakes at the porch outlet.
  const flat = clone(p);
  flat.library = { products: null, config: { power: { daisyChain: false } } };
  const flatInfo = exp.describeCords(plan.computePlan(flat), flat);
  const fp = flatInfo.outlets.find((o) => o.id === 'out_porch');
  assert.match(panels.outletSummaryText(fp), new RegExp('^' + fp.cords + ' cords at this outlet feeding ' + fp.runs + ' runs · .* W · \\d+ power stakes?$'));
  assert.ok(fp.cords > 1);
});

test('8.5 the supply tree lists each cord under its outlet: cord from the outlet, then jumpers, with the route', () => {
  const p = tracedSample();
  const pl = plan.computePlan(p);
  const info = exp.describeCords(pl, p);
  assert.equal(info.rows.length, pl.power.feeds.length, 'one row per feed');
  assert.deepEqual(info.outlets.map((o) => o.trees.length), [1, 1], 'one supply tree per cord that goes back to an outlet');
  const porch = info.outlets[0].trees[0];
  assert.deepEqual(porch.map((r) => r.feedId), pl.power.groups[0].feedIds, 'rows follow the tree depth-first');
  const root = porch[0];
  assert.equal(root.kind, 'home');
  assert.equal(root.depth, 0);
  assert.equal(root.line, '15 ft cord from Porch outlet');
  assert.equal(root.route, 'down 1.5 ft, 2.5 ft along the ground');
  assert.equal(root.gauge, '16-gauge');
  assert.equal(root.awg, 16);
  assert.equal(root.neededFt, 9);
  assert.ok(Math.abs(root.carriesW - 184.8) < 1e-9 && root.watts === 6, 'the cord carries everything hanging off it');
  assert.equal(root.tapText, '3-way tap at its start');
  const door = porch.find((r) => r.lights === 'Front door');
  assert.equal(door.kind, 'jumper');
  assert.equal(door.depth, 1);
  assert.equal(door.line, '6 ft jumper cord from the 3-way tap at the start of Walkway left edge');
  const walkRight = porch.find((r) => r.lights === 'Walkway right edge');
  assert.equal(walkRight.line, '6 ft jumper cord from the end of Front door');
  const bush1 = porch.find((r) => r.lights === 'Bush 1');
  assert.equal(bush1.tapText, '3-way tap at its end', 'two jumpers leave the end of Bush 1');
  // Counts of each kind match the planner's.
  assert.equal(info.rows.filter((r) => r.kind === 'home').length, pl.power.counts.homeRuns);
  assert.equal(info.rows.filter((r) => r.kind === 'jumper').length, pl.power.counts.jumpers);
  assert.ok(info.rows.every((r) => !/AWG|feed/i.test(r.line)), 'no trade terms in the sentence');
});

test('8.5 a run that plugs straight in is not "length unknown"; unknown and no-outlet rows say what to do', () => {
  const runs = [{ id: 'r1', label: 'Front eave', featureId: 'f1', unit: 'string' }, { id: 'r2', label: 'Left rake', featureId: 'f2', unit: 'string' },
    { id: 'r3', label: 'Shed', featureId: 'f3', unit: 'string' }, { id: 'r4', label: 'Fence', featureId: 'f4', unit: 'string' }];
  const feeds = [
    { id: 'a', runIds: ['r1'], outletId: 'o1', watts: 20, supplyW: 30, depth: 0, taps: 0, source: { kind: 'outlet', outletId: 'o1' }, plugIn: false, cordUnknown: false,
      cord: { kind: 'home', lengthFt: 18.2, boughtFt: 25, pieces: [25], awg: 16, voltageDropPct: 0.3, routeText: 'down 1.5 ft, 12 ft along the ground, up 9 ft' } },
    { id: 'b', runIds: ['r2'], outletId: 'o1', watts: 10, supplyW: 10, depth: 1, taps: 0, source: { kind: 'feed', feedId: 'a', port: 'end' }, plugIn: true, cordUnknown: false, cord: null },
    { id: 'c', runIds: ['r3'], outletId: 'o1', watts: 5, supplyW: 5, depth: 0, taps: 0, source: { kind: 'outlet', outletId: 'o1' }, plugIn: false, cordUnknown: true, cord: null },
    { id: 'd', runIds: ['r4'], outletId: null, watts: 5, supplyW: 0, depth: 0, taps: 0, source: null, plugIn: false, cordUnknown: false, cord: null },
  ];
  const fake = {
    runs,
    power: {
      feeds, outlets: [{ id: 'o1', label: 'Porch outlet', feedIds: ['a', 'b', 'c'], directFeedIds: ['a', 'c'], watts: 35, splitters: 1 }],
      groups: [{ id: 'g1', outletId: 'o1', rootFeedId: 'a', feedIds: ['a', 'b'] }, { id: 'g2', outletId: 'o1', rootFeedId: 'c', feedIds: ['c'] }],
    },
  };
  const project = { outlets: [{ id: 'o1', label: 'Porch outlet' }], features: [{ id: 'f2', params: { ownCord: false } }, { id: 'f3', params: { ownCord: true } }] };
  const info = exp.describeCords(fake, project);
  const [a, b, c, d] = info.rows;
  assert.equal(a.line, '25 ft cord from Porch outlet');
  assert.equal(b.kind, 'plugIn');
  assert.equal(b.what, 'Plugs straight in');
  assert.equal(b.line, 'Plugs straight into the end of Front eave (no cord needed)');
  assert.ok(!/unknown/i.test(b.line + b.what), 'plugging straight in is not an unknown length');
  assert.equal(b.neededFt, null);
  assert.equal(c.kind, 'unknown');
  assert.match(c.line, /length unknown \(set the scale of its wall in step 2\)/);
  assert.equal(c.ownCord, true);
  assert.equal(b.ownCord, false);
  assert.equal(d.kind, 'none');
  assert.equal(d.line, 'No outlet yet');
  assert.deepEqual(info.loose.map((r) => r.feedId), ['d']);
  assert.equal(info.outlets[0].cords, 2);
  assert.equal(info.outlets[0].trees.length, 2);
  assert.equal(panels.outletSummaryText(info.outlets[0]), '2 cords at this outlet feeding 3 runs · 35.0 W · 1 power stake');
  // Damaged or missing plans give an empty description, never an exception.
  assert.deepEqual(exp.describeCords(null, null), { outlets: [], loose: [], rows: [] });
  assert.deepEqual(exp.describeCords({ power: { feeds: 'x', outlets: [null] } }, {}).rows, []);
});

test('8.5 "Give this run its own cord" and "Link nearby runs" reach the planner (params.ownCord, config.power.daisyChain)', () => {
  const store = storeMod.createStore({ project: tracedSample(), persist: null, now: () => '2026-11-11T12:00:00.000Z' });
  const actions = actionsMod.createActions(store);
  const before = store.plan().power.counts;
  assert.deepEqual([before.homeRuns, before.jumpers], [2, 10]);
  // The door lights get their own cord: one more cord to an outlet, and nothing is jumpered to or from the door.
  assert.equal(actions.setOwnCord(['ft_door'], true), true);
  assert.equal(store.project().features.find((f) => f.id === 'ft_door').params.ownCord, true);
  const door = store.plan().power.feeds.find((f) => f.runIds.includes('run_ft_door'));
  assert.equal(door.source.kind, 'outlet');
  assert.ok(store.plan().power.feeds.every((f) => !(f.source && f.source.kind === 'feed' && f.source.feedId === door.id)));
  assert.ok(store.plan().power.counts.homeRuns > before.homeRuns);
  assert.equal(exp.describeCords(store.plan(), store.project()).rows.find((r) => r.feedId === door.id).ownCord, true);
  assert.equal(actions.setOwnCord(['ft_door'], true), false, 'setting it again changes nothing (no empty undo step)');
  assert.equal(store.undoLabel(), 'Give a run its own cord');
  // A cord that feeds two runs sets both in one undo step.
  actions.setOwnCord(['ft_gable_left', 'ft_gable_right'], true);
  assert.equal(store.undo(), 'Give a run its own cord');
  assert.ok(!store.project().features.find((f) => f.id === 'ft_gable_left').params.ownCord);
  // Reset to auto-plan clears it.
  actions.resetAutoPlan();
  assert.ok(!store.project().features.find((f) => f.id === 'ft_door').params.ownCord);
  assert.deepEqual(store.plan().power.counts.jumpers, before.jumpers);
  // The switch writes config.power.daisyChain the way the panel does (only the changed leaf is stored).
  const off = panels.diffConfig(catalog.DEFAULT_CONFIG, Object.assign(clone(catalog.DEFAULT_CONFIG), { power: Object.assign(clone(catalog.DEFAULT_CONFIG.power), { daisyChain: false }) }));
  assert.deepEqual(off, { power: { daisyChain: false } });
  actions.setLibraryConfig(off);
  const flat = store.plan().power.counts;
  assert.equal(flat.jumpers, 0);
  assert.equal(flat.homeRuns, store.plan().power.feeds.length);
  assert.equal(panels.powerVerdict(store.plan()).level, 'warn', 'one cord per run crosses the walkway on the sample: the sentence says to fix it');
});
