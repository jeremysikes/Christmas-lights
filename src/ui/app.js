/* LightPlan UI: app (SPEC §6.6).
 * Boots the app and wires the shell around the viewport and the step panels:
 *   persist.load → store → actions → viewport → panels → top bar, step bar, canvas controls, hint bar,
 *   sample banner, toast, in-page dialog, drag-and-drop, file inputs, mobile bottom sheet → export.initDownloads
 * (initDownloads is started first because claude.use('downloads') can take up to 10 s to settle).
 *
 * First run (nothing saved): the traced sample house at step 1, night preview on, with a banner saying it is a
 * sample. A restored project gets a "welcome back" toast. Keyboard shortcuts belong to the viewport; this file
 * registers none (only Escape inside the menu and the dialog, which the viewport never sees).
 *
 * Every optional piece (viewport, export) is guarded, so the panels still work if one of them fails to load.
 *
 * Flow (SPEC §8.5): one primary button is pinned under the panel (#action-btn); panels.nextAction decides what
 * it says from the plan's state and the open step, so the way forward is always in view. The step bar marks a
 * step done from the plan (photo in, scale set, items traced, outlet placed), not from its position. After a
 * trace is finished the hint bar shows its length and offers what to trace next (ui.afterTrace); on a phone the
 * sheet stays collapsed until Done or More.
 *
 * A ridge traced on a wall comes out too short (measure: wrongSurface 'roof'). Right after such a trace the hint
 * bar says so and, instead of "Trace next", offers "Put it on the roof", "Type its length" and "Later" (#hint-fix).
 * The same group of buttons carries the other notes about an item: the question "what kind of roof is it?"
 * (ui.roofAsk), how a move to a roof turned out when it looks wrong or rough (ui.moveNote), and an item drawn
 * below the line where its roof starts. Its buttons are built from hint.fix.buttons.
 * The hint for a line says which line it is: an eave, the bottom of a steep roof face, or the trim line where an
 * upper roof starts.
 */
