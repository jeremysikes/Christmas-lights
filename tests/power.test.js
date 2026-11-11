const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const g = LP.require('geometry');
const catalog = LP.require('catalog');
const design = LP.require('design');
const power = LP.require('power');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);
const lib = catalog.getLibrary(null);
/** One cord per feed from the outlet (config.power.daisyChain off), for tests about a single cord. */
const NO_CHAIN = catalog.getLibrary({ library: { products: null, config: { power: { daisyChain: false } } } });

// ------------------------------------------------------------------ fixtures
// Wall planes: image px → plane feet with u = s·x and v = s·(H0 − y), so v points up (SPEC §3).
const H0 = 1000;
function wallSol(planeId, s, offsetX = 0) {
  const Himg2plane = g.multiplyH([1, 0, -offsetX * s, 0, 1, H0 * s, 0, 0, 1], g.scaleMatrix(s, -s));
  return {
    ok: true, planeId, kind: 'wall', mode: 'rect-known', Himg2plane, Hplane2img: g.invertH(Himg2plane),
    scale: { sx: s, sy: s, anisotropic: false }, refResults: [], disagreementPct: null, checks: 0,
    viewAngleDeg: 0, pose: null, K: null, pitch: null, extent: null, warnings: [], notes: [],
  };
}
const SOLS = { pl_front: wallSol('pl_front', 0.1), pl_side: wallSol('pl_side', 0.2, 3000) };
/** Front-wall plane feet → image px (10 px per ft). */
const F = (u, v) => [u * 10, H0 - v * 10];

const DEFAULT_PARAMS = { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false,
  overrideWidthFt: null, overrideHeightFt: null };
function feature(id, type, points, opts = {}) {
  const { params, ...rest } = opts;
  return Object.assign({
    id, imageId: 'img_1', planeId: 'pl_front', type, label: id, points, closed: catalog.FEATURE_TYPES[type].closedDefault,
    overrideFt: null, productId: null, color: null,
  }, rest, { params: Object.assign({}, DEFAULT_PARAMS, params || {}) });
}
function outlet(id, point, opts = {}) {
  return Object.assign({ id, imageId: 'img_1', planeId: 'pl_front', point, label: id, type: 'exteriorGfci', gfci: true,
    circuitId: 'cir_1', receptacles: 2 }, opts);
}
function circuit(id, breakerAmps = 15, opts = {}) {
  return Object.assign({ id, name: id, breakerAmps, voltage: 120, existingLoadW: 0 }, opts);
}
function project({ features = [], outlets = [], circuits = [circuit('cir_1')], library } = {}) {
  return {
    schema: 'lightplan/project', version: 1, id: 'prj_t', name: 'Test',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    images: [{ id: 'img_1', width: 3000, height: 1000 }, { id: 'img_2', width: 3000, height: 1000 }],
    planes: [
      { id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall' },
      { id: 'pl_side', imageId: 'img_1', name: 'Side wall', kind: 'wall' },
      { id: 'pl_back', imageId: 'img_1', name: 'Back wall', kind: 'wall' },
    ],
    features, outlets, circuits, library: library || { products: null, config: null },
  };
}
/** Hand-made measureProject result: plane-space lengths (or overrideFt) per SPEC §5.5 shapes. */
function measure(p, sols = SOLS) {
  const features = {};
  for (const f of p.features) {
    const sol = sols[f.planeId];
    const linear = catalog.LINEAR_TYPES.includes(f.type);
    let L = null, method = 'plane';
    if (Number.isFinite(f.overrideFt)) { L = f.overrideFt; method = 'override'; }
    else if (sol && sol.ok) L = g.polylineLength(f.points.map((q) => g.applyH(sol.Himg2plane, q)), f.closed);
    features[f.id] = L === null
      ? { ok: false, featureId: f.id, type: f.type, method: 'uncalibrated', measuredFt: null, lengthFt: null, withWasteFt: null }
      : { ok: true, featureId: f.id, type: f.type, method, measuredFt: L, wrapFt: null, lengthFt: L, withWasteFt: linear ? L * 1.1 : L,
        areaSqFt: null, widthFt: null, heightFt: null, lights: null, pitchEstimate: null, overridden: method === 'override',
        confidence: { level: 'high', score: 90, reasons: [] } };
  }
  return { planes: sols, features, totals: {}, warnings: [] };
}
function plan(p, l = lib, sols = SOLS) {
  const measured = measure(p, sols);
  const runs = design.planRuns(p, measured, l);
  return { runs, measured, power: power.planPower(p, measured, runs, l) };
}
const codes = (pw) => pw.warnings.map((w) => w.code);
const byCode = (pw, code) => pw.warnings.filter((w) => w.code === code);
const feedOf = (pw, runId) => pw.feeds.find((f) => f.runIds.includes(runId));

// ------------------------------------------------------------------ electrical rules
test('circuit limits: 15 A → 1,440 W and 20 A → 1,920 W (80% continuous load)', () => {
  assert.equal(power.limitW(15, 120, 0.8), 1440);
  assert.equal(power.limitW(20, 120, 0.8), 1920);
  const pw = power.planPower(project({ circuits: [circuit('cir_1', 15), circuit('cir_2', 20)] }), measure(project()), [], lib);
  assert.deepEqual(pw.circuits.map((c) => c.limitW), [1440, 1920]);
  assert.deepEqual(pw.circuits.map((c) => c.loadW), [0, 0]);
  assert.deepEqual(pw.circuits.map((c) => c.overloaded), [false, false]);
  assert.deepEqual(pw.feeds, []);
  assert.deepEqual(codes(pw), ['disclaimer']); // nothing to power → no outlet warnings
});

test('cord gauge: thinnest gauge that carries the current within 3% voltage drop', () => {
  // 50 W LED at 80 ft: 0.42 A; the 100 ft 16 AWG cord bought drops 0.28% (0.22% over the 80 ft needed)
  const c1 = power.sizeCord(80, 50, lib.config.power);
  assert.equal(c1.awg, 16);
  close(c1.voltageDropPct, 0.28, 0.01);
  assert.equal(power.chooseCordGauge(80, 50 / 120, lib.config.power).awg, 16);
  // 1500 W at 100 ft: 12.5 A; 16 AWG 8.4%, 14 AWG 5.3%, 12 AWG 3.3% → none meets 3% → 12 AWG, flagged
  const c2 = power.sizeCord(100, 1500, lib.config.power);
  assert.equal(c2.awg, 12);
  assert.equal(c2.ok, false);
  assert.equal(c2.dropOk, false);
  close(c2.voltageDropPct, 3.31, 0.01);
  // 1800 W at 10 ft: 15 A exceeds 16 AWG ampacity (13 A) → 14 AWG
  assert.equal(power.sizeCord(10, 1800, lib.config.power).awg, 14);
  close(power.voltageDropPct(100, 12.5, 1.588, 120), 3.308, 0.001);
});

test('cord pieces: smallest standard length, 100 ft cords plus the remainder above 100 ft', () => {
  assert.deepEqual(power.cordPieces(130), [100, 50]);
  assert.deepEqual(power.cordPieces(5), [6]);
  assert.deepEqual(power.cordPieces(6), [6]);
  assert.deepEqual(power.cordPieces(16), [25]);
  assert.deepEqual(power.cordPieces(100), [100]);
  assert.deepEqual(power.cordPieces(200), [100, 100]);
  assert.deepEqual(power.cordPieces(230), [100, 100, 50]);
  assert.deepEqual(power.cordPieces(0), [6]);
  assert.deepEqual(power.cordPieces(NaN), [6]);
  assert.deepEqual(power.sizeCord(130, 20, lib.config.power).pieces, [100, 50]);
});

// ------------------------------------------------------------------ overloads and feeds
test('10 incandescent C9 strings on one 15 A circuit: overload warning; a second circuit takes the excess', () => {
  // 220 ft eave → 242 ft with waste → 10 strings bought; 9 × 25 ft cover the 220 ft (the 10th is a spare):
  // 9 × 175 W = 1,575 W live, max 3 end to end → feeds 3 + 3 + 3
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(230, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const one = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5), { label: 'Porch outlet' })], circuits: [circuit('cir_1', 15, { name: 'Porch circuit' })] }));
  const pw = one.power;
  assert.equal(one.runs[0].quantity, 10);
  assert.deepEqual(pw.feeds.map((f) => f.strings), [3, 3, 3]);
  assert.deepEqual(pw.feeds.map((f) => f.watts), [525, 525, 525]);
  assert.ok(pw.feeds.every((f) => f.outletId === 'out_a' && f.circuitId === 'cir_1'));
  assert.equal(pw.circuits[0].loadW, 1575);
  assert.equal(pw.circuits[0].overloaded, true);
  close(pw.circuits[0].utilizationPct, 109.4, 0.05);
  const over = byCode(pw, 'circuit-overload');
  assert.equal(over.length, 1);
  assert.equal(over[0].level, 'danger');
  assert.equal(over[0].circuitId, 'cir_1');
  assert.equal(over[0].message, 'Porch circuit would carry 1,575 W, over the 1,440 W safe limit for a 15 A breaker (80%). Move a run to another circuit or switch to LED.');
  assert.equal(pw.warnings[0].code, 'circuit-overload'); // danger sorts first
  assert.match(byCode(pw, 'incandescent')[0].message, /Front eave uses incandescent lights .*9 strings draw 1,575 W\. The LED version \(C9 LED string, 25 bulbs\) would draw about 86 W/);
  assert.match(byCode(pw, 'max-end-to-end')[0].message, /^Front eave needs 3 feeds: .* allows only 3 strings end to end and this run uses 9\.$/);
  assert.equal(pw.counts.splitters, 1);   // 3 feeds on one outlet → 1 stake (3 sockets)
  assert.equal(pw.counts.timers, 1);

  // A second outlet on another circuit, almost as close: the third 525 W feed moves there.
  const two = plan(project({
    features: [eave],
    outlets: [outlet('out_a', F(5, 1.5)), outlet('out_b', F(3, 1.5), { circuitId: 'cir_2' })],
    circuits: [circuit('cir_1', 15), circuit('cir_2', 20)],
  })).power;
  assert.deepEqual(byCode(two, 'circuit-overload'), []);
  assert.deepEqual(two.feeds.map((f) => f.outletId), ['out_a', 'out_a', 'out_b']);
  assert.deepEqual(two.circuits.map((c) => c.loadW), [1050, 525]);
  assert.ok(two.circuits.every((c) => !c.overloaded));
});

