// Unit tests for ui.preview's bulb layout (computeBulbs is DOM-free, so it runs in Node).
const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
require('../src/ui/preview.js');

const preview = LP.require('ui.preview');
const sample = LP.require('sample');
const planMod = LP.require('plan');
const measure = LP.require('measure');
const g = LP.require('geometry');
const catalog = LP.require('catalog');

const clone = (v) => JSON.parse(JSON.stringify(v));
const base = sample.createSample({ traced: true });
const IMG = base.project.images[0].id;

function planFor(project) { return planMod.computePlan(project); }
function bulbsOf(bulbs, plan, featureId) {
  const idx = plan.runs.findIndex((r) => r.featureId === featureId);
  return bulbs.filter((b) => b.run === idx);
}
function withFeature(project, id, patch) {
  const p = clone(project);
  const f = p.features.find((x) => x.id === id);
  Object.assign(f, patch);
  return p;
}

test('computeBulbs is memoized on (plan object, imageId) and never mutates its inputs', () => {
  const project = clone(base.project);
  const before = JSON.stringify(project);
  const plan = planFor(project);
  const a = preview.computeBulbs(project, plan, IMG);
  assert.equal(preview.computeBulbs(project, plan, IMG), a);
  assert.notEqual(preview.computeBulbs(project, plan, 'img_other'), a);
  assert.equal(preview.computeBulbs(project, plan, 'img_other').length, 0);
  const again = preview.computeBulbs(project, planFor(project), IMG);
  assert.notEqual(again, a);
  assert.deepEqual(again.map((b) => [b.x, b.y, b.phase]), a.map((b) => [b.x, b.y, b.phase]), 'deterministic');
  assert.equal(JSON.stringify(project), before);
  assert.ok(Array.isArray(a.strands));
  for (const b of a) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && b.r > 0, 'finite bulb');
    assert.ok(['bulb', 'mini', 'drop', 'stake'].includes(b.kind));
    assert.ok(b.phase >= 0 && b.phase < 1);
    assert.match(b.color, /^#[0-9a-f]{6}$/i);
  }
});

test('linear runs use equal TRUE spacing in plane coordinates (perspective-correct)', () => {
  const project = clone(base.project);
  const plan = planFor(project);
  const bulbs = bulbsOf(preview.computeBulbs(project, plan, IMG), plan, 'ft_eave');
  const sol = plan.measured.planes.pl_front;
  const uv = bulbs.map((b) => measure.imageToPlane(sol, [b.x, b.y]));
  const gaps = [];
  for (let i = 1; i < uv.length; i++) gaps.push(g.dist(uv[i - 1], uv[i]));
  const lengthFt = plan.measured.features.ft_eave.measuredFt;
  const expected = lengthFt / Math.round(lengthFt / 1);   // C9: 12 in spacing, spread evenly end to end
  for (const d of gaps) assert.ok(Math.abs(d - expected) < 1e-6, 'gap ' + d + ' ft');
  assert.equal(bulbs.length, Math.round(lengthFt) + 1);
  // ...which in the photo means unequal pixel gaps (the far end is smaller).
  const px = [];
  for (let i = 1; i < bulbs.length; i++) px.push(Math.hypot(bulbs[i].x - bulbs[i - 1].x, bulbs[i].y - bulbs[i - 1].y));
  assert.ok(Math.max(...px) / Math.min(...px) > 1.02, 'perspective changes the pixel spacing');
});

test('dense runs keep >= 2.5 px between bulbs and add a soft strand', () => {
  // A rope light (1 in spacing) on the far-away ridge is far denser than 2.5 image px.
  const project = withFeature(base.project, 'ft_ridge', { productId: 'rope-led-18' });
  const plan = planFor(project);
  const all = preview.computeBulbs(project, plan, IMG);
  const bulbs = bulbsOf(all, plan, 'ft_ridge');
  assert.ok(bulbs.length > 5);
  for (let i = 1; i < bulbs.length; i++) {
    assert.ok(Math.hypot(bulbs[i].x - bulbs[i - 1].x, bulbs[i].y - bulbs[i - 1].y) >= preview.MIN_SPACING_PX - 1e-9);
  }
  assert.ok(all.strands.some((s) => s.kind === 'glow' && s.pts.length >= 2), 'soft strand drawn');
});