LP.define('ui.app', ['schema', 'sample', 'catalog', 'measure', 'ui.persist', 'ui.store', 'ui.imagesource', 'ui.actions', 'ui.panels'],
  function (schema, sample, catalog, measure, persist, storeModule, imagesource, actionsModule, panels) {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const FEATURE_TYPES = catalog.FEATURE_TYPES;
    const TOAST_MS = { info: 4000, ok: 4000, warn: 6500, error: 8000 };
    const DRAW_MODES = ['rect', 'line', 'trace', 'outlet'];
    let started = false;

    function mq(query) {
      try { return window.matchMedia ? window.matchMedia(query) : null; } catch (e) { return null; }
    }
    const isDesktop = () => { const m = mq('(min-width: 900px)'); return !!(m && m.matches); };
    const reducedMotion = () => { const m = mq('(prefers-reduced-motion: reduce)'); return !!(m && m.matches); };

    /** Replace every [data-icon] placeholder in the static shell with its inline SVG. */
    function fillIcons(root) {
      for (const el of Array.from(root.querySelectorAll('[data-icon]'))) {
        if (el.firstChild) continue;
        el.appendChild(panels.icon(el.getAttribute('data-icon')));
      }
    }

    /** A viewport stand-in so the rest of the app works if the real one is missing or failed to start. */
    function nullViewport() {
      return { fit() {}, zoomBy() {}, redraw() {}, screenToImage: (p) => p, imageToScreen: (p) => p, destroy() {} };
    }

    function start() {
      if (started) return;
      const root = $('lp-app');
      if (!root) return;
      started = true;
      fillIcons(root);
      try {
        if (LP.has('ui.export')) LP.require('ui.export').initDownloads();
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('LightPlan: downloads could not be set up', e);
      }
      persist.load().then(boot, () => boot(null)).catch((e) => {
        if (typeof console !== 'undefined') console.error('LightPlan failed to start', e);
        const pr = $('panel-root');
        if (pr) pr.textContent = 'LightPlan could not start in this browser. Reload the page to try again.';
      });
    }

    // ================================================================ boot
    function boot(saved) {
      let project = null;
      let restoreProblem = null;
      if (saved && saved.project) {
        try {
          project = schema.normalizeProject(schema.migrateProject(saved.project));
        } catch (e) {
          project = null;
          restoreProblem = (e && e.message) || 'The saved plan could not be opened.';
        }
      }
      const firstRun = !project;
      let sampleCanvas = null;
      if (firstRun) {
        const s = sample.createSample({ traced: true });
        project = schema.normalizeProject(s.project);
        const t = new Date().toISOString();
        project.createdAt = t;
        project.updatedAt = t;
        try { sampleCanvas = imagesource.renderSample(s.primitives, s.width, s.height); } catch (e) { sampleCanvas = null; }
      }
      // An autosave this version cannot open is copied to a backup key before the sample's autosave can replace it;
      // if even that fails, autosave pauses until the user downloads it or closes the note.
      let unreadable = null;
      if (restoreProblem && saved && typeof saved.raw === 'string') {
        const kept = persist.backupUnreadable(saved.raw);
        if (!kept) persist.pauseAutosave();
        unreadable = { raw: saved.raw, kept, message: restoreProblem };
      }
      // A restored plan reopens at the step and view the user left (day view while nothing is traced yet).
      const pref = firstRun ? null : persist.loadPref('ui', null);
      const prefStep = pref && Number.isInteger(pref.step) && pref.step >= 1 && pref.step <= 6 ? pref.step : 1;
      const traced = project.features.length > 0;
      const night = firstRun ? true : traced && !(pref && pref.night === false);
      const lightsOn = firstRun ? true : !(pref && pref.preview === false);
      const defaults = storeModule.defaultUI();
      const store = storeModule.createStore({
        project,
        ui: {
          step: firstRun ? 1 : prefStep,
          sheet: 'half',
          view: Object.assign({}, defaults.view, { preview: lightsOn, night, twinkle: firstRun && !reducedMotion() }),
          notice: !persist.isAvailable() ? { kind: 'storage' } : unreadable ? { kind: 'unreadable', raw: unreadable.raw, kept: unreadable.kept, message: unreadable.message } : null,
        },
      });
      const actions = actionsModule.createActions(store);
      persist.setErrorHandler((msg) => {
        // The storage note already says nothing is being saved; do not repeat it as a toast on every edit.
        const n = store.ui().notice;
        if (n && n.kind === 'storage') return;
        actions.toast(msg, 'warn');
      });
      // Another tab saved over this plan: this tab stops autosaving (persist pauses) and asks what to do.
      persist.setForeignChangeHandler(() => store.setUI({ notice: { kind: 'foreign' } }));
      try { window.addEventListener('storage', (e) => persist.handleStorageEvent(e)); } catch (e) { /* ignore */ }

      if (firstRun) {
        if (sampleCanvas) store.setImage(project.images[0].id, sampleCanvas, null);
      } else {
        actions.hydrateImages(project, saved.images || {}, { persist: false }).then((r) => {
          if (r.missing.length) {
            actions.toast('Your plan was restored, but its photo was not saved in this browser. The measurements are kept; choose the photo again to see it.', 'warn');
          }
        });
      }

      let viewport = null;
      try {
        if (LP.has('ui.viewport')) viewport = LP.require('ui.viewport').createViewport({ host: $('viewport'), store, actions });
      } catch (e) {
        if (typeof console !== 'undefined') console.error('LightPlan: the photo view failed to start', e);
        viewport = null;
      }
      viewport = viewport || nullViewport();

      panels.mount({ root: $('panel-root'), store, actions, viewport });
      const shell = wireShell({ store, actions, viewport });
      shell.render();
      store.subscribe(() => shell.schedule());

      if (!restoreProblem && !firstRun) actions.toast('Welcome back. Your plan was restored.', 'ok');

      // Expose for debugging and end-to-end tests (read-only use).
      try { window.LightPlanApp = { store, actions, viewport }; } catch (e) { /* ignore */ }
    }

    // ================================================================ shell wiring
    /** "Eave 1: 38′ 5″." for the hint bar right after a trace (says so when the length is rough or missing). */
    function tracedText(f, project, plan) {
      const ft = FEATURE_TYPES[f.type] || {};
      const label = f.label || ft.label || 'Item';
      const m = plan && plan.measured && plan.measured.features ? plan.measured.features[f.id] : null;
      if (!m || !m.ok) return label + ' is traced. It has no length yet: set the scale in step 2.';
      const fmt = (v) => measure.formatLength(v, project.settings && project.settings.lengthFormat);
      let size;
      if (f.type === 'bush') size = fmt(m.widthFt) + ' wide, ' + fmt(m.heightFt) + ' tall';
      else if (ft.geometry === 'vertical') size = fmt(m.heightFt != null ? m.heightFt : m.measuredFt) + ' tall';
      else size = fmt(m.lengthFt);
      const rough = m.confidence && m.confidence.level === 'low' ? ' (rough: check it with a tape)' : '';
      return label + ': ' + size + rough + '.';
    }
    /** The three quick picks after a trace: the same kind again, then the usual next ones. */
    function nextTraceTypes(type) {
      const out = [];
      for (const t of [type, 'roofline', 'window', 'bush']) if (FEATURE_TYPES[t] && out.indexOf(t) < 0) out.push(t);
      return out.slice(0, 3);
    }

    /**
     * What the hint bar says: {text, count, finish} while a tool is in use; {after: true, text, next: [types]}
     * right after a trace is finished; null otherwise. plan is only needed for the after-trace length.
     */
    function hintFor(ui, project, plan) {
      const mode = ui.mode || {};
      const o = mode.opts || {};
      const pts = ui.draft && Array.isArray(ui.draft.points) ? ui.draft.points.length : 0;
      const idle = !mode.name || mode.name === 'select';
      const named = (id) => (project.features || []).find((x) => x && x.id === id) || null;
      // "Put it on the roof" found no roof under the item: ask what kind of roof it is before its line is drawn.
      if (ui.roofAsk && idle && named(ui.roofAsk.featureId)) {
        const wall = project.planes.find((p) => p.id === ui.roofAsk.planeId);
        return {
          after: true, fix: { featureId: ui.roofAsk.featureId, buttons: ['ordinary', 'steep', 'cancel'] }, next: [], count: '', finish: false,
          text: 'What kind of roof is above ' + (wall ? "'" + wall.name + "'" : 'this wall') + '? An ordinary roof slopes back from the eave. A mansard goes up steeply first, then turns shallow.',
        };
      }
      // A move to a roof that did not turn out well: say what is off and what to do, never "done".
      if (ui.moveNote && idle && named(ui.moveNote.featureId) && named(ui.moveNote.featureId).planeId === ui.moveNote.planeId) {
        const n = ui.moveNote;
        const buttons = n.kind === 'wrong' ? (n.canSteep ? ['usesteep', 'tape', 'undo'] : ['tape:primary', 'undo', 'ok']) : ['tape:primary', 'undo', 'ok'];
        return { after: true, fix: { featureId: n.featureId, buttons }, text: n.text, next: [], count: '', finish: false };
      }
      if (ui.afterTrace && idle) {
        const f = named(ui.afterTrace.featureId);
        if (f) {
          // A ridge drawn on a wall comes out too short: say so at once and offer the two fixes instead of "Trace next".
          const m = plan && plan.measured && plan.measured.features ? plan.measured.features[f.id] : null;
          if (panels.needsRoof(f, m)) {
            const fmt = (v) => measure.formatLength(v, project.settings && project.settings.lengthFormat);
            const len = m.ok && Number.isFinite(m.measuredFt) ? ' measures ' + fmt(m.measuredFt) + ' on the wall, which is too short' : ' is drawn on the wall, so it comes out too short';
            return { after: true, fix: { featureId: f.id, buttons: ['roof:primary', 'tape', 'later'] }, text: (f.label || 'This ridge') + len + '. A ridge sits on the roof, behind the wall.', next: [], count: '', finish: false };
          }
          // Drawn below the line where its roof starts: it sits on the surface under that roof.
          if (panels.needsLower(f, m)) {
            const on = project.planes.find((p) => p.id === f.planeId);
            return {
              after: true, fix: { featureId: f.id, buttons: ['lower:primary', 'tape', 'later'] }, next: [], count: '', finish: false,
              text: (f.label || 'This item') + ' is drawn below the line where ' + (on ? "'" + on.name + "'" : 'this roof') + ' starts, so it is not on that roof.',
            };
          }
          return { after: true, text: tracedText(f, project, plan), next: nextTraceTypes(f.type), count: '', finish: false };
        }
      }
      const plane = project.planes.find((p) => p.id === o.planeId);
      const pname = plane ? "'" + plane.name + "'" : 'this wall';
      if (mode.name === 'rect') {
        const what = o.purpose === 'refRect' ? referenceName(o.presetId) : rectName(o.presetId);
        return { text: 'Tap the 4 corners of ' + what + ' on ' + pname + '. Zoom in for accuracy.', count: pts + ' of 4', finish: false };
      }
      if (mode.name === 'line') {
        if (o.purpose === 'roofEave') {
          let text = 'Tap both ends of the eave where the roof slope meets ' + pname + '.';
          if (o.steep) text = 'Tap both ends of the line where the steep roof face starts on ' + pname + '. This is the eave or gutter line at its bottom.';
          else if (o.upper || (plane && plane.kind === 'roof')) text = 'Tap both ends of the line where ' + pname + ' ends and the upper roof starts. This is the trim line at its top.';
          else if (o.thenMove) text = 'A ridge sits on the roof, so mark the roof first: tap both ends of the eave where the roof slope meets ' + pname + '.';
          return { text, count: pts + ' of 2', finish: false };
        }
        if (o.purpose === 'groundBase') {
          // On the way to a walkway or stake lights: say why the ground comes first (the hint bar says it once;
          // no toast repeats it over the wall being tapped).
          const then = o.thenTrace && FEATURE_TYPES[o.thenTrace] ? FEATURE_TYPES[o.thenTrace].short : null;
          return { text: (then ? then + ' lights lie on the ground, so mark the ground first: tap' : 'Tap') + ' two points along the bottom of ' + pname + ', where it meets the ground.', count: pts + ' of 2', finish: false };
        }
        if (o.purpose === 'planeLine') {
          const sk = plane ? actionsModule.surfaceKind(project, plane) : 'wall';
          const text = sk === 'steep' ? 'Tap both ends of the line where the steep roof face starts again.'
            : sk === 'upper' ? 'Tap both ends of the trim line where the upper roof starts again.'
              : sk === 'roof' ? 'Tap both ends of the eave again.' : 'Tap two points along the bottom of the wall again.';
          return { text, count: pts + ' of 2', finish: false };
        }
        if (o.courses) return { text: 'Tap the bottom edge of one course, then the bottom edge of the course ' + o.courses + ' courses up.', count: pts + ' of 2', finish: false };
        return { text: 'Tap both ends of ' + referenceName(o.presetId) + ' on ' + pname + '.', count: pts + ' of 2', finish: false };
      }
      if (mode.name === 'trace') {
        const ft = FEATURE_TYPES[o.type];
        if (!ft) return null;
        const label = ft.label.toLowerCase();
        if (ft.geometry === 'vertical') return { text: 'Tap the base of the ' + label.replace(/ \(.*\)/, '') + ', then its top.', count: pts + ' of 2', finish: false };
        const count = pts + (pts === 1 ? ' point' : ' points');
        if (ft.geometry === 'polygon' || ft.geometry === 'area') return { text: 'Tap around the ' + label.replace(/ \(.*\)/, '') + '. Tap the first point to close it, or tap Finish.', count, finish: pts >= 3 };
        // On a house with a steep roof face a "rake" is also the leaning corner edge of that face.
        const mansard = o.type === 'rake' && project.planes.some((p) => actionsModule.surfaceKind(project, p) === 'steep');
        return { text: 'Tap along the ' + (mansard ? 'gable rake or the leaning corner edge' : label) + ', corner by corner. Double-tap or tap Finish when done.', count, finish: pts >= 2 };
      }
      if (mode.name === 'outlet') return { text: 'Tap where the outlet is on the photo.', count: '', finish: false };
      return null;
    }
    function rectName(presetId) {
      return {
        'door-rect': 'the entry door', 'garage-single': 'the garage door', 'garage-double': 'the garage door',
        'custom-rect': 'the rectangle', unknown: 'the rectangle (for example the wall corners)',
      }[presetId] || 'the rectangle';
    }
    /** "the entry door height": a reference by name, with its article, for "Tap both ends of …". */
    function referenceName(presetId) {
      const known = {
        'door-height': 'the entry door height', 'door-width': 'the entry door width', 'door-rect': 'the entry door',
        'garage-single': 'the garage door', 'garage-double': 'the garage door', 'garage-height': 'the garage door height',
        'custom-line': 'the line you measured', 'custom-rect': 'the rectangle you measured',
      }[presetId];
      if (known) return known;
      // Presets this file does not list (new ones in measure.REF_PRESETS): their own label, without the size.
      const preset = measure.getRefPreset ? measure.getRefPreset(presetId) : null;
      const label = preset && typeof preset.label === 'string' ? preset.label.replace(/\s*\(.*\)\s*$/, '').trim() : '';
      return label ? 'the ' + label.charAt(0).toLowerCase() + label.slice(1) : 'the reference';
    }

    function wireShell(env) {
      const { store, actions, viewport } = env;
      const appEl = $('lp-app');
      const nameInput = $('project-name');
      const undoBtn = $('btn-undo');
      const redoBtn = $('btn-redo');
      const menuBtn = $('btn-menu');
      const menu = $('app-menu');
      const stepButtons = Array.from(document.querySelectorAll('#stepbar-list [data-step]'));
      const hintbar = $('hintbar');
      const hintText = $('hint-text');
      const hintCount = $('hint-count');
      const hintUndo = $('hint-undo');
      const hintCancel = $('hint-cancel');
      const hintFinish = $('hint-finish');
      const hintPlaneWrap = $('hint-plane-wrap');
      const hintPlane = $('hint-plane');
      const hintActions = $('hint-actions');
      const hintNext = $('hint-next');
      const hintNextChips = $('hint-next-chips');
      const hintFix = $('hint-fix');
      let hintFixKey = '';
      // [label, label below 380 px, label below 480 px]: the full label is always the button's aria-label.
      const FIX_LABEL = {
        roof: ['Put it on the roof', 'Put on roof'], lower: ['Put it on the surface below', 'Put it below', 'Put it below'], tape: ['Type its length', 'Type length'],
        later: ['Later'], ordinary: ['Ordinary roof'], steep: ['Steep roof (mansard)', 'Steep (mansard)', 'Steep (mansard)'], cancel: ['Cancel'],
        usesteep: ['Use a steep roof face', 'Steep roof face', 'Steep roof face'], undo: ['Undo'], ok: ['OK'],
      };
      const actionBar = $('action-bar');
      const actionBtn = $('action-btn');
      const actionLabel = $('action-label');
      const actionNote = $('action-note');
      const panelRoot = $('panel-root');
      const notice = $('notice');
      const noticeText = $('notice-text');
      const noticeA = $('notice-a');
      const noticeB = $('notice-b');
      const noticeClose = $('notice-close');
      const banner = $('sample-banner');
      const empty = $('empty-state');
      const busy = $('busy');
      const busyText = $('busy-text');
      const dropOverlay = $('drop-overlay');
      const toastRegion = $('toast-region');
      const backdrop = $('dialog-backdrop');
      const dialogTitle = $('dialog-title');
      const dialogBody = $('dialog-body');
      const dialogConfirm = $('dialog-confirm');
      const dialogCancel = $('dialog-cancel');
      const handle = $('sheet-handle');
      const panelEl = $('panel');
      const ctl = {
        zoomIn: $('ctl-zoom-in'), zoomOut: $('ctl-zoom-out'), fit: $('ctl-fit'),
        night: $('ctl-night'), twinkle: $('ctl-twinkle'), overlay: $('ctl-overlay'), labels: $('ctl-labels'), snap: $('ctl-snap'),
      };

      let scheduled = false;
      let toastTimer = null;
      let shownToastId = null;
      let lastImageEl = null;
      let lastDialog = null;
      let restoreSheet = null;
      let lastDrawing = false;
      let lastToolKey = '';
      let hintNextKey = null;
      let currentAction = null;
      let pdfBusy = false;
      let dialogReturnFocus = null;
      let lastPref = null;
      let lastSelKey = null;
      let hintPlaneKey = null;
      const stageEl = $('stage');
      const stageTop = hintbar ? hintbar.parentElement : null;
      const workspace = stageEl ? stageEl.parentElement : null;

      /**
       * Keep the photo and the messages clear of what floats over the photo.
       *  - While the hint bar is up (a tool in use, or "Trace next"), the viewport fits the photo into the room
       *    under it and above the view buttons, so no tap aimed at the roof lands on a button of the bar.
       *  - A message (toast) sits just under the hint bar, the sample note or a notice, never on top of them; while
       *    a tool is in use it sits at the bottom of the photo instead, away from where the taps go.
       */
      function layoutOverlays() {
        if (!stageEl) return;
        const st = stageEl.getBoundingClientRect();
        const hintUp = hintbar && !hintbar.hidden;
        if (typeof viewport.setInsets === 'function') {
          let top = 0;
          let bottom = 0;
          if (hintUp) {
            top = Math.max(0, hintbar.getBoundingClientRect().bottom - st.top + 6);
            const vc = document.querySelector('.view-controls');
            const r = vc ? vc.getBoundingClientRect() : null;
            // Only the buttons at the bottom of the photo take room there (on a wide screen the zoom buttons are at the top).
            if (r && r.height > 0 && r.top > st.top + st.height / 2) bottom = Math.max(0, st.bottom - r.top + 6);
          }
          viewport.setInsets({ top, bottom });
        }
        if (toastRegion && workspace) {
          const ws = workspace.getBoundingClientRect();
          const tool = DRAW_MODES.includes(store.ui().mode.name);
          if (tool) {
            toastRegion.style.top = 'auto';
            toastRegion.style.bottom = Math.max(8, Math.round(ws.bottom - st.bottom + 68)) + 'px';
          } else {
            let under = 0;
            if (stageTop) for (const el of Array.from(stageTop.children)) { if (!el.hidden) under = Math.max(under, el.getBoundingClientRect().bottom - ws.top); }
            toastRegion.style.bottom = 'auto';
            toastRegion.style.top = Math.round(under > 0 ? under + 8 : 8) + 'px';
          }
        }
      }
      // The hint bar and the notes change height when their text wraps: follow them.
      if (typeof ResizeObserver === 'function' && stageTop) {
        try { const ro = new ResizeObserver(() => layoutOverlays()); ro.observe(stageTop); if (stageEl) ro.observe(stageEl); } catch (e) { /* ignore */ }
      }

      const on = (el, ev, fn, opts) => { if (el) el.addEventListener(ev, fn, opts); };

      // ---------------------------------------------------------------- top bar
      on(nameInput, 'change', () => actions.setProjectName(nameInput.value));
      on(nameInput, 'keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
      on(undoBtn, 'click', () => { actions.undo(); });   // the last tapped point first while drawing
      on(redoBtn, 'click', () => { store.redo(); });

      function setMenu(open) {
        if (!menu || !menuBtn) return;
        menu.hidden = !open;
        menuBtn.setAttribute('aria-expanded', String(open));
        if (open) {
          const first = menu.querySelector('[role="menuitem"]');
          if (first) first.focus();
        }
      }
      on(menuBtn, 'click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
      on(document, 'click', (e) => { if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) setMenu(false); });
      on(menu, 'keydown', (e) => {
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); menuBtn.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      });
      on(menu, 'click', (e) => {
        const item = e.target.closest('[data-menu]');
        if (!item) return;
        setMenu(false);
        const what = item.getAttribute('data-menu');
        if (what === 'new-photo') panels.pickFile(actions, 'file');
        else if (what === 'open') panels.pickFile(actions, 'json');
        else if (what === 'save') panels.exportFile(store, actions, 'json');
        else if (what === 'start-over') actions.startOver();
      });

      // ---------------------------------------------------------------- step bar
      for (const b of stepButtons) {
        on(b, 'click', () => {
          actions.goStep(Number(b.getAttribute('data-step')));
          if (!isDesktop() && store.ui().sheet === 'min') actions.setSheet('half');
        });
      }

      // ---------------------------------------------------------------- canvas controls
      on(ctl.zoomIn, 'click', () => viewport.zoomBy(1.4));
      on(ctl.zoomOut, 'click', () => viewport.zoomBy(1 / 1.4));
      on(ctl.fit, 'click', () => viewport.fit());
      const flip = (key) => actions.setView({ [key]: !store.ui().view[key] });
      // The buttons show night/twinkle as on only while the lights are on, so a tap acts on what is shown: with the
      // lights off, Night or Twinkle turns the lights on with it.
      on(ctl.night, 'click', () => {
        const v = store.ui().view;
        actions.setView(v.night && v.preview ? { night: false } : { night: true, preview: true });
      });
      on(ctl.twinkle, 'click', () => {
        const v = store.ui().view;
        actions.setView(v.twinkle && v.preview ? { twinkle: false } : { twinkle: true, preview: true });
      });
      on(ctl.overlay, 'click', () => flip('overlay'));
      on(ctl.labels, 'click', () => flip('labels'));
      on(ctl.snap, 'click', () => flip('snap'));

      // ---------------------------------------------------------------- hint bar, banner, empty state
      on(hintUndo, 'click', () => actions.removeLastDraftPoint());
      on(hintCancel, 'click', () => actions.cancelDraft());
      on(hintFinish, 'click', () => actions.completeDraft());
      on(hintPlane, 'change', () => actions.setActivePlane(hintPlane.value));
      // After a trace: pick what to trace next, open the full list (More) or stop (Done).
      on(hintNextChips, 'click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-next]') : null;
        if (b) actions.startTrace(b.getAttribute('data-next'));
      });
      on($('hint-done'), 'click', () => actions.finishTracing());
      // After a ridge was traced on a wall: move it to the roof, type its length, or leave it for later.
      // The buttons are built from the hint (hint.fix.buttons); each carries the item it is about.
      const FIX_DO = {
        roof: (id) => actions.putOnRoof(id),
        lower: (id) => actions.putOnPlane(id),
        tape: (id) => { restoreSheet = restoreSheet || 'half'; actions.typeLength(id); },
        later: () => actions.finishTracing(),
        ordinary: (id) => actions.drawRoofFor(id, 'roof'),
        steep: (id) => actions.drawRoofFor(id, 'steep'),
        cancel: () => actions.cancelDraft(),
        usesteep: (id) => actions.useSteepInstead(id),
        undo: () => actions.undoMove(),
        ok: () => actions.dismissMoveNote(),
      };
      // The note buttons get shorter labels on a narrow phone: follow the window width.
      on(window, 'resize', () => schedule());
      on(hintFix, 'click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-fix]') : null;
        if (!b || !hintFix.contains(b)) return;
        const fn = FIX_DO[b.getAttribute('data-fix')];
        if (fn) fn(b.getAttribute('data-id'));
      });
      on($('hint-more'), 'click', () => {
        restoreSheet = null;
        actions.finishTracing();
        if (!isDesktop() && store.ui().sheet === 'min') actions.setSheet('half');
        if (panelRoot) panelRoot.scrollTop = 0;   // "What to light" is at the top of the Trace panel
      });

      // ---------------------------------------------------------------- the pinned next-action button
      on(actionBtn, 'click', () => {
        const next = currentAction;
        if (!next || pdfBusy) return;
        const result = panels.runNextAction(next, { store, actions });
        if (next.id === 'save-pdf' && result && typeof result.then === 'function') {
          pdfBusy = true;
          schedule();
          const done = () => { pdfBusy = false; schedule(); };
          result.then(done, done);
        }
        if (/^go-/.test(next.id) && !isDesktop() && store.ui().sheet === 'min') actions.setSheet('half');
      });

      // ---------------------------------------------------------------- notice (storage, unreadable autosave, other tab)
      function saveRaw(raw) {
        const exp = LP.has('ui.export') ? LP.require('ui.export') : null;
        if (!exp) return Promise.resolve('failed');
        return Promise.resolve().then(() => exp.saveFile('lightplan-saved-plan.json', raw, 'application/json'));
      }
      on(noticeA, 'click', () => {
        const n = store.ui().notice;
        if (!n) return;
        if (n.kind === 'storage') panels.exportFile(store, actions, 'json');
        else if (n.kind === 'unreadable') {
          saveRaw(n.raw).then((res) => {
            if (res === 'saved') {
              persist.resumeAutosave();
              store.setUI({ notice: null });
              actions.toast('The saved plan was downloaded. Open it with a newer LightPlan.', 'ok');
            } else if (res !== 'declined') actions.toast('The saved plan could not be downloaded here.', 'error');
          });
        } else if (n.kind === 'foreign') {
          try { window.location.reload(); } catch (e) { /* ignore */ }
        }
      });
      on(noticeB, 'click', () => {
        const n = store.ui().notice;
        if (n && n.kind === 'foreign') {
          persist.resumeAutosave();
          persist.saveProjectNow(store.project());
          store.setUI({ notice: null });
          actions.toast('This tab\'s plan is saved again. The other tab\'s changes were replaced.', 'ok');
        }
      });
      on(noticeClose, 'click', () => {
        const n = store.ui().notice;
        if (n && n.kind === 'unreadable') persist.resumeAutosave();
        store.setUI({ notice: null });
      });
      on($('banner-close'), 'click', () => actions.dismissBanner());
      for (const b of Array.from(document.querySelectorAll('[data-pick]'))) {
        on(b, 'click', () => {
          const kind = b.getAttribute('data-pick');
          if (kind === 'sample') actions.loadSample({ traced: true });
          else panels.pickFile(actions, kind);
        });
      }

      // ---------------------------------------------------------------- file inputs
      const fileOf = (input) => (input && input.files && input.files[0]) || null;
      on($('file-input'), 'change', (e) => { const f = fileOf(e.target); if (f) actions.loadImageFile(f, { sourceKind: 'upload' }); });
      on($('camera-input'), 'change', (e) => { const f = fileOf(e.target); if (f) actions.loadImageFile(f, { sourceKind: 'camera' }); });
      on($('json-input'), 'change', (e) => { const f = fileOf(e.target); if (f) actions.importProjectFile(f); });

      // ---------------------------------------------------------------- drag and drop anywhere
      let dragDepth = 0;
      const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0);
      on(window, 'dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth += 1; if (dropOverlay) dropOverlay.hidden = false; });
      on(window, 'dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
      on(window, 'dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth && dropOverlay) dropOverlay.hidden = true;
      });
      on(window, 'drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        if (dropOverlay) dropOverlay.hidden = true;
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        const isJson = /\.json$/i.test(file.name || '') || /json/i.test(file.type || '');
        actions.confirmReplace().then((ok) => {
          if (!ok) return;
          if (isJson) actions.importProjectFile(file);
          else actions.loadImageFile(file, { sourceKind: 'upload' });
        });
      });

      // ---------------------------------------------------------------- dialog
      on(dialogConfirm, 'click', () => { const d = store.ui().dialog; if (d && d.onConfirm) d.onConfirm(); });
      on(dialogCancel, 'click', () => { const d = store.ui().dialog; if (d && d.onCancel) d.onCancel(); });
      on(backdrop, 'click', (e) => { if (e.target === backdrop) { const d = store.ui().dialog; if (d && d.onCancel) d.onCancel(); } });
      on(backdrop, 'keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); const d = store.ui().dialog; if (d && d.onCancel) d.onCancel(); return; }
        if (e.key === 'Tab') {
          // Keep focus inside the dialog.
          const items = [dialogCancel, dialogConfirm];
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
        }
        e.stopPropagation();
      });

      // ---------------------------------------------------------------- bottom sheet (phone)
      const SHEETS = ['min', 'half', 'full'];
      let drag = null;
      on(handle, 'pointerdown', (e) => {
        if (isDesktop()) return;
        drag = { y: e.clientY, h: panelEl.getBoundingClientRect().height, moved: false, id: e.pointerId };
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      });
      on(handle, 'pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dy = e.clientY - drag.y;
        if (Math.abs(dy) > 6) drag.moved = true;
        if (drag.moved) {
          const ws = panelEl.parentElement.getBoundingClientRect().height;
          const hgt = Math.max(96, Math.min(ws - 40, drag.h - dy));
          panelEl.style.flexBasis = hgt + 'px';
          appEl.classList.add('sheet-dragging');
        }
      });
      const endDrag = (e) => {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        const d = drag;
        drag = null;
        if (!d.moved) {
          appEl.classList.remove('sheet-dragging');
          const cur = store.ui().sheet;
          actions.setSheet(cur === 'min' ? 'half' : cur === 'half' ? 'full' : 'min');
          return;
        }
        const hNow = panelEl.getBoundingClientRect().height;
        panelEl.style.flexBasis = '';
        // Snap to the nearest size by measuring each one. 'sheet-dragging' stays on while measuring: it turns the
        // flex-basis transition off, without which every size would measure as the current, mid-transition height.
        appEl.classList.add('sheet-dragging');
        let best = 'half';
        let bestD = Infinity;
        for (const s of SHEETS) {
          appEl.setAttribute('data-sheet', s);
          const dist = Math.abs(panelEl.getBoundingClientRect().height - hNow);
          if (dist < bestD) { bestD = dist; best = s; }
        }
        appEl.setAttribute('data-sheet', best);
        void panelEl.offsetHeight;   // apply the chosen size before the transition comes back
        appEl.classList.remove('sheet-dragging');
        actions.setSheet(best);
        restoreSheet = null;
      };
      on(handle, 'pointerup', endDrag);
      on(handle, 'pointercancel', endDrag);
      on(handle, 'keydown', (e) => {
        const cur = SHEETS.indexOf(store.ui().sheet);
        if (e.key === 'ArrowUp') { e.preventDefault(); actions.setSheet(SHEETS[Math.min(2, cur + 1)]); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); actions.setSheet(SHEETS[Math.max(0, cur - 1)]); }
      });

      // ---------------------------------------------------------------- system hooks
      const flush = () => { try { persist.flush(); } catch (e) { /* ignore */ } };
      on(window, 'pagehide', flush);
      on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
      const rm = mq('(prefers-reduced-motion: reduce)');
      if (rm) {
        const onRm = () => { if (rm.matches && store.ui().view.twinkle) actions.setView({ twinkle: false }); };
        if (rm.addEventListener) rm.addEventListener('change', onRm); else if (rm.addListener) rm.addListener(onRm);
      }

      // ---------------------------------------------------------------- render
      function setPressed(btn, pressed, labelOn, labelOff) {
        if (!btn) return;
        btn.setAttribute('aria-pressed', String(!!pressed));
        const label = pressed ? labelOn : labelOff || labelOn;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
      }

      function renderToast(ui) {
        const t = ui.toast;
        if (!t) {
          if (shownToastId !== null) { toastRegion.textContent = ''; shownToastId = null; }
          return;
        }
        if (t.id === shownToastId) return;
        shownToastId = t.id;
        toastRegion.textContent = '';
        const el = panels.h('div', { class: 'toast ' + (t.kind || 'info'), role: t.kind === 'error' ? 'alert' : 'status' },
          panels.icon(t.kind === 'ok' ? 'check' : t.kind === 'info' ? 'info' : 'warning'),
          panels.h('p', null, t.message),
          panels.h('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Dismiss' }, panels.icon('close')));
        el.querySelector('button').addEventListener('click', () => actions.dismissToast(t.id));
        toastRegion.appendChild(el);
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => actions.dismissToast(t.id), TOAST_MS[t.kind] || 4000);
      }

      function renderNotice(ui) {
        const n = ui.notice;
        if (!notice) return;
        notice.hidden = !n;
        if (!n) return;
        let text = '';
        let a = null;
        let b = null;
        let closable = true;
        if (n.kind === 'storage') {
          text = 'This browser is not saving your plan, so it is lost when the page closes. Use Save project before you leave.';
          a = 'Save project';
        } else if (n.kind === 'unreadable') {
          text = (n.message || 'The saved plan could not be opened.') + (n.kept
            ? ' It is kept in this browser; download it to open it elsewhere. The sample house is shown meanwhile.'
            : ' Download it now: until you do (or close this note), this page does not autosave.');
          a = 'Download it';
        } else if (n.kind === 'foreign') {
          text = 'This plan was changed in another tab. This tab stopped saving so it does not overwrite that work.';
          a = 'Reload';
          b = 'Keep this tab\'s plan';
          closable = false;
        } else if (n.kind === 'replanned') {
          text = n.message || 'This plan was worked out again, and its totals changed.';
        }
        noticeText.textContent = text;
        noticeA.textContent = a || '';
        noticeA.hidden = !a;
        noticeB.textContent = b || '';
        noticeB.hidden = !b;
        noticeClose.hidden = !closable;
      }
      const planeLabel = (p) => actionsModule.surfaceOptionLabel(store.project(), p);

      function renderDialog(ui) {
        const d = ui.dialog;
        if (d === lastDialog) return;
        lastDialog = d;
        if (!d) {
          backdrop.hidden = true;
          if (dialogReturnFocus && document.contains(dialogReturnFocus)) { try { dialogReturnFocus.focus(); } catch (e) { /* ignore */ } }
          dialogReturnFocus = null;
          return;
        }
        dialogReturnFocus = document.activeElement;
        dialogTitle.textContent = d.title || '';
        dialogBody.textContent = d.body || '';
        dialogConfirm.textContent = d.confirmLabel || 'OK';
        dialogCancel.textContent = d.cancelLabel || 'Cancel';
        dialogConfirm.className = 'btn ' + (d.danger ? 'danger-solid' : 'primary');
        backdrop.hidden = false;
        // Safe default: focus Cancel for destructive dialogs, the confirm button otherwise.
        setTimeout(() => { try { (d.danger ? dialogCancel : dialogConfirm).focus(); } catch (e) { /* ignore */ } }, 0);
      }

      function render() {
        scheduled = false;
        const ui = store.ui();
        const project = store.project();
        const image = storeModule.activeImageOf(project);

        // Root attributes drive the CSS (sheet size, step, drawing).
        appEl.setAttribute('data-step', String(ui.step));
        appEl.setAttribute('data-mode', ui.mode.name);
        appEl.setAttribute('data-has-image', image ? 'true' : 'false');

        // Phone: collapse the sheet while a drawing tool is active and while the hint bar offers what to trace
        // next, and again whenever another tool is picked from a raised sheet; restore it afterwards.
        const toolOn = DRAW_MODES.includes(ui.mode.name);
        const drawing = toolOn || !!ui.afterTrace;
        const toolKey = toolOn ? ui.mode.name + '|' + ((ui.mode.opts && (ui.mode.opts.type || ui.mode.opts.purpose)) || '') : '';
        const toolStarted = !!toolKey && toolKey !== lastToolKey;
        lastToolKey = toolKey;
        // A message that was already showing when a tool is picked has done its job: the hint bar takes over
        // (otherwise it would jump from the top of the photo to the bottom). Errors and warnings stay.
        if (toolStarted && ui.toast && ui.toast.id === shownToastId && (ui.toast.kind === 'ok' || ui.toast.kind === 'info' || !ui.toast.kind)) {
          actions.dismissToast(ui.toast.id);
          return;
        }
        if (((drawing && !lastDrawing) || toolStarted) && !isDesktop() && ui.sheet !== 'min') {
          if (!restoreSheet) restoreSheet = ui.sheet;
          lastDrawing = drawing;
          actions.setSheet('min');
          return;
        }
        if (!drawing && lastDrawing && restoreSheet) {
          const s = restoreSheet;
          restoreSheet = null;
          lastDrawing = false;
          actions.setSheet(s);
          return;
        }
        lastDrawing = drawing;
        // Phone: a canvas tap that selects an item raises a collapsed sheet so its editor (and Delete) can be seen.
        const sel = ui.selection;
        const selKey = sel ? sel.kind + ':' + sel.id : null;
        if (selKey !== lastSelKey) {
          const was = lastSelKey;
          lastSelKey = selKey;
          if (selKey && was !== selKey && ui.mode.name === 'select' && !ui.afterTrace && !isDesktop() && ui.sheet === 'min') {
            actions.setSheet('half');
            return;
          }
        }
        appEl.setAttribute('data-sheet', ui.sheet);
        // Remember the step and view so a reload reopens where the user was.
        const prefNow = ui.step + '|' + ui.view.night + '|' + ui.view.preview;
        if (prefNow !== lastPref) {
          lastPref = prefNow;
          persist.savePref('ui', { step: ui.step, night: !!ui.view.night, preview: !!ui.view.preview });
        }
        if (handle) {
          handle.setAttribute('aria-label', 'Panel size: ' + ui.sheet + '. Tap to change.');
        }

        // Top bar
        if (nameInput && document.activeElement !== nameInput && nameInput.value !== (project.name || '')) nameInput.value = project.name || '';
        undoBtn.disabled = !actions.canUndo();
        redoBtn.disabled = !store.canRedo();
        const ul = actions.undoLabel();
        const rl = store.redoLabel();
        undoBtn.title = ul === 'Undo point' ? ul : ul ? 'Undo: ' + ul : 'Undo';
        undoBtn.setAttribute('aria-label', undoBtn.title);
        redoBtn.title = rl ? 'Redo: ' + rl : 'Redo';
        redoBtn.setAttribute('aria-label', redoBtn.title);

        // Step bar: a step is marked done by what the plan holds (photo, scale, traced items, an outlet), wherever
        // the user happens to be.
        let plan = null;
        try { plan = store.plan(); } catch (e) { plan = null; }
        const counts = panels.stepWarnings(plan);
        const progress = panels.planProgress(project, plan);
        for (const b of stepButtons) {
          const n = Number(b.getAttribute('data-step'));
          const cur = n === ui.step;
          if (cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
          const done = !!progress.steps[n];
          b.classList.toggle('done', done);
          b.setAttribute('data-done', String(done));
          const badge = b.querySelector('.step-badge');
          const c = counts[n];
          // Warnings first; a step with none shows how many of its measurements are rough (Low), in a neutral colour.
          const lowOnly = !c.count && c.low > 0;
          const shown = c.count || (lowOnly ? c.low : 0);
          if (badge) {
            badge.hidden = !shown;
            badge.textContent = shown ? String(shown) : '';
            badge.className = 'step-badge ' + (lowOnly ? 'neutral' : c.level || '');
          }
          const label = panels.STEPS[n - 1].label;
          b.setAttribute('aria-label', 'Step ' + n + ': ' + label + (done ? ', done' : '') + (c.count ? ', ' + c.count + (c.count === 1 ? ' warning' : ' warnings') : '') +
            (c.low ? ', ' + c.low + (c.low === 1 ? ' rough measurement' : ' rough measurements') : ''));
        }

        // Canvas controls
        const v = ui.view;
        setPressed(ctl.night, v.night && v.preview, 'Night preview (on)', 'Night preview (off)');
        if (ctl.night) {
          const ic = ctl.night.querySelector('[data-icon]');
          const want = v.night && v.preview ? 'moon' : 'sun';
          if (ic && ic.getAttribute('data-icon') !== want) { ic.setAttribute('data-icon', want); ic.textContent = ''; ic.appendChild(panels.icon(want)); }
        }
        setPressed(ctl.twinkle, v.twinkle && v.preview, 'Twinkle (on)', 'Twinkle (off)');
        setPressed(ctl.overlay, v.overlay, 'Tracing overlay (on)', 'Tracing overlay (off)');
        setPressed(ctl.labels, v.labels, 'Length labels (on)', 'Length labels (off)');
        setPressed(ctl.snap, v.snap, 'Snap to points (on)', 'Snap to points (off)');
        for (const k of ['zoomIn', 'zoomOut', 'fit']) if (ctl[k]) ctl[k].disabled = !image;

        // Hint bar
        const hint = hintFor(ui, project, plan);
        hintbar.hidden = !hint;
        if (hint) {
          hintText.textContent = hint.text;
          if (hintCount) { hintCount.textContent = hint.count || ''; hintCount.hidden = !hint.count; }
          if (hintActions) hintActions.hidden = !!hint.after;
          if (hintNext) hintNext.hidden = !hint.after || !!hint.fix;
          if (hintFix) hintFix.hidden = !(hint.after && hint.fix);
          if (hintFix && hint.after && hint.fix) {
            // A phone gets shorter labels where the full ones would not fit one row.
            const w = window.innerWidth || 1000;
            const tier = w < 380 ? 1 : w < 480 ? 2 : 0;
            const key = hint.fix.featureId + '|' + hint.fix.buttons.join(',') + '|' + tier;
            if (key !== hintFixKey) {
              hintFixKey = key;
              hintFix.textContent = '';
              for (const spec of hint.fix.buttons) {
                const name = spec.split(':')[0];
                const lab = FIX_LABEL[name] || [name];
                hintFix.appendChild(panels.h('button', {
                  type: 'button', id: 'hint-fix-' + name, class: 'btn small' + (/:primary$/.test(spec) ? ' primary' : ''),
                  'aria-label': lab[0], data: { fix: name, id: hint.fix.featureId },
                }, (tier && lab[tier]) || lab[0]));
              }
            }
          }
          if (hint.after && !hint.fix) {
            // The result of the trace just finished, and what to trace next.
            const key = hint.next.join(',');
            if (key !== hintNextKey && hintNextChips) {
              hintNextKey = key;
              hintNextChips.textContent = '';
              for (const t of hint.next) {
                hintNextChips.appendChild(panels.h('button', { type: 'button', class: 'btn small', data: { next: t } }, FEATURE_TYPES[t].short));
              }
            }
          } else if (!hint.after) {
            const pts = ui.draft && ui.draft.points ? ui.draft.points.length : 0;
            hintUndo.disabled = !pts;
            hintUndo.hidden = ui.mode.name === 'outlet';
            hintFinish.hidden = !(ui.mode.name === 'trace' && FEATURE_TYPES[ui.mode.opts.type] && FEATURE_TYPES[ui.mode.opts.type].geometry !== 'vertical');
            hintFinish.disabled = !hint.finish;
          }
        }
        // The surface being traced on, with a picker, right in the hint bar (the panel is collapsed while tracing).
        const tracing = ui.mode.name === 'trace';
        if (hintPlaneWrap) hintPlaneWrap.hidden = !tracing;
        if (tracing && hintPlane) {
          const planes = project.planes.filter((p) => !image || p.imageId === image.id);
          const key = planes.map((p) => p.id + '=' + p.name + '/' + actionsModule.surfaceKind(project, p)).join('|');
          if (key !== hintPlaneKey) {
            hintPlaneKey = key;
            hintPlane.textContent = '';
            for (const p of planes) {
              const o = document.createElement('option');
              o.value = p.id;
              o.textContent = planeLabel(p);
              hintPlane.appendChild(o);
            }
          }
          const pid = ui.mode.opts.planeId || ui.activePlaneId || '';
          if (hintPlane.value !== pid) hintPlane.value = pid;
        }
        renderNotice(ui);

        // Banner, empty state, busy
        const isSample = !!(image && image.source && image.source.kind === 'sample');
        banner.hidden = !(isSample && !ui.bannerDismissed && !hint && !ui.notice);
        const traced = project.features.length > 0;
        const bannerText = $('sample-banner-text');
        if (bannerText) {
          const long = traced
            ? 'This is a sample house, already measured and traced. Use your own photo to plan your house.'
            : 'This is the sample house with nothing measured yet. Practice calibrating and tracing, then use your own photo.';
          const short = traced ? 'Sample house, already traced.' : 'Sample house to practice on.';
          if (bannerText.getAttribute('data-text') !== long) {
            bannerText.setAttribute('data-text', long);
            bannerText.textContent = '';
            bannerText.appendChild(panels.h('span', { class: 'banner-long' }, long));
            bannerText.appendChild(panels.h('span', { class: 'banner-short' }, short));
          }
        }
        empty.hidden = !!image;
        busy.hidden = !ui.busy;
        if (ui.busy) busyText.textContent = ui.busy;

        // Fit when a new photo arrives.
        const el = image ? store.getImage(image.id) : null;
        if (el !== lastImageEl) {
          lastImageEl = el;
          if (el) { try { viewport.fit(); } catch (e) { /* ignore */ } }
        }

        // The pinned button: the next thing to do, always in view.
        if (actionBar && actionBtn) {
          const next = panels.nextAction(project, ui, plan);
          currentAction = next;
          const making = pdfBusy && next.id === 'save-pdf';
          actionBar.hidden = false;
          if (actionLabel) actionLabel.textContent = making ? 'Making PDF…' : next.label;
          actionBtn.disabled = making;
          actionBtn.className = 'btn block' + (next.primary ? ' primary' : '');
          actionBtn.setAttribute('data-action', next.id);
          if (actionNote) { actionNote.textContent = next.note || ''; actionNote.hidden = !next.note; }
        }

        renderToast(ui);
        renderDialog(ui);
        layoutOverlays();
      }
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
        raf(render);
      }
      return { render, schedule };
    }

    return { start, hintFor };
  });
