// Unit tests for the UI state layer: ui.persist (Node: no storage), ui.store and ui.actions.
// These modules only touch the DOM inside functions that need it, so the state logic runs in Node.
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const schema = LP.require('schema');
const sample = LP.require('sample');
const storeMod = LP.require('ui.store');
const actionsMod = LP.require('ui.actions');
const persist = LP.require('ui.persist');

/** A store with autosave disabled and a fixed clock, plus actions. */
function setup(project) {
  const store = storeMod.createStore({ project: project || blankWithPhoto(), persist: null, now: () => '2026-11-09T12:00:00.000Z' });
  const actions = actionsMod.createActions(store);
  return { store, actions };
}
function blankWithPhoto() {
  const p = schema.createProject({ now: '2026-11-09T10:00:00.000Z' });
  p.images = [schema.createImage({ id: 'img_1', name: 'front.jpg', width: 2000, height: 1500, storageKey: 'img_1' })];
  p.activeImageId = 'img_1';
  p.planes = [schema.createPlane({ id: 'pl_front', kind: 'wall', imageId: 'img_1', name: 'Front wall' })];
  return p;
}

test('parseLength accepts feet-inches, decimals, inches and metric', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
  near(actionsMod.parseLength('6\' 8"'), 6 + 8 / 12);
  near(actionsMod.parseLength("6'8"), 6 + 8 / 12);
  near(actionsMod.parseLength('6′ 8″'), 6 + 8 / 12);
  near(actionsMod.parseLength('6 ft 8 in'), 6 + 8 / 12);
  near(actionsMod.parseLength('6.67'), 6.67);
  near(actionsMod.parseLength('80in'), 80 / 12);
  near(actionsMod.parseLength('80"'), 80 / 12);
  near(actionsMod.parseLength('12 ft'), 12);
  near(actionsMod.parseLength('6-8'), 6 + 8 / 12);
  near(actionsMod.parseLength('2 m'), 2 / 0.3048);
  near(actionsMod.parseLength('6,5'), 6.5);
  assert.equal(actionsMod.parseLength(''), null);
  assert.equal(actionsMod.parseLength('abc'), null);
  assert.equal(actionsMod.parseLength('0'), null);
  assert.equal(actionsMod.parseLength('-3'), null);
  assert.equal(actionsMod.parseLength(null), null);
});

test('persist works without browser storage: load resolves null, saves never throw', async () => {
  assert.equal(await persist.load(), null);
  assert.equal(persist.saveProjectNow({ a: 1 }), false);
  persist.saveProject({ a: 1 });
  persist.flush();
  assert.equal(await persist.saveImage('img_1', 'data:image/jpeg;base64,AAAA'), false);
  assert.equal(await persist.saveImage('sample', 'data:image/png;base64,AAAA'), false);
  assert.equal(await persist.loadImage('img_1'), null);
  assert.equal(typeof (await persist.clear()), 'boolean');
  assert.equal(persist.loadPref('x', 7), 7);
});

test('commit, undo, redo and no-op commits', () => {
  const { store } = setup();
  const before = store.project();
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  assert.equal(store.canUndo(), false);
  assert.equal(store.commit('Rename', (d) => { d.name = 'Maple St'; }), true);
  assert.equal(store.project().name, 'Maple St');
  assert.equal(store.project().updatedAt, '2026-11-09T12:00:00.000Z');
  assert.equal(before.name, '', 'the previous project object is not mutated');
  assert.equal(store.canUndo(), true);
  assert.equal(store.undoLabel(), 'Rename');
  // Same value again: no change, no undo entry.
  assert.equal(store.commit('Rename', (d) => { d.name = 'Maple St'; }), false);
  assert.equal(store.commit('Cancelled', () => false), false);
  assert.equal(store.undo(), 'Rename');
  assert.equal(store.project().name, '');
  assert.equal(store.canRedo(), true);
  assert.equal(store.redo(), 'Rename');
  assert.equal(store.project().name, 'Maple St');
  assert.ok(calls >= 3);
  // A throwing mutator leaves the project unchanged.
  const cur = store.project();
  assert.equal(store.commit('Broken', () => { throw new Error('boom'); }), false);
  assert.equal(store.project(), cur);
});

