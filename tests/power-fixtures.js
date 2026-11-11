// Shared hand-made fixtures for the power tests (not a test file): a flat front wall at 10 px per ft with
// v pointing up, hand-made measureProject results, and a checker that walks a PowerPlan's supply trees and
// cord routes and returns every rule it breaks (SPEC §8.1, §8.2).
const LP = require('./loader');
const g = LP.require('geometry');
const catalog = LP.require('catalog');
const design = LP.require('design');
const power = LP.require('power');

const lib = catalog.getLibrary(null);
const H0 = 1000;
function wallSol(planeId, s, offsetX = 0) {
  const Himg2plane = g.multiplyH([1, 0, -offsetX * s, 0, 1, H0 * s, 0, 0, 1], g.scaleMatrix(s, -s));
  return {
    ok: true, planeId, kind: 'wall', mode: 'rect-known', Himg2plane, Hplane2img: g.invertH(Himg2plane),
    scale: { sx: s, sy: s, anisotropic: false }, refResults: [], disagreementPct: null, checks: 0,
    viewAngleDeg: 0, pose: null, K: null, pitch: null, extent: null, warnings: [], notes: [],
  };
}
const SOLS = { pl_front: wallSol('pl_front', 0.1), pl_side: wallSol('pl_side', 0.2, 3000) };
/** Front-wall plane feet → image px (10 px per ft). */
const F = (u, v) => [u * 10, H0 - v * 10];
/** Image px → front-wall feet. */
const toFt = (p) => [p[0] / 10, (H0 - p[1]) / 10];

const DEFAULT_PARAMS = { mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null, reverse: false,
  overrideWidthFt: null, overrideHeightFt: null };
function feature(id, type, points, opts = {}) {
  const { params, ...rest } = opts;
  return Object.assign({
    id, imageId: 'img_1', planeId: 'pl_front', type, label: id, points, closed: catalog.FEATURE_TYPES[type].closedDefault,
    overrideFt: null, productId: null, color: null,
  }, rest, { params: Object.assign({}, DEFAULT_PARAMS, params || {}) });
}
function outlet(id, point, opts = {}) {
  return Object.assign({ id, imageId: 'img_1', planeId: 'pl_front', point, label: id, type: 'exteriorGfci', gfci: true,
    circuitId: 'cir_1', receptacles: 2 }, opts);
}
function circuit(id, breakerAmps = 15, opts = {}) {
  return Object.assign({ id, name: id, breakerAmps, voltage: 120, existingLoadW: 0 }, opts);
}
function project({ features = [], outlets = [], circuits = [circuit('cir_1')], library } = {}) {
  return {
    schema: 'lightplan/project', version: 1, id: 'prj_t', name: 'Test',
    settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: [], lengthFormat: 'ft-in' },
    images: [{ id: 'img_1', width: 3000, height: 1000 }, { id: 'img_2', width: 3000, height: 1000 }],
    planes: [
      { id: 'pl_front', imageId: 'img_1', name: 'Front wall', kind: 'wall' },
      { id: 'pl_side', imageId: 'img_1', name: 'Side wall', kind: 'wall' },
      { id: 'pl_back', imageId: 'img_1', name: 'Back wall', kind: 'wall' },
    ],
    features, outlets, circuits, library: library || { products: null, config: null },
  };
}
/** Hand-made measureProject result: plane-space lengths (or overrideFt) per SPEC §5.5 shapes. */
function measure(p, sols = SOLS) {
  const features = {};
  for (const f of p.features) {
    const sol = sols[f.planeId];
    const linear = catalog.LINEAR_TYPES.includes(f.type);
    let L = null, method = 'plane';
    if (Number.isFinite(f.overrideFt)) { L = f.overrideFt; method = 'override'; }
    else if (sol && sol.ok) L = g.polylineLength(f.points.map((q) => g.applyH(sol.Himg2plane, q)), f.closed);
    features[f.id] = L === null
      ? { ok: false, featureId: f.id, type: f.type, method: 'uncalibrated', measuredFt: null, lengthFt: null, withWasteFt: null }
      : { ok: true, featureId: f.id, type: f.type, method, measuredFt: L, wrapFt: null, lengthFt: L, withWasteFt: linear ? L * 1.1 : L,
        areaSqFt: null, widthFt: null, heightFt: null, lights: null, pitchEstimate: null, overridden: method === 'override',
        confidence: { level: 'high', score: 90, reasons: [] } };
  }
  return { planes: sols, features, totals: {}, warnings: [] };
}
/** Library with config.power overrides (daisyChain: false, jumperMaxFt, ...). */
function libWith(powerCfg) {
  return catalog.getLibrary({ library: { products: null, config: { power: powerCfg } } });
}
function plan(p, l = lib, sols = SOLS) {
  const measured = measure(p, sols);
  const runs = design.planRuns(p, measured, l);
  return { runs, measured, power: power.planPower(p, measured, runs, l) };
}
const codes = (pw) => pw.warnings.map((w) => w.code);
const byCode = (pw, code) => pw.warnings.filter((w) => w.code === code);
const feedOf = (pw, runId) => pw.feeds.find((f) => f.runIds.includes(runId));
const kinds = (feed) => (feed.cord ? feed.cord.route.map((s) => s.kind) : null);

