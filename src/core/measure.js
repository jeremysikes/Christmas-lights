/* LightPlan core: measure.
 * Calibration (references, perspective rectangles), plane solutions (wall, roof, ground), feature measurement,
 * confidence scoring and the measureProject() entry point.
 *
 * How a length is measured:
 *  1. Each image gets intrinsics K (camera.resolveCamera: manual → preset → EXIF → rectangle → phone 1×).
 *  2. Each WALL plane gets a homography image px → wall feet [u right, v up]:
 *       rect-known  perspective rectangle of known size (exact, no camera needed for in-plane lengths)
 *       rect-refs   rectangle of unknown size: its true proportions come from K; the scale comes from references
 *                   (an isotropic fit whose extra references are cross-checks; separate horizontal/vertical
 *                   scales only when the references pin the proportions better than K does, or clearly
 *                   disagree with it, in which case the disagreement is reported)
 *       refs-only   no rectangle: a straight-on similarity (ft per px) from references
 *     With a rectangle, the camera pose is recovered from the homography (camera.poseFromHomography).
 *  3. ROOF and GROUND planes are built in 3D from their parent wall's pose: the eave/base line is lifted to
 *     wall coordinates, a sloped (roof) or level (ground) frame is built on it, and its homography is
 *     K·[R·e1, R·e2, R·origin + t]. Without a pose, roofs fall back to an orthographic pitch correction.
 *  4. Features are measured in their plane's coordinates; confidence is scored from how the plane was solved and
 *     from tap precision: every calibration tap behind the plane and every point of the feature is nudged by
 *     ±2.5 px (one coordinate at a time, plane solutions re-solved), and the expected error 2σ caps the level
 *     (High needs ≤ 3%, Medium ≤ 6%). Bias the noise model cannot see gets hard caps (refs-only walls, roof-ortho,
 *     assumed focal length or pitch, off-plane items, a single unchecked reference, lens/rectangle mismatch).
 *
 * Pure: no DOM, no clocks, inputs are never mutated, compute paths never throw on bad project data
 * (they return ok:false with a plain-language `reason`).
 *
 * Deviations from SPEC §5.5 (all documented signatures still work):
 *  - PlaneSolution also has: `reason` (why !ok), `issues` ([{code, level, message}] mirroring `warnings`),
 *    `calib` ({scaleFrom:'rect'|'refs'|'parent', onlyMediumLowRefs, minCourses, rectProblem, refsBothDirections,
 *    anisotropic}) used for confidence, `frame` (3D frame of roof/ground planes), `gridExtent` (plane-space box for
 *    overlay grids on every plane; `extent` stays the rectangle's box or null), `parentPlaneId` for roof/ground
 *    planes, `disagreementZ` (largest disagreement ÷ what tap noise explains), `poseConsistencyPct` /
 *    `poseTolerancePct` (rectangle vs lens fit), `focalMismatchPct` (lens setting vs rectangle estimate, when
 *    significant), `pitchInfo` ({onEave, spread, samples} for estimated roof pitches), `groundScale` (ground
 *    planes re-fitted from their own references), `frontSign` (horizon test), `uncertaintyPct` (expected error of
 *    a typical item on the plane) and `confidence` (plane-level rating shown on its pill).
 *  - viewAngleDeg of a roof/ground plane is its parent wall's view angle (the 3D accuracy comes from the wall).
 *  - scale.sx/sy are the fitted scale factors (ft per base unit): 1 for rect-known, ft per px for refs-only.
 *  - disagreementPct is the spread between independent size constraints: (max ratio / min ratio − 1)·100 where
 *    ratio = measured/expected with the final solution (for rect-known, the rectangle itself counts as ratio 1).
 *    With two references one of which is 10% off this reads 10, which is what the warning should say.
 *  - Roof/ground planes do NOT inherit the wall's `checks`/`disagreementPct` (wall references say nothing about the
 *    camera pose). Roof references are checks; ground references re-fit the ground scale (scaling the scene about
 *    the camera), so one sets the scale and further ones are checks.
 *  - Points of a roof/ground item at or above that surface's horizon make the item unmeasurable (ok:false).
 *  - On a plane without `rect`, the largest valid known-size rect ref becomes the plane rectangle.
 *  - An unknown-size rect with ONE known side uses that side as an extra scale reference.
 *  - FeatureMeasurement also has: `reason` (why !ok), `pixelLength`, `segmentsFt`, `uncertaintyPct` (expected
 *    error 2σ in % from tap precision; Infinity when a nudge breaks the measurement; null without measureProject).
 *  - Roof pitch is estimated per roof: rakes on its parent wall whose low end sits on its eave line first, else all
 *    gable rakes (`pitchInfo.onEave` false). measureProject warns 'pitch-spread' when samples differ by > 2/12.
 *  - measureProject also warns 'focal-mismatch' (warn; with imageId and suggestedFocalPx) when an EXIF, preset or
 *    manual focal length disagrees with a rectangle estimate, and 'exif-ignored' (info) for cropped photos.
 *  - Trees, columns and bushes drawn on a GROUND plane (with a pose) are measured on a vertical plane parallel to
 *    the wall through their base point on the ground (true 3D size, method 'ground-3d').
 *  - measureProject() also returns `ok` (false only when the input is not a project object).
 */
