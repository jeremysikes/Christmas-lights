// The mansard house: best rectangle for scale (A), steep roof faces and upper roofs (B), and items drawn on the
// wrong kind of surface (C).
//
// tests/fixtures/mansard-house.json is the geometry of a real project (no photo): a 2048 x 1152 photo taken from
// about 64 ft, one wall whose rectangle is a 3 x 5 ft window only 63 x 101 px, a known-size reference rectangle
// on a garage door (8 ft x 7 ft 2 in, 155 x 140 px) and a ridge drawn on the wall.
// tests/fixtures/sample-house-measured.json is the measured sample house (levels, scores, lengths, reasons) as it
// was before these changes; the sample house must not move.
// tests/sim-mansard.js builds synthetic mansard houses in 3D and projects them into a photo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LP = require('./loader');
const measure = LP.require('measure');
const schema = LP.require('schema');
const sample = LP.require('sample');
const plan = LP.require('plan');
const g = LP.require('geometry');
const sim = require('./sim-houses');
const man = require('./sim-mansard');

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mansard-house.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}
const pct = (x) => (x == null ? 'none' : (100 * x).toFixed(1) + '%');
const WALL = 'pl_5ymbns89', GARAGE = 'ref_f0uo6flu', RIDGE = 'ft_av29e5cj';
const noDashes = (s) => assert.ok(!/[—–]/.test(s), 'no dashes in on-screen text: ' + s);

// ================================================================ A. best rectangle for scale
test('A: the mansard house wall goes from Low to Medium with no re-tapping: the garage door sets the scale, the window checks it', () => {
  const proj = fixture();
  // The fixture is the geometry of the user's file; loading it (normalizeProject) changes nothing that is measured.
  const loaded = schema.normalizeProject(proj);
  assert.deepEqual(schema.validateProject(loaded).errors, []);
  assert.deepEqual(loaded.planes, proj.planes);
  assert.deepEqual(loaded.features[0].points, proj.features[0].points);
  // Before: what the window alone gives (the same project without its garage door reference).
  const before = clone(proj);
  before.planes[0].refs = [];
  const b = measure.measureProject(before).planes[WALL];
  assert.equal(b.confidence.level, 'low');
  assert.equal(b.confidence.score, 49);
  assert.ok(b.uncertaintyPct > 13 && b.uncertaintyPct < 15, 'about ±14%: ' + b.uncertaintyPct);
  assert.equal(b.calib.rectFrom, 'rect');
  assert.equal(b.calib.rectAuto, false);

  // After: the stored project, untouched.
  const r = measure.measureProject(proj);
  const w = r.planes[WALL];
  assert.equal(w.mode, 'rect-known');
  assert.equal(w.confidence.level, 'medium');
  assert.equal(w.confidence.score, 74);
  assert.ok(w.uncertaintyPct > 5 && w.uncertaintyPct < 6, 'about ±5.6%: ' + w.uncertaintyPct);
  assert.equal(w.calib.rectFrom, GARAGE);
  assert.equal(w.calib.rectLabel, 'Custom rectangle (8′ 0″ × 7′ 2″)');
  assert.equal(w.calib.rectAuto, true);
  assert.equal(w.calib.rectWhy, 'largest');
  assert.equal(w.calib.scaleFrom, 'rect');
  assert.deepEqual(w.calib.rectCandidates.map((c) => [c.from, c.used]), [['rect', false], [GARAGE, true]]);
  assert.ok(w.calib.rectCandidates[1].expectedPct < 0.5 * w.calib.rectCandidates[0].expectedPct, 'the garage door is clearly better, not a close call');
  assert.equal(w.notes[0], "Scale taken from 'Custom rectangle (8′ 0″ × 7′ 2″)' (the largest measured rectangle). 'Rectangle (3′ 0″ × 5′ 0″)' is used as a check.");
  noDashes(w.notes[0]);
  // The window is now a check, and it agrees within 1%.
  assert.equal(w.checks, 2);
  assert.deepEqual(w.refResults.map((x) => [x.label, x.refId, x.fromRect]), [
    ['Rectangle (3′ 0″ × 5′ 0″), width', null, true], ['Rectangle (3′ 0″ × 5′ 0″), height', null, true],
  ]);
  for (const x of w.refResults) assert.ok(Math.abs(x.errorPct) < 1, x.label + ' ' + x.errorPct);
  assert.ok(w.disagreementPct < 1);

  // The same as swapping rectangle and reference by hand.
  const swapped = clone(proj);
  const pl = swapped.planes[0], ref = pl.refs[0];
  pl.refs = [{ id: 'ref_window', kind: 'rect', points: pl.rect.corners, widthFt: 3, heightFt: 5, presetId: 'custom-rect', quality: 'high', tapErr: pl.rect.tapErr }];
  pl.rect = { corners: ref.points, widthFt: ref.widthFt, heightFt: ref.heightFt, presetId: 'custom-rect', tapErr: ref.tapErr };
  const s = measure.measureProject(swapped);
  assert.equal(s.planes[WALL].calib.rectFrom, 'rect');
  assert.equal(s.planes[WALL].calib.rectAuto, false, 'the garage door is the wall rectangle now, nothing to choose');
  assert.equal(s.planes[WALL].confidence.level, 'medium');
  assert.equal(s.planes[WALL].confidence.score, 74);
  assert.ok(Math.abs(s.planes[WALL].uncertaintyPct - w.uncertaintyPct) < 1e-9);
  assert.ok(Math.abs(s.features[RIDGE].measuredFt - r.features[RIDGE].measuredFt) < 1e-9, 'same lengths either way');
});

test('A: stored project data is not rewritten, and measuring twice gives the same answer', () => {
  const proj = fixture();
  const text = JSON.stringify(proj);
  const first = measure.measureProject(deepFreeze(proj));
  assert.equal(JSON.stringify(proj), text, 'the project is untouched');
  assert.equal(proj.planes[0].rect.widthFt, 3, 'the wall rectangle is still the window');
  assert.equal(proj.planes[0].refs.length, 1);
  assert.equal(JSON.stringify(measure.measureProject(proj)), JSON.stringify(first));
  assert.equal(JSON.stringify(measure.solvePlanes(proj).planes[WALL].calib), JSON.stringify(first.planes[WALL].calib), 'solvePlanes makes the same choice');
});