test('7 incandescent C9 strings bought, 6 hung → 2 feeds (max 3 end to end), split along the run', () => {
  // 150 ft → 165 ft with waste → 7 strings bought; 6 × 25 ft cover the 150 ft (1 spare)
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(160, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const { runs, power: pw } = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] }));
  assert.equal(runs[0].quantity, 7);
  assert.equal(pw.chains.length, 1);
  assert.equal(pw.chains[0].strings, 6);
  assert.equal(pw.chains[0].spares, 1);
  assert.equal(pw.feeds.length, 2);
  assert.deepEqual(pw.feeds.map((f) => f.strings), [3, 3]);
  assert.deepEqual(pw.chains[0].feedIds, pw.feeds.map((f) => f.id));
  assert.deepEqual(pw.feeds.map((f) => f.id), ['feed_ft_eave_1', 'feed_ft_eave_2']);
  // feed starts at the left end (nearest the outlet), then where three 25 ft strings end (75 ft along)
  assert.deepEqual(pw.feeds[0].start.point, F(10, 20));
  assert.equal(pw.feeds[0].start.label, 'left end of Front eave');
  const p2 = pw.feeds[1].start.point;
  close(p2[0], F(10 + 75, 20)[0], 1e-6); close(p2[1], 800, 1e-6);
  assert.equal(pw.feeds[1].start.label, 'point 75 ft from the left end of Front eave');
  assert.equal(pw.feeds[1].start.toward, 'right end of Front eave');
  assert.equal(pw.feeds[1].start.planeId, 'pl_front');
  assert.equal(pw.feeds[1].start.imageId, 'img_1');
  const info = byCode(pw, 'max-end-to-end');
  assert.equal(info.length, 1);
  assert.equal(info[0].level, 'info');
  assert.match(info[0].message, /^Front eave needs 2 feeds: C9 incandescent string, 25 bulbs \(7 W\) allows only 3 strings end to end and this run uses 6\.$/);
  assert.deepEqual(pw.runInfo.run_ft_eave.feedIds, pw.chains[0].feedIds);
});

test('LED runs within maxEndToEnd stay on one feed', () => {
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(160, 20)]);
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(pw.feeds.length, 1);
  assert.equal(pw.feeds[0].strings, 6); // 7 bought for 150 ft + 10%, 6 × 25 ft hung
  close(pw.feeds[0].watts, 57.6, 1e-9);
  close(pw.feeds[0].amps, 0.48, 1e-9);
  assert.deepEqual(byCode(pw, 'max-end-to-end'), []);
  assert.deepEqual(byCode(pw, 'incandescent'), []);
});

// ------------------------------------------------------------------ chains and orientation
test('two adjacent rooflines chain end to end and start at the end nearest the outlet', () => {
  const a = feature('ft_a', 'roofline', [F(10, 20), F(40, 20)], { label: 'Left eave' });
  const b = feature('ft_b', 'roofline', [F(41, 20), F(70, 20)], { label: 'Right eave' });
  const far = feature('ft_c', 'roofline', [F(80, 20), F(100, 20)], { label: 'Garage eave' });        // 10 ft gap
  const win = feature('ft_w', 'window', [F(40.5, 18), F(45, 18), F(45, 12), F(40.5, 12)], { label: 'Window' }); // other product
  const { power: pw } = plan(project({ features: [a, b, far, win], outlets: [outlet('out_a', F(75, 1.5))] }));
  const ab = pw.chains.find((c) => c.runIds.includes('run_ft_a'));
  assert.equal(ab.id, 'chain_ft_a');
  assert.deepEqual(ab.runIds, ['run_ft_b', 'run_ft_a']);          // walks from the right end (nearest the outlet)
  assert.deepEqual(ab.reversed, { run_ft_b: true, run_ft_a: true });
  assert.equal(ab.strings, 3);                                     // 30 + 29 ft as one line: 3 C9 LED strings (not 2 + 2)
  assert.equal(ab.feedIds.length, 1);
  const feed = pw.feeds.find((f) => f.id === ab.feedIds[0]);
  assert.deepEqual(feed.runIds, ['run_ft_b', 'run_ft_a']);
  assert.equal(feed.start.label, 'right end of Right eave');
  assert.deepEqual(pw.runInfo.run_ft_b.start, F(70, 20));
  assert.deepEqual(pw.runInfo.run_ft_b.end, F(41, 20));
  assert.equal(pw.runInfo.run_ft_a.reversed, true);
  assert.equal(pw.runInfo.run_ft_a.chainId, pw.runInfo.run_ft_b.chainId);
  assert.notEqual(pw.runInfo.run_ft_c.chainId, ab.id);
  assert.notEqual(pw.runInfo.run_ft_w.chainId, ab.id);
  assert.equal(pw.chains.length, 3);
  // a closed outline plugs in at its first point, which is both its start and its end
  assert.deepEqual(pw.runInfo.run_ft_w.start, F(40.5, 18));
  assert.deepEqual(pw.runInfo.run_ft_w.end, F(40.5, 18));
  assert.equal(feedOf(pw, 'run_ft_w').start.label, 'top-left corner of Window');
});

test('chaining across planes uses the mean local scale; too far apart does not chain', () => {
  // Side wall: 0.2 ft per px. Endpoints 10 px apart → 10 × mean(0.1, 0.2) = 1.5 ft → chain.
  const a = feature('ft_a', 'roofline', [F(200, 20), F(270, 20)], { label: 'Front eave' });
  const end = F(270, 20);
  const b = feature('ft_b', 'roofline', [[end[0] + 10, end[1]], [end[0] + 210, end[1]]], { planeId: 'pl_side', label: 'Side eave' });
  const c = feature('ft_c', 'roofline', [[end[0] + 235, end[1]], [end[0] + 300, end[1]]], { planeId: 'pl_side', label: 'Shed eave' });
  const pw = plan(project({ features: [a, b, c], outlets: [outlet('out_a', F(195, 1.5))] })).power;
  assert.equal(pw.runInfo.run_ft_a.chainId, pw.runInfo.run_ft_b.chainId);
  // b ↔ c: same plane, 25 px × 0.2 = 5 ft apart → separate chains
  assert.notEqual(pw.runInfo.run_ft_c.chainId, pw.runInfo.run_ft_b.chainId);
});

