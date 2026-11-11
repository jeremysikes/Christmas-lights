// Seeded random houses for the power-routing tests (tests/power-routing.test.js). Not a test file itself.
//
// Each house is a 3D model photographed by a pinhole camera: a front wall with a tape-measured rectangle,
// windows (one or two floors), a door, an eave, sometimes a roof plane (rake, ridge), sometimes a ground
// plane (walkway, stakes, a tree, a bush), sometimes a second wall set back to the right (a garage with a
// gutter and its own outlet), bushes and columns traced on the wall, and 1-3 outlets. Every image point is an
// exact projection, so measure.measureProject recovers the walls in feet and the tests can check the planned
// cord routes in wall-plane feet against the openings that were generated.
const LP = require('./loader');
const g = LP.require('geometry');
const catalog = LP.require('catalog');

const IMG_W = 2048, IMG_H = 1536;
const F26 = (26 * Math.hypot(IMG_W, IMG_H)) / 43.2666;
const DOOR_W = 3, DOOR_H = 80 / 12;
const GARAGE_SETBACK = 4;

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

const PARAMS = { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false,
  overrideWidthFt: null, overrideHeightFt: null };

/**
 * One random house, or null when it does not fit the frame. Returns
 * { project, model: { W, Hw, hasGround, hasRoof, hasGarage, openings: [{id, wallId, type, u0, u1, v0, v1}] } }.
 * opts.incandescent: share of houses whose eave uses incandescent C9 (default 0.15).
 */