test('A: the choice is stable: no ±2.5 px nudge of any calibration tap flips it, and close calls keep the wall\'s own rectangle', () => {
  const proj = fixture();
  const lists = [proj.planes[0].rect.corners, proj.planes[0].refs[0].points];
  for (let li = 0; li < lists.length; li++) {
    for (let k = 0; k < 4; k++) for (const axis of [0, 1]) for (const d of [2.5, -2.5]) {
      const p = clone(proj);
      (li === 0 ? p.planes[0].rect.corners : p.planes[0].refs[0].points)[k][axis] += d;
      assert.equal(measure.measureProject(p).planes[WALL].calib.rectFrom, GARAGE);
    }
  }
  // Two rectangles on one straight-on wall. The reference must be clearly better (expected error down by a quarter
  // or more) to take over; a rectangle that is only somewhat larger does not.
  const wallWith = (refW, refH) => {
    const sq = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    return {
      settings: {}, images: [{ id: 'img', width: 2000, height: 1500, exif: { focal35: 26 } }],
      planes: [{
        id: 'pl_w', imageId: 'img', name: 'Front', kind: 'wall',
        rect: { corners: sq(300, 700, 200, 200), widthFt: 10, heightFt: 10, presetId: 'custom-rect' },
        refs: [{ id: 'r2', kind: 'rect', points: sq(1200, 700, refW * 20, refH * 20), widthFt: refW, heightFt: refH, presetId: 'custom-rect', quality: 'high' }],
        derived: null,
      }],
      features: [],
    };
  };
  const close = measure.measureProject(wallWith(11, 11)).planes.pl_w; // 10% larger each way
  assert.equal(close.calib.rectFrom, 'rect');
  assert.equal(close.calib.rectAuto, false);
  assert.equal(close.calib.rectCandidates.length, 2);
  assert.ok(close.calib.rectCandidates[1].expectedPct < close.calib.rectCandidates[0].expectedPct, 'the reference is a little better');
  assert.ok(close.calib.rectCandidates[1].expectedPct > 0.75 * close.calib.rectCandidates[0].expectedPct, 'but not by a quarter');
  assert.deepEqual(close.notes, []);
  const same = measure.measureProject(wallWith(10, 10)).planes.pl_w;
  assert.equal(same.calib.rectFrom, 'rect', 'equal rectangles: the wall\'s own stays');
  const clear = measure.measureProject(wallWith(20, 20)).planes.pl_w; // twice the size
  assert.equal(clear.calib.rectFrom, 'r2');
  assert.equal(clear.calib.rectWhy, 'largest');
  // A smaller reference never takes over, and a wall with no second rectangle reports its own.
  const small = measure.measureProject(wallWith(5, 5)).planes.pl_w;
  assert.equal(small.calib.rectFrom, 'rect');
  const alone = wallWith(5, 5);
  alone.planes[0].refs = [];
  const a = measure.measureProject(alone).planes.pl_w;
  assert.deepEqual([a.calib.rectFrom, a.calib.rectLabel, a.calib.rectAuto, a.calib.rectCandidates], ['rect', 'Rectangle (10′ 0″ × 10′ 0″)', false, null]);
  // No wall rectangle at all: the reference rectangle is used, as before, and reported.
  const promoted = wallWith(8, 7);
  promoted.planes[0].rect = null;
  const pr = measure.measureProject(promoted).planes.pl_w;
  assert.deepEqual([pr.calib.rectFrom, pr.calib.rectAuto], ['r2', false]);
  // No rectangle in use: nothing to report.
  const refsOnly = wallWith(8, 7);
  refsOnly.planes[0].rect = null;
  refsOnly.planes[0].refs = [{ id: 'l1', kind: 'line', points: [[300, 900], [300, 700]], lengthFt: 10, presetId: 'custom-line', quality: 'high' }];
  assert.equal(measure.measureProject(refsOnly).planes.pl_w.calib.rectFrom, null);
});

test('A: the sample house keeps every rating, score, reason and length', () => {
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-house-measured.json'), 'utf8'));
  const r = measure.measureProject(sample.createSample().project);
  assert.deepEqual(Object.keys(r.planes), Object.keys(pinned.planes));
  assert.deepEqual(Object.keys(r.features), Object.keys(pinned.features));
  const near = (a, b, what) => assert.ok(a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), what + ': ' + a + ' vs ' + b);
  for (const id of Object.keys(pinned.planes)) {
    const p = r.planes[id], q = pinned.planes[id];
    assert.deepEqual([p.mode, p.confidence.level, p.confidence.score, p.checks, p.confidence.reasons], [q.mode, q.level, q.score, q.checks, q.reasons], id);
    near(p.uncertaintyPct, q.uncertaintyPct, id + ' expected error');
    near(p.disagreementPct, q.disagreementPct, id + ' disagreement');
    assert.equal(p.calib.rectAuto, false, id + ': no rectangle was swapped');
    assert.ok(!p.steep && !p.slopeBelow);
  }
  for (const id of Object.keys(pinned.features)) {
    const f = r.features[id], q = pinned.features[id];
    assert.deepEqual([f.confidence.level, f.confidence.score, f.confidence.reasons], [q.level, q.score, q.reasons], id);
    near(f.measuredFt, q.measuredFt, id + ' measured');
    near(f.lengthFt, q.lengthFt, id + ' length');
    near(f.uncertaintyPct, q.uncertaintyPct, id + ' expected error');
  }
});

