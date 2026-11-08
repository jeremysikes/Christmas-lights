/* LightPlan core: camera (single-view metrology).
 *
 * Pinhole camera with square pixels, no skew and the principal point at the image center:
 *   K = [[f, 0, cx], [0, f, cy], [0, 0, 1]]   (pixels)
 *
 * Wall frame (feet): u right along the wall, v up, w out of the wall toward the camera. The wall is w = 0.
 * Camera frame: x right, y down (image rows), z forward. A wall point X maps to the camera frame as
 * Xc = R·X + t, and to the image as K·Xc / Xc.z. R's columns r1, r2, r3 are the wall axes u, v, w expressed in
 * camera coordinates. Because v is "up" and image y is "down", r2 points roughly along -y, so
 * r3 = r1 × r2 points along -z, i.e. back toward the camera, and the camera center C = -Rᵀt has C.w > 0.
 *
 * Pure functions: no DOM, no clocks, inputs are never mutated.
 *
 * Deviations from SPEC §5.2 (documented signatures all still work):
 *  - resolveCamera() also returns `ok` (false when the image has no usable width/height; f is then null).
 *  - resolveCamera() 'auto' also considers rectangle references (e.g. a door drawn as a rectangle) besides
 *    the plane rectangles; the lowest relStd still wins, and small rectangles rarely pass the stability test.
 *  - viewAngleDeg(pose, point, normal?) takes an optional plane normal (default: the wall normal (0,0,1)).
 *  - estimateFocalFromQuad() also returns `samples` (the perturbed estimates) for debugging.
 *  - poseFromHomography() also returns `consistency: {normRatio, cosAngle}` (how well H agrees with K).
 *  - Extra exports: getPreset, DEFAULT_PRESET_ID, FULL_FRAME_DIAGONAL_MM, Kmatrix, KinvMatrix.
 */
