/* LightPlan core: sample.
 *
 * The built-in sample house: the first thing every user sees, and the accuracy demo.
 *
 * A small 3D model of a suburban house is rendered through a pinhole camera into vector primitives, and the
 * same camera projects the 3D corners of every traced feature. Measuring the sample project therefore checks
 * the whole pipeline (focal length, perspective rectangle, roof and ground planes) against true lengths.
 *
 * Model (feet). Wall frame: u to the right along the front wall, v up, w toward the street; the main front
 * wall is the plane w = 0 and the ground is v = 0.
 *   Main block     u 0..34, 28 deep, walls 10 ft, side-gable roof 6/12 (ridge at w = -14, v = 17)
 *   Entry gable    in the front wall plane over the door: rakes (9,10) → (17,14) → (25,10), with the eave
 *                  fascia running straight across its base (a pediment)
 *   Garage wing    u 34..56, front wall set back to w = -4, walls 9 ft, side-gable roof 6/12 (ridge v = 15)
 *   Openings       front door 3 × 6.667 ft at u 15.5..18.5; windows 4 × 5 ft at u 3..7 and 27..31
 *                  (sill 3 ft); double garage door 16 × 7 ft at u 37..53
 *   Yard           3 bushes (4 ft wide, 3 ft tall) at w = +2; a maple at u = -10, w = +12 (10 in trunk,
 *                  canopy from 7 ft); walkway u 15..19 from the door to the sidewalk at w = 18; driveway in
 *                  front of the garage; sidewalk, curb and street toward the camera
 *
 * Camera: 26 mm-equivalent phone lens on a 1600 × 1100 image (f = 26·hypot(w,h)/43.2666 px), standing across
 * the street 64 ft from the front wall at eye height 5.5 ft, turned 20° off the facade normal and tilted 8° up.
 * Both the sideways and the vertical convergence of the facade are visible, so the focal length can be
 * recovered from the facade rectangle (both vanishing points are finite).
 *
 * Drawing: painter's algorithm. Layers back to front: sky, distant trees, ground, house, foreground plants.
 * Inside the depth-sorted layers, groups are drawn farthest first (distance from the camera to the group's
 * reference point); each group is one surface plus its details, drawn in order. The layer split is what makes
 * plain depth sorting correct here: everything on the ground is behind everything standing on it, and the
 * plants all stand in front of the house walls.
 *
 * Pure: no DOM, no clocks, randomness only from a seeded PRNG, so output is identical on every call.
 * drawPrimitives only calls methods of the CanvasRenderingContext2D it is given.
 *
 * Deviations from SPEC §5.11 (the documented signatures all still work):
 *  - groundTruth values are numbers (true 3D length in feet; the tree's value is its trunk height to the
 *    canopy) except bushes, whose value is {widthFt, heightFt}: bushes are planned by size, not by length.
 *  - traced:false returns groundTruth {} (there are no features to compare).
 *  - camera also has `distanceFt` (perpendicular distance from the camera to the front wall).
 *  - Extra exports: SAMPLE_WIDTH, SAMPLE_HEIGHT.
 *  - The ref "Window width (tape)" carries a `label` field (not in SPEC §4) so the UI can show its name.
 */
