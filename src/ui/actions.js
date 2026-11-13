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
 *    dismissToast, confirmReplace, hydrateImages, removePlaneRect, setOwnCord(featureIds, on), finishTracing.
 *  - Suppliers (SPEC §8.3): setSupplier(id) sets or clears project.library.supplierId ("Buy from"), and
 *    setBuying({style, costBasis}) edits library.config.buying, storing only what differs from the defaults. Each
 *    is one undo step and returns true when it changed the project.
 *  - Finishing a trace puts the tool down (mode 'select', the new item picked) and sets ui.afterTrace
 *    {featureId, type}: the hint bar then shows the item's length and offers what to trace next. It is cleared by
 *    starting any tool, picking something else, changing step, or finishTracing().
 *  - loadImageFile opens step 2 (set the scale) once the photo is in, and says so.
 *  - Tap precision (SPEC §8.4): addDraftPoint(p, {tapErr}), moveVertex(target, index, p, {gesture, tapErr}) and
 *    insertVertex(featureId, afterIndex, p, {tapErr}) take the point's expected tap error in stored-image px from
 *    the viewport. It is stored index for index beside the points as rect.tapErr, ref.tapErr, feature.tapErr and
 *    plane.derived.tapErr, and kept aligned through insert, delete, move, type changes, undo and redo. Points made
 *    by code carry none: an item gets a list only once a person tapped one of its points, and its other points
 *    then hold 2.5 (the precision measure.js assumes when it knows nothing).
 *  - deletePlane(id) returns a Promise<bool> (it asks first when traced items would be deleted with it).
 *  - addCircuit() returns the new circuit id; addPlane('wall') returns the new plane id.
 *  - loadSample({traced, confirm}) asks before replacing the user's work (confirm:false skips) and is undoable.
 *  - startTrace picks the surface by type (KINDS_FOR_TYPE); a walkway/stakes with no ground plane first starts the
 *    ground base line tool (line purpose 'groundBase' with opts.thenTrace) and then traces on the new ground.
 *  - addOutlet puts the outlet on the wall under the tap (wallForPoint), never on a roof or ground plane.
 *  - Module exports also parseLength(text) → feet | null, nextFeatureLabel, nextOutletLabel, wallForPoint,
 *    KINDS_FOR_TYPE, isSmallPhoto(image) (under 1,000 px wide: loadImageFile warns, and the Upload and Calibrate
 *    panels keep saying so).
 *  - Mansard roofs: addPlane('steep') draws the line where a steep roof face starts on a wall (line purpose
 *    'roofEave' with opts.steep) and makes a roof plane with derived.steep true and derived.angleDeg 70;
 *    addPlane('upper') draws the line where a steep face ends (opts.upper, planeId = the steep face) and makes a roof
 *    plane whose parent is that face. setSteepAngle(planeId, deg) stores a typical angle (a guess) and
 *    setSteepMeasured(planeId, {upFt, backFt, slopeFt}) stores two tape numbers as derived.pitch (measured).
 *  - Items on the wrong surface (measure.misplacedFeatures): putOnRoof(featureId, planeId?) moves a ridge drawn on a
 *    wall to a roof surface that hangs off that wall, or starts the eave line (opts.thenMove) and moves the item when
 *    the roof exists, as one undo step. typeLength(featureId) opens the item's tape-measured length field
 *    (ui.focusTape, which the panels follow).
 *    A roof whose starting line does not lie under the item is never picked for it. With nothing to pick,
 *    putOnRoof asks what kind of roof it is (ui.roofAsk; drawRoofFor(featureId, 'roof' | 'steep') then draws its
 *    line). After a move the result is checked (moveVerdict): a length much longer than on the wall, or an item
 *    below the roof's starting line, is reported as looking wrong, and a roof seen almost edge-on as rough
 *    (ui.moveNote in step 3, a warning message elsewhere), never as a success. useSteepInstead(featureId) undoes
 *    such a move and draws a steep roof face for the item. putOnPlane(featureId, planeId) moves an item that was
 *    drawn below its roof's starting line to a surface under it.
 *  - On a mansard the surface follows where the item is traced (mansardSurfaceFor): between the bottom line and
 *    the trim line of a steep face it goes on that face, above the trim line on the upper roof, at or below the
 *    bottom line back on the wall. A surface picked by hand for the trace (opts.planePicked) is kept.
 *  - Module exports also surfaceKind, SURFACE_LABEL, surfaceOptionLabel, wallOfPlane, typeFitsSurface,
 *    pickRoofCandidate, mansardSurfaceFor, steepAngleText and STEEP_ANGLES.
 *  - goStep clears the toast (a message about one step does not follow the user to the next), and starting a
 *    walkway with no ground plane no longer toasts what the hint bar already says.
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

    // ---------------------------------------------------------------- tap precision (SPEC §8.4)
    // Beside every tapped point list (rect.corners, ref.points, feature.points, derived.line) an optional tapErr
    // list holds each point's expected tap error in stored-image px, index for index. The viewport supplies the
    // value when a point is placed or dragged; a point with no information holds TAP_ERR_FLOOR, which is what
    // measure.js assumes anyway. Lists exist only where at least one point was tapped by a person.
    const TAP_ERR_FLOOR = 2.5;
    const TAP_ERR_CEIL = 80;
    const isTapErr = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const fitTapErr = (v) => Math.round(Math.min(TAP_ERR_CEIL, Math.max(TAP_ERR_FLOOR, v)) * 100) / 100;
    /** n values (TAP_ERR_FLOOR where unknown), or null when none of the first n is known. */
    function tapErrList(list, n) {
      const src = arr(list);
      const out = [];
      let any = false;
      for (let i = 0; i < n; i++) {
        if (isTapErr(src[i])) { out.push(fitTapErr(src[i])); any = true; } else out.push(TAP_ERR_FLOOR);
      }
      return any ? out : null;
    }
    /** holder.tapErr as a clean list aligned with its n points, or null when it is missing or misaligned. */
    function alignedTapErr(holder, n) {
      const t = holder && holder.tapErr;
      return Array.isArray(t) && t.length === n ? t.map((v) => (isTapErr(v) ? fitTapErr(v) : TAP_ERR_FLOOR)) : null;
    }
    /**
     * Record the precision of point `index` of a holder with n points after it was placed or dragged.
     * opts.tapErr: a number = how well it was placed; null = it was snapped onto a point with no value; absent =
     * moved by code (the list is left alone).
     */
    function putTapErr(holder, n, index, opts) {
      if (!holder || !opts || !Object.prototype.hasOwnProperty.call(opts, 'tapErr')) return;
      const cur = alignedTapErr(holder, n);
      if (isTapErr(opts.tapErr)) {
        const next = cur || new Array(n).fill(TAP_ERR_FLOOR);
        next[index] = fitTapErr(opts.tapErr);
        holder.tapErr = next;
      } else if (cur) {
        cur[index] = TAP_ERR_FLOOR;
        holder.tapErr = cur;
      } else if (holder.tapErr !== undefined) delete holder.tapErr;
    }
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

    /** A photo under this many px wide is too coarse to place corners well (a thumbnail, a small screenshot). */
    const SMALL_PHOTO_PX = 1000;
    function isSmallPhoto(image) {
      return !!(image && Number.isFinite(image.width) && image.width > 0 && image.width < SMALL_PHOTO_PX &&
        !(image.source && image.source.kind === 'sample'));
    }

    /** Surface kinds each feature type can lie on; the first is preferred when the active surface does not fit. */
    const KINDS_FOR_TYPE = {
      roofline: ['wall'], gutter: ['wall'], window: ['wall'], door: ['wall'], railing: ['wall'], column: ['wall'], bush: ['wall'],
      rake: ['wall', 'roof'], tree: ['wall', 'ground'], ridge: ['roof', 'wall'], walkway: ['ground'], stakes: ['ground'],
    };

    // ---------------------------------------------------------------- kinds of surface
    /**
     * What a surface is to the person using it: 'wall', 'roof' (an ordinary roof slope), 'steep' (a steep roof
     * face, as on a mansard), 'upper' (a roof that starts at the top of another roof face) or 'ground'.
     */
    function surfaceKind(project, plane) {
      if (!plane || typeof plane !== 'object') return 'wall';
      if (plane.kind === 'ground') return 'ground';
      if (plane.kind !== 'roof') return 'wall';
      if (plane.derived && plane.derived.steep === true) return 'steep';
      const parent = plane.derived ? byId(project && project.planes, plane.derived.parentPlaneId) : null;
      return parent && parent.kind === 'roof' ? 'upper' : 'roof';
    }
    const SURFACE_LABEL = { wall: 'Wall', roof: 'Roof slope', steep: 'Steep roof face', upper: 'Upper roof', ground: 'Ground' };
    const SURFACE_WORD = { wall: 'wall', roof: 'roof', steep: 'steep roof', upper: 'upper roof', ground: 'ground' };
    /** "Front yard · ground", but just "Front wall" or "Steep roof face 1" when the name already says what it is. */
    function surfaceOptionLabel(project, plane) {
      const sk = surfaceKind(project, plane);
      const name = (plane && typeof plane.name === 'string' && plane.name.trim()) || SURFACE_LABEL[sk];
      const base = plane && plane.kind === 'roof' ? 'roof' : sk;
      return name.toLowerCase().indexOf(base) >= 0 ? name : name + ' · ' + SURFACE_WORD[sk];
    }
    /** The wall a surface hangs off: itself for a wall, else up through its parents. null when there is none. */
    function wallOfPlane(project, plane) {
      const seen = new Set();
      let cur = plane || null;
      while (cur && cur.kind !== 'wall' && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = cur.derived ? byId(project && project.planes, cur.derived.parentPlaneId) : null;
      }
      return cur && cur.kind === 'wall' ? cur : null;
    }
    // What else can be traced on the faces of a mansard: the trim line and gutter along a steep face, dormer
    // outlines on it, and the top edge of the upper roof.
    const MANSARD_TYPES = { steep: ['roofline', 'gutter', 'window'], upper: ['roofline', 'gutter'] };
    /** Can this type of item be measured on this surface? */
    function typeFitsSurface(project, type, plane) {
      if (!plane) return false;
      if ((KINDS_FOR_TYPE[type] || ['wall']).includes(plane.kind)) return true;
      const extra = MANSARD_TYPES[surfaceKind(project, plane)];
      return !!extra && extra.includes(type);
    }
    /**
     * The surface a traced item belongs on when it is drawn over a mansard, from where its points are in the photo:
     * between the bottom line and the trim line of a steep face → that face; above the trim line → its upper roof;
     * at or below the bottom line → the wall, but only when `current` is one of that mansard's roof surfaces (an
     * item on the wall or the ground stays where the user put it). null when no steep face lies under the points,
     * or the type cannot be measured on that surface.
     */
    function mansardSurfaceFor(project, imageId, points, type, current) {
      const pts = arr(points).filter(isPt);
      if (!pts.length || !project) return null;
      const cx = pts.reduce((t, q) => t + q[0], 0) / pts.length, cy = pts.reduce((t, q) => t + q[1], 0) / pts.length;
      const lineOf = (pl) => { const l = pl && pl.derived ? arr(pl.derived.line).filter(isPt) : []; return l.length >= 2 ? l : null; };
      const yAt = (l, x) => (Math.abs(l[1][0] - l[0][0]) < 1e-9 ? (l[0][1] + l[1][1]) / 2 : l[0][1] + ((x - l[0][0]) / (l[1][0] - l[0][0])) * (l[1][1] - l[0][1]));
      for (const face of arr(project.planes)) {
        if (!face || surfaceKind(project, face) !== 'steep' || (imageId && face.imageId !== imageId)) continue;
        const bottom = lineOf(face);
        if (!bottom) continue;
        const l0 = Math.min(bottom[0][0], bottom[1][0]), l1 = Math.max(bottom[0][0], bottom[1][0]);
        const margin = 0.1 * (l1 - l0);
        if (cx < l0 - margin || cx > l1 + margin) continue;
        const upper = arr(project.planes).find((x) => x && x.kind === 'roof' && x.derived && x.derived.parentPlaneId === face.id && lineOf(x)) || null;
        const yBottom = yAt(bottom, cx);
        const yTrim = upper ? yAt(lineOf(upper), cx) : null;
        const tol = Math.max(8, yTrim != null ? 0.15 * Math.abs(yBottom - yTrim) : 12);
        let plane;
        if (cy > yBottom - tol) {
          const mine = current && (current.id === face.id || (upper && current.id === upper.id));
          plane = mine ? wallOfPlane(project, face) : null;
        } else if (yTrim != null && cy < yTrim - tol) plane = upper;
        else plane = face;
        return plane && typeFitsSurface(project, type, plane) ? plane : null;
      }
      return null;
    }
    /** Typical slopes of a steep roof face, in degrees from level, for the picker (70 is the default). */
    const STEEP_ANGLES = [60, 65, 70, 75, 80];
    /** "70°" for a steep face's slope, from its solution (sol.pitch.angleDeg) or its stored data. */
    function steepAngleText(angleDeg) {
      return Number.isFinite(angleDeg) ? Math.round(angleDeg) + '°' : '';
    }
    /**
     * The roof surface an item moves to, from measure.misplacedFeatures' candidates (best first): among the ones
     * that rank the same as the first (measurable, ordinary roofs before steep faces), the one whose starting line
     * lies most under the item on the photo, so a ridge over the garage goes to the garage roof. null when no
     * roof starts under the item (candidate.under false) or the item lies below every roof's line.
     */
    function pickRoofCandidate(project, feature, candidates) {
      // A roof that starts beside the item, or above it, is another roof: it is never picked (the caller asks).
      const list = arr(candidates).filter((c) => c && c.under !== false && !c.below);
      if (!list.length) return null;
      const top = list.filter((c) => c.ok === list[0].ok && !!c.steep === !!list[0].steep);
      const xs = arr(feature && feature.points).filter(isPt).map((q) => q[0]);
      if (top.length < 2 || !xs.length) return top[0];
      const f0 = Math.min.apply(null, xs), f1 = Math.max.apply(null, xs);
      let best = top[0];
      let bestScore = -Infinity;
      for (const c of top) {
        const pl = byId(project && project.planes, c.planeId);
        const line = pl && pl.derived ? arr(pl.derived.line).filter(isPt) : [];
        if (line.length < 2) continue;
        const l0 = Math.min(line[0][0], line[1][0]), l1 = Math.max(line[0][0], line[1][0]);
        // Overlap along the photo when there is some, else minus the gap between them.
        const score = Math.min(f1, l1) - Math.max(f0, l0);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best;
    }

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
      let focusSeq = 0;
      let scrollSeq = 0;

      const SELECT = () => ({ mode: { name: 'select', opts: {} }, draft: { points: [] }, afterTrace: null, moveNote: null, roofAsk: null });

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
        // A message about the step being left does not follow the user to the next one.
        store.setUI(Object.assign({ step, selection: null, toast: null }, SELECT()));
      };
      actions.select = (sel) => {
        // Picking anything but the item just traced (or nothing) ends the "trace next" offer in the hint bar.
        const at = U().afterTrace;
        const keep = !!(at && sel && sel.kind === 'feature' && sel.id === at.featureId);
        if (!sel) { store.setUI(at ? { selection: null, afterTrace: null } : { selection: null }); return; }
        const patch = { selection: Object.assign({}, sel) };
        if (at && !keep) patch.afterTrace = null;
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
          // Picked by hand for this trace: the mansard rule (mansardSurfaceFor) leaves it alone.
          patch.mode = { name: ui.mode.name, opts: Object.assign({}, ui.mode.opts, { planeId: id, planePicked: true }) };
        }
        store.setUI(patch);
      };
      actions.setView = (patch) => store.setUI({ view: Object.assign({}, U().view, patch || {}) });
      actions.setCalib = (patch) => store.setUI({ calib: Object.assign({}, U().calib, patch || {}) });
      actions.setSheet = (sheet) => { if (['min', 'half', 'full'].includes(sheet)) store.setUI({ sheet }); };
      actions.dismissBanner = () => store.setUI({ bannerDismissed: true });

      // ------------------------------------------------------------ tools and drafts
      actions.setMode = (name, opts) => {
        const patch = { mode: { name: name || 'select', opts: Object.assign({}, opts || {}) }, draft: { points: [] }, afterTrace: null, moveNote: null, roofAsk: null };
        if (name && name !== 'select' && name !== 'pan') patch.selection = null;
        store.setUI(patch);
      };
      actions.cancelDraft = () => {
        // A line started from another step (Review's "Put it on the roof") goes back there when it is cancelled.
        const back = U().mode && U().mode.opts ? U().mode.opts.returnStep : null;
        const ask = U().roofAsk;
        const step = Number.isInteger(back) ? back : ask && Number.isInteger(ask.returnStep) ? ask.returnStep : null;
        store.setUI(step != null && step !== U().step ? Object.assign(SELECT(), { step }) : SELECT());
      };

      /**
       * Add a tapped point to the tool in use. meta.tapErr (optional): the point's expected tap error in image px
       * (SPEC §8.4), kept beside the draft points and stored with the finished item.
       */
      actions.addDraftPoint = (p, meta) => {
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
        const errs = arr(ui.draft && ui.draft.tapErr).slice(0, pts.length);
        while (errs.length < pts.length) errs.push(null);
        errs.push(meta && isTapErr(meta.tapErr) ? fitTapErr(meta.tapErr) : null);
        const patch = { draft: { points: next, tapErr: errs } };
        if (mode.name === 'trace' && mode.opts && !mode.opts.planePicked) {
          // On a mansard the surface follows where the item is drawn, unless one was picked by hand for this trace.
          const proj = P();
          const img = activeImage();
          const cur = findPlane(proj, mode.opts.planeId);
          const auto = mansardSurfaceFor(proj, img ? img.id : null, next, mode.opts.type, cur);
          if (auto && auto.id !== mode.opts.planeId) {
            patch.mode = { name: 'trace', opts: Object.assign({}, mode.opts, { planeId: auto.id }) };
            patch.activePlaneId = auto.id;
          }
        }
        store.setUI(patch);
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
        if (pts.length) store.setUI({ draft: { points: pts.slice(0, -1), tapErr: arr(U().draft.tapErr).slice(0, pts.length - 1) } });
      };

      /** Finish the current drawing tool. Returns true when something was created. */
      actions.completeDraft = (copts) => {
        const ui = U();
        const mode = ui.mode || {};
        const o = mode.opts || {};
        const pts = arr(ui.draft && ui.draft.points).map(pt);
        const errs = (n) => tapErrList(ui.draft && ui.draft.tapErr, n);   // null when no point was tapped by a person
        const p = P();
        if (mode.name === 'rect') {
          if (pts.length < 4) { actions.toast('Tap all 4 corners first.', 'warn'); return false; }
          const plane = findPlane(p, o.planeId);
          if (!plane) { actions.cancelDraft(); return false; }
          if (o.purpose === 'refRect') {
            const ref = measure.refFromPreset(o.presetId || 'custom-rect', pts.slice(0, 4), {
              widthFt: o.widthFt, heightFt: o.heightFt, id: schema.uid('ref'),
            });
            if (errs(4)) ref.tapErr = errs(4);
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
            if (errs(4)) pl.rect.tapErr = errs(4);
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
            // A roof is one of three things: an ordinary slope, a steep face (a mansard), or the upper roof that
            // starts where a steep face ends (its line is drawn on that face, so its parent is a roof).
            const sk = kind !== 'roof' ? 'ground' : o.steep ? 'steep' : plane.kind === 'roof' ? 'upper' : 'roof';
            const count = (k) => p.planes.filter((x) => surfaceKind(p, x) === k).length + 1;
            const name = nextName(names, SURFACE_LABEL[sk], count(sk));
            const derived = { parentPlaneId: plane.id, line, pitch: kind === 'roof' && o.pitch ? o.pitch : null };
            if (sk === 'steep') { derived.steep = true; derived.angleDeg = measure.STEEP ? measure.STEEP.defaultDeg : 70; }
            const np = schema.createPlane({ kind, imageId: plane.imageId, name, derived });
            if (errs(2) && np.derived) np.derived.tapErr = errs(2);
            // Made to hold an item that was drawn on the wall (putOnRoof): the roof and the move are one undo step.
            const moved = o.thenMove ? byId(p.features, o.thenMove) : null;
            if (moved) {
              const before = lengthNow(moved.id);
              store.commit('Put ' + (moved.label || 'item') + ' on a new ' + (sk === 'steep' ? 'steep roof face' : 'roof slope'), (d) => {
                d.planes.push(np);
                const f = byId(d.features, moved.id);
                if (f) f.planeId = np.id;
              });
              store.setUI(Object.assign(SELECT(), { activePlaneId: np.id, selection: { kind: 'feature', id: moved.id } }));
              reportMove(moved.id, np.id, before, true);
              return true;
            }
            const label = { roof: 'Add roof slope', steep: 'Add steep roof face', upper: 'Add upper roof', ground: 'Add ground plane' }[sk];
            store.commit(label, (d) => { d.planes.push(np); });
            scrollSeq += 1;
            store.setUI(Object.assign(SELECT(), { activePlaneId: np.id, selection: { kind: 'plane', id: np.id } },
              sk === 'steep' || sk === 'upper' ? { scrollTo: { key: sk === 'steep' ? 'steep' : 'upper-pitch', planeId: np.id, n: scrollSeq } } : {}));
            // What comes next is further down the panel: say so (the panels scroll to it, ui.scrollTo).
            if (sk === 'steep') actions.toast('Steep roof face added. Now say how steep it is, then add the upper roof.', 'ok');
            else if (sk === 'upper') actions.toast('Upper roof added. Now pick its pitch. The top of a mansard is usually flatter than the rest of the house.', 'ok');
            // Made on the way to tracing a walkway (startTrace): carry on with that trace on the new ground.
            if (o.thenTrace && FEATURE_TYPES[o.thenTrace]) actions.startTrace(o.thenTrace);
            return true;
          }
          if (o.purpose === 'planeLine') {
            store.commit('Redraw line', (d) => {
              const pl = findPlane(d, plane.id);
              if (!pl || !pl.derived) return false;
              pl.derived.line = line;
              if (errs(2)) pl.derived.tapErr = errs(2); else delete pl.derived.tapErr;
            });
            store.setUI(Object.assign(SELECT(), { selection: { kind: 'plane', id: plane.id }, activePlaneId: plane.id }));
            return true;
          }
          const ref = measure.refFromPreset(o.presetId || 'custom-line', line, {
            lengthFt: o.lengthFt, courses: o.courses, id: schema.uid('ref'),
          });
          if (errs(2)) ref.tapErr = errs(2);
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
          if (errs(feature.points.length)) feature.tapErr = errs(feature.points.length);
          store.commit('Trace ' + ft.short.toLowerCase(), (d) => { d.features.push(feature); });
          // The tool is put down: the new item is picked (its points can be dragged) and the hint bar shows its
          // length and offers what to trace next (ui.afterTrace) instead of an empty trace with a disabled Finish.
          store.setUI(Object.assign(SELECT(), { selection: { kind: 'feature', id: feature.id }, afterTrace: { featureId: feature.id, type: o.type } }));
          return true;
        }
        return false;
      };

      /**
       * "Done" after tracing (hint bar, pinned button): what is being traced is kept when it has enough points,
       * then the tool is put down and nothing is picked.
       */
      actions.finishTracing = () => {
        const ui = U();
        if (ui.mode.name === 'trace') {
          const ft = FEATURE_TYPES[ui.mode.opts && ui.mode.opts.type];
          const need = ft ? Math.max(ft.minPoints || 2, ft.geometry === 'polygon' || ft.geometry === 'area' ? 3 : 2) : 2;
          if (arr(ui.draft && ui.draft.points).length >= need && actions.completeDraft()) {
            // A ridge that ended up on a wall comes out too short: keep it picked so the hint bar can offer the fix.
            const at = U().afterTrace;
            let m = null;
            try { m = at ? store.plan().measured.features[at.featureId] : null; } catch (e) { m = null; }
            if (m && m.wrongSurface === 'roof') return;
          }
        }
        store.setUI(Object.assign(SELECT(), { selection: null }));
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
       * walkways and stakes go on the ground, ridges on a roof (also when a wall is active, if a roof exists), rakes on a wall or roof, trees on a wall or the
       * ground, and everything else (eaves, gutters, windows, doors, railings, columns, bushes) on a wall: the
       * parent wall of an active roof/ground plane, else the first wall. Returns {plane, needGround}.
       */
      function planeForType(type) {
        const p = P();
        const img = activeImage();
        const planes = p.planes.filter((x) => !img || x.imageId === img.id);
        const active = byId(planes, U().activePlaneId);
        const allowed = KINDS_FOR_TYPE[type] || ['wall'];
        // A ridge sits on a roof: with a wall active it goes on a roof above that wall when there is one (measured
        // on the wall it comes out too short). The surface picker in the hint bar can still put it anywhere.
        const roofs = planes.filter((x) => x.kind === 'roof');
        const home = wallOfPlane(p, active);
        const rank = (x) => (home && wallOfPlane(p, x) === home ? 0 : 2) + (surfaceKind(p, x) === 'steep' ? 1 : 0);
        const roof = roofs.slice().sort((x, y) => rank(x) - rank(y))[0] || null;
        if (active && typeFitsSurface(p, type, active) && !(allowed[0] === 'roof' && active.kind === 'wall' && roof)) return { plane: active };
        if (allowed[0] === 'ground') {
          const ground = planes.find((x) => x.kind === 'ground');
          return ground ? { plane: ground } : { plane: null, needGround: true };
        }
        if (allowed[0] === 'roof' && roof) return { plane: roof };
        const wall = wallOfPlane(p, active) || planes.find((x) => x.kind === 'wall');
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
          // The hint bar explains why (opts.thenTrace); a toast with the same sentence would only cover the wall.
          store.setUI({ traceType: type });
          actions.setMode('line', { purpose: 'groundBase', planeId: wall.id, pitch: null, thenTrace: type });
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

      /**
       * Move one point of a traced item, a rectangle, a reference, an eave / base line or an outlet. mopts:
       * {gesture} (part of an open drag) and, from the viewport, {tapErr}: how well the point was placed (image px;
       * null = snapped onto a point with no value), stored at the same index of the item's tapErr list.
       */
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
              putTapErr(f, f.points.length, index, mopts);
              return undefined;
            }
            case 'planeRect': {
              const pl = findPlane(d, target.planeId);
              if (!pl || !pl.rect || !pl.rect.corners[index]) return false;
              pl.rect.corners[index] = q;
              putTapErr(pl.rect, pl.rect.corners.length, index, mopts);
              return undefined;
            }
            case 'planeLine': {
              const pl = findPlane(d, target.planeId);
              if (!pl || !pl.derived || !Array.isArray(pl.derived.line) || !pl.derived.line[index]) return false;
              pl.derived.line[index] = q;
              putTapErr(pl.derived, pl.derived.line.length, index, mopts);
              return undefined;
            }
            case 'ref': {
              const pl = findPlane(d, target.planeId);
              const r = pl ? byId(pl.refs, target.refId) : null;
              if (!r || !r.points[index]) return false;
              r.points[index] = q;
              putTapErr(r, r.points.length, index, mopts);
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
      actions.insertVertex = (featureId, afterIndex, p, iopts) => {
        if (!isPt(p)) return;
        let at = null;
        const ok = store.commit('Add point', (d) => {
          const f = byId(d.features, featureId);
          const ft = f && FEATURE_TYPES[f.type];
          if (!f || (ft && ft.maxPoints && f.points.length >= ft.maxPoints)) return false;
          const i = Math.max(0, Math.min(f.points.length - 1, Math.round(afterIndex)));
          // Keep the tap-precision list in step: the new point takes the value given, else "no information".
          const errs = alignedTapErr(f, f.points.length);
          const given = iopts && isTapErr(iopts.tapErr) ? fitTapErr(iopts.tapErr) : null;
          f.points.splice(i + 1, 0, pt(p));
          if (errs) { errs.splice(i + 1, 0, given === null ? TAP_ERR_FLOOR : given); f.tapErr = errs; }
          else if (given !== null) { f.tapErr = new Array(f.points.length).fill(TAP_ERR_FLOOR); f.tapErr[i + 1] = given; }
          else if (f.tapErr !== undefined) delete f.tapErr;
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
          const errs = alignedTapErr(g, g.points.length);
          g.points.splice(index, 1);
          if (errs) { errs.splice(index, 1); g.tapErr = errs; } else if (g.tapErr !== undefined) delete g.tapErr;
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
          if (ft.geometry === 'vertical') {
            const errs = alignedTapErr(g, g.points.length);
            g.points = [g.points[0], g.points[g.points.length - 1]];
            if (errs) g.tapErr = [errs[0], errs[errs.length - 1]]; else if (g.tapErr !== undefined) delete g.tapErr;
            g.closed = false;
          }
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
      /**
       * "Buy from" (SPEC §8.3): who the project buys from. 'generic' (or null) = any store, which clears the field.
       * Every run still on Auto then switches to that supplier's product; a run with its own product keeps it.
       * One undo step. Returns true when the choice changed.
       */
      actions.setSupplier = (supplierId) => {
        const lib = catalog.getLibrary(P());
        const known = arr(lib.suppliers).find((s) => s && s.id === supplierId) || null;
        const next = known && known.id !== 'generic' ? known.id : null;
        return store.commit(next ? 'Buy from ' + known.name : 'Buy from any store', (d) => {
          if (!catalog.isPlainObject(d.library)) d.library = { products: null, config: null };
          const cur = typeof d.library.supplierId === 'string' && d.library.supplierId && d.library.supplierId !== 'generic' ? d.library.supplierId : null;
          if (cur === next) return false;
          if (next) d.library.supplierId = next; else delete d.library.supplierId;
          return undefined;
        });
      };
      /**
       * How the chosen supplier's C7 and C9 is bought and costed (config.buying): {style: 'bulk' | 'strings'} and
       * {costBasis: 'bought' | 'used'}. Only a value that differs from the default is stored, like every other rule
       * of thumb. One undo step. Returns true when something changed.
       */
      actions.setBuying = (patch) => {
        if (!catalog.isPlainObject(patch)) return false;
        const allowed = { style: catalog.BUYING_STYLES, costBasis: catalog.COST_BASES };
        const def = catalog.DEFAULT_CONFIG.buying;
        const label = patch.style !== undefined ? 'Change how C7 and C9 are bought' : 'Change what the job is charged for';
        return store.commit(label, (d) => {
          if (!catalog.isPlainObject(d.library)) d.library = { products: null, config: null };
          const cfg = catalog.isPlainObject(d.library.config) ? d.library.config : {};
          const buying = catalog.isPlainObject(cfg.buying) ? Object.assign({}, cfg.buying) : {};
          for (const k of Object.keys(allowed)) {
            if (patch[k] === undefined || !allowed[k].includes(patch[k])) continue;
            if (patch[k] === def[k]) delete buying[k]; else buying[k] = patch[k];
          }
          if (Object.keys(buying).length) cfg.buying = buying; else delete cfg.buying;
          d.library.config = Object.keys(cfg).length ? cfg : null;
          return undefined;
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
      actions.addPlane = (kind, opts) => {
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
        if (k === 'upper') {
          // The upper roof of a mansard starts where a steep face ends: its line is drawn on that face.
          const steeps = p.planes.filter((x) => x.imageId === img.id && surfaceKind(p, x) === 'steep');
          const hasUpper = (s) => p.planes.some((x) => x.derived && x.derived.parentPlaneId === s.id);
          const face = (opts && findPlane(p, opts.parentId)) || (active && surfaceKind(p, active) === 'steep' ? active : null) ||
            steeps.find((s) => !hasUpper(s)) || steeps[0] || null;
          if (!face || surfaceKind(p, face) !== 'steep') { actions.toast('Add a steep roof face first. The upper roof starts where it ends.', 'warn'); return null; }
          store.setUI({ activePlaneId: face.id });
          actions.setMode('line', { purpose: 'roofEave', planeId: face.id, pitch: null, upper: true });
          return null;
        }
        const parent = wallOfPlane(p, active) || p.planes.find((x) => x.kind === 'wall' && x.imageId === img.id) || null;
        if (!parent) { actions.toast('Add a wall first: roof slopes and the ground are worked out from a wall.', 'warn'); return null; }
        if (k === 'steep') actions.setMode('line', { purpose: 'roofEave', planeId: parent.id, pitch: null, steep: true });
        else actions.setMode('line', { purpose: k === 'roof' ? 'roofEave' : 'groundBase', planeId: parent.id, pitch: null });
        return null;
      };

      /** A typical slope for a steep roof face (degrees from level). It is a guess: lengths on the face stay rough. */
      actions.setSteepAngle = (planeId, deg) => {
        const lim = measure.STEEP || { minDeg: 20, maxDeg: 85 };
        const v = Math.round(Number(deg));
        if (!(v >= lim.minDeg && v <= lim.maxDeg)) return false;
        return store.commit('Set how steep the roof face is', (d) => {
          const pl = findPlane(d, planeId);
          if (!pl || pl.kind !== 'roof' || !pl.derived || pl.derived.steep !== true) return false;
          if (pl.derived.angleDeg === v && !pl.derived.pitch) return false;
          pl.derived.angleDeg = v;
          pl.derived.pitch = null;
          return undefined;
        });
      };
      /**
       * The slope of a steep roof face from tape numbers (feet): how far it goes up, how far it goes back and its
       * sloped height. Any two are enough. Stored as derived.pitch, which means measured. Returns the result of
       * measure.steepFromTape; nothing is stored (and a message says why) when the numbers do not give a slope.
       */
      actions.setSteepMeasured = (planeId, nums) => {
        const res = measure.steepFromTape(nums || {});
        if (!res.ok) { actions.toast(res.reason, 'warn'); return res; }
        const r4 = (v) => Math.round(v * 10000) / 10000;
        const cur = findPlane(P(), planeId);
        const same = cur && cur.derived && cur.derived.pitch && cur.derived.pitch.rise === r4(res.upFt) && cur.derived.pitch.run === r4(res.backFt);
        if (same) return res;   // the same numbers again (leaving a field, then the button): nothing to store
        const done = store.commit('Measure how steep the roof face is', (d) => {
          const pl = findPlane(d, planeId);
          if (!pl || pl.kind !== 'roof' || !pl.derived || pl.derived.steep !== true) return false;
          pl.derived.pitch = { rise: r4(res.upFt), run: r4(res.backFt) };
          return undefined;
        });
        // A message about numbers that did not fit has done its job once good ones are in.
        if (done !== false && U().toast && U().toast.kind === 'warn') store.setUI({ toast: null });
        return done === false ? { ok: false, reason: 'This is not a steep roof face.' } : res;
      };

      // ------------------------------------------------------------ items drawn on the wrong surface
      /** What an item measures right now (ft), or null. */
      function lengthNow(featureId) {
        try {
          const m = store.plan().measured.features[featureId];
          return m && m.ok && Number.isFinite(m.measuredFt) ? m.measuredFt : null;
        } catch (e) { return null; }
      }
      // A roof length this much longer than the same item read on the wall is not believable: the roof behind a
      // wall is further from the camera, but only by its run (a ridge 15 ft back, seen from 30 ft, reads 1.5 times).
      const MOVE_TOO_LONG = 1.6;
      // Above this expected error a surface gives only a rough number (an upper roof seen almost edge-on).
      const ROUGH_PCT = 50;
      /**
       * How a move to a roof surface turned out: {kind: 'ok' | 'rough' | 'wrong' | 'noscale', text, canSteep}.
       * 'wrong': the item lies below the line where that roof starts, or reads much longer than it did on the wall.
       * 'rough': the roof is an upper roof or is only roughly measured. Never throws.
       */
      function moveVerdict(featureId, planeId, beforeFt, created) {
        const p = P();
        const f = byId(p.features, featureId) || {};
        const pl = findPlane(p, planeId);
        const name = "'" + ((pl && pl.name) || 'the roof') + "'";
        const label = f.label || 'The item';
        let m = null, sol = null;
        try { const meas = store.plan().measured; m = meas.features[featureId]; sol = meas.planes[planeId]; } catch (e) { m = null; sol = null; }
        const fmt = (v) => measure.formatLength(v, p.settings && p.settings.lengthFormat);
        const now = m && m.ok && Number.isFinite(m.measuredFt) ? m.measuredFt : null;
        const sk = surfaceKind(p, pl);
        const reads = now != null ? label + ' now reads ' + fmt(now) + ' on ' + name + '. ' : label + ' is now on ' + name + '. ';
        const steepTip = sk === 'roof' ? ' If this is a mansard roof, use a steep roof face.' : '';
        if (m && m.wrongSurface === 'below') {
          return { kind: 'wrong', canSteep: sk === 'roof', text: label + ' lies below the line where ' + name + ' starts, so it is not on that roof.' + steepTip + ' Or type its length.' };
        }
        if (now != null && beforeFt > 0 && now > MOVE_TOO_LONG * beforeFt && sk !== 'upper') {
          return { kind: 'wrong', canSteep: sk === 'roof', text: reads + 'On the wall it read ' + fmt(beforeFt) + ', so this looks too long.' + steepTip + ' Or type its length.' };
        }
        if (!sol || !sol.ok) return { kind: 'noscale', canSteep: false, text: label + ' is now on ' + name + '. That surface has no scale yet: finish it in step 2.' };
        if (sk === 'upper' || (Number.isFinite(sol.uncertaintyPct) && sol.uncertaintyPct > ROUGH_PCT)) {
          const why = sk === 'upper' ? 'This roof is seen almost edge-on, so this length is rough.' : 'This surface is only roughly measured, so this length is rough.';
          return { kind: 'rough', canSteep: false, text: reads + why + ' Type a tape-measured length.' };
        }
        const next = sk === 'steep' ? ' Say how steep that face is in step 2.' : created ? ' Check the pitch of that roof in step 2.' : '';
        return { kind: 'ok', canSteep: false, text: label + ' is now measured on ' + name + '.' + next };
      }
      /** Say how a move turned out: a green message when it is fine, else a note with what to do (never green). */
      function reportMove(featureId, planeId, beforeFt, created, others) {
        const v = moveVerdict(featureId, planeId, beforeFt, created);
        if (v.kind === 'ok' || v.kind === 'noscale') {
          const tail = others ? ' If it belongs on another roof surface, change Surface on its card.' : '';
          actions.toast(v.text + tail, v.kind === 'ok' ? 'ok' : 'warn');
          if (created && U().step === 3) store.setUI({ afterTrace: { featureId, type: (byId(P().features, featureId) || {}).type } });
          return v;
        }
        // In step 3 the note sits in the hint bar with its buttons; elsewhere (Review) it is a warning message.
        if (U().step === 3) store.setUI({ toast: null, moveNote: { featureId, planeId, kind: v.kind, text: v.text, canSteep: v.canSteep } });
        else actions.toast(v.text, 'warn');
        return v;
      }

      /**
       * "Put it on the roof": move an item that belongs on a roof (a ridge drawn on a wall) to a roof surface that
       * hangs off that wall: the given one, else the one that starts under the item. With no such roof, the hint
       * bar first asks what kind of roof it is (ui.roofAsk), then its line is drawn (drawRoofFor) and the item
       * moves when the roof exists. One undo step either way. Returns 'moved', 'ask' or false.
       */
      actions.putOnRoof = (featureId, planeId) => {
        const p = P();
        const f = byId(p.features, featureId);
        if (!f) return false;
        let measured = null;
        try { measured = store.plan().measured; } catch (e) { measured = null; }
        const item = arr(measure.misplacedFeatures(p, measured)).find((x) => x.featureId === featureId && x.wants === 'roof');
        if (!item) return false;
        const target = planeId ? item.candidates.find((c) => c.planeId === planeId) : pickRoofCandidate(p, f, item.candidates);
        if (target) {
          const name = target.name || 'the roof';
          const before = lengthNow(featureId);
          store.commit('Move ' + (f.label || 'item') + " to '" + name + "'", (d) => {
            const g = byId(d.features, featureId);
            if (!g) return false;
            g.planeId = target.planeId;
            return undefined;
          });
          const ui = U();
          const patch = { activePlaneId: target.planeId, moveNote: null, roofAsk: null };
          if (ui.step === 3 && !(ui.selection && ui.selection.kind === 'feature' && ui.selection.id === featureId)) patch.selection = { kind: 'feature', id: featureId };
          store.setUI(patch);
          reportMove(featureId, target.planeId, before, false, item.candidates.length > 1);
          return 'moved';
        }
        // No roof starts under the item yet. Ask what kind of roof it is before its line is drawn: an ordinary
        // eave line on a mansard would put the item on the wrong slope.
        const from = U().step;
        store.setUI(Object.assign(SELECT(), { step: 3, toast: null, activePlaneId: item.planeId, selection: { kind: 'feature', id: featureId },
          roofAsk: { featureId, planeId: item.planeId, returnStep: from !== 3 ? from : null } }));
        return 'ask';
      };
      /**
       * The answer to "what kind of roof is it?" (ui.roofAsk): draw the line where an ordinary roof ('roof') or a
       * steep roof face ('steep') starts on the item's wall; the item moves to the new surface when the line is in.
       */
      actions.drawRoofFor = (featureId, kind) => {
        const p = P();
        const f = byId(p.features, featureId);
        const wall = f ? wallOfPlane(p, findPlane(p, f.planeId)) : null;
        if (!f || !wall) { store.setUI({ roofAsk: null }); return false; }
        const ask = U().roofAsk;
        const returnStep = ask && Number.isInteger(ask.returnStep) ? ask.returnStep : null;
        if (U().step !== 3) store.setUI({ step: 3, toast: null });
        store.setUI({ activePlaneId: wall.id });
        const opts = { purpose: 'roofEave', planeId: wall.id, pitch: null, thenMove: featureId };
        if (kind === 'steep') opts.steep = true;
        if (returnStep != null) opts.returnStep = returnStep;
        actions.setMode('line', opts);
        return true;
      };
      /** "Use a steep roof face" after a move that looks wrong: undo that move, then draw a steep face for the item. */
      actions.useSteepInstead = (featureId) => {
        const note = U().moveNote;
        if (!note || note.featureId !== featureId || !note.canSteep) return false;
        store.undo();
        store.setUI({ moveNote: null, toast: null });
        return actions.drawRoofFor(featureId, 'steep');
      };
      /** "Undo" on the note after a move: take the move back. */
      actions.undoMove = () => {
        if (!U().moveNote) return false;
        store.undo();
        store.setUI({ moveNote: null, toast: null });
        return true;
      };
      actions.dismissMoveNote = () => store.setUI({ moveNote: null });
      /**
       * Move an item that was drawn below the line where its roof starts to a surface under it (the given one, else
       * the nearest one it can be measured on). Returns true when it moved.
       */
      actions.putOnPlane = (featureId, planeId) => {
        const p = P();
        const f = byId(p.features, featureId);
        if (!f) return false;
        let measured = null;
        try { measured = store.plan().measured; } catch (e) { measured = null; }
        const item = arr(measure.misplacedFeatures(p, measured)).find((x) => x.featureId === featureId && x.wants === 'below');
        const fits = (c) => !c.below && typeFitsSurface(p, f.type, findPlane(p, c.planeId));
        const target = item ? (planeId ? item.candidates.find((c) => c.planeId === planeId) : item.candidates.find(fits)) : null;
        if (!target) return false;
        const name = target.name || 'the surface below';
        store.commit('Move ' + (f.label || 'item') + " to '" + name + "'", (d) => {
          const g = byId(d.features, featureId);
          if (!g) return false;
          g.planeId = target.planeId;
          return undefined;
        });
        store.setUI({ activePlaneId: target.planeId, moveNote: null });
        actions.toast((f.label || 'The item') + " is now measured on '" + name + "'.", 'ok');
        return true;
      };
      /**
       * "Type its length": open the item's tape-measured length field. In Review the field is in the item's
       * "double-check" entry; anywhere else the item is opened in step 3. The panels focus the field (ui.focusTape).
       */
      actions.typeLength = (featureId) => {
        if (!byId(P().features, featureId)) return false;
        const inReview = U().step === 6;
        focusSeq += 1;
        const patch = Object.assign(SELECT(), { focusTape: { featureId, n: focusSeq } });
        if (!inReview) { patch.step = 3; patch.selection = { kind: 'feature', id: featureId }; }
        store.setUI(patch);
        return true;
      };
      actions.deletePlane = (id) => {
        const p = P();
        const pl = findPlane(p, id);
        if (!pl) return Promise.resolve(false);
        // Everything built from it goes too: its roofs and ground, and an upper roof on one of those roofs.
        const ids = [id];
        for (let i = 0; i < ids.length; i++) {
          for (const x of p.planes) if (x.derived && x.derived.parentPlaneId === ids[i] && !ids.includes(x.id)) ids.push(x.id);
        }
        const children = p.planes.filter((x) => x.id !== id && ids.includes(x.id));
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
          // Straight on to step 2: with the photo in, setting the scale is the next thing to do.
          store.setUI(Object.assign(SELECT(), {
            busy: null, step: 2, activePlaneId: wall.id, selection: null, bannerDismissed: false,
            view: Object.assign({}, U().view, { night: false, twinkle: false }),
          }));
          const lens = img.exif && img.exif.focal35 ? ' The lens was read from the photo.' : '';
          if (isSmallPhoto(image)) {
            actions.toast('Photo added, but it is small (' + image.width + ' px wide), so corners are hard to place and lengths come out rough. Use the original photo from the camera if you can. You are now on step 2: set the scale.', 'warn');
          } else {
            actions.toast('Photo added.' + lens + ' You are now on step 2: set the scale by marking something whose size you know.', 'ok');
          }
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
            // The plan is always worked out again. When that moves the totals the file was saved with (a file from
            // an older LightPlan, whose cords and bush lights were planned by other rules), say so in a note that
            // stays until it is closed: an installer may already have sent the old quote.
            const moved = replannedText(res && res.saved, store.plan());
            if (moved && !(store.ui().notice && store.ui().notice.kind === 'storage')) store.setUI({ notice: { kind: 'replanned', message: moved } });
            else if (store.ui().notice && store.ui().notice.kind === 'replanned') store.setUI({ notice: null });
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

    /**
     * What to tell someone whose saved file was planned again with different results: the materials cost (and the
     * customer quote, when there is one) then and now. '' when the file carries no totals or they have not moved
     * (by more than a dollar). saved = {cost, quoteTotal} from schema.importProject; plan = the fresh plan.
     */
    function replannedText(saved, plan) {
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const money = (v) => '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const sm = plan && plan.summary ? plan.summary : null;
      if (!saved || !sm) return '';
      const parts = [];
      const was = num(saved.cost), now = num(sm.cost);
      if (was !== null && now !== null && Math.abs(was - now) > 1) parts.push('materials were ' + money(was) + ', now ' + money(now));
      const qWas = num(saved.quoteTotal), qNow = num(sm.quoteTotal);
      if (qWas !== null && qNow !== null && Math.abs(qWas - qNow) > 1) parts.push('the customer quote was ' + money(qWas) + ', now ' + money(qNow));
      if (!parts.length) return '';
      return 'This plan was saved with different planning rules (an older LightPlan, most likely). Cords, lights and prices were worked out again: ' +
        parts.join('; ') + '. Check the shopping list before you order or quote.';
    }

    return {
      createActions, parseLength, nextFeatureLabel, nextOutletLabel, wallForPoint, KINDS_FOR_TYPE, isSmallPhoto, SMALL_PHOTO_PX, replannedText,
      surfaceKind, SURFACE_LABEL, surfaceOptionLabel, wallOfPlane, typeFitsSurface, pickRoofCandidate, mansardSurfaceFor, steepAngleText, STEEP_ANGLES,
    };
  });
