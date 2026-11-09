const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const schema = LP.require('schema');
const catalog = LP.require('catalog');
const geometry = LP.require('geometry');

// ------------------------------------------------------------------ helpers
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Minimal JSON Schema (draft 2020-12) validator covering the keywords project.schema.json uses:
 * $ref (local), type, enum, const, properties, required, items, min/maxItems, minimum, maximum,
 * exclusiveMinimum, minLength, pattern, anyOf, allOf, if/then, additionalProperties (schema form).
 * Returns a list of "path: problem" strings.
 */
function validateJson(root, value, start) {
  const errors = [];
  const resolve = (ref) => {
    if (ref === '#') return root;
    const m = /^#\/\$defs\/(.+)$/.exec(ref);
    if (!m || !root.$defs[m[1]]) throw new Error('unresolvable $ref ' + ref);
    return root.$defs[m[1]];
  };
  const typeOk = (t, v) => {
    switch (t) {
      case 'null': return v === null;
      case 'boolean': return typeof v === 'boolean';
      case 'string': return typeof v === 'string';
      case 'number': return typeof v === 'number' && Number.isFinite(v);
      case 'integer': return Number.isInteger(v);
      case 'array': return Array.isArray(v);
      case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
      default: throw new Error('unknown type ' + t);
    }
  };
  function check(s, v, at, out) {
    if (s.$ref) check(resolve(s.$ref), v, at, out);
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeOk(t, v))) { out.push(at + ': expected ' + types.join('|')); return; }
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) out.push(at + ': expected ' + JSON.stringify(s.const));
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(at + ': not in enum');
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) out.push(at + ': below minimum');
      if (s.maximum !== undefined && v > s.maximum) out.push(at + ': above maximum');
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) out.push(at + ': not above exclusiveMinimum');
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) out.push(at + ': too short');
      if (s.pattern && !new RegExp(s.pattern).test(v)) out.push(at + ': pattern mismatch');
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) out.push(at + ': too few items');
      if (s.maxItems !== undefined && v.length > s.maxItems) out.push(at + ': too many items');
      if (s.items) v.forEach((x, i) => check(s.items, x, at + '/' + i, out));
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of s.required || []) if (!(k in v)) out.push(at + ': missing ' + k);
      for (const k of Object.keys(v)) {
        if (s.properties && s.properties[k]) check(s.properties[k], v[k], at + '/' + k, out);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, v[k], at + '/' + k, out);
      }
    }
    if (s.anyOf) {
      const ok = s.anyOf.some((sub) => { const e = []; check(sub, v, at, e); return e.length === 0; });
      if (!ok) out.push(at + ': matches no anyOf branch');
    }
    if (s.allOf) for (const sub of s.allOf) check(sub, v, at, out);
    if (s.if) {
      const e = [];
      check(s.if, v, at, e);
      if (e.length === 0 && s.then) check(s.then, v, at, out);
    }
  }
  check(start || root, value, '#', errors);
  return errors;
}

