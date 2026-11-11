// Regression tests for the measurement-honesty review findings (M1–M10, F1, F3, F7) and for the Phase 1.1 UX
// review's UX-01 and UX-02 (taps placed zoomed out, SPEC §8.4). Each test reproduces the reviewer's scenario and
// pins the corrected behaviour: a measurement that can be badly off must not be shown at a confidence level that
// promises more than it delivers.
const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
const measure = LP.require('measure');
const sample = LP.require('sample');
const catalog = LP.require('catalog');

// ------------------------------------------------------------------ independent pinhole camera
function makeCamera({ W = 2048, H = 1536, f35 = 26, yawDeg = 20, tiltDeg = 6, dist = 60, height = 5, target = [25, 6, 0], f } = {}) {
  const focal = f || (f35 * Math.hypot(W, H)) / 43.2666;
  const y = (yawDeg * Math.PI) / 180, t = (tiltDeg * Math.PI) / 180;
  const fwd = [Math.sin(y) * Math.cos(t), Math.sin(t), -Math.cos(y) * Math.cos(t)];
  const C = [target[0] - dist * Math.sin(y), height, target[2] + dist * Math.cos(y)];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((v) => v / l); };
  const right = norm(cross(fwd, [0, 1, 0]));
  return { W, H, f: focal, C, rows: [right, cross(fwd, right), fwd] };
}
function proj(cam, X) {
  const p = [X[0] - cam.C[0], X[1] - cam.C[1], X[2] - cam.C[2]];
  const [xc, yc, zc] = cam.rows.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]);
  return [(cam.f * xc) / zc + cam.W / 2, (cam.f * yc) / zc + cam.H / 2];
}
const pts = (cam, list) => list.map((X) => proj(cam, X));
const relErr = (a, b) => (a - b) / b;
const DOOR_H = 80 / 12;

