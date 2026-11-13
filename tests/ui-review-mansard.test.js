// Review fixes for the mansard work (SPEC §8.6), UI side. Each test is named by its finding id.
//   F1  "Put it on the roof" asks what kind of roof it is, never picks a roof that starts beside the item, and
//       never reports a length that looks wrong as done
//   F2  on a mansard the surface follows where the item is traced; an item below its roof's line is flagged
//   F3  a move to an upper roof is reported as rough, with "Type its length" first
//   F5  after a steep face or an upper roof is made, a message says what comes next and the panel scrolls to it
//   F6  tape numbers that are not a steep face are refused; Up shorter than Back can be swapped
//   F10 rectangles are named by their size
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

for (const f of ['persist', 'store', 'imagesource', 'actions', 'export', 'panels', 'app']) require(path.join(__dirname, '..', 'src', 'ui', f + '.js'));

const schema = LP.require('schema');
const measure = LP.require('measure');
const panels = LP.require('ui.panels');
const app = LP.require('ui.app');
const storeMod = LP.require('ui.store');
const A = LP.require('ui.actions');

const fixture = () => schema.normalizeProject(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mansard-house.json'), 'utf8')));
function setup() {
  const store = storeMod.createStore({ project: fixture(), persist: null, now: () => '2026-11-13T12:00:00.000Z' });
  return { store, actions: A.createActions(store) };
}
const kindOf = (store, k) => store.project().planes.find((p) => A.surfaceKind(store.project(), p) === k);
const feat = (store, id) => store.project().features.find((f) => f.id === id);
const hint = (store) => app.hintFor(store.ui(), store.project(), store.plan());
const noDashes = (s) => assert.ok(!/[—–]/.test(s), 'no dashes in on-screen text: ' + s);
function drawLine(actions, a, b) {
  actions.addDraftPoint(a, { tapErr: 3 });
  actions.addDraftPoint(b, { tapErr: 3 });
}
/** The fixture with a steep face (bottom line y 440) and its upper roof (trim line y 310) over the main house. */
function mansard() {
  const env = setup();
  env.actions.addPlane('steep');
  drawLine(env.actions, [400, 440], [1290, 440]);
  env.steep = kindOf(env.store, 'steep');
  env.actions.addPlane('upper');
  drawLine(env.actions, [440, 310], [1250, 310]);
  env.upper = kindOf(env.store, 'upper');
  env.wall = env.store.project().planes[0];
  return env;
}

test('F1: with no roof, the hint bar asks ordinary or steep, and the steep answer makes a steep roof face for the item', () => {
  const { store, actions } = setup();
  const f = store.project().features[0];
  const wall = store.project().planes[0];
  store.setUI({ step: 3 });
  assert.equal(actions.putOnRoof(f.id), 'ask');
  let h = hint(store);
  assert.equal(h.text, "What kind of roof is above 'Front wall'? An ordinary roof slopes back from the eave. A mansard goes up steeply first, then turns shallow.");
  assert.deepEqual(h.fix, { featureId: f.id, buttons: ['ordinary', 'steep', 'cancel'] });
  noDashes(h.text);
  assert.equal(store.ui().mode.name, 'select', 'no line is being drawn yet');
  actions.drawRoofFor(f.id, 'steep');
  const o = store.ui().mode.opts;
  assert.deepEqual([o.purpose, o.planeId, o.thenMove, o.steep], ['roofEave', wall.id, f.id, true]);
  assert.match(hint(store).text, /where the steep roof face starts/);
  const before = store.project();
  drawLine(actions, [400, 440], [1290, 440]);
  const face = kindOf(store, 'steep');
  assert.ok(face, 'a steep roof face was made');
  assert.deepEqual([face.derived.steep, face.derived.angleDeg, face.derived.pitch], [true, 70, null]);
  assert.equal(feat(store, f.id).planeId, face.id);
  assert.equal(store.undoLabel(), 'Put Ridge 1 on a new steep roof face');
  // On this photo the steep face is only roughly measured, so the note says so and offers the tape first.
  const ui = store.ui();
  assert.equal(ui.moveNote.kind, 'rough');
  assert.match(ui.moveNote.text, /^Ridge 1 now reads 4\d′ \d+″ on 'Steep roof face 1'\. This surface is only roughly measured, so this length is rough\. Type a tape-measured length\.$/);
  assert.deepEqual(hint(store).fix.buttons, ['tape:primary', 'undo', 'ok']);
  actions.undoMove();
  assert.equal(store.project(), before, 'Undo on the note takes the move and the new face back');
  assert.equal(store.ui().moveNote, null);
});

test('F1: an ordinary roof that makes the ridge three times too long is reported as wrong, and "Use a steep roof face" redoes it', () => {
  const { store, actions } = setup();
  const f = store.project().features[0];
  store.setUI({ step: 3 });
  actions.putOnRoof(f.id);
  actions.drawRoofFor(f.id, 'roof');
  const before = store.project();
  drawLine(actions, [400, 440], [1290, 440]);
  const wallFt = 38.4, nowFt = store.plan().measured.features[f.id].measuredFt;
  assert.ok(nowFt > 2.5 * wallFt, 'the ridge reads ' + nowFt.toFixed(1) + ' ft on a house about 46 ft wide');
  const note = store.ui().moveNote;
  assert.deepEqual([note.kind, note.canSteep], ['wrong', true]);
  noDashes(note.text);
  assert.ok(!store.ui().toast || store.ui().toast.kind !== 'ok', 'no green message');
  assert.equal(actions.useSteepInstead(f.id), true);
  assert.equal(store.project(), before, 'the ordinary roof is gone');
  assert.deepEqual([store.ui().mode.name, store.ui().mode.opts.steep, store.ui().mode.opts.thenMove], ['line', true, f.id]);
  // "OK" only closes the note.
  actions.cancelDraft();
  actions.putOnRoof(f.id);
  actions.drawRoofFor(f.id, 'roof');
  drawLine(actions, [400, 440], [1290, 440]);
  const kept = store.project();
  actions.dismissMoveNote();
  assert.deepEqual([store.ui().moveNote, store.project() === kept], [null, true]);
});

test('F1: a roof that starts beside the item is never picked for it: the garage roof does not take the mansard ridge', () => {
  const { store, actions } = setup();
  const f = store.project().features[0];   // across the main house, x 460 to 1256
  actions.addPlane('roof');
  drawLine(actions, [1284, 545], [1648, 545]);   // the garage roof, to the right of the ridge
  const garage = kindOf(store, 'roof');
  const item = measure.misplacedFeatures(store.project(), store.plan().measured)[0];
  assert.deepEqual(item.candidates.map((c) => [c.planeId, c.under]), [[garage.id, false]]);
  assert.equal(A.pickRoofCandidate(store.project(), f, item.candidates), null);
  assert.equal(panels.roofFixNote(store.project(), f, item), 'No roof marked so far starts under this item. Put it on the roof asks what kind of roof it is, has you mark where it starts, then moves the item.');
  store.setUI({ step: 6 });
  assert.equal(actions.putOnRoof(f.id), 'ask');
  assert.equal(feat(store, f.id).planeId, store.project().planes[0].id, 'the ridge stays on the wall until the question is answered');
  // Naming the garage roof by hand still works (the Surface picker), and its 158 ft is reported as wrong.
  store.setUI({ step: 3, roofAsk: null });
  assert.equal(actions.putOnRoof(f.id, garage.id), 'moved');
  assert.equal(store.ui().moveNote.kind, 'wrong');
  assert.match(store.ui().moveNote.text, /so this looks too long/);
});

test('F2: on a mansard the surface follows where the item is traced', () => {
  const { store, actions, steep, upper, wall } = mansard();
  const p = store.project();
  const img = p.images[0].id;
  const at = (pts, type, cur) => { const pl = A.mansardSurfaceFor(p, img, pts, type, cur); return pl ? pl.id : null; };
  // Between the bottom line and the trim line: the steep face. Above the trim line: the upper roof.
  assert.equal(at([[400, 440], [440, 310]], 'rake', upper), steep.id, 'a leaning corner edge');
  assert.equal(at([[700, 400], [760, 400], [760, 340], [700, 340]], 'window', wall), steep.id, 'a dormer');
  assert.equal(at([[440, 310], [1250, 310]], 'roofline', upper), steep.id, 'the trim line itself');
  assert.equal(at([[460, 255], [1256, 260]], 'ridge', wall), upper.id, 'the top edge');
  assert.equal(at([[460, 255], [1256, 260]], 'roofline', steep), upper.id);
  // At or below the bottom line: back on the wall when a mansard roof was the surface, else left alone.
  assert.equal(at([[400, 440], [1290, 440]], 'gutter', upper), wall.id, 'a gutter along the eave');
  assert.equal(at([[400, 440], [1290, 440]], 'gutter', wall), null);
  assert.equal(at([[700, 600], [760, 600], [760, 520], [700, 520]], 'window', wall), null, 'a window in the brick wall');
  // Beside the mansard (the garage wing), or a type that cannot be measured there: no opinion.
  assert.equal(at([[1500, 400], [1600, 330]], 'rake', wall), null);
  assert.equal(at([[700, 400], [700, 340]], 'tree', wall), null);
  assert.equal(at([], 'rake', wall), null);

  // Live: with the upper roof active, a corner edge traced with Rake lands on the steep face.
  store.setUI({ step: 3 });
  actions.setActivePlane(upper.id);
  actions.startTrace('rake');
  assert.equal(store.ui().mode.opts.planeId, upper.id);
  actions.addDraftPoint([400, 440], { tapErr: 3 });
  actions.addDraftPoint([440, 310], { tapErr: 3 });
  assert.equal(store.ui().mode.opts.planeId, steep.id, 'the hint bar picker now shows the steep face');
  actions.completeDraft();
  const rake = store.project().features[store.project().features.length - 1];
  assert.equal(rake.planeId, steep.id);
  assert.equal(store.plan().measured.features[rake.id].wrongSurface, null);
  // A dormer traced as a window with the upper roof active goes on the steep face, not the wall.
  actions.setActivePlane(upper.id);
  actions.startTrace('window');
  for (const q of [[700, 400], [760, 400], [760, 340], [700, 340]]) actions.addDraftPoint(q, { tapErr: 3 });
  actions.completeDraft();
  assert.equal(store.project().features[store.project().features.length - 1].planeId, steep.id);
  // A surface picked by hand for this trace is kept.
  actions.startTrace('rake');
  actions.setActivePlane(upper.id);
  assert.equal(store.ui().mode.opts.planePicked, true);
  actions.addDraftPoint([1290, 440], { tapErr: 3 });
  actions.addDraftPoint([1250, 310], { tapErr: 3 });
  assert.equal(store.ui().mode.opts.planeId, upper.id);
  actions.completeDraft();
  const forced = store.project().features[store.project().features.length - 1];
  assert.equal(forced.planeId, upper.id);

  // That one is below the line where the upper roof starts: flagged at once, with the surface below as the fix.
  const m = store.plan().measured.features[forced.id];
  assert.equal(m.wrongSurface, 'below');
  assert.equal(panels.needsLower(forced, m), true);
  assert.equal(panels.needsLower(Object.assign({}, forced, { overrideFt: 9 }), m), false);
  const h = hint(store);
  assert.equal(h.text, "Rake 2 is drawn below the line where 'Upper roof 1' starts, so it is not on that roof.");
  assert.deepEqual(h.fix, { featureId: forced.id, buttons: ['lower:primary', 'tape', 'later'] });
  noDashes(h.text);
  const item = measure.misplacedFeatures(store.project(), store.plan().measured).find((x) => x.featureId === forced.id);
  assert.equal(panels.lowerTarget(store.project(), forced, item).planeId, steep.id);
  assert.equal(actions.putOnPlane(forced.id), true);
  assert.equal(feat(store, forced.id).planeId, steep.id);
  assert.equal(store.undoLabel(), "Move Rake 2 to 'Steep roof face 1'");
  assert.equal(store.plan().measured.features[forced.id].wrongSurface, null);
  assert.equal(actions.putOnPlane(forced.id), false, 'nothing left to fix');
});

test('F2: the rake hint names the leaning corner edge once a steep roof face exists', () => {
  const bare = setup();
  bare.actions.startTrace('rake');
  assert.match(hint(bare.store).text, /^Tap along the gable rake, corner by corner\./);
  const { store, actions } = mansard();
  actions.startTrace('rake');
  assert.match(hint(store).text, /^Tap along the gable rake or the leaning corner edge, corner by corner\./);
});

test('F3: in step 3 a move to the upper roof is a rough result with "Type its length" first, and Undo takes it back', () => {
  const { store, actions, upper, wall } = mansard();
  const f = store.project().features[0];
  store.setUI({ step: 3 });
  assert.equal(actions.putOnRoof(f.id), 'moved');
  assert.equal(feat(store, f.id).planeId, upper.id);
  const ui = store.ui();
  assert.equal(ui.toast, null, 'no green message');
  assert.deepEqual([ui.moveNote.kind, ui.moveNote.canSteep], ['rough', false]);
  assert.equal(ui.moveNote.text, "Ridge 1 now reads 64′ 2″ on 'Upper roof 1'. This roof is seen almost edge-on, so this length is rough. Type a tape-measured length.");
  assert.deepEqual(hint(store).fix, { featureId: f.id, buttons: ['tape:primary', 'undo', 'ok'] });
  actions.undoMove();
  assert.equal(feat(store, f.id).planeId, wall.id);
  // Typing the length closes the note.
  actions.putOnRoof(f.id);
  actions.typeLength(f.id);
  assert.equal(store.ui().moveNote, null);
});

test('F5: after a steep face or an upper roof is made, a message says what comes next and the panel is sent there', () => {
  const { store, actions } = setup();
  actions.addPlane('steep');
  drawLine(actions, [400, 440], [1290, 440]);
  const steep = kindOf(store, 'steep');
  assert.equal(store.ui().toast.message, 'Steep roof face added. Now say how steep it is, then add the upper roof.');
  assert.equal(store.ui().toast.kind, 'ok');
  assert.deepEqual([store.ui().scrollTo.key, store.ui().scrollTo.planeId], ['steep', steep.id]);
  const n1 = store.ui().scrollTo.n;
  actions.addPlane('upper');
  drawLine(actions, [440, 310], [1250, 310]);
  const upper = kindOf(store, 'upper');
  assert.equal(store.ui().toast.message, 'Upper roof added. Now pick its pitch. The top of a mansard is usually flatter than the rest of the house.');
  assert.deepEqual([store.ui().scrollTo.key, store.ui().scrollTo.planeId], ['upper-pitch', upper.id]);
  assert.ok(store.ui().scrollTo.n > n1, 'a new request each time');
  for (const t of ['Steep roof face added. Now say how steep it is, then add the upper roof.', store.ui().toast.message]) noDashes(t);
  // An ordinary roof and the ground send the panel nowhere.
  actions.setActivePlane(store.project().planes[0].id);
  actions.addPlane('roof');
  drawLine(actions, [1284, 545], [1648, 545]);
  assert.equal(store.ui().scrollTo.key, 'upper-pitch', 'unchanged');
});

test('F6: tape numbers that are not a steep face are refused with a reason; a likely swap can be stored and swapped', () => {
  const { store, actions } = setup();
  actions.addPlane('steep');
  drawLine(actions, [400, 440], [1290, 440]);
  const id = kindOf(store, 'steep').id;
  const before = store.project();
  const res = actions.setSteepMeasured(id, { upFt: 1, backFt: 8 });
  assert.equal(res.ok, false);
  assert.equal(store.project(), before, 'nothing is stored');
  assert.match(store.ui().toast.message, /^This is not a steep face: it rises less than 20° from level\. Check that Up and Back are not swapped, or add it as a Roof slope\.$/);
  assert.equal(store.ui().toast.kind, 'warn');
  // 3 up, 8 back is allowed (20.6°) but flagged; swapping gives 8 up, 3 back.
  const lean = actions.setSteepMeasured(id, { upFt: 3, backFt: 8 });
  assert.deepEqual([lean.ok, lean.swapLikely], [true, true]);
  assert.deepEqual(kindOf(store, 'steep').derived.pitch, { rise: 3, run: 8 });
  const swapped = actions.setSteepMeasured(id, { upFt: 8, backFt: 3 });
  assert.deepEqual([swapped.ok, swapped.swapLikely], [true, false]);
  assert.deepEqual(kindOf(store, 'steep').derived.pitch, { rise: 8, run: 3 });
});

test('F10: rectangles are named by their size, and a preset keeps its name', () => {
  assert.equal(panels.rectWords('Custom rectangle (8′ 0″ × 7′ 2″)'), 'the 8′ 0″ × 7′ 2″ rectangle');
  assert.equal(panels.rectWords('Rectangle (3′ 0″ × 5′ 0″)'), 'the 3′ 0″ × 5′ 0″ rectangle');
  assert.equal(panels.rectWords('Double garage door (16 × 7 ft)'), 'the double garage door (16 × 7 ft)');
  assert.equal(panels.rectWords(''), 'the rectangle');
});
