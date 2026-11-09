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
 * Snapping (ui.view.snap; hold Alt with a mouse to place freely): to any vertex, rectangle corner, reference end
 * or outlet within 14 CSS px; else to horizontal/vertical within 4° in the plane's rectified coordinates
 * (measure.imageToPlane/planeToImage), falling back to image axes when the plane has no scale yet. Closing a
 * polygon (tapping its first point) always works, snap or not, and passes the first point exactly.
 *
 * Deviations from SPEC §6.3 (documented API unchanged; additive):
 *  - Extra viewport members: canvas, getView() → {scale, tx, ty, cssW, cssH, dpr, fitScale},
 *    setView({scale, tx, ty}), zoomIn(), zoomOut(), isAnimating().
 *  - Extra keys (desktop, focus not in a field): + / - zoom, 0 fits the photo; Delete works like Backspace.
 *  - Step 5 also labels each cord path with its length ("18 ft cord") when labels are on.
 *  - Module extras for tests: selectionHandles(project, sel), snapCandidates(project, imageId), layersFor(step, mode).
 */
LP.define('ui.viewport', ['geometry', 'catalog', 'measure', 'ui.preview'], function (g, catalog, measure, preview) {
  'use strict';

  // ---------------------------------------------------------------- tuning (CSS px unless noted)
  const TAP_SLOP = 8;
  const TAP_MS = 500;
  const DOUBLE_TAP_MS = 320;
  const DOUBLE_TAP_SLOP = 32;
  const SNAP_PX = 14;
  const AXIS_SNAP_DEG = 4;
  const HANDLE_HIT = { touch: 22, pen: 14, mouse: 11 };
  const ITEM_HIT = { touch: 18, pen: 10, mouse: 8 };
  const HANDLE_R = 6.5;
  const LOUPE_SIZE = 110;
  const LOUPE_ZOOM = 2.5;
  const LOUPE_GAP = 34;
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

  const candMemo = new WeakMap();
  /** Every point on the photo a new or moved point can snap to: [{p, key, index}]. Memoized per project. */
  function snapCandidates(project, imageId) {
    if (!isObj(project)) return [];
    const m = candMemo.get(project);
    if (m && m.imageId === imageId) return m.list;
    const list = [];
    for (const f of arr(project.features)) {
      if (!onImage(f, imageId)) continue;
      arr(f.points).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'feature:' + f.id, index: i }); });
    }
    for (const pl of arr(project.planes)) {
      if (!onImage(pl, imageId)) continue;
      if (pl.rect) arr(pl.rect.corners).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'planeRect:' + pl.id, index: i }); });
      if (pl.derived) arr(pl.derived.line).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'planeLine:' + pl.id, index: i }); });
      for (const ref of arr(pl.refs)) {
        if (ref) arr(ref.points).forEach((p, i) => { if (okPt(p)) list.push({ p, key: 'ref:' + pl.id + ':' + ref.id, index: i }); });
      }
    }
    for (const o of arr(project.outlets)) {
      if (onImage(o, imageId) && okPt(o.point)) list.push({ p: o.point, key: 'outlet:' + o.id, index: 0 });
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
     * Snap image point ip. opt: {exclude: {key, index}, anchors: [img pts], planeId, closeFirst: img pt|null}.
     * Returns {pt, kind: null|'vertex'|'close'|'axis', anchor?, axis?}.
     */
    function snapPoint(ip, opt) {
      const op = opt || {};
      const r = SNAP_PX / view.scale;
      if (op.closeFirst && g.dist(ip, op.closeFirst) <= r * 1.25) return { pt: op.closeFirst.slice(), kind: 'close' };
      const ui = uiState();
      if (!viewFlags(ui).snap || altKey) return { pt: ip, kind: null };
      const prj = project();
      const img = activeImage(prj);
      let best = null;
      if (img) {
        for (const c of snapCandidates(prj, img.id)) {
          if (op.exclude && c.key === op.exclude.key && c.index === op.exclude.index) continue;
          const d = g.dist(ip, c.p);
          if (d <= r && (!best || d < best.d)) best = { d, p: c.p };
        }
      }
      if (best) return { pt: best.p.slice(), kind: 'vertex' };
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
      const pts = draftPoints(ui);
      const anchors = [];
      if (pts.length) anchors.push(pts[pts.length - 1]);
      if (mode.name === 'rect' && pts.length === 3) anchors.push(pts[0]);
      let closeFirst = null;
      let planeId = snapPlaneForDraft(ui);
      if (mode.name === 'trace') {
        const t = FT[(isObj(mode.opts) && mode.opts.type) || ui.traceType];
        if (t && (t.geometry === 'polygon' || t.geometry === 'area') && pts.length >= 3) closeFirst = pts[0];
        if (t && t.geometry === 'vertical') planeId = verticalSnapPlane(planeId);
      }
      return { anchors, planeId, closeFirst };
    }
    /**
     * Trees and columns stand upright. On a wall, "vertical" in the wall's coordinates is upright; on a roof or the
     * ground the plane's v axis runs up the slope or toward the street, so align them on image axes instead.
     */
    function verticalSnapPlane(planeId) {
      const pl = byId(arr(project() && project().planes), planeId);
      return pl && pl.kind === 'wall' ? planeId : null;
    }

    /** Snap options while dragging handle h: exclude itself; align to its neighbors. */
    function dragSnapOptions(h) {
      const prj = project();
      const t = h.target;
      const anchors = [];
      let planeId = null;
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
      } else if (t.kind === 'planeRect') {
        const pl = byId(prj.planes, t.planeId);
        if (pl && pl.rect && arr(pl.rect.corners).length === 4) neighborsInQuad(pl.rect.corners, h.index).forEach((p) => anchors.push(p));
        planeId = null;   // the rectangle defines this plane's axes: align on image axes
      } else if (t.kind === 'planeLine') {
        const pl = byId(prj.planes, t.planeId);
        const line = pl && pl.derived ? arr(pl.derived.line) : [];
        line.forEach((p, i) => { if (i !== h.index && okPt(p)) anchors.push(p); });
        planeId = pl && pl.derived ? pl.derived.parentPlaneId : null;   // an eave/base lies on its parent wall
      }
      return { exclude: { key: targetKey(t), index: h.index }, anchors, planeId };
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
        try { store.beginGesture(); } catch (err) { /* ignore */ }
        const ip = screenToImage(sp);
        drag = { type: 'handle', id: e.pointerId, handle: h, grab: [h.p[0] - ip[0], h.p[1] - ip[1]], pointerType: type, opts: dragSnapOptions(h), moved: false };
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
        try { actions.moveVertex(drag.handle.target, drag.handle.index, pt, { gesture: true }); } catch (err) { /* actions toast their own errors */ }
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
        if (moved <= TAP_SLOP && (elapsed < TAP_MS || placing)) handleTap(sp, d.pointerType, e.timeStamp || performance.now());
      }
      loupe = null;
      if (d.pointerType === 'touch') hover = null;
      requestRedraw();
    }

    function handleTap(sp, type, t) {
      const ui = uiState();
      const mode = modeOf(ui);
      const draftLen = draftPoints(ui).length;
      const isDouble = !!lastTap && t - lastTap.t <= DOUBLE_TAP_MS && Math.hypot(sp[0] - lastTap.x, sp[1] - lastTap.y) <= DOUBLE_TAP_SLOP && lastTap.mode === mode.name;
      if (isDouble) {
        lastTap = null;
        if (mode.name === 'trace') {
          if (draftLen >= 2 && typeof actions.completeDraft === 'function') actions.completeDraft();
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
        if (typeof actions.addDraftPoint === 'function') actions.addDraftPoint(pt);
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
      labels.obstacles = [];   // screen boxes labels must not cover (outlet icons)
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
        labels.push({ text: featureLabelText(prj, f, m), x: at[0], y: at[1], dot: conf, priority: isSel ? 4 : 1, faint });
      }
    }

    function drawPower(prj, plan, img, flags, labels) {
      if (!plan) return;
      const power = isObj(plan.power) ? plan.power : {};
      const outletsById = new Map(arr(prj.outlets).filter(isObj).map((x) => [x.id, x]));
      // Cord paths (dashed, circuit color).
      for (const feed of arr(power.feeds)) {
        if (!isObj(feed)) continue;
        const start = isObj(feed.start) ? feed.start : {};
        const outlet = outletsById.get(feed.outletId);
        if (start.imageId !== img.id && !(outlet && onImage(outlet, img.id))) continue;
        const path = validPts(feed.cordPath);
        if (path.length < 2) continue;
        const color = circuitColor(prj, feed.circuitId);
        pathFrom(path, false);
        strokeOutlined(color, 2.2, 0.95, [7, 5]);
        const S = path.map(imageToScreen);
        if (flags.labels && feed.cord && isNum(feed.cord.lengthFt) && g.polylineLength(S, false) >= 70) {
          const mp = polylineMidpoint(S);
          labels.push({ text: Math.ceil(feed.cord.lengthFt) + ' ft cord', x: mp.p[0] + mp.n[0] * 13, y: mp.p[1] + mp.n[1] * 13, swatch: color, priority: 0 });
        }
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
        if (flags.labels) {
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
        const tries = [[0, 0], [0, -h - 3], [0, h + 3], [w * 0.6, 0], [-w * 0.6, 0], [0, -2 * h - 6], [0, 2 * h + 6]];
        let box = null;
        for (const t of tries) {
          const x = clamp(l.x + t[0] - w / 2, 2, view.cssW - w - 2);
          const y = clamp(l.y + t[1] - h / 2, 2, view.cssH - h - 2);
          const b = { x, y, w, h };
          if (!placed.some((q) => b.x < q.x + q.w + 3 && q.x < b.x + b.w + 3 && b.y < q.y + q.h + 2 && q.y < b.y + b.h + 2)) { box = b; break; }
        }
        if (!box) {
          if (l.priority < 4) continue;
          box = { x: clamp(l.x - w / 2, 2, view.cssW - w - 2), y: clamp(l.y - h / 2, 2, view.cssH - h - 2), w, h };
        }
        placed.push(box);
        ctx.globalAlpha = l.faint ? 0.82 : 1;
        preview.roundRectPath(ctx, box.x, box.y, box.w, box.h, h / 2);
        ctx.fillStyle = 'rgba(9,14,22,0.86)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
        let tx = box.x + 7;
        if (l.dot || l.swatch) {
          dot([box.x + 11, box.y + h / 2], l.dot ? 4 : 3.5, l.dot || l.swatch, l.dot ? null : 'rgba(255,255,255,0.4)', 1);
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
      destroy,
    };
  }

  return { createViewport, selectionHandles, snapCandidates, layersFor, targetKey };
});
