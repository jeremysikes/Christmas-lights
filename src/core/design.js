/* LightPlan core: design (SPEC §5.6).
 * Auto-plans one LightRun per traced feature: picks the product, works out how many strings / nets /
 * sets / feet to buy, the bulbs, watts and amps, the clips or light stakes, and a plain-language
 * explanation of the arithmetic. Pure: no DOM, no clock, never mutates its inputs, never throws on
 * partial project data (an unmeasured feature still yields a run with quantity 0 and a warning).
 *
 * Deviations from SPEC §5.6 (documented signature is unchanged; these are refinements):
 *  - Clip rule. clipEligible products: mount (params.mount ?? type default) when it is allInOne,
 *    gutter, shingle, ridge or adhesive, otherwise all-in-one clips. Products that are not clip
 *    eligible get clips only for adhesive or zipTie mounts. Three practical exceptions:
 *    mount 'zipTie' always gives zip ties (C9 on a railing is zip-tied too), mount 'stake' never gives
 *    clips (the light stakes hold the line), and an explicit params.mount 'none' means "no clips".
 *  - Tree canopies (wrapMode 'canopy') are planned by light count like bushes, so they use
 *    method 'bush-rule' (the method enum has no separate canopy value).
 *  - lengthFt / withWasteFt are always numbers on a LightRun (0 for bushes planned by light count and
 *    for features that are not measured yet) so downstream sums never see null.
 *  - Extra exports: resolveProduct(feature, library) and clipsFor(feature, product, lengthFt, config).
 */