LP.define('sample', ['geometry'], function (g) {
  'use strict';

  // ================================================================ image and camera
  const WIDTH = 1600;
  const HEIGHT = 1100;
  const DEG = Math.PI / 180;
  const FULL_FRAME_DIAGONAL_MM = 43.2666;

  /** The camera stands right of the house center and looks back toward −u by yawDeg. */
  const CAMERA = { f35: 26, position: [46, 5.5, 64], yawDeg: 20, tiltDeg: 8 };
  /** Geometry closer than this to the camera (along the view axis) is clipped before projection. */
  const NEAR_FT = 4;

  // ================================================================ model
  const PITCH = 6 / 12;
  const SLOPE_COS = 1 / Math.hypot(1, PITCH); // cos(atan(6/12))
  const SLOPE_SIN = PITCH * SLOPE_COS;
  const COURSE_FT = 5 / 12; // 5 in exposure for both lap siding and shingles

  const MODEL = {
    main: { u0: 0, u1: 34, depth: 28, wallH: 10 },
    gable: { u0: 9, u1: 25, peakV: 14 },
    garage: { u0: 34, u1: 56, w: -4, depth: 24, wallH: 9 },
    door: { u0: 15.5, u1: 18.5, h: 80 / 12 },
    windows: [{ u0: 3, u1: 7 }, { u0: 27, u1: 31 }],
    windowSill: 3,
    windowHead: 8,
    garageDoor: { u0: 37, u1: 53, h: 7 },
    foundationH: 0.6,
    fasciaH: 0.45,
    bushW: 2,
    bushes: [5, 22, 29],
    tree: { u: -10, w: 12, trunkIn: 10, canopyBase: 7 },
    walkway: { u0: 15, u1: 19, w0: 0, w1: 18 },
    driveway: { u0: 36, u1: 54 },
    sidewalk: { w0: 18, w1: 22 },
    curb: { w0: 25.4, w1: 25.9 },
    streetW: 26.6,
    porchOutlet: [13, 1.5],
    garageOutlet: [35, 1.5],
    sidingRef: { u: 54.8, v0: 1.25, courses: 12 },
  };
  const MAIN_RIDGE_V = MODEL.main.wallH + (MODEL.main.depth / 2) * PITCH; // 17
  const MAIN_SLOPE_FT = MODEL.main.depth / 2 / SLOPE_COS; // eave → ridge along the roof, 15.65
  const GARAGE_RIDGE_V = MODEL.garage.wallH + (MODEL.garage.depth / 2) * PITCH; // 15
  const GARAGE_SLOPE_FT = MODEL.garage.depth / 2 / SLOPE_COS; // 13.42

  // Surface maps: 2D coordinates on a surface → 3D wall-frame point.
  const onFront = (u, v) => [u, v, 0];
  const onGarage = (u, v) => [u, v, MODEL.garage.w];
  /** Right gable end of the main block (faces +u); s = depth behind the front wall. */
  const onMainSide = (s, v) => [MODEL.main.u1, v, -s];
  /** Main roof front slope: a along the eave, b up the slope from the eave. */
  const onMainRoof = (a, b) => [a, MODEL.main.wallH + b * SLOPE_SIN, -b * SLOPE_COS];
  const onGarageRoof = (a, b) => [a, MODEL.garage.wallH + b * SLOPE_SIN, MODEL.garage.w - b * SLOPE_COS];
  const onGround = (u, w) => [u, 0, w];

  /** Bush = union of spheres [du, v, dw, r] around its base center; extents: 4 ft wide, 3 ft tall. */
  const BUSH_SPHERES = [
    [-1.15, 0.85, 0, 0.85], [1.15, 0.85, 0, 0.85], [0, 1.55, 0, 1.45],
    [-0.62, 2.3, 0.1, 0.7], [0.72, 2.2, -0.1, 0.75], [-1.45, 1.5, 0.15, 0.55], [1.5, 1.45, -0.1, 0.5],
  ];
  /** Maple canopy spheres [du, v, dw, r] around the trunk; bottom ≈ 7 ft, top 24 ft, about 17 ft wide. */
  const CANOPY_SPHERES = [
    [-2.1, 10.5, -1.2, 3.3], [2.4, 10.8, -1.0, 3.4], [-5.2, 15.8, -1.5, 3.0], [5.4, 16.0, -1.2, 3.0],
    [0, 15.6, -0.5, 5.2], [-4.0, 13.0, 0.3, 3.4], [4.1, 13.2, 0.4, 3.5],
    [-2.9, 18.6, 0, 3.7], [2.8, 18.8, 0.2, 3.8], [0, 20.4, 0.1, 3.6],
    [-1.5, 11.4, 1.6, 2.6], [1.9, 12.2, 1.8, 2.5], [-0.6, 16.8, 2.2, 3.0],
  ];

  // ================================================================ palette (soft daylight)
  const C = {
    skyTop: '#76abd8', skyMid: '#a9cbe6', skyLow: '#e1ecf0',
    cloud: '#ffffff', cloudShade: '#dfe8f1',
    farTree: ['#7b9b89', '#86a594', '#93b0a2'], farTreeLit: '#9fbbaa', hedge: '#6f8f74',
    lawnFar: '#a9c088', lawnMid: '#8fb267', lawnNear: '#6f9a49',
    asphaltFar: '#80848a', asphaltNear: '#5e6267',
    concrete: '#d9d5cc', concreteFar: '#cdc8be', concreteLight: '#e3e0d8', joint: 'rgba(120,112,100,0.45)',
    curb: '#e4e1da', gutterPan: '#b9b6b0',
    siding: '#93a6b1', sidingSide: '#7f929e', sidingLine: 'rgba(48,66,80,0.33)', sidingLit: 'rgba(255,255,255,0.13)',
    trim: '#f7f6f1', trimShade: '#e2e2dc', trimEdge: 'rgba(90,95,100,0.45)',
    foundation: '#bdb8ae', foundationLine: 'rgba(80,76,70,0.35)',
    roof: '#50555c', roofRidge: '#43474d', roofLine: 'rgba(22,24,28,0.42)', roofTab: 'rgba(22,24,28,0.30)',
    shutter: '#3c4955', shutterLine: 'rgba(0,0,0,0.28)',
    door: '#8b3a2c', doorPanel: '#7b3125', doorLit: 'rgba(255,220,200,0.22)', doorShadow: 'rgba(40,10,5,0.35)',
    brass: '#c9a24a',
    glassTop: '#e6f2f9', glassBottom: '#a6c8de', glassShine: 'rgba(255,255,255,0.32)', sash: '#eeede8',
    garageDoor: '#f3f2ec', garagePanel: '#e7e6df', garageGlassTop: '#7d98a8', garageGlassBottom: '#566f7e',
    lamp: '#2f3236', lampGlass: '#efe2b8', outlet: '#e6e4dd', outletEdge: '#8d8b84',
    bushDark: '#2f6430', bushMid: '#3f7c3b', bushLit: '#579a49', bushHi: '#78b45f',
    trunk: '#6b4b33', trunkDark: '#4c3424', trunkLit: '#86613f',
    leafDark: '#2f6330', leafMid: '#3f7d3a', leafLit: '#58994a', leafHi: '#7ab65e',
    shadow: 'rgba(28,48,22,0.26)', shadowSoft: 'rgba(28,48,22,0.16)',
  };

  // ================================================================ small helpers
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** Round to 0.1 px (and turn −0 into 0). */
  const r1 = (v) => Math.round(v * 10) / 10 + 0;
  const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
  const roundPt = (p) => [r1(p[0]), r1(p[1])];
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // ================================================================ camera
  function buildCamera() {
    const f = (CAMERA.f35 * Math.hypot(WIDTH, HEIGHT)) / FULL_FRAME_DIAGONAL_MM;
    const yaw = CAMERA.yawDeg * DEG;
    const tilt = CAMERA.tiltDeg * DEG;
    // View direction: turned toward −u by the yaw, tilted up by the tilt.
    const fwd = [-Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), -Math.cos(yaw) * Math.cos(tilt)];
    // Camera x axis = fwd × up. It is level (no roll), so the horizon is a horizontal image line.
    const right = g.v3norm([-fwd[2], 0, fwd[0]]);
    const down = g.v3cross(fwd, right); // image y grows downward
    return { f, cx: WIDTH / 2, cy: HEIGHT / 2, pos: CAMERA.position.slice(), right, down, fwd };
  }

  function toCamera(cam, X) {
    const d = g.v3sub(X, cam.pos);
    return [g.v3dot(cam.right, d), g.v3dot(cam.down, d), g.v3dot(cam.fwd, d)];
  }
  function cameraToImage(cam, c) {
    return [(cam.f * c[0]) / c[2] + cam.cx, (cam.f * c[1]) / c[2] + cam.cy];
  }
  /** World → image (unrounded); null behind the near plane. */
  function projectWorld(cam, X) {
    const c = toCamera(cam, X);
    return c[2] >= NEAR_FT ? cameraToImage(cam, c) : null;
  }
  /** Image row of the horizon: a level camera tilted up by τ sees it at cy + f·tan τ. */
  function horizonY(cam) { return cam.cy + cam.f * Math.tan(CAMERA.tiltDeg * DEG); }

  /** Sutherland–Hodgman clip of a camera-space polygon against z ≥ NEAR_FT. */
  function clipNear(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const aIn = a[2] >= NEAR_FT, bIn = b[2] >= NEAR_FT;
      if (aIn) out.push(a);
      if (aIn !== bIn) out.push(lerp3(a, b, (NEAR_FT - a[2]) / (b[2] - a[2])));
    }
    return out;
  }

  // ================================================================ scene builder (painter's algorithm)
  const LAYERS = ['sky', 'far', 'ground', 'house', 'front'];
  const DEPTH_SORTED = { far: true, house: true, front: true };

  function createBuilder(cam) {
    const groups = [];

    /** Start a group of primitives. refPoint (3D) sets its depth inside depth-sorted layers. */
    function group(layer, refPoint) {
      const depth = refPoint ? g.v3len(g.v3sub(refPoint, cam.pos)) : 0;
      const grp = { layer, depth, seq: groups.length, prims: [] };
      groups.push(grp);
      return grp;
    }

    /** Fill spec → primitive fill. A 3D gradient {from, to, stops} becomes a 2D linear gradient. */
    function paint(fill) {
      if (!isObj(fill) || !fill.from) return fill;
      const a = projectWorld(cam, fill.from), b = projectWorld(cam, fill.to);
      if (!a || !b) return fill.stops[fill.stops.length - 1][1];
      return { linear: [r1(a[0]), r1(a[1]), r1(b[0]), r1(b[1])], stops: fill.stops.map((s) => [s[0], s[1]]) };
    }

    function styled(prim, style) {
      if (style.fill) prim.fill = paint(style.fill);
      if (style.stroke) { prim.stroke = style.stroke; prim.lw = style.lw || 1; }
      return prim;
    }

    /** 3D polygon (clipped at the near plane). */
    function poly(grp, pts3, style) {
      const c = clipNear(pts3.map((X) => toCamera(cam, X)));
      if (c.length < 3) return;
      grp.prims.push(styled({ t: 'poly', pts: c.map((p) => roundPt(cameraToImage(cam, p))) }, style));
    }

    /** Axis-aligned rectangle on a surface map. */
    function quad(grp, map, a0, b0, a1, b1, style) {
      poly(grp, [map(a0, b0), map(a1, b0), map(a1, b1), map(a0, b1)], style);
    }

    /** 3D line segment (clipped at the near plane). */
    function line(grp, A, B, style) {
      let a = toCamera(cam, A), b = toCamera(cam, B);
      if (a[2] < NEAR_FT && b[2] < NEAR_FT) return;
      if (a[2] < NEAR_FT) a = lerp3(a, b, (NEAR_FT - a[2]) / (b[2] - a[2]));
      else if (b[2] < NEAR_FT) b = lerp3(b, a, (NEAR_FT - b[2]) / (a[2] - b[2]));
      const prim = { t: 'line', pts: [roundPt(cameraToImage(cam, a)), roundPt(cameraToImage(cam, b))], stroke: style.stroke, lw: style.lw || 1 };
      if (style.dash) prim.dash = style.dash.slice();
      grp.prims.push(prim);
    }

    /** Sphere of radius rFt at X, drawn as its (nearly circular) image. */
    function sphere(grp, X, rFt, style) {
      const c = toCamera(cam, X);
      if (c[2] < NEAR_FT + rFt) return;
      const p = cameraToImage(cam, c);
      grp.prims.push(styled({ t: 'circle', c: roundPt(p), r: r1((cam.f * rFt) / c[2]) }, style));
    }

    /** Ellipse lying on the ground (u radius ru, w radius rw). */
    function groundEllipse(grp, u, w, ru, rw, style, n) {
      const pts = [];
      const k = n || 28;
      for (let i = 0; i < k; i++) {
        const t = (2 * Math.PI * i) / k;
        pts.push(onGround(u + ru * Math.cos(t), w + rw * Math.sin(t)));
      }
      poly(grp, pts, style);
    }

    /** Circle lying on a surface map (e.g. a round gable vent). */
    function surfaceCircle(grp, map, a, b, r, style, n) {
      const pts = [];
      const k = n || 24;
      for (let i = 0; i < k; i++) {
        const t = (2 * Math.PI * i) / k;
        pts.push(map(a + r * Math.cos(t), b + r * Math.sin(t)));
      }
      poly(grp, pts, style);
    }

    function rect2(grp, x, y, w, h, fill) { grp.prims.push({ t: 'rect', x: r1(x), y: r1(y), w: r1(w), h: r1(h), fill }); }
    function circle2(grp, x, y, r, fill) { grp.prims.push({ t: 'circle', c: [r1(x), r1(y)], r: r1(r), fill }); }

    function flatten() {
      const out = [];
      for (const layer of LAYERS) {
        const list = groups.filter((grp) => grp.layer === layer);
        if (DEPTH_SORTED[layer]) list.sort((a, b) => b.depth - a.depth || a.seq - b.seq);
        for (const grp of list) for (const p of grp.prims) out.push(p);
      }
      return out;
    }

    return { cam, group, poly, quad, line, sphere, groundEllipse, surfaceCircle, rect2, circle2, flatten };
  }

  // ================================================================ reusable surface details
  /** Faint lap-siding course lines on a surface; spanAt(v) → [aFrom, aTo] or null. */
  function sidingLines(d, grp, map, spanAt, vFrom, vTo) {
    for (let k = Math.ceil(vFrom / COURSE_FT + 1e-9); k * COURSE_FT < vTo - 0.08; k++) {
      const v = k * COURSE_FT;
      const s = spanAt(v);
      if (!s || s[1] - s[0] < 0.05) continue;
      d.line(grp, map(s[0], v), map(s[1], v), { stroke: C.sidingLine, lw: 1 });
      d.line(grp, map(s[0], v + 0.07), map(s[1], v + 0.07), { stroke: C.sidingLit, lw: 0.8 });
    }
  }

  /** Shingle texture on a roof slope: course lines, staggered tab gaps and a few weathered patches. */
  function shingles(d, grp, map, a0, a1, slopeFt, seed) {
    const rand = g.rng(seed);
    const courses = Math.floor(slopeFt / COURSE_FT);
    for (let k = 0; k <= courses; k++) {
      const b0 = k * COURSE_FT;
      const b1 = Math.min(slopeFt, b0 + COURSE_FT);
      if (b1 - b0 < 0.05) continue;
      if (k > 0) d.line(grp, map(a0, b0), map(a1, b0), { stroke: C.roofLine, lw: 0.9 });
      // Tab gaps every ~3 ft, offset half a tab on alternate courses.
      for (let a = a0 + (k % 2 ? 1.5 : 0.2) + rand() * 0.6; a < a1 - 0.3; a += 3 + rand() * 0.3) {
        if (rand() < 0.55) d.line(grp, map(a, b0), map(a, b1), { stroke: C.roofTab, lw: 0.7 });
      }
      // Weathered patches: slightly lighter or darker shingle runs.
      if (rand() < 0.5) {
        const pa = a0 + rand() * (a1 - a0 - 4);
        const len = 1.5 + rand() * 4;
        const tone = rand() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
        d.quad(grp, map, pa, b0, Math.min(a1, pa + len), b1, { fill: tone });
      }
    }
  }

  /** Window: shutters, casing, sash, glass, 6-over-6 grilles and sill. Outline (u0..u1, v0..v1) is the sash. */
  function windowUnit(d, grp, map, u0, u1, v0, v1) {
    for (const [sa, sb] of [[u0 - 1.85, u0 - 0.38], [u1 + 0.38, u1 + 1.85]]) {
      d.quad(grp, map, sa, v0 - 0.1, sb, v1 + 0.15, { fill: C.shutter });
      const mid = (v0 + v1) / 2 + 0.02;
      for (let v = v0 + 0.25; v < v1 - 0.1; v += 0.3) {
        if (Math.abs(v - mid) < 0.18) continue;
        d.line(grp, map(sa + 0.18, v), map(sb - 0.18, v), { stroke: C.shutterLine, lw: 1 });
      }
      d.quad(grp, map, sa + 0.12, mid - 0.08, sb - 0.12, mid + 0.08, { fill: 'rgba(255,255,255,0.08)' });
    }
    // Casing with a header cap and its shadow line.
    d.quad(grp, map, u0 - 0.34, v0 - 0.02, u1 + 0.34, v1 + 0.34, { fill: C.trim });
    d.quad(grp, map, u0 - 0.48, v1 + 0.34, u1 + 0.48, v1 + 0.5, { fill: C.trimShade });
    d.line(grp, map(u0 - 0.48, v1 + 0.34), map(u1 + 0.48, v1 + 0.34), { stroke: C.trimEdge, lw: 0.8 });
    d.quad(grp, map, u0, v0, u1, v1, { fill: C.sash, stroke: 'rgba(120,125,130,0.55)', lw: 0.8 });
    // Two sashes of glass, each with a 3 × 2 grille.
    const meet = (v0 + v1) / 2;
    const glass = { from: map((u0 + u1) / 2, v1), to: map((u0 + u1) / 2, v0), stops: [[0, C.glassTop], [0.55, '#c3dcec'], [1, C.glassBottom]] };
    for (const [ga, gb] of [[meet + 0.1, v1 - 0.17], [v0 + 0.17, meet - 0.1]]) {
      const ua = u0 + 0.17, ub = u1 - 0.17;
      d.quad(grp, map, ua, ga, ub, gb, { fill: glass });
      // Sky reflection: a soft diagonal band across the pane.
      const h = gb - ga;
      d.poly(grp, [map(ua + 0.3, gb), map(ua + 1.25, gb), map(ua + 0.55, ga), map(ua, ga + h * 0.3), map(ua, ga + h * 0.85)], { fill: C.glassShine });
      for (let i = 1; i < 3; i++) {
        const u = ua + ((ub - ua) * i) / 3;
        d.line(grp, map(u, ga), map(u, gb), { stroke: C.sash, lw: 1.6 });
      }
      d.line(grp, map(ua, (ga + gb) / 2), map(ub, (ga + gb) / 2), { stroke: C.sash, lw: 1.6 });
      d.line(grp, map(ua, gb), map(ub, gb), { stroke: 'rgba(60,70,80,0.35)', lw: 1 });
    }
    // Sill.
    d.quad(grp, map, u0 - 0.55, v0 - 0.22, u1 + 0.55, v0 - 0.02, { fill: C.trimShade });
    d.line(grp, map(u0 - 0.55, v0 - 0.22), map(u1 + 0.55, v0 - 0.22), { stroke: 'rgba(60,70,80,0.4)', lw: 1 });
  }

  /** Wall-mounted lantern (unlit in daylight), centered at (u, v). */
  function lantern(d, grp, map, u, v) {
    d.quad(grp, map, u - 0.1, v - 0.5, u + 0.1, v + 0.45, { fill: C.lamp });
    d.quad(grp, map, u - 0.22, v - 0.3, u + 0.22, v + 0.25, { fill: C.lamp });
    d.quad(grp, map, u - 0.15, v - 0.22, u + 0.15, v + 0.18, { fill: C.lampGlass });
    d.poly(grp, [map(u - 0.3, v + 0.25), map(u + 0.3, v + 0.25), map(u, v + 0.5)], { fill: C.lamp });
  }

  /** Exterior outlet with a weatherproof cover, centered at (u, v). */
  function outletBox(d, grp, map, u, v) {
    d.quad(grp, map, u - 0.19, v - 0.25, u + 0.19, v + 0.25, { fill: C.outlet, stroke: C.outletEdge, lw: 0.8 });
    d.quad(grp, map, u - 0.1, v - 0.13, u + 0.1, v + 0.13, { fill: '#d4d1c9' });
  }

  // ================================================================ scene parts
  function drawSky(d) {
    const grp = d.group('sky');
    const hy = horizonY(d.cam);
    d.rect2(grp, 0, 0, WIDTH, hy + 4, { linear: [0, 0, 0, r1(hy)], stops: [[0, C.skyTop], [0.55, C.skyMid], [1, C.skyLow]] });
    // Soft cumulus: shaded under-layer, then the lit puffs.
    const clouds = [
      { x: 255, y: 150, s: 1.0 }, { x: 790, y: 95, s: 0.72 }, { x: 1300, y: 185, s: 1.08 },
      { x: 1085, y: 318, s: 0.5 }, { x: 520, y: 300, s: 0.42 },
    ];
    const puffs = [[-118, 16, 26], [-74, 6, 40], [-30, -14, 52], [22, -26, 60], [74, -8, 46], [114, 10, 32], [0, 14, 40], [-50, 18, 30], [56, 18, 32]];
    for (const cl of clouds) {
      const cg = d.group('sky');
      for (const p of puffs) d.circle2(cg, cl.x + p[0] * cl.s, cl.y + (p[1] + 9) * cl.s, p[2] * cl.s, C.cloudShade);
      for (const p of puffs) d.circle2(cg, cl.x + p[0] * cl.s - 3 * cl.s, cl.y + p[1] * cl.s - 2 * cl.s, p[2] * cl.s * 0.94, C.cloud);
    }
  }

  function drawLawnBase(d) {
    const grp = d.group('ground');
    const hy = horizonY(d.cam);
    d.rect2(grp, 0, hy, WIDTH, HEIGHT - hy, { linear: [0, r1(hy), 0, HEIGHT], stops: [[0, C.lawnFar], [0.25, C.lawnMid], [1, C.lawnNear]] });
  }

  /**
   * Distant tree line behind the lots: hazy broadleaf crowns (clusters of puffs) and a few conifers.
   * Farther trees are paler and bluer (aerial perspective). Nothing here is ever traced.
   */
  function drawBackground(d) {
    const rand = g.rng(41);
    // Low hedge row far behind the lots, with a bumpy top.
    const hedge = d.group('far', [40, 2, -150]);
    const top = [];
    for (let u = -320; u <= 380; u += 7) top.push([u, 4 + rand() * 3, -150]);
    d.poly(hedge, top.concat([onGround(380, -150), onGround(-320, -150)]), { fill: C.hedge });

    const trees = [];
    for (let i = 0; i < 28; i++) trees.push({ u: -290 + i * 17 + rand() * 10, w: -70 - rand() * 75, h: 30 + rand() * 14, kind: 'leaf' });
    for (const u of [-150, -96, -22, 68, 128]) trees.push({ u: u + rand() * 8, w: -88 - rand() * 30, h: 40 + rand() * 10, kind: 'conifer' });
    for (const t of trees) {
      const grp = d.group('far', [t.u, t.h / 2, t.w]);
      const haze = g.clamp((-t.w - 70) / 75, 0, 1); // 0 near → 1 far
      if (t.kind === 'conifer') {
        const fill = haze > 0.5 ? '#6f8f86' : '#5f8277';
        for (let k = 0; k < 4; k++) {
          const v0 = t.h * (0.12 + k * 0.2), v1 = v0 + t.h * 0.42, half = t.h * (0.2 - k * 0.04);
          d.poly(grp, [[t.u - half, v0, t.w], [t.u + half, v0, t.w], [t.u, v1, t.w]], { fill });
        }
        continue;
      }
      // Farther crowns take the paler, bluer tones.
      const tone = C.farTree[Math.min(2, Math.floor(haze * 2 + rand() * 1.2))];
      const r = t.h * 0.3;
      const cy = t.h - r * 1.05;
      // Crown silhouette: a ring of puffs around a core, then light (upper left) and shade (lower right) puffs.
      d.sphere(grp, [t.u, cy, t.w], r * 0.95, { fill: tone });
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + rand() * 0.4;
        d.sphere(grp, [t.u + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.62, t.w], r * (0.36 + rand() * 0.14), { fill: tone });
      }
      d.sphere(grp, [t.u, cy - r * 0.95, t.w], r * 0.5, { fill: tone });
      for (let k = 0; k < 3; k++) {
        d.sphere(grp, [t.u - r * (0.15 + 0.3 * rand()), cy + r * (0.15 + 0.4 * rand()), t.w + 1], r * (0.22 + 0.1 * rand()), { fill: 'rgba(205,225,210,0.13)' });
      }
      d.sphere(grp, [t.u + r * 0.35, cy - r * 0.45, t.w + 1], r * 0.45, { fill: 'rgba(50,75,60,0.12)' });
    }
  }

  function drawGround(d) {
    const M = MODEL;
    const grp = d.group('ground');
    // Mowing stripes on the front lawn and a few soft patches of lighter and darker grass.
    for (let k = 0; k < 6; k += 2) d.quad(grp, onGround, -70, k * 3, 110, (k + 1) * 3, { fill: 'rgba(255,255,255,0.05)' });
    const lawnRand = g.rng(71);
    for (let i = 0; i < 16; i++) {
      const u = -75 + lawnRand() * 190, w = -40 + lawnRand() * 56;
      d.groundEllipse(grp, u, w, 4 + lawnRand() * 7, 1.5 + lawnRand() * 3, { fill: lawnRand() < 0.5 ? 'rgba(55,95,35,0.10)' : 'rgba(215,235,160,0.10)' }, 18);
    }
    // Street, gutter pan and curb.
    // The street recedes sideways, so its shading is a plain top-to-bottom image gradient.
    const curbY = projectWorld(d.cam, onGround(40, M.streetW))[1];
    d.poly(grp, [onGround(-420, M.streetW), onGround(520, M.streetW), onGround(520, 140), onGround(-420, 140)], {
      fill: { linear: [0, r1(curbY - 40), 0, HEIGHT], stops: [[0, C.asphaltFar], [1, C.asphaltNear]] },
    });
    const rand = g.rng(97);
    for (let i = 0; i < 9; i++) {
      // Sealed cracks: thin dark wiggles across the asphalt.
      const u = -30 + rand() * 120, w = M.streetW + 2 + rand() * 18;
      const pts = [onGround(u, w)];
      for (let k = 0; k < 3; k++) pts.push(onGround(u + (k + 1) * (1.5 + rand() * 2), w + (rand() - 0.5) * 2.5));
      for (let k = 1; k < pts.length; k++) d.line(grp, pts[k - 1], pts[k], { stroke: 'rgba(35,38,42,0.18)', lw: 1 });
    }
    d.quad(grp, onGround, -420, M.curb.w1, 520, M.streetW, { fill: C.gutterPan });
    d.quad(grp, onGround, -420, M.curb.w0, 520, M.curb.w1, { fill: C.curb });
    d.line(grp, onGround(-420, M.curb.w1), onGround(520, M.curb.w1), { stroke: 'rgba(70,70,70,0.4)', lw: 1 });
    // Sidewalk with control joints every 5 ft.
    d.quad(grp, onGround, -420, M.sidewalk.w0, 520, M.sidewalk.w1, {
      fill: { from: onGround(40, M.sidewalk.w0), to: onGround(40, M.sidewalk.w1), stops: [[0, C.concreteFar], [1, C.concrete]] },
    });
    for (let u = -80; u <= 150; u += 5) d.line(grp, onGround(u, M.sidewalk.w0), onGround(u, M.sidewalk.w1), { stroke: C.joint, lw: 0.9 });
    d.line(grp, onGround(-420, M.sidewalk.w1), onGround(520, M.sidewalk.w1), { stroke: 'rgba(110,105,95,0.35)', lw: 1 });
    // Driveway from the garage to the curb.
    const dw = M.driveway;
    d.quad(grp, onGround, dw.u0, M.garage.w, dw.u1, M.curb.w0, {
      fill: { from: onGround(45, M.garage.w), to: onGround(45, M.curb.w0), stops: [[0, C.concreteFar], [1, C.concreteLight]] },
    });
    for (const w of [5, 13, M.sidewalk.w0, M.sidewalk.w1]) d.line(grp, onGround(dw.u0, w), onGround(dw.u1, w), { stroke: C.joint, lw: 1 });
    d.line(grp, onGround((dw.u0 + dw.u1) / 2, M.garage.w), onGround((dw.u0 + dw.u1) / 2, M.sidewalk.w0), { stroke: C.joint, lw: 1 });
    // Tire marks: two faint darker bands.
    for (const u of [40, 49]) d.quad(grp, onGround, u, M.garage.w + 0.5, u + 1.6, M.sidewalk.w0, { fill: 'rgba(90,85,75,0.07)' });
    // Walkway from the door to the sidewalk, and the stoop.
    const wk = M.walkway;
    d.quad(grp, onGround, wk.u0, wk.w0, wk.u1, wk.w1, {
      fill: { from: onGround(17, 0), to: onGround(17, 18), stops: [[0, C.concreteFar], [1, C.concrete]] },
    });
    for (const w of [4.5, 9, 13.5]) d.line(grp, onGround(wk.u0, w), onGround(wk.u1, w), { stroke: C.joint, lw: 1 });
    d.quad(grp, onGround, 14.4, 0, 19.6, 2.6, { fill: C.concreteLight, stroke: 'rgba(120,112,100,0.5)', lw: 1 });
    // Soft contact shadow along the house base.
    d.quad(grp, onGround, M.main.u0 - 0.3, 0, M.main.u1, 1.6, {
      fill: { from: onGround(17, 0), to: onGround(17, 1.6), stops: [[0, 'rgba(30,45,25,0.30)'], [1, 'rgba(30,45,25,0)']] },
    });
    d.quad(grp, onGround, M.garage.u0, M.garage.w, M.garage.u1, M.garage.w + 1.2, {
      fill: { from: onGround(45, M.garage.w), to: onGround(45, M.garage.w + 1.2), stops: [[0, 'rgba(40,40,35,0.22)'], [1, 'rgba(40,40,35,0)']] },
    });
    // Plant shadows (sun from the upper left, in front of the house).
    const t = M.tree;
    d.groundEllipse(grp, t.u + 5, t.w - 3.5, 9.5, 5.5, { fill: C.shadowSoft });
    d.groundEllipse(grp, t.u + 3.5, t.w - 2.2, 6.5, 3.6, { fill: C.shadowSoft });
    d.groundEllipse(grp, t.u + 0.25, t.w - 0.15, 0.9, 0.5, { fill: C.shadow }, 16);
    for (const u of M.bushes) d.groundEllipse(grp, u + 0.6, M.bushW - 0.2, 2.5, 1.7, { fill: C.shadow });
  }

  /** Main roof front slope (the back slope faces away from the camera). */
  function drawMainRoof(d) {
    const M = MODEL.main;
    const grp = d.group('house', onMainRoof((M.u0 + M.u1) / 2, MAIN_SLOPE_FT / 2));
    d.quad(grp, onMainRoof, M.u0, 0, M.u1, MAIN_SLOPE_FT, {
      fill: { from: onMainRoof(17, 0), to: onMainRoof(17, MAIN_SLOPE_FT), stops: [[0, '#565b62'], [1, '#4a4f56']] },
    });
    shingles(d, grp, onMainRoof, M.u0, M.u1, MAIN_SLOPE_FT, 11);
    // Ridge cap and the left rake edge.
    d.quad(grp, onMainRoof, M.u0, MAIN_SLOPE_FT - 0.4, M.u1, MAIN_SLOPE_FT, { fill: C.roofRidge });
    d.line(grp, onMainRoof(M.u0, MAIN_SLOPE_FT), onMainRoof(M.u1, MAIN_SLOPE_FT), { stroke: 'rgba(255,255,255,0.18)', lw: 1 });
    d.line(grp, onMainRoof(M.u0, 0), onMainRoof(M.u0, MAIN_SLOPE_FT), { stroke: C.trim, lw: 2.2 });
  }

  /** Right gable end of the main block: the strip beside the garage and the triangle above its roof. */
  function drawMainSide(d) {
    const M = MODEL.main, G = MODEL.garage;
    const setback = -G.w; // 4 ft of wall between the front corner and the garage
    const grp = d.group('house', onMainSide(M.depth / 2, 12));
    d.quad(grp, onMainSide, 0, 0, setback, M.wallH, { fill: C.sidingSide });
    d.poly(grp, [onMainSide(0, M.wallH), onMainSide(M.depth / 2, MAIN_RIDGE_V), onMainSide(M.depth, M.wallH)], { fill: C.sidingSide });
    const halfSpan = (v) => (v <= M.wallH ? [0.4, setback - 0.3] : [(v - M.wallH) / PITCH, M.depth - (v - M.wallH) / PITCH]);
    sidingLines(d, grp, onMainSide, halfSpan, MODEL.foundationH, MAIN_RIDGE_V - 0.4);
    d.quad(grp, onMainSide, 0, 0, setback, MODEL.foundationH, { fill: '#aaa59b' });
    d.quad(grp, onMainSide, 0, MODEL.foundationH, 0.42, M.wallH, { fill: C.trimShade });
    d.quad(grp, onMainSide, setback - 0.35, MODEL.foundationH, setback, M.wallH, { fill: C.trimShade });
    // Rake boards under the roof edge.
    const rb = 0.45;
    d.poly(grp, [
      onMainSide(0, M.wallH), onMainSide(M.depth / 2, MAIN_RIDGE_V), onMainSide(M.depth, M.wallH),
      onMainSide(M.depth - rb / PITCH, M.wallH), onMainSide(M.depth / 2, MAIN_RIDGE_V - rb), onMainSide(rb / PITCH, M.wallH),
    ], { fill: C.trimShade });
    d.line(grp, onMainSide(0, M.wallH), onMainSide(M.depth / 2, MAIN_RIDGE_V), { stroke: '#3e4248', lw: 1.6 });
  }

  /** Main front wall with the entry gable, windows, door, outlet and trim. */
  function drawMainFront(d) {
    const M = MODEL.main, GB = MODEL.gable, D = MODEL.door;
    const grp = d.group('house', onFront((M.u0 + M.u1) / 2, M.wallH / 2));
    const F = onFront;
    const gableMid = (GB.u0 + GB.u1) / 2;
    d.quad(grp, F, M.u0, 0, M.u1, M.wallH, { fill: C.siding });
    d.poly(grp, [F(GB.u0, M.wallH), F(gableMid, GB.peakV), F(GB.u1, M.wallH)], { fill: C.siding });
    // Siding courses on the wall and the gable.
    sidingLines(d, grp, F, () => [M.u0 + 0.45, M.u1 - 0.45], MODEL.foundationH, M.wallH - MODEL.fasciaH);
    const gableSpan = (v) => [GB.u0 + (v - M.wallH) / PITCH + 1.1, GB.u1 - (v - M.wallH) / PITCH - 1.1];
    sidingLines(d, grp, F, gableSpan, M.wallH, GB.peakV - 0.9);
    // Shade under the eave and under the gable rakes.
    d.quad(grp, F, M.u0, M.wallH - 1.4, M.u1, M.wallH - MODEL.fasciaH, {
      fill: { from: F(17, M.wallH - MODEL.fasciaH), to: F(17, M.wallH - 1.4), stops: [[0, 'rgba(25,35,45,0.30)'], [1, 'rgba(25,35,45,0)']] },
    });
    d.poly(grp, [F(GB.u0 + 1, M.wallH), F(gableMid, GB.peakV - 0.5), F(GB.u1 - 1, M.wallH), F(GB.u1 - 2.6, M.wallH), F(gableMid, GB.peakV - 1.3), F(GB.u0 + 2.6, M.wallH)], {
      fill: 'rgba(25,35,45,0.12)',
    });
    // Foundation and corner boards.
    d.quad(grp, F, M.u0, 0, M.u1, MODEL.foundationH, { fill: C.foundation });
    d.line(grp, F(M.u0, MODEL.foundationH), F(M.u1, MODEL.foundationH), { stroke: C.foundationLine, lw: 1 });
    d.quad(grp, F, M.u0, MODEL.foundationH, M.u0 + 0.45, M.wallH, { fill: C.trim });
    d.quad(grp, F, M.u1 - 0.45, MODEL.foundationH, M.u1, M.wallH, { fill: C.trim });
    // Windows.
    for (const w of MODEL.windows) windowUnit(d, grp, F, w.u0, w.u1, MODEL.windowSill, MODEL.windowHead);
    // Front door: casing, six-panel slab, knob, lantern.
    d.quad(grp, F, D.u0 - 0.5, 0, D.u1 + 0.5, D.h + 0.45, { fill: C.trim });
    d.quad(grp, F, D.u0 - 0.65, D.h + 0.45, D.u1 + 0.65, D.h + 0.65, { fill: C.trimShade });
    d.line(grp, F(D.u0 - 0.65, D.h + 0.45), F(D.u1 + 0.65, D.h + 0.45), { stroke: C.trimEdge, lw: 0.8 });
    d.quad(grp, F, D.u0, 0, D.u1, D.h, { fill: C.door, stroke: 'rgba(40,15,10,0.6)', lw: 1 });
    const pw = (D.u1 - D.u0 - 0.9) / 2;
    for (const [pv0, pv1] of [[0.45, 2.35], [2.75, 4.85], [5.2, D.h - 0.35]]) {
      for (const pu of [D.u0 + 0.3, D.u0 + 0.6 + pw]) {
        d.quad(grp, F, pu, pv0, pu + pw, pv1, { fill: C.doorPanel });
        d.line(grp, F(pu, pv1), F(pu + pw, pv1), { stroke: C.doorShadow, lw: 1 });
        d.line(grp, F(pu, pv0), F(pu, pv1), { stroke: C.doorShadow, lw: 1 });
        d.line(grp, F(pu, pv0), F(pu + pw, pv0), { stroke: C.doorLit, lw: 1 });
        d.line(grp, F(pu + pw, pv0), F(pu + pw, pv1), { stroke: C.doorLit, lw: 1 });
      }
    }
    d.surfaceCircle(grp, F, D.u1 - 0.32, 3.2, 0.1, { fill: C.brass }, 10);
    lantern(d, grp, F, D.u0 - 1.05, 5.75);
    outletBox(d, grp, F, MODEL.porchOutlet[0], MODEL.porchOutlet[1]);
    // Downspout at the left corner.
    d.quad(grp, F, M.u0 + 0.1, 0.25, M.u0 + 0.38, M.wallH - MODEL.fasciaH, { fill: C.trimShade, stroke: 'rgba(90,95,100,0.35)', lw: 0.8 });
    d.quad(grp, F, M.u0 + 0.1, 0.05, M.u0 + 0.75, 0.3, { fill: C.trimShade });
    // Fascia / gutter along the whole eave (it runs straight across the gable base).
    d.quad(grp, F, M.u0, M.wallH - MODEL.fasciaH, M.u1, M.wallH, { fill: C.trim });
    d.line(grp, F(M.u0, M.wallH - MODEL.fasciaH), F(M.u1, M.wallH - MODEL.fasciaH), { stroke: C.trimEdge, lw: 0.9 });
    d.line(grp, F(M.u0, M.wallH), F(M.u1, M.wallH), { stroke: '#3e4248', lw: 1.3 });
    // Gable rake boards, the roof edge above them, and a round louvered vent.
    const rb = 0.5;
    d.poly(grp, [
      F(GB.u0, M.wallH), F(gableMid, GB.peakV), F(GB.u1, M.wallH),
      F(GB.u1 - rb / PITCH, M.wallH), F(gableMid, GB.peakV - rb), F(GB.u0 + rb / PITCH, M.wallH),
    ], { fill: C.trim });
    d.line(grp, F(GB.u0 + rb / PITCH, M.wallH), F(gableMid, GB.peakV - rb), { stroke: C.trimEdge, lw: 0.8 });
    d.line(grp, F(gableMid, GB.peakV - rb), F(GB.u1 - rb / PITCH, M.wallH), { stroke: C.trimEdge, lw: 0.8 });
    d.line(grp, F(GB.u0 - 0.2, M.wallH - 0.1), F(gableMid, GB.peakV), { stroke: '#3e4248', lw: 1.6 });
    d.line(grp, F(gableMid, GB.peakV), F(GB.u1 + 0.2, M.wallH - 0.1), { stroke: '#3e4248', lw: 1.6 });
    d.surfaceCircle(grp, F, gableMid, 11.75, 0.72, { fill: C.trim });
    d.surfaceCircle(grp, F, gableMid, 11.75, 0.55, { fill: '#55626c' });
    for (let k = -2; k <= 2; k++) {
      const v = 11.75 + k * 0.18;
      const half = Math.sqrt(Math.max(0, 0.55 * 0.55 - (k * 0.18) ** 2)) - 0.03;
      d.line(grp, F(gableMid - half, v), F(gableMid + half, v), { stroke: 'rgba(230,235,238,0.7)', lw: 1 });
    }
  }

  /** Garage roof front slope. */
  function drawGarageRoof(d) {
    const G = MODEL.garage;
    const grp = d.group('house', onGarageRoof((G.u0 + G.u1) / 2, GARAGE_SLOPE_FT / 2));
    d.quad(grp, onGarageRoof, G.u0, 0, G.u1, GARAGE_SLOPE_FT, {
      fill: { from: onGarageRoof(45, 0), to: onGarageRoof(45, GARAGE_SLOPE_FT), stops: [[0, '#565b62'], [1, '#4b5057']] },
    });
    shingles(d, grp, onGarageRoof, G.u0, G.u1, GARAGE_SLOPE_FT, 23);
    d.quad(grp, onGarageRoof, G.u0, GARAGE_SLOPE_FT - 0.4, G.u1, GARAGE_SLOPE_FT, { fill: C.roofRidge });
    d.line(grp, onGarageRoof(G.u0, GARAGE_SLOPE_FT), onGarageRoof(G.u1, GARAGE_SLOPE_FT), { stroke: 'rgba(255,255,255,0.18)', lw: 1 });
    d.line(grp, onGarageRoof(G.u1, 0), onGarageRoof(G.u1, GARAGE_SLOPE_FT), { stroke: C.trim, lw: 2.2 });
    // Where the garage roof meets the main wall: a dark flashing line.
    d.line(grp, onGarageRoof(G.u0, 0), onGarageRoof(G.u0, GARAGE_SLOPE_FT), { stroke: 'rgba(30,32,36,0.6)', lw: 1.4 });
  }

  /** Garage front wall: siding, double garage door, lanterns, outlet, gutter and downspout. */
  function drawGarageFront(d) {
    const G = MODEL.garage, GD = MODEL.garageDoor;
    const grp = d.group('house', onGarage((G.u0 + G.u1) / 2, G.wallH / 2));
    const W = onGarage;
    d.quad(grp, W, G.u0, 0, G.u1, G.wallH, { fill: C.siding });
    sidingLines(d, grp, W, () => [G.u0 + 0.4, G.u1 - 0.45], MODEL.foundationH, G.wallH - MODEL.fasciaH);
    d.quad(grp, W, G.u0, G.wallH - 1.3, G.u1, G.wallH - MODEL.fasciaH, {
      fill: { from: W(45, G.wallH - MODEL.fasciaH), to: W(45, G.wallH - 1.3), stops: [[0, 'rgba(25,35,45,0.30)'], [1, 'rgba(25,35,45,0)']] },
    });
    d.quad(grp, W, G.u0, 0, G.u1, MODEL.foundationH, { fill: C.foundation });
    d.line(grp, W(G.u0, MODEL.foundationH), W(G.u1, MODEL.foundationH), { stroke: C.foundationLine, lw: 1 });
    d.quad(grp, W, G.u0, MODEL.foundationH, G.u0 + 0.35, G.wallH, { fill: C.trimShade });
    d.quad(grp, W, G.u1 - 0.45, MODEL.foundationH, G.u1, G.wallH, { fill: C.trim });
    // Door casing, slab, sections, raised panels and a row of windows in the top section.
    d.quad(grp, W, GD.u0 - 0.45, 0, GD.u1 + 0.45, GD.h + 0.45, { fill: C.trim });
    d.quad(grp, W, GD.u0, 0, GD.u1, GD.h, { fill: C.garageDoor, stroke: 'rgba(110,110,100,0.6)', lw: 1 });
    const sec = GD.h / 4;
    const cols = 8, gap = 0.26;
    const pw = (GD.u1 - GD.u0 - gap * (cols + 1)) / cols;
    for (let s = 0; s < 4; s++) {
      const v0 = s * sec + 0.3, v1 = (s + 1) * sec - 0.3;
      if (s > 0) d.line(grp, W(GD.u0, s * sec), W(GD.u1, s * sec), { stroke: 'rgba(110,110,100,0.55)', lw: 1 });
      if (s === 3) {
        // Four windows, each two panels wide.
        const glass = { from: W(45, v1), to: W(45, v0), stops: [[0, C.garageGlassTop], [1, C.garageGlassBottom]] };
        for (let k = 0; k < 4; k++) {
          const a = GD.u0 + gap + k * 2 * (pw + gap);
          d.quad(grp, W, a, v0, a + 2 * pw + gap, v1, { fill: glass, stroke: 'rgba(80,90,95,0.7)', lw: 1 });
          d.line(grp, W(a + 0.15, v1 - 0.1), W(a + 0.9, v0 + 0.1), { stroke: 'rgba(255,255,255,0.25)', lw: 2 });
        }
        continue;
      }
      for (let k = 0; k < cols; k++) {
        const a = GD.u0 + gap + k * (pw + gap);
        d.quad(grp, W, a, v0, a + pw, v1, { fill: C.garagePanel });
        d.line(grp, W(a, v1), W(a + pw, v1), { stroke: 'rgba(120,118,108,0.55)', lw: 1 });
        d.line(grp, W(a, v0), W(a + pw, v0), { stroke: 'rgba(255,255,255,0.9)', lw: 1 });
      }
    }
    d.quad(grp, W, GD.u0, GD.h - 0.5, GD.u1, GD.h, {
      fill: { from: W(45, GD.h), to: W(45, GD.h - 0.5), stops: [[0, 'rgba(40,40,35,0.22)'], [1, 'rgba(40,40,35,0)']] },
    });
    lantern(d, grp, W, GD.u0 - 1.25, 7.55);
    lantern(d, grp, W, GD.u1 + 1.25, 7.55);
    outletBox(d, grp, W, MODEL.garageOutlet[0], MODEL.garageOutlet[1]);
    // Gutter along the eave and a downspout at the right corner.
    d.quad(grp, W, G.u0, G.wallH - MODEL.fasciaH, G.u1, G.wallH, { fill: C.trim });
    d.line(grp, W(G.u0, G.wallH - MODEL.fasciaH), W(G.u1, G.wallH - MODEL.fasciaH), { stroke: C.trimEdge, lw: 0.9 });
    d.line(grp, W(G.u0, G.wallH), W(G.u1, G.wallH), { stroke: '#3e4248', lw: 1.3 });
    d.quad(grp, W, G.u1 - 0.42, 0.25, G.u1 - 0.14, G.wallH - MODEL.fasciaH, { fill: C.trimShade, stroke: 'rgba(90,95,100,0.35)', lw: 0.8 });
    d.quad(grp, W, G.u1 - 0.8, 0.05, G.u1 - 0.14, 0.3, { fill: C.trimShade });
  }

  /** Front-of-house bush: dark silhouette spheres, lit inner layer, highlights and leaf flecks. */
  function drawBush(d, u, index) {
    const w = MODEL.bushW;
    const grp = d.group('front', [u, 1.5, w]);
    const rand = g.rng(301 + index * 17);
    for (const s of BUSH_SPHERES) d.sphere(grp, [u + s[0], s[1], w + s[2]], s[3], { fill: C.bushDark });
    for (const s of BUSH_SPHERES) d.sphere(grp, [u + s[0] - s[3] * 0.18, s[1] + s[3] * 0.18, w + s[2] + 0.2], s[3] * 0.72, { fill: C.bushMid });
    for (const s of BUSH_SPHERES) d.sphere(grp, [u + s[0] - s[3] * 0.32, s[1] + s[3] * 0.38, w + s[2] + 0.3], s[3] * 0.38, { fill: C.bushLit });
    for (let i = 0; i < 16; i++) {
      const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * 1.5;
      const pu = u + Math.cos(a) * rr * 1.2, pv = 1.5 + Math.sin(a) * rr * 0.9;
      const lit = pv > 1.6 && pu < u + 0.5;
      d.sphere(grp, [pu, pv, w + 1.2], 0.1 + rand() * 0.1, { fill: lit ? C.bushHi : 'rgba(25,60,28,0.3)' });
    }
  }

  /** The maple: tapered trunk with two limbs and a layered canopy. */
  function drawTree(d) {
    const T = MODEL.tree;
    const grp = d.group('front', [T.u, 0, T.w]);
    const cam = d.cam;
    const base = [T.u, 0, T.w];
    // Trunk as a billboard facing the camera (level width direction = camera x axis).
    const side = (X, halfFt) => [g.v3add(X, g.v3scale(cam.right, -halfFt)), g.v3add(X, g.v3scale(cam.right, halfFt))];
    const r0 = T.trunkIn / 24; // radius in feet
    const [bl, br] = side(base, r0 * 1.45);
    const [ml, mr] = side([T.u, 0.6, T.w], r0);
    const [tl, tr] = side([T.u, 10.5, T.w], r0 * 0.7);
    const trunkFill = { from: bl, to: br, stops: [[0, C.trunkLit], [0.45, C.trunk], [1, C.trunkDark]] };
    d.poly(grp, [bl, ml, tl, tr, mr, br], { fill: trunkFill });
    d.line(grp, [T.u + 0.05, 1.2, T.w + 0.4], [T.u + 0.02, 5.5, T.w + 0.4], { stroke: 'rgba(40,25,15,0.35)', lw: 1 });
    // Two limbs rising into the canopy.
    for (const [du, v1, lean] of [[-2.6, 11.5, -1], [2.9, 12.2, 1]]) {
      const [a0, a1] = side([T.u + lean * 0.1, 7.4, T.w], 0.22);
      const [b0, b1] = side([T.u + du, v1, T.w - 0.5], 0.1);
      d.poly(grp, [a0, b0, b1, a1], { fill: C.trunk });
    }
    // Canopy: each crown sphere carries a ring of leaf clumps (scalloped silhouette). Layers: dark mass,
    // mid-tone body shifted toward the light (upper left), lit clumps on the sunny side, small highlights.
    const rand = g.rng(509);
    const crowns = CANOPY_SPHERES.slice().sort((a, b) => a[2] - b[2]).map((s) => {
      const clumps = [];
      const n = 6;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + rand() * 0.5;
        clumps.push({ du: Math.cos(a) * s[3] * 0.68, dv: Math.sin(a) * s[3] * 0.68, r: s[3] * (0.4 + rand() * 0.12), a });
      }
      return { s, clumps };
    });
    const at = (s, du, dv, dw) => [T.u + s[0] + du, s[1] + dv, T.w + s[2] + dw];
    // Sunlit side: up and to the left (angle measured from +u, counterclockwise, v up).
    const sunny = (a) => Math.cos(a - 2.2) > 0.25;
    for (const { s, clumps } of crowns) {
      d.sphere(grp, at(s, 0, 0, 0), s[3] * 0.9, { fill: C.leafDark });
      for (const c of clumps) d.sphere(grp, at(s, c.du, c.dv, 0.1), c.r, { fill: C.leafDark });
    }
    for (const { s } of crowns) d.sphere(grp, at(s, -s[3] * 0.16, s[3] * 0.18, 0.5), s[3] * 0.74, { fill: C.leafMid });
    for (const { s, clumps } of crowns) {
      for (const c of clumps) {
        if (sunny(c.a)) d.sphere(grp, at(s, c.du * 0.8 - c.r * 0.12, c.dv * 0.8 + c.r * 0.12, 0.9), c.r * 0.72, { fill: C.leafLit });
      }
    }
    for (const { s, clumps } of crowns) {
      for (const c of clumps) {
        if (sunny(c.a) && rand() < 0.45) d.sphere(grp, at(s, c.du * 0.85 - c.r * 0.25, c.dv * 0.85 + c.r * 0.28, 1.2), c.r * 0.24, { fill: C.leafHi });
      }
    }
  }

  function buildPrimitives(cam) {
    const d = createBuilder(cam);
    drawSky(d);
    drawLawnBase(d);
    drawBackground(d);
    drawGround(d);
    drawMainRoof(d);
    drawMainSide(d);
    drawGarageRoof(d);
    drawMainFront(d);
    drawGarageFront(d);
    MODEL.bushes.forEach((u, i) => drawBush(d, u, i));
    drawTree(d);
    return d.flatten();
  }

  // ================================================================ traced project
  /** Silhouette of a union of image circles, sampled as a star-shaped polygon around `center`. */
  function circleUnionOutline(circles, center, n) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      const dir = [Math.cos(a), Math.sin(a)];
      let best = 0;
      for (const c of circles) {
        // Farthest t with |center + t·dir − c| = r (ray leaves the circle).
        const ox = c.c[0] - center[0], oy = c.c[1] - center[1];
        const along = ox * dir[0] + oy * dir[1];
        const perp2 = ox * ox + oy * oy - along * along;
        const disc = c.r * c.r - perp2;
        if (disc >= 0) best = Math.max(best, along + Math.sqrt(disc));
      }
      pts.push([center[0] + dir[0] * best, center[1] + dir[1] * best]);
    }
    return pts;
  }

  function bushOutline(cam, u) {
    const w = MODEL.bushW;
    const circles = BUSH_SPHERES.map((s) => {
      const c = toCamera(cam, [u + s[0], s[1], w + s[2]]);
      return { c: cameraToImage(cam, c), r: (cam.f * s[3]) / c[2] };
    });
    return circleUnionOutline(circles, projectWorld(cam, [u, 1.4, w]), 12);
  }

  function featureParams(extra) {
    return Object.assign({
      mount: null, diameterIn: null, spiralSpacingIn: null, wrapMode: null, outletId: null,
      reverse: false, overrideWidthFt: null, overrideHeightFt: null,
    }, extra || {});
  }

  /** 3D length of a polyline (closed adds the closing segment). */
  function length3(pts, closed) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += g.v3len(g.v3sub(pts[i], pts[i - 1]));
    if (closed && pts.length > 2) L += g.v3len(g.v3sub(pts[0], pts[pts.length - 1]));
    return L;
  }

  /** Every traced feature: id, type, label, plane, 3D points (or image points for bushes) and truth. */
  function featureDefs(cam) {
    const M = MODEL.main, GB = MODEL.gable, G = MODEL.garage, D = MODEL.door, T = MODEL.tree, WK = MODEL.walkway;
    const gableMid = (GB.u0 + GB.u1) / 2;
    const win = (w) => [onFront(w.u0, MODEL.windowHead), onFront(w.u1, MODEL.windowHead), onFront(w.u1, MODEL.windowSill), onFront(w.u0, MODEL.windowSill)];
    const defs = [
      { id: 'ft_eave', type: 'roofline', label: 'Front eave', planeId: 'pl_front', pts: [onFront(M.u0, M.wallH), onFront(M.u1, M.wallH)] },
      { id: 'ft_garage_gutter', type: 'gutter', label: 'Garage gutter', planeId: 'pl_garage', pts: [onGarage(G.u0, G.wallH), onGarage(G.u1, G.wallH)] },
      { id: 'ft_gable_left', type: 'rake', label: 'Entry gable left', planeId: 'pl_front', pts: [onFront(GB.u0, M.wallH), onFront(gableMid, GB.peakV)] },
      { id: 'ft_gable_right', type: 'rake', label: 'Entry gable right', planeId: 'pl_front', pts: [onFront(gableMid, GB.peakV), onFront(GB.u1, M.wallH)] },
      { id: 'ft_roof_rake', type: 'rake', label: 'Main roof left rake', planeId: 'pl_roof', pts: [onMainRoof(M.u0, 0), onMainRoof(M.u0, MAIN_SLOPE_FT)] },
      { id: 'ft_ridge', type: 'ridge', label: 'Ridge', planeId: 'pl_roof', pts: [onMainRoof(M.u0, MAIN_SLOPE_FT), onMainRoof(M.u1, MAIN_SLOPE_FT)] },
      { id: 'ft_window_left', type: 'window', label: 'Window left', planeId: 'pl_front', pts: win(MODEL.windows[0]), closed: true },
      { id: 'ft_window_right', type: 'window', label: 'Window right', planeId: 'pl_front', pts: win(MODEL.windows[1]), closed: true },
      { id: 'ft_door', type: 'door', label: 'Front door', planeId: 'pl_front', pts: [onFront(D.u0, 0), onFront(D.u0, D.h), onFront(D.u1, D.h), onFront(D.u1, 0)] },
    ];
    MODEL.bushes.forEach((u, i) => {
      const xs = BUSH_SPHERES.map((s) => [s[0] - s[3], s[0] + s[3]]);
      const widthFt = Math.max(...xs.map((x) => x[1])) - Math.min(...xs.map((x) => x[0]));
      const heightFt = Math.max(...BUSH_SPHERES.map((s) => s[1] + s[3]));
      defs.push({ id: 'ft_bush_' + (i + 1), type: 'bush', label: 'Bush ' + (i + 1), planeId: 'pl_front', image: bushOutline(cam, u), closed: true, truth: { widthFt: r3(widthFt), heightFt: r3(heightFt) } });
    });
    defs.push(
      { id: 'ft_tree', type: 'tree', label: 'Maple tree', planeId: 'pl_yard', pts: [[T.u, 0, T.w], [T.u, T.canopyBase, T.w]], params: { diameterIn: T.trunkIn } },
      { id: 'ft_walk_left', type: 'walkway', label: 'Walkway left edge', planeId: 'pl_yard', pts: [onGround(WK.u0, 1), onGround(WK.u0, 16)] },
      { id: 'ft_walk_right', type: 'walkway', label: 'Walkway right edge', planeId: 'pl_yard', pts: [onGround(WK.u1, 1), onGround(WK.u1, 16)] },
    );
    return defs;
  }

  const P = (cam, X) => roundPt(projectWorld(cam, X));

  function baseProject(name) {
    return {
      schema: 'lightplan/project',
      version: 1,
      id: 'prj_sample',
      name,
      // Fixed timestamps keep the sample deterministic; the app stamps real times when it saves.
      createdAt: '2026-11-01T12:00:00.000Z',
      updatedAt: '2026-11-01T12:00:00.000Z',
      customer: { name: '', address: '', phone: '', email: '' },
      // roofPitch null: the roof pitch is estimated from the entry gable (part of the accuracy demo).
      settings: { wastePct: 10, roofPitch: null, colorMode: 'warmWhite', customColors: ['#ff3b30', '#34c759'], lengthFormat: 'ft-in' },
      images: [{
        id: 'img_sample', name: 'Sample house', width: WIDTH, height: HEIGHT,
        source: { kind: 'sample', capturedAt: null, attribution: null },
        exif: null,
        camera: { mode: 'auto', presetId: 'phone1x', focalPx: null },
        storageKey: 'sample',
      }],
      activeImageId: 'img_sample',
      planes: [],
      features: [],
      outlets: [],
      circuits: [],
      library: { products: null, config: null },
      pricing: { overrides: {} },
      quote: {
        enabled: false, company: '', laborMethod: 'perFt', ratePerFt: 3.5, ratePerHour: 65, markupPct: 30,
        takedownFee: 150, storageFee: 75, taxPct: 0, validDays: 30, notes: '',
      },
    };
  }

  function wallPlane(id, name, color, rect, refs) {
    return { id, imageId: 'img_sample', name, kind: 'wall', color, rect, refs: refs || [], derived: null };
  }

  function buildTracedProject(cam) {
    const M = MODEL.main, G = MODEL.garage, GD = MODEL.garageDoor, D = MODEL.door, W0 = MODEL.windows[0], SR = MODEL.sidingRef;
    const project = baseProject('Sample house');
    project.planes = [
      wallPlane('pl_front', 'Front wall', '#4f9dff', {
        corners: [P(cam, onFront(M.u0, M.wallH)), P(cam, onFront(M.u1, M.wallH)), P(cam, onFront(M.u1, 0)), P(cam, onFront(M.u0, 0))],
        widthFt: null, heightFt: null, presetId: 'unknown',
      }, [
        { id: 'ref_door_height', kind: 'line', points: [P(cam, onFront(D.u0, 0)), P(cam, onFront(D.u0, D.h))], lengthFt: 80 / 12, presetId: 'door-height', courses: null, quality: 'high' },
        { id: 'ref_window_width', kind: 'line', points: [P(cam, onFront(W0.u0, MODEL.windowHead)), P(cam, onFront(W0.u1, MODEL.windowHead))], lengthFt: 4, presetId: 'custom-line', courses: null, quality: 'high', label: 'Window width (tape)' },
      ]),
      wallPlane('pl_garage', 'Garage wall', '#b388ff', {
        corners: [P(cam, onGarage(GD.u0, GD.h)), P(cam, onGarage(GD.u1, GD.h)), P(cam, onGarage(GD.u1, 0)), P(cam, onGarage(GD.u0, 0))],
        widthFt: 16, heightFt: 7, presetId: 'garage-double',
      }, [
        { id: 'ref_siding', kind: 'line', points: [P(cam, onGarage(SR.u, SR.v0)), P(cam, onGarage(SR.u, SR.v0 + SR.courses * COURSE_FT))], lengthFt: (SR.courses * 5) / 12, presetId: 'siding-5', courses: SR.courses, quality: 'medium' },
      ]),
      {
        id: 'pl_roof', imageId: 'img_sample', name: 'Main roof', kind: 'roof', color: '#ff8a3d', rect: null, refs: [],
        derived: { parentPlaneId: 'pl_front', line: [P(cam, onFront(M.u0, M.wallH)), P(cam, onFront(M.u1, M.wallH))], pitch: null },
      },
      {
        id: 'pl_yard', imageId: 'img_sample', name: 'Front yard', kind: 'ground', color: '#4cc38a', rect: null, refs: [],
        derived: { parentPlaneId: 'pl_front', line: [P(cam, onFront(M.u0, 0)), P(cam, onFront(M.u1, 0))], pitch: null },
      },
    ];
    const groundTruth = {};
    project.features = featureDefs(cam).map((def) => {
      groundTruth[def.id] = def.truth || (def.type === 'tree' ? r3(def.pts[1][1] - def.pts[0][1]) : r3(length3(def.pts, !!def.closed)));
      return {
        id: def.id, imageId: 'img_sample', planeId: def.planeId, type: def.type, label: def.label,
        points: def.image ? def.image.map(roundPt) : def.pts.map((X) => P(cam, X)),
        closed: !!def.closed, overrideFt: null, productId: null, color: null,
        params: featureParams(def.params),
      };
    });
    project.outlets = [
      { id: 'out_porch', imageId: 'img_sample', planeId: 'pl_front', point: P(cam, onFront(MODEL.porchOutlet[0], MODEL.porchOutlet[1])), label: 'Porch outlet', type: 'exteriorGfci', gfci: true, circuitId: 'cir_porch', receptacles: 2 },
      { id: 'out_garage', imageId: 'img_sample', planeId: 'pl_garage', point: P(cam, onGarage(MODEL.garageOutlet[0], MODEL.garageOutlet[1])), label: 'Garage outlet', type: 'garage', gfci: true, circuitId: 'cir_garage', receptacles: 2 },
    ];
    project.circuits = [
      { id: 'cir_porch', name: 'Porch circuit', breakerAmps: 15, voltage: 120, existingLoadW: 0 },
      { id: 'cir_garage', name: 'Garage circuit', breakerAmps: 20, voltage: 120, existingLoadW: 0 },
    ];
    return { project, groundTruth };
  }

  function buildPracticeProject() {
    const project = baseProject('Sample house (practice)');
    project.planes = [wallPlane('pl_front', 'Front wall', '#4f9dff', null, [])];
    project.circuits = [{ id: 'cir_1', name: 'Circuit 1', breakerAmps: 15, voltage: 120, existingLoadW: 0 }];
    return { project, groundTruth: {} };
  }

  // ================================================================ public API
  /**
   * The sample house. traced (default true): fully traced project; false: same photo with one blank
   * 'Front wall' plane for practice. Always returns fresh objects (callers may mutate them).
   */
  function createSample(opts) {
    const traced = !(isObj(opts) && opts.traced === false);
    const cam = buildCamera();
    const built = traced ? buildTracedProject(cam) : buildPracticeProject();
    return {
      width: WIDTH,
      height: HEIGHT,
      primitives: buildPrimitives(cam),
      project: built.project,
      groundTruth: built.groundTruth,
      camera: {
        f: cam.f, cx: cam.cx, cy: cam.cy, position: cam.pos.slice(),
        yawDeg: CAMERA.yawDeg, tiltDeg: CAMERA.tiltDeg, distanceFt: cam.pos[2],
      },
    };
  }

  // ---------------------------------------------------------------- canvas rendering
  const isPt = (p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]);
  const isPaint = (f) => typeof f === 'string' || (isObj(f) && Array.isArray(f.linear) && f.linear.length === 4 && f.linear.every(isNum) && Array.isArray(f.stops) && f.stops.length > 0);

  function canvasPaint(ctx, fill) {
    if (typeof fill === 'string') return fill;
    if (typeof ctx.createLinearGradient !== 'function') return fill.stops[0][1];
    const [x0, y0, x1, y1] = fill.linear;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const s of fill.stops) {
      if (Array.isArray(s) && isNum(s[0]) && typeof s[1] === 'string') grad.addColorStop(Math.min(1, Math.max(0, s[0])), s[1]);
    }
    return grad;
  }

  function tracePath(ctx, pts, close) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (close) ctx.closePath();
  }

  function strokeWith(ctx, p) {
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = isNum(p.lw) && p.lw > 0 ? p.lw : 1;
    const dashed = Array.isArray(p.dash) && p.dash.length > 0 && p.dash.every(isNum) && typeof ctx.setLineDash === 'function';
    if (dashed) ctx.setLineDash(p.dash);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  function drawOne(ctx, p) {
    if (!isObj(p)) return;
    if (p.t === 'rect') {
      if (![p.x, p.y, p.w, p.h].every(isNum) || !isPaint(p.fill)) return;
      ctx.fillStyle = canvasPaint(ctx, p.fill);
      ctx.fillRect(p.x, p.y, p.w, p.h);
    } else if (p.t === 'poly' || p.t === 'line') {
      if (!Array.isArray(p.pts) || p.pts.length < 2 || !p.pts.every(isPt)) return;
      const close = p.t === 'poly' && p.closed !== false;
      tracePath(ctx, p.pts, close);
      if (p.t === 'poly' && close && isPaint(p.fill)) { ctx.fillStyle = canvasPaint(ctx, p.fill); ctx.fill(); }
      if (typeof p.stroke === 'string') strokeWith(ctx, p);
    } else if (p.t === 'circle') {
      if (!isPt(p.c) || !isNum(p.r) || p.r <= 0) return;
      ctx.beginPath();
      ctx.arc(p.c[0], p.c[1], p.r, 0, Math.PI * 2);
      if (isPaint(p.fill)) { ctx.fillStyle = canvasPaint(ctx, p.fill); ctx.fill(); }
      if (typeof p.stroke === 'string') strokeWith(ctx, p);
    }
  }

  /** Draw primitives on any CanvasRenderingContext2D (only context methods are used). Bad items are skipped. */
  function drawPrimitives(ctx, primitives) {
    if (!ctx || typeof ctx.beginPath !== 'function' || !Array.isArray(primitives)) return;
    if (typeof ctx.save === 'function') ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const p of primitives) {
      try { drawOne(ctx, p); } catch (e) { /* skip a primitive the context rejects */ }
    }
    if (typeof ctx.restore === 'function') ctx.restore();
  }

  // ---------------------------------------------------------------- SVG
  const fmt = (n) => String(Math.round(n * 100) / 100 + 0);
  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** CSS color → SVG color + opacity (rgba() and #rrggbbaa become rgb()/#rrggbb plus an opacity attribute). */
  function svgColor(c) {
    const s = String(c).trim();
    let m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(s);
    if (m) return { color: 'rgb(' + m[1] + ',' + m[2] + ',' + m[3] + ')', opacity: Math.min(1, Math.max(0, parseFloat(m[4]))) };
    m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(s);
    if (m) return { color: '#' + m[1], opacity: parseInt(m[2], 16) / 255 };
    return { color: s, opacity: 1 };
  }

  /** Standalone SVG document for the primitives (gradients become <linearGradient> defs). */
  function toSVG(primitives, width, height) {
    const W = isNum(width) && width > 0 ? width : WIDTH;
    const H = isNum(height) && height > 0 ? height : HEIGHT;
    const defs = [];
    const gradIds = new Map();
    const body = [];

    function paintAttrs(kind, fill) {
      if (!isPaint(fill)) return ' ' + kind + '="none"';
      if (typeof fill === 'string') {
        const c = svgColor(fill);
        return ' ' + kind + '="' + escAttr(c.color) + '"' + (c.opacity < 1 ? ' ' + kind + '-opacity="' + fmt(c.opacity) + '"' : '');
      }
      const key = JSON.stringify(fill);
      let id = gradIds.get(key);
      if (!id) {
        id = 'g' + gradIds.size;
        gradIds.set(key, id);
        const [x1, y1, x2, y2] = fill.linear;
        const stops = fill.stops.filter((s) => Array.isArray(s) && isNum(s[0]) && typeof s[1] === 'string').map((s) => {
          const c = svgColor(s[1]);
          return '<stop offset="' + fmt(Math.min(1, Math.max(0, s[0]))) + '" stop-color="' + escAttr(c.color) + '"' + (c.opacity < 1 ? ' stop-opacity="' + fmt(c.opacity) + '"' : '') + '/>';
        });
        defs.push('<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + fmt(x1) + '" y1="' + fmt(y1) + '" x2="' + fmt(x2) + '" y2="' + fmt(y2) + '">' + stops.join('') + '</linearGradient>');
      }
      return ' ' + kind + '="url(#' + id + ')"';
    }
    function strokeAttrs(p) {
      if (typeof p.stroke !== 'string') return '';
      let s = paintAttrs('stroke', p.stroke) + ' stroke-width="' + fmt(isNum(p.lw) && p.lw > 0 ? p.lw : 1) + '" stroke-linejoin="round" stroke-linecap="round"';
      if (Array.isArray(p.dash) && p.dash.length && p.dash.every(isNum)) s += ' stroke-dasharray="' + p.dash.map(fmt).join(' ') + '"';
      return s;
    }
    const ptsAttr = (pts) => pts.map((q) => fmt(q[0]) + ',' + fmt(q[1])).join(' ');

    for (const p of Array.isArray(primitives) ? primitives : []) {
      if (!isObj(p)) continue;
      if (p.t === 'rect') {
        if (![p.x, p.y, p.w, p.h].every(isNum) || !isPaint(p.fill)) continue;
        body.push('<rect x="' + fmt(p.x) + '" y="' + fmt(p.y) + '" width="' + fmt(Math.abs(p.w)) + '" height="' + fmt(Math.abs(p.h)) + '"' + paintAttrs('fill', p.fill) + '/>');
      } else if (p.t === 'poly' || p.t === 'line') {
        if (!Array.isArray(p.pts) || p.pts.length < 2 || !p.pts.every(isPt)) continue;
        const closed = p.t === 'poly' && p.closed !== false;
        body.push('<' + (closed ? 'polygon' : 'polyline') + ' points="' + ptsAttr(p.pts) + '"' + (closed ? paintAttrs('fill', p.fill) : ' fill="none"') + strokeAttrs(p) + '/>');
      } else if (p.t === 'circle') {
        if (!isPt(p.c) || !isNum(p.r) || p.r <= 0) continue;
        body.push('<circle cx="' + fmt(p.c[0]) + '" cy="' + fmt(p.c[1]) + '" r="' + fmt(p.r) + '"' + paintAttrs('fill', p.fill) + strokeAttrs(p) + '/>');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(W) + '" height="' + fmt(H) + '" viewBox="0 0 ' + fmt(W) + ' ' + fmt(H) + '">' +
      (defs.length ? '<defs>' + defs.join('') + '</defs>' : '') + body.join('') + '</svg>';
  }

  return { SAMPLE_WIDTH: WIDTH, SAMPLE_HEIGHT: HEIGHT, createSample, drawPrimitives, toSVG };
});
