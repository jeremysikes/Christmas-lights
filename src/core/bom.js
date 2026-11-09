/* LightPlan core: bom (SPEC §5.8).
 * Bill of materials, customer quote, install checklist and CSV export, all built from the planned light
 * runs (design.js) and the power plan (power.js). Pure: no DOM, no clock, never mutates its inputs, and
 * never throws on partial or damaged data.
 *
 * Money is USD rounded to cents at every line and total, so a printed quote always adds up.
 *
 * Deviations from SPEC §5.8 (documented signatures and shapes unchanged; these are additive):
 *  - buildBom and buildQuote results carry ok: true, or ok: false plus a plain `reason` (and zeroed
 *    numbers) if the data could not be used at all.
 *  - Light lines are grouped by product + color mode; custom colors are part of the key, so two custom
 *    palettes become two lines ("... - Custom (#ff3b30, #34c759)"). Line names use " - <Color>" suffixes.
 *  - Clip packs add the project waste % to the clip count (as SPEC says); light stakes are bought as
 *    counted (the count already includes one spare per run) in packs of the accessory packSize.
 *  - Quote lines omit Takedown and Storage when the fee is 0 and Tax when the rate is 0. Labor hours are
 *    rounded to the nearest 0.25 h; installed feet to the nearest foot; setup hours apply only when
 *    there is something to install.
 *  - Checklist: several power stakes at one outlet are chained (stake 1 into the timer, each next stake into a
 *    socket of the one before), and the step says how many sockets that gives.
 *  - Checklist: runs that are planned but sit on no feed (power plan missing) get hang steps in the
 *    "No outlet chosen yet" group; runs with nothing to buy are listed in a "Not in the plan yet" group.
 *  - bomToCsv uses CRLF line ends (RFC 4180) and prefixes text cells that start with = + - @ with an
 *    apostrophe so spreadsheet apps do not run them as formulas. The subtotal goes in a summary row after
 *    a blank row, with the amount in the Item column, so summing the Line Total column is not doubled.
 *  - Extra exports: round2, emptyBom.
 */