test('gestures push one undo entry', () => {
  const { store, actions } = setup();
  actions.setMode('trace', { type: 'roofline', planeId: 'pl_front' });
  actions.addDraftPoint([10, 10]);
  actions.addDraftPoint([200, 10]);
  actions.completeDraft();
  const id = store.project().features[0].id;
  store.beginGesture();
  actions.moveVertex({ kind: 'feature', id }, 1, [210, 12], { gesture: true });
  actions.moveVertex({ kind: 'feature', id }, 1, [220, 14], { gesture: true });
  assert.equal(store.endGesture('Move point'), true);
  assert.deepEqual(store.project().features[0].points[1], [220, 14]);
  assert.equal(store.undo(), 'Move point');
  assert.deepEqual(store.project().features[0].points[1], [200, 10]);
  assert.equal(store.undo(), 'Trace eave');
  assert.equal(store.project().features.length, 0);
  // Selection pointed at the deleted feature, so it is cleared.
  assert.equal(store.ui().selection, null);
});

test('plan is memoized per project version', () => {
  const { store } = setup();
  const a = store.plan();
  assert.equal(store.plan(), a);
  store.commit('Waste', (d) => { d.settings.wastePct = 15; });
  assert.notEqual(store.plan(), a);
  assert.ok(store.plan().summary);
});

test('rect tool marks the plane rectangle and selects the plane', () => {
  const { store, actions } = setup();
  actions.setCalib({ rectPresetId: 'garage-double' });
  actions.startPlaneRect('pl_front');
  assert.equal(store.ui().mode.name, 'rect');
  for (const p of [[100, 100], [500, 110], [505, 300], [98, 290]]) actions.addDraftPoint(p);
  const pl = store.project().planes[0];
  assert.equal(pl.rect.presetId, 'garage-double');
  assert.equal(pl.rect.widthFt, 16);
  assert.equal(pl.rect.heightFt, 7);
  assert.equal(pl.rect.corners.length, 4);
  assert.equal(store.ui().mode.name, 'select');
  assert.deepEqual(store.ui().selection, { kind: 'plane', id: 'pl_front' });
  // Unknown size keeps width/height null.
  actions.setCalib({ rectPresetId: 'unknown' });
  actions.startPlaneRect('pl_front');
  for (const p of [[100, 100], [500, 110], [505, 300], [98, 290]]) actions.addDraftPoint(p);
  assert.equal(store.project().planes[0].rect.widthFt, null);
});

test('reference tools: preset, custom length and courses', () => {
  const { store, actions } = setup();
  actions.setCalib({ refPresetId: 'door-height' });
  actions.startReference('pl_front');
  actions.addDraftPoint([300, 200]);
  actions.addDraftPoint([300, 400]);
  let refs = store.project().planes[0].refs;
  assert.equal(refs.length, 1);
  assert.equal(refs[0].presetId, 'door-height');
  assert.ok(Math.abs(refs[0].lengthFt - 80 / 12) < 1e-9);
  assert.equal(store.ui().selection.kind, 'ref');

  // Custom length without a value is refused with a toast.
  actions.setCalib({ refPresetId: 'custom-line', refLengthFt: null });
  actions.startReference('pl_front');
  assert.equal(store.ui().mode.name, 'select');
  assert.equal(store.ui().toast.kind, 'warn');
  actions.setCalib({ refLengthFt: 12.5 });
  actions.startReference('pl_front');
  actions.addDraftPoint([10, 500]);
  actions.addDraftPoint([400, 500]);
  refs = store.project().planes[0].refs;
  assert.equal(refs[1].lengthFt, 12.5);

  actions.setCalib({ refPresetId: 'siding-5', refCourses: 12 });
  actions.startReference('pl_front');
  actions.addDraftPoint([600, 500]);
  actions.addDraftPoint([600, 300]);
  refs = store.project().planes[0].refs;
  assert.equal(refs[2].courses, 12);
  assert.ok(Math.abs(refs[2].lengthFt - 5) < 1e-9);
});