function image(cam, extra) {
  return Object.assign({ id: 'img', name: 'h.jpg', width: cam.W, height: cam.H, exif: { focal35: 26 }, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img' }, extra || {});
}
function lineRef(id, points, lengthFt, presetId) {
  return { id, kind: 'line', points, lengthFt, presetId: presetId || 'custom-line', courses: null, quality: 'high' };
}
function wallPlane(rect, refs) { return { id: 'pl_w', imageId: 'img', name: 'Front wall', kind: 'wall', rect, refs: refs || [], derived: null }; }
function feature(id, type, points, planeId, params) {
  return {
    id, imageId: 'img', planeId: planeId || 'pl_w', type, label: id, points, closed: !!catalog.FEATURE_TYPES[type].closedDefault,
    overrideFt: null, productId: null, color: null,
    params: Object.assign({ mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false, overrideWidthFt: null, overrideHeightFt: null }, params || {}),
  };
}
function projectOf(images, planes, features, settings) {
  return {
    schema: 'lightplan/project', version: 1, id: 'p', name: 'T',
    settings: Object.assign({ wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' }, settings || {}),
    images, activeImageId: 'img', planes, features, outlets: [], circuits: [], library: { products: null, config: null },
  };
}
const RANK = { low: 0, medium: 1, high: 2 };
/** A level is honest for an error if High means |err| ≤ 3% and Medium means |err| ≤ 6%. */
function assertHonest(name, m, err) {
  const e = Math.abs(err);
  if (e > 0.06) assert.equal(m.confidence.level, 'low', name + ': ' + (100 * err).toFixed(1) + '% off but ' + m.confidence.level + ' (' + m.confidence.reasons.join(' | ') + ')');
  else if (e > 0.03) assert.notEqual(m.confidence.level, 'high', name + ': ' + (100 * err).toFixed(1) + '% off but high');
}

// ------------------------------------------------------------------ sample house helpers
const S0 = sample.createSample();
function sampleCam() {
  const c = S0.camera, d = Math.PI / 180;
  const fwd = [-Math.sin(c.yawDeg * d) * Math.cos(c.tiltDeg * d), Math.sin(c.tiltDeg * d), -Math.cos(c.yawDeg * d) * Math.cos(c.tiltDeg * d)];
  const rl = Math.hypot(fwd[2], fwd[0]);
  const right = [-fwd[2] / rl, 0, fwd[0] / rl];
  const down = [fwd[1] * right[2] - fwd[2] * right[1], fwd[2] * right[0] - fwd[0] * right[2], fwd[0] * right[1] - fwd[1] * right[0]];
  return { W: S0.width, H: S0.height, f: c.f, C: c.position, rows: [right, down, fwd] };
}
const freshSample = () => JSON.parse(JSON.stringify(S0.project));
function sampleErrors(project) {
  const r = measure.measureProject(project);
  const out = {};
  for (const f of project.features) {
    const m = r.features[f.id], t = S0.groundTruth[f.id];
    if (!m.ok) continue;
    out[f.id] = { m, err: typeof t === 'number' ? relErr(m.measuredFt, t) : Math.max(Math.abs(relErr(m.widthFt, t.widthFt)), Math.abs(relErr(m.heightFt, t.heightFt))) };
  }
  return { r, out };
}

// ================================================================== M1: tap noise is propagated
test('M1: a garage-door rectangle with ±2 px corner errors cannot rate a 10%-off eave High', () => {
  const cam = makeCamera({ yawDeg: 20, dist: 60, target: [25, 6, 0] });
  const garage = pts(cam, [[30, 7, 0], [46, 7, 0], [46, 0, 0], [30, 0, 0]]);
  const d = [[2, 2], [-2, -2], [2, 2], [-2, -2]];
  const corners = garage.map((p, i) => [p[0] + d[i][0], p[1] + d[i][1]]);
  const eave = pts(cam, [[0, 12, 0], [50, 12, 0]]);
  const p = projectOf([image(cam)], [wallPlane({ corners, widthFt: 16, heightFt: 7, presetId: 'garage-double' })], [feature('eave', 'roofline', eave)]);
  const m = measure.measureProject(p).features.eave;
  const err = relErr(m.measuredFt, 50);
  console.log(`  eave ${m.measuredFt.toFixed(2)} ft vs 50 (${(100 * err).toFixed(1)}%), ${m.confidence.level} ${m.confidence.score}`);
  assert.ok(Math.abs(err) > 0.03, 'precondition: the corner errors throw the eave off');
  assertHonest('eave', m, err);
  assert.ok(m.confidence.reasons.some((s) => /Expected error about ±\d+(\.\d)?% from how exactly the points could be tapped/.test(s)), m.confidence.reasons.join(' | '));
  assert.ok(m.uncertaintyPct > 3, 'uncertaintyPct ' + m.uncertaintyPct);
});

test('M1: exact taps on a big known rectangle stay High with a small expected error', () => {
  const cam = makeCamera({ yawDeg: 12, dist: 55, target: [20, 6, 0] });
  const rect = pts(cam, [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]]);
  const p = projectOf([image(cam)], [wallPlane({ corners: rect, widthFt: 40, heightFt: 12 }, [lineRef('door', pts(cam, [[18, 0, 0], [18, DOOR_H, 0]]), DOOR_H, 'door-height')])],
    [feature('eave', 'roofline', pts(cam, [[0, 12, 0], [40, 12, 0]]))]);
  const m = measure.measureProject(p).features.eave;
  assert.equal(m.confidence.level, 'high');
  assert.ok(m.uncertaintyPct > 0 && m.uncertaintyPct < 3, String(m.uncertaintyPct));
});

// ================================================================== M2: ground/roof depend on the pose
test('M2: moving the sample front-wall corner 2 px leaves no dishonest High/Medium on any item', () => {
  for (const [corner, dx] of [[1, -2], [0, -2], [1, 2], [2, 2]]) {
    const p = freshSample();
    const front = p.planes.find((pl) => pl.id === 'pl_front');
    front.rect.corners[corner] = [front.rect.corners[corner][0] + dx, front.rect.corners[corner][1]];
    const { out } = sampleErrors(p);
    for (const id of Object.keys(out)) assertHonest('corner ' + corner + ' ' + dx + ' px: ' + id, out[id].m, out[id].err);
  }
});

test('M2: a ground point tapped above the horizon is rejected, not measured at 200 ft', () => {
  const p = freshSample();
  const walk = p.features.find((f) => f.id === 'ft_walk_left');
  walk.points[1] = [walk.points[1][0], 150]; // up on the wall, far above eye level
  const m = measure.measureProject(p).features.ft_walk_left;
  assert.equal(m.ok, false, 'measured ' + m.measuredFt);
  assert.match(m.reason, /horizon/);
});

test('M2: roof and ground planes do not inherit the wall\'s reference checks', () => {
  const r = measure.measureProject(S0.project);
  assert.ok(r.planes.pl_front.checks >= 1);
  assert.equal(r.planes.pl_yard.checks, 0);
  assert.equal(r.planes.pl_roof.checks, 0);
  assert.equal(r.planes.pl_yard.disagreementPct, null);
});

test('M2: a tape-measured ground reference re-fits the ground scale', () => {
  const p = freshSample();
  const front = p.planes.find((pl) => pl.id === 'pl_front');
  front.rect.corners[1] = [front.rect.corners[1][0] - 2, front.rect.corners[1][1]];
  const before = sampleErrors(p).out.ft_walk_left.err;
  const yard = p.planes.find((pl) => pl.id === 'pl_yard');
  const right = p.features.find((f) => f.id === 'ft_walk_right');
  yard.refs = [lineRef('ref_walk', right.points.map((q) => q.slice()), 15)];
  const { r, out } = sampleErrors(p);
  console.log(`  walkway left: ${(100 * before).toFixed(1)}% → ${(100 * out.ft_walk_left.err).toFixed(1)}% with a 15 ft ground reference`);
  assert.ok(Math.abs(before) > 0.05, 'precondition');
  assert.ok(Math.abs(out.ft_walk_left.err) < 0.03);
  assert.equal(r.planes.pl_yard.checks, 0, 'one ground reference sets the scale; it is not a check');
});

// ================================================================== M3: refs-only
test('M3: a wall with no rectangle and one reference is never High, even at 40° yaw', () => {
  const cam = makeCamera({ yawDeg: 40, dist: 60, target: [20, 6, 0] });
  const p = projectOf([image(cam)], [wallPlane(null, [lineRef('door', pts(cam, [[18, 0, 0], [18, DOOR_H, 0]]), DOOR_H, 'door-height')])],
    [feature('eave', 'roofline', pts(cam, [[0, 12, 0], [40, 12, 0]]))]);
  const m = measure.measureProject(p).features.eave;
  console.log(`  refs-only 40°: eave ${(100 * relErr(m.measuredFt, 40)).toFixed(1)}% → ${m.confidence.level}`);
  assert.equal(m.confidence.level, 'low');
});

test('M3: refs-only with agreeing horizontal and vertical references reaches Medium at most', () => {
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 0, dist: 60, height: 6, target: [20, 6, 0] });
  const refs = [lineRef('door', pts(cam, [[18, 0, 0], [18, DOOR_H, 0]]), DOOR_H), lineRef('h', pts(cam, [[2, 3, 0], [12, 3, 0]]), 10)];
  const p = projectOf([image(cam)], [wallPlane(null, refs)], [feature('eave', 'roofline', pts(cam, [[0, 12, 0], [40, 12, 0]]))]);
  assert.equal(measure.measureProject(p).features.eave.confidence.level, 'medium');
});

test('M3: a concave (mis-tapped) rectangle is not dropped quietly: Low with the rectangle problem first', () => {
  const cam = makeCamera({ yawDeg: 20, dist: 60, target: [20, 6, 0] });
  const q = pts(cam, [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]]);
  const c = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
  const concave = [q[0], q[1], [c[0] + 0.1 * (q[2][0] - c[0]), c[1] + 0.1 * (q[2][1] - c[1])], q[3]];
  const p = projectOf([image(cam)], [wallPlane({ corners: concave, widthFt: null, heightFt: null }, [lineRef('door', pts(cam, [[18, 0, 0], [18, DOOR_H, 0]]), DOOR_H, 'door-height')])],
    [feature('eave', 'roofline', pts(cam, [[0, 12, 0], [40, 12, 0]]))]);
  const m = measure.measureProject(p).features.eave;
  assert.equal(m.confidence.level, 'low');
  assert.match(m.confidence.reasons[0], /rectangle/i);
});