LP.define('design', ['catalog'], function (catalog) {
  'use strict';

  const { FEATURE_TYPES, LINEAR_TYPES } = catalog;
  /** Mount values that map straight onto a clip type for clip-eligible products. */
  const CLIP_MOUNTS = ['allInOne', 'gutter', 'shingle', 'ridge', 'adhesive'];
  const UNIT_WORDS = { string: ['string', 'strings'], net: ['net', 'nets'], set: ['set', 'sets'], foot: ['ft', 'ft'] };
  /** Net lights on a line-type feature are estimated as a band this wide. */
  const NET_BAND_FT = 4;

  // ---------------------------------------------------------------- small helpers
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const finiteOr = (v, d) => (Number.isFinite(v) ? v : d);
  const round = (v, d) => { const k = Math.pow(10, d); return Math.round(v * k) / k; };

  /** "1,234.5" style number with a fixed number of decimals and thousands separators (locale independent). */
  function num(v, decimals) {
    const d = decimals === undefined ? 1 : decimals;
    if (!Number.isFinite(v)) return '?';
    const fixed = Math.abs(v).toFixed(d);
    const parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + parts.join('.');
  }
  /** Trim needless decimals for small config values ("1.5", "4", "0.75"). */
  function short(v) { return Number.isFinite(v) ? String(round(v, 2)) : '?'; }
  function unitWord(unit, n) {
    const w = UNIT_WORDS[unit] || ['unit', 'units'];
    return n === 1 ? w[0] : w[1];
  }

  function getLib(project, library) {
    if (library && Array.isArray(library.products) && isObj(library.config)) return library;
    return catalog.getLibrary(project);
  }
  function isEnabled(p) { return !!p && p.enabled !== false; }

  // ---------------------------------------------------------------- products
  /** Enabled products whose suitableFor list includes the feature type, in library order. */
  function suitableProducts(type, library) {
    const lib = library && Array.isArray(library.products) ? library : catalog.getLibrary(null);
    return lib.products.filter((p) => isEnabled(p) && Array.isArray(p.suitableFor) && p.suitableFor.includes(type));
  }

  /**
   * Product for a feature: feature.productId → config.typeDefaults[type] → first enabled suitable product.
   * A product the user picked explicitly does not have to be "suitable" (nets on a roofline are allowed),
   * it only has to exist and be enabled. Returns {product|null, source, warnings}.
   */
  function resolveProduct(feature, library) {
    const lib = library && Array.isArray(library.products) ? library : catalog.getLibrary(null);
    const type = feature && feature.type;
    const label = (feature && feature.label) || (FEATURE_TYPES[type] && FEATURE_TYPES[type].label) || 'This feature';
    const warnings = [];
    const wanted = feature && typeof feature.productId === 'string' && feature.productId ? feature.productId : null;
    if (wanted) {
      const p = catalog.getProduct(lib.products, wanted);
      if (isEnabled(p)) return { product: p, source: 'feature', warnings };
      warnings.push(p
        ? `${label}: ${p.name || wanted} is turned off in the product library, so the default product is used instead.`
        : `${label}: the chosen product (${wanted}) is no longer in the product library, so the default product is used instead.`);
    }
    const defaults = (lib.config && lib.config.typeDefaults) || {};
    const defId = defaults[type];
    if (defId) {
      const p = catalog.getProduct(lib.products, defId);
      if (isEnabled(p)) return { product: p, source: 'typeDefault', warnings };
    }
    const fallback = suitableProducts(type, lib)[0] || null;
    if (fallback) return { product: fallback, source: 'suitable', warnings };
    const typeLabel = (FEATURE_TYPES[type] && FEATURE_TYPES[type].label.toLowerCase()) || 'this feature';
    warnings.push(`${label}: no enabled product suits a ${typeLabel}. Turn one on in the product library.`);
    return { product: null, source: null, warnings };
  }

  // ---------------------------------------------------------------- clips
  /** Clip type and count for a run, or null when the run needs no clips (see deviations in the header). */
  function clipsFor(feature, product, lengthFt, config) {
    if (!product || !(lengthFt > 0)) return null;
    const ft = FEATURE_TYPES[feature && feature.type];
    const params = (feature && isObj(feature.params)) ? feature.params : {};
    const explicit = typeof params.mount === 'string' && params.mount ? params.mount : null;
    const mount = explicit || (ft ? ft.defaultMount : null);
    let type = null;
    if (explicit === 'none' || mount === 'stake') type = null;
    else if (mount === 'zipTie') type = 'zipTie';
    else if (product.clipEligible) type = CLIP_MOUNTS.includes(mount) ? mount : 'allInOne';
    else if (mount === 'adhesive') type = 'adhesive';
    if (!type) return null;
    const spacing = pos(config && config.clipSpacingIn) || 12;
    // One clip every `spacing` inches plus one to finish the run.
    return { type, count: Math.ceil((lengthFt * 12) / spacing) + 1 };
  }

  // ---------------------------------------------------------------- quantity rules
  /**
   * Work out quantity and the explanation for one measured feature.
   * Returns {method, quantity, lengthFt, withWasteFt, detail, warnings}.
   */
  function quantityFor(feature, fm, product, config, wastePct) {
    const type = feature.type;
    const ftype = FEATURE_TYPES[type];
    const geom = ftype.geometry;
    const params = isObj(feature.params) ? feature.params : {};
    const unit = product.unit;
    const warnings = [];
    const tape = fm.overridden ? 'Tape-measured ' : '';
    const wasteFactor = 1 + wastePct / 100;

    // Linear length with waste, as measure.js reported it (recomputed only if missing).
    const lengthFt = Math.max(0, finiteOr(fm.lengthFt, 0));
    let withWasteFt = Number.isFinite(fm.withWasteFt) ? fm.withWasteFt
      : (LINEAR_TYPES.includes(type) ? lengthFt * wasteFactor : lengthFt);
    withWasteFt = Math.max(0, withWasteFt);
    const lenText = (L, LW) => (L > 0 && LW > L + 1e-9 ? `${tape}${num(L)} ft + ${short(round((LW / L - 1) * 100, 1))}% = ${num(LW)} ft` : `${tape}${num(L)} ft`);

    const bad = (field) => {
      warnings.push(`${product.name || product.id} has no ${field} in the product library, so its quantity can't be worked out.`);
      return { method: 'linear', quantity: 0, lengthFt, withWasteFt, detail: `Product data missing (${field}).`, warnings };
    };

    // --- per-unit products priced by the foot (permanent track)
    const perFoot = (L, LW) => {
      const q = Math.ceil(LW - 1e-9);
      return { method: 'per-foot', quantity: Math.max(0, q), lengthFt: L, withWasteFt: LW,
        detail: `${lenText(L, LW)}, rounded up = ${num(q, 0)} ft`, warnings };
    };
    // --- path-light sets: one stake every stakeSpacingIn along the true length (no waste: stakes are counted)
    const pathSets = (L, LW) => {
      const spacing = pos(product.stakeSpacingIn) || pos(product.bulbSpacingIn);
      const per = pos(product.stakesPerSet);
      if (!spacing) return bad('stake spacing');
      if (!per) return bad('stakes per set');
      const stakes = L > 0 ? Math.floor((L * 12) / spacing) + 1 : 0;
      const q = Math.ceil(stakes / per);
      return { method: 'path-sets', quantity: q, lengthFt: L, withWasteFt: LW,
        detail: `${tape}${num(L)} ft at ${short(spacing)} in spacing = ${num(stakes, 0)} stakes / ${short(per)} per set = ${num(q, 0)} ${unitWord('set', q)}`, warnings };
    };
    // --- light-count rule (bushes and tree canopies): lights / bulbs per unit
    const byLights = (lights, prefix) => {
      const per = pos(product.bulbsPerUnit);
      if (!per) return bad('bulbs per unit');
      const q = lights > 0 ? Math.ceil(lights / per - 1e-9) : 0;
      return { method: 'bush-rule', quantity: q, lengthFt: 0, withWasteFt: 0,
        detail: `${prefix} = ${num(lights, 0)} lights / ${num(per, 0)} per ${unitWord(unit, 1)} = ${num(q, 0)} ${unitWord(unit, q)}`, warnings };
    };

    // ------------------------------------------------ area features (bushes)
    if (geom === 'area') {
      const bush = config.bush || {};
      const w = finiteOr(fm.widthFt, 0), h = finiteOr(fm.heightFt, 0);
      if (unit === 'net') {
        const cover = pos(product.coverageSqFt);
        if (!cover) return bad('coverage area');
        const factor = pos(bush.netCoverFactor) || 1;
        const area = w * h * factor; // drape factor: a net has to go over the top and down the sides
        const q = area > 0 ? Math.ceil(area / cover - 1e-9) : 0;
        return { method: 'bush-net', quantity: q, lengthFt: 0, withWasteFt: 0,
          detail: `${tape}${num(w)} ft × ${num(h)} ft × ${short(factor)} to drape = ${num(area)} sq ft / ${short(cover)} sq ft per net = ${num(q, 0)} ${unitWord('net', q)}`, warnings };
      }
      if (unit === 'string') {
        let lights = Number.isFinite(fm.lights) ? fm.lights : null;
        const lpu = pos(bush.lightsPerUnit) || 100, hu = pos(bush.heightUnitFt) || 1.5, wu = pos(bush.widthUnitFt) || 1;
        if (lights === null) lights = lpu * (h / hu) * (w / wu);
        lights = Math.ceil(lights - 1e-9);
        return byLights(lights, `${tape}${num(w)} ft wide × ${num(h)} ft tall at ${short(lpu)} lights per ${short(wu)} ft of width per ${short(hu)} ft of height`);
      }
      // Path sets or per-foot products around a bush: plan along its outline.
      const perim = Math.max(0, finiteOr(fm.measuredFt, 0));
      const perimW = perim * wasteFactor;
      return unit === 'set' ? pathSets(perim, perimW) : perFoot(perim, perimW);
    }

    // ------------------------------------------------ tree canopy (planned by light count)
    const canopy = type === 'tree' && (params.wrapMode === 'canopy' || (Number.isFinite(fm.lights) && fm.wrapFt == null));
    if (canopy) {
      const h = finiteOr(fm.heightFt, finiteOr(fm.measuredFt, lengthFt));
      const perFt = pos(config.tree && config.tree.canopyLightsPerFtHeight) || 100;
      const lights = Number.isFinite(fm.lights) ? fm.lights : perFt * h;
      if (unit === 'foot') return perFoot(lengthFt, withWasteFt);
      const res = byLights(Math.ceil(lights - 1e-9), `${tape}${num(h)} ft tall canopy × ${short(perFt)} lights per ft`);
      res.lengthFt = lengthFt; res.withWasteFt = withWasteFt;
      return res;
    }

    // ------------------------------------------------ linear and vertical-wrap features
    if (unit === 'foot') return perFoot(lengthFt, withWasteFt);
    if (unit === 'set') return pathSets(lengthFt, withWasteFt);
    if (unit === 'net') {
      const cover = pos(product.coverageSqFt);
      if (!cover) return bad('coverage area');
      const area = withWasteFt * NET_BAND_FT;
      const q = area > 0 ? Math.ceil(area / cover - 1e-9) : 0;
      warnings.push(`${feature.label || ftype.label}: net lights on a ${ftype.label.toLowerCase()} are estimated as a ${NET_BAND_FT} ft wide band.`);
      return { method: 'linear', quantity: q, lengthFt, withWasteFt,
        detail: `${lenText(lengthFt, withWasteFt)} × ${NET_BAND_FT} ft band = ${num(area)} sq ft / ${short(cover)} sq ft per net = ${num(q, 0)} ${unitWord('net', q)}`, warnings };
    }
    // string products
    const per = pos(product.stringLengthFt);
    if (!per) return bad('lit length');
    const q = withWasteFt > 0 ? Math.ceil(withWasteFt / per - 1e-9) : 0;
    const tail = ` / ${short(per)} ft per string = ${num(q, 0)} ${unitWord('string', q)}`;
    if (geom === 'vertical' && Number.isFinite(fm.wrapFt)) {
      // Spiral wrap: measure.js already turned height + diameter + spacing into wire length.
      const cfg = (type === 'tree' ? config.tree : config.column) || {};
      const D = pos(params.diameterIn) || pos(cfg.defaultDiameterIn);
      const s = pos(params.spiralSpacingIn) || pos(cfg.spiralSpacingIn);
      const h = finiteOr(fm.heightFt, fm.measuredFt);
      const how = D && s && Number.isFinite(h)
        ? `${tape}${num(h)} ft tall, ${short(D)} in across, wrapped every ${short(s)} in = ${num(lengthFt)} ft of lights`
        : `${tape}${num(lengthFt)} ft of wrap`;
      return { method: 'spiral', quantity: q, lengthFt, withWasteFt, detail: how + tail, warnings };
    }
    return { method: geom === 'vertical' ? 'spiral' : 'linear',
      quantity: q, lengthFt, withWasteFt, detail: lenText(lengthFt, withWasteFt) + tail, warnings };
  }

  /** Plain reason a feature has no usable measurement yet. */
  function notMeasuredReason(feature, project, measured) {
    const planes = Array.isArray(project && project.planes) ? project.planes : [];
    const plane = planes.find((p) => p && p.id === feature.planeId);
    const label = feature.label || (FEATURE_TYPES[feature.type] && FEATURE_TYPES[feature.type].label) || 'this feature';
    if (!plane) return `Not measured yet: put ${label} on a wall, roof or ground plane first`;
    const sol = measured && isObj(measured.planes) ? measured.planes[plane.id] : null;
    if (!sol || !sol.ok) return `Not measured yet: calibrate ${plane.name || 'its plane'} first`;
    return `Not measured yet: check the points traced for ${label}`;
  }

  // ---------------------------------------------------------------- main
  /**
   * One LightRun per feature, in project.features order. Features of unknown type are skipped
   * (schema validation reports them); everything else gets a run, measured or not.
   */
  function planRuns(project, measured, library) {
    const lib = getLib(project, library);
    const config = lib.config || catalog.DEFAULT_CONFIG;
    const settings = (project && isObj(project.settings)) ? project.settings : {};
    const wastePct = Number.isFinite(settings.wastePct) && settings.wastePct >= 0 ? settings.wastePct : 10;
    const voltage = pos(config.power && config.power.voltage) || 120;
    const features = Array.isArray(project && project.features) ? project.features : [];
    const fms = measured && isObj(measured.features) ? measured.features : {};
    const runs = [];

    for (const feature of features) {
      if (!isObj(feature) || !FEATURE_TYPES[feature.type] || typeof feature.id !== 'string') continue;
      const ftype = FEATURE_TYPES[feature.type];
      const label = (typeof feature.label === 'string' && feature.label.trim()) ? feature.label.trim() : ftype.label;
      const feat = Object.assign({}, feature, { label });
      const { product, warnings } = resolveProduct(feat, lib);
      const colors = catalog.resolveColors(feature.color, settings);
      const run = {
        id: 'run_' + feature.id, featureId: feature.id, featureType: feature.type, label,
        planeId: feature.planeId || null, imageId: feature.imageId || null,
        productId: product ? product.id : null, productName: product ? (product.name || product.id) : null,
        category: product ? product.category || null : null, tech: product ? product.tech || null : null,
        unit: product ? product.unit || null : null,
        colorMode: colors.mode, colors: colors.colors,
        lengthFt: 0, withWasteFt: 0, quantity: 0, bulbs: 0, watts: 0, amps: 0,
        clips: null, lightStakes: 0, method: methodGuess(ftype, product), detail: '', warnings: warnings.slice(),
        start: null, end: null, reversed: false, chainId: null, feedIds: [], outletId: null, circuitId: null,
      };
      if (product && Array.isArray(product.colors) && product.colors.length && !product.colors.includes(colors.mode)) {
        const modeLabel = (catalog.COLOR_MODES[colors.mode] && catalog.COLOR_MODES[colors.mode].label) || colors.mode;
        run.warnings.push(`${label}: ${run.productName} is not sold in ${modeLabel.toLowerCase()}. Pick another color or product.`);
      }

      const fm = fms[feature.id];
      if (!fm || !fm.ok) {
        run.warnings.push(notMeasuredReason(feat, project, measured));
        run.detail = 'Not measured yet.';
        runs.push(run);
        continue;
      }
      // Keep whatever length is known even when no product is available, so totals still add up.
      run.lengthFt = round(Math.max(0, finiteOr(fm.lengthFt, 0)), 4);
      run.withWasteFt = round(Math.max(0, finiteOr(fm.withWasteFt, run.lengthFt)), 4);
      if (!product) {
        run.detail = 'No product available.';
        runs.push(run);
        continue;
      }

      const q = quantityFor(feat, fm, product, config, wastePct);
      const quantity = Number.isFinite(q.quantity) && q.quantity > 0 ? q.quantity : 0;
      run.method = q.method;
      run.lengthFt = round(q.lengthFt, 4);
      run.withWasteFt = round(q.withWasteFt, 4);
      run.quantity = quantity;
      run.bulbs = Math.round(quantity * finiteOr(product.bulbsPerUnit, 0));
      run.watts = round(quantity * Math.max(0, finiteOr(product.wattsPerUnit, 0)), 2);
      run.amps = round(run.watts / voltage, 4);
      run.detail = q.detail;
      run.warnings.push(...q.warnings);
      run.clips = clipsFor(feat, product, run.lengthFt, config);
      // C9-on-stakes runs (type 'stakes' with a string product) need one light stake per bulb spacing.
      if (feature.type === 'stakes' && product.unit !== 'set' && run.lengthFt > 0) {
        const spacing = pos(config.stakes && config.stakes.spacingIn) || 12;
        run.lightStakes = Math.ceil((run.lengthFt * 12) / spacing) + 1;
      }
      runs.push(run);
    }
    return runs;
  }

  /** Method label for runs that never reach the quantity step (unmeasured / no product). */
  function methodGuess(ftype, product) {
    const unit = product && product.unit;
    if (unit === 'foot') return 'per-foot';
    if (unit === 'set') return 'path-sets';
    if (ftype.geometry === 'area') return unit === 'net' ? 'bush-net' : 'bush-rule';
    if (ftype.geometry === 'vertical') return 'spiral';
    return 'linear';
  }

  return { planRuns, suitableProducts, resolveProduct, clipsFor };
});
