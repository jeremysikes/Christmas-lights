// Unit tests for the UI half of three fixes found on a real house with a mansard roof
// (tests/fixtures/mansard-house.json, geometry only): the line that says which rectangle sets the scale, steep
// roof faces and upper roofs (surface kinds, the add flow, how steep), and a ridge drawn on a wall (the two fixes).
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions', 'export', 'panels', 'app']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const schema = LP.require('schema');
const sample = LP.require('sample');
const measure = LP.require('measure');
const panels = LP.require('ui.panels');
const app = LP.require('ui.app');
const storeMod = LP.require('ui.store');
const A = LP.require('ui.actions');

const fixture = () => schema.normalizeProject(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mansard-house.json'), 'utf8')));
function setup(project) {
  const store = storeMod.createStore({ project: project || fixture(), persist: null, now: () => '2026-11-13T12:00:00.000Z' });
  return { store, actions: A.createActions(store) };
}
const plane = (store, pred) => store.project().planes.find(pred);
const feat = (store, id) => store.project().features.find((f) => f.id === id);
const measured = (store) => store.plan().measured;
/** Draw a two-point line with the tool in use (the viewport does this from taps). */
function drawLine(actions, a, b) {
  actions.addDraftPoint(a, { tapErr: 3 });
  actions.addDraftPoint(b, { tapErr: 3 });
}
/** The fixture with a steep face, its upper roof and an ordinary roof over the garage. */
function withRoofs() {
  const env = setup();
  const { store, actions } = env;
  actions.addPlane('steep');
  drawLine(actions, [400, 440], [1290, 440]);
  env.steep = plane(store, (p) => A.surfaceKind(store.project(), p) === 'steep');
  actions.addPlane('upper');
  drawLine(actions, [440, 310], [1250, 310]);
  env.upper = plane(store, (p) => A.surfaceKind(store.project(), p) === 'upper');
  actions.setActivePlane(store.project().planes[0].id);
  actions.addPlane('roof');
  drawLine(actions, [1284, 545], [1648, 545]);
  env.garage = plane(store, (p) => A.surfaceKind(store.project(), p) === 'roof');
  env.wall = store.project().planes[0];
  return env;
}

// ---------------------------------------------------------------- A. which rectangle sets the scale

test('A: the wall of the mansard project is Medium and its card says where the scale comes from', () => {
  const { store } = setup();
  const wall = store.project().planes[0];
  const sol = measured(store).planes[wall.id];
  assert.equal(sol.confidence.level, 'medium');
  assert.equal(sol.calib.rectAuto, true);
  const line = panels.scaleLine(sol);
  assert.match(line, /^Scale taken from 'Custom rectangle \(8′ 0″ × 7′ 2″\)' \(the largest measured rectangle\)\. 'Rectangle \(3′ 0″ × 5′ 0″\)' is used as a check\.$/);
  assert.ok(!/—/.test(line), 'no em dash');
  // The stored project is not rewritten to say so.
  assert.equal(wall.rect.widthFt, 3);
  assert.equal(wall.refs.length, 1);
});

test('A: no scale line when the wall uses its own rectangle, has no scale, or is not a wall', () => {
  const p = schema.normalizeProject(sample.createSample({ traced: true }).project);
  const m = measure.measureProject(p);
  for (const pl of p.planes) assert.equal(panels.scaleLine(m.planes[pl.id]), null, pl.name);
  assert.equal(panels.scaleLine(null), null);
  assert.equal(panels.scaleLine({ ok: false, calib: { rectAuto: true } }), null);
  // Without core's note the line is still built from the label and the reason.
  assert.equal(panels.scaleLine({ ok: true, notes: [], calib: { rectAuto: true, rectLabel: 'Double garage door (16 × 7 ft)', rectWhy: 'steadiest' } }),
    "Scale taken from 'Double garage door (16 × 7 ft)' (the measured rectangle that gives the steadiest scale). The rectangle you marked on the wall is used as a check.");
});

// ---------------------------------------------------------------- B. kinds of surface

test('B: surfaceKind tells wall, roof slope, steep face, upper roof and ground apart', () => {
  const { store, steep, upper, garage, wall } = withRoofs();
  const p = store.project();
  assert.equal(A.surfaceKind(p, wall), 'wall');
  assert.equal(A.surfaceKind(p, garage), 'roof');
  assert.equal(A.surfaceKind(p, steep), 'steep');
  assert.equal(A.surfaceKind(p, upper), 'upper');
  assert.equal(A.surfaceKind(p, { kind: 'ground', derived: { parentPlaneId: wall.id } }), 'ground');
  assert.equal(A.surfaceKind(p, { kind: 'roof', derived: { parentPlaneId: wall.id, steep: false } }), 'roof', 'only steep === true counts');
  assert.equal(A.surfaceKind(p, null), 'wall');
  assert.deepEqual([wall, garage, steep, upper].map((pl) => A.SURFACE_LABEL[A.surfaceKind(p, pl)]), ['Wall', 'Roof slope', 'Steep roof face', 'Upper roof']);
  // Names in pickers: the kind is added only when the name does not already say it.
  assert.equal(A.surfaceOptionLabel(p, steep), 'Steep roof face 1');
  assert.equal(A.surfaceOptionLabel(p, upper), 'Upper roof 1');
  assert.equal(A.surfaceOptionLabel(p, Object.assign({}, steep, { name: 'Mansard' })), 'Mansard · steep roof');
  assert.equal(A.surfaceOptionLabel(p, Object.assign({}, upper, { name: 'Top' })), 'Top · upper roof');
  assert.equal(A.surfaceOptionLabel(p, Object.assign({}, wall, { name: 'Front' })), 'Front · wall');
  assert.equal(A.surfaceOptionLabel(p, { kind: 'ground', name: 'Front yard' }), 'Front yard · ground');
  // The wall under a surface, through a roof face when need be.
  assert.equal(A.wallOfPlane(p, upper).id, wall.id);
  assert.equal(A.wallOfPlane(p, steep).id, wall.id);
  assert.equal(A.wallOfPlane(p, wall).id, wall.id);
  assert.equal(A.wallOfPlane(p, { id: 'x', kind: 'roof', derived: { parentPlaneId: 'gone' } }), null);
  const loop = { planes: [{ id: 'a', kind: 'roof', derived: { parentPlaneId: 'b' } }, { id: 'b', kind: 'roof', derived: { parentPlaneId: 'a' } }] };
  assert.equal(A.wallOfPlane(loop, loop.planes[0]), null, 'a circle of parents ends');
});

test('B: what can be traced where', () => {
  const { store, steep, upper, garage, wall } = withRoofs();
  const p = store.project();
  const fits = (type, pl) => A.typeFitsSurface(p, type, pl);
  // Trim line, gutter and dormer outlines on a steep face; the top edge on the upper roof.
  for (const t of ['roofline', 'gutter', 'window', 'rake', 'ridge']) assert.ok(fits(t, steep), t + ' on a steep face');
  for (const t of ['roofline', 'gutter', 'rake', 'ridge']) assert.ok(fits(t, upper), t + ' on an upper roof');
  assert.ok(!fits('window', upper) && !fits('door', steep) && !fits('walkway', steep) && !fits('bush', steep));
  // An ordinary roof slope is as before.
  assert.ok(fits('ridge', garage) && fits('rake', garage) && !fits('roofline', garage) && !fits('window', garage));
  assert.ok(fits('roofline', wall) && fits('ridge', wall) && !fits('walkway', wall));
  assert.equal(fits('roofline', null), false);
});

test('B: adding a steep roof face draws its bottom line on the wall and stores a 70 degree guess', () => {
  const { store, actions } = setup();
  const wall = store.project().planes[0];
  assert.equal(actions.addPlane('steep'), null);
  let ui = store.ui();
  assert.deepEqual([ui.mode.name, ui.mode.opts.purpose, ui.mode.opts.planeId, ui.mode.opts.steep], ['line', 'roofEave', wall.id, true]);
  assert.equal(app.hintFor(ui, store.project(), store.plan()).text, "Tap both ends of the line where the steep roof face starts on 'Front wall'. This is the eave or gutter line at its bottom.");
  drawLine(actions, [400, 440], [1290, 440]);
  const steep = plane(store, (p) => p.kind === 'roof');
  assert.equal(steep.name, 'Steep roof face 1');
  assert.deepEqual(steep.derived, { parentPlaneId: wall.id, line: [[400, 440], [1290, 440]], pitch: null, tapErr: [3, 3], steep: true, angleDeg: 70 });
  assert.equal(store.undoLabel(), 'Add steep roof face');
  ui = store.ui();
  assert.deepEqual(ui.selection, { kind: 'plane', id: steep.id });
  assert.equal(ui.mode.name, 'select');
  const sol = measured(store).planes[steep.id];
  assert.ok(sol.ok && sol.steep && sol.mode === 'roof-3d');
  assert.equal(sol.pitch.source, 'guess');
  assert.equal(sol.confidence.level, 'low');
  assert.equal(panels.steepSlopeText(sol.pitch), '70° from level (a typical angle, not measured)');
  // The file it saves passes the validator and comes back the same.
  const v = schema.validateProject(store.project());
  assert.ok(v.ok !== false && !(v.errors && v.errors.length), JSON.stringify(v.errors || []));
  assert.deepEqual(schema.normalizeProject(JSON.parse(JSON.stringify(store.project()))).planes, store.project().planes);
  // One undo takes it away.
  actions.undo();
  assert.equal(store.project().planes.length, 1);
});

test('B: how steep: a typical angle is a guess, two tape numbers are a measurement', () => {
  const { store, actions } = setup();
  actions.addPlane('steep');
  drawLine(actions, [400, 440], [1290, 440]);
  const id = plane(store, (p) => p.kind === 'roof').id;
  const d = () => plane(store, (p) => p.id === id).derived;
  const sol = () => measured(store).planes[id];
  assert.deepEqual(A.STEEP_ANGLES, [60, 65, 70, 75, 80]);
  assert.equal(actions.setSteepAngle(id, 70), false, 'picking the angle already in use changes nothing');
  assert.equal(actions.setSteepAngle(id, 75), true);
  assert.deepEqual([d().angleDeg, d().pitch], [75, null]);
  assert.equal(store.undoLabel(), 'Set how steep the roof face is');
  assert.equal(actions.setSteepAngle(id, 89), false, 'beyond what core measures');
  assert.equal(actions.setSteepAngle(id, 10), false);
  assert.equal(actions.setSteepAngle(store.project().planes[0].id, 70), false, 'a wall has no steepness');
  assert.equal(d().angleDeg, 75);

  // Numbers that cannot be right: core's sentence is shown and nothing is stored.
  const n = store.undoLabel();
  let res = actions.setSteepMeasured(id, { upFt: 8, slopeFt: 5 });
  assert.equal(res.ok, false);
  assert.equal(store.ui().toast.message, 'The sloped height must be longer than how far the face goes up.');
  assert.equal(d().pitch, null);
  res = actions.setSteepMeasured(id, { upFt: 8 });
  assert.equal(store.ui().toast.message, 'Enter two of these: how far the face goes up, how far it goes back, and its sloped height.');
  res = actions.setSteepMeasured(id, { upFt: 40, backFt: 1 });
  assert.match(store.ui().toast.message, /almost straight up/);
  assert.equal(store.undoLabel(), n);

  // Up and sloped height.
  res = actions.setSteepMeasured(id, { upFt: 8, slopeFt: 8.5 });
  assert.equal(res.ok, true);
  assert.deepEqual(d().pitch, { rise: 8, run: 2.8723 });
  assert.equal(d().angleDeg, 75, 'the earlier guess stays in the file; the measurement wins');
  assert.equal(store.ui().toast, null, 'the earlier warning is put away');
  assert.equal(store.undoLabel(), 'Measure how steep the roof face is');
  assert.equal(sol().pitch.source, 'user');
  assert.ok(Math.abs(sol().pitch.angleDeg - 70.25) < 0.05);
  assert.equal(panels.steepSlopeText(sol().pitch), '70° from level (measured)');
  // The same numbers again are not a second undo step.
  const before = store.project();
  actions.setSteepMeasured(id, { upFt: 8, slopeFt: 8.5 });
  assert.equal(store.project(), before);
  // Up and back.
  assert.equal(actions.setSteepMeasured(id, { upFt: 9, backFt: 3 }).ok, true);
  assert.deepEqual(d().pitch, { rise: 9, run: 3 });
  // Picking a typical angle again goes back to a guess.
  assert.equal(actions.setSteepAngle(id, 65), true);
  assert.deepEqual([d().angleDeg, d().pitch, sol().pitch.source], [65, null, 'guess']);
  // Never on an ordinary roof.
  actions.setActivePlane(store.project().planes[0].id);
  actions.addPlane('roof');
  drawLine(actions, [1284, 545], [1648, 545]);
  const roof = plane(store, (p) => p.kind === 'roof' && p.id !== id);
  assert.equal(roof.derived.steep, undefined);
  assert.equal(actions.setSteepMeasured(roof.id, { upFt: 8, backFt: 3 }).ok, false);
  assert.equal(plane(store, (p) => p.id === roof.id).derived.pitch, null);
});

test('B: the slope of a steep face reads in degrees from stored data too', () => {
  assert.deepEqual(panels.storedSteepPitch({ steep: true, angleDeg: 72 }), { angleDeg: 72, source: 'guess' });
  assert.deepEqual(panels.storedSteepPitch({ steep: true }), { angleDeg: 70, source: 'default' });
  assert.deepEqual(panels.storedSteepPitch({ steep: true, angleDeg: 5 }), { angleDeg: 20, source: 'guess' });
  const m = panels.storedSteepPitch({ steep: true, angleDeg: 60, pitch: { rise: 8, run: 8 } });
  assert.equal(m.source, 'user');
  assert.ok(Math.abs(m.angleDeg - 45) < 1e-9);
  assert.equal(panels.storedSteepPitch({ steep: true, pitch: { rise: 50, run: 1 } }).angleDeg, 85);
  assert.equal(panels.steepSlopeText({ angleDeg: 70, source: 'default' }), '70° from level (assumed)');
  assert.equal(panels.steepSlopeText({ angleDeg: 85, source: 'user', clamped: true }), '85° from level (measured, almost straight up)');
  assert.equal(panels.steepSlopeText(null), '');
  assert.equal(A.steepAngleText(69.6), '70°');
  assert.equal(A.steepAngleText(NaN), '');
});

test('B: the upper roof is drawn on the steep face and built from it', () => {
  const { store, actions } = setup();
  // Without a steep face there is nothing to start from.
  assert.equal(actions.addPlane('upper'), null);
  assert.equal(store.ui().toast.message, 'Add a steep roof face first. The upper roof starts where it ends.');
  assert.equal(store.ui().mode.name, 'select');
  actions.addPlane('steep');
  drawLine(actions, [400, 440], [1290, 440]);
  const steep = plane(store, (p) => p.kind === 'roof');
  actions.setActivePlane(store.project().planes[0].id);   // whatever is active, the steep face is found
  actions.addPlane('upper');
  const ui = store.ui();
  assert.deepEqual([ui.mode.name, ui.mode.opts.purpose, ui.mode.opts.planeId, ui.mode.opts.upper], ['line', 'roofEave', steep.id, true]);
  assert.equal(app.hintFor(ui, store.project(), store.plan()).text, "Tap both ends of the line where 'Steep roof face 1' ends and the upper roof starts. This is the trim line at its top.");
  drawLine(actions, [440, 310], [1250, 310]);
  const upper = plane(store, (p) => p.derived && p.derived.parentPlaneId === steep.id);
  assert.equal(upper.name, 'Upper roof 1');
  assert.equal(upper.kind, 'roof');
  assert.equal(upper.derived.steep, undefined);
  assert.equal(store.undoLabel(), 'Add upper roof');
  const sol = measured(store).planes[upper.id];
  assert.ok(sol.ok && sol.mode === 'roof-3d' && !sol.steep);
  assert.equal(sol.slopeBelow, 'guess', 'the face below is only guessed');
  actions.setSteepMeasured(steep.id, { upFt: 8, backFt: 2.9 });
  assert.equal(measured(store).planes[upper.id].slopeBelow, null);
  // Redrawing either line says which line it is.
  actions.redrawPlaneLine(upper.id);
  assert.equal(app.hintFor(store.ui(), store.project(), store.plan()).text, 'Tap both ends of the trim line where the upper roof starts again.');
  actions.redrawPlaneLine(steep.id);
  assert.equal(app.hintFor(store.ui(), store.project(), store.plan()).text, 'Tap both ends of the line where the steep roof face starts again.');
  actions.cancelDraft();
  // An ordinary roof added next is named and built as before.
  actions.addPlane('roof');
  assert.equal(store.ui().mode.opts.planeId, store.project().planes[0].id, 'its eave goes on the wall, also with a roof active');
  assert.equal(app.hintFor(store.ui(), store.project(), store.plan()).text, "Tap both ends of the eave where the roof slope meets 'Front wall'.");
  drawLine(actions, [1284, 545], [1648, 545]);
  assert.equal(store.project().planes[store.project().planes.length - 1].name, 'Roof slope 1');
});

test('B: deleting a wall takes the steep face and the upper roof on it too', async () => {
  const { store, actions, steep, upper, garage, wall } = withRoofs();
  actions.startTrace('roofline');
  const done = actions.deletePlane(wall.id);
  const dialog = store.ui().dialog;
  assert.match(dialog.body, /'Steep roof face 1'/);
  assert.match(dialog.body, /'Upper roof 1'/);
  assert.match(dialog.body, /'Roof slope 1'/);
  dialog.onConfirm();
  assert.equal(await done, true);
  const ids = store.project().planes.map((p) => p.id);
  for (const id of [wall.id, steep.id, upper.id, garage.id]) assert.ok(!ids.includes(id));
  assert.equal(store.project().features.length, 0);
  actions.undo();
  assert.equal(store.project().planes.length, 4);
});

test('B: items traced with a steep face or an upper roof picked go on it and measure there', () => {
  const { store, actions, steep, upper, wall } = withRoofs();
  actions.setActivePlane(steep.id);
  actions.startTrace('roofline');
  assert.equal(store.ui().mode.opts.planeId, steep.id);
  actions.addDraftPoint([440, 310]);
  actions.addDraftPoint([1250, 310]);
  actions.completeDraft();
  const trim = store.project().features[store.project().features.length - 1];
  assert.equal(trim.planeId, steep.id);
  const m = measured(store).features[trim.id];
  assert.ok(m.ok && m.method === 'roof-3d' && m.lengthFt > 30 && m.wrongSurface === null);
  // A window (a dormer outline) too; a door goes back to the wall.
  actions.setActivePlane(steep.id);
  actions.startTrace('window');
  assert.equal(store.ui().mode.opts.planeId, steep.id);
  actions.startTrace('door');
  assert.equal(store.ui().mode.opts.planeId, wall.id);
  // The top edge on the upper roof; a window does not go there.
  actions.setActivePlane(upper.id);
  actions.startTrace('roofline');
  assert.equal(store.ui().mode.opts.planeId, upper.id);
  actions.startTrace('window');
  assert.equal(store.ui().mode.opts.planeId, wall.id);
});

// ---------------------------------------------------------------- C. a ridge drawn on a wall

test('C: needsRoof follows core, and a typed length ends it', () => {
  const { store, actions } = setup();
  const f = store.project().features[0];
  const m = measured(store).features[f.id];
  assert.equal(m.wrongSurface, 'roof');
  assert.equal(panels.needsRoof(f, m), true);
  assert.equal(panels.needsRoof(Object.assign({}, f, { overrideFt: 66 }), m), false);
  assert.equal(panels.needsRoof(f, Object.assign({}, m, { wrongSurface: 'ground' })), false, 'only the roof fix is offered here');
  assert.equal(panels.needsRoof(f, null), false);
  const item = measure.misplacedFeatures(store.project(), measured(store))[0];
  assert.equal(panels.wrongSurfaceWhy(item), 'A ridge sits on the roof, behind the wall. Measured on the wall it comes out too short.');
  assert.equal(panels.wrongSurfaceWhy(null), '');
  assert.equal(panels.roofFixNote(store.project(), f, item), 'No roof is marked above this wall yet. Put it on the roof has you mark where the roof starts, then moves the item.');
  // The hint bar right after such a trace: the length, why it is wrong, and the fix instead of "Trace next".
  store.setUI({ afterTrace: { featureId: f.id, type: 'ridge' }, selection: { kind: 'feature', id: f.id } });
  let hint = app.hintFor(store.ui(), store.project(), store.plan());
  assert.deepEqual(hint.fix, { featureId: f.id });
  assert.equal(hint.text, 'Ridge 1 measures 38′ 5″ on the wall, which is too short. A ridge sits on the roof, behind the wall.');
  actions.updateFeature(f.id, { overrideFt: 66 });
  hint = app.hintFor(store.ui(), store.project(), store.plan());
  assert.equal(hint.fix, undefined);
  assert.match(hint.text, /^Ridge 1: 66′ 0″/);
  // Sentences shown on screen carry no em dash.
  for (const s of [item.message, panels.roofFixNote(store.project(), f, item)]) assert.ok(!/—/.test(s));
});

test('C: "Put it on the roof" with no roof yet draws the eave, then moves the item: one undo step', () => {
  const { store, actions } = setup();
  const wall = store.project().planes[0];
  const f = store.project().features[0];
  store.setUI({ step: 6 });
  assert.equal(actions.putOnRoof(f.id), 'draw');
  let ui = store.ui();
  assert.equal(ui.step, 3, 'the line is drawn in the Trace step');
  assert.deepEqual([ui.mode.name, ui.mode.opts.purpose, ui.mode.opts.planeId, ui.mode.opts.thenMove], ['line', 'roofEave', wall.id, f.id]);
  assert.equal(app.hintFor(ui, store.project(), store.plan()).text, "A ridge sits on the roof, so mark the roof first: tap both ends of the eave where the roof slope meets 'Front wall'.");
  const before = store.project();
  drawLine(actions, [400, 440], [1290, 440]);
  const roof = plane(store, (p) => p.kind === 'roof');
  assert.equal(roof.name, 'Roof slope 1');
  assert.equal(roof.derived.steep, undefined);
  assert.equal(feat(store, f.id).planeId, roof.id);
  assert.deepEqual(feat(store, f.id).points, f.points, 'the points stay where they were tapped');
  assert.equal(store.undoLabel(), 'Put Ridge 1 on a new roof slope');
  assert.equal(measured(store).features[f.id].wrongSurface, null);
  ui = store.ui();
  assert.deepEqual(ui.selection, { kind: 'feature', id: f.id });
  assert.deepEqual(ui.afterTrace, { featureId: f.id, type: 'ridge' });
  assert.match(ui.toast.message, /^Ridge 1 is now measured on 'Roof slope 1'\./);
  assert.match(app.hintFor(ui, store.project(), store.plan()).text, /^Ridge 1: /);
  actions.undo();
  assert.equal(store.project(), before, 'one undo removes the roof and puts the ridge back');
  store.redo();
  assert.equal(feat(store, f.id).planeId, roof.id);
  // Cancelling the line leaves everything alone.
  actions.undo();
  actions.putOnRoof(f.id);
  actions.cancelDraft();
  assert.equal(store.project(), before);
  // Nothing to do for an item that is not misplaced, or that is tape-measured.
  actions.updateFeature(f.id, { overrideFt: 66 });
  assert.equal(actions.putOnRoof(f.id), false);
  assert.equal(actions.putOnRoof('nope'), false);
});

test('C: "Put it on the roof" with roofs there moves the item to the one above it, and it can be changed', () => {
  const { store, actions, steep, upper, garage, wall } = withRoofs();
  const f = store.project().features[0];   // across the main house, x 460 to 1256
  const item = measure.misplacedFeatures(store.project(), measured(store))[0];
  assert.deepEqual(item.candidates.map((c) => c.planeId).sort(), [steep.id, upper.id, garage.id].sort());
  // Ordinary roofs come before the steep face; of the two, the one whose line lies under the ridge.
  assert.equal(A.pickRoofCandidate(store.project(), f, item.candidates).planeId, upper.id);
  const overGarage = Object.assign({}, f, { points: [[1310, 470], [1596, 470]] });
  assert.equal(A.pickRoofCandidate(store.project(), overGarage, item.candidates).planeId, garage.id);
  assert.equal(A.pickRoofCandidate(store.project(), f, []), null);
  assert.equal(A.pickRoofCandidate(store.project(), f, [{ planeId: steep.id, ok: true, steep: true }]).planeId, steep.id);
  assert.equal(panels.roofFixNote(store.project(), f, item), "Put it on the roof moves it to 'Upper roof 1'. You can pick another surface after.");

  store.setUI({ step: 6 });
  assert.equal(actions.putOnRoof(f.id), 'moved');
  assert.equal(feat(store, f.id).planeId, upper.id);
  assert.equal(store.undoLabel(), "Move Ridge 1 to 'Upper roof 1'");
  assert.equal(store.ui().step, 6, 'Review stays open');
  assert.equal(store.ui().toast.message, "Ridge 1 is now measured on 'Upper roof 1'. If it belongs on another roof surface, change Surface on its card.");
  assert.equal(measure.misplacedFeatures(store.project(), measured(store)).length, 0);
  actions.undo();
  assert.equal(feat(store, f.id).planeId, wall.id);
  // A named surface wins over the pick; one that does not hang off this wall is refused by falling back to drawing.
  assert.equal(actions.putOnRoof(f.id, garage.id), 'moved');
  assert.equal(feat(store, f.id).planeId, garage.id);
});

test('C: a new ridge starts on a roof when one exists above the wall, and on the wall when none does', () => {
  const bare = setup();
  bare.actions.startTrace('ridge');
  assert.equal(bare.store.ui().mode.opts.planeId, bare.store.project().planes[0].id);
  const { store, actions, steep, upper, garage, wall } = withRoofs();
  actions.setActivePlane(wall.id);
  actions.startTrace('ridge');
  const picked = store.ui().mode.opts.planeId;
  assert.ok([upper.id, garage.id].includes(picked), 'an ordinary roof before the steep face');
  // With a roof picked it stays there, and the picker can still force the wall.
  actions.setActivePlane(steep.id);
  actions.startTrace('ridge');
  assert.equal(store.ui().mode.opts.planeId, steep.id);
  actions.setActivePlane(wall.id);
  assert.equal(store.ui().mode.opts.planeId, wall.id);
  // A rake keeps to the active wall, as before.
  actions.startTrace('rake');
  assert.equal(store.ui().mode.opts.planeId, wall.id);
});

test('C: "Done tracing" keeps a ridge that landed on the wall picked, so the fix is offered at once', () => {
  const { store, actions } = setup();
  actions.startTrace('ridge');
  actions.addDraftPoint([1310, 470]);
  actions.addDraftPoint([1596, 470]);
  actions.finishTracing();
  const f = store.project().features[1];
  assert.deepEqual(store.ui().afterTrace, { featureId: f.id, type: 'ridge' });
  assert.deepEqual(store.ui().selection, { kind: 'feature', id: f.id });
  assert.ok(app.hintFor(store.ui(), store.project(), store.plan()).fix);
  // "Later" (Done again) puts it down.
  actions.finishTracing();
  assert.equal(store.ui().afterTrace, null);
  assert.equal(store.ui().selection, null);
  // Any other item is put down straight away, as before.
  actions.startTrace('roofline');
  actions.addDraftPoint([500, 450]);
  actions.addDraftPoint([900, 450]);
  actions.finishTracing();
  assert.equal(store.ui().afterTrace, null);
  assert.equal(store.ui().selection, null);
  assert.equal(store.project().features.length, 3);
});

test('C: "Type its length" opens the tape field: in step 3 on the item, in Review in place', () => {
  const { store, actions } = setup();
  const f = store.project().features[0];
  store.setUI({ step: 2, afterTrace: { featureId: f.id, type: 'ridge' } });
  assert.equal(actions.typeLength(f.id), true);
  let ui = store.ui();
  assert.equal(ui.step, 3);
  assert.deepEqual(ui.selection, { kind: 'feature', id: f.id });
  assert.equal(ui.afterTrace, null);
  assert.equal(ui.focusTape.featureId, f.id);
  const n = ui.focusTape.n;
  store.setUI({ step: 6, selection: null });
  actions.typeLength(f.id);
  ui = store.ui();
  assert.equal(ui.step, 6);
  assert.equal(ui.selection, null);
  assert.ok(ui.focusTape.n > n, 'each request is a new one');
  assert.equal(actions.typeLength('nope'), false);
  assert.equal(storeMod.defaultUI().focusTape, null);
});

test('the sample house offers none of this: no scale line, no misplaced ridge, the same surfaces', () => {
  const p = schema.normalizeProject(sample.createSample({ traced: true }).project);
  const { store } = setup(p);
  const m = measured(store);
  assert.ok(p.planes.every((pl) => ['wall', 'roof', 'ground'].includes(A.surfaceKind(p, pl))));
  assert.ok(p.features.every((f) => !panels.needsRoof(f, m.features[f.id])));
  for (const f of p.features) {
    const pl = p.planes.find((x) => x.id === f.planeId);
    assert.ok(!pl || A.typeFitsSurface(p, f.type, pl), f.label + ' fits its surface');
  }
});
