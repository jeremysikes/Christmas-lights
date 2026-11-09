// Tests for src/core/sample.js: the built-in sample house (art, traced project, ground truth, accuracy demo).
const LP = require('./loader');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sample = LP.require('sample');
const g = LP.require('geometry');
const hasMeasure = LP.has('measure');
const measure = hasMeasure ? LP.require('measure') : null;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPt = (p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]);
const isTenth = (v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;

/** Every image point stored in a project: rect corners, refs, derived lines, features, outlets. */
function allProjectPoints(project) {
  const out = [];
  for (const pl of project.planes) {
    if (pl.rect) pl.rect.corners.forEach((p) => out.push({ where: pl.name + ' rectangle', p }));
    for (const r of pl.refs) r.points.forEach((p) => out.push({ where: pl.name + ' ref ' + r.id, p }));
    if (pl.derived) pl.derived.line.forEach((p) => out.push({ where: pl.name + ' line', p }));
  }
  for (const f of project.features) f.points.forEach((p) => out.push({ where: f.label, p }));
  for (const o of project.outlets) out.push({ where: o.label, p: o.point });
  return out;
}

const s = sample.createSample();
const byId = (id) => s.project.features.find((f) => f.id === id);
const plane = (id) => s.project.planes.find((p) => p.id === id);

// ---------------------------------------------------------------- shape and determinism
test('createSample returns the SPEC shape at 1600 × 1100', () => {
  assert.equal(s.width, 1600);
  assert.equal(s.height, 1100);
  assert.equal(sample.SAMPLE_WIDTH, 1600);
  assert.equal(sample.SAMPLE_HEIGHT, 1100);
  assert.ok(Array.isArray(s.primitives));
  assert.ok(s.primitives.length > 500, 'a detailed illustration');
  assert.ok(s.primitives.length < 3000, 'stays under ~3000 primitives (' + s.primitives.length + ')');
  for (const k of ['project', 'groundTruth', 'camera']) assert.ok(s[k] && typeof s[k] === 'object', k);
});

test('output is deterministic and every call returns fresh objects', () => {
  const a = sample.createSample();
  const b = sample.createSample({ traced: true });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  a.project.features[0].points[0][0] = -999;
  a.primitives[0].x = -999;
  a.groundTruth.ft_eave = 1;
  const c = sample.createSample();
  assert.equal(JSON.stringify(c), JSON.stringify(b));
});

test('bad options fall back to the traced sample', () => {
  for (const opts of [undefined, null, 42, 'x', [], {}]) {
    const r = sample.createSample(opts);
    assert.ok(r.project.features.length > 0);
  }
});

// ---------------------------------------------------------------- camera
test('camera: 26 mm-equivalent focal, 15–25° yaw, ≥ 8° tilt, 60–75 ft away at eye height', () => {
  const cam = s.camera;
  assert.ok(Math.abs(cam.f - (26 * Math.hypot(1600, 1100)) / 43.2666) < 1e-9);
  assert.equal(cam.cx, 800);
  assert.equal(cam.cy, 550);
  assert.ok(cam.yawDeg >= 15 && cam.yawDeg <= 25);
  assert.ok(cam.tiltDeg >= 8);
  assert.equal(cam.position.length, 3);
  assert.ok(cam.position[2] >= 60 && cam.position[2] <= 75, 'distance from the facade');
  assert.equal(cam.distanceFt, cam.position[2]);
  assert.ok(Math.abs(cam.position[1] - 5.5) < 0.5, 'eye height');
});

test('re-projecting the 3D model with the returned camera reproduces the traced points', () => {
  const cam = s.camera;
  const yaw = (cam.yawDeg * Math.PI) / 180, tilt = (cam.tiltDeg * Math.PI) / 180;
  const fwd = [-Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), -Math.cos(yaw) * Math.cos(tilt)];
  const right = g.v3norm([-fwd[2], 0, fwd[0]]);
  const down = g.v3cross(fwd, right);
  const proj = (X) => {
    const d = g.v3sub(X, cam.position);
    const z = g.v3dot(fwd, d);
    return [(cam.f * g.v3dot(right, d)) / z + cam.cx, (cam.f * g.v3dot(down, d)) / z + cam.cy];
  };
  const near = (p, X) => assert.ok(g.dist(p, proj(X)) < 0.08, JSON.stringify(p) + ' vs ' + JSON.stringify(proj(X)));
  const rect = plane('pl_front').rect.corners;
  near(rect[0], [0, 10, 0]);
  near(rect[1], [34, 10, 0]);
  near(rect[2], [34, 0, 0]);
  near(rect[3], [0, 0, 0]);
  near(byId('ft_ridge').points[1], [34, 17, -14]);
  near(byId('ft_garage_gutter').points[1], [56, 9, -4]);
  near(byId('ft_tree').points[0], [-10, 0, 12]);
  near(byId('ft_walk_right').points[1], [19, 0, 16]);
});

