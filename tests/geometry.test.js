const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('./loader');
const g = LP.require('geometry');
const catalog = LP.require('catalog');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

test('homography maps 4 points exactly and inverts', () => {
  const src = [[100, 120], [900, 80], [950, 700], [80, 760]];
  const dst = [[0, 7], [16, 7], [16, 0], [0, 0]];
  const H = g.homographyFromPoints(src, dst);
  src.forEach((p, i) => { const q = g.applyH(H, p); close(q[0], dst[i][0], 1e-9); close(q[1], dst[i][1], 1e-9); });
  const Hi = g.invertH(H);
  dst.forEach((p, i) => { const q = g.applyH(Hi, p); close(q[0], src[i][0], 1e-6); close(q[1], src[i][1], 1e-6); });
});

test('least-squares homography with extra points', () => {
  const H0 = [1.2, 0.1, 30, -0.05, 0.9, 12, 0.0004, -0.0002, 1];
  const src = [[0, 0], [100, 0], [100, 80], [0, 80], [50, 40], [20, 70]];
  const dst = src.map((p) => g.applyH(H0, p));
  const H = g.homographyFromPoints(src, dst);
  H.forEach((v, i) => close(v, H0[i], 1e-7, 'h' + i));
});

test('degenerate input returns null', () => {
  assert.equal(g.homographyFromPoints([[0, 0], [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 0], [1, 1], [0, 1]]), null);
  assert.equal(g.homographyFromPoints([[0, 0]], [[0, 0]]), null);
});

test('orderQuad handles any tap order', () => {
  const quad = [[10, 10], [200, 20], [210, 150], [5, 160]];
  const shuffled = [quad[2], quad[0], quad[3], quad[1]];
  assert.deepEqual(g.orderQuad(shuffled), quad);
  assert.ok(g.isConvexQuad(quad));
});

test('localScale of a pure scale map', () => {
  const s = g.localScale(g.scaleMatrix(0.05), [300, 200]);
  close(s.scale, 0.05, 1e-12); close(s.sMin, 0.05, 1e-12); close(s.sMax, 0.05, 1e-12);
});

test('polylines, polygons, intersections', () => {
  close(g.polylineLength([[0, 0], [3, 4], [3, 10]]), 11, 1e-12);
  close(g.polylineLength([[0, 0], [4, 0], [4, 3]], true), 12, 1e-12);
  close(g.polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]]), 12, 1e-12);
  assert.ok(g.segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0]));
  assert.ok(!g.segmentsIntersect([0, 0], [1, 1], [2, 2], [3, 5]));
  assert.ok(g.pointInPolygon([1, 1], [[0, 0], [4, 0], [4, 3], [0, 3]]));
  const r = g.resampleByDistance([[0, 0], [10, 0]], 2.5);
  assert.equal(r.length, 5);
  close(g.median([5, 1, 3]), 3, 0);
});

test('catalog library merges overrides without mutating defaults', () => {
  const lib = catalog.getLibrary({ library: { products: null, config: { clipSpacingIn: 8, power: { voltage: 110 } } } });
  assert.equal(lib.config.clipSpacingIn, 8);
  assert.equal(lib.config.power.voltage, 110);
  assert.equal(lib.config.power.continuousFactor, 0.8);
  assert.equal(catalog.DEFAULT_CONFIG.clipSpacingIn, 12);
  assert.ok(catalog.getProduct(lib.products, 'c9-led'));
  assert.ok(catalog.getAccessory(lib.accessories, 'cord-16-25'));
  for (const t of catalog.TYPE_ORDER) assert.ok(catalog.getProduct(lib.products, catalog.DEFAULT_CONFIG.typeDefaults[t]), t);
  assert.deepEqual(catalog.resolveColors(null, { colorMode: 'multicolor' }).colors.length, 5);
});
