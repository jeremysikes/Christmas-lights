// Unit tests for ui.viewport's pure helpers (createViewport itself needs a browser; see tests/e2e).
const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
require('../src/ui/preview.js');
require('../src/ui/viewport.js');

const vp = LP.require('ui.viewport');
const sample = LP.require('sample');
const project = sample.createSample({ traced: true }).project;
const IMG = project.images[0].id;

test('module loads without a DOM and exports the viewport API', () => {
  assert.equal(typeof vp.createViewport, 'function');
  assert.throws(() => vp.createViewport({}), /host element and a store/);
});

test('selectionHandles returns one handle per editable point with a moveVertex target', () => {
  const eave = vp.selectionHandles(project, { kind: 'feature', id: 'ft_eave' });
  assert.equal(eave.length, 2);
  assert.deepEqual(eave[1].target, { kind: 'feature', id: 'ft_eave' });
  assert.equal(eave[1].index, 1);

  const front = vp.selectionHandles(project, { kind: 'plane', id: 'pl_front' });
  assert.equal(front.length, 4);
  assert.ok(front.every((h) => h.target.kind === 'planeRect' && h.target.planeId === 'pl_front'));

  const roof = vp.selectionHandles(project, { kind: 'plane', id: 'pl_roof' });
  assert.equal(roof.length, 2);
  assert.equal(roof[0].target.kind, 'planeLine');

  const ref = vp.selectionHandles(project, { kind: 'ref', id: 'ref_door_height' });   // planeId found by search
  assert.equal(ref.length, 2);
  assert.deepEqual(ref[0].target, { kind: 'ref', planeId: 'pl_front', refId: 'ref_door_height' });

  const outlet = vp.selectionHandles(project, { kind: 'outlet', id: 'out_porch' });
  assert.deepEqual(outlet.map((h) => h.target), [{ kind: 'outlet', id: 'out_porch' }]);

  assert.deepEqual(vp.selectionHandles(project, { kind: 'feature', id: 'missing' }), []);
  assert.deepEqual(vp.selectionHandles(null, null), []);
});

test('snapCandidates lists every vertex, corner, reference end and outlet on the photo (memoized)', () => {
  const list = vp.snapCandidates(project, IMG);
  assert.equal(vp.snapCandidates(project, IMG), list);
  const keys = new Set(list.map((c) => c.key));
  assert.ok(keys.has('feature:ft_eave'));
  assert.ok(keys.has('planeRect:pl_front'));
  assert.ok(keys.has('planeLine:pl_roof'));
  assert.ok(keys.has('ref:pl_front:ref_door_height'));
  assert.ok(keys.has('outlet:out_garage'));
  const featurePts = project.features.reduce((n, f) => n + f.points.length, 0);
  assert.ok(list.length >= featurePts + 4 + project.outlets.length);
  assert.deepEqual(vp.snapCandidates(project, 'img_other'), []);
  // Keys match targetKey so a dragged vertex can exclude itself.
  assert.equal(vp.targetKey({ kind: 'ref', planeId: 'pl_front', refId: 'ref_door_height' }), 'ref:pl_front:ref_door_height');
  assert.equal(vp.targetKey({ kind: 'planeRect', planeId: 'pl_front' }), 'planeRect:pl_front');
});

test('layersFor shows the right overlay per step and tool', () => {
  assert.equal(Object.values(vp.layersFor(1, 'select')).some(Boolean), false, 'step 1 is the clean preview');
  const s2 = vp.layersFor(2, 'select');
  assert.ok(s2.planes && s2.grid && s2.refs && !s2.features);
  const s3 = vp.layersFor(3, 'select');
  assert.ok(s3.features && s3.featureLabels && !s3.outlets);
  const s5 = vp.layersFor(5, 'select');
  assert.ok(s5.outlets && s5.power && s5.featuresFaint && !s5.features);
  assert.ok(vp.layersFor(4, 'select').featuresFaint && vp.layersFor(6, 'select').featureLabels);
  assert.ok(vp.layersFor(1, 'trace').features, 'tracing always shows features');
  assert.ok(vp.layersFor(4, 'outlet').outlets, 'placing outlets always shows outlets');
  assert.ok(vp.layersFor(3, 'rect').planes && vp.layersFor(3, 'line').refs);
});

