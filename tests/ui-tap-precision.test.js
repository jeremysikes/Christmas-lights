// Tap precision (SPEC §8.4, UI half): every point a person places or drags is stored with its expected tap error
// (tapErr, stored-image px) beside the point list, index for index, through insert, delete, move, undo and redo.
// Tested at the action / store level: schema.normalizeProject keeping tapErr on reload is the schema's side of §8.4.
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions', 'preview', 'viewport']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const schema = LP.require('schema');
const sample = LP.require('sample');
const storeMod = LP.require('ui.store');
const actionsMod = LP.require('ui.actions');
const vp = LP.require('ui.viewport');

function setup(project) {
  const store = storeMod.createStore({ project: project || blankWithPhoto(), persist: null, now: () => '2026-11-11T12:00:00.000Z' });
  return { store, actions: actionsMod.createActions(store) };
}
function blankWithPhoto() {
  const p = schema.createProject({ now: '2026-11-11T10:00:00.000Z' });
  p.images = [schema.createImage({ id: 'img_1', name: 'front.jpg', width: 1600, height: 1200, storageKey: 'img_1' })];
  p.activeImageId = 'img_1';
  p.planes = [schema.createPlane({ id: 'pl_front', kind: 'wall', imageId: 'img_1', name: 'Front wall' })];
  return p;
}
const tracedSample = () => schema.normalizeProject(sample.createSample({ traced: true }).project);
/** Every stored tapErr list is as long as its point list. */
function assertAligned(project) {
  for (const pl of project.planes) {
    if (pl.rect && pl.rect.tapErr !== undefined) assert.equal(pl.rect.tapErr.length, pl.rect.corners.length, pl.id + ' rect');
    if (pl.derived && pl.derived.tapErr !== undefined) assert.equal(pl.derived.tapErr.length, pl.derived.line.length, pl.id + ' line');
    for (const r of pl.refs) if (r.tapErr !== undefined) assert.equal(r.tapErr.length, r.points.length, r.id);
  }
  for (const f of project.features) if (f.tapErr !== undefined) assert.equal(f.tapErr.length, f.points.length, f.id);
}

test('8.4 e = clamp(k / s, 2.5, 80): a finger at fit zoom on a phone is good to about 13 photo px, not 2.5', () => {
  // A 1600 px wide photo fitted into a 390 px phone: 0.234 CSS px per photo px.
  assert.equal(vp.tapErrorPx(0.234, 'touch'), 12.82);
  assert.equal(vp.tapErrorPx(0.234, 'mouse'), 6.41, 'a mouse or pen is twice as steady (k = 1.5)');
  assert.equal(vp.tapErrorPx(0.234, 'pen'), 6.41);
  // Held down and aimed with the 2.5x loupe.
  assert.equal(vp.tapErrorPx(0.234, 'touch', 2.5), 5.13);
  // Zoomed in, the floor is today's assumption; far out, the ceiling.
  assert.equal(vp.tapErrorPx(2, 'touch'), 2.5);
  assert.equal(vp.tapErrorPx(4, 'mouse'), 2.5);
  assert.equal(vp.tapErrorPx(0.01, 'touch'), 80);
  assert.equal(vp.tapErrorPx(0, 'touch'), 3, 'a missing scale reads as 1 CSS px per photo px');
  assert.equal(vp.tapErrorPx(0.5, 'unknown-pointer'), 3, 'unknown pointers count as a mouse');
});