test('A: honesty with two rectangles: a front door as the wall rectangle plus a garage door reference', { timeout: 60000 }, (t) => {
  const rnd = g.rng(2026);
  const withRef = [], doorOnly = [];
  let chosen = 0, n = 0, tries = 0;
  while (n < 150 && tries++ < 5000) {
    const house = sim.randomHouse(rnd);
    if (!house || !house.px.garage) continue;
    n++;
    const sigma = [1.5, 2, 3][Math.floor(rnd() * 3)];
    const tapped = new Map(); // each point list is tapped once, so both projects share the same taps
    const noisy = (list) => {
      if (!tapped.has(list)) tapped.set(list, list.map((p) => [p[0] + sigma * sim.gaussian(rnd), p[1] + sigma * sim.gaussian(rnd)]));
      return tapped.get(list);
    };
    const proj = sim.buildProject(house, 'door-rect', noisy);
    const r0 = measure.measureProject(proj);
    proj.planes[0].refs.push({ id: 'r_garage', kind: 'rect', points: noisy(house.px.garage), widthFt: 16, heightFt: 7, presetId: 'garage-double', quality: 'high' });
    const r1 = measure.measureProject(proj);
    if (r1.planes.pl_w.calib.rectFrom === 'r_garage') chosen++;
    for (const f of proj.features) {
      for (const [res, rows] of [[r1, withRef], [r0, doorOnly]]) {
        const m = res.features[f.id];
        if (m && m.ok) rows.push({ level: m.confidence.level, err: (m.measuredFt - house.truth[f.id]) / house.truth[f.id] });
      }
    }
  }
  const high = sim.honesty(withRef, 'high', 0.03), medium = sim.honesty(withRef, 'medium', 0.06);
  const before = doorOnly.filter((x) => x.level !== 'low').length;
  t.diagnostic(`houses ${n}, garage door chosen in ${chosen}; with it: High ${high.n} (${pct(high.within)} within 3%), Medium ${medium.n} (${pct(medium.within)} within 6%); door alone: ${before} of ${doorOnly.length} not Low`);
  assert.equal(n, 150);
  assert.ok(chosen >= 0.95 * n, 'a 16 x 7 ft door beats a 3 x 6.7 ft door: ' + chosen);
  assert.ok(high.n + medium.n >= 50, 'the better rectangle earns ratings the door alone could not: ' + (high.n + medium.n));
  assert.ok(high.n + medium.n > before);
  assert.ok(high.n === 0 || high.within >= 0.95, 'High within ±3%: ' + pct(high.within));
  assert.ok(medium.within >= 0.95, 'Medium within ±6%: ' + pct(medium.within));
});

// ================================================================ B. steep roof face and upper roof
const ITEMS_STEEP = ['trim', 'cornerLeft', 'cornerRight', 'dormer'];
const ITEMS_UPPER = ['topEdge', 'upperHip'];

for (const deg of [60, 70, 80]) {
  test(`B: a ${deg}° mansard with exact taps: items on the steep face and the upper roof measure true`, () => {
    const h = man.mansardHouse({ deg });
    assert.ok(h, 'the house fits the photo');
    const proj = man.mansardProject(h);
    assert.deepEqual(schema.validateProject(schema.normalizeProject(proj)).errors, []);
    const r = measure.measureProject(deepFreeze(proj));
    const s = r.planes.pl_s, u = r.planes.pl_u;
    assert.equal(s.ok && s.mode, 'roof-3d');
    assert.equal(s.steep, true);
    assert.deepEqual([s.pitch.source, s.pitch.steep, Math.round(s.pitch.angleDeg * 1e6) / 1e6], ['user', true, deg]);
    assert.equal(s.parentPlaneId, 'pl_w');
    assert.equal(u.ok && u.mode, 'roof-3d');
    assert.equal(u.parentPlaneId, 'pl_s');
    assert.ok(!u.steep);
    assert.equal(u.slopeBelow, null, 'the face below is measured');
    assert.deepEqual([u.pitch.rise, u.pitch.run, u.pitch.source], [4, 12, 'user']);
    // The upper roof's frame starts on the trim line, behind and above the wall, and slopes back.
    assert.ok(Math.abs(u.frame.origin[1] - (h.Hw + h.up)) < 1e-6 && Math.abs(u.frame.origin[2] + h.back) < 1e-6, JSON.stringify(u.frame.origin));
    assert.ok(Math.abs(s.frame.e2[1] - Math.sin((deg * Math.PI) / 180)) < 1e-9 && s.frame.e2[2] < 0);
    for (const id of ITEMS_STEEP.concat(ITEMS_UPPER)) {
      const m = r.features[id];
      assert.ok(m.ok, id + ': ' + m.reason);
      assert.equal(m.method, 'roof-3d');
      assert.ok(Math.abs(m.measuredFt / h.truth[id] - 1) < 1e-6, id + ' ' + m.measuredFt + ' vs ' + h.truth[id]);
      // Whatever level is claimed is kept, trivially here; the claim itself must be a usable one on the steep face.
      if (ITEMS_STEEP.includes(id)) assert.notEqual(m.confidence.level, 'low', id + ': ' + m.confidence.reasons[0]);
      for (const why of m.confidence.reasons) noDashes(why);
    }
    // Nothing about the slope is flagged: it came from two tape numbers.
    assert.ok(!r.warnings.some((w) => /^steep-angle|^pitch-/.test(w.code)), JSON.stringify(r.warnings.map((w) => w.code)));
    assert.ok(!r.features.trim.confidence.reasons.some((x) => /slope is|a guess|assumed|pitch is|not measured/.test(x)));
  });

  test(`B: the same ${deg}° mansard items drawn on the wall come out short by what the geometry predicts`, () => {
    const h = man.mansardHouse({ deg });
    const r = measure.measureProject(man.mansardProject(h, { on: 'wall' }));
    // Seen from the camera, a point behind the wall lands on the wall plane where its sight line crosses it.
    const C = h.cam.C;
    const onWall = (X) => { const t = C[2] / (C[2] - X[2]); return [C[0] + t * (X[0] - C[0]), C[1] + t * (X[1] - C[1])]; };
    const lengthOnWall = (pts, closed) => {
      const q = pts.map(onWall);
      let L = 0;
      for (let i = 1; i < q.length; i++) L += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
      if (closed) L += Math.hypot(q[0][0] - q[q.length - 1][0], q[0][1] - q[q.length - 1][1]);
      return L;
    };
    for (const id of ITEMS_STEEP.concat(ITEMS_UPPER)) {
      const m = r.features[id];
      const predicted = lengthOnWall(h.S[id], id === 'dormer');
      assert.ok(Math.abs(m.measuredFt / predicted - 1) < 1e-6, id + ' ' + m.measuredFt + ' vs predicted ' + predicted);
      assert.ok(m.measuredFt < h.truth[id] * 0.995, id + ' is short on the wall: ' + pct(m.measuredFt / h.truth[id] - 1));
    }
    // A line parallel to the wall, `back` feet behind it, shrinks by D / (D + back).
    const D = h.D;
    assert.ok(Math.abs(r.features.trim.measuredFt / h.truth.trim - D / (D + h.back)) < 1e-6);
    assert.ok(Math.abs(r.features.topEdge.measuredFt / h.truth.topEdge - D / (D + h.back + h.run2)) < 1e-6);
    // The top edge is a ridge on a wall: rated Low, and flagged for the fix (C).
    assert.equal(r.features.topEdge.wrongSurface, 'roof');
    assert.equal(r.features.topEdge.confidence.level, 'low');
    assert.match(r.features.topEdge.confidence.reasons[0], /^A ridge measured on the wall comes out too short/);
  });
}