// ---------------------------------------------------------------- review findings
test('mobile-ux:UX-04 quick taps while placing corners are never double taps; trace finishes only on the same spot', () => {
  const last = { t: 1000, x: 100, y: 100, mode: 'rect' };
  assert.equal(vp.isDoubleTap(last, { t: 1200, x: 125, y: 110 }, 'rect'), false, 'rect corners 27 px apart, 200 ms');
  assert.equal(vp.isDoubleTap(Object.assign({}, last, { mode: 'line' }), { t: 1100, x: 101, y: 100 }, 'line'), false);
  assert.equal(vp.isDoubleTap(Object.assign({}, last, { mode: 'outlet' }), { t: 1100, x: 101, y: 100 }, 'outlet'), false);
  const tr = Object.assign({}, last, { mode: 'trace' });
  assert.equal(vp.isDoubleTap(tr, { t: 1200, x: 130, y: 100 }, 'trace'), false, 'a nearby window corner is a new point');
  assert.equal(vp.isDoubleTap(tr, { t: 1200, x: 104, y: 103 }, 'trace'), true, 'a second tap on the same spot finishes');
  const sel = Object.assign({}, last, { mode: 'select' });
  assert.equal(vp.isDoubleTap(sel, { t: 1200, x: 120, y: 100 }, 'select'), true, 'select mode keeps double-tap zoom');
  assert.equal(vp.isDoubleTap(sel, { t: 1400, x: 100, y: 100 }, 'select'), false);
});

test('completeness:F2 the vertex snap radius is capped in image px when zoomed out', () => {
  // Phone fit zoom on a 2016 px wide photo: 14 CSS px would be ~78 image px.
  const r = vp.snapRadiusImg(0.18, 2016, 1512);
  assert.ok(r <= 2016 * 0.01 + 1e-9, 'capped at 1% of the long side (' + r.toFixed(1) + ')');
  // Zoomed in, the on-screen radius applies.
  assert.ok(Math.abs(vp.snapRadiusImg(2, 2016, 1512) - 7) < 1e-9);
});

test('completeness:F2 snap candidates know their surface (eave/base lines lie on the wall too)', () => {
  const c = vp.snapCandidates(project, IMG);
  const corner = c.find((x) => x.key === 'planeRect:pl_front');
  assert.deepEqual(corner.planes, ['pl_front']);
  const base = c.find((x) => x.key === 'planeLine:pl_yard');
  assert.deepEqual(base.planes.slice().sort(), ['pl_front', 'pl_yard']);
  const walk = c.find((x) => x.key === 'feature:ft_walk_left');
  assert.deepEqual(walk.planes, ['pl_yard']);
});

test('completeness:F8 / mobile-ux:UX-08 a selected line shows + handles between its points (not trees)', () => {
  const eave = vp.midpointHandles(project, { kind: 'feature', id: 'ft_eave' });
  assert.equal(eave.length, 1);
  const f = project.features.find((x) => x.id === 'ft_eave');
  assert.deepEqual(eave[0].p, [(f.points[0][0] + f.points[1][0]) / 2, (f.points[0][1] + f.points[1][1]) / 2]);
  const win = project.features.find((x) => x.id === 'ft_window_left');
  assert.equal(vp.midpointHandles(project, { kind: 'feature', id: 'ft_window_left' }).length, win.points.length, 'closed outlines get one per side');
  assert.equal(vp.midpointHandles(project, { kind: 'feature', id: 'ft_tree' }).length, 0);
});

// ---------------------------------------------------------------- Phase 1.1: cords on the photo (SPEC §8.5)
const planMod = LP.require('plan');
const samplePower = planMod.computePlan(project).power;

test('8.5 cord labels say what is bought: "25 ft cord" for a cord from an outlet, "6 ft jumper" for a jumper', () => {
  const home = samplePower.feeds.find((f) => f.id === 'feed_ft_garage_gutter_1');
  const jumper = samplePower.feeds.find((f) => f.id === 'feed_ft_door_1');
  assert.equal(home.cord.kind, 'home');
  assert.equal(vp.cordLabelText(home), '25 ft cord');
  assert.equal(jumper.cord.kind, 'jumper');
  assert.equal(vp.cordLabelText(jumper), '6 ft jumper');
  // Two pieces joined are one cord run: the label adds them up. No pieces: the length needed, rounded up.
  assert.equal(vp.cordLabelText({ cord: { kind: 'home', boughtFt: 150, lengthFt: 131.2 } }), '150 ft cord');
  assert.equal(vp.cordLabelText({ cord: { kind: 'jumper', lengthFt: 4.2 } }), '5 ft jumper');
  // A run that plugs straight in, or one with no measurable cord, has no cord label.
  assert.equal(vp.cordLabelText({ plugIn: true, cord: null }), null);
  assert.equal(vp.cordLabelText({ cordUnknown: true, cord: null }), null);
  assert.equal(vp.cordLabelText(null), null);
});

