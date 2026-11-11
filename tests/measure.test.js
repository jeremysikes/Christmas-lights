const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
const measure = LP.require('measure');
const g = LP.require('geometry');
const catalog = LP.require('catalog');

// ------------------------------------------------------------------ independent pinhole camera (test-only)
// Wall frame: u right, v up, w toward the street. The camera looks at `target` from `dist` ft away (horizontal
// distance), turned `yawDeg` off the wall normal and tilted `tiltDeg` up, its center `height` ft above the base.
const W = 1600, H = 1200;
const F26 = (26 * Math.hypot(W, H)) / 43.2666;
function makeCamera({ yawDeg = 20, tiltDeg = 8, dist = 60, height = 5.5, target = [20, 0, 0], f = F26 } = {}) {
  const y = (yawDeg * Math.PI) / 180, t = (tiltDeg * Math.PI) / 180;
  const fwd = [Math.sin(y) * Math.cos(t), Math.sin(t), -Math.cos(y) * Math.cos(t)];
  const C = [target[0] - dist * Math.sin(y), height, target[2] + dist * Math.cos(y)];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((v) => v / l); };
  const right = norm(cross(fwd, [0, 1, 0]));
  return { C, rows: [right, cross(fwd, right), fwd], f };
}
function proj(cam, X) {
  const p = [X[0] - cam.C[0], X[1] - cam.C[1], X[2] - cam.C[2]];
  const [xc, yc, zc] = cam.rows.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]);
  return [(cam.f * xc) / zc + W / 2, (cam.f * yc) / zc + H / 2];
}

// ------------------------------------------------------------------ the test house (wall frame, feet)
const DOOR_H = 80 / 12;
const S = {
  rect: [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]], // house corners 40 x 12, [TL, TR, BR, BL]
  doorHeight: [[18, 0, 0], [18, DOOR_H, 0]],
  horizRef: [[2, 3, 0], [12, 3, 0]], // 10 ft horizontal reference
  eave: [[0, 12, 0], [40, 12, 0]], // 40 ft
  wallEdge: [[40, 0, 0], [40, 12, 0]], // 12 ft
  gable: [[8, 12, 0], [20, 20, 0], [32, 12, 0]], // in-plane 8/12 gable: two rakes of hypot(12, 8)
  window: [[5, 4, 0], [10, 4, 0], [10, 8, 0], [5, 8, 0]], // 5 x 4 window, perimeter 18
  diag: [[2, 1, 0], [38, 10, 0]],
  sideRake: [[40, 12, 0], [40, 18, -12]], // receding rake at 6/12: hypot(12, 6)
  ridge: [[12, 18, -12], [28, 18, -12]], // 16 ft ridge on the 6/12 roof plane
  base: [[0, 0, 0], [40, 0, 0]],
  walkway: [[18, 0, 2], [14, 0, 22]], // walkway edge on the ground: hypot(4, 20)
  tree: [[30, 0, 8], [30, 10, 8]], // 10 ft tree standing in the yard
};
const TRUE = {
  doorHeight: DOOR_H, eave: 40, wallEdge: 12, gable: 2 * Math.hypot(12, 8), window: 18, diag: Math.hypot(36, 9),
  sideRake: Math.hypot(12, 6), ridge: 16, walkway: Math.hypot(4, 20), tree: 10,
};
const pts = (cam, list) => list.map((X) => proj(cam, X));
const relErr = (a, b) => Math.abs(a - b) / Math.abs(b);