test('B: a guessed or assumed slope caps the rating at Low; two tape numbers do not', () => {
  const h = man.mansardHouse({ deg: 60 }); // the face really is 60°
  const guess = measure.measureProject(man.mansardProject(h, { steep: 'guess', guessDeg: 70 }));
  const dflt = measure.measureProject(man.mansardProject(h, { steep: 'default' }));
  const tape = measure.measureProject(man.mansardProject(h, { steep: 'tape' }));
  const GUESS = 'Lengths on a steep roof face depend on its slope, and 70° is only a guess. Measure how far the face goes up and how far it goes back.';
  const ASSUMED = 'Lengths on a steep roof face depend on its slope, and it is only assumed. Measure how far the face goes up and how far it goes back.';
  const BELOW = 'This roof starts at the top of a roof face whose slope is not measured, so it may sit in the wrong place. Measure how far that face goes up and how far it goes back.';
  for (const s of [GUESS, ASSUMED, BELOW]) noDashes(s);
  assert.deepEqual([guess.planes.pl_s.pitch.source, Math.round(guess.planes.pl_s.pitch.angleDeg)], ['guess', 70]);
  assert.deepEqual([dflt.planes.pl_s.pitch.source, Math.round(dflt.planes.pl_s.pitch.angleDeg)], ['default', 70]);
  assert.equal(measure.STEEP.defaultDeg, 70);
  for (const [r, why, src] of [[guess, GUESS, 'guess'], [dflt, ASSUMED, 'default']]) {
    assert.equal(r.planes.pl_s.confidence.level, 'low');
    assert.equal(r.planes.pl_s.confidence.reasons[0], why);
    assert.equal(r.planes.pl_u.slopeBelow, src);
    assert.equal(r.planes.pl_u.confidence.reasons[0], BELOW);
    for (const id of ITEMS_STEEP) {
      assert.equal(r.features[id].confidence.level, 'low', id);
      assert.equal(r.features[id].confidence.reasons[0], why, id);
    }
    for (const id of ITEMS_UPPER) {
      assert.equal(r.features[id].confidence.level, 'low', id);
      assert.equal(r.features[id].confidence.reasons[0], BELOW, id);
    }
    // And the cap is deserved: with 70° used for a true 60°, lines up the slope are well off, by what the two
    // slopes predict (the same rise seen at 70° is shorter along the slope than at 60°).
    const e = (id) => r.features[id].measuredFt / h.truth[id] - 1;
    assert.ok(e('dormer') < -0.05 && e('cornerLeft') < -0.05, 'up-slope items are short: ' + pct(e('dormer')) + ', ' + pct(e('cornerLeft')));
    assert.ok(Math.abs(e('trim')) > 0.02 && Math.abs(e('trim')) < 0.05, 'the trim line is off by a few percent: ' + pct(e('trim')));
  }
  assert.ok(guess.warnings.some((w) => w.code === 'steep-angle-guess' && w.level === 'info' && w.planeId === 'pl_s'));
  assert.ok(dflt.warnings.some((w) => w.code === 'steep-angle-assumed' && /so 70° is assumed/.test(w.message)));
  assert.ok(!dflt.warnings.some((w) => w.code === 'pitch-default'), 'the 6/12 message is for ordinary roofs');
  // Tape numbers: exact, and no slope reason anywhere.
  for (const id of ITEMS_STEEP.concat(ITEMS_UPPER)) {
    assert.ok(Math.abs(tape.features[id].measuredFt / h.truth[id] - 1) < 1e-6, id);
    assert.ok(!tape.features[id].confidence.reasons.some((x) => /slope is|only a guess|only assumed|not measured/.test(x)), id);
  }
  assert.equal(tape.features.trim.confidence.level, 'high');
  // A right guess measures right, and is still Low: nobody measured it.
  const right = measure.measureProject(man.mansardProject(h, { steep: 'guess', guessDeg: 60 }));
  assert.ok(Math.abs(right.features.dormer.measuredFt / h.truth.dormer - 1) < 1e-6);
  assert.equal(right.features.dormer.confidence.level, 'low');
  // scoreConfidence takes the new factors directly.
  const sc = measure.scoreConfidence({ mode: 'roof-3d', kind: 'roof', pitchSource: 'guess', steep: true, steepAngleDeg: 65 });
  assert.equal(sc.level, 'low');
  assert.match(sc.reasons[0], /and 65° is only a guess/);
  assert.equal(measure.scoreConfidence({ mode: 'roof-3d', kind: 'roof', pitchSource: 'user', slopeBelow: 'guess' }).reasons[0], BELOW);
  assert.match(measure.scoreConfidence({ mode: 'roof-3d', kind: 'roof', pitchSource: 'default' }).reasons[0], /^Roof lengths depend on the pitch/, 'ordinary roofs keep their own words');
});

