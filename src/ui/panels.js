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
 *
 * Phase 1.1 (SPEC §8.5): the panels no longer end in a "Next" button. One button is pinned under the panel by
 * app.js; nextAction(project, ui, plan) says what it reads and runNextAction does it, and planProgress(project,
 * plan) tells the step bar what is done. The Power step is built from powerVerdict(plan) and
 * ui.export.describeCords; Review opens with ui.export.roughMeasurements. Tap precision (SPEC §8.4): when a rating
 * is held down by taps placed zoomed out, the Calibrate plane editor and the Trace item editor show that reason as
 * a note (zoomedOutReason), not only folded away under "why".
 *
 * Suppliers (SPEC §8.3, §8.5). The Design step opens with "Buy from" (Any store / a supplier): the supplier's site,
 * what its pages say about business accounts, one sentence about how fresh its prices are, and "C7 and C9 as"
 * (cut-to-length wire and bulbs, or ready-made strings). A run's product picker is grouped by supplier
 * (productGroups) and its card says where the product is bought (part number, price, status, a link) or, for a
 * cut-to-length product, what it is ordered as and the status of each part. The Review step's "Shopping list" shows
 * supplier, part number, price status and links on every row, what a spool, box or pack leaves over, and an
 * "Order sheets" section (copy as text, save as CSV); in installer mode it has the cost-basis switch.
 * Every link is a plain <a target="_blank"> beside a "Copy link" button, because the viewer may refuse to open
 * links: copying writes to the clipboard and, where that is blocked, shows the address selected in a read-only
 * field. Nothing is ever fetched or opened by code. The wording comes from ui.export (supplierFacts, priceSentence,
 * priceStatusLabel, orderUseText, describeBulk, whereToBuy) so the PDF says the same.
 *
 * Mansard roofs and two fixes found on a real house:
 *  - Calibrate: when a wall's scale comes from a measured rectangle other than the one marked as its corners
 *    (measure: calib.rectAuto), the wall's status card says so in one line (scaleLine) and the reference list shows
 *    which rectangle sets the scale and how the other one checks.
 *  - Calibrate: "Steep roof face (mansard)" beside Wall, Roof slope and Ground. Its editor (steepEditor) offers
 *    typical angles (a guess) and "I measured it" (two tape numbers, measure.steepFromTape), shows the angle, and
 *    offers "Add the upper roof". The surface list names the kinds apart (ui.actions.surfaceKind).
 *  - Trace and Review: a ridge drawn on a wall (measure: wrongSurface 'roof', needsRoof) carries two buttons, on
 *    its card and in its "double-check" entry: "Put it on the roof" (actions.putOnRoof) and "Type its length"
 *    (actions.typeLength, which sets ui.focusTape; render() then puts the cursor in that item's tape field).
 */
LP.define('ui.panels', ['catalog', 'measure', 'camera', 'design', 'power', 'ui.actions', 'ui.persist', 'ui.store', 'suppliers'],
  function (catalog, measure, camera, design, power, actionsModule, persist, storeModule, suppliers) {
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
      external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
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
    /**
     * A price as people type it: "12.5", "$12", "12,50" (a comma for the decimal point) or "1,234.50" → dollars,
     * or null when it is not a number of 0 or more.
     */
    function parseMoney(text) {
      let t = String(text == null ? '' : text).trim().replace(/^\$\s*/, '').replace(/\s+/g, '');
      if (!t) return null;
      if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
      else if (/^\d*,\d{1,2}$/.test(t)) t = t.replace(',', '.');
      if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
      const v = Number(t);
      return Number.isFinite(v) && v >= 0 ? v : null;
    }
    /**
     * A tape-measured size that is so far from what the photo says that it is probably a slip of the finger
     * (150 for 15.0): the factor between them when it is 3 or more, else null.
     */
    function tapeMismatch(typedFt, photoFt) {
      if (!(isNum(typedFt) && typedFt > 0 && isNum(photoFt) && photoFt > 0)) return null;
      const k = typedFt > photoFt ? typedFt / photoFt : photoFt / typedFt;
      return k >= 3 ? k : null;
    }
    /** A plain name for a price-override key that is not on the shopping list right now (a part number, a product). */
    function overrideName(library, sku) {
      const lib = library || {};
      for (const p of arr(lib.products)) {
        if (!p) continue;
        if (p.sku === sku || p.id === sku) return p.name || sku;
        for (const c of suppliers.componentOffers(p)) if (c.offer && c.offer.sku === sku) return c.offer.name || sku;
      }
      for (const a of arr(lib.accessories)) if (a && a.sku === sku) return a.name || sku;
      for (const sid of Object.keys(suppliers.SUPPLIER_ACCESSORIES)) {
        const m = suppliers.SUPPLIER_ACCESSORIES[sid];
        for (const k of Object.keys(m)) if (m[k].sku === sku) return m[k].name || sku;
      }
      return sku;
    }
    /**
     * Your own prices for things that are not on the shopping list right now (the plan changed, or a dearer size
     * dropped out of the wire mix): [{sku, name, price}]. They are kept, so they need a way to be seen and reset.
     */
    function strayOverrides(project, plan) {
      const overrides = project && project.pricing && project.pricing.overrides;
      if (!overrides || typeof overrides !== 'object') return [];
      const onList = new Set(arr(plan && plan.bom && plan.bom.lines).map((l) => l.sku));
      const out = [];
      for (const sku of Object.keys(overrides)) {
        const v = typeof overrides[sku] === 'string' ? Number(overrides[sku]) : overrides[sku];
        if (onList.has(sku) || !(isNum(v) && v >= 0)) continue;
        out.push({ sku, name: overrideName(plan && plan.library, sku), price: v });
      }
      return out;
    }
    const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'], pack: ['pack', 'packs'], spool: ['spool', 'spools'], each: ['', ''] };
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
      if (w.code === 'focal-mismatch' || w.code === 'exif-ignored') return 1;
      if (w.planeId || /^(pitch|ref|plane|rect|measure|derived)/.test(w.code || '')) return 2;
      if (w.featureId) return 3;
      return 6;
    }
    /**
     * {step: {count, level, low}} per step: `count` warn/danger warnings (info and the disclaimer are not counted)
     * and their worst `level`; `low` is the number of traced items rated Low that have no tape-measured size yet
     * (step 3 only: the step bar shows it in a neutral colour when the step has no warnings).
     */
    function stepWarnings(plan) {
      const out = {};
      for (const s of STEPS) out[s.n] = { count: 0, level: null, low: 0 };
      for (const w of arr(plan && plan.warnings)) {
        if (!w || w.code === 'disclaimer' || (w.level !== 'warn' && w.level !== 'danger')) continue;
        const s = out[warningStep(w)];
        s.count += 1;
        if (w.level === 'danger' || !s.level) s.level = w.level;
      }
      const measured = plan && plan.measured && plan.measured.features;
      if (measured && typeof measured === 'object') {
        for (const id of Object.keys(measured)) {
          const m = measured[id];
          if (m && m.ok && !m.overridden && m.confidence && m.confidence.level === 'low') out[3].low += 1;
        }
      }
      return out;
    }

    // ================================================================ progress and the next thing to do
    /**
     * Where the plan stands, read from the plan itself (never from which step happens to be open).
     * → { photo, scaled, traced (items on this photo), outlets (on this photo),
     *     steps: {1: photo in, 2: scale set, 3: something traced, 4: lights planned, 5: outlet placed, 6: false},
     *     left: ['set the scale', …]  (what is still to do, in order) }
     */
    function planProgress(project, plan) {
      const image = storeModule.activeImageOf(project);
      const onPhoto = (x) => !!x && (!image || x.imageId === image.id || x.imageId == null);
      const sols = (plan && plan.measured && plan.measured.planes) || {};
      const scaled = !!image && arr(project && project.planes).some((pl) => pl && pl.imageId === image.id && sols[pl.id] && sols[pl.id].ok);
      const traced = image ? arr(project && project.features).filter(onPhoto).length : 0;
      const outlets = image ? arr(project && project.outlets).filter(onPhoto).length : 0;
      const left = [];
      if (!image) left.push('add a photo');
      else {
        if (!scaled) left.push('set the scale');
        if (!traced) left.push('trace the lights');
        if (!outlets) left.push('place an outlet');
      }
      return {
        photo: !!image, scaled, traced, outlets, left,
        steps: { 1: !!image, 2: scaled, 3: traced > 0, 4: traced > 0, 5: outlets > 0, 6: false },
      };
    }

    /**
     * The one button pinned under the panel: what to do next, from the plan's state and the open step.
     * → { id, label, primary, note }   id is handled by runNextAction; note is the "Left to do" line (may be '').
     */
    function nextAction(project, ui, plan) {
      const pr = planProgress(project, plan);
      const mode = (ui && ui.mode && ui.mode.name) || 'select';
      const step = (ui && ui.step) || 1;
      const note = pr.photo && pr.left.length ? 'Left to do: ' + pr.left.join(', ') + '.' : '';
      const act = (id, label, primary) => ({ id, label, primary: primary !== false, note });
      // A tool is in use: the button is the way out of it (the hint bar on the photo says what to tap).
      if (mode === 'trace') return { id: 'trace-done', label: 'Done tracing', primary: true, note: '' };
      if (mode === 'rect' || mode === 'line' || mode === 'outlet') return { id: 'cancel-tool', label: 'Cancel', primary: false, note: '' };
      if (!pr.photo) return { id: 'pick-photo', label: 'Choose photo', primary: true, note: '' };
      const toScale = () => act('go-2', pr.scaled ? 'Next: ' + STEPS[1].label : 'Set the scale');
      const toTrace = () => act('go-3', pr.traced ? 'Next: ' + STEPS[2].label : 'Trace the lights');
      if (step <= 1) return toScale();
      if (step === 2) {
        if (pr.scaled) return toTrace();
        const planes = arr(project.planes).filter((pl) => pl && storeModule.activeImageOf(project) && pl.imageId === storeModule.activeImageOf(project).id);
        const active = byId(planes, ui.activePlaneId);
        const wall = active && active.kind === 'wall' ? active : planes.find((pl) => pl.kind === 'wall') || null;
        if (!wall) return act('add-wall', 'Add a wall');
        if (!wall.rect && !arr(wall.refs).length) return Object.assign(act('mark-rect', 'Mark the 4 corners'), { planeId: wall.id });
        // A rectangle of unknown size (or references that do not solve yet): one known length sets the scale.
        return Object.assign(act('draw-ref', 'Add a known length'), { planeId: wall.id });
      }
      if (step === 3) {
        if (!pr.traced) return pr.scaled ? act('trace-roofline', 'Trace the roofline') : act('go-2', 'Set the scale');
        return act('go-4', 'Next: ' + STEPS[3].label);
      }
      if (step === 4) return pr.traced ? act('go-5', 'Next: ' + STEPS[4].label) : toTrace();
      if (step === 5) {
        if (!pr.traced) return toTrace();
        return pr.outlets ? act('go-6', 'See the shopping list') : act('place-outlet', 'Place an outlet');
      }
      return pr.traced ? act('save-pdf', 'Save PDF') : toTrace();
    }

    /** Do what the pinned button says. env: {store, actions}. Returns a promise for 'save-pdf', else undefined. */
    function runNextAction(next, env) {
      const actions = env.actions;
      const id = next && next.id;
      if (!id) return undefined;
      if (id === 'pick-photo') return void pickFile(actions, 'file');
      if (id === 'trace-done') return void actions.finishTracing();
      if (id === 'cancel-tool') return void actions.cancelDraft();
      if (id === 'add-wall') return void actions.addPlane('wall');
      if (id === 'mark-rect') return void actions.startPlaneRect(next.planeId);
      if (id === 'draw-ref') return void actions.startReference(next.planeId);
      if (id === 'trace-roofline') return void actions.startTrace('roofline');
      if (id === 'place-outlet') return void actions.startOutlet();
      if (id === 'save-pdf') return exportFile(env.store, actions, 'pdf');
      const m = /^go-(\d)$/.exec(id);
      if (m) return void actions.goStep(Number(m[1]));
      return undefined;
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
    /** Set once the viewer says saving files is unavailable: the export buttons are then disabled with a note. */
    let savingUnavailable = false;
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
      return saveResult(Promise.resolve().then(run), actions, EXPORT_DONE[kind]);
    }
    /** Report how a save went in a toast (the same words for every file). Resolves the result; never rejects. */
    function saveResult(promise, actions, doneText) {
      return promise.then((res) => {
        if (res === 'saved') actions.toast(doneText, 'ok');
        else if (res === 'busy') actions.toast('A save is already open. Finish or close it first.', 'info');
        else if (res === 'unavailable') {
          savingUnavailable = true;
          actions.toast('Saving files is not available in this view, so nothing was saved.', 'error');
        } else if (res === 'too_large') actions.toast('This file is too large to save here.', 'error');
        else if (res !== 'declined') actions.toast('The file could not be saved. Try again.', 'error');
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
    const surfaceKind = actionsModule.surfaceKind;
    const SURFACE_LABEL = actionsModule.SURFACE_LABEL;
    const surfaceOptionLabel = actionsModule.surfaceOptionLabel;
    /** "70° from level, measured" for a steep roof face (sol.pitch of its solution). */
    function steepSlopeText(pitch) {
      if (!pitch || !isNum(pitch.angleDeg)) return '';
      const how = pitch.source === 'user' ? (pitch.clamped ? 'measured, almost straight up' : 'measured')
        : pitch.source === 'guess' ? 'a typical angle, not measured' : 'assumed';
      return actionsModule.steepAngleText(pitch.angleDeg) + ' from level (' + how + ')';
    }
    /** A steep face's slope read from its stored data, for when its wall has no scale yet: {angleDeg, source}. */
    function storedSteepPitch(derived) {
      const d = derived || {};
      const lim = measure.STEEP || { defaultDeg: 70, minDeg: 20, maxDeg: 85 };
      if (d.pitch && d.pitch.rise > 0 && d.pitch.run > 0) {
        const ang = Math.atan2(d.pitch.rise, d.pitch.run) * 180 / Math.PI;
        return { angleDeg: Math.min(ang, lim.maxDeg), source: 'user', clamped: ang > lim.maxDeg };
      }
      if (isNum(d.angleDeg)) return { angleDeg: Math.max(lim.minDeg, Math.min(lim.maxDeg, d.angleDeg)), source: 'guess' };
      return { angleDeg: lim.defaultDeg, source: 'default' };
    }
    /**
     * The one line that says where a wall's scale comes from when LightPlan chose a measured rectangle other than
     * the one marked as the wall's corners (measure: calib.rectAuto), or null. The wording is core's own note.
     */
    function scaleLine(sol) {
      const c = sol && sol.ok && sol.calib;
      if (!c || !c.rectAuto) return null;
      const why = c.rectWhy === 'steadiest' ? 'the measured rectangle that gives the steadiest scale' : 'the largest measured rectangle';
      const own = arr(c.rectCandidates).find((x) => x && x.from === 'rect');
      const mine = own && own.label ? rectWords(own.label) + " you marked as this wall's corners" : 'The rectangle you marked as this wall\'s corners';
      return 'Scale taken from ' + (c.rectLabel ? rectWords(c.rectLabel) : 'another rectangle') + ' (' + why + '). ' + capFirst(mine) + ' is used as a check.';
    }
    /**
     * A rectangle by what the homeowner knows of it: "the 8′ 0″ × 7′ 2″ rectangle" for one whose size was typed
     * (core labels those "Custom rectangle (…)" or "Rectangle (…)"), "the double garage door (16 × 7 ft)" for a preset.
     */
    function rectWords(label) {
      const text = String(label || '').trim();
      const m = /^(?:Custom rectangle|Rectangle) \((.+)\)$/.exec(text);
      if (m) return 'the ' + m[1] + ' rectangle';
      return text ? 'the ' + text.charAt(0).toLowerCase() + text.slice(1) : 'the rectangle';
    }
    const isScaleNote = (n) => typeof n === 'string' && /^Scale taken from/.test(n);
    /**
     * Does this item need the "put it on the roof" fix? m is its measurement: a ridge drawn on a wall
     * (m.wrongSurface 'roof') whose length is not tape-measured yet.
     */
    function needsRoof(f, m) {
      return !!(f && m && m.wrongSurface === 'roof' && !(isNum(f.overrideFt) && f.overrideFt > 0));
    }
    /**
     * Does this item need the "put it on the surface below" fix? It is on a roof but drawn below the line where
     * that roof starts (m.wrongSurface 'below'), and its length is not tape-measured yet.
     */
    function needsLower(f, m) {
      return !!(f && m && m.wrongSurface === 'below' && !(isNum(f.overrideFt) && f.overrideFt > 0));
    }
    /** The surface an item drawn below its roof's line would move to (a candidate of misplacedFeatures), or null. */
    function lowerTarget(project, f, item) {
      return arr(item && item.candidates).find((c) => !c.below && actionsModule.typeFitsSurface(project, f.type, byId(project.planes, c.planeId))) || null;
    }
    /** The first two sentences of core's message for a misplaced item (what is wrong, without the "do this"). */
    function wrongSurfaceWhy(item) {
      const msg = item && typeof item.message === 'string' ? item.message : '';
      const parts = msg.split('. ');
      return parts.length > 2 ? parts.slice(0, 2).join('. ') + '.' : msg;
    }
    /** Under the two fix buttons: where "Put it on the roof" will put the item. */
    function roofFixNote(project, f, item) {
      const target = item ? actionsModule.pickRoofCandidate(project, f, item.candidates) : null;
      if (target) return "Put it on the roof moves it to '" + (target.name || 'the roof') + "'" + (item.candidates.length > 1 ? '. You can pick another surface after.' : '.');
      if (item && arr(item.candidates).length) return 'No roof marked so far starts under this item. Put it on the roof asks what kind of roof it is, has you mark where it starts, then moves the item.';
      return 'No roof is marked above this wall yet. Put it on the roof asks what kind of roof it is, has you mark where it starts, then moves the item.';
    }
    const SOURCE_KIND = { upload: 'Uploaded photo', camera: 'Phone camera', sample: 'Sample house', streetview: 'Street-level screenshot', aerial: 'Aerial view' };
    /**
     * Lens wording as shown on screen: the wide-view preset is called "Screenshot (wide view)" (SPEC §8.4), whatever
     * an older catalog or message still calls it.
     */
    const OLD_WIDE_NAME = new RegExp(['Street', 'View'].join(' ') + '( screenshots?)?', 'gi');   // the preset's Phase 1 name
    const lensWords = (t) => String(t == null ? '' : t).replace(OLD_WIDE_NAME, 'Screenshot (wide view)');
    const smallPhotoText = (image) => 'This photo is small (' + fmtNum(image.width, 0) + ' px wide), so corners are hard to place and lengths come out rough. Use the original photo from the camera if you can.';
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
    const MOUNT_OPTIONS = [['gutter', 'Gutter clips'], ['shingle', 'Shingle tabs'], ['allInOne', 'All-in-one clips'], ['ridge', 'Ridge clips'],
      ['adhesive', 'Adhesive clips'], ['zipTie', 'Zip ties'], ['stake', 'Light stakes'], ['none', 'No clips']];
    const MOUNT_LABEL = MOUNT_OPTIONS.reduce((o, m) => { o[m[0]] = m[1]; return o; }, {});
    const CALIBRATE_SENTENCE = 'Tap the four corners of this wall, then one thing on it whose size you know, like the height of the front door. ' +
      'LightPlan un-tilts the photo so lengths come out as if you stood straight in front of it. ' +
      'To tap a garage door or the front door instead, choose it under "What is it?" first.';
    const WASTE_NOTE = 'Add 10% for waste, corners and drops to the outlet';
    const RAKE_NOTE = 'A rake is the sloped edge of a gable roof, from the eave up to the peak.';
    const MANSARD_NOTE = 'On a mansard, trace the trim line, corner edges and dormers on the steep roof face, and the top edge on the upper roof. ' +
      'Use Rake for the leaning corner edges. LightPlan picks the surface from where you tap, and you can change it with "On" above the photo.';
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
    /** A select whose options sit in named groups: o.first / o.last are plain options before and after the groups. */
    function groupedSelect(o) {
      const opt = (op) => h('option', { value: op[0], disabled: !!op[2] }, op[1]);
      return h('select', {
        class: 'input select' + (o.cls ? ' ' + o.cls : ''), value: o.value == null ? '' : o.value,
        data: Object.assign({ act: o.act, fk: fk(o.act, o.data && o.data.id, o.data && o.data.field) }, o.data || {}),
        'aria-label': o.aria || null, id: o.idAttr || null,
      }, arr(o.first).map(opt), arr(o.groups).map((g) => h('optgroup', { label: g.label, 'data-supplier': g.supplierId || null }, g.options.map(opt))), arr(o.last).map(opt));
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
        h('input', { type: 'checkbox', role: 'switch', checked: !!o.checked, data: Object.assign({ act: o.act }, o.data || {}), 'aria-label': o.aria || null }),
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
    /**
     * The "Tapped zoomed out (about ±N px on the photo): zoom in and re-tap …" reason of a rating (SPEC §8.4), or
     * null. It is the one cause the user can fix in seconds, so the Calibrate and Trace steps say it outright in a
     * note instead of leaving it folded away under "why".
     */
    function zoomedOutReason(conf) {
      return arr(conf && conf.reasons).find((r) => typeof r === 'string' && /^Tapped zoomed out/.test(r)) || null;
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
        // Items on the wrong surface that have a fix here (a ridge drawn on a wall, an item below its roof's line), by feature id.
        misplaced: (() => {
          let memo = null;
          return () => {
            if (!memo) {
              memo = {};
              for (const it of arr(measure.misplacedFeatures(project, plan.measured))) if (it && (it.wants === 'roof' || it.wants === 'below')) memo[it.featureId] = it;
            }
            return memo;
          };
        })(),
        fmt: (ft) => measure.formatLength(ft, fmtFmt),
        activePlane: byId(planes, ui.activePlaneId) || planes[0] || null,
      };
    }

    function planeConfidence(ctx, sol) {
      if (!sol || !sol.ok) return null;
      // measure rates each plane itself (tap precision, caps); this fallback is for older solutions only.
      if (sol.confidence && sol.confidence.level) return sol.confidence;
      const K = ctx.image ? ctx.plan.measured.cameras[ctx.image.id] : null;
      return measure.scoreConfidence({
        mode: sol.mode, checks: sol.checks, disagreementPct: sol.disagreementPct,
        onlyMediumLowRefs: sol.calib && sol.calib.onlyMediumLowRefs, minCourses: sol.calib && sol.calib.minCourses,
        viewAngleDeg: sol.viewAngleDeg, focalSource: K && K.source, pitchSource: sol.pitch && sol.pitch.source,
        steep: !!sol.steep, steepAngleDeg: sol.steep && sol.pitch ? sol.pitch.angleDeg : null, slopeBelow: sol.slopeBelow,
        thresholds: ctx.config.confidence,
      });
    }

    // ================================================================ step 1: Upload
    function stepUpload(ctx) {
      const { image, plan } = ctx;
      const isSample = !!(image && image.source && image.source.kind === 'sample');
      const kids = [head(1, 'Use a photo of the front of the house. Every measurement comes from it.')];
      // The two photo buttons are shown once: on the picture while there is no photo (the empty card there has
      // them), here once there is one (to use a different photo). Dropping a file is a desktop extra.
      if (image) {
        kids.push(h('div', { class: 'dropzone', 'data-key': 'dropzone' },
          h('p', { class: 'dz-title' }, 'Use a different photo'),
          h('p', { class: 'dz-sub' }, 'Choose or take a photo', h('span', { class: 'desk-only' }, ', or drop one anywhere on the picture'), '.'),
          h('div', { class: 'btn-row' },
            button('Choose photo', { act: 'pick', data: { kind: 'file' }, icon: 'image' }),
            button('Take photo', { act: 'pick', data: { kind: 'camera' }, icon: 'camera' }))));
      } else {
        kids.push(h('p', { class: 'lead', 'data-key': 'dropzone' }, 'Choose or take a photo to start',
          h('span', { class: 'desk-only' }, ', or drop one anywhere on the page'), '.'));
      }
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
        ]), actionsModule.isSmallPhoto(image) ? callout('warn', smallPhotoText(image), { key: 'small-photo' }) : null], { key: 'photo' }));
        kids.push(lensSection(ctx));
      }
      kids.push(disclosure('Photo tips', h('ul', { class: 'tips' }, PHOTO_TIPS.map((t) => h('li', null, t))), { open: !image || isSample, key: 'tips' }));
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
      ].concat(camera.CAMERA_PRESETS.map((p) => ['preset:' + p.id, lensWords(p.label)]))
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
          h('span', null, lensWords(K.label) + (isNum(K.f) ? ' · ' : ''), isNum(K.f) ? h('span', { class: 'num' }, fmtNum(K.f, 0) + ' px') : null)));
      }
      // The lens setting disagrees with what the rectangles in the photo measure (a zoomed screenshot, a crop...).
      const mismatch = arr(plan.measured && plan.measured.warnings).find((w) => w && w.code === 'focal-mismatch' && w.imageId === image.id);
      if (mismatch) {
        kids.push(callout('warn', lensWords(mismatch.message), {
          key: 'lens-mismatch',
          after: isNum(mismatch.suggestedFocalPx) ? button('Use ' + fmtNum(mismatch.suggestedFocalPx, 0) + ' px', { act: 'lens-use', data: { id: image.id, f: mismatch.suggestedFocalPx }, cls: 'small' }) : null,
        }));
      }
      if (K && K.exifIgnored) kids.push(callout('info', lensWords(K.exifIgnored), { key: 'lens-exif-ignored' }));
      kids.push(h('p', { class: 'hint' }, 'Automatic uses the lens data in the photo, then measures the lens from the rectangle you mark in step 2, and otherwise assumes a phone main camera. For a screenshot, keep Automatic once a rectangle is marked: a screenshot can be zoomed, so how wide it sees is not fixed.'));
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
      if (actionsModule.isSmallPhoto(image)) kids.push(callout('warn', smallPhotoText(image), { key: 'small-photo' }));
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
        h('span', { class: 'plane-kind' }, SURFACE_LABEL[surfaceKind(ctx.project, pl)] || 'Surface'),
        conf ? pill(conf.level) : h('span', { class: 'pill none' }, 'Needs a scale'));
      });
      kids.push(section('Surfaces', [
        h('div', { class: 'plane-list' }, rows.length ? rows : h('p', { class: 'hint' }, 'No surfaces yet.')),
        h('div', { class: 'btn-row wrap' },
          button('Wall', { act: 'add-plane', data: { kind: 'wall' }, icon: 'plus', cls: 'small' }),
          button('Roof slope', { act: 'add-plane', data: { kind: 'roof' }, icon: 'plus', cls: 'small' }),
          button('Ground', { act: 'add-plane', data: { kind: 'ground' }, icon: 'plus', cls: 'small' }),
          button('Steep roof face (mansard)', { act: 'add-plane', data: { kind: 'steep' }, icon: 'plus', cls: 'small' })),
        h('p', { class: 'hint' }, 'Measure each wall on its own surface. A roof slope starts from its eave on a wall; the ground starts from the bottom of a wall. A steep roof face is the near-upright shingled part of a mansard roof.'),
      ], { key: 'surfaces' }));

      const pl = ctx.activePlane;
      if (pl) kids.push(planeEditor(ctx, pl, sols[pl.id]));
      kids.push(pitchSection(ctx));
      return kids;
    }

    function planeEditor(ctx, pl, sol) {
      const { fmt, config, plan } = ctx;
      const conf = planeConfidence(ctx, sol);
      const K = ctx.image ? plan.measured.cameras[ctx.image.id] : null;
      const parent = pl.derived ? byId(ctx.project.planes, pl.derived.parentPlaneId) : null;
      const sk = surfaceKind(ctx.project, pl);
      const wall = actionsModule.wallOfPlane(ctx.project, pl);
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
      // How the lens was worked out, in words (the focal length in pixels is on the Upload step for those who want it).
      if (K && K.ok !== false) statusRows.push(['Lens', lensWords(K.label)]);
      if (sk === 'steep') {
        // A steep face is told by its angle from level, never as a rise over 12.
        const text = steepSlopeText(sol && sol.pitch ? sol.pitch : storedSteepPitch(pl.derived));
        if (text) statusRows.push(['Slope', text]);
      } else if (pl.kind === 'roof' && sol && sol.pitch) {
        statusRows.push(['Pitch', sol.pitch.rise + '/' + sol.pitch.run + (sol.pitch.source === 'estimated' ? ' (estimated)' : sol.pitch.source === 'default' ? ' (assumed)' : sol.pitch.source === 'house' ? ' (borrowed from the house, not measured here)' : '')]);
      }
      // The scale came from a measured rectangle other than the one marked as the wall's corners: say so, once.
      const scaleText = pl.kind === 'wall' ? scaleLine(sol) : null;
      kids.push(h('div', { class: 'status-card' }, dl(statusRows),
        scaleText ? h('p', { class: 'scale-line', 'data-key': 'scale-line' }, icon('ruler'), h('span', null, scaleText)) : null,
        conf ? confidenceBlock(conf, 'plane-conf-' + pl.id) : null));
      const zoomWhy = zoomedOutReason(conf);
      if (zoomWhy) kids.push(callout('warn', zoomWhy, { key: 'zoomed-out' }));

      if (pl.kind === 'wall') {
        kids.push(rectEditor(ctx, pl, sol));
        kids.push(refEditor(ctx, pl, sol));
      } else {
        const what = sk === 'steep' ? 'the bottom line' : sk === 'upper' ? 'the trim line' : pl.kind === 'roof' ? 'eave line' : 'wall base line';
        if (sk === 'steep') kids.push(steepEditor(ctx, pl, sol));
        else if (pl.kind === 'roof') {
          const pp = pl.derived && pl.derived.pitch;
          const housePitch = plan.measured.pitch;
          const houseText = 'Same as the house (' + housePitch.rise + '/' + housePitch.run + (housePitch.source === 'estimated' ? ', estimated' : housePitch.source === 'default' ? ', assumed' : '') + ')';
          const opts = [['', houseText]].concat(pitchOptions());
          const val = pp ? pitchValue(pp) : '';
          if (pp && !opts.some((o) => o[0] === val)) opts.push([val, pp.rise + '/' + pp.run]);
          if (sk === 'upper') {
            // The top of a mansard is rarely as steep as the rest of the house, so the house pitch is only borrowed.
            opts[0] = ['', 'Borrow the house pitch (' + housePitch.rise + '/' + housePitch.run + ')'];
            kids.push(h('div', { class: 'sub', 'data-key': 'upper-pitch' },
              field('Pitch of this upper roof', selectInput({ act: 'plane-pitch', value: val, options: opts, data: { id: pl.id } })),
              h('p', { class: 'hint' }, pp ? 'Lengths on this roof use this pitch.'
                : 'The top of a mansard is usually flatter than the rest of the house. Pick its own pitch if you know it. Until then lengths on this roof are rated Low.')));
          } else {
            kids.push(field('Pitch of this slope', selectInput({ act: 'plane-pitch', value: val, options: opts, data: { id: pl.id } })));
          }
        }
        kids.push(h('div', { class: 'btn-row' }, button('Redraw ' + what, { act: 'redraw-line', data: { id: pl.id }, icon: 'ruler', cls: 'small' })));
        if (sk === 'steep') {
          // The shallow roof above a steep face starts where the face ends: offer it here, once.
          const upper = ctx.project.planes.filter((x) => x && x.derived && x.derived.parentPlaneId === pl.id);
          if (upper.length) {
            kids.push(h('p', { class: 'ok-line', 'data-key': 'upper-there' }, icon('check'), h('span', null, 'The upper roof above this face is \'' + upper[0].name + '\'.')));
          } else {
            kids.push(h('div', { class: 'sub', 'data-key': 'upper-offer' }, h('h4', null, 'The roof above this face'),
              h('p', { class: 'hint' }, 'To measure the top edge of the house, add the upper roof. You mark where this face ends, along the trim line at its top.'),
              h('div', { class: 'btn-row' }, button('Add the upper roof', { act: 'add-plane', data: { kind: 'upper', parent: pl.id }, icon: 'plus' }))));
          }
        }
        if (sk === 'upper' && parent) {
          kids.push(h('p', { class: 'hint' }, 'Starts where \'' + parent.name + '\' ends. From the street this roof is seen almost edge-on, so lengths on it are rough. Tape-measure the ones that matter.'));
        } else if (parent) {
          kids.push(h('p', { class: 'hint' }, 'Built from \'' + parent.name + '\'. Its accuracy depends on ' + (wall && wall.id !== parent.id ? "the rectangle on '" + wall.name + "'." : 'that wall\'s rectangle.')));
        }
      }
      const issues = sol ? arr(sol.warnings).filter((w) => !/disagree/i.test(w)) : [];
      for (const w of issues) kids.push(callout('warn', w, { key: 'pw-' + hashKey(w) }));
      // Notes explain how the plane was solved (e.g. separate horizontal/vertical scales, a promoted rectangle).
      for (const n of sol ? arr(sol.notes) : []) { if (!(scaleText && isScaleNote(n))) kids.push(callout('info', n, { key: 'pn-' + hashKey(n) })); }
      return section(pl.name || 'Surface', kids, { key: 'plane-' + pl.id, cls: 'plane-editor' });
    }

    /**
     * "How steep is it?" for a steep roof face: a typical angle (a guess, 70° to start with), or two tape numbers
     * (how far the face goes up, how far it goes back, its sloped height), which measure.steepFromTape turns into
     * the angle. Only typed tape numbers are stored as measured.
     */
    function steepEditor(ctx, pl, sol) {
      const d = pl.derived || {};
      const measured = !!(d.pitch && d.pitch.rise > 0 && d.pitch.run > 0);
      const lim = measure.STEEP || { defaultDeg: 70, minDeg: 20, maxDeg: 85 };
      const guess = measured ? null : Math.round(isNum(d.angleDeg) ? Math.max(lim.minDeg, Math.min(lim.maxDeg, d.angleDeg)) : lim.defaultDeg);
      const angles = actionsModule.STEEP_ANGLES.slice();
      if (guess != null && !angles.includes(guess)) { angles.push(guess); angles.sort((a, b) => a - b); }
      const chips = angles.map((a) => h('button', {
        type: 'button', class: 'chip angle-chip' + (a === guess ? ' on' : ''), 'aria-pressed': String(a === guess),
        data: { act: 'steep-angle', id: pl.id, deg: a }, 'aria-label': a + ' degrees from level',
      }, h('span', null, a + '°')));
      // The tape fields show what is being typed (kept in local.steep through re-renders), else the stored numbers.
      const draft = ctx.local && ctx.local.steep && ctx.local.steep.planeId === pl.id ? ctx.local.steep : null;
      const shown = (ctx.local && ctx.local.steepShown && ctx.local.steepShown[pl.id]) || ['up', 'back'];
      const stored = measured ? { up: d.pitch.rise, back: d.pitch.run, slope: Math.hypot(d.pitch.rise, d.pitch.run) } : null;
      const val = (k) => (draft ? draft[k] || '' : stored && shown.includes(k) ? ctx.fmt(stored[k]) : '');
      const tape = (k, label, ph) => field(label, textInput({ act: 'steep-tape', value: val(k), placeholder: stored && !draft && !shown.includes(k) ? ctx.fmt(stored[k]) : ph, data: { id: pl.id, field: k } }));
      const angle = sol && sol.pitch && isNum(sol.pitch.angleDeg) ? sol.pitch.angleDeg : null;
      const wall = actionsModule.wallOfPlane(ctx.project, pl);
      const wallName = wall && wall.name ? "'" + wall.name + "'" : 'its wall';
      const stillRough = !!(sol && sol.ok && sol.confidence && sol.confidence.level === 'low' && isNum(sol.uncertaintyPct) && sol.uncertaintyPct > 6);
      return h('div', { class: 'sub steep-editor', 'data-key': 'steep' },
        h('h4', null, 'How steep is it?'),
        h('p', { class: 'hint' }, 'Pick the closest angle, counted up from level ground. Most mansard faces are near 70°. A picked angle is a guess, so lengths on this face are rated Low. Measuring it makes them more exact.'),
        h('div', { class: 'angle-row', role: 'group', 'aria-label': 'Typical angles' }, chips),
        h('h4', null, 'I measured it'),
        h('p', { class: 'hint' }, 'Tape-measure two of these and LightPlan works out the angle: how far the face goes straight up, how far it leans back, or its sloped height.'),
        h('div', { class: 'row-3' },
          tape('up', 'Up', 'e.g. 8\''),
          tape('back', 'Back', 'e.g. 3\''),
          tape('slope', 'Sloped height', 'e.g. 8\' 6"')),
        h('div', { class: 'btn-row' }, button('Use these numbers', { act: 'steep-use', data: { id: pl.id }, icon: 'ruler' })),
        measured && angle != null
          ? h('p', { class: 'ok-line', 'data-key': 'steep-result' }, icon('check'), h('span', null, 'Measured: ' + actionsModule.steepAngleText(angle) + ' from level (' + ctx.fmt(stored.up) + ' up, ' + ctx.fmt(stored.back) + ' back, ' + ctx.fmt(stored.slope) + ' along the slope).'))
          : h('p', { class: 'hint', 'data-key': 'steep-result' }, 'Using ' + guess + '° from level. This is a guess.'),
        // Up shorter than Back is possible, but far more often the two numbers were typed the wrong way round.
        measured && stored.up < stored.back
          ? callout('warn', 'Up is shorter than Back, so this face leans back more than it rises. Are the two numbers swapped?', {
            key: 'steep-swap', after: h('div', { class: 'btn-row' }, button('Swap Up and Back', { act: 'steep-swap', data: { id: pl.id }, cls: 'small' })),
          }) : null,
        // Measured, yet still rated Low: the limit is the wall's scale, which this editor cannot change.
        measured && stillRough ? h('p', { class: 'hint', 'data-key': 'steep-still-rough' }, 'Lengths on this face are still rated Low, because the scale of ' + wallName + ' is rough. A larger measured rectangle on that wall would lift them.') : null);
    }

    function rectEditor(ctx, pl, sol) {
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
        // Another measured rectangle sets the scale (measure: calib.rectAuto): this one only checks it.
        if (sol && sol.ok && sol.calib && sol.calib.rectAuto) text += ' Used as a check: a larger measured rectangle sets the scale.';
        kids.push(h('p', { class: 'ok-line' }, icon('check'), h('span', null, text)));
        if (!rect.widthFt && !pl.refs.length) kids.push(callout('info', 'The size is unknown, so add at least one reference length below to set the scale.'));
      }
      kids.push(h('div', { class: 'btn-row' },
        button(rect ? 'Mark corners again' : 'Mark 4 corners', { act: 'mark-rect', data: { id: pl.id }, icon: 'corners', cls: rect ? '' : 'primary' }),
        rect ? button('Remove', { act: 'remove-rect', data: { id: pl.id }, cls: 'ghost' }) : null));
      return h('div', { class: 'sub', 'data-key': 'rect' }, h('h4', null, 'The 4 corners of a rectangle'),
        h('p', { class: 'hint' }, 'Four corners of anything truly rectangular on this wall (the wall itself, a garage door, a door). Seeing how it is skewed in the photo is how LightPlan un-tilts the picture. This is also called a perspective rectangle.'),
        kids);
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
      // Never disabled: a tap on a disabled button is lost when it is also the tap that commits the typed length.
      // The click handler reads the fields' live values and explains what is missing.
      kids.push(h('div', { class: 'btn-row' }, button(preset.kind === 'rect' ? 'Draw (4 corners)' : 'Draw (2 ends)', { act: 'draw-ref', data: { id: pl.id }, icon: preset.kind === 'rect' ? 'corners' : 'ruler' })));

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
          err == null ? h('span', { class: 'err-badge none' }, r || (sol && sol.promotedRefId === ref.id) ? 'sets scale' : '—')
            : h('span', { class: 'err-badge ' + cls, title: 'Measured minus expected' }, signedPct(err)),
          iconButton('trash', 'Delete reference ' + label, { act: 'delete-ref', data: { id: ref.id, plane: pl.id }, cls: 'small' }));
      });
      // The wall's own rectangle, when another one sets the scale: it is checked like a reference (not deletable here).
      for (const r of arr(sol && sol.refResults).filter((x) => x && x.fromRect)) {
        const err = isNum(r.errorPct) ? r.errorPct : null;
        const cls = err == null ? 'none' : Math.abs(err) < 2 ? 'ok' : Math.abs(err) <= warnPct ? 'warn' : 'danger';
        items.push(h('li', { class: 'ref-item own-rect', 'data-key': 'own-' + hashKey(String(r.label)) },
          h('div', { class: 'ref-main' },
            h('span', { class: 'ref-label' }, r.label || 'The wall rectangle'),
            h('span', { class: 'ref-nums num' }, 'Expected ' + ctx.fmt(r.expectedFt) + ' · measured ' + ctx.fmt(r.measuredFt))),
          h('span', { class: 'err-badge ' + cls, title: 'Measured minus expected' }, err == null ? 'check' : signedPct(err))));
      }
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
          field('Surface to trace on', selectInput({ act: 'active-plane', value: ctx.activePlane ? ctx.activePlane.id : '', options: planes.map((p) => [p.id, surfaceOptionLabel(ctx.project, p)]) })),
          toggle('Snap', { act: 'view-toggle', data: { key: 'snap' }, checked: ui.view.snap })),
        h('p', { class: 'hint' }, 'Lines: tap each corner, then Finish or double-tap. Windows and bushes: tap around and tap the first point to close. Trees and columns: tap the base, then the top.'),
        h('p', { class: 'hint', 'data-key': 'rake-note' }, RAKE_NOTE),
        planes.some((p) => surfaceKind(ctx.project, p) === 'steep') ? h('p', { class: 'hint', 'data-key': 'mansard-note' }, MANSARD_NOTE) : null,
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
      return kids;
    }

    function featureEditor(ctx, f, m) {
      const ft = FEATURE_TYPES[f.type] || {};
      const cfg = ctx.config;
      const kids = [];
      // The short names (the same words as the "What to light" buttons) fit the half-width picker whole.
      kids.push(h('div', { class: 'row-2' },
        field('Label', textInput({ act: 'feature-field', value: f.label, data: { id: f.id, field: 'label' }, maxlength: 80 })),
        field('Type', selectInput({ act: 'feature-type', value: f.type, options: TYPE_ORDER.map((t) => [t, FEATURE_TYPES[t].short]), data: { id: f.id } }))));
      kids.push(field('Surface', selectInput({ act: 'feature-plane', value: f.planeId || '', options: [['', 'None']].concat(ctx.planes.map((p) => [p.id, surfaceOptionLabel(ctx.project, p)])), data: { id: f.id } })));
      const fpl = byId(ctx.planes, f.planeId);
      const kinds = actionsModule.KINDS_FOR_TYPE && actionsModule.KINDS_FOR_TYPE[f.type];
      // A ridge drawn on a wall comes out too short: offer the two fixes right on its card while that stands.
      if (needsRoof(f, m)) {
        const item = ctx.misplaced()[f.id] || null;
        kids.push(callout('warn', wrongSurfaceWhy(item) || 'A ridge sits on the roof, behind the wall. Measured on the wall it comes out too short.', {
          key: 'ws-' + f.id,
          after: [h('div', { class: 'btn-row wrap' },
            button('Put it on the roof', { act: 'put-on-roof', data: { id: f.id }, cls: 'small primary' }),
            button('Type its length', { act: 'type-length', data: { id: f.id }, cls: 'small' })),
          h('p', { class: 'hint' }, roofFixNote(ctx.project, f, item))],
        }));
      }
      // Drawn below the line where its roof starts: it sits on the surface under that roof.
      if (needsLower(f, m)) {
        const item = ctx.misplaced()[f.id] || null;
        const to = lowerTarget(ctx.project, f, item);
        kids.push(callout('warn', 'This item is drawn below the line where \'' + (fpl ? fpl.name : 'this roof') + '\' starts, so it is not on that roof and its length is wrong.', {
          key: 'bl-' + f.id,
          after: [h('div', { class: 'btn-row wrap' },
            to ? button('Put it on \'' + (to.name || 'the surface below') + '\'', { act: 'put-on-plane', data: { id: f.id, plane: to.planeId }, cls: 'small primary' }) : null,
            button('Type its length', { act: 'type-length', data: { id: f.id }, cls: 'small' }))],
        }));
      }
      if (fpl && kinds && !actionsModule.typeFitsSurface(ctx.project, f.type, fpl)) {
        kids.push(callout('warn', 'This ' + (ft.short || 'item').toLowerCase() + ' is measured on \'' + fpl.name + '\' (' + (SURFACE_LABEL[surfaceKind(ctx.project, fpl)] || fpl.kind).toLowerCase() +
          '), so its length is likely wrong. Pick the ' + (kinds[0] === 'ground' ? 'ground' : kinds[0] === 'roof' ? 'roof slope' : 'wall') + ' it is on.', { key: 'fk-' + f.id }));
      }
      // Points: the one last pressed on the photo can be deleted; tap a + between two points on the photo to add one.
      const av = ctx.ui.activeVertex;
      const vi = av && av.featureId === f.id && Number.isInteger(av.index) && av.index < f.points.length ? av.index : null;
      kids.push(h('div', { class: 'btn-row wrap point-row' },
        button(vi != null ? 'Delete point ' + (vi + 1) : 'Delete point', { act: 'delete-vertex', data: { id: f.id, index: vi == null ? '' : vi }, icon: 'close', cls: 'small', disabled: vi == null }),
        button('Delete ' + (f.label || 'item'), { act: 'delete-feature', data: { id: f.id }, icon: 'trash', cls: 'danger ghost small' })));
      kids.push(h('p', { class: 'hint' }, vi != null ? 'Point ' + (vi + 1) + ' is picked. Drag the points on the photo, or tap a + between two of them to add a point.'
        : 'Drag the points on the photo. Press one to pick it for Delete point, or tap a + between two points to add one.'));

      if (m && m.ok) {
        const rows = [];
        if (f.type === 'bush') {
          rows.push(['Size', ctx.fmt(m.widthFt) + ' wide × ' + ctx.fmt(m.heightFt) + ' tall', 'num']);
          const rule = bushRuleText(cfg);
          rows.push(['Lights', plural(m.lights, 'light', 'lights') + ' by the rule of thumb' + (rule ? ' (' + rule + ')' : ''), 'num']);
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
        const zoomWhy = zoomedOutReason(m.confidence);
        if (zoomWhy) kids.push(callout('warn', zoomWhy, { key: 'zoomed-out-' + f.id }));
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

    // ================================================================ suppliers and buying (SPEC §8.3, §8.5)
    const GENERIC = suppliers.GENERIC_ID;
    const safeUrl = suppliers.safeUrl;
    const exportModule = () => (typeof LP !== 'undefined' && LP.has('ui.export') ? LP.require('ui.export') : null);

    /** One option of a product picker: the name, then the part number and price ("… · part number 77667 · $49.99"). */
    function productOptionText(p) {
      const bits = [p.name || p.id];
      if (p.kind === 'bulk') {
        // A cut-to-length product is a kit: it has no part number of its own, and its per-foot figure is worked out.
        bits.push('sold as parts');
        if (isNum(p.price)) bits.push('about ' + money(p.price) + ' per ft');
      } else {
        if (p.supplierSku) bits.push('part number ' + p.supplierSku);
        if (isNum(p.price)) bits.push(money(p.price) + (p.unit === 'foot' ? ' per ft' : ''));
      }
      return bits.join(' · ');
    }
    /**
     * The options of a run's product picker, grouped by where the product is bought: the chosen supplier first,
     * then "Any store", then the other suppliers. → [{ supplierId, label, options: [[id, text]] }]
     */
    function productGroups(products, library) {
      const lib = library || {};
      const known = arr(lib.suppliers).filter((x) => x && x.id);
      const chosen = lib.supplierId && lib.supplierId !== GENERIC && known.some((x) => x.id === lib.supplierId) ? lib.supplierId : null;
      const nameOf = (id) => { const x = known.find((k) => k.id === id); return x ? x.name : id; };
      const order = (chosen ? [chosen] : []).concat([GENERIC]);
      for (const x of known) if (!order.includes(x.id)) order.push(x.id);
      const byWhere = new Map();
      for (const p of arr(products)) {
        if (!p || !p.id) continue;
        const where = catalog.isSupplierProduct(p) ? p.supplierId : GENERIC;
        if (!byWhere.has(where)) byWhere.set(where, []);
        byWhere.get(where).push([p.id, productOptionText(p)]);
      }
      const out = [];
      for (const id of order.concat(Array.from(byWhere.keys()).filter((k) => !order.includes(k)))) {
        if (byWhere.has(id)) out.push({ supplierId: id, label: id === GENERIC ? 'Any store' : nameOf(id), options: byWhere.get(id) });
      }
      return out;
    }
    /** The supplier whose site a link is on, by host name; null for a link to anywhere else. */
    function supplierOfUrl(library, url) {
      const words = exportModule();
      const host = words ? words.hostOf(url) : '';
      if (!host) return null;
      return arr(library && library.suppliers).find((x) => x && x.url && words.hostOf(x.url) === host) || null;
    }
    /**
     * A product list ready to save in the project. A supplier's catalog entries are kept only when at least one of
     * them was changed: catalog.getLibrary adds the untouched ones back in their own order, so a later catalog
     * update still reaches the project and an unchanged price is never mistaken for the user's own.
     */
    function productsToSave(list) {
      const fresh = new Map(suppliers.SUPPLIER_PRODUCTS.map((p) => [p.id, JSON.stringify(p)]));
      const touched = new Set();
      for (const p of arr(list)) if (p && fresh.has(p.id) && JSON.stringify(p) !== fresh.get(p.id)) touched.add(p.supplierId);
      return arr(list).filter((p) => !(p && fresh.has(p.id) && !touched.has(p.supplierId)));
    }
    /** "100 lights for every 1.5 ft of height and every 3 ft of width": the bush rule of thumb as the settings hold it. */
    function bushRuleText(config) {
      const b = (config && config.bush) || {};
      const ft = (v) => trimNum(v, 2) + ' ft';
      if (!(isNum(b.lightsPerUnit) && isNum(b.heightUnitFt) && isNum(b.widthUnitFt))) return '';
      return fmtNum(b.lightsPerUnit, 0) + ' lights for every ' + ft(b.heightUnitFt) + ' of height and every ' + ft(b.widthUnitFt) + ' of width';
    }

    /**
     * Put text on the clipboard. Resolves true when the browser says it did: the clipboard API first, then the
     * older select-and-copy command for views where the API is not allowed. Never rejects, never throws.
     */
    function writeClipboard(text) {
      return new Promise((resolve) => {
        const older = () => {
          let ok = false;
          let ta = null;
          try {
            ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.setAttribute('aria-hidden', 'true');
            ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
            const before = document.activeElement;
            (document.body || document.documentElement).appendChild(ta);
            ta.focus({ preventScroll: true });
            ta.select();
            ok = document.execCommand('copy') === true;
            if (before && typeof before.focus === 'function') before.focus({ preventScroll: true });
          } catch (e) {
            ok = false;
          }
          // The helper field never stays in the page, whatever happened above.
          try { if (ta && ta.parentNode) ta.parentNode.removeChild(ta); } catch (e) { /* ignore */ }
          resolve(ok);
        };
        try {
          const cb = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null;
          if (cb && typeof cb.writeText === 'function') { Promise.resolve(cb.writeText(text)).then(() => resolve(true), older); return; }
        } catch (e) { /* fall through to the older way */ }
        older();
      });
    }

    /** The small label beside a price: "as of Nov 11, 2026 · checked", "… · check price", "your price", "typical price". */
    function priceBadge(status) {
      if (!status || !status.text) return null;
      return h('span', { class: 'badge price-' + status.kind, 'data-status': status.kind }, status.text);
    }
    /** What was copied but could not reach the clipboard: shown selected in a read-only field so it can be copied by hand. */
    function copyFallback(copied) {
      const attrs = { class: 'input copy-field', readonly: true, value: copied.text, 'aria-label': 'Text to copy', data: { 'copy-field': copied.key, fk: 'copy:' + copied.key } };
      return h('div', { class: 'copy-fallback', 'data-key': 'copy-' + copied.key },
        h('p', { class: 'hint' }, 'Copying is blocked in this view. It is selected below: press and hold it, or press Ctrl+C, to copy.'),
        copied.multiline ? h('textarea', Object.assign({ rows: 6 }, attrs)) : h('input', Object.assign({ type: 'text' }, attrs)),
        h('div', { class: 'btn-row' }, button('Done', { act: 'copy-close', cls: 'small ghost' })));
    }
    /**
     * A link that opens in a new tab, with a "Copy link" button beside it: the viewer may refuse to open links, and a
     * copied address always works. `key` is unique in the panel (it says which button was pressed).
     */
    function linkRow(ctx, url, label, key, o) {
      const u = safeUrl(url);
      if (!u) return null;
      const opts = o || {};
      const copied = ctx.local.copy && ctx.local.copy.key === key ? ctx.local.copy : null;
      return h('div', { class: 'link-row' + (opts.cls ? ' ' + opts.cls : ''), 'data-key': 'lr-' + key },
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn small link-btn', href: u, target: '_blank', rel: 'noopener noreferrer', 'aria-label': opts.aria || null, 'data-link': opts.kind || 'open' },
            icon('external'), h('span', null, label)),
          button(copied && copied.ok ? 'Copied' : 'Copy link', { act: 'copy-link', data: { url: u, key }, icon: copied && copied.ok ? 'check' : 'copy', cls: 'small ghost',
            aria: 'Copy the link' + (opts.aria ? ': ' + opts.aria : '') })),
        copied && !copied.ok ? copyFallback(copied) : null);
    }
    /** Two or three choices of which one is on (a radio group drawn as full-width buttons with an optional second line). */
    function choiceList(labelText, labelId, choices) {
      return h('div', { class: 'choice-block' },
        h('p', { class: 'field-label', id: labelId }, labelText),
        h('div', { class: 'choice-list', role: 'group', 'aria-labelledby': labelId }, choices.map((c) => h('button', {
          type: 'button', class: 'choice' + (c.on ? ' on' : ''), 'aria-pressed': String(!!c.on), data: Object.assign({ act: c.act }, c.data || {}),
        }, h('span', { class: 'choice-dot', 'aria-hidden': 'true' }), h('span', { class: 'choice-text' }, h('span', { class: 'choice-title' }, c.title), c.sub ? h('span', { class: 'choice-sub' }, c.sub) : null)))));
    }

    /**
     * "Buy from" at the top of the Design step: Any store or a supplier. A supplier brings its site, what its pages say
     * about business accounts, one sentence about its prices, and how its C7 and C9 are bought.
     */
    function buyFromSection(ctx) {
      const { plan, project } = ctx;
      const lib = plan.library;
      const words = exportModule();
      const chosenId = lib.supplierId || GENERIC;
      const chips = arr(lib.suppliers).filter((x) => x && x.id).map((x) => {
        const on = x.id === chosenId;
        // A short name keeps to one line; on a narrow panel only a long one wraps inside its chip.
        return h('button', { type: 'button', class: 'chip buy-chip' + (String(x.name).length <= 12 ? ' short' : '') + (on ? ' on' : ''), 'aria-pressed': String(on), data: { act: 'supplier', id: x.id } }, h('span', null, x.name));
      });
      const kids = [h('div', { class: 'chip-row buy-row', role: 'group', 'aria-label': 'Buy from' }, chips)];
      const facts = words ? words.supplierFacts(lib, chosenId) : null;
      if (!facts) return section('Buy from', kids, { key: 'buy-from' });
      if (facts.generic) {
        kids.push(h('p', { class: 'hint', 'data-key': 'buy-note' }, facts.notes + ' Choose a supplier to plan with its products, part numbers, prices and links.'));
        return section('Buy from', kids, { key: 'buy-from' });
      }
      const items = words.supplierItems(lib, facts.id, project.pricing && project.pricing.overrides);
      const w = facts.wholesale;
      const runs = arr(plan.runs).filter((r) => r && r.productId);
      const own = runs.filter((r) => r.supplierId === facts.id).length;
      const rest = runs.length - own;
      const runsText = !runs.length ? '' : plural(own, 'run uses', 'runs use') + ' its products.' +
        (rest ? ' ' + (rest === 1 ? 'The other one has' : 'The other ' + fmtNum(rest, 0) + ' have') + ' nothing on file there (or a product you picked yourself) and ' + (rest === 1 ? 'stays' : 'stay') + ' as planned.' : '');
      kids.push(h('div', { class: 'sup-card', 'data-key': 'sup-' + facts.id, 'data-supplier': facts.id },
        h('p', { class: 'sup-name' }, h('strong', null, facts.name), facts.host ? h('span', { class: 'sup-host' }, facts.host) : null),
        linkRow(ctx, facts.url, 'Open the site', 'site-' + facts.id, { aria: facts.name + ' site', kind: 'site' }),
        h('p', { class: 'sup-prices', 'data-key': 'sup-prices' }, words.priceSentence(items)),
        runsText ? h('p', { class: 'hint', 'data-key': 'sup-runs' }, runsText) : null,
        w ? h('div', { class: 'sup-account', 'data-key': 'sup-account' },
          h('p', { class: 'field-label' }, 'Business or wholesale account'),
          w.name ? h('p', { class: 'sup-account-name' }, w.name) : null,
          dl([w.phone ? ['Phone', w.phone, 'num'] : null, w.email ? ['Email', w.email] : null]),
          w.url ? linkRow(ctx, w.url, 'Wholesale page', 'whole-' + facts.id, { aria: facts.name + ' wholesale page', kind: 'wholesale' }) : null,
          w.note ? h('p', { class: 'hint' }, w.note) : null) : null));
      const style = lib.config.buying && lib.config.buying.style === 'strings' ? 'strings' : 'bulk';
      // What "cut-to-length" is ordered as, said once here instead of on every run card.
      const bulkUsed = arr(plan.runs).map((r) => (r && r.productKind === 'bulk' ? catalog.getProduct(lib.products, r.productId) : null)).find(Boolean);
      const bulkWords = bulkUsed ? words.describeBulk(bulkUsed, project.pricing && project.pricing.overrides) : null;
      kids.push(h('div', { 'data-key': 'buy-style' }, choiceList('C7 and C9 as', 'buy-style-label', [
        { title: 'Cut-to-length wire + bulbs', sub: 'How installers buy: wire by the spool, bulbs by the box, cut to fit each run.', on: style === 'bulk', act: 'buy-style', data: { style: 'bulk' } },
        { title: 'Ready-made strings', sub: 'Ready to hang. A run uses whole strings, so some length is left over.', on: style === 'strings', act: 'buy-style', data: { style: 'strings' } },
      ]), bulkWords ? h('p', { class: 'hint', 'data-key': 'bulk-what' }, bulkWords.summary + (bulkWords.limit ? ' ' + bulkWords.limit : '')) : null));
      return section('Buy from', kids, { key: 'buy-from' });
    }

    /**
     * Under a run's product picker: where its product is bought. A supplier's product shows the part number, price,
     * how fresh the price is and a link. A cut-to-length product says what is ordered (wire, bulbs, plugs), its limit
     * and the status of every part; the kit itself has no part number, so it is never marked "check price".
     * An any-store product, when a supplier is chosen, gets a link to where that supplier keeps such things.
     */
    function productInfo(ctx, run) {
      const lib = ctx.plan.library;
      const words = exportModule();
      const p = catalog.getProduct(lib.products, run.productId);
      if (!p || !words) return null;
      const overrides = ctx.project.pricing && ctx.project.pricing.overrides;
      const key = 'run-' + run.id;
      if (!catalog.isSupplierProduct(p)) {
        // The shopping-list line for this product carries the link to look for it at the chosen supplier.
        const line = arr(ctx.plan.bom.lines).find((l) => l.sku === (p.sku || p.id) && safeUrl(l.findUrl));
        const at = line ? supplierOfUrl(lib, line.findUrl) : null;
        if (!line || !at) return null;
        const chosen = words.supplierFacts(lib, at.id);
        return h('div', { class: 'prod-info', 'data-key': 'pi-' + run.id, 'data-supplier': GENERIC },
          h('p', { class: 'prod-from' }, 'Any store. No part number on file at ' + at.name + ' for this.'),
          linkRow(ctx, line.findUrl, 'Find at ' + at.name, key, { aria: 'Look for ' + p.name + ' at ' + at.name, kind: 'find' }),
          words.isUncheckedSearch(chosen, line.findUrl) ? h('p', { class: 'hint small' }, 'This link searches the site. ' + chosen.searchNote) : null);
      }
      const sup = arr(lib.suppliers).find((x) => x && x.id === p.supplierId);
      const supName = sup ? sup.name : p.supplierId;
      const bulk = words.describeBulk(p, overrides);
      if (bulk) {
        const groupTitle = { wire: 'Socket wire', bulb: 'Bulbs', plug: 'Slide-on plugs' };
        const rows = [];
        let last = null;
        for (const part of bulk.parts) {
          if (part.group !== last) { rows.push(h('li', { class: 'part-group', 'data-key': 'pg-' + part.group }, groupTitle[part.group] || part.group)); last = part.group; }
          rows.push(h('li', { class: 'part-row', 'data-key': 'pp-' + part.sku, 'data-status': part.status.kind },
            h('p', { class: 'part-label' }, h('strong', null, part.label), isNum(part.price) ? h('span', { class: 'num' }, money(part.price)) : null),
            h('p', { class: 'part-meta' }, part.supplierSku ? h('span', null, 'part number ', h('span', { class: 'num' }, part.supplierSku)) : h('span', null, 'no part number on file'), priceBadge(part.status)),
            part.note ? h('p', { class: 'hint small' }, part.note) : null,
            linkRow(ctx, part.url, 'Open', 'part-' + run.id + '-' + part.sku, { aria: part.name + ' at ' + supName, kind: 'part' })));
        }
        return h('div', { class: 'prod-info bulk', 'data-key': 'pi-' + run.id, 'data-supplier': p.supplierId, 'data-kind': 'bulk' },
          h('p', { class: 'prod-from' }, h('strong', null, supName), ' · sold as parts' + (bulk.perFoot ? ' · ' + bulk.perFoot : '')),
          h('p', { class: 'prod-what' }, bulk.short || bulk.summary),
          h('p', { class: 'prod-prices' }, bulk.statuses.map((st) => priceBadge(st))),
          h('details', { class: 'disclosure parts', 'data-key': 'parts-' + run.id },
            h('summary', null, h('span', null, 'Parts and part numbers (' + bulk.parts.length + ')'), icon('chevronDown', 'chev')),
            h('div', { class: 'disclosure-body' },
              h('p', { class: 'hint small' }, 'Every size and colour on file. The shopping list in step 6 picks the ones this plan needs.'),
              h('ul', { class: 'part-list' }, rows))));
      }
      const priced = words.pricedAs(p, overrides);
      const status = words.priceStatusLabel(priced);
      return h('div', { class: 'prod-info', 'data-key': 'pi-' + run.id, 'data-supplier': p.supplierId, 'data-status': status.kind },
        h('p', { class: 'prod-from line' }, h('strong', null, supName),
          p.supplierSku ? h('span', null, 'part number ', h('span', { class: 'num' }, String(p.supplierSku))) : h('span', null, 'no part number on file'),
          isNum(priced.price) ? h('span', { class: 'num' }, money(priced.price)) : null, priceBadge(status)),
        p.orderNote ? h('p', { class: 'hint small' }, p.orderNote) : null,
        linkRow(ctx, p.url, 'Open at ' + supName, key, { aria: p.name + ' at ' + supName, kind: 'product' }));
    }

    // ================================================================ step 4: Design
    function stepDesign(ctx) {
      const { ui, project, plan, image } = ctx;
      const kids = [head(4, 'Say who you buy from, and LightPlan picks a product for each run. Change any of them here.')];
      if (!image) {
        kids.push(callout('info', 'Add a photo first.', { after: button('Go to Upload', { act: 'go-step', data: { step: 1 }, cls: 'small' }) }));
        return kids;
      }
      kids.push(buyFromSection(ctx));
      kids.push(section('Preview', [h('div', { class: 'btn-row wrap' },
        button(ui.view.preview ? 'Lights on' : 'Lights off', { act: 'view-flip', data: { key: 'preview' }, pressed: ui.view.preview, icon: 'bulb', cls: 'small' }),
        // Night and twinkle only show with the lights on, so they read as pressed only then (as on the canvas).
        button(ui.view.night && ui.view.preview ? 'Night' : 'Day', { act: 'view-flip', data: { key: 'night' }, pressed: ui.view.night && ui.view.preview, icon: ui.view.night && ui.view.preview ? 'moon' : 'sun', cls: 'small' }),
        button('Twinkle', { act: 'view-flip', data: { key: 'twinkle' }, pressed: ui.view.twinkle && ui.view.preview, icon: 'sparkle', cls: 'small' }))], { key: 'preview' }));

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
        // Every supplier's products are offered, grouped by supplier with the chosen one first (SPEC §8.5).
        const suitable = design.suitableProducts(run.featureType, lib, { allSuppliers: true });
        const auto = design.resolveProduct(Object.assign({}, f, { productId: null }), lib, { colorMode: run.colorMode }).product;
        const groups = productGroups(suitable, lib);
        const extra = [];
        if (f.productId && !suitable.some((p) => p.id === f.productId)) {
          const cur = catalog.getProduct(lib.products, f.productId);
          extra.push([f.productId, (cur ? productOptionText(cur) : f.productId) + (cur && cur.enabled === false ? ' (turned off)' : '')]);
        }
        const houseColor = COLOR_MODES[s.colorMode] ? COLOR_MODES[s.colorMode].label : 'Warm white';
        const colorOptions = [['', 'House color (' + houseColor + ')']].concat(['warmWhite', 'coolWhite', 'multicolor', 'custom'].map((k) => [k, COLOR_MODES[k].label]));
        const qty = run.quantity;
        return h('li', { class: 'run-card', 'data-key': run.id },
          h('div', { class: 'run-head' }, swatch(ft.color, 'dot'), h('span', { class: 'run-label' }, run.label),
            h('span', { class: 'swatches' }, arr(run.colors).slice(0, 5).map((c) => swatch(c)))),
          field('Product', groupedSelect({ act: 'run-product', value: f.productId || '', first: [['', 'Auto: ' + (auto ? auto.name : 'none available')]], groups, last: extra, data: { id: f.id } })),
          // The picker cuts a long name short, so the product in use is written out in full under it.
          run.productName ? h('p', { class: 'run-product', 'data-key': 'pn-' + run.id }, run.productName) : null,
          productInfo(ctx, run),
          field('Color', selectInput({ act: 'run-color', value: f.color ? f.color.mode : '', options: colorOptions, data: { id: f.id } })),
          runControls(ctx, f, run),
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
      return kids;
    }

    /** Clips (mount), forced outlet and direction for one run: the overrides design.js and power.js honour. */
    function runControls(ctx, f, run) {
      const ft = FEATURE_TYPES[f.type] || {};
      const params = f.params || {};
      const kids = [];
      if (catalog.LINEAR_TYPES.includes(f.type)) {
        const def = MOUNT_LABEL[ft.defaultMount] || 'type default';
        const mountOpts = [['', 'Auto: ' + def.toLowerCase()]].concat(MOUNT_OPTIONS);
        kids.push(field('Clips', selectInput({ act: 'run-mount', value: params.mount || '', options: mountOpts, data: { id: f.id } })));
      }
      const outlets = ctx.project.outlets.filter((o) => !ctx.image || o.imageId === ctx.image.id || o.imageId == null);
      if (outlets.length) {
        const opts = [['', 'Auto: nearest']].concat(outlets.map((o) => [o.id, o.label]));
        if (params.outletId && !opts.some((x) => x[0] === params.outletId)) opts.push([params.outletId, 'Missing outlet']);
        kids.push(field('Outlet', selectInput({ act: 'run-outlet', value: params.outletId || '', options: opts, data: { id: f.id } })));
      }
      const open = !(f.closed || ft.geometry === 'polygon' || ft.geometry === 'area' || ft.geometry === 'vertical');
      // One full-width row each, so the choice can be read without opening the picker.
      const grid = kids.length ? h('div', { class: 'run-picks' }, kids) : null;
      const rev = open ? toggle('Start from the other end', { act: 'run-reverse', data: { id: f.id }, checked: params.reverse === true }) : null;
      return grid || rev ? h('div', { class: 'run-controls' }, grid, rev) : null;
    }

    function productEditor(ctx) {
      const local = ctx.local;
      const products = ctx.plan.library.products;
      const custom = !!(ctx.project.library && ctx.project.library.products);
      const supplierName = (id) => { const x = arr(ctx.plan.library.suppliers).find((k) => k && k.id === id); return x ? x.name : id; };
      const rows = products.map((p) => h('li', { class: 'prod-card' + (p.enabled === false ? ' off' : ''), 'data-key': 'p-' + p.id },
        h('div', { class: 'prod-head' },
          toggle('', { act: 'product-enabled', data: { id: p.id }, checked: p.enabled !== false, cls: 'compact', aria: 'Use ' + p.name }),
          textInput({ act: 'product-field', value: p.name, data: { id: p.id, field: 'name' }, aria: 'Name of ' + p.id, cls: 'grow' })),
        catalog.isSupplierProduct(p) ? h('p', { class: 'prod-from' }, supplierName(p.supplierId),
          p.kind === 'bulk' ? ' · sold as parts (wire, bulbs, plugs): change their prices in the shopping list, step 6' : p.supplierSku ? ' · part number ' + p.supplierSku : '') : null,
        h('div', { class: 'prod-grid' },
          p.kind === 'bulk' ? null : field('Price ($)', numInput({ act: 'product-field', value: p.price, min: 0, step: 0.01, data: { id: p.id, field: 'price' } })),
          field('Watts per ' + (p.unit === 'foot' ? 'ft' : p.unit), numInput({ act: 'product-field', value: p.wattsPerUnit, min: 0, step: 0.1, data: { id: p.id, field: 'wattsPerUnit' } })),
          field('Lit length (ft)', numInput({ act: 'product-field', value: p.stringLengthFt, min: 0.1, step: 0.5, data: { id: p.id, field: 'stringLengthFt' } })),
          field('Max end to end', numInput({ act: 'product-field', value: p.maxEndToEnd, min: 1, step: 1, decimals: 0, data: { id: p.id, field: 'maxEndToEnd' } })),
          field('Bulb spacing (in)', numInput({ act: 'product-field', value: p.bulbSpacingIn, min: 0.5, step: 0.5, data: { id: p.id, field: 'bulbSpacingIn' } })),
          field('Bulbs per ' + (p.unit === 'foot' ? 'ft' : p.unit), numInput({ act: 'product-field', value: p.bulbsPerUnit, min: 0, step: 1, decimals: 0, data: { id: p.id, field: 'bulbsPerUnit' } })))));
      const json = local.productDraft != null ? local.productDraft : JSON.stringify(products, null, 2);
      const msg = local.productMsg;
      return disclosure('Product library' + (custom ? ' (edited)' : ''), [
        h('p', { class: 'hint' }, 'Any-store products are typical retail values, not one brand; a supplier\'s products are as its pages listed them. Check the box label and change anything that differs. Turned-off products are not used by the auto-plan.'),
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
    /** The power plan in plain words, cord by cord (ui.export.describeCords); empty when that module is missing. */
    function cordInfo(plan, project) {
      const exp = exportModule();
      return exp && typeof exp.describeCords === 'function' ? exp.describeCords(plan, project) : { outlets: [], loose: [], rows: [] };
    }
    const capFirst = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
    function pctText(share) {
      if (!(share > 0)) return '0%';
      const v = Math.round(share * 100);
      return v < 1 ? 'under 1%' : fmtNum(v, 0) + '%';
    }

    /**
     * The Power step's opening sentence: is the plan safe to plug in, and if not, what to fix first.
     * → {level: 'ok' | 'info' | 'warn' | 'danger', lead: 'Good to go:', text: ' …', more: other problems below}
     */
    function powerVerdict(plan) {
      const pw = (plan && plan.power) || {};
      const runs = arr(plan && plan.runs);
      const total = plan && plan.summary && isNum(plan.summary.watts) ? plan.summary.watts : pw.totals && isNum(pw.totals.watts) ? pw.totals.watts : 0;
      if (!runs.length) return { level: 'info', lead: 'Nothing to power yet:', text: ' trace the lights in step 3 first, then mark an outlet here.', more: 0 };
      const used = arr(pw.outlets).filter((o) => o && arr(o.feedIds).length > 0);
      if (!used.length) {
        return { level: 'warn', lead: 'Place an outlet:', text: ' these lights use ' + watts(total) + '. Tap Place outlet, then tap where the outlet is on the photo.', more: 0 };
      }
      const issues = arr(pw.warnings).filter((w) => w && w.code !== 'disclaimer' && (w.level === 'danger' || w.level === 'warn'));
      const danger = issues.find((w) => w.level === 'danger');
      if (danger) return { level: 'danger', lead: 'Not safe yet:', text: ' ' + danger.message, more: issues.length - 1 };
      if (issues.length) {
        return { level: 'warn', lead: issues.length === 1 ? 'One thing to fix first:' : issues.length + ' things to fix first:', text: ' ' + issues[0].message, more: issues.length - 1 };
      }
      const limit = Math.max.apply(null, used.map((o) => (isNum(o.limitW) && o.limitW > 0 ? o.limitW : 0))) || 1440;
      if (total <= limit) {
        return { level: 'ok', lead: 'Good to go:', text: ' these lights use ' + watts(total) + ', ' + pctText(total / limit) + ' of one outlet\'s safe limit.', more: 0 };
      }
      const busiest = Math.max.apply(null, used.map((o) => (isNum(o.limitW) && o.limitW > 0 && isNum(o.watts) ? o.watts / o.limitW : 0)));
      return {
        level: 'ok', lead: 'Good to go:', more: 0,
        text: ' these lights use ' + watts(total) + ' across ' + plural(used.length, 'outlet', 'outlets') + '; the busiest is at ' + pctText(busiest) + ' of its safe limit.',
      };
    }

    /** "1 cord at this outlet feeding 10 runs · 185 W" (the cords that plug into the outlet, not every run it powers). */
    function outletSummaryText(o) {
      if (!o || !(o.feeds > 0)) return 'Nothing plugged in yet';
      return plural(o.cords, 'cord', 'cords') + ' at this outlet feeding ' + plural(o.runs, 'run', 'runs') + ' · ' + watts(o.watts) +
        (o.splitters ? ' · ' + plural(o.splitters, 'power stake', 'power stakes') : '');
    }

    function stepPower(ctx) {
      const { ui, project, plan, image } = ctx;
      const pw = plan.power;
      const kids = [head(5, 'Mark the outlets you can use. LightPlan links the runs, picks the cords and checks that nothing is overloaded.')];
      if (!image) {
        kids.push(callout('info', 'Add a photo first.', { after: button('Go to Upload', { act: 'go-step', data: { step: 1 }, cls: 'small' }) }));
        return kids;
      }
      // One sentence first: is it safe, and if not, what to fix.
      const verdict = powerVerdict(plan);
      kids.push(h('div', { class: 'verdict ' + verdict.level, role: verdict.level === 'danger' ? 'alert' : 'status', 'data-key': 'verdict' },
        icon(verdict.level === 'ok' ? 'check' : verdict.level === 'info' ? 'info' : 'warning'),
        h('div', { class: 'verdict-body' },
          h('p', { class: 'verdict-text' }, h('strong', null, verdict.lead), verdict.text),
          verdict.more > 0 ? h('p', { class: 'verdict-more' }, 'And ' + (verdict.more === 1 ? '1 more thing' : verdict.more + ' more things') + ' to check, listed under Warnings below.') : null)));

      const cords = cordInfo(plan, project);
      const cordsByOutlet = {};
      for (const o of cords.outlets) cordsByOutlet[o.id] = o;
      const placing = ui.mode.name === 'outlet';
      const sel = ui.selection;
      const circuitOpts = [['', 'Not sure']].concat(project.circuits.map((c) => [c.id, c.name]));
      const outletItems = project.outlets.filter((o) => !image || o.imageId === image.id || o.imageId == null).map((o) => {
        const selected = !!(sel && sel.kind === 'outlet' && sel.id === o.id);
        const opl = byId(ctx.planes, o.planeId);
        return h('li', { class: 'outlet-card' + (selected ? ' selected' : ''), 'data-key': o.id },
          h('div', { class: 'outlet-head' },
            h('button', { type: 'button', class: 'outlet-pick', data: { act: 'select-outlet', id: o.id }, 'aria-label': 'Show ' + o.label + ' on the photo' }, icon('plug')),
            textInput({ act: 'outlet-field', value: o.label, data: { id: o.id, field: 'label' }, aria: 'Outlet name', cls: 'grow', maxlength: 60 }),
            iconButton('trash', 'Delete ' + o.label, { act: 'delete-outlet', data: { id: o.id }, cls: 'small' })),
          h('p', { class: 'outlet-info' }, outletSummaryText(cordsByOutlet[o.id])),
          h('div', { class: 'row-2 align-end' },
            field('Kind of outlet', selectInput({ act: 'outlet-type', value: o.type, options: OUTLET_TYPES, data: { id: o.id } })),
            toggle('GFCI protected', { act: 'outlet-gfci', data: { id: o.id }, checked: o.gfci })),
          opl && opl.kind !== 'wall' ? callout('warn', 'This outlet is on \'' + opl.name + '\'. Outlets are on walls: pick the wall it is on under More about this outlet, or the cord lengths come out wrong.', { key: 'op-' + o.id }) : null,
          h('details', { class: 'outlet-more', 'data-key': 'more-' + o.id },
            h('summary', null, h('span', null, 'More about this outlet'), icon('chevronDown', 'chev')),
            h('div', { class: 'row-2' },
              field('Breaker it is on', selectInput({ act: 'outlet-circuit', value: o.circuitId || '', options: circuitOpts, data: { id: o.id } })),
              field('Wall it is on', selectInput({ act: 'outlet-plane', value: o.planeId || '', options: [['', 'None']].concat(ctx.planes.map((p) => [p.id, surfaceOptionLabel(ctx.project, p)])), data: { id: o.id } })))));
      });
      kids.push(section('Outlets', [
        h('div', { class: 'btn-row' }, button(placing ? 'Tap the photo to place it' : 'Place outlet', { act: 'place-outlet', icon: 'plug', cls: placing ? 'on' : 'primary', pressed: placing })),
        outletItems.length ? h('ul', { class: 'outlet-list' }, outletItems) : h('p', { class: 'hint' }, 'Place each outdoor outlet you can use. Garage outlets work too.'),
        outletItems.length ? h('p', { class: 'hint' }, 'GFCI protected means the outlet (or its breaker) has TEST and RESET buttons. For an outlet without it, the shopping list adds a plug-in GFCI adapter.') : null,
      ], { key: 'outlets' }));
      kids.push(callout('info', power.DISCLAIMER, { key: 'disclaimer' }));

      // How the power runs: outlet → cord → run → jumper cord → run.
      const daisy = !(ctx.config.power && ctx.config.power.daisyChain === false);
      const treeKids = [
        toggle('Link nearby runs with jumper cords', { act: 'power-daisy', checked: daisy }),
        h('p', { class: 'hint' }, daisy
          ? 'On: runs that sit close together are joined with a jumper cord (a short cord from one run to the next), so only a few cords go back to the outlets.'
          : 'Off: every run, or set of runs joined end to end, gets its own cord from an outlet. Turn it on to join nearby runs with jumper cords (short cords from one run to the next).'),
      ];
      for (const o of cords.outlets) {
        if (!o.trees.length) continue;
        treeKids.push(h('div', { class: 'tree', 'data-key': 'tree-' + o.id },
          h('p', { class: 'tree-head' }, icon('plug'), h('strong', null, o.label), h('span', { class: 'num' }, plural(o.cords, 'cord', 'cords') + ' · ' + watts(o.watts))),
          h('ul', { class: 'feed-list' }, o.trees.map((tree) => tree.map((r) => cordRow(r, daisy))))));
      }
      if (cords.loose.length) {
        treeKids.push(h('div', { class: 'tree', 'data-key': 'tree-none' },
          h('p', { class: 'tree-head' }, icon('warning'), h('strong', null, 'No outlet yet'), h('span', { class: 'num' }, plural(cords.loose.length, 'run', 'runs'))),
          h('ul', { class: 'feed-list' }, cords.loose.map((r) => cordRow(r, false)))));
      }
      if (!cords.rows.length) treeKids.push(h('p', { class: 'hint' }, 'Cords appear here once there are lights and an outlet.'));
      else {
        treeKids.push(h('p', { class: 'hint legend' },
          h('span', { class: 'lg' }, h('i', { class: 'lg-line home', 'aria-hidden': 'true' }), 'cord from an outlet'),
          h('span', { class: 'lg' }, h('i', { class: 'lg-line jumper', 'aria-hidden': 'true' }), 'jumper cord'),
          h('span', { class: 'lg' }, h('i', { class: 'lg-line none', 'aria-hidden': 'true' }), 'plugs straight in (no cord)'),
          h('span', { class: 'lg' }, h('i', { class: 'lg-tap', 'aria-hidden': 'true' }), '3-way tap (a plug with three outlets)')));
        treeKids.push(h('p', { class: 'hint', 'data-key': 'gauge-note' }, '16-gauge is the usual light outdoor extension cord. A smaller number (14 or 12) is a thicker cord for a heavier load or a longer run.'));
        const detail = cords.rows.filter((r) => r.kind === 'home' || r.kind === 'jumper').map((r) => h('li', { 'data-key': 'cd-' + r.feedId },
          h('strong', null, r.lights + ': '),
          h('span', { class: 'num' }, [
            r.pieces.length ? r.pieces.map((x) => fmtNum(x, 0) + ' ft').join(' + ') + ' bought' : null,
            r.neededFt != null ? fmtNum(r.neededFt, 0) + ' ft needed' : null,
            r.awg != null ? r.awg + ' AWG' : null,
            'carries ' + watts(r.carriesW),
            r.dropPct != null ? fmtNum(r.dropPct, 1) + '% voltage drop' + (r.pathDropPct != null && r.pathDropPct > r.dropPct + 0.05 ? ' (' + fmtNum(r.pathDropPct, 1) + '% back to the outlet)' : '') : null,
          ].filter(Boolean).join(', '))));
        if (detail.length) {
          treeKids.push(disclosure('Cord details (wire gauge, voltage drop)', [
            h('p', { class: 'hint' }, 'AWG is the wire gauge printed on the cord: a smaller number is a thicker cord. Voltage drop is how much the lights dim at the far end.'),
            h('ul', { class: 'cord-detail' }, detail),
          ], { key: 'cord-detail' }));
        }
      }
      kids.push(section('How the power runs', treeKids, { key: 'feeds' }));

      const c = pw.counts || {};
      const n = (v) => fmtNum(isNum(v) ? v : 0, 0);
      kids.push(section('Power parts to buy', h('div', { class: 'tiles small' },
        tile('Cords to outlets', n(c.homeRuns)),
        tile('Jumper cords', n(c.jumpers), 'short cords from one run to the next'),
        tile('3-way taps', n(c.taps), 'plugs with three outlets'),
        tile('Timers', n(c.timers)), tile('Power stakes', n(c.splitters), 'ground stakes with 3 outlets, for an outlet that feeds several cords'),
        tile('Cord covers', n(c.cordCovers)), tile('GFCI adapters', n(c.gfciAdapters))), { key: 'counts' }));

      // Circuits
      const circuitItems = project.circuits.map((ci) => {
        const info = byId(pw.circuits, ci.id);
        const sharePct = Math.round(power.continuousFactorOf(ctx.config.power.continuousFactor).factor * 100);
        const limit = info ? info.limitW : power.limitW(ci.breakerAmps, ci.voltage || 120, ctx.config.power.continuousFactor);
        const load = info ? info.loadW : ci.existingLoadW || 0;
        const pct = limit > 0 ? (load / limit) * 100 : 0;
        const cls = pct > 100 ? 'danger' : pct > 90 ? 'warn' : 'ok';
        const breakerOpts = [['15', '15 A'], ['20', '20 A']];
        if (![15, 20].includes(ci.breakerAmps)) breakerOpts.push([String(ci.breakerAmps), ci.breakerAmps + ' A']);
        return h('li', { class: 'circuit-card', 'data-key': ci.id },
          h('div', { class: 'outlet-head' },
            textInput({ act: 'circuit-field', value: ci.name, data: { id: ci.id, field: 'name' }, aria: 'Circuit name', cls: 'grow', maxlength: 60 }),
            iconButton('trash', 'Delete ' + ci.name, { act: 'delete-circuit', data: { id: ci.id }, cls: 'small', disabled: project.circuits.length <= 1 })),
          h('div', { class: 'row-2' },
            field('Breaker', selectInput({ act: 'circuit-breaker', value: String(ci.breakerAmps), options: breakerOpts, data: { id: ci.id } })),
            field('Already on it (W)', numInput({ act: 'circuit-existing', value: ci.existingLoadW, min: 0, step: 10, decimals: 0, data: { id: ci.id } }))),
          h('div', { class: 'meter ' + cls, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(limit)), 'aria-valuenow': String(Math.round(load)), 'aria-label': ci.name + ' load' },
            h('span', { class: 'meter-fill', style: 'width:' + Math.min(100, Math.max(0, pct)).toFixed(1) + '%' })),
          h('p', { class: 'meter-text num' }, watts(load) + ' of ' + fmtNum(limit, 0) + ' W safe limit (' + sharePct + '% of ' + ci.breakerAmps + ' A) · ' + fmtNum(pct, 0) + '%'));
      });
      kids.push(section('Breakers (circuits)', [
        h('p', { class: 'hint' }, 'A circuit is everything on one breaker in the panel. Outlets on the same breaker share its limit: say which breaker each outlet is on under More about this outlet, and add what else runs on it (a garage freezer, porch lights) so the check is honest.'),
        h('ul', { class: 'circuit-list' }, circuitItems),
        h('div', { class: 'btn-row' }, button('Add circuit', { act: 'add-circuit', icon: 'plus', cls: 'small' })),
      ], { key: 'circuits' }));

      const order = { danger: 0, warn: 1, info: 2 };
      // With no outlet placed the sentence at the top already says so, in plainer words.
      const noOutlet = verdict.level === 'warn' && verdict.lead === 'Place an outlet:';
      const warns = arr(pw.warnings).filter((w) => w.code !== 'disclaimer' && !(noOutlet && w.code === 'no-outlets')).slice().sort((a, b) => order[a.level] - order[b.level]);
      kids.push(section('Warnings', warns.length ? warningList(warns, false) : h('p', { class: 'ok-line' }, icon('check'), h('span', null, noOutlet ? 'Nothing else to check.' : 'No power problems found.')), { key: 'pwarn' }));
      return kids;
    }

    /** One row of the supply tree: the lights on one cord, where the cord comes from and how it runs. */
    function cordRow(r, daisy) {
      const unitText = r.strings != null && r.unit ? fmtNum(r.strings, r.unit === 'foot' ? 1 : 0) + ' ' + unitWord(r.unit, r.strings) : null;
      const meta = [r.route ? capFirst(r.route) : null];
      if (r.gauge && (r.kind === 'home' || r.kind === 'jumper')) meta.push(r.gauge + ' cord');
      if (r.neededFt != null) meta.push('needs ' + fmtNum(r.neededFt, 0) + ' ft');
      if (r.carriesW > r.watts + 0.5) meta.push('carries ' + fmtNum(r.carriesW, 0) + ' W in all');
      const notes = [];
      if (r.tapText) notes.push(capFirst(r.tapText) + ' (a plug with three outlets)');
      if (r.cover) notes.push('Needs a cord cover where it crosses the walkway');
      if (r.doorway) notes.push('Runs in front of ' + r.doorway + ': keep it tight against the doorstep, under a cord cover');
      const showOwn = daisy && r.featureIds.length > 0 && (r.kind === 'jumper' || r.kind === 'plugIn' || r.ownCord);
      const depth = Math.max(0, Math.min(5, r.depth || 0));
      return h('li', { class: 'feed-item ' + r.kind + (depth ? ' child' : ''), 'data-key': r.feedId, 'data-kind': r.kind, style: depth ? 'margin-left:' + depth * 12 + 'px' : null },
        h('p', { class: 'feed-title' }, h('i', { class: 'lg-line ' + (r.kind === 'jumper' ? 'jumper' : r.kind === 'home' ? 'home' : 'none'), 'aria-hidden': 'true' }),
          h('strong', null, r.lights), h('span', { class: 'num feed-w' }, (unitText ? unitText + ' · ' : '') + watts(r.watts))),
        h('p', { class: 'feed-line' }, r.line),
        meta.filter(Boolean).length ? h('p', { class: 'feed-meta' }, meta.filter(Boolean).join(' · ')) : null,
        notes.length ? h('p', { class: 'feed-note' }, notes.join('. ') + '.') : null,
        showOwn ? toggle('Give this run its own cord', { act: 'feed-own-cord', data: { ids: r.featureIds.join(',') }, checked: r.ownCord, cls: 'slim' }) : null);
    }

    function tile(label, value, sub) {
      return h('div', { class: 'tile' }, h('p', { class: 'tile-value num' }, value), h('p', { class: 'tile-label' }, label), sub ? h('p', { class: 'tile-sub' }, sub) : null);
    }

    // ================================================================ step 6: Review & Export
    function stepReview(ctx) {
      const { project, plan, local } = ctx;
      const sm = plan.summary;
      const kids = [head(6, 'Everything to buy, what it costs, and the order to put it up.')];

      const rough = roughList(plan, project);
      if (rough.length) kids.push(roughSection(ctx, rough));

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
          h('div', { class: 'tile wide accent', 'data-key': 'cost-tile', 'data-rough': rough.length ? 'true' : null },
            h('p', { class: 'tile-value num' }, money(sm.cost)),
            h('p', { class: 'tile-label' }, 'Estimated materials cost', rough.length ? h('span', { class: 'badge warn rough-badge' }, 'rough') : null),
            rough.length ? h('p', { class: 'tile-sub' }, 'Rough until ' + (rough.length === 1 ? 'the measurement above is' : 'the ' + rough.length + ' measurements above are') + ' checked with a tape.') : null,
            isNum(sm.quoteTotal) ? h('p', { class: 'tile-sub num' }, 'Customer quote ' + money(sm.quoteTotal)) : null)),
      ], { key: 'summary' }));

      kids.push(bomSection(ctx));
      kids.push(orderSheetsSection(ctx));
      kids.push(quoteSection(ctx));
      kids.push(checklistSection(ctx));

      const busy = local.exporting || (savingUnavailable ? 'off' : null);
      kids.push(section('Export', [savingUnavailable ? callout('warn', 'Saving files is not available in this view. Open LightPlan as a standalone file to save the report, the shopping list or the project.', { key: 'save-off' }) : null,
        h('div', { class: 'export-grid' },
        button(busy === 'pdf' ? 'Making PDF…' : 'PDF report', { act: 'export', data: { kind: 'pdf' }, icon: 'file', disabled: !!busy }),
        button(busy === 'quote' ? 'Making PDF…' : 'Customer quote PDF', { act: 'export', data: { kind: 'quote' }, icon: 'file', disabled: !!busy || !project.quote.enabled, title: project.quote.enabled ? null : 'Turn on installer mode to make a quote' }),
        button('CSV (shopping list)', { act: 'export', data: { kind: 'csv' }, icon: 'table', disabled: !!busy }),
        button('Save project (JSON)', { act: 'export', data: { kind: 'json' }, icon: 'download', disabled: !!busy }),
        button('Open project (JSON)', { act: 'pick', data: { kind: 'json' }, icon: 'folder' })),
      project.quote.enabled ? null : h('p', { class: 'hint' }, 'Turn on installer mode above to make a customer quote.'),
      h('p', { class: 'hint' }, 'Save project keeps the photo, tracing and settings in one file you can open later.')], { key: 'export' }));
      return kids;
    }

    /** The measurements worth a tape measure (ui.export.roughMeasurements); empty when that module is missing. */
    function roughList(plan, project) {
      const exp = exportModule();
      try { return exp && typeof exp.roughMeasurements === 'function' ? exp.roughMeasurements(plan, project) : []; } catch (e) { return []; }
    }

    /**
     * "Measurements to double-check (n)" at the top of Review: each Low-confidence item with the range it could be,
     * a tape-measure field (the same override the Trace step edits) and a link to the item in step 3.
     */
    function roughSection(ctx, rough) {
      // Roughest first, so the ones that matter most are in view; the rest fold away under "more".
      const rank = (it) => (it.pct === Infinity ? 1e9 : isNum(it.pct) ? it.pct : 0);
      const sorted = rough.slice().sort((a, b) => rank(b) - rank(a));
      const items = sorted.map((it) => {
        const f = byId(ctx.project.features, it.featureId) || { params: {} };
        const ft = FEATURE_TYPES[it.type] || { color: '#999' };
        const params = f.params || {};
        const tape = it.kind === 'bush'
          ? h('div', { class: 'row-2' },
            field('Tape width', textInput({ act: 'feature-len', value: params.overrideWidthFt ? ctx.fmt(params.overrideWidthFt) : '', placeholder: 'e.g. 4\'', data: { id: it.featureId, field: 'overrideWidthFt' } })),
            field('Tape height', textInput({ act: 'feature-len', value: params.overrideHeightFt ? ctx.fmt(params.overrideHeightFt) : '', placeholder: 'e.g. 3\'', data: { id: it.featureId, field: 'overrideHeightFt' } })))
          : field(it.kind === 'height' ? 'Tape-measured height' : 'Tape-measured length',
            textInput({ act: 'feature-len', value: f.overrideFt ? ctx.fmt(f.overrideFt) : '', placeholder: 'e.g. ' + ctx.fmt(it.lengthFt), data: { id: it.featureId, field: 'overrideFt' } }));
        // A ridge drawn on a wall: the same two fixes as on its card in step 3.
        const m = ctx.plan.measured.features[it.featureId];
        const wrong = needsRoof(f, m) ? ctx.misplaced()[it.featureId] || {} : null;
        const low = !wrong && needsLower(f, m) ? ctx.misplaced()[it.featureId] || {} : null;
        const lowTo = low ? lowerTarget(ctx.project, f, low) : null;
        return h('li', { class: 'rough-item', 'data-key': 'rough-' + it.featureId },
          h('p', { class: 'rough-title' }, swatch(ft.color, 'dot'), h('strong', null, it.label), pill(it.level)),
          h('p', { class: 'rough-text' }, capFirst(it.text) + '.'),
          wrong ? h('div', { class: 'rough-fix', 'data-key': 'fix' },
            h('p', { class: 'rough-text' }, wrongSurfaceWhy(wrong) || 'A ridge sits on the roof, behind the wall. Measured on the wall it comes out too short.'),
            h('div', { class: 'btn-row wrap' },
              button('Put it on the roof', { act: 'put-on-roof', data: { id: it.featureId }, cls: 'small primary' }),
              button('Type its length', { act: 'type-length', data: { id: it.featureId }, cls: 'small' }))) : null,
          low ? h('div', { class: 'rough-fix', 'data-key': 'fix-below' },
            h('p', { class: 'rough-text' }, 'This item is drawn below the line where its roof starts, so it is not on that roof.'),
            h('div', { class: 'btn-row wrap' },
              lowTo ? button('Put it on \'' + (lowTo.name || 'the surface below') + '\'', { act: 'put-on-plane', data: { id: it.featureId, plane: lowTo.planeId }, cls: 'small primary' }) : null,
              button('Type its length', { act: 'type-length', data: { id: it.featureId }, cls: 'small' }))) : null,
          h('div', { class: 'rough-row' }, tape,
            button('Show it', { act: 'show-feature', data: { id: it.featureId }, icon: 'arrowRight', cls: 'small ghost', aria: 'Show ' + it.label + ' on the photo in step 3' })));
      });
      const FIRST = 4;
      const rest = items.length > FIRST + 1 ? items.slice(FIRST) : [];
      const first = rest.length ? items.slice(0, FIRST) : items;
      return section('Measurements to double-check (' + rough.length + ')', [
        h('p', { class: 'hint' }, 'The photo could not measure these well. Check each one with a tape measure and type what you get: the shopping list and the cost follow it straight away. Show it opens the item on the photo in step 3.'),
        h('ul', { class: 'rough-list' }, first),
        rest.length ? h('details', { class: 'disclosure rough-more', 'data-key': 'rough-more' },
          h('summary', null, h('span', null, rest.length + ' more to double-check'), icon('chevronDown', 'chev')),
          h('div', { class: 'disclosure-body' }, h('ul', { class: 'rough-list' }, rest))) : null,
      ], { key: 'rough', cls: 'rough-sec' });
    }

    /** Under the shopping list: how far to trust the prices, and that any of them can be typed over (said once). */
    function bomHint(sentence) {
      const tail = 'Type what you pay over any unit price: the totals follow.';
      if (!sentence) return tail;
      return /edit any price/.test(sentence) ? sentence.replace('edit any price.', 'type what you pay over any unit price.') : sentence + ' ' + tail;
    }
    /** "6 packs", "38 ft", "1 spool", "4" (things sold singly have no unit word). */
    function qtyWords(qty, unit, name) {
      // A pack the supplier calls a box ("box of 25") is counted in boxes, as on its page.
      const word = unit === 'pack' && /\bbox of\b/i.test(String(name || '')) ? (qty === 1 ? 'box' : 'boxes') : unitWord(unit, qty);
      return fmtNum(qty, unit === 'foot' ? 1 : 0) + (word ? ' ' + word : '');
    }

    /**
     * The shopping list: one row per thing to buy with where it is bought (supplier, part number), how fresh its
     * price is, an editable unit price, what a spool, box or pack leaves over, and a link to it (or to where the
     * chosen supplier keeps such things). In installer mode: what the job is charged for.
     */
    function bomSection(ctx) {
      const { plan, project } = ctx;
      const bom = plan.bom;
      const lib = plan.library;
      const words = exportModule();
      const index = words ? words.bulkPartIndex(lib) : null;
      // The basis the plan applied: "only what is used" counts in installer mode only (bom.costBasis says which).
      const usedBasis = bom.costBasis === 'used';
      let toOrder = 0;
      let byShare = 0;
      const rows = arr(bom.lines).map((l) => {
        const key = l.sku + ':' + hashKey(l.name);
        const status = words ? words.priceStatusLabel(l) : null;
        const use = words ? words.orderUseText(l, index) : '';
        const share = isNum(l.buyTotal) && Math.abs(l.buyTotal - l.lineTotal) > 0.004;
        toOrder += isNum(l.buyTotal) ? l.buyTotal : l.lineTotal;
        if (use) byShare += 1;
        const url = safeUrl(l.url);
        const find = url ? null : safeUrl(l.findUrl);
        const at = find ? supplierOfUrl(lib, find) : null;
        const atFacts = at && words ? words.supplierFacts(lib, at.id) : null;
        return h('li', { class: 'bom-row', 'data-key': key, 'data-sku': l.sku, 'data-supplier': l.supplierId || GENERIC, 'data-status': status ? status.kind : null },
          h('div', { class: 'bom-top' }, h('span', { class: 'bom-name' }, l.name), h('span', { class: 'bom-total num' }, money(l.lineTotal))),
          h('p', { class: 'bom-from' },
            h('span', { class: 'bom-supplier' }, l.supplierName || 'Any store'),
            l.supplierSku ? h('span', { class: 'bom-part' }, 'part number ', h('span', { class: 'num' }, l.supplierSku)) : null,
            priceBadge(status)),
          l.notes ? h('p', { class: 'bom-notes' }, l.notes) : null,
          h('div', { class: 'bom-price' },
            h('span', { class: 'num bom-qty' }, qtyWords(l.qty, l.unit, l.name) + ' ×'),
            h('span', { class: 'money-input' }, h('span', { 'aria-hidden': 'true' }, '$'),
              textInput({ act: 'price', value: isNum(l.unitPrice) ? l.unitPrice.toFixed(2) : '', inputmode: 'decimal', maxlength: 12, data: { sku: l.sku }, aria: 'Unit price of ' + l.name, cls: 'num' + (l.overridden ? ' changed' : '') })),
            l.overridden ? button('Reset', { act: 'price-reset', data: { sku: l.sku }, cls: 'small ghost', aria: 'Reset the price of ' + l.name + ' to ' + money(l.defaultPrice) }) : null),
          use ? h('p', { class: 'bom-use' }, h('span', { class: 'num' }, use), share ? h('span', { class: 'num' }, ' · the whole order costs ' + money(l.buyTotal)) : null) : null,
          url ? linkRow(ctx, url, 'Open', 'bom-' + key, { aria: l.name + ' at ' + (l.supplierName || 'the supplier'), kind: 'product' }) : null,
          find ? linkRow(ctx, find, at ? 'Find at ' + at.name : 'Find it', 'bom-' + key, { aria: 'Look for ' + l.name + (at ? ' at ' + at.name : ''), kind: 'find' }) : null,
          find && atFacts && words.isUncheckedSearch(atFacts, find) ? h('p', { class: 'bom-notes' }, 'This link searches the site. ' + atFacts.searchNote) : null);
      });
      // Installer mode: charge the job for everything ordered, or only for the share of a spool, box or pack it uses.
      const basis = project.quote.enabled && rows.length ? h('div', { class: 'cost-basis', 'data-key': 'cost-basis' },
        choiceList('Charge this job for', 'cost-basis-label', [
          { title: 'Everything ordered', sub: 'The whole spool, box or pack goes on this job.', on: !usedBasis, act: 'cost-basis', data: { basis: 'bought' } },
          { title: 'Only what is used', sub: 'You keep the leftover wire, bulbs and plugs for the next job. The order stays the same; only what this job is charged changes.', on: usedBasis, act: 'cost-basis', data: { basis: 'used' } },
        ]),
        byShare ? null : h('p', { class: 'hint' }, 'Nothing in this plan is bought by the spool or box, so both give the same total.')) : null;
      const differs = Math.abs(toOrder - bom.subtotal) > 0.004;
      const from = arr(lib.suppliers).find((x) => x && x.id === (lib.supplierId || GENERIC));
      const stray = strayOverrides(project, plan);
      const strayBlock = stray.length ? h('div', { class: 'bom-stray', 'data-key': 'bom-stray' },
        h('p', { class: 'hint' }, 'Your own ' + (stray.length === 1 ? 'price for an item that is' : 'prices for items that are') + ' not on the list right now. ' +
          (stray.length === 1 ? 'It is' : 'They are') + ' kept in case the item comes back:'),
        h('ul', { class: 'stray-list' }, stray.map((x) => h('li', { 'data-key': 'stray-' + hashKey(x.sku), 'data-sku': x.sku },
          h('span', { class: 'stray-name' }, x.name), h('span', { class: 'num' }, money(x.price)),
          button('Reset', { act: 'price-reset', data: { sku: x.sku }, cls: 'small ghost', aria: 'Remove your price for ' + x.name }))))) : null;
      return section('Shopping list', [
        rows.length ? h('p', { class: 'bom-buying', 'data-key': 'bom-buying' }, h('span', null, 'Buying from ', h('strong', null, from ? from.name : 'Any store'), '.'),
          button('Change', { act: 'go-step', data: { step: 4 }, cls: 'small ghost', aria: 'Change who you buy from, in step 4' })) : null,
        rows.length ? h('ul', { class: 'bom-list' }, rows) : h('p', { class: 'hint' }, 'Trace something to see what to buy.'),
        basis,
        rows.length ? h('p', { class: 'bom-subtotal' }, h('span', null, differs ? 'Subtotal for this job' : 'Subtotal'), h('strong', { class: 'num' }, money(bom.subtotal))) : null,
        rows.length && differs ? h('p', { class: 'bom-subtotal order', 'data-key': 'to-order' }, h('span', null, 'To order'), h('strong', { class: 'num' }, money(toOrder))) : null,
        strayBlock,
        rows.length ? h('p', { class: 'hint', 'data-key': 'bom-hint' }, bomHint(words ? words.priceSentence(bom.lines) : '')) : null,
      ], { key: 'bom' });
    }

    /**
     * "Order sheets": one card per supplier in the plan (then "Any store") with the part number, item and quantity of
     * each line, the subtotal to order, the supplier's phone and free-shipping line when its pages give one, and two
     * ways out: copy the list as text, or save it as a CSV file.
     */
    function orderSheetsSection(ctx) {
      const words = exportModule();
      if (!words) return null;
      const entries = words.whereToBuy(ctx.plan).filter((e) => e.lines.length);
      if (!entries.length) return null;
      const local = ctx.local;
      const busy = local.exporting || (savingUnavailable ? 'off' : null);
      const cards = entries.map((e) => {
        const key = 'order-' + e.supplierId;
        const copied = local.copy && local.copy.key === key ? local.copy : null;
        const lines = e.lines.map((l, i) => h('li', { class: 'order-line', 'data-key': 'ol' + i + hashKey(String(l.sku) + l.name), 'data-part': l.supplierSku || null },
          h('span', { class: 'os-qty num' }, qtyWords(l.qty, l.unit, l.name)),
          h('span', { class: 'os-item' },
            h('span', { class: 'os-name' }, l.name),
            l.supplierSku ? h('span', { class: 'os-part' }, 'Part number ', h('span', { class: 'num' }, l.supplierSku)) : e.generic ? null : h('span', { class: 'os-part' }, 'No part number on file'))));
        return h('li', { class: 'order-card', 'data-key': key, 'data-supplier': e.supplierId },
          h('div', { class: 'order-head' }, h('strong', null, e.name), h('span', { class: 'num' }, plural(e.lines.length, 'item', 'items'))),
          h('ul', { class: 'order-lines' }, lines),
          h('p', { class: 'order-total' }, h('span', null, 'Subtotal to order'), h('strong', { class: 'num' }, money(e.subtotal))),
          e.phone ? h('p', { class: 'order-fact', 'data-fact': 'phone' }, 'Order by phone: ', h('span', { class: 'num' }, e.phone)) : null,
          e.freeShipping ? h('p', { class: 'order-fact', 'data-fact': 'shipping' }, e.freeShipping) : null,
          e.sentence ? h('p', { class: 'hint' }, e.sentence) : null,
          h('div', { class: 'btn-row wrap' },
            button(copied && copied.ok ? 'Copied' : 'Copy order list', { act: 'copy-order', data: { id: e.supplierId }, icon: copied && copied.ok ? 'check' : 'copy', cls: 'small', aria: 'Copy the order list for ' + e.name }),
            button(busy === key ? 'Saving…' : 'Save order CSV', { act: 'order-csv', data: { id: e.supplierId }, icon: 'table', cls: 'small', disabled: !!busy, aria: 'Save the order list for ' + e.name + ' as a CSV file' })),
          copied && !copied.ok ? copyFallback(copied) : null);
      });
      return section('Order sheets', [
        h('p', { class: 'hint' }, entries.some((e) => !e.generic)
          ? 'One list per supplier, with the part numbers to type on its site or read out on the phone.'
          : 'Everything to buy as one list. Choose a supplier in step 4 to get its part numbers and links.'),
        h('ul', { class: 'order-list' }, cards),
      ], { key: 'order-sheets' });
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
        groups.length ? h('p', { class: 'hint', 'data-key': 'ticks-note' }, h('span', { class: 'num' }, done + ' of ' + total),
          persist.isAvailable() ? ' steps done. Ticks are saved in this browser.' : ' steps done. Ticks last until this page closes: this browser is not saving anything.') : null,
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
        copy: null,   // {key, text, ok, multiline, select}: the last "Copy" pressed; ok false = shown selected to copy by hand
        steep: null,        // {planeId, up, back, slope}: tape numbers being typed for a steep roof face
        steepShown: {},     // plane id → which two tape fields were typed (shown again after they are stored)
        focusN: 0,          // the last ui.focusTape request that was carried out
        scrollN: 0,         // the last ui.scrollTo request that was carried out
        steepRefused: null, // the steep face whose tape numbers "Use these numbers" just refused
      };
      let scheduled = false;
      let destroyed = false;
      let lastStep = null;
      let lastSel = null;

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
        // Text shown to be copied by hand belongs to the step it was asked on: it does not wait there for a return.
        if (lastStep !== null && store.ui().step !== lastStep) local.copy = null;
        const next = build();
        const cur = root.firstElementChild;
        if (cur && cur.classList.contains('panel-content')) morph(cur, next);
        else { root.textContent = ''; root.appendChild(next); }
        const step = store.ui().step;
        if (step !== lastStep) { root.scrollTop = 0; lastStep = step; }
        // A newly selected item (often from a tap on the photo) is scrolled into view with its editor.
        const sel = store.ui().selection;
        const selKey = sel ? sel.kind + ':' + sel.id : null;
        if (selKey !== lastSel) {
          lastSel = selKey;
          const row = sel ? root.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(sel.id) : sel.id) + '"]') : null;
          if (row && sel.kind !== 'plane' && typeof row.scrollIntoView === 'function') {
            const r = row.getBoundingClientRect();
            const box = root.getBoundingClientRect();
            if (r.top < box.top || r.top > box.bottom - 60) { try { row.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ } }
          }
        }
        // Re-focus a field that was replaced (its structure changed) so typing is not interrupted.
        if (focusKey && (!document.activeElement || !root.contains(document.activeElement))) {
          const el = root.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(focusKey) : focusKey) + '"]');
          if (el) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        }
        // A steep face or an upper roof was just made: bring what comes next (its slope, its pitch) into view, once.
        const goTo = store.ui().scrollTo;
        if (goTo && goTo.n !== local.scrollN) {
          const part = root.querySelector('[data-key="' + (goTo.key === 'steep' ? 'steep' : 'upper-pitch') + '"]');
          if (part) {
            local.scrollN = goTo.n;
            const show = () => { try { part.scrollIntoView({ block: 'start' }); } catch (e) { /* ignore */ } };
            show();
            // On a phone the sheet may still be settling at half height: bring it into view again after.
            setTimeout(() => { if (!destroyed) show(); }, 350);
          }
        }
        // "Type its length": put the cursor in that item's tape-measured length field, once per request.
        const want = store.ui().focusTape;
        if (want && want.n !== local.focusN) {
          const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
          const el = root.querySelector('[data-act="feature-len"][data-field="overrideFt"][data-id="' + esc(String(want.featureId)) + '"]');
          if (el) {
            local.focusN = want.n;
            const folded = el.closest('details');
            if (folded && !folded.open) folded.open = true;
            const show = () => { try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ } };
            try { show(); el.focus({ preventScroll: true }); if (el.select) el.select(); } catch (e) { /* ignore */ }
            // On a phone the sheet may still be rising from its collapsed size: bring the field into view again after.
            setTimeout(() => { if (!destroyed && document.activeElement === el) show(); }, 350);
          }
        }
        // Text that could not be copied is shown in a read-only field: select it once so it can be copied by hand.
        if (local.copy && local.copy.select) {
          local.copy.select = false;
          const el = root.querySelector('[data-copy-field]');
          if (el) { try { el.focus({ preventScroll: true }); el.select(); if (el.setSelectionRange) el.setSelectionRange(0, el.value.length); } catch (e) { /* ignore */ } }
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
      /** What the photo itself measures for a tape field (the size before any tape value), or null. */
      const photoSizeOf = (featureId, fieldName) => {
        const f = byId(P().features, featureId);
        const m = f ? store.plan().measured.features[featureId] : null;
        if (!f || !m || !m.ok) return null;
        const params = f.params || {};
        if (fieldName === 'overrideWidthFt') return params.overrideWidthFt ? null : m.widthFt;
        if (fieldName === 'overrideHeightFt') return params.overrideHeightFt ? null : m.heightFt;
        const ft = FEATURE_TYPES[f.type] || {};
        if (ft.geometry === 'vertical') return f.overrideFt ? null : (isNum(m.heightFt) ? m.heightFt : m.measuredFt);
        return m.measuredFt;
      };
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
        actions.setLibraryProducts(productsToSave(list));
      }
      /**
       * Copy text for the user: to the clipboard when the browser allows it, else shown selected in a read-only field
       * beside the button that was pressed (key) so it can be copied by hand. `what` names it in the message.
       */
      let copyTimer = null;
      function copyText(text, key, what) {
        const finish = (ok) => {
          if (destroyed) return;
          local.copy = { key, text, ok: !!ok, multiline: text.indexOf('\n') >= 0, select: !ok };
          // A refusal replaces any earlier "copied" message, so the two never disagree.
          if (ok) actions.toast(what + ' copied.', 'ok');
          else actions.toast('Copying is blocked in this view. It is selected below so you can copy it by hand.', 'info');
          schedule();
          if (copyTimer) clearTimeout(copyTimer);
          // "Copied" goes back to "Copy" after a moment; the read-only field stays until Done.
          if (ok) copyTimer = setTimeout(() => { if (local.copy && local.copy.key === key && local.copy.ok) { local.copy = null; schedule(); } }, 2500);
        };
        writeClipboard(String(text)).then(finish, () => finish(false));
      }
      /** The three tape fields of a steep roof face, as typed: {up, back, slope} (strings), read from the page. */
      function steepFields(planeId) {
        const out = { planeId, up: '', back: '', slope: '' };
        for (const f of Array.from(root.querySelectorAll('[data-act="steep-tape"]'))) {
          if (f.dataset.id === planeId && Object.prototype.hasOwnProperty.call(out, f.dataset.field)) out[f.dataset.field] = f.value.trim();
        }
        return out;
      }
      /**
       * Store the tape numbers typed for a steep roof face. loud: say what is wrong (the button); quiet (leaving a
       * field) stores them only when two or three good numbers are there.
       */
      function applySteepTape(planeId, loud) {
        const typed = steepFields(planeId);
        const nums = {};
        const keys = [];
        for (const k of ['up', 'back', 'slope']) {
          if (!typed[k]) continue;
          const v = parseLength(typed[k]);
          if (v == null) {
            if (loud) badLength(root.querySelector('[data-act="steep-tape"][data-field="' + k + '"]') || { value: typed[k] });
            return false;
          }
          nums[k + 'Ft'] = v;
          keys.push(k);
        }
        // Leaving a field stores only a plain pair: exactly two good numbers, and not while numbers that were just
        // refused are still in the fields (the third one may be the stale one). Anything else waits for the button.
        if (!loud && (keys.length !== 2 || local.steepRefused === planeId || !measure.steepFromTape(nums).ok)) return false;
        const res = actions.setSteepMeasured(planeId, nums);
        if (!res || !res.ok) { if (loud) local.steepRefused = planeId; schedule(); return false; }
        if (local.steepRefused === planeId) local.steepRefused = null;
        local.steep = null;
        local.steepShown[planeId] = keys.length === 2 ? keys : ['up', 'back'];
        schedule();
        return true;
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
          actions.setLibraryProducts(productsToSave(parsed.value));
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
        'lens-use': (el) => {
          const f = Number(el.dataset.f);
          if (f > 0) actions.updateImageCamera(el.dataset.id, { mode: 'manual', focalPx: Math.round(f) });
        },
        pick: (el) => pickFile(actions, el.dataset.kind),
        'load-sample': (el) => actions.loadSample({ traced: el.dataset.traced !== '0' }),
        'select-plane': (el) => actions.select({ kind: 'plane', id: el.dataset.id }),
        'add-plane': (el) => actions.addPlane(el.dataset.kind, el.dataset.parent ? { parentId: el.dataset.parent } : undefined),
        // A typical angle for a steep roof face (a guess). It replaces tape numbers, so those fields are cleared.
        'steep-angle': (el) => {
          local.steep = null;
          delete local.steepShown[el.dataset.id];
          actions.setSteepAngle(el.dataset.id, Number(el.dataset.deg));
          schedule();
        },
        'steep-use': (el) => applySteepTape(el.dataset.id, true),
        'put-on-roof': (el) => actions.putOnRoof(el.dataset.id),
        'put-on-plane': (el) => actions.putOnPlane(el.dataset.id, el.dataset.plane || undefined),
        'steep-swap': (el) => {
          const pl = byId(P().planes, el.dataset.id);
          const pp = pl && pl.derived ? pl.derived.pitch : null;
          if (!pp) return;
          local.steep = null;
          local.steepShown[el.dataset.id] = ['up', 'back'];
          actions.setSteepMeasured(el.dataset.id, { upFt: pp.run, backFt: pp.rise });
        },
        'type-length': (el) => actions.typeLength(el.dataset.id),
        'delete-plane': (el) => actions.deletePlane(el.dataset.id),
        'mark-rect': (el) => actions.startPlaneRect(el.dataset.id),
        'remove-rect': (el) => actions.removePlaneRect(el.dataset.id),
        'draw-ref': (el) => {
          // Commit the reference size fields from their live values first (the change event may not have fired).
          const live = {};
          const len = root.querySelector('[data-act="ref-length"]');
          if (len && len.value.trim()) { const v = parseLength(len.value.trim()); if (v == null) { badLength(len); return; } live.refLengthFt = v; }
          for (const f of Array.from(root.querySelectorAll('[data-act="ref-rect-size"]'))) {
            if (!f.value.trim()) continue;
            const v = parseLength(f.value.trim());
            if (v == null) { badLength(f); return; }
            live[f.dataset.field === 'width' ? 'refWidthFt' : 'refHeightFt'] = v;
          }
          if (Object.keys(live).length) actions.setCalib(live);
          actions.startReference(el.dataset.id);
        },
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
        'delete-vertex': (el) => {
          const i = Number(el.dataset.index);
          if (el.dataset.index !== '' && Number.isInteger(i)) actions.deleteVertex(el.dataset.id, i);
        },
        'view-flip': (el) => {
          const k = el.dataset.key;
          const v = store.ui().view;
          // With the lights off, Night and Twinkle show as off; tapping one turns it on together with the lights.
          if ((k === 'night' || k === 'twinkle') && !v.preview) actions.setView({ [k]: true, preview: true });
          else actions.setView({ [k]: !v[k] });
        },
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
        // From Review: open the Trace step with this item picked (its points and its editor show).
        'show-feature': (el) => { actions.goStep(3); actions.select({ kind: 'feature', id: el.dataset.id }); },
        'delete-outlet': (el) => actions.deleteOutlet(el.dataset.id),
        'add-circuit': () => actions.addCircuit(),
        'delete-circuit': (el) => actions.deleteCircuit(el.dataset.id),
        'price-reset': (el) => actions.setPriceOverride(el.dataset.sku, null),
        // Who to buy from, how its C7 and C9 are bought, and what the job is charged for: one undo step each.
        supplier: (el) => actions.setSupplier(el.dataset.id),
        'buy-style': (el) => actions.setBuying({ style: el.dataset.style }),
        'cost-basis': (el) => actions.setBuying({ costBasis: el.dataset.basis }),
        'copy-link': (el) => { if (safeUrl(el.dataset.url)) copyText(el.dataset.url, el.dataset.key, 'Link'); },
        'copy-close': () => { local.copy = null; schedule(); },
        'copy-order': (el) => {
          const words = exportModule();
          const entry = words ? words.whereToBuy(store.plan()).find((e) => e.supplierId === el.dataset.id) : null;
          if (entry) copyText(words.orderSheetText(entry), 'order-' + entry.supplierId, 'Order list for ' + entry.name);
        },
        'order-csv': (el) => {
          const words = exportModule();
          const id = el.dataset.id;
          if (!words || local.exporting) return;
          const entry = words.whereToBuy(store.plan()).find((e) => e.supplierId === id);
          local.exporting = 'order-' + id;
          schedule();
          saveResult(Promise.resolve().then(() => words.exportOrderCsv(store, id)), actions, 'Order list for ' + (entry ? entry.name : 'this supplier') + ' saved as a CSV file.')
            .then(() => { local.exporting = null; schedule(); });
        },
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
        'steep-tape': (el) => { local.steep = steepFields(el.dataset.id); applySteepTape(el.dataset.id, false); },
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
          const id = el.dataset.id;
          const apply = () => {
            if (k === 'overrideFt') actions.updateFeature(id, { overrideFt: v });
            else actions.updateFeature(id, { params: { [k]: v } });
          };
          // A size far from what the photo says is probably a slip (150 for 15.0): ask before it reaches the order.
          const photo = photoSizeOf(id, k);
          const off = v == null ? null : tapeMismatch(v, photo);
          if (off === null || typeof actions.confirm !== 'function') { apply(); return; }
          const fmt = (ft) => measure.formatLength(ft, P().settings && P().settings.lengthFormat);
          const times = fmtNum(Math.round(off), 0) + ' times';
          actions.confirm({
            title: 'Is ' + fmt(v) + ' right?',
            body: 'The photo measures about ' + fmt(photo) + ' here, so ' + fmt(v) + ' is ' + (v > photo ? times + ' as much' : 'only one part in ' + fmtNum(Math.round(off), 0) + ' of that') +
              '. Keep it if the tape says so; otherwise check for a slip of the finger.',
            confirmLabel: 'Keep ' + fmt(v), cancelLabel: 'Change it',
          }).then((ok) => { if (ok) apply(); else schedule(); });
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
        'run-mount': (el) => actions.updateFeature(el.dataset.id, { params: { mount: el.value || null } }),
        'run-outlet': (el) => actions.updateFeature(el.dataset.id, { params: { outletId: el.value || null } }),
        'run-reverse': (el) => actions.updateFeature(el.dataset.id, { params: { reverse: !!el.checked } }),
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
        'outlet-plane': (el) => actions.updateOutlet(el.dataset.id, { planeId: el.value || null }),
        'outlet-gfci': (el) => actions.updateOutlet(el.dataset.id, { gfci: !!el.checked }),
        // Daisy chains on or off (config.power.daisyChain, default on), and one run kept off the chains.
        'power-daisy': (el) => editConfig('power.daisyChain', !!el.checked),
        'feed-own-cord': (el) => actions.setOwnCord(String(el.dataset.ids || '').split(',').filter(Boolean), !!el.checked),
        'circuit-field': (el) => { const v = el.value.trim(); if (v) actions.updateCircuit(el.dataset.id, { name: v.slice(0, 60) }); else schedule(); },
        'circuit-breaker': (el) => actions.updateCircuit(el.dataset.id, { breakerAmps: Number(el.value) || 15 }),
        'circuit-existing': (el) => { const v = num(el); actions.updateCircuit(el.dataset.id, { existingLoadW: v != null && v >= 0 ? v : 0 }); },
        price: (el) => {
          if (el.value.trim() === '') { actions.setPriceOverride(el.dataset.sku, null); return; }
          const v = parseMoney(el.value);
          if (v == null) {
            // Put the price that is in the plan back in the field, so what is shown is what is used.
            const line = arr(store.plan().bom.lines).find((l) => l.sku === el.dataset.sku);
            actions.toast('"' + el.value.trim().slice(0, 20) + '" is not a price. Type dollars and cents of $0 or more, like 12.50.', 'warn');
            if (line && isNum(line.unitPrice)) el.value = line.unitPrice.toFixed(2);
            schedule();
            return;
          }
          actions.setPriceOverride(el.dataset.sku, v);
          // The same price typed again changes nothing in the plan: still show it as dollars and cents.
          el.value = (Math.round(v * 100) / 100).toFixed(2);
        },
        'quote-toggle': (el) => actions.updateQuote({ enabled: !!el.checked }),
        'quote-text': (el) => actions.updateQuote({ [el.dataset.field]: el.value.slice(0, el.dataset.field === 'notes' ? 2000 : 120) }),
        'quote-num': (el) => {
          const v = num(el);
          if (v == null || v < 0) { actions.toast('Enter a number of 0 or more.', 'warn'); schedule(); return; }
          // updateQuote refuses (with a toast) values a reload would reset, e.g. a tax rate above 100%.
          if (actions.updateQuote({ [el.dataset.field]: el.dataset.field === 'validDays' ? Math.round(v) : v }) === false) schedule();
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
        'steep-tape': (el) => { local.steep = steepFields(el.dataset.id); },
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

    return {
      mount, icon, h, morph, pickFile, exportFile, stepWarnings, warningStep, STEPS, validateProducts, diffConfig, ICONS,
      powerVerdict, outletSummaryText, roughList, planProgress, nextAction, runNextAction, lensWords, zoomedOutReason,
      productGroups, productOptionText, productsToSave, bushRuleText, supplierOfUrl, writeClipboard,
      parseMoney, tapeMismatch, strayOverrides, CALIBRATE_SENTENCE,
      scaleLine, rectWords, steepSlopeText, storedSteepPitch, needsRoof, needsLower, lowerTarget, wrongSurfaceWhy, roofFixNote,
    };
  });