function image(camera, extra) {
  return Object.assign({ id: 'img_1', name: 'front.jpg', width: W, height: H, exif: null, camera: camera || { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img_1' }, extra || {});
}
function wall(cam, { widthFt = 40, heightFt = 12, rect = true, refs = [] } = {}) {
  return {
    id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall', color: '#4f9dff',
    rect: rect ? { corners: pts(cam, S.rect), widthFt, heightFt, presetId: null } : null,
    refs, derived: null,
  };
}
function lineRef(cam, id, list, lengthFt, extra) {
  return Object.assign({ id, kind: 'line', points: pts(cam, list), lengthFt, presetId: 'custom-line', courses: null, quality: 'high' }, extra || {});
}
function feature(cam, id, type, planeId, list, extra) {
  return Object.assign({
    id, imageId: 'img_1', planeId, type, label: id, points: pts(cam, list), closed: catalog.FEATURE_TYPES[type].closedDefault,
    overrideFt: null, productId: null, color: null,
    params: { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false, overrideWidthFt: null, overrideHeightFt: null },
  }, extra || {});
}
function projectOf({ images, planes, features, settings }) {
  return {
    schema: 'lightplan/project', version: 1, id: 'prj_test', name: 'Test',
    settings: Object.assign({ wastePct: 10, roofPitch: { rise: 6, run: 12 }, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' }, settings || {}),
    images, activeImageId: 'img_1', planes, features: features || [], outlets: [], circuits: [], library: { products: null, config: null },
  };
}
function report(name, measured, truth) {
  const e = (100 * (measured - truth)) / truth;
  console.log(`  ${name}: ${measured.toFixed(4)} ft vs ${truth.toFixed(4)} ft (error ${e >= 0 ? '+' : ''}${e.toFixed(4)}%)`);
  return Math.abs(e);
}

// ================================================================== accuracy
test('rect-known: in-plane lengths via homography are within 0.1%', () => {
  const cam = makeCamera();
  const p = projectOf({
    images: [image()], planes: [wall(cam)],
    features: [
      feature(cam, 'door', 'door', 'pl_front', S.doorHeight),
      feature(cam, 'eave', 'roofline', 'pl_front', S.eave),
      feature(cam, 'gable', 'rake', 'pl_front', S.gable),
      feature(cam, 'window', 'window', 'pl_front', S.window),
      feature(cam, 'diag', 'railing', 'pl_front', S.diag),
    ],
  });
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_front.mode, 'rect-known');
  for (const [id, truth] of [['door', TRUE.doorHeight], ['eave', TRUE.eave], ['gable', TRUE.gable], ['window', TRUE.window], ['diag', TRUE.diag]]) {
    const m = r.features[id];
    assert.ok(m.ok, id);
    assert.equal(m.method, 'plane');
    assert.ok(report('in-plane ' + id, m.measuredFt, truth) < 0.1, id);
  }
  assert.ok(Math.abs(r.features.window.areaSqFt - 20) < 0.02);
  // waste applies to linear types
  assert.ok(Math.abs(r.features.eave.withWasteFt - r.features.eave.lengthFt * 1.1) < 1e-9);
});

test('pose from the wall rectangle: camera center within 1%', () => {
  const cam = makeCamera();
  const r = measure.solvePlanes(projectOf({ images: [image()], planes: [wall(cam)] }));
  const sol = r.planes.pl_front;
  assert.ok(sol.pose && sol.pose.ok);
  const d = Math.hypot(sol.pose.C[0] - cam.C[0], sol.pose.C[1] - cam.C[1], sol.pose.C[2] - cam.C[2]);
  const err = (100 * d) / Math.hypot(...cam.C);
  console.log(`  pose camera center error: ${err.toFixed(5)}%`);
  assert.ok(err < 1);
  assert.equal(r.cameras.img_1.source, 'rectangle');
  assert.ok(sol.viewAngleDeg > 15 && sol.viewAngleDeg < 25);
  assert.deepEqual(Object.keys(sol.extent), ['minU', 'minV', 'maxU', 'maxV']);
});

test('roof-3d: receding side rake and ridge on the roof plane within 1%', () => {
  const cam = makeCamera();
  const roof = { id: 'pl_roof', imageId: 'img_1', name: 'Main roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_front', line: pts(cam, S.eave), pitch: { rise: 6, run: 12 } } };
  const p = projectOf({
    images: [image()], planes: [wall(cam), roof],
    features: [feature(cam, 'side', 'rake', 'pl_roof', S.sideRake), feature(cam, 'ridge', 'ridge', 'pl_roof', S.ridge)],
  });
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_roof.mode, 'roof-3d');
  assert.deepEqual(r.planes.pl_roof.pitch, { rise: 6, run: 12, source: 'user' });
  assert.equal(r.features.side.method, 'roof-3d');
  assert.ok(report('roof-3d side rake', r.features.side.measuredFt, TRUE.sideRake) < 1);
  assert.ok(report('roof-3d ridge', r.features.ridge.measuredFt, TRUE.ridge) < 1);
  // no off-plane penalty for a ridge on a roof plane
  assert.ok(!r.features.ridge.confidence.reasons.some((s) => /ridge sits above/.test(s)));
});

test('ground-3d: walkway edge within 1% (and a tree in the yard)', () => {
  const cam = makeCamera();
  const ground = { id: 'pl_yard', imageId: 'img_1', name: 'Front yard', kind: 'ground', rect: null, refs: [], derived: { parentPlaneId: 'pl_front', line: pts(cam, S.base), pitch: null } };
  const p = projectOf({
    images: [image()], planes: [wall(cam), ground],
    features: [feature(cam, 'walk', 'walkway', 'pl_yard', S.walkway), feature(cam, 'tree', 'tree', 'pl_yard', S.tree)],
  });
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_yard.mode, 'ground-3d');
  assert.equal(r.features.walk.method, 'ground-3d');
  assert.ok(report('ground-3d walkway', r.features.walk.measuredFt, TRUE.walkway) < 1);
  assert.ok(report('ground-3d tree height', r.features.tree.heightFt, TRUE.tree) < 1);
  // without a pose the ground plane cannot be solved
  const p2 = projectOf({ images: [image()], planes: [wall(cam, { rect: false, refs: [lineRef(cam, 'r1', S.doorHeight, DOOR_H)] }), ground] });
  const r2 = measure.solvePlanes(p2);
  assert.equal(r2.planes.pl_yard.ok, false);
  assert.match(r2.planes.pl_yard.reason, /Ground plane needs a perspective rectangle on its wall/);
});

test('rect-refs: unknown-size rectangle + door height gives horizontal lengths within 1% (focal from rectangle)', () => {
  const cam = makeCamera();
  const p = projectOf({
    images: [image()], planes: [wall(cam, { widthFt: null, heightFt: null, refs: [lineRef(cam, 'door', S.doorHeight, DOOR_H, { presetId: 'door-height' })] })],
    features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave), feature(cam, 'diag', 'railing', 'pl_front', S.diag)],
  });
  const r = measure.measureProject(p);
  assert.equal(r.cameras.img_1.source, 'rectangle');
  assert.equal(r.planes.pl_front.mode, 'rect-refs');
  assert.ok(report('rect-refs eave (horizontal)', r.features.eave.measuredFt, TRUE.eave) < 1);
  assert.ok(report('rect-refs diagonal', r.features.diag.measuredFt, TRUE.diag) < 1);
  assert.equal(r.planes.pl_front.checks, 0);
  assert.equal(r.planes.pl_front.disagreementPct, null);
});

test('rect-refs with a focal preset 30% wrong: anisotropic fit brings both directions within 2%', () => {
  const cam = makeCamera();
  const refs = [lineRef(cam, 'h', S.horizRef, 10), lineRef(cam, 'v', S.doorHeight, DOOR_H)];
  const p = projectOf({
    images: [image({ mode: 'manual', presetId: null, focalPx: F26 * 1.3 })],
    planes: [wall(cam, { widthFt: null, heightFt: null, refs })],
    features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave), feature(cam, 'edge', 'column', 'pl_front', S.wallEdge)],
  });
  const r = measure.measureProject(p);
  const sol = r.planes.pl_front;
  assert.equal(r.cameras.img_1.source, 'manual');
  assert.equal(sol.scale.anisotropic, true);
  assert.ok(report('anisotropic horizontal (eave)', r.features.eave.measuredFt, TRUE.eave) < 2);
  assert.ok(report('anisotropic vertical (wall edge)', r.features.edge.measuredFt, TRUE.wallEdge) < 2);
  // an isotropic fit (only the vertical ref) would be visibly off horizontally with this wrong focal
  const p2 = projectOf({ images: [image({ mode: 'manual', focalPx: F26 * 1.3 })], planes: [wall(cam, { widthFt: null, heightFt: null, refs: [refs[1]] })], features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave)] });
  const iso = measure.measureProject(p2).features.eave.measuredFt;
  console.log(`  (same photo, vertical ref only: eave error ${(100 * (iso - 40) / 40).toFixed(2)}%)`);
  assert.ok(relErr(iso, 40) > 0.02);
});

