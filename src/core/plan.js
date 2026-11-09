/* LightPlan core: plan (SPEC §5.10).
 * computePlan(project) runs the whole pipeline: library → measure → design → power → merge power info
 * into the runs → BOM → quote → checklist → warnings → summary. Pure and deterministic: the same
 * project always gives the same plan, and nothing in the project is mutated.
 *
 * computePlan never throws. Each stage is wrapped: if one fails (or its module is not loaded), the plan
 * gets a danger warning {code: 'internal-error', stage} and that stage's result is empty, and every
 * later stage still runs on what is available.
 *
 * measure, design and power are looked up lazily through LP (not declared as define() dependencies) so
 * that a missing or broken module degrades the plan instead of stopping the whole app from loading.
 *
 * Deviations from SPEC §5.10 (documented signature unchanged; these are additive):
 *  - internal-error warnings carry an extra `stage` field ('library', 'measure', 'design', 'power',
 *    'merge', 'bom', 'quote', 'checklist', 'summary').
 *  - Run warnings (plain strings on each LightRun) become {level:'warn', code:'run', message, featureId}.
 *    A run's "Not measured yet" note is dropped when measure already reported that feature as
 *    unmeasured, so the same problem is not listed twice.
 *  - summary.circuits counts the circuits that power at least one feed (an outlet with no circuit counts
 *    as its own assumed circuit); summary.quoteTotal is null when installer mode is off.
 *  - Extra exports: mergeRunInfo, collectWarnings, summarize, emptyMeasured, emptyPower.
 */