LP.define('measure', ['geometry', 'camera', 'catalog'], function (g, camera, catalog) {
  'use strict';

  // ================================================================ presets
  const REF_PRESETS = [
    { id: 'door-height', label: 'Entry door height (80 in)', kind: 'line', lengthIn: 80, quality: 'high' },
    { id: 'door-width', label: 'Entry door width (36 in)', kind: 'line', lengthIn: 36, quality: 'high' },
    { id: 'door-rect', label: 'Entry door (36 × 80 in)', kind: 'rect', widthIn: 36, heightIn: 80, quality: 'high' },
    { id: 'garage-single', label: 'Single garage door (9 × 7 ft)', kind: 'rect', widthIn: 108, heightIn: 84, quality: 'high' },
    { id: 'garage-double', label: 'Double garage door (16 × 7 ft)', kind: 'rect', widthIn: 192, heightIn: 84, quality: 'high' },
    { id: 'garage-height', label: 'Garage door height (7 ft)', kind: 'line', lengthIn: 84, quality: 'high' },
    { id: 'siding-4', label: 'Vinyl siding, 4 in courses', kind: 'courses', courseIn: 4, quality: 'medium' },
    { id: 'siding-5', label: 'Vinyl siding, 5 in courses', kind: 'courses', courseIn: 5, quality: 'medium' },
    { id: 'brick', label: 'Brick courses (3 ≈ 8 in)', kind: 'courses', courseIn: 8 / 3, quality: 'medium' },
    { id: 'custom-line', label: 'Custom length', kind: 'line', quality: 'high' },
    { id: 'custom-rect', label: 'Custom rectangle', kind: 'rect', quality: 'high' },
  ];
  const WALL_RECT_PRESETS = ['door-rect', 'garage-single', 'garage-double', 'custom-rect']
    .map((id) => Object.assign({}, REF_PRESETS.find((p) => p.id === id)))
    .concat([{ id: 'unknown', label: 'Size unknown (e.g. house corners)', kind: 'rect', quality: 'high' }])
    .map((p) => Object.assign(p, {
      widthFt: p.widthIn ? p.widthIn / 12 : null,
      heightFt: p.heightIn ? p.heightIn / 12 : null,
    }));

  const QUALITY_WEIGHT = { high: 1, medium: 0.6, low: 0.3 };
  const MODE_PENALTY = { 'rect-known': 0, 'rect-refs': 5, 'refs-only': 20, 'roof-3d': 10, 'roof-ortho': 20, 'ground-3d': 10 };
  const MODE_REASON = {
    'rect-refs': 'The rectangle size comes from reference lengths, not a known size.',
    'refs-only': 'This wall has no perspective rectangle, so the photo is assumed to be straight on.',
    'roof-3d': 'Measured on the roof slope, worked out in 3D from the wall.',
    'roof-ortho': 'The roof slope length is approximated from the wall because the wall has no perspective rectangle.',
    'ground-3d': 'Measured on the ground, worked out in 3D from the wall.',
  };
  const DEFAULT_PITCH = { rise: 6, run: 12 };
  // A rake segment only counts toward the pitch estimate when it is at least this long and plausibly sloped.
  const PITCH_MIN_SEGMENT_FT = 1;
  const PITCH_MIN_DEG = 5;
  const PITCH_MAX_DEG = 70;
  const MAX_GRID_LINES = 400;

  // ================================================================ small helpers
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const posNum = (v) => (isNum(v) && v > 0 ? v : null);
  const round = (v, d) => { const k = Math.pow(10, d); return Math.round(v * k) / k; };
  const quoted = (name, fallback) => (typeof name === 'string' && name.trim() ? "'" + name.trim() + "'" : fallback);

  /** Copy of a point list as [[x,y]...]; null if it is not an array or any point is not two finite numbers. */
  function cleanPts(points) {
    if (!Array.isArray(points)) return null;
    const out = [];
    for (const p of points) {
      if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) return null;
      out.push([p[0], p[1]]);
    }
    return out;
  }

  function getRefPreset(id) { return REF_PRESETS.find((p) => p.id === id) || null; }

  function validPitch(p) { return isObj(p) && isNum(p.rise) && p.rise >= 0 && isNum(p.run) && p.run > 0; }
  const pitchAngleDeg = (rise, run) => (Math.atan2(rise, run) * 180) / Math.PI;

  // ================================================================ references
  /**
   * Build a reference object (SPEC §4) from a preset. Explicit numbers in opts override the preset's size.
   * 'courses' presets become kind:'line' refs with courses:N and lengthFt = N·courseIn/12.
   * opts.id sets the id; otherwise a deterministic id is derived from the preset and points.
   */
  function refFromPreset(presetId, points, opts) {
    const o = isObj(opts) ? opts : {};
    const pts = Array.isArray(points) ? points.map((p) => (Array.isArray(p) ? [p[0], p[1]] : p)) : [];
    const preset = getRefPreset(presetId) || getRefPreset(pts.length === 4 ? 'custom-rect' : 'custom-line');
    const id = typeof o.id === 'string' && o.id ? o.id
      : 'ref_' + g.hashString(preset.id + ':' + JSON.stringify(pts)).toString(36);
    const quality = QUALITY_WEIGHT[o.quality] ? o.quality : preset.quality;
    if (preset.kind === 'rect') {
      return {
        id, kind: 'rect', points: pts,
        widthFt: posNum(o.widthFt) || (preset.widthIn ? preset.widthIn / 12 : null),
        heightFt: posNum(o.heightFt) || (preset.heightIn ? preset.heightIn / 12 : null),
        presetId: preset.id, quality,
      };
    }
    if (preset.kind === 'courses') {
      const courses = posNum(o.courses);
      return { id, kind: 'line', points: pts, lengthFt: courses ? (courses * preset.courseIn) / 12 : null, presetId: preset.id, courses, quality };
    }
    return {
      id, kind: 'line', points: pts,
      lengthFt: posNum(o.lengthFt) || (preset.lengthIn ? preset.lengthIn / 12 : null),
      presetId: preset.id, courses: null, quality,
    };
  }

  /** Human label for a reference, e.g. "Entry door height (80 in)" or "Custom length (12′ 0″)". */
  function refLabel(ref) {
    const p = getRefPreset(ref.presetId);
    if (ref.courses && p && p.kind === 'courses') return p.label + ' × ' + ref.courses;
    if (p && p.id !== 'custom-line' && p.id !== 'custom-rect') return p.label;
    if (ref.kind === 'rect') return 'Custom rectangle (' + formatLength(ref.widthFt) + ' × ' + formatLength(ref.heightFt) + ')';
    return 'Custom length (' + formatLength(ref.lengthFt) + ')';
  }

  /**
   * Turn one reference into size constraints. A line gives one; a rect gives a width and a height constraint.
   * Constraint: {refId, label, kind:'line'|'width'|'height', pts, expectedFt, q, quality, courses}.
   * Bad refs give a plain-language problem instead.
   */
  function refConstraints(ref) {
    if (!isObj(ref)) return { constraints: [], problem: 'A reference on this plane is damaged and was skipped.' };
    const label = refLabel(ref);
    const quality = QUALITY_WEIGHT[ref.quality] ? ref.quality : 'high';
    const q = QUALITY_WEIGHT[quality];
    const pts = cleanPts(ref.points);
    if (ref.kind === 'rect') {
      if (!pts || pts.length !== 4) return { constraints: [], problem: "The reference '" + label + "' needs 4 corners. It was skipped." };
      const quad = g.orderQuad(pts);
      if (!g.isConvexQuad(quad)) return { constraints: [], problem: "The corners of the reference '" + label + "' cross over. Re-tap them." };
      const w = posNum(ref.widthFt), h = posNum(ref.heightFt);
      if (!w && !h) return { constraints: [], problem: "The reference '" + label + "' has no size. Enter its width and height." };
      const out = [];
      if (w) out.push({ refId: ref.id, label: label + ', width', kind: 'width', pts: quad, expectedFt: w, q, quality, courses: null });
      if (h) out.push({ refId: ref.id, label: label + ', height', kind: 'height', pts: quad, expectedFt: h, q, quality, courses: null });
      return { constraints: out, quad, widthFt: w, heightFt: h };
    }
    if (!pts || pts.length < 2) return { constraints: [], problem: "The reference '" + label + "' needs 2 points. It was skipped." };
    let L = posNum(ref.lengthFt);
    const preset = getRefPreset(ref.presetId);
    if (!L && posNum(ref.courses) && preset && preset.kind === 'courses') L = (ref.courses * preset.courseIn) / 12;
    if (!L) return { constraints: [], problem: "The reference '" + label + "' has no length. Enter its length." };
    const a = pts[0], b = pts[pts.length - 1];
    if (g.dist(a, b) < 1e-6) return { constraints: [], problem: "The two ends of the reference '" + label + "' are the same point." };
    const courses = posNum(ref.courses) || null;
    return { constraints: [{ refId: ref.id, label, kind: 'line', pts: [a, b], expectedFt: L, q, quality, courses }] };
  }

  /** Plane-space vector of a constraint under the image→plane map H (null if it cannot be mapped). */
  function constraintVector(c, H) {
    const m = (p) => g.applyH(H, p);
    if (c.kind === 'line') {
      const a = m(c.pts[0]), b = m(c.pts[1]);
      return a && b ? [b[0] - a[0], b[1] - a[1]] : null;
    }
    const [TL, TR, BR, BL] = c.pts.map(m);
    if (!TL || !TR || !BR || !BL) return null;
    // Average of the two opposite sides: width = top and bottom edges, height = left and right edges.
    if (c.kind === 'width') return [((TR[0] - TL[0]) + (BR[0] - BL[0])) / 2, ((TR[1] - TL[1]) + (BR[1] - BL[1])) / 2];
    return [((TL[0] - BL[0]) + (TR[0] - BR[0])) / 2, ((TL[1] - BL[1]) + (TR[1] - BR[1])) / 2];
  }

  /** Pixel length of a constraint on screen (rect widths/heights: the mean of the two opposite sides). */
  function constraintPx(c) {
    if (c.kind === 'line') return g.dist(c.pts[0], c.pts[1]);
    const [TL, TR, BR, BL] = c.pts;
    return c.kind === 'width' ? (g.dist(TL, TR) + g.dist(BL, BR)) / 2 : (g.dist(TL, BL) + g.dist(TR, BR)) / 2;
  }

  /** Relative 1σ of a constraint's measured length from tap noise (two ends; a rect side is the mean of two). */
  function constraintSigma(c) {
    const px = constraintPx(c);
    if (!(px > 0)) return Infinity;
    return c.kind === 'line' ? (SIGMA_TAP_PX * Math.SQRT2) / px : SIGMA_TAP_PX / px;
  }

  /**
   * Measure constraints with the final map. Returns refResults, the ratio spread (max/min − 1, %) and z: the
   * largest pairwise disagreement divided by what tap noise alone would explain (|ln(rᵢ/rⱼ)| / hypot(σᵢ, σⱼ)).
   * unitSigma (number) adds the plane's own size as a ratio-1 constraint with that relative σ (rect-known).
   */
  function evaluateConstraints(constraints, H, lenFn, unitSigma) {
    const refResults = [];
    const items = isNum(unitSigma) ? [{ r: 1, s: unitSigma }] : [];
    for (const c of constraints) {
      const d = constraintVector(c, H);
      const measured = d ? lenFn(d[0], d[1]) : null;
      const errorPct = isNum(measured) ? (100 * (measured - c.expectedFt)) / c.expectedFt : null;
      refResults.push({ refId: c.refId, label: c.label, expectedFt: c.expectedFt, measuredFt: isNum(measured) ? measured : null, errorPct });
      if (isNum(measured) && measured > 0) items.push({ r: measured / c.expectedFt, s: constraintSigma(c) });
    }
    let spread = null, z = null;
    if (items.length >= 2) {
      let hi = items[0], lo = items[0];
      for (const it of items) { if (it.r > hi.r) hi = it; if (it.r < lo.r) lo = it; }
      spread = (hi.r / lo.r - 1) * 100;
      z = 0;
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const s = Math.hypot(items[i].s, items[j].s);
          const zij = s > 0 ? Math.abs(Math.log(items[i].r / items[j].r)) / s : Infinity;
          if (zij > z) z = zij;
        }
      }
    }
    return { refResults, spread, z };
  }

  // ================================================================ plane solutions
  // Tap precision used for honesty: every tapped coordinate is assumed to be off by about this much (1σ, stored-image
  // pixels). Expected errors are 2σ, so "High" (±3%) needs 2σ ≤ 3% and "Medium" (±6%) needs 2σ ≤ 6%.
  const SIGMA_TAP_PX = 2.5;
  const U_HIGH_PCT = 3;
  const U_MEDIUM_PCT = 6;
  // Relative 1σ of the focal length by source. EXIF is trusted; presets are typical lenses; a hand-entered pixel focal
  // length cannot be checked and is usually typed from a guess, so it counts as loose as the default.
  const FOCAL_REL_SIGMA = { exif: 0.03, preset: 0.12, manual: 0.25, default: 0.25 };
  const POSE_TOL_MIN_PCT = 3;

  function baseSolution(plane, kind) {
    return {
      ok: false, planeId: plane && plane.id != null ? plane.id : null, kind, mode: 'uncalibrated',
      Himg2plane: null, Hplane2img: null,
      scale: { sx: null, sy: null, anisotropic: false },
      refResults: [], disagreementPct: null, disagreementZ: null, checks: 0,
      viewAngleDeg: null, pose: null, K: null, pitch: null, pitchInfo: null, extent: null, gridExtent: null,
      poseConsistencyPct: null, poseToleranceZ: null, focalMismatchPct: null,
      calib: { scaleFrom: null, onlyMediumLowRefs: false, minCourses: null, rectProblem: null, refsBothDirections: false, anisotropic: false },
      warnings: [], notes: [], issues: [], reason: null, confidence: null,
    };
  }

  function addIssue(sol, code, message, level) {
    sol.warnings.push(message);
    sol.issues.push({ code, level: level || 'warn', message });
  }

  function failSolution(sol, reason, code) {
    sol.ok = false;
    sol.mode = 'uncalibrated';
    sol.reason = reason;
    sol.Himg2plane = null;
    sol.Hplane2img = null;
    addIssue(sol, code || 'plane-uncalibrated', reason);
    return sol;
  }

  function bboxOfPlanePts(pts) {
    const b = g.bbox(pts);
    return { minU: b.minX, minV: b.minY, maxU: b.maxX, maxV: b.maxY };
  }

  /** Relative 1σ of the focal length for its source. A rectangle estimate's relStd is per ±2 px corner nudge. */
  function focalRelSigma(K) {
    if (!K) return FOCAL_REL_SIGMA.default;
    if (K.source === 'rectangle') return Math.max(0.03, 3.5 * (isNum(K.relStd) ? K.relStd : 0.1) * (SIGMA_TAP_PX / 2));
    return FOCAL_REL_SIGMA[K.source] || FOCAL_REL_SIGMA.default;
  }

  /** Relative 1σ of a rectangle's width/height ratio that comes from the focal length's uncertainty. */
  function aspectSigma(quad, K) {
    if (!K) return Infinity;
    const e = 0.05;
    const a = camera.rectAspectFromQuad(quad, K);
    const ap = camera.rectAspectFromQuad(quad, { f: K.f * (1 + e), cx: K.cx, cy: K.cy });
    const am = camera.rectAspectFromQuad(quad, { f: K.f * (1 - e), cx: K.cx, cy: K.cy });
    if (!a || !ap || !am) return Infinity;
    return (Math.abs(ap - am) / (2 * e * a)) * focalRelSigma(K);
  }

  /** Mean on-screen width and height (px) of an ordered quad [TL, TR, BR, BL]. */
  function quadSidesPx(q) {
    return { w: (g.dist(q[0], q[1]) + g.dist(q[3], q[2])) / 2, h: (g.dist(q[0], q[3]) + g.dist(q[1], q[2])) / 2 };
  }

  /** Solve a wall plane (rect-known / rect-refs / refs-only). K may be null when the photo is missing. */
  function solveWall(plane, image, K, config) {
    const sol = baseSolution(plane, 'wall');
    const name = quoted(plane.name, 'this wall');
    if (!image) return failSolution(sol, 'The photo for ' + name + ' is missing, so it cannot be measured.', 'missing-image');
    const Kok = !!(K && K.ok !== false && K.f > 0);
    sol.K = Kok ? { f: K.f, cx: K.cx, cy: K.cy, source: K.source, label: K.label, relStd: K.relStd } : null;
    const warnPct = isNum(config && config.refDisagreementWarnPct) ? config.refDisagreementWarnPct : 5;

    // ---- perspective rectangle
    let quad = null, rectW = null, rectH = null;
    if (isObj(plane.rect) && plane.rect.corners != null) {
      const c = cleanPts(plane.rect.corners);
      if (!c || c.length !== 4) {
        const msg = 'The rectangle on ' + name + ' needs 4 corners. It is ignored until all 4 are placed.';
        addIssue(sol, 'rect-incomplete', msg);
        sol.calib.rectProblem = msg;
      } else {
        const q = g.orderQuad(c);
        if (!g.isConvexQuad(q)) {
          const msg = 'The rectangle corners on ' + name + ' cross over or bend inward, so the rectangle is ignored. Re-tap the 4 corners.';
          addIssue(sol, 'rect-not-convex', msg);
          sol.calib.rectProblem = msg;
        } else {
          quad = q;
          rectW = posNum(plane.rect.widthFt);
          rectH = posNum(plane.rect.heightFt);
        }
      }
    }

    // ---- references → constraints
    let constraints = [];
    const rectRefs = [];
    for (const ref of arr(plane.refs)) {
      const rc = refConstraints(ref);
      if (rc.problem) { addIssue(sol, 'ref-invalid', rc.problem); continue; }
      if (rc.quad && rc.widthFt && rc.heightFt) rectRefs.push({ ref, quad: rc.quad, w: rc.widthFt, h: rc.heightFt, constraints: rc.constraints });
      constraints = constraints.concat(rc.constraints);
    }
    // No plane rectangle: promote the largest known-size reference rectangle to plane rectangle.
    if (!quad && rectRefs.length) {
      const best = rectRefs.slice().sort((a, b) => g.polygonArea(b.quad) - g.polygonArea(a.quad))[0];
      quad = best.quad; rectW = best.w; rectH = best.h;
      constraints = constraints.filter((c) => best.constraints.indexOf(c) < 0);
      sol.notes.push("The reference '" + refLabel(best.ref) + "' is used as this wall's perspective rectangle.");
      sol.calib.rectProblem = null; // a usable rectangle after all
      sol.promotedRefId = best.ref.id != null ? best.ref.id : null;
    }

    // ---- base map H0 (image → base plane units) and mode
    let H0 = null;
    let mode;
    let rectPlaneCorners = null; // rectangle corners in base units, [TL, TR, BR, BL]
    if (quad && rectW && rectH) {
      mode = 'rect-known';
      rectPlaneCorners = [[0, rectH], [rectW, rectH], [rectW, 0], [0, 0]];
      H0 = g.homographyFromPoints(quad, rectPlaneCorners);
    } else if (quad && Kok) {
      mode = 'rect-refs';
      const a = camera.rectAspectFromQuad(quad, sol.K);
      if (a) {
        rectPlaneCorners = [[0, 1], [a, 1], [a, 0], [0, 0]];
        H0 = g.homographyFromPoints(quad, rectPlaneCorners);
        // One known side of the rectangle is a reference too.
        if (rectW) constraints.push({ refId: null, label: 'Rectangle width', kind: 'width', pts: quad, expectedFt: rectW, q: 1, quality: 'high', courses: null });
        if (rectH) constraints.push({ refId: null, label: 'Rectangle height', kind: 'height', pts: quad, expectedFt: rectH, q: 1, quality: 'high', courses: null });
      }
    } else {
      mode = 'refs-only';
      // Straight-on similarity: u = x, v = (image height − y); the scale is fitted below.
      const ih = isNum(image.height) ? image.height : 0;
      H0 = [1, 0, 0, 0, -1, ih, 0, 0, 1];
      if (quad && !Kok) sol.notes.push('The rectangle on ' + name + ' is ignored because the photo size is unknown.');
    }
    if (!H0) return failSolution(sol, 'The rectangle corners on ' + name + ' are too close together to use. Re-tap them.', 'rect-degenerate');
    sol.mode = mode;

    // ---- scale fit
    let sx = 1, sy = 1, anisotropic = false;
    let aspectCheck = null; // {pct, z}: the camera-derived proportions used as a cross-check on the references
    const usedForScale = mode === 'rect-known' ? [] : constraints;
    let horizRefs = false, vertRefs = false;
    if (mode !== 'rect-known') {
      const items = [];
      for (const c of constraints) {
        const d = constraintVector(c, H0);
        const len = d ? Math.hypot(d[0], d[1]) : 0;
        if (len > 1e-12) items.push({ c, du: d[0], dv: d[1], len, px: constraintPx(c) });
      }
      if (!items.length) {
        return failSolution(sol, 'Add a reference length on ' + name + ' (for example the front door height) so the app knows the scale.', 'needs-reference');
      }
      // Isotropic weighted mean: s = Σ wᵢ(Lᵢ/|dᵢ|) / Σ wᵢ with wᵢ = |dᵢ|·q  ⇒  s = Σ qLᵢ / Σ q|dᵢ|.
      let num = 0, den = 0;
      for (const it of items) { num += it.c.q * it.c.expectedFt; den += it.c.q * it.len; }
      sx = sy = num / den;
      const hItems = items.filter((it) => Math.abs(it.du) > 2 * Math.abs(it.dv));
      const vItems = items.filter((it) => Math.abs(it.dv) > 2 * Math.abs(it.du));
      horizRefs = hItems.length > 0; vertRefs = vItems.length > 0;
      // Separate horizontal/vertical scales only when the references pin the proportions better than the camera
      // does, or when they clearly disagree with it (then the disagreement is reported, not absorbed).
      if (mode === 'rect-refs' && items.length >= 2 && horizRefs && vertRefs) {
        let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
        for (const it of items) {
          const L2 = it.c.expectedFt * it.c.expectedFt;
          const w = it.c.q / (L2 * L2);
          const x = it.du * it.du, y = it.dv * it.dv;
          a11 += w * x * x; a12 += w * x * y; a22 += w * y * y;
          b1 += w * x * L2; b2 += w * y * L2;
        }
        const sol2 = g.solveLinear([[a11, a12], [a12, a22]], [b1, b2]);
        if (sol2 && sol2[0] > 0 && sol2[1] > 0) {
          const ax = Math.sqrt(sol2[0]), ay = Math.sqrt(sol2[1]);
          const sumSq = (list) => list.reduce((s, it) => s + it.px * it.px, 0);
          const sigRefs = SIGMA_TAP_PX * Math.SQRT2 * Math.sqrt(1 / sumSq(hItems) + 1 / sumSq(vItems));
          const sigK = aspectSigma(quad, sol.K);
          const lnRatio = Math.log(ax / ay);
          const z = lnRatio === 0 ? 0 : Math.abs(lnRatio) / Math.hypot(sigRefs, isFinite(sigK) ? sigK : 0);
          const diffPct = Math.abs(ax / ay - 1) * 100;
          const refsBetter = sigRefs < sigK;
          if (refsBetter || z > 2) {
            sx = ax; sy = ay; anisotropic = true;
            if (!refsBetter) {
              aspectCheck = { pct: diffPct, z };
              sol.notes.push('Horizontal and vertical references disagree with the camera on the wall\'s proportions by ' + diffPct.toFixed(1) +
                '%, so each direction was scaled separately. Either a reference or the lens setting is off.');
            } else if (diffPct > 5) {
              sol.notes.push('Horizontal and vertical references disagree on scale by ' + diffPct.toFixed(1) +
                '%, so each direction was scaled separately. This usually means the lens setting is off.');
            }
          }
        }
      }
    }
    sol.scale = { sx, sy, anisotropic };
    const Himg2plane = g.normalizeH(g.multiplyH(g.scaleMatrix(sx, sy), H0));
    const Hplane2img = Himg2plane ? g.invertH(Himg2plane) : null;
    if (!Himg2plane || !Hplane2img) return failSolution(sol, 'The marks on ' + name + ' do not define a usable scale. Re-tap them.', 'plane-degenerate');
    sol.ok = true;
    sol.Himg2plane = Himg2plane;
    sol.Hplane2img = Hplane2img;

    // ---- checks and disagreement
    const sides = quad ? quadSidesPx(quad) : null;
    const unitSigma = mode === 'rect-known' && sides ? SIGMA_TAP_PX / Math.max(1e-9, Math.min(sides.w, sides.h)) : null;
    const ev = evaluateConstraints(constraints, Himg2plane, Math.hypot, unitSigma);
    sol.refResults = ev.refResults;
    const used = ev.refResults.filter((r) => isNum(r.measuredFt)).length;
    if (mode === 'rect-known') sol.checks = used;
    else if (aspectCheck) sol.checks = Math.max(0, used - 1); // the camera's proportions served as the cross-check
    else sol.checks = Math.max(0, used - (anisotropic ? 2 : 1));
    if (aspectCheck) {
      // Two references fit the two scales exactly; only a third one can also disagree with them.
      sol.disagreementPct = Math.max(aspectCheck.pct, used >= 3 && isNum(ev.spread) ? ev.spread : 0);
      sol.disagreementZ = aspectCheck.z;
    } else {
      sol.disagreementPct = sol.checks >= 1 ? ev.spread : null;
      sol.disagreementZ = sol.checks >= 1 ? ev.z : null;
    }
    if (isNum(sol.disagreementPct) && sol.disagreementPct > warnPct) {
      let msg = 'References on ' + name + ' disagree by ' + sol.disagreementPct.toFixed(1) + '%. Check that each one sits on this wall and that its size is right.';
      if (aspectCheck) msg += ' If they are right, check the lens setting in step 1.';
      else if (isNum(sol.disagreementZ) && sol.disagreementZ <= 2) {
        const shortest = constraints.reduce((m, c) => Math.min(m, constraintPx(c)), Infinity);
        msg += ' Part of it can be tap error: the shortest one spans only ' + Math.round(shortest) + ' px, so zoom in or use a longer reference.';
      }
      addIssue(sol, 'ref-disagreement', msg);
    }
    sol.calib = {
      scaleFrom: mode === 'rect-known' ? 'rect' : 'refs',
      onlyMediumLowRefs: usedForScale.length > 0 && usedForScale.every((c) => c.q < 1),
      minCourses: usedForScale.reduce((m, c) => (c.courses && (m == null || c.courses < m) ? c.courses : m), null),
      rectProblem: sol.calib.rectProblem,
      refsBothDirections: mode === 'refs-only' && horizRefs && vertRefs && sol.checks >= 1 && isNum(sol.disagreementPct) && sol.disagreementPct <= 3,
      anisotropic,
    };

    // ---- extent, pose, view angle
    if (rectPlaneCorners) {
      const corners = quad.map((p) => g.applyH(Himg2plane, p)).filter(Boolean);
      if (corners.length === 4) {
        sol.extent = bboxOfPlanePts(corners);
        const e = sol.extent;
        const w = e.maxU - e.minU, h = e.maxV - e.minV;
        sol.gridExtent = { minU: e.minU - w * 0.25, minV: e.minV, maxU: e.maxU + w * 0.25, maxV: e.maxV + h * 0.75 };
      }
      if (sol.K) {
        const pose = camera.poseFromHomography(Hplane2img, sol.K);
        if (pose.ok) {
          sol.pose = pose;
          if (sol.extent) {
            const center = [(sol.extent.minU + sol.extent.maxU) / 2, (sol.extent.minV + sol.extent.maxV) / 2, 0];
            sol.viewAngleDeg = camera.viewAngleDeg(pose, center);
          }
          const cons = pose.consistency;
          if (cons) {
            // How far the rectangle and the lens disagree, against what ±σ taps on this rectangle could explain.
            sol.poseConsistencyPct = 100 * Math.max(Math.abs(cons.normRatio - 1), Math.abs(cons.cosAngle));
            const tapPct = sides ? 100 * SIGMA_TAP_PX * Math.SQRT2 * Math.hypot(1 / sides.w, 1 / sides.h) : 0;
            sol.poseTolerancePct = Math.max(POSE_TOL_MIN_PCT, 2 * tapPct);
            if (Math.abs(cons.normRatio - 1) > 0.1 || Math.abs(cons.cosAngle) > 0.1) {
              addIssue(sol, 'pose-inconsistent', 'The rectangle on ' + name + " doesn't quite match the camera setting, so roof and ground lengths worked out from it may be off.", 'info');
            }
          }
        } else {
          sol.notes.push('The camera position could not be worked out from the rectangle on ' + name + '.');
        }
      }
    } else {
      addIssue(sol, 'refs-only', 'No perspective rectangle: assumes the photo was taken straight on.', 'info');
      const pts = [];
      for (const c of constraints) for (const p of c.pts) { const q = g.applyH(Himg2plane, p); if (q) pts.push(q); }
      if (pts.length) {
        const e = bboxOfPlanePts(pts);
        const pad = Math.max(5, (e.maxU - e.minU) * 0.5);
        sol.gridExtent = { minU: e.minU - pad, minV: Math.min(0, e.minV), maxU: e.maxU + pad, maxV: e.maxV + pad };
      }
    }
    return sol;
  }

  /** Resolve a roof pitch: plane's own → project setting → estimated from rakes → 6/12 default. */
  function resolvePitch(planePitch, settingsPitch, estimated) {
    if (validPitch(planePitch)) return { rise: planePitch.rise, run: planePitch.run, source: 'user' };
    if (validPitch(settingsPitch)) return { rise: settingsPitch.rise, run: settingsPitch.run, source: 'user' };
    if (estimated && isNum(estimated.rise)) return { rise: estimated.rise, run: 12, source: 'estimated' };
    return { rise: DEFAULT_PITCH.rise, run: DEFAULT_PITCH.run, source: 'default' };
  }

  /** Eave/base line of a derived plane in its parent wall's coordinates: {A, B, vMid, len} or a failure reason. */
  function derivedLine(plane, parent) {
    const d = isObj(plane.derived) ? plane.derived : null;
    const line = d ? cleanPts(d.line) : null;
    if (!line || line.length < 2) return { problem: 'no-line' };
    let A = g.applyH(parent.Himg2plane, line[0]);
    let B = g.applyH(parent.Himg2plane, line[line.length - 1]);
    if (!A || !B) return { problem: 'bad-line' };
    if (B[0] < A[0]) { const t = A; A = B; B = t; } // keep plane coordinate a increasing to the right
    return { A, B, vMid: (A[1] + B[1]) / 2, len: Math.abs(B[0] - A[0]), line };
  }

  /** Homogeneous w of a plane point under Hplane2img (sign tells which side of the camera it is on). */
  function wOf(H, uv) { return H[6] * uv[0] + H[7] * uv[1] + H[8]; }

  /**
   * Solve a roof or ground plane from its parent wall solution. pitch: the resolved pitch for roofs
   * ({rise, run, source}); pitchInfo: how an estimated pitch was found ({onEave, spread, samples}).
   */
  function solveDerived(plane, kind, wallSols, pitch, pitchInfo) {
    const sol = baseSolution(plane, kind);
    const name = quoted(plane.name, kind === 'roof' ? 'this roof' : 'this ground area');
    const d = isObj(plane.derived) ? plane.derived : null;
    const what = kind === 'roof' ? 'an eave line' : 'a wall base line';
    if (!d || d.parentPlaneId == null) return failSolution(sol, name + ' needs ' + what + ' drawn on a wall.', 'derived-no-parent');
    sol.parentPlaneId = d.parentPlaneId;
    const parent = Object.prototype.hasOwnProperty.call(wallSols, d.parentPlaneId) ? wallSols[d.parentPlaneId] : null;
    if (!parent) return failSolution(sol, name + ' is attached to a wall that no longer exists. Draw ' + what + ' again.', 'derived-no-parent');
    const parentName = quoted(parent.name, 'its wall');
    if (!parent.ok) return failSolution(sol, 'Measure ' + parentName + ' first: ' + (parent.reason || 'it has no scale yet.'), 'derived-parent-uncalibrated');
    if (kind === 'roof') {
      sol.pitch = pitch || { rise: DEFAULT_PITCH.rise, run: DEFAULT_PITCH.run, source: 'default' };
      sol.pitchInfo = sol.pitch.source === 'estimated' && pitchInfo ? pitchInfo : null;
    }

    const dl = derivedLine(plane, parent);
    if (dl.problem === 'no-line') return failSolution(sol, name + ' needs ' + what + ' with 2 points.', 'derived-no-line');
    if (dl.problem) return failSolution(sol, 'The line for ' + name + ' could not be placed on ' + parentName + '.', 'derived-bad-line');
    const { A, B, vMid, len } = dl;
    const du = B[0] - A[0], dv = B[1] - A[1];
    if (Math.abs(du) < 0.25) return failSolution(sol, 'The line for ' + name + ' is too short or not level. Draw it along the ' + (kind === 'roof' ? 'eave' : 'bottom of the wall') + '.', 'derived-bad-line');
    if (Math.abs(dv) > 0.2 * Math.abs(du)) {
      sol.notes.push('The line for ' + name + ' is not level on the wall; it was treated as level.');
    }

    // The view of the wall carries over; its reference checks do not (they say nothing about the camera pose).
    sol.K = parent.K;
    sol.viewAngleDeg = parent.viewAngleDeg;
    sol.poseConsistencyPct = parent.poseConsistencyPct;
    sol.poseTolerancePct = parent.poseTolerancePct;
    sol.calib = Object.assign({}, parent.calib, { scaleFrom: 'parent', onlyMediumLowRefs: parent.calib.onlyMediumLowRefs });

    if (parent.pose && parent.K) {
      const A3 = [A[0], vMid, 0], B3 = [B[0], vMid, 0];
      const frame = kind === 'roof' ? camera.roofFrame(A3, B3, sol.pitch.rise, sol.pitch.run) : camera.groundFrame(A3, B3);
      const Hp2i = frame ? camera.homographyForFrame(frame, parent.K, parent.pose) : null;
      const Hi2p = Hp2i ? g.invertH(Hp2i) : null;
      if (!Hi2p) return failSolution(sol, name + ' could not be worked out from ' + parentName + '.', 'derived-degenerate');
      sol.mode = kind === 'roof' ? 'roof-3d' : 'ground-3d';
      sol.frame = frame;
      sol.pose = parent.pose;
      sol.Himg2plane = Hi2p;
      sol.Hplane2img = Hp2i;
      sol.frameHimg2plane = Hi2p; // before any re-fit of the ground scale (billboards use the 3D frame)
      sol.groundScale = 1;
      sol.gridExtent = { minU: 0, minV: 0, maxU: len, maxV: kind === 'roof' ? Math.min(20, Math.max(4, len / 2)) : Math.min(25, Math.max(6, len / 2)) };
    } else if (kind === 'roof') {
      // No pose: measure in wall coordinates and correct each segment for the pitch (camera at infinity).
      sol.mode = 'roof-ortho';
      sol.Himg2plane = parent.Himg2plane;
      sol.Hplane2img = parent.Hplane2img;
      sol.gridExtent = { minU: A[0], minV: vMid, maxU: B[0], maxV: vMid + Math.min(10, len / 3) };
      addIssue(sol, 'roof-ortho', name + ' is approximated because ' + parentName + ' has no perspective rectangle.', 'info');
    } else {
      return failSolution(sol, 'Ground plane needs a perspective rectangle on its wall (' + parentName + ').', 'ground-needs-rect');
    }
    sol.ok = true;
    sol.scale = { sx: 1, sy: 1, anisotropic: false };

    const own = [];
    for (const ref of arr(plane.refs)) {
      const rc = refConstraints(ref);
      if (rc.problem) addIssue(sol, 'ref-invalid', rc.problem);
      else for (const c of rc.constraints) own.push(c);
    }
    if (kind === 'ground' && sol.mode === 'ground-3d' && own.length) {
      // Tape-measured lengths on the ground re-fit its scale. The ground's distance from the camera is the least
      // certain part of the pose (camera height, horizon tilt), and scaling the scene about the camera fixes it.
      let num = 0, den = 0;
      for (const c of own) {
        const dv2 = constraintVector(c, sol.Himg2plane);
        const L = dv2 ? Math.hypot(dv2[0], dv2[1]) : 0;
        if (L > 1e-9) { num += c.q * c.expectedFt; den += c.q * L; }
      }
      const s = den > 0 ? num / den : null;
      if (s && isNum(s) && s > 0.2 && s < 5) {
        const fr = sol.frame;
        const C = parent.pose.C;
        const rel = g.v3sub(C, fr.origin);
        const fa = g.v3dot(rel, fr.e1), fb = g.v3dot(rel, fr.e2); // camera foot in ground coordinates
        const T = [s, 0, fa * (1 - s), 0, s, fb * (1 - s), 0, 0, 1];
        const Hi2p = g.normalizeH(g.multiplyH(T, sol.Himg2plane));
        const Hp2i = Hi2p ? g.invertH(Hi2p) : null;
        if (Hi2p && Hp2i) {
          sol.Himg2plane = Hi2p;
          sol.Hplane2img = Hp2i;
          sol.groundScale = s;
          sol.scale = { sx: s, sy: s, anisotropic: false };
          sol.calib = Object.assign({}, sol.calib, { scaleFrom: 'refs' });
          if (Math.abs(s - 1) > 0.05) sol.notes.push('The ground reference re-scaled ' + name + ' by ' + ((s - 1) * 100).toFixed(1) + '% from the wall-based estimate.');
        }
      }
    }
    const lenFn = segLengthFn(sol);
    const refit = sol.groundScale !== 1 && isNum(sol.groundScale);
    const ev = evaluateConstraints(own, sol.Himg2plane, lenFn, refit ? null : 0.02);
    sol.refResults = ev.refResults;
    const ownChecks = ev.refResults.filter((r) => isNum(r.measuredFt)).length;
    sol.checks = refit ? Math.max(0, ownChecks - 1) : ownChecks;
    sol.disagreementPct = sol.checks >= 1 ? ev.spread : null;
    sol.disagreementZ = sol.checks >= 1 ? ev.z : null;
    if (sol.checks >= 1 && isNum(ev.spread) && ev.spread > 5) {
      addIssue(sol, 'ref-disagreement', 'References on ' + name + ' disagree by ' + ev.spread.toFixed(1) + '%. Check ' + (kind === 'roof' ? 'the roof pitch' : 'the wall rectangle') + ' and that each reference sits on this surface.');
    }
    // A plane point is in front of the camera when w has the same sign as at the eave/base line.
    const mid = g.applyH(sol.Himg2plane, [(dl.line[0][0] + dl.line[dl.line.length - 1][0]) / 2, (dl.line[0][1] + dl.line[dl.line.length - 1][1]) / 2]);
    sol.frontSign = mid ? Math.sign(wOf(sol.Hplane2img, mid)) || 1 : 1;
    return sol;
  }

  /** Segment length in plane coordinates; roof-ortho stretches the vertical part by 1/sin(pitch). */
  function segLengthFn(sol) {
    if (sol && sol.mode === 'roof-ortho' && sol.pitch) {
      const rise = sol.pitch.rise, run = sol.pitch.run;
      return (du, dv) => camera.orthoPitchLength(du, dv, rise, run);
    }
    return Math.hypot;
  }

  /**
   * Estimate roof pitch from in-plane gable rakes (features of type 'rake' on calibrated WALL planes).
   * Each segment ≥ 1 ft gives rise = 12·tan(angle) in wall coordinates; the median is rounded and clamped 2..18.
   * Also returns `spread` (max − min rise of the samples).
   */
  function estimatePitch(project, planeSolutions) {
    const sols = isObj(planeSolutions) ? planeSolutions : {};
    const samples = [];
    for (const f of arr(project && project.features)) {
      if (!isObj(f) || f.type !== 'rake') continue;
      const sol = Object.prototype.hasOwnProperty.call(sols, f.planeId) ? sols[f.planeId] : null;
      if (!sol || !sol.ok || sol.kind !== 'wall') continue;
      for (const s of rakeSamples(f.points, sol)) samples.push(s);
    }
    if (!samples.length) return null;
    const medRise = g.median(samples);
    return { rise: g.clamp(Math.round(medRise), 2, 18), run: 12, angleDeg: pitchAngleDeg(medRise, 12), samples, spread: Math.max.apply(null, samples) - Math.min.apply(null, samples) };
  }

  const PITCH_EAVE_TOL_FT = 1.5;
  const PITCH_SPREAD_MAX = 2;

  /**
   * Pitch estimate for one roof plane: rakes on its parent wall whose low end sits on the roof's eave line (within
   * 1.5 ft of its height and inside its span) first; otherwise every gable rake in the project (onEave false).
   * Returns {rise, run, angleDeg, samples, spread, onEave} or null.
   */
  function estimateRoofPitch(project, wallSols, roofPlane, globalEstimate) {
    const d = isObj(roofPlane.derived) ? roofPlane.derived : null;
    const parent = d && Object.prototype.hasOwnProperty.call(wallSols, d.parentPlaneId) ? wallSols[d.parentPlaneId] : null;
    const dl = parent && parent.ok ? derivedLine(roofPlane, parent) : null;
    const samples = [];
    if (dl && !dl.problem) {
      for (const f of arr(project && project.features)) {
        if (!isObj(f) || f.type !== 'rake' || f.planeId !== d.parentPlaneId) continue;
        const p = cleanPts(f.points);
        if (!p || p.length < 2) continue;
        const plane = p.map((q) => g.applyH(parent.Himg2plane, q));
        if (plane.some((q) => !q)) continue;
        const low = plane.reduce((m, q) => (q[1] < m[1] ? q : m), plane[0]);
        if (Math.abs(low[1] - dl.vMid) > PITCH_EAVE_TOL_FT || low[0] < dl.A[0] - 1 || low[0] > dl.B[0] + 1) continue;
        for (const s of rakeSamples(f.points, parent)) samples.push(s);
      }
    }
    if (samples.length) {
      const med = g.median(samples);
      return { rise: g.clamp(Math.round(med), 2, 18), run: 12, angleDeg: pitchAngleDeg(med, 12), samples, spread: Math.max.apply(null, samples) - Math.min.apply(null, samples), onEave: true };
    }
    return globalEstimate ? Object.assign({}, globalEstimate, { onEave: false }) : null;
  }

  /** Rise-per-12 samples from the segments of a rake polyline on a wall plane. */
  function rakeSamples(points, sol) {
    const pts = cleanPts(points);
    if (!pts || pts.length < 2) return [];
    const plane = pts.map((p) => g.applyH(sol.Himg2plane, p));
    if (plane.some((p) => !p)) return [];
    const out = [];
    for (let i = 1; i < plane.length; i++) {
      const du = Math.abs(plane[i][0] - plane[i - 1][0]);
      const dv = Math.abs(plane[i][1] - plane[i - 1][1]);
      if (Math.hypot(du, dv) < PITCH_MIN_SEGMENT_FT) continue;
      const ang = (Math.atan2(dv, du) * 180) / Math.PI;
      if (ang < PITCH_MIN_DEG || ang > PITCH_MAX_DEG) continue;
      out.push((12 * dv) / du);
    }
    return out;
  }

  function resolveCameras(proj, cfg) {
    const images = arr(proj.images).filter(isObj);
    const planes = arr(proj.planes).filter(isObj);
    const cameras = {};
    const opts = { maxImageSide: isNum(cfg && cfg.maxImageSide) ? cfg.maxImageSide : 2048 };
    for (const img of images) {
      if (img.id == null) continue;
      let K;
      try { K = camera.resolveCamera(img, planes, opts); } catch (e) { K = null; }
      cameras[img.id] = K || { ok: false, f: null, cx: null, cy: null, source: 'default', label: 'Camera unknown', relStd: null, rectEstimate: null, focalQuad: null, exifIgnored: null };
    }
    return cameras;
  }

  /** {pct, significant, rect} when the chosen focal (EXIF, preset or manual) disagrees with a rectangle estimate. */
  function focalMismatch(K) {
    if (!K || K.ok === false || !K.rectEstimate || !(K.f > 0) || (K.source !== 'exif' && K.source !== 'preset' && K.source !== 'manual')) return null;
    const re = K.rectEstimate;
    const pct = Math.abs(K.f / re.f - 1) * 100;
    const tol = 100 * Math.max(0.15, 3 * (isNum(re.relStd) ? re.relStd : 0.1));
    return { pct, significant: pct > tol, rect: re };
  }

  /**
   * Solve the planes given resolved cameras. pitchOverride (planeId → {pitch, pitchInfo}) pins roof pitches
   * (used when re-solving nudged copies for the uncertainty estimate).
   */
  function solveAll(proj, cfg, cameras, pitchOverride) {
    const settings = isObj(proj.settings) ? proj.settings : {};
    const images = arr(proj.images).filter(isObj);
    const planes = arr(proj.planes).filter(isObj);
    const imageById = (id) => images.find((im) => im.id === id) || null;
    const out = {};
    const named = (sol, plane) => { sol.name = typeof plane.name === 'string' ? plane.name : ''; return sol; };
    for (const plane of planes) {
      const kind = plane.kind == null ? 'wall' : plane.kind;
      if (kind !== 'wall') continue;
      const image = imageById(plane.imageId);
      const K = image ? cameras[image.id] : null;
      let sol;
      try { sol = solveWall(plane, image, K && K.ok !== false ? K : null, cfg); } catch (e) {
        sol = failSolution(baseSolution(plane, 'wall'), 'This wall could not be measured because its data is damaged.', 'plane-error');
      }
      const mm = focalMismatch(K);
      if (mm && mm.significant && sol.ok) sol.focalMismatchPct = mm.pct;
      out[plane.id] = named(sol, plane);
    }

    // Nudged re-solves pin every roof pitch, so they skip the (feature-wide) pitch estimate.
    const estimated = pitchOverride ? null : estimatePitch(proj, out);
    let pitch;
    if (validPitch(settings.roofPitch)) {
      pitch = { rise: settings.roofPitch.rise, run: settings.roofPitch.run, source: 'user', angleDeg: pitchAngleDeg(settings.roofPitch.rise, settings.roofPitch.run), samples: estimated ? estimated.samples : [] };
    } else if (estimated) {
      pitch = { rise: estimated.rise, run: 12, source: 'estimated', angleDeg: estimated.angleDeg, samples: estimated.samples };
    } else {
      pitch = { rise: DEFAULT_PITCH.rise, run: DEFAULT_PITCH.run, source: 'default', angleDeg: null, samples: [] };
    }

    for (const plane of planes) {
      const kind = plane.kind;
      if (kind == null || kind === 'wall') continue;
      let sol;
      if (kind !== 'roof' && kind !== 'ground') {
        sol = failSolution(baseSolution(plane, kind), quoted(plane.name, 'A plane') + ' has an unknown kind and was skipped.', 'plane-unknown-kind');
      } else {
        try {
          let rp = null, info = null;
          if (kind === 'roof') {
            const pin = pitchOverride && pitchOverride[plane.id];
            if (pin) { rp = pin.pitch; info = pin.pitchInfo; } else {
              const est = estimateRoofPitch(proj, out, plane, estimated);
              rp = resolvePitch(isObj(plane.derived) ? plane.derived.pitch : null, settings.roofPitch, est);
              info = est ? { onEave: est.onEave, spread: est.spread, samples: est.samples } : null;
            }
          }
          sol = solveDerived(plane, kind, out, rp, info);
        } catch (e) {
          sol = failSolution(baseSolution(plane, kind), 'This plane could not be measured because its data is damaged.', 'plane-error');
        }
        if (sol.ok && sol.kind === 'roof' && sol.pitchInfo && sol.pitchInfo.spread > PITCH_SPREAD_MAX && !(pitchOverride && pitchOverride[plane.id])) {
          const lo = Math.min.apply(null, sol.pitchInfo.samples), hi = Math.max.apply(null, sol.pitchInfo.samples);
          addIssue(sol, 'pitch-spread', 'The gable rakes disagree on the roof pitch (from about ' + Math.round(lo) + '/12 to ' + Math.round(hi) + '/12), so the pitch of ' +
            quoted(plane.name, 'this roof') + ' is uncertain. Enter its pitch.');
        }
        const parent = sol.parentPlaneId != null ? out[sol.parentPlaneId] : null;
        if (sol.ok && parent && isNum(parent.focalMismatchPct)) sol.focalMismatchPct = parent.focalMismatchPct;
      }
      out[plane.id] = named(sol, plane);
    }
    return { planes: out, pitch };
  }

  /**
   * Solve every plane of a project. Walls first, then the pitch estimate, then roof and ground planes.
   * Never throws: a plane that cannot be solved gets ok:false and a reason.
   */
  function solvePlanes(project, config) {
    const proj = isObj(project) ? project : {};
    const cfg = isObj(config) ? config : catalog.getLibrary(proj).config;
    const cameras = resolveCameras(proj, cfg);
    const solved = solveAll(proj, cfg, cameras, null);
    return { cameras, planes: solved.planes, pitch: solved.pitch };
  }

  // ================================================================ tap-precision uncertainty
  /** A copy of a plane with one tapped coordinate moved: path 'rect' | 'ref:<index>' | 'line', point k, axis. */
  function nudgedPlane(plane, path, k, axis, delta) {
    const move = (list) => list.map((p, i) => (i === k ? (axis === 0 ? [p[0] + delta, p[1]] : [p[0], p[1] + delta]) : p));
    const copy = Object.assign({}, plane);
    if (path === 'rect') copy.rect = Object.assign({}, plane.rect, { corners: move(plane.rect.corners) });
    else if (path === 'line') copy.derived = Object.assign({}, plane.derived, { line: move(plane.derived.line) });
    else {
      const j = Number(path.slice(4));
      copy.refs = plane.refs.map((r, i) => (i === j ? Object.assign({}, r, { points: move(r.points) }) : r));
    }
    return copy;
  }

  /** Indices of the points of a list that matter: all for a rect/quad, the two ends for a line. */
  function tapIndices(points, endsOnly) {
    const p = cleanPts(points);
    if (!p || !p.length) return [];
    if (!endsOnly || p.length <= 2) return p.map((_, i) => i);
    return [0, p.length - 1];
  }

  /**
   * Re-solve the planes with every calibration tap nudged by ±σ (one coordinate at a time): rectangle corners and
   * reference ends of walls whose scale depends on them, the eave/base line of roof and ground planes, ground
   * references that re-fit the scale, and — when the focal length was measured from a rectangle — that
   * rectangle's corners (the focal length moves with them). Returns {[planeId]: [{plus, minus}]}.
   */
  function perturbedSolutions(proj, cfg, cameras, solved, neededPlaneIds) {
    const planes = arr(proj.planes).filter(isObj);
    const byId = {};
    for (const pl of planes) byId[pl.id] = pl;
    const taps = []; // {planeId, path, k, axis, focalImage}
    const seen = new Set();
    const add = (planeId, path, k, focalImage) => {
      for (const axis of [0, 1]) {
        const key = planeId + '|' + path + '|' + k + '|' + axis;
        if (seen.has(key)) { if (focalImage) taps.find((t) => t.key === key).focalImage = focalImage; continue; }
        seen.add(key);
        taps.push({ key, planeId, path, k, axis, focalImage: focalImage || null });
      }
    };
    // Focal quads first, so their taps carry the image whose focal length they move.
    for (const imgId of Object.keys(cameras)) {
      const K = cameras[imgId];
      if (!K || K.source !== 'rectangle' || !K.focalQuad || !byId[K.focalQuad.planeId]) continue;
      const pl = byId[K.focalQuad.planeId];
      if (K.focalQuad.refId == null) { if (isObj(pl.rect)) for (const k of tapIndices(pl.rect.corners)) add(pl.id, 'rect', k, imgId); }
      else arr(pl.refs).forEach((r, j) => { if (isObj(r) && r.id === K.focalQuad.refId) for (const k of tapIndices(r.points)) add(pl.id, 'ref:' + j, k, imgId); });
    }
    for (const pl of planes) {
      const sol = solved.planes[pl.id];
      if (!sol || !sol.ok) continue;
      if (sol.kind === 'wall') {
        if (sol.mode !== 'refs-only' && isObj(pl.rect) && sol.promotedRefId === undefined) for (const k of tapIndices(pl.rect.corners)) add(pl.id, 'rect', k);
        arr(pl.refs).forEach((r, j) => {
          if (!isObj(r)) return;
          const scaleRef = sol.calib.scaleFrom === 'refs' || (sol.promotedRefId !== undefined && r.id === sol.promotedRefId);
          if (scaleRef) for (const k of tapIndices(r.points, r.kind !== 'rect')) add(pl.id, 'ref:' + j, k);
        });
      } else {
        for (const k of tapIndices(pl.derived && pl.derived.line, true)) add(pl.id, 'line', k);
        if (sol.groundScale !== 1 && isNum(sol.groundScale)) arr(pl.refs).forEach((r, j) => { if (isObj(r)) for (const k of tapIndices(r.points, r.kind !== 'rect')) add(pl.id, 'ref:' + j, k); });
      }
    }
    // Pitches stay as solved (pitch uncertainty is rated separately).
    const pins = {};
    for (const id of Object.keys(solved.planes)) {
      const s = solved.planes[id];
      if (s.kind === 'roof' && s.pitch) pins[id] = { pitch: s.pitch, pitchInfo: s.pitchInfo };
    }
    const out = {};
    const imageOf = (pl) => (pl ? pl.imageId : null);
    for (const t of taps) {
      const owner = byId[t.planeId];
      // Which planes can this tap move?
      const affected = new Set();
      if (t.focalImage) { for (const pl of planes) if (pl.imageId === t.focalImage || (pl.derived && byId[pl.derived.parentPlaneId] && imageOf(byId[pl.derived.parentPlaneId]) === t.focalImage)) affected.add(pl.id); }
      affected.add(owner.id);
      if ((owner.kind == null || owner.kind === 'wall')) for (const pl of planes) if (pl.derived && pl.derived.parentPlaneId === owner.id) affected.add(pl.id);
      if (![...affected].some((id) => neededPlaneIds.has(id))) continue;
      const include = new Set(affected);
      for (const id of affected) { const pl = byId[id]; if (pl && pl.derived && pl.derived.parentPlaneId != null) include.add(pl.derived.parentPlaneId); }
      const pair = {};
      for (const sign of [1, -1]) {
        const moved = nudgedPlane(owner, t.path, t.k, t.axis, sign * SIGMA_TAP_PX);
        const sub = Object.assign({}, proj, { planes: planes.filter((pl) => include.has(pl.id)).map((pl) => (pl.id === owner.id ? moved : pl)) });
        let cams = cameras;
        let lensBroken = false;
        if (t.focalImage) {
          const K = cameras[t.focalImage];
          const fq = K.focalQuad;
          const fpl = fq.planeId === owner.id ? moved : byId[fq.planeId];
          const quadPts = fq.refId == null ? fpl.rect && fpl.rect.corners : (arr(fpl.refs).find((r) => isObj(r) && r.id === fq.refId) || {}).points;
          const q = cleanPts(quadPts);
          const f = q && q.length === 4 ? camera.focalFromQuadQuick(g.orderQuad(q), K.cx, K.cy) : null;
          if (f) cams = Object.assign({}, cameras, { [t.focalImage]: Object.assign({}, K, { f }) });
          else lensBroken = true; // the nudge leaves no focal estimate: everything that needs the lens is unknown
        }
        let res;
        try { res = solveAll(sub, cfg, cams, pins).planes; } catch (e) { res = {}; }
        if (lensBroken) for (const id of Object.keys(res)) if (res[id] && ['rect-refs', 'roof-3d', 'ground-3d'].indexOf(res[id].mode) >= 0) res[id] = null;
        pair[sign > 0 ? 'plus' : 'minus'] = res;
      }
      for (const id of affected) {
        if (!neededPlaneIds.has(id)) continue;
        (out[id] = out[id] || []).push({ plus: pair.plus[id] || null, minus: pair.minus[id] || null });
      }
    }
    return out;
  }

  // ================================================================ measuring points and features
  function imageToPlane(planeSol, p) {
    if (!planeSol || !planeSol.ok || !planeSol.Himg2plane || !Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) return null;
    return g.applyH(planeSol.Himg2plane, p);
  }
  function planeToImage(planeSol, uv) {
    if (!planeSol || !planeSol.ok || !planeSol.Hplane2img || !Array.isArray(uv) || !isNum(uv[0]) || !isNum(uv[1])) return null;
    return g.applyH(planeSol.Hplane2img, uv);
  }

  /**
   * Live measurement of a point list on a plane. Lengths in feet (null when the plane is not calibrated or a
   * point cannot be mapped). roof-ortho planes correct each segment for the roof pitch.
   * Also returns planePoints (plane coordinates) for callers that need them.
   */
  function measurePoints(points, closed, planeSol, opts) {
    const pts = cleanPts(points) || [];
    const isClosed = !!closed && pts.length > 2;
    const res = { lengthFt: null, segmentsFt: [], areaSqFt: null, widthFt: null, heightFt: null, pixelLength: g.polylineLength(pts, isClosed), planePoints: null };
    if (!planeSol || !planeSol.ok || !planeSol.Himg2plane || pts.length < 2) return res;
    const plane = pts.map((p) => g.applyH(planeSol.Himg2plane, p));
    if (plane.some((p) => !p)) return res;
    const lenFn = segLengthFn(planeSol);
    const segs = [];
    const n = plane.length;
    for (let i = 1; i < n; i++) segs.push(lenFn(plane[i][0] - plane[i - 1][0], plane[i][1] - plane[i - 1][1]));
    if (isClosed) segs.push(lenFn(plane[0][0] - plane[n - 1][0], plane[0][1] - plane[n - 1][1]));
    res.segmentsFt = segs;
    res.lengthFt = segs.reduce((s, v) => s + v, 0);
    res.planePoints = plane;
    // roof-ortho: vertical extents in wall coordinates are foreshortened slope distances.
    const vStretch = planeSol.mode === 'roof-ortho' && planeSol.pitch
      ? 1 / Math.max(1e-6, Math.sin(Math.atan2(planeSol.pitch.rise, planeSol.pitch.run))) : 1;
    const b = g.bbox(plane);
    res.widthFt = b.w;
    res.heightFt = b.h * vStretch;
    if (isClosed) res.areaSqFt = g.polygonArea(plane) * vStretch;
    return res;
  }

  /**
   * For off-plane objects standing on the ground (tree, column, bush) on a ground-3d plane: a vertical
   * plane parallel to the wall through the object's base point on the ground. Returns a plane solution-like
   * object (mode 'billboard') or null. A ground scale re-fitted from references scales the object too.
   */
  function billboardFor(basePx, groundSol) {
    if (!groundSol || groundSol.mode !== 'ground-3d' || !groundSol.frame || !groundSol.pose || !groundSol.K) return null;
    const ab = g.applyH(groundSol.frameHimg2plane || groundSol.Himg2plane, basePx);
    if (!ab) return null;
    const fr = groundSol.frame;
    const X = g.v3add(fr.origin, g.v3add(g.v3scale(fr.e1, ab[0]), g.v3scale(fr.e2, ab[1])));
    const frame = { origin: X, e1: [1, 0, 0], e2: [0, 1, 0], n: [0, 0, 1] };
    const Hp2i = camera.homographyForFrame(frame, groundSol.K, groundSol.pose);
    let Hi2p = Hp2i ? g.invertH(Hp2i) : null;
    const s = isNum(groundSol.groundScale) ? groundSol.groundScale : 1;
    if (Hi2p && s !== 1) Hi2p = g.normalizeH(g.multiplyH(g.scaleMatrix(s, s), Hi2p));
    const back = Hi2p ? g.invertH(Hi2p) : null;
    return Hi2p && back ? { ok: true, mode: 'billboard', Himg2plane: Hi2p, Hplane2img: back } : null;
  }

  function spiralWrapFt(heightFt, diameterIn, spacingIn) {
    // turns = H_in / s ; one turn is the hypotenuse of the circumference π·D and the rise s.
    const turns = (heightFt * 12) / spacingIn;
    return (turns * Math.hypot(Math.PI * diameterIn, spacingIn)) / 12;
  }

  const METHOD_BY_MODE = { 'rect-known': 'plane', 'rect-refs': 'plane', 'refs-only': 'plane', 'roof-3d': 'roof-3d', 'roof-ortho': 'roof-ortho', 'ground-3d': 'ground-3d' };

  /** Lowest point on screen of a polygon: where a bush touches the ground. */
  const lowestPoint = (pts) => pts.reduce((lo, p) => (p[1] > lo[1] ? p : lo), pts[0]);

  /** Length of a polyline on a plane (no allocation beyond the mapped points); null when a point cannot be mapped. */
  function planeLength(plane, closed, lenFn) {
    let L = 0;
    for (let i = 1; i < plane.length; i++) L += lenFn(plane[i][0] - plane[i - 1][0], plane[i][1] - plane[i - 1][1]);
    if (closed && plane.length > 2) L += lenFn(plane[0][0] - plane[plane.length - 1][0], plane[0][1] - plane[plane.length - 1][1]);
    return L;
  }
  function mapAll(H, pts) {
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) { const q = g.applyH(H, pts[i]); if (!q) return null; out[i] = q; }
    return out;
  }

  /**
   * The size that planning uses, measured the same way measureFeature does: length (polylines), height
   * (verticals), or the geometric mean of width and height (areas). null when it cannot be measured.
   */
  function featureMetric(geometry, pts, closed, sol) {
    if (!sol || !sol.ok || !sol.Himg2plane) return null;
    if (geometry === 'vertical') {
      const two = [pts[0], pts[pts.length - 1]];
      const bb = sol.mode === 'ground-3d' ? billboardFor(two[0], sol) : sol;
      const m = bb ? mapAll(bb.Himg2plane, two) : null;
      return m ? planeLength(m, false, segLengthFn(bb)) : null;
    }
    if (geometry === 'area') {
      const bb = sol.mode === 'ground-3d' ? billboardFor(lowestPoint(pts), sol) : sol;
      const m = bb ? mapAll(bb.Himg2plane, pts) : null;
      if (!m) return null;
      const b = g.bbox(m);
      const vStretch = bb.mode === 'roof-ortho' && bb.pitch ? 1 / Math.max(1e-6, Math.sin(Math.atan2(bb.pitch.rise, bb.pitch.run))) : 1;
      return Math.sqrt(Math.max(0, b.w * b.h * vStretch));
    }
    const m = mapAll(sol.Himg2plane, pts);
    return m ? planeLength(m, closed && pts.length > 2, segLengthFn(sol)) : null;
  }

  /**
   * Expected error (2σ, % of the size) from tap precision: every calibration tap behind the plane and every point
   * of the feature nudged by ±σ, one coordinate at a time. Infinity when a nudge breaks the measurement.
   */
  function featureUncertaintyPct(geometry, pts, closed, sol, perturb) {
    const L = featureMetric(geometry, pts, closed, sol);
    if (!isNum(L) || !(L > 0)) return null;
    let sum = 0;
    for (const pr of arr(perturb)) {
      const a = pr.plus ? featureMetric(geometry, pts, closed, pr.plus) : null;
      const b = pr.minus ? featureMetric(geometry, pts, closed, pr.minus) : null;
      if (!isNum(a) || !isNum(b)) return Infinity;
      sum += ((a - b) / 2) ** 2;
    }
    const nudge = (k, axis, d) => (axis === 0 ? [pts[k][0] + d, pts[k][1]] : [pts[k][0], pts[k][1] + d]);
    if (geometry === 'polyline' || geometry === 'polygon') {
      // A moved point only changes its own two segments.
      const H = sol.Himg2plane, lenFn = segLengthFn(sol);
      const plane = mapAll(H, pts);
      if (!plane) return Infinity;
      const n = plane.length, isClosed = closed && n > 2;
      const seg = (a, b) => lenFn(b[0] - a[0], b[1] - a[1]);
      for (let k = 0; k < n; k++) {
        const prev = k > 0 ? plane[k - 1] : (isClosed ? plane[n - 1] : null);
        const next = k < n - 1 ? plane[k + 1] : (isClosed ? plane[0] : null);
        const base = (prev ? seg(prev, plane[k]) : 0) + (next ? seg(plane[k], next) : 0);
        for (const axis of [0, 1]) {
          const qa = g.applyH(H, nudge(k, axis, SIGMA_TAP_PX)), qb = g.applyH(H, nudge(k, axis, -SIGMA_TAP_PX));
          if (!qa || !qb) return Infinity;
          const la = (prev ? seg(prev, qa) : 0) + (next ? seg(qa, next) : 0) - base;
          const lb = (prev ? seg(prev, qb) : 0) + (next ? seg(qb, next) : 0) - base;
          sum += ((la - lb) / 2) ** 2;
        }
      }
    } else {
      const idx = geometry === 'vertical' ? [0, pts.length - 1] : pts.map((_, i) => i);
      for (const k of idx) {
        for (const axis of [0, 1]) {
          const mv = (d) => pts.map((p, i) => (i === k ? nudge(k, axis, d) : p));
          const a = featureMetric(geometry, mv(SIGMA_TAP_PX), closed, sol);
          const b = featureMetric(geometry, mv(-SIGMA_TAP_PX), closed, sol);
          if (!isNum(a) || !isNum(b)) return Infinity;
          sum += ((a - b) / 2) ** 2;
        }
      }
    }
    return (200 * Math.sqrt(sum)) / L;
  }

  /** Typical distance (ft) of an off-plane item from the wall, for the bias hint. */
  const OFF_PLANE_DIST_FT = { tree: 12, bush: 3, column: 6, ridge: 14 };

  /**
   * Measure one feature on its plane solution. ctx: {config, wastePct | settings.wastePct, perturb}.
   * ctx.perturb (from measureProject) holds nudged plane solutions for the tap-precision estimate.
   * Override rules (SPEC §4): polyline/polygon overrideFt = length; vertical overrideFt = HEIGHT (wrap
   * recomputed); bushes ignore overrideFt and use params.overrideWidthFt / overrideHeightFt.
   */
  function measureFeature(feature, planeSol, ctx) {
    const c = isObj(ctx) ? ctx : {};
    const config = isObj(c.config) ? c.config : catalog.DEFAULT_CONFIG;
    const settings = isObj(c.settings) ? c.settings : {};
    const wastePct = isNum(c.wastePct) ? c.wastePct : (isNum(settings.wastePct) ? settings.wastePct : 10);
    const f = isObj(feature) ? feature : {};
    const type = typeof f.type === 'string' && Object.prototype.hasOwnProperty.call(catalog.FEATURE_TYPES, f.type) ? catalog.FEATURE_TYPES[f.type] : null;
    const out = {
      ok: false, featureId: f.id != null ? f.id : null, type: f.type != null ? f.type : null, method: 'uncalibrated',
      measuredFt: null, wrapFt: null, lengthFt: null, withWasteFt: null,
      areaSqFt: null, widthFt: null, heightFt: null, lights: null, pitchEstimate: null,
      overridden: false, confidence: null, reason: null, pixelLength: null, segmentsFt: null, uncertaintyPct: null,
    };
    const thresholds = isObj(config.confidence) ? config.confidence : catalog.DEFAULT_CONFIG.confidence;
    const failWith = (reason) => {
      out.ok = false;
      out.reason = reason;
      out.confidence = { level: 'low', score: 0, reasons: [reason] };
      return out;
    };
    if (!type) return failWith('This item has an unknown type, so it cannot be measured.');
    const label = typeof f.label === 'string' && f.label.trim() ? f.label.trim() : type.label;
    const params = isObj(f.params) ? f.params : {};
    const pts = cleanPts(f.points);
    const minPts = type.geometry === 'vertical' ? 2 : (type.minPoints || 2);
    let geomProblem = null;
    if (!pts) geomProblem = 'Some points of ' + label + ' are not valid. Redraw it.';
    else if (pts.length < minPts) geomProblem = label + ' needs at least ' + minPts + ' points.';

    const sol = planeSol && planeSol.ok ? planeSol : null;
    let planeProblem = null;
    if (!planeSol) planeProblem = label + ' is not on a known wall or plane. Pick a plane for it.';
    else if (!planeSol.ok) planeProblem = planeSol.reason || 'Its plane has no scale yet.';
    // Points of a roof or ground item must lie on that surface: at or above its horizon in the photo they would
    // map behind the camera (or absurdly far away).
    if (!geomProblem && sol && (sol.mode === 'ground-3d' || sol.mode === 'roof-3d') && sol.Hplane2img) {
      const onSurface = sol.mode === 'ground-3d' && (type.geometry === 'vertical' || type.geometry === 'area')
        ? [type.geometry === 'vertical' ? pts[0] : lowestPoint(pts)] : pts;
      const sign = sol.frontSign || 1;
      const beyond = onSurface.some((p) => {
        const uv = g.applyH(sol.Himg2plane, p);
        return !uv || wOf(sol.Hplane2img, uv) * sign <= 1e-9 * Math.abs(sol.Hplane2img[8] || 1);
      });
      if (beyond) {
        planeProblem = sol.mode === 'ground-3d'
          ? 'A point of ' + label + ' is at or above the horizon in the photo, so it cannot be on the ground. Tap points on the ground itself, or put it on a wall.'
          : 'A point of ' + label + ' is at or above the horizon of this roof slope in the photo, so it cannot lie on it. Redraw it on the roof.';
      }
    }
    const canMeasure = !geomProblem && !!sol && !planeProblem;
    const typeConf = type.id === 'tree' ? config.tree : type.id === 'column' ? config.column : null;

    // ---- geometric measurement
    let effMode = sol ? sol.mode : 'uncalibrated';
    let mp = null;
    const closed = type.geometry === 'area' ? true
      : (typeof f.closed === 'boolean' ? f.closed : !!type.closedDefault);
    if (canMeasure) {
      if (type.geometry === 'vertical') {
        const two = [pts[0], pts[pts.length - 1]];
        const bb = sol.mode === 'ground-3d' ? billboardFor(two[0], sol) : null;
        mp = measurePoints(two, false, bb || sol);
        if (isNum(mp.lengthFt)) { out.measuredFt = mp.lengthFt; out.heightFt = mp.lengthFt; }
      } else if (type.geometry === 'area') {
        const bb = sol.mode === 'ground-3d' ? billboardFor(lowestPoint(pts), sol) : null;
        mp = measurePoints(pts, true, bb || sol);
        if (isNum(mp.lengthFt)) {
          out.measuredFt = mp.lengthFt; out.areaSqFt = mp.areaSqFt; out.widthFt = mp.widthFt; out.heightFt = mp.heightFt;
        }
      } else {
        mp = measurePoints(pts, closed, sol);
        if (isNum(mp.lengthFt)) {
          out.measuredFt = mp.lengthFt;
          if (closed) { out.areaSqFt = mp.areaSqFt; out.widthFt = mp.widthFt; out.heightFt = mp.heightFt; }
        }
      }
      out.segmentsFt = mp.segmentsFt.length ? mp.segmentsFt : null;
    }
    if (pts) out.pixelLength = g.polylineLength(pts, closed && pts.length > 2);

    // ---- planning numbers and overrides
    const overrideFt = posNum(f.overrideFt);
    let fullOverride = false;
    const extraReasons = [];
    let assumedDiameterIn = null;
    if (type.geometry === 'area') {
      const oW = posNum(params.overrideWidthFt), oH = posNum(params.overrideHeightFt);
      const w = oW || out.widthFt, h = oH || out.heightFt;
      if (oW) out.widthFt = oW;
      if (oH) out.heightFt = oH;
      out.overridden = !!(oW || oH);
      fullOverride = !!(oW && oH);
      if (out.overridden && !fullOverride) extraReasons.push((oW ? 'Width' : 'Height') + ' is tape-measured; ' + (oW ? 'height' : 'width') + ' is measured from the photo.');
      if (isNum(w) && isNum(h)) {
        const b = isObj(config.bush) ? config.bush : catalog.DEFAULT_CONFIG.bush;
        out.lights = Math.round(b.lightsPerUnit * (h / b.heightUnitFt) * (w / b.widthUnitFt));
        out.ok = true;
      }
      out.lengthFt = null;
      out.withWasteFt = null;
    } else if (type.geometry === 'vertical') {
      const height = overrideFt || out.measuredFt;
      out.overridden = !!overrideFt;
      fullOverride = out.overridden;
      if (isNum(height)) {
        out.heightFt = height;
        out.ok = true;
        if (type.id === 'tree' && params.wrapMode === 'canopy') {
          const per = isObj(config.tree) && isNum(config.tree.canopyLightsPerFtHeight) ? config.tree.canopyLightsPerFtHeight : 100;
          out.lights = Math.round(per * height);
          out.wrapFt = null;
          out.lengthFt = height;
        } else {
          const tc = typeConf || {};
          const D = posNum(params.diameterIn) || posNum(tc.defaultDiameterIn) || 10;
          const s = posNum(params.spiralSpacingIn) || posNum(tc.spiralSpacingIn) || 4;
          if (type.id === 'tree' && !posNum(params.diameterIn)) assumedDiameterIn = D;
          out.wrapFt = spiralWrapFt(height, D, s);
          out.lengthFt = out.wrapFt;
        }
        out.withWasteFt = out.lengthFt;
      }
    } else {
      out.overridden = !!overrideFt;
      fullOverride = out.overridden;
      const L = overrideFt || out.measuredFt;
      if (isNum(L)) {
        out.ok = true;
        out.lengthFt = L;
        out.withWasteFt = catalog.LINEAR_TYPES.indexOf(type.id) >= 0 ? L * (1 + wastePct / 100) : L;
      }
    }

    // ---- pitch estimate for in-plane rakes
    if (type.id === 'rake' && sol && sol.kind === 'wall' && pts) {
      const s = rakeSamples(pts, sol);
      if (s.length) {
        const m = g.median(s);
        out.pitchEstimate = { rise: g.clamp(Math.round(m), 2, 18), run: 12, angleDeg: pitchAngleDeg(m, 12) };
      }
    }

    if (!out.ok) return failWith(geomProblem || planeProblem || label + ' could not be measured.');
    out.method = fullOverride ? 'override' : (METHOD_BY_MODE[effMode] || 'plane');
    if (fullOverride) {
      // A tape-measured height still wraps with the trunk diameter, which may be assumed.
      out.confidence = scoreConfidence({ overridden: true, thresholds, assumedDiameterIn });
      return out;
    }

    // ---- confidence
    let extrapolation = false;
    if (sol && sol.extent && mp && mp.planePoints) {
      const e = sol.extent, fb = g.bbox(mp.planePoints);
      const rw = e.maxU - e.minU, rh = e.maxV - e.minV;
      const outU = Math.max(e.minU - fb.minX, fb.maxX - e.maxU);
      const outV = Math.max(e.minV - fb.minY, fb.maxY - e.maxV);
      extrapolation = outU > 1.5 * rw || outV > 1.5 * rh;
    }
    const offPlaneType = type.offPlane || type.id === 'column' ? type.id : null;
    const offPlaneOnWall = !!(sol && sol.kind === 'wall' && offPlaneType);
    let offPlaneBiasPct = null;
    if (offPlaneOnWall && sol.pose && sol.pose.C && sol.pose.C[2] > 0) {
      const dOff = OFF_PLANE_DIST_FT[type.id] || 5;
      offPlaneBiasPct = (100 * dOff) / (sol.pose.C[2] + dOff);
    }
    if (canMeasure && c.perturb && sol && sol.planeId != null) {
      const perturb = c.perturb[sol.planeId] || [];
      out.uncertaintyPct = featureUncertaintyPct(type.geometry, pts, closed, sol, perturb);
    }
    out.confidence = scoreConfidence({
      mode: effMode,
      kind: sol ? sol.kind : null,
      checks: sol ? sol.checks : 0,
      disagreementPct: sol ? sol.disagreementPct : null,
      disagreementZ: sol ? sol.disagreementZ : null,
      onlyMediumLowRefs: !!(sol && sol.calib && sol.calib.onlyMediumLowRefs),
      minCourses: sol && sol.calib ? sol.calib.minCourses : null,
      viewAngleDeg: sol ? sol.viewAngleDeg : null,
      focalSource: sol && sol.K ? sol.K.source : null,
      focalRelStd: sol && sol.K ? sol.K.relStd : null,
      focalMismatchPct: sol ? sol.focalMismatchPct : null,
      poseConsistencyPct: sol ? sol.poseConsistencyPct : null,
      poseTolerancePct: sol ? sol.poseTolerancePct : null,
      pitchSource: sol && sol.kind === 'roof' && sol.pitch ? sol.pitch.source : null,
      pitchOnEave: sol && sol.pitchInfo ? sol.pitchInfo.onEave : null,
      pitchSpread: sol && sol.pitchInfo ? sol.pitchInfo.spread : null,
      rectProblem: sol && sol.calib ? sol.calib.rectProblem : null,
      refsBothDirections: !!(sol && sol.calib && sol.calib.refsBothDirections),
      anisotropic: !!(sol && sol.scale && sol.scale.anisotropic),
      scaleFrom: sol && sol.calib ? sol.calib.scaleFrom : null,
      offPlane: offPlaneOnWall ? type.id : null,
      offPlaneBiasPct,
      assumedDiameterIn,
      extrapolation,
      pixelLength: out.pixelLength,
      uncertaintyPct: out.uncertaintyPct,
      extraReasons,
      thresholds,
    });
    return out;
  }

  const LEVELS = ['low', 'medium', 'high'];

  /**
   * Confidence score: start at 100 and subtract (SPEC §5.5). Every deduction adds a plain-language reason.
   * Then level caps that no score can buy back (each with its reason, listed first): tap-precision uncertainty,
   * refs-only walls, roof-ortho, an assumed focal length or pitch, off-plane items, a single unchecked reference,
   * a lens setting that disagrees with the rectangles, an assumed trunk diameter. When a cap lowers the level the
   * score is clamped into that level's band.
   * factors: {overridden, mode, kind, checks, disagreementPct, disagreementZ, onlyMediumLowRefs, minCourses,
   *           viewAngleDeg, focalSource, focalRelStd, focalMismatchPct, poseConsistencyPct, poseTolerancePct,
   *           pitchSource, pitchOnEave, pitchSpread, rectProblem, refsBothDirections, anisotropic, scaleFrom,
   *           offPlane (type id or bool), offPlaneBiasPct, assumedDiameterIn, extrapolation, pixelLength,
   *           uncertaintyPct, extraReasons, thresholds: {highMin, mediumMin}, reason}
   */
  function scoreConfidence(factors) {
    const fx = isObj(factors) ? factors : {};
    const th = isObj(fx.thresholds) ? fx.thresholds : catalog.DEFAULT_CONFIG.confidence;
    const levelOf = (s) => (s >= th.highMin ? 'high' : s >= th.mediumMin ? 'medium' : 'low');
    const caps = []; // {level, why}
    const cap = (level, why) => caps.push({ level, why });
    const diameterReason = isNum(fx.assumedDiameterIn)
      ? 'Trunk diameter assumed (' + Math.round(fx.assumedDiameterIn) + ' in); enter it for an accurate wrap.' : null;
    if (fx.overridden) {
      if (diameterReason) return { level: 'medium', score: Math.min(100, th.highMin - 1), reasons: [diameterReason, 'Height is tape-measured.'] };
      return { level: 'high', score: 100, reasons: ['Tape-measured'] };
    }
    const mode = fx.mode;
    if (!Object.prototype.hasOwnProperty.call(MODE_PENALTY, mode)) {
      return { level: 'low', score: 0, reasons: [fx.reason || 'Not measured yet: this plane has no scale.'] };
    }
    const derived = mode === 'roof-3d' || mode === 'ground-3d' || mode === 'roof-ortho';
    const threeD = mode === 'roof-3d' || mode === 'ground-3d';
    let score = 100;
    const reasons = [];
    const take = (pts, why) => { score -= pts; reasons.push(why); };

    if (typeof fx.rectProblem === 'string' && fx.rectProblem) cap('low', fx.rectProblem);
    if (MODE_PENALTY[mode]) take(MODE_PENALTY[mode], MODE_REASON[mode]);
    if (mode === 'refs-only') {
      if (fx.refsBothDirections) cap('medium', 'Mark a perspective rectangle (garage door, front door or the house corners) for a better rating.');
      else cap('low', 'Nothing checks the straight-on assumption. Mark a perspective rectangle, or add a horizontal and a vertical reference that agree.');
    }
    if (mode === 'roof-ortho') cap('low', 'Add a perspective rectangle on the wall to measure the roof.');

    const single = !derived && fx.scaleFrom === 'refs' && !(fx.checks >= 1);
    if (single) {
      cap('medium', (fx.anisotropic ? "Each direction's scale rests on one reference that nothing checks. Add a third reference" : 'The scale rests on one reference that nothing checks. Add a second reference') +
        ' on a different object: a recessed door or a set-back wall would throw every length off.');
      score -= 5;
    } else if (!(fx.checks >= 1)) {
      take(5, derived ? 'Nothing on this surface cross-checks its scale; a tape-measured length on it would.' : 'There is no second reference to cross-check the scale.');
    }
    const d = fx.disagreementPct;
    // A disagreement that tap noise on short references explains (z ≤ 2) costs nothing: adding a correct reference
    // must never lower the rating.
    const significant = !isNum(fx.disagreementZ) || fx.disagreementZ > 2;
    if (isNum(d) && significant) {
      const msg = 'References disagree by ' + d.toFixed(1) + '%.';
      if (d > 10) take(35, msg);
      else if (d > 6) take(20, msg);
      else if (d >= 3) take(10, msg);
    }
    if (fx.onlyMediumLowRefs) take(10, 'The scale comes only from medium-quality references such as siding or brick courses.');
    if (isNum(fx.minCourses) && fx.minCourses < 8) {
      take(10, 'The siding or brick reference spans only ' + fx.minCourses + ' courses. Span 8 or more for better accuracy.');
    }
    const va = fx.viewAngleDeg;
    if (isNum(va)) {
      const msg = 'The photo views this wall at ' + Math.round(va) + '° off straight-on.';
      if (va > 50) take(25, msg);
      else if (va > 35) take(15, msg);
      else if (va >= 20) take(5, msg);
    }
    const usesLens = mode === 'rect-refs' || threeD;
    if (fx.focalSource === 'default' && usesLens) {
      take(10, 'The camera focal length is assumed (phone main camera). Choose the camera that took the photo.');
      if (threeD) cap('low', 'Roof and ground lengths need the real focal length, and it is only assumed here. Choose the camera that took the photo.');
      else if (!fx.anisotropic) cap('medium', 'The wall\'s proportions come from an assumed focal length. Add a horizontal and a vertical reference, or choose the camera that took the photo.');
    }
    if (fx.focalSource === 'rectangle' && usesLens && isNum(fx.focalRelStd) && fx.focalRelStd > 0.05) {
      take(10, 'The focal length measured from the rectangle is unsteady. A larger or more angled rectangle, or a photo with lens data, measures it better.');
    }
    if (isNum(fx.focalMismatchPct) && usesLens) {
      const why = 'The lens setting does not match the rectangles in the photo (off by ' + Math.round(fx.focalMismatchPct) + '%). Choose Automatic, or enter the measured focal length.';
      if (threeD) cap('low', why);
      else if (!fx.anisotropic) cap('medium', why);
    }
    if (threeD && isNum(fx.poseConsistencyPct) && fx.poseConsistencyPct > (isNum(fx.poseTolerancePct) ? fx.poseTolerancePct : POSE_TOL_MIN_PCT)) {
      cap('low', 'The wall rectangle does not fit the lens setting (off by ' + fx.poseConsistencyPct.toFixed(0) + '%), so lengths worked out in 3D from it are unreliable. Check the rectangle size and the lens.');
    }
    if (fx.pitchSource === 'estimated') {
      take(10, 'The roof pitch is estimated from the gable.');
      if (isNum(fx.pitchSpread) && fx.pitchSpread > PITCH_SPREAD_MAX) cap('low', 'The gable rakes disagree on the roof pitch. Enter the pitch of this roof.');
      else if (fx.pitchOnEave === false) cap('low', 'The roof pitch is borrowed from a gable that is not on this roof\'s eave, and roofs often differ. Enter the pitch of this roof.');
      else cap('low', 'The roof pitch is estimated from a gable on the wall, which may not match this roof\'s slope. Enter the pitch (a phone level on a rake board) for a better rating.');
    } else if (fx.pitchSource === 'default') {
      take(25, 'The roof pitch is unknown, so 6/12 is assumed. Enter the pitch.');
      cap('low', 'Roof lengths depend on the pitch, and it is only assumed. Enter the pitch.');
    }
    if (fx.offPlane) {
      const bias = isNum(fx.offPlaneBiasPct) ? ' (about ' + Math.round(fx.offPlaneBiasPct) + '% for something ' + (OFF_PLANE_DIST_FT[fx.offPlane] || 5) + ' ft from it with this camera)' : '';
      if (fx.offPlane === 'ridge') {
        take(15, 'The ridge sits above and behind the wall, so measuring it on the wall is approximate. Draw it on a roof plane.');
        cap('low', 'A ridge measured on the wall comes out too short' + bias + '. Draw it on a roof plane.');
      } else {
        take(15, 'This item stands in front of the wall, so its size is approximate.');
        const steer = ' Trace it on a ground plane (from the wall\'s base line) to measure its true size.';
        if (fx.offPlane === 'bush') cap('medium', 'Items in front of the wall measure too large' + bias + '.' + steer);
        else cap('low', 'Items in front of the wall measure too large' + bias + '.' + steer);
      }
    }
    if (diameterReason) cap('low', diameterReason);
    if (fx.extrapolation) take(10, 'This item reaches far beyond the measured rectangle, so small errors grow.');
    if (isNum(fx.pixelLength) && fx.pixelLength > 0 && 2 / fx.pixelLength > 0.03) {
      take(10, 'This item is short on screen, so a small tap error is a large share of its length. Zoom in to place points.');
    }
    const u = fx.uncertaintyPct;
    if (u === Infinity) cap('low', 'A small tap error changes this measurement a lot. Re-tap the rectangle and references, zoomed in.');
    else if (isNum(u)) {
      // The fix depends on the surface: ground and roof lengths hinge on the camera pose worked out from the wall,
      // so zooming in on taps helps far less than a tape-measured length or a better vantage point.
      const fix = mode === 'ground-3d'
        ? 'from street level the ground is seen almost edge-on. Add a tape-measured reference on this ground surface, or take the photo from closer or higher.'
        : (mode === 'roof-3d' || mode === 'roof-ortho')
          ? 'roof lengths depend on the camera angle worked out from the wall. Type a tape-measured length if you can, or rely on the 10% waste.'
          : 'zoom in or use a larger rectangle.';
      const why = 'Expected error about ±' + (u < 10 ? u.toFixed(1) : Math.round(u)) + '% from tap precision; ' + fix;
      if (u > U_MEDIUM_PCT) cap('low', why);
      else if (u > U_HIGH_PCT) cap('medium', why);
    }
    for (const r of arr(fx.extraReasons)) reasons.push(r);
    score = g.clamp(Math.round(score), 0, 100);
    let level = levelOf(score);
    const limiting = [];
    for (const lv of ['low', 'medium']) {
      const these = caps.filter((x) => x.level === lv);
      if (!these.length) continue;
      if (LEVELS.indexOf(lv) < LEVELS.indexOf(level)) level = lv;
      for (const x of these) if (limiting.indexOf(x.why) < 0) limiting.push(x.why);
    }
    if (level === 'medium') score = Math.min(score, th.highMin - 1);
    if (level === 'low') score = Math.min(score, th.mediumMin - 1);
    score = Math.max(0, score);
    const all = limiting.concat(reasons.filter((r) => limiting.indexOf(r) < 0));
    if (!all.length) all.push('Measured on a known-size rectangle and cross-checked.');
    if (isNum(u) && u <= U_HIGH_PCT && level === 'high') all.push('Expected error about ±' + u.toFixed(1) + '% from tap precision.');
    return { level, score, reasons: all };
  }

  /**
   * A typical item on a plane, in image pixels, for the plane's own tap-precision estimate: a line across the
   * wall rectangle at mid-height, a 15 ft walkway edge out from the wall base, or a 10 ft line up a roof slope.
   */
  function representativeSegment(sol) {
    const e = sol.extent || sol.gridExtent;
    let a = null, b = null;
    if (sol.kind === 'wall' && isObj(e)) {
      const vm = (e.minV + e.maxV) / 2;
      if (sol.extent) { a = [e.minU, vm]; b = [e.maxU, vm]; } else { const um = (e.minU + e.maxU) / 2; a = [um - 5, vm]; b = [um + 5, vm]; }
    } else if (sol.mode === 'ground-3d' && isObj(sol.gridExtent)) {
      const um = sol.gridExtent.maxU / 2; a = [um, 1]; b = [um, 16];
    } else if (sol.mode === 'roof-3d' && isObj(sol.gridExtent)) {
      const um = sol.gridExtent.maxU / 2; a = [um, 0]; b = [um, 10];
    }
    if (!a) return null;
    const pa = planeToImage(sol, a), pb = planeToImage(sol, b);
    return pa && pb ? [pa, pb] : null;
  }

  /** Plane-level confidence (no feature-specific factors): shown on the plane's pill. */
  function planeConfidence(sol, thresholds, uncertaintyPct) {
    if (!sol || !sol.ok) return null;
    return scoreConfidence({
      uncertaintyPct,
      mode: sol.mode, kind: sol.kind, checks: sol.checks, disagreementPct: sol.disagreementPct, disagreementZ: sol.disagreementZ,
      onlyMediumLowRefs: !!(sol.calib && sol.calib.onlyMediumLowRefs), minCourses: sol.calib ? sol.calib.minCourses : null,
      viewAngleDeg: sol.viewAngleDeg, focalSource: sol.K ? sol.K.source : null, focalRelStd: sol.K ? sol.K.relStd : null,
      focalMismatchPct: sol.focalMismatchPct, poseConsistencyPct: sol.poseConsistencyPct, poseTolerancePct: sol.poseTolerancePct,
      pitchSource: sol.kind === 'roof' && sol.pitch ? sol.pitch.source : null,
      pitchOnEave: sol.pitchInfo ? sol.pitchInfo.onEave : null, pitchSpread: sol.pitchInfo ? sol.pitchInfo.spread : null,
      rectProblem: sol.calib ? sol.calib.rectProblem : null, refsBothDirections: !!(sol.calib && sol.calib.refsBothDirections),
      anisotropic: !!(sol.scale && sol.scale.anisotropic), scaleFrom: sol.calib ? sol.calib.scaleFrom : null,
      thresholds,
    });
  }

  // ================================================================ project
  function emptyTotals() {
    const byType = {};
    for (const t of catalog.TYPE_ORDER) byType[t] = { count: 0, lengthFt: 0, withWasteFt: 0, lights: 0 };
    return { byType, totalFt: 0, totalWithWasteFt: 0 };
  }

  /**
   * Measure everything in a project. Never throws; problems show up as ok:false items and warnings
   * [{level:'warn'|'info', code, message, planeId?, featureId?}].
   */
  function measureProject(project, config) {
    try {
      return measureProjectUnsafe(project, config);
    } catch (e) {
      return {
        ok: false, cameras: {}, planes: {}, pitch: { rise: DEFAULT_PITCH.rise, run: DEFAULT_PITCH.run, source: 'default', angleDeg: null, samples: [] },
        features: {}, totals: emptyTotals(),
        warnings: [{ level: 'warn', code: 'measure-failed', message: 'Measurements could not be worked out because the project data is damaged.' }],
      };
    }
  }

  function measureProjectUnsafe(project, config) {
    const isProject = isObj(project);
    const proj = isProject ? project : {};
    const cfg = isObj(config) ? config : catalog.getLibrary(proj).config;
    const settings = isObj(proj.settings) ? proj.settings : {};
    const cameras = resolveCameras(proj, cfg);
    const solvedAll = solveAll(proj, cfg, cameras, null);
    const solved = { cameras, planes: solvedAll.planes, pitch: solvedAll.pitch };
    const warnings = [];
    if (!isProject) warnings.push({ level: 'warn', code: 'not-a-project', message: 'There is no project to measure.' });

    for (const imgId of Object.keys(cameras)) {
      const K = cameras[imgId];
      if (!K) continue;
      if (K.exifIgnored) warnings.push({ level: 'info', code: 'exif-ignored', message: K.exifIgnored, imageId: imgId });
      const mm = focalMismatch(K);
      if (mm && mm.significant) {
        const what = K.source === 'exif' ? 'The lens data in the photo' : 'The lens setting (' + K.label + ')';
        warnings.push({
          level: 'warn', code: 'focal-mismatch', imageId: imgId, suggestedFocalPx: Math.round(mm.rect.f),
          message: what + ' gives a focal length of ' + Math.round(K.f) + ' px, but the ' + mm.rect.what + ' on ' + quoted(mm.rect.planeName, 'a wall') +
            ' measures ' + Math.round(mm.rect.f) + ' px. The lens setting does not match the photo (a zoomed or cropped picture?): choose Automatic, or enter ' +
            Math.round(mm.rect.f) + ' px by hand.',
        });
      }
    }
    for (const pid of Object.keys(solved.planes)) {
      for (const is of solved.planes[pid].issues) warnings.push({ level: is.level, code: is.code, message: is.message, planeId: pid });
    }
    const hasRoof = Object.keys(solved.planes).some((k) => solved.planes[k].kind === 'roof' && solved.planes[k].ok);
    if (hasRoof && solved.pitch.source === 'estimated') {
      warnings.push({ level: 'info', code: 'pitch-estimated', message: 'Roof pitch estimated at ' + solved.pitch.rise + '/12 from the gable rakes. Enter it if you know it.' });
    } else if (hasRoof && solved.pitch.source === 'default') {
      const anyDefault = Object.keys(solved.planes).some((k) => solved.planes[k].pitch && solved.planes[k].pitch.source === 'default');
      if (anyDefault) warnings.push({ level: 'info', code: 'pitch-default', message: 'Roof pitch is unknown, so 6/12 is assumed. Trace a gable rake on a wall or enter the pitch.' });
    }
    const thresholds = isObj(cfg.confidence) ? cfg.confidence : catalog.DEFAULT_CONFIG.confidence;

    // Nudged plane solutions for the tap-precision estimate (every solved plane: its pill shows it too).
    const needed = new Set(Object.keys(solved.planes).filter((pid) => solved.planes[pid].ok));
    let perturb = {};
    if (needed.size) {
      try { perturb = perturbedSolutions(proj, cfg, cameras, solvedAll, needed); } catch (e) { perturb = {}; }
    }
    for (const pid of Object.keys(solved.planes)) {
      const sol = solved.planes[pid];
      let u = null;
      if (sol.ok && sol.mode !== 'roof-ortho') {
        const seg = representativeSegment(sol);
        try { u = seg ? featureUncertaintyPct('polyline', seg, false, sol, perturb[pid] || []) : null; } catch (e) { u = null; }
      }
      sol.uncertaintyPct = isNum(u) || u === Infinity ? u : null;
      sol.confidence = planeConfidence(sol, thresholds, sol.uncertaintyPct);
    }

    const features = {};
    const totals = emptyTotals();
    const ctx = { config: cfg, settings, wastePct: isNum(settings.wastePct) ? settings.wastePct : 10, perturb };
    arr(proj.features).forEach((f, idx) => {
      const id = isObj(f) && f.id != null ? String(f.id) : 'feature_' + idx;
      const sol = isObj(f) && Object.prototype.hasOwnProperty.call(solved.planes, f.planeId) ? solved.planes[f.planeId] : null;
      let m;
      try { m = measureFeature(f, sol, ctx); } catch (e) {
        m = measureFeature(null, null, ctx);
        m.reason = 'This item could not be measured because its data is damaged.';
        m.confidence = { level: 'low', score: 0, reasons: [m.reason] };
      }
      if (m.featureId == null) m.featureId = id;
      features[id] = m;
      const label = isObj(f) && typeof f.label === 'string' && f.label.trim() ? f.label.trim()
        : (m.type && catalog.FEATURE_TYPES[m.type] ? catalog.FEATURE_TYPES[m.type].label : 'An item');
      if (!m.ok) {
        warnings.push({ level: 'warn', code: 'feature-unmeasured', message: label + ' cannot be measured yet: ' + m.reason, featureId: id });
      } else if (m.confidence && m.confidence.level === 'low') {
        warnings.push({ level: 'info', code: 'low-confidence', message: label + ' is a rough measurement: ' + m.confidence.reasons[0], featureId: id });
      }
      const bt = m.type && Object.prototype.hasOwnProperty.call(totals.byType, m.type) ? totals.byType[m.type] : null;
      if (!bt) return;
      bt.count += 1;
      if (!m.ok) return;
      if (isNum(m.lights)) bt.lights += m.lights;
      if (m.type === 'bush') return; // bushes are planned by light count, not feet
      if (isNum(m.lengthFt)) { bt.lengthFt += m.lengthFt; totals.totalFt += m.lengthFt; }
      if (isNum(m.withWasteFt)) { bt.withWasteFt += m.withWasteFt; totals.totalWithWasteFt += m.withWasteFt; }
    });
    return { ok: isProject, cameras: solved.cameras, planes: solved.planes, pitch: solved.pitch, features, totals, warnings };
  }

  // ================================================================ overlay helpers and formatting
  /**
   * Image-space segments of a plane-aligned grid every stepFt over extent (default: the plane's gridExtent).
   * Lines that would pass behind the camera are dropped. The step grows if the grid would be too dense.
   */
  function planeGridLines(planeSol, stepFt, extent) {
    if (!planeSol || !planeSol.ok || !planeSol.Hplane2img) return [];
    const e = isObj(extent) ? extent : (planeSol.gridExtent || planeSol.extent);
    if (!isObj(e) || ![e.minU, e.minV, e.maxU, e.maxV].every(isNum) || e.maxU <= e.minU || e.maxV <= e.minV) return [];
    let step = posNum(stepFt) || 1;
    const count = (s) => Math.floor(e.maxU / s) - Math.ceil(e.minU / s) + Math.floor(e.maxV / s) - Math.ceil(e.minV / s) + 2;
    while (count(step) > MAX_GRID_LINES) step *= 2;
    const H = planeSol.Hplane2img;
    const center = [(e.minU + e.maxU) / 2, (e.minV + e.maxV) / 2];
    const sign = Math.sign(wOf(H, center)) || 1;
    const seg = (a, b) => {
      if (wOf(H, a) * sign <= 1e-9 || wOf(H, b) * sign <= 1e-9) return null;
      const p = g.applyH(H, a), q = g.applyH(H, b);
      return p && q ? [p, q] : null;
    };
    const lines = [];
    for (let k = Math.ceil(e.minU / step); k * step <= e.maxU + 1e-9; k++) {
      const s = seg([k * step, e.minV], [k * step, e.maxV]);
      if (s) lines.push(s);
    }
    for (let k = Math.ceil(e.minV / step); k * step <= e.maxV + 1e-9; k++) {
      const s = seg([e.minU, k * step], [e.maxU, k * step]);
      if (s) lines.push(s);
    }
    return lines;
  }

  /** "32′ 4″" (ft-in, nearest inch) or "32.3 ft" (ft-decimal). Non-numbers give "—". */
  function formatLength(ft, format) {
    if (!isNum(ft)) return '—';
    if (format === 'ft-decimal') {
      const v = round(ft, 1);
      return (Object.is(v, -0) ? 0 : v).toFixed(1) + ' ft';
    }
    const totalIn = Math.round(Math.abs(ft) * 12);
    const sign = ft < 0 && totalIn > 0 ? '-' : '';
    return sign + Math.floor(totalIn / 12) + '′ ' + (totalIn % 12) + '″';
  }

  return {
    REF_PRESETS, WALL_RECT_PRESETS, QUALITY_WEIGHT, getRefPreset, refFromPreset, refLabel,
    solvePlanes, estimatePitch, resolvePitch, measurePoints, measureFeature, scoreConfidence, measureProject,
    imageToPlane, planeToImage, planeGridLines, formatLength, spiralWrapFt,
  };
});