test('refs-only with a fronto-parallel camera is within 0.5%', () => {
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 0, height: 6 });
  const p = projectOf({
    images: [image()], planes: [wall(cam, { rect: false, refs: [lineRef(cam, 'door', S.doorHeight, DOOR_H), lineRef(cam, 'h', S.horizRef, 10)] })],
    features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave), feature(cam, 'gable', 'rake', 'pl_front', S.gable)],
  });
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_front.mode, 'refs-only');
  assert.ok(report('refs-only eave', r.features.eave.measuredFt, TRUE.eave) < 0.5);
  assert.ok(report('refs-only gable', r.features.gable.measuredFt, TRUE.gable) < 0.5);
  assert.ok(r.planes.pl_front.warnings.some((w) => /straight on/.test(w)));
  assert.equal(r.planes.pl_front.checks, 1);
});

test('two references where one is 10% wrong: disagreementPct ~10 and a warning', () => {
  const cam = makeCamera();
  // rect-known wall + a door-height ref entered 10% too long
  const p = projectOf({ images: [image()], planes: [wall(cam, { refs: [lineRef(cam, 'door', S.doorHeight, DOOR_H * 1.1)] })] });
  const r = measure.measureProject(p);
  const sol = r.planes.pl_front;
  console.log(`  disagreement (rect + 10%-wrong ref): ${sol.disagreementPct.toFixed(3)}%`);
  assert.ok(Math.abs(sol.disagreementPct - 10) < 0.5);
  assert.ok(Math.abs(sol.refResults[0].errorPct + 9.09) < 0.1);
  assert.ok(sol.warnings.some((w) => /References on 'Front wall' disagree by/.test(w)));
  assert.ok(r.warnings.some((w) => w.code === 'ref-disagreement' && w.planeId === 'pl_front'));
  // two refs on a refs-only wall, one 10% wrong
  const cam0 = makeCamera({ yawDeg: 0, tiltDeg: 0, height: 6 });
  const p2 = projectOf({ images: [image()], planes: [wall(cam0, { rect: false, refs: [lineRef(cam0, 'a', S.doorHeight, DOOR_H), lineRef(cam0, 'b', S.horizRef, 11)] })] });
  const sol2 = measure.solvePlanes(p2).planes.pl_front;
  console.log(`  disagreement (two refs, one 10% wrong): ${sol2.disagreementPct.toFixed(3)}%`);
  assert.ok(Math.abs(sol2.disagreementPct - 10) < 0.5);
  assert.ok(sol2.warnings.some((w) => /disagree by 10\.0%/.test(w)));
});

test('in-plane 8/12 gable estimates rise 8; a roof plane with pitch null uses it (source estimated)', () => {
  const cam = makeCamera();
  const roof = { id: 'pl_roof', imageId: 'img_1', name: 'Main roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_front', line: pts(cam, S.eave), pitch: null } };
  const p = projectOf({
    settings: { roofPitch: null },
    images: [image()], planes: [wall(cam), roof],
    features: [feature(cam, 'gable', 'rake', 'pl_front', S.gable), feature(cam, 'side', 'rake', 'pl_roof', S.sideRake)],
  });
  const r = measure.measureProject(p);
  assert.equal(r.pitch.source, 'estimated');
  assert.equal(r.pitch.rise, 8);
  assert.equal(r.pitch.run, 12);
  assert.ok(Math.abs(r.pitch.angleDeg - Math.atan2(8, 12) * 180 / Math.PI) < 0.01);
  assert.deepEqual(r.planes.pl_roof.pitch, { rise: 8, run: 12, source: 'estimated' });
  assert.deepEqual(r.features.gable.pitchEstimate.rise, 8);
  assert.ok(r.features.side.confidence.reasons.some((s) => /estimated/.test(s)));
  assert.ok(r.warnings.some((w) => w.code === 'pitch-estimated'));
  // estimatePitch directly
  const est = measure.estimatePitch(p, r.planes);
  assert.equal(est.rise, 8);
  assert.equal(est.samples.length, 2);
  // with no rakes and no setting the default 6/12 is used and flagged
  const p2 = projectOf({ settings: { roofPitch: null }, images: [image()], planes: [wall(cam), roof], features: [feature(cam, 'side', 'rake', 'pl_roof', S.sideRake)] });
  const r2 = measure.measureProject(p2);
  assert.equal(r2.planes.pl_roof.pitch.source, 'default');
  assert.ok(r2.features.side.confidence.reasons.some((s) => /6\/12 is assumed/.test(s)));
  assert.ok(r2.warnings.some((w) => w.code === 'pitch-default'));
});

test('roof-ortho uses the parent wall and orthoPitchLength per segment', () => {
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 0, height: 6 });
  const roof = { id: 'pl_roof', imageId: 'img_1', name: 'Main roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_front', line: pts(cam, S.eave), pitch: { rise: 6, run: 12 } } };
  // a rake seen straight on rises 6 ft in the wall plane while running 12 ft horizontally along the eave
  const faceOnRake = [[40, 12, 0], [28, 18, 0]];
  const p = projectOf({
    images: [image()], planes: [wall(cam, { rect: false, refs: [lineRef(cam, 'door', S.doorHeight, DOOR_H), lineRef(cam, 'h', S.horizRef, 10)] }), roof],
    features: [feature(cam, 'r', 'rake', 'pl_roof', faceOnRake)],
  });
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_roof.mode, 'roof-ortho');
  assert.equal(r.features.r.method, 'roof-ortho');
  const expected = Math.sqrt(12 * 12 + (6 / Math.sin(Math.atan2(6, 12))) ** 2);
  assert.ok(relErr(r.features.r.measuredFt, expected) < 0.005);
});

// ================================================================== confidence
test('confidence: rect-known + cross-check + small view angle is high', () => {
  const cam = makeCamera({ yawDeg: 12, tiltDeg: 8 });
  const p = projectOf({
    images: [image()], planes: [wall(cam, { refs: [lineRef(cam, 'door', S.doorHeight, DOOR_H, { presetId: 'door-height' })] })],
    features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave)],
  });
  const r = measure.measureProject(p);
  const c = r.features.eave.confidence;
  assert.ok(r.planes.pl_front.viewAngleDeg < 20);
  assert.equal(r.planes.pl_front.checks, 1);
  assert.equal(c.level, 'high');
  assert.equal(c.score, 100);
});