/** A fully populated raw project (shapes per SPEC §4). */
function sampleProject() {
  return {
    schema: 'lightplan/project', version: 1, id: 'prj_ab12cd', name: '123 Maple St',
    createdAt: '2026-11-08T17:00:00.000Z', updatedAt: '2026-11-08T17:20:00.000Z',
    customer: { name: 'Pat', address: '123 Maple St', phone: '555-0100', email: 'pat@example.com' },
    settings: { wastePct: 10, roofPitch: { rise: 6, run: 12 }, colorMode: 'warmWhite', customColors: ['#ff3b30', '#34c759'], lengthFormat: 'ft-in' },
    images: [{
      id: 'img_1', name: 'front.jpg', width: 2048, height: 1536,
      source: { kind: 'upload', capturedAt: null, attribution: null },
      exif: { focal35: 26, focalMm: 5.96, make: 'Apple', model: 'iPhone 15' },
      camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img_1',
    }],
    activeImageId: 'img_1',
    planes: [
      {
        id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall', color: '#4f9dff',
        rect: { corners: [[100, 200], [900, 210], [905, 600], [95, 590]], widthFt: 16, heightFt: 7, presetId: 'garage-double' },
        refs: [
          { id: 'ref_1', kind: 'line', points: [[120, 590], [120, 400]], lengthFt: 6.6667, presetId: 'door-height', courses: null, quality: 'high' },
          { id: 'ref_2', kind: 'rect', points: [[300, 400], [360, 400], [360, 590], [300, 590]], widthFt: 3, heightFt: 6.6667, presetId: 'door-rect', quality: 'high' },
        ],
        derived: null,
      },
      {
        id: 'pl_roof', imageId: 'img_1', name: 'Main roof', kind: 'roof', color: '#ff8a3d', rect: null, refs: [],
        derived: { parentPlaneId: 'pl_front', line: [[100, 200], [900, 210]], pitch: null },
      },
    ],
    features: [{
      id: 'ft_1', imageId: 'img_1', planeId: 'pl_front', type: 'roofline', label: 'Front eave',
      points: [[100, 190], [900, 200]], closed: false, overrideFt: null, productId: null, color: null,
      params: { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: 'out_1', reverse: false, overrideWidthFt: null, overrideHeightFt: null },
    }, {
      id: 'ft_2', imageId: 'img_1', planeId: 'pl_front', type: 'window', label: 'Bay window',
      points: [[400, 300], [500, 300], [500, 380], [400, 380]], closed: true, overrideFt: 14, productId: 'mini-led-100',
      color: { mode: 'custom', colors: ['#ff0000'] },
      params: { mount: 'adhesive', diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: true, overrideWidthFt: null, overrideHeightFt: null },
    }],
    outlets: [{ id: 'out_1', imageId: 'img_1', planeId: 'pl_front', point: [500, 580], label: 'Porch outlet', type: 'exteriorGfci', gfci: true, circuitId: 'cir_1', receptacles: 2 }],
    circuits: [{ id: 'cir_1', name: 'Porch circuit', breakerAmps: 15, voltage: 120, existingLoadW: 0 }],
    library: { products: null, config: null },
    pricing: { overrides: { 'c9-led': 29.99 } },
    quote: { enabled: false, company: '', laborMethod: 'perFt', ratePerFt: 3.5, ratePerHour: 65, markupPct: 30, takedownFee: 150, storageFee: 75, taxPct: 0, validDays: 30, notes: '' },
  };
}

// ------------------------------------------------------------------ JSON Schema
test('JSON_SCHEMA deep-equals schema/project.schema.json', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'project.schema.json'), 'utf8'));
  assert.deepEqual(file, schema.JSON_SCHEMA);
});

test('JSON_SCHEMA is draft 2020-12 and documents every field', () => {
  const s = schema.JSON_SCHEMA;
  assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(s.properties.schema.const, schema.SCHEMA_ID);
  assert.equal(s.properties.version.const, schema.SCHEMA_VERSION);
  const missing = [];
  const describes = (prop) => !!prop.description || (prop.$ref && !!s.$defs[prop.$ref.replace('#/$defs/', '')].description);
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) for (const [k, v] of Object.entries(node.properties)) { if (!describes(v)) missing.push(at + '.' + k); walk(v, at + '.' + k); }
    for (const k of ['items', 'additionalProperties']) if (node[k] && typeof node[k] === 'object') walk(node[k], at + '[' + k + ']');
  };
  walk(s, 'project');
  for (const [k, v] of Object.entries(s.$defs)) { if (!v.description) missing.push('$defs.' + k); walk(v, '$defs.' + k); }
  assert.deepEqual(missing, []);
  // Every field of each §4 object is required in the schema (derived plan output stays loose).
  const req = (name) => s.$defs[name].required.slice().sort();
  assert.deepEqual(req('feature'), Object.keys(schema.createFeature('roofline')).sort());
  assert.deepEqual(req('featureParams'), Object.keys(schema.createFeature('tree').params).sort());
  assert.deepEqual(req('outlet'), Object.keys(schema.createOutlet()).sort());
  assert.deepEqual(req('circuit'), Object.keys(schema.createCircuit()).sort());
  assert.deepEqual(req('image'), Object.keys(schema.createImage()).sort());
  assert.deepEqual(req('plane'), Object.keys(schema.createPlane()).sort());
  assert.deepEqual(s.required.slice().sort(), Object.keys(schema.createProject()).sort());
});

