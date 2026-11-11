// Phase 1.1 power planning (SPEC §8.1, §8.2): cords run down to the ground, along it, and up beside the
// openings; runs are linked into supply trees with jumper cords and 3-way taps.
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const g = LP.require('geometry');
const catalog = LP.require('catalog');
const design = LP.require('design');
const power = LP.require('power');
const measureMod = LP.require('measure');
const bomMod = LP.require('bom');
const planMod = LP.require('plan');
const FX = require('./power-fixtures');
const { lib, libWith, F, toFt, feature, outlet, circuit, project, plan, byCode, feedOf, kinds, checkPlan } = FX;
const { powerHouses } = require('./power-houses');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);
const NO_CHAIN = libWith({ daisyChain: false });
const pathFt = (feed) => feed.cordPath.map((p) => toFt(p).map((x) => Math.round(x * 100) / 100));
const homeRuns = (pw) => pw.feeds.filter((f) => f.source && f.source.kind === 'outlet');
const win = (id, u, v, w = 4, h = 4, opts = {}) => feature(id, 'window', [F(u, v + h), F(u + w, v + h), F(u + w, v), F(u, v)], Object.assign({ label: id }, opts));

// ------------------------------------------------------------------ §8.1 ground-first routes
test('a home run goes down to the ground, along it and straight up: never across the wall', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)], { label: 'Front eave' });
  const { power: pw } = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] }));
  const f = pw.feeds[0];
  assert.deepEqual(f.source, { kind: 'outlet', outletId: 'out_a' });
  assert.equal(f.cord.kind, 'home');
  assert.deepEqual(kinds(f), ['drop', 'ground', 'rise']);
  assert.deepEqual(f.cord.route.map((s) => Math.round(s.lengthFt * 10) / 10), [1.5, 5, 20]);
  // (1.5 + 5 + 20) × 1.15 + 4 ft of slack
  close(f.cord.lengthFt, 26.5 * 1.15 + 4, 0.06);
  assert.deepEqual(pathFt(f), [[5, 1.5], [5, 0], [10, 0], [10, 20]]);
  assert.equal(f.cord.routeText, 'down 1.5 ft, 5 ft along the ground, up 20 ft');
  assert.deepEqual(f.cord.pieces, [50]);
});

test('a riser never passes through a window: it moves beside the opening and hops across at the top', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)], { label: 'Front eave', params: { reverse: false } });
  const w = win('ft_w', 8, 4, 4, 4, { label: 'Window left' });
  const { power: pw } = plan(project({ features: [eave, w], outlets: [outlet('out_a', F(5, 1.5))] }), NO_CHAIN);
  const f = feedOf(pw, 'run_ft_e');
  // The eave starts at u = 10, right above the window (u 8 to 12, v 4 to 8): the riser stands half a foot left of it.
  assert.deepEqual(kinds(f), ['drop', 'ground', 'rise', 'hop']);
  assert.deepEqual(pathFt(f), [[5, 1.5], [5, 0], [7.5, 0], [7.5, 20], [10, 20]]);
  assert.equal(f.cord.routeText, 'down 1.5 ft, 2.5 ft along the ground, up 20 ft beside Window left, 2.5 ft across');
  close(f.cord.lengthFt, (1.5 + 2.5 + 20 + 2.5) * 1.15 + 4, 0.06);
  // Lights around the window itself are reached by a riser beside it, not up its own edge.
  const fw = feedOf(pw, 'run_ft_w');
  assert.equal(fw.start.label, 'top-left corner of Window left');
  assert.deepEqual(pathFt(fw), [[5, 1.5], [5, 0], [7.5, 0], [7.5, 8], [8, 8]]);
  assert.match(fw.cord.routeText, /up 8 ft beside Window left, 0\.5 ft across$/);
  // An outlet on the other side picks the other side of the window.
  const right = plan(project({ features: [eave, w], outlets: [outlet('out_a', F(30, 1.5))] }), NO_CHAIN).power;
  assert.deepEqual(pathFt(feedOf(right, 'run_ft_e')), [[30, 1.5], [30, 0], [12.5, 0], [12.5, 20], [10, 20]]);
  assert.deepEqual(checkPlan(project({ features: [eave, w], outlets: [outlet('out_a', F(5, 1.5))] }), FX.measure(project({ features: [eave, w] })), pw, NO_CHAIN, { groundV: { pl_front: 0 } }), []);
});

test('stacked windows: the riser clears every opening between the ground and the lights', () => {
  const low = win('ft_low', 20, 3, 4, 4, { label: 'Kitchen window' });
  const high = win('ft_high', 18, 12, 5, 4, { label: 'Bedroom window' });
  // Traced right to left and forced to start at its last point: (21, 20), above both windows.
  const eave = feature('ft_e', 'roofline', [F(50, 20), F(21, 20)], { label: 'Eave', params: { reverse: true } });
  const p = project({ features: [low, high, eave], outlets: [outlet('out_a', F(40, 1.5))] });
  const { power: pw, measured } = plan(p, NO_CHAIN);
  // From the right: clear of the kitchen window is u 24.5, clear of the bedroom window is u 23.5 → 24.5 clears both.
  assert.deepEqual(pathFt(feedOf(pw, 'run_ft_e')), [[40, 1.5], [40, 0], [24.5, 0], [24.5, 20], [21, 20]]);
  assert.deepEqual(checkPlan(p, measured, pw, NO_CHAIN, { groundV: { pl_front: 0 } }), []);
});

