const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
const camera = LP.require('camera');
const g = LP.require('geometry');

// ------------------------------------------------------------------ independent pinhole camera (test-only)
// Wall frame: u right, v up, w toward the street. The camera looks at `target` from `dist` ft away (horizontal
// distance), turned `yawDeg` off the wall normal and tilted `tiltDeg` up, with its center `height` ft above the base.
const W = 1600, H = 1200;
const F26 = (26 * Math.hypot(W, H)) / 43.2666;
function makeCamera({ yawDeg = 20, tiltDeg = 8, dist = 60, height = 5.5, target = [20, 0, 0], f = F26 } = {}) {
  const y = (yawDeg * Math.PI) / 180, t = (tiltDeg * Math.PI) / 180;
  const fwd = [Math.sin(y) * Math.cos(t), Math.sin(t), -Math.cos(y) * Math.cos(t)];
  const C = [target[0] - dist * Math.sin(y), height, target[2] + dist * Math.cos(y)];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((v) => v / l); };
  const right = norm(cross(fwd, [0, 1, 0]));
  const down = cross(fwd, right);
  return { C, rows: [right, down, fwd], f };
}
function project(cam, X) {
  const p = [X[0] - cam.C[0], X[1] - cam.C[1], X[2] - cam.C[2]];
  const [xc, yc, zc] = cam.rows.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]);
  return [(cam.f * xc) / zc + W / 2, (cam.f * yc) / zc + H / 2];
}
const relErr = (a, b) => Math.abs(a - b) / Math.abs(b);
const WALL = [[0, 12, 0], [40, 12, 0], [40, 0, 0], [0, 0, 0]]; // TL, TR, BR, BL of a 40 x 12 ft wall

test('focal length helpers and presets', () => {
  assert.ok(Math.abs(camera.focalFromF35(26, W, H) - F26) < 1e-9);
  assert.ok(Math.abs(camera.focalFromHfov(90, 1600) - 800) < 1e-9);
  assert.ok(Math.abs(camera.focalFromPreset('streetview', 1600, 1200) - 800) < 1e-9);
  assert.ok(Math.abs(camera.focalFromPreset('phone2x', W, H) - 2 * F26) < 1e-9);
  assert.ok(Math.abs(camera.focalFromPreset('nope', W, H) - F26) < 1e-9, 'unknown preset falls back to phone 1x');
  assert.equal(camera.focalFromF35(0, W, H), null);
  assert.equal(camera.CAMERA_PRESETS.length, 6);
});

test('8.4 the 90° lens preset keeps its id and is called "Screenshot (wide view)"; no lens label names Street View', () => {
  assert.deepEqual(camera.CAMERA_PRESETS.map((p) => p.id), ['phone1x', 'phone2x', 'phone3x', 'phone05x', 'streetview', 'camera50']);
  const wide = camera.getPreset('streetview');
  assert.ok(wide, 'a project saved with presetId "streetview" still finds its preset');
  assert.equal(wide.label, 'Screenshot (wide view)');
  assert.equal(wide.hfovDeg, 90);
  for (const p of camera.CAMERA_PRESETS) assert.ok(!/street\s*view/i.test(p.label), p.id + ': ' + p.label);
  // The label is what the lens line on screen and the lens-mismatch warning show.
  const r = camera.resolveCamera({ id: 'img', width: 1600, height: 1200, exif: null, camera: { mode: 'preset', presetId: 'streetview' } }, []);
  assert.equal(r.source, 'preset');
  assert.equal(r.label, 'Screenshot (wide view)');
  assert.ok(Math.abs(r.f - 800) < 1e-9, 'same focal length as before: 90° across a 1600 px photo');
});

