// Seeded Monte Carlo of random houses photographed by a pinhole camera, traced with Gaussian tap noise and
// measured with measure.measureProject. Used by tests/measure-honesty.test.js to pin how honest the
// High / Medium / Low confidence levels are. Not a test file itself (no .test.js suffix).
//
// Every tap (rectangle corners, reference ends, derived eave/base lines, feature points) gets independent
// N(0, sigma²) noise in x and y, in stored-image pixels. sigma per house is drawn from opts.sigmas.
//
// Finger taps at fit zoom (SPEC §8.4): opts.featureSigmas draws a separate sigma for the traced items (the
// calibration keeps opts.sigmas), and opts.tapErr stores a matching `tapErr` array beside every tapped point list,
// the way the app records how coarse each tap was (never below 2.5 px). Without opts.tapErr the project carries no
// tap precision, which is what measure assumed for every project before §8.4 (every tap good to 2.5 px).
// garageDoorScene / simulateGarageDoor are the UX-01 scene: one small rectangle, tapped with a finger.
const LP = require('./loader');
const g = LP.require('geometry');
const measure = LP.require('measure');
const catalog = LP.require('catalog');

const IMG_W = 2048, IMG_H = 1536;
const F26 = (26 * Math.hypot(IMG_W, IMG_H)) / 43.2666;
const DOOR_H = 80 / 12, DOOR_W = 3;

function makeCamera({ yawDeg, tiltDeg, dist, height, target, f }) {
  const y = (yawDeg * Math.PI) / 180, t = (tiltDeg * Math.PI) / 180;
  const fwd = [Math.sin(y) * Math.cos(t), Math.sin(t), -Math.cos(y) * Math.cos(t)];
  const C = [target[0] - dist * Math.sin(y), height, target[2] + dist * Math.cos(y)];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return a.map((v) => v / l); };
  const right = norm(cross(fwd, [0, 1, 0]));
  return { C, rows: [right, cross(fwd, right), fwd], f };
}
function project3(cam, X) {
  const p = [X[0] - cam.C[0], X[1] - cam.C[1], X[2] - cam.C[2]];
  const [xc, yc, zc] = cam.rows.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]);
  if (!(zc > 1)) return null;
  return [(cam.f * xc) / zc + IMG_W / 2, (cam.f * yc) / zc + IMG_H / 2];
}

/** One random house + camera. Returns null when the needed points do not fit in the frame. */
function randomHouse(rnd) {
  const U = (a, b) => a + (b - a) * rnd();
  const W = U(28, 60), Hw = U(9, 18);
  const doorU = U(0.3, 0.6) * W;
  const winU = doorU > W / 2 ? U(2, doorU - 8) : U(doorU + 5, W - 6);
  const rise = 4 + Math.floor(rnd() * 7); // 4..10 / 12
  const yawDeg = U(0, 35) * (rnd() < 0.5 ? -1 : 1), tiltDeg = U(2, 10), height = U(4.5, 6);
  const f = F26;
  const cosY = Math.cos((yawDeg * Math.PI) / 180);
  // Facade fills 30–90% of the frame width.
  const dMin = Math.max(30, (W * cosY * f) / (0.9 * IMG_W)), dMax = Math.max(dMin + 1, (W * cosY * f) / (0.3 * IMG_W));
  const dist = U(dMin, dMax);
  const cam = makeCamera({ yawDeg, tiltDeg, dist, height, target: [W / 2, Hw / 2, 0], f });
  const run = 14, roofRise = (run * rise) / 12;
  const S = {
    facade: [[0, Hw, 0], [W, Hw, 0], [W, 0, 0], [0, 0, 0]],
    door: [[doorU, DOOR_H, 0], [doorU + DOOR_W, DOOR_H, 0], [doorU + DOOR_W, 0, 0], [doorU, 0, 0]],
    doorHeight: [[doorU, 0, 0], [doorU, DOOR_H, 0]],
    doorWidth: [[doorU, DOOR_H, 0], [doorU + DOOR_W, DOOR_H, 0]],
    eave: [[0, Hw, 0], [W, Hw, 0]],
    base: [[0, 0, 0], [W, 0, 0]],
    window: [[winU, 8, 0], [winU + 4, 8, 0], [winU + 4, 3, 0], [winU, 3, 0]],
    wallEdge: [[W, 0, 0], [W, Hw, 0]],
    walkway: [[doorU + 1.5, 0, 1], [doorU + 1.5, 0, 16]],
    sideRake: [[0, Hw, 0], [0, Hw + roofRise, -run]],
  };
  if (W >= 40) {
    const gu = W - 18;
    S.garage = [[gu, 7, 0], [gu + 16, 7, 0], [gu + 16, 0, 0], [gu, 0, 0]];
  }
  const truth = { eave: W, window: 18, wallEdge: Hw, walkway: 15, sideRake: Math.hypot(run, roofRise) };
  const px = {};
  for (const k of Object.keys(S)) {
    const list = S[k].map((X) => project3(cam, X));
    if (list.some((p) => !p || p[0] < 0 || p[0] > IMG_W || p[1] < 0 || p[1] > IMG_H)) {
      if (k === 'garage') continue;
      return null;
    }
    px[k] = list;
  }
  return { W, Hw, rise, yawDeg, dist, cam, px, truth };
}