LP.define('plan', ['catalog', 'bom'], function (catalog, bom) {
  'use strict';

  const LEVEL_ORDER = { danger: 0, warn: 1, info: 2 };
  const STAGE_TEXT = {
    library: 'the product library',
    measure: 'the measurements',
    design: 'the light runs',
    power: 'the power and cord plan',
    merge: 'which outlet powers each run',
    bom: 'the bill of materials',
    quote: 'the quote',
    checklist: 'the install checklist',
    summary: 'the plan summary',
  };

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const round = (v, d) => { const k = Math.pow(10, d); return Math.round(fin(v, 0) * k) / k; };

  /** A core module by name, or an Error when it is not loaded. */
  function moduleOf(name) {
    const reg = typeof LP !== 'undefined' ? LP : null;
    if (!reg || !reg.has(name)) throw new Error('LightPlan module "' + name + '" is not loaded.');
    return reg.require(name);
  }

  // ---------------------------------------------------------------- empty stage results
  function emptyMeasured() {
    const byType = {};
    for (const t of catalog.TYPE_ORDER) byType[t] = { count: 0, lengthFt: 0, withWasteFt: 0, lights: 0 };
    return {
      ok: false, cameras: {}, planes: {}, pitch: { rise: 6, run: 12, source: 'default', angleDeg: null, samples: [] },
      features: {}, totals: { byType, totalFt: 0, totalWithWasteFt: 0 }, warnings: [],
    };
  }
  function emptyPower() {
    return {
      chains: [], feeds: [], outlets: [], circuits: [], runInfo: {}, cords: [],
      counts: { timers: 0, splitters: 0, cordCovers: 0, gfciAdapters: 0 }, totals: { watts: 0, amps: 0 }, warnings: [],
    };
  }
  function emptyQuote() {
    return {
      ok: false, enabled: false, materialsCost: 0, markupPct: 0, materialsPrice: 0, laborMethod: 'perFt', linearFt: 0,
      laborHours: 0, laborCost: 0, takedownFee: 0, storageFee: 0, taxPct: 0, tax: 0, total: 0, lines: [], validDays: 0, notes: '',
    };
  }
  /** Fill any missing top-level keys so later stages can read the result without checks. */
  function completeMeasured(m) {
    const base = emptyMeasured();
    const out = Object.assign({}, base, m);
    for (const k of ['cameras', 'planes', 'features']) if (!isObj(out[k])) out[k] = {};
    if (!isObj(out.totals)) out.totals = base.totals;
    else if (!isObj(out.totals.byType)) out.totals = Object.assign({}, out.totals, { byType: base.totals.byType });
    if (!Array.isArray(out.warnings)) out.warnings = [];
    return out;
  }
  function completePower(p) {
    const base = emptyPower();
    const out = Object.assign({}, base, p);
    for (const k of ['chains', 'feeds', 'outlets', 'circuits', 'cords', 'warnings']) if (!Array.isArray(out[k])) out[k] = [];
    for (const k of ['runInfo', 'counts', 'totals']) if (!isObj(out[k])) out[k] = base[k];
    return out;
  }

  // ---------------------------------------------------------------- merge power info into runs
  /** New run objects with start, end, reversed, chainId, feedIds, outletId and circuitId from power.runInfo. */
  function mergeRunInfo(runs, power) {
    const info = isObj(power) && isObj(power.runInfo) ? power.runInfo : {};
    return arr(runs).filter(isObj).map((run) => {
      const out = Object.assign({}, run);
      out.feedIds = arr(run.feedIds).slice();
      const ri = Object.prototype.hasOwnProperty.call(info, run.id) && isObj(info[run.id]) ? info[run.id] : null;
      if (!ri) return out;
      out.start = Array.isArray(ri.start) ? ri.start.slice() : null;
      out.end = Array.isArray(ri.end) ? ri.end.slice() : null;
      out.reversed = ri.reversed === true;
      out.chainId = ri.chainId == null ? null : ri.chainId;
      out.feedIds = arr(ri.feedIds).slice();
      out.outletId = ri.outletId == null ? null : ri.outletId;
      out.circuitId = ri.circuitId == null ? null : ri.circuitId;
      return out;
    });
  }

  // ---------------------------------------------------------------- warnings
  const ID_KEYS = ['featureId', 'planeId', 'outletId', 'circuitId', 'stage'];
  function cleanWarning(w) {
    if (!isObj(w) || typeof w.message !== 'string' || !w.message.trim()) return null;
    const out = {
      level: Object.prototype.hasOwnProperty.call(LEVEL_ORDER, w.level) ? w.level : 'warn',
      code: typeof w.code === 'string' && w.code ? w.code : 'note',
      message: w.message.trim(),
    };
    for (const k of ID_KEYS) if (w[k] != null) out[k] = w[k];
    return out;
  }
  /**
   * Internal, measurement, power and run warnings in one list: deduplicated by message (keeping the most
   * severe level), danger first, then warn, then info, otherwise in the order the stages reported them.
   */
  function collectWarnings(internal, measured, power, runs) {
    const all = [];
    for (const w of arr(internal)) all.push(w);
    const m = isObj(measured) ? measured : {};
    for (const w of arr(m.warnings)) all.push(w);
    for (const w of arr(isObj(power) ? power.warnings : null)) all.push(w);
    const unmeasured = new Set(arr(m.warnings).filter((w) => isObj(w) && w.code === 'feature-unmeasured').map((w) => w.featureId));
    for (const run of arr(runs)) {
      if (!isObj(run)) continue;
      for (const text of arr(run.warnings)) {
        if (typeof text !== 'string') continue;
        if (unmeasured.has(run.featureId) && /^Not measured yet/.test(text)) continue;
        all.push({ level: 'warn', code: 'run', message: text, featureId: run.featureId });
      }
    }
    const out = [];
    const byMessage = new Map();
    for (const raw of all) {
      const w = cleanWarning(raw);
      if (!w) continue;
      const seen = byMessage.get(w.message);
      if (seen) {
        if (LEVEL_ORDER[w.level] < LEVEL_ORDER[seen.level]) seen.level = w.level;
        continue;
      }
      byMessage.set(w.message, w);
      out.push(w);
    }
    // Array.prototype.sort is stable, so each level keeps the reporting order.
    return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  }

  // ---------------------------------------------------------------- summary
  /**
   * Headline numbers. `power` may be null when the power stage failed: watts and amps then come from
   * the runs themselves (voltage from the library config), and cords, timers and outlets are 0.
   */
  function summarize(measured, runs, power, bomResult, quote, voltage) {
    const totals = isObj(measured) && isObj(measured.totals) ? measured.totals : emptyMeasured().totals;
    const runList = arr(runs).filter(isObj);
    const pw = isObj(power) ? power : emptyPower();
    const strings = runList.reduce((s, r) => s + (r.unit === 'string' ? Math.max(0, fin(r.quantity, 0)) : 0), 0);
    const clips = runList.reduce((s, r) => s + (isObj(r.clips) ? Math.max(0, fin(r.clips.count, 0)) : 0), 0);
    const cords = arr(pw.cords).reduce((s, c) => s + (isObj(c) ? Math.max(0, fin(c.count, 0)) : 0), 0);
    const pwTotals = isObj(power) && isObj(power.totals) && Number.isFinite(power.totals.watts) ? power.totals : null;
    const watts = pwTotals ? pwTotals.watts : runList.reduce((s, r) => s + Math.max(0, fin(r.watts, 0)), 0);
    const amps = pwTotals && Number.isFinite(pwTotals.amps) ? pwTotals.amps : watts / (fin(voltage, 0) > 0 ? voltage : 120);
    const feeds = arr(pw.feeds).filter((f) => isObj(f) && f.outletId);
    const circuitKeys = new Set(feeds.map((f) => (f.circuitId ? 'c:' + f.circuitId : 'o:' + f.outletId)));
    const outletsUsed = arr(pw.outlets).filter((o) => isObj(o) && arr(o.feedIds).length > 0).length;
    const byType = isObj(totals.byType) ? JSON.parse(JSON.stringify(totals.byType)) : {};
    return {
      totalFt: round(totals.totalFt, 2),
      totalWithWasteFt: round(totals.totalWithWasteFt, 2),
      byType,
      strings: round(strings, 2),
      clips: Math.round(clips),
      cords: Math.round(cords),
      timers: Math.round(fin(isObj(pw.counts) ? pw.counts.timers : 0, 0)),
      watts: round(watts, 2),
      amps: round(amps, 3),
      circuits: circuitKeys.size,
      outletsUsed,
      cost: isObj(bomResult) ? fin(bomResult.subtotal, 0) : 0,
      quoteTotal: isObj(quote) && quote.enabled ? fin(quote.total, 0) : null,
    };
  }

  // ---------------------------------------------------------------- computePlan
  /**
   * The full plan for a project:
   * {library, measured, runs, power, bom, quote, checklist, warnings, summary}. Never throws.
   */
  function computePlan(project) {
    const internal = [];
    function failed(stage) {
      internal.push({
        level: 'danger', code: 'internal-error', stage,
        message: 'LightPlan could not work out ' + STAGE_TEXT[stage] + ', so that part of the plan is empty. ' +
          'Undo your last change, or export the project and report the problem.',
      });
    }
    function stage(name, fn, fallback) {
      try {
        const v = fn();
        if (v === undefined || v === null) throw new Error('empty result');
        return v;
      } catch (e) {
        failed(name);
        return fallback();
      }
    }

    const library = stage('library', () => catalog.getLibrary(isObj(project) ? project : null), () => catalog.getLibrary(null));
    const measured = completeMeasured(stage('measure', () => {
      const m = moduleOf('measure').measureProject(project, library.config);
      if (!isObj(m)) throw new Error('bad measure result');
      return m;
    }, emptyMeasured));
    const designRuns = stage('design', () => {
      const r = moduleOf('design').planRuns(project, measured, library);
      if (!Array.isArray(r)) throw new Error('bad design result');
      return r;
    }, () => []);
    let powerOk = true;
    const power = completePower(stage('power', () => {
      const p = moduleOf('power').planPower(project, measured, designRuns, library);
      if (!isObj(p)) throw new Error('bad power result');
      return p;
    }, () => { powerOk = false; return emptyPower(); }));
    const runs = stage('merge', () => mergeRunInfo(designRuns, power), () => designRuns.filter(isObj).map((r) => Object.assign({}, r)));
    const bomResult = stage('bom', () => {
      const b = bom.buildBom(project, runs, power, library);
      if (!isObj(b) || b.ok === false) throw new Error('bom failed');
      return b;
    }, () => bom.emptyBom());
    const quote = stage('quote', () => {
      const q = bom.buildQuote(project, bomResult, measured, runs, library);
      if (!isObj(q) || q.ok === false) throw new Error('quote failed');
      return q;
    }, emptyQuote);
    const checklist = stage('checklist', () => {
      const c = bom.buildChecklist(project, runs, power, measured);
      if (!Array.isArray(c)) throw new Error('bad checklist');
      return c;
    }, () => []);
    const voltage = isObj(library.config) && isObj(library.config.power) ? library.config.power.voltage : 120;
    const summary = stage('summary', () => summarize(measured, runs, powerOk ? power : null, bomResult, quote, voltage),
      () => summarize(null, [], null, null, null, voltage));
    let warnings;
    try {
      warnings = collectWarnings(internal, measured, power, runs);
    } catch (e) {
      warnings = internal.slice();
    }
    return { library, measured, runs, power, bom: bomResult, quote, checklist, warnings, summary };
  }

  return { computePlan, mergeRunInfo, collectWarnings, summarize, emptyMeasured, emptyPower };
});
