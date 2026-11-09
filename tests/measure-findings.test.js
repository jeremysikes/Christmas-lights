// Regression tests for the measurement-honesty review findings (M1–M10, F1, F3, F7). Each test reproduces the
// reviewer's scenario and pins the corrected behaviour: a measurement that can be badly off must not be shown at
// a confidence level that promises more than it delivers.
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
  assert.ok(m.confidence.reasons.some((s) => /Expected error about ±\d+(\.\d)?% from tap precision/.test(s)), m.confidence.reasons.join(' | '));
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

test('F1: the sample front wall (two references) is not described as having no second reference', () => {
  const r = measure.measureProject(S0.project);
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

test('F3: a Street View preset that disagrees with the rectangles is flagged and 3D lengths drop to Low', () => {
  const p = freshSample();
  p.images[0].camera = { mode: 'preset', presetId: 'streetview', focalPx: null };
  const { r, out } = sampleErrors(p);
  const w = r.warnings.find((x) => x.code === 'focal-mismatch');
  assert.ok(w, 'focal-mismatch warning');
  assert.equal(w.level, 'warn');
  assert.match(w.message, /lens setting/i);
  console.log(`  streetview preset: walkway ${(100 * out.ft_walk_left.err).toFixed(1)}% → ${out.ft_walk_left.m.confidence.level}`);
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
