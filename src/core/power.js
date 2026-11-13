/* LightPlan core: power (SPEC §5.7, as changed by §8.1 and §8.2).
 * Chains light runs end to end, splits chains into feeds that respect each product's "max end to end"
 * limit, links the feeds into supply trees (a cord from an outlet, then jumper cords from run to run),
 * routes every cord along the ground and up beside the openings, sizes it (ampacity + voltage drop),
 * totals circuit loads against the 80% continuous-load rule, and counts timers, power stakes, 3-way taps,
 * cord covers and GFCI adapters. Pure: no DOM, no clock, never mutates inputs, never throws on partial
 * project data.
 *
 * Distances. Image points become feet through the plane solutions from measure.js:
 *  - two points on the same calibrated plane: distance in plane coordinates (feet);
 *  - two points on different planes that both have a recovered camera pose (walls with a perspective
 *    rectangle, and the roof and ground planes built on them): the 3D distance in the camera frame;
 *  - otherwise: the image vector scaled by each available plane's local Jacobian in that direction
 *    (|J·d|, averaged), never by a direction-blind scale; with no calibrated plane at either point the
 *    distance is unknown (no chaining, and the cord length is reported as unknown with a warning).
 *
 * Cord routes (§8.1, makeRouter). A cord never crosses a wall face. A home run goes from the outlet down to
 * the ground, along the ground (along the wall base on one wall; straight across the yard to a point on a
 * ground plane; the 3D distance between the two feet for two walls) and straight up to where it plugs in.
 * No piece passes through the inside of a traced window or door: a riser that would is moved to the nearest
 * clear spot openingMarginFt beside the opening, with a level hop at the height of the lights. Targets within
 * 1 ft of the ground need no riser; roof targets go up the parent wall to the eave and then up the slope;
 * bushes, trees and columns are fed at their base (lowest point on the photo). Length = the pieces summed
 * × routingFactor + slack (cordSlackFt for home runs, jumperSlackFt for jumpers). A point on no calibrated
 * plane falls back to the photo distance to the other end's foot, scaled by that plane, × 1.3.
 *   Jumpers (run to run) take the shortest valid of: a straight hop (within jumperDirectFt, missing every
 *   opening); a path along the wall (straight up or down any height, across at most jumperDirectFt of open
 *   wall: across at the higher of the two heights when that works); and down - along the ground - up.
 *   feed.cord carries kind ('home' | 'jumper'), route [{kind, lengthFt, planeId, from, to}] and routeText;
 *   feed.cordPath is the same route as an image polyline.
 *
 * Supply trees (§8.2). Outlets are the first sources. Prim-style, the cheapest feasible (unpowered feed, way
 * of walking its chain, source) is taken again and again: cost = cord length needed + crossingPenaltyFt per
 * doorway or walkway crossed; forced outlets (params.outletId) go first; ties prefer a jumper, the shorter
 * cord, an end plug over a tap, then ids. A source is an outlet (home run) or a powered feed: the end plug of
 * its last string (the load then passes through its strings) or a 3-way tap where its own cord arrives.
 * A jumper needs config.power.daisyChain, no params.ownCord on either side, a length within jumperMaxFt, and:
 *  - every string run the load passes through stays within maxConnectedW (product.maxConnectedW, else
 *    maxEndToEnd × wattsPerUnit); products without an end connector (per-foot track) and wraps that are not
 *    on a wall offer no end plug;
 *  - every cord back to the outlet stays within the plug limit for everything below it;
 *  - the root outlet and its circuit stay within their limits.
 * A home run is always possible (nearest outlet within every limit, else within its circuit, else nearest
 * with an overload warning), so every feed is powered when an outlet is marked on its photo.
 * Afterwards each cord is sized for the watts it carries on the length bought; voltage drop adds up along a
 * path (feed.pathDropPct), and where a path goes over the limit the cord that loses the most is bought one
 * gauge thicker until the path fits or every cord is 12 AWG.
 *
 * Notes on the documented shapes (signature unchanged; extras are additions):
 *  - Extra warning codes: cord-unknown (no scale to size a cord), outlet-no-circuit (used outlet has no
 *    circuit; assumed to be alone on a 15 A breaker), outlet-missing (params.outletId names an outlet
 *    that does not exist), cord-ampacity (a cord carries more than a plug-in cord can: gauge ampacity
 *    capped at the 15 A plug, config.power.plugAmps), outlet-overload (danger: everything at one outlet shares
 *    one receptacle, timer and power stake, all 15 A gear, so an outlet carries at most plugAmps × V ×
 *    continuous factor = 1,440 W), timer-tungsten (more incandescent watts through one timer than
 *    config.power.timerTungstenW, 1,250 W by default), daisy-chain (info: how many jumpers link the runs and
 *    how many cords go back to the outlets), pass-through (a product whose own strings exceed its stated
 *    maxConnectedW), and a second voltage-drop wording for a path of cords that is over the limit in total.
 *  - Crossings are tested on the real route: crossesDoorway when the ground piece passes a traced door's
 *    span within 3 ft of that wall (feed.doorway = the door's label), crossesWalkway when it passes where a
 *    walkway meets the wall, crosses a walkway line on the photo, or joins two different walkway edges. Each
 *    such feed gets a cord cover. A feed's own door or walkway never counts. Two walkway edges that meet a wall
 *    within 12 ft of each other are the two sides of one walkway: a cord along that wall crosses it only when
 *    it lies across more than 1.5 ft of its width (stopping at a door jamb just inside the edge does not).
 *  - Strings along measured lengths. For string products laid along a run's length, only the strings that
 *    cover the true length are hung and loaded (feeds, circuit loads, totals); the rest of what is bought
 *    (waste rounding) are spares (chain.spares). Consecutive runs in a chain with the same string and colors
 *    are counted as one continuous line (a string carries on around the corner): runInfo[runId] carries the
 *    run's share of the strings bought (quantity), hung (hung), live watts and a plain `note`, which
 *    plan.mergeRunInfo copies onto the run. A mid-run feed starts where the hung strings end
 *    (feed.start.toward names the end it works toward), and every feed lists its `portions`
 *    [{runId, units, total, startsRun, endsRun}] for the checklist.
 *  - Feeding from the middle. Besides the two end-fed walks, a chain can be fed at the point nearest an
 *    outlet (by cord length): it is split there into two walks working outward (each filled up to the
 *    end-to-end limit). That way of walking it is offered to the supply planner when it needs at least 10%
 *    less cord and does not cost more in strings, cords and taps; with daisy chains the second walk plugs
 *    into a tap on the first walk's cord (feed.plugIn, no cord of its own).
 *  - Two plugs within 1 ft of each other need no jumper cord: the feed has plugIn: true and cord: null.
 *  - Power stakes at an outlet are counted from its home runs only (outlet.directFeedIds) and are chained from
 *    its one timer socket, so n > 1 cords need ceil((n − 1) / (splitterOutlets − 1)) stakes. More than 6
 *    home runs at one outlet adds a 'many-cords' warning. A start junction with k jumpers needs
 *    ceil(k / (tapOutlets − 1)) taps, an end plug with k jumpers needs 0 for k ≤ 1, else
 *    ceil((k − 1) / (tapOutlets − 1)) (feed.taps, counts.taps).
 *  - Outlet objects carry extra limitW, overloaded, incandescentW and directFeedIds; feedIds lists every feed
 *    in the outlet's trees. groups[] has one entry per home run (supply tree).
 *  - Feeds only consider outlets on the same photo (unless forced with params.outletId); feeds with no
 *    outlet on their photo stay unassigned and get the 'unassigned' warning.
 *  - Feed objects carry an extra `cordUnknown: bool`; cord is null when there is no outlet, the length
 *    cannot be measured, or the run plugs straight in. cord.boughtFt is the total length of the standard pieces
 *    bought; the gauge and voltageDropPct are worked out on it (the whole cord carries the current), lengthFt is
 *    the length needed.
 *  - config.power.continuousFactor is bounded to (0, 1]: a value above 1 and up to 100 is read as a percent
 *    (80 → 0.8), anything else falls back to 0.8; both cases, and any share above 0.8, add a
 *    'continuous-factor' warning.
 *  - Extra exports: limitW, continuousFactorOf, voltageDropPct, chooseCordGauge, cordPieces, sizeCord, DISCLAIMER.
 */
