/* LightPlan UI: viewport (SPEC §6.3).
 * The photo canvas: pan / zoom / pinch, the tap tools, hit testing, selection handles, snapping, the touch loupe,
 * the step overlays (planes, references, features, outlets, cords) and the glowing-lights preview layer.
 *
 * Coordinates: image px (stored photo) ↔ CSS px on the canvas via  screen = image · scale + (tx, ty).
 * The backing store is CSS px · devicePixelRatio. The photo and bulbs are drawn in image space; every overlay is
 * drawn in CSS px space so lines, handles and labels keep a constant on-screen size at any zoom.
 *
 * Input model (pointer events, so mouse, touch and pen behave the same):
 *  - One pointer dragging on empty space pans, in every mode. Two pointers pinch-zoom and pan together.
 *    The mouse wheel zooms at the cursor. Middle or right mouse drag also pans.
 *  - A tap is press + release with < 8 px of movement and < 500 ms. In the placing tools (rect, line, trace,
 *    outlet) a stationary press of any length also places the point: holding a finger still while reading the
 *    loupe is how people place points precisely on a phone.
 *  - A double tap zooms in 2× at the tap, except in trace mode where it finishes the polyline.
 *  - In select mode, pressing a handle of the selected item drags it: store.beginGesture(), then
 *    actions.moveVertex(target, index, point, {gesture:true}) per move, then store.endGesture('Move point').
 *
 * Snapping (ui.view.snap, the magnet button on the canvas; hold Alt with a mouse to place freely): to a vertex,
 * rectangle corner, reference end or outlet ON THE SAME SURFACE within 14 CSS px, capped at 1% of the photo's
 * long side in image px (so a zoomed-out phone never jumps to an unrelated corner); the plane's own rectangle
 * corners / line ends are left out while they are being redrawn. Else, for traced items only, to horizontal/
 * vertical within 4° in the plane's rectified coordinates (measure.imageToPlane/planeToImage), falling back to
 * image axes when the plane has no scale yet. Calibration geometry (perspective rectangles, references, eave and
 * wall-base lines) is never axis-snapped: its perspective is the information being captured. Closing a polygon
 * (tapping its first point) always works, snap or not, and passes the first point exactly.
 *
 * Double taps: in select mode a double tap zooms in. In trace mode a second tap within 8 CSS px of the first
 * finishes the run. In the rect / line / outlet tools every tap places a point (no double-tap zoom).
 * Editing points: a selected traced item shows a small + between each pair of points; tapping it inserts a point
 * (actions.insertVertex). Pressing a point picks it (ui.activeVertex) for the editor's Delete point.
 *
 * Deviations from SPEC §6.3 (documented API unchanged; additive):
 *  - Extra viewport members: canvas, getView() → {scale, tx, ty, cssW, cssH, dpr, fitScale},
 *    setView({scale, tx, ty}), zoomIn(), zoomOut(), isAnimating().
 *  - Extra keys (desktop, focus not in a field): + / - zoom, 0 fits the photo; Delete works like Backspace.
 *  - Step 5 cords (SPEC §8.5): each cord is drawn along feed.cordPath in the colour of its outlet's circuit. A cord
 *    from an outlet (home run) is a solid line starting at the outlet's marker; a jumper cord (run to run) is thinner
 *    and dashed; pieces on the ground are a little heavier than risers. A 3-way tap is a small white diamond, a run
 *    that plugs straight into its source (feed.plugIn) a ring with "plugs in". With labels on, a cord carries the
 *    length that is bought ("25 ft cord" / "6 ft jumper"). A cord label sits beside a stretch of its own cord that
 *    is on screen, or is left out: it never covers an outlet, an outlet label or another label, and never slides
 *    along the edge of the photo. Short jumpers get their label once the view is zoomed in.
 *  - Tap precision (SPEC §8.4): every point placed or dragged here is passed to the actions with its expected
 *    error in stored-image px, tapErrorPx(scale, pointerType, loupeZoom) = clamp(k / s, 2.5, 80) (k = 3 for a
 *    finger, 1.5 for a mouse or pen; s = CSS px per image px, times the loupe's 2.5 when the press was held at least
 *    300 ms, long enough to aim with the loupe: a quick tap does not get the loupe's benefit). A point snapped onto
 *    an existing vertex takes that vertex's stored value instead (none when it has none).
 *  - Module extras for tests: selectionHandles(project, sel), snapCandidates(project, imageId), layersFor(step, mode),
 *    cordLabelText(feed), cordPieces(feed), tapMarkers(power), cordLabelSpots(screenPath, w, h), clipSegment,
 *    tapErrorPx.
 */
