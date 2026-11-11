/* LightPlan UI: actions (SPEC §6.2).
 * Every user intent that changes the project goes through here, as a labelled store.commit (so it can be
 * undone), or through store.setUI for UI-only state. Panels, the viewport and the app shell never edit the
 * project themselves.
 *
 * Drawing tools (ui.mode):
 *   rect   {purpose:'planeRect'|'refRect', planeId, presetId, widthFt, heightFt}     completes at 4 taps
 *   line   {purpose:'refLine', planeId, presetId, lengthFt, courses}                  completes at 2 taps
 *          {purpose:'roofEave'|'groundBase', planeId (parent wall), pitch}            → new roof / ground plane
 *          {purpose:'planeLine', planeId (roof/ground)}                               → redraw its eave / base line
 *   trace  {type, planeId}   polyline: Finish / double-tap / Enter; polygon: tap the first point or Finish;
 *                            vertical (tree, column): completes at 2 taps (base, then top)
 *   outlet {planeId}         one tap places an outlet
 *
 * Deviations from SPEC §6.2 (additive; documented actions keep their signatures):
 *  - Extra line purpose 'planeLine' (redraw a roof eave / ground base line).
 *  - completeDraft({close}) accepts close:true (used when the first point is tapped again).
 *  - Extra actions: undo, undoLabel, canUndo (a draft point first), hasUserWork, setActiveVertex, setActivePlane, setView, setCalib, setSheet, startPlaneRect, startReference, startTrace,
 *    startOutlet, redrawPlaneLine, changeFeatureType, resetAutoPlan, setProjectName, dismissBanner,
 *    dismissToast, confirmReplace, hydrateImages, removePlaneRect, setOwnCord(featureIds, on).
 *  - deletePlane(id) returns a Promise<bool> (it asks first when traced items would be deleted with it).
 *  - addCircuit() returns the new circuit id; addPlane('wall') returns the new plane id.
 *  - loadSample({traced, confirm}) asks before replacing the user's work (confirm:false skips) and is undoable.
 *  - startTrace picks the surface by type (KINDS_FOR_TYPE); a walkway/stakes with no ground plane first starts the
 *    ground base line tool (line purpose 'groundBase' with opts.thenTrace) and then traces on the new ground.
 *  - addOutlet puts the outlet on the wall under the tap (wallForPoint), never on a roof or ground plane.
 *  - Module exports also parseLength(text) → feet | null, nextFeatureLabel, nextOutletLabel, wallForPoint,
 *    KINDS_FOR_TYPE.
 */