test('params.reverse forces the run to start at its last point', () => {
  const mk = (reverse) => feature('ft_e', 'roofline', [F(10, 20), F(60, 20)], { label: 'Front eave', params: { reverse } });
  const normal = plan(project({ features: [mk(false)], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(normal.runInfo.run_ft_e.reversed, false);
  assert.deepEqual(normal.feeds[0].start.point, F(10, 20));
  const forced = plan(project({ features: [mk(true)], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(forced.runInfo.run_ft_e.reversed, true);
  assert.deepEqual(forced.runInfo.run_ft_e.start, F(60, 20));
  assert.deepEqual(forced.feeds[0].start.point, F(60, 20));
  assert.equal(forced.feeds[0].start.label, 'right end of Front eave');
  assert.equal(forced.chains[0].reversed.run_ft_e, true);
});

test('two forced-reverse runs that would need opposite directions are not chained', () => {
  // a ends where b ends (end-to-end); both forced reverse would need opposite chain directions
  const a = feature('ft_a', 'roofline', [F(10, 20), F(40, 20)], { params: { reverse: true } });
  const b = feature('ft_b', 'roofline', [F(70, 20), F(41, 20)], { params: { reverse: true } });
  const pw = plan(project({ features: [a, b], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.notEqual(pw.runInfo.run_ft_a.chainId, pw.runInfo.run_ft_b.chainId);
  assert.equal(pw.runInfo.run_ft_a.reversed, true);
  assert.equal(pw.runInfo.run_ft_b.reversed, true);
});

// ------------------------------------------------------------------ outlets
test('params.outletId forces a run to an outlet; a missing outlet falls back with a warning', () => {
  const eave = (outletId) => feature('ft_e', 'roofline', [F(10, 20), F(60, 20)], { label: 'Front eave', params: { outletId } });
  const outs = [outlet('out_near', F(5, 1.5)), outlet('out_far', F(90, 1.5), { circuitId: 'cir_2' })];
  const circuits = [circuit('cir_1'), circuit('cir_2', 20)];
  const auto = plan(project({ features: [eave(null)], outlets: outs, circuits })).power;
  assert.equal(auto.feeds[0].outletId, 'out_near');
  const forced = plan(project({ features: [eave('out_far')], outlets: outs, circuits })).power;
  assert.equal(forced.feeds[0].outletId, 'out_far');
  assert.equal(forced.feeds[0].circuitId, 'cir_2');
  assert.equal(forced.runInfo.run_ft_e.outletId, 'out_far');
  assert.equal(forced.runInfo.run_ft_e.circuitId, 'cir_2');
  // orientation follows the forced outlet: the right end is closer to out_far
  assert.deepEqual(forced.feeds[0].start.point, F(60, 20));
  assert.deepEqual(forced.outlets.find((o) => o.id === 'out_far').feedIds, [forced.feeds[0].id]);
  const missing = plan(project({ features: [eave('out_gone')], outlets: outs, circuits })).power;
  assert.equal(missing.feeds[0].outletId, 'out_near');
  assert.match(byCode(missing, 'outlet-missing')[0].message, /Front eave is set to an outlet that no longer exists/);
});

test('no outlets: feeds stay unassigned with a no-outlets warning', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const pw = plan(project({ features: [eave], outlets: [] })).power;
  assert.equal(pw.feeds.length, 1);
  assert.equal(pw.feeds[0].outletId, null);
  assert.equal(pw.feeds[0].circuitId, null);
  assert.equal(pw.feeds[0].cord, null);
  assert.deepEqual(pw.feeds[0].cordPath, []);
  assert.deepEqual(pw.cords, []);
  assert.deepEqual(pw.counts, { timers: 0, splitters: 0, cordCovers: 0, gfciAdapters: 0, taps: 0, homeRuns: 0, jumpers: 0 });
  assert.deepEqual(pw.groups, []);
  assert.equal(pw.feeds[0].source, null);
  assert.ok(codes(pw).includes('no-outlets'));
  assert.ok(codes(pw).includes('disclaimer'));
  assert.equal(pw.runInfo.run_ft_e.outletId, null);
});

test('outlets only on another photo: feeds are unassigned with a plain warning', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)], { label: 'Front eave' });
  const pw = plan(project({ features: [eave], outlets: [outlet('out_back', F(5, 1.5), { imageId: 'img_2', planeId: null })] })).power;
  assert.equal(pw.feeds[0].outletId, null);
  assert.ok(!codes(pw).includes('no-outlets'));
  assert.equal(byCode(pw, 'unassigned')[0].message,
    'No outlet is marked on the same photo as the feed at the left end of Front eave. Mark an outlet on that photo to plan the cord.');
});

test('equal distances break ties by outlet id', () => {
  // a tree plugs in at its base, so both run directions start at the same point, 10 ft from each outlet
  const tree = feature('ft_t', 'tree', [F(50, 0), F(50, 10)]);
  const p = project({ features: [tree], outlets: [outlet('out_b', F(60, 0)), outlet('out_a', F(40, 0))] });
  const measured = measure(p);
  measured.features.ft_t = Object.assign({}, measured.features.ft_t, { wrapFt: 40, lengthFt: 40, withWasteFt: 40, heightFt: 10 });
  const pw = power.planPower(p, measured, design.planRuns(p, measured, lib), lib);
  assert.equal(pw.feeds[0].outletId, 'out_a');
});

test('timers: one per outlet with feeds; splitters: chained 3-outlet stakes on outlets with more than one feed', () => {
  // four separate windows (closed outlines, 1 mini string each) near one outlet → 4 feeds
  const wins = [0, 1, 2, 3].map((i) => feature('ft_w' + i, 'window',
    [F(10 + i * 10, 15), F(15 + i * 10, 15), F(15 + i * 10, 10), F(10 + i * 10, 10)], { label: 'Window ' + (i + 1) }));
  const eave = feature('ft_e', 'roofline', [F(200, 20), F(240, 20)]);
  const outs = [outlet('out_a', F(5, 1.5)), outlet('out_b', F(245, 1.5)), outlet('out_idle', F(150, 1.5))];
  const pw = plan(project({ features: wins.concat([eave]), outlets: outs })).power;
  assert.equal(pw.feeds.length, 5);
  const a = pw.outlets.find((o) => o.id === 'out_a');
  const b = pw.outlets.find((o) => o.id === 'out_b');
  const idle = pw.outlets.find((o) => o.id === 'out_idle');
  assert.equal(a.feedIds.length, 4);
  assert.equal(a.needsSplitter, true);
  assert.equal(a.splitters, 2);
  assert.equal(a.timer, true);
  assert.equal(b.feedIds.length, 1);
  assert.equal(b.needsSplitter, false);
  assert.equal(b.splitters, 0);
  assert.equal(idle.timer, false);
  assert.deepEqual(idle.feedIds, []);
  assert.equal(pw.counts.timers, 2);
  assert.equal(pw.counts.splitters, 2);
  close(a.watts, 4 * 4.8, 1e-9);
  // timerPerOutlet off → no timers
  const noTimer = catalog.getLibrary({ library: { config: { power: { timerPerOutlet: false } } } });
  assert.equal(plan(project({ features: wins, outlets: outs }), noTimer).power.counts.timers, 0);
});

test('non-GFCI outlet: one GFCI adapter and a warning; indoor outlet warning', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const win = feature('ft_w', 'window', [F(200, 15), F(205, 15), F(205, 10), F(200, 10)]);
  const outs = [
    outlet('out_g', F(5, 1.5), { label: 'Garage outlet', type: 'garage', gfci: false }),
    outlet('out_in', F(210, 3), { label: 'Living room outlet', type: 'interior', gfci: false }),
    outlet('out_unused', F(120, 1.5), { label: 'Side outlet', type: 'other', gfci: false }),
  ];
  const pw = plan(project({ features: [eave, win], outlets: outs })).power;
  assert.equal(pw.counts.gfciAdapters, 2); // the unused outlet does not need one
  const g1 = byCode(pw, 'no-gfci');
  assert.deepEqual(g1.map((w) => w.outletId), ['out_g', 'out_in']);
  assert.equal(g1[0].message, 'Garage outlet has no GFCI protection. Plug a portable outdoor GFCI adapter into it before connecting lights.');
  const indoor = byCode(pw, 'interior-outlet');
  assert.equal(indoor.length, 1);
  assert.equal(indoor[0].outletId, 'out_in');
  // a GFCI outlet (default type) needs nothing
  const ok = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(ok.counts.gfciAdapters, 0);
  assert.deepEqual(byCode(ok, 'no-gfci'), []);
});

test('outlet without a circuit is assumed to be alone on a 15 A breaker', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(230, 20)], { productId: 'c9-incan' });
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5), { label: 'Porch outlet', circuitId: null })], circuits: [] })).power;
  assert.ok(pw.feeds.every((f) => f.outletId === 'out_a' && f.circuitId === null));
  assert.match(byCode(pw, 'outlet-no-circuit')[0].message, /Porch outlet is not assigned to a circuit/);
  const over = byCode(pw, 'circuit-overload')[0];
  assert.equal(over.outletId, 'out_a');
  assert.match(over.message, /^The circuit for Porch outlet would carry 1,575 W, over the 1,440 W safe limit for a 15 A breaker \(80%\)\./); // 9 hung strings
});