test('8.5 a cord is drawn in the pieces of its route, with the pieces on the ground marked', () => {
  const home = samplePower.feeds.find((f) => f.id === 'feed_ft_garage_gutter_1');
  const pieces = vp.cordPieces(home);
  assert.deepEqual(pieces.map((p) => p.ground), [false, true, false], 'down from the outlet, along the ground, up to the gutter');
  // The pieces join up into the cord path, outlet first.
  assert.deepEqual(pieces[0].pts[0], home.cordPath[0]);
  assert.deepEqual(pieces[pieces.length - 1].pts[1], home.cordPath[home.cordPath.length - 1]);
  for (let i = 1; i < pieces.length; i++) assert.deepEqual(pieces[i].pts[0], pieces[i - 1].pts[1]);
  // Routes without end points (older plans, uncalibrated fallbacks) fall back to the whole path as one piece.
  const bare = { cord: { kind: 'home', route: [{ kind: 'drop', lengthFt: 2 }] }, cordPath: [[0, 0], [0, 10], [50, 10]] };
  assert.deepEqual(vp.cordPieces(bare), [{ pts: [[0, 0], [0, 10], [50, 10]], ground: false }]);
  assert.deepEqual(vp.cordPieces({ cord: null, cordPath: null }), []);
  assert.deepEqual(vp.cordPieces(null), []);
});

test('8.5 3-way taps are marked where they sit: at a run\'s start, or at its end when two jumpers leave it', () => {
  const taps = vp.tapMarkers(samplePower);
  const tapped = samplePower.feeds.filter((f) => f.taps > 0).map((f) => f.id).sort();
  assert.deepEqual(Array.from(new Set(taps.map((t) => t.feedId))).sort(), tapped, 'every feed that needs a tap gets a marker');
  assert.equal(samplePower.counts.taps, 4);
  const byFeed = (id) => taps.filter((t) => t.feedId === id);
  // The cord from the Porch outlet ends in a tap at the start of the walkway lights (two jumpers branch off there).
  const walk = samplePower.feeds.find((f) => f.id === 'feed_ft_walk_left_1');
  assert.deepEqual(byFeed(walk.id).map((t) => [t.port, t.point]), [['start', walk.start.point]]);
  // Two jumpers leave the end of Bush 1: the tap sits where those jumpers begin.
  const bush = byFeed('feed_ft_bush_1_1');
  assert.equal(bush.length, 1);
  assert.equal(bush[0].port, 'end');
  const kid = samplePower.feeds.find((f) => f.source.kind === 'feed' && f.source.feedId === 'feed_ft_bush_1_1');
  assert.deepEqual(bush[0].point, kid.cordPath[0]);
  assert.deepEqual(vp.tapMarkers({ feeds: [{ id: 'a', taps: 0 }] }), []);
  assert.deepEqual(vp.tapMarkers(null), []);
});

test('8.5 a cord label only goes beside a stretch of its own cord that is on screen', () => {
  // A level cord across the middle of a 400 x 300 canvas: above it first, then below, at the middle and nearer the ends.
  const mid = vp.cordLabelSpots([[100, 150], [300, 150]], 400, 300);
  assert.equal(mid.visible, 200);
  assert.deepEqual([mid.alts[0].x, mid.alts[0].y, mid.alts[0].ny], [200, 150, -1], 'above the middle of the cord first');
  assert.deepEqual([mid.alts[1].x, mid.alts[1].y, mid.alts[1].ny], [200, 150, 1], 'then below it');
  assert.ok(mid.alts.length >= 6, 'a long stretch offers spots nearer its ends too');
  assert.ok(mid.alts.every((a) => a.x >= 100 && a.x <= 300 && a.y === 150));
  // Zoomed in so that the cord runs off the left edge: the spots stay on the part that can be seen.
  const cut = vp.cordLabelSpots([[-500, 150], [80, 150]], 400, 300);
  assert.ok(Math.abs(cut.visible - 80) < 1e-6);
  assert.ok(cut.alts.length > 0 && cut.alts.every((a) => a.x >= 0 && a.x <= 80 + 1e-6), 'no spot is made up for the part off screen');
  // Wholly off screen: nothing (the old overlay slid such labels along the edge of the photo, on top of each other).
  const off = vp.cordLabelSpots([[-500, 150], [-20, 150]], 400, 300);
  assert.equal(off.visible, 0);
  assert.deepEqual(off.alts, []);
  // An upright riser: the label goes to one side of it, not across it.
  const riser = vp.cordLabelSpots([[200, 250], [200, 50]], 400, 300);
  assert.ok(Math.abs(Math.abs(riser.alts[0].nx) - 1) < 1e-9 && Math.abs(riser.alts[0].ny) < 1e-9);
  assert.deepEqual(vp.clipSegment([-10, 10], [30, 10], 20, 20), [[0, 10], [20, 10]]);
  assert.equal(vp.clipSegment([-10, -10], [-5, 30], 20, 20), null);
});
