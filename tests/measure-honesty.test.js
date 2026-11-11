// Seeded Monte Carlo regression for the honesty of the confidence levels (review finding M1).
// Random houses (28–60 ft facades, 9–18 ft walls) are photographed by a 26 mm-equivalent camera from 0–35° off
// straight-on with the facade filling 30–90% of the frame; every tap gets N(0, σ²) pixel noise with σ ∈ {1.5, 2, 3}.
// Setups cover tape-measured house corners, a garage-door rectangle, a front-door rectangle, house corners of
// unknown size with door references (EXIF or measured focal), refs-only walls, and roof/ground planes built from
// the wall. The promise in docs/TEST_SCRIPT.md: High within ±3%, Medium within ±6%.
//
// Finger taps (SPEC §8.4, review findings UX-01 and UX-02). On a 390 px phone with the photo fitted to the screen
// one screen pixel is about 5 photo pixels, so a finger is good to 10–20 photo px, not 2.5. The app stores that
// beside every tapped point list (tapErr) and measure rates the result with it. The same promise is held for:
//   - everything tapped at fit zoom (σ ∈ {10, 13, 16, 20} px, tapErr to match);
//   - a mix of zoom levels (calibration and items each tapped at σ ∈ {2, 4, 8, 16} px, tapErr to match);
//   - the UX-01 scene: a garage-door rectangle of about 400 × 175 photo px tapped with a 16 px finger.
// Each has a control run of the same taps with no tapErr stored, which shows what the tap precision is for.
const test = require('node:test');
const assert = require('node:assert/strict');
const sim = require('./sim-houses');

const pct = (x) => (x == null ? 'none' : (100 * x).toFixed(1) + '%');
/** The bar every case is held to: of the results rated High, ≥ 95% within ±3%; of those rated Medium, ≥ 95% within ±6%. */
const HONEST_SHARE = 0.95;
function levels(rows) {
  return {
    high: sim.honesty(rows, 'high', 0.03), medium: sim.honesty(rows, 'medium', 0.06),
    low: rows.filter((r) => r.level === 'low').length, n: rows.length,
  };
}
const describeLevels = (name, lv) => `${name}: rows ${lv.n}: High ${lv.high.n} (${pct(lv.high.within)} within 3%), Medium ${lv.medium.n} (${pct(lv.medium.within)} within 6%), Low ${lv.low}`;
/** A level nobody was given cannot be dishonest; one that was given must keep its promise. */
function assertHonestLevels(name, lv) {
  assert.ok(lv.high.n === 0 || lv.high.within >= HONEST_SHARE, name + ': High within ±3%: ' + pct(lv.high.within) + ' of ' + lv.high.n);
  assert.ok(lv.medium.n === 0 || lv.medium.within >= HONEST_SHARE, name + ': Medium within ±6%: ' + pct(lv.medium.within) + ' of ' + lv.medium.n);
}
const median = (list) => { const s = list.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };

test('confidence levels are honest: ≥ 95% of High within ±3% and ≥ 95% of Medium within ±6%', { timeout: 60000 }, (t) => {
  const rows = sim.simulate({ houses: 250, seed: 2026, sigmas: [1.5, 2, 3] });
  const high = sim.honesty(rows, 'high', 0.03);
  const medium = sim.honesty(rows, 'medium', 0.06);
  const low = rows.filter((r) => r.level === 'low').length;
  t.diagnostic(`rows ${rows.length}: High ${high.n} (${pct(high.within)} within 3%), Medium ${medium.n} (${pct(medium.within)} within 6%), Low ${low}`);
  const bySetup = {};
  for (const r of rows) {
    const k = r.setup + '/' + r.feature;
    const b = bySetup[k] || (bySetup[k] = { high: 0, medium: 0, low: 0, errs: [] });
    b[r.level]++;
    b.errs.push(Math.abs(r.err));
  }
  for (const k of Object.keys(bySetup).sort()) {
    const b = bySetup[k];
    b.errs.sort((x, y) => x - y);
    t.diagnostic(`${k.padEnd(30)} H/M/L ${b.high}/${b.medium}/${b.low}  median ${pct(b.errs[b.errs.length >> 1])}  p90 ${pct(b.errs[Math.floor(b.errs.length * 0.9)])}`);
  }
  assert.ok(high.n >= 50, 'enough High results to judge: ' + high.n);
  assert.ok(high.within >= 0.95, 'High within ±3%: ' + pct(high.within));
  assert.ok(medium.n >= 300, 'enough Medium results to judge: ' + medium.n);
  assert.ok(medium.within >= 0.95, 'Medium within ±6%: ' + pct(medium.within));
  // 3D lengths from a wall-derived pose are far too sensitive to tap error for High.
  assert.equal(rows.filter((r) => r.planeKind !== 'wall' && r.level === 'high').length, 0, 'no High on roof/ground planes');
  // Walls without a rectangle cannot see foreshortening.
  assert.equal(rows.filter((r) => r.setup === 'refs-only' && r.level === 'high').length, 0, 'no High on refs-only walls');
  // Honest is not the same as useless: a tape-measured facade still rates most in-wall items High or Medium.
  const fk = rows.filter((r) => r.setup === 'facade-known' && r.planeKind === 'wall');
  const fkUseful = fk.filter((r) => r.level !== 'low').length / fk.length;
  t.diagnostic('facade-known wall items rated High or Medium: ' + pct(fkUseful));
  assert.ok(fkUseful >= 0.6, 'facade-known wall items High/Medium: ' + pct(fkUseful));
});