function randomPowerHouse(rnd, opts) {
  const o = Object.assign({ incandescent: 0.15 }, opts || {});
  const U = (a, b) => a + (b - a) * rnd();
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const W = Math.round(U(26, 48)), twoFloors = rnd() < 0.4;
  const Hw = twoFloors ? Math.round(U(17, 20)) : Math.round(U(9, 11));
  const hasGround = rnd() < 0.6, hasRoof = rnd() < 0.6, hasGarage = rnd() < 0.35;
  const G = hasGarage ? Math.round(U(12, 20)) : 0;
  const rise = 4 + Math.floor(rnd() * 5), run = 12, roofRise = (run * rise) / 12;
  const yawDeg = U(5, 28) * (rnd() < 0.5 ? -1 : 1), tiltDeg = U(3, 9), height = U(4.8, 5.8);
  const span = W + G;
  const dist = U(1.05, 1.5) * span * (F26 / (0.8 * IMG_W));
  const cam = makeCamera({ yawDeg, tiltDeg, dist, height, target: [span / 2, Hw / 2 + 1, 0], f: F26 });
  let fits = true;
  const P = (X) => {
    const p = project3(cam, X);
    if (!p || p[0] < 4 || p[0] > IMG_W - 4 || p[1] < 4 || p[1] > IMG_H - 4) { fits = false; return [0, 0]; }
    return p;
  };
  const wallPts = (list, z) => list.map(([u, v]) => P([u, v, z || 0]));

  // ---- openings on the front wall: a door and windows in slots that do not overlap
  const openings = [];
  const doorU = Math.round(U(0.3, 0.6) * W);
  openings.push({ id: 'ft_door', wallId: 'pl_w', type: 'door', u0: doorU, u1: doorU + DOOR_W, v0: 0, v1: DOOR_H });
  const slots = [];
  for (let u = 2; u + 5 <= W - 1; u += 7) {
    if (u + 5 < doorU - 1.5 || u > doorU + DOOR_W + 1.5) slots.push({ u, floor: 0 });
    if (twoFloors) slots.push({ u, floor: 1 });
  }
  const nWin = Math.min(slots.length, 1 + Math.floor(rnd() * 5));
  const taken = [];
  for (let i = 0; i < nWin; i++) {
    const k = Math.floor(rnd() * slots.length);
    const s = slots.splice(k, 1)[0];
    const w = pick([3, 4, 5]), h = pick([3.5, 4.5]);
    const v0 = s.floor ? 11.5 : 3;
    taken.push(s);
    openings.push({ id: 'ft_win_' + (i + 1), wallId: 'pl_w', type: 'window', u0: s.u, u1: s.u + w, v0, v1: v0 + h });
  }

  const features = [];
  const feature = (id, type, points, extra) => features.push(Object.assign({
    id, imageId: 'img', planeId: 'pl_w', type, label: id.replace(/^ft_/, '').replace(/_/g, ' '), points,
    closed: !!catalog.FEATURE_TYPES[type].closedDefault, overrideFt: null, productId: null, color: null,
    params: Object.assign({}, PARAMS),
  }, extra || {}));

  // ---- lights on the front wall
  const eaveProduct = rnd() < o.incandescent ? 'c9-incan' : null;
  if (rnd() < 0.3) {
    const cut = Math.round(U(0.35, 0.65) * W);
    feature('ft_eave_a', 'roofline', wallPts([[0, Hw], [cut, Hw]]), { productId: eaveProduct });
    feature('ft_eave_b', 'roofline', wallPts([[cut + 5, Hw], [W, Hw]]), { productId: eaveProduct });
  } else {
    feature('ft_eave', 'roofline', wallPts([[0, Hw], [W, Hw]]), { productId: eaveProduct });
  }
  for (const op of openings) {
    if (op.type === 'door') {
      feature(op.id, 'door', wallPts([[op.u0, 0], [op.u0, op.v1], [op.u1, op.v1], [op.u1, 0]]));
    } else {
      const corners = [[op.u0, op.v1], [op.u1, op.v1], [op.u1, op.v0], [op.u0, op.v0]];
      const start = Math.floor(rnd() * 4);
      feature(op.id, 'window', wallPts(corners.slice(start).concat(corners.slice(0, start))));
    }
  }
  // Bushes and a column traced on the wall, between the openings of the ground floor.
  const groundSpans = openings.filter((op) => op.v0 < 9).map((op) => [op.u0 - 1, op.u1 + 1]);
  const freeAt = (a, b) => a >= 0.5 && b <= W - 0.5 && groundSpans.every(([x0, x1]) => b < x0 || a > x1);
  let bushes = 0;
  for (let t = 0; t < 12 && bushes < 3; t++) {
    const a = U(1, W - 5), w = U(2.5, 4), b = a + w;
    if (!freeAt(a, b)) continue;
    groundSpans.push([a, b]);
    bushes += 1;
    const h = U(1.8, 2.6);
    // First point at the top, so "fed at the base" is a real choice.
    feature('ft_bush_' + bushes, 'bush', wallPts([[a + w / 2, h], [b, h * 0.6], [b - 0.2, 0.1], [a + w / 2, 0], [a + 0.2, 0.1], [a, h * 0.6]]));
  }
  for (let t = 0; t < 6; t++) {
    const u = U(1, W - 1);
    if (!freeAt(u - 0.5, u + 0.5)) continue;
    groundSpans.push([u - 0.5, u + 0.5]);
    // Traced top first on half of the houses: the base is still where it is fed.
    const pts = rnd() < 0.5 ? [[u, 0], [u, 8]] : [[u, 8], [u, 0]];
    feature('ft_column', 'column', wallPts(pts));
    break;
  }

  const planes = [{ id: 'pl_w', imageId: 'img', name: 'Front wall', kind: 'wall',
    rect: { corners: wallPts([[0, Hw], [W, Hw], [W, 0], [0, 0]]), widthFt: W, heightFt: Hw, presetId: 'custom-rect' }, refs: [], derived: null }];
  if (hasRoof) {
    planes.push({ id: 'pl_r', imageId: 'img', name: 'Roof', kind: 'roof', rect: null, refs: [],
      derived: { parentPlaneId: 'pl_w', line: wallPts([[0, Hw], [W, Hw]]), pitch: { rise, run: 12 } } });
    feature('ft_rake', 'rake', [P([0, Hw, 0]), P([0, Hw + roofRise * 0.6, -run * 0.6])], { planeId: 'pl_r' });
    if (rnd() < 0.5) feature('ft_ridge', 'ridge', [P([4, Hw + roofRise * 0.6, -run * 0.6]), P([W - 4, Hw + roofRise * 0.6, -run * 0.6])], { planeId: 'pl_r' });
  }
  if (hasGround) {
    planes.push({ id: 'pl_g', imageId: 'img', name: 'Yard', kind: 'ground', rect: null, refs: [],
      derived: { parentPlaneId: 'pl_w', line: wallPts([[0, 0], [W, 0]]), pitch: null } });
    const far = U(6, 10);
    feature('ft_walk', 'walkway', [P([doorU - 0.5, 0, 1]), P([doorU - 0.5, 0, far])], { planeId: 'pl_g' });
    if (rnd() < 0.5) feature('ft_walk_b', 'walkway', [P([doorU + DOOR_W + 0.5, 0, 1]), P([doorU + DOOR_W + 0.5, 0, far])], { planeId: 'pl_g' });
    if (rnd() < 0.5) {
      const a = U(1, W / 2 - 8);
      if (a > 0.5) feature('ft_stakes', 'stakes', [P([a, 0, 2]), P([a + 8, 0, 2])], { planeId: 'pl_g' });
    }
    if (rnd() < 0.6) {
      const x = U(2, W - 2), z = U(4, 8);
      feature('ft_tree', 'tree', [P([x, 0, z]), P([x, 7, z])], { planeId: 'pl_g', params: Object.assign({}, PARAMS, { diameterIn: 10 }) });
    }
  }
  if (hasGarage) {
    const z = -GARAGE_SETBACK;
    planes.push({ id: 'pl_garage', imageId: 'img', name: 'Garage wall', kind: 'wall',
      rect: { corners: [P([W, 9, z]), P([W + G, 9, z]), P([W + G, 0, z]), P([W, 0, z])], widthFt: G, heightFt: 9, presetId: 'custom-rect' }, refs: [], derived: null });
    feature('ft_gutter', 'gutter', [P([W, 9, z]), P([W + G, 9, z])], { planeId: 'pl_garage' });
  }

  // ---- outlets: 1.5 ft up the front wall, clear of the door; a garage outlet on some
  const outlets = [];
  const nOut = 1 + Math.floor(rnd() * 3);
  for (let t = 0; t < 30 && outlets.length < nOut; t++) {
    const u = Math.round(U(1, W - 1) * 2) / 2;
    if (u > doorU - 1.5 && u < doorU + DOOR_W + 1.5) continue;
    if (outlets.some((x) => Math.abs(x.u - u) < 4)) continue;
    outlets.push({ u, id: 'out_' + (outlets.length + 1), imageId: 'img', planeId: 'pl_w', point: P([u, 1.5, 0]), label: 'Outlet ' + (outlets.length + 1),
      type: 'exteriorGfci', gfci: true, circuitId: outlets.length % 2 ? 'cir_2' : 'cir_1', receptacles: 2 });
  }
  if (hasGarage && rnd() < 0.7) {
    outlets.push({ u: null, id: 'out_garage', imageId: 'img', planeId: 'pl_garage', point: P([W + 2, 1.5, -GARAGE_SETBACK]), label: 'Garage outlet',
      type: 'garage', gfci: true, circuitId: 'cir_2', receptacles: 2 });
  }
  if (!fits || !outlets.length) return null;
  for (const x of outlets) delete x.u;

  // A forced outlet or an own cord on one item of some houses.
  if (rnd() < 0.15) pick(features).params.outletId = pick(outlets).id;
  if (rnd() < 0.15) pick(features).params.ownCord = true;

  const project = {
    schema: 'lightplan/project', version: 1, id: 'p', name: 'power house',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    images: [{ id: 'img', name: 'h.jpg', width: IMG_W, height: IMG_H, exif: { focal35: 26 }, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: 'img' }],
    activeImageId: 'img', planes, features, outlets,
    circuits: [{ id: 'cir_1', name: 'Circuit 1', breakerAmps: 15, voltage: 120, existingLoadW: 0 }, { id: 'cir_2', name: 'Circuit 2', breakerAmps: 20, voltage: 120, existingLoadW: 0 }],
    library: { products: null, config: null },
  };
  return { project, model: { W, Hw, hasGround, hasRoof, hasGarage, openings } };
}

/** `count` houses from one seed (houses that do not fit the frame are skipped). */
function powerHouses(count, seed, opts) {
  const rnd = g.rng(seed);
  const out = [];
  let tries = 0;
  while (out.length < count && tries < count * 40) {
    tries += 1;
    const h = randomPowerHouse(rnd, opts);
    if (h) out.push(h);
  }
  return out;
}

module.exports = { randomPowerHouse, powerHouses, makeCamera, project3, IMG_W, IMG_H, F26, PARAMS };