LP.define('camera', ['geometry'], function (g) {
  'use strict';

  /** Diagonal of a 36 x 24 mm full-frame sensor, the reference for "35 mm equivalent" focal lengths. */
  const FULL_FRAME_DIAGONAL_MM = 43.2666;

  const CAMERA_PRESETS = [
    { id: 'phone1x', label: 'Phone main camera (1×)', f35: 26 },
    { id: 'phone2x', label: 'Phone 2× zoom', f35: 52 },
    { id: 'phone3x', label: 'Phone 3× telephoto', f35: 77 },
    { id: 'phone05x', label: 'Phone 0.5× ultra-wide', f35: 13 },
    { id: 'streetview', label: 'Street View screenshot', hfovDeg: 90 },
    { id: 'camera50', label: 'Camera 50 mm', f35: 50 },
  ];
  const DEFAULT_PRESET_ID = 'phone1x';

  // Focal-from-rectangle acceptance rules (SPEC §5.2).
  const FOCAL_MIN_FACTOR = 0.25; // f >= 0.25 · max(w, h)
  const FOCAL_MAX_FACTOR = 6; //    f <= 6 · max(w, h)
  const FOCAL_MAX_REL_STD = 0.15; // perturbation study must be this stable
  const PERTURB_PX = 2; //         corner jitter used by the perturbation study

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isPt = (p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]);
  const isQuad = (q) => Array.isArray(q) && q.length === 4 && q.every(isPt);

  // ---------------------------------------------------------------- intrinsics
  function focalFromF35(f35, width, height) {
    if (!(f35 > 0) || !(width > 0) || !(height > 0)) return null;
    return (f35 * Math.hypot(width, height)) / FULL_FRAME_DIAGONAL_MM;
  }

  function focalFromHfov(hfovDeg, width) {
    if (!(hfovDeg > 0 && hfovDeg < 179) || !(width > 0)) return null;
    return width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  }

  function getPreset(presetId) {
    return CAMERA_PRESETS.find((p) => p.id === presetId) || null;
  }

  function focalFromPreset(presetId, width, height) {
    const p = getPreset(presetId) || getPreset(DEFAULT_PRESET_ID);
    if (p.hfovDeg) return focalFromHfov(p.hfovDeg, width);
    return focalFromF35(p.f35, width, height);
  }

  function Kmatrix(K) { return [K.f, 0, K.cx, 0, K.f, K.cy, 0, 0, 1]; }
  function KinvMatrix(K) { return [1 / K.f, 0, -K.cx / K.f, 0, 1 / K.f, -K.cy / K.f, 0, 0, 1]; }
  function validK(K) { return !!K && K.f > 0 && isNum(K.f) && isNum(K.cx) && isNum(K.cy); }

  // Unit square in [TL, TR, BR, BL] order with v up: TL=(0,1), TR=(1,1), BR=(1,0), BL=(0,0).
  const UNIT_SQUARE = [[0, 1], [1, 1], [1, 0], [0, 0]];

  // ---------------------------------------------------------------- focal length from a rectangle
  /**
   * f² from the orthogonality of a rectangle's sides.
   * H_s maps the unit square to centered image coordinates, so its first two columns are (up to scale) K·r1
   * and K·r2. With K = diag(f, f, 1): r1·r2 = 0  ⇒  (h0·h1 + h3·h4)/f² + h6·h7 = 0.
   * Returns NaN when the quad does not define a finite, positive f².
   */
  function focalSquaredFromQuad(quad, cx, cy) {
    const centered = quad.map((p) => [p[0] - cx, p[1] - cy]);
    const H = g.homographyFromPoints(UNIT_SQUARE, centered);
    if (!H) return NaN;
    // Rescale so the products below are well conditioned (f² is invariant to the overall scale of H).
    const den = H[6] * H[7];
    const num = -(H[0] * H[1] + H[3] * H[4]);
    if (!isNum(den) || !isNum(num) || den === 0) return NaN;
    return num / den;
  }

  /**
   * Estimate the focal length (px) from a perspective rectangle [TL, TR, BR, BL].
   * Needs both vanishing points to be finite (the photo must be angled sideways AND tilted). A deterministic
   * perturbation study (each corner moved ±2 px in x and in y, one at a time: 16 variants) gives relStd,
   * the RMS relative change of f. ok only when f is believable and stable.
   */
  function estimateFocalFromQuad(quad, cx, cy) {
    const fail = (reason, extra) => Object.assign({ ok: false, f: null, relStd: null, reason }, extra || {});
    if (!isQuad(quad) || !isNum(cx) || !isNum(cy) || cx <= 0 || cy <= 0) {
      return fail('The rectangle needs 4 corners on the photo.');
    }
    const q = g.orderQuad(quad);
    if (!g.isConvexQuad(q)) return fail('The rectangle corners do not form a 4-sided shape. Re-tap the corners.');
    const maxSide = 2 * Math.max(cx, cy);
    const f2 = focalSquaredFromQuad(q, cx, cy);
    const straightOn = "The photo is nearly straight-on, so the focal length can't be measured from the rectangle.";
    if (!(f2 > 0)) return fail(straightOn);
    const f = Math.sqrt(f2);
    if (f < FOCAL_MIN_FACTOR * maxSide || f > FOCAL_MAX_FACTOR * maxSide) {
      // A very long focal estimate almost always means "too straight-on to tell".
      return fail(f > FOCAL_MAX_FACTOR * maxSide ? straightOn
        : "The rectangle's corners don't give a believable focal length. Check that they are the corners of a real rectangle.", { estimate: f });
    }
    const offsets = [[PERTURB_PX, 0], [-PERTURB_PX, 0], [0, PERTURB_PX], [0, -PERTURB_PX]];
    const samples = [];
    let sumSq = 0;
    for (let i = 0; i < 4; i++) {
      for (const o of offsets) {
        const qq = q.map((p, k) => (k === i ? [p[0] + o[0], p[1] + o[1]] : p));
        const fk2 = focalSquaredFromQuad(qq, cx, cy);
        if (!(fk2 > 0)) {
          return fail('The rectangle is too small or too straight-on to measure the focal length reliably.', { estimate: f, relStd: Infinity });
        }
        const fk = Math.sqrt(fk2);
        samples.push(fk);
        sumSq += ((fk - f) / f) ** 2;
      }
    }
    const relStd = Math.sqrt(sumSq / samples.length);
    if (!(relStd <= FOCAL_MAX_REL_STD)) {
      return fail('The rectangle is too small or too straight-on to measure the focal length reliably.', { estimate: f, relStd, samples });
    }
    return { ok: true, f, relStd, reason: null, samples };
  }

  // ---------------------------------------------------------------- choosing the camera for an image
  /**
   * Resolve intrinsics for an image. Order for 'auto': EXIF 35 mm focal → best rectangle estimate → phone 1×.
   * 'exif' with no EXIF focal falls back to the 'auto' order (minus EXIF). 'manual' with a bad focalPx and
   * 'preset' with an unknown preset fall back to the default preset.
   */
  function resolveCamera(image, planes) {
    const img = image || {};
    const w = img.width, h = img.height;
    if (!(w > 0) || !(h > 0) || !isNum(w) || !isNum(h)) {
      return { ok: false, f: null, cx: null, cy: null, source: 'default', label: 'Photo size unknown', relStd: null };
    }
    const cx = w / 2, cy = h / 2;
    const cam = img.camera || {};
    const mode = cam.mode || 'auto';
    const out = (f, source, label, relStd) => ({ ok: true, f, cx, cy, source, label, relStd: relStd == null ? null : relStd });

    if (mode === 'manual' && cam.focalPx > 0 && isNum(cam.focalPx)) {
      return out(cam.focalPx, 'manual', 'Focal length entered by hand (' + Math.round(cam.focalPx) + ' px)', null);
    }
    if (mode === 'preset' && getPreset(cam.presetId)) {
      const p = getPreset(cam.presetId);
      return out(focalFromPreset(p.id, w, h), 'preset', p.label, null);
    }
    const exifF35 = img.exif && isNum(img.exif.focal35) && img.exif.focal35 > 0 ? img.exif.focal35 : null;
    if ((mode === 'auto' || mode === 'exif') && exifF35) {
      return out(focalFromF35(exifF35, w, h), 'exif', 'From the photo data (' + Math.round(exifF35) + ' mm equivalent)', null);
    }
    if (mode === 'auto' || mode === 'exif') {
      let best = null;
      for (const pl of Array.isArray(planes) ? planes : []) {
        if (!pl || (img.id != null && pl.imageId !== img.id) || (pl.kind && pl.kind !== 'wall')) continue;
        const quads = [];
        if (pl.rect && isQuad(pl.rect.corners)) quads.push({ quad: pl.rect.corners, what: 'rectangle' });
        for (const r of Array.isArray(pl.refs) ? pl.refs : []) {
          if (r && r.kind === 'rect' && isQuad(r.points)) quads.push({ quad: r.points, what: 'reference rectangle' });
        }
        for (const c of quads) {
          const est = estimateFocalFromQuad(c.quad, cx, cy);
          if (est.ok && (!best || est.relStd < best.relStd)) best = Object.assign({ plane: pl, what: c.what }, est);
        }
      }
      if (best) {
        const name = best.plane.name ? "'" + best.plane.name + "'" : 'a wall';
        return out(best.f, 'rectangle', 'Measured from the ' + best.what + ' on ' + name, best.relStd);
      }
    }
    const def = getPreset(DEFAULT_PRESET_ID);
    return out(focalFromPreset(def.id, w, h), 'default', 'Assumed: ' + def.label, null);
  }

  /** Width/height ratio of the real rectangle seen as `quad`, given intrinsics: ||K⁻¹h1|| / ||K⁻¹h2||. */
  function rectAspectFromQuad(quad, K) {
    if (!isQuad(quad) || !validK(K)) return null;
    const H = g.homographyFromPoints(UNIT_SQUARE, g.orderQuad(quad));
    if (!H) return null;
    const M = g.m3mul(KinvMatrix(K), H);
    const n1 = g.v3len(g.m3col(M, 0));
    const n2 = g.v3len(g.m3col(M, 1));
    const a = n1 / n2;
    return isNum(a) && a > 0 ? a : null;
  }

  // ---------------------------------------------------------------- pose
  /** Nearest rotation to a near-orthogonal 3x3 matrix (polar decomposition by Newton iteration). */
  function nearestRotation(M) {
    let R = M.slice();
    for (let it = 0; it < 30; it++) {
      const inv = g.m3inv(R);
      if (!inv) return null;
      const invT = g.m3transpose(inv);
      const next = R.map((v, i) => 0.5 * (v + invT[i]));
      let diff = 0;
      for (let i = 0; i < 9; i++) diff = Math.max(diff, Math.abs(next[i] - R[i]));
      R = next;
      if (diff < 1e-13) break;
    }
    return g.m3det(R) > 0 ? R : null;
  }

  /**
   * Camera pose from a plane→image homography (plane in feet, wall frame with w = 0).
   * M = K⁻¹H = λ⁻¹ [r1 r2 t]. λ = 2/(|m1|+|m2|) averages the two column norms (they should be equal).
   */
  function poseFromHomography(Hplane2img, K) {
    const fail = { ok: false, R: null, t: null, C: null };
    if (!Array.isArray(Hplane2img) || Hplane2img.length !== 9 || !Hplane2img.every(isNum) || !validK(K)) return fail;
    const M = g.m3mul(KinvMatrix(K), Hplane2img);
    const m1 = g.m3col(M, 0), m2 = g.m3col(M, 1), m3 = g.m3col(M, 2);
    const n = g.v3len(m1) + g.v3len(m2);
    if (!(n > 0)) return fail;
    let lambda = 2 / n;
    if (m3[2] * lambda < 0) lambda = -lambda; // the plane origin must be in front of the camera
    const r1 = g.v3scale(m1, lambda), r2 = g.v3scale(m2, lambda);
    const t = g.v3scale(m3, lambda);
    const r3 = g.v3cross(r1, r2);
    const R = nearestRotation(g.m3fromCols(r1, r2, r3));
    if (!R || !t.every(isNum)) return fail;
    const C = g.v3scale(g.m3mulv(g.m3transpose(R), t), -1);
    if (!C.every(isNum) || !(C[2] > 0)) return fail;
    // How well H and K agree: for a perfect match |m1| = |m2| and m1 ⟂ m2. A mismatch means the focal length,
    // the rectangle's stated size or its corners are off, and 3D results (roof, ground) inherit that error.
    const l1 = g.v3len(m1), l2 = g.v3len(m2);
    const consistency = { normRatio: l1 / l2, cosAngle: g.v3dot(m1, m2) / (l1 * l2) };
    return { ok: true, R, t, C, consistency };
  }

  /** Angle (degrees) between a plane normal (default: wall normal) and the ray from a plane point to the camera. */
  function viewAngleDeg(pose, planePoint3, normal) {
    if (!pose || !pose.C || !Array.isArray(planePoint3)) return null;
    const n = g.v3norm(normal || [0, 0, 1]);
    const v = g.v3sub(pose.C, planePoint3);
    const L = g.v3len(v);
    if (!(L > 0)) return null;
    const c = g.clamp(Math.abs(g.v3dot(v, n)) / L, 0, 1);
    return (Math.acos(c) * 180) / Math.PI;
  }

  /** Ray (wall frame) through an image pixel. */
  function rayThroughPixel(px, K, pose) {
    if (!isPt(px) || !validK(K) || !pose || !pose.R) return null;
    const dc = [(px[0] - K.cx) / K.f, (px[1] - K.cy) / K.f, 1];
    return { origin: pose.C.slice(), dir: g.v3norm(g.m3mulv(g.m3transpose(pose.R), dc)) };
  }

  /** Project a wall-frame 3D point to the image. null when the point is behind the camera. */
  function projectPoint(X3, K, pose) {
    if (!Array.isArray(X3) || !validK(K) || !pose || !pose.R) return null;
    const Xc = g.v3add(g.m3mulv(pose.R, X3), pose.t);
    if (!(Xc[2] > 1e-9)) return null;
    return [K.f * (Xc[0] / Xc[2]) + K.cx, K.f * (Xc[1] / Xc[2]) + K.cy];
  }

  // ---------------------------------------------------------------- derived planes
  /** Horizontal unit vector along A→B (the v component is dropped so eaves/bases are level). */
  function horizontalDir(A3, B3) {
    const d = [B3[0] - A3[0], 0, B3[2] - A3[2]];
    const L = g.v3len(d);
    return L > 1e-9 ? g.v3scale(d, 1 / L) : null;
  }

  /**
   * Roof frame: origin at eave point A, e1 level along the eave, e2 up the slope, away from the camera.
   * h is the level direction perpendicular to the eave pointing INTO the house (w < 0); the slope direction is
   * e2 = cosθ·h + sinθ·up with θ = atan(rise/run). n = e1 × e2, flipped to point upward.
   */
  function roofFrame(A3, B3, rise, run) {
    if (!Array.isArray(A3) || !Array.isArray(B3)) return null;
    const e1 = horizontalDir(A3, B3);
    if (!e1 || !(rise >= 0) || !(run > 0)) return null;
    let h = [-e1[2], 0, e1[0]];
    if (h[2] > 0) h = g.v3scale(h, -1);
    const th = Math.atan2(rise, run);
    const e2 = g.v3add(g.v3scale(h, Math.cos(th)), [0, Math.sin(th), 0]);
    let n = g.v3norm(g.v3cross(e1, e2));
    if (n[1] < 0) n = g.v3scale(n, -1);
    return { origin: A3.slice(), e1, e2, n };
  }

  /** Ground frame: origin at wall-base point A, e1 level along the base, e2 level and toward the camera (w > 0). */
  function groundFrame(A3, B3) {
    if (!Array.isArray(A3) || !Array.isArray(B3)) return null;
    const e1 = horizontalDir(A3, B3);
    if (!e1) return null;
    let e2 = [-e1[2], 0, e1[0]];
    if (e2[2] < 0) e2 = g.v3scale(e2, -1);
    return { origin: A3.slice(), e1, e2, n: [0, 1, 0] };
  }

  /** Homography from plane coordinates (a, b) of a 3D frame to the image: K·[R·e1, R·e2, R·origin + t]. */
  function homographyForFrame(frame, K, pose) {
    if (!frame || !validK(K) || !pose || !pose.R) return null;
    const c1 = g.m3mulv(pose.R, frame.e1);
    const c2 = g.m3mulv(pose.R, frame.e2);
    const c3 = g.v3add(g.m3mulv(pose.R, frame.origin), pose.t);
    const H = g.m3mul(Kmatrix(K), g.m3fromCols(c1, c2, c3));
    return H.every(isNum) ? g.normalizeH(H) : null;
  }

  /**
   * Slope length of a roof segment seen straight on (camera far away): horizontal runs are true length,
   * the vertical extent dv is the rise of a slope at angle θ, so its slope length is dv / sinθ.
   */
  function orthoPitchLength(du, dv, rise, run) {
    const th = Math.atan2(rise, run);
    const s = Math.sin(th);
    if (!(s > 1e-6)) return Math.hypot(du, dv);
    return Math.sqrt(du * du + (dv / s) ** 2);
  }

  return {
    FULL_FRAME_DIAGONAL_MM, CAMERA_PRESETS, DEFAULT_PRESET_ID, getPreset,
    focalFromF35, focalFromHfov, focalFromPreset, estimateFocalFromQuad, resolveCamera,
    rectAspectFromQuad, poseFromHomography, viewAngleDeg, rayThroughPixel, projectPoint,
    roofFrame, groundFrame, homographyForFrame, orthoPitchLength,
    Kmatrix, KinvMatrix,
  };
});