test('finger taps at fit zoom (10–20 px, stored as tapErr) are held to the same bar: High within ±3%, Medium within ±6%', { timeout: 60000 }, (t) => {
  const finger = { houses: 250, seed: 2026, sigmas: [10, 13, 16, 20] };
  const rows = sim.simulate(Object.assign({ tapErr: true }, finger));
  const lv = levels(rows);
  t.diagnostic(describeLevels('finger at fit zoom, tapErr stored', lv));
  const bySetup = {};
  for (const r of rows) {
    const k = r.setup + '/' + r.feature;
    const b = bySetup[k] || (bySetup[k] = { high: 0, medium: 0, low: 0, errs: [] });
    b[r.level]++;
    b.errs.push(Math.abs(r.err));
  }
  for (const k of Object.keys(bySetup).sort()) {
    const b = bySetup[k];
    t.diagnostic(`${k.padEnd(30)} H/M/L ${b.high}/${b.medium}/${b.low}  median ${pct(median(b.errs))}`);
  }
  assert.ok(lv.n >= 5000, 'enough results to judge: ' + lv.n);
  assertHonestLevels('finger at fit zoom', lv);
  // Honest here mostly means Low: the median wall item is about 10% off, so hardly anything can promise ±6%.
  t.diagnostic('rated Low: ' + pct(lv.low / lv.n) + '; median error of all results ' + pct(median(rows.map((r) => Math.abs(r.err)))));
  assert.ok(median(rows.map((r) => Math.abs(r.err))) > 0.06, 'precondition: taps this coarse really do throw the lengths off');
  // What limits the rating is said in plain words: where nothing else makes an item rough (tape-measured house
  // corners, an item on the wall), the first reason is to zoom in and re-tap.
  const fk = rows.filter((r) => r.setup === 'facade-known' && r.planeKind === 'wall' && r.level !== 'high');
  const told = fk.filter((r) => /^Tapped zoomed out \(about ±(10|13|16|20) px on the photo\): zoom in and re-tap /.test(r.reasons[0])).length;
  t.diagnostic('tape-measured facade, wall items not rated High: ' + fk.length + ', told to zoom in and re-tap: ' + pct(told / fk.length));
  assert.ok(told / fk.length >= 0.95, 'told to zoom in: ' + pct(told / fk.length));

  // Control: the very same taps with no tap precision stored are rated as if they were good to 2.5 px. This is
  // the failure the review measured (UX-02), and the reason tapErr exists.
  const blind = levels(sim.simulate(Object.assign({}, finger, { houses: 100 })));
  t.diagnostic(describeLevels('control, same kind of taps with no tapErr', blind));
  assert.ok(blind.high.n + blind.medium.n >= 300, 'the control rates many results High or Medium: ' + (blind.high.n + blind.medium.n));
  assert.ok(blind.high.within < 0.6 && blind.medium.within < 0.6, 'and most of those are wrong: ' + pct(blind.high.within) + ', ' + pct(blind.medium.within));
});

test('a mix of zoom levels (2–16 px taps, stored as tapErr) is held to the same bar and still gives High and Medium', { timeout: 60000 }, (t) => {
  // Per house the calibration and the traced items each get their own precision: zoomed in (2 px), the loupe or a
  // mouse (4 px), half zoomed (8 px) or a finger at fit zoom (16 px).
  const rows = sim.simulate({ houses: 300, seed: 2026, sigmas: [2, 4, 8, 16], featureSigmas: [2, 4, 8, 16], tapErr: true });
  const lv = levels(rows);
  t.diagnostic(describeLevels('mixed zoom, tapErr stored', lv));
  for (const cs of [2, 4, 8, 16]) {
    for (const fs of [2, 4, 8, 16]) {
      const cell = levels(rows.filter((r) => r.sigma === cs && r.featureSigma === fs));
      t.diagnostic(`calibration ${String(cs).padStart(2)} px, items ${String(fs).padStart(2)} px: High ${cell.high.n} (${pct(cell.high.within)}), Medium ${cell.medium.n} (${pct(cell.medium.within)}), Low ${cell.low}`);
    }
  }
  assert.ok(lv.high.n >= 15, 'enough High results to judge: ' + lv.high.n);
  assert.ok(lv.medium.n >= 250, 'enough Medium results to judge: ' + lv.medium.n);
  assertHonestLevels('mixed zoom', lv);
  // Coarse calibration taps alone, and coarse item taps alone, are each caught.
  assertHonestLevels('calibration at fit zoom, items zoomed in', levels(rows.filter((r) => r.sigma === 16 && r.featureSigma === 2)));
  assertHonestLevels('calibration zoomed in, items at fit zoom', levels(rows.filter((r) => r.sigma === 2 && r.featureSigma === 16)));
  // Careful taps recorded as careful lose nothing: 2 px is stored as 2.5, which is what measure assumes anyway.
  const careful = levels(rows.filter((r) => r.sigma === 2 && r.featureSigma === 2));
  assert.ok(careful.high.n + careful.medium.n >= 0.2 * careful.n, 'zoomed-in taps still earn High or Medium: ' + (careful.high.n + careful.medium.n) + ' of ' + careful.n);
  assert.equal(rows.filter((r) => r.planeKind !== 'wall' && r.level === 'high').length, 0, 'no High on roof/ground planes');
});

