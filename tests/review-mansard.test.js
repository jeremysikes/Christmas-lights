// Review fixes for the mansard work (SPEC §8.6), core side. Each test is named by its finding id.
//   A1  a larger reference rectangle that disagrees with the wall's own is not used for scale, and a gap between
//       the two caps the rating
//   A2  a reference whose id is 'rect' never competes with the wall's own rectangle
//   A3  the choice holds under small nudges away from the 0.75 boundary (the boundary itself is a hard threshold)
//   P1  nudged re-solves do not rebuild the candidate table
//   B1  an upper roof does not take the project pitch as measured
//   S1  a damaged steep slope loads as "not measured", and the validator reports parent loops
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LP = require('./loader');
const measure = LP.require('measure');
const schema = LP.require('schema');
const g = LP.require('geometry');
const sim = require('./sim-houses');
const man = require('./sim-mansard');

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mansard-house.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const noDashes = (s) => assert.ok(!/[—–]/.test(s), 'no dashes in on-screen text: ' + s);
const WALL = 'pl_5ymbns89', GARAGE = 'ref_f0uo6flu', RIDGE = 'ft_av29e5cj';

/**
 * A 44 ft wall whose own rectangle is a 3 x 5 ft window, with a 16 x 7 ft garage door as a reference. The garage
 * door can sit behind the wall (setback, ft) and its typed size can be wrong. Three items lie on the main wall.
 */