test('estimateFocalFromQuad recovers f within 1% and is deterministic', () => {
  const cam = makeCamera();
  const quad = WALL.map((X) => project(cam, X));
  const r = camera.estimateFocalFromQuad(quad, W / 2, H / 2);
  assert.ok(r.ok, r.reason);
  const err = relErr(r.f, F26);
  console.log(`  focal from rectangle: ${r.f.toFixed(2)} px vs ${F26.toFixed(2)} (error ${(err * 100).toFixed(4)}%), relStd ${r.relStd.toFixed(4)}`);
  assert.ok(err < 0.01);
  assert.ok(r.relStd <= 0.15);
  // tap order does not matter; repeated calls give identical results
  const shuffled = [quad[2], quad[0], quad[3], quad[1]];
  const r2 = camera.estimateFocalFromQuad(shuffled, W / 2, H / 2);
  assert.equal(r2.f, r.f);
  assert.equal(r2.relStd, r.relStd);
});

test('estimateFocalFromQuad refuses a fronto-parallel photo (zero yaw and tilt)', () => {
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 0, height: 6 });
  const quad = WALL.map((X) => project(cam, X));
  const r = camera.estimateFocalFromQuad(quad, W / 2, H / 2);
  assert.equal(r.ok, false);
  assert.equal(r.f, null);
  assert.match(r.reason, /straight-on/);
  // and garbage
  assert.equal(camera.estimateFocalFromQuad([[0, 0], [1, 1]], 800, 600).ok, false);
  assert.equal(camera.estimateFocalFromQuad(null, 800, 600).ok, false);
  assert.equal(camera.estimateFocalFromQuad([[0, 0], [NaN, 1], [2, 2], [3, 0]], 800, 600).ok, false);
});

test('rectAspectFromQuad gives the true width/height ratio', () => {
  const cam = makeCamera();
  const quad = WALL.map((X) => project(cam, X));
  const a = camera.rectAspectFromQuad(quad, { f: F26, cx: W / 2, cy: H / 2 });
  assert.ok(relErr(a, 40 / 12) < 1e-6);
});

test('poseFromHomography recovers the camera center within 1%', () => {
  const cam = makeCamera();
  const quad = WALL.map((X) => project(cam, X));
  const Hp2i = g.homographyFromPoints([[0, 12], [40, 12], [40, 0], [0, 0]], quad);
  const K = { f: F26, cx: W / 2, cy: H / 2 };
  const pose = camera.poseFromHomography(Hp2i, K);
  assert.ok(pose.ok);
  const d = Math.hypot(pose.C[0] - cam.C[0], pose.C[1] - cam.C[1], pose.C[2] - cam.C[2]);
  const err = d / Math.hypot(...cam.C);
  console.log(`  camera center: [${pose.C.map((v) => v.toFixed(3))}] vs [${cam.C.map((v) => v.toFixed(3))}] (error ${(err * 100).toFixed(5)}%)`);
  assert.ok(err < 0.01);
  assert.ok(pose.C[2] > 0, 'camera is in front of the wall');
  assert.ok(Math.abs(pose.consistency.normRatio - 1) < 1e-6);
  // R is a rotation
  const Rt = g.m3transpose(pose.R);
  const I = g.m3mul(Rt, pose.R);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => assert.ok(Math.abs(I[i] - v) < 1e-9));
  assert.ok(Math.abs(g.m3det(pose.R) - 1) < 1e-9);
  // a negated homography gives the same pose
  const pose2 = camera.poseFromHomography(Hp2i.map((v) => -v), K);
  pose2.C.forEach((v, i) => assert.ok(Math.abs(v - pose.C[i]) < 1e-9));
  // projectPoint agrees with the independent projection; view angle is ~20 degrees at the wall center
  for (const X of [[5, 3, 0], [30, 20, -6], [12, 0, 15]]) {
    const p = camera.projectPoint(X, K, pose), q = project(cam, X);
    assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6);
  }
  const va = camera.viewAngleDeg(pose, [20, 6, 0]);
  assert.ok(va > 15 && va < 25, 'view angle ' + va);
  // a ray through a pixel passes through the 3D point
  const X = [33, 7, 0];
  const ray = camera.rayThroughPixel(project(cam, X), K, pose);
  const toX = g.v3sub(X, ray.origin);
  const perp = g.v3len(g.v3cross(toX, ray.dir)); // distance from X to the ray
  assert.ok(perp < 1e-6);
  assert.equal(camera.poseFromHomography(null, K).ok, false);
  assert.equal(camera.poseFromHomography([1, 0, 0, 0, 1, 0, 0, 0, 1], null).ok, false);
});