LP.define('ui.actions', ['catalog', 'schema', 'measure', 'sample', 'ui.imagesource', 'ui.persist', 'ui.store'],
  function (catalog, schema, measure, sample, imagesource, persist, storeModule) {
    'use strict';

    const { FEATURE_TYPES } = catalog;
    const arr = (v) => (Array.isArray(v) ? v : []);
    const byId = (list, id) => arr(list).find((x) => x && x.id === id) || null;
    const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    const pt = (p) => [p[0], p[1]];
    const posOrNull = (v) => (Number.isFinite(v) && v > 0 ? v : null);
    const nowIso = () => new Date().toISOString();

    // ---------------------------------------------------------------- length parsing
    /**
     * Parse a length typed by a person into feet. Accepts 6' 8", 6'8, 6'-8", 6' 8 1/2", 6′ 8″, 6 ft 8 in, 6ft,
     * 80in, 80", 36 1/2", 36-1/2", 1/2", 8 1/2', 6.67 (plain numbers are feet), 6-8 (feet-inches), 2.4 m, 240 cm.
     * A comma followed by exactly three digits is a thousands separator (1,200 = 1200); any other comma is a
     * decimal point (6,5 = 6.5). Inches of 12 or more after a feet value are refused. Returns null for anything
     * else or ≤ 0.
     */
    function parseLength(input) {
      if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;
      if (typeof input !== 'string') return null;
      const s = input.trim().toLowerCase()
        .replace(/[′’‘´`]/g, "'")
        .replace(/[″“”]/g, '"')
        .replace(/''/g, '"')
        .replace(/(\d),(\d{3})(?![\d.,])/g, '$1$2')
        .replace(/(\d),(\d)/g, '$1.$2')
        .replace(/\s+/g, ' ');
      if (!s) return null;
      // A number: decimal, a fraction (1/2) or a whole number with a fraction (8 1/2, 36-1/2).
      const N = '(\\d+(?:\\.\\d+)?(?:[ -]\\d+/\\d+)?|\\d+/\\d+|\\.\\d+)';
      const num = (t) => {
        let m = t.match(/^(\d+)[ -](\d+)\/(\d+)$/);
        if (m) return Number(m[3]) > 0 ? Number(m[1]) + Number(m[2]) / Number(m[3]) : NaN;
        m = t.match(/^(\d+)\/(\d+)$/);
        if (m) return Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : NaN;
        return parseFloat(t);
      };
      const ok = (v) => (Number.isFinite(v) && v > 0 ? v : null);
      let m = s.match(new RegExp('^' + N + " ?(?:'|ft\\.?|feet|foot) ?(?:-? ?" + N + ' ?(?:"|in\\.?|inch|inches)?)?$'));
      if (m) {
        const inches = m[2] ? num(m[2]) : 0;
        if (!(inches >= 0) || inches >= 12) return null;
        return ok(num(m[1]) + inches / 12);
      }
      m = s.match(new RegExp('^' + N + ' ?(?:"|in\\.?|inch|inches)$'));
      if (m) return ok(num(m[1]) / 12);
      m = s.match(new RegExp('^' + N + ' ?(?:m|meters?|metres?)$'));
      if (m) return ok(num(m[1]) / 0.3048);
      m = s.match(new RegExp('^' + N + ' ?cm$'));
      if (m) return ok(num(m[1]) / 30.48);
      m = s.match(new RegExp('^' + N + '$'));
      if (m) return ok(num(m[1]));
      m = s.match(/^(\d+) ?[- ] ?(\d+(?:\.\d+)?)$/);
      if (m && parseFloat(m[2]) < 12) return ok(parseInt(m[1], 10) + parseFloat(m[2]) / 12);
      return null;
    }

    // ---------------------------------------------------------------- default labels
    /** "<short> <n>" with the first n not already used by a feature label, e.g. "Eave 2". */
    function nextFeatureLabel(project, type) {
      const ft = FEATURE_TYPES[type];
      const short = ft ? ft.short : 'Item';
      const feats = arr(project && project.features);
      const used = new Set(feats.map((f) => f && f.label));
      let n = feats.filter((f) => f && f.type === type).length + 1;
      while (used.has(short + ' ' + n)) n += 1;
      return short + ' ' + n;
    }
    function letters(i) {
      let s = '';
      let n = i;
      do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
      return s;
    }
    /** "Outlet A", "Outlet B", ... (first unused). */
    function nextOutletLabel(project) {
      const used = new Set(arr(project && project.outlets).map((o) => o && o.label));
      for (let i = 0; i < 702; i++) {
        const label = 'Outlet ' + letters(i);
        if (!used.has(label)) return label;
      }
      return 'Outlet';
    }
    function nextName(existing, base, startAt) {
      const used = new Set(existing);
      let n = startAt;
      while (used.has(base + ' ' + n)) n += 1;
      return base + ' ' + n;
    }

    /** Surface kinds each feature type can lie on; the first is preferred when the active surface does not fit. */
    const KINDS_FOR_TYPE = {
      roofline: ['wall'], gutter: ['wall'], window: ['wall'], door: ['wall'], railing: ['wall'], column: ['wall'], bush: ['wall'],
      rake: ['wall', 'roof'], tree: ['wall', 'ground'], ridge: ['roof', 'wall'], walkway: ['ground'], stakes: ['ground'],
    };

    /**
     * The wall a point on the photo belongs to: the wall whose rectangle, references or traced items (their
     * outline) contain it, else the nearest such wall, else the preferred/first wall. Roof and ground planes are
     * never picked (outlets sit on walls). Returns a plane id or null.
     */
    function wallForPoint(project, imageId, point, preferId) {
      const walls = arr(project && project.planes).filter((pl) => pl && pl.kind === 'wall' && (!imageId || pl.imageId === imageId));
      if (!walls.length || !isPt(point)) return walls[0] ? walls[0].id : null;
      let best = null;
      for (const pl of walls) {
        const pts = [];
        if (pl.rect) arr(pl.rect.corners).forEach((q) => { if (isPt(q)) pts.push(q); });
        for (const r of arr(pl.refs)) arr(r && r.points).forEach((q) => { if (isPt(q)) pts.push(q); });
        for (const f of arr(project.features)) {
          if (f && f.planeId === pl.id && (!imageId || f.imageId === imageId)) arr(f.points).forEach((q) => { if (isPt(q)) pts.push(q); });
        }
        if (pts.length < 3) continue;
        const hull = convexHull(pts);
        const d = hull.length >= 3 && pointInPoly(point, hull) ? 0 : distToPoly(point, hull);
        const score = d - (pl.id === preferId ? 1e-6 : 0);
        if (!best || score < best.score) best = { id: pl.id, score };
      }
      if (best) return best.id;
      const pref = walls.find((pl) => pl.id === preferId);
      return (pref || walls[0]).id;
    }
    function convexHull(points) {
      const ps = points.map(pt).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      if (ps.length < 3) return ps;
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower = [];
      for (const q of ps) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
      const upper = [];
      for (let i = ps.length - 1; i >= 0; i--) { const q = ps[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
      return lower.slice(0, -1).concat(upper.slice(0, -1));
    }
    function pointInPoly(q, poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }
    function distToPoly(q, poly) {
      let d = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L = dx * dx + dy * dy;
        const t = L > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
        d = Math.min(d, Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)));
      }
      return d;
    }

    function createActions(store) {
      const P = () => store.project();
      const U = () => store.ui();
      const activeImage = () => storeModule.activeImageOf(P());
      const findPlane = (d, id) => byId(d.planes, id);
      let toastSeq = 0;
      let pendingConfirm = null;

      const SELECT = () => ({ mode: { name: 'select', opts: {} }, draft: { points: [] } });

      const actions = {};

      // ------------------------------------------------------------ feedback
      actions.toast = (message, kind) => {
        toastSeq += 1;
        store.setUI({ toast: { message: String(message), kind: kind || 'info', id: toastSeq } });
        return toastSeq;
      };
      actions.dismissToast = (id) => {
        const t = U().toast;
        if (t && (id == null || t.id === id)) store.setUI({ toast: null });
      };
      /** In-page confirm dialog (alert/confirm/prompt do nothing in the artifact viewer). Resolves true/false. */
      actions.confirm = (o) => {
        const opts = o || {};
        if (pendingConfirm) pendingConfirm(false);
        return new Promise((resolve) => {
          const settle = (result) => {
            if (pendingConfirm !== settle) return;
            pendingConfirm = null;
            store.setUI({ dialog: null });
            resolve(result);
          };
          pendingConfirm = settle;
          store.setUI({
            dialog: {
              title: opts.title || 'Are you sure?',
              body: opts.body || '',
              confirmLabel: opts.confirmLabel || 'OK',
              cancelLabel: opts.cancelLabel || 'Cancel',
              danger: !!opts.danger,
              onConfirm: () => settle(true),
              onCancel: () => settle(false),
            },
          });
        });
      };

      // ------------------------------------------------------------ navigation, selection, view
      actions.goStep = (n) => {
        const step = Math.max(1, Math.min(6, Math.round(Number(n) || 1)));
        store.setUI(Object.assign({ step, selection: null }, SELECT()));
      };
      actions.select = (sel) => {
        if (!sel) { store.setUI({ selection: null }); return; }
        const patch = { selection: Object.assign({}, sel) };
        const p = P();
        if (sel.kind === 'plane' && findPlane(p, sel.id)) patch.activePlaneId = sel.id;
        else if (sel.kind === 'ref' && findPlane(p, sel.planeId)) patch.activePlaneId = sel.planeId;
        else if (sel.kind === 'feature') {
          const f = byId(p.features, sel.id);
          if (f && f.planeId && findPlane(p, f.planeId)) patch.activePlaneId = f.planeId;
        }
        store.setUI(patch);
      };
      actions.setActivePlane = (id) => {
        if (!findPlane(P(), id)) return;
        const ui = U();
        const patch = { activePlaneId: id };
        if (ui.mode.name === 'trace' || ui.mode.name === 'outlet') {
          patch.mode = { name: ui.mode.name, opts: Object.assign({}, ui.mode.opts, { planeId: id }) };
        }
        store.setUI(patch);
      };
      actions.setView = (patch) => store.setUI({ view: Object.assign({}, U().view, patch || {}) });
      actions.setCalib = (patch) => store.setUI({ calib: Object.assign({}, U().calib, patch || {}) });
      actions.setSheet = (sheet) => { if (['min', 'half', 'full'].includes(sheet)) store.setUI({ sheet }); };
      actions.dismissBanner = () => store.setUI({ bannerDismissed: true });

      // ------------------------------------------------------------ tools and drafts
      actions.setMode = (name, opts) => {
        const patch = { mode: { name: name || 'select', opts: Object.assign({}, opts || {}) }, draft: { points: [] } };
        if (name && name !== 'select' && name !== 'pan') patch.selection = null;
        store.setUI(patch);
      };
      actions.cancelDraft = () => store.setUI(SELECT());

      actions.addDraftPoint = (p) => {
        const ui = U();
        const mode = ui.mode || {};
        if (!['rect', 'line', 'trace'].includes(mode.name) || !isPt(p)) return;
        const pts = arr(ui.draft && ui.draft.points);
        const last = pts[pts.length - 1];
        if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) return; // double tap on one spot
        if (mode.name === 'trace') {
          const first = pts[0];
          if (pts.length >= 3 && first && Math.abs(first[0] - p[0]) < 0.5 && Math.abs(first[1] - p[1]) < 0.5) {
            actions.completeDraft({ close: true });
            return;
          }
        }
        const next = pts.concat([pt(p)]);
        store.setUI({ draft: { points: next } });
        if (mode.name === 'rect' && next.length >= 4) actions.completeDraft();
        else if (mode.name === 'line' && next.length >= 2) actions.completeDraft();
        else if (mode.name === 'trace') {
          const ft = FEATURE_TYPES[mode.opts && mode.opts.type];
          if (ft && (ft.geometry === 'vertical' || (ft.maxPoints && next.length >= ft.maxPoints)) && next.length >= (ft.maxPoints || 2)) {
            actions.completeDraft();
          }
        }
      };
      /** Undo for the top bar and Ctrl+Z: the last tapped draft point first, then the last committed change. */
      actions.undo = () => {
        const pts = arr(U().draft && U().draft.points);
        if (pts.length && ['rect', 'line', 'trace'].includes(U().mode.name)) { actions.removeLastDraftPoint(); return 'Undo point'; }
        return store.undo();
      };
      /** What actions.undo would undo, for the button's label. */
      actions.undoLabel = () => {
        const pts = arr(U().draft && U().draft.points);
        if (pts.length && ['rect', 'line', 'trace'].includes(U().mode.name)) return 'Undo point';
        return store.undoLabel();
      };
      actions.canUndo = () => !!actions.undoLabel() && (store.canUndo() || actions.undoLabel() === 'Undo point');
      actions.removeLastDraftPoint = () => {
        const pts = arr(U().draft && U().draft.points);
        if (pts.length) store.setUI({ draft: { points: pts.slice(0, -1) } });
      };

      /** Finish the current drawing tool. Returns true when something was created. */
      actions.completeDraft = (copts) => {
        const ui = U();
        const mode = ui.mode || {};
        const o = mode.opts || {};
        const pts = arr(ui.draft && ui.draft.points).map(pt);
        const p = P();
        if (mode.name === 'rect') {
          if (pts.length < 4) { actions.toast('Tap all 4 corners first.', 'warn'); return false; }
          const plane = findPlane(p, o.planeId);
          if (!plane) { actions.cancelDraft(); return false; }
          if (o.purpose === 'refRect') {
            const ref = measure.refFromPreset(o.presetId || 'custom-rect', pts.slice(0, 4), {
              widthFt: o.widthFt, heightFt: o.heightFt, id: schema.uid('ref'),
            });
            store.commit('Add reference', (d) => { const pl = findPlane(d, plane.id); if (!pl) return false; pl.refs.push(ref); });
            store.setUI(Object.assign(SELECT(), { selection: { kind: 'ref', id: ref.id, planeId: plane.id }, activePlaneId: plane.id }));
            return true;
          }
          const preset = arr(measure.WALL_RECT_PRESETS).find((x) => x.id === o.presetId) || null;
          const widthFt = posOrNull(o.widthFt) || (preset ? posOrNull(preset.widthFt) : null);
          const heightFt = posOrNull(o.heightFt) || (preset ? posOrNull(preset.heightFt) : null);
          const known = !!(widthFt && heightFt);
          store.commit('Mark rectangle', (d) => {
            const pl = findPlane(d, plane.id);
            if (!pl) return false;
            pl.rect = { corners: pts.slice(0, 4), widthFt: known ? widthFt : null, heightFt: known ? heightFt : null, presetId: o.presetId || 'unknown' };
          });
          store.setUI(Object.assign(SELECT(), { selection: { kind: 'plane', id: plane.id }, activePlaneId: plane.id }));
          return true;
        }
        if (mode.name === 'line') {
          if (pts.length < 2) { actions.toast('Tap both ends first.', 'warn'); return false; }
          const line = pts.slice(0, 2);
          const plane = findPlane(p, o.planeId);
          if (!plane) { actions.cancelDraft(); return false; }
          if (o.purpose === 'roofEave' || o.purpose === 'groundBase') {
            const kind = o.purpose === 'roofEave' ? 'roof' : 'ground';
            const names = p.planes.map((x) => x.name);
            const name = kind === 'roof'
              ? nextName(names, 'Roof slope', p.planes.filter((x) => x.kind === 'roof').length + 1)
              : nextName(names, 'Ground', p.planes.filter((x) => x.kind === 'ground').length + 1);
            const np = schema.createPlane({
              kind, imageId: plane.imageId, name,
              derived: { parentPlaneId: plane.id, line, pitch: kind === 'roof' && o.pitch ? o.pitch : null },
            });
            store.commit(kind === 'roof' ? 'Add roof slope' : 'Add ground plane', (d) => { d.planes.push(np); });
            store.setUI(Object.assign(SELECT(), { activePlaneId: np.id, selection: { kind: 'plane', id: np.id } }));
            // Made on the way to tracing a walkway (startTrace): carry on with that trace on the new ground.
            if (o.thenTrace && FEATURE_TYPES[o.thenTrace]) actions.startTrace(o.thenTrace);
            return true;
          }
          if (o.purpose === 'planeLine') {
            store.commit('Redraw line', (d) => {
              const pl = findPlane(d, plane.id);
              if (!pl || !pl.derived) return false;
              pl.derived.line = line;
            });
            store.setUI(Object.assign(SELECT(), { selection: { kind: 'plane', id: plane.id }, activePlaneId: plane.id }));
            return true;
          }
          const ref = measure.refFromPreset(o.presetId || 'custom-line', line, {
            lengthFt: o.lengthFt, courses: o.courses, id: schema.uid('ref'),
          });
          store.commit('Add reference', (d) => { const pl = findPlane(d, plane.id); if (!pl) return false; pl.refs.push(ref); });
          store.setUI(Object.assign(SELECT(), { selection: { kind: 'ref', id: ref.id, planeId: plane.id }, activePlaneId: plane.id }));
          return true;
        }
        if (mode.name === 'trace') {
          const ft = FEATURE_TYPES[o.type];
          if (!ft) { actions.cancelDraft(); return false; }
          const need = Math.max(ft.minPoints || 2, ft.geometry === 'polygon' || ft.geometry === 'area' ? 3 : 2);
          if (pts.length < need) {
            actions.toast(ft.geometry === 'vertical' ? 'Tap the base, then the top.' : 'Tap at least ' + need + ' points first.', 'warn');
            return false;
          }
          const img = activeImage();
          const planeId = findPlane(p, o.planeId) ? o.planeId : U().activePlaneId;
          const closed = ft.geometry === 'polygon' || ft.geometry === 'area' ? true
            : ft.geometry === 'vertical' ? false : !!(copts && copts.close);
          const feature = schema.createFeature(o.type, {
            imageId: img ? img.id : null, planeId, points: ft.maxPoints ? pts.slice(0, ft.maxPoints) : pts, closed,
            label: nextFeatureLabel(p, o.type),
          });
          store.commit('Trace ' + ft.short.toLowerCase(), (d) => { d.features.push(feature); });
          // Stay in trace mode with the same type so the next run can be traced straight away.
          store.setUI({ draft: { points: [] }, selection: { kind: 'feature', id: feature.id } });
          return true;
        }
        return false;
      };

      actions.startPlaneRect = (planeId) => {
        const p = P();
        const plane = findPlane(p, planeId || U().activePlaneId);
        if (!plane) { actions.toast('Add a photo first.', 'warn'); return; }
        if (plane.kind !== 'wall') { actions.toast('Perspective rectangles go on walls. Pick a wall first.', 'warn'); return; }
        const c = U().calib;
        const preset = arr(measure.WALL_RECT_PRESETS).find((x) => x.id === c.rectPresetId) || null;
        const custom = c.rectPresetId === 'custom-rect';
        if (custom && !(posOrNull(c.rectWidthFt) && posOrNull(c.rectHeightFt))) {
          actions.toast('Enter the rectangle width and height first.', 'warn');
          return;
        }
        actions.setMode('rect', {
          purpose: 'planeRect', planeId: plane.id, presetId: preset ? preset.id : 'unknown',
          widthFt: custom ? c.rectWidthFt : (preset ? preset.widthFt : null),
          heightFt: custom ? c.rectHeightFt : (preset ? preset.heightFt : null),
        });
      };
      actions.removePlaneRect = (planeId) => {
        store.commit('Remove rectangle', (d) => { const pl = findPlane(d, planeId); if (!pl || !pl.rect) return false; pl.rect = null; });
      };
      actions.startReference = (planeId) => {
        const p = P();
        const plane = findPlane(p, planeId || U().activePlaneId);
        if (!plane) { actions.toast('Add a photo first.', 'warn'); return; }
        const c = U().calib;
        const preset = measure.getRefPreset(c.refPresetId) || measure.getRefPreset('door-height');
        if (preset.kind === 'rect') {
          const custom = preset.id === 'custom-rect';
          if (custom && !(posOrNull(c.refWidthFt) && posOrNull(c.refHeightFt))) {
            actions.toast('Enter the width and height of the rectangle first.', 'warn');
            return;
          }
          actions.setMode('rect', {
            purpose: 'refRect', planeId: plane.id, presetId: preset.id,
            widthFt: custom ? c.refWidthFt : preset.widthIn / 12, heightFt: custom ? c.refHeightFt : preset.heightIn / 12,
          });
          return;
        }
        if (preset.kind === 'courses') {
          const courses = Math.round(Number(c.refCourses));
          if (!(courses >= 1)) { actions.toast('Enter how many courses the line spans.', 'warn'); return; }
          actions.setMode('line', { purpose: 'refLine', planeId: plane.id, presetId: preset.id, courses, lengthFt: null });
          return;
        }
        if (preset.id === 'custom-line' && !posOrNull(c.refLengthFt)) {
          actions.toast('Enter the length first, for example 6\' 8".', 'warn');
          return;
        }
        actions.setMode('line', {
          purpose: 'refLine', planeId: plane.id, presetId: preset.id,
          lengthFt: preset.id === 'custom-line' ? c.refLengthFt : preset.lengthIn / 12, courses: null,
        });
      };
      /**
       * Pick the surface a feature type is traced on. The active surface is used when it suits the type; otherwise:
       * walkways and stakes go on the ground, ridges on a roof, rakes on a wall or roof, trees on a wall or the
       * ground, and everything else (eaves, gutters, windows, doors, railings, columns, bushes) on a wall: the
       * parent wall of an active roof/ground plane, else the first wall. Returns {plane, needGround}.
       */
      function planeForType(type) {
        const p = P();
        const img = activeImage();
        const planes = p.planes.filter((x) => !img || x.imageId === img.id);
        const active = byId(planes, U().activePlaneId);
        const allowed = KINDS_FOR_TYPE[type] || ['wall'];
        if (active && allowed.includes(active.kind)) return { plane: active };
        if (allowed[0] === 'ground') {
          const ground = planes.find((x) => x.kind === 'ground');
          return ground ? { plane: ground } : { plane: null, needGround: true };
        }
        if (allowed[0] === 'roof') {
          const roof = planes.find((x) => x.kind === 'roof');
          if (roof) return { plane: roof };
        }
        const parent = active && active.derived ? byId(planes, active.derived.parentPlaneId) : null;
        const wall = (parent && parent.kind === 'wall' ? parent : null) || planes.find((x) => x.kind === 'wall');
        return { plane: wall || active || planes[0] || null };
      }
      actions.startTrace = (type) => {
        if (!FEATURE_TYPES[type]) return;
        const pick = planeForType(type);
        if (pick.needGround) {
          // Measuring a walkway on a wall gives a wrong length, so make the ground first, then trace on it.
          const p = P();
          const img = activeImage();
          const active = byId(p.planes, U().activePlaneId);
          const wall = (active && active.kind === 'wall' ? active : null) || p.planes.find((x) => x.kind === 'wall' && (!img || x.imageId === img.id));
          if (!wall) { actions.toast('Add a photo first.', 'warn'); return; }
          store.setUI({ traceType: type });
          actions.setMode('line', { purpose: 'groundBase', planeId: wall.id, pitch: null, thenTrace: type });
          actions.toast(FEATURE_TYPES[type].short + 's lie on the ground, so LightPlan needs the ground first: tap two points along the bottom of \'' + wall.name + '\', where it meets the ground.', 'info');
          return;
        }
        const plane = pick.plane;
        if (!plane) { actions.toast('Add a photo first.', 'warn'); return; }
        store.setUI({ traceType: type, activePlaneId: plane.id });
        actions.setMode('trace', { type, planeId: plane.id });
      };
      actions.startOutlet = () => {
        const plane = byId(P().planes, U().activePlaneId);
        if (!activeImage()) { actions.toast('Add a photo first.', 'warn'); return; }
        // The outlet goes on the wall under the tap (see addOutlet); planeId here is only a fallback.
        actions.setMode('outlet', { planeId: plane && plane.kind === 'wall' ? plane.id : null });
      };
      actions.redrawPlaneLine = (planeId) => {
        const plane = findPlane(P(), planeId);
        if (!plane || plane.kind === 'wall') return;
        actions.setMode('line', { purpose: 'planeLine', planeId: plane.id });
      };

      // ------------------------------------------------------------ direct edits on the canvas
      actions.addOutlet = (p) => {
        if (!isPt(p)) return null;
        const img = activeImage();
        if (!img) { actions.toast('Add a photo first.', 'warn'); return null; }
        const proj = P();
        const ui = U();
        // Outlets sit on walls: use the wall under the tap, never the active roof or ground plane.
        const hint = (ui.mode.opts && ui.mode.opts.planeId) || ui.activePlaneId;
        const planeId = wallForPoint(proj, img.id, p, hint) ||
          (findPlane(proj, ui.activePlaneId) ? ui.activePlaneId : null);
        let circuit = proj.circuits[0] || null;
        const newCircuit = circuit ? null : schema.createCircuit({ name: 'Circuit 1', breakerAmps: 15 });
        if (newCircuit) circuit = newCircuit;
        const outlet = schema.createOutlet({
          imageId: img.id, planeId, point: pt(p), label: nextOutletLabel(proj), type: 'exteriorGfci', gfci: true,
          circuitId: circuit.id, receptacles: 2,
        });
        store.commit('Place outlet', (d) => {
          if (newCircuit) d.circuits.push(newCircuit);
          d.outlets.push(outlet);
        });
        store.setUI(Object.assign(SELECT(), { selection: { kind: 'outlet', id: outlet.id } }));
        return outlet.id;
      };

      actions.moveVertex = (target, index, p, mopts) => {
        if (!target || !isPt(p)) return;
        // A drag move outside an open gesture would push one undo entry per pointer move: skip it.
        if (mopts && mopts.gesture && typeof store.inGesture === 'function' && !store.inGesture()) return;
        const q = pt(p);
        store.commit('Move point', (d) => {
          switch (target.kind) {
            case 'feature': {
              const f = byId(d.features, target.id);
              if (!f || !f.points[index]) return false;
              f.points[index] = q;
              return undefined;
            }
            case 'planeRect': {
              const pl = findPlane(d, target.planeId);
              if (!pl || !pl.rect || !pl.rect.corners[index]) return false;
              pl.rect.corners[index] = q;
              return undefined;
            }
            case 'planeLine': {
              const pl = findPlane(d, target.planeId);
              if (!pl || !pl.derived || !Array.isArray(pl.derived.line) || !pl.derived.line[index]) return false;
              pl.derived.line[index] = q;
              return undefined;
            }
            case 'ref': {
              const pl = findPlane(d, target.planeId);
              const r = pl ? byId(pl.refs, target.refId) : null;
              if (!r || !r.points[index]) return false;
              r.points[index] = q;
              return undefined;
            }
            case 'outlet': {
              const o = byId(d.outlets, target.id);
              if (!o) return false;
              o.point = q;
              return undefined;
            }
            default:
              return false;
          }
        }, { gesture: !!(mopts && mopts.gesture) });
      };
      /** Pick a traced item's point (pressed on the photo) so the editor can offer Delete point. */
      actions.setActiveVertex = (featureId, index) => {
        const cur = U().activeVertex;
        if (featureId == null) { if (cur) store.setUI({ activeVertex: null }); return; }
        if (cur && cur.featureId === featureId && cur.index === index) return;
        store.setUI({ activeVertex: { featureId, index } });
      };
      actions.insertVertex = (featureId, afterIndex, p) => {
        if (!isPt(p)) return;
        let at = null;
        const ok = store.commit('Add point', (d) => {
          const f = byId(d.features, featureId);
          const ft = f && FEATURE_TYPES[f.type];
          if (!f || (ft && ft.maxPoints && f.points.length >= ft.maxPoints)) return false;
          const i = Math.max(0, Math.min(f.points.length - 1, Math.round(afterIndex)));
          f.points.splice(i + 1, 0, pt(p));
          at = i + 1;
        });
        if (ok) store.setUI({ activeVertex: { featureId, index: at } });
      };
      actions.deleteVertex = (featureId, index) => {
        const f = byId(P().features, featureId);
        if (!f) return;
        const ft = FEATURE_TYPES[f.type];
        const min = Math.max(ft ? ft.minPoints : 2, f.closed ? 3 : 2);
        if (f.points.length <= min) {
          actions.toast((f.label || 'This item') + ' needs at least ' + min + ' points. Delete the whole item instead.', 'warn');
          return;
        }
        const ok = store.commit('Delete point', (d) => {
          const g = byId(d.features, featureId);
          if (!g || !g.points[index]) return false;
          g.points.splice(index, 1);
        });
        if (ok) store.setUI({ activeVertex: null });
      };
      actions.deleteSelection = () => {
        const sel = U().selection;
        if (!sel) return;
        if (sel.kind === 'feature') actions.deleteFeature(sel.id);
        else if (sel.kind === 'plane') actions.deletePlane(sel.id);
        else if (sel.kind === 'ref') actions.deleteRef(sel.planeId, sel.id);
        else if (sel.kind === 'outlet') actions.deleteOutlet(sel.id);
      };

      // ------------------------------------------------------------ entity edits
      actions.deleteFeature = (id) => {
        const f = byId(P().features, id);
        if (!f) return;
        store.commit('Delete ' + (f.label || 'item'), (d) => { d.features = d.features.filter((x) => x.id !== id); });
      };
      actions.updateFeature = (id, patch) => {
        if (!patch) return;
        store.commit('Edit item', (d) => {
          const f = byId(d.features, id);
          if (!f) return false;
          for (const k of Object.keys(patch)) {
            if (k === 'id') continue;
            if (k === 'params') f.params = Object.assign({}, f.params, patch.params);
            else f[k] = catalog.deepClone(patch[k]);
          }
        });
      };
      /**
       * "Give this run its own cord" (params.ownCord, SPEC §8.2): the runs get a cord from an outlet and no jumper
       * cord to or from another run. One undo step for all the given features (a cord can feed several runs).
       */
      actions.setOwnCord = (featureIds, on) => {
        const ids = arr(featureIds);
        if (!ids.length) return false;
        return store.commit(on ? 'Give a run its own cord' : 'Let a run share a cord', (d) => {
          let changed = false;
          for (const id of ids) {
            const f = byId(d.features, id);
            if (!f) continue;
            if (!f.params || typeof f.params !== 'object') f.params = {};
            if ((f.params.ownCord === true) !== !!on) { f.params.ownCord = !!on; changed = true; }
          }
          return changed ? undefined : false;
        });
      };
      /** Change a feature's type, keeping its points where the geometry allows it. */
      actions.changeFeatureType = (id, type) => {
        const f = byId(P().features, id);
        const ft = FEATURE_TYPES[type];
        if (!f || !ft || f.type === type) return;
        if ((ft.geometry === 'polygon' || ft.geometry === 'area') && f.points.length < 3) {
          actions.toast('A ' + ft.label.toLowerCase() + ' needs at least 3 points. Trace it again instead.', 'warn');
          return;
        }
        const old = FEATURE_TYPES[f.type];
        const defaultLabel = old && new RegExp('^' + old.short + ' \\d+$').test(f.label || '');
        const label = defaultLabel ? nextFeatureLabel(P(), type) : f.label;
        store.commit('Change type', (d) => {
          const g = byId(d.features, id);
          if (!g) return false;
          g.type = type;
          g.label = label;
          g.productId = null;
          g.params.mount = null;
          if (ft.geometry === 'vertical') { g.points = [g.points[0], g.points[g.points.length - 1]]; g.closed = false; }
          else if (ft.geometry === 'polygon' || ft.geometry === 'area') g.closed = true;
          else g.closed = !!ft.closedDefault;
        });
      };
      actions.updatePlane = (id, patch) => {
        if (!patch) return;
        store.commit('Edit surface', (d) => {
          const pl = findPlane(d, id);
          if (!pl) return false;
          for (const k of Object.keys(patch)) {
            if (k === 'id') continue;
            if (k === 'derived' && pl.derived && patch.derived) pl.derived = Object.assign({}, pl.derived, catalog.deepClone(patch.derived));
            else if (k === 'rect' && pl.rect && patch.rect) pl.rect = Object.assign({}, pl.rect, catalog.deepClone(patch.rect));
            else pl[k] = catalog.deepClone(patch[k]);
          }
        });
      };
      actions.updateRef = (planeId, refId, patch) => {
        if (!patch) return;
        store.commit('Edit reference', (d) => {
          const pl = findPlane(d, planeId);
          const r = pl ? byId(pl.refs, refId) : null;
          if (!r) return false;
          Object.assign(r, catalog.deepClone(patch));
        });
      };
      actions.deleteRef = (planeId, refId) => {
        store.commit('Delete reference', (d) => {
          const pl = findPlane(d, planeId);
          if (!pl || !byId(pl.refs, refId)) return false;
          pl.refs = pl.refs.filter((r) => r.id !== refId);
        });
      };
      actions.updateOutlet = (id, patch) => {
        if (!patch) return;
        store.commit('Edit outlet', (d) => {
          const o = byId(d.outlets, id);
          if (!o) return false;
          Object.assign(o, catalog.deepClone(patch));
          // A new type resets GFCI to that type's default (schema: only exterior GFCI outlets are protected), so an
          // indoor outlet feeding outdoor lights is never counted as GFCI unless the user ticks it.
          if (patch.type !== undefined && patch.gfci === undefined) o.gfci = patch.type === 'exteriorGfci';
        });
      };
      actions.deleteOutlet = (id) => {
        const o = byId(P().outlets, id);
        if (!o) return;
        store.commit('Delete ' + (o.label || 'outlet'), (d) => {
          d.outlets = d.outlets.filter((x) => x.id !== id);
          for (const f of d.features) if (f.params && f.params.outletId === id) f.params.outletId = null;
        });
      };
      actions.updateCircuit = (id, patch) => {
        if (!patch) return;
        store.commit('Edit circuit', (d) => {
          const c = byId(d.circuits, id);
          if (!c) return false;
          Object.assign(c, catalog.deepClone(patch));
        });
      };
      actions.addCircuit = () => {
        const p = P();
        const c = schema.createCircuit({ name: nextName(p.circuits.map((x) => x.name), 'Circuit', p.circuits.length + 1), breakerAmps: 15 });
        store.commit('Add circuit', (d) => { d.circuits.push(c); });
        return c.id;
      };
      actions.deleteCircuit = (id) => {
        const p = P();
        if (!byId(p.circuits, id)) return;
        if (p.circuits.length <= 1) { actions.toast('Keep at least one circuit. Rename it or change its breaker instead.', 'warn'); return; }
        store.commit('Delete circuit', (d) => {
          d.circuits = d.circuits.filter((c) => c.id !== id);
          const fallback = d.circuits[0] ? d.circuits[0].id : null;
          for (const o of d.outlets) if (o.circuitId === id) o.circuitId = fallback;
        });
      };
      actions.updateSettings = (patch) => {
        if (!patch) return;
        store.commit('Edit settings', (d) => { Object.assign(d.settings, catalog.deepClone(patch)); });
      };
      actions.updateQuote = (patch) => {
        if (!patch) return false;
        // Refuse values normalizeProject would rewrite, so a reload or import never changes the quote silently.
        for (const k of Object.keys(patch)) {
          const problem = schema.quoteFieldProblem(k, patch[k]);
          if (problem) { actions.toast(problem, 'warn'); return false; }
        }
        store.commit('Edit quote', (d) => { Object.assign(d.quote, catalog.deepClone(patch)); });
        return true;
      };
      actions.updateCustomer = (patch) => {
        if (!patch) return;
        store.commit('Edit customer', (d) => { Object.assign(d.customer, catalog.deepClone(patch)); });
      };
      actions.setProjectName = (name) => {
        store.commit('Rename plan', (d) => { d.name = String(name == null ? '' : name).trim().slice(0, 120); });
      };
      actions.setPriceOverride = (sku, price) => {
        if (!sku) return;
        store.commit(price == null ? 'Reset price' : 'Edit price', (d) => {
          if (!d.pricing || typeof d.pricing !== 'object') d.pricing = { overrides: {} };
          if (!d.pricing.overrides || typeof d.pricing.overrides !== 'object') d.pricing.overrides = {};
          if (price == null || !(Number.isFinite(price) && price >= 0)) delete d.pricing.overrides[sku];
          else d.pricing.overrides[sku] = Math.round(price * 100) / 100;
        });
      };
      actions.setLibraryProducts = (products) => {
        store.commit(products ? 'Edit products' : 'Reset products', (d) => {
          d.library.products = Array.isArray(products) && products.length ? catalog.deepClone(products) : null;
        });
      };
      actions.setLibraryConfig = (config) => {
        store.commit(config ? 'Edit rules of thumb' : 'Reset rules of thumb', (d) => {
          d.library.config = catalog.isPlainObject(config) && Object.keys(config).length ? catalog.deepClone(config) : null;
        });
      };
      actions.updateImageCamera = (imageId, patch) => {
        if (!patch) return;
        store.commit('Change lens', (d) => {
          const im = byId(d.images, imageId);
          if (!im) return false;
          im.camera = Object.assign({}, im.camera, catalog.deepClone(patch));
        });
      };
      /** Undo every per-run choice (product, color, forced outlet, own cord, direction) so the auto-plan applies again. */
      actions.resetAutoPlan = () => {
        const changed = store.commit('Reset to auto-plan', (d) => {
          for (const f of d.features) {
            f.productId = null;
            f.color = null;
            if (f.params) {
              f.params.outletId = null; f.params.reverse = false; f.params.mount = null;
              if (f.params.ownCord) f.params.ownCord = false;
            }
          }
        });
        actions.toast(changed ? 'Every run is back on the automatic plan.' : 'Every run already uses the automatic plan.', 'ok');
      };

      // ------------------------------------------------------------ planes
      actions.addPlane = (kind) => {
        const k = kind || 'wall';
        const p = P();
        const img = activeImage();
        if (!img) { actions.toast('Add a photo first.', 'warn'); return null; }
        if (k === 'wall') {
          const walls = p.planes.filter((x) => x.kind === 'wall');
          const pl = schema.createPlane({ kind: 'wall', imageId: img.id, name: nextName(p.planes.map((x) => x.name), 'Wall', walls.length + 1) });
          store.commit('Add wall', (d) => { d.planes.push(pl); });
          store.setUI(Object.assign(SELECT(), { activePlaneId: pl.id, selection: { kind: 'plane', id: pl.id } }));
          return pl.id;
        }
        const active = findPlane(p, U().activePlaneId);
        let parent = active && active.kind === 'wall' ? active : null;
        if (!parent && active && active.derived) parent = findPlane(p, active.derived.parentPlaneId);
        if (!parent) parent = p.planes.find((x) => x.kind === 'wall' && x.imageId === img.id) || null;
        if (!parent) { actions.toast('Add a wall first: roof slopes and the ground are worked out from a wall.', 'warn'); return null; }
        actions.setMode('line', { purpose: k === 'roof' ? 'roofEave' : 'groundBase', planeId: parent.id, pitch: null });
        return null;
      };
      actions.deletePlane = (id) => {
        const p = P();
        const pl = findPlane(p, id);
        if (!pl) return Promise.resolve(false);
        const children = p.planes.filter((x) => x.derived && x.derived.parentPlaneId === id);
        const ids = [id].concat(children.map((x) => x.id));
        const feats = p.features.filter((f) => ids.includes(f.planeId));
        const doDelete = () => store.commit('Delete ' + (pl.name || 'surface'), (d) => {
          d.planes = d.planes.filter((x) => !ids.includes(x.id));
          d.features = d.features.filter((f) => !ids.includes(f.planeId));
          for (const o of d.outlets) if (ids.includes(o.planeId)) o.planeId = null;
        });
        if (!feats.length && !children.length) return Promise.resolve(doDelete());
        const parts = [];
        if (feats.length) parts.push(feats.length === 1 ? '1 traced item' : feats.length + ' traced items');
        if (children.length) parts.push(children.map((c) => "'" + c.name + "'").join(', '));
        return actions.confirm({
          title: "Delete '" + pl.name + "'?",
          body: 'This also deletes ' + parts.join(' and ') + ' that ' + (feats.length + children.length === 1 ? 'depends' : 'depend') + ' on it. You can undo this.',
          confirmLabel: 'Delete', danger: true,
        }).then((ok) => (ok ? doDelete() : false));
      };

      // ------------------------------------------------------------ photos and whole projects
      /**
       * Decode photos for a project into the store: stored data URLs for real photos, a fresh render for the
       * sample. Resolves {missing: [image names]} (photos that were not saved with the project). hopts.persist:false
       * skips writing the photos back to storage (use it when they were just read from storage).
       */
      actions.hydrateImages = (project, imagesByKey, hopts) => {
        const write = !(hopts && hopts.persist === false);
        const tasks = arr(project && project.images).map((im) => {
          if (!im) return Promise.resolve(null);
          const key = im.storageKey;
          if (key === 'sample' || (im.source && im.source.kind === 'sample')) {
            try {
              const s = sample.createSample({ traced: false });
              store.setImage(im.id, imagesource.renderSample(s.primitives, s.width, s.height), null);
              return Promise.resolve(null);
            } catch (e) {
              return Promise.resolve(im.name || 'Sample house');
            }
          }
          const url = imagesByKey && key ? imagesByKey[key] : null;
          if (!url) return Promise.resolve(im.name || 'photo');
          // The data is there but cannot be decoded: damaged, not missing.
          return imagesource.loadElement(url).then((el) => { store.setImage(im.id, el, url, { persist: write }); return null; },
            () => ({ damaged: true, name: im.name || 'photo' }));
        });
        // missing lists every photo that did not load; damaged is the subset whose data was there but unreadable.
        return Promise.all(tasks).then((r) => ({
          missing: r.filter(Boolean).map((x) => (typeof x === 'string' ? x : x.name)),
          damaged: r.filter((x) => x && typeof x === 'object' && x.damaged).map((x) => x.name),
        }));
      };

      /** True when the current project holds work the user made (so replacing it should ask first). */
      function hasUserWork() {
        const p = P();
        if (!p) return false;
        const img = activeImage();
        if (img && img.source && img.source.kind === 'sample') {
          // A sample is work once it differs from a fresh copy (practice tracing, edits to the traced plan).
          const key = (q) => JSON.stringify([q.planes, q.features, q.outlets, q.circuits]);
          const mine = key(p);
          try {
            for (const traced of [true, false]) {
              if (key(schema.normalizeProject(sample.createSample({ traced }).project)) === mine) return false;
            }
          } catch (e) { /* no fresh sample to compare with: fall through to the content check */ }
        }
        return p.features.length > 0 || p.outlets.length > 0 || p.planes.some((pl) => pl.rect || pl.refs.length);
      }
      actions.hasUserWork = hasUserWork;
      /** Ask before a new photo or project replaces the user's own work. Resolves true to go ahead. */
      actions.confirmReplace = () => {
        if (!hasUserWork()) return Promise.resolve(true);
        return actions.confirm({
          title: 'Replace this plan?',
          body: 'Starting from a new photo replaces your current plan. Save the project first if you want to keep it.',
          confirmLabel: 'Replace plan', danger: true,
        });
      };

      /** A fresh project that keeps the user's settings, product library, prices and quote setup. */
      function freshProject() {
        const prev = P();
        const proj = schema.createProject({
          now: nowIso(),
          settings: prev ? prev.settings : undefined,
          quote: prev ? prev.quote : undefined,
        });
        if (prev) {
          proj.library = catalog.deepClone(prev.library) || { products: null, config: null };
          proj.pricing = catalog.deepClone(prev.pricing) || { overrides: {} };
        }
        return proj;
      }

      actions.loadImageFile = (file, lopts) => {
        const kind = lopts && lopts.sourceKind === 'camera' ? 'camera' : 'upload';
        const src = kind === 'camera' ? imagesource.CameraImageSource : imagesource.FileImageSource;
        store.setUI({ busy: 'Opening the photo…' });
        return src.acquire(file).then((img) => imagesource.loadElement(img.dataUrl).then((el) => {
          const proj = freshProject();
          const imageId = schema.uid('img');
          const image = schema.createImage({
            id: imageId, name: img.name, width: img.width, height: img.height,
            source: { kind: img.source.kind, capturedAt: img.source.capturedAt, attribution: img.source.attribution },
            exif: img.exif, camera: { mode: 'auto', presetId: 'phone1x', focalPx: null }, storageKey: imageId,
          });
          const wall = schema.createPlane({ kind: 'wall', imageId, name: 'Front wall' });
          proj.images = [image];
          proj.activeImageId = imageId;
          proj.planes = [wall];
          store.replaceProject(proj, { resetHistory: true });
          store.setImage(imageId, el, img.dataUrl);
          // Day view: a new photo has no lights yet, and calibrating needs the photo at full brightness.
          store.setUI(Object.assign(SELECT(), {
            busy: null, step: 1, activePlaneId: wall.id, selection: null, bannerDismissed: false,
            view: Object.assign({}, U().view, { night: false, twinkle: false }),
          }));
          const lens = img.exif && img.exif.focal35 ? 'The lens was read from the photo.' : 'The photo has no lens data, so LightPlan will work it out.';
          actions.toast('Photo added. ' + lens + ' Tap Next to calibrate.', 'ok');
          return true;
        })).catch((e) => {
          store.setUI({ busy: null });
          actions.toast(e && e.message ? e.message : 'The photo could not be opened.', 'error');
          return false;
        });
      };

      /**
       * Load the sample house. Asks first when it would replace the user's own work (sopts.confirm:false skips the
       * question), and the replace is undoable: undo history is kept and no stored photo is deleted.
       */
      actions.loadSample = (sopts) => {
        const traced = !(sopts && sopts.traced === false);
        const ask = sopts && sopts.confirm === false ? Promise.resolve(true) : actions.confirmReplace();
        return ask.then((go) => {
          if (!go) return false;
          return imagesource.SampleImageSource.acquire({ traced }).then((res) => loadSampleResult(res));
        }).catch((e) => {
          actions.toast(e && e.message ? e.message : 'The sample house could not be loaded.', 'error');
          return false;
        });
      };
      function loadSampleResult(res) {
        const proj = schema.normalizeProject(res.sample.project);
        const t = nowIso();
        proj.createdAt = t;
        proj.updatedAt = t;
        store.replaceProject(proj, { resetHistory: false, label: 'Load sample house' });
        store.setImage(proj.images[0].id, res.canvas, null);
        const wall = proj.planes.find((x) => x.kind === 'wall');
        store.setUI(Object.assign(SELECT(), {
          step: 1, selection: null, activePlaneId: wall ? wall.id : null, bannerDismissed: false,
          view: Object.assign({}, U().view, { preview: true, night: true }),
        }));
        return true;
      }

      actions.newProject = () => {
        store.replaceProject(freshProject(), { resetHistory: true });
        store.setUI(Object.assign(SELECT(), { step: 1, selection: null, activePlaneId: null }));
      };

      actions.startOver = () => actions.confirm({
        title: 'Start over?',
        body: 'This deletes your plan and photo from this browser. Save the project first if you want to keep it.',
        confirmLabel: 'Delete and start over', danger: true,
      }).then((ok) => {
        if (!ok) return false;
        return persist.clear().then(() => {
          store.clearImages();
          store.replaceProject(schema.createProject({ now: nowIso() }), { resetHistory: true });
          const d = storeModule.defaultUI();
          store.setUI({ step: 1, mode: d.mode, draft: d.draft, selection: null, activePlaneId: null, calib: d.calib, bannerDismissed: false, toast: null });
          // No toast: the empty-state card already asks for a photo, and a toast would cover it on a phone.
          return true;
        });
      });

      function readText(file) {
        if (file && typeof file.text === 'function') return file.text();
        return new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error('The file could not be read.'));
          fr.readAsText(file);
        });
      }

      actions.importProjectFile = (file) => {
        if (!file) return Promise.resolve(false);
        const exp = typeof LP !== 'undefined' && LP.has('ui.export') ? LP.require('ui.export') : null;
        const read = exp && typeof exp.importJsonFile === 'function'
          ? Promise.resolve().then(() => exp.importJsonFile(file))
          : readText(file).then((text) => schema.importProject(text));
        store.setUI({ busy: 'Opening the project…' });
        return read.then((res) => {
          const proj = schema.normalizeProject(res && res.project);
          store.replaceProject(proj, { resetHistory: true });
          return actions.hydrateImages(proj, (res && res.images) || {}).then((h) => {
            const hasImage = proj.images.length > 0;
            store.setUI(Object.assign(SELECT(), {
              busy: null, selection: null, bannerDismissed: false,
              step: proj.features.length ? 6 : hasImage ? 2 : 1,
            }));
            const name = proj.name ? "'" + proj.name + "'" : 'the project';
            if (h.damaged && h.damaged.length) actions.toast('Opened ' + name + ', but the photo in this file is damaged and could not be opened. The plan and measurements are kept; choose the photo again to see it.', 'warn');
            else if (h.missing.length) actions.toast('Opened ' + name + ', but its photo was not saved in the file. The plan and measurements are kept.', 'warn');
            else actions.toast('Opened ' + name + '.', 'ok');
            return true;
          });
        }).catch((e) => {
          store.setUI({ busy: null });
          actions.toast(e && e.message ? e.message : 'This file is not a LightPlan project.', 'error');
          return false;
        });
      };

      return actions;
    }

    return { createActions, parseLength, nextFeatureLabel, nextOutletLabel, wallForPoint, KINDS_FOR_TYPE };
  });