test('8.4 a calibration rectangle stores one tapErr per corner; corners placed by code store none', () => {
  const { store, actions } = setup();
  actions.setCalib({ rectPresetId: 'garage-double' });
  actions.startPlaneRect('pl_front');
  const corners = [[100, 100], [500, 110], [505, 300], [98, 290]];
  corners.forEach((c, i) => actions.addDraftPoint(c, { tapErr: 12.82 - i }));
  let rect = store.project().planes[0].rect;
  assert.deepEqual(rect.tapErr, [12.82, 11.82, 10.82, 9.82]);
  assert.deepEqual(rect.corners, corners);
  // Dragging a corner while zoomed in replaces that corner's value only.
  store.beginGesture();
  actions.moveVertex({ kind: 'planeRect', planeId: 'pl_front' }, 2, [506, 301], { gesture: true, tapErr: 4.1 });
  actions.moveVertex({ kind: 'planeRect', planeId: 'pl_front' }, 2, [507, 302], { gesture: true, tapErr: 2.5 });
  store.endGesture('Move point');
  rect = store.project().planes[0].rect;
  assert.deepEqual(rect.tapErr, [12.82, 11.82, 2.5, 9.82]);
  assert.equal(store.undo(), 'Move point');
  assert.deepEqual(store.project().planes[0].rect.tapErr, [12.82, 11.82, 10.82, 9.82], 'undo brings the old value back with the old corner');
  store.redo();
  assert.deepEqual(store.project().planes[0].rect.tapErr, [12.82, 11.82, 2.5, 9.82]);
  // Changing what the rectangle is keeps the taps.
  actions.updatePlane('pl_front', { rect: { presetId: 'garage-single', widthFt: 9, heightFt: 7 } });
  assert.deepEqual(store.project().planes[0].rect.tapErr, [12.82, 11.82, 2.5, 9.82]);
  // Marked again by code (no tap information): no list at all, which measure.js reads as 2.5 px everywhere.
  actions.startPlaneRect('pl_front');
  corners.forEach((c) => actions.addDraftPoint(c));
  assert.equal(store.project().planes[0].rect.tapErr, undefined);
  // Out-of-range values are clamped to [2.5, 80] on the way in.
  actions.startPlaneRect('pl_front');
  [0.4, 500, 7.777, NaN].forEach((e, i) => actions.addDraftPoint(corners[i], { tapErr: e }));
  assert.deepEqual(store.project().planes[0].rect.tapErr, [2.5, 80, 7.78, 2.5]);
  assertAligned(store.project());
});

test('8.4 reference ends and roof / ground lines store their tapErr, and a redrawn line replaces it', () => {
  const { store, actions } = setup();
  actions.setCalib({ refPresetId: 'door-height' });
  actions.startReference('pl_front');
  actions.addDraftPoint([300, 200], { tapErr: 12.8 });
  actions.addDraftPoint([300, 400], { tapErr: 5.1 });
  const ref = store.project().planes[0].refs[0];
  assert.deepEqual(ref.tapErr, [12.8, 5.1]);
  actions.moveVertex({ kind: 'ref', planeId: 'pl_front', refId: ref.id }, 0, [301, 201], { tapErr: 3 });
  assert.deepEqual(store.project().planes[0].refs[0].tapErr, [3, 5.1]);
  // A rectangle reference has four.
  actions.setCalib({ refPresetId: 'custom-rect', refWidthFt: 3, refHeightFt: 5 });
  actions.startReference('pl_front');
  [[600, 300], [700, 300], [700, 450], [600, 450]].forEach((c) => actions.addDraftPoint(c, { tapErr: 9 }));
  assert.deepEqual(store.project().planes[0].refs[1].tapErr, [9, 9, 9, 9]);
  // A reference drawn by code has none.
  actions.setCalib({ refPresetId: 'door-width' });
  actions.startReference('pl_front');
  actions.addDraftPoint([800, 400]);
  actions.addDraftPoint([860, 400]);
  assert.equal(store.project().planes[0].refs[2].tapErr, undefined);

  // Roof slope from an eave line.
  actions.addPlane('roof');
  actions.addDraftPoint([100, 300], { tapErr: 12.8 });
  actions.addDraftPoint([700, 290], { tapErr: 12.8 });
  const roof = store.project().planes.find((x) => x.kind === 'roof');
  assert.deepEqual(roof.derived.tapErr, [12.8, 12.8]);
  actions.moveVertex({ kind: 'planeLine', planeId: roof.id }, 1, [702, 291], { tapErr: 2.5 });
  assert.deepEqual(store.project().planes.find((x) => x.id === roof.id).derived.tapErr, [12.8, 2.5]);
  // Redrawn zoomed in: the new taps replace the old ones; redrawn by code: the list goes.
  actions.redrawPlaneLine(roof.id);
  actions.addDraftPoint([101, 301], { tapErr: 3.3 });
  actions.addDraftPoint([699, 291], { tapErr: 3.4 });
  assert.deepEqual(store.project().planes.find((x) => x.id === roof.id).derived.tapErr, [3.3, 3.4]);
  actions.redrawPlaneLine(roof.id);
  actions.addDraftPoint([102, 302]);
  actions.addDraftPoint([698, 292]);
  assert.equal(store.project().planes.find((x) => x.id === roof.id).derived.tapErr, undefined);
  // Ground plane from the wall base.
  actions.setActivePlane('pl_front');
  actions.addPlane('ground');
  actions.addDraftPoint([100, 700], { tapErr: 6.4 });
  actions.addDraftPoint([700, 710], { tapErr: 6.4 });
  assert.deepEqual(store.project().planes.find((x) => x.kind === 'ground').derived.tapErr, [6.4, 6.4]);
  assertAligned(store.project());
});