// ---------------------------------------------------------------- traced project
test('every traced point is inside the image and rounded to 0.1 px', () => {
  const pts = allProjectPoints(s.project);
  assert.ok(pts.length > 60);
  for (const { where, p } of pts) {
    assert.ok(isPt(p), where + ' has a valid point');
    assert.ok(p[0] >= 0 && p[0] <= s.width && p[1] >= 0 && p[1] <= s.height, where + ' is inside the image: ' + JSON.stringify(p));
    assert.ok(isTenth(p[0]) && isTenth(p[1]), where + ' rounded to 0.1 px: ' + JSON.stringify(p));
  }
});

test('project follows the SPEC §4 data model', () => {
  const p = s.project;
  assert.equal(p.schema, 'lightplan/project');
  assert.equal(p.version, 1);
  assert.match(p.id, /^prj_/);
  assert.equal(p.settings.roofPitch, null, 'pitch is left for the estimate from the gable');
  assert.equal(p.settings.wastePct, 10);
  assert.deepEqual(p.library, { products: null, config: null });
  assert.deepEqual(p.pricing, { overrides: {} });
  assert.equal(p.quote.enabled, false);
  assert.equal(p.images.length, 1);
  const img = p.images[0];
  assert.equal(img.id, 'img_sample');
  assert.equal(img.name, 'Sample house');
  assert.equal(img.width, 1600);
  assert.equal(img.height, 1100);
  assert.equal(img.source.kind, 'sample');
  assert.equal(img.exif, null);
  assert.equal(img.camera.mode, 'auto');
  assert.equal(img.storageKey, 'sample');
  assert.equal(p.activeImageId, 'img_sample');
  const ids = new Set();
  for (const coll of [p.planes, p.features, p.outlets, p.circuits]) {
    for (const item of coll) {
      assert.ok(!ids.has(item.id), 'unique id ' + item.id);
      ids.add(item.id);
    }
  }
  for (const pl of p.planes) {
    assert.match(pl.id, /^pl_/);
    assert.equal(pl.imageId, 'img_sample');
    assert.ok(['wall', 'roof', 'ground'].includes(pl.kind));
    assert.match(pl.color, /^#[0-9a-f]{6}$/i);
    for (const r of pl.refs) assert.match(r.id, /^ref_/);
  }
  for (const f of p.features) {
    assert.match(f.id, /^ft_/);
    assert.equal(f.imageId, 'img_sample');
    assert.ok(ids.has(f.planeId), f.label + ' sits on an existing plane');
    for (const k of ['overrideFt', 'productId', 'color']) assert.equal(f[k], null);
    for (const k of ['mount', 'diameterIn', 'spiralSpacingIn', 'wrapMode', 'outletId', 'reverse', 'overrideWidthFt', 'overrideHeightFt']) {
      assert.ok(k in f.params, f.label + ' params.' + k);
    }
    assert.equal(typeof f.closed, 'boolean');
  }
  for (const o of p.outlets) {
    assert.match(o.id, /^out_/);
    assert.ok(p.circuits.some((c) => c.id === o.circuitId));
  }
});

test('planes: front wall (unknown size + 2 refs), garage door rectangle, roof and yard', () => {
  const front = plane('pl_front');
  assert.equal(front.name, 'Front wall');
  assert.equal(front.kind, 'wall');
  assert.equal(front.rect.widthFt, null);
  assert.equal(front.rect.heightFt, null);
  assert.deepEqual(g.orderQuad(front.rect.corners), front.rect.corners, 'stored as [TL, TR, BR, BL]');
  const doorRef = front.refs.find((r) => r.presetId === 'door-height');
  assert.ok(doorRef);
  assert.equal(doorRef.kind, 'line');
  assert.ok(Math.abs(doorRef.lengthFt - 80 / 12) < 1e-9);
  const tape = front.refs.find((r) => r.presetId === 'custom-line');
  assert.equal(tape.lengthFt, 4);
  assert.equal(tape.label, 'Window width (tape)');
  // One reference runs vertically and one horizontally (so both scale directions are pinned).
  const dirOf = (r) => Math.abs(r.points[1][1] - r.points[0][1]) > Math.abs(r.points[1][0] - r.points[0][0]) ? 'v' : 'h';
  assert.equal(dirOf(doorRef), 'v');
  assert.equal(dirOf(tape), 'h');

  const garage = plane('pl_garage');
  assert.equal(garage.name, 'Garage wall');
  assert.equal(garage.rect.presetId, 'garage-double');
  assert.equal(garage.rect.widthFt, 16);
  assert.equal(garage.rect.heightFt, 7);
  const siding = garage.refs[0];
  assert.equal(siding.presetId, 'siding-5');
  assert.equal(siding.courses, 12);
  assert.equal(siding.lengthFt, 5);
  assert.equal(siding.quality, 'medium');

  const roof = plane('pl_roof');
  assert.equal(roof.name, 'Main roof');
  assert.equal(roof.kind, 'roof');
  assert.equal(roof.rect, null);
  assert.equal(roof.derived.parentPlaneId, 'pl_front');
  assert.equal(roof.derived.pitch, null);
  assert.deepEqual(roof.derived.line, [front.rect.corners[0], front.rect.corners[1]], 'front eave line');

  const yard = plane('pl_yard');
  assert.equal(yard.name, 'Front yard');
  assert.equal(yard.kind, 'ground');
  assert.deepEqual(yard.derived.line, [front.rect.corners[3], front.rect.corners[2]], 'front wall base line');
});

test('features: labels, types, planes and point counts', () => {
  const expect = {
    ft_eave: ['Front eave', 'roofline', 'pl_front', 2],
    ft_garage_gutter: ['Garage gutter', 'gutter', 'pl_garage', 2],
    ft_gable_left: ['Entry gable left', 'rake', 'pl_front', 2],
    ft_gable_right: ['Entry gable right', 'rake', 'pl_front', 2],
    ft_roof_rake: ['Main roof left rake', 'rake', 'pl_roof', 2],
    ft_ridge: ['Ridge', 'ridge', 'pl_roof', 2],
    ft_window_left: ['Window left', 'window', 'pl_front', 4],
    ft_window_right: ['Window right', 'window', 'pl_front', 4],
    ft_door: ['Front door', 'door', 'pl_front', 4],
    ft_bush_1: ['Bush 1', 'bush', 'pl_front', 12],
    ft_bush_2: ['Bush 2', 'bush', 'pl_front', 12],
    ft_bush_3: ['Bush 3', 'bush', 'pl_front', 12],
    ft_tree: ['Maple tree', 'tree', 'pl_yard', 2],
    ft_walk_left: ['Walkway left edge', 'walkway', 'pl_yard', 2],
    ft_walk_right: ['Walkway right edge', 'walkway', 'pl_yard', 2],
  };
  assert.deepEqual(s.project.features.map((f) => f.id).sort(), Object.keys(expect).sort());
  for (const [id, [label, type, planeId, n]] of Object.entries(expect)) {
    const f = byId(id);
    assert.equal(f.label, label, id);
    assert.equal(f.type, type, id);
    assert.equal(f.planeId, planeId, id);
    assert.equal(f.points.length, n, id);
  }
  assert.equal(byId('ft_window_left').closed, true);
  assert.equal(byId('ft_door').closed, false, 'door outline is open at the bottom');
  assert.equal(byId('ft_bush_1').closed, true);
  assert.equal(byId('ft_tree').params.diameterIn, 10);
  // The tree is traced base → top: the second point is higher on screen.
  assert.ok(byId('ft_tree').points[1][1] < byId('ft_tree').points[0][1]);
  // Bush outlines are simple (non-self-intersecting, positive area) polygons.
  for (const id of ['ft_bush_1', 'ft_bush_2', 'ft_bush_3']) assert.ok(g.polygonArea(byId(id).points) > 1500, id);
});

test('outlets and circuits: porch GFCI on 15 A, garage GFCI on 20 A', () => {
  const porch = s.project.outlets.find((o) => o.label === 'Porch outlet');
  const gar = s.project.outlets.find((o) => o.label === 'Garage outlet');
  assert.equal(porch.planeId, 'pl_front');
  assert.equal(porch.type, 'exteriorGfci');
  assert.equal(porch.gfci, true);
  assert.equal(gar.planeId, 'pl_garage');
  assert.equal(gar.gfci, true);
  const circuit = (o) => s.project.circuits.find((c) => c.id === o.circuitId);
  assert.equal(circuit(porch).name, 'Porch circuit');
  assert.equal(circuit(porch).breakerAmps, 15);
  assert.equal(circuit(gar).name, 'Garage circuit');
  assert.equal(circuit(gar).breakerAmps, 20);
  for (const c of s.project.circuits) assert.equal(c.voltage, 120);
});

// ---------------------------------------------------------------- ground truth
test('ground truth comes from the 3D model', () => {
  const t = s.groundTruth;
  const close = (id, v) => assert.ok(Math.abs(t[id] - v) < 0.002, id + ': ' + t[id] + ' vs ' + v);
  close('ft_eave', 34);
  close('ft_garage_gutter', 22);
  close('ft_gable_left', Math.hypot(8, 4));
  close('ft_gable_right', Math.hypot(8, 4));
  close('ft_roof_rake', Math.hypot(14, 7));
  close('ft_ridge', 34);
  close('ft_window_left', 18);
  close('ft_window_right', 18);
  close('ft_door', 80 / 12 * 2 + 3);
  close('ft_tree', 7);
  close('ft_walk_left', 15);
  close('ft_walk_right', 15);
  for (const id of ['ft_bush_1', 'ft_bush_2', 'ft_bush_3']) assert.deepEqual(t[id], { widthFt: 4, heightFt: 3 });
  assert.deepEqual(Object.keys(t).sort(), s.project.features.map((f) => f.id).sort(), 'one truth per feature');
});

// ---------------------------------------------------------------- practice (untraced) sample
test('traced:false gives the same photo with one blank Front wall', () => {
  const u = sample.createSample({ traced: false });
  assert.equal(JSON.stringify(u.primitives), JSON.stringify(s.primitives));
  assert.equal(u.width, 1600);
  assert.equal(u.project.images[0].storageKey, 'sample');
  assert.equal(u.project.images[0].source.kind, 'sample');
  assert.equal(u.project.planes.length, 1);
  const pl = u.project.planes[0];
  assert.equal(pl.name, 'Front wall');
  assert.equal(pl.kind, 'wall');
  assert.equal(pl.rect, null);
  assert.deepEqual(pl.refs, []);
  assert.deepEqual(u.project.features, []);
  assert.deepEqual(u.project.outlets, []);
  assert.deepEqual(u.groundTruth, {});
  assert.deepEqual(u.camera, s.camera);
});

// ---------------------------------------------------------------- primitives
test('primitives are well-formed and stay mostly inside the image', () => {
  const colorOk = (c) => typeof c === 'string' && /^(#[0-9a-f]{6}|rgba?\([\d.,\s]+\))$/i.test(c);
  const fillOk = (f) => colorOk(f) || (f && Array.isArray(f.linear) && f.linear.length === 4 && f.linear.every(isNum) &&
    Array.isArray(f.stops) && f.stops.length >= 2 && f.stops.every((st) => isNum(st[0]) && st[0] >= 0 && st[0] <= 1 && colorOk(st[1])));
  const counts = {};
  for (const p of s.primitives) {
    counts[p.t] = (counts[p.t] || 0) + 1;
    if (p.t === 'rect') {
      assert.ok([p.x, p.y, p.w, p.h].every(isNum));
      assert.ok(fillOk(p.fill));
    } else if (p.t === 'poly') {
      assert.ok(p.pts.length >= 3 && p.pts.every(isPt));
      assert.ok(p.fill === undefined || fillOk(p.fill));
      assert.ok(p.fill !== undefined || p.stroke !== undefined, 'poly draws something');
      if (p.stroke) assert.ok(colorOk(p.stroke) && isNum(p.lw) && p.lw > 0);
    } else if (p.t === 'line') {
      assert.ok(p.pts.length >= 2 && p.pts.every(isPt));
      assert.ok(colorOk(p.stroke) && isNum(p.lw) && p.lw > 0);
    } else if (p.t === 'circle') {
      assert.ok(isPt(p.c) && isNum(p.r) && p.r > 0);
      assert.ok(fillOk(p.fill));
    } else {
      assert.fail('unknown primitive ' + p.t);
    }
  }
  assert.ok(counts.rect >= 1 && counts.poly > 100 && counts.line > 100 && counts.circle > 50, JSON.stringify(counts));
  // The first primitive is the sky and covers the top of the image.
  const sky = s.primitives[0];
  assert.equal(sky.t, 'rect');
  assert.equal(sky.x, 0);
  assert.equal(sky.y, 0);
  assert.equal(sky.w, 1600);
});

// ---------------------------------------------------------------- drawPrimitives
/** Records every call and property write on a minimal fake 2D context. */
function recordingContext({ gradients = true } = {}) {
  const calls = [];
  const ctx = {
    calls,
    save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
    beginPath() { calls.push(['beginPath']); }, closePath() { calls.push(['closePath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); }, lineTo(x, y) { calls.push(['lineTo', x, y]); },
    arc(x, y, r) { calls.push(['arc', x, y, r]); },
    fill() { calls.push(['fill', ctx.fillStyle]); }, stroke() { calls.push(['stroke', ctx.strokeStyle, ctx.lineWidth]); },
    fillRect(x, y, w, h) { calls.push(['fillRect', x, y, w, h, ctx.fillStyle]); },
    setLineDash(d) { calls.push(['setLineDash', d]); },
  };
  if (gradients) {
    ctx.createLinearGradient = (x0, y0, x1, y1) => {
      const grad = { kind: 'gradient', args: [x0, y0, x1, y1], stops: [], addColorStop(o, c) { grad.stops.push([o, c]); } };
      return grad;
    };
  }
  return ctx;
}

test('drawPrimitives draws every primitive on any 2D context', () => {
  const ctx = recordingContext();
  sample.drawPrimitives(ctx, s.primitives);
  const n = (name) => ctx.calls.filter((c) => c[0] === name).length;
  assert.equal(n('save'), 1);
  assert.equal(n('restore'), 1);
  assert.equal(n('fillRect'), s.primitives.filter((p) => p.t === 'rect').length);
  assert.equal(n('arc'), s.primitives.filter((p) => p.t === 'circle').length);
  assert.equal(n('beginPath'), s.primitives.filter((p) => p.t !== 'rect').length, 'rects use fillRect');
  assert.equal(n('stroke'), s.primitives.filter((p) => typeof p.stroke === 'string').length);
  const gradientFills = ctx.calls.filter((c) => (c[0] === 'fill' || c[0] === 'fillRect') && c[c.length - 1] && c[c.length - 1].kind === 'gradient');
  assert.ok(gradientFills.length > 5, 'gradients become canvas gradients');
  assert.ok(gradientFills.every((c) => c[c.length - 1].stops.length >= 2));
});

test('drawPrimitives falls back to solid colors without gradient support and skips bad input', () => {
  const ctx = recordingContext({ gradients: false });
  sample.drawPrimitives(ctx, s.primitives);
  assert.ok(ctx.calls.filter((c) => c[0] === 'fill').every((c) => typeof c[1] === 'string'));
  // Garbage never throws.
  const bad = [null, 7, { t: 'poly' }, { t: 'poly', pts: [[0, 0], ['x', 1]] }, { t: 'circle', c: [1, 2], r: -1 },
    { t: 'rect', x: 0, y: 0, w: NaN, h: 1, fill: '#fff' }, { t: 'line', pts: [[0, 0]] }, { t: 'mystery' },
    { t: 'line', pts: [[0, 0], [5, 5]], stroke: '#000', lw: 2, dash: [4, 2] }];
  const ctx2 = recordingContext();
  sample.drawPrimitives(ctx2, bad);
  assert.equal(ctx2.calls.filter((c) => c[0] === 'stroke').length, 1, 'only the valid dashed line is drawn');
  assert.deepEqual(ctx2.calls.filter((c) => c[0] === 'setLineDash').map((c) => c[1]), [[4, 2], []]);
  sample.drawPrimitives(null, s.primitives);
  sample.drawPrimitives({}, s.primitives);
  sample.drawPrimitives(recordingContext(), null);
  // A context that throws on one call does not stop the rest.
  const flaky = recordingContext();
  let first = true;
  flaky.arc = () => { if (first) { first = false; throw new Error('boom'); } };
  sample.drawPrimitives(flaky, s.primitives);
  assert.equal(flaky.calls.filter((c) => c[0] === 'restore').length, 1);
});

// ---------------------------------------------------------------- toSVG
/** Minimal XML well-formedness check: balanced tags, quoted attributes, no stray markup. */
function checkXml(xml) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(xml))) {
    assert.ok(!/[<>]/.test(xml.slice(last, m.index)), 'stray markup near ' + xml.slice(last, m.index).slice(0, 40));
    if (m[1]) assert.equal(stack.pop(), m[2], 'closing tag matches');
    else if (!m[4]) stack.push(m[2]);
    last = re.lastIndex;
  }
  assert.equal(last, xml.length, 'whole document parsed');
  assert.deepEqual(stack, []);
}

test('toSVG produces a well-formed standalone SVG document', () => {
  const svg = sample.toSVG(s.primitives, s.width, s.height);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100" viewBox="0 0 1600 1100">'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(!/NaN|undefined|Infinity|rgba\(/.test(svg), 'no invalid numbers or CSS-only colors');
  checkXml(svg);
  // Every gradient reference resolves.
  const ids = new Set([...svg.matchAll(/<linearGradient id="(g\d+)"/g)].map((m) => m[1]));
  const refs = [...svg.matchAll(/url\(#(g\d+)\)/g)].map((m) => m[1]);
  assert.ok(ids.size > 3 && refs.length > 3);
  for (const r of refs) assert.ok(ids.has(r), 'gradient ' + r + ' is defined');
  const shapes = (svg.match(/<(rect|polygon|polyline|circle) /g) || []).length;
  assert.equal(shapes, s.primitives.length, 'one SVG element per primitive');
});

test('toSVG converts rgba colors and escapes attributes; bad input gives an empty document', () => {
  const svg = sample.toSVG([
    { t: 'circle', c: [5, 5], r: 3, fill: 'rgba(10,20,30,0.5)', stroke: '#112233', lw: 2 },
    { t: 'poly', pts: [[0, 0], [4, 0], [4, 4]], closed: false, stroke: 'red"><script>', lw: 1 },
    { t: 'line', pts: [[0, 0], [1, 1]], stroke: '#000000', lw: 1, dash: [3, 1] },
    { t: 'poly', pts: [[0, 0], [1, NaN], [2, 2]], fill: '#fff' },
  ], 10, 10);
  assert.ok(svg.includes('fill="rgb(10,20,30)" fill-opacity="0.5"'));
  assert.ok(svg.includes('stroke-dasharray="3 1"'));
  assert.ok(svg.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(!svg.includes('<script'));
  checkXml(svg);
  const empty = sample.toSVG(null);
  assert.equal(empty, '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100" viewBox="0 0 1600 1100"></svg>');
});

// ---------------------------------------------------------------- accuracy demo (needs measure.js)
test('measuring the sample matches the 3D ground truth', { skip: hasMeasure ? false : 'src/core/measure.js is not written yet' }, (t) => {
  const r = measure.measureProject(s.project);
  assert.ok(r.ok);
  // Focal length recovered from a rectangle, within 2%.
  const K = r.cameras.img_sample;
  assert.equal(K.source, 'rectangle');
  const fErr = (100 * (K.f - s.camera.f)) / s.camera.f;
  t.diagnostic('focal: estimated ' + K.f.toFixed(1) + ' px, true ' + s.camera.f.toFixed(1) + ' px (' + fErr.toFixed(2) + '%), ' + K.label);
  assert.ok(Math.abs(fErr) < 2);
  // Roof pitch estimated from the in-plane entry gable.
  assert.equal(r.pitch.source, 'estimated');
  assert.equal(r.pitch.rise, 6);
  assert.equal(r.pitch.run, 12);
  for (const pl of s.project.planes) assert.ok(r.planes[pl.id].ok, pl.name + ' is solved: ' + r.planes[pl.id].reason);
  assert.equal(r.planes.pl_roof.mode, 'roof-3d');
  assert.equal(r.planes.pl_yard.mode, 'ground-3d');

  const lines = [];
  for (const f of s.project.features) {
    const m = r.features[f.id];
    assert.ok(m.ok, f.label + ' measured: ' + m.reason);
    const truth = s.groundTruth[f.id];
    if (f.type === 'bush') {
      // Bushes stand 2 ft in front of the wall, so their size on the wall plane is approximate.
      const ew = (100 * (m.widthFt - truth.widthFt)) / truth.widthFt;
      const eh = (100 * (m.heightFt - truth.heightFt)) / truth.heightFt;
      lines.push(f.label.padEnd(20) + ' width ' + m.widthFt.toFixed(2) + ' (' + ew.toFixed(1) + '%), height ' + m.heightFt.toFixed(2) + ' (' + eh.toFixed(1) + '%)');
      assert.ok(Math.abs(ew) < 15 && Math.abs(eh) < 15, f.label + ' within 15%');
      continue;
    }
    const err = (100 * (m.measuredFt - truth)) / truth;
    const kind = r.planes[f.planeId].kind;
    const tol = kind === 'wall' ? 1 : 2;
    lines.push(f.label.padEnd(20) + ' ' + m.measuredFt.toFixed(3).padStart(7) + ' ft vs ' + String(truth).padStart(6) + ' ft  ' +
      (err >= 0 ? '+' : '') + err.toFixed(2) + '%  (' + kind + ', ' + m.method + ', ' + m.confidence.level + ')');
    assert.ok(Math.abs(err) < tol, f.label + ': ' + err.toFixed(3) + '% exceeds ' + tol + '%');
  }
  for (const line of lines) t.diagnostic(line);
  // Cross-check reference on the garage agrees with the garage door rectangle.
  const siding = r.planes.pl_garage.refResults[0];
  assert.ok(Math.abs(siding.errorPct) < 1, 'siding courses agree with the garage door: ' + siding.errorPct);
  // Nothing in the sample should raise a warning other than the pitch note.
  assert.deepEqual(r.warnings.filter((w) => w.level === 'warn').map((w) => w.message), []);
});

// ---------------------------------------------------------------- integration with schema and plan (when present)
test('the sample is a valid, already-normalized project', { skip: LP.has('schema') ? false : 'src/core/schema.js is not written yet' }, () => {
  const schema = LP.require('schema');
  for (const traced of [true, false]) {
    const p = sample.createSample({ traced }).project;
    const v = schema.validateProject(p);
    assert.deepEqual(v.errors, [], 'traced:' + traced);
    assert.equal(v.ok, true);
    assert.equal(JSON.stringify(schema.normalizeProject(p)), JSON.stringify(p), 'normalizeProject changes nothing (traced:' + traced + ')');
  }
});

test('computePlan turns the sample into a full plan without danger warnings', { skip: LP.has('plan') ? false : 'src/core/plan.js is not written yet' }, (t) => {
  const plan = LP.require('plan').computePlan(s.project);
  assert.equal(plan.runs.length, s.project.features.length, 'one light run per traced feature');
  assert.ok(plan.summary.totalFt > 200 && plan.summary.totalFt < 320, 'total ' + plan.summary.totalFt);
  assert.deepEqual(plan.warnings.filter((w) => w.level === 'danger').map((w) => w.message), []);
  t.diagnostic('plan: ' + plan.summary.totalFt.toFixed(1) + ' ft, ' + plan.summary.strings + ' strings, $' + plan.summary.cost +
    ', warnings: ' + plan.warnings.map((w) => w.code).join(', '));
});

// ---------------------------------------------------------------- real canvas + SVG parser (optional)
let playwright = null;
try { playwright = require('playwright'); } catch (e) { playwright = null; }

test('renders on a real canvas and the SVG parses in a browser', { skip: playwright ? false : 'playwright is not installed', timeout: 60000 }, async (t) => {
  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (e) {
    t.skip('Chromium could not start: ' + e.message.split('\n')[0]);
    return;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
    const root = path.join(__dirname, '..');
    const src = ['src/core/lp.js', 'src/core/geometry.js', 'src/core/sample.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n;\n');
    await page.setContent('<canvas id="c" width="1600" height="1100" style="display:block"></canvas>');
    await page.addScriptTag({ content: src });
    const result = await page.evaluate(() => {
      const S = LP.require('sample');
      const smp = S.createSample();
      const ctx = document.getElementById('c').getContext('2d');
      S.drawPrimitives(ctx, smp.primitives);
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const doc = new DOMParser().parseFromString(S.toSVG(smp.primitives, smp.width, smp.height), 'image/svg+xml');
      const door = smp.project.features.find((f) => f.id === 'ft_door').points;
      const doorMid = [(door[0][0] + door[3][0]) / 2, (door[1][1] + door[0][1]) / 2];
      return {
        skyTop: px(800, 4), street: px(800, 1090), door: px(Math.round(doorMid[0]), Math.round(doorMid[1] + 4)),
        svgError: doc.getElementsByTagName('parsererror').length, svgShapes: doc.documentElement.childElementCount,
      };
    });
    const [r, gg, b] = result.skyTop;
    assert.ok(b > r && b > 180, 'sky is blue at the top: ' + result.skyTop);
    assert.ok(Math.abs(result.street[0] - result.street[2]) < 20 && result.street[0] < 140, 'street is dark gray: ' + result.street);
    assert.ok(result.door[0] > result.door[1] + 40, 'front door is red-brown: ' + result.door);
    assert.ok(gg >= 0);
    assert.equal(result.svgError, 0, 'SVG parses without errors');
    assert.ok(result.svgShapes > 500);
    // Keep a PNG for eyeballing (tests/e2e/out is git-ignored).
    const out = path.join(root, 'tests', 'e2e', 'out');
    fs.mkdirSync(out, { recursive: true });
    await page.locator('#c').screenshot({ path: path.join(out, 'sample.png') });
  } finally {
    await browser.close();
  }
});