test('trace tool: polylines, closing polygons, verticals, default labels', () => {
  const { store, actions } = setup();
  actions.startTrace('roofline');
  actions.addDraftPoint([0, 0]);
  actions.addDraftPoint([100, 0]);
  actions.addDraftPoint([100, 0]); // duplicate tap ignored
  actions.addDraftPoint([200, 5]);
  assert.equal(store.ui().draft.points.length, 3);
  actions.completeDraft();
  let fs = store.project().features;
  assert.equal(fs.length, 1);
  assert.equal(fs[0].label, 'Eave 1');
  assert.equal(fs[0].closed, false);
  assert.equal(fs[0].planeId, 'pl_front');
  // Phase 1.1 (SPEC §8.5, UX-06): finishing puts the tool down and offers what to trace next, instead of staying in
  // trace mode with "0 points" and a disabled Finish.
  assert.equal(store.ui().mode.name, 'select', 'the trace tool is put down after Finish');
  assert.deepEqual(store.ui().afterTrace, { featureId: fs[0].id, type: 'roofline' });
  assert.deepEqual(store.ui().selection, { kind: 'feature', id: fs[0].id });
  assert.deepEqual(store.ui().draft.points, []);

  actions.startTrace('roofline');
  assert.equal(store.ui().afterTrace, null, 'picking the next item ends the offer');
  actions.addDraftPoint([0, 50]);
  actions.addDraftPoint([100, 50]);
  actions.completeDraft();
  assert.equal(store.project().features[1].label, 'Eave 2');

  actions.startTrace('window');
  actions.addDraftPoint([10, 10]);
  actions.addDraftPoint([60, 10]);
  assert.equal(actions.completeDraft(), false, 'a window needs 3 points');
  actions.addDraftPoint([60, 80]);
  actions.addDraftPoint([10, 80]);
  actions.addDraftPoint([10, 10]); // tapping the first point closes the polygon
  fs = store.project().features;
  assert.equal(fs[2].type, 'window');
  assert.equal(fs[2].closed, true);
  assert.equal(fs[2].points.length, 4);
  assert.equal(fs[2].label, 'Window 1');

  actions.startTrace('tree');
  actions.addDraftPoint([300, 400]);
  actions.addDraftPoint([300, 250]); // verticals complete at 2 points
  fs = store.project().features;
  assert.equal(fs[3].type, 'tree');
  assert.equal(fs[3].points.length, 2);

  actions.cancelDraft();
  assert.equal(store.ui().mode.name, 'select');
});

test('outlets get letters, GFCI defaults and a circuit (created if none)', () => {
  const p = blankWithPhoto();
  p.circuits = [];
  const { store, actions } = setup(p);
  actions.startOutlet();
  const a = actions.addOutlet([50, 60]);
  actions.startOutlet();
  const b = actions.addOutlet([70, 60]);
  const proj = store.project();
  assert.equal(proj.circuits.length, 1);
  assert.equal(proj.circuits[0].name, 'Circuit 1');
  assert.equal(proj.circuits[0].breakerAmps, 15);
  const oa = proj.outlets.find((o) => o.id === a);
  const ob = proj.outlets.find((o) => o.id === b);
  assert.equal(oa.label, 'Outlet A');
  assert.equal(ob.label, 'Outlet B');
  assert.equal(oa.type, 'exteriorGfci');
  assert.equal(oa.gfci, true);
  assert.equal(oa.circuitId, proj.circuits[0].id);
  assert.equal(oa.planeId, 'pl_front');
  assert.deepEqual(store.ui().selection, { kind: 'outlet', id: b });
  // Deleting a circuit moves its outlets to the remaining one; the last circuit is kept.
  const c2 = actions.addCircuit();
  actions.updateOutlet(a, { circuitId: c2 });
  actions.deleteCircuit(c2);
  assert.equal(store.project().outlets.find((o) => o.id === a).circuitId, store.project().circuits[0].id);
  actions.deleteCircuit(store.project().circuits[0].id);
  assert.equal(store.project().circuits.length, 1);
});