test('8.4 a traced item keeps tapErr aligned through undo point, insert, delete, move, type change, undo and redo', () => {
  const { store, actions } = setup();
  actions.startTrace('roofline');
  actions.addDraftPoint([0, 0], { tapErr: 12.8 });
  actions.addDraftPoint([100, 0], { tapErr: 11 });
  actions.addDraftPoint([150, 40], { tapErr: 10 });
  assert.deepEqual(store.ui().draft.tapErr, [12.8, 11, 10]);
  actions.removeLastDraftPoint();                       // Undo point
  assert.deepEqual(store.ui().draft.tapErr, [12.8, 11]);
  actions.addDraftPoint([200, 5], { tapErr: 9 });
  actions.addDraftPoint([300, 5], { tapErr: null });    // snapped onto a point that has no value
  actions.completeDraft();
  const id = store.project().features[0].id;
  const f = () => store.project().features.find((x) => x.id === id);
  assert.deepEqual(f().tapErr, [12.8, 11, 9, 2.5], 'a point with no information holds 2.5 (what measure assumes)');
  assert.equal(f().points.length, 4);

  // Insert: the + handle makes a point by code (no tap), a tapped insert carries its value.
  actions.insertVertex(id, 0, [50, 0]);
  assert.deepEqual(f().tapErr, [12.8, 2.5, 11, 9, 2.5]);
  actions.insertVertex(id, 3, [250, 5], { tapErr: 4.2 });
  assert.deepEqual(f().tapErr, [12.8, 2.5, 11, 9, 4.2, 2.5]);
  assert.deepEqual(f().points[4], [250, 5]);
  // Delete.
  actions.deleteVertex(id, 1);
  assert.deepEqual(f().tapErr, [12.8, 11, 9, 4.2, 2.5]);
  assert.equal(f().points.length, 5);
  // Move: the dragged point's value changes; a drag that ends snapped onto a point with a value copies it, and
  // onto one with none falls back to 2.5.
  actions.moveVertex({ kind: 'feature', id }, 0, [1, 1], { tapErr: 3.1 });
  assert.deepEqual(f().tapErr, [3.1, 11, 9, 4.2, 2.5]);
  actions.moveVertex({ kind: 'feature', id }, 1, [200, 5], { tapErr: 9 });
  assert.deepEqual(f().tapErr, [3.1, 9, 9, 4.2, 2.5]);
  actions.moveVertex({ kind: 'feature', id }, 2, [300, 5], { tapErr: null });
  assert.deepEqual(f().tapErr, [3.1, 9, 2.5, 4.2, 2.5]);
  // A move made by code (no tapErr given) leaves the list alone.
  actions.moveVertex({ kind: 'feature', id }, 3, [251, 6]);
  assert.deepEqual(f().tapErr, [3.1, 9, 2.5, 4.2, 2.5]);
  // Undo and redo walk the list back and forth with the points.
  const history = [];
  while (store.canUndo()) { store.undo(); const g = f(); history.push(g ? [g.points.length, g.tapErr ? g.tapErr.slice() : null] : null); if (g) assertAligned(store.project()); }
  assert.equal(history[history.length - 1], null, 'back before the trace');
  assert.deepEqual(history[history.length - 2], [4, [12.8, 11, 9, 2.5]], 'the item as first traced');
  while (store.canRedo()) { store.redo(); assertAligned(store.project()); }
  assert.deepEqual(f().tapErr, [3.1, 9, 2.5, 4.2, 2.5]);
  // Turning the eave into a column keeps its two end points and their values.
  actions.changeFeatureType(id, 'column');
  assert.equal(f().points.length, 2);
  assert.deepEqual(f().tapErr, [3.1, 2.5]);
  assertAligned(store.project());
});

