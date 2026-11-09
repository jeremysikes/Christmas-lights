/* LightPlan UI: panels (SPEC §6.6).
 * The six step panels: 1 Upload, 2 Calibrate, 3 Trace, 4 Design, 5 Power, 6 Review & Export.
 *
 * Rendering model
 *  - Each render builds a fresh, detached DOM tree for the current step with h() and then MORPHS the live panel
 *    into it: nodes of the same tag (and data-key) are kept and patched, so a focused input, its caret, an open
 *    <details> and the scroll position all survive. A focused text field's value is never overwritten.
 *  - Text inputs commit on `change` (Enter or leaving the field), never per keystroke.
 *  - All events are delegated from the panel root: interactive elements carry data-act (+ data-id etc.) and a
 *    handler reads the current project from the store when the event fires, so no handler holds stale data.
 *  - Renders are batched to one per animation frame.
 *
 * Deviations from SPEC §6.6 (additive): mount() returns {render, destroy}. Module exports also icon(name),
 * h(), morph(), pickFile(actions, kind), exportFile(store, actions, kind), stepWarnings(plan), STEPS,
 * validateProducts(list).
 */
LP.define('ui.panels', ['catalog', 'measure', 'camera', 'design', 'power', 'ui.actions', 'ui.persist', 'ui.store'],
  function (catalog, measure, camera, design, power, actionsModule, persist, storeModule) {
    'use strict';

    const { FEATURE_TYPES, TYPE_ORDER, COLOR_MODES } = catalog;
    const parseLength = actionsModule.parseLength;
    const arr = (v) => (Array.isArray(v) ? v : []);
    const byId = (list, id) => arr(list).find((x) => x && x.id === id) || null;
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

    // ================================================================ icons (inline SVG, 24×24, stroked)
    const ICONS = {
      undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
      redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
      more: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
      zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6M11 8v6M8 11h6"/>',
      zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6M8 11h6"/>',
      fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
      moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      sparkle: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5"/><path d="m6.5 6.5 2 2M15.5 15.5l2 2M6.5 17.5l2-2M15.5 8.5l2-2"/>',
      layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
      tag: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8" r="1.5"/>',
      camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
      image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
      house: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
      check: '<path d="m5 12 5 5 9-10"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      chevronDown: '<path d="m6 9 6 6 6-6"/>',
      bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
      plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v4"/>',
      warning: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
      download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
      folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
      file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
      pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
      arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      reset: '<path d="M4 12a8 8 0 1 0 2.3-5.6L4 9"/><path d="M4 4v5h5"/>',
      corners: '<rect x="5" y="7" width="14" height="10" stroke-dasharray="3 2"/><circle cx="5" cy="7" r="1.8" fill="currentColor"/><circle cx="19" cy="7" r="1.8" fill="currentColor"/><circle cx="19" cy="17" r="1.8" fill="currentColor"/><circle cx="5" cy="17" r="1.8" fill="currentColor"/>',
      ruler: '<path d="M5 19 19 5"/><circle cx="5" cy="19" r="2" fill="currentColor"/><circle cx="19" cy="5" r="2" fill="currentColor"/>',
      magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
      table: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 10h18M9 10v9"/>',
    };
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function icon(name, cls) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.innerHTML = ICONS[name] || ICONS.info;
      return svg;
    }

    // ================================================================ tiny DOM builder
    function append(el, kids) {
      for (const k of kids) {
        if (k == null || k === false || k === true) continue;
        if (Array.isArray(k)) append(el, k);
        else if (typeof k === 'string' || typeof k === 'number') el.appendChild(document.createTextNode(String(k)));
        else el.appendChild(k);
      }
    }
    /**
     * h('button', {class, data: {act, id}, disabled: true, 'aria-label': ...}, ...children).
     * value / checked are applied as properties after children (so a <select> can pick its option).
     */
    function h(tag, props) {
      const el = document.createElement(tag);
      let value;
      let checked;
      if (props) {
        for (const k of Object.keys(props)) {
          const v = props[k];
          if (v == null || v === false) continue;
          if (k === 'class') el.className = v;
          else if (k === 'value') value = v;
          else if (k === 'checked') checked = !!v;
          else if (k === 'data') {
            for (const dk of Object.keys(v)) if (v[dk] != null) el.setAttribute('data-' + dk, String(v[dk]));
          } else if (v === true) el.setAttribute(k, '');
          else el.setAttribute(k, String(v));
        }
      }
      append(el, Array.prototype.slice.call(arguments, 2));
      if (value !== undefined) el.value = String(value);
      if (checked !== undefined) el.checked = checked;
      return el;
    }

    // ================================================================ morph (patch live DOM toward a new tree)
    const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null);
    function sameKind(a, b) {
      if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
      if (a.nodeType !== 1) return true;
      if (keyOf(a) !== keyOf(b)) return false;
      return a.nodeName !== 'INPUT' || a.type === b.type;
    }
    function syncAttrs(from, to) {
      const keepOpen = from.nodeName === 'DETAILS' && !to.hasAttribute('data-open-sync');
      for (let i = from.attributes.length - 1; i >= 0; i--) {
        const n = from.attributes[i].name;
        if (keepOpen && n === 'open') continue;
        if (!to.hasAttribute(n)) from.removeAttribute(n);
      }
      for (const a of Array.from(to.attributes)) {
        if (keepOpen && a.name === 'open') continue;
        if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
      }
    }
    function syncValue(from, to) {
      if (from.nodeName === 'INPUT' && (from.type === 'checkbox' || from.type === 'radio')) {
        if (from.checked !== to.checked) from.checked = to.checked;
        return;
      }
      const focused = typeof document !== 'undefined' && document.activeElement === from;
      if (focused && from.nodeName !== 'SELECT') return; // never clobber what the user is typing
      if (from.value !== to.value) from.value = to.value;
    }
    function morphChildren(from, to) {
      const keyed = new Map();
      for (let c = from.firstChild; c; c = c.nextSibling) { const k = keyOf(c); if (k) keyed.set(k, c); }
      let cur = from.firstChild;
      for (const nk of Array.from(to.childNodes)) {
        const k = keyOf(nk);
        let match = null;
        if (k) {
          match = keyed.get(k) || null;
          if (match && !sameKind(match, nk)) match = null;
        } else if (cur && !keyOf(cur) && sameKind(cur, nk)) {
          match = cur;
        }
        if (match) {
          if (k) keyed.delete(k);
          if (match === cur) cur = cur.nextSibling;
          else from.insertBefore(match, cur);
          morph(match, nk);
        } else {
          from.insertBefore(nk, cur);
        }
      }
      while (cur) { const next = cur.nextSibling; from.removeChild(cur); cur = next; }
    }
    /** Make `from` look like `to`, reusing nodes. Returns the resulting live node. */
    function morph(from, to) {
      if (!sameKind(from, to)) { from.parentNode.replaceChild(to, from); return to; }
      if (from.nodeType !== 1) {
        if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
        return from;
      }
      syncAttrs(from, to);
      if (from.nodeName === 'TEXTAREA') { syncValue(from, to); return from; }
      morphChildren(from, to);
      if (from.nodeName === 'INPUT' || from.nodeName === 'SELECT') syncValue(from, to);
      return from;
    }

    // ================================================================ formatting
    function groupInt(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    function fmtNum(v, d) {
      if (!isNum(v)) return '—';
      const fixed = Math.abs(v).toFixed(d || 0);
      const [i, f] = fixed.split('.');
      return (v < 0 && Number(fixed) !== 0 ? '-' : '') + groupInt(i) + (f ? '.' + f : '');
    }
    const money = (v) => (isNum(v) ? '$' + fmtNum(v, 2) : '—');
    const watts = (v) => fmtNum(v, isNum(v) && v < 100 ? 1 : 0) + ' W';
    const trimNum = (v, d) => (isNum(v) ? String(Math.round(v * Math.pow(10, d)) / Math.pow(10, d)) : '');
    /** "+1.2%", "-0.4%", and "0.0%" (never "-0.0%") for values that round to zero. */
    function signedPct(v) {
      const t = Math.abs(v).toFixed(1);
      return (Number(t) === 0 ? '' : v > 0 ? '+' : '-') + t + '%';
    }
    function plural(n, one, many) { return fmtNum(n, 0) + ' ' + (n === 1 ? one : many); }
    const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'], pack: ['pack', 'packs'], each: ['', ''] };
    function unitWord(unit, n) { const w = UNIT_WORDS[unit] || ['unit', 'units']; return n === 1 ? w[0] : w[1]; }
    function hashKey(s) {
      let x = 5381;
      for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
      return (x >>> 0).toString(36);
    }

    // ================================================================ steps and warnings
    const STEPS = [
      { n: 1, label: 'Upload', title: 'Add a photo' },
      { n: 2, label: 'Calibrate', title: 'Calibrate the photo' },
      { n: 3, label: 'Trace', title: 'Trace the lights' },
      { n: 4, label: 'Design', title: 'Choose the lights' },
      { n: 5, label: 'Power', title: 'Plan the power' },
      { n: 6, label: 'Review', title: 'Review and export' },
    ];
    const POWER_CODES = new Set(['incandescent', 'circuit-overload', 'circuit-high', 'max-end-to-end', 'cord-walkway', 'no-gfci',
      'interior-outlet', 'voltage-drop', 'long-cord', 'no-outlets', 'unassigned', 'cord-unknown', 'outlet-no-circuit',
      'outlet-missing', 'cord-ampacity']);
    const STAGE_STEP = { library: 4, measure: 2, design: 4, power: 5, merge: 5, bom: 6, quote: 6, checklist: 6, summary: 6 };
    /** Which step a plan warning belongs to. */
    function warningStep(w) {
      if (w.code === 'internal-error') return STAGE_STEP[w.stage] || 6;
      if (POWER_CODES.has(w.code) || w.outletId || w.circuitId) return 5;
      if (w.code === 'run') return 4;
      if (w.planeId || /^(pitch|ref|plane|rect|measure|derived)/.test(w.code || '')) return 2;
      if (w.featureId) return 3;
      return 6;
    }
    /** {step: {count, level}} of warn/danger warnings per step (info and the disclaimer are not counted). */
    function stepWarnings(plan) {
      const out = {};
      for (const s of STEPS) out[s.n] = { count: 0, level: null };
      for (const w of arr(plan && plan.warnings)) {
        if (!w || w.code === 'disclaimer' || (w.level !== 'warn' && w.level !== 'danger')) continue;
        const s = out[warningStep(w)];
        s.count += 1;
        if (w.level === 'danger' || !s.level) s.level = w.level;
      }
      return out;
    }

    // ================================================================ files and exports (shared with app.js)
    /** Open a file picker ('file' | 'camera' | 'json'), asking first if the current plan would be replaced. */
    function pickFile(actions, kind) {
      const id = kind === 'camera' ? 'camera-input' : kind === 'json' ? 'json-input' : 'file-input';
      const input = document.getElementById(id);
      if (!input) return;
      actions.confirmReplace().then((ok) => {
        if (!ok) return;
        try { input.value = ''; } catch (e) { /* some browsers refuse; harmless */ }
        input.click();
      });
    }
    const EXPORT_DONE = {
      pdf: 'Report saved as a PDF.', quote: 'Customer quote saved as a PDF.', csv: 'Shopping list saved as a CSV file.', json: 'Project saved. Open it again with Open project.',
    };
    /** Run one export ('pdf' | 'quote' | 'csv' | 'json') and report the result in a toast. */
    function exportFile(store, actions, kind) {
      const exp = typeof LP !== 'undefined' && LP.has('ui.export') ? LP.require('ui.export') : null;
      if (!exp) { actions.toast('Saving files is not available in this build.', 'error'); return Promise.resolve('failed'); }
      const run = {
        pdf: () => exp.exportPdfReport(store),
        quote: () => exp.exportQuotePdf(store),
        csv: () => exp.exportCsv(store),
        json: () => exp.exportJson(store, { includeImages: true }),
      }[kind];
      if (!run) return Promise.resolve('failed');
      return Promise.resolve().then(run).then((res) => {
        if (res === 'failed') actions.toast('The file could not be saved. Try again.', 'error');
        else if (res !== 'declined') actions.toast(EXPORT_DONE[kind], 'ok');
        return res;
      }, (e) => {
        actions.toast(e && e.message ? e.message : 'The file could not be made. Try again.', 'error');
        return 'failed';
      });
    }

    // ================================================================ product / config validation
    const PRODUCT_CATEGORIES = ['c9', 'c7', 'mini', 'icicle', 'net', 'rope', 'track', 'path', 'treewrap'];
    const PRODUCT_UNITS = ['string', 'net', 'set', 'foot'];
    /** Check a product list typed as JSON. Returns {ok, errors: [plain sentences]}. */
    function validateProducts(list) {
      const errors = [];
      if (!Array.isArray(list)) return { ok: false, errors: ['The product list must be a JSON array: [ {...}, {...} ].'] };
      if (!list.length) errors.push('The product list is empty. Use "Reset to defaults" to start again.');
      const ids = new Set();
      list.forEach((p, i) => {
        const where = 'Product ' + (i + 1) + (p && p.name ? ' ("' + p.name + '")' : '');
        if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push(where + ' is not an object.'); return; }
        if (typeof p.id !== 'string' || !p.id.trim()) errors.push(where + ' needs an "id".');
        else if (ids.has(p.id)) errors.push(where + ' uses the id "' + p.id + '" twice.');
        else ids.add(p.id);
        if (typeof p.name !== 'string' || !p.name.trim()) errors.push(where + ' needs a "name".');
        if (!PRODUCT_CATEGORIES.includes(p.category)) errors.push(where + ': "category" must be one of ' + PRODUCT_CATEGORIES.join(', ') + '.');
        if (!PRODUCT_UNITS.includes(p.unit)) errors.push(where + ': "unit" must be one of ' + PRODUCT_UNITS.join(', ') + '.');
        for (const k of ['price', 'wattsPerUnit', 'bulbsPerUnit']) if (!(isNum(p[k]) && p[k] >= 0)) errors.push(where + ': "' + k + '" must be a number of 0 or more.');
        for (const k of ['stringLengthFt', 'maxEndToEnd']) if (!(isNum(p[k]) && p[k] > 0)) errors.push(where + ': "' + k + '" must be a number above 0.');
        if (!Array.isArray(p.suitableFor) || p.suitableFor.some((t) => !FEATURE_TYPES[t])) errors.push(where + ': "suitableFor" must list feature types such as "roofline" or "window".');
        if (p.enabled !== undefined && typeof p.enabled !== 'boolean') errors.push(where + ': "enabled" must be true or false.');
      });
      return { ok: errors.length === 0, errors };
    }
    /** Only the leaves of `obj` that differ from `base` (so stored overrides stay small). */
    function diffConfig(base, obj) {
      if (!catalog.isPlainObject(obj)) return null;
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const b = base ? base[k] : undefined;
        if (catalog.isPlainObject(v) && catalog.isPlainObject(b)) {
          const d = diffConfig(b, v);
          if (d && Object.keys(d).length) out[k] = d;
        } else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = catalog.deepClone(v);
      }
      return out;
    }
    function getPath(obj, path) { return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj); }
    function setPath(obj, path, value) {
      const keys = path.split('.');
      let o = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!catalog.isPlainObject(o[keys[i]])) o[keys[i]] = {};
        o = o[keys[i]];
      }
      if (value == null) delete o[keys[keys.length - 1]];
      else o[keys[keys.length - 1]] = value;
      return obj;
    }

    const CONFIG_FIELDS = [
      ['clipSpacingIn', 'Clip spacing', 'in'],
      ['bush.lightsPerUnit', 'Bush lights per size unit', 'lights'],
      ['bush.heightUnitFt', 'Bush size unit: height', 'ft'],
      ['bush.widthUnitFt', 'Bush size unit: width', 'ft'],
      ['bush.netCoverFactor', 'Net lights: extra coverage', '×'],
      ['tree.defaultDiameterIn', 'Tree trunk diameter', 'in'],
      ['tree.spiralSpacingIn', 'Tree wrap spacing', 'in'],
      ['tree.canopyLightsPerFtHeight', 'Canopy lights per foot of height', 'lights'],
      ['column.defaultDiameterIn', 'Column diameter', 'in'],
      ['column.spiralSpacingIn', 'Column wrap spacing', 'in'],
      ['stakes.spacingIn', 'Light stake spacing', 'in'],
      ['power.continuousFactor', 'Safe share of the breaker', '× rating'],
      ['power.maxVoltageDropPct', 'Largest voltage drop allowed', '%'],
      ['power.cordSlackFt', 'Extra cord at each end', 'ft'],
      ['power.routingFactor', 'Cord routing allowance', '×'],
      ['power.chainGapFt', 'Join runs closer than', 'ft'],
      ['labor.ftPerHour', 'Install speed', 'ft per hour'],
      ['labor.setupHours', 'Setup time', 'hours'],
      ['labor.hoursPerTree', 'Time per tree', 'hours'],
      ['labor.hoursPerBush', 'Time per bush', 'hours'],
      ['refDisagreementWarnPct', 'Warn when references disagree by', '%'],
    ];

    // ================================================================ text tables
    const PLANE_KIND = { wall: 'Wall', roof: 'Roof slope', ground: 'Ground' };
    const SOURCE_KIND = { upload: 'Uploaded photo', camera: 'Phone camera', sample: 'Sample house', streetview: 'Street View', aerial: 'Aerial view' };
    const FOCAL_SOURCE = { exif: 'From the photo', rectangle: 'Measured', manual: 'Entered by hand', preset: 'Preset', default: 'Assumed' };
    const MODE_TEXT = {
      'rect-known': 'Measured from a rectangle of known size.',
      'rect-refs': "Measured from the rectangle's shape, scaled by your reference lengths.",
      'refs-only': 'Measured from reference lengths only, as if the photo was taken straight on.',
      'roof-3d': 'Worked out in 3D from the wall below it.',
      'roof-ortho': 'Approximated from the wall below it, which has no perspective rectangle.',
      'ground-3d': 'Worked out in 3D from the wall behind it.',
    };
    const OUTLET_TYPES = [['exteriorGfci', 'Outdoor GFCI'], ['garage', 'Garage'], ['interior', 'Indoor'], ['other', 'Other']];
    const LEVEL_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
    const CALIBRATE_SENTENCE = 'Tap the four corners of something rectangular on this wall, like the garage door, and LightPlan ' +
      'will un-tilt the photo so measurements come out as if you stood straight in front of it.';
    const WASTE_NOTE = 'Add 10% for waste, corners and drops to the outlet';
    const PHOTO_TIPS = [
      'Stand across the street so the whole front of the house fits in the photo.',
      'Hold the phone level at chest height and use the main (1×) lens.',
      'Take it in daylight, even if you plan to check the night preview.',
      'Keep the garage door or front door in view: they make good size references.',
      'Upload the original photo, not a crop or an edit, so LightPlan can read the lens data.',
    ];

    // ================================================================ small components
    function button(label, o) {
      const opts = o || {};
      return h('button', {
        type: 'button', class: 'btn' + (opts.cls ? ' ' + opts.cls : ''), disabled: !!opts.disabled,
        data: Object.assign({ act: opts.act }, opts.data || {}), 'aria-label': opts.aria || null, title: opts.title || null,
        'aria-pressed': opts.pressed == null ? null : String(!!opts.pressed), 'data-key': opts.key || null,
      }, opts.icon ? icon(opts.icon) : null, label ? h('span', null, label) : null);
    }
    function iconButton(name, aria, o) {
      const opts = o || {};
      return h('button', {
        type: 'button', class: 'icon-btn' + (opts.cls ? ' ' + opts.cls : ''), 'aria-label': aria, title: aria,
        disabled: !!opts.disabled, data: Object.assign({ act: opts.act }, opts.data || {}),
      }, icon(name));
    }
    const fk = (act, id, field) => act + ':' + (id || '') + ':' + (field || '');
    function textInput(o) {
      return h('input', {
        type: 'text', class: 'input' + (o.cls ? ' ' + o.cls : ''), value: o.value == null ? '' : o.value, placeholder: o.placeholder || null,
        autocomplete: 'off', spellcheck: 'false', inputmode: o.inputmode || null, maxlength: o.maxlength || 200,
        data: Object.assign({ act: o.act, fk: fk(o.act, o.data && o.data.id, o.data && (o.data.field || o.data.path || o.data.sku || o.data.index)) }, o.data || {}),
        'aria-label': o.aria || null, id: o.idAttr || null,
      });
    }
    function numInput(o) {
      return h('input', {
        type: 'number', class: 'input num' + (o.cls ? ' ' + o.cls : ''), value: isNum(o.value) ? trimNum(o.value, o.decimals == null ? 2 : o.decimals) : '',
        min: o.min == null ? null : o.min, max: o.max == null ? null : o.max, step: o.step || 'any', inputmode: 'decimal',
        placeholder: o.placeholder == null ? null : String(o.placeholder),
        data: Object.assign({ act: o.act, fk: fk(o.act, o.data && o.data.id, o.data && (o.data.field || o.data.path || o.data.sku || o.data.index)) }, o.data || {}),
        'aria-label': o.aria || null, id: o.idAttr || null,
      });
    }
    function selectInput(o) {
      return h('select', {
        class: 'input select' + (o.cls ? ' ' + o.cls : ''), value: o.value == null ? '' : o.value,
        data: Object.assign({ act: o.act, fk: fk(o.act, o.data && o.data.id, o.data && o.data.field) }, o.data || {}),
        'aria-label': o.aria || null, id: o.idAttr || null, disabled: !!o.disabled,
      }, o.options.map((op) => h('option', { value: op[0], disabled: !!op[2] }, op[1])));
    }
    let fieldSeq = 0;
    /** A labelled control. The control gets an id so the <label for> works even after morphing. */
    function field(label, control, hint, cls) {
      const id = control.id || ('f-' + (control.getAttribute('data-fk') || ++fieldSeq)).replace(/[^a-zA-Z0-9_-]/g, '_');
      control.id = id;
      return h('div', { class: 'field' + (cls ? ' ' + cls : '') },
        h('label', { class: 'field-label', for: id }, label), control, hint ? h('p', { class: 'field-hint' }, hint) : null);
    }
    function toggle(label, o) {
      return h('label', { class: 'switch' + (o.cls ? ' ' + o.cls : '') },
        h('input', { type: 'checkbox', role: 'switch', checked: !!o.checked, data: Object.assign({ act: o.act }, o.data || {}) }),
        h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        h('span', { class: 'switch-label' }, label));
    }
    function section(title, kids, o) {
      const opts = o || {};
      return h('section', { class: 'sec' + (opts.cls ? ' ' + opts.cls : ''), 'data-key': opts.key || null },
        title ? h('h3', { class: 'sec-title' }, title, opts.extra || null) : null, kids);
    }
    function disclosure(title, kids, o) {
      const opts = o || {};
      return h('details', { class: 'disclosure' + (opts.cls ? ' ' + opts.cls : ''), open: !!opts.open, 'data-key': opts.key || null },
        h('summary', null, h('span', null, title), icon('chevronDown', 'chev')), h('div', { class: 'disclosure-body' }, kids));
    }
    function callout(kind, text, o) {
      const opts = o || {};
      const ic = kind === 'danger' || kind === 'warn' ? 'warning' : kind === 'ok' ? 'check' : 'info';
      return h('div', { class: 'callout ' + kind, role: kind === 'danger' ? 'alert' : null, 'data-key': opts.key || null },
        icon(ic), h('div', { class: 'callout-body' }, h('p', null, text), opts.after || null));
    }
    function pill(level, extra) {
      const lv = LEVEL_LABEL[level] ? level : 'low';
      return h('span', { class: 'pill ' + lv }, LEVEL_LABEL[lv] + (extra ? ' ' + extra : ''));
    }
    function confidenceBlock(conf, key) {
      if (!conf) return null;
      return h('details', { class: 'reasons', 'data-key': key || null },
        h('summary', null, pill(conf.level), h('span', { class: 'reasons-toggle' }, 'Confidence ' + conf.score + '/100 · why'), icon('chevronDown', 'chev')),
        h('ul', null, arr(conf.reasons).map((r) => h('li', null, r))));
    }
    function swatch(color, cls) {
      return h('span', { class: 'swatch' + (cls ? ' ' + cls : ''), style: 'background:' + color, 'aria-hidden': 'true' });
    }
    function head(n, sub) {
      return h('header', { class: 'panel-head' },
        h('p', { class: 'eyebrow' }, 'Step ' + n + ' of 6'),
        h('h2', { class: 'panel-title' }, STEPS[n - 1].title),
        sub ? h('p', { class: 'panel-sub' }, sub) : null);
    }
    function nextButton(n) {
      if (n >= 6) {
        return h('div', { class: 'panel-next' },
          button('Save project (JSON)', { act: 'export', data: { kind: 'json' }, cls: 'primary block', icon: 'download' }),
          h('p', { class: 'hint center' }, 'Saving keeps the photo, tracing and settings in one file you can open later.'));
      }
      return h('div', { class: 'panel-next' },
        button('Next: ' + STEPS[n].label, { act: 'go-step', data: { step: n + 1 }, cls: 'primary block', icon: 'arrowRight' }));
    }
    function dl(rows) {
      return h('dl', { class: 'facts' }, rows.filter(Boolean).map((r) => h('div', { class: 'fact' }, h('dt', null, r[0]), h('dd', { class: r[2] || null }, r[1]))));
    }
    function warningList(list, withSteps) {
      if (!list.length) return null;
      return h('ul', { class: 'warn-list' }, list.map((w, i) => h('li', { class: 'warn-item ' + w.level, 'data-key': 'w' + i + hashKey(w.message) },
        icon(w.level === 'info' ? 'info' : 'warning'),
        h('span', null, w.message),
        withSteps ? button('Step ' + warningStep(w), { act: 'go-step', data: { step: warningStep(w) }, cls: 'small ghost' }) : null)));
    }

    // ================================================================ derived context per render
    function makeCtx(store) {
      const project = store.project();
      const ui = store.ui();
      const plan = store.plan();
      const image = storeModule.activeImageOf(project);
      const planes = arr(project.planes).filter((p) => !image || p.imageId === image.id);
      const features = arr(project.features).filter((f) => !image || f.imageId === image.id || f.imageId == null);
      const fmtFmt = project.settings && project.settings.lengthFormat;
      return {
        store, project, ui, plan, image, planes, features,
        config: plan.library.config,
        sols: plan.measured.planes || {},
        fmt: (ft) => measure.formatLength(ft, fmtFmt),
        activePlane: byId(planes, ui.activePlaneId) || planes[0] || null,
      };
    }

    function planeConfidence(ctx, sol) {
      if (!sol || !sol.ok) return null;
      const K = ctx.image ? ctx.plan.measured.cameras[ctx.image.id] : null;
      return measure.scoreConfidence({
        mode: sol.mode, checks: sol.checks, disagreementPct: sol.disagreementPct,
        onlyMediumLowRefs: sol.calib && sol.calib.onlyMediumLowRefs, minCourses: sol.calib && sol.calib.minCourses,
        viewAngleDeg: sol.viewAngleDeg, focalSource: K && K.source, pitchSource: sol.pitch && sol.pitch.source,
        thresholds: ctx.config.confidence,
      });
    }

    // ================================================================ step 1: Upload
    function stepUpload(ctx) {
      const { image, plan } = ctx;
      const isSample = !!(image && image.source && image.source.kind === 'sample');
      const kids = [head(1, 'Use a photo of the front of the house. Every measurement comes from it.')];
      kids.push(h('div', { class: 'dropzone', 'data-key': 'dropzone' },
        icon('image', 'dz-icon'),
        h('p', { class: 'dz-title' }, 'Drop a photo here'),
        h('p', { class: 'dz-sub' }, 'You can also drop it anywhere on the picture.'),
        h('div', { class: 'btn-row' },
          button('Choose photo', { act: 'pick', data: { kind: 'file' }, cls: 'primary', icon: 'image' }),
          button('Take photo', { act: 'pick', data: { kind: 'camera' }, icon: 'camera' }))));
      kids.push(section('Or try it first', [
        h('div', { class: 'btn-col' },
          button('Use sample house (traced)', { act: 'load-sample', data: { traced: '1' }, icon: 'house' }),
          button('Practice on a blank sample', { act: 'load-sample', data: { traced: '0' }, icon: 'pencil' })),
        h('p', { class: 'hint' }, 'The traced sample is a finished plan you can explore. The blank one is the same house with nothing measured, so you can practice.'),
      ], { key: 'samples' }));
      if (image) {
        const ex = image.exif;
        const cam = ex ? [ex.make, ex.model].filter(Boolean).join(' ') : '';
        const exText = ex && (cam || ex.focal35)
          ? (cam || 'Camera') + (ex.focal35 ? ', ' + Math.round(ex.focal35) + ' mm equivalent' : '') + (ex.focalMm ? ' (' + trimNum(ex.focalMm, 2) + ' mm lens)' : '')
          : 'No camera data in this photo';
        kids.push(section('This photo', [dl([
          ['Name', image.name || 'Untitled photo'],
          ['Size', fmtNum(image.width, 0) + ' × ' + fmtNum(image.height, 0) + ' px', 'num'],
          ['Source', SOURCE_KIND[image.source && image.source.kind] || 'Photo'],
          isSample ? null : ['Camera', exText],
        ])], { key: 'photo' }));
        kids.push(lensSection(ctx));
      }
      kids.push(disclosure('Photo tips', h('ul', { class: 'tips' }, PHOTO_TIPS.map((t) => h('li', null, t))), { open: !image || isSample, key: 'tips' }));
      if (image && plan) kids.push(nextButton(1));
      return kids;
    }

    function lensSection(ctx) {
      const { image, plan } = ctx;
      const cam = image.camera || {};
      const K = plan.measured.cameras[image.id] || null;
      const value = cam.mode === 'preset' ? 'preset:' + cam.presetId : cam.mode || 'auto';
      const hasExif = !!(image.exif && image.exif.focal35);
      const options = [
        ['auto', 'Automatic (recommended)'],
        ['exif', hasExif ? 'From the photo data' : 'From the photo data (none in this photo)', !hasExif && value !== 'exif'],
      ].concat(camera.CAMERA_PRESETS.map((p) => ['preset:' + p.id, p.label]))
        .concat([['manual', 'Enter the focal length in pixels']]);
      const kids = [
        field('Lens', selectInput({ act: 'lens-mode', value, options, data: { id: image.id } })),
      ];
      if (cam.mode === 'manual') {
        kids.push(field('Focal length (pixels)', numInput({ act: 'lens-focal', value: cam.focalPx, min: 50, step: 1, decimals: 0, data: { id: image.id }, placeholder: K && K.f ? Math.round(K.f) : '' }),
          'The focal length in pixels of the stored photo (' + fmtNum(image.width, 0) + ' px wide).'));
      }
      if (K && K.ok !== false) {
        kids.push(h('div', { class: 'lens-status' },
          h('span', { class: 'badge ' + (K.source === 'default' ? 'warn' : 'ok') }, FOCAL_SOURCE[K.source] || 'Lens'),
          h('span', null, K.label + (isNum(K.f) ? ' · ' : ''), isNum(K.f) ? h('span', { class: 'num' }, fmtNum(K.f, 0) + ' px') : null)));
      }
      kids.push(h('p', { class: 'hint' }, 'Automatic uses the lens data in the photo, then measures it from a perspective rectangle, and otherwise assumes a phone main camera. For a Street View screenshot, pick that preset.'));
      return section('Lens', kids, { key: 'lens' });
    }

    // ================================================================ step 2: Calibrate
    function stepCalibrate(ctx) {
      const { image, planes, sols, plan } = ctx;
      const kids = [head(2), h('p', { class: 'lead' }, CALIBRATE_SENTENCE)];
      if (!image) {
        kids.push(callout('info', 'Add a photo first.', { after: button('Go to Upload', { act: 'go-step', data: { step: 1 }, cls: 'small' }) }));
        return kids;
      }
      // Surfaces
      const rows = planes.map((pl) => {
        const sol = sols[pl.id];
        const conf = planeConfidence(ctx, sol);
        const active = ctx.activePlane && ctx.activePlane.id === pl.id;
        return h('button', {
          type: 'button', class: 'plane-row' + (active ? ' active' : ''), 'aria-pressed': String(active), 'data-key': pl.id,
          data: { act: 'select-plane', id: pl.id },
        }, swatch(pl.color || '#4f9dff', 'dot'),
        h('span', { class: 'plane-name' }, pl.name || PLANE_KIND[pl.kind]),
        h('span', { class: 'plane-kind' }, PLANE_KIND[pl.kind] || 'Surface'),
        conf ? pill(conf.level) : h('span', { class: 'pill none' }, 'Needs a scale'));
      });
      kids.push(section('Surfaces', [
        h('div', { class: 'plane-list' }, rows.length ? rows : h('p', { class: 'hint' }, 'No surfaces yet.')),
        h('div', { class: 'btn-row wrap' },
          button('Wall', { act: 'add-plane', data: { kind: 'wall' }, icon: 'plus', cls: 'small' }),
          button('Roof slope', { act: 'add-plane', data: { kind: 'roof' }, icon: 'plus', cls: 'small' }),
          button('Ground', { act: 'add-plane', data: { kind: 'ground' }, icon: 'plus', cls: 'small' })),
        h('p', { class: 'hint' }, 'Measure each wall on its own surface. A roof slope starts from its eave on a wall; the ground starts from the bottom of a wall.'),
      ], { key: 'surfaces' }));

      const pl = ctx.activePlane;
      if (pl) kids.push(planeEditor(ctx, pl, sols[pl.id]));
      kids.push(pitchSection(ctx));
      kids.push(nextButton(2));
      return kids;
    }

    function planeEditor(ctx, pl, sol) {
      const { fmt, config, plan } = ctx;
      const conf = planeConfidence(ctx, sol);
      const K = ctx.image ? plan.measured.cameras[ctx.image.id] : null;
      const parent = pl.derived ? byId(ctx.project.planes, pl.derived.parentPlaneId) : null;
      const kids = [];
      kids.push(h('div', { class: 'row-2' },
        field('Name', textInput({ act: 'plane-name', value: pl.name, data: { id: pl.id }, maxlength: 60 })),
        h('div', { class: 'field end' }, button('Delete', { act: 'delete-plane', data: { id: pl.id }, icon: 'trash', cls: 'danger ghost small' }))));

      // Status in plain words
      const statusRows = [];
      if (sol && sol.ok) {
        let modeText = MODE_TEXT[sol.mode] || 'Measured.';
        if (parent && (sol.mode === 'roof-3d' || sol.mode === 'ground-3d' || sol.mode === 'roof-ortho')) modeText = modeText.replace('the wall', "'" + parent.name + "'");
        statusRows.push(['How', modeText]);
        if (isNum(sol.viewAngleDeg)) statusRows.push(['View angle', 'About ' + Math.round(sol.viewAngleDeg) + '° off straight-on' + (sol.viewAngleDeg > 35 ? ' (steep: expect less accuracy)' : '')]);
      } else {
        statusRows.push(['How', 'Not measured yet. ' + ((sol && sol.reason) || (pl.kind === 'wall' ? 'Mark a rectangle or add a reference length below.' : ''))]);
      }
      if (K && K.ok !== false) statusRows.push(['Lens', K.label + (isNum(K.f) ? ' (' + fmtNum(K.f, 0) + ' px)' : '')]);
      if (pl.kind === 'roof' && sol && sol.pitch) statusRows.push(['Pitch', sol.pitch.rise + '/' + sol.pitch.run + (sol.pitch.source === 'estimated' ? ' (estimated)' : sol.pitch.source === 'default' ? ' (assumed)' : '')]);
      kids.push(h('div', { class: 'status-card' }, dl(statusRows), conf ? confidenceBlock(conf, 'plane-conf-' + pl.id) : null));

      if (pl.kind === 'wall') {
        kids.push(rectEditor(ctx, pl));
        kids.push(refEditor(ctx, pl, sol));
      } else {
        const what = pl.kind === 'roof' ? 'eave line' : 'wall base line';
        if (pl.kind === 'roof') {
          const pp = pl.derived && pl.derived.pitch;
          const housePitch = plan.measured.pitch;
          const houseText = 'Same as the house (' + housePitch.rise + '/' + housePitch.run + (housePitch.source === 'estimated' ? ', estimated' : housePitch.source === 'default' ? ', assumed' : '') + ')';
          const opts = [['', houseText]].concat(pitchOptions());
          const val = pp ? pitchValue(pp) : '';
          if (pp && !opts.some((o) => o[0] === val)) opts.push([val, pp.rise + '/' + pp.run]);
          kids.push(field('Pitch of this slope', selectInput({ act: 'plane-pitch', value: val, options: opts, data: { id: pl.id } })));
        }
        kids.push(h('div', { class: 'btn-row' }, button('Redraw ' + what, { act: 'redraw-line', data: { id: pl.id }, icon: 'ruler', cls: 'small' })));
        if (parent) kids.push(h('p', { class: 'hint' }, 'Built from \'' + parent.name + '\'. Its accuracy depends on that wall\'s rectangle.'));
      }
      const issues = sol ? arr(sol.warnings).filter((w) => !/disagree/i.test(w)) : [];
      for (const w of issues) kids.push(callout('warn', w, { key: 'pw-' + hashKey(w) }));
      return section(pl.name || 'Surface', kids, { key: 'plane-' + pl.id, cls: 'plane-editor' });
    }

    function rectEditor(ctx, pl) {
      const c = ctx.ui.calib;
      const rect = pl.rect;
      const presetId = rect ? rect.presetId || (rect.widthFt ? 'custom-rect' : 'unknown') : c.rectPresetId;
      const presets = measure.WALL_RECT_PRESETS;
      const options = presets.map((p) => [p.id, p.label]);
      const kids = [field('What is it?', selectInput({ act: 'rect-preset', value: presetId, options, data: { id: pl.id } }))];
      if (presetId === 'custom-rect') {
        const w = rect ? rect.widthFt : c.rectWidthFt;
        const hgt = rect ? rect.heightFt : c.rectHeightFt;
        kids.push(h('div', { class: 'row-2' },
          field('Width', textInput({ act: 'rect-size', value: w ? ctx.fmt(w) : '', placeholder: '16\' 0"', data: { id: pl.id, field: 'width' }, inputmode: 'text' })),
          field('Height', textInput({ act: 'rect-size', value: hgt ? ctx.fmt(hgt) : '', placeholder: '7\' 0"', data: { id: pl.id, field: 'height' }, inputmode: 'text' }))));
      }
      if (rect) {
        const p = presets.find((x) => x.id === rect.presetId);
        let text;
        if (rect.widthFt && rect.heightFt) {
          text = 'Corners marked: ' + (p && p.id !== 'custom-rect' && p.id !== 'unknown' ? p.label : ctx.fmt(rect.widthFt) + ' × ' + ctx.fmt(rect.heightFt) + ' rectangle') + '.';
        } else {
          text = 'Corners marked. The size is unknown, so the scale comes from the reference lengths.';
        }
        kids.push(h('p', { class: 'ok-line' }, icon('check'), h('span', null, text)));
        if (!rect.widthFt && !pl.refs.length) kids.push(callout('info', 'The size is unknown, so add at least one reference length below to set the scale.'));
      }
      kids.push(h('div', { class: 'btn-row' },
        button(rect ? 'Mark corners again' : 'Mark 4 corners', { act: 'mark-rect', data: { id: pl.id }, icon: 'corners', cls: rect ? '' : 'primary' }),
        rect ? button('Remove', { act: 'remove-rect', data: { id: pl.id }, cls: 'ghost' }) : null));
      return h('div', { class: 'sub', 'data-key': 'rect' }, h('h4', null, 'Perspective rectangle'), kids);
    }

    function refEditor(ctx, pl, sol) {
      const c = ctx.ui.calib;
      const preset = measure.getRefPreset(c.refPresetId) || measure.getRefPreset('door-height');
      const kids = [field('Reference', selectInput({ act: 'ref-preset', value: preset.id, options: measure.REF_PRESETS.map((p) => [p.id, p.label]) }))];
      if (preset.kind === 'courses') {
        kids.push(field('Courses spanned', numInput({ act: 'ref-courses', value: c.refCourses, min: 1, step: 1, decimals: 0 }),
          'Tap the bottom edge of one course and the bottom edge of the course this many courses up. Span 8 or more.'));
      } else if (preset.id === 'custom-line') {
        kids.push(field('Length', textInput({ act: 'ref-length', value: c.refLengthFt ? ctx.fmt(c.refLengthFt) : '', placeholder: '6\' 8", 6.67 or 80in' }),
          c.refLengthFt ? 'Reads as ' + ctx.fmt(c.refLengthFt) + '.' : 'Feet and inches, decimal feet or inches.'));
      } else if (preset.id === 'custom-rect') {
        kids.push(h('div', { class: 'row-2' },
          field('Width', textInput({ act: 'ref-rect-size', value: c.refWidthFt ? ctx.fmt(c.refWidthFt) : '', placeholder: '3\' 0"', data: { field: 'width' } })),
          field('Height', textInput({ act: 'ref-rect-size', value: c.refHeightFt ? ctx.fmt(c.refHeightFt) : '', placeholder: '6\' 8"', data: { field: 'height' } }))));
      }
      const needsValue = (preset.id === 'custom-line' && !c.refLengthFt) || (preset.id === 'custom-rect' && !(c.refWidthFt && c.refHeightFt));
      kids.push(h('div', { class: 'btn-row' }, button(preset.kind === 'rect' ? 'Draw (4 corners)' : 'Draw (2 ends)', { act: 'draw-ref', data: { id: pl.id }, icon: preset.kind === 'rect' ? 'corners' : 'ruler', disabled: needsValue })));

      // Existing references with expected vs measured
      const results = {};
      for (const r of arr(sol && sol.refResults)) results[r.refId] = r;
      const warnPct = isNum(ctx.config.refDisagreementWarnPct) ? ctx.config.refDisagreementWarnPct : 5;
      const sel = ctx.ui.selection;
      const items = pl.refs.map((ref) => {
        const r = results[ref.id];
        const expected = r ? r.expectedFt : ref.kind === 'rect' ? null : ref.lengthFt;
        const err = r && isNum(r.errorPct) ? r.errorPct : null;
        const cls = err == null ? '' : Math.abs(err) < 2 ? 'ok' : Math.abs(err) <= warnPct ? 'warn' : 'danger';
        const label = ref.label || measure.refLabel(ref);
        const selected = sel && sel.kind === 'ref' && sel.id === ref.id;
        return h('li', { class: 'ref-item' + (selected ? ' selected' : ''), 'data-key': ref.id },
          h('button', { type: 'button', class: 'ref-main', data: { act: 'select-ref', id: ref.id, plane: pl.id } },
            h('span', { class: 'ref-label' }, label),
            h('span', { class: 'ref-nums num' },
              ref.kind === 'rect' && !r ? 'Rectangle ' + ctx.fmt(ref.widthFt) + ' × ' + ctx.fmt(ref.heightFt)
                : 'Expected ' + ctx.fmt(expected) + ' · measured ' + (r ? ctx.fmt(r.measuredFt) : '—'))),
          err == null ? h('span', { class: 'err-badge none' }, r ? 'sets scale' : '—')
            : h('span', { class: 'err-badge ' + cls, title: 'Measured minus expected' }, signedPct(err)),
          iconButton('trash', 'Delete reference ' + label, { act: 'delete-ref', data: { id: ref.id, plane: pl.id }, cls: 'small' }));
      });
      const listKids = items.length ? h('ul', { class: 'ref-list' }, items) : h('p', { class: 'hint' }, 'No references on this wall yet. A door height or a garage door width works well.');
      const out = [h('h4', null, 'Reference lengths'), kids, listKids];
      if (sol && isNum(sol.disagreementPct) && sol.disagreementPct > warnPct) {
        out.push(callout('warn', 'References on \'' + pl.name + '\' disagree by ' + sol.disagreementPct.toFixed(1) +
          '%. Check that each one sits on this wall and that its size is right.', { key: 'disagree' }));
      } else if (sol && sol.checks >= 1 && isNum(sol.disagreementPct)) {
        out.push(h('p', { class: 'ok-line' }, icon('check'), h('span', null, 'References agree within ' + sol.disagreementPct.toFixed(1) + '%.')));
      }
      return h('div', { class: 'sub', 'data-key': 'refs' }, out);
    }

    const PITCH_RISES = [4, 5, 6, 7, 8, 9, 10, 11, 12];
    const pitchOptions = () => PITCH_RISES.map((r) => [String(r) + '/12', r + '/12']);
    const pitchValue = (p) => p.rise + '/' + p.run;
    function pitchSection(ctx) {
      const s = ctx.project.settings.roofPitch;
      const val = s ? pitchValue(s) : 'est';
      const opts = [['est', 'Unknown (estimate it)']].concat(pitchOptions());
      if (s && !opts.some((o) => o[0] === val)) opts.push([val, s.rise + '/' + s.run]);
      const p = ctx.plan.measured.pitch;
      let info;
      if (!s && p.source === 'estimated') {
        info = h('p', { class: 'pitch-est' }, h('span', { class: 'num big' }, p.rise + '/12'), h('span', { class: 'badge warn' }, 'estimated'),
          h('span', { class: 'hint' }, ' from ' + plural(arr(p.samples).length, 'gable rake', 'gable rakes') + (isNum(p.angleDeg) ? ' (' + p.angleDeg.toFixed(1) + '°)' : '') + '.'));
      } else if (!s) {
        info = h('p', { class: 'hint' }, 'No gable rake is traced on a wall yet, so 6/12 is assumed. Trace a gable rake on a wall to estimate it, or pick the pitch if you know it.');
      } else {
        info = h('p', { class: 'hint' }, 'Using ' + s.rise + '/' + s.run + ' for every roof slope that does not set its own.');
      }
      return section('Roof pitch', [field('Pitch (rise per 12 in of run)', selectInput({ act: 'roof-pitch', value: val, options: opts })), info], { key: 'pitch' });
    }

    // ================================================================ step 3: Trace
    /** Short text for a feature row: the number the plan uses (length, wrap length or light count). */
    function featureLengthText(ctx, f, m) {
      if (!m || !m.ok) return '';
      if (f.type === 'bush' || (f.type === 'tree' && isNum(m.lights))) return plural(m.lights, 'light', 'lights');
      if (f.type === 'tree' || f.type === 'column') return ctx.fmt(m.lengthFt) + ' wrap';
      return ctx.fmt(m.lengthFt);
    }

    /** "Front yard · ground", but just "Front wall" when the name already says what it is. */
    function planeOptionLabel(p) {
      const kind = p.kind === 'roof' ? 'roof' : p.kind === 'ground' ? 'ground' : 'wall';
      const name = p.name || PLANE_KIND[p.kind] || 'Surface';
      return name.toLowerCase().indexOf(kind) >= 0 ? name : name + ' · ' + kind;
    }

    function stepTrace(ctx) {
      const { ui, planes, features, plan, image } = ctx;
      const kids = [head(3, 'Pick what to light, then tap along it on the photo.')];
      if (!image) {
        kids.push(callout('info', 'Add a photo first.', { after: button('Go to Upload', { act: 'go-step', data: { step: 1 }, cls: 'small' }) }));
        return kids;
      }
      const tracing = ui.mode.name === 'trace';
      if (tracing) {
        const ft = FEATURE_TYPES[ui.mode.opts.type];
        const pts = arr(ui.draft.points).length;
        const plane = byId(planes, ui.mode.opts.planeId);
        const canFinish = ft && ft.geometry !== 'vertical' && pts >= (ft.geometry === 'polyline' ? 2 : 3);
        kids.push(h('div', { class: 'trace-bar', 'data-key': 'trace-bar' },
          h('p', null, swatch(ft ? ft.color : '#999', 'dot'), h('span', null, 'Tracing ' + (ft ? ft.label.toLowerCase() : '') + (plane ? ' on \'' + plane.name + '\'' : '') + ' · ', h('span', { class: 'num' }, plural(pts, 'point', 'points')))),
          h('div', { class: 'btn-row' },
            button('Undo point', { act: 'draft-undo', disabled: !pts, cls: 'small' }),
            button('Cancel', { act: 'draft-cancel', cls: 'small' }),
            button('Finish', { act: 'draft-finish', disabled: !canFinish, cls: 'small primary' }))));
      }
      kids.push(section('What to light', [
        h('div', { class: 'chip-grid' }, TYPE_ORDER.map((t) => {
          const ft = FEATURE_TYPES[t];
          const on = tracing && ui.mode.opts.type === t;
          return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), data: { act: 'trace-type', type: t }, title: ft.label },
            swatch(ft.color), h('span', null, ft.short));
        })),
        h('div', { class: 'row-auto' },
          field('Surface to trace on', selectInput({ act: 'active-plane', value: ctx.activePlane ? ctx.activePlane.id : '', options: planes.map((p) => [p.id, planeOptionLabel(p)]) })),
          toggle('Snap', { act: 'view-toggle', data: { key: 'snap' }, checked: ui.view.snap })),
        h('p', { class: 'hint' }, 'Lines: tap each corner, then Finish or double-tap. Windows and bushes: tap around and tap the first point to close. Trees and columns: tap the base, then the top.'),
      ], { key: 'types' }));

      // Feature list
      const measured = plan.measured.features;
      const sel = ui.selection;
      const items = features.map((f) => {
        const ft = FEATURE_TYPES[f.type] || { label: f.type, short: f.type, color: '#999' };
        const m = measured[f.id];
        const selected = !!(sel && sel.kind === 'feature' && sel.id === f.id);
        const rowKids = [h('button', { type: 'button', class: 'feat-row', 'aria-expanded': String(selected), data: { act: 'select-feature', id: f.id } },
          swatch(ft.color, 'dot'),
          h('span', { class: 'feat-label' }, f.label || ft.label),
          h('span', { class: 'feat-len num' }, featureLengthText(ctx, f, m)),
          m && m.ok ? pill(m.confidence.level, m.overridden ? '· tape' : null) : h('span', { class: 'pill none' }, 'Not measured'))];
        if (selected) rowKids.push(featureEditor(ctx, f, m));
        return h('li', { class: 'feat-item' + (selected ? ' selected' : ''), 'data-key': f.id }, rowKids);
      });
      kids.push(section('Traced (' + features.length + ')', items.length ? h('ul', { class: 'feat-list' }, items)
        : h('p', { class: 'hint' }, 'Nothing traced yet. Pick a type above, then tap along it on the photo.'), { key: 'features' }));

      kids.push(totalsSection(ctx));
      kids.push(nextButton(3));
      return kids;
    }

    function featureEditor(ctx, f, m) {
      const ft = FEATURE_TYPES[f.type] || {};
      const cfg = ctx.config;
      const kids = [];
      kids.push(h('div', { class: 'row-2' },
        field('Label', textInput({ act: 'feature-field', value: f.label, data: { id: f.id, field: 'label' }, maxlength: 80 })),
        field('Type', selectInput({ act: 'feature-type', value: f.type, options: TYPE_ORDER.map((t) => [t, FEATURE_TYPES[t].label]), data: { id: f.id } }))));
      kids.push(field('Surface', selectInput({ act: 'feature-plane', value: f.planeId || '', options: [['', 'None']].concat(ctx.planes.map((p) => [p.id, p.name])), data: { id: f.id } })));

      if (m && m.ok) {
        const rows = [];
        if (f.type === 'bush') {
          rows.push(['Size', ctx.fmt(m.widthFt) + ' wide × ' + ctx.fmt(m.heightFt) + ' tall', 'num']);
          rows.push(['Lights', plural(m.lights, 'light', 'lights') + ' by the rule of thumb', 'num']);
        } else if (ft.geometry === 'vertical') {
          rows.push(['Height', ctx.fmt(m.heightFt != null ? m.heightFt : m.measuredFt), 'num']);
          if (isNum(m.wrapFt)) rows.push(['Wrap length', ctx.fmt(m.wrapFt), 'num']);
          if (isNum(m.lights)) rows.push(['Lights', plural(m.lights, 'light', 'lights'), 'num']);
        } else {
          rows.push(['Measured', ctx.fmt(m.measuredFt), 'num']);
          if (m.overridden) rows.push(['Using', ctx.fmt(m.lengthFt) + ' (tape-measured)', 'num']);
          rows.push(['With waste', ctx.fmt(m.withWasteFt), 'num']);
        }
        kids.push(dl(rows));
        kids.push(confidenceBlock(m.confidence, 'conf-' + f.id));
      } else {
        kids.push(callout('warn', 'Not measured yet: ' + ((m && m.reason) || 'calibrate its surface in step 2.')));
      }

      if (f.type === 'bush') {
        kids.push(h('div', { class: 'row-2' },
          field('Tape width', textInput({ act: 'feature-len', value: f.params.overrideWidthFt ? ctx.fmt(f.params.overrideWidthFt) : '', placeholder: 'e.g. 4\'', data: { id: f.id, field: 'overrideWidthFt' } })),
          field('Tape height', textInput({ act: 'feature-len', value: f.params.overrideHeightFt ? ctx.fmt(f.params.overrideHeightFt) : '', placeholder: 'e.g. 3\'', data: { id: f.id, field: 'overrideHeightFt' } }))));
      } else {
        const vertical = ft.geometry === 'vertical';
        kids.push(field(vertical ? 'Tape-measured height' : 'Tape-measured length',
          textInput({ act: 'feature-len', value: f.overrideFt ? ctx.fmt(f.overrideFt) : '', placeholder: m && m.ok ? 'e.g. ' + ctx.fmt(vertical ? m.heightFt : m.measuredFt) : 'e.g. 32\' 4"', data: { id: f.id, field: 'overrideFt' } }),
          f.overrideFt ? 'Replaces the measured ' + (vertical ? 'height' : 'length') + '. Clear it to go back.' : 'Optional. Replaces the measured ' + (vertical ? 'height' : 'length') + ' in the plan.'));
      }
      if (f.type === 'tree' || f.type === 'column') {
        const d = f.type === 'tree' ? cfg.tree : cfg.column;
        kids.push(h('div', { class: 'row-2' },
          field('Diameter (in)', numInput({ act: 'feature-param', value: f.params.diameterIn, min: 1, step: 1, placeholder: d.defaultDiameterIn, data: { id: f.id, field: 'diameterIn' } })),
          field('Wrap spacing (in)', numInput({ act: 'feature-param', value: f.params.spiralSpacingIn, min: 1, step: 1, placeholder: d.spiralSpacingIn, data: { id: f.id, field: 'spiralSpacingIn' } }))));
        if (f.type === 'tree') {
          kids.push(field('How to light it', selectInput({ act: 'feature-wrap', value: f.params.wrapMode || 'trunk', options: [['trunk', 'Wrap the trunk (spiral)'], ['canopy', 'Light the canopy (by height)']], data: { id: f.id } })));
        }
      }
      kids.push(h('div', { class: 'btn-row end' }, button('Delete', { act: 'delete-feature', data: { id: f.id }, icon: 'trash', cls: 'danger ghost small' })));
      return h('div', { class: 'feat-editor' }, kids);
    }

    function totalsSection(ctx) {
      const t = ctx.plan.measured.totals;
      const rows = TYPE_ORDER.filter((k) => t.byType[k] && t.byType[k].count > 0).map((k) => {
        const b = t.byType[k];
        const ft = FEATURE_TYPES[k];
        const val = k === 'bush' ? plural(b.lights, 'light', 'lights') : ctx.fmt(b.lengthFt);
        const waste = k === 'bush' ? '' : catalog.LINEAR_TYPES.includes(k) ? ctx.fmt(b.withWasteFt) : '';
        return h('tr', { 'data-key': k }, h('th', { scope: 'row' }, swatch(ft.color, 'dot'), ft.short), h('td', { class: 'num' }, String(b.count)), h('td', { class: 'num' }, val), h('td', { class: 'num' }, waste));
      });
      const table = rows.length ? h('table', { class: 'totals' },
        h('thead', null, h('tr', null, h('th', null, 'Type'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Length'), h('th', { class: 'num' }, 'With waste'))),
        h('tbody', null, rows),
        h('tfoot', null, h('tr', null, h('th', { scope: 'row' }, 'Total'), h('td'), h('td', { class: 'num' }, ctx.fmt(t.totalFt)), h('td', { class: 'num' }, ctx.fmt(t.totalWithWasteFt))))) : null;
      return section('Running totals', [
        table || h('p', { class: 'hint' }, 'Totals appear here as you trace.'),
        h('div', { class: 'waste-row' },
          field('Waste (%)', numInput({ act: 'waste', value: ctx.project.settings.wastePct, min: 0, max: 100, step: 1, decimals: 1 }), WASTE_NOTE)),
      ], { key: 'totals' });
    }

    // ================================================================ step 4: Design
    function stepDesign(ctx) {
      const { ui, project, plan, image } = ctx;
      const kids = [head(4, 'LightPlan picks a product for each run. Change any of them here.')];
      if (!image) {
        kids.push(callout('info', 'Add a photo first.', { after: button('Go to Upload', { act: 'go-step', data: { step: 1 }, cls: 'small' }) }));
        return kids;
      }
      kids.push(section('Preview', [h('div', { class: 'btn-row wrap' },
        button(ui.view.preview ? 'Lights on' : 'Lights off', { act: 'view-flip', data: { key: 'preview' }, pressed: ui.view.preview, icon: 'bulb', cls: 'small' }),
        button(ui.view.night ? 'Night' : 'Day', { act: 'view-flip', data: { key: 'night' }, pressed: ui.view.night, icon: ui.view.night ? 'moon' : 'sun', cls: 'small' }),
        button('Twinkle', { act: 'view-flip', data: { key: 'twinkle' }, pressed: ui.view.twinkle, icon: 'sparkle', cls: 'small' }))], { key: 'preview' }));

      // Colors
      const s = project.settings;
      const chips = ['warmWhite', 'coolWhite', 'multicolor', 'custom'].map((mode) => {
        const cm = COLOR_MODES[mode];
        const colors = mode === 'custom' ? s.customColors : cm.colors;
        const on = s.colorMode === mode;
        return h('button', { type: 'button', class: 'chip color-chip' + (on ? ' on' : ''), 'aria-pressed': String(on), data: { act: 'color-mode', mode } },
          h('span', { class: 'swatches' }, arr(colors).slice(0, 5).map((c) => swatch(c))), h('span', null, cm.label));
      });
      const colorKids = [h('div', { class: 'chip-row' }, chips)];
      if (s.colorMode === 'custom') {
        colorKids.push(h('div', { class: 'custom-colors' },
          s.customColors.map((c, i) => h('div', { class: 'color-item', 'data-key': 'cc' + i },
            h('input', { type: 'color', class: 'color-input', value: c, 'aria-label': 'Custom color ' + (i + 1), data: { act: 'custom-color', index: i } }),
            iconButton('close', 'Remove color ' + (i + 1), { act: 'custom-color-remove', data: { index: i }, disabled: s.customColors.length <= 1, cls: 'small' }))),
          s.customColors.length < 8 ? button('Add color', { act: 'custom-color-add', icon: 'plus', cls: 'small' }) : null));
      }
      kids.push(section('Light color', colorKids, { key: 'colors' }));

      // Runs
      const lib = plan.library;
      const runs = plan.runs;
      const featureById = (id) => byId(project.features, id);
      const runCards = runs.map((run) => {
        const f = featureById(run.featureId);
        if (!f) return null;
        const ft = FEATURE_TYPES[run.featureType] || { color: '#999', short: '' };
        const suitable = design.suitableProducts(run.featureType, lib);
        const auto = design.resolveProduct(Object.assign({}, f, { productId: null }), lib).product;
        const options = [['', 'Auto: ' + (auto ? auto.name : 'none available')]].concat(suitable.map((p) => [p.id, p.name]));
        if (f.productId && !options.some((o) => o[0] === f.productId)) {
          const cur = catalog.getProduct(lib.products, f.productId);
          options.push([f.productId, (cur ? cur.name : f.productId) + (cur && cur.enabled === false ? ' (turned off)' : '')]);
        }
        const houseColor = COLOR_MODES[s.colorMode] ? COLOR_MODES[s.colorMode].label : 'Warm white';
        const colorOptions = [['', 'House color (' + houseColor + ')']].concat(['warmWhite', 'coolWhite', 'multicolor', 'custom'].map((k) => [k, COLOR_MODES[k].label]));
        const qty = run.quantity;
        return h('li', { class: 'run-card', 'data-key': run.id },
          h('div', { class: 'run-head' }, swatch(ft.color, 'dot'), h('span', { class: 'run-label' }, run.label),
            h('span', { class: 'swatches' }, arr(run.colors).slice(0, 5).map((c) => swatch(c)))),
          field('Product', selectInput({ act: 'run-product', value: f.productId || '', options, data: { id: f.id } })),
          field('Color', selectInput({ act: 'run-color', value: f.color ? f.color.mode : '', options: colorOptions, data: { id: f.id } })),
          h('p', { class: 'run-qty' },
            h('strong', { class: 'num' }, fmtNum(qty, run.unit === 'foot' ? 1 : 0) + ' ' + unitWord(run.unit, qty)),
            h('span', { class: 'num' }, ' · ' + watts(run.watts)),
            run.clips && run.clips.count ? h('span', { class: 'num' }, ' · ' + plural(run.clips.count, 'clip', 'clips')) : null,
            run.lightStakes ? h('span', { class: 'num' }, ' · ' + plural(run.lightStakes, 'stake', 'stakes')) : null),
          run.detail ? h('p', { class: 'run-detail' }, run.detail) : null,
          arr(run.warnings).length ? h('ul', { class: 'warn-list compact' }, run.warnings.map((w, i) => h('li', { class: 'warn-item warn', 'data-key': 'rw' + i }, icon('warning'), h('span', null, w)))) : null);
      });
      kids.push(section('Light runs (' + runs.length + ')', [
        runs.length ? h('ul', { class: 'run-list' }, runCards) : h('p', { class: 'hint' }, 'Trace something in step 3 to plan its lights.'),
        runs.length ? h('div', { class: 'btn-row' }, button('Reset to auto-plan', { act: 'reset-auto', icon: 'reset', cls: 'small' })) : null,
      ], { key: 'runs' }));

      kids.push(productEditor(ctx));
      kids.push(configEditor(ctx));
      kids.push(nextButton(4));
      return kids;
    }

    function productEditor(ctx) {
      const local = ctx.local;
      const products = ctx.plan.library.products;
      const custom = !!(ctx.project.library && ctx.project.library.products);
      const rows = products.map((p) => h('li', { class: 'prod-card' + (p.enabled === false ? ' off' : ''), 'data-key': 'p-' + p.id },
        h('div', { class: 'prod-head' },
          toggle('', { act: 'product-enabled', data: { id: p.id }, checked: p.enabled !== false, cls: 'compact' }),
          textInput({ act: 'product-field', value: p.name, data: { id: p.id, field: 'name' }, aria: 'Name of ' + p.id, cls: 'grow' })),
        h('div', { class: 'prod-grid' },
          field('Price ($)', numInput({ act: 'product-field', value: p.price, min: 0, step: 0.01, data: { id: p.id, field: 'price' } })),
          field('Watts per ' + (p.unit === 'foot' ? 'ft' : p.unit), numInput({ act: 'product-field', value: p.wattsPerUnit, min: 0, step: 0.1, data: { id: p.id, field: 'wattsPerUnit' } })),
          field('Lit length (ft)', numInput({ act: 'product-field', value: p.stringLengthFt, min: 0.1, step: 0.5, data: { id: p.id, field: 'stringLengthFt' } })),
          field('Max end to end', numInput({ act: 'product-field', value: p.maxEndToEnd, min: 1, step: 1, decimals: 0, data: { id: p.id, field: 'maxEndToEnd' } })),
          field('Bulb spacing (in)', numInput({ act: 'product-field', value: p.bulbSpacingIn, min: 0.5, step: 0.5, data: { id: p.id, field: 'bulbSpacingIn' } })),
          field('Bulbs per ' + (p.unit === 'foot' ? 'ft' : p.unit), numInput({ act: 'product-field', value: p.bulbsPerUnit, min: 0, step: 1, decimals: 0, data: { id: p.id, field: 'bulbsPerUnit' } })))));
      const json = local.productDraft != null ? local.productDraft : JSON.stringify(products, null, 2);
      const msg = local.productMsg;
      return disclosure('Product library' + (custom ? ' (edited)' : ''), [
        h('p', { class: 'hint' }, 'Typical retail values, not one brand. Check the box label and change anything that differs. Turned-off products are not used by the auto-plan.'),
        h('ul', { class: 'prod-list' }, rows),
        h('h4', null, 'Edit as JSON'),
        h('textarea', { class: 'input code', rows: 10, spellcheck: 'false', 'aria-label': 'Product library as JSON', value: json, data: { act: 'product-json', fk: 'product-json' } }),
        msg ? h('div', { class: 'json-msg ' + msg.kind, role: 'status' }, msg.lines.map((l) => h('p', null, l))) : null,
        h('div', { class: 'btn-row wrap' },
          button('Check', { act: 'product-json-check', cls: 'small' }),
          button('Apply', { act: 'product-json-apply', cls: 'small primary' }),
          local.productDraft != null ? button('Discard edits', { act: 'product-json-discard', cls: 'small ghost' }) : null,
          button('Reset to defaults', { act: 'product-reset', icon: 'reset', cls: 'small ghost', disabled: !custom })),
      ], { key: 'products', cls: 'editor' });
    }

    function configEditor(ctx) {
      const local = ctx.local;
      const cfg = ctx.plan.library.config;
      const overrides = (ctx.project.library && ctx.project.library.config) || null;
      const fields = CONFIG_FIELDS.map(([path, label, unit]) => {
        const v = getPath(cfg, path);
        const changed = overrides && getPath(overrides, path) !== undefined;
        return field(label + (unit ? ' (' + unit + ')' : ''), numInput({ act: 'config-field', value: v, min: 0, step: 'any', data: { path }, cls: changed ? 'changed' : '' }), null, 'cfg-field');
      });
      const json = local.configDraft != null ? local.configDraft : JSON.stringify(cfg, null, 2);
      const msg = local.configMsg;
      return disclosure('Rules of thumb' + (overrides ? ' (edited)' : ''), [
        h('p', { class: 'hint' }, 'The numbers behind clips, bushes, trees, cords and labor. Changed values are highlighted.'),
        h('div', { class: 'cfg-grid' }, fields),
        h('h4', null, 'Edit as JSON'),
        h('textarea', { class: 'input code', rows: 10, spellcheck: 'false', 'aria-label': 'Rules of thumb as JSON', value: json, data: { act: 'config-json', fk: 'config-json' } }),
        msg ? h('div', { class: 'json-msg ' + msg.kind, role: 'status' }, msg.lines.map((l) => h('p', null, l))) : null,
        h('div', { class: 'btn-row wrap' },
          button('Check', { act: 'config-json-check', cls: 'small' }),
          button('Apply', { act: 'config-json-apply', cls: 'small primary' }),
          local.configDraft != null ? button('Discard edits', { act: 'config-json-discard', cls: 'small ghost' }) : null,
          button('Reset to defaults', { act: 'config-reset', icon: 'reset', cls: 'small ghost', disabled: !overrides })),
      ], { key: 'config', cls: 'editor' });
    }

    // ================================================================ step 5: Power
    function stepPower(ctx) {
      const { ui, project, plan, image } = ctx;
      const pw = plan.power;
      const kids = [head(5, 'Mark the outdoor outlets. LightPlan chains the runs, sizes the cords and checks each circuit.')];
      kids.push(callout('info', power.DISCLAIMER, { key: 'disclaimer' }));
      if (!image) {
        kids.push(callout('info', 'Add a photo first.', { after: button('Go to Upload', { act: 'go-step', data: { step: 1 }, cls: 'small' }) }));
        return kids;
      }
      const placing = ui.mode.name === 'outlet';
      const sel = ui.selection;
      const outletInfo = (id) => byId(pw.outlets, id);
      const circuitOpts = [['', 'Unknown circuit']].concat(project.circuits.map((c) => [c.id, c.name]));
      const outletItems = project.outlets.filter((o) => !image || o.imageId === image.id || o.imageId == null).map((o) => {
        const info = outletInfo(o.id);
        const selected = !!(sel && sel.kind === 'outlet' && sel.id === o.id);
        const nFeeds = info ? info.feedIds.length : 0;
        const infoText = nFeeds ? plural(nFeeds, 'cord', 'cords') + ' · ' + watts(info.watts) + (info.splitters ? ' · ' + plural(info.splitters, 'power stake', 'power stakes') : '') : 'Nothing plugged in yet';
        return h('li', { class: 'outlet-card' + (selected ? ' selected' : ''), 'data-key': o.id },
          h('div', { class: 'outlet-head' },
            h('button', { type: 'button', class: 'outlet-pick', data: { act: 'select-outlet', id: o.id }, 'aria-label': 'Show ' + o.label + ' on the photo' }, icon('plug')),
            textInput({ act: 'outlet-field', value: o.label, data: { id: o.id, field: 'label' }, aria: 'Outlet name', cls: 'grow', maxlength: 60 }),
            iconButton('trash', 'Delete ' + o.label, { act: 'delete-outlet', data: { id: o.id }, cls: 'small' })),
          h('div', { class: 'row-2' },
            field('Type', selectInput({ act: 'outlet-type', value: o.type, options: OUTLET_TYPES, data: { id: o.id } })),
            field('Circuit', selectInput({ act: 'outlet-circuit', value: o.circuitId || '', options: circuitOpts, data: { id: o.id } }))),
          h('div', { class: 'row-2 align-center' },
            toggle('GFCI protected', { act: 'outlet-gfci', data: { id: o.id }, checked: o.gfci }),
            h('p', { class: 'outlet-info num' }, infoText)));
      });
      kids.push(section('Outlets', [
        h('div', { class: 'btn-row' }, button(placing ? 'Tap the photo to place it' : 'Place outlet', { act: 'place-outlet', icon: 'plug', cls: placing ? 'on' : 'primary', pressed: placing })),
        outletItems.length ? h('ul', { class: 'outlet-list' }, outletItems) : h('p', { class: 'hint' }, 'Place each outdoor outlet you can use. Garage outlets work too.'),
      ], { key: 'outlets' }));

      // Circuits
      const circuitItems = project.circuits.map((c) => {
        const info = byId(pw.circuits, c.id);
        const sharePct = Math.round(power.continuousFactorOf(ctx.config.power.continuousFactor).factor * 100);
        const limit = info ? info.limitW : power.limitW(c.breakerAmps, c.voltage || 120, ctx.config.power.continuousFactor);
        const load = info ? info.loadW : c.existingLoadW || 0;
        const pct = limit > 0 ? (load / limit) * 100 : 0;
        const cls = pct > 100 ? 'danger' : pct > 90 ? 'warn' : 'ok';
        const breakerOpts = [['15', '15 A'], ['20', '20 A']];
        if (![15, 20].includes(c.breakerAmps)) breakerOpts.push([String(c.breakerAmps), c.breakerAmps + ' A']);
        return h('li', { class: 'circuit-card', 'data-key': c.id },
          h('div', { class: 'outlet-head' },
            textInput({ act: 'circuit-field', value: c.name, data: { id: c.id, field: 'name' }, aria: 'Circuit name', cls: 'grow', maxlength: 60 }),
            iconButton('trash', 'Delete ' + c.name, { act: 'delete-circuit', data: { id: c.id }, cls: 'small', disabled: project.circuits.length <= 1 })),
          h('div', { class: 'row-2' },
            field('Breaker', selectInput({ act: 'circuit-breaker', value: String(c.breakerAmps), options: breakerOpts, data: { id: c.id } })),
            field('Already on it (W)', numInput({ act: 'circuit-existing', value: c.existingLoadW, min: 0, step: 10, decimals: 0, data: { id: c.id } }))),
          h('div', { class: 'meter ' + cls, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(limit)), 'aria-valuenow': String(Math.round(load)), 'aria-label': c.name + ' load' },
            h('span', { class: 'meter-fill', style: 'width:' + Math.min(100, Math.max(0, pct)).toFixed(1) + '%' })),
          h('p', { class: 'meter-text num' }, watts(load) + ' of ' + fmtNum(limit, 0) + ' W safe limit (' + sharePct + '% of ' + c.breakerAmps + ' A) · ' + fmtNum(pct, 0) + '%'));
      });
      kids.push(section('Circuits', [
        h('ul', { class: 'circuit-list' }, circuitItems),
        h('div', { class: 'btn-row' }, button('Add circuit', { act: 'add-circuit', icon: 'plus', cls: 'small' })),
        h('p', { class: 'hint' }, 'Outlets on the same breaker share one circuit. Add what else runs on it (a garage freezer, porch lights) so the check is honest.'),
      ], { key: 'circuits' }));

      // Feeds
      const runById = (id) => byId(plan.runs, id);
      const outletLabel = (id) => { const o = byId(project.outlets, id); return o ? o.label : null; };
      const feedItems = pw.feeds.map((f, i) => {
        const fruns = arr(f.runIds).map(runById).filter(Boolean);
        const names = fruns.map((r) => r.label);
        const units = Array.from(new Set(fruns.map((r) => r.unit)));
        const unitText = units.length === 1 ? fmtNum(f.strings, units[0] === 'foot' ? 1 : 0) + ' ' + unitWord(units[0], f.strings) : plural(f.strings, 'unit', 'units');
        const cord = f.cord ? arr(f.cord.pieces).map((p) => p + ' ft').join(' + ') + ' cord, ' + f.cord.awg + ' AWG (needs ' + fmtNum(f.cord.lengthFt, 0) + ' ft)'
          : f.outletId ? 'Cord length unknown' : 'No outlet yet';
        return h('li', { class: 'feed-item', 'data-key': f.id },
          h('p', { class: 'feed-title' }, h('span', { class: 'num feed-num' }, String(i + 1)), h('span', null, names.join(', ') || 'Lights'),
            icon('arrowRight', 'feed-arrow'), h('strong', null, outletLabel(f.outletId) || 'No outlet')),
          h('p', { class: 'feed-meta num' }, watts(f.watts) + ' · ' + unitText + ' · ' + cord + (f.crossesWalkway ? ' · needs a cord cover' : '')));
      });
      kids.push(section('Cords (' + pw.feeds.length + ')', feedItems.length ? h('ul', { class: 'feed-list' }, feedItems) : h('p', { class: 'hint' }, 'Cords appear once there are lights and an outlet.'), { key: 'feeds' }));

      const c = pw.counts;
      kids.push(section('Power extras to buy', h('div', { class: 'tiles small' },
        tile('Timers', fmtNum(c.timers, 0)), tile('Power stakes', fmtNum(c.splitters, 0)), tile('Cord covers', fmtNum(c.cordCovers, 0)), tile('GFCI adapters', fmtNum(c.gfciAdapters, 0))), { key: 'counts' }));

      const order = { danger: 0, warn: 1, info: 2 };
      const warns = arr(pw.warnings).filter((w) => w.code !== 'disclaimer').slice().sort((a, b) => order[a.level] - order[b.level]);
      kids.push(section('Warnings', warns.length ? warningList(warns, false) : h('p', { class: 'ok-line' }, icon('check'), h('span', null, 'No power problems found.')), { key: 'pwarn' }));
      kids.push(nextButton(5));
      return kids;
    }

    function tile(label, value, sub) {
      return h('div', { class: 'tile' }, h('p', { class: 'tile-value num' }, value), h('p', { class: 'tile-label' }, label), sub ? h('p', { class: 'tile-sub' }, sub) : null);
    }

    // ================================================================ step 6: Review & Export
    function stepReview(ctx) {
      const { project, plan, local } = ctx;
      const sm = plan.summary;
      const kids = [head(6, 'Everything to buy, what it costs, and the order to put it up.')];

      const problems = arr(plan.warnings).filter((w) => w.level === 'danger' || w.level === 'warn');
      if (problems.length) kids.push(section('Check before you buy (' + problems.length + ')', warningList(problems, true), { key: 'problems' }));

      const byType = TYPE_ORDER.filter((k) => sm.byType[k] && (sm.byType[k].lengthFt > 0 || sm.byType[k].lights > 0)).map((k) => {
        const b = sm.byType[k];
        return h('li', { 'data-key': k }, swatch(FEATURE_TYPES[k].color, 'dot'), h('span', null, FEATURE_TYPES[k].short),
          h('span', { class: 'num' }, k === 'bush' ? plural(b.lights, 'light', 'lights') : ctx.fmt(b.lengthFt)));
      });
      kids.push(section('Summary', [
        h('div', { class: 'tiles' },
          h('div', { class: 'tile wide' }, h('p', { class: 'tile-value num' }, fmtNum(sm.totalWithWasteFt, 0) + ' ft'), h('p', { class: 'tile-label' }, 'Lights, linear feet incl. waste'),
            h('p', { class: 'tile-sub num' }, ctx.fmt(sm.totalFt) + ' measured'), byType.length ? h('ul', { class: 'type-list' }, byType) : null),
          tile('Strings', fmtNum(sm.strings, 0)), tile('Clips', fmtNum(sm.clips, 0)), tile('Cords', fmtNum(sm.cords, 0)), tile('Timers', fmtNum(sm.timers, 0)),
          tile('Total watts', watts(sm.watts), fmtNum(sm.amps, 1) + ' A'), tile('Circuits', fmtNum(sm.circuits, 0)),
          h('div', { class: 'tile wide accent' }, h('p', { class: 'tile-value num' }, money(sm.cost)), h('p', { class: 'tile-label' }, 'Estimated materials cost'),
            isNum(sm.quoteTotal) ? h('p', { class: 'tile-sub num' }, 'Customer quote ' + money(sm.quoteTotal)) : null)),
      ], { key: 'summary' }));

      kids.push(bomSection(ctx));
      kids.push(quoteSection(ctx));
      kids.push(checklistSection(ctx));

      const busy = local.exporting;
      kids.push(section('Export', [h('div', { class: 'export-grid' },
        button(busy === 'pdf' ? 'Making PDF…' : 'PDF report', { act: 'export', data: { kind: 'pdf' }, icon: 'file', disabled: !!busy }),
        button(busy === 'quote' ? 'Making PDF…' : 'Customer quote PDF', { act: 'export', data: { kind: 'quote' }, icon: 'file', disabled: !!busy || !project.quote.enabled, title: project.quote.enabled ? null : 'Turn on installer mode to make a quote' }),
        button('CSV (shopping list)', { act: 'export', data: { kind: 'csv' }, icon: 'table', disabled: !!busy }),
        button('Save project (JSON)', { act: 'export', data: { kind: 'json' }, icon: 'download', disabled: !!busy }),
        button('Open project (JSON)', { act: 'pick', data: { kind: 'json' }, icon: 'folder' })),
      project.quote.enabled ? null : h('p', { class: 'hint' }, 'Turn on installer mode above to make a customer quote.')], { key: 'export' }));
      kids.push(nextButton(6));
      return kids;
    }

    function bomSection(ctx) {
      const bom = ctx.plan.bom;
      const rows = arr(bom.lines).map((l) => h('li', { class: 'bom-row', 'data-key': l.sku + ':' + hashKey(l.name) },
        h('div', { class: 'bom-top' }, h('span', { class: 'bom-name' }, l.name), h('span', { class: 'bom-total num' }, money(l.lineTotal))),
        l.notes ? h('p', { class: 'bom-notes' }, l.notes) : null,
        h('div', { class: 'bom-price' },
          h('span', { class: 'num bom-qty' }, fmtNum(l.qty, l.unit === 'foot' ? 1 : 0) + (unitWord(l.unit, l.qty) ? ' ' + unitWord(l.unit, l.qty) : '') + ' ×'),
          h('span', { class: 'money-input' }, h('span', { 'aria-hidden': 'true' }, '$'),
            numInput({ act: 'price', value: l.unitPrice, min: 0, step: 0.01, decimals: 2, data: { sku: l.sku }, aria: 'Unit price of ' + l.name, cls: l.overridden ? 'changed' : '' })),
          l.overridden ? button('Reset', { act: 'price-reset', data: { sku: l.sku }, cls: 'small ghost', aria: 'Reset the price of ' + l.name + ' to ' + money(l.defaultPrice) }) : null)));
      return section('Bill of materials', [
        rows.length ? h('ul', { class: 'bom-list' }, rows) : h('p', { class: 'hint' }, 'Trace something to see what to buy.'),
        rows.length ? h('p', { class: 'bom-subtotal' }, h('span', null, 'Subtotal'), h('strong', { class: 'num' }, money(bom.subtotal))) : null,
        rows.length ? h('p', { class: 'hint' }, 'Edit a unit price to match your store. Prices are typical retail and change often.') : null,
      ], { key: 'bom' });
    }

    function quoteSection(ctx) {
      const { project, plan } = ctx;
      const q = project.quote;
      const cu = project.customer;
      const kids = [toggle('Installer mode (make a customer quote)', { act: 'quote-toggle', checked: q.enabled })];
      if (q.enabled) {
        const qf = (label, key, o) => field(label, numInput(Object.assign({ act: 'quote-num', value: q[key], min: 0, data: { field: key } }, o || {})));
        kids.push(field('Your company', textInput({ act: 'quote-text', value: q.company, data: { field: 'company' }, placeholder: 'Company name', maxlength: 120 })));
        kids.push(h('div', { class: 'row-2' },
          field('Customer name', textInput({ act: 'customer-text', value: cu.name, data: { field: 'name' }, maxlength: 120 })),
          field('Customer phone', textInput({ act: 'customer-text', value: cu.phone, data: { field: 'phone' }, inputmode: 'tel', maxlength: 60 }))));
        kids.push(field('Customer address', textInput({ act: 'customer-text', value: cu.address, data: { field: 'address' }, maxlength: 200 })));
        kids.push(field('Labor priced', selectInput({ act: 'quote-method', value: q.laborMethod, options: [['perFt', 'Per foot of lights'], ['perHour', 'Per hour']] })));
        kids.push(h('div', { class: 'row-2' },
          q.laborMethod === 'perFt' ? qf('Rate per foot ($)', 'ratePerFt', { step: 0.05 }) : qf('Rate per hour ($)', 'ratePerHour', { step: 1 }),
          field('Install speed (ft/hour)', numInput({ act: 'config-field', value: plan.library.config.labor.ftPerHour, min: 1, step: 1, decimals: 0, data: { path: 'labor.ftPerHour' } }))));
        kids.push(h('div', { class: 'row-2' }, q.laborMethod === 'perFt' ? qf('Rate per hour ($), trees and bushes', 'ratePerHour', { step: 1 }) : null, qf('Markup on materials (%)', 'markupPct', { step: 1 })));
        kids.push(h('div', { class: 'row-2' }, qf('Takedown fee ($)', 'takedownFee', { step: 5 }), qf('Storage fee ($)', 'storageFee', { step: 5 })));
        kids.push(h('div', { class: 'row-2' }, qf('Tax on materials (%)', 'taxPct', { step: 0.1, max: 100 }), qf('Quote valid for (days)', 'validDays', { step: 1, decimals: 0 })));
        kids.push(field('Notes for the customer', h('textarea', { class: 'input', rows: 3, value: q.notes, data: { act: 'quote-text', field: 'notes', fk: 'quote-notes' }, maxlength: 2000 })));
        kids.push(quotePreview(ctx));
      } else {
        kids.push(h('p', { class: 'hint' }, 'For installers: adds labor, markup and fees, and makes a customer-facing quote PDF.'));
      }
      return section('Quote', kids, { key: 'quote' });
    }

    function quotePreview(ctx) {
      const { project, plan } = ctx;
      const q = plan.quote;
      const cu = project.customer;
      const lines = arr(q.lines);
      return h('div', { class: 'quote-preview', 'aria-label': 'Customer quote preview' },
        h('p', { class: 'qp-company' }, project.quote.company || 'Your company'),
        h('p', { class: 'qp-title' }, 'Holiday lighting quote'),
        cu.name || cu.address ? h('p', { class: 'qp-customer' }, [cu.name, cu.address].filter(Boolean).join(' · ')) : null,
        h('table', { class: 'qp-lines' }, h('tbody', null, lines.map((l, i) => {
          const isTotal = /^total$/i.test(l.description);
          return h('tr', { class: isTotal ? 'total' : null, 'data-key': 'q' + i }, h('td', null, l.description), h('td', { class: 'num' }, money(l.amount)));
        }))),
        h('p', { class: 'qp-foot' }, 'Valid for ' + plural(q.validDays, 'day', 'days') + '.' + (q.notes ? ' ' + q.notes : '')));
    }

    function checklistSection(ctx) {
      const { plan, local } = ctx;
      const groups = arr(plan.checklist);
      let total = 0;
      let done = 0;
      const blocks = groups.map((g, gi) => {
        let gDone = 0;
        const items = arr(g.steps).map((s, si) => {
          const key = hashKey(g.title + '|' + si + '|' + s);
          const checked = !!local.checks[key];
          total += 1;
          if (checked) { done += 1; gDone += 1; }
          return h('li', { class: 'check-item' + (checked ? ' done' : ''), 'data-key': key },
            h('label', null, h('input', { type: 'checkbox', checked, data: { act: 'check', key } }), h('span', null, s)));
        });
        const n = arr(g.steps).length;
        return h('details', { class: 'disclosure check-group', open: gi === 0, 'data-key': 'g' + gi + hashKey(g.title) },
          h('summary', null,
            h('span', { class: 'check-title' }, g.outletId ? icon('plug') : null, h('span', null, g.title)),
            h('span', { class: 'check-count num' + (gDone === n && n ? ' all' : '') }, gDone + '/' + n),
            icon('chevronDown', 'chev')),
          h('div', { class: 'disclosure-body' }, h('ol', { class: 'check-list' }, items)));
      });
      return section('Install checklist', [
        groups.length ? h('p', { class: 'hint' }, h('span', { class: 'num' }, done + ' of ' + total), ' steps done. Ticks are saved in this browser.') : null,
        groups.length ? blocks : h('p', { class: 'hint' }, 'The checklist appears once there are lights and outlets.'),
        done ? h('div', { class: 'btn-row' }, button('Clear ticks', { act: 'check-clear', cls: 'small ghost' })) : null,
      ], { key: 'checklist' });
    }

    // ================================================================ mount
    function mount(opts) {
      const root = opts.root;
      const store = opts.store;
      const actions = opts.actions;
      const local = {
        productDraft: null, productMsg: null, configDraft: null, configMsg: null, exporting: null,
        checks: {}, checksProjectId: null,
      };
      let scheduled = false;
      let destroyed = false;
      let lastStep = null;

      function loadChecks(project) {
        if (!project || local.checksProjectId === project.id) return;
        local.checksProjectId = project.id;
        const saved = persist.loadPref('checklist:' + project.id, {});
        local.checks = saved && typeof saved === 'object' ? saved : {};
      }

      function build() {
        const ctx = makeCtx(store);
        ctx.local = local;
        loadChecks(ctx.project);
        const step = ctx.ui.step;
        const builders = { 1: stepUpload, 2: stepCalibrate, 3: stepTrace, 4: stepDesign, 5: stepPower, 6: stepReview };
        let kids;
        try {
          kids = (builders[step] || stepUpload)(ctx);
        } catch (e) {
          if (typeof console !== 'undefined') console.error('LightPlan panel failed', e);
          kids = [head(step), callout('danger', 'This panel could not be shown because of a problem in the plan data. Undo your last change, or save the project and report the problem.')];
        }
        return h('div', { class: 'panel-content', 'data-key': 'step-' + step, 'data-step': String(step) }, kids);
      }

      function render() {
        if (destroyed) return;
        scheduled = false;
        const active = document.activeElement;
        const focusKey = active && root.contains(active) ? active.getAttribute('data-fk') : null;
        const next = build();
        const cur = root.firstElementChild;
        if (cur && cur.classList.contains('panel-content')) morph(cur, next);
        else { root.textContent = ''; root.appendChild(next); }
        const step = store.ui().step;
        if (step !== lastStep) { root.scrollTop = 0; lastStep = step; }
        // Re-focus a field that was replaced (its structure changed) so typing is not interrupted.
        if (focusKey && (!document.activeElement || !root.contains(document.activeElement))) {
          const el = root.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(focusKey) : focusKey) + '"]');
          if (el) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        }
      }
      function schedule() {
        if (scheduled || destroyed) return;
        scheduled = true;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
        raf(render);
      }

      // ---------------------------------------------------------------- handlers
      const P = () => store.project();
      const num = (el) => { const v = parseFloat(String(el.value).replace(',', '.')); return Number.isFinite(v) ? v : null; };
      const badLength = (el) => {
        actions.toast('"' + el.value + '" is not a length LightPlan understands. Try 32\' 4", 32.3 or 388in.', 'warn');
        schedule();
      };
      function saveChecks() {
        const p = P();
        if (p) persist.savePref('checklist:' + p.id, local.checks);
      }
      function editProducts(mutate) {
        const list = catalog.deepClone(store.plan().library.products);
        mutate(list);
        actions.setLibraryProducts(list);
      }
      function editConfig(path, value) {
        const over = catalog.deepClone((P().library && P().library.config) || {});
        const def = getPath(catalog.DEFAULT_CONFIG, path);
        setPath(over, path, value == null || value === def ? null : value);
        actions.setLibraryConfig(diffConfig(catalog.DEFAULT_CONFIG, over));
      }
      function parseJson(text) {
        try { return { ok: true, value: JSON.parse(text) }; } catch (e) {
          return { ok: false, error: 'This is not valid JSON: ' + String(e && e.message ? e.message : e).replace(/^JSON\.parse: /, '') + '.' };
        }
      }
      function checkProducts(apply) {
        const text = local.productDraft != null ? local.productDraft : JSON.stringify(store.plan().library.products, null, 2);
        const parsed = parseJson(text);
        if (!parsed.ok) { local.productMsg = { kind: 'danger', lines: [parsed.error] }; schedule(); return; }
        const v = validateProducts(parsed.value);
        if (!v.ok) { local.productMsg = { kind: 'danger', lines: v.errors.slice(0, 6).concat(v.errors.length > 6 ? ['…and ' + (v.errors.length - 6) + ' more.'] : []) }; schedule(); return; }
        if (apply) {
          actions.setLibraryProducts(parsed.value);
          local.productDraft = null;
          local.productMsg = { kind: 'ok', lines: ['Applied ' + plural(parsed.value.length, 'product', 'products') + '. The plan is updated.'] };
        } else {
          local.productMsg = { kind: 'ok', lines: ['Looks good: ' + plural(parsed.value.length, 'product', 'products') + '. Tap Apply to use it.'] };
        }
        schedule();
      }
      function checkConfig(apply) {
        const text = local.configDraft != null ? local.configDraft : JSON.stringify(store.plan().library.config, null, 2);
        const parsed = parseJson(text);
        if (!parsed.ok) { local.configMsg = { kind: 'danger', lines: [parsed.error] }; schedule(); return; }
        if (!catalog.isPlainObject(parsed.value)) { local.configMsg = { kind: 'danger', lines: ['The rules of thumb must be a JSON object: { ... }.'] }; schedule(); return; }
        const errors = [];
        (function walk(o, prefix) {
          for (const k of Object.keys(o)) {
            const v = o[k];
            const path = prefix ? prefix + '.' + k : k;
            const def = getPath(catalog.DEFAULT_CONFIG, path);
            if (def === undefined) continue; // unknown keys are kept but unused
            if (catalog.isPlainObject(def)) { if (catalog.isPlainObject(v)) walk(v, path); else errors.push('"' + path + '" must be an object.'); }
            else if (typeof def === 'number' && !(isNum(v) && v >= 0)) errors.push('"' + path + '" must be a number of 0 or more.');
            else if (typeof def === 'boolean' && typeof v !== 'boolean') errors.push('"' + path + '" must be true or false.');
          }
        })(parsed.value, '');
        if (errors.length) { local.configMsg = { kind: 'danger', lines: errors.slice(0, 6) }; schedule(); return; }
        if (apply) {
          actions.setLibraryConfig(diffConfig(catalog.DEFAULT_CONFIG, parsed.value));
          local.configDraft = null;
          local.configMsg = { kind: 'ok', lines: ['Applied. The plan is updated.'] };
        } else local.configMsg = { kind: 'ok', lines: ['Looks good. Tap Apply to use it.'] };
        schedule();
      }

      const CLICK = {
        'go-step': (el) => actions.goStep(Number(el.dataset.step)),
        pick: (el) => pickFile(actions, el.dataset.kind),
        'load-sample': (el) => actions.loadSample({ traced: el.dataset.traced !== '0' }),
        'select-plane': (el) => actions.select({ kind: 'plane', id: el.dataset.id }),
        'add-plane': (el) => actions.addPlane(el.dataset.kind),
        'delete-plane': (el) => actions.deletePlane(el.dataset.id),
        'mark-rect': (el) => actions.startPlaneRect(el.dataset.id),
        'remove-rect': (el) => actions.removePlaneRect(el.dataset.id),
        'draw-ref': (el) => actions.startReference(el.dataset.id),
        'select-ref': (el) => actions.select({ kind: 'ref', id: el.dataset.id, planeId: el.dataset.plane }),
        'delete-ref': (el) => actions.deleteRef(el.dataset.plane, el.dataset.id),
        'redraw-line': (el) => actions.redrawPlaneLine(el.dataset.id),
        'trace-type': (el) => {
          const ui = store.ui();
          if (ui.mode.name === 'trace' && ui.mode.opts.type === el.dataset.type) actions.cancelDraft();
          else actions.startTrace(el.dataset.type);
        },
        'draft-undo': () => actions.removeLastDraftPoint(),
        'draft-cancel': () => actions.cancelDraft(),
        'draft-finish': () => actions.completeDraft(),
        'select-feature': (el) => {
          const sel = store.ui().selection;
          if (sel && sel.kind === 'feature' && sel.id === el.dataset.id) actions.select(null);
          else actions.select({ kind: 'feature', id: el.dataset.id });
        },
        'delete-feature': (el) => actions.deleteFeature(el.dataset.id),
        'view-flip': (el) => { const k = el.dataset.key; actions.setView({ [k]: !store.ui().view[k] }); },
        'color-mode': (el) => actions.updateSettings({ colorMode: el.dataset.mode }),
        'custom-color-add': () => {
          const cs = P().settings.customColors.slice();
          const palette = ['#ff3b30', '#34c759', '#2f7bff', '#ffb000', '#b44dff', '#ffffff', '#ff7ad9', '#00d1c1'];
          cs.push(palette.find((c) => !cs.includes(c)) || '#ffffff');
          actions.updateSettings({ customColors: cs });
        },
        'custom-color-remove': (el) => {
          const cs = P().settings.customColors.slice();
          if (cs.length <= 1) return;
          cs.splice(Number(el.dataset.index), 1);
          actions.updateSettings({ customColors: cs });
        },
        'reset-auto': () => actions.resetAutoPlan(),
        'product-json-check': () => checkProducts(false),
        'product-json-apply': () => checkProducts(true),
        'product-json-discard': () => { local.productDraft = null; local.productMsg = null; schedule(); },
        'product-reset': () => {
          actions.confirm({ title: 'Reset the product library?', body: 'Every product goes back to the default name, price, watts and limits.', confirmLabel: 'Reset products', danger: true })
            .then((ok) => { if (ok) { actions.setLibraryProducts(null); local.productDraft = null; local.productMsg = { kind: 'ok', lines: ['Products reset to the defaults.'] }; schedule(); } });
        },
        'config-json-check': () => checkConfig(false),
        'config-json-apply': () => checkConfig(true),
        'config-json-discard': () => { local.configDraft = null; local.configMsg = null; schedule(); },
        'config-reset': () => {
          actions.confirm({ title: 'Reset the rules of thumb?', body: 'Clip spacing, bush, tree, cord and labor numbers go back to the defaults.', confirmLabel: 'Reset rules', danger: true })
            .then((ok) => { if (ok) { actions.setLibraryConfig(null); local.configDraft = null; local.configMsg = { kind: 'ok', lines: ['Rules of thumb reset to the defaults.'] }; schedule(); } });
        },
        'place-outlet': () => {
          if (store.ui().mode.name === 'outlet') actions.cancelDraft();
          else actions.startOutlet();
        },
        'select-outlet': (el) => actions.select({ kind: 'outlet', id: el.dataset.id }),
        'delete-outlet': (el) => actions.deleteOutlet(el.dataset.id),
        'add-circuit': () => actions.addCircuit(),
        'delete-circuit': (el) => actions.deleteCircuit(el.dataset.id),
        'price-reset': (el) => actions.setPriceOverride(el.dataset.sku, null),
        'check-clear': () => { local.checks = {}; saveChecks(); schedule(); },
        export: (el) => {
          const kind = el.dataset.kind;
          if (local.exporting) return;
          local.exporting = kind;
          schedule();
          exportFile(store, actions, kind).then(() => { local.exporting = null; schedule(); });
        },
      };

      const CHANGE = {
        'lens-mode': (el) => {
          const v = el.value;
          const id = el.dataset.id;
          if (v.indexOf('preset:') === 0) actions.updateImageCamera(id, { mode: 'preset', presetId: v.slice(7) });
          else if (v === 'manual') {
            const K = store.plan().measured.cameras[id];
            const im = byId(P().images, id);
            actions.updateImageCamera(id, { mode: 'manual', focalPx: (im && im.camera && im.camera.focalPx) || (K && isNum(K.f) ? Math.round(K.f) : null) });
          } else actions.updateImageCamera(id, { mode: v });
        },
        'lens-focal': (el) => {
          const v = num(el);
          if (v != null && v > 0) actions.updateImageCamera(el.dataset.id, { mode: 'manual', focalPx: v });
          else schedule();
        },
        'plane-name': (el) => {
          const name = el.value.trim();
          if (name) actions.updatePlane(el.dataset.id, { name: name.slice(0, 60) });
          else schedule();
        },
        'rect-preset': (el) => {
          const id = el.dataset.id;
          const pid = el.value;
          const pl = byId(P().planes, id);
          actions.setCalib({ rectPresetId: pid });
          if (pl && pl.rect) {
            const preset = measure.WALL_RECT_PRESETS.find((x) => x.id === pid);
            if (pid === 'custom-rect') {
              const c = store.ui().calib;
              actions.updatePlane(id, { rect: { presetId: pid, widthFt: pl.rect.widthFt || c.rectWidthFt || null, heightFt: pl.rect.heightFt || c.rectHeightFt || null } });
            } else {
              actions.updatePlane(id, { rect: { presetId: pid, widthFt: preset ? preset.widthFt : null, heightFt: preset ? preset.heightFt : null } });
            }
          }
        },
        'rect-size': (el) => {
          const id = el.dataset.id;
          const raw = el.value.trim();
          const v = raw ? parseLength(raw) : null;
          if (raw && v == null) { badLength(el); return; }
          const key = el.dataset.field === 'width' ? 'widthFt' : 'heightFt';
          actions.setCalib({ [key === 'widthFt' ? 'rectWidthFt' : 'rectHeightFt']: v });
          const pl = byId(P().planes, id);
          if (pl && pl.rect) actions.updatePlane(id, { rect: { [key]: v, presetId: 'custom-rect' } });
        },
        'ref-preset': (el) => actions.setCalib({ refPresetId: el.value }),
        'ref-courses': (el) => { const v = num(el); actions.setCalib({ refCourses: v != null && v >= 1 ? Math.round(v) : null }); },
        'ref-length': (el) => {
          const raw = el.value.trim();
          const v = raw ? parseLength(raw) : null;
          if (raw && v == null) { badLength(el); return; }
          actions.setCalib({ refLengthFt: v });
        },
        'ref-rect-size': (el) => {
          const raw = el.value.trim();
          const v = raw ? parseLength(raw) : null;
          if (raw && v == null) { badLength(el); return; }
          actions.setCalib({ [el.dataset.field === 'width' ? 'refWidthFt' : 'refHeightFt']: v });
        },
        'plane-pitch': (el) => {
          const v = el.value;
          const m = v.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
          actions.updatePlane(el.dataset.id, { derived: { pitch: m ? { rise: Number(m[1]), run: Number(m[2]) } : null } });
        },
        'roof-pitch': (el) => {
          const m = el.value.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
          actions.updateSettings({ roofPitch: m ? { rise: Number(m[1]), run: Number(m[2]) } : null });
        },
        'active-plane': (el) => actions.setActivePlane(el.value),
        'view-toggle': (el) => actions.setView({ [el.dataset.key]: !!el.checked }),
        'feature-field': (el) => {
          const f = byId(P().features, el.dataset.id);
          const v = el.value.trim();
          if (!f) return;
          if (!v) { schedule(); return; }
          actions.updateFeature(f.id, { [el.dataset.field]: v.slice(0, 80) });
        },
        'feature-type': (el) => actions.changeFeatureType(el.dataset.id, el.value),
        'feature-plane': (el) => actions.updateFeature(el.dataset.id, { planeId: el.value || null }),
        'feature-len': (el) => {
          const raw = el.value.trim();
          const v = raw ? parseLength(raw) : null;
          if (raw && v == null) { badLength(el); return; }
          const k = el.dataset.field;
          if (k === 'overrideFt') actions.updateFeature(el.dataset.id, { overrideFt: v });
          else actions.updateFeature(el.dataset.id, { params: { [k]: v } });
        },
        'feature-param': (el) => {
          const v = num(el);
          actions.updateFeature(el.dataset.id, { params: { [el.dataset.field]: v != null && v > 0 ? v : null } });
        },
        'feature-wrap': (el) => actions.updateFeature(el.dataset.id, { params: { wrapMode: el.value === 'canopy' ? 'canopy' : 'trunk' } }),
        waste: (el) => {
          const v = num(el);
          if (v == null || v < 0 || v > 100) { actions.toast('Waste must be between 0 and 100%.', 'warn'); schedule(); return; }
          actions.updateSettings({ wastePct: v });
        },
        'custom-color': (el) => {
          const cs = P().settings.customColors.slice();
          const i = Number(el.dataset.index);
          if (/^#[0-9a-f]{6}$/i.test(el.value) && i >= 0 && i < cs.length) { cs[i] = el.value; actions.updateSettings({ customColors: cs }); }
        },
        'run-product': (el) => actions.updateFeature(el.dataset.id, { productId: el.value || null }),
        'run-color': (el) => {
          const v = el.value;
          actions.updateFeature(el.dataset.id, { color: !v ? null : v === 'custom' ? { mode: 'custom', colors: P().settings.customColors.slice() } : { mode: v } });
        },
        'product-enabled': (el) => editProducts((list) => { const p = byId(list, el.dataset.id); if (p) p.enabled = !!el.checked; }),
        'product-field': (el) => {
          const k = el.dataset.field;
          if (k === 'name') {
            const v = el.value.trim();
            if (!v) { schedule(); return; }
            editProducts((list) => { const p = byId(list, el.dataset.id); if (p) p.name = v.slice(0, 120); });
            return;
          }
          const v = num(el);
          const min = k === 'maxEndToEnd' || k === 'stringLengthFt' || k === 'bulbSpacingIn' ? 1e-9 : 0;
          if (v == null || v < min) { actions.toast('Enter a number' + (min ? ' above 0.' : ' of 0 or more.'), 'warn'); schedule(); return; }
          editProducts((list) => { const p = byId(list, el.dataset.id); if (p) p[k] = k === 'maxEndToEnd' || k === 'bulbsPerUnit' ? Math.round(v) : v; });
        },
        'config-field': (el) => {
          let v = num(el);
          if (el.value.trim() === '') { editConfig(el.dataset.path, null); return; }
          if (v == null || v < 0) { actions.toast('Enter a number of 0 or more.', 'warn'); schedule(); return; }
          if (el.dataset.path === 'power.continuousFactor') {
            // A share of the breaker rating: 0.8 means 80%. Typing 80 means 80%; anything else is refused.
            if (v > 1 && v <= 100) { v = v / 100; actions.toast('Saved as ' + trimNum(v, 2) + ' (' + trimNum(v * 100, 1) + '% of the breaker rating).', 'info'); }
            else if (!(v > 0 && v <= 1)) { actions.toast('Enter the safe share as a fraction from 0.01 to 1 (0.8 = 80%).', 'warn'); schedule(); return; }
          }
          editConfig(el.dataset.path, v);
        },
        'outlet-field': (el) => { const v = el.value.trim(); if (v) actions.updateOutlet(el.dataset.id, { label: v.slice(0, 60) }); else schedule(); },
        'outlet-type': (el) => actions.updateOutlet(el.dataset.id, { type: el.value }),
        'outlet-circuit': (el) => actions.updateOutlet(el.dataset.id, { circuitId: el.value || null }),
        'outlet-gfci': (el) => actions.updateOutlet(el.dataset.id, { gfci: !!el.checked }),
        'circuit-field': (el) => { const v = el.value.trim(); if (v) actions.updateCircuit(el.dataset.id, { name: v.slice(0, 60) }); else schedule(); },
        'circuit-breaker': (el) => actions.updateCircuit(el.dataset.id, { breakerAmps: Number(el.value) || 15 }),
        'circuit-existing': (el) => { const v = num(el); actions.updateCircuit(el.dataset.id, { existingLoadW: v != null && v >= 0 ? v : 0 }); },
        price: (el) => {
          const v = num(el);
          if (el.value.trim() === '') { actions.setPriceOverride(el.dataset.sku, null); return; }
          if (v == null || v < 0) { actions.toast('Enter a price of $0 or more.', 'warn'); schedule(); return; }
          actions.setPriceOverride(el.dataset.sku, v);
        },
        'quote-toggle': (el) => actions.updateQuote({ enabled: !!el.checked }),
        'quote-text': (el) => actions.updateQuote({ [el.dataset.field]: el.value.slice(0, el.dataset.field === 'notes' ? 2000 : 120) }),
        'quote-num': (el) => {
          const v = num(el);
          if (v == null || v < 0) { actions.toast('Enter a number of 0 or more.', 'warn'); schedule(); return; }
          actions.updateQuote({ [el.dataset.field]: el.dataset.field === 'validDays' ? Math.round(v) : v });
        },
        'quote-method': (el) => actions.updateQuote({ laborMethod: el.value === 'perHour' ? 'perHour' : 'perFt' }),
        'customer-text': (el) => actions.updateCustomer({ [el.dataset.field]: el.value.trim().slice(0, 200) }),
        check: (el) => {
          if (el.checked) local.checks[el.dataset.key] = true;
          else delete local.checks[el.dataset.key];
          saveChecks();
          schedule();
        },
      };
      const INPUT = {
        'product-json': (el) => { local.productDraft = el.value; },
        'config-json': (el) => { local.configDraft = el.value; },
      };

      function onClick(e) {
        const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!el || !root.contains(el) || el.disabled) return;
        if (el.matches('input, select, textarea')) return; // handled on change
        const fn = CLICK[el.dataset.act];
        if (fn) { e.preventDefault(); fn(el, e); }
      }
      function onChange(e) {
        const el = e.target;
        if (!el || !el.matches || !el.matches('[data-act]')) return;
        const fn = CHANGE[el.dataset.act];
        if (fn) fn(el, e);
      }
      function onInput(e) {
        const el = e.target;
        if (!el || !el.matches || !el.matches('[data-act]')) return;
        const fn = INPUT[el.dataset.act];
        if (fn) fn(el, e);
      }
      root.addEventListener('click', onClick);
      root.addEventListener('change', onChange);
      root.addEventListener('input', onInput);
      const unsubscribe = store.subscribe(schedule);
      render();

      return {
        render,
        destroy() {
          destroyed = true;
          unsubscribe();
          root.removeEventListener('click', onClick);
          root.removeEventListener('change', onChange);
          root.removeEventListener('input', onInput);
        },
      };
    }

    return { mount, icon, h, morph, pickFile, exportFile, stepWarnings, warningStep, STEPS, validateProducts, diffConfig, ICONS };
  });
