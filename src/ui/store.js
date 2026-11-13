/* LightPlan UI: store (SPEC §6.1).
 * One place that holds the project, the UI state, undo/redo history, the memoized plan and decoded photos.
 *
 *  - The project is treated as immutable. store.commit(label, mutator) deep-clones it, lets the mutator edit
 *    the clone, and swaps it in only if something actually changed (so no-op edits never pollute undo).
 *  - Undo entries are whole-project snapshots (projects are small JSON; photos live outside the project).
 *  - Gestures (dragging a point) take one snapshot at beginGesture and push a single undo entry at
 *    endGesture, however many commits happened in between.
 *  - store.plan() runs plan.computePlan lazily, once per project version.
 *  - After every project change the UI state is checked so it never points at deleted items
 *    (selection, active plane, the plane a tool is drawing on).
 *  - Listeners get {projectChanged, uiChanged} and are called synchronously; renderers batch with rAF.
 *
 * Deviations from SPEC §6.1 (additive; the documented API is unchanged):
 *  - UI state also has `calib` (calibration form values), `bannerDismissed`, `busy` (a progress message),
 *    `notice` (a persistent note the app shows: storage blocked, unreadable autosave, another tab),
 *    `activeVertex` ({featureId, index} of the point last pressed, for Delete point) and `afterTrace`
 *    ({featureId, type} of the item just traced, while the hint bar offers what to trace next).
 *  - createStore accepts opts.persist (default ui.persist; null disables autosave, for tests) and opts.now
 *    (() => ISO string, for tests).
 *  - commit() returns true when the project changed. A mutator may return false to cancel the commit.
 *  - Listener payloads may also carry historyChanged / imageChanged flags.
 *  - setImage accepts a 4th argument {persist:false} to skip the storage write.
 *  - undo()/redo() do nothing while a gesture is open (canUndo/canRedo report false then).
 *  - Extra methods: undoLabel(), redoLabel(), getImageData(imageId) → data URL | null, inGesture(),
 *    clearImages(). Extra exports: defaultUI(), sanitizeUI(project, ui).
 */