test('confidence: refs-only with a single short courses ref is not high', () => {
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 0, height: 6 });
  const ref = measure.refFromPreset('siding-4', pts(cam, [[2, 2, 0], [2, 4, 0]]), { courses: 6, id: 'ref_s' });
  assert.equal(ref.kind, 'line');
  assert.ok(Math.abs(ref.lengthFt - 2) < 1e-12);
  const p = projectOf({ images: [image()], planes: [wall(cam, { rect: false, refs: [ref] })], features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave)] });
  const c = measure.measureProject(p).features.eave.confidence;
  assert.notEqual(c.level, 'high');
  assert.ok(c.reasons.some((s) => /6 courses/.test(s)));
  assert.ok(c.reasons.some((s) => /medium-quality/.test(s)));
});

test('confidence: override is high / 100 "Tape-measured"', () => {
  const cam = makeCamera();
  const p = projectOf({ images: [image()], planes: [wall(cam, { rect: false })], features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave, { overrideFt: 42 })] });
  const m = measure.measureProject(p).features.eave;
  assert.equal(m.ok, true, 'override works even on an uncalibrated plane');
  assert.equal(m.method, 'override');
  assert.equal(m.lengthFt, 42);
  assert.equal(m.measuredFt, null);
  assert.deepEqual(m.confidence, { level: 'high', score: 100, reasons: ['Tape-measured'] });
  assert.deepEqual(measure.scoreConfidence({ overridden: true }), { level: 'high', score: 100, reasons: ['Tape-measured'] });
});

test('scoreConfidence deductions follow the spec table', () => {
  const s = (fx) => measure.scoreConfidence(Object.assign({ checks: 1 }, fx)).score;
  assert.equal(s({ mode: 'rect-known' }), 100);
  assert.equal(s({ mode: 'rect-refs' }), 95);
  // Level caps (score clamped into the capped level's band): refs-only is Low unless two directions agree.
  assert.equal(s({ mode: 'refs-only' }), 49);
  assert.equal(s({ mode: 'refs-only', refsBothDirections: true }), 74);
  assert.equal(s({ mode: 'roof-3d', pitchSource: 'default' }), 49);
  assert.equal(s({ mode: 'roof-3d' }), 90);
  assert.equal(s({ mode: 'rect-known', checks: 0 }), 95);
  assert.equal(s({ mode: 'rect-known', disagreementPct: 4 }), 90);
  assert.equal(s({ mode: 'rect-known', disagreementPct: 8 }), 80);
  assert.equal(s({ mode: 'rect-known', disagreementPct: 12 }), 65);
  assert.equal(s({ mode: 'rect-known', viewAngleDeg: 40 }), 85);
  assert.equal(s({ mode: 'rect-known', viewAngleDeg: 60 }), 75);
  assert.equal(s({ mode: 'rect-refs', focalSource: 'default' }), 74);
  assert.equal(s({ mode: 'rect-refs', focalSource: 'default', anisotropic: true }), 85);
  assert.equal(s({ mode: 'rect-known', offPlane: 'tree' }), 49);
  assert.equal(s({ mode: 'rect-known', offPlane: 'bush' }), 74);
  assert.equal(s({ mode: 'rect-known', uncertaintyPct: 2 }), 100);
  assert.equal(s({ mode: 'rect-known', uncertaintyPct: 4 }), 74);
  assert.equal(s({ mode: 'rect-known', uncertaintyPct: 7 }), 49);
  assert.equal(s({ mode: 'rect-known', disagreementPct: 8, disagreementZ: 1.5 }), 100);
  assert.equal(s({ mode: 'rect-known', extrapolation: true }), 90);
  assert.equal(s({ mode: 'rect-known', pixelLength: 40 }), 90);
  assert.equal(measure.scoreConfidence({ mode: 'uncalibrated' }).level, 'low');
  assert.equal(measure.scoreConfidence({ mode: 'refs-only', checks: 0, onlyMediumLowRefs: true, minCourses: 4 }).level, 'low');
});