test('B: a steep face never takes the project pitch or the gable estimate, and never feeds the house-wide estimate', () => {
  const h = man.mansardHouse({ deg: 70 });
  // The project says 4/12 (true of the upper roof); the steep face has only a guess.
  const proj = man.mansardProject(h, { steep: 'guess', guessDeg: 70, upperPitch: 'none' });
  proj.settings.roofPitch = { rise: 4, run: 12 };
  const r = measure.measureProject(proj);
  assert.deepEqual([r.planes.pl_s.pitch.source, Math.round(r.planes.pl_s.pitch.angleDeg)], ['guess', 70]);
  assert.deepEqual([r.planes.pl_u.pitch.rise, r.planes.pl_u.pitch.source], [4, 'house'], 'the upper roof borrows the project pitch as an assumption (review B1)');
  assert.ok(Math.abs(r.features.trim.measuredFt / h.truth.trim - 1) < 1e-6);

  // The leaning corner edges traced as rakes on the WALL look like a very steep gable. They start on the steep
  // face's eave, so they are not gables and no pitch is estimated from them.
  const corners = man.mansardProject(man.mansardHouse({ deg: 60 }), { upper: false });
  for (const f of corners.features) if (f.id === 'cornerLeft' || f.id === 'cornerRight') f.planeId = 'pl_w';
  corners.planes.push({ id: 'pl_r', imageId: 'img', name: 'Garage roof', kind: 'roof', rect: null, refs: [], derived: { parentPlaneId: 'pl_w', line: [[100, 300], [300, 300]], pitch: null } });
  const rc = measure.measureProject(corners);
  assert.equal(rc.pitch.source, 'default');
  assert.deepEqual(rc.pitch.samples, []);
  assert.equal(measure.estimatePitch(corners, rc.planes), null);
  assert.equal(rc.planes.pl_r.pitch.source, 'default', 'the ordinary roof is not given 18/12 from a mansard corner');
  // Without the steep face those same lines are read as gable rakes (as before): that is what was prevented.
  const noSteep = clone(corners);
  noSteep.planes = noSteep.planes.filter((p) => p.id !== 'pl_s');
  noSteep.features = noSteep.features.filter((f) => f.planeId === 'pl_w');
  assert.equal(measure.measureProject(noSteep).pitch.source, 'estimated');
  // Rakes drawn on the steep face itself never counted (they are not on a wall).
  const onFace = measure.measureProject(man.mansardProject(man.mansardHouse({ deg: 60 }), { upper: false }));
  assert.equal(onFace.pitch.source, 'default');
});

test('B: steepFromTape turns two tape numbers into the slope', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
  const a = measure.steepFromTape({ upFt: 8, backFt: 3 });
  assert.equal(a.ok, true);
  near(a.angleDeg, (Math.atan2(8, 3) * 180) / Math.PI);
  assert.deepEqual(a.pitch, { rise: 8, run: 3 });
  near(a.slopeFt, Math.hypot(8, 3));
  const b = measure.steepFromTape({ upFt: 8, slopeFt: Math.hypot(8, 3) });
  near(b.angleDeg, a.angleDeg); near(b.pitch.run, 3);
  const c = measure.steepFromTape({ backFt: 3, slopeFt: Math.hypot(8, 3) });
  near(c.angleDeg, a.angleDeg); near(c.pitch.rise, 8);
  assert.equal(measure.steepFromTape({ upFt: 8, backFt: 3, slopeFt: 8.5 }).ok, true, 'three numbers that agree');
  // The result drives a steep face exactly.
  const h = man.mansardHouse({ deg: 70 });
  const proj = man.mansardProject(h, { steep: 'default' });
  proj.planes[1].derived.pitch = measure.steepFromTape({ upFt: h.up, slopeFt: h.slope }).pitch;
  const r = measure.measureProject(proj);
  assert.equal(r.planes.pl_s.pitch.source, 'user');
  assert.ok(Math.abs(r.features.dormer.measuredFt / h.truth.dormer - 1) < 1e-6);
  // Problems are said in plain words and nothing throws.
  const bad = [
    [{ upFt: 8 }, /^Enter two of these/], [{}, /^Enter two of these/], [null, /^Enter two of these/],
    [{ upFt: 8, slopeFt: 7 }, /sloped height must be longer than how far the face goes up/],
    [{ backFt: 8, slopeFt: 8 }, /sloped height must be longer than how far the face goes back/],
    [{ upFt: 8, backFt: 3, slopeFt: 12 }, /do not fit together/],
    [{ upFt: 10, backFt: 0.5 }, /almost straight up \(more than 85°\)\. Measure it as a wall\./],
    [{ upFt: 'x', backFt: -2, slopeFt: NaN }, /^Enter two of these/],
  ];
  for (const [input, re] of bad) {
    const out = measure.steepFromTape(input);
    assert.equal(out.ok, false);
    assert.match(out.reason, re);
    noDashes(out.reason);
  }
  assert.deepEqual(measure.STEEP, { defaultDeg: 70, minDeg: 20, maxDeg: 85 });
});

