/* LightPlan core: geometry.
 * Pure 2D/3D math: homographies (normalized DLT), polylines, polygons, quads, small 3D vector/matrix helpers.
 * No DOM, no globals besides LP. Matrices are flat row-major arrays of 9 numbers. */
LP.define('geometry', [], function () {
  'use strict';

  const EPS = 1e-12;

  // ---------------------------------------------------------------- linear algebra
  /** Solve A x = b (A: n rows of n numbers) by Gaussian elimination with partial pivoting. null if singular. */
  function solveLinear(A, b) {
    const n = b.length;
    if (!A || A.length !== n) return null;
    const M = A.map((row, i) => row.slice(0, n).concat([b[i]]));
    let maxAbs = 0;
    for (const row of M) for (let k = 0; k < n; k++) maxAbs = Math.max(maxAbs, Math.abs(row[k]));
    const tol = Math.max(maxAbs, 1) * 1e-13;
    for (let c = 0; c < n; c++) {
      let piv = c;
      let best = Math.abs(M[c][c]);
      for (let r = c + 1; r < n; r++) {
        const v = Math.abs(M[r][c]);
        if (v > best) { best = v; piv = r; }
      }
      if (!(best > tol)) return null;
      if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
      const pv = M[c][c];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / pv;
        if (f === 0) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x.every(Number.isFinite) ? x : null;
  }

  // ---------------------------------------------------------------- homographies
  function applyH(H, p) {
    if (!H || !p) return null;
    const x = p[0], y = p[1];
    const w = H[6] * x + H[7] * y + H[8];
    if (!Number.isFinite(w) || Math.abs(w) < EPS) return null;
    const u = (H[0] * x + H[1] * y + H[2]) / w;
    const v = (H[3] * x + H[4] * y + H[5]) / w;
    return Number.isFinite(u) && Number.isFinite(v) ? [u, v] : null;
  }

  function multiplyH(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
      }
    }
    return C;
  }

  function m3det(m) {
    return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  }

  function m3inv(m) {
    if (!m) return null;
    const d = m3det(m);
    if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
    const inv = [
      (m[4] * m[8] - m[5] * m[7]) / d, (m[2] * m[7] - m[1] * m[8]) / d, (m[1] * m[5] - m[2] * m[4]) / d,
      (m[5] * m[6] - m[3] * m[8]) / d, (m[0] * m[8] - m[2] * m[6]) / d, (m[2] * m[3] - m[0] * m[5]) / d,
      (m[3] * m[7] - m[4] * m[6]) / d, (m[1] * m[6] - m[0] * m[7]) / d, (m[0] * m[4] - m[1] * m[3]) / d,
    ];
    return inv.every(Number.isFinite) ? inv : null;
  }

  /** Scale a homography so H[8] = 1 when possible (else unit Frobenius norm). */
  function normalizeH(H) {
    if (!H) return null;
    if (Math.abs(H[8]) > 1e-10) return H.map((v) => v / H[8]);
    const n = Math.sqrt(H.reduce((s, v) => s + v * v, 0));
    return n > 0 ? H.map((v) => v / n) : null;
  }

  function invertH(H) {
    const inv = m3inv(H);
    return inv ? normalizeH(inv) : null;
  }

  function hartleyT(pts) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy);
    d /= pts.length;
    const s = d > EPS ? Math.SQRT2 / d : 1;
    return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  }

  /** Homography mapping src[i] → dst[i]. 4 points: exact (normalized DLT, h8 = 1); more: least squares. */
  function homographyFromPoints(src, dst) {
    if (!Array.isArray(src) || !Array.isArray(dst) || src.length < 4 || src.length !== dst.length) return null;
    for (const p of src.concat(dst)) if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    const Ts = hartleyT(src);
    const Td = hartleyT(dst);
    const s = src.map((p) => applyH(Ts, p));
    const d = dst.map((p) => applyH(Td, p));
    const rows = [];
    const rhs = [];
    for (let i = 0; i < s.length; i++) {
      const x = s[i][0], y = s[i][1], u = d[i][0], v = d[i][1];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.push(u);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(v);
    }
    let h;
    if (rows.length === 8) {
      h = solveLinear(rows, rhs);
    } else {
      const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
      const Atb = new Array(8).fill(0);
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        for (let i = 0; i < 8; i++) {
          Atb[i] += row[i] * rhs[r];
          for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
        }
      }
      h = solveLinear(AtA, Atb);
    }
    if (!h) return null;
    const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    const TdInv = m3inv(Td);
    if (!TdInv) return null;
    return normalizeH(multiplyH(TdInv, multiplyH(Hn, Ts)));
  }

  /** Diagonal scale matrix (applied after a homography: multiplyH(scaleMatrix(sx,sy), H)). */
  function scaleMatrix(sx, sy) {
    return [sx, 0, 0, 0, sy === undefined ? sx : sy, 0, 0, 0, 1];
  }

  /** Local linear scale of the map H at point p: output units per input unit. */
  function localScale(H, p) {
    if (!H || !p) return null;
    const x = p[0], y = p[1];
    const w = H[6] * x + H[7] * y + H[8];
    if (Math.abs(w) < EPS) return null;
    const X = (H[0] * x + H[1] * y + H[2]) / w;
    const Y = (H[3] * x + H[4] * y + H[5]) / w;
    const a = (H[0] - X * H[6]) / w, b = (H[1] - X * H[7]) / w;
    const c = (H[3] - Y * H[6]) / w, d = (H[4] - Y * H[7]) / w;
    const det = Math.abs(a * d - b * c);
    // singular values of [[a,b],[c,d]]
    const s1 = a * a + b * b + c * c + d * d;
    const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
    const sMax = Math.sqrt((s1 + disc) / 2);
    const sMin = Math.sqrt(Math.max(0, (s1 - disc) / 2));
    return { scale: Math.sqrt(det), sMin, sMax };
  }

  // ---------------------------------------------------------------- 2D primitives
  function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  function polylineLength(pts, closed) {
    if (!pts || pts.length < 2) return 0;
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    if (closed && pts.length > 2) L += dist(pts[pts.length - 1], pts[0]);
    return L;
  }

  function polygonArea(pts) {
    if (!pts || pts.length < 3) return 0;
    let s = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(s) / 2;
  }

  function bbox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts || []) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function centroid(pts) {
    if (!pts || !pts.length) return [0, 0];
    let x = 0, y = 0;
    for (const p of pts) { x += p[0]; y += p[1]; }
    return [x / pts.length, y / pts.length];
  }

  function pointSegmentDistance(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const point = [a[0] + t * dx, a[1] + t * dy];
    return { d: dist(p, point), t, point };
  }

  function orient(a, b, c) {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < 1e-12 ? 0 : (v > 0 ? 1 : -1);
  }
  function onSegment(a, b, p) {
    return Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
      Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
  }
  /** True when segment ab intersects segment cd (proper crossing or touching). */
  function segmentsIntersect(a, b, c, d) {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(a, b, c)) return true;
    if (o2 === 0 && onSegment(a, b, d)) return true;
    if (o3 === 0 && onSegment(c, d, a)) return true;
    if (o4 === 0 && onSegment(c, d, b)) return true;
    return false;
  }

  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Order 4 points as [TL, TR, BR, BL] (image space, y down), independent of tap order. */
  function orderQuad(pts) {
    if (!pts || pts.length !== 4) return pts ? pts.slice() : pts;
    const c = centroid(pts);
    const sorted = pts.slice().sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
    let start = 0;
    for (let i = 1; i < 4; i++) {
      if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
    }
    return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4].slice());
  }

  function isConvexQuad(pts) {
    if (!pts || pts.length !== 4) return false;
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-9) return false;
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  /** Point at arc length d along a polyline (clamped). */
  function pointAtDistance(pts, d) {
    if (!pts || !pts.length) return null;
    if (d <= 0 || pts.length === 1) return { point: pts[0].slice(), segIndex: 0 };
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const L = dist(pts[i - 1], pts[i]);
      if (acc + L >= d && L > 0) return { point: lerp(pts[i - 1], pts[i], (d - acc) / L), segIndex: i - 1 };
      acc += L;
    }
    return { point: pts[pts.length - 1].slice(), segIndex: Math.max(0, pts.length - 2) };
  }

  /** Samples at equal arc-length steps, endpoints included. */
  function resampleByDistance(pts, step, closed) {
    if (!pts || pts.length < 2 || !(step > 0)) return (pts || []).map((p) => p.slice());
    const path = closed ? pts.concat([pts[0]]) : pts;
    const total = polylineLength(path, false);
    const n = Math.max(1, Math.round(total / step));
    const out = [];
    for (let i = 0; i <= n; i++) out.push(pointAtDistance(path, (total * i) / n).point);
    if (closed) out.pop();
    return out;
  }

  function angleDeg(a, b) { return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; }

  // ---------------------------------------------------------------- 3D helpers
  const v3add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const v3scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const v3len = (a) => Math.hypot(a[0], a[1], a[2]);
  function v3norm(a) { const l = v3len(a); return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }

  const m3mul = multiplyH;
  function m3mulv(m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }
  function m3transpose(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
  function m3fromCols(c0, c1, c2) { return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]]; }
  function m3col(m, i) { return [m[i], m[3 + i], m[6 + i]]; }

  // ---------------------------------------------------------------- misc
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function median(values) {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  /** Deterministic PRNG (mulberry32). Returns a function producing [0,1). */
  function rng(seed) {
    let t = (seed >>> 0) || 1;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  return {
    EPS, solveLinear,
    applyH, multiplyH, invertH, normalizeH, homographyFromPoints, scaleMatrix, localScale,
    dist, lerp, polylineLength, polygonArea, bbox, centroid, pointSegmentDistance, segmentsIntersect,
    pointInPolygon, orderQuad, isConvexQuad, pointAtDistance, resampleByDistance, angleDeg,
    v3add, v3sub, v3scale, v3dot, v3cross, v3len, v3norm,
    m3mul, m3mulv, m3transpose, m3inv, m3det, m3fromCols, m3col,
    clamp, median, rng, hashString,
  };
});