// ================================================================== M4: roof-ortho
test('M4: a roof on a wall without a perspective rectangle (roof-ortho) is Low', () => {
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 0, dist: 40, height: 5.5, target: [17, 6, 0] });
  const refs = [lineRef('door', pts(cam, [[15, 0, 0], [15, DOOR_H, 0]]), DOOR_H), lineRef('h', pts(cam, [[2, 3, 0], [12, 3, 0]]), 10)];
  const roof = { id: 'pl_r', imageId: 'img', name: 'Roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: pts(cam, [[0, 10, 0], [34, 10, 0]]), pitch: { rise: 6, run: 12 } } };
  const rake = feature('rake', 'rake', pts(cam, [[0, 10, 0], [0, 17, -14]]), 'pl_r');
  const r = measure.measureProject(projectOf([image(cam)], [wallPlane(null, refs), roof], [rake]));
  assert.equal(r.planes.pl_r.mode, 'roof-ortho');
  const m = r.features.rake;
  console.log(`  roof-ortho rake ${(100 * relErr(m.measuredFt, Math.hypot(14, 7))).toFixed(1)}% → ${m.confidence.level}`);
  assert.equal(m.confidence.level, 'low');
  assert.ok(m.confidence.reasons.some((s) => /Add a perspective rectangle on the wall to measure the roof/.test(s)));
});

// ================================================================== F1 / M6: rect-refs cross-checks
test('F1: on a wall whose rectangle size is unknown, two references are compared and a 15% error is flagged', () => {
  const p = freshSample();
  const front = p.planes.find((pl) => pl.id === 'pl_front');
  unknownSize(front);
  front.refs.find((r) => r.id === 'ref_window_width').lengthFt = 4.6;
  const { r, out } = sampleErrors(p);
  const sol = r.planes.pl_front;
  assert.equal(sol.scale.anisotropic, false);
  assert.equal(sol.checks, 1);
  assert.ok(sol.disagreementPct > 10, String(sol.disagreementPct));
  assert.ok(r.warnings.some((w) => w.code === 'ref-disagreement' && w.planeId === 'pl_front' && w.level === 'warn'));
  assert.ok(Math.abs(sol.refResults.find((x) => x.refId === 'ref_window_width').errorPct) > 3);
  assertHonest('eave', out.ft_eave.m, out.ft_eave.err);
  assert.notEqual(out.ft_eave.m.confidence.level, 'high');
});

// The sample now tapes its front wall (34 x 10 ft); these F1 checks need the size-unknown calibration with two refs.
function unknownSize(plane) {
  plane.rect.widthFt = null;
  plane.rect.heightFt = null;
  plane.rect.presetId = 'unknown';
  return plane;
}

test('F1: the sample front wall (two references) is not described as having no second reference', () => {
  const p = freshSample();
  unknownSize(p.planes.find((pl) => pl.id === 'pl_front'));
  const r = measure.measureProject(p);
  assert.equal(r.planes.pl_front.checks, 1);
  assert.ok(!r.features.ft_eave.confidence.reasons.some((s) => /no second reference/.test(s)), r.features.ft_eave.confidence.reasons.join(' | '));
});

test('M6: with an EXIF focal, door height + door width do not switch to a separate horizontal scale', () => {
  const cam = makeCamera({ yawDeg: 20, dist: 60, target: [20, 6, 0] });
  const rect = pts(cam, [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]]);
  const refs = [lineRef('dh', pts(cam, [[18, 0, 0], [18, DOOR_H, 0]]), DOOR_H, 'door-height'), lineRef('dw', pts(cam, [[18, DOOR_H, 0], [21, DOOR_H, 0]]), 3, 'door-width')];
  const r = measure.solvePlanes(projectOf([image(cam)], [wallPlane({ corners: rect, widthFt: null, heightFt: null }, refs)], []));
  const sol = r.planes.pl_w;
  assert.equal(sol.mode, 'rect-refs');
  assert.equal(sol.scale.anisotropic, false);
  assert.equal(sol.checks, 1, 'the second reference is a cross-check');
});

// ================================================================== M5 / F3: focal length
test('M5: a 2× lens with no EXIF (assumed phone 1×) cannot rate ground and roof lengths High or Medium', () => {
  const cam = makeCamera({ f35: 52, yawDeg: 10, dist: 100, target: [25, 6, 0] });
  const garage = pts(cam, [[30, 7, 0], [46, 7, 0], [46, 0, 0], [30, 0, 0]]);
  const ground = { id: 'pl_g', imageId: 'img', name: 'Yard', kind: 'ground', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: pts(cam, [[0, 0, 0], [50, 0, 0]]), pitch: null } };
  const roof = { id: 'pl_r', imageId: 'img', name: 'Roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: pts(cam, [[0, 12, 0], [50, 12, 0]]), pitch: { rise: 6, run: 12 } } };
  const p = projectOf([image(cam, { exif: null })], [wallPlane({ corners: garage, widthFt: 16, heightFt: 7, presetId: 'garage-double' }), ground, roof],
    [feature('walk', 'walkway', pts(cam, [[20, 0, 1], [20, 0, 16]]), 'pl_g'), feature('rake', 'rake', pts(cam, [[0, 12, 0], [0, 19, -14]]), 'pl_r')]);
  const r = measure.measureProject(p);
  assert.equal(r.cameras.img.source, 'default');
  assertHonest('walkway', r.features.walk, relErr(r.features.walk.measuredFt, 15));
  assertHonest('rake', r.features.rake, relErr(r.features.rake.measuredFt, Math.hypot(14, 7)));
  assert.equal(r.features.walk.confidence.level, 'low');
  assert.equal(r.features.rake.confidence.level, 'low');
});

