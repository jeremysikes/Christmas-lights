// Seeded Monte Carlo regression for the honesty of the confidence levels (review finding M1).
// Random houses (28–60 ft facades, 9–18 ft walls) are photographed by a 26 mm-equivalent camera from 0–35° off
// straight-on with the facade filling 30–90% of the frame; every tap gets N(0, σ²) pixel noise with σ ∈ {1.5, 2, 3}.
// Setups cover tape-measured house corners, a garage-door rectangle, a front-door rectangle, house corners of
// unknown size with door references (EXIF or measured focal), refs-only walls, and roof/ground planes built from
// the wall. The promise in docs/TEST_SCRIPT.md: High within ±3%, Medium within ±6%.
const test = require('node:test');
const assert = require('node:assert/strict');
const sim = require('./sim-houses');

const pct = (x) => (100 * x).toFixed(1) + '%';

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