test('targets within a foot of the ground need no riser; bushes, trees and columns are fed at their base', () => {
  // The bush is traced starting at its top; the column is traced top first.
  const bush = feature('ft_b', 'bush', [F(22, 2.5), F(24, 1.5), F(23.5, 0.1), F(22, 0), F(20.5, 0.1), F(20, 1.5)], { label: 'Boxwood' });
  const column = feature('ft_c', 'column', [F(30, 8), F(30, 0)], { label: 'Porch post' });
  const tree = feature('ft_t', 'tree', [F(40, 0), F(40, 10)], { label: 'Oak' });
  const p = project({ features: [bush, column, tree], outlets: [outlet('out_a', F(5, 1.5))] });
  const measured = FX.measure(p);
  measured.features.ft_b = Object.assign({}, measured.features.ft_b, { areaSqFt: 8, widthFt: 4, heightFt: 2.5 });
  measured.features.ft_c = Object.assign({}, measured.features.ft_c, { wrapFt: 30, lengthFt: 30, withWasteFt: 30, heightFt: 8 });
  measured.features.ft_t = Object.assign({}, measured.features.ft_t, { wrapFt: 40, lengthFt: 40, withWasteFt: 40, heightFt: 10 });
  const runs = design.planRuns(p, measured, NO_CHAIN);
  const pw = power.planPower(p, measured, runs, NO_CHAIN);
  const fb = feedOf(pw, 'run_ft_b'), fc = feedOf(pw, 'run_ft_c'), ft = feedOf(pw, 'run_ft_t');
  assert.equal(fb.start.label, 'base of Boxwood');
  assert.deepEqual(fb.start.point, F(22, 0));
  assert.deepEqual(kinds(fb), ['drop', 'ground']);
  assert.equal(fb.cord.routeText, 'down 1.5 ft, 17 ft along the ground');
  assert.equal(fc.start.label, 'base of Porch post');
  assert.deepEqual(fc.start.point, F(30, 0));
  assert.deepEqual(pw.runInfo.run_ft_c.start, F(30, 0));
  assert.deepEqual(pw.runInfo.run_ft_c.end, F(30, 8));
  assert.deepEqual(kinds(fc), ['drop', 'ground']);
  assert.deepEqual(ft.start.point, F(40, 0));
  close(ft.cord.lengthFt, (1.5 + 35) * 1.15 + 4, 0.06);
});

test('a wall with no ground plane: the ground is the lowest thing traced, or outletHeightFt below the outlets', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  // Nothing lower than the outlet: the ground is 1.5 ft below it (config.power.outletHeightFt).
  const a = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 4.5))] })).power.feeds[0];
  assert.deepEqual(pathFt(a), [[5, 4.5], [5, 3], [10, 3], [10, 20]]);
  assert.deepEqual(a.cord.route.map((s) => Math.round(s.lengthFt * 10) / 10), [1.5, 5, 17]);
  const b = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 4.5))] }), libWith({ outletHeightFt: 2.5 })).power.feeds[0];
  assert.deepEqual(pathFt(b), [[5, 4.5], [5, 2], [10, 2], [10, 20]]);
  // A door traced down to v = 0 sets the ground there.
  const door = feature('ft_d', 'door', [F(30, 0), F(30, 6.7), F(33, 6.7), F(33, 0)], { label: 'Door' });
  const c = feedOf(plan(project({ features: [eave, door], outlets: [outlet('out_a', F(5, 4.5))] }), NO_CHAIN).power, 'run_ft_e');
  assert.deepEqual(pathFt(c), [[5, 4.5], [5, 0], [10, 0], [10, 20]]);
});

test('the ground segment that passes a doorway is flagged, and the penalty picks the outlet on the lights\' side', () => {
  const door = feature('ft_door', 'door', [F(20, 0), F(20, 6.7), F(23, 6.7), F(23, 0)], { label: 'Front door' });
  const post = feature('ft_post', 'column', [F(26, 0), F(26, 8)], { label: 'Porch post' });
  const outs = [outlet('out_left', F(17, 1.5), { label: 'Left outlet' }), outlet('out_right', F(38, 1.5), { label: 'Right outlet' })];
  const p = project({ features: [door, post], outlets: outs });
  const measured = FX.measure(p);
  measured.features.ft_post = Object.assign({}, measured.features.ft_post, { wrapFt: 30, lengthFt: 30, withWasteFt: 30, heightFt: 8 });
  const go = (l) => power.planPower(p, measured, design.planRuns(p, measured, l), l);
  // Left outlet: 9 ft away but past the door (10.5 ft routed → 16.1 ft of cord + 12 ft penalty).
  // Right outlet: 12 ft away, nothing in between (13.5 ft routed → 19.5 ft of cord).
  const pw = go(NO_CHAIN);
  const f = feedOf(pw, 'run_ft_post');
  assert.equal(f.outletId, 'out_right');
  assert.equal(f.crossesDoorway, false);
  close(f.cord.lengthFt, 13.5 * 1.15 + 4, 0.06);
  assert.equal(pw.counts.cordCovers, 0);
  // Without the penalty the nearer outlet wins, the crossing is flagged, and the cord is not charged for the penalty.
  const flat = go(libWith({ daisyChain: false, crossingPenaltyFt: 0 }));
  const f2 = feedOf(flat, 'run_ft_post');
  assert.equal(f2.outletId, 'out_left');
  assert.equal(f2.crossesDoorway, true);
  assert.equal(f2.doorway, 'Front door');
  close(f2.cord.lengthFt, 10.5 * 1.15 + 4, 0.06);
  assert.match(f2.cord.routeText, /9 ft along the ground past Front door/);
  assert.equal(flat.counts.cordCovers, 1);
  assert.equal(byCode(flat, 'cord-doorway').length, 1);
  // The door's own lights start at the corner nearest the outlet and do not "pass" their own doorway.
  assert.equal(feedOf(pw, 'run_ft_door').crossesDoorway, false);
});

test('no calibrated plane at one end: the photo distance is scaled; none at either end: the cord is unknown', () => {
  const eave = feature('ft_e', 'roofline', [F(10, 20), F(60, 20)]);
  const noPlane = plan(project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5), { planeId: null })] })).power.feeds[0];
  // Outlet → the foot of the riser, scaled by the wall (0.1 ft per px) × 1.3, then 20 ft up.
  const px = g.dist(F(5, 1.5), F(10, 0));
  close(noPlane.cord.lengthFt, (px * 0.1 * 1.3 + 20) * 1.15 + 4, 0.06);
  assert.deepEqual(kinds(noPlane), ['ground', 'rise']);
  assert.equal(noPlane.cordUnknown, false);
  const a = feature('ft_a', 'roofline', [[100, 200], [400, 200]], { planeId: 'pl_back', overrideFt: 30, label: 'Back eave' });
  const pw = plan(project({ features: [a], outlets: [outlet('out_a', [90, 900], { planeId: 'pl_back' })] })).power;
  assert.equal(pw.feeds[0].outletId, 'out_a');
  assert.equal(pw.feeds[0].cord, null);
  assert.equal(pw.feeds[0].cordUnknown, true);
  assert.equal(byCode(pw, 'cord-unknown').length, 1);
});