test('roofFrame and groundFrame: level e1, slope into the house, ground toward the camera', () => {
  // eave tapped slightly out of level: e1 must still be horizontal
  const fr = camera.roofFrame([0, 12, 0], [40, 12.5, 0], 6, 12);
  assert.ok(Math.abs(fr.e1[1]) < 1e-12);
  assert.ok(Math.abs(g.v3len(fr.e1) - 1) < 1e-12);
  assert.ok(Math.abs(g.v3len(fr.e2) - 1) < 1e-12);
  assert.ok(fr.e2[2] < 0, 'slope runs into the house');
  assert.ok(Math.abs(fr.e2[1] / Math.hypot(fr.e2[0], fr.e2[2]) - 0.5) < 1e-12, '6/12');
  assert.ok(Math.abs(g.v3dot(fr.e1, fr.e2)) < 1e-12);
  assert.ok(fr.n[1] > 0);
  // reversed eave direction still slopes into the house
  const fr2 = camera.roofFrame([40, 12, 0], [0, 12, 0], 6, 12);
  assert.ok(fr2.e2[2] < 0);
  const gr = camera.groundFrame([40, 0, 0], [0, 0, 0]);
  assert.ok(gr.e2[2] > 0, 'ground extends toward the camera');
  assert.ok(Math.abs(gr.e2[1]) < 1e-15);
  assert.equal(camera.roofFrame([0, 0, 0], [0, 5, 0], 6, 12), null, 'vertical eave is rejected');
});

test('homographyForFrame matches the independent projection', () => {
  const cam = makeCamera();
  const quad = WALL.map((X) => project(cam, X));
  const K = { f: F26, cx: W / 2, cy: H / 2 };
  const pose = camera.poseFromHomography(g.homographyFromPoints([[0, 12], [40, 12], [40, 0], [0, 0]], quad), K);
  const fr = camera.roofFrame([0, 12, 0], [40, 12, 0], 6, 12);
  const Hr = camera.homographyForFrame(fr, K, pose);
  const ab = [10, 5];
  const X = g.v3add(fr.origin, g.v3add(g.v3scale(fr.e1, ab[0]), g.v3scale(fr.e2, ab[1])));
  const p = g.applyH(Hr, ab), q = project(cam, X);
  assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6);
});

test('orthoPitchLength formula', () => {
  const th = Math.atan2(6, 12);
  assert.ok(Math.abs(camera.orthoPitchLength(10, 3, 6, 12) - Math.sqrt(100 + (3 / Math.sin(th)) ** 2)) < 1e-12);
  assert.ok(Math.abs(camera.orthoPitchLength(0, 6, 6, 12) - Math.hypot(12, 6)) < 1e-9, 'rise 6 at 6/12 = slope 13.42');
  assert.equal(camera.orthoPitchLength(3, 4, 0, 12), 5, 'flat roof: plain length');
});

test('resolveCamera order: manual, preset, EXIF, rectangle, default', () => {
  const cam = makeCamera();
  const quad = WALL.map((X) => project(cam, X));
  const planes = [{ id: 'pl', imageId: 'img', name: 'Front wall', kind: 'wall', rect: { corners: quad, widthFt: null, heightFt: null }, refs: [] }];
  const base = { id: 'img', width: W, height: H, exif: null };
  const r1 = camera.resolveCamera(Object.assign({}, base, { camera: { mode: 'auto' } }), planes);
  assert.equal(r1.source, 'rectangle');
  assert.ok(relErr(r1.f, F26) < 0.01);
  const r2 = camera.resolveCamera(Object.assign({}, base, { exif: { focal35: 52 }, camera: { mode: 'auto' } }), planes);
  assert.equal(r2.source, 'exif');
  assert.ok(relErr(r2.f, 2 * F26) < 1e-9);
  const r3 = camera.resolveCamera(Object.assign({}, base, { camera: { mode: 'preset', presetId: 'streetview' } }), planes);
  assert.equal(r3.source, 'preset');
  assert.ok(Math.abs(r3.f - 800) < 1e-9);
  const r4 = camera.resolveCamera(Object.assign({}, base, { camera: { mode: 'manual', focalPx: 1500 } }), planes);
  assert.equal(r4.source, 'manual');
  assert.equal(r4.f, 1500);
  const r5 = camera.resolveCamera(Object.assign({}, base, { camera: { mode: 'auto' } }), []);
  assert.equal(r5.source, 'default');
  assert.ok(relErr(r5.f, F26) < 1e-9);
  const r6 = camera.resolveCamera({ id: 'x' }, null);
  assert.equal(r6.ok, false);
  assert.doesNotThrow(() => camera.resolveCamera(null, [null, 5, 'x']));
});