test('normalized projects and factory output conform to JSON_SCHEMA; broken ones do not', () => {
  const S = schema.JSON_SCHEMA;
  assert.deepEqual(validateJson(S, schema.createProject({ now: '2026-11-08T17:00:00.000Z' })), []);
  assert.deepEqual(validateJson(S, sampleProject()), []);
  assert.deepEqual(validateJson(S, schema.normalizeProject(sampleProject())), []);
  assert.deepEqual(validateJson(S, schema.normalizeProject({ planes: [{ kind: 'ground' }], features: [{ type: 'bush' }], outlets: [{}] })), []);
  const p = schema.createProject();
  p.planes.push(schema.createPlane({ kind: 'roof' }));
  p.features.push(schema.createFeature('tree'));
  p.planes[0].refs.push(schema.createRef({ kind: 'rect', points: [[0, 0], [1, 0], [1, 1], [0, 1]], widthFt: 3, heightFt: 7 }));
  assert.deepEqual(validateJson(S, p), []);

  const bad = sampleProject();
  bad.features[0].type = 'spaceship';
  bad.planes[0].refs[0].points.push([1, 2]);
  bad.circuits[0].breakerAmps = 0;
  const errs = validateJson(S, bad);
  assert.ok(errs.some((e) => e.startsWith('#/features/0/type')), errs.join('\n'));
  assert.ok(errs.some((e) => e.startsWith('#/planes/0/refs/0/points')), errs.join('\n'));
  assert.ok(errs.some((e) => e.startsWith('#/circuits/0/breakerAmps')), errs.join('\n'));
  const exp = schema.exportProject(sampleProject(), { summary: { totalFt: 1 } }, {}, '2026-11-08T18:00:00.000Z');
  assert.deepEqual(validateJson(S, exp, S.$defs.exportFile), []);
  assert.ok(validateJson(S, { ...exp, project: bad }, S.$defs.exportFile).length > 0, 'the wrapped project is checked too');
});

// ------------------------------------------------------------------ ids and factories
test('uid makes prefixed ids and is deterministic with a seeded generator', () => {
  assert.match(schema.uid('ft'), /^ft_[0-9a-z]{8}$/);
  assert.match(schema.uid('pl_'), /^pl_[0-9a-z]{8}$/);
  assert.equal(schema.uid('img', geometry.rng(7)), schema.uid('img', geometry.rng(7)));
  assert.notEqual(schema.uid('img', geometry.rng(7)), schema.uid('img', geometry.rng(8)));
  assert.match(schema.uid('x', () => NaN), /^x_0{8}$/);
});

test('createProject fills every field with the §4 defaults', () => {
  const p = schema.createProject({ name: '123 Maple St', now: '2026-11-08T17:00:00.000Z', rng: geometry.rng(3) });
  assert.equal(p.schema, 'lightplan/project');
  assert.equal(p.version, 1);
  assert.match(p.id, /^prj_/);
  assert.equal(p.name, '123 Maple St');
  assert.equal(p.createdAt, '2026-11-08T17:00:00.000Z');
  assert.equal(p.updatedAt, '2026-11-08T17:00:00.000Z');
  assert.deepEqual(p.customer, { name: '', address: '', phone: '', email: '' });
  assert.deepEqual(p.settings, { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: ['#ff3b30', '#34c759'], lengthFormat: 'ft-in' });
  assert.deepEqual([p.images, p.planes, p.features, p.outlets], [[], [], [], []]);
  assert.equal(p.activeImageId, null);
  assert.equal(p.circuits.length, 1);
  assert.match(p.circuits[0].id, /^cir_/);
  assert.deepEqual({ ...p.circuits[0], id: 'x' }, { id: 'x', name: 'Circuit 1', breakerAmps: 15, voltage: 120, existingLoadW: 0 });
  assert.deepEqual(p.library, { products: null, config: null });
  assert.deepEqual(p.pricing, { overrides: {} });
  assert.deepEqual(p.quote, { enabled: false, company: '', laborMethod: 'perFt', ratePerFt: 3.5, ratePerHour: 65, markupPct: 30,
    takedownFee: 150, storageFee: 75, taxPct: 0, validDays: 30, notes: '' });
  assert.equal(schema.createProject().createdAt, null, 'core code never reads the clock');
  assert.deepEqual(schema.validateProject(p), { ok: true, errors: [] });
  assert.deepEqual(schema.createProject({ rng: geometry.rng(3) }), schema.createProject({ rng: geometry.rng(3) }));
});

