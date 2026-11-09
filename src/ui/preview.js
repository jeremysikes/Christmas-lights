/* LightPlan UI: preview (SPEC §6.4).
 * Turns the plan's light runs into individual bulbs on the photo and draws them as glowing lights.
 *
 * computeBulbs(project, plan, imageId) decides where every bulb goes (image px). It uses no DOM, so it also
 * runs in Node tests. It is memoized on (plan object, imageId).
 *  - Linear runs are sampled at equal TRUE spacing (product.bulbSpacingIn) along the feature in plane
 *    coordinates (feet) and mapped back with the plane's Hplane2img. Interpolating in plane space and then
 *    projecting is what makes the spacing perspective-correct: bulbs bunch up with distance like the real string.
 *    Segment lengths come from measure.measurePoints, so roof-ortho planes get their pitch correction too.
 *  - Bulbs closer than 2.5 image px are dropped; when that happens a soft line is drawn along the run instead,
 *    so dense mini lights still read as a continuous strand when zoomed out.
 *  - Icicles: bulbs on the line plus drops hanging straight down (dropLengthsIn, cycled).
 *  - Bushes: a seeded jittered scatter inside the polygon (at most 600 bulbs), or a diamond grid for nets.
 *  - Trees and columns: the projection of a helix around the trunk (a zig-zag across the trunk width). The trunk
 *    width comes from diameterIn and the local scale along the traced height; far-side bulbs are dimmed.
 *  - Path lights and ground stakes: a bulb on a short stake line that stands vertically in 3D.
 *  - No plane solution (not calibrated yet): bulbs are spaced in image space at a pixel spacing taken from another
 *    calibrated plane on the photo, or from the photo size.
 *  - Features without a run (the design stage failed) still get the type's default product and the project colors.
 *
 * drawBase / drawBulbs / renderSnapshot draw on a 2D canvas context. Bulbs are cached glow sprites (one per
 * color, size bucket, kind and day/night) drawn with 'lighter' compositing: a white-hot core, the bulb color, and a
 * long soft halo (bloom) that is wide at night and subtle by day.
 *
 * Deviations from SPEC §6.4 (documented signatures unchanged; all additive):
 *  - Bulb also has `a` (0..1 brightness; far-side trunk bulbs and bulbs deep in a bush are dimmer) and `run`
 *    (index in plan.runs, -1 when the feature had no run).
 *  - The array computeBulbs returns also carries `strands` ([{pts, color, width, kind:'glow'|'stake', alpha}]: soft
 *    lines for dense or continuous lights, and stake lines) and `imageId`. drawBulbs draws the strands.
 *  - drawBase also takes opts.width / opts.height (draw size in image px; default the image's own size).
 *  - drawBulbs also takes opts.dpr (device px per CSS px, default 1) so minimum bulb sizes stay constant on screen.
 *    pxPerImagePx is DEVICE px per image px (the full canvas transform scale).
 *  - renderSnapshot also takes opts.imageId (default: the project's active image).
 *  - Extra exports: clearCaches(), twinkleFactor(bulb, timeSec), BULB_RADIUS_IN, MAX_BUSH_BULBS, MIN_SPACING_PX.
 */