test('M5: an EXIF focal on a cropped photo is not trusted and the reason is reported', () => {
  const p = freshSample();
  p.images[0].exif = { focal35: 26, width: 2 * p.images[0].width, height: 2 * p.images[0].height };
  const r = measure.measureProject(p);
  assert.equal(r.cameras.img_sample.source, 'rectangle');
  assert.ok(r.warnings.some((w) => w.code === 'exif-ignored'));
});

test('F3: the wide-screenshot lens preset (id "streetview") that disagrees with the rectangles is flagged and 3D lengths drop to Low', () => {
  const p = freshSample();
  p.images[0].camera = { mode: 'preset', presetId: 'streetview', focalPx: null };
  const { r, out } = sampleErrors(p);
  const w = r.warnings.find((x) => x.code === 'focal-mismatch');
  assert.ok(w, 'focal-mismatch warning');
  assert.equal(w.level, 'warn');
  assert.match(w.message, /lens setting/i);
  // SPEC §8.4: the preset is named for what it is, a wide screenshot, on screen and in this warning.
  assert.match(w.message, /The lens setting \(Screenshot \(wide view\)\)/);
  assert.ok(!/street\s*view/i.test(w.message), w.message);
  console.log(`  wide-screenshot preset: walkway ${(100 * out.ft_walk_left.err).toFixed(1)}% → ${out.ft_walk_left.m.confidence.level}`);
  assert.equal(out.ft_walk_left.m.confidence.level, 'low');
  for (const id of Object.keys(out)) assertHonest(id, out[id].m, out[id].err);
});

// ================================================================== M7: off-plane items
test('M7: a tree or ridge traced on a wall plane is Low; a bush on a wall is at most Medium', () => {
  const cam = makeCamera({ yawDeg: 15, dist: 60, target: [17, 6, 0] });
  const rect = pts(cam, [[0, 10, 0], [34, 10, 0], [34, 0, 0], [0, 0, 0]]);
  const p = projectOf([image(cam)], [wallPlane({ corners: rect, widthFt: 34, heightFt: 10 })], [
    feature('ridge', 'ridge', pts(cam, [[0, 17, -14], [34, 17, -14]])),
    feature('tree', 'tree', pts(cam, [[-6, 0, 15], [-6, 7, 15]]), 'pl_w', { diameterIn: 10 }),
    feature('bush', 'bush', pts(cam, [[3, 0, 3], [7, 0, 3], [7, 3, 3], [3, 3, 3]])),
  ]);
  const f = measure.measureProject(p).features;
  assert.equal(f.ridge.confidence.level, 'low');
  assert.equal(f.tree.confidence.level, 'low');
  assert.notEqual(f.bush.confidence.level, 'high');
  assert.ok(f.tree.confidence.reasons.some((s) => /ground plane/i.test(s)), f.tree.confidence.reasons.join(' | '));
});

// ================================================================== M8: per-roof pitch
test('M8: a steep entry gable that is not on the main eave does not set a Medium-rated main-roof pitch', () => {
  const cam = makeCamera({ yawDeg: 15, dist: 60, target: [20, 8, 0] });
  const rect = pts(cam, [[0, 18, 0], [40, 18, 0], [40, 0, 0], [0, 0, 0]]);
  const roof = { id: 'pl_r', imageId: 'img', name: 'Main roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: pts(cam, [[0, 18, 0], [40, 18, 0]]), pitch: null } };
  // Porch gable 12/12 with its base at 9 ft (below the 18 ft main eave); the main roof is really 5/12.
  const p = projectOf([image(cam)], [wallPlane({ corners: rect, widthFt: 40, heightFt: 18 }), roof], [
    feature('gable', 'rake', pts(cam, [[14, 9, 0], [18, 13, 0], [22, 9, 0]])),
    feature('rake', 'rake', pts(cam, [[0, 18, 0], [0, 18 + 14 * 5 / 12, -14]]), 'pl_r'),
  ]);
  const r = measure.measureProject(p);
  const m = r.features.rake;
  console.log(`  main-roof rake with borrowed 12/12: ${(100 * relErr(m.measuredFt, Math.hypot(14, 14 * 5 / 12))).toFixed(1)}% → ${m.confidence.level}`);
  assert.equal(r.planes.pl_r.pitch.source, 'estimated');
  assert.equal(m.confidence.level, 'low');
  assert.ok(m.confidence.reasons.some((s) => /pitch/i.test(s)));
});

test('M8: rakes on the eave line that disagree by more than 2/12 raise a warning', () => {
  const cam = makeCamera({ yawDeg: 15, dist: 60, target: [20, 8, 0] });
  const rect = pts(cam, [[0, 10, 0], [40, 10, 0], [40, 0, 0], [0, 0, 0]]);
  const roof = { id: 'pl_r', imageId: 'img', name: 'Main roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: pts(cam, [[0, 10, 0], [40, 10, 0]]), pitch: null } };
  const p = projectOf([image(cam)], [wallPlane({ corners: rect, widthFt: 40, heightFt: 10 }), roof], [
    feature('g1', 'rake', pts(cam, [[4, 10, 0], [10, 16, 0], [16, 10, 0]])), // 12/12
    feature('g2', 'rake', pts(cam, [[24, 10, 0], [30, 12.5, 0], [36, 10, 0]])), // 5/12
    feature('ridge', 'ridge', pts(cam, [[0, 15.8, -14], [40, 15.8, -14]]), 'pl_r'),
  ]);
  const r = measure.measureProject(p);
  assert.ok(r.warnings.some((w) => w.code === 'pitch-spread'));
  assert.equal(r.features.ridge.confidence.level, 'low');
});

// ================================================================== M9 / M10: single and short references
test('M9: one unverified reference on a recessed door does not give High', () => {
  const cam = makeCamera({ yawDeg: 20, dist: 60, target: [20, 6, 0] });
  const rect = pts(cam, [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]]);
  const door = lineRef('door', pts(cam, [[18, 0, -4], [18, DOOR_H, -4]]), DOOR_H, 'door-height');
  const p = projectOf([image(cam)], [wallPlane({ corners: rect, widthFt: null, heightFt: null }, [door])], [feature('eave', 'roofline', pts(cam, [[0, 12, 0], [40, 12, 0]]))]);
  const m = measure.measureProject(p).features.eave;
  console.log(`  recessed door ref: eave ${(100 * relErr(m.measuredFt, 40)).toFixed(1)}% → ${m.confidence.level}`);
  assert.notEqual(m.confidence.level, 'high');
  assert.ok(m.confidence.reasons.some((s) => /second reference/i.test(s)));
});

test('M10: adding a correctly sized but short check reference never lowers the level', () => {
  const cam = makeCamera({ yawDeg: 12, dist: 70, target: [20, 6, 0] });
  const facade = pts(cam, [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]]);
  const eave = feature('eave', 'roofline', pts(cam, [[0, 12, 0], [40, 12, 0]]));
  const rect = { corners: facade, widthFt: 40, heightFt: 12, presetId: 'custom-rect' };
  const without = measure.measureProject(projectOf([image(cam)], [wallPlane(rect)], [eave])).features.eave.confidence;
  // A door-height reference tapped 3 px short at each end (normal tap noise on a ~100 px span).
  const d = pts(cam, [[20, 0, 0], [20, DOOR_H, 0]]);
  const dir = [(d[1][0] - d[0][0]), (d[1][1] - d[0][1])], L = Math.hypot(dir[0], dir[1]);
  const shortRef = lineRef('door', [[d[0][0] + 3 * dir[0] / L, d[0][1] + 3 * dir[1] / L], [d[1][0] - 3 * dir[0] / L, d[1][1] - 3 * dir[1] / L]], DOOR_H, 'door-height');
  const r = measure.measureProject(projectOf([image(cam)], [wallPlane(rect, [shortRef])], [eave]));
  const withRef = r.features.eave.confidence;
  console.log(`  without ref ${without.level} ${without.score}, with short ref ${withRef.level} ${withRef.score} (disagreement ${r.planes.pl_w.disagreementPct.toFixed(1)}%)`);
  assert.equal(without.level, 'high', 'precondition: the eave is High without the reference');
  assert.ok(r.planes.pl_w.disagreementPct > 3, 'precondition: the short reference reads several % off');
  assert.ok(RANK[withRef.level] >= RANK[without.level]);
  assert.ok(withRef.score >= without.score);
});