test('B: limits and bad data: angles are kept inside 20..85°, broken parents give a plain reason, nothing throws', () => {
  const h = man.mansardHouse({ deg: 70 });
  const solve = (edit) => { const p = man.mansardProject(h); edit(p); return measure.measureProject(deepFreeze(p)); };
  const steepOf = (p) => p.planes[1].derived;
  // Guesses outside the range are clamped; nonsense falls back to 70.
  assert.equal(Math.round(solve((p) => { steepOf(p).pitch = null; steepOf(p).angleDeg = 89.5; }).planes.pl_s.pitch.angleDeg), 85);
  assert.equal(Math.round(solve((p) => { steepOf(p).pitch = null; steepOf(p).angleDeg = 5; }).planes.pl_s.pitch.angleDeg), 20);
  for (const v of ['70', NaN, Infinity, null, {}]) {
    const s = solve((p) => { steepOf(p).pitch = null; steepOf(p).angleDeg = v; }).planes.pl_s;
    assert.deepEqual([s.ok, s.pitch.source, Math.round(s.pitch.angleDeg)], [true, 'default', 70], String(v));
  }
  // A measured slope steeper than 85° is measured as 85° and says so.
  const wallLike = solve((p) => { steepOf(p).pitch = { rise: 10, run: 0.1 }; }).planes.pl_s;
  assert.deepEqual([wallLike.ok, Math.round(wallLike.pitch.angleDeg), wallLike.pitch.source], [true, 85, 'user']);
  assert.match(wallLike.notes.join(' '), /almost straight up\. It is measured as an 85° face\./);
  // steep must be exactly true: anything else is an ordinary roof.
  assert.ok(!solve((p) => { steepOf(p).steep = 'yes'; }).planes.pl_s.steep);
  // An upper roof whose face below failed, or is gone, or is itself: a reason, never a throw.
  const gone = solve((p) => { p.planes[2].derived.parentPlaneId = 'nope'; }).planes.pl_u;
  assert.deepEqual([gone.ok, gone.issues[0].code], [false, 'derived-no-parent']);
  const self = solve((p) => { p.planes[2].derived.parentPlaneId = 'pl_u'; }).planes.pl_u;
  assert.equal(self.ok, false);
  const loop = solve((p) => { p.planes[1].derived.parentPlaneId = 'pl_u'; });
  assert.deepEqual([loop.planes.pl_s.ok, loop.planes.pl_u.ok], [false, false]);
  assert.match(loop.planes.pl_u.reason, /is attached to a surface that is attached back to it/);
  for (const id of ITEMS_STEEP.concat(ITEMS_UPPER)) assert.equal(loop.features[id].ok, false);
  const noLine = solve((p) => { p.planes[1].derived.line = null; });
  assert.equal(noLine.planes.pl_s.ok, false);
  assert.match(noLine.planes.pl_u.reason, /^Measure 'Steep face' first: /);
  // A ground plane cannot hang off a roof.
  const ground = solve((p) => { p.planes.push({ id: 'pl_g', imageId: 'img', name: 'Deck', kind: 'ground', rect: null, refs: [], derived: { parentPlaneId: 'pl_s', line: h.px.trim, pitch: null } }); }).planes.pl_g;
  assert.deepEqual([ground.ok, ground.reason], [false, "'Deck' needs a wall base line drawn on a wall."]);
  // No perspective rectangle on the wall: the steep face is approximated (Low), and an upper roof needs more.
  const ortho = solve((p) => {
    p.planes[0].rect = null;
    p.planes[0].refs = [{ id: 'r', kind: 'line', points: [h.px.door[3], h.px.door[0]], lengthFt: man.DOOR_H, presetId: 'door-height', quality: 'high' }];
  });
  assert.equal(ortho.planes.pl_s.mode, 'roof-ortho');
  assert.equal(ortho.planes.pl_s.steep, true);
  assert.equal(ortho.features.trim.confidence.level, 'low');
  assert.equal(ortho.planes.pl_u.ok, false);
  assert.equal(ortho.planes.pl_u.reason, "'Upper roof' sits on 'Steep face', which is only approximated. Add a perspective rectangle on the wall below so both can be measured.");
  // The upper roof can come before its steep face in the list.
  const reordered = solve((p) => { p.planes.push(p.planes.splice(1, 1)[0]); });
  assert.ok(Math.abs(reordered.features.topEdge.measuredFt / h.truth.topEdge - 1) < 1e-6);
  // The rest of the app still works on a mansard project (cord routing, shopping list).
  assert.doesNotThrow(() => plan.computePlan(man.mansardProject(h)));
  // Garbage in every new field.
  for (const junk of [null, 5, 'x', [], { steep: true, angleDeg: {}, pitch: 'x', line: 'x', parentPlaneId: {} }]) {
    const r = solve((p) => { p.planes[1].derived = junk; });
    assert.equal(r.ok, true);
    assert.equal(r.planes.pl_s.ok, false);
  }
});

test('B: the tap-precision estimate reaches through a steep face to its upper roof', () => {
  const h = man.mansardHouse({ deg: 70 });
  const base = measure.measureProject(man.mansardProject(h));
  assert.ok(base.planes.pl_u.uncertaintyPct > base.planes.pl_s.uncertaintyPct, 'errors add up on the way up');
  // Coarser taps anywhere below make the upper roof worse: the wall's rectangle (two levels down), the steep
  // face's eave line (one level down; it matters little, it only sets where the face starts) and its own line.
  const withTapErr = (edit) => { const p = man.mansardProject(h); edit(p); return measure.measureProject(p); };
  const rectCoarse = withTapErr((p) => { p.planes[0].rect.tapErr = [10, 10, 10, 10]; });
  assert.ok(rectCoarse.planes.pl_u.uncertaintyPct > 2 * base.planes.pl_u.uncertaintyPct, rectCoarse.planes.pl_u.uncertaintyPct + ' vs ' + base.planes.pl_u.uncertaintyPct);
  assert.ok(rectCoarse.planes.pl_s.uncertaintyPct > 2 * base.planes.pl_s.uncertaintyPct);
  const eaveCoarse = withTapErr((p) => { p.planes[1].derived.tapErr = [12, 12]; });
  assert.ok(eaveCoarse.planes.pl_u.uncertaintyPct > base.planes.pl_u.uncertaintyPct);
  assert.ok(eaveCoarse.features.topEdge.uncertaintyPct > base.features.topEdge.uncertaintyPct);
  assert.ok(eaveCoarse.planes.pl_s.uncertaintyPct > base.planes.pl_s.uncertaintyPct);
  const trimCoarse = withTapErr((p) => { p.planes[2].derived.tapErr = [12, 12]; });
  assert.ok(trimCoarse.planes.pl_u.uncertaintyPct > base.planes.pl_u.uncertaintyPct, trimCoarse.planes.pl_u.uncertaintyPct + ' vs ' + base.planes.pl_u.uncertaintyPct);
  assert.equal(trimCoarse.planes.pl_s.uncertaintyPct, base.planes.pl_s.uncertaintyPct, 'the upper roof\'s line does not move the face below');
  assert.equal(eaveCoarse.planes.pl_u.tapsRecorded, false);
  const recorded = man.mansardProject(h);
  recorded.planes[0].rect.tapErr = [2.5, 2.5, 2.5, 2.5];
  recorded.planes[1].derived.tapErr = [2.5, 2.5];
  recorded.planes[2].derived.tapErr = [2.5, 2.5];
  assert.equal(measure.measureProject(recorded).planes.pl_u.tapsRecorded, true);
  delete recorded.planes[0].rect.tapErr;
  assert.equal(measure.measureProject(recorded).planes.pl_u.tapsRecorded, false, 'the wall two levels down counts');
});