LP.define('ui.preview', ['geometry', 'catalog', 'measure', 'camera'], function (g, catalog, measure, camera) {
  'use strict';

  const MAX_BUSH_BULBS = 600;
  const MIN_SPACING_PX = 2.5;
  const MAX_SAMPLES_PER_RUN = 50000;   // guard against a wildly mis-scaled plane
  const DROP_BULB_SPACING_IN = 2.5;   // icicle bulbs along each drop
  /** Radius of the lit part of one bulb as it reads in a photo (inches). Not the glass size. */
  const BULB_RADIUS_IN = { c9: 1.0, c7: 0.8, mini: 0.34, icicle: 0.34, net: 0.34, rope: 0.42, track: 0.6, path: 1.5, treewrap: 0.34 };
  const KIND_BY_CATEGORY = { c9: 'bulb', c7: 'bulb', track: 'bulb', mini: 'mini', icicle: 'mini', net: 'mini', rope: 'mini', treewrap: 'mini', path: 'stake' };
  const STAKE_HEIGHT_FT = { path: 1.2, other: 0.7 };

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const pos = (v) => (isNum(v) && v > 0 ? v : null);
  const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  function cleanPts(points) {
    if (!Array.isArray(points)) return null;
    const out = [];
    for (const p of points) {
      if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) return null;
      out.push([p[0], p[1]]);
    }
    return out;
  }

  // ================================================================ colors
  function parseHex(hex) {
    const s = String(hex || '').trim();
    if (!HEX_RE.test(s)) return [255, 196, 107];
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function mixRgb(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rgba(c, a) {
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + Math.max(0, Math.min(1, a)).toFixed(4) + ')';
  }
  function toHex(c) {
    return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  /** Average color of a palette (multicolor dense strands read as a mixed glow). */
  function averageColor(colors) {
    const rgb = colors.map(parseHex);
    const sum = rgb.reduce((s, c) => [s[0] + c[0], s[1] + c[1], s[2] + c[2]], [0, 0, 0]);
    return toHex(sum.map((v) => v / rgb.length));
  }

  // ================================================================ bulb layout
  function usableSol(s) { return s && s.ok && s.Hplane2img && s.Himg2plane ? s : null; }

  function activeImageId(project) {
    const images = arr(project && project.images);
    const act = images.find((i) => i && i.id === project.activeImageId);
    return (act || images[0] || {}).id || null;
  }

  /** Everything the per-feature samplers need, resolved once per (plan, image). */
  function makeContext(project, plan, imageId, lib) {
    const img = arr(project.images).find((i) => i && i.id === imageId) || null;
    const W = pos(img && img.width) || 1600;
    const H = pos(img && img.height) || 1200;
    const measured = plan && isObj(plan.measured) ? plan.measured : {};
    const sols = isObj(measured.planes) ? measured.planes : {};
    const planesOnImage = arr(project.planes).filter((p) => p && p.imageId === imageId);
    // Calibrated planes on this photo, walls first: used to estimate a pixel scale for uncalibrated features.
    const imgSols = planesOnImage
      .map((p) => ({ p, s: usableSol(sols[p.id]) }))
      .filter((x) => x.s)
      .sort((a, b) => (a.p.kind === 'wall' ? 0 : 1) - (b.p.kind === 'wall' ? 0 : 1))
      .map((x) => x.s);
    return {
      project, plan, imageId, W, H, sols, imgSols,
      products: arr(lib && lib.products),
      config: isObj(lib && lib.config) ? lib.config : catalog.DEFAULT_CONFIG,
      measuredFeatures: isObj(measured.features) ? measured.features : {},
      settings: isObj(project.settings) ? project.settings : {},
      fallbackPxPerFt: Math.max(W, H) / 60,   // a typical house front fills about 60 ft of a photo's long side
    };
  }

  /** Image px per foot at image point p (least-foreshortened direction, i.e. how big a small sphere looks). */
  function pxPerFtAt(ctx, sol, p) {
    const s = sol || ctx.imgSols[0] || null;
    if (s && p) {
      const ls = g.localScale(s.Himg2plane, p);
      if (ls && ls.sMin > 1e-9 && Number.isFinite(ls.sMin)) {
        const v = 1 / ls.sMin;
        if (v > 1e-3 && v < 1e5) return v;
      }
    }
    return ctx.fallbackPxPerFt;
  }

  /**
   * The image point hFt straight up (negative: down) from image point p, which lies on plane `sol`.
   * Walls: +v in plane coordinates. Roof/ground planes with a recovered pose: lift the 3D point along the wall
   * frame's vertical and project it with the camera. Otherwise: image up, scaled by the local pixel scale.
   */
  function liftPoint(ctx, sol, p, hFt) {
    if (sol) {
      const uv = g.applyH(sol.Himg2plane, p);
      if (uv && (sol.kind === 'wall' || sol.mode === 'billboard')) {
        const q = g.applyH(sol.Hplane2img, [uv[0], uv[1] + hFt]);
        if (q) return q;
      } else if (uv && sol.frame && sol.pose && sol.K) {
        const fr = sol.frame;
        const X = g.v3add(fr.origin, g.v3add(g.v3scale(fr.e1, uv[0]), g.v3scale(fr.e2, uv[1])));
        const q = camera.projectPoint([X[0], X[1] + hFt, X[2]], sol.K, sol.pose);
        if (q && g.dist(p, q) < Math.abs(hFt) * pxPerFtAt(ctx, sol, p) * 4 + 2) return q;
      }
    }
    return [p[0], p[1] - hFt * pxPerFtAt(ctx, sol, p)];
  }

  /** Start the point list at the run's start (power end): reverse an open run, rotate a closed one. */
  function orientToStart(pts, closed, start) {
    if (!Array.isArray(start) || !isNum(start[0]) || !isNum(start[1]) || pts.length < 2) return pts;
    let best = 0;
    let bd = Infinity;
    pts.forEach((p, i) => { const d = g.dist(p, start); if (d < bd) { bd = d; best = i; } });
    if (closed) return pts.slice(best).concat(pts.slice(0, best));
    return best === pts.length - 1 ? pts.slice().reverse() : pts;
  }

  /**
   * Points at equal true spacing (feet) along a path, perspective-correct when the plane is solved.
   * Returns {points, dense} where dense means some bulbs were dropped by the 2.5 px cap.
   */
  function sampleAlong(ctx, sol, pts, closed, spacingFt) {
    const full = closed && pts.length > 2 ? pts.concat([pts[0]]) : pts;
    let positions = null;
    if (sol && spacingFt > 0) {
      const m = measure.measurePoints(full, false, sol);
      const plane = m.planePoints;
      const segs = m.segmentsFt;
      if (plane && segs && segs.length === full.length - 1 && segs.every(isNum)) {
        const total = segs.reduce((s, v) => s + v, 0);
        if (total > 1e-6) {
          const n = Math.min(MAX_SAMPLES_PER_RUN, Math.max(1, Math.round(total / spacingFt)));
          positions = [];
          let seg = 0;
          let acc = 0;
          for (let i = 0; i <= n; i++) {
            const d = (total * i) / n;
            while (seg < segs.length - 1 && acc + segs[seg] < d) { acc += segs[seg]; seg++; }
            const t = segs[seg] > 0 ? Math.max(0, Math.min(1, (d - acc) / segs[seg])) : 0;
            const p = g.applyH(sol.Hplane2img, g.lerp(plane[seg], plane[seg + 1], t));
            if (p) positions.push(p);
          }
        }
      }
    }
    if (!positions) {
      const pxSpacing = Math.max(MIN_SPACING_PX, spacingFt * pxPerFtAt(ctx, null, g.centroid(full)));
      const pxLen = g.polylineLength(full, false);
      positions = pxLen / pxSpacing > MAX_SAMPLES_PER_RUN ? [] : g.resampleByDistance(full, pxSpacing, false);
    }
    if (closed && positions.length > 1) positions.pop();   // the closing sample repeats the first one
    const kept = [];
    let dense = false;
    for (const p of positions) {
      if (!kept.length || g.dist(kept[kept.length - 1], p) >= MIN_SPACING_PX) kept.push(p);
      else dense = true;
    }
    if (closed && kept.length > 2 && g.dist(kept[kept.length - 1], kept[0]) < MIN_SPACING_PX) { kept.pop(); dense = true; }
    return { points: kept, dense };
  }

  /** Image-px gap from point i to its nearest neighbour along a sampled line. */
  function neighborGap(points, i) {
    const a = i > 0 ? g.dist(points[i - 1], points[i]) : Infinity;
    const b = i < points.length - 1 ? g.dist(points[i], points[i + 1]) : Infinity;
    const d = Math.min(a, b);
    return Number.isFinite(d) ? d : 0;
  }

  /** A stand-in run for a feature the plan has no run for (type default product, project colors). */
  function pseudoRun(f, project, ctx) {
    const type = catalog.FEATURE_TYPES[f.type];
    if (!type) return null;
    const td = isObj(ctx.config.typeDefaults) ? ctx.config.typeDefaults : {};
    const product = catalog.getProduct(ctx.products, f.productId) || catalog.getProduct(ctx.products, td[f.type]) ||
      catalog.getProduct(catalog.DEFAULT_PRODUCTS, type.defaultProduct);
    const c = catalog.resolveColors(f.color, project.settings);
    return { featureId: f.id, productId: product ? product.id : null, category: product ? product.category : 'mini', colors: c.colors, bulbs: 0, start: null };
  }

  function addFeatureBulbs(out, ctx, f, run, runIndex) {
    const type = catalog.FEATURE_TYPES[f.type];
    const pts = cleanPts(f.points);
    if (!type || !pts || pts.length < 2) return;
    const product = catalog.getProduct(ctx.products, run.productId) || catalog.getProduct(catalog.DEFAULT_PRODUCTS, run.productId) ||
      catalog.getProduct(catalog.DEFAULT_PRODUCTS, type.defaultProduct) || {};
    const category = run.category || product.category || 'mini';
    let colors = arr(run.colors).filter((c) => HEX_RE.test(String(c)));
    if (!colors.length) colors = catalog.resolveColors(f.color, ctx.settings).colors;
    const rnd = g.rng(g.hashString(String(f.id || f.label || 'feature')));
    const sol = usableSol(ctx.sols[f.planeId]);
    const rIn = BULB_RADIUS_IN[category] || 0.4;
    const baseKind = KIND_BY_CATEGORY[category] || 'mini';
    // s: typical gap to neighbouring bulbs (image px) and dim: 1 along a line, 2 for a filled area. drawBulbs uses
    // them to thin bulbs that would sit closer than ~2 px on screen, so far-away bushes do not burn out to white.
    let spacing = 0;
    let dim = 1;
    const emit = (p, r, kind, i, a) => {
      out.push({ x: p[0], y: p[1], r: Math.max(0.15, Math.min(60, r)), color: colors[i % colors.length], phase: rnd(), kind, a: a == null ? 1 : a, run: runIndex, s: spacing, dim });
    };
    const params = isObj(f.params) ? f.params : {};

    // ---- area (bush): scatter or net grid
    if (type.geometry === 'area') {
      if (pts.length < 3) return;
      const areaPx = g.polygonArea(pts);
      if (areaPx < 4) return;
      const c = g.centroid(pts);
      const ppf = pxPerFtAt(ctx, sol, c);
      const r = (rIn / 12) * ppf;
      const b = g.bbox(pts);
      if (category === 'net') {
        const spacingIn = pos(product.bulbSpacingIn) || 4;
        let s = Math.max(MIN_SPACING_PX, (spacingIn / 12) * ppf);
        s = Math.max(s, Math.sqrt(areaPx / MAX_BUSH_BULBS) * 1.08);   // a diamond grid has ~1 bulb per s² · 0.87
        const dy = s * 0.866;
        spacing = s; dim = 2;
        let row = 0;
        let i = 0;
        for (let y = b.minY + dy / 2; y < b.maxY; y += dy, row++) {
          for (let x = b.minX + (row % 2 ? s : s / 2); x < b.maxX; x += s) {
            if (i >= MAX_BUSH_BULBS) break;
            if (g.pointInPolygon([x, y], pts)) { emit([x, y], r, 'mini', i, 0.85 + 0.15 * rnd()); i++; }
          }
        }
        return;
      }
      const m = ctx.measuredFeatures[f.id];
      const ftArea = areaPx / (ppf * ppf);
      const want = pos(run.bulbs) || pos(m && m.lights) || Math.round(ftArea * 60);
      const cap = Math.floor(areaPx / (MIN_SPACING_PX * MIN_SPACING_PX * 1.6));
      const n = Math.max(0, Math.min(want, MAX_BUSH_BULBS, cap));
      if (!n) return;
      // Jittered grid: one random point per cell keeps the coverage even (no clumps or bald patches).
      const cell = Math.sqrt(areaPx / n);
      spacing = cell; dim = 2;
      const cand = [];
      for (let y = b.minY; y < b.maxY; y += cell) {
        for (let x = b.minX; x < b.maxX; x += cell) {
          const q = [x + rnd() * cell, y + rnd() * cell];
          if (g.pointInPolygon(q, pts)) cand.push(q);
        }
      }
      for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
      cand.slice(0, n).forEach((q, i) => emit(q, r, 'mini', i, 0.55 + 0.45 * rnd()));
      return;
    }

    // ---- vertical (tree, column): helix around the trunk, or a canopy scatter
    if (type.geometry === 'vertical') {
      const base = pts[0];
      const top = pts[pts.length - 1];
      const Hpx = g.dist(base, top);
      if (Hpx < 3) return;
      const m = ctx.measuredFeatures[f.id];
      const heightFt = (m && m.ok && pos(m.heightFt)) || Hpx / pxPerFtAt(ctx, sol, base);
      const ppf = Hpx / heightFt;             // local scale along the traced height
      const along = [(top[0] - base[0]) / Hpx, (top[1] - base[1]) / Hpx];
      let perp = [-along[1], along[0]];
      if (perp[0] < 0) perp = [-perp[0], -perp[1]];
      const r = (rIn / 12) * ppf;
      if (type.id === 'tree' && params.wrapMode === 'canopy') {
        // Lights spread through the canopy: a seeded, evenly spread (Vogel spiral) fill of an ellipse on the trace.
        const mid = g.lerp(base, top, 0.5);
        const ax = Hpx / 2, bx = Hpx * 0.38;
        const area = Math.PI * ax * bx;
        const n = Math.max(0, Math.min(pos(run.bulbs) || pos(m && m.lights) || 300, MAX_BUSH_BULBS, Math.floor(area / (MIN_SPACING_PX * MIN_SPACING_PX * 1.6))));
        const golden = Math.PI * (3 - Math.sqrt(5));
        spacing = n ? Math.sqrt(area / n) : 0; dim = 2;
        for (let i = 0; i < n; i++) {
          const rr = Math.sqrt((i + 0.5) / n);
          const th = i * golden + rnd() * 0.6;
          const u = rr * Math.cos(th), v = rr * Math.sin(th);
          emit([mid[0] + along[0] * u * ax + perp[0] * v * bx, mid[1] + along[1] * u * ax + perp[1] * v * bx], r, 'mini', i, 0.55 + 0.45 * rnd());
        }
        return;
      }
      const tc = (type.id === 'tree' ? ctx.config.tree : ctx.config.column) || {};
      const D = pos(params.diameterIn) || pos(tc.defaultDiameterIn) || (type.id === 'tree' ? 10 : 8);
      const s = pos(params.spiralSpacingIn) || pos(tc.spiralSpacingIn) || (type.id === 'tree' ? 4 : 6);
      const rPx = (D / 24) * ppf;              // trunk radius in image px
      const turns = (heightFt * 12) / s;
      const helixIn = turns * Math.hypot(Math.PI * D, s);
      const spacingIn = pos(product.bulbSpacingIn) || 3;
      // Projected path length of the zig-zag: each turn crosses the trunk twice (≈ 4 r) while rising Hpx/turns.
      const projLen = turns * Math.hypot(4 * rPx, Hpx / turns);
      const n = Math.max(1, Math.min(Math.round(helixIn / spacingIn), Math.floor(projLen / MIN_SPACING_PX), 6000));
      spacing = projLen / n; dim = 1;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const th = 2 * Math.PI * turns * t;
        const side = Math.sin(th), depth = Math.cos(th);
        const p = [base[0] + along[0] * t * Hpx + perp[0] * rPx * side, base[1] + along[1] * t * Hpx + perp[1] * rPx * side];
        emit(p, r, 'mini', i, depth >= 0 ? 0.7 + 0.3 * depth : 0.16);
      }
      return;
    }

    // ---- linear types
    const closed = typeof f.closed === 'boolean' ? f.closed : !!type.closedDefault;
    const path = orientToStart(pts, closed && pts.length > 2, run.start);
    const isStakes = category === 'path' || (type.id === 'stakes' && (params.mount == null || params.mount === 'stake'));
    if (isStakes) {
      const stakesCfg = isObj(ctx.config.stakes) ? ctx.config.stakes : {};
      const spacingIn = category === 'path' ? (pos(product.stakeSpacingIn) || pos(product.bulbSpacingIn) || 18) : (pos(stakesCfg.spacingIn) || 12);
      const hFt = category === 'path' ? STAKE_HEIGHT_FT.path : STAKE_HEIGHT_FT.other;
      const res = sampleAlong(ctx, sol, path, false, spacingIn / 12);
      res.points.forEach((p, i) => {
        spacing = neighborGap(res.points, i); dim = 1;
        const top = liftPoint(ctx, sol, p, hFt);
        const ppf = pxPerFtAt(ctx, sol, p);
        out.strands.push({ pts: [p, top], color: colors[i % colors.length], width: Math.max(0.4, 0.05 * ppf), kind: 'stake', alpha: 1 });
        emit(top, (rIn / 12) * ppf, 'stake', i, 1);
      });
      return;
    }
    const spacingFt = (pos(product.bulbSpacingIn) || 12) / 12;
    const res = sampleAlong(ctx, sol, path, closed && path.length > 2, spacingFt);
    const glowLine = res.dense || category === 'rope';
    const lineColor = colors.length > 1 ? averageColor(colors) : colors[0];
    if (category === 'icicle') {
      const drops = arr(product.dropLengthsIn).filter((v) => pos(v));
      const dropList = drops.length ? drops : [4, 7, 10, 6];
      res.points.forEach((p, i) => {
        const ppf = pxPerFtAt(ctx, sol, p);
        const r = (rIn / 12) * ppf;
        spacing = neighborGap(res.points, i); dim = 1;
        emit(p, r, 'mini', i, 1);
        const L = dropList[i % dropList.length];
        dim = 2;
        const bottom = liftPoint(ctx, sol, p, -L / 12);
        const nDrop = Math.max(1, Math.round(L / DROP_BULB_SPACING_IN));
        let prev = p;
        for (let k = 1; k <= nDrop; k++) {
          const q = g.lerp(p, bottom, k / nDrop);
          if (g.dist(prev, q) < MIN_SPACING_PX) continue;
          emit(q, r * 0.9, 'drop', i, 0.92 - 0.25 * (k / nDrop));
          prev = q;
        }
      });
    } else {
      res.points.forEach((p, i) => {
        spacing = neighborGap(res.points, i); dim = 1;
        emit(p, (rIn / 12) * pxPerFtAt(ctx, sol, p), baseKind, i, category === 'rope' ? 0.55 : 1);
      });
    }
    if (glowLine) {
      const mid = path[Math.floor(path.length / 2)];
      const w = Math.max(0.5, (rIn / 12) * pxPerFtAt(ctx, sol, mid) * 1.3);
      out.strands.push({ pts: closed && path.length > 2 ? path.concat([path[0]]) : path, color: lineColor, width: w, kind: 'glow', alpha: category === 'rope' ? 0.85 : 0.5 });
    }
  }

  function emptyBulbs(imageId) {
    const out = [];
    out.strands = [];
    out.imageId = imageId || null;
    return out;
  }

  function buildBulbs(project, plan, imageId) {
    const out = emptyBulbs(imageId);
    if (!isObj(project)) return out;
    const lib = plan && isObj(plan.library) && Array.isArray(plan.library.products) ? plan.library : catalog.getLibrary(project);
    const ctx = makeContext(project, plan, imageId, lib);
    const runByFeature = new Map();
    arr(plan && plan.runs).forEach((r, i) => { if (isObj(r) && r.featureId != null && !runByFeature.has(r.featureId)) runByFeature.set(r.featureId, { run: r, index: i }); });
    const activeId = activeImageId(project);
    for (const f of arr(project.features)) {
      if (!isObj(f)) continue;
      if (f.imageId !== imageId && !(f.imageId == null && imageId === activeId)) continue;
      const entry = runByFeature.get(f.id);
      const run = entry ? entry.run : pseudoRun(f, project, ctx);
      if (!run) continue;
      try {
        addFeatureBulbs(out, ctx, f, run, entry ? entry.index : -1);
      } catch (e) {
        // One damaged feature must not take the whole preview down; its bulbs are simply skipped.
      }
    }
    return out;
  }

  // Memo: plan object (or the project when there is no plan) → Map(imageId → bulbs).
  let memo = new WeakMap();

  /** Bulbs for one photo. Memoized on (plan object, imageId). Never throws. */
  function computeBulbs(project, plan, imageId) {
    const id = imageId != null ? imageId : (isObj(project) ? activeImageId(project) : null);
    const key = isObj(plan) ? plan : (isObj(project) ? project : null);
    if (!key) return emptyBulbs(id);
    let byImage = memo.get(key);
    if (byImage && byImage.has(id)) return byImage.get(id);
    let bulbs;
    try { bulbs = buildBulbs(project, plan, id); } catch (e) { bulbs = emptyBulbs(id); }
    if (!byImage) { byImage = new Map(); memo.set(key, byImage); }
    byImage.set(id, bulbs);
    return bulbs;
  }

  // ================================================================ drawing
  function makeCanvas(w, h) {
    const W = Math.max(1, Math.ceil(w)), H = Math.max(1, Math.ceil(h));
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(W, H);
    return null;
  }

  function sourceSize(image) {
    if (!image) return [0, 0];
    const w = image.naturalWidth || image.videoWidth || image.width || 0;
    const h = image.naturalHeight || image.videoHeight || image.height || 0;
    return [w, h];
  }

  /** Darken an image-sized area to a night look (see drawBase). ctx is in image space. */
  function applyNight(ctx, w, h) {
    // Night vision is less saturated: pull 35% of the color out first.
    ctx.globalCompositeOperation = 'saturation';
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, h);
    // Darken to ~0.3 with more blue left than red (blue hour / moonlight).
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgb(62, 70, 100)';
    ctx.fillRect(0, 0, w, h);
    // The sky falls off toward the top and the corners darken a little, like a real night exposure.
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
    sky.addColorStop(0, 'rgb(150,155,175)');
    sky.addColorStop(1, 'rgb(255,255,255)');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    const vig = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.35, w / 2, h * 0.55, Math.hypot(w, h) * 0.62);
    vig.addColorStop(0, 'rgb(255,255,255)');
    vig.addColorStop(1, 'rgb(170,172,185)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
    // Keep the deepest shadows navy instead of flat black.
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = 'rgb(6, 9, 20)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  // image object → {w, h, canvas}: the night version, built once (also keeps twinkle frames cheap).
  let nightCache = new WeakMap();
  function nightVersion(image, w, h) {
    if (!image || typeof image !== 'object') return null;
    if (image.complete === false || image.naturalWidth === 0) return null;   // not decoded yet: do not cache a blank
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    const hit = nightCache.get(image);
    if (hit && hit.w === W && hit.h === H) return hit.canvas;
    const cv = makeCanvas(W, H);
    const x = cv && cv.getContext('2d');
    if (!x) return null;
    try { x.drawImage(image, 0, 0, W, H); } catch (e) { return null; }
    applyNight(x, W, H);
    nightCache.set(image, { w: W, h: H, canvas: cv });
    return cv;
  }

  /**
   * The photo, or the photo as it would look at night: darkened to about 30% with a slight blue tint, a darker
   * sky and a little less color, so the lights carry the picture. ctx is already transformed to image space.
   */
  function drawBase(ctx, image, opts) {
    if (!ctx) return;
    const o = opts || {};
    const sz = sourceSize(image);
    const w = pos(o.width) || sz[0];
    const h = pos(o.height) || sz[1];
    if (!w || !h) return;
    ctx.save();
    const night = o.night ? nightVersion(image, w, h) : null;
    let drawn = false;
    if (night) {
      ctx.drawImage(night, 0, 0, w, h);
      drawn = true;
    } else if (image) {
      try { ctx.drawImage(image, 0, 0, w, h); drawn = true; } catch (e) { drawn = false; }
      if (drawn && o.night) applyNight(ctx, w, h);
    }
    if (!drawn) {
      ctx.fillStyle = o.night ? '#0d1422' : '#2a3442';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  /**
   * Glow profiles per bulb kind (radii in multiples of the core radius):
   *   halo   outer radius of the sprite (bloom reach)      glowA / glowR  colored glow hugging the bulb
   *   bloomA strength of the wide bloom                     hot            how white the center burns
   *   minCore smallest core radius on screen (CSS px), so bulbs stay visible when zoomed out.
   */
  const LOOKS = {
    bulb: { minCore: 1.5, night: { halo: 13, glowA: 0.5, glowR: 2.7, bloomA: 0.2, hot: 0.62 }, day: { halo: 3.2, glowA: 0.28, glowR: 1.7, bloomA: 0.03, hot: 0.45 } },
    mini: { minCore: 0.8, night: { halo: 6.5, glowA: 0.42, glowR: 2.1, bloomA: 0.1, hot: 0.55 }, day: { halo: 2.6, glowA: 0.22, glowR: 1.6, bloomA: 0.02, hot: 0.4 } },
    drop: { minCore: 0.75, night: { halo: 6, glowA: 0.4, glowR: 2.0, bloomA: 0.09, hot: 0.55 }, day: { halo: 2.6, glowA: 0.22, glowR: 1.6, bloomA: 0.02, hot: 0.4 } },
    stake: { minCore: 1.5, night: { halo: 12, glowA: 0.55, glowR: 2.7, bloomA: 0.22, hot: 0.62 }, day: { halo: 3.2, glowA: 0.28, glowR: 1.7, bloomA: 0.03, hot: 0.45 } },
  };
  /** Bulbs whose on-screen gap falls below this (CSS px) are thinned out (see drawBulbs). */
  const LOD_GAP_CSS = 2.2;
  const KIND_INDEX = { bulb: 0, mini: 1, drop: 2, stake: 3 };
  const KIND_BY_INDEX = ['bulb', 'mini', 'drop', 'stake'];
  const BUCKET_BASE = 0.5;
  const BUCKET_STEP = Math.log(1.14);
  const MAX_HALO_DEV = 200;
  let spriteCache = new Map();   // color → Map(numeric key → sprite)
  let spriteCount = 0;

  /**
   * One glow sprite: a radial gradient sampled from I(d) = core + glow + bloom, where x = d / core radius:
   *   core  exp(-1.1 x²)            the bulb itself, burning toward white in the middle
   *   glow  glowA · exp(-(x/glowR)²) the colored light hugging the bulb
   *   bloom bloomA · exp(-3 d/R)    the wide, soft spill a camera records around bright points (faded to 0 at R)
   */
  function buildSprite(color, coreDev, kindIdx, night, haloMul) {
    const look = LOOKS[KIND_BY_INDEX[kindIdx]] || LOOKS.mini;
    const L = night ? look.night : look.day;
    const R = Math.min(MAX_HALO_DEV, Math.max(coreDev * Math.min(L.halo, haloMul || L.halo), coreDev + 1.5));
    const size = Math.ceil(R * 2) + 2;
    const canvas = makeCanvas(size, size);
    if (!canvas) return null;
    const c2 = canvas.getContext('2d');
    if (!c2) return null;
    const cx = size / 2;
    const base = parseHex(color);
    const white = [255, 255, 255];
    const grad = c2.createRadialGradient(cx, cx, 0, cx, cx, R);
    const N = 20;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * (i / N);              // denser stops near the center
      const d = t * R;
      const x = d / coreDev;
      const core = Math.exp(-x * x * 1.1);
      const glow = L.glowA * Math.exp(-(x / L.glowR) * (x / L.glowR));
      const fade = (1 - t * t) * (1 - t * t);
      const bloom = L.bloomA * Math.exp(-3 * t) * fade;
      const alpha = Math.min(1, core + glow + bloom);
      const col = mixRgb(base, white, L.hot * Math.pow(core, 1.4));
      grad.addColorStop(Math.min(1, t), rgba(col, i === N ? 0 : alpha));
    }
    c2.fillStyle = grad;
    c2.fillRect(0, 0, size, size);
    return { canvas, half: size / 2 };
  }

  /**
   * Cached sprite for (color, core size bucket, halo reach, kind, day/night). haloMul caps the halo radius in core
   * radii; drawBulbs lowers it for tightly packed bulbs so their halos do not stack into a white bar.
   */
  function getSprite(color, coreDev, kind, night, haloMul) {
    const kindIdx = KIND_INDEX[kind] != null ? KIND_INDEX[kind] : 1;
    const q = Math.max(0, Math.min(120, Math.round(Math.log(Math.max(coreDev, BUCKET_BASE) / BUCKET_BASE) / BUCKET_STEP)));
    const hm = Math.max(2, Math.min(15, Math.round(haloMul || 15)));
    const key = ((q * 16 + hm) * 4 + kindIdx) * 2 + (night ? 1 : 0);
    let byColor = spriteCache.get(color);
    if (!byColor) { byColor = new Map(); spriteCache.set(color, byColor); }
    let sp = byColor.get(key);
    if (sp === undefined) {
      if (spriteCount > 2500) { spriteCache = new Map(); spriteCount = 0; byColor = new Map(); spriteCache.set(color, byColor); }
      sp = buildSprite(color, BUCKET_BASE * Math.exp(q * BUCKET_STEP), kindIdx, night, hm);
      byColor.set(key, sp);
      spriteCount++;
    }
    return sp;
  }

  /** Brightness multiplier for twinkle at time tSec: each bulb fades on its own rhythm (phase sets offset and rate). */
  function twinkleFactor(b, tSec) {
    const ph = isNum(b.phase) ? b.phase : 0;
    const rate = 0.18 + 0.55 * ((ph * 7.31) % 1);    // Hz
    const s = 0.5 + 0.5 * Math.sin(2 * Math.PI * (tSec * rate + ph));
    if (b.kind === 'bulb' || b.kind === 'stake') return 0.62 + 0.38 * s;   // big bulbs shimmer
    return 0.18 + 0.82 * s * s;                                            // minis sparkle
  }

  /** Image-space rectangle visible through ctx's current (axis-aligned) transform, or null if unknown. */
  function visibleRect(ctx) {
    if (typeof ctx.getTransform !== 'function' || !ctx.canvas) return null;
    let m;
    try { m = ctx.getTransform(); } catch (e) { return null; }
    if (!m || Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9 || !(m.a > 0) || !(m.d > 0)) return null;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    return { x0: -m.e / m.a, y0: -m.f / m.d, x1: (W - m.e) / m.a, y1: (H - m.f) / m.d };
  }

  function strokePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  function drawStrands(ctx, strands, pxPer, dpr, night, onlyKind) {
    const minW = (0.6 * dpr) / pxPer;
    for (const s of strands) {
      if (!s || s.kind !== onlyKind || !Array.isArray(s.pts) || s.pts.length < 2) continue;
      const rgb = parseHex(s.color);
      if (s.kind === 'stake') {
        // Dark stake, faintly lit by its own bulb at night.
        ctx.strokeStyle = night ? rgba(mixRgb(rgb, [0, 0, 0], 0.7), 0.9) : 'rgba(58,72,60,0.9)';
        ctx.lineWidth = Math.max(minW, s.width);
        strokePath(ctx, s.pts);
        continue;
      }
      const w = Math.max(minW, s.width);
      const a = isNum(s.alpha) ? s.alpha : 0.5;
      ctx.strokeStyle = rgba(rgb, a * (night ? 0.16 : 0.08));
      ctx.lineWidth = w * (night ? 6 : 3);
      strokePath(ctx, s.pts);
      ctx.strokeStyle = rgba(mixRgb(rgb, [255, 255, 255], 0.35), a * (night ? 0.6 : 0.4));
      ctx.lineWidth = w;
      strokePath(ctx, s.pts);
    }
  }

  /**
   * Resolve each visible bulb to {sprite, x, y, size, alpha, group} for one view (pxPer, dpr, night). Applies
   * level of detail, halo capping and the zoom-out dimming. Twinkle is NOT applied here.
   *  - Level of detail: when bulbs sit closer than ~2 px on screen, keep a stable random subset (a fraction that
   *    falls with the gap, squared for filled areas) instead of piling sprites into a white blob.
   *  - Halo reach: at most ~3 gaps to the neighbours, so dense strings glow as a band without burning out.
   *  - A bulb drawn bigger than it really is (zoomed out) is dimmed in proportion, and packed area fills (bushes,
   *    nets) dim a little as they get denser on screen.
   */
  function resolveSprites(bulbs, pxPer, dpr, night, view) {
    const lodGap = LOD_GAP_CSS * dpr;
    const out = [];
    for (let i = 0; i < bulbs.length; i++) {
      const b = bulbs[i];
      if (!b || !isNum(b.x) || !isNum(b.y)) continue;
      if (b.s > 0) {
        const gap = b.s * pxPer;
        if (gap < lodGap) {
          const ratio = gap / lodGap;
          const keep = b.dim === 2 ? ratio * ratio : ratio;
          if ((b.phase * 97.13) % 1 > keep) continue;
        }
      }
      const look = LOOKS[b.kind] || LOOKS.mini;
      const physDev = (b.r || 0) * pxPer;
      const minDev = look.minCore * dpr;
      const coreDev = Math.max(physDev, minDev);
      const haloMul = b.s > 0 ? Math.max(2.5, (3 * b.s * pxPer) / coreDev) : 15;
      const sp = getSprite(b.color, coreDev, b.kind, night, haloMul);
      if (!sp) continue;
      const half = sp.half / pxPer;
      if (view && (b.x + half < view.x0 || b.x - half > view.x1 || b.y + half < view.y0 || b.y - half > view.y1)) continue;
      let a = isNum(b.a) ? b.a : 1;
      if (physDev < minDev) a *= Math.max(0.35, Math.pow(physDev / minDev, 0.4));
      if (b.dim === 2 && b.s > 0) a *= Math.max(0.6, Math.min(1, (b.s * pxPer) / (3.2 * dpr)));
      if (a <= 0.01) continue;
      out.push({ b, sp, half, a: a > 1 ? 1 : a });
    }
    return out;
  }

  // Twinkle groups: big bulbs shimmer in 2 groups, small ones sparkle in 4. Each bulb joins one group at random
  // (from its phase), and each group fades on its own rhythm, which reads as independent twinkling while the
  // per-frame cost no longer depends on the number of bulbs.
  const TWINKLE_GROUPS = 6;
  const GROUP_PHASES = [0.13, 0.61, 0.07, 0.38, 0.71, 0.93];
  function groupOf(b) {
    const r = (b.phase * 7.7) % 1;
    return b.kind === 'bulb' || b.kind === 'stake' ? (r < 0.5 ? 0 : 1) : 2 + Math.min(3, Math.floor(r * 4));
  }
  function groupFactor(gIdx, tSec) {
    return twinkleFactor({ phase: GROUP_PHASES[gIdx], kind: gIdx < 2 ? 'bulb' : 'mini' }, tSec);
  }

  const LAYER_PIXEL_BUDGET = 8e6;   // all layers of one canvas together (device px)
  const layerStates = new WeakMap(); // target canvas → {key, bulbs, box, scale, layers: [canvas]}

  /** Cache key without the translation: a pure pan can reuse the layers by shifting them. */
  function layerKey(m, W, H, pxPer, dpr, night, groups) {
    return [m.a, m.d, W, H, pxPer, dpr, night ? 1 : 0, groups].join('|');
  }

  /**
   * (Re)build the cached light layers for a target canvas: one layer, or one per twinkle group. When every glow
   * fits the pixel budget the layers cover all bulbs (so panning only shifts them); otherwise only the part
   * visible on the canvas is rendered.
   */
  function buildLayers(target, bulbs, m, pxPer, dpr, night, groups, prev) {
    let items = resolveSprites(bulbs, pxPer, dpr, night, null);
    const boxOf = (list) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const it of list) {
        const cx = it.b.x * m.a + m.e, cy = it.b.y * m.d + m.f, h = it.sp.half;
        if (cx - h < x0) x0 = cx - h;
        if (cy - h < y0) y0 = cy - h;
        if (cx + h > x1) x1 = cx + h;
        if (cy + h > y1) y1 = cy + h;
      }
      return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
    };
    let bb = boxOf(items);
    let clipped = false;
    if (!(bb.x1 > bb.x0 && bb.y1 > bb.y0) || (bb.x1 - bb.x0) * (bb.y1 - bb.y0) * groups > LAYER_PIXEL_BUDGET) {
      const view = { x0: -m.e / m.a, y0: -m.f / m.d, x1: (target.width - m.e) / m.a, y1: (target.height - m.f) / m.d };
      items = items.filter((it) => !(it.b.x + it.half < view.x0 || it.b.x - it.half > view.x1 || it.b.y + it.half < view.y0 || it.b.y - it.half > view.y1));
      bb = boxOf(items);
      bb = { x0: Math.max(0, bb.x0), y0: Math.max(0, bb.y0), x1: Math.min(target.width, bb.x1), y1: Math.min(target.height, bb.y1) };
      clipped = true;
    }
    const st = { bulbs, key: null, box: null, scale: 1, clipped, e: m.e, f: m.f, layers: prev ? prev.layers : [] };
    if (!(bb.x1 > bb.x0 && bb.y1 > bb.y0)) return st;
    const bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
    const scale = Math.min(1, Math.sqrt(LAYER_PIXEL_BUDGET / (bw * bh * groups)));
    const lw = Math.max(1, Math.ceil(bw * scale)), lh = Math.max(1, Math.ceil(bh * scale));
    st.box = { x: bb.x0, y: bb.y0, w: bw, h: bh };
    st.scale = scale;
    for (let gI = 0; gI < groups; gI++) {
      let c = st.layers[gI];
      if (!c) { c = makeCanvas(lw, lh); if (!c) return null; st.layers[gI] = c; }
      if (c.width !== lw || c.height !== lh) { c.width = lw; c.height = lh; }
      const lc = c.getContext('2d');
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(0, 0, lw, lh);
      lc.globalCompositeOperation = 'lighter';
      lc.setTransform(m.a * scale, 0, 0, m.d * scale, (m.e - bb.x0) * scale, (m.f - bb.y0) * scale);
    }
    st.layers.length = groups;   // free layers of a previous twinkle state
    const ctxs = st.layers.map((c) => c.getContext('2d'));
    for (const it of items) {
      const lc = ctxs[groups > 1 ? groupOf(it.b) : 0];
      lc.globalAlpha = it.a;
      lc.drawImage(it.sp.canvas, it.b.x - it.half, it.b.y - it.half, it.half * 2, it.half * 2);
    }
    return st;
  }

  /**
   * Draw bulbs as glowing lights. ctx is in image space. opts: {pxPerImagePx (device px per image px), night,
   * timeMs (null = static), twinkle, dpr, cache}.
   * By default the lights are rendered once into a cached layer per target canvas (bounded to the lit area) and
   * re-rendered only when the bulbs, the view or day/night change; with twinkle on, one layer per twinkle group is
   * composited each frame with that group's brightness. cache:false draws every sprite directly (snapshots, or a
   * transform the layer cannot represent).
   */
  function drawBulbs(ctx, bulbs, opts) {
    if (!ctx || !Array.isArray(bulbs)) return;
    const o = opts || {};
    const pxPer = pos(o.pxPerImagePx) || 1;
    const dpr = pos(o.dpr) || 1;
    const night = o.night !== false;
    const tw = !!o.twinkle && isNum(o.timeMs);
    const tSec = tw ? o.timeMs / 1000 : 0;
    const strands = arr(bulbs.strands);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (strands.length) drawStrands(ctx, strands, pxPer, dpr, night, 'stake');
    ctx.globalCompositeOperation = 'lighter';
    if (strands.length) drawStrands(ctx, strands, pxPer, dpr, night, 'glow');

    let m = null;
    if (o.cache !== false && ctx.canvas && typeof ctx.getTransform === 'function') {
      try { m = ctx.getTransform(); } catch (e) { m = null; }
      if (m && (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9 || !(m.a > 0) || !(m.d > 0))) m = null;
    }
    let st = null;
    let dx = 0, dy = 0;
    if (m) {
      const groups = tw ? TWINKLE_GROUPS : 1;
      const key = layerKey(m, ctx.canvas.width, ctx.canvas.height, pxPer, dpr, night, groups);
      st = layerStates.get(ctx.canvas) || null;
      if (st && st.bulbs === bulbs && st.key === key) {
        // Same scale: reuse the layers if the view only moved by whole device pixels (and nothing was cut off).
        dx = m.e - st.e; dy = m.f - st.f;
        const whole = Math.abs(dx - Math.round(dx)) < 1e-6 && Math.abs(dy - Math.round(dy)) < 1e-6;
        if ((dx || dy) && (st.clipped || !whole)) st = null;
      } else st = null;
      if (!st) {
        dx = 0; dy = 0;
        st = buildLayers(ctx.canvas, bulbs, m, pxPer, dpr, night, groups, layerStates.get(ctx.canvas) || null);
        if (st) { st.key = key; layerStates.set(ctx.canvas, st); }
      }
    }
    if (st) {
      if (st.box) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (let gI = 0; gI < st.layers.length; gI++) {
          ctx.globalAlpha = tw ? groupFactor(gI, tSec) : 1;
          ctx.drawImage(st.layers[gI], st.box.x + Math.round(dx), st.box.y + Math.round(dy), st.box.w, st.box.h);
        }
      }
    } else {
      for (const it of resolveSprites(bulbs, pxPer, dpr, night, visibleRect(ctx))) {
        const a = tw ? it.a * twinkleFactor(it.b, tSec) : it.a;
        if (a <= 0.01) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(it.sp.canvas, it.b.x - it.half, it.b.y - it.half, it.half * 2, it.half * 2);
      }
    }
    ctx.restore();
  }

  // ================================================================ snapshot
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Numbered tags ("1", "2", ... in plan.runs order) at each run's start, nudged apart when they collide. */
  function drawRunTags(ctx, project, plan, imageId, k, canvasW, canvasH) {
    const features = new Map(arr(project.features).filter(isObj).map((f) => [f.id, f]));
    const R = Math.max(9, Math.min(16, canvasW / 110));
    const placed = [];
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    arr(plan && plan.runs).forEach((run, i) => {
      if (!isObj(run)) return;
      const f = features.get(run.featureId);
      if (!f || (f.imageId !== imageId && run.imageId !== imageId)) return;
      const pts = cleanPts(f.points);
      const start = Array.isArray(run.start) && isNum(run.start[0]) && isNum(run.start[1]) ? run.start : (pts && pts[0]);
      if (!start) return;
      const px = start[0] * k, py = start[1] * k;
      const tries = [[0, -2.2], [2.2, -1.2], [-2.2, -1.2], [0, 2.2], [2.6, 1.2], [-2.6, 1.2], [0, -4.4], [4.4, 0], [-4.4, 0]];
      let pos2 = null;
      for (const t of tries) {
        const x = Math.max(R + 2, Math.min(canvasW - R - 2, px + t[0] * R));
        const y = Math.max(R + 2, Math.min(canvasH - R - 2, py + t[1] * R));
        if (placed.every((q) => Math.hypot(q[0] - x, q[1] - y) >= 2 * R + 3)) { pos2 = [x, y]; break; }
      }
      if (!pos2) pos2 = [Math.max(R + 2, Math.min(canvasW - R - 2, px)), Math.max(R + 2, Math.min(canvasH - R - 2, py - 2.2 * R))];
      placed.push(pos2);
      ctx.strokeStyle = 'rgba(255,191,90,0.85)';
      ctx.lineWidth = Math.max(1.2, R / 8);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(pos2[0], pos2[1]); ctx.stroke();
      ctx.fillStyle = '#ffbf5a';
      ctx.beginPath(); ctx.arc(px, py, Math.max(2, R / 5), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(13,20,32,0.92)';
      ctx.beginPath(); ctx.arc(pos2[0], pos2[1], R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffbf5a';
      ctx.lineWidth = Math.max(1.5, R / 6);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      const label = String(i + 1);
      ctx.font = '700 ' + Math.round(R * (label.length > 1 ? 0.95 : 1.15)) + 'px "Atkinson Hyperlegible", system-ui, sans-serif';
      ctx.fillText(label, pos2[0], pos2[1] + R * 0.04);
    });
    ctx.restore();
  }

  /** Photo + lights on a new canvas for reports. labels: numbered tag at each run start. */
  function renderSnapshot(opts) {
    const o = opts || {};
    const project = isObj(o.project) ? o.project : {};
    const plan = isObj(o.plan) ? o.plan : null;
    const imageId = o.imageId != null ? o.imageId : activeImageId(project);
    const rec = arr(project.images).find((i) => i && i.id === imageId) || null;
    const sz = sourceSize(o.image);
    const W = pos(rec && rec.width) || sz[0] || 1600;
    const H = pos(rec && rec.height) || sz[1] || 1200;
    const maxWidth = pos(o.maxWidth) || 1600;
    const night = o.night !== false;
    const k = Math.min(1, maxWidth / W);
    const cw = Math.max(1, Math.round(W * k)), ch = Math.max(1, Math.round(H * k));
    const canvas = makeCanvas(cw, ch);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = night ? '#0b1220' : '#2a3442';
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    drawBase(ctx, o.image || null, { night, width: W, height: H });
    const bulbs = computeBulbs(project, plan, imageId);
    drawBulbs(ctx, bulbs, { pxPerImagePx: k, night, timeMs: null, twinkle: false, dpr: Math.max(1, cw / 1200), cache: false });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (o.labels !== false) drawRunTags(ctx, project, plan, imageId, k, cw, ch);
    return canvas;
  }

  /** Drop every cache (bulb layouts and glow sprites). */
  function clearCaches() {
    memo = new WeakMap();
    nightCache = new WeakMap();
    spriteCache = new Map();
    spriteCount = 0;
  }

  return {
    computeBulbs, drawBase, drawBulbs, renderSnapshot,
    clearCaches, twinkleFactor, roundRectPath,
    BULB_RADIUS_IN, MAX_BUSH_BULBS, MIN_SPACING_PX,
  };
});
