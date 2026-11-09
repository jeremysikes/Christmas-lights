// Unit tests for ui.viewport's pure helpers (createViewport itself needs a browser; see tests/e2e).
const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
require('../src/ui/preview.js');
require('../src/ui/viewport.js');

const vp = LP.require('ui.viewport');
const sample = LP.require('sample');
const project = sample.createSample({ traced: true }).project;
const IMG = project.images[0].id;

test('module loads without a DOM and exports the viewport API', () => {
  assert.equal(typeof vp.createViewport, 'function');
  assert.throws(() => vp.createViewport({}), /host element and a store/);
});

test('selectionHandles returns one handle per editable point with a moveVertex target', () => {
  const eave = vp.selectionHandles(project, { kind: 'feature', id: 'ft_eave' });
  assert.equal(eave.length, 2);
  assert.deepEqual(eave[1].target, { kind: 'feature', id: 'ft_eave' });
  assert.equal(eave[1].index, 1);

  const front = vp.selectionHandles(project, { kind: 'plane', id: 'pl_front' });
  assert.equal(front.length, 4);
  assert.ok(front.every((h) => h.target.kind === 'planeRect' && h.target.planeId === 'pl_front'));

  const roof = vp.selectionHandles(project, { kind: 'plane', id: 'pl_roof' });
  assert.equal(roof.length, 2);
  assert.equal(roof[0].target.kind, 'planeLine');

  const ref = vp.selectionHandles(project, { kind: 'ref', id: 'ref_door_height' });   // planeId found by search
  assert.equal(ref.length, 2);
  assert.deepEqual(ref[0].target, { kind: 'ref', planeId: 'pl_front', refId: 'ref_door_height' });

  const outlet = vp.selectionHandles(project, { kind: 'outlet', id: 'out_porch' });
  assert.deepEqual(outlet.map((h) => h.target), [{ kind: 'outlet', id: 'out_porch' }]);

  assert.deepEqual(vp.selectionHandles(project, { kind: 'feature', id: 'missing' }), []);
  assert.deepEqual(vp.selectionHandles(null, null), []);
});

test('snapCandidates lists every vertex, corner, reference end and outlet on the photo (memoized)', () => {
  const list = vp.snapCandidates(project, IMG);
  assert.equal(vp.snapCandidates(project, IMG), list);
  const keys = new Set(list.map((c) => c.key));
  assert.ok(keys.has('feature:ft_eave'));
  assert.ok(keys.has('planeRect:pl_front'));
  assert.ok(keys.has('planeLine:pl_roof'));
  assert.ok(keys.has('ref:pl_front:ref_door_height'));
  assert.ok(keys.has('outlet:out_garage'));
  const featurePts = project.features.reduce((n, f) => n + f.points.length, 0);
  assert.ok(list.length >= featurePts + 4 + project.outlets.length);
  assert.deepEqual(vp.snapCandidates(project, 'img_other'), []);
  // Keys match targetKey so a dragged vertex can exclude itself.
  assert.equal(vp.targetKey({ kind: 'ref', planeId: 'pl_front', refId: 'ref_door_height' }), 'ref:pl_front:ref_door_height');
  assert.equal(vp.targetKey({ kind: 'planeRect', planeId: 'pl_front' }), 'planeRect:pl_front');
});

test('layersFor shows the right overlay per step and tool', () => {
  assert.equal(Object.values(vp.layersFor(1, 'select')).some(Boolean), false, 'step 1 is the clean preview');
  const s2 = vp.layersFor(2, 'select');
  assert.ok(s2.planes && s2.grid && s2.refs && !s2.features);
  const s3 = vp.layersFor(3, 'select');
  assert.ok(s3.features && s3.featureLabels && !s3.outlets);
  const s5 = vp.layersFor(5, 'select');
  assert.ok(s5.outlets && s5.power && s5.featuresFaint && !s5.features);
  assert.ok(vp.layersFor(4, 'select').featuresFaint && vp.layersFor(6, 'select').featureLabels);
  assert.ok(vp.layersFor(1, 'trace').features, 'tracing always shows features');
  assert.ok(vp.layersFor(4, 'outlet').outlets, 'placing outlets always shows outlets');
  assert.ok(vp.layersFor(3, 'rect').planes && vp.layersFor(3, 'line').refs);
});
