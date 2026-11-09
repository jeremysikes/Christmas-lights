// Regression tests for UI review findings (actions, store, persist). Each test names the finding it covers.
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const schema = LP.require('schema');
const sample = LP.require('sample');
const storeMod = LP.require('ui.store');
const actionsMod = LP.require('ui.actions');

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
function tracedSample() {
  return schema.normalizeProject(sample.createSample({ traced: true }).project);
}

// ---------------------------------------------------------------- electrical:U1
test('electrical:U1 changing an outlet type away from exterior GFCI clears GFCI (and back sets it)', () => {
  const { store, actions } = setup();
  actions.setMode('outlet', { planeId: 'pl_front' });
  const id = actions.addOutlet([500, 900]);
  assert.equal(store.project().outlets[0].gfci, true);
  actions.updateOutlet(id, { type: 'interior' });
  assert.equal(store.project().outlets[0].gfci, false, 'an indoor outlet is not assumed to be GFCI protected');
  actions.updateOutlet(id, { gfci: true });
  assert.equal(store.project().outlets[0].gfci, true, 'the user can still tick GFCI');
  actions.updateOutlet(id, { type: 'other' });
  assert.equal(store.project().outlets[0].gfci, false);
  actions.updateOutlet(id, { type: 'exteriorGfci' });
  assert.equal(store.project().outlets[0].gfci, true);
});

// ---------------------------------------------------------------- measurement:M12
test('measurement:M12 parseLength reads tape notations, fractions and thousands separators', () => {
  const near = (a, b) => assert.ok(a != null && Math.abs(a - b) < 1e-9, a + ' vs ' + b);
  near(actionsMod.parseLength('6\'-8"'), 6 + 8 / 12);
  near(actionsMod.parseLength('6\' - 8"'), 6 + 8 / 12);
  near(actionsMod.parseLength('6\' 8 1/2"'), 6 + 8.5 / 12);
  near(actionsMod.parseLength('36 1/2"'), 36.5 / 12);
  near(actionsMod.parseLength('36-1/2"'), 36.5 / 12);
  near(actionsMod.parseLength('1/2"'), 0.5 / 12);
  near(actionsMod.parseLength('8 1/2\''), 8.5);
  near(actionsMod.parseLength('1,200'), 1200);
  near(actionsMod.parseLength('6,5'), 6.5);
  assert.equal(actionsMod.parseLength('5\'13"'), null, 'inches of 12 or more after feet are refused');
  assert.equal(actionsMod.parseLength('1/0"'), null);
  // The old forms still work.
  near(actionsMod.parseLength('6\' 8"'), 6 + 8 / 12);
  near(actionsMod.parseLength('6-8'), 6 + 8 / 12);
  near(actionsMod.parseLength('80in'), 80 / 12);
});

// ---------------------------------------------------------------- mobile-ux:UX-01 / completeness:F4
test('mobile-ux:UX-01 wall items are traced on a wall even after a roof or ground plane was made active', () => {
  const { store, actions } = setup(tracedSample());
  actions.setActivePlane('pl_yard');
  actions.startTrace('roofline');
  assert.equal(store.ui().mode.opts.planeId, 'pl_front', 'an eave goes on the parent wall, not the ground');
  actions.cancelDraft();
  actions.setActivePlane('pl_roof');
  actions.startTrace('window');
  assert.equal(store.ui().mode.opts.planeId, 'pl_front', 'a window goes on the wall, not the roof');
  actions.cancelDraft();
  actions.setActivePlane('pl_garage');
  actions.startTrace('gutter');
  assert.equal(store.ui().mode.opts.planeId, 'pl_garage', 'an active wall is kept');
  actions.cancelDraft();
  actions.setActivePlane('pl_front');
  actions.startTrace('walkway');
  assert.equal(store.ui().mode.opts.planeId, 'pl_yard', 'walkways go on the ground');
  actions.cancelDraft();
  actions.setActivePlane('pl_roof');
  actions.startTrace('rake');
  assert.equal(store.ui().mode.opts.planeId, 'pl_roof', 'a rake may lie on a roof slope');
  actions.cancelDraft();
  actions.setActivePlane('pl_yard');
  actions.startTrace('tree');
  assert.equal(store.ui().mode.opts.planeId, 'pl_yard', 'a tree may stand on the ground');
});

test('mobile-ux:UX-01 a walkway with no ground plane asks for the ground first, then traces on it', () => {
  const p = tracedSample();
  p.planes = p.planes.filter((x) => x.kind !== 'ground');
  p.features = p.features.filter((f) => f.planeId !== 'pl_yard');
  const { store, actions } = setup(p);
  actions.startTrace('walkway');
  const ui = store.ui();
  assert.equal(ui.mode.name, 'line', 'the ground base tool starts instead of tracing the walkway on the wall');
  assert.equal(ui.mode.opts.purpose, 'groundBase');
  assert.equal(ui.mode.opts.thenTrace, 'walkway');
  actions.addDraftPoint([465, 817]);
  actions.addDraftPoint([992, 817]);
  const ground = store.project().planes.find((x) => x.kind === 'ground');
  assert.ok(ground, 'a ground plane was made');
  assert.equal(store.ui().mode.name, 'trace', 'tracing the walkway starts right after');
  assert.equal(store.ui().mode.opts.planeId, ground.id);
});

test('mobile-ux:UX-01 making a roof slope keeps the next eave on the wall', () => {
  const { store, actions } = setup(tracedSample());
  actions.addPlane('roof');
  actions.addDraftPoint([470, 640]);
  actions.addDraftPoint([990, 640]);
  assert.equal(store.project().planes.filter((x) => x.kind === 'roof').length, 2);
  actions.startTrace('roofline');
  assert.equal(store.ui().mode.opts.planeId, 'pl_front');
});

