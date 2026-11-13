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
 *     Best rectangle for scale: when a wall has a known-size rectangle AND known-size rectangle references, each is
 *     a candidate. The wall is solved from the wall's own rectangle unless another candidate cuts the expected
 *     error (tap precision, for a level and a plumb line across the box that holds all candidates) by a quarter
 *     or more AND the wall's own rectangle, measured with that candidate, matches its stated size within tap
 *     noise (z ≤ 2). A candidate that disagrees (set back from the wall, mistyped size) stays a check and is
 *     reported in calib.rectRejected. The others become checks. calib.rectFrom says which one was used. Stored
 *     data is not rewritten.
 *  3. ROOF and GROUND planes are built in 3D from their parent wall's pose: the eave/base line is lifted to
 *     wall coordinates, a sloped (roof) or level (ground) frame is built on it, and its homography is
 *     K·[R·e1, R·e2, R·origin + t]. Without a pose, roofs fall back to an orthographic pitch correction.
 *     STEEP ROOF FACE (mansard): a roof plane with derived.steep === true. Its slope is derived.pitch when measured
 *     (rise over run in any one unit: the tape numbers "up" and "back"; source 'user'), else derived.angleDeg in
 *     degrees from level (a guess, kept inside 20..85; source 'guess'), else 70° (source 'default'). The project
 *     pitch and the gable-rake estimate are never used for it, and rakes that start on its eave line never feed
 *     the house-wide estimate (they are its leaning corners, not gables). A guess or the default caps every length
 *     on the face at Low, as an assumed pitch does.
 *     UPPER ROOF: a roof plane whose parent is a roof plane solved in 3D. Its line (drawn along the top of that
 *     face) is lifted through the parent's frame, and the same roof frame is built on it with the wall's pose.
 *     An unmeasured slope anywhere below it (solution.slopeBelow) caps its lengths at Low. Parents are solved
 *     first whatever the stored order; planes that hang off each other in a circle fail with a reason.
 *  4. Features are measured in their plane's coordinates; confidence is scored from how the plane was solved and
 *     from tap precision: every calibration tap behind the plane and every point of the feature is nudged by
 *     its tap precision (one coordinate at a time, plane solutions re-solved), and the expected error 2σ caps the
 *     level (High needs ≤ 3%, Medium ≤ 6%). Bias the noise model cannot see gets hard caps (refs-only walls,
 *     roof-ortho, assumed focal length or pitch, off-plane items, a single unchecked reference, lens/rectangle
 *     mismatch).
 *     Tap precision (SPEC §8.4) is ±2.5 px of the stored photo unless the project says the taps were coarser: an
 *     optional `tapErr` array beside a point list (rect.corners, ref.points, derived.line, feature.points) holds
 *     the expected error of each tap in stored-image pixels (the UI sets it from the zoom at the moment of the
 *     tap). A plane's calibration taps use max(2.5, largest tapErr on its rectangle, references and eave/base
 *     line); a feature's points use max(2.5, largest of feature.tapErr). A tapErr that is missing, the wrong
 *     length or not all finite numbers carries no information (2.5 px). When coarse taps are what limits a
 *     rating, the reason says "Tapped zoomed out (about ±N px on the photo): zoom in and re-tap …".
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
 *    a typical item on the plane), `confidence` (plane-level rating shown on its pill) and `tapSigmaPx` (the tap
 *    precision used for this plane's own calibration taps: 2.5, or more when its `tapErr` arrays say so).
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
 *  - scoreConfidence() takes three more optional factors for coarse taps: `tapPx` (precision, px, of the coarse
 *    taps that add most to the expected error; only when above 2.5), `tapWhat` (what was tapped: 'rect' | 'ref' |
 *    'refs' | 'eave' | 'base' | 'item', several joined with '+') and `uncertaintyBasePct` (what the expected error
 *    would be at the standard 2.5 px).
 *  - REF_PRESETS also has three two-tap garage door widths: 'garage-width-16', 'garage-width-9', 'garage-width-8'.
 *  - Roof pitch is estimated per roof: rakes on its parent wall whose low end sits on its eave line first, else all
 *    gable rakes (`pitchInfo.onEave` false). measureProject warns 'pitch-spread' when samples differ by > 2/12.
 *  - measureProject also warns 'focal-mismatch' (warn; with imageId and suggestedFocalPx) when an EXIF, preset or
 *    manual focal length disagrees with a rectangle estimate, and 'exif-ignored' (info) for cropped photos.
 *  - Trees, columns and bushes drawn on a GROUND plane (with a pose) are measured on a vertical plane parallel to
 *    the wall through their base point on the ground (true 3D size, method 'ground-3d').
 *  - measureProject() also returns `ok` (false only when the input is not a project object).
 *  - PlaneSolution.calib also has `rectFrom` ('rect' = the wall's own rectangle, a reference id, or null when no
 *    rectangle is in use), `rectLabel` (plain name of that rectangle), `rectAuto` (true when a reference rectangle
 *    was chosen over the wall's own), `rectWhy` ('largest' | 'steadiest' | null) and `rectCandidates`
 *    ([{from, label, expectedPct, areaPx, used}] or null when there was nothing to choose; expectedPct is a
 *    comparison figure, not an accuracy) and `rectRejected` ({from, label, pct} when a steadier reference
 *    rectangle was left as a check because it disagrees with the wall's own, else null) and `rectCheckPct` (how
 *    far the wall's own rectangle is from its stated size when another one sets the scale; 3% or more caps the
 *    level at Medium, 6% or more at Low). When the wall's own
 *    rectangle is only a check, its two refResults have refId null and `fromRect: true`.
 *  - Roof PlaneSolutions also have `steep` (true on a steep face), `pitch.angleDeg` / `pitch.steep` /
 *    `pitch.clamped` on steep faces, pitch.source 'guess' (besides 'user' | 'estimated' | 'default') and
 *    `slopeBelow` ('default' | 'guess' | 'estimated' | 'house' | null: an unmeasured slope under an upper roof).
 *    An upper roof with no pitch of its own uses the project pitch as an assumption: pitch.source 'house',
 *    capped at Low (the top of a mansard is usually flatter than the house pitch).
 *    Issue codes: 'steep-angle-assumed', 'steep-angle-guess' (info), 'derived-parent-no-3d'.
 *  - FeatureMeasurement also has `wrongSurface`: 'roof' (a ridge drawn on a wall), 'ground' (a tree or column
 *    drawn on a wall) or null. misplacedFeatures(project, measured?) lists those items with the surfaces they
 *    could move to. steepFromTape({upFt, backFt, slopeFt}) turns two tape numbers into a steep face's pitch.
 *    STEEP = {defaultDeg: 70, minDeg: 20, maxDeg: 85}.
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
    // Two taps across a garage door: the widest thing of known size on most fronts (SPEC §8.4).
    { id: 'garage-width-16', label: 'Garage door width (16 ft)', kind: 'line', lengthIn: 192, quality: 'high' },
    { id: 'garage-width-9', label: 'Garage door width (9 ft)', kind: 'line', lengthIn: 108, quality: 'high' },
    { id: 'garage-width-8', label: 'Garage door width (8 ft)', kind: 'line', lengthIn: 96, quality: 'high' },
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
  // Steep roof faces (mansard): the slope is an angle from level. A guess is kept inside 20..85 degrees; a face
  // steeper than 85 degrees is a wall for every practical purpose and its 3D frame gets ill-conditioned.
  const STEEP = { defaultDeg: 70, minDeg: 20, maxDeg: 85 };
  // Best rectangle for scale: another known-size rectangle replaces the wall's own only when it cuts the expected
  // error by at least a quarter (see chooseScaleRect).
  const RECT_SWITCH_RATIO = 0.75;
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

  /**
   * Relative 1σ of a constraint's measured length from tap noise (two ends; a rect side is the mean of two).
   * tapSigma: the plane's tap precision in px.
   */
  function constraintSigma(c, tapSigma) {
    const px = constraintPx(c);
    if (!(px > 0)) return Infinity;
    return c.kind === 'line' ? (tapSigma * Math.SQRT2) / px : tapSigma / px;
  }

  /**
   * Measure constraints with the final map. Returns refResults, the ratio spread (max/min − 1, %) and z: the
   * largest pairwise disagreement divided by what tap noise alone would explain (|ln(rᵢ/rⱼ)| / hypot(σᵢ, σⱼ)).
   * unitSigma (number) adds the plane's own size as a ratio-1 constraint with that relative σ (rect-known).
   * tapSigma: the plane's tap precision in px.
   */
  function evaluateConstraints(constraints, H, lenFn, unitSigma, tapSigma) {
    const refResults = [];
    const items = isNum(unitSigma) ? [{ r: 1, s: unitSigma }] : [];
    for (const c of constraints) {
      const d = constraintVector(c, H);
      const measured = d ? lenFn(d[0], d[1]) : null;
      const errorPct = isNum(measured) ? (100 * (measured - c.expectedFt)) / c.expectedFt : null;
      const rr = { refId: c.refId, label: c.label, expectedFt: c.expectedFt, measuredFt: isNum(measured) ? measured : null, errorPct };
      if (c.fromRect) rr.fromRect = true; // the wall's own rectangle, used as a check (another one sets the scale)
      refResults.push(rr);
      if (isNum(measured) && measured > 0) items.push({ r: measured / c.expectedFt, s: constraintSigma(c, tapSigma) });
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
  // pixels) unless a `tapErr` array says the taps were coarser (see planeTapSigma / featureTapSigma). Expected errors
  // are 2σ, so "High" (±3%) needs 2σ ≤ 3% and "Medium" (±6%) needs 2σ ≤ 6%.
  const SIGMA_TAP_PX = 2.5;
  const U_HIGH_PCT = 3;
  const U_MEDIUM_PCT = 6;
  // Relative 1σ of the focal length by source. EXIF is trusted; presets are typical lenses; a hand-entered pixel focal
  // length cannot be checked and is usually typed from a guess, so it counts as loose as the default.
  const FOCAL_REL_SIGMA = { exif: 0.03, preset: 0.12, manual: 0.25, default: 0.25 };
  const POSE_TOL_MIN_PCT = 3;

  /**
   * Largest value of a `tapErr` array (SPEC §8.4: expected error of each tap, stored-image px, index for index with
   * `points`). 0 when it carries no information: missing, not an array, not one finite number per point.
   */
  function tapErrMax(tapErr, points) {
    if (!Array.isArray(tapErr) || !Array.isArray(points) || !tapErr.length || tapErr.length !== points.length) return 0;
    let m = 0;
    for (const v of tapErr) {
      if (!isNum(v)) return 0;
      if (v > m) m = v;
    }
    return m;
  }

  /**
   * Tap precision of a plane's calibration taps: {sigma, what}. sigma (1σ, px) is the coarsest of its rectangle,
   * references and eave/base line, never below 2.5. what names the coarse lists for the reason text (null when
   * sigma is 2.5): 'rect' (rectangle corners, also a rectangle reference), 'ref' / 'refs' (one / several reference
   * lengths), 'eave' or 'base' (the line of a roof or ground plane), joined with '+' when more than one was tapped
   * about that coarsely (at least half of sigma).
   */
  function planeTapInfo(plane) {
    if (!isObj(plane)) return { sigma: SIGMA_TAP_PX, what: null };
    let rect = isObj(plane.rect) ? tapErrMax(plane.rect.tapErr, plane.rect.corners) : 0;
    const refs = [];
    for (const r of arr(plane.refs)) {
      if (!isObj(r)) continue;
      const m = tapErrMax(r.tapErr, r.points);
      if (r.kind === 'rect') rect = Math.max(rect, m); else refs.push(m);
    }
    const line = isObj(plane.derived) ? tapErrMax(plane.derived.tapErr, plane.derived.line) : 0;
    const sigma = Math.max(SIGMA_TAP_PX, rect, line, refs.reduce((m, v) => Math.max(m, v), 0));
    if (!(sigma > SIGMA_TAP_PX)) return { sigma, what: null };
    const coarse = (v) => v > SIGMA_TAP_PX && v >= sigma / 2;
    const parts = [];
    if (coarse(line)) parts.push(plane.kind === 'ground' ? 'base' : 'eave');
    if (coarse(rect)) parts.push('rect');
    const n = refs.filter(coarse).length;
    if (n) parts.push(n > 1 ? 'refs' : 'ref');
    return { sigma, what: parts.join('+') };
  }

  /**
   * Was the precision of every calibration tap of this plane recorded (a valid tapErr beside its rectangle, each
   * reference and its eave or base line)? Only then does "2.5 px" mean "tapped zoomed in" and not "unknown".
   */
  function planeTapsRecorded(plane) {
    if (!isObj(plane)) return false;
    let lists = 0;
    if (isObj(plane.rect)) { if (!(tapErrMax(plane.rect.tapErr, plane.rect.corners) > 0)) return false; lists += 1; }
    for (const r of arr(plane.refs)) {
      if (!isObj(r)) continue;
      if (!(tapErrMax(r.tapErr, r.points) > 0)) return false;
      lists += 1;
    }
    if (isObj(plane.derived) && Array.isArray(plane.derived.line)) { if (!(tapErrMax(plane.derived.tapErr, plane.derived.line) > 0)) return false; lists += 1; }
    return lists > 0;
  }

  /** Tap precision (1σ, px) of a plane's calibration taps (SPEC §8.4). */
  function planeTapSigma(plane) { return planeTapInfo(plane).sigma; }

  /** Tap precision (1σ, px) of a feature's own points. */
  function featureTapSigma(feature) {
    return isObj(feature) ? Math.max(SIGMA_TAP_PX, tapErrMax(feature.tapErr, feature.points)) : SIGMA_TAP_PX;
  }

  /** Tap precision (1σ, px) of the rectangle a camera's focal length estimate was measured from. */
  function focalTapSigma(K) {
    const re = K && isObj(K.rectEstimate) ? K.rectEstimate : null;
    return re && isNum(re.tapSigmaPx) && re.tapSigmaPx > SIGMA_TAP_PX ? re.tapSigmaPx : SIGMA_TAP_PX;
  }

  function baseSolution(plane, kind) {
    return {
      ok: false, planeId: plane && plane.id != null ? plane.id : null, kind, mode: 'uncalibrated',
      Himg2plane: null, Hplane2img: null,
      scale: { sx: null, sy: null, anisotropic: false },
      refResults: [], disagreementPct: null, disagreementZ: null, checks: 0,
      viewAngleDeg: null, pose: null, K: null, pitch: null, pitchInfo: null, extent: null, gridExtent: null,
      poseConsistencyPct: null, poseToleranceZ: null, focalMismatchPct: null, tapSigmaPx: planeTapSigma(plane),
      calib: { scaleFrom: null, onlyMediumLowRefs: false, minCourses: null, rectProblem: null, refsBothDirections: false, anisotropic: false,
        rectFrom: null, rectLabel: null, rectAuto: false, rectWhy: null, rectCandidates: null, rectRejected: null, rectCheckPct: null },
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

  /**
   * Relative 1σ of the focal length for its source. A rectangle estimate's relStd is per ±2 px corner nudge;
   * tapSigma is the tap precision (px) of the rectangle it was measured from.
   */
  function focalRelSigma(K, tapSigma) {
    if (!K) return FOCAL_REL_SIGMA.default;
    if (K.source === 'rectangle') return Math.max(0.03, 3.5 * (isNum(K.relStd) ? K.relStd : 0.1) * (tapSigma / 2));
    return FOCAL_REL_SIGMA[K.source] || FOCAL_REL_SIGMA.default;
  }

  /** Relative 1σ of a rectangle's width/height ratio that comes from the focal length's uncertainty. */
  function aspectSigma(quad, K, focalSigma) {
    if (!K) return Infinity;
    const e = 0.05;
    const a = camera.rectAspectFromQuad(quad, K);
    const ap = camera.rectAspectFromQuad(quad, { f: K.f * (1 + e), cx: K.cx, cy: K.cy });
    const am = camera.rectAspectFromQuad(quad, { f: K.f * (1 - e), cx: K.cx, cy: K.cy });
    if (!a || !ap || !am) return Infinity;
    return (Math.abs(ap - am) / (2 * e * a)) * focalRelSigma(K, focalSigma);
  }

  /** Mean on-screen width and height (px) of an ordered quad [TL, TR, BR, BL]. */
  function quadSidesPx(q) {
    return { w: (g.dist(q[0], q[1]) + g.dist(q[3], q[2])) / 2, h: (g.dist(q[0], q[3]) + g.dist(q[1], q[2])) / 2 };
  }

  /** Plain label of a wall's own rectangle: its preset ("Double garage door (16 × 7 ft)") or "Rectangle (W × H)". */
  function rectLabel(rect) {
    const p = isObj(rect) ? WALL_RECT_PRESETS.find((x) => x.id === rect.presetId) : null;
    if (p && p.id !== 'custom-rect' && p.id !== 'unknown') return p.label;
    const w = isObj(rect) ? posNum(rect.widthFt) : null, h = isObj(rect) ? posNum(rect.heightFt) : null;
    return w && h ? 'Rectangle (' + formatLength(w) + ' × ' + formatLength(h) + ')' : 'Rectangle';
  }

  /**
   * Expected error (2σ, %) of a wall solved from each known-size rectangle candidate, for one common test item: a
   * level and a plumb line across the box that holds every candidate (image px). Each corner of the candidate is
   * nudged by ±tapSigma, one coordinate at a time, exactly as the tap-precision estimate does. A small rectangle
   * far from the rest of the wall scores badly, a large one well.
   * candidates: [{quad [TL, TR, BR, BL], w, h}]. Returns one number per candidate (Infinity when a nudge breaks it).
   */
  function scaleRectErrors(candidates, tapSigma) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of candidates) for (const p of c.quad) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    const tests = [[[minX, my], [maxX, my]], [[mx, minY], [mx, maxY]]];
    const lengths = (quad, w, h) => {
      const H = g.homographyFromPoints(quad, [[0, h], [w, h], [w, 0], [0, 0]]);
      if (!H) return null;
      const out = [];
      for (const t of tests) {
        const a = g.applyH(H, t[0]), b = g.applyH(H, t[1]);
        if (!a || !b) return null;
        out.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      return out;
    };
    return candidates.map((c) => {
      const L = lengths(c.quad, c.w, c.h);
      if (!L || !(L[0] > 0) || !(L[1] > 0)) return Infinity;
      const v = [0, 0];
      for (let k = 0; k < 4; k++) {
        for (const axis of [0, 1]) {
          const mv = (d) => c.quad.map((p, i) => (i === k ? (axis === 0 ? [p[0] + d, p[1]] : [p[0], p[1] + d]) : p));
          const a = lengths(mv(tapSigma), c.w, c.h), b = lengths(mv(-tapSigma), c.w, c.h);
          if (!a || !b) return Infinity;
          for (let i = 0; i < 2; i++) v[i] += ((a[i] - b[i]) / 2) ** 2;
        }
      }
      const pct = 200 * Math.sqrt((v[0] / (L[0] * L[0]) + v[1] / (L[1] * L[1])) / 2);
      return isNum(pct) ? pct : Infinity;
    });
  }

  /**
   * Does the wall's own rectangle agree with a candidate scale rectangle? The own rectangle's width and height
   * are measured with the candidate's map and compared with their stated sizes, against what ±tapSigma taps
   * explain: the candidate's 4 corners are nudged one coordinate at a time (the measurement of a small rectangle
   * far from the candidate moves a lot with them), and the own rectangle's corners add their own tap noise.
   * {ok, z, pct}: z is the root mean square of the two misfits in σ (width and height), ok when z ≤ 2; pct is the
   * larger of the two gaps in percent. A candidate that cannot be solved, or with absurd numbers, is not ok.
   */
  function rectAgreement(cand, own, tapSigma) {
    const bad = { ok: false, z: Infinity, pct: null };
    const cons = [
      { kind: 'width', pts: own.quad, expectedFt: own.w },
      { kind: 'height', pts: own.quad, expectedFt: own.h },
    ];
    const logs = (quad) => {
      const H = g.homographyFromPoints(quad, [[0, cand.h], [cand.w, cand.h], [cand.w, 0], [0, 0]]);
      if (!H) return null;
      const out = [];
      for (const c of cons) {
        const d = constraintVector(c, H);
        const m = d ? Math.hypot(d[0], d[1]) : 0;
        if (!(m > 0) || !isNum(m)) return null;
        out.push(Math.log(m / c.expectedFt));
      }
      return out;
    };
    const base = logs(cand.quad);
    if (!base) return bad;
    const v = cons.map((c) => constraintSigma(c, tapSigma) ** 2);
    for (let k = 0; k < 4; k++) {
      for (const axis of [0, 1]) {
        const mv = (dd) => cand.quad.map((p, i) => (i === k ? (axis === 0 ? [p[0] + dd, p[1]] : [p[0], p[1] + dd]) : p));
        const hi = logs(mv(tapSigma)), lo = logs(mv(-tapSigma));
        if (!hi || !lo) return bad;
        for (let i = 0; i < 2; i++) v[i] += ((hi[i] - lo[i]) / 2) ** 2;
      }
    }
    if (!(v[0] > 0) || !(v[1] > 0) || !isFinite(v[0]) || !isFinite(v[1])) return bad;
    const z = Math.sqrt((base[0] * base[0] / v[0] + base[1] * base[1] / v[1]) / 2);
    const pct = 100 * Math.max(Math.abs(Math.exp(base[0]) - 1), Math.abs(Math.exp(base[1]) - 1));
    return { ok: isNum(z) && z <= 2, z: isNum(z) ? z : Infinity, pct: isNum(pct) ? pct : null };
  }

  /**
   * Solve a wall plane (rect-known / rect-refs / refs-only). K may be null when the photo is missing.
   * pin (optional) {rectFrom}: use this rectangle for scale ('rect' or a reference id) instead of choosing; nudged
   * re-solves pass the choice of the real solve so that a nudge can never flip it.
   */
  function solveWall(plane, image, K, config, pin) {
    const sol = baseSolution(plane, 'wall');
    const name = quoted(plane.name, 'this wall');
    if (!image) return failSolution(sol, 'The photo for ' + name + ' is missing, so it cannot be measured.', 'missing-image');
    const Kok = !!(K && K.ok !== false && K.f > 0);
    sol.K = Kok ? { f: K.f, cx: K.cx, cy: K.cy, source: K.source, label: K.label, relStd: K.relStd } : null;
    const tapSigma = sol.tapSigmaPx; // this wall's own taps
    const focalSigma = focalTapSigma(K); // the taps of the rectangle the focal length was measured from
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
    // Best rectangle for scale. The wall's own rectangle and every known-size rectangle reference are candidates.
    // The wall's own stays unless another one cuts the expected error by a quarter or more AND the two agree: the
    // wall's own rectangle, measured with the other one, must match its stated size within what tap noise explains
    // (z ≤ 2). A larger rectangle that sits on another surface (a garage on a set-back wing) or has a mistyped
    // size fails that test, stays a check, and the note says why it was not used. Away from the 0.75 boundary a
    // small nudge does not flip the choice; right at it a 1 px nudge can (a hard threshold; see SPEC §8.6). A
    // reference whose id is the sentinel 'rect' cannot be told from the wall's own rectangle, so it never competes.
    let rectFrom = null, rectAuto = false, rectWhy = null, rectCandidates = null, ownRectLabel = null, rectRejected = null, rectCheckPct = null;
    if (quad && rectW && rectH) {
      rectFrom = 'rect';
      ownRectLabel = rectLabel(plane.rect);
      const others = rectRefs.filter((r) => r.ref.id != null && r.ref.id !== 'rect');
      if (others.length) {
        const cands = [{ from: 'rect', label: ownRectLabel, quad, w: rectW, h: rectH, rr: null }]
          .concat(others.map((r) => ({ from: r.ref.id, label: refLabel(r.ref), quad: r.quad, w: r.w, h: r.h, rr: r })));
        const own = cands[0];
        const pinFrom = isObj(pin) && pin.rectFrom != null ? pin.rectFrom : null;
        let best = own;
        if (pinFrom != null) {
          // A nudged re-solve: the choice of the real solve is kept, so the candidate table is not needed.
          best = cands.find((c) => c.from === pinFrom) || own;
          cands.forEach((c) => { c.expectedPct = Infinity; c.areaPx = g.polygonArea(c.quad); });
        } else {
          const errs = scaleRectErrors(cands, tapSigma);
          cands.forEach((c, i) => { c.expectedPct = errs[i]; c.areaPx = g.polygonArea(c.quad); });
          const better = cands.slice(1).filter((c) => c.expectedPct <= RECT_SWITCH_RATIO * own.expectedPct).sort((a, b) => a.expectedPct - b.expectedPct);
          for (const c of better) {
            const fit = rectAgreement(c, own, tapSigma);
            if (fit.ok) { best = c; rectCheckPct = fit.pct; break; }
            if (!rectRejected) rectRejected = { from: c.from, label: c.label, pct: fit.pct };
          }
          if (best !== own) rectRejected = null;
        }
        rectCandidates = cands.map((c) => ({ from: c.from, label: c.label, expectedPct: c.expectedPct === Infinity ? null : c.expectedPct, areaPx: c.areaPx, used: c === best }));
        if (best !== own) {
          constraints = constraints.filter((c) => best.rr.constraints.indexOf(c) < 0);
          constraints.push({ refId: null, label: own.label + ', width', kind: 'width', pts: own.quad, expectedFt: own.w, q: 1, quality: 'high', courses: null, fromRect: true });
          constraints.push({ refId: null, label: own.label + ', height', kind: 'height', pts: own.quad, expectedFt: own.h, q: 1, quality: 'high', courses: null, fromRect: true });
          quad = best.quad; rectW = best.w; rectH = best.h;
          rectFrom = best.from; rectAuto = true;
          rectWhy = cands.every((c) => c === best || c.areaPx < best.areaPx) ? 'largest' : 'steadiest';
          sol.promotedRefId = best.from;
          sol.notes.push("Scale taken from '" + best.label + "' (the " + (rectWhy === 'largest' ? 'largest measured rectangle' : 'measured rectangle that gives the steadiest scale') +
            "). '" + own.label + "' is used as a check.");
        } else if (rectRejected) {
          sol.notes.push("'" + rectRejected.label + "' would give a steadier scale, but it does not agree with '" + own.label + "'" +
            (isNum(rectRejected.pct) ? ' (they are ' + rectRejected.pct.toFixed(1) + '% apart)' : '') +
            ', so it is only used as a check. Make sure it sits on this wall and that its size is right.');
        }
      }
    } else if (quad) rectFrom = 'rect';
    // No plane rectangle: promote the largest known-size reference rectangle to plane rectangle.
    if (!quad && rectRefs.length) {
      const best = rectRefs.slice().sort((a, b) => g.polygonArea(b.quad) - g.polygonArea(a.quad))[0];
      quad = best.quad; rectW = best.w; rectH = best.h;
      constraints = constraints.filter((c) => best.constraints.indexOf(c) < 0);
      sol.notes.push("The reference '" + refLabel(best.ref) + "' is used as this wall's perspective rectangle.");
      sol.calib.rectProblem = null; // a usable rectangle after all
      sol.promotedRefId = best.ref.id != null ? best.ref.id : null;
      rectFrom = sol.promotedRefId;
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
          const sigRefs = tapSigma * Math.SQRT2 * Math.sqrt(1 / sumSq(hItems) + 1 / sumSq(vItems));
          const sigK = aspectSigma(quad, sol.K, focalSigma);
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
    const unitSigma = mode === 'rect-known' && sides ? tapSigma / Math.max(1e-9, Math.min(sides.w, sides.h)) : null;
    const ev = evaluateConstraints(constraints, Himg2plane, Math.hypot, unitSigma, tapSigma);
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
      // Which rectangle gives the perspective and, when its size is known, the scale: 'rect' (the wall's own), a
      // reference id, or null (no rectangle in use). rectAuto: chosen over the wall's own rectangle.
      rectFrom: mode === 'refs-only' ? null : rectFrom,
      rectLabel: mode === 'refs-only' || rectFrom == null ? null
        : rectFrom === 'rect' ? (ownRectLabel || rectLabel(plane.rect)) : refLabel(arr(plane.refs).find((r) => isObj(r) && r.id === rectFrom) || {}),
      rectAuto: mode !== 'refs-only' && rectAuto,
      rectWhy: mode !== 'refs-only' ? rectWhy : null,
      rectCandidates,
      // A reference rectangle that would have given a steadier scale but disagrees with the wall's own rectangle:
      // {from, label, pct} or null.
      rectRejected: mode !== 'refs-only' ? rectRejected : null,
      // How far the wall's own rectangle is from its stated size when measured with the chosen one (%, rectAuto only).
      rectCheckPct: mode !== 'refs-only' && rectAuto ? rectCheckPct : null,
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
            const tapPct = sides ? 100 * tapSigma * Math.SQRT2 * Math.hypot(1 / sides.w, 1 / sides.h) : 0;
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

  /** Is this a steep roof face (mansard)? Roof planes with derived.steep === true. */
  function isSteepPlane(plane) {
    return isObj(plane) && plane.kind === 'roof' && isObj(plane.derived) && plane.derived.steep === true;
  }

  /**
   * Slope of a steep roof face: {rise, run, source, angleDeg, steep: true}.
   *   derived.pitch (rise over run, any units: the two tape numbers "up" and "back")  → source 'user'
   *   derived.angleDeg (degrees from level, kept inside 20..85)                         → source 'guess'
   *   neither                                                                           → 70°, source 'default'
   * The project pitch and the gable-rake estimate are never used: they describe ordinary roofs.
   */
  function resolveSteepPitch(derived) {
    const d = isObj(derived) ? derived : {};
    const fromAngle = (deg, source) => ({ rise: 12 * Math.tan((deg * Math.PI) / 180), run: 12, source, angleDeg: deg, steep: true });
    if (validPitch(d.pitch) && d.pitch.rise > 0) {
      const ang = pitchAngleDeg(d.pitch.rise, d.pitch.run);
      if (ang > STEEP.maxDeg) return Object.assign(fromAngle(STEEP.maxDeg, 'user'), { clamped: true });
      return { rise: d.pitch.rise, run: d.pitch.run, source: 'user', angleDeg: ang, steep: true };
    }
    if (isNum(d.angleDeg)) return fromAngle(g.clamp(d.angleDeg, STEEP.minDeg, STEEP.maxDeg), 'guess');
    return fromAngle(STEEP.defaultDeg, 'default');
  }

  /**
   * The slope of a steep roof face from two tape numbers (feet, or any one unit): how far the face goes up
   * (upFt, vertical), how far it goes back (backFt, level) and its sloped height (slopeFt). Any two are enough;
   * with all three they must agree within 5%.
   * Returns {ok: true, angleDeg, pitch: {rise, run}, upFt, backFt, slopeFt} (store `pitch` as derived.pitch), or
   * {ok: false, reason}. Angles above 85° are refused (measure such a face as a wall).
   */
  function steepFromTape(input) {
    const o = isObj(input) ? input : {};
    let up = posNum(o.upFt), back = posNum(o.backFt);
    const slope = posNum(o.slopeFt);
    const fail = (reason) => ({ ok: false, reason });
    const given = (up ? 1 : 0) + (back ? 1 : 0) + (slope ? 1 : 0);
    if (given < 2) return fail('Enter two of these: how far the face goes up, how far it goes back, and its sloped height.');
    if (slope && up && slope <= up) return fail('The sloped height must be longer than how far the face goes up.');
    if (slope && back && slope <= back) return fail('The sloped height must be longer than how far the face goes back.');
    if (given === 3 && Math.abs(Math.hypot(up, back) / slope - 1) > 0.05) {
      return fail('These three numbers do not fit together. Check them, or enter only two.');
    }
    if (!up) up = Math.sqrt(slope * slope - back * back);
    if (!back) back = Math.sqrt(slope * slope - up * up);
    const angleDeg = pitchAngleDeg(up, back);
    if (!isNum(angleDeg) || !(up > 0) || !(back > 0)) return fail('These numbers do not give a slope. Check them.');
    if (angleDeg > STEEP.maxDeg) return fail('This face is almost straight up (more than ' + STEEP.maxDeg + '°). Measure it as a wall.');
    return { ok: true, angleDeg, pitch: { rise: up, run: back }, upFt: up, backFt: back, slopeFt: Math.hypot(up, back) };
  }

  // The wall's own 3D frame (camera.js: u right, v up, w toward the camera).
  const WALL_FRAME = { origin: [0, 0, 0], e1: [1, 0, 0], e2: [0, 1, 0], n: [0, 0, 1] };

  /** Eave/base line of a derived plane in its parent plane's coordinates: {A, B, vMid, len} or a failure reason. */
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
    // An upper roof hangs off a roof face (the top of a mansard); everything else hangs off a wall.
    const onRoof = parent.kind === 'roof';
    if (parent.kind !== 'wall' && !(onRoof && kind === 'roof')) return failSolution(sol, name + ' needs ' + what + ' drawn on a wall.', 'derived-no-parent');
    const parentName = quoted(parent.name, onRoof ? 'the roof face below it' : 'its wall');
    if (!parent.ok) return failSolution(sol, 'Measure ' + parentName + ' first: ' + (parent.reason || 'it has no scale yet.'), 'derived-parent-uncalibrated');
    if (onRoof && (parent.mode !== 'roof-3d' || !parent.frame || !parent.pose || !parent.K)) {
      return failSolution(sol, name + ' sits on ' + parentName + ', which is only approximated. Add a perspective rectangle on the wall below so both can be measured.', 'derived-parent-no-3d');
    }
    if (kind === 'roof') {
      sol.pitch = pitch || { rise: DEFAULT_PITCH.rise, run: DEFAULT_PITCH.run, source: 'default' };
      sol.pitchInfo = sol.pitch.source === 'estimated' && pitchInfo ? pitchInfo : null;
      if (sol.pitch.steep) {
        sol.steep = true;
        const deg = Math.round(sol.pitch.angleDeg);
        if (sol.pitch.clamped) sol.notes.push(name + ' is almost straight up. It is measured as an ' + STEEP.maxDeg + '° face.');
        if (sol.pitch.source === 'default') addIssue(sol, 'steep-angle-assumed', 'The slope of ' + name + ' is unknown, so ' + deg + '° is assumed. Measure how far the face goes up and how far it goes back.', 'info');
        else if (sol.pitch.source === 'guess') addIssue(sol, 'steep-angle-guess', 'The slope of ' + name + ' (' + deg + '°) is a guess. Measure how far the face goes up and how far it goes back.', 'info');
      }
      // A slope that is not measured anywhere below this roof moves it too: 'default' | 'guess' | 'estimated' | null.
      if (onRoof) {
        const below = parent.pitch && parent.pitch.source !== 'user' ? parent.pitch.source : (parent.slopeBelow || null);
        sol.slopeBelow = below;
      }
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
      // The line is lifted to 3D through the parent's frame (a wall: [u, v, 0]; a roof face: along and up its slope).
      const pf = onRoof ? parent.frame : WALL_FRAME;
      const lift = (a, b) => g.v3add(pf.origin, g.v3add(g.v3scale(pf.e1, a), g.v3scale(pf.e2, b)));
      const A3 = lift(A[0], vMid), B3 = lift(B[0], vMid);
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
    const ev = evaluateConstraints(own, sol.Himg2plane, lenFn, refit ? null : 0.02, sol.tapSigmaPx);
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
    // Eave lines of steep roof faces, by parent wall: a rake that starts on one is the leaning corner of that
    // face, not a gable, and says nothing about ordinary roofs.
    const steepLines = {};
    for (const pl of arr(project && project.planes)) {
      if (!isSteepPlane(pl)) continue;
      const pid = pl.derived.parentPlaneId;
      const parent = pid != null && Object.prototype.hasOwnProperty.call(sols, pid) ? sols[pid] : null;
      if (!parent || !parent.ok || parent.kind !== 'wall') continue;
      const dl = derivedLine(pl, parent);
      if (!dl.problem) (steepLines[pid] = steepLines[pid] || []).push(dl);
    }
    for (const f of arr(project && project.features)) {
      if (!isObj(f) || f.type !== 'rake') continue;
      const sol = Object.prototype.hasOwnProperty.call(sols, f.planeId) ? sols[f.planeId] : null;
      if (!sol || !sol.ok || sol.kind !== 'wall') continue;
      if (arr(steepLines[f.planeId]).some((dl) => rakeStartsOnLine(f.points, sol, dl))) continue;
      for (const s of rakeSamples(f.points, sol)) samples.push(s);
    }
    if (!samples.length) return null;
    const medRise = g.median(samples);
    return { rise: g.clamp(Math.round(medRise), 2, 18), run: 12, angleDeg: pitchAngleDeg(medRise, 12), samples, spread: Math.max.apply(null, samples) - Math.min.apply(null, samples) };
  }

  const PITCH_EAVE_TOL_FT = 1.5;
  const PITCH_SPREAD_MAX = 2;

  /** Does the low end of a rake (image points) sit on an eave line (derivedLine) of the wall solution `sol`? */
  function rakeStartsOnLine(points, sol, dl) {
    const p = cleanPts(points);
    if (!p || p.length < 2) return false;
    const plane = p.map((q) => g.applyH(sol.Himg2plane, q));
    if (plane.some((q) => !q)) return false;
    const low = plane.reduce((m, q) => (q[1] < m[1] ? q : m), plane[0]);
    return !(Math.abs(low[1] - dl.vMid) > PITCH_EAVE_TOL_FT || low[0] < dl.A[0] - 1 || low[0] > dl.B[0] + 1);
  }

  /**
   * Pitch estimate for one roof plane: rakes on its parent wall whose low end sits on the roof's eave line (within
   * 1.5 ft of its height and inside its span) first; otherwise every gable rake in the project (onEave false).
   * Returns {rise, run, angleDeg, samples, spread, onEave} or null.
   */
  function estimateRoofPitch(project, wallSols, roofPlane, globalEstimate) {
    const d = isObj(roofPlane.derived) ? roofPlane.derived : null;
    const parent = d && Object.prototype.hasOwnProperty.call(wallSols, d.parentPlaneId) ? wallSols[d.parentPlaneId] : null;
    // Only a wall carries gable rakes; an upper roof (on a roof face) borrows the house-wide estimate.
    const dl = parent && parent.ok && parent.kind === 'wall' ? derivedLine(roofPlane, parent) : null;
    const samples = [];
    if (dl && !dl.problem) {
      for (const f of arr(project && project.features)) {
        if (!isObj(f) || f.type !== 'rake' || f.planeId !== d.parentPlaneId) continue;
        if (!rakeStartsOnLine(f.points, parent, dl)) continue;
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
      // How precisely the rectangle behind the focal estimate was tapped (it scales how far that estimate can be off).
      if (K && isObj(K.rectEstimate)) K.rectEstimate.tapSigmaPx = planeTapSigma(planes.find((pl) => pl.id === K.rectEstimate.planeId));
      cameras[img.id] = K || { ok: false, f: null, cx: null, cy: null, source: 'default', label: 'Camera unknown', relStd: null, rectEstimate: null, focalQuad: null, exifIgnored: null };
    }
    return cameras;
  }

  /** {pct, significant, rect} when the chosen focal (EXIF, preset or manual) disagrees with a rectangle estimate. */
  function focalMismatch(K) {
    if (!K || K.ok === false || !K.rectEstimate || !(K.f > 0) || (K.source !== 'exif' && K.source !== 'preset' && K.source !== 'manual')) return null;
    const re = K.rectEstimate;
    const pct = Math.abs(K.f / re.f - 1) * 100;
    // relStd is per ±2 px corner nudge at the standard tap precision; coarser taps explain a larger difference.
    const tol = 100 * Math.max(0.15, 3 * (isNum(re.relStd) ? re.relStd : 0.1) * (focalTapSigma(K) / SIGMA_TAP_PX));
    return { pct, significant: pct > tol, rect: re };
  }

  /**
   * Solve the planes given resolved cameras. pitchOverride (planeId → {pitch, pitchInfo}) pins roof pitches
   * (used when re-solving nudged copies for the uncertainty estimate).
   */
  function solveAll(proj, cfg, cameras, pitchOverride) {
    // pitchOverride also pins each wall's scale rectangle ({rectFrom}); see solveWall.
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
      try { sol = solveWall(plane, image, K && K.ok !== false ? K : null, cfg, pitchOverride ? pitchOverride[plane.id] : null); } catch (e) {
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

    const solveOne = (plane) => {
      const kind = plane.kind;
      let sol;
      if (kind !== 'roof' && kind !== 'ground') {
        sol = failSolution(baseSolution(plane, kind), quoted(plane.name, 'A plane') + ' has an unknown kind and was skipped.', 'plane-unknown-kind');
      } else {
        try {
          let rp = null, info = null;
          if (kind === 'roof') {
            const pin = pitchOverride && pitchOverride[plane.id];
            if (pin) { rp = pin.pitch; info = pin.pitchInfo; } else if (isSteepPlane(plane)) {
              rp = resolveSteepPitch(plane.derived); // never the project pitch, never the gable estimate
            } else {
              const est = estimateRoofPitch(proj, out, plane, estimated);
              const own = isObj(plane.derived) ? plane.derived.pitch : null;
              const pid = isObj(plane.derived) ? plane.derived.parentPlaneId : null;
              const upper = pid != null && Object.prototype.hasOwnProperty.call(out, pid) && out[pid].kind === 'roof';
              if (upper && !validPitch(own) && validPitch(settings.roofPitch)) {
                // An upper roof (the top of a mansard) is usually much flatter than the house pitch, so the
                // project pitch is only an assumption here: source 'house', capped at Low.
                rp = { rise: settings.roofPitch.rise, run: settings.roofPitch.run, source: 'house' };
              } else {
                rp = resolvePitch(own, settings.roofPitch, est);
                info = est ? { onEave: est.onEave, spread: est.spread, samples: est.samples } : null;
              }
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
    };
    // Parents first: planes on a wall in stored order, then roofs drawn on a roof face (an upper roof), and so on.
    let todo = planes.filter((pl) => pl.kind != null && pl.kind !== 'wall');
    while (todo.length) {
      const waiting = (pl) => {
        const pid = isObj(pl.derived) ? pl.derived.parentPlaneId : null;
        return pid != null && pid !== pl.id && todo.some((o) => o !== pl && o.id === pid);
      };
      const ready = todo.filter((pl) => !waiting(pl));
      if (!ready.length) {
        // Planes that hang off each other in a circle.
        for (const pl of todo) {
          out[pl.id] = named(failSolution(baseSolution(pl, pl.kind), quoted(pl.name, 'This roof') + ' is attached to a surface that is attached back to it. Draw its eave line again.', 'derived-no-parent'), pl);
        }
        break;
      }
      for (const pl of ready) solveOne(pl);
      todo = todo.filter((pl) => ready.indexOf(pl) < 0);
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
   * rectangle's corners (the focal length moves with them). σ is the tap precision of the plane the tap belongs
   * to (planeTapInfo). Returns {[planeId]: [{plus, minus, sigma, src}]}; sigma is the nudge used and src says what
   * was tapped coarsely on the plane the tap belongs to (planeTapInfo().what; null at the standard 2.5 px).
   */
  function perturbedSolutions(proj, cfg, cameras, solved, neededPlaneIds) {
    const planes = arr(proj.planes).filter(isObj);
    const byId = {};
    for (const pl of planes) byId[pl.id] = pl;
    // Planes a plane hangs off, nearest first (a roof on a roof face on a wall has two).
    const ancestors = {};
    for (const pl of planes) {
      const list = [];
      let cur = pl;
      while (cur && isObj(cur.derived) && cur.derived.parentPlaneId != null && byId[cur.derived.parentPlaneId]) {
        const up = byId[cur.derived.parentPlaneId];
        if (up === pl || list.indexOf(up.id) >= 0) break;
        list.push(up.id);
        cur = up;
      }
      ancestors[pl.id] = list;
    }
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
    // Pitches stay as solved (pitch uncertainty is rated separately), and so does each wall's scale rectangle.
    const pins = {};
    for (const id of Object.keys(solved.planes)) {
      const s = solved.planes[id];
      if (s.kind === 'roof' && s.pitch) pins[id] = { pitch: s.pitch, pitchInfo: s.pitchInfo };
      else if (s.kind === 'wall' && s.calib && s.calib.rectCandidates) pins[id] = { rectFrom: s.calib.rectFrom };
    }
    const out = {};
    const imageOf = (pl) => (pl ? pl.imageId : null);
    const tapOf = {};
    for (const pl of planes) tapOf[pl.id] = planeTapInfo(pl);
    for (const t of taps) {
      const owner = byId[t.planeId];
      const sigma = tapOf[owner.id].sigma;
      const src = tapOf[owner.id].what;
      // Which planes can this tap move?
      const affected = new Set();
      if (t.focalImage) { for (const pl of planes) if (pl.imageId === t.focalImage || ancestors[pl.id].some((id) => imageOf(byId[id]) === t.focalImage)) affected.add(pl.id); }
      affected.add(owner.id);
      // Everything that hangs off the tapped plane moves with it (a wall's roofs and grounds, a roof face's upper roof).
      if (owner.kind == null || owner.kind === 'wall' || owner.kind === 'roof') for (const pl of planes) if (ancestors[pl.id].indexOf(owner.id) >= 0) affected.add(pl.id);
      if (![...affected].some((id) => neededPlaneIds.has(id))) continue;
      const include = new Set(affected);
      for (const id of affected) for (const up of ancestors[id] || []) include.add(up);
      const pair = {};
      for (const sign of [1, -1]) {
        const moved = nudgedPlane(owner, t.path, t.k, t.axis, sign * sigma);
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
        (out[id] = out[id] || []).push({ plus: pair.plus[id] || null, minus: pair.minus[id] || null, sigma, src });
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
   * Expected error (2σ, % of the size) from tap precision: every calibration tap behind the plane (nudged by its
   * plane's tap precision, see perturbedSolutions) and every point of the feature (nudged by tapSigma, default
   * 2.5 px), one coordinate at a time. Infinity when a nudge breaks the measurement.
   * detail (optional object) is filled in for the reason text when coarse taps (σ above 2.5 px) are involved:
   *   tapPx, tapWhat  precision and kind (planeTapInfo().what, or 'item' for the feature's own points) of the
   *                   coarse taps that add the most to the expected error, or whose nudge broke the measurement;
   *   basePct         what the expected error would be had every tap been good to 2.5 px (each coarse tap's share
   *                   scaled down by (2.5/σ)², which is exact while the measurement responds linearly).
   */
  function featureUncertaintyPct(geometry, pts, closed, sol, perturb, tapSigma, detail) {
    const own = isNum(tapSigma) && tapSigma > SIGMA_TAP_PX ? tapSigma : SIGMA_TAP_PX;
    const L = featureMetric(geometry, pts, closed, sol);
    if (!isNum(L) || !(L > 0)) return null;
    let sum = 0;
    // Bookkeeping for coarse taps only; it never touches `sum`, so results without tapErr are what they always were.
    let extra = 0; // variance added by taps being coarser than 2.5 px
    const bySrc = {}; // src → {extra, sigma}
    const coarse = (sigma, src, v) => {
      if (!(sigma > SIGMA_TAP_PX)) return;
      const e = v * (1 - (SIGMA_TAP_PX / sigma) ** 2);
      extra += e;
      const b = bySrc[src] || (bySrc[src] = { extra: 0, sigma: 0 });
      b.extra += e;
      if (sigma > b.sigma) b.sigma = sigma;
    };
    const broken = (sigma, src) => {
      if (detail && sigma > SIGMA_TAP_PX) { detail.tapPx = sigma; detail.tapWhat = src; detail.basePct = null; }
      return Infinity;
    };
    // Variance share of one tapped coordinate from the size changes da, db that nudging it by +σ and −σ causes.
    // Half the difference is the slope; a coarse nudge is big enough for the measurement to bend (both nudges can
    // move the size the same way, or away from a freak value), so there the larger one-sided change counts.
    const share = (da, db, sigma) => {
      const v = ((da - db) / 2) ** 2;
      return sigma > SIGMA_TAP_PX ? Math.max(v, da * da, db * db) : v;
    };
    for (const pr of arr(perturb)) {
      const a = pr.plus ? featureMetric(geometry, pts, closed, pr.plus) : null;
      const b = pr.minus ? featureMetric(geometry, pts, closed, pr.minus) : null;
      if (!isNum(a) || !isNum(b)) return broken(pr.sigma, pr.src);
      const v = pr.sigma > SIGMA_TAP_PX ? share(a - L, b - L, pr.sigma) : ((a - b) / 2) ** 2;
      sum += v;
      coarse(pr.sigma, pr.src, v);
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
          const qa = g.applyH(H, nudge(k, axis, own)), qb = g.applyH(H, nudge(k, axis, -own));
          if (!qa || !qb) return broken(own, 'item');
          const la = (prev ? seg(prev, qa) : 0) + (next ? seg(qa, next) : 0) - base;
          const lb = (prev ? seg(prev, qb) : 0) + (next ? seg(qb, next) : 0) - base;
          const v = share(la, lb, own);
          sum += v;
          coarse(own, 'item', v);
        }
      }
    } else {
      const idx = geometry === 'vertical' ? [0, pts.length - 1] : pts.map((_, i) => i);
      for (const k of idx) {
        for (const axis of [0, 1]) {
          const mv = (d) => pts.map((p, i) => (i === k ? nudge(k, axis, d) : p));
          const a = featureMetric(geometry, mv(own), closed, sol);
          const b = featureMetric(geometry, mv(-own), closed, sol);
          if (!isNum(a) || !isNum(b)) return broken(own, 'item');
          const v = own > SIGMA_TAP_PX ? share(a - L, b - L, own) : ((a - b) / 2) ** 2;
          sum += v;
          coarse(own, 'item', v);
        }
      }
    }
    if (detail && extra > 0) {
      let top = null;
      for (const src of Object.keys(bySrc)) if (!top || bySrc[src].extra > bySrc[top].extra) top = src;
      detail.tapPx = bySrc[top].sigma;
      detail.tapWhat = top;
      detail.basePct = (200 * Math.sqrt(Math.max(0, sum - extra))) / L;
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
      wrongSurface: null,
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
    // Drawn on a wall, but it belongs on another kind of surface: 'roof' (a ridge) or 'ground' (tree, column).
    if (planeSol && planeSol.kind === 'wall') out.wrongSurface = wantedSurface(type);
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
    const tapDetail = {}; // coarse (zoomed-out) taps behind the expected error, if any
    if (canMeasure && c.perturb && sol && sol.planeId != null) {
      const perturb = c.perturb[sol.planeId] || [];
      out.uncertaintyPct = featureUncertaintyPct(type.geometry, pts, closed, sol, perturb, featureTapSigma(f), tapDetail);
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
      steep: !!(sol && sol.steep), steepAngleDeg: sol && sol.steep && sol.pitch ? sol.pitch.angleDeg : null,
      slopeBelow: sol ? sol.slopeBelow : null,
      rectProblem: sol && sol.calib ? sol.calib.rectProblem : null,
      rectCheckPct: sol && sol.calib ? sol.calib.rectCheckPct : null,
      refsBothDirections: !!(sol && sol.calib && sol.calib.refsBothDirections),
      anisotropic: !!(sol && sol.scale && sol.scale.anisotropic),
      scaleFrom: sol && sol.calib ? sol.calib.scaleFrom : null,
      offPlane: offPlaneOnWall ? type.id : null,
      offPlaneBiasPct,
      assumedDiameterIn,
      extrapolation,
      pixelLength: out.pixelLength,
      uncertaintyPct: out.uncertaintyPct,
      uncertaintyBasePct: tapDetail.basePct,
      tapPx: tapDetail.tapPx,
      tapWhat: tapDetail.tapWhat,
      // The item's own points, when they were tapped zoomed out; and whether every tap behind this number is
      // known to have been placed zoomed in (then "zoom in" is no advice).
      ownTapPx: featureTapSigma(f),
      tapsFine: !!(sol && sol.tapsRecorded) && tapErrMax(f.tapErr, f.points) > 0 && !(tapDetail.tapPx > SIGMA_TAP_PX),
      extraReasons,
      thresholds,
    });
    return out;
  }

  /**
   * The kind of surface an item belongs on when a wall is the wrong place for it: 'roof' (a ridge), 'ground' (a
   * tree or a column) or null. These are the items a wall caps at Low.
   */
  function wantedSurface(type) {
    if (!type) return null;
    if (type.id === 'ridge') return 'roof';
    if (type.id === 'tree' || type.id === 'column') return 'ground'; // a bush sits against the wall and may stay there
    return null;
  }

  /** Is the size of this item typed in from a tape (so where it is drawn no longer matters)? */
  function tapeMeasured(f) { return !!posNum(f.overrideFt); }

  const SURFACE_MESSAGE = {
    roof: 'A ridge sits on the roof, behind the wall. Measured on the wall it comes out too short. Move it to a roof surface, or type a tape-measured length.',
    ground: 'This item stands in front of the wall. Measured on the wall it comes out too large. Move it to a ground surface, or type a tape-measured height.',
  };

  /**
   * Items drawn on the wrong kind of surface, and where they could go. A ridge drawn on a wall belongs on a roof
   * surface; a tree or column drawn on a wall belongs on a ground surface. Items whose size is tape-measured
   * (overrideFt) are left out: that fix is already made.
   * measured (optional): the measureProject result for this project; worked out when missing.
   * Returns [{featureId, type, label, planeId, wants: 'roof' | 'ground', message, lengthFt (as measured now, or
   *   null), candidates: [{planeId, name, kind, steep, parentPlaneId, ok, lengthFt}], canCreate: true}].
   * candidates are the existing surfaces of the wanted kind that hang off that wall (directly, or through a roof
   * face), best first: ones the item can be measured on, ordinary roofs before steep faces. lengthFt is what the
   * item would measure there (null when it cannot be measured there). To apply: set feature.planeId to the
   * candidate's planeId; the points stay as they are. With no candidate, draw an eave line (roof) or a wall base
   * line (ground) on that wall first. Never throws; the project is not changed.
   */
  function misplacedFeatures(project, measured) {
    try {
      const proj = isObj(project) ? project : {};
      const res = isObj(measured) && isObj(measured.planes) && isObj(measured.features) ? measured : measureProject(proj);
      const planes = arr(proj.planes).filter(isObj);
      const byId = {};
      for (const pl of planes) if (pl.id != null) byId[pl.id] = pl;
      const hangsOff = (pl, wallId) => {
        const seen = new Set();
        for (let cur = pl; cur && isObj(cur.derived) && cur.derived.parentPlaneId != null && !seen.has(cur.id);) {
          seen.add(cur.id);
          if (cur.derived.parentPlaneId === wallId) return true;
          cur = byId[cur.derived.parentPlaneId];
        }
        return false;
      };
      const cfg = catalog.getLibrary(proj).config;
      const out = [];
      arr(proj.features).forEach((f, idx) => {
        if (!isObj(f)) return;
        const type = typeof f.type === 'string' && Object.prototype.hasOwnProperty.call(catalog.FEATURE_TYPES, f.type) ? catalog.FEATURE_TYPES[f.type] : null;
        const wants = wantedSurface(type);
        const wall = f.planeId != null ? byId[f.planeId] : null;
        if (!wants || !wall || !(wall.kind == null || wall.kind === 'wall') || tapeMeasured(f)) return;
        const id = f.id != null ? String(f.id) : 'feature_' + idx;
        const now = Object.prototype.hasOwnProperty.call(res.features, id) ? res.features[id] : null;
        const candidates = [];
        for (const pl of planes) {
          if (pl.kind !== wants || !hangsOff(pl, wall.id)) continue;
          const sol = Object.prototype.hasOwnProperty.call(res.planes, pl.id) ? res.planes[pl.id] : null;
          let m = null;
          if (sol && sol.ok) { try { m = measureFeature(Object.assign({}, f, { planeId: pl.id }), sol, { config: cfg }); } catch (e) { m = null; } }
          const ok = !!(m && m.ok && isNum(m.measuredFt));
          candidates.push({
            planeId: pl.id, name: typeof pl.name === 'string' ? pl.name : '', kind: pl.kind, steep: isSteepPlane(pl),
            parentPlaneId: pl.derived.parentPlaneId, ok, lengthFt: ok ? m.measuredFt : null,
          });
        }
        const rank = (c) => (c.ok ? 0 : 2) + (c.steep ? 1 : 0);
        candidates.sort((a, b) => rank(a) - rank(b)); // stable: stored order within a rank
        out.push({
          featureId: id, type: type.id, label: typeof f.label === 'string' && f.label.trim() ? f.label.trim() : type.label,
          planeId: wall.id, wants, message: SURFACE_MESSAGE[wants],
          lengthFt: now && now.ok && isNum(now.measuredFt) ? now.measuredFt : null,
          candidates, canCreate: true,
        });
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  const LEVELS = ['low', 'medium', 'high'];
  // What to re-tap when taps placed zoomed out limit a rating (ends "zoom in and re-tap …"). Keys as in
  // planeTapInfo().what, plus 'item' for a feature's own points; several are joined with '+'.
  const TAP_WHAT = {
    rect: 'the corners of the rectangle',
    ref: 'the two ends of the reference length',
    refs: 'the ends of the reference lengths',
    eave: 'the two ends of the eave line',
    base: 'the two ends of the wall base line',
    item: 'the points of this item',
  };
  function tapWhatText(key) {
    const parts = (typeof key === 'string' ? key : '').split('+').map((k) => (Object.prototype.hasOwnProperty.call(TAP_WHAT, k) ? TAP_WHAT[k] : null)).filter(Boolean);
    return parts.length ? parts.join(' and ') : 'the points';
  }

  /**
   * Confidence score: start at 100 and subtract (SPEC §5.5). Every deduction adds a plain-language reason.
   * Then level caps that no score can buy back (each with its reason, listed first): tap-precision uncertainty,
   * refs-only walls, roof-ortho, an assumed focal length or pitch, off-plane items, a single unchecked reference,
   * a lens setting that disagrees with the rectangles, an assumed trunk diameter. When a cap lowers the level the
   * score is clamped into that level's band.
   * factors: {overridden, mode, kind, checks, disagreementPct, disagreementZ, onlyMediumLowRefs, minCourses,
   *           viewAngleDeg, focalSource, focalRelStd, focalMismatchPct, poseConsistencyPct, poseTolerancePct,
   *           pitchSource ('user' | 'estimated' | 'default' | 'guess' | 'house'), pitchOnEave, pitchSpread, steep, steepAngleDeg,
   *           slopeBelow (an unmeasured slope under an upper roof), rectProblem, rectCheckPct, refsBothDirections, anisotropic, scaleFrom,
   *           offPlane (type id or bool), offPlaneBiasPct, assumedDiameterIn, extrapolation, pixelLength,
   *           uncertaintyPct, uncertaintyBasePct, tapPx, tapWhat, ownTapPx, tapsFine, extraReasons,
   *           thresholds: {highMin, mediumMin}, reason}
   * ownTapPx: precision of the item's own points; when they were tapped zoomed out and that is not already the
   * reason given, a "Tapped zoomed out ... re-tap the points of this item too" reason is added. tapsFine: every tap
   * behind the number is known to have been placed zoomed in, so the advice is "use a larger rectangle" only.
   * Coarse taps (SPEC §8.4): when taps placed zoomed out (tapPx above 2.5 px) are what pushes the expected error
   * over a level limit, or are the larger part of it, the reason names them ("Tapped zoomed out (about ±N px on the
   * photo): zoom in and re-tap …") instead of the surface-specific advice. The level follows uncertaintyPct either way.
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
    // The scale was taken from a reference rectangle instead of the wall's own. The wall's own rectangle then
    // measures this far from its stated size, and every length can be off by as much (the other rectangle may sit
    // on another surface, or one of the sizes may be wrong), so the rating cannot promise less than that gap.
    if (isNum(fx.rectCheckPct) && fx.rectCheckPct >= U_HIGH_PCT) {
      cap(fx.rectCheckPct >= U_MEDIUM_PCT ? 'low' : 'medium', 'The two measured rectangles on this wall are ' + fx.rectCheckPct.toFixed(1) +
        '% apart. Check that both sit flat on this wall and that their sizes are right.');
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
      take(10, 'How wide the camera sees (its focal length) is assumed: a phone main camera. Choose the camera that took the photo.');
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
    } else if (fx.pitchSource === 'guess' || (fx.pitchSource === 'default' && fx.steep)) {
      // A steep roof face (mansard) whose slope nobody measured: a guess in degrees, or the 70° default.
      const deg = isNum(fx.steepAngleDeg) ? Math.round(fx.steepAngleDeg) : STEEP.defaultDeg;
      const fixIt = ' Measure how far the face goes up and how far it goes back.';
      if (fx.pitchSource === 'guess') {
        take(10, 'The slope of this steep roof face (' + deg + '°) is a guess.');
        cap('low', 'Lengths on a steep roof face depend on its slope, and ' + deg + '° is only a guess.' + fixIt);
      } else {
        take(25, 'The slope of this steep roof face is unknown, so ' + deg + '° is assumed.');
        cap('low', 'Lengths on a steep roof face depend on its slope, and it is only assumed.' + fixIt);
      }
    } else if (fx.pitchSource === 'house') {
      // An upper roof (on a steep roof face) with no pitch of its own: the house pitch is only borrowed.
      take(10, 'The pitch of this upper roof is taken from the house pitch.');
      cap('low', 'The top of a mansard is usually flatter than the rest of the house, and this upper roof has no pitch of its own. Enter the pitch of this upper roof.');
    } else if (fx.pitchSource === 'default') {
      take(25, 'The roof pitch is unknown, so 6/12 is assumed. Enter the pitch.');
      cap('low', 'Roof lengths depend on the pitch, and it is only assumed. Enter the pitch.');
    }
    if (fx.slopeBelow === 'default' || fx.slopeBelow === 'guess' || fx.slopeBelow === 'estimated' || fx.slopeBelow === 'house') {
      cap('low', 'This roof starts at the top of a roof face whose slope is not measured, so it may sit in the wrong place. Measure how far that face goes up and how far it goes back.');
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
    const capOf = (x) => (x > U_MEDIUM_PCT ? 'low' : x > U_HIGH_PCT ? 'medium' : null);
    let zoomWhy = null;
    if (isNum(fx.tapPx) && fx.tapPx > SIGMA_TAP_PX && (u === Infinity || isNum(u)) && capOf(u)) {
      const u0 = fx.uncertaintyBasePct; // the expected error had every tap been good to 2.5 px
      const pushesOver = isNum(u0) && capOf(u0) !== capOf(u);
      const largerPart = !isNum(u0) || u === Infinity || u * u > 2 * u0 * u0;
      if (pushesOver || largerPart) {
        zoomWhy = 'Tapped zoomed out (about ±' + Math.round(fx.tapPx) + ' px on the photo): zoom in and re-tap ' + tapWhatText(fx.tapWhat) + '.';
      }
    }
    if (u === Infinity) cap('low', zoomWhy || 'A small tap error changes this measurement a lot. Re-tap the rectangle and references, zoomed in.');
    else if (isNum(u)) {
      // The fix depends on the surface: ground and roof lengths hinge on the camera pose worked out from the wall,
      // so zooming in on taps helps far less than a tape-measured length or a better vantage point.
      const fix = mode === 'ground-3d'
        ? 'from street level the ground is seen almost edge-on. Add a tape-measured reference on this ground surface, or take the photo from closer or higher.'
        : (mode === 'roof-3d' || mode === 'roof-ortho')
          ? 'roof lengths depend on the camera angle worked out from the wall. Type a tape-measured length if you can, or rely on the 10% waste.'
          : fx.tapsFine === true ? 'use a larger rectangle (the points were already tapped zoomed in, so zooming in further will not help).'
            : 'zoom in or use a larger rectangle.';
      const about = 'Expected error about ±' + (u < 10 ? u.toFixed(1) : Math.round(u)) + '%';
      // Coarse taps on a small rectangle can give an expected error of several hundred percent; past ±50% the
      // number says nothing a person can use, so it is put in words.
      const asTapped = u > 50 ? 'As tapped, this measurement could be off by more than half.' : about + ' as tapped.';
      const why = zoomWhy ? zoomWhy + ' ' + asTapped : about + ' from how exactly the points could be tapped; ' + fix;
      if (u > U_MEDIUM_PCT) cap('low', why);
      else if (u > U_HIGH_PCT) cap('medium', why);
    }
    // The item's own points were tapped zoomed out, but something else is the larger part of the error: still say
    // so, because re-tapping them zoomed in is the quickest thing the user can do.
    const named = zoomWhy && typeof fx.tapWhat === 'string' && fx.tapWhat.split('+').includes('item');
    if (!named && isNum(fx.ownTapPx) && fx.ownTapPx > SIGMA_TAP_PX && (u === Infinity || (isNum(u) && capOf(u)))) {
      reasons.push('Tapped zoomed out (about ±' + Math.round(fx.ownTapPx) + ' px on the photo): zoom in and re-tap ' + TAP_WHAT.item + ' too.');
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
    if (isNum(u) && u <= U_HIGH_PCT && level === 'high') all.push('Expected error about ±' + u.toFixed(1) + '% from how exactly the points could be tapped.');
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
  function planeConfidence(sol, thresholds, uncertaintyPct, tapDetail) {
    if (!sol || !sol.ok) return null;
    const td = isObj(tapDetail) ? tapDetail : {};
    return scoreConfidence({
      uncertaintyPct, uncertaintyBasePct: td.basePct, tapPx: td.tapPx, tapWhat: td.tapWhat,
      tapsFine: sol.tapsRecorded === true && !(td.tapPx > SIGMA_TAP_PX),
      mode: sol.mode, kind: sol.kind, checks: sol.checks, disagreementPct: sol.disagreementPct, disagreementZ: sol.disagreementZ,
      onlyMediumLowRefs: !!(sol.calib && sol.calib.onlyMediumLowRefs), minCourses: sol.calib ? sol.calib.minCourses : null,
      viewAngleDeg: sol.viewAngleDeg, focalSource: sol.K ? sol.K.source : null, focalRelStd: sol.K ? sol.K.relStd : null,
      focalMismatchPct: sol.focalMismatchPct, poseConsistencyPct: sol.poseConsistencyPct, poseTolerancePct: sol.poseTolerancePct,
      pitchSource: sol.kind === 'roof' && sol.pitch ? sol.pitch.source : null,
      pitchOnEave: sol.pitchInfo ? sol.pitchInfo.onEave : null, pitchSpread: sol.pitchInfo ? sol.pitchInfo.spread : null,
      steep: !!sol.steep, steepAngleDeg: sol.steep && sol.pitch ? sol.pitch.angleDeg : null, slopeBelow: sol.slopeBelow,
      rectProblem: sol.calib ? sol.calib.rectProblem : null, refsBothDirections: !!(sol.calib && sol.calib.refsBothDirections),
      rectCheckPct: sol.calib ? sol.calib.rectCheckPct : null,
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
      const anyDefault = Object.keys(solved.planes).some((k) => solved.planes[k].pitch && solved.planes[k].pitch.source === 'default' && !solved.planes[k].steep);
      if (anyDefault) warnings.push({ level: 'info', code: 'pitch-default', message: 'Roof pitch is unknown, so 6/12 is assumed. Trace a gable rake on a wall or enter the pitch.' });
    }
    const thresholds = isObj(cfg.confidence) ? cfg.confidence : catalog.DEFAULT_CONFIG.confidence;

    // Nudged plane solutions for the tap-precision estimate (every solved plane: its pill shows it too).
    const needed = new Set(Object.keys(solved.planes).filter((pid) => solved.planes[pid].ok));
    let perturb = {};
    if (needed.size) {
      try { perturb = perturbedSolutions(proj, cfg, cameras, solvedAll, needed); } catch (e) { perturb = {}; }
    }
    const planeObj = {};
    for (const pl of arr(proj.planes)) if (isObj(pl) && pl.id != null) planeObj[pl.id] = pl;
    for (const pid of Object.keys(solved.planes)) {
      const sol = solved.planes[pid];
      // Every tap behind this surface has a recorded precision: its own, and its parent wall's for a roof or ground.
      const own = planeObj[pid];
      let recorded = planeTapsRecorded(own);
      const walked = new Set([pid]);
      for (let up = own; recorded && up && isObj(up.derived) && up.derived.parentPlaneId != null && !walked.has(up.derived.parentPlaneId);) {
        walked.add(up.derived.parentPlaneId);
        up = planeObj[up.derived.parentPlaneId];
        recorded = planeTapsRecorded(up);
      }
      sol.tapsRecorded = recorded;
      let u = null;
      const tapDetail = {};
      if (sol.ok && sol.mode !== 'roof-ortho') {
        // The typical item itself counts as carefully tapped (2.5 px): the pill rates the calibration.
        const seg = representativeSegment(sol);
        try { u = seg ? featureUncertaintyPct('polyline', seg, false, sol, perturb[pid] || [], SIGMA_TAP_PX, tapDetail) : null; } catch (e) { u = null; }
      }
      sol.uncertaintyPct = isNum(u) || u === Infinity ? u : null;
      sol.confidence = planeConfidence(sol, thresholds, sol.uncertaintyPct, tapDetail);
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
    STEEP, steepFromTape, misplacedFeatures,
    imageToPlane, planeToImage, planeGridLines, formatLength, spiralWrapFt,
  };
});
