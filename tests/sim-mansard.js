// Synthetic mansard houses for tests/measure-mansard.test.js. Not a test file itself (no .test.js suffix).
//
// World frame as in sim-houses.js: x right along the front wall, y up, z toward the camera; the wall is z = 0.
// The house: a front wall W wide and Hw high, with a door and (when wide enough) a garage door. At the eave
// (y = Hw) a steep roof face leans back at `deg` degrees from level, going `up` feet up and back = up / tan(deg)
// feet back. The steep face wraps the sides, so its two corner edges lean back and inward by the same amount. A
// trim line runs along its top. Above it an upper roof at `upperRise`/12 runs `run2` feet further back to the
// top edge, hipped at both ends.
const sim = require('./sim-houses');
const LP = require('./loader');
const g = LP.require('geometry');
const measure = LP.require('measure');
const catalog = LP.require('catalog');

const { IMG_W, IMG_H, F26 } = sim;
const DOOR_H = 80 / 12, DOOR_W = 3;
const rad = (d) => (d * Math.PI) / 180;

/**
 * One mansard house and camera. opts: {W, Hw, deg, up, upperRise, run2, yawDeg, tiltDeg, dist, height}.
 * Returns {S (3D point lists), px (the same in image pixels), truth (true lengths, ft), cam, D (camera distance
 * from the wall plane), back, ...opts}, or null when a needed point falls outside the frame.
 */
function mansardHouse(opts) {
  const o = Object.assign({ W: 44, Hw: 10, deg: 70, up: 8, upperRise: 4, run2: 8, yawDeg: 12, tiltDeg: 8, dist: 60, height: 5.5 }, opts || {});
  const { W, Hw, deg, up } = o;
  const back = up / Math.tan(rad(deg));
  const slope = up / Math.sin(rad(deg));
  const yT = Hw + up, zT = -back; // the trim line
  const rise2 = (o.run2 * o.upperRise) / 12, yR = yT + rise2, zR = zT - o.run2;
  const inset = Math.min(o.run2, (W - 2 * back) / 2 - 2); // hips of the upper roof
  const doorU = 0.3 * W;
  // A point on the steep face: a feet along the eave, b feet up the slope.
  const onFace = (a, b) => [a, Hw + b * Math.sin(rad(deg)), -b * Math.cos(rad(deg))];
  const dormerU = 0.55 * W, d0 = 0.2 * slope, d1 = 0.75 * slope;
  const S = {
    facade: [[0, Hw, 0], [W, Hw, 0], [W, 0, 0], [0, 0, 0]],
    door: [[doorU, DOOR_H, 0], [doorU + DOOR_W, DOOR_H, 0], [doorU + DOOR_W, 0, 0], [doorU, 0, 0]],
    eave: [[0, Hw, 0], [W, Hw, 0]],
    trim: [[back, yT, zT], [W - back, yT, zT]],
    cornerLeft: [[0, Hw, 0], [back, yT, zT]],
    cornerRight: [[W, Hw, 0], [W - back, yT, zT]],
    dormer: [onFace(dormerU, d1), onFace(dormerU + 4, d1), onFace(dormerU + 4, d0), onFace(dormerU, d0)],
    topEdge: [[back + inset, yR, zR], [W - back - inset, yR, zR]],
    upperHip: [[back, yT, zT], [back + inset, yR, zR]],
  };
  if (W >= 40) {
    const gu = W - 18;
    S.garage = [[gu, 7, 0], [gu + 16, 7, 0], [gu + 16, 0, 0], [gu, 0, 0]];
  }
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const truth = {
    eave: W, trim: W - 2 * back, cornerLeft: len(S.cornerLeft[0], S.cornerLeft[1]), cornerRight: len(S.cornerRight[0], S.cornerRight[1]),
    dormer: 2 * (4 + (d1 - d0)), topEdge: len(S.topEdge[0], S.topEdge[1]), upperHip: len(S.upperHip[0], S.upperHip[1]),
  };
  const cam = sim.makeCamera({ yawDeg: o.yawDeg, tiltDeg: o.tiltDeg, dist: o.dist, height: o.height, target: [W / 2, (Hw + up) / 2, 0], f: F26 });
  const px = {};
  for (const k of Object.keys(S)) {
    const list = S[k].map((X) => sim.project3(cam, X));
    if (list.some((p) => !p || p[0] < 0 || p[0] > IMG_W || p[1] < 0 || p[1] > IMG_H)) return null;
    px[k] = list;
  }
  return Object.assign({}, o, { S, px, truth, cam, D: cam.C[2], back, slope, rise2 });
}

/**
 * The project for a mansard house. o: {
 *   rect: 'facade' | 'garage' | 'door' (the wall's known-size rectangle; default 'facade'),
 *   steep: how the slope of the steep face is stored:
 *     'tape' (default)  derived.pitch = {rise: up, run: back}, the two tape numbers
 *     'guess'           derived.angleDeg = guessDeg (default: the true angle)
 *     'default'         nothing (70° is assumed)
 *   guessDeg, upper: false leaves the upper roof out, upperPitch: 'own' (default) | 'none',
 *   on: 'roof' (default: items on the steep face and upper roof) | 'wall' (the same items drawn on the wall),
 *   noisy(points, role): tapped points (default: exact) }.
 */