// ================================================================== F7: assumed trunk diameter
test('F7: a tree wrapped with the assumed 10 in trunk diameter is flagged and not High', () => {
  const p = freshSample();
  p.features.find((f) => f.id === 'ft_tree').params.diameterIn = null;
  const m = measure.measureProject(p).features.ft_tree;
  assert.ok(m.confidence.reasons.some((s) => /Trunk diameter assumed \(10 in\)/.test(s)), m.confidence.reasons.join(' | '));
  assert.notEqual(m.confidence.level, 'high');
});

// ================================================================== UI routing of the new lens warnings
test('F3: lens warnings are routed to step 1 (Upload → Lens), where the "Use N px" fix lives', () => {
  const path = require('path');
  for (const f of ['persist', 'store', 'imagesource', 'actions', 'panels']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));
  const panels = LP.require('ui.panels');
  assert.equal(panels.warningStep({ code: 'focal-mismatch', imageId: 'img' }), 1);
  assert.equal(panels.warningStep({ code: 'exif-ignored', imageId: 'img' }), 1);
  assert.equal(panels.warningStep({ code: 'pitch-spread', planeId: 'pl_r' }), 2);
});

// ================================================================== UX-01 / UX-02 (SPEC §8.4): taps placed zoomed out
// The app stores how coarse each tap was (`tapErr`, stored-image px, one value per point) beside the rectangle
// corners, the reference ends, the eave / base line and an item's points. measure rates a plane by the coarsest of
// its calibration taps and an item by its coarsest point, never finer than the 2.5 px it always assumed.
const ZOOM_WHY = (px, what) => 'Tapped zoomed out (about ±' + px + ' px on the photo): zoom in and re-tap ' + what + '.';

/** A 40 x 12 ft front (tape-measured corners, door height as a check), its roof and yard, and one item on each. */
function tapHouse() {
  const cam = makeCamera({ yawDeg: 12, dist: 55, target: [20, 6, 0] });
  const wall = wallPlane({ corners: pts(cam, [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]]), widthFt: 40, heightFt: 12, presetId: 'custom-rect' },
    [lineRef('door', pts(cam, [[18, 0, 0], [18, DOOR_H, 0]]), DOOR_H, 'door-height')]);
  const roof = { id: 'pl_r', imageId: 'img', name: 'Roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: pts(cam, [[0, 12, 0], [40, 12, 0]]), pitch: { rise: 6, run: 12 } } };
  const yard = { id: 'pl_g', imageId: 'img', name: 'Yard', kind: 'ground', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: pts(cam, [[0, 0, 0], [40, 0, 0]]), pitch: null } };
  return projectOf([image(cam)], [wall, roof, yard], [
    feature('eave', 'roofline', pts(cam, [[0, 12, 0], [40, 12, 0]])),
    feature('window', 'window', pts(cam, [[5, 4, 0], [10, 4, 0], [10, 8, 0], [5, 8, 0]])),
    feature('rake', 'rake', pts(cam, [[40, 12, 0], [40, 18, -12]]), 'pl_r'),
    feature('walk', 'walkway', pts(cam, [[18, 0, 2], [14, 0, 22]]), 'pl_g'),
  ]);
}
/** tapHouse() with `change(project)` applied, measured. */
function tapMeasured(change) {
  const p = tapHouse();
  if (change) change(p);
  return measure.measureProject(p);
}
/** Every tapped point list of a project with the object that holds its tapErr: [holder, points]. */
function tapLists(p) {
  const out = [];
  for (const pl of p.planes) {
    if (pl.rect) out.push([pl.rect, pl.rect.corners]);
    for (const r of pl.refs) out.push([r, r.points]);
    if (pl.derived) out.push([pl.derived, pl.derived.line]);
  }
  for (const f of p.features) out.push([f, f.points]);
  return out;
}

