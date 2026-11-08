const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const g = LP.require('geometry');
const catalog = LP.require('catalog');
const design = LP.require('design');
const power = LP.require('power');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);
const lib = catalog.getLibrary(null);

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
  // 50 W LED at 80 ft: 0.42 A, 16 AWG drops 0.22%
  const c1 = power.sizeCord(80, 50, lib.config.power);
  assert.equal(c1.awg, 16);
  close(c1.voltageDropPct, 0.22, 0.01);
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
  // 220 ft eave → 242 ft with waste → 10 strings × 175 W = 1,750 W, max 3 end to end → feeds 3 + 3 + 3 + 1
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(230, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const one = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5), { label: 'Porch outlet' })], circuits: [circuit('cir_1', 15, { name: 'Porch circuit' })] }));
  const pw = one.power;
  assert.equal(one.runs[0].quantity, 10);
  assert.deepEqual(pw.feeds.map((f) => f.strings), [3, 3, 3, 1]);
  assert.deepEqual(pw.feeds.map((f) => f.watts), [525, 525, 525, 175]);
  assert.ok(pw.feeds.every((f) => f.outletId === 'out_a' && f.circuitId === 'cir_1'));
  assert.equal(pw.circuits[0].loadW, 1750);
  assert.equal(pw.circuits[0].overloaded, true);
  close(pw.circuits[0].utilizationPct, 121.5, 0.05);
  const over = byCode(pw, 'circuit-overload');
  assert.equal(over.length, 1);
  assert.equal(over[0].level, 'danger');
  assert.equal(over[0].circuitId, 'cir_1');
  assert.equal(over[0].message, 'Porch circuit would carry 1,750 W, over the 1,440 W safe limit for a 15 A breaker (80%). Move a run to another circuit or switch to LED.');
  assert.equal(pw.warnings[0].code, 'circuit-overload'); // danger sorts first
  assert.match(byCode(pw, 'incandescent')[0].message, /Front eave uses incandescent lights .*10 strings draw 1,750 W\. The LED version \(C9 LED string, 25 bulbs\) would draw about 96 W/);
  assert.match(byCode(pw, 'max-end-to-end')[0].message, /^Front eave needs 4 feeds: .* allows only 3 strings end to end and this run uses 10\.$/);
  assert.equal(pw.counts.splitters, 2);   // 4 feeds on one outlet → ceil(4 / 3)
  assert.equal(pw.counts.timers, 1);

  // A second outlet on another circuit, almost as close: the third 525 W feed moves there.
  const two = plan(project({
    features: [eave],
    outlets: [outlet('out_a', F(5, 1.5)), outlet('out_b', F(3, 1.5), { circuitId: 'cir_2' })],
    circuits: [circuit('cir_1', 15), circuit('cir_2', 20)],
  })).power;
  assert.deepEqual(byCode(two, 'circuit-overload'), []);
  assert.deepEqual(two.feeds.map((f) => f.outletId), ['out_a', 'out_a', 'out_b', 'out_a']);
  assert.deepEqual(two.circuits.map((c) => c.loadW), [1225, 525]);
  assert.ok(two.circuits.every((c) => !c.overloaded));
});

test('7 incandescent C9 strings → 3 feeds (max 3 end to end), split along the run', () => {
  // 150 ft → 165 ft with waste → 7 strings
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(160, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const { runs, power: pw } = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] }));
  assert.equal(runs[0].quantity, 7);
  assert.equal(pw.chains.length, 1);
  assert.equal(pw.chains[0].strings, 7);
  assert.equal(pw.feeds.length, 3);
  assert.deepEqual(pw.feeds.map((f) => f.strings), [3, 3, 1]);
  assert.deepEqual(pw.chains[0].feedIds, pw.feeds.map((f) => f.id));
  assert.deepEqual(pw.feeds.map((f) => f.id), ['feed_ft_eave_1', 'feed_ft_eave_2', 'feed_ft_eave_3']);
  // feed starts at the left end (nearest the outlet), then 3/7 and 6/7 of the way along
  assert.deepEqual(pw.feeds[0].start.point, F(10, 20));
  assert.equal(pw.feeds[0].start.label, 'left end of Front eave');
  const p2 = pw.feeds[1].start.point, p3 = pw.feeds[2].start.point;
  close(p2[0], F(10 + 150 * 3 / 7, 20)[0], 1e-6); close(p2[1], 800, 1e-6);
  close(p3[0], F(10 + 150 * 6 / 7, 20)[0], 1e-6);
  assert.equal(pw.feeds[1].start.label, 'point 64 ft from the left end of Front eave');
  assert.equal(pw.feeds[1].start.planeId, 'pl_front');
  assert.equal(pw.feeds[1].start.imageId, 'img_1');
  const info = byCode(pw, 'max-end-to-end');
  assert.equal(info.length, 1);
  assert.equal(info[0].level, 'info');
  assert.match(info[0].message, /^Front eave needs 3 feeds: C9 incandescent string, 25 bulbs \(7 W\) allows only 3 strings end to end and this run uses 7\.$/);
  assert.deepEqual(pw.runInfo.run_ft_eave.feedIds, pw.chains[0].feedIds);
});