test('8.4 scoreConfidence: taps placed zoomed out change the reason, never the level or the score', () => {
  const sc = (fx) => measure.scoreConfidence(Object.assign({ mode: 'rect-known', checks: 1 }, fx));
  const zoom = (px, what) => 'Tapped zoomed out (about ±' + px + ' px on the photo): zoom in and re-tap ' + what + '.';
  const usual = (u) => 'Expected error about ±' + u + '% from tap precision; zoom in or use a larger rectangle.';
  // Coarse taps are most of the expected error: say so, and say what to re-tap.
  assert.deepEqual(sc({ uncertaintyPct: 7, uncertaintyBasePct: 2.2, tapPx: 16, tapWhat: 'rect' }),
    { level: 'low', score: 49, reasons: [zoom(16, 'the corners of the rectangle') + ' Expected error about ±7.0% as tapped.'] });
  assert.deepEqual(sc({ uncertaintyPct: 4, uncertaintyBasePct: 1, tapPx: 12.82, tapWhat: 'item' }),
    { level: 'medium', score: 74, reasons: [zoom(13, 'the points of this item') + ' Expected error about ±4.0% as tapped.'] });
  // Coarse taps are the smaller part, but they are what pushes the expected error over a limit (3% or 6%).
  assert.equal(sc({ uncertaintyPct: 3.4, uncertaintyBasePct: 2.9, tapPx: 5, tapWhat: 'ref' }).reasons[0], zoom(5, 'the two ends of the reference length') + ' Expected error about ±3.4% as tapped.');
  assert.equal(sc({ uncertaintyPct: 6.5, uncertaintyBasePct: 5.8, tapPx: 5, tapWhat: 'refs' }).reasons[0], zoom(5, 'the ends of the reference lengths') + ' Expected error about ±6.5% as tapped.');
  // Neither: the usual advice stays, word for word.
  assert.equal(sc({ uncertaintyPct: 7, uncertaintyBasePct: 6.5, tapPx: 4, tapWhat: 'item' }).reasons[0], usual('7.0'));
  assert.equal(sc({ uncertaintyPct: 4, uncertaintyBasePct: 3.5, tapPx: 4, tapWhat: 'rect' }).reasons[0], usual('4.0'));
  // The surface-specific advice stays as well when coarse taps are not the cause.
  assert.match(sc({ mode: 'ground-3d', uncertaintyPct: 30, uncertaintyBasePct: 27, tapPx: 4, tapWhat: 'item' }).reasons[0], /^Expected error about ±30% from tap precision; from street level the ground is seen almost edge-on\./);
  assert.match(sc({ mode: 'roof-3d', uncertaintyPct: 20, uncertaintyBasePct: 18, tapPx: 15, tapWhat: 'eave' }).reasons[0], /^Expected error about ±20% from tap precision; roof lengths depend on the camera angle/);
  // ... and gives way to the zoom reason when they are, on any surface.
  assert.equal(sc({ mode: 'roof-3d', uncertaintyPct: 40, uncertaintyBasePct: 18, tapPx: 15, tapWhat: 'eave' }).reasons[0], zoom(15, 'the two ends of the eave line') + ' Expected error about ±40% as tapped.');
  assert.equal(sc({ mode: 'ground-3d', uncertaintyPct: 45, uncertaintyBasePct: 27, tapPx: 9, tapWhat: 'base' }).reasons[0], zoom(9, 'the two ends of the wall base line') + ' Expected error about ±45% as tapped.');
  assert.equal(sc({ uncertaintyPct: 12, uncertaintyBasePct: 2, tapPx: 16, tapWhat: 'rect+ref' }).reasons[0], zoom(16, 'the corners of the rectangle and the two ends of the reference length') + ' Expected error about ±12% as tapped.');
  // Past ±50% the number is put in words; a measurement that a nudge breaks altogether needs no number.
  assert.equal(sc({ mode: 'ground-3d', uncertaintyPct: 244, uncertaintyBasePct: 27, tapPx: 16, tapWhat: 'rect' }).reasons[0], zoom(16, 'the corners of the rectangle') + ' As tapped, this measurement could be off by more than half.');
  assert.equal(sc({ uncertaintyPct: Infinity, tapPx: 16, tapWhat: 'rect' }).reasons[0], zoom(16, 'the corners of the rectangle'));
  assert.equal(sc({ uncertaintyPct: Infinity }).reasons[0], 'A small tap error changes this measurement a lot. Re-tap the rectangle and references, zoomed in.');
  // An unknown source still reads as a sentence; no base figure means the coarse taps are taken as the cause.
  assert.equal(sc({ uncertaintyPct: 9, tapPx: 20, tapWhat: 'something-new' }).reasons[0], zoom(20, 'the points') + ' Expected error about ±9.0% as tapped.');
  // Nothing to say when the expected error is within the High limit, or when the taps were not coarse.
  assert.ok(!sc({ uncertaintyPct: 2.8, uncertaintyBasePct: 1, tapPx: 8, tapWhat: 'rect' }).reasons.some((s) => /zoomed out/.test(s)));
  for (const tapPx of [2.5, 2, 0, -5, NaN, Infinity, null, undefined, '16']) {
    assert.equal(sc({ uncertaintyPct: 7, uncertaintyBasePct: 2, tapPx, tapWhat: 'rect' }).reasons[0], usual('7.0'), 'tapPx ' + String(tapPx));
  }
  // The level and the score follow the expected error exactly as before, whatever the taps were.
  for (const mode of ['rect-known', 'rect-refs', 'refs-only', 'roof-3d', 'ground-3d']) {
    for (const u of [1, 2.9, 3.1, 5.9, 6.1, 25, 300, Infinity]) {
      const plain = measure.scoreConfidence({ mode, checks: 1, uncertaintyPct: u });
      const coarse = measure.scoreConfidence({ mode, checks: 1, uncertaintyPct: u, uncertaintyBasePct: u / 4, tapPx: 16, tapWhat: 'rect' });
      assert.deepEqual([coarse.level, coarse.score, coarse.reasons.length], [plain.level, plain.score, plain.reasons.length], mode + ' ±' + u);
    }
  }
});

test('ridge off-plane penalty applies only on a wall plane', () => {
  const cam = makeCamera();
  const p = projectOf({ images: [image()], planes: [wall(cam)], features: [feature(cam, 'ridge', 'ridge', 'pl_front', [[12, 15, 0], [28, 15, 0]])] });
  const m = measure.measureProject(p).features.ridge;
  assert.ok(m.confidence.reasons.some((s) => /ridge sits above/.test(s)));
});

// ================================================================== trees, bushes, totals
test('spiral wrap: 8 ft tall, 10 in diameter, 4 in spacing is about 63.3 ft', () => {
  assert.ok(Math.abs(measure.spiralWrapFt(8, 10, 4) - 63.34) < 0.01);
  const cam = makeCamera();
  const tree = feature(cam, 'tree', 'tree', 'pl_front', [[30, 0, 0], [30, 8, 0]], { overrideFt: 8 });
  tree.params = Object.assign({}, tree.params, { diameterIn: 10, spiralSpacingIn: 4 });
  const p = projectOf({ images: [image()], planes: [wall(cam)], features: [tree] });
  const m = measure.measureProject(p).features.tree;
  assert.equal(m.overridden, true);
  assert.equal(m.method, 'override');
  assert.equal(m.heightFt, 8);
  assert.ok(Math.abs(m.wrapFt - 63.34) < 0.01, String(m.wrapFt));
  assert.equal(m.lengthFt, m.wrapFt);
  assert.equal(m.withWasteFt, m.lengthFt, 'no waste on trees');
  // measured (not overridden) tree on the wall: height from the photo, off-plane penalty
  const t2 = feature(cam, 't2', 'tree', 'pl_front', [[30, 0, 0], [30, 8, 0]]);
  const m2 = measure.measureProject(projectOf({ images: [image()], planes: [wall(cam)], features: [t2] })).features.t2;
  assert.ok(Math.abs(m2.heightFt - 8) < 0.01);
  assert.ok(Math.abs(m2.wrapFt - 63.34) < 0.05);
  assert.ok(m2.confidence.reasons.some((s) => /stands in front of the wall/.test(s)));
  // canopy mode
  const t3 = feature(cam, 't3', 'tree', 'pl_front', [[30, 0, 0], [30, 8, 0]], { overrideFt: 8 });
  t3.params = Object.assign({}, t3.params, { wrapMode: 'canopy' });
  const m3 = measure.measureFeature(t3, null, {});
  assert.equal(m3.lights, 800);
  assert.equal(m3.wrapFt, null);
  assert.equal(m3.lengthFt, 8);
});