test('UX-02: a tapErr that is missing, malformed, the wrong length or no coarser than 2.5 px changes nothing', () => {
  const base = tapMeasured();
  assert.deepEqual(Object.keys(base.planes).map((id) => base.planes[id].tapSigmaPx), [2.5, 2.5, 2.5]);
  // One value for every list, whatever its length: not an array, or an array of the wrong length.
  const junk = [null, 'coarse', 16, true, { 0: 16, 1: 16, length: 2 }, [], [16], [16, 16, 16], [16, 16, 16, 16, 16]];
  // Built for the list's own length: right length, but one entry is not a finite number.
  const almost = [NaN, Infinity, -Infinity, '16', null, undefined, [16]].map((bad) => (n) => { const a = new Array(n).fill(16); a[n - 1] = bad; return a; });
  // Numbers that say nothing (zero or below): no information either.
  const empty = [(n) => new Array(n).fill(0), (n) => new Array(n).fill(-40)];
  const variants = junk.map((j) => () => j).concat(almost, empty);
  variants.forEach((make, i) => {
    // On every list at once ...
    const all = tapMeasured((p) => { for (const [holder, points] of tapLists(p)) holder.tapErr = make(points.length); });
    assert.deepEqual(all, base, 'variant ' + i + ' on every list');
  });
  // Valid, and no coarser than what measure already assumes (the app stores 2.5 for a point tapped zoomed in):
  // every number is unchanged. The only difference is the advice: a point known to have been tapped zoomed in
  // is not told to "zoom in" (review finding U14), and each surface says its taps were recorded.
  const ZOOMED_IN = 'use a larger rectangle (the points were already tapped zoomed in, so zooming in further will not help).';
  const plain = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'tapsRecorded' ? undefined : typeof v === 'string' ? v.split(ZOOMED_IN).join('zoom in or use a larger rectangle.') : v)));
  const fine = [(n) => new Array(n).fill(2.5), (n) => new Array(n).fill(1).map((v, i) => 2.5 - i / 10)];
  fine.forEach((make, i) => {
    const all = tapMeasured((p) => { for (const [holder, points] of tapLists(p)) holder.tapErr = make(points.length); });
    assert.deepEqual(plain(all), plain(base), 'fine variant ' + i + ': the same numbers');
    assert.ok(Object.keys(all.planes).every((id) => all.planes[id].tapsRecorded === true) && Object.keys(base.planes).every((id) => base.planes[id].tapsRecorded === false));
    assert.ok(JSON.stringify(all).includes(ZOOMED_IN) && !JSON.stringify(base).includes(ZOOMED_IN), 'only the advice differs');
    assert.ok(!/zoom in or use a larger rectangle/.test(JSON.stringify(all)));
  });
  // ... and one list at a time, with the kind of value most likely to slip through (wrong length).
  const count = tapLists(tapHouse()).length;
  for (let k = 0; k < count; k++) {
    const one = tapMeasured((p) => { const [holder, points] = tapLists(p)[k]; holder.tapErr = new Array(points.length + 1).fill(16); });
    assert.deepEqual(one, base, 'wrong length on list ' + k);
  }
  // The sample house stores no tapErr at all: its planes all read 2.5 px.
  const sampleRes = measure.measureProject(freshSample());
  for (const id of Object.keys(sampleRes.planes)) assert.equal(sampleRes.planes[id].tapSigmaPx, 2.5, id);
});

test('UX-02: a plane is rated by its coarsest calibration tap (rectangle, references, eave or base line), an item by its coarsest point', () => {
  const base = tapMeasured();
  const sigmas = (r) => [r.planes.pl_w.tapSigmaPx, r.planes.pl_r.tapSigmaPx, r.planes.pl_g.tapSigmaPx];
  // Rectangle corners: the largest of the four counts, and gives exactly what four equally coarse corners give.
  const rectMixed = tapMeasured((p) => { p.planes[0].rect.tapErr = [3, 16, 5, 4]; });
  assert.deepEqual(sigmas(rectMixed), [16, 2.5, 2.5], 'only the wall owns those taps');
  assert.deepEqual(rectMixed, tapMeasured((p) => { p.planes[0].rect.tapErr = [16, 16, 16, 16]; }));
  // A reference on the wall counts for the wall, even next to a carefully tapped rectangle.
  const ref = tapMeasured((p) => { p.planes[0].rect.tapErr = [2.5, 2.5, 3, 2.5]; p.planes[0].refs[0].tapErr = [7, 20]; });
  assert.deepEqual(sigmas(ref), [20, 2.5, 2.5]);
  // The eave line belongs to the roof, the base line to the yard.
  assert.deepEqual(sigmas(tapMeasured((p) => { p.planes[1].derived.tapErr = [9, 4]; })), [2.5, 9, 2.5]);
  assert.deepEqual(sigmas(tapMeasured((p) => { p.planes[2].derived.tapErr = [4, 11]; })), [2.5, 2.5, 11]);
  // The largest of all of them, where a plane has several.
  assert.deepEqual(sigmas(tapMeasured((p) => { p.planes[0].rect.tapErr = [6, 6, 6, 6]; p.planes[0].refs[0].tapErr = [5, 5]; })), [6, 2.5, 2.5]);

  // Every item on the wall, and on the roof and yard worked out from it, gets a larger expected error.
  for (const id of ['eave', 'window', 'rake', 'walk']) {
    assert.ok(rectMixed.features[id].uncertaintyPct > 3 * base.features[id].uncertaintyPct, id + ': ' + base.features[id].uncertaintyPct + ' → ' + rectMixed.features[id].uncertaintyPct);
    assert.equal(rectMixed.features[id].measuredFt, base.features[id].measuredFt, 'the length itself does not move');
  }
  console.log(`  rectangle tapped to ±16 px: eave ±${base.features.eave.uncertaintyPct.toFixed(1)}% → ±${rectMixed.features.eave.uncertaintyPct.toFixed(1)}% (${base.features.eave.confidence.level} → ${rectMixed.features.eave.confidence.level}), window ±${base.features.window.uncertaintyPct.toFixed(1)}% → ±${rectMixed.features.window.uncertaintyPct.toFixed(1)}% (${base.features.window.confidence.level} → ${rectMixed.features.window.confidence.level})`);
  assert.equal(base.features.eave.confidence.level, 'high', 'precondition: tapped carefully the eave is High');
  assert.equal(rectMixed.features.eave.confidence.level, 'medium', 'the level follows the expected error');
  assert.equal(rectMixed.features.window.confidence.level, 'low');
  assert.equal(rectMixed.planes.pl_w.confidence.level, 'medium', 'the wall pill follows too');

  // An item's own points: only that item changes, and its largest value is the one that counts.
  const item = tapMeasured((p) => { p.features[1].tapErr = [2.5, 13, 2.5, 2.5]; });
  assert.deepEqual(item.planes, base.planes);
  for (const id of ['eave', 'rake', 'walk']) assert.deepEqual(item.features[id], base.features[id], id + ' is untouched');
  assert.ok(item.features.window.uncertaintyPct > 3 * base.features.window.uncertaintyPct);
  assert.deepEqual(item, tapMeasured((p) => { p.features[1].tapErr = [13, 13, 13, 13]; }));
  assert.equal(item.features.window.confidence.level, 'low');
});