// ------------------------------------------------------------------ plan checker
/** Does segment a→b pass through the inside of the box (shrunk by `shrink` on every side)? */
function segInsideBox(a, b, box, shrink) {
  const x0 = box.u0 + shrink, x1 = box.u1 - shrink, y0 = box.v0 + shrink, y1 = box.v1 - shrink;
  if (!(x1 > x0) || !(y1 > y0)) return false;
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-12) return q > 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, a[0] - x0) || !clip(dx, x1 - a[0]) || !clip(-dy, a[1] - y0) || !clip(dy, y1 - a[1])) return false;
  return (t1 - t0) * Math.hypot(dx, dy) > 1e-6 || (Math.hypot(dx, dy) < 1e-9 && a[0] > x0 && a[0] < x1 && a[1] > y0 && a[1] < y1);
}

/** Traced windows and doors per wall, as boxes in wall-plane feet (straight from the traced points). */
function openingsByWall(project, measured) {
  const out = new Map();
  for (const f of project.features) {
    if (f.type !== 'window' && f.type !== 'door') continue;
    const sol = measured.planes[f.planeId];
    if (!sol || !sol.ok || sol.kind !== 'wall') continue;
    const pts = f.points.map((p) => g.applyH(sol.Himg2plane, p));
    const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
    if (!out.has(f.planeId)) out.set(f.planeId, []);
    out.get(f.planeId).push({ id: f.id, type: f.type, u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) });
  }
  return out;
}

/**
 * Every rule of SPEC §8.1 / §8.2 that the plan breaks, as plain strings ([] = fine).
 * opts.groundV: {wallId: v} when known (default: lowest of 0 and the wall's lowest opening).
 */