test('closed outlines (windows) do not double the first bulb', () => {
  const project = clone(base.project);
  const plan = planFor(project);
  const bulbs = bulbsOf(preview.computeBulbs(project, plan, IMG), plan, 'ft_window_left');
  const first = bulbs[0], last = bulbs[bulbs.length - 1];
  assert.ok(Math.hypot(first.x - last.x, first.y - last.y) >= preview.MIN_SPACING_PX);
  assert.ok(bulbs.length > 40 && bulbs.length < 70, 'about 18 ft of 4 in spacing: ' + bulbs.length);
});

test('bushes: seeded scatter inside the polygon, at most 600 bulbs', () => {
  const project = clone(base.project);
  const plan = planFor(project);
  const all = preview.computeBulbs(project, plan, IMG);
  for (const id of ['ft_bush_1', 'ft_bush_2', 'ft_bush_3']) {
    const f = project.features.find((x) => x.id === id);
    const bulbs = bulbsOf(all, plan, id);
    assert.ok(bulbs.length > 50 && bulbs.length <= preview.MAX_BUSH_BULBS, id + ': ' + bulbs.length);
    for (const b of bulbs) assert.ok(g.pointInPolygon([b.x, b.y], f.points), 'inside');
    assert.ok(bulbs.every((b) => b.dim === 2 && b.s > 0));
  }
  // A big bush is capped at 600.
  const big = withFeature(base.project, 'ft_bush_1', { points: [[100, 300], [700, 300], [700, 900], [100, 900]] });
  const bigPlan = planFor(big);
  const bb = bulbsOf(preview.computeBulbs(big, bigPlan, IMG), bigPlan, 'ft_bush_1');
  assert.equal(bb.length, preview.MAX_BUSH_BULBS);
});

test('net lights on a bush form a grid', () => {
  const project = withFeature(base.project, 'ft_bush_2', { productId: 'net-led-4x6' });
  const plan = planFor(project);
  const bulbs = bulbsOf(preview.computeBulbs(project, plan, IMG), plan, 'ft_bush_2');
  assert.ok(bulbs.length > 10);
  const rows = new Set(bulbs.map((b) => b.y.toFixed(3)));
  assert.ok(rows.size < bulbs.length / 3, 'bulbs share rows');
});

test('trees wrap a zig-zag spiral across the trunk width, far side dimmed', () => {
  const project = clone(base.project);
  const plan = planFor(project);
  const f = project.features.find((x) => x.id === 'ft_tree');
  const bulbs = bulbsOf(preview.computeBulbs(project, plan, IMG), plan, 'ft_tree');
  assert.ok(bulbs.length > 100);
  const [b0, t0] = [f.points[0], f.points[1]];
  const H = g.dist(b0, t0);
  const heightFt = plan.measured.features.ft_tree.heightFt;
  const radiusPx = ((f.params.diameterIn / 24) * H) / heightFt;
  let maxOff = 0;
  for (const b of bulbs) maxOff = Math.max(maxOff, g.pointSegmentDistance([b.x, b.y], b0, t0).d);
  assert.ok(maxOff <= radiusPx + 1e-6 && maxOff > radiusPx * 0.9, 'spans the trunk: ' + maxOff + ' vs r ' + radiusPx);
  assert.ok(bulbs.some((b) => b.a < 0.5) && bulbs.some((b) => b.a > 0.9), 'front bright, back dim');
});

test('icicles hang drops straight down below the line', () => {
  const project = withFeature(base.project, 'ft_eave', { productId: 'icicle-led-300' });
  const plan = planFor(project);
  const bulbs = bulbsOf(preview.computeBulbs(project, plan, IMG), plan, 'ft_eave');
  const drops = bulbs.filter((b) => b.kind === 'drop');
  const line = bulbs.filter((b) => b.kind === 'mini');
  assert.ok(drops.length > line.length, 'more drop bulbs than line bulbs');
  const sol = plan.measured.planes.pl_front;
  const lineV = measure.imageToPlane(sol, [line[0].x, line[0].y])[1];
  for (const d of drops.slice(0, 40)) assert.ok(measure.imageToPlane(sol, [d.x, d.y])[1] < lineV, 'below the eave');
});