test('UX-01: a small rectangle (a garage door about 400 × 175 px) tapped with a 16 px finger never rates the eave Medium or High', { timeout: 60000 }, (t) => {
  const scene = sim.garageDoorScene();
  t.diagnostic(`garage door ${scene.doorPx.w.toFixed(0)} x ${scene.doorPx.h.toFixed(0)} px in a ${sim.IMG_W} px wide photo; eave ${scene.eaveFt} ft`);
  assert.ok(scene.doorPx.w > 380 && scene.doorPx.w < 420 && scene.doorPx.h > 160 && scene.doorPx.h < 190, 'the scene is the reviewed one');
  const rows = sim.simulateGarageDoor({ trials: 300, seed: 2026, sigma: 16 });
  assert.equal(rows.length, 300);
  const count = (list, key) => list.reduce((c, r) => { c[r[key]] = (c[r[key]] || 0) + 1; return c; }, { high: 0, medium: 0, low: 0 });
  const eave = count(rows, 'level'), wall = count(rows, 'planeLevel');
  const errs = rows.map((r) => Math.abs(r.err));
  t.diagnostic(`tapErr stored: eave High/Medium/Low ${eave.high}/${eave.medium}/${eave.low}, wall pill ${wall.high}/${wall.medium}/${wall.low}; eave error median ${pct(median(errs))}, within 6% in ${pct(errs.filter((e) => e <= 0.06).length / errs.length)} of trials`);
  // The eave is off by a fifth in the median trial; nothing about it may read Medium or High.
  assert.ok(median(errs) > 0.15, 'precondition: the eave is badly off in the typical trial: ' + pct(median(errs)));
  assert.equal(eave.high + eave.medium, 0, 'no eave rated Medium or High');
  assert.equal(wall.high + wall.medium, 0, 'the wall pill is not Medium or High either');
  const why = /^Tapped zoomed out \(about ±16 px on the photo\): zoom in and re-tap the corners of the rectangle\./;
  for (const r of rows) {
    assert.match(r.reasons[0], why);
    assert.match(r.planeReasons[0], why);
  }
  // Control: the same taps with no tap precision stored. This is what the review saw on screen.
  const blind = sim.simulateGarageDoor({ trials: 300, seed: 2026, sigma: 16, tapErr: false });
  const bEave = count(blind, 'level'), bWall = count(blind, 'planeLevel');
  const wrong = blind.filter((r) => r.level !== 'low' && Math.abs(r.err) > 0.06).length;
  t.diagnostic(`control, no tapErr: eave High/Medium/Low ${bEave.high}/${bEave.medium}/${bEave.low} (${wrong} of the ${bEave.high + bEave.medium} not Low are more than 6% off), wall pill ${bWall.high}/${bWall.medium}/${bWall.low}`);
  assert.ok(bEave.high + bEave.medium >= 30 && wrong >= 0.9 * (bEave.high + bEave.medium), 'the control reproduces the dishonest Medium');
  assert.equal(bWall.low, 0, 'and its wall pill is never Low');
  // Zoomed in (2 px taps, stored as 2.5) the same door gives an eave within a few percent, and it is not blamed on zoom.
  const zoomed = sim.simulateGarageDoor({ trials: 300, seed: 2026, sigma: 2 });
  const zErrs = zoomed.map((r) => Math.abs(r.err));
  const zLv = { high: sim.honesty(zoomed, 'high', 0.03), medium: sim.honesty(zoomed, 'medium', 0.06), low: zoomed.filter((r) => r.level === 'low').length, n: zoomed.length };
  t.diagnostic(describeLevels('zoomed in (2 px)', zLv) + '; eave error median ' + pct(median(zErrs)));
  assert.ok(median(zErrs) < 0.05, 'zoomed in, the typical eave is within 5%: ' + pct(median(zErrs)));
  assertHonestLevels('zoomed in', zLv);
  assert.ok(!zoomed.some((r) => r.reasons.some((s) => /zoomed out/.test(s))), 'careful taps are not called zoomed out');
});
