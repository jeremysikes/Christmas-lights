/* LightPlan core: measure.
 * Calibration (references, perspective rectangles), plane solutions (wall, roof, ground), feature measurement,
 * confidence scoring and the measureProject() entry point.
 *
 * How a length is measured:
 *  1. Each image gets intrinsics K (camera.resolveCamera: manual → preset → EXIF → rectangle → phone 1×).
 *  2. Each WALL plane gets a homography image px → wall feet [u right, v up]:
 *       rect-known  perspective rectangle of known size (exact, no camera needed for in-plane lengths)
 *       rect-refs   rectangle of unknown size: its true proportions come from K; the scale comes from references
 *                   (an isotropic fit, or separate horizontal/vertical scales when refs exist in both directions,
 *                   which also absorbs a wrong focal length)
 *       refs-only   no rectangle: a straight-on similarity (ft per px) from references
 *     With a rectangle, the camera pose is recovered from the homography (camera.poseFromHomography).
 *  3. ROOF and GROUND planes are built in 3D from their parent wall's pose: the eave/base line is lifted to
 *     wall coordinates, a sloped (roof) or level (ground) frame is built on it, and its homography is
 *     K·[R·e1, R·e2, R·origin + t]. Without a pose, roofs fall back to an orthographic pitch correction.
 *  4. Features are measured in their plane's coordinates; confidence is scored from how the plane was solved.
 *
 * Pure: no DOM, no clocks, inputs are never mutated, compute paths never throw on bad project data
 * (they return ok:false with a plain-language `reason`).
 *
 * Deviations from SPEC §5.5 (all documented signatures still work):
 *  - PlaneSolution also has: `reason` (why !ok), `issues` ([{code, level, message}] mirroring `warnings`),
 *    `calib` ({scaleFrom:'rect'|'refs'|'parent', onlyMediumLowRefs, minCourses}) used for confidence,
 *    `frame` (3D frame of roof/ground planes), `gridExtent` (plane-space box for overlay grids on every plane;
 *    `extent` stays the rectangle's box or null), `parentPlaneId` for roof/ground planes.
 *  - viewAngleDeg of a roof/ground plane is its parent wall's view angle (the 3D accuracy comes from the wall).
 *  - scale.sx/sy are the fitted scale factors (ft per base unit): 1 for rect-known, ft per px for refs-only.
 *  - disagreementPct is the spread between independent size constraints: (max ratio / min ratio − 1)·100 where
 *    ratio = measured/expected with the final solution (for rect-known, the rectangle itself counts as ratio 1).
 *    With two references one of which is 10% off this reads 10, which is what the warning should say.
 *  - Roof/ground planes inherit `checks` and `disagreementPct` from their parent wall (plus their own refs).
 *  - On a plane without `rect`, the largest valid known-size rect ref becomes the plane rectangle.
 *  - An unknown-size rect with ONE known side uses that side as an extra scale reference.
 *  - FeatureMeasurement also has: `reason` (why !ok), `pixelLength`, `segmentsFt`.
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

  /** Measure constraints with the final map; returns refResults and the ratio spread. */
  function evaluateConstraints(constraints, H, lenFn, includeUnitRatio) {
    const refResults = [];
    const ratios = includeUnitRatio ? [1] : [];
    for (const c of constraints) {
      const d = constraintVector(c, H);
      const measured = d ? lenFn(d[0], d[1]) : null;
      const errorPct = isNum(measured) ? (100 * (measured - c.expectedFt)) / c.expectedFt : null;
      refResults.push({ refId: c.refId, label: c.label, expectedFt: c.expectedFt, measuredFt: isNum(measured) ? measured : null, errorPct });
      if (isNum(measured) && measured > 0) ratios.push(measured / c.expectedFt);
    }
    const spread = ratios.length >= 2 ? (Math.max.apply(null, ratios) / Math.min.apply(null, ratios) - 1) * 100 : null;
    return { refResults, spread };
  }

  // ================================================================ plane solutions
  function baseSolution(plane, kind) {
    return {
      ok: false, planeId: plane && plane.id != null ? plane.id : null, kind, mode: 'uncalibrated',
      Himg2plane: null, Hplane2img: null,
      scale: { sx: null, sy: null, anisotropic: false },
      refResults: [], disagreementPct: null, checks: 0,
      viewAngleDeg: null, pose: null, K: null, pitch: null, extent: null, gridExtent: null,
      calib: { scaleFrom: null, onlyMediumLowRefs: false, minCourses: null },
      warnings: [], notes: [], issues: [], reason: null,
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

  /** Solve a wall plane (rect-known / rect-refs / refs-only). K may be null when the photo is missing. */
  function solveWall(plane, image, K, config) {
    const sol = baseSolution(plane, 'wall');
    const name = quoted(plane.name, 'this wall');
    if (!image) return failSolution(sol, 'The photo for ' + name + ' is missing, so it cannot be measured.', 'missing-image');
    const Kok = !!(K && K.ok !== false && K.f > 0);
    sol.K = Kok ? { f: K.f, cx: K.cx, cy: K.cy, source: K.source, label: K.label, relStd: K.relStd } : null;

    // ---- perspective rectangle
    let quad = null, rectW = null, rectH = null;
    if (isObj(plane.rect) && plane.rect.corners != null) {
      const c = cleanPts(plane.rect.corners);
      if (!c || c.length !== 4) {
        addIssue(sol, 'rect-incomplete', 'The rectangle on ' + name + ' needs 4 corners. It is ignored until all 4 are placed.');
      } else {
        const q = g.orderQuad(c);
        if (!g.isConvexQuad(q)) {
          addIssue(sol, 'rect-not-convex', 'The rectangle corners on ' + name + ' cross over or bend inward. Re-tap the 4 corners.');
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
    const usedForScale = mode === 'rect-known' ? [] : constraints;
    if (mode !== 'rect-known') {
      const items = [];
      for (const c of constraints) {
        const d = constraintVector(c, H0);
        const len = d ? Math.hypot(d[0], d[1]) : 0;
        if (len > 1e-12) items.push({ c, du: d[0], dv: d[1], len });
      }
      if (!items.length) {
        return failSolution(sol, 'Add a reference length on ' + name + ' (for example the front door height) so the app knows the scale.', 'needs-reference');
      }
      // Isotropic weighted mean: s = Σ wᵢ(Lᵢ/|dᵢ|) / Σ wᵢ with wᵢ = |dᵢ|·q  ⇒  s = Σ qLᵢ / Σ q|dᵢ|.
      let num = 0, den = 0;
      for (const it of items) { num += it.c.q * it.c.expectedFt; den += it.c.q * it.len; }
      sx = sy = num / den;
      // Anisotropic fit when references exist in both directions: Lᵢ² = sx²·duᵢ² + sy²·dvᵢ².
      // Each equation is divided by Lᵢ² so every reference counts by its relative error.
      const horiz = items.some((it) => Math.abs(it.du) > 2 * Math.abs(it.dv));
      const vert = items.some((it) => Math.abs(it.dv) > 2 * Math.abs(it.du));
      if (mode === 'rect-refs' && items.length >= 2 && horiz && vert) {
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
          sx = Math.sqrt(sol2[0]); sy = Math.sqrt(sol2[1]); anisotropic = true;
          const diffPct = Math.abs(sx / sy - 1) * 100;
          if (diffPct > 5) {
            sol.notes.push('Horizontal and vertical references disagree on scale by ' + diffPct.toFixed(1) +
              '%, so each direction was scaled separately. This usually means the camera setting is off.');
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
    const ev = evaluateConstraints(constraints, Himg2plane, Math.hypot, mode === 'rect-known');
    sol.refResults = ev.refResults;
    const used = ev.refResults.filter((r) => isNum(r.measuredFt)).length;
    sol.checks = Math.max(0, mode === 'rect-known' ? used : used - (anisotropic ? 2 : 1));
    sol.disagreementPct = sol.checks >= 1 ? ev.spread : null;
    const warnPct = isNum(config && config.refDisagreementWarnPct) ? config.refDisagreementWarnPct : 5;
    if (isNum(sol.disagreementPct) && sol.disagreementPct > warnPct) {
      addIssue(sol, 'ref-disagreement', 'References on ' + name + ' disagree by ' + sol.disagreementPct.toFixed(1) +
        '%. Check that each one sits on this wall and that its size is right.');
    }
    sol.calib = {
      scaleFrom: mode === 'rect-known' ? 'rect' : 'refs',
      onlyMediumLowRefs: usedForScale.length > 0 && usedForScale.every((c) => c.q < 1),
      minCourses: usedForScale.reduce((m, c) => (c.courses && (m == null || c.courses < m) ? c.courses : m), null),
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
          if (cons && (Math.abs(cons.normRatio - 1) > 0.1 || Math.abs(cons.cosAngle) > 0.1)) {
            addIssue(sol, 'pose-inconsistent', 'The rectangle on ' + name + " doesn't quite match the camera setting, so roof and ground lengths worked out from it may be off.", 'info');
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

  /** Solve a roof or ground plane from its parent wall solution. */
  function solveDerived(plane, kind, wallSols, settings, estimated) {
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
    if (kind === 'roof') sol.pitch = resolvePitch(d.pitch, settings && settings.roofPitch, estimated);

    const line = cleanPts(d.line);
    if (!line || line.length < 2) return failSolution(sol, name + ' needs ' + what + ' with 2 points.', 'derived-no-line');
    let A = g.applyH(parent.Himg2plane, line[0]);
    let B = g.applyH(parent.Himg2plane, line[line.length - 1]);
    if (!A || !B) return failSolution(sol, 'The line for ' + name + ' could not be placed on ' + parentName + '.', 'derived-bad-line');
    if (B[0] < A[0]) { const t = A; A = B; B = t; } // keep plane coordinate a increasing to the right
    const du = B[0] - A[0], dv = B[1] - A[1];
    if (Math.abs(du) < 0.25) return failSolution(sol, 'The line for ' + name + ' is too short or not level. Draw it along the ' + (kind === 'roof' ? 'eave' : 'bottom of the wall') + '.', 'derived-bad-line');
    if (Math.abs(dv) > 0.2 * Math.abs(du)) {
      sol.notes.push('The line for ' + name + ' is not level on the wall; it was treated as level.');
    }

    // Inherit calibration quality from the parent wall.
    sol.K = parent.K;
    sol.viewAngleDeg = parent.viewAngleDeg;
    sol.calib = Object.assign({}, parent.calib, { scaleFrom: 'parent' });
    const vMid = (A[1] + B[1]) / 2; // the plane sits at the mean height of the tapped line
    const len = Math.abs(du);

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

    // Own references are pure checks; the wall's checks carry over.
    const own = [];
    for (const ref of arr(plane.refs)) {
      const rc = refConstraints(ref);
      if (rc.problem) addIssue(sol, 'ref-invalid', rc.problem);
      else for (const c of rc.constraints) own.push(c);
    }
    const ev = evaluateConstraints(own, sol.Himg2plane, segLengthFn(sol), true);
    sol.refResults = ev.refResults;
    const ownChecks = ev.refResults.filter((r) => isNum(r.measuredFt)).length;
    sol.checks = (parent.checks || 0) + ownChecks;
    const spreads = [parent.disagreementPct, ownChecks ? ev.spread : null].filter(isNum);
    sol.disagreementPct = spreads.length ? Math.max.apply(null, spreads) : null;
    if (ownChecks && isNum(ev.spread) && ev.spread > 5) {
      addIssue(sol, 'ref-disagreement', 'References on ' + name + ' disagree by ' + ev.spread.toFixed(1) + '%. Check the roof pitch and that each reference sits on this surface.');
    }
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
    return { rise: g.clamp(Math.round(medRise), 2, 18), run: 12, angleDeg: pitchAngleDeg(medRise, 12), samples };
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

  /**
   * Solve every plane of a project. Walls first, then the pitch estimate, then roof and ground planes.
   * Never throws: a plane that cannot be solved gets ok:false and a reason.
   */
  function solvePlanes(project, config) {
    const proj = isObj(project) ? project : {};
    const cfg = isObj(config) ? config : catalog.getLibrary(proj).config;
    const settings = isObj(proj.settings) ? proj.settings : {};
    const images = arr(proj.images).filter(isObj);
    const planes = arr(proj.planes).filter(isObj);

    const cameras = {};
    for (const img of images) {
      if (img.id == null) continue;
      let K;
      try { K = camera.resolveCamera(img, planes); } catch (e) { K = null; }
      cameras[img.id] = K || { ok: false, f: null, cx: null, cy: null, source: 'default', label: 'Camera unknown', relStd: null };
    }
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
      out[plane.id] = named(sol, plane);
    }

    const estimated = estimatePitch(proj, out);
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
        try { sol = solveDerived(plane, kind, out, settings, estimated); } catch (e) {
          sol = failSolution(baseSolution(plane, kind), 'This plane could not be measured because its data is damaged.', 'plane-error');
        }
      }
      out[plane.id] = named(sol, plane);
    }
    return { cameras, planes: out, pitch };
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
   * object (mode 'billboard') or null.
   */
  function billboardFor(basePx, groundSol) {
    if (!groundSol || groundSol.mode !== 'ground-3d' || !groundSol.frame || !groundSol.pose || !groundSol.K) return null;
    const ab = g.applyH(groundSol.Himg2plane, basePx);
    if (!ab) return null;
    const fr = groundSol.frame;
    const X = g.v3add(fr.origin, g.v3add(g.v3scale(fr.e1, ab[0]), g.v3scale(fr.e2, ab[1])));
    const frame = { origin: X, e1: [1, 0, 0], e2: [0, 1, 0], n: [0, 0, 1] };
    const Hp2i = camera.homographyForFrame(frame, groundSol.K, groundSol.pose);
    const Hi2p = Hp2i ? g.invertH(Hp2i) : null;
    return Hi2p ? { ok: true, mode: 'billboard', Himg2plane: Hi2p, Hplane2img: Hp2i } : null;
  }

  function spiralWrapFt(heightFt, diameterIn, spacingIn) {
    // turns = H_in / s ; one turn is the hypotenuse of the circumference π·D and the rise s.
    const turns = (heightFt * 12) / spacingIn;
    return (turns * Math.hypot(Math.PI * diameterIn, spacingIn)) / 12;
  }

  const METHOD_BY_MODE = { 'rect-known': 'plane', 'rect-refs': 'plane', 'refs-only': 'plane', 'roof-3d': 'roof-3d', 'roof-ortho': 'roof-ortho', 'ground-3d': 'ground-3d' };

  /**
   * Measure one feature on its plane solution. ctx: {config, wastePct | settings.wastePct}.
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
      overridden: false, confidence: null, reason: null, pixelLength: null, segmentsFt: null,
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
    const canMeasure = !geomProblem && !!sol;
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
        let bb = null;
        if (sol.mode === 'ground-3d') {
          const base = pts.reduce((lo, p) => (p[1] > lo[1] ? p : lo), pts[0]); // lowest point on screen touches the ground
          bb = billboardFor(base, sol);
        }
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
    if (fullOverride) { out.confidence = scoreConfidence({ overridden: true, thresholds }); return out; }

    // ---- confidence
    let extrapolation = false;
    if (sol && sol.extent && mp && mp.planePoints) {
      const e = sol.extent, fb = g.bbox(mp.planePoints);
      const rw = e.maxU - e.minU, rh = e.maxV - e.minV;
      const outU = Math.max(e.minU - fb.minX, fb.maxX - e.maxU);
      const outV = Math.max(e.minV - fb.minY, fb.maxY - e.maxV);
      extrapolation = outU > 1.5 * rw || outV > 1.5 * rh;
    }
    const offPlaneOnWall = !!(sol && sol.kind === 'wall' && type.offPlane);
    out.confidence = scoreConfidence({
      mode: effMode,
      checks: sol ? sol.checks : 0,
      disagreementPct: sol ? sol.disagreementPct : null,
      onlyMediumLowRefs: !!(sol && sol.calib && sol.calib.onlyMediumLowRefs),
      minCourses: sol && sol.calib ? sol.calib.minCourses : null,
      viewAngleDeg: sol ? sol.viewAngleDeg : null,
      focalSource: sol && sol.K ? sol.K.source : null,
      pitchSource: sol && sol.kind === 'roof' && sol.pitch ? sol.pitch.source : null,
      offPlane: offPlaneOnWall ? type.id : null,
      extrapolation,
      pixelLength: out.pixelLength,
      extraReasons,
      thresholds,
    });
    return out;
  }

  /**
   * Confidence score: start at 100 and subtract (SPEC §5.5). Every deduction adds a plain-language reason.
   * factors: {overridden, mode, checks, disagreementPct, onlyMediumLowRefs, minCourses, viewAngleDeg,
   *           focalSource, pitchSource, offPlane (type id or bool), extrapolation, pixelLength,
   *           extraReasons, thresholds: {highMin, mediumMin}, reason}
   */
  function scoreConfidence(factors) {
    const fx = isObj(factors) ? factors : {};
    const th = isObj(fx.thresholds) ? fx.thresholds : catalog.DEFAULT_CONFIG.confidence;
    const levelOf = (s) => (s >= th.highMin ? 'high' : s >= th.mediumMin ? 'medium' : 'low');
    if (fx.overridden) return { level: 'high', score: 100, reasons: ['Tape-measured'] };
    const mode = fx.mode;
    if (!Object.prototype.hasOwnProperty.call(MODE_PENALTY, mode)) {
      return { level: 'low', score: 0, reasons: [fx.reason || 'Not measured yet: this plane has no scale.'] };
    }
    let score = 100;
    const reasons = [];
    const take = (pts, why) => { score -= pts; reasons.push(why); };
    if (MODE_PENALTY[mode]) take(MODE_PENALTY[mode], MODE_REASON[mode]);
    if (!(fx.checks >= 1)) take(5, 'There is no second reference to cross-check the scale.');
    const d = fx.disagreementPct;
    if (isNum(d)) {
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
    if (fx.focalSource === 'default' && (mode === 'rect-refs' || mode === 'roof-3d' || mode === 'ground-3d')) {
      take(10, 'The camera focal length is assumed (phone main camera). Choose the camera that took the photo.');
    }
    if (fx.pitchSource === 'estimated') take(10, 'The roof pitch is estimated from the gable.');
    else if (fx.pitchSource === 'default') take(25, 'The roof pitch is unknown, so 6/12 is assumed. Enter the pitch.');
    if (fx.offPlane) {
      take(15, fx.offPlane === 'ridge'
        ? 'The ridge sits above and behind the wall, so measuring it on the wall is approximate. Draw it on a roof plane.'
        : 'This item stands in front of the wall, so its size is approximate.');
    }
    if (fx.extrapolation) take(10, 'This item reaches far beyond the measured rectangle, so small errors grow.');
    if (isNum(fx.pixelLength) && fx.pixelLength > 0 && 2 / fx.pixelLength > 0.03) {
      take(10, 'This item is short on screen, so a small tap error is a large share of its length. Zoom in to place points.');
    }
    for (const r of arr(fx.extraReasons)) reasons.push(r);
    score = g.clamp(Math.round(score), 0, 100);
    if (!reasons.length) reasons.push('Measured on a known-size rectangle and cross-checked.');
    return { level: levelOf(score), score, reasons };
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
    const solved = solvePlanes(proj, cfg);
    const warnings = [];
    if (!isProject) warnings.push({ level: 'warn', code: 'not-a-project', message: 'There is no project to measure.' });

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

    const features = {};
    const totals = emptyTotals();
    const ctx = { config: cfg, settings, wastePct: isNum(settings.wastePct) ? settings.wastePct : 10 };
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
  /** Homogeneous w of a plane point under Hplane2img (sign tells which side of the camera it is on). */
  function wOf(H, uv) { return H[6] * uv[0] + H[7] * uv[1] + H[8]; }

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