function checkPlan(project, measured, pw, library, opts = {}) {
  const errs = [];
  const bad = (msg) => errs.push(msg);
  const cfg = library.config.power;
  const V = cfg.voltage || 120;
  const plugLimit = (cfg.plugAmps || 15) * V * 0.8;
  const openings = openingsByWall(project, measured);
  const feedById = new Map(pw.feeds.map((f) => [f.id, f]));
  const outletById = new Map(project.outlets.map((o) => [o.id, o]));
  const runs = opts.runs || [];
  const productOfFeed = (f) => {
    const run = runs.find((r) => r.id === f.runIds[0]);
    return run ? catalog.getProduct(library.products, run.productId) : null;
  };
  const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;

  // ---- tree shape
  const children = new Map(pw.feeds.map((f) => [f.id, []]));
  for (const f of pw.feeds) {
    if (!f.outletId) { if (f.source || f.cord) bad(`${f.id}: unpowered feed has a source or a cord`); continue; }
    if (!f.source) { bad(`${f.id}: no source`); continue; }
    if (f.source.kind === 'outlet') {
      if (f.source.outletId !== f.outletId) bad(`${f.id}: home run from ${f.source.outletId} but outletId ${f.outletId}`);
      if (f.parentFeedId !== null || f.depth !== 0) bad(`${f.id}: a home run has no parent and depth 0`);
    } else {
      const parent = feedById.get(f.source.feedId);
      if (!parent) { bad(`${f.id}: source feed missing`); continue; }
      if (f.parentFeedId !== parent.id) bad(`${f.id}: parentFeedId does not match its source`);
      if (f.depth !== parent.depth + 1) bad(`${f.id}: depth ${f.depth} under a parent of depth ${parent.depth}`);
      if (f.outletId !== parent.outletId || f.circuitId !== parent.circuitId) bad(`${f.id}: not on its parent's outlet and circuit`);
      if (!['end', 'start'].includes(f.source.port)) bad(`${f.id}: bad port`);
      if (!parent.childFeedIds.includes(f.id)) bad(`${f.id}: missing from its parent's childFeedIds`);
      children.get(parent.id).push(f);
    }
  }
  // Subtree watts and the watts that pass through each feed's strings, worked out again from the tree.
  const subtree = (f) => f.watts + children.get(f.id).reduce((s, c) => s + subtree(c), 0);
  const through = (f) => children.get(f.id).filter((c) => c.source.port === 'end').reduce((s, c) => s + subtree(c), 0);
  for (const f of pw.feeds) {
    if (!f.outletId || !f.source) continue;
    const sub = subtree(f), thr = through(f);
    if (Math.abs(sub - f.supplyW) > 0.02) bad(`${f.id}: supplyW ${f.supplyW}, the tree says ${sub}`);
    if (Math.abs(thr - f.throughW) > 0.02) bad(`${f.id}: throughW ${f.throughW}, the tree says ${thr}`);
    const product = productOfFeed(f);
    if (product) {
      const maxW = product.maxConnectedW || product.maxEndToEnd * product.wattsPerUnit;
      if (f.watts + thr > maxW + 0.01) bad(`${f.id}: ${f.watts + thr} W through strings rated for ${maxW} W`);
      if (thr > 0 && product.unit === 'foot' && product.endConnector !== true) bad(`${f.id}: a per-foot product feeds a jumper from its end`);
    }
    if (f.source.kind === 'feed' && sub > plugLimit + 0.01) bad(`${f.id}: jumper carries ${sub} W`);
    if (f.source.kind === 'outlet' && sub > plugLimit + 0.01 && f.watts <= plugLimit) bad(`${f.id}: home run carries ${sub} W`);
    const kids = children.get(f.id);
    const ks = kids.filter((c) => c.source.port === 'start').length, ke = kids.filter((c) => c.source.port === 'end').length;
    const per = (cfg.tapOutlets || 3) - 1;
    const taps = Math.ceil(ks / per) + (ke <= 1 ? 0 : Math.ceil((ke - 1) / per));
    if (f.taps !== taps) bad(`${f.id}: ${f.taps} taps for ${ks} start and ${ke} end jumpers (want ${taps})`);
  }
  // ---- outlets, circuits, groups, counts
  const overloaded = new Set(pw.warnings.filter((w) => w.code === 'outlet-overload' || w.code === 'circuit-overload').map((w) => w.outletId || w.circuitId));
  for (const o of pw.outlets) {
    const mine = pw.feeds.filter((f) => f.outletId === o.id);
    if (JSON.stringify(mine.map((f) => f.id).sort()) !== JSON.stringify(o.feedIds.slice().sort())) bad(`${o.id}: feedIds do not list its trees`);
    const direct = mine.filter((f) => f.source && f.source.kind === 'outlet').map((f) => f.id);
    if (JSON.stringify(direct.sort()) !== JSON.stringify((o.directFeedIds || []).slice().sort())) bad(`${o.id}: directFeedIds are not its home runs`);
    const n = direct.length, k = (cfg.splitterOutlets || 3) - 1;
    if (o.splitters !== (n > 1 ? Math.ceil((n - 1) / k) : 0)) bad(`${o.id}: ${o.splitters} power stakes for ${n} home runs`);
    if (o.watts > o.limitW + 0.01 && !overloaded.has(o.id)) bad(`${o.id}: ${o.watts} W over its ${o.limitW} W limit without a warning`);
  }
  for (const c of pw.circuits) if (c.loadW > c.limitW + 0.01 && !overloaded.has(c.id)) bad(`${c.id}: overloaded without a warning`);
  const powered = pw.feeds.filter((f) => f.outletId);
  const inGroups = [].concat(...(pw.groups || []).map((gr) => gr.feedIds));
  if (JSON.stringify(inGroups.slice().sort()) !== JSON.stringify(powered.map((f) => f.id).sort())) bad('groups do not cover every powered feed exactly once');
  for (const gr of pw.groups || []) {
    const root = feedById.get(gr.rootFeedId);
    if (!root || root.source.kind !== 'outlet' || root.outletId !== gr.outletId || gr.feedIds[0] !== gr.rootFeedId) bad(`${gr.id}: bad root`);
    if (root && Math.abs(gr.watts - subtree(root)) > 0.05) bad(`${gr.id}: watts`);
  }
  const homes = powered.filter((f) => f.source && f.source.kind === 'outlet').length;
  if (pw.counts.homeRuns !== homes) bad(`counts.homeRuns ${pw.counts.homeRuns}, want ${homes}`);
  const jumperCords = powered.filter((f) => f.source && f.source.kind === 'feed' && f.cord).length;
  if (pw.counts.jumpers !== jumperCords) bad(`counts.jumpers ${pw.counts.jumpers}, want ${jumperCords}`);
  if (pw.counts.taps !== pw.feeds.reduce((s, f) => s + (f.taps || 0), 0)) bad('counts.taps is not the sum of the feeds');
  if (pw.counts.splitters !== pw.outlets.reduce((s, o) => s + o.splitters, 0)) bad('counts.splitters');

  // ---- cords and routes
  for (const f of powered) {
    if (!f.source) continue;
    const home = f.source.kind === 'outlet';
    const src = home ? outletById.get(f.source.outletId) : feedById.get(f.source.feedId);
    if (f.cordUnknown) { if (f.cord) bad(`${f.id}: unknown cord with a cord`); continue; }
    if (!Array.isArray(f.cordPath) || f.cordPath.length < 2 || !f.cordPath.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      bad(`${f.id}: cordPath is not a finite polyline of 2+ points`);
      continue;
    }
    if (!near(f.cordPath[f.cordPath.length - 1], f.start.point, 0.01)) bad(`${f.id}: cordPath does not end at the feed start`);
    if (home && src && !near(f.cordPath[0], src.point, 0.01)) bad(`${f.id}: cordPath does not start at the outlet`);
    if (!f.cord) {
      if (home || f.plugIn !== true) bad(`${f.id}: powered without a cord`);
      continue;
    }
    const c = f.cord;
    if (c.kind !== (home ? 'home' : 'jumper')) bad(`${f.id}: cord.kind ${c.kind}`);
    if (!Array.isArray(c.route) || !c.route.length || typeof c.routeText !== 'string' || !c.routeText) { bad(`${f.id}: no route`); continue; }
    const routed = c.route.reduce((s, x) => s + x.lengthFt, 0);
    const want = routed * cfg.routingFactor + (home ? cfg.cordSlackFt : cfg.jumperSlackFt);
    if (Math.abs(want - c.lengthFt) > 0.06) bad(`${f.id}: cord ${c.lengthFt} ft but the route adds up to ${want.toFixed(2)} ft`);
    if (c.boughtFt < c.lengthFt - 1e-6) bad(`${f.id}: bought ${c.boughtFt} ft for ${c.lengthFt} ft`);
    if (!home && c.lengthFt > cfg.jumperMaxFt + 1e-6) bad(`${f.id}: jumper of ${c.lengthFt} ft`);
    const allowed = home ? ['drop', 'ground', 'rise', 'hop', 'roof'] : ['drop', 'ground', 'rise', 'hop', 'roof', 'wall', 'direct'];
    if (home && !opts.allowNoDrop && c.route[0].kind !== 'drop') bad(`${f.id}: home run starts with ${c.route[0].kind}, not a drop`);
    for (const s of c.route) {
      if (!allowed.includes(s.kind)) bad(`${f.id}: ${s.kind} segment on a ${c.kind} cord`);
      if (!(s.lengthFt >= 0) || !Number.isFinite(s.lengthFt)) bad(`${f.id}: segment length ${s.lengthFt}`);
      const sol = s.planeId ? measured.planes[s.planeId] : null;
      if (!sol || !sol.ok || sol.kind !== 'wall') continue;
      const a = g.applyH(sol.Himg2plane, s.from), b = g.applyH(sol.Himg2plane, s.to);
      for (const box of openings.get(s.planeId) || []) {
        if (segInsideBox(a, b, box, 0.05)) bad(`${f.id}: ${s.kind} segment (${a.map((x) => x.toFixed(1))}) → (${b.map((x) => x.toFixed(1))}) crosses ${box.id}`);
      }
      const gv = opts.groundV && Number.isFinite(opts.groundV[s.planeId]) ? opts.groundV[s.planeId] : null;
      if ((s.kind === 'drop' || s.kind === 'rise') && Math.abs(a[0] - b[0]) > 0.05) bad(`${f.id}: ${s.kind} is not vertical`);
      if (s.kind === 'hop' && Math.abs(a[1] - b[1]) > 0.05) bad(`${f.id}: hop is not level`);
      if (s.kind === 'ground' && gv !== null && (a[1] > gv + 0.06 || b[1] > gv + 0.06)) bad(`${f.id}: ground segment at v ${a[1].toFixed(2)} / ${b[1].toFixed(2)}`);
    }
  }
  return errs;
}