test('8.4 points made by code carry no tapErr; one person-placed point starts a list for that item only', () => {
  const p = tracedSample();
  for (const f of p.features) assert.equal(f.tapErr, undefined, f.id);
  for (const pl of p.planes) {
    if (pl.rect) assert.equal(pl.rect.tapErr, undefined);
    if (pl.derived) assert.equal(pl.derived.tapErr, undefined);
    for (const r of pl.refs) assert.equal(r.tapErr, undefined);
  }
  assert.ok(vp.snapCandidates(p, p.images[0].id).every((c) => c.tapErr === null || c.tapErr === undefined), 'nothing to copy from the sample');
  const { store, actions } = setup(p);
  // Traced by code: no list.
  actions.startTrace('roofline');
  actions.addDraftPoint([480, 700]);
  actions.addDraftPoint([700, 700]);
  actions.completeDraft();
  assert.equal(store.project().features[store.project().features.length - 1].tapErr, undefined);
  // Dragging one corner of the sample's eave with a finger at fit zoom starts a list for the eave.
  actions.moveVertex({ kind: 'feature', id: 'ft_eave' }, 0, [472, 644], { tapErr: 12.82 });
  const eave = store.project().features.find((f) => f.id === 'ft_eave');
  assert.deepEqual(eave.tapErr, [12.82, 2.5]);
  assert.equal(store.project().features.find((f) => f.id === 'ft_ridge').tapErr, undefined, 'other items are untouched');
  // A point dragged onto a vertex that has no stored value records "none" without inventing a list.
  actions.moveVertex({ kind: 'feature', id: 'ft_ridge' }, 0, store.project().features.find((f) => f.id === 'ft_ridge').points[0].map((v) => v + 1), { tapErr: null });
  assert.equal(store.project().features.find((f) => f.id === 'ft_ridge').tapErr, undefined);
  // Snap candidates now offer the eave's values to anything snapped onto its corners.
  const cands = vp.snapCandidates(store.project(), p.images[0].id).filter((c) => c.key === 'feature:ft_eave');
  assert.deepEqual(cands.map((c) => c.tapErr), [12.82, 2.5]);
  // Deleting and inserting on an item without a list makes none.
  actions.insertVertex('ft_ridge', 0, [800, 560]);
  assert.equal(store.project().features.find((f) => f.id === 'ft_ridge').tapErr, undefined);
  actions.deleteVertex('ft_ridge', 1);
  assert.equal(store.project().features.find((f) => f.id === 'ft_ridge').tapErr, undefined);
  assertAligned(store.project());
  // Outlets have no tap list.
  actions.moveVertex({ kind: 'outlet', id: 'out_porch' }, 0, [650, 780], { tapErr: 12 });
  assert.equal(store.project().outlets.find((o) => o.id === 'out_porch').tapErr, undefined);
});

test('8.4 a damaged or misaligned tapErr list is dropped or rebuilt, never left out of step', () => {
  const p = tracedSample();
  p.features.find((f) => f.id === 'ft_eave').tapErr = [5];                       // wrong length
  p.features.find((f) => f.id === 'ft_window_left').tapErr = [4, 'x', null, 9];   // right length, junk inside
  const { store, actions } = setup(p);
  assert.deepEqual(vp.snapCandidates(store.project(), p.images[0].id).filter((c) => c.key === 'feature:ft_eave').map((c) => c.tapErr), [null, null]);
  actions.insertVertex('ft_eave', 0, [700, 640]);
  assert.equal(store.project().features.find((f) => f.id === 'ft_eave').tapErr, undefined, 'a list of the wrong length is dropped on the next edit');
  actions.moveVertex({ kind: 'feature', id: 'ft_window_left' }, 0, [511, 675], { tapErr: 6 });
  assert.deepEqual(store.project().features.find((f) => f.id === 'ft_window_left').tapErr, [6, 2.5, 2.5, 9]);
  assertAligned(store.project());
});
