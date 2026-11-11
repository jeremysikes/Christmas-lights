/* LightPlan core: catalog.
 * Feature types, the default product library, accessories and rules of thumb.
 * Everything here is plain JSON-able data so it can be edited in the UI, exported, and moved to a backend.
 * Values are typical retail figures (US, 120 V, 2026 USD), not one brand. Always check the box label.
 *
 * Phase 1.1 (SPEC §8.3): the library also carries the supplier map from core/suppliers.js. getLibrary appends
 * the suppliers' products to the project's list and says which supplier the project buys from
 * (library.supplierId; 'generic' = "Any store", the Phase 1 behaviour). config.buying holds how C7/C9 is
 * bought (cut-to-length wire and bulbs, or ready-made strings) and how leftovers are costed. */
LP.define('catalog', ['suppliers'], function (suppliers) {
  'use strict';

  const FEATURE_TYPES = {
    roofline: { id: 'roofline', label: 'Roofline / eave', short: 'Eave', geometry: 'polyline', color: '#ffb000', offPlane: false, defaultProduct: 'c9-led', defaultMount: 'allInOne', closedDefault: false, minPoints: 2, maxPoints: null },
    rake: { id: 'rake', label: 'Gable rake', short: 'Rake', geometry: 'polyline', color: '#ff6b3d', offPlane: false, defaultProduct: 'c9-led', defaultMount: 'shingle', closedDefault: false, minPoints: 2, maxPoints: null },
    gutter: { id: 'gutter', label: 'Gutter', short: 'Gutter', geometry: 'polyline', color: '#f5d90a', offPlane: false, defaultProduct: 'c9-led', defaultMount: 'gutter', closedDefault: false, minPoints: 2, maxPoints: null },
    ridge: { id: 'ridge', label: 'Ridge', short: 'Ridge', geometry: 'polyline', color: '#ff4f9a', offPlane: true, defaultProduct: 'c9-led', defaultMount: 'ridge', closedDefault: false, minPoints: 2, maxPoints: null },
    window: { id: 'window', label: 'Window outline', short: 'Window', geometry: 'polygon', color: '#38c6ff', offPlane: false, defaultProduct: 'mini-led-100', defaultMount: 'adhesive', closedDefault: true, minPoints: 3, maxPoints: null },
    door: { id: 'door', label: 'Door outline', short: 'Door', geometry: 'polyline', color: '#7d93ff', offPlane: false, defaultProduct: 'mini-led-100', defaultMount: 'adhesive', closedDefault: false, minPoints: 2, maxPoints: null },
    column: { id: 'column', label: 'Column / post', short: 'Column', geometry: 'vertical', color: '#b388ff', offPlane: false, defaultProduct: 'treewrap-led', defaultMount: 'none', closedDefault: false, minPoints: 2, maxPoints: 2 },
    railing: { id: 'railing', label: 'Railing', short: 'Railing', geometry: 'polyline', color: '#2ee6a6', offPlane: false, defaultProduct: 'mini-led-100', defaultMount: 'zipTie', closedDefault: false, minPoints: 2, maxPoints: null },
    walkway: { id: 'walkway', label: 'Walkway / driveway edge', short: 'Walkway', geometry: 'polyline', color: '#c4f03a', offPlane: false, defaultProduct: 'path-stakes', defaultMount: 'stake', closedDefault: false, minPoints: 2, maxPoints: null },
    bush: { id: 'bush', label: 'Bush (area)', short: 'Bush', geometry: 'area', color: '#34c759', offPlane: true, defaultProduct: 'mini-led-100', defaultMount: 'none', closedDefault: true, minPoints: 3, maxPoints: null },
    tree: { id: 'tree', label: 'Tree (wrap)', short: 'Tree', geometry: 'vertical', color: '#19b38a', offPlane: true, defaultProduct: 'treewrap-led', defaultMount: 'none', closedDefault: false, minPoints: 2, maxPoints: 2 },
    stakes: { id: 'stakes', label: 'Ground stakes', short: 'Stakes', geometry: 'polyline', color: '#ff9de2', offPlane: false, defaultProduct: 'c9-led', defaultMount: 'stake', closedDefault: false, minPoints: 2, maxPoints: null },
  };
  const TYPE_ORDER = ['roofline', 'rake', 'gutter', 'ridge', 'window', 'door', 'column', 'railing', 'walkway', 'bush', 'tree', 'stakes'];
  /** Types whose planned length is linear feet of light (waste applies). */
  const LINEAR_TYPES = ['roofline', 'rake', 'gutter', 'ridge', 'window', 'door', 'railing', 'walkway', 'stakes'];

  const ALL_COLORS = ['warmWhite', 'coolWhite', 'multicolor', 'custom'];
  const LINE_TYPES = ['roofline', 'rake', 'gutter', 'ridge', 'window', 'door', 'railing', 'walkway', 'stakes'];

  const DEFAULT_PRODUCTS = [
    { id: 'c9-led', sku: 'c9-led', name: 'C9 LED string, 25 bulbs', category: 'c9', tech: 'LED', unit: 'string', bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 1, bulbsPerUnit: 25, wattsPerUnit: 9.6, maxEndToEnd: 30, price: 32.99, colors: ALL_COLORS, clipEligible: true, enabled: true, suitableFor: LINE_TYPES, notes: 'Classic large bulbs for rooflines. Typical LED C9 draws about 0.4 W per bulb.' },
    { id: 'c9-incan', sku: 'c9-incan', name: 'C9 incandescent string, 25 bulbs (7 W)', category: 'c9', tech: 'incandescent', unit: 'string', bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 1, bulbsPerUnit: 25, wattsPerUnit: 175, maxEndToEnd: 3, price: 18.99, colors: ALL_COLORS, clipEligible: true, enabled: true, suitableFor: LINE_TYPES, notes: '7 W bulbs: 175 W per string, only 3 strings end to end.' },
    { id: 'c7-led', sku: 'c7-led', name: 'C7 LED string, 25 bulbs', category: 'c7', tech: 'LED', unit: 'string', bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 1, bulbsPerUnit: 25, wattsPerUnit: 7.2, maxEndToEnd: 40, price: 27.99, colors: ALL_COLORS, clipEligible: true, enabled: true, suitableFor: LINE_TYPES, notes: 'Slightly smaller than C9. Good for lower rooflines and windows.' },
    { id: 'c7-incan', sku: 'c7-incan', name: 'C7 incandescent string, 25 bulbs (5 W)', category: 'c7', tech: 'incandescent', unit: 'string', bulbSpacingIn: 12, stringLengthFt: 25, leadFt: 1, bulbsPerUnit: 25, wattsPerUnit: 125, maxEndToEnd: 5, price: 14.99, colors: ALL_COLORS, clipEligible: true, enabled: true, suitableFor: LINE_TYPES, notes: '5 W bulbs: 125 W per string.' },
    { id: 'mini-led-100', sku: 'mini-led-100', name: '5 mm mini LED string, 100 bulbs', category: 'mini', tech: 'LED', unit: 'string', bulbSpacingIn: 4, stringLengthFt: 33, leadFt: 0.5, bulbsPerUnit: 100, wattsPerUnit: 4.8, maxEndToEnd: 43, price: 12.99, colors: ALL_COLORS, clipEligible: false, enabled: true, suitableFor: ['window', 'door', 'railing', 'bush', 'tree', 'column', 'roofline', 'gutter', 'rake'], notes: 'Windows, doors, railings and bushes.' },
    { id: 'mini-incan-100', sku: 'mini-incan-100', name: 'Mini incandescent string, 100 bulbs', category: 'mini', tech: 'incandescent', unit: 'string', bulbSpacingIn: 4, stringLengthFt: 33, leadFt: 0.5, bulbsPerUnit: 100, wattsPerUnit: 40.8, maxEndToEnd: 3, price: 6.99, colors: ALL_COLORS, clipEligible: false, enabled: true, suitableFor: ['window', 'door', 'railing', 'bush', 'tree', 'column'], notes: 'About 41 W per string, 3 strings end to end.' },
    { id: 'icicle-led-300', sku: 'icicle-led-300', name: 'LED icicle lights, 300 bulbs', category: 'icicle', tech: 'LED', unit: 'string', bulbSpacingIn: 4, stringLengthFt: 16.5, leadFt: 1, bulbsPerUnit: 300, wattsPerUnit: 14.4, maxEndToEnd: 20, dropLengthsIn: [4, 7, 10, 6], price: 24.99, colors: ALL_COLORS, clipEligible: true, enabled: true, suitableFor: ['roofline', 'gutter', 'railing'], notes: 'Hang from gutters or eaves with all-in-one clips.' },
    { id: 'net-led-4x6', sku: 'net-led-4x6', name: 'LED net lights, 4 × 6 ft, 150 bulbs', category: 'net', tech: 'LED', unit: 'net', bulbSpacingIn: 4, stringLengthFt: 6, leadFt: 1, bulbsPerUnit: 150, wattsPerUnit: 7.2, maxEndToEnd: 30, coverageSqFt: 24, price: 22.99, colors: ALL_COLORS, clipEligible: false, enabled: true, suitableFor: ['bush'], notes: 'Drape over bushes. One net covers about 24 sq ft.' },
    { id: 'rope-led-18', sku: 'rope-led-18', name: 'LED rope light, 18 ft', category: 'rope', tech: 'LED', unit: 'string', bulbSpacingIn: 1, stringLengthFt: 18, leadFt: 1.5, bulbsPerUnit: 216, wattsPerUnit: 10.8, maxEndToEnd: 8, price: 29.99, colors: ALL_COLORS, clipEligible: false, enabled: true, suitableFor: ['window', 'door', 'railing', 'walkway', 'roofline', 'column'], notes: 'Continuous glow. Mount with rope clips (counted as adhesive clips).' },
    { id: 'track-permanent', sku: 'track-permanent', name: 'Permanent RGBW track lighting (per ft)', category: 'track', tech: 'LED', unit: 'foot', bulbSpacingIn: 6, stringLengthFt: 1, leadFt: 0, bulbsPerUnit: 2, wattsPerUnit: 1.2, maxEndToEnd: 300, price: 28, colors: ALL_COLORS, clipEligible: false, enabled: false, suitableFor: ['roofline', 'rake', 'gutter', 'ridge'], notes: 'Optional. Installed under the eave by a pro; priced per foot.' },
    { id: 'path-stakes', sku: 'path-stakes', name: 'LED pathway stake lights, set of 10', category: 'path', tech: 'LED', unit: 'set', bulbSpacingIn: 18, stringLengthFt: 15, leadFt: 3, bulbsPerUnit: 10, wattsPerUnit: 3, maxEndToEnd: 25, stakesPerSet: 10, stakeSpacingIn: 18, price: 29.99, colors: ALL_COLORS, clipEligible: false, enabled: true, suitableFor: ['walkway', 'stakes'], notes: 'Ten stakes 18 in apart per set.' },
    { id: 'treewrap-led', sku: 'treewrap-led', name: 'LED tree-wrap string, 150 bulbs (green wire)', category: 'treewrap', tech: 'LED', unit: 'string', bulbSpacingIn: 3, stringLengthFt: 37.5, leadFt: 1, bulbsPerUnit: 150, wattsPerUnit: 7.2, maxEndToEnd: 30, price: 16.99, colors: ALL_COLORS, clipEligible: false, enabled: true, suitableFor: ['tree', 'column', 'railing', 'bush'], notes: 'Tight spacing for trunk and branch wraps.' },
  ];

  const CORD_GAUGES = [
    { awg: 16, ampacity: 13, ohmsPer1000ft: 4.016 },
    { awg: 14, ampacity: 15, ohmsPer1000ft: 2.525 },
    { awg: 12, ampacity: 20, ohmsPer1000ft: 1.588 },
  ];
  const CORD_LENGTHS = [6, 15, 25, 50, 100];
  const CORD_PRICES = {
    16: { 6: 6.99, 15: 9.99, 25: 14.99, 50: 22.99, 100: 39.99 },
    14: { 6: 9.99, 15: 15.99, 25: 24.99, 50: 36.99, 100: 59.99 },
    12: { 6: 12.99, 15: 21.99, 25: 34.99, 50: 49.99, 100: 84.99 },
  };
  function cordSku(awg, lengthFt) { return 'cord-' + awg + '-' + lengthFt; }

  const CLIP_TYPES = {
    allInOne: { label: 'All-in-one clips', sku: 'clip-allinone' },
    gutter: { label: 'Gutter clips', sku: 'clip-gutter' },
    shingle: { label: 'Shingle clips', sku: 'clip-shingle' },
    ridge: { label: 'Ridge clips', sku: 'clip-ridge' },
    adhesive: { label: 'Adhesive clips', sku: 'clip-adhesive' },
    zipTie: { label: 'Zip ties', sku: 'zip-ties' },
  };

  const ACCESSORIES = [
    { sku: 'clip-allinone', name: 'All-in-one light clips (gutter + shingle)', category: 'clips', unit: 'pack', packSize: 100, price: 12.99 },
    { sku: 'clip-gutter', name: 'Gutter hook clips', category: 'clips', unit: 'pack', packSize: 100, price: 9.99 },
    { sku: 'clip-shingle', name: 'Shingle tab clips', category: 'clips', unit: 'pack', packSize: 100, price: 9.99 },
    { sku: 'clip-ridge', name: 'Ridge-line clips', category: 'clips', unit: 'pack', packSize: 100, price: 11.99 },
    { sku: 'clip-adhesive', name: 'Adhesive mini-light clips', category: 'clips', unit: 'pack', packSize: 50, price: 7.99 },
    { sku: 'zip-ties', name: 'UV-rated zip ties, 8 in', category: 'clips', unit: 'pack', packSize: 100, price: 5.99 },
    { sku: 'light-stakes', name: 'C9 light stakes', category: 'hardware', unit: 'pack', packSize: 25, price: 14.99 },
    { sku: 'timer-outdoor', name: 'Outdoor plug-in timer or smart plug', category: 'power', unit: 'each', packSize: 1, price: 19.99 },
    { sku: 'splitter-3', name: 'Outdoor 3-outlet power stake', category: 'power', unit: 'each', packSize: 1, price: 12.99 },
    { sku: 'tap-3way', name: 'Outdoor 3-way tap', category: 'power', unit: 'each', packSize: 1, price: 6.99 },
    { sku: 'gfci-adapter', name: 'Portable outdoor GFCI adapter', category: 'power', unit: 'each', packSize: 1, price: 24.99 },
    { sku: 'cord-cover', name: 'Walkway cord cover, 6 ft', category: 'hardware', unit: 'each', packSize: 1, price: 14.99 },
    // Slide-on plugs for cut-to-length socket wire (bulk C7/C9, SPEC §8.3). Only used when a supplier's bulk
    // product has no plug of its own on file.
    { sku: 'plug-spt1-male', name: 'Slide-on male plugs for SPT-1 socket wire', category: 'lights', unit: 'pack', packSize: 10, price: 7.99 },
    { sku: 'plug-spt1-female', name: 'Slide-on female plugs for SPT-1 socket wire', category: 'lights', unit: 'pack', packSize: 10, price: 7.99 },
  ];
  for (const g of CORD_GAUGES) {
    for (const L of CORD_LENGTHS) {
      ACCESSORIES.push({ sku: cordSku(g.awg, L), name: 'Outdoor extension cord, ' + g.awg + ' AWG, ' + L + ' ft', category: 'cords', unit: 'each', packSize: 1, price: CORD_PRICES[g.awg][L], awg: g.awg, lengthFt: L });
    }
  }

  const COLOR_MODES = {
    warmWhite: { label: 'Warm white', colors: ['#ffc46b'] },
    coolWhite: { label: 'Cool white', colors: ['#dfeaff'] },
    multicolor: { label: 'Multicolor', colors: ['#ff3b30', '#34c759', '#2f7bff', '#ffb000', '#b44dff'] },
    custom: { label: 'Custom', colors: null },
  };

  const DEFAULT_CONFIG = {
    typeDefaults: { roofline: 'c9-led', rake: 'c9-led', gutter: 'c9-led', ridge: 'c9-led', window: 'mini-led-100', door: 'mini-led-100', column: 'treewrap-led', railing: 'mini-led-100', walkway: 'path-stakes', bush: 'mini-led-100', tree: 'treewrap-led', stakes: 'c9-led' },
    clipSpacingIn: 12,
    clipPackSize: null, // null = each clip accessory's own pack size (adhesive clips come 50 to a pack); a number overrides all
    bush: { lightsPerUnit: 100, heightUnitFt: 1.5, widthUnitFt: 1, netCoverFactor: 1.5 },
    tree: { defaultDiameterIn: 10, spiralSpacingIn: 4, canopyLightsPerFtHeight: 100 },
    column: { defaultDiameterIn: 8, spiralSpacingIn: 6 },
    stakes: { spacingIn: 12, packSize: null }, // packSize null = the light-stakes accessory pack size (25); a number overrides
    power: { voltage: 120, continuousFactor: 0.8, maxVoltageDropPct: 3, cordSlackFt: 4, routingFactor: 1.15, chainGapFt: 3, timerPerOutlet: true, splitterOutlets: 3, plugAmps: 15, timerTungstenW: 1250,
      // Phase 1.1 (SPEC §8): runs are linked with jumper cords, and cords run down to the ground, along it and up.
      daisyChain: true, jumperMaxFt: 30, jumperDirectFt: 6, jumperSlackFt: 1.5, outletHeightFt: 1.5, openingMarginFt: 0.5, crossingPenaltyFt: 12, tapOutlets: 3 },
    labor: { ftPerHour: 40, setupHours: 1, hoursPerTree: 0.75, hoursPerBush: 0.25 },
    refDisagreementWarnPct: 5,
    confidence: { highMin: 75, mediumMin: 50 },
    maxImageSide: 2048,
    // Phase 1.1 (SPEC §8.3). style: how C7/C9 from the chosen supplier is bought when a run has no product of
    // its own: 'bulk' = socket wire cut to length + bulbs + plugs, 'strings' = ready-made strings.
    // costBasis: 'bought' totals everything ordered; 'used' totals only the share of wire, bulbs and plugs this
    // job uses (installers who carry leftovers to the next job).
    buying: { style: 'bulk', costBasis: 'bought' },
  };
  const BUYING_STYLES = ['bulk', 'strings'];
  const COST_BASES = ['bought', 'used'];

  /** Supplier category-page role (suppliers.ROLES) for each generic accessory sku and product category. */
  const ACCESSORY_ROLES = {
    'clip-allinone': 'clips', 'clip-gutter': 'clips', 'clip-shingle': 'clips', 'clip-ridge': 'clips', 'clip-adhesive': 'clips', 'zip-ties': 'clips',
    'light-stakes': 'stakes', 'timer-outdoor': 'timers', 'plug-spt1-male': 'plugs', 'plug-spt1-female': 'plugs',
  };
  const CATEGORY_ROLES = { c9: 'stringers', c7: 'stringers', mini: 'miniLights', icicle: 'icicle', net: 'net', rope: 'rope', treewrap: 'treeWrap' };
  /** Role for an accessory sku: the table above, extension cords by their sku prefix, else null (search instead). */
  function accessoryRole(sku) {
    if (Object.prototype.hasOwnProperty.call(ACCESSORY_ROLES, sku)) return ACCESSORY_ROLES[sku];
    return /^cord-\d+-\d+$/.test(String(sku)) ? 'extensionCords' : null;
  }
  function categoryRole(category) {
    return Object.prototype.hasOwnProperty.call(CATEGORY_ROLES, category) ? CATEGORY_ROLES[category] : null;
  }

  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function deepClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  /** Deep-merge plain objects (arrays and scalars in `over` replace). Never mutates inputs. */
  function deepMerge(base, over) {
    if (!isPlainObject(over)) return deepClone(base);
    const out = deepClone(base) || {};
    for (const k of Object.keys(over)) {
      const v = over[k];
      if (v === undefined) continue;
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : deepClone(v);
    }
    return out;
  }

  /**
   * The effective library for a project: {products, config, accessories, supplierId, suppliers}.
   * products = the project's own list (or the defaults) followed by every supplier product whose id is not
   * already in it, so a saved (edited) copy of a supplier product wins over the catalog's. supplierId = the
   * supplier the project buys from when it names a known one, else 'generic'. config = defaults with the
   * project's overrides merged in; config.buying values that are not known words fall back to the defaults.
   */
  function getLibrary(project) {
    const lib = (project && project.library) || {};
    const products = Array.isArray(lib.products) && lib.products.length ? deepClone(lib.products) : deepClone(DEFAULT_PRODUCTS);
    const have = new Set(products.map((p) => p && p.id));
    for (const p of suppliers.SUPPLIER_PRODUCTS) if (!have.has(p.id)) products.push(deepClone(p));
    const config = deepMerge(DEFAULT_CONFIG, isPlainObject(lib.config) ? lib.config : null);
    if (!isPlainObject(config.buying)) config.buying = deepClone(DEFAULT_CONFIG.buying);
    if (!BUYING_STYLES.includes(config.buying.style)) config.buying.style = DEFAULT_CONFIG.buying.style;
    if (!COST_BASES.includes(config.buying.costBasis)) config.buying.costBasis = DEFAULT_CONFIG.buying.costBasis;
    return {
      products, config, accessories: deepClone(ACCESSORIES),
      supplierId: suppliers.knownSupplierId(lib.supplierId), suppliers: deepClone(suppliers.SUPPLIERS),
    };
  }
  /** True for a product from a supplier's catalog (anything but "Any store"). */
  function isSupplierProduct(p) {
    return !!p && typeof p.supplierId === 'string' && p.supplierId !== '' && p.supplierId !== suppliers.GENERIC_ID;
  }
  function getProduct(products, id) {
    if (!Array.isArray(products) || !id) return null;
    return products.find((p) => p && p.id === id) || null;
  }
  function getAccessory(accessories, sku) {
    return (accessories || ACCESSORIES).find((a) => a.sku === sku) || null;
  }
  /** Resolve a run's display colors: feature color → project settings → warm white. */
  function resolveColors(featureColor, settings) {
    const s = settings || {};
    const mode = (featureColor && featureColor.mode) || s.colorMode || 'warmWhite';
    if (mode === 'custom') {
      const list = (featureColor && featureColor.colors) || s.customColors;
      const colors = Array.isArray(list) ? list.filter((c) => /^#[0-9a-f]{3,8}$/i.test(String(c))) : [];
      return { mode, colors: colors.length ? colors : COLOR_MODES.warmWhite.colors.slice() };
    }
    const def = COLOR_MODES[mode] || COLOR_MODES.warmWhite;
    return { mode: COLOR_MODES[mode] ? mode : 'warmWhite', colors: def.colors.slice() };
  }

  return {
    FEATURE_TYPES, TYPE_ORDER, LINEAR_TYPES, DEFAULT_PRODUCTS, DEFAULT_CONFIG, ACCESSORIES, COLOR_MODES,
    CLIP_TYPES, CORD_GAUGES, CORD_LENGTHS, CORD_PRICES, cordSku, BUYING_STYLES, COST_BASES,
    getLibrary, getProduct, getAccessory, resolveColors, deepMerge, deepClone, isPlainObject,
    accessoryRole, categoryRole, isSupplierProduct,
  };
});
