/* LightPlan core: power (SPEC §5.7).
 * Chains light runs end to end, splits chains into feeds that respect each product's
 * "max end to end" limit, picks the run direction and outlet for each feed, sizes the extension cord
 * (ampacity + voltage drop), totals circuit loads against the 80% continuous-load rule, and counts
 * timers, splitters, cord covers and GFCI adapters. Pure: no DOM, no clock, never mutates inputs,
 * never throws on partial project data.
 *
 * Distances. Image points become feet through the plane solutions from measure.js:
 *  - two points on the same calibrated plane: distance in plane coordinates (feet);
 *  - otherwise: image distance × mean local scale (geometry.localScale) of the planes available at the
 *    two points; with no calibrated plane at either point the distance is unknown (no chaining, and the
 *    cord length is reported as unknown with a warning).
 * Cord routing: same plane → |Δu| + |Δv| (across at outlet height, then up or down the wall);
 * different planes → scaled straight distance × 1.3; then × routingFactor + cordSlackFt.
 *
 * Deviations from SPEC §5.7 (documented signature and shapes unchanged):
 *  - Extra warning codes: cord-unknown (no scale to size a cord), outlet-no-circuit (used outlet has no
 *    circuit; assumed to be alone on a 15 A breaker), outlet-missing (params.outletId names an outlet
 *    that does not exist), cord-ampacity (a feed draws more than a 12 AWG cord can carry).
 *  - Feeds only consider outlets on the same photo (unless forced with params.outletId); feeds with no
 *    outlet on their photo stay unassigned and get the 'unassigned' warning.
 *  - Feed objects carry an extra `cordUnknown: bool`; cord is null when there is no outlet or the length
 *    cannot be measured.
 *  - Extra exports: limitW, voltageDropPct, chooseCordGauge, cordPieces, sizeCord, DISCLAIMER.
 */