function mansardProject(house, o) {
  const opt = Object.assign({ rect: 'facade', steep: 'tape', guessDeg: null, upper: true, upperPitch: 'own', on: 'roof', noisy: null }, o || {});
  const P = (k, role) => (opt.noisy ? opt.noisy(house.px[k], role || 'calib') : house.px[k].map((p) => p.slice()));
  const rect = opt.rect === 'garage' ? { corners: P('garage'), widthFt: 16, heightFt: 7, presetId: 'garage-double' }
    : opt.rect === 'door' ? { corners: P('door'), widthFt: DOOR_W, heightFt: DOOR_H, presetId: 'door-rect' }
      : { corners: P('facade'), widthFt: house.W, heightFt: house.Hw, presetId: 'custom-rect' };
  const steepDerived = { parentPlaneId: 'pl_w', line: P('eave'), pitch: null, steep: true };
  if (opt.steep === 'tape') steepDerived.pitch = { rise: house.up, run: house.back };
  else if (opt.steep === 'guess') steepDerived.angleDeg = opt.guessDeg == null ? house.deg : opt.guessDeg;
  const planes = [
    { id: 'pl_w', imageId: 'img', name: 'Front wall', kind: 'wall', rect, refs: [], derived: null },
    { id: 'pl_s', imageId: 'img', name: 'Steep face', kind: 'roof', rect: null, refs: [], derived: steepDerived },
  ];
  if (opt.upper) {
    planes.push({
      id: 'pl_u', imageId: 'img', name: 'Upper roof', kind: 'roof', rect: null, refs: [],
      derived: { parentPlaneId: 'pl_s', line: P('trim'), pitch: opt.upperPitch === 'own' ? { rise: house.upperRise, run: 12 } : null },
    });
  }
  const feature = (id, type, planeId) => ({
    id, imageId: 'img', planeId: opt.on === 'wall' ? 'pl_w' : planeId, type, label: id, points: P(id, 'feature'),
    closed: !!catalog.FEATURE_TYPES[type].closedDefault, overrideFt: null, productId: null, color: null, params: {},
  });
  const features = [
    feature('trim', 'roofline', 'pl_s'), feature('cornerLeft', 'rake', 'pl_s'), feature('cornerRight', 'rake', 'pl_s'),
    feature('dormer', 'window', 'pl_s'),
  ];
  if (opt.upper) features.push(feature('topEdge', 'ridge', 'pl_u'), feature('upperHip', 'rake', 'pl_u'));
  return {
    schema: 'lightplan/project', version: 1, id: 'p', name: 'mansard sim',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    images: [{ id: 'img', name: 'h.jpg', width: IMG_W, height: IMG_H, exif: { focal35: 26 }, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img' }],
    activeImageId: 'img', planes, features, outlets: [], circuits: [], library: { products: null, config: null },
  };
}

/** A random mansard house seen from the street; null when it does not fit the frame. */
function randomMansard(rnd) {
  const U = (a, b) => a + (b - a) * rnd();
  const W = U(30, 56), deg = [60, 70, 80][Math.floor(rnd() * 3)];
  const yawDeg = U(0, 30) * (rnd() < 0.5 ? -1 : 1);
  const cosY = Math.cos(rad(yawDeg));
  const dMin = Math.max(35, (W * cosY * F26) / (0.85 * IMG_W)), dMax = Math.max(dMin + 1, (W * cosY * F26) / (0.4 * IMG_W));
  return mansardHouse({
    W, Hw: U(8, 11), deg, up: U(6, 10), upperRise: 3 + Math.floor(rnd() * 4), run2: U(6, 10),
    yawDeg, tiltDeg: U(6, 14), dist: U(dMin, dMax), height: U(4.5, 6),
  });
}

/**
 * Monte Carlo over random mansard houses with Gaussian tap noise. opts: {houses, seed, sigmas, variants}; each
 * variant is the options of mansardProject plus a `name`. Returns rows {variant, feature, plane ('steep' |
 * 'upper'), deg, sigma, level, score, err (relative, signed), reasons}.
 */
function simulateMansard(opts) {
  const o = Object.assign({ houses: 100, seed: 1, sigmas: [1.5, 2, 3], variants: [{ name: 'facade-tape', rect: 'facade', steep: 'tape' }] }, opts || {});
  const rnd = g.rng(o.seed);
  const rows = [];
  let made = 0, tries = 0;
  while (made < o.houses && tries < o.houses * 30) {
    tries++;
    const house = randomMansard(rnd);
    if (!house) continue;
    made++;
    const sigma = o.sigmas[Math.floor(rnd() * o.sigmas.length)];
    const noisy = (list) => list.map((p) => [p[0] + sigma * sim.gaussian(rnd), p[1] + sigma * sim.gaussian(rnd)]);
    for (const v of o.variants) {
      if (v.rect === 'garage' && !house.px.garage) continue;
      const proj = mansardProject(house, Object.assign({}, v, { noisy }));
      const r = measure.measureProject(proj);
      for (const f of proj.features) {
        const m = r.features[f.id];
        if (!m || !m.ok) continue;
        const truth = house.truth[f.id];
        rows.push({
          variant: v.name, feature: f.id, plane: f.planeId === 'pl_u' ? 'upper' : 'steep', deg: house.deg, sigma,
          level: m.confidence.level, score: m.confidence.score, err: (m.measuredFt - truth) / truth, reasons: m.confidence.reasons,
        });
      }
    }
  }
  return rows;
}

module.exports = { mansardHouse, mansardProject, randomMansard, simulateMansard, DOOR_H, DOOR_W };