LP.define('ui.viewport', ['geometry', 'catalog', 'measure', 'ui.preview'], function (g, catalog, measure, preview) {
  'use strict';

  // ---------------------------------------------------------------- tuning (CSS px unless noted)
  const TAP_SLOP = 8;
  const TAP_MS = 500;
  const DOUBLE_TAP_MS = 320;
  const DOUBLE_TAP_SLOP = 32;
  const FINISH_TAP_SLOP = 8;      // trace: a second tap this close to the first finishes the run
  const SNAP_MAX_FRAC = 0.01;     // vertex snap radius cap: 1% of the photo's long side (image px)
  const MID_MIN_SEG = 40;         // CSS px: segments shorter than this get no + (insert) handle
  const SNAP_PX = 14;
  const AXIS_SNAP_DEG = 4;
  const HANDLE_HIT = { touch: 22, pen: 14, mouse: 11 };
  const ITEM_HIT = { touch: 18, pen: 10, mouse: 8 };
  const HANDLE_R = 6.5;
  const LOUPE_SIZE = 110;
  const LOUPE_ZOOM = 2.5;
  const LOUPE_GAP = 34;
  const LOUPE_AIM_MS = 300;       // a press held this long was aimed with the loupe (a quick tap was not)
  const TAP_K = { touch: 3, pen: 1.5, mouse: 1.5 };   // how far off a tap lands, in CSS px (1 sigma)
  const TAP_ERR_MIN = 2.5;        // image px: the precision assumed when nothing is known (measure.js)
  const TAP_ERR_MAX = 80;
  const MAX_ZOOM = 12;          // CSS px per image px
  const FIT_MARGIN = 0.96;
  const AMBER = '#ffbf5a';
  const CIRCUIT_COLORS = ['#4f9dff', '#ff8a3d', '#2ee6a6', '#e46cff', '#ffd23f', '#ff5c7a', '#7ee0ff', '#b5f04a'];
  const CONF_COLORS = { high: '#3ddc84', medium: '#ffc53d', low: '#ff5c72' };
  const LABEL_FONT = '600 12px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const LABEL_H = 20;
  const PLACING_MODES = { rect: true, line: true, trace: true, outlet: true };
  const DRAFT_MODES = { rect: true, line: true, trace: true };

  const FT = catalog.FEATURE_TYPES;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const okPt = (p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]);
  const validPts = (pts) => arr(pts).filter(okPt);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const byId = (list, id) => arr(list).find((x) => x && x.id === id) || null;

  // ---------------------------------------------------------------- pure helpers (exported for tests)
  function activeImage(project) {
    const images = arr(project && project.images);
    return byId(images, project && project.activeImageId) || images[0] || null;
  }
  function onImage(item, imageId) { return !!item && item.imageId === imageId; }
  function planeSolution(plan, planeId) {
    const ps = plan && plan.measured && plan.measured.planes;
    const s = ps && planeId != null ? ps[planeId] : null;
    return s && s.ok && s.Hplane2img && s.Himg2plane ? s : null;
  }
  function featureClosed(f) {
    const t = FT[f.type];
    if (t && t.geometry === 'area') return true;
    return typeof f.closed === 'boolean' ? f.closed : !!(t && t.closedDefault);
  }
  function findRefPlane(project, sel) {
    const direct = byId(project.planes, sel.planeId);
    if (direct && byId(direct.refs, sel.id)) return direct;
    return arr(project.planes).find((p) => p && byId(p.refs, sel.id)) || null;
  }

  /** Stable key for a moveVertex target (used to exclude the dragged vertex from snapping). */
  function targetKey(t) {
    if (!t) return '';
    if (t.kind === 'feature' || t.kind === 'outlet') return t.kind + ':' + t.id;
    if (t.kind === 'ref') return 'ref:' + t.planeId + ':' + t.refId;
    return t.kind + ':' + t.planeId;
  }

  /** Draggable handles of the selected item: [{target, index, p}] in image px. */
  function selectionHandles(project, sel) {
    if (!project || !sel) return [];
    if (sel.kind === 'feature') {
      const f = byId(project.features, sel.id);
      if (!f) return [];
      return arr(f.points).map((p, i) => (okPt(p) ? { target: { kind: 'feature', id: f.id }, index: i, p } : null)).filter(Boolean);
    }
    if (sel.kind === 'outlet') {
      const o = byId(project.outlets, sel.id);
      return o && okPt(o.point) ? [{ target: { kind: 'outlet', id: o.id }, index: 0, p: o.point }] : [];
    }
    if (sel.kind === 'ref') {
      const pl = findRefPlane(project, sel);
      const ref = pl ? byId(pl.refs, sel.id) : null;
      if (!ref) return [];
      return arr(ref.points).map((p, i) => (okPt(p) ? { target: { kind: 'ref', planeId: pl.id, refId: ref.id }, index: i, p } : null)).filter(Boolean);
    }
    if (sel.kind === 'plane') {
      const pl = byId(project.planes, sel.id);
      if (!pl) return [];
      const out = [];
      if (pl.rect && Array.isArray(pl.rect.corners)) {
        pl.rect.corners.forEach((p, i) => { if (okPt(p)) out.push({ target: { kind: 'planeRect', planeId: pl.id }, index: i, p }); });
      }
      if (pl.derived && Array.isArray(pl.derived.line)) {
        pl.derived.line.forEach((p, i) => { if (okPt(p)) out.push({ target: { kind: 'planeLine', planeId: pl.id }, index: i, p }); });
      }
      return out;
    }
    return [];
  }

  /**
   * '+' handles between the points of a selected traced item: [{featureId, afterIndex, p}] in image px.
   * Not for items with a fixed number of points (trees, columns).
   */
  function midpointHandles(project, sel) {
    if (!project || !sel || sel.kind !== 'feature') return [];
    const f = byId(project.features, sel.id);
    if (!f) return [];
    const t = FT[f.type];
    if (t && t.maxPoints) return [];
    const pts = arr(f.points);
    if (pts.length < 2 || !pts.every(okPt)) return [];
    const closed = featureClosed(f) && pts.length > 2;
    const out = [];
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      out.push({ featureId: f.id, afterIndex: i, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
    }
    return out;
  }

  /**
   * Is this tap the second of a double tap? Select (and pan) mode: within 320 ms and 32 CSS px. Trace mode: within
   * 320 ms and 8 CSS px of the first tap (only that finishes a run; anything farther is a new point). Rect, line
   * and outlet tools: never, every tap places a point.
   */
  function isDoubleTap(last, tap, modeName) {
    if (!last || last.mode !== modeName || !(tap.t - last.t <= DOUBLE_TAP_MS)) return false;
    const d = Math.hypot(tap.x - last.x, tap.y - last.y);
    if (modeName === 'trace') return d <= FINISH_TAP_SLOP;
    if (modeName === 'select' || modeName === 'pan') return d <= DOUBLE_TAP_SLOP;
    return false;
  }

  /** The vertex snap radius in image px: SNAP_PX on screen, capped at 1% of the photo's long side. */
  function snapRadiusImg(scale, imgW, imgH) {
    const r = SNAP_PX / (scale > 0 ? scale : 1);
    const side = Math.max(imgW || 0, imgH || 0);
    return side > 0 ? Math.min(r, Math.max(3, side * SNAP_MAX_FRAC)) : r;
  }

  const candMemo = new WeakMap();
  /**
   * Every point on the photo a new or moved point can snap to: [{p, key, index, planes}]. `planes` lists the
   * surfaces the point lies on (a roof eave / ground base line lies on its plane and on the parent wall; an
   * outlet with no surface has none). Memoized per project.
   */
  function snapCandidates(project, imageId) {
    if (!isObj(project)) return [];
    const m = candMemo.get(project);
    if (m && m.imageId === imageId) return m.list;
    const list = [];
    // Each candidate carries the tap precision stored for that point (tapErr), when there is one: a point snapped
    // onto it is exactly as good as it is.
    const errAt = (holder, n, i) => {
      const t = holder && Array.isArray(holder.tapErr) && holder.tapErr.length === n ? holder.tapErr[i] : null;
      return isNum(t) && t > 0 ? t : null;
    };
    for (const f of arr(project.features)) {
      if (!onImage(f, imageId)) continue;
      const planes = f.planeId ? [f.planeId] : [];
      const n = arr(f.points).length;
      arr(f.points).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'feature:' + f.id, index: i, planes, tapErr: errAt(f, n, i) }); });
    }
    for (const pl of arr(project.planes)) {
      if (!onImage(pl, imageId)) continue;
      const own = [pl.id];
      if (pl.rect) {
        const n = arr(pl.rect.corners).length;
        arr(pl.rect.corners).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'planeRect:' + pl.id, index: i, planes: own, tapErr: errAt(pl.rect, n, i) }); });
      }
      if (pl.derived) {
        const both = pl.derived.parentPlaneId ? [pl.id, pl.derived.parentPlaneId] : own;
        const n = arr(pl.derived.line).length;
        arr(pl.derived.line).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'planeLine:' + pl.id, index: i, planes: both, tapErr: errAt(pl.derived, n, i) }); });
      }
      for (const ref of arr(pl.refs)) {
        if (!ref) continue;
        const n = arr(ref.points).length;
        arr(ref.points).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'ref:' + pl.id + ':' + ref.id, index: i, planes: own, tapErr: errAt(ref, n, i) }); });
      }
    }
    for (const o of arr(project.outlets)) {
      if (onImage(o, imageId) && okPt(o.point)) list.push({ p: o.point, key: 'outlet:' + o.id, index: 0, planes: o.planeId ? [o.planeId] : [] });
    }
    candMemo.set(project, { imageId, list });
    return list;
  }

  /** Which overlay layers a step shows (the active tool can add its own layer). */
  function layersFor(step, modeName) {
    const L = { planes: false, planesFaint: false, grid: false, refs: false, features: false, featuresFaint: false, featureLabels: false, outlets: false, power: false };
    if (step === 2) { L.planes = true; L.grid = true; L.refs = true; }
    else if (step === 3) { L.features = true; L.featureLabels = true; L.planesFaint = true; }
    else if (step === 4 || step === 6) { L.featuresFaint = true; L.featureLabels = true; }
    else if (step === 5) { L.featuresFaint = true; L.outlets = true; L.power = true; }
    if (modeName === 'trace') { L.features = true; L.featuresFaint = false; L.planesFaint = !L.planes; }
    if (modeName === 'rect' || modeName === 'line') { L.planes = true; L.refs = true; }
    if (modeName === 'outlet') L.outlets = true;
    return L;
  }

  function circuitColor(project, circuitId) {
    const i = arr(project.circuits).findIndex((c) => c && c.id === circuitId);
    return i >= 0 ? CIRCUIT_COLORS[i % CIRCUIT_COLORS.length] : '#9aa7b5';
  }

  /** Rotate/reverse a feature's points so they start at the run's power end (matches the preview's order). */
  function orientedPoints(pts, closed, start) {
    if (!okPt(start) || pts.length < 2) return pts;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = g.dist(p, start); if (d < bd) { bd = d; best = i; } });
    if (closed) return pts.slice(best).concat(pts.slice(0, best));
    return best === pts.length - 1 ? pts.slice().reverse() : pts;
  }

  /**
   * Expected error (1 sigma) of a point placed on the photo, in stored-image px (SPEC §8.4):
   * e = clamp(k / s, 2.5, 80), with s = CSS px per image px (times the loupe's magnification when the point was
   * aimed with the loupe) and k = 3 for a finger, 1.5 for a mouse or pen. At fit zoom on a phone one CSS px is
   * about 4 to 5 photo px, so a finger tap is good to about 13 px, not the 2.5 px measure.js assumes otherwise.
   */
  function tapErrorPx(scale, pointerType, loupeZoom) {
    const k = TAP_K[pointerType] || TAP_K.mouse;
    const s = (isNum(scale) && scale > 0 ? scale : 1) * (isNum(loupeZoom) && loupeZoom > 1 ? loupeZoom : 1);
    return Math.round(clamp(k / s, TAP_ERR_MIN, TAP_ERR_MAX) * 100) / 100;
  }

  /**
   * The words on a cord's photo label: the cord that is bought for it, "25 ft cord" for a cord from an outlet and
   * "6 ft jumper" for a jumper cord from one run to the next. null when the feed has no cord of its own.
   */
  function cordLabelText(feed) {
    const c = isObj(feed) ? feed.cord : null;
    if (!isObj(c)) return null;
    const ft = isNum(c.boughtFt) && c.boughtFt > 0 ? c.boughtFt : isNum(c.lengthFt) && c.lengthFt > 0 ? Math.ceil(c.lengthFt) : null;
    if (ft == null) return null;
    return Math.round(ft) + ' ft ' + (c.kind === 'jumper' ? 'jumper' : 'cord');
  }

  /**
   * The pieces a cord is drawn in: [{pts: [image points], ground: bool}]. The route's own pieces when every one
   * carries its two ends (so pieces lying on the ground can be drawn a little heavier than risers), else the whole
   * cordPath as one piece.
   */
  function cordPieces(feed) {
    const route = arr(isObj(feed) && isObj(feed.cord) ? feed.cord.route : null).filter(isObj);
    if (route.length && route.every((r) => okPt(r.from) && okPt(r.to))) {
      return route.map((r) => ({ pts: [r.from, r.to], ground: r.kind === 'ground' }));
    }
    const path = validPts(isObj(feed) ? feed.cordPath : null);
    return path.length >= 2 ? [{ pts: path, ground: false }] : [];
  }

  /**
   * Where the 3-way taps sit: [{feedId, port, point, imageId}] in image px. A tap at a run's start is where its own
   * cord meets the lights (feed.start.point); a tap at its end is where two or more jumpers leave its last string
   * (the first point of those jumpers).
   */
  function tapMarkers(power) {
    const feeds = arr(isObj(power) ? power.feeds : null).filter(isObj);
    const out = [];
    for (const f of feeds) {
      if (!(f.taps > 0)) continue;
      const kids = feeds.filter((c) => isObj(c.source) && c.source.kind === 'feed' && c.source.feedId === f.id);
      const start = isObj(f.start) ? f.start : {};
      if (kids.some((c) => c.source.port === 'start') && okPt(start.point)) {
        out.push({ feedId: f.id, port: 'start', point: start.point, imageId: start.imageId });
      }
      const atEnd = kids.filter((c) => c.source.port === 'end');
      if (atEnd.length > 1) {
        const k = atEnd.find((c) => okPt(arr(c.cordPath)[0]));
        if (k) out.push({ feedId: f.id, port: 'end', point: k.cordPath[0], imageId: isObj(k.start) ? k.start.imageId : start.imageId });
      }
    }
    return out;
  }

  /** The part of segment a-b inside the box [0, w] × [0, h] (Liang-Barsky), or null when none of it is. */
  function clipSegment(a, b, w, h) {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const tests = [[-dx, a[0]], [dx, w - a[0]], [-dy, a[1]], [dy, h - a[1]]];
    for (const [p, q] of tests) {
      if (p === 0) { if (q < 0) return null; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
  }

  /**
   * Where a cord's label may go, best first: beside the middle of each stretch of the cord that is on screen,
   * longest stretch first, on either side of it. S is the cord in CSS px. Returns {visible (px on screen), alts:
   * [{x, y, nx, ny}]}: a point on the cord and the unit direction to push the label away from it (drawLabels moves
   * the pill just clear of the cord, whatever its width). A label is only ever placed at one of these spots, so it
   * never drifts away from its cord or piles up at the edge of the photo when the cord itself is off screen.
   */
  function cordLabelSpots(S, cssW, cssH) {
    const segs = [];
    let visible = 0;
    for (let i = 0; i + 1 < S.length; i++) {
      const c = clipSegment(S[i], S[i + 1], cssW, cssH);
      if (!c) continue;
      const len = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
      if (len <= 0) continue;
      visible += len;
      segs.push({ a: c[0], b: c[1], len });
    }
    segs.sort((p, q) => q.len - p.len);
    const alts = [];
    for (const s of segs) {
      if (alts.length && s.len < 24) break;
      let nx = -(s.b[1] - s.a[1]) / s.len, ny = (s.b[0] - s.a[0]) / s.len;
      if (ny > 0 || (Math.abs(ny) < 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }   // above the cord first (to its right when it is upright)
      // The middle of the stretch first; on a long stretch also nearer to either end.
      for (const k of s.len >= 60 ? [0.5, 0.3, 0.7, 0.15, 0.85] : [0.5]) {
        const x = s.a[0] + (s.b[0] - s.a[0]) * k, y = s.a[1] + (s.b[1] - s.a[1]) * k;
        alts.push({ x, y, nx, ny }, { x, y, nx: -nx, ny: -ny });
      }
    }
    return { visible, alts };
  }

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  // ---------------------------------------------------------------- viewport
  function createViewport(opts) {
    const o = opts || {};
    const host = o.host;
    const store = o.store;
    const actions = o.actions || {};
    if (!host || !store) throw new Error('createViewport needs a host element and a store.');

    const canvas = document.createElement('canvas');
    canvas.className = 'lp-viewport-canvas';
    canvas.setAttribute('aria-label', 'Photo of the house with the light plan. Drag to move, pinch or scroll to zoom.');
    canvas.setAttribute('role', 'img');
    const cs = canvas.style;
    cs.position = 'absolute'; cs.left = '0'; cs.top = '0'; cs.width = '100%'; cs.height = '100%';
    cs.display = 'block'; cs.touchAction = 'none'; cs.userSelect = 'none'; cs.webkitUserSelect = 'none';
    cs.webkitTouchCallout = 'none'; cs.webkitTapHighlightColor = 'transparent'; cs.outline = 'none';
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const loupeCanvas = document.createElement('canvas');
    const loupeCtx = loupeCanvas.getContext('2d');

    const view = { scale: 1, tx: 0, ty: 0, cssW: 0, cssH: 0, dpr: 1, fitted: true, imageKey: null, pendingFit: true, imgW: 0, imgH: 0 };
    const pointers = new Map();     // pointerId → {x, y, type}
    let drag = null;                // {type:'pending'|'pan'|'handle'|'pinch', ...}
    let hover = null;               // {img (snapped), snap, raw} while placing, or null
    let hoverHandle = null;         // handle under the mouse (select mode)
    let loupe = null;               // {screen:[x,y], img:[x,y]}
    let lastTap = null;             // {t, x, y, mode}
    let lastPointerType = 'mouse';
    let altKey = false;
    let frame = 0;
    let zoomAnim = 0;
    let destroyed = false;
    let docVisible = typeof document.hidden === 'boolean' ? !document.hidden : true;
    let onScreen = true;
    let bgColor = '#0f1620';
    let lastProject = null;
    const textWidths = new Map();
    let lastLabels = [];            // pills drawn in the last frame: [{text, x, y, w, h, anchored}] (CSS px), for tests
    let occl = { t: -1e9, list: [] }; // boxes of the buttons and bars that float over the canvas (labels keep clear)
    let occlTimer = 0;
    const gridMemo = new WeakMap();

    // ---------------- coordinate transforms
    function imageToScreen(p) { return [p[0] * view.scale + view.tx, p[1] * view.scale + view.ty]; }
    function screenToImage(s) { return [(s[0] - view.tx) / view.scale, (s[1] - view.ty) / view.scale]; }

    function project() { try { return store.project() || null; } catch (e) { return null; } }
    function uiState() {
      let ui = null;
      try { ui = store.ui(); } catch (e) { ui = null; }
      return isObj(ui) ? ui : {};
    }
    function viewFlags(ui) {
      const v = isObj(ui.view) ? ui.view : {};
      const d = (k, def) => (typeof v[k] === 'boolean' ? v[k] : def);
      return { preview: d('preview', true), night: d('night', true), twinkle: d('twinkle', false), overlay: d('overlay', true), grid: d('grid', true), labels: d('labels', true), snap: d('snap', true) };
    }
    function modeOf(ui) { return isObj(ui.mode) && typeof ui.mode.name === 'string' ? ui.mode : { name: 'select', opts: {} }; }
    function draftPoints(ui) { return validPts(isObj(ui.draft) ? ui.draft.points : null); }
    function safePlan() { try { return store.plan() || null; } catch (e) { return null; } }

    // ---------------- sizing and fitting
    function fitScaleFor(w, h) {
      if (!(view.imgW > 0 && view.imgH > 0 && w > 0 && h > 0)) return 1;
      return Math.min(w / view.imgW, h / view.imgH);
    }
    function minScale() { return fitScaleFor(view.cssW, view.cssH) / 4; }
    function clampView() {
      if (!(view.imgW > 0)) return;
      view.scale = clamp(view.scale, minScale(), MAX_ZOOM);
      const iw = view.imgW * view.scale, ih = view.imgH * view.scale;
      const mx = Math.min(80, view.cssW * 0.25), my = Math.min(80, view.cssH * 0.25);
      view.tx = clamp(view.tx, mx - iw, view.cssW - mx);
      view.ty = clamp(view.ty, my - ih, view.cssH - my);
    }
    function fit() {
      if (!(view.cssW > 0 && view.cssH > 0) || !(view.imgW > 0 && view.imgH > 0)) { view.pendingFit = true; requestRedraw(); return; }
      const s = fitScaleFor(view.cssW, view.cssH) * FIT_MARGIN;
      view.scale = s;
      view.tx = (view.cssW - view.imgW * s) / 2;
      view.ty = (view.cssH - view.imgH * s) / 2;
      view.fitted = true;
      view.pendingFit = false;
      requestRedraw();
    }
    function syncImage() {
      const prj = project();
      const img = activeImage(prj);
      const key = img ? img.id + '|' + img.width + 'x' + img.height : null;
      view.imgW = img && img.width > 0 ? img.width : 0;
      view.imgH = img && img.height > 0 ? img.height : 0;
      if (key !== view.imageKey) {
        view.imageKey = key;
        if (key) fit();
      }
    }
    function resize() {
      const r = host.getBoundingClientRect();
      const w = Math.max(0, Math.round(r.width)), h = Math.max(0, Math.round(r.height));
      const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
      const changed = w !== view.cssW || h !== view.cssH || dpr !== view.dpr;
      if (!changed) return false;
      occl.t = -1e9;
      const oldW = view.cssW, oldH = view.cssH;
      view.cssW = w; view.cssH = h; view.dpr = dpr;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      if (w > 0 && h > 0) {
        if (view.pendingFit || view.fitted) fit();
        else if (oldW > 0 && oldH > 0) {
          // Keep the photo point at the center of the canvas where it was.
          const c = screenToImage([oldW / 2, oldH / 2]);
          view.tx = w / 2 - c[0] * view.scale;
          view.ty = h / 2 - c[1] * view.scale;
          clampView();
        }
      }
      return true;
    }

    // ---------------- zoom
    function zoomBy(factor, screenPt) {
      if (!isNum(factor) || factor <= 0 || !(view.imgW > 0)) return;
      const sp = okPt(screenPt) ? screenPt : [view.cssW / 2, view.cssH / 2];
      const ip = screenToImage(sp);
      const ns = clamp(view.scale * factor, minScale(), MAX_ZOOM);
      view.scale = ns;
      view.tx = sp[0] - ip[0] * ns;
      view.ty = sp[1] - ip[1] * ns;
      view.fitted = false;
      clampView();
      requestRedraw();
    }

    /**
     * The controls and bars the page floats over the canvas (zoom and view buttons, the hint bar, the sample note),
     * as boxes in canvas CSS px, so labels are not drawn underneath them. Read from the page at most every 300 ms.
     */
    function occluders() {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      if (now - occl.t < 300) return occl.list;
      const list = [];
      try {
        const stage = host.parentElement;
        const c = canvas.getBoundingClientRect();
        const els = stage ? stage.querySelectorAll('.canvas-controls, .hintbar, .sample-banner') : [];
        for (const el of Array.from(els)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) list.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
        }
      } catch (e) { /* no page around the canvas: nothing floats over it */ }
      occl = { t: now, list };
      return list;
    }

    // ---------------- redraw scheduling
    function animating() {
      const ui = uiState();
      const v = viewFlags(ui);
      return !destroyed && v.preview && v.twinkle && docVisible && onScreen && view.cssW > 0 && view.cssH > 0 && !!activeImage(project());
    }
    function requestRedraw() {
      if (destroyed || frame) return;
      frame = requestAnimationFrame(render);
    }

    // ---------------- snapping
    /** The plane whose rectified axes a new/moved point should align to (null → image axes). */
    function snapPlaneForDraft(ui) {
      const mode = modeOf(ui);
      const op = isObj(mode.opts) ? mode.opts : {};
      if (mode.name === 'rect' && op.purpose === 'planeRect') return null;   // that rectangle defines the plane
      return draftPlaneId(ui);
    }
    /**
     * The plane a draft is drawn on. A roof/ground plane's own line (purpose 'planeLine') lies on its parent wall,
     * like the eave or wall base that creates one ('roofEave' / 'groundBase' already pass the wall).
     */
    function draftPlaneId(ui) {
      const mode = modeOf(ui);
      const op = isObj(mode.opts) ? mode.opts : {};
      let id = op.planeId || ui.activePlaneId || null;
      if (op.purpose === 'planeLine') {
        const pl = byId(arr(project() && project().planes), id);
        if (pl && pl.derived && pl.derived.parentPlaneId) id = pl.derived.parentPlaneId;
      }
      return id;
    }

    /**
     * The tap precision to record for a point just placed or dragged: the snapped-onto point's own value (null when
     * it has none), else what this pointer manages at this zoom. heldMs is how long the press lasted: a finger held
     * down long enough to aim with the loupe gets the loupe's magnification.
     */
    function tapErrFor(snap, pointerType, heldMs) {
      if (snap && snap.kind === 'vertex') return isNum(snap.tapErr) ? snap.tapErr : null;
      const aimed = pointerType === 'touch' && heldMs >= LOUPE_AIM_MS;
      return tapErrorPx(view.scale, pointerType, aimed ? LOUPE_ZOOM : 1);
    }

    /**
     * Snap image point ip. opt: {exclude: {key, index}, excludeKeys: [key], anchors: [img pts], planeId,
     * surface: plane id whose points may be snapped to (null = any), noAxis, closeFirst: img pt|null}.
     * Returns {pt, kind: null|'vertex'|'close'|'axis', anchor?, axis?}; a vertex snap also carries tapErr, the
     * precision stored for the point snapped onto (null when it has none).
     */
    function snapPoint(ip, opt) {
      const op = opt || {};
      const r = SNAP_PX / view.scale;
      if (op.closeFirst && g.dist(ip, op.closeFirst) <= r * 1.25) return { pt: op.closeFirst.slice(), kind: 'close' };
      const ui = uiState();
      if (!viewFlags(ui).snap || altKey) return { pt: ip, kind: null };
      const prj = project();
      const img = activeImage(prj);
      const rv = snapRadiusImg(view.scale, view.imgW, view.imgH);
      let best = null;
      if (img) {
        for (const c of snapCandidates(prj, img.id)) {
          if (op.exclude && c.key === op.exclude.key && c.index === op.exclude.index) continue;
          if (op.excludeKeys && op.excludeKeys.includes(c.key)) continue;
          if (op.surface && c.planes && c.planes.length && !c.planes.includes(op.surface)) continue;
          const d = g.dist(ip, c.p);
          if (d <= rv && (!best || d < best.d)) best = { d, p: c.p, tapErr: c.tapErr };
        }
      }
      if (best) return { pt: best.p.slice(), kind: 'vertex', tapErr: isNum(best.tapErr) ? best.tapErr : null };
      if (op.noAxis) return { pt: ip, kind: null };
      const sol = planeSolution(safePlan(), op.planeId);
      let axisBest = null;
      for (const a of arr(op.anchors)) {
        if (!okPt(a)) continue;
        let cand = null;
        if (sol) {
          const A = measure.imageToPlane(sol, a), B = measure.imageToPlane(sol, ip);
          if (A && B) {
            const du = B[0] - A[0], dv = B[1] - A[1];
            if (Math.hypot(du, dv) > 1e-6) {
              const ang = Math.atan2(Math.abs(dv), Math.abs(du)) * 180 / Math.PI;
              if (ang <= AXIS_SNAP_DEG) cand = { dev: ang, pt: measure.planeToImage(sol, [B[0], A[1]]), axis: 'h' };
              else if (ang >= 90 - AXIS_SNAP_DEG) cand = { dev: 90 - ang, pt: measure.planeToImage(sol, [A[0], B[1]]), axis: 'v' };
            }
          }
        } else {
          const dx = ip[0] - a[0], dy = ip[1] - a[1];
          if (Math.hypot(dx, dy) > 1e-6) {
            const ang = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
            if (ang <= AXIS_SNAP_DEG) cand = { dev: ang, pt: [ip[0], a[1]], axis: 'h' };
            else if (ang >= 90 - AXIS_SNAP_DEG) cand = { dev: 90 - ang, pt: [a[0], ip[1]], axis: 'v' };
          }
        }
        // Only accept a snap that stays close on screen (guards against odd projections far from the plane).
        if (cand && okPt(cand.pt) && g.dist(cand.pt, ip) * view.scale <= SNAP_PX * 2 && (!axisBest || cand.dev < axisBest.dev)) {
          axisBest = Object.assign(cand, { anchor: a });
        }
      }
      if (axisBest) return { pt: axisBest.pt, kind: 'axis', anchor: axisBest.anchor, axis: axisBest.axis };
      return { pt: ip, kind: null };
    }

    /** Snap options for a new draft point. */
    function draftSnapOptions(ui) {
      const mode = modeOf(ui);
      const op = isObj(mode.opts) ? mode.opts : {};
      const pts = draftPoints(ui);
      const anchors = [];
      if (pts.length) anchors.push(pts[pts.length - 1]);
      if (mode.name === 'rect' && pts.length === 3) anchors.push(pts[0]);
      let closeFirst = null;
      let planeId = snapPlaneForDraft(ui);
      if (mode.name === 'trace') {
        const t = FT[op.type || ui.traceType];
        if (t && (t.geometry === 'polygon' || t.geometry === 'area') && pts.length >= 3) closeFirst = pts[0];
        if (t && t.geometry === 'vertical') planeId = verticalSnapPlane(planeId);
      }
      // Rectangles, references and eave / wall-base lines capture perspective: no axis snapping, and a plane's
      // own corners / line ends are not snap targets while they are being redrawn.
      const calibrating = mode.name === 'rect' || mode.name === 'line';
      const excludeKeys = [];
      if (op.purpose === 'planeRect' && op.planeId) excludeKeys.push('planeRect:' + op.planeId);
      if (op.purpose === 'planeLine' && op.planeId) excludeKeys.push('planeLine:' + op.planeId);
      return { anchors, planeId, closeFirst, noAxis: calibrating, excludeKeys, surface: draftPlaneId(ui) };
    }
    /**
     * Trees and columns stand upright. On a wall, "vertical" in the wall's coordinates is upright; on a roof or the
     * ground the plane's v axis runs up the slope or toward the street, so align them on image axes instead.
     */
    function verticalSnapPlane(planeId) {
      const pl = byId(arr(project() && project().planes), planeId);
      return pl && pl.kind === 'wall' ? planeId : null;
    }

    /**
     * Snap options while dragging handle h: exclude itself; snap to points on its own surface; traced items align
     * to their neighbors, calibration geometry (rectangles, references, eave/base lines) never axis-snaps.
     */
    function dragSnapOptions(h) {
      const prj = project();
      const t = h.target;
      const anchors = [];
      let planeId = null;
      let surface = null;
      if (t.kind === 'feature') {
        const f = byId(prj.features, t.id);
        if (f) {
          const pts = arr(f.points);
          const closed = featureClosed(f) && pts.length > 2;
          const n = pts.length;
          const prev = h.index > 0 ? h.index - 1 : (closed ? n - 1 : -1);
          const next = h.index < n - 1 ? h.index + 1 : (closed ? 0 : -1);
          if (prev >= 0 && okPt(pts[prev])) anchors.push(pts[prev]);
          if (next >= 0 && next !== prev && okPt(pts[next])) anchors.push(pts[next]);
          planeId = FT[f.type] && FT[f.type].geometry === 'vertical' ? verticalSnapPlane(f.planeId) : f.planeId;
          surface = f.planeId || null;
        }
      } else if (t.kind === 'ref') {
        const pl = byId(prj.planes, t.planeId);
        const ref = pl ? byId(pl.refs, t.refId) : null;
        if (ref) {
          const pts = arr(ref.points);
          if (pts.length === 4) neighborsInQuad(pts, h.index).forEach((p) => anchors.push(p));
          else pts.forEach((p, i) => { if (i !== h.index && okPt(p)) anchors.push(p); });
        }
        planeId = t.planeId;
        surface = t.planeId;
      } else if (t.kind === 'planeRect') {
        const pl = byId(prj.planes, t.planeId);
        if (pl && pl.rect && arr(pl.rect.corners).length === 4) neighborsInQuad(pl.rect.corners, h.index).forEach((p) => anchors.push(p));
        planeId = null;
        surface = t.planeId;
      } else if (t.kind === 'planeLine') {
        const pl = byId(prj.planes, t.planeId);
        const line = pl && pl.derived ? arr(pl.derived.line) : [];
        line.forEach((p, i) => { if (i !== h.index && okPt(p)) anchors.push(p); });
        planeId = pl && pl.derived ? pl.derived.parentPlaneId : null;   // an eave/base lies on its parent wall
        surface = planeId;
      } else if (t.kind === 'outlet') {
        const o = byId(prj.outlets, t.id);
        surface = o ? o.planeId || null : null;
      }
      const calibration = t.kind === 'planeRect' || t.kind === 'planeLine' || t.kind === 'ref';
      return { exclude: { key: targetKey(t), index: h.index }, anchors, planeId, surface, noAxis: calibration };
    }

    function neighborsInQuad(corners, index) {
      const pts = arr(corners);
      if (pts.length !== 4 || !pts.every(okPt)) return [];
      const ordered = g.orderQuad(pts);
      const me = pts[index];
      const k = ordered.findIndex((q) => q[0] === me[0] && q[1] === me[1]);
      if (k < 0) return [];
      return [ordered[(k + 3) % 4], ordered[(k + 1) % 4]];
    }

    function clampToImage(p) {
      if (!(view.imgW > 0)) return p;
      return [clamp(p[0], 0, view.imgW), clamp(p[1], 0, view.imgH)];
    }

    // ---------------- hit testing (screen space)
    function hitRadius(table, type) { return table[type] || table.mouse; }

    function hitHandle(sp, type) {
      const ui = uiState();
      if (modeOf(ui).name !== 'select' || !ui.selection) return null;
      const r = hitRadius(HANDLE_HIT, type);
      let best = null;
      for (const h of selectionHandles(project(), ui.selection)) {
        const s = imageToScreen(h.p);
        const d = Math.hypot(s[0] - sp[0], s[1] - sp[1]);
        if (d <= r && (!best || d < best.d)) best = Object.assign({ d }, h);
      }
      return best;
    }

    /** The '+' (insert point) handle of the selected item under screen point sp, or null. */
    function hitMidpoint(sp, type) {
      const ui = uiState();
      if (modeOf(ui).name !== 'select' || !ui.selection) return null;
      const r = hitRadius(HANDLE_HIT, type);
      let best = null;
      for (const m of visibleMidpoints(ui)) {
        const s = imageToScreen(m.p);
        const d = Math.hypot(s[0] - sp[0], s[1] - sp[1]);
        if (d <= r && (!best || d < best.d)) best = Object.assign({ d }, m);
      }
      return best;
    }
    /** Midpoint handles whose segment is long enough on screen not to crowd the point handles. */
    function visibleMidpoints(ui) {
      const prj = project();
      const f = ui.selection && ui.selection.kind === 'feature' ? byId(prj && prj.features, ui.selection.id) : null;
      if (!f) return [];
      const pts = arr(f.points);
      return midpointHandles(prj, ui.selection).filter((m) => {
        const a = imageToScreen(pts[m.afterIndex]), b = imageToScreen(pts[(m.afterIndex + 1) % pts.length]);
        return Math.hypot(b[0] - a[0], b[1] - a[1]) >= MID_MIN_SEG;
      });
    }

    function distToScreenPath(sp, pts, closed) {
      const S = pts.map(imageToScreen);
      if (S.length === 1) return Math.hypot(S[0][0] - sp[0], S[0][1] - sp[1]);
      let d = Infinity;
      const n = S.length;
      const segs = closed && n > 2 ? n : n - 1;
      for (let i = 0; i < segs; i++) d = Math.min(d, g.pointSegmentDistance(sp, S[i], S[(i + 1) % n]).d);
      return d;
    }

    /** What a select-mode tap at screen point sp selects (or null). Order: outlets, features, refs, planes. */
    function hitTest(sp, type) {
      const prj = project();
      const img = activeImage(prj);
      if (!prj || !img) return null;
      const ui = uiState();
      const L = layersFor(ui.step, modeOf(ui).name);
      const r = hitRadius(ITEM_HIT, type);
      const ip = screenToImage(sp);
      if (L.outlets) {
        let best = null;
        for (const o of arr(prj.outlets)) {
          if (!onImage(o, img.id) || !okPt(o.point)) continue;
          const s = imageToScreen(o.point);
          const d = Math.hypot(s[0] - sp[0], s[1] - sp[1]);
          if (d <= Math.max(r, 16) && (!best || d < best.d)) best = { d, sel: { kind: 'outlet', id: o.id, planeId: o.planeId } };
        }
        if (best) return best.sel;
      }
      if (L.features || L.featuresFaint) {
        let best = null;
        for (const f of arr(prj.features)) {
          if (!onImage(f, img.id)) continue;
          const pts = validPts(f.points);
          if (!pts.length) continue;
          const closed = featureClosed(f) && pts.length > 2;
          let d = distToScreenPath(sp, pts, closed);
          // Inside a closed outline counts as a near miss, so an edge right under the finger still wins.
          if (d > r && closed && g.pointInPolygon(ip, pts)) d = r * 0.75;
          if (d <= r && (!best || d < best.d)) best = { d, sel: { kind: 'feature', id: f.id, planeId: f.planeId } };
        }
        if (best) return best.sel;
      }
      if (L.refs) {
        let best = null;
        for (const pl of arr(prj.planes)) {
          if (!onImage(pl, img.id)) continue;
          for (const ref of arr(pl.refs)) {
            const pts = validPts(ref && ref.points);
            if (pts.length < 2) continue;
            const quad = pts.length === 4 ? g.orderQuad(pts) : pts;
            const d = distToScreenPath(sp, quad, pts.length === 4);
            if (d <= r && (!best || d < best.d)) best = { d, sel: { kind: 'ref', id: ref.id, planeId: pl.id } };
          }
        }
        if (best) return best.sel;
      }
      if (L.planes) {
        let best = null;
        for (const pl of arr(prj.planes)) {
          if (!onImage(pl, img.id)) continue;
          const corners = validPts(pl.rect && pl.rect.corners);
          if (corners.length === 4) {
            const quad = g.orderQuad(corners);
            let d = distToScreenPath(sp, quad, true);
            if (d > r && g.pointInPolygon(ip, quad)) d = r * 0.9;
            if (d <= r && (!best || d < best.d)) best = { d, sel: { kind: 'plane', id: pl.id } };
          }
          const line = validPts(pl.derived && pl.derived.line);
          if (line.length === 2) {
            const d = distToScreenPath(sp, line, false);
            if (d <= r && (!best || d < best.d)) best = { d, sel: { kind: 'plane', id: pl.id } };
          }
        }
        if (best) return best.sel;
      }
      return null;
    }

    // ---------------- pointer input
    function eventPoint(e) {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }
    function pointerKind(e) { return e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse'; }

    function updateHoverForPlacing(sp) {
      const ui = uiState();
      const mode = modeOf(ui);
      if (!PLACING_MODES[mode.name] || !(view.imgW > 0)) { hover = null; return; }
      const raw = screenToImage(sp);
      const snap = mode.name === 'outlet' ? snapPoint(raw, { anchors: [] }) : snapPoint(raw, draftSnapOptions(ui));
      hover = { raw, img: clampToImage(snap.pt), snap };
    }

    function startPinch() {
      const pts = Array.from(pointers.values()).slice(0, 2);
      if (pts.length < 2) return;
      if (drag && drag.type === 'handle') finishHandleDrag();
      const p1 = [pts[0].x, pts[0].y], p2 = [pts[1].x, pts[1].y];
      const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      drag = { type: 'pinch', d0: Math.max(10, g.dist(p1, p2)), scale0: view.scale, anchor: screenToImage(mid) };
      hover = null; loupe = null; lastTap = null;
      requestRedraw();
    }

    function finishHandleDrag() {
      if (!drag || drag.type !== 'handle') return;
      drag = null;
      loupe = null;
      try { store.endGesture('Move point'); } catch (e) { /* the store reports its own problems */ }
      requestRedraw();
    }

    function stopZoomAnimation() {
      if (zoomAnim) { cancelAnimationFrame(zoomAnim); zoomAnim = 0; }
    }

    function onPointerDown(e) {
      if (destroyed) return;
      stopZoomAnimation();   // a new touch takes over from a running double-tap zoom
      const sp = eventPoint(e);
      const type = pointerKind(e);
      lastPointerType = type;
      altKey = !!e.altKey;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture is best effort */ }
      pointers.set(e.pointerId, { x: sp[0], y: sp[1], type });
      if (pointers.size === 2) { startPinch(); return; }
      if (pointers.size > 2) return;
      // Middle / right mouse button: pan straight away.
      if (type === 'mouse' && e.button !== 0) {
        drag = { type: 'pan', start: sp, tx0: view.tx, ty0: view.ty, id: e.pointerId };
        canvas.style.cursor = 'grabbing';
        return;
      }
      const ui = uiState();
      const h = hitHandle(sp, type);
      if (h) {
        if (h.target.kind === 'feature' && typeof actions.setActiveVertex === 'function') {
          try { actions.setActiveVertex(h.target.id, h.index); } catch (err) { /* ignore */ }
        }
        try { store.beginGesture(); } catch (err) { /* ignore */ }
        const ip = screenToImage(sp);
        drag = { type: 'handle', id: e.pointerId, handle: h, grab: [h.p[0] - ip[0], h.p[1] - ip[1]], pointerType: type, opts: dragSnapOptions(h), moved: false, t0: e.timeStamp || performance.now() };
        if (type === 'touch') loupe = { screen: sp, img: h.p.slice() };
        hover = null;
        requestRedraw();
        return;
      }
      drag = { type: 'pending', id: e.pointerId, start: sp, t0: e.timeStamp || performance.now(), tx0: view.tx, ty0: view.ty, pointerType: type };
      if (PLACING_MODES[modeOf(ui).name]) {
        updateHoverForPlacing(sp);
        if (type === 'touch' && hover) loupe = { screen: sp, img: hover.img };
        requestRedraw();
      }
    }

    function onPointerMove(e) {
      if (destroyed) return;
      const sp = eventPoint(e);
      const type = pointerKind(e);
      altKey = !!e.altKey;
      const p = pointers.get(e.pointerId);
      if (p) { p.x = sp[0]; p.y = sp[1]; }
      if (!drag) {
        // Hover (mouse / pen without contact).
        if (type === 'touch') return;
        lastPointerType = type;
        const ui = uiState();
        const mode = modeOf(ui).name;
        if (PLACING_MODES[mode]) {
          updateHoverForPlacing(sp);
          canvas.style.cursor = 'crosshair';
          requestRedraw();
        } else {
          const h = mode === 'select' ? hitHandle(sp, type) : null;
          const changed = (h ? targetKey(h.target) + h.index : '') !== (hoverHandle ? targetKey(hoverHandle.target) + hoverHandle.index : '');
          hoverHandle = h;
          if (h) canvas.style.cursor = 'move';
          else if (mode === 'select' && hitTest(sp, type)) canvas.style.cursor = 'pointer';
          else canvas.style.cursor = 'grab';
          if (changed) requestRedraw();
          if (hover) { hover = null; requestRedraw(); }
        }
        return;
      }
      if (drag.type === 'pinch') {
        const pts = Array.from(pointers.values()).slice(0, 2);
        if (pts.length < 2) return;
        const p1 = [pts[0].x, pts[0].y], p2 = [pts[1].x, pts[1].y];
        const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        const ns = clamp(drag.scale0 * (g.dist(p1, p2) / drag.d0), minScale(), MAX_ZOOM);
        view.scale = ns;
        view.tx = mid[0] - drag.anchor[0] * ns;
        view.ty = mid[1] - drag.anchor[1] * ns;
        view.fitted = false;
        clampView();
        requestRedraw();
        return;
      }
      if (e.pointerId !== drag.id) return;
      if (drag.type === 'handle') {
        const ip = screenToImage(sp);
        const want = [ip[0] + drag.grab[0], ip[1] + drag.grab[1]];
        const snap = snapPoint(want, drag.opts);
        const pt = clampToImage(snap.pt);
        drag.snap = snap;
        drag.current = pt;
        drag.moved = true;
        if (drag.pointerType === 'touch') loupe = { screen: sp, img: pt };
        // The dragged point is as good as this pointer at this zoom (SPEC §8.4); actions keep the tapErr list aligned.
        const tapErr = tapErrFor(snap, drag.pointerType, (e.timeStamp || performance.now()) - drag.t0);
        try { actions.moveVertex(drag.handle.target, drag.handle.index, pt, { gesture: true, tapErr }); } catch (err) { /* actions toast their own errors */ }
        requestRedraw();
        return;
      }
      if (drag.type === 'pending') {
        if (Math.hypot(sp[0] - drag.start[0], sp[1] - drag.start[1]) > TAP_SLOP) {
          drag.type = 'pan';
          hover = null; loupe = null;
          canvas.style.cursor = 'grabbing';
        } else if (PLACING_MODES[modeOf(uiState()).name]) {
          updateHoverForPlacing(sp);
          if (drag.pointerType === 'touch' && hover) loupe = { screen: sp, img: hover.img };
          requestRedraw();
          return;
        }
      }
      if (drag.type === 'pan') {
        view.tx = drag.tx0 + (sp[0] - drag.start[0]);
        view.ty = drag.ty0 + (sp[1] - drag.start[1]);
        view.fitted = false;
        clampView();
        requestRedraw();
      }
    }

    function onPointerUp(e, cancelled) {
      if (destroyed) return;
      const sp = eventPoint(e);
      const had = pointers.has(e.pointerId);
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (!had || !drag) return;
      if (drag.type === 'pinch') {
        if (pointers.size >= 2) startPinch();   // a third finger lifted: re-anchor on the two still down
        else if (pointers.size === 1) {
          // Keep panning with the finger that stays down; it can no longer become a tap.
          const [id, p] = Array.from(pointers.entries())[0];
          drag = { type: 'pan', id, start: [p.x, p.y], tx0: view.tx, ty0: view.ty };
        } else if (pointers.size === 0) drag = null;
        return;
      }
      if (e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (d.type === 'handle') {
        drag = d;
        finishHandleDrag();
        return;
      }
      canvas.style.cursor = '';
      if (d.type === 'pending' && !cancelled) {
        const elapsed = (e.timeStamp || performance.now()) - d.t0;
        const moved = Math.hypot(sp[0] - d.start[0], sp[1] - d.start[1]);
        const placing = PLACING_MODES[modeOf(uiState()).name];
        if (moved <= TAP_SLOP && (elapsed < TAP_MS || placing)) handleTap(sp, d.pointerType, e.timeStamp || performance.now(), elapsed);
      }
      loupe = null;
      if (d.pointerType === 'touch') hover = null;
      requestRedraw();
    }

    function handleTap(sp, type, t, heldMs) {
      const ui = uiState();
      const mode = modeOf(ui);
      const draftLen = draftPoints(ui).length;
      const isDouble = isDoubleTap(lastTap, { t, x: sp[0], y: sp[1] }, mode.name);
      if (isDouble) {
        lastTap = null;
        if (mode.name === 'trace') {
          // Finish (completeDraft explains when there are too few points; the tap is never silently lost).
          if (draftLen >= 1 && typeof actions.completeDraft === 'function') actions.completeDraft();
          return;
        }
        // The first tap of the pair already did its job (placed a point or selected); the second zooms.
        animateZoom(2, sp);
        return;
      }
      lastTap = { t, x: sp[0], y: sp[1], mode: mode.name };
      if (!(view.imgW > 0)) return;
      const raw = screenToImage(sp);
      if (DRAFT_MODES[mode.name]) {
        const snap = snapPoint(raw, draftSnapOptions(ui));
        const pt = clampToImage(snap.pt);
        if (typeof actions.addDraftPoint === 'function') actions.addDraftPoint(pt, { tapErr: tapErrFor(snap, type, heldMs || 0) });
        hover = type === 'touch' ? null : { raw, img: pt, snap };
        return;
      }
      if (mode.name === 'outlet') {
        const snap = snapPoint(raw, { anchors: [] });
        if (typeof actions.addOutlet === 'function') actions.addOutlet(clampToImage(snap.pt));
        return;
      }
      if (mode.name === 'select') {
        const onHandle = hitHandle(sp, type);
        if (onHandle) return;   // tapping a handle keeps the current selection
        const mid = hitMidpoint(sp, type);
        if (mid && typeof actions.insertVertex === 'function') {
          actions.insertVertex(mid.featureId, mid.afterIndex, mid.p);
          lastTap = null;
          return;
        }
        const hit = hitTest(sp, type);
        if (typeof actions.select === 'function') actions.select(hit);
      }
    }

    function animateZoom(factor, sp) {
      stopZoomAnimation();
      const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) { zoomBy(factor, sp); return; }
      const ip = screenToImage(sp);
      const s0 = view.scale;
      const s1 = clamp(s0 * factor, minScale(), MAX_ZOOM);
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 180);
        const e = 1 - Math.pow(1 - k, 3);
        const s = s0 * Math.pow(s1 / s0, e);
        view.scale = s;
        view.tx = sp[0] - ip[0] * s;
        view.ty = sp[1] - ip[1] * s;
        view.fitted = false;
        clampView();
        requestRedraw();
        zoomAnim = k < 1 && !destroyed ? requestAnimationFrame(step) : 0;
      };
      zoomAnim = requestAnimationFrame(step);
    }

    function onWheel(e) {
      if (destroyed) return;
      e.preventDefault();
      stopZoomAnimation();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const dy = e.deltaY * unit;
      if (!dy) return;
      // ctrlKey is set for trackpad pinches, which send small deltas: zoom faster for those.
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
      zoomBy(clamp(factor, 0.5, 2), eventPoint(e));
    }

    function onPointerLeave(e) {
      if (pointerKind(e) !== 'touch' && !drag) {
        hover = null;
        hoverHandle = null;
        requestRedraw();
      }
    }

    // ---------------- keyboard
    function onKeyDown(e) {
      if (destroyed || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      const ui = uiState();
      if (ui.dialog) return;
      const key = e.key;
      const mod = e.ctrlKey || e.metaKey;
      if (key === 'Alt') { altKey = true; return; }
      if (mod && !e.altKey && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        try {
          if (e.shiftKey) { if (!store.canRedo || store.canRedo()) store.redo(); }
          else if (typeof actions.undo === 'function') actions.undo();   // a draft point first, then history
          else if (!store.canUndo || store.canUndo()) store.undo();
        } catch (err) { /* ignore */ }
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && (key === 'y' || key === 'Y')) {
        e.preventDefault();
        try { if (!store.canRedo || store.canRedo()) store.redo(); } catch (err) { /* ignore */ }
        return;
      }
      if (mod || e.altKey) return;
      const mode = modeOf(ui);
      const draftLen = draftPoints(ui).length;
      const onButton = e.target && e.target.closest && e.target.closest('button, a[href], [role="button"]');
      switch (key) {
        case 'Escape':
          if (draftLen && actions.cancelDraft) actions.cancelDraft();
          else if (ui.selection && actions.select) actions.select(null);
          else if (mode.name !== 'select' && actions.setMode) actions.setMode('select', {});
          else return;
          e.preventDefault();
          return;
        case 'Enter':
          if (onButton) return;
          if (mode.name === 'trace' && draftLen >= 2 && actions.completeDraft) { e.preventDefault(); actions.completeDraft(); }
          return;
        case 'Backspace':
        case 'Delete':
          if (draftLen && actions.removeLastDraftPoint) { e.preventDefault(); actions.removeLastDraftPoint(); }
          else if (ui.selection && actions.deleteSelection) { e.preventDefault(); actions.deleteSelection(); }
          return;
        case '+':
        case '=':
          e.preventDefault(); zoomBy(1.25); return;
        case '-':
        case '_':
          e.preventDefault(); zoomBy(0.8); return;
        case '0':
          e.preventDefault(); fit(); return;
        default:
      }
    }
    function onKeyUp(e) { if (e.key === 'Alt') altKey = false; }

    // ================================================================ drawing
    /** Canvas background around the photo: the theme's --canvas-bg, else --stage, else a dark slate. */
    function readBackground() {
      try {
        const st = getComputedStyle(host);
        const v = st.getPropertyValue('--canvas-bg').trim() || st.getPropertyValue('--stage').trim();
        if (v) bgColor = v;
      } catch (e) { /* keep the default */ }
    }

    function render(ts) {
      frame = 0;
      if (destroyed) return;
      resize();
      if (!(view.cssW > 0 && view.cssH > 0)) return;
      const prj = project();
      const ui = uiState();
      const flags = viewFlags(ui);
      const img = activeImage(prj);
      const dpr = view.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = flags.preview && flags.night ? '#04070c' : bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!img) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawCenterText('Take or upload a photo of the house to start.');
        return;
      }
      if (view.pendingFit) fit();
      const plan = safePlan();
      let source = null;
      try { source = store.getImage(img.id); } catch (e) { source = null; }

      // ---- photo + lights (image space)
      ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = view.scale < 1 ? 'high' : 'medium';
      const twinkleOn = animating();
      if (flags.preview) {
        preview.drawBase(ctx, source, { night: flags.night, width: img.width, height: img.height });
        const bulbs = preview.computeBulbs(prj, plan, img.id);
        preview.drawBulbs(ctx, bulbs, { pxPerImagePx: dpr * view.scale, night: flags.night, timeMs: twinkleOn ? ts : null, twinkle: twinkleOn, dpr });
      } else if (source) {
        try { ctx.drawImage(source, 0, 0, img.width, img.height); } catch (e) { /* undecodable image: placeholder below */ }
      } else {
        ctx.fillStyle = '#1d2633';
        ctx.fillRect(0, 0, img.width, img.height);
      }

      // ---- overlays (CSS px space)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!source) drawCenterText('Loading the photo…');
      const labels = [];
      labels.obstacles = occluders().slice();   // screen boxes labels must not cover (floating controls, outlet icons, taps)
      const mode = modeOf(ui);
      if (flags.overlay) drawOverlay(prj, plan, ui, img, flags, labels, mode);
      drawSelection(prj, plan, ui, img);
      if (DRAFT_MODES[mode.name]) drawDraft(prj, plan, ui, img, flags, labels, mode);
      else if (mode.name === 'outlet' && hover) drawOutletGhost(hover.img);
      drawSnapIndicator();
      if (loupe) captureLoupe(loupe.img);   // before the labels: the loupe shows the photo and lines, not pills
      drawLabels(labels);
      if (loupe) drawLoupe(loupe.screen);

      if (twinkleOn) requestRedraw();
    }

    function drawCenterText(text) {
      ctx.save();
      ctx.font = '500 15px "Atkinson Hyperlegible", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(232,238,244,0.78)';
      ctx.fillText(text, view.cssW / 2, view.cssH / 2);
      ctx.restore();
    }

    // ---- small drawing primitives (CSS px)
    function pathFrom(pts, closed) {
      ctx.beginPath();
      pts.forEach((p, i) => { const s = imageToScreen(p); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); });
      if (closed) ctx.closePath();
    }
    function strokeOutlined(color, width, alpha, dash) {
      ctx.save();
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (dash) ctx.setLineDash(dash);
      ctx.strokeStyle = 'rgba(4,8,14,0.55)';
      ctx.lineWidth = width + 2.5;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.restore();
    }
    function dot(s, r, fill, stroke, lw) {
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.5; ctx.stroke(); }
    }
    function fmtLen(prj, ft) {
      const f = prj && prj.settings && prj.settings.lengthFormat === 'ft-decimal' ? 'ft-decimal' : 'ft-in';
      return measure.formatLength(ft, f);
    }
    function polylineMidpoint(S) {
      const total = g.polylineLength(S, false);
      const at = g.pointAtDistance(S, total / 2);
      const i = at ? at.segIndex : 0;
      const a = S[i], b = S[Math.min(S.length - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      if (ny > 0) { nx = -nx; ny = -ny; }   // put labels above the line
      return { p: at ? at.point : a, n: [nx, ny] };
    }

    // ---- grid lines (memoized per plane solution object, i.e. per plan)
    function gridLines(sol, step) {
      let m = gridMemo.get(sol);
      if (!m) { m = new Map(); gridMemo.set(sol, m); }
      if (!m.has(step)) m.set(step, measure.planeGridLines(sol, step));
      return m.get(step);
    }
    function cssPxPerFt(sol) {
      const e = sol.gridExtent || sol.extent;
      const c = e ? [(e.minU + e.maxU) / 2, (e.minV + e.maxV) / 2] : [0, 0];
      const ls = g.localScale(sol.Hplane2img, c);
      return ls && ls.scale > 0 ? ls.scale * view.scale : 0;
    }
    function extentPolygon(sol) {
      const e = sol.gridExtent || sol.extent;
      if (!e) return null;
      const H = sol.Hplane2img;
      const corners = [[e.minU, e.minV], [e.maxU, e.minV], [e.maxU, e.maxV], [e.minU, e.maxV]];
      const w = (uv) => H[6] * uv[0] + H[7] * uv[1] + H[8];
      const sign = Math.sign(w([(e.minU + e.maxU) / 2, (e.minV + e.maxV) / 2])) || 1;
      if (corners.some((c) => w(c) * sign <= 1e-9)) return null;
      const out = corners.map((c) => g.applyH(H, c));
      return out.every(Boolean) ? out : null;
    }

    function drawSegments(lines, color, width, alpha) {
      if (!lines.length) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const seg of lines) {
        const a = imageToScreen(seg[0]), b = imageToScreen(seg[1]);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- overlay by step
    function drawOverlay(prj, plan, ui, img, flags, labels, mode) {
      const L = layersFor(ui.step, mode.name);
      if (L.planes || L.planesFaint) drawPlanes(prj, plan, ui, img, flags, labels, L);
      if (L.refs) drawRefs(prj, plan, img, flags, labels);
      if (L.features || L.featuresFaint) drawFeatures(prj, plan, ui, img, flags, labels, L);
      if (L.power) drawPower(prj, plan, img, flags, labels);
      if (L.outlets) drawOutlets(prj, plan, img, flags, labels);
    }

    function drawPlanes(prj, plan, ui, img, flags, labels, L) {
      const faint = !L.planes;
      for (const pl of arr(prj.planes)) {
        if (!onImage(pl, img.id)) continue;
        const color = typeof pl.color === 'string' && pl.color ? pl.color : '#4f9dff';
        const sol = planeSolution(plan, pl.id);
        const active = pl.id === ui.activePlaneId;
        if (!faint && sol && flags.grid) {
          if (pl.kind !== 'wall') {
            const poly = extentPolygon(sol);
            if (poly) {
              pathFrom(poly, true);
              ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.restore();
            }
          }
          const pf = cssPxPerFt(sol);
          if (pf * 1 >= 9) drawSegments(gridLines(sol, 1), color, 0.75, 0.2);
          const major = pf * 5 >= 9 ? 5 : 10;
          drawSegments(gridLines(sol, major), color, 1, pl.kind === 'wall' ? 0.42 : 0.5);
        }
        const corners = validPts(pl.rect && pl.rect.corners);
        let labelAt = null;
        if (corners.length === 4) {
          const quad = g.orderQuad(corners);
          pathFrom(quad, true);
          strokeOutlined(color, active ? 2.5 : 1.75, faint ? 0.4 : 1);
          labelAt = imageToScreen(quad[0]);
          labelAt = [labelAt[0], labelAt[1] - 16];
        } else if (corners.length > 1) {
          pathFrom(corners, false);
          strokeOutlined(color, 1.5, faint ? 0.4 : 0.9, [4, 4]);
        }
        const line = validPts(pl.derived && pl.derived.line);
        if (line.length === 2) {
          pathFrom(line, false);
          strokeOutlined(color, active ? 3.5 : 3, faint ? 0.45 : 1);
          const m = polylineMidpoint(line.map(imageToScreen));
          labelAt = [m.p[0] + m.n[0] * 16, m.p[1] + m.n[1] * 16];
        }
        if (!faint && flags.labels && labelAt) {
          const name = typeof pl.name === 'string' && pl.name.trim() ? pl.name.trim() : (pl.kind === 'roof' ? 'Roof' : pl.kind === 'ground' ? 'Ground' : 'Wall');
          const raw = plan && plan.measured && plan.measured.planes ? plan.measured.planes[pl.id] : null;
          const text = raw && !raw.ok ? name + ' · no scale yet' : name;
          labels.push({ text, x: labelAt[0], y: labelAt[1], swatch: color, priority: active ? 3 : 2 });
        }
      }
    }

    function drawRefs(prj, plan, img, flags, labels) {
      const warnPct = 5;
      for (const pl of arr(prj.planes)) {
        if (!onImage(pl, img.id)) continue;
        const raw = plan && plan.measured && plan.measured.planes ? plan.measured.planes[pl.id] : null;
        const results = raw && Array.isArray(raw.refResults) ? raw.refResults : [];
        for (const ref of arr(pl.refs)) {
          const pts = validPts(ref && ref.points);
          if (pts.length < 2) continue;
          const isRect = ref.kind === 'rect' && pts.length === 4;
          const shape = isRect ? g.orderQuad(pts) : [pts[0], pts[pts.length - 1]];
          pathFrom(shape, isRect);
          strokeOutlined('#f4f7fb', 2, 0.95, [7, 5]);
          if (!isRect) {
            // End ticks make the measured span obvious.
            const a = imageToScreen(shape[0]), b = imageToScreen(shape[1]);
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            const nx = -(b[1] - a[1]) / len * 7, ny = (b[0] - a[0]) / len * 7;
            ctx.beginPath();
            ctx.moveTo(a[0] - nx, a[1] - ny); ctx.lineTo(a[0] + nx, a[1] + ny);
            ctx.moveTo(b[0] - nx, b[1] - ny); ctx.lineTo(b[0] + nx, b[1] + ny);
            strokeOutlined('#f4f7fb', 2, 0.95);
          }
          if (!flags.labels) continue;
          const mine = results.filter((r) => r && r.refId === ref.id);
          let text;
          let worst = null;
          if (mine.length) {
            const exp = mine.map((r) => fmtLen(prj, r.expectedFt)).join(' × ');
            const got = mine.map((r) => (isNum(r.measuredFt) ? fmtLen(prj, r.measuredFt) : '—')).join(' × ');
            text = exp + ' / ' + got;
            mine.forEach((r) => { if (isNum(r.errorPct)) worst = Math.max(worst || 0, Math.abs(r.errorPct)); });
          } else {
            const exp = isRect ? fmtLen(prj, ref.widthFt) + ' × ' + fmtLen(prj, ref.heightFt) : fmtLen(prj, ref.lengthFt);
            text = exp + ' / —';
          }
          const S = shape.map(imageToScreen);
          let at;
          if (isRect) at = g.centroid(S);
          else { const m = polylineMidpoint(S); at = [m.p[0] + m.n[0] * 15, m.p[1] + m.n[1] * 15]; }
          const dotColor = worst == null ? null : worst <= 3 ? CONF_COLORS.high : worst <= warnPct ? CONF_COLORS.medium : CONF_COLORS.low;
          labels.push({ text, x: at[0], y: at[1], dot: dotColor, priority: 2 });
        }
      }
    }

    function featureLabelText(prj, f, m) {
      if (!m || !m.ok) return 'No scale yet';
      const t = FT[f.type];
      if (t && t.geometry === 'area') return isNum(m.widthFt) && isNum(m.heightFt) ? fmtLen(prj, m.widthFt) + ' × ' + fmtLen(prj, m.heightFt) : 'No scale yet';
      if (t && t.geometry === 'vertical') return fmtLen(prj, m.heightFt) + ' tall';
      return fmtLen(prj, m.lengthFt);
    }

    function drawFeatures(prj, plan, ui, img, flags, labels, L) {
      const faint = !L.features;
      const meas = plan && plan.measured && isObj(plan.measured.features) ? plan.measured.features : {};
      const sel = ui.selection;
      for (const f of arr(prj.features)) {
        if (!onImage(f, img.id)) continue;
        const pts = validPts(f.points);
        if (pts.length < 1) continue;
        const t = FT[f.type];
        const color = (t && t.color) || '#ffffff';
        const closed = featureClosed(f) && pts.length > 2;
        const isSel = sel && sel.kind === 'feature' && sel.id === f.id;
        if (pts.length >= 2) {
          pathFrom(pts, closed);
          if (t && t.geometry === 'area' && !faint) {
            ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = color; ctx.fill(); ctx.restore();
          }
          if (!isSel) strokeOutlined(color, faint ? 2 : 3, faint ? 0.45 : 1);
          if (t && t.geometry === 'vertical' && !faint) {
            const b = imageToScreen(pts[0]), top = imageToScreen(pts[pts.length - 1]);
            dot(b, 3.5, color, 'rgba(4,8,14,0.6)', 1.5);
            dot(top, 3.5, color, 'rgba(4,8,14,0.6)', 1.5);
          }
        }
        if (!flags.labels || !L.featureLabels) continue;
        const m = meas[f.id];
        const S = pts.map(imageToScreen);
        let at;
        if (closed) at = g.centroid(S);
        else if (S.length === 1) at = [S[0][0], S[0][1] - 16];
        else if (t && t.geometry === 'vertical') { const mid = g.lerp(S[0], S[S.length - 1], 0.5); at = [mid[0] + 14, mid[1]]; }
        else { const mp = polylineMidpoint(S); at = [mp.p[0] + mp.n[0] * 15, mp.p[1] + mp.n[1] * 15]; }
        const conf = m && m.ok && m.confidence ? CONF_COLORS[m.confidence.level] || null : (m ? CONF_COLORS.low : null);
        // On a small screen, short items lose their label first so the long runs stay readable; longer runs win
        // label collisions over shorter ones.
        let span = 0;
        if (S.length >= 2) {
          const b = g.bbox(S);
          span = closed ? Math.hypot(b.maxX - b.minX, b.maxY - b.minY) : S.reduce((acc, q, i) => (i ? acc + Math.hypot(q[0] - S[i - 1][0], q[1] - S[i - 1][1]) : 0), 0);
        }
        if (!isSel && view.cssW < 600 && span < 44) continue;
        labels.push({ text: featureLabelText(prj, f, m), x: at[0], y: at[1], dot: conf, priority: isSel ? 4 : 1 + Math.min(2, span / 300), faint });
      }
    }

    function drawPower(prj, plan, img, flags, labels) {
      if (!plan) return;
      const power = isObj(plan.power) ? plan.power : {};
      const outletsById = new Map(arr(prj.outlets).filter(isObj).map((x) => [x.id, x]));
      const onPhoto = (feed) => {
        const start = isObj(feed.start) ? feed.start : {};
        const outlet = outletsById.get(feed.outletId);
        return start.imageId === img.id || !!(outlet && onImage(outlet, img.id));
      };
      // Cords, in the colour of their outlet's circuit. A cord from an outlet is a solid line; a jumper cord (run to
      // run) is thinner and dashed. The pieces lying on the ground are drawn a little heavier than the risers.
      const plugIns = [];
      for (const feed of arr(power.feeds)) {
        if (!isObj(feed) || !onPhoto(feed)) continue;
        const color = circuitColor(prj, feed.circuitId);
        if (feed.plugIn === true) {
          const sp = isObj(feed.start) ? feed.start.point : null;
          if (okPt(sp)) plugIns.push({ p: sp, color });
          continue;
        }
        const pieces = cordPieces(feed);
        if (!pieces.length) continue;
        const jumper = isObj(feed.cord) && feed.cord.kind === 'jumper';
        for (const piece of pieces) {
          pathFrom(piece.pts, false);
          if (jumper) strokeOutlined(color, piece.ground ? 2 : 1.6, 0.95, [6, 4]);
          else strokeOutlined(color, piece.ground ? 3.4 : 2.6, 0.97);
        }
        const text = flags.labels ? cordLabelText(feed) : null;
        if (!text) continue;
        const S = validPts(feed.cordPath).map(imageToScreen);
        const spots = cordLabelSpots(S, view.cssW, view.cssH);
        // Short jumpers stay unlabelled until the view is zoomed in far enough to tell them apart.
        if (spots.visible < (jumper ? 56 : 24) || !spots.alts.length) continue;
        const alts = spots.alts.slice();
        if (!jumper && S.length) {
          // A cord from an outlet may also sit right beside the outlet's marker (short cords have no room of their own).
          const o = S[0];
          if (o[0] >= 0 && o[0] <= view.cssW && o[1] >= 0 && o[1] <= view.cssH) {
            alts.push({ x: o[0], y: o[1], nx: 1, ny: 0, gap: 17 }, { x: o[0], y: o[1], nx: -1, ny: 0, gap: 17 }, { x: o[0], y: o[1], nx: 0, ny: -1, gap: 18 });
          }
        }
        const ft = isNum(feed.cord.lengthFt) ? feed.cord.lengthFt : 0;
        labels.push({ text, alts, swatch: color, priority: jumper ? 0.4 + Math.min(0.5, ft / 100) : 1.5, dashed: jumper });
      }
      // Run start arrows: where each run is plugged in, pointing the way the lights run.
      const features = new Map(arr(prj.features).filter(isObj).map((f) => [f.id, f]));
      for (const run of arr(plan.runs)) {
        if (!isObj(run) || !okPt(run.start)) continue;
        const f = features.get(run.featureId);
        if (!f || !onImage(f, img.id)) continue;
        const pts = validPts(f.points);
        if (pts.length < 2) continue;
        const closed = featureClosed(f) && pts.length > 2;
        const op = orientedPoints(pts, closed, run.start);
        const a = imageToScreen(run.start);
        let next = null;
        for (let i = 1; i < op.length && !next; i++) {
          const b = imageToScreen(op[i]);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 2) next = b;
        }
        if (!next) continue;
        drawArrow(a, next, circuitColor(prj, run.circuitId));
      }
      // A run that plugs straight into the one before it (no cord of its own): a ring around its first plug.
      for (const pi of plugIns) {
        const s = imageToScreen(pi.p);
        dot(s, 9, null, 'rgba(4,8,14,0.6)', 4.5);
        dot(s, 9, null, '#ffffff', 2);
        // The label has only these four spots, so it is placed before the cord labels (which can slide along their
        // cords); with none of them free it is left out and the ring stands alone.
        if (flags.labels) {
          const spots = [[0, -1], [0, 1], [1, 0], [-1, 0]].map((n) => ({ x: s[0], y: s[1], nx: n[0], ny: n[1] }));
          labels.push({ text: 'plugs in', alts: spots, gap: 12, swatch: pi.color, priority: 1.2 });
        }
      }
      // 3-way taps: a small diamond where one plug becomes three.
      for (const tap of tapMarkers(power)) {
        if (tap.imageId != null && tap.imageId !== img.id) continue;
        const feed = byId(power.feeds, tap.feedId);
        const s = imageToScreen(tap.point);
        const r = drawTap(s, circuitColor(prj, feed ? feed.circuitId : null));
        labels.obstacles.push({ x: s[0] - r, y: s[1] - r, w: 2 * r, h: 2 * r });
      }
    }

    function drawTap(s, color) {
      const r = clamp(view.scale * 14, 4.5, 6.5);   // a little smaller when the whole house is on a phone screen
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(s[0], s[1] - r); ctx.lineTo(s[0] + r, s[1]); ctx.lineTo(s[0], s[1] + r); ctx.lineTo(s[0] - r, s[1]);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(4,8,14,0.75)';
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      return r;
    }

    function drawArrow(a, toward, color) {
      const dx = toward[0] - a[0], dy = toward[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const L = Math.min(16, len * 0.8);
      const tip = [a[0] + ux * L, a[1] + uy * L];
      ctx.save();
      dot(a, 4.5, color, 'rgba(4,8,14,0.75)', 1.5);
      ctx.beginPath();
      ctx.moveTo(tip[0] + ux * 4, tip[1] + uy * 4);
      ctx.lineTo(tip[0] - ux * 6 - uy * 5.5, tip[1] - uy * 6 + ux * 5.5);
      ctx.lineTo(tip[0] - ux * 6 + uy * 5.5, tip[1] - uy * 6 - ux * 5.5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(4,8,14,0.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }

    function outletIcon(s, color, selected) {
      const w = 22, h = 24;
      ctx.save();
      preview.roundRectPath(ctx, s[0] - w / 2, s[1] - h / 2, w, h, 6);
      ctx.fillStyle = 'rgba(14,20,30,0.92)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = '#f4f7fb';
      ctx.fillRect(s[0] - 5.5, s[1] - 6, 2.4, 6);
      ctx.fillRect(s[0] + 3.1, s[1] - 6, 2.4, 6);
      ctx.beginPath();
      ctx.arc(s[0], s[1] + 5, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function drawOutlets(prj, plan, img, flags, labels) {
      const sel = uiState().selection;
      for (const o of arr(prj.outlets)) {
        if (!onImage(o, img.id) || !okPt(o.point)) continue;
        const s = imageToScreen(o.point);
        const color = circuitColor(prj, o.circuitId);
        const isSel = sel && sel.kind === 'outlet' && sel.id === o.id;
        outletIcon(s, color, isSel);
        labels.obstacles.push({ x: s[0] - 13, y: s[1] - 14, w: 26, h: 28 });
        // An outlet that is off the edge of the view gets no label: clamped to the edge, its name would sit beside
        // something else.
        const inView = s[0] >= -11 && s[0] <= view.cssW + 11 && s[1] >= -12 && s[1] <= view.cssH + 12;
        if (flags.labels && (inView || isSel)) {
          const text = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : 'Outlet';
          labels.push({ text, x: s[0], y: s[1] + 24, swatch: color, priority: isSel ? 4 : 2 });
        }
      }
    }

    function drawOutletGhost(p) {
      const s = imageToScreen(p);
      ctx.save();
      ctx.globalAlpha = 0.8;
      outletIcon(s, AMBER, false);
      ctx.restore();
    }

    // ---- selection highlight + handles
    function drawSelection(prj, plan, ui, img) {
      const sel = ui.selection;
      if (!prj || !sel) return;
      let shape = null, closed = false, color = '#ffffff';
      if (sel.kind === 'feature') {
        const f = byId(prj.features, sel.id);
        if (!f || !onImage(f, img.id)) return;
        shape = validPts(f.points);
        closed = featureClosed(f) && shape.length > 2;
        color = (FT[f.type] && FT[f.type].color) || '#ffffff';
      } else if (sel.kind === 'ref') {
        const pl = findRefPlane(prj, sel);
        const ref = pl ? byId(pl.refs, sel.id) : null;
        if (!ref || !onImage(pl, img.id)) return;
        const pts = validPts(ref.points);
        closed = pts.length === 4;
        shape = closed ? g.orderQuad(pts) : pts;
        color = '#f4f7fb';
      } else if (sel.kind === 'plane') {
        const pl = byId(prj.planes, sel.id);
        if (!pl || !onImage(pl, img.id)) return;
        const corners = validPts(pl.rect && pl.rect.corners);
        if (corners.length === 4) { shape = g.orderQuad(corners); closed = true; }
        else shape = validPts(pl.derived && pl.derived.line);
        color = pl.color || '#4f9dff';
      } else if (sel.kind === 'outlet') {
        const ol = byId(prj.outlets, sel.id);
        if (!ol || !onImage(ol, img.id) || !okPt(ol.point)) return;
        const s = imageToScreen(ol.point);
        dot(s, 19, null, 'rgba(255,255,255,0.9)', 2);
      }
      if (shape && shape.length >= 2) {
        pathFrom(shape, closed);
        ctx.save();
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 9; ctx.stroke();
        ctx.restore();
        strokeOutlined(color, 3.5, 1);
      }
      const active = drag && drag.type === 'handle' ? drag.handle : null;
      for (const h of selectionHandles(prj, sel)) {
        const s = imageToScreen(h.p);
        const isActive = active && targetKey(active.target) === targetKey(h.target) && active.index === h.index;
        const isHover = hoverHandle && targetKey(hoverHandle.target) === targetKey(h.target) && hoverHandle.index === h.index;
        const r = HANDLE_R + (lastPointerType === 'touch' ? 2 : 0) + (isActive || isHover ? 2 : 0);
        if (isActive) {
          // While dragging, a hollow ring keeps the photo under the point visible (and in the loupe).
          dot(s, r + 2, null, 'rgba(4,8,14,0.6)', 4);
          dot(s, r + 2, null, '#ffffff', 2);
          continue;
        }
        dot(s, r + 1.5, 'rgba(4,8,14,0.55)');
        dot(s, r, '#ffffff', color, 2.5);
      }
      if (!active) {
        // '+' between points: tap to insert a point there.
        for (const m of visibleMidpoints(ui)) {
          const s = imageToScreen(m.p);
          dot(s, 7.5, 'rgba(4,8,14,0.7)', color, 1.5);
          ctx.save();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(s[0] - 3.5, s[1]); ctx.lineTo(s[0] + 3.5, s[1]);
          ctx.moveTo(s[0], s[1] - 3.5); ctx.lineTo(s[0], s[1] + 3.5);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // ---- draft (points being placed)
    function drawDraft(prj, plan, ui, img, flags, labels, mode) {
      const pts = draftPoints(ui);
      const op = isObj(mode.opts) ? mode.opts : {};
      const typeId = mode.name === 'trace' ? (op.type || ui.traceType) : null;
      const t = typeId ? FT[typeId] : null;
      const color = t ? t.color : AMBER;
      const h = hover ? hover.img : null;
      const closable = !!t && (t.geometry === 'polygon' || t.geometry === 'area') && pts.length >= 3;
      if (pts.length >= 2) {
        pathFrom(pts, false);
        strokeOutlined(color, 3, 1);
      }
      if (h && pts.length) {
        const chain = [pts[pts.length - 1], h];
        if (mode.name === 'rect' && pts.length === 3) chain.push(pts[0]);
        pathFrom(chain, false);
        strokeOutlined(color, 2, 0.9, [6, 5]);
      }
      pts.forEach((p, i) => {
        const s = imageToScreen(p);
        if (i === 0 && closable) dot(s, 9, null, '#ffffff', 2);
        dot(s, 5, color, 'rgba(4,8,14,0.8)', 1.5);
      });
      if (h) {
        const s = imageToScreen(h);
        dot(s, 4, '#ffffff', 'rgba(4,8,14,0.8)', 1.5);
      }
      // Live length while placing.
      if (!flags.labels || !h || !pts.length) return;
      if (mode.name === 'rect' && op.purpose === 'planeRect') return;   // this rectangle sets the scale itself
      const planeId = draftPlaneId(ui);
      const sol = planeSolution(plan, planeId);
      if (!sol) return;
      const plane = byId(prj.planes, planeId);
      let text = null;
      if (mode.name === 'rect') {
        const m = measure.measurePoints([pts[pts.length - 1], h], false, sol);
        if (isNum(m.lengthFt)) text = fmtLen(prj, m.lengthFt);
      } else if (t && t.geometry === 'area') {
        text = null;
      } else if (t && t.geometry === 'vertical') {
        if (plane && plane.kind === 'wall') {
          const m = measure.measurePoints([pts[0], h], false, sol);
          if (isNum(m.lengthFt)) text = fmtLen(prj, m.lengthFt) + ' tall';
        }
      } else {
        const m = measure.measurePoints(pts.concat([h]), false, sol);
        if (isNum(m.lengthFt)) text = fmtLen(prj, m.lengthFt);
      }
      if (text) {
        const s = imageToScreen(h);
        labels.push({ text, x: s[0] + 0, y: s[1] - 26, priority: 5, dot: null, swatch: color });
      }
    }

    function drawSnapIndicator() {
      const snap = drag && drag.type === 'handle' ? drag.snap : (hover ? hover.snap : null);
      const at = drag && drag.type === 'handle' ? drag.current : (hover ? hover.img : null);
      if (!snap || !snap.kind || !at) return;
      const s = imageToScreen(at);
      ctx.save();
      if (snap.kind === 'vertex' || snap.kind === 'close') {
        dot(s, 11, null, 'rgba(4,8,14,0.6)', 4);
        dot(s, 11, null, snap.kind === 'close' ? '#3ddc84' : '#7ee0ff', 2);
      } else if (snap.kind === 'axis' && okPt(snap.anchor)) {
        const a = imageToScreen(snap.anchor);
        const dx = s[0] - a[0], dy = s[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        const ext = 40;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(s[0] + (dx / len) * ext, s[1] + (dy / len) * ext);
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(126,224,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.translate(s[0], s[1]);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#7ee0ff';
        ctx.strokeStyle = 'rgba(4,8,14,0.7)';
        ctx.lineWidth = 1.5;
        ctx.fillRect(-4, -4, 8, 8);
        ctx.strokeRect(-4, -4, 8, 8);
      }
      ctx.restore();
    }

    // ---- labels: pills in a mono font, placed greedily so they never pile up
    function textWidth(text) {
      let w = textWidths.get(text);
      if (w === undefined) {
        w = ctx.measureText(text).width;
        if (textWidths.size > 2000) textWidths.clear();
        textWidths.set(text, w);
      }
      return w;
    }
    function drawLabels(list) {
      lastLabels = [];
      if (!list.length) return;
      ctx.save();
      ctx.font = LABEL_FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const placed = arr(list.obstacles).slice();
      const sorted = list.slice().sort((a, b) => b.priority - a.priority);
      for (const l of sorted) {
        const extra = l.dot || l.swatch ? 13 : 0;
        const w = Math.ceil(textWidth(l.text)) + 14 + extra;
        const h = LABEL_H;
        const free = (b) => !placed.some((q) => b.x < q.x + q.w + 3 && q.x < b.x + b.w + 3 && b.y < q.y + q.h + 2 && q.y < b.y + b.h + 2);
        let box = null;
        if (Array.isArray(l.alts)) {
          // Anchored labels (cords): only at one of their own spots, wholly on the canvas, or not at all.
          const gap = isNum(l.gap) ? l.gap : 5;
          for (const a of l.alts) {
            const t = Math.abs(a.nx) * w / 2 + Math.abs(a.ny) * h / 2 + (isNum(a.gap) ? a.gap : gap);
            const b = { x: a.x + a.nx * t - w / 2, y: a.y + a.ny * t - h / 2, w, h };
            if (b.x < 2 || b.y < 2 || b.x + w > view.cssW - 2 || b.y + h > view.cssH - 2) continue;
            if (free(b)) { box = b; break; }
          }
          if (!box) continue;
        } else {
          const tries = [[0, 0], [0, -h - 3], [0, h + 3], [w * 0.6, 0], [-w * 0.6, 0], [0, -2 * h - 6], [0, 2 * h + 6]];
          for (const t of tries) {
            const x = clamp(l.x + t[0] - w / 2, 2, view.cssW - w - 2);
            const y = clamp(l.y + t[1] - h / 2, 2, view.cssH - h - 2);
            const b = { x, y, w, h };
            if (free(b)) { box = b; break; }
          }
          if (!box) {
            if (l.priority < 4) continue;
            box = { x: clamp(l.x - w / 2, 2, view.cssW - w - 2), y: clamp(l.y - h / 2, 2, view.cssH - h - 2), w, h };
          }
        }
        placed.push(box);
        lastLabels.push({ text: l.text, x: box.x, y: box.y, w: box.w, h: box.h, anchored: Array.isArray(l.alts) });
        ctx.globalAlpha = l.faint ? 0.82 : 1;
        preview.roundRectPath(ctx, box.x, box.y, box.w, box.h, h / 2);
        ctx.fillStyle = 'rgba(9,14,22,0.86)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
        let tx = box.x + 7;
        if (l.dot || l.swatch) {
          // A jumper cord's label carries a ring, a cord from an outlet a filled dot (like their lines: dashed, solid).
          if (l.dashed) dot([box.x + 11, box.y + h / 2], 3.2, null, l.swatch, 1.8);
          else dot([box.x + 11, box.y + h / 2], l.dot ? 4 : 3.5, l.dot || l.swatch, l.dot ? null : 'rgba(255,255,255,0.4)', 1);
          tx += extra;
        }
        ctx.fillStyle = '#eef3f8';
        ctx.fillText(l.text, tx, box.y + h / 2 + 0.5);
      }
      ctx.restore();
    }

    // ---- touch loupe: 2.5× of the canvas around the true point, drawn above the finger
    /** Copy the canvas around image point ip, magnified, into the loupe buffer. */
    function captureLoupe(ip) {
      const D = LOUPE_SIZE;
      const dpr = view.dpr;
      const devSize = Math.round(D * dpr);
      if (loupeCanvas.width !== devSize) { loupeCanvas.width = devSize; loupeCanvas.height = devSize; }
      const src = imageToScreen(ip);
      const half = D / LOUPE_ZOOM / 2;                  // CSS px of source on each side of the point
      loupeCtx.setTransform(1, 0, 0, 1, 0, 0);
      loupeCtx.fillStyle = '#05080e';
      loupeCtx.fillRect(0, 0, devSize, devSize);
      // Copy only the part of the source square that lies on the canvas (no out-of-bounds reads).
      const sx0 = (src[0] - half) * dpr, sy0 = (src[1] - half) * dpr, sw = 2 * half * dpr;
      const ix0 = Math.max(0, sx0), iy0 = Math.max(0, sy0);
      const ix1 = Math.min(canvas.width, sx0 + sw), iy1 = Math.min(canvas.height, sy0 + sw);
      if (ix1 > ix0 && iy1 > iy0) {
        const k = devSize / sw;
        loupeCtx.imageSmoothingEnabled = true;
        loupeCtx.drawImage(canvas, ix0, iy0, ix1 - ix0, iy1 - iy0, (ix0 - sx0) * k, (iy0 - sy0) * k, (ix1 - ix0) * k, (iy1 - iy0) * k);
      }
    }
    /** Draw the loupe buffer in a circle above the finger (below it near the top edge), with a crosshair. */
    function drawLoupe(finger) {
      const D = LOUPE_SIZE, R = D / 2;
      const cx = clamp(finger[0], R + 6, view.cssW - R - 6);
      let cy = finger[1] - R - LOUPE_GAP;
      if (cy - R < 6) cy = finger[1] + R + LOUPE_GAP;   // no room above: show it below the finger
      cy = clamp(cy, R + 6, Math.max(R + 6, view.cssH - R - 6));
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.save();
      ctx.clip();
      ctx.drawImage(loupeCanvas, cx - R, cy - R, D, D);
      // Crosshair with a gap so the exact point stays visible.
      ctx.strokeStyle = 'rgba(4,8,14,0.8)';
      ctx.lineWidth = 3;
      crosshair(cx, cy, R);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.25;
      crosshair(cx, cy, R);
      ctx.restore();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }
    function crosshair(cx, cy, R) {
      const gap = 5;
      ctx.beginPath();
      ctx.moveTo(cx - R, cy); ctx.lineTo(cx - gap, cy);
      ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy - gap);
      ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + R);
      ctx.stroke();
    }

    // ================================================================ wiring
    const unsubscribe = store.subscribe(function (info) {
      if (destroyed) return;
      const prj = project();
      if (prj !== lastProject) { lastProject = prj; syncImage(); }
      else if (info && info.imageChanged) syncImage();
      if (info && info.uiChanged) {
        // A bar over the canvas may have appeared or gone. The page updates its bars a frame later than this, so
        // look again shortly after.
        occl.t = -1e9;
        if (!occlTimer) {
          occlTimer = setTimeout(function () { occlTimer = 0; occl.t = -1e9; requestRedraw(); }, 150);
        }
        const mode = modeOf(uiState()).name;
        if (!PLACING_MODES[mode]) hover = null;
        if (mode !== 'select') hoverHandle = null;
        readBackground();
      }
      requestRedraw();
    });

    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { if (resize()) requestRedraw(); });
      ro.observe(host);
    }
    let io = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(function (entries) {
        const e = entries[entries.length - 1];
        const was = onScreen;
        onScreen = !!(e && e.isIntersecting);
        if (onScreen && !was) requestRedraw();
      });
      io.observe(canvas);
    }
    function onVisibility() {
      docVisible = !document.hidden;
      if (docVisible) requestRedraw();
    }
    function onWindowResize() { if (resize()) requestRedraw(); }
    const onCancel = (e) => onPointerUp(e, true);
    const onUp = (e) => onPointerUp(e, false);
    const prevent = (e) => e.preventDefault();
    const onBlur = () => { altKey = false; };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', prevent);
    canvas.addEventListener('dblclick', prevent);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('visibilitychange', onVisibility);

    readBackground();
    lastProject = project();
    resize();
    syncImage();
    requestRedraw();

    function destroy() {
      if (destroyed) return;
      if (drag && drag.type === 'handle') finishHandleDrag();
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      if (zoomAnim) cancelAnimationFrame(zoomAnim);
      if (occlTimer) clearTimeout(occlTimer);
      frame = 0;
      try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (e) { /* ignore */ }
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', prevent);
      canvas.removeEventListener('dblclick', prevent);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    return {
      canvas,
      fit,
      zoomBy,
      zoomIn: () => zoomBy(1.4),
      zoomOut: () => zoomBy(1 / 1.4),
      redraw: requestRedraw,
      screenToImage,
      imageToScreen,
      getView: () => ({ scale: view.scale, tx: view.tx, ty: view.ty, cssW: view.cssW, cssH: view.cssH, dpr: view.dpr, fitScale: fitScaleFor(view.cssW, view.cssH) }),
      setView: (v) => {
        if (!isObj(v)) return;
        if (isNum(v.scale) && v.scale > 0) view.scale = v.scale;
        if (isNum(v.tx)) view.tx = v.tx;
        if (isNum(v.ty)) view.ty = v.ty;
        view.fitted = false;
        clampView();
        requestRedraw();
      },
      isAnimating: animating,
      /** The label pills drawn in the last frame, [{text, x, y, w, h, anchored}] in CSS px (for tests). */
      labelBoxes: () => lastLabels.map((b) => Object.assign({}, b)),
      destroy,
    };
  }

  return {
    createViewport, selectionHandles, snapCandidates, layersFor, targetKey, midpointHandles, isDoubleTap, snapRadiusImg,
    cordLabelText, cordPieces, tapMarkers, cordLabelSpots, clipSegment, tapErrorPx,
  };
});