test('B: honesty with tap noise on mansard houses: High within ±3%, Medium within ±6%, steep faces and upper roofs included', { timeout: 60000 }, (t) => {
  const variants = [
    { name: 'facade-tape', rect: 'facade', steep: 'tape' }, { name: 'garage-tape', rect: 'garage', steep: 'tape' },
    { name: 'door-tape', rect: 'door', steep: 'tape' }, { name: 'facade-guess', rect: 'facade', steep: 'guess' },
    { name: 'facade-wrong-guess', rect: 'facade', steep: 'guess', guessDeg: 70 }, { name: 'facade-default', rect: 'facade', steep: 'default' },
  ];
  const rows = man.simulateMansard({ houses: 200, seed: 2026, sigmas: [1.5, 2, 3], variants });
  const high = sim.honesty(rows, 'high', 0.03), medium = sim.honesty(rows, 'medium', 0.06);
  t.diagnostic(`rows ${rows.length}: High ${high.n} (${pct(high.within)} within 3%), Medium ${medium.n} (${pct(medium.within)} within 6%), Low ${rows.filter((r) => r.level === 'low').length}`);
  const by = {};
  for (const r of rows) {
    const b = by[r.variant + '/' + r.feature] || (by[r.variant + '/' + r.feature] = { high: 0, medium: 0, low: 0, errs: [] });
    b[r.level]++;
    b.errs.push(Math.abs(r.err));
  }
  for (const k of Object.keys(by).sort()) {
    const b = by[k];
    b.errs.sort((x, y) => x - y);
    t.diagnostic(`${k.padEnd(32)} H/M/L ${b.high}/${b.medium}/${b.low}  median ${pct(b.errs[b.errs.length >> 1])}  p90 ${pct(b.errs[Math.floor(b.errs.length * 0.9)])}`);
  }
  assert.ok(high.n >= 100, 'enough High results to judge: ' + high.n);
  assert.ok(high.within >= 0.95, 'High within ±3%: ' + pct(high.within));
  assert.ok(medium.n >= 300, 'enough Medium results to judge: ' + medium.n);
  assert.ok(medium.within >= 0.95, 'Medium within ±6%: ' + pct(medium.within));
  for (const deg of [60, 70, 80]) {
    const sel = rows.filter((r) => r.deg === deg && r.plane === 'steep');
    const hi = sim.honesty(sel, 'high', 0.03), me = sim.honesty(sel, 'medium', 0.06);
    t.diagnostic(`steep face at ${deg}°: High ${hi.n} (${pct(hi.within)}), Medium ${me.n} (${pct(me.within)})`);
    assert.ok(hi.n >= 15 && hi.within >= 0.95, deg + '° High: ' + hi.n + ', ' + pct(hi.within));
    assert.ok(me.n >= 50 && me.within >= 0.95, deg + '° Medium: ' + me.n + ', ' + pct(me.within));
  }
  // A slope nobody measured is never better than Low, right or wrong; and wrong guesses really are off.
  for (const v of ['facade-guess', 'facade-wrong-guess', 'facade-default']) {
    assert.equal(rows.filter((r) => r.variant === v && r.level !== 'low').length, 0, v);
  }
  const wrong = rows.filter((r) => r.variant === 'facade-wrong-guess' && r.deg === 60 && r.feature === 'dormer').map((r) => Math.abs(r.err)).sort((a, b) => a - b);
  assert.ok(wrong.length >= 20 && wrong[wrong.length >> 1] > 0.05, '70° used for a true 60° throws the dormer off: median ' + pct(wrong[wrong.length >> 1]));
  // The shallow upper roof is seen almost edge-on from the street: never High.
  assert.equal(rows.filter((r) => r.plane === 'upper' && r.level === 'high').length, 0);
  // Useful, not only honest: with a tape-measured facade and slope, most trim lines rate High or Medium.
  const trim = rows.filter((r) => r.variant === 'facade-tape' && r.feature === 'trim');
  assert.ok(trim.filter((r) => r.level !== 'low').length >= 0.8 * trim.length);
});