LP.define('bom', ['catalog'], function (catalog) {
  'use strict';

  const { CLIP_TYPES, COLOR_MODES } = catalog;
  const CATEGORIES = ['lights', 'clips', 'cords', 'power', 'hardware'];
  const EPS = 1e-9;
  const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'], pack: ['pack', 'packs'], each: ['each', 'each'] };

  // ---------------------------------------------------------------- small helpers
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const nonNeg = (v, d) => { const n = fin(v, null); return n !== null && n >= 0 ? n : d; };
  const pos = (v) => { const n = fin(v, null); return n !== null && n > 0 ? n : null; };

  /** Round to cents without binary noise (1.005 → 1.01). */
  function round2(v) {
    const n = fin(v, 0);
    const sign = n < 0 ? -1 : 1;
    return (sign * Math.round(Number((Math.abs(n) * 100).toPrecision(12)))) / 100;
  }
  const roundTo = (v, step) => Math.round(Number((fin(v, 0) / step).toPrecision(12))) * step;

  /** "1,234" or "1,234.5": up to `decimals` decimals, trailing zeros trimmed, thousands separators. */
  function fmtNum(v, decimals) {
    if (!Number.isFinite(v)) return '?';
    const d = decimals === undefined ? 1 : decimals;
    const k = Math.pow(10, d);
    const r = Math.round(Math.abs(v) * k) / k;
    const parts = String(r).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 && r !== 0 ? '-' : '') + parts.join('.');
  }
  function unitWord(unit, n) {
    const w = UNIT_WORDS[unit] || ['unit', 'units'];
    return Math.abs(n - 1) < EPS ? w[0] : w[1];
  }
  function listText(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }
  /** First n items, then "N more". */
  function shortList(items, n) {
    return items.length > n ? items.slice(0, n).concat([(items.length - n) + ' more']) : items.slice();
  }
  function getLib(project, library) {
    if (isObj(library) && Array.isArray(library.products) && isObj(library.config)) return library;
    try { return catalog.getLibrary(isObj(project) ? project : null); } catch (e) { return catalog.getLibrary(null); }
  }
  function wastePctOf(project) {
    const s = isObj(project) && isObj(project.settings) ? project.settings : {};
    const w = fin(s.wastePct, null);
    return w !== null && w >= 0 ? w : 10;
  }
  function colorLabel(mode) { return (COLOR_MODES[mode] && COLOR_MODES[mode].label) || 'Warm white'; }
  function emptyCategories() { const o = {}; for (const c of CATEGORIES) o[c] = 0; return o; }
  function emptyBom(reason) {
    const b = { ok: !reason, lines: [], subtotal: 0, byCategory: emptyCategories() };
    if (reason) b.reason = reason;
    return b;
  }
  /** Outlet has GFCI protection (same rule as power.js: explicit flag, else exterior GFCI type). */
  const hasGfci = (o) => o.gfci === true || (o.gfci == null && o.type === 'exteriorGfci');

  // ================================================================ buildBom
  /**
   * Bill of materials: lights (by product + color), clips (packs, plus waste), cords (by gauge and length),
   * timers, power stakes, GFCI adapters, light stakes and cord covers.
   * Returns {ok, lines: [BomLine], subtotal, byCategory: {lights, clips, cords, power, hardware}}.
   */
  function buildBom(project, runs, power, library) {
    try {
      return buildBomUnsafe(project, runs, power, library);
    } catch (e) {
      return emptyBom('The bill of materials could not be worked out from this project data.');
    }
  }

  function buildBomUnsafe(project, runs, power, library) {
    const lib = getLib(project, library);
    const config = lib.config || catalog.DEFAULT_CONFIG;
    const accessories = arr(lib.accessories).length ? lib.accessories : catalog.ACCESSORIES;
    const overrides = isObj(project) && isObj(project.pricing) && isObj(project.pricing.overrides) ? project.pricing.overrides : {};
    const wastePct = wastePctOf(project);
    const runList = arr(runs).filter(isObj);
    const pw = isObj(power) ? power : {};
    const lines = [];

    /** One BOM line. unitPrice = price override for the SKU, else the library price. */
    function addLine(category, sku, name, qty, unit, defaultPrice, notes) {
      if (!(qty > 0)) return;
      const def = round2(nonNeg(defaultPrice, 0));
      const ov = overrides[sku];
      const ovNum = typeof ov === 'string' && ov.trim() !== '' ? Number(ov) : ov;
      const overridden = typeof ovNum === 'number' && Number.isFinite(ovNum) && ovNum >= 0;
      const unitPrice = overridden ? round2(ovNum) : def;
      lines.push({
        sku, category, name, qty, unit, unitPrice, defaultPrice: def, overridden,
        lineTotal: round2(qty * unitPrice), notes: notes || '',
      });
    }
    const accessory = (sku) => catalog.getAccessory(accessories, sku) || catalog.getAccessory(catalog.ACCESSORIES, sku);

    // ---- lights: one line per product + color, in the order the runs list them
    const groups = new Map();
    for (const run of runList) {
      const qty = fin(run.quantity, 0);
      if (!(qty > 0) || !run.productId) continue;
      const product = catalog.getProduct(lib.products, run.productId);
      const mode = typeof run.colorMode === 'string' && run.colorMode ? run.colorMode : 'warmWhite';
      const colors = arr(run.colors).filter((c) => typeof c === 'string');
      const key = run.productId + '|' + mode + (mode === 'custom' ? '|' + colors.join(',') : '');
      let g = groups.get(key);
      if (!g) {
        const baseName = (product && product.name) || run.productName || run.productId;
        const suffix = mode === 'custom' && colors.length ? colorLabel(mode) + ' (' + colors.join(', ') + ')' : colorLabel(mode);
        g = {
          sku: (product && (product.sku || product.id)) || run.productId,
          name: baseName + ' - ' + suffix,
          unit: (product && product.unit) || run.unit || 'string',
          price: product ? product.price : null,
          qty: 0,
          uses: [],
        };
        groups.set(key, g);
      }
      g.qty += qty;
      g.uses.push((run.label || 'A run') + ' (' + fmtNum(qty, 2) + ')');
    }
    for (const g of groups.values()) {
      const priceNote = Number.isFinite(g.price) ? '' : ' No price in the product library.';
      addLine('lights', g.sku, g.name, roundQty(g.qty), g.unit, g.price, 'For ' + shortList(g.uses, 6).join(', ') + '.' + priceNote);
    }

    // ---- clips: one line per clip type, packs of the accessory pack size, waste % added
    const clipCounts = new Map();
    for (const run of runList) {
      const c = run.clips;
      if (!isObj(c) || !CLIP_TYPES[c.type] || !(fin(c.count, 0) > 0)) continue;
      clipCounts.set(c.type, (clipCounts.get(c.type) || 0) + Math.ceil(c.count));
    }
    for (const type of Object.keys(CLIP_TYPES)) {
      const count = clipCounts.get(type);
      if (!count) continue;
      const info = CLIP_TYPES[type];
      const acc = accessory(info.sku);
      const packSize = pos(acc && acc.packSize) || pos(config.clipPackSize) || 100;
      const withWaste = Math.ceil(count * (1 + wastePct / 100) - EPS);
      const packs = Math.ceil(withWaste / packSize - EPS);
      const noun = type === 'zipTie' ? 'zip ties' : 'clips';
      addLine('clips', info.sku, (acc && acc.name) || info.label, packs, (acc && acc.unit) || 'pack', acc ? acc.price : 0,
        `${fmtNum(count, 0)} ${noun} + ${fmtNum(wastePct, 1)}% spare = ${fmtNum(withWaste, 0)}, in packs of ${fmtNum(packSize, 0)}.`);
    }

    // ---- cords: pieces from the power plan, by gauge and length
    const cordUses = new Map();
    for (const f of arr(pw.feeds)) {
      if (!isObj(f) || !isObj(f.cord) || !Number.isFinite(f.cord.awg)) continue;
      const where = isObj(f.start) && f.start.label ? 'the ' + f.start.label : 'a feed';
      for (const L of arr(f.cord.pieces)) {
        const k = f.cord.awg + '|' + L;
        if (!cordUses.has(k)) cordUses.set(k, []);
        if (!cordUses.get(k).includes(where)) cordUses.get(k).push(where);
      }
    }
    for (const c of arr(pw.cords)) {
      if (!isObj(c) || !Number.isFinite(c.awg) || !(c.lengthFt > 0) || !(c.count > 0)) continue;
      const sku = catalog.cordSku(c.awg, c.lengthFt);
      const acc = accessory(sku);
      const table = catalog.CORD_PRICES[c.awg];
      const price = acc ? acc.price : (table && Number.isFinite(table[c.lengthFt]) ? table[c.lengthFt] : null);
      const uses = cordUses.get(c.awg + '|' + c.lengthFt) || [];
      const note = (uses.length ? 'For the cord' + (uses.length > 1 ? 's' : '') + ' to ' + listText(shortList(uses, 3)) + '.' : '') +
        (Number.isFinite(price) ? '' : ' No price in the product library.');
      addLine('cords', sku, (acc && acc.name) || `Outdoor extension cord, ${c.awg} AWG, ${c.lengthFt} ft`, Math.round(c.count),
        (acc && acc.unit) || 'each', price, note.trim());
    }

    // ---- power accessories: timers, power stakes, GFCI adapters
    const counts = isObj(pw.counts) ? pw.counts : {};
    const pwOutlets = arr(pw.outlets).filter(isObj);
    const projOutlets = isObj(project) ? arr(project.outlets).filter(isObj) : [];
    const outletLabel = (o) => o.label || 'Outlet';
    const used = pwOutlets.filter((o) => arr(o.feedIds).length > 0);
    const accLine = (category, sku, qty, notes) => {
      const n = Math.round(fin(qty, 0));
      if (!(n > 0)) return;
      const acc = accessory(sku);
      addLine(category, sku, (acc && acc.name) || sku, n, (acc && acc.unit) || 'each', acc ? acc.price : 0, notes);
    };
    const timerOutlets = pwOutlets.filter((o) => o.timer).map(outletLabel);
    accLine('power', 'timer-outdoor', counts.timers, timerOutlets.length ? 'One for each outlet used: ' + listText(shortList(timerOutlets, 4)) + '.' : '');
    const splitOutlets = pwOutlets.filter((o) => o.splitters > 0).map(outletLabel);
    accLine('power', 'splitter-3', counts.splitters, splitOutlets.length ? 'For outlets that feed more than one cord: ' + listText(shortList(splitOutlets, 4)) + '.' : '');
    const noGfci = used.map((o) => projOutlets.find((p) => p.id === o.id)).filter((o) => o && !hasGfci(o)).map(outletLabel);
    accLine('power', 'gfci-adapter', counts.gfciAdapters, noGfci.length ? 'For outlets without GFCI protection: ' + listText(shortList(noGfci, 4)) + '.' : '');

    // ---- hardware: light stakes (packs) and walkway cord covers
    const stakeCount = runList.reduce((s, r) => s + Math.max(0, Math.ceil(fin(r.lightStakes, 0))), 0);
    if (stakeCount > 0) {
      const acc = accessory('light-stakes');
      const packSize = pos(acc && acc.packSize) || pos(config.stakes && config.stakes.packSize) || 25;
      const packs = Math.ceil(stakeCount / packSize - EPS);
      const where = runList.filter((r) => fin(r.lightStakes, 0) > 0).map((r) => r.label || 'a run');
      addLine('hardware', 'light-stakes', (acc && acc.name) || 'Light stakes', packs, (acc && acc.unit) || 'pack', acc ? acc.price : 0,
        `${fmtNum(stakeCount, 0)} stakes for ${listText(shortList(where, 3))}, in packs of ${fmtNum(packSize, 0)}.`);
    }
    accLine('hardware', 'cord-cover', counts.cordCovers, 'Where a cord crosses a walkway.');

    // ---- totals
    lines.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)); // stable within a category
    const byCategory = emptyCategories();
    for (const l of lines) byCategory[l.category] = round2(byCategory[l.category] + l.lineTotal);
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    return { ok: true, lines, subtotal, byCategory };
  }
  /** Quantities are whole units for everything except odd per-foot products; keep 2 decimals at most. */
  function roundQty(q) { return Math.abs(q - Math.round(q)) < 1e-6 ? Math.round(q) : Math.round(q * 100) / 100; }

  // ================================================================ buildQuote
  function quoteSettings(project) {
    const q = isObj(project) && isObj(project.quote) ? project.quote : {};
    return {
      enabled: q.enabled === true,
      laborMethod: q.laborMethod === 'perHour' ? 'perHour' : 'perFt',
      ratePerFt: nonNeg(q.ratePerFt, 3.5),
      ratePerHour: nonNeg(q.ratePerHour, 65),
      markupPct: nonNeg(q.markupPct, 30),
      takedownFee: round2(nonNeg(q.takedownFee, 150)),
      storageFee: round2(nonNeg(q.storageFee, 75)),
      taxPct: Math.min(100, nonNeg(q.taxPct, 0)),
      validDays: Number.isInteger(q.validDays) && q.validDays >= 0 ? q.validDays : 30,
      notes: typeof q.notes === 'string' ? q.notes : '',
    };
  }

  /**
   * Customer quote. Materials are marked up; labor is per installed foot (trees and bushes hourly) or
   * per estimated hour; takedown and storage are flat fees; tax applies to the marked-up materials.
   */
  function buildQuote(project, bom, measured, runs, library) {
    try {
      return buildQuoteUnsafe(project, bom, measured, runs, library);
    } catch (e) {
      const s = quoteSettings(null);
      return {
        ok: false, reason: 'The quote could not be worked out from this project data.',
        enabled: false, materialsCost: 0, markupPct: s.markupPct, materialsPrice: 0, laborMethod: s.laborMethod, linearFt: 0,
        laborHours: 0, laborCost: 0, takedownFee: 0, storageFee: 0, taxPct: 0, tax: 0, total: 0, lines: [], validDays: s.validDays, notes: '',
      };
    }
  }

  function buildQuoteUnsafe(project, bom, measured, runs, library) {
    const s = quoteSettings(project);
    const labor = (getLib(project, library).config || {}).labor || {};
    const ftPerHour = pos(labor.ftPerHour) || 40;
    const setupHours = nonNeg(labor.setupHours, 1);
    const hoursPerTree = nonNeg(labor.hoursPerTree, 0.75);
    const hoursPerBush = nonNeg(labor.hoursPerBush, 0.25);

    // What gets installed: linear feet of planned runs, plus trees and bushes priced by the hour.
    let feet = 0, trees = 0, bushes = 0;
    if (Array.isArray(runs)) {
      for (const r of runs) {
        if (!isObj(r) || !(fin(r.quantity, 0) > 0)) continue;
        if (r.featureType === 'tree') trees += 1;
        else if (r.featureType === 'bush') bushes += 1;
        else feet += Math.max(0, fin(r.lengthFt, 0));
      }
    } else if (isObj(measured) && isObj(measured.totals)) {
      // No runs: fall back to measured totals (bushes are already excluded from totalFt).
      const bt = isObj(measured.totals.byType) ? measured.totals.byType : {};
      const treeFt = isObj(bt.tree) ? fin(bt.tree.lengthFt, 0) : 0;
      feet = Math.max(0, fin(measured.totals.totalFt, 0) - treeFt);
      trees = isObj(bt.tree) ? fin(bt.tree.count, 0) : 0;
      bushes = isObj(bt.bush) ? fin(bt.bush.count, 0) : 0;
    }
    const linearFt = Math.round(feet);
    const extraHours = roundTo(trees * hoursPerTree + bushes * hoursPerBush, 0.25);
    const hasWork = linearFt > 0 || trees > 0 || bushes > 0;
    const laborHours = hasWork ? roundTo(linearFt / ftPerHour + setupHours + trees * hoursPerTree + bushes * hoursPerBush, 0.25) : 0;
    const laborCost = round2(s.laborMethod === 'perFt' ? linearFt * s.ratePerFt + extraHours * s.ratePerHour : laborHours * s.ratePerHour);

    const materialsCost = round2(isObj(bom) ? nonNeg(bom.subtotal, 0) : 0);
    const materialsPrice = round2(materialsCost * (1 + s.markupPct / 100));
    const tax = round2(materialsPrice * s.taxPct / 100);
    const total = round2(materialsPrice + laborCost + s.takedownFee + s.storageFee + tax);

    const lines = [{ description: 'Materials', amount: materialsPrice }];
    lines.push({ description: `Installation labor (${fmtNum(linearFt, 0)} ft, ${fmtNum(laborHours, 2)} h)`, amount: laborCost });
    if (s.takedownFee > 0) lines.push({ description: 'Takedown', amount: s.takedownFee });
    if (s.storageFee > 0) lines.push({ description: 'Storage', amount: s.storageFee });
    if (s.taxPct > 0) lines.push({ description: `Tax (${fmtNum(s.taxPct, 3)}%)`, amount: tax });
    lines.push({ description: 'Total', amount: total });

    return {
      ok: true, enabled: s.enabled, materialsCost, markupPct: s.markupPct, materialsPrice, laborMethod: s.laborMethod,
      linearFt, laborHours, laborCost, takedownFee: s.takedownFee, storageFee: s.storageFee, taxPct: s.taxPct, tax, total,
      lines, validDays: s.validDays, notes: s.notes,
    };
  }

  // ================================================================ buildChecklist
  /**
   * Install checklist: one group per outlet (project order), each in feed order: GFCI adapter → timer →
   * power stake → for each cord: run the cord → clips/stakes → hang from the start end → continue into
   * the next chained run → test. Then feeds with no outlet, runs not in the plan, and a final safety
   * and test group. Returns [{outletId|null, title, steps: [string]}].
   */
  function buildChecklist(project, runs, power, measured) { // eslint-disable-line no-unused-vars
    // `measured` is part of the SPEC signature; every number the checklist needs is already on the runs.
    try {
      return buildChecklistUnsafe(project, runs, power);
    } catch (e) {
      return [{ outletId: null, title: 'Install checklist', steps: ['The install checklist could not be made from this project data. Check the plan warnings.'] }];
    }
  }

  function buildChecklistUnsafe(project, runs, power) {
    const proj = isObj(project) ? project : {};
    const pw = isObj(power) ? power : {};
    const config = getLib(proj, null).config || catalog.DEFAULT_CONFIG;
    const clipSpacing = pos(config.clipSpacingIn) || 12;
    const stakeSpacing = pos(config.stakes && config.stakes.spacingIn) || 12;
    const runList = arr(runs).filter((r) => isObj(r) && typeof r.id === 'string');
    const runById = new Map(runList.map((r) => [r.id, r]));
    const featureById = new Map(arr(proj.features).filter(isObj).map((f) => [f.id, f]));
    const feeds = arr(pw.feeds).filter((f) => isObj(f) && typeof f.id === 'string');
    const portions = allocatePortions(feeds, arr(pw.chains), runById);
    const projOutlets = arr(proj.outlets).filter((o) => isObj(o) && typeof o.id === 'string');
    const pwOutlets = new Map(arr(pw.outlets).filter(isObj).map((o) => [o.id, o]));
    const circuits = new Map(arr(proj.circuits).filter(isObj).map((c) => [c.id, c]));
    const groups = [];

    const sideOf = (run) => startSideLabel(run, featureById.get(run.featureId));
    /** "around" for closed outlines (windows, bushes), "along" for open lines. */
    const prepOf = (run) => {
      const f = featureById.get(run.featureId);
      const t = catalog.FEATURE_TYPES[run.featureType];
      return (f && f.closed === true) || (t && t.geometry === 'area') ? 'around' : 'along';
    };

    /** Steps for one feed: cord, then each run portion (clips, stakes, hang), then a test. */
    function feedSteps(feed, cordText, timer, prefix) {
      const steps = [prefix + cordText];
      if (feed.crossesWalkway) steps.push('Lay a cord cover over the cord where it crosses the walkway.');
      const list = portions.get(feed.id) || [];
      list.forEach((p, j) => {
        const run = p.run;
        const label = run.label || 'this run';
        if (p.startsRun && isObj(run.clips) && fin(run.clips.count, 0) > 0) steps.push(clipStep(run, label, clipSpacing, prepOf(run)));
        if (p.startsRun && fin(run.lightStakes, 0) > 0) {
          steps.push(`Push ${fmtNum(Math.ceil(run.lightStakes), 0)} light stakes into the ground along ${label}, one every ${fmtNum(stakeSpacing, 1)} in.`);
        }
        const what = quantityText(p);
        const noun = run.unit === 'foot' ? 'section' : unitWord(run.unit, 1);
        if (j === 0) {
          const start = feed.start && feed.start.label ? feed.start.label : sideOf(run);
          steps.push(`${verbPhrase(run, what, label, prepOf(run))}, starting at the ${start}. Plug the first ${noun} into the cord.`);
        } else {
          const prev = list[j - 1].run;
          const prevNoun = prev.unit === 'foot' ? 'section' : unitWord(prev.unit, 1);
          const start = p.startsRun ? sideOf(run) : 'point where the last one ended';
          steps.push(`Continue into ${label}: plug its first ${noun} into the last ${prevNoun} of ${prev.label || 'the previous run'}, ` +
            `then ${lowerFirst(verbPhrase(run, what, label, prepOf(run)))}, starting at the ${start}.`);
        }
      });
      const strings = list.length && list.every((p) => p.run.unit === 'string') ? list.reduce((s, p) => s + p.units, 0) : null;
      const lights = strings === null ? 'every light on this cord works'
        : Math.abs(strings - 1) < EPS ? 'the string on this cord lights' : `all ${fmtNum(strings, 2)} strings on this cord light`;
      steps.push(timer
        ? `Test: switch the timer on and check that ${lights}. Fix dead bulbs or blown fuses, then switch it off.`
        : `Test: plug the cord in and check that ${lights}. Fix dead bulbs or blown fuses, then unplug it.`);
      return steps;
    }

    // ---- one group per outlet that powers something, in project order
    const feedsAt = (oid) => feeds.filter((f) => f.outletId === oid);
    const outletIds = projOutlets.map((o) => o.id);
    for (const id of pwOutlets.keys()) if (!outletIds.includes(id)) outletIds.push(id);
    for (const oid of outletIds) {
      const fs = feedsAt(oid);
      if (!fs.length) continue;
      const o = projOutlets.find((x) => x.id === oid) || pwOutlets.get(oid) || {};
      const info = pwOutlets.get(oid) || {};
      const label = o.label || 'the outlet';
      const circuit = circuits.get(o.circuitId);
      const title = (o.label || 'Outlet') + (circuit && circuit.name ? ' (' + circuit.name + ')' : '');
      const timer = info.timer !== undefined ? !!info.timer : (isObj(config.power) ? config.power.timerPerOutlet !== false : true);
      const steps = [];
      const adapter = projOutlets.some((x) => x.id === oid) && !hasGfci(o);
      if (adapter) steps.push(`Plug a portable outdoor GFCI adapter into ${label}.`);
      if (timer) steps.push(`Plug an outdoor timer or smart plug into ${adapter ? 'the GFCI adapter' : label} and leave it switched off while you work.`);
      const splitters = Math.max(0, Math.round(fin(info.splitters, 0)));
      const per = Math.max(2, Math.round(pos(isObj(config.power) ? config.power.splitterOutlets : null) || 3));
      const into = timer ? 'timer' : 'outlet';
      if (splitters === 1) {
        steps.push(`Plug an outdoor power stake (${per} outlets each) into the ${into} so it can feed ${fs.length} cords.`);
      } else if (splitters > 1) {
        // Stakes are chained: the first goes into the timer, each other one into a free socket of the stake before it.
        const sockets = splitters * (per - 1) + 1;
        steps.push(`Plug an outdoor power stake (${per} outlets) into the ${into}, then plug each of the other ${splitters - 1} stakes into a free socket ` +
          `of the stake before it. The ${splitters} stakes give ${sockets} sockets for the ${fs.length} cords.`);
      }
      fs.forEach((f, i) => {
        const prefix = fs.length > 1 ? `Cord ${i + 1} of ${fs.length}: ` : '';
        steps.push(...feedSteps(f, cordStep(f, label), timer, prefix));
      });
      if (timer) steps.push(`Set the timer on ${label} to switch the lights on at dusk and off at bedtime.`);
      groups.push({ outletId: oid, title, steps });
    }

    // ---- feeds with no outlet, plus planned runs that are on no feed (power plan missing)
    const knownOutlets = new Set(outletIds);
    const orphanFeeds = feeds.filter((f) => !f.outletId || !knownOutlets.has(f.outletId));
    const onFeed = new Set();
    for (const f of feeds) for (const id of arr(f.runIds)) onFeed.add(id);
    const loose = runList.filter((r) => !onFeed.has(r.id) && fin(r.quantity, 0) > 0 && r.productId);
    for (const r of loose) {
      // Pseudo-feed so the run still gets its clip, hang and test steps.
      const id = 'loose_' + r.id;
      orphanFeeds.push({ id, runIds: [r.id], strings: r.quantity, start: { label: sideOf(r) } });
      portions.set(id, [{ run: r, units: r.quantity, total: r.quantity, startsRun: true, endsRun: true }]);
    }
    if (orphanFeeds.length) {
      const steps = ['Mark the outlet that will power these lights on the photo, so LightPlan can size the cords and check the circuit.'];
      orphanFeeds.forEach((f, i) => {
        const dest = f.start && f.start.label ? 'the ' + f.start.label : 'the start of the run';
        const prefix = orphanFeeds.length > 1 ? `Cord ${i + 1} of ${orphanFeeds.length}: ` : '';
        steps.push(...feedSteps(f, `Run an outdoor extension cord from the nearest GFCI-protected outdoor outlet to ${dest}.`, false, prefix));
      });
      groups.push({ outletId: null, title: 'No outlet chosen yet', steps });
    }

    // ---- runs with nothing to hang yet
    const notPlanned = runList.filter((r) => !onFeed.has(r.id) && !loose.includes(r));
    if (notPlanned.length) {
      groups.push({
        outletId: null, title: 'Not in the plan yet',
        steps: notPlanned.map((r) => `${r.label || 'A run'} is not in this checklist because ${!r.productId ? 'no product is available for it' : 'it is not measured yet'}.`),
      });
    }

    groups.push({ outletId: null, title: 'Safety and final test', steps: safetySteps(pw, projOutlets, feeds) });
    return groups;
  }

  /**
   * Split each feed's units between its runs, walking chains in feed order. power.js fills feeds in
   * run order and only splits a run when it alone exceeds the end-to-end limit, so a greedy walk
   * reproduces its portions exactly. Returns Map feedId → [{run, units, total, startsRun, endsRun}].
   */
  function allocatePortions(feeds, chains, runById) {
    const byId = new Map(feeds.map((f) => [f.id, f]));
    const order = [];
    const seen = new Set();
    for (const c of chains) {
      for (const fid of arr(isObj(c) ? c.feedIds : null)) {
        if (byId.has(fid) && !seen.has(fid)) { seen.add(fid); order.push(byId.get(fid)); }
      }
    }
    for (const f of feeds) if (!seen.has(f.id)) { seen.add(f.id); order.push(f); }
    const used = new Map();
    const out = new Map();
    for (const feed of order) {
      let left = fin(feed.strings, Infinity);
      const list = [];
      for (const rid of arr(feed.runIds)) {
        const run = runById.get(rid);
        if (!run) continue;
        const total = Math.max(0, fin(run.quantity, 0));
        const before = used.get(rid) || 0;
        const take = Math.max(0, Math.min(total - before, left));
        used.set(rid, before + take);
        left -= take;
        list.push({ run, units: roundQty(take), total, startsRun: before <= EPS, endsRun: before + take >= total - EPS });
      }
      out.set(feed.id, list);
    }
    return out;
  }

  function cordStep(feed, outletLabel) {
    const dest = isObj(feed.start) && feed.start.label ? 'the ' + feed.start.label : 'the start of the run';
    const c = feed.cord;
    if (isObj(c) && Number.isFinite(c.awg) && arr(c.pieces).length) {
      const pieces = c.pieces.filter((p) => p > 0);
      const need = Number.isFinite(c.lengthFt) ? ` (about ${fmtNum(Math.ceil(c.lengthFt), 0)} ft needed)` : '';
      if (pieces.length === 1) return `Run a ${fmtNum(pieces[0], 0)} ft, ${c.awg} AWG outdoor extension cord from ${outletLabel} to ${dest}${need}.`;
      const sum = pieces.reduce((s, p) => s + p, 0);
      return `Run ${fmtNum(sum, 0)} ft of ${c.awg} AWG outdoor extension cord (${pieces.map((p) => fmtNum(p, 0) + ' ft').join(' + ')}, joined end to end) ` +
        `from ${outletLabel} to ${dest}${need}. Keep the joints off the ground.`;
    }
    if (feed.cordUnknown) return `Run an outdoor extension cord from ${outletLabel} to ${dest}. Measure that distance on site, because the photo cannot size this cord.`;
    return `Run an outdoor extension cord from ${outletLabel} to ${dest}.`;
  }

  function clipStep(run, label, spacing, prep) {
    const count = fmtNum(Math.ceil(run.clips.count), 0);
    const every = `one every ${fmtNum(spacing, 1)} in`;
    if (run.clips.type === 'adhesive') return `Stick ${count} adhesive clips ${prep} ${label}, ${every}. Wipe the surface clean and dry first.`;
    if (run.clips.type === 'zipTie') return `Have ${count} zip ties ready to fasten the lights to ${label}, ${every}.`;
    const info = CLIP_TYPES[run.clips.type];
    return `Put up ${count} ${(info ? info.label : 'light clips').toLowerCase()} ${prep} ${label}, ${every}.`;
  }

  /** "warm white C9 LED string, 25 bulbs" or "C9 LED string, 25 bulbs in custom colors #ff3b30, #34c759". */
  function coloredName(run) {
    const name = run.productName || run.productId || 'lights';
    if (run.colorMode === 'custom') {
      const cs = arr(run.colors).filter((c) => typeof c === 'string');
      return name + ' in custom colors' + (cs.length ? ' ' + cs.join(', ') : '');
    }
    return colorLabel(run.colorMode).toLowerCase() + ' ' + name;
  }
  /** "2 × warm white C9 LED string, 25 bulbs", "the first 30 of the 45 × ...", "48 ft of ...". */
  function quantityText(p) {
    const run = p.run;
    const tail = coloredName(run);
    const partial = p.units < p.total - EPS;
    const n = fmtNum(p.units, 2), t = fmtNum(p.total, 2);
    if (run.unit === 'foot') {
      if (!partial) return `${n} ft of ${tail}`;
      return `${p.startsRun ? 'the first' : p.endsRun ? 'the last' : 'the next'} ${n} of ${t} ft of ${tail}`;
    }
    if (!partial) return `${n} × ${tail}`;
    return `${p.startsRun ? 'the first' : p.endsRun ? 'the last' : 'the next'} ${n} of the ${t} × ${tail}`;
  }
  function verbPhrase(run, what, label, prep) {
    switch (run.method) {
      case 'spiral': return `Wrap ${what} around ${label}`;
      case 'bush-rule': return run.featureType === 'tree' ? `Wrap ${what} through the branches of ${label}` : `Weave ${what} through ${label}`;
      case 'bush-net': return `Drape ${what} over ${label}`;
      case 'path-sets': return `Set out ${what} ${prep} ${label}`;
      case 'per-foot': return `Install ${what} ${prep} ${label}`;
      default: return `Hang ${what} ${prep} ${label}`;
    }
  }
  const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

  /** Where a run starts, in words: "left end of Front eave", "top-left corner of Bay window", "base of Oak tree". */
  function startSideLabel(run, feature) {
    const label = run.label || 'the run';
    const type = catalog.FEATURE_TYPES[run.featureType];
    if (type && type.geometry === 'vertical') return 'base of ' + label;
    const isPt = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    const start = isPt(run.start) ? run.start : null;
    if (!start) return 'start of ' + label;
    const pts = feature ? arr(feature.points).filter(isPt) : [];
    const closed = (feature && feature.closed) || (type && type.geometry === 'area');
    if (closed && pts.length >= 3) {
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const corner = (start[1] <= cy ? 'top' : 'bottom') + '-' + (start[0] <= cx ? 'left' : 'right');
      return corner + (type && type.geometry === 'area' ? ' edge of ' : ' corner of ') + label;
    }
    const end = isPt(run.end) ? run.end : (pts.length ? pts[pts.length - 1] : null);
    if (!end) return 'start of ' + label;
    const dx = start[0] - end[0], dy = start[1] - end[1];
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx <= 0 ? 'left' : 'right') : (dy <= 0 ? 'top' : 'bottom');
    return side + ' end of ' + label;
  }

  function safetySteps(pw, projOutlets, feeds) {
    const steps = [
      'Before you climb, plug in every string on the ground and replace dead bulbs or blown fuses.',
      'Set ladders on firm, level ground, keep three points of contact, and stay at least 10 ft away from overhead power lines.',
      'Use outdoor-rated cords, timers and power stakes only. Keep plugs and joints off the ground and out of puddles, and never staple or nail through a wire.',
      'Plug every cord into a GFCI-protected outlet or a portable GFCI adapter.',
    ];
    const usedOutletIds = new Set(feeds.map((f) => f.outletId).filter(Boolean));
    for (const c of arr(pw.circuits)) {
      if (!isObj(c)) continue;
      const usesIt = arr(c.outletIds).some((id) => usedOutletIds.has(id));
      const load = fin(c.loadW, 0), existing = fin(c.existingLoadW, 0), limit = fin(c.limitW, 0);
      if (!usesIt || !(load > existing) || !(limit > 0)) continue;
      const name = c.name || 'This circuit';
      if (c.overloaded || load > limit + EPS) {
        steps.push(`${name} is over its safe limit: ${fmtNum(load, 0)} W planned against ${fmtNum(limit, 0)} W. Move a run to another circuit before you switch on.`);
      } else {
        const extra = existing > 0 ? ` plus ${fmtNum(existing, 0)} W already on it` : '';
        steps.push(`${name} carries ${fmtNum(load - existing, 0)} W of lights${extra}, ${fmtNum((load / limit) * 100, 0)}% of its ${fmtNum(limit, 0)} W safe limit. Keep heaters and other big loads off it while the lights are on.`);
      }
    }
    steps.push('When everything is up, run the whole display for 30 minutes, then check that no cord, plug or timer feels warm.');
    steps.push('This plan is an estimate, not an electrical inspection. If a breaker trips, unplug a run and ask an electrician.');
    return steps;
  }

  // ================================================================ bomToCsv
  const CSV_HEADER = ['SKU', 'Item', 'Category', 'Qty', 'Unit', 'Unit Price', 'Line Total', 'Notes'];
  /** RFC 4180 field: quote when it holds a comma, quote or line break; double inner quotes. */
  function csvField(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** Text cells only: neutralise leading characters that spreadsheets treat as formulas. */
  function csvText(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }
  const money = (v) => round2(v).toFixed(2);

  /**
   * CSV of the BOM: a header row and one row per line, then a blank row and a summary row
   * ("Subtotal" in the SKU column, the amount in the Item column). The subtotal is kept out of the
   * Line Total column so summing that column in a spreadsheet gives the real total. CRLF line ends.
   */
  function bomToCsv(bom) {
    const b = isObj(bom) ? bom : {};
    const rows = [CSV_HEADER];
    for (const l of arr(b.lines)) {
      if (!isObj(l)) continue;
      rows.push([csvText(l.sku), csvText(l.name), csvText(l.category), Number.isFinite(l.qty) ? String(l.qty) : '',
        csvText(l.unit), money(l.unitPrice), money(l.lineTotal), csvText(l.notes)]);
    }
    const subtotal = Number.isFinite(b.subtotal) ? b.subtotal : arr(b.lines).reduce((s, l) => s + (isObj(l) ? fin(l.lineTotal, 0) : 0), 0);
    const blank = CSV_HEADER.map(() => '');
    rows.push(blank);
    rows.push(['Subtotal', money(subtotal)].concat(blank.slice(2)));
    return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
  }

  return { buildBom, buildQuote, buildChecklist, bomToCsv, round2, emptyBom };
});
