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
 *    config.clipPackSize / config.stakes.packSize (null by default) override the accessory pack sizes when set.
 *  - Quote lines omit Takedown and Storage when the fee is 0 and Tax when the rate is 0. Labor hours are
 *    rounded to the nearest 0.25 h; installed feet to the nearest foot; setup hours apply only when
 *    there is something to install.
 *  - Checklist: feed portions come from power.js (feed.portions: hung strings per run) when present, so the
 *    hang steps count the strings actually hung; a mid-run start says which way to work (feed.start.toward);
 *    the last feed of a chain with spares says to keep them.
 *  - Checklist: several power stakes at one outlet are chained (stake 1 into the timer, each next stake into a
 *    socket of the one before), and the step says how many sockets that gives.
 *  - Checklist: runs that are planned but sit on no feed (power plan missing) get hang steps in the
 *    "No outlet chosen yet" group; runs with nothing to buy are listed in a "Not in the plan yet" group.
 *  - bomToCsv uses CRLF line ends (RFC 4180) and prefixes text cells that start with = + - @ with an
 *    apostrophe so spreadsheet apps do not run them as formulas. The subtotal goes in a summary row after
 *    a blank row, with the amount in the Item column, so summing the Line Total column is not doubled.
 *  - Extra exports: round2, emptyBom.
 *
 * Phase 1.1 (SPEC §8.3), suppliers:
 *  - Every line also says where it is bought: supplierId (null = any store), supplierName, supplierSku (the part
 *    number to type at the supplier, null when it is not confirmed), url (the product page), findUrl (for a line
 *    with no product page: the chosen supplier's category page or search), priceAsOf and priceStatus
 *    ('verified' | 'observed' | 'default' | 'yours'). 'yours' = pricing.overrides has the line's sku, or the
 *    price of a supplier item was edited in the project's own product list. Links are https only.
 *  - Bulk C7/C9 (product.kind 'bulk') is bought as parts, gathered per product across the job: socket wire
 *    (the best mix of the sizes on file that covers the feet, see MIX_RULE: each piece counts as $5 of plugs and
 *    work, a price seen on a category list only as 10% dearer, at most 4 ready-made lengths), bulbs per colour
 *    in packs, and slide-on plugs. These lines are category 'lights'. A bulk product whose parts cannot be priced
 *    falls back to one per-foot line at product.price. The same wire is ordered whatever the cost basis.
 *  - Slide-on plugs are counted from the wire that is bought (plugNeeds): every cut length (one per power feed,
 *    one per run without a power plan; the hung feet, not the feet with waste) needs a male plug where the cord
 *    arrives and a female plug on its far end, a joint between two pieces needs one of each, and a plug a
 *    ready-made length comes with is used where that end of the piece is used. C7 and C9 wire take the same
 *    plugs, so there is one line per plug part for the whole job, and no line when no plug is needed.
 *  - config.buying.costBasis 'used' applies in installer mode only (project.quote.enabled); otherwise every line
 *    is totalled as ordered. The result carries costBasis (the basis applied) and orderTotal (sum of buyTotal).
 *  - A supplier item in a colour it is not sold in (product.colors) and a bulb colour that is not on file keep
 *    the supplier but lose the part number and page, get a findUrl, and are priceStatus 'observed'.
 *  - A supplier timer with a watt limit (offer.maxWatts) is ordered only for outlets within it; an outlet that
 *    carries more gets a generic heavy-duty timer line. Gutter runs use the supplier's all-in-one clip when it
 *    has no gutter clip of its own. Custom colours are named by colour family ("Red and green"), not by code.
 *  - qty is what to order. usedQty is the share of it this job uses (bulk parts only; otherwise equal to qty).
 *    buyTotal = qty × unitPrice. total (and lineTotal, kept for Phase 1 readers) = buyTotal, or
 *    usedQty × unitPrice for bulk parts when the cost basis is 'used'. subtotal and byCategory add up lineTotal.
 *  - When the chosen supplier has its own item for an accessory (clips by mount type, light stakes, timer) the
 *    line takes its sku, name, pack size, price and link; config.clipPackSize / stakes.packSize do not apply to
 *    a supplier's pack. Other accessories stay generic with a findUrl.
 *  - orderSheets(bom, library): the lines grouped per supplier, then "Any store". orderSheetToCsv and
 *    orderSheetToText write one sheet. priceNote(bom) is the "prices were last checked on ..." sentence for
 *    exports; priceStatusText(line) is the short "as of ... (check the price)" label.
 *  - bomToCsv adds Supplier, Part number, Price status and Link columns when a line has any of them; a plan
 *    with no supplier keeps the Phase 1 columns. With cost basis 'used' it adds Used Qty and Order Total columns,
 *    a "To order" row and a note. priceNote says "Supplier prices ... the other prices are typical store prices"
 *    for a list that mixes supplier and any-store lines.
 *  - Checklist: a bulk feed starts with a "cut the wire, add the plugs, screw in the bulbs" step.
 */
LP.define('bom', ['catalog', 'suppliers'], function (catalog, suppliers) {
  'use strict';

  const { CLIP_TYPES, COLOR_MODES } = catalog;
  const CATEGORIES = ['lights', 'clips', 'cords', 'power', 'hardware'];
  const EPS = 1e-9;
  const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'], pack: ['pack', 'packs'], each: ['each', 'each'], spool: ['spool', 'spools'] };

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
  function listText(items, word) {
    const and = ' ' + (word || 'and') + ' ';
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + and + items[1];
    return items.slice(0, -1).join(', ') + and + items[items.length - 1];
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
    const b = { ok: !reason, lines: [], subtotal: 0, byCategory: emptyCategories(), orderTotal: 0, costBasis: 'bought' };
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
    // Who the project buys from (SPEC §8.3): null = "Any store", the Phase 1 behaviour.
    const preferred = preferredSupplier(lib);
    // "Only what is used" is an installer's way of costing a job (leftovers go to the next one), so it applies in
    // installer mode only: with the quote switched off the list is always priced as everything ordered.
    const installer = isObj(project) && isObj(project.quote) && project.quote.enabled === true;
    const usedBasis = installer && isObj(config.buying) && config.buying.costBasis === 'used';

    /** Unit price for a SKU: the user's own price (pricing.overrides) when it is a valid number, else the default. */
    function priceOf(sku, defaultPrice) {
      const def = round2(nonNeg(defaultPrice, 0));
      const ov = overrides[sku];
      const ovNum = typeof ov === 'string' && ov.trim() !== '' ? Number(ov) : ov;
      const overridden = typeof ovNum === 'number' && Number.isFinite(ovNum) && ovNum >= 0;
      return { def, overridden, unitPrice: overridden ? round2(ovNum) : def };
    }
    /**
     * One BOM line. unitPrice = price override for the SKU, else the library price. `meta` says where it is
     * bought: {supplierId, supplierSku, url, priceAsOf, priceStatus} for a supplier's item, {findUrl} for a
     * generic item the chosen supplier may carry, and {usedQty} for bulk parts (the share of `qty` this job uses).
     */
    function addLine(category, sku, name, qty, unit, defaultPrice, notes, meta) {
      if (!(qty > 0)) return;
      const m = isObj(meta) ? meta : {};
      const { def, overridden, unitPrice } = priceOf(sku, defaultPrice);
      const sup = typeof m.supplierId === 'string' && m.supplierId !== suppliers.GENERIC_ID ? suppliers.getSupplier(m.supplierId) : null;
      let priceStatus = 'default';
      if (sup) priceStatus = suppliers.PRICE_STATUSES.includes(m.priceStatus) ? m.priceStatus : 'observed';
      // A supplier price that no longer matches the catalog's was typed in by the user (product library edit).
      const listed = sup ? suppliers.catalogPrice(sku) : null;
      if (overridden || (listed !== null && round2(listed) !== def)) priceStatus = 'yours';
      const buyTotal = round2(qty * unitPrice);
      // Bulk parts: the share of what is ordered that this job uses (wire feet, bulbs, plugs); everything else is used whole.
      const share = typeof m.usedQty === 'number' && Number.isFinite(m.usedQty) && m.usedQty >= 0 && m.usedQty < qty;
      const usedQty = share ? Math.round(m.usedQty * 10000) / 10000 : qty;
      const total = share && usedBasis ? round2(m.usedQty * unitPrice) : buyTotal;
      lines.push({
        sku, category, name, qty, unit, unitPrice, defaultPrice: def, overridden,
        lineTotal: total, notes: notes || '',
        supplierId: sup ? sup.id : null, supplierName: sup ? sup.name : ANY_STORE,
        supplierSku: sup && (typeof m.supplierSku === 'string' || typeof m.supplierSku === 'number') && String(m.supplierSku) ? String(m.supplierSku) : null,
        url: sup ? suppliers.safeUrl(m.url) : null, findUrl: suppliers.safeUrl(m.findUrl),
        priceAsOf: sup && priceStatus !== 'yours' && typeof m.priceAsOf === 'string' && m.priceAsOf ? m.priceAsOf : null,
        priceStatus, usedQty, total, buyTotal,
      });
    }
    const accessory = (sku) => catalog.getAccessory(accessories, sku) || catalog.getAccessory(catalog.ACCESSORIES, sku);
    /** Where an Offer (or supplier product) is bought. */
    const offerMeta = (supplierId, o) => ({ supplierId, supplierSku: o.supplierSku, url: o.url, priceAsOf: o.priceAsOf, priceStatus: o.priceStatus });
    /** The chosen supplier's own item for a generic accessory, when it has one on file. */
    const offerFor = (sku) => (preferred ? suppliers.accessoryOffer(preferred, sku) : null);
    /** A generic accessory bought from the chosen supplier: a link to where the supplier keeps such things. */
    const lookFor = (sku, name) => (preferred ? { findUrl: suppliers.findUrl(preferred, catalog.accessoryRole(sku), searchWords(name)) } : null);
    const cautionOf = (o) => (isObj(o) && typeof o.notes === 'string' && o.notes ? ' ' + o.notes : '');

    // ---- lights: one line per product + color, in the order the runs list them. Bulk C7/C9 (cut-to-length
    // socket wire) is gathered per product across the whole job and bought as wire, bulbs and plugs.
    const groups = new Map();
    for (const run of runList) {
      const qty = fin(run.quantity, 0);
      if (!(qty > 0) || !run.productId) continue;
      const product = catalog.getProduct(lib.products, run.productId);
      if (isBulkProduct(product)) {
        const key = 'bulk|' + product.id;
        let g = groups.get(key);
        if (!g) { g = { bulk: true, product, feet: 0, uses: [], runs: [] }; groups.set(key, g); }
        g.feet += qty;
        g.uses.push((run.label || 'A run') + ' (' + fmtNum(qty, 2) + ' ft)');
        g.runs.push(run);
        continue;
      }
      const mode = typeof run.colorMode === 'string' && run.colorMode ? run.colorMode : 'warmWhite';
      const colors = arr(run.colors).filter((c) => typeof c === 'string');
      // Custom colours are named by their colour families ("Red and green"), so two palettes of the same
      // families are one line and nobody has to read colour codes.
      const named = mode === 'custom' ? suppliers.colourNames(colors) : '';
      const key = run.productId + '|' + mode + (mode === 'custom' ? '|' + (named || colors.join(',')) : '');
      let g = groups.get(key);
      if (!g) {
        const baseName = (product && product.name) || run.productName || run.productId;
        const suffix = mode === 'custom' && named ? named.charAt(0).toUpperCase() + named.slice(1) : colorLabel(mode);
        g = {
          sku: (product && (product.sku || product.id)) || run.productId,
          name: baseName + ' - ' + suffix,
          colour: suffix.toLowerCase(), mode,
          unit: (product && product.unit) || run.unit || 'string',
          price: product ? product.price : null,
          product,
          qty: 0,
          uses: [],
        };
        groups.set(key, g);
      }
      g.qty += qty;
      g.uses.push((run.label || 'A run') + ' (' + fmtNum(qty, 2) + ')');
    }
    const plugPlan = planPlugs(Array.from(groups.values()).filter((g) => g.bulk));
    for (const g of groups.values()) {
      if (g.bulk) { addBulkLines(g); continue; }
      const priceNote = Number.isFinite(g.price) && g.price >= 0 ? '' : ' No price in the product library.';
      const p = g.product;
      let meta = null;
      let caution = '';
      let name = g.name;
      if (catalog.isSupplierProduct(p)) {
        const sold = arr(p.colors).filter((c) => typeof c === 'string');
        if (sold.length && !sold.includes(g.mode)) {
          // A supplier item picked by hand in a colour it is not sold in: its part number and page are for another
          // colour, so they are left off and the line says to choose the colour at the supplier (the automatic
          // choice never gets here: design.js keeps the any-store product instead).
          const have = listText(sold.map((c) => colorLabel(c).toLowerCase()), 'or');
          name += ` (the part on file is ${have} only: choose the colour at the supplier)`;
          meta = { supplierId: p.supplierId, priceAsOf: p.priceAsOf, priceStatus: 'observed',
            findUrl: suppliers.findUrl(p.supplierId, catalog.categoryRole(p.category), searchWords((p.name || '') + ' ' + g.colour)) };
          caution = ` The part number on file${p.supplierSku ? ' (' + p.supplierSku + ')' : ''} is the ${have} one, so it is left off: choose ${g.colour} at the supplier and check its price.`;
        } else {
          meta = offerMeta(p.supplierId, p);
          if (typeof p.orderNote === 'string' && p.orderNote) caution = ' ' + p.orderNote;
          const other = cheaperSet(p, g.mode);
          if (other) {
            caution += ` A lower-priced set for the same job is also on file at this supplier (${other.name}, part ${other.supplierSku}): ` +
              'pick it on the run in the Design step if you prefer it.';
          }
        }
      } else if (preferred && p) {
        meta = { findUrl: suppliers.findUrl(preferred, catalog.categoryRole(p.category), searchWords(p.name || '')) };
      }
      addLine('lights', g.sku, name, roundQty(g.qty), g.unit, g.price, 'For ' + shortList(g.uses, 6).join(', ') + '.' + priceNote + caution, meta);
    }
    /**
     * Another ready-made set from the same supplier that fills the same role, is sold in this colour and costs at
     * least 10% less per lit foot, or null. The planner picks the first set on file for a role; the line says when
     * a cheaper kind exists so the buyer can choose.
     */
    function cheaperSet(p, mode) {
      const perFt = (x) => x.price / x.stringLengthFt;
      if (!p.equiv || p.unit !== 'string' || !pos(p.stringLengthFt) || !pos(p.price)) return null;
      const others = lib.products.filter((x) => isObj(x) && x.id !== p.id && x.supplierId === p.supplierId && x.equiv === p.equiv && x.kind !== 'bulk' &&
        x.enabled !== false && x.unit === 'string' && pos(x.stringLengthFt) && pos(x.price) && typeof x.supplierSku === 'string' && x.supplierSku &&
        (!arr(x.colors).length || x.colors.includes(mode)));
      others.sort((a, b) => perFt(a) - perFt(b));
      return others.length && perFt(others[0]) < 0.9 * perFt(p) ? others[0] : null;
    }

    /** Feet of wire a run hangs (its true length, whole feet): the waste allowance stays on the spool. */
    function hungFeet(run) {
      const q = Math.max(0, fin(run.quantity, 0));
      const h = fin(run.hung, null);
      if (h !== null && h >= 0) return Math.min(h, q);
      const L = fin(run.lengthFt, 0);
      return L > 0 ? Math.min(q, Math.ceil(L - EPS)) : q;
    }
    /** The feet of each length of wire that is cut for a bulk product: one per power feed, one per run that is on no feed. */
    function cutLengths(g) {
      const runById = new Map(g.runs.map((r) => [r.id, r]));
      const feedsOf = new Map();
      const mine = [];
      for (const f of arr(pw.feeds)) {
        if (!isObj(f)) continue;
        const ids = arr(f.runIds).filter((id) => runById.has(id));
        if (!ids.length) continue;
        mine.push({ f, ids });
        for (const id of ids) feedsOf.set(id, (feedsOf.get(id) || 0) + 1);
      }
      const cuts = [];
      for (const { f, ids } of mine) {
        const listed = arr(f.portions).filter((x) => isObj(x) && runById.has(x.runId) && fin(x.units, null) !== null);
        const ft = listed.length ? listed.reduce((t, x) => t + Math.max(0, x.units), 0) : ids.reduce((t, id) => t + hungFeet(runById.get(id)) / feedsOf.get(id), 0);
        cuts.push(Math.max(1, Math.ceil(ft - EPS)));
      }
      for (const r of g.runs) if (!feedsOf.has(r.id)) cuts.push(Math.max(1, Math.ceil(hungFeet(r) - EPS)));
      return cuts;
    }
    /** The sizes a bulk product's wire can be bought in, with today's price for each (the user's own price when set). */
    function wireSizes(c) {
      const ready = (o) => o.plugsIncluded === 'both' || o.plugsIncluded === 'male';
      const sizes = [{ offer: c.wire, lengthFt: c.wire.spoolFt, unit: 'spool', readyMade: ready(c.wire) }];
      for (const x of arr(c.wire.sizes)) {
        if (isObj(x) && pos(x.lengthFt) && nonNeg(x.price, null) !== null && typeof x.sku === 'string' && x.sku) {
          // A spool is wire with no plugs; a ready-made length comes with a plug on one or both ends.
          sizes.push({ offer: x, lengthFt: x.lengthFt, unit: ready(x) ? 'each' : 'spool', readyMade: ready(x) });
        }
      }
      for (const x of sizes) {
        const pr = priceOf(x.offer.sku, x.offer.price);
        x.price = pr.unitPrice;
        // A price seen on a category list only counts as a little dearer when sizes are compared (see MIX_RULE).
        x.unsure = !pr.overridden && x.offer.priceStatus !== 'verified';
      }
      return sizes;
    }
    /**
     * What each bulk product buys as wire and how many slide-on plugs the whole job needs, per plug part
     * (C7 and C9 wire take the same plugs, so their needs are pooled into one line per plug).
     * Returns {byProduct: Map(product id → {feet, mix, cuts, need}), plugs: Map(key → {...}), order: [key]}.
     */
    function planPlugs(bulkGroups) {
      const byProduct = new Map();
      const plugs = new Map();
      for (const g of bulkGroups) {
        const c = g.product.components;
        const feet = Math.ceil(g.feet - EPS);
        const mix = cheapestMix(feet, wireSizes(c), MIX_RULE);
        const cuts = cutLengths(g);
        const pieces = [];
        for (const m of mix) for (let i = 0; i < Math.min(m.count, 2000); i++) pieces.push({ lengthFt: m.size.lengthFt, plugs: m.size.offer.plugsIncluded });
        const need = plugNeeds(cuts, pieces);
        byProduct.set(g.product.id, { feet, mix, cuts, need });
        const wireType = typeof c.wire.wireType === 'string' && c.wire.wireType ? c.wire.wireType : 'SPT-1';
        const sid = catalog.isSupplierProduct(g.product) ? g.product.supplierId : null;
        for (const gender of ['male', 'female']) {
          const o = isOffer(gender === 'male' ? c.plugMale : c.plugFemale) ? (gender === 'male' ? c.plugMale : c.plugFemale) : null;
          const key = o ? o.sku : 'plug-' + wireType.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + gender;
          let e = plugs.get(key);
          if (!e) { e = { key, gender, offer: o, wireType, sid, need: 0, cuts: 0, joints: 0, allPlugged: true, first: g.product.id }; plugs.set(key, e); }
          e.need += need[gender];
          e.cuts += cuts.length;
          e.joints += need.joints;
          if (pieces.some((x) => x.plugs !== 'both')) e.allPlugged = false;
        }
      }
      return { byProduct, plugs };
    }

    /**
     * Wire, bulbs and plugs for one bulk product (SPEC §8.3). Wire: the feet of all its runs (waste included),
     * bought as the best mix of the sizes on file (cheapestMix with MIX_RULE). Bulbs: one per socket, split by
     * each run's colour pattern, in packs. Plugs: what the cut lengths and joints need beyond the plugs the wire
     * comes with, pooled per plug part across every bulk product of the job.
     */
    function addBulkLines(g) {
      const product = g.product;
      const c = product.components;
      const sid = catalog.isSupplierProduct(product) ? product.supplierId : null;
      const spacing = pos(product.bulbSpacingIn) || 12;
      const where = shortList(g.uses, 6).join(', ');
      const planned = plugPlan.byProduct.get(product.id);

      // -- wire
      const feet = planned.feet;
      const mix = planned.mix;
      const boughtFt = mix.reduce((t, m) => t + m.count * m.size.lengthFt, 0);
      const leftFt = Math.max(0, boughtFt - feet);
      const mixText = mix.map((m) => `${fmtNum(m.count, 0)} × ${fmtNum(m.size.lengthFt, 0)} ft`).join(' + ');
      // Installers who keep leftovers may have this wire on the truck already.
      const onHand = usedBasis ? ` If you already have this wire on a spool, take the ${fmtNum(feet, 0)} ft from it instead of ordering.` : '';
      for (const m of mix) {
        const note = `${fmtNum(feet, 0)} ft needed for ${where}. ` +
          (mix.length > 1 ? `Bought as ${mixText} = ${fmtNum(boughtFt, 0)} ft, ` : `${fmtNum(boughtFt, 0)} ft bought, `) +
          `${fmtNum(leftFt, 0)} ft left over.` + cautionOf(m.size.offer) + onHand;
        addLine('lights', m.size.offer.sku, m.size.offer.name || 'Socket wire', m.count, m.size.unit, m.size.offer.price, note,
          Object.assign(offerMeta(sid, m.size.offer), { usedQty: boughtFt > 0 ? (m.count * feet) / boughtFt : m.count }));
      }

      // -- bulbs: one per socket, by colour
      const bulb = c.bulb;
      const packQty = pos(bulb.packQty) || 25;
      const def = bulb.variants[bulb.defaultVariant];
      const byColour = new Map();
      for (const run of g.runs) {
        const sockets = Math.ceil((fin(run.quantity, 0) * 12) / spacing - EPS);
        const pattern = bulbPattern(run);
        pattern.forEach((family, i) => {
          const n = Math.floor(sockets / pattern.length) + (i < sockets % pattern.length ? 1 : 0);
          if (!(n > 0)) return;
          let e = byColour.get(family);
          if (!e) { e = { family, count: 0, uses: [] }; byColour.set(family, e); }
          e.count += n;
          const label = run.label || 'A run';
          const seen = e.uses.find((u) => u.label === label);
          if (seen) seen.n += n; else e.uses.push({ label, n });
        });
      }
      const order = suppliers.VARIANT_ORDER;
      const families = Array.from(byColour.values()).sort((a, b) => rank(order, a.family) - rank(order, b.family));
      const bulbRole = product.category === 'c7' ? 'c7Bulbs' : 'c9Bulbs';
      for (const e of families) {
        const listed = isObj(bulb.variants[e.family]) && nonNeg(bulb.variants[e.family].price, null) !== null ? bulb.variants[e.family] : null;
        const o = listed || def;
        const packs = Math.ceil(e.count / packQty - EPS);
        const label = suppliers.VARIANT_LABELS[e.family] || e.family;
        const uses = shortList(e.uses.map((u) => `${u.label} (${fmtNum(u.n, 0)})`), 6).join(', ');
        const base = `${fmtNum(e.count, 0)} ${e.count === 1 ? 'bulb' : 'bulbs'} needed for ${uses}. ${fmtNum(packs * packQty, 0)} bought, ${fmtNum(packs * packQty - e.count, 0)} spare.`;
        const used = { usedQty: e.count / packQty };
        if (listed) {
          addLine('lights', o.sku, o.name || `${bulb.name || 'Bulbs'} - ${label}`, packs, 'pack', o.price, base + cautionOf(o), Object.assign(offerMeta(sid, o), used));
        } else {
          // A colour this supplier's list does not have: priced like the default colour, with no part number
          // (the default's number would order the wrong colour) and a link to the supplier's bulb page instead.
          // Nobody read a price for this colour, so the line always says "check the price".
          const defLabel = (suppliers.VARIANT_LABELS[bulb.defaultVariant] || 'the default colour').toLowerCase();
          addLine('lights', o.sku + ':' + e.family, `${bulb.name || 'Bulbs'} - ${label} (choose the colour at the supplier)`, packs, 'pack', o.price,
            `${base} No ${label.toLowerCase()} bulb is on file for this supplier, so it is priced like ${defLabel}: choose the colour at the supplier and check its price.`,
            Object.assign({ supplierId: sid, priceAsOf: o.priceAsOf, priceStatus: 'observed', findUrl: sid ? suppliers.findUrl(sid, bulbRole, (bulb.name || '') + ' ' + label) : null }, used));
        }
      }

      // -- plugs: one line per plug part for the whole job, written with the first product that takes that plug
      for (const e of plugPlan.plugs.values()) {
        if (e.first !== product.id || !(e.need > 0)) continue;
        const acc = accessory('plug-spt1-' + e.gender);
        const o = e.offer;
        const size = pos(o && o.packQty) || pos(acc && acc.packSize) || 10;
        const packs = Math.ceil(e.need / size - EPS);
        const joint = e.joints > 0 ? (e.gender === 'male' ? ' and on the second piece wherever two pieces of wire are joined' : ', and on the first piece wherever two pieces of wire are joined') : '';
        const use = e.gender === 'male' ? `It goes on the end where the cord arrives${joint}.`
          : `It goes on the far end, so the next run or a jumper cord can plug in${joint}.`;
        const own = e.allPlugged ? ' The lengths bought come with a plug on each end, so only the ends you cut need one.' : '';
        const note = `One for each cut end of wire that has no plug of its own: ${fmtNum(e.need, 0)} needed, ${fmtNum(packs * size, 0)} bought. ${use}${own}`;
        const used = { usedQty: e.need / size };
        if (o) {
          addLine('lights', o.sku, o.name || `Slide-on ${e.gender} plugs`, packs, 'pack', o.price, note + cautionOf(o), Object.assign(offerMeta(e.sid, o), used));
        } else {
          // No plug on file for this supplier: a plain line with a link to where the supplier keeps its plugs.
          const name = `Slide-on ${e.gender} plugs for ${e.wireType} socket wire, pack of ${fmtNum(size, 0)}`;
          const from = e.sid || preferred;
          addLine('lights', e.key, name, packs, 'pack', acc ? acc.price : 0,
            note + (from ? ' No part number is on file for this plug: pick the one that matches the wire.' : ''),
            Object.assign({ findUrl: from ? suppliers.findUrl(from, 'plugs', `${e.wireType} ${e.gender} plug`) : null }, used));
        }
      }
    }

    // ---- clips: one line per clip type, packs of the accessory pack size, waste % added
    const clipCounts = new Map();
    for (const run of runList) {
      const c = run.clips;
      if (!isObj(c) || !CLIP_TYPES[c.type] || !(fin(c.count, 0) > 0)) continue;
      clipCounts.set(c.type, (clipCounts.get(c.type) || 0) + Math.ceil(c.count));
    }
    // A supplier with an all-in-one clip (made for gutters and shingles) but no gutter clip of its own: gutter
    // runs are counted with the all-in-one clips, so there is one pack to buy and one place to buy it.
    let gutterAsAllInOne = 0;
    if (clipCounts.get('gutter') && !offerFor(CLIP_TYPES.gutter.sku) && offerFor(CLIP_TYPES.allInOne.sku)) {
      gutterAsAllInOne = clipCounts.get('gutter');
      clipCounts.set('allInOne', (clipCounts.get('allInOne') || 0) + gutterAsAllInOne);
      clipCounts.delete('gutter');
    }
    for (const type of Object.keys(CLIP_TYPES)) {
      const count = clipCounts.get(type);
      if (!count) continue;
      const info = CLIP_TYPES[type];
      const acc = accessory(info.sku);
      // The chosen supplier's own clip: its name, pack size, price and link (its pack is what can be ordered, so
      // config.clipPackSize does not apply to it).
      const off = offerFor(info.sku);
      const packSize = (off && pos(off.packQty)) || pos(config.clipPackSize) || pos(acc && acc.packSize) || 100;
      const withWaste = Math.ceil(count * (1 + wastePct / 100) - EPS);
      const packs = Math.ceil(withWaste / packSize - EPS);
      const noun = type === 'zipTie' ? 'zip ties' : 'clips';
      const note = `${fmtNum(count, 0)} ${noun} + ${fmtNum(wastePct, 1)}% spare = ${fmtNum(withWaste, 0)}, in packs of ${fmtNum(packSize, 0)}.` +
        (type === 'allInOne' && gutterAsAllInOne ? ` ${fmtNum(gutterAsAllInOne, 0)} of them are for the gutter runs: this clip hangs on a gutter too.` : '');
      const name = (acc && acc.name) || info.label;
      if (off) addLine('clips', off.sku, off.name || name, packs, 'pack', off.price, note + cautionOf(off), offerMeta(preferred, off));
      else addLine('clips', info.sku, name, packs, (acc && acc.unit) || 'pack', acc ? acc.price : 0, note, lookFor(info.sku, name));
    }

    // ---- cords: pieces from the power plan, by gauge and length
    const cordUses = new Map();
    for (const f of arr(pw.feeds)) {
      if (!isObj(f) || !isObj(f.cord) || !Number.isFinite(f.cord.awg)) continue;
      const where = isObj(f.start) && f.start.label ? 'the ' + f.start.label : 'a feed';
      const list = f.cord.kind === 'jumper' ? 'jumpers' : 'homes';
      for (const L of arr(f.cord.pieces)) {
        const k = f.cord.awg + '|' + L;
        if (!cordUses.has(k)) cordUses.set(k, { homes: [], jumpers: [] });
        if (!cordUses.get(k)[list].includes(where)) cordUses.get(k)[list].push(where);
      }
    }
    for (const c of arr(pw.cords)) {
      if (!isObj(c) || !Number.isFinite(c.awg) || !(c.lengthFt > 0) || !(c.count > 0)) continue;
      const sku = catalog.cordSku(c.awg, c.lengthFt);
      const acc = accessory(sku);
      const table = catalog.CORD_PRICES[c.awg];
      const price = acc ? acc.price : (table && Number.isFinite(table[c.lengthFt]) ? table[c.lengthFt] : null);
      // Cords from an outlet and jumper cords between runs are the same product; the note says which is which.
      const uses = cordUses.get(c.awg + '|' + c.lengthFt) || { homes: [], jumpers: [] };
      const parts = [];
      if (uses.homes.length) parts.push('the cord' + (uses.homes.length > 1 ? 's' : '') + ' to ' + listText(shortList(uses.homes, 3)));
      if (uses.jumpers.length) parts.push('the jumper' + (uses.jumpers.length > 1 ? 's' : '') + ' to ' + listText(shortList(uses.jumpers, 3)));
      const note = (parts.length ? 'For ' + parts.join('; ') + '.' : '') +
        (Number.isFinite(price) ? '' : ' No price in the product library.');
      addLine('cords', sku, (acc && acc.name) || `Outdoor extension cord, ${c.awg} AWG, ${c.lengthFt} ft`, Math.round(c.count),
        (acc && acc.unit) || 'each', price, note.trim(), lookFor(sku, `outdoor extension cord ${c.lengthFt} ft`));
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
      const name = (acc && acc.name) || sku;
      const off = offerFor(sku);
      if (off) addLine(category, off.sku, off.name || name, n, (acc && acc.unit) || 'each', off.price, ((notes || '') + cautionOf(off)).trim(), offerMeta(preferred, off));
      else addLine(category, sku, name, n, (acc && acc.unit) || 'each', acc ? acc.price : 0, notes, lookFor(sku, name));
    };
    // A supplier's timer with a watt limit of its own is only ordered for the outlets it can carry. An outlet that
    // carries more gets a plain heavy-duty timer instead (power.js raises the 'timer-rating' warning for it).
    const timerOffer = offerFor('timer-outdoor');
    const timerMaxW = timerOffer ? pos(timerOffer.maxWatts) : null;
    const timed = pwOutlets.filter((o) => o.timer);
    const tooMuch = timerMaxW ? timed.filter((o) => fin(o.watts, 0) > timerMaxW + EPS) : [];
    const light = timed.filter((o) => !tooMuch.includes(o));
    const timerCount = Math.max(0, Math.round(fin(counts.timers, 0)));
    const heavyCount = Math.min(timerCount, tooMuch.length);
    accLine('power', 'timer-outdoor', timerCount - heavyCount, light.length ? 'One for each outlet used: ' + listText(shortList(light.map(outletLabel), 4)) + '.' : '');
    if (heavyCount > 0) {
      const acc = accessory('timer-outdoor');
      const plugA = pos(isObj(config.power) ? config.power.plugAmps : null) || 15;
      const volts = pos(isObj(config.power) ? config.power.voltage : null) || 120;
      const who = listText(shortList(tooMuch.map((o) => `${outletLabel(o)} (${fmtNum(fin(o.watts, 0), 0)} W)`), 3));
      addLine('power', 'timer-outdoor', `Heavy-duty outdoor plug-in timer, rated ${fmtNum(plugA, 0)} A (${fmtNum(plugA * volts, 0)} W)`, heavyCount, (acc && acc.unit) || 'each', acc ? acc.price : 0,
        `For ${who}: more than the ${fmtNum(timerMaxW, 0)} W the ${suppliers.getSupplier(preferred).name} timer is rated for, so ${heavyCount > 1 ? 'these outlets need' : 'this outlet needs'} a heavier timer. Check the watt rating on its label.`,
        lookFor('timer-outdoor', 'heavy duty outdoor timer 15 amp'));
    }
    const splitOutlets = pwOutlets.filter((o) => o.splitters > 0).map(outletLabel);
    accLine('power', 'splitter-3', counts.splitters, splitOutlets.length ? 'For outlets that feed more than one cord: ' + listText(shortList(splitOutlets, 4)) + '.' : '');
    // 3-way taps where jumper cords branch off a run (SPEC §8.2).
    const tapAt = arr(pw.feeds).filter((f) => isObj(f) && fin(f.taps, 0) > 0).map((f) => (isObj(f.start) && f.start.label ? 'the ' + f.start.label : 'a run'));
    accLine('power', 'tap-3way', counts.taps, tapAt.length ? 'Where jumper cords branch off: ' + listText(shortList(tapAt, 4)) + '.' : '');
    const noGfci = used.map((o) => projOutlets.find((p) => p.id === o.id)).filter((o) => o && !hasGfci(o)).map(outletLabel);
    accLine('power', 'gfci-adapter', counts.gfciAdapters, noGfci.length ? 'For outlets without GFCI protection: ' + listText(shortList(noGfci, 4)) + '.' : '');

    // ---- hardware: light stakes (packs) and walkway cord covers
    const stakeCount = runList.reduce((s, r) => s + Math.max(0, Math.ceil(fin(r.lightStakes, 0))), 0);
    if (stakeCount > 0) {
      const acc = accessory('light-stakes');
      const off = offerFor('light-stakes');
      const packSize = (off && pos(off.packQty)) || pos(config.stakes && config.stakes.packSize) || pos(acc && acc.packSize) || 25;
      const packs = Math.ceil(stakeCount / packSize - EPS);
      const where = runList.filter((r) => fin(r.lightStakes, 0) > 0).map((r) => r.label || 'a run');
      const note = `${fmtNum(stakeCount, 0)} stakes for ${listText(shortList(where, 3))}, in packs of ${fmtNum(packSize, 0)}.`;
      const name = (acc && acc.name) || 'Light stakes';
      if (off) addLine('hardware', off.sku, off.name || name, packs, 'pack', off.price, note + cautionOf(off), offerMeta(preferred, off));
      else addLine('hardware', 'light-stakes', name, packs, (acc && acc.unit) || 'pack', acc ? acc.price : 0, note, lookFor('light-stakes', name));
    }
    accLine('hardware', 'cord-cover', counts.cordCovers, 'Where a cord crosses a walkway or passes a doorway.');

    // ---- totals
    lines.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)); // stable within a category
    const byCategory = emptyCategories();
    for (const l of lines) byCategory[l.category] = round2(byCategory[l.category] + l.lineTotal);
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    // orderTotal: what everything on the list costs to order (equal to subtotal unless the basis is 'used').
    const orderTotal = round2(lines.reduce((s, l) => s + l.buyTotal, 0));
    return { ok: true, lines, subtotal, byCategory, orderTotal, costBasis: usedBasis ? 'used' : 'bought' };
  }
  /** Quantities are whole units for everything except odd per-foot products; keep 2 decimals at most. */
  function roundQty(q) { return Math.abs(q - Math.round(q)) < 1e-6 ? Math.round(q) : Math.round(q * 100) / 100; }

  // ---------------------------------------------------------------- suppliers and bulk helpers (SPEC §8.3)
  const ANY_STORE = 'Any store';
  /** The supplier the library buys from, or null for "Any store". */
  function preferredSupplier(lib) {
    const id = suppliers.knownSupplierId(isObj(lib) ? lib.supplierId : null);
    return id === suppliers.GENERIC_ID ? null : id;
  }
  const isOffer = (o) => isObj(o) && typeof o.sku === 'string' && o.sku !== '' && nonNeg(o.price, null) !== null;
  /** A bulk product whose parts can be priced: wire with a spool length, bulbs with a default colour on file. */
  function isBulkProduct(p) {
    if (!isObj(p) || p.kind !== 'bulk' || !isObj(p.components)) return false;
    const c = p.components;
    if (!isOffer(c.wire) || !pos(c.wire.spoolFt)) return false;
    return isObj(c.bulb) && isObj(c.bulb.variants) && isOffer(c.bulb.variants[c.bulb.defaultVariant]);
  }
  const rank = (order, key) => { const i = order.indexOf(key); return i < 0 ? order.length : i; };
  /** Plain search words from a product name ("Outdoor extension cord, 16 AWG" → "Outdoor extension cord 16 AWG"). */
  function searchWords(name) {
    return String(name || '').replace(/\([^)]*\)/g, ' ').replace(/[^A-Za-z0-9.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const { colourFamily, bulbPattern } = suppliers; // colour families of bulbs (shared with design.js, which counts watts by colour)
  /**
   * How wire sizes are compared when a job is bought (cheapestMix): every piece counts as $5 of plugs and work
   * (a joint to make and keep dry), a price seen on a category list only counts as 10% dearer than it says, and
   * at most 4 ready-made lengths are bought for one product (more wire than that comes off a spool). The line
   * always shows the real prices.
   */
  const MIX_RULE = { pieceCost: 5, unsurePct: 10, maxReadyMade: 4 };
  /**
   * Slide-on plugs a job needs beyond the plugs its wire comes with. `cuts` = feet of each length that is hung
   * (one per power feed); `pieces` = the wire bought, [{lengthFt, plugs: 'both' | 'male' | false}]. The wire is
   * shared out the way an installer would: the longest cut first, each from the shortest piece that covers it
   * (so few pieces are joined), a longer cut from several pieces joined end to end. Every cut needs a male plug
   * where the cord arrives and a female plug on its far end; a joint needs a female on the first piece and a
   * male on the second. A plug the piece came with is used where that end of the piece is used.
   * Returns {male, female, joints}.
   */
  function plugNeeds(cuts, pieces) {
    const stock = arr(pieces).filter((x) => isObj(x) && pos(x.lengthFt))
      .map((x) => ({ ft: x.lengthFt, male: x.plugs === 'both' || x.plugs === 'male', female: x.plugs === 'both' }))
      .sort((a, b) => b.ft - a.ft);
    const order = arr(cuts).filter((x) => pos(x)).sort((a, b) => b - a);
    let male = 0, female = 0, joints = 0;
    for (const cut of order) {
      let need = cut, first = true;
      for (let guard = 0; need > EPS && guard < 10000; guard++) {
        // The shortest piece that covers what is left, else the longest one (a joint follows it).
        let idx = -1;
        for (let i = 0; i < stock.length; i++) {
          if (stock[i].ft < need - EPS) continue;
          if (idx < 0 || stock[i].ft < stock[idx].ft - EPS || (Math.abs(stock[i].ft - stock[idx].ft) <= EPS && stock[i].male && !stock[idx].male)) idx = i;
        }
        if (idx < 0) for (let i = 0; i < stock.length; i++) if (idx < 0 || stock[i].ft > stock[idx].ft + EPS || (Math.abs(stock[i].ft - stock[idx].ft) <= EPS && stock[i].male && !stock[idx].male)) idx = i;
        if (!first) joints += 1;
        if (idx < 0) { male += 1; female += 1; break; } // no wire left to share out: count a full pair
        const seg = stock[idx];
        const take = Math.min(need, seg.ft);
        const whole = take >= seg.ft - EPS;
        if (whole) {
          if (!seg.male) male += 1;
          if (!seg.female) female += 1;
          stock.splice(idx, 1);
        } else if (!seg.male && seg.female) {
          // Cut from the far end of the piece, so the plug it came with is the far end of this length.
          male += 1;
          seg.female = false;
          seg.ft -= take;
        } else {
          if (!seg.male) male += 1;
          female += 1;
          seg.male = false;
          seg.ft -= take;
        }
        need -= take;
        first = false;
      }
    }
    return { male, female, joints };
  }
  /**
   * Cheapest way to buy at least `feet` of wire from the sizes on file ([{lengthFt, price, unsure?, readyMade?}]):
   * a small dynamic programme over whole feet. Ties go to fewer pieces, then to the longer piece.
   * `rule` (optional) makes the comparison more like a buyer's: pieceCost dollars are added for every piece,
   * unsurePct percent to the price of a size marked `unsure`, and at most maxReadyMade pieces marked `readyMade`
   * are used (when the other sizes cannot cover the feet, that cap is dropped). Returns [{size, count}], longest first.
   */
  function cheapestMix(feet, sizes, rule) {
    const need = Math.max(1, Math.ceil(feet - EPS));
    const list = sizes.slice().sort((a, b) => b.lengthFt - a.lengthFt);
    if (list.length === 1 || need > 50000) return cheapestPerFoot(need, list);
    const r = isObj(rule) ? rule : {};
    const pieceCost = nonNeg(r.pieceCost, 0), unsure = 1 + nonNeg(r.unsurePct, 0) / 100;
    const capped = Number.isInteger(r.maxReadyMade) && r.maxReadyMade >= 0 && list.some((x) => x.readyMade) && list.some((x) => !x.readyMade);
    const K = capped ? r.maxReadyMade : 0;
    const adj = list.map((x) => x.price * (x.unsure ? unsure : 1) + pieceCost);
    // Whole feet a piece is sure to cover (a 12.5 ft piece covers 12).
    const covers = list.map((x) => Math.max(1, Math.floor(x.lengthFt + EPS)));
    const W = need + 1;
    // cost[k * W + f]: the least it costs to cover f feet with at most k ready-made pieces.
    const cost = new Float64Array((K + 1) * W), pieces = new Int32Array((K + 1) * W), pick = new Int32Array((K + 1) * W).fill(-1);
    for (let k = 0; k <= K; k++) {
      for (let f = 1; f <= need; f++) {
        let best = Infinity, bestN = 0, bestI = -1;
        for (let i = 0; i < list.length; i++) {
          const kk = capped && list[i].readyMade ? k - 1 : k;
          if (kk < 0) continue;
          const rest = kk * W + Math.max(0, f - covers[i]);
          const cst = adj[i] + cost[rest], n = pieces[rest] + 1;
          if (cst < best - 1e-9 || (Math.abs(cst - best) <= 1e-9 && n < bestN)) { best = cst; bestN = n; bestI = i; }
        }
        cost[k * W + f] = best; pieces[k * W + f] = bestN; pick[k * W + f] = bestI;
      }
    }
    if (!Number.isFinite(cost[K * W + need])) return cheapestMix(feet, sizes, Object.assign({}, r, { maxReadyMade: null }));
    const countOf = list.map(() => 0);
    for (let k = K, f = need; f > 0;) {
      const i = pick[k * W + f];
      countOf[i] += 1;
      if (capped && list[i].readyMade) k -= 1;
      f = Math.max(0, f - covers[i]);
    }
    return list.map((size, i) => ({ size, count: countOf[i] })).filter((m) => m.count > 0);
  }
  /** One size only: the cheapest per foot (ties to the longer), as many as cover `feet`. For buyers who keep leftovers. */
  function cheapestPerFoot(feet, sizes) {
    const best = sizes.slice().sort((a, b) => a.price / a.lengthFt - b.price / b.lengthFt || b.lengthFt - a.lengthFt)[0];
    return [{ size: best, count: Math.max(1, Math.ceil(feet / best.lengthFt - EPS)) }];
  }

  // ================================================================ orderSheets
  /**
   * What to order from whom: one sheet per supplier that has lines (in the suppliers' own order), then
   * "Any store" for everything without a supplier. Totals are what is ordered (qty × unit price), whatever the
   * cost basis. Returns [{supplierId, supplierName, url, wholesale, priceAsOf, lines: [{supplierSku, name, qty,
   * unit, unitPrice, total, url, findUrl, priceStatus, priceAsOf, notes, sku}], subtotal}].
   */
  function orderSheets(bomResult, library) {
    try {
      const b = isObj(bomResult) ? bomResult : {};
      const known = isObj(library) && Array.isArray(library.suppliers) && library.suppliers.length ? library.suppliers.filter(isObj) : suppliers.SUPPLIERS;
      const sheets = new Map();
      const sheetFor = (id) => {
        if (!sheets.has(id)) {
          const s = known.find((x) => x.id === id) || suppliers.getSupplier(id) || {};
          sheets.set(id, {
            supplierId: id, supplierName: id === suppliers.GENERIC_ID ? ANY_STORE : (s.name || id),
            url: id === suppliers.GENERIC_ID ? null : suppliers.safeUrl(s.url),
            wholesale: id !== suppliers.GENERIC_ID && isObj(s.wholesale) ? JSON.parse(JSON.stringify(s.wholesale)) : null,
            priceAsOf: null, lines: [], subtotal: 0,
          });
        }
        return sheets.get(id);
      };
      for (const l of arr(b.lines)) {
        if (!isObj(l) || !(fin(l.qty, 0) > 0)) continue;
        const sheet = sheetFor(typeof l.supplierId === 'string' && l.supplierId ? l.supplierId : suppliers.GENERIC_ID);
        const total = round2(fin(l.buyTotal, fin(l.qty, 0) * fin(l.unitPrice, 0)));
        sheet.lines.push({
          supplierSku: l.supplierSku || null, name: l.name || '', qty: l.qty, unit: l.unit || 'each', unitPrice: round2(fin(l.unitPrice, 0)), total,
          url: suppliers.safeUrl(l.url), findUrl: suppliers.safeUrl(l.findUrl), priceStatus: l.priceStatus || 'default', priceAsOf: l.priceAsOf || null,
          notes: l.notes || '', sku: l.sku || '',
        });
        sheet.subtotal = round2(sheet.subtotal + total);
        if (l.priceAsOf && (!sheet.priceAsOf || l.priceAsOf < sheet.priceAsOf)) sheet.priceAsOf = l.priceAsOf;
      }
      const order = known.map((s) => s.id).filter((id) => id !== suppliers.GENERIC_ID);
      const out = [];
      for (const id of order) if (sheets.has(id)) out.push(sheets.get(id));
      for (const [id, sheet] of sheets) if (id !== suppliers.GENERIC_ID && !order.includes(id)) out.push(sheet);
      if (sheets.has(suppliers.GENERIC_ID)) out.push(sheets.get(suppliers.GENERIC_ID));
      return out;
    } catch (e) {
      return [];
    }
  }

  /**
   * The sentence every export carries when a plan uses supplier prices: when they were last checked and that
   * account prices differ. '' when no line has a supplier price (nothing to warn about).
   */
  function priceNote(bomOrSheet) {
    const list = arr(isObj(bomOrSheet) ? bomOrSheet.lines : null).filter(isObj);
    const dates = list.filter((l) => typeof l.priceAsOf === 'string' && l.priceAsOf).map((l) => l.priceAsOf).sort();
    if (!dates.length) return '';
    const tail = 'Account (wholesale) prices differ: edit any price.';
    // A list that also holds any-store items: their prices are typical ones, not checked on that date.
    const mixed = list.some((l) => !l.priceAsOf && (l.priceStatus === 'default' || l.priceStatus === undefined) && fin(l.qty, 0) > 0);
    if (mixed) return `Supplier prices were last checked on ${suppliers.formatDate(dates[0])}; the other prices are typical store prices. Confirm at checkout. ${tail}`;
    return `Prices were last checked on ${suppliers.formatDate(dates[0])}; confirm at checkout. ${tail}`;
  }
  /** "as of Nov 11, 2026 (check the price)" for a line with a supplier price, "your price" for an edited one, '' otherwise. */
  function priceStatusText(line) {
    if (!isObj(line)) return '';
    if (line.priceStatus === 'yours') return 'your price';
    if (!line.priceAsOf) return '';
    return 'as of ' + suppliers.formatDate(line.priceAsOf) + (line.priceStatus === 'verified' ? '' : ' (check the price)');
  }

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
        // A run whose strings are counted with the run before it can buy none and still be installed.
        if (!isObj(r) || !(fin(r.quantity, 0) > 0 || (r.productId && arr(r.feedIds).length > 0))) continue;
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
   * Install checklist: one group per outlet (project order): GFCI adapter → timer → power stake → then each
   * supply tree depth-first (SPEC §8.2): run the cord from the outlet (with its route) → 3-way tap → clips/stakes →
   * hang from the start end → continue into the next chained run → test → each run jumpered from it, the same
   * way. Then feeds with no outlet, runs not in the plan, and a final safety and test group.
   * Returns [{outletId|null, title, steps: [string]}].
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
    const lib = getLib(proj, null);
    const config = lib.config || catalog.DEFAULT_CONFIG;
    /** The run's product when it is cut-to-length socket wire (bulk C7/C9, SPEC §8.3), else null. */
    const bulkOf = (run) => {
      const product = isObj(run) ? catalog.getProduct(lib.products, run.productId) : null;
      return product && product.kind === 'bulk' ? product : null;
    };
    const clipSpacing = pos(config.clipSpacingIn) || 12;
    const stakeSpacing = pos(config.stakes && config.stakes.spacingIn) || 12;
    const runList = arr(runs).filter((r) => isObj(r) && typeof r.id === 'string');
    const runById = new Map(runList.map((r) => [r.id, r]));
    const featureById = new Map(arr(proj.features).filter(isObj).map((f) => [f.id, f]));
    const feeds = arr(pw.feeds).filter((f) => isObj(f) && typeof f.id === 'string');
    const portions = allocatePortions(feeds, arr(pw.chains), runById);
    const chainOfFeed = new Map();
    for (const c of arr(pw.chains)) if (isObj(c)) for (const fid of arr(c.feedIds)) chainOfFeed.set(fid, c);
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

    const feedById = new Map(feeds.map((f) => [f.id, f]));
    /** Feeds jumpered from `feed`, in the order they were planned. */
    const childrenOf = (feed) => {
      const ids = arr(feed.childFeedIds).filter((id) => feedById.has(id));
      const kids = ids.map((id) => feedById.get(id));
      for (const f of feeds) if (f.parentFeedId === feed.id && !ids.includes(f.id)) kids.push(f);
      return kids;
    };
    const portOf = (f) => (isObj(f.source) && f.source.port === 'start' ? 'start' : 'end');
    const tapPer = Math.max(1, Math.round(pos(isObj(config.power) ? config.power.tapOutlets : null) || 3) - 1);
    /** "the last string of Front eave": the plug at the end of a feed, for the run that hangs off it. */
    const endOf = (feed) => {
      const list = portions.get(feed.id) || [];
      const hung = list.filter((p) => p.units > EPS);
      const run = (hung.length ? hung[hung.length - 1] : list[list.length - 1] || {}).run;
      if (!run) return 'the last string of the run before';
      if (bulkOf(run)) return `the wire on ${run.label || 'the run before'}`; // its female plug
      const noun = run.unit === 'foot' ? 'section' : unitWord(run.unit, 1);
      return `the last ${noun} of ${run.label || 'the run before'}`;
    };
    const startOf = (feed) => (isObj(feed.start) && feed.start.label ? 'the ' + feed.start.label : 'the start of the run');
    const tapWords = (n) => (n === 1 ? 'a 3-way tap' : `${n} 3-way taps (each plugged into the one before)`);
    const hangOn = (kids) => {
      const cords = kids.every((k) => isObj(k.cord));
      return kids.length === 1 ? (cords ? '1 jumper cord' : '1 more run') : `${kids.length} ${cords ? 'jumper cords' : 'more runs'}`;
    };

    /**
     * Steps for one feed: its cord (from the outlet, or a jumper from the run that feeds it), a tap when other runs
     * branch off where the cord arrives, then each run portion (clips, stakes, hang), a tap on the end plug when
     * more than one jumper leaves it, and a test.
     */
    function feedSteps(feed, cordText, timer, prefix) {
      const steps = [prefix + cordText];
      const jumper = isObj(feed.source) && feed.source.kind === 'feed';
      const cordName = feed.plugIn ? 'plug' : jumper ? 'jumper cord' : 'cord';
      if (feed.crossesDoorway) {
        steps.push(`Keep the ${cordName} tight against the doorstep where it runs in front of ${feed.doorway || 'the door'} and lay a cord cover over it there${feed.crossesWalkway ? ' and across the walkway' : ''}.`);
      } else if (feed.crossesWalkway) steps.push(`Lay a cord cover over the ${cordName} where it crosses the walkway.`);
      const kids = childrenOf(feed);
      const atStart = kids.filter((k) => portOf(k) === 'start'), atEnd = kids.filter((k) => portOf(k) === 'end');
      if (atStart.length) {
        const n = Math.ceil(atStart.length / tapPer);
        const where = feed.plugIn ? `at ${startOf(feed)}` : `into the end of that ${cordName} at ${startOf(feed)}`;
        steps.push(`Plug ${tapWords(n)} ${where}: the lights and ${hangOn(atStart)} plug into ${n === 1 ? 'it' : 'them'}.`);
      }
      const plugInto = atStart.length ? 'the tap' : `the ${cordName}`;
      const list = portions.get(feed.id) || [];
      // Cut-to-length socket wire: one feed is one length of wire, cut and fitted with plugs and bulbs on the ground.
      const bulkFeed = list.length > 0 && list.every((p) => bulkOf(p.run));
      if (bulkFeed) {
        const ft = list.reduce((t, p) => t + p.units, 0);
        const spacing = pos(bulkOf(list[0].run).bulbSpacingIn) || 12;
        const sockets = Math.ceil((ft * 12) / spacing - EPS);
        const labels = [];
        for (const p of list) if (p.units > EPS && !labels.includes(p.run.label || 'this run')) labels.push(p.run.label || 'this run');
        const patterns = list.filter((p) => p.units > EPS).map((p) => bulbPattern(p.run).join(','));
        const same = patterns.every((x) => x === patterns[0]);
        const colours = same && patterns.length ? patterns[0].split(',').map((f) => (suppliers.VARIANT_LABELS[f] || f).toLowerCase()) : [];
        const bulbs = !colours.length ? 'the bulbs for each run into the sockets'
          : colours.length === 1 ? `a ${colours[0]} bulb into every socket`
            : `the bulbs into the sockets in the pattern ${colours.join(', ')}`;
        if (ft > EPS) {
          steps.push(`On the ground, cut one length of socket wire for ${listText(shortList(labels, 3))}: ${fmtNum(ft, 0)} ft (${fmtNum(sockets, 0)} sockets). ` +
            `Slide a male plug onto the end that meets ${plugInto} and a female plug onto the far end, unless that end already has a plug, then screw ${bulbs}.`);
        }
      }
      let stringRun = null; // the run whose last string is the one in hand (a carried-on run starts none)
      list.forEach((p, j) => {
        const run = p.run;
        const label = run.label || 'this run';
        // One clip per socket for socket wire; the library's clip spacing for everything else.
        const clipEvery = (bulkOf(run) && pos(bulkOf(run).bulbSpacingIn)) || clipSpacing;
        if (p.startsRun && isObj(run.clips) && fin(run.clips.count, 0) > 0) steps.push(clipStep(run, label, clipEvery, prepOf(run)));
        if (p.startsRun && fin(run.lightStakes, 0) > 0) {
          steps.push(`Push ${fmtNum(Math.ceil(run.lightStakes), 0)} light stakes into the ground along ${label}, one every ${fmtNum(stakeSpacing, 1)} in.`);
        }
        if (bulkFeed) {
          const part = p.units < p.total - EPS ? ` (${fmtNum(p.units, 2)} of its ${fmtNum(p.total, 2)} ft)` : ` (${fmtNum(p.units, 2)} ft)`;
          if (j === 0) {
            const start = feed.start && feed.start.label ? feed.start.label : sideOf(run);
            const toward = feed.start && typeof feed.start.toward === 'string' && feed.start.toward ? `, working toward the ${feed.start.toward}` : '';
            const plugStep = feed.plugIn && !atStart.length ? '' : ` Plug its male plug into ${plugInto}.`;
            steps.push(`Hang the wire ${prepOf(run)} ${label}${part}, starting at the ${start}${toward}.${plugStep}`);
          } else {
            steps.push(`Carry the same wire on ${prepOf(run)} ${label}${part}.`);
          }
          return;
        }
        const what = quantityText(p);
        const noun = run.unit === 'foot' ? 'section' : unitWord(run.unit, 1);
        if (j === 0) {
          const start = feed.start && feed.start.label ? feed.start.label : sideOf(run);
          const toward = feed.start && typeof feed.start.toward === 'string' && feed.start.toward ? `, working toward the ${feed.start.toward}` : '';
          // A run that plugs straight into another one (no jumper cord) was plugged in by the step before.
          const plugStep = feed.plugIn && !atStart.length ? '' : ` Plug the first ${noun} into ${plugInto}.`;
          steps.push(`${verbPhrase(run, what, label, prepOf(run))}, starting at the ${start}${toward}.${plugStep}`);
        } else if (!(p.units > EPS) && run.unit !== 'foot') {
          // Strings counted along the chain: the last string of the previous run carries on along this one.
          const prev = stringRun || list[j - 1].run;
          steps.push(`Carry the last ${unitWord(prev.unit, 1)} of ${prev.label || 'the previous run'} on along ${label}; no new ${noun} starts here.`);
        } else {
          const prev = stringRun || list[j - 1].run;
          const prevNoun = prev.unit === 'foot' ? 'section' : unitWord(prev.unit, 1);
          const start = p.startsRun ? sideOf(run) : 'point where the last one ended';
          steps.push(`Continue into ${label}: plug its first ${noun} into the last ${prevNoun} of ${prev.label || 'the previous run'}, ` +
            `then ${lowerFirst(verbPhrase(run, what, label, prepOf(run)))}, starting at the ${start}.`);
        }
        if (p.units > EPS) stringRun = run;
      });
      const chain = chainOfFeed.get(feed.id);
      if (chain && chain.feedIds[chain.feedIds.length - 1] === feed.id && fin(chain.spares, 0) > 0) {
        const first = list.length ? list[0].run : null;
        const n = fin(chain.spares, 0);
        const noun = first && first.unit === 'foot' ? 'ft' : unitWord(first ? first.unit : 'string', n);
        if (bulkFeed) {
          // Cut-to-length wire: the waste allowance is not hung. It stays on the spool in case a run is longer than measured.
          steps.push(`The order has ${fmtNum(n, 0)} ft of wire and bulbs to spare. If a run turns out longer than the plan says, cut it longer; keep what is left for repairs.`);
        } else steps.push(`Keep the ${fmtNum(n, 2)} spare ${noun} (bought for waste) to replace a dead one later.`);
      }
      if (atEnd.length > 1) {
        const n = Math.ceil((atEnd.length - 1) / tapPer);
        steps.push(`Plug ${tapWords(n)} into the end of ${endOf(feed)}: ${hangOn(atEnd)} plug into ${n === 1 ? 'it' : 'them'}.`);
      }
      const strings = list.length && list.every((p) => p.run.unit === 'string') ? list.reduce((s, p) => s + p.units, 0) : null;
      const on = feed.plugIn ? 'run' : 'cord';
      const lights = strings === null ? `every light on this ${on} works`
        : Math.abs(strings - 1) < EPS ? `the string on this ${on} lights` : `all ${fmtNum(strings, 2)} strings on this ${on} light`;
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
      // Cords that come back to the outlet (home runs); every other feed hangs off one of them by a jumper.
      const here = new Set(fs.map((f) => f.id));
      const homes = fs.filter((f) => !(f.parentFeedId && here.has(f.parentFeedId)));
      const splitters = Math.max(0, Math.round(fin(info.splitters, 0)));
      const per = Math.max(2, Math.round(pos(isObj(config.power) ? config.power.splitterOutlets : null) || 3));
      const into = timer ? 'timer' : 'outlet';
      if (splitters === 1) {
        steps.push(`Plug an outdoor power stake (${per} outlets each) into the ${into} so it can feed ${homes.length} cords.`);
      } else if (splitters > 1) {
        // Stakes are chained: the first goes into the timer, each other one into a free socket of the stake before it.
        const sockets = splitters * (per - 1) + 1;
        steps.push(`Plug an outdoor power stake (${per} outlets) into the ${into}, then plug each of the other ${splitters - 1} stakes into a free socket ` +
          `of the stake before it. The ${splitters} stakes give ${sockets} sockets for the ${homes.length} cords.`);
      }
      // Depth-first through each supply tree: the cord from the outlet, its lights, then every run jumpered from it.
      const done = new Set();
      const visit = (f, text, prefix) => {
        if (done.has(f.id)) return;
        done.add(f.id);
        steps.push(...feedSteps(f, text, timer, prefix));
        for (const k of childrenOf(f)) {
          if (!here.has(k.id)) continue;
          const from = portOf(k) === 'start' ? `the 3-way tap at ${startOf(f)}` : `the end of ${endOf(f)}`;
          const kidList = portions.get(k.id) || [];
          visit(k, jumperStep(k, from, kidList, kidList.length > 0 && !!bulkOf(kidList[0].run)), '');
        }
      };
      homes.forEach((f, i) => visit(f, cordStep(f, label), homes.length > 1 ? `Cord ${i + 1} of ${homes.length}: ` : ''));
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
    // power.js lists each feed's portions (hung strings per run, split runs, runs carried on by the previous
    // string); use them when every feed has them.
    const listed = feeds.length && feeds.every((f) => Array.isArray(f.portions) && f.portions.every((p) => isObj(p) && runById.has(p.runId)));
    if (listed) {
      const out = new Map();
      for (const f of feeds) {
        out.set(f.id, f.portions.map((p) => {
          const run = runById.get(p.runId);
          const total = Math.max(0, fin(p.total, fin(run.quantity, 0)));
          return { run, units: roundQty(Math.max(0, fin(p.units, 0))), total, startsRun: p.startsRun === true, endsRun: p.endsRun === true };
        }));
      }
      return out;
    }
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
      // The way the cord runs (power.js): "down 1.5 ft, 18 ft along the ground, up 8.5 ft beside Window left".
      const route = typeof c.routeText === 'string' && c.routeText ? `: ${c.routeText}` : '';
      if (pieces.length === 1) return `Run a ${fmtNum(pieces[0], 0)} ft, ${c.awg} AWG outdoor extension cord from ${outletLabel} to ${dest}${need}${route}.`;
      const sum = pieces.reduce((s, p) => s + p, 0);
      return `Run ${fmtNum(sum, 0)} ft of ${c.awg} AWG outdoor extension cord (${pieces.map((p) => fmtNum(p, 0) + ' ft').join(' + ')}, joined end to end) ` +
        `from ${outletLabel} to ${dest}${need}${route}. Keep the joints off the ground.`;
    }
    if (feed.cordUnknown) return `Run an outdoor extension cord from ${outletLabel} to ${dest}. Measure that distance on site, because the photo cannot size this cord.`;
    return `Run an outdoor extension cord from ${outletLabel} to ${dest}.`;
  }

  /** The step that brings power to a feed from the run that feeds it: a jumper cord, or a plug straight into it. */
  function jumperStep(feed, from, list, bulk) {
    const dest = isObj(feed.start) && feed.start.label ? 'the ' + feed.start.label : 'the start of the run';
    const c = feed.cord;
    if (isObj(c) && Number.isFinite(c.awg) && arr(c.pieces).length) {
      const pieces = c.pieces.filter((p) => p > 0);
      const need = Number.isFinite(c.lengthFt) ? ` (about ${fmtNum(Math.ceil(c.lengthFt), 0)} ft needed)` : '';
      const route = typeof c.routeText === 'string' && c.routeText ? `: ${c.routeText}` : '';
      if (pieces.length === 1) return `From ${from}, run a ${fmtNum(pieces[0], 0)} ft, ${c.awg} AWG jumper cord to ${dest}${need}${route}.`;
      const sum = pieces.reduce((s, p) => s + p, 0);
      return `From ${from}, run ${fmtNum(sum, 0)} ft of ${c.awg} AWG jumper cord (${pieces.map((p) => fmtNum(p, 0) + ' ft').join(' + ')}, joined end to end) ` +
        `to ${dest}${need}${route}. Keep the joints off the ground.`;
    }
    const first = list.length ? list[0].run : null;
    const noun = first && first.unit === 'foot' ? 'section' : unitWord(first ? first.unit : 'string', 1);
    const what = bulk ? `the male plug of the wire for ${(first && first.label) || 'the next run'}` : `the first ${noun} of ${(first && first.label) || 'the next run'}`;
    if (feed.plugIn) return `Plug ${what} straight into ${from}: no jumper cord is needed.`;
    return `From ${from}, run a jumper cord to ${dest}. Measure that distance on site, because the photo cannot size this cord.`;
  }

  function clipStep(run, label, spacing, prep) {
    const count = fmtNum(Math.ceil(run.clips.count), 0);
    const every = `one every ${fmtNum(spacing, 1)} in`;
    if (run.clips.type === 'adhesive') return `Stick ${count} adhesive clips ${prep} ${label}, ${every}. Wipe the surface clean and dry first.`;
    if (run.clips.type === 'zipTie') return `Have ${count} zip ties ready to fasten the lights to ${label}, ${every}.`;
    const info = CLIP_TYPES[run.clips.type];
    return `Put up ${count} ${(info ? info.label : 'light clips').toLowerCase()} ${prep} ${label}, ${every}.`;
  }

  /** "warm white C9 LED string, 25 bulbs" or "C9 LED string, 25 bulbs in red and green". */
  function coloredName(run) {
    const name = run.productName || run.productId || 'lights';
    if (run.colorMode === 'custom') {
      const named = suppliers.colourNames(run.colors);
      return name + (named ? ' in ' + named : ' in custom colors');
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
    if (type && (type.geometry === 'vertical' || type.geometry === 'area')) return 'base of ' + label;
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
  /** Extra columns when the plan buys from a supplier (SPEC §8.3). */
  const CSV_SUPPLIER_HEADER = ['Supplier', 'Part number', 'Price status', 'Link'];
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
  const csvRows = (rows) => rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
  /** The product page of a line, else where to look for it at the chosen supplier, else ''. */
  const lineLink = (l) => suppliers.safeUrl(l.url) || suppliers.safeUrl(l.findUrl) || '';

  /** Printed under a list whose line totals are shares of what is ordered (cost basis 'used'). */
  const USED_NOTE = 'Line totals count only the share of the wire, bulbs and plugs that this job uses. "Order Total" and "To order" are what the whole spools, boxes and packs cost.';
  /**
   * CSV of the BOM: a header row and one row per line, then a blank row and a summary row
   * ("Subtotal" in the SKU column, the amount in the Item column). The subtotal is kept out of the
   * Line Total column so summing that column in a spreadsheet gives the real total. CRLF line ends.
   * When any line names a supplier or carries a link, four columns are added (Supplier, Part number, Price
   * status, Link) and a last row carries the "prices were last checked" sentence.
   * When a line total is only the share this job uses (cost basis 'used'), two more columns say how much of the
   * quantity is used and what the whole quantity costs to order, a "To order" row follows the subtotal, and a
   * note explains the difference, so Qty x Unit Price never silently disagrees with Line Total.
   */
  function bomToCsv(bom) {
    const b = isObj(bom) ? bom : {};
    const list = arr(b.lines).filter(isObj);
    const withSupplier = list.some((l) => l.supplierId || l.supplierSku || lineLink(l));
    const buyOf = (l) => fin(l.buyTotal, fin(l.lineTotal, 0));
    const shares = list.some((l) => Math.abs(buyOf(l) - fin(l.lineTotal, 0)) > 0.004);
    let header = withSupplier ? CSV_HEADER.concat(CSV_SUPPLIER_HEADER) : CSV_HEADER;
    if (shares) header = header.concat(['Used Qty', 'Order Total']);
    const rows = [header];
    for (const l of list) {
      const row = [csvText(l.sku), csvText(l.name), csvText(l.category), Number.isFinite(l.qty) ? String(l.qty) : '',
        csvText(l.unit), money(l.unitPrice), money(l.lineTotal), csvText(l.notes)];
      if (withSupplier) row.push(csvText(l.supplierName || ANY_STORE), csvText(l.supplierSku || ''), csvText(priceStatusText(l)), lineLink(l));
      if (shares) row.push(Number.isFinite(l.usedQty) ? String(Math.round(l.usedQty * 100) / 100) : (Number.isFinite(l.qty) ? String(l.qty) : ''), money(buyOf(l)));
      rows.push(row);
    }
    const subtotal = Number.isFinite(b.subtotal) ? b.subtotal : list.reduce((s, l) => s + fin(l.lineTotal, 0), 0);
    const blank = header.map(() => '');
    rows.push(blank);
    rows.push(['Subtotal', money(subtotal)].concat(blank.slice(2)));
    if (shares) rows.push(['To order', money(list.reduce((s, l) => s + buyOf(l), 0))].concat(blank.slice(2)));
    const note = withSupplier ? priceNote(b) : '';
    if (note) rows.push(['Note', csvText(note)].concat(blank.slice(2)));
    if (shares) rows.push(['Note', csvText(USED_NOTE)].concat(blank.slice(2)));
    return csvRows(rows);
  }

  /**
   * CSV of one order sheet (from orderSheets): Part number, Item, Qty, Unit, Unit Price, Total, Price status,
   * Link, Notes; then a blank row, the subtotal (kept out of the Total column) and the price sentence.
   */
  function orderSheetToCsv(sheet) {
    const s = isObj(sheet) ? sheet : {};
    const header = ['Part number', 'Item', 'Qty', 'Unit', 'Unit Price', 'Total', 'Price status', 'Link', 'Notes'];
    const rows = [header];
    const list = arr(s.lines).filter(isObj);
    for (const l of list) {
      rows.push([csvText(l.supplierSku || ''), csvText(l.name), Number.isFinite(l.qty) ? String(l.qty) : '', csvText(l.unit), money(l.unitPrice), money(l.total),
        csvText(priceStatusText(l)), lineLink(l), csvText(l.notes)]);
    }
    const subtotal = Number.isFinite(s.subtotal) ? s.subtotal : list.reduce((t, l) => t + fin(l.total, 0), 0);
    const blank = header.map(() => '');
    rows.push(blank);
    rows.push(['Subtotal', money(subtotal)].concat(blank.slice(2)));
    rows.push(['Supplier', csvText(s.supplierName || ANY_STORE)].concat(blank.slice(2)));
    const note = priceNote(s);
    if (note) rows.push(['Note', csvText(note)].concat(blank.slice(2)));
    return csvRows(rows);
  }

  /** One order sheet as plain text to paste into an email or an order form. */
  function orderSheetToText(sheet) {
    const s = isObj(sheet) ? sheet : {};
    const out = ['Order from ' + (s.supplierName || ANY_STORE) + (suppliers.safeUrl(s.url) ? ' (' + s.url + ')' : '')];
    for (const l of arr(s.lines).filter(isObj)) {
      const part = l.supplierSku ? 'Part ' + l.supplierSku + ': ' : '';
      const status = priceStatusText(l);
      const count = l.unit === 'foot' ? fmtNum(l.qty, 2) + ' ft of' : fmtNum(l.qty, 2) + ' ×';
      // One pair of brackets: "(as of Nov 11, 2026, check the price)".
      out.push(`${count} ${part}${l.name} - $${money(l.unitPrice)} each = $${money(l.total)}` + (status ? ' (' + status.replace(' (check the price)', ', check the price') + ')' : ''));
      const link = lineLink(l);
      if (link) out.push('  ' + link);
    }
    out.push('Subtotal: $' + money(Number.isFinite(s.subtotal) ? s.subtotal : 0));
    const note = priceNote(s);
    if (note) out.push(note);
    return out.join('\n');
  }

  return {
    buildBom, buildQuote, buildChecklist, bomToCsv, round2, emptyBom,
    orderSheets, orderSheetToCsv, orderSheetToText, priceNote, priceStatusText, colourFamily, cheapestMix, plugNeeds, MIX_RULE, USED_NOTE,
  };
});