test('UX-02: when taps placed zoomed out are what limits a rating, the reason says so and names what to re-tap', () => {
  // The rectangle: every item that depends on it says to re-tap its corners.
  const rect = tapMeasured((p) => { p.planes[0].rect.tapErr = [16, 16, 16, 16]; });
  assert.equal(rect.features.eave.confidence.reasons[0], ZOOM_WHY(16, 'the corners of the rectangle') + ' Expected error about ±' + rect.features.eave.uncertaintyPct.toFixed(1) + '% as tapped.');
  assert.equal(rect.features.window.confidence.reasons[0], ZOOM_WHY(16, 'the corners of the rectangle') + ' Expected error about ±' + Math.round(rect.features.window.uncertaintyPct) + '% as tapped.');
  assert.equal(rect.planes.pl_w.confidence.reasons[0], ZOOM_WHY(16, 'the corners of the rectangle') + ' Expected error about ±' + rect.planes.pl_w.uncertaintyPct.toFixed(1) + '% as tapped.');
  // Roof and ground lengths are worked out from the wall, so its coarse corners are their problem too; an expected
  // error past ±50% is put in words, not in a number nobody can use.
  for (const id of ['rake', 'walk']) {
    assert.ok(rect.features[id].uncertaintyPct > 50, id);
    assert.equal(rect.features[id].confidence.reasons[0], ZOOM_WHY(16, 'the corners of the rectangle') + ' As tapped, this measurement could be off by more than half.');
    assert.equal(rect.features[id].confidence.level, 'low');
  }
  for (const id of ['pl_r', 'pl_g']) assert.ok(rect.planes[id].confidence.reasons[0].startsWith(ZOOM_WHY(16, 'the corners of the rectangle')), id);
  // The "rough measurement" warning carries the same advice.
  const warn = rect.warnings.find((w) => w.code === 'low-confidence' && w.featureId === 'window');
  assert.ok(warn && warn.message.includes('zoom in and re-tap the corners of the rectangle'), warn && warn.message);

  // A reference length that sets the scale.
  const ref = tapMeasured((p) => { Object.assign(p.planes[0].rect, { widthFt: null, heightFt: null, presetId: 'unknown' }); p.planes[0].refs[0].tapErr = [14, 14]; });
  assert.equal(ref.planes.pl_w.mode, 'rect-refs');
  assert.ok(ref.features.eave.confidence.reasons[0].startsWith(ZOOM_WHY(14, 'the two ends of the reference length')), ref.features.eave.confidence.reasons[0]);
  assert.equal(ref.features.eave.confidence.level, 'low');

  // The item's own points.
  const item = tapMeasured((p) => { p.features[0].tapErr = [13, 13]; p.features[1].tapErr = [13, 13, 13, 13]; });
  assert.equal(item.features.eave.confidence.reasons[0], ZOOM_WHY(13, 'the points of this item') + ' Expected error about ±' + item.features.eave.uncertaintyPct.toFixed(1) + '% as tapped.');
  assert.equal(item.features.eave.confidence.level, 'medium', 'a long eave tapped zoomed out drops from High to Medium');
  assert.ok(item.features.window.confidence.reasons[0].startsWith(ZOOM_WHY(13, 'the points of this item')));
  assert.equal(item.features.window.confidence.level, 'low');
  // The reason is first in the list, where the panel and the warnings read it from.
  for (const r of [rect, ref, item]) {
    for (const id of Object.keys(r.features)) {
      const c = r.features[id].confidence;
      const k = c.reasons.findIndex((s) => /^Tapped zoomed out/.test(s));
      assert.ok(k <= 0, id + ': ' + c.reasons.join(' | '));
    }
  }
});