// ================================================================ C. items on the wrong kind of surface
test('C: the ridge drawn on the wall of the mansard house is reported with the fix, and existing roof surfaces are offered', () => {
  const proj = fixture();
  const frozen = JSON.stringify(proj);
  const res = measure.measureProject(proj);
  assert.equal(res.features[RIDGE].wrongSurface, 'roof');
  assert.equal(res.features[RIDGE].confidence.level, 'low');
  assert.match(res.features[RIDGE].confidence.reasons[0], /^A ridge measured on the wall comes out too short .* Draw it on a roof plane\.$/);
  const list = measure.misplacedFeatures(proj, res);
  assert.equal(list.length, 1);
  const it = list[0];
  assert.deepEqual([it.featureId, it.type, it.label, it.planeId, it.wants, it.canCreate], [RIDGE, 'ridge', 'Ridge 1', WALL, 'roof', true]);
  assert.deepEqual(it.candidates, [], 'no roof surface yet: draw an eave line on this wall first');
  assert.ok(Math.abs(it.lengthFt - res.features[RIDGE].measuredFt) < 1e-9);
  assert.equal(it.message, 'A ridge sits on the roof, behind the wall. Measured on the wall it comes out too short. Move it to a roof surface, or type a tape-measured length.');
  noDashes(it.message);
  assert.deepEqual(measure.misplacedFeatures(proj), list, 'works without a measured result too');
  assert.equal(JSON.stringify(proj), frozen);

  // Add a steep face on the eave and an upper roof on its trim line (taps read off the same photo).
  const withRoofs = clone(proj);
  withRoofs.planes.push(
    { id: 'pl_steep', imageId: proj.images[0].id, name: 'Steep roof', kind: 'roof', color: '#ff8a3d', rect: null, refs: [], derived: { parentPlaneId: WALL, line: [[420, 470], [1300, 472]], pitch: null, steep: true, angleDeg: 70 } },
    { id: 'pl_upper', imageId: proj.images[0].id, name: 'Top roof', kind: 'roof', color: '#ff8a3d', rect: null, refs: [], derived: { parentPlaneId: 'pl_steep', line: [[440, 300], [1280, 304]], pitch: null } },
    { id: 'pl_other', imageId: proj.images[0].id, name: 'Other wall', kind: 'wall', color: '#4f9dff', rect: null, refs: [], derived: null },
    { id: 'pl_yard', imageId: proj.images[0].id, name: 'Yard', kind: 'ground', color: '#4cc38a', rect: null, refs: [], derived: { parentPlaneId: WALL, line: [[420, 720], [1300, 722]], pitch: null } },
  );
  const m2 = measure.measureProject(withRoofs);
  assert.equal(m2.planes.pl_steep.ok && m2.planes.pl_upper.ok, true, m2.planes.pl_steep.reason || m2.planes.pl_upper.reason);
  assert.deepEqual([m2.planes.pl_upper.pitch.rise, m2.planes.pl_upper.pitch.source], [4, 'house'], 'the project pitch (4/12) is only borrowed by the upper roof (review B1)');
  const c = measure.misplacedFeatures(withRoofs, m2)[0].candidates;
  // Ordinary roof first, then the steep face; the yard and the other wall are not roof surfaces.
  assert.deepEqual(c.map((x) => [x.planeId, x.name, x.kind, x.steep, x.parentPlaneId]), [['pl_upper', 'Top roof', 'roof', false, 'pl_steep'], ['pl_steep', 'Steep roof', 'roof', true, WALL]]);
  assert.equal(c[1].ok, true);
  assert.ok(c[1].lengthFt > res.features[RIDGE].measuredFt, 'on the roof the ridge is longer than on the wall');
  // Moving it is only a change of planeId, and the result is what the candidate promised.
  const moved = clone(withRoofs);
  moved.features[0].planeId = 'pl_steep';
  const m3 = measure.measureProject(moved);
  assert.ok(Math.abs(m3.features[RIDGE].measuredFt - c[1].lengthFt) < 1e-9);
  assert.equal(m3.features[RIDGE].wrongSurface, null);
  assert.deepEqual(measure.misplacedFeatures(moved, m3), []);
  // The other fix: a tape-measured length.
  const taped = clone(proj);
  taped.features[0].overrideFt = 46;
  assert.deepEqual(measure.misplacedFeatures(taped), []);
  assert.equal(measure.measureProject(taped).features[RIDGE].confidence.level, 'high');
});

test('C: trees and columns on a wall want a ground surface; items in the right place are not listed; bad data never throws', () => {
  const s = sample.createSample().project;
  assert.deepEqual(measure.misplacedFeatures(s), [], 'the sample house has nothing misplaced');
  const wall = s.planes.find((p) => p.kind === 'wall');
  const ground = s.planes.find((p) => p.kind === 'ground' && p.derived.parentPlaneId === wall.id);
  const roof = s.planes.find((p) => p.kind === 'roof' && p.derived.parentPlaneId === wall.id);
  assert.ok(ground && roof);
  const p = clone(s);
  const tree = p.features.find((f) => f.type === 'tree'), ridge = p.features.find((f) => f.type === 'ridge');
  const bush = p.features.find((f) => f.type === 'bush');
  assert.ok(tree && ridge && bush);
  const column = Object.assign(clone(tree), { id: 'ft_column', type: 'column', label: 'Porch post' });
  p.features.push(column);
  tree.planeId = wall.id; column.planeId = wall.id; ridge.planeId = wall.id;
  assert.equal(bush.planeId, wall.id, 'the sample bushes are traced on the wall');
  const res = measure.measureProject(p);
  const list = measure.misplacedFeatures(p, res);
  // A bush sits against the wall and is fine there (it is only capped at Medium), so it is not listed.
  assert.deepEqual(list.map((x) => [x.featureId, x.wants]).sort(), [[column.id, 'ground'], [ridge.id, 'roof'], [tree.id, 'ground']].sort());
  assert.equal(res.features[bush.id].wrongSurface, null);
  for (const it of list) {
    const want = it.wants === 'roof' ? roof.id : ground.id;
    assert.deepEqual(it.candidates.map((c) => c.planeId), [want], it.featureId);
    assert.equal(it.candidates[0].steep, false);
    assert.equal(res.features[it.featureId].wrongSurface, it.wants);
    noDashes(it.message);
  }
  assert.equal(list.find((x) => x.wants === 'ground').message, 'This item stands in front of the wall. Measured on the wall it comes out too large. Move it to a ground surface, or type a tape-measured height.');
  // A candidate the item cannot be measured on (its points are above that surface's horizon) is listed last, not ok.
  const tr = list.find((x) => x.featureId === tree.id).candidates[0];
  assert.equal(typeof tr.ok, 'boolean');
  assert.equal(tr.lengthFt === null, !tr.ok);
  // A tape-measured height is the other fix.
  tree.overrideFt = 14;
  assert.ok(!measure.misplacedFeatures(p).some((x) => x.featureId === tree.id));
  assert.ok(measure.misplacedFeatures(p).some((x) => x.featureId === column.id));
  for (const junk of [null, undefined, 5, 'x', [], {}, { features: [null, 5, { type: 'ridge' }, { type: 'ridge', planeId: 'nope' }], planes: [null, { id: 'a' }, { id: 'b', kind: 'roof', derived: { parentPlaneId: 'b' } }] }]) {
    assert.deepEqual(measure.misplacedFeatures(junk), []);
    assert.deepEqual(measure.misplacedFeatures(junk, { planes: 3 }), []);
  }
  // A ridge on a wall with no scale yet is still on the wrong surface.
  const blank = { planes: [{ id: 'w', kind: 'wall' }], features: [{ id: 'f', type: 'ridge', planeId: 'w', points: [[0, 0], [10, 0]] }] };
  const b = measure.misplacedFeatures(blank);
  assert.deepEqual([b.length, b[0].featureId, b[0].lengthFt, b[0].candidates.length], [1, 'f', null, 0]);
});