test('entity factories fill every field', () => {
  const im = schema.createImage({ name: 'front.jpg', width: 2048, height: 1536 });
  assert.match(im.id, /^img_/);
  assert.equal(im.storageKey, im.id);
  assert.deepEqual(im.source, { kind: 'upload', capturedAt: null, attribution: null });
  assert.equal(im.exif, null);
  assert.deepEqual(im.camera, { mode: 'auto', presetId: 'phone1x', focalPx: null });
  assert.equal(schema.createImage({ id: 'img_s', source: { kind: 'sample' }, storageKey: 'sample' }).storageKey, 'sample');

  const wall = schema.createPlane({ name: 'Front wall' });
  assert.match(wall.id, /^pl_/);
  assert.deepEqual({ ...wall, id: 'x' }, { id: 'x', imageId: null, name: 'Front wall', kind: 'wall', color: '#4f9dff', rect: null, refs: [], derived: null });
  const roof = schema.createPlane({ kind: 'roof', derived: { parentPlaneId: 'pl_front', line: [[0, 0], [10, 0]], pitch: { rise: 8, run: 12 } } });
  assert.equal(roof.name, 'Roof');
  assert.deepEqual(roof.derived, { parentPlaneId: 'pl_front', line: [[0, 0], [10, 0]], pitch: { rise: 8, run: 12 } });
  assert.deepEqual(schema.createPlane({ kind: 'ground' }).derived, { parentPlaneId: null, line: null, pitch: null });

  const line = schema.createRef({ points: [[0, 0], [0, 100]], lengthFt: 6.6667, presetId: 'door-height' });
  assert.deepEqual(Object.keys(line).sort(), ['courses', 'id', 'kind', 'lengthFt', 'points', 'presetId', 'quality']);
  assert.equal(line.kind, 'line');
  const rect = schema.createRef({ kind: 'rect', points: [[0, 0], [1, 0], [1, 1], [0, 1]], widthFt: 3, heightFt: 6.6667 });
  assert.deepEqual(Object.keys(rect).sort(), ['heightFt', 'id', 'kind', 'points', 'presetId', 'quality', 'widthFt']);
  assert.equal(schema.createRef({ kind: 'rect' }).kind, 'rect', 'a ref with no points yet is still complete');

  const win = schema.createFeature('window', { planeId: 'pl_front', points: [[0, 0], [1, 0], [1, 1]] });
  assert.match(win.id, /^ft_/);
  assert.equal(win.closed, true);
  assert.equal(win.label, 'Window outline');
  assert.deepEqual(win.params, { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false, overrideWidthFt: null, overrideHeightFt: null });
  assert.equal(schema.createFeature('door').closed, false);
  assert.equal(schema.createFeature('roofline', { label: 'Front eave' }).label, 'Front eave');
  assert.throws(() => schema.createFeature('spaceship'), /Unknown feature type/);

  const out = schema.createOutlet({ label: 'Garage', type: 'garage', point: [1, 2] });
  assert.equal(out.gfci, false, 'only exterior GFCI outlets default to GFCI protected');
  assert.equal(schema.createOutlet().gfci, true);
  assert.equal(schema.createOutlet().receptacles, 2);
  assert.equal(schema.createCircuit({ breakerAmps: 20 }).breakerAmps, 20);
  assert.equal(schema.createFeature('roofline', { id: 'ft_x' }).id, 'ft_x');
});