test('circuit above 90% of its limit gets a circuit-high warning', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(40, 20)]); // 33 ft → 2 C9 LED strings = 19.2 W
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))],
    circuits: [circuit('cir_1', 15, { name: 'Kitchen circuit', existingLoadW: 1300 })] })).power;
  assert.equal(pw.circuits[0].existingLoadW, 1300);
  close(pw.circuits[0].loadW, 1319.2, 1e-9);
  close(pw.circuits[0].utilizationPct, 91.6, 0.05);
  assert.equal(pw.circuits[0].overloaded, false);
  assert.equal(byCode(pw, 'circuit-high')[0].message,
    'Kitchen circuit would carry 1,319 W (including 1,300 W already on it), 92% of its 1,440 W safe limit. Keep other appliances off that circuit while the lights are on.');
  assert.deepEqual(byCode(pw, 'circuit-overload'), []);
});

// ------------------------------------------------------------------ cords
test('same-wall cord: down to the ground, along it and up, × routing factor + slack', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  const f = pw.feeds[0];
  // 1.5 ft down + |10 − 5| along the ground + 20 ft up = 26.5 ft → 26.5 × 1.15 + 4 = 34.5 ft
  close(f.cord.lengthFt, 34.5, 0.05);
  assert.equal(f.cord.awg, 16);
  assert.deepEqual(f.cord.pieces, [50]);
  assert.equal(f.cordPath.length, 4);
  assert.deepEqual(f.cordPath[0], F(5, 1.5));
  close(f.cordPath[1][0], F(5, 0)[0], 1e-6); close(f.cordPath[1][1], F(5, 0)[1], 1e-6);
  close(f.cordPath[2][0], F(10, 0)[0], 1e-6); close(f.cordPath[2][1], F(10, 0)[1], 1e-6);
  assert.deepEqual(f.cordPath[3], F(10, 20));
  assert.deepEqual(pw.cords, [{ awg: 16, lengthFt: 50, count: 1 }]);
  assert.equal(f.crossesWalkway, false);
});

test('outlet without a plane: the photo distance to the foot of the riser is scaled (+30%); two walls: ground distance between their feet', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const noPlane = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5), { planeId: null })] })).power;
  const px = g.dist(F(5, 1.5), F(10, 0));
  close(noPlane.feeds[0].cord.lengthFt, (px * 0.1 * 1.3 + 20) * 1.15 + 4, 0.05);
  assert.equal(noPlane.feeds[0].cordPath.length, 3);
  // Feed on the side wall (0.2 ft/px, its ground set by a door traced down to v = 0), outlet on the front wall
  // (0.1 ft/px): 1.5 ft down, the 100 px between the two feet at the mean scale 0.15, then 40 ft up.
  const side = feature('ft_s', 'roofline', [[2000, 800], [2100, 800]], { planeId: 'pl_side' });
  const door = feature('ft_d', 'door', [[2300, 1000], [2300, 965], [2315, 965], [2315, 1000]], { planeId: 'pl_side' });
  const cross = plan(project({ features: [side, door], outlets: [outlet('out_a', [1900, 985])] }), NO_CHAIN).power;
  const f = feedOf(cross, 'run_ft_s');
  close(f.cord.lengthFt, (1.5 + 100 * 0.15 + 40) * 1.15 + 4, 0.05);
  assert.deepEqual(f.cord.route.map((x) => x.kind), ['drop', 'ground', 'rise']);
});

test('1,500 W feed with a ~95 ft cord: 12 AWG and a voltage-drop warning; long cords get pieces and a warning', () => {
  const custom = catalog.deepClone(lib);
  custom.products.push({ id: 'big-c9', sku: 'big-c9', name: 'Big C9 string', category: 'c9', tech: 'LED', unit: 'string',
    bulbSpacingIn: 12, stringLengthFt: 10, leadFt: 1, bulbsPerUnit: 10, wattsPerUnit: 150, maxEndToEnd: 20, price: 10,
    colors: ['warmWhite'], clipEligible: true, enabled: true, suitableFor: ['roofline'] });
  // 100 ft → 10 strings of 10 ft hung (11 bought with waste) × 150 W = 1,500 W. Outlet 70 ft to the left and 9 ft below
  // the left end; the ground is 1.5 ft below the outlet: 1.5 + 70 + 10.5 = 82 ft routed.
  const eave = feature('ft_e', 'roofline', [F(100, 20), F(200, 20)], { label: 'Front eave', productId: 'big-c9' });
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(30, 11))], circuits: [circuit('cir_1', 20)] }), custom).power;
  const f = pw.feeds[0];
  assert.equal(f.watts, 1500);
  close(f.cord.lengthFt, 82 * 1.15 + 4, 0.06);  // 98.3 ft
  assert.equal(f.cord.awg, 12);
  assert.ok(f.cord.voltageDropPct > 3);
  const vd = byCode(pw, 'voltage-drop');
  assert.equal(vd.length, 1);
  // The 100 ft cord bought carries the current: 2 · 100 · 1.588/1000 · 12.5 / 120 = 3.3%.
  assert.match(vd[0].message, /^The 100 ft cord to the left end of Front eave \(about 98 ft needed\) would lose 3\.3% of its voltage even with 12 AWG cord \(limit 3%\)\. Use a closer outlet or split the run\.$/);
  assert.deepEqual(byCode(pw, 'long-cord'), []);

  // Long cord: 1.5 ft down + 145 ft along the ground + 20 ft up → 166.5 × 1.15 + 4 = 195.5 ft → two 100 ft cords
  const far = feature('ft_far', 'roofline', [F(150, 20), F(175, 20)], { label: 'Garage eave' });
  const pw2 = plan(project({ features: [far], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  close(pw2.feeds[0].cord.lengthFt, 195.5, 0.05);
  assert.deepEqual(pw2.feeds[0].cord.pieces, [100, 100]);
  assert.deepEqual(pw2.cords, [{ awg: 16, lengthFt: 100, count: 2 }]);
  assert.match(byCode(pw2, 'long-cord')[0].message, /^The cord to the left end of Garage eave needs about 19[56] ft \(100 ft \+ 100 ft\)\. Look for a closer outlet\.$/);
});

test('a cord path that crosses a walkway needs a cord cover and gets a warning', () => {
  const eave = feature('ft_e', 'roofline', [F(50, 20), F(90, 20)], { label: 'Front eave' });
  // walkway traced on an uncalibrated ground plane, crossing the cord's run along the wall
  const walk = feature('ft_walk', 'walkway', [F(30, 5), F(30, -10)], { planeId: 'pl_ground', label: 'Front walk' });
  const pw = plan(project({ features: [eave, walk], outlets: [outlet('out_a', F(10, 1.5))] })).power;
  assert.equal(pw.feeds.length, 1);           // the unmeasured walkway itself is not powered
  assert.equal(pw.feeds[0].crossesWalkway, true);
  assert.equal(pw.counts.cordCovers, 1);
  const w = byCode(pw, 'cord-walkway');
  assert.equal(w.length, 1);
  assert.equal(w[0].message, 'The cord to the left end of Front eave crosses a walkway. Put a cord cover over it so nobody trips.');
  // walkway elsewhere → no cover
  const elsewhere = feature('ft_walk', 'walkway', [F(150, 5), F(150, -10)], { planeId: 'pl_ground' });
  const pw2 = plan(project({ features: [eave, elsewhere], outlets: [outlet('out_a', F(10, 1.5))] })).power;
  assert.equal(pw2.counts.cordCovers, 0);
  assert.deepEqual(byCode(pw2, 'cord-walkway'), []);
});

test('no scale at all: runs do not chain and the cord length is reported as unknown', () => {
  // tape-measured runs on an uncalibrated plane, touching each other in the image
  const a = feature('ft_a', 'roofline', [[100, 200], [400, 200]], { planeId: 'pl_back', overrideFt: 30, label: 'Back eave' });
  const b = feature('ft_b', 'roofline', [[401, 200], [700, 200]], { planeId: 'pl_back', overrideFt: 30, label: 'Back eave 2' });
  const pw = plan(project({ features: [a, b], outlets: [outlet('out_a', [90, 900], { planeId: 'pl_back' })] })).power;
  assert.notEqual(pw.runInfo.run_ft_a.chainId, pw.runInfo.run_ft_b.chainId);
  assert.equal(pw.feeds.length, 2);
  for (const f of pw.feeds) {
    assert.equal(f.outletId, 'out_a');
    assert.equal(f.cord, null);
    assert.equal(f.cordUnknown, true);
  }
  assert.deepEqual(pw.cords, []);
  const unk = byCode(pw, 'cord-unknown');
  assert.equal(unk.length, 2);
  assert.match(unk[0].message, /^The cord length to the .* is unknown because Back wall is not calibrated\. Calibrate it to size the cord\.$/);
});

test('outlets without a position are skipped; a forced outlet on another photo leaves the cord unknown', () => {
  const eave = (outletId) => feature('ft_e', 'roofline', [F(10, 20), F(60, 20)], { label: 'Front eave', params: { outletId } });
  const outs = [outlet('out_nowhere', null, { label: 'Lost outlet' }), outlet('out_a', F(5, 1.5)),
    outlet('out_back', [100, 900], { label: 'Back outlet', imageId: 'img_2', planeId: null })];
  const auto = plan(project({ features: [eave(null)], outlets: outs })).power;
  assert.equal(auto.feeds[0].outletId, 'out_a');
  const forced = plan(project({ features: [eave('out_back')], outlets: outs })).power;
  assert.equal(forced.feeds[0].outletId, 'out_back');
  assert.equal(forced.feeds[0].cord, null);
  assert.equal(forced.feeds[0].cordUnknown, true);
  assert.equal(byCode(forced, 'cord-unknown')[0].message,
    'The cord length to the left end of Front eave is unknown because Back outlet is on a different photo. Calibrate it to size the cord.');
});

test('large projects plan quickly', () => {
  const features = [];
  for (let i = 0; i < 150; i++) features.push(feature('ft_' + i, i % 3 ? 'roofline' : 'window',
    i % 3 ? [F(i * 4, 20 + (i % 5)), F(i * 4 + 3.5, 20 + (i % 5))] : [F(i * 4, 10), F(i * 4 + 2, 10), F(i * 4 + 2, 6), F(i * 4, 6)]));
  const outs = [0, 1, 2, 3, 4].map((k) => outlet('out_' + k, F(k * 120, 1.5), { circuitId: k % 2 ? 'cir_2' : 'cir_1' }));
  const t0 = process.hrtime.bigint();
  const pw = plan(project({ features, outlets: outs, circuits: [circuit('cir_1'), circuit('cir_2', 20)] })).power;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(pw.feeds.length > 0);
  assert.ok(pw.feeds.every((f) => f.outletId));
  assert.ok(ms < 2000, `took ${ms} ms`);
});

// ------------------------------------------------------------------ robustness
test('unpowered runs, bad data and missing pieces never throw; inputs are not mutated', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const lost = feature('ft_lost', 'roofline', [F(10, 30), F(60, 30)], { planeId: 'pl_back' }); // not measured → quantity 0
  const tree = feature('ft_t', 'tree', [F(120, 0), F(120, 12)], { label: 'Oak' });
  const p = project({ features: [eave, lost, tree], outlets: [outlet('out_a', F(5, 1.5)), outlet('out_bad', null), { id: 7 }] });
  const measured = measure(p);
  measured.features.ft_t = Object.assign({}, measured.features.ft_t, { wrapFt: 40, lengthFt: 40, withWasteFt: 40, heightFt: 12 });
  const runs = design.planRuns(p, measured, lib);
  const snap = JSON.stringify([p, measured, runs, lib]);
  const pw = power.planPower(p, measured, runs, lib);
  assert.equal(JSON.stringify([p, measured, runs, lib]), snap);
  assert.equal(pw.runInfo.run_ft_lost.chainId, null);
  assert.deepEqual(pw.runInfo.run_ft_lost.feedIds, []);
  assert.deepEqual(pw.runInfo.run_ft_lost.start, F(10, 30));
  assert.equal(feedOf(pw, 'run_ft_t').start.label, 'base of Oak');
  assert.equal(pw.runInfo.run_ft_t.reversed, false);
  // Live load: the 50 ft eave hangs 2 of its 3 strings (the third is a spare), the oak hangs both of its 2.
  close(pw.totals.watts, 2 * 9.6 + 2 * 7.2, 1e-9);
  close(pw.totals.watts, pw.chains.reduce((s, c) => s + c.watts, 0), 1e-9);
  close(pw.totals.amps, pw.totals.watts / 120, 1e-3);

  for (const args of [[], [null, null, null, null], [{}, {}, [{}], {}], [p, null, runs, null], [p, measured, [{ id: 'run_x', featureId: 'nope', quantity: 3 }], lib]]) {
    const out = power.planPower(...args);
    assert.ok(Array.isArray(out.feeds) && Array.isArray(out.chains) && Array.isArray(out.warnings));
    assert.equal(out.warnings[out.warnings.length - 1].code, 'disclaimer');
    assert.match(out.warnings.find((w) => w.code === 'disclaimer').message, /^This is a planning estimate, not an electrical inspection\./);
  }
});