LP.define('power', ['geometry', 'catalog', 'suppliers'], function (geometry, catalog, suppliers) {
  'use strict';

  const { FEATURE_TYPES } = catalog;
  const CROSS_PLANE_FACTOR = 1.3;     // photo distance from a point on no calibrated plane → routed distance
  const ASSUMED_BREAKER_AMPS = 15;    // outlets with no circuit are assumed to sit alone on a 15 A breaker
  const DEFAULT_CONTINUOUS_FACTOR = 0.8; // the 80% rule for continuous loads (ASSUMPTIONS.md #6)
  const DEFAULT_PLUG_AMPS = 15;       // plug-in cords, timers, power stakes and duplex outlets are 15 A devices
  const DEFAULT_TIMER_TUNGSTEN_W = 1250; // typical outdoor timer rating for incandescent (tungsten) loads
  const MANY_CORDS = 6;               // more cords than this at one outlet gets a 'many-cords' warning
  const WALKWAY_NEAR_WALL_FT = 3;     // a walkway edge within this distance of the wall base meets the wall
  const WALKWAY_MAX_WIDTH_FT = 12;    // two walkway edges that meet a wall this close together are one walkway
  const WALKWAY_EDGE_FT = 1.5;        // a cord along the wall that lies across less of a walkway than this does not cross it
  const SPAN_TOL_FT = 0.25;           // spans that only touch at their ends do not cross
  const SPLIT_GAIN = 0.9;             // feeding a chain from the middle must save at least 10% of the cord
  const NEAR_GROUND_FT = 1;           // a plug this close to the ground needs no riser
  const ROUTE_TOL_FT = 0.05;          // a cord that only touches an opening's outline does not cross it
  const TAP_PRICE = (catalog.getAccessory(null, 'tap-3way') || { price: 0 }).price; // for comparing ways to feed a chain
  const PLUG_REACH_FT = 1;            // two plugs this close need no jumper cord: one plugs straight into the other
  const DISCLAIMER = 'This is a planning estimate, not an electrical inspection. Check your breaker sizes ' +
    'and what else shares each circuit, use outdoor-rated cords and GFCI protection, and ask a licensed ' +
    'electrician before adding outlets or circuits.';
  const LEVEL_ORDER = { danger: 0, warn: 1, info: 2 };
  const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'] };

  // ---------------------------------------------------------------- small helpers
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const isH = (H) => Array.isArray(H) && H.length === 9 && H.every(Number.isFinite);
  const isM3 = isH;
  const isV3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
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
  /**
   * The share of a breaker's rating that continuous load may use, always in (0, 1].
   * A value above 1 and up to 100 is read as a percentage (80 → 0.8); anything else that is not in (0, 1]
   * falls back to the 80% rule. Returns {factor, raw, reading: 'ok'|'percent'|'default'}.
   */
  function continuousFactorOf(raw) {
    if (Number.isFinite(raw) && raw > 0 && raw <= 1) return { factor: raw, raw, reading: 'ok' };
    if (Number.isFinite(raw) && raw > 1 && raw <= 100) return { factor: raw / 100, raw, reading: 'percent' };
    return { factor: DEFAULT_CONTINUOUS_FACTOR, raw, reading: raw === undefined || raw === null ? 'ok' : 'default' };
  }
  /** Safe continuous load for a breaker: amps × volts × continuous factor (15 A → 1,440 W; 20 A → 1,920 W). */
  function limitW(breakerAmps, voltage, continuousFactor) {
    const a = pos(breakerAmps) || ASSUMED_BREAKER_AMPS;
    const v = pos(voltage) || 120;
    const f = continuousFactorOf(continuousFactor).factor;
    return round(a * v * f, 6);
  }

  /** Round-trip voltage drop in percent: 2 · L · (Ω/1000 ft) · I / V · 100. */
  function voltageDropPct(lengthFt, amps, ohmsPer1000ft, voltage) {
    return ((2 * lengthFt * (ohmsPer1000ft / 1000) * amps) / voltage) * 100;
  }

  /**
   * Thinnest gauge (16 → 14 → 12 AWG) whose ampacity (capped at the 15 A plug rating, cfg.plugAmps) covers the
   * current and whose voltage drop stays within maxVoltageDropPct. When none qualifies, 12 AWG is returned
   * with ok:false.
   * Returns {awg, voltageDropPct, ok, ampacityOk, dropOk}.
   */
  function chooseCordGauge(lengthFt, amps, cfg) {
    const c = Object.assign({}, catalog.DEFAULT_CONFIG.power, cfg || {});
    const V = pos(c.voltage) || 120;
    const maxDrop = pos(c.maxVoltageDropPct) || 3;
    const L = Math.max(0, Number.isFinite(lengthFt) ? lengthFt : 0);
    const I = Math.max(0, Number.isFinite(amps) ? amps : 0);
    // A plug-in extension cord ends in a 15 A (NEMA 5-15) plug, so no gauge carries more than plugAmps.
    const plugA = pos(c.plugAmps) || DEFAULT_PLUG_AMPS;
    const capacity = (g) => Math.min(g.ampacity, plugA);
    const gauges = catalog.CORD_GAUGES.slice().sort((a, b) => b.awg - a.awg); // 16, 14, 12
    for (const g of gauges) {
      const drop = voltageDropPct(L, I, g.ohmsPer1000ft, V);
      if (capacity(g) >= I && drop <= maxDrop + 1e-9) {
        return { awg: g.awg, voltageDropPct: round(drop, 2), ok: true, ampacityOk: true, dropOk: true };
      }
    }
    const thick = gauges[gauges.length - 1];
    const drop = voltageDropPct(L, I, thick.ohmsPer1000ft, V);
    return { awg: thick.awg, voltageDropPct: round(drop, 2), ok: false, ampacityOk: capacity(thick) >= I, dropOk: drop <= maxDrop + 1e-9 };
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

  /**
   * Cord for a feed: {lengthFt, boughtFt, awg, pieces, voltageDropPct, ok, ampacityOk, dropOk}.
   * lengthFt is the length needed; the whole purchased cord (boughtFt = sum of the standard pieces) carries
   * the current, so the gauge and the voltage drop are worked out on boughtFt.
   */
  function sizeCord(lengthFt, watts, cfg, voltage) {
    const c = Object.assign({}, catalog.DEFAULT_CONFIG.power, cfg || {});
    const V = pos(voltage) || pos(c.voltage) || 120;
    const L = round(Math.max(0, Number.isFinite(lengthFt) ? lengthFt : 0), 1);
    const I = Math.max(0, Number.isFinite(watts) ? watts : 0) / V;
    const pieces = cordPieces(L);
    const bought = pieces.reduce((s, x) => s + x, 0);
    const g = chooseCordGauge(bought, I, Object.assign({}, c, { voltage: V }));
    return { lengthFt: L, boughtFt: bought, awg: g.awg, pieces, voltageDropPct: g.voltageDropPct,
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
    /**
     * Feet covered by the image vector d at image point p on plane s: |J·d| with J the local Jacobian of
     * the image → plane map. Direction matters: on a ground plane seen at a grazing angle one pixel across
     * is a fraction of a foot, one pixel up can be many feet. null without a scale.
     */
    function feetAlong(s, p, d) {
      if (!s || !isPt(p)) return null;
      const H = s.Himg2plane;
      const w = H[6] * p[0] + H[7] * p[1] + H[8];
      if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
      const X = (H[0] * p[0] + H[1] * p[1] + H[2]) / w;
      const Y = (H[3] * p[0] + H[4] * p[1] + H[5]) / w;
      const a = (H[0] - X * H[6]) / w, b = (H[1] - X * H[7]) / w;
      const c = (H[3] - Y * H[6]) / w, e = (H[4] - Y * H[7]) / w;
      const L = Math.hypot(a * d[0] + b * d[1], c * d[0] + e * d[1]);
      return Number.isFinite(L) ? L : null;
    }
    /**
     * Camera-frame 3D point (feet) of image point p on plane s, or null when the plane has no recovered
     * camera pose. Walls: plane coordinates (u, v) are the wall frame (u, v, 0). Roof and ground planes carry
     * their 3D frame in the parent wall's coordinates. Every plane on one photo shares the camera frame, so
     * points on different planes (a wall outlet and a tree on the lawn) can be compared directly.
     */
    function toCamera(s, p) {
      if (!s || !s.pose || !isM3(s.pose.R) || !isV3(s.pose.t)) return null;
      const ab = toPlane(s, p);
      if (!ab) return null;
      const f = s.frame;
      let X;
      if (f && isV3(f.origin) && isV3(f.e1) && isV3(f.e2)) {
        X = geometry.v3add(f.origin, geometry.v3add(geometry.v3scale(f.e1, ab[0]), geometry.v3scale(f.e2, ab[1])));
      } else if (s.kind === 'wall') {
        X = [ab[0], ab[1], 0];
      } else return null;
      const Xc = geometry.v3add(geometry.m3mulv(s.pose.R, X), s.pose.t);
      return Xc.every(Number.isFinite) && Xc[2] > 0 ? Xc : null; // behind the camera: above the horizon
    }
    /** Approximate feet between image points on two different planes: 3D when both have a pose, else |J·d|. */
    function crossPlaneFeet(a, b) {
      const A = toCamera(sol(a.planeId), a.point), B = toCamera(sol(b.planeId), b.point);
      if (A && B) return geometry.v3len(geometry.v3sub(A, B));
      const d = [b.point[0] - a.point[0], b.point[1] - a.point[1]];
      const ls = [feetAlong(sol(a.planeId), a.point, d), feetAlong(sol(b.planeId), b.point, d)].filter((x) => x !== null);
      return ls.length ? mean(ls) : null;
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
      return crossPlaneFeet(a, b);
    }
    /**
     * Wall-frame position (u along the wall, v up, w out from the wall) of image point p on plane `planeId`,
     * for the wall `wallId`. Same plane: (u, v, 0). Other planes: through the shared camera frame, which
     * needs a pose on both. null when unknown.
     */
    function toWallFrame(wallId, planeId, p) {
      const w = sol(wallId);
      if (!w) return null;
      if (planeId === wallId) { const uv = toPlane(w, p); return uv ? [uv[0], uv[1], 0] : null; }
      if (!w.pose || !isM3(w.pose.R) || !isV3(w.pose.t)) return null;
      const Xc = toCamera(sol(planeId), p);
      if (!Xc) return null;
      return geometry.m3mulv(geometry.m3transpose(w.pose.R), geometry.v3sub(Xc, w.pose.t));
    }
    /**
     * Span [uMin, uMax] (wall feet) where a walkway traced on the ground comes within nearFt of the wall's
     * base, or null when it does not reach the wall (a sidewalk out by the street) or cannot be placed.
     */
    function walkwaySpanAtWall(wallId, feature, nearFt) {
      const pts = (Array.isArray(feature.points) ? feature.points : []).filter(isPt)
        .map((p) => toWallFrame(wallId, feature.planeId, p));
      if (pts.length < 2 || pts.some((x) => !x)) return null;
      // Distance from the wall: w for a walkway on a ground plane; on the wall plane itself the ground
      // shows below the base, so how far below v = 0 a point maps stands in for it.
      const off = (x) => (feature.planeId === wallId ? Math.max(0, -x[1]) : Math.abs(x[2]));
      const us = [];
      const segs = [];
      for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
      if (feature.closed === true && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
      for (const [a, b] of segs) {
        const da = off(a), db = off(b);
        if (da <= nearFt) us.push(a[0]);
        if (db <= nearFt) us.push(b[0]);
        if ((da - nearFt) * (db - nearFt) < 0) us.push(a[0] + (b[0] - a[0]) * ((nearFt - da) / (db - da)));
      }
      return us.length ? [Math.min.apply(null, us), Math.max.apply(null, us)] : null;
    }
    return { sol, toPlane, toImage, scaleAt, feetAlong, toCamera, planeName, feetBetween, toWallFrame, walkwaySpanAtWall };
  }

  // ---------------------------------------------------------------- run geometry
  /**
   * Geometry of a powered run: shape kind and its two "ports" (end 0 = first point, end 1 = last point).
   * Closed outlines, bushes and wraps (trees, columns) plug in at one spot, so both ports are the same point:
   * the first corner of an outline, the base (lowest point on the photo) of a bush, tree or column.
   */
  function runShape(feature) {
    const ft = FEATURE_TYPES[feature.type];
    let pts = (Array.isArray(feature.points) ? feature.points : []).filter(isPt).map((p) => [p[0], p[1]]);
    if (!ft || !pts.length) return null;
    let kind = 'open';
    if (ft.geometry === 'vertical') kind = 'vertical';
    else if (ft.geometry === 'area') kind = 'area';
    else if (pts.length > 2 && (feature.closed === true || (feature.closed == null && ft.closedDefault))) kind = 'closed';
    // Trees, columns and bushes are fed at their base: the lowest point on the photo, whichever way they were traced.
    if (kind === 'vertical' && pts[pts.length - 1][1] > pts[0][1]) pts = pts.slice().reverse();
    if (kind === 'area') {
      let low = 0;
      for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[low][1] + 1e-9) low = i;
      pts = pts.slice(low).concat(pts.slice(0, low));
    }
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
    if (shape.kind === 'vertical' || shape.kind === 'area') return 'base of ' + label;
    if (shape.kind === 'closed') {
      const c = geometry.centroid(shape.pts);
      return (p[1] <= c[1] ? 'top' : 'bottom') + '-' + (p[0] <= c[0] ? 'left' : 'right') + ' corner of ' + label;
    }
    const q = path[path.length - 1];
    const dx = p[0] - q[0], dy = p[1] - q[1];
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx <= 0 ? 'left' : 'right') : (dy <= 0 ? 'top' : 'bottom');
    return side + ' end of ' + label;
  }

  // ---------------------------------------------------------------- cord routing (SPEC §8.1)
  /** Does segment a→b pass through the inside of the box [x0, x1] × [y0, y1]? Touching its outline does not count. */
  function segHitsBox(a, b, x0, x1, y0, y1) {
    if (!(x1 > x0) || !(y1 > y0)) return false;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 1e-9) return a[0] > x0 && a[0] < x1 && a[1] > y0 && a[1] < y1;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (Math.abs(p) < 1e-12) return q > 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (!clip(-dx, a[0] - x0) || !clip(dx, x1 - a[0]) || !clip(-dy, a[1] - y0) || !clip(dy, y1 - a[1])) return false;
    return (t1 - t0) * Math.hypot(dx, dy) > 1e-6;
  }
  /** Does the image segment a→b cross the traced line of feature f (its closing side included when it is closed)? */
  function lineCrosses(a, b, f) {
    if (!isPt(a) || !isPt(b)) return false;
    const pts = (Array.isArray(f.points) ? f.points : []).filter(isPt);
    const n = f.closed && pts.length > 2 ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) if (geometry.segmentsIntersect(a, b, pts[i], pts[(i + 1) % pts.length])) return true;
    return false;
  }
  /** "1.5", "18", "0.5": feet to the nearest half foot, for route descriptions. */
  function fmtHalf(v) { return String(Math.max(0.5, Math.round(v * 2) / 2)); }

  /**
   * Plain words for a route: "down 1.5 ft, 18 ft along the ground, up 8.5 ft beside Window left".
   * Pieces shorter than 3 in are left out.
   */
  function routeText(segs) {
    const parts = [];
    for (const s of segs) {
      if (!(s.lengthFt >= 0.25)) continue;
      const n = fmtHalf(s.lengthFt);
      if (s.kind === 'drop') parts.push(`down ${n} ft` + (s.beside ? ` beside ${s.beside}` : ''));
      else if (s.kind === 'rise') parts.push(`up ${n} ft` + (s.beside ? ` beside ${s.beside}` : ''));
      else if (s.kind === 'ground') parts.push(`${n} ft along the ground` + (s.past ? ` past ${s.past}` : ''));
      else if (s.kind === 'hop') parts.push(`${n} ft across`);
      else if (s.kind === 'roof') parts.push(s.part === 'eave' ? `${n} ft along the eave` : `${s.dir === 'down' ? 'down' : 'up'} the roof ${n} ft`);
      else if (s.kind === 'wall') parts.push((s.dir === 'across' ? `${n} ft across` : `${s.dir} ${n} ft`) + (s.past ? ` past ${s.past}` : ''));
      else parts.push((s.photo ? `about ${n} ft (measured on the photo)` : `straight across, ${n} ft`) + (s.past ? ` past ${s.past}` : ''));
    }
    return parts.length ? parts.join(', ') : 'right next to it';
  }

  /**
   * Cord routes bound to one project. A cord never crosses a wall face: it goes down to the ground, along the
   * ground and straight up, and no piece passes through the inside of a traced window or door.
   *
   * A located point ("loc") is one of
   *   {kind: 'wall', w, u, v}            on a calibrated wall (w = wallInfo), in wall feet;
   *   {kind: 'roof', w, u, v, roof}      on a roof plane: (u, v) is the eave point on the parent wall under it,
   *                                      roof = {slope, along, corner, eaveImg} the way up from there;
   *   {kind: 'ground', w}                on a ground plane (w = its parent wall, or null);
   *   {kind: 'none'}                     on no calibrated plane.
   * Routes are {ft, segs, path, door, walkway, plug}: ft = feet before routingFactor and slack (null when the
   * photo cannot size it), segs = [{kind, lengthFt, planeId, from, to}], path = image polyline.
   */
  function makeRouter(project, space, features, opt) {
    const planeList = (Array.isArray(project && project.planes) ? project.planes : []).filter(isObj);
    const planeById = new Map(planeList.map((p) => [p.id, p]));
    const margin = opt.openingMarginFt;
    const walls = new Map(), locs = new Map(), spans = new Map();
    const sumFt = (segs) => segs.reduce((s, x) => s + x.lengthFt, 0);
    const overlaps = (a0, a1, b0, b1) => a1 > b0 + SPAN_TOL_FT && a0 < b1 - SPAN_TOL_FT;
    const finite = (p) => isPt(p);

    /**
     * A wall for routing: {id, s, groundV, groundId, openings, doors}. groundV is the wall's ground level in
     * wall feet: the base line of a ground plane built on this wall, else the lowest of the wall rectangle's
     * bottom corners, every feature point on the wall, each outlet on it minus outletHeightFt, and the yard of
     * another wall on the same photo (placed in 3D when both walls have a camera pose). Openings are
     * the boxes of the traced windows and doors (a door's box reaches down to the ground).
     */
    function wallInfo(wallId) {
      if (walls.has(wallId)) return walls.get(wallId);
      let info = null;
      const s = space.sol(wallId);
      if (s && s.kind === 'wall') {
        let groundV = null, groundId = null;
        for (const pl of planeList) {
          if (pl.kind !== 'ground' || !isObj(pl.derived) || pl.derived.parentPlaneId !== wallId) continue;
          if (groundV === null) {
            const line = (Array.isArray(pl.derived.line) ? pl.derived.line : []).filter(isPt).map((p) => space.toPlane(s, p)).filter(finite);
            if (line.length >= 2) groundV = mean(line.map((p) => p[1]));
          }
          if (groundId === null && space.sol(pl.id)) groundId = pl.id;
        }
        if (groundV === null) {
          const vs = [];
          const push = (p, off) => { const uv = isPt(p) ? space.toPlane(s, p) : null; if (finite(uv)) vs.push(uv[1] - off); };
          const plane = planeById.get(wallId);
          const corners = plane && isObj(plane.rect) && Array.isArray(plane.rect.corners) ? plane.rect.corners : [];
          if (corners.length === 4) { push(corners[2], 0); push(corners[3], 0); }
          for (const f of features) if (f.planeId === wallId) for (const p of (Array.isArray(f.points) ? f.points : [])) push(p, 0);
          // Outlets on this wall, and outlets on the same photo that sit on no calibrated plane (taken to be on it).
          for (const o of opt.outlets) {
            const here = o.planeId === wallId || (!space.sol(o.planeId) && (!o.imageId || !plane || !plane.imageId || o.imageId === plane.imageId));
            if (here) push(o.point, opt.outletHeightFt);
          }
          // The yard traced from another wall of the same photo is this wall's ground too (needs both camera poses).
          for (const pl of planeList) {
            if (pl.kind !== 'ground' || !isObj(pl.derived) || !space.sol(pl.id) || (plane && pl.imageId && plane.imageId && pl.imageId !== plane.imageId)) continue;
            const q = (Array.isArray(pl.derived.line) ? pl.derived.line : []).find(isPt);
            const x = q ? space.toWallFrame(wallId, pl.id, q) : null;
            if (x && Number.isFinite(x[1])) vs.push(x[1]);
          }
          groundV = vs.length ? Math.min.apply(null, vs) : 0;
        }
        const openings = [];
        for (const f of features) {
          if ((f.type !== 'window' && f.type !== 'door') || f.planeId !== wallId) continue;
          const pts = (Array.isArray(f.points) ? f.points : []).filter(isPt).map((p) => space.toPlane(s, p)).filter(finite);
          if (pts.length < 2) continue;
          const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
          const box = { id: f.id, type: f.type, label: f.label || (f.type === 'door' ? 'the door' : 'the window'),
            u0: Math.min.apply(null, us), u1: Math.max.apply(null, us), v0: Math.min.apply(null, vs), v1: Math.max.apply(null, vs) };
          if (f.type === 'door') box.v0 = Math.min(box.v0, groundV);
          if (box.u1 - box.u0 > 2 * ROUTE_TOL_FT && box.v1 - box.v0 > 2 * ROUTE_TOL_FT) openings.push(box);
        }
        info = { id: wallId, s, groundV, groundId, openings, doors: openings.filter((b) => b.type === 'door') };
      }
      walls.set(wallId, info);
      return info;
    }

    /**
     * The opening a riser at u between heights va and vb would pass through (within the margin beside it), or
     * null. `m` (default: the opening margin) is how far beside an opening still counts; 0 tests the opening itself.
     */
    function riserBlock(w, u, va, vb, m) {
      const lo = Math.min(va, vb), hi = Math.max(va, vb);
      const pad = m === undefined ? margin : m;
      for (const b of w.openings) {
        if (u <= b.u0 - pad + 1e-9 || u >= b.u1 + pad - 1e-9) continue;
        if (Math.min(hi, b.v1) - Math.max(lo, b.v0) > ROUTE_TOL_FT) return b;
      }
      return null;
    }
    /** The opening whose inside the wall segment a→b (wall feet) passes through, or null. */
    function wallBlock(w, a, b) {
      for (const o of w.openings) {
        if (segHitsBox(a, b, o.u0 + ROUTE_TOL_FT, o.u1 - ROUTE_TOL_FT, o.v0 + ROUTE_TOL_FT, o.v1 - ROUTE_TOL_FT)) return o;
      }
      return null;
    }

    function locate(point, planeId, fixed) {
      if (!isPt(point)) return null;
      const key = point[0] + ',' + point[1] + '|' + (planeId || '') + (fixed ? '|fixed' : '');
      if (locs.has(key)) return locs.get(key);
      const img = [point[0], point[1]];
      const s = space.sol(planeId);
      let loc = { kind: 'none', img, planeId: s ? planeId : null };
      const uv = s ? space.toPlane(s, img) : null;
      if (finite(uv)) {
        const plane = planeById.get(planeId);
        const parentId = s.parentPlaneId || (plane && isObj(plane.derived) ? plane.derived.parentPlaneId : null);
        if (s.kind === 'wall') {
          const w = wallInfo(planeId);
          if (w) loc = { kind: 'wall', img, planeId, w, u: uv[0], v: uv[1], fixed: fixed === true };
        } else if (s.kind === 'roof') {
          loc = roofLoc(img, planeId, s, uv, plane, parentId) || loc;
        } else if (s.kind === 'ground') {
          loc = { kind: 'ground', img, planeId, w: parentId ? wallInfo(parentId) : null };
        }
      }
      locs.set(key, loc);
      return loc;
    }
    /**
     * A point on a roof plane: the eave point on the wall under it and the way up the slope from there. For an
     * upper roof (its parent is a roof face) the slope adds up over both roofs, down to the face's eave on the wall.
     */
    function roofLoc(img, planeId, s, uv, plane, parentId, depth) {
      // An upper roof starts at the top of a roof face (a mansard): a cord to it runs down this roof to that line,
      // then down the face below to its eave on the wall. The point where it meets the face is located on the face.
      const below = parentId ? space.sol(parentId) : null;
      if (below && below.kind === 'roof') {
        if ((depth || 0) >= 4 || !(s.frame && isV3(s.frame.origin) && isV3(s.frame.e1))) return null;
        const edge = space.toImage(s, [uv[0], 0]);
        const puv = finite(edge) ? space.toPlane(below, edge) : null;
        if (!finite(puv)) return null;
        const pplane = planeById.get(parentId);
        const grand = below.parentPlaneId || (pplane && isObj(pplane.derived) ? pplane.derived.parentPlaneId : null);
        const face = roofLoc(edge, parentId, below, puv, pplane, grand, (depth || 0) + 1);
        if (!face) return null;
        return { kind: 'roof', img, planeId, w: face.w, u: face.u, v: face.v,
          roof: { slope: Math.abs(uv[1]) + face.roof.slope, along: face.roof.along, corner: face.roof.corner, eaveImg: face.roof.eaveImg } };
      }
      const w = parentId ? wallInfo(parentId) : null;
      if (!w) return null;
      const line = (plane && isObj(plane.derived) && Array.isArray(plane.derived.line) ? plane.derived.line : [])
        .filter(isPt).map((p) => space.toPlane(w.s, p)).filter(finite);
      if (line.length < 2) return null;
      const uA = line[0][0], uB = line[line.length - 1][0], vE = mean(line.map((p) => p[1]));
      let u, slope, corner;
      const f = s.frame;
      if (f && isV3(f.origin) && isV3(f.e1)) {
        // Roof coordinates (a along the eave, b up the slope); the eave line lies in the wall plane.
        u = f.origin[0] + f.e1[0] * uv[0];
        slope = Math.abs(uv[1]);
        corner = space.toImage(s, [uv[0], 0]);
      } else {
        // No camera pose: the roof is measured in wall coordinates, heights above the eave are slope ÷ sin(pitch).
        u = uv[0];
        const sin = s.pitch && s.pitch.rise > 0 && s.pitch.run > 0 ? Math.sin(Math.atan2(s.pitch.rise, s.pitch.run)) : 1;
        slope = Math.abs(uv[1] - vE) / Math.max(sin, 0.2);
        corner = space.toImage(w.s, [u, vE]);
      }
      const uC = Math.min(Math.max(u, Math.min(uA, uB)), Math.max(uA, uB));
      const eaveImg = space.toImage(w.s, [uC, vE]);
      if (!finite(corner) || !finite(eaveImg) || !Number.isFinite(slope)) return null;
      return { kind: 'roof', img, planeId, w, u: uC, v: vE, roof: { slope, along: Math.abs(u - uC), corner, eaveImg } };
    }

    /**
     * Ways down the wall from (u, v) to the ground: [{segs, foot}] with segs ordered from the point down.
     * Within a foot of the ground no riser is needed. Otherwise the riser stands at the point's own u when
     * that passes no opening; if it would, it stands at the nearest clear u on each side (half a foot beside
     * the opening, or in the middle of a narrow gap between two openings) with a level hop at the point's
     * height. When every level hop would cross an opening (a row of windows that touch), the cord goes up
     * beside the row to above the openings in the way, across there, and down to the point.
     * `fixed` (an outlet: it is where it is) drops straight down unless the opening itself is under it; the
     * margin only applies to risers that are being placed.
     */
    function wallDescents(w, u, v, img, fixed) {
      const g = w.groundV, h = Math.abs(v - g);
      const at = (uu, vv, fallback) => { const q = space.toImage(w.s, [uu, vv]); return finite(q) ? q : fallback; };
      const make = (ur, beside) => {
        const segs = [];
        const hop = Math.abs(ur - u) > 0.01;
        const top = hop ? at(ur, v, img) : img;
        if (hop) segs.push({ kind: 'hop', lengthFt: Math.abs(ur - u), planeId: w.id, from: img, to: top });
        const foot = h > 0.01 ? at(ur, g, top) : top;
        if (h > 0.01) segs.push({ kind: 'vert', lengthFt: h, planeId: w.id, from: top, to: foot, beside: beside || null });
        return { segs, foot: { img: foot, planeId: w.id, wallId: w.id, u: ur } };
      };
      if (h <= NEAR_GROUND_FT + 1e-9 || v < g || !riserBlock(w, u, g, v, fixed ? 0 : undefined)) return [make(u, null)];
      // Where a riser may stand: half a foot beside each opening, and the middle of a gap between two openings
      // that is too narrow for that (the cord runs up the trim between two windows).
      const spots = [];
      for (const b of w.openings) {
        for (const e of [b.u0 - margin, b.u1 + margin]) spots.push({ e, b, pad: undefined });
        for (const c of w.openings) {
          const gap = c.u0 - b.u1;
          if (c !== b && gap > 2 * ROUTE_TOL_FT && gap < 2 * margin - 1e-9) spots.push({ e: b.u1 + gap / 2, b, pad: 0 });
        }
      }
      let left = null, right = null;
      for (const sp of spots) {
        if (riserBlock(w, sp.e, g, v, sp.pad) || wallBlock(w, [sp.e, v], [u, v])) continue;
        if (sp.e < u && (!left || sp.e > left.e)) left = sp;
        if (sp.e > u && (!right || sp.e < right.e)) right = sp;
      }
      const out = [];
      if (left) out.push(make(left.e, left.b.label));
      if (right) out.push(make(right.e, right.b.label));
      if (out.length) return out;
      // No level hop is clear: up beside the row to above what is in the way, across there, and down to the point.
      const over = (sp) => {
        let top = v;
        for (let guard = 0; guard <= w.openings.length; guard++) {
          const hit = wallBlock(w, [sp.e, top], [u, top]);
          if (!hit) break;
          top = hit.v1 + margin;
        }
        if (!(top > v + 1e-9) || wallBlock(w, [sp.e, top], [u, top]) || riserBlock(w, sp.e, g, top, sp.pad) || wallBlock(w, [u, top], [u, v])) return null;
        const corner = at(u, top, img), head = at(sp.e, top, corner), foot = at(sp.e, g, head);
        return {
          segs: [
            { kind: 'vert', back: true, lengthFt: top - v, planeId: w.id, from: img, to: corner },
            { kind: 'hop', lengthFt: Math.abs(sp.e - u), planeId: w.id, from: corner, to: head },
            { kind: 'vert', lengthFt: Math.abs(top - g), planeId: w.id, from: head, to: foot, beside: sp.b.label },
          ],
          foot: { img: foot, planeId: w.id, wallId: w.id, u: sp.e },
        };
      };
      let overL = null, overR = null;
      for (const sp of spots) {
        if (sp.e < u && (!overL || sp.e > overL.e)) { const r = over(sp); if (r) overL = { e: sp.e, r }; }
        if (sp.e > u && (!overR || sp.e < overR.e)) { const r = over(sp); if (r) overR = { e: sp.e, r }; }
      }
      if (overL) out.push(overL.r);
      if (overR) out.push(overR.r);
      if (out.length) return out;
      // Last resort (openings that overlap in a way no route clears): the nearest clear riser, or the point's own u.
      for (const sp of spots) {
        if (riserBlock(w, sp.e, g, v, sp.pad)) continue;
        if (sp.e < u && (!left || sp.e > left.e)) left = sp;
        if (sp.e > u && (!right || sp.e < right.e)) right = sp;
      }
      if (left) out.push(make(left.e, left.b.label));
      if (right) out.push(make(right.e, right.b.label));
      return out.length ? out : [make(u, null)];
    }
    function descents(loc) {
      if (loc.desc) return loc.desc;
      let out;
      if (loc.kind === 'wall') out = wallDescents(loc.w, loc.u, loc.v, loc.img, loc.fixed === true);
      else if (loc.kind === 'roof') {
        const pre = [];
        if (loc.roof.slope > ROUTE_TOL_FT) pre.push({ kind: 'roof', part: 'slope', lengthFt: loc.roof.slope, planeId: loc.planeId, from: loc.img, to: loc.roof.corner });
        if (loc.roof.along > ROUTE_TOL_FT) pre.push({ kind: 'roof', part: 'eave', lengthFt: loc.roof.along, planeId: loc.planeId, from: loc.roof.corner, to: loc.roof.eaveImg });
        out = wallDescents(loc.w, loc.u, loc.v, loc.roof.eaveImg).map((d) => ({ segs: pre.concat(d.segs), foot: d.foot }));
      } else {
        out = [{ segs: [], foot: { img: loc.img, planeId: loc.planeId, wallId: null, near: loc.kind === 'ground' ? loc.w : null, none: loc.kind === 'none' } }];
      }
      loc.desc = out;
      return out;
    }

    /** Feet along the ground between two foot points: {lengthFt, planeId} or null when the photo has no scale there. */
    function groundSeg(fa, fb) {
      if (fa.wallId && fa.wallId === fb.wallId) return { lengthFt: Math.abs(fa.u - fb.u), planeId: fa.wallId };
      const unlocated = fa.none || fb.none;
      const ref = (f) => {
        const w = f.wallId ? wallInfo(f.wallId) : null;
        // A wall foot is measured on that wall's ground plane when it has one (same plane as yard items).
        return { point: f.img, planeId: w ? (w.groundId && !unlocated ? w.groundId : w.id) : f.planeId };
      };
      const ra = ref(fa), rb = ref(fb);
      const d = space.feetBetween(ra, rb);
      if (d === null || !Number.isFinite(d)) return null;
      return { lengthFt: unlocated ? d * CROSS_PLANE_FACTOR : d, planeId: ra.planeId && ra.planeId === rb.planeId ? ra.planeId : null };
    }
    /** [u along wall w, distance out from it] of a foot point, or null when it cannot be placed. */
    function alongWall(w, foot) {
      if (foot.wallId === w.id) return [foot.u, 0];
      const planeId = foot.wallId || foot.planeId;
      if (!planeId) return null;
      const x = space.toWallFrame(w.id, planeId, foot.img);
      return x && x.every(Number.isFinite) ? [x[0], Math.abs(x[2])] : null;
    }
    /**
     * What a ground segment passes: a traced door (its label) when the segment runs past the door's span within
     * 3 ft of that wall, and a walkway that meets the wall there. `own` features never count.
     */
    function groundCrossings(fa, fb, own, imageId) {
      const res = { door: null, walkway: false };
      const ids = [];
      for (const f of [fa, fb]) { const id = f.wallId || (f.near ? f.near.id : null); if (id && !ids.includes(id)) ids.push(id); }
      for (const id of ids) {
        const w = wallInfo(id);
        if (!w) continue;
        const pa = alongWall(w, fa), pb = alongWall(w, fb);
        if (!pa || !pb) continue;
        // The part of the segment within WALKWAY_NEAR_WALL_FT of the wall.
        let t0 = 0, t1 = 1;
        const dd = pb[1] - pa[1];
        if (pa[1] > WALKWAY_NEAR_WALL_FT && pb[1] > WALKWAY_NEAR_WALL_FT) continue;
        if (pa[1] > WALKWAY_NEAR_WALL_FT) t0 = (WALKWAY_NEAR_WALL_FT - pa[1]) / dd;
        if (pb[1] > WALKWAY_NEAR_WALL_FT) t1 = (WALKWAY_NEAR_WALL_FT - pa[1]) / dd;
        const ua = pa[0] + (pb[0] - pa[0]) * t0, ub = pa[0] + (pb[0] - pa[0]) * t1;
        const lo = Math.min(ua, ub), hi = Math.max(ua, ub);
        if (hi - lo < 2 * SPAN_TOL_FT) continue;
        if (!res.door) {
          const d = w.doors.find((b) => !own.has(b.id) && overlaps(lo, hi, b.u0, b.u1));
          if (d) res.door = d.label;
        }
        if (!res.walkway) {
          // Where walkway edges meet this wall. Two edges that meet it within WALKWAY_MAX_WIDTH_FT of each other are
          // the two sides of one walkway: the cord crosses it when it lies across more than WALKWAY_EDGE_FT of its
          // width (a cord that stops at the door jamb a foot inside the edge is not in anyone's way). An edge with
          // no partner counts as before: the cord passes the spot where it meets the wall.
          const met = [];
          for (const wf of opt.walkways) {
            if (own.has(wf.id) || (wf.imageId && imageId && wf.imageId !== imageId)) continue;
            const k = id + '|' + wf.id;
            if (!spans.has(k)) spans.set(k, space.walkwaySpanAtWall(id, wf, WALKWAY_NEAR_WALL_FT));
            if (spans.get(k)) met.push(spans.get(k));
            // A walkway that cannot be placed against this wall (its ground is not calibrated) is judged on the photo.
            else if (lineCrosses(fa.img, fb.img, wf)) res.walkway = true;
          }
          met.sort((a, b) => a[0] - b[0]);
          for (let i = 0; i < met.length && !res.walkway; i++) {
            const next = met[i + 1];
            if (next && next[0] - met[i][1] <= WALKWAY_MAX_WIDTH_FT) {
              const across = Math.min(hi, next[1]) - Math.max(lo, met[i][0]);
              res.walkway = across > WALKWAY_EDGE_FT;
              i += 1;
            } else res.walkway = overlaps(lo, hi, met[i][0], met[i][1]);
          }
        }
      }
      return res;
    }

    function finish(A, B, segs, extra) {
      const path = [A.img];
      const add = (p) => { const q = path[path.length - 1]; if (finite(p) && Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) path.push([p[0], p[1]]); };
      for (const s of segs) { add(s.from); add(s.to); }
      add(B.img);
      if (path.length < 2) path.push([B.img[0], B.img[1]]);
      return Object.assign({ ft: sumFt(segs), segs, path, door: null, walkway: false, plug: false }, extra || {});
    }
    /** Down from A (riser rules), along the ground, up to B (riser rules): the cheapest of the riser choices. */
    function viaGround(A, B, own, imageId) {
      let best = null;
      for (const da of descents(A)) {
        for (const db of descents(B)) {
          const gs = groundSeg(da.foot, db.foot);
          if (!gs) continue;
          const cr = groundCrossings(da.foot, db.foot, own, imageId);
          const ft = sumFt(da.segs) + gs.lengthFt + sumFt(db.segs);
          const score = ft + ((cr.door ? 1 : 0) + (cr.walkway ? 1 : 0)) * opt.penaltyFt;
          if (!best || score < best.score - 1e-9) best = { da, db, gs, cr, score };
        }
      }
      if (!best) return null;
      const segs = [];
      // A 'vert' piece runs from the point toward the ground; one marked `back` runs the other way first (over the top of a row of openings).
      for (const s of best.da.segs) segs.push(Object.assign({}, s, s.kind === 'vert' ? { kind: s.back ? 'rise' : 'drop' } : { dir: 'down' }));
      if (best.gs.lengthFt > 0.01) {
        segs.push({ kind: 'ground', lengthFt: best.gs.lengthFt, planeId: best.gs.planeId, from: best.da.foot.img, to: best.db.foot.img,
          past: best.cr.door, photo: !!(best.da.foot.none || best.db.foot.none) });
      }
      for (let i = best.db.segs.length - 1; i >= 0; i--) {
        const s = best.db.segs[i];
        segs.push(Object.assign({}, s, { from: s.to, to: s.from }, s.kind === 'vert' ? { kind: s.back ? 'drop' : 'rise' } : { dir: 'up' }));
      }
      return finish(A, B, segs, { door: best.cr.door, walkway: best.cr.walkway, score: best.score });
    }

    /** Home run outlet → feed start. ft is null (with a straight path to draw) when the photo cannot size it. */
    function home(A, B, own, imageId) {
      return viaGround(A, B, own, imageId) || { ft: null, segs: [], path: [A.img.slice(), B.img.slice()], door: null, walkway: false, plug: false };
    }

    /** A hop that stays within a foot of the ground still lies in front of any door or walkway between its ends. */
    function lowHop(A, B, route, own, imageId) {
      const low = (loc) => loc.kind === 'ground' || (loc.kind === 'wall' && Math.abs(loc.v - loc.w.groundV) <= NEAR_GROUND_FT + 1e-9);
      if (!low(A) || !low(B)) return route;
      const cr = groundCrossings(descents(A)[0].foot, descents(B)[0].foot, own, imageId);
      route.door = cr.door;
      route.walkway = cr.walkway;
      route.score = route.ft + ((cr.door ? 1 : 0) + (cr.walkway ? 1 : 0)) * opt.penaltyFt;
      if (cr.door) for (const s of route.segs) s.past = cr.door;
      return route;
    }
    /**
     * Jumper from a powered run's plug (A) to the start of another run (B): the shortest valid of a straight
     * hop (corner to corner, within jumperDirectFt), a path along the wall (straight up or down any height,
     * across at most jumperDirectFt of open wall), and down - along the ground - up. Plugs within PLUG_REACH_FT
     * of each other need no cord. null when nothing can be measured.
     */
    function jumper(A, B, own, imageId) {
      const d = space.feetBetween({ point: A.img, planeId: A.planeId }, { point: B.img, planeId: B.planeId });
      if (d !== null && d <= PLUG_REACH_FT + 1e-9) return { ft: d, segs: [], path: [A.img.slice(), B.img.slice()], door: null, walkway: false, plug: true };
      const options = [];
      const sameWall = A.kind === 'wall' && B.kind === 'wall' && A.w.id === B.w.id;
      if (sameWall) {
        const w = A.w, a = [A.u, A.v], b = [B.u, B.v];
        const du = Math.abs(a[0] - b[0]), dv = Math.abs(a[1] - b[1]);
        const leg = (p, q, from, to) => ({ kind: 'wall', lengthFt: Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]), planeId: w.id, from, to,
          dir: Math.abs(p[0] - q[0]) > Math.abs(p[1] - q[1]) ? 'across' : (q[1] > p[1] ? 'up' : 'down') });
        if (du <= opt.jumperDirectFt + 1e-9) {
          if (du <= 0.01 || dv <= 0.01) {
            if (!wallBlock(w, a, b) && !(du <= 0.01 && riserBlock(w, a[0], a[1], b[1]))) options.push(lowHop(A, B, finish(A, B, [leg(a, b, A.img, B.img)]), own, imageId));
          } else {
            if (d !== null && d <= opt.jumperDirectFt + 1e-9 && !wallBlock(w, a, b)) {
              options.push(lowHop(A, B, finish(A, B, [{ kind: 'direct', lengthFt: d, planeId: w.id, from: A.img, to: B.img }]), own, imageId));
            }
            // An L: across at the higher of the two heights first (along the eave or the top of a window, then
            // down), else across at the lower. The upright leg follows the riser rule: beside openings, not up
            // their edge.
            const hi = Math.max(a[1], b[1]), lo = Math.min(a[1], b[1]);
            for (const vAcross of [hi, lo]) {
              const c = vAcross === a[1] ? [b[0], a[1]] : [a[0], b[1]];
              const ci = space.toImage(w.s, c);
              const upright = c[0] === a[0] ? [a, c] : [c, b];
              if (!finite(ci) || wallBlock(w, a, c) || wallBlock(w, c, b) || riserBlock(w, c[0], upright[0][1], upright[1][1])) continue;
              options.push(finish(A, B, [leg(a, c, A.img, ci), leg(c, b, ci, B.img)]));
              break;
            }
          }
        }
      } else if (d !== null && d <= opt.jumperDirectFt + 1e-9) {
        options.push(lowHop(A, B, finish(A, B, [{ kind: 'direct', lengthFt: d, planeId: A.planeId && A.planeId === B.planeId ? A.planeId : null, from: A.img, to: B.img,
          photo: A.kind === 'none' || B.kind === 'none' }]), own, imageId));
      }
      const vg = viaGround(A, B, own, imageId);
      if (vg) options.push(vg);
      let best = null;
      for (const o of options) {
        const score = o.score !== undefined ? o.score : o.ft;
        if (!best || score < best.score - 1e-9) best = { o, score };
      }
      return best ? best.o : null;
    }

    return { wallInfo, locate, home, jumper };
  }

  // ---------------------------------------------------------------- main
  function planPower(project, measured, runs, library) {
    const lib = library && Array.isArray(library.products) && isObj(library.config) ? library : catalog.getLibrary(project);
    const cfg = powerConfig(lib);
    const V = pos(cfg.voltage) || 120;
    const cf = continuousFactorOf(cfg.continuousFactor);
    const factor = cf.factor;
    const gapFt = Number.isFinite(cfg.chainGapFt) && cfg.chainGapFt >= 0 ? cfg.chainGapFt : 3;
    const routingFactor = pos(cfg.routingFactor) || 1;
    const slackFt = Number.isFinite(cfg.cordSlackFt) && cfg.cordSlackFt >= 0 ? cfg.cordSlackFt : 0;
    // Power stakes hang off the outlet's one timer socket and are chained: each extra stake takes one socket of
    // the stake before it, so n stakes of k sockets give n·(k − 1) + 1 sockets.
    const splitterOutlets = Math.max(2, Math.round(pos(cfg.splitterOutlets) || 3));
    const stakesFor = (cords) => (cords > 1 ? Math.ceil((cords - 1) / (splitterOutlets - 1)) : 0);
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
    // Every cord at an outlet goes through one receptacle, one timer and the power stakes: 15 A plug-in gear.
    const plugAmps = pos(cfg.plugAmps) || DEFAULT_PLUG_AMPS;
    const outletLimit = (o) => limitW(plugAmps, outletVoltage(o), factor);
    const socketKey = (o) => 'socket:' + o.id;
    const addLoad = (map, o, w) => {
      map.set(circuitKey(o), (map.get(circuitKey(o)) || 0) + w);
      map.set(socketKey(o), (map.get(socketKey(o)) || 0) + w);
    };

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
      // Strings laid along a measured length: only the strings that cover the length are hung (and loaded);
      // the rest of what is bought (waste rounding) are spares. Cut-to-length socket wire (kind 'bulk') is the
      // same by the foot: the true length is cut, hung and lit, and the waste allowance stays on the spool.
      // Other products (bush counts, nets, path sets, per-foot track) hang every unit.
      const len = pos(product && product.stringLengthFt);
      const L = Number.isFinite(run.lengthFt) ? run.lengthFt : 0;
      const LW = Number.isFinite(run.withWasteFt) ? run.withWasteFt : L;
      const cutWire = !!product && product.kind === 'bulk' && run.unit === 'foot' && run.method === 'per-foot';
      const lengthBased = !!len && L > 0 && LW >= L - 1e-9 && Math.ceil(LW / len - 1e-9) === run.quantity &&
        (cutWire || (run.unit === 'string' && (run.method === 'linear' || run.method === 'spiral')));
      items.push({
        idx, run, feature, shape, product,
        planeId: feature.planeId || run.planeId || null,
        imageId: feature.imageId || run.imageId || null,
        forcedReverse: params.reverse === true && shape.kind === 'open',
        forcedOutlet,
        ownCord: params.ownCord === true,
        wattsPerUnit: Math.max(0, Number.isFinite(run.watts) ? run.watts : 0) / run.quantity,
        incandescent: (run.tech || (product && product.tech)) === 'incandescent',
        len: lengthBased ? len : null, L, LW,
        // Cut wire is counted run by run (each run buys its own whole feet), not pooled along the chain like strings.
        solo: lengthBased && cutWire,
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

    /**
     * The two possible walks of a component (start from each free end). A step is {k, reversed, from, to}:
     * the run is entered at its first point (or its last when reversed) and covers [from, to] feet along that
     * traversal (the whole run here; split walks cover part of one run).
     */
    function walks(memberIdx) {
      const sorted = memberIdx.slice().sort((x, y) => x - y);
      const free = [];
      for (const m of sorted) for (const port of [0, 1]) if (!nbr[m][port]) free.push({ m, port });
      return free.slice(0, 2).map((f) => {
        const steps = [];
        let cur = f.m, entry = f.port;
        while (cur !== null && steps.length <= sorted.length) {
          steps.push({ k: cur, reversed: entry === 1, from: 0, to: items[cur].L });
          const next = nbr[cur][1 - entry];
          if (!next) break;
          cur = next.j; entry = next.b;
        }
        return steps;
      });
    }

    /**
     * Where the strings go along a walk. Strings on a length-based run are laid end to end from where the
     * walk enters it: `hung` strings start inside the step (the first `firstFt` feet in), `bought` is the
     * step's share of what is bought (with waste). Other runs hang all their units. Returns new step objects.
     */
    function layout(steps) {
      const out = steps.map((st) => Object.assign({}, st));
      for (let i = 0; i < out.length;) {
        const it = items[out[i].k];
        if (!it.len) {
          Object.assign(out[i], { hung: it.run.quantity, bought: it.run.quantity, firstFt: 0 });
          i += 1;
          continue;
        }
        const j = poolEnd(out, i);
        placeStrings(out, i, j, it.len);
        i = j;
      }
      return out;
    }
    /**
     * End (exclusive) of the group of steps whose strings run on continuously from step i: consecutive
     * length-based runs of the same string in the same colors (a string carries on around a corner, but a
     * warm-white string cannot become a multicolor one).
     */
    function poolEnd(out, i) {
      const a = items[out[i].k];
      let j = i + 1;
      if (a.solo) return j;
      while (j < out.length) {
        const b = items[out[j].k];
        if (!b.len || b.solo || b.len !== a.len || colorKey(b.run) !== colorKey(a.run)) break;
        j += 1;
      }
      return j;
    }
    function colorKey(run) {
      return String(run.colorMode || '') + '|' + (Array.isArray(run.colors) ? run.colors.join(',') : '');
    }
    /** Lay strings of length len end to end over steps [i, j): hung over the true length, bought over the length with waste. */
    function placeStrings(out, i, j, len) {
      const segs = [];
      let T = 0, S = 0;
      for (let m = i; m < j; m++) {
        const it = items[out[m].k];
        const Lp = Math.max(0, out[m].to - out[m].from);
        const LWp = it.L > 0 ? it.LW * (Lp / it.L) : 0;
        segs.push({ m, T, S, Lp, LWp });
        T += Lp; S += LWp;
      }
      const hungT = T > 1e-9 ? Math.ceil(T / len - 1e-9) : 0;
      const boughtT = Math.max(hungT, S > 1e-9 ? Math.ceil(S / len - 1e-9) : 0);
      if (j - i > 1) {
        const note = { labels: segs.map((g) => items[out[g.m].k].run.label), withWasteFt: S, strings: boughtT, len };
        for (const g of segs) out[g.m].pool = note;
      }
      const count = (start, length, total, last) => {
        let n = 0, first = null;
        for (let q = 0; q < total; q++) {
          const x = q * len;
          if (x >= start - 1e-6 && (last || x < start + length - 1e-6)) { n += 1; if (first === null) first = x - start; }
        }
        return { n, first };
      };
      // Each step buys the strings hung on it; the spares (waste rounding) go with the last step that hangs one.
      let lastHung = null;
      segs.forEach((g, gi) => {
        const h = count(g.T, g.Lp, hungT, gi === segs.length - 1);
        Object.assign(out[g.m], { hung: h.n, bought: h.n, firstFt: h.first === null ? null : Math.max(0, h.first) });
        if (h.n > 0) lastHung = g.m;
      });
      if (lastHung !== null) out[lastHung].bought += boughtT - hungT;
    }

    /**
     * Spares bought for waste do not depend on where the strings hang: over walks that feed one chain from the
     * middle, buy max(hung, ceil(length with waste / string length)) strings per string and color, with the
     * spares on the last step that hangs one (not a separate rounding on each side).
     */
    function settleSpares(placedWalks) {
      const groups = new Map();
      for (const pl of placedWalks) {
        for (const ps of pl) {
          const it = items[ps.k];
          if (!it.len) continue;
          const key = it.solo ? 'run|' + ps.k : it.len + '|' + colorKey(it.run);
          const g = groups.get(key) || { len: it.len, hung: 0, withWaste: 0, steps: [] };
          const Lp = Math.max(0, ps.to - ps.from);
          g.hung += ps.hung;
          g.withWaste += it.L > 0 ? it.LW * (Lp / it.L) : 0;
          g.steps.push(ps);
          groups.set(key, g);
        }
      }
      for (const g of groups.values()) {
        const bought = Math.max(g.hung, g.withWaste > 1e-9 ? Math.ceil(g.withWaste / g.len - 1e-9) : 0);
        let lastHung = null;
        for (const ps of g.steps) { ps.bought = ps.hung; if (ps.hung > 0) lastHung = ps; }
        if (lastHung) lastHung.bought += bought - g.hung;
      }
    }

    // ---- 2. feeds for one walk: fill each feed up to maxEndToEnd hung units, splitting between runs, and
    // splitting a run along its length only when that run alone is longer than the limit. A mid-run feed
    // starts where the strings already hung end (string length along the run, not a share of the count).
    function buildFeeds(placed) {
      const feeds = [];
      let cur = null;
      const product = items[placed[0].k].product;
      const maxE = pos(product && product.maxEndToEnd) || Infinity;
      // The most watts this product's wiring may carry end to end: its own strings plus whatever is plugged into them.
      const maxConnW = pos(product && product.maxConnectedW) ||
        (pos(product && product.maxEndToEnd) && pos(product.wattsPerUnit) ? product.maxEndToEnd * product.wattsPerUnit : Infinity);
      const endConnector = !(product && (product.endConnector === false || (product.endConnector == null && product.unit === 'foot')));
      const open = (ps, offset) => {
        const it = items[ps.k];
        const path = traversal(it.shape, ps.reversed);
        const Lr = it.L;
        let frac;
        if (it.len && Lr > 0) frac = Math.min(ps.to, ps.from + (ps.firstFt || 0) + offset * it.len) / Lr;
        else frac = it.run.quantity > 0 ? offset / it.run.quantity : 0;
        let point, label, toward = null;
        if (frac <= 1e-9) {
          point = path[0].slice();
          label = portLabel(it.shape, path, it.run.label);
        } else {
          point = pointAlong(path, frac, space.sol(it.planeId), space);
          // Mid-run feed start: say how far along the run it is, from the end the run starts at.
          const pct = Math.round(frac * 100);
          if (it.shape.kind === 'vertical') label = `point ${pct}% of the way up ${it.run.label}`;
          else if (Lr > 0) label = `point ${fmtInt(frac * Lr)} ft from the ${portLabel(it.shape, path, it.run.label)}`;
          else label = `point ${pct}% of the way along ${it.run.label}`;
          if (it.shape.kind === 'open' && path.length >= 2) toward = portLabel(it.shape, path.slice().reverse(), it.run.label);
        }
        cur = { portions: [], units: 0, watts: 0, start: { point, imageId: it.imageId, planeId: it.planeId, label }, first: ps, last: ps, mid: frac > 1e-9 };
        if (toward) cur.start.toward = toward;
        feeds.push(cur);
      };
      const add = (ps, units) => {
        const it = items[ps.k];
        cur.last = ps;
        cur.portions.push({ k: ps.k, units });
        cur.units += units;
        cur.watts += units * it.wattsPerUnit;
      };
      for (const ps of placed) {
        const u = ps.hung;
        if (!(u > 0)) {
          // Covered by the string that runs on from the previous run.
          if (!cur) open(ps, 0);
          add(ps, 0);
          continue;
        }
        if (u <= maxE) {
          if (!cur || cur.units + u > maxE) open(ps, 0);
          add(ps, u);
          continue;
        }
        // This run alone exceeds the limit: top up the current feed, then start new feeds along it.
        let offset = 0;
        while (u - offset > 1e-9) {
          if (!cur || cur.units >= maxE - 1e-9) open(ps, offset);
          const take = Math.min(maxE - cur.units, u - offset);
          add(ps, take);
          offset += take;
        }
      }
      for (const f of feeds) {
        f.runIds = [];
        for (const p of f.portions) { const id = items[p.k].run.id; if (!f.runIds.includes(id)) f.runIds.push(id); }
        f.forcedOutlet = null;
        for (const p of f.portions) if (items[p.k].forcedOutlet) { f.forcedOutlet = items[p.k].forcedOutlet; break; }
        f.incandescent = f.portions.some((p) => items[p.k].incandescent);
        f.ownCord = f.portions.some((p) => items[p.k].ownCord);
        f.featureIds = new Set(f.portions.map((p) => items[p.k].feature.id));
        f.firstFeature = items[f.portions[0].k].feature;
        f.lastFeature = items[f.portions[f.portions.length - 1].k].feature;
        f.watts = round(f.watts, 2);
        f.units = round(f.units, 4);
        f.maxConnW = maxConnW;
      }
      // Where each feed's last string ends: the plug a jumper to another run can use. A feed cut mid-run ends
      // where the next one starts; otherwise it ends where its last run does (a loop ends where it began, a wrap
      // at its top). Products without an end connector (per-foot track) and wraps that are not on a wall
      // (a tree in the yard: its top is not a point of the ground plane) offer no end plug.
      feeds.forEach((f, i) => {
        const next = feeds[i + 1];
        const it = items[f.last.k];
        const path = traversal(it.shape, f.last.reversed);
        const point = next && next.mid && next.first === f.last ? next.start.point.slice() : path[path.length - 1].slice();
        const sol = space.sol(it.planeId);
        const reachable = it.shape.kind !== 'vertical' || (!!sol && sol.kind === 'wall');
        f.endPort = endConnector && reachable ? { point, imageId: it.imageId, planeId: it.planeId } : null;
      });
      return { feeds, maxE };
    }

    // ---- cord routes and what each candidate costs (SPEC §8.1)
    const nonNeg = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
    const daisy = cfg.daisyChain !== false;
    const jumperMaxFt = nonNeg(cfg.jumperMaxFt, 30);
    const jumperSlackFt = nonNeg(cfg.jumperSlackFt, 1.5);
    const penaltyFt = nonNeg(cfg.crossingPenaltyFt, 12);
    const tapOutlets = Math.max(2, Math.round(pos(cfg.tapOutlets) || 3));
    const walkways = features.filter((f) => f.type === 'walkway' && Array.isArray(f.points) && f.points.filter(isPt).length >= 2);
    const router = makeRouter(project, space, features, {
      outlets, walkways, penaltyFt,
      outletHeightFt: nonNeg(cfg.outletHeightFt, 1.5), openingMarginFt: nonNeg(cfg.openingMarginFt, 0.5),
      jumperDirectFt: nonNeg(cfg.jumperDirectFt, 6),
    });
    /** Does the image path cross a walkway traced on the same photo (other than the feed's own)? */
    function pathCrossesWalkway(path, own, imageId) {
      if (path.length < 2) return false;
      return walkways.some((w) => {
        if (own.has(w.id) || (w.imageId && imageId && w.imageId !== imageId)) return false;
        for (let j = 1; j < path.length; j++) if (lineCrosses(path[j - 1], path[j], w)) return true;
        return false;
      });
    }
    /**
     * Does a routed cord cross a walkway line on the photo? Only the pieces that lie on the ground away from a
     * wall are tested (and straight hops): a piece along the base of one wall is judged by where walkways meet
     * that wall (groundCrossings), and a piece up the wall cannot cross a walkway at all.
     */
    function routeCrossesWalkway(r, own, imageId) {
      if (!r.segs.length) return pathCrossesWalkway(r.path, own, imageId);
      return r.segs.some((sg) => {
        const onWall = sg.planeId && space.sol(sg.planeId) && space.sol(sg.planeId).kind === 'wall';
        if (sg.kind !== 'direct' && !(sg.kind === 'ground' && !onWall)) return false;
        return isPt(sg.from) && isPt(sg.to) && pathCrossesWalkway([sg.from, sg.to], own, imageId);
      });
    }
    /** A cord from outlet o to the start of `feed`: {kind:'home', outlet, route, lengthFt|null, cost, door, walkway}. */
    function homeCandidate(feed, o) {
      let r = { ft: null, segs: [], path: [], door: null, walkway: false, plug: false };
      // Pixels on two different photos are not comparable: no distance and nothing to draw.
      const samePhoto = !(o.imageId && feed.start.imageId && o.imageId !== feed.start.imageId);
      if (isPt(o.point) && samePhoto) {
        // The outlet is where it is: its cord drops straight down, even half a foot from a door frame.
        const A = router.locate(o.point, o.planeId, true), B = router.locate(feed.start.point, feed.start.planeId);
        if (A && B) r = router.home(A, B, feed.featureIds, feed.start.imageId);
      }
      const lengthFt = r.ft === null ? null : r.ft * routingFactor + slackFt;
      const walkway = lengthFt !== null && (r.walkway || routeCrossesWalkway(r, feed.featureIds, feed.start.imageId));
      const crossings = (r.door ? 1 : 0) + (walkway ? 1 : 0);
      return { kind: 'home', outlet: o, node: null, port: null, route: r, lengthFt, plug: false, srcId: o.id,
        cost: lengthFt === null ? Infinity : lengthFt + crossings * penaltyFt, door: r.door, walkway };
    }
    /** Home-run candidates of a feed: its forced outlet, else every located outlet on its photo. */
    function homeCandidates(feed) {
      if (feed.homes) return feed.homes;
      const list = [];
      if (feed.forcedOutlet) list.push(homeCandidate(feed, outletById.get(feed.forcedOutlet)));
      else {
        for (const o of outlets) {
          if (!isPt(o.point) || (o.imageId && feed.start.imageId && o.imageId !== feed.start.imageId)) continue;
          list.push(homeCandidate(feed, o));
        }
      }
      feed.homes = list;
      return list;
    }
    /** Cord cost of the cheapest home run to `feed` (penalties included); Infinity without an outlet or a scale. */
    const soloCost = (feed) => homeCandidates(feed).reduce((best, c) => Math.min(best, c.cost), Infinity);
    /**
     * A jumper from a powered feed (`node`) to the start of `feed`, plugged into the end of the node's last
     * string (port 'end') or into a tap where the node's own cord arrives (port 'start'); null when it cannot
     * be routed or is longer than jumperMaxFt.
     */
    function jumperCandidate(feed, node, port) {
      const src = port === 'end' ? node.feed.endPort : node.feed.start;
      if (!src || !isPt(src.point)) return null;
      if (src.imageId && feed.start.imageId && src.imageId !== feed.start.imageId) return null;
      const straight = space.feetBetween(src, feed.start);
      if (straight === null || straight * routingFactor + jumperSlackFt > jumperMaxFt + 1e-9) return null;
      const A = router.locate(src.point, src.planeId), B = router.locate(feed.start.point, feed.start.planeId);
      if (!A || !B) return null;
      const own = new Set(feed.featureIds);
      for (const id of node.feed.featureIds) own.add(id);
      const r = router.jumper(A, B, own, feed.start.imageId);
      if (!r || r.ft === null) return null;
      const lengthFt = r.plug ? 0 : r.ft * routingFactor + jumperSlackFt;
      if (lengthFt > jumperMaxFt + 1e-9) return null;
      // A cord from one walkway edge to another lies across the walkway between them.
      const from = port === 'end' ? node.feed.lastFeature : node.feed.firstFeature;
      const between = !!from && from.type === 'walkway' && feed.firstFeature.type === 'walkway' && from.id !== feed.firstFeature.id;
      const walkway = !r.plug && (r.walkway || between || routeCrossesWalkway(r, own, feed.start.imageId));
      const crossings = (r.door && !r.plug ? 1 : 0) + (walkway ? 1 : 0);
      return { kind: 'jumper', outlet: null, node, port, route: r, lengthFt, plug: !!r.plug, srcId: node.feed.id,
        cost: lengthFt + crossings * penaltyFt, door: r.plug ? null : r.door, walkway };
    }

    // ---- 3. chains: every way a chain can be walked (from either end, or outward from the point nearest an
    // outlet) with the feeds each needs. The supply planner below picks one per chain.
    const comps = [];
    for (let c = 0; c < items.length; c++) if (members[c].length) comps.push(members[c].slice().sort((x, y) => x - y));
    comps.sort((x, y) => x[0] - y[0]);
    /** Feeds and stand-alone cord totals for an option made of one or more walks (each walk is fed from its first step). */
    function evaluate(opt, key) {
      opt.placed = opt.walks.map(layout);
      if (opt.placed.length > 1) settleSpares(opt.placed);
      opt.feeds = [];
      opt.placed.forEach((pl, wi) => {
        const built = buildFeeds(pl);
        opt.maxE = built.maxE;
        built.feeds.forEach((f, i) => { f.walk = wi; f.firstOfWalk = i === 0; opt.feeds.push(f); });
      });
      opt.feeds.forEach((f, fi) => { f.id = 'feed_' + key + '_' + (fi + 1); });
      opt.firstCord = soloCost(opt.feeds[0]);
      // With daisy chains the second walk of a split plugs into a tap on the first walk's cord: no cord of its own.
      // A run with "its own cord" keeps that cord: both halves hang off the tap where it arrives.
      const tapped = (f) => daisy && !!opt.split && f.firstOfWalk && f.walk > 0 && !f.forcedOutlet;
      opt.totalCord = 0;
      // Rough dollars (strings bought, 16 AWG cords, taps) so a split is never chosen when it costs more than it saves.
      const product = items[opt.walks[0][0].k].product;
      opt.dollars = opt.placed.reduce((s, pl) => s + pl.reduce((t, ps) => t + ps.bought, 0), 0) * Math.max(0, Number.isFinite(product && product.price) ? product.price : 0);
      for (const f of opt.feeds) {
        if (tapped(f)) { opt.dollars += TAP_PRICE; continue; }
        const L = soloCost(f);
        opt.totalCord += L === Infinity ? 1e6 : L;
        if (L !== Infinity) for (const piece of cordPieces(L)) opt.dollars += catalog.CORD_PRICES[16][piece] || 0;
      }
      return opt;
    }
    /**
     * Feeding a chain from the middle: the point of the walk nearest an outlet (by cord length) splits it into
     * two walks that work outward from there, each filled up to the end-to-end limit. null when that point is
     * an end of the chain or the chain cannot be split (a forced direction, nothing to split mid-run).
     */
    function splitOption(steps) {
      if (steps.some((st) => items[st.k].forcedReverse)) return null;
      let bestPt = null;
      steps.forEach((st, si) => {
        const it = items[st.k];
        const path = traversal(it.shape, st.reversed);
        const xs = [];
        if (si > 0) xs.push(0); // between two runs
        if (it.len && it.shape.kind === 'open' && it.L > 0) {
          const step = Math.max(0.5, it.L / 200);
          for (let x = step; x < it.L - 1e-6; x += step) xs.push(x);
        }
        const own = new Set([it.feature.id]);
        for (const x of xs) {
          const point = x <= 1e-9 ? path[0].slice() : pointAlong(path, x / it.L, space.sol(it.planeId), space);
          const probe = { start: { point, imageId: it.imageId, planeId: it.planeId }, featureIds: own, forcedOutlet: it.forcedOutlet };
          const L = soloCost(probe);
          if (L !== Infinity && (!bestPt || L < bestPt.cord - 1e-9)) bestPt = { si, x, cord: L };
        }
      });
      if (!bestPt) return null;
      const { si, x } = bestPt;
      const it = items[steps[si].k];
      const back = (st) => ({ k: st.k, reversed: !st.reversed, from: 0, to: items[st.k].L });
      const A = [], B = [];
      if (x > 1e-9) {
        // Split inside run si: A works back from x to the run's entry end, B on from x to its exit end.
        A.push({ k: steps[si].k, reversed: !steps[si].reversed, from: it.L - x, to: it.L });
        B.push({ k: steps[si].k, reversed: steps[si].reversed, from: x, to: it.L });
      } else {
        B.push(Object.assign({}, steps[si]));
      }
      for (let i = si - 1; i >= 0; i--) A.push(back(steps[i]));
      for (let i = si + 1; i < steps.length; i++) B.push(Object.assign({}, steps[i]));
      if (!A.length || !B.length) return null;
      return { walks: [A, B], w: 2, split: true, order: steps.map((st) => st.k) };
    }
    const optionsOf = comps.map((m) => {
      const key = items[m[0]].run.id.replace(/^run_/, '');
      let options = walks(m).map((steps, w) => ({ walks: [steps], w }));
      const allowed = options.filter((o) => o.walks[0].every((s) => !items[s.k].forcedReverse || s.reversed));
      if (allowed.length) options = allowed;
      for (const opt of options) evaluate(opt, key);
      options.sort((x, y) => x.firstCord - y.firstCord || x.totalCord - y.totalCord || x.w - y.w);
      // An outlet under the middle of a long chain: feeding it outward from there can need far less cord.
      const split = splitOption(options[0].walks[0]);
      if (split) {
        evaluate(split, key);
        if (split.totalCord < SPLIT_GAIN * options[0].totalCord && split.dollars <= options[0].dollars + 1e-9) options.push(split);
      }
      return options;
    });

    // ---- 4. supply trees (SPEC §8.2). Outlets are the first sources. Prim-style, the cheapest feasible
    // (unpowered feed, way of walking its chain, source) is taken again and again, where a source is an outlet
    // (a home-run cord) or a feed that is already powered (a jumper from the end of its last string, or from a
    // tap where its own cord arrives). The first feed taken from a chain settles how that chain is walked.
    const circuitFits = (loadMap, o, watts) => (loadMap.get(circuitKey(o)) || 0) + watts <= limits.get(circuitKey(o)) + 1e-9;
    const outletFits = (loadMap, o, watts) => (loadMap.get(socketKey(o)) || 0) + watts <= outletLimit(o) + 1e-9;
    const loads = new Map(baseLoads);
    const fixed = comps.map(() => null);
    const nodes = [];
    const targets = [];
    optionsOf.forEach((options, n) => options.forEach((opt, oi) => {
      for (const feed of opt.feeds) targets.push({ feed, n, oi, done: false, cands: homeCandidates(feed).slice() });
    }));
    const active = (t) => !t.done && (fixed[t.n] === null || fixed[t.n] === t.oi);
    /**
     * May `watts` more hang off powered feed s at `port`? Every cord back to the outlet carries the whole tree
     * below it (plug limit), every string run the load passes through must stay within what the product allows
     * end to end, and the outlet and its circuit must stay within their limits.
     */
    function canAttach(s, port, watts) {
      const o = s.outlet;
      if (!circuitFits(loads, o, watts) || !outletFits(loads, o, watts)) return false;
      const lim = outletLimit(o);
      if (watts > lim + 1e-9) return false;
      for (let n = s, p = port; n; p = n.port, n = n.parent) {
        if (p === 'end' && n.feed.watts + n.throughW + watts > n.feed.maxConnW + 1e-9) return false;
        if (n.supplyW + watts > lim + 1e-9) return false;
      }
      return true;
    }
    const cmpNum = (x, y) => (x === y || Math.abs(x - y) <= 1e-9 ? 0 : x < y ? -1 : 1);
    for (;;) {
      // Order: forced outlets first, then choices within every limit, then the cheapest cord (crossing penalties
      // added); ties prefer a jumper, the shorter cord, an end plug over a tap, then ids.
      let best = null;
      for (const t of targets) {
        if (!active(t)) continue;
        const f = t.feed;
        const forced = f.forcedOutlet ? 0 : 1;
        for (const c of t.cands) {
          const home = c.kind === 'home';
          const tier = !home ? 0 : circuitFits(loads, c.outlet, f.watts) ? (outletFits(loads, c.outlet, f.watts) ? 0 : 1) : 2;
          if (best) {
            const b = best.c;
            const d = (forced - best.forced) || (tier - best.tier) || cmpNum(c.cost, b.cost) || ((home ? 1 : 0) - (b.kind === 'home' ? 1 : 0)) ||
              cmpNum(c.lengthFt === null ? Infinity : c.lengthFt, b.lengthFt === null ? Infinity : b.lengthFt) ||
              ((c.port === 'start' ? 1 : 0) - (b.port === 'start' ? 1 : 0)) || cmpStr(f.id, best.t.feed.id) || cmpStr(c.srcId, b.srcId) || (t.oi - best.t.oi);
            if (d >= 0) continue;
          }
          if (!home && !canAttach(c.node, c.port, f.watts)) continue;
          best = { t, c, tier, forced };
        }
      }
      if (!best) break;
      const { t, c } = best;
      const f = t.feed;
      t.done = true;
      if (fixed[t.n] === null) fixed[t.n] = t.oi;
      const o = c.kind === 'home' ? c.outlet : c.node.outlet;
      const node = { feed: f, parent: c.node, port: c.port, outlet: o, cand: c, throughW: 0, supplyW: f.watts, children: [],
        depth: c.node ? c.node.depth + 1 : 0, out: null, pathDrop: 0 };
      f.node = node;
      addLoad(loads, o, f.watts);
      for (let n = c.node, p = c.port; n; p = n.port, n = n.parent) {
        n.supplyW += f.watts;
        if (p === 'end') n.throughW += f.watts;
      }
      if (c.node) c.node.children.push(node);
      nodes.push(node);
      // The feed just powered is a source for every feed still waiting.
      if (daisy) {
        const split = !!optionsOf[t.n][t.oi].split && f.firstOfWalk;
        for (const u of targets) {
          if (!active(u) || u.feed.forcedOutlet) continue;
          // The other half of a run that is fed from its middle plugs into the tap on this half's cord, even when
          // the run has "its own cord": that cord still comes straight from the outlet.
          const sibling = split && u.n === t.n && u.oi === t.oi && u.feed.firstOfWalk && u.feed !== f;
          const linked = !f.ownCord && !u.feed.ownCord;
          if (!linked && !sibling) continue;
          for (const port of linked ? ['end', 'start'] : ['start']) {
            const j = jumperCandidate(u.feed, node, port);
            if (j && (linked || j.plug)) u.cands.push(j);
          }
        }
      }
    }
    const chosen = optionsOf.map((options, n) => options[fixed[n] === null ? 0 : fixed[n]]);

    // ---- assemble chains and feeds (chain order = first run's position in the run list)
    const chainsOut = [];
    const feedsOut = [];
    const runInfo = {};
    const chainLabels = new Map();
    comps.forEach((m, n) => {
      const opt = chosen[n];
      const key = items[m[0]].run.id.replace(/^run_/, '');
      const chainId = 'chain_' + key;
      const allSteps = [].concat(...opt.placed);
      // Per run: hung and bought strings over the whole option (a split run appears in two walks).
      const perRun = new Map();
      for (const ps of allSteps) {
        const e = perRun.get(ps.k) || { hung: 0, bought: 0, steps: [] };
        e.hung += ps.hung; e.bought += ps.bought; e.steps.push(ps);
        perRun.set(ps.k, e);
      }
      const runOrder = [];
      for (const ps of opt.walks.length > 1 ? opt.walks[1].concat(opt.walks[0].slice().reverse()) : opt.walks[0]) {
        if (!runOrder.includes(ps.k)) runOrder.push(ps.k);
      }
      if (opt.walks.length > 1) runOrder.sort((a, b) => opt.order.indexOf(a) - opt.order.indexOf(b));
      const reversed = {};
      for (const k of runOrder) {
        const st = perRun.get(k).steps[perRun.get(k).steps.length - 1];
        reversed[items[k].run.id] = items[k].shape.kind === 'vertical' ? false : st.reversed;
      }
      // Feed portions in feed order, with which portion starts and ends each run (for the checklist).
      const seen = new Map();
      const feedIds = [];
      const mine = [];
      opt.feeds.forEach((f) => {
        feedIds.push(f.id);
        const portions = f.portions.map((p) => {
          const before = seen.get(p.k) || 0;
          seen.set(p.k, before + 1);
          return { runId: items[p.k].run.id, units: p.units, total: perRun.get(p.k).hung, startsRun: before === 0, endsRun: false };
        });
        const out = {
          id: f.id, chainId, runIds: f.runIds.slice(), strings: f.units, watts: f.watts, amps: round(f.watts / V, 4),
          start: f.start, outletId: null, circuitId: null, cord: null, cordPath: [], crossesWalkway: false, crossesDoorway: false, cordUnknown: false,
          portions,
          source: null, parentFeedId: null, childFeedIds: [], depth: 0, supplyW: 0, throughW: 0, pathDropPct: null, taps: 0, plugIn: false,
          _incandescent: f.incandescent, _feature: items[f.portions[0].k].feature.id,
        };
        if (f.node) f.node.out = out;
        mine.push(out);
        feedsOut.push(out);
      });
      // Mark the last portion of each run.
      const lastSeen = new Map();
      for (const f of mine) for (const p of f.portions) lastSeen.set(p.runId, p);
      for (const p of lastSeen.values()) p.endsRun = true;
      const runIds = runOrder.map((k) => items[k].run.id);
      const hungUnits = allSteps.reduce((s, ps) => s + ps.hung, 0);
      const boughtUnits = allSteps.reduce((s, ps) => s + ps.bought, 0);
      const liveWatts = round(opt.feeds.reduce((s, f) => s + f.watts, 0), 2);
      chainsOut.push({ id: chainId, productId: items[m[0]].run.productId, runIds, reversed, strings: round(hungUnits, 4),
        spares: round(Math.max(0, boughtUnits - hungUnits), 4), watts: liveWatts, feedIds });
      const labels = runOrder.map((k) => items[k].run.label);
      chainLabels.set(chainId, labels.length === 1 ? labels[0] : listText(labels.length > 3 ? labels.slice(0, 2).concat([`${labels.length - 2} more runs`]) : labels));
      for (const k of runOrder) {
        const it = items[k];
        const e = perRun.get(k);
        const path = traversal(it.shape, reversed[it.run.id] && it.shape.kind !== 'vertical');
        runInfo[it.run.id] = {
          chainId, feedIds: feedIds.filter((fid, fi) => opt.feeds[fi].runIds.includes(it.run.id)),
          outletId: null, circuitId: null, sourceFeedId: null,
          start: path[0].slice(), end: path[path.length - 1].slice(), reversed: reversed[it.run.id],
          quantity: round(e.bought, 4), hung: round(e.hung, 4), watts: round(e.hung * it.wattsPerUnit, 2),
        };
        if (it.solo && e.bought > e.hung + 1e-9) {
          runInfo[it.run.id].note = `${fmtInt(e.hung)} ft of it is cut, hung and lit; the other ${fmtInt(e.bought - e.hung)} ft is the allowance for waste and stays on the spool.`;
        }
        const pool = e.steps.map((ps) => ps.pool).find(Boolean);
        if (pool) {
          const others = pool.labels.filter((l) => l !== it.run.label);
          const own = round(e.bought, 4);
          runInfo[it.run.id].note = `Counted with ${listText(others.length > 3 ? others.slice(0, 2).concat([`${others.length - 2} more runs`]) : others)} ` +
            `as one continuous line: ${fmt1(pool.withWasteFt)} ft ÷ ${fmt1(pool.len)} ft per string = ${fmtInt(pool.strings)} ${unitWord(it.run.unit, pool.strings)}` +
            (own > 0 ? (own >= pool.strings ? ', all bought for this run.' : `, ${fmtInt(own)} of them bought for this run.`)
              : `; the last ${unitWord(it.run.unit, 1)} of the run before carries on along this one, so none is bought for it.`);
        }
      }
      if (opt.split) {
        const firsts = opt.feeds.filter((f) => f.firstOfWalk);
        const root = firsts.map((f) => f.node).find(Boolean);
        const tapped = firsts.some((f) => f.node && f.node.cand.kind === 'jumper' && firsts.some((x) => x.node === f.node.parent));
        // The split point is the one nearest an outlet; a jumper from another run may reach it first.
        const where = !root || !root.parent ? `the point nearest ${(root && root.outlet.label) || 'the outlet'}` : `the middle, at the ${root.feed.start.label}`;
        warn('info', 'fed-from-middle',
          `${chainLabels.get(chainId)} ${runIds.length > 1 ? 'are' : 'is'} fed from ${where}: ` +
          (tapped ? 'one cord ends in a 3-way tap there and the lights run outward both ways, ' : `${opt.feeds.length} cords work outward from there, `) +
          'which needs much less cord than feeding from one end.', { featureId: items[m[0]].feature.id });
      }
      if (opt.feeds.length > opt.walks.length) {
        const product = items[m[0]].product;
        const unit = items[m[0]].run.unit;
        const what = runIds.length > 1 ? 'these connected runs use' : 'this run uses';
        warn('info', 'max-end-to-end',
          `${chainLabels.get(chainId)} ${runIds.length > 1 ? 'need' : 'needs'} ${opt.feeds.length} feeds: ${(product && product.name) || items[m[0]].run.productName} allows only ` +
          `${fmtInt(opt.maxE)} ${unitWord(unit, opt.maxE)} end to end and ${what} ${fmtInt(hungUnits)}.`,
          { featureId: items[m[0]].feature.id });
      }
    });
    // Unpowered runs (not measured, no product, no geometry) still get an entry.
    for (const run of allRuns) {
      if (runInfo[run.id]) continue;
      const f = featureById.get(run.featureId);
      const shape = f ? runShape(f) : null;
      const path = shape ? traversal(shape, false) : null;
      runInfo[run.id] = { chainId: null, feedIds: [], outletId: null, circuitId: null, sourceFeedId: null,
        start: path ? path[0].slice() : null, end: path ? path[path.length - 1].slice() : null, reversed: false };
    }

    // ---- cords: each one is sized for everything it carries (its own feed and every feed hanging off it)
    for (const node of nodes) {
      const feed = node.out, c = node.cand, o = node.outlet;
      feed.outletId = o.id;
      feed.circuitId = o.circuitId && circuitById.has(o.circuitId) ? o.circuitId : null;
      feed.source = c.kind === 'home' ? { kind: 'outlet', outletId: o.id } : { kind: 'feed', feedId: node.parent.out.id, port: c.port };
      feed.parentFeedId = node.parent ? node.parent.out.id : null;
      feed.depth = node.depth;
      feed.supplyW = round(node.supplyW, 2);
      feed.throughW = round(node.throughW, 2);
      feed.cordPath = c.route.path.map((p) => [p[0], p[1]]);
      feed.crossesWalkway = !!c.walkway;
      feed.crossesDoorway = !!c.door;
      feed._doorLabel = c.door;
      if (node.parent) node.parent.out.childFeedIds.push(feed.id);
      const ks = node.children.filter((x) => x.port === 'start').length, ke = node.children.filter((x) => x.port === 'end').length;
      feed.taps = Math.ceil(ks / (tapOutlets - 1)) + (ke <= 1 ? 0 : Math.ceil((ke - 1) / (tapOutlets - 1)));
      if (c.plug) {
        feed.plugIn = true;
      } else if (c.lengthFt === null) {
        feed.cordUnknown = true;
        let reason = `${space.planeName(feed.start.planeId)} is not calibrated`;
        if (!isPt(o.point)) reason = `${o.label || 'the outlet'} has no position on the photo`;
        else if (feed.start.imageId && o.imageId && o.imageId !== feed.start.imageId) reason = `${o.label || 'the outlet'} is on a different photo`;
        warn('warn', 'cord-unknown', `The cord length to the ${feed.start.label} is unknown because ${reason}. Calibrate it to size the cord.`,
          { featureId: feed._feature, outletId: o.id });
      } else {
        feed.cord = sizeCord(c.lengthFt, node.supplyW, cfg, outletVoltage(o));
        feed.cord.kind = c.kind;
        feed.cord.route = c.route.segs.map((s) => ({ kind: s.kind, lengthFt: round(s.lengthFt, 2), planeId: s.planeId || null, from: [s.from[0], s.from[1]], to: [s.to[0], s.to[1]] }));
        feed.cord.routeText = routeText(c.route.segs);
      }
    }
    // Voltage drop adds up along the cords of a path. Where a path loses more than the limit, the cord on it that
    // loses the most is bought one gauge thicker, until the path is within the limit or every cord is 12 AWG.
    const maxDrop = pos(cfg.maxVoltageDropPct) || 3;
    const gauges = catalog.CORD_GAUGES.slice().sort((a, b) => b.awg - a.awg); // 16, 14, 12
    const thicker = (awg) => { const i = gauges.findIndex((x) => x.awg === awg); return i >= 0 && i + 1 < gauges.length ? gauges[i + 1] : null; };
    const pathDrops = () => { for (const node of nodes) node.pathDrop = (node.parent ? node.parent.pathDrop : 0) + (node.out.cord ? node.out.cord.voltageDropPct : 0); };
    pathDrops();
    for (let guard = 0; guard < 2 * nodes.length + 2; guard++) {
      let worst = null, fix = null;
      for (const node of nodes) {
        if (!(node.pathDrop > maxDrop + 1e-9) || (worst && node.pathDrop <= worst.pathDrop + 1e-9)) continue;
        let cand = null;
        for (let n = node; n; n = n.parent) {
          const c = n.out.cord;
          if (c && thicker(c.awg) && (!cand || c.voltageDropPct > cand.out.cord.voltageDropPct + 1e-9)) cand = n;
        }
        if (cand) { worst = node; fix = cand; }
      }
      if (!fix) break;
      const c = fix.out.cord, gauge = thicker(c.awg), volts = outletVoltage(fix.outlet);
      const amps = fix.supplyW / volts;
      c.awg = gauge.awg;
      c.voltageDropPct = round(voltageDropPct(c.boughtFt, amps, gauge.ohmsPer1000ft, volts), 2);
      c.ampacityOk = Math.min(gauge.ampacity, plugAmps) >= amps;
      c.dropOk = c.voltageDropPct <= maxDrop + 1e-9;
      c.ok = c.ampacityOk && c.dropOk;
      pathDrops();
    }
    for (const node of nodes) node.out.pathDropPct = round(node.pathDrop, 2);
    const feedOutById = new Map(feedsOut.map((f) => [f.id, f]));

    // ---- run info: outlet/circuit of each run's first feed, and the feed that powers it
    for (const id of Object.keys(runInfo)) {
      const info = runInfo[id];
      const f = info.feedIds.length ? feedOutById.get(info.feedIds[0]) : null;
      if (f) { info.outletId = f.outletId; info.circuitId = f.circuitId; info.sourceFeedId = f.parentFeedId; }
    }

    // ---- outlets, supply trees, circuits, counts
    // The timer the chosen supplier has on file may be rated for less than the outlet (1,000 W at 1000Bulbs).
    const timerOffer = lib.supplierId ? suppliers.accessoryOffer(lib.supplierId, 'timer-outdoor') : null;
    const timerMaxW = timerOffer ? pos(timerOffer.maxWatts) : null;
    const outletsOut = outlets.map((o) => {
      const fs = feedsOut.filter((f) => f.outletId === o.id);
      const direct = fs.filter((f) => f.source && f.source.kind === 'outlet');
      // Power stakes split the timer socket between the cords that come back to the outlet (home runs only).
      const n = direct.length;
      const w = round(fs.reduce((s, f) => s + f.watts, 0), 2);
      const lim = outletLimit(o);
      return {
        id: o.id, label: o.label || 'Outlet', circuitId: o.circuitId && circuitById.has(o.circuitId) ? o.circuitId : null,
        feedIds: fs.map((f) => f.id), directFeedIds: direct.map((f) => f.id), watts: w,
        needsSplitter: n > 1, splitters: stakesFor(n),
        timer: fs.length > 0 && cfg.timerPerOutlet !== false,
        limitW: lim, overloaded: w > lim + 1e-9,
        timerMaxW: fs.length > 0 && cfg.timerPerOutlet !== false ? timerMaxW : null,
        incandescentW: round(fs.filter((f) => f._incandescent).reduce((s, f) => s + f.watts, 0), 2),
      };
    });
    const groups = [];
    for (const o of outletsOut) {
      for (const rootId of o.directFeedIds) {
        const ids = [];
        let jumperFt = 0;
        const walk = (f) => {
          ids.push(f.id);
          if (f.id !== rootId && f.cord) jumperFt += f.cord.boughtFt;
          for (const cid of f.childFeedIds) walk(feedOutById.get(cid));
        };
        const root = feedOutById.get(rootId);
        walk(root);
        groups.push({ id: 'tree_' + rootId.replace(/^feed_/, ''), outletId: o.id, rootFeedId: rootId, feedIds: ids, watts: root.supplyW,
          homeRunFt: root.cord ? root.cord.boughtFt : 0, jumperFt });
      }
    }
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
    const jumperCords = feedsOut.filter((f) => f.source && f.source.kind === 'feed' && f.cord).length;
    const counts = {
      timers: outletsOut.filter((o) => o.timer).length,
      splitters: outletsOut.reduce((s, o) => s + o.splitters, 0),
      cordCovers: feedsOut.filter((f) => f.crossesWalkway || f.crossesDoorway).length,
      gfciAdapters: usedOutlets.filter((o) => !hasGfci(o)).length,
      taps: feedsOut.reduce((s, f) => s + f.taps, 0),
      homeRuns: feedsOut.filter((f) => f.source && f.source.kind === 'outlet').length,
      jumpers: jumperCords,
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
    // Live load: the strings that are hung (spares bought for waste are not plugged in).
    const totalWatts = round(chainsOut.reduce((s, c) => s + c.watts, 0), 2);

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
    // Outlets: every cord at one outlet shares its receptacle, timer and power stakes (15 A plug-in gear).
    const tungstenW = pos(cfg.timerTungstenW) || DEFAULT_TIMER_TUNGSTEN_W;
    for (const o of outletsOut) {
      if (!o.feedIds.length) continue;
      if (o.overloaded) {
        const gear = o.timer ? (o.splitters > 0 ? 'outlet, timer and power stake' : 'outlet and timer') : (o.splitters > 0 ? 'outlet and power stake' : 'outlet');
        warn('danger', 'outlet-overload',
          `${o.label} would feed ${fmtInt(o.watts)} W through one ${gear}, over the ${fmtInt(o.limitW)} W safe limit for ${fmtInt(plugAmps)} A plug-in gear ` +
          `(${fmtInt(factor * 100)}%). Move a cord to another outlet${o.incandescentW > 0 ? ' or switch to LED' : ''}.`, { outletId: o.id });
      }
      if (o.directFeedIds.length > MANY_CORDS) {
        warn('warn', 'many-cords',
          `${o.label} feeds ${o.directFeedIds.length} cords through ${o.splitters} chained power stakes. Spread the cords over more outlets if you can, ` +
          'and keep every stake and joint off the ground.', { outletId: o.id });
      }
      if (o.timer && o.timerMaxW && o.watts > o.timerMaxW + 1e-9 && !o.overloaded) {
        const sup = suppliers.getSupplier(lib.supplierId);
        warn('warn', 'timer-rating',
          `${o.label} would run ${fmtInt(o.watts)} W through its timer, more than the ${fmtInt(o.timerMaxW)} W the ${(sup && sup.name) || 'supplier'} timer is rated for. ` +
          `The shopping list has a heavy-duty timer for this outlet instead: check that its label says ${fmtInt(plugAmps)} A (${fmtInt(plugAmps * outletVoltage(outletById.get(o.id)))} W).`,
          { outletId: o.id });
      }
      if (o.timer && o.incandescentW > tungstenW + 1e-9) {
        warn('warn', 'timer-tungsten',
          `${o.label} would run ${fmtInt(o.incandescentW)} W of incandescent lights through one timer. Many outdoor timers are rated about ` +
          `${fmtInt(tungstenW)} W for incandescent loads: check the timer's label, use a heavy-duty timer, or switch to LED.`, { outletId: o.id });
      }
    }
    // The safe-share setting: say how an odd value was read, and flag a share above the 80% rule.
    if (cf.reading === 'percent') {
      warn('warn', 'continuous-factor', `The safe share of the breaker is set to ${fmt1(cf.raw)}, so LightPlan reads it as ${fmt1(factor * 100)}%. Enter it as a fraction of 1 (for example 0.8).`);
    } else if (cf.reading === 'default') {
      warn('warn', 'continuous-factor', `The safe share of the breaker (${String(cf.raw)}) is not a fraction between 0 and 1, so LightPlan uses the 80% rule instead.`);
    }
    if (factor > DEFAULT_CONTINUOUS_FACTOR + 1e-9) {
      warn('warn', 'continuous-factor', `The safe share of the breaker is ${fmt1(factor * 100)}%, above the usual 80% limit for loads that stay on for hours, like holiday lights. Circuit limits are higher than the usual rule allows.`);
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
      // Live strings and watts (spares bought for waste are not plugged in).
      const q = e.items.reduce((s, it) => s + (runInfo[it.run.id] && Number.isFinite(runInfo[it.run.id].hung) ? runInfo[it.run.id].hung : it.run.quantity), 0);
      const w = e.items.reduce((s, it) => s + (runInfo[it.run.id] && Number.isFinite(runInfo[it.run.id].watts) ? runInfo[it.run.id].watts : Math.max(0, it.run.watts || 0)), 0);
      const name = (first.product && first.product.name) || first.run.productName || pid;
      const led = lib.products.find((p) => p && p.enabled !== false && p.tech === 'LED' && first.product && p.category === first.product.category && p.unit === first.product.unit);
      const ledText = led ? ` The LED version (${led.name}) would draw about ${fmtInt(q * (led.wattsPerUnit || 0))} W and allows more ${unitWord(led.unit, 2)} end to end.` : '';
      const labels = listText(e.items.map((it) => it.run.label));
      warn('warn', 'incandescent', `${labels} ${e.items.length === 1 ? 'uses' : 'use'} incandescent lights (${name}): ${fmtInt(q)} ${unitWord(first.run.unit, q)} draw ${fmtInt(w)} W.${ledText}`,
        e.items.length === 1 ? { featureId: first.feature.id } : undefined);
    }
    // Feeds: cords, walkways, doorways and what passes through the strings.
    const nodeOf = new Map(nodes.map((node) => [node.out.id, node]));
    for (const f of feedsOut) {
      const node = nodeOf.get(f.id);
      if (!node) continue;
      const fid = f._feature;
      const cordName = f.source.kind === 'feed' ? 'jumper cord' : 'cord';
      if (f.crossesWalkway) {
        warn('warn', 'cord-walkway', `The ${cordName} to the ${f.start.label} crosses a walkway. Put a cord cover over it so nobody trips.`, { featureId: fid, outletId: f.outletId });
      }
      if (f.crossesDoorway) {
        warn('warn', 'cord-doorway', `The ${cordName} to the ${f.start.label} runs along the ground in front of ${f._doorLabel}. Keep it tight against the doorstep under a cord cover ` +
          'so nobody trips, or use an outlet on the other side of the door.', { featureId: fid, outletId: f.outletId });
      }
      if (node.feed.watts + node.throughW > node.feed.maxConnW + 1e-6) {
        warn('warn', 'pass-through', `The lights starting at the ${f.start.label} would carry ${fmtInt(node.feed.watts + node.throughW)} W through their own wiring, more than the ` +
          `${fmtInt(node.feed.maxConnW)} W this product allows end to end. Split the run or use a product that allows more.`, { featureId: fid, outletId: f.outletId });
      }
      if (f.cord) {
        const volts = outletVoltage(node.outlet);
        if (!f.cord.ampacityOk) {
          warn('danger', 'cord-ampacity', `The feed at the ${f.start.label} draws ${fmt1(node.supplyW / volts)} A, more than a plug-in extension cord can carry (${fmtInt(plugAmps)} A plug). Split it into more feeds.`, { featureId: fid, outletId: f.outletId });
        } else if (!f.cord.dropOk) {
          const need = f.cord.boughtFt > f.cord.lengthFt + 0.5 ? ` (about ${fmtInt(f.cord.lengthFt)} ft needed)` : '';
          warn('warn', 'voltage-drop', `The ${fmtInt(f.cord.boughtFt)} ft ${cordName} to the ${f.start.label}${need} would lose ${fmt1(f.cord.voltageDropPct)}% of its voltage even with 12 AWG cord (limit ${fmt1(maxDrop)}%). Use a closer outlet or split the run.`, { featureId: fid, outletId: f.outletId });
        }
        if (f.cord.lengthFt > 100) {
          warn('warn', 'long-cord', `The cord to the ${f.start.label} needs about ${fmtInt(f.cord.lengthFt)} ft (${f.cord.pieces.map((p) => p + ' ft').join(' + ')}). Look for a closer outlet.`, { featureId: fid, outletId: f.outletId });
        }
      }
      // A path of cords that each pass on their own but add up to more than the limit: flagged where it first goes over.
      const ownOver = !!f.cord && (!f.cord.dropOk || !f.cord.ampacityOk);
      if (node.parent && !ownOver && node.pathDrop > maxDrop + 1e-9 && !(node.parent.pathDrop > maxDrop + 1e-9)) {
        warn('warn', 'voltage-drop', `The lights at the ${f.start.label} are fed through ${node.depth + 1} cords in a row that lose ${fmt1(node.pathDrop)}% of the voltage in total ` +
          `(limit ${fmt1(maxDrop)}%). Give this run its own cord from the outlet, or use a closer outlet.`, { featureId: fid, outletId: f.outletId });
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
          'Mark an outlet on that photo to plan the cord.', { featureId: orphan[0]._feature });
      }
    }
    // Daisy chains: how many cords the jumpers save at the outlets.
    const linked = feedsOut.filter((f) => f.source && (f.parentFeedId || f.childFeedIds.length));
    if (counts.jumpers > 0) {
      const runCount = new Set([].concat(...linked.map((f) => f.runIds))).size;
      const homes = counts.homeRuns;
      const back = usedOutlets.length === 1 ? (usedOutlets[0].label || 'the outlet') : 'the outlets';
      warn('info', 'daisy-chain', `${fmtInt(runCount)} runs are linked with ${fmtInt(counts.jumpers)} jumper ${counts.jumpers === 1 ? 'cord' : 'cords'}; ` +
        `${fmtInt(homes)} ${homes === 1 ? 'cord goes' : 'cords go'} back to ${back}.`);
    }
    warn('info', 'disclaimer', DISCLAIMER);
    warnings.sort((x, y) => LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level]); // stable: keeps insertion order within a level

    // Strip internal fields.
    for (const f of feedsOut) {
      if (f.crossesDoorway) f.doorway = f._doorLabel;
      delete f._incandescent; delete f._doorLabel; delete f._feature;
    }

    return {
      chains: chainsOut,
      feeds: feedsOut,
      outlets: outletsOut,
      circuits: circuitsOut,
      groups,
      runInfo,
      cords,
      counts,
      totals: { watts: totalWatts, amps: round(totalWatts / V, 3) },
      warnings,
    };
  }

  return { planPower, limitW, continuousFactorOf, voltageDropPct, chooseCordGauge, cordPieces, sizeCord, DISCLAIMER };
});