test('completeness:F4 a new outlet goes on the wall that contains the tap, never the active ground plane', () => {
  const { store, actions } = setup(tracedSample());
  actions.setActivePlane('pl_yard');
  actions.startOutlet();
  const id = actions.addOutlet([648.4, 781.1]);
  assert.equal(store.project().outlets.find((o) => o.id === id).planeId, 'pl_front');
  actions.startOutlet();
  const id2 = actions.addOutlet([1026.9, 784.9]);
  assert.equal(store.project().outlets.find((o) => o.id === id2).planeId, 'pl_garage');
  // The surface can be changed afterwards.
  actions.updateOutlet(id, { planeId: 'pl_garage' });
  assert.equal(store.project().outlets.find((o) => o.id === id).planeId, 'pl_garage');
});

test('completeness:F4 wallForPoint picks the wall whose rectangle or traced items hold the point', () => {
  const p = tracedSample();
  assert.equal(actionsMod.wallForPoint(p, p.images[0].id, [648.4, 781.1]), 'pl_front');
  assert.equal(actionsMod.wallForPoint(p, p.images[0].id, [1026.9, 784.9]), 'pl_garage');
  // Far outside every wall: the nearest wall.
  const far = actionsMod.wallForPoint(p, p.images[0].id, [10, 800]);
  assert.equal(far, 'pl_front');
});

// ---------------------------------------------------------------- data-export:F1
test('data-export:F1 loading a sample over the user\'s own plan asks first and can be undone', async () => {
  const { store, actions } = setup();
  actions.setMode('outlet', { planeId: 'pl_front' });
  actions.addOutlet([500, 900]);
  actions.setProjectName('42 My Own House');
  // Decline: nothing changes.
  let pending = actions.loadSample({ traced: true });
  assert.ok(store.ui().dialog, 'an in-page dialog asks before replacing the plan');
  store.ui().dialog.onCancel();
  assert.equal(await pending, false);
  assert.equal(store.project().name, '42 My Own House');
  // Confirm: the sample loads, and Undo brings the plan back. (Node has no canvas: stub the sample photo.)
  const src = LP.require('ui.imagesource').SampleImageSource;
  const acquire = src.acquire;
  src.acquire = (o) => Promise.resolve({ sample: sample.createSample(o), canvas: null });
  try {
    pending = actions.loadSample({ traced: true });
    store.ui().dialog.onConfirm();
    assert.equal(await pending, true);
  } finally { src.acquire = acquire; }
  assert.equal(store.project().name, 'Sample house');
  assert.equal(store.canUndo(), true, 'loading a sample is undoable');
  store.undo();
  assert.equal(store.project().name, '42 My Own House');
});

test('data-export:F1 work traced on the practice sample counts as the user\'s work', () => {
  const blank = schema.normalizeProject(sample.createSample({ traced: false }).project);
  const { store, actions } = setup(blank);
  assert.equal(actions.hasUserWork(), false, 'an untouched practice sample is not work');
  actions.setMode('trace', { type: 'roofline', planeId: 'pl_front' });
  actions.addDraftPoint([10, 10]);
  actions.addDraftPoint([200, 10]);
  actions.completeDraft();
  assert.equal(actions.hasUserWork(), true);
  const traced = setup(tracedSample());
  assert.equal(traced.actions.hasUserWork(), false, 'the untouched traced sample is not work');
  traced.actions.updateFeature('ft_eave', { overrideFt: 40 });
  assert.equal(traced.actions.hasUserWork(), true, 'an edited traced sample is work');
  assert.equal(store.ui().mode.name, 'trace');
});

// ---------------------------------------------------------------- mobile-ux:UX-11
test('mobile-ux:UX-11 undo during a handle drag does not split the drag into many undo entries', () => {
  const { store, actions } = setup(tracedSample());
  const before = store.project();
  store.beginGesture();
  for (let i = 0; i < 5; i++) actions.moveVertex({ kind: 'feature', id: 'ft_eave' }, 0, [470 + i, 640], { gesture: true });
  store.undo();
  for (let i = 0; i < 10; i++) actions.moveVertex({ kind: 'feature', id: 'ft_eave' }, 0, [480 + i, 641], { gesture: true });
  store.endGesture('Move point');
  let n = 0;
  while (store.canUndo()) { store.undo(); n += 1; }
  assert.ok(n <= 1, 'one drag leaves at most one undo entry (' + n + ')');
  assert.deepEqual(store.project().features.find((f) => f.id === 'ft_eave').points, before.features.find((f) => f.id === 'ft_eave').points);
});

// ---------------------------------------------------------------- mobile-ux:UX-12
test('mobile-ux:UX-12 Undo while tracing removes the last tapped point before touching finished runs', () => {
  const { store, actions } = setup();
  actions.setMode('trace', { type: 'roofline', planeId: 'pl_front' });
  actions.addDraftPoint([10, 10]);
  actions.addDraftPoint([200, 10]);
  actions.completeDraft();
  actions.addDraftPoint([10, 50]);
  actions.addDraftPoint([200, 50]);
  assert.equal(actions.undoLabel(), 'Undo point');
  actions.undo();
  assert.equal(store.project().features.length, 1, 'the finished eave is kept');
  assert.equal(store.ui().draft.points.length, 1);
  actions.undo();
  assert.equal(store.ui().draft.points.length, 0);
  actions.undo();
  assert.equal(store.project().features.length, 0, 'with no draft, Undo reverts the last change');
});