// ------------------------------------------------------------------ normalizeProject
test('normalizeProject never throws and returns a valid project for any input', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'images', { enumerable: true, get() { throw new Error('boom'); } });
  const inputs = [null, undefined, 0, 'x', [], {}, { features: 'nope', planes: [null, 3, 'a'] }, hostile];
  inputs.forEach((input, i) => {
    const p = schema.normalizeProject(input);
    assert.deepEqual(schema.validateProject(p), { ok: true, errors: [] }, 'input #' + i);
  });
  const empty = schema.normalizeProject({});
  assert.deepEqual(empty.circuits, [{ id: 'cir_1', name: 'Circuit 1', breakerAmps: 15, voltage: 120, existingLoadW: 0 }]);
  assert.deepEqual(schema.normalizeProject({ circuits: [] }).circuits, [], 'an explicit empty list stays empty');
});

test('normalizeProject fills a partial project without mutating it', () => {
  const raw = deepFreeze({
    name: 'Partial', settings: { wastePct: '15', colorMode: 'neon' },
    images: [{ id: 'img_a', width: 1000, height: 800 }],
    planes: [{ id: 'pl_a', name: 'Front', refs: [{ points: [[0, 0], [0, 10]], lengthFt: 6.5 }, { kind: 'rect', points: [[0, 0], [1, 1]] }] }],
    features: [{ type: 'roofline', planeId: 'pl_a', points: [[0, 0], { x: 10, y: 0 }, [NaN, 1]] }],
  });
  const before = JSON.stringify(raw);
  const p = schema.normalizeProject(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(p.name, 'Partial');
  assert.equal(p.settings.wastePct, 15, 'numeric strings are accepted');
  assert.equal(p.settings.colorMode, 'warmWhite', 'unknown enum values fall back to the default');
  assert.equal(p.activeImageId, 'img_a');
  assert.equal(p.planes[0].imageId, 'img_a', 'missing imageId falls back to the active image');
  assert.equal(p.planes[0].kind, 'wall');
  assert.equal(p.planes[0].refs.length, 1, 'a rect ref with 2 points is dropped');
  assert.match(p.planes[0].refs[0].id, /^ref_/);
  assert.equal(p.features[0].id, 'ft_1');
  assert.equal(p.features[0].imageId, 'img_a', 'feature imageId comes from its plane');
  assert.deepEqual(p.features[0].points, [[0, 0], [10, 0]]);
  assert.equal(p.features[0].label, 'Roofline / eave');
  assert.deepEqual(schema.validateProject(p), { ok: true, errors: [] });
});

test('normalizeProject repairs ids and references deterministically', () => {
  const raw = {
    images: [{ id: 'img_1', width: 10, height: 10 }],
    planes: [{ id: 'pl_1' }, { id: 'pl_1' }, { kind: 'roof', derived: { parentPlaneId: 'pl_gone', line: [[0, 0], [1, 0]] } }],
    features: [{ id: 'ft_2', type: 'gutter' }, { type: 'gutter' }, { id: 'ft_2', type: 'gutter', planeId: 'pl_gone', params: { outletId: 'out_gone' } }],
    outlets: [{ id: 'out_1', circuitId: 'cir_gone', planeId: 'pl_1' }],
    circuits: [{ id: 'cir_9', breakerAmps: '20' }],
  };
  const a = schema.normalizeProject(raw);
  assert.deepEqual(a.planes.map((p) => p.id), ['pl_1', 'pl_2', 'pl_3']);
  assert.equal(a.planes[2].derived.parentPlaneId, null);
  assert.deepEqual(a.features.map((f) => f.id), ['ft_2', 'ft_3', 'ft_4']);
  assert.equal(a.features[2].planeId, null);
  assert.equal(a.features[2].params.outletId, null);
  assert.equal(a.outlets[0].circuitId, null);
  assert.equal(a.outlets[0].planeId, 'pl_1');
  assert.equal(a.circuits[0].breakerAmps, 20);
  assert.deepEqual(schema.normalizeProject(raw), a, 'deterministic');
  assert.deepEqual(schema.normalizeProject(a), a, 'idempotent');
  assert.match(a.id, /^prj_[0-9a-z]+$/);
  assert.equal(schema.normalizeProject(raw).id, a.id, 'a missing project id is derived from the content');
});

test('normalizeProject keeps unknown keys and drops derived results', () => {
  const p = schema.normalizeProject({ ...sampleProject(), derived: { summary: {} }, futureField: { a: 1 },
    features: [{ ...sampleProject().features[0], hidden: true }] });
  assert.equal('derived' in p, false);
  assert.deepEqual(p.futureField, { a: 1 });
  assert.equal(p.features[0].hidden, true);
  const n = schema.normalizeProject(sampleProject());
  assert.deepEqual(n, sampleProject(), 'a complete valid project passes through unchanged');
});

// ------------------------------------------------------------------ migrateProject
test('migrateProject handles version 1, missing versions and refuses future versions', () => {
  const raw = deepFreeze(sampleProject());
  const m = schema.migrateProject(raw);
  assert.notEqual(m, raw);
  assert.deepEqual(m, sampleProject());
  const legacy = clone(sampleProject());
  delete legacy.version;
  delete legacy.schema;
  assert.equal(schema.migrateProject(legacy).version, 1);
  assert.equal(schema.migrateProject(legacy).schema, 'lightplan/project');
  assert.equal(schema.migrateProject({ ...sampleProject(), version: '1' }).version, 1);
  assert.throws(() => schema.migrateProject({ ...sampleProject(), version: 2 }), (e) => e instanceof Error && /newer version of LightPlan/.test(e.message));
  assert.throws(() => schema.migrateProject({ ...sampleProject(), version: 0 }), /unknown format version/);
  assert.throws(() => schema.migrateProject({ ...sampleProject(), version: 'beta' }), /unknown format version/);
  assert.throws(() => schema.migrateProject(null), /^Error: This file is not a LightPlan project\.$/);
  assert.throws(() => schema.migrateProject({ schema: 'something/else' }), /not a LightPlan project/);
});

// ------------------------------------------------------------------ validateProject
test('validateProject accepts valid projects and explains problems in plain words', () => {
  assert.deepEqual(schema.validateProject(sampleProject()), { ok: true, errors: [] });
  const bad = sampleProject();
  bad.features[0].type = 'spaceship';
  bad.features[1].planeId = 'pl_gone';
  bad.features.push(clone(bad.features[1]));
  bad.outlets[0].type = 'socket';
  bad.circuits[0].breakerAmps = -5;
  bad.settings.wastePct = 300;
  bad.planes[0].rect.corners.pop();
  bad.quote.laborMethod = 'perDay';
  delete bad.customer;
  const r = schema.validateProject(bad);
  assert.equal(r.ok, false);
  const has = (re) => assert.ok(r.errors.some((e) => re.test(e)), re + ' in\n' + r.errors.join('\n'));
  has(/^Feature "Front eave" has an unknown type "spaceship"\.$/);
  has(/^Feature "Bay window" is on a plane that does not exist\.$/);
  has(/^Two features share the id "ft_2"\.$/);
  has(/^Outlet "Porch outlet": the type must be one of/);
  has(/^Circuit "Porch circuit": the breaker size must be a positive number of amps\.$/);
  has(/^Waste must be a percentage from 0 to 100\.$/);
  has(/^Plane "Front wall": the rectangle needs exactly 4 corner points\.$/);
  has(/^The labor method must be perFt or perHour\.$/);
  has(/^Customer details are missing\.$/);
  for (const e of r.errors) assert.match(e, /^[A-Z"].*\.$/, 'every error is a sentence: ' + e);
});

test('validateProject never throws', () => {
  const hostile = sampleProject();
  Object.defineProperty(hostile, 'planes', { get() { throw new Error('boom'); } });
  for (const input of [null, undefined, 42, 'x', [], {}, { planes: [null] }, hostile]) {
    const r = schema.validateProject(input);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
  }
});

// ------------------------------------------------------------------ export / import
test('exportProject builds the wrapper purely from its arguments', () => {
  const plan = { summary: { totalFt: 52.5 }, bad: () => 1 };
  const images = { img_1: 'data:image/jpeg;base64,AAAA', other: 'data:image/jpeg;base64,BBBB', img_2: 'not-a-data-url' };
  const raw = deepFreeze(sampleProject());
  const e = schema.exportProject(raw, plan, images, '2026-11-08T18:00:00.000Z');
  assert.deepEqual(Object.keys(e), ['schema', 'version', 'exportedAt', 'project', 'images', 'derived']);
  assert.equal(e.schema, 'lightplan/export');
  assert.equal(e.version, 1);
  assert.equal(e.exportedAt, '2026-11-08T18:00:00.000Z');
  assert.deepEqual(e.project, sampleProject());
  assert.deepEqual(e.images, { img_1: 'data:image/jpeg;base64,AAAA' }, 'only photos the project uses');
  assert.deepEqual(e.derived, { summary: { totalFt: 52.5 } });
  assert.notEqual(e.derived.summary, plan.summary);
  const bare = schema.exportProject(sampleProject());
  assert.equal(bare.exportedAt, null);
  assert.equal(bare.derived, null);
  assert.deepEqual(bare.images, {});
});

test('importProject round-trips an export and accepts a bare project or JSON text', () => {
  const images = { img_1: 'data:image/jpeg;base64,AAAA' };
  const e = schema.exportProject(sampleProject(), { summary: {} }, images, '2026-11-08T18:00:00.000Z');
  const r = schema.importProject(JSON.parse(JSON.stringify(e)));
  assert.deepEqual(r, { project: sampleProject(), images });
  assert.deepEqual(schema.importProject(JSON.stringify(e)), r);
  assert.deepEqual(schema.importProject(sampleProject()), { project: sampleProject(), images: {} });
  const partial = schema.importProject({ planes: [], features: [{ type: 'gutter', points: [[0, 0], [5, 0]] }] });
  assert.equal(partial.project.features[0].type, 'gutter');
  const withDerived = schema.importProject({ ...sampleProject(), derived: { summary: { cost: 1e9 } } });
  assert.equal('derived' in withDerived.project, false, 'derived results are never trusted from a file');
  const badImages = schema.importProject({ ...e, images: { img_1: 'javascript:alert(1)' } });
  assert.deepEqual(badImages.images, {});
});

test('importProject refuses files it cannot use with plain messages', () => {
  const notProject = /^This file is not a LightPlan project\.$/;
  for (const input of [null, 42, 'not json', '[]', [], {}, { hello: 'world' }, { schema: 'lightplan/export', project: 'x' }]) {
    assert.throws(() => schema.importProject(input), (e) => e instanceof Error && notProject.test(e.message), JSON.stringify(input));
  }
  assert.throws(() => schema.importProject({ ...sampleProject(), version: 3 }), /newer version of LightPlan \(format version 3\)/);
  assert.throws(() => schema.importProject({ schema: 'lightplan/export', version: 2, project: sampleProject() }), /newer version of LightPlan \(export version 2\)/);
  const bad = sampleProject();
  bad.features[0].type = 'spaceship';
  assert.throws(() => schema.importProject(bad), /^Error: This project file has problems: Feature "Front eave" has an unknown type "spaceship"\.$/);
});

test('ENUMS stay in step with the catalog', () => {
  assert.deepEqual(schema.ENUMS.featureType, catalog.TYPE_ORDER);
  assert.deepEqual(schema.ENUMS.colorMode, Object.keys(catalog.COLOR_MODES));
  assert.deepEqual(schema.ENUMS.mount.filter((m) => !['stake', 'none'].includes(m)).sort(), Object.keys(catalog.CLIP_TYPES).sort());
});