// ------------------------------------------------------------------ §8.2 supply trees
test('nearby runs are linked with jumpers: one cord goes back to the outlet', () => {
  const wins = [0, 1, 2, 3].map((i) => win('ft_w' + i, 10 + i * 10, 3, 4, 4, { label: 'Window ' + (i + 1) }));
  const p = project({ features: wins, outlets: [outlet('out_a', F(5, 1.5), { label: 'Porch outlet' })] });
  const { power: pw, measured, runs } = plan(p);
  assert.equal(pw.feeds.length, 4);
  assert.equal(homeRuns(pw).length, 1);
  assert.equal(pw.counts.homeRuns, 1);
  assert.equal(pw.counts.jumpers, 3);
  assert.equal(pw.counts.splitters, 0, 'one home run needs no power stake');
  assert.equal(pw.counts.timers, 1);
  assert.equal(pw.outlets[0].feedIds.length, 4);
  assert.deepEqual(pw.outlets[0].directFeedIds, ['feed_ft_w0_1']);
  assert.equal(pw.outlets[0].needsSplitter, false);
  close(pw.outlets[0].watts, 4 * 4.8, 1e-9);
  close(pw.circuits[0].loadW, 4 * 4.8, 1e-9);
  // Each window hangs off the end of the one before it: the load passes through the strings.
  const f = (i) => feedOf(pw, 'run_ft_w' + i);
  assert.deepEqual(f(1).source, { kind: 'feed', feedId: 'feed_ft_w0_1', port: 'end' });
  assert.deepEqual(f(3).source, { kind: 'feed', feedId: 'feed_ft_w2_1', port: 'end' });
  assert.deepEqual([0, 1, 2, 3].map((i) => f(i).depth), [0, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map((i) => Math.round(f(i).supplyW * 10) / 10), [19.2, 14.4, 9.6, 4.8]);
  assert.deepEqual([0, 1, 2, 3].map((i) => Math.round(f(i).throughW * 10) / 10), [14.4, 9.6, 4.8, 0]);
  assert.equal(pw.counts.taps, 0, 'one jumper on an end plug needs no tap');
  // The jumper runs along the top of one window, down beside it, 5 ft along the ground and up beside the next.
  assert.equal(f(1).cord.kind, 'jumper');
  assert.deepEqual(kinds(f(1)), ['hop', 'drop', 'ground', 'rise', 'hop']);
  assert.deepEqual(pathFt(f(1)), [[10, 7], [14.5, 7], [14.5, 0], [19.5, 0], [19.5, 7], [20, 7]]);
  close(f(1).cord.lengthFt, (4.5 + 7 + 5 + 7 + 0.5) * 1.15 + 1.5, 0.06);
  assert.equal(f(1).cord.routeText, '4.5 ft across, down 7 ft beside Window 1, 5 ft along the ground, up 7 ft beside Window 2, 0.5 ft across');
  assert.equal(pw.groups.length, 1);
  assert.deepEqual(pw.groups[0].feedIds, ['feed_ft_w0_1', 'feed_ft_w1_1', 'feed_ft_w2_1', 'feed_ft_w3_1']);
  assert.equal(pw.groups[0].outletId, 'out_a');
  close(pw.groups[0].watts, 19.2, 1e-6);
  assert.equal(pw.runInfo.run_ft_w2.sourceFeedId, 'feed_ft_w1_1');
  assert.equal(pw.runInfo.run_ft_w0.sourceFeedId, null);
  assert.equal(pw.runInfo.run_ft_w3.outletId, 'out_a');
  const info = byCode(pw, 'daisy-chain');
  assert.equal(info.length, 1);
  assert.equal(info[0].level, 'info');
  assert.equal(info[0].message, '4 runs are linked with 3 jumper cords; 1 cord goes back to Porch outlet.');
  assert.deepEqual(checkPlan(p, measured, pw, lib, { runs, groundV: { pl_front: 0 } }), []);
});

test('daisyChain: false gives every feed its own ground-first cord from the outlet', () => {
  const wins = [0, 1, 2, 3].map((i) => win('ft_w' + i, 10 + i * 10, 3, 4, 4));
  const p = project({ features: wins, outlets: [outlet('out_a', F(5, 1.5))] });
  const { power: pw, measured, runs } = plan(p, NO_CHAIN);
  assert.equal(homeRuns(pw).length, 4);
  assert.equal(pw.counts.jumpers, 0);
  assert.equal(pw.counts.taps, 0);
  assert.equal(pw.outlets[0].splitters, 2);
  assert.deepEqual(pw.outlets[0].directFeedIds.length, 4);
  for (const f of pw.feeds) {
    assert.equal(f.parentFeedId, null);
    assert.equal(f.cord.route[0].kind, 'drop');
    assert.equal(f.throughW, 0);
  }
  assert.deepEqual(byCode(pw, 'daisy-chain'), []);
  assert.deepEqual(checkPlan(p, measured, pw, NO_CHAIN, { runs, groundV: { pl_front: 0 } }), []);
});

test('params.ownCord gives a run its own cord from the outlet and keeps other runs off it', () => {
  const mk = (own) => [win('ft_w0', 10, 2), win('ft_w1', 16, 2, 4, 4, { params: { ownCord: own } }), win('ft_w2', 22, 2)];
  const linked = plan(project({ features: mk(false), outlets: [outlet('out_a', F(5, 1.5))] })).power;
  assert.equal(homeRuns(linked).length, 1);
  const own = plan(project({ features: mk(true), outlets: [outlet('out_a', F(5, 1.5))] })).power;
  const f1 = feedOf(own, 'run_ft_w1');
  assert.deepEqual(f1.source, { kind: 'outlet', outletId: 'out_a' });
  assert.deepEqual(f1.childFeedIds, []);
  // Window 3 hangs off window 1 (a 29 ft jumper), not off the own-cord run 2 ft beside it.
  assert.deepEqual(feedOf(own, 'run_ft_w2').source, { kind: 'feed', feedId: 'feed_ft_w0_1', port: 'end' });
  close(feedOf(own, 'run_ft_w2').cord.lengthFt, (4.5 + 6 + 7 + 6 + 0.5) * 1.15 + 1.5, 0.06);
  assert.equal(homeRuns(own).length, 2);
  // Stored projects keep the flag; it is optional (missing means false), so older projects stay as they are.
  const schema = LP.require('schema');
  assert.equal('ownCord' in schema.createFeature('window', {}).params, false);
  const norm = (v) => schema.normalizeProject({ features: [{ id: 'f', type: 'window', params: { ownCord: v } }] }).features[0].params;
  assert.equal(norm(true).ownCord, true);
  assert.equal(norm(false).ownCord, false);
  assert.equal('ownCord' in norm('yes'), false);
  const bad = schema.normalizeProject(project({ features: mk(true) }));
  assert.equal(schema.validateProject(bad).ok, true, schema.validateProject(bad).errors.join('; '));
  bad.features[1].params.ownCord = 'yes';
  assert.match(schema.validateProject(bad).errors.join('; '), /"ownCord" must be true or false/);
  assert.equal(schema.JSON_SCHEMA.$defs.featureParams.properties.ownCord.type, 'boolean');
  assert.equal(schema.JSON_SCHEMA.$defs.featureParams.required.includes('ownCord'), false);
});

test('params.outletId forces a home run from that outlet; other runs may still hang off it', () => {
  const feats = [win('ft_w0', 10, 3), win('ft_w1', 20, 3, 4, 4, { params: { outletId: 'out_far' } }), win('ft_w2', 30, 3)];
  const outs = [outlet('out_a', F(5, 1.5)), outlet('out_far', F(90, 1.5), { circuitId: 'cir_2' })];
  const pw = plan(project({ features: feats, outlets: outs, circuits: [circuit('cir_1'), circuit('cir_2', 20)] })).power;
  const f1 = feedOf(pw, 'run_ft_w1');
  assert.deepEqual(f1.source, { kind: 'outlet', outletId: 'out_far' });
  assert.equal(f1.circuitId, 'cir_2');
  assert.equal(f1.cord.kind, 'home');
  assert.equal(feedOf(pw, 'run_ft_w0').outletId, 'out_a');
  // Window 3 is nearer the forced run than anything on out_a.
  assert.deepEqual(feedOf(pw, 'run_ft_w2').source, { kind: 'feed', feedId: f1.id, port: 'end' });
  assert.equal(feedOf(pw, 'run_ft_w2').circuitId, 'cir_2');
});

test('jumperMaxFt caps the jumper length: farther runs get their own cord', () => {
  const feats = [win('ft_w0', 10, 3), win('ft_w1', 30, 3)];
  const p = project({ features: feats, outlets: [outlet('out_a', F(5, 1.5))] });
  // Jumper: 4.5 + 7 + 15 + 7 + 0.5 = 34 ft routed → 40.6 ft of cord: over the 30 ft default.
  assert.equal(homeRuns(plan(p).power).length, 2);
  const far = plan(p, libWith({ jumperMaxFt: 45 })).power;
  assert.equal(homeRuns(far).length, 1);
  close(feedOf(far, 'run_ft_w1').cord.lengthFt, 34 * 1.15 + 1.5, 0.06);
  assert.deepEqual(feedOf(far, 'run_ft_w1').cord.pieces, [50]);
});

test('short jumpers: straight across a corner, or an L along the wall that misses the openings', () => {
  // Eave end at (30, 10); a window whose top-left corner is 3 ft below and 2 ft to the right.
  const eave = feature('ft_e', 'roofline', [F(10, 10), F(30, 10)], { label: 'Eave' });
  const w = win('ft_w', 32, 3, 4, 4, { label: 'Window' });
  const pw = plan(project({ features: [eave, w], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  const fw = feedOf(pw, 'run_ft_w');
  assert.deepEqual(fw.source, { kind: 'feed', feedId: 'feed_ft_e_1', port: 'end' });
  assert.deepEqual(kinds(fw), ['direct']);
  close(fw.cord.lengthFt, Math.hypot(2, 3) * 1.15 + 1.5, 0.06);
  assert.deepEqual(fw.cord.pieces, [6]);
  assert.match(fw.cord.routeText, /^straight across, 3\.5 ft$/);
  // 8 ft below: too far for a straight hop, so the jumper steps across at eave height and drops down the wall (an L).
  const low = win('ft_w', 32, -2, 4, 4, { label: 'Window' });
  const pw2 = plan(project({ features: [eave, low], outlets: [outlet('out_a', F(5, 5))] })).power;
  const f2 = feedOf(pw2, 'run_ft_w');
  assert.deepEqual(kinds(f2), ['wall', 'wall']);
  close(f2.cord.lengthFt, (8 + 2) * 1.15 + 1.5, 0.06);
  assert.deepEqual(pathFt(f2), [[30, 10], [32, 10], [32, 2]]);
  assert.equal(f2.cord.routeText, '2 ft across, down 8 ft');
});

test('3-way taps: a start junction needs one per two jumpers, an end plug takes one jumper without a tap', () => {
  // A 20 ft railing 5 ft up with its own outlet, and k short posts 3 ft from one of its ends, 120° apart so each
  // is nearer that end than the other posts.
  const rail = feature('ft_rail', 'roofline', [F(20, 5), F(40, 5)], { label: 'Railing', params: { outletId: 'out_a' } });
  const posts = (cu, side, k) => [[cu + side * 3, 5], [cu - side * 1.5, 7.6], [cu - side * 1.5, 2.4]].slice(0, k)
    .map(([u, v], i) => feature('ft_p' + i, 'column', [F(u, v), F(u, v + 1)], { label: 'Post ' + (i + 1) }));
  const go = (cu, side, k) => {
    const p = project({ features: [rail].concat(posts(cu, side, k)), outlets: [outlet('out_a', F(19, 1.5))] });
    const measured = FX.measure(p);
    for (let i = 0; i < k; i++) measured.features['ft_p' + i] = Object.assign({}, measured.features['ft_p' + i], { wrapFt: 10, lengthFt: 10, withWasteFt: 10, heightFt: 1 });
    const runs = design.planRuns(p, measured, lib);
    const pw = power.planPower(p, measured, runs, lib);
    assert.deepEqual(checkPlan(p, measured, pw, lib, { runs }), []);
    return pw;
  };
  // Posts around the far end (40, 5): they plug into the end of the railing lights.
  for (const [k, taps] of [[1, 0], [2, 1], [3, 1]]) {
    const pw = go(40, 1, k);
    const r = feedOf(pw, 'run_ft_rail');
    assert.deepEqual(r.start.point, F(20, 5));
    assert.equal(r.childFeedIds.length, k);
    assert.ok(pw.feeds.filter((f) => f !== r).every((f) => f.source.kind === 'feed' && f.source.port === 'end'), `end, k = ${k}`);
    assert.equal(r.taps, taps, `${k} jumpers on the end plug`);
    assert.equal(pw.counts.taps, taps);
    close(r.throughW, k * 7.2, 1e-6);
  }
  // Posts around the start (20, 5), where the cord meets the lights: a tap there feeds them.
  for (const [k, taps] of [[1, 1], [2, 1], [3, 2]]) {
    const pw = go(20, -1, k);
    const r = feedOf(pw, 'run_ft_rail');
    assert.deepEqual(r.start.point, F(20, 5));
    assert.ok(pw.feeds.filter((f) => f !== r).every((f) => f.source.kind === 'feed' && f.source.feedId === r.id && f.source.port === 'start'), `start, k = ${k}`);
    assert.equal(r.taps, taps, `${k} jumpers at the start`);
    assert.equal(r.throughW, 0);
    close(r.supplyW, r.watts + k * 7.2, 1e-6);
  }
});

test('incandescent C9: a full string run passes nothing on, so the next feed needs a start tap or its own cord', () => {
  // 150 ft of 7 W C9: 6 strings hung, two feeds of 3 (525 W each, the most three strings may carry).
  const eave = feature('ft_eave', 'roofline', [F(10, 20), F(160, 20)], { label: 'Front eave', productId: 'c9-incan' });
  const p = project({ features: [eave], outlets: [outlet('out_a', F(5, 1.5))] });
  const { power: pw, measured, runs } = plan(p);
  assert.deepEqual(pw.feeds.map((f) => f.watts), [525, 525]);
  // The second feed starts where the first ends, but it cannot plug into it: both get a cord from the outlet.
  assert.deepEqual(pw.feeds.map((f) => f.source.kind), ['outlet', 'outlet']);
  assert.deepEqual(pw.feeds.map((f) => f.throughW), [0, 0]);
  assert.deepEqual(checkPlan(p, measured, pw, lib, { runs, groundV: { pl_front: 0 } }), []);
  assert.deepEqual(byCode(pw, 'pass-through'), []);

  // A mini-light window right under the start of a 75 ft incandescent eave: the eave (525 W) cannot go through the
  // window's string (rated 43 × 4.8 = 206 W), so it plugs into a tap where the window's cord arrives.
  const short = feature('ft_eave', 'roofline', [F(10, 12), F(85, 12)], { label: 'Front eave', productId: 'c9-incan' });
  const w = win('ft_w', 10, 6, 4, 4, { label: 'Window' });
  const p2 = project({ features: [short, w], outlets: [outlet('out_a', F(5, 1.5))] });
  const r2 = plan(p2);
  const fe = feedOf(r2.power, 'run_ft_eave'), fw = feedOf(r2.power, 'run_ft_w');
  assert.deepEqual(fw.source, { kind: 'outlet', outletId: 'out_a' });
  assert.deepEqual(fe.source, { kind: 'feed', feedId: fw.id, port: 'start' });
  assert.equal(fw.taps, 1);
  assert.equal(fw.throughW, 0);
  close(fw.supplyW, 525 + 4.8, 1e-6);
  assert.equal(r2.power.counts.taps, 1);
  // The window's cord carries both: 529.8 W.
  assert.equal(fw.cord.awg, 16);
  assert.deepEqual(checkPlan(p2, r2.measured, r2.power, lib, { runs: r2.runs, groundV: { pl_front: 0 } }), []);

  // A product that states its own limit: maxConnectedW wins over maxEndToEnd × watts.
  const custom = catalog.deepClone(lib);
  custom.products.find((x) => x.id === 'mini-led-100').maxConnectedW = 600;
  const r3 = plan(p2, custom);
  assert.deepEqual(feedOf(r3.power, 'run_ft_eave').source, { kind: 'feed', feedId: fw.id, port: 'end' });
  assert.equal(r3.power.counts.taps, 0);
});

test('voltage drop adds up along the cords of a path; a path over the limit is flagged where it first goes over', () => {
  // Two 125 ft C7 incandescent eaves (625 W each, the most 5 strings may carry) 16 ft apart and 3 ft up.
  // The left one is forced to start at its right end (64, 3), 59 ft from the outlet.
  const y = feature('ft_y', 'roofline', [F(-61, 3), F(64, 3)], { label: 'Left eave', productId: 'c7-incan', params: { reverse: true } });
  const x = feature('ft_x', 'roofline', [F(80, 3), F(205, 3)], { label: 'Right eave', productId: 'c7-incan' });
  const p = project({ features: [y, x], outlets: [outlet('out_a', F(5, 1.5))] });
  const { power: pw, measured, runs } = plan(p);
  const fy = feedOf(pw, 'run_ft_y'), fx = feedOf(pw, 'run_ft_x');
  assert.deepEqual(fy.source, { kind: 'outlet', outletId: 'out_a' });
  assert.deepEqual(fx.source, { kind: 'feed', feedId: fy.id, port: 'start' });
  // Home run: (1.5 + 59 + 3) × 1.15 + 4 = 77 ft → a 100 ft cord carrying 1,250 W: 12 AWG, 2.76%.
  assert.deepEqual(fy.cord.pieces, [100]);
  assert.equal(fy.supplyW, 1250);
  assert.equal(fy.cord.awg, 12);
  close(fy.cord.voltageDropPct, 2.76, 0.01);
  close(fy.pathDropPct, 2.76, 0.01);
  // Jumper: (3 + 16 + 3) × 1.15 + 1.5 = 26.8 ft → a 50 ft cord carrying 625 W. On its own 16 AWG would do (1.74%),
  // but the path is already at 2.76%, so it is bought as thick as cords come: 12 AWG, 0.69%.
  assert.deepEqual(fx.cord.pieces, [50]);
  assert.equal(fx.cord.awg, 12);
  close(fx.cord.voltageDropPct, 0.69, 0.01);
  close(fx.pathDropPct, fy.cord.voltageDropPct + fx.cord.voltageDropPct, 0.011);
  const vd = byCode(pw, 'voltage-drop');
  assert.equal(vd.length, 1);
  assert.equal(vd[0].featureId, 'ft_x');
  assert.match(vd[0].message, /^The lights at the left end of Right eave are fed through 2 cords in a row that lose 3\.[45]% of the voltage in total \(limit 3%\)\./);
  assert.deepEqual(checkPlan(p, measured, pw, lib, { runs, groundV: { pl_front: 0 }, allowNoDrop: true }), []);
});

test('two plugs within a foot need no jumper cord: the second run plugs straight in', () => {
  // A C9 eave ends at the corner where mini-light icicles start (another product, so they are not one chain).
  const eave = feature('ft_e', 'roofline', [F(10, 10), F(30, 10)], { label: 'Eave' });
  const ice = feature('ft_i', 'roofline', [F(30.5, 10), F(45, 10)], { label: 'Icicles', productId: 'icicle-led-300' });
  const pw = plan(project({ features: [eave, ice], outlets: [outlet('out_a', F(5, 1.5))] })).power;
  const fi = feedOf(pw, 'run_ft_i');
  assert.deepEqual(fi.source, { kind: 'feed', feedId: 'feed_ft_e_1', port: 'end' });
  assert.equal(fi.plugIn, true);
  assert.equal(fi.cord, null);
  assert.equal(fi.cordUnknown, false);
  assert.equal(pw.counts.jumpers, 0);
  assert.deepEqual(pw.cords, [{ awg: 16, lengthFt: 25, count: 1 }]);
  assert.equal(pw.counts.taps, 0);
  assert.equal(pw.counts.homeRuns, 1);
  assert.deepEqual(pw.outlets[0].feedIds.length, 2);
});

// ------------------------------------------------------------------ real planes: ground, roof, a second wall
test('sample house: 12 cords and 6 power stakes become a few home runs with jumpers; nothing crosses a window or the door', { skip: !LP.has('sample') }, () => {
  const s = LP.require('sample').createSample();
  const out = planMod.computePlan(s.project);
  const pw = out.power;
  assert.ok(pw.feeds.length >= 12);
  assert.ok(pw.feeds.every((f) => f.outletId), 'every feed is powered');
  const homes = homeRuns(pw).length;
  assert.ok(homes <= 5, `${homes} home runs (was 12)`);
  assert.equal(pw.counts.homeRuns, homes);
  assert.ok(pw.counts.splitters <= 2, `${pw.counts.splitters} power stakes (was 6)`);
  assert.ok(pw.counts.jumpers >= 5);
  assert.deepEqual(byCode(pw, 'many-cords'), []);
  const bought = pw.feeds.reduce((sum, f) => sum + (f.cord ? f.cord.boughtFt : 0), 0);
  assert.ok(bought < 285, `${bought} ft of cord bought (was 285 ft)`);
  assert.deepEqual(checkPlan(s.project, out.measured, pw, out.library, { runs: out.runs, groundV: { pl_front: 0, pl_garage: 0 } }), []);
  // The windows are reached by risers beside them.
  for (const id of ['run_ft_window_left', 'run_ft_window_right']) {
    const f = feedOf(pw, id);
    assert.ok(f.cord.route.some((x) => x.kind === 'rise' || x.kind === 'wall' || x.kind === 'direct'), id);
  }
  // Same plan twice.
  assert.equal(JSON.stringify(planMod.computePlan(s.project).power), JSON.stringify(pw));
  // The plan summary and the shopping list follow.
  assert.equal(out.summary.homeRuns, homes);
  assert.equal(out.summary.jumpers, pw.counts.jumpers);
  const cordQty = out.bom.lines.filter((l) => l.category === 'cords').reduce((sum, l) => sum + l.qty, 0);
  assert.equal(cordQty, pw.cords.reduce((sum, c) => sum + c.count, 0));
});

test('sample house without daisy chains: targets on the ground plane and on the roof plane', { skip: !LP.has('sample') }, () => {
  const s = LP.require('sample').createSample();
  const p = JSON.parse(JSON.stringify(s.project));
  p.library = { products: null, config: { power: { daisyChain: false } } };
  // Without the eave, the rake and the ridge are one chain on the roof plane; reversing the ridge starts it at the
  // ridge's right end, 15.7 ft up the slope above the eave's right corner.
  p.features = p.features.filter((f) => f.id !== 'ft_eave');
  p.features.find((f) => f.id === 'ft_ridge').params.reverse = true;
  const out = planMod.computePlan(p);
  const pw = out.power;
  assert.equal(homeRuns(pw).length, pw.feeds.length);
  assert.deepEqual(checkPlan(p, out.measured, pw, out.library, { runs: out.runs, groundV: { pl_front: 0, pl_garage: 0 } }), []);
  // Tree base (−10, 0, 12) from the porch outlet (13, 1.5, 0): down 1.5 ft, then straight across the lawn.
  const tree = feedOf(pw, 'run_ft_tree');
  assert.equal(tree.outletId, 'out_porch');
  assert.deepEqual(kinds(tree), ['drop', 'ground']);
  close(tree.cord.route[1].lengthFt, Math.hypot(23, 12), 0.6);
  close(tree.cord.lengthFt, (1.5 + Math.hypot(23, 12)) * 1.15 + 4, 0.8);
  assert.equal(tree.cordPath.length, 3);
  // Walkway left edge starts at (15, 0, 1).
  const walk = feedOf(pw, 'run_ft_walk_left');
  assert.deepEqual(kinds(walk), ['drop', 'ground']);
  close(walk.cord.route[1].lengthFt, Math.hypot(2, 1), 0.3);
  // Ridge right end: up the front wall at its right corner (10 ft), then 15.7 ft up the roof.
  const ridge = feedOf(pw, 'run_ft_ridge');
  assert.equal(ridge.start.planeId, 'pl_roof');
  assert.deepEqual(kinds(ridge), ['drop', 'ground', 'rise', 'roof']);
  const [, , rise, roof] = ridge.cord.route;
  close(rise.lengthFt, 10, 0.2);
  close(roof.lengthFt, 15.7, 0.3);
  assert.match(ridge.cord.routeText, /up 10 ft, up the roof 15\.5 ft$/);
  // The garage outlet is on another wall: its foot is 4 ft behind and 1 ft right of the front wall's corner.
  assert.equal(ridge.outletId, 'out_garage');
  close(ridge.cord.route[1].lengthFt, Math.hypot(1, 4), 0.4);
});

// ------------------------------------------------------------------ property test
test('property: 200+ random houses keep every cord on the ground and beside the openings, and every tree within its limits', () => {
  const houses = powerHouses(220, 20261111);
  assert.ok(houses.length >= 200, `${houses.length} houses`);
  const stats = { feeds: 0, homes: 0, jumpers: 0, plugIns: 0, taps: 0, roof: 0, ground: 0, garage: 0, hops: 0, incan: 0 };
  houses.forEach((h, n) => {
    const library = catalog.getLibrary(h.project);
    const measured = measureMod.measureProject(h.project, library.config);
    const runs = design.planRuns(h.project, measured, library);
    const snap = n % 20 === 0 ? JSON.stringify([h.project, measured, runs, library]) : null;
    const pw = power.planPower(h.project, measured, runs, library);
    if (snap) assert.equal(JSON.stringify([h.project, measured, runs, library]), snap, `house ${n}: inputs mutated`);
    assert.equal(JSON.stringify(power.planPower(h.project, measured, runs, library)), JSON.stringify(pw), `house ${n}: second call differs`);
    const groundV = { pl_w: 0, pl_garage: 0 };
    const errs = checkPlan(h.project, measured, pw, library, { runs, groundV });
    assert.deepEqual(errs, [], `house ${n}: ${errs.slice(0, 4).join(' | ')}`);
    // Every feed is powered (there is always an outlet on the photo), unless the photo cannot size the cord.
    for (const f of pw.feeds) assert.ok(f.outletId, `house ${n}: ${f.id} is not powered`);
    for (const f of pw.feeds) assert.ok(f.cord || f.plugIn, `house ${n}: ${f.id} has no cord`);
    const live = pw.feeds.reduce((sum, f) => sum + f.watts, 0);
    close(pw.outlets.reduce((sum, o) => sum + o.watts, 0), live, 0.05, `house ${n}: outlet watts`);
    stats.feeds += pw.feeds.length;
    stats.homes += pw.counts.homeRuns; stats.jumpers += pw.counts.jumpers; stats.taps += pw.counts.taps;
    stats.plugIns += pw.feeds.filter((f) => f.plugIn).length;
    stats.incan += pw.warnings.some((w) => w.code === 'incandescent') ? 1 : 0;
    for (const f of pw.feeds) {
      if (!f.cord) continue;
      if (f.cord.route.some((x) => x.kind === 'roof')) stats.roof += 1;
      if (f.cord.route.some((x) => x.kind === 'hop')) stats.hops += 1;
      if (f.start.planeId === 'pl_g') stats.ground += 1;
      if (f.start.planeId === 'pl_garage') stats.garage += 1;
    }
  });
  // The houses exercise what they are meant to.
  for (const k of Object.keys(stats)) assert.ok(stats[k] > 0, `no ${k} in ${JSON.stringify(stats)}`);
  assert.ok(stats.homes < 0.5 * stats.feeds, `daisy chains at least halve the cords to the outlets: ${JSON.stringify(stats)}`);
});

test('property: broken or half-finished data never throws, never mutates the inputs and still gives finite routes', () => {
  const houses = powerHouses(60, 99);
  const rnd = g.rng(5);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const junk = [null, undefined, NaN, 'x', {}, [], [NaN, 1], [1], Infinity, -1, 0, [1e12, -1e12]];
  const nan9 = [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];
  let n = 0;
  for (const h of houses) {
    for (let k = 0; k < 6; k++) {
      const p = JSON.parse(JSON.stringify(h.project));
      const library = catalog.getLibrary(p);
      const measured = JSON.parse(JSON.stringify(measureMod.measureProject(p, library.config), (key, v) => (v === Infinity ? 1e9 : v)));
      const runs = design.planRuns(p, measured, library);
      // Damage the project and the plane solutions after the runs were planned, so power sees data that does not fit.
      for (let t = 0; t < 1 + Math.floor(rnd() * 4); t++) {
        const what = Math.floor(rnd() * 12);
        const f = pick(p.features), pl = pick(p.planes), o = pick(p.outlets), sol = measured.planes[pl.id];
        if (what === 0) f.points[Math.floor(rnd() * f.points.length)] = pick(junk);
        if (what === 1) f.points = pick(junk);
        if (what === 2) pl.derived = pick(junk);
        if (what === 3 && pl.derived) pl.derived.line = pick(junk);
        if (what === 3 && pl.rect) pl.rect.corners = pick(junk);
        if (what === 4) o.point = pick(junk);
        if (what === 5) o.planeId = pick(['nope', null, 'pl_g', 'pl_r', 'pl_garage']);
        if (what === 6) delete measured.planes[pl.id];
        if (what === 7 && sol) sol.Himg2plane = pick([null, [1, 2, 3], [0, 0, 0, 0, 0, 0, 0, 0, 0], nan9]);
        if (what === 8 && sol) sol.frame = pick([null, {}, { origin: [1, 2], e1: 'x' }]);
        if (what === 9 && sol) sol.pose = pick([null, {}, { R: [1], t: [0, 0, 0] }]);
        if (what === 10 && sol) sol.kind = pick(['wall', 'roof', 'ground', 'zzz', null]);
        if (what === 11) { f.planeId = pick(['pl_w', 'pl_r', 'pl_g', 'pl_garage', 'nope', null]); f.params = pick([null, { ownCord: true, outletId: 'out_1', reverse: true }, {}]); }
      }
      const snap = JSON.stringify([p, measured, runs]);
      const pw = power.planPower(p, measured, runs, library);
      assert.equal(JSON.stringify([p, measured, runs]), snap, 'inputs are not mutated');
      assert.equal(JSON.stringify(power.planPower(p, measured, runs, library)), JSON.stringify(pw), 'same plan twice');
      for (const f of pw.feeds) {
        assert.ok(f.cordPath.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1])), `finite cordPath for ${f.id}`);
        if (!f.cord) continue;
        assert.ok(Number.isFinite(f.cord.lengthFt) && f.cord.pieces.length > 0, `finite cord for ${f.id}`);
        assert.ok(f.cord.route.every((x) => Number.isFinite(x.lengthFt) && x.from.every(Number.isFinite) && x.to.every(Number.isFinite)), `finite route for ${f.id}`);
      }
      const merged = planMod.mergeRunInfo(runs, pw);
      assert.ok(bomMod.buildBom(p, merged, pw, library).ok);
      assert.ok(bomMod.buildChecklist(p, merged, pw, measured).length > 0);
      n += 1;
    }
  }
  assert.equal(n, 360);
});

// ------------------------------------------------------------------ shopping list and checklist
test('shopping list: jumper cords are bought like any cord, and 3-way taps get a line', () => {
  const short = feature('ft_eave', 'roofline', [F(10, 12), F(85, 12)], { label: 'Front eave', productId: 'c9-incan' });
  const w = win('ft_w', 10, 6, 4, 4, { label: 'Window' });
  const w2 = win('ft_w2', 16, 6, 4, 4, { label: 'Second window' });
  const p = project({ features: [short, w, w2], outlets: [outlet('out_a', F(5, 1.5), { label: 'Porch outlet' })] });
  const { runs, power: pw } = plan(p);
  assert.equal(pw.counts.taps, 1);
  assert.equal(pw.counts.homeRuns, 1);
  const b = bomMod.buildBom(p, planMod.mergeRunInfo(runs, pw), pw, lib);
  const tap = b.lines.find((l) => l.sku === 'tap-3way');
  assert.deepEqual([tap.category, tap.name, tap.qty, tap.unit, tap.unitPrice, tap.lineTotal], ['power', 'Outdoor 3-way tap', 1, 'each', 6.99, 6.99]);
  assert.equal(tap.notes, 'Where jumper cords branch off: the top-left corner of Window.');
  const cords = b.lines.filter((l) => l.category === 'cords');
  assert.equal(cords.reduce((s, l) => s + l.qty, 0), 3, 'one home run and two jumpers');
  assert.ok(cords.some((l) => /jumper/.test(l.notes)), JSON.stringify(cords.map((l) => l.notes)));
  assert.equal(b.lines.find((l) => l.sku === 'splitter-3'), undefined, 'one cord at the outlet needs no power stake');
  assert.equal(catalog.getAccessory(lib.accessories, 'tap-3way').price, 6.99);
});

test('checklist walks each supply tree: the home run with its route, then each jumper from the run that feeds it', () => {
  const short = feature('ft_eave', 'roofline', [F(10, 12), F(85, 12)], { label: 'Front eave', productId: 'c9-incan' });
  const w = win('ft_w', 10, 6, 4, 4, { label: 'Window' });
  const w2 = win('ft_w2', 16, 6, 4, 4, { label: 'Second window' });
  // A garland that starts half a foot from where the second window's string ends.
  const ice = feature('ft_i', 'roofline', [F(16.5, 10.5), F(30, 10.5)], { label: 'Garland', productId: 'icicle-led-300' });
  const p = project({ features: [short, w, w2, ice], outlets: [outlet('out_a', F(5, 1.5), { label: 'Porch outlet' })] });
  const { runs, power: pw } = plan(p);
  const groups = bomMod.buildChecklist(p, planMod.mergeRunInfo(runs, pw), pw, null);
  const steps = groups[0].steps;
  const text = steps.join('\n');
  const at = (re) => { const i = steps.findIndex((s) => re.test(s)); assert.ok(i >= 0, `${re} not in:\n${text}`); return i; };
  assert.equal(groups[0].outletId, 'out_a');
  assert.ok(!/power stake/.test(text), 'one cord at the outlet: no power stake');
  const home = at(/^Run a 25 ft, 16 AWG outdoor extension cord from Porch outlet to the top-left corner of Window \(about 23 ft needed\): down 1\.5 ft, 4\.5 ft along the ground, up 10 ft beside Window, 0\.5 ft across\.$/);
  const tap = at(/^Plug a 3-way tap into the end of that cord at the top-left corner of Window: the lights and 1 jumper cord plug into it\.$/);
  const hangW = at(/^Hang 1 × warm white 5 mm mini LED string.*around Window, starting at the top-left corner of Window\. Plug the first string into the tap\.$/);
  const jumpE = at(/^From the 3-way tap at the top-left corner of Window, run a 6 ft, 16 AWG jumper cord to the left end of Front eave \(about 4 ft needed\): up 2 ft\.$/);
  const hangE = at(/^Hang 3 × warm white C9 incandescent string.*along Front eave, starting at the left end of Front eave\. Plug the first string into the jumper cord\.$/);
  const jumpW2 = at(/^From the end of the last string of Window, run a 15 ft, 16 AWG jumper cord to the top-left corner of Second window \(about 9 ft needed\): 6 ft across\.$/);
  const plugI = at(/^Plug the first string of Garland straight into the end of the last string of Second window: no jumper cord is needed\.$/);
  assert.ok(home < tap && tap < hangW && hangW < jumpE && jumpE < hangE && hangE < jumpW2 && jumpW2 < plugI, text);
  assert.equal(steps.filter((s) => /^Test: /.test(s)).length, 4, 'each feed is tested');
  assert.ok(/Set the timer on Porch outlet/.test(steps[steps.length - 1]));
  // With daisy chains off the old wording stays: one numbered cord per feed, each with its route.
  const flat = plan(p, NO_CHAIN);
  const flatSteps = bomMod.buildChecklist(Object.assign({}, p, { library: { products: null, config: { power: { daisyChain: false } } } }),
    planMod.mergeRunInfo(flat.runs, flat.power), flat.power, null)[0].steps;
  assert.ok(flatSteps.some((s) => /^Cord 1 of 4: Run a .* from Porch outlet to .*: down 1\.5 ft, /.test(s)), flatSteps.join('\n'));
  assert.ok(flatSteps.some((s) => /power stake/.test(s)));
});