test('roof and ground planes come from a line on a wall', () => {
  const { store, actions } = setup();
  assert.equal(actions.addPlane('roof'), null);
  assert.equal(store.ui().mode.name, 'line');
  assert.equal(store.ui().mode.opts.purpose, 'roofEave');
  actions.addDraftPoint([100, 300]);
  actions.addDraftPoint([700, 290]);
  const roof = store.project().planes.find((x) => x.kind === 'roof');
  assert.ok(roof);
  assert.equal(roof.name, 'Roof slope 1');
  assert.equal(roof.derived.parentPlaneId, 'pl_front');
  assert.equal(store.ui().activePlaneId, roof.id);
  actions.addPlane('ground');
  // Active plane is the roof: the ground plane is built from the roof's parent wall.
  assert.equal(store.ui().mode.opts.planeId, 'pl_front');
  actions.addDraftPoint([100, 700]);
  actions.addDraftPoint([700, 710]);
  assert.ok(store.project().planes.find((x) => x.kind === 'ground'));
  const wallId = actions.addPlane('wall');
  assert.equal(store.project().planes.find((x) => x.id === wallId).name, 'Wall 2');
});

test('deletePlane asks first when items depend on it, and removes children', async () => {
  const { store, actions } = setup();
  actions.addPlane('roof');
  actions.addDraftPoint([100, 300]);
  actions.addDraftPoint([700, 290]);
  actions.setActivePlane('pl_front');
  actions.startTrace('roofline');
  actions.addDraftPoint([0, 0]);
  actions.addDraftPoint([100, 0]);
  actions.completeDraft();
  actions.cancelDraft();
  const pending = actions.deletePlane('pl_front');
  const dialog = store.ui().dialog;
  assert.ok(dialog && dialog.danger);
  assert.match(dialog.body, /1 traced item/);
  dialog.onCancel();
  assert.equal(await pending, false);
  assert.equal(store.project().planes.length, 2);
  const again = actions.deletePlane('pl_front');
  store.ui().dialog.onConfirm();
  assert.equal(await again, true);
  assert.equal(store.project().planes.length, 0);
  assert.equal(store.project().features.length, 0);
  assert.equal(store.ui().dialog, null);
  assert.equal(store.undo(), 'Delete Front wall');
  assert.equal(store.project().planes.length, 2);
});

test('feature edits: params merge, type change keeps geometry valid, labels follow the type', () => {
  const { store, actions } = setup();
  actions.startTrace('roofline');
  actions.addDraftPoint([0, 0]);
  actions.addDraftPoint([50, 10]);
  actions.addDraftPoint([100, 0]);
  actions.completeDraft();
  const id = store.project().features[0].id;
  actions.updateFeature(id, { params: { diameterIn: 12 }, overrideFt: 30 });
  let f = store.project().features[0];
  assert.equal(f.params.diameterIn, 12);
  assert.equal(f.params.reverse, false, 'other params are kept');
  assert.equal(f.overrideFt, 30);
  actions.changeFeatureType(id, 'column');
  f = store.project().features[0];
  assert.equal(f.type, 'column');
  assert.equal(f.points.length, 2);
  assert.equal(f.label, 'Column 1');
  actions.changeFeatureType(id, 'window');
  assert.equal(store.project().features[0].type, 'column', 'a 2-point item cannot become a window');
});