test('warnings are ordered danger, warn, info and every one has a level, code and message', () => {
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(230, 20)], { productId: 'c9-incan' });
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5), { gfci: false, type: 'garage' })] })).power;
  const order = { danger: 0, warn: 1, info: 2 };
  for (let i = 1; i < pw.warnings.length; i++) assert.ok(order[pw.warnings[i - 1].level] <= order[pw.warnings[i].level]);
  for (const w of pw.warnings) assert.ok(w.level && w.code && typeof w.message === 'string' && w.message.length > 10);
  // the 4th feed starts 203 ft along the eave, far from the only outlet → long cord too
  // 1,750 W through one outlet and timer also overloads the 15 A plug-in gear and the timer's incandescent rating.
  assert.deepEqual([...new Set(codes(pw))].sort(), ['circuit-overload', 'disclaimer', 'incandescent', 'long-cord', 'max-end-to-end', 'no-gfci', 'outlet-overload', 'timer-tungsten']);
});

// ------------------------------------------------------------------ integration with measure.js
test('integration: a real measure.measureProject result flows through design and power', { skip: !LP.has('measure') }, () => {
  const measureMod = LP.require('measure');
  // A 40 × 12 ft wall seen in perspective: image points come from an exact plane → image homography.
  const quad = [[180, 220], [1380, 120], [1400, 900], [160, 860]];            // TL, TR, BR, BL
  const Hp2i = g.homographyFromPoints([[0, 12], [40, 12], [40, 0], [0, 0]], quad);
  const P = (u, v) => g.applyH(Hp2i, [u, v]);
  const p = project({
    features: [
      feature('eave_l', 'roofline', [P(0, 12), P(20, 12)], { label: 'Left eave' }),
      feature('eave_r', 'roofline', [P(20.5, 12), P(40, 12)], { label: 'Right eave' }),
      feature('win', 'window', [P(5, 4), P(10, 4), P(10, 8), P(5, 8)], { label: 'Window' }),
    ],
    outlets: [outlet('out_porch', P(38, 1.5), { label: 'Porch outlet' })],
  });
  p.images = [{ id: 'img_1', name: 'front.jpg', width: 1600, height: 1200, exif: null,
    camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img_1' }];
  p.activeImageId = 'img_1';
  p.planes = [{ id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall', color: '#4f9dff',
    rect: { corners: quad, widthFt: 40, heightFt: 12, presetId: null }, refs: [], derived: null }];

  const measured = measureMod.measureProject(p, lib.config);
  assert.equal(measured.planes.pl_front.mode, 'rect-known');
  const runs = design.planRuns(p, measured, lib);
  const run = (id) => runs.find((r) => r.featureId === id);
  close(run('eave_l').lengthFt, 20, 1e-6);
  assert.equal(run('eave_l').quantity, 1);                     // 22 ft → 1 C9 string
  assert.equal(run('eave_r').quantity, 1);                     // 19.5 ft → 21.45 ft → 1 string
  assert.equal(run('win').quantity, 1);                        // 18 ft perimeter → 19.8 ft → 1 mini string
  assert.equal(run('win').clips.type, 'adhesive');

  const pw = power.planPower(p, measured, runs, lib);
  // the two eaves chain (0.5 ft apart) and start at the right end, nearest the porch outlet
  const chain = pw.chains.find((c) => c.runIds.includes('run_eave_l'));
  assert.deepEqual(chain.runIds, ['run_eave_r', 'run_eave_l']);
  const feed = pw.feeds.find((f) => f.id === chain.feedIds[0]);
  assert.equal(feed.start.label, 'right end of Right eave');
  // ground-first route: 1.5 ft down + |40 − 38| along the ground + 12 ft up = 15.5 ft → × 1.15 + 4 = 21.8 ft → one 25 ft 16 AWG cord
  close(feed.cord.lengthFt, 15.5 * 1.15 + 4, 0.06);
  assert.deepEqual(feed.cord.pieces, [25]);
  assert.equal(feed.cord.awg, 16);
  assert.deepEqual(feed.source, { kind: 'outlet', outletId: 'out_porch' });
  // the window plugs in at its first point (bottom-left on the wall). A cord from the outlet would need 48 ft; a
  // jumper from the far end of the eave lights (0, 12) needs 8 ft down the wall and 5 ft across to (5, 4).
  const wf = feedOf(pw, 'run_win');
  assert.equal(wf.start.label, 'bottom-left corner of Window');
  assert.deepEqual(wf.source, { kind: 'feed', feedId: feed.id, port: 'end' });
  close(wf.cord.lengthFt, 13 * 1.15 + 1.5, 0.06);
  assert.equal(wf.cord.routeText, 'down 8 ft, 5 ft across');
  assert.equal(pw.outlets[0].feedIds.length, 2);
  assert.deepEqual(pw.outlets[0].directFeedIds, [feed.id]);
  assert.equal(pw.outlets[0].splitters, 0);
  assert.equal(pw.counts.timers, 1);
  close(pw.circuits[0].loadW, 9.6 * 2 + 4.8, 1e-9);
  assert.deepEqual(codes(pw), ['daisy-chain', 'disclaimer']);
});

test('a chain of several runs that needs more than one feed reads "need" (plural)', () => {
  // Two adjacent incandescent C9 eaves, 5 + 5 strings: they chain and need 4 feeds of at most 3 strings.
  const a = feature('ft_a', 'roofline', [F(10, 20), F(110, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const b = feature('ft_b', 'roofline', [F(110, 20), F(210, 20)], { label: 'Garage eave', productId: 'c9-incan' });
  const pw = plan(project({ features: [a, b], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(pw.chains.length, 1);
  const info = byCode(pw, 'max-end-to-end');
  assert.equal(info.length, 1);
  assert.match(info[0].message, /^Front eave and Garage eave need \d feeds: .* these connected runs use \d+\.$/);
});

// ------------------------------------------------------------------ review fixes (planning)
test('safe share of the breaker is bounded: 80 means 80%, above 1 is never a free pass, above 0.8 is flagged', () => {
  assert.equal(power.limitW(15, 120, 80), 1440, '80 is read as 80%');
  assert.equal(power.limitW(15, 120, 1), 1800);
  assert.equal(power.limitW(15, 120, 500), 1440, 'nonsense falls back to the 80% rule');
  assert.equal(power.limitW(15, 120, -2), 1440);
  // 300 ft of incandescent C9 on the porch circuit draws far more than any sane limit.
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(310, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const run = (cf) => plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))],
    library: { products: null, config: { power: { continuousFactor: cf } } } }), catalog.getLibrary({ library: { config: { power: { continuousFactor: cf } } } })).power;
  for (const cf of [80, 500]) {
    const pw = run(cf);
    assert.equal(pw.circuits[0].limitW, 1440, `continuousFactor ${cf}`);
    assert.equal(pw.circuits[0].overloaded, true, `continuousFactor ${cf}`);
    assert.ok(codes(pw).includes('circuit-overload'), `continuousFactor ${cf} still warns about the overload`);
    assert.ok(codes(pw).includes('continuous-factor'), `continuousFactor ${cf} explains how the setting was read`);
  }
  const high = run(0.95);
  assert.equal(high.circuits[0].limitW, 1710);
  assert.ok(codes(high).includes('continuous-factor'), 'a share above the 80% rule is flagged');
  assert.ok(!codes(run(0.8)).includes('continuous-factor'));
});

test('cord gauge and voltage drop are checked on the cord actually bought, not the length needed', () => {
  // 60 ft needed → a 100 ft cord. 1,400 W = 11.7 A: 14 AWG over 100 ft drops 4.9%, so 14 AWG is not enough.
  const a = power.sizeCord(60, 1400, lib.config.power);
  assert.deepEqual(a.pieces, [100]);
  assert.equal(a.awg, 12);
  close(a.voltageDropPct, 3.09, 0.01);
  assert.equal(a.dropOk, false, '12 AWG over 100 ft is still above 3%');
  // 625 W of C7 incandescent, 82.8 ft needed → 100 ft cord: 16 AWG would drop 3.49%, so 14 AWG.
  const b = power.sizeCord(82.8, 625, lib.config.power);
  assert.deepEqual(b.pieces, [100]);
  assert.equal(b.awg, 14);
  close(b.voltageDropPct, 2.19, 0.01);
  assert.equal(b.dropOk, true);
  assert.equal(b.lengthFt, 82.8, 'lengthFt stays the length needed');
  assert.equal(b.boughtFt, 100);
});

test('plug-in cords, timers, power stakes and outlets are 15 A devices: cords cap at 15 A, outlets at 1,440 W', () => {
  // A cord with a 15 A plug is never good for 19 A, whatever its gauge.
  const a = power.sizeCord(30, 2300, lib.config.power);
  assert.equal(a.ampacityOk, false);
  assert.equal(a.ok, false);
  assert.equal(power.sizeCord(30, 1900, lib.config.power).ampacityOk, false, '15.8 A is over a 15 A plug');
  assert.equal(power.sizeCord(10, 1800, lib.config.power).ampacityOk, true, '15 A is within a 15 A plug');
  // 220 ft of incandescent C9 on a 20 A circuit, one outlet: 9 hung strings = 1,575 W through one timer and stake.
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(230, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const one = plan(project({ features: [eave], outlets: [outlet('out_a', F(110, 1.5), { label: 'Porch outlet' })], circuits: [circuit('cir_1', 20)] })).power;
  assert.equal(one.circuits[0].overloaded, false, 'the 20 A circuit itself is fine');
  const over = byCode(one, 'outlet-overload');
  assert.equal(over.length, 1);
  assert.equal(over[0].level, 'danger');
  assert.equal(over[0].outletId, 'out_a');
  assert.match(over[0].message, /^Porch outlet would feed [\d,]+ W through one outlet, timer and power stake, over the 1,440 W safe limit for 15 A plug-in gear \(80%\)\. Move a cord to another outlet/);
  assert.equal(one.outlets[0].limitW, 1440);
  assert.equal(one.outlets[0].overloaded, true);
  const tung = byCode(one, 'timer-tungsten');
  assert.equal(tung.length, 1);
  assert.match(tung[0].message, /incandescent/);
  // A second outlet on the same circuit takes the feeds that would overload the first one.
  const two = plan(project({ features: [eave], circuits: [circuit('cir_1', 20)],
    outlets: [outlet('out_a', F(110, 1.5), { label: 'Porch outlet' }), outlet('out_b', F(120, 1.5), { label: 'Side outlet' })] })).power;
  assert.deepEqual(byCode(two, 'outlet-overload'), []);
  assert.ok(two.outlets.every((o) => o.watts <= 1440), JSON.stringify(two.outlets.map((o) => o.watts)));
  assert.ok(two.outlets.every((o) => o.feedIds.length > 0), 'both outlets are used');
});

test('power stakes are daisy-chained from one timer socket: n stakes give 2n + 1 sockets', () => {
  const windows = (n) => Array.from({ length: n }, (_, i) => feature('ft_w' + i, 'window',
    [F(10 + i * 10, 15), F(15 + i * 10, 15), F(15 + i * 10, 10), F(10 + i * 10, 10)], { label: 'Window ' + (i + 1) }));
  const sockets = (stakes) => (stakes > 0 ? 2 * stakes + 1 : 1);
  for (const [n, want] of [[1, 0], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [7, 3], [8, 4], [13, 6]]) {
    const pw = plan(project({ features: windows(n), outlets: [outlet('out_a', F(5, 1.5))] })).power;
    assert.equal(pw.feeds.length, n);
    const o = pw.outlets[0];
    assert.equal(o.splitters, want, `${n} cords need ${want} chained 3-outlet stakes`);
    assert.ok(sockets(o.splitters) >= n, `${n} cords fit in ${sockets(o.splitters)} sockets`);
    assert.equal(byCode(pw, 'many-cords').length, n > 6 ? 1 : 0, `${n} cords`);
  }
});

test('sample house: cords and chain gaps between planes are measured in 3D, not with a direction-blind scale', { skip: !LP.has('sample') || !LP.has('measure') }, () => {
  const sample = LP.require('sample');
  const planMod = LP.require('plan');
  const s = sample.createSample();
  // One cord per run, so each length can be checked against the 3D model.
  const p = JSON.parse(JSON.stringify(s.project));
  p.library = { products: null, config: { power: { daisyChain: false } } };
  const out = planMod.computePlan(p);
  const pw = out.power;
  // Front-wall frame (u, v, w) of the 3D model: porch outlet (13, 1.5, 0), garage outlet (35, 1.5, -4).
  const cord = (ft) => (1.5 + ft) * 1.15 + 4;
  const feedFor = (runId) => pw.feeds.find((f) => f.runIds.includes(runId));
  // Walkway left edge runs from (15, 0, 1) to (15, 0, 16): the near end is 2.2 ft along the ground from the porch outlet.
  const walk = feedFor('run_ft_walk_left');
  assert.equal(walk.outletId, 'out_porch');
  close(walk.cord.lengthFt, cord(Math.hypot(2, 1)), 0.5);
  assert.match(walk.start.label, /end of Walkway left edge/);
  const walkRun = out.runs.find((r) => r.id === 'run_ft_walk_left');
  const near = walkRun.start, far = walkRun.end;
  const H = out.measured.planes.pl_yard.Himg2plane;
  assert.ok(g.applyH(H, near)[1] < g.applyH(H, far)[1], 'the feed starts at the end nearest the house');
  // Walkway right edge starts at (19, 0, 1). From the porch outlet the cord would pass the front door and the other
  // walkway edge, so it comes from the garage outlet on the other wall: 16.8 ft across the ground in 3D.
  const right = feedFor('run_ft_walk_right');
  assert.equal(right.outletId, 'out_garage');
  close(right.cord.lengthFt, cord(Math.hypot(16, 5)), 1);
  assert.equal(right.crossesDoorway || right.crossesWalkway, false);
  // Maple tree base (-10, 0, 12): 25.9 ft along the ground from the porch outlet.
  const tree = feedFor('run_ft_tree');
  close(tree.cord.lengthFt, cord(Math.hypot(23, 12)), 1);
  assert.deepEqual(tree.cord.pieces, [50]);
  // Eave right end (34, 10, 0) and garage gutter start (34, 9, -4) are 4.1 ft apart: more than chainGapFt (3), not chained.
  assert.notEqual(out.runs.find((r) => r.id === 'run_ft_garage_gutter').chainId, out.runs.find((r) => r.id === 'run_ft_eave').chainId);
});

test('a cord along the ground is flagged where it passes a traced door; a jumper through the door lights avoids it', () => {
  // Synthetic wall: outlet at u = 5, door from u = 20 to 23, a window to the right of the door.
  const door = feature('ft_door', 'door', [F(20, 0), F(20, 6.7), F(23, 6.7), F(23, 0)], { label: 'Front door' });
  const win = feature('ft_win', 'window', [F(30, 8), F(34, 8), F(34, 4), F(30, 4)], { label: 'Window right' });
  const left = feature('ft_wl', 'window', [F(8, 8), F(12, 8), F(12, 4), F(8, 4)], { label: 'Window left' });
  const p = project({ features: [door, win, left], outlets: [outlet('out_a', F(5, 1.5))] });
  // One cord per run: the cord to the right window lies on the ground in front of the door.
  const pw = plan(p, NO_CHAIN).power;
  const winFeed = feedOf(pw, 'run_ft_win');
  assert.equal(winFeed.crossesDoorway, true, 'the cord to the right window passes the doorway on the ground');
  assert.equal(winFeed.doorway, 'Front door');
  assert.equal(feedOf(pw, 'run_ft_wl').crossesDoorway, false);
  assert.equal(feedOf(pw, 'run_ft_door').crossesDoorway, false, 'the door lights themselves start at the door');
  const dw = byCode(pw, 'cord-doorway');
  assert.equal(dw.length, 1);
  assert.match(dw[0].message, /^The cord to the top-left corner of Window right runs along the ground in front of Front door\. Keep it tight against the doorstep under a cord cover so nobody trips, or use an outlet on the other side of the door\.$/);
  assert.equal(pw.counts.cordCovers, 1);
  // Linked runs: the door lights carry the power over the doorway, and the right window hangs off their end.
  const linked = plan(p).power;
  assert.deepEqual(feedOf(linked, 'run_ft_win').source, { kind: 'feed', feedId: 'feed_ft_door_1', port: 'end' });
  assert.equal(linked.counts.cordCovers, 0);
  assert.deepEqual(byCode(linked, 'cord-doorway'), []);
  assert.equal(linked.counts.homeRuns, 2, 'the door lights and the left window each get a cord; the right window gets a jumper');
});

test('sample house, one cord per run: Bush 2 is fed from the garage side; from the porch its cord would pass the door and the walkway', { skip: !LP.has('sample') || !LP.has('measure') }, () => {
  const base = LP.require('sample').createSample().project;
  const run = (powerCfg) => {
    const p = JSON.parse(JSON.stringify(base));
    p.library = { products: null, config: { power: powerCfg } };
    return LP.require('plan').computePlan(p);
  };
  // Crossings cost 12 ft each when cords are compared, so the planner goes around the doorway.
  const out = run({ daisyChain: false });
  const pw = out.power;
  const bush2 = feedOf(pw, 'run_ft_bush_2');
  assert.equal(bush2.outletId, 'out_garage');
  assert.equal(bush2.crossesDoorway || bush2.crossesWalkway, false);
  for (const id of ['run_ft_gable_left', 'run_ft_window_left', 'run_ft_bush_1']) {
    const f = feedOf(pw, id);
    assert.equal(f.crossesWalkway || f.crossesDoorway, false, id);
  }
  // The door lights start at the door's bottom-left corner (u 15.5), half a foot inside the walkway (u 15 to 19).
  // That cord stops at the jamb: it lies across no more than a foot of the walkway and not across its own
  // doorway, so it needs no cord cover (review finding U16; it used to count as crossing the walkway's left edge).
  assert.equal(feedOf(pw, 'run_ft_door').crossesDoorway, false);
  assert.equal(feedOf(pw, 'run_ft_door').crossesWalkway, false);
  assert.equal(pw.counts.cordCovers, 0);
  // Without the penalty the nearer porch outlet wins, and the crossings are flagged.
  const flat = run({ daisyChain: false, crossingPenaltyFt: 0 });
  const b2 = feedOf(flat.power, 'run_ft_bush_2');
  assert.equal(b2.outletId, 'out_porch');
  assert.equal(b2.crossesDoorway, true);
  assert.equal(b2.crossesWalkway, true);
  assert.ok(byCode(flat.power, 'cord-walkway').some((w) => /Bush 2/.test(w.message)));
  assert.ok(byCode(flat.power, 'cord-doorway').some((w) => /Bush 2/.test(w.message) && /Front door/.test(w.message)));
  const steps = flat.checklist.find((gr) => gr.outletId === 'out_porch').steps;
  assert.ok(steps.some((s) => /cord cover/.test(s) && /Front door/.test(s)), 'the checklist says where the cover goes');
});

test('mid-run feeds start where the hung strings end (string length, not string count); spare strings are not live load', () => {
  // 100 ft incandescent C9 eave: 110 ft with waste → 5 strings bought, but 4 × 25 ft cover the 100 ft.
  const eave = feature('ft_eave', 'roofline', [F(0, 20), F(100, 20)], { label: 'Eave', productId: 'c9-incan' });
  const { runs, power: pw } = plan(project({ features: [eave], outlets: [outlet('out_a', F(0, 1.5))] }));
  assert.equal(runs[0].quantity, 5, 'the shopping list still buys 5 (one spare)');
  assert.deepEqual(pw.feeds.map((f) => f.strings), [3, 1], '4 hung strings: 3 + 1');
  assert.deepEqual(pw.feeds.map((f) => f.watts), [525, 175]);
  assert.equal(pw.feeds[1].start.label, 'point 75 ft from the left end of Eave', 'three 25 ft strings end at 75 ft');
  close(pw.feeds[1].start.point[0], F(75, 20)[0], 1e-6);
  // Three full strings pass nothing on (525 W is their limit), so the last string gets its own cord from the outlet:
  // 1.5 ft down, 75 ft along the ground, 20 ft up.
  assert.deepEqual(pw.feeds[1].source, { kind: 'outlet', outletId: 'out_a' });
  close(pw.feeds[1].cord.lengthFt, (1.5 + 75 + 20) * 1.15 + 4, 0.06);
  assert.deepEqual(pw.feeds[1].cord.pieces, [100, 15], 'the cord bought is long enough for the real feed point (about 115 ft)');
  assert.equal(pw.totals.watts, 700, 'live load is the 4 hung strings');
  assert.equal(pw.chains[0].strings, 4);
  assert.equal(pw.chains[0].spares, 1);
  // 300 ft eave: 14 strings bought, 12 cover the run → 4 feeds of 3, none for the 2 spares.
  const long = feature('ft_long', 'roofline', [F(0, 20), F(300, 20)], { label: 'Long eave', productId: 'c9-incan' });
  const p2 = plan(project({ features: [long], outlets: [outlet('out_a', F(0, 1.5))], circuits: [circuit('cir_1', 20)] }));
  assert.equal(p2.runs[0].quantity, 14);
  assert.deepEqual(p2.power.feeds.map((f) => f.strings), [3, 3, 3, 3]);
  assert.deepEqual(p2.power.feeds.map((f) => f.start.label), ['left end of Long eave', 'point 75 ft from the left end of Long eave',
    'point 150 ft from the left end of Long eave', 'point 225 ft from the left end of Long eave']);
});

test('checklist follows the power plan: the second cord goes to 75 ft, hangs the last hung string, and the spare is kept', () => {
  const bomMod = LP.require('bom');
  const planMod = LP.require('plan');
  const eave = feature('ft_eave', 'roofline', [F(0, 20), F(100, 20)], { label: 'Eave', productId: 'c9-incan' });
  const p = project({ features: [eave], outlets: [outlet('out_a', F(0, 1.5), { label: 'Outlet 1' })] });
  const { runs, power: pw } = plan(p);
  const steps = bomMod.buildChecklist(p, planMod.mergeRunInfo(runs, pw), pw, null)[0].steps;
  assert.ok(steps.includes('Cord 2 of 2: Run 115 ft of 16 AWG outdoor extension cord (100 ft + 15 ft, joined end to end) from Outlet 1 to the point 75 ft from the left end of Eave (about 115 ft needed): down 1.5 ft, 75 ft along the ground, up 20 ft. Keep the joints off the ground.'), steps.join('\n'));
  assert.ok(steps.some((s) => /^Hang the first 3 of the 4 × warm white C9 incandescent string/.test(s)), steps.join('\n'));
  assert.ok(steps.some((s) => /^Hang the last 1 of the 4 × warm white C9 incandescent string.*starting at the point 75 ft from the left end of Eave, working toward the right end of Eave\./.test(s)), steps.join('\n'));
  assert.ok(steps.some((s) => /Keep the 1 spare string/.test(s)), steps.join('\n'));
});

test('strings are counted along a chain, not rounded up run by run: a string carries on around the corner', () => {
  const bomMod = LP.require('bom');
  const planMod = LP.require('plan');
  // Two 9 ft gable rakes meeting at the peak: 19.8 ft with waste → 1 string (not 1 + 1).
  const left = feature('ft_gl', 'rake', [F(10, 10), F(17, 15.6)], { label: 'Gable left' });
  const right = feature('ft_gr', 'rake', [F(17, 15.6), F(24, 10)], { label: 'Gable right' });
  const p = project({ features: [left, right], outlets: [outlet('out_a', F(5, 1.5), { label: 'Outlet 1' })] });
  const { runs, power: pw } = plan(p);
  assert.deepEqual(runs.map((r) => r.quantity), [1, 1], 'design alone rounds each run up');
  assert.equal(pw.chains.length, 1);
  assert.equal(pw.runInfo.run_ft_gl.quantity + pw.runInfo.run_ft_gr.quantity, 1, 'one string covers both rakes');
  const merged = planMod.mergeRunInfo(runs, pw);
  assert.equal(merged.reduce((s, r) => s + r.quantity, 0), 1);
  const b = bomMod.buildBom(p, merged, pw, lib);
  assert.equal(b.lines.find((l) => l.sku === 'c9-led').qty, 1);
  const carried = merged.find((r) => r.quantity === 0);
  assert.match(carried.detail, /one continuous line/);
  const steps = bomMod.buildChecklist(p, merged, pw, null)[0].steps;
  assert.ok(steps.some((s) => /^Carry the last string of Gable (left|right) on along Gable (left|right)/.test(s)), steps.join('\n'));
  // Different colors cannot share a string: each run keeps its own.
  const red = feature('ft_gr', 'rake', [F(17, 15.6), F(24, 10)], { label: 'Gable right', color: { mode: 'multicolor' } });
  const p2 = plan(project({ features: [left, red], outlets: [outlet('out_a', F(5, 1.5))] }));
  assert.equal(p2.power.runInfo.run_ft_gl.quantity + p2.power.runInfo.run_ft_gr.quantity, 2);
});

test('sample house: the roofline chains buy 6 C9 LED strings, not 8', { skip: !LP.has('sample') || !LP.has('measure') }, () => {
  const out = LP.require('plan').computePlan(LP.require('sample').createSample().project);
  const c9 = out.runs.filter((r) => r.productId === 'c9-led');
  const chains = new Map();
  for (const r of c9) chains.set(r.chainId, (chains.get(r.chainId) || 0) + r.withWasteFt);
  const want = Array.from(chains.values()).reduce((s, ft) => s + Math.ceil(ft / 25 - 1e-9), 0);
  assert.equal(c9.reduce((s, r) => s + r.quantity, 0), want);
  assert.equal(out.bom.lines.find((l) => l.sku === 'c9-led').qty, want);
  assert.ok(want < 8, 'per-run rounding bought 8');
  assert.equal(out.summary.strings, out.runs.filter((r) => r.unit === 'string').reduce((s, r) => s + r.quantity, 0));
});

test('an outlet under the middle of a long run feeds it from the middle: one short cord, a tap, lights working outward both ways', () => {
  // 200 ft C9 LED eave at 12 ft, one outlet directly below its middle.
  const eave = feature('ft_eave', 'roofline', [F(10, 12), F(210, 12)], { label: 'Eave' });
  const { power: pw } = plan(project({ features: [eave], outlets: [outlet('out_a', F(110, 1.5), { label: 'Outlet 1' })] }));
  assert.equal(pw.feeds.length, 2, JSON.stringify(pw.feeds.map((f) => f.start.label)));
  for (const f of pw.feeds) close(f.start.point[0], F(110, 12)[0], 15);
  // One cord from the outlet (1.5 ft down, 12 ft up) ends in a 3-way tap; the other half plugs straight into the tap.
  const [a, b] = pw.feeds[0].source.kind === 'outlet' ? pw.feeds : [pw.feeds[1], pw.feeds[0]];
  assert.deepEqual(a.source, { kind: 'outlet', outletId: 'out_a' });
  close(a.cord.lengthFt, 13.5 * 1.15 + 4, 1.5);
  assert.deepEqual(b.source, { kind: 'feed', feedId: a.id, port: 'start' });
  assert.equal(b.plugIn, true);
  assert.equal(b.cord, null);
  assert.equal(a.taps, 1);
  assert.equal(pw.counts.taps, 1);
  assert.equal(pw.counts.homeRuns, 1);
  assert.equal(pw.outlets[0].splitters, 0);
  close(a.supplyW, 8 * 9.6, 1e-6);
  assert.deepEqual(byCode(pw, 'long-cord'), []);
  assert.equal(pw.feeds.reduce((s, f) => s + f.strings, 0), 8, '4 strings each way cover the 200 ft');
  assert.equal(pw.runInfo.run_ft_eave.quantity, 9, 'spares are counted over the chain: 220 ft with waste = 9 strings, not 5 + 5');
  assert.equal(pw.chains[0].spares, 1);
  assert.deepEqual(byCode(pw, 'max-end-to-end'), [], '8 strings are well within the limit of 30');
  assert.match(byCode(pw, 'fed-from-middle')[0].message, /^Eave is fed from the point nearest Outlet 1: one cord ends in a 3-way tap there and the lights run outward both ways/);
  const towards = pw.feeds.map((f) => f.start.toward).sort();
  assert.deepEqual(towards, ['left end of Eave', 'right end of Eave']);
  assert.deepEqual(pw.cords, [{ awg: 16, lengthFt: 25, count: 1 }]);
  // With one cord per feed (daisy chains off) two cords work outward from there, as before.
  const flat = plan(project({ features: [eave], outlets: [outlet('out_a', F(110, 1.5), { label: 'Outlet 1' })] }), NO_CHAIN).power;
  assert.equal(flat.feeds.length, 2);
  assert.ok(flat.feeds.every((f) => f.source.kind === 'outlet' && f.cord.pieces[0] === 25));
  assert.match(byCode(flat, 'fed-from-middle')[0].message, /^Eave is fed from the point nearest Outlet 1: 2 cords work outward from there/);
  // An outlet near one end still feeds from that end with one cord.
  const end = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(end.feeds.length, 1);
  assert.equal(end.feeds[0].start.label, 'left end of Eave');
  // A split that needs an extra string to save a few feet of cord is not worth it: 22 ft of eave is one 25 ft string
  // from either end, two strings when fed from the middle.
  const short = feature('ft_s', 'roofline', [F(10, 12), F(32, 12)], { label: 'Short eave' });
  const one = plan(project({ features: [short], outlets: [outlet('out_a', F(21, 1.5))] })).power;
  assert.equal(one.feeds.length, 1);
  assert.equal(one.runInfo.run_ft_s.quantity, 1);
  assert.deepEqual(byCode(one, 'fed-from-middle'), []);
});