/** Plain-text supply trees for reports: one block per outlet, children indented under their source. */
function printTrees(project, pw) {
  const lines = [];
  const feedById = new Map(pw.feeds.map((f) => [f.id, f]));
  const cordText = (f) => (f.cord ? `${f.cord.pieces.join('+')} ft ${f.cord.awg} AWG (needs ${f.cord.lengthFt}; ${f.cord.routeText})` : f.plugIn ? 'plugs straight in' : 'cord unknown');
  const walk = (f, indent) => {
    const how = f.source.kind === 'outlet' ? 'home run' : `jumper from the ${f.source.port} of ${f.source.feedId.replace(/^feed_ft_/, '')}`;
    lines.push(`${indent}${f.start.label} [${f.watts} W${f.taps ? ', ' + f.taps + ' tap' : ''}]: ${how}, ${cordText(f)}`);
    for (const id of f.childFeedIds) walk(feedById.get(id), indent + '    ');
  };
  for (const o of pw.outlets) {
    lines.push(`${o.label}: ${o.watts} W, ${(o.directFeedIds || []).length} home runs, ${o.splitters} power stakes`);
    for (const id of o.directFeedIds || []) walk(feedById.get(id), '  ');
  }
  return lines.join('\n');
}

module.exports = { lib, libWith, SOLS, wallSol, F, toFt, feature, outlet, circuit, project, measure, plan, codes, byCode, feedOf, kinds,
  checkPlan, openingsByWall, segInsideBox, printTrees, DEFAULT_PARAMS };