LP.define('power', ['geometry', 'catalog'], function (geometry, catalog) {
  'use strict';

  const { FEATURE_TYPES } = catalog;
  const CROSS_PLANE_FACTOR = 1.3;     // straight-line cord distance between planes → routed distance
  const ASSUMED_BREAKER_AMPS = 15;    // outlets with no circuit are assumed to sit alone on a 15 A breaker
  const DISCLAIMER = 'This is a planning estimate, not an electrical inspection. Check your breaker sizes ' +
    'and what else shares each circuit, use outdoor-rated cords and GFCI protection, and ask a licensed ' +
    'electrician before adding outlets or circuits.';
  const LEVEL_ORDER = { danger: 0, warn: 1, info: 2 };
  const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'] };

  // ---------------------------------------------------------------- small helpers
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const isH = (H) => Array.isArray(H) && H.length === 9 && H.every(Number.isFinite);
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const round = (v, d) => { const k = Math.pow(10, d); return Math.round(v * k) / k; };
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

  /** Integer with thousands separators, locale independent ("1,612"). */
  function fmtInt(v) {
    if (!Number.isFinite(v)) return '?';
    const s = String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + s;
  }
  function fmt1(v) { return Number.isFinite(v) ? String(round(v, 1)) : '?'; }
  function unitWord(unit, n) { const w = UNIT_WORDS[unit] || ['unit', 'units']; return n === 1 ? w[0] : w[1]; }
  function listText(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function powerConfig(library) {
    const base = catalog.DEFAULT_CONFIG.power;
    const over = library && isObj(library.config) && isObj(library.config.power) ? library.config.power : {};
    const cfg = Object.assign({}, base);
    for (const k of Object.keys(over)) if (over[k] !== undefined && over[k] !== null) cfg[k] = over[k];
    return cfg;
  }

  // ---------------------------------------------------------------- electrical rules (exported, pure)
  /** Safe continuous load for a breaker: amps × volts × continuous factor (15 A → 1,440 W; 20 A → 1,920 W). */
  function limitW(breakerAmps, voltage, continuousFactor) {
    const a = pos(breakerAmps) || ASSUMED_BREAKER_AMPS;
    const v = pos(voltage) || 120;
    const f = pos(continuousFactor) || 0.8;
    return round(a * v * f, 6);
  }

  /** Round-trip voltage drop in percent: 2 · L · (Ω/1000 ft) · I / V · 100. */
  function voltageDropPct(lengthFt, amps, ohmsPer1000ft, voltage) {
    return ((2 * lengthFt * (ohmsPer1000ft / 1000) * amps) / voltage) * 100;
  }

  /**
   * Thinnest gauge (16 → 14 → 12 AWG) whose ampacity covers the current and whose voltage drop stays within
   * maxVoltageDropPct. When none qualifies, 12 AWG is returned with ok:false.
   * Returns {awg, voltageDropPct, ok, ampacityOk, dropOk}.
   */
  function chooseCordGauge(lengthFt, amps, cfg) {
    const c = Object.assign({}, catalog.DEFAULT_CONFIG.power, cfg || {});
    const V = pos(c.voltage) || 120;
    const maxDrop = pos(c.maxVoltageDropPct) || 3;
    const L = Math.max(0, Number.isFinite(lengthFt) ? lengthFt : 0);
    const I = Math.max(0, Number.isFinite(amps) ? amps : 0);
    const gauges = catalog.CORD_GAUGES.slice().sort((a, b) => b.awg - a.awg); // 16, 14, 12
    for (const g of gauges) {
      const drop = voltageDropPct(L, I, g.ohmsPer1000ft, V);
      if (g.ampacity >= I && drop <= maxDrop + 1e-9) {
        return { awg: g.awg, voltageDropPct: round(drop, 2), ok: true, ampacityOk: true, dropOk: true };
      }
    }
    const thick = gauges[gauges.length - 1];
    const drop = voltageDropPct(L, I, thick.ohmsPer1000ft, V);
    return { awg: thick.awg, voltageDropPct: round(drop, 2), ok: false, ampacityOk: thick.ampacity >= I, dropOk: drop <= maxDrop + 1e-9 };
  }

  /** Purchasable cord pieces: the smallest standard length ≥ L; above 100 ft, 100 ft cords plus the remainder. */
  function cordPieces(lengthFt) {
    const lengths = catalog.CORD_LENGTHS.slice().sort((a, b) => a - b);
    const longest = lengths[lengths.length - 1];
    let L = Number.isFinite(lengthFt) && lengthFt > 0 ? lengthFt : 0;
    const pieces = [];
    // Guard against absurd inputs (a 50,000 ft cord is a data error, not a shopping list).
    while (L > longest + 1e-9 && pieces.length < 100) { pieces.push(longest); L -= longest; }
    if (L > 1e-9 || pieces.length === 0) pieces.push(lengths.find((x) => x >= L - 1e-9) || longest);
    return pieces;
  }

  /** Cord for a feed: {lengthFt, awg, pieces, voltageDropPct, ok, ampacityOk, dropOk}. */
  function sizeCord(lengthFt, watts, cfg, voltage) {
    const c = Object.assign({}, catalog.DEFAULT_CONFIG.power, cfg || {});
    const V = pos(voltage) || pos(c.voltage) || 120;
    const L = round(Math.max(0, Number.isFinite(lengthFt) ? lengthFt : 0), 1);
    const I = Math.max(0, Number.isFinite(watts) ? watts : 0) / V;
    const g = chooseCordGauge(L, I, Object.assign({}, c, { voltage: V }));
    return { lengthFt: L, awg: g.awg, pieces: cordPieces(L), voltageDropPct: g.voltageDropPct,
      ok: g.ok, ampacityOk: g.ampacityOk, dropOk: g.dropOk };
  }

  // ---------------------------------------------------------------- image ↔ feet
  /** Distance and routing helpers bound to one project's plane solutions. */
  function makeSpace(project, measured) {
    const sols = measured && isObj(measured.planes) ? measured.planes : {};
    const planes = Array.isArray(project && project.planes) ? project.planes : [];

    function sol(planeId) {
      const s = planeId ? sols[planeId] : null;
      return s && s.ok && isH(s.Himg2plane) ? s : null;
    }
    function toPlane(s, p) { return s && isPt(p) ? geometry.applyH(s.Himg2plane, p) : null; }
    function toImage(s, uv) {
      if (!s || !isPt(uv)) return null;
      const H = isH(s.Hplane2img) ? s.Hplane2img : geometry.invertH(s.Himg2plane);
      return H ? geometry.applyH(H, uv) : null;
    }
    /** Feet per image pixel of plane `s` at image point p, or null. */
    function scaleAt(s, p) {
      if (!s || !isPt(p)) return null;
      const ls = geometry.localScale(s.Himg2plane, p);
      return ls && Number.isFinite(ls.scale) && ls.scale > 0 ? ls.scale : null;
    }
    function planeName(planeId) {
      const pl = planes.find((p) => p && p.id === planeId);
      return pl && pl.name ? pl.name : 'its plane';
    }
    /** Approximate feet between two located points ({point, planeId}); null when no scale is available. */
    function feetBetween(a, b) {
      if (!isPt(a.point) || !isPt(b.point)) return null;
      if (a.planeId && a.planeId === b.planeId) {
        const s = sol(a.planeId);
        const ua = toPlane(s, a.point), ub = toPlane(s, b.point);
        if (ua && ub) return geometry.dist(ua, ub);
      }
      const scales = [scaleAt(sol(a.planeId), a.point), scaleAt(sol(b.planeId), b.point)].filter((x) => x !== null);
      return scales.length ? geometry.dist(a.point, b.point) * mean(scales) : null;
    }
    /**
     * Cord route from an outlet to a feed start: {routedFt|null, path:[[x,y]...], samePlane}.
     * routedFt is the walking distance along the house before routingFactor and slack are applied.
     */
    function cordRoute(outlet, start) {
      const o = outlet.point, p = start.point;
      if (!isPt(o) || !isPt(p)) return { routedFt: null, path: [], samePlane: false };
      const straightPath = [o.slice(0, 2), p.slice(0, 2)];
      if (outlet.planeId && outlet.planeId === start.planeId) {
        const s = sol(start.planeId);
        const uo = toPlane(s, o), us = toPlane(s, p);
        if (uo && us) {
          // Across at outlet height, then straight up/down the wall to the feed start.
          const corner = toImage(s, [us[0], uo[1]]);
          const path = corner ? [o.slice(0, 2), corner, p.slice(0, 2)] : straightPath;
          return { routedFt: Math.abs(us[0] - uo[0]) + Math.abs(us[1] - uo[1]), path, samePlane: true };
        }
      }
      // Different planes, or an outlet without a calibrated plane: scale the straight line.
      const outletScale = scaleAt(sol(outlet.planeId), o);
      const startScale = scaleAt(sol(start.planeId), p);
      const scales = [outletScale, startScale].filter((x) => x !== null);
      if (!scales.length) return { routedFt: null, path: straightPath, samePlane: false };
      return { routedFt: geometry.dist(o, p) * mean(scales) * CROSS_PLANE_FACTOR, path: straightPath, samePlane: false };
    }
    return { sol, toPlane, toImage, scaleAt, planeName, feetBetween, cordRoute };
  }

  // ---------------------------------------------------------------- run geometry
  /**
   * Geometry of a powered run: shape kind and its two "ports" (end 0 = first point, end 1 = last point).
   * Closed outlines, bushes and wraps (trees, columns) plug in at one spot, so both ports are the same point.
   */
  function runShape(feature) {
    const ft = FEATURE_TYPES[feature.type];
    const pts = (Array.isArray(feature.points) ? feature.points : []).filter(isPt).map((p) => [p[0], p[1]]);
    if (!ft || !pts.length) return null;
    let kind = 'open';
    if (ft.geometry === 'vertical') kind = 'vertical';
    else if (ft.geometry === 'area') kind = 'area';
    else if (pts.length > 2 && (feature.closed === true || (feature.closed == null && ft.closedDefault))) kind = 'closed';
    const first = pts[0];
    const last = kind === 'open' ? pts[pts.length - 1] : first;
    return { kind, pts, ports: [first, last] };
  }

  /** Image-space polyline a run follows when entered from `reversed` ? end 1 : end 0. */
  function traversal(shape, reversed) {
    const pts = shape.pts;
    if (shape.kind === 'vertical') return pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : [pts[0]];
    if (shape.kind === 'closed' || shape.kind === 'area') {
      const loop = reversed ? [pts[0]].concat(pts.slice(1).reverse()) : pts.slice();
      return loop.concat([pts[0]]);
    }
    return reversed ? pts.slice().reverse() : pts.slice();
  }

  /** Point at `fraction` (0..1) of the run's true length along its traversal (plane space when calibrated). */
  function pointAlong(path, fraction, s, space) {
    if (path.length < 2) return path[0].slice();
    const f = Math.min(1, Math.max(0, fraction));
    const planePts = s ? path.map((p) => space.toPlane(s, p)) : null;
    if (planePts && planePts.every(Boolean)) {
      const total = geometry.polylineLength(planePts, false);
      const hit = geometry.pointAtDistance(planePts, total * f);
      const back = hit && space.toImage(s, hit.point);
      if (back) return back;
    }
    const total = geometry.polylineLength(path, false);
    const hit = geometry.pointAtDistance(path, total * f);
    return hit ? hit.point : path[0].slice();
  }

  /** "left end of Front eave", "top-left corner of Bay window", "base of Oak tree". */
  function portLabel(shape, path, label) {
    const p = path[0];
    if (shape.kind === 'vertical') return 'base of ' + label;
    if (shape.kind === 'closed' || shape.kind === 'area') {
      const c = geometry.centroid(shape.pts);
      const corner = (p[1] <= c[1] ? 'top' : 'bottom') + '-' + (p[0] <= c[0] ? 'left' : 'right');
      return corner + (shape.kind === 'area' ? ' edge of ' : ' corner of ') + label;
    }
    const q = path[path.length - 1];
    const dx = p[0] - q[0], dy = p[1] - q[1];
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx <= 0 ? 'left' : 'right') : (dy <= 0 ? 'top' : 'bottom');
    return side + ' end of ' + label;
  }

  // ---------------------------------------------------------------- main
  function planPower(project, measured, runs, library) {
    const lib = library && Array.isArray(library.products) && isObj(library.config) ? library : catalog.getLibrary(project);
    const cfg = powerConfig(lib);
    const V = pos(cfg.voltage) || 120;
    const factor = pos(cfg.continuousFactor) || 0.8;
    const gapFt = Number.isFinite(cfg.chainGapFt) && cfg.chainGapFt >= 0 ? cfg.chainGapFt : 3;
    const routingFactor = pos(cfg.routingFactor) || 1;
    const slackFt = Number.isFinite(cfg.cordSlackFt) && cfg.cordSlackFt >= 0 ? cfg.cordSlackFt : 0;
    const splitterOutlets = pos(cfg.splitterOutlets) || 3;
    const space = makeSpace(project, measured);
    const warnings = [];
    const warn = (level, code, message, extra) => warnings.push(Object.assign({ level, code, message }, extra || {}));

    const features = Array.isArray(project && project.features) ? project.features.filter(isObj) : [];
    const featureById = new Map(features.map((f) => [f.id, f]));
    const allRuns = (Array.isArray(runs) ? runs : []).filter((r) => isObj(r) && typeof r.id === 'string');
    const outlets = (Array.isArray(project && project.outlets) ? project.outlets : []).filter((o) => isObj(o) && typeof o.id === 'string');
    const outletById = new Map(outlets.map((o) => [o.id, o]));
    const circuits = (Array.isArray(project && project.circuits) ? project.circuits : []).filter((c) => isObj(c) && typeof c.id === 'string');
    const circuitById = new Map(circuits.map((c) => [c.id, c]));

    // ---- circuit bookkeeping: each outlet loads its circuit, or an assumed 15 A circuit of its own.
    const circuitKey = (o) => (o.circuitId && circuitById.has(o.circuitId) ? o.circuitId : 'outlet:' + o.id);
    const circuitVoltage = (c) => pos(c && c.voltage) || V;
    const limits = new Map();
    const baseLoads = new Map();
    for (const c of circuits) {
      limits.set(c.id, limitW(c.breakerAmps, circuitVoltage(c), factor));
      baseLoads.set(c.id, Number.isFinite(c.existingLoadW) && c.existingLoadW > 0 ? c.existingLoadW : 0);
    }
    for (const o of outlets) {
      const k = circuitKey(o);
      if (!limits.has(k)) { limits.set(k, limitW(ASSUMED_BREAKER_AMPS, V, factor)); baseLoads.set(k, 0); }
    }
    const outletVoltage = (o) => circuitVoltage(o && circuitById.get(o.circuitId));

    // ---- powered runs: measured runs with a quantity and traceable geometry
    const items = [];
    for (let idx = 0; idx < allRuns.length; idx++) {
      const run = allRuns[idx];
      const feature = featureById.get(run.featureId);
      if (!feature || !(run.quantity > 0)) continue;
      const shape = runShape(feature);
      if (!shape) continue;
      const params = isObj(feature.params) ? feature.params : {};
      let forcedOutlet = null;
      if (typeof params.outletId === 'string' && params.outletId) {
        if (outletById.has(params.outletId)) forcedOutlet = params.outletId;
        else warn('warn', 'outlet-missing', `${run.label} is set to an outlet that no longer exists, so the nearest outlet is used instead.`, { featureId: feature.id });
      }
      const product = catalog.getProduct(lib.products, run.productId);
      items.push({
        idx, run, feature, shape, product,
        planeId: feature.planeId || run.planeId || null,
        imageId: feature.imageId || run.imageId || null,
        forcedReverse: params.reverse === true && shape.kind === 'open',
        forcedOutlet,
        wattsPerUnit: Math.max(0, Number.isFinite(run.watts) ? run.watts : 0) / run.quantity,
        incandescent: (run.tech || (product && product.tech)) === 'incandescent',
      });
    }

    // ---- 1. chains: link run ends of the same product that are within chainGapFt (greedy, shortest first)
    const links = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i], B = items[j];
        if (!A.run.productId || A.run.productId !== B.run.productId || A.imageId !== B.imageId) continue;
        for (let a = 0; a < 2; a++) {
          for (let b = 0; b < 2; b++) {
            const d = space.feetBetween({ point: A.shape.ports[a], planeId: A.planeId }, { point: B.shape.ports[b], planeId: B.planeId });
            if (d !== null && d <= gapFt + 1e-9) links.push({ i, a, j, b, d });
          }
        }
      }
    }
    links.sort((x, y) => x.d - y.d || cmpStr(items[x.i].run.id, items[y.i].run.id) || x.a - y.a ||
      cmpStr(items[x.j].run.id, items[y.j].run.id) || x.b - y.b);

    // Union with orientation parity. par[r] = "run r is traversed forward when its component is walked in
    // canonical direction". Linking end a of i to end b of j forces fwd_i === fwd_j exactly when a !== b
    // (end-to-start keeps direction, start-to-start or end-to-end flips one run). Components remember
    // whether a forced-reverse run requires the canonical (true) or flipped (false) walk, and any forced
    // outlet, so incompatible runs never end up in one chain.
    const comp = items.map((_, k) => k);
    const members = items.map((_, k) => [k]);
    const par = items.map(() => true);
    const need = items.map((it) => (it.forcedReverse ? false : null));
    const compOutlet = items.map((it) => it.forcedOutlet);
    const nbr = items.map(() => [null, null]);
    for (const L of links) {
      const ci = comp[L.i], cj = comp[L.j];
      if (ci === cj || nbr[L.i][L.a] || nbr[L.j][L.b]) continue;
      if (compOutlet[ci] && compOutlet[cj] && compOutlet[ci] !== compOutlet[cj]) continue;
      const flip = (par[L.i] === par[L.j]) !== (L.a !== L.b);
      const needJ = need[cj] === null ? null : (flip ? !need[cj] : need[cj]);
      if (need[ci] !== null && needJ !== null && need[ci] !== needJ) continue;
      if (flip) for (const m of members[cj]) par[m] = !par[m];
      for (const m of members[cj]) { comp[m] = ci; members[ci].push(m); }
      members[cj] = [];
      need[ci] = need[ci] !== null ? need[ci] : needJ;
      compOutlet[ci] = compOutlet[ci] || compOutlet[cj];
      nbr[L.i][L.a] = { j: L.j, b: L.b };
      nbr[L.j][L.b] = { j: L.i, b: L.a };
    }

    /** The two possible walks of a component (start from each free end). */
    function walks(memberIdx) {
      const sorted = memberIdx.slice().sort((x, y) => x - y);
      const free = [];
      for (const m of sorted) for (const port of [0, 1]) if (!nbr[m][port]) free.push({ m, port });
      return free.slice(0, 2).map((f) => {
        const steps = [];
        let cur = f.m, entry = f.port;
        while (cur !== null && steps.length <= sorted.length) {
          steps.push({ k: cur, reversed: entry === 1 });
          const next = nbr[cur][1 - entry];
          if (!next) break;
          cur = next.j; entry = next.b;
        }
        return steps;
      });
    }

    // ---- 2. feeds for one walk: fill each feed up to maxEndToEnd units, splitting between runs, and
    // splitting a run along its length only when that run alone is longer than the limit.
    function buildFeeds(steps) {
      const feeds = [];
      let cur = null;
      const product = items[steps[0].k].product;
      const maxE = pos(product && product.maxEndToEnd) || Infinity;
      const open = (step, offset) => {
        const it = items[step.k];
        const path = traversal(it.shape, step.reversed);
        const q = it.run.quantity;
        let point, label;
        if (offset <= 0) {
          point = path[0].slice();
          label = portLabel(it.shape, path, it.run.label);
        } else {
          point = pointAlong(path, offset / q, space.sol(it.planeId), space);
          // Mid-run feed start: say how far along the run it is, from the end the run starts at.
          const pct = Math.round((offset / q) * 100);
          if (it.shape.kind === 'vertical') label = `point ${pct}% of the way up ${it.run.label}`;
          else if (it.run.lengthFt > 0) label = `point ${fmtInt((offset / q) * it.run.lengthFt)} ft from the ${portLabel(it.shape, path, it.run.label)}`;
          else label = `point ${pct}% of the way along ${it.run.label}`;
        }
        cur = { portions: [], units: 0, watts: 0, start: { point, imageId: it.imageId, planeId: it.planeId, label } };
        feeds.push(cur);
      };
      const add = (step, units) => {
        const it = items[step.k];
        cur.portions.push({ k: step.k, units });
        cur.units += units;
        cur.watts += units * it.wattsPerUnit;
      };
      for (const step of steps) {
        const q = items[step.k].run.quantity;
        if (q <= maxE) {
          if (!cur || cur.units + q > maxE) open(step, 0);
          add(step, q);
          continue;
        }
        // This run alone exceeds the limit: top up the current feed, then start new feeds along it.
        let offset = 0;
        while (q - offset > 1e-9) {
          if (!cur || cur.units >= maxE - 1e-9) open(step, offset);
          const take = Math.min(maxE - cur.units, q - offset);
          add(step, take);
          offset += take;
        }
      }
      for (const f of feeds) {
        f.runIds = [];
        for (const p of f.portions) { const id = items[p.k].run.id; if (!f.runIds.includes(id)) f.runIds.push(id); }
        f.forcedOutlet = null;
        for (const p of f.portions) if (items[p.k].forcedOutlet) { f.forcedOutlet = items[p.k].forcedOutlet; break; }
        f.incandescent = f.portions.some((p) => items[p.k].incandescent);
        f.watts = round(f.watts, 2);
        f.units = round(f.units, 4);
      }
      return { feeds, maxE };
    }

    // ---- outlet candidates and capacity
    const routeCache = new Map();
    function route(outlet, start) {
      const key = outlet.id + '|' + start.point[0] + ',' + start.point[1] + '|' + start.planeId;
      if (!routeCache.has(key)) {
        const r = space.cordRoute(outlet, start);
        const lengthFt = r.routedFt === null ? null : r.routedFt * routingFactor + slackFt;
        routeCache.set(key, { lengthFt, path: r.path });
      }
      return routeCache.get(key);
    }
    /** Outlets on the feed's photo, nearest cord first (unknown lengths last), ties by outlet id. */
    function candidates(feed) {
      return outlets
        .filter((o) => !o.imageId || !feed.start.imageId || o.imageId === feed.start.imageId)
        .map((o) => ({ outlet: o, lengthFt: route(o, feed.start).lengthFt }))
        .sort((x, y) => {
          const ax = x.lengthFt === null ? Infinity : x.lengthFt, ay = y.lengthFt === null ? Infinity : y.lengthFt;
          return ax - ay || cmpStr(x.outlet.id, y.outlet.id);
        });
    }
    const fits = (loads, o, watts) => (loads.get(circuitKey(o)) || 0) + watts <= limits.get(circuitKey(o)) + 1e-9;
    /** Greedy outlet choice: forced outlet → nearest outlet whose circuit stays within its limit → nearest. */
    function pickOutlet(feed, loads) {
      if (feed.forcedOutlet) return outletById.get(feed.forcedOutlet);
      const cands = candidates(feed);
      if (!cands.length) return null;
      const ok = cands.find((c) => fits(loads, c.outlet, feed.watts));
      return (ok || cands[0]).outlet;
    }
    const cordLen = (o, feed) => {
      const L = o ? route(o, feed.start).lengthFt : null;
      return L === null ? Infinity : L;
    };

    // ---- 3. chains: pick the walk whose first feed has the shortest cord to an outlet with capacity
    const comps = [];
    for (let c = 0; c < items.length; c++) if (members[c].length) comps.push(members[c].slice().sort((x, y) => x - y));
    comps.sort((x, y) => x[0] - y[0]);
    const chainWatts = (m) => m.reduce((s, k) => s + Math.max(0, items[k].run.watts || 0), 0);
    const order = comps.map((m, n) => n).sort((x, y) => chainWatts(comps[y]) - chainWatts(comps[x]) ||
      cmpStr(items[comps[x][0]].run.id, items[comps[y][0]].run.id));
    const tentative = new Map(baseLoads);
    const chosen = new Array(comps.length);
    for (const n of order) {
      const m = comps[n];
      let options = walks(m).map((steps, w) => ({ steps, w }));
      const allowed = options.filter((o) => o.steps.every((s) => !items[s.k].forcedReverse || s.reversed));
      if (allowed.length) options = allowed;
      for (const opt of options) {
        const built = buildFeeds(opt.steps);
        opt.feeds = built.feeds;
        opt.maxE = built.maxE;
        const first = opt.feeds[0];
        opt.firstCord = cordLen(pickOutlet(first, tentative), first);
        opt.totalCord = opt.feeds.reduce((s, f) => { const L = cordLen(pickOutlet(f, tentative), f); return s + (L === Infinity ? 1e6 : L); }, 0);
      }
      options.sort((x, y) => x.firstCord - y.firstCord || x.totalCord - y.totalCord || x.w - y.w);
      const best = options[0];
      chosen[n] = best;
      // Tentatively load circuits so later chains see what is already planned.
      for (const f of best.feeds) {
        const o = pickOutlet(f, tentative);
        if (o) tentative.set(circuitKey(o), (tentative.get(circuitKey(o)) || 0) + f.watts);
      }
    }

    // ---- assemble chains and feeds (chain order = first run's position in the run list)
    const chainsOut = [];
    const feedsOut = [];
    const runInfo = {};
    const chainLabels = new Map();
    comps.forEach((m, n) => {
      const opt = chosen[n];
      const key = items[m[0]].run.id.replace(/^run_/, '');
      const chainId = 'chain_' + key;
      const reversed = {};
      for (const s of opt.steps) reversed[items[s.k].run.id] = items[s.k].shape.kind === 'vertical' ? false : s.reversed;
      const feedIds = [];
      opt.feeds.forEach((f, fi) => {
        const id = 'feed_' + key + '_' + (fi + 1);
        feedIds.push(id);
        feedsOut.push({
          id, chainId, runIds: f.runIds.slice(), strings: f.units, watts: f.watts, amps: round(f.watts / V, 4),
          start: f.start, outletId: null, circuitId: null, cord: null, cordPath: [], crossesWalkway: false, cordUnknown: false,
          _forced: f.forcedOutlet, _incandescent: f.incandescent,
        });
      });
      const runIds = opt.steps.map((s) => items[s.k].run.id);
      const units = opt.steps.reduce((s, st) => s + items[st.k].run.quantity, 0);
      chainsOut.push({ id: chainId, productId: items[m[0]].run.productId, runIds, reversed, strings: units,
        watts: round(chainWatts(m), 2), feedIds });
      const labels = opt.steps.map((s) => items[s.k].run.label);
      chainLabels.set(chainId, labels.length === 1 ? labels[0] : listText(labels.length > 3 ? labels.slice(0, 2).concat([`${labels.length - 2} more runs`]) : labels));
      for (const s of opt.steps) {
        const it = items[s.k];
        const path = traversal(it.shape, s.reversed);
        runInfo[it.run.id] = {
          chainId, feedIds: feedIds.filter((fid, fi) => opt.feeds[fi].runIds.includes(it.run.id)),
          outletId: null, circuitId: null,
          start: path[0].slice(), end: path[path.length - 1].slice(), reversed: reversed[it.run.id],
        };
      }
      if (opt.feeds.length > 1) {
        const product = items[m[0]].product;
        const unit = items[m[0]].run.unit;
        const what = runIds.length > 1 ? 'these connected runs use' : 'this run uses';
        warn('info', 'max-end-to-end',
          `${chainLabels.get(chainId)} needs ${opt.feeds.length} feeds: ${(product && product.name) || items[m[0]].run.productName} allows only ` +
          `${fmtInt(opt.maxE)} ${unitWord(unit, opt.maxE)} end to end and ${what} ${fmtInt(units)}.`,
          { featureId: items[m[0]].feature.id });
      }
    });
    // Unpowered runs (not measured, no product, no geometry) still get an entry.
    for (const run of allRuns) {
      if (runInfo[run.id]) continue;
      const f = featureById.get(run.featureId);
      const shape = f ? runShape(f) : null;
      const path = shape ? traversal(shape, false) : null;
      runInfo[run.id] = { chainId: null, feedIds: [], outletId: null, circuitId: null,
        start: path ? path[0].slice() : null, end: path ? path[path.length - 1].slice() : null, reversed: false };
    }

    // ---- 4. outlets: forced feeds first, then the rest by watts (largest first), ties by id
    const loads = new Map(baseLoads);
    const assignOrder = feedsOut.slice().sort((x, y) => (x._forced ? 0 : 1) - (y._forced ? 0 : 1) ||
      y.watts - x.watts || cmpStr(x.id, y.id));
    for (const feed of assignOrder) {
      const o = pickOutlet({ forcedOutlet: feed._forced, start: feed.start, watts: feed.watts }, loads);
      if (!o) continue;
      feed.outletId = o.id;
      feed.circuitId = o.circuitId && circuitById.has(o.circuitId) ? o.circuitId : null;
      loads.set(circuitKey(o), (loads.get(circuitKey(o)) || 0) + feed.watts);
      const r = route(o, feed.start);
      feed.cordPath = r.path.map((p) => p.slice());
      if (r.lengthFt === null) {
        feed.cordUnknown = true;
        const reason = feed.start.imageId && o.imageId && o.imageId !== feed.start.imageId
          ? `${o.label || 'the outlet'} is on a different photo`
          : `${space.planeName(feed.start.planeId)} is not calibrated`;
        warn('warn', 'cord-unknown', `The cord length to the ${feed.start.label} is unknown because ${reason}. Calibrate it to size the cord.`,
          { featureId: runFeature(feed), outletId: o.id });
      } else {
        feed.cord = sizeCord(r.lengthFt, feed.watts, cfg, outletVoltage(o));
      }
    }

    // ---- walkway crossings: does the cord path cross a walkway traced on the same photo?
    const walkways = features.filter((f) => f.type === 'walkway' && Array.isArray(f.points) && f.points.filter(isPt).length >= 2);
    for (const feed of feedsOut) {
      if (feed.cordPath.length < 2) continue;
      const own = new Set(feed.runIds.map((id) => (allRuns.find((r) => r.id === id) || {}).featureId));
      feed.crossesWalkway = walkways.some((w) => {
        if (own.has(w.id) || (w.imageId && feed.start.imageId && w.imageId !== feed.start.imageId)) return false;
        const wp = w.points.filter(isPt);
        const segs = [];
        for (let i = 1; i < wp.length; i++) segs.push([wp[i - 1], wp[i]]);
        if (w.closed && wp.length > 2) segs.push([wp[wp.length - 1], wp[0]]);
        for (let i = 1; i < feed.cordPath.length; i++) {
          for (const s of segs) if (geometry.segmentsIntersect(feed.cordPath[i - 1], feed.cordPath[i], s[0], s[1])) return true;
        }
        return false;
      });
    }
    function runFeature(feed) {
      const r = allRuns.find((x) => x.id === feed.runIds[0]);
      return r ? r.featureId : undefined;
    }

    // ---- run info: outlet/circuit of each run's first feed
    for (const id of Object.keys(runInfo)) {
      const info = runInfo[id];
      const f = info.feedIds.length ? feedsOut.find((x) => x.id === info.feedIds[0]) : null;
      if (f) { info.outletId = f.outletId; info.circuitId = f.circuitId; }
    }

    // ---- outlets, circuits, counts
    const outletsOut = outlets.map((o) => {
      const fs = feedsOut.filter((f) => f.outletId === o.id);
      const n = fs.length;
      return {
        id: o.id, label: o.label || 'Outlet', circuitId: o.circuitId && circuitById.has(o.circuitId) ? o.circuitId : null,
        feedIds: fs.map((f) => f.id), watts: round(fs.reduce((s, f) => s + f.watts, 0), 2),
        needsSplitter: n > 1, splitters: n > 1 ? Math.ceil(n / splitterOutlets) : 0,
        timer: n > 0 && cfg.timerPerOutlet !== false,
      };
    });
    const circuitsOut = circuits.map((c) => {
      const limit = limits.get(c.id);
      const load = loads.get(c.id) || 0;
      return {
        id: c.id, name: c.name || 'Circuit', breakerAmps: pos(c.breakerAmps) || ASSUMED_BREAKER_AMPS, voltage: circuitVoltage(c),
        limitW: limit, loadW: round(load, 2), existingLoadW: baseLoads.get(c.id) || 0,
        utilizationPct: round((load / limit) * 100, 1),
        outletIds: outlets.filter((o) => o.circuitId === c.id).map((o) => o.id),
        overloaded: load > limit + 1e-9,
      };
    });
    const usedOutlets = outlets.filter((o) => feedsOut.some((f) => f.outletId === o.id));
    const hasGfci = (o) => o.gfci === true || (o.gfci == null && o.type === 'exteriorGfci');
    const counts = {
      timers: outletsOut.filter((o) => o.timer).length,
      splitters: outletsOut.reduce((s, o) => s + o.splitters, 0),
      cordCovers: feedsOut.filter((f) => f.crossesWalkway).length,
      gfciAdapters: usedOutlets.filter((o) => !hasGfci(o)).length,
    };
    const cordMap = new Map();
    for (const f of feedsOut) {
      if (!f.cord) continue;
      for (const L of f.cord.pieces) {
        const k = f.cord.awg + '|' + L;
        cordMap.set(k, (cordMap.get(k) || 0) + 1);
      }
    }
    const cords = Array.from(cordMap.entries()).map(([k, count]) => {
      const [awg, L] = k.split('|').map(Number);
      return { awg, lengthFt: L, count };
    }).sort((x, y) => y.awg - x.awg || x.lengthFt - y.lengthFt);
    const totalWatts = round(items.reduce((s, it) => s + Math.max(0, it.run.watts || 0), 0), 2);

    // ---- warnings
    // Circuit loads (project circuits, then assumed per-outlet circuits).
    const circuitNotes = [];
    for (const c of circuitsOut) circuitNotes.push({ key: c.id, name: c.name, amps: c.breakerAmps, load: c.loadW, limit: c.limitW, existing: c.existingLoadW, circuitId: c.id });
    for (const o of usedOutlets) {
      if (circuitById.has(o.circuitId)) continue;
      const label = o.label || 'Outlet';
      warn('warn', 'outlet-no-circuit', `${label} is not assigned to a circuit, so LightPlan assumes it is alone on a ${ASSUMED_BREAKER_AMPS} A breaker. Pick its circuit to check the real load.`, { outletId: o.id });
      const k = circuitKey(o);
      circuitNotes.push({ key: k, name: `The circuit for ${label}`, amps: ASSUMED_BREAKER_AMPS, load: round(loads.get(k) || 0, 2), limit: limits.get(k), existing: 0, outletId: o.id });
    }
    for (const c of circuitNotes) {
      const ids = c.circuitId ? { circuitId: c.circuitId } : { outletId: c.outletId };
      const incan = feedsOut.some((f) => f._incandescent && f.outletId && circuitKey(outletById.get(f.outletId)) === c.key);
      const already = c.existing > 0 ? ` (including ${fmtInt(c.existing)} W already on it)` : '';
      if (c.load > c.limit + 1e-9) {
        warn('danger', 'circuit-overload',
          `${c.name} would carry ${fmtInt(c.load)} W${already}, over the ${fmtInt(c.limit)} W safe limit for a ${fmtInt(c.amps)} A breaker ` +
          `(${fmtInt(factor * 100)}%). Move a run to another circuit${incan ? ' or switch to LED' : ''}.`, ids);
      } else if (c.load > 0.9 * c.limit) {
        warn('warn', 'circuit-high',
          `${c.name} would carry ${fmtInt(c.load)} W${already}, ${fmtInt((c.load / c.limit) * 100)}% of its ${fmtInt(c.limit)} W safe limit. ` +
          'Keep other appliances off that circuit while the lights are on.', ids);
      }
    }
    // Incandescent products, one warning per product.
    const byProduct = new Map();
    for (const it of items) {
      if (!it.incandescent) continue;
      const e = byProduct.get(it.run.productId) || { items: [] };
      e.items.push(it);
      byProduct.set(it.run.productId, e);
    }
    for (const [pid, e] of byProduct) {
      const first = e.items[0];
      const q = e.items.reduce((s, it) => s + it.run.quantity, 0);
      const w = e.items.reduce((s, it) => s + Math.max(0, it.run.watts || 0), 0);
      const name = (first.product && first.product.name) || first.run.productName || pid;
      const led = lib.products.find((p) => p && p.enabled !== false && p.tech === 'LED' && first.product && p.category === first.product.category && p.unit === first.product.unit);
      const ledText = led ? ` The LED version (${led.name}) would draw about ${fmtInt(q * (led.wattsPerUnit || 0))} W and allows more ${unitWord(led.unit, 2)} end to end.` : '';
      const labels = listText(e.items.map((it) => it.run.label));
      warn('warn', 'incandescent', `${labels} ${e.items.length === 1 ? 'uses' : 'use'} incandescent lights (${name}): ${fmtInt(q)} ${unitWord(first.run.unit, q)} draw ${fmtInt(w)} W.${ledText}`,
        e.items.length === 1 ? { featureId: first.feature.id } : undefined);
    }
    // Feeds: cords and walkways.
    for (const f of feedsOut) {
      const fid = runFeature(f);
      if (f.crossesWalkway) {
        warn('warn', 'cord-walkway', `The cord to the ${f.start.label} crosses a walkway. Put a cord cover over it so nobody trips.`, { featureId: fid, outletId: f.outletId });
      }
      if (!f.cord) continue;
      if (!f.cord.ampacityOk) {
        warn('danger', 'cord-ampacity', `The feed at the ${f.start.label} draws ${fmt1(f.watts / outletVoltage(outletById.get(f.outletId)))} A, more than a 12 AWG cord can carry. Split it across more outlets.`, { featureId: fid, outletId: f.outletId });
      } else if (!f.cord.dropOk) {
        warn('warn', 'voltage-drop', `The ${fmtInt(f.cord.lengthFt)} ft cord to the ${f.start.label} would lose ${fmt1(f.cord.voltageDropPct)}% of its voltage even with 12 AWG cord (limit ${fmt1(cfg.maxVoltageDropPct)}%). Use a closer outlet or split the run.`, { featureId: fid, outletId: f.outletId });
      }
      if (f.cord.lengthFt > 100) {
        warn('warn', 'long-cord', `The cord to the ${f.start.label} needs about ${fmtInt(f.cord.lengthFt)} ft (${f.cord.pieces.map((p) => p + ' ft').join(' + ')}). Look for a closer outlet.`, { featureId: fid, outletId: f.outletId });
      }
    }
    // Outlets: GFCI and indoor outlets.
    for (const o of usedOutlets) {
      const label = o.label || 'Outlet';
      if (!hasGfci(o)) warn('warn', 'no-gfci', `${label} has no GFCI protection. Plug a portable outdoor GFCI adapter into it before connecting lights.`, { outletId: o.id });
      if (o.type === 'interior') warn('warn', 'interior-outlet', `${label} is an indoor outlet. Use a flat door-pass-through cord so a closing door or window can't pinch it, or use an outdoor outlet.`, { outletId: o.id });
    }
    // Feeds without an outlet.
    if (feedsOut.length && !outlets.length) {
      warn('warn', 'no-outlets', `No outlets are marked yet, so ${feedsOut.length === 1 ? 'the feed has' : `the ${feedsOut.length} feeds have`} no cord or circuit. Mark your outdoor outlets on the photo to plan cords and circuits.`);
    } else {
      const orphan = feedsOut.filter((f) => !f.outletId);
      if (orphan.length) {
        const names = orphan.slice(0, 3).map((f) => 'the ' + f.start.label);
        if (orphan.length > 3) names.push(`${orphan.length - 3} more`);
        warn('warn', 'unassigned', `No outlet is marked on the same photo as the feed${orphan.length === 1 ? '' : 's'} at ${listText(names)}. ` +
          'Mark an outlet on that photo to plan the cord.', { featureId: runFeature(orphan[0]) });
      }
    }
    warn('info', 'disclaimer', DISCLAIMER);
    warnings.sort((x, y) => LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level]); // stable: keeps insertion order within a level

    // Strip internal fields.
    for (const f of feedsOut) { delete f._forced; delete f._incandescent; }

    return {
      chains: chainsOut,
      feeds: feedsOut,
      outlets: outletsOut,
      circuits: circuitsOut,
      runInfo,
      cords,
      counts,
      totals: { watts: totalWatts, amps: round(totalWatts / V, 3) },
      warnings,
    };
  }

  return { planPower, limitW, voltageDropPct, chooseCordGauge, cordPieces, sizeCord, DISCLAIMER };
});
