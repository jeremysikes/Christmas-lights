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
 */
LP.define('ui.app', ['schema', 'sample', 'catalog', 'ui.persist', 'ui.store', 'ui.imagesource', 'ui.actions', 'ui.panels'],
  function (schema, sample, catalog, persist, storeModule, imagesource, actionsModule, panels) {
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
      const defaults = storeModule.defaultUI();
      const store = storeModule.createStore({
        project,
        ui: {
          step: 1,
          sheet: 'half',
          view: Object.assign({}, defaults.view, { preview: true, night: true, twinkle: firstRun && !reducedMotion() }),
        },
      });
      const actions = actionsModule.createActions(store);
      persist.setErrorHandler((msg) => actions.toast(msg, 'warn'));

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

      if (restoreProblem) actions.toast(restoreProblem + ' Showing the sample house instead.', 'error');
      else if (!firstRun) actions.toast('Welcome back. Your plan was restored.', 'ok');

      // Expose for debugging and end-to-end tests (read-only use).
      try { window.LightPlanApp = { store, actions, viewport }; } catch (e) { /* ignore */ }
    }

    // ================================================================ shell wiring
    function hintFor(ui, project) {
      const mode = ui.mode || {};
      const o = mode.opts || {};
      const pts = ui.draft && Array.isArray(ui.draft.points) ? ui.draft.points.length : 0;
      const plane = project.planes.find((p) => p.id === o.planeId);
      const pname = plane ? "'" + plane.name + "'" : 'this wall';
      if (mode.name === 'rect') {
        const what = o.purpose === 'refRect' ? referenceName(o.presetId) : rectName(o.presetId);
        return { text: 'Tap the 4 corners of ' + what + ' on ' + pname + '. Zoom in for accuracy.', count: pts + ' of 4', finish: false };
      }
      if (mode.name === 'line') {
        if (o.purpose === 'roofEave') return { text: 'Tap both ends of the eave where the roof slope meets ' + pname + '.', count: pts + ' of 2', finish: false };
        if (o.purpose === 'groundBase') return { text: 'Tap two points along the bottom of ' + pname + ', where it meets the ground.', count: pts + ' of 2', finish: false };
        if (o.purpose === 'planeLine') return { text: plane && plane.kind === 'roof' ? 'Tap both ends of the eave again.' : 'Tap two points along the bottom of the wall again.', count: pts + ' of 2', finish: false };
        if (o.courses) return { text: 'Tap the bottom edge of one course, then the bottom edge of the course ' + o.courses + ' courses up.', count: pts + ' of 2', finish: false };
        return { text: 'Tap both ends of the ' + referenceName(o.presetId).replace(/^an? /, '') + ' on ' + pname + '.', count: pts + ' of 2', finish: false };
      }
      if (mode.name === 'trace') {
        const ft = FEATURE_TYPES[o.type];
        if (!ft) return null;
        const label = ft.label.toLowerCase();
        if (ft.geometry === 'vertical') return { text: 'Tap the base of the ' + label.replace(/ \(.*\)/, '') + ', then its top.', count: pts + ' of 2', finish: false };
        if (ft.geometry === 'polygon' || ft.geometry === 'area') return { text: 'Tap around the ' + label.replace(/ \(.*\)/, '') + '. Tap the first point to close it, or tap Finish.', count: pts ? pts + ' points' : '', finish: pts >= 3 };
        return { text: 'Tap along the ' + label + ', corner by corner. Double-tap or tap Finish when done.', count: pts ? pts + ' points' : '', finish: pts >= 2 };
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
    function referenceName(presetId) {
      return {
        'door-height': 'the entry door height', 'door-width': 'the entry door width', 'door-rect': 'the entry door',
        'garage-single': 'the garage door', 'garage-double': 'the garage door', 'garage-height': 'the garage door height',
        'custom-line': 'the line you measured', 'custom-rect': 'the rectangle you measured',
      }[presetId] || 'the reference';
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
        night: $('ctl-night'), twinkle: $('ctl-twinkle'), overlay: $('ctl-overlay'), labels: $('ctl-labels'),
      };

      let scheduled = false;
      let toastTimer = null;
      let shownToastId = null;
      let lastImageEl = null;
      let lastDialog = null;
      let restoreSheet = null;
      let lastModeName = 'select';
      let dialogReturnFocus = null;

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
      on(ctl.night, 'click', () => {
        const v = store.ui().view;
        // Night only makes sense with the lights on, so turning night on also turns the preview on.
        actions.setView(v.night ? { night: false } : { night: true, preview: true });
      });
      on(ctl.twinkle, 'click', () => {
        const v = store.ui().view;
        actions.setView(v.twinkle ? { twinkle: false } : { twinkle: true, preview: true });
      });
      on(ctl.overlay, 'click', () => flip('overlay'));
      on(ctl.labels, 'click', () => flip('labels'));

      // ---------------------------------------------------------------- hint bar, banner, empty state
      on(hintUndo, 'click', () => actions.removeLastDraftPoint());
      on(hintCancel, 'click', () => actions.cancelDraft());
      on(hintFinish, 'click', () => actions.completeDraft());
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
        appEl.classList.remove('sheet-dragging');
        if (!d.moved) {
          const cur = store.ui().sheet;
          actions.setSheet(cur === 'min' ? 'half' : cur === 'half' ? 'full' : 'min');
          return;
        }
        const hNow = panelEl.getBoundingClientRect().height;
        panelEl.style.flexBasis = '';
        // Snap to the nearest size by measuring each one.
        let best = 'half';
        let bestD = Infinity;
        for (const s of SHEETS) {
          appEl.setAttribute('data-sheet', s);
          const dist = Math.abs(panelEl.getBoundingClientRect().height - hNow);
          if (dist < bestD) { bestD = dist; best = s; }
        }
        appEl.setAttribute('data-sheet', store.ui().sheet);
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

        // Phone: collapse the sheet while a drawing tool is active, restore it afterwards.
        const drawing = DRAW_MODES.includes(ui.mode.name);
        if (drawing && !DRAW_MODES.includes(lastModeName) && !isDesktop() && ui.sheet !== 'min') {
          restoreSheet = ui.sheet;
          lastModeName = ui.mode.name;
          actions.setSheet('min');
          return;
        }
        if (!drawing && DRAW_MODES.includes(lastModeName) && restoreSheet) {
          const s = restoreSheet;
          restoreSheet = null;
          lastModeName = ui.mode.name;
          actions.setSheet(s);
          return;
        }
        lastModeName = ui.mode.name;
        appEl.setAttribute('data-sheet', ui.sheet);
        if (handle) {
          handle.setAttribute('aria-label', 'Panel size: ' + ui.sheet + '. Tap to change.');
        }

        // Top bar
        if (nameInput && document.activeElement !== nameInput && nameInput.value !== (project.name || '')) nameInput.value = project.name || '';
        undoBtn.disabled = !actions.canUndo();
        redoBtn.disabled = !store.canRedo();
        const ul = actions.undoLabel();
        const rl = store.redoLabel();
        undoBtn.title = ul ? 'Undo: ' + ul : 'Undo';
        undoBtn.setAttribute('aria-label', undoBtn.title);
        redoBtn.title = rl ? 'Redo: ' + rl : 'Redo';
        redoBtn.setAttribute('aria-label', redoBtn.title);

        // Step bar
        const counts = panels.stepWarnings(store.plan());
        for (const b of stepButtons) {
          const n = Number(b.getAttribute('data-step'));
          const cur = n === ui.step;
          if (cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
          b.classList.toggle('done', n < ui.step);
          const badge = b.querySelector('.step-badge');
          const c = counts[n];
          if (badge) {
            badge.hidden = !c.count;
            badge.textContent = c.count ? String(c.count) : '';
            badge.className = 'step-badge ' + (c.level || '');
          }
          const label = panels.STEPS[n - 1].label;
          b.setAttribute('aria-label', 'Step ' + n + ': ' + label + (c.count ? ', ' + c.count + (c.count === 1 ? ' warning' : ' warnings') : ''));
        }

        // Canvas controls
        const v = ui.view;
        setPressed(ctl.night, v.night && v.preview, 'Night preview (on)', 'Night preview (off)');
        if (ctl.night) {
          const ic = ctl.night.querySelector('[data-icon]');
          const want = v.night ? 'moon' : 'sun';
          if (ic && ic.getAttribute('data-icon') !== want) { ic.setAttribute('data-icon', want); ic.textContent = ''; ic.appendChild(panels.icon(want)); }
        }
        setPressed(ctl.twinkle, v.twinkle && v.preview, 'Twinkle (on)', 'Twinkle (off)');
        setPressed(ctl.overlay, v.overlay, 'Tracing overlay (on)', 'Tracing overlay (off)');
        setPressed(ctl.labels, v.labels, 'Length labels (on)', 'Length labels (off)');
        for (const k of ['zoomIn', 'zoomOut', 'fit']) if (ctl[k]) ctl[k].disabled = !image;

        // Hint bar
        const hint = hintFor(ui, project);
        hintbar.hidden = !hint;
        if (hint) {
          hintText.textContent = hint.text;
          if (hintCount) { hintCount.textContent = hint.count || ''; hintCount.hidden = !hint.count; }
          const pts = ui.draft && ui.draft.points ? ui.draft.points.length : 0;
          hintUndo.disabled = !pts;
          hintUndo.hidden = ui.mode.name === 'outlet';
          hintFinish.hidden = !(ui.mode.name === 'trace' && FEATURE_TYPES[ui.mode.opts.type] && FEATURE_TYPES[ui.mode.opts.type].geometry !== 'vertical');
          hintFinish.disabled = !hint.finish;
        }

        // Banner, empty state, busy
        const isSample = !!(image && image.source && image.source.kind === 'sample');
        banner.hidden = !(isSample && !ui.bannerDismissed && !hint);
        const traced = project.features.length > 0;
        const bannerText = $('sample-banner-text');
        if (bannerText) {
          bannerText.textContent = traced
            ? 'This is a sample house, already measured and traced. Use your own photo to plan your house.'
            : 'This is the sample house with nothing measured yet. Practice calibrating and tracing, then use your own photo.';
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

        renderToast(ui);
        renderDialog(ui);
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