function gaussian(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** What the app stores for a tap that is good to `sigma` px: never below 2.5 (a careful tap) or above 80 (SPEC §8.4). */
const storedTapErr = (sigma) => Math.min(80, Math.max(2.5, sigma));

const SETUPS = ['facade-known', 'garage-known', 'door-rect', 'facade-door', 'facade-door-width', 'refs-only', 'facade-door-auto'];

/**
 * The project for one house and setup. noisy(points, role) returns the tapped points (role 'calib' | 'feature').
 * taps (optional) {calib, feature}: tap precision in px stored as `tapErr` beside each point list (null = none).
 */
function buildProject(house, setup, noisy, taps) {
  const P = (k) => noisy(house.px[k], 'calib');
  const PF = (k) => noisy(house.px[k], 'feature');
  const tc = taps && taps.calib > 0 ? taps.calib : null, tf = taps && taps.feature > 0 ? taps.feature : null;
  // Adds tapErr (one value per point) beside the point list stored under `key`, when a precision is recorded.
  const withTap = (obj, key, sigma) => { if (sigma) obj.tapErr = obj[key].map(() => sigma); return obj; };
  const image = { id: 'img', name: 'h.jpg', width: IMG_W, height: IMG_H, exif: setup === 'facade-door-auto' ? null : { focal35: 26 }, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img' };
  const line = (id, k, lengthFt, presetId) => withTap({ id, kind: 'line', points: P(k), lengthFt, presetId: presetId || 'custom-line', courses: null, quality: 'high' }, 'points', tc);
  let rect = null; const refs = [];
  if (setup === 'garage-known') rect = { corners: P('garage'), widthFt: 16, heightFt: 7, presetId: 'garage-double' };
  else if (setup === 'door-rect') rect = { corners: P('door'), widthFt: DOOR_W, heightFt: DOOR_H, presetId: 'door-rect' };
  else if (setup === 'facade-known') rect = { corners: P('facade'), widthFt: house.W, heightFt: house.Hw, presetId: 'custom-rect' }; // tape-measured house corners
  else if (setup !== 'refs-only') rect = { corners: P('facade'), widthFt: null, heightFt: null, presetId: 'unknown' };
  if (rect) withTap(rect, 'corners', tc);
  if (setup !== 'garage-known' && setup !== 'door-rect' && setup !== 'facade-known') refs.push(line('r_dh', 'doorHeight', DOOR_H, 'door-height'));
  if (setup === 'facade-door-width') refs.push(line('r_dw', 'doorWidth', DOOR_W, 'door-width'));
  const planes = [{ id: 'pl_w', imageId: 'img', name: 'Front wall', kind: 'wall', rect, refs, derived: null }];
  const feature = (id, type, k, planeId) => withTap({
    id, imageId: 'img', planeId: planeId || 'pl_w', type, label: id, points: PF(k), closed: !!catalog.FEATURE_TYPES[type].closedDefault,
    overrideFt: null, productId: null, color: null, params: {},
  }, 'points', tf);
  // The eave runs along the top of the facade rectangle; a tape-measured facade would give it exactly, so it is
  // only traced where the rectangle's size is not known.
  const features = [feature('window', 'window', 'window'), feature('wallEdge', 'railing', 'wallEdge')];
  if (setup !== 'facade-known') features.unshift(feature('eave', 'roofline', 'eave'));
  if (setup === 'facade-door' || setup === 'facade-door-auto' || setup === 'garage-known' || setup === 'facade-known') {
    planes.push({ id: 'pl_g', imageId: 'img', name: 'Yard', kind: 'ground', rect: null, refs: [], derived: withTap({ parentPlaneId: 'pl_w', line: P('base'), pitch: null }, 'line', tc) });
    planes.push({ id: 'pl_r', imageId: 'img', name: 'Roof', kind: 'roof', rect: null, refs: [], derived: withTap({ parentPlaneId: 'pl_w', line: P('eave'), pitch: { rise: house.rise, run: 12 } }, 'line', tc) });
    features.push(feature('walkway', 'walkway', 'walkway', 'pl_g'), feature('sideRake', 'rake', 'sideRake', 'pl_r'));
  }
  return {
    schema: 'lightplan/project', version: 1, id: 'p', name: 'sim',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    images: [image], activeImageId: 'img', planes, features, outlets: [], circuits: [], library: { products: null, config: null },
  };
}

/**
 * Run the simulation. opts: {houses, seed, sigmas, setups, featureSigmas, tapErr}. Returns rows
 * {setup, feature, planeKind, sigma, featureSigma, level, score, err (relative, signed), reasons}.
 * featureSigmas (optional): tap noise of the traced items, drawn per house (default: the house's sigma).
 * tapErr (default false): record each tap's precision in the project (`tapErr` arrays equal to the noise used).
 */
function simulate(opts) {
  const o = Object.assign({ houses: 200, seed: 1, sigmas: [1.5, 2, 3], setups: SETUPS, featureSigmas: null, tapErr: false }, opts || {});
  const rnd = g.rng(o.seed);
  const rows = [];
  let made = 0, tries = 0;
  while (made < o.houses && tries < o.houses * 20) {
    tries++;
    const house = randomHouse(rnd);
    if (!house) continue;
    made++;
    const sigma = o.sigmas[Math.floor(rnd() * o.sigmas.length)];
    const featureSigma = o.featureSigmas ? o.featureSigmas[Math.floor(rnd() * o.featureSigmas.length)] : sigma;
    const noisy = (list, role) => {
      const sg = role === 'feature' ? featureSigma : sigma;
      return list.map((p) => [p[0] + sg * gaussian(rnd), p[1] + sg * gaussian(rnd)]);
    };
    const taps = o.tapErr ? { calib: storedTapErr(sigma), feature: storedTapErr(featureSigma) } : null;
    for (const setup of o.setups) {
      if (setup === 'garage-known' && !house.px.garage) continue;
      const proj = buildProject(house, setup, noisy, taps);
      const r = measure.measureProject(proj);
      for (const f of proj.features) {
        const m = r.features[f.id];
        if (!m || !m.ok) continue;
        const truth = house.truth[f.id];
        rows.push({
          setup, feature: f.id, planeKind: r.planes[f.planeId].kind, sigma, featureSigma,
          level: m.confidence.level, score: m.confidence.score, err: (m.measuredFt - truth) / truth, reasons: m.confidence.reasons,
        });
      }
    }
  }
  return rows;
}

/** Share of rows whose |err| is within tol, plus count. */
function honesty(rows, level, tol) {
  const sel = rows.filter((r) => r.level === level);
  const ok = sel.filter((r) => Math.abs(r.err) <= tol).length;
  return { n: sel.length, within: sel.length ? ok / sel.length : null };
}

/**
 * The UX-01 scene (SPEC §8.4): a 52 ft ranch photographed straight on, whose only calibration is its 16 x 7 ft
 * garage door, about 400 x 175 px in the stored photo. On a 390 px phone at fit zoom that door is about
 * 75 x 33 screen px and a 3 px slip of the finger is about 16 photo px.
 * Returns {door (corners in px, [TL, TR, BR, BL]), doorPx {w, h}, eave (2 points, px), eaveFt, project(corners,
 * eave, tapErr)}; project() builds the project for the given tapped points, with `tapErr` px stored beside the
 * corners and the eave's points when tapErr is a number (none when it is null).
 */
function garageDoorScene() {
  const eaveFt = 52;
  const cam = makeCamera({ yawDeg: 0, tiltDeg: 3, dist: 62, height: 5, target: [eaveFt / 2, 5, 0], f: F26 });
  const P = (list) => list.map((X) => project3(cam, X));
  const door = P([[32, 7, 0], [48, 7, 0], [48, 0, 0], [32, 0, 0]]);
  const eave = P([[0, 9, 0], [eaveFt, 9, 0]]);
  const project = (corners, eavePts, tapErr) => {
    const rect = { corners, widthFt: 16, heightFt: 7, presetId: 'garage-double' };
    const feature = { id: 'eave', imageId: 'img', planeId: 'pl_w', type: 'roofline', label: 'Eave', points: eavePts, closed: false, overrideFt: null, productId: null, color: null, params: {} };
    if (tapErr != null) { rect.tapErr = corners.map(() => tapErr); feature.tapErr = eavePts.map(() => tapErr); }
    return {
      schema: 'lightplan/project', version: 1, id: 'p', name: 'UX-01',
      settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
      images: [{ id: 'img', name: 'h.jpg', width: IMG_W, height: IMG_H, exif: { focal35: 26 }, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img' }],
      activeImageId: 'img', planes: [{ id: 'pl_w', imageId: 'img', name: 'Front wall', kind: 'wall', rect, refs: [], derived: null }],
      features: [feature], outlets: [], circuits: [], library: { products: null, config: null },
    };
  };
  return { door, doorPx: { w: g.dist(door[0], door[1]), h: g.dist(door[0], door[3]) }, eave, eaveFt, project };
}

/**
 * Tap the garage-door scene `trials` times: the 4 corners and the 2 ends of the eave each get N(0, sigma²) noise.
 * opts: {trials, seed, sigma, tapErr}. tapErr true (default) stores the precision the app would store for such
 * taps; false stores none (what every project looked like before §8.4).
 * Returns rows {err (eave, relative, signed), level, reasons, planeLevel, planeReasons, viewAngleDeg}.
 */
function simulateGarageDoor(opts) {
  const o = Object.assign({ trials: 200, seed: 1, sigma: 16, tapErr: true }, opts || {});
  const scene = garageDoorScene();
  const rnd = g.rng(o.seed);
  const noisy = (list) => list.map((p) => [p[0] + o.sigma * gaussian(rnd), p[1] + o.sigma * gaussian(rnd)]);
  const rows = [];
  for (let i = 0; i < o.trials; i++) {
    const r = measure.measureProject(scene.project(noisy(scene.door), noisy(scene.eave), o.tapErr ? storedTapErr(o.sigma) : null));
    const m = r.features.eave, pl = r.planes.pl_w;
    if (!m || !m.ok) continue;
    rows.push({
      err: (m.measuredFt - scene.eaveFt) / scene.eaveFt, level: m.confidence.level, reasons: m.confidence.reasons,
      planeLevel: pl.confidence ? pl.confidence.level : null, planeReasons: pl.confidence ? pl.confidence.reasons : [], viewAngleDeg: pl.viewAngleDeg,
    });
  }
  return rows;
}

module.exports = { simulate, honesty, SETUPS, randomHouse, buildProject, garageDoorScene, simulateGarageDoor, storedTapErr, IMG_W, IMG_H, F26, makeCamera, project3, gaussian };