test('LED runs within maxEndToEnd stay on one feed', () => {
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(160, 20)]);
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(pw.feeds.length, 1);
  assert.equal(pw.feeds[0].strings, 7);
  close(pw.feeds[0].watts, 67.2, 1e-9);
  close(pw.feeds[0].amps, 0.56, 1e-9);
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
  assert.equal(ab.strings, 4);                                     // 2 + 2 C9 LED strings
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
  assert.deepEqual(pw.counts, { timers: 0, splitters: 0, cordCovers: 0, gfciAdapters: 0 });
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

test('timers: one per outlet with feeds; splitters: ceil(feeds / 3) on outlets with more than one feed', () => {
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
  assert.match(over.message, /^The circuit for Porch outlet would carry 1,750 W, over the 1,440 W safe limit for a 15 A breaker \(80%\)\./);
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
test('same-plane cord: |du| + |dv| routed down the wall and across, × routing factor + slack', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  const f = pw.feeds[0];
  // |10 − 5| + |20 − 1.5| = 23.5 ft → 23.5 × 1.15 + 4 = 31.0 ft
  close(f.cord.lengthFt, 31.0, 0.05);
  assert.equal(f.cord.awg, 16);
  assert.deepEqual(f.cord.pieces, [50]);
  assert.equal(f.cordPath.length, 3);
  assert.deepEqual(f.cordPath[0], F(5, 1.5));
  close(f.cordPath[1][0], F(10, 1.5)[0], 1e-6); close(f.cordPath[1][1], F(10, 1.5)[1], 1e-6);
  assert.deepEqual(f.cordPath[2], F(10, 20));
  assert.deepEqual(pw.cords, [{ awg: 16, lengthFt: 50, count: 1 }]);
  assert.equal(f.crossesWalkway, false);
});

test('outlet without a plane uses the feed plane scale; cross-plane cords add 30%', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const noPlane = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5), { planeId: null })] })).power;
  const px = g.dist(F(5, 1.5), F(10, 20));
  close(noPlane.feeds[0].cord.lengthFt, px * 0.1 * 1.3 * 1.15 + 4, 0.05);
  assert.equal(noPlane.feeds[0].cordPath.length, 2);
  // feed on the side wall (0.2 ft/px), outlet on the front wall (0.1 ft/px): mean scale 0.15
  const side = feature('ft_s', 'roofline', [[2000, 800], [2100, 800]], { planeId: 'pl_side' });
  const cross = plan(project({ features: [side], outlets: [outlet('out_a', [1900, 985])] })).power;
  close(cross.feeds[0].cord.lengthFt, g.dist([1900, 985], [2000, 800]) * 0.15 * 1.3 * 1.15 + 4, 0.05);
});

test('1,500 W feed with a ~95 ft cord: 12 AWG and a voltage-drop warning; long cords get pieces and a warning', () => {
  const custom = catalog.deepClone(lib);
  custom.products.push({ id: 'big-c9', sku: 'big-c9', name: 'Big C9 string', category: 'c9', tech: 'LED', unit: 'string',
    bulbSpacingIn: 12, stringLengthFt: 10, leadFt: 1, bulbsPerUnit: 10, wattsPerUnit: 150, maxEndToEnd: 20, price: 10,
    colors: ['warmWhite'], clipEligible: true, enabled: true, suitableFor: ['roofline'] });
  // 90 ft → 99 ft with waste → 10 strings × 150 W = 1,500 W. Outlet 70 ft across and 9 ft below the left end.
  const eave = feature('ft_e', 'roofline', [F(100, 20), F(190, 20)], { label: 'Front eave', productId: 'big-c9' });
  const pw = plan(project({ features: [eave], outlets: [outlet('out_a', F(30, 11))], circuits: [circuit('cir_1', 20)] }), custom).power;
  const f = pw.feeds[0];
  assert.equal(f.watts, 1500);
  close(f.cord.lengthFt, 79 * 1.15 + 4, 0.06);  // 94.85 ft, stored to 0.1 ft
  assert.equal(f.cord.awg, 12);
  assert.ok(f.cord.voltageDropPct > 3);
  const vd = byCode(pw, 'voltage-drop');
  assert.equal(vd.length, 1);
  assert.match(vd[0].message, /^The 95 ft cord to the left end of Front eave would lose 3\.1% of its voltage even with 12 AWG cord \(limit 3%\)\. Use a closer outlet or split the run\.$/);
  assert.deepEqual(byCode(pw, 'long-cord'), []);

  // Long cord: 145 ft across + 18.5 ft up → 163.5 × 1.15 + 4 = 192 ft → two 100 ft cords
  const far = feature('ft_far', 'roofline', [F(150, 20), F(175, 20)], { label: 'Garage eave' });
  const pw2 = plan(project({ features: [far], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  close(pw2.feeds[0].cord.lengthFt, 192.0, 0.05);
  assert.deepEqual(pw2.feeds[0].cord.pieces, [100, 100]);
  assert.deepEqual(pw2.cords, [{ awg: 16, lengthFt: 100, count: 2 }]);
  assert.equal(byCode(pw2, 'long-cord')[0].message, 'The cord to the left end of Garage eave needs about 192 ft (100 ft + 100 ft). Look for a closer outlet.');
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
  close(pw.totals.watts, runs.reduce((s, r) => s + r.watts, 0), 1e-9);
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
  assert.deepEqual([...new Set(codes(pw))].sort(), ['circuit-overload', 'disclaimer', 'incandescent', 'long-cord', 'max-end-to-end', 'no-gfci']);
});