test('UX-02: when coarse taps are not what limits a rating, the advice for that surface stays', () => {
  const base = tapMeasured();
  const roofWhy = /^Expected error about ±\d+% from how exactly the points could be tapped; roof lengths depend on the camera angle worked out from the wall\./;
  const groundWhy = /^Expected error about ±\d+% from how exactly the points could be tapped; from street level the ground is seen almost edge-on\./;
  assert.match(base.features.rake.confidence.reasons[0], roofWhy);
  assert.match(base.features.walk.confidence.reasons[0], groundWhy);
  // A coarsely tapped eave line barely moves a roof length (the camera angle from the wall is what matters).
  const eaveLine = tapMeasured((p) => { p.planes[1].derived.tapErr = [15, 15]; });
  assert.equal(eaveLine.planes.pl_r.tapSigmaPx, 15);
  assert.ok(eaveLine.features.rake.uncertaintyPct >= base.features.rake.uncertaintyPct);
  assert.match(eaveLine.features.rake.confidence.reasons[0], roofWhy);
  assert.match(eaveLine.planes.pl_r.confidence.reasons[0], roofWhy);
  // Slightly coarse points on an item that is rough for another reason.
  const walk = tapMeasured((p) => { p.features[3].tapErr = [4, 4]; });
  assert.ok(walk.features.walk.uncertaintyPct > base.features.walk.uncertaintyPct);
  assert.match(walk.features.walk.confidence.reasons[0], groundWhy);
  const rake = tapMeasured((p) => { p.features[2].tapErr = [4, 4]; });
  assert.match(rake.features.rake.confidence.reasons[0], roofWhy);
  // Coarse taps that leave the expected error under the High limit need no reason at all.
  const mild = tapMeasured((p) => { p.planes[0].rect.tapErr = [6, 6, 6, 6]; });
  assert.equal(mild.features.eave.confidence.level, 'high');
  assert.ok(!mild.features.eave.confidence.reasons.some((s) => /zoomed out/.test(s)), mild.features.eave.confidence.reasons.join(' | '));
  // No tapErr anywhere: nobody is told they tapped zoomed out.
  for (const r of [base, measure.measureProject(freshSample())]) {
    for (const id of Object.keys(r.features)) assert.ok(!r.features[id].confidence.reasons.some((s) => /zoomed out/.test(s)), id);
    for (const id of Object.keys(r.planes)) assert.ok(!(r.planes[id].confidence && r.planes[id].confidence.reasons.some((s) => /zoomed out/.test(s))), id);
  }
});

test('UX-01: the reviewer\'s journey, a garage-door rectangle tapped 16 px off at fit zoom, is Low and says to zoom in', () => {
  // A 52 ft ranch photographed straight on (2048 px wide stored photo). The 16 x 7 ft garage door is about
  // 400 x 175 px. On a 390 px phone at fit zoom one screen px is 5.3 photo px, so a 3 px slip of the finger is 16.
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 3, dist: 62, height: 5, target: [26, 5, 0] });
  const door = pts(cam, [[32, 7, 0], [48, 7, 0], [48, 0, 0], [32, 0, 0]]); // TL, TR, BR, BL
  const wPx = Math.hypot(door[1][0] - door[0][0], door[1][1] - door[0][1]), hPx = Math.hypot(door[3][0] - door[0][0], door[3][1] - door[0][1]);
  assert.ok(wPx > 380 && wPx < 420 && hPx > 160 && hPx < 190, 'the door is about 400 x 170 px: ' + wPx.toFixed(0) + ' x ' + hPx.toFixed(0));
  // The two right-hand corners land 16 px inside the door: it now looks as if it were seen from the side.
  const slip = [[0, 0], [0, 16], [0, -16], [0, 0]];
  const corners = door.map((c, i) => [c[0] + slip[i][0], c[1] + slip[i][1]]);
  const eave = pts(cam, [[0, 9, 0], [52, 9, 0]]);
  const run = (tapErr) => {
    const rect = { corners, widthFt: 16, heightFt: 7, presetId: 'garage-double' };
    const f = feature('eave', 'roofline', eave);
    if (tapErr) { rect.tapErr = [tapErr, tapErr, tapErr, tapErr]; f.tapErr = [tapErr, tapErr]; }
    return measure.measureProject(projectOf([image(cam)], [wallPlane(rect)], [f]));
  };
  // What the review found, reproduced: with nothing known about the taps the eave comes out a fifth short, Medium.
  const blind = run(null);
  const blindErr = relErr(blind.features.eave.measuredFt, 52);
  console.log(`  no tap precision stored: eave ${blind.features.eave.measuredFt.toFixed(1)} ft vs 52 (${(100 * blindErr).toFixed(1)}%), ${blind.features.eave.confidence.level}; wall ${blind.planes.pl_w.confidence.level}, "${Math.round(blind.planes.pl_w.viewAngleDeg)}° off straight-on"`);
  assert.ok(blindErr < -0.2, 'precondition: the slip makes the eave more than 20% short');
  assert.equal(blind.features.eave.confidence.level, 'medium', 'precondition: this is the dishonest Medium of UX-01');
  // With the taps recorded as the app records them, the same numbers are rated for what they are.
  const r = run(16);
  const m = r.features.eave, wallConf = r.planes.pl_w.confidence;
  console.log(`  tapErr 16 px: eave ${m.confidence.level} (${m.confidence.reasons[0]}); wall ${wallConf.level}`);
  assert.equal(m.measuredFt, blind.features.eave.measuredFt, 'the length is the same; only its rating changes');
  assert.equal(r.planes.pl_w.tapSigmaPx, 16);
  assert.equal(m.confidence.level, 'low');
  assert.ok(m.confidence.score < 50);
  assert.ok(m.confidence.reasons[0].startsWith(ZOOM_WHY(16, 'the corners of the rectangle')), m.confidence.reasons[0]);
  assertHonest('eave', m, blindErr);
  // The wall's own pill (shown as soon as the 4 corners are placed) was "Medium, 70/100" in the review.
  assert.equal(wallConf.level, 'low');
  assert.ok(wallConf.reasons[0].startsWith(ZOOM_WHY(16, 'the corners of the rectangle')), wallConf.reasons[0]);
  // Zoomed in and re-tapped (corners within 2.5 px, recorded as such) the eave is right again and no longer blamed on zoom.
  const good = measure.measureProject(projectOf([image(cam)], [wallPlane({ corners: door, widthFt: 16, heightFt: 7, presetId: 'garage-double', tapErr: [2.5, 2.5, 2.5, 2.5] })],
    [Object.assign(feature('eave', 'roofline', eave), { tapErr: [2.5, 2.5] })]));
  assert.ok(Math.abs(relErr(good.features.eave.measuredFt, 52)) < 1e-6);
  assert.ok(!good.features.eave.confidence.reasons.some((s) => /zoomed out/.test(s)));
});