test('bush rule: 3 ft wide x 4 ft tall gives 267 lights (100 per 1.5 ft of height per 3 ft of width); totals exclude bushes from feet', () => {
  const cam = makeCamera();
  const bush = feature(cam, 'bush', 'bush', 'pl_front', [[5, 0, 0], [8, 0, 0], [8, 4, 0], [5, 4, 0]]);
  const bushOv = feature(cam, 'bush2', 'bush', 'pl_front', [[20, 0, 0], [21, 0, 0], [21, 1, 0]], { overrideFt: 99 });
  bushOv.params = Object.assign({}, bushOv.params, { overrideWidthFt: 3, overrideHeightFt: 4 });
  const p = projectOf({ images: [image()], planes: [wall(cam)], features: [bush, bushOv, feature(cam, 'eave', 'roofline', 'pl_front', S.eave)] });
  const r = measure.measureProject(p);
  // The rule of thumb in the library: lightsPerUnit for every heightUnitFt of height and every widthUnitFt of width.
  assert.deepEqual([catalog.DEFAULT_CONFIG.bush.lightsPerUnit, catalog.DEFAULT_CONFIG.bush.heightUnitFt, catalog.DEFAULT_CONFIG.bush.widthUnitFt], [100, 1.5, 3]);
  const m = r.features.bush;
  assert.ok(Math.abs(m.widthFt - 3) < 0.01 && Math.abs(m.heightFt - 4) < 0.01);
  assert.ok(Math.abs(m.lights - 267) <= 1, String(m.lights)); // 100 × (4 / 1.5) × (3 / 3) = 266.7
  assert.equal(m.lengthFt, null);
  assert.ok(Math.abs(m.measuredFt - 14) < 0.02, 'perimeter');
  const m2 = r.features.bush2;
  assert.equal(m2.lights, 267);
  assert.equal(m2.overridden, true);
  assert.equal(m2.method, 'override');
  assert.equal(m2.lengthFt, null, 'overrideFt is ignored for bushes');
  const bt = r.totals.byType.bush;
  assert.equal(bt.count, 2);
  assert.equal(bt.lengthFt, 0);
  assert.ok(Math.abs(bt.lights - 534) <= 2);
  assert.ok(Math.abs(r.totals.totalFt - r.features.eave.lengthFt) < 1e-9);
  assert.ok(Math.abs(r.totals.totalWithWasteFt - r.features.eave.withWasteFt) < 1e-9);
  assert.equal(r.totals.byType.roofline.count, 1);
  // The count follows the library's numbers: a denser rule (100 lights per 1.5 ft of height per 1 ft of width,
  // the Phase 1 default) gives 800 for the same bush.
  const dense = Object.assign({}, catalog.DEFAULT_CONFIG, { bush: Object.assign({}, catalog.DEFAULT_CONFIG.bush, { widthUnitFt: 1 }) });
  const rd = measure.measureProject(p, dense);
  assert.ok(Math.abs(rd.features.bush.lights - 800) <= 2, String(rd.features.bush.lights));
  assert.equal(rd.features.bush2.lights, 800);
});

// ================================================================== robustness
test('seeded ±1.5 px noise on corners and points keeps in-rect lengths within 2%', () => {
  const cam = makeCamera();
  let worst = 0, worstId = null;
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = g.rng(seed);
    const jitter = (p) => [p[0] + (rnd() * 2 - 1) * 1.5, p[1] + (rnd() * 2 - 1) * 1.5];
    const w = wall(cam);
    w.rect.corners = w.rect.corners.map(jitter);
    const feats = [['eave', 'roofline', S.eave], ['base', 'walkway', S.base], ['diag', 'railing', S.diag], ['window', 'window', S.window], ['edge', 'column', S.wallEdge]]
      .map(([id, type, list]) => { const f = feature(cam, id, type, 'pl_front', list); f.points = f.points.map(jitter); return f; });
    const r = measure.measureProject(projectOf({ images: [image()], planes: [w], features: feats }));
    const truth = { eave: 40, base: 40, diag: TRUE.diag, window: 18, edge: 12 };
    for (const id of Object.keys(truth)) {
      const e = relErr(id === 'edge' ? r.features[id].heightFt : r.features[id].measuredFt, truth[id]);
      if (e > worst) { worst = e; worstId = id; }
    }
  }
  console.log(`  worst in-rect error over 25 noisy seeds: ${(worst * 100).toFixed(3)}% (${worstId})`);
  assert.ok(worst < 0.02);
});