test('resolveCamera distrusts EXIF focal35 when the photo was cropped or resized (M5)', () => {
  const cam = makeCamera();
  const quad = WALL.map((X) => project(cam, X));
  const planes = [{ id: 'pl', imageId: 'img', name: 'Front wall', kind: 'wall', rect: { corners: quad, widthFt: null, heightFt: null }, refs: [] }];
  // Stored at native size (below the 2048 px cap) but EXIF says the original was twice as big: cropped.
  const cropped = { id: 'img', width: W, height: H, exif: { focal35: 26, width: 2 * W, height: 2 * H }, camera: { mode: 'auto' } };
  const r = camera.resolveCamera(cropped, planes);
  assert.notEqual(r.source, 'exif');
  assert.equal(r.source, 'rectangle');
  assert.match(r.exifIgnored, /cropped|resized/);
  // Different aspect ratio (a crop) even when the stored photo was downscaled.
  const big = { id: 'img', width: 2048, height: 1536, exif: { focal35: 26, width: 4032, height: 2268 }, camera: { mode: 'auto' } };
  assert.notEqual(camera.resolveCamera(big, []).source, 'exif');
  // Matching dimensions (downscaled 4032 x 3024 → 2048 x 1536), or rotated by the orientation tag: trusted.
  const ok1 = { id: 'img', width: 2048, height: 1536, exif: { focal35: 26, width: 4032, height: 3024 }, camera: { mode: 'auto' } };
  assert.equal(camera.resolveCamera(ok1, []).source, 'exif');
  const ok2 = { id: 'img', width: 1536, height: 2048, exif: { focal35: 26, width: 4032, height: 3024, orientation: 6 }, camera: { mode: 'auto' } };
  assert.equal(camera.resolveCamera(ok2, []).source, 'exif');
  const ok3 = { id: 'img', width: W, height: H, exif: { focal35: 26 }, camera: { mode: 'auto' } };
  assert.equal(camera.resolveCamera(ok3, []).source, 'exif');
});

test('resolveCamera reports the rectangle estimate next to a preset/EXIF focal so a mismatch can be flagged (F3)', () => {
  const cam = makeCamera();
  const quad = WALL.map((X) => project(cam, X));
  const planes = [{ id: 'pl', imageId: 'img', name: 'Front wall', kind: 'wall', rect: { corners: quad, widthFt: null, heightFt: null }, refs: [] }];
  const r = camera.resolveCamera({ id: 'img', width: W, height: H, exif: null, camera: { mode: 'preset', presetId: 'streetview' } }, planes);
  assert.equal(r.source, 'preset');
  assert.ok(r.rectEstimate && relErr(r.rectEstimate.f, F26) < 0.01);
  assert.equal(r.rectEstimate.planeId, 'pl');
  const auto = camera.resolveCamera({ id: 'img', width: W, height: H, exif: null, camera: { mode: 'auto' } }, planes);
  assert.deepEqual(auto.focalQuad, { planeId: 'pl', refId: null });
  assert.ok(relErr(camera.focalFromQuadQuick(g.orderQuad(quad), W / 2, H / 2), F26) < 0.01);
});