LP.define('ui.store', ['catalog', 'plan', 'ui.persist'], function (catalog, planModule, persistModule) {
  'use strict';

  const MAX_HISTORY = 100;
  const SAMPLE_KEY = 'sample';

  /** Default UI state (SPEC §6.1), plus `calib`, `bannerDismissed` and `busy`. */
  function defaultUI() {
    return {
      step: 1,
      mode: { name: 'select', opts: {} },
      draft: { points: [] },
      selection: null,
      activePlaneId: null,
      traceType: 'roofline',
      view: { preview: true, night: true, twinkle: false, overlay: true, grid: true, labels: true, snap: true },
      sheet: 'half',
      toast: null,
      dialog: null,
      calib: { rectPresetId: 'unknown', rectWidthFt: null, rectHeightFt: null, refPresetId: 'door-height', refLengthFt: null, refCourses: 12, refWidthFt: null, refHeightFt: null },
      bannerDismissed: false,
      busy: null,
      activeVertex: null,
      notice: null,          // persistent note: {kind:'storage'|'unreadable'|'foreign', ...}
      afterTrace: null,      // {featureId, type} right after a trace is finished: the hint bar offers what to trace next
      focusTape: null,       // {featureId, n}: the panels put the cursor in this item's tape-measured length field (once per n)
      roofAsk: null,         // {featureId, planeId, returnStep}: the hint bar asks what kind of roof the item sits on
      moveNote: null,        // {featureId, planeId, kind: 'rough' | 'wrong', text, canSteep}: how a move to a roof turned out
      scrollTo: null,        // {key, planeId, n}: the panels scroll to this part of a surface's editor (once per n)
    };
  }

  const arr = (v) => (Array.isArray(v) ? v : []);
  const byId = (list, id) => arr(list).find((x) => x && x.id === id) || null;

  /** The image the user is working on: activeImageId, else the first image, else null. */
  function activeImageOf(project) {
    const images = arr(project && project.images);
    return byId(images, project && project.activeImageId) || images[0] || null;
  }

  /**
   * UI fixes needed after a project change: returns a patch for ui (or null when nothing needs fixing) so the
   * selection, active plane and active tool never refer to items that no longer exist.
   */
  function sanitizeUI(project, ui) {
    const patch = {};
    const planes = arr(project && project.planes);
    const img = activeImageOf(project);
    const imgPlanes = planes.filter((p) => p && (!img || p.imageId === img.id));

    const sel = ui.selection;
    if (sel) {
      let exists = false;
      if (sel.kind === 'feature') exists = !!byId(project.features, sel.id);
      else if (sel.kind === 'plane') exists = !!byId(planes, sel.id);
      else if (sel.kind === 'outlet') exists = !!byId(project.outlets, sel.id);
      else if (sel.kind === 'ref') {
        const pl = byId(planes, sel.planeId);
        exists = !!(pl && byId(pl.refs, sel.id));
      }
      if (!exists) patch.selection = null;
    }
    if (ui.afterTrace && !byId(project.features, ui.afterTrace.featureId)) patch.afterTrace = null;

    if (!byId(imgPlanes, ui.activePlaneId)) {
      const wall = imgPlanes.find((p) => p.kind === 'wall') || imgPlanes[0] || null;
      const next = wall ? wall.id : null;
      if (next !== ui.activePlaneId) patch.activePlaneId = next;
    }

    const mode = ui.mode || { name: 'select', opts: {} };
    if (mode.name !== 'select' && mode.name !== 'pan') {
      const pid = mode.opts && mode.opts.planeId;
      const noImage = !img;
      if (noImage || (pid != null && !byId(planes, pid))) {
        patch.mode = { name: 'select', opts: {} };
        patch.draft = { points: [] };
      }
    }
    return Object.keys(patch).length ? patch : null;
  }

  function createStore(opts) {
    const o = opts || {};
    const persist = o.persist === undefined ? persistModule : o.persist;
    const now = typeof o.now === 'function' ? o.now : () => new Date().toISOString();

    let project = o.project || null;
    let ui = Object.assign(defaultUI(), o.ui || {});
    ui.view = Object.assign(defaultUI().view, (o.ui && o.ui.view) || {});
    ui.calib = Object.assign(defaultUI().calib, (o.ui && o.ui.calib) || {});
    {
      const fix = sanitizeUI(project || {}, ui);
      if (fix) ui = Object.assign({}, ui, fix);
    }

    let undoStack = []; // [{label, project}]
    let redoStack = [];
    let gesture = null; // {before: project}
    let planCache = null;
    const listeners = new Set();
    const images = new Map(); // imageId → {el, dataUrl}

    function emit(info) {
      for (const fn of Array.from(listeners)) {
        try { fn(info); } catch (e) { if (typeof console !== 'undefined') console.error('LightPlan listener failed', e); }
      }
    }
    function autosave() {
      if (persist && typeof persist.saveProject === 'function' && project) {
        try { persist.saveProject(project); } catch (e) { /* persist never throws, but stay safe */ }
      }
    }
    /** Swap in a new project version: drop the plan memo, fix UI references, autosave. */
    function setProject(next) {
      project = next;
      planCache = null;
      const fix = sanitizeUI(project || {}, ui);
      if (fix) ui = Object.assign({}, ui, fix);
      autosave();
      return !!fix;
    }
    function pushUndo(label, snapshot) {
      undoStack.push({ label: label || 'Edit', project: snapshot });
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack = [];
    }
    const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

    const store = {
      project: () => project,
      ui: () => ui,

      plan() {
        if (!planCache) planCache = planModule.computePlan(project);
        return planCache;
      },

      commit(label, mutator, options) {
        if (!project || typeof mutator !== 'function') return false;
        const draft = catalog.deepClone(project);
        let result;
        try {
          result = mutator(draft);
        } catch (e) {
          if (typeof console !== 'undefined') console.error('LightPlan edit failed: ' + label, e);
          return false;
        }
        if (result === false || same(draft, project)) return false;
        draft.updatedAt = now();
        const inGesture = !!(options && options.gesture && gesture);
        if (!inGesture) pushUndo(label, project);
        const uiFixed = setProject(draft);
        emit({ projectChanged: true, uiChanged: uiFixed, historyChanged: !inGesture });
        return true;
      },

      beginGesture() {
        if (!gesture) gesture = { before: project };
      },
      endGesture(label) {
        if (!gesture) return false;
        const before = gesture.before;
        gesture = null;
        if (before && project && !same(before, project)) {
          pushUndo(label || 'Move point', before);
          emit({ projectChanged: false, uiChanged: false, historyChanged: true });
          return true;
        }
        return false;
      },
      inGesture: () => !!gesture,

      setUI(patch) {
        if (!patch || typeof patch !== 'object') return;
        ui = Object.assign({}, ui, patch);
        emit({ projectChanged: false, uiChanged: true });
      },

      canUndo: () => !gesture && undoStack.length > 0,
      canRedo: () => !gesture && redoStack.length > 0,
      undoLabel: () => (undoStack.length ? undoStack[undoStack.length - 1].label : null),
      redoLabel: () => (redoStack.length ? redoStack[redoStack.length - 1].label : null),

      /**
       * Undo the last change. Returns its label, or null when there is nothing to undo. Ignored while a gesture
       * (a handle drag) is open: the drag would otherwise go on outside any gesture, one undo entry per move.
       */
      undo() {
        if (gesture) return null;
        const entry = undoStack.pop();
        if (!entry) return null;
        redoStack.push({ label: entry.label, project });
        const uiFixed = setProject(entry.project);
        emit({ projectChanged: true, uiChanged: uiFixed, historyChanged: true });
        return entry.label;
      },
      redo() {
        if (gesture) return null;
        const entry = redoStack.pop();
        if (!entry) return null;
        undoStack.push({ label: entry.label, project });
        const uiFixed = setProject(entry.project);
        emit({ projectChanged: true, uiChanged: uiFixed, historyChanged: true });
        return entry.label;
      },

      /**
       * Replace the whole project (new photo, sample, import, start over). With resetHistory (default) undo
       * history is cleared and stored photos the new project does not use are deleted.
       */
      replaceProject(next, options) {
        const reset = !(options && options.resetHistory === false);
        gesture = null;
        if (reset) {
          undoStack = [];
          redoStack = [];
        } else if (project) {
          pushUndo((options && options.label) || 'Replace project', project);
        }
        setProject(next);
        if (reset && persist && typeof persist.pruneImages === 'function') {
          const keep = arr(next && next.images).map((im) => im && im.storageKey).filter((k) => typeof k === 'string' && k);
          try { persist.pruneImages(keep); } catch (e) { /* ignore */ }
          // Forget decoded photos of images that are gone.
          for (const id of Array.from(images.keys())) if (!byId(next && next.images, id)) images.delete(id);
        }
        emit({ projectChanged: true, uiChanged: true, historyChanged: true });
      },

      subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
      },

      getImage(imageId) {
        const rec = images.get(imageId);
        return rec ? rec.el : null;
      },
      getImageData(imageId) {
        const rec = images.get(imageId);
        return rec && typeof rec.dataUrl === 'string' ? rec.dataUrl : null;
      },
      /**
       * Cache decoded pixels for an image and store its data URL (never for the regenerated sample photo).
       * options.persist:false skips the storage write (the photo was just read from storage).
       */
      setImage(imageId, element, dataUrl, options) {
        images.set(imageId, { el: element || null, dataUrl: typeof dataUrl === 'string' ? dataUrl : null });
        const im = byId(project && project.images, imageId);
        const key = im && typeof im.storageKey === 'string' ? im.storageKey : null;
        const write = !(options && options.persist === false);
        if (write && key && key !== SAMPLE_KEY && typeof dataUrl === 'string' && persist && typeof persist.saveImage === 'function') {
          try { persist.saveImage(key, dataUrl); } catch (e) { /* ignore */ }
        }
        emit({ projectChanged: false, uiChanged: true, imageChanged: true });
      },
      clearImages() { images.clear(); },
    };
    return store;
  }

  return { createStore, defaultUI, sanitizeUI, activeImageOf, MAX_HISTORY };
});