test('measureProject never throws on garbage and reports ok:false with reasons', () => {
  const cam = makeCamera();
  const good = wall(cam);
  const p = projectOf({
    images: [image(), { id: 'img_bad', width: NaN, height: 'x' }, null],
    planes: [
      good,
      { id: 'pl_orphan', imageId: 'img_missing', name: 'Side wall', kind: 'wall', rect: { corners: pts(cam, S.rect), widthFt: 40, heightFt: 12 }, refs: [] },
      { id: 'pl_three', imageId: 'img_1', name: 'Three corners', kind: 'wall', rect: { corners: pts(cam, S.rect).slice(0, 3), widthFt: 40, heightFt: 12 }, refs: [] },
      { id: 'pl_nan', imageId: 'img_1', name: 'NaN wall', kind: 'wall', rect: { corners: [[NaN, 1], [2, 3], [4, 5], [6, 7]], widthFt: 4, heightFt: 4 }, refs: [{ id: 'r', kind: 'line', points: [[1, NaN], [2, 2]], lengthFt: 3 }, null, 7] },
      { id: 'pl_roof', imageId: 'img_1', name: 'Roof', kind: 'roof', derived: { parentPlaneId: 'nope', line: null, pitch: 'steep' } },
      { id: 'pl_weird', kind: 'ceiling' },
      null, 'plane', 42,
    ],
    features: [
      feature(cam, 'one', 'roofline', 'pl_front', [[0, 12, 0]]),
      Object.assign(feature(cam, 'nan', 'roofline', 'pl_front', S.eave), { points: [[NaN, 2], [3, 4]] }),
      feature(cam, 'unknownPlane', 'gutter', 'pl_does_not_exist', S.eave),
      feature(cam, 'orphan', 'gutter', 'pl_orphan', S.eave),
      feature(cam, 'three', 'gutter', 'pl_three', S.eave),
      { id: 'badType', type: 'laser', planeId: 'pl_front', points: [[1, 2], [3, 4]] },
      { id: 'noPoints', type: 'window', planeId: 'pl_front', points: 'abc' },
      null, 5, 'feature', { type: 'tree', planeId: 'pl_front', points: [[1, 2]], params: 'x' },
      feature(cam, 'ok', 'roofline', 'pl_front', S.eave),
    ],
  });
  let r;
  assert.doesNotThrow(() => { r = measure.measureProject(p); });
  assert.ok(r.features.ok.ok);
  for (const id of ['one', 'nan', 'unknownPlane', 'orphan', 'three', 'badType', 'noPoints']) {
    assert.equal(r.features[id].ok, false, id);
    assert.equal(typeof r.features[id].reason, 'string', id);
    assert.ok(r.features[id].reason.length > 10, id);
    assert.equal(r.features[id].confidence.level, 'low');
  }
  assert.match(r.features.unknownPlane.reason, /not on a known wall or plane/);
  assert.match(r.features.orphan.reason, /photo .* is missing/);
  assert.equal(r.planes.pl_orphan.ok, false);
  assert.equal(r.planes.pl_three.ok, false);
  assert.ok(r.planes.pl_three.warnings.some((w) => /needs 4 corners/.test(w)));
  assert.equal(r.planes.pl_nan.ok, false);
  assert.equal(r.planes.pl_roof.ok, false);
  assert.equal(r.planes.pl_weird.ok, false);
  assert.ok(r.warnings.some((w) => w.code === 'feature-unmeasured' && w.featureId === 'unknownPlane'));
  assert.ok(r.warnings.every((w) => typeof w.message === 'string' && (w.level === 'warn' || w.level === 'info')));
  // totally broken input
  for (const junk of [null, undefined, 42, 'x', [], { images: 'x', planes: { a: 1 }, features: 7 }, { settings: null, planes: [{ id: 'p', kind: 'wall', imageId: 'i', rect: 5, refs: 'r' }], images: [{ id: 'i', width: 10, height: 10 }] }]) {
    let out;
    assert.doesNotThrow(() => { out = measure.measureProject(junk); });
    assert.ok(out && out.totals && out.features && Array.isArray(out.warnings));
  }
  assert.doesNotThrow(() => measure.measureFeature(undefined, undefined, undefined));
  assert.doesNotThrow(() => measure.measurePoints(null, true, null));
  assert.deepEqual(measure.planeGridLines(null, 1), []);
  assert.equal(measure.imageToPlane(null, [1, 2]), null);
  assert.equal(measure.planeToImage({ ok: true, Hplane2img: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, [NaN, 1]), null);
});

test('measureProject does not mutate its input and is deterministic', () => {
  const cam = makeCamera();
  const p = projectOf({ images: [image()], planes: [wall(cam, { refs: [lineRef(cam, 'door', S.doorHeight, DOOR_H)] })], features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave)] });
  const before = JSON.stringify(p);
  const a = measure.measureProject(p), b = measure.measureProject(p);
  assert.equal(JSON.stringify(p), before);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('measureProject for 100 features takes < 20 ms', () => {
  const cam = makeCamera();
  const roof = { id: 'pl_roof', imageId: 'img_1', name: 'Main roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_front', line: pts(cam, S.eave), pitch: null } };
  const ground = { id: 'pl_yard', imageId: 'img_1', name: 'Yard', kind: 'ground', rect: null, refs: [], derived: { parentPlaneId: 'pl_front', line: pts(cam, S.base), pitch: null } };
  const kinds = [['roofline', 'pl_front', S.eave], ['rake', 'pl_front', S.gable], ['window', 'pl_front', S.window], ['ridge', 'pl_roof', S.ridge], ['walkway', 'pl_yard', S.walkway], ['tree', 'pl_yard', S.tree]];
  const features = [];
  for (let i = 0; i < 100; i++) { const k = kinds[i % kinds.length]; features.push(feature(cam, 'f' + i, k[0], k[1], k[2])); }
  const p = projectOf({ settings: { roofPitch: null }, images: [image()], planes: [wall(cam, { refs: [lineRef(cam, 'door', S.doorHeight, DOOR_H)] }), roof, ground], features });
  measure.measureProject(p); // warm up the JIT
  const runs = 10;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) measure.measureProject(p);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
  console.log(`  measureProject, 100 features: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 20);
});

// ================================================================== helpers and formatting
test('formatLength', () => {
  assert.equal(measure.formatLength(32.333), '32′ 4″');
  assert.equal(measure.formatLength(11.999), '12′ 0″');
  assert.equal(measure.formatLength(0), '0′ 0″');
  assert.equal(measure.formatLength(32.333, 'ft-decimal'), '32.3 ft');
  assert.equal(measure.formatLength(null), '—');
  assert.equal(measure.formatLength(NaN, 'ft-decimal'), '—');
  assert.equal(measure.formatLength(-1.5), '-1′ 6″');
});

test('refFromPreset and presets', () => {
  const door = measure.refFromPreset('door-height', [[1, 2], [1, 100]]);
  assert.equal(door.kind, 'line');
  assert.ok(Math.abs(door.lengthFt - 80 / 12) < 1e-12);
  assert.equal(door.quality, 'high');
  assert.match(door.id, /^ref_/);
  assert.equal(measure.refFromPreset('door-height', [[1, 2], [1, 100]]).id, door.id, 'deterministic id');
  const garage = measure.refFromPreset('garage-double', [[0, 0], [10, 0], [10, 5], [0, 5]], { id: 'ref_g' });
  assert.deepEqual([garage.kind, garage.widthFt, garage.heightFt, garage.id], ['rect', 16, 7, 'ref_g']);
  const brick = measure.refFromPreset('brick', [[0, 0], [0, 10]], { courses: 12 });
  assert.ok(Math.abs(brick.lengthFt - (12 * 8) / 3 / 12) < 1e-12);
  assert.equal(brick.quality, 'medium');
  const custom = measure.refFromPreset('custom-line', [[0, 0], [0, 10]], { lengthFt: 12.5 });
  assert.equal(custom.lengthFt, 12.5);
  // The whole list, in the order the reference picker shows it (SPEC §5.5 plus the §8.4 garage door widths).
  assert.deepEqual(measure.REF_PRESETS.map((p) => [p.id, p.label, p.kind, p.quality]), [
    ['door-height', 'Entry door height (80 in)', 'line', 'high'],
    ['door-width', 'Entry door width (36 in)', 'line', 'high'],
    ['door-rect', 'Entry door (36 × 80 in)', 'rect', 'high'],
    ['garage-single', 'Single garage door (9 × 7 ft)', 'rect', 'high'],
    ['garage-double', 'Double garage door (16 × 7 ft)', 'rect', 'high'],
    ['garage-height', 'Garage door height (7 ft)', 'line', 'high'],
    ['garage-width-16', 'Garage door width (16 ft)', 'line', 'high'],
    ['garage-width-9', 'Garage door width (9 ft)', 'line', 'high'],
    ['garage-width-8', 'Garage door width (8 ft)', 'line', 'high'],
    ['siding-4', 'Vinyl siding, 4 in courses', 'courses', 'medium'],
    ['siding-5', 'Vinyl siding, 5 in courses', 'courses', 'medium'],
    ['brick', 'Brick courses (3 ≈ 8 in)', 'courses', 'medium'],
    ['custom-line', 'Custom length', 'line', 'high'],
    ['custom-rect', 'Custom rectangle', 'rect', 'high'],
  ]);
  assert.equal(new Set(measure.REF_PRESETS.map((p) => p.id)).size, measure.REF_PRESETS.length, 'preset ids are unique');
  assert.deepEqual(measure.WALL_RECT_PRESETS.map((p) => p.id), ['door-rect', 'garage-single', 'garage-double', 'custom-rect', 'unknown']);
  const pts = [[0, 0], [0, 1]];
  measure.refFromPreset('door-height', pts);
  assert.deepEqual(pts, [[0, 0], [0, 1]], 'input not mutated');
});

test('8.4 two taps across a garage door are a reference: width 16, 9 and 8 ft', () => {
  for (const [id, ft] of [['garage-width-16', 16], ['garage-width-9', 9], ['garage-width-8', 8]]) {
    const preset = measure.getRefPreset(id);
    assert.equal(preset.lengthIn, ft * 12, id);
    const ref = measure.refFromPreset(id, [[100, 500], [500, 500]]);
    assert.deepEqual([ref.kind, ref.lengthFt, ref.presetId, ref.quality, ref.courses], ['line', ft, id, 'high', null], id);
    assert.equal(ref.points.length, 2, 'two taps');
    assert.equal(measure.refLabel(ref), 'Garage door width (' + ft + ' ft)');
  }
  // On a straight-on photo the two taps set the scale of the wall: 16 ft across 400 px is 25 px per foot.
  const ref = measure.refFromPreset('garage-width-16', [[1000, 900], [1400, 900]], { id: 'ref_gw' });
  const p = projectOf({
    images: [image()],
    planes: [{ id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall', rect: null, refs: [ref], derived: null }],
    features: [{ id: 'eave', imageId: 'img_1', planeId: 'pl_front', type: 'roofline', label: 'Eave', points: [[150, 700], [1450, 700]], closed: false, overrideFt: null, productId: null, color: null, params: {} }],
  });
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_front.mode, 'refs-only');
  assert.deepEqual(r.planes.pl_front.refResults.map((x) => x.label), ['Garage door width (16 ft)']);
  assert.ok(Math.abs(r.features.eave.measuredFt - 52) < 1e-9, String(r.features.eave.measuredFt));
});

test('a rect reference becomes the plane rectangle when the wall has none', () => {
  const cam = makeCamera();
  const garage = measure.refFromPreset('custom-rect', pts(cam, [[22, 7, 0], [38, 7, 0], [38, 0, 0], [22, 0, 0]]), { id: 'ref_gar', widthFt: 16, heightFt: 7 });
  const p = projectOf({ images: [image()], planes: [wall(cam, { rect: false, refs: [garage, lineRef(cam, 'door', S.doorHeight, DOOR_H)] })], features: [feature(cam, 'eave', 'roofline', 'pl_front', S.eave)] });
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_front.mode, 'rect-known');
  assert.equal(r.planes.pl_front.checks, 1);
  assert.ok(report('eave from garage-door rectangle', r.features.eave.measuredFt, 40) < 0.1);
});

test('imageToPlane / planeToImage round trip and grid lines', () => {
  const cam = makeCamera();
  const p = projectOf({
    images: [image()],
    planes: [wall(cam), { id: 'pl_yard', imageId: 'img_1', name: 'Yard', kind: 'ground', rect: null, refs: [], derived: { parentPlaneId: 'pl_front', line: pts(cam, S.base), pitch: null } }],
  });
  const r = measure.solvePlanes(p);
  const sol = r.planes.pl_front;
  const px = proj(cam, [12, 5, 0]);
  const uv = measure.imageToPlane(sol, px);
  assert.ok(Math.abs(uv[0] - 12) < 1e-6 && Math.abs(uv[1] - 5) < 1e-6);
  const back = measure.planeToImage(sol, uv);
  assert.ok(g.dist(back, px) < 1e-6);
  const lines = measure.planeGridLines(sol, 1, { minU: 0, minV: 0, maxU: 40, maxV: 12 });
  assert.equal(lines.length, 41 + 13);
  // the u = 0 line runs along the left edge of the wall
  assert.ok(g.dist(lines[0][0], proj(cam, [0, 0, 0])) < 1e-6);
  assert.ok(measure.planeGridLines(r.planes.pl_yard, 1).length > 10);
  assert.ok(measure.planeGridLines(sol, 0.001, { minU: 0, minV: 0, maxU: 40, maxV: 12 }).length <= 400);
});

test('measurePoints gives live readouts', () => {
  const cam = makeCamera();
  const sol = measure.solvePlanes(projectOf({ images: [image()], planes: [wall(cam)] })).planes.pl_front;
  const m = measure.measurePoints(pts(cam, S.window), true, sol);
  assert.ok(Math.abs(m.lengthFt - 18) < 1e-6);
  assert.ok(Math.abs(m.areaSqFt - 20) < 1e-6);
  assert.ok(Math.abs(m.widthFt - 5) < 1e-6 && Math.abs(m.heightFt - 4) < 1e-6);
  assert.equal(m.segmentsFt.length, 4);
  assert.ok(m.pixelLength > 0);
  const un = measure.measurePoints(pts(cam, S.window), true, null);
  assert.equal(un.lengthFt, null);
  assert.ok(un.pixelLength > 0);
});