function twoRectWall(o) {
  const opt = Object.assign({ setback: 0, typedW: 16, typedH: 7, dist: 38, refId: 'ref_garage' }, o);
  const cam = sim.makeCamera({ yawDeg: 3, tiltDeg: 2, dist: opt.dist, height: 5.5, target: [26, 6, 0], f: sim.F26 });
  const P = (list) => list.map((X) => sim.project3(cam, X));
  const sq = (u, v, w, h, z) => [[u, v + h, z], [u + w, v + h, z], [u + w, v, z], [u, v, z]];
  const item = (id, type, pts, closed) => ({ id, imageId: 'img', planeId: 'pl_w', type, label: id, points: P(pts), closed, overrideFt: null, productId: null, color: null, params: {} });
  const proj = {
    schema: 'lightplan/project', version: 1, id: 'p', name: 'two rectangles',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    images: [{ id: 'img', name: 'h.jpg', width: sim.IMG_W, height: sim.IMG_H, exif: { focal35: 26 }, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img' }],
    activeImageId: 'img',
    planes: [{
      id: 'pl_w', imageId: 'img', name: 'Front wall', kind: 'wall',
      rect: { corners: P(sq(8, 3, 3, 5, 0)), widthFt: 3, heightFt: 5, presetId: 'custom-rect' },
      refs: [{ id: opt.refId, kind: 'rect', points: P(sq(24, 0, 16, 7, -opt.setback)), widthFt: opt.typedW, heightFt: opt.typedH, presetId: 'custom-rect', quality: 'high' }],
      derived: null,
    }],
    features: [
      item('line20', 'roofline', [[22, 9, 0], [42, 9, 0]], false),
      item('line12', 'roofline', [[26, 8, 0], [38, 8, 0]], false),
      item('win', 'window', [[14, 8, 0], [18, 8, 0], [18, 4, 0], [14, 4, 0]], true),
    ],
    outlets: [], circuits: [], library: { products: null, config: null },
  };
  for (const pl of proj.planes) for (const p of pl.rect.corners.concat(pl.refs[0].points)) assert.ok(p && p[0] > 0 && p[0] < sim.IMG_W && p[1] > 0 && p[1] < sim.IMG_H, 'in frame');
  return { proj, truth: { line20: 20, line12: 12, win: 16 } };
}

test('A1: a larger rectangle that is set back or mistyped never earns a rating its lengths do not keep', () => {
  const cases = [];
  for (const dist of [38, 62]) for (const setback of [0, 1.5, 2, 3, 4, -3]) cases.push({ dist, setback });
  for (const typedW of [15, 18, 9]) cases.push({ typedW });
  cases.push({ typedW: 160, typedH: 70 }); // inches typed as feet
  let switched = 0;
  for (const c of cases) {
    const { proj, truth } = twoRectWall(c);
    const r = measure.measureProject(proj);
    const w = r.planes.pl_w;
    const what = JSON.stringify(c);
    if (w.calib.rectAuto) switched++;
    for (const id of Object.keys(truth)) {
      const f = r.features[id];
      const err = Math.abs(f.measuredFt / truth[id] - 1) * 100;
      if (f.confidence.level === 'high') assert.ok(err <= 3, what + ' ' + id + ' is High but off by ' + err.toFixed(1) + '%');
      if (f.confidence.level === 'medium') assert.ok(err <= 6, what + ' ' + id + ' is Medium but off by ' + err.toFixed(1) + '%');
    }
    // The wall pill follows the same rule: its lengths are those of the items on it.
    const worst = Math.max(...Object.keys(truth).map((id) => Math.abs(r.features[id].measuredFt / truth[id] - 1) * 100));
    if (w.confidence.level === 'high') assert.ok(worst <= 3, what + ' wall High, items off by ' + worst.toFixed(1) + '%');
    if (w.confidence.level === 'medium') assert.ok(worst <= 6, what + ' wall Medium, items off by ' + worst.toFixed(1) + '%');
  }
  assert.ok(switched >= 2, 'the garage door is still used when it agrees: ' + switched);

  // A garage door that agrees is used, and reports no gap.
  const good = measure.measureProject(twoRectWall({}).proj).planes.pl_w;
  assert.deepEqual([good.calib.rectFrom, good.calib.rectAuto, good.calib.rectRejected, good.confidence.level], ['ref_garage', true, null, 'high']);
  assert.ok(good.calib.rectCheckPct < 0.01);

  // A plainly wrong size: the wall's own rectangle stays, lengths are true, and the note says why.
  const typo = twoRectWall({ typedW: 9 });
  const t = measure.measureProject(typo.proj);
  const tw = t.planes.pl_w;
  assert.deepEqual([tw.calib.rectFrom, tw.calib.rectAuto, tw.calib.rectCheckPct], ['rect', false, null]);
  assert.equal(tw.calib.rectRejected.from, 'ref_garage');
  assert.ok(tw.calib.rectRejected.pct > 40);
  assert.ok(Math.abs(t.features.line20.measuredFt / 20 - 1) < 1e-6, 'the wall\'s own rectangle gives the true length');
  assert.equal(tw.confidence.level, 'low');
  const note = tw.notes.find((n) => /would give a steadier scale/.test(n));
  assert.ok(note, 'the note says why the larger rectangle was not used');
  assert.match(note, /does not agree with 'Rectangle \(3′ 0″ × 5′ 0″\)'/);
  noDashes(note);
  assert.ok(tw.issues.some((i) => i.code === 'ref-disagreement'), 'the disagreement warning stays');

  // A small gap that tap noise could explain: the garage door is used, but the rating cannot promise less than the gap.
  const near = measure.measureProject(twoRectWall({ setback: 1.5 }).proj);
  const nw = near.planes.pl_w;
  assert.equal(nw.calib.rectFrom, 'ref_garage');
  assert.ok(nw.calib.rectCheckPct >= 3 && nw.calib.rectCheckPct < 6, String(nw.calib.rectCheckPct));
  assert.equal(nw.confidence.level, 'medium');
  assert.equal(near.features.line20.confidence.level, 'medium');
  const why = near.features.line20.confidence.reasons.find((x) => /two measured rectangles/.test(x));
  assert.ok(why, near.features.line20.confidence.reasons.join(' | '));
  noDashes(why);
  const far = measure.measureProject(twoRectWall({ setback: 4, dist: 62 }).proj);
  if (far.planes.pl_w.calib.rectAuto) assert.equal(far.planes.pl_w.confidence.level, 'low', 'a gap of 6% or more is Low');

  // Absurd references are never chosen.
  for (const bad of [(ref) => { ref.points = ref.points.map((p, i) => [i % 2 ? 1e7 : -1e7, i < 2 ? -1e7 : 1e7]); }, (ref) => { ref.widthFt = 1e-9; ref.heightFt = 1e-9; }]) {
    const { proj } = twoRectWall({});
    bad(proj.planes[0].refs[0]);
    const m = measure.measureProject(proj);
    assert.equal(m.planes.pl_w.calib.rectFrom, 'rect');
    assert.ok(Math.abs(m.features.line20.measuredFt / 20 - 1) < 1e-6);
  }
});

test('A1: the mansard house still goes to Medium: its window agrees with the garage door within 1%', () => {
  const r = measure.measureProject(fixture());
  const w = r.planes[WALL];
  assert.deepEqual([w.calib.rectFrom, w.calib.rectAuto, w.calib.rectRejected, w.confidence.level, w.confidence.score], [GARAGE, true, null, 'medium', 74]);
  assert.ok(w.calib.rectCheckPct < 1, String(w.calib.rectCheckPct));
  assert.ok(!w.confidence.reasons.some((x) => /two measured rectangles/.test(x)));
  assert.equal(r.features[RIDGE].confidence.level, 'low');
});

test('A2: a reference with the id "rect" is only a check, and the report names the wall\'s own rectangle', () => {
  const a = measure.measureProject(twoRectWall({}).proj).planes.pl_w;
  const b = measure.measureProject(twoRectWall({ refId: 'rect' }).proj).planes.pl_w;
  assert.equal(a.calib.rectFrom, 'ref_garage');
  assert.deepEqual([b.calib.rectFrom, b.calib.rectAuto, b.calib.rectLabel, b.calib.rectCandidates], ['rect', false, 'Rectangle (3′ 0″ × 5′ 0″)', null]);
  // Solved from the window alone, so its expected error is the window's (large), not the garage door's.
  const alone = twoRectWall({});
  alone.proj.planes[0].refs = [];
  const c = measure.measureProject(alone.proj).planes.pl_w;
  assert.ok(Math.abs(b.uncertaintyPct - c.uncertaintyPct) < 1e-9, b.uncertaintyPct + ' vs ' + c.uncertaintyPct);
  assert.ok(b.uncertaintyPct > 3 * a.uncertaintyPct);
  assert.equal(b.checks, 2, 'the garage door still checks the scale');
});

test('A3: away from the 0.75 boundary no 1 px nudge of a corner flips the choice', () => {
  const sq = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const wallWith = (refFt) => ({
    settings: {}, images: [{ id: 'img', width: 2000, height: 1500, exif: { focal35: 26 } }],
    planes: [{
      id: 'pl_w', imageId: 'img', name: 'Front', kind: 'wall',
      rect: { corners: sq(300, 700, 200, 200), widthFt: 10, heightFt: 10, presetId: 'custom-rect' },
      refs: [{ id: 'r2', kind: 'rect', points: sq(1200, 700, refFt * 20, refFt * 20), widthFt: refFt, heightFt: refFt, presetId: 'custom-rect', quality: 'high' }],
      derived: null,
    }],
    features: [],
  });
  for (const [refFt, want] of [[10.5, 'rect'], [11, 'rect'], [16, 'r2'], [20, 'r2']]) {
    const base = measure.measureProject(wallWith(refFt)).planes.pl_w;
    assert.equal(base.calib.rectFrom, want, refFt + ' ft');
    const ratio = base.calib.rectCandidates[1].expectedPct / base.calib.rectCandidates[0].expectedPct;
    assert.ok(Math.abs(ratio - 0.75) > 0.05, 'clear of the boundary: ' + ratio.toFixed(3));
    for (let k = 0; k < 4; k++) for (const axis of [0, 1]) for (const d of [1, -1]) {
      const p = wallWith(refFt);
      p.planes[0].refs[0].points[k][axis] += d;
      assert.equal(measure.measureProject(p).planes.pl_w.calib.rectFrom, want, refFt + ' ft, corner ' + k);
    }
  }
});

test('P1: nudged re-solves keep the choice without rebuilding the candidate table', () => {
  const count = (proj) => {
    const real = g.homographyFromPoints;
    let n = 0;
    g.homographyFromPoints = function () { n++; return real.apply(this, arguments); };
    try { measure.measureProject(proj); } finally { g.homographyFromPoints = real; }
    return n;
  };
  const withRef = fixture();
  const swapped = clone(withRef); // the same wall with the garage door as its own rectangle: nothing to choose
  const pl = swapped.planes[0], ref = pl.refs[0];
  pl.refs = [{ id: 'ref_window', kind: 'rect', points: pl.rect.corners, widthFt: 3, heightFt: 5, presetId: 'custom-rect', quality: 'high', tapErr: pl.rect.tapErr }];
  pl.rect = { corners: ref.points, widthFt: ref.widthFt, heightFt: ref.heightFt, presetId: 'custom-rect', tapErr: ref.tapErr };
  const a = count(withRef), b = count(swapped);
  // Choosing costs one candidate table (17 fits for each of 2 rectangles) and one agreement test (17 fits), once.
  assert.ok(a - b <= 2 * 17 + 17 + 4, 'fits with a choice ' + a + ', without ' + b);
  assert.ok(a > b, 'the choice itself is made once: ' + a + ' vs ' + b);
});

test('B1: an upper roof with no pitch of its own borrows the house pitch as an assumption, rated Low', () => {
  const h = man.mansardHouse({ deg: 70, upperRise: 2, dist: 45, height: 12, tiltDeg: 0, yawDeg: 8 });
  assert.ok(h, 'the house fits the frame');
  const proj = man.mansardProject(h, { upperPitch: 'none' });
  proj.settings.roofPitch = { rise: 4, run: 12 }; // the house pitch; the top of this mansard is really 2/12
  const r = measure.measureProject(proj);
  const u = r.planes.pl_u;
  assert.deepEqual([u.pitch.rise, u.pitch.run, u.pitch.source], [4, 12, 'house']);
  assert.equal(u.confidence.level, 'low');
  const why = u.confidence.reasons.find((x) => /Enter the pitch of this upper roof/.test(x));
  assert.ok(why, u.confidence.reasons.join(' | '));
  noDashes(why);
  for (const id of ['topEdge', 'upperHip']) {
    assert.equal(r.features[id].confidence.level, 'low', id);
    assert.ok(r.features[id].confidence.reasons.some((x) => /Enter the pitch of this upper roof/.test(x)), id);
  }
  assert.ok(Math.abs(r.features.topEdge.measuredFt / h.truth.topEdge - 1) > 0.05, 'the borrowed pitch really is off here');
  // The steep face below is unaffected, and an ordinary roof on the wall still takes the project pitch as measured.
  assert.equal(r.planes.pl_s.pitch.source, 'user');
  const ordinary = clone(proj);
  ordinary.planes.push({ id: 'pl_r', imageId: 'img', name: 'Garage roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: clone(h.px.eave), pitch: null } });
  assert.equal(measure.measureProject(ordinary).planes.pl_r.pitch.source, 'user');
  // With its own pitch the upper roof is measured and true.
  const own = man.mansardProject(h, { upperPitch: 'own' });
  own.settings.roofPitch = { rise: 4, run: 12 };
  const r2 = measure.measureProject(own);
  assert.deepEqual([r2.planes.pl_u.pitch.rise, r2.planes.pl_u.pitch.source], [2, 'user']);
  assert.ok(Math.abs(r2.features.topEdge.measuredFt / h.truth.topEdge - 1) < 1e-6);
  assert.ok(!r2.features.topEdge.confidence.reasons.some((x) => /Enter the pitch of this upper roof/.test(x)));
  // No house pitch at all: the 6/12 default, Low, as before.
  const none = man.mansardProject(h, { upperPitch: 'none' });
  assert.equal(measure.measureProject(none).planes.pl_u.pitch.source, 'default');
});

test('S1: a steep slope with a missing run loads as not measured, so loading never changes a length', () => {
  const h = man.mansardHouse({ deg: 70 });
  const proj = man.mansardProject(h, { steep: 'default' });
  proj.planes[1].derived.pitch = { rise: 8 }; // run lost
  const raw = measure.measureProject(proj);
  const loaded = schema.normalizeProject(proj);
  const steep = loaded.planes.find((p) => p.id === 'pl_s');
  assert.equal(steep.derived.pitch, null, 'no run of 12 is made up on a steep face');
  assert.equal(steep.derived.steep, true);
  const after = measure.measureProject(loaded);
  assert.deepEqual([after.planes.pl_s.pitch.source, Math.round(after.planes.pl_s.pitch.angleDeg)], ['default', 70]);
  for (const id of Object.keys(raw.features)) {
    assert.ok(Math.abs(after.features[id].measuredFt - raw.features[id].measuredFt) < 1e-9, id);
    assert.equal(after.features[id].confidence.level, raw.features[id].confidence.level, id);
  }
  // A run of zero or less, or a rise of zero, is dropped the same way; two good tape numbers are kept as typed.
  for (const bad of [{ rise: 8, run: 0 }, { rise: 8, run: -2 }, { rise: 0, run: 3 }, { rise: 8, run: 'x' }]) {
    const p = man.mansardProject(h, { steep: 'default' });
    p.planes[1].derived.pitch = bad;
    assert.equal(schema.normalizeProject(p).planes[1].derived.pitch, null, JSON.stringify(bad));
  }
  const ok = man.mansardProject(h, { steep: 'tape' });
  assert.deepEqual(schema.normalizeProject(ok).planes[1].derived.pitch, { rise: h.up, run: h.back });
  // An ordinary roof keeps the old rule (a missing run means "per 12").
  const ord = man.mansardProject(h, {});
  ord.planes[2].derived.pitch = { rise: 4 };
  assert.deepEqual(schema.normalizeProject(ord).planes[2].derived.pitch, { rise: 4, run: 12 });
});

test('S1: the validator reports parent loops, a ground area on a roof and a roof on a ground area', () => {
  const h = man.mansardHouse({ deg: 70 });
  const base = () => schema.normalizeProject(man.mansardProject(h, {}));
  assert.deepEqual(schema.validateProject(base()).errors, []);
  const loop = base();
  loop.planes[1].derived.parentPlaneId = 'pl_u';
  const e1 = schema.validateProject(loop).errors;
  assert.ok(e1.some((e) => /is built from a surface that is built from it/.test(e)), e1.join(' | '));
  assert.equal(measure.measureProject(loop).ok, true, 'and measuring it does not throw');
  const ground = base();
  ground.planes[2].kind = 'ground';
  const e2 = schema.validateProject(ground).errors;
  assert.ok(e2.some((e) => /a ground area must be built from a wall/.test(e)), e2.join(' | '));
  const roofOnGround = base();
  roofOnGround.planes[1].kind = 'ground';
  delete roofOnGround.planes[1].derived.steep;
  delete roofOnGround.planes[1].derived.angleDeg;
  const e3 = schema.validateProject(roofOnGround).errors;
  assert.ok(e3.some((e) => /a roof cannot be built from a ground area/.test(e)), e3.join(' | '));
  for (const e of e1.concat(e2, e3)) noDashes(e);
});

test('F2: an item drawn below the line where its roof starts is flagged, rated Low, and offered the surfaces under it', () => {
  const h = man.mansardHouse({ deg: 70 });
  const proj = man.mansardProject(h, {});
  // In the right place nothing is flagged (the corner edges start exactly on the steep face's line).
  const good = measure.measureProject(proj);
  for (const id of Object.keys(good.features)) assert.equal(good.features[id].wrongSurface, null, id);
  assert.deepEqual(measure.misplacedFeatures(proj, good), []);
  // The left corner edge, the dormer and a gutter along the wall's eave, all put on the upper roof by mistake.
  const bad = clone(proj);
  for (const f of bad.features) if (f.id === 'cornerLeft' || f.id === 'dormer') f.planeId = 'pl_u';
  bad.features.push({ id: 'gutter', imageId: 'img', planeId: 'pl_u', type: 'gutter', label: 'Gutter 1', points: clone(h.px.eave), closed: false, overrideFt: null, productId: null, color: null, params: {} });
  const r = measure.measureProject(bad);
  for (const id of ['cornerLeft', 'dormer', 'gutter']) {
    const m = r.features[id];
    assert.deepEqual([m.wrongSurface, m.belowLine, m.confidence.level], ['below', true, 'low'], id);
    const why = m.confidence.reasons.find((x) => /below the line where this roof starts/.test(x));
    assert.ok(why, id + ': ' + m.confidence.reasons.join(' | '));
    noDashes(why);
  }
  assert.equal(r.features.topEdge.wrongSurface, null, 'the top edge is on the upper roof');
  const list = measure.misplacedFeatures(bad, r);
  assert.deepEqual(list.map((x) => [x.featureId, x.wants, x.planeId, x.canCreate]).sort(), [['cornerLeft', 'below', 'pl_u', false], ['dormer', 'below', 'pl_u', false], ['gutter', 'below', 'pl_u', false]]);
  const corner = list.find((x) => x.featureId === 'cornerLeft');
  assert.deepEqual(corner.candidates.map((c) => [c.planeId, c.kind, c.steep, c.below]), [['pl_s', 'roof', true, false], ['pl_w', 'wall', false, false]], 'nearest surface first');
  assert.ok(Math.abs(corner.candidates[0].lengthFt / h.truth.cornerLeft - 1) < 1e-6, 'on the steep face it measures true');
  noDashes(corner.message);
  // The gutter along the wall's eave is not below the steep face's line (it is on it), and it measures true there.
  const gutter = list.find((x) => x.featureId === 'gutter');
  assert.equal(gutter.candidates[0].below, false);
  assert.ok(Math.abs(gutter.candidates[0].lengthFt / h.truth.eave - 1) < 1e-6);
  // A tape-measured length ends the matter.
  bad.features.find((f) => f.id === 'gutter').overrideFt = 44;
  assert.ok(!measure.misplacedFeatures(bad).some((x) => x.featureId === 'gutter'));
});

test('F1 F3: roof candidates for a ridge on a wall say whether their line lies under it and how rough they are', () => {
  const h = man.mansardHouse({ deg: 70 });
  const proj = man.mansardProject(h, {});
  // The top edge drawn on the wall, plus an ordinary roof over the right-hand third of the wall only.
  const top = proj.features.find((f) => f.id === 'topEdge');
  top.planeId = 'pl_w';
  const eave = h.px.eave;
  const part = [[eave[0][0] + 0.8 * (eave[1][0] - eave[0][0]), eave[0][1] + 0.8 * (eave[1][1] - eave[0][1])], eave[1].slice()];
  proj.planes.push({ id: 'pl_side', imageId: 'img', name: 'Side roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: part, pitch: { rise: 6, run: 12 } } });
  const r = measure.measureProject(proj);
  const item = measure.misplacedFeatures(proj, r).find((x) => x.featureId === 'topEdge');
  assert.equal(item.wants, 'roof');
  const by = {};
  for (const c of item.candidates) by[c.planeId] = c;
  assert.deepEqual([by.pl_u.under, by.pl_u.upper, by.pl_u.below], [true, true, false]);
  assert.deepEqual([by.pl_s.under, by.pl_s.upper], [true, false]);
  assert.equal(by.pl_side.under, false, 'the side roof starts beside the item, not under it');
  for (const c of item.candidates) assert.ok(c.expectedPct > 0, c.planeId + ' reports its expected error');
});

test('F6: tape numbers for a face that is not steep are refused, and a likely swap is reported', () => {
  const flat = measure.steepFromTape({ upFt: 1, backFt: 8 });
  assert.equal(flat.ok, false);
  assert.match(flat.reason, /not a steep face/);
  assert.match(flat.reason, /Roof slope/);
  noDashes(flat.reason);
  const leaning = measure.steepFromTape({ upFt: 3, backFt: 8 }); // 20.6°: allowed, but probably swapped
  assert.deepEqual([leaning.ok, leaning.swapLikely, Math.round(leaning.angleDeg)], [true, true, 21]);
  const fine = measure.steepFromTape({ upFt: 8, backFt: 3 });
  assert.deepEqual([fine.ok, fine.swapLikely], [true, false]);
  assert.equal(measure.steepFromTape({ upFt: 5, backFt: 5 }).swapLikely, false, '45° is not flagged');
});

test('open issue (power): a cord to an item on an upper roof runs down both roofs to the wall, not a photo-based guess', () => {
  const plan = LP.require('plan');
  const h = man.mansardHouse({ deg: 70 });
  const proj = man.mansardProject(h, {});
  proj.features = proj.features.filter((f) => f.id === 'topEdge');
  proj.outlets = [{ id: 'out_1', imageId: 'img', planeId: 'pl_w', point: sim.project3(h.cam, [4, 1.5, 0]), label: 'Outlet 1', type: 'exteriorGfci', gfci: true, circuitId: null }];
  const loaded = schema.normalizeProject(proj);
  const out = plan.computePlan(loaded);
  const cords = [];
  for (const f of out.power.feeds || []) if (f.cord && Array.isArray(f.cord.route)) cords.push(f.cord);
  assert.ok(cords.length >= 1, 'the top edge gets a cord');
  const route = cords[0].route;
  const slope = route.filter((s) => s.kind === 'roof').reduce((t, s) => t + s.lengthFt, 0);
  // Down the upper roof to the trim line and down the steep face (8.5 ft of slope) to the eave, then down the wall.
  assert.ok(slope >= h.slope - 0.2, 'the cord follows the slope of both roofs: ' + slope.toFixed(1) + ' ft, steep face alone ' + h.slope.toFixed(1));
  assert.ok(!route.some((s) => s.kind === 'direct'), 'no straight-line guess across the photo: ' + route.map((s) => s.kind).join(' > '));
  assert.ok(route.some((s) => s.kind === 'rise' && Math.abs(s.lengthFt - h.Hw) < 0.5), 'and it goes up the wall to the eave: ' + JSON.stringify(route.map((s) => [s.kind, s.lengthFt])));
  assert.match(cords[0].routeText, /up the roof/);
});