test('path stakes: a bulb on top of a short stake line on the ground plane', () => {
  const project = clone(base.project);
  const plan = planFor(project);
  const all = preview.computeBulbs(project, plan, IMG);
  const bulbs = bulbsOf(all, plan, 'ft_walk_left');
  assert.ok(bulbs.length >= 5 && bulbs.every((b) => b.kind === 'stake'));
  const stakes = all.strands.filter((s) => s.kind === 'stake');
  assert.ok(stakes.length >= bulbs.length);
  for (const s of stakes) assert.ok(s.pts[1][1] < s.pts[0][1], 'stake top is above its foot');
});

test('multicolor cycles along the run from its start', () => {
  const project = clone(base.project);
  project.settings.colorMode = 'multicolor';
  const plan = planFor(project);
  const palette = catalog.COLOR_MODES.multicolor.colors;
  const bulbs = bulbsOf(preview.computeBulbs(project, plan, IMG), plan, 'ft_eave');
  bulbs.slice(0, 10).forEach((b, i) => assert.equal(b.color, palette[i % palette.length]));
  const run = plan.runs.find((r) => r.featureId === 'ft_eave');
  assert.ok(Math.hypot(bulbs[0].x - run.start[0], bulbs[0].y - run.start[1]) < 1e-6, 'starts at the power end');
});

test('uncalibrated planes still get bulbs, spaced in image pixels', () => {
  const practice = clone(sample.createSample({ traced: false }).project);
  practice.features.push({ id: 'ft_x', imageId: practice.images[0].id, planeId: practice.planes[0].id, type: 'roofline', label: 'Eave',
    points: [[400, 600], [1000, 600]], closed: false, overrideFt: null, productId: null, color: null, params: {} });
  const plan = planFor(practice);
  assert.equal(plan.measured.planes[practice.planes[0].id].ok, false);
  const bulbs = preview.computeBulbs(practice, plan, practice.images[0].id);
  assert.ok(bulbs.length > 10, 'bulbs: ' + bulbs.length);
  for (let i = 1; i < bulbs.length; i++) assert.ok(bulbs[i].x > bulbs[i - 1].x);
});

test('robust to missing or damaged data', () => {
  assert.equal(preview.computeBulbs(null, null, 'x').length, 0);
  assert.equal(preview.computeBulbs(undefined, undefined).length, 0);
  assert.deepEqual(preview.computeBulbs({}, { runs: 'nope' }, 'x').strands, []);
  const p = clone(base.project);
  p.features.push({ id: 'bad1', imageId: IMG, type: 'roofline', points: [[1, 'x']] });
  p.features.push({ id: 'bad2', imageId: IMG, type: 'unknown', points: [[1, 1], [5, 5]] });
  p.features.push({ id: 'bad3', imageId: IMG, type: 'bush', points: [[1, 1], [2, 2]] });
  p.features.push(null);
  const plan = planFor(p);
  const bulbs = preview.computeBulbs(p, plan, IMG);
  assert.ok(bulbs.length > 1000);
  // No plan at all (or a plan whose design stage failed): type defaults and project colors are used.
  const noRuns = preview.computeBulbs(p, { runs: [], measured: plan.measured }, IMG);
  assert.ok(noRuns.length > 500);
  assert.ok(noRuns.every((b) => b.run === -1));
  const noPlan = preview.computeBulbs(p, null, IMG);
  assert.ok(noPlan.length > 100);
});

test('twinkleFactor stays in range and varies over time', () => {
  const b = { phase: 0.3, kind: 'mini' };
  const vals = [];
  for (let t = 0; t < 10; t += 0.25) vals.push(preview.twinkleFactor(b, t));
  assert.ok(vals.every((v) => v > 0 && v <= 1));
  assert.ok(Math.max(...vals) - Math.min(...vals) > 0.3);
  const big = [];
  for (let t = 0; t < 10; t += 0.25) big.push(preview.twinkleFactor({ phase: 0.3, kind: 'bulb' }, t));
  assert.ok(Math.min(...big) >= 0.6, 'big bulbs only shimmer');
});