test('sanitizeUI clears dangling selection and tools', () => {
  const p = blankWithPhoto();
  const patch = storeMod.sanitizeUI(p, Object.assign(storeMod.defaultUI(), {
    selection: { kind: 'feature', id: 'ft_gone' }, activePlaneId: 'pl_gone', mode: { name: 'trace', opts: { planeId: 'pl_gone' } },
  }));
  assert.equal(patch.selection, null);
  assert.equal(patch.activePlaneId, 'pl_front');
  assert.equal(patch.mode.name, 'select');
});

test('sample project works through the store and actions without throwing', () => {
  const s = sample.createSample({ traced: true });
  const { store, actions } = setup(schema.normalizeProject(s.project));
  assert.equal(store.ui().activePlaneId, 'pl_front');
  const plan = store.plan();
  assert.ok(plan.summary.totalFt > 100);
  actions.resetAutoPlan();
  actions.setPriceOverride('c9-led', 30);
  assert.equal(store.plan().bom.lines.find((l) => l.sku === 'c9-led').unitPrice, 30);
  actions.setPriceOverride('c9-led', null);
  assert.equal(store.plan().bom.lines.find((l) => l.sku === 'c9-led').overridden, false);
  actions.updateSettings({ roofPitch: { rise: 8, run: 12 } });
  assert.equal(store.plan().measured.pitch.source, 'user');
  actions.setLibraryConfig({ clipSpacingIn: 6 });
  assert.equal(store.plan().library.config.clipSpacingIn, 6);
  actions.setLibraryConfig(null);
  assert.equal(store.project().library.config, null);
  actions.select({ kind: 'feature', id: 'ft_ridge' });
  assert.equal(store.ui().activePlaneId, 'pl_roof');
  actions.goStep(9);
  assert.equal(store.ui().step, 6);
  assert.equal(store.ui().selection, null);
});

test('confirm resolves false when replaced by a second dialog', async () => {
  const { store, actions } = setup();
  const first = actions.confirm({ title: 'One' });
  const second = actions.confirm({ title: 'Two' });
  assert.equal(await first, false);
  assert.equal(store.ui().dialog.title, 'Two');
  store.ui().dialog.onConfirm();
  assert.equal(await second, true);
});

test('updateQuote refuses a value that a reload would reset (tax above 100%) and says why', () => {
  const { store, actions } = setup();
  const before = store.project().quote.taxPct;
  assert.equal(actions.updateQuote({ taxPct: 825 }), false);
  assert.equal(store.project().quote.taxPct, before, 'the store keeps the old tax rate');
  assert.match(store.ui().toast.message, /from 0 to 100/);
  actions.updateQuote({ taxPct: 8.25 });
  assert.equal(store.project().quote.taxPct, 8.25);
  const reloaded = schema.normalizeProject(JSON.parse(JSON.stringify(store.project())));
  assert.equal(reloaded.quote.taxPct, 8.25, 'what the app holds survives a reload');
});

test('hydrateImages tells a photo missing from the file from one that is there but damaged', async () => {
  const { actions } = setup();
  const p = blankWithPhoto();
  p.images.push(schema.createImage({ id: 'img_2', name: 'back.jpg', width: 10, height: 10, storageKey: 'img_2' }));
  // In Node no photo can be decoded, so a present data URL stands in for a damaged one.
  const r = await actions.hydrateImages(p, { img_1: 'data:image/jpeg;base64,AAAA' }, { persist: false });
  assert.deepEqual(r.damaged, ['front.jpg']);
  assert.deepEqual(r.missing.slice().sort(), ['back.jpg', 'front.jpg'], 'missing still lists every photo that did not load');
});

test('opening a file whose photo data is damaged says the photo is damaged, not that it was not saved', async () => {
  const { store, actions } = setup();
  const exported = schema.exportProject(blankWithPhoto(), null, { img_1: 'data:image/jpeg;base64,AAAA' }, null);
  const ok = await actions.importProjectFile({ text: () => Promise.resolve(JSON.stringify(exported)) });
  assert.equal(ok, true);
  assert.match(store.ui().toast.message, /photo in this file is damaged/);
  assert.doesNotMatch(store.ui().toast.message, /not saved/);
});
